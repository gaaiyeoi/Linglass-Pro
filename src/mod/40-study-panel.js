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
  const HEARTBEAT_MS = 1000;
  const WIDTH_MIN = 300;
  const WIDTH_MAX = 760;

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
  font: 400 13px/1.5 system-ui, -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
  direction: ltr;
  transform: translateX(100%);
  pointer-events: none;
  transition: transform var(--llg-duration-normal) var(--llg-ease-out);
}
.panel[data-state="open"] { transform: translateX(0); pointer-events: auto; }

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
  padding: 12px 12px 10px 16px;
  border-bottom: 1px solid var(--llg-divider);
}
.head-text { flex: 1; min-width: 0; }
.title { font-size: 13px; font-weight: 600; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sub { margin-top: 2px; font-size: 11px; color: var(--llg-text-secondary);
  font-variant-numeric: tabular-nums; }
.icon {
  flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
  border: none; border-radius: 6px; background: transparent;
  color: var(--llg-text-secondary); font: inherit; font-size: 17px; line-height: 1;
  cursor: pointer;
}
.icon:hover { background: var(--llg-row-hover); color: var(--llg-text-primary); }

.stage { padding: 12px 16px 14px; border-bottom: 1px solid var(--llg-divider); min-height: 96px; }
.kline { position: relative; overflow: hidden; border-radius: var(--llg-radius-sm);
  padding: 6px 10px; margin-bottom: 6px; }
.kline:last-child { margin-bottom: 0; }
.kline-ja { font-size: 16px; font-weight: 600; line-height: 1.45; }
.kline-zh { font-size: 13px; color: var(--llg-text-quaternary); }
.kfill { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
  background: var(--llg-accent-light); border-radius: var(--llg-radius-sm); }
.ktext { position: relative; display: block; word-break: break-word; }
.stage-empty { color: var(--llg-text-tertiary); font-size: 12px; }

.list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  margin: 0; padding: 6px 0; list-style: none; scrollbar-width: thin; }
.list:empty::after {
  content: "打开 Linglass 字幕后会自动记录每一句";
  display: block; padding: 28px 16px; text-align: center;
  color: var(--llg-text-tertiary); font-size: 12px;
}
.row { display: grid; grid-template-columns: 44px 1fr; gap: 8px;
  padding: 6px 14px 6px 12px; cursor: pointer;
  border-left: 2px solid transparent; }
.row:hover { background: var(--llg-row-hover); }
.row.is-active { background: var(--llg-accent-light); border-left-color: var(--llg-accent); }
.stamp { color: var(--llg-text-tertiary); font-size: 11px;
  font-variant-numeric: tabular-nums; padding-top: 2px; }
.ja { display: block; font-size: 13.5px; line-height: 1.5; word-break: break-word; }
.zh { display: block; margin-top: 1px; color: var(--llg-text-secondary);
  font-size: 12.5px; line-height: 1.5; word-break: break-word; }

.foot { display: flex; gap: 6px; padding: 10px 12px;
  border-top: 1px solid var(--llg-divider); }
.foot button { flex: 1; padding: 7px 8px; border-radius: var(--llg-radius-sm);
  border: 1px solid var(--llg-border-default); background: var(--llg-button-secondary);
  color: var(--llg-text-primary); font: inherit; font-size: 12px; cursor: pointer;
  transition: background var(--llg-duration-fast) var(--llg-ease-out); }
.foot button:hover { background: var(--llg-button-secondary-hover); }
.foot button.ghost { flex: 0 0 auto; color: var(--llg-text-secondary); }

.toast {
  position: absolute; left: 50%; bottom: 62px;
  transform: translateX(-50%) translateY(6px);
  max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 6px 12px; border-radius: 999px;
  background: var(--llg-accent); color: #fff; font-size: 12px;
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
    --llg-text-primary: #1D1D1F;
    --llg-text-secondary: #636366;
    --llg-text-tertiary: #636366;
    --llg-text-quaternary: #48484A;
  }
}
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
  <ol class="list" data-role="list"></ol>
  <footer class="foot">
    <button type="button" data-act="md">导出 Markdown</button>
    <button type="button" data-act="srt">SRT</button>
    <button type="button" data-act="copy">复制</button>
    <button type="button" class="ghost" data-act="clear">清空</button>
  </footer>
  <div class="toast" data-role="toast"></div>
