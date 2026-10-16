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
import { spawn } from 'node:child_process';
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

/** 找一个能加载扩展的 Chrome：优先 Chrome for Testing，其次系统 Chrome */
function pickBrowser() {
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
      }, 30000);
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

async function connect() {
  const deadline = Date.now() + 20000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const info = await res.json();
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
        setTimeout(() => reject(new Error('WebSocket 连接超时')), 10000);
      });
      return new Cdp(ws);
    } catch (err) {
      lastErr = err;
      await sleep(400);
    }
  }
  throw new Error(`连不上调试端口 ${PORT}：${lastErr && lastErr.message}`);
}

/** 在某个页面里求值；不传 contextId 就是页面 world */
async function evaluate(cdp, sessionId, expression, contextId) {
  const params = {
    expression: `(() => { try { return JSON.stringify(${expression}); } catch (e) { return JSON.stringify({ __error: String(e && e.message || e) }); } })()`,
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
    const { targetInfos } = await cdp.send('Target.getTargets');
    const pageTarget = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
    if (!pageTarget) throw new Error('找不到页面 target');

    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

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
