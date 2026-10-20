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

test('手机接收页：排版按 36/24/20/18 的规格分层（PLAN 063）', () => {
  const html = renderPage('demo', null);
  assert.ok(
    html.includes('const TYPE_SPEC = {"primary":36,"secondary":24,"context":20,"ruby":18};'),
    '规格值以 100% 档位注入，其余档位等比缩放',
  );
  assert.ok(/#line-primary \{[^}]*line-height: 1\.6/.test(html), '主字幕行高 1.6');
  assert.ok(/#line-secondary \{[^}]*margin-top: 8px/.test(html), '译文与原文间距 8px');
  assert.ok(/#prev \{ margin-bottom: 12px; \}/.test(html), '上文与主字幕间距 12px');
  assert.ok(/#plate \{[^}]*margin-bottom: 16px/.test(html), '译文底部外边距 16px');
});

test('手机接收页：控制条竖排贴右侧，底部只留进度条（PLAN 063 v2）', () => {
  const html = renderPage('demo', null);
  const controls = /#controls \{[^}]*\}/.exec(html);
  assert.ok(controls, '#controls 样式块存在');
  assert.ok(/flex-direction:\s*column/.test(controls[0]), '按钮竖排');
  assert.ok(/right:\s*max\(12px/.test(controls[0]), '贴右边缘');
  assert.ok(/bottom:\s*calc/.test(controls[0]), '靠右下，避开居中的字幕块');
  assert.ok(!/left:\s*50%/.test(controls[0]), '不再在底部水平居中');

  const stage = /#stage \{[^}]*\}/.exec(html);
  assert.ok(/justify-content:\s*center/.test(stage[0]), '字幕块垂直居中');
  assert.ok(html.includes('calc(env(safe-area-inset-bottom) + 24px)'), '底部只给进度条留位');
});

test('手机接收页：全部控件收在一个竖排图标组里（PLAN 063 v4）', () => {
  const html = renderPage('demo', null);
  const block = /<div id="controls">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(block, '控制组存在');
  for (const id of ['gear', 'playpause', 'rate']) {
    assert.ok(block[1].includes('id="' + id + '"'), id + ' 在控制组内');
  }
  assert.equal((html.match(/id="gear"/g) || []).length, 1, '齿轮只在控制组内出现一次');
  assert.ok(!/#gear \{[^}]*position:\s*fixed/.test(html), '齿轮不再单独固定在角落');
  assert.ok(!html.includes('−5s') && !html.includes('+5s'), '回退 / 快进不再用文字');
  assert.equal((block[1].match(/data-cmd="skip"/g) || []).length, 2, '回退与快进各一个图标按钮');
  assert.ok(block[1].includes('rate-badge'), '倍速保留数值角标');
});

test('手机接收页：图标全部用 SVG，不出现 emoji 或符号字符（PLAN 063 v2）', () => {
  const html = renderPage('demo', null);
  for (const ch of ['⚙', '▶', '❚', '⤴', '✓', '✗']) {
    assert.ok(!html.includes(ch), `不应出现字符 ${ch}`);
  }
  assert.ok(/id="gear"[\s\S]*?<svg/.test(html), '齿轮用内联 SVG');
  assert.ok(/id="playpause"[\s\S]*?<svg/.test(html), '播放按钮用内联 SVG');
});

test('手机接收页：句内进度只铺在日语原文背后（PLAN 063 v3）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('id="fill-primary"'), '原文行有句内进度');
  assert.ok(!html.includes('id="fill-secondary"'), '译文行不铺进度');
  assert.ok(!html.includes('llg-sep'), '竖线分隔符已移除');
  assert.ok(html.includes('.llg-seg'), '文节之间改用 6px 微弱间距');
  assert.ok(/#line-primary rt \{[^}]*padding-bottom: 4px/.test(html), '注音与汉字间距 4px');
});

test('手机接收页：译文用冷色与原文区分（PLAN 063 v3）', () => {
  const html = renderPage('demo', null);
  assert.ok(
    html.includes('const SECONDARY_COLOR = "rgba(168, 199, 250, .88)";'),
    '译文颜色固定为冷色，不跟随原文颜色',
  );
  assert.ok(html.includes('secondaryColor = SECONDARY_COLOR'), '译文不再取原文颜色');
});

test('手机接收页：设置面板里的滑动不再触发选句（PLAN 064）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('let pickBlocked = false'), '有「本段手势被屏蔽」标记');
  assert.ok(html.includes("closest('#controls, #gear, #sheet')"), '面板 / 控制条内的触摸被识别');
  assert.ok(/function onPickMove\(ev\) \{\s*if \(pickBlocked\) return;/.test(html),
    'touchmove 同样屏蔽（它读的是上一次的起点）');
  assert.ok(/function onPickEnd\(\) \{\s*if \(pickBlocked\)/.test(html),
    'touchcancel / touchend 清标记且不 seek');
});

test('手机接收页：分词组默认显示，可在设置里关掉（PLAN 064）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('data-pref="seg"'), '设置里有分词开关');
  assert.ok(html.includes('seg: value.seg !== false'), '没有存过时默认显示');
  assert.ok(html.includes('.kline.no-seg .llg-seg'), '关掉只去掉段间距');
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
