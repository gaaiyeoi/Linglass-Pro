/**
 * 用导入的译文覆盖画面里 Linglass 的译文行（PLAN 050）
 *
 * 背景：PLAN 031 的边界是「导入的译文只进浮窗 / 面板 / 导出，不碰官方画面」。
 * 现在用户要求画面里也显示导入的译文，所以这里只改**译文行**：
 *
 *   #linglass-subtitle-overlay (shadowRoot)
 *     .subtitle-group
 *       .subtitle.subtitle-primary     ← 一个字都不碰（原文、振假名、点词、拖选）
 *       .subtitle.subtitle-secondary   ← 这一行的文本换成导入的译文
 *
 * 为什么碰 secondary 是安全的：官方 `updateSecondary()` 就是
 * `secondaryElement.textContent = cue.text`，这行是**纯文本**，没有 primary 那套
 * `.linglass-word` 按字符切片的结构；点词/拖选的切片只发生在 primary 上。
 *
 * ── 两条必须守住的规矩 ──
 *
 * 1. **先比对再写**：这棵树上有我们自己的 MutationObserver，无脑赋值会把
 *    自己打成死循环（仓库铁律，见 AGENTS.md §3 与 15-ja-break.js）。
 * 2. **空档与非导入句不碰**：官方自己会在句间隐藏译文行；我们只在
 *    「当前句有导入译文且还没结束」时接管，否则原样留给官方。
 */
(() => {
  'use strict';

  const track = globalThis.__llgModTrack;
  const shared = globalThis.__llgModShared;
  if (!track) {
    console.error('[llg-imported] 字幕轨道未加载（检查 src/mod 数字前缀与加载顺序）');
    return;
  }

  const HOST_ID = 'linglass-subtitle-overlay';
  const SECONDARY_SEL = '.subtitle.subtitle-secondary';
  const VIDEO_SEL = '#movie_player video';

  /** 当前挂着的 shadowRoot（官方重建播放器时会换一棵） */
  let root = null;
  let observer = null;

  function videoTime() {
    if (typeof track.getVideoTime === 'function') {
      const time = track.getVideoTime();
      if (Number.isFinite(time)) return time;
    }
    const video = document.querySelector(VIDEO_SEL) || document.querySelector('video');
    return video && Number.isFinite(video.currentTime) ? video.currentTime : null;
  }

  /**
   * 现在要覆盖的那一句；null = 不接管。
   *
   * `origin === 'imported'` 是 PLAN 031 建立的优先级标记（导入的译文不会被采样覆盖）。
   * `time >= cue.end` 表示已经进入句间空档 —— 这时官方会隐藏译文行，我们若继续写
   * 就会把上一句留在画面上。
   */
  function importedCue() {
    const cue = track.getCurrent();
    if (!cue || cue.origin !== 'imported' || !cue.secondary) return null;
    const time = videoTime();
    if (time != null && Number.isFinite(cue.end) && time >= cue.end) return null;
    return cue;
  }

  function paint() {
    const cue = importedCue();
    if (!cue) return;

    const el = root && root.querySelector(SECONDARY_SEL);
    if (!el) return;

    // 先比对再写：官方刚写过同一段文本时再赋值就是一次无意义的 DOM 变更，
    // 会触发自己的观察器（幂等）
    if (el.textContent !== cue.secondary) el.textContent = cue.secondary;
    // 官方在「这句没有译文」时把行隐藏；导入的译文要显示出来
    if (el.style && el.style.display === 'none') el.style.display = 'inline-block';
  }

  /** 官方重建播放器会换 shadowRoot：换树就重挂观察器 */
  function bind() {
    const host = document.getElementById(HOST_ID);
    const next = host && host.shadowRoot;
    if (!next) return false;
    if (next === root && observer) return true;

    observer?.disconnect();
    root = next;
    observer = new MutationObserver(() => paint());
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    return true;
  }

  function tick() {
    bind();
    paint();
  }

  bind();
  paint();
  // 导入落在暂停期间时也要立刻反映到画面上（applyTranslations 会 notify）
  track.subscribe(() => paint());

  // 共用 00-shared.js 的 1s 心跳（整页只留一个定时器）；单独被拿走时退回 setInterval
  if (shared && typeof shared.onTick === 'function') shared.onTick(tick);
  else setInterval(tick, 1000);
})();
