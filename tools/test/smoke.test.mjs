/**
 * 逻辑冒烟测试 —— 在 Node 里用桩件驱动真实的 src/mod 模块。
 *
 * 覆盖的是「不需要浏览器就能验的那部分」：字幕轨道的时间轴推导、去重、暂停保护、
 * 落盘键名，以及导出格式与时间格式化。浏览器内的视觉与交互（面板滑入、画中画、
 * MutationObserver 真实时序）必须在 Arc / Chrome 里人工确认。
 *
 * 怎么跑起来的：src/mod/*.js 都是自执行的 IIFE，只通过 globalThis 互相取用，
 * 只依赖 document / chrome / MutationObserver 这几个全局。所以用 node:vm 开一个
 * 沙箱、把这几个全局换成桩，就能把源文件原封不动跑起来 —— 不用打包、不用改源码、
 * 也不需要额外依赖（项目刻意保持零依赖）。
 *
 * 定时器是手动驱动的：真定时器会让测试变慢、还会让 node:test 挂住不退出。
 * 心跳与落盘去抖都进了队列，测试里用 h.tick() / h.runTimers() 显式触发。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_MOD = path.join(ROOT, 'src', 'mod');

const VIDEO_ID = 'abc123';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const STORE_PREFIX = 'llgTrack:';

/** 读源码（只读一次，多个用例共用） */
const sources = new Map();
async function sourceOf(file) {
  if (!sources.has(file)) {
    sources.set(file, await readFile(path.join(SRC_MOD, file), 'utf8'));
  }
  return sources.get(file);
}

/**
 * 搭一个沙箱，装上桩件与待测模块。
 *
 * @param {object} [options]
 * @param {boolean} [options.withPanel] 是否额外加载 40-study-panel.js
 * @param {boolean} [options.withPip]   是否额外加载 30-desktop-subtitles.js
 * @param {object}  [options.stored]    预置的 chrome.storage.local 内容
 * @param {object}  [options.settings]  预置的官方外观设置（chrome.storage.sync 的
 *                                      'linglass-settings'，对象或 JSON 字符串都行）
 * @param {boolean} [options.withColumn] 是否造出播放页的推荐列（`#columns #secondary`）。
 *                                      有它 → 面板走 column 形态（寄生在列里）；
 *                                      没有 → 退回 float 形态（悬浮 + 让位）。
 * @param {boolean} [options.withStorageGetKeys] 桩上带不带 `chrome.storage.local.getKeys()`。
 *                                      默认不带 = 老版本 Chrome，骨架的枚举退化路径会走
 *                                      `get(null)`；打开它测「有 getKeys 就不搬整份 storage」。
 * @param {boolean} [options.noPipStored] 不预置 `llgPip` 落盘（`withPip` 时默认会预置
 *                                      `{enabled:true}`，见函数体里的说明）。只有
 *                                      「桌面字幕默认值」那条用例需要它。
 */
