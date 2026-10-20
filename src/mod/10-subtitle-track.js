/**
 * Linglass 字幕轨道记录器
 *
 * 把 Linglass 渲染出来的每一句双语字幕，连同它在视频里的时间点记录下来，
 * 形成一条可复用的「字幕轨道」。桌面字幕浮窗的歌词式进度、侧边学习面板、
 * 导出中日对照 Markdown，都建立在这条轨道上。
 *
 * 只「读」Linglass 的 Shadow DOM，不修改它：
 *   #linglass-subtitle-overlay  →  .subtitle-group  →  .subtitle.subtitle-primary / -secondary
 *
 * 关于时间精度：Linglass 不对外暴露它内部的 cue 时间轴，所以这里用
 * 「监听 DOM 变化 + 采样 video.currentTime」自建轨道。行级时间戳的精度取决于
 * MutationObserver 的触发时刻（实际就是字幕切换那一瞬），够用；但拿不到逐词
 * 时间戳，词级进度只能用「句内线性插值」近似——这点无法绕过。
 *
 * 光靠采样只能得到「播放过的句子」。所以还读一份**骨架**：官方自己已经把整条
 * 原文轨（学习语言）落进了 chrome.storage.local（见下方「官方整条轨」一节），
 * 拿它当时间轴底座，采样只负责往里填译文。这样面板一打开就是整条轨，而不是
 * 攒到哪儿显示到哪儿。
 *
 * 对外接口挂在 globalThis.__llgModTrack 上。同一扩展的所有内容脚本共享同一个
 * isolated world，所以各脚本直接用这个全局量互相取用即可，不需要消息传递。
 */
