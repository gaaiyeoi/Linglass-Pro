#!/usr/bin/env node
/**
 * 导入官方新版本作为只读基线
 *
 *   node tools/import-vendor.mjs --download              从 Chrome 商店拉取最新版
 *   node tools/import-vendor.mjs --from ~/linglass.crx   从本地 crx / zip 导入
 *   node tools/import-vendor.mjs --from /path/to/unpacked  从已解压目录导入
 *
 * 导入后不需要改任何代码：build.mjs 会自动挑版本号最大的 vendor/linglass-* 作为基线。
 * 自带的 mod 代码全部在 src/mod/ 下，与基线版本无关。
 *
 * 加 --force 可覆盖同版本已存在的目录。
 *
 * crx/zip 的解包用仓库自带的 tools/zip.mjs（手写、零依赖），所以不依赖系统 unzip ——
 * macOS 不用再要求用户装命令行工具，Windows 上也能跑。
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipTo } from './zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(ROOT, 'vendor');

/** Linglass 在 Chrome 商店的扩展 ID（产物里 chromewebstore 链接可佐证） */
const EXT_ID = 'nhncklckpmkkhjcijjgfcgclfpbbkcba';

const CRX_URL =
  'https://clients2.google.com/service/update2/crx?response=redirect' +
  '&os=mac&arch=arm64&os_arch=arm64&nacl_arch=arm64' +
  '&prod=chromiumcrx&prodchannel=unknown&prodversion=140.0.0.0' +
  `&acceptformat=crx2,crx3&x=id%3D${EXT_ID}%26uc`;

function log(msg) {
  console.log(`[vendor] ${msg}`);
}

function parseArgs(argv) {
  const args = { download: false, from: null, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--download') args.download = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--from') args.from = argv[i + 1] ?? null;
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

/** CRX 只是「一段头部 + 一个 zip」，剥掉头部就能交给 unzip */
function crxToZip(buf) {
  if (buf.subarray(0, 4).toString('utf8') !== 'Cr24') return buf;

  const version = buf.readUInt32LE(4);
  let offset;
  if (version === 2) {
    offset = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  } else if (version === 3) {
    offset = 12 + buf.readUInt32LE(8);
  } else {
    throw new Error(`不支持的 CRX 版本: ${version}`);
  }
  return buf.subarray(offset);
}

/** 允许传进来的目录外面多包一层，自动下钻到含 manifest.json 的那一层 */
async function resolveRoot(dir) {
  const direct = path.join(dir, 'manifest.json');
  try {
    await stat(direct);
    return dir;
  } catch {
    // 继续往下找
  }

  const entries = await readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length === 1) {
    return resolveRoot(path.join(dir, dirs[0].name));
  }
  throw new Error(`${dir} 里找不到 manifest.json`);
}

async function preparePayload(args) {
  if (args.download) {
    log(`下载  ${CRX_URL.slice(0, 72)}…`);
    const res = await fetch(CRX_URL);
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    log(`下载完成  ${(buf.length / 1024 / 1024).toFixed(2)} MB`);

    return { kind: 'archive', buf: crxToZip(buf) };
  }

  const src = path.resolve(args.from.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  const info = await stat(src);

  if (info.isDirectory()) {
    log(`来源  目录 ${src}`);
    return { kind: 'dir', dir: src };
  }

  log(`来源  文件 ${src}`);
  return { kind: 'archive', buf: crxToZip(await readFile(src)) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.download && !args.from)) {
    console.log(`
用法：
  node tools/import-vendor.mjs --download              从 Chrome 商店拉取最新版
  node tools/import-vendor.mjs --from <crx|zip|目录>    从本地导入
  node tools/import-vendor.mjs --from <...> --force     覆盖同版本已有目录
`);
    process.exit(args.help ? 0 : 1);
  }

  await mkdir(VENDOR_DIR, { recursive: true });
  const tmp = await mkdtemp(path.join(tmpdir(), 'linglass-vendor-'));

  try {
    const payload = await preparePayload(args);

    let root;
    if (payload.kind === 'dir') {
      root = await resolveRoot(payload.dir);
    } else {
      const outDir = path.join(tmp, 'extracted');
      await mkdir(outDir, { recursive: true });
      log('解开  归档');
      await unzipTo(payload.buf, outDir);
      root = await resolveRoot(outDir);
    }

    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    const version = manifest.version;
    if (!version) throw new Error('提取出的 manifest.json 没有 version 字段');

    const dest = path.join(VENDOR_DIR, `linglass-${version}`);

    let exists = false;
    try {
      await stat(dest);
      exists = true;
    } catch {
      exists = false;
    }

    if (exists && !args.force) {
      log(`vendor/linglass-${version} 已存在，无需导入（要覆盖加 --force）`);
      return;
    }
    if (exists) {
      log(`覆盖  vendor/linglass-${version}`);
      await rm(dest, { recursive: true, force: true });
    }

    await cp(root, dest, { recursive: true });
    log(`写入  vendor/linglass-${version}   ${manifest.name ?? ''} v${version}`);
    log('下一步：make build');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[vendor] 失败: ${err.message}`);
  process.exit(1);
});
