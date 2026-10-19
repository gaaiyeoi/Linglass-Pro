#!/usr/bin/env node
/**
 * 探针 —— 在带我们扩展的独立浏览器里，直接读 Linglass 的内部数据。
 *
 * 为什么需要它：src/mod/ 的功能全部寄生在官方产物上，但官方内部状态（整条字幕轨、
 * 逐词数据、侧边栏 iframe 的真实规格）只存在于运行时的 JS 内存与 chrome.storage 里。
 * 静态读 vendor/ 能确认写入结构，确认不了「这条视频实际存下来了什么」。
 *
 * 怎么做：用 CDP 连一个加载了 dist/ 的浏览器，在**扩展自己的 isolated world** 里
 * 执行 chrome.storage.local.get —— 因为我们的 mod 脚本是叠加进官方扩展的
 * content_scripts 的，所以和官方共用同一个 storage 命名空间。
 *
 * 为什么不用系统 Chrome：Chrome 137+ 起 --load-extension 被移除（实测 155 直接忽略）。
 * 所以默认用 Playwright 缓存里的 Google Chrome for Testing（保留了该开关）。
 *
 * 用法：
 *   node tools/probe.mjs                       # 搜一个日语视频并打开
 *   node tools/probe.mjs --url=<视频地址>       # 指定视频
 *   node tools/probe.mjs --headed              # 有头（测画中画必须）
 *   node tools/probe.mjs --keep                # 跑完不关浏览器，自己进去看
 *   node tools/probe.mjs --wait=40             # 等字幕的秒数（默认 25）
 *
 * 零依赖：CDP 走 node 原生 fetch + WebSocket。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const EXT_ID_HINT = 'nhncklckpmkkhjcijjgfcgclfpbbkcba'; // Linglass 官方扩展 id
const PORT = 9335;
/** 持久化 profile：登录过 Linglass 之后，下次直接复用（--fresh 可强制开新的） */
const DEFAULT_PROFILE = path.join(ROOT, '.scratch', 'probe-profile');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  // 不能 split('=')：「--url=https://x/watch?v=abc」会被切成三段，值只剩到第二个 '=' 之前
  return eq === -1 ? true : hit.slice(eq + 1);
};

const KEEP = flag('keep') === true;
const HEADED = flag('headed') === true;
const WAIT_S = Number(flag('wait', 25));
const SEARCH = '日本語 字幕';
/** 兜底视频：找一个视频页来做注入检查，语言无关（不用于验证字幕内容） */
const FALLBACK_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/** Arc 的可执行文件。用 --browser=arc 时走它（注意：必须先把用户正在用的 Arc 退掉，
 *  否则新参数会被已有实例吞掉，扩展根本不会加载） */
const ARC_BIN = '/Applications/Arc.app/Contents/MacOS/Arc';

/** 找一个能加载扩展的浏览器：优先 Chrome for Testing，其次系统 Chrome */
function pickBrowser() {
  const requested = flag('browser');
  if (requested && requested !== 'arc') return requested;
  if (requested === 'arc') {
    if (!existsSync(ARC_BIN)) throw new Error(`找不到 Arc：${ARC_BIN}`);
    return ARC_BIN;
  }

  const candidates = [
    path.join(
      os.homedir(),
      'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    path.join(
      os.homedir(),
      'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64',
      'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('找不到可用的浏览器，先跑 npx playwright install chromium');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端：按 id 配对响应，其余事件转给订阅者 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => this.onMessage(ev.data));
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message || 'CDP 错误'}`));
      else resolve(msg.result);
      return;
    }
    for (const fn of this.listeners) fn(msg);
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 15000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // 忽略
    }
  }
}

/**
 * 调试端口的候选地址。
 *
 * 为什么不能只试 127.0.0.1：**复用已有 Arc 实例时它只监听 IPv6** —— 实测
 * `lsof` 显示 `[::1]:9335 (LISTEN)`，此时 `curl 127.0.0.1:9335` 直接连不上（000），
 * 而 `curl [::1]:9335` 是 200。只试 IPv4 会报一个很误导的「连不上调试端口：fetch failed」。
 */
const CDP_HOSTS = ['127.0.0.1', '[::1]'];

async function connect() {
  const deadline = Date.now() + 20000;
  let lastErr = null;
  while (Date.now() < deadline) {
    for (const host of CDP_HOSTS) {
      try {
        const res = await fetch(`http://${host}:${PORT}/json/version`);
        const info = await res.json();
        const ws = new WebSocket(info.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true });
          ws.addEventListener('error', reject, { once: true });
          setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
        });
        return new Cdp(ws);
      } catch (err) {
        // 这个地址不通就换下一个；两个都不通时把最后一条错误带出去
        lastErr = err;
      }
    }
    await sleep(400);
  }
  throw new Error(`连不上调试端口 ${PORT}（试了 ${CDP_HOSTS.join(' / ')}）：${lastErr && lastErr.message}`);
}

/** 在某个页面里求值；不传 contextId 就是页面 world */
async function evaluate(cdp, sessionId, expression, contextId) {
  const params = {
    // 外层必须 async 且 await 内层：内层若是 (async () => {...})()，
    // 直接 JSON.stringify 会把它序列化成 "{}"，awaitPromise 也救不回来（顶层已是字符串）。
    expression: `(async () => { try { return JSON.stringify(await (${expression})); } catch (e) { return JSON.stringify({ __error: String((e && e.message) || e) }); } })()`,
    returnByValue: true,
    awaitPromise: true,
  };
  if (contextId) params.contextId = contextId;
  const res = await cdp.send('Runtime.evaluate', params, sessionId);
  if (res.exceptionDetails) {
    return { __error: res.exceptionDetails.text || '求值异常' };
  }
  const raw = res.result && res.result.value;
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}

