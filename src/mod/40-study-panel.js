/**
 * Linglass 学习面板（页面内 Shadow DOM 侧栏）
 *
 * 1. 实时双语字幕
 * 2. 歌词式进度：当前句高亮 + 句内按播放进度扫过的填充条
 * 3. 逐句列表：点任意一句跳到视频对应位置
 * 4. 导出中日对照 Markdown（Obsidian 友好：YAML frontmatter + 每句一个带时间戳
 *    的可点击回跳链接 + 每行一个列表项，方便块引用与批注）以及双语 SRT
 *
 * 为什么用页面内面板而不是 chrome.sidePanel：Arc 有自己的一套侧边栏，
 * Chrome 原生 sidePanel API 在 Arc 上能否工作无法保证，官方 manifest 里也没有
 * 声明 sidePanel 权限。页面内面板在任何 Chromium 上都稳定。
 *
 * ⚠️ 但「能直接复用 Linglass 的 CSS 变量」是**错的**（原注释这么写过，实测不成立）：
 * 面板挂在 document.body 上，拿不到官方定义在它自己 shadow root / 侧边栏文档里的
 * `:root` 变量；而 `:host { all: initial }` 连自定义属性一起重置。
 * 所以官方的玻璃令牌是在 PANEL_CSS 里显式抄了一份（见那边的注释）。
 *
 * 时间戳来自 10-subtitle-track.js 自建的轨道；行级精确，词级用句内线性插值近似。
 *
 * ── 挂在哪儿（本文件最容易被改坏的部分，先读这段）──
 *
 * watch 页：宿主插进 YouTube 自己的推荐列（`#columns #secondary` 的第一个子节点），
 *   宽度与位置由 YouTube 算 —— 所以我们**不遮挡任何东西**（EnglishXYZ 2.2.5 就是这么做的）。
 *   代价：没有全高、没有拖拽改宽、面板高度得自己给一个上限（见 PANEL_CSS 的 column 段）。
 *
 * 其它页面（首页 / 搜索页没有那个列，或 YouTube 换了结构）：退回「右侧悬浮 + 让页面让位」
 *   的老做法（`data-mode=float`）。让位规则是实测出来的（见 LAYOUT_CSS 的注释）。
 *
 * 为什么不在悬浮模式下硬修「推荐列被压住」：实测（`--browser=arc`，viewport 1549×1100，
 * 面板 448px）——
 *
 *   panel=[1101..1549]  #movie_player=[0..1101]  #columns=[0..1101]
 *   #secondary=[825..1161]  overlap=true clearance=-60
 *
 * 即：容器确实让开了，但推荐列的宽度是 YouTube 自己定的（336px，不跟着容器缩），
 * 于是它从容器里溢出去 60px，正好落在面板底下。让位规则修不了这件事 —— 只有把面板
 * 交给 YouTube 的列布局才修得掉。
 */
