/**
 * 文节切分的规则用例（PLAN 020）。
 *
 * 为什么单独一个文件，而不是并进 smoke.test.mjs：`05-ja-segment.js` 是纯函数，
 * 不需要 DOM / chrome 桩件，加载方式比 harness() 简单得多；而 smoke.test.mjs
 * 此刻正被另一个会话改动，往里追加会把别人的改动卷进同一次提交
 * （AGENTS.md §4「一个 PLAN = 一个提交」）。`make test` 跑的是
 * `tools/test/*.test.mjs`，两个文件都会被带上。
 *
 * 用例口径来自需求里的 10 条基本规则，其中两个完整句子是逐字验收项。
 * 除具体切分外，每个文本都过一遍与实现无关的不变量：切点严格升序、
 * 拼回去必须等于原文（规范第 1 条「除插入 | 外不得改写原文」）。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 纯函数模块：喂一个空沙箱就能跑起来（它只往 globalThis 上挂一个名字） */
async function loadSegment() {
  const source = await readFile(path.join(ROOT, 'src', 'mod', '05-ja-segment.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, cut: sandbox.__llgModJaSegment.cut };
}

/** 把切点还原成「一节一个元素」的数组（宿主侧数组，便于 deepEqual） */
function sections(cut, text) {
  const out = [];
  let prev = 0;
  for (const point of cut(text)) {
    out.push(text.slice(prev, point));
    prev = point;
  }
  // 切点落在句末时没有尾巴 —— 不补空串
  if (prev < text.length) out.push(text.slice(prev));
  return out;
}

/** 切点必须严格升序、不越界，且拼回去等于原文 */
function assertInvariants(cut, text) {
  const points = cut(text);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i] > points[i - 1], `${text} 的切点必须严格升序`);
  }
  assert.ok(points.length === 0 || points[points.length - 1] <= text.length, '切点不能越界');
  assert.equal(sections(cut, text).join(''), text, '切出来的节拼回去必须等于原文');
}

test('文节切分：需求里给的两个完整句子逐字对齐', async () => {
  const { cut } = await loadSegment();

  assert.deepEqual(
    sections(cut, '私は昨日図書館で日本語の本を借りました。'),
    ['私は', '昨日', '図書館で', '日本語の', '本を', '借りました。'],
  );
  assert.deepEqual(
    sections(cut, '先生がゆっくり説明してくれたので、よく分かりました。'),
    ['先生が', 'ゆっくり', '説明してくれたので、', 'よく', '分かりました。'],
  );
});

test('文节切分：数词与量词、时间单位连成一个文节（规则 8）', async () => {
  const { cut } = await loadSegment();

  assert.deepEqual(sections(cut, '三冊の本を読みました。'), ['三冊の', '本を', '読みました。']);
  assert.deepEqual(sections(cut, '2026年に卒業します。'), ['2026年に', '卒業します。']);
  assert.deepEqual(sections(cut, '三人で映画を見ました。'), ['三人で', '映画を', '見ました。']);
  assert.deepEqual(
    sections(cut, '5時に起きて、散歩して、それから仕事へ行く。'),
    ['5時に', '起きて、', '散歩して、', 'それから', '仕事へ', '行く。'],
  );
  // 量词链要能连着长：数词 → 量词 → 量词的后缀 / 再接一个数词
  assert.deepEqual(sections(cut, '3年後に会いましょう。'), ['3年後に', '会いましょう。']);
  assert.deepEqual(sections(cut, '10月3日に東京へ行く。'), ['10月3日に', '東京へ', '行く。']);
  assert.deepEqual(sections(cut, '100万円を借りた。'), ['100万円を', '借りた。']);
  assert.deepEqual(sections(cut, '1ヶ月で三冊読んだ。'), ['1ヶ月で', '三冊', '読んだ。']);
  // 但量词链到此为止：紧跟的假名是动词开头，不能吸进来（规则 2 的反面）
  assert.deepEqual(sections(cut, '2時間半かかった。'), ['2時間半', 'かかった。']);
});

test('文节切分：疑问数词只在接量词时才算数词（何か 不能拆）', async () => {
  const { cut } = await loadSegment();

  assert.deepEqual(sections(cut, '何か食べたい。'), ['何か', '食べたい。']);
  assert.deepEqual(sections(cut, '何回も読んだ。'), ['何回も', '読んだ。']);
  assert.deepEqual(sections(cut, '何人か来ました。'), ['何人か', '来ました。']);
});

test('文节切分：复合名词、专有名词、外来语复合词不拆（规则 8）', async () => {
  const { cut } = await loadSegment();

  assert.deepEqual(
    sections(cut, '日本語学校で勉強しています。'),
    ['日本語学校で', '勉強しています。'],
  );
  assert.deepEqual(sections(cut, '東京都に住んでいます。'), ['東京都に', '住んでいます。']);
  assert.deepEqual(
    sections(cut, 'コンピューターゲームで遊ぶ。'),
    ['コンピューターゲームで', '遊ぶ。'],
  );
  assert.deepEqual(
    sections(cut, '会社員として働いています。'),
    ['会社員として', '働いています。'],
  );

  // 反向守卫：时间名词不许被后缀名词吸走；「日本語 + 上手」也不许连成一节
  assert.deepEqual(
    sections(cut, '私は昨日学校へ行きました。'),
    ['私は', '昨日', '学校へ', '行きました。'],
  );
  assert.deepEqual(
    sections(cut, '昨日学校で友達に会った。'),
    ['昨日', '学校で', '友達に', '会った。'],
  );
  assert.deepEqual(sections(cut, '日本語上手ですね。'), ['日本語', '上手ですね。']);
});

