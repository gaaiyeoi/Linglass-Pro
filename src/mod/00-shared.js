/**
 * 共享设施：Linglass 风格的控制栏按钮
 *
 * Linglass 自己的播放器按钮是「ytp-button + 挂到 .ytp-right-controls + 内联布局样式
 * + data-tooltip-text 自绘气泡 + 开启时 #0A84FF」。这里把同一套做法固化成一个工厂，
 * 供桌面字幕浮窗和侧边学习面板共用，避免两份逐字重复的样式。
 *
 * 加载顺序：本文件以 00- 前缀命名，构建时会排在最前面（见 build.mjs 的 scanMod）。
 * 同一扩展的所有内容脚本共享一个 isolated world，所以直接挂全局量互相取用。
 *
 * 注意：布局用内联样式，不用纯 class —— YouTube 的 .ytp-button 规则与我们的
 * class 选择器同优先级，谁后加载谁生效，靠内联样式才能保证稳定；hover / 开启态
 * 这类伪类无法内联，用 !important 压过去（Linglass 自己也是这么做的）。
 */
(() => {
  'use strict';

  const NS = '__llgModShared';
  if (globalThis[NS]) return;

  /**
   * 清掉上一轮注入留在页面里的 DOM。
   *
   * 扩展被重载时（make dev 每次保存都会触发），上一轮的 content script 上下文连同它
   * 注册的所有监听器一起销毁，但它创建的 DOM 还留在页面里。不清掉的话，后面的
   * getElementById 会找到这些「僵尸元素」并且复用 —— 按钮在、面板在，但点了全都没反应。
   *
   * 本文件是 00- 前缀，最先执行，所以这里是唯一合适的清理点。
   */
  const STALE_IDS = [
    'llg-pip-btn',
    'llg-cast-btn',
    'llg-panel-btn',
    'llg-mod-control-styles',
    'llg-pip-btn-styles', // 早期版本的样式 id，一并清掉
    'llg-study-panel-root',
    // 40-study-panel.js 注入的页面级让位样式：重载后旧规则必须清掉，
    // 否则残留的 html[data-llg-panel] 规则会一直压着页面（面板已经没了）
    'llg-panel-layout-styles',
  ];
  for (const id of STALE_IDS) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  // ---------------------------------------------------------------- 设计令牌
  //
  // PLAN 047：全插件的视觉只有一套语言 —— **液态玻璃**。
  //
  // 之前每个渲染位置各写一份近似值（深色底有 #141518 / rgba(28,28,30,.92) /
  // rgba(22,22,24,.97) 三种，模糊有 8 / 20 / 20+saturate 三种，圆角有 8 / 9 / 10 / 12），
  // 放在一起看就是「不像同一个产品」。这里把玻璃的物理参数收敛成三档（清透 / 磨砂 /
  // 深邃），其余语义令牌（文字、强调色、圆角、间距、动效）也统一到一个来源。
  //
  // 消费方：
  //   · 30-desktop-subtitles.js 的浮窗 + 浮窗设置面板（tokensCss(':root')）
  //   · 40-study-panel.js 的学习面板（值对齐，见那边的注释）
  //   · tools/cast-page.mjs 的手机字幕屏（构建期拼同一份文本，但**不带模糊**）
  //
  // 为什么不直接引用官方 `--lg-*`：官方令牌定义在它自己的 shadow root 里，
  // `:host { all: initial }` 又会把自定义属性重置成初始值 —— 引用永远走兜底值。

  /** 玻璃三档：level 是给设置面板与存储用的稳定标识 */
  const GLASS_LEVELS = ['thin', 'regular', 'thick'];

  /** 每一档的物理参数（深色）。浅色覆盖见 tokensCss 的 media query */
  const GLASS = {
    thin: {
      bg: 'rgba(24, 24, 27, .60)',
      blur: 'blur(16px) saturate(160%)',
      shadow: '0 8px 24px rgba(0, 0, 0, .32)',
    },
    regular: {
      bg: 'rgba(19, 20, 24, .76)',
      blur: 'blur(28px) saturate(190%)',
      shadow: '0 12px 32px rgba(0, 0, 0, .42)',
    },
    thick: {
      bg: 'rgba(13, 14, 17, .91)',
      blur: 'blur(44px) saturate(220%)',
      shadow: '0 16px 40px rgba(0, 0, 0, .5)',
    },
  };

  /** 取一档玻璃的落盘值（脏值一律回落 regular） */
  function glassOf(level) {
    return GLASS_LEVELS.includes(level) ? level : 'regular';
  }

  /**
   * 生成 `--llg-*` 令牌块。
   * @param {string} selector 作用域（浏览器端用 ':root'，shadow 里用 ':host'）
   */
  function tokensCss(selector = ':root') {
    const glassVars = GLASS_LEVELS.map((level) => [
      `  --llg-glass-${level}: ${GLASS[level].bg};`,
      `  --llg-blur-${level}: ${GLASS[level].blur};`,
      `  --llg-shadow-${level}: ${GLASS[level].shadow};`,
    ].join('\n')).join('\n');

    return `${selector} {
${glassVars}
  --llg-sheen: inset 0 1px 0 rgba(255, 255, 255, .10);
  --llg-highlight: linear-gradient(135deg, rgba(255, 255, 255, .10) 0%, rgba(255, 255, 255, .02) 100%);
  --llg-hairline: rgba(255, 255, 255, .10);
  --llg-hairline-soft: rgba(255, 255, 255, .06);
  --llg-text-1: #F5F5F7;
  --llg-text-2: #A1A1A6;
  --llg-text-3: #7C7C82;
  --llg-text-4: #5E5E64;
  --llg-accent: #0A84FF;
  --llg-accent-soft: rgba(10, 132, 255, .14);
  --llg-accent-softer: rgba(10, 132, 255, .09);
  --llg-surface-1: rgba(255, 255, 255, .06);
  --llg-surface-2: rgba(255, 255, 255, .10);
  --llg-surface-3: rgba(255, 255, 255, .16);
  --llg-r-xs: 6px;
  --llg-r-sm: 8px;
  --llg-r-md: 12px;
  --llg-r-lg: 16px;
  --llg-r-pill: 999px;
  --llg-space-1: 4px;
  --llg-space-2: 8px;
  --llg-space-3: 12px;
  --llg-space-4: 16px;
  --llg-dur-fast: .15s;
  --llg-dur-base: .22s;
  --llg-dur-slow: .32s;
  --llg-ease: cubic-bezier(.22, .61, .36, 1);
  --llg-ease-out: cubic-bezier(0, 0, .2, 1);
  --llg-font: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, 'PingFang SC', sans-serif;
}

@media (prefers-color-scheme: light) {
  ${selector} {
    --llg-glass-thin: rgba(255, 255, 255, .62);
    --llg-glass-regular: rgba(250, 250, 252, .78);
    --llg-glass-thick: rgba(255, 255, 255, .92);
    --llg-sheen: inset 0 1px 0 rgba(255, 255, 255, .9);
    --llg-highlight: linear-gradient(135deg, rgba(255, 255, 255, .9) 0%, rgba(255, 255, 255, .55) 100%);
    --llg-hairline: rgba(0, 0, 0, .10);
    --llg-hairline-soft: rgba(0, 0, 0, .06);
    --llg-text-1: #1D1D1F;
    --llg-text-2: #636366;
    --llg-text-3: #7C7C82;
    --llg-text-4: #48484A;
    --llg-accent: #007AFF;
    --llg-accent-soft: rgba(0, 122, 255, .12);
    --llg-accent-softer: rgba(0, 122, 255, .08);
    --llg-surface-1: rgba(0, 0, 0, .04);
    --llg-surface-2: rgba(0, 0, 0, .07);
    --llg-surface-3: rgba(0, 0, 0, .12);
    --llg-shadow-thin: 0 8px 24px rgba(0, 0, 0, .12);
    --llg-shadow-regular: 0 12px 32px rgba(0, 0, 0, .16);
    --llg-shadow-thick: 0 16px 40px rgba(0, 0, 0, .2);
  }
}`;
  }

  /** 某一档玻璃的表面声明（背景 + 模糊 + 内高光） */
  function glassCss(level) {
    const name = glassOf(level);
    return `background: var(--llg-glass-${name});
  -webkit-backdrop-filter: var(--llg-blur-${name});
  backdrop-filter: var(--llg-blur-${name});
  box-shadow: var(--llg-shadow-${name}), var(--llg-sheen);`;
  }

  const STYLE_ID = 'llg-mod-control-styles';

  const CONTROL_CSS = `
.llg-mod-btn { position: relative; }
.llg-mod-btn:hover { opacity: 1 !important; }
.llg-mod-btn:focus-visible { outline: 2px solid #007AFF; outline-offset: -2px; border-radius: 4px; }
.llg-mod-btn[disabled] { opacity: .35 !important; cursor: default; }
.llg-mod-btn.is-on { color: #0A84FF !important; opacity: 1 !important; }
.llg-mod-btn.is-on:hover { color: #3391FF !important; }

.llg-mod-icon { width: 28px; height: 28px; pointer-events: none; }
.ytp-fullscreen .llg-mod-icon { width: 34px; height: 34px; }
.ytp-big-mode .llg-mod-icon { width: 32px; height: 32px; }

.llg-mod-btn::after {
  content: attr(data-tooltip-text);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(28, 25, 23, .9);
  color: #fff;
  font-size: 12px;
  font-family: 'YouTube Sans', 'Roboto', sans-serif;
  font-weight: 400;
  line-height: 1.4;
  padding: 4px 8px;
  border-radius: 4px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: opacity .15s ease, visibility .15s ease;
  pointer-events: none;
  z-index: 10000;
}
.llg-mod-btn:hover::after { opacity: 1; visibility: visible; }
`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CONTROL_CSS;
    document.head.append(style);
  }

  /** 与 Linglass 的 applyButtonStyles 逐条对齐 */
  function applyLayout(btn) {
    Object.assign(btn.style, {
      position: 'relative',
      width: '48px',
      height: '100%',
      padding: '0',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
      opacity: '0.9',
      color: '#fff',
      transition: 'opacity 0.1s ease, color 0.2s ease',
      outline: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
  }

  function createControlButton({ id, icon, onClick }) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.className = 'ytp-button llg-mod-btn';
    btn.innerHTML = icon;
    applyLayout(btn);
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      onClick();
    });
    return btn;
  }

  /** 把按钮插到目标位置：优先 afterId 之后，否则紧跟 Linglass 自己的按钮 */
  function place(controls, btn, afterId) {
    const after = afterId ? document.getElementById(afterId) : null;

    if (after && after.parentElement === controls) {
      if (after.nextSibling !== btn) controls.insertBefore(btn, after.nextSibling);
      return;
    }

    const anchor = controls.querySelector('.linglass-settings-btn');
    if (anchor && anchor.parentElement === controls) {
      const next = anchor.nextSibling;
      if (next !== btn || btn.parentElement !== controls) {
        controls.insertBefore(btn, next);
      }
      return;
    }

    if (btn.parentElement !== controls) controls.appendChild(btn);
  }

  /**
   * 确保按钮存在于控制栏。
   * @returns {boolean} false 表示控制栏还没出现，由调用方的心跳继续等
   */
  function ensureButton({ id, icon, afterId, onClick }) {
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return false;

    injectStyle();

    const existing = document.getElementById(id);
    const btn = existing ?? createControlButton({ id, icon, onClick });
    place(controls, btn, afterId);
    return true;
  }

  function setButtonState(id, { label, on, disabled } = {}) {
    const btn = document.getElementById(id);
    if (!btn) return;

    if (disabled !== undefined) btn.disabled = !!disabled;
    if (on !== undefined) btn.classList.toggle('is-on', !!on);
    if (label !== undefined) {
      btn.dataset.tooltipText = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
  }

  // ---------------------------------------------------------------- 共享心跳
  //
  // 起因（PLAN 025）：10/15/30/40/50 五个模块各挂了一个 `setInterval(fn, 1000)`，
  // 做的都是「一秒看一眼」：查一次轨道、补一次断句标记、对齐一次浮窗状态。
  // 没有哪一个需要独立的时间源，而一个标签页五个定时器、开五个标签页就是二十五个。
  //
  // 这里合成一个：注册进来的回调由同一次 tick 依次调用，于是本扩展在任意页面里
  // 只有一个常驻定时器。
  //
  // 刻意**不**做错峰：错峰要靠 setTimeout 串起来，而 Node 侧的冒烟测试是用
  // `h.tick()` 显式驱动这一个定时器的（真定时器会让测试挂住不退出）—— 错峰之后
  // 测试就没法确定性地推进心跳了。换来的是「一秒内几次微秒级调用挤在同一拍」，
  // 不值得为它牺牲可测性。

  const HEARTBEAT_MS = 1000;
  const tickers = [];
  let tickTimer = 0;

  function dispatchTicks() {
    // 复制一份再遍历：回调里注销自己（或别人）不该打乱这一轮的顺序
    for (const fn of [...tickers]) {
      try {
        fn();
      } catch (err) {
        console.warn(`[llg-shared] 心跳回调抛错：${err && err.message}`);
      }
    }
  }

  /**
   * 注册一个每秒跑一次的回调。
   * @param {() => void} fn
   * @returns {() => void} 注销函数
   */
  function onTick(fn) {
    if (typeof fn !== 'function') return () => {};
    tickers.push(fn);
    if (!tickTimer) tickTimer = setInterval(dispatchTicks, HEARTBEAT_MS);
    return () => {
      const index = tickers.indexOf(fn);
      if (index >= 0) tickers.splice(index, 1);
    };
  }

  // ---------------------------------------------------------------- 功能注册表
  //
  // 各功能模块（30- / 40-）在加载时把自己登记进来，50-settings-panel.js 据此在
  // Linglass 自己的设置面板里生成原生行。这样「有哪些功能」只有一处真相，
  // 新增功能不需要改设置面板的代码。

  const features = new Map();

  /**
   * @param {object} feature
   * @param {string} feature.id           唯一标识，也用作 DOM 标记
   * @param {string} feature.title        行标题
   * @param {string} [feature.icon]       行图标 SVG（开关行用 class="toggle-icon"）
   * @param {() => boolean} [feature.isOn] 开关行当前状态
   * @param {() => void} [feature.toggle]  开关行点击行为；不给则不渲染成开关
   * @param {Array<{id:string,title:string,icon:string,value?:() => string,run:() => void}>} [feature.actions]
   */
  function registerFeature(feature) {
    if (!feature || !feature.id) return;
    features.set(feature.id, feature);
  }

  function listFeatures() {
    return [...features.values()];
  }

  // ---------------------------------------------------------------- 复制清道夫
  //
  // PLAN 050：官方的振假名是 `<ruby>夜<rt>よる</rt></ruby>`，浏览器对选区的默认复制
  // 会把 `<rt>` 的文本按顺序拼进去 —— 从浮窗 / 页面字幕里抠一句话，粘出来就是
  // 「夜よる」。剪贴板不经过我们自己的读取路径（`10-subtitle-track.js` 的 `plainText()`
  // 早已剥掉 rt），所以只能在 `copy` 事件上把选区重新序列化一遍。
  //
  // 浮窗原文行里还有文节分隔符（`.llg-sep` 节点），同样不该被复制。
  // 只有选区里**确实含**这两样东西时才接管，其余复制保持浏览器原生行为
  // （换行与富文本粘贴都不动）。

  /** 浮窗分隔符节点的 class（与 30-desktop-subtitles.js 的 SEP_CLASS 一致） */
  const COPY_SEP_CLASS = 'llg-sep';

  function isCopyNoise(node) {
    if (!node) return false;
    if (node.nodeName === 'RT') return true;
    return !!(node.className && String(node.className).split(/\s+/).includes(COPY_SEP_CLASS));
  }

  function hasCopyNoise(node) {
    if (!node) return false;
    if (isCopyNoise(node)) return true;
    for (const child of node.childNodes || []) {
      if (hasCopyNoise(child)) return true;
    }
    return false;
  }

  /** 跳过 rt 与分隔符取文本（与 10- 的 subtreeText 同口径，但不建节点） */
  function copyTextOf(node) {
    let text = '';
    for (const child of node.childNodes || []) {
      if (child.nodeType === 3) {
        text += child.data || '';
        continue;
      }
      if (isCopyNoise(child)) continue;
      text += copyTextOf(child);
    }
    return text;
  }

  /**
   * 选区 → 干净纯文本。选区为空、或里面没有 rt / 分隔符时返回 null（= 不接管）。
   */
  function selectionCopyText(win) {
    const sel = win && typeof win.getSelection === 'function' ? win.getSelection() : null;
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;

    try {
      const parts = [];
      let noise = false;
      for (let i = 0; i < sel.rangeCount; i += 1) {
        const range = sel.getRangeAt(i);
        const frag = range && typeof range.cloneContents === 'function' ? range.cloneContents() : null;
        if (!frag) return null;
        if (hasCopyNoise(frag)) noise = true;
        parts.push(copyTextOf(frag));
      }

      if (!noise) return null;
      // 分隔符两侧的窄空格（\u2009）也去掉，粘出来才是干净的句子
      return parts.join('\n').replace(/\u2009/g, '').trim();
    } catch {
      // 选区跨了拿不到的范围（跨文档 / 已失效）：不接管，让浏览器按原样复制
      return null;
    }
  }

  /** 给一个 window / document 装上复制清道夫（同一个目标只装一次） */
  function installCopySanitizer(win) {
    if (!win || typeof win.addEventListener !== 'function') return;
    if (win.__llgCopySanitized) return;
    win.__llgCopySanitized = true;
    win.addEventListener('copy', (ev) => {
      const text = selectionCopyText(win);
      if (text === null) return;
      const data = ev && ev.clipboardData;
      if (!data || typeof data.setData !== 'function') return;
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      data.setData('text/plain', text);
    });
  }

  installCopySanitizer(document);

  Object.defineProperty(globalThis, NS, {
    value: {
      ensureButton,
      setButtonState,
      injectStyle,
      registerFeature,
      listFeatures,
      onTick,
      installCopySanitizer,
      // 设计令牌（PLAN 047）：所有自有 UI 的表面材质 / 色彩 / 形状 / 动效都从这里取
      design: { GLASS_LEVELS, GLASS, glassOf, tokensCss, glassCss },
    },
    configurable: true,
  });
})();
