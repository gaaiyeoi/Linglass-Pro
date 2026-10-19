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
  // 心跳间隔不在这里定义：定时器由 00-shared.js 的共享心跳统一驱动（1s，见文件末尾）
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

/* 「回到当前句」：悬浮在列表右下角的胶囊，只有跟随被关掉（用户滚到别处了）时才出现。
   为什么从 .head 挪到这里：① 列形态下面板跟着 YouTube 的列走、只有几百像素宽，
   挤在标题旁边不显眼；② 拖滚动条不会触发 wheel（PLAN 013 登记的已知边界），
   按钮的显隐改由「当前行是否在列表可视区内」兜底，见 list 的 scroll 监听。 */
.list-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
.follow {
  position: absolute; right: 12px; bottom: 12px; z-index: 1;
  padding: 6px 12px; border: none; border-radius: 999px;
  background: var(--llg-button-secondary); color: var(--llg-text-primary);
  box-shadow: 0 2px 10px rgba(0, 0, 0, .32);
  font: inherit; font-size: 12.5px; line-height: 1.3; white-space: nowrap;
  cursor: pointer;
  transition: background var(--llg-duration-fast) var(--llg-ease-out);
}
.follow:hover { background: var(--llg-button-secondary-hover); }
.follow[data-state="off"] { display: none; }

/* 当前句块（大字号双语）排在列表**之后**、紧贴页脚：位置与视频原生字幕一样低，
   眼睛不必在「画面底部」与「面板顶部」之间来回跳（见 PLAN 014 的第 3 条）。 */
.stage { padding: 14px 16px 16px; border-top: 1px solid var(--llg-divider); min-height: 104px; }
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

.foot { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px;
  border-top: 1px solid var(--llg-divider); }
.foot button { flex: 1 1 auto; min-width: 68px; padding: 8px 8px; border-radius: var(--llg-radius-sm);
  border: 1px solid var(--llg-border-default); background: var(--llg-button-secondary);
  color: var(--llg-text-primary); font: inherit; font-size: 13.5px; cursor: pointer;
  transition: background var(--llg-duration-fast) var(--llg-ease-out); }
.foot button:hover { background: var(--llg-button-secondary-hover); }
.foot button.ghost { flex: 0 0 auto; color: var(--llg-text-secondary); }

/* ── AI 翻译设置层（PLAN 034）──
   盖住整个面板而不是新开页面：翻译结果要落在面板/浮窗/导出里，
   用户翻完抬头就能看到，不必在标签页之间来回切。 */
.sheet {
  position: absolute; inset: 0; z-index: 5;
  display: flex; flex-direction: column;
  background: rgba(22, 22, 24, .97);
  -webkit-backdrop-filter: var(--llg-glass-blur);
  backdrop-filter: var(--llg-glass-blur);
}
.sheet[data-state="closed"] { display: none; }
.sheet-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 12px 12px 10px 16px; border-bottom: 1px solid var(--llg-divider);
}
.sheet-title { font-size: 15px; font-weight: 600; }
.sheet-body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px;
}
.field { display: flex; flex-direction: column; gap: 5px;
  font-size: 12.5px; color: var(--llg-text-secondary); }
.field input, .field select {
  width: 100%; padding: 8px 10px; border-radius: var(--llg-radius-sm);
  border: 1px solid var(--llg-border-default); background: var(--llg-button-secondary);
  color: var(--llg-text-primary); font: inherit; font-size: 13.5px;
}
.field input:focus, .field select:focus { outline: none; border-color: var(--llg-accent); }
.field-check { flex-direction: row; align-items: center; gap: 8px;
  color: var(--llg-text-quaternary); }
.field-check input { width: auto; }
.sheet-note { font-size: 12.5px; line-height: 1.5; color: var(--llg-text-tertiary);
  white-space: pre-wrap; word-break: break-word; }
.sheet-actions { display: flex; gap: 8px; margin-top: 2px; }
.sheet-actions button {
  flex: 1 1 auto; padding: 9px 10px; border-radius: var(--llg-radius-sm);
  border: 1px solid var(--llg-border-default); background: var(--llg-button-secondary);
  color: var(--llg-text-primary); font: inherit; font-size: 13.5px; cursor: pointer;
}
.sheet-actions button:hover { background: var(--llg-button-secondary-hover); }
.sheet-actions button.ghost { flex: 0 0 auto; color: var(--llg-text-secondary); }
.sheet-actions button[disabled] { opacity: .45; cursor: default; }

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
  /* 设置层自己的底色要跟着换：它盖在 .panel 之上，不继承后者的背景 */
  .sheet { background: rgba(250, 250, 252, .97); }
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
  <div class="list-wrap">
    <ol class="list" data-role="list"></ol>
    <button class="follow" type="button" data-role="follow" data-act="follow"
      data-state="off" title="滚动到正在播放的那一句">回到当前句</button>
  </div>
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
  <footer class="foot">
    <button type="button" data-act="md">导出 Markdown</button>
    <button type="button" data-act="srt">SRT</button>
    <button type="button" data-act="srtSrc" title="只导原文，喂给翻译工具用">原文 SRT</button>
    <button type="button" data-act="importSrt" title="把翻好的译文 SRT 贴回来">导入译文</button>
    <button type="button" data-act="aiTranslate" title="用自己的 API Key 按句翻译整条原文">AI 翻译</button>
    <button type="button" data-act="copy">复制</button>
    <button type="button" class="ghost" data-act="clear">清空</button>
  </footer>
  <section class="sheet" data-role="sheet" data-state="closed">
    <header class="sheet-head">
      <span class="sheet-title">AI 翻译</span>
      <button class="icon" type="button" data-act="aiClose" aria-label="关闭">×</button>
    </header>
    <div class="sheet-body">
      <label class="field"><span>服务商</span>
        <select data-role="aiProvider">
          <option value="deepseek">DeepSeek</option>
          <option value="openai">OpenAI</option>
          <option value="moonshot">Kimi（Moonshot）</option>
          <option value="siliconflow">SiliconFlow</option>
          <option value="openrouter">OpenRouter</option>
          <option value="custom">自定义</option>
        </select>
      </label>
      <label class="field"><span>接口地址</span>
        <input data-role="aiBase" type="text" spellcheck="false" placeholder="https://api.deepseek.com/v1">
      </label>
      <label class="field"><span>模型</span>
        <input data-role="aiModel" type="text" spellcheck="false" placeholder="deepseek-chat">
      </label>
      <label class="field"><span>API Key</span>
        <input data-role="aiKey" type="password" spellcheck="false" autocomplete="off" placeholder="sk-…">
      </label>
      <label class="field"><span>目标语言</span>
        <select data-role="aiTarget">
          <option value="zh-CN">简体中文</option>
          <option value="zh-TW">繁體中文</option>
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
        </select>
      </label>
      <label class="field field-check">
        <input data-role="aiSkip" type="checkbox">
        <span>跳过已有译文的句子</span>
      </label>
      <label class="field field-check">
        <input data-role="aiWhole" type="checkbox">
        <span>整片放进上下文（更准，更贵；需 64k+ 上下文模型）</span>
      </label>
      <div class="sheet-note" data-role="aiStatus">Key 只存在本机扩展存储里，只发给你填的接口。</div>
      <div class="sheet-actions">
        <button type="button" data-act="aiRun" data-role="aiRun">开始翻译</button>
        <button type="button" data-act="aiStop" data-role="aiStop">停止</button>
        <button type="button" class="ghost" data-act="aiForget">清除 Key</button>
      </div>
    </div>
  </section>
  <div class="toast" data-role="toast"></div>