(() => {
  'use strict';

  const NS = '__llgModTrack';
  if (globalThis[NS]) return;

  const HOST_ID = 'linglass-subtitle-overlay';
  const STORE_PREFIX = 'llgTrack:';

  /** Node.TEXT_NODE。内容脚本里直接写 3，省一层全局查找 */
  const TEXT_NODE = 3;

  /** 轨道采样的心跳间隔（正常由 MutationObserver 驱动，心跳只作兜底） */
  const HEARTBEAT_MS = 1000;
  /**
   * 心跳注册：优先挂到 00-shared.js 的**共享**定时器上（PLAN 025 —— 五个模块
   * 各挂一个 1s 定时器是纯浪费，现在整个扩展只有一个）。
   *
   * 留 `setInterval` 兜底是因为本文件是「字幕轨道」这块公用的底座：被别人单独
   * 拿走/裁剪时（shared 不存在）它仍然要能自己跑起来。
   */
  const everySecond = (fn) => {
    const shared = globalThis.__llgModShared;
    if (shared && typeof shared.onTick === 'function') shared.onTick(fn);
    else setInterval(fn, HEARTBEAT_MS);
  };
  /** 落盘去抖：字幕可能一秒变好几条，不必每条都写 storage */
  const SAVE_DEBOUNCE_MS = 800;
  /** 拿不到观察到的结束时间时，给一句的默认时长 */
  const DEFAULT_CUE_SECONDS = 6;
  /** 估计时长的下限，避免极短句把进度分母压成 0 */
  const MIN_CUE_SECONDS = 1;
  /**
   * 两次采样之间超过这么久，判定为「用户拖了进度条」。
   *
   * 正常采样由 MutationObserver（逐词高亮会频繁触发）+ 1s 心跳驱动，间隔通常远小于 1s；
   * 留到 2.5s 是给「漏掉一拍」留余量（页面被节流、主线程卡顿都不会超过这个量级），
   * 而拖进度条至少是几秒起。跨过去的那一段不是这句在播，所以跳转后的位置不能当句末。
   */
  const JUMP_SECONDS = 2.5;
  /**
   * 一句的时长上限。一条字幕极少超过 20 秒，超出几乎只可能来自拖进度条 ——
   * 这种样本混进「一句大概多久」的中位数里，会让**所有**活跃句的进度分母偏大
   * （表现就是进度条走不满、总比字幕慢半拍），所以估计时直接剔除。
   */
  const MAX_CUE_SECONDS = 20;
  /** 重看同一段时判定「同一句」的时间容差 */
  const DEDUPE_WINDOW_SECONDS = 2.5;

  /**
   * 单个视频最多保留多少句（PLAN 025）。
   *
   * 没有这个上限时，挂着看几小时直播会让 `cues` 与学习面板的 `<li>` 一起线性长下去
   * （用户报的「内存越用越多」）。5000 句 ≈ 十小时直播（按每句 7 秒算），
   * 超出后丢**最旧**的：正在播的位置与导出要看的都是最近的句子，而 `indexAt()`
   * 的二分查找在丢弃前缀之后依然成立。
   */
  const MAX_CUES = 5000;

  /** 落盘上限：最多留多少个视频的轨道 */
  const MAX_STORED_TRACKS = 30;
  /** 落盘 TTL：轨道超过这个年龄就删（30 天） */
  const TRACK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  /**
   * 我们自己的轨道索引键。
   *
   * 为什么需要它：`llgTrack:<videoId>` 是「按视频一个键」的写法，要给它做上限/TTL
   * 就必须知道有哪些键、各自什么时候写的 —— 而 `chrome.storage.local.getKeys()`
   * 只有 Chrome 130+ 有，老版本只能 `get(null)` 把整份 storage（几 MB）搬进内存，
   * 那正是我们想避免的事。所以自己记一份小索引（30 条上下）。
   */
  const INDEX_KEY = 'llgTrackIndex';

  // ---------------------------------------------------------------- 官方整条轨（骨架）
  //
  // 实测官方产物（vendor/linglass-1.12.3/assets/index.ts-CtsHbKHl.js 的 Qa()）：
  // 官方一次就把整条轨取全了，并把原文轨落进 chrome.storage.local：
  //
  //   key    subtitle-cache:v6:{videoId}:{primaryLang}:{secondaryLang}
  //   索引   subtitle-cache:index → { entries: [{ key, cachedAt }] }（最多 50 条，TTL 24h）
  //   值     { cues, rawCues, mergePlan, isAsr, parts, cachedAt, videoId, primaryLang,
  //            secondaryLang }，其中 cues[i] = { start, end, text, rawText, id }（秒）
  //
  // 其中 `{lang}:primary` 那条是**原文（学习语言）的整条轨**，正是面板要的骨架。
  // 母语（译文）那一侧**不进 storage**（MT 是按块懒翻译、只缓存已经翻过的块），
  // 所以译文仍然只能在实际播放时采下来 —— 这是方案的边界，不是实现偷懒。
  //
  // 只读，绝不写/删官方这批 key。

  const SKELETON_PREFIX = 'subtitle-cache:v6:';
  const SKELETON_INDEX_KEY = 'subtitle-cache:index';
  /** 原文档位的后缀 */
  const SKELETON_SLOT = ':primary';
  /**
   * 每个视频最多试几次列索引。
   *
   * 由心跳（1s 一次）驱动，所以这个数约等于「等官方写缓存的时间窗口」= 60 秒。
   * 为什么不用时间窗口 / 时间节流：逐词高亮会频繁驱动 capture()，按「次数」计数时
   * 必须保证尝试由心跳驱动而不是 capture 驱动（见 heartbeat 与 capture 的调用点）；
   * 而时间节流会让 Node 侧的冒烟测试无法确定性推进（真实 Date.now 走得比测试慢）。
   */
  const SKELETON_MAX_TRIES = 60;
  /** 直播句找不到对应骨架句时的匹配容差（秒） */
  const SKELETON_TOLERANCE_SECONDS = 1.8;
  /** 连续这么多句都匹配不上，就认为骨架选错了（另一种学习语言），换下一个候选 */
  const SKELETON_MISMATCH_LIMIT = 6;
  /** 骨架最多换几次（防抖动：视频被重新剪过时也会「匹配不上」，不能一直换） */
  const SKELETON_MAX_SWITCHES = 1;
  /**
   * 导入译文时按 start 找轨道句的容差（秒）。
   *
   * 计划里的 start 就是从这条轨道导出去的（05-srt.js 的 planImport 取的 `cues[best].start`），
   * 所以正常情况下是**同一个数**，这里只是给浮点往返留一点余量。刻意取小：
   * 临近两句的 start 可能只差 1 秒出头，容差放大会把译文贴到隔壁句上。
   */
  const IMPORT_START_TOLERANCE = 0.05;

  const listeners = new Set();

  let cues = [];
  let meta = null;
  /**
   * 整条轨道是不是用户用文件替换来的（PLAN 052）。
   *
   * 为真时**不许骨架再覆盖/补句**：用户已经按句重新断过，官方那套滚动断句只会把结果弄乱。
   * 换视频时按落盘里的 `meta.import.wholeTrack` 还原，所以刷新后依然生效。
   */
  let manualTrack = false;
  /** 当前正在显示的那一句（不一定在数组末尾——用户会往回拖进度条） */
  let active = null;
  /**
   * 最近一次 readLines() 的结果。
   *
   * 只有 capture()（MutationObserver + 心跳驱动）会写它，getProgress() 每帧
   * 只读它 —— 见 onTimeline() 的注释（PLAN 025 的根因第 1 条）。
   */
  let lastLines = null;
  let boundHost = null;
  let observer = null;
  let videoRef = null;
  let lastKey = null;
  let lastTickTime = null;
  let saveTimer = 0;
  let loading = false;

  /** 骨架句：end 与 start 都来自官方，不该被采样重写 */
  let officialCues = new WeakSet();
  /** 骨架文本 → 骨架句，用来把采样到的译文贴回正确的那一句 */
  const officialByText = new Map();
  /** 连续匹配不上的直播句数（见 SKELETON_MISMATCH_LIMIT） */
  let liveMisses = 0;
  /**
   * 导入的译文与当前原文轨对不上？（PLAN 031 第 4 条）
   *
   * `null` = 这个视频没导入过（或还没算），面板据此决定要不要提示。
   * 不落盘：它是「当前这份轨道 vs 导入时那份」的比对结果，换了轨道就得重算。
   */
  let importMismatch = null;

  /** 骨架的加载状态机（每个视频一份） */
  const skeleton = {
    videoId: null,
    /** 候选 key，按 cachedAt 降序 */
    keys: null,
    /** 下一个要试的候选下标 */
    next: 0,
    /** 列索引失败/为空的次数 */
    tries: 0,
    /** 试完了（成功采用或确实没有） */
    done: false,
    /** 正在读（防并发重入） */
    loading: false,
    /**
     * 读的过程中又收到「官方刚写好缓存」的事件。
     *
     * 不接住的话：事件被 loading 挡掉，而当前这次读完又可能把 done 置真，
     * 于是刚写好的整条轨照样被永久放弃（PLAN 049）。
     */
    pending: false,
    /** 已采用的那份 key */
    adopted: null,
    /** 已经换过几次候选 */
    switches: 0,
  };

  function warn(msg) {
    console.warn(`[llg-track] ${msg}`);
  }

  function currentVideo() {
    if (videoRef && videoRef.isConnected) return videoRef;
    videoRef = document.querySelector('#movie_player video') || document.querySelector('video');
    return videoRef;
  }

  /** 当前播放位置（秒）。拿不到视频元素时返回 null，由调用方降级。 */
  function currentTime() {
    const video = currentVideo();
    return video && Number.isFinite(video.currentTime) ? video.currentTime : null;
  }

  /**
   * 取一行的纯文本（**不含振假名**）。
   *
   * 为什么不能直接读 textContent：官方的日语振假名是 `<ruby>夜<rt>よる</rt></ruby>`，
   * textContent 会把注音拼在汉字后面 ——「夜」+「よる」=「夜よる」，于是浮窗、面板列表、
   * 导出的 Markdown / SRT 里全长出这种"重复标记"。
   *
   * 官方自己取纯文本时是先 clone 再删掉所有 rt（vendor/linglass-1.12.3/assets/
   * promoCards-*.js 的 Tn()），15-ja-break.js 的 textOf() 也是同一口径（它的插入位置
   * 要对齐官方的字符偏移）。三处**口径**（结果）必须一致 —— 否则「译文贴回骨架句」的
   * 文本匹配会因为一边带注音、一边不带而莫名失败；但实现不必都是 clone（见下）。
   */
  function plainText(el) {
    // 走 subtreeText() 而不是 cloneNode(true) + 删 rt（PLAN 025）：注音行在日语学习场景里
    // 是常态，而 clone 每读一次就造一棵等大的 DOM 树交给 GC —— 这是「看久了越来越卡」
    // 里最不值当的一份开销。subtreeText() 就是同一件事的不建节点版本（跳过 RT、
    // 其余文本节点按顺序拼起来），两者结果逐字符相同。
    if (el.querySelector('rt')) return subtreeText(el, null);
    return el.textContent || '';
  }

  function readLines() {
    const host = document.getElementById(HOST_ID);
    const root = host && host.shadowRoot;
    if (!root) return null;

    const group = root.querySelector('.subtitle-group');
    if (!group || group.style.display === 'none') return { primary: '', secondary: '' };

    const line = (sel) => {
      const el = root.querySelector(sel);
      if (!el || el.style.display === 'none') return '';
      return plainText(el).replace(/\s+/g, ' ').trim();
    };

    return {
      primary: line('.subtitle.subtitle-primary'),
      secondary: line('.subtitle.subtitle-secondary'),
    };
  }

  /**
   * 取一棵子树里的文本。
   *
   * `only === 'RT'` → 只要 rt 里的（注音）；`only` 为空 → 排除 rt（与 plainText() 同口径）。
   * 官方自己做的事也是这两件（`Tn()` 删掉 rt，`ruby()` 把注音放进 rt）。
   */
  function subtreeText(node, only) {
    let text = '';
    for (const child of node.childNodes || []) {
      if (child.nodeType === TEXT_NODE) {
        if (!only) text += child.data || '';
        continue;
      }
      if (child.nodeName === 'RT') {
        if (only === 'RT') text += child.textContent || '';
        continue;
      }
      text += subtreeText(child, only);
    }
    return text;
  }

  /**
   * 把一行拆成片段：普通文本一段，`<ruby>夜<rt>よる</rt></ruby>` 收成「夜 + 注音よる」一段。
   * 与 plainText() 同一口径 —— 所有片段的 text 拼起来就是剥掉 rt 的纯文本。
   */
  function collectTokens(node, out) {
    for (const child of node.childNodes || []) {
      if (child.nodeType === TEXT_NODE) {
        if (child.data) out.push({ text: child.data, ruby: '' });
        continue;
      }
      if (child.nodeName === 'RT') continue;
      if (child.nodeName === 'RUBY') {
        const text = subtreeText(child, null);
        if (text) out.push({ text, ruby: subtreeText(child, 'RT') });
        continue;
      }
      collectTokens(child, out);
    }
  }

  /**
   * 当前原文行的「带注音结构」（**只给浮窗用**），不改变任何既有口径。
   *
   * 为什么要单独开一个接口：readLines() 给的是**剥掉 rt 的纯文本**（浮窗原文行、面板
   * 逐句列表、导出的 Markdown / SRT 都用它）—— 那是 PLAN 010 定下的口径，不能动。
   * 而浮窗想要「和官方这行长一个样」，就需要 rt。所以这里额外提供一份结构；官方这行
   * 没有 rt 时返回 null，调用方走原来的纯文本路径，行为一个字不变。
   *
   * 返回 null 的三种情况：
   *   · 没有字幕，或字幕整体隐藏；
   *   · 官方这行没有 rt（`readingMode` 关着，或这门语言没有注音）—— 跟随官方；
   *   · 片段拼出来的原文与归一化后的纯文本不一致（行里有额外空白 / 换行）：
   *     这时不敢把字符往某个注音上对，宁可退回纯文本。
   */
  function readPrimaryRich() {
    const host = document.getElementById(HOST_ID);
    const root = host && host.shadowRoot;
    if (!root) return null;

    const group = root.querySelector('.subtitle-group');
    if (!group || group.style.display === 'none') return null;

    const el = root.querySelector('.subtitle.subtitle-primary');
    if (!el || el.style.display === 'none') return null;
    if (!el.querySelector('rt')) return null;

    const tokens = [];
    collectTokens(el, tokens);
    const raw = tokens.map((token) => token.text).join('');
    const text = normalizeText(raw);
    if (!text || raw !== text) return null;
    return { text, tokens };
  }

  function readMeta() {
    const url = new URL(location.href);
    const id = url.searchParams.get('v') || '';

    const pick = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const text = el && el.textContent ? el.textContent.trim() : '';
        if (text) return text;
      }
      return '';
    };

    const video = currentVideo();
    return {
      id,
      title: pick([
        'ytd-watch-metadata #title h1',
        'h1.ytd-watch-metadata',
        'h1.style-scope.ytd-watch-metadata',
      ]) || document.title.replace(/\s*-\s*YouTube\s*$/, '').trim(),
      channel: pick(['ytd-watch-metadata #owner #channel-name a', '#owner #channel-name a']),
      url: id ? `https://www.youtube.com/watch?v=${id}` : location.href,
      duration: video && Number.isFinite(video.duration) ? video.duration : null,
    };
  }

  // ---------------------------------------------------------------- 骨架的读入与合并

  /** 归一化文本：骨架与直播句比对时忽略空白差异 */
  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 列 storage 里的所有 key。
   *
   * 只在「官方索引没给出这个视频的骨架」时走这条路：实测（本机 chrome.storage.local，
   * 2026-10-16）官方索引里只有 13 条，而 storage 里躺着 20 多条 `subtitle-cache:v6:*` 的
   * **值** —— 索引有条数上限与 TTL，被挤掉的是索引条目，值还在。只要拿到 key 就能读值，
   * 所以索引里没有不该成为放弃的理由。
   *
   * `getKeys()` 是 Chrome 130+ 的 API，只回 key、不搬值，代价最小；老版本退回 `get(null)`
   * （把整份 storage 搬进内存，几 MB —— 所以调用方要限次，见 listSkeletonKeys）。
   */
  async function listStoredKeys() {
    const local = chrome.storage.local;
    if (typeof local.getKeys === 'function') {
      return (await local.getKeys()) || [];
    }
    const all = await local.get(null);
    return all ? Object.keys(all) : [];
  }

  /**
   * 列出这个视频的原文档位候选，按 cachedAt 降序（最新的那份最可能是当前用的）。
   *
   * 先读官方索引：便宜，而且带 cachedAt（能排序、能挑最新那一份）。索引里没有本视频的条目
   * 就退化为枚举 storage 的 key（见 listStoredKeys）—— 这条路拿不到 cachedAt，就保持 storage
   * 给的顺序，让 maybeLoadSkeleton 逐个试（选错了靠 liveMisses 的失配检测换下一份）。
   *
   * `tries` 是已经试过的次数，用来限制枚举的频率：枚举比读索引贵（`get(null)` 时尤其），
   * 而官方写缓存是秒级的事，所以前 5 次每秒翻一遍、之后每 10 秒一遍就够
   * （最多 11 次，不会变成「每次心跳把 storage 全搬一遍」）。
   */
  async function listSkeletonKeys(videoId, tries = 1) {
    if (!videoId) return [];
    const prefix = `${SKELETON_PREFIX}${videoId}:`;
    const isCandidate = (key) => typeof key === 'string'
      && key.startsWith(prefix)
      && key.endsWith(SKELETON_SLOT);

    const stored = await chrome.storage.local.get(SKELETON_INDEX_KEY);
    const index = stored && stored[SKELETON_INDEX_KEY];
    const entries = index && Array.isArray(index.entries) ? index.entries : [];
    const indexed = entries
      .filter((entry) => entry && isCandidate(entry.key))
      .sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0))
      .map((entry) => entry.key);
    if (indexed.length) return indexed;

    if (tries > 5 && tries % 10 !== 0) return [];
    return (await listStoredKeys()).filter(isCandidate);
  }

  /** 官方 cue → 轨道 cue：只取原文与时间，译文等采样来填 */
  function fromSkeleton(rawCues) {
    const list = [];
    for (const raw of rawCues || []) {
      const text = normalizeText(raw && raw.text);
      const start = Number(raw && raw.start);
      if (!text || !Number.isFinite(start)) continue;
      const end = Number(raw && raw.end);
      list.push({
        start,
        end: Number.isFinite(end) && end > start ? end : null,
        primary: text,
        secondary: '',
      });
    }
    list.sort((a, b) => a.start - b.start);
    return list;
  }

  /**
   * 把骨架并进当前轨道。
   *
   * 骨架句是权威的（start/end/原文都来自官方），采样到的直播句按**文本**贴回对应的
   * 骨架句去填译文；文本匹配不上的（官方会重新断句/合并，视频也可能被重新剪过）
   * 退化为时间匹配；两者都不中的直播句才新建，保证「画面上有、轨道里也有」。
   */
  function adoptSkeleton(skeletonCues) {
    const merged = skeletonCues.map((cue) => ({ ...cue }));
    officialByText.clear();
    for (const cue of merged) {
      const key = normalizeText(cue.primary);
      if (key && !officialByText.has(key)) officialByText.set(key, cue);
      officialCues.add(cue);
    }

    const extras = [];
    for (const live of cues) {
      const match = officialByText.get(normalizeText(live.primary));
      if (match) {
        // 骨架句是新建的、secondary 恒为空，所以这里必然搬得动；`origin` 一起搬，
        // 否则导入的译文（PLAN 031）刷新一次就降级成「采样来的译文」，会被后续采样覆盖
        if (!match.secondary && live.secondary) {
          match.secondary = live.secondary;
          if (live.origin) match.origin = live.origin;
        }
        // 采样到的那句会继续被 extendActive 更新，指针要一起挪到骨架句上
        if (live === active) active = match;
        continue;
      }
      extras.push(live);
    }

    cues = merged.concat(extras).sort((a, b) => a.start - b.start);
    liveMisses = 0;
    // 官方整条轨本身也可能有几千句（长视频 / 直播），同样受上限约束
    enforceCueLimit();
    invalidateEstimate();
  }

  /**
   * 句数上限（PLAN 025）：超出就丢**最旧**的那几句。
   *
   * 除了 `cues`，还要把被丢掉的句子从 `officialByText`（Map）里摘干净 ——
   * Map 会一直拽着对象不放，不清就等于上限白设了（那正是「内存只涨不降」的一半）。
   * `officialCues` 是 WeakSet，本来就不阻止回收，但一起清掉更省心。
   */
  function enforceCueLimit() {
    if (cues.length <= MAX_CUES) return;

    const gone = new Set(cues.splice(0, cues.length - MAX_CUES));
    if (active && gone.has(active)) active = null;
    for (const cue of gone) {
      officialCues.delete(cue);
      const key = normalizeText(cue.primary);
      if (officialByText.get(key) === cue) officialByText.delete(key);
    }
    invalidateEstimate();
  }

  /** 当前轨道里有多少句来自骨架（用来判断新骨架是不是更短） */
  function adoptedCount() {
    let count = 0;
    for (const cue of cues) {
      if (officialCues.has(cue)) count += 1;
    }
    return count;
  }

  /** 丢掉上一份骨架带来的状态（换骨架、清空轨道时用） */
  function resetSkeletonAdoption() {
    officialCues = new WeakSet();
    officialByText.clear();
    liveMisses = 0;
  }

  /** 骨架里找这一句：先按文本，再按时间 */
  function matchOfficial(primary, start) {
    const key = normalizeText(primary);
    if (key) {
      const byText = officialByText.get(key);
      if (byText) return byText;
    }

    let best = null;
    for (const cue of cues) {
      if (!officialCues.has(cue)) continue;
      if (cue.start > start + SKELETON_TOLERANCE_SECONDS) break;
      const end = cue.end != null ? cue.end : cue.start + DEFAULT_CUE_SECONDS;
      if (end + SKELETON_TOLERANCE_SECONDS < start) continue;
      if (!best || Math.abs(cue.start - start) < Math.abs(best.start - start)) best = cue;
    }
    return best;
  }

  /** 骨架选错了（缓存里有另一种学习语言的轨）→ 换下一个候选；整轨重来，不留下别国文字 */
  function retrySkeleton() {
    if (skeleton.switches >= SKELETON_MAX_SWITCHES) return;
    if (!skeleton.keys || skeleton.next >= skeleton.keys.length) return;

    skeleton.switches += 1;
    skeleton.adopted = null;
    skeleton.done = false;

    cues = [];
    active = null;
    lastKey = null;
    resetSkeletonAdoption();
    invalidateEstimate();
    notify();

    maybeLoadSkeleton().catch(() => {});
  }

  /**
   * 读骨架（幂等、限次）。
   *
   * 为什么不能无条件轮询：Linglass 可能在我们之后才写缓存，所以允许重试几次；
   * 但每帧/每秒读 storage 是浪费，所以 tries 用尽就彻底放弃，退回旧行为。
   */
  async function maybeLoadSkeleton() {
    const videoId = meta && meta.id;
    if (!videoId || skeleton.loading || skeleton.done) return;
    // 整条轨来自用户文件：官方骨架不许再插手（PLAN 052）
    if (manualTrack) return;

    if (skeleton.videoId !== videoId) {
      skeleton.videoId = videoId;
      skeleton.keys = null;
      skeleton.next = 0;
      skeleton.tries = 0;
      skeleton.done = false;
      skeleton.adopted = null;
      skeleton.switches = 0;
      skeleton.pending = false;
    }

    skeleton.loading = true;
    try {
      if (!skeleton.keys) {
        skeleton.tries += 1;
        const keys = await listSkeletonKeys(videoId, skeleton.tries);
        if (!keys.length) {
          // ⚠️ 空结果**不能**落账（PLAN 014 的根因）：[] 是 truthy，写进 skeleton.keys 之后
          // 下一次调用就会以为「索引已经列过了」而跳过重列，直接 done —— 从此永远读不到骨架，
          // 面板就只剩「播放过的句子」。官方写缓存晚于我们打开面板是常态（索引里还留着
          // 别的视频的条目、只是还没有当前 videoId 的），这里只累加次数，等下一次心跳再试。
          if (skeleton.tries >= SKELETON_MAX_TRIES) skeleton.done = true;
          return;
        }
        skeleton.keys = keys;
      }

      while (skeleton.next < skeleton.keys.length) {
        const key = skeleton.keys[skeleton.next];
        skeleton.next += 1;

        const stored = await chrome.storage.local.get(key);
        const list = fromSkeleton(stored && stored[key] && stored[key].cues);
        if (!list.length) continue;
        // 已采用的整条轨只许变长：官方可能重写缓存（cachedAt 更新）或留下更短的重切产物，
        // 采用更短的会把「全文」缩回去（PLAN 049）。
        if (skeleton.adopted && list.length < adoptedCount()) continue;

        if (skeleton.adopted) resetSkeletonAdoption();
        adoptSkeleton(list);
        skeleton.adopted = key;
        skeleton.done = true;
        // 骨架到位了，原文轨才是完整的那条 → 此刻比对「导入时的指纹」才有意义
        refreshImportMismatch();

        notify();
        scheduleSave();
        return;
      }

      // 候选都读完了但内容为空：当作没有骨架
      skeleton.done = true;
    } catch (err) {
      skeleton.done = true;
      warn(`读官方字幕缓存失败（退回只记录播放过的句子）：${err && err.message}`);
    } finally {
      skeleton.loading = false;
      // 读的过程中官方又写了缓存：补一次，别让这一轮把 done 定死
      if (skeleton.pending) {
        skeleton.pending = false;
        skeleton.done = false;
        skeleton.keys = null;
        skeleton.next = 0;
        maybeLoadSkeleton().catch(() => {});
      }
    }
  }

  /**
   * 官方写完整条轨时会往 `chrome.storage.local` 写 `subtitle-cache:v6:…:primary`。
   *
   * 为什么必须事件驱动：这条缓存可能在我们开始播放**几分钟后**才写进来（本机实测
   * 一条 21 分钟的视频，页面打开约 100 秒后才出现）。而旧实现只有 60 次心跳的轮询窗口，
   * 窗口一过就永久放弃 —— 面板与导出于是一直只有「播放过的句子」（PLAN 049 的根因）。
   *
   * 只认当前视频的原文档位：其它视频的写入、`:yt-reseg` / `:zh` 那些槽位都不能触发重来。
   */
  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local') return;
    if (manualTrack) return;
    const videoId = meta && meta.id;
    if (!videoId || !changes) return;

    const prefix = `${SKELETON_PREFIX}${videoId}:`;
    const arrived = Object.keys(changes).some((key) => {
      const change = changes[key];
      return key.startsWith(prefix)
        && key.endsWith(SKELETON_SLOT)
        && change
        && change.newValue;
    });
    if (!arrived) return;

    skeleton.done = false;
    if (skeleton.loading) {
      skeleton.pending = true;
      return;
    }
    skeleton.keys = null;
    skeleton.next = 0;
    skeleton.tries = 0;
    maybeLoadSkeleton().catch(() => {});
  }

  // ---------------------------------------------------------------- 轨道写入

  /** 按 start 升序插入，保证二分查找和导出顺序都成立 */
  function insertCue(cue) {
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= cue.start) lo = mid + 1;
      else hi = mid;
    }
    cues.splice(lo, 0, cue);
    enforceCueLimit();
    invalidateEstimate();
  }

  /** 重看同一段视频时，同一句话会再次出现，别重复收录 */
  function findDuplicate(primary, start) {
    for (let i = cues.length - 1; i >= 0; i -= 1) {
      const cue = cues[i];
      if (cue.start < start - DEDUPE_WINDOW_SECONDS) break;
      if (Math.abs(cue.start - start) <= DEDUPE_WINDOW_SECONDS && cue.primary === primary) {
        return cue;
      }
    }
    return null;
  }

  function closeActive() {
    if (!active) return;
    // 骨架句的 end 是官方给的，比「采样到哪一刻」准，不要覆盖
    if (!officialCues.has(active)) {
      const t = currentTime();
      if (t != null) active.end = t;
      if (active.end == null || active.end < active.start) active.end = active.start;
    }
    active = null;
    // 这一句的时长从此定稿，进了估计时长的样本集合
    invalidateEstimate();
    scheduleSave();
  }

  /**
   * 当前句还在显示时，让它的 end 跟着播放前进。
   *
   * 采样间隔分三档，别把它们混成一句「还在播」：
   *   · 几乎没动（< 0.05s）→ 暂停，保持不动（否则 end 会被无限拉长，进度条倒退）
   *   · 正常前进（≤ JUMP_SECONDS）→ 推进 end，这是 SRT 导出要的「显示到哪一刻」
   *   · 跨了一大步（> JUMP_SECONDS）→ 用户拖了进度条。**只更新采样点，不推进 end**：
   *     中间那一段不是这句在播，写进去就会变成一条超长的「时长样本」，
   *     把 estimatedSeconds() 的中位数抬高，进而让所有进度分母偏大。
   */
  function extendActive() {
    if (!active) return;
    const t = currentTime();
    if (t == null) return;

    if (lastTickTime != null) {
      const delta = t - lastTickTime;
      if (delta < 0.05) return;
      if (delta > JUMP_SECONDS) {
        lastTickTime = t;
        return;
      }
    }

    lastTickTime = t;
    // 骨架句的时间由官方给定，采样只更新「我们现在播到哪」，不动它的 end
    if (!officialCues.has(active)) {
      active.end = t;
      scheduleSave();
    }
  }

  function openCue(lines) {
    const t = currentTime();
    const fallbackStart = cues.length ? cues[cues.length - 1].end ?? 0 : 0;
    const start = t != null ? t : fallbackStart + 0.001;

    // 有骨架时：这一句是「往骨架句里填译文」，而不是新建一句
    if (officialByText.size) {
      const match = matchOfficial(lines.primary, start);
      if (match) {
        // 导入的译文优先于采样来的译文（PLAN 031）：用户自己翻的那份更可信
        if (lines.secondary && !match.secondary && match.origin !== 'imported') {
          match.secondary = lines.secondary;
        }
        active = match;
        liveMisses = 0;
        return;
      }
      liveMisses += 1;
      if (liveMisses >= SKELETON_MISMATCH_LIMIT) retrySkeleton();
    }

    const existing = findDuplicate(lines.primary, start);
    if (existing) {
      // 同上：导入的译文不许被采样覆盖
      if (lines.secondary && existing.origin !== 'imported') existing.secondary = lines.secondary;
      active = existing;
      return;
    }

    const cue = { start, end: null, primary: lines.primary, secondary: lines.secondary };
    insertCue(cue);
    active = cue;
    scheduleSave();
  }

  /**
   * 采样一次字幕状态。字幕空档期不建句，只收尾。
   * 每次「换了新的一句」都通知订阅者 —— 桌面字幕靠它做到零延迟跟读，
   * 不必等下一个心跳。
   *
   * 顺便把读到的这一份留给 getProgress() 用（见 onTimeline）：字幕 DOM 一有变化
   * 这个函数就跑（MutationObserver），没变化时心跳每秒兜一次，所以那份缓存最多
   * 陈旧 1 秒，而「换行那一刻」是零延迟的。
   */
  function capture() {
    const lines = readLines();
    lastLines = lines;
    const t = currentTime();
    const key = lines ? `${lines.primary}\u0000${lines.secondary}` : '';

    if (key === lastKey) {
      extendActive();
      return;
    }
    lastKey = key;

    closeActive();
    // 骨架的重试不挂在这里：逐词高亮会让 capture 一秒触发好几次，次数会被刷爆
    // （见 heartbeat 的调用点）
    if (lines && (lines.primary || lines.secondary)) openCue(lines);
    notify();
  }

  // ---------------------------------------------------------------- 观察器

  function bindObserver() {
    const host = document.getElementById(HOST_ID);
    if (!host) return false;
    if (host === boundHost && observer) return true;

    observer?.disconnect();
    observer = null;
    boundHost = host;

    const root = host.shadowRoot;
    if (!root) return false;

    observer = new MutationObserver(capture);
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    capture();
    return true;
  }

  function heartbeat() {
    const video = currentVideo();
    if (video !== videoRef) {
      videoRef = video;
      lastTickTime = null;
    }
    bindObserver();
    capture();
    // 骨架重试挂在心跳上：1s 一次、最多 SKELETON_MAX_TRIES 次（≈1 分钟）。
    // 官方写缓存晚于我们打开面板是常态，所以必须留出这个窗口（见 PLAN 014 的第 1 条）。
    maybeLoadSkeleton().catch(() => {});
  }

  // ---------------------------------------------------------------- 持久化

  function storeKey() {
    return meta && meta.id ? STORE_PREFIX + meta.id : null;
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      save().catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }

  /** 读我们自己的轨道索引（读不出来就当空） */
  async function readIndex() {
    const stored = await chrome.storage.local.get(INDEX_KEY);
    const value = stored && stored[INDEX_KEY];
    const entries = value && Array.isArray(value.entries) ? value.entries : [];
    return entries.filter((entry) => entry && typeof entry.key === 'string');
  }

  /**
   * 算出「该留哪些、该删哪些」。
   *
   * 排序把当前这条顶到最前（它的 savedAt 就是 now），所以「上限」永远先淘汰别人 ——
   * 不会出现「正在看的这个视频的轨道被自己挤掉」这种荒唐结果。
   */
  function pruneIndex(entries, currentKey, now) {
    const others = new Map();
    for (const entry of entries) {
      if (entry.key === currentKey) continue;
      // 只认我们自己的键：官方那批 subtitle-cache:* 绝不能碰
      if (!entry.key.startsWith(STORE_PREFIX)) continue;
      if (entry.key === INDEX_KEY) continue;
      const savedAt = Number(entry.savedAt);
      others.set(entry.key, Number.isFinite(savedAt) ? savedAt : 0);
    }

    const ordered = [[currentKey, now], ...[...others].sort((a, b) => b[1] - a[1])];
    const keep = [];
    const drop = [];
    for (const [key, savedAt] of ordered) {
      const fresh = key === currentKey || (now - savedAt) < TRACK_TTL_MS;
      if (fresh && keep.length < MAX_STORED_TRACKS) keep.push({ key, savedAt });
      else drop.push(key);
    }
    return { keep: { entries: keep }, drop };
  }

  /**
   * 落盘轨道 + 维护索引（PLAN 025）。
   *
   * 索引与轨道放在**同一次 `set()`** 里：既少一次写，也让「轨道写了、索引没写」
   * 这种半截状态不可能出现。删除是随后单独一次 `remove()`，失败也只是下次再删。
   */
  async function save() {
    const key = storeKey();
    if (!key) return;
    try {
      const now = Date.now();
      const { keep, drop } = pruneIndex(await readIndex(), key, now);
      await chrome.storage.local.set({
        [key]: { meta, cues, savedAt: now },
        [INDEX_KEY]: keep,
      });
      if (drop.length) await chrome.storage.local.remove(drop);
    } catch (err) {
      // storage 不可用时静默降级：内存里的轨道仍然可用。
      // 但要说一声 —— 配额写满时 set() 正是静默失败的（用户看到的是「进度记不住了」）
      warn(`落盘失败（配额写满？）：${err && err.message}`);
    }
  }

  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    await save().catch(() => {});
  }

  async function loadForCurrentVideo() {
    const next = readMeta();
    if (meta && next.id === meta.id) {
      meta = { ...meta, ...next, title: next.title || meta.title };
      return;
    }

    closeActive();
    await flush();

    meta = next;
    cues = [];
    active = null;
    manualTrack = false;
    lastKey = null;
    lastTickTime = null;
    // 换视频了：上一部片的行不该再参与「画面与时间轴对得上吗」的判断
    lastLines = null;
    resetSkeletonAdoption();
    invalidateEstimate();

    loading = true;
    try {
      const key = storeKey();
      const stored = key ? (await chrome.storage.local.get(key))[key] : null;
      if (stored && Array.isArray(stored.cues) && stored.cues.length) {
        cues = stored.cues;
        meta = { ...next, ...stored.meta, ...next, title: next.title || stored.meta?.title || '' };
        // 这一条轨是用户用文件替换过的：骨架不许再覆盖（刷新后仍然要守住）
        manualTrack = meta.import?.wholeTrack === true;
        // 旧版本（没有上限时）存下来的长轨也要收一收
        enforceCueLimit();
      }
    } catch {
      // 读不出来就当新视频
    } finally {
      loading = false;
    }

    // 我们自己的轨道里已经带着上一轮采用的骨架（译文随句一起落盘），所以这里先比一次；
    // 骨架是首次采用的话，maybeLoadSkeleton() 采用完还会再算一次（见下）
    refreshImportMismatch();
    notify();
    maybeLoadSkeleton().catch(() => {});
  }

  // ---------------------------------------------------------------- 查询

  /** start <= t 的最后一句；cues 恒按 start 升序，可二分 */
  function indexAt(time) {
    const t = time ?? currentTime();
    if (t == null || !cues.length) return -1;

    let lo = 0;
    let hi = cues.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  /**
   * 估计「一句大概持续多久」：取已定稿句子的**时长中位数**。
   *
   * 为什么是中位数而不是平均值：同一视频里相邻句子的时长相关性很高，中位数对个别
   * 超长/超短的句子不敏感。
   *
   * 为什么排除活跃句：活跃句的 end 是「现在播到哪了」（见 extendActive），
   * 拿它当时长样本会得出「这一句的时长 = 已经播了多久」，分母于是又跟着 t 跑。
   *
   * 结果要缓存：这个函数在 getProgress() 的路径上，而浮窗与面板是每帧调一次
   * （60fps × 几千句的排序 = 白烧 CPU）。样本集合只在「建句 / 句子定稿 / 换视频 / 清空」
   * 时变化，所以在那几处失效即可。
   */
  let estimateCache = null;

  function invalidateEstimate() {
    estimateCache = null;
  }

  function estimatedSeconds() {
    if (estimateCache != null) return estimateCache;

    const spans = [];
    for (const cue of cues) {
      if (cue === active) continue;
      if (cue.end == null || cue.end <= cue.start) continue;
      const span = cue.end - cue.start;
      // 拖进度条留下的超长「一句」不是真实语速，别让它把中位数带偏
      if (span > MAX_CUE_SECONDS) continue;
      spans.push(span);
    }

    let value = DEFAULT_CUE_SECONDS;
    if (spans.length) {
      spans.sort((a, b) => a - b);
      const mid = spans.length >> 1;
      const median = spans.length % 2 ? spans[mid] : (spans[mid - 1] + spans[mid]) / 2;
      value = Math.max(MIN_CUE_SECONDS, median);
    }

    estimateCache = value;
    return value;
  }

  /**
   * 进度条的分母 —— 这一句「预计播到哪儿」。
   *
   * ⚠️ 不能用 resolveEnd()。resolveEnd 优先取 cue.end，而活跃句的 cue.end 会被
   * extendActive() 一路推到当前播放位置，于是
   *
   *     进度 = (t - start) / (cue.end - start) = (t - start) / (t - start) = 1
   *
   * 每句开始不到一秒就顶到 100%，这正是「进度是错的」。cue.end 的既有语义
   * （SRT 导出时"这句显示到哪一刻"）保持不变，这里只是换一个口径而已。
   */
  function progressEnd(cue, next) {
    if (next) return next.start;
    // 骨架句的 end 是官方给的权威值，活跃句也一样可用（它不会被 extendActive 改写）
    if (cue.end != null && cue.end > cue.start && (officialCues.has(cue) || cue !== active)) return cue.end;
    return cue.start + estimatedSeconds();
  }

  /** 补出每句的结束时间：优先用观察到的 end，其次用下一句的 start */
  function resolveEnd(cue, next) {
    let end = cue.end;
    if (end == null || end < cue.start) {
      end = next ? next.start : cue.start + DEFAULT_CUE_SECONDS;
    }
    if (next && next.start < end) end = next.start;
    return end;
  }

  function getCurrent() {
    const index = indexAt();
    if (index < 0) return null;
    const cue = cues[index];
    const next = cues[index + 1] ?? null;
    return { ...cue, end: resolveEnd(cue, next), index, next };
  }

  /** 当前句的进度分母（测试与诊断用，语义见 progressEnd） */
  function getProgressEnd() {
    const index = indexAt();
    if (index < 0) return null;
    return progressEnd(cues[index], cues[index + 1] ?? null);
  }

  /**
   * 画面上正在显示的那句，跟时间轴里的这句是同一句吗？
   *
   * 画面没有字幕时（空档、句间那 100ms 的过渡）**不判** —— 那只是切换的瞬间，
   * 不代表时间轴错了，判了会让进度条在正常播放时闪成 0。
   */
  function onTimeline(primary) {
    // ⚠️ 这里**必须**用 capture() 缓存的那一份，不能自己 readLines()（PLAN 025 的根因）：
    // 本函数在 getProgress() 的路径上，而 getProgress() 被两个 rAF 循环每帧调用
    // （浮窗一个、面板一个），于是「面板 + 浮窗同时开着」时同一行文本每秒要被
    // 查询/解析上百次 —— 而且读的还是同一份没变过的 DOM。缓存由 MutationObserver
    // 与 1s 心跳维护，换行那一刻就是新的。
    const lines = lastLines;
    if (!lines || !lines.primary) return true;
    return lines.primary === (primary || '');
  }

  function getProgress() {
    const t = currentTime();
    const index = indexAt(t);
    if (t == null || index < 0) return 0;
    // 画面上的这句跟时间轴里那句不是同一句 → 时间轴落后了（扩展加载晚、
    // 用户拖到了没记录过的区间）。这时候算出来的分母早就过去了，夹一下就是
    // 一个假的 100%：宁可空着也不画。
    if (!onTimeline(cues[index].primary)) return 0;
    const start = cues[index].start;
    const span = progressEnd(cues[index], cues[index + 1] ?? null) - start;
    if (!(span > 0)) return 0;
    return Math.max(0, Math.min(1, (t - start) / span));
  }

  /** 导出用：全部句子，end 已补齐，空句已剔除 */
  function finalizedCues() {
    return cues
      .map((cue, i) => ({ ...cue, end: resolveEnd(cue, cues[i + 1] ?? null) }))
      .filter((cue) => cue.primary || cue.secondary);
  }

  // ---------------------------------------------------------------- 导入译文（PLAN 031）

  /** 按 start 找轨道句（见 IMPORT_START_TOLERANCE 的说明） */
  function cueAtStart(start) {
    if (!Number.isFinite(start)) return null;
    let best = null;
    for (const cue of cues) {
      const value = Number(cue && cue.start);
      if (!Number.isFinite(value)) continue;
      const gap = Math.abs(value - start);
      if (gap > IMPORT_START_TOLERANCE) continue;
      if (!best || gap < Math.abs(best.start - start)) best = cue;
    }
    return best;
  }

  /**
   * 刷新「导入的译文与当前原文轨对不上」这个判断。
   *
   * 没导入过（`meta.import` 缺失）或轨道还空着时恒为 `null` —— 那种情况下
   * 「对不上」没有意义，不该去打扰用户。结果只活在内存里，由 `getMeta()` 暴露给面板。
   */
  function refreshImportMismatch() {
    const stamp = meta && meta.import && meta.import.fingerprint;
    const srt = globalThis.__llgModSrt;
    if (!stamp || !srt || typeof srt.fingerprint !== 'function' || !cues.length) {
      importMismatch = null;
      return;
    }
    importMismatch = !srt.sameFingerprint(stamp, srt.fingerprint(cues));
  }

  /**
   * 导入译文：把 `[{ start, secondary }]` 贴回对应句（PLAN 031）。
   *
   * - 写上 `cue.secondary` 与 `cue.origin = 'imported'`；后者是**优先级标记**，
   *   采样（`openCue` / `findDuplicate`）看到它就绕开，绝不把用户自己翻的覆盖成官方译文或空。
   * - 记住导入那一刻的原文轨指纹（句数 + 首句 + 末句），下次加载时比对 —— 见第 4 条保险。
   * - 落盘走我们自己的键（`llgTrack:<videoId>`），所以刷新后译文还在。
   *
   * 返回 `{ applied, missed, fingerprintMismatch }`：贴不上的要**如实报数**，不许假装全对。
   */
  async function applyTranslations(list) {
    const items = Array.isArray(list) ? list : [];
    let applied = 0;
    let missed = 0;

    for (const item of items) {
      const text = normalizeText(item && item.secondary);
      const cue = text ? cueAtStart(Number(item && item.start)) : null;
      if (!cue) {
        missed += 1;
        continue;
      }
      cue.secondary = text;
      cue.origin = 'imported';
      applied += 1;
    }

    if (applied) {
      const srt = globalThis.__llgModSrt;
      meta = {
        ...(meta || {}),
        import: {
          at: Date.now(),
          fingerprint: srt && typeof srt.fingerprint === 'function' ? srt.fingerprint(cues) : null,
        },
      };
      // 刚记下的指纹就是当前轨道算的，所以这一步必定算出 false
      refreshImportMismatch();
      notify();
      await flush();
    }

    return { applied, missed, fingerprintMismatch: importMismatch === true };
  }

  /**
   * 用一份 SRT 直接替换整条轨道（PLAN 052）。
   *
   * 与 `applyTranslations` 的区别：贴回是「按 start 找已有 cue」，句数与时间轴都以现有轨道为准；
   * 这里是「文件说了算」—— 句数、时间轴、原文/译文全部换成文件里的。
   *
   * 替换后必须把骨架关掉：否则官方整条轨一旦晚到，就会把用户重新断好的句子覆盖回去。
   * 落盘仍走我们自己的 `llgTrack:<videoId>`，官方缓存一个字节不写。
   *
   * @param {Array<{start:number,end:number,primary?:string,secondary?:string}>} list
   * @returns {Promise<{applied:number}>}
   */
  async function replaceCues(list) {
    const items = Array.isArray(list) ? list : [];
    const next = [];

    for (const item of items) {
      const start = Number(item && item.start);
      if (!Number.isFinite(start)) continue;

      const primary = normalizeText(item.primary);
      const secondary = normalizeText(item.secondary);
      if (!primary && !secondary) continue;

      const rawEnd = Number(item.end);
      const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + DEFAULT_CUE_SECONDS;
      next.push({ start, end, primary, secondary, origin: secondary ? 'imported' : 'official' });
    }

    if (!next.length) return { applied: 0 };

    next.sort((a, b) => a.start - b.start);

    closeActive();
    cues = next;
    enforceCueLimit();
    active = null;
    manualTrack = true;
    lastKey = null;
    lastLines = null;
    importMismatch = null;
    resetSkeletonAdoption();
    skeleton.done = true;
    skeleton.adopted = null;
    invalidateEstimate();
    meta = {
      ...(meta || {}),
      import: { at: Date.now(), fingerprint: null, wholeTrack: true },
    };

    notify();
    await flush();
    return { applied: cues.length };
  }

  function snapshot() {
    return { meta: meta ? { ...meta } : null, cues: finalizedCues() };
  }

  async function clear() {
    closeActive();
    cues = [];
    active = null;
    manualTrack = false;
    lastKey = null;
    importMismatch = null;
    resetSkeletonAdoption();
    // 清空之后不要立刻又被骨架填满：这个视频本次不再采用骨架（换视频会重新允许）
    skeleton.done = true;
    skeleton.adopted = null;
    invalidateEstimate();
    const key = storeKey();
    if (key) {
      try {
        await chrome.storage.local.remove(key);
        // 索引里那一条也要摘掉：留着它就等于白占一个上限名额，而且它指向的键已经没了
        const entries = (await readIndex()).filter((entry) => entry.key !== key);
        await chrome.storage.local.set({ [INDEX_KEY]: { entries } });
      } catch {
        // 忽略
      }
    }
    notify();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** 只在结构变化（新增/清空/加载）时通知；end 的推进不影响列表渲染 */
  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (err) {
        warn(`订阅者抛错：${err && err.message}`);
      }
    }
  }

  const api = {
    subscribe,
    getCues: () => cues,
    getCurrent,
    getProgress,
    getProgressEnd,
    getCuesForExport: finalizedCues,
    // importMismatch 是内存里的比对结果（不落盘），面板靠它决定要不要提示
    getMeta: () => (meta ? { ...meta, importMismatch } : null),
    applyTranslations,
    replaceCues,
    getVideoTime: currentTime,
    readLines,
    readPrimaryRich,
    snapshot,
    clear,
    flush,
    reload: loadForCurrentVideo,
  };

  Object.defineProperty(globalThis, NS, { value: api, configurable: true });

  // ---------------------------------------------------------------- 启动

  // 官方写完整条轨的时刻不可预测（可能晚于我们 60 秒的轮询窗口），
  // 所以必须靠 storage 事件，而不是继续加长轮询（PLAN 049）。
  if (chrome.storage && chrome.storage.onChanged
    && typeof chrome.storage.onChanged.addListener === 'function') {
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  document.addEventListener('yt-navigate-finish', () => {
    loadForCurrentVideo().catch((err) => warn(`切换视频失败：${err && err.message}`));
  });

  loadForCurrentVideo().catch((err) => warn(`初始化失败：${err && err.message}`));
  everySecond(heartbeat);
})();
