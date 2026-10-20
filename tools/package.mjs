#!/usr/bin/env node
/**
 * 打安装包（`make package`）
 *
 *   node tools/package.mjs
 *
 * 产出一个包到 release/（文件名里的版本号读作「基线版本 + patch 位」，
 * 例如 1.12.4.900 = Linglass 1.12.4 加 patch 900）：
 *
 *   Linglass-Pro-<版本>-installer.zip   本项目源码 + 安装脚本 + 图文向导。
 *                                       安装时需要 Node.js：脚本在本机从 Chrome 商店
 *                                       获取 Linglass 当前版本，再把 src/mod 合并进去。
 *
 * 发布包不含 vendor/ 与 dist/（见 assertNoOfficialCode）。
 *
 * 版本号取自 dist/manifest.json，所以要先 `make build`（Makefile 里 package 依赖 build）。
 * 注意 build.mjs 把 patch 固定为 900（避免和商店更新撞号），于是 1.12.3 与 1.12.4
 * 的产物版本号都是 1.12.900 —— 所以文件名必须补上基线 patch 才分辨得出来。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readZip, writeZip } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DIST_DIR = path.join(ROOT, 'dist');

/** dist/manifest.json 里 patch 位的固定值（与 build.mjs 的 MOD_PATCH 对应） */
const MOD_PATCH_FALLBACK = '900';

