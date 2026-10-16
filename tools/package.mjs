#!/usr/bin/env node
/**
 * 打「一键安装包」（`make package`）
 *
 *   node tools/package.mjs
 *
 * 产出 release/Linglass-Pro-<版本>-installer.zip，只装**我们自己的东西**：
 * 安装脚本、安装器、构建脚本、src/mod/ 与图文向导。
 *
 * ⚠️ 合规红线：发布包里绝不能出现 vendor/ 与 dist/ —— 那是 Linglass 的专有代码，
 * 本仓库不重新分发。官方基线由**用户本机**在安装时自己从 Chrome 商店拉。
 * 所以下面的清单是白名单（不是黑名单），而且打完包会读回来自检一遍。
 *
 * 版本号取自 dist/manifest.json，所以要先 `make build`（Makefile 里已经让 package 依赖 build）。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readZip, writeZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');

/** 白名单：只有这里列出的东西（以及 src/mod/ 下的 .js）会被打进发布包 */
const PACKAGE_FILES = [
  'install-macos.command',
  'install-windows.bat',
  'build.mjs',
  'tools/zip.mjs',
  'tools/import-vendor.mjs',
  'tools/install.mjs',
  'docs/install-guide.html',
];

/** 必须是可执行的（双击安装靠它，zip 的权限位很容易在打包环节悄悄丢掉） */
const EXECUTABLE = new Set(['install-macos.command']);

/** 这些前缀一旦出现在包里就是合规事故 */
const FORBIDDEN_PREFIXES = ['vendor/', 'dist/', 'release/'];

function log(msg) {
  console.log(`[package] ${msg}`);
}

/** 递归列出相对路径（统一用 `/`，zip 规范要求） */
async function collect(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...await collect(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.dev.js')) {
      // *.dev.js 只在 `make dev` 注入（build.mjs 会跳过），发给用户只是噪音
      out.push(rel);
    }
  }
  return out;
}

async function main() {
  const manifestPath = path.join(ROOT, 'dist', 'manifest.json');
  let version;
  try {
    version = JSON.parse(await readFile(manifestPath, 'utf8')).version;
  } catch {
    throw new Error('读不到 dist/manifest.json —— 先跑 make build');
  }

  const modFiles = await collect(path.join(ROOT, 'src', 'mod'));
  const names = [...PACKAGE_FILES, ...modFiles.map((rel) => `src/mod/${rel}`)];
  names.sort();

  const missing = [];
  const entries = [];
  for (const name of names) {
    try {
      const data = await readFile(path.join(ROOT, name));
      entries.push({ name, data, mode: EXECUTABLE.has(name) ? 0o755 : 0o644 });
    } catch {
      missing.push(name);
    }
  }
  if (missing.length) throw new Error(`清单里的文件不存在：${missing.join('、')}`);

  const zip = writeZip(entries);

  // 自检 1：拆解过的内容不该有官方代码或构建产物
  const packed = readZip(zip);
  const leaked = packed.filter((entry) => FORBIDDEN_PREFIXES.some((p) => entry.name.startsWith(p)));
  if (leaked.length) {
    throw new Error(`发布包里混进了不该发的东西：${leaked.map((e) => e.name).join('、')}`);
  }

  // 自检 2：入口文件齐全、可执行位没丢
  const byName = new Map(packed.map((entry) => [entry.name, entry]));
  for (const name of PACKAGE_FILES) {
    if (!byName.has(name)) throw new Error(`发布包里缺少 ${name}`);
  }
  if (byName.get('install-macos.command').mode !== 0o755) {
    throw new Error('install-macos.command 丢了可执行位，用户双击会没反应');
  }

  // 自检 3：安装器依赖的模块必须同行，否则用户双击才会发现
  if (!byName.has('tools/zip.mjs') || !byName.has('tools/import-vendor.mjs')) {
    throw new Error('发布包里缺少安装器依赖的 tools/ 模块');
  }

  await rm(RELEASE_DIR, { recursive: true, force: true });
  await mkdir(RELEASE_DIR, { recursive: true });

  const outName = `Linglass-Pro-${version}-installer.zip`;
  const outPath = path.join(RELEASE_DIR, outName);
  await writeFile(outPath, zip);

  log(`版本      ${version}`);
  log(`内容      ${packed.length} 个文件（官方代码 0 个）`);
  log(`产物      ${path.relative(ROOT, outPath)}  ${(zip.length / 1024).toFixed(1)} KB`);
  log('');
  log('发给别人时告诉对方：解压后 macOS 双击 install-macos.command，Windows 双击 install-windows.bat');
}

main().catch((err) => {
  console.error(`[package] 失败: ${err.message}`);
  process.exit(1);
});