(() => {
  'use strict';

  const shared = globalThis.__llgModShared;
  const track = globalThis.__llgModTrack;
  if (!shared || !track) {
    console.error('[llg-panel] 共享模块未加载（检查 src/mod 数字前缀与加载顺序）');
    return;
  }

  const BTN_ID = 'llg-panel-btn';
  const PIP_BTN_ID = 'llg-pip-btn';
  const ROOT_ID = 'llg-study-panel-root';
  const STORE_KEY = 'llgStudyPanel';
  const HEARTBEAT_MS = 1000;
  const WIDTH_MIN = 300;
  const WIDTH_MAX = 760;
  /** 让位样式的 <style> id（00-shared.js 的 STALE_IDS 里也登记了，扩展重载后要清掉） */
  const LAYOUT_STYLE_ID = 'llg-panel-layout-styles';
  /** 面板打开且需要让位时，打在 <html> 上的标记 */
  const PANEL_ATTR = 'data-llg-panel';
  /** 面板当前宽度，页面级让位样式靠它算 */
  const WIDTH_VAR = '--llg-panel-w';
  /** 补 resize（兜底）与「宽度脉冲」的时机（毫秒），见 nudgeVideosLayout */
  const NUDGE_DELAYS = [0, 350];
  const NUDGE_RESTORE_MS = 220;

  /**
   * 面板的两种挂载形态（打在宿主的 data-mode 上，样式按它分叉）。
   *   column：寄生在 YouTube 的推荐列里，宽度由列决定、不需要让位（watch 页）
   *   float ：右侧悬浮 + 让页面让位（没有那一列的页面）
   */
  const MODE_COLUMN = 'column';
  const MODE_FLOAT = 'float';
  /** 推荐列的选择器。带上 #columns 是为了不要撞上别处的 #secondary（见契约测试的登记） */
  const COLUMN_SEL = '#columns #secondary';

  const LABEL_IDLE = '学习面板';
  const LABEL_ON = '关闭学习面板';

  const ICON_SVG = `
<svg viewBox="0 0 24 24" class="llg-mod-icon" aria-hidden="true">
  <rect x="2.5" y="4" width="19" height="15.5" rx="2.5" fill="currentColor" fill-opacity="0.16"/>
  <path d="M6.2 9.2h11.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-opacity="0.88"/>
  <path d="M6.2 12.5h11.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-opacity="0.6"/>
  <path d="M6.2 15.8h6.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-opacity="0.38"/>
</svg>`;

  /**
   * 官方设计令牌的本地副本。
   *
   * 为什么不直接引用官方的 `--lg-*` / `--glass-*`：面板挂在 document.body 上，
   * 官方的 `:root` 块定义在它自己的 shadow root 里，根本到不了这里；
   * 而 `:host { all: initial }` 会把宿主上一切可继承属性（**包括自定义属性**）
   * 重置成初始值。两头一夹，`var(--radius-sm, 8px)` 这类引用**永远只会走兜底值** ——
   * 那就是"看起来不像 Linglass"的原因。
   *
   * 所以这里把官方取值显式抄一份（取值全部来自 vendor/linglass-1.12.3：
   * src/content/translate/styles.css 与 assets/sidepanel-*.css），只在本文件里用。
   * 官方改版时这份副本不会自动跟着变，属于已知代价（视觉走样，不影响功能）。
   */
  const PANEL_CSS = `
:host { all: initial; position: fixed; top: 0; right: 0; width: 0; height: 0; z-index: 2147483000; }
* { box-sizing: border-box; }

.panel {
  /* ── 玻璃令牌（深色为默认，浅色见本段末尾的 media query）── */
  --llg-bg-glass: rgba(28, 28, 30, .92);
  --llg-glass-blur: blur(20px);
  --llg-glass-saturate: saturate(180%);
  --llg-glass-overlay: linear-gradient(135deg, rgba(255,255,255,.06) 0%, rgba(255,255,255,.02) 100%);
  --llg-sheen: inset 0 1px 0 rgba(255, 255, 255, .08);
  --llg-divider: rgba(255, 255, 255, .06);
  --llg-border-subtle: rgba(255, 255, 255, .08);
  --llg-border-default: rgba(255, 255, 255, .12);
  --llg-shadow-panel: -8px 0 32px rgba(0, 0, 0, .45);
  --llg-row-hover: rgba(255, 255, 255, .04);
  --llg-button-secondary: rgba(255, 255, 255, .08);
  --llg-button-secondary-hover: rgba(255, 255, 255, .15);
  --llg-accent: #0A84FF;
  --llg-accent-light: rgba(10, 132, 255, .15);
  /* 当前句的进度填充。比 --llg-accent-light 更轻：那个令牌还用在列表选中态与
     拖拽手柄的 hover 上（那两处需要看得见），而这里是压在原文下面当背景的。 */
  --llg-fill-active: rgba(10, 132, 255, .10);
  --llg-text-primary: #FFFFFF;
  --llg-text-secondary: #8E8E93;
  --llg-text-tertiary: #8E8E93;
  --llg-text-quaternary: #AEAEB2;
  --llg-radius-sm: 8px;
  --llg-duration-fast: .15s;
  --llg-duration-normal: .2s;
  --llg-ease-out: cubic-bezier(0, 0, .2, 1);

  position: fixed;
  top: 0;
  right: 0;
  height: 100vh;
  width: 400px;
  display: flex;
  flex-direction: column;
  background: var(--llg-bg-glass);
  -webkit-backdrop-filter: var(--llg-glass-blur) var(--llg-glass-saturate);
  backdrop-filter: var(--llg-glass-blur) var(--llg-glass-saturate);
  border-left: 1px solid var(--llg-border-subtle);
  box-shadow: var(--llg-shadow-panel), var(--llg-sheen);
  color: var(--llg-text-primary);
  /* 放大到 15px 基座并优先 Inter，对齐官方侧边栏（官方 body 是 1rem = 16px，
     行高 1.5，开启字形平滑）。Inter 只是「本机装了就生效」的加成 —— 官方的字体文件
     在 vendor/assets/inter-latin-*.woff2，文件名带内容哈希，换版就变，不值得为它
     新增一条对官方产物的脆弱依赖；而且它只覆盖拉丁字母，中日文本来就走系统字体。 */
  font: 400 15px/1.5 'Inter', -apple-system, BlinkMacSystemFont, system-ui, 'PingFang SC', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  direction: ltr;
  transform: translateX(100%);
  pointer-events: none;
  transition: transform var(--llg-duration-normal) var(--llg-ease-out);
}
.panel[data-state="open"] { transform: translateX(0); pointer-events: auto; }
/* 视频全屏时收起（用户意图（data-state）不变，退出全屏后原样放回来） */
.panel[data-fullscreen="1"] { transform: translateX(100%); pointer-events: none; }

/* ── 寄生在推荐列里（data-mode=column）──
   宽度由 YouTube 的列给出，所以我们不再是 fixed、不再全高、也不能拖拽改宽。
   收开用 display 而不是 translateX：列里没有「从右边滑入」的余地，滑出去会把页面顶宽。
   高度得自己定一个：列本身是无限长的（推荐视频列表），面板不能跟着长下去 ——
   62vh 让「面板 + 下面几条推荐」都能露出来。⚠ 这个数值只经过布局推理，没在浏览器里
   人工确认过观感（要改就改这里）。 */
:host([data-mode="column"]) { display: block; position: static; width: 100%; height: auto; }
:host([data-mode="column"]) .panel {
  position: relative;
  top: auto;
  right: auto;
  width: 100%;
  height: 62vh;
  min-height: 320px;
  max-height: 640px;
  margin-bottom: 12px;
  transform: none;
  transition: none;
  border: 1px solid var(--llg-border-subtle);
  border-radius: var(--llg-radius-sm);
}
:host([data-mode="column"]) .panel[data-state="closed"] { display: none; }
/* 列布局下全屏由 YouTube 自己负责（整列都不显示），这里只需保证不会被滑走 */
:host([data-mode="column"]) .panel[data-fullscreen="1"] { transform: none; pointer-events: auto; }
:host([data-mode="column"]) .resize { display: none; }

/* 玻璃高光：一层斜向渐变，压在背景之上、内容之下（::before 是同层第一个盒子） */
.panel::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: var(--llg-glass-overlay);
}

.resize {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}
.resize:hover { background: var(--llg-accent-light); }

.head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 14px 12px 12px 16px;
  border-bottom: 1px solid var(--llg-divider);
}
.head-text { flex: 1; min-width: 0; }
.title { font-size: 15px; font-weight: 600; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sub { margin-top: 3px; font-size: 12.5px; color: var(--llg-text-secondary);
  font-variant-numeric: tabular-nums; }
.icon {
  flex: 0 0 auto; width: 28px; height: 28px; padding: 0;
  border: none; border-radius: 6px; background: transparent;
  color: var(--llg-text-secondary); font: inherit; font-size: 18px; line-height: 1;
  cursor: pointer;
}
.icon:hover { background: var(--llg-row-hover); color: var(--llg-text-primary); }

.stage { padding: 14px 16px 16px; border-bottom: 1px solid var(--llg-divider); min-height: 104px; }
.kline { position: relative; overflow: hidden; border-radius: var(--llg-radius-sm);
  padding: 8px 12px; margin-bottom: 8px; }
.kline:last-child { margin-bottom: 0; }
.kline-ja { font-size: 18px; font-weight: 600; line-height: 1.45; }
.kline-zh { font-size: 15px; color: var(--llg-text-quaternary); }
.kfill { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
  background: var(--llg-fill-active); border-radius: var(--llg-radius-sm); }
.ktext { position: relative; display: block; word-break: break-word; }
.stage-empty { color: var(--llg-text-tertiary); font-size: 13.5px; }

.list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  margin: 0; padding: 6px 0; list-style: none; scrollbar-width: thin; }
.list:empty::after {
  content: "打开 Linglass 字幕后会自动记录每一句";
  display: block; padding: 28px 16px; text-align: center;
  color: var(--llg-text-tertiary); font-size: 13.5px;
}
.row { display: grid; grid-template-columns: 48px 1fr; gap: 8px;
  padding: 9px 14px 9px 12px; cursor: pointer;
  border-left: 2px solid transparent; }
.row:hover { background: var(--llg-row-hover); }
.row.is-active { background: var(--llg-accent-light); border-left-color: var(--llg-accent); }
.stamp { color: var(--llg-text-tertiary); font-size: 12px;
  font-variant-numeric: tabular-nums; padding-top: 2px; }
.ja { display: block; font-size: 15px; line-height: 1.5; word-break: break-word; }
.zh { display: block; margin-top: 2px; color: var(--llg-text-secondary);
  font-size: 14px; line-height: 1.5; word-break: break-word; }

.foot { display: flex; gap: 6px; padding: 12px;
  border-top: 1px solid var(--llg-divider); }
.foot button { flex: 1; padding: 8px 8px; border-radius: var(--llg-radius-sm);
  border: 1px solid var(--llg-border-default); background: var(--llg-button-secondary);
  color: var(--llg-text-primary); font: inherit; font-size: 13.5px; cursor: pointer;
  transition: background var(--llg-duration-fast) var(--llg-ease-out); }
.foot button:hover { background: var(--llg-button-secondary-hover); }
.foot button.ghost { flex: 0 0 auto; color: var(--llg-text-secondary); }

.toast {
  position: absolute; left: 50%; bottom: 62px;
  transform: translateX(-50%) translateY(6px);
  max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 6px 12px; border-radius: 999px;
  background: var(--llg-accent); color: #fff; font-size: 13px;
  opacity: 0; pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
}
.toast.is-on { opacity: 1; transform: translateX(-50%) translateY(0); }

/* 官方同样提供浅色一套，跟随系统 */
@media (prefers-color-scheme: light) {
  .panel {
    --llg-bg-glass: rgba(255, 255, 255, .72);
    --llg-glass-overlay: linear-gradient(135deg, rgba(255,255,255,.9) 0%, rgba(255,255,255,.7) 100%);
    --llg-sheen: inset 0 1px 0 rgba(255, 255, 255, .9);
    --llg-divider: rgba(0, 0, 0, .06);
    --llg-border-subtle: rgba(0, 0, 0, .08);
    --llg-border-default: rgba(0, 0, 0, .12);
    --llg-shadow-panel: -8px 0 32px rgba(0, 0, 0, .12);
    --llg-row-hover: rgba(0, 0, 0, .04);
    --llg-button-secondary: rgba(0, 0, 0, .06);
    --llg-button-secondary-hover: rgba(0, 0, 0, .1);
    --llg-accent: #007AFF;
    --llg-accent-light: rgba(0, 122, 255, .12);
    --llg-fill-active: rgba(0, 122, 255, .08);
    --llg-text-primary: #1D1D1F;
    --llg-text-secondary: #636366;
    --llg-text-tertiary: #636366;
    --llg-text-quaternary: #48484A;
  }
}
`;

  /**
   * 页面级让位样式：面板打开时，把页面内容整体往左收窄，而不是压在视频上面。
   *
   * **只在 float 形态用**（`data-mode=float`）：column 形态下面板已经在 YouTube 的列里，
   * 宽度是它自己算的，再让位就成了双重收窄。
   *
   * 取值与选择器全部来自实测（tools/probe.mjs 的「候选让位规则对比」，viewport
   * 1440×757、面板 480 宽；默认 / 剧场 / 全屏三态 × 5 条候选）：
   *
   *   默认视图：video 16..1012 → 16..869（clearance −52 → +91）
   *   剧场视图：video 197..1242 → 0..960（clearance −282 → 0）
   *   全屏：不套用（见 applyLayout）
   *
   * 四条「挂 ytd-app / 挂 ytd-watch-flexy × padding / margin」在默认与剧场下结果完全一致，
   * 选 ytd-app + padding 是因为它同时覆盖非播放页（首页/搜索页）：那种页面上没有
   * ytd-watch-flexy，只挂它的话面板会照样盖住内容。
   *
   * 顶栏与迷你播放器是 fixed，任何让位规则都盖不住，只能各自单独让。
   */
  const LAYOUT_CSS = `
html[data-llg-panel] ytd-app { padding-right: var(--llg-panel-w, 400px) !important; }
html[data-llg-panel] #masthead-container { width: calc(100% - var(--llg-panel-w, 400px)) !important; }
html[data-llg-panel] ytd-miniplayer { right: var(--llg-panel-w, 400px) !important; }
`;

  const PANEL_HTML = `
<div class="panel" data-state="closed" data-role="panel">
  <div class="resize" data-role="resize"></div>
  <header class="head">
    <div class="head-text">
      <div class="title" data-role="title">学习面板</div>
      <div class="sub" data-role="sub">等待字幕…</div>
    </div>
    <button class="icon" type="button" data-act="close" aria-label="关闭">×</button>
  </header>
  <section class="stage">
    <div class="kline kline-ja">
      <i class="kfill" data-role="fill"></i>
      <span class="ktext" data-role="ja"></span>
    </div>
    <div class="kline kline-zh">
      <i class="kfill" data-role="fill2"></i>
      <span class="ktext" data-role="zh"></span>
    </div>
  </section>
  <ol class="list" data-role="list"></ol>
  <footer class="foot">
    <button type="button" data-act="md">导出 Markdown</button>
    <button type="button" data-act="srt">SRT</button>
    <button type="button" data-act="copy">复制</button>
    <button type="button" class="ghost" data-act="clear">清空</button>
  </footer>
  <div class="toast" data-role="toast"></div>
</div>`;

  const els = {};
  const state = { open: false, width: 400 };
  let built = false;
  let rendered = [];
  let activeIndex = -1;
  let follow = true;
  let rafId = 0;
  let toastTimer = 0;
  /** 让位当前是不是生效（null = 还没算过），用来避免重复写 DOM 与重复补 resize */
  let layoutOn = null;
  let layoutWidth = 0;
  /** 补 resize 的定时器，连续改宽时要先撤销上一次 */
  const nudgeTimers = [];
  /** 面板宿主（buildPanel 里建，之后只挂载不重建） */
  let hostNode = null;
  /** 当前挂载形态（null = 还没挂过）；见文件头「挂在哪儿」 */
  let mountMode = null;
  /** 当前挂在哪个元素下（YouTube 重建列之后这个引用会失效，据此重挂） */
  let mountParent = null;

  // ---------------------------------------------------------------- 工具

  function fmtClock(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function fmtSrtTime(seconds) {
    // 先取整到毫秒再拆分：直接对小数部分取整会被浮点误差咬
    // （21.2 - 21 = 0.19999999999999929，会输出成 ,199）
    const totalMs = Math.round(Math.max(0, seconds || 0) * 1000);
    const ms = totalMs % 1000;
    const whole = (totalMs - ms) / 1000;
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }

  function yamlString(value) {
    return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function video() {
    return document.querySelector('#movie_player video') || document.querySelector('video');
  }

  function toast(message) {
    // 面板没打开过时没有地方显示气泡（从设置面板触发导出就是这种情况），退回控制台
    if (!built) {
      console.info(`[llg-panel] ${message}`);
      return;
    }
    els.toast.textContent = message;
    els.toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-on'), 2400);
  }

  // ---------------------------------------------------------------- 面板 DOM

  function buildPanel() {
    if (built) return;

    const host = document.createElement('div');
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.append(style);

    const holder = document.createElement('div');
    holder.innerHTML = PANEL_HTML;
    shadow.append(holder.firstElementChild);

    for (const role of ['panel', 'resize', 'title', 'sub', 'fill', 'fill2', 'ja', 'zh', 'list', 'toast']) {
      els[role] = shadow.querySelector(`[data-role="${role}"]`);
    }

    // 宽度不在这里写死：列形态下它由 YouTube 的列给（见 applyPanelWidth）
    els.list.addEventListener('wheel', () => {
      follow = false;
    }, { passive: true });

    shadow.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') setOpen(false);
      else if (act === 'clear') onClear();
      else if (act) onExport(act);
    });

    setupResize();

    hostNode = host;
    built = true;
    // 挂载形态由页面结构决定（见文件头「挂在哪儿」），所以建完就同步一次
    syncMount();
  }

  function setupResize() {
    let startX = 0;
    let startWidth = 0;

    const onMove = (ev) => {
      state.width = clamp(startWidth + (startX - ev.clientX), WIDTH_MIN, WIDTH_MAX);
      applyPanelWidth();
      // 拖的过程中就让页面跟着让位（YouTube 自己有 ResizeObserver，跟得上）
      applyLayout();
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      saveState();
    };

    els.resize.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      startX = ev.clientX;
      startWidth = state.width;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // ---------------------------------------------------------------- 挂载

  /**
   * 决定这次用哪种形态，并把宿主放到对的位置（幂等：位置没变的调用什么都不做）。
   *
   * 为什么要每次心跳都跑：YouTube 是 SPA，换视频 / 切布局时会把 `#columns`、`#secondary`
   * 整棵重建，宿主会跟着被丢掉。所以判据不能是「挂过没有」，而是「父节点还是不是同一个
   * 元素、宿主还在不在文档里」。
   */
  function syncMount() {
    if (!built) return;

    const column = document.querySelector(COLUMN_SEL);
    const next = column ? MODE_COLUMN : MODE_FLOAT;
    const parent = column || document.body;
    // 桩件里没有 isConnected（真 DOM 一定有）：拿不到就当它还在，靠父节点引用判重挂
    const connected = typeof hostNode.isConnected === 'boolean' ? hostNode.isConnected : true;

    if (mountMode === next && mountParent === parent && connected) return;

    if (next === MODE_COLUMN) parent.prepend(hostNode);
    else parent.append(hostNode);

    mountMode = next;
    mountParent = parent;
    hostNode.dataset.mode = next;
    // 形态变了，宽度与让位都要跟着重算（列里不该再压窄页面）
    applyPanelWidth();
    applyLayout();
  }

  /**
   * 面板宽度。
   *
   * **必须走内联样式**（悬浮形态）：内联优先级高于样式表，写进 PANEL_CSS 会被
   * `:host([data-mode="column"]) .panel { width: 100% }` 这类规则之外的东西干扰，
   * 而拖拽改宽要的正是「立即生效、不被任何规则覆盖」。
   * 反过来，列形态下我们必须把这条内联宽度**清掉** —— 否则它会盖住 CSS 里的 100%，
   * 面板就还是 400px 宽地卡在列里（列宽是 YouTube 给的，我们不该管）。
   */
  function applyPanelWidth() {
    if (!built) return;
    els.panel.style.width = mountMode === MODE_COLUMN ? '' : `${state.width}px`;
  }

  // ---------------------------------------------------------------- 让位

  /**
   * 视频是不是全屏了。
   *
   * 两个都看：`document.fullscreenElement` 是标准信号（YouTube 用 Fullscreen API 全屏
   * `#movie_player`），`ytd-watch-flexy[fullscreen]` 是 YouTube 自己的标记 —— 它有时
   * 先改标记、后进真正全屏，两个一起判可以少一次「页面被压窄但面板已经该收起」的抖动。
   */
  function isFullscreen() {
    return Boolean(document.fullscreenElement)
      || Boolean(document.querySelector('ytd-watch-flexy[fullscreen]'));
  }

  /** 让位样式的 <style> 只注入一次（幂等；扩展重载后的残留由 00-shared.js 的 STALE_IDS 清） */
  function injectLayoutStyle() {
    if (document.getElementById(LAYOUT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = LAYOUT_STYLE_ID;
    style.textContent = LAYOUT_CSS;
    document.head.append(style);
  }

  /**
   * 逼 YouTube 重算播放器尺寸（这轮最反直觉的一条，全靠实测）。
   *
   * 现象：只把容器改窄，`<video>` 的矩形**一动不动** —— 剧场模式下 video 停在
   * 197..1242，把 ytd-app 收窄 480px 之后它还是 197..1242，于是照样被面板压住。
   * YouTube 的播放器尺寸是它自己的 JS 算出来写上去的，没收到「尺寸变了」就不会重算。
   *
   * 试过没用与有用的做法（probe 的候选对比 + 剧场切换实测）：
   *   · 合成一个 `resize` 事件 → **没用**；下面仍然发它，只是给「监听 resize 的版本」兜底；
   *   · 让容器**再变 1px、下一拍改回** → 有用。它自己的 ResizeObserver 真的看到尺寸变化，
   *     随即按新容器重算（probe 里 video 从 197..1242 变成 0..959、clearance 从 −282 变 0）。
   *
   * 所以这里的「补」是脉冲式地改一下宽度变量：1px 肉眼看不出来，但足够触发观察者。
   * 恢复得早一点也没关系 —— 观察者要的只是「变过」，之后读到的宽度仍然是面板的真实宽度。
   */
  function nudgeVideosLayout() {
    const root = document.documentElement;

    for (const delay of NUDGE_DELAYS) {
      const notify = setTimeout(() => {
        nudgeTimers.splice(nudgeTimers.indexOf(notify), 1);
        try {
          window.dispatchEvent(new Event('resize'));
        } catch (err) {
          // 非常规环境（测试沙箱）里没有 Event/window，让位本身已经生效，不必上报
        }
      }, delay);
      nudgeTimers.push(notify);
    }

    try {
      root.style.setProperty(WIDTH_VAR, `${state.width + 1}px`);
    } catch (err) {
      return; // 沙箱或异常环境下没有 style，让位本身已经生效
    }

    const restore = setTimeout(() => {
      nudgeTimers.splice(nudgeTimers.indexOf(restore), 1);
      // 期间面板可能已经关了：那就别再往 <html> 上写宽度变量
      if (layoutOn) root.style.setProperty(WIDTH_VAR, `${state.width}px`);
    }, NUDGE_RESTORE_MS);
    nudgeTimers.push(restore);
  }

  /** 让位关闭时把挂着的脉冲计时器撤掉，避免关闭后又被写回宽度变量 */
  function cancelNudges() {
    for (const timer of nudgeTimers.splice(0)) clearTimeout(timer);
  }

  /**
   * 把让位状态同步到页面。
   *
   * 全屏时不套用：面板自己会收起（见 syncFullscreen），页面不需要（也不应该）让位 ——
   * 实测全屏下套用让位规则反而把 `<video>` 从 50..2510 挤成 0..960。
   *
   * column 形态也不套用：面板已经在 YouTube 的列里（宽度由它算），再让位就是双重收窄。
   */
  function applyLayout() {
    const on = state.open && !isFullscreen() && mountMode !== MODE_COLUMN;
    const root = document.documentElement;

    if (on === layoutOn && (!on || layoutWidth === state.width)) return;

    const wasOn = layoutOn === true;
    const widthChanged = layoutWidth !== state.width;
    layoutOn = on;
    layoutWidth = state.width;

    if (on) {
      injectLayoutStyle();
      root.setAttribute(PANEL_ATTR, 'open');
      root.style.setProperty(WIDTH_VAR, `${state.width}px`);
      // 首次开启、以及拖宽之后都要让 YouTube 重算播放器尺寸
      if (!wasOn || widthChanged) nudgeVideosLayout();
    } else {
      cancelNudges();
      root.removeAttribute(PANEL_ATTR);
      root.style.removeProperty(WIDTH_VAR);
    }
  }

  /**
   * 全屏时把面板收起（用户意图 state.open 不动），退出全屏再放回来。
   *
   * column 形态不需要收：YouTube 全屏时整列都不显示，面板自然跟着不见；
   * 反过来在这里写 data-fullscreen=1 只会在退出全屏时多一次无意义的 DOM 变更。
   */
  function syncFullscreen() {
    if (built) {
      const hidden = mountMode === MODE_COLUMN ? '0' : (isFullscreen() ? '1' : '0');
      if (els.panel.dataset.fullscreen !== hidden) els.panel.dataset.fullscreen = hidden;
    }
    applyLayout();
  }

  /**
   * 页面布局的标记（剧场 / 全屏）。
   *
   * 为什么要盯它：实测发现 —— 面板已经开着时**再切剧场模式**，YouTube 不会按新容器
   * 重算 `<video>` 尺寸（probe 的「剧场视图 / baseline(现状)」那一行：容器已经是
   * 0..959，video 还停在 197..1242，被面板压住 283px）。它只在收到 resize 时才重算，
   * 所以布局标记一变就主动补一次（见心跳里的调用）。
   */
  function layoutSignature() {
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy) return '';
    return `${flexy.hasAttribute('theater') ? 'T' : '-'}${flexy.hasAttribute('fullscreen') ? 'F' : '-'}`;
  }

  /** 上一次看到的布局标记；null = 还没建立基线（第一次心跳只记录，不补 resize） */
  let layoutSignatureSeen = null;

  function syncLayoutSignature() {
    const signature = layoutSignature();
    if (layoutSignatureSeen === null) {
      layoutSignatureSeen = signature;
      return;
    }
    if (signature === layoutSignatureSeen) return;
    layoutSignatureSeen = signature;
    if (state.open) nudgeVideosLayout();
  }

  // ---------------------------------------------------------------- 开关

  function setOpen(open) {
    if (open) buildPanel();

    state.open = open;
    if (built) {
      els.panel.dataset.state = open ? 'open' : 'closed';
      if (open) renderAll();
    }

    syncFullscreen();
    saveState();

    if (open) startFrame();
    else stopFrame();

    refreshButton();
  }

  /** 面板宽度与开关一起落盘：刷新/换视频/扩展重载之后要能自己回来（「常驻」） */
  function saveState() {
    chrome.storage.local
      .set({ [STORE_KEY]: { width: state.width, open: state.open } })
      .catch(() => {});
  }

  function refreshButton() {
    const ok = shared.ensureButton({
      id: BTN_ID,
      icon: ICON_SVG,
      afterId: PIP_BTN_ID,
      onClick: () => setOpen(!state.open),
    });
    if (!ok) return;
    shared.setButtonState(BTN_ID, {
      label: state.open ? LABEL_ON : LABEL_IDLE,
      on: state.open,
    });
  }

  // ---------------------------------------------------------------- 列表

  function makeRow(cue) {
    const li = document.createElement('li');
    li.className = 'row';

    const stamp = document.createElement('span');
    stamp.className = 'stamp';
    stamp.textContent = fmtClock(cue.start);

    const body = document.createElement('div');

    const ja = document.createElement('span');
    ja.className = 'ja';
    ja.textContent = cue.primary || '（无原文）';
    body.append(ja);

    if (cue.secondary) {
      const zh = document.createElement('span');
      zh.className = 'zh';
      zh.textContent = cue.secondary;
      body.append(zh);
    }

    li.append(stamp, body);
    li.addEventListener('click', () => {
      const el = video();
      if (el && Number.isFinite(cue.start)) el.currentTime = cue.start;
      follow = true;
    });
    return li;
  }

  function renderAll() {
    const cues = track.getCues();
    els.list.textContent = '';
    const frag = document.createDocumentFragment();
    for (const cue of cues) frag.append(makeRow(cue));
    els.list.append(frag);
    rendered = cues.slice();
    activeIndex = -1;
    updateMeta();
  }

  /** 追加式增量渲染：正常播放时只 append 新行，避免整表重建丢掉滚动位置 */
  function syncList() {
    const cues = track.getCues();
    const samePrefix = cues.length >= rendered.length
      && rendered.every((cue, i) => cue === cues[i]);

    if (samePrefix && cues.length === rendered.length) return;

    if (!samePrefix) {
      const scrollTop = els.list.scrollTop;
      els.list.textContent = '';
      const frag = document.createDocumentFragment();
      for (const cue of cues) frag.append(makeRow(cue));
      els.list.append(frag);
      els.list.scrollTop = scrollTop;
    } else {
      const frag = document.createDocumentFragment();
      for (let i = rendered.length; i < cues.length; i += 1) frag.append(makeRow(cues[i]));
      els.list.append(frag);
    }

    rendered = cues.slice();
    activeIndex = -1;
    updateMeta();
  }

  function updateMeta() {
    const meta = track.getMeta();
    const cues = track.getCues();
    const count = cues.length;
    els.title.textContent = meta?.title || '学习面板';

    const parts = [];
    if (meta?.duration) parts.push(fmtClock(meta.duration));
    parts.push(`${count} 句`);
    // 句子来自官方整条轨（见 10-subtitle-track.js 的「骨架」一节），译文只可能来自
    // 实际播放 —— 把进度显出来，用户才知道「还有多少没看过」，而不是以为漏了。
    const translated = cues.reduce((sum, cue) => sum + (cue.secondary ? 1 : 0), 0);
    if (count && translated < count) parts.push(`译文 ${translated}/${count}`);
    if (meta?.channel) parts.push(meta.channel);
    els.sub.textContent = parts.join(' · ');
  }

  // ---------------------------------------------------------------- 歌词进度

  function startFrame() {
    if (rafId) return;
    const step = () => {
      rafId = requestAnimationFrame(step);
      paint();
    };
    rafId = requestAnimationFrame(step);
  }

  function stopFrame() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function paint() {
    if (!built) return;

    const cur = track.getCurrent();
    const percent = `${track.getProgress() * 100}%`;
    els.fill.style.width = percent;
    els.fill2.style.width = percent;

    const ja = cur ? cur.primary : '';
    const zh = cur ? cur.secondary : '';
    if (els.ja.textContent !== ja) els.ja.textContent = ja;
    if (els.zh.textContent !== zh) els.zh.textContent = zh;

    highlight(cur ? cur.index : -1);
  }

  function highlight(index) {
    if (index === activeIndex) return;

    const prev = els.list.querySelector('.row.is-active');
    if (prev) prev.classList.remove('is-active');

    activeIndex = index;
    if (index < 0) return;

    const row = els.list.children[index];
    if (!row) return;
    row.classList.add('is-active');
    if (follow) row.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- 导出

  function toMarkdown(snap) {
    const meta = snap.meta || {};
    const url = meta.url || location.href;
    const title = meta.title || '未命名视频';

    const lines = [];
    lines.push('---');
    lines.push(`title: ${yamlString(title)}`);
    lines.push(`source: ${url}`);
    if (meta.id) lines.push(`video_id: ${meta.id}`);
    if (meta.channel) lines.push(`channel: ${yamlString(meta.channel)}`);
    if (meta.duration) lines.push(`duration: ${yamlString(fmtClock(meta.duration))}`);
    lines.push(`exported: ${new Date().toISOString().slice(0, 10)}`);
    lines.push('tags: [linglass, 日语学习]');
    lines.push('---');
    lines.push('');
    lines.push(`# ${title}`);
    lines.push('');
    lines.push(`> [在 YouTube 打开](${url}) · 共 ${snap.cues.length} 句`);
    lines.push('');
    lines.push('## 中日对照');
    lines.push('');

    for (const cue of snap.cues) {
      const seconds = Math.max(0, Math.floor(cue.start || 0));
      const stamp = fmtClock(seconds);
      const link = `${url}&t=${seconds}s`;
      lines.push(`- [\`${stamp}\`](${link}) ${cue.primary || '（无原文）'}`);
      if (cue.secondary) lines.push(`  - ${cue.secondary}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  function toSrt(snap) {
    return snap.cues
      .map((cue, i) => {
        const start = Math.max(0, cue.start || 0);
        const end = Math.max(start + 0.5, cue.end || start + 3);
        const text = [cue.primary, cue.secondary].filter(Boolean).join('\n');
        return `${i + 1}\n${fmtSrtTime(start)} --> ${fmtSrtTime(end)}\n${text}\n`;
      })
      .join('\n');
  }

  function baseName(snap) {
    const raw = (snap.meta?.title || 'youtube-字幕').trim();
    return raw.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 120) || 'youtube-字幕';
  }

  function download(filename, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function onExport(kind) {
    const snap = track.snapshot();
    if (!snap.cues.length) {
      toast('还没有记录到字幕');
      return;
    }

    if (kind === 'md') {
      download(`${baseName(snap)}.md`, toMarkdown(snap), 'text/markdown;charset=utf-8');
      toast(`已导出 ${snap.cues.length} 句 Markdown`);
      return;
    }
    if (kind === 'srt') {
      download(`${baseName(snap)}.srt`, toSrt(snap), 'application/x-subrip;charset=utf-8');
      toast(`已导出 ${snap.cues.length} 句 SRT`);
      return;
    }
    if (kind === 'copy') {
      navigator.clipboard
        .writeText(toMarkdown(snap))
        .then(() => toast('Markdown 已复制，直接粘进 Obsidian'))
        .catch(() => toast('复制失败，改用「导出 Markdown」'));
    }
  }

  function onClear() {
    const count = track.getCues().length;
    if (!count) {
      toast('本来就是空的');
      return;
    }
    if (!window.confirm(`清空已记录的 ${count} 句？重新看一遍会重新记录。`)) return;
    track.clear().then(() => {
      if (built) renderAll();
      toast('已清空');
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- 启动

  // 纯函数的测试钩子：浏览器里没有副作用，Node 侧可直接调用做冒烟测试
  Object.defineProperty(globalThis, '__llgModPanel', {
    value: { toMarkdown, toSrt, fmtClock, fmtSrtTime },
    configurable: true,
  });

  // 登记到设置面板（行内图标用 .toggle-icon / .nav-row__ic，与面板同一套线框风格）
  shared.registerFeature({
    id: 'studyPanel',
    title: '学习面板',
    icon: `
<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="4" width="18" height="16" rx="2"/>
  <path d="M14 4v16"/>
  <path d="M6 9h5M6 13h4"/>
</svg>`,
    isOn: () => state.open,
    toggle: () => setOpen(!state.open),
    actions: [
      {
        id: 'exportMd',
        title: '导出中日对照 Markdown',
        icon: `
<svg class="nav-row__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M5 19h14"/>
</svg>`,
        value: () => `${track.getCues().length} 句`,
        run: () => onExport('md'),
      },
      {
        id: 'exportSrt',
        title: '导出双语 SRT',
        icon: `
<svg class="nav-row__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="6" width="18" height="12" rx="2"/>
  <path d="M7 12h3.5M13.5 12H17"/>
</svg>`,
        run: () => onExport('srt'),
      },
      {
        id: 'copyMd',
        title: '复制 Markdown 到剪贴板',
        icon: `
<svg class="nav-row__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="9" width="11" height="11" rx="2"/>
  <path d="M5 15V6a1 1 0 0 1 1-1h9"/>
</svg>`,
        run: () => onExport('copy'),
      },
      {
        id: 'clearTrack',
        title: '清空已记录的字幕',
        icon: `
<svg class="nav-row__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 7h14"/><path d="M9.5 7V5h5v2"/><path d="M7.5 7l1 12h7l1-12"/>
</svg>`,
        run: () => onClear(),
      },
    ],
  });

  chrome.storage.local
    .get(STORE_KEY)
    .then((res) => {
      const saved = res && res[STORE_KEY];
      if (saved && Number.isFinite(saved.width)) {
        state.width = clamp(saved.width, WIDTH_MIN, WIDTH_MAX);
        applyPanelWidth();
      }
      // 「常驻」：上次开着就自己开回来（落盘晚于首帧，所以这里是唯一能恢复的时机）
      if (saved && saved.open === true) setOpen(true);
      else syncFullscreen();
    })
    .catch(() => {
      syncFullscreen();
    });

  track.subscribe(() => {
    if (state.open && built) syncList();
  });

  document.addEventListener('yt-navigate-finish', () => {
    rendered = [];
    activeIndex = -1;
    if (state.open && built) renderAll();
    // 换视频可能带来新的布局（例如从普通页进剧场、或从首页进播放页），
    // 挂载形态、让位与收起都要重算
    syncMount();
    syncFullscreen();
  });

  // 全屏进出：面板收起 / 放回，页面让位跟着开关（ytd-watch-flexy[fullscreen] 那条
  // 分支由心跳兜底，因为 YouTube 有时不进 Fullscreen API 只改自己的标记）
  document.addEventListener('fullscreenchange', syncFullscreen);

  // 视频被换掉时重新挂按钮（YouTube 是 SPA，控制栏会被重建）
  refreshButton();
  setInterval(() => {
    refreshButton();
    // 列被 YouTube 重建之后宿主会掉出来，靠心跳把它挂回去
    syncMount();
    syncFullscreen();
    syncLayoutSignature();
  }, HEARTBEAT_MS);
})();
