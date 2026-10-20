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
    /* 控件全部搬到顶部横排（PLAN 063 v5）：顶部让出工具条 + 状态行，
       底部只留进度条；左右 12px，右侧不再有竖排按钮，字幕可用宽度更大 */
    padding: calc(env(safe-area-inset-top) + 78px) var(--pad)
             calc(env(safe-area-inset-bottom) + 32px);
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
  /* 卷轴窗口（PLAN 065 v2）：高度跟着字幕板走，换句时整块板在窗口里上下滚，
     滚出窗口的部分被裁掉 —— 不额外造任何覆盖层，DOM 里始终只有一块字幕板。 */
  #reel {
    position: relative;
    display: flex; flex-direction: column; align-items: center;
    width: 100%; overflow: hidden;
    /* 主译文的底部外边距：单语（译文隐藏）时它仍把主字幕与下文预览隔开 */
    margin-bottom: 16px;
  }
  #plate {
    display: flex; flex-direction: column; align-items: center;
    box-sizing: border-box; max-width: 100%;
  }
  /* 换句时滚出去的那一格（PLAN 068）：新句从下方进窗口的同时，旧句在同一窗口里
     向上滚出，两块板拼成一次连续滚动。它不是 cloneNode 出来的快照 —— 节点是从
     #plate 直接**搬**过来的，动完就清空，所以窗口里任何时刻只有两块真实字幕板。 */
  #ghost {
    position: absolute; top: 0; left: 0; right: 0;
    display: flex; flex-direction: column; align-items: center;
    pointer-events: none;
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
  /* 一行放下整句（PLAN 063 v6）：nowrap 之后由 fitLine() 按实际宽度等比缩小字号，
     不再折行；两行各自独立算，译文不会跟着原文一起缩。 */
  #line-primary, #line-secondary {
    position: relative; display: block;
    text-align: center; white-space: nowrap;
    max-width: 100%;
  }
  /* 压在填充之上：kfill 是绝对定位，默认画在普通流后面 */
  #line-primary { z-index: 1; line-height: 1.6; }
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
  /* 滚出去那一格的骨架与注音：字号 / 颜色 / 描边仍由 appearanceCss 按同一档位给，
     这里只补 #line-primary 那几条无法继承的排版规则（PLAN 068） */
  #ghost-primary, #ghost-secondary {
    position: relative; display: block;
    text-align: center; white-space: nowrap;
    max-width: 100%;
  }
  #ghost-primary { line-height: 1.6; }
  #ghost-primary:has(ruby) { line-height: 2; }
  #ghost-secondary { line-height: 1.5; margin-top: 8px; }
  #ghost-primary rt {
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

  /* 状态在工具条正下方居中：顶部一行只留工具条，避免与字幕左右抢空间 */
  #status {
    position: fixed; top: calc(env(safe-area-inset-top) + 56px);
    left: 50%; transform: translateX(-50%);
    font-size: 11px; color: #7a7a80; letter-spacing: .02em;
    display: flex; align-items: center; gap: 6px;
  }
  #dot { width: 6px; height: 6px; border-radius: 50%; background: #4b5563; }
  #status.on #dot { background: #30d158; }
  #status.off { color: #f87171; }
  #status.off #dot { background: #f87171; }

  /* 播放控制条：常驻（PLAN 044），v5 改为顶部横排（PLAN 063 v5）。
     右侧竖排会压住长句的右端，横排到顶部后字幕左右都能用满。 */
  #controls {
    position: fixed; left: 50%; transform: translateX(-50%);
    top: calc(env(safe-area-inset-top) + 8px);
    display: flex; flex-direction: row; align-items: center; gap: 2px;
    padding: 3px; border-radius: 14px;
    background: rgba(24, 24, 27, .92); border: 1px solid rgba(255, 255, 255, .12);
    z-index: 20;
  }
  #controls button {
    background: none; border: 0; color: #e5e7eb;
    width: 48px; height: 36px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 11px; font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  #controls button svg { width: 17px; height: 17px; }
  #controls button:active { background: rgba(255, 255, 255, .14); }
  /* 横排时用竖线分组：设置 / 回退·播放·快进 / 倍速 */
  #controls .group-sep {
    width: 1px; height: 18px; margin: 0 3px;
    background: rgba(255, 255, 255, .12);
  }

  /* 选句（PLAN 045 → 067）：早期版本会弹一张盖住整屏的浮层，字型与位置都与字幕
     不同，滑动时像在操作另一个界面。现在没有浮层，手势直接驱动字幕位本身 ——
     候选句写在 #plate 上，原文与上下句沿用当前外观，只有一块极淡的蓝底标出
     「松手会跳到这里」。 */
  #stage.picking .kline {
    border-radius: 10px;
    background: rgba(10, 132, 255, .14);
    box-shadow: inset 0 0 0 1px rgba(10, 132, 255, .4);
  }
  /* 选句时唯一新增的界面元素：底部一行说明滑到了第几句、对应时间 */
  #pick-badge {
    position: fixed; left: 50%;
    bottom: calc(env(safe-area-inset-bottom) + 40px);
    transform: translateX(-50%) translateY(4px);
    padding: 3px 10px; border-radius: 999px;
    background: rgba(24, 24, 27, .82);
    font-size: 12px; letter-spacing: .03em;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, .6);
    opacity: 0; pointer-events: none; z-index: 22;
    transition: opacity .12s ease, transform .12s ease;
  }
  #pick-badge.show { opacity: 1; transform: translateX(-50%); }
  /* 竖屏建议文案与选句说明占同一块地方，选句时让位 */
  #stage.picking ~ #hint { display: none; }

  /* 倍速按钮只放数值（PLAN 063 v6）：图标表达不出档位，数值本身就是最好的标识。
     选择器带上 #controls，否则压不过 #controls button 的 48px。 */
  #controls #rate { width: 64px; }
  #rate-badge {
    font-size: 14px; line-height: 1; color: #64d2ff;
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
    top: calc(env(safe-area-inset-top) + 82px);
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
    bottom: calc(env(safe-area-inset-bottom) + 30px);
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
  <div id="reel">
    <div id="plate">
      <div class="kline">
        <i class="kfill" id="fill-primary"></i>
        <div id="line-primary"></div>
      </div>
      <div id="line-secondary"></div>
    </div>
    <div id="ghost" class="hidden" aria-hidden="true">
      <div class="kline"><div id="ghost-primary"></div></div>
      <div id="ghost-secondary" class="hidden"></div>
    </div>
  </div>
  <div id="next" class="ctx hidden">
    <div class="ctx-line" id="next-primary"></div>
    <div class="ctx-line" id="next-secondary"></div>
  </div>