async function harness({
  withPanel = false,
  withPip = false,
  withColumn = false,
  withStorageGetKeys = false,
  noPipStored = false,
  stored = {},
  settings = null,
} = {}) {
  // 桌面字幕自 PLAN 025 起默认**关闭**（用户选择「视频内嵌字幕优先」）。下面这一批
  // 「桌面字幕：…」用例测的是**开关开着之后**的常驻行为（窗口被 UA 收走能不能回来、
  // 点 X 算不算关闭……），所以这里默认预置落盘 enabled: true。
  // 默认值本身由「桌面字幕：默认关闭（视频内嵌字幕优先）」那条用例覆盖（它传 noPipStored）。
  if (withPip && !noPipStored && !(stored && stored.llgPip)) {
    stored = { ...stored, llgPip: { enabled: true } };
  }

  const h = {
    // 字幕浮层 Shadow DOM 的可控状态
    primary: '',
    /** 剥掉振假名（rt）之后的原文 —— 官方 DOM 里这两份文本都存在，见 primaryEl */
    primaryPlain: '',
    /** 这一行的原文是否带振假名（`<ruby>夜<rt>よる</rt></ruby>`） */
    primaryRt: false,
    /**
     * 原文行的 DOM 子树（只给「带注音」的用例造，见 showRuby）。
     * 元素用 `{ nodeName, childNodes }`、文本节点用 `{ nodeType: 3, data }` 描述 ——
     * 够 10-subtitle-track.js 的 readPrimaryRich() 遍历。
     */
    primaryNodes: null,
    secondary: '',
    groupDisplay: '',
    primaryDisplay: '',
    secondaryDisplay: '',
    // 播放器
    currentTime: 0,
    duration: 600,
    /**
     * 宿主页面里有没有播放器的 video（`#movie_player video`）。
     * 关掉它 = 还在非播放页（首页 / 搜索页），用来测「这次手势不算数时要重新武装」
     */
    hasMoviePlayer: true,
    // 落盘与定时器
    saved: [],
    removed: [],
    stored,
    /** chrome.storage.local.get 被读过的 key（用来断言「没有反复轮询」） */
    storageReads: [],
    /** chrome.storage.local.getKeys() 被调了几次（枚举退化路径的代价，见 PLAN 014） */
    storageGetKeysCalls: 0,
    /**
     * 字幕 shadowRoot 被查了几次。
     * 用来钉住 PLAN 025 的根因：getProgress()（每帧调用）绝不能再读字幕 DOM。
     */
    subtitleQueries: () => subtitleQueries,
    // 官方外观设置（chrome.storage.sync）与它的变更监听器
    sync: settings == null ? {} : { 'linglass-settings': settings },
    syncListeners: [],
    features: [],
    timers: new Map(),
    intervals: [],
    mutationCallback: null,
    // 页面可见性（桌面字幕的「切回浏览器」判定靠它）
    visibilityState: 'visible',
    // 全屏（面板在全屏时要收起、页面让位要撤掉）与剧场模式
    fullscreenElement: null,
    youtubeFullscreen: false,
    theater: false,
    // window 上收到的 resize（让位之后要补一次，见 nudgeVideosLayout）
    windowEvents: [],
    docListeners: {},
    listeners(type) {
      if (!h.docListeners[type]) h.docListeners[type] = [];
      return h.docListeners[type];
    },
    // 系统级画中画
    pip: { window: null, windows: [], requestCount: 0, deny: false, lastOptions: null },
    /**
     * 我们注册到控制栏的按钮（按 id 记下 options）。
     * 用来调用**真实的** onClick —— 「回到浏览器后点控制栏按钮该开还是该关」这条逻辑
     * 只有那一个入口，见 h.buttons.get('llg-pip-btn').onClick
     */
    buttons: new Map(),
    /** 当前有没有瞬时用户激活（requestWindow 的门槛，见 h.gesture 与 navigator 桩） */
    activation: false,
    jaBreakEnabled: true,
  };

  let timerId = 0;
  const video = {
    get currentTime() {
      return h.currentTime;
    },
    set currentTime(v) {
      h.currentTime = v;
    },
    get duration() {
      return h.duration;
    },
    isConnected: true,
    // 播放控制（桌面字幕浮窗的控制栏会操作这些）
    paused: false,
    playbackRate: 1,
    plays: 0,
    pauses: 0,
    handlers: {},
    play() {
      video.plays += 1;
      video.paused = false;
    },
    pause() {
      video.pauses += 1;
      video.paused = true;
    },
    addEventListener(type, fn) {
      if (!video.handlers[type]) video.handlers[type] = [];
      video.handlers[type].push(fn);
    },
    removeEventListener(type, fn) {
      const list = video.handlers[type];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    fire(type) {
      for (const fn of [...(video.handlers[type] || [])]) fn();
    },
  };
  h.video = video;

  const display = (key) => ({
    get display() {
      return h[key];
    },
    set display(v) {
      h[key] = v;
    },
  });

  const group = { style: display('groupDisplay') };
  /**
   * 原文行。带振假名时，真 DOM 是一棵 `<ruby>夜<rt>よる</rt></ruby>` 树：
   *   · textContent       → 「夜よる」（注音拼在汉字后面，这正是我们要避开的东西）
   *   · 剥掉 rt 之后的文本 → 「夜」（官方 Tn() 与 15-ja-break.js 的 textOf() 的口径）
   * 桩件必须同时给出这两份文本，否则测不出「剥 rt」这件事。
   */
  const primaryEl = {
    style: display('primaryDisplay'),
    get textContent() {
      return h.primary;
    },
    set textContent(v) {
      h.primary = v;
      h.primaryPlain = v;
    },
    /** 官方行的真实子树：readPrimaryRich() 会遍历它（只有 showRuby 造的用例才有） */
    get childNodes() {
      return h.primaryNodes || [];
    },
    querySelector(selector) {
      return selector === 'rt' && h.primaryRt ? { nodeName: 'RT' } : null;
    },
    cloneNode() {
      return {
        querySelectorAll: (selector) => (selector === 'rt' ? [{ remove() {} }] : []),
        textContent: h.primaryPlain,
      };
    },
  };
  const secondaryEl = {
    style: display('secondaryDisplay'),
    get textContent() {
      return h.secondary;
    },
    set textContent(v) {
      h.secondary = v;
    },
    // 真 DOM 的元素都有这两个方法；译文行没有振假名，所以 rt 永远查不到
    querySelector() {
      return null;
    },
    cloneNode() {
      return { querySelectorAll: () => [], textContent: h.secondary };
    },
  };

  /** 字幕 shadowRoot 的查询计数（PLAN 025 的热路径回归断言用） */
  let subtitleQueries = 0;

  const subtitleRoot = {
    querySelector(selector) {
      subtitleQueries += 1;
      if (selector === '.subtitle-group') return group;
      if (selector === '.subtitle.subtitle-primary') return primaryEl;
      if (selector === '.subtitle.subtitle-secondary') return secondaryEl;
      return null;
    },
  };

  const host = { shadowRoot: subtitleRoot };

  /** YouTube 的布局标记（剧场 / 全屏）：让位与面板收起都读它 */
  const flexy = {
    hasAttribute(name) {
      if (name === 'theater') return h.theater === true;
      if (name === 'fullscreen') return h.youtubeFullscreen === true;
      return false;
    },
  };

  /** 推荐列（`#columns #secondary`）的假货：只有 withColumn 时存在 */
  let column = withColumn ? makeStubNode('div') : null;
  if (column) column.id = 'secondary';

  /**
   * 极简 DOM 桩：只够 40-study-panel.js 的 buildPanel / renderAll / highlight 跑完。
   *
   * 为什么不引 jsdom：本仓库刻意零依赖（见 AGENTS.md §0），而面板的布局行为
   * （开关落盘、让位标记、全屏收起）**必须**经过 buildPanel 才测得到。
   */
  function makeStubNode(tagName = 'div') {
    const node = {
      tagName,
      id: '',
      className: '',
      style: {},
      dataset: {},
      attributes: {},
      children: [],
      classes: new Set(),
      textContent: '',
      innerHTML: '',
      scrollTop: 0,
      /** 注册过的监听器（按类型），测试用 h.fireOn() 触发 */
      handlers: {},
      /** scrollIntoView 的调用参数，用来断言「确实滚到了当前句」 */
      scrolls: [],
      append(...kids) {
        // DocumentFragment 在真 DOM 里会被摊平（子节点直接进容器）—— 列表就是靠
        // 「先把行 append 进 frag、再把 frag append 进 ol」渲染的，不摊平的话
        // els.list.children[index] 拿到的是那个 fragment，highlight 与跟随就测不出来
        for (const kid of kids) {
          if (kid && kid.tagName === 'fragment') node.children.push(...kid.children);
          else node.children.push(kid);
        }
      },
      prepend(...kids) {
        node.children.unshift(...kids);
      },
      replaceChildren() {
        node.children.length = 0;
      },
      setAttribute(name, value) {
        node.attributes[name] = String(value);
        if (name === 'id') node.id = String(value);
      },
      getAttribute(name) {
        return name in node.attributes ? node.attributes[name] : null;
      },
      removeAttribute(name) {
        delete node.attributes[name];
      },
      addEventListener(type, fn) {
        if (!node.handlers[type]) node.handlers[type] = [];
        node.handlers[type].push(fn);
      },
      removeEventListener(type, fn) {
        const list = node.handlers[type];
        if (!list) return;
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      },
      scrollIntoView(options) {
        node.scrolls.push(options || null);
      },
      /**
       * 矩形（面板判断「当前句在不在列表可视区内」要拿它比对）。
       * 默认全 0，也就是「可见」—— 既有用例不受影响；要测滚出视野就临时给 node.rect 赋值。
       */
      getBoundingClientRect() {
        return node.rect || { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
      },
      click() {},
      remove() {},
      get firstElementChild() {
        return node.children[0] ?? null;
      },
      get classList() {
        return {
          add: (name) => node.classes.add(name),
          remove: (name) => node.classes.delete(name),
          contains: (name) => node.classes.has(name),
        };
      },
      querySelector(selector) {
        if (selector !== '.row.is-active') return null;
        return node.children.find((kid) => kid.classes && kid.classes.has('is-active')) ?? null;
      },
    };
    return node;
  }

  /** 面板宿主（attachShadow）的桩：按 data-role 惰性造节点，够 querySelector 用 */
  function makePanelHost() {
    const roles = new Map();
    const roleNode = (role) => {
      if (!roles.has(role)) roles.set(role, makeStubNode(`stub:${role}`));
      return roles.get(role);
    };
    const host = {
      roleNode,
      /** shadow 上的点击监听器（面板用事件委托接所有 data-act），供 h.panelAct() 触发 */
      clickHandler: null,
      shadow: {
        append: () => {},
        addEventListener(type, fn) {
          if (type === 'click') host.clickHandler = fn;
        },
        querySelector(selector) {
          const match = /^\[data-role="(.+)"\]$/.exec(selector);
          return match ? roleNode(match[1]) : null;
        },
      },
    };
    return host;
  }
  let panelHost = null;

  /**
   * 画中画窗口的假货。
   *
   * 30-desktop-subtitles.js 只用到极小的一个子集：createElement / append /
   * getElementById（按 id 找它刚建好的那些节点）、addEventListener('pagehide')、
   * close()、requestAnimationFrame。所以这里不求完整 DOM，只保证这五件事成立。
   */
  function fakePipDocument() {
    const byId = new Map();
    const el = (tagName) => {
      const node = {
        tagName,
        id: '',
        className: '',
        style: {},
        textContent: '',
        children: [],
        dataset: {},
        attributes: {},
        disabled: false,
        title: '',
        append(...kids) {
          for (const kid of kids) {
            node.children.push(kid);
            if (kid && kid.id) byId.set(kid.id, kid);
          }
        },
        replaceChildren(...kids) {
          node.children.length = 0;
          node.append(...kids);
        },
        setAttribute(name, value) {
          node.attributes[name] = String(value);
          if (name === 'id') node.id = String(value);
        },
        getAttribute(name) {
          return name in node.attributes ? node.attributes[name] : null;
        },
      };
      return node;
    };

    const doc = {
      documentElement: { style: {} },
      head: el('head'),
      body: el('body'),
      handlers: {},
      createElement: (tagName) => el(tagName),
      // 浮窗渲染原文行时会用文本节点（真 DOM 里 <ruby> 的第一个子节点就是 Text）
      createTextNode: (text) => ({
        nodeType: 3,
        textContent: String(text),
        data: String(text),
        children: [],
      }),
      getElementById: (id) => byId.get(id) ?? null,
      addEventListener(type, fn) {
        if (!doc.handlers[type]) doc.handlers[type] = [];
        doc.handlers[type].push(fn);
      },
      removeEventListener() {},
    };
    return doc;
  }

  function makePipWindow() {
    const win = {
      document: fakePipDocument(),
      closed: false,
      innerWidth: 1000,
      innerHeight: 220,
      handlers: {},
      addEventListener(type, fn) {
        if (!win.handlers[type]) win.handlers[type] = [];
        win.handlers[type].push(fn);
      },
      removeEventListener() {},
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      /** 模拟 UA 关闭：只发 pagehide，不经过我们的 close() */
      fire(type) {
        for (const fn of [...(win.handlers[type] || [])]) fn();
      },
      close() {
        win.closed = true;
        if (h.pip.window === win) h.pip.window = null;
        win.fire('pagehide');
      },
    };
    return win;
  }

  /**
   * <head> 与 <html> 的桩：让位样式注入到 head，标记与宽度写在 html 上。
   * 这两处是「面板打开时页面有没有真的让位」在 Node 侧唯一的观察点。
   */
  const head = {
    appended: [],
    append(el) {
      head.appended.push(el);
    },
  };
  h.head = head;

  const documentElement = {
    attributes: {},
    style: {
      values: {},
      setProperty(name, value) {
        documentElement.style.values[name] = String(value);
      },
      removeProperty(name) {
        delete documentElement.style.values[name];
      },
      getPropertyValue(name) {
        return documentElement.style.values[name] ?? '';
      },
    },
    setAttribute(name, value) {
      documentElement.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in documentElement.attributes ? documentElement.attributes[name] : null;
    },
    removeAttribute(name) {
      delete documentElement.attributes[name];
    },
    hasAttribute(name) {
      return name in documentElement.attributes;
    },
  };
  h.documentElement = documentElement;

  const sandbox = {
    console,
    URL,
    navigator: {
      clipboard: { writeText: () => Promise.resolve() },
      // 瞬时用户激活。桌面字幕在调 requestWindow() 之前会问它一句（见 hasActivation()）
      userActivation: {
        get isActive() {
          return h.activation;
        },
      },
    },
    confirm: () => true,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    Element: class {},
    // 让位之后会补一次 resize（见 40-study-panel.js nudgeVideosLayout）
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    dispatchEvent: (ev) => {
      h.windowEvents.push(ev && ev.type);
      return true;
    },
    // 30-desktop-subtitles.js 会把 wake() 挂到 window 的 focus 上（window 就是本沙箱），
    // 40-study-panel.js 拖拽改宽时也会用 window 上的 pointermove / pointerup
    addEventListener: (type, fn) => h.listeners(type).push(fn),
    removeEventListener: (type, fn) => {
      const list = h.listeners(type);
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    location: { href: WATCH_URL, pathname: '/watch' },
    document: {
      title: 'テスト動画 - YouTube',
      head,
      body: { append: () => {} },
      documentElement,
      getElementById: (id) => (id === 'linglass-subtitle-overlay' ? host : null),
      querySelector: (selector) => {
        if (selector === '#movie_player video') return h.hasMoviePlayer ? video : null;
        if (selector === 'ytd-watch-flexy') return flexy;
        if (selector === 'ytd-watch-flexy[fullscreen]') return h.youtubeFullscreen ? flexy : null;
        if (selector === '#columns #secondary') return column;
        return null;
      },
      querySelectorAll: () => [],
      createElement: (tagName) => {
        const node = makeStubNode(tagName);
        // 只有面板宿主会用到 attachShadow（buildPanel 里唯一一次）
        node.attachShadow = () => {
          panelHost = makePanelHost();
          // 记下那个真实的 div（测试要断言它被挂到哪里、data-mode 是什么）
          panelHost.node = node;
          return panelHost.shadow;
        };
        return node;
      },
      createDocumentFragment: () => makeStubNode('fragment'),
      get fullscreenElement() {
        return h.fullscreenElement;
      },
      addEventListener: (type, fn) => h.listeners(type).push(fn),
      removeEventListener: (type, fn) => {
        const list = h.listeners(type);
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      },
      get visibilityState() {
        return h.visibilityState;
      },
    },
    // 官方字幕样式依赖它（Chrome 支持 paint-order，浮窗就直接描边而不是铺一圈阴影）
    CSS: { supports: () => true },
    chrome: {
      storage: {
        local: {
          // 支持按 key 读（官方字幕缓存的索引与具体条目都是按 key 读的，
          // 一次 get(null) 会把几十条整轨全拖进来）
          get: (key) => {
            h.storageReads.push(key);
            if (key == null) return Promise.resolve(h.stored);
            const keys = Array.isArray(key) ? key : [key];
            const out = {};
            for (const name of keys) {
              if (name in h.stored) out[name] = h.stored[name];
            }
            return Promise.resolve(out);
          },
          // 只在新版 Chrome 上有（Chrome 130+）。默认不给 —— 缺了它才走 get(null) 退化路径，
          // 两条路各有用例（见 PLAN 014 的「索引里没有就自己列」）
          ...(withStorageGetKeys
            ? {
              getKeys: () => {
                h.storageGetKeysCalls += 1;
                return Promise.resolve(Object.keys(h.stored));
              },
            }
            : {}),
          set: (entry) => {
            h.saved.push(entry);
            return Promise.resolve();
          },
          remove: (key) => {
            h.removed.push(key);
            return Promise.resolve();
          },
        },
        // 官方「外观」设置落在 sync 区（zustand persist）
        sync: {
          get: () => Promise.resolve(h.sync),
          set: () => Promise.resolve(),
        },
        onChanged: {
          addListener: (fn) => h.syncListeners.push(fn),
        },
      },
    },
    MutationObserver: class {
      constructor(callback) {
        h.mutationCallback = callback;
      }

      observe() {}

      disconnect() {}
    },
    setInterval: (fn) => h.intervals.push(fn),
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      timerId += 1;
      h.timers.set(timerId, { fn, ms });
      return timerId;
    },
    clearTimeout: (id) => h.timers.delete(id),
  };

  vm.createContext(sandbox);
  vm.runInContext('globalThis.window = globalThis;', sandbox);

  // 00-shared.js 的桩：只提供 40-study-panel.js 实际用到的四件事。
  // ensureButton 恒返回 false —— 让 refreshButton() 立刻短路，避免测试去碰控制栏；
  // 但 options 要记下来：控制栏按钮的 onClick 是「点回来该开还是该关」唯一的入口。
  sandbox.__llgModShared = {
    ensureButton: (options) => {
      h.buttons.set(options.id, options);
      return false;
    },
    setButtonState: () => {},
    injectStyle: () => {},
    registerFeature: (feature) => h.features.push(feature),
    listFeatures: () => h.features,
  };

  // 15-ja-break.js 的桩：桌面字幕只跟它要「开关状态」和「分隔符长什么样」。
  // 不加载真模块 —— 它要往官方字幕 shadowRoot 里写东西，桩件沙箱里没有那套结构。
  sandbox.__llgModJaBreak = {
    isEnabled: () => h.jaBreakEnabled,
    SEPARATOR: '|',
  };

  // 真实 00-shared.js 不加载（控制栏那套没法在桩里跑），但**共享心跳**必须照它的
  // 语义提供：各模块用 shared.onTick(fn) 注册 1s 心跳，h.tick() 就是那一次 tick
  // （PLAN 025 —— 五个 setInterval 合成一个，桩件要给出同一件事的替身）。
  sandbox.__llgModShared.onTick = (fn) => {
    h.intervals.push(fn);
    return () => {};
  };

  sandbox.documentPictureInPicture = {
    get window() {
      return h.pip.window;
    },
    requestWindow(options) {
      h.pip.requestCount += 1;
      h.pip.lastOptions = options;
      // 没有瞬时用户激活 → 真实现会 reject
      if (h.pip.deny) return Promise.reject(new Error('NotAllowedError'));
      const win = makePipWindow();
      h.pip.window = win;
      h.pip.windows.push(win);
      return Promise.resolve(win);
    },
  };

  h.tick = () => {
    for (const fn of h.intervals) fn();
  };
  h.runTimers = () => {
    const pending = [...h.timers.values()];
    h.timers.clear();
    for (const timer of pending) timer.fn();
  };
  h.drain = async () => {
    // 让微任务队列跑干净（save()/flush() 都是 async）
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  /**
   * 触发一次用户手势（桌面字幕靠它拿到瞬时激活）。
   *
   * 瞬时激活只覆盖**事件处理器的同步调用链**（open() 在回调里同步调 requestWindow，
   * 等它 await 回来时已经不需要激活了），所以这里也只在调用监听器期间把它置真。
   * `ev` 用来模拟「这次手势落在哪个元素上」（桌面字幕据此跳过我们自己的按钮/开关）。
   */
  h.gesture = (type = 'pointerdown', ev = null) => {
    h.withActivation(() => {
      for (const fn of [...h.listeners(type)]) fn(ev);
    });
  };
  /**
   * 在「有瞬时用户激活」的窗口里跑一段**同步**代码。
   *
   * 与 h.gesture 的区别：手势是「某个事件被派发时恰好带激活」，而这里用来模拟
   * 「用户是点着页面回到浏览器本体的」——那一刻没有页面事件，但激活仍在有效期内，
   * open() 因此能当场把浮窗开回来（见 30- 的 wake()）。
   */
  h.withActivation = (fn) => {
    h.activation = true;
    try {
      return fn();
    } finally {
      h.activation = false;
    }
  };
  /** 切换页面可见性并广播 visibilitychange */
  h.setVisibility = (state) => {
    h.visibilityState = state;
    for (const fn of [...h.listeners('visibilitychange')]) fn();
  };
  /** 广播 window 的 focus（用户从别的应用点回浏览器 / 从最小化恢复） */
  h.focus = () => {
    for (const fn of [...h.listeners('focus')]) fn();
  };
  h.lastPipWindow = () => h.pip.windows[h.pip.windows.length - 1] || null;
  /**
   * 浮窗节点的文本，**跳过 rt** —— 注音不算原文（与字幕轨道同一口径）。
   * 纯文本渲染时 line 里是 span，富渲染（官方行有注音）时是「文本节点 + <ruby>」。
   */
  function pipPlain(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.textContent || '';
    if (node.tagName === 'rt') return '';
    if (!node.children || !node.children.length) return node.textContent || '';
    return node.children.map(pipPlain).join('');
  }

  /** <ruby> 里的注音（rt 的文本） */
  function pipRuby(node) {
    const rt = (node.children || []).find((kid) => kid.tagName === 'rt');
    return rt ? rt.textContent || '' : '';
  }

  h.pipText = () => {
    const win = h.lastPipWindow();
    const line = win && win.document.getElementById('line-primary');
    return line ? pipPlain(line) : null;
  };
  /**
   * 任意一行的纯文本（与 pipText 同一口径：分隔符拼进去、注音不算）。
   * 上下文行（#prev-* / #next-*）走的是「片段 → 子节点」那条渲染路径，
   * 桩件的 textContent 不会汇总子节点，所以断言必须走 pipPlain。
   */
  h.pipLineText = (id) => {
    const win = h.lastPipWindow();
    const el = win && win.document.getElementById(id);
    return el ? pipPlain(el) : null;
  };
  /** 原文行的片段结构（文本 / 分隔符 / 注音），用来断言分隔符独立成节点、注音成 ruby */
  h.pipSegments = () => {
    const win = h.lastPipWindow();
    const line = win && win.document.getElementById('line-primary');
    if (!line) return null;
    return line.children.map((kid) => ({
      text: pipPlain(kid),
      sep: kid.className === 'llg-sep',
      ruby: kid.tagName === 'ruby' ? pipRuby(kid) : '',
    }));
  };
  /** 浮窗当前生效的那张样式表（字号/颜色/底板都在里面） */
  h.pipCss = () => {
    const win = h.lastPipWindow();
    if (!win) return null;
    const style = win.document.head.children.find((kid) => kid.tagName === 'style');
    return style ? style.textContent : null;
  };
  /** 模拟用户在官方「外观」页改了设置：写出新值并派发 storage.onChanged */
  h.changeSettings = (value) => {
    h.sync = { 'linglass-settings': value };
    const changes = { 'linglass-settings': { newValue: value } };
    for (const fn of [...h.syncListeners]) fn(changes, 'sync');
  };
  h.pipFill = () => {
    const win = h.lastPipWindow();
    const fill = win && win.document.getElementById('fill-primary');
    return fill ? fill.style.width : null;
  };
  /** 取浮窗里的按钮（按 id），用来断言文案/禁用态 */
  h.pipButton = (id) => {
    const win = h.lastPipWindow();
    return win ? win.document.getElementById(id) : null;
  };
  /**
   * 走真实的点击委托：造一个带 closest() 的事件目标，交给 PiP 窗口 document 上的监听器。
   * 这样测到的是「点击 → data-act → command」这条真实链路，而不是直接调 command。
   */
  h.pipClick = (act) => {
    const win = h.lastPipWindow();
    const handlers = win && win.document.handlers.click;
    if (!handlers || !handlers.length) return false;
    const target = {
      closest: (selector) => (selector === '[data-act]' ? { dataset: { act } } : null),
    };
    for (const fn of [...handlers]) fn({ target, preventDefault: () => {} });
    return true;
  };

  // ------------------------------------------------------------ 学习面板的观察点

  /** 面板 shadow 里的角色节点（buildPanel 惰性造的桩） */
  h.panelRole = (role) => (panelHost ? panelHost.roleNode(role) : null);
  h.panelState = () => {
    const panel = h.panelRole('panel');
    return panel ? panel.dataset.state : null;
  };
  /** 面板宿主节点（真 DOM 里的那个 div#llg-study-panel-root） */
  h.panelHostNode = () => (panelHost ? panelHost.node : null);
  /** 面板当前的挂载形态：'column'（寄生在推荐列里）/ 'float'（悬浮 + 让位） */
  h.panelMode = () => {
    const node = h.panelHostNode();
    return node && node.dataset ? (node.dataset.mode ?? null) : null;
  };
  /** 推荐列桩件（withColumn 时才有）：用来断言宿主真的被 prepend 进去了 */
  h.column = () => column;
  /**
   * 模拟 YouTube 重建推荐列（换视频 / 切布局时它会把整列换掉，宿主跟着一起被丢）。
   * 换完返回新的那一列。
   */
  h.rebuildColumn = () => {
    column = makeStubNode('div');
    column.id = 'secondary';
    return column;
  };
  /** 触发面板里某个角色节点上的监听器（例如列表的 wheel / 某一行的 click） */
  h.fireOn = (role, type, ev = {}) => {
    const node = h.panelRole(role);
    const handlers = node && node.handlers ? node.handlers[type] : null;
    if (!handlers || !handlers.length) return false;
    for (const fn of [...handlers]) fn(ev);
    return true;
  };
  /**
   * 走面板的真实点击委托：造一个带 closest() 的目标（必须是沙箱里 Element 的实例，
   * 源码里有 `ev.target instanceof Element` 的判断），交给 shadow 上的 click 监听器。
   */
  h.panelAct = (act) => {
    const handler = panelHost && panelHost.clickHandler;
    if (!handler) return false;
    const target = Object.create(sandbox.Element.prototype);
    target.closest = (selector) => (selector === '[data-act]' ? { dataset: { act } } : null);
    handler({ target });
    return true;
  };
  /** 让位是否生效：<html> 上的标记 / 宽度变量 / 注入的页面级样式 */
  h.panelLayoutOn = () => documentElement.attributes['data-llg-panel'] !== undefined;
  h.panelWidthVar = () => documentElement.style.getPropertyValue('--llg-panel-w');
  h.layoutStyle = () => head.appended.find((el) => el && el.id === 'llg-panel-layout-styles') || null;
  /** 开关面板（走设置面板注册表里的真实路径：toggle → setOpen） */
  h.togglePanel = () => {
    const feature = h.features.find((f) => f.id === 'studyPanel');
    if (!feature) throw new Error('学习面板没有登记到设置面板');
    feature.toggle();
    return feature.isOn();
  };
  /** 进出全屏（面板要收起、页面让位要撤掉） */
  h.setFullscreen = (on) => {
    h.fullscreenElement = on ? { tagName: 'DIV' } : null;
    for (const fn of [...h.listeners('fullscreenchange')]) fn();
  };

  vm.runInContext(await sourceOf('05-ja-segment.js'), sandbox, {
    filename: '05-ja-segment.js',
  });
  // 05-srt.js 也要在轨道之前（文件名顺序：05-ja-segment < 05-srt < 10-subtitle-track）——
  // 轨道在 applyTranslations 里跟它要 fingerprint（PLAN 031）
  vm.runInContext(await sourceOf('05-srt.js'), sandbox, {
    filename: '05-srt.js',
  });
  vm.runInContext(await sourceOf('10-subtitle-track.js'), sandbox, {
    filename: '10-subtitle-track.js',
  });
  if (withPip) {
    vm.runInContext(await sourceOf('30-desktop-subtitles.js'), sandbox, {
      filename: '30-desktop-subtitles.js',
    });
  }
  if (withPanel) {
    vm.runInContext(await sourceOf('40-study-panel.js'), sandbox, {
      filename: '40-study-panel.js',
    });
  }

  await sandbox.__llgModTrack.reload();
  await h.drain();

  return { sandbox, h, track: sandbox.__llgModTrack };
}

/** 让当前字幕变成指定文本（模拟 Linglass 更新了 Shadow DOM，**没有**注音） */
function show(h, primary, secondary = '') {
  h.primary = primary;
  h.secondary = secondary;
  // 真实重渲染之后上一行的 <ruby>/<rt> 不会留在新的一行里，桩件要一起清掉
  h.primaryRt = false;
  h.primaryNodes = null;
  h.tick();
}

/**
 * 让当前原文行变成「带振假名」的样子：`full` 是 textContent（含注音），
 * `plain` 是剥掉 rt 之后的文本。用于验证我们读的是后者。
 *
 * 桩件给的是**真实 DOM 的形状**：`<ruby>` 里「汉字文本节点 + <rt>注音</rt>」，
 * 所以两种读法（按文本节点遍历、或 clone 后删 rt）都得得到 `plain`。
 * 旧桩只造了 `cloneNode()` 那条路径（PLAN 025 的实现不再 clone，桩件必须描述
 * DOM 本身而不是某一种实现）。
 */
function showFurigana(h, full, plain, secondary = '') {
  h.primaryRt = true;
  h.primary = full;
  h.primaryPlain = plain;
  h.primaryNodes = [
    { nodeType: 3, data: plain, textContent: plain },
    { nodeName: 'RT', textContent: full.slice(plain.length), childNodes: [] },
  ];
  h.secondary = secondary;
  h.tick();
}

/**
 * 让当前原文行变成「官方渲染了 <ruby>/<rt>」的样子。
 *
 * tokens 是这一行的片段：`{ text: '夜', ruby: 'よる' }` 或纯文本 `{ text: '、' }`。
 * 既给 textContent（含注音的「夜よる」），也给剥掉 rt 的文本，还给一棵可遍历的子树 ——
 * readLines() 读前者剥干净的结果，readPrimaryRich() 遍历后者拿注音。
 */
function showRuby(h, tokens, secondary = '') {
  let full = '';
  let plain = '';
  const nodes = [];

  for (const token of tokens) {
    full += token.text + (token.ruby || '');
    plain += token.text;
    if (token.ruby) {
      nodes.push({
        nodeName: 'RUBY',
        childNodes: [
          { nodeType: 3, data: token.text, textContent: token.text },
          { nodeName: 'RT', textContent: token.ruby, childNodes: [] },
        ],
      });
    } else {
      nodes.push({ nodeType: 3, data: token.text, textContent: token.text });
    }
  }

  h.primaryRt = true;
  h.primary = full;
  h.primaryPlain = plain;
  h.primaryNodes = nodes;
  h.secondary = secondary;
  h.tick();
}

/**
 * 官方字幕缓存的假货（结构来自 vendor/linglass-1.12.3/assets/index.ts-CtsHbKHl.js 的
 * `Qa()` / `jl()`，不是猜的）：索引 + 一条原文档位。
 */
function officialCache(rawCues, { videoId = VIDEO_ID, lang = 'ja', cachedAt = 1000 } = {}) {
  const key = `subtitle-cache:v6:${videoId}:${lang}:primary`;
  return {
    'subtitle-cache:index': {
      entries: [
        { key, cachedAt },
        // 目标语言那一份也进索引（官方确实会写），但它不是原文档位，不该被当骨架
        { key: `subtitle-cache:v6:${videoId}:${lang}:zh`, cachedAt: cachedAt - 1 },
      ],
    },
    [key]: { cues: rawCues, videoId, primaryLang: lang, secondaryLang: 'primary', cachedAt },
  };
}

/** 整条原文轨（官方的时间是权威值：0→2.5→6→9.5） */
const SKELETON_CUES = [
  { start: 0, end: 2.5, text: 'おはよう', rawText: 'おはよう', id: 'c0' },
  { start: 2.5, end: 6, text: 'きょうは あめ です', rawText: '今日は雨です', id: 'c1' },
  { start: 6, end: 9.5, text: 'あしたは はれ です', rawText: '明日は晴れです', id: 'c2' },
];

test('字幕轨道：换句时收尾上一句、建新句，并按 start 升序排列', async () => {
  const { h, track } = await harness();

  h.currentTime = 5;
  show(h, 'こんにちは', '你好');
  assert.equal(track.getCues().length, 1);
  assert.equal(track.getCues()[0].start, 5);

  h.currentTime = 7;
  h.tick();
  assert.equal(track.getCues()[0].end, 7, '同句持续时 end 应该跟着播放前进');

  h.currentTime = 9;
  show(h, 'さようなら', '再见');
  const cues = track.getCues();
  assert.equal(cues.length, 2);
  assert.equal(cues[0].end, 9, '换句时应该用当前播放位置给上一句收尾');
  assert.equal(cues[1].start, 9);
  assert.ok(cues[0].start <= cues[1].start, 'cues 必须按 start 升序');
});

test('字幕轨道：读原文时剥掉振假名 rt（不是「夜よる」）', async () => {
  const { h, track } = await harness();

  h.currentTime = 3;
  showFurigana(h, '夜よる', '夜', '晚上');

  assert.equal(track.readLines().primary, '夜', '注音（rt）不该进入原文');
  assert.equal(track.getCues()[0].primary, '夜', '轨道里记的也必须是剥干净的原文');
  assert.equal(track.getCues()[0].secondary, '晚上', '译文那一行不受影响');
});

test('字幕轨道：画面上的振假名不会让进度误判成 0', async () => {
  const { h, track } = await harness();

  // 先正常播一句（不带注音），把它记进轨道
  h.currentTime = 10;
  show(h, '夜', '晚上');
  await h.drain();

  // 官方重渲染这一行时带上了振假名：textContent 变成「夜よる」、DOM 里多了 <rt>，
  // 但它跟时间轴里的「夜」是同一句 —— 剥 rt 之后两边口径才一致
  h.primaryRt = true;
  h.primary = '夜よる';
  h.primaryPlain = '夜';
  h.primaryNodes = [
    { nodeType: 3, data: '夜', textContent: '夜' },
    { nodeName: 'RT', textContent: 'よる', childNodes: [] },
  ];
  h.currentTime = 12;
  h.tick();

  assert.ok(
    track.getProgress() > 0,
    '画面与时间轴是同一句（只是带了注音），不该被判成「不一致」而返回 0',
  );
});

test('字幕轨道：重看同一段不重复收录', async () => {
  const { h, track } = await harness();

  h.currentTime = 5;
  show(h, 'こんにちは', '你好');
  h.currentTime = 9;
  show(h, 'さようなら', '再见');
  assert.equal(track.getCues().length, 2);

  // 往回拖到 5.2s，同一句再次出现 —— 容差内视为同一句
  h.currentTime = 5.2;
  show(h, 'こんにちは', '你好');
  assert.equal(track.getCues().length, 2, '重看不应新增句子');
  assert.equal(track.getCues()[0].start, 5, '应复用原来那句，而不是新建在 5.2');
});

test('字幕轨道：字幕空档期只收尾、不建空句', async () => {
  const { h, track } = await harness();

  h.currentTime = 5;
  show(h, 'こんにちは', '你好');
  h.currentTime = 8;
  show(h, '');
  assert.equal(track.getCues().length, 1, '空档不应建句');
  assert.equal(track.getCues()[0].end, 8);
});

/**
 * 进度分母的回归测试。
 *
 * 旧实现拿 resolveEnd()（= 活跃句被 extendActive 推上去的 cue.end）当分母，
 * 于是 (t - start) / (t - start) 恒等于 1：每句开始不到一秒进度就顶到 100%。
 * 旧版本的这条用例之所以是绿的，是因为它手动把 currentTime 倒回了句中（真实播放不会倒回）。
 */
test('字幕轨道：活跃句的 end 不再吞掉进度分母', async () => {
  const { h, track } = await harness();

  h.currentTime = 10;
  show(h, 'テスト', '测试');

  // 真实播放：心跳每秒把 end 推到当前播放位置
  h.currentTime = 12;
  h.tick();
  assert.equal(track.getCues()[0].end, 12);

  h.currentTime = 13;
  h.tick();
  assert.equal(track.getCues()[0].end, 13, '同句持续时 end 应该跟着播放前进（SRT 导出的语义）');

  assert.equal(track.getProgressEnd(), 16, '分母 = 起点 + 估计时长（首句无样本 → 6s）');
  assert.equal(track.getProgress(), 0.5, '播到 13s 时是 10→16 的中点，而不是 100%');

  // 暂停：currentTime 不动，end 不能被无限拉长（否则进度条会倒退）
  h.tick();
  h.tick();
  assert.equal(track.getCues()[0].end, 13, '暂停时 end 必须保持不动');
  assert.equal(track.getProgress(), 0.5, '暂停时进度也不动');
});

test('字幕轨道：有下一句时，进度分母用下一句的起点', async () => {
  const { h, track } = await harness();

  h.currentTime = 10;
  show(h, 'あ', '啊');
  h.currentTime = 12;
  show(h, 'い', '咿'); // 换句 → 第一句定稿

  // 回退到句中。真实路径里 YouTube 会把字幕重新渲染成这句；不同步画面的话，
  // 时间轴与画面就不是同一句了 —— 那是「不画」的语义（见下面那条用例）
  h.currentTime = 11;
  show(h, 'あ', '啊');
  assert.equal(track.getProgressEnd(), 12, '分母应当是下一句的 start');
  assert.equal(track.getProgress(), 0.5, '11s 处于 10→12 的中点');
});

/**
 * 拖进度条曾经会污染「一句大概多久」的样本：extendActive() 只防了暂停（Δt < 0.05s），
 * 没防跳转 —— 跳转后的位置被直接写进 active.end，于是这一句变成「一句 60 秒」，
 * 中位数被抬高，所有活跃句的进度分母跟着偏大（进度条永远走不满）。
 */
test('字幕轨道：拖进度条不会被当成这句的结束时间', async () => {
  const { h, track } = await harness();

  h.currentTime = 10;
  show(h, 'テスト', '测试');
  h.currentTime = 12;
  h.tick();
  assert.equal(track.getCues()[0].end, 12);

  // 往前拖一分钟：这一句只播到 12s，跨过去的那一段不是它在播
  h.currentTime = 72;
  h.tick();
  assert.equal(track.getCues()[0].end, 12, '跳转后的位置不能当句末');

  // 跳转之后接着播，采样重新跟上
  h.currentTime = 73;
  h.tick();
  assert.equal(track.getCues()[0].end, 73, '跳转之后仍要跟着播放推进');
});

test('字幕轨道：被拖进度条污染的超长句不进估计样本', async () => {
  const { h, track } = await harness();

  h.currentTime = 0;
  show(h, 'a', '');
  h.currentTime = 2;
  show(h, 'b', ''); // a: 0→2
  h.currentTime = 6;
  show(h, 'c', ''); // b: 2→6
  h.currentTime = 120;
  show(h, 'd', ''); // c: 6→120 —— 拖了进度条，不是真实时长
  h.currentTime = 122;
  h.tick();

  assert.equal(track.getCues()[2].end - track.getCues()[2].start, 114, '污染样本确实被记下来了');
  assert.equal(track.getProgressEnd(), 123, '中位数只取 (2 + 4) / 2 = 3，不是被 114 抬起来的值');
});

/**
 * 扩展加载晚、或者往没记录过的区间拖时，indexAt() 会返回一个早就播完的旧句，
 * 分母也早过了 → 进度被夹成 100%：画面上的句子跟时间轴里的根本不是同一句，
 * 却给出一个确定的「满格」。这种假进度比空着更糟。
 */
test('字幕轨道：画面与时间轴不是同一句时不画假进度', async () => {
  const { h, track } = await harness();

  h.currentTime = 10;
  show(h, 'あ', '啊');
  h.currentTime = 12;
  show(h, 'い', '咿');

  h.currentTime = 11; // 时间轴指向「あ」（10→12），画面却是「い」
  assert.equal(track.getProgress(), 0, '不是同一句 → 什么都不画，而不是假的 100%');

  show(h, 'あ', '啊'); // 画面同步回来（真实播放里 YouTube 会重渲染）
  assert.equal(track.getProgress(), 0.5, '对上了就给正常进度');
});

test('字幕轨道：估计时长取已定稿句子的中位数，且不含活跃句', async () => {
  const { h, track } = await harness();

  h.currentTime = 0;
  show(h, 'a', '');
  h.currentTime = 2;
  show(h, 'b', ''); // a: 0→2，时长 2
  h.currentTime = 6;
  show(h, 'c', ''); // b: 2→6，时长 4

  h.currentTime = 12;
  h.tick(); // c 成为活跃句，它的 end 是「播到哪了」，不能当时长样本

  assert.equal(track.getProgressEnd(), 9, '中位数 (2 + 4) / 2 = 3 → 6 + 3');
});

test('字幕轨道：未进入任何句子时进度为 0', async () => {
  const { h, track } = await harness();

  assert.equal(track.getProgress(), 0, '还没有任何 cue');
  h.currentTime = 100;
  show(h, 'あとで', '稍后');
  h.currentTime = 1;
  assert.equal(track.getProgress(), 0, '播放位置早于第一句时进度为 0');
});

test('字幕轨道：导出用的 cue 补齐 end 且不与下一句重叠', async () => {
  const { sandbox, h, track } = await harness();

  h.currentTime = 5;
  show(h, 'こんにちは', '你好');
  h.currentTime = 9;
  show(h, 'さようなら', '再见');

  const snapshot = track.snapshot();
  assert.equal(snapshot.cues.length, 2);
  assert.equal(snapshot.cues[0].end, 9, 'end 应被夹到下一句的 start');
  assert.ok(snapshot.cues[1].end >= snapshot.cues[1].start, '最后一句的 end 由默认时长补齐');
  assert.equal(snapshot.meta.id, VIDEO_ID);

  // getCuesForExport 与 snapshot 用的是同一套收尾逻辑
  assert.deepEqual(sandbox.__llgModTrack.getCuesForExport(), snapshot.cues);
});

test('字幕轨道：落盘键名带上视频 id，去抖期间只写一次', async () => {
  const { h, track } = await harness();

  h.currentTime = 5;
  show(h, 'こんにちは', '你好');
  h.currentTime = 7;
  h.tick();
  h.currentTime = 9;
  show(h, 'さようなら', '再见');

  assert.equal(h.saved.length, 0, '去抖未到期前不应落盘');
  h.runTimers();
  await h.drain();

  assert.equal(h.saved.length, 1, '去抖期间多次变更只产生一次写入');
  const entry = h.saved[0];
  const key = `${STORE_PREFIX}${VIDEO_ID}`;
  assert.ok(key in entry, `落盘键应为 ${key}`);
  assert.equal(entry[key].cues.length, 2);
  assert.equal(entry[key].meta.id, VIDEO_ID);

  // flush 是无条件落盘的（切视频 / 卸载前强制保底），所以这里应当再写一次
  await track.flush();
  await h.drain();
  assert.equal(h.saved.length, 2, 'flush 应强制再写一次，确保数据落地');
});

// ---------------------------------------------------------------- 热路径与内存（PLAN 025）

/**
 * 卡顿的根因回归（PLAN 025 第 1 条）。
 *
 * 桌面浮窗与学习面板各自有一个 rAF 循环，每帧都调 track.getProgress()；而旧实现里
 * getProgress() → onTimeline() → readLines() 会去查字幕 Shadow DOM（并且可能在
 * 注音行上 cloneNode 整行）。两个循环同时跑时同一份没变过的文本每秒被读上百次。
 *
 * 现在那一份由 capture()（MutationObserver + 1s 心跳）缓存，getProgress() 一帧都
 * 不该碰 DOM。
 */
test('字幕轨道：每帧读进度不再反复查询 Shadow DOM（卡顿的根因）', async () => {
  const { h, track } = await harness();

  h.currentTime = 10;
  show(h, 'テスト', '测试'); // 换句 → capture() 真的读了一次
  const baseline = h.subtitleQueries();
  assert.ok(baseline > 0, '换句时必须读字幕 DOM');

  // 模拟 4 秒的播放（≈ 240 帧，两个 rAF 循环就是 480 次 getProgress）
  for (let frame = 0; frame < 240; frame += 1) {
    h.currentTime = 10 + frame / 60;
    track.getProgress();
  }

  assert.equal(
    h.subtitleQueries(),
    baseline,
    'getProgress() 是每帧调用的，不许再读字幕 DOM（旧实现每帧查 3 次 + 可能克隆整行）',
  );

  // 缓存不能影响进度本身的正确性：10 → 16 的句子里，播到 13s 就是 50%
  h.currentTime = 13;
  assert.equal(track.getProgress(), 0.5);
  assert.equal(h.subtitleQueries(), baseline, '对了时间之后同样不该读 DOM');
});

/**
 * 超长视频 / 直播的句数上限（PLAN 025 第 4 条）：没有它，`cues` 与面板的 `<li>`
 * 会跟着直播时长线性长下去（用户报的「内存越用越多」）。
 */
test('字幕轨道：超长视频/直播的句数有上限（不会无限增长）', async () => {
  const MAX = 5000;
  const raw = [];
  for (let i = 0; i < MAX + 200; i += 1) {
    raw.push({ start: i, end: i + 0.9, text: `t${i}`, rawText: `t${i}`, id: `c${i}` });
  }

  const { h, track } = await harness({ stored: officialCache(raw) });
  await h.drain();
  await h.drain();

  const cues = track.getCues();
  assert.equal(cues.length, MAX, `句数上限应是 ${MAX}，实际 ${cues.length}`);
  assert.equal(cues[0].primary, 't200', '超出时丢的是**最旧**的句子（正在播的在末尾）');
  assert.equal(cues[cues.length - 1].primary, `t${MAX + 199}`, '最新的句子必须留着');

  h.currentTime = MAX + 199.5;
  assert.ok(track.getProgress() > 0, '丢掉前缀之后二分查找与进度仍然成立');
});

/**
 * 落盘 TTL（PLAN 025 第 3 条）。
 *
 * 旧实现每看一个新视频就写一条 `llgTrack:<id>`，没有上限也没有 TTL，只有用户手动
 * 「清空」才会删；默认配额约 10MB，写满之后 `set()` 静默失败 —— 表现是「进度记不住了」。
 */
test('字幕轨道：超过 TTL 的旧轨道会被删掉', async () => {
  const now = Date.now();
  const entries = [];
  const stored = {
    'subtitle-cache:index': { entries: [] },
    // 官方缓存（绝不能碰）与我们的旧轨道混在一起
    'subtitle-cache:v6:abc123:ja:primary': { cues: [] },
  };

  for (let i = 0; i < 5; i += 1) {
    const key = `llgTrack:fresh${i}`;
    entries.push({ key, savedAt: now - (i + 1) * 1000 });
    stored[key] = { meta: { id: `fresh${i}` }, cues: [], savedAt: now - (i + 1) * 1000 };
  }
  const ancient = 'llgTrack:ancient';
  entries.push({ key: ancient, savedAt: now - 40 * 24 * 60 * 60 * 1000 });
  stored[ancient] = { meta: { id: 'ancient' }, cues: [] };
  stored.llgTrackIndex = { entries };

  const { h } = await harness({ stored });
  h.currentTime = 5;
  show(h, 'テスト', '测试');
  h.runTimers();
  await h.drain();

  const written = h.saved.at(-1);
  assert.ok(written, '应当写了一次盘');
  const keys = written.llgTrackIndex.entries.map((entry) => entry.key);

  assert.equal(keys.length, 6, '5 条新鲜 + 当前这条，一条都不该被名额挤掉');
  assert.ok(keys.includes(`llgTrack:${VIDEO_ID}`), '当前视频必须留在索引里');
  assert.ok(!keys.includes(ancient), '超过 TTL（30 天）的轨道要淘汰');
  assert.deepEqual(
    h.removed.flat(),
    [ancient],
    '只删那一条过期的；官方缓存与别人的轨道都不许碰',
  );
});

/** 落盘条数上限（PLAN 025 第 3 条）：名额满了先淘汰最旧的 */
test('字幕轨道：落盘最多留 30 个视频的轨道', async () => {
  const now = Date.now();
  const entries = [];
  const stored = { 'subtitle-cache:index': { entries: [] } };

  for (let i = 0; i < 40; i += 1) {
    const key = `llgTrack:old${i}`;
    entries.push({ key, savedAt: now - (i + 1) * 1000 });
    stored[key] = { meta: { id: `old${i}` }, cues: [], savedAt: now - (i + 1) * 1000 };
  }
  stored.llgTrackIndex = { entries };

  const { h } = await harness({ stored });
  h.currentTime = 5;
  show(h, 'テスト', '测试');
  h.runTimers();
  await h.drain();

  const written = h.saved.at(-1);
  const keys = written.llgTrackIndex.entries.map((entry) => entry.key);

  assert.equal(keys.length, 30, `索引最多留 30 条，实际 ${keys.length}`);
  assert.ok(keys.includes(`llgTrack:${VIDEO_ID}`), '当前视频必须留在索引里');

  // 40 条旧轨道 + 当前位置 → 只留 30 → 淘汰 11 条最旧的
  const removed = h.removed.flat();
  assert.equal(removed.length, 11, `应当删掉 11 条最旧的，实际 ${removed.length}`);
  assert.ok(!removed.includes(`llgTrack:${VIDEO_ID}`), '当前视频绝不能被自己挤掉');
  assert.ok(!removed.includes('llgTrack:old0'), '被淘汰的是最旧的那一批（old29 往后）');
});

// ---------------------------------------------------------------- 官方整条轨（骨架）

test('字幕轨道：官方缓存提供整条轨，一句都没播也全在（面板与导出都拿得到）', async () => {
  const { h, track } = await harness({ stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();

  assert.equal(track.getCues().length, 3, '还没播过任何一句，轨道里就该是整条');

  const exported = track.getCuesForExport();
  assert.equal(JSON.stringify(exported.map((cue) => cue.primary)),
    JSON.stringify(['おはよう', 'きょうは あめ です', 'あしたは はれ です']));
  assert.equal(JSON.stringify(exported.map((cue) => [cue.start, cue.end])),
    JSON.stringify([[0, 2.5], [2.5, 6], [6, 9.5]]), '时间用官方给的，不是采样推的');
  assert.equal(exported[0].secondary, '', '没播过就没有译文（不强求）');

  // 只读：绝不能往官方那批 key 里写东西
  const wroteOfficial = h.saved.some((entry) =>
    Object.keys(entry).some((key) => key.startsWith('subtitle-cache:')));
  assert.equal(wroteOfficial, false, '官方缓存只能读，不能写');
});

test('字幕轨道：直播采到的译文贴到骨架句上，且不改官方时间', async () => {
  const { h, track } = await harness({ stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();

  h.currentTime = 0.2;
  show(h, 'おはよう', '早安');
  assert.equal(track.getCues().length, 3, '匹配上了就不该新建句');
  assert.equal(track.getCues()[0].secondary, '早安');

  // 播放推进不能改写官方 end（官方给的 2.5 比「采样到哪一刻」准）
  h.currentTime = 1.2;
  h.tick();
  assert.equal(track.getCues()[0].end, 2.5);

  h.currentTime = 3;
  show(h, 'きょうは あめ です', '今天下雨');
  assert.equal(track.getCues()[1].secondary, '今天下雨');
  assert.equal(track.getCues()[0].end, 2.5, '换句收尾时也不能改写官方 end');

  // 文本对不上（官方会重新断句）→ 退化为时间匹配，仍然贴回骨架句
  h.currentTime = 7;
  show(h, 'あした は はれ です', '明天晴');
  assert.equal(track.getCues().length, 3, '时间落在骨架句里 → 贴回去，不新建');
  assert.equal(track.getCues()[2].secondary, '明天晴');

  const exported = track.getCuesForExport();
  assert.equal(exported.filter((cue) => cue.secondary).length, 3, '看过的三句都带上了译文');
});

test('字幕轨道：骨架里没有的直播句照样记下来，不被丢掉', async () => {
  const { h, track } = await harness({ stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();

  // 缓存是 24 小时前那份、视频被重新剪过：这句在骨架里不存在
  h.currentTime = 100;
  show(h, 'まったく べつの はなし', '完全不同的内容');
  const cues = track.getCues();
  assert.equal(cues.length, 4, '骨架 3 句 + 采集到的新句');
  assert.equal(cues[3].primary, 'まったく べつの はなし');
  assert.equal(cues[3].secondary, '完全不同的内容');
});

test('字幕轨道：拿不到官方缓存就退回旧行为（只记录播放过的句子）', async () => {
  const { h, track } = await harness();
  await h.drain();
  await h.drain();

  assert.equal(track.getCues().length, 0, '没有缓存时不会凭空多出句子');

  h.currentTime = 5;
  show(h, 'テスト', '测试');
  assert.equal(track.getCues().length, 1);
  assert.equal(track.getCues()[0].secondary, '测试');

  // 索引读不到时会重试（官方写缓存晚于我们打开面板，见 PLAN 014 的根因），
  // 但**有限**：窗口（SKELETON_MAX_TRIES 次心跳）用完就彻底停手，不跟着心跳一直轮询。
  // ⚠️ 断言在 PLAN 014 里从「≤ 4 次」改为下面这两条：旧值固化了「试 4 次就放弃」的旧语义，
  // 而那正是「列表只看得到播放过的句子」的原因（见该 PLAN 的「为什么改断言」）。
  for (let i = 0; i < 200; i += 1) {
    h.tick();
    await h.drain();
  }
  const indexReads = h.storageReads.filter((key) => key === 'subtitle-cache:index').length;
  assert.ok(indexReads >= 2, `必须真的重试，不能试一次就放弃（实际 ${indexReads} 次）`);
  assert.ok(indexReads <= 61, `重试次数要有上限（实际 ${indexReads} 次）`);
});

test('字幕轨道：换视频后重新找骨架（上一个视频的骨架不能串台）', async () => {
  const { sandbox, h, track } = await harness({ stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();
  assert.equal(track.getCues().length, 3);

  // 切到另一个视频：URL 变了，__llgModTrack.reload() 会重新读轨道与骨架
  sandbox.location.href = 'https://www.youtube.com/watch?v=zzz999';
  await track.reload();
  await h.drain();
  await h.drain();

  assert.equal(track.getCues().length, 0, '新视频既没有本地轨道也没有缓存 → 空轨道');
  assert.equal(track.getMeta().id, 'zzz999');
});

test('字幕轨道：索引里暂时没有本视频时，官方稍后写入仍能被采用', async () => {
  // 索引里有**别的视频**的条目，但还没有当前视频的 —— 这是官方写缓存晚于页面
  // （用户先看过别的视频、本次刚打开这一条）时的常态。
  const otherKey = 'subtitle-cache:v6:other999:ja:primary';
  const { h, track } = await harness({
    stored: {
      'subtitle-cache:index': { entries: [{ key: otherKey, cachedAt: 1000 }] },
      [otherKey]: { cues: SKELETON_CUES },
    },
  });
  await h.drain();
  await h.drain();

  // 改动前这里会永久放弃骨架（空结果被当成「已经列过索引」），列表从此只剩播放过的句子
  assert.equal(track.getCues().length, 0, '官方还没写本视频的缓存 → 现在只有空轨道');

  Object.assign(h.stored, officialCache(SKELETON_CUES));
  h.tick();
  await h.drain();
  await h.drain();

  assert.equal(track.getCues().length, 3, '官方稍后补上的骨架必须能被采用（不能永久放弃）');
  assert.equal(track.getCues()[0].primary, 'おはよう');
});

/**
 * 实测（本机 chrome.storage.local，2026-10-16）：官方索引里只有 13 条，而 storage 里躺着
 * 20 多条 subtitle-cache 值 —— **值比索引活得久**（索引有条数上限与 TTL，被挤掉的是索引条目，
 * 不是值）。索引里没有当前视频的条目时，如果就此放弃，轨道就只剩「播放过的句子」，
 * 进度条的分母退化成「全片时长的中位数」（见 PLAN 014 的根因：实测同一视频里句长
 * 1.3s～5.4s，中位数约 4s —— 1.3s 那句的进度条只走到 32% 就换行了）。
 */
test('字幕轨道：官方索引里没有这条时，直接从 storage 里把骨架捞出来', async () => {
  const key = `subtitle-cache:v6:${VIDEO_ID}:ja:primary`;
  const { h, track } = await harness({
    stored: { [key]: { cues: SKELETON_CUES, videoId: VIDEO_ID, primaryLang: 'ja' } },
  });
  await h.drain();
  await h.drain();

  assert.equal(track.getCues().length, 3, '索引里没有也必须捞到骨架');
  assert.equal(track.getCues()[1].primary, 'きょうは あめ です');
  assert.equal(track.getProgressEnd(), 2.5, '分母是骨架里下一句的真实起点');

  // 播到第一句的中点：官方起点 0 → 2.5 的中点就是 1.25s。
  // 没有骨架的话分母会是 start + 估计时长（首句无样本 → 6s），这里会变成 0.208。
  h.currentTime = 1.25;
  show(h, 'おはよう', '早安');
  assert.equal(track.getProgress(), 0.5, '分母 2.5 来自骨架，不是估计时长');
  assert.equal(track.getCues().length, 3, '采到的句子贴回骨架，不新建');

  const wroteOfficial = h.saved.some((entry) =>
    Object.keys(entry).some((name) => name.startsWith('subtitle-cache:')));
  assert.equal(wroteOfficial, false, '官方缓存只能读，不能写');
});

test('字幕轨道：有 getKeys() 就不搬整份 storage（老版本才退回 get(null)）', async () => {
  const key = `subtitle-cache:v6:${VIDEO_ID}:ja:primary`;
  const { h, track } = await harness({
    withStorageGetKeys: true,
    stored: { [key]: { cues: SKELETON_CUES } },
  });
  await h.drain();
  await h.drain();

  assert.equal(track.getCues().length, 3, '枚举这条路同样要能捞到骨架');
  assert.ok(h.storageGetKeysCalls >= 1, '应当用 getKeys() 列 key');
  assert.equal(
    h.storageReads.filter((name) => name == null).length,
    0,
    '有 getKeys() 就不该把整份 storage 搬进内存',
  );
});

test('字幕轨道：列不到骨架时，枚举 storage 不能变成每次心跳都翻一遍', async () => {
  const { h, track } = await harness({ stored: { 'subtitle-cache:index': { entries: [] } } });
  await h.drain();
  await h.drain();

  for (let i = 0; i < 60; i += 1) {
    h.tick();
    await h.drain();
  }

  assert.equal(track.getCues().length, 0, '确实没有骨架，轨道就只记播放过的句子');
  const enums = h.storageReads.filter((name) => name == null).length;
  assert.ok(enums >= 1, `至少要真的去列一次 storage（实际 ${enums} 次）`);
  assert.ok(enums <= 12, `枚举要限次：60 次心跳不该等于 60 次枚举（实际 ${enums} 次）`);
});

test('标点与空白：字幕文本被归一成单行', async () => {
  const { h, track } = await harness();

  h.currentTime = 3;
  show(h, '  複数   の   空白  ', ' 多  空格 ');
  const lines = track.readLines();
  assert.equal(lines.primary, '複数 の 空白');
  assert.equal(lines.secondary, '多 空格');
});

test('学习面板：时间格式化', async () => {
  const { sandbox } = await harness({ withPanel: true });
  const { fmtClock, fmtSrtTime } = sandbox.__llgModPanel;

  assert.equal(fmtClock(0), '00:00');
  assert.equal(fmtClock(65), '01:05');
  assert.equal(fmtClock(3661), '1:01:01');
  assert.equal(fmtClock(-5), '00:00', '负数要被夹到 0');

  assert.equal(fmtSrtTime(0), '00:00:00,000');
  // 浮点陷阱：21.2 - 21 = 0.19999999999999929，直接取整会写成 ,199
  assert.equal(fmtSrtTime(21.2), '00:00:21,200');
  assert.equal(fmtSrtTime(3661.5), '01:01:01,500');
});

test('学习面板：SRT 导出按标准格式，双语各占一行', async () => {
  const { sandbox } = await harness({ withPanel: true });
  const { toSrt } = sandbox.__llgModPanel;

  const srt = toSrt({
    cues: [
      { start: 5, end: 9, primary: 'こんにちは', secondary: '你好' },
      { start: 9, end: 15, primary: 'さようなら', secondary: '再见' },
    ],
  });

  // 每条以空行分隔，末尾不额外补空行（标准 SRT 的写法）
  assert.equal(
    srt,
    '1\n00:00:05,000 --> 00:00:09,000\nこんにちは\n你好\n'
      + '\n'
      + '2\n00:00:09,000 --> 00:00:15,000\nさようなら\n再见\n',
  );
});

test('学习面板：单语 cue 不产生空行，end 异常时有兜底', async () => {
  const { sandbox } = await harness({ withPanel: true });
  const { toSrt } = sandbox.__llgModPanel;

  // end 为 0 会被当成「没有结束时间」→ 兜底为 start + 3s
  assert.equal(
    toSrt({ cues: [{ start: 2, end: 0, primary: 'はい' }] }),
    '1\n00:00:02,000 --> 00:00:05,000\nはい\n',
  );

  // end 早于 start（拖进度条倒着来时可能出现）→ 至少给 0.5s，不能出现负时长
  assert.equal(
    toSrt({ cues: [{ start: 2, end: 1, primary: 'はい' }] }),
    '1\n00:00:02,000 --> 00:00:02,500\nはい\n',
  );
});

test('学习面板：Markdown 导出的 frontmatter、回跳链接与中日对照', async () => {
  const { sandbox } = await harness({ withPanel: true });
  const { toMarkdown } = sandbox.__llgModPanel;

  const md = toMarkdown({
    meta: { title: 'テスト動画', url: WATCH_URL, id: VIDEO_ID, channel: 'テストch', duration: 600 },
    cues: [
      { start: 65, end: 69, primary: 'こんにちは', secondary: '你好' },
      { start: 70, end: 75, primary: 'さようなら', secondary: '再见' },
    ],
  });
  const lines = md.split('\n');

  assert.equal(lines[0], '---', 'YAML frontmatter 起头');
  assert.ok(md.includes('title: "テスト動画"'));
  assert.ok(md.includes(`source: ${WATCH_URL}`));
  assert.ok(md.includes(`video_id: ${VIDEO_ID}`));
  assert.ok(md.includes('channel: "テストch"'));
  assert.ok(md.includes('duration: "10:00"'));
  assert.ok(md.includes('# テスト動画'), '正文一级标题');
  assert.ok(md.includes('> [在 YouTube 打开]('), '顶部回跳链接');

  // 每句：带时间戳的可点击回跳 + 缩进的译文
  assert.ok(md.includes(`- [\`01:05\`](${WATCH_URL}&t=65s) こんにちは`));
  assert.ok(md.includes('  - 你好'));
  assert.ok(md.includes(`- [\`01:10\`](${WATCH_URL}&t=70s) さようなら`));
  assert.ok(md.includes('  - 再见'));
});

test('学习面板：标题里的引号与反斜杠被转义，不会破坏 frontmatter', async () => {
  const { sandbox } = await harness({ withPanel: true });
  const { toMarkdown } = sandbox.__llgModPanel;

  const md = toMarkdown({
    meta: { title: 'Back\\slash "quoted"', url: WATCH_URL, id: VIDEO_ID },
    cues: [{ start: 1, end: 2, primary: 'a', secondary: 'b' }],
  });

  assert.ok(md.includes('title: "Back\\\\slash \\"quoted\\""'), '需要转义 \\ 与 "');
  assert.equal(md.split('\n').filter((line) => line === '---').length, 2, 'frontmatter 边界只应有两个');
});

test('学习面板：打开时给页面让位（标记 + 宽度变量 + 页面级样式 + 补 resize）', async () => {
  const { h } = await harness({ withPanel: true });
  await h.drain();

  assert.equal(h.panelState(), null, '还没打开时不该有面板 DOM');
  assert.equal(h.panelLayoutOn(), false);

  h.togglePanel();
  await h.drain();

  assert.equal(h.panelState(), 'open');
  assert.equal(h.panelLayoutOn(), true, '打开后 <html> 上要有让位标记');
  assert.equal(h.panelWidthVar(), '401px', '让位时脉冲 +1px：让 YouTube 的 ResizeObserver 看到尺寸变化');

  const style = h.layoutStyle();
  assert.ok(style, '让位样式应注入到 <head>');
  assert.ok(style.textContent.includes('ytd-app'), '让位规则要收窄 ytd-app（实测：这条才让 video 真的缩）');
  assert.ok(style.textContent.includes('var(--llg-panel-w'), '宽度要跟着变量走，拖宽时才不用重写规则');
  assert.ok(style.textContent.includes('!important'), 'YouTube 自己的宽度规则优先级不低，必须压过去');

  h.runTimers();
  assert.equal(h.panelWidthVar(), '400px', '下一拍恢复成面板的真实宽度');
  assert.ok(h.windowEvents.includes('resize'), '顺带补一次 resize 事件（兜底）');

  h.togglePanel();
  await h.drain();

  assert.equal(h.panelState(), 'closed');
  assert.equal(h.panelLayoutOn(), false, '关闭后要撤掉标记，页面恢复原状');
  assert.equal(h.panelWidthVar(), '', '宽度变量也要清掉');
});

test('学习面板：watch 页寄生在推荐列里，不遮挡也不再让位', async () => {
  const { h } = await harness({ withPanel: true, withColumn: true });
  await h.drain();

  h.togglePanel();
  await h.drain();

  assert.equal(h.panelState(), 'open');
  assert.equal(h.panelMode(), 'column', '有推荐列时就寄生在列里（宽度交给 YouTube 算）');

  const node = h.panelHostNode();
  assert.equal(h.column().children[0], node, '宿主要是 #secondary 的第一个子节点（EnglishXYZ 的做法）');

  // 这一组是「不遮挡」的核心：列里再让位 = 双重收窄，推荐列反而会被挤出去
  assert.equal(h.panelLayoutOn(), false, 'column 形态不该给页面让位');
  assert.equal(h.panelWidthVar(), '', 'column 形态没有面板宽度变量');
  assert.equal(h.layoutStyle(), null, 'column 形态连让位样式都不该注入');
  // 内联宽度会盖住 CSS 里的 width:100%，必须清掉，否则面板会 400px 宽地卡在列里
  assert.equal(h.panelRole('panel').style.width, '', 'column 形态不写内联宽度');
});

test('学习面板：没有推荐列（首页/搜索页）时退回悬浮 + 让位', async () => {
  const { h } = await harness({ withPanel: true });
  await h.drain();

  h.togglePanel();
  await h.drain();

  assert.equal(h.panelMode(), 'float', '没有 #columns #secondary 就退回悬浮形态');
  assert.equal(h.panelLayoutOn(), true, '悬浮形态必须让位，否则就是压在页面内容上');
  assert.equal(h.panelHostNode().dataset.mode, 'float');
  assert.equal(h.panelRole('panel').style.width, '400px', '悬浮形态的宽度仍然我们说了算（可拖拽）');
});

test('学习面板：推荐列被 YouTube 重建后，心跳把宿主挂回新列', async () => {
  const { h } = await harness({
    withPanel: true,
    withColumn: true,
    stored: { llgStudyPanel: { open: true } },
  });
  await h.drain();

  const node = h.panelHostNode();
  assert.equal(h.column().children[0], node, '打开时先挂在第一列里');

  // 换视频 / 切布局：YouTube 把整列换掉，宿主跟着被丢
  const next = h.rebuildColumn();
  h.tick();

  assert.equal(next.children[0], node, '心跳要把它挂回新的那一列');
  assert.equal(h.panelMode(), 'column');
  assert.equal(h.panelLayoutOn(), false, '重挂之后仍然不让位');
});

test('学习面板：开关落盘，下次加载自己开回来（常驻）', async () => {
  const first = await harness({ withPanel: true });
  await first.h.drain();

  first.h.togglePanel();
  await first.h.drain();

  const saved = first.h.saved[first.h.saved.length - 1];
  assert.ok(saved, '开关变化要落盘');
  // 逐字段比较：落盘对象是在 vm 沙箱里造的，deepStrictEqual 会因为「跨 realm 的原型不同」而失败
  assert.equal(saved.llgStudyPanel.width, 400, '宽度与开关一起落盘');
  assert.equal(saved.llgStudyPanel.open, true);

  // 刷新 / 换页面 / 扩展重载之后：落盘里是开着的，就自己开回来
  const second = await harness({ withPanel: true, stored: { llgStudyPanel: { width: 420, open: true } } });
  await second.h.drain();

  assert.equal(second.h.panelState(), 'open', '上次开着 → 加载即打开');
  assert.equal(second.h.panelRole('panel').style.width, '420px', '宽度也要恢复');
  second.h.runTimers(); // 恢复时也会脉冲让位，跑完恢复拍再断言宽度
  assert.equal(second.h.panelWidthVar(), '420px');

  // 上次是关着的（或从没记录过）→ 不自动打开，别打扰用户
  const third = await harness({ withPanel: true, stored: { llgStudyPanel: { width: 380, open: false } } });
  await third.h.drain();
  assert.equal(third.h.panelState(), null);
  assert.equal(third.h.panelLayoutOn(), false);

  const fourth = await harness({ withPanel: true });
  await fourth.h.drain();
  assert.equal(fourth.h.panelState(), null, '没有落盘记录时默认关闭');
});

test('学习面板：视频全屏时收起，退出全屏放回来', async () => {
  const { h } = await harness({ withPanel: true });
  await h.drain();
  h.togglePanel();
  await h.drain();
  assert.equal(h.panelLayoutOn(), true);

  h.setFullscreen(true);
  assert.equal(h.panelRole('panel').dataset.fullscreen, '1', '全屏时面板要收起');
  assert.equal(h.panelLayoutOn(), false, '全屏时不该继续压窄页面（实测会把 video 从满屏挤成 960）');
  assert.equal(h.panelRole('panel').dataset.state, 'open', '用户意图不变，只是暂时收起');

  h.setFullscreen(false);
  assert.equal(h.panelRole('panel').dataset.fullscreen, '0');
  assert.equal(h.panelLayoutOn(), true, '退出全屏要恢复让位');

  // YouTube 有时只改自己的标记、不一定进 Fullscreen API —— 心跳兜底
  h.youtubeFullscreen = true;
  h.tick();
  assert.equal(h.panelRole('panel').dataset.fullscreen, '1', 'ytd-watch-flexy[fullscreen] 也要认');
  h.youtubeFullscreen = false;
  h.tick();
  assert.equal(h.panelRole('panel').dataset.fullscreen, '0');
});

test('学习面板：切剧场模式后要补一次 resize（否则 video 尺寸不跟着重算）', async () => {
  const { h } = await harness({ withPanel: true });
  await h.drain();
  h.togglePanel();
  await h.drain();

  h.runTimers(); // 面板打开时那次脉冲的恢复拍
  assert.equal(h.panelWidthVar(), '400px');

  h.tick();
  assert.equal(h.panelWidthVar(), '400px', '第一次心跳只建立布局基线，不该补');

  // 实测：面板开着再切剧场，YouTube 不会按新容器重算 <video> 尺寸（会被面板压住）
  h.theater = true;
  h.tick();
  assert.equal(h.panelWidthVar(), '401px', '剧场标记一变就要再补一次（脉冲）');

  h.runTimers();
  assert.equal(h.panelWidthVar(), '400px');

  h.tick();
  assert.equal(h.panelWidthVar(), '400px', '标记没再变就不该反复补');
});

test('学习面板：滚开之后能一键回到当前句', async () => {
  const { h, track } = await harness({ withPanel: true, withColumn: true });
  await h.drain();
  h.togglePanel();
  await h.drain();

  const follow = h.panelRole('follow');
  assert.equal(follow.dataset.state, 'off', '默认跟随中，按钮收着');

  h.currentTime = 1;
  show(h, 'いち', '一');
  h.currentTime = 3;
  show(h, 'に', '二');
  h.currentTime = 5;
  show(h, 'さん', '三');
  assert.equal(track.getCues().length, 3);

  const list = h.panelRole('list');
  assert.equal(list.children.length, 3, '三句都渲染成了行');

  // 用户滚去看别的句子 → 停止跟随（不然他根本看不了后面的），按钮随之出现
  assert.equal(h.fireOn('list', 'wheel'), true, '列表要能收到滚轮事件');
  assert.equal(follow.dataset.state, 'on', '滚开之后按钮要出现');

  // 点「回到当前句」：走真实点击委托 → 滚到正在播放的那一句（居中）→ 恢复跟随
  for (const row of list.children) row.scrolls.length = 0;
  assert.equal(h.panelAct('follow'), true, '点击委托要能走到 follow');
  assert.equal(follow.dataset.state, 'off', '回到当前句之后按钮收起');
  assert.equal(list.children[2].scrolls.length, 1, '滚的应该是当前句（第 3 句）');
  assert.equal(list.children[2].scrolls[0].block, 'center', '按按钮那一下要居中，让用户看清在哪');
  assert.equal(list.children[0].scrolls.length, 0, '别的行不该被动到');
});

test('学习面板：拖滚动条滚开后同样能一键回到当前句', async () => {
  const { h } = await harness({ withPanel: true, withColumn: true });
  await h.drain();
  h.togglePanel();
  await h.drain();

  h.currentTime = 1;
  show(h, 'いち', '一');
  h.currentTime = 3;
  show(h, 'に', '二');
  h.currentTime = 5;
  show(h, 'さん', '三');

  const list = h.panelRole('list');
  const follow = h.panelRole('follow');

  // 先让面板记住「当前句」（等于播放时的自动跟随把它定位过一次）
  assert.equal(h.panelAct('follow'), true);
  assert.equal(follow.dataset.state, 'off', '还在跟随，按钮收着');

  // 跟随中的程序化滚动（highlight → scrollIntoView）也会发 scroll：
  // 当前行还在视野里 → 不能误关跟随
  list.rect = { top: 0, bottom: 300, left: 0, right: 320 };
  list.children[2].rect = { top: 40, bottom: 80, left: 0, right: 320 };
  assert.equal(h.fireOn('list', 'scroll'), true, '列表要能收到 scroll 事件');
  assert.equal(follow.dataset.state, 'off', '当前行可见 → 不该误关跟随');

  // 拖滚动条把当前句滚出视野（只发 scroll、不发 wheel）→ 按钮浮出来
  list.children[2].rect = { top: 420, bottom: 460, left: 0, right: 320 };
  h.fireOn('list', 'scroll');
  assert.equal(follow.dataset.state, 'on', '当前句滚出视野 → 「回到当前句」要出现');

  // 点它：回到当前句（居中）并恢复跟随
  for (const row of list.children) row.scrolls.length = 0;
  assert.equal(h.panelAct('follow'), true);
  assert.equal(follow.dataset.state, 'off', '回到当前句之后按钮收起');
  assert.equal(list.children[2].scrolls[0].block, 'center', '按按钮那一下要居中');
});

test('学习面板：当前句块排在列表之后（贴在面板底部）', async () => {
  const source = await sourceOf('40-study-panel.js');
  const block = source.match(/const PANEL_HTML = `([\s\S]*?)`;/);
  assert.ok(block, '源码里要有 PANEL_HTML 模板');

  const markup = block[1];
  const listAt = markup.indexOf('data-role="list"');
  const stageAt = markup.indexOf('class="stage"');
  const footAt = markup.indexOf('class="foot"');
  const followAt = markup.indexOf('data-role="follow"');
  assert.ok(listAt >= 0 && stageAt >= 0 && footAt >= 0 && followAt >= 0, '四个区块都要在');

  assert.ok(listAt < stageAt, '当前句块要排在列表之后（沉到面板底部，与原生字幕同高）');
  assert.ok(stageAt < footAt, '当前句块要在页脚之上');
  assert.ok(followAt > listAt && followAt < stageAt, '「回到当前句」挂在列表区域里（不再占 header）');
});

test('学习面板：把功能登记进设置面板注册表', async () => {
  const { h } = await harness({ withPanel: true });

  const ids = h.features.map((f) => f.id);
  assert.ok(ids.includes('studyPanel'), '学习面板应登记为可开关功能');

  const feature = h.features.find((f) => f.id === 'studyPanel');
  assert.equal(feature.isOn(), false, '默认是关闭的');
  assert.equal(typeof feature.toggle, 'function');
  assert.ok(feature.actions.length >= 3, '应带上导出 / 复制 / 清空等操作行');
  for (const action of feature.actions) {
    assert.ok(action.id && action.title && action.icon, '操作行必须有 id / 标题 / 图标');
  }
});

// ---------------------------------------------------------------- 桌面字幕常驻

/**
 * PLAN 025 改了默认值：用户选择「视频内嵌字幕优先」——官方那层字幕本来就在画面里
 * （还能点词查词），没表过态时不该再自动多弹一扇系统窗口。
 *
 * ⚠️ 这条用例**替换**了原来的「桌面字幕：默认开启，但要等第一次用户手势才真正开窗」
 * （旧断言固化了 PLAN 016 的旧语义「默认开启」，而本轮需求就是改掉它）。
 * 旧用例想守住的另一半「开启之后要等第一次用户手势、且落盘」在新用例里继续断言。
 */
test('桌面字幕：默认关闭（视频内嵌字幕优先），没开过就不弹窗', async () => {
  const { sandbox, h } = await harness({ withPip: true, noPipStored: true });
  const pip = sandbox.__llgModPip;
  await h.drain();

  assert.equal(pip.isEnabled(), false, '没表过态时默认是关的（画面里的官方字幕优先）');
  assert.equal(pip.isOpen(), false);
  assert.equal(h.pip.requestCount, 0, '加载时不能硬开');

  // 默认关着 → 页面手势也不该把窗口顶出来（否则「默认关闭」形同虚设）
  h.gesture();
  await h.drain();
  assert.equal(h.pip.requestCount, 0, '没开过的功能不许被手势自动打开');
  assert.equal(pip.isOpen(), false);

  // 用户显式打开：走设置面板开关那条真实路径
  const feature = h.features.find((f) => f.id === 'desktopSubtitles');
  assert.ok(feature, '桌面字幕应登记为可开关功能');
  h.withActivation(() => feature.toggle());
  await h.drain();

  assert.equal(pip.isOpen(), true);
  assert.equal(h.pip.lastOptions.disallowReturnToOpener, true, '不给「返回标签页」按钮');
  assert.equal(h.saved.at(-1).llgPip.enabled, true, '开了之后要落盘，下次自己回来');
});

test('桌面字幕：切回浏览器时被 UA 关掉，下一次手势把它接回来', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();
  const first = h.lastPipWindow();

  h.setVisibility('hidden');
  h.setVisibility('visible'); // 用户切回浏览器（hidden → visible 的跃迁）
  first.fire('pagehide');     // UA 就在这一刻把它关了
  await h.drain();

  // UA 关窗与「文档卸载」一样不带瞬时激活，这一刻 requestWindow() 必然被拒 ——
  // 所以不去撞它，静默武装等下一次手势（见 open() 的 hasActivation()）
  assert.equal(h.pip.requestCount, 1, '没有激活就别试着开');
  assert.equal(pip.isOpen(), false);
  assert.equal(pip.isEnabled(), true, '这次不是用户关的，开关要保持开着');

  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true, '下一次手势就回来');
  assert.equal(h.pip.requestCount, 2);
});

test('桌面字幕：显式关闭之后不再自动弹回来', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();

  pip.close(); // 用户点了控制栏里的「关闭桌面字幕」
  await h.drain();

  assert.equal(pip.isEnabled(), false);
  assert.equal(pip.isOpen(), false);
  assert.equal(h.saved.at(-1).llgPip.enabled, false, '关掉也要落盘');

  h.gesture();
  await h.drain();
  assert.equal(h.pip.requestCount, 1, '关掉之后任何手势都不许再开');
});

test('桌面字幕：点 PiP 窗口自己的 X 关不掉它（只有按钮才算关闭）', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true);

  // 页面一直可见地把窗口关掉：可能是用户点了 X，也可能是文档正在卸载（刷新/导航）——
  // 两者在 pagehide 里区分不了，所以一律不当作关闭
  h.lastPipWindow().fire('pagehide');
  await h.drain();

  assert.equal(pip.isEnabled(), true, '点 X 不算关闭，开关要保持开着');
  assert.ok(
    !h.saved.some((entry) => entry.llgPip && entry.llgPip.enabled === false),
    'pagehide 里绝不允许把常驻开关写成关（刷新页面就会走到这里）',
  );

  // 「回来」要等一次手势：点 X 的那一下落在 PiP 窗口的文档上，opener 文档没有瞬时激活，
  // requestWindow() 此刻开不出来（旧断言假定它立刻就能开回来 —— 那是桩不检查激活的假象）
  assert.equal(h.pip.requestCount, 1);
  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true, '下一次手势就回来');
  assert.equal(h.pip.requestCount, 2);
});

test('桌面字幕：窗口被系统悄悄销毁（pagehide 没走到我们这里）时，心跳把它弄回来', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true);

  h.pip.window = null; // 系统直接销毁，pagehide 没送到我们手里
  h.tick();
  await h.drain();

  // 心跳发现 pipWin 与实际不一致 → 清干净状态并武装；但定时器回调里没有用户激活，
  // requestWindow() 此刻开不出来，所以要等下一次手势（旧断言假定心跳能直接开回来）
  assert.equal(pip.isOpen(), false);
  assert.equal(h.pip.requestCount, 1);

  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true, '下一次手势把它接回来');
  assert.equal(h.pip.requestCount, 2);
});

test('桌面字幕：还不是播放页时的第一次手势不会被丢掉', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  // 从首页点视频封面的那一刻：SPA 导航还没完成，页面上还没有 #movie_player
  h.hasMoviePlayer = false;
  h.gesture();
  await h.drain();
  assert.equal(h.pip.requestCount, 0, '还不是播放页，不能开窗');

  // 导航完成后，用户下一次点击就该接住 —— 不靠 1s 心跳重新武装
  h.hasMoviePlayer = true;
  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true);
  assert.equal(h.pip.requestCount, 1);
});