function rule(title) {
  console.log(`\n${'─'.repeat(4)} ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

/**
 * 把候选规则对比的结果打成人眼能并排看的一行一条。
 * `clearance` 是「面板左边缘 − 视频右边缘」：正数 = 视频完全在面板左边（不遮挡），
 * 负数就是被压了多少像素。
 */
function printLayoutCompare(label, data) {
  if (!data || !data.candidates) {
    console.log(`[probe] ${label}: ${JSON.stringify(data)}`);
    return;
  }
  console.log(`[probe] ${label}  viewport=${data.viewport.w}×${data.viewport.h}`
    + ` theater=${data.theater} fullscreen=${data.documentFullscreen} panelW=${data.panelWidth}`);

  const row = (name, m) => {
    const span = (r) => (r ? `${r.left}..${r.right}` : '-');
    // 除了 video（要求不重叠），还要看 #secondary（推荐列）：它伸到面板底下同样是遮挡
    console.log(`[probe]   ${String(name).padEnd(28)} overlap=${String(m.overlap).padEnd(5)}`
      + ` clearance=${String(m.clearance).padStart(5)}`
      + ` video=[${span(m.video)}]`
      + ` primary=[${span(m.primary)}] secondary=[${span(m.secondary)}]`
      + ` columns=[${span(m.columns)}] mastheadRight=${m.masthead ? m.masthead.right : '-'}`);
  };
  if (data.boxes) {
    for (const [name, box] of Object.entries(data.boxes)) {
      if (!box) continue;
      console.log(`[probe]   ${name.padEnd(10)} rect=${box.rect.padEnd(12)}`
        + ` width=${box.width} min=${box.minWidth} max=${box.maxWidth}`
        + ` flex=${box.flex} padR=${box.paddingRight} overflowX=${box.overflowX}`);
    }
  }

  // 注意：面板是**用真实按钮点开**的，所以我们的让位样式此时已经注入 ——
  // 这一行就是「我们现在的实现」的实测结果；下面的候选是覆盖在它之上的对照。
  row('baseline(现状)', data.baseline);
  for (const candidate of data.candidates) row(candidate.name, candidate);
}

/**
 * 面板压住了谁 —— 一次性把「面板 vs 页面内容」的量测打成几行。
 *
 * 为什么不能只看 clearance（面板左边缘 − video 右边缘）：那条只证明视频让开了。
 * 面板是 fixed 全高、贴在右边缘的，而推荐列（#secondary）的宽度由 YouTube 自己定、
 * 不跟着容器缩 —— 所以「video 让开了」完全可能与「推荐列被压在面板底下」同时成立。
 * 这个函数就是回答「面板到底压住了谁」的。
 */
function printPanelVsPage(label, data) {
  const p = data && data.panel;
  if (!p) {
    console.log(`[probe] ${label}: 面板不在（panelState=${data ? data.panelState : '-'}）`);
    return;
  }

  const viewport = data.viewport ? `${data.viewport.w}×${data.viewport.h}` : '-';
  console.log(`[probe] ${label}  viewport=${viewport}`
    + ` panel=[${p.left}..${p.right}] (${p.width}px)`);

  const targets = [
    ['#movie_player', data.layout && data.layout.player],
    ['#columns', data.layout && data.layout.columns],
    ['#secondary', data.layout && data.layout.secondary],
    ['#masthead', data.layout && data.layout.masthead],
  ];

  for (const [name, rect] of targets) {
    if (!rect) {
      console.log(`[probe]   ${name.padEnd(14)} -`);
      continue;
    }
    const horizontal = rect.right > p.left && rect.left < p.right;
    const vertical = rect.bottom > p.top && rect.top < p.bottom;
    // inside：面板整个落在这一块里面。列形态下这是**想要的**结果 ——
    // 面板寄生在 `#secondary` 里，与它相交是天经地义，不代表遮挡了别的东西。
    const inside = rect.left <= p.left && p.right <= rect.right
      && rect.top <= p.top && p.bottom <= rect.bottom;
    console.log(`[probe]   ${name.padEnd(14)} [${rect.left}..${rect.right}]`
      + ` overlap=${horizontal && vertical}`
      + ` inside=${inside}`
      + ` clearance=${Math.round(p.left - rect.right)}`);
  }
}

/** 等到 document.readyState 变成 complete；SPA 的内容还要额外等一会儿 */
async function waitPage(cdp, sessionId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evaluate(cdp, sessionId, 'document.readyState').catch(() => null);
    if (state === 'complete') return true;
    await sleep(400);
  }
  return false;
}

/** 我们注入到页面里的东西（页面 world 就能看到 DOM） */
const DOM_PROBE = `({
  controls: !!document.querySelector('.ytp-right-controls'),
  ourButtons: ['llg-pip-btn', 'llg-panel-btn'].map((id) => {
    const el = document.getElementById(id);
    if (!el) return { id, present: false };
    const after = el.previousElementSibling;
    return {
      id,
      present: true,
      label: el.dataset.tooltipText || null,
      disabled: !!el.disabled,
      onClass: el.classList.contains('is-on'),
      prev: after ? (after.id || after.className) : null,
    };
  }),
  settingsHost: !!document.getElementById('linglass-settings-panel-v2'),
  subtitleHost: !!document.getElementById('linglass-subtitle-overlay'),
  studyPanelRoot: !!document.getElementById('llg-study-panel-root'),
  video: (() => {
    const v = document.querySelector('#movie_player video') || document.querySelector('video');
    return v ? { currentTime: Math.round(v.currentTime * 10) / 10, duration: v.duration, paused: v.paused, readyState: v.readyState } : null;
  })(),
})`;

/** 官方字幕浮层里到底渲染了什么（含逐词 span） */
const SUBTITLE_PROBE = `(() => {
  const host = document.getElementById('linglass-subtitle-overlay');
  const root = host && host.shadowRoot;
  if (!root) return { host: !!host, shadow: false };
  const group = root.querySelector('.subtitle-group');
  const words = root.querySelectorAll('.linglass-word');
  const wordSample = [];
  for (let i = 0; i < Math.min(words.length, 3); i += 1) {
    wordSample.push({
      word: words[i].dataset.word,
      start: words[i].dataset.start,
      end: words[i].dataset.end,
    });
  }
  const text = (sel) => {
    const el = root.querySelector(sel);
    return el ? el.textContent.slice(0, 60) : null;
  };
  return {
    host: true,
    shadow: true,
    groupDisplay: group ? group.style.display : null,
    primary: text('.subtitle.subtitle-primary'),
    secondary: text('.subtitle.subtitle-secondary'),
    wordSpanCount: words.length,
    wordSample,
    classes: Array.from(root.querySelectorAll('[class]')).slice(0, 12).map((e) => e.className).filter((c) => typeof c === 'string'),
  };
})()`;

/** 官方设置面板里我们的行渲染成什么样 */
const SETTINGS_PROBE = `(() => {
  const host = document.getElementById('linglass-settings-panel-v2');
  const root = host && host.shadowRoot;
  if (!root) return { host: !!host, shadow: false };
  const section = root.querySelector('[data-llg-mod="section"]');
  return {
    host: true,
    shadow: true,
    panelPages: !!root.querySelector('.panel-pages'),
    rootPage: !!root.querySelector('.panel-content.panel-page[data-page="root"]'),
    sectionTitle: section ? section.textContent : null,
    ourNodeCount: root.querySelectorAll('[data-llg-mod]').length,
    toggles: Array.from(root.querySelectorAll('[data-llg-toggle]')).map((t) => ({
      id: t.dataset.llgToggle,
      on: t.classList.contains('on'),
      cls: t.className,
      knob: !!t.querySelector('.toggle-knob'),
    })),
    rows: Array.from(root.querySelectorAll('[data-llg-mod^="row:"]')).map((r) => r.textContent.trim().slice(0, 24)),
    actions: Array.from(root.querySelectorAll('[data-llg-mod^="action:"]')).map((a) => a.textContent.trim().slice(0, 36)),
  };
})()`;

