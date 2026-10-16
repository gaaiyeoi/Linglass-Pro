#!/usr/bin/env node
/**
 * Linglass Mod 构建脚本
 *
 *   vendor/linglass-<version>/   原始扩展（只读基线，永不修改）
 *   src/mod/                     我们的增量代码
 *          ↓
 *   dist/                        可加载的完整扩展
 *
 * 用法：
 *   node build.mjs          正式构建
 *   node build.mjs --dev    开发构建：额外注入 *.dev.js，并放开本地 dev server 权限
 *
 * src/mod/ 的文件名约定：
 *   NN-xxx.js      内容脚本，NN 决定注入顺序（共享模块用 00/10，消费者用 30/40）
 *   xxx.dev.js     只在 --dev 构建注入的内容脚本
 *   xxx.sw.dev.js  只在 --dev 构建挂到官方 service worker 上的模块
 *
 * 加载：Arc → arc://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 dist/
 */
import { cp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.join(ROOT, 'vendor');
const SRC_MOD = path.join(ROOT, 'src', 'mod');
const DIST = path.join(ROOT, 'dist');

/** 构建产物把 patch 位固定为 900，远离官方版本号，避免和商店更新撞号 */
const MOD_PATCH = 900;

/** 我们的增量脚本只跑在 YouTube */
const SITE_MATCHES = ['https://www.youtube.com/*'];

/** 开发构建里 dev server 的地址（127.0.0.1 属安全上下文，https 页面也能连） */
const DEV_ORIGIN = 'http://127.0.0.1:8791/*';

/** 文件名以它结尾的脚本只作为 Service Worker 模块，绝不作内容脚本 */
const SW_MODULE_SUFFIX = '.sw.dev.js';

/**
 * mod 依赖 Linglass 的 Shadow DOM 契约，官方改版时这里会失效。
 * 构建时做一次字符串校验，把「运行才发现字幕不动」提前到「构建就报警」。
 */
const SUBTITLE_CONTRACT = [
  'linglass-subtitle-overlay',
  'subtitle-group',
  'subtitle-primary',
  'subtitle-secondary',
];

const DEV = process.argv.includes('--dev');

function log(msg) {
  console.log(`[build] ${msg}`);
}

function warn(msg) {
  console.warn(`[build] ⚠️  ${msg}`);
}

/** 取 vendor/ 下版本号最大的 linglass-* 目录作为基线 */
async function pickVendor() {
  const dirs = (await readdir(VENDOR_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith('linglass-'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error('vendor/ 下找不到 linglass-* 目录');
  return { name: dirs[dirs.length - 1], abs: path.join(VENDOR_DIR, dirs[dirs.length - 1]) };
}

/**
 * 校验字幕浮层契约。
 *
 * 不硬编码任何官方文件名 —— 官方一发版哈希就变。改为扫 assets/ 下的全部 js/css，
 * 只要每个契约记号都能在某个文件里找到就算通过（实测它在共享 chunk
 * promoCards-*.js 里，名字有误导性，所以不值得按文件名去猜）。
 */
async function verifySubtitleContract(vendor) {
  const assetsDir = path.join(vendor, 'assets');

  let files;
  try {
    files = (await readdir(assetsDir)).filter((f) => f.endsWith('.js') || f.endsWith('.css'));
  } catch (err) {
    warn(`读不到 assets/，跳过契约校验：${err.message}`);
    return;
  }

  const found = new Map();
  for (const file of files) {
    let source;
    try {
      source = await readFile(path.join(assetsDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const token of SUBTITLE_CONTRACT) {
      if (!found.has(token) && source.includes(token)) found.set(token, file);
    }
    if (found.size === SUBTITLE_CONTRACT.length) break;
  }

  const missing = SUBTITLE_CONTRACT.filter((token) => !found.has(token));
  if (missing.length) {
    warn(`官方可能改版：assets/ 下找不到 ${missing.join(', ')}`);
    warn('src/mod/desktop-subtitles.js 依赖这套 Shadow DOM 契约，构建仍继续，但请先核对选择器');
    return;
  }

  log(`契约校验  ✓  ${[...new Set(found.values())].join(', ')}`);
}

/**
 * 按文件名约定分类 src/mod/ 下的脚本：
 *   NN-*.js       内容脚本，NN 是注入顺序（同一扩展的内容脚本共享 isolated world，
 *                 靠 globalThis 互相取用，所以共享模块必须排在消费者前面）
 *   *.dev.js      只在 --dev 构建注入的内容脚本
 *   *.sw.dev.js   只在 --dev 构建注入的 Service Worker 模块（绝不作为内容脚本）
 */
async function scanMod() {
  const contentScripts = [];
  const swModules = [];

  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;

      const isDevOnly = entry.name.endsWith('.dev.js');
      if (isDevOnly && !DEV) continue;

      if (entry.name.endsWith(SW_MODULE_SUFFIX)) {
        swModules.push(rel);
      } else {
        contentScripts.push(rel);
      }
    }
  }

  await walk(SRC_MOD, '');
  return { contentScripts, swModules };
}

/**
 * 开发构建：把我们的 SW 客户端挂到官方 service worker 入口上。
 * MV3 只允许一个 background.service_worker，所以不能另起一个，只能搭在官方入口后面。
 */
async function patchServiceWorker(swModules) {
  if (!swModules.length) return;

  const rel = 'service-worker-loader.js';
  const abs = path.join(DIST, rel);
  const original = await readFile(abs, 'utf8');
  const imports = swModules.map((m) => `import './mod/${m}';`).join('\n');
  await writeFile(abs, `${original.trimEnd()}\n${imports}\n`, 'utf8');
  log(`SW 挂载   ${rel} += ${swModules.map((m) => `mod/${m}`).join(', ')}`);
}

async function main() {
  const vendor = await pickVendor();
  log(`基线      ${path.relative(ROOT, vendor.abs)}`);
  await verifySubtitleContract(vendor.abs);

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await cp(vendor.abs, DIST, { recursive: true });

  // 商店下发的校验清单，解压加载时会报错，直接删掉
  await rm(path.join(DIST, '_metadata'), { recursive: true, force: true });

  // 增量代码
  await cp(SRC_MOD, path.join(DIST, 'mod'), { recursive: true });

  const mfPath = path.join(DIST, 'manifest.json');
  const mf = JSON.parse(await readFile(mfPath, 'utf8'));

  // 幂等：先清掉上一次注入的 mod/*，再按当前 src/mod 内容重新注入
  mf.content_scripts = mf.content_scripts.filter(
    (cs) => !(cs.js || []).every((js) => js.startsWith('mod/')),
  );

  const { contentScripts, swModules } = await scanMod();
  if (!contentScripts.length) throw new Error('src/mod/ 下没有可注入的内容脚本');

  // 合成单个条目：Chrome 保证同一个 content_scripts 条目里的 js 按数组顺序执行，
  // 所以 00- / 10- / 30- / 40- 的数字前缀就是确定的加载顺序。
  mf.content_scripts.push({
    js: contentScripts.map((entry) => `mod/${entry}`),
    matches: SITE_MATCHES,
    run_at: 'document_idle',
  });
  log(`注入      ${contentScripts.map((e) => `mod/${e}`).join(' → ')}`);

  // mod/* 需要能被页面侧按 URL 取到（PiP 窗口、动态 import）
  if (!mf.web_accessible_resources.some((r) => (r.resources || []).includes('mod/*'))) {
    mf.web_accessible_resources.push({
      matches: SITE_MATCHES,
      resources: ['mod/*'],
      use_dynamic_url: false,
    });
  }

  if (DEV) {
    if (!mf.host_permissions.includes(DEV_ORIGIN)) {
      mf.host_permissions.push(DEV_ORIGIN);
    }
    await patchServiceWorker(swModules);
  }

  const [maj, min] = mf.version.split('.').map(Number);
  mf.version = `${maj}.${min}.${MOD_PATCH}`;

  await writeFile(mfPath, JSON.stringify(mf, null, 3), 'utf8');

  // 回报前自检：确认写出去的产物真的是我们要的
  const written = JSON.parse(await readFile(mfPath, 'utf8'));
  const expectedJs = contentScripts.map((entry) => `mod/${entry}`);
  const injectedEntry = written.content_scripts.find((cs) =>
    (cs.js || []).some((js) => js.startsWith('mod/')),
  );
  const injectedJs = injectedEntry ? injectedEntry.js : [];

  const orderOk = injectedJs.length === expectedJs.length
    && injectedJs.every((js, i) => js === expectedJs[i]);
  if (!orderOk) {
    throw new Error(`注入校验失败：期望 [${expectedJs.join(', ')}]，实际 [${injectedJs.join(', ')}]`);
  }

  // SW 模块绝不能被当成内容脚本注入（内容脚本没有 chrome.runtime.reload）
  const leakedSw = injectedJs.filter((js) => js.endsWith(SW_MODULE_SUFFIX));
  if (leakedSw.length) {
    throw new Error(`SW 模块被误注入为内容脚本: ${leakedSw.join(', ')}`);
  }

  log(`版本      ${written.version}${DEV ? '  (dev)' : ''}`);
  log(`产物      ${path.relative(ROOT, DIST)}/`);
  log(
    `加载      Arc → arc://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 ${path.relative(ROOT, DIST)}/`,
  );
}

main().catch((err) => {
  console.error(`[build] 失败: ${err.message}`);
  process.exit(1);
});
