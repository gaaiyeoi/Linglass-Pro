/**
 * 手机字幕屏 —— 接收页
 *
 * 排版按 PLAN 063 的手机屏规格分层（100% 档位）：
 *
 *   上文预览  20px / 40% 白 / 1.4 / 与主字幕间距 12px
 *   当前原文  36px / 600 / 1.6 / #FFFFFF
 *   假名注音  18px / 80% 白 / 悬在汉字正上方，间距 4px
 *   主译文    24px / 400 / 85% 白 / 上 8px、下 16px
 *   下文预览  20px / 40% 白 / 1.4
 *
 * 无底板、无句内进度底色、无竖线分隔符：文节之间只用 6px 间距分层，
 * 剩下的层级全部由字号、字重与透明度表达（style 预设仍决定字体栈与描边）。
 * 字号档位 50–150% 在这套规格上等比缩放。
 *
 * 布局（PLAN 063 v2）：字幕块垂直居中；播放控制竖排贴右侧下方，
 * 齿轮在右上、连接状态在左上；底部只留整片进度条，因此字幕不再被控件顶上去。
 * 界面里的图标一律用内联 SVG，不使用任何 emoji 或依赖字体的符号字符。
 *
 * 与浮窗的差别：
 *   1. 控制条只有播放/暂停、±5 秒、倍速（PLAN 042）：命令发回 cast-server，
 *      由扩展在自己的下一次 /push 里取走并操作 Mac 上的 video。手机上不画进度条拖拽；
 *   2. 上下文行的「点一句跳转」没有（跨设备跳不了）。
 *
 * 页面完全内联：手机端不发任何外部请求，断网时也不会卡在加载样式表。
 */
import { RATE_STEPS } from './cast-control.mjs';

/** 官方 f.classic.font 等字体栈（与 30-desktop-subtitles.js 保持一致） */
const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_COMIC_LATIN = '"Trebuchet MS", "Segoe UI", Verdana, system-ui, sans-serif';
const FONT_COMIC_JA = '"Hiragino Maru Gothic ProN", "Hiragino Maru Gothic", "Yu Gothic",'
  + ' YuGothic, Meiryo, sans-serif';

/** 官方 C：comic 预设把这几种语言的字面换成手写体 */
const COMIC_LANGS = [
  'en', 'de', 'fr', 'es', 'it', 'pt-BR', 'pt-PT', 'nl', 'sv', 'pl', 'cs', 'tr', 'id', 'ru', 'uk',
];

/**
 * 官方四套预设（settings-*.js 的 f），这里只取手机屏仍用得上的部分：
 * 描边 / 阴影 / 字距。字号、字重、行高由 PLAN 063 的规格统一决定，
 * 底板也不再画（见 appearanceCss 的注释）。
 */
const STYLE_SPECS = {
  classic: { outlineEm: 0, shadow: 'plate', letterSpacingEm: 0 },
  cinema: { outlineEm: .055, shadow: 'depth', letterSpacingEm: .004 },
  comic: { outlineEm: .085, shadow: 'offset', letterSpacingEm: .008 },
  contrast: { outlineEm: 0, shadow: 'none', letterSpacingEm: 0 },
};

const STYLE_CHOICES = ['classic', 'cinema', 'comic', 'contrast'];
const STYLE_LABELS = { classic: '经典', cinema: '影院', comic: '漫画', contrast: '高对比' };
const COLOR_PRESETS = ['#FFFFFF', '#FFD60A', '#64D2FF', '#30D158'];

/**
 * 官方面板里四个样式瓷砖的示意图（30-desktop-subtitles.js 的 STYLE_ICONS，一字未改）。
 * 手机上面板要和浮窗面板长得一样，这四张图就是「一样」最直观的那部分。
 */
const STYLE_ICONS = {
  classic: '<path fill-rule="evenodd" fill="currentColor" d="M5.5,5.5h13a3,3 0 0 1 3,3v7a3,3 0 0 1 -3,3h-13a3,3 0 0 1 -3,-3v-7a3,3 0 0 1 3,-3zM6,9.3h12v2h-12zM8,13.2h8v2h-8z"/>',
  cinema: '<path fill="none" stroke="currentColor" stroke-width="1.7" d="M5.8,8.2h12.4a2.1,2.1 0 0 1 2.1,2.1v0a2.1,2.1 0 0 1 -2.1,2.1h-12.4a2.1,2.1 0 0 1 -2.1,-2.1v0a2.1,2.1 0 0 1 2.1,-2.1z"/><path fill="none" stroke="currentColor" stroke-width="1.7" d="M8.6,14.6h6.8a1.7,1.7 0 0 1 1.7,1.7v0a1.7,1.7 0 0 1 -1.7,1.7h-6.8a1.7,1.7 0 0 1 -1.7,-1.7v0a1.7,1.7 0 0 1 1.7,-1.7z"/>',
  comic: '<path fill="currentColor" opacity="0.34" d="M7.4,9.1h12.4a2.5,2.5 0 0 1 2.5,2.5v0.1a2.5,2.5 0 0 1 -2.5,2.5h-12.4a2.5,2.5 0 0 1 -2.5,-2.5v-0.1a2.5,2.5 0 0 1 2.5,-2.5z"/><path fill="currentColor" opacity="0.34" d="M10.4,16.6h6.4a2.1,2.1 0 0 1 2.1,2.1v0.1a2.1,2.1 0 0 1 -2.1,2.1h-6.4a2.1,2.1 0 0 1 -2.1,-2.1v-0.1a2.1,2.1 0 0 1 2.1,-2.1z"/><path fill="currentColor" d="M4.8,6.7h12.4a2.5,2.5 0 0 1 2.5,2.5v0.1a2.5,2.5 0 0 1 -2.5,2.5h-12.4a2.5,2.5 0 0 1 -2.5,-2.5v-0.1a2.5,2.5 0 0 1 2.5,-2.5z"/><path fill="currentColor" d="M7.8,14.2h6.4a2.1,2.1 0 0 1 2.1,2.1v0.1a2.1,2.1 0 0 1 -2.1,2.1h-6.4a2.1,2.1 0 0 1 -2.1,-2.1v-0.1a2.1,2.1 0 0 1 2.1,-2.1z"/>',
  contrast: '<path fill-rule="evenodd" fill="currentColor" d="M4.7,5.9h14.6a2.2,2.2 0 0 1 2.2,2.2v2.2a2.2,2.2 0 0 1 -2.2,2.2h-14.6a2.2,2.2 0 0 1 -2.2,-2.2v-2.2a2.2,2.2 0 0 1 2.2,-2.2zM5.6,8.3h12.8v1.9h-12.8zM8.2,14.3h7.6a2,2 0 0 1 2,2v1.8a2,2 0 0 1 -2,2h-7.6a2,2 0 0 1 -2,-2v-1.8a2,2 0 0 1 2,-2zM8.7,16.4h6.6v1.7h-6.6z"/>',
};
const COLOR_NAMES = { '#FFFFFF': '白色', '#FFD60A': '黄色', '#64D2FF': '青色', '#30D158': '绿色' };

/**
 * 手机屏排版规格（PLAN 063）：100% 档位下的像素值，档位 50–150% 等比缩放。
 * 注音单独一档：它比原文小一半，但仍要在线宽屏上看得清。
 */
const TYPE_SPEC = {
  primary: 36,
  secondary: 24,
  context: 20,
  ruby: 18,
};

/** 字号下限：档位调到 50% 时仍不能小到无法阅读 */
const MIN_FONT_PX = 11;

/**
 * 主译文固定用冷色（PLAN 063 v3）：原文是纯白 + 600，译文是同色系的浅蓝 + 400，
 * 字号也小一档。三种差异叠在一起，扫一眼就能分清「哪行是日语、哪行是翻译」。
 * 不跟随设置里的原文颜色：跟随之后两者又变成同一个色相，区分度就没了。
 */
const SECONDARY_COLOR = 'rgba(168, 199, 250, .88)';