test('桌面字幕：判据是「播放页里有 video」，不再看 pathname（直播页也能开）', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  sandbox.location.pathname = '/live/abc123'; // 直播页同样有 #movie_player
  h.gesture();
  await h.drain();

  assert.equal(pip.isOpen(), true);
  assert.equal(h.pip.requestCount, 1);
});

test('桌面字幕：恢复时没有用户手势，就等到下一次手势', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();

  // 刷新 / 真导航 / 系统悄悄收走窗口：这一刻都没有瞬时激活
  h.setVisibility('hidden');
  h.setVisibility('visible');
  h.lastPipWindow().fire('pagehide');
  await h.drain();

  assert.equal(pip.isOpen(), false);
  assert.equal(
    h.pip.requestCount, 1,
    '没有激活就别去撞 requestWindow（必然被拒，还会刷一条红字），直接等手势',
  );

  h.gesture(); // 下一次手势把它接住
  await h.drain();

  assert.equal(pip.isOpen(), true);
  assert.equal(h.pip.requestCount, 2);
});

test('桌面字幕：有激活但被系统拒绝时，仍然等到下一次手势', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.pip.deny = true; // requestWindow 被系统拒绝
  h.gesture();       // 但这次手势确实带着瞬时激活
  await h.drain();

  assert.equal(h.pip.requestCount, 1, '有激活就该试一次，失败了才等下一次');
  assert.equal(pip.isOpen(), false);

  h.pip.deny = false;
  h.gesture();
  await h.drain();

  assert.equal(pip.isOpen(), true);
  assert.equal(h.pip.requestCount, 2);
});

