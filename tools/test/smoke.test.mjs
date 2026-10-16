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
 */
async function harness({
  withPanel = false,
  withPip = false,
  withColumn = false,
  stored = {},
  settings = null,
} = {}) {
  const h = {
    // 字幕浮层 Shadow DOM 的可控状态
    primary: '',
    /** 剥掉振假名（rt）之后的原文 —— 官方 DOM 里这两份文本都存在，见 primaryEl */
    primaryPlain: '',
    /** 这一行的原文是否带振假名（`<ruby>夜<rt>よる</rt></ruby>`） */
    primaryRt: false,
    secondary: '',
    groupDisplay: '',
    primaryDisplay: '',
    secondaryDisplay: '',
    // 播放器
    currentTime: 0,
    duration: 600,
    // 落盘与定时器
    saved: [],
    removed: [],
    stored,
    /** chrome.storage.local.get 被读过的 key（用来断言「没有反复轮询」） */
    storageReads: [],
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

  const subtitleRoot = {
    querySelector(selector) {
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
      append(...kids) {
        for (const kid of kids) node.children.push(kid);
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
      addEventListener() {},
      removeEventListener() {},
      scrollIntoView() {},
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
    return {
      roleNode,
      shadow: {
        append: () => {},
        addEventListener: () => {},
        querySelector(selector) {
          const match = /^\[data-role="(.+)"\]$/.exec(selector);
          return match ? roleNode(match[1]) : null;
        },
      },
    };
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
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
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
    location: { href: WATCH_URL, pathname: '/watch' },
    document: {
      title: 'テスト動画 - YouTube',
      head,
      body: { append: () => {} },
      documentElement,
      getElementById: (id) => (id === 'linglass-subtitle-overlay' ? host : null),
      querySelector: (selector) => {
        if (selector === '#movie_player video') return video;
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
  // ensureButton 恒返回 false —— 让 refreshButton() 立刻短路，避免测试去碰控制栏。
  sandbox.__llgModShared = {
    ensureButton: () => false,
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
  /** 触发一次用户手势（桌面字幕靠它拿到瞬时激活） */
  h.gesture = (type = 'pointerdown') => {
    for (const fn of [...h.listeners(type)]) fn();
  };
  /** 切换页面可见性并广播 visibilitychange */
  h.setVisibility = (state) => {
    h.visibilityState = state;
    for (const fn of [...h.listeners('visibilitychange')]) fn();
  };
  h.lastPipWindow = () => h.pip.windows[h.pip.windows.length - 1] || null;
  h.pipText = () => {
    const win = h.lastPipWindow();
    const line = win && win.document.getElementById('line-primary');
    if (!line) return null;
    // 原文行是「文本节点 + <span class="llg-sep">」拼出来的，拼回去才等于画出来的文字
    if (line.children.length) return line.children.map((kid) => kid.textContent).join('');
    return line.textContent;
  };
  /** 原文行的片段结构（文本 / 分隔符），用来断言分隔符是独立节点 */
  h.pipSegments = () => {
    const win = h.lastPipWindow();
    const line = win && win.document.getElementById('line-primary');
    if (!line) return null;
    return line.children.map((kid) => ({ text: kid.textContent, sep: kid.className === 'llg-sep' }));
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

/** 让当前字幕变成指定文本（模拟 Linglass 更新了 Shadow DOM） */
function show(h, primary, secondary = '') {
  h.primary = primary;
  h.secondary = secondary;
  h.tick();
}

/**
 * 让当前原文行变成「带振假名」的样子：`full` 是 textContent（含注音），
 * `plain` 是剥掉 rt 之后的文本。用于验证我们读的是后者。
 */
function showFurigana(h, full, plain, secondary = '') {
  h.primaryRt = true;
  h.primary = full;
  h.primaryPlain = plain;
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

  // 官方重渲染这一行时带上了振假名：textContent 变成「夜よる」，
  // 但它跟时间轴里的「夜」是同一句 —— 剥 rt 之后两边口径才一致
  h.primaryRt = true;
  h.primary = '夜よる';
  h.primaryPlain = '夜';
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

  // 索引读不到时最多重试几次，绝不跟着心跳一直轮询
  for (let i = 0; i < 8; i += 1) h.tick();
  const indexReads = h.storageReads.filter((key) => key === 'subtitle-cache:index').length;
  assert.ok(indexReads <= 4, `索引最多读 4 次（实际 ${indexReads} 次）`);
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

test('桌面字幕：默认开启，但要等第一次用户手势才真正开窗', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  assert.equal(pip.isEnabled(), true, '没表过态时默认就是开着的');
  assert.equal(pip.isOpen(), false);
  assert.equal(h.pip.requestCount, 0, 'requestWindow 要瞬时用户激活，加载时不能硬开');

  h.gesture();
  await h.drain();

  assert.equal(h.pip.requestCount, 1);
  assert.equal(pip.isOpen(), true);
  assert.equal(h.pip.lastOptions.disallowReturnToOpener, true, '不给「返回标签页」按钮');
  assert.equal(h.saved.at(-1).llgPip.enabled, true, '常驻开关要落盘');
});

test('桌面字幕：切回浏览器时被 UA 关掉，会自己回来', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();
  const first = h.lastPipWindow();

  h.setVisibility('hidden');
  h.setVisibility('visible'); // 用户切回浏览器（hidden → visible 的跃迁）
  first.fire('pagehide');     // UA 就在这一刻把它关了
  await h.drain();

  assert.equal(h.pip.requestCount, 2, '应当立刻重开一次');
  assert.equal(pip.isOpen(), true);
  assert.equal(pip.isEnabled(), true, '这次不是用户关的，开关要保持开着');
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

test('桌面字幕：用户点 PiP 窗口自己的 X 也算显式关闭', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();

  // 页面一直可见 → 不是「切回浏览器」那种关闭，而是用户自己关的
  h.lastPipWindow().fire('pagehide');
  await h.drain();

  assert.equal(pip.isEnabled(), false);
  assert.equal(h.pip.requestCount, 1, '不该自己弹回来');
});

test('桌面字幕：恢复时没有用户手势，就等到下一次手势', async () => {
  const { sandbox, h } = await harness({ withPip: true });
  const pip = sandbox.__llgModPip;

  h.gesture();
  await h.drain();

  h.pip.deny = true; // 模拟 requestWindow 被拒（此刻没有瞬时激活）
  h.setVisibility('hidden');
  h.setVisibility('visible');
  h.lastPipWindow().fire('pagehide');
  await h.drain();

  assert.equal(pip.isOpen(), false);
  assert.equal(h.pip.requestCount, 2, '会先试一次');

  h.pip.deny = false;
  h.gesture(); // 下一次手势把它接住
  await h.drain();

  assert.equal(pip.isOpen(), true);
  assert.equal(h.pip.requestCount, 3);
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

test('桌面字幕：字号来自官方档位，且不随浮窗尺寸变', async () => {
  const { sandbox, h } = await harness({ withPip: true, settings: APPEARANCE });
  const pip = sandbox.__llgModPip;
  await h.drain();

  // 官方 100% 档：基座 24px，原文行（日语算 CJK）27px、译文行 20px
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 27px/);
  assert.match(pip.pipCss(), /#line-secondary \{[^}]*font-size: 20px/);
  assert.doesNotMatch(pip.pipCss(), /clamp\(|vw/, '字号不许跟浮窗尺寸走');

  h.changeSettings(withAppearance({ subtitleScale: 150 }));
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 40\.5px/);
  assert.match(pip.pipCss(), /#line-secondary \{[^}]*font-size: 30px/);

  // 档位缺失（旧版本落盘、或值被写坏）→ 退回官方默认 100%
  h.changeSettings(withAppearance({ subtitleScale: 0 }));
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 27px/);

  // 落盘是 JSON 字符串（zustand persist 的另一种形态）也要认
  h.changeSettings(JSON.stringify(withAppearance({ subtitleScale: 50 })));
  assert.match(pip.pipCss(), /#line-primary \{[^}]*font-size: 13\.5px/, '50% → 12 + 1.5');
});

test('桌面字幕：颜色、样式预设、双语都跟着官方外观走', async () => {
  const { h } = await harness({ withPip: true, settings: APPEARANCE });
  await h.drain();

  h.currentTime = 5;
  show(h, 'テスト', '测试');
  await h.drain();
  h.gesture();
  await h.drain();

  const classic = h.pipCss();
  assert.match(classic, /#line-primary \{[^}]*color: #FFFFFF/);
  assert.match(classic, /#line-primary \{[^}]*font-weight: 600/, '日语原文行加粗一档（500 + 100）');
  assert.match(classic, /#line-secondary \{[^}]*color: rgba\(255, 255, 255, 0\.75\)/,
    'classic 的译文行是同色 ×.75（官方 secondaryAlpha）');
  assert.match(classic, /#plate \{[^}]*background: linear-gradient/, 'classic 的底板画在整块上');

  // 换颜色 + 换预设：cinema 不画底板，改用描边
  h.changeSettings(withAppearance({ subtitleColor: '#FFD60A', subtitleStyle: 'cinema' }));
  const cinema = h.pipCss();
  assert.match(cinema, /#line-primary \{[^}]*color: #FFD60A/);
  assert.doesNotMatch(cinema, /#plate \{[^}]*background/, 'cinema 不画底板');
  assert.match(cinema, /#line-primary \{[^}]*paint-order: stroke fill/, 'cinema 靠描边保证可读');

  // 关掉双语 → 译文行不渲染（官方关掉时也不显示）
  h.changeSettings(withAppearance({ dualSubtitles: false }));
  assert.equal(h.pipButton('line-secondary').textContent, '');
  h.changeSettings(APPEARANCE);
  assert.equal(h.pipButton('line-secondary').textContent, '测试', '再打开就回来');
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
