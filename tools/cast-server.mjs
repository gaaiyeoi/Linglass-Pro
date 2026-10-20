#!/usr/bin/env node
/**
 * 手机字幕屏 —— 局域网接收端（预览版，PLAN 035 的第一步）
 *
 *   Mac 浏览器（扩展）──POST /push──▶ 本进程 ──SSE /stream──▶ iPhone Safari
 *
 * 为什么需要这个进程：Chrome 扩展不能监听端口，iPhone 也不可能直连扩展，
 * 所以「浮窗内容上手机」必须有一小块局域网中转。
 *
 * 本文件做四件事：
 *   1. 把接收页发给手机（GET /，页面本体见 cast-page.mjs）；
 *   2. 把收到的字幕快照用 SSE 广播出去（GET /stream）；
 *   3. 收下手机发来的播放命令（POST /control），搭扩展下一次 /push 的响应带回去；
 *   4. --demo 时自己造一组假字幕，用来在真机上确认排版。
 *
 * 用法：
 *   node tools/cast-server.mjs --demo      # 假字幕循环，用来看效果
 *   node tools/cast-server.mjs             # 只转发扩展推来的真实字幕
 *   PORT=9000 node tools/cast-server.mjs   # 换端口
 *
 * 零第三方依赖（与本仓库其它工具一致）。
 */
import http from 'node:http';
import os from 'node:os';

import { enqueueControl, isAllowedOrigin, pruneControls, sanitizeControl } from './cast-control.mjs';
import { renderPage } from './cast-page.mjs';

/** 手机要能访问，必须绑到所有网卡；只绑 127.0.0.1 的话手机连不上 */
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8899);
const DEMO = process.argv.includes('--demo');
/** 单条快照上限：正常字幕一次几百字节，64KB 已经很宽松 */
const MAX_BODY = 64 * 1024;
/** SSE 保活间隔：手机端超过 25s 没有任何数据就判定卡住 */
const PING_MS = 15000;
/** 预览用假字幕的推进节拍 */
const DEMO_TICK_MS = 500;
/**
 * 房间数上限。
 *
 * `?room=` 是请求里任意一段字符串，无上限时循环换名字就能让 Map 单调增长
 * （每个房间还挂着 snapshot / pending）。32 已经远超「几台设备 coexisting」。
 */
const MAX_ROOMS = 32;

// ---------------------------------------------------------------- 房间（多设备/多标签隔离）

/**
 * 房间只防「串台」，不做鉴权：同一 Wi-Fi 上的人都能看到字幕。
 * 这是刻意的最小实现，PLAN 的「不做什么」里会写明不走 HTTPS、不做账号。
 */
const rooms = new Map();
let seq = 0;

function roomOf(name) {
  const key = String(name || 'demo').slice(0, 32);
  let room = rooms.get(key);
  if (room) {
    room.lastSeen = Date.now();
    return room;
  }

  // 只在「没有客户端」的房间上淘汰：有人在看的房间绝不踢掉，宁可短暂超限。
  if (rooms.size >= MAX_ROOMS) {
    let victim = null;
    let oldest = Infinity;
    for (const [roomKey, item] of rooms) {
      if (item.clients.size) continue;
      if (item.lastSeen < oldest) {
        oldest = item.lastSeen;
        victim = roomKey;
      }
    }
    if (victim !== null) rooms.delete(victim);
  }

  room = {
    snapshot: null,
    // 静态块（PLAN 071）：只在变化时随帧来，这里替新接入的手机保存一份
    static: null,
    staticVer: '',
    // 整条轨（PLAN 072）：分块来的，攒齐后供新接入的手机一次性补齐
    track: null,
    // 扩展订阅的命令通道（PLAN 074）
    cmdClients: new Set(),
    clients: new Set(),
    prefs: null,
    // 手机发来的播放命令（等待扩展在下一次 /push 里取走并 ack）
    pending: [],
    cmdSeq: 0,
    lastSeen: Date.now(),
  };
  rooms.set(key, room);
  return room;
}


/**
 * 手机端的显示偏好（字号 / 样式 / 颜色 / 上下文 / 进度条）。
 *
 * 为什么存在服务端：手机上的 localStorage 是按「来源」分的，用 .local 打开一次、
 * 再用 IP 打开一次就是两份存储；主屏图标又是第三种。放在房间里，这些场景都能继承
 * 上一次的设置（页面加载时由服务端注入，作为 localStorage 的后备）。
 */