test('桌面字幕：窗口被浏览器收走后，控制栏按钮那一下是「开回来」而不是把常驻开关关掉', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true);

  // 浏览器把窗口收走了，而 pagehide 还没送到我们手里（心跳也还没跑到）—— pipWin 是陈旧的
  h.pip.window = null;

  const btn = h.buttons.get('llg-pip-btn');
  assert.ok(btn, '控制栏按钮要注册过（它的 onClick 是这条逻辑唯一的入口）');
  h.withActivation(() => btn.onClick()); // 用户点控制栏按钮，这一下带着瞬时激活
  await h.drain();

  assert.equal(pip.isEnabled(), true, '这一次不是用户要关它，常驻开关必须保持开着');
  assert.ok(
    !h.saved.some((entry) => entry.llgPip && entry.llgPip.enabled === false),
    '绝不允许把常驻开关写成关（旧写法走 close()，功能就这么被关掉了）',
  );
  assert.equal(h.pip.requestCount, 2, '这一点应该用来把窗口开回来');
  assert.equal(pip.isOpen(), true);
});

test('桌面字幕：回到浏览器本体时，那一下带着激活就当场把窗口开回来', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true);

  // ① 切回标签页（visibilitychange）：窗口已被浏览器收走，本地 pipWin 陈旧。
  //    用户是「点着页面回来」的 → 这一刻还在瞬时激活有效期内 → 应当当场开回来
  h.pip.window = null;
  h.withActivation(() => h.setVisibility('visible'));
  await h.drain();

  assert.equal(pip.isOpen(), true, '可见性回来的那一下就该把它接回来');
  assert.equal(h.pip.requestCount, 2);

  // ② 窗口重新获得焦点（window focus）：从别的应用点回来时 visibilityState 未必跃迁，
  //    光靠 visibilitychange 会漏掉这个时机
  h.pip.window = null;
  h.setVisibility('hidden');
  h.withActivation(() => h.focus());
  await h.drain();

  assert.equal(pip.isOpen(), true, '焦点回来的那一下同样要接');
  assert.equal(h.pip.requestCount, 3);
});