/** 我们自己的学习面板 */
const PANEL_PROBE = `(() => {
  const host = document.getElementById('llg-study-panel-root');
  if (!host || !host.shadowRoot) return { present: false };
  const root = host.shadowRoot;
  const pick = (role) => root.querySelector('[data-role="' + role + '"]');
  const panel = pick('panel');
  const list = pick('list');
  return {
    present: true,
    state: panel ? panel.dataset.state : null,
    width: panel ? Math.round(panel.getBoundingClientRect().width) : null,
    right: panel ? Math.round(window.innerWidth - panel.getBoundingClientRect().right) : null,
    hasResize: !!pick('resize'),
    listRows: list ? list.children.length : null,
    title: pick('title') ? pick('title').textContent : null,
    sub: pick('sub') ? pick('sub').textContent : null,
    hasStyle: !!root.querySelector('style'),
  };
})()`;

/**
 * 布局探针：面板打开后，它和视频到底谁压着谁。
 *
 * 「不遮挡视频」这条需求在 Node 侧完全测不了（要真浏览器的真实排版），
 * 所以这里是它唯一的验收手段：量面板矩形与视频矩形是否相交，并顺带把
 * YouTube 的几种布局（默认 / 剧场 / 全屏）与让位用的 DOM 事实一起 dump 出来，
 * 方便改规则时不用靠猜。会自己把面板点开（已经开着就不点，免得反手关掉）。
 */
const LAYOUT_PROBE = `(async () => {
  const pick = () => {
    const host = document.getElementById('llg-study-panel-root');
    const shadow = host && host.shadowRoot;
    return { host, shadow, panel: shadow ? shadow.querySelector('[data-role="panel"]') : null };
  };

  if (!pick().panel) {
    const btn = document.getElementById('llg-panel-btn');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 500));
  }
  if (pick().panel && pick().panel.dataset.state !== 'open') {
    const btn = document.getElementById('llg-panel-btn');
    if (btn) btn.click();
    await new Promise((r) => setTimeout(r, 500));
  }

  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const round = (n) => Math.round(n);
    return {
      left: round(r.left), right: round(r.right),
      top: round(r.top), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height),
    };
  };

  const { panel } = pick();
  const video = document.querySelector('#movie_player video');
  const p = rect(panel);
  const v = rect(video);
  const overlap = Boolean(p && v)
    && !(v.right <= p.left || v.left >= p.right || v.bottom <= p.top || v.top >= p.bottom);

  const app = document.querySelector('ytd-app');
  return {
    panelState: panel ? panel.dataset.state : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    panel: p,
    video: v,
    overlap,
    clearance: p && v ? Math.round(p.left - v.right) : null,
    html: {
      marker: document.documentElement.getAttribute('data-llg-panel'),
      widthVar: getComputedStyle(document.documentElement).getPropertyValue('--llg-panel-w').trim(),
    },
    layout: {
      theater: Boolean(document.querySelector('ytd-watch-flexy[theater]')),
      fullscreen: Boolean(document.querySelector('ytd-watch-flexy[fullscreen]')),
      app: rect(app),
      appMarginRight: app ? getComputedStyle(app).marginRight : null,
      columns: rect(document.querySelector('#columns')),
      secondary: rect(document.querySelector('#secondary')),
      fullBleed: rect(document.querySelector('#full-bleed-container')),
      player: rect(document.querySelector('#movie_player')),
      masthead: rect(document.querySelector('#masthead-container')),
    },
  };
})()`;

/**
 * 让位规则的候选清单（见 layoutCompareProbe）。
 *
 * 这些都是「把页面内容收窄，给右侧面板腾地方」的写法，差别在于挂在哪一层、
 * 用 padding 还是 margin —— 剧场模式下播放器在 `#full-bleed-container` 里贴满视口，
 * 两种写法的结果可能完全不同，所以必须实测，不能推理。
 */
const LAYOUT_CANDIDATES = [
  // 实测教训：只把容器改窄，`<video>` 的矩形**一动不动** —— 剧场模式下播放器的
  // 尺寸是 YouTube 自己的 JS 算出来写进内联样式/由它自己的 ResizeObserver 驱动的，
  // 光改 CSS 不会重算。所以每条候选都带上「补一次 resize 事件」这个动作，
  // 并且单独留一条 baseline+nudge 用来看「是不是只要 nudge 就够了」。
  {
    // 上一轮实测：只让位给视频不够 —— 两列栅格在收窄后的容器里溢出，
    // #columns 宽 1221 而可用只有 994，推荐列被面板压住 227px；
    // `#primary{min-width:0}` / 折行 / `#secondary{width:100%}` 都治不好（要么没效果，
    // 要么把视频反而拉宽）。所以这一轮直接试「把 #columns 自己夹住」这一族写法。
    name: 'columns-max100',
    css: '#columns { max-width: 100% !important; }',
    nudge: true,
  },
  {
    name: 'columns-max100+min0',
    css: '#columns { max-width: 100% !important; }\n'
      + '#primary { min-width: 0 !important; }',
    nudge: true,
  },
  {
    name: 'columns-max100+sec402',
    css: '#columns { max-width: 100% !important; }\n'
      + '#primary { min-width: 0 !important; }\n'
      + '#secondary { width: 402px !important; flex: 0 0 402px !important; }',
    nudge: true,
  },
  {
    name: 'flexy-fit+columns-max100',
    css: 'ytd-watch-flexy { min-width: 0 !important; max-width: 100% !important; }\n'
      + '#columns { max-width: 100% !important; }\n'
      + '#primary { min-width: 0 !important; }',
    nudge: true,
  },
];

/** 顶栏与迷你播放器是 fixed 的，任何让位规则都盖不住它们，得单独让 */
const LAYOUT_MASTHEAD_CSS = `
#masthead-container { width: calc(100% - var(--llg-panel-w)) !important; }
ytd-miniplayer { right: var(--llg-panel-w) !important; }
`;

/**
 * 候选规则对比探针：在同一种布局下依次套用每条候选规则，各量一次「面板 vs 视频」。
 *
 * 为什么要这样：单次测量的成败分不清「规则不对」和「量的时候布局还没稳定」，
 * 而且每换一条规则都重跑一次探针（要开真浏览器）代价太高。一次跑完所有候选，
 * 结果直接并排比较，才能选出真正生效的那条。
 */