</div>`;

  const els = {};
  const state = { open: false, width: 400 };
  let built = false;
  let rendered = [];
  let activeIndex = -1;
  let follow = true;
  let rafId = 0;
  let toastTimer = 0;

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

    for (const role of ['panel', 'resize', 'title', 'sub', 'fill', 'fill2', 'ja', 'zh', 'list', 'toast']) {
      els[role] = shadow.querySelector(`[data-role="${role}"]`);
    }

    els.panel.style.width = `${state.width}px`;
    els.list.addEventListener('wheel', () => {
      follow = false;
    }, { passive: true });

    shadow.addEventListener('click', (ev) => {
      const btn = ev.target instanceof Element ? ev.target.closest('[data-act]') : null;
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'close') setOpen(false);
      else if (act === 'clear') onClear();
      else if (act) onExport(act);
    });

    setupResize();

    document.body.append(host);
    built = true;
  }

  function setupResize() {
    let startX = 0;
    let startWidth = 0;

    const onMove = (ev) => {
      state.width = clamp(startWidth + (startX - ev.clientX), WIDTH_MIN, WIDTH_MAX);
      els.panel.style.width = `${state.width}px`;
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      chrome.storage.local.set({ [STORE_KEY]: { width: state.width } }).catch(() => {});
    };

    els.resize.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      startX = ev.clientX;
      startWidth = state.width;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // ---------------------------------------------------------------- 开关

  function setOpen(open) {
    if (open) buildPanel();

    state.open = open;
    if (built) {
      els.panel.dataset.state = open ? 'open' : 'closed';
      if (open) renderAll();
    }

    if (open) startFrame();
    else stopFrame();

    refreshButton();
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
      follow = true;
    });
    return li;
  }

  function renderAll() {
    const cues = track.getCues();
    els.list.textContent = '';
    const frag = document.createDocumentFragment();
    for (const cue of cues) frag.append(makeRow(cue));
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
      const frag = document.createDocumentFragment();
      for (const cue of cues) frag.append(makeRow(cue));
      els.list.append(frag);
      els.list.scrollTop = scrollTop;
    } else {
      const frag = document.createDocumentFragment();
      for (let i = rendered.length; i < cues.length; i += 1) frag.append(makeRow(cues[i]));
      els.list.append(frag);
    }

    rendered = cues.slice();
    activeIndex = -1;
    updateMeta();
  }

  function updateMeta() {
    const meta = track.getMeta();
    const count = track.getCues().length;
    els.title.textContent = meta?.title || '学习面板';

    const parts = [];
    if (meta?.duration) parts.push(fmtClock(meta.duration));
    parts.push(`${count} 句`);
    if (meta?.channel) parts.push(meta.channel);
    els.sub.textContent = parts.join(' · ');
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
    const percent = `${track.getProgress() * 100}%`;
    els.fill.style.width = percent;
    els.fill2.style.width = percent;

    const ja = cur ? cur.primary : '';
    const zh = cur ? cur.secondary : '';
    if (els.ja.textContent !== ja) els.ja.textContent = ja;
    if (els.zh.textContent !== zh) els.zh.textContent = zh;

    highlight(cur ? cur.index : -1);
  }

  function highlight(index) {
    if (index === activeIndex) return;

    const prev = els.list.querySelector('.row.is-active');
    if (prev) prev.classList.remove('is-active');

    activeIndex = index;
    if (index < 0) return;

    const row = els.list.children[index];
    if (!row) return;
    row.classList.add('is-active');
    if (follow) row.scrollIntoView({ block: 'nearest' });
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

  function toSrt(snap) {
    return snap.cues
      .map((cue, i) => {
        const start = Math.max(0, cue.start || 0);
        const end = Math.max(start + 0.5, cue.end || start + 3);
        const text = [cue.primary, cue.secondary].filter(Boolean).join('\n');
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
    if (kind === 'copy') {
      navigator.clipboard
        .writeText(toMarkdown(snap))
        .then(() => toast('Markdown 已复制，直接粘进 Obsidian'))
        .catch(() => toast('复制失败，改用「导出 Markdown」'));
    }
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
        if (built) els.panel.style.width = `${state.width}px`;
      }
    })
    .catch(() => {});

  track.subscribe(() => {
    if (state.open && built) syncList();
  });

  document.addEventListener('yt-navigate-finish', () => {
    rendered = [];
    activeIndex = -1;
    if (state.open && built) renderAll();
  });

  // 视频被换掉时重新挂按钮（YouTube 是 SPA，控制栏会被重建）
  refreshButton();
  setInterval(refreshButton, HEARTBEAT_MS);
})();