test('桌面字幕：窗口自称 closed（API 的引用还没更新）时，心跳清干净并武装', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();

  // 窗口已经从内部关掉了，但 documentPictureInPicture.window 还指着它 ——
  // 只比身份的判据会以为「一切正常」，窗口就永远回不来
  h.lastPipWindow().closed = true;
  h.tick();
  await h.drain();

  assert.equal(pip.isOpen(), false, '心跳要把陈旧的状态清掉');
  assert.equal(pip.isEnabled(), true, '这不是用户关的，开关保持开着');
  assert.equal(h.pip.requestCount, 1, '心跳里没有瞬时激活，不能硬开');

  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true, '下一次手势接回来');
  assert.equal(h.pip.requestCount, 2);
});

test('桌面字幕：只有页面上的普通手势才预开，我们自己的按钮/开关不抢跑', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  // ① 控制栏里的「桌面字幕」按钮：这一下点击归按钮自己的 onClick，
  //    arm() 若在 pointerdown 阶段先 open()，紧接着的 click 就会看到「已经开着」
  //    而把它 close() 掉（还会把 enabled 落盘成关）
  const btn = { nodeType: 1, id: 'llg-pip-btn', closest: () => null };
  h.gesture('pointerdown', { composedPath: () => [btn] });
  await h.drain();
  assert.equal(h.pip.requestCount, 0, '按钮上的手势不许预开');
  assert.equal(pip.isEnabled(), true, '也不许被谁写成关');

  // ② 设置面板里的开关：它自己就是 [data-llg-toggle]。真实 DOM 里它在 Linglass 的
  //    shadowRoot 内，事件冒到 document 时 target 已被重定向成宿主元素 ——
  //    只有 composedPath() 能看见它，所以判据必须走 composedPath()
  const toggle = { nodeType: 1, id: '' };
  toggle.closest = (sel) => (sel === '[data-llg-toggle]' ? toggle : null);
  h.gesture('pointerdown', { composedPath: () => [toggle] });
  await h.drain();
  assert.equal(h.pip.requestCount, 0, '开关上的手势同样不许预开');

  // ③ 页面上的普通手势（点播放器区域之类）：照旧预开 —— 上面两条只挡我们自己的 UI
  const blank = { nodeType: 1, id: 'somewhere-on-the-page', closest: () => null };
  h.gesture('pointerdown', { composedPath: () => [blank] });
  await h.drain();
  assert.equal(pip.isOpen(), true, '普通手势该开就开');
  assert.equal(h.pip.requestCount, 1);
});