function sanitizePrefs(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const scale = Math.round((Number(value.scale) || 100) / 10) * 10;
  return {
    style: ['classic', 'cinema', 'comic', 'contrast'].includes(value.style)
      ? value.style
      : 'classic',
    scale: Math.max(50, Math.min(150, scale)),
    color: /^#[0-9a-fA-F]{6}$/.test(String(value.color || ''))
      ? String(value.color).toUpperCase()
      : '#FFFFFF',
    ctx: [0, 1, 2].includes(Number(value.ctx)) ? Number(value.ctx) : 1,
    dual: value.dual !== false,
    bar: value.bar !== false,
  };
}

/**
 * 把一块轨道拼进房间的整轨缓存（PLAN 072）。
 *
 * 扩展按 200 句一块发；这里按 `ver` 累积。版本变了（换视频 / 官方轨晚到）就整份作废，
 * 不做跨版本的拼接 —— 混着拼出来的时间轴比没有更糟。
 */
function mergeTrackChunk(store, chunk) {
  const total = Math.max(0, Math.min(20000, Number(chunk.total) || 0));
  const from = Math.max(0, Number(chunk.from) || 0);
  const cues = Array.isArray(chunk.cues) ? chunk.cues : [];
  const ver = String(chunk.ver || '');
  const same = store && store.ver === ver && store.total === total;
  const next = same ? store : { ver, total, cues: [] };

  for (let i = 0; i < cues.length; i += 1) {
    const at = from + i;
    if (at >= 0 && at < total && cues[i]) next.cues[at] = cues[i];
  }
  let got = 0;
  for (let i = 0; i < next.total; i += 1) if (next.cues[i]) got += 1;
  next.got = got;
  return next;
}

/**
 * 写一帧 SSE。
 *
 * `res.write()` 返回 false 表示内核缓冲已满（手机弱网 / 息屏）。这时**跳过**这个
 * 客户端，等 drain 再恢复 —— 不处理的话 4 帧/秒的推送会让 Node 侧 Buffer 一直长，
 * 最后连中转进程的内存一起耗掉。
 */
function sendEvent(res, payload) {
  if (res.__llgBackpressure) return false;
  const ok = res.write(`data: ${JSON.stringify(payload)}\n\n`);
  if (ok === false) {
    res.__llgBackpressure = true;
    res.once('drain', () => {
      res.__llgBackpressure = false;
    });
  }
  return true;
}

function broadcast(room, payload) {
  for (const res of room.clients) {
    try {
      sendEvent(res, payload);
    } catch {
      room.clients.delete(res);
    }
  }
}

// ---------------------------------------------------------------- HTTP

/**
 * 按 Origin 白名单设 CORS 头，返回「这个来源是否放行」。
 *
 * 旧实现是 `allow-origin: *` + `allow-private-network: true` —— 那个组合等于
 * 主动拆掉浏览器对「公网页面访问本机」的保护：任意网站都能 POST /control 暂停/
 * 跳转用户正在看的视频。这里改成**回显白名单里的 Origin**，其余不设 CORS 头
 * 并在入口直接 403。
 */
function cors(req, res) {
  const origin = req.headers.origin;
  const allowed = isAllowedOrigin(origin);
  // 带上 Vary：同一个 URL 对不同 Origin 返回不同头，别让中间缓存串了
  res.setHeader('vary', 'origin');
  if (!allowed) return false;

  res.setHeader('access-control-allow-origin', origin || '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  // 只有白名单来源才看得到这个头 —— 它正是「公网页面访问本机」的闸门
  res.setHeader('access-control-allow-private-network', 'true');
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function handleStream(req, res, url) {
  const room = roomOf(url.searchParams.get('room'));

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // 有反向代理时别缓冲，否则字幕会攒着一起到
    'x-accel-buffering': 'no',
    // 不要在这里再写 access-control-allow-origin：writeHead 里的头会覆盖
    // cors() 按白名单回显的那一份，退化成 `*` 就等于绕开了 §12 的校验。
  });
  // 断线后 1 秒重连（EventSource 自己会做）
  res.write('retry: 1000\n\n');
  if (room.snapshot) sendEvent(res, room.snapshot);

  room.clients.add(res);
  console.log(`[cast] 手机接入（room=${url.searchParams.get('room') || 'demo'}），当前 ${room.clients.size} 台`);

  const ping = setInterval(() => {
    // 背压时也跳过：往一个已经写不动的连接继续塞 ping 只会加重缓冲
    if (!res.__llgBackpressure) res.write(': ping\n\n');
  }, PING_MS);
  req.on('close', () => {
    clearInterval(ping);
    room.clients.delete(res);
  });
}

