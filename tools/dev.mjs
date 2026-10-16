#!/usr/bin/env node
/**
 * 开发服务器
 *
 * 监听 src/ 与 build.mjs，改动后自动重建 dist/，并通过本地 HTTP 通知扩展
 * 执行 chrome.runtime.reload() —— 在 arc://extensions 里不用手点刷新。
 *
 * 用法：make dev（= node tools/dev.mjs）
 *
 *   首次需要手动做一次：Arc → arc://extensions → 开发者模式 →
 *   加载已解压的扩展程序 → 选 dist/。之后全程自动。
 *
 * 端口固定 127.0.0.1:8791，与 build.mjs --dev 注入的 host_permissions 对应。
 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = 8791;

/** 长轮询最长挂起时间，避免代理/系统把连接掐掉 */
const WAIT_TIMEOUT_MS = 25000;
/** 编辑器保存常常连发多次事件，去抖一下 */
const DEBOUNCE_MS = 150;

let rev = 0;
let building = false;
let queued = false;
let debounceTimer = 0;
const waiters = new Set();

function respondJson(res, body) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

/** 有新的 rev 了，唤醒所有挂着等待的扩展连接 */
function broadcast() {
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    respondJson(waiter.res, { rev });
  }
  waiters.clear();
}

function handleWait(req, res, since) {
  if (rev > since) {
    respondJson(res, { rev });
    return;
  }

  const waiter = { res, timer: 0 };
  waiter.timer = setTimeout(() => {
    waiters.delete(waiter);
    respondJson(res, { rev });
  }, WAIT_TIMEOUT_MS);
  waiters.add(waiter);

  req.on('close', () => {
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
  });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (url.pathname === '/rev') {
      respondJson(res, { rev });
      return;
    }
    if (url.pathname === '/wait') {
      const since = Number(url.searchParams.get('since') ?? 0);
      handleWait(req, res, Number.isFinite(since) ? since : 0);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  });
}

function build(reason) {
  if (building) {
    queued = true;
    return;
  }
  building = true;

  const child = spawn(process.execPath, ['build.mjs', '--dev'], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => {
    building = false;

    if (code === 0) {
      rev += 1;
      console.log(`\n[dev] rev=${rev} 重建完成（${reason}）→ 通知扩展重载\n`);
      broadcast();
    } else {
      console.error(`\n[dev] 构建失败 exit=${code}，等下一次改动\n`);
    }

    if (queued) {
      queued = false;
      build('合并触发');
    }
  });
}

function schedule(reason) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = 0;
    build(reason);
  }, DEBOUNCE_MS);
}

function startWatching() {
  watch(path.join(ROOT, 'src'), { recursive: true }, () => schedule('src 变更'));
  watch(path.join(ROOT, 'build.mjs'), () => schedule('build.mjs 变更'));
}

function main() {
  const server = createServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[dev] 端口 ${PORT} 已被占用，先关掉上一个 make dev`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, HOST, () => {
    console.log(`[dev] dev server  http://${HOST}:${PORT}`);
    console.log('[dev] 首次请到 Arc → arc://extensions 加载 dist/，之后改动会自动重载');
    console.log('[dev] Ctrl-C 退出\n');
    build('首次构建');
    startWatching();
  });

  const shutdown = () => {
    server.close();
    for (const waiter of waiters) clearTimeout(waiter.timer);
    waiters.clear();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
