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

test('手机接收页：上下滑动直接改字幕位，不再弹浮层（PLAN 067）', () => {
  const html = renderPage('demo', null);
  assert.ok(!html.includes('id="picker"'), '不再有覆盖式选句浮层');
  assert.ok(!html.includes('picker-rows'), '不再另画五行');
  assert.ok(!html.includes('.picker-card'), '不再有浮层卡片');
  assert.ok(html.includes('id="pick-badge"'), '只留底部一行说明（第几句 / 时间）');
  assert.ok(html.includes("sendControl('seek'"), '松手后发 seek');
  assert.ok(html.includes('onPickStart'), '触摸手势已接线');
  assert.ok(html.includes('function paintPick()'), '候选句写到字幕位');
  assert.ok(html.includes('linePrimary.textContent = primaryText'), '原文沿用 #line-primary');
  assert.ok(html.includes("stageEl.classList.add('picking')"), '字幕板进入选句态');
  assert.ok(/#stage\.picking \.kline/.test(html), '选中态做在原字幕板上');
  assert.ok(/if \(picking\) \{[\s\S]{0,200}?paintControls\(payload\);/.test(html),
    '拖动期间推送只更新控件，不抢字幕文字（PLAN 069 起这里还会停掉换句排程）');
  assert.ok(/applyLineText\(lastPayload\.cur \|\| \{\}\)/.test(html),
    '收起选句时立刻恢复上一帧的实时字幕');
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
  assert.ok(/#reel \{[^}]*margin-bottom: 16px/.test(html), '译文底部外边距 16px（挂在卷轴窗口上）');
});

test('手机接收页：控件横排到顶部，字幕左右不被遮挡（PLAN 063 v5）', () => {
  const html = renderPage('demo', null);
  const controls = /#controls \{[^}]*\}/.exec(html);
  assert.ok(controls, '#controls 样式块存在');
  assert.ok(/flex-direction:\s*row/.test(controls[0]), '按钮横排');
  assert.ok(/left:\s*50%/.test(controls[0]) && /translateX\(-50%\)/.test(controls[0]), '水平居中');
  assert.ok(/top:\s*calc/.test(controls[0]), '贴顶部');
  assert.ok(!/right:\s*max\(12px/.test(controls[0]), '不再贴右边缘挡字幕');

  const stage = /#stage \{[^}]*\}/.exec(html);
  assert.ok(/justify-content:\s*center/.test(stage[0]), '字幕块垂直居中');
  assert.ok(/safe-area-inset-top\) \+ 78px/.test(stage[0]), '顶部给工具条让位');
  assert.ok(html.includes('calc(env(safe-area-inset-bottom) + 32px)'), '底部只给进度条留位');
});

test('手机接收页：倍速按钮只显示数值，一眼可辨（PLAN 063 v6）', () => {
  const html = renderPage('demo', null);
  assert.ok(/#controls #rate \{ width: 64px; \}/.test(html), '倍速按钮固定宽度（且压得过 button 的 48px）');
  assert.ok(/#rate-badge \{[^}]*font-size: 14px/.test(html), '数值 14px');
  const rate = /<button[^>]*id="rate"[\s\S]*?<\/button>/.exec(html);
  assert.ok(rate, '倍速按钮存在');
  assert.ok(!rate[0].includes('<svg'), '不再混用图标');
  assert.ok(rate[0].includes('rate-badge'), '保留数值节点');
});

test('手机接收页：一行放不下时自动缩小字号，不换行（PLAN 063 v6）', () => {
  const html = renderPage('demo', null);
  assert.ok(/#line-primary, #line-secondary \{[^}]*white-space: nowrap/.test(html), '两行都不换行');
  assert.ok(!html.includes('text-wrap: balance'), '删掉两行均衡，避免又折行');
  assert.ok(html.includes('function fitLine(el, minPx)'), '有按实际宽度缩字号的函数');
  assert.ok(html.includes('fitLine(linePrimary, 12)'), '原文下限 12px');
  assert.ok(html.includes('fitLine(lineSecondary, 13)'), '译文上限独立计算');
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

test('手机接收页：换句做在原字幕板上，不复制覆盖层（PLAN 065 v2）', () => {
  const html = renderPage('demo', null);
  assert.ok(!html.includes('function makeGhost'), '不再克隆一层 ghost');
  assert.ok(!html.includes('cloneNode(true)'), '没有任何 DOM 复制');
  assert.ok(html.includes('id="reel"'), '字幕板外套一层卷轴窗口');
  assert.ok(/#reel \{[^}]*overflow: hidden/.test(html), '滚出窗口的部分被裁掉');
  assert.ok(html.includes('function playSwap(cur, dir, duration)'), '在原字幕板上做动画（PLAN 069 起时长由调用方给）');
  assert.ok(html.includes('plateEl.getAnimations()'), '新句到来时先取消未播完的动画');
  assert.ok(html.includes('prefers-reduced-motion: reduce'), '尊重系统的「减少动效」');
  assert.ok(html.includes('translateY('), '用位移表达方向，不用缩放');
});

test('手机接收页：新旧两句在同一窗口里并行滚一格（PLAN 068）', () => {
  const html = renderPage('demo', null);
  const ghost = /#ghost \{([^}]*)\}/.exec(html);
  assert.ok(ghost, '滚出去的那一格有自己的板');
  assert.ok(/position:\s*absolute/.test(ghost[0]), '与 #plate 叠在同一个窗口里');
  assert.ok(html.includes('function movePlateToGhost()'), '旧句是搬过去而不是复制');
  assert.ok(html.includes('replaceChildren(...Array.from(linePrimary.childNodes))'),
    '移动节点，不产生第二份文本');
  assert.equal((html.match(/plateEl\.animate\(/g) || []).length, 1, '新句只从一侧滚入');
  assert.equal((html.match(/ghostEl\.animate\(/g) || []).length, 1, '旧句同时在另一侧滚出');
  assert.ok(!html.includes('duration: 150'), '不再有「旧句滑完、新句才进来」的串行空档');
  assert.ok(html.includes('const SWAP_MS = 260;'), '一次换句 260ms');
  assert.ok(html.includes('function nudgeCtx(dir, duration)'), '上下句跟着轻推一格，不瞬间换字');
});

test('手机接收页：换句按本地时钟排程，不再等推送到达才起跑（PLAN 069）', () => {
  const html = renderPage('demo', null);
  // 协议：帧里带 sentAt（延迟估计）与 plan（未来句时间表）
  assert.ok(html.includes('function updateFrameClock(payload, now, arrivalWall)'),
    '用 sentAt 还原取样时刻');
  assert.ok(html.includes('function localAt(videoTime)'), '视频时间能换算成本地时钟');
  assert.ok(html.includes('function planSwap(payload, now)'), '按 plan 排下一个换句点');
  assert.ok(html.includes('function tickSwap(now)'), '到点由 rAF 起跑');
  assert.ok(html.includes('swapCtl.bias'), '用实到帧校准固定偏差');
  assert.ok(html.includes('const SWAP_BIAS_ALPHA = 0.3;'), '偏差平滑');
  assert.ok(html.includes('const LATENCY_WINDOW = 20;'), '单程延迟取滑动最小样本');

  // 动画时长按「距下一句还有多久」收缩，快句不再硬切
  assert.ok(html.includes('const SWAP_MIN_MS = 140;'), '收缩下限');
  assert.ok(html.includes('const SWAP_CUT_MS = 80;'), '只有来不及表达方向才硬切');
  assert.ok(!html.includes('performance.now() - lastSwapAt > 220'), '删掉 220ms 硬切门限');
  assert.ok(!html.includes('lastSwapAt'), '「多久没换句」这个判据整个删除');

  // 排程寄生在既有 rAF 里，不新增循环
  assert.ok(/tickSwap\(now\);\s*\n\s*requestAnimationFrame\(paintProgress\);/.test(html),
    '到点检查挂在 paintProgress 的循环上');

  // 同一句的实到帧只补内容，不滚第二次
  assert.ok(html.includes('alreadyShown'), '排程与实到帧按 cue.start 去重');
  assert.ok(html.includes('reelEl.style.height'), '动画期间窗口高度钉住，避免新句更高时露空档');
});

test('手机接收页：用 RTT 测时钟差，首帧就对齐（PLAN 075）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('async function syncClock()'), '主动测一次 RTT');
  assert.ok(html.includes("fetch('/ping', { cache: 'no-store' })"), '打服务端时间戳');
  assert.ok(html.includes('clockSync.offset = data.at + rtt / 2 - t1;'),
    'offset 取服务端墙钟减手机墙钟');
  assert.ok(html.includes("setInterval(syncClock, 30000);"), '周期性复测');
  assert.ok(html.includes('clockSync.offset : arrivalWall'), '有偏移就先对齐再取最小');
  assert.ok(html.includes('swapCtl.seeded'), '偏差用最小单程延迟播种，不再从 0 学');
});

test('手机接收页：只对官方时间轴的句子提前起跑（PLAN 073）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('if (next.official !== true) return;'),
    '采样句不排程，退回实到帧驱动');
});

test('手机接收页：断流时用整条轨继续换句（PLAN 072）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('function mergeTrack(chunk)'), '分块拼整轨');
  assert.ok(html.includes('function trackCueAt(seconds)'), '按视频时间在整轨里定位');
  assert.ok(html.includes('const STALE_STREAM_MS = 1200;'), '断流判据');
  assert.ok(html.includes('function tickTrackSwap(now)'), '断流期间由 rAF 驱动换句');
  assert.ok(/tickSwap\(now\);\s*\n\s*requestAnimationFrame\(paintProgress\);/.test(html),
    '兜底仍挂在既有循环上');
  assert.ok(html.includes("if (ver !== trackStore.ver || total !== trackStore.total)"),
    '版本变了整份作废，不跨版本拼时间轴');
});

test('手机接收页：静态块只在变化时传，其余帧用缓存补齐（PLAN 071）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes("const STATIC_FIELDS = ['cur', 'prev', 'next', 'cues', 'plan', 'style'];"),
    '静态字段清单与扩展侧一一对应');
  assert.ok(html.includes('if (payload.static && typeof payload.static === \'object\') staticBlock = payload.static;'),
    '收到静态块就换缓存');
  assert.ok(html.includes('payload[name] === undefined'), '缺字段的帧从缓存补，不把字幕清空');
});

test('手机接收页：缓冲期间冻结本地时钟（PLAN 070）', () => {
  const html = renderPage('demo', null);
  // 排程时钟与两条进度都走同一个派生值
  assert.ok(html.includes('payload.playing !== false && payload.stalled !== true'),
    'playing 与 stalled 合起来才算「在播」');
  assert.equal(
    html.split('payload.playing !== false && payload.stalled !== true').length - 1, 2,
    '排程时钟与进度时钟都要看 stalled，不能只改一处',
  );
});

test('手机接收页：上下文行的中文不会闪没（PLAN 066）', () => {
  const html = renderPage('demo', null);
  assert.ok(html.includes('const ctxMemo'), '同一句的译文有粘性');
  assert.ok(html.includes('primary === memo.primary && !secondary'), '只在换句时允许清空译文');
  assert.ok(html.includes('260'), '整块延迟收起，避免换句空帧把行藏起来');
  assert.ok(html.includes("'prev'") && html.includes("'next'"), '两个槽位各自记忆');
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
