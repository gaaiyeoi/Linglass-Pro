/**
 * AI 翻译纯函数的用例（PLAN 034）。
 *
 * 与 srt.test.mjs 同样的理由单独成文件：`06-ai-translate.js` 不碰 DOM / chrome，
 * 喂一个空沙箱就能跑；`make test` 跑 `tools/test/*.test.mjs`，这个文件会被带上。
 *
 * 重点覆盖两种会让译文**整批错位**的输入：模型少返回一条、返回里夹着解释文字。
 * 前者必须判失败（宁可整批跳过），后者必须能捞出数组。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function loadModule() {
  const source = await readFile(path.join(ROOT, 'src', 'mod', '06-ai-translate.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.__llgModAiTranslate;
}

/** 洗成宿主侧对象，避免 strict 的 deepEqual 被沙箱原型干扰 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('AI 翻译：配置归一补默认值、裁未知项', async () => {
  const ai = await loadModule();

  const defaults = ai.normalizeConfig(null);
  assert.equal(defaults.provider, 'deepseek');
  assert.equal(defaults.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(defaults.model, 'deepseek-chat');
  assert.equal(defaults.target, 'zh-CN');
  assert.equal(defaults.key, '');
  // 默认「只翻缺失」：默认重翻全部会让第二次点 AI 翻译覆盖已有译文（含手工导入的
  // SRT）并把整片重新请求一遍。显式取消勾选仍然生效（见下面的 explicit 用例）。
  assert.equal(defaults.skipExisting, true, '默认只翻缺失的句子');

  const custom = ai.normalizeConfig({
    provider: 'custom',
    baseUrl: '  https://example.com/v1  ',
    model: ' my-model ',
    key: '  sk-test  ',
    target: 'xx',
    skipExisting: 'yes',
  });
  assert.equal(custom.provider, 'custom');
  assert.equal(custom.baseUrl, 'https://example.com/v1');
  assert.equal(custom.model, 'my-model');
  assert.equal(custom.key, 'sk-test');
  assert.equal(custom.target, 'zh-CN', '未知语言退回默认');
  assert.equal(custom.skipExisting, true, '非布尔值退回默认（true）');

  const explicit = ai.normalizeConfig({ skipExisting: false, wholeContext: true });
  assert.equal(explicit.skipExisting, false, '用户显式取消勾选要生效');
  assert.equal(explicit.wholeContext, true, '整片上下文仍是显式开启');

  const unknown = ai.normalizeConfig({ provider: 'nope' });
  assert.equal(unknown.provider, 'deepseek', '未知服务商退回默认预设');
  assert.equal(unknown.baseUrl, 'https://api.deepseek.com/v1');
});

test('AI 翻译：接口地址三种写法都归一成 /chat/completions', async () => {
  const ai = await loadModule();

  assert.equal(ai.chatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions');
  assert.equal(ai.chatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(ai.chatUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(
    ai.chatUrl('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
    '完整地址不要重复拼',
  );
  assert.equal(ai.chatUrl('   '), '');
});

test('AI 翻译：切批只取有原文的句，按条数与字数分批', async () => {
  const ai = await loadModule();
  const cues = [
    { start: 0, primary: '一' },
    { start: 1, primary: '' },
    { start: 2, secondary: '只有译文' },
    { start: 3, primary: '三三' },
    { start: 4, primary: '四四四' },
    { start: Number.NaN, primary: '坏时间戳' },
  ];

  const byItems = plain(ai.planBatches(cues, { maxItems: 2, maxChars: 9999 }));
  assert.equal(byItems.length, 2);
  assert.deepEqual(byItems[0].items, [
    { start: 0, text: '一' },
    { start: 3, text: '三三' },
  ]);
  assert.deepEqual(byItems[1].items, [{ start: 4, text: '四四四' }]);

  // 1 + 2 = 3 ≤ 4，再加 3 就超了，所以第三句单独成批
  const byChars = plain(ai.planBatches(cues, { maxItems: 99, maxChars: 4 }));
  assert.deepEqual(byChars, [
    { items: [{ start: 0, text: '一' }, { start: 3, text: '三三' }] },
    { items: [{ start: 4, text: '四四四' }] },
  ]);

  assert.deepEqual(plain(ai.planBatches([])), [], '空轨道没有批次');
});

test('AI 翻译：prompt 带目标语言、字幕约束与前后文', async () => {
  const ai = await loadModule();
  const messages = ai.buildMessages(['おはよう', 'こんにちは'], 'zh-CN', {
    title: 'テスト回',
    before: ['前の句'],
    after: ['次の句'],
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /简体中文/);
  assert.match(messages[0].content, /JSON 字符串数组/);
  assert.match(messages[0].content, /丸ハラ/, '缩写不许硬音译，要给出例子');
  assert.match(messages[0].content, /碎片/, '要说明字幕是被时间切开的碎片');

  assert.match(messages[0].content, /本次共 2 条/, '条数直接写进 prompt 比只说「等长」有效');
  assert.match(messages[0].content, /绝不能和相邻条合并/, '半句话也必须单独成条');

  const user = messages[1].content;
  assert.match(user, /视频标题：テスト回/);
  assert.match(user, /【前文｜只作参考，不要翻译，不要输出】\n\["前の句"\]/);
  assert.match(user, /【待翻译｜共 2 条，逐条翻译，输出等长 JSON 数组】\n\["おはよう","こんにちは"\]/);
  assert.match(user, /【后文｜只作参考，不要翻译，不要输出】\n\["次の句"\]/);

  // 没有标题与前后文时不该出现空标签（省 token，也免得模型去翻空数组）
  const bare = ai.buildMessages(['あ'], 'en');
  assert.ok(!bare[1].content.includes('【前文'));
  assert.ok(!bare[1].content.includes('【后文'));
  assert.ok(!bare[1].content.includes('视频标题'));
});

test('AI 翻译：解析纯数组 / 代码围栏 / 前后有解释文字', async () => {
  const ai = await loadModule();

  assert.deepEqual(plain(ai.parseTranslationContent('["甲","乙"]', 2)), {
    ok: true,
    lines: ['甲', '乙'],
  });

  assert.deepEqual(plain(ai.parseTranslationContent('```json\n["甲","乙"]\n```', 2)), {
    ok: true,
    lines: ['甲', '乙'],
  });

  assert.deepEqual(
    plain(ai.parseTranslationContent('好的，结果如下：\n["甲","乙"]\n希望有帮助', 2)),
    { ok: true, lines: ['甲', '乙'] },
    '数组前后的解释文字要能容忍',
  );

  assert.deepEqual(plain(ai.parseTranslationContent('[{"text":"甲"},{"translation":"乙"}]', 2)), {
    ok: true,
    lines: ['甲', '乙'],
  });
});

test('AI 翻译：重试时改成编号对象格式（逼模型逐条输出）', async () => {
  const ai = await loadModule();
  const messages = ai.buildMessages(['あ', 'い'], 'zh-CN', {}, { indexed: true });

  assert.match(messages[0].content, /JSON 对象/);
  assert.match(messages[0].content, /"1" 到 "2"/);
  assert.match(messages[0].content, /共 2 个键/);
  assert.match(messages[1].content, /【待翻译｜共 2 条，输出 \{"1":"…"\} 形式的对象】/);
  // 编号对象的返回仍然能被解析
  assert.deepEqual(plain(ai.parseTranslationContent('{"1":"甲","2":"乙"}', 2)), {
    ok: true,
    lines: ['甲', '乙'],
  });
});

test('AI 翻译：整片模式发全片编号原文，只要求指定条号', async () => {
  const ai = await loadModule();
  const messages = ai.buildWholeMessages(['句1', '句2', '句3', '句4'], 'zh-CN', 3, 4, {
    title: 'テスト回',
    brief: '丸ハラ=句号骚扰',
  });

  assert.match(messages[0].content, /第 3 到 4 条/);
  assert.match(messages[0].content, /"3" 到 "4"/);
  assert.match(messages[0].content, /丸ハラ=句号骚扰/);

  const user = messages[1].content;
  assert.match(user, /视频标题：テスト回/);
  assert.match(user, /【全片字幕｜键是条号，只翻译第 3-4 条】\n\{"1":"句1","2":"句2","3":"句3","4":"句4"\}/);
  assert.match(user, /【本次要翻译的条号】3-4（共 2 条/);

  // 返回 3..4（不是从 1 开始）也要能对齐
  assert.deepEqual(plain(ai.parseTranslationContent('{"3":"丙","4":"丁"}', 2)), {
    ok: true,
    lines: ['丙', '丁'],
  });
  // 缺号 / 多号仍然失败
  assert.equal(ai.parseTranslationContent('{"3":"丙"}', 2).ok, false);
  assert.equal(ai.parseTranslationContent('{"3":"丙","4":"丁","5":"戊"}', 2).ok, false);
});

test('AI 翻译：前文按字数封顶，保留离待翻译最近的几句', async () => {
  const ai = await loadModule();
  const before = Array.from({ length: 400 }, (_, i) => `${'あ'.repeat(40)}${i}`);
  const messages = ai.buildMessages(['あ'], 'zh-CN', { before });

  const user = messages[1].content;
  const list = JSON.parse(/【前文｜[^\n]*\n(\[[^\n]*\])/.exec(user)[1]);

  assert.ok(list.length < 400, '不能把 400 句全塞进去');
  assert.ok(list.join('').length <= ai.CONTEXT_BEFORE_CHARS, '前文总字数要守住上限');
  assert.equal(list[list.length - 1], before[before.length - 1], '保留的是离待翻译最近的那批');
});

test('AI 翻译：全片语境摘要要求术语与非音译，且注入到后续请求的 system', async () => {
  const ai = await loadModule();
  const lines = Array.from({ length: 50 }, (_, i) => `句子${i}`);
  const brief = ai.buildBriefMessages(lines, 'zh-CN');

  assert.equal(brief.length, 2);
  assert.match(brief[0].content, /300 字/);
  assert.match(brief[0].content, /丸ハラ/, '要给出缩写该怎么处理');
  assert.match(brief[0].content, /不要音译/);
  assert.match(brief[1].content, /【全片字幕｜按时间顺序】\n\["句子0"/);

  const withBrief = ai.buildMessages(['あ'], 'zh-CN', { brief: '丸ハラ=句号骚扰' });
  assert.match(withBrief[0].content, /【全片语境/);
  assert.match(withBrief[0].content, /丸ハラ=句号骚扰/);
});

test('AI 翻译：带序号的对象、一行一条也能救回来', async () => {
  const ai = await loadModule();

  assert.deepEqual(plain(ai.parseTranslationContent('{"1":"甲","2":"乙"}', 2)), {
    ok: true,
    lines: ['甲', '乙'],
  });

  // 一行一条：剥掉常见编号前缀
  assert.deepEqual(plain(ai.parseTranslationContent('1. 甲\n2. 乙\n3、丙', 3)), {
    ok: true,
    lines: ['甲', '乙', '丙'],
  });

  // 行数不等仍然判失败（少一条就会整批错位）
  assert.equal(ai.parseTranslationContent('1. 甲\n2. 乙', 3).ok, false);

  // 被截断的 JSON 不能当成「一行一条」救回来
  assert.equal(ai.parseTranslationContent('["甲","乙"', 2).ok, false);
});

test('AI 翻译：条数不符 / 坏 JSON / 非数组都判失败', async () => {
  const ai = await loadModule();

  const short = ai.parseTranslationContent('["只有一条"]', 2);
  assert.equal(short.ok, false);
  assert.match(short.reason, /条数不符/);

  const malformed = ai.parseTranslationContent('甲、乙', 2);
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /等长的 JSON 数组/);

  const notArray = ai.parseTranslationContent('{"a":1}', 1);
  assert.equal(notArray.ok, false);

  const empty = ai.parseTranslationContent('   ', 1);
  assert.equal(empty.ok, false);

  const badElement = ai.parseTranslationContent('["甲", 2]', 2);
  assert.equal(badElement.ok, false);
  assert.match(badElement.reason, /无法识别/);
});
