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
 */
async function harness({ withPanel = false, withPip = false, stored = {} } = {}) {
  const h = {
    // 字幕浮层 Shadow DOM 的可控状态
    primary: '',
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
    features: [],
    timers: new Map(),
    intervals: [],
    mutationCallback: null,
    // 页面可见性（桌面字幕的「切回浏览器」判定靠它）
    visibilityState: 'visible',
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
  };

  const display = (key) => ({
    get display() {
      return h[key];
    },
    set display(v) {
      h[key] = v;
    },
  });

  const group = { style: display('groupDisplay') };
  const primaryEl = {
    style: display('primaryDisplay'),
    get textContent() {
      return h.primary;
    },
    set textContent(v) {
      h.primary = v;
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

  /**
   * 画中画窗口的假货。
   *
   * 30-desktop-subtitles.js 只用到极小的一个子集：createElement / append /
   * getElementById（按 id 找它刚建好的那些节点）、addEventListener('pagehide')、
   * close()、requestAnimationFrame。所以这里不求完整 DOM，只保证这五件事成立。
   */
  function fakePipDocument() {
    const byId = new Map();
    const el = (tagName) => ({
      tagName,
      id: '',
      className: '',
      style: {},
      textContent: '',
      children: [],
      append(...kids) {
        for (const kid of kids) {
          this.children.push(kid);
          if (kid && kid.id) byId.set(kid.id, kid);
        }
      },
    });
    return {
      documentElement: { style: {} },
      head: el('head'),
      body: el('body'),
      createElement: (tagName) => el(tagName),
      getElementById: (id) => byId.get(id) ?? null,
    };
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

  const sandbox = {
    console,
    URL,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    confirm: () => true,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    location: { href: WATCH_URL, pathname: '/watch' },
    document: {
      title: 'テスト動画 - YouTube',
      head: { append: () => {} },
      body: { append: () => {} },
      getElementById: (id) => (id === 'linglass-subtitle-overlay' ? host : null),
      querySelector: (selector) =>
        selector === '#movie_player video' ? video : null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, append: () => {}, remove: () => {} }),
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
    chrome: {
      storage: {
        local: {
          get: () => Promise.resolve(h.stored),
          set: (entry) => {
            h.saved.push(entry);
            return Promise.resolve();
          },
          remove: (key) => {
            h.removed.push(key);
            return Promise.resolve();
          },
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
    return line ? line.textContent : null;
  };
  h.pipFill = () => {
    const win = h.lastPipWindow();
    const fill = win && win.document.getElementById('fill-primary');
    return fill ? fill.style.width : null;
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

  h.currentTime = 11; // 用户在句内
  assert.equal(track.getProgressEnd(), 12, '分母应当是下一句的 start');
  assert.equal(track.getProgress(), 0.5, '11s 处于 10→12 的中点');
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

  assert.equal(h.pipText(), SEGMENTED);

  // 中途关掉视频内的断句 → 心跳把浮窗重绘成干净原文（去重键里带了开关状态）
  h.jaBreakEnabled = false;
  h.tick();
  assert.equal(h.pipText(), '昨日買った本を読む');
  assert.equal(sandbox.__llgModPip.isOpen(), true);
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
