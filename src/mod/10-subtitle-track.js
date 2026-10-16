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

  /** 轨道采样的心跳间隔（正常由 MutationObserver 驱动，心跳只作兜底） */
  const HEARTBEAT_MS = 1000;
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
  /** 每个视频最多试几次列索引（缓存可能晚于页面出现，但也不能无限轮询） */
  const SKELETON_MAX_TRIES = 4;
  /** 直播句找不到对应骨架句时的匹配容差（秒） */
  const SKELETON_TOLERANCE_SECONDS = 1.8;
  /** 连续这么多句都匹配不上，就认为骨架选错了（另一种学习语言），换下一个候选 */
  const SKELETON_MISMATCH_LIMIT = 6;
  /** 骨架最多换几次（防抖动：视频被重新剪过时也会「匹配不上」，不能一直换） */
  const SKELETON_MAX_SWITCHES = 1;

  const listeners = new Set();

  let cues = [];
  let meta = null;
  /** 当前正在显示的那一句（不一定在数组末尾——用户会往回拖进度条） */
  let active = null;
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
   * 官方自己取纯文本时就是先 clone 再删掉所有 rt（vendor/linglass-1.12.3/assets/
   * promoCards-*.js 的 Tn()），15-ja-break.js 的 textOf() 也是同一口径（它的插入位置
   * 要对齐官方的字符偏移）。三处口径必须一致 —— 否则「译文贴回骨架句」的文本匹配
   * 会因为一边带注音、一边不带而莫名失败。
   */
  function plainText(el) {
    if (el.querySelector('rt')) {
      const clone = el.cloneNode(true);
      for (const rt of clone.querySelectorAll('rt')) rt.remove();
      return clone.textContent || '';
    }
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

  /** 列出这个视频的原文档位候选，按 cachedAt 降序（最新的那份最可能是当前用的） */
  async function listSkeletonKeys(videoId) {
    const stored = await chrome.storage.local.get(SKELETON_INDEX_KEY);
    const index = stored && stored[SKELETON_INDEX_KEY];
    const entries = index && Array.isArray(index.entries) ? index.entries : [];
    const prefix = `${SKELETON_PREFIX}${videoId}:`;

    return entries
      .filter((entry) => entry && typeof entry.key === 'string'
        && entry.key.startsWith(prefix)
        && entry.key.endsWith(SKELETON_SLOT))
      .sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0))
      .map((entry) => entry.key);
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
        if (!match.secondary && live.secondary) match.secondary = live.secondary;
        // 采样到的那句会继续被 extendActive 更新，指针要一起挪到骨架句上
        if (live === active) active = match;
        continue;
      }
      extras.push(live);
    }

    cues = merged.concat(extras).sort((a, b) => a.start - b.start);
    liveMisses = 0;
    invalidateEstimate();
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

    if (skeleton.videoId !== videoId) {
      skeleton.videoId = videoId;
      skeleton.keys = null;
      skeleton.next = 0;
      skeleton.tries = 0;
      skeleton.done = false;
      skeleton.adopted = null;
      skeleton.switches = 0;
    }

    skeleton.loading = true;
    try {
      if (!skeleton.keys) {
        skeleton.tries += 1;
        skeleton.keys = await listSkeletonKeys(videoId);
        if (!skeleton.keys.length) {
          if (skeleton.tries >= SKELETON_MAX_TRIES) skeleton.done = true;
          return;
        }
      }

      while (skeleton.next < skeleton.keys.length) {
        const key = skeleton.keys[skeleton.next];
        skeleton.next += 1;

        const stored = await chrome.storage.local.get(key);
        const list = fromSkeleton(stored && stored[key] && stored[key].cues);
        if (!list.length) continue;

        if (skeleton.adopted) resetSkeletonAdoption();
        adoptSkeleton(list);
        skeleton.adopted = key;
        skeleton.done = true;

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
    }
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
        if (lines.secondary && !match.secondary) match.secondary = lines.secondary;
        active = match;
        liveMisses = 0;
        return;
      }
      liveMisses += 1;
      if (liveMisses >= SKELETON_MISMATCH_LIMIT) retrySkeleton();
    }

    const existing = findDuplicate(lines.primary, start);
    if (existing) {
      if (lines.secondary) existing.secondary = lines.secondary;
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
   */
  function capture() {
    const lines = readLines();
    const key = lines ? `${lines.primary}\u0000${lines.secondary}` : '';

    if (key === lastKey) {
      extendActive();
      return;
    }
    lastKey = key;

    closeActive();
    if (lines && (lines.primary || lines.secondary)) {
      openCue(lines);
      // 官方写缓存可能晚于页面打开，所以看到字幕就顺手再试一次（限次，见 maybeLoadSkeleton）
      maybeLoadSkeleton().catch(() => {});
    }
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

  async function save() {
    const key = storeKey();
    if (!key) return;
    try {
      await chrome.storage.local.set({ [key]: { meta, cues, savedAt: Date.now() } });
    } catch {
      // storage 不可用时静默降级：内存里的轨道仍然可用
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
    lastKey = null;
    lastTickTime = null;
    resetSkeletonAdoption();
    invalidateEstimate();

    loading = true;
    try {
      const key = storeKey();
      const stored = key ? (await chrome.storage.local.get(key))[key] : null;
      if (stored && Array.isArray(stored.cues) && stored.cues.length) {
        cues = stored.cues;
        meta = { ...next, ...stored.meta, ...next, title: next.title || stored.meta?.title || '' };
      }
    } catch {
      // 读不出来就当新视频
    } finally {
      loading = false;
    }

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
    const lines = readLines();
    if (!lines || !lines.primary) return true;
    return lines.primary === primary;
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

  function snapshot() {
    return { meta: meta ? { ...meta } : null, cues: finalizedCues() };
  }

  async function clear() {
    closeActive();
    cues = [];
    active = null;
    lastKey = null;
    resetSkeletonAdoption();
    // 清空之后不要立刻又被骨架填满：这个视频本次不再采用骨架（换视频会重新允许）
    skeleton.done = true;
    skeleton.adopted = null;
    invalidateEstimate();
    const key = storeKey();
    if (key) {
      try {
        await chrome.storage.local.remove(key);
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
    getMeta: () => (meta ? { ...meta } : null),
    getVideoTime: currentTime,
    readLines,
    snapshot,
    clear,
    flush,
    reload: loadForCurrentVideo,
  };

  Object.defineProperty(globalThis, NS, { value: api, configurable: true });

  // ---------------------------------------------------------------- 启动

  document.addEventListener('yt-navigate-finish', () => {
    loadForCurrentVideo().catch((err) => warn(`切换视频失败：${err && err.message}`));
  });

  loadForCurrentVideo().catch((err) => warn(`初始化失败：${err && err.message}`));
  setInterval(heartbeat, HEARTBEAT_MS);
})();
