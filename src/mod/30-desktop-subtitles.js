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
 *   原文行的文节分隔符 —— 复用 15-ja-break.js 的开关与 05-ja-segment.js 的切分结果
 *
 * ── 常驻语义（本文件最容易被改坏的部分，先读这段）──
 *
 * 期望：默认开启、切回浏览器之后依然在、只有显式关闭才关。
 *
 * 但「关」这件事不归我们管：规范允许 UA 自行关闭 PiP 窗口
 * （Document PiP §5 步骤 9 / §6.4），opener 文档被销毁或导航时更是强制关闭
 * （§6.6 / §6.7）—— 刷新页面、真导航换视频、扩展重载都落在这一档。
 * 而 §6.10 那句 "Giving system focus to the opener does not necessarily need to close
 * the document picture-in-picture window" 里的 "not necessarily" 就是留给实现的裁量权。
 *
 * 所以我们不去阻止关闭（阻止不了），而是把「被关掉」从终态改成中间态：
 *
 *   enabled（落盘，默认 true）= 用户希望它开着
 *   pagehide 时判「谁关的」：
 *     · 我们自己的 close()  → 显式
 *     · 页面 hidden，或刚从 hidden 回到 visible（RECENT_VISIBLE_MS 内）→ 判定为
 *       「切回浏览器时被 UA 关掉」→ 立刻重开
 *     · 其余（用户在 PiP 窗口上点了 X）→ 显式
 *
 * 「立刻重开」不一定成功：requestWindow() 必须在瞬时用户激活内调用。
 * 所以恢复是两段的 —— 先试一次，失败就 arm() 一个一次性手势监听，
 * 用户下一次点击/按键时打开（默认开启就是靠这条路径生效的）。
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
  const LABEL_UNSUPPORTED = '当前浏览器不支持桌面字幕';
  const HEARTBEAT_MS = 1000;

  const PIP_WIDTH = 1000;
  const PIP_HEIGHT = 220;

  /** 常驻开关的落盘键。默认 true —— 用户没表过态时就是要开着 */
  const STORE_KEY = 'llgPip';

  /**
   * 「刚从后台切回来」的判定窗口。
   * UA 关闭 PiP 的时机就是我们切回浏览器那一刻，给 4s 余量足够覆盖系统调度抖动；
   * 再长的窗口会把「用户盯着 PiP 点它的 X」误判成切回（那时页面是 visible 且
   * lastVisibleAt 早已过期）。
   */
  const RECENT_VISIBLE_MS = 4000;

  /** 触发「下一次手势就开」的事件。pointerdown 覆盖鼠标/触摸，keydown 覆盖键盘用户 */
  const GESTURE_EVENTS = ['pointerdown', 'keydown'];

  /** 与 15-ja-break.js 的 ::after 观感对齐（那边是 margin: 0 .14em） */
  const THIN_SPACE = '\u2009';

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
  /** 常驻开关（落盘）。true = 希望它开着 */
  let enabled = true;
  /** 待开的一次性手势监听器（armed 非空即已挂上） */
  let armed = null;
  /** 防止 pointerdown 的预开与随后的 click 各开一次 */
  let opening = false;
  /** 包住我们主动调用的 close()，用来把「我们关的」和「别人关的」分开 */
  let closingByUs = false;
  /**
   * 上一次「从后台切回来」的时刻（0 = 本次加载后还没切出去过）。
   *
   * 只在真正发生 hidden → visible 的跃迁时刷新，而不是把「visible」当条件 ——
   * 否则刚打开页面的那几秒里，用户点 PiP 的 X 会被误判成「切回浏览器导致的关闭」，
   * 于是窗口被强行弹回来。
   */
  let lastVisibleAt = 0;
  /** 页面当前是不是处于后台（用来识别 hidden → visible 的跃迁） */
  let pageHidden = document.visibilityState === 'hidden';

  function supported() {
    return 'documentPictureInPicture' in window;
  }

  function warn(msg) {
    console.warn(`[桌面字幕] ${msg}`);
  }

  // ---------------------------------------------------------------- 文案渲染

  function currentLines() {
    const lines = track.readLines();
    if (!lines) return { primary: '', secondary: '' };
    return lines;
  }

  /**
   * 原文行按日语「文节」插入分隔符。
   *
   * 这里改的是**浮窗自己的纯文本**，与 15-ja-break.js「不许碰官方字幕行文本流」那条约束
   * 无关 —— 那条约束保护的是官方点词/拖拽选词的字符偏移，浮窗里没有这回事。
   *
   * 尊重视频内断句的开关：关着、或 15-ja-break.js 没加载（扩展被裁剪过）时原样返回。
   */
  function displayPrimary(text) {
    const jaBreak = globalThis.__llgModJaBreak;
    const segment = globalThis.__llgModJaSegment;
    if (!text || !jaBreak || typeof jaBreak.isEnabled !== 'function' || !jaBreak.isEnabled()) {
      return text;
    }
    if (!segment || typeof segment.cut !== 'function') return text;

    const points = segment.cut(text);
    if (!points || !points.length) return text;

    // cut() 的切点严格升序、且最后一点落在文本末尾，所以这样切不会丢尾巴
    const separator = `${THIN_SPACE}${jaBreak.SEPARATOR || '|'}${THIN_SPACE}`;
    const parts = [];
    let prev = 0;
    for (const point of points) {
      if (point > prev) parts.push(text.slice(prev, point));
      prev = point;
    }
    if (prev < text.length) parts.push(text.slice(prev));
    return parts.join(separator);
  }

  function pushText() {
    if (!pipWin) return;

    const lines = currentLines();
    const primary = displayPrimary(lines.primary);
    // 分隔符开关的状态进键：用户中途切换断句时浮窗要重绘
    const key = `${primary}\u0000${lines.secondary}`;
    if (key === lastKey) return;
    lastKey = key;

    const d = pipWin.document;
    const p = d.getElementById('line-primary');
    const s = d.getElementById('line-secondary');
    if (p) p.textContent = primary;
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

  // ---------------------------------------------------------------- 常驻开关

  function save() {
    try {
      chrome.storage.local.set({ [STORE_KEY]: { enabled } }).catch(() => {});
    } catch {
      // storage 不可用：内存里的状态仍然有效
    }
  }

  /** 现在这个时机自动开窗有没有意义（watch 页 + 有视频） */
  function canAutoOpen() {
    if (!supported() || !enabled || pipWin) return false;
    if (location.pathname !== '/watch') return false;
    return !!document.querySelector('#movie_player video');
  }

  function disarm() {
    if (!armed) return;
    for (const type of GESTURE_EVENTS) document.removeEventListener(type, armed, true);
    armed = null;
  }

  /**
   * 武装「下一次用户手势就开」。
   * requestWindow() 必须在瞬时用户激活内调用，所以在没有手势的时机（心跳里发现窗口没了、
   * 页面刚加载）只能这样等 —— 「默认开启」正是靠这条路径生效。
   */
  function arm() {
    if (armed || !enabled || pipWin || !supported()) return;
    armed = () => {
      disarm();
      if (canAutoOpen()) open();
    };
    for (const type of GESTURE_EVENTS) document.addEventListener(type, armed, true);
  }

  async function open() {
    if (!supported() || pipWin || opening) return false;

    disarm();
    enabled = true;
    closingByUs = false;
    opening = true;
    try {
      pipWin = await documentPictureInPicture.requestWindow({
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
        disallowReturnToOpener: true,
      });
    } catch (err) {
      // 没有用户手势、或窗口已被系统拒绝时会走到这里
      warn(`无法打开画中画窗口：${err && err.message}`);
      pipWin = null;
      opening = false;
      arm(); // 等下一次手势再来
      refreshButton();
      return false;
    }
    opening = false;

    buildWindow(pipWin);
    save();
    refreshButton();
    push();
    startFrame();
    return true;
  }

  /** 显式关闭：用户点了我们的按钮 / 设置面板的开关 */
  function close() {
    disarm();
    enabled = false;
    save();

    if (pipWin) {
      closingByUs = true;
      try {
        pipWin.close();
      } catch {
        // 已经被关了
      }
    }
    stop();
  }

  function stop() {
    stopFrame();
    pipWin = null;
    lastKey = '';
    refreshButton();
  }

  function buildWindow(win) {
    const d = win.document;
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

    win.addEventListener('pagehide', () => handlePageHide(win));
  }

  /**
   * 页面处于 hidden，或刚从 hidden 回到 visible —— 这两种时机下的关闭都算「不是用户点的」。
   * 反过来，用户盯着 PiP 窗口点它的 X 时，页面一直 visible 且 lastVisibleAt 早已过期。
   */
  function isInvoluntaryClose() {
    if (document.visibilityState === 'hidden') return true;
    return Date.now() - lastVisibleAt <= RECENT_VISIBLE_MS;
  }

  /**
   * PiP 窗口关闭（无论是谁关的都会走到这里）。
   * 关键点：**被 UA 关掉不是终态** —— 只要 enabled 还是 true，就立刻想办法把它弄回来。
   */
  function handlePageHide(win) {
    // 我们主动关闭时 stop() 可能已经先跑（close() 是同步返回的），pagehide 反而晚到；
    // 这时用 closingByUs 兜住，其余「不属于当前窗口」的过期 pagehide 直接忽略
    if (win !== pipWin && !closingByUs) return;

    const byUs = closingByUs;
    closingByUs = false;
    const involuntary = !byUs && isInvoluntaryClose();

    stop();

    if (!enabled) return;

    if (involuntary) {
      // 立刻试一次：切回浏览器那一刻我们通常还在用户手势的激活期内；
      // 失败时 open() 内部会 arm()，等下一次手势
      open();
      return;
    }

    // 用户自己关的（PiP 窗口上的 X / 系统关的）：按显式处理，不再自动弹回来
    enabled = false;
    save();
    refreshButton();
  }

  // ---------------------------------------------------------------- 按钮

  function refreshButton() {
    const ok = shared.ensureButton({
      id: BTN_ID,
      icon: ICON_SVG,
      onClick: () => {
        if (pipWin) close();
        else open();
      },
    });
    if (!ok) return;
    shared.setButtonState(BTN_ID, {
      label: supported() ? (pipWin ? LABEL_ON : LABEL_IDLE) : LABEL_UNSUPPORTED,
      on: !!pipWin,
      disabled: !supported(),
    });
  }

  function heartbeat() {
    refreshButton();
    if (!pipWin) {
      // 没有任何窗口在等 pagehide 了，这个标记不该跨窗口残留
      closingByUs = false;
      // 窗口不在但开关还开着（刚加载完 / 被关过）→ 保证有人等着把手势接住
      arm();
      return;
    }
    // 双保险：rAF 万一没跑起来（窗口被系统挂起等），这里仍按秒推进
    pushText();
    pushProgress();
  }

  // ---------------------------------------------------------------- 启动

  // 纯函数 + 状态测试钩子（与 15-ja-break.js / 40-study-panel.js 的既有做法一致）
  Object.defineProperty(globalThis, '__llgModPip', {
    value: {
      open,
      close,
      setEnabled: (next) => (next ? open() : close()),
      isEnabled: () => enabled,
      isOpen: () => !!pipWin,
      displayPrimary,
      RECENT_VISIBLE_MS,
    },
    configurable: true,
  });

  track.subscribe(() => {
    if (pipWin) pushText();
  });

  document.addEventListener('visibilitychange', () => {
    const state = document.visibilityState;
    if (state === 'hidden') {
      pageHidden = true;
      return;
    }
    if (state !== 'visible') return;

    if (pageHidden) lastVisibleAt = Date.now(); // 只有真的从后台回来才算
    pageHidden = false;
    refreshButton();
    // 回到前台时窗口已经不在了（被 UA 关掉且 pagehide 发生在 hidden 期间）→ 重新等手势
    if (!pipWin) arm();
  });

  // 登记到设置面板（线框图标，与 Linglass 面板内的 .toggle-icon 同一套语言）
  shared.registerFeature({
    id: 'desktopSubtitles',
    title: '桌面字幕浮窗',
    desc: '默认开启；切回浏览器后自动恢复，关掉之后不再自动打开',
    icon: `
<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="5" width="18" height="14" rx="2"/>
  <rect x="12.5" y="11.5" width="6.5" height="5" rx="1"/>
  <path d="M6.5 10h4.5"/>
</svg>`,
    isOn: () => enabled,
    toggle: () => {
      if (enabled) close();
      else open();
    },
  });

  refreshButton();

  chrome.storage.local
    .get(STORE_KEY)
    .then((res) => {
      const saved = res && res[STORE_KEY];
      if (saved && typeof saved.enabled === 'boolean') enabled = saved.enabled;
    })
    .catch(() => {})
    .finally(() => {
      // 扩展重载后，上一轮打开的画中画窗会变成孤儿窗口：页面还在，但它的 pagehide 监听
      // 和整个内容脚本上下文都没了，关不掉也更新不了。documentPictureInPicture.window
      // 能拿到当前文档的画中画窗（页面本身重载时它会被浏览器自动关掉，所以走到这里
      // 非空就说明是扩展重载留下的），直接关掉重来 —— 关掉之后照常 arm()，
      // 用户下一次手势它就回来了，不会像以前那样彻底消失。
      cleanupOrphan();
      refreshButton();
      if (enabled) arm();
    });

  function cleanupOrphan() {
    if (!supported()) return;
    const orphan = documentPictureInPicture.window;
    if (!orphan) return;
    try {
      orphan.close();
    } catch {
      // 已经被关了
    }
    console.info('[桌面字幕] 清理了扩展重载遗留的画中画窗口');
  }

  setInterval(heartbeat, HEARTBEAT_MS);
})();
