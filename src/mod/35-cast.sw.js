/**
 * 手机字幕屏 —— Service Worker 侧转发（PLAN 038）
 *
 * 为什么不在内容脚本里直连 127.0.0.1：
 *   实测（内容脚本 → http://127.0.0.1:8899）在部分 Chrome 版本上会被页面侧的
 *   跨域 / 私有网络访问策略静默拦掉，而失败没有任何可读的响应。扩展源 + host_permissions
 *   的请求不受页面策略影响 —— 本仓库的 dev server 自动重载一直走的就是这条路。
 *
 * 协议：内容脚本 → { type: '__llg_cast_push', url, body } → 这里 fetch → 回 { ok, status, text }
 * 只做转发，不含任何业务判断；超时 5s，避免内容脚本那边的 promise 永远挂着。
 * `text` 要带回来：/push 的响应里可能有手机发来的播放命令（PLAN 042），
 * 所以截断上限从 200 放宽到 4000（够 8 条命令，服务端队列上限也是 8）。
 *
 * 本文件由 build.mjs 挂到官方 service-worker-loader.js 末尾（MV3 只允许一个 SW）。
 */
(() => {
  'use strict';

  if (globalThis.__llgCastSw) return;
  globalThis.__llgCastSw = true;

  const TIMEOUT_MS = 5000;

  async function relay(url, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : 0;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body,
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text: text.slice(0, 4000), via: 'sw' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || msg.type !== '__llg_cast_push') return false;
    relay(msg.url, msg.body)
      .then(respond)
      .catch((err) => respond({
        ok: false,
        via: 'sw',
        error: String((err && err.message) || err),
      }));
    // 异步响应：不返回 true 的话 reply 会被丢掉
    return true;
  });
})();
