/**
 * 打包逻辑的用例（PLAN 024）。
 *
 * 这里锁的都是「错了也不会报错、只会让用户拿到坏包」的地方：
 *
 *   - 完整包有没有内嵌一层（没有的话，一百多个文件会摊到用户的下载目录里）
 *   - manifest.json 在不在内嵌层的根（不在的话加载扩展直接失败）
 *   - 纯代码包里有没有混进官方代码或构建产物（合规红线）
 *   - 官方只动 patch 时（1.12.3 → 1.12.4），两个包的文件名会不会撞
 *     —— 产物版本号恒为 <major>.<minor>.900，不做区分就是同名同号
 *
 * 构包函数收的是「已经读好的数据」，所以这里不碰文件系统，喂假 ctx 即可。
 * import 本模块不会触发 main()：package.mjs 末尾有 argv[1] 守卫。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  archiveRootName,
  assertExtensionLayout,
  assertNoOfficialCode,
  buildArchive,
  packageFileName,
  readableVersion,
} from '../package.mjs';
import { readZip, writeZip } from '../zip.mjs';

const ROOT_NAME = 'Linglass-Pro-1.12.4.900';

function fakeContext(overrides = {}) {
  return {
    baseVersion: '1.12.4',
    manifestVersion: '1.12.900',
    installerFiles: [
      { name: 'install-macos.command', data: '#!/bin/bash\n', mode: 0o755 },
      { name: 'tools/install.mjs', data: 'export {};\n', mode: 0o644 },
    ],
    extensionFiles: [
      { name: 'manifest.json', data: '{"version":"1.12.900"}', mode: 0o644 },
      { name: 'mod/00-shared.js', data: 'const a = 1;\n', mode: 0o644 },
    ],
    guide: Buffer.from('<p>hi</p>', 'utf8'),
    ...overrides,
  };
}

test('打包：版本号把官方基线的 patch 补进文件名', () => {
  assert.equal(readableVersion('1.12.4', '1.12.900'), '1.12.4.900');
  assert.equal(
    packageFileName('extension', '1.12.4', '1.12.900'),
    'Linglass-Pro-1.12.4.900-extension.zip',
  );
  assert.equal(
    packageFileName('installer', '1.12.4', '1.12.900'),
    'Linglass-Pro-1.12.4.900-installer.zip',
  );
  assert.equal(archiveRootName('1.12.4', '1.12.900'), ROOT_NAME);
});

test('打包：官方只动 patch 时，两版的文件名不会撞', () => {
  // build.mjs 把 patch 固定成 900，所以 1.12.3 与 1.12.4 的产物版本号都是 1.12.900
  const older = packageFileName('extension', '1.12.3', '1.12.900');
  const newer = packageFileName('extension', '1.12.4', '1.12.900');

  assert.notEqual(older, newer, '文件名必须能分辨基于哪个官方版本');
  assert.ok(older.includes('1.12.3.900') && newer.includes('1.12.4.900'));
});

test('打包：版本串残缺时不崩，退回默认值', () => {
  assert.equal(readableVersion('1.12', '1.12'), '1.12.0.900');
  assert.equal(readableVersion('', ''), '0.0.0.900');
});

test('打包：完整包内嵌一层，且 manifest.json 落在该层根', () => {
  const packed = readZip(buildArchive('extension', fakeContext()));

  assert.deepEqual(
    packed.map((entry) => entry.name).sort(),
    [`${ROOT_NAME}/INSTALL.html`, `${ROOT_NAME}/manifest.json`, `${ROOT_NAME}/mod/00-shared.js`],
  );
  assert.ok(
    packed.every((entry) => entry.name.startsWith(`${ROOT_NAME}/`)),
    '任何文件都不许散落在 zip 根（macOS 解压会直接摊到下载目录）',
  );

  const guide = packed.find((entry) => entry.name.endsWith('INSTALL.html'));
  assert.equal(guide.data.toString('utf8'), '<p>hi</p>', '向导要带上');
});

test('打包：完整包自检——散落根 / 缺 manifest / 缺 mod / 混进安装器都会失败', () => {
  assert.equal(assertExtensionLayout(buildArchive('extension', fakeContext()), ROOT_NAME).length, 3);

  const stray = writeZip([{ name: 'manifest.json', data: '{}' }]);
  assert.throws(() => assertExtensionLayout(stray, ROOT_NAME), /散落在根/);

  const noManifest = writeZip([{ name: `${ROOT_NAME}/mod/00-shared.js`, data: 'x' }]);
  assert.throws(() => assertExtensionLayout(noManifest, ROOT_NAME), /manifest\.json/);

  const noMod = writeZip([{ name: `${ROOT_NAME}/manifest.json`, data: '{}' }]);
  assert.throws(() => assertExtensionLayout(noMod, ROOT_NAME), /mod\//);

  const bait = writeZip([
    { name: `${ROOT_NAME}/manifest.json`, data: '{}' },
    { name: `${ROOT_NAME}/mod/00-shared.js`, data: 'x' },
    { name: `${ROOT_NAME}/install-macos.command`, data: 'x' },
  ]);
  assert.throws(() => assertExtensionLayout(bait, ROOT_NAME), /安装器文件/);
});

test('打包：纯代码包自检拒绝官方代码与构建产物', () => {
  const clean = writeZip([
    { name: 'install-macos.command', data: 'x', mode: 0o755 },
    { name: 'src/mod/00-shared.js', data: 'x' },
  ]);
  assert.equal(assertNoOfficialCode(clean).length, 2);

  for (const prefix of ['vendor', 'dist', 'release']) {
    const dirty = writeZip([{ name: `${prefix}/something.js`, data: 'x' }]);
    assert.throws(() => assertNoOfficialCode(dirty), /不该发的东西/, `${prefix}/ 必须被拒绝`);
  }
});

test('打包：纯代码包保留可执行位（用户靠它双击）', () => {
  const packed = readZip(buildArchive('installer', fakeContext()));
  assert.equal(packed.find((entry) => entry.name === 'install-macos.command').mode, 0o755);
  assert.equal(packed.find((entry) => entry.name === 'tools/install.mjs').mode, 0o644);
});

test('打包：未知包类型直接报错，不静默产出空包', () => {
  assert.throws(() => buildArchive('whatever', fakeContext()), /未知的包类型/);
});