function layoutCompareProbe(candidates = LAYOUT_CANDIDATES) {
  return `(async () => {
  const candidates = ${JSON.stringify(candidates)};
  const mastheadCss = ${JSON.stringify(LAYOUT_MASTHEAD_CSS)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const panelNow = () => {
    const host = document.getElementById('llg-study-panel-root');
    const shadow = host && host.shadowRoot;
    return shadow ? shadow.querySelector('[data-role="panel"]') : null;
  };

  if (!panelNow() || panelNow().dataset.state !== 'open') {
    const btn = document.getElementById('llg-panel-btn');
    if (btn) btn.click();
    await sleep(500);
    if (panelNow() && panelNow().dataset.state !== 'open') { btn.click(); await sleep(500); }
  }

  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const round = (n) => Math.round(n);
    return {
      left: round(r.left), right: round(r.right),
      top: round(r.top), bottom: round(r.bottom),
      width: round(r.width), height: round(r.height),
    };
  };

  /**
   * 关键盒子的计算样式。
   *
   * 为什么要打这个：只看到「#columns 宽 1221 而可用只有 994」还不够 —— 得知道这
   * 1221 是它自己的 width / min-width 来的，还是父级撑出来的，才能写对覆盖规则。
   */
  const boxes = () => {
    const pick = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        // 注意：这里是**外层模板字符串里的代码**，不能用反引号（会提前结束字符串）
        rect: Math.round(r.left) + '..' + Math.round(r.right),
        width: cs.width,
        minWidth: cs.minWidth,
        maxWidth: cs.maxWidth,
        flex: cs.flex,
        paddingRight: cs.paddingRight,
        overflowX: cs.overflowX,
      };
    };
    return {
      app: pick('ytd-app'),
      flexy: pick('ytd-watch-flexy'),
      columns: pick('#columns'),
      primary: pick('#primary'),
      secondary: pick('#secondary'),
    };
  };

  const measure = () => {
    const p = rect(panelNow());
    const v = rect(document.querySelector('#movie_player video'));
    const overlap = Boolean(p && v)
      && !(v.right <= p.left || v.left >= p.right || v.bottom <= p.top || v.top >= p.bottom);
    return {
      overlap,
      clearance: p && v ? Math.round(p.left - v.right) : null,
      panel: p,
      video: v,
      player: rect(document.querySelector('#movie_player')),
      fullBleed: rect(document.querySelector('#full-bleed-container')),
      columns: rect(document.querySelector('#columns')),
      // 推荐列：宽度由 YouTube 自己定（不跟着容器缩），所以「video 让开了」不等于
      // 「整页都让开了」。量它才能回答「面板压住了谁」。
      secondary: rect(document.querySelector('#secondary')),
      app: rect(document.querySelector('ytd-app')),
      masthead: rect(document.querySelector('#masthead-container')),
      primary: rect(document.querySelector('#primary')),
    };
  };

  const style = document.createElement('style');
  style.id = 'llg-probe-layout';
  document.head.appendChild(style);

  const panelWidth = Math.round(panelNow() ? panelNow().getBoundingClientRect().width : 400);
  document.documentElement.setAttribute('data-llg-panel', 'probe');
  document.documentElement.style.setProperty('--llg-panel-w', panelWidth + 'px');

  const out = {
    panelWidth,
    theater: Boolean(document.querySelector('ytd-watch-flexy[theater]')),
    fullscreenAttr: Boolean(document.querySelector('ytd-watch-flexy[fullscreen]')),
    documentFullscreen: Boolean(document.fullscreenElement),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    baseline: measure(),
    boxes: boxes(),
    candidates: [],
  };

  const nudgeResize = () => {
    window.dispatchEvent(new Event('resize'));
    const video = document.querySelector('#movie_player video');
    if (video) video.dispatchEvent(new Event('resize', { bubbles: false }));
  };

  for (const candidate of candidates) {
    style.textContent = mastheadCss + '\\n' + candidate.css;
    await sleep(600);
    if (candidate.nudge) {
      nudgeResize();
      await sleep(600);
      nudgeResize();
    }
    await sleep(900);
    out.candidates.push({ name: candidate.name, ...measure() });
  }

  style.textContent = '';
  await sleep(300);
  style.remove();
  document.documentElement.removeAttribute('data-llg-panel');
  document.documentElement.style.removeProperty('--llg-panel-w');

  return out;
})()`;
}

/** 当前是不是剧场模式 */
const THEATER_PROBE = '(() => Boolean(document.querySelector("ytd-watch-flexy[theater]")))()';

/** 系统级画中画窗口 */
const PIP_PROBE = `(() => {
  const apiPresent = 'documentPictureInPicture' in window;
  const w = apiPresent ? documentPictureInPicture.window : undefined;
  if (!w) return { apiPresent, windowOpen: false };
  const d = w.document;
  const text = (id) => (d.getElementById(id) ? d.getElementById(id).textContent : null);
  const width = (id) => (d.getElementById(id) ? d.getElementById(id).style.width : null);
  return {
    apiPresent,
    windowOpen: true,
    closed: w.closed,
    size: { w: w.innerWidth, h: w.innerHeight },
    primary: text('line-primary'),
    secondary: text('line-secondary'),
    fillPrimary: width('fill-primary'),
    hasBox: !!d.getElementById('box'),
  };
})()`;

/**
 * 画中画存活采样（PLAN 032）。
 *
 * 与 PIP_PROBE 分开：PIP_PROBE 的口径被「实测④」钉着，这里只关心
 * 「窗口还在不在」以及**同一时刻**宿主页面的可见性/焦点 —— 三者的组合才能判断
 * 是「切标签页」、「切应用」还是「回到 opener」触发了收走。
 */
const PIP_ALIVE_PROBE = `(() => {
  const apiPresent = 'documentPictureInPicture' in window;
  const w = apiPresent ? documentPictureInPicture.window : undefined;
  const btn = document.getElementById('llg-pip-btn');
  return {
    apiPresent,
    windowOpen: !!w,
    closed: w ? !!w.closed : null,
    visibility: document.visibilityState,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
    buttonOn: btn ? btn.classList.contains('is-on') : null,
  };
})()`;

/** 扩展 isolated world 里才有的东西 */
const STORAGE_PROBE = `(async () => {
  const grab = async (area) => {
    try {
      return await chrome.storage[area].get(null);
    } catch (err) {
      return { __error: String((err && err.message) || err) };
    }
  };
  const all = await grab('local');
  const sync = await grab('sync');
  const session = await grab('session');

  const keys = Object.keys(all);
  const cacheKeys = keys.filter((k) => k.startsWith('subtitle-cache:v6:'));
  const index = all['subtitle-cache:index'] || null;
  const details = cacheKeys.map((k) => {
    const entry = all[k] || {};
    const sampleOf = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
    return {
      key: k,
      cueCount: Array.isArray(entry.cues) ? entry.cues.length : null,
      rawCueCount: Array.isArray(entry.rawCues) ? entry.rawCues.length : null,
      mergePlanCount: Array.isArray(entry.mergePlan) ? entry.mergePlan.length : null,
      partsCount: Array.isArray(entry.parts) ? entry.parts.length : null,
      isAsr: entry.isAsr ?? null,
      fields: Object.keys(entry),
      cueSample: sampleOf(entry.cues),
      rawCueSample: sampleOf(entry.rawCues),
      mergePlanSample: sampleOf(entry.mergePlan),
    };
  });

  return {
    areaKeyCount: { local: keys.length, sync: Object.keys(sync).length, session: Object.keys(session).length },
    localKeys: keys,
    syncKeys: Object.keys(sync),
    sessionKeys: Object.keys(session),
    cacheKeyCount: cacheKeys.length,
    indexEntryCount: index && Array.isArray(index.entries) ? index.entries.length : null,
    indexKeys: index && Array.isArray(index.entries) ? index.entries.map((e) => e.key) : null,
    details,
    settingsLike: keys.filter((k) => !k.startsWith('subtitle-cache')),
    settingsSnapshot: keys
      .filter((k) => /linglass-(settings|user|prefs|lang)/i.test(k))
      .slice(0, 6)
      .map((k) => ({ key: k, value: JSON.stringify(all[k]).slice(0, 300) })),
  };
})()`;