/**
 * 文节之间的间距（替代原来的竖线分隔符）。
 * 6px 在 36px 的原文里几乎看不出来（只相当于字宽的 1/6），调到 10px 才能一眼分出词组。
 */
const SEGMENT_GAP_PX = 10;

export function renderPage(room, bootPrefs) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#141518">
<!-- 三个 apple-* 标签合起来才是「从主屏打开时没有地址栏 / 标签栏」：
     Safari 里直接访问永远有浏览器 UI，iOS 也不支持网页调用 requestFullscreen。
     所以唯一可行的全屏方式就是「添加到主屏幕」后以 standalone 模式启动。 -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="字幕屏">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="/manifest.webmanifest?room=${encodeURIComponent(room)}">
<title>字幕屏</title>
<style>
  /* 骨架照抄浮窗：深灰蓝而不是纯黑（与 30-desktop-subtitles.js 的 PIP_BASE_CSS 同值） */
  /* 左右留白 12px：36px 的原文一行能多放近一个字，长句更容易只断成两行 */
  :root { color-scheme: dark; --radius-sm: 8px; --pad: max(12px, env(safe-area-inset-left)); }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%; background: #141518; overflow: hidden;
    -webkit-text-size-adjust: 100%; -webkit-font-smoothing: antialiased;
    color: #fff;
  }
  #stage {
    position: fixed; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    /* 行间距全部由各行的 margin 精确控制（PLAN 063） */
    gap: 0;
    /* 控制条已挪到右侧竖排，底部只剩一条 5px 进度条：留 24px 即可。
       上下留白接近对称，字幕块因此落在画面正中，不再被控件顶上去（PLAN 063 v2） */
    padding: calc(env(safe-area-inset-top) + 8px) var(--pad)
             calc(env(safe-area-inset-bottom) + 24px);
  }
  /* 上下文行：整段一起淡到 40%，字号与颜色由 appearanceCss 给（13px） */
  .ctx {
    display: flex; flex-direction: column; align-items: center;
    max-width: 100%;
  }
  /* 上文与主字幕之间 12px */
  #prev { margin-bottom: 12px; }
  .ctx-line {
    display: block; line-height: 1.4; text-align: center; white-space: pre-wrap;
    max-width: 100%;
  }
  #plate {
    display: flex; flex-direction: column; align-items: center;
    box-sizing: border-box; max-width: 100%;
    /* 主译文的底部外边距：单语（译文隐藏）时它仍把主字幕与下文预览隔开 */
    margin-bottom: 16px;
  }
  /* 句内进度只铺在日语原文背后（PLAN 063 v3）：极淡的蓝，不抢文字；
     译文行不铺，避免两行各有一条进度、看起来像两个播放位置。 */
  /* max-content：短句时进度块贴合文字宽度；长句换行后受 max-width 限制，变成整行宽 */
  .kline { position: relative; display: inline-block; width: max-content; max-width: 100%; }
  .kfill {
    position: absolute; left: 0; top: 0; bottom: 0; width: 100%;
    border-radius: 6px; background: rgba(10, 132, 255, .13);
    transform: scaleX(0); transform-origin: left center;
    will-change: transform;
  }
  #line-primary, #line-secondary {
    position: relative; display: block;
    text-align: center; white-space: pre-wrap;
    max-width: 100%;
  }
  /* 压在填充之上：kfill 是绝对定位，默认画在普通流后面 */
  #line-primary { z-index: 1; }
  /* balance 只在放得下两行时生效（Safari 17.5+）：避免长句末尾只剩一个字独占一行 */
  #line-primary { line-height: 1.6; text-wrap: balance; }
  /* 带注音的行需要额外行距：rt 悬在基字上方，自身不撑开行盒，
     只按 1.6 会给上一行让出 0 像素，注音直接压到上一行（真机实测）。 */
  #line-primary:has(ruby) { line-height: 2; }
  /* 主译文：与原文 8px、与下文预览 16px（后者落在 #plate 上） */
  #line-secondary { line-height: 1.5; margin-top: 8px; }
  /* 注音：12px（appearanceCss 按档位算）/ 80% 白；抬到汉字正上方并留 4px 间距 */
  #line-primary rt {
    font-weight: 400; letter-spacing: 0;
    color: rgba(255, 255, 255, .8);
    line-height: 1.2;
    padding-bottom: 4px;
  }
  /* 文节之间只用微弱间距，不画竖线（PLAN 063）；「分词 → 隐藏」时归零（PLAN 064） */
  .llg-seg { display: inline; }
  .llg-seg:not(:last-child) { margin-right: ${SEGMENT_GAP_PX}px; }
  .kline.no-seg .llg-seg:not(:last-child) { margin-right: 0; }

  /* 空态：与浮窗同一句文案 */
  #stage.empty::before {
    content: "— 等待 Linglass 字幕 —";
    font-size: 15px; font-weight: 400; color: #7a7a80; letter-spacing: .04em;
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  }
  #stage.empty > * { visibility: hidden; }

  /* 整片进度条：形状照抄浮窗，但真机上 3px + 12% 白的轨道几乎不可见（PLAN 044），
     所以加粗到 5px、轨道提到 20%、并上移到 home indicator 之外。 */
  #progress {
    position: fixed; left: var(--pad); right: var(--pad);
    bottom: calc(env(safe-area-inset-bottom) + 18px);
    height: 5px; border-radius: 999px;
    background: rgba(255, 255, 255, .2);
    overflow: hidden;
    z-index: 21;
  }
  #progress.off { display: none; }
  /* 这里是 <i>，默认 display:inline —— 行内元素的 width/height/transform 全部不生效，
     从 PLAN 038 起那条白条就一直没被画出来过（PLAN 045 定位到）。必须块级化。 */
  #progress-fill {
    display: block; position: absolute; inset: 0;
    border-radius: inherit;
    background: #fff; box-shadow: 0 0 6px rgba(255, 255, 255, .4);
    transform: scaleX(0); transform-origin: left center;
    will-change: transform;
  }

  /* 状态挪到左上：右上让给常驻的齿轮（控制条已改为右侧竖排，见 PLAN 063 v2） */
  #status {
    position: fixed; top: calc(env(safe-area-inset-top) + 8px);
    left: var(--pad);
    font-size: 12px; color: #7a7a80; letter-spacing: .02em;
    display: flex; align-items: center; gap: 6px;
  }
  #dot { width: 6px; height: 6px; border-radius: 50%; background: #4b5563; }
  #status.on #dot { background: #30d158; }
  #status.off { color: #f87171; }
  #status.off #dot { background: #f87171; }

  /* 播放控制条：常驻（PLAN 044），v2 改为贴右侧竖排（PLAN 063 v2）。
     竖排放在右下方，避开垂直居中的字幕块；底部只留整片进度条，
     字幕因此不再被控件顶到画面上半部。 */
  #controls {
    position: fixed; right: max(12px, env(safe-area-inset-right));
    bottom: calc(env(safe-area-inset-bottom) + 40px);
    display: flex; flex-direction: column; align-items: stretch; gap: 4px;
    padding: 4px; border-radius: 20px;
    background: rgba(24, 24, 27, .92); border: 1px solid rgba(255, 255, 255, .12);
    z-index: 20;
  }
  #controls button {
    background: none; border: 0; color: #e5e7eb;
    width: 52px; height: 38px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 16px; font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  #controls button svg { width: 18px; height: 18px; }
  #controls button:active { background: rgba(255, 255, 255, .14); }
  /* 图标按钮之间用细分隔线分组：设置 / 回退·播放·快进 / 倍速 */
  #controls .group-sep {
    height: 1px; margin: 2px 8px;
    background: rgba(255, 255, 255, .12);
  }

  /* 选句浮层（PLAN 045）：上滑打开，中间那行是「松手要跳到的句子」。
     只画 ±2 行 —— 手机屏幕小，五行刚好够看出上下文，又不会盖满整屏。 */
  #picker {
    position: fixed; inset: 0; z-index: 40;
    display: flex; align-items: center; justify-content: center;
    background: rgba(10, 11, 13, .76);
    opacity: 0; pointer-events: none;
    transition: opacity .18s ease;
  }
  #picker.open { opacity: 1; pointer-events: auto; }
  .picker-card { width: min(88vw, 620px); text-align: center; }
  .picker-tip {
    font-size: 12px; color: rgba(255, 255, 255, .5);
    letter-spacing: .04em; margin-bottom: 10px;
  }
  .picker-rows { display: flex; flex-direction: column; gap: 6px; }
  .picker-row {
    font-size: 16px; line-height: 1.35; color: rgba(255, 255, 255, .3);
    padding: 6px 10px; border-radius: 8px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-height: 30px;
  }
  .picker-row.center {
    font-size: 21px; color: #fff; font-weight: 600;
    white-space: normal;
    background: rgba(10, 132, 255, .18);
    box-shadow: inset 0 0 0 1px rgba(10, 132, 255, .5);
  }
  .picker-time {
    margin-top: 10px; font-size: 12px; color: rgba(255, 255, 255, .45);
    font-variant-numeric: tabular-nums;
  }

  /* 倍速：图标 + 右下角小数值。倍速是数值，纯图标看不出当前档位，
     所以保留一个 9px 的角标，其余按钮一律只有图标。 */
  #rate { position: relative; }
  #rate-badge {
    position: absolute; right: 5px; bottom: 3px;
    font-size: 9px; line-height: 1; color: #64d2ff;
    letter-spacing: .02em;
  }

  /* 设置面板：视觉语言照抄 Linglass 自己的面板（30-desktop-subtitles.js 的 PIP_PANEL_CSS）：
     44px 行高、细分割线、11px 分区标题、样式瓷砖用官方那四张示意图 */
  #sheet {
    position: fixed; left: 0; right: 0; bottom: 0;
    max-height: 92dvh; overflow-y: auto;
    background: rgba(18, 19, 22, .985);
    border-top: 1px solid rgba(255, 255, 255, .12);
    border-radius: 16px 16px 0 0;
    padding: 10px max(16px, env(safe-area-inset-left))
             calc(env(safe-area-inset-bottom) + 10px);
    display: flex; flex-direction: column;
    transform: translateY(101%); transition: transform .22s ease;
    z-index: 30;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
  }
  #sheet.open { transform: translateY(0); }
  .sheet-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 2px 2px 8px;
  }
  .sheet-head span { font-size: 15px; font-weight: 600; color: #fff; }
  .sheet-head button {
    background: none; border: 0; color: #0a84ff; font-size: 15px; padding: 4px 2px;
  }
  .sec-label {
    font-size: 11px; letter-spacing: .06em; color: rgba(255, 255, 255, .45);
    margin: 10px 2px 6px;
  }
  .row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; min-height: 44px;
    font-size: 14px; color: #e5e7eb;
    border-bottom: 1px solid rgba(255, 255, 255, .06);
  }
  .row:last-of-type { border-bottom: 0; }

  /* 样式瓷砖：与官方面板同一尺寸比例（46px 图 + 11px 说明） */
  .style-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .style-btn {
    padding: 0; border: 0; background: none; color: #e5e7eb;
    display: flex; flex-direction: column; align-items: center; gap: 5px;
  }
  .style-btn__art {
    width: 100%; height: 48px; border-radius: 10px;
    background: rgba(255, 255, 255, .08);
    display: flex; align-items: center; justify-content: center;
  }
  .style-btn__art svg { width: 26px; height: 26px; }
  .style-btn.active .style-btn__art { box-shadow: inset 0 0 0 2px #0a84ff; }
  .style-btn.active { color: #fff; }
  .style-btn__cap { font-size: 11px; opacity: .75; }

  .seg { display: flex; gap: 6px; }
  .seg button, .stepper button {
    background: rgba(255, 255, 255, .08); color: #d1d5db;
    border: 0; border-radius: 8px; padding: 6px 11px; font-size: 13px;
    min-width: 38px;
  }
  .seg button.active { background: #0a84ff; color: #fff; font-weight: 600; }
  .stepper { display: flex; align-items: center; gap: 2px;
    background: rgba(255, 255, 255, .08); border-radius: 9px; padding: 2px; }
  .stepper button { background: none; min-width: 34px; padding: 5px 0; font-size: 16px; }
  .stepper button:active { background: rgba(255, 255, 255, .12); }
  .stepper .value {
    min-width: 52px; text-align: center; font-variant-numeric: tabular-nums;
    color: #fff; font-size: 13px;
  }
  .swatch {
    width: 26px; height: 26px; border-radius: 50%; padding: 0;
    border: 2px solid transparent;
  }
  .swatch.active { border-color: #fff; box-shadow: 0 0 0 2px rgba(255, 255, 255, .25); }

  /* 只在 Safari 里直接打开（非 standalone）时出现：教一次怎么去掉地址栏 */
  #install {
    position: fixed; left: 50%; transform: translateX(-50%);
    top: calc(env(safe-area-inset-top) + 34px);
    width: min(92vw, 520px);
    background: rgba(24, 24, 27, .94);
    border: 1px solid rgba(255, 255, 255, .12);
    border-radius: 12px; padding: 10px 12px;
    font-size: 13px; line-height: 1.5; color: #e5e7eb;
    display: flex; align-items: center; gap: 10px;
    transition: opacity .35s ease, transform .35s ease;
    z-index: 10;
  }
  #install.gone { opacity: 0; transform: translateX(-50%) translateY(-8px); pointer-events: none; }
  #install .share { flex: none; opacity: .9; }
  #install .share svg { width: 18px; height: 18px; display: block; }
  #install .body { flex: 1; }
  #install b { color: #fff; font-weight: 600; }
  #install button {
    flex: none; background: rgba(255, 255, 255, .1); color: #e5e7eb;
    border: 0; border-radius: 8px; padding: 5px 10px; font-size: 12px;
  }
  #hint {
    display: none; position: fixed; left: 50%; transform: translateX(-50%);
    bottom: calc(env(safe-area-inset-bottom) + 108px);
    font-size: 12px; color: #4b5563; letter-spacing: .08em;
    z-index: 9;
  }
  @media (orientation: portrait) { #hint { display: block; } }
  .hidden { display: none !important; }
</style>
<style id="appearance"></style>
</head>
<body>
<div id="stage" class="empty">
  <div id="prev" class="ctx hidden">
    <div class="ctx-line" id="prev-primary"></div>
    <div class="ctx-line" id="prev-secondary"></div>
  </div>
  <div id="plate">
    <div class="kline">
      <i class="kfill" id="fill-primary"></i>
      <div id="line-primary"></div>
    </div>
    <div id="line-secondary"></div>
  </div>
  <div id="next" class="ctx hidden">
    <div class="ctx-line" id="next-primary"></div>
    <div class="ctx-line" id="next-secondary"></div>
  </div>
</div>
<div id="progress"><i id="progress-fill"></i></div>
<div id="status"><i id="dot"></i><span id="status-text">连接中…</span></div>
<div id="picker" aria-hidden="true">
  <div class="picker-card">
    <div class="picker-tip">上下滑动选句 · 松手跳到该句</div>
    <div class="picker-rows" id="picker-rows"></div>
    <div class="picker-time" id="picker-time"></div>
  </div>
</div>
<div id="controls">
  <button id="gear" type="button" aria-label="设置">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M19.14 12.94a7.07 7.07 0 0 0 .06-.94 7.07 7.07 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.3 7.3 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96a7.3 7.3 0 0 0 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7.3 7.3 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"/>
    </svg>
  </button>
  <span class="group-sep"></span>
  <button type="button" data-cmd="skip" data-v="-5" aria-label="快退 5 秒">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 2.35-5.66"/>
      <path d="M4 4.4V9h4.6"/>
      <text x="12" y="15.6" text-anchor="middle" font-size="8.4" stroke="none"
        fill="currentColor">5</text>
    </svg>
  </button>
  <button type="button" id="playpause" data-cmd="toggle" aria-label="播放或暂停">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>
  </button>
  <button type="button" data-cmd="skip" data-v="5" aria-label="快进 5 秒">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" aria-hidden="true">
      <path d="M20 12a8 8 0 1 1-2.35-5.66"/>
      <path d="M20 4.4V9h-4.6"/>
      <text x="12" y="15.6" text-anchor="middle" font-size="8.4" stroke="none"
        fill="currentColor">5</text>
    </svg>
  </button>
  <span class="group-sep"></span>
  <button type="button" id="rate" data-cmd="rate" aria-label="切换倍速">
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3.5 6.5L10 12l-6.5 5.5zM12.5 6.5L19 12l-6.5 5.5z"/>
    </svg>
    <span id="rate-badge">1×</span>
  </button>
</div>
<div id="sheet">
  <div class="sheet-head"><span>字幕设置</span><button id="sheet-done" type="button">完成</button></div>

  <div class="sec-label">外观</div>
  <div class="style-grid" data-pref="style">
    ${STYLE_CHOICES.map((name) => `<button type="button" class="style-btn" data-v="${name}">
      <span class="style-btn__art"><svg viewBox="0 0 24 24" aria-hidden="true">${STYLE_ICONS[name]}</svg></span>
      <span class="style-btn__cap">${STYLE_LABELS[name]}</span>
    </button>`).join('')}
  </div>
  <div class="row"><span>字号</span>
    <div class="stepper">
      <button type="button" id="scale-">−</button>
      <span class="value" id="scale-value">100%</span>
      <button type="button" id="scale+">+</button>
    </div>
  </div>
  <div class="row"><span>颜色</span>
    <div class="seg" data-pref="color">
      ${COLOR_PRESETS.map((hex) => `<button type="button" class="swatch" data-v="${hex}" title="${COLOR_NAMES[hex]}" style="background:${hex}"></button>`).join('')}
    </div>
  </div>

  <div class="sec-label">显示</div>
  <div class="row"><span>译文</span>
    <div class="seg" data-pref="dual">
      <button type="button" data-v="1">显示</button>
      <button type="button" data-v="0">隐藏</button>
    </div>
  </div>
  <div class="row"><span>上下文</span>
    <div class="seg" data-pref="ctx">
      <button type="button" data-v="0">无</button>
      <button type="button" data-v="1">下一句</button>
      <button type="button" data-v="2">上下</button>
    </div>
  </div>
  <div class="row"><span>进度条</span>
    <div class="seg" data-pref="bar">
      <button type="button" data-v="1">显示</button>
      <button type="button" data-v="0">隐藏</button>
    </div>
  </div>
  <div class="row"><span>分词</span>
    <div class="seg" data-pref="seg">
      <button type="button" data-v="1">显示</button>
      <button type="button" data-v="0">隐藏</button>
    </div>
  </div>
</div>
<div id="install" class="gone">
  <span class="share">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 15.5V4"/><path d="M8 8l4-4 4 4"/><path d="M5 13.5v5.5h14v-5.5"/>
    </svg>
  </span>
  <span class="body"><b>点这里去掉地址栏：</b>分享，添加到主屏幕，从主屏图标打开</span>
  <button id="install-ok" type="button">知道了</button>
</div>
<div id="hint">建议横屏 · 自动锁定设为「永不」</div>
<script>
(() => {
  'use strict';

  /**
   * 服务端按房间存的上一次显示偏好。用 localStorage 的地方以它作后备：
   * 手机上换一个地址（IP / .local / 主屏图标）打开时，localStorage 是另一份存储，
   * 没有这份种子就会「每次都回到默认字号」。
   */
  const BOOT_PREFS = ${JSON.stringify(bootPrefs || null)};

  // ================================================================ 官方外观公式
  // 与 src/mod/30-desktop-subtitles.js 的 pipCss() 逐条对应；改那边时这里要跟着改。

  const STYLE_SPECS = ${JSON.stringify(STYLE_SPECS)};
  const STYLE_CHOICES = ${JSON.stringify(STYLE_CHOICES)};
  const COLOR_PRESETS = ${JSON.stringify(COLOR_PRESETS)};
  const RATE_STEPS = ${JSON.stringify(RATE_STEPS)};
  const COMIC_LANGS = ${JSON.stringify(COMIC_LANGS)};
  const FONT_SANS = ${JSON.stringify(FONT_SANS)};
  const FONT_COMIC_LATIN = ${JSON.stringify(FONT_COMIC_LATIN)};
  const FONT_COMIC_JA = ${JSON.stringify(FONT_COMIC_JA)};

  const TYPE_SPEC = ${JSON.stringify(TYPE_SPEC)};
  const SECONDARY_COLOR = ${JSON.stringify(SECONDARY_COLOR)};
  const MIN_FONT_PX = ${MIN_FONT_PX};
  const SCALE_MIN = 50;
  const SCALE_MAX = 150;
  const SCALE_STEP = 10;

  const round1 = (value) => Math.round(value * 10) / 10;

  function hexChannels(hex) {
    const raw = String(hex == null ? '' : hex).replace('#', '');
    const value = /^[0-9a-fA-F]{6}$/.test(raw) ? raw : '000000';
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }

  function colorWithAlpha(hex, alpha) {
    const [r, g, b] = hexChannels(hex);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function fontStackOf(spec, lang, style) {
    // comic 的手写体只覆盖拉丁语系与日语（与官方 oe() 一致）
    if (style === 'comic') {
      if (lang === 'ja') return FONT_COMIC_JA;
      if (COMIC_LANGS.indexOf(lang) >= 0) return FONT_COMIC_LATIN;
    }
    return FONT_SANS;
  }

  function shadowOf(shape, base) {
    const px = (ratio) => round1(base * ratio);
    if (shape === 'plate') return '0 ' + px(.083) + 'px ' + px(.333) + 'px rgba(0, 0, 0, 0.8)';
    if (shape === 'depth') return '0 ' + px(.04) + 'px ' + px(.13) + 'px rgba(0, 0, 0, 0.6)';
    if (shape === 'offset') return px(.05) + 'px ' + px(.05) + 'px 0 rgba(0, 0, 0, 0.62)';
    return 'none';
  }

  const paintOrderOk = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    && CSS.supports('paint-order', 'stroke fill');

  /** 官方 re()：阴影 + 描边。不支持 paint-order 时铺 8 向 text-shadow */
  function textEdgeOf(spec, base) {
    const shadow = shadowOf(spec.shadow, base);
    if (!(spec.outlineEm > 0)) return { shadow: shadow, stroke: '0', paintOrder: 'normal' };

    const ring = Math.max(1, round1(base * spec.outlineEm));
    if (paintOrderOk) return { shadow: shadow, stroke: ring + 'px', paintOrder: 'stroke fill' };

    const offsets = [];
    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8;
      offsets.push(
        (Math.cos(angle) * ring).toFixed(2) + 'px '
        + (Math.sin(angle) * ring).toFixed(2) + 'px 0 rgba(0, 0, 0, 0.92)',
      );
    }
    const joined = offsets.join(', ');
    return {
      shadow: shadow === 'none' ? joined : joined + ', ' + shadow,
      stroke: '0',
      paintOrder: 'normal',
    };
  }

  /**
   * 某一行在指定档位下的字号。规格值就是 100% 档位，50–150% 等比缩放；
   * 任何一行都不低于 MIN_FONT_PX（11px），否则 50% 档位下注音会糊成一条线。
   */
  function typePx(px, scale) {
    return round1(Math.max(MIN_FONT_PX, px * (scale / 100)));
  }

  /**
   * 生成整张外观样式表（与 pipCss 同结构：骨架在静态 CSS，这里只给随外观变的部分）。
   *
   * 字号 / 字重 / 行高按 PLAN 063 的手机屏规格固定；style 预设只剩字体栈与描边差异。
   * 底板（classic 的模糊块、contrast 的行底）不再输出：手机屏是纯色背景，
   * 背景修饰只会让字更挤，也与「清爽」的目标相反。
   */
  function appearanceCss(target) {
    const spec = STYLE_SPECS[target.style] || STYLE_SPECS.classic;
    const scale = target.scale;
    const primary = typePx(TYPE_SPEC.primary, scale);
    const secondary = typePx(TYPE_SPEC.secondary, scale);
    const context = typePx(TYPE_SPEC.context, scale);
    const ruby = typePx(TYPE_SPEC.ruby, scale);
    const edge = textEdgeOf(spec, primary);
    const letterSpacing = spec.letterSpacingEm ? spec.letterSpacingEm + 'em' : 'normal';
    const primaryColor = target.color;
    // 译文固定冷色（见 SECONDARY_COLOR 的注释），与原文的纯白拉开色相
    const secondaryColor = SECONDARY_COLOR;
    const contextColor = colorWithAlpha(target.color, .4);

    const line = (selector, fontLang, size, weight, color) => selector + ' {'
      + ' font-family: ' + fontStackOf(spec, fontLang, target.style) + ';'
      + ' font-size: ' + size + 'px;'
      + ' font-weight: ' + weight + ';'
      + ' letter-spacing: ' + letterSpacing + ';'
      + ' color: ' + color + ';'
      + ' text-shadow: ' + edge.shadow + ';'
      + ' -webkit-text-stroke-width: ' + edge.stroke + ';'
      + ' -webkit-text-stroke-color: rgba(0, 0, 0, 0.92);'
      + ' paint-order: ' + edge.paintOrder + '; }';

    return [
      // 当前原文：24px / 600 / 不透明
      line('#line-primary', target.primaryLang, primary, 600, primaryColor),
      // 主译文：16px / 400 / 85%
      line('#line-secondary', target.secondaryLang, secondary, 400, secondaryColor),
      // 上文 / 下文预览：13px / 400 / 40%
      line('#prev-primary, #next-primary', target.primaryLang, context, 400, contextColor),
      line('#prev-secondary, #next-secondary', target.secondaryLang, context, 400, contextColor),
      // 注音：12px / 400 / 80%（颜色与 4px 间距在静态 CSS 里）
      '#line-primary rt { font-size: ' + ruby + 'px; }',
    ].join('\\n');
  }

  // ================================================================ DOM

  const stageEl = document.getElementById('stage');
  const linePrimary = document.getElementById('line-primary');
  const lineSecondary = document.getElementById('line-secondary');
  const prevEl = document.getElementById('prev');
  const nextEl = document.getElementById('next');
  const prevPrimary = document.getElementById('prev-primary');
  const prevSecondary = document.getElementById('prev-secondary');
  const nextPrimary = document.getElementById('next-primary');
  const nextSecondary = document.getElementById('next-secondary');
  const fillPrimary = document.getElementById('fill-primary');
  const progressEl = document.getElementById('progress');
  const progressFill = document.getElementById('progress-fill');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const gearEl = document.getElementById('gear');
  const controlsEl = document.getElementById('controls');
  const playBtn = document.getElementById('playpause');
  const rateBtn = document.getElementById('rate');
  const rateBadge = document.getElementById('rate-badge');
  const sheetEl = document.getElementById('sheet');
  const styleEl = document.getElementById('appearance');
  const pickerEl = document.getElementById('picker');
  const pickerRows = document.getElementById('picker-rows');
  const pickerTime = document.getElementById('picker-time');

  /**
   * 播放 / 暂停图标用内联 SVG，不用三角形、双竖线这类字符：
   * 它们在部分平台会被渲染成彩色 emoji，或者因字体缺失变成方框（PLAN 063 v2）。
   */
  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M8 5.5h3.4v13H8zM12.6 5.5H16v13h-3.4z" fill="currentColor"/></svg>';

  const room = new URLSearchParams(location.search).get('room') || 'demo';

  // ================================================================ 本机偏好
  //
  // 第一次收到字幕时按发送端的样式播种，之后以手机为准（字号/上下文/进度条是「这块屏怎么摆」，
  // 不该被 Mac 上的每一次调整覆盖）。键名带 v2：v1 存的是旧的 scale 倍数，形状不同。

  const PREFS_KEY = 'llg-cast-prefs-v2';
  let prefs = null;

  function readPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      // localStorage 没有时退回服务端注入的那份（换地址 / 换容器打开的场景）
      const value = raw ? JSON.parse(raw) : BOOT_PREFS;
      if (!value || typeof value !== 'object') return null;
      return {
        style: STYLE_CHOICES.indexOf(value.style) >= 0 ? value.style : 'classic',
        scale: Number.isFinite(value.scale) ? value.scale : 100,
        color: COLOR_PRESETS.indexOf(value.color) >= 0 ? value.color : '#FFFFFF',
        ctx: Number.isFinite(value.ctx) ? value.ctx : 1,
        dual: value.dual !== false,
        bar: value.bar !== false,
        // 分词默认打开（PLAN 064）：段间距是手机屏上唯一的词组边界提示
        seg: value.seg !== false,
      };
    } catch {
      return null;
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // 隐私模式存不住，本次照样生效
    }
    // 再同步一份到房间：换个地址打开（IP / .local / 主屏图标）也能继承
    try {
      fetch('/prefs?room=' + encodeURIComponent(room), {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(prefs),
        cache: 'no-store',
      }).catch(() => {});
    } catch {
      // 断网时忽略：下一次改设置会再同步
    }
  }

  function seedPrefs(style) {
    if (prefs) return;
    prefs = {
      style: STYLE_CHOICES.indexOf(style.style) >= 0 ? style.style : 'classic',
      scale: clampScale(Number(style.scale) || 100),
      color: COLOR_PRESETS.indexOf(style.color) >= 0 ? style.color : '#FFFFFF',
      ctx: Number.isFinite(style.ctxLines) ? style.ctxLines : 1,
      dual: style.dual !== false,
      bar: true,
      seg: true,
    };
    savePrefs();
  }

  function clampScale(value) {
    const step = Math.round(value / SCALE_STEP) * SCALE_STEP;
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, step));
  }

  // ================================================================ 渲染

  let langPrimary = 'ja';
  let langSecondary = 'zh';
  let lastSeq = -1;
  let lastCurKey = '';
  let lastPayload = null;

  /**
   * 两条进度条都靠**本地时钟插值**，不靠 4Hz 的推送做动画。
   *
   * 之前每来一帧就改一次宽度，配合 CSS transition，等于每 250ms 重启一次过渡，
   * 看起来就是「一顿一顿」。现在推送只提供基准（position + 到达时刻），
   * rAF 每帧补上经过的时间，网络抖动也不会体现在动画上。
   */
  let videoClock = { active: false, playing: false, baseMs: 0, basePos: 0, duration: 0 };
  let cueClock = {
    active: false, playing: false, baseMs: 0, baseProgress: 0, duration: 0, start: null,
    /** 画面上的那句原文：换句只认它（见 syncClocks 的注释） */
    text: '',
  };
  let lastBarValue = -1;
  let lastFillValue = -1;

  /**
   * 整张样式表重写的成本不低，而 render() 每秒会来好几次 ——
   * 外观没变就不写（AGENTS.md §3 的幂等规矩同样适用于 DOM）。
   */
  let lastAppearanceKey = '';

  function applyAppearance() {
    // 视口尺寸必须进键：基座字号跟着它算，旋转 / 地址栏收放后不重算就会停在旧字号
    const key = [
      prefs.style, prefs.scale, prefs.color, langPrimary, langSecondary,
      window.innerWidth, window.innerHeight,
    ].join('|');
    if (key === lastAppearanceKey) return;
    lastAppearanceKey = key;
    styleEl.textContent = appearanceCss({
      style: prefs.style,
      scale: prefs.scale,
      color: prefs.color,
      primaryLang: langPrimary,
      secondaryLang: langSecondary,
    });
  }

  /**
   * 二维数组 → 节点：外层是文节段，内层是 token（可能带注音）。
   *
   * 段与段之间**不插入任何字符**（PLAN 063 去掉了竖线），只靠 .llg-seg 的
   * margin-right 表达词组边界 —— 文本流保持连续，复制/选中也不会带出符号。
   */
  function buildLine(target, segments) {
    const nodes = [];
    segments.forEach((seg) => {
      const tokens = [];
      for (const token of seg) {
        if (!token || !token.text) continue;
        if (token.ruby) {
          const ruby = document.createElement('ruby');
          ruby.append(token.text);
          const rt = document.createElement('rt');
          rt.textContent = token.ruby;
          ruby.append(rt);
          tokens.push(ruby);
        } else {
          tokens.push(token.text);
        }
      }
      if (!tokens.length) return;
      const group = document.createElement('span');
      group.className = 'llg-seg';
      group.replaceChildren(...tokens);
      nodes.push(group);
    });
    target.replaceChildren(...nodes);
  }

  function applyPrefs() {
    applyAppearance();
    progressEl.classList.toggle('off', !prefs.bar);
    // 关掉分词只去掉段间距，文本流本身没变（切点由发送端决定）
    linePrimary.parentElement.classList.toggle('no-seg', !prefs.seg);

    const hasCtx = !!lastPayload;
    renderCtx(prevEl, prevPrimary, prevSecondary,
      hasCtx && prefs.ctx >= 2 ? lastPayload.prev : null);
    renderCtx(nextEl, nextPrimary, nextSecondary,
      hasCtx && prefs.ctx >= 1 ? lastPayload.next : null);

    lineSecondary.classList.toggle('hidden', lastPayload
      ? (lastPayload.style && lastPayload.style.dual === false) || !prefs.dual
        || !lineSecondary.textContent
      : false);
  }

  function renderCtx(block, primaryEl, secondaryEl, cue) {
    const primary = cue && cue.primary ? cue.primary : '';
    const secondary = cue && cue.secondary ? cue.secondary : '';
    // 幂等：同一帧里每秒会来好几次，无谓的 textContent 赋值会白白触发排版
    if (primaryEl.textContent !== primary) primaryEl.textContent = primary;
    if (secondaryEl.textContent !== secondary) secondaryEl.textContent = secondary;
    secondaryEl.classList.toggle('hidden', !secondary);
    block.classList.toggle('hidden', !primary);
  }

  /**
   * 收到一帧就重设两条时钟的基准。
   *
   * 偏差小于阈值时**不重设**：本地时钟本来就更平滑，每 250ms 把基准拽回去
   * 反而会在进度条上看到一次次微小回跳。超过阈值（拖动 / 卡顿 / 重连）才认推送为准。
   *
   * 句内这条额外守一条规矩（PLAN 062）：**换句只认画面文本**（text），不跟
   * payload.cue 的时间轴走。换句那一拍两个来源必然错开，而 progress 在错开时
   * 是 null（getProgressOrNull()）—— 以前把它折成 0 当基准，于是每句快结束时
   * 句内进度都被拽回句首重走，看起来「永远走不完」。
   *
   * @param {number|null} progress 不可信时为 null
   * @param {string} text 画面上的那句原文（换句依据）
   */
  function syncClocks(payload, progress, text, now) {
    const playing = payload.playing !== false;
    const timeline = payload.timeline;

    if (timeline && timeline.duration > 0) {
      const duration = timeline.duration;
      const est = videoClock.active && videoClock.playing
        ? videoClock.basePos + (now - videoClock.baseMs) / 1000
        : null;
      const drifted = est === null || Math.abs(est - timeline.position) > 0.8;
      if (drifted || videoClock.duration !== duration) {
        videoClock = { active: true, playing, duration, baseMs: now, basePos: timeline.position };
      } else if (videoClock.playing !== playing) {
        // 暂停 / 继续：把当前估值定成新基准，避免跳一下
        videoClock = { active: true, playing, duration, baseMs: now, basePos: est };
      }
    } else {
      videoClock.active = false;
    }

    const cue = payload.cue;
    const cueDuration = cue && cue.end > cue.start ? cue.end - cue.start : 0;

    // 画面换句（含空档、第一次收到字幕）：这一帧就是新句的起点。这里**不用 progress**
    // —— 换句窗口里它可能是上一句的尾巴、也可能是 null，都不是这一句的起点。
    if (!cueClock.active || cueClock.text !== text) {
      cueClock = {
        active: cueDuration > 0, playing, start: cue ? cue.start : null,
        duration: cueDuration, baseMs: now, baseProgress: 0, text,
      };
      return;
    }

    // 同一句但时间轴没给出句时长：保持本地估值，别归零
    if (!(cueDuration > 0)) {
      cueClock = {
        active: false, playing, start: cue ? cue.start : null, duration: 0,
        baseMs: now, baseProgress: cueValue(now), text,
      };
      return;
    }

    // 时间轴跑到了别的句子，而画面还停在这句：整帧不碰时钟。
    // （反过来画面先换句的情形已在上面的文本分支处理。）
    if (cueClock.start !== cue.start) return;

    // 活跃句的 end 会被一路推到播放位置：分母变长时保持已走的比例不动
    if (cueClock.duration !== cueDuration) {
      cueClock = {
        active: true, playing, start: cue.start, duration: cueDuration,
        baseMs: now, baseProgress: cueValue(now), text,
      };
      return;
    }

    if (cueClock.playing !== playing) {
      cueClock = {
        active: true, playing, start: cue.start, duration: cueDuration,
        baseMs: now, baseProgress: cueValue(now), text,
      };
      return;
    }

    // 这一帧没有可信进度（时间轴与画面句还没对齐）：保持本地推进
    if (progress == null) return;

    const est = cueValue(now);
    // 阈值按「秒」比，不按进度比：进度是 0–1，直接比 0.5 等于半句，形同没校验
    const drift = Math.abs(est - progress) * cueDuration;
    if (drift <= 0.5) return;
    // 只补「本地落后」，回退一律忽略：句内进度条不回跳，换句由文本分支负责重置
    if (progress < est) return;

    cueClock = { ...cueClock, baseMs: now, baseProgress: progress };
  }

  /** 句内进度（0–1）：有句时长就按本地时钟推，没有就停在推送值 */
  function cueValue(now) {
    if (!cueClock.active) return Math.max(0, Math.min(1, cueClock.baseProgress || 0));
    const value = cueClock.playing
      ? cueClock.baseProgress + (now - cueClock.baseMs) / 1000 / cueClock.duration
      : cueClock.baseProgress;
    return Math.max(0, Math.min(1, value));
  }

  /**
   * 每帧刷两条进度：底部整片进度 + 日语原文背后的句内进度（PLAN 063 v3）。
   * 译文行不铺进度。
   * 用 transform 的 scaleX（合成器动画），不写 width —— 后者每帧都要重新布局。
   */
  function paintProgress() {
    const now = performance.now();

    let bar;
    if (videoClock.active && videoClock.duration > 0) {
      const pos = videoClock.playing
        ? videoClock.basePos + (now - videoClock.baseMs) / 1000
        : videoClock.basePos;
      bar = Math.max(0, Math.min(1, pos / videoClock.duration));
    } else {
      // 拿不到整片时长（直播 / 元数据还没到）：退回句内进度，至少还有东西在动
      bar = cueValue(now);
    }
    if (Math.abs(bar - lastBarValue) > 0.0005) {
      lastBarValue = bar;
      progressFill.style.transform = 'scaleX(' + bar + ')';
    }

    const fill = cueValue(now);
    if (Math.abs(fill - lastFillValue) > 0.0005) {
      lastFillValue = fill;
      fillPrimary.style.transform = 'scaleX(' + fill + ')';
    }

    requestAnimationFrame(paintProgress);
  }

  function render(payload) {
    if (!payload) return;
    const style = payload.style || {};
    // 服务端重启会让 seq 从头开始：比上次小就当成新的一条流，否则会一直忽略帧
    if (payload.seq < lastSeq) {
      lastSeq = -1;
      lastCurKey = '';
      // 换了服务端进程：两条进度都重新起算，别接着上一段的时钟走
      videoClock.active = false;
      cueClock.active = false;
    }
    if (payload.seq === lastSeq) return;
    lastSeq = payload.seq;
    lastPayload = payload;

    if (!prefs) prefs = readPrefs();
    if (!prefs) seedPrefs(style);
    if (style.primaryLang) langPrimary = style.primaryLang;
    if (style.secondaryLang) langSecondary = style.secondaryLang;

    const cur = payload.cur || {};
    // 手机本地也留一份句子历史：快照没带 cues（旧扩展）时选句浮层靠它兜底
    rememberCue(payload.cue, cur.primary);
    const key = JSON.stringify(cur.segments || []);
    if (key !== lastCurKey) {
      lastCurKey = key;
      if (cur.segments && cur.segments.length) buildLine(linePrimary, cur.segments);
      else linePrimary.replaceChildren();
    }
    const secondaryText = cur.secondary || '';
    if (lineSecondary.textContent !== secondaryText) lineSecondary.textContent = secondaryText;
    stageEl.classList.toggle('empty', !linePrimary.textContent);
    // 每 250ms 一帧：先比对再写（与 renderCtx 的口径一致），否则 title 会一直进
    // MutationRecord，标签页标题也在无意义地重算
    const nextTitle = cur.primary || '字幕屏';
    if (document.title !== nextTitle) document.title = nextTitle;

    applyPrefs();

    // 两条进度都交给本地时钟插值（paintProgress 每帧刷），这里只重设基准。
    // progress 缺失（null）= 扩展说「这一拍不可信」，不能折成 0（PLAN 062）
    const rawProgress = payload.progress;
    const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(1, rawProgress)) : null;
    syncClocks(payload, progress, cur.primary || '', performance.now());

    paintControls(payload);
    setStatus(payload.playing === false ? '已暂停' : '已连接', true);
  }

  function setStatus(text, on) {
    // 每帧都会走到这里（render 的末尾）——文本没变就别写
    if (statusText.textContent !== text) statusText.textContent = text;
    statusEl.classList.toggle('on', !!on);
    statusEl.classList.toggle('off', !on);
  }

  function connect() {
    const es = new EventSource('/stream?room=' + encodeURIComponent(room));
    es.onopen = () => setStatus('已连接', true);
    es.onerror = () => setStatus('连接中断，重连中…', false);
    es.onmessage = (ev) => {
      try {
        render(JSON.parse(ev.data));
      } catch {
        // 半个包 / 非法 JSON：丢掉这一帧，等下一帧覆盖
      }
    };
  }

  // ================================================================ 设置面板

  function paintSegs() {
    // 分段按钮与样式瓷砖都是 [data-pref]，共用一套回显逻辑
    for (const seg of sheetEl.querySelectorAll('[data-pref]')) {
      const key = seg.dataset.pref;
      for (const btn of seg.querySelectorAll('button')) {
        const value = btn.dataset.v;
        const active = key === 'dual' || key === 'bar' || key === 'seg'
          ? (value === '1') === !!prefs[key]
          : String(prefs[key]) === value;
        btn.classList.toggle('active', active);
      }
    }
    document.getElementById('scale-value').textContent = prefs.scale + '%';
  }

  for (const seg of sheetEl.querySelectorAll('[data-pref]')) {
    seg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const key = seg.dataset.pref;
      const value = btn.dataset.v;
      if (key === 'style') prefs.style = value;
      else if (key === 'color') prefs.color = value;
      else if (key === 'ctx') prefs.ctx = Number(value);
      else if (key === 'dual') prefs.dual = value === '1';
      else if (key === 'bar') prefs.bar = value === '1';
      else if (key === 'seg') prefs.seg = value === '1';
      savePrefs();
      paintSegs();
      applyPrefs();
    });
  }

  document.getElementById('scale-').addEventListener('click', () => {
    prefs.scale = clampScale(prefs.scale - SCALE_STEP);
    savePrefs();
    paintSegs();
    applyPrefs();
  });
  document.getElementById('scale+').addEventListener('click', () => {
    prefs.scale = clampScale(prefs.scale + SCALE_STEP);
    savePrefs();
    paintSegs();
    applyPrefs();
  });

  function openSheet(open) {
    sheetEl.classList.toggle('open', open);
    if (open) {
      // 还没收到任何字幕就点开设置：先给一套官方默认，别让 paintSegs 读到 null
      if (!prefs) {
        prefs = { style: 'classic', scale: 100, color: '#FFFFFF', ctx: 1, dual: true, bar: true, seg: true };
      }
      paintSegs();
    }
  }

  gearEl.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openSheet(!sheetEl.classList.contains('open'));
  });
  document.getElementById('sheet-done').addEventListener('click', () => openSheet(false));

  // 控制条与齿轮常驻，点画面不再是「唤出它们」的开关；点面板外只负责收起面板
  document.addEventListener('click', (ev) => {
    if (sheetEl.contains(ev.target) || gearEl.contains(ev.target)) return;
    if (sheetEl.classList.contains('open')) openSheet(false);
  });

  // ================================================================ 播放控制（PLAN 042）

  /** 当前倍速（乐观更新：点完立刻显示新档位，随后由推送回显校准） */
  let rateNow = 1;
  /**
   * 刚点完倍速后的一小段「别信推送」的时间窗。
   *
   * 命令要等 Mac 下一次 /push 才执行（≤1s），期间到达的快照还是旧倍速 ——
   * 不挡的话按钮会先跳回旧档位再跳回来，看着像没点中。
   */
  let rateHoldUntil = 0;

  /** 1 → "1×"、1.25 → "1.25×"（去掉多余的 0，别显示 "1.50×"） */
  function fmtRate(value) {
    const rate = Number(value);
    if (!Number.isFinite(rate) || rate <= 0) return '1×';
    return String(Math.round(rate * 100) / 100).replace(/0+$/, '').replace(/\.$/, '') + '×';
  }

  /**
   * 命令发回 Mac：同源 POST，服务端入队，扩展下一次 /push 取走并操作 video。
   * 失败不做重试 —— 控制是「按一下就走」的交互，攒着补发反而会误操作。
   */
  function sendControl(action, value) {
    try {
      fetch('/control?room=' + encodeURIComponent(room), {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ action: action, value: value == null ? null : value }),
        cache: 'no-store',
      }).catch(() => {});
    } catch {
      // 断网：忽略
    }
  }

  controlsEl.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    ev.stopPropagation();

    const action = btn.dataset.cmd;
    if (action === 'rate') {
      const index = RATE_STEPS.indexOf(rateNow);
      const next = RATE_STEPS[(index + 1) % RATE_STEPS.length];
      rateNow = next;
      rateHoldUntil = performance.now() + 2000;
      rateBadge.textContent = fmtRate(next);
      sendControl('rate', next);
    } else if (action === 'skip') {
      sendControl('skip', Number(btn.dataset.v));
    } else {
      sendControl(action, null);
    }
  });

  /** 用快照回显：暂停态显示播放图标，倍速显示 Mac 上的真实值（Mac 上改也会同步过来） */
  function paintControls(payload) {
    const paused = payload.playing === false;
    const icon = paused ? 'play' : 'pause';
    // 幂等：同一状态不重写 innerHTML（AGENTS.md §3）
    if (playBtn.dataset.icon !== icon) {
      playBtn.dataset.icon = icon;
      playBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    }
    const rate = Number(payload.rate);
    if (Number.isFinite(rate) && rate > 0 && performance.now() > rateHoldUntil) rateNow = rate;
    const shownRate = fmtRate(rateNow);
    if (rateBadge.textContent !== shownRate) rateBadge.textContent = shownRate;
  }

  // ================================================================ 上下滑动选句（PLAN 045）
  //
  // 手指在字幕区上滑 → 浮层从「当前句」往前翻；滑得越远跳得越多（46px 一句）。
  // 松手 300ms 后发一条 seek 命令，由扩展把 Mac 上的 video.currentTime 设到该句开头。
  // 列表优先用扩展推来的 cues 窗口（当前句往前 40 句），没有时用本机累积的历史。

  /** 每滑这么多像素移动一句（一行的高度，手感接近「翻一格」） */
  const PICK_ROW_PX = 46;
  /** 超过这个纵向距离才认为是「要选句」，而不是误触 */
  const PICK_OPEN_PX = 26;
  /** 松手后等这么久再 seek：手指离开屏幕后仍有最后一次位移 */
  const PICK_SEND_DELAY = 300;

  /** 快照没带 cues 时的兜底：手机自己记下看过的句子 */
  const cueHistory = [];

  let pickerOpen = false;
  let pickerList = [];
  let pickIndex = 0;
  let pickBaseIndex = 0;
  let pickStartY = 0;
  let pickTravel = 0;
  let pickTimer = 0;
  /**
   * 本段触摸落在设置面板 / 控制条里：整段手势都不归选句管。
   *
   * 光在 touchstart 里 return 不够 —— touchmove 读的是**上一次**留下的 pickStartY，
   * 在设置页里轻轻一滑，dy 会是一个很大的值，直接翻句并 seek（PLAN 064）。
   */
  let pickBlocked = false;

  function rememberCue(cue, primary) {
    const start = Number(cue && cue.start);
    if (!Number.isFinite(start) || !primary) return;
    const last = cueHistory[cueHistory.length - 1];
    if (last && Math.abs(last[0] - start) < 0.01) return;
    // 用户往回拖过（或换了视频）：丢掉比当前句更晚的历史，别让列表前后乱序
    while (cueHistory.length && cueHistory[cueHistory.length - 1][0] > start + 0.01) cueHistory.pop();
    cueHistory.push([start, primary]);
    if (cueHistory.length > 200) cueHistory.shift();
  }

  /** 选句用的列表：扩展窗口优先（能翻得更远），否则用本机历史 */
  function pickerSource() {
    const list = lastPayload && Array.isArray(lastPayload.cues) ? lastPayload.cues : null;
    if (list && list.length) return list;
    return cueHistory;
  }

  function fmtClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }

  /** 只画选中句前后各 2 行：手机屏幕小，五行已经够看出上下文 */
  function renderPicker() {
    const rows = [];
    for (let off = -2; off <= 2; off += 1) {
      const item = pickerList[pickIndex + off];
      const row = document.createElement('div');
      row.className = 'picker-row' + (off === 0 ? ' center' : '');
      row.textContent = item ? String(item[1] || '—') : '';
      rows.push(row);
    }
    pickerRows.replaceChildren(...rows);
    const current = pickerList[pickIndex];
    pickerTime.textContent = current ? fmtClock(current[0]) : '';
  }

  function openPicker() {
    const list = pickerSource();
    if (!Array.isArray(list) || list.length < 2) return false;
    pickerList = list;
    // 列表最后一项就是正在播的这句：从它开始往前翻
    pickIndex = pickerList.length - 1;
    pickBaseIndex = pickIndex;
    pickerOpen = true;
    pickerEl.classList.add('open');
    pickerEl.setAttribute('aria-hidden', 'false');
    renderPicker();
    return true;
  }

  function closePicker() {
    pickerOpen = false;
    pickerEl.classList.remove('open');
    pickerEl.setAttribute('aria-hidden', 'true');
    clearTimeout(pickTimer);
  }

  function commitPick() {
    const item = pickerList[pickIndex];
    if (item) sendControl('seek', Number(item[0]) || 0);
  }

  function onPickStart(ev) {
    pickBlocked = false;
    if (!ev.touches || ev.touches.length !== 1) return;
    const y = ev.touches[0].clientY;
    // 设置面板 / 控制条里的滑动（滑块、列表滚动）交给它们自己，不能变成选句
    if (ev.target && ev.target.closest && ev.target.closest('#controls, #gear, #sheet')) {
      pickBlocked = true;
      return;
    }
    if (pickerOpen) {
      // 浮层里继续换句：以当前选中为基准重新算
      pickStartY = y;
      pickBaseIndex = pickIndex;
      pickTravel = 0;
      return;
    }
    pickStartY = y;
    pickTravel = 0;
  }

  function onPickMove(ev) {
    if (pickBlocked) return;
    if (!ev.touches || ev.touches.length !== 1) return;
    const dy = ev.touches[0].clientY - pickStartY;
    if (!pickerOpen) {
      if (Math.abs(dy) < PICK_OPEN_PX) return;
      if (!openPicker()) return;
    }
    // 已经在选句：别让 iOS 把这次滑动当成页面回弹
    if (ev.cancelable) ev.preventDefault();
    pickTravel = dy;
    // 上滑（dy < 0）= 往更早的句子走
    const next = Math.max(
      0,
      Math.min(pickerList.length - 1, pickBaseIndex + Math.round(dy / PICK_ROW_PX)),
    );
    if (next !== pickIndex) {
      pickIndex = next;
      renderPicker();
    }
  }

  function onPickEnd() {
    if (pickBlocked) {
      pickBlocked = false;
      return;
    }
    if (!pickerOpen) return;
    // 只滑了一点点就松手：当误触，关掉不跳
    if (Math.abs(pickTravel) < PICK_ROW_PX / 2) {
      closePicker();
      return;
    }
    clearTimeout(pickTimer);
    pickTimer = setTimeout(() => {
      commitPick();
      closePicker();
    }, PICK_SEND_DELAY);
  }

  document.addEventListener('touchstart', onPickStart, { passive: true });
  document.addEventListener('touchmove', onPickMove, { passive: false });
  document.addEventListener('touchend', onPickEnd, { passive: true });
  document.addEventListener('touchcancel', () => {
    pickBlocked = false;
    if (pickerOpen) closePicker();
  });

  // 旋转 / 地址栏收放 / 从竖屏启动后转横屏：iOS 的视口尺寸常常晚一两帧才稳定，
  // 所以既监听事件，也在载入后补两次重排。
  function relayout() {
    if (!prefs) return;
    // 强制重建一次：尺寸可能只是「看起来没变」而内部布局已经换了
    lastAppearanceKey = '';
    applyAppearance();
  }

  let resizeTimer = 0;
  function scheduleRelayout(delay) {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, delay);
  }

  window.addEventListener('resize', () => scheduleRelayout(120));
  window.addEventListener('orientationchange', () => scheduleRelayout(320));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => scheduleRelayout(120));
  }
  setTimeout(relayout, 300);
  setTimeout(relayout, 1200);

  // ================================================================ 系统集成

  // 纯 HTTP + 局域网 IP 不是安全上下文，取不到 Wake Lock；
  // 这里只是「有机会就拿」，拿不到就靠系统自动锁定去关（README 会写明）
  if (navigator.wakeLock && window.isSecureContext) {
    const lock = () => navigator.wakeLock.request('screen').catch(() => {});
    lock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') lock();
    });
  }

  // Safari 里直接打开时一定有地址栏 / 标签栏，而 iOS 不支持网页调用 requestFullscreen。
  // 唯一能真正全屏的是「添加到主屏幕」后以 standalone 启动，所以这里教一次。
  const installEl = document.getElementById('install');
  const HINT_KEY = 'llg-cast-install-hint';
  const standalone = window.navigator.standalone === true
    || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  if (standalone) {
    installEl.remove();
  } else {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(HINT_KEY) === 'off';
    } catch {
      // 隐私模式禁用 localStorage，就当没关过
    }
    if (!dismissed) {
      installEl.classList.remove('gone');
      const hide = () => installEl.classList.add('gone');
      document.getElementById('install-ok').addEventListener('click', () => {
        hide();
        try {
          localStorage.setItem(HINT_KEY, 'off');
        } catch {
          // 存不住就下次再提示
        }
      });
      // 12 秒后自己退场：它是提示，不是横幅
      setTimeout(hide, 12000);
    }
  }

  prefs = readPrefs();
  if (prefs) {
    paintSegs();
    applyPrefs();
  }

  // 进度动画必须自己起转：它只在 rAF 里递归续命，没人踢第一脚就永远不动
  requestAnimationFrame(paintProgress);
  connect();
})();
</script>
</body>
</html>`;
}
