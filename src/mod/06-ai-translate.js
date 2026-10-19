/**
 * AI 翻译的纯函数（PLAN 034）
 *
 * 定位：把 PLAN 031 的「导出原文 → 扩展外翻好 → 导入译文」那条离线链路，
 * 收成页面内的一个按钮 —— 用户填自己的 API Key，按批把原文发给 OpenAI 兼容接口，
 * 再把译文贴回轨道（贴回用的是轨道已有的 `applyTranslations`，本模块不碰 DOM）。
 *
 * 只回答五件事，一个 DOM 都不碰，所以能被 Node 侧的测试直接驱动：
 *
 *   1. normalizeConfig(raw)               配置补默认值 / 裁未知项
 *   2. chatUrl(baseUrl)                   接口地址 → .../chat/completions
 *   3. planBatches(cues, options)         按条数 / 字数切批（只取有原文的句）
 *   4. buildMessages(texts, targetLang)   OpenAI 兼容的 messages
 *   5. parseTranslationContent(text, n)   模型返回 → 等长译文数组，或失败原因
 *
 * ── 一条硬约定：条数不等就判失败 ──
 * 贴回是按 `start` 对齐的（PLAN 031），如果模型少返回一条，后面每一条都会**错位**贴到
 * 上一句上。错位的译文比没有译文更糟，所以这里宁可整批跳过、如实报失败，也不做
 * 「尽力对齐」。
 *
 * 挂在 globalThis.__llgModAiTranslate 上（与 05-srt.js 同款做法）。
 */
