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
  /** 重看同一段时判定「同一句」的时间容差 */
  const DEDUPE_WINDOW_SECONDS = 2.5;

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

  function readLines() {
    const host = document.getElementById(HOST_ID);
    const root = host && host.shadowRoot;
    if (!root) return null;

    const group = root.querySelector('.subtitle-group');
    if (!group || group.style.display === 'none') return { primary: '', secondary: '' };

    const line = (sel) => {
      const el = root.querySelector(sel);
      if (!el || el.style.display === 'none') return '';
      return el.textContent.replace(/\s+/g, ' ').trim();
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
    const t = currentTime();
    if (t != null) active.end = t;
    if (active.end == null || active.end < active.start) active.end = active.start;
    active = null;
    // 这一句的时长从此定稿，进了估计时长的样本集合
    invalidateEstimate();
    scheduleSave();
  }

  /** 当前句还在显示时，让它的 end 跟着播放前进 */
  function extendActive() {
    if (!active) return;
    const t = currentTime();
    if (t == null) return;
    // 暂停时 currentTime 不动，别把 end 无限拉长（否则进度条会倒退）
    if (lastTickTime != null && t - lastTickTime < 0.05) return;
    lastTickTime = t;
    active.end = t;
    scheduleSave();
  }

  function openCue(lines) {
    const t = currentTime();
    const fallbackStart = cues.length ? cues[cues.length - 1].end ?? 0 : 0;
    const start = t != null ? t : fallbackStart + 0.001;

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
      spans.push(cue.end - cue.start);
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
    if (cue !== active && cue.end != null && cue.end > cue.start) return cue.end;
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

  function getProgress() {
    const t = currentTime();
    const index = indexAt(t);
    if (t == null || index < 0) return 0;
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
