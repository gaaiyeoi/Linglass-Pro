/**
 * 一键安装器里「可测的那部分」的用例（PLAN 023）。
 *
 * `tools/install.mjs` 大部分动作是 IO 与平台分支（spawn 浏览器、打开文件管理器），
 * Node 里没法可靠断言，属于人工确认范围。但**候选浏览器表**是纯数据 + 一个
 * existsSync 过滤，它是安装流程里最容易悄悄错掉的地方（路径写错 = 用户双击后
 * 什么都不弹），所以单独锁住：
 *
 *   - macOS 表的顺序（先 Chrome 后 Arc）与各自的扩展页地址（arc:// 那个不一样）
 *   - Windows 表的反斜杠路径、覆盖「只装了当前用户」的情况
 *   - 缺环境变量时退回默认位置而不是抛错
 *   - Linux 只给 PATH 命令名，不猜安装路径
 *
 * 这里不会触发 main()：install.mjs 末尾有 `import.meta.url === argv[1]` 守卫。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { browserCandidates } from '../install.mjs';

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
};

test('安装器：macOS 表按 Chrome → Arc 顺序，扩展页地址各用各的', () => {
  const list = browserCandidates('darwin');

  assert.equal(list[0].name, 'Google Chrome');
  assert.equal(list[0].app, '/Applications/Google Chrome.app');
  assert.equal(list[0].url, 'chrome://extensions');

  const arc = list.find((c) => c.name === 'Arc');
  assert.ok(arc, 'Arc 必须在候选表里');
  assert.equal(arc.url, 'arc://extensions', 'Arc 的扩展页是 arc:// 而不是 chrome://');

  assert.ok(
    list.every((c) => c.app.startsWith('/Applications/')),
    'macOS 的候选都该是 /Applications 下的 .app',
  );
});

test('安装器：Windows 表是反斜杠路径，且覆盖用户级安装', () => {
  const list = browserCandidates('win32', WIN_ENV);

  assert.equal(list[0].app, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.ok(
    list.every((c) => c.app.includes('\\')),
    '在 macOS 上取这张表也不能拼出混合分隔符',
  );
  assert.ok(
    list.some((c) => c.app.startsWith('C:\\Users\\me\\AppData\\Local')),
    'Chrome 只给当前用户装时落在 LOCALAPPDATA，必须能找到',
  );
  assert.ok(list.some((c) => c.app.endsWith('msedge.exe')), 'Edge 也要覆盖');
});

test('安装器：Windows 缺环境变量时退回默认位置，不抛错', () => {
  const list = browserCandidates('win32', {});

  assert.ok(list.length > 0);
  assert.ok(list[0].app.startsWith('C:\\'), '拿不到 ProgramFiles 就用默认盘符路径');
});

test('安装器：Linux 只给 PATH 命令名，不猜安装路径', () => {
  const list = browserCandidates('linux');

  assert.equal(list[0].app, 'google-chrome');
  assert.ok(list.every((c) => c.viaPath === true), 'Linux 上不做文件存在性检查');
});

test('安装器：任何平台的候选都带齐 name / app / url', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const list = browserCandidates(platform, WIN_ENV);
    assert.ok(list.length > 0, `${platform} 至少要有一个候选`);
    for (const candidate of list) {
      assert.ok(candidate.name, `${platform} 的候选取名`);
      assert.ok(candidate.app, `${platform} 的候选 app`);
      assert.ok(
        candidate.url === 'chrome://extensions' || candidate.url === 'arc://extensions',
        `${platform} 的候选 url 必须是扩展管理页`,
      );
    }
  }
});
