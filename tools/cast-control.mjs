/**
 * 手机字幕屏 —— 手机发来的播放命令（消毒）
 *
 * 链路：手机 POST /control → cast-server 入队 → 扩展下一次 /push 的响应里带回 →
 * 内容脚本操作 video。服务端与内容脚本都只会执行**这里放行过**的形状，
 * 所以手机页多写一个字段、或者有人手工 POST 一个 `action: "eval"` 都进不来。
 */

/** 只认这六个动作：两个停止态、一个开关、快进快退、倍速、跳到某句 */
export const CONTROL_ACTIONS = ['toggle', 'play', 'pause', 'skip', 'rate', 'seek'];

/** 内容脚本直连 /push 时，Origin 是它所在页面的 origin */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'www.youtube-nocookie.com',
]);

/** 私有网段：手机打开的接收页自己会 POST /prefs，它的 Origin 就是这类地址 */
const PRIVATE_V4 = [
  // 127.0.0.0/8：Mac 本机（内容脚本直连时上游可能把它算成页面来源）
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
];

/** 手机页倍速按钮循环的档位（与 YouTube 自己的档位一致；服务端另外夹 0.25–2） */
export const RATE_STEPS = [0.75, 1, 1.25, 1.5, 2];

/** 单次快进/快退的上限（秒）：足够跳过一句，又不至于一按就飞出十分钟 */
const SKIP_LIMIT = 60;

/** 待执行命令的上限：手滑连点、或扩展没开时，别让队列无限长 */
export const MAX_PENDING = 8;

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;

/**
 * @param {unknown} raw 请求体（已 JSON.parse）
 * @returns {{action: string, value: number|null}|null} 非法一律 null
 */
export function sanitizeControl(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const action = String(raw.action || '');
  if (action === 'toggle' || action === 'play' || action === 'pause') {
    return { action, value: null };
  }

  const value = Number(raw.value);
  if (!Number.isFinite(value)) return null;

  if (action === 'skip') {
    const seconds = Math.max(-SKIP_LIMIT, Math.min(SKIP_LIMIT, round1(value)));
    // 0 秒的快进没有任何意义，还平白多一次往返
    return seconds === 0 ? null : { action, value: seconds };
  }

  if (action === 'rate') {
    return { action, value: Math.max(0.25, Math.min(2, round2(value))) };
  }

  if (action === 'seek') {
    // 选句跳转：0 秒合法（片头第一句就是 0），上限给一天，真正的边界由扩展按 video.duration 夹
    return { action, value: Math.max(0, Math.min(24 * 3600, round1(value))) };
  }

  return null;
}

/**
 * 允许访问中转站的 Origin（PLAN 046 §12）。
 *
 * 这个进程绑 `0.0.0.0`、没有账号，能表达「谁可以访问」的地方只剩 CORS。
 * 白名单覆盖三类真实来源：
 *   · 扩展自身（`chrome-extension://…`）—— SW 中继；
 *   · YouTube 系 —— 内容脚本直连时 Origin 是页面 origin；
 *   · 本机与私有网段（含 `.local`）—— 手机打开的接收页会 POST `/prefs`。
 *
 * 无 Origin 放行：curl / 导航请求不带 Origin，而**浏览器跨源请求一定带**，
 * 所以「没有 Origin」恰恰说明它不是被某个网站驱动的。
 *
 * 已知边界：同一个 Wi-Fi 上的恶意页面 Origin 也是 `192.168.x.x`，白名单拦不住它。
 * 那是「不走 HTTPS、不做账号」这个取舍的代价，README 里写明。
 *
 * @param {string|undefined} origin
 * @returns {boolean}
 */
export function isAllowedOrigin(origin) {
  if (!origin) return true;

  let url;
  try {
    url = new URL(String(origin));
  } catch {
    return false;
  }

  if (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return true;
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  if (host.endsWith('.local')) return true;
  return PRIVATE_V4.some((pattern) => pattern.test(host));
}

/**
 * 入队（原地修改并返回同一个数组，服务端直接存着用）。
 * 超过上限时丢**最旧**的：手滑连点十下，用户最后想要的一定是最后那几下。
 */
export function enqueueControl(pending, cmd) {
  pending.push(cmd);
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  return pending;
}

/**
 * 扩展在下一次 /push 里 ack 之后清理队列。
 * `ack` 为 0 / 非法 = 还没执行过任何一条，队列原样保留。
 */
export function pruneControls(pending, ack) {
  const value = Number(ack) || 0;
  return value > 0 ? pending.filter((cmd) => cmd.cid > value) : pending;
}