/**
 * 用真实输入事件点击。
 * 不能用 element.click()：画中画要「用户手势」（transient activation），脚本触发的
 * click 不算，requestWindow 会被直接拒绝。
 */
async function clickSelector(cdp, sessionId, selector, hostId = null) {
  const box = await evaluate(cdp, sessionId, `(() => {
    ${hostId
      ? `const host = document.getElementById(${JSON.stringify(hostId)});
         const root = host && host.shadowRoot;
         const el = root && root.querySelector(${JSON.stringify(selector)});`
      : `const el = document.querySelector(${JSON.stringify(selector)});`}
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box || typeof box.x !== 'number') return false;

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, sessionId);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 },
    sessionId,
  );
  await sleep(60);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 },
    sessionId,
  );
  return true;
}

/**
 * 把鼠标移到播放器上，让 YouTube 的控制栏显形。
 *
 * 实测：控制栏自动隐藏时，`clickSelector` 那套真实坐标点击会落在视频上 ——
 * 表现为「点了剧场按钮但 theater 属性没变」。所以点控制栏之前必须先 hover。
 */
async function hoverPlayer(cdp, sessionId) {
  const box = await evaluate(cdp, sessionId, `(() => {
    const el = document.querySelector('#movie_player');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!box || typeof box.x !== 'number') return false;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, sessionId);
  await sleep(900);
  return true;
}

/**
 * 切剧场模式。
 *
 * 实测：控制栏自动隐藏时，真实坐标点击会落在视频上（点了个寂寞）；而剧场开关
 * 不需要用户激活，所以用程序化 click 更可靠 —— 与全屏不同，全屏必须有瞬时激活。
 */
async function toggleTheater(cdp, sessionId) {
  const before = await evaluate(cdp, sessionId, THEATER_PROBE);
  const clicked = await evaluate(cdp, sessionId, `(() => {
    const btn = document.querySelector('.ytp-size-button');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(2500);
  const after = await evaluate(cdp, sessionId, THEATER_PROBE);
  console.log(`[probe] 剧场切换: 点击=${clicked}  ${before} → ${after}`);
  return after;
}

/** 反复切到想要的剧场状态（最多试 3 次），返回最终状态 */
async function ensureTheater(cdp, sessionId, want) {
  let state = await evaluate(cdp, sessionId, THEATER_PROBE);
  for (let i = 0; i < 3 && state !== want; i += 1) {
    state = await toggleTheater(cdp, sessionId);
  }
  return state;
}

/** 拖拽 shadow DOM 里的手柄（测面板改宽）。dx 为负表示往左拖，面板变宽 */
async function dragShadowHandle(cdp, sessionId, hostId, selector, dx) {
  const box = await evaluate(cdp, sessionId, `(() => {
    const host = document.getElementById(${JSON.stringify(hostId)});
    const root = host && host.shadowRoot;
    const el = root && root.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box || typeof box.x !== 'number') return false;

  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 },
    sessionId,
  );
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: box.x + (dx * i) / steps, y: box.y, button: 'left', buttons: 1 },
      sessionId,
    );
    await sleep(30);
  }
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: box.x + dx, y: box.y, button: 'left', buttons: 0, clickCount: 1 },
    sessionId,
  );
  return true;
}

// ------------------------------------------------- 画中画存活实测（PLAN 032）
//
// 要回答的是「浮窗到底在哪个时刻丢的」：切标签页？切应用？还是切回浏览器。
// 三段实测都只是**采样**，不改任何产品代码 —— 结论决定后面走「优化重开时机」还是「原生 helper」。

/** 打印一行采样（中文不 padEnd：中文字符的显示宽度不是 1，按长度对齐反而更歪） */
function printPipSample(phase, elapsed, sample) {
  console.log(`[probe] ${phase} +${String(elapsed).padStart(4)}ms  `
    + `窗口=${sample.windowOpen ? '在' : '没了'}  `
    + `可见=${sample.visibility}  焦点=${sample.hasFocus}  `
    + `按钮=${sample.buttonOn ? 'on' : 'off'}`);
}

/**
 * 按 gaps（距上一次采样的毫秒数）连续采样。
 * 返回最后一次采样与「第一次发现窗口没了」的时刻 —— 立刻没与延迟几秒没，含义完全不同。
 */
async function pipTimeline(cdp, sessionId, phase, gaps) {
  let elapsed = 0;
  let lostAt = null;
  let last = null;
  for (const gap of gaps) {
    if (gap) await sleep(gap);
    elapsed += gap;
    const sample = await evaluate(cdp, sessionId, PIP_ALIVE_PROBE);
    last = sample;
    if (lostAt === null && !sample.windowOpen) lostAt = elapsed;
    printPipSample(phase, elapsed, sample);
  }
  return { last, lostAt };
}

/** 一句结论：只在「切走」与「切回」两段各取最后一份采样，避免把中间态读成结论 */
function printPipVerdict(name, away, back) {
  if (!away || !back) return;
  const awayAlive = Boolean(away.last && away.last.windowOpen);
  const backAlive = Boolean(back.last && back.last.windowOpen);
  if (!awayAlive) {
    console.log(`[probe] 结论(${name})：切走时就被收走`
      + `${away.lostAt === null ? '' : `（+${away.lostAt}ms）`}`);
    return;
  }
  if (!backAlive) {
    console.log(`[probe] 结论(${name})：切走时还在，切回来被收走`
      + `${back.lostAt === null ? '' : `（+${back.lostAt}ms）`}`);
    return;
  }
  console.log(`[probe] 结论(${name})：切走与切回都还在`);
}

/**
 * 切到同一浏览器的另一个标签页再切回来。
 *
 * 用 CDP 而不是键盘快捷键：Arc 上快捷键会被它自己吃掉。
 * `Target.createTarget` 在 Arc 里会被立刻搬走（见 pickPage 上方注释），失败就跳过 ——
 * 这一段的失败不该连累「切应用」那一段。
 */
async function pipTabSwitch(cdp, sessionId, pageTarget) {
  let other = null;
  try {
    const created = await cdp.send('Target.createTarget', { url: 'about:blank', background: false });
    other = created.targetId;
  } catch (err) {
    console.log(`[probe] 当前浏览器不允许新建标签页（${err.message}），跳过切标签页实测`);
    return null;
  }

  try {
    await sleep(900);
    const away = await pipTimeline(cdp, sessionId, '切走(新标签页)', [600, 2400]);
    try {
      await cdp.send('Target.activateTarget', { targetId: pageTarget.targetId });
    } catch (err) {
      console.log(`[probe] Target.activateTarget 不可用（${err.message}），改用 Page.bringToFront`);
      await cdp.send('Page.bringToFront', {}, sessionId);
    }
    const back = await pipTimeline(cdp, sessionId, '切回(原标签页)', [400, 1000, 2500]);
    printPipVerdict('标签页', away, back);
    return { away, back };
  } finally {
    if (other) {
      await cdp.send('Target.closeTarget', { targetId: other }).catch(() => {});
    }
  }
}

