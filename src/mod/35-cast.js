/**
 * 手机字幕屏 —— 发送端（PLAN 038）
 *
 *   __llgModTrack / __llgModPip.castLines()  ──构建快照──▶
 *     POST http://127.0.0.1:8899/push?room=demo  ──▶ tools/cast-server.mjs ──SSE──▶ 手机
 *
 * 为什么从**内容脚本**直接发，而不是绕 service worker：
 *   · 目标地址是 127.0.0.1，属「潜在可信来源」，https 页面允许连（不会算混合内容）；
 *   · 请求体用 text/plain + 普通 CORS（服务端只回显白名单里的 Origin），
 *     是「简单请求」，不触发预检；
 *   · 少一层消息转发，也就没有 MV3 service worker 被回收的问题。
 * 实现顺序是**直连优先、失败退回 SW**（见 send()）：SW 那条路要求扩展拿到
 * 127.0.0.1 的 host 权限，而 build 已把它改成 optional —— 所以它只能当兜底，
 * 不能当默认路径（否则 4 次/秒的 sendMessage 会持续唤醒 SW）。
 *
 * 内容与浮窗**同源**：正文用的切词 / 注音 / 上下文全部来自 __llgModPip.castLines()，
 * 样式（预设 / 档位 / 颜色 / 双语 / 语言）来自官方设置，所以手机上看到的就是同一套东西。
 */
