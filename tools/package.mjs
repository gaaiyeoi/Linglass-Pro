#!/usr/bin/env node
/**
 * 打安装包（`make package`）
 *
 *   node tools/package.mjs
 *
 * 产出两个东西到 release/（文件名里的版本号读作「官方基线 + 我们的补丁」，
 * 例如 1.12.4.900 = 官方 1.12.4 上叠第 900 号补丁）：
 *
 *   Linglass-Pro-<版本>-installer.zip   只有我们的代码 + 安装器 + 向导。
 *                                       对方要先装 Node，双击后由他本机从商店拉官方基线。
 *   Linglass-Pro-<版本>-extension.zip   完整包：dist/ 的全部内容 + 向导。
 *                                       解压后直接能在扩展管理页加载，不用装任何东西。
 *
 * ⚠️ 完整包含 Linglass 的官方代码。分发它是**使用者的选择**，风险由分发者承担 ——
 * 公开传播可能招致原作者投诉（乃至被 DMCA 下架）。仓库自身仍然只提交我们自己的代码，
 * vendor/ 与 dist/ 都不进版本控制。
 *
 * 纯代码包的自检仍然禁止出现 vendor/ 与 dist/（见 assertNoOfficialCode）——
 * 想发一个「干净」的包时就用它。
 *
 * 版本号取自 dist/manifest.json，所以要先 `make build`（Makefile 里 package 依赖 build）。
 * 注意 build.mjs 把 patch 固定为 900（避免和商店更新撞号），于是 1.12.3 与 1.12.4
 * 的产物版本号都是 1.12.900 —— 所以文件名必须补上官方基线的 patch 才分辨得出来。
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

/** 纯代码包的白名单：只有这里列出的（以及 src/mod/ 下的 .js）会被打进去 */
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

/** 纯代码包里一旦出现这些前缀就是合规事故（完整包不受这条约束） */
const INSTALLER_FORBIDDEN = ['vendor/', 'dist/', 'release/'];

/** 完整包里向导的落点：ASCII 文件名，中文名在部分解压工具上会乱码 */
const EXTENSION_GUIDE_NAME = 'INSTALL.html';

const GUIDE_SOURCE = path.join(ROOT, 'docs', 'install-guide.html');

function log(msg) {
  console.log(`[package] ${msg}`);
}

/**
 * 包的可读版本号：`<major>.<minor>.<官方 patch>.<我们的 patch>`。
 *
 * 为什么不能直接用 manifest 里的 `1.12.900`：官方一发小版本（1.12.3 → 1.12.4），
 * 产物版本号不变（major/minor 没动，patch 恒为 900），两个包会同名同号，
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
 *   ctx.baseVersion      官方基线版本，如 '1.12.4'
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

/** 纯代码包自检：混进官方代码或构建产物直接失败 */
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
    throw new Error('完整包里缺 mod/ 脚本 —— 这不是我们的产物');
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

  // 纯代码包：白名单 + src/mod 下全部非 dev 脚本
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
      throw new Error(`纯代码包里缺少 ${name}`);
    }
  }
  if (installerPacked.find((e) => e.name === 'install-macos.command').mode !== 0o755) {
    throw new Error('install-macos.command 丢了可执行位，用户双击会没反应');
  }

  // 完整包：dist/ 原样 + 向导
  const distFiles = await listFiles(DIST_DIR);
  const extensionFiles = await readEntries(DIST_DIR, distFiles);
  const extensionZip = buildArchive('extension', {
    ...context,
    extensionFiles,
  });
  const extensionPacked = assertExtensionLayout(
    extensionZip,
    archiveRootName(baseVersion, manifestVersion),
  );

  await rm(RELEASE_DIR, { recursive: true, force: true });
  await mkdir(RELEASE_DIR, { recursive: true });

  const outputs = [
    { kind: 'extension', buf: extensionZip, count: extensionPacked.length },
    { kind: 'installer', buf: installerZip, count: installerPacked.length },
  ];

  for (const output of outputs) {
    const name = packageFileName(output.kind, baseVersion, manifestVersion);
    const abs = path.join(RELEASE_DIR, name);
    await writeFile(abs, output.buf);
    const size = `${(output.buf.length / 1024 / 1024).toFixed(2)} MB`;
    const what = output.kind === 'extension' ? '含官方代码，下载即用' : '只有我们的代码，需装 Node';
    log(`${output.kind === 'extension' ? '完整包  ' : '纯代码包'}  ${path.relative(ROOT, abs)}`);
    log(`          ${output.count} 个文件 / ${size} / ${what}`);
  }

  console.log('');
  log('完整包：对方解压 → 在扩展管理页选中那个文件夹 → 完事（不用装 Node）');
  log('纯代码包：对方要先装 Node，再双击里面的安装文件（本机去商店拉官方基线）');
  log('⚠️ 完整包含 Linglass 官方代码，公开分发的风险请先看 README 对应一节');
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
