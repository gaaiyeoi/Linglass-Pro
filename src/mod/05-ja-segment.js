/**
 * 日语「文节」切分（纯函数）
 *
 * 只做一件事：给一句日文，算出该在哪些字符位置断开。供 15-ja-break.js 在
 * Linglass 的原文字幕行上画分隔符，不做任何 DOM 操作 —— 这样它能被 Node 侧的
 * 冒烟测试直接驱动。
 *
 * ── 为什么是 Intl.Segmenter 而不是带词典的分词器（kuromoji 之类）──
 * 后者要拖着十几 MB 的字典文件，对内容脚本来说完全不成比例。Intl.Segmenter 是
 * 浏览器内建、基于 ICU 词典的分词，日语支持在 Chromium 与 Node 上都可用。
 *
 * ── 它给的是「词」，而文节要的是「自立词 + 附属词」──
 * ICU 的切法有两个特点，决定了下面这套判据：
 *
 *   1. 助词、助动词、补助动词是封闭类，可以老老实实列表。但它们粘上去之后，
 *      对后面片段的影响并不一样，所以分成两类：
 *        CASE  —— 格助词、提示助词、副助词、并列助词。「花を + かいました」里
 *                 那个「か」是新词的首字，所以 CASE 之后必须格外警惕。
 *        LOOSE —— 终助词、接续助词、助动词、补助动词。「ました + か」
 *                 「おわ + わ + って」这些都要继续黏。
 *
 *   2. 活用形会被切成「词干 + 假名碎片」，而且切法不固定：
 *          借りました   → 借り / ま / した
 *          食べられます → 食 / べら / れ / ます
 *          行かなかった → 行 / か / なか / っ / た
 *          読んでいる   → 読 / んで / いる
 *      碎片不可能穷举，所以判据不看碎片本身，而看**当前文节已经长成什么样**
 *      （shouldAttach 里的 lastKind / pieces / head）。
 *
 * 结果：'私は昨日図書館で日本語の本を借りました。' →
 *     私は|昨日|図書館で|日本語の|本を|借りました。|
 * 与规则里的「昨日買った本を読む → 昨日|買った|本を|読む」一致。
 *
 * ── 已知的能力边界（不打算修，成本远大于收益）──
 *   · 复合名词、专有名词能否被 ICU 当成一个词，取决于它的词典；「AI 技術」这类
 *     可能被切成两段，于是多出一刀。
 *   · ICU 偶尔会把一个词切得莫名其妙（例如「がくせい」→ が / く / せい），
 *     这时只能靠「开头的助词后面允许黏回」勉强拼对。真实字幕里这类词多写汉字。
 *   · 补助动词一律黏回前一节，「家にいる」会连成一个文节而不是「家に|いる」。
 *   · 逐句独立切分，看不到前后句的上下文。
 *   · 判不准时一律偏向「另起一节」：宁可多切一刀，也不把两个自立词黏死。
 */