/**
 * 扩展订阅的下行命令通道（PLAN 074）。
 *
 * 命令原本只能搭 `/push` 的响应回程：暂停时内容不变，扩展一拍最多 1 秒才空推一次
 * （CONTROL_POLL_MS），手机上点「播放」要等一秒才生效。这里给扩展一条 SSE，
 * 手机按下即达；`pending` 队列与 ack 语义保持不变，作为丢包兜底。
 */
function handleCommands(req, res, url) {
  const room = roomOf(url.searchParams.get('room'));

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 1000\n\n');
  // 重连时把还没 ack 的命令补一遍：两条通道都可能丢一拍
  if (room.pending.length) sendEvent(res, { controls: room.pending });

  room.cmdClients.add(res);
  console.log(`[cast] 扩展接入命令通道（room=${url.searchParams.get('room') || 'demo'}），当前 ${room.cmdClients.size} 条`);

  const ping = setInterval(() => {
    if (!res.__llgBackpressure) res.write(': ping\n\n');
  }, PING_MS);
  req.on('close', () => {
    clearInterval(ping);
    room.cmdClients.delete(res);
  });
}

/** 把一条命令立刻推给订阅中的扩展（PLAN 074） */
function broadcastControl(room, cmd) {
  const payload = { controls: [cmd] };
  for (const res of room.cmdClients) {
    try {
      sendEvent(res, payload);
    } catch {
      room.cmdClients.delete(res);
    }
  }
}

async function handlePush(req, res, url) {
  const text = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad json');
    return;
  }

  const room = roomOf(url.searchParams.get('room') || payload.room);
  // 静态块只在变化时来（PLAN 071）：丢掉了的话新接入的手机就只剩播放头，没有字幕
  if (payload.static && typeof payload.static === 'object') {
    room.static = payload.static;
    room.staticVer = String(payload.trackVer || '');
  }
  // 整条轨（PLAN 072）：分块累积，供新接入的手机补齐；已连上的照常转发这一块
  if (payload.track && typeof payload.track === 'object') {
    room.track = mergeTrackChunk(room.track, payload.track);
  }
  const next = { ...payload, v: 1, seq: (seq += 1), at: Date.now() };
  // room.snapshot 是「新客户端接入时补发的那一帧」：静态块与整轨都要补上
  room.snapshot = { ...next };
  if (room.static && !next.static) {
    room.snapshot.static = room.static;
    room.snapshot.trackVer = room.staticVer;
  }
  if (room.track && !next.track) {
    room.snapshot.track = {
      ver: room.track.ver,
      from: 0,
      to: room.track.got,
      total: room.track.total,
      cues: room.track.cues.slice(),
    };
  }
  // 已连上的客户端自己缓存静态块：动态帧就按原样发，省带宽
  broadcast(room, next);

  // 扩展在下一次 /push 里带回它已经执行到哪一条，据此清掉队列。
  // 只保留 cid > ack 的命令：响应丢了也不会漏执行，扩展按 cid 去重即可。
  room.pending = pruneControls(room.pending, payload.ack);

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    seq: next.seq,
    clients: room.clients.size,
    controls: room.pending,
  }));
}

/**
 * 手机 → 服务端：播放命令（暂停 / 倍速 / ±5 秒）。
 *
 * 这里只入队，不动作 —— 真正的执行者是扩展（它握着 video）。
 * 命令带 `cid`，随扩展下一次 `/push` 的响应回去；扩展 ack 之后才清理。
 */
