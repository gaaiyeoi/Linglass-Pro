/**
 * 日语「文节」切分（纯函数）
 *
 * 只做一件事：给一句日文，算出该在哪些字符位置断开。供 15-ja-break.js 在
 * Linglass 的原文字幕行上画分隔符，不做任何 DOM 操作 —— 这样它能被 Node 侧的
 * 测试直接驱动。除插入分隔符外，一个字符都不改写、不删减、不纠正，也不加空格。
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
 *      （shouldAttach 里的 lastKind / pieces / sawAux / head）。
 *
 * ── 需求里的 10 条规则，分别由哪段代码负责 ──
 *   1  每个文节末尾一个分隔符、不改写原文 → cut() 只返回下标，渲染侧照原样
 *                                            插入（15-ja-break.js / 30-desktop-subtitles.js）
 *   2  名词 / 代词 / 数词 + 其后助词不分家 → CASE / LOOSE 表 + shouldAttach 的助词分支
 *   3  动词 + 助动词 / 否定 / 时态 / 补助动词 → LOOSE 表 + sawAux（谓语链不回切）
 *   4  形容词 / 形容动词 + 活用 → 同上（汉字词干后面吸假名尾巴那一条）
 *   5  连体修饰语与被修饰名词之间切开 → 汉字片段一律另起一节
 *   6  副词 / 接续词 / 感叹词单独成节 → STANDALONE（显式点名，不靠副作用）
 *   7  固定语法保持整体 → 形式名词在 STANDALONE，`では / じゃ` 在 LOOSE
 *   8  复合名词 / 数词＋量词 / 外来语复合词不拆 → 数词＋量词、片假名连写、
 *                                                 汉字复合词三条判据（见下）
 *   9  标点原样保留；`。！？` 后成节；逗号只跟着上一节 → FORCE_STOP / SOFT_STOP
 *   10 不在单词 / 助词 / 活用内部切 → 上述各条的另一面
 *
 * ── 三条「合并」判据的由来（规则 8）──
 *   · 数词 + 量词：ICU 会把「三冊」「5時に」「2026年」切成两段，而数词后面跟的
 *     助数词/时间单位属于同一个文节，所以显式合并。表外的量词（`1 棟` 的 棟）
 *     不合并 —— 宁可少合并，也不猜。
 *   · 片假名连写：`コンピューター + ゲーム` 是复合外来语词，连起来。代价是相邻的
 *     两个独立外来语词（`アメリカ カナダ` 这种并列）也会被连成一节。
 *   · 汉字复合词 / 接尾辞：`日本語 + 学校`、`東京 + 都`、`外国 + 人`。这一条**只对
 *     单个纯汉字词**生效，并且用 NOUN_BREAK（昨日 / 今日 / 最近 / 私 / 本当…）
 *     挡住「时间名词 + 普通名词」的误合并（`昨日|学校へ|` 不能变成 `昨日学校へ|`）。
 *
 * ── 已知的能力边界（不打算修，成本远大于收益）──
 *   · 复合名词 / 专有名词能否被连起来，最终取决于 ICU 词典与上面那三张表：
 *     「AI 技術」这类可能仍被切成两段，表外的量词也不会合并。
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
  /** 全是汉字 */
  const KANJI_ONLY = /^[\u3005\u3007\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/;
  /** 整段都是假名（含长音符 ー）：活用词尾的形态 */
  const KANA_ONLY = /^[\u3041-\u309f\u30a0-\u30ff\u30fc\uff66-\uff9f]+$/;
  /** 整段都是片假名：外来语复合词靠它判断能不能连写 */
  const KATAKANA_ONLY = /^[\u30a0-\u30ff\u30fc\uff66-\uff9f]+$/;
  /** 数词：阿拉伯 / 全角 / 汉字数字 */
  const NUMERAL = /^[0-9０-９一二三四五六七八九十百千万億兆]+$/;

  /**
   * 疑问数词。**不放进 NUMERAL**：`何` 单用时要能接 `か`（何か），
   * 所以它只在「后面紧跟量词」时才当数词用（何人 / 何回も）。
   */
  const INTERROGATIVE = new Set(['何', '幾']);

  /** 开引号 / 开括号：自成新文节的开头，紧随其后的词并进来 */
  const OPENERS = new Set([
    '「', '『', '（', '(', '【', '〔', '〈', '《', '［', '[', '｛', '{', '“', '‘',
  ]);

  /** 句末标点：出现后一律另起文节（规则 9） */
  const FORCE_STOP = new Set([
    '。', '．', '.', '！', '!', '？', '?', '…', '‥', '；', ';', '：', ':',
  ]);

  /**
   * 顿号 / 逗号：照旧黏在上一节尾巴上（所以分隔符落在逗号之后），
   * 但**不额外制造断点** —— 切点由文节本身决定（规则 9）。
   */
  const SOFT_STOP = new Set(['、', '，', ',']);

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
   *
   * 「では」「じゃ」是断定 / 否定的复合形式（静かではありません、わけではない）：
   * 收进来之后它们才会黏回前面的名词或形式名词（规则 4 / 7）。
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
    'では', 'じゃ',
    // 补助动词
    'いる', 'いた', 'います', 'ある', 'あった', 'くださる', 'ください', 'もらう',
    'あげる', 'くれる', 'しまう', 'しまっ', 'ちゃう', 'じゃう', 'おく', 'みる',
    'くる', 'きた', 'いく', 'いっ', 'ほしい', 'ござい', 'いたす', 'いたし',
    // ICU 切碎的词尾
    'する', 'した', 'すれ', 'して', 'い', 'くだ', 'さい',
  ]);

  /**
   * 纯假名的自立词 —— 出现时一律另起一节（规则 6 / 7）。
   *
   * 这些词的末尾常常恰好是助词（とても 的 も、あの 的 の、こと 的 と），
   * 光看末字会把它们自己骗过去；而且要挡住它们把后一个假名词黏上来
   * （ゆっくり + きく 不能连成一节）。所以必须显式点名，不能靠副作用。
   *
   * ⚠️ 这里**不许**收助词 / 助动词：shouldAttach 先查这张表再查 CASE / LOOSE，
   * 收错了会让助词失去「黏回前词」的能力。
   */
  const STANDALONE = new Set([
    // 指示词 / 代名词
    'これ', 'それ', 'あれ', 'どれ', 'ここ', 'そこ', 'どこ', 'この', 'その', 'あの', 'どの',
    'どこか', 'なにか', 'だれか', 'いつか', 'どれか',
    // 形式名词
    'こと', 'もの', 'とき', 'ため', 'ほか', 'ほう', 'うち', 'わけ', 'はず', 'まま', 'ひと',
    // 高频副词 / 应答词 / 感叹词
    'また', 'まだ', 'もう', 'すぐ', 'はい', 'ええ', 'うん', 'さあ', 'ほら', 'ねえ',
    'ああ', 'おお', 'わあ', 'あっ', 'えっ', 'いいえ', 'なるほど', 'たしかに', 'ぜひ',
    'ゆっくり', 'しっかり', 'はっきり', 'のんびり', 'きちんと', 'ちゃんと', 'いっしょ',
    'だんだん', 'どんどん', 'だいたい', 'たいてい', 'ちょっと', 'すこし', 'すこしずつ',
    'かなり', 'けっこう', 'ずっと', 'もっと', 'きっと', 'たぶん', 'やっぱり', 'やはり',
    'いつも', 'ときどき', 'ぜんぜん', 'あまり', 'ほとんど', 'そろそろ', 'しばらく',
    'まず', 'つぎに', 'きゅうに', 'さっそく', 'すでに', 'たちまち', 'かならず',
    // 接续词
    'そして', 'しかし', 'だから', 'それから', 'それで', 'それに', 'ところで', 'つまり',
    'たとえば', 'ちなみに', 'なお', 'または', 'すなわち',
  ]);

  /**
   * 格助词后跟单字助词时，允许回黏的那几个真助词（规则 2 / 10）。
   * 只有单字格助词在里面 —— には / にも / のに / での / との / への 是一个文节。
   * 其余单字形态（か / た）多半是新词的首字：花を + かいました、ここで + たべられます。
   */
  const AFTER_CASE_OK = new Set(['は', 'も', 'に', 'へ', 'と', 'で', 'の', 'が', 'を', 'や']);

  /**
   * 小写假名（っ / ゃ / ゅ / ょ / ぁ…）。日语里没有以它开头的词，
   * 所以以它开头的片段一定是上一节的活用尾。
   *
   * 这一条专治「美しかった」：ICU 切成 美 / しか / っ / た，而 `しか` 同时在
   * CASE 表里（副助词），于是这一节看起来「格助词 + 假名」像是新词开头 ——
   * 但后面跟着的 `っ` 说明它其实是形容词的词尾（美し + かっ + た）。
   */
  const SMALL_KANA = new Set(['っ', 'ゃ', 'ゅ', 'ょ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ゎ', 'ゕ', 'ゖ']);

  /**
   * 助数词 / 时间单位 / 跟在量词后面的附属字（规则 8：数词 + 量词不拆）。
   * 最后那批（後 / 前 / 間 / 目 / 半…）本身不是量词，但它们只会跟在一个量词后面
   * 组成同一个文节（3年後 / 2時間半 / 3度目），所以一并收在这里。
   * 这些字只有在**数词打头的链**里才会被查（见 counterRun），不会单独吸词。
   */
  const COUNTER_HEADS = new Set([
    '人', '名', '位', '冊', '枚', '台', '個', '本', '匹', '頭', '羽', '件', '円', '歳', '才',
    '回', '度', '番', '階', '杯', '泊', '点', '組', '足', '着', '軒', '袋', '箱', '錠', '粒',
    '時', '分', '秒', '年', '月', '日', '週', '割', '倍', '歩', '坪', '升', '合', '曲',
    '折', '膳', '束', '滴', '層', '隻', '通', '発', '戸', '面', '駅', '区',
    'ヶ', 'ヵ', 'ケ', 'カ', 'か', 'つ', '万', '億', '兆',
    '後', '前', '間', '来', '以', '目', '半', '程', '頃',
  ]);

  /** 量词后面允许跟的尾巴（助词，以及 3年後に / 2時間半 这类附加成分的后半） */
  const COUNTER_TAIL = new Set([
    'に', 'を', 'が', 'で', 'と', 'は', 'も', 'の', 'へ', 'や', 'か', 'ら', 'ま', 'よ', 'ね',
    '半', '間', '前', '後', '以', '来', '目', 'ごろ', 'おき', 'ごと', 'ずつ', 'ぶり',
  ]);

  /**
   * 汉字复合词 / 接尾辞的尾部（规则 8）。只在「当前节是单个纯汉字词」时才查它，
   * 所以像「昨日 + 学校」这种误合并要靠 NOUN_BREAK 挡。
   */
  const COMPOUND_TAIL = new Set([
    '学校', '小学校', '中学校', '高校', '大学', '大学院', '会社', '銀行', '病院', '駅',
    '館', '園', '場', '所', '室', '部', '課', '会', '式', '祭', '料', '費', '金', '税',
    '学', '校', '院', '科', '店', '社', '者', '員', '家', '屋', '長', '語', '都', '道',
    '府', '県', '市', '区', '町', '村', '生', '人', '間', '中', '外', '前', '後', '上',
    '下', '内', '側', '向', '組', '連', '団', '隊', '軍', '派', '史', '書', '紙', '画',
    '曲', '劇', '的', '化', '性', '度', '制', '法', '風', '産', '製', '品', '物', '用', '型',
  ]);

  /**
   * 不许被 COMPOUND_TAIL 吸走的自立名词：时间名词、代词、常见的「独立成节」的词。
   * 这条表不给全，只挡真实字幕里最容易撞上的那批（规则 8 的反面守卫）。
   */
  const NOUN_BREAK = new Set([
    '昨日', '今日', '明日', '明後日', '今朝', '今晩', '毎日', '毎朝', '毎週', '毎月', '毎年',
    '今年', '去年', '来年', '今週', '先週', '来週', '今月', '先月', '来月', '最近', '昔', '今',
    '本当', '一番', '全部', '普通', '大変', '時々', '私', '僕', '俺', '彼', '彼女', '何', '誰',
  ]);

  /**
   * 接尾辞里允许**前缀匹配**的那几个字（会 + 社員 → 会社員、国際 + 会議）。
   * 这里只放「基本不单独成词」的构词字；上 / 生 / 人 / 家 / 屋 这些本身就常作独立词，
   * 放进来的话「日本語 + 上手」会被连成「日本語上手」，所以它们只走整词匹配。
   */
  const COMPOUND_PREFIX = new Set([
    '学', '校', '院', '科', '部', '課', '会', '式', '祭', '語', '都', '道', '府', '県', '市',
    '区', '町', '村', '社', '員', '館', '園', '場', '所', '室', '店', '費', '税', '産', '製',
    '的', '化', '性', '度', '型', '組', '連', '団', '隊', '派', '史', '紙', '画', '曲', '劇', '金',
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

  /**
   * 这一片段是不是「量词形态」：首字是助数词，其余部分是助词尾巴或另一个量词字。
   * 分かる / 人が 这种要分开：かる 里的 る 不在尾巴表里，所以不会被合并进来。
   */
  function isCounterPiece(piece) {
    if (!COUNTER_HEADS.has(piece[0])) return false;
    for (const ch of piece.slice(1)) {
      if (!COUNTER_TAIL.has(ch) && !COUNTER_HEADS.has(ch)) return false;
    }
    return true;
  }

  /**
   * 这一片段能不能当接尾辞跟前面的汉字词合并（规则 8）。
   * 整词命中（学校 / 駅 / 的）或「以构词字开头」（社員 / 会議）都算。
   */
  function isCompoundTail(piece) {
    if (COMPOUND_TAIL.has(piece)) return true;
    return piece.length > 1 && COMPOUND_PREFIX.has(piece[0]);
  }

  function newSection(piece, start, end, kind) {
    return {
      start,
      end,
      pieces: 1,
      head: piece[0],
      first: piece,
      lastKind: kind ?? kindOf(piece),
      hardStop: false,
      softStop: false,
      /** 黏过助动词 / 活用尾：说明这一节是个「还在长的谓语」 */
      sawAux: false,
      /** 数词打头、后面全是量词 / 量词附属字的链（三冊・5時に・2026年・3年後） */
      counterRun: NUMERAL.test(piece),
      pureKanji: KANJI_ONLY.test(piece),
      pureKatakana: KATAKANA_ONLY.test(piece),
    };
  }

  /** 把片段并进当前文节，并同步维护上面那些标记 */
  function attach(cur, piece, end) {
    const kind = kindOf(piece);
    cur.end = end;
    cur.pieces += 1;
    cur.lastKind = kind;
    if (kind === 'loose') cur.sawAux = true;
    cur.counterRun = cur.counterRun && (NUMERAL.test(piece) || isCounterPiece(piece));
    cur.pureKanji = cur.pureKanji && KANJI_ONLY.test(piece);
    cur.pureKatakana = cur.pureKatakana && KATAKANA_ONLY.test(piece);
  }

  /**
   * 这一段该并进当前文节，还是另起一节。
   *
   * @param {{pieces: number, head: string, first: string, lastKind: string,
   *          hardStop: boolean, softStop: boolean, sawAux: boolean, counterRun: boolean,
   *          pureKanji: boolean, pureKatakana: boolean}} cur
   */
  function shouldAttach(cur, piece) {
    // 上一节只有开引号（「 + 本）
    if (cur.lastKind === 'opener') return true;
    // 点名的自立假名词（副词 / 接续词 / 形式名词 / 指示词），一律另起一节
    if (STANDALONE.has(piece)) return false;
    // 逗号之后：分隔符已经落在逗号后面了，不再把后一个词往回黏（规则 9）
    if (cur.softStop) return false;

    // 疑问数词 + 量词：何人 / 何回も（何 单用时不走这条，好让它接 か）
    if (cur.pieces === 1 && INTERROGATIVE.has(cur.first) && isCounterPiece(piece)) return true;
    // 规则 8：数词 + 量词 / 时间单位（三冊・5時に・2026年に・3ヶ月・10月3日・3年後）
    // 「か」既作量词首字（1か月）也作终助词，所以真正的助词要留给下面几条判据
    if (cur.counterRun && !CASE.has(piece) && !LOOSE.has(piece)
      && (NUMERAL.test(piece) || isCounterPiece(piece))) return true;
    // 规则 8：片假名连写的外来语复合词（コンピューター + ゲーム）
    if (cur.pureKatakana && KATAKANA_ONLY.test(piece)) return true;
    // 规则 8：汉字复合词 / 接尾辞（日本語 + 学校、東京 + 都、外国 + 人、会 + 社員）
    if (cur.pieces === 1 && cur.pureKanji
      && !NOUN_BREAK.has(cur.first) && isCompoundTail(piece)) return true;

    // 数词链（三冊 / 2時間半 / 100万円）之后：只收助词与助动词。
    // 零散的单字假名（か かった、た）是后面那个动词的开头，不能吸进来。
    if (cur.counterRun && cur.lastKind === 'word') {
      if (CASE.has(piece)) return true;
      return LOOSE.has(piece) && piece.length > 1;
    }

    if (CASE.has(piece) || LOOSE.has(piece)) {
      // 格助词后面跟一个**单字**助词：只有单字格助词才算真助词（学校には / 読むのに），
      // 其余多半是新词的首字（花を + か、ここで + た）。
      // 两个字的形态（した / くだ / さい）几乎只作词尾，不会被这条拦住。
      if (cur.lastKind === 'case' && piece.length === 1) return AFTER_CASE_OK.has(piece);
      return true;
    }

    if (!KANA_ONLY.test(piece)) return false;
    // 小写假名开头：一定是上一节（多半是形容词词干）的活用尾，回黏
    if (SMALL_KANA.has(piece[0])) return true;
    if (cur.lastKind === 'case') {
      // 谓语链内部的副助词之后（見せ + て + も），假名尾巴要回黏
      if (cur.sawAux) return true;
      // 其余情况只在「这一节还只有一个片段」时收
      // （わたしは 断在 が 上之后，く 要能黏回那一个片段的 が）
      return cur.pieces < 2;
    }
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
          cur.hardStop = FORCE_STOP.has(piece);
          cur.softStop = SOFT_STOP.has(piece);
          cur.pureNumeral = false;
          cur.pureKanji = false;
          cur.pureKatakana = false;
        }
        continue;
      }

      if (cur.hardStop) {
        sections.push(newSection(piece, start, end));
        continue;
      }

      if (shouldAttach(cur, piece)) {
        attach(cur, piece, end);
      } else {
        sections.push(newSection(piece, start, end));
      }
    }

    if (sections.length < 2) return [];
    return sections.map((section) => section.end);
  }

  Object.defineProperty(globalThis, NS, { value: { cut }, configurable: true });
})();