/** 从可执行文件路径截出 .app（`/Applications/Arc.app/Contents/MacOS/Arc` → `/Applications/Arc.app`） */
function appBundlePath(bin) {
  const index = String(bin).indexOf('.app/');
  return index === -1 ? null : String(bin).slice(0, index + 4);
}

/** `open -a`：不触发「自动化」权限弹窗（AppleScript 控制别的 app 会） */
function activateApp(appPath) {
  try {
    execFileSync('open', ['-a', appPath], { stdio: 'ignore' });
    return true;
  } catch (err) {
    console.log(`[probe] open -a ${path.basename(appPath)} 失败：${err.message}`);
    return false;
  }
}

/** 切到别的应用再切回来 —— 这才是用户真正要验证的那个动作 */
async function pipAppSwitch(cdp, sessionId, browserBin) {
  if (process.platform !== 'darwin') {
    console.log('[probe] 非 macOS：跳过「切到别的应用」实测');
    return null;
  }
  const app = appBundlePath(browserBin);
  if (!app) {
    console.log('[probe] 无法从浏览器路径推出 .app，跳过「切到别的应用」实测');
    return null;
  }

  console.log(`[probe] 切走 → Finder，切回 → ${path.basename(app)}`);
  if (!activateApp('Finder')) return null;
  const away = await pipTimeline(cdp, sessionId, '切走(Finder)', [700, 2500]);

  if (!activateApp(app)) return { away, back: null };
  const back = await pipTimeline(cdp, sessionId, '切回(浏览器)', [400, 1200, 2500]);
  printPipVerdict('应用', away, back);
  return { away, back };
}

/**
 * 窗口丢了之后，一次**真实**页面点击能不能把它接回来。
 *
 * 点的是播放器左上角：YouTube 会顺带切换播放/暂停（探针可接受），
 * 但那次 pointerdown 是真实手势，会命中 `arm()` 的一次性监听。
 */
async function restorePipByClick(cdp, sessionId) {
  const before = await evaluate(cdp, sessionId, PIP_ALIVE_PROBE);
  if (before.windowOpen) return before;

  const box = await evaluate(cdp, sessionId, `(() => {
    const el = document.querySelector('#movie_player');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + 30) };
  })()`);
  if (!box) {
    console.log('[probe] 找不到播放器，无法验证「手势重开」');
    return before;
  }

  console.log('[probe] 窗口已不在，点一下播放器（会顺带切换播放/暂停）验证手势重开');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y }, sessionId);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 },
    sessionId,
  );
  await sleep(60);
  await cdp.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 },
    sessionId,
  );
  const timeline = await pipTimeline(cdp, sessionId, '手势后', [1200, 2000]);
  console.log(`[probe] 结论(手势重开)：${timeline.last && timeline.last.windowOpen ? '成功' : '失败'}`);
  return timeline.last;
}

/**
 * 从 target 列表里挑出要操作的那个页面。
 *
 * 不能直接取「第一个 page」：Arc 会忽略 --user-data-dir 而用你本人的 profile，
 * 列表里因此混着你自己的标签页 —— 实测撞上过一个 localhost 页面，attach 之后
 * Runtime.enable 直接超时。给了 --url 时优先按它匹配。
 */
function pickPage(targetInfos, wantUrl) {
  const pages = targetInfos.filter(
    (t) => t.type === 'page' && !String(t.url).startsWith('chrome-extension://'),
  );
  if (wantUrl) {
    const bare = wantUrl.split('?')[0];
    const exact = pages.find((t) => String(t.url).startsWith(bare));
    if (exact) return exact;
    const youtube = pages.find((t) => String(t.url).includes('youtube.com/watch'));
    if (youtube) return youtube;
  }
  // 只有 YouTube 页能碰：其它页（实测撞到过 localhost 开发页、linglass.app 落地页）
  // attach 之后 Runtime.enable 会直接超时 —— 那不是「页面在忙」，而是这类 target
  // 在 Arc 里没被真正托管给调试器。宁可让调用方另开一个 YouTube 标签。
  const anyYoutube = pages.find((t) => String(t.url).includes('youtube.com'));
  if (anyYoutube) return anyYoutube;
  return pages.find((t) => String(t.url).startsWith('http')) || pages[0] || null;
}

/** 挑出来的这个 target 能不能用（是不是 YouTube 页） */
function isUsablePage(target) {
  return Boolean(target) && String(target.url || '').includes('youtube.com');
}

