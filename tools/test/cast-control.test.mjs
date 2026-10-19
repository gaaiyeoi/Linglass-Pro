/**
 * 手机播放命令的消毒规则（PLAN 042）。
 *
 * 服务端与内容脚本都只执行放行过的形状，所以这张白名单是唯一入口 ——
 * 夹取边界必须钉死，否则手机上一次「倍速 10×」会让 Mac 上的视频听起来像快进磁带。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_ACTIONS,
  MAX_PENDING,
  RATE_STEPS,
  enqueueControl,
  isAllowedOrigin,
  pruneControls,
  sanitizeControl,
} from '../cast-control.mjs';

test('只放行白名单动作（toggle / play / pause 不带值）', () => {
  for (const action of ['toggle', 'play', 'pause']) {
    assert.deepEqual(sanitizeControl({ action, value: 123 }), { action, value: null });
  }
  assert.deepEqual(sanitizeControl({ action: 'eval' }), null);
  assert.deepEqual(sanitizeControl({ action: 'seek' }), null);
});

test('skip 夹到 ±60 秒，0 秒直接拒绝', () => {
  assert.deepEqual(sanitizeControl({ action: 'skip', value: 5 }), { action: 'skip', value: 5 });
  assert.deepEqual(sanitizeControl({ action: 'skip', value: -5.24 }), { action: 'skip', value: -5.2 });
  assert.deepEqual(sanitizeControl({ action: 'skip', value: 999 }), { action: 'skip', value: 60 });
  assert.deepEqual(sanitizeControl({ action: 'skip', value: -999 }), { action: 'skip', value: -60 });
  assert.equal(sanitizeControl({ action: 'skip', value: 0 }), null);
});

test('rate 夹到 0.25–2 并保留两位', () => {
  assert.deepEqual(sanitizeControl({ action: 'rate', value: 1.5 }), { action: 'rate', value: 1.5 });
  assert.deepEqual(sanitizeControl({ action: 'rate', value: 10 }), { action: 'rate', value: 2 });
  assert.deepEqual(sanitizeControl({ action: 'rate', value: 0 }), { action: 'rate', value: 0.25 });
  assert.deepEqual(sanitizeControl({ action: 'rate', value: 1.234 }), { action: 'rate', value: 1.23 });
  assert.equal(sanitizeControl({ action: 'rate', value: 'fast' }), null);
});

test('垃圾输入一律 null', () => {
  assert.equal(sanitizeControl(null), null);
  assert.equal(sanitizeControl('toggle'), null);
  assert.equal(sanitizeControl({}), null);
  assert.equal(sanitizeControl({ action: 'skip' }), null);
});

test('手机循环的倍速档位都在服务端允许的区间里', () => {
  assert.ok(RATE_STEPS.length >= 3);
  for (const rate of RATE_STEPS) {
    assert.ok(rate >= 0.25 && rate <= 2, `${rate} 超出 0.25–2`);
    assert.deepEqual(sanitizeControl({ action: 'rate', value: rate }), { action: 'rate', value: rate });
  }
  assert.deepEqual(
    [...CONTROL_ACTIONS].sort(),
    ['pause', 'play', 'rate', 'seek', 'skip', 'toggle'],
  );
});

test('seek 夹到 0–86400 秒并保留一位（PLAN 045）', () => {
  assert.deepEqual(sanitizeControl({ action: 'seek', value: 12.34 }), {
    action: 'seek',
    value: 12.3,
  });
  assert.deepEqual(sanitizeControl({ action: 'seek', value: 0 }), { action: 'seek', value: 0 });
  assert.deepEqual(sanitizeControl({ action: 'seek', value: -5 }), { action: 'seek', value: 0 });
  assert.deepEqual(sanitizeControl({ action: 'seek', value: 1e9 }), {
    action: 'seek',
    value: 86400,
  });
  assert.equal(sanitizeControl({ action: 'seek', value: 'ahead' }), null);
});

test('队列超过上限时丢最旧的', () => {
  const pending = [];
  for (let i = 1; i <= MAX_PENDING + 3; i += 1) {
    enqueueControl(pending, { cid: i, action: 'toggle', value: null });
  }
  assert.equal(pending.length, MAX_PENDING);
  assert.equal(pending[0].cid, 4, '前三条被挤掉，留下的是最后 8 条');
  assert.equal(pending.at(-1).cid, MAX_PENDING + 3);
});

test('ack 只清掉已执行的部分，ack=0 保持原样', () => {
  const pending = [
    { cid: 1, action: 'play', value: null },
    { cid: 2, action: 'rate', value: 1.5 },
  ];
  assert.equal(pruneControls(pending, 0), pending, '还没执行过任何一条，队列原样返回');
  assert.deepEqual(pruneControls(pending, 1).map((cmd) => cmd.cid), [2]);
  assert.deepEqual(pruneControls(pending, 2), []);
  assert.deepEqual(pruneControls(pending, 'bad'), pending);
});

/**
 * Origin 白名单（PLAN 046 §12）。
 *
 * 这条用例钉住的是：**公网页面不能访问本机中转站**。旧实现用
 * `allow-origin: *` + `allow-private-network: true`，等于把浏览器对
 * 「公网页面 → 127.0.0.1」的保护主动关掉。
 */
test('Origin 白名单：浏览器真实来源放行，公网站点拒绝', () => {
  // 放行：扩展自身、YouTube 系（内容脚本直连）、手机页面（私有网段/本机）
  for (const origin of [
    'chrome-extension://abcdefghijklmnop',
    'https://www.youtube.com',
    'https://youtube.com',
    'https://m.youtube.com',
    'https://music.youtube.com',
    'https://www.youtube-nocookie.com',
    'http://192.168.1.8:8899',
    'http://10.0.0.12:8899',
    'http://172.16.3.4:8899',
    'http://172.31.255.1:8899',
    'http://localhost:8899',
    'http://127.0.0.1:8899',
    'http://[::1]:8899',
    'http://macbook.local:8899',
  ]) {
    assert.equal(isAllowedOrigin(origin), true, `${origin} 应放行`);
  }

  // 拒绝：公网站点（包括「长得像 IP」的公网地址）、非法值
  for (const origin of [
    'https://evil.example.com',
    'https://192.168.1.8.evil.com',
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://172.15.0.1',
    'null',
    'file://',
    'not a url',
  ]) {
    assert.equal(isAllowedOrigin(origin), false, `${origin} 应拒绝`);
  }

  // 无 Origin：curl / 导航请求。浏览器跨源请求一定带 Origin，
  // 所以「没有」恰恰说明不是被网页驱动的。
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(''), true);
});