/** 发布包的白名单：只有这里列出的（以及 src/mod/ 下的 .js）会被打进去 */
const INSTALLER_FILES = [
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

/** 发布包里一旦出现这些前缀就是打包错误（完整包不受这条约束） */
const INSTALLER_FORBIDDEN = ['vendor/', 'dist/', 'release/'];

/** 完整包里向导的落点：ASCII 文件名，中文名在部分解压工具上会乱码 */
const EXTENSION_GUIDE_NAME = 'INSTALL.html';

const GUIDE_SOURCE = path.join(ROOT, 'docs', 'install-guide.html');

function log(msg) {
  console.log(`[package] ${msg}`);
}

/**
 * 包的可读版本号：`<major>.<minor>.<基线 patch>.<patch 位>`。
 *
 * 为什么不能直接用 manifest 里的 `1.12.900`：Linglass 一发小版本（1.12.3 → 1.12.4），
 * 产物版本号不变（major/minor 没动，patch 恒为 900），两次构建会同名同号，
 * 用户分不清手里是哪一个。
 */
export function readableVersion(baseVersion, manifestVersion) {
  // 逐段兜底而不是靠解构默认值：空串解构出来仍是空串，默认值只对 undefined 生效
  const [major = '', minor = '', modPatch = ''] = String(manifestVersion).split('.');
  const basePatch = String(baseVersion).split('.')[2] ?? '';
  return [
    major || '0',
    minor || '0',
    basePatch || '0',
    modPatch || MOD_PATCH_FALLBACK,
  ].join('.');
}

/** 文件名（kind 只认 'installer' 与 'extension'） */
export function packageFileName(kind, baseVersion, manifestVersion) {
  return `Linglass-Pro-${readableVersion(baseVersion, manifestVersion)}-${kind}.zip`;
}

/** 完整包内嵌的那一层目录名（不带扩展名，去掉 kind 后缀） */
export function archiveRootName(baseVersion, manifestVersion) {
  return `Linglass-Pro-${readableVersion(baseVersion, manifestVersion)}`;
}

/**
 * 打包。ctx 全是**已经读好的数据**（不碰文件系统），这样单测能喂假数据。
 *
 *   ctx.baseVersion      Linglass 基线版本，如 '1.12.4'
 *   ctx.manifestVersion  dist/manifest.json 里的版本，如 '1.12.900'
 *   ctx.installerFiles   [{ name, data, mode }]，项目根相对路径
 *   ctx.extensionFiles   [{ name, data, mode }]，dist 相对路径
 *   ctx.guide            Buffer，图文向导的内容
 */
export function buildArchive(kind, ctx) {
  if (kind === 'installer') return writeZip(ctx.installerFiles);
  if (kind === 'extension') return buildExtensionArchive(ctx);
  throw new Error(`未知的包类型: ${kind}`);
}

/**
 * 完整包：dist 的内容原样搬进内嵌层，再附一份向导。
 *
 * 内嵌一层是硬要求 —— 若让一百多个文件躺在 zip 根，macOS 的归档实用工具会
 * 把它们直接摊到用户的下载目录里。内嵌之后解压只得到一个文件夹，正好拿去加载。
 */
function buildExtensionArchive(ctx) {
  const root = `${archiveRootName(ctx.baseVersion, ctx.manifestVersion)}/`;
  const entries = ctx.extensionFiles.map((file) => ({ ...file, name: root + file.name }));
  entries.push({ name: root + EXTENSION_GUIDE_NAME, data: ctx.guide, mode: 0o644 });
  return writeZip(entries);
}

/** 发布包自检：混进 vendor/ 或构建产物直接失败 */
export function assertNoOfficialCode(zip) {
  const packed = readZip(zip);
  const leaked = packed.filter((entry) =>
    INSTALLER_FORBIDDEN.some((prefix) => entry.name.startsWith(prefix)));
  if (leaked.length) {
    throw new Error(`发布包里混进了不该发的东西：${leaked.map((e) => e.name).join('、')}`);
  }
  return packed;
}

/** 完整包自检：必须内嵌一层、manifest.json 在该层根、且不能混进安装器的东西 */
export function assertExtensionLayout(zip, rootName) {
  const packed = readZip(zip);
  const prefix = `${rootName}/`;

  const stray = packed.filter((entry) => !entry.name.startsWith(prefix));
  if (stray.length) {
    throw new Error(`完整包里有散落在根的文件（解压会摊一地）：${stray.map((e) => e.name).join('、')}`);
  }
  if (!packed.some((entry) => entry.name === `${prefix}manifest.json`)) {
    throw new Error('完整包里找不到内嵌层根上的 manifest.json，加载扩展会失败');
  }
  if (!packed.some((entry) => entry.name === `${prefix}mod/00-shared.js`)) {
    throw new Error('完整包里缺 mod/ 脚本 —— 产物不完整');
  }
  const installerBait = packed.find((entry) => entry.name.endsWith('install-macos.command'));
  if (installerBait) {
    throw new Error(`完整包里混进了安装器文件：${installerBait.name}`);
  }
  return packed;
}

/** 递归列出相对路径（统一用 `/`，zip 规范要求） */
async function listFiles(dir, prefix = '', accept = () => true) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const out = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...await listFiles(path.join(dir, entry.name), rel, accept));
    } else if (accept(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/** 取 vendor/ 下版本号最大的那一份作为基线（与 build.mjs 的挑法一致） */
async function pickBaseVersion() {
  const versions = (await readdir(VENDOR_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('linglass-'))
    .map((entry) => entry.name.replace(/^linglass-/, ''))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!versions.length) throw new Error('vendor/ 下找不到 linglass-* 目录，先跑 make vendor-update');
  return versions[versions.length - 1];
}

async function readEntries(baseDir, names) {
  const out = [];
  for (const name of names) {
    out.push({
      name,
      data: await readFile(path.join(baseDir, name)),
      mode: EXECUTABLE.has(name) ? 0o755 : 0o644,
    });
  }
  return out;
}

async function main() {
  const manifestPath = path.join(DIST_DIR, 'manifest.json');
  let manifestVersion;
  try {
    manifestVersion = JSON.parse(await readFile(manifestPath, 'utf8')).version;
  } catch {
    throw new Error('读不到 dist/manifest.json —— 先跑 make build');
  }

  const baseVersion = await pickBaseVersion();
  const version = readableVersion(baseVersion, manifestVersion);
  log(`基线      vendor/linglass-${baseVersion}（文件名里的 ${version}）`);

  // 发布包：白名单 + src/mod 下全部非 dev 脚本
  const modFiles = await listFiles(
    path.join(ROOT, 'src', 'mod'),
    '',
    (rel) => rel.endsWith('.js') && !rel.endsWith('.dev.js'),
  );
  const installerNames = [...INSTALLER_FILES, ...modFiles.map((rel) => `src/mod/${rel}`)].sort();
  const installerFiles = await readEntries(ROOT, installerNames);
  const guide = await readFile(GUIDE_SOURCE);

  const context = { baseVersion, manifestVersion, installerFiles, guide };

  const installerZip = buildArchive('installer', context);
  const installerPacked = assertNoOfficialCode(installerZip);
  for (const name of INSTALLER_FILES) {
    if (!installerPacked.some((entry) => entry.name === name)) {
      throw new Error(`发布包里缺少 ${name}`);
    }
  }
  if (installerPacked.find((e) => e.name === 'install-macos.command').mode !== 0o755) {
    throw new Error('install-macos.command 丢了可执行位，用户双击会没反应');
  }

  await rm(RELEASE_DIR, { recursive: true, force: true });
  await mkdir(RELEASE_DIR, { recursive: true });

  const name = packageFileName('installer', baseVersion, manifestVersion);
  const abs = path.join(RELEASE_DIR, name);
  await writeFile(abs, installerZip);
  const size = `${(installerZip.length / 1024 / 1024).toFixed(2)} MB`;
  log(`发布包    ${path.relative(ROOT, abs)}`);
  log(`          ${installerPacked.length} 个文件 / ${size} / 仅含本项目源码，需装 Node`);

  console.log('');
  log('安装前先装 Node，再双击解压目录里的安装文件');
  log('安装时由本机从 Chrome 商店获取 Linglass 当前版本，再与本项目源码合并');
}

/** 只在被直接执行时跑 main（被 import 时什么都不做，方便单测构包函数） */
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[package] 失败: ${err.message}`);
    process.exit(1);
  });
}
