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

  Object.defineProperty(globalThis, NS, {
    value: { ensureButton, setButtonState, injectStyle, registerFeature, listFeatures },
    configurable: true,
  });
})();