(() => {
  'use strict';

  const NS = '__llgModCast';
  if (globalThis[NS]) return;

  const shared = globalThis.__llgModShared;
  const track = globalThis.__llgModTrack;

  /** 控制栏按钮：与桌面字幕浮窗并排（先插在它后面） */
  const BTN_ID = 'llg-cast-btn';
  const LABEL_IDLE = '手机字幕屏';
  const LABEL_ON = '关闭手机字幕屏';
  const ICON_SVG = `
<svg viewBox="0 0 24 24" class="llg-mod-icon" aria-hidden="true">
  <rect x="6.5" y="2.5" width="11" height="19" rx="2.6"
    fill="none" stroke="currentColor" stroke-width="1.7"/>
  <path d="M9.2 15.2h5.6M9.2 17.8h3.6" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-opacity="0.85"/>
  <path d="M3 9.2h2.2M3 12.6h2.2M18.8 9.2H21M18.8 12.6H21" stroke="currentColor"
    stroke-width="1.4" stroke-linecap="round" stroke-opacity="0.45"/>
</svg>`;

  /** 落盘键：与浮窗的 llgPipAppearance 分开，两件事互不影响 */
  const STORE_KEY = 'llgCast';
  /** 推送节拍：rAF 里按时间门限发，约 4 次/秒；暂停且内容没变时不会发 */
  const PUSH_INTERVAL_MS = 250;
  /**
   * 内容没变时的最慢重发间隔（1 秒）。
   *
   * 手机发来的命令是搭 `/push` 的**响应**回来的：暂停时内容不变，若一直去重不发，
   * 手机上点「播放」就永远送不到 —— 所以这里保留一拍最多 1s 的空推送当反向通道。
   */
  const CONTROL_POLL_MS = 1000;
  /** 失败退避上限，避免 cast server 没起时每秒刷一次失败日志 */
  const RETRY_MAX_MS = 8000;
  /** 与 build.mjs 的 CAST_ORIGIN 同一份：SW 中继需要这条 host 权限 */
  const CAST_ORIGIN = 'http://127.0.0.1/*';

  const DEFAULT_STATE = {
    enabled: false,
    // 与 tools/cast-server.mjs 的默认端口对应；换端口时改这里（或 __llgModCast.setConfig）
    endpoint: 'http://127.0.0.1:8899',
    room: 'demo',
  };

  let state = { ...DEFAULT_STATE };
  // 帧序号由服务端统一分配（它才是广播顺序的依据），扩展侧不再自带 seq
  let sent = 0;
  let failures = 0;
  /**
   * 静态块（PLAN 071）：`cur/prev/next/cues/plan/style` 这些低频内容单独成块，
   * 只在变化时随帧发一次，稳态每帧只剩播放头。
   */
  let staticBlock = null;
  /** 静态块的版本（FNV-1a 32 位十六进制）；手机端按它认缓存 */
  let staticVer = '';
  /** 静态块是按哪个廉价指纹建的：指纹没变就不重建、不序列化 */
  let staticKey = '';
  /** 上一次成功发出去的静态版本（失败不前进，否则手机会永远缺这块） */
  let sentStaticVer = '';
  /** 上一帧的廉价指纹（见 frameKey）：用来在 snapshot() 之前挡掉没变化的帧 */
  let lastFrameKey = '';
  let nextTryAt = 0;
  let inflight = false;
  /**
   * 已经执行过的最后一条手机命令。命令被 /push 的响应重复带回是常态
   * （服务端要等下一次 ack 才清理），所以必须按 cid 去重，否则「切换暂停」会执行两次。
   */
  let lastCid = 0;
  let rafId = 0;
  let lastPushAt = 0;
  let lastAttemptAt = 0;
  let lastError = '';
  let videoEl = null;
  /** 设置面板上「测试手机字幕屏连接」那一行的回显 */
  let probeLabel = '未测试';

  function warn(message) {
    console.warn(`[手机字幕屏] ${message}`);
  }

  function saveState() {
    try {
      chrome.storage.local.set({ [STORE_KEY]: state }).catch(() => {});
    } catch {
      // storage 不可用（被裁剪的包）：本次会话内仍然生效
    }
  }

  // ---------------------------------------------------------------- 控制栏按钮

  /**
   * 与「桌面字幕浮窗」并排的一枚按钮：开关同一份状态（设置面板里的行也是它）。
   * 控制栏被 YouTube 重建后会消失，所以心跳里要反复 ensure。
   */
  function refreshButton() {
    if (!shared || typeof shared.ensureButton !== 'function') return;
    const ok = shared.ensureButton({
      id: BTN_ID,
      icon: ICON_SVG,
      afterId: 'llg-pip-btn',
      onClick: () => toggle(),
    });
    if (!ok) return;
    shared.setButtonState(BTN_ID, {
      label: state.enabled ? LABEL_ON : LABEL_IDLE,
      on: state.enabled,
    });
  }

  // ---------------------------------------------------------------- 快照

  /** 宿主页面的 video（与 10-subtitle-track.js 用同一套选择器；换视频后元素会变） */
  function video() {
    if (!videoEl || videoEl.isConnected === false) {
      videoEl = document.querySelector('video.html5-main-video') || document.querySelector('video');
    }
    return videoEl;
  }

  /** 快照里带多少「当前句之前」的句子：手机选句浮层能往前翻这么远（PLAN 045） */
  const CUE_WINDOW = 40;

  /**
   * 当前句及之前若干句，折成 `[[start, primary], …]`。
   *
   * 只带「过去」不带「未来」：手机上的滑动手势是「回到刚才没听清的那句」，
   * 往前翻 40 句（通常 3–5 分钟）够用，而多带未来句只会让每帧 JSON 变大。
   */
  function cueWindow(current) {
    const list = typeof track.getCues === 'function' ? track.getCues() : null;
    const index = current && Number.isInteger(current.index) ? current.index : -1;
    if (!list || index < 0) return [];

    const from = Math.max(0, index - CUE_WINDOW);
    const window = [];
    for (let i = from; i <= index; i += 1) {
      const cue = list[i];
      if (!cue) continue;
      window.push([Number(cue.start) || 0, cue.primary || '']);
    }
    return window;
  }

  /**
   * 快照里带几件「未来」的句子（PLAN 069）。
   *
   * 手机端要把换句排到自己的时钟上，就必须在**下一句开始之前**知道它几时开始。
   * 骨架（官方整条原文轨）已经把整条时间轴铺好了，所以这里几乎零成本。
   * 只带两句：一句给排程，一句给「排程被跳过时还有下一步可排」的余量，
   * 再多只是让 250ms 一帧的 JSON 变大。
   */
  const PLAN_AHEAD = 2;

  /**
   * 当前句及其后若干句的时间表：`[{ start, end, primary, secondary }, …]`。
   *
   * 与 `cueWindow()`（只往后看历史）方向相反：这里只给**当前句与未来**。
   * 手机端拿 `[0]` 认当前句、`[1]` 当排程目标；取不到轨道时返回空数组，
   * 手机端据此退回「实到帧驱动」（旧扩展同款行为）。
   *
   * `secondary` 照原样带：译文是播放后才采到的，常常为空，
   * 手机端会按 PLAN 066 的规则先出原文、译文到达后补写，不重启动画。
   */
  function upcomingCues(current) {
    const list = typeof track.getCues === 'function' ? track.getCues() : null;
    const index = current && Number.isInteger(current.index) ? current.index : -1;
    if (!list || index < 0) return [];

    const out = [];
    const last = Math.min(list.length - 1, index + PLAN_AHEAD);
    for (let i = index; i <= last; i += 1) {
      const cue = list[i];
      const start = Number(cue && cue.start);
      if (!Number.isFinite(start)) continue;
      const end = Number(cue && cue.end);
      out.push({
        start,
        // end 可能还没定稿（活跃句的 end 会被采样一路推着走）：交给手机端自己补
        end: Number.isFinite(end) && end > start ? end : null,
        primary: (cue && cue.primary) || '',
        secondary: (cue && cue.secondary) || '',
        // 官方骨架给的时间可信；采样句有 ±100ms 误差，手机端据此决定要不要提前起跑（PLAN 073）
        official: typeof track.isOfficialAt === 'function' ? track.isOfficialAt(start) : false,
      });
    }
    return out;
  }

  /**
   * 快照里的句内进度：**不可信时是 `null`**（时间轴与画面句还没对齐）。
   *
   * 不能退回 0：手机端拿它当句内时钟的基准，0 意味着「这句从头开始」，
   * 而这里 0 的真实含义是「不知道」—— 见 PLAN 062。旧版 track 没有这个入口时
   * 退回 `getProgress()`，保证扩展与内容脚本不同版本时整帧字段不缺失。
   */
  function progressOf() {
    if (!track) return null;
    if (typeof track.getProgressOrNull === 'function') return track.getProgressOrNull();
    return typeof track.getProgress === 'function' ? track.getProgress() : null;
  }

  /**
   * 构建一帧快照。字段与 tools/cast-page.mjs 的渲染一一对应：
   *   cue/progress  整句进度；cur.segments 二维数组（段 → token，token 可能带 ruby）
   *   prev/next     上下文原文；style 官方外观 + 浮窗自己的 ctxLines
   *
   * 返回 null 表示「现在没有可推的东西」（轨道没就绪 / 浮窗模块缺失）。
   */
  function snapshot() {
    const pip = globalThis.__llgModPip;
    if (!track || !pip || typeof pip.castLines !== 'function') return null;

    let lines;
    try {
      lines = pip.castLines();
    } catch {
      return null;
    }
    if (!lines) return null;

    const current = typeof track.getCurrent === 'function' ? track.getCurrent() : null;
    const official = typeof pip.official === 'function' ? pip.official() : {};
    const own = typeof pip.pipOption === 'function' ? pip.pipOption() : {};
    const jaBreak = globalThis.__llgModJaBreak;
    const v = video();

    return {
      v: 1,
      // 房间号由 URL 决定；带在体里只为诊断（服务端不读它）
      room: state.room,
      /**
       * 扩展侧发出这一帧的时刻（PLAN 069）。手机端只用它估计「帧在网络上排了多久」，
       * 据此把取样时刻还原回去；两台机器的时钟差由手机端取最小样本吸收，不做对时。
       *
       * ⚠️ 绝不能进 `frameKey()`：它每帧都变，进了指纹就等于「暂停时也每 250ms 全量发帧」。
       */
      sentAt: Date.now(),
      playing: !!(v && !v.paused && !v.ended),
      /**
       * 在播但画面放不动（PLAN 070）：`readyState < HAVE_FUTURE_DATA` 就是缓冲中。
       *
       * 手机端所有时钟都靠 `playing` 推进，缓冲时它仍是 true —— 不单列这个状态，
       * 手机就会在转圈期间把字幕滚到下一句，缓冲结束再滚回来。
       */
      stalled: !!v && v.readyState < 3,
      // 倍速：手机控制条用它回显（Mac 上改了倍速，手机上也要跟着变）
      rate: v ? Number(v.playbackRate) || 1 : 1,
      // 整片进度：手机底部那条白条与浮窗的 #progress 是同一个东西
      timeline: v && Number.isFinite(v.duration) && v.duration > 0
        ? { position: Number(v.currentTime) || 0, duration: v.duration }
        : null,
      cue: current
        ? { start: Number(current.start) || 0, end: Number(current.end) || 0 }
        : null,
      progress: progressOf(),
      cur: {
        primary: lines.primary,
        segments: lines.segments,
        secondary: lines.secondary,
      },
      prev: lines.prev || null,
      next: lines.next || null,
      // 手机选句浮层的候选（PLAN 045）：当前句往前 40 句
      cues: cueWindow(current),
      // 换句排程的时间表（PLAN 069）：当前句与未来两句，手机端据此在本地时钟上起跑
      plan: upcomingCues(current),
      style: {
        style: official.subtitleStyle || 'classic',
        scale: Number(official.subtitleScale) || 100,
        color: official.subtitleColor || '#FFFFFF',
        dual: official.dualSubtitles !== false,
        primaryLang: official.learningLanguage || null,
        secondaryLang: official.nativeLanguage || null,
        ctxLines: Number.isFinite(own.ctxLines) ? own.ctxLines : 1,
        // 分隔符跟着视频内那一处走（PLAN 047）：none 时传空串，手机端不画符号
        separator: (() => {
          if (!jaBreak) return '|';
          if (typeof jaBreak.separator === 'function') {
            const mode = jaBreak.separator();
            if (mode === 'none') return '';
            return mode === 'dot' ? '·' : '|';
          }
          return jaBreak.SEPARATOR || '|';
        })(),
      },
    };
  }

  /**
   * 一帧的**廉价指纹**：只碰内存对象 + `readLines()`（4 次 querySelector），
   * 不构建 segments、不做 JSON.stringify。
   *
   * 调用它的三个源（250ms 的 rAF、1s 心跳、每次换句）在暂停 / 同句时会反复进来，
   * 而 snapshot() 要分词 + 两次整帧序列化。先用这个挡一道，命中就一帧都不建。
   *
   * 覆盖范围必须与 snapshot() 的字段一一对应：
   *   cue/progress/playing/rate/timeline + cur(primary/segments/secondary) + style
   * `segments` 只由 primary 与断句开关决定，后者在 jaBreak 的开关里 —— 它变化时
   * 官方行会重建，cue index 不变但 primary 文本不变……所以额外把 separator 放进来。
   */
  function frameKey() {
    const pip = globalThis.__llgModPip;
    const current = track && typeof track.getCurrent === 'function' ? track.getCurrent() : null;
    const lines = track && typeof track.readLines === 'function' ? track.readLines() : null;
    const official = pip && typeof pip.official === 'function' ? pip.official() : {};
    const own = pip && typeof pip.pipOption === 'function' ? pip.pipOption() : {};
    const progress = progressOf();
    const jaBreak = globalThis.__llgModJaBreak;
    const v = video();
    // 相邻句的译文是播放到它之后才补进轨道的：暂停时 currentTime 不动，
    // 不把这两个字段算进指纹，手机上的上下句中文会一直停在「只有原文」（PLAN 066）
    const cues = track && typeof track.getCues === 'function' ? track.getCues() : null;
    const prevCue = cues && current && current.index != null ? cues[current.index - 1] : null;
    const nextCue = cues && current && current.index != null ? cues[current.index + 1] : null;

    return [
      current ? current.index : -1,
      current ? Number(current.start) : -1,
      lines ? lines.primary : '',
      lines ? lines.secondary : '',
      prevCue && prevCue.secondary ? prevCue.secondary : '',
      nextCue && nextCue.secondary ? nextCue.secondary : '',
      (jaBreak && jaBreak.SEPARATOR) || '|',
      // 断句开关一变，同一句的 segments 就不同（纯文本一段 vs 按文节切）
      jaBreak && typeof jaBreak.isEnabled === 'function' && jaBreak.isEnabled() ? 1 : 0,
      official.subtitleStyle,
      official.subtitleScale,
      official.subtitleColor,
      official.dualSubtitles,
      official.learningLanguage,
      official.nativeLanguage,
      own.ctxLines,
      v ? (v.paused ? 1 : 0) : 0,
      // 缓冲开始/结束各要推一拍（PLAN 070）：不进指纹的话这次状态变化会被去重掉
      v && v.readyState < 3 ? 1 : 0,
      v ? Number(v.playbackRate) || 1 : 1,
      v && Number.isFinite(v.duration) && v.duration > 0 ? Math.round(v.currentTime * 2) : 0,
      // null（不可信）与 0（句首）必须是两个不同的键，否则换句那一拍会被去重掉
      progress == null ? 'n' : Math.round(progress * 200),
    ].join('\u0001');
  }

  // ---------------------------------------------------------------- 推送

  function pushUrl() {
    return `${state.endpoint}/push?room=${encodeURIComponent(state.room)}`;
  }

  /** 扩展订阅的下行通道（PLAN 074）：手机命令按下即达，不再等下一拍 /push 回程 */
  function commandUrl() {
    return `${state.endpoint}/commands?room=${encodeURIComponent(state.room)}`;
  }

  /** `/commands` 的 EventSource：断线由它自己按 retry 重连 */
  let cmdSource = null;

  function openCommandStream() {
    closeCommandStream();
    if (typeof EventSource !== 'function') return;
    try {
      cmdSource = new EventSource(commandUrl());
    } catch {
      cmdSource = null;
      return;
    }
    cmdSource.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        // 复用既有执行/去重逻辑：同一个 cid 从两条路径到达都不会执行两次
        applyControls(data && data.controls);
      } catch {
        // 不是 JSON（心跳 / 旧服务端）：忽略
      }
    });
  }

  function closeCommandStream() {
    if (!cmdSource) return;
    cmdSource.close();
    cmdSource = null;
  }

  /**
   * 内容脚本直连。`text/plain` 让它成为「简单请求」（不预检）。
   * 必须带超时：被页面侧的私有网络策略拦掉时，fetch 可能既不 resolve 也不 reject，
   * 那样 inflight 会永远为 true，之后一帧都发不出去（且没有任何日志）。
   *
   * ⚠️ 不要带 `keepalive`：Chrome 对 keepalive 请求体有全局配额（约 64KB），
   * 4 次/秒的长跑会把它耗尽并直接 reject；而且按规范 keepalive 请求**会忽略
   * abort signal**，上面那个 4s 超时也就随之失效。这条链路只在页面存活时推送，
   * 本来就不需要「卸载后仍送达」。
   */
  function direct(url, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 4000) : 0;
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body,
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
    })
      .then(async (res) => {
        // 响应里带手机发来的播放命令（见 applyControls），所以这里要留下正文
        const text = await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, via: 'direct', text: text.slice(0, 4000) };
      })
      .catch((err) => ({ ok: false, via: 'direct', error: String((err && err.message) || err) }))
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  /**
   * 扩展源转发（首选）：扩展源 + host_permissions，不受页面侧的跨域 / 私有网络策略影响。
   * SW 没挂上（旧构建 / 被裁剪）或自己失败时很快返回错误，由 send() 决定要不要直连。
   */
  function viaServiceWorker(url, body) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, via: 'sw', error: 'timeout' }), 6000);
      try {
        chrome.runtime.sendMessage({ type: '__llg_cast_push', url, body }, (reply) => {
          const err = chrome.runtime.lastError;
          if (err) {
            finish({ ok: false, via: 'sw', error: err.message });
            return;
          }
          finish(reply || { ok: false, via: 'sw', error: 'empty response' });
        });
      } catch (err) {
        finish({ ok: false, via: 'sw', error: String((err && err.message) || err) });
      }
    });
  }

  /**
   * 直连优先，失败再走扩展源中继。
   *
   * 文件头的取舍仍然成立：直连是简单请求、无预检、少一层消息转发，正常路径就该走它。
   * SW 只在「页面侧的私有网络策略把直连拦掉」时兜底 —— 而那种情况下 SW 往往也会因为
   * 拿不到 host 权限而失败（见 requestCastPermission），此时两条原因一起报出去。
   * 旧实现是 SW 优先：4 次/秒的 `runtime.sendMessage` 会持续唤醒 MV3 service worker，
   * 失败时还要再补一次直连（双倍延迟）。
   */
  async function send(url, body) {
    const res = await direct(url, body);
    if (res.ok) return res;
    const sw = await viaServiceWorker(url, body);
    if (sw.ok) return sw;
    return {
      ok: false,
      via: 'direct+sw',
      error: `${res.error || '直连失败'} / ${sw.error || 'sw 不可用'}`,
    };
  }

  /** 播放可能被自动播放策略拒绝（没有用户手势）；拒绝就静默，下一次推送里 still paused */
  function playVideo(v) {
    try {
      const started = v.play();
      if (started && typeof started.catch === 'function') started.catch(() => {});
    } catch {
      // 老浏览器 / 被策略拒绝：忽略
    }
  }

  /**
   * 执行手机发来的命令。形状已在服务端消毒（tools/cast-control.mjs），这里只做动作。
   * 没有 video（还没进播放页 / 换元素中）就**不推进 lastCid** —— 让服务端保留队列，
   * 下一次推送再试，而不是把命令悄悄吞掉。
   */
  function applyControls(list) {
    if (!Array.isArray(list) || !list.length) return;
    const v = video();
    if (!v) return;

    for (const cmd of list) {
      const cid = Number(cmd && cmd.cid) || 0;
      if (!cid || cid <= lastCid) continue;
      lastCid = cid;

      const action = String(cmd.action || '');
      if (action === 'toggle') {
        if (v.paused) playVideo(v);
        else v.pause();
      } else if (action === 'play') {
        playVideo(v);
      } else if (action === 'pause') {
        v.pause();
      } else if (action === 'skip') {
        const delta = Number(cmd.value) || 0;
        const limit = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
        v.currentTime = Math.max(0, Math.min(limit, (Number(v.currentTime) || 0) + delta));
      } else if (action === 'seek') {
        // 手机选句跳转：值是那句的绝对开始时间（秒）
        const seconds = Number(cmd.value);
        if (Number.isFinite(seconds)) {
          const limit = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
          v.currentTime = Math.max(0, Math.min(limit, seconds));
        }
      } else if (action === 'rate') {
        const rate = Number(cmd.value);
        if (Number.isFinite(rate) && rate > 0) v.playbackRate = rate;
      }
    }
  }

  /** FNV-1a 32 位：给静态块取一个跨端一致的短版本号（PLAN 071） */
  function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  /**
   * 取静态块（PLAN 071）。
   *
   * 只在 `frameKey()` 变化时重建并序列化：这个指纹已经覆盖了当前句、上下文、样式与
   * 分隔符，静态块不会漏更新。稳态（同一句继续播）下这里一次 `JSON.stringify` 都不做。
   */
  function staticOf(payload, key) {
    if (key === staticKey && staticBlock) return staticBlock;
    staticKey = key;
    staticBlock = {
      cur: payload.cur,
      prev: payload.prev,
      next: payload.next,
      cues: payload.cues,
      plan: payload.plan,
      style: payload.style,
    };
    staticVer = fnv1a(JSON.stringify(staticBlock));
    return staticBlock;
  }

  /** 整条轨的分块大小（PLAN 072）：200 句约 10–14KB，远低于服务端 64KB 上限 */
  const TRACK_CHUNK = 200;
  /** 轨道下发进度：`sentTo` 只在发送成功后前进，失败的那一块下一拍重来 */
  let trackState = { ver: '', id: '', total: 0, sentTo: 0 };

  /** 当前视频 id：只用于让手机端区分「换了视频」，取不到就空串 */
  function videoId() {
    try {
      return new URL(location.href).searchParams.get('v') || '';
    } catch {
      return '';
    }
  }

  /**
   * 轨道指纹：句数 + 首尾句起点。
   *
   * 用这个而不是完整内容哈希：拿到全量轨道时不必为算版本再序列化一遍；
   * 断句变化（官方轨晚到、视频内切轨）几乎必然改变句数或首尾起点。
   */
  function trackVerOf(cues, id) {
    const first = cues[0] || {};
    const last = cues[cues.length - 1] || {};
    return fnv1a(`${id}|${cues.length}|${Number(first.start) || 0}|${Number(last.start) || 0}`);
  }

  /**
   * 取下一块整条轨（PLAN 072）。
   *
   * 手机端拿到完整轨道后，即使推送中断也能继续按本地时钟换句；
   * 没有它的话，断流一超过 `plan` 覆盖的两句就停在最后一句上不动。
   * 发完返回 null（轨道没变时不会再占带宽）。
   */
  function nextTrackChunk() {
    const cues = track && typeof track.getCues === 'function' ? track.getCues() : null;
    if (!cues || !cues.length) return null;

    const id = videoId();
    const ver = trackVerOf(cues, id);
    if (ver !== trackState.ver) trackState = { ver, id, total: cues.length, sentTo: 0 };
    if (trackState.sentTo >= cues.length) return null;

    const from = trackState.sentTo;
    const to = Math.min(cues.length, from + TRACK_CHUNK);
    const chunk = [];
    for (let i = from; i < to; i += 1) {
      const cue = cues[i];
      const start = Number(cue && cue.start);
      if (!Number.isFinite(start)) continue;
      const end = Number(cue && cue.end);
      chunk.push([
        start,
        Number.isFinite(end) && end > start ? end : null,
        (cue && cue.primary) || '',
        (cue && cue.secondary) || '',
      ]);
    }
    return { ver, id, from, to, total: cues.length, cues: chunk };
  }

  /**
   * 发一帧。
   * @param {boolean} force true = 忽略去重（刚打开开关时用）
   */
  async function push(force) {
    if (!state.enabled || inflight) return;
    if (Date.now() < nextTryAt) return;

    // 先算指纹再建快照：内容没变时（暂停 / 同句）连 segments 都不必重新切
    const key = frameKey();
    if (!force && key === lastFrameKey && Date.now() - lastAttemptAt < CONTROL_POLL_MS) return;

    const payload = snapshot();
    if (!payload) return;

    // 静态块按需重建（PLAN 071）；`static` 只在版本变化时随帧下发
    const block = staticOf(payload, key);
    const withStatic = staticVer !== sentStaticVer;
    // 整条轨分块下发（PLAN 072）：一块一拍，发完为止
    const trackChunk = nextTrackChunk();
    // 动态块就是整帧去掉静态字段：稳态下只有几十字节
    const body = JSON.stringify({
      v: payload.v,
      room: payload.room,
      sentAt: payload.sentAt,
      playing: payload.playing,
      stalled: payload.stalled,
      rate: payload.rate,
      timeline: payload.timeline,
      cue: payload.cue,
      progress: payload.progress,
      trackVer: staticVer,
      ...(withStatic ? { static: block } : {}),
      ...(trackChunk ? { track: trackChunk } : {}),
      // ack：告诉服务端「我已经执行到这条了」；它据此清掉队列
      ack: lastCid,
    });
    // 暂停时同一句会被 rAF 反复取到：`frameKey()` 那一道已经挡掉（AGENTS.md §3 幂等），
    // 这里不再对整帧做第二次序列化比较 —— 一次 stringify 的产物就是发出去的 body。

    inflight = true;
    lastAttemptAt = Date.now();
    try {
      const res = await send(pushUrl(), body);
      if (!res.ok) throw new Error(`${res.via}: ${res.error || `HTTP ${res.status}`}`);

      if (failures) console.info('[手机字幕屏] 已恢复推送');
      failures = 0;
      nextTryAt = 0;
      sentStaticVer = staticVer;
      // 这一块真的发出去了才推进进度；失败时下一拍重发同一块
      if (trackChunk) trackState.sentTo = trackChunk.to;
      lastFrameKey = key;
      lastError = '';
      sent += 1;

      // 响应的正文里带着手机发来的播放命令（见 handleControl）
      if (res.text) {
        try {
          applyControls(JSON.parse(res.text).controls);
        } catch {
          // 不是 JSON（旧服务端 / 被截断）：这一拍没有命令，忽略
        }
      }
    } catch (err) {
      lastError = String((err && err.message) || err);
      failures += 1;
      nextTryAt = Date.now() + Math.min(RETRY_MAX_MS, 400 * 2 ** Math.min(failures, 5));
      // 只在第一次与每 30 次提醒：cast server 没起时不该把控制台刷满
      if (failures === 1 || failures % 30 === 0) {
        warn(`推送失败（第 ${failures} 次）：${lastError}。先确认电脑上已运行 make cast`);
      }
    } finally {
      inflight = false;
    }
  }

  function loop() {
    if (!state.enabled) {
      // 必须归零：`start()` 用 `if (rafId) return` 判重。留着这个句柄的话，
      // 之后经 setConfig({enabled:true}) 或任何绕过 stop() 的路径再打开，
      // start() 会以为自己还在跑 —— 开关亮着，一帧都不推。
      rafId = 0;
      return;
    }
    const now = Date.now();
    if (now - lastPushAt >= PUSH_INTERVAL_MS) {
      lastPushAt = now;
      // 不 await：上一帧没回来时 push() 自己会挡掉
      push(false);
    }
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (rafId) return;
    // 开关被关掉再打开：手机端可能已经换了页面，静态块要重发一次
    sentStaticVer = '';
    failures = 0;
    nextTryAt = 0;
    lastPushAt = 0;
    rafId = requestAnimationFrame(loop);
    openCommandStream();
    push(true);
  }

  function stop() {
    closeCommandStream();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  /** 关掉开关时告诉手机「我这没字幕了」，否则它会一直停在最后一句 */
  function pushIdle() {
    send(pushUrl(), JSON.stringify({
      v: 1,
      playing: false,
      cur: { segments: [], secondary: '', primary: '' },
      prev: null,
      next: null,
      style: { dual: true, ctxLines: 0 },
    })).catch(() => {});
  }

  /**
   * 连接自检：发一帧空探针，返回走的是哪条路、耗时、失败原因。
   * 设置面板里那行「测试手机字幕屏连接」调的就是它 —— 出问题时不用开 DevTools 猜。
   */
  async function probe() {
    const started = Date.now();
    const res = await send(
      pushUrl(),
      JSON.stringify({
        v: 1,
        probe: true,
        playing: false,
        cur: { segments: [], secondary: '', primary: '' },
      }),
    );
    const result = { ...res, ms: Date.now() - started, url: pushUrl() };
    console.info('[手机字幕屏] 连接测试', result);
    return result;
  }

  // ---------------------------------------------------------------- 开关

  function setEnabled(next) {
    const value = !!next;
    if (value === state.enabled) return;
    state.enabled = value;
    saveState();
    refreshButton();
    if (value) start();
    else {
      stop();
      pushIdle();
    }
  }

  /**
   * 申请 127.0.0.1 的 host 权限（build 里已改成 `optional_host_permissions`）。
   *
   * 只在用户手势里调用（toggle 来自控制栏按钮 / 设置面板开关的点击）。
   * 拿不到也不影响主路径 —— 直连不需要扩展权限，SW 中继只是被拦时的兜底；
   * 而且这条权限对「不用手机屏」的用户本来就不该在安装时索要。
   */
  function requestCastPermission() {
    try {
      const perms = chrome && chrome.permissions;
      if (!perms || typeof perms.request !== 'function') return;
      perms.request({ origins: [CAST_ORIGIN] }, () => {
        // 读一次 lastError，否则 Chrome 会打 "Unchecked runtime.lastError"
        void (chrome.runtime && chrome.runtime.lastError);
      });
    } catch {
      // 没有手势 / 权限 API 不可用：忽略
    }
  }

  function toggle() {
    if (!state.enabled) requestCastPermission();
    setEnabled(!state.enabled);
  }

  // ---------------------------------------------------------------- 启动

  try {
    chrome.storage.local
      .get(STORE_KEY)
      .then((res) => {
        const saved = res && res[STORE_KEY];
        if (saved && typeof saved === 'object') {
          state = {
            ...DEFAULT_STATE,
            ...saved,
            enabled: saved.enabled === true,
          };
        }
        if (state.enabled) start();
      })
      .catch(() => {});
  } catch {
    // 没有 storage：保持默认（关闭）
  }

  // 结构变化时立即推一帧，不必等到下一拍
  if (track && typeof track.subscribe === 'function') {
    track.subscribe(() => {
      if (state.enabled) push(false);
    });
  }

  // 每秒一次的兜底：rAF 在后台标签页会被暂停，这条保证「切走标签页」也还在推
  if (shared && typeof shared.onTick === 'function') {
    shared.onTick(() => {
      refreshButton();
      if (state.enabled) push(false);
    });
  }

  refreshButton();

  // 挂到 Linglass 自己的设置面板（与浮窗、学习面板同一处，不另造入口）
  if (shared && typeof shared.registerFeature === 'function') {
    shared.registerFeature({
      id: 'phoneCast',
      title: '手机字幕屏',
      desc: '把当前字幕同步到手机。先在电脑上运行 make cast，再用手机浏览器打开终端里打印的地址；'
        + '这里只管开关，内容与样式跟随当前字幕与官方设置',
      icon: `
<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="7" y="2.5" width="10" height="19" rx="2.5"/>
  <path d="M11 18.5h2"/>
  <path d="M4 8.5h5M4 13.5h5M15 8.5h5M15 13.5h5"/>
</svg>`,
      isOn: () => state.enabled,
      toggle,
      // 出问题时先点这一行：它会告诉你走的是 SW 还是直连、耗时多少、失败原因
      actions: [
        {
          id: 'cast-probe',
          title: '测试手机字幕屏连接',
          icon: `
<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 12h4l2-5 4 10 2-5h4"/>
</svg>`,
          value: () => probeLabel,
          run: () => {
            const enabled = state.enabled;
            probeLabel = '测试中…';
            probe()
              .then((res) => {
                const via = res.via || '?';
                probeLabel = res.ok ? `✓ ${via} ${res.ms}ms` : `✗ ${via}：${String(res.error).slice(0, 32)}`;
                if (!enabled) probeLabel += '（开关是关的）';
              })
              .catch((err) => {
                probeLabel = `✗ ${String((err && err.message) || err).slice(0, 32)}`;
              });
          },
        },
      ],
    });
  }

  // 测试 / 探针直入口（与 __llgModPip 同款做法）
  Object.defineProperty(globalThis, NS, {
    value: {
      isEnabled: () => state.enabled,
      setEnabled,
      toggle,
      snapshot,
      push,
      probe,
      config: () => ({ ...state }),
      setConfig: (patch) => {
        state = { ...state, ...patch };
        saveState();
        return { ...state };
      },
      stats: () => ({ sent, failures, lastError, lastAttemptAt, staticVer, commandStream: !!cmdSource }),
      pushUrl,
      commandUrl,
    },
    configurable: true,
  });
})();
