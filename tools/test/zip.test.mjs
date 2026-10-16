/**
 * 手写 zip 读写模块的用例（PLAN 023）。
 *
 * 为什么单独一个文件：`tools/zip.mjs` 是纯函数/纯 IO 模块，不需要 DOM / chrome 桩件，
 * 加载方式和 smoke.test.mjs 的 harness() 无关。`make test` 跑的是
 * `tools/test/*.test.mjs`，这个文件会被自动带上。
 *
 * 重点覆盖两类风险：
 *   1. 我们自己 writeZip 出来的东西，自己解不回来（往返）
 *   2. **别人**打出来的 zip（含畸形/恶意样本）—— 解析器不能只会认自家格式，
 *      所以下面有一个手工拼字节的 rawZip()，故意不走 writeZip
 *
 * zip slip 与 zip64 是刻意写出来的边界用例：前者必须「先全部校验、再落盘」，
 * 后者必须明确报错而不是解出错数据。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { crc32, readZip, unzipTo, writeZip } from '../zip.mjs';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * 手工拼一个最小 zip（只用 stored，不走 writeZip）。
 *
 * 存在的意义是「构造 writeZip 不肯产出的样本」：zip slip 路径、假 zip64、
 * 非 Unix 宿主的权限位。参数开关就是给这些用例用的。
 */
function rawZip(entries, opts = {}) {
  const host = opts.hostUnix ? 3 : 0;
  const mode = opts.mode ?? 0o644;
  const compSizeOverride = opts.compSizeOverride ?? null;

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.text ?? '', 'utf8');
    const crc = opts.badCrc ? (crc32(data) ^ 0xff) >>> 0 : crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);            // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const compSize = compSizeOverride ?? data.length;
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE((host << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);         // stored
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compSize, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((mode & 0o7777) << 16, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'linglass-zip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('zip 往返：UTF-8 文件名、权限位、内容逐字节一致', () => {
  const command = Buffer.from('#!/bin/bash\necho hi\n', 'utf8');
  const buf = writeZip([
    { name: 'install-macos.command', data: command, mode: 0o755 },
    { name: 'src/mod/00-shared.js', data: 'const a = 1;\n' },
    { name: 'docs/使用说明.html', data: '<p>中文</p>' },
  ]);

  const entries = readZip(buf);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['install-macos.command', 'src/mod/00-shared.js', 'docs/使用说明.html'],
  );
  assert.deepEqual(entries[0].data, command);
  assert.equal(entries[0].mode, 0o755, '可执行位必须保住（双击安装靠它）');
  assert.equal(entries[1].mode, 0o644, '默认权限位');
  assert.equal(entries[2].data.toString('utf8'), '<p>中文</p>');
});

test('zip 落盘：解出文件树并恢复可执行位', async (t) => {
  const dir = await tempDir(t);
  const buf = writeZip([
    { name: 'tools/install.mjs', data: 'export {};\n' },
    { name: 'install-macos.command', data: '#!/bin/bash\n', mode: 0o755 },
  ]);

  const names = await unzipTo(buf, dir);
  assert.deepEqual(names.sort(), ['install-macos.command', 'tools/install.mjs']);

  assert.equal(await readFile(path.join(dir, 'tools', 'install.mjs'), 'utf8'), 'export {};\n');
  if (process.platform !== 'win32') {
    const info = await stat(path.join(dir, 'install-macos.command'));
    assert.equal(info.mode & 0o777, 0o755);
  }
});

test('压缩策略：压得动的走 deflate，压不动的走 stored', () => {
  const repetitive = 'あ'.repeat(50000);
  const packed = writeZip([{ name: 'big.txt', data: repetitive }]);
  assert.ok(packed.length < repetitive.length / 4, '高度重复的内容必须被压掉');

  const tiny = writeZip([{ name: 'a.txt', data: 'x' }]);
  assert.ok(tiny.length > 1, '单字节内容压不动，应退回 stored（长度是 header 开销）');

  // 两条路径都要能解回来（往返覆盖 deflate 分支）
  assert.equal(readZip(packed)[0].data.toString('utf8'), repetitive);
  assert.equal(readZip(tiny)[0].data.toString('utf8'), 'x');
});

test('CRC32 对得住已知向量', () => {
  // 外部真值：'123456789' 的 CRC32 = 0xCBF43926（与实现无关的校准点）
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
});

test('能解非本仓库 writer 打出来的 zip（含 Unix 权限位）', () => {
  const buf = rawZip(
    [
      { name: 'a/b.txt', text: 'hello' },
      { name: 'run.sh', text: '#!/bin/sh\n' },
    ],
    { hostUnix: true, mode: 0o755 },
  );

  const entries = readZip(buf);
  assert.deepEqual(entries.map((e) => e.data.toString('utf8')), ['hello', '#!/bin/sh\n']);
  assert.equal(entries[1].mode, 0o755);
});

test('拒绝 zip slip：上跳、绝对路径、盘符，且一个文件都不落盘', async (t) => {
  const dir = await tempDir(t);
  const attacks = ['../evil.txt', '/tmp/evil.txt', 'C:\\evil.exe', 'a/../../evil.txt'];

  for (const name of attacks) {
    const buf = rawZip([
      { name: 'ok.txt', text: 'safe' },
      { name, text: 'pwned' },
    ]);

    assert.throws(() => readZip(buf), /不安全的路径条目/, `${name} 必须被拒绝`);
    await assert.rejects(
      () => unzipTo(buf, dir),
      /不安全的路径条目/,
      `${name} 落盘前必须被拒绝`,
    );
  }

  // 「先全部校验、再落盘」：连排在前面的正常条目也不该被写出去
  assert.deepEqual(await readdir(dir), []);
});

test('拒绝 zip64：明确报错，不静默解错', () => {
  const buf = rawZip([{ name: 'a.txt', text: 'x' }], { compSizeOverride: 0xffffffff });
  assert.throws(() => readZip(buf), /zip64/);
});

test('拒绝损坏：CRC 对不上、文件被截断', () => {
  assert.throws(
    () => readZip(rawZip([{ name: 'a.txt', text: 'x' }], { badCrc: true })),
    /CRC 对不上/,
  );

  const good = rawZip([{ name: 'a.txt', text: 'x' }]);
  assert.throws(() => readZip(good.subarray(0, good.length - 8)), /EOCD|越界|截断/);
});

test('writeZip 自己也不接受危险路径', () => {
  assert.throws(() => writeZip([{ name: '../evil.txt', data: 'x' }]), /路径条目/);
  assert.throws(() => writeZip([{ name: '/evil.txt', data: 'x' }]), /路径条目/);
});