test('桌面字幕：落盘里关掉的开关，下次加载不会被重新打开', async () => {
  const { sandbox, h } = await harness({
    withPip: true,
    stored: { llgPip: { enabled: false } },
  });
  const pip = sandbox.__llgModPip;
  await h.drain();

  assert.equal(pip.isEnabled(), false);

  h.gesture();
  await h.drain();
  assert.equal(h.pip.requestCount, 0, '用户明确关过的东西不许自作主张打开');
});

// ---------------------------------------------------------------- 浮窗的进度与分隔符

const SEGMENTED = '昨日\u2009|\u2009買った\u2009|\u2009本を\u2009|\u2009読む';

test('桌面字幕：原文行按文节插分隔符，并跟随视频内断句的开关', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  assert.equal(pip.displayPrimary('昨日買った本を読む'), SEGMENTED);

  h.jaBreakEnabled = false;
  assert.equal(pip.displayPrimary('昨日買った本を読む'), '昨日買った本を読む', '断句关着就不插');
  assert.equal(pip.displayPrimary('hello world'), 'hello world', '非日语原样放过');
  assert.equal(pip.displayPrimary(''), '');
});

test('桌面字幕：浮窗原文行真的带上了分隔符', async () => {
  const { sandbox, h } = await harness({ withPip: true });

  h.currentTime = 5;
  show(h, '昨日買った本を読む', '昨天买的书');
  await h.drain();

  h.gesture();
  await h.drain();

  assert.equal(h.pipText(), '昨日|買った|本を|読む', '渲染出来的是分隔符节点拼回去的文本');
  assert.equal(sandbox.__llgModPip.displayPrimary('昨日買った本を読む'), SEGMENTED,
    '给探针看的那份拼接带窄空格，读起来才有间距');

  // 中途关掉视频内的断句 → 心跳把浮窗重绘成干净原文（去重键里带了开关状态）
  h.jaBreakEnabled = false;
  h.tick();
  assert.equal(h.pipText(), '昨日買った本を読む');
  assert.equal(sandbox.__llgModPip.isOpen(), true);
});

// ---------------------------------------------------------------- 浮窗的振假名

test('桌面字幕：官方原文行带注音时，浮窗渲染成 ruby（跟随官方）', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  h.jaBreakEnabled = false;

  h.currentTime = 5;
  showRuby(h, [
    { text: '夜', ruby: 'よる' },
    { text: 'に' },
    { text: '本', ruby: 'ほん' },
    { text: 'を' },
  ], '晚上看书');
  await h.drain();

  h.gesture();
  await h.drain();

  const segments = h.pipSegments();
  assert.deepEqual(segments.map((seg) => seg.text), ['夜', 'に', '本', 'を']);
  assert.deepEqual(segments.map((seg) => seg.ruby), ['よる', '', 'ほん', ''],
    '有注音的片段渲染成 <ruby><rt>，其余是普通文本');
  assert.equal(h.pipText(), '夜に本を', '注音不算原文（与字幕轨道同一口径）');
});

test('桌面字幕：官方原文行没有注音时，浮窗一个字符都不变', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  h.jaBreakEnabled = false;

  h.currentTime = 5;
  show(h, '夜に本を', '晚上看书');
  await h.drain();

  h.gesture();
  await h.drain();

  const segments = h.pipSegments();
  assert.equal(segments.length, 1, '没有注音就走原来的纯文本路径');
  assert.equal(segments[0].ruby, '');
  assert.equal(h.pipText(), '夜に本を');
});

test('桌面字幕：注音与文节分隔符共存，切点落在注音片段内时放弃那个切点', async () => {
  const { sandbox, h } = await harness({ withPip: true });

  h.currentTime = 5;
  showRuby(h, [
    { text: '昨日', ruby: 'きのう' },
    { text: '買った' },
    { text: '本', ruby: 'ほん' },
    { text: 'を' },
    { text: '読む' },
  ], '昨天买了书');
  await h.drain();

  h.gesture();
  await h.drain();

  assert.equal(h.pipText(), '昨日|買った|本を|読む', '分隔符与注音在同一行里共存');
  const rubies = h.pipSegments()
    .filter((seg) => seg.ruby)
    .map((seg) => `${seg.text}/${seg.ruby}`);
  assert.deepEqual(rubies, ['昨日/きのう', '本/ほん']);

  // 切点落在带注音的片段内部：放弃这个分隔符，但绝不把带注音的汉字切成两半
  const segs = sandbox.__llgModPip.richSegments(
    [{ text: '昨日', ruby: 'きのう' }, { text: '買った', ruby: '' }],
    [1, 4],
  );
  assert.equal(segs.length, 2);
  assert.equal(segs[0].map((token) => token.text).join(''), '昨日買っ');
  assert.equal(segs[1].map((token) => token.text).join(''), 'た');
});

// ---------------------------------------------------------------- 浮窗跟随官方外观

/** 官方外观设置：chrome.storage.sync 的 linglass-settings（zustand persist 的形态） */
const APPEARANCE = {
  version: 4,
  state: {
    subtitleStyle: 'classic',
    subtitleScale: 100,
    subtitleColor: '#FFFFFF',
    dualSubtitles: true,
    learningLanguage: 'ja',
    nativeLanguage: 'zh',
  },
};

/** 改其中几项，其余保持官方默认 */
function withAppearance(patch) {
  return { ...APPEARANCE, state: { ...APPEARANCE.state, ...patch } };
}

test('桌面字幕：浮窗外观首次从官方拷来当初始值，之后官方再改都不动', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE });
  const pip = sandbox.__llgModPip;
  await h.drain();

  // 官方 100% 档：基座 24px，原文行（日语算 CJK）27px、译文行 20px
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 27px/);
  assert.match(pip.pipCss(), /#line-secondary \{[^}]*font-size: 20px/);
  assert.doesNotMatch(pip.pipCss(), /clamp\(|vw/, '字号不许跟浮窗尺寸走');

  // 首次播种要落盘，而且存的是**完整四项** —— 完全独立之后缺项没法再去官方补
  const seeded = h.saved.find((entry) => entry.llgPipAppearance);
  assert.ok(seeded, '首次打开要把官方的当前值播种进落盘');
  assert.deepEqual({ ...seeded.llgPipAppearance },
    { style: 'classic', scale: 100, color: '#FFFFFF', dual: true, ctxLines: pip.CTX_DEFAULT });

  // 官方那边怎么改都不动了（PLAN 027：浮窗完全独立）
  h.changeSettings(withAppearance({ subtitleScale: 150, subtitleColor: '#FFD60A' }));
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 27px/, '字号不跟官方');
  assert.match(pip.pipCss(), /#line-primary \{[^}]*color: #FFFFFF/, '颜色也不跟官方');
});

test('桌面字幕：官方那份读不成/读坏了时，播种用默认值（不是拿脏值当初值）', async () => {
  // 落盘是 JSON 字符串（zustand persist 的另一种形态）也要认；档位是 0 → 退回默认 100%
  const { sandbox, h } = await harness({
    withPip: true,
    settings: JSON.stringify(withAppearance({ subtitleScale: 0, subtitleStyle: 'nope' })),
  });
  await h.drain();

  const seeded = h.saved.find((entry) => entry.llgPipAppearance);
  assert.equal(seeded.llgPipAppearance.scale, 100, '档位被写坏 → 官方默认 100%');
  assert.equal(sandbox.__llgModPip.appearanceOwn().style, 'classic', '预设不认得 → 默认 classic');
  assert.match(sandbox.__llgModPip.pipCss(), /#line-primary \{[^}]*font-size: 27px/);

  // 官方那份整个读不到（被裁剪的包 / 首次安装）→ 同样退回默认值
  const bare = await harness({ withPip: true });
  await bare.h.drain();
  assert.equal(bare.sandbox.__llgModPip.appearanceOwn().scale, 100);
});

test('桌面字幕：落盘里有浮窗外观时就用它，官方那份已经无关', async () => {
  const { sandbox, h } = await harness({
    withPip: true,
    settings: withAppearance({ subtitleScale: 150 }),
    stored: {
      llgPipAppearance: { style: 'contrast', scale: 130, color: '#64D2FF', dual: false },
    },
  });
  const pip = sandbox.__llgModPip;
  await h.drain();

  // 130% → 基座 31.2，原文行 31.2 × 27/24 = 35.1（官方那边是 150%，照样不管）
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 35\.1px/);
  assert.match(pip.pipCss(), /#line-primary \{[^}]*color: #64D2FF/);
  assert.match(pip.pipCss(), /\.kline \{[^}]*background: rgba\(0, 0, 0, 0\.88\)/,
    'contrast 是逐行底板');
  assert.ok(
    !h.saved.some((entry) => entry.llgPipAppearance),
    '落盘里已经有 → 既不重写也不拿官方覆盖',
  );
});

test('桌面字幕：窗口能拖小（内容里不许有固有最小尺寸）', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE });
  const pip = sandbox.__llgModPip;
  await h.drain();

  const css = pip.pipCss();

  // 控制栏那排按钮曾经写死 42px（toggle 54px）：六个按钮 + 间距 + 内边距 ≈ 320px，
  // 等于给 PiP 窗口设了一个拖不下去的下限
  assert.doesNotMatch(css, /#bar button \{[^}]*min-width: 42px/, '按钮不许写死最小宽度');
  assert.doesNotMatch(css, /#pip-toggle \{[^}]*min-width: 54px/, 'toggle 也不许写死');
  assert.match(css, /#bar button \{[^}]*min-width: 0/, '按钮要能跟着窗口一起收窄');
  assert.match(css, /#bar button \{[^}]*white-space: nowrap/, '收窄时不许折行');

  // flex 子项默认 min-width: auto，会被内容的 min-content 撑住 —— 链条上每一环都要解除
  for (const sel of ['#box', '#stage', '#plate', '\\.kline']) {
    assert.match(css, new RegExp(`${sel} \\{[^}]*min-width: 0`), `${sel} 要解除固有最小尺寸`);
  }
});

test('桌面字幕：开窗尺寸贴合内容，不再写死 1000×264', async () => {
  const { h } = await harness({ withPip: true, settings: APPEARANCE });
  await h.drain();
  h.gesture();
  await h.drain();

  // 100% 档 + classic 底板 + 双语 + 默认 1 段上下文行（下一句的原文与译文各 ×0.8）≈ 202px
  // （旧的 264 上下各留一大块空白；只有当前句时是 145px 上下）
  const fit = h.pip.lastOptions;
  assert.ok(fit.height > 180 && fit.height < 230, `默认高度要贴合内容，实际 ${fit.height}`);
  assert.ok(fit.width < 1000, '宽度不该再留一大块黑边');

  // 字号不跟窗口走 → 窗口就得跟字号走：150% 档那次开窗必须明显更高
  const big = await harness({ withPip: true, settings: withAppearance({ subtitleScale: 150 }) });
  big.h.gesture();
  await big.h.drain();
  assert.ok(
    big.h.pip.lastOptions.height > fit.height + 10,
    `档位调大后默认高度要跟着长（${big.h.pip.lastOptions.height} vs ${fit.height}）`,
  );

  // 上下文行数也要进高度（PLAN 029）：少了矮一截，多了高一截
  const asOwn = (ctxLines) => ({
    llgPipAppearance: { style: 'classic', scale: 100, color: '#FFFFFF', dual: true, ctxLines },
  });
  const none = await harness({ withPip: true, settings: APPEARANCE, stored: asOwn(0) });
  none.h.gesture();
  await none.h.drain();
  assert.ok(
    none.h.pip.lastOptions.height < fit.height - 30,
    `contextLines=0 该矮一截（${none.h.pip.lastOptions.height} vs ${fit.height}）`,
  );

  const both = await harness({ withPip: true, settings: APPEARANCE, stored: asOwn(2) });
  both.h.gesture();
  await both.h.drain();
  assert.ok(
    both.h.pip.lastOptions.height > fit.height + 30,
    `contextLines=2 该高一截（${both.h.pip.lastOptions.height} vs ${fit.height}）`,
  );
});

test('桌面字幕：样式条上改字号/预设/颜色/双语立即生效并落盘', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE });
  const pip = sandbox.__llgModPip;

  h.currentTime = 5;
  show(h, 'テスト', '测试');
  await h.drain();
  h.gesture();
  await h.drain();

  // 播种自官方 classic：整块底板 + 译文行同色 ×.75 + 日语原文行加粗一档
  const classic = h.pipCss();
  assert.match(classic, /#line-primary \{[^}]*color: #FFFFFF/);
  assert.match(classic, /#line-primary \{[^}]*font-weight: 600/, '日语原文行加粗一档（500 + 100）');
  assert.match(classic, /#line-secondary \{[^}]*color: rgba\(255, 255, 255, 0\.75\)/,
    'classic 的译文行是同色 ×.75（官方 secondaryAlpha）');
  assert.match(classic, /#plate \{[^}]*background: linear-gradient/, 'classic 的底板画在整块上');

  // 字号：走真实的点击链路（data-act → command），改一档就生效 + 落盘 + 回显
  h.pipClick('scale+');
  assert.equal(pip.appearanceOwn().scale, 110);
  assert.match(h.pipCss(), /#line-primary \{[^}]*font-size: 29\.7px/, '110% → 26.4 × 27/24');
  assert.equal(h.saved.at(-1).llgPipAppearance.scale, 110, '改一下就要落盘');
  assert.equal(h.pipButton('scale-val').textContent, '110%', '样式条回显当前档位');
  h.pipClick('scale-');
  assert.equal(pip.appearanceOwn().scale, 100, '减回去');

  // 预设：cinema 不画底板，改用描边；选中的那个按钮要有标记
  h.pipClick('style:cinema');
  assert.doesNotMatch(h.pipCss(), /#plate \{[^}]*background/, 'cinema 不画底板');
  assert.match(h.pipCss(), /#line-primary \{[^}]*paint-order: stroke fill/, 'cinema 靠描边保证可读');
  assert.equal(h.pipButton('pip-style-cinema').dataset.on, '1');
  assert.equal(h.pipButton('pip-style-classic').dataset.on, undefined, '没选中的不能有标记');

  // 颜色：小写也认，但生效与落盘一律大写
  h.pipClick('color:#ffd60a');
  assert.match(h.pipCss(), /#line-primary \{[^}]*color: #FFD60A/);
  assert.equal(h.pipButton('pip-color-FFD60A').dataset.on, '1');
  assert.equal(pip.appearanceOwn().color, '#FFD60A');

  // 双语：浮窗自己的开关（不再只能跟官方）
  h.pipClick('dual');
  assert.equal(h.pipButton('line-secondary').textContent, '', '关掉就不渲染译文行');
  assert.equal(h.pipButton('pip-dual').dataset.on, undefined);
  h.pipClick('dual');
  assert.equal(h.pipButton('line-secondary').textContent, '测试', '再打开就回来');
  assert.equal(h.pipButton('pip-dual').dataset.on, '1');

  // 脏值挡在 command 里（不是靠 UI 藏起来）：不认得的预设 / 颜色一律不生效、不落盘
  const before = h.saved.length;
  const styleBefore = pip.appearanceOwn().style;
  h.pipClick('style:nope');
  h.pipClick('color:#123456');
  assert.equal(pip.appearanceOwn().style, styleBefore, '不认得的预设不生效');
  assert.equal(pip.appearanceOwn().color, '#FFD60A', '不在色板里的颜色不生效');
  assert.equal(h.saved.length, before, '也不许写进落盘');
});

test('桌面字幕：样式条与控制栏互斥，字幕区一个节点都不动', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE });
  const pip = sandbox.__llgModPip;

  h.currentTime = 5;
  show(h, 'テスト', '测试');
  await h.drain();
  h.gesture();
  await h.drain();

  assert.equal(pip.barMode(), 'play');
  assert.equal(h.pipButton('bar').style.display, '');
  assert.equal(h.pipButton('stylebar').style.display, 'none', '默认收起');

  h.pipClick('appearance');
  assert.equal(pip.barMode(), 'style');
  assert.equal(h.pipButton('bar').style.display, 'none');
  assert.equal(h.pipButton('stylebar').style.display, '');
  assert.equal(h.pipText(), 'テスト', '切换不动字幕');

  h.pipClick('appearance');
  assert.equal(pip.barMode(), 'play');
  assert.equal(h.pipButton('bar').style.display, '');

  // 窗口被 UA 关掉、再过一次手势重开：新窗口从播放控制栏开始，不继承上一扇窗的状态
  h.pipClick('appearance');
  h.lastPipWindow().fire('pagehide');
  await h.drain();
  h.gesture();
  await h.drain();

  assert.equal(pip.isOpen(), true);
  assert.equal(pip.barMode(), 'play', '新窗口从播放控制栏开始');
  assert.equal(h.pipButton('stylebar').style.display, 'none');
});

test('桌面字幕：↺ 把官方当前的设置重新拷一份当浮窗样式', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE });
  const pip = sandbox.__llgModPip;

  h.currentTime = 5;
  show(h, 'テスト', '测试');
  await h.drain();
  h.gesture();
  await h.drain();

  pip.setAppearanceOwn({ scale: 150, color: '#FFD60A' });
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 40\.5px/);

  // 官方那边改成 60% / 绿色：浮窗常态下不跟它，但「复位」要把官方此刻的值请回来
  h.changeSettings(withAppearance({ subtitleScale: 60, subtitleColor: '#30D158' }));
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 40\.5px/, '常态下不跟官方');

  h.pipClick('reset');
  assert.match(pip.pipCss(), /#line-primary \{[^}]*color: #30D158/);
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 16\.2px/, '60% → 14.4 × 27/24');
  assert.equal(h.saved.at(-1).llgPipAppearance.scale, 60, '复位也要落盘');
});

