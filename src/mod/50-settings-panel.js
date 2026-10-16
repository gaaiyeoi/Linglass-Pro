/**
 * 把我们的功能挂进 Linglass 自己的设置面板
 *
 * 目标：我们的开关和操作出现在 Linglass 设置面板里，与「字幕样式」「同步模式」那些
 * 行并列，长得完全一样 —— 而不是页面上的外挂按钮。
 *
 * 官方面板是一个带 shadowRoot 的 Web Component：宿主 #linglass-settings-panel-v2，
 * attachShadow({ mode: "open" })，所以可以从内容脚本直接访问。它的 render() 会把
 * shadowRoot.innerHTML 清空重建，因此我们必须在每次重建后重新注入。
 *
 * ── 为什么是「root 页加行」而不是「nav-row 进自己的子页面」 ──
 * 这两条路我都评估过，子页面那条在这个版本上会坏：
 *
 *   1. 它的 nav-row 是【逐个绑定】的：render() 同步走完 attachEventListeners()，
 *      而 MutationObserver 回调在微任务检查点才触发 —— 必然晚于绑定。所以后注入的
 *      .nav-row[data-page] 拿不到监听器，进入子页面只能我们自己实现。
 *   2. 自己实现就要连同 refreshPageHeader() 和 syncStackHeight() 一起复刻。而它的
 *      syncStackHeight() 用的是它自己的 this.page（对我们来说恒为 "root"），且由挂在
 *      每个页面上的 ResizeObserver 驱动 —— 一旦任何页面尺寸变化，它就会把 .panel-stack
 *      的高度改回 root 页的高度。结果是：面板高度会在我们浏览子页面时突然弹回，而
 *      .panel-stack 是 overflow:hidden，我们较高的子页面会被裁掉。
 *   3. root 页加行则是它明确支持的：ResizeObserver 会观察到高度变化并自动触发
 *      syncStackHeight()，装不下时给它加上 .panel-stack--clamped（overflow-y:auto）。
 *      面板自然变成可滚动，零冲突。
 *
 * ── 为什么不与它的点击处理冲突 ──
 *   · handleToggleClick 是 `const s = t.dataset.setting; s && (...)` —— 没有
 *     data-setting 就整体短路，我们的开关用不着这个属性。
 *   · 它的 `.toggle` 监听器只绑在 attachEventListeners() 那一刻已存在的元素上，
 *     我们注入得更晚，所以它根本没有我们的监听器。
 *   · 我们的行在它 shadowRoot 内部，它的样式表直接生效 —— 用对 class 就白拿原生观感，
 *     一行 CSS 都不用写。
 */