test('文节切分：动词 / 形容词与其活用、补助动词连成整体（规则 3 / 4）', async () => {
  const { cut } = await loadSegment();

  for (const text of [
    '見せてもらいました。',
    '読んでいます。',
    '行かなかった。',
    '勉強してみたい。',
    '美しかった。',
    '静かではありません。',
  ]) {
    // 整句就是一个文节 —— 里面没有可画分隔符的位置
    assert.equal(cut(text).length, 0, `${text} 整体只有一个文节，不该画分隔符`);
    assertInvariants(cut, text);
  }
});

test('文节切分：格助词后的假名尾巴按「谓语是否进行中」判断', async () => {
  const { cut } = await loadSegment();

  // 谓语链内部的副助词（見せ + て + も）之后，假名尾巴要回黏
  assert.deepEqual(sections(cut, '見せてもらいました。'), ['見せてもらいました。']);
  // 独立的名词短语之后，假名是新词的开头，不能回黏
  assert.deepEqual(sections(cut, 'きれいな花をかいました'), ['きれいな', '花を', 'かいました']);
  assert.deepEqual(sections(cut, 'ここでたべられます'), ['ここで', 'たべられます']);
});

test('文节切分：提示助词跟在格助词后面也不许切开（规则 2 / 10）', async () => {
  const { cut } = await loadSegment();

  assert.deepEqual(sections(cut, '学校には行きません。'), ['学校には', '行きません。']);
  assert.deepEqual(sections(cut, '学校にも行きました。'), ['学校にも', '行きました。']);
  assert.deepEqual(sections(cut, '本を読むのにかかった。'), ['本を', '読むのに', 'かかった。']);
  assert.deepEqual(sections(cut, '東京への電車に乗る。'), ['東京への', '電車に', '乗る。']);
  // 但 か / た 这种「长得像助词的新词首字」仍然不许回黏（既有用例）
  assert.deepEqual(sections(cut, 'きれいな花をかいました'), ['きれいな', '花を', 'かいました']);
});

test('文节切分：固定语法与形式名词保持自然整体（规则 7）', async () => {
  const { cut } = await loadSegment();

  assert.deepEqual(sections(cut, '知らないわけではない。'), ['知らない', 'わけではない。']);
  assert.deepEqual(
    sections(cut, '日本語を勉強することができます。'),
    ['日本語を', '勉強する', 'ことが', 'できます。'],
  );
  assert.deepEqual(
    sections(cut, '図書館へ行くために、電車に乗ります。'),
    ['図書館へ', '行く', 'ために、', '電車に', '乗ります。'],
  );
  assert.deepEqual(
    sections(cut, 'よく分かるように説明してください。'),
    ['よく', '分かるように', '説明してください。'],
  );
  assert.deepEqual(
    sections(cut, 'もっと勉強しなければならない。'),
    ['もっと', '勉強しなければならない。'],
  );
});

test('文节切分：副词 / 接续词 / 感叹词单独成文节（规则 6）', async () => {
  const { cut } = await loadSegment();

  assert.deepEqual(
    sections(cut, 'これはとてもおいしいケーキです。'),
    ['これは', 'とても', 'おいしい', 'ケーキです。'],
  );
  assert.deepEqual(sections(cut, 'しかし、そうはいきません。'), ['しかし、', 'そうは', 'いきません。']);
  assert.deepEqual(sections(cut, 'きっと来ると信じています。'), ['きっと', '来ると', '信じています。']);
  assert.deepEqual(
    sections(cut, 'ゆっくり歩いて、しっかり食べる。'),
    ['ゆっくり', '歩いて、', 'しっかり', '食べる。'],
  );
  // 副词后面跟全假名的动词：不能因为「后面的词全是假名」就黏成一节
  assert.deepEqual(sections(cut, 'しっかりみてください'), ['しっかり', 'みてください']);
  assert.deepEqual(
    sections(cut, '散歩してそれから仕事へ行く。'),
    ['散歩して', 'それから', '仕事へ', '行く。'],
  );
});

test('文节切分：逗号只跟着上一节，不额外制造断点（规则 9）', async () => {
  const { cut } = await loadSegment();

  // 逗号黏在上一节尾巴上，所以分隔符落在逗号之后
  assert.deepEqual(sections(cut, '本を読んだ、そして寝た。'), ['本を', '読んだ、', 'そして', '寝た。']);
  assert.deepEqual(sections(cut, '昨日、買った本を読む。'), ['昨日、', '買った', '本を', '読む。']);
});

test('文节切分：整句不变量（切点升序 / 拼回原文）与非日语行放过', async () => {
  const { cut } = await loadSegment();

  for (const text of [
    '私は昨日図書館で日本語の本を借りました。',
    '先生がゆっくり説明してくれたので、よく分かりました。',
    '日本語学校で勉強しています。',
    'コンピューターゲームで遊ぶ。',
    '「本」を読んだ、そして寝た。',
    '3ヶ月で三冊の本を読みました。',
    'きのうはあめでした',
  ]) {
    assertInvariants(cut, text);
  }

  for (const text of ['这个句子不应该被处理', 'hello world', '']) {
    assert.equal(cut(text).length, 0, `${text} 不该被处理`);
  }
});