</div>
<div id="progress"><i id="progress-fill"></i></div>
<div id="status"><i id="dot"></i><span id="status-text">连接中…</span></div>
<div id="pick-badge" aria-hidden="true"><span id="pick-badge-text"></span></div>
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
      // 当前原文：24px / 600 / 不透明。滚出去那一格（#ghost-*）必须与它同档，
      // 否则换句时新旧两句的字号会差一截（PLAN 068）
      line('#line-primary, #ghost-primary', target.primaryLang, primary, 600, primaryColor),
      // 主译文：16px / 400 / 85%
      line('#line-secondary, #ghost-secondary', target.secondaryLang, secondary, 400, secondaryColor),
      // 上文 / 下文预览：13px / 400 / 40%
      line('#prev-primary, #next-primary', target.primaryLang, context, 400, contextColor),
      line('#prev-secondary, #next-secondary', target.secondaryLang, context, 400, contextColor),
      // 注音：0.5em（= 18px @ 36px）。必须用 em —— fitLine 缩原文时注音要等比缩，
      // 固定 px 会让注音反过来撑宽整行，怎么迭代都缩不进一行
      '#line-primary rt { font-size: .5em; }',
    ].join('\\n');
  }

  // ================================================================ DOM

  const stageEl = document.getElementById('stage');
  const reelEl = document.getElementById('reel');
  const plateEl = document.getElementById('plate');
  const linePrimary = document.getElementById('line-primary');
  const lineSecondary = document.getElementById('line-secondary');
  const ghostEl = document.getElementById('ghost');
  const ghostPrimary = document.getElementById('ghost-primary');
  const ghostSecondary = document.getElementById('ghost-secondary');
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
  const pickBadge = document.getElementById('pick-badge');
  const pickBadgeText = document.getElementById('pick-badge-text');

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
   * 静态块（PLAN 071）：cur/prev/next/cues/plan/style 不再每帧重传，
   * 收到一次就存下来，后续的「只有播放头」的帧靠它补齐。
   */
  const STATIC_FIELDS = ['cur', 'prev', 'next', 'cues', 'plan', 'style'];
  let staticBlock = null;

  /**
   * 整条轨（PLAN 072）：扩展分块下发，攒齐后断流也能按本地时钟继续换句。
   * cues[i] 是 [start, end, primary, secondary]，可能有洞（块丢了）。
   */
  const trackStore = { ver: '', total: 0, cues: [], got: 0 };
  /** 上一帧到达的本地时刻：超过 STALE_STREAM_MS 没新帧就认为断流 */
  let lastFrameAt = 0;
  const STALE_STREAM_MS = 1200;

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
    // 样式表刚换过：上一轮的行内缩字号要按新基准重算
    fitBothLines();
  }

  /**
   * 让一行装下整句（PLAN 063 v6）。
   *
   * 两行都是 white-space: nowrap，超出的部分会被裁掉；这里按实际宽度等比缩小字号，
   * 直到放得下。下限 minPx，避免极长句缩到看不清。两行各自独立算，译文不跟原文一起缩。
   */
  function fitLine(el, minPx) {
    if (!el || !el.textContent) return;
    if (getComputedStyle(el).display === 'none') return;
    // 先回到样式表给的字号，否则上一轮的缩小结果会当成新基准
    el.style.fontSize = '';
    const base = parseFloat(getComputedStyle(el).fontSize);
    if (!(base > 0)) return;
    const pad = parseFloat(getComputedStyle(stageEl).paddingLeft) || 0;
    const avail = stageEl.clientWidth - pad * 2;
    if (!(avail > 0)) return;
    // 注音、段间距、字距不严格随字号线性变化，迭代几次才收敛
    let size = base;
    for (let i = 0; i < 3 && el.scrollWidth > avail; i += 1) {
      const need = el.scrollWidth;
      if (!(need > 0)) break;
      // 0.97 给取整留余量，否则向下取一位小数后可能还差 1px
      size = Math.max(minPx, Math.min(size, size * (avail / need) * 0.97));
      el.style.fontSize = (Math.floor(size * 10) / 10) + 'px';
      if (size <= minPx) break;
    }
  }

  function fitBothLines() {
    fitLine(linePrimary, 12);
    fitLine(lineSecondary, 13);
  }

  // ================================================================ 换句动效（PLAN 065 → 068 → 069）
  //
  // PLAN 065 是「旧句滑出 → 换字 → 新句滑入」的串行两段：中间有一段窗口全空的
  // 空档，看起来是「闪了一下」而不是滚动。PLAN 068 改成两块板在同一窗口里
  // **并行拼合滚动**：
  //   旧句（#ghost）从 0 滚到 -H，新句（#plate）从 +H 滚到 0，同一时长、同一缓动。
  // 任一时刻滚到多少，两块板在窗口里都正好接在一起（旧句底边 = 新句顶边），
  // 观感就是歌词卷轴实实在在地滚了一整格，而不是原地淡入淡出。
  //
  // PLAN 069 换掉的是「什么时候起跑」：以前是「帧到达 → 检测换句 → 起跑」，而帧到达
  // 时刻被 250ms 的推送节拍与网络抖动着走，动效再顺也像在按拍子跳。现在帧里带
  // sentAt 与 plan（未来两句的 start），手机把换句排到**本地时钟**上，并用实到帧
  // 校准「预测 − 实际」的固定偏差 —— 与 PLAN 062 对进度条做的事同源。

  /** 一次换句的动效时长上限；实际时长按「距下一句还有多久」收缩（PLAN 069） */
  const SWAP_MS = 260;
  /** 收缩下限：再短就看不出是滚动，不如直接换字 */
  const SWAP_MIN_MS = 140;
  /** 只剩这么点时间动画来不及表达方向，直接换字 */
  const SWAP_CUT_MS = 80;
  /** 预测偏差的平滑系数：越小越稳，越大越跟手 */
  const SWAP_BIAS_ALPHA = 0.3;
  /** 单程延迟样本窗口（帧数） */
  const LATENCY_WINDOW = 20;
  const SWAP_EASE = 'cubic-bezier(.32,.72,.26,1)';

  /** 上一帧的句首时间：判断新句是「往后」还是「往前」（拖动选句时反过来） */
  let lastCueStart = null;
  /**
   * 已经显示在板上的那句（按 cue.start 认，PLAN 069）。
   *
   * 排程换句用的是「未来句的纯文本」，实到帧带的是同一句的 segments ——
   * 靠这个值把两者认成同一句，才不会滚第二次。
   */
  let shownCueStart = null;
  /** 本次换句动画何时结束；早于它到达的「上一句」帧属于陈旧帧（见 isStaleFrame） */
  let swapEndsAt = 0;

  /**
   * 到达时刻的排队延迟（PLAN 069）。
   *
   * sentAt 是扩展侧的 Date.now()，两台机器的时钟可能有任意时差 —— 这里**不做对时**，
   * 只取最近若干帧里最小的那个当「最顺利的一次」，其余帧相对它的超出量就是排队时间。
   * 用它把「帧到达时刻」还原成「扩展取样的时刻」，位置估值的抖动就只剩系统性的一份。
   */
  const queue = { samples: [], min: null };

  /**
   * 手机 ↔ 服务端的时钟差（PLAN 075）。
   *
   * offset = 服务端的墙钟 − 手机的墙钟。扩展与中转进程在同一台 Mac（localhost），
   * 所以它也等于「扩展墙钟 − 手机墙钟」。测出来之后 sentAt 就能直接换算成单程延迟，
   * 不用再靠「实到帧 − 预测」慢慢学（PLAN 069 的 bias 只做残差微调）。
   */
  const clockSync = { offset: null, rtt: null, inflight: false };

  async function syncClock() {
    if (clockSync.inflight) return;
    clockSync.inflight = true;
    const t0 = Date.now();
    try {
      const res = await fetch('/ping', { cache: 'no-store' });
      const data = await res.json();
      const t1 = Date.now();
      if (!Number.isFinite(data && data.at)) return;
      const rtt = t1 - t0;
      // 只用更小的 RTT 覆盖：大 RTT 说明这一次排过队，算出来的单程不干净
      if (!Number.isFinite(clockSync.rtt) || rtt <= clockSync.rtt) {
        clockSync.rtt = rtt;
        clockSync.offset = data.at + rtt / 2 - t1;
      }
    } catch {
      // 服务端没有 /ping（旧版本）：退回 PLAN 069 的相对最小样本估计
    } finally {
      clockSync.inflight = false;
    }
  }

  function noteQueueDelay(sentAt, arrivalWall) {
    if (!Number.isFinite(sentAt)) return 0;
    // 有 RTT 测出的时钟差就先对齐，再取最小样本扣排队量；没有就退回原口径
    const aligned = Number.isFinite(clockSync.offset) ? arrivalWall + clockSync.offset : arrivalWall;
    const raw = aligned - sentAt;
    // 极端值（时钟被改、服务端重放旧帧）会把最小值带偏，直接丢
    if (!(Math.abs(raw) < 6 * 60 * 60 * 1000)) return 0;
    queue.samples.push(raw);
    if (queue.samples.length > LATENCY_WINDOW) queue.samples.shift();
    queue.min = Math.min(...queue.samples);
    return Math.max(0, raw - queue.min);
  }

  /** 当前帧对应的视频时钟：sendLocal = 扩展取样那一刻的本地 performance.now() */
  let frameClock = null;

  function updateFrameClock(payload, now, arrivalWall) {
    const timeline = payload.timeline;
    if (!timeline || !(timeline.duration > 0) || !Number.isFinite(timeline.position)) {
      frameClock = null;
      return;
    }
    const excess = noteQueueDelay(payload.sentAt, arrivalWall);
    frameClock = {
      sendLocal: now - excess,
      pos: Number(timeline.position),
      rate: Number(payload.rate) > 0 ? Number(payload.rate) : 1,
      // 缓冲时 playing 仍是 true，但画面没在动：本地时钟必须一起冻住（PLAN 070）
      playing: payload.playing !== false && payload.stalled !== true,
    };
  }

  /** 视频时间（秒）→ 本地 performance.now()；拿不到时间轴时返回 null */
  function localAt(videoTime) {
    if (!frameClock || !Number.isFinite(videoTime)) return null;
    return frameClock.sendLocal + ((videoTime - frameClock.pos) / frameClock.rate) * 1000;
  }

  /**
   * 这一帧是不是「已经翻过去的那一句」的迟到帧（PLAN 069）。
   *
   * 排程换句会在句边界**那一刻**滚完，而那个时候还有几帧（250ms 节拍内）仍在报上一句。
   * 不挡的话它们会立刻把字幕滚回去，下一帧再滚回来 —— 实测就是这样来回跳。
   * 判据用本地时钟：要么动画还在跑，要么视频估值已经越过这一句的起点。
   * 往回拖进度条时视频估值也跟着退回去，所以真实的 seek 不会被误挡。
   */
  function isStaleFrame(cueStart, now) {
    if (cueStart == null || shownCueStart == null) return false;
    if (!(cueStart < shownCueStart - 0.02)) return false;
    if (now < swapEndsAt) return true;
    if (!frameClock || !frameClock.playing) return false;
    const pos = frameClock.pos + ((now - frameClock.sendLocal) / 1000) * frameClock.rate;
    return pos >= shownCueStart - 0.05;
  }

  /**
   * 换句排程（PLAN 069）。
   *
   * bias 是「本地时钟预测」相对「实际到达」的固定偏差：第一次排程按 0 算，之后每来
   * 一个真的换句帧就用「到达时刻 − 预测时刻」修正（推送一拍、网络单向延迟、两台机器
   * 的取样口径差都折进这一项）。这样网络抖动只影响校准值的一阶平滑，不进动效。
   */
  const swapCtl = {
    /** 是否已经用「最小单程延迟」播过种（PLAN 075）；之后交给 EWMA 微调 */
    seeded: false,
    bias: 0,
    /** 已排程的目标句起点（秒）；null = 没排程 */
    start: null,
    /** plan 里那一项：换句时用它先把原文写上去 */
    entry: null,
    /** 换句应该在本地时钟的哪一刻完成 */
    due: 0,
    /** 起跑时刻 = due - 时长 */
    at: 0,
  };

  function clearSwapPlan() {
    swapCtl.start = null;
    swapCtl.entry = null;
    swapCtl.due = 0;
    swapCtl.at = 0;
  }

  /**
   * 用这一帧的 plan 重新排一次换句。
   *
   * 不排程的四种情况：选句中、暂停、拿不到时间轴（直播 / 元数据未到）、plan 里没有
   * 比当前句更晚的一句。这几种都退回「实到帧驱动」（PLAN 068 的旧行为）。
   */
  function planSwap(payload, now) {
    clearSwapPlan();
    if (picking || !frameClock || !frameClock.playing) return;

    const plan = Array.isArray(payload.plan) ? payload.plan : null;
    const curStart = Number(payload.cue && payload.cue.start);
    if (!plan || !plan.length || !Number.isFinite(curStart)) return;

    let next = null;
    for (const item of plan) {
      const start = Number(item && item.start);
      if (!Number.isFinite(start)) continue;
      // 只认「更晚的一句」：plan[0] 是当前句，往回拖进度条时它可能比上一帧更早
      if (start <= curStart + 0.02) continue;
      // 已经滚上来的那一句不再排：迟到帧会把上一个换句点重新算出来（见 isStaleFrame）
      if (shownCueStart != null && start <= shownCueStart + 0.02) continue;
      if (!next || start < Number(next.start)) next = item;
    }
    if (!next || !String(next.primary || '').trim()) return;
    // 采样句的 start 有 ±100ms 误差（PLAN 073）：宁可晚一拍由实到帧触发，
    // 也不要在它前面提前一个动画时长起跑 —— 那会把误差放大成「滚早了等字幕」。
    if (next.official !== true) return;

    // 首次排程就用「最小单程延迟」把偏差播种（PLAN 075）：
    // 预测值比真实时刻晚了这个量，先扣掉，之后再由 EWMA 微调残差。
    // 没有测到时钟差时 queue.min 含两台机器的时钟偏移（可能是任意值），绝不能拿来播种。
    if (!swapCtl.seeded && Number.isFinite(clockSync.offset) && Number.isFinite(queue.min)) {
      swapCtl.bias = -Math.min(400, Math.max(0, queue.min));
      swapCtl.seeded = true;
    }
    const due = localAt(Number(next.start)) + swapCtl.bias;
    // 已经过了（缓冲、丢帧、刚 seek 过）：不排，交给实到帧
    if (!Number.isFinite(due) || due <= now) return;

    swapCtl.start = Number(next.start);
    swapCtl.entry = next;
    swapCtl.due = due;
    swapCtl.at = Math.max(now, due - SWAP_MS);
  }

  /**
   * 用一次真实换句校准偏差。
   *
   * 只在「这一帧的句子正是刚才排程的那一句」时采样：seek、往回翻、排程被跳过时测出来的
   * 都不是排程误差。样本离群（暂停恢复、跳转）也不参与平滑，否则会把后续排程带偏。
   */
  function observeSwap(arrival, cueStart) {
    if (swapCtl.start == null || !Number.isFinite(cueStart)) return;
    if (Math.abs(swapCtl.start - cueStart) > 0.02) return;
    const lateness = arrival - swapCtl.due;
    if (!Number.isFinite(lateness) || Math.abs(lateness) > 1500) return;
    swapCtl.bias += lateness * SWAP_BIAS_ALPHA;
    // 上限一拍：偏差再大也该由「实到帧驱动」兜住，不能让排程跑到几秒之外
    swapCtl.bias = Math.max(-600, Math.min(600, swapCtl.bias));
  }

  /**
   * 拼一块整轨（PLAN 072）。
   *
   * ver 变了就整份作废重来：不同版本的句子区间拼在一起，时间轴会错得比没有更离谱。
   * got 用「新增了才算」的方式累计，重复到达的块不会把计数刷高。
   */
  function mergeTrack(chunk) {
    const total = Math.max(0, Math.min(20000, Number(chunk.total) || 0));
    const from = Math.max(0, Number(chunk.from) || 0);
    const cues = Array.isArray(chunk.cues) ? chunk.cues : [];
    const ver = String(chunk.ver || '');
    if (!total) return;

    if (ver !== trackStore.ver || total !== trackStore.total) {
      trackStore.ver = ver;
      trackStore.total = total;
      trackStore.cues = [];
      trackStore.got = 0;
    }
    let added = 0;
    for (let i = 0; i < cues.length; i += 1) {
      const at = from + i;
      if (at < 0 || at >= total || !cues[i]) continue;
      if (!trackStore.cues[at]) added += 1;
      trackStore.cues[at] = cues[i];
    }
    trackStore.got += added;
  }

  /** 在整轨里定位某一时刻的句子（二分）；有洞时返回 null，交给帧驱动 */
  function trackCueAt(seconds) {
    if (!trackStore.total || trackStore.got < trackStore.total) return null;
    let lo = 0;
    let hi = trackStore.total - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cue = trackStore.cues[mid];
      if (!cue) return null;
      if (cue[0] <= seconds) {
        hit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (hit < 0) return null;
    const cue = trackStore.cues[hit];
    return {
      start: cue[0],
      end: cue[1],
      primary: cue[2] || '',
      secondary: cue[3] || '',
    };
  }

  /**
   * 断流兜底（PLAN 072）：太久没收到帧、手里又有完整轨道，就按本地时钟自己换句。
   *
   * 网络恢复后由帧里的事实接管；已经滚过去的那一句由 isStaleFrame 挡掉，
   * 所以不会因为「本地跑快了」而滚回去再滚一遍。
   */
  function tickTrackSwap(now) {
    if (picking || !frameClock || !frameClock.playing) return;
    if (!lastFrameAt || now - lastFrameAt < STALE_STREAM_MS) return;
    if (!trackStore.total || trackStore.got < trackStore.total) return;

    const pos = frameClock.pos + ((now - frameClock.sendLocal) / 1000) * frameClock.rate;
    const cue = trackCueAt(pos);
    if (!cue || !String(cue.primary || '').trim()) return;
    if (shownCueStart != null && Math.abs(cue.start - shownCueStart) < 0.02) return;

    const dir = shownCueStart != null && cue.start < shownCueStart ? -1 : 1;
    playSwap({ primary: cue.primary, secondary: cue.secondary, segments: null }, dir, SWAP_MS);
    shownCueStart = cue.start;
    lastCueStart = cue.start;
  }

  /**
   * 排程到点（由 rAF 每帧调，寄生在 paintProgress 的循环里，不另开一个）。
   *
   * 时长按「还剩多久」收缩：滚动结束的那一刻正好是该句开始播的时刻，
   * 所以换句节奏由播放位置决定，而不是由推送到达时刻决定。
   */
  function tickSwap(now) {
    if (swapCtl.start == null) {
      // 没有排程时才走断流兜底：有排程说明帧还在来，别和它抢
      tickTrackSwap(now);
      return;
    }
    if (now < swapCtl.at) return;

    const entry = swapCtl.entry;
    const start = swapCtl.start;
    const due = swapCtl.due;
    const paused = !!frameClock && !frameClock.playing;
    clearSwapPlan();
    if (!entry || picking || paused) return;

    const text = String(entry.primary || '');
    if (!text) return;

    const dir = shownCueStart != null && start < shownCueStart ? -1 : 1;
    const duration = Math.min(SWAP_MS, Math.max(SWAP_MIN_MS, due - now));
    // 预排文本只有纯文本（没有 segments）：先按原文滚上来，实到帧再补分词/注音
    playSwap({ primary: text, secondary: entry.secondary || '', segments: null }, dir, duration);
    shownCueStart = start;
    lastCueStart = start;
  }

  /**
   * 把推送里这句真正写到板上（原文、译文、自适应字号）。
   *
   * 指纹分两种形态：带 segments 的帧按结构比（分词 / 注音会变），排程换句那种
   * 「只有纯文本」的帧（PLAN 069）按文本比 —— 两者不能共用一个空数组指纹，
   * 否则纯文本那一帧会被当成「空句」跳过，板上留白。
   */
  function lineKey(cur) {
    if (!cur) return 'text\u0000';
    return cur.segments ? JSON.stringify(cur.segments) : 'text\u0000' + (cur.primary || '');
  }

  function applyLineText(cur) {
    const key = lineKey(cur);
    if (key !== lastCurKey) {
      lastCurKey = key;
      if (cur.segments && cur.segments.length) buildLine(linePrimary, cur.segments);
      // 排程换句只有纯文本：这时也必须写进去，不能当成「空句」清掉
      else if (cur.primary) linePrimary.textContent = cur.primary;
      else linePrimary.replaceChildren();
    }
    const secondaryText = cur.secondary || '';
    if (lineSecondary.textContent !== secondaryText) lineSecondary.textContent = secondaryText;
    fitBothLines();
  }

  /**
   * 把 #plate 上正在显示的这句搬到 #ghost。
   *
   * 用 replaceChildren(...childNodes) 是**移动节点**，不是 cloneNode：
   * 注音、文节 span、缩过的字号都原样带过去，且不产生第二份文本。
   */
  function movePlateToGhost() {
    ghostPrimary.replaceChildren(...Array.from(linePrimary.childNodes));
    ghostPrimary.style.fontSize = linePrimary.style.fontSize || '';
    ghostSecondary.textContent = lineSecondary.textContent;
    ghostSecondary.style.fontSize = lineSecondary.style.fontSize || '';
    ghostSecondary.classList.toggle('hidden', lineSecondary.classList.contains('hidden'));
    ghostEl.classList.remove('hidden');
    // 节点已经被搬走：这两个行内字号要按新句重新算
    linePrimary.style.fontSize = '';
    lineSecondary.style.fontSize = '';
  }

  function resetGhost() {
    ghostEl.getAnimations().forEach((anim) => anim.cancel());
    ghostEl.classList.add('hidden');
    ghostPrimary.replaceChildren();
    ghostSecondary.textContent = '';
    // 动画被打断时窗口高度可能还钉着（见 playSwap）：交还给内容自己算
    reelEl.style.height = '';
    swapEndsAt = 0;
  }

  /** 上下句跟着换句轻推一格：边缘两行也有「整块滚了一格」的方向暗示 */
  function nudgeCtx(dir, duration) {
    for (const block of [prevEl, nextEl]) {
      if (block.classList.contains('hidden')) continue;
      block.getAnimations().forEach((anim) => anim.cancel());
      block.animate([
        { transform: 'translateY(' + (dir * 10) + 'px)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ], { duration: duration || SWAP_MS, easing: SWAP_EASE });
    }
  }

  /**
   * 换句：新旧两句在同一卷轴窗口里并行滚一格。
   *
   * 位移量取旧窗口高度 H：旧句从 0 到 -H，新句从 +H 到 0。任一进度 p，
   * 旧句底边在 (1-p)H、新句顶边也在 (1-p)H —— 两块板始终严丝合缝地接在一起，
   * 所以半途看到的是「上半是旧句的下半截、下半是新句的上半截」，没有空档。
   * 未播完的动画先取消：连续快速换句时不排队，以最新一句为准。
   *
   * duration 由调用方给（PLAN 069）：排程路径按「距下一句还有多久」收缩，
   * 实到帧路径用它自己的剩余时间。
   */
  function playSwap(cur, dir, duration) {
    const reduced = window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // 上一次没播完的动画可能把窗口高度钉住了：先交还，再量真正的旧高度
    reelEl.style.height = '';
    const height = reelEl.getBoundingClientRect().height
      || plateEl.getBoundingClientRect().height;
    if (reduced || !(height > 0)) {
      resetGhost();
      applyLineText(cur);
      return;
    }

    ghostEl.getAnimations().forEach((anim) => anim.cancel());
    plateEl.getAnimations().forEach((anim) => anim.cancel());
    movePlateToGhost();
    // 新句先写进板，但整块停在窗口的「来向」一侧
    applyLineText(cur);

    // 窗口高度在这一格滚动期间钉住：不钉的话新句更高时 #reel 会立刻长高，
    // 旧句下方露出一条空档（PLAN 068 的「下一句探进来」）。滚动结束后交给内容自己算。
    const travel = height;
    reelEl.style.height = travel + 'px';

    const durationMs = Math.min(SWAP_MS, Math.max(SWAP_MIN_MS, duration || SWAP_MS));
    // 这段时间里迟到帧不许把字幕滚回去（见 isStaleFrame）
    swapEndsAt = performance.now() + durationMs;
    const out = ghostEl.animate([
      { transform: 'translateY(0)' },
      { transform: 'translateY(' + (-dir * travel) + 'px)' },
    ], { duration: durationMs, easing: SWAP_EASE });
    plateEl.animate([
      { transform: 'translateY(' + (dir * travel) + 'px)' },
      { transform: 'translateY(0)' },
    ], { duration: durationMs, easing: SWAP_EASE });

    out.onfinish = () => {
      resetGhost();
    };

    nudgeCtx(dir, durationMs);
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
      hasCtx && prefs.ctx >= 2 ? lastPayload.prev : null, 'prev');
    renderCtx(nextEl, nextPrimary, nextSecondary,
      hasCtx && prefs.ctx >= 1 ? lastPayload.next : null, 'next');

    lineSecondary.classList.toggle('hidden', lastPayload
      ? (lastPayload.style && lastPayload.style.dual === false) || !prefs.dual
        || !lineSecondary.textContent
      : false);
  }

  /**
   * 上下文行：相邻句的译文本就晚一拍才到（骨架先只有原文），单帧也可能整块缺失。
   * 这里做两件抗抖的事（PLAN 066）：
   *   1. 同一句（primary 没变）时，新帧没带译文就沿用上一次的 —— 中文不再闪一下；
   *   2. 整块延迟 260ms 再收起 —— 换句瞬间的空帧不会把行藏起来。
   */
  const ctxMemo = {
    prev: { primary: '', secondary: '', timer: 0 },
    next: { primary: '', secondary: '', timer: 0 },
  };

  function renderCtx(block, primaryEl, secondaryEl, cue, slot) {
    const memo = ctxMemo[slot];
    const primary = cue && cue.primary ? cue.primary : '';
    let secondary = cue && cue.secondary ? cue.secondary : '';
    if (prefs && prefs.dual && primary && primary === memo.primary && !secondary) {
      secondary = memo.secondary;
    }
    if (primary) {
      memo.primary = primary;
      if (secondary) memo.secondary = secondary;
    } else {
      memo.primary = '';
      memo.secondary = '';
    }
    // 幂等：同一帧里每秒会来好几次，无谓的 textContent 赋值会白白触发排版
    if (primaryEl.textContent !== primary) primaryEl.textContent = primary;
    if (secondaryEl.textContent !== secondary) secondaryEl.textContent = secondary;
    secondaryEl.classList.toggle('hidden', !secondary);

    if (primary) {
      clearTimeout(memo.timer);
      memo.timer = 0;
      block.classList.remove('hidden');
    } else if (!memo.timer) {
      memo.timer = setTimeout(() => {
        memo.timer = 0;
        if (!primaryEl.textContent) block.classList.add('hidden');
      }, 260);
    }
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
    // 缓冲（PLAN 070）与暂停同义：两条进度都不要再本地推进
    const playing = payload.playing !== false && payload.stalled !== true;
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

    // 换句排程寄生在这个循环里（PLAN 069）：不另开 rAF，也不依赖推送到达
    tickSwap(now);

    requestAnimationFrame(paintProgress);
  }

  function render(payload) {
    if (!payload) return;
    // 同一拍里只取一次：performance.now() 是排程与动画的共用基准，
    // Date.now() 是延迟估计的到达时刻（两者不能互相换算，见 noteQueueDelay）
    const now = performance.now();
    const arrivalWall = Date.now();
    // 静态块（PLAN 071）：只在变化时随帧来，其余帧用缓存补齐，后面全按完整帧走
    if (payload.static && typeof payload.static === 'object') staticBlock = payload.static;
    if (staticBlock) {
      for (const name of STATIC_FIELDS) {
        if (payload[name] === undefined) payload[name] = staticBlock[name];
      }
    }
    // 整条轨（PLAN 072）：块来了就拼，攒齐后断流也能继续换句
    if (payload.track && typeof payload.track === 'object') mergeTrack(payload.track);
    const style = payload.style || {};
    // 服务端重启会让 seq 从头开始：比上次小就当成新的一条流，否则会一直忽略帧
    if (payload.seq < lastSeq) {
      lastSeq = -1;
      lastCurKey = '';
      // 换了服务端进程：两条进度都重新起算，别接着上一段的时钟走
      videoClock.active = false;
      cueClock.active = false;
      // 延迟样本与换句排程都属于上一条流，全部作废（偏差是同一台机器的，留着）
      queue.samples = [];
      queue.min = null;
      clearSwapPlan();
    }
    if (payload.seq === lastSeq) return;
    lastSeq = payload.seq;
    lastPayload = payload;
    // 断流判据（PLAN 072）：多久没收到新帧，决定要不要用整轨自己续播
    lastFrameAt = now;

    if (!prefs) prefs = readPrefs();
    if (!prefs) seedPrefs(style);
    if (style.primaryLang) langPrimary = style.primaryLang;
    if (style.secondaryLang) langSecondary = style.secondaryLang;

    const cur = payload.cur || {};
    // 手机本地也留一份句子历史：快照没带 cues（旧扩展）时选句靠它兜底
    rememberCue(payload.cue, cur.primary);

    // 选句中：字幕由手势驱动（PLAN 067），推送只更新控件与状态，不抢文字 ——
    // 否则每 250ms 一帧就会把手里选的那句换回正在播的那句。
    if (picking) {
      // 选句期间字幕由手势驱动：排程也必须停，否则到点会把候选句滚走（PLAN 069）
      clearSwapPlan();
      paintControls(payload);
      setStatus(payload.playing === false ? '已暂停' : '已连接', true);
      return;
    }

    const cueStart = payload.cue && Number.isFinite(payload.cue.start) ? payload.cue.start : null;
    const key = lineKey(cur);
    const secondaryText = cur.secondary || '';
    const lineChanged = key !== lastCurKey || lineSecondary.textContent !== secondaryText;
    // 方向：新句时间更靠后就是往后翻；拖动选句往回跳时反过来
    const swapDir = lastCueStart != null && cueStart != null && cueStart < lastCueStart ? -1 : 1;
    if (cueStart != null) lastCueStart = cueStart;

    // 排程要用到「这一帧的取样时刻」：先更新本地时钟，再判陈旧帧、处理换句与重排
    updateFrameClock(payload, now, arrivalWall);
    // 排程换句会比这一帧更早把新句滚上来：之后陆续到达的「上一句」帧不能把它滚回去
    const stale = isStaleFrame(cueStart, now);

    // 空态与标题用推送里的文本立即更新，不等 110ms 的滑出动画
    // （陈旧帧不参与：否则标题与字幕会在换句窗口里来回跳）
    if (!stale) {
      stageEl.classList.toggle('empty', !(cur.primary || '').trim());
      // 每 250ms 一帧：先比对再写（与 renderCtx 的口径一致），否则 title 会一直进
      // MutationRecord，标签页标题也在无意义地重算
      const nextTitle = cur.primary || '字幕屏';
      if (document.title !== nextTitle) document.title = nextTitle;
    }

    applyPrefs();
    if (lineChanged && !stale) {
      // 排程已经把这句滚上来了（PLAN 069）：这一帧只补 segments / 译文，不能再滚第二次
      const alreadyShown = cueStart != null && shownCueStart != null && cueStart === shownCueStart;
      if (alreadyShown) {
        applyLineText(cur);
      } else {
        // 实到帧是最终依据：先用它校准排程偏差，再决定这次换句的时长
        observeSwap(now, cueStart);
        const scheduled = swapCtl.start != null && cueStart != null
          && Math.abs(swapCtl.start - cueStart) <= 0.02;
        const remaining = scheduled ? swapCtl.due - now : SWAP_MS;
        clearSwapPlan();

        if (plateEl.textContent && remaining > SWAP_CUT_MS) {
          playSwap(cur, swapDir, Math.min(SWAP_MS, remaining));
        } else {
          resetGhost();
          plateEl.getAnimations().forEach((anim) => anim.cancel());
          applyLineText(cur);
        }
        shownCueStart = cueStart;
      }
    }

    // 两条进度都交给本地时钟插值（paintProgress 每帧刷），这里只重设基准。
    // progress 缺失（null）= 扩展说「这一拍不可信」，不能折成 0（PLAN 062）
    const rawProgress = payload.progress;
    const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(1, rawProgress)) : null;
    syncClocks(payload, progress, cur.primary || '', now);

    // 帧里带了未来的句子时间表就重排下一个换句点（拿不到时这里是空操作）
    planSwap(payload, now);

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
    // 注意：这里的反斜杠在模板字符串里要写两层，否则页面拿到的是 /.$/，
    // 会把 "1.25" 的末位数字删掉，显示成 "1.2×"
    return String(Math.round(rate * 100) / 100).replace(/0+$/, '').replace(/\\.$/, '') + '×';
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

  // ================================================================ 上下滑动选句（PLAN 045 → 067）
  //
  // 手指在字幕区上滑 → 候选句从「当前句」往前翻；滑得越远跳得越多（46px 一句）。
  // 松手 300ms 后发一条 seek 命令，由扩展把 Mac 上的 video.currentTime 设到该句开头。
  // 列表优先用扩展推来的 cues 窗口（当前句往前 40 句），没有时用本机累积的历史。
  //
  // PLAN 067：这里**不再有浮层**。候选句直接写在 #plate 上，字号 / 颜色 / 投影
  // 全部沿用当前外观，上下句也走原来的 #prev / #next；看起来就是字幕自己在滚。
  // 拖动期间 render() 会跳过文字更新（见 picking 分支），否则 250ms 一帧的推送
  // 会把手里的候选句抢回正在播的那句。

  /** 每滑这么多像素移动一句（一行的高度，手感接近「翻一格」） */
  const PICK_ROW_PX = 46;
  /** 超过这个纵向距离才认为是「要选句」，而不是误触 */
  const PICK_OPEN_PX = 26;
  /** 松手后等这么久再 seek：手指离开屏幕后仍有最后一次位移 */
  const PICK_SEND_DELAY = 300;

  /** 快照没带 cues 时的兜底：手机自己记下看过的句子 */
  const cueHistory = [];

  let picking = false;
  let pickList = [];
  let pickIndex = 0;
  let pickBaseIndex = 0;
  let pickStartY = 0;
  let pickTravel = 0;
  let pickTimer = 0;
  /**
   * 手势开始时正在播的那句：句子窗口是打开选句那一刻的快照，拖动期间视频还在走，
   * 拿实时 cue 去比会让「第几句」「有没有译文」随推送漂移，所以入口处冻结这三个值。
   */
  let pickAnchorIndex = 0;
  let pickAnchorStart = null;
  let pickAnchorSecondary = '';
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

  /** 推送里正在播的那句的起点；拿不到时返回 null */
  function liveStart() {
    const cue = lastPayload && lastPayload.cue;
    const start = cue ? Number(cue.start) : NaN;
    return Number.isFinite(start) ? start : null;
  }

  /** 选中的是不是「打开选句那一刻正在播」的那句（只有它带译文） */
  function pickIsLive() {
    const item = pickList[pickIndex];
    return !!item && pickAnchorStart != null
      && Math.abs(Number(item[0]) - pickAnchorStart) < 0.01;
  }

  /** 底部那行说明：滑到第几句、对应时间 */
  function updatePickBadge() {
    const item = pickList[pickIndex];
    if (!item) {
      pickBadgeText.textContent = '';
      return;
    }
    const delta = pickIndex - pickAnchorIndex;
    const where = delta === 0
      ? '松手回到这句'
      : (delta < 0 ? '早 ' : '晚 ') + Math.abs(delta) + ' 句';
    const text = fmtClock(item[0]) + ' · ' + where;
    if (pickBadgeText.textContent !== text) pickBadgeText.textContent = text;
  }

  /** 候选句的上下文：复用 #prev / #next，跟随设置里的「上下文」档位 */
  function paintPickCtx(block, primaryEl, secondaryEl, item, want) {
    const primary = want && item ? String(item[1] || '') : '';
    if (primaryEl.textContent !== primary) primaryEl.textContent = primary;
    // 候选句只有原文（cues 是 [start, primary]），选句期间译文行留空
    if (secondaryEl.textContent) secondaryEl.textContent = '';
    secondaryEl.classList.add('hidden');
    block.classList.toggle('hidden', !primary);
  }

  /**
   * 把候选句写到字幕位上，而不是另画一层。
   *
   * 只有命中正在播的那句时才带译文：cues 里每句只有原文，凭空补译文会给出
   * 一句和原文对不上的中文。其余情况让译文行空着，看到的就是真实原文。
   */
  function paintPick() {
    const cur = pickList[pickIndex] || null;
    const prev = pickList[pickIndex - 1] || null;
    const next = pickList[pickIndex + 1] || null;
    const dual = !prefs || prefs.dual;
    const secondary = pickIsLive() && dual ? pickAnchorSecondary : '';

    // 选句写的是纯文本：清掉 segments 指纹，交回推送时才会按 segments 重建原文
    lastCurKey = '';
    plateEl.getAnimations().forEach((anim) => anim.cancel());
    const primaryText = cur ? String(cur[1] || '') : '';
    if (linePrimary.textContent !== primaryText) linePrimary.textContent = primaryText;
    // 译文行占着位：候选中只有正在播的那句有译文，直接撤掉这一行会让原文上下跳一格。
    // 用零宽字符撑住行高，松手回到实时字幕时再按真实内容重排。
    const secondaryText = dual ? (secondary || '\\u200b') : '';
    if (lineSecondary.textContent !== secondaryText) lineSecondary.textContent = secondaryText;
    lineSecondary.classList.toggle('hidden', !dual);
    fitBothLines();

    paintPickCtx(prevEl, prevPrimary, prevSecondary, prev, !prefs || prefs.ctx >= 2);
    paintPickCtx(nextEl, nextPrimary, nextSecondary, next, !prefs || prefs.ctx >= 1);
    updatePickBadge();
  }

  function openPick() {
    const list = pickerSource();
    if (!Array.isArray(list) || list.length < 2) return false;
    pickList = list;
    // 列表最后一项就是正在播的这句：从它开始往前翻
    pickIndex = pickList.length - 1;
    pickBaseIndex = pickIndex;
    pickAnchorIndex = pickIndex;
    pickAnchorStart = liveStart();
    pickAnchorSecondary = (lastPayload && lastPayload.cur && lastPayload.cur.secondary) || '';
    picking = true;
    // 换句排程停在手势上（PLAN 069）：到点把候选句滚走等于抢用户的手
    clearSwapPlan();
    resetGhost();
    plateEl.getAnimations().forEach((anim) => anim.cancel());
    // 空态会把字幕整块 visibility: hidden —— 选句期间得先把面板露出来
    stageEl.classList.remove('empty');
    stageEl.classList.add('picking');
    pickBadge.classList.add('show');
    paintPick();
    return true;
  }

  function closePick() {
    picking = false;
    stageEl.classList.remove('picking');
    pickBadge.classList.remove('show');
    clearTimeout(pickTimer);
    pickTimer = 0;
    // 推送迟到 / 断流时不能把选句文本留在屏上：立刻回到上一次推送的画面
    if (lastPayload) {
      lastCurKey = '';
      applyLineText(lastPayload.cur || {});
      applyPrefs();
      const live = lastPayload.cur || {};
      stageEl.classList.toggle('empty', !(live.primary || '').trim());
      // 屏上已经是这一句了：下一帧不该再为同一句滚一次（PLAN 069 的去重口径）
      const start = Number(lastPayload.cue && lastPayload.cue.start);
      shownCueStart = Number.isFinite(start) ? start : shownCueStart;
    }
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
    if (picking) {
      // 选句进行中又落下第二根手指：以当前选中为基准重新算
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
    if (!picking) {
      if (Math.abs(dy) < PICK_OPEN_PX) return;
      if (!openPick()) return;
    }
    // 已经在选句：别让 iOS 把这次滑动当成页面回弹
    if (ev.cancelable) ev.preventDefault();
    pickTravel = dy;
    // 上滑（dy < 0）= 往更早的句子走
    const next = Math.max(
      0,
      Math.min(pickList.length - 1, pickBaseIndex + Math.round(dy / PICK_ROW_PX)),
    );
    if (next !== pickIndex) {
      pickIndex = next;
      paintPick();
    }
  }

  function onPickEnd() {
    if (pickBlocked) {
      pickBlocked = false;
      return;
    }
    if (!picking) return;
    // 只滑了一点点就松手：当误触，收起高亮不跳
    if (Math.abs(pickTravel) < PICK_ROW_PX / 2) {
      closePick();
      return;
    }
    clearTimeout(pickTimer);
    // 留 300ms 让手指离开后仍能看到「选中的是哪句」，再跳过去
    pickTimer = setTimeout(() => {
      const item = pickList[pickIndex];
      if (item) sendControl('seek', Number(item[0]) || 0);
      closePick();
    }, PICK_SEND_DELAY);
  }

  document.addEventListener('touchstart', onPickStart, { passive: true });
  document.addEventListener('touchmove', onPickMove, { passive: false });
  document.addEventListener('touchend', onPickEnd, { passive: true });
  document.addEventListener('touchcancel', () => {
    pickBlocked = false;
    if (picking) closePick();
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
  // 先测一次时钟差（PLAN 075），再按 30 秒的节奏复测；服务端没有 /ping 时自动退回
  syncClock();
  setInterval(syncClock, 30000);
  connect();
})();
</script>
</body>
</html>`;
}
