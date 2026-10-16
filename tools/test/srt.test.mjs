/**
 * SRT 解析与「译文贴回计划」的用例（PLAN 031）。
 *
 * 与 ja-segment.test.mjs 同样的理由单独成文件：`05-srt.js` 是纯函数，不需要
 * DOM / chrome 桩件，喂一个空沙箱就能跑；`make test` 跑 `tools/test/*.test.mjs`，
 * 两个文件都会被带上。
 *
 * 覆盖的都是**真实文件里见过**的脏数据：BOM、CRLF、两种毫秒分隔符、缺序号行、
 * 一句多行、时间戳乱序、坏块、末块没有尾换行。
 *
 * ⚠️ 沙箱里造出来的对象带着**另一份 Object.prototype**，而本文件用的是
 * `node:assert/strict`（它的 `deepEqual` 就是 `deepStrictEqual`，会比原型）。
 * 所以凡是拿沙箱产物做结构断言的地方都先过一遍 `plain()`。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 纯函数模块：喂一个空沙箱就能跑起来（它只往 globalThis 上挂一个名字） */
async function loadSrt() {
  const source = await readFile(path.join(ROOT, 'src', 'mod', '05-srt.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.__llgModSrt;
}

/** 洗成宿主侧的普通对象/数组，好让 strict 的 deepEqual 只看值不看原型 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('SRT：BOM + CRLF + 逗号毫秒，正常解析', async () => {
  const srt = await loadSrt();
  const parsed = srt.parseSrt(
    '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\nおはよう\r\n\r\n'
    + '2\r\n00:00:03,500 --> 00:00:06,000\r\n今日は雨です\r\n',
  );

  assert.equal(parsed.length, 2);
  assert.deepEqual(plain(parsed), [
    { start: 1, end: 3.5, text: 'おはよう' },
    { start: 3.5, end: 6, text: '今日は雨です' },
  ]);
});

test('SRT：点号毫秒、缺序号行、一句多行拼成一行', async () => {
  const srt = await loadSrt();
  const parsed = srt.parseSrt(
    '00:00:01.250 --> 00:00:03.000\n今天\n下雨\n\n'
    + '2\n00:00:03.000 --> 00:00:05.000\n明天晴',
  );

  assert.equal(parsed.length, 2);
  assert.deepEqual(plain(parsed[0]), { start: 1.25, end: 3, text: '今天 下雨' });
  assert.deepEqual(plain(parsed[1]), { start: 3, end: 5, text: '明天晴' }, '末块没有尾换行也要收进来');
});

test('SRT：时间戳乱序也按 start 升序输出', async () => {
  const srt = await loadSrt();
  const parsed = srt.parseSrt(
    '2\n00:00:10,000 --> 00:00:12,000\n后一句\n\n'
    + '1\n00:00:01,000 --> 00:00:03,000\n前一句',
  );

  assert.deepEqual(plain(parsed.map((item) => item.text)), ['前一句', '后一句']);
  assert.ok(parsed[0].start < parsed[1].start);
});

test('SRT：坏块跳过，不让整次导入失败', async () => {
  const srt = await loadSrt();
  const parsed = srt.parseSrt(
    '这不是时间轴\n随手写的文字\n\n'            // 没有时间行
    + '3\n00:00:07,000 --> 00:00:09,000\n\n'   // 有时间行没有文本
    + '4\n00:00:04,000 --> 00:00:06,000\n好的一句\n\n'
    + '97 --> 128\n畸形时间轴\n'               // 段数不够
    + '\n',
  );

  assert.equal(parsed.length, 1);
  assert.deepEqual(plain(parsed[0]), { start: 4, end: 6, text: '好的一句' });
});

test('SRT：空输入与非字符串不抛错', async () => {
  const srt = await loadSrt();
  assert.deepEqual(plain(srt.parseSrt('')), []);
  assert.deepEqual(plain(srt.parseSrt(null)), []);
  assert.deepEqual(plain(srt.parseSrt(undefined)), []);
  assert.deepEqual(plain(srt.parseSrt(123)), []);
});

/** 轨道句的造法：与 10-subtitle-track.js 的 cue 形状一致（start / end / primary） */
function cue(start, end, primary = `s${start}`) {
  return { start, end, primary, secondary: '', origin: undefined };
}

test('贴回计划：按时间戳命中，assignments 带的是**轨道句**的 start', async () => {
  const srt = await loadSrt();
  const cues = [cue(0, 2.5), cue(2.5, 6), cue(6, 9.5)];
  const parsed = [
    { start: 0.05, end: 2.4, text: '早安' },
    { start: 2.6, end: 5.9, text: '今天下雨' },
  ];

  const plan = srt.planImport(cues, parsed);
  assert.equal(plan.total, 2);
  assert.equal(plan.missed.length, 0);
  assert.deepEqual(plain(plan.assignments), [
    { start: 0, secondary: '早安' },
    { start: 2.5, secondary: '今天下雨' },
  ]);
});

test('贴回计划：窗口里有多个候选时取重叠最大的那个', async () => {
  const srt = await loadSrt();
  const cues = [cue(0, 4), cue(4, 10)];

  // 4.5 → 5.5 与第二句重叠 1.0s，与第一句重叠 -0.5s → 选第二句
  const plan = srt.planImport(cues, [{ start: 4.5, end: 5.5, text: '后一句' }]);
  assert.deepEqual(plain(plan.assignments), [{ start: 4, secondary: '后一句' }]);
});

test('贴回计划：一个轨道句只贴一次', async () => {
  const srt = await loadSrt();
  const cues = [cue(0, 4), cue(4, 10)];
  const plan = srt.planImport(cues, [
    { start: 1, end: 3, text: '第一份' },
    { start: 1.2, end: 3.2, text: '第二份' },
  ]);

  assert.equal(plan.assignments.length, 1, '第一句占掉之后，第二句不能被贴到同一句上');
  assert.deepEqual(plain(plan.assignments[0]), { start: 0, secondary: '第一份' });
  assert.equal(plan.missed.length, 1, '抢不到的那句如实进 missed');
});

test('贴回计划：超出容差、缺文本、轨道为空都进 missed', async () => {
  const srt = await loadSrt();
  const cues = [cue(0, 4)];

  const far = srt.planImport(cues, [{ start: 100, end: 101, text: '对不上' }]);
  assert.equal(far.assignments.length, 0);
  assert.equal(far.missed.length, 1);

  const blank = srt.planImport(cues, [{ start: 1, end: 2, text: '' }]);
  assert.equal(blank.missed.length, 1);

  const empty = srt.planImport([], [{ start: 1, end: 2, text: '没轨道' }]);
  assert.equal(empty.assignments.length, 0);
  assert.equal(empty.total, 1);
});

test('贴回计划：容差可覆盖（导出与导入用了同源时间戳，正常几乎零偏差）', async () => {
  const srt = await loadSrt();
  const cues = [cue(0, 4)];

  // 4.9 句 —— 离窗口右边界 4 + 1.5 = 5.5 之内
  const close = srt.planImport(cues, [{ start: 4.9, end: 5.4, text: '擦边' }]);
  assert.equal(close.assignments.length, 1);

  // 5.6 —— 出窗口
  const beyond = srt.planImport(cues, [{ start: 5.6, end: 6.0, text: '出界' }]);
  assert.equal(beyond.missed.length, 1);
});

test('贴回计划：轨道句没有 end（还没定稿）时按默认窗口兜底', async () => {
  const srt = await loadSrt();
  const plan = srt.planImport([{ start: 10, end: null, primary: 'x' }],
    [{ start: 12, end: 13, text: '还没定稿也要贴得上' }]);
  assert.deepEqual(plain(plan.assignments), [{ start: 10, secondary: '还没定稿也要贴得上' }]);
});

test('指纹：句数 + 首句 + 末句，空轨道是零值', async () => {
  const srt = await loadSrt();
  assert.deepEqual(plain(srt.fingerprint([])), { count: 0, first: '', last: '' });

  const stamp = srt.fingerprint([cue(0, 1, 'A'), cue(1, 2, 'B'), cue(2, 3, 'C')]);
  assert.deepEqual(plain(stamp), { count: 3, first: 'A', last: 'C' });

  // 只看原文：只有译文的句子不计入（与导出原文的口径一致）
  assert.equal(srt.fingerprint([{ start: 0, end: 1, secondary: '只有译文' }]).count, 0);
});

test('指纹：sameFingerprint 判同', async () => {
  const srt = await loadSrt();
  const a = srt.fingerprint([cue(0, 1, 'A'), cue(1, 2, 'B')]);
  const b = srt.fingerprint([cue(0, 1, 'A'), cue(1, 2, 'B')]);
  const c = srt.fingerprint([cue(0, 1, 'A'), cue(1, 2, 'C')]);

  assert.equal(srt.sameFingerprint(a, b), true);
  assert.equal(srt.sameFingerprint(a, c), false, '末句变了就是不同');
  assert.equal(srt.sameFingerprint(a, srt.fingerprint([])), false, '句数变了就是不同');
  assert.equal(srt.sameFingerprint(a, null), false);
  assert.equal(srt.sameFingerprint(null, null), false);
});