test('桌面字幕：语言仍然跟随官方（换语言要换字面与字号比例）', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE });
  const pip = sandbox.__llgModPip;
  await h.drain();

  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 27px/, '日语算 CJK：放大一档');
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-weight: 600/);

  h.changeSettings(withAppearance({ learningLanguage: 'en' }));
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 24px/, '换成英语：不再放大');
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-weight: 500/);

  // 只改样式时（浮窗不跟）样式表一字不改 —— 语言没变就不该白重画
  const before = pip.pipCss();
  h.changeSettings(withAppearance({ learningLanguage: 'en', subtitleScale: 150 }));
  assert.equal(pip.pipCss(), before);
});

test('桌面字幕：落盘里的浮窗外观被写坏时逐项夹回合法值', async () => {
  const { sandbox, h } = await harness({
    withPip: true,
    settings: APPEARANCE,
    stored: {
      llgPipAppearance: { style: 'nope', scale: 999, color: 'not-a-color', dual: 'yes' },
    },
  });
  const pip = sandbox.__llgModPip;
  await h.drain();

  assert.deepEqual({ ...pip.appearanceOwn() },
    { style: 'classic', scale: 150, color: '#FFFFFF', dual: true, ctxLines: pip.CTX_DEFAULT },
    '逐项兜底，不是整份丢掉');

  // 一半坏一半好：好的那项要保住（上下文行数不在落盘里 → 走默认 1）
  assert.deepEqual({ ...pip.parseOwn({ style: 'cinema', scale: 'x' }) },
    { style: 'cinema', scale: 100, color: '#FFFFFF', dual: true, ctxLines: 1 });

  // 上下文行数也要夹：负数 / 99 / 小数 / 字符串都不许原样进来
  assert.equal(pip.parseOwn({ ctxLines: -5 }).ctxLines, 0);
  assert.equal(pip.parseOwn({ ctxLines: 99 }).ctxLines, pip.CTX_MAX);
  assert.equal(pip.parseOwn({ ctxLines: 1.4 }).ctxLines, 1);
  assert.equal(pip.parseOwn({ ctxLines: '2' }).ctxLines, pip.CTX_DEFAULT, '字符串不当数字用');

  // 整个值读不成 / 压根没存过（首次打开）→ null，交给调用方拿官方播种
  assert.equal(pip.parseOwn(null), null);
  assert.equal(pip.parseOwn(undefined), null);
  assert.equal(pip.parseOwn('classic'), null);
});

test('桌面字幕：分隔符是独立节点，观感与视频内那套一致', async () => {
  const { h } = await harness({ withPip: true, settings: APPEARANCE });
  await h.drain();

  h.currentTime = 5;
  show(h, '昨日買った本を読む', '昨天买的书');
  await h.drain();
  h.gesture();
  await h.drain();

  const segments = h.pipSegments();
  assert.deepEqual(segments.map((s) => s.text), ['昨日', '|', '買った', '|', '本を', '|', '読む']);
  assert.equal(segments.filter((s) => s.sep).length, 3, '三个断点各一个分隔符节点');
  assert.deepEqual(
    segments.filter((s) => !s.sep).map((s) => s.text),
    ['昨日', '買った', '本を', '読む'],
    '文节自己不带分隔符',
  );
  assert.match(
    h.pipCss(),
    /\.llg-sep \{ margin: 0 \.14em; opacity: \.42; font-weight: 400; \}/,
    '分隔符吃的是 15-ja-break.js 视频内那套参数',
  );
});

test('桌面字幕：浮窗进度条按新的分母走', async () => {
  const { h } = await harness({ withPip: true });

  h.currentTime = 10;
  show(h, 'テスト', '测试');
  await h.drain();

  h.gesture();
  await h.drain();
  assert.equal(h.pipFill(), '0%', '刚开窗时还没播');

  h.currentTime = 13;
  h.tick();
  assert.equal(h.pipFill(), '50%', '3 / 6，而不是旧实现的 100%');
});

// ---------------------------------------------------------------- 浮窗的上下文行

test('桌面字幕：默认只显示下一句，且下一句只有原文（译文要等它被播到过）', async () => {
  const { h } = await harness({ withPip: true, settings: APPEARANCE, stored: officialCache(SKELETON_CUES) });
  h.jaBreakEnabled = false;
  await h.drain();
  await h.drain();

  h.currentTime = 0.2;
  show(h, 'おはよう', '早安');
  await h.drain();
  h.gesture();
  await h.drain();

  assert.equal(h.pipText(), 'おはよう');
  assert.equal(h.pipButton('line-secondary').textContent, '早安');

  // 默认档位 1 = 当前句 + 下一句
  assert.equal(h.pipButton('next').style.display, '', '默认要显示下一句');
  assert.equal(h.pipLineText('next-primary'), 'きょうは あめ です', '原文来自整条轨');
  assert.equal(h.pipLineText('next-secondary'), '',
    '官方缓存里没有译文 —— 这句还没被播到过');
  assert.equal(h.pipButton('prev').style.display, 'none', '档位 1 时上一句要收起来');

  // 上下文行：字号 0.8×、不透明度 55%，且不给底板 / 不给注音
  assert.match(h.pipCss(), /#next-primary \{[^}]*font-size: 21\.6px/, '27 × 0.8');
  assert.match(h.pipCss(), /#next-secondary \{[^}]*font-size: 16px/, '20 × 0.8');
  // 「淡」在块上（整段一起淡），只有当前句不透明；悬停提亮一档，明示点得动
  assert.match(h.pipCss(), /\.ctx \{[^}]*opacity: \.4/, '上下文行整段压到 .4');
  assert.match(h.pipCss(), /\.ctx:hover \{ opacity: \.75; \}/);
  assert.doesNotMatch(h.pipCss(), /#next-primary \{[^}]*opacity/, '别在行上再淡一次');
  assert.doesNotMatch(h.pipCss(), /#prev \{[^}]*background/, '上下文行不画底板');
});

test('桌面字幕：档位拉到 2 时上一句也显示，并带上它刚采到的译文', async () => {
  const { sandbox, h } = await harness({
    withPip: true,
    settings: APPEARANCE,
    stored: {
      ...officialCache(SKELETON_CUES),
      llgPipAppearance: { style: 'classic', scale: 100, color: '#FFFFFF', dual: true, ctxLines: 2 },
    },
  });
  const pip = sandbox.__llgModPip;
  h.jaBreakEnabled = false;
  await h.drain();
  await h.drain();

  // 播两句：第一句采到译文，第二句成为当前句
  h.currentTime = 0.2;
  show(h, 'おはよう', '早安');
  h.currentTime = 3;
  show(h, 'きょうは あめ です', '今天下雨');
  await h.drain();
  h.gesture();
  await h.drain();

  assert.equal(h.pipText(), 'きょうは あめ です');
  assert.equal(h.pipButton('line-secondary').textContent, '今天下雨');

  // 上一句：原文 + 它刚采到的译文（刚播过 → 有）
  assert.equal(h.pipButton('prev').style.display, '');
  assert.equal(h.pipLineText('prev-primary'), 'おはよう');
  assert.equal(h.pipButton('prev-secondary').textContent, '早安');

  // 下一句：骨架有原文、没译文 → 只渲染原文
  assert.equal(h.pipButton('next').style.display, '');
  assert.equal(h.pipLineText('next-primary'), 'あしたは はれ です');
  assert.equal(h.pipButton('next-secondary').textContent, '');

  // 同一个入口对外也暴露（探针与测试共用），边界处给 null
  assert.equal(pip.contextText(-1).primary, 'おはよう');
  assert.equal(pip.contextText(1).secondary, '');
  assert.equal(pip.contextText(-99), null);
});

test('桌面字幕：≡ 循环 0/1/2 并落盘，0 时两段上下文都收起来', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE, stored: officialCache(SKELETON_CUES) });
  const pip = sandbox.__llgModPip;
  h.jaBreakEnabled = false;
  await h.drain();
  await h.drain();

  // 播到第二句：这样「上一句」存在（第一句没有上一句），档位切换才有东西可显
  h.currentTime = 0.2;
  show(h, 'おはよう', '早安');
  h.currentTime = 3;
  show(h, 'きょうは あめ です', '今天下雨');
  await h.drain();
  h.gesture();
  await h.drain();

  assert.equal(pip.appearanceOwn().ctxLines, pip.CTX_DEFAULT, '默认 1：只看下一句');
  assert.equal(h.pipButton('pip-ctx').textContent, '≡1', '按钮上要写档位');
  assert.equal(h.pipButton('pip-ctx').dataset.on, '1', '开了上下文才算选中态');

  h.pipClick('ctx'); // 1 → 2
  assert.equal(pip.appearanceOwn().ctxLines, 2);
  assert.equal(h.pipButton('pip-ctx').textContent, '≡2');
  assert.equal(h.pipButton('prev').style.display, '', '2 段：上一句要出来');
  assert.equal(h.saved.at(-1).llgPipAppearance.ctxLines, 2, '改一下就要落盘');

  // ↺ 复位只把官方那套请回来，不该顺手抹掉用户调的行数
  h.pipClick('reset');
  assert.equal(pip.appearanceOwn().ctxLines, 2, '复位不动上下文行数');

  h.pipClick('ctx'); // 2 → 0
  assert.equal(pip.appearanceOwn().ctxLines, 0);
  assert.equal(h.pipButton('pip-ctx').textContent, '≡0');
  assert.equal(h.pipButton('pip-ctx').dataset.on, undefined, '0 不算选中');
  assert.equal(h.pipButton('prev').style.display, 'none');
  assert.equal(h.pipButton('next').style.display, 'none', '0 段时下一句也要收起来');
  assert.equal(h.pipLineText('next-primary'), '', '收起时要清掉文本');

  h.pipClick('ctx'); // 0 → 1
  assert.equal(pip.appearanceOwn().ctxLines, 1);
  assert.equal(h.saved.at(-1).llgPipAppearance.ctxLines, 1);
});

test('桌面字幕：换句时给滚轮动效打方向标记，改外观不滚', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE, stored: officialCache(SKELETON_CUES) });
  const pip = sandbox.__llgModPip;
  h.jaBreakEnabled = false;
  await h.drain();
  await h.drain();

  h.currentTime = 0.2;
  show(h, 'おはよう', '早安');
  h.currentTime = 3;
  show(h, 'きょうは あめ です', '今天下雨');
  await h.drain();
  h.gesture();
  await h.drain();

  const reel = h.lastPipWindow().document.getElementById('reel');
  assert.ok(reel, '三段要装在 #reel 里（动效的载体）');
  assert.equal(reel.dataset.roll, undefined, '开窗第一次填充不该自己动一下');

  // 往前播 → 内容从下方推进来
  h.currentTime = 7;
  show(h, 'あしたは はれ です', '明天是晴天');
  h.tick();
  assert.equal(reel.dataset.roll, 'up', '前进 = 从下往上推');

  // 往回调 → 反向
  h.currentTime = 3;
  h.tick();
  assert.equal(reel.dataset.roll, 'down', '后退 = 从上往下推');

  // 改外观（不换句）不该滚：方向标记保持原样，不重新触发
  pip.setAppearanceOwn({ color: '#FFD60A' });
  assert.equal(reel.dataset.roll, 'down', '只改颜色 → 不动效');

  // 同一个方向连续换句也要能重放：标记被删掉再打回来（动画名不会自己重来）
  h.currentTime = 7;
  h.tick();
  assert.equal(reel.dataset.roll, 'up');
  assert.match(h.pipCss(), /#reel\[data-roll="up"\] \{ animation: llg-roll-up/);
  assert.match(h.pipCss(), /@media \(prefers-reduced-motion: reduce\) \{\s*#reel\[data-roll\] \{ animation: none; \}/,
    '系统设了「减少动态效果」就不动');
});

test('桌面字幕：点上一句 / 下一句会跳到那一句的开头并从头播', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE, stored: officialCache(SKELETON_CUES) });
  const pip = sandbox.__llgModPip;
  h.jaBreakEnabled = false;
  await h.drain();
  await h.drain();

  h.currentTime = 0.2;
  show(h, 'おはよう', '早安');
  h.currentTime = 4;   // 停在第二句句中
  show(h, 'きょうは あめ です', '今天下雨');
  await h.drain();
  h.gesture();
  await h.drain();

  // 两块上下文行都是可点的（data-act 走既有的点击委托）
  assert.equal(h.pipButton('prev').dataset.act, 'cue-prev');
  assert.equal(h.pipButton('next').dataset.act, 'cue-next');
  assert.match(h.pipCss(), /\.ctx \{[^}]*cursor: pointer/, '鼠标指针要变成手型');

  const plays = h.video.plays;

  // 点上一句：跳到第一句开头（骨架给的 0）并继续播 —— 不是「回到本句开头」
  h.pipClick('cue-prev');
  assert.equal(h.currentTime, 0, '跳到上一句的开头');
  assert.equal(h.video.plays, plays + 1, '并且从头播');

  // 点下一句：跳到紧接着那句的开头（上一跳之后当前句是第 0 句 → 下一句起点 2.5）
  h.pipClick('cue-next');
  assert.equal(h.currentTime, 2.5, '跳到下一句的开头');
  assert.equal(h.video.plays, plays + 2);

  // 没有下一句时点了不该把播放停掉、也不该出错（末句）
  h.currentTime = 8;
  h.tick();
  assert.equal(pip.command('cue-next'), false, '末句没有下一句 → 什么都没做');
});

test('桌面字幕：上下文行的断句跟随视频内那个开关', async () => {
  const { h } = await harness({ withPip: true, settings: APPEARANCE, stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();

  h.currentTime = 0.2;
  show(h, 'おはよう', '早安');
  await h.drain();
  h.gesture();
  await h.drain();

  // 开关开着：上下文行也按文节切开，分隔符独立成节点（与当前句同一套规则）
  const win = h.lastPipWindow();
  const next = win.document.getElementById('next-primary');
  const seps = (next.children || []).filter((kid) => kid.className === 'llg-sep');
  assert.ok(seps.length >= 1, `下一句要切成文节，实际分隔符 ${seps.length} 个`);
  assert.ok(h.pipLineText('next-primary').includes('|'),
    `上下文行的分隔符要拼进文本，实际 ${h.pipLineText('next-primary')}`);

  // 中途关掉 → 心跳把上下文行也重绘成干净原文
  h.jaBreakEnabled = false;
  h.tick();
  assert.equal(h.pipLineText('next-primary'), 'きょうは あめ です');
});

// ---------------------------------------------------------------- 浮窗播放控制

test('桌面字幕：浮窗控制栏——暂停/播放、前后 5 秒、倍速循环', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.currentTime = 5;
  show(h, 'いち', '一');
  await h.drain();
  h.gesture();
  await h.drain();
  assert.equal(pip.isOpen(), true, '控制栏在浮窗里，先得把窗开起来');

  // 播放/暂停：按 video 的真实状态切换
  assert.equal(h.video.paused, false);
  assert.equal(pip.command('toggle'), true);
  assert.equal(h.video.pauses, 1);
  assert.equal(h.video.paused, true);
  assert.equal(h.pipButton('pip-toggle').textContent, '▶', '暂停时按钮显示「播放」');
  assert.equal(h.pipButton('pip-toggle').getAttribute('aria-label'), '播放');

  pip.command('toggle');
  assert.equal(h.video.plays, 1);
  assert.equal(h.pipButton('pip-toggle').textContent, '⏸', '播放时按钮显示「暂停」');

  // ±5 秒，并夹在 0 / duration 之间
  h.currentTime = 20;
  pip.command('back');
  assert.equal(h.currentTime, 15);
  pip.command('fwd');
  assert.equal(h.currentTime, 20);
  h.currentTime = 2;
  pip.command('back');
  assert.equal(h.currentTime, 0, '不能倒到负数');
  h.currentTime = 599;
  pip.command('fwd');
  assert.equal(h.currentTime, 600, '不能超过 duration');

  // 倍速循环：1 → 1.25 → 1.5 → 1.75 → 2 → 0.75 → 1
  assert.equal(h.video.playbackRate, 1);
  pip.command('rate');
  assert.equal(h.video.playbackRate, 1.25);
  assert.equal(h.pipButton('pip-rate').textContent, '1.25×', '倍速要回显');
  pip.command('rate');
  pip.command('rate');
  pip.command('rate');
  assert.equal(h.video.playbackRate, 2);
  pip.command('rate');
  assert.equal(h.video.playbackRate, 0.75, '到顶之后回到最小档');
  pip.command('rate');
  assert.equal(h.video.playbackRate, 1);

  // 非档位值（用户在播放器里自己拖过）→ 归一档
  h.video.playbackRate = 3;
  pip.command('rate');
  assert.equal(h.video.playbackRate, 1);

  assert.equal(pip.command('unknown-act'), false, '未知动作不该抛出');
});

test('桌面字幕：浮窗控制栏——上一句/下一句走在 cue 边界上', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.currentTime = 5;
  show(h, 'a', '甲');
  h.currentTime = 9;
  show(h, 'b', '乙');
  h.currentTime = 15;
  show(h, 'c', '丙');
  await h.drain();
  h.gesture();
  await h.drain();

  // 刚进入第三句（句首）→ 退到第二句
  h.currentTime = 15;
  pip.command('prev');
  assert.equal(h.currentTime, 9);
  pip.command('prev');
  assert.equal(h.currentTime, 5);
  assert.equal(h.pipButton('pip-prev').disabled, true, '第一句的句首没有上一句');

  // 播到句中 → 先回本句开头，再按一次才退到上一句
  h.currentTime = 11;
  pip.command('prev');
  assert.equal(h.currentTime, 9, '句中先回本句开头');
  pip.command('prev');
  assert.equal(h.currentTime, 5);

  // 下一句
  h.currentTime = 5;
  pip.command('next');
  assert.equal(h.currentTime, 9);
  h.currentTime = 15;
  pip.command('next');
  assert.equal(h.currentTime, 15, '最后一句往后没有目标');
  assert.equal(h.pipButton('pip-next').disabled, true);
});

