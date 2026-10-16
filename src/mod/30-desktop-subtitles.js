/**
 * Linglass 桌面字幕
 *
 * 把 Linglass 渲染在 YouTube 播放器上的双语字幕，投送到系统级 Picture-in-Picture
 * 浮窗，并带上歌词式的句内进度条。浏览器最小化、切到别的应用之后，字幕依然留在
 * 桌面上，进度继续走。
 *
 * 按钮挂在 YouTube 控制栏里、紧贴 Linglass 自己的设置按钮（见 00-shared.js），
 * 看起来就是 Linglass 自带的功能。
 *
 * 数据来源：
 *   文案 —— 直接读 Linglass 的 Shadow DOM（实时、永远最新）
 *   进度 —— 10-subtitle-track.js 记录的句子时间轴，句内线性插值
 *
 * 进度更新的双保险：
 *   1. pipWin.requestAnimationFrame —— PiP 窗口可见时由它自己的合成器驱动，
 *      即使宿主窗口最小化也照常跑（页面侧的 rAF 会被暂停）
 *   2. 1s 心跳 —— 视频在播放时页面不会被定时器节流（媒体播放豁免），作为兜底
 */
(() => {
  'use strict';

  const shared = globalThis.__llgModShared;
  const track = globalThis.__llgModTrack;
  if (!shared || !track) {
    console.error('[llg-pip] 共享模块未加载（检查 src/mod 数字前缀与加载顺序）');
    return;
  }

  const BTN_ID = 'llg-pip-btn';
  const LABEL_IDLE = '桌面字幕';
  const LABEL_ON = '关闭桌面字幕';
  const HEARTBEAT_MS = 1000;

  const PIP_CSS = `
:root { color-scheme: dark; }
html, body { height: 100%; margin: 0; overflow: hidden; background: #0d0d0f;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased; }
#box { height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; box-sizing: border-box;
  padding: 0 34px; gap: 8px; }
.kline { position: relative; display: inline-block; max-width: 100%; }
.kfill { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
  border-radius: var(--radius-sm, 8px); }
#fill-primary { background: rgba(10, 132, 255, .30); }
#line-primary { position: relative; display: block;
  font-size: clamp(20px, 3.2vw, 44px); font-weight: 600; color: #fff;
  line-height: 1.28; text-align: center; white-space: pre-wrap;
  text-shadow: 0 2px 10px rgba(0,0,0,.85), 0 0 3px rgba(0,0,0,.9); }
#fill-secondary { background: rgba(10, 132, 255, .22); }
#line-secondary { position: relative; display: block;
  font-size: clamp(14px, 2.1vw, 29px); font-weight: 400; color: #c8c8d0;
  line-height: 1.36; text-align: center; white-space: pre-wrap;
  text-shadow: 0 2px 10px rgba(0,0,0,.85), 0 0 3px rgba(0,0,0,.9); }
#box:not(:has(#line-primary:not(:empty)))::before {
  content: "— 等待 Linglass 字幕 —";
  font-size: clamp(12px, 1.2vw, 15px); font-weight: 400;
  color: #7a7a80; letter-spacing: .04em; }
`;

  const ICON_SVG = `
<svg viewBox="0 0 24 24" class="llg-mod-icon" aria-hidden="true">
  <rect x="2.5" y="4" width="19" height="13.5" rx="2.5" fill="currentColor" fill-opacity="0.16"/>
  <path d="M6.4 10.6h11.2" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-opacity="0.88"/>
  <path d="M8.8 13.8h6.4" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-opacity="0.5"/>
</svg>`;

  let pipWin = null;
  let rafId = 0;
  let lastKey = '';

  function currentLines() {
    const lines = track.readLines();
    if (!lines) return { primary: '', secondary: '' };
    return lines;
  }

  function pushText() {
    if (!pipWin) return;

    const lines = currentLines();
    const key = `${lines.primary}\u0000${lines.secondary}`;
    if (key === lastKey) return;
    lastKey = key;

    const d = pipWin.document;
    const p = d.getElementById('line-primary');
    const s = d.getElementById('line-secondary');
    if (p) p.textContent = lines.primary;
    if (s) s.textContent = lines.secondary;
  }

  function pushProgress() {
    if (!pipWin) return;
    const percent = `${track.getProgress() * 100}%`;
    const d = pipWin.document;
    const f1 = d.getElementById('fill-primary');
    const f2 = d.getElementById('fill-secondary');
    if (f1) f1.style.width = percent;
    if (f2) f2.style.width = percent;
  }

  function push() {
    pushText();
    pushProgress();
  }

  /** 用 PiP 窗口自己的 rAF 驱动进度：宿主窗口最小化时页面侧的 rAF 会停，这个不会 */
  function startFrame() {
    if (!pipWin || rafId) return;
    const win = pipWin;

    const step = () => {
      if (!pipWin || pipWin !== win) {
        rafId = 0;
        return;
      }
      rafId = win.requestAnimationFrame(step);
      pushProgress();
    };

    try {
      rafId = win.requestAnimationFrame(step);
    } catch {
      rafId = 0; // 不支持就退化成心跳驱动
    }
  }

  function stopFrame() {
    if (!rafId || !pipWin) {
      rafId = 0;
      return;
    }
    try {
      pipWin.cancelAnimationFrame(rafId);
    } catch {
      // 窗口已经关了，忽略
    }
    rafId = 0;
  }

  function refreshButton() {
    const ok = shared.ensureButton({
      id: BTN_ID,
      icon: ICON_SVG,
      onClick: () => start(),
    });
    if (!ok) return;
    shared.setButtonState(BTN_ID, {
      label: 'documentPictureInPicture' in window
        ? (pipWin ? LABEL_ON : LABEL_IDLE)
        : '当前浏览器不支持桌面字幕',
      on: !!pipWin,
      disabled: !('documentPictureInPicture' in window),
    });
  }

  async function start() {
    if (!('documentPictureInPicture' in window)) {
      console.warn('[桌面字幕] 需要 Chrome / Edge 116+（documentPictureInPicture）');
      refreshButton();
      return;
    }
    if (pipWin) {
      pipWin.close();
      return;
    }

    try {
      pipWin = await documentPictureInPicture.requestWindow({
        width: 1000,
        height: 220,
        disallowReturnToOpener: true,
      });
    } catch (err) {
      // 没有用户手势、或窗口已被系统拒绝时会走到这里
      console.warn(`[桌面字幕] 无法打开画中画窗口：${err && err.message}`);
      pipWin = null;
      refreshButton();
      return;
    }

    const d = pipWin.document;
    d.documentElement.style.colorScheme = 'dark';

    const style = d.createElement('style');
    style.textContent = PIP_CSS;
    d.head.append(style);

    const box = d.createElement('div');
    box.id = 'box';
    for (const [lineId, fillId] of [
      ['line-primary', 'fill-primary'],
      ['line-secondary', 'fill-secondary'],
    ]) {
      const wrap = d.createElement('div');
      wrap.className = 'kline';

      const fill = d.createElement('i');
      fill.className = 'kfill';
      fill.id = fillId;

      const text = d.createElement('span');
      text.id = lineId;

      wrap.append(fill, text);
      box.append(wrap);
    }
    d.body.append(box);

    pipWin.addEventListener('pagehide', stop);

    lastKey = '';
    refreshButton();
    push();
    startFrame();
  }

  function stop() {
    stopFrame();
    pipWin = null;
    lastKey = '';
    refreshButton();
  }

  function heartbeat() {
    refreshButton();
    if (!pipWin) return;
    // 双保险：rAF 万一没跑起来（窗口被系统挂起等），这里仍按秒推进
    pushText();
    pushProgress();
  }

  track.subscribe(() => {
    if (pipWin) pushText();
  });

  // 登记到设置面板（线框图标，与 Linglass 面板内的 .toggle-icon 同一套语言）
  shared.registerFeature({
    id: 'desktopSubtitles',
    title: '桌面字幕浮窗',
    icon: `
<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="5" width="18" height="14" rx="2"/>
  <rect x="12.5" y="11.5" width="6.5" height="5" rx="1"/>
  <path d="M6.5 10h4.5"/>
</svg>`,
    isOn: () => !!pipWin,
    toggle: () => {
      start();
    },
  });

  refreshButton();

  // 扩展重载后，上一轮打开的画中画窗会变成孤儿窗口：页面还在，但它的 pagehide 监听
  // 和整个内容脚本上下文都没了，关不掉也更新不了。documentPictureInPicture.window
  // 能拿到当前文档的画中画窗（页面本身重载时它会被浏览器自动关掉，所以走到这里
  // 非空就说明是扩展重载留下的），直接关掉重来。
  if ('documentPictureInPicture' in window && documentPictureInPicture.window) {
    try {
      documentPictureInPicture.window.close();
    } catch {
      // 已经被关了
    }
    console.info('[桌面字幕] 清理了扩展重载遗留的画中画窗口');
  }

  setInterval(heartbeat, HEARTBEAT_MS);
})();