(() => {
  'use strict';

  const shared = globalThis.__llgModShared;
  if (!shared) {
    console.error('[llg-settings] 共享模块未加载（检查 src/mod 数字前缀与加载顺序）');
    return;
  }

  const HOST_ID = 'linglass-settings-panel-v2';
  const ROOT_PAGE = '.panel-content.panel-page[data-page="root"]';
  const ATTR = 'data-llg-mod';
  const HEARTBEAT_MS = 1000;
  const SECTION_TITLE = 'Linglass-Pro';

  /**
   * 本次 content script 上下文的标记。
   * 扩展重载会留下上一轮的「僵尸行」——DOM 还在 shadowRoot 里，但监听器已随旧上下文
   * 销毁。位置标记必须带上会话 id，否则新上下文会误以为自己已经注入过，直接跳过。
   */
  const SESSION = Math.random().toString(36).slice(2, 10);

  let observer = null;
  let observedShadow = null;

  function panelShadow() {
    const host = document.getElementById(HOST_ID);
    return host && host.shadowRoot ? host.shadowRoot : null;
  }

  /** 把静态 SVG 字符串变成元素；图标都是我们自己的常量，不是外部输入 */
  function svgOf(markup) {
    const holder = document.createElement('div');
    holder.innerHTML = markup || '';
    return holder.firstElementChild;
  }

  function buildToggleRow(feature) {
    const row = document.createElement('div');
    row.className = 'toggle-row';
    row.setAttribute(ATTR, `row:${feature.id}`);

    const label = document.createElement('div');
    label.className = 'toggle-label';
    const icon = svgOf(feature.icon);
    if (icon) label.append(icon);
    const text = document.createElement('span');
    text.textContent = feature.title;
    label.append(text);

    const toggle = document.createElement('button');
    toggle.className = 'toggle';
    toggle.type = 'button';
    toggle.setAttribute('data-llg-toggle', feature.id);
    if (feature.desc) toggle.title = feature.desc;
    const knob = document.createElement('span');
    knob.className = 'toggle-knob';
    toggle.append(knob);

    toggle.addEventListener('click', () => {
      feature.toggle();
      syncState();
    });

    row.append(label, toggle);
    return row;
  }

  function buildActionRow(action) {
    const row = document.createElement('button');
    row.className = 'nav-row';
    row.type = 'button';
    row.setAttribute(ATTR, `action:${action.id}`);

    const icon = svgOf(action.icon);
    if (icon) row.append(icon);

    const name = document.createElement('span');
    name.className = 'nav-row__name';
    name.textContent = action.title;
    row.append(name);

    if (typeof action.value === 'function') {
      const value = document.createElement('span');
      value.className = 'nav-row__val';
      value.setAttribute('data-llg-val', action.id);
      value.textContent = String(action.value());
      row.append(value);
    }

    row.addEventListener('click', () => {
      action.run();
      syncState();
    });

    return row;
  }

  /** 注入我们的行；返回 false 表示面板还没渲染出 root 页，等下一次心跳 */
  function inject(shadow) {
    if (!shadow.querySelector('.panel-pages')) return false;
    const root = shadow.querySelector(ROOT_PAGE);
    if (!root) return false;

    // 面板每次 render() 都会重建 shadowRoot，所以每次都要确认我们的行还在。
    // 用会话标记区分：本轮注入的保留，上一轮遗留的清掉。
    const mine = [...root.querySelectorAll(`[${ATTR}="section"]`)]
      .some((el) => el.dataset.llgOwner === SESSION);
    if (mine) return true;
    for (const stale of shadow.querySelectorAll(`[${ATTR}]`)) stale.remove();

    const features = shared.listFeatures();
    if (!features.length) return false;

    const header = document.createElement('div');
    header.className = 'section-label';
    header.setAttribute(ATTR, 'section');
    header.dataset.llgOwner = SESSION;
    header.textContent = SECTION_TITLE;
    header.style.marginTop = '14px';

    const frag = document.createDocumentFragment();
    frag.append(header);

    const toggleable = features.filter((f) => typeof f.toggle === 'function');
    if (toggleable.length) {
      const section = document.createElement('div');
      section.className = 'toggle-section';
      section.setAttribute(ATTR, 'toggles');
      for (const feature of toggleable) section.append(buildToggleRow(feature));
      frag.append(section);
    }

    const actions = features.flatMap((f) => f.actions ?? []);
    if (actions.length) {
      const wrap = document.createElement('div');
      wrap.setAttribute(ATTR, 'actions');
      for (const action of actions) wrap.append(buildActionRow(action));
      frag.append(wrap);
    }

    root.append(frag);
    return true;
  }

  /**
   * 把状态写回 DOM。
   * 每个写入都必须先比较再写 —— 我们对 shadowRoot 挂了 MutationObserver，
   * 无脑赋值 textContent 即使内容相同也会产生 DOM 变更，从而把自己打成死循环。
   */
  function syncState(shadow) {
    const root = shadow || panelShadow();
    if (!root) return;

    for (const feature of shared.listFeatures()) {
      const toggle = root.querySelector(`[data-llg-toggle="${feature.id}"]`);
      if (!toggle) continue;
      const on = typeof feature.isOn === 'function' ? !!feature.isOn() : false;
      if (toggle.classList.contains('on') !== on) toggle.classList.toggle('on', on);
    }

    for (const feature of shared.listFeatures()) {
      for (const action of feature.actions ?? []) {
        if (typeof action.value !== 'function') continue;
        const value = root.querySelector(`[data-llg-val="${action.id}"]`);
        if (!value) continue;
        const next = String(action.value());
        if (value.textContent !== next) value.textContent = next;
      }
    }
  }

  function ensureObserver(shadow) {
    if (observedShadow === shadow && observer) return;
    observer?.disconnect();
    observedShadow = shadow;
    observer = new MutationObserver(() => {
      inject(shadow);
      syncState(shadow);
    });
    observer.observe(shadow, { childList: true, subtree: true });
  }

  function heartbeat() {
    const shadow = panelShadow();
    if (!shadow) return;
    ensureObserver(shadow);
    inject(shadow);
    syncState(shadow);
  }

  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
})();
