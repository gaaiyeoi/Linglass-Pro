/**
 * 导入译文覆盖画面译文行（PLAN 061）的用例。
 *
 * 这个模块只碰官方字幕 shadowRoot 里的 `.subtitle-secondary`，不依赖 chrome.*，
 * 所以喂一个假 shadowRoot + 假轨道就能跑；官方主轨与浮窗不在这里测。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_PATH = path.join(ROOT, 'src', 'mod', '16-imported-subtitle.js');
const source = await readFile(SOURCE_PATH, 'utf8');

/**
 * 假环境：
 *   · 一条「当前句」（由测试逐例替换）
 *   · 官方 secondary 行（文本 + display 都可断言，写入次数单独计数）
 *   · 一棵可替换的 shadowRoot（官方重建播放器）
 *   · MutationObserver / onTick 的桩
 */
function makeEnv({ cue = null, time = 0, secondary = '', display = 'none' } = {}) {
  const state = {
    cue,
    time,
    secondary,
    display,
    /** secondary 行被写了几次（幂等断言用） */
    writes: 0,
    /** 模块注册的订阅者（applyTranslations 之后会调用） */
    trackSubscriber: null,
  };
  const ticks = [];
  let observerCallback = null;

  const makeSecondary = () => ({
    style: {
      get display() {
        return state.display;
      },
      set display(value) {
        state.display = value;
      },
    },
    get textContent() {
      return state.secondary;
    },
    set textContent(value) {
      state.writes += 1;
      state.secondary = value;
    },
  });

  const makeRoot = (el) => ({
    querySelector(selector) {
      return selector === '.subtitle.subtitle-secondary' ? el : null;
    },
  });

  let secondaryEl = makeSecondary();
  const host = { shadowRoot: makeRoot(secondaryEl) };

  const sandbox = {
    console,
    document: {
      getElementById: (id) => (id === 'linglass-subtitle-overlay' ? host : null),
      querySelector: (selector) => {
        if (selector === '#movie_player video') return { currentTime: state.time };
        return null;
      },
    },
    MutationObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }

      observe() {}

      disconnect() {}
    },
    __llgModTrack: {
      getCurrent: () => state.cue,
      subscribe: (fn) => {
        state.trackSubscriber = fn;
      },
    },
    __llgModShared: {
      onTick: (fn) => {
        ticks.push(fn);
        return () => {};
      },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: '16-imported-subtitle.js' });

  return {
    state,
    host,
    /** 跑一轮心跳（重绑 + 重绘） */
    tick: () => {
      for (const fn of [...ticks]) fn();
    },
    /** 模拟官方又改了一次字幕行（观察器回调） */
    mutate: () => observerCallback(),
    /** 官方重建播放器：换一棵 shadowRoot，里面是新的、还没写字的 secondary 行 */
    rebuild: () => {
      state.secondary = '';
      state.display = 'none';
      secondaryEl = makeSecondary();
      host.shadowRoot = makeRoot(secondaryEl);
    },
  };
}

const IMPORTED_CUE = {
  start: 1,
  end: 5,
  primary: 'おはよう',
  secondary: '早上好（导入）',
  origin: 'imported',
};

test('导入句：画面译文行被换成导入的译文，并从隐藏变为可见', () => {
  const env = makeEnv({ cue: IMPORTED_CUE, time: 2, secondary: '官方译文', display: 'none' });

  assert.equal(env.state.secondary, '早上好（导入）');
  assert.equal(env.state.display, 'inline-block', '官方隐藏时我们要显示出来');
});

test('非导入句：官方译文一个字都不动', () => {
  const cue = { ...IMPORTED_CUE, origin: 'official' };
  const env = makeEnv({ cue, time: 2, secondary: '官方译文', display: 'inline-block' });

  assert.equal(env.state.secondary, '官方译文');
  assert.equal(env.state.display, 'inline-block');
});

test('句间空档：不接管（官方会把上一句收起来）', () => {
  const env = makeEnv({ cue: IMPORTED_CUE, time: 6, secondary: '', display: 'none' });

  assert.equal(env.state.secondary, '', '过了 cue.end 不许把上一句写回来');
  assert.equal(env.state.display, 'none');
});

test('官方重渲染覆盖之后，观察器要重新写回导入译文', () => {
  const env = makeEnv({ cue: IMPORTED_CUE, time: 2, secondary: '', display: 'none' });
  assert.equal(env.state.secondary, '早上好（导入）');

  // 官方在下一拍写了自己的译文
  env.state.secondary = '官方新译文';
  env.mutate();

  assert.equal(env.state.secondary, '早上好（导入）');
});

test('幂等：文本与可见性都没变时不重复写 DOM', () => {
  const env = makeEnv({ cue: IMPORTED_CUE, time: 2, secondary: '', display: 'none' });
  const afterLoad = env.state.writes;

  env.mutate();
  env.tick();
  env.mutate();

  assert.equal(env.state.writes, afterLoad, '重复回调不许制造无意义的 DOM 变更');
});

test('官方重建播放器换掉 shadowRoot 后，心跳要重新绑定并继续覆盖', () => {
  const env = makeEnv({ cue: IMPORTED_CUE, time: 2, secondary: '', display: 'none' });
  assert.equal(env.state.secondary, '早上好（导入）');

  env.rebuild();
  env.state.writes = 0;
  env.tick();

  assert.equal(env.state.secondary, '早上好（导入）');
  assert.equal(env.state.display, 'inline-block');
  assert.equal(env.state.writes, 1, '新树里应当写一次');
});