</div>`;

  const els = {};
  const state = { open: false, width: 400 };
  let built = false;
  let rendered = [];
  /**
   * `start → 行节点`。AI 翻译逐批贴回时只改受影响的那几十行，
   * 而不是每批重建整张列表（1000 句 × 50 批 = 5 万次节点创建，长播客上会卡）。
   */
  const rowByStart = new Map();
  let activeIndex = -1;
  let follow = true;
  let rafId = 0;
  /** 上一次写进填充条的百分比（先比对再写，见 paint） */
  let lastFill = '';
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
  /** 「导入译文」用的隐藏 file input（内容脚本读不了本地路径，只能走它），懒建 */
  let importInput = null;
  /** 已经提示过「原文轨与导入时对不上」的那个视频 id（同一个视频只打扰一次） */
  let mismatchNotifiedFor = null;

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

    for (const role of [
      'panel', 'resize', 'title', 'sub', 'follow', 'fill', 'fill2', 'ja', 'zh', 'list', 'toast',
      'sheet', 'aiProvider', 'aiBase', 'aiModel', 'aiKey', 'aiTarget', 'aiSkip', 'aiWhole',
      'aiStatus', 'aiRun', 'aiStop',
    ]) {
      els[role] = shadow.querySelector(`[data-role="${role}"]`);
    }
    syncFollowButton();
    setupAiForm();

    // 宽度不在这里写死：列形态下它由 YouTube 的列给（见 applyPanelWidth）
    // 滚轮一滚就停止跟随（否则用户看不了别的句子），「回到当前句」负责把他带回来
    els.list.addEventListener('wheel', () => {
      setFollow(false);
    }, { passive: true });

    // 拖滚动条 / 触控板边缘滚动只发 scroll 不发 wheel（PLAN 013 登记的已知边界）。
    // 这里兜底：滚完之后当前行不在可视区内，就一样停止跟随，让「回到当前句」浮出来。
    // 不能无条件 setFollow(false) —— 跟随中的程序化滚动（highlight → scrollIntoView）
    // 也会发 scroll，而那时当前行是可见的，判据天然把它排除掉。
    els.list.addEventListener('scroll', () => {
      if (follow && !activeRowVisible()) setFollow(false);
    }, { passive: true });

    shadow.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') setOpen(false);
      else if (act === 'follow') onFollow();
      else if (act === 'clear') onClear();
      else if (act === 'importSrt') onImportSrt();
      else if (act === 'aiTranslate') openAiSheet();
      else if (act === 'aiClose') closeAiSheet();
      else if (act === 'aiRun') runAiTranslate().catch(() => {});
      else if (act === 'aiStop') stopAiTranslate();
      else if (act === 'aiForget') onForgetKey();
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
      // 点了某一句就跟着它走（用户手动挑了目标，跟随自然恢复）
      setFollow(true);
    });
    return li;
  }

  function renderAll() {
    const cues = track.getCues();
    els.list.textContent = '';
    rowByStart.clear();
    const frag = document.createDocumentFragment();
    for (const cue of cues) {
      const row = makeRow(cue);
      rowByStart.set(cue.start, row);
      frag.append(row);
    }
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
      rowByStart.clear();
      const frag = document.createDocumentFragment();
      for (const cue of cues) {
        const row = makeRow(cue);
        rowByStart.set(cue.start, row);
        frag.append(row);
      }
      els.list.append(frag);
      els.list.scrollTop = scrollTop;
    } else {
      const frag = document.createDocumentFragment();
      for (let i = rendered.length; i < cues.length; i += 1) {
        const row = makeRow(cues[i]);
        rowByStart.set(cues[i].start, row);
        frag.append(row);
      }
      els.list.append(frag);
    }

    rendered = cues.slice();
    activeIndex = -1;
    updateMeta();
  }

  /**
   * 把一行就地更新成 cue 的当前内容（不重建节点）。
   *
   * 结构固定是 `<li><span class=stamp><div><span class=ja>[<span class=zh>]</div></li>`，
   * 所以只改文本、必要时补一个 `.zh` —— 这样批量贴回时不会把用户正在滚动的位置
   * 连同节点一起换掉（换节点还会丢事件监听）。
   */
  function updateRow(row, cue) {
    const body = row && row.children ? row.children[1] : null;
    if (!body || !body.children) return;

    const jaText = cue.primary || '（无原文）';
    const ja = body.children[0];
    if (ja && ja.textContent !== jaText) ja.textContent = jaText;

    const zhText = cue.secondary || '';
    const zh = body.children[1];
    if (zh) {
      if (zh.textContent !== zhText) zh.textContent = zhText;
      return;
    }
    if (!zhText) return;

    const node = document.createElement('span');
    node.className = 'zh';
    node.textContent = zhText;
    body.append(node);
  }

  /**
   * 只刷新这些 `start` 对应的行（AI 翻译每批回帖时用）。
   *
   * 旧实现是每批 `renderAll()`：1000 句的轨道上，50 批就是 5 万次节点创建/销毁，
   * 全程同步，长播客上肉眼可见卡顿，而且滚动位置只能「事后塞回去」。
   */
  function refreshRowsFor(starts) {
    if (!built) return;
    const targets = starts instanceof Set ? starts : new Set(starts || []);
    if (!targets.size) return;

    const scrollTop = els.list.scrollTop;
    let changed = false;
    for (const cue of track.getCues()) {
      if (!targets.has(cue.start)) continue;
      const row = rowByStart.get(cue.start);
      if (!row) continue;
      updateRow(row, cue);
      changed = true;
    }
    if (!changed) return;
    // 补上译文可能让某一行变高：恢复一次位置，避免用户视线被顶走
    if (els.list.scrollTop !== scrollTop) els.list.scrollTop = scrollTop;
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

    // 导入过译文、但现在的原文轨跟导入时对不上（PLAN 031 第 4 条）：只提示一次，
    // 不做任何自动失效 —— 用户的口径是「默认没变，不对再自己重新导一次」。
    const id = meta?.id || '';
    if (meta?.importMismatch && mismatchNotifiedFor !== id) {
      mismatchNotifiedFor = id;
      toast('原文字幕与导入译文时不同，可能有对不上的句子');
    }
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
    // 每帧一次：句内进度在 60fps 下大量重复，值没变就别碰样式（免得白白重绘）
    const percent = `${track.getProgress() * 100}%`;
    if (percent !== lastFill) {
      lastFill = percent;
      els.fill.style.width = percent;
      els.fill2.style.width = percent;
    }

    const ja = cur ? cur.primary : '';
    const zh = cur ? cur.secondary : '';
    if (els.ja.textContent !== ja) els.ja.textContent = ja;
    if (els.zh.textContent !== zh) els.zh.textContent = zh;

    highlight(cur ? cur.index : -1);
  }

  /**
   * 当前句那一行是否完整落在列表的可视区内。
   *
   * 用 getBoundingClientRect 而不是 offsetTop：真 DOM 里 list 的 offsetParent 不一定是
   * 它自己（可能是 .panel），拿 offsetTop 比会算错。
   * 桩件（Node 冒烟测试）没有这个方法时返回 true —— 宁可不动跟随，也不要误关。
   */
  function activeRowVisible() {
    if (activeIndex < 0) return true;
    const row = els.list.children[activeIndex];
    if (!row) return true;
    const list = els.list;
    if (typeof list.getBoundingClientRect !== 'function'
      || typeof row.getBoundingClientRect !== 'function') return true;

    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // 容差 2px：贴着边缘那一行仍然算「看得见」，否则会在边界上反复开关
    return rowRect.top >= listRect.top - 2 && rowRect.bottom <= listRect.bottom + 2;
  }

  /**
   * 跟随开关。
   *
   * 关：滚轮、滚动条（当前行滚出可视区）。开：点某一句、点「回到当前句」。
   * 按钮状态跟着它走（先比对再写，见 AGENTS.md §3 的幂等规矩）。
   */
  function setFollow(value) {
    if (follow === value) return;
    follow = value;
    syncFollowButton();
  }

  function syncFollowButton() {
    // 只看按钮在不在，不看 built —— buildPanel 是在 built 置位**之前**调它的
    if (!els.follow) return;
    const next = follow ? 'off' : 'on';
    if (els.follow.dataset.state !== next) els.follow.dataset.state = next;
  }

  /**
   * 回到正在播放的那一句。
   *
   * 用户实测反馈：「整条字幕都展示了，但滚动之后很难定位到正在播放的位置」。
   * 滚轮一滚跟随就关了（不然看不了别的句子），而恢复跟随原先只有「点某一行」这一条路 ——
   * 那恰恰要求用户先自己找到当前句。这里给一个直达入口：滚过去 + 恢复跟随。
   */
  function onFollow() {
    setFollow(true);

    const cur = track.getCurrent();
    if (!cur) {
      toast('还没有正在播放的句子');
      return;
    }
    // 强制重画一次高亮：index 与 activeIndex 相同的话 highlight 会提前返回，就不会滚动
    activeIndex = -1;
    highlight(cur.index, { center: true });
  }

  function highlight(index, { center = false } = {}) {
    if (index === activeIndex && !center) return;

    const prev = els.list.querySelector('.row.is-active');
    if (prev) prev.classList.remove('is-active');

    activeIndex = index;
    if (index < 0) return;

    const row = els.list.children[index];
    if (!row) return;
    row.classList.add('is-active');
    // 通常跟随时用 nearest（不打断阅读）；用户按「回到当前句」是要「看清楚在哪」，
    // 那一下把它居中。
    if (center || follow) row.scrollIntoView({ block: center ? 'center' : 'nearest' });
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

  /**
   * `sourceOnly`：只导原文（PLAN 031）。
   *
   * 默认的「双语 SRT」一旦某几句已经被官方翻过，导出来就是「有的两行、有的一行」的
   * 混合文件 —— 喂给翻译工具会乱。所以离线翻译工作流要先走这个口子拿一份干净的单语文件。
   * 原文为空的句子（只采到译文的那些）在 sourceOnly 下没有意义，直接不导出。
   */
  function toSrt(snap, options = {}) {
    const list = options && options.sourceOnly
      ? snap.cues.filter((cue) => cue.primary)
      : snap.cues;
    return list
      .map((cue, i) => {
        const start = Math.max(0, cue.start || 0);
        const end = Math.max(start + 0.5, cue.end || start + 3);
        const text = options && options.sourceOnly
          ? cue.primary
          : [cue.primary, cue.secondary].filter(Boolean).join('\n');
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
    if (kind === 'srtSrc') {
      // 离线翻译工作流的第 1 步（PLAN 031）：干净的单语原文，喂给翻译工具
      const lines = toSrt(snap, { sourceOnly: true });
      const count = snap.cues.filter((cue) => cue.primary).length;
      if (!count) {
        toast('这条轨道上还没有原文');
        return;
      }
      download(`${baseName(snap)}.ja.srt`, lines, 'application/x-subrip;charset=utf-8');
      toast(`已导出 ${count} 句原文，翻好后用「导入译文」贴回来`);
      return;
    }
    if (kind === 'copy') {
      navigator.clipboard
        .writeText(toMarkdown(snap))
        .then(() => toast('Markdown 已复制，直接粘进 Obsidian'))
        .catch(() => toast('复制失败，改用「导出 Markdown」'));
    }
  }

  // ---------------------------------------------------------------- 导入译文（PLAN 031）

  /**
   * 打开文件选择框。
   *
   * 内容脚本拿不到本地文件路径（没有 file:// 权限，也不该有），所以只能走
   * `<input type="file">` —— 用户点一下、选文件，我们在 change 里读。
   * 每次用完把 `value` 清掉，否则同一个文件再选一次不会触发 change。
   */
  function onImportSrt() {
    // 从设置面板进来时面板可能还关着：先把面板打开（贴回结果总得有地方看）
    if (!built) setOpen(true);
    if (!importInput) {
      importInput = document.createElement('input');
      importInput.type = 'file';
      importInput.accept = '.srt';
      importInput.style.display = 'none';
      importInput.addEventListener('change', () => {
        const file = importInput.files && importInput.files[0];
        importInput.value = '';
        if (file) readTranslations(file).catch(() => {});
      });
      document.body.append(importInput);
    }
    importInput.click();
  }

  /** 读文件 → 解析 → 排贴回计划 → 交给轨道 → 如实报数 */
  async function readTranslations(file) {
    const srt = globalThis.__llgModSrt;
    if (!srt || typeof srt.parseSrt !== 'function') {
      toast('SRT 模块未加载（检查 src/mod 的注入顺序）');
      return;
    }
    try {
      const parsed = srt.parseSrt(await file.text());
      if (!parsed.length) {
        toast('这个文件里没解析出一句字幕（只吃 SRT）');
        return;
      }

      // 计划排的是「当前导出用的那条轨道」（end 已补齐），与 applyTranslations 匹配的是同一批 start
      const plan = srt.planImport(track.getCuesForExport(), parsed);
      const result = await track.applyTranslations(plan.assignments);

      const notes = [`已贴 ${result.applied} / ${parsed.length} 句`];
      if (plan.missed.length) notes.push(`${plan.missed.length} 句对不上时间轴`);
      if (result.applied && track.getMeta()?.importMismatch) {
        notes.push('但原文轨与导入时不一致，可能有对错的句子');
      }
      toast(notes.join('，'));

      if (built && result.applied) renderAll();
    } catch (err) {
      toast(`导入失败：${(err && err.message) || err}`);
    }
  }

  // ---------------------------------------------------------------- AI 翻译（PLAN 034）

  const AI_STORE_KEY = 'llgAiTranslate';

  /** 已保存的配置；null = 还没从 storage 读到（此时表单按默认值渲染） */
  let aiConfig = null;
  let aiRunning = false;
  /** 当前这一轮的取消句柄；null = 没在跑 */
  let aiAbort = null;
  /** 输入落盘的防抖计时器（别每敲一个字符写一次 storage） */
  let aiSaveTimer = 0;
  /** 最近一次失败的可读原因（汇总时带上，否则用户只看到一个干巴巴的失败句数） */
  let aiLastError = '';
  /**
   * 一段失败后最多拆几次半。
   *
   * 20 句 → 10 句 → 5 句：再往下拆就变成「一句一个请求」，慢且浪费额度；
   * 拆到 5 句仍失败通常就是接口本身的问题（额度、模型名、CORS），再拆也没用。
   */
  const AI_SPLIT_DEPTH = 2;
  /**
   * 前后文取多少行（真正生效的上限是 06-ai-translate.js 里的**字数**：
   * 3000 字前文 / 600 字后文）。这里只是给 slice 一个上界，免得为超长轨道
   * 复制出一个巨大的数组 —— 字幕长短差异太大，按行数封顶不可靠。
   */
  const CONTEXT_BEFORE_LINES = 200;
  const CONTEXT_AFTER_LINES = 20;
  /** 少于这么多句就不做「全片语境」预处理：短片没什么可归纳的，白花一次请求 */
  const BRIEF_MIN_CUES = 30;
  /**
   * 单个请求的上限。
   *
   * 没有它时，模型/网络挂住只能靠用户点「停止」——而一旦挂住，`aiRunning` 会一直是
   * true，按钮永久 disabled，用户只能刷新页面（刷新会丢掉这一轮的进度文案）。
   * 120s 足够长播客的一段 20 句（实测长句批次 10~30s），又不至于让人一直等。
   */
  const AI_TIMEOUT_MS = 120000;

  function aiModule() {
    return globalThis.__llgModAiTranslate || null;
  }

  /** 与 `10-subtitle-track.js` 的 `IMPORT_START_TOLERANCE` 同值：贴回只认零偏差 */
  const AI_START_TOLERANCE = 0.05;

  /** 原文归一化（只用来做兜底匹配，和轨道内部的比较口径一致） */
  function sourceKey(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
  }

  /**
   * 排一批译文该贴到哪几句。
   *
   * 主判据仍是 `start`（轨道的句号）：正常情况下它与批次里的 start 是同一个数。
   * 但轨道会在翻译期间被重建（换视频、官方重新断句后 `adoptSkeleton` 整条替换），
   * 那时 start 全变、原文却还在 —— 所以补一条**唯一文本**兜底：
   * 同一段原文在轨道里出现两次以上就放弃，贴错一句比少贴一句更糟。
   *
   * @param {Array<{start: number, text: string}>} items
   * @param {string[]} lines 与本批等长的译文
   * @returns {{assignments: Array<{start: number, secondary: string}>, unresolved: number[]}}
   */
  function resolveAssignments(items, lines) {
    const current = track.getCues();
    const byText = new Map();
    for (const cue of current) {
      const key = sourceKey(cue && cue.primary);
      if (!key) continue;
      // 重复原文（「はい」这种）置 null：不唯一就不可信
      byText.set(key, byText.has(key) ? null : cue);
    }

    const assignments = [];
    const unresolved = [];
    const used = new Set();
    items.forEach((item, index) => {
      const start = Number(item.start);
      const key = sourceKey(item.text);

      let direct = null;
      let bestGap = Infinity;
      for (const cue of current) {
        const gap = Math.abs(Number(cue && cue.start) - start);
        if (!Number.isFinite(gap) || gap > AI_START_TOLERANCE) continue;
        if (gap < bestGap) {
          bestGap = gap;
          direct = cue;
        }
      }
      const textMatch = byText.get(key) || null;

      // 优先用「start 命中且原文也对得上」的那句；start 撞上了别的句子（轨道整体
      // 平移后常见）时，以唯一原文为准，别把译文贴到隔壁句上。
      let matched = null;
      if (direct && (direct === textMatch || sourceKey(direct.primary) === key)) {
        matched = direct;
      } else if (textMatch && !used.has(textMatch)) {
        matched = textMatch;
      } else if (direct) {
        matched = direct;
      }

      if (!matched || used.has(matched)) {
        unresolved.push(index);
        return;
      }
      used.add(matched);
      assignments.push({ start: Number(matched.start), secondary: lines[index] });
    });

    return { assignments, unresolved };
  }

  /** 表单 → 归一后的配置；AI 模块没加载时返回 null（调用方负责提示） */
  function readAiForm() {
    const ai = aiModule();
    if (!ai || !els.aiProvider) return null;
    return ai.normalizeConfig({
      provider: els.aiProvider.value,
      baseUrl: els.aiBase.value,
      model: els.aiModel.value,
      key: els.aiKey.value,
      target: els.aiTarget.value,
      skipExisting: !!els.aiSkip.checked,
      wholeContext: !!els.aiWhole.checked,
    });
  }

  /** 配置 → 表单。Key 会回填（是本机扩展存储，不是页面存储），输入框本身是 password。 */
  function fillAiForm(cfg) {
    if (!els.aiProvider || !cfg) return;
    els.aiProvider.value = cfg.provider;
    els.aiBase.value = cfg.baseUrl;
    els.aiModel.value = cfg.model;
    els.aiKey.value = cfg.key;
    els.aiTarget.value = cfg.target;
    els.aiSkip.checked = cfg.skipExisting === true;
    els.aiWhole.checked = cfg.wholeContext === true;
    setAiStatus(aiStatusNote(cfg));
  }

  function setAiStatus(message) {
    if (!els.aiStatus) return;
    const next = String(message ?? '');
    // 先比对再写：这一层在 shadowRoot 里，而我们对 shadowRoot 挂着 MutationObserver
    if (els.aiStatus.textContent !== next) els.aiStatus.textContent = next;
  }

  /**
   * 接口地址的安全提示。
   *
   * Key 明文存在扩展存储里，请求时随 `Authorization` 头发出去；不是 https 就意味着
   * 它在链路上是明文。用户自己填的自定义地址我们拦不住，但必须让他在**填的时候**
   * 看见，而不是只写在 README 里。
   */
  function endpointWarning(baseUrl) {
    const value = String(baseUrl || '').trim();
    if (!value) return '';
    if (/^https:\/\//i.test(value)) return '';
    let host = '';
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      return '接口地址不合法，请检查（需要 http(s):// 开头）。';
    }
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return '';
    return '注意：接口不是 https，API Key 会以明文经过网络。';
  }

  /** 没在跑时状态行的默认文案（配置回填 / 防抖保存后调用） */
  function aiStatusNote(cfg) {
    const warning = endpointWarning(cfg && cfg.baseUrl);
    if (warning) return warning;
    return cfg && cfg.key ? 'Key 已保存在本机。' : '填好 API Key 就能开始。';
  }

  function syncAiButtons() {
    if (els.aiRun) els.aiRun.disabled = aiRunning;
    if (els.aiStop) els.aiStop.disabled = !aiRunning;
    if (els.sheet) els.sheet.dataset.running = aiRunning ? '1' : '0';
  }

  function scheduleAiSave() {
    clearTimeout(aiSaveTimer);
    aiSaveTimer = setTimeout(() => {
      const cfg = readAiForm();
      if (!cfg) return;
      aiConfig = cfg;
      chrome.storage.local.set({ [AI_STORE_KEY]: cfg }).catch(() => {});
      // 翻译进行中不碰状态行：那里正在显示进度，改配置不该把它盖掉
      if (!aiRunning) setAiStatus(aiStatusNote(cfg));
    }, 400);
  }

  /** 切服务商时把预设的地址与模型填进去，用户只补 Key */
  function applyAiPreset() {
    const ai = aiModule();
    if (!ai) return;
    const found = ai.PROVIDERS.find((item) => item.id === els.aiProvider.value);
    if (!found) return;
    if (found.baseUrl) els.aiBase.value = found.baseUrl;
    if (found.model) els.aiModel.value = found.model;
  }

  function setupAiForm() {
    if (!els.aiProvider) return;
    for (const role of ['aiProvider', 'aiBase', 'aiModel', 'aiKey', 'aiTarget', 'aiSkip', 'aiWhole']) {
      const node = els[role];
      if (!node || typeof node.addEventListener !== 'function') continue;
      node.addEventListener('change', scheduleAiSave);
      node.addEventListener('input', scheduleAiSave);
    }
    els.aiProvider.addEventListener('change', applyAiPreset);
    syncAiButtons();
  }

  function openAiSheet() {
    // 从设置面板进来时面板可能还没建过、也可能被关着：设置层得有地方显示
    if (!state.open) setOpen(true);
    if (!els.sheet) return;
    const ai = aiModule();
    if (!ai) {
      toast('AI 翻译模块未加载（检查 src/mod 的注入顺序）');
      return;
    }
    if (!aiRunning) fillAiForm(aiConfig || ai.normalizeConfig(null));
    els.sheet.dataset.state = 'open';
    syncAiButtons();
  }

  function closeAiSheet() {
    if (!els.sheet) return;
    els.sheet.dataset.state = 'closed';
    // 关的时候**立刻**落盘，不走防抖：不然用户关掉又马上打开，会读到上一次的旧配置
    clearTimeout(aiSaveTimer);
    const cfg = readAiForm();
    if (cfg) {
      aiConfig = cfg;
      chrome.storage.local.set({ [AI_STORE_KEY]: cfg }).catch(() => {});
    }
  }

  function stopAiTranslate() {
    if (!aiAbort) return;
    setAiStatus('正在停止…（当前这一批请求会被中断）');
    aiAbort.abort();
  }

  function onForgetKey() {
    if (els.aiKey) els.aiKey.value = '';
    const cfg = readAiForm();
    if (cfg) {
      aiConfig = cfg;
      chrome.storage.local.set({ [AI_STORE_KEY]: cfg }).catch(() => {});
    }
    setAiStatus('已清除本机保存的 Key。');
  }

  /** 网络层错误说人话：CORS 与「地址填错」在 fetch 里都只有一个 TypeError */
  function describeFetchError(err) {
    if (err && err.name === 'AbortError') return '已停止。';
    if (err && err.name === 'TimeoutError') {
      return `请求超时（${Math.round(AI_TIMEOUT_MS / 1000)} 秒没有返回）`;
    }
    if (err instanceof TypeError) {
      return '连不上接口：可能是地址填错，或该接口不允许浏览器直连（CORS）。';
    }
    return `请求失败：${(err && err.message) || err}`;
  }

  /**
   * 本次请求的取消信号：用户点的「停止」与超时合并。
   *
   * `AbortSignal.any` 是 Chrome 116+（本仓库的目标运行时正好是这个下限）；
   * 拿不到就只用其中能拿到的那一个 —— 宁可少了手动停止，也不能没有超时。
   */
  function abortSignal() {
    const user = aiAbort ? aiAbort.signal : null;
    const timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(AI_TIMEOUT_MS)
      : null;
    if (user && timeout && typeof AbortSignal.any === 'function') {
      try {
        return AbortSignal.any([user, timeout]);
      } catch {
        return user;
      }
    }
    return user || timeout || undefined;
  }

  /**
   * 非 2xx 时取一句可读的原因（OpenAI 兼容接口都在 error.message 里）。
   *
   * ⚠️ 必须**先 text() 再 JSON.parse**：body 只能读一次，先 `res.json()` 失败时
   * 流已经被消费，再 `res.text()` 只会抛 "body used already"，于是 502 / 限流页 /
   * 代理返回的 HTML 全部变成一句干巴巴的「接口返回 502」。
   */
  async function readErrorText(res) {
    let raw = '';
    try {
      raw = await res.text();
    } catch {
      return '';
    }
    const body = String(raw || '').trim();
    if (!body) return '';
    try {
      const data = JSON.parse(body);
      const message = data && data.error && data.error.message;
      if (message) return String(message).slice(0, 160);
    } catch {
      // 不是 JSON：按原文截断，至少让用户看见「502 Bad Gateway」那一行
    }
    return body.replace(/\s+/g, ' ').slice(0, 160);
  }

  /**
   * 发一批。
   *
   * 成功返回等长译文数组；任何失败返回 null（由调用方决定重试 / 跳过并计数）。
   * 不在这里 toast：一批失败不该弹一次气泡，进度行 + 最终汇总就够了。
   */
  async function translateBatch(ai, cfg, url, texts, context, options = {}, whole = null) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: whole
            ? ai.buildWholeMessages(whole.lines, cfg.target, whole.from, whole.to, context)
            : ai.buildMessages(texts, cfg.target, context, options),
          temperature: 0.2,
          stream: false,
        }),
        signal: abortSignal(),
      });

      if (!res.ok) {
        // 只能读一次 body：先把原因取出来再拼，别在模板里调用两次
        const detail = await readErrorText(res);
        aiLastError = `接口返回 ${res.status}${detail ? `：${detail}` : ''}`;
        setAiStatus(aiLastError);
        return null;
      }

      const data = await res.json();
      const content = data && data.choices && data.choices[0]
        && data.choices[0].message && data.choices[0].message.content;
      const parsed = ai.parseTranslationContent(content, texts.length);
      if (!parsed.ok) {
        aiLastError = parsed.reason;
        // 留一份响应片段到控制台：判断「是不是被截断」只有看原文才准，面板里放不下
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`[llg-ai] 返回不可用：${parsed.reason}；片段：${String(content ?? '').slice(0, 240)}`);
        }
        setAiStatus(`这一段返回不可用（${parsed.reason}）`);
        return null;
      }
      return parsed.lines;
    } catch (err) {
      aiLastError = describeFetchError(err);
      setAiStatus(aiLastError);
      return null;
    }
  }

  /**
   * 全片语境预处理（PLAN 034 追加）。
   *
   * 花一次请求把整片读一遍，产出一份短摘要（术语译法、说话人、语气）。
   * **失败不阻塞翻译**：拿不到摘要就按无摘要继续，最多是术语一致性差一点。
   */
  async function requestContextBrief(ai, cfg, url, lines) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.key}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: ai.buildBriefMessages(lines, cfg.target),
          temperature: 0.2,
          stream: false,
        }),
        signal: abortSignal(),
      });

      if (!res.ok) {
        const detail = await readErrorText(res);
        aiLastError = `语境整理：接口返回 ${res.status}${detail ? `：${detail}` : ''}`;
        return '';
      }

      const data = await res.json();
      const content = data && data.choices && data.choices[0]
        && data.choices[0].message && data.choices[0].message.content;
      return String(content || '').trim().slice(0, ai.BRIEF_RESPONSE_CHARS);
    } catch (err) {
      if (!(err && err.name === 'AbortError')) aiLastError = describeFetchError(err);
      return '';
    }
  }

  /**
   * 逐批翻译。
   *
   * 每批回来立刻 `applyTranslations` 落盘 —— 中途停止 / 网络断了，已经翻好的部分不丢，
   * 而且 `origin='imported'` 让官方采样不会把我们的译文盖掉（与 PLAN 031 同一套优先级）。
   */
  async function runAiTranslate() {
    if (aiRunning) return;
    const ai = aiModule();
    if (!ai) {
      toast('AI 翻译模块未加载（检查 src/mod 的注入顺序）');
      return;
    }

    const cfg = readAiForm();
    if (!cfg) return;
    if (!cfg.key) {
      setAiStatus('先填 API Key。');
      toast('先填 API Key');
      return;
    }
    const url = ai.chatUrl(cfg.baseUrl);
    if (!url) {
      setAiStatus('接口地址不能为空。');
      return;
    }
    if (!cfg.model) {
      setAiStatus('模型不能为空。');
      return;
    }

    const cues = track.getCuesForExport().filter((cue) => cue.primary
      && !(cfg.skipExisting && cue.secondary));
    if (!cues.length) {
      setAiStatus(cfg.skipExisting ? '没有待翻译的句子（都已有译文）。' : '这条轨道上还没有原文。');
      return;
    }

    const batches = ai.planBatches(cues);
    const total = batches.reduce((sum, batch) => sum + batch.items.length, 0);
    // 轨道可能在翻译期间被重建（换视频 / 官方重新断句），结束时用指纹交代一句，
    // 否则「贴不上」只会被读成「模型没翻」。
    const srtApi = globalThis.__llgModSrt;
    const startStamp = srtApi && typeof srtApi.fingerprint === 'function'
      ? srtApi.fingerprint(track.getCues())
      : null;

    aiRunning = true;
    aiAbort = typeof AbortController === 'function' ? new AbortController() : null;
    aiConfig = cfg;
    chrome.storage.local.set({ [AI_STORE_KEY]: cfg }).catch(() => {});
    syncAiButtons();

    let applied = 0;
    let failed = 0;
    let missedAxis = 0;
    let stopped = false;
    /**
     * 这一轮是否改用「编号对象」输出。
     *
     * 第一次出现「条数不符」就置真，后面的段从一开始就用编号格式 —— 同一部片子、
     * 同一个模型，会合并相邻条的地方往往会反复合并（半句话多、口语碎片多），
     * 每段都先失败一次再换格式就太浪费了。
     */
    let preferIndexed = false;
    /** 失败段落最后一次的可读原因（拆半重试期间会被覆盖，取最后一次即可） */
    let lastReason = '';

    // 队列初始就是切好的批；某一段反复失败时会在它后面**插入**两个半段，
    // 所以进度文案用「已贴 x / total 句」而不是「第几批」—— 段数是会变的。
    const queue = batches.map((batch) => ({ items: batch.items, depth: 0 }));

    // 每段都带上原文窗口当参考：字幕是碎片，单看一条连「丸ハラ」这种缩写
    // 都只能硬音译（实测被译成「丸原」）。拆半之后 items 仍是原顺序里的连续切片，
    // 所以用「首句在全量列表里的下标 + 段长」就能算出前后文。
    const videoTitle = (track.getMeta() && track.getMeta().title) || '';
    const orderIndex = new Map();
    cues.forEach((cue, index) => {
      if (!orderIndex.has(cue.start)) orderIndex.set(cue.start, index);
    });
    /** 全片语境摘要（下面预处理得到；空串 = 没做或失败，按无摘要翻译） */
    let brief = '';
    const contextFor = (job) => {
      const first = orderIndex.has(job.items[0].start) ? orderIndex.get(job.items[0].start) : -1;
      if (first < 0) return { title: videoTitle, brief };
      const afterFrom = first + job.items.length;
      return {
        title: videoTitle,
        brief,
        before: cues.slice(Math.max(0, first - CONTEXT_BEFORE_LINES), first).map((cue) => cue.primary),
        after: cues.slice(afterFrom, afterFrom + CONTEXT_AFTER_LINES).map((cue) => cue.primary),
        // 整片模式用 1 起算的条号，和请求里「键是条号」的对象对齐
        from: first + 1,
        to: first + job.items.length,
      };
    };

    // 整片上下文模式：把全片原文随每条请求一起发（输出仍是 20 条）。
    // 超过字数上限就退回分段 —— 8k 模型硬塞只会 400。
    const allTexts = cues.map((cue) => cue.primary);
    const wholeChars = allTexts.reduce((sum, item) => sum + item.length, 0);
    let wholeMode = cfg.wholeContext === true && wholeChars <= ai.WHOLE_MAX_CHARS;
    if (cfg.wholeContext && !wholeMode) {
      setAiStatus(`整片约 ${wholeChars} 字，超过 ${ai.WHOLE_MAX_CHARS} 字上限，改用分段上下文…`);
    }

    try {
      if (wholeMode) setAiStatus(`整片上下文模式（约 ${wholeChars} 字/次）…`);

      // 先读整片、再逐段翻：整片的主题与术语只能从全量里看出来，分段永远补不齐。
      // 阈值以下不做 —— 短片没有可归纳的东西，白花一次请求与等待。
      // 整片模式已经每次都带全片原文，再整理一次摘要纯属浪费，直接跳过。
      if (!wholeMode && cues.length >= BRIEF_MIN_CUES) {
        setAiStatus(`整理全片语境…（${cues.length} 句）`);
        brief = await requestContextBrief(ai, cfg, url, cues.map((cue) => cue.primary));
        if (brief) setAiStatus(`语境已整理（${brief.length} 字），开始逐段翻译…`);
        else if (!(aiAbort && aiAbort.signal.aborted)) {
          setAiStatus('语境整理没拿到结果，直接开始逐段翻译…');
        }
      }

      for (let index = 0; index < queue.length; index += 1) {
        const aborted = () => aiAbort && aiAbort.signal.aborted;
        if (aborted()) {
          stopped = true;
          break;
        }

        const job = queue[index];
        const texts = job.items.map((item) => item.text);
        const context = contextFor(job);
        setAiStatus(`翻译中… 已贴 ${applied} / ${total} 句（第 ${index + 1}/${queue.length} 段）`);

        const whole = wholeMode && context.from
          ? { lines: allTexts, from: context.from, to: context.to }
          : null;
        let lines = await translateBatch(ai, cfg, url, texts, context, { indexed: preferIndexed }, whole);
        // 单段失败重试一次。
        // 「条数不符」多半是模型把相邻两条合并了（字幕本身就是半句话），数组格式下
        // 根本看不出少了哪条；重试改成带编号的 JSON 对象，逼它逐号输出。
        if (!lines && !aborted()) {
          const countIssue = aiLastError.includes('条数不符');
          if (countIssue) preferIndexed = true;

          if (whole && countIssue) {
            // 「条数不符」是模型把相邻两句合并了，与上下文长度无关：先留在整片模式下
            // 换编号对象重试。一次格式问题就连累后面所有段退回分段，等于用户为「整片」
            // 付了输入成本却只享受到第一段。
            setAiStatus(`这一段条数不对（${aiLastError}），改用编号格式在整片模式下重试一次…`);
            lines = await translateBatch(ai, cfg, url, texts, context, { indexed: true }, whole);
          }

          if (!lines && !aborted()) {
            if (whole) {
              // 上下文超限（8k 模型会直接 400）或整片重试仍失败 —— 本轮退回分段，
              // 别拿着同一堵墙反复撞。
              wholeMode = false;
              setAiStatus(`整片上下文不可用（${aiLastError}），本轮改用分段上下文…`);
            } else {
              setAiStatus(countIssue
                ? `这一段条数不对（${aiLastError}），改用编号格式重试一次…`
                : `这一段没拿到可用结果（${aiLastError}），重试一次…`);
            }
            lines = await translateBatch(ai, cfg, url, texts, context, {
              indexed: countIssue || preferIndexed,
            }, null);
          }
        }

        if (!lines) {
          lastReason = aiLastError;
          if (aborted()) {
            stopped = true;
            break;
          }
          // 仍然失败：多半是「输出被截断」或「模型合并了句子」，把这段拆成两半再试，
          // 直到 AI_SPLIT_DEPTH 用完 —— 把「整段报废」降级成「只丢少数几句」。
          if (job.items.length > 1 && job.depth < AI_SPLIT_DEPTH) {
            const mid = Math.ceil(job.items.length / 2);
            queue.splice(
              index + 1,
              0,
              { items: job.items.slice(0, mid), depth: job.depth + 1 },
              { items: job.items.slice(mid), depth: job.depth + 1 },
            );
            setAiStatus(`第 ${index + 1} 段失败（${aiLastError}），拆成两半重试…`);
            continue;
          }
          failed += job.items.length;
          continue;
        }

        const plan = resolveAssignments(job.items, lines);
        const result = await track.applyTranslations(plan.assignments);
        applied += result.applied;
        const missed = (plan.assignments.length - result.applied) + plan.unresolved.length;
        failed += missed;
        missedAxis += missed;
        // 贴不上的真实原因是「轨道上找不到这一句」，不是更早那次解析失败 ——
        // 不更新的话，用户看到的「最近一次原因」会是一句陈旧的误导信息。
        if (missed) lastReason = '轨道上找不到对应原文（可能换视频或官方重新断句了）';
        // 只刷新这一批贴到的行（见 refreshRowsFor 的注释：旧实现是整表重建）
        refreshRowsFor(plan.assignments.map((item) => item.start));
      }
    } finally {
      aiRunning = false;
      aiAbort = null;
      syncAiButtons();
    }

    const notes = [`已贴 ${applied} / ${total} 句`];
    if (failed) notes.push(`${failed} 句没翻成`);
    if (missedAxis) notes.push(`其中 ${missedAxis} 句没贴到轨道上`);
    const endStamp = srtApi && typeof srtApi.fingerprint === 'function'
      ? srtApi.fingerprint(track.getCues())
      : null;
    if (missedAxis && startStamp && endStamp
      && typeof srtApi.sameFingerprint === 'function'
      && !srtApi.sameFingerprint(startStamp, endStamp)) {
      notes.push('原文轨在翻译期间变了（换视频或官方重新断句），贴不上的句子重翻一次即可');
    }
    if (stopped) notes.push('已停止');
    if (failed && lastReason && !stopped) notes.push(`最近一次原因：${lastReason}`);
    const summary = notes.join('，');
    setAiStatus(summary);
    toast(summary);
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
        id: 'exportSrtSource',
        title: '导出原文 SRT（离线翻译用）',
        icon: `
