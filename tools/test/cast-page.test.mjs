/**
 * 手机字幕屏接收页（tools/cast-page.mjs）的静态回归。
 *
 * 页面是「一段 HTML 字符串」，Node 侧能测的只有生成出来的结构与样式口径；
 * 真机上的合成 / 掉帧测不了（见 PLAN 041 的「未实测」一节）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPage } from '../cast-page.mjs';

test('手机接收页：底板不带 backdrop-filter（纯色背景上只会拖慢句内进度）', () => {
  const html = renderPage('demo', null);
  assert.ok(
    !html.includes('backdrop-filter'),
    'PLAN 041：模糊在纯色背景上没有视觉效果，却会让 .kfill 每帧重栅格化',
  );
});

test('手机接收页：两条进度都用 transform 驱动，不靠 transition: width', () => {
  const html = renderPage('demo', null);
  // .kfill 与 #progress-fill 的初始态（之后由 paintProgress() 每帧改 scaleX）
  assert.ok(html.includes('transform: scaleX(0)'), '进度条初始为 scaleX(0)');
  assert.ok(html.includes('will-change: transform'), '给合成器提示');
  assert.ok(!/transition:\s*width/.test(html), '宽度过渡每帧触发布局，不能再用');
});

test('手机接收页：设置项的进度条开关仍然生效', () => {
  const html = renderPage('demo', { bar: false });
  assert.ok(html.includes('"bar":false'), '服务端注入的偏好要带进页面');
});

test('手机接收页：控制条与齿轮常驻，不再依赖点画面浮出（PLAN 044）', () => {
  const html = renderPage('demo', null);
  assert.ok(!html.includes('showChrome'), '不再有「点画面唤出」的定时收起逻辑');
  assert.ok(!/#controls\s*\{[^}]*opacity:\s*0/.test(html), '控制条不能默认隐藏');
  assert.ok(!/#gear\s*\{[^}]*opacity:\s*0/.test(html), '齿轮不能默认隐藏');
});

test('手机接收页：整片进度条加粗到 5px（3px 在真机上看不见）', () => {
  const html = renderPage('demo', null);
  assert.ok(/#progress\s*\{[^}]*height:\s*5px/.test(html), 'PLAN 044：轨道加粗');
  assert.ok(/#progress\s*\{[^}]*z-index:\s*21/.test(html), '进度条不能被控制条遮住');
});

test('手机接收页：进度填充是块级（行内元素上的 scaleX 不产生任何渲染）', () => {
  const html = renderPage('demo', null);
  const fill = /#progress-fill\s*\{[^}]*\}/.exec(html);
  assert.ok(fill, '#progress-fill 的样式块存在');
  assert.ok(/display:\s*block/.test(fill[0]), 'PLAN 045：<i> 默认 inline，必须块级化');
  assert.ok(/position:\s*absolute/.test(fill[0]), '绝对定位后 inset 才撑满轨道');
});

test('手机接收页：上滑选句浮层存在，并发 seek 命令（PLAN 045）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('id="picker"'), '选句浮层');
  assert.ok(html.includes('picker-rows'), '只画 ±2 行');
  assert.ok(html.includes("sendControl('seek'"), '松手后发 seek');
  assert.ok(html.includes('onPickStart'), '触摸手势已接线');
});

test('手机接收页：句内进度按画面换句重置，不被时间轴的 0 拽回去（PLAN 062）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('cueClock.text'), '换句依据是画面文本，不是时间轴句');
  assert.ok(html.includes('progress == null'), '缺失进度（不可信）时保持本地推进');
  assert.ok(html.includes('const rawProgress = payload.progress'), 'null 不能被折成 0');
});

test('手机接收页：控制条有播放/暂停、±5 秒、倍速四个按钮（PLAN 042）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('id="controls"'), '控制条存在');
  assert.ok(html.includes('data-cmd="toggle"'), '播放/暂停');
  assert.ok(html.includes('data-cmd="skip" data-v="-5"'), '快退 5 秒');
  assert.ok(html.includes('data-cmd="skip" data-v="5"'), '快进 5 秒');
  assert.ok(html.includes('data-cmd="rate"'), '倍速');
  // 档位由 cast-control.mjs 注入，页面上不再各自写一份
  assert.ok(html.includes('const RATE_STEPS = [0.75,1,1.25,1.5,2];'), '倍速档位来自唯一定义');
  assert.ok(html.includes("fetch('/control?room='"), '命令要发回服务端');
});
