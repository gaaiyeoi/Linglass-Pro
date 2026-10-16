/**
 * 零依赖 zip 读 + 写
 *
 * 本仓库要求不引入任何第三方依赖，而 Node 自带的 `zlib` 只提供 deflate/inflate，
 * 不管 zip 容器格式，所以这里手写最小可用的 zip 解析与打包。
 *
 *   readZip(buffer)      → [{ name, mode, isDir, data }]
 *   unzipTo(buffer, dir) → 落盘，返回解出来的条目名
 *   writeZip(entries)    → Buffer
 *
 * 两个用途：
 *   1. 解 Chrome 商店下发的 CRX（剥掉头部之后就是一个普通 zip）
 *   2. `make package` 打发布包（要保留 install-macos.command 的可执行位）
 *
 * 刻意不支持的部分（遇到就明确报错，不静默解错）：
 *   - zip64（CRX 远不到 4GB）
 *   - 加密条目
 *   - zip slip 路径（`..` 与绝对路径 / 盘符）
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** EOCD 定长部分 22 字节，后面最多跟 65535 字节注释 */
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** 值的上限：中央目录里出现这些「满值」就是在说「真值在 zip64 扩展里」 */
const ZIP64_SENTINEL = 0xffffffff;
const ZIP64_COUNT_SENTINEL = 0xffff;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/** 打开「用 Unix 权限位」的宿主标记（version made by 的高字节） */
const HOST_UNIX = 3;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

/** 导出是为了让测试能手工构造「非本仓库 writer 产出」的样本，并对着已知向量校准 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 从尾部往前找 EOCD —— 注释长度不定，所以只能倒着扫 */
function findEocd(buf) {
  const floor = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('不是有效的 zip：找不到 EOCD 记录');
}

/** zip slip 防护：`..`、绝对路径、Windows 盘符一律拒绝 */
function assertSafeName(name) {
  if (!name) throw new Error('zip 里有空文件名');
  if (name.startsWith('/') || name.startsWith('\\')) {
    throw new Error(`zip 里有不安全的路径条目（绝对路径）: ${name}`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new Error(`zip 里有不安全的路径条目（盘符）: ${name}`);
  }
  if (name.split(/[\\/]/).includes('..')) {
    throw new Error(`zip 里有不安全的路径条目（上跳）: ${name}`);
  }
}

function inflate(method, data, name) {
  if (method === METHOD_STORE) return data;
  if (method === METHOD_DEFLATE) return zlib.inflateRawSync(data);
  throw new Error(`zip 条目用了不支持的解压方式 ${method}: ${name}`);
}

/**
 * 解出全部条目。数据描述符（flag bit 3）不用特殊处理 —— 压缩后大小以中央目录为准，
 * 那才是权威值（local header 在这种情况下写的是 0）。
 */
export function readZip(buf) {
  const eocd = findEocd(buf);

  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (centralOffset === ZIP64_SENTINEL || count === ZIP64_COUNT_SENTINEL) {
    throw new Error('这个 zip 用了 zip64，本仓库的解析器不支持');
  }
  if (centralOffset + centralSize > buf.length) {
    throw new Error('zip 中央目录越界：文件可能被截断');
  }

  const entries = [];
  let cursor = centralOffset;

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_SIG) {
      throw new Error(`zip 中央目录第 ${i + 1} 条签名不对`);
    }

    const madeBy = buf.readUInt16LE(cursor + 4);
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const crc = buf.readUInt32LE(cursor + 16);
    const compSize = buf.readUInt32LE(cursor + 20);
    const rawSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const attrs = buf.readUInt32LE(cursor + 38);
    const localOffset = buf.readUInt32LE(cursor + 42);

    if (compSize === ZIP64_SENTINEL || rawSize === ZIP64_SENTINEL) {
      throw new Error('zip 用了 zip64，本仓库的解析器不支持');
    }
    if (flags & 0x1) throw new Error('zip 里有加密条目，不支持');

    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    assertSafeName(name);

    const isDir = name.endsWith('/');
    if (isDir) {
      entries.push({ name, isDir: true, mode: null, data: Buffer.alloc(0) });
      continue;
    }

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`zip 条目 ${name} 的 local header 签名不对`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;

    const compressed = buf.subarray(dataStart, dataStart + compSize);
    const data = inflate(method, compressed, name);

    if (data.length !== rawSize) {
      throw new Error(`zip 条目 ${name} 解出来 ${data.length} 字节，预期 ${rawSize}`);
    }
    if (crc32(data) !== crc) {
      throw new Error(`zip 条目 ${name} 的 CRC 对不上：文件可能在下载中损坏`);
    }

    // external attrs 高 16 位是 st_mode（含文件类型位），只有 Unix 打包的才有意义
    const host = (madeBy >> 8) & 0xff;
    const mode = host === HOST_UNIX && (attrs >>> 16) ? ((attrs >>> 16) & 0o7777) : null;

    entries.push({ name, isDir: false, mode, data, crc });
  }

  return entries;
}

/** 解压落盘。Windows 上不设权限位（chmod 语义不同，设了反而可能让文件变只读） */
export async function unzipTo(buf, outDir) {
  const entries = readZip(buf);
  const names = [];

  for (const entry of entries) {
    const dest = path.join(outDir, ...entry.name.split('/'));
    if (entry.isDir) {
      await mkdir(dest, { recursive: true });
      continue;
    }

    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, entry.data);
    if (process.platform !== 'win32' && entry.mode) await chmod(dest, entry.mode);
    names.push(entry.name);
  }

  return names;
}

/**
 * 打包成 zip。
 *
 * entries: [{ name, data (Buffer|string), mode (number, 默认 0o644) }]
 * 目录不用显式列出 —— 解压方按路径自己建（Windows 资源管理器与 macOS 都认）。
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeName(entry.name);
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const mode = entry.mode ?? 0o644;
    const crc = crc32(raw);
    // 压不小就别压了，省得解压方多走一趟 inflate
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    const nameBuf = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x800, 6);         // flag: 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);            // mod time
    local.writeUInt16LE(0x21, 12);         // mod date（1980-01-01，固定值让产物可复现）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE((HOST_UNIX << 8) | 20, 4);  // made by: Unix + 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk start
    central.writeUInt16LE(0, 36);          // internal attrs
    central.writeUInt32LE((mode & 0o7777) << 16, 38);  // external attrs：高 16 位是 mode
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(EOCD_MIN);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);                          // 本磁盘号
  eocd.writeUInt16LE(0, 6);                          // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8);             // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10);            // 总条目数
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                         // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd]);
}