test('桌面字幕：浮窗控制栏的点击委托与状态回显', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.currentTime = 5;
  show(h, 'a', '甲');
  await h.drain();
  h.gesture();
  await h.drain();

  // 真实链路：点击 → closest('[data-act]') → command
  h.currentTime = 10;
  assert.equal(h.pipClick('back'), true);
  assert.equal(h.currentTime, 5, '点击委托把 data-act 递到了 command');
  h.pipClick('toggle');
  assert.equal(h.video.pauses, 1);

  // video 自己发出事件时立刻回显（不等 1s 心跳）
  h.video.paused = false;
  h.video.fire('play');
  assert.equal(h.pipButton('pip-toggle').textContent, '⏸');
  h.video.paused = true;
  h.video.fire('pause');
  assert.equal(h.pipButton('pip-toggle').textContent, '▶');

  // 没有 video 时不能抛
  sandbox.document.querySelector = () => null;
  assert.equal(pip.command('toggle'), false);
});

test('学习面板：玻璃令牌都有定义，且不引用拿不到的官方变量', async () => {
  const source = await sourceOf('40-study-panel.js');

  // 只看真正生效的那段 CSS：注释里必须能出现 var(--radius-sm, 8px) 这种反例写法
  // （解释「为什么不能引用官方变量」），拿全文扫会把说明文字当成引用。
  const block = source.match(/const PANEL_CSS = `([\s\S]*?)`;/);
  assert.ok(block, '找不到 PANEL_CSS');

  const used = new Set([...block[1].matchAll(/var\(\s*(--llg-[a-z0-9-]+)/g)].map((m) => m[1]));
  const defined = new Set([...block[1].matchAll(/(--llg-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  assert.ok(used.size >= 15, `面板应当用上一整套玻璃令牌，实际只引用了 ${used.size} 个`);
  assert.deepEqual(
    [...used].filter((name) => !defined.has(name)),
    [],
    '这些令牌被 var() 引用了却没有定义',
  );

  // 官方那套（--lg-* / --glass-* / --radius-*）在这里一定拿不到：
  // :host{all:initial} 会重置自定义属性，面板也不在官方的 shadow root 里。
  // 引用它们只会静默走兜底值 —— 那正是「看着不像 Linglass」的根因。
  const foreign = [...block[1].matchAll(/var\(\s*--(?!llg-)([a-z0-9-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(foreign)], [], '不该引用拿不到的官方变量');
});

/**
 * 排版尺度的回归测试（PLAN 007）。
 *
 * 需求是「字号偏小」，所以断言的方向是「不低于官方下限」，而不是钉死具体像素 ——
 * 以后想再放大不会被这条测试挡住，但被无声改小回去会立刻红。
 *
 * 官方下限取自 vendor/linglass-1.12.3/assets/sidepanel-BiK3qJ0g.css：
 * 正文基座 --text-base = 1rem = 16px、行高 1.5；组件级文本集中在 13.5–15px，
 * 元信息 12px。我们比官方的小一档（面板窄、行密），但基座不应低于 15px，
 * 列表行不应低于官方 13.5px 的行文本下限。
 */
test('学习面板：排版尺度不低于官方下限', async () => {
  const source = await sourceOf('40-study-panel.js');
  const block = source.match(/const PANEL_CSS = `([\s\S]*?)`;/);
  assert.ok(block, '找不到 PANEL_CSS');
  const css = block[1];

  /** 取某条规则块里某个属性的 px 值；取不到就返回 NaN，由断言报错 */
  function pxOf(selector, prop) {
    const rule = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
    if (!rule) return Number.NaN;
    const decl = rule[1].match(new RegExp(`${prop}\\s*:\\s*([\\d.]+)px`));
    return decl ? Number.parseFloat(decl[1]) : Number.NaN;
  }

  // .panel 用的是 font 简写，单独取 `font: <weight> <size>px/<line-height> <family>`
  const base = css.match(/\.panel\s*\{[\s\S]*?font:\s*\d+\s+([\d.]+)px\/([\d.]+)/);
  assert.ok(base, '.panel 的 font 简写里找不到字号');
  assert.ok(Number.parseFloat(base[1]) >= 15, `面板基座字号 ${base[1]}px 小于 15px（官方 --text-base 是 16px）`);
  assert.ok(Number.parseFloat(base[2]) >= 1.5, `面板基座行高 ${base[2]} 小于官方的 1.5`);
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/, '官方开启了 antialiased，我们跟着开');

  // 行文本与标题：本轮的目标值，也就是「不许改小回来」的下限
  const floors = [
    ['.ja', 'font-size', 15],
    ['.zh', 'font-size', 14],
    ['.title', 'font-size', 15],
    ['.stamp', 'font-size', 12],
    ['.kline-ja', 'font-size', 18],
    ['.kline-zh', 'font-size', 15],
  ];

  for (const [selector, prop, floor] of floors) {
    const value = pxOf(selector, prop);
    assert.ok(
      Number.isFinite(value),
      `${selector} 的 ${prop} 没解析出来（选择器或属性名改了？）`,
    );
    assert.ok(value >= floor, `${selector} 的 ${prop} 是 ${value}px，低于本轮的 ${floor}px`);
  }

  // 官方行文本下限 13.5px：列表行的两行文字都不该低于它
  for (const selector of ['.ja', '.zh']) {
    assert.ok(pxOf(selector, 'font-size') >= 13.5, `${selector} 低于官方 13.5px 的行文本下限`);
  }

  // 时间戳列至少要放得下 12px 等宽数字的 `1:00:00`
  const columns = css.match(/\.row\s*\{[\s\S]*?grid-template-columns:\s*(\d+)px/);
  assert.ok(columns, '.row 的 grid-template-columns 没解析出来');
  assert.ok(Number.parseInt(columns[1], 10) >= 48, `时间戳列 ${columns[1]}px 放不下放大后的时间戳`);
});

/**
 * 文节切分测试。
 *
 * 这些断言依赖 ICU 的日语词典（Intl.Segmenter），Node 升级 ICU 时可能需要跟着调。
 * 除具体切分外，还断言了一条与实现无关的不变量：切出来的节拼回去必须等于原文。
 */
function sectionsOf(cut, text) {
  const points = cut(text);
  const out = [];
  let prev = 0;
  for (const point of points) {
    out.push(text.slice(prev, point));
    prev = point;
  }
  return out;
}

test('文节切分：助词与活用词尾黏回自立词，按文节断句', async () => {
  const { sandbox } = await harness();
  const { cut } = sandbox.__llgModJaSegment;

  // 需求里给的两个例子
  assert.deepEqual(
    sectionsOf(cut, '私は昨日図書館で日本語の本を借りました。'),
    ['私は', '昨日', '図書館で', '日本語の', '本を', '借りました。'],
  );
  assert.deepEqual(
    sectionsOf(cut, '昨日買った本を読む'),
    ['昨日', '買った', '本を', '読む'],
  );
});

test('文节切分：一个文节就是一个整体，不往里插分隔符', async () => {
  const { sandbox } = await harness();
  const { cut } = sandbox.__llgModJaSegment;

  for (const text of [
    '食べられます', '行かなかった', '読んでいる', '勉強してみたい', 'いきませんでした',
    'はい。',
  ]) {
    // 用长度而不是 deepEqual：vm 沙箱里的数组与宿主不同 realm，比原型会失败
    assert.equal(cut(text).length, 0, `${text} 整体只有一个文节，不该画分隔符`);
  }
});

test('文节切分：格助词之后的词另起一节，不会被黏成新词的一部分', async () => {
  const { sandbox } = await harness();
  const { cut } = sandbox.__llgModJaSegment;

  // 「花を + かいました」「ここで + たべられます」里的 か / た 与格助词长得一样
  assert.deepEqual(sectionsOf(cut, 'きれいな花をかいました'), ['きれいな', '花を', 'かいました']);
  assert.deepEqual(sectionsOf(cut, 'ここでたべられます'), ['ここで', 'たべられます']);
});

test('文节切分：纯假名句按其形态判断，不靠汉字词干', async () => {
  const { sandbox } = await harness();
  const { cut } = sandbox.__llgModJaSegment;

  assert.deepEqual(sectionsOf(cut, 'きのうはあめでした'), ['きのうは', 'あめでした']);
  assert.deepEqual(sectionsOf(cut, 'それをみてください'), ['それを', 'みてください']);
  assert.deepEqual(sectionsOf(cut, 'まだおわっていません'), ['まだ', 'おわっていません']);
  // とても 的末字是提示助词 も，但它是个自立词，不能把后面的形容词黏上来
  assert.deepEqual(
    sectionsOf(cut, 'これはとてもおいしいです'),
    ['これは', 'とても', 'おいしいです'],
  );
});

test('文节切分：非日语行原样放过', async () => {
  const { sandbox } = await harness();
  const { cut } = sandbox.__llgModJaSegment;

  assert.equal(cut('这个句子不应该被处理').length, 0);
  assert.equal(cut('hello world').length, 0);
  assert.equal(cut('').length, 0);
});

test('文节切分：切点严格升序，且拼回去等于原文', async () => {
  const { sandbox } = await harness();
  const { cut } = sandbox.__llgModJaSegment;

  const texts = [
    '私は昨日図書館で日本語の本を借りました。',
    'きのうはあめでした',
    'それをみてください',
    '本を読むことがすきです',
    '「本」を読む',
  ];

  for (const text of texts) {
    const points = cut(text);
    assert.ok(points.length >= 1, `${text} 应该被切开`);
    for (let i = 1; i < points.length; i += 1) {
      assert.ok(points[i] > points[i - 1], `${text} 的切点必须严格升序`);
    }
    assert.ok(points[points.length - 1] <= text.length, '切点不能越界');
    assert.equal(sectionsOf(cut, text).join(''), text, '切出来的节拼回去必须等于原文');
  }
});
// ---------------------------------------------------------------- 共享心跳（PLAN 025）

/**
 * 这一条用的是**真正的** 00-shared.js（不是 harness 里那个桩）：定时器合并是
 * 省资源的做法，得有人守着「真的只起一个」。
 *
 * 只在独立沙箱里加载它 —— 控制栏那套（ensureButton / injectStyle）在桩件里没法跑，
 * 而这里也不碰它们。加载时唯一会碰 DOM 的是清僵尸元素（`document.getElementById`）。
 */
test('共享心跳：五个模块共用同一个 1s 定时器，回调抛错不拖累别人', async () => {
  const intervals = [];
  const warnings = [];
  const sandbox = {
    console: {
      log: () => {},
      warn: (...args) => warnings.push(args.join(' ')),
      error: () => {},
    },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: () => {},
    document: { getElementById: () => null },
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(await sourceOf('00-shared.js'), context, { filename: '00-shared.js' });

  const shared = sandbox.__llgModShared;
  assert.ok(shared && typeof shared.onTick === 'function', '00-shared.js 应提供共享心跳');
  assert.equal(intervals.length, 0, '没人注册时不该起定时器（页面不白跑一个 1s 空转）');

  const order = [];
  const offA = shared.onTick(() => order.push('a'));
  shared.onTick(() => {
    order.push('b');
    throw new Error('boom');
  });
  const offC = shared.onTick(() => order.push('c'));

  assert.equal(intervals.length, 1, '五个模块共用一个定时器：注册几个回调都只起一个');
  assert.equal(intervals[0].ms, 1000);

  intervals[0].fn();
  assert.deepEqual(order, ['a', 'b', 'c'], '按注册顺序依次调用');
  assert.equal(warnings.length, 1, '抛错要报出来（不然静默失效最难查）');
  assert.match(warnings[0], /boom/);

  // 注销要真的生效，且不影响这一轮与下一轮的其余回调
  offA();
  offC();
  order.length = 0;
  intervals[0].fn();
  assert.deepEqual(order, ['b'], '注销后只剩没注销的那个');
  assert.equal(intervals.length, 1, '回调来去都不该反复重开定时器');
});
// ---------------------------------------------------------------- 导入译文（PLAN 031）

/**
 * 离线翻译工作流的回归：导出原文 → 外部翻好 → 导入译文 → 浮窗/面板/导出都能看到。
 *
 * 这里最要紧的一条是「采样不许覆盖导入的译文」—— 导入之后用户还要继续看视频，
 * 一覆盖就等于白翻了。另外 `origin` 必须跟着译文一起活过 reload（adoptSkeleton
 * 会把轨道重建成骨架句，漏搬这个标记的话，来源就丢了）。
 */

/** 把最近一次落盘的内容搬回 storage 桩（真实里 save() 已经写进去了，桩件只记不生效） */
function persistLastSave(h, key) {
  const last = h.saved.filter((entry) => entry[key]).pop();
  if (!last) throw new Error(`没有落盘过 ${key}`);
  h.stored[key] = last[key];
  return last[key];
}

test('导入译文：贴回对应句、打上 origin，并落盘到我们自己的键', async () => {
  const { sandbox, h, track } = await harness({ stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();
  assert.equal(track.getCues().length, 3, '先要有骨架');

  const plan = sandbox.__llgModSrt.planImport(track.getCuesForExport(), [
    { start: 0, end: 2.5, text: '早安' },
    { start: 2.5, end: 6, text: '今天下雨' },
  ]);
  assert.equal(plan.missed.length, 0);

  const result = await track.applyTranslations(plan.assignments);
  assert.equal(result.applied, 2);
  assert.equal(result.missed, 0);
  assert.equal(result.fingerprintMismatch, false);

  const cues = track.getCues();
  assert.equal(cues[0].secondary, '早安');
  assert.equal(cues[1].secondary, '今天下雨');
  assert.equal(cues[0].origin, 'imported');
  assert.equal(cues[2].secondary, '', '没导到的句子保持原样');

  const saved = persistLastSave(h, `llgTrack:${VIDEO_ID}`);
  assert.equal(saved.cues[0].secondary, '早安', '译文必须落盘（刷新后还在）');
  assert.equal(saved.cues[0].origin, 'imported', '来源标记一起落盘');
  assert.equal(saved.meta.import.fingerprint.count, 3);
  assert.equal(saved.meta.import.fingerprint.first, 'おはよう');
  assert.equal(saved.meta.import.fingerprint.last, 'あしたは はれ です');
});

test('导入译文：继续播放时采样不把导入的译文覆盖掉（本 PLAN 的核心回归）', async () => {
  const { sandbox, h, track } = await harness({ stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();

  const plan = sandbox.__llgModSrt.planImport(track.getCuesForExport(), [
    { start: 0, end: 2.5, text: '早安' },
  ]);
  await track.applyTranslations(plan.assignments);
  assert.equal(track.getCues()[0].secondary, '早安');

  // 播到这一句，官方给了它自己的译文 —— 采样不许动导入的那份
  h.currentTime = 0.3;
  show(h, 'おはよう', '官方译文');
  assert.equal(track.getCues()[0].secondary, '早安', '导入的译文优先于官方/采样');

  // 骨架句的时间照样由官方定（采样不改官方给的 end）
  h.currentTime = 1.5;
  h.tick();
  assert.equal(track.getCues()[0].end, 2.5);

  assert.equal(track.getCues()[0].origin, 'imported');
});

test('导入译文：切走再切回来，译文与 origin 都还在（走一遍 adoptSkeleton）', async () => {
  const { sandbox, h, track } = await harness({ stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();

  const plan = sandbox.__llgModSrt.planImport(track.getCuesForExport(), [
    { start: 0, end: 2.5, text: '早安' },
    { start: 2.5, end: 6, text: '今天下雨' },
  ]);
  await track.applyTranslations(plan.assignments);
  persistLastSave(h, `llgTrack:${VIDEO_ID}`);

  sandbox.location.href = 'https://www.youtube.com/watch?v=zzz999';
  await track.reload();
  await h.drain();
  assert.equal(track.getCues().length, 0, '换到没有轨道的视频就是空轨道');

  sandbox.location.href = WATCH_URL;
  await track.reload();
  await h.drain();
  await h.drain();

  assert.equal(track.getCues().length, 3, '骨架照常采用');
  assert.equal(track.getCues()[0].secondary, '早安');
  assert.equal(track.getCues()[1].secondary, '今天下雨');
  assert.equal(track.getCues()[0].origin, 'imported', 'origin 漏搬的话来源就丢了（优先级保护跟着失效）');
  assert.equal(track.getMeta().importMismatch, false, '原文轨与导入时一致，不该报对不上');
});

test('导入译文：原文轨与导入时不一致时，getMeta 报 importMismatch（不做自动失效）', async () => {
  // 只有我们自己的轨道、没有官方缓存：当前原文轨 2 句，而导入时记的是 3 句
  const key = `llgTrack:${VIDEO_ID}`;
  const short = SKELETON_CUES.slice(0, 2).map((raw) => ({
    start: raw.start, end: raw.end, primary: raw.text, secondary: '我翻的', origin: 'imported',
  }));

  const { h, track } = await harness({
    stored: {
      [key]: {
        meta: {
          id: VIDEO_ID,
          import: { at: 1, fingerprint: { count: 3, first: 'おはよう', last: 'あしたは はれ です' } },
        },
        cues: short,
        savedAt: 1,
      },
    },
  });
  await h.drain();
  await h.drain();

  assert.equal(track.getCues().length, 2);
  assert.equal(track.getMeta().importMismatch, true, '对不上就要报出来（面板据此提示一次）');
  assert.equal(track.getCues()[0].secondary, '我翻的', '只是提示，不做自动失效');
});

test('导入译文：没导入过的轨道不报 importMismatch（不去打扰用户）', async () => {
  const { h, track } = await harness({ stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();

  assert.equal(track.getMeta().importMismatch, null);
});

test('导出原文 SRT：单语、干净，不带译文那一行', async () => {
  const { sandbox, h, track } = await harness({ withPanel: true, stored: officialCache(SKELETON_CUES) });
  await h.drain();
  await h.drain();

  // 播过一句、官方顺手给了译文 —— 双语导出会是「一句两行、一句一行」的混合文件
  h.currentTime = 0.2;
  show(h, 'おはよう', '早安');

  const snap = track.snapshot();
  const panel = sandbox.__llgModPanel;
  const bilingual = panel.toSrt(snap);
  const sourceOnly = panel.toSrt(snap, { sourceOnly: true });

  assert.match(bilingual, /おはよう\n早安/, '默认导出仍然是双语的');
  assert.equal(sourceOnly.includes('早安'), false, '只导原文时译文一个字符都不该出现');
  assert.match(sourceOnly, /1\n00:00:00,000 --> 00:00:02,500\nおはよう/);

  const blocks = sourceOnly.split('\n\n').filter(Boolean);
  assert.equal(blocks.length, 3, '三段，每段一句原文');
  const linesPerBlock = blocks.map((block) => block.split('\n').filter(Boolean));
  assert.equal(linesPerBlock.every((lines) => lines.length === 3), true,
    '每段恒为「序号 / 时间轴 / 一行原文」');
});