<svg class="nav-row__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="6" width="18" height="12" rx="2"/>
  <path d="M7 12h8"/><path d="M12 9l3 3-3 3"/>
</svg>`,
        run: () => onExport('srtSrc'),
      },
      {
        id: 'importTranslation',
        title: '导入译文 SRT',
        icon: `
<svg class="nav-row__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="6" width="18" height="12" rx="2"/>
  <path d="M17 12h-8"/><path d="M12 9l-3 3 3 3"/>
</svg>`,
        value: () => {
          const imported = track.getCues().filter((cue) => cue.origin === 'imported').length;
          return imported ? `${imported} 句` : '';
        },
        run: () => onImportSrt(),
      },
      {
        id: 'aiTranslate',
        title: 'AI 翻译（用自己的 API Key）',
        icon: `
<svg class="nav-row__ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 7h10"/><path d="M9 4v3"/><path d="M6 7c1 4 3 6 6 7"/>
  <path d="M13 20l4-9 4 9"/><path d="M14.5 17h5"/>
</svg>`,
        value: () => {
          const cues = track.getCues();
          const done = cues.reduce((sum, cue) => sum + (cue.secondary ? 1 : 0), 0);
          return cues.length ? `${done}/${cues.length} 句` : '';
        },
        run: () => openAiSheet(),
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

  // AI 翻译配置（PLAN 034）：与面板开关同一个键空间，但分开存 —— 换 Key 不该顺手
  // 把面板宽度那条记录一起重写。没读到就等打开设置层时按默认值渲染。
  chrome.storage.local
    .get(AI_STORE_KEY)
    .then((res) => {
      const ai = aiModule();
      aiConfig = ai ? ai.normalizeConfig(res && res[AI_STORE_KEY]) : null;
      // 设置层已经打开着（storage 读得慢于用户手速）就回填一次
      if (built && els.sheet && els.sheet.dataset.state === 'open' && !aiRunning) {
        fillAiForm(aiConfig);
      }
    })
    .catch(() => {});

  track.subscribe(() => {
    if (state.open && built) syncList();
  });

  document.addEventListener('yt-navigate-finish', () => {
    rendered = [];
    activeIndex = -1;
    // 换视频了，新视频的「原文轨对不上」要能再提示一次
    mismatchNotifiedFor = null;
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
  // 定时器挂在 00-shared.js 的共享心跳上（PLAN 025）：整页只留一个 1s 定时器
  shared.onTick(() => {
    refreshButton();
    // 列被 YouTube 重建之后宿主会掉出来，靠心跳把它挂回去
    syncMount();
    syncFullscreen();
    syncLayoutSignature();
  });
})();