async function main() {
  if (!existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('dist/ 不存在，先跑 make build');
  }

  const browser = pickBrowser();
  const fresh = flag('fresh') === true;
  let profile;
  if (fresh) {
    profile = await mkdtemp(path.join(os.tmpdir(), 'llg-probe-'));
  } else {
    profile = flag('profile') || DEFAULT_PROFILE;
    await mkdir(profile, { recursive: true });
  }
  const childArgs = [
    `--user-data-dir=${profile}`,
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--autoplay-policy=no-user-gesture-required',
    // headless 的默认 UA 里带 HeadlessChrome，YouTube 会当成爬虫给降级页面（实测首页拿不到任何视频链接）
    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    'about:blank',
  ];
  if (!HEADED) childArgs.unshift('--headless=new');

  console.log(`[probe] 浏览器  ${path.basename(browser)}${HEADED ? ' (有头)' : ' (headless)'}`);
  console.log(`[probe] 扩展    ${DIST}`);

  const child = spawn(browser, childArgs, { stdio: 'ignore', detached: false });
  let cdp = null;

  try {
    cdp = await connect();
    const version = await cdp.send('Browser.getVersion');
    console.log(`[probe] 内核    ${version.product || '?'}  (${version.jsVersion || '?'})`);

    const { targetInfos } = await cdp.send('Target.getTargets');
    let pageTarget = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    if (!pageTarget) {
      const extTargets = targetInfos.filter((t) => String(t.url).startsWith('chrome-extension://'));
      console.log(extTargets.length
        ? `[probe] 扩展已加载（${extTargets.length} 个 target），但还没有普通标签页`
        : '[probe] 没有扩展 target，--load-extension 可能被忽略');

      // Arc 不吃命令行的 URL 参数，Target.createTarget 建出来的 target 也会被它立刻搬走
      // （实测 attach 报 "No target with given id found"）。让 Arc 自己开标签页最稳。
      const kickUrl = flag('url') || 'https://www.youtube.com/';
      console.log(`[probe] 用 AppleScript 让 Arc 打开 ${kickUrl}`);
      try {
        execFileSync('osascript', ['-e', `tell application "Arc" to open location "${kickUrl}"`], { stdio: 'ignore' });
      } catch (err) {
        console.log(`[probe] AppleScript 失败：${err && err.message}`);
      }
      await sleep(6000);

      const again = await cdp.send('Target.getTargets');
      pageTarget = pickPage(again.targetInfos, flag('url'));
      if (!pageTarget) {
        console.log('[probe] Arc 仍然没开出标签页，当前 target：');
        for (const t of again.targetInfos) console.log(`  ${t.type} | ${String(t.url).slice(0, 110)}`);
        return;
      }
    }

    // Arc 用的是你本人的 profile，列表里全是你日常的标签页 —— 而它们不能碰（见 pickPage）。
    // 挑中的不是 YouTube 就让 Arc 自己再开一个：命令行的 URL 参数与 Target.createTarget
    // 在 Arc 上都不行，只有 AppleScript 这条路稳。
    if (pageTarget && !isUsablePage(pageTarget)) {
      const kickUrl = flag('url') || 'https://www.youtube.com/';
      console.log(`[probe] 挑中的标签页不是 YouTube（${String(pageTarget.url).slice(0, 60)}），让 Arc 另开 ${kickUrl}`);
      try {
        execFileSync('osascript', ['-e', `tell application "Arc" to open location "${kickUrl}"`], { stdio: 'ignore' });
      } catch (err) {
        console.log(`[probe] AppleScript 失败：${err && err.message}`);
      }
      await sleep(6000);

      const again = await cdp.send('Target.getTargets');
      const usable = pickPage(again.targetInfos, flag('url'));
      if (isUsablePage(usable)) pageTarget = usable;
      else console.log('[probe] Arc 没开出 YouTube 页，沿用原来那个 target（多半会在 attach 处超时）');
    }

    console.log(`[probe] 目标页  ${String(pageTarget.url || '').slice(0, 100)}`);
    let sessionId = null;
    let attachErr = null;
    for (let attempt = 1; attempt <= 3 && !sessionId; attempt += 1) {
      try {
        const attached = await cdp.send('Target.attachToTarget', {
          targetId: pageTarget.targetId,
          flatten: true,
        });
        sessionId = attached.sessionId;
        // 不调 Page.enable：Arc 的 Page domain 会直接超时，而我们只需要 Runtime
        // （Page.navigate / bringToFront 是方法调用，不依赖 enable）
        await cdp.send('Runtime.enable', {}, sessionId);
      } catch (err) {
        // Arc 建完 tab 会立刻搬动它，头一次 attach 可能拿到已经失效的 session
        attachErr = err;
        sessionId = null;
        await sleep(1200);
      }
    }
    if (!sessionId) {
      throw new Error(`附着页面失败（试了 3 次）：${attachErr && attachErr.message}`);
    }
    console.log(`[probe] 已附着  target=${String(pageTarget.targetId).slice(0, 8)}`);

    // 跟踪存活的 execution context：navigate 会销毁旧的、建新的，
    // 直接拿第一次抓到的那个会报 "Cannot find context with specified id"。
    const liveContexts = new Map();
    cdp.on((msg) => {
      if (msg.method === 'Runtime.executionContextCreated') {
        liveContexts.set(msg.params.context.id, msg.params.context);
      } else if (msg.method === 'Runtime.executionContextDestroyed') {
        liveContexts.delete(msg.params.executionContextId);
      } else if (msg.method === 'Runtime.executionContextsCleared') {
        liveContexts.clear();
      }
    });

    const explicit = flag('url');
    let discovered = null;

    // 指定了视频就直接去：多出来的首页 / 搜索页导航既慢，又会给 YouTube 更多反爬信号
    if (!explicit) {
      rule('打开 YouTube 首页');
      await cdp.send('Page.navigate', { url: 'https://www.youtube.com/' }, sessionId);
      await waitPage(cdp, sessionId);
      await sleep(5000);

      // YouTube 新版把内容塞进了 shadow DOM，querySelectorAll 穿不过去，得递归挖
      const FIND_VIDEO = `(() => {
        const deepQuery = (selector) => {
          const out = [];
          const walk = (root) => {
            for (const el of root.querySelectorAll(selector)) out.push(el);
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
          };
          walk(document);
          return out;
        };
        const links = deepQuery('a[href*="/watch?v="]')
          .map((el) => el.getAttribute('href'))
          .filter((h) => h && /\\/watch\\?v=[\\w-]{6,}/.test(h));
        return {
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          bodyLength: document.body ? document.body.innerHTML.length : 0,
          plainAnchors: document.querySelectorAll('a').length,
          count: links.length,
          sample: links.slice(0, 3),
        };
      })()`;

      let found = await evaluate(cdp, sessionId, FIND_VIDEO);
      console.log(`[probe] ${JSON.stringify(found)}`);

      if (!found || !found.count) {
        rule('首页没拿到视频链接，改试搜索页');
        await cdp.send(
          'Page.navigate',
          { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(SEARCH)}` },
          sessionId,
        );
        await waitPage(cdp, sessionId);
        await sleep(5000);
        found = await evaluate(cdp, sessionId, FIND_VIDEO);
        console.log(`[probe] ${JSON.stringify(found)}`);
      }

      discovered = found && found.sample && found.sample[0]
        ? new URL(found.sample[0], 'https://www.youtube.com').href
        : null;
    }

    const target = explicit || discovered || FALLBACK_VIDEO;

    console.log(`[probe] 视频来源: ${explicit ? '--url' : discovered ? '自动发现' : '兜底'}`);

    if (!target) {
      console.log('[probe] 没拿到任何视频，只能停在当前页做注入检查');
    } else {
      rule(`打开视频 ${target}`);
      await cdp.send('Page.navigate', { url: target }, sessionId);
      await waitPage(cdp, sessionId);
      // 有头模式下页面可能在后台，YouTube 的懒加载就不触发，播放器一直不出来
      await cdp.send('Page.bringToFront', {}, sessionId).catch(() => {});
      await sleep(4000);

      // 尝试播放：自动播放策略已放开，但 YouTube 仍可能需要一次点击
      await evaluate(
        cdp,
        sessionId,
        `(() => {
          const v = document.querySelector('#movie_player video') || document.querySelector('video');
          if (!v) return 'no-video';
          v.muted = true;
          const p = v.play();
          return p && p.catch ? 'play-called' : 'play-called';
        })()`,
      );
      console.log(`[probe] 等待 ${WAIT_S}s，让 Linglass 去取字幕…`);
      await sleep(WAIT_S * 1000);
    }

    rule('页面 world：注入与 DOM');
    console.log(JSON.stringify(await evaluate(cdp, sessionId, DOM_PROBE), null, 1));

    rule('页面 world：官方字幕浮层');
    console.log(JSON.stringify(await evaluate(cdp, sessionId, SUBTITLE_PROBE), null, 1));

    rule('isolated world：chrome.storage 缓存');
    const contexts = [...liveContexts.values()];
    // 取「最新」的那个：navigate 之后旧页面的 context 会被销毁，数组里可能还留着历史项
    const extCtx = contexts
      .filter((c) => c.auxData && c.auxData.isDefault === false && String(c.origin).startsWith('chrome-extension://'))
      .pop();
    console.log(`[probe] 存活上下文 ${contexts.length} 个，扩展 isolated world: ${extCtx ? `命中 (${extCtx.origin})` : '未找到'}`);
    if (extCtx) {
      console.log(JSON.stringify(await evaluate(cdp, sessionId, STORAGE_PROBE, extCtx.id), null, 1));
    } else {
      console.log('[probe] 所有上下文：');
      console.log(JSON.stringify(contexts.map((c) => ({ id: c.id, origin: c.origin, name: c.name, aux: c.auxData })), null, 1));
    }

    rule('布局：打开面板后，它和视频是否重叠');
    const layoutBase = await evaluate(cdp, sessionId, LAYOUT_PROBE);
    console.log(`[probe] panelState=${layoutBase.panelState}`
      + ` panel=[${layoutBase.panel ? `${layoutBase.panel.left}..${layoutBase.panel.right}` : '-'}]`
      + ` video=[${layoutBase.video ? `${layoutBase.video.left}..${layoutBase.video.right}` : '-'}]`
      + ` overlap=${layoutBase.overlap} clearance=${layoutBase.clearance}`);
    console.log(`[probe] 我们的标记: data-llg-panel=${layoutBase.html.marker}`
      + ` --llg-panel-w="${layoutBase.html.widthVar}"`
      + ` theater=${layoutBase.layout.theater} fullscreen=${layoutBase.layout.fullscreen}`);
    printPanelVsPage('布局：面板压住了谁（现状）', layoutBase);

    // 让位规则必须在「默认 / 剧场 / 全屏」三种布局下都对，所以三态各比一次候选规则。
    // 切模式用真实的输入事件点 YouTube 自己的按钮，而不是手动改属性 —— 属性一改 CSS 会响应，
    // 但 YouTube 自己的重排逻辑不一定跟着跑，量出来的就不是真实排版。
    rule('布局：候选让位规则对比（默认视图）');
    await ensureTheater(cdp, sessionId, false);
    printLayoutCompare('默认视图', await evaluate(cdp, sessionId, layoutCompareProbe()));

    rule('布局：候选让位规则对比（剧场视图）');
    await ensureTheater(cdp, sessionId, true);
    printLayoutCompare('剧场视图', await evaluate(cdp, sessionId, layoutCompareProbe()));

    rule('布局：候选让位规则对比（全屏）');
    await hoverPlayer(cdp, sessionId);
    await clickSelector(cdp, sessionId, '.ytp-fullscreen-button');
    await sleep(3000);
    printLayoutCompare('全屏', await evaluate(cdp, sessionId, layoutCompareProbe()));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await sleep(1500);

    // ---------------------------------------------------------- 交互实测
    if (!flag('no-checks')) {
      rule('实测①：设置面板行渲染');
      const opened = await clickSelector(cdp, sessionId, '.linglass-settings-btn');
      console.log(`[probe] 点击官方设置按钮: ${opened ? 'ok' : '找不到元素'}`);
      await sleep(1500);
      console.log(JSON.stringify(await evaluate(cdp, sessionId, SETTINGS_PROBE), null, 1));

      rule('实测②：学习面板开关 + 渲染');
      const toggled = await clickSelector(cdp, sessionId, '#llg-panel-btn');
      console.log(`[probe] 点击学习面板按钮: ${toggled ? 'ok' : '找不到元素'}`);
      await sleep(1200);
      const panelBefore = await evaluate(cdp, sessionId, PANEL_PROBE);
      console.log(JSON.stringify(panelBefore, null, 1));

      rule('实测③：面板拖拽改宽（往左拖 80px）');
      const dragged = await dragShadowHandle(cdp, sessionId, 'llg-study-panel-root', '.resize', -80);
      await sleep(500);
      const panelAfter = await evaluate(cdp, sessionId, PANEL_PROBE);
      console.log(JSON.stringify({
        dragged,
        widthBefore: panelBefore && panelBefore.width,
        widthAfter: panelAfter && panelAfter.width,
        delta: panelBefore && panelAfter ? panelAfter.width - panelBefore.width : null,
      }, null, 1));

      rule('实测④：桌面字幕（系统级画中画）');
      const pipClicked = await clickSelector(cdp, sessionId, '#llg-pip-btn');
      console.log(`[probe] 点击桌面字幕按钮: ${pipClicked ? 'ok' : '找不到元素'}`);
      await sleep(2500);
      const pipState = await evaluate(cdp, sessionId, PIP_PROBE);
      console.log(JSON.stringify(pipState, null, 1));
      const pipBtn = await evaluate(cdp, sessionId, `(() => {
        const el = document.getElementById('llg-pip-btn');
        return el ? { label: el.dataset.tooltipText, on: el.classList.contains('is-on'), disabled: !!el.disabled } : null;
      })()`);
      console.log(`[probe] 按钮状态: ${JSON.stringify(pipBtn)}`);

      if (pipState && pipState.windowOpen) {
        rule('实测⑤：宿主窗口最小化后，画中画是否仍在桌面');
        const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pageTarget.targetId });
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        await sleep(3000);
        const minimized = await evaluate(cdp, sessionId, PIP_PROBE);
        console.log(`[probe] 最小化后: ${JSON.stringify(minimized)}`);
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await sleep(1500);
        const restored = await evaluate(cdp, sessionId, PIP_PROBE);
        console.log(`[probe] 恢复后:   ${JSON.stringify(restored)}`);

        // ---------------------------------------------------- 存活实测（PLAN 032）
        // ⑤ 之后窗口可能已经被收走（那正是它要测的），先确认它还开着：⑥⑦ 测的是
        // 「切走时会不会丢」，没有窗口就无物可测。
        rule('实测⑥：切到另一个标签页 / 切回来，浮窗还在不在');
        let alive = await evaluate(cdp, sessionId, PIP_ALIVE_PROBE);
        if (!alive.windowOpen) {
          console.log('[probe] 上一步之后窗口已不在，点一次控制栏按钮重开再继续');
          await sleep(1200);
          await clickSelector(cdp, sessionId, '#llg-pip-btn');
          await sleep(2000);
          alive = await evaluate(cdp, sessionId, PIP_ALIVE_PROBE);
        }

        if (alive.windowOpen) {
          await pipTabSwitch(cdp, sessionId, pageTarget);

          rule('实测⑦：切到别的应用 / 切回来，浮窗还在不在');
          await pipAppSwitch(cdp, sessionId, browser);

          rule('实测⑧：窗口丢了之后，一次真实页面点击能否重开');
          await restorePipByClick(cdp, sessionId);
        } else {
          console.log('[probe] 窗口仍然不在（按钮重开也失败），跳过 ⑥⑦⑧');
        }
      } else if (!HEADED) {
        console.log('[probe] headless 拿不到画中画窗口（没有窗口管理器），用 --headed 重跑才能验证');
      }
    }

    rule('扩展 id 校验');
    console.log(`[probe] 期望包含 ${EXT_ID_HINT}`);
  } finally {
    if (!KEEP) {
      cdp?.close();
      child.kill('SIGTERM');
      await sleep(800);
      child.kill('SIGKILL');
      // 持久化 profile 要留着（Linglass 登录态在里面），只有 --fresh 的临时目录才删
      if (fresh) await rm(profile, { recursive: true, force: true }).catch(() => {});
      console.log(`\n[probe] 已关闭浏览器（profile: ${profile}${fresh ? '，已删除' : '，已保留'}）`);
    } else {
      console.log(`\n[probe] 浏览器保留中，调试端口 ${PORT}（profile: ${profile}）`);
    }
  }
}

main().catch((err) => {
  console.error(`[probe] 失败: ${err && err.message}`);
  process.exit(1);
});