async function handleControl(req, res, url) {
  const text = await readBody(req);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad json');
    return;
  }

  const cmd = sanitizeControl(raw);
  if (!cmd) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad control');
    return;
  }

  const room = roomOf(url.searchParams.get('room') || raw.room);
  room.cmdSeq += 1;
  const queued = { cid: room.cmdSeq, ...cmd };
  enqueueControl(room.pending, queued);
  // 有扩展在订阅命令通道就立刻给它（PLAN 074）；没订阅时仍靠 /push 回程
  broadcastControl(room, queued);

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, cid: queued.cid }));
}

function handleInfo(res) {
  const body = {
    ok: true,
    port: PORT,
    demo: DEMO,
    rooms: [...rooms.entries()].map(([name, room]) => ({
      name,
      clients: room.clients.size,
      seq: room.snapshot ? room.snapshot.seq : 0,
    })),
  };
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const allowedOrigin = cors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(allowedOrigin ? 204 : 403);
    res.end();
    return;
  }
  if (!allowedOrigin) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('origin not allowed');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 每次请求现生成：start_url 要带上当前房间号，否则从主屏图标打开会掉回默认房间
  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
    const room = url.searchParams.get('room') || 'demo';
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({
      name: '字幕屏',
      short_name: '字幕屏',
      start_url: `/?room=${encodeURIComponent(room)}`,
      scope: '/',
      display: 'standalone',
      // iOS 对 manifest 的 orientation 支持不稳定，写上不亏：真忽略也只是照常旋转
      orientation: 'landscape',
      background_color: '#141518',
      theme_color: '#141518',
    }));
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const room = roomOf(url.searchParams.get('room'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    // 把房间上一次的显示偏好注进页面：localStorage 为空（换 URL / 换容器）时也能继承
    res.end(renderPage(url.searchParams.get('room') || 'demo', room.prefs));
    return;
  }

  // 手机端改一次设置就同步一份：只按房间存最近一份，不做历史
  if (req.method === 'POST' && url.pathname === '/prefs') {
    try {
      const room = roomOf(url.searchParams.get('room'));
      room.prefs = sanitizePrefs(JSON.parse(await readBody(req)));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, prefs: room.prefs }));
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('bad prefs');
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/stream') {
    handleStream(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/commands') {
    handleCommands(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/push') {
    try {
      await handlePush(req, res, url);
    } catch (err) {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err.message);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/control') {
    try {
      await handleControl(req, res, url);
    } catch (err) {
      res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err.message);
    }
    return;
  }

  // 手机端测时钟差用（PLAN 075）：只回一个时间戳，不做任何副作用
  if (req.method === 'GET' && url.pathname === '/ping') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify({ ok: true, at: Date.now() }));
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/info')) {
    handleInfo(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// ---------------------------------------------------------------- 预览用假字幕

const DEMO_CUES = [
  {
    duration: 9,
    segments: [
      [{ text: '昨日', ruby: 'きのう' }, { text: 'は', ruby: '' }],
      [{ text: '雨', ruby: 'あめ' }, { text: 'だったので', ruby: '' }],
      [{ text: '家', ruby: 'いえ' }, { text: 'で', ruby: '' }],
      [{ text: '本', ruby: 'ほん' }, { text: 'を', ruby: '' }, { text: '読', ruby: 'よ' }, { text: 'んでいた', ruby: '' }],
    ],
    primary: '昨日は雨だったので、家で本を読んでいた。',
    secondary: '昨天下雨，所以在家看书。',
  },
  {
    duration: 8,
    segments: [
      [{ text: 'この', ruby: '' }, { text: '問題', ruby: 'もんだい' }],
      [{ text: 'もう', ruby: '' }, { text: '一度', ruby: 'いちど' }],
      [{ text: '考', ruby: 'かんが' }, { text: 'えてみよう', ruby: '' }],
    ],
    primary: 'この問題、もう一度考えてみよう。',
    secondary: '这个问题，再想一遍吧。',
  },
  {
    duration: 8,
    segments: [
      [{ text: '準備', ruby: 'じゅんび' }, { text: 'ができたら', ruby: '' }],
      [{ text: '出発', ruby: 'しゅっぱつ' }, { text: 'しましょう', ruby: '' }],
    ],
    primary: '準備ができたら、出発しましょう。',
    secondary: '准备好了就出发吧。',
  },
];

let demoIndex = 0;
let demoStartedAt = Date.now();
/** 假字幕的总时长：用来演示底部那条「整片进度」（真机上是视频的总时长） */
const DEMO_LOOP_SECONDS = DEMO_CUES.reduce((sum, cue) => sum + cue.duration, 0);
const demoBootAt = Date.now();

function demoTick() {
  let cue = DEMO_CUES[demoIndex];
  let elapsed = (Date.now() - demoStartedAt) / 1000;
  while (elapsed >= cue.duration) {
    demoStartedAt += cue.duration * 1000;
    demoIndex = (demoIndex + 1) % DEMO_CUES.length;
    cue = DEMO_CUES[demoIndex];
    elapsed = (Date.now() - demoStartedAt) / 1000;
  }

  const prev = DEMO_CUES[(demoIndex + DEMO_CUES.length - 1) % DEMO_CUES.length];
  const next = DEMO_CUES[(demoIndex + 1) % DEMO_CUES.length];
  const payload = {
    v: 1,
    demo: true,
    playing: true,
    // 预览模式没有真的播放器：倍速固定 1×（控制条照常显示）
    rate: 1,
    // start 用单调递增的绝对秒数：换句时手机端靠它把进度瞬间归零，而不是倒着走
    // end 必须是 start + 本句时长：手机端拿 end - start 算句时长来做本地插值，
    // 写成 cue.duration 会让 end < start，插值直接退化成「跟推送一跳一跳」
    cue: { start: demoStartedAt / 1000, end: demoStartedAt / 1000 + cue.duration },
    // 整片进度（真机上是 video.currentTime / duration）
    timeline: {
      position: ((Date.now() - demoBootAt) / 1000) % DEMO_LOOP_SECONDS,
      duration: DEMO_LOOP_SECONDS,
    },
    progress: Math.min(1, elapsed / cue.duration),
    cur: { segments: cue.segments, secondary: cue.secondary, primary: cue.primary },
    prev: { primary: prev.primary },
    next: { primary: next.primary },
    // 字段与扩展侧将要推的快照一致（见 PLAN 035）：样式名 / 档位 / 颜色 / 语言都按官方的来
    style: {
      style: 'classic',
      scale: 100,
      color: '#FFFFFF',
      dual: true,
      primaryLang: 'ja',
      secondaryLang: 'zh',
      ctxLines: 1,
      separator: '|',
    },
  };

  // 只推给正在看的房间：没人连也不必空转
  const room = rooms.get('demo');
  if (!room || !room.clients.size) return;
  const frame = { ...payload, seq: (seq += 1), at: Date.now() };
  room.snapshot = frame;
  broadcast(room, frame);
}

// ---------------------------------------------------------------- 启动

/**
 * 列出可让手机访问的 IPv4。
 *
 * 虚拟网卡必须排后面：OrbStack / Docker / VPN 会各给一个 192.168.x 或 10.x 地址，
 * 把它们当成「手机打开这个」会白白浪费用户十分钟。物理网卡（en*）优先。
 */
function lanAddresses() {
  const physical = [];
  const virtual = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      const bucket = /^en\d+$/.test(name) ? physical : virtual;
      bucket.push({ name, address: item.address });
    }
  }
  return [...physical, ...virtual];
}

server.listen(PORT, HOST, () => {
  const room = 'demo';
  const host = os.hostname().replace(/\.local$/i, '');
  console.log(`[cast] 监听      ${HOST}:${PORT}${DEMO ? '  (假字幕预览)' : ''}`);
  lanAddresses().forEach((item, index) => {
    const tail = index === 0 ? '' : `   （${item.name}，通常不用）`;
    console.log(`[cast] 手机打开  http://${item.address}:${PORT}/?room=${room}${tail}`);
  });
  console.log(`[cast] 或        http://${host}.local:${PORT}/?room=${room}`);
  console.log('[cast] 首次运行请在 macOS 防火墙弹窗里点「允许」');
  if (DEMO) {
    setInterval(demoTick, DEMO_TICK_MS);
    console.log('[cast] 预览模式：手机接入后会自动循环 3 句假字幕');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[cast] 端口 ${PORT} 已被占用，换一个：PORT=9000 node tools/cast-server.mjs`);
    process.exit(1);
  }
  throw err;
});

process.on('SIGINT', () => {
  console.log('\n[cast] 停止');
  process.exit(0);
});