(() => {
  'use strict';

  const NS = '__llgModAiTranslate';
  if (globalThis[NS]) return;

  /**
   * 服务商预设。
   *
   * 全部是 OpenAI 兼容的 `/chat/completions`，所以一套请求格式通吃。
   * `baseUrl` 写到 `/v1` 为止（`chatUrl()` 负责补最后一段）：DeepSeek 也接受不带 `/v1`，
   * 但 OpenAI 必须带，统一带上是更稳的默认值。
   */
  const PROVIDERS = [
    { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'moonshot', label: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    {
      id: 'siliconflow',
      label: 'SiliconFlow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'Qwen/Qwen2.5-7B-Instruct',
    },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
    { id: 'custom', label: '自定义', baseUrl: '', model: '' },
  ];

  /** 目标语言。值直接用 BCP 47 标签，prompt 里取中文名。 */
  const TARGETS = [
    { id: 'zh-CN', label: '简体中文' },
    { id: 'zh-TW', label: '繁體中文' },
    { id: 'en', label: 'English' },
    { id: 'ja', label: '日本語' },
    { id: 'ko', label: '한국어' },
  ];

  const DEFAULT_CONFIG = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    key: '',
    target: 'zh-CN',
    /**
     * 默认只翻缺失的句子。
     *
     * 默认翻全部（false）时，用户第二次点「AI 翻译」—— 哪怕只想补翻漏掉的几句 ——
     * 会把整片已翻内容（包括手工导入的 SRT 译文）重新请求并覆盖，直接烧额度。
     * 想重翻的人可以在面板上取消勾选，而不是让默认值替所有人做这个决定。
     */
    skipExisting: true,
    /** 整片原文是否随每条请求一起发（更准、更贵，需要 64k+ 上下文模型） */
    wholeContext: false,
  };

  // 一批 20 句 / 1200 字。
  //
  // 一开始是 40 句 / 2000 字，真实长播客上出现了大面积整批失败：40 句的译文很容易顶到
  // 不少模型的默认输出上限（4096 tokens），响应被截断 → JSON 不完整 → 整批报废。
  // 20 句的译文通常不到一半上限，同时请求数只翻一倍，是更稳的取值。
  const MAX_ITEMS = 20;
  const MAX_CHARS = 1200;

  /**
   * 前文窗口的上限（字符）。
   *
   * 上限管的是**输入**，与每批输出条数无关 —— 之前整批失败是输出被截断，不是输入太长。
   * 3000 字日文约等于 100~150 条字幕，足够让缩写、指代、话题连续性都落在眼里；
   * 再长对准确率的边际收益很小，却会让最便宜的 8k 模型直接超限。
   */
  const CONTEXT_BEFORE_CHARS = 3000;
  /** 后文只用来消解「半句还没说完」，不需要太长 */
  const CONTEXT_AFTER_CHARS = 600;
  /** 全片语境预处理的输入上限（约 1 小时的播客；再长就只取前 2 万字） */
  const BRIEF_MAX_CHARS = 20000;
  /** 语境摘要本身的上限，避免模型写成一篇分析文章把后面的上下文挤掉 */
  const BRIEF_RESPONSE_CHARS = 1500;
  /**
   * 「整片上下文」模式的输入上限。
   *
   * 整片原文会随**每一条**请求重发，所以这个上限同时也是「能不能用」的门槛：
   * 3 万字日文约 2~3 万 token，128k 上下文模型毫无压力；8k 的便宜模型会直接 400，
   * 面板会在第一次失败后自动退回分段模式（见 40-study-panel.js）。
   */
  const WHOLE_MAX_CHARS = 30000;

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function preset(id) {
    return PROVIDERS.find((item) => item.id === id) || null;
  }

  /**
   * 配置归一。未知服务商 / 语言退回默认值，缺地址与模型时用服务商预设补上 ——
   * 这样用户只换 Key 就能直接用（也是「填个 Key 就能翻」的最小代价）。
   */
  function normalizeConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const provider = preset(src.provider) ? src.provider : DEFAULT_CONFIG.provider;
    const fallback = preset(provider) || preset(DEFAULT_CONFIG.provider);
    const target = TARGETS.some((item) => item.id === src.target) ? src.target : DEFAULT_CONFIG.target;
    // 布尔项只在用户**明确表过态**时采用输入值；`null` / `'yes'` 这类一律退回默认。
    // skipExisting 的默认值是 true（见 DEFAULT_CONFIG 的说明），不能写成 `=== true`。
    const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

    return {
      provider,
      baseUrl: text(src.baseUrl) || fallback.baseUrl,
      model: text(src.model) || fallback.model,
      key: text(src.key),
      target,
      skipExisting: bool(src.skipExisting, DEFAULT_CONFIG.skipExisting),
      wholeContext: bool(src.wholeContext, DEFAULT_CONFIG.wholeContext),
    };
  }

  /**
   * 接口地址归一。
   *
   * 用户可能填 `https://api.deepseek.com`、`.../v1`、或直接粘完整
   * `.../v1/chat/completions`，三种都要能用 —— 否则「地址填什么都报 404」这件事
   * 会被当成我们的 bug。
   */
  function chatUrl(baseUrl) {
    const base = text(baseUrl).replace(/\/+$/, '');
    if (!base) return '';
    if (/\/chat\/completions$/i.test(base)) return base;
    return `${base}/chat/completions`;
  }

  /**
   * 切批。
   *
   * 只取有原文的句子（译文为空不是「已翻」，而是「没原文」——可能是只采到译文的句）。
   * 一条超长句也能单独成批：先放进空批，再在下一轮因为超限被切开。
   *
   * @param {Array<{start: number, primary?: string}>} cues
   * @param {{maxItems?: number, maxChars?: number}} [options]
   * @returns {Array<{items: Array<{start: number, text: string}>}>}
   */
  function planBatches(cues, options = {}) {
    const maxItems = Math.max(1, Number(options.maxItems) || MAX_ITEMS);
    const maxChars = Math.max(1, Number(options.maxChars) || MAX_CHARS);
    const list = Array.isArray(cues) ? cues : [];
    const batches = [];
    let current = [];
    let chars = 0;

    for (const cue of list) {
      const source = text(cue && cue.primary);
      if (!source) continue;
      const start = Number(cue && cue.start);
      if (!Number.isFinite(start)) continue;

      if (current.length && (current.length >= maxItems || chars + source.length > maxChars)) {
        batches.push({ items: current });
        current = [];
        chars = 0;
      }

      current.push({ start, text: source });
      chars += source.length;
    }

    if (current.length) batches.push({ items: current });
    return batches;
  }

  function targetLabel(id) {
    const found = TARGETS.find((item) => item.id === id);
    return found ? found.label : id;
  }

  /** 统一成「若干行文本」，并把空行剔掉（context 里的空句没有价值） */
  function cleanLines(list) {
    if (!Array.isArray(list)) return [];
    return list.map((item) => String(item ?? '').trim()).filter(Boolean);
  }

  /** 从末尾往前取，直到加不下为止（前文要「离待翻译最近的那几行」） */
  function tailLines(lines, maxChars) {
    const list = cleanLines(lines);
    const out = [];
    let chars = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const line = list[i];
      if (out.length && chars + line.length > maxChars) break;
      out.unshift(line);
      chars += line.length;
    }
    return out;
  }

  /** 从头往后取（后文要「紧接在待翻译之后的那几行」） */
  function headLines(lines, maxChars) {
    const list = cleanLines(lines);
    const out = [];
    let chars = 0;
    for (const line of list) {
      if (out.length && chars + line.length > maxChars) break;
      out.push(line);
      chars += line.length;
    }
    return out;
  }

  /**
   * 两种输出格式共用的翻译规矩（第 1 条「格式」由各调用方补）。
   * 抽出来是为了让「分段」与「整片」两条路径不会各自漂移。
   */
  const COMMON_RULES = [
    '2. 字幕是按时间切开的碎片，可能半句话就被切断：借助上下文理解整句，',
    '   但输出只保留**这一条**对应的部分，不要合并、不要把别的条的内容补进来。',
    '   哪怕某条只有半句话、一两个词或一个语气词，也必须单独占一条，',
    '   绝不能和相邻条合并 —— 合并会让后面所有条错位。',
    '3. 译文要像中文母语者写的字幕：脱离翻译腔，口语自然，保留原文的语气',
    '   （随意 / 敬语 / 吐槽 / 情绪）与称呼关系。',
    '4. 日本特有的文化词、网络流行语、缩写、专有名词，按中文读者能懂的方式意译；',
    '   没有通用译法时给简短意译，可在中文括号里补两三个字说明，',
    '   **不要音译成没有意义的汉字词**（例如「丸ハラ」指「句号骚扰」，不是「丸原」）。',
    '5. 数字、时间、人名地名按中文习惯写；不要擅自改动事实信息。',
    '6. 某条确实听不清或无法翻译时，原样返回该条。',
    '7. 若给出「全片语境」，其中的术语译法优先级最高，全片保持一致。',
  ];

  /**
   * 一次请求的 messages。
   *
   * ── 为什么要带前后文（2026-10-19 的真实反馈）──
   * 字幕是按时间切开的碎片：「丸ハラ」这种缩写、半句被切断的语法、指代前面出现过的人名，
   * 单看一条都翻不准（实测被音译成了「丸原」）。所以每次请求除了「待翻译」，
   * 还附上**紧邻的几行原文**当参考 —— 只作理解用，不进输出。
   *
   * ── 为什么用 JSON 数组 ──
   * 行内标点、换行、引号都不会把批次切歪，模型也更难自作主张合并/拆句。
   *
   * 前文按字数封顶（`CONTEXT_BEFORE_CHARS`）而不是条数：字幕长短差异很大，
   * 「最近 100 条」可能只有 200 字，也可能有 5000 字。
   *
   * `options.indexed`：重试专用格式 —— 让模型输出键为 `"1".."N"` 的 JSON 对象。
   * 漏掉/合并一条时数组只会「少一个元素」，看不出少了哪条；带编号则每一条都必须出现，
   * 模型也更容易自我核对（实测「条数不符（期望 20，实际 19）」掉得明显更少）。
   *
   * @param {string[]} texts 待翻译
   * @param {string} targetLang
   * @param {{title?: string, brief?: string, before?: string[], after?: string[]}} [context]
   * @param {{indexed?: boolean}} [options]
   */
  function buildMessages(texts, targetLang, context = {}, options = {}) {
    const list = Array.isArray(texts) ? texts.map((item) => String(item ?? '')) : [];
    const target = targetLabel(targetLang);
    const before = tailLines(context.before, CONTEXT_BEFORE_CHARS);
    const after = headLines(context.after, CONTEXT_AFTER_CHARS);
    const title = typeof context.title === 'string' ? context.title.trim() : '';
    const brief = typeof context.brief === 'string' ? context.brief.trim().slice(0, BRIEF_RESPONSE_CHARS) : '';
    const indexed = options.indexed === true;
    const count = list.length;

    const system = [
      `你是一位精通日语与中文的资深字幕译者，把日语字幕译成${target}。`,
      '硬性要求：',
      indexed
        ? `1. 输出一个 JSON 对象，键必须是字符串 "1" 到 "${count}" 的连续编号，`
          + `共 ${count} 个键，一个都不能少；值是一条译文。不要输出数组、解释或代码块。`
        : `1. 只翻译「待翻译」里的每一条，输出 JSON 字符串数组：本次共 ${count} 条，`
          + '元素个数必须等于这个数、顺序一致；不要输出「前文 / 后文」、解释或代码块。',
      ...COMMON_RULES,
    ];

    if (brief) {
      system.push('');
      system.push('【全片语境（由整片字幕整理，术语按这里的译法）】');
      system.push(brief);
    }

    const parts = [];
    if (title) parts.push(`视频标题：${title}`);
    if (before.length) {
      parts.push('【前文｜只作参考，不要翻译，不要输出】');
      parts.push(JSON.stringify(before));
    }
    parts.push(indexed
      ? `【待翻译｜共 ${count} 条，输出 {"1":"…"} 形式的对象】`
      : `【待翻译｜共 ${count} 条，逐条翻译，输出等长 JSON 数组】`);
    parts.push(JSON.stringify(list));
    if (after.length) {
      parts.push('【后文｜只作参考，不要翻译，不要输出】');
      parts.push(JSON.stringify(after));
    }

    return [
      { role: 'system', content: system.join('\n') },
      { role: 'user', content: parts.join('\n') },
    ];
  }

  /**
   * 整片上下文模式（PLAN 034 追加）。
   *
   * ── 为什么不是「整片一次翻完」──
   * 几百句的译文远超声出上限（DeepSeek 默认 4096、上限 8192 tokens），
   * 一次请求必然被截断 —— 那正是最早整批报废的原因。所以这里只把**输入**放大：
   * 全片编号原文一次放进去，只要求翻 `from..to` 这几条，输出仍是 20 条左右。
   *
   * ── 为什么编号而不是再发一遍待翻译 ──
   * 全片本身就用「条号 → 原文」的对象给出，模型能直接看到这一条在整片里的位置；
   * 输出也要求同样的编号，错位/漏条一眼可见（与重试用的 indexed 格式同源）。
   *
   * @param {string[]} lines 全片原文（按顺序，下标 0 对应条号 1）
   * @param {string} targetLang
   * @param {number} from 起始条号（1 起）
   * @param {number} to 结束条号（含）
   * @param {{title?: string, brief?: string}} [context]
   */
  function buildWholeMessages(lines, targetLang, from, to, context = {}) {
    const all = Array.isArray(lines) ? lines.map((line) => String(line ?? '')) : [];
    const start = Math.max(1, Number(from) || 1);
    const end = Math.min(all.length, Number(to) || start);
    const count = Math.max(0, end - start + 1);

    const target = targetLabel(targetLang);
    const title = typeof context.title === 'string' ? context.title.trim() : '';
    const brief = typeof context.brief === 'string' ? context.brief.trim().slice(0, BRIEF_RESPONSE_CHARS) : '';

    const numbered = {};
    all.forEach((line, index) => { numbered[String(index + 1)] = line; });

    const system = [
      `你是一位精通日语与中文的资深字幕译者，把日语字幕译成${target}。`,
      `输入是整片字幕（JSON 对象，键是条号，按时间顺序）。本次只需要翻译第 ${start} 到 ${end} 条，`
        + `共 ${count} 条 —— 其余条目只作语境参考。`,
      '硬性要求：',
      `1. 输出一个 JSON 对象，键恰好是 "${start}" 到 "${end}" 这 ${count} 个条号`,
      '   （键是字符串、连续、一个都不能少，也不能多）；值是这一条的译文。',
      '   不要输出其它条号、不要输出数组、不要解释或代码块。',
      ...COMMON_RULES,
    ];

    if (brief) {
      system.push('');
      system.push('【全片语境（由整片字幕整理，术语按这里的译法）】');
      system.push(brief);
    }

    const parts = [];
    if (title) parts.push(`视频标题：${title}`);
    parts.push(`【全片字幕｜键是条号，只翻译第 ${start}-${end} 条】`);
    parts.push(JSON.stringify(numbered));
    parts.push(`【本次要翻译的条号】${start}-${end}（共 ${count} 条，输出这些条号的 JSON 对象）`);

    return [
      { role: 'system', content: system.join('\n') },
      { role: 'user', content: parts.join('\n') },
    ];
  }

  /**
   * 全片语境预处理的 messages。
   *
   * 目的：翻译是按段发的，模型看不到整片；而「丸ハラ」这类缩写的正确译法只能从整片
   * 的话题、说话人、反复出现的词里推出来。所以先花一次请求把整片读一遍，
   * 产出一份**很短的**语境摘要，之后每一段都带上它 —— 用输入换准确率。
   *
   * 输出不是 JSON：这里要的是自然语言摘要，强行套格式反而会让模型去编结构化字段。
   *
   * @param {string[]} lines 全片原文（按顺序，超长会被截断）
   * @param {string} targetLang
   */
  function buildBriefMessages(lines, targetLang) {
    const target = targetLabel(targetLang);
    const list = cleanLines(lines);
    const picked = headLines(list, BRIEF_MAX_CHARS);

    const system = [
      `你在为字幕翻译做前置分析。用户给你一部日语播客/视频的字幕（可能只截取了前面一部分，`,
      `也可能有识别错误）。请输出一份给译者看的${target}语境摘要，供后续逐段翻译使用。`,
      '按下面四项，用短句写，总长不超过 300 字：',
      '1. 主题与节目类型（如闲聊 / 访谈 / 讲解）。',
      '2. 说话人与相互称呼、他们的关系。',
      '3. 反复出现的专有名词、日本流行语、缩写、行业黑话 —— 逐条给「原文=建议译法」，',
      '   没有通用译法时给意译；不要音译成没有意义的汉字词（例如「丸ハラ=句号骚扰」）。',
      '4. 整体语气（随意 / 正式 / 吐槽密度等）。',
      '只输出摘要正文，不要标题、不要 JSON、不要解释你在做什么。',
    ].join('\n');

    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `【全片字幕｜按时间顺序】\n${JSON.stringify(picked)}`,
      },
    ];
  }

  /** 去掉 ```json ... ``` 围栏（模型最常见的一种「听话但多此一举」） */
  function stripFence(raw) {
    const value = String(raw ?? '').trim();
    const fenced = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(value);
    return fenced ? fenced[1].trim() : value;
  }

  /** 数组元素有时是对象（`{ text: "..." }` / `{ translation: "..." }`） */
  function itemText(item) {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return null;
    for (const key of ['text', 'translation', 'target', '译文']) {
      if (typeof item[key] === 'string') return item[key].trim();
    }
    return null;
  }

  /** 校验一组候选译文：条数必须相等，元素必须是可读文本 */
  function toLines(parsed, count) {
    if (!Array.isArray(parsed)) return { ok: false, reason: '返回的不是 JSON 数组' };
    if (parsed.length !== count) {
      return { ok: false, reason: `条数不符（期望 ${count}，实际 ${parsed.length}）` };
    }

    const lines = [];
    for (const item of parsed) {
      const line = itemText(item);
      if (line === null) return { ok: false, reason: '数组里有无法识别的元素' };
      lines.push(line);
    }
    return { ok: true, lines };
  }

  /**
   * `{ "1": "…", "2": "…" }` 这种带序号的返回 → 按序号排好的字符串数组。
   *
   * 序号必须是**连续整数**（起点不固定：整片模式可能只返回 `41..60`），
   * 否则顺序不可信；条数也必须正好等于本批期望值。
   */
  function fromNumberedObject(parsed, count) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const keys = Object.keys(parsed);
    if (keys.length !== count) return null;
    if (!keys.every((key) => /^\d+$/.test(key))) return null;

    const numbers = keys.map(Number).sort((a, b) => a - b);
    for (let i = 1; i < numbers.length; i += 1) {
      if (numbers[i] !== numbers[i - 1] + 1) return null;
    }

    const ordered = [];
    for (const number of numbers) {
      const value = parsed[String(number)];
      if (typeof value !== 'string') return null;
      ordered.push(value);
    }
    return ordered;
  }

  /**
   * 逐行兜底：有些模型不看 JSON 指令，老老实实一行一条。
   *
   * 只在**行数恰好相等**时接受，并剥掉常见编号前缀（`1.` / `1、` / `-` / `•`）。
   * 行数不等仍然判失败 —— 少一条就会整批错位，这条底线不能松。
   */
  function fromLines(raw, count) {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+\s*[.、)）])\s*/, '').trim())
      .filter(Boolean);

    if (lines.length !== count) return null;
    // 还带着 JSON 残骸（被截断的数组 / 对象 / 带引号的元素）就不算逐行结果
    if (lines.some((line) => /^[[\]{}]/.test(line) || /^".*",?$/.test(line))) return null;
    return lines;
  }

  /**
   * 解析模型返回。
   *
   * 容忍（按尝试顺序）：代码围栏、数组前后夹解释文字、元素是对象、带序号的 JSON 对象、
   * 一行一条的纯文本。
   * 不容忍：**条数不等**（会让整批错位）—— 只回 `{ ok: false, reason }`，
   * 由调用方决定重试 / 拆半，还是跳过并报失败。
   *
   * @param {string} content
   * @param {number} expected 本批期望条数
   * @returns {{ok: true, lines: string[]} | {ok: false, reason: string}}
   */
  function parseTranslationContent(content, expected) {
    const count = Number(expected);
    if (!Number.isFinite(count) || count <= 0) {
      return { ok: false, reason: '期望条数不合法' };
    }

    const raw = stripFence(content);
    if (!raw) return { ok: false, reason: '返回内容为空' };

    // 1) JSON 数组（可能夹在解释文字之间）
    let value = raw;
    if (!value.startsWith('[')) {
      const start = value.indexOf('[');
      const end = value.lastIndexOf(']');
      if (start >= 0 && end > start) value = value.slice(start, end + 1);
    }
    // 记下数组这一次的具体原因（条数不符 / 被截断），兜底都失败时报这个比笼统的一句更有用
    let bestReason = '';
    if (value.startsWith('[')) {
      try {
        const result = toLines(JSON.parse(value), count);
        if (result.ok) return result;
        bestReason = result.reason;
      } catch {
        bestReason = '返回的不是合法 JSON（可能被截断）';
      }
    }

    // 2) 带序号的 JSON 对象
    const objectStart = raw.indexOf('{');
    const objectEnd = raw.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
      try {
        const asObject = fromNumberedObject(
          JSON.parse(raw.slice(objectStart, objectEnd + 1)),
          count,
        );
        if (asObject) return { ok: true, lines: asObject };
      } catch {
        // 忽略，继续兜底
      }
    }

    // 3) 一行一条（模型没按 JSON 输出时的兜底）
    const asLines = fromLines(raw, count);
    if (asLines) return { ok: true, lines: asLines };

    return { ok: false, reason: bestReason || '返回的不是等长的 JSON 数组（可能没按格式输出）' };
  }

  const api = {
    PROVIDERS,
    TARGETS,
    DEFAULT_CONFIG,
    MAX_ITEMS,
    MAX_CHARS,
    CONTEXT_BEFORE_CHARS,
    CONTEXT_AFTER_CHARS,
    BRIEF_MAX_CHARS,
    BRIEF_RESPONSE_CHARS,
    WHOLE_MAX_CHARS,
    normalizeConfig,
    chatUrl,
    planBatches,
    buildMessages,
    buildBriefMessages,
    buildWholeMessages,
    parseTranslationContent,
  };

  Object.defineProperty(globalThis, NS, { value: api, configurable: true });
})();