(() => {
  'use strict';

  const NS = '__llgModJaSegment';
  if (globalThis[NS]) return;

  /** 含假名才当日语处理：中文 / 英文行原样放过，不插分隔符 */
  const KANA = /[\u3041-\u309f\u30a0-\u30ff\uff66-\uff9f]/;
  /** 汉字（含々〆〇与扩展 A 区） */
  const KANJI = /[\u3005\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  /** 整段都是假名（含长音符 ー）：活用词尾的形态 */
  const KANA_ONLY = /^[\u3041-\u309f\u30a0-\u30ff\u30fc\uff66-\uff9f]+$/;

  /** 开引号 / 开括号：自成新文节的开头，紧随其后的词并进来 */
  const OPENERS = new Set([
    '「', '『', '（', '(', '【', '〔', '〈', '《', '［', '[', '｛', '{', '“', '‘',
  ]);

  /** 句读点：出现后一律另起文节，紧跟其后的助词也不再往回黏 */
  const HARD_STOP = new Set([
    '。', '．', '.', '！', '!', '？', '?', '…', '‥', '；', ';', '、', '，', ',', '：', ':',
  ]);

  /**
   * 格助词 / 提示助词 / 副助词 / 并列助词 —— 「后面要另起成分」的那一类。
   * 其中「から」「と」「で」「が」同时也作接续助词，这里按格助词算。
   */
  const CASE = new Set([
    'が', 'を', 'に', 'へ', 'と', 'で', 'の', 'は', 'も', 'や', 'こそ', 'しか', 'だけ',
    'ばかり', 'まで', 'ほど', 'くらい', 'ぐらい', 'など', 'なんか', 'なんて', 'きり',
    'のみ', 'さえ', 'とか', 'やら', 'だの', 'なり', 'から', 'より', 'とも', 'たり', 'だり',
  ]);

  /**
   * 终助词 / 接续助词 / 助动词 / 补助动词 —— 「后面还能接着黏」的那一类。
   *
   * 末尾那一批是 ICU 在全假名句里单独吐出来的碎片（ください → くだ / さい，
   * あめでした → あめ / で / した，行かなかった → 行 / か / なか / っ / た），
   * 字面形态没法与自立词区分，只能收在这里。
   */
  const LOOSE = new Set([
    // 终助词
    'か', 'ね', 'よ', 'な', 'わ', 'ぞ', 'ぜ', 'さ', 'かな', 'かしら',
    // 接续助词
    'て', 'ながら', 'つつ', 'ので', 'のに', 'けれど', 'けど', 'けれども', 'し',
    'ても', 'でも', 'ば', 'なら', 'たら', 'ものの',
    // 助动词
    'だ', 'です', 'でし', 'だっ', 'ます', 'まし', 'ませ', 'ました', 'ません', 'でした',
    'た', 'ない', 'なかっ', 'なく', 'なけれ', 'ぬ', 'ん', 'う', 'ず', 'つ',
    'よう', 'そう', 'らしい', 'べき', 'まい', 'みたい', 'たい', 'たく', 'たかっ',
    'れる', 'られる', 'せる', 'させる', 'える', 'れば',
    // 补助动词
    'いる', 'いた', 'います', 'ある', 'あった', 'くださる', 'ください', 'もらう',
    'あげる', 'くれる', 'しまう', 'しまっ', 'ちゃう', 'じゃう', 'おく', 'みる',
    'くる', 'きた', 'いく', 'いっ', 'ほしい', 'ござい', 'いたす', 'いたし',
    // ICU 切碎的词尾
    'する', 'した', 'すれ', 'して', 'い', 'くだ', 'さい',
  ]);

  /**
   * 纯假名的自立词 —— 出现时一律另起一节。
   *
   * 这些词的末尾常常恰好是助词（とても 的 も、あの 的 の、こと 的 と），
   * 光看末字会把它们自己骗过去，必须显式点名。
   */
  const STANDALONE = new Set([
    // 指示词 / 代名词
    'これ', 'それ', 'あれ', 'どれ', 'ここ', 'そこ', 'どこ', 'この', 'その', 'あの', 'どの',
    // 形式名词
    'こと', 'もの', 'とき', 'ため', 'ほか', 'ほう', 'うち', 'わけ', 'はず', 'まま', 'ひと',
    // 高频副词 / 应答词
    'また', 'まだ', 'もう', 'すぐ', 'はい', 'ええ', 'うん', 'さあ', 'ほら', 'ねえ',
  ]);

  let segmenter;

  /** Intl.Segmenter 不可用（极老的运行时）时退化为「不切」 */
  function getSegmenter() {
    if (segmenter === undefined) {
      segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('ja', { granularity: 'word' })
        : null;
    }
    return segmenter;
  }

  /** 片段归类：决定它能不能吸住下一个片段 */
  function kindOf(piece) {
    // 开引号可能被 ICU 当成「词」，所以这里也要认一遍，别让它把「和「本」分开
    if (OPENERS.has(piece)) return 'opener';
    if (CASE.has(piece)) return 'case';
    if (LOOSE.has(piece)) return 'loose';
    if (STANDALONE.has(piece)) return 'standalone';
    return 'word';
  }

  function newSection(piece, start, end, kind) {
    return {
      start,
      end,
      pieces: 1,
      head: piece[0],
      lastKind: kind ?? kindOf(piece),
      hardStop: false,
    };
  }

  /**
   * 这一段该并进当前文节，还是另起一节。
   *
   * @param {{pieces: number, head: string, lastKind: string, hardStop: boolean}} cur
   */
  function shouldAttach(cur, piece) {
    // 上一节只有开引号（「 + 本）
    if (cur.lastKind === 'opener') return true;
    // 点名的自立假名词，一律另起一节
    if (STANDALONE.has(piece)) return false;

    if (CASE.has(piece) || LOOSE.has(piece)) {
      // 格助词后面跟一个**单字**助词，多半是新词的首字而非助词：
      // 花を + か（かいました）、ここで + た（たべられます）。
      // 两个字的形态（した / くだ / さい）几乎只作词尾，不会被这条拦住。
      return !(cur.lastKind === 'case' && piece.length === 1);
    }

    if (!KANA_ONLY.test(piece)) return false;
    // 格助词后的假名：只有当前节还只有一个片段时才收
    // （わたしは 断在 が 上之后，く 要能黏回那一个片段的 が）
    if (cur.lastKind === 'case') return cur.pieces < 2;
    // 终助词 / 接续助词 / 助动词之后可以继续黏（いました + か）
    if (cur.lastKind === 'loose') return true;
    // 句读点后、自立假名词后：另起一节
    if (cur.lastKind === 'punct' || cur.lastKind === 'standalone') return false;
    // 词干后面：汉字词干的活用词尾（借りました / 行かなかった），或 2 字以内的碎片
    return KANJI.test(cur.head) || piece.length <= 2;
  }

  /**
   * 把一句日文切成文节，返回每节结束处的字符下标（升序，末节也在内）。
   *
   * 整句只有一节时返回空数组 —— 没有内部停顿，就不该画分隔符。
   *
   * 例：'私は昨日図書館で日本語の本を借りました。'
   *   → [2, 4, 8, 12, 14, 20]
   *   → 私は|昨日|図書館で|日本語の|本を|借りました。|
   */
  function cut(text) {
    if (!text || !KANA.test(text)) return [];
    const tokenizer = getSegmenter();
    if (!tokenizer) return [];

    /** @type {ReturnType<typeof newSection>[]} */
    const sections = [];

    for (const part of tokenizer.segment(text)) {
      const start = part.index;
      const end = start + part.segment.length;
      const piece = part.segment;
      const cur = sections.length ? sections[sections.length - 1] : null;

      if (!cur) {
        sections.push(newSection(piece, start, end));
        continue;
      }

      if (!part.isWordLike) {
        if (OPENERS.has(piece)) {
          sections.push(newSection(piece, start, end, 'opener'));
        } else {
          // 标点（含闭引号、顿号）黏在上一节尾巴上
          cur.end = end;
          cur.pieces += 1;
          cur.lastKind = 'punct';
          cur.hardStop = HARD_STOP.has(piece);
        }
        continue;
      }

      if (cur.hardStop) {
        sections.push(newSection(piece, start, end));
        continue;
      }

      if (shouldAttach(cur, piece)) {
        cur.end = end;
        cur.pieces += 1;
        cur.lastKind = kindOf(piece);
      } else {
        sections.push(newSection(piece, start, end));
      }
    }

    if (sections.length < 2) return [];
    return sections.map((section) => section.end);
  }

  Object.defineProperty(globalThis, NS, { value: { cut }, configurable: true });
})();
