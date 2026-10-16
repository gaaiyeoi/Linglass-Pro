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
 *   外观 —— 照搬官方「外观」设置（样式 / 字号 / 颜色 / 双语），见下面的「原生外观」一节
 *
 * ── 常驻语义（本文件最容易被改坏的部分，先读这段）──
 *
 * 期望：**用户一旦打开，就只有我们自己的按钮/开关能关掉它。**
 *
 * ⚠️ 默认值是 **false**（PLAN 025，用户选择「视频内嵌字幕优先」）：官方那层字幕本来
 * 就在画面里显示，没表过态时不该再自动多弹一扇系统窗口。下面这套「窗口消失了也要
 * 自己回来」的语义只对**已经开着**的人成立 —— 没开过的人，第一次开窗仍然是一次
 * 用户手势（控制栏按钮 / 设置面板开关）。
 *
 * 但「窗口消失」这件事不归我们管：规范允许 UA 自行关闭 PiP 窗口
 * （Document PiP §5 步骤 9 / §6.4），opener 文档被销毁或导航时更是强制关闭
 * （§6.6 / §6.7）—— 用户点窗口自己的 X、切到别的应用、刷新页面、真导航换视频、
 * 扩展重载，都会让窗口消失。
 *
 * 所以我们不去阻止关闭（阻止不了），而是把「窗口消失」一律当成**中间态**：
 *
 *   enabled（落盘，默认 false）= 用户希望它开着。**写入口只有两处**：
 *   open() 写 true，close() 写 false（close 只由控制栏按钮 / 设置面板开关触发）。
 *
 *   pagehide 时：只要不是我们自己的 close()（closingByUs），且 enabled 还是 true，
 *   就立刻想办法把窗口弄回来 —— 于是**只有按钮/开关能真正关掉它**。
 *
 *   为什么不区分「谁关的」：用户点 X 与文档卸载（刷新 / 导航）在 pagehide 里
 *   **区分不了**（刷新时 document.visibilityState 仍是 'visible'）。早期版本按
 *   「疑似点 X 就当用户不要了」处理并落盘 enabled = false，结果是**每次刷新都会把
 *   用户的开关关掉**，只能再手点按钮才能回来。既然关闭权只归按钮，这个区分就没有
 *   存在的意义了（对应地，isInvoluntaryClose()/lastVisibleAt 那一套也一并删掉）。
 *
 * 「立刻弄回来」不一定成功：requestWindow() 必须在瞬时用户激活内调用。
 * 所以恢复是「**有激活才试**」：
 *   有激活（用户正点着页面）→ 试一次；被拒就 arm() 一个一次性手势监听
 *   没激活（刷新 / 真导航 / 系统悄悄收走窗口）→ **连试都不试**，直接 arm()
 * 用户下一次点击/按键时打开（「开了就一直开着」就是靠这条路径生效的）。没激活还去调
 * requestWindow() 只会换来一条 'Document PiP requires user activation' 的红字，
 * 让用户以为功能坏了 —— 见 open() 里的 hasActivation()。
 *
 * **关窗这件事不归我们**：切回浏览器本体（把系统焦点/可见性还给 opener）时，UA 会把
 * 窗口收走。规范只把它列为裁量（§5 步骤 9 的 "Optionally, the user agent can close
 * any existing picture-in-picture windows."、§6.10 的 "…does not necessarily need to
 * close…"），而 `disallowReturnToOpener: true` 只是「不显示那个返回标签页的按钮」的
 * **hint**（MDN / Chrome 文档口径一致，且只在 Chrome 124+ 存在），拦不住它。
 * 代码里能关掉窗口的只有 close()（我们自己的 UI）与 cleanupOrphan()（内容脚本重新
 * 注入时清残留）——「回到浏览器」这条路径上没有任何一处会关它，也不该去试。
 *
 * 于是「回到浏览器」的那些时机（visibilitychange / window focus，见 wake()）做两件事：
 *   先把本地状态跟浏览器对齐（syncWindow()：窗口其实已经被收走时清干净，且不写 enabled），
 *   再尽量试一次开窗 —— 用户若是「点着页面回来」的，那一下带着瞬时激活，浮窗当场就回来；
 *   否则照旧 arm()，等下一次手势。
 *
 * arm() 的手势监听**跳过落在我们自己的按钮/开关上的手势**（见 onOurOwnUi()）：
 * 那些点击有自己的 click 处理器（控制栏按钮的 onClick、设置面板开关的 toggle），
 * 在 pointerdown 阶段预开会和它抢同一次点击 —— 先开、紧接着被 close() 关掉。
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
  /**
   * 设置面板里我们自己那些开关按钮（50-settings-panel.js 打的标记）。
   * 只读依赖：用来认出「这次手势是要开/关浮窗」，而不是「用户顺手点了下页面」。
   */
  const TOGGLE_SELECTOR = '[data-llg-toggle]';
  const LABEL_IDLE = '桌面字幕';
  const LABEL_ON = '关闭桌面字幕';
  const LABEL_UNSUPPORTED = '当前浏览器不支持桌面字幕';
  // 心跳间隔不在这里定义：定时器由 00-shared.js 的共享心跳统一驱动（1s，见文件末尾）

  const PIP_WIDTH = 1000;
  /** 比只放两行字幕时高一些：底部留出播放控制栏（见 PIP_BASE_CSS 的 #bar） */
  const PIP_HEIGHT = 264;

  /**
   * 倍速循环按钮的档位（见 command('rate')）。
   * 用固定档位而不是滑块：浮窗是系统窗口，拖滑块的手感与命中面积都不好，
   * 而且档位是学习场景里真正会用的那几个。
   */
  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
  /** 快退/快进的步长（秒） */
  const SEEK_STEP = 5;
  /** 上一句：播到句中超过这么久时，先把本句拉回开头，再按一次才是上一句 */
  const RESTART_CUE_AFTER = 1;
  /** 只在播放/暂停/倍速变化时重画控制栏，这几个事件类型就够了 */
  const VIDEO_STATE_EVENTS = ['play', 'pause', 'ratechange'];

  /** 常驻开关的落盘键。默认 false —— 用户没表过态时只显示画面内那层官方字幕 */
  const STORE_KEY = 'llgPip';

  /** 触发「下一次手势就开」的事件。pointerdown 覆盖鼠标/触摸，keydown 覆盖键盘用户 */
  const GESTURE_EVENTS = ['pointerdown', 'keydown'];

  /** 与 15-ja-break.js 的 ::after 观感对齐（那边是 margin: 0 .14em） */
  const THIN_SPACE = '\u2009';
  /** 浮窗里分隔符节点的 class（样式见 pipCss：与视频内那套同一份观感） */
  const SEP_CLASS = 'llg-sep';

  // ---------------------------------------------------------------- 原生外观
  //
  // 浮窗的排版照搬官方字幕：字体栈、字重、字号、颜色、底板、阴影/描边全部来自官方
  // 「外观」设置页（样式 / 字号 / 颜色 / 双语）—— 用户在那边改，浮窗跟着变。
  //
  // 读法与官方一致：chrome.storage.sync['linglass-settings']。官方用 zustand persist
  // 落盘，值是对象还是 JSON 字符串两种形态都出现过，所以两种都兜。
  //
  // 与官方唯一的偏差：**字号不乘播放器高度**。官方是
  //   base = max(11, max(playerHeight * .0333, 24) * scale/100)
  // 会跟着播放器尺寸变（剧场 / 全屏就放大）。浮窗没有「播放器尺寸」这个概念，
  // 而用户要的是「设置是多少就是多少」，所以这里只取官方的基座 24px 乘档位：
  // 浮窗拉大拉小、播放器进全屏，字号都不动。
  //
  // 取值出处（vendor/linglass-1.12.3/assets/，官方一发版文件哈希就变，只记名字前缀）：
  //   settings-*.js    默认设置 pe、预设表 f、字号 Se()、阴影/描边 re() 与 R()、色板
  //   promoCards-*.js  落盘读取、译文行的 adjustColorOpacity()、底板用色 primaryBgColor
  //                    （默认 #000000，官方外观页里能换的是**文字**颜色）

  /** 官方外观设置的落盘键（chrome.storage.sync） */
  const SETTINGS_KEY = 'linglass-settings';

  /** 官方 f.classic.font 等字体栈 */
  const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const FONT_COMIC_LATIN = '"Trebuchet MS", "Segoe UI", Verdana, system-ui, sans-serif';
  const FONT_COMIC_JA = '"Hiragino Maru Gothic ProN", "Hiragino Maru Gothic", "Yu Gothic",'
    + ' YuGothic, Meiryo, sans-serif';

  /** 官方 C：comic 预设把这几种语言的字面换成手写体 */
  const COMIC_LANGS = [
    'en', 'de', 'fr', 'es', 'it', 'pt-BR', 'pt-PT', 'nl', 'sv', 'pl', 'cs', 'tr', 'id', 'ru', 'uk',
  ];
  /** 官方 fe：这三种语言的原文行放大一档、加粗一档 */
  const CJK_LANGS = ['zh', 'ja', 'ko'];

  /** 官方 U / y：100% 档位的基座字号与字号下限 */
  const BASE_FONT_PX = 24;
  const MIN_FONT_PX = 11;
  /** 官方 D.FONT_SIZE_RATIO / x.SECONDARY_RATIO */
  const CJK_FONT_RATIO = 27 / 24;
  const SECONDARY_RATIO = 20 / 24;
  /** 官方 x：整块底板（classic）的内边距与圆角，按 metricScale 缩放 */
  const PLATE_PAD_Y = 8;
  const PLATE_PAD_X = 16;
  const PLATE_RADIUS = 8;
  /** 官方 le()：逐行底板（contrast）的尺寸系数 */
  const LINE_PAD_Y = .14;
  const LINE_PAD_X = .42;
  const LINE_RADIUS = .16;
  const LINE_GAP = .14;
  /** 官方 primaryBgColor 的默认值：底板是黑的，用户能换的是文字颜色 */
  const PLATE_COLOR = '#000000';
  /** 官方描边环的方向数（浏览器不支持 paint-order 时才铺） */
  const OUTLINE_STEPS = 8;

  /** 官方默认设置（settings-*.js 的 pe 里浮窗用得上的那几项） */
  const DEFAULT_APPEARANCE = {
    style: 'classic',
    scale: 100,
    color: '#FFFFFF',
    dual: true,
    primaryLang: null,
    secondaryLang: null,
  };

  /**
   * 官方四套预设（settings-*.js 的 f），字段名照抄，便于以后与官方对照：
   *   plate  block = 整块一个矩形（classic）、line = 每行各自一个（contrast）、none = 不画
   *   shadow 阴影类型，取值与官方 R() 的 switch 一致
   */
  const STYLE_SPECS = {
    classic: {
      font: FONT_SANS,
      primaryWeight: 500,
      secondaryWeight: 400,
      plate: 'block',
      plateOpacity: .8,
      plateBlur: true,
      outlineEm: 0,
      shadow: 'plate',
      secondaryAlpha: .75,
      letterSpacingEm: 0,
    },
    cinema: {
      font: FONT_SANS,
      primaryWeight: 600,
      secondaryWeight: 500,
      plate: 'none',
      plateOpacity: 0,
      plateBlur: false,
      outlineEm: .055,
      shadow: 'depth',
      secondaryAlpha: 1,
      letterSpacingEm: .004,
    },
    comic: {
      font: FONT_SANS,
      displayFont: { stack: FONT_COMIC_LATIN, langs: COMIC_LANGS },
      langOverrides: { ja: FONT_COMIC_JA },
      primaryWeight: 700,
      secondaryWeight: 600,
      plate: 'none',
      plateOpacity: 0,
      plateBlur: false,
      outlineEm: .085,
      shadow: 'offset',
      secondaryAlpha: 1,
      letterSpacingEm: .008,
    },
    contrast: {
      font: FONT_SANS,
      primaryWeight: 600,
      secondaryWeight: 500,
      plate: 'line',
      plateOpacity: .88,
      plateBlur: false,
      outlineEm: 0,
      shadow: 'none',
      secondaryAlpha: 1,
      letterSpacingEm: 0,
    },
  };

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  /**
   * #RRGGBB → [r, g, b]。
   * 官方对残缺值直接当黑处理（hexToRGBA 里长度不等于 6 就走 '000000'），这里同样兜住。
   */
  function hexChannels(hex) {
    const raw = String(hex == null ? '' : hex).replace('#', '');
    const value = /^[0-9a-fA-F]{6}$/.test(raw) ? raw : '000000';
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
    ];
  }

  /** 官方 hexToRGBA()：第二个参数是百分比 */
  function hexToRgba(hex, alphaPercent) {
    const [r, g, b] = hexChannels(hex);
    return `rgba(${r}, ${g}, ${b}, ${alphaPercent / 100})`;
  }

  /** 官方 adjustColorOpacity()：同一个颜色换个不透明度（译文行用它） */
  function colorWithAlpha(hex, alpha) {
    const [r, g, b] = hexChannels(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function styleSpecOf(style) {
    return STYLE_SPECS[style] || STYLE_SPECS.classic;
  }

  /** 官方 oe()：预设默认字体 → 这门语言有专门字面（comic 的日语）就换掉 */
  function fontStackOf(spec, lang) {
    if (lang && spec.langOverrides && spec.langOverrides[lang]) return spec.langOverrides[lang];
    if (lang && spec.displayFont && spec.displayFont.langs.includes(lang)) {
      return spec.displayFont.stack;
    }
    return spec.font;
  }

  function isCJK(lang) {
    return CJK_LANGS.includes(lang);
  }

  /**
   * 官方 Se()：基座字号 → 原文行 / 译文行。
   * 只有一处不同：官方拿播放器高度算 base，我们固定用 24px 基座（见本节顶部说明）。
   */
  function fontSizeOf(target) {
    const base = Math.max(MIN_FONT_PX, BASE_FONT_PX * (target.scale / 100));
    return {
      base,
      primary: isCJK(target.primaryLang) ? base * CJK_FONT_RATIO : base,
      secondary: Math.max(MIN_FONT_PX, base * SECONDARY_RATIO),
    };
  }

  /** 官方 ie()：原文语言是 CJK 时加粗一档 */
  function primaryWeightOf(spec, target) {
    return isCJK(target.primaryLang)
      ? Math.min(700, spec.primaryWeight + 100)
      : spec.primaryWeight;
  }

  /** 官方 R()：三种阴影类型，系数照抄 */
  function shadowOf(shape, px) {
    switch (shape) {
      case 'plate':
        return `0 ${px(.083)}px ${px(.333)}px rgba(0, 0, 0, 0.8)`;
      case 'depth':
        return `0 ${px(.04)}px ${px(.13)}px rgba(0, 0, 0, 0.6)`;
      case 'offset':
        return `${px(.05)}px ${px(.05)}px 0 rgba(0, 0, 0, 0.62)`;
      default:
        return 'none';
    }
  }

  /**
   * 官方 re()：阴影 + 描边。
   * 支持 paint-order 就直接描边（更干净），不支持才铺一圈 8 向 text-shadow。
   */
  function textEdgeOf(spec, basePx, paintOrderSupported) {
    const px = (ratio) => round1(basePx * ratio);
    const shadow = shadowOf(spec.shadow, px);

    if (!(spec.outlineEm > 0)) return { shadow, stroke: '0', paintOrder: 'normal' };

    const ring = Math.max(1, round1(basePx * spec.outlineEm));
    if (paintOrderSupported) return { shadow, stroke: `${ring}px`, paintOrder: 'stroke fill' };

    const offsets = [];
    for (let i = 0; i < OUTLINE_STEPS; i += 1) {
      const angle = (Math.PI * 2 * i) / OUTLINE_STEPS;
      const x = (Math.cos(angle) * ring).toFixed(2);
      const y = (Math.sin(angle) * ring).toFixed(2);
      offsets.push(`${x}px ${y}px 0 rgba(0, 0, 0, 0.92)`);
    }
    const joined = offsets.join(', ');
    return {
      shadow: shadow === 'none' ? joined : `${joined}, ${shadow}`,
      stroke: '0',
      paintOrder: 'normal',
    };
  }

  function canPaintOrder() {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('paint-order', 'stroke fill');
  }

  /** 底板规则：block 画在整块上，line 画在每行上，none 什么都不画 */
  function plateCss(spec, basePx) {
    if (spec.plate === 'block') {
      const scale = basePx / BASE_FONT_PX;
      const blur = spec.plateBlur
        ? ' backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);'
        : '';
      return `#plate {
  padding: ${round1(PLATE_PAD_Y * scale)}px ${round1(PLATE_PAD_X * scale)}px;
  border-radius: ${round1(PLATE_RADIUS * scale)}px;
  background: linear-gradient(to bottom,
    ${hexToRgba(PLATE_COLOR, spec.plateOpacity * 75)},
    ${hexToRgba(PLATE_COLOR, spec.plateOpacity * 100)});${blur}
}`;
    }

    if (spec.plate === 'line') {
      return `.kline {
  padding: ${round1(LINE_PAD_Y * basePx)}px ${round1(LINE_PAD_X * basePx)}px;
  background: ${hexToRgba(PLATE_COLOR, spec.plateOpacity * 100)};
  border-radius: ${round1(LINE_RADIUS * basePx)}px;
}
.kline + .kline { margin-top: ${round1(LINE_GAP * basePx)}px; }`;
    }

    return '';
  }

  /** 与外观无关的部分：结构、进度条、控制栏。字号一律写死 px，不跟浮窗尺寸走 */
  const PIP_BASE_CSS = `
:root { color-scheme: dark; }
html, body { height: 100%; margin: 0; overflow: hidden; background: #0d0d0f;
  -webkit-font-smoothing: antialiased; }
#box { height: 100%; display: flex; flex-direction: column; box-sizing: border-box; }
#stage { flex: 1; min-height: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; padding: 10px 34px 0; gap: 8px; }
.kline { position: relative; display: inline-block; max-width: 100%; }
.kfill { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
  border-radius: var(--radius-sm, 8px); }
/* 填充是「读字时的背景」，不是装饰：官方 classic 底板本来就是 rgba(0,0,0,.8) 的深底，
   再压 30% 的蓝就成了「蓝块上的白字」。所以取一个只在扫读时够用、不跟文字抢对比的透明度。 */
#fill-primary { background: rgba(10, 132, 255, .16); }
#fill-secondary { background: rgba(10, 132, 255, .11); }
#line-primary, #line-secondary { position: relative; display: block;
  line-height: 1.3; text-align: center; white-space: pre-wrap; }
#stage:not(:has(#line-primary:not(:empty)))::before {
  content: "— 等待 Linglass 字幕 —";
  font-size: 15px; font-weight: 400; color: #7a7a80; letter-spacing: .04em; }

/* 播放控制栏：浮窗自己的按钮，直接操作宿主页面里的 video（同源）。
   字体栈是给控制栏用的 —— 字幕行不再继承它（那两行完全按官方外观走） */
#bar { display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 8px 12px 10px;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
#bar button { min-width: 42px; height: 30px; padding: 0 10px;
  border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
  background: rgba(255,255,255,.08); color: #fff;
  font: inherit; font-size: 13px; line-height: 1; cursor: pointer;
  transition: background .15s ease; }
#bar button:hover { background: rgba(255,255,255,.18); }
#bar button:active { background: rgba(255,255,255,.26); }
#bar button[disabled] { opacity: .32; cursor: default; }
#bar button[disabled]:hover { background: rgba(255,255,255,.08); }
#pip-toggle { min-width: 54px; font-size: 15px; }
#pip-rate { font-variant-numeric: tabular-nums; }
`;

  /**
   * 浮窗样式表 = 骨架（上面那段）+ 按官方规则生成的外观。
   * 一次生成整张写进 <style>；设置变了就整张重写，不会出现新旧两套规则打架。
   */
  function pipCss(target) {
    const spec = styleSpecOf(target.style);
    const size = fontSizeOf(target);
    const edge = textEdgeOf(spec, size.base, canPaintOrder());
    const letterSpacing = spec.letterSpacingEm ? `${spec.letterSpacingEm}em` : 'normal';
    const secondaryColor = spec.secondaryAlpha < 1
      ? colorWithAlpha(target.color, spec.secondaryAlpha)
      : target.color;

    return [PIP_BASE_CSS, plateCss(spec, size.base), `
#plate { display: flex; flex-direction: column; align-items: center;
  box-sizing: border-box; max-width: 100%; }
#line-primary { font-family: ${fontStackOf(spec, target.primaryLang)};
  font-size: ${round1(size.primary)}px; font-weight: ${primaryWeightOf(spec, target)};
  letter-spacing: ${letterSpacing}; color: ${target.color};
  text-shadow: ${edge.shadow}; -webkit-text-stroke-width: ${edge.stroke};
  -webkit-text-stroke-color: rgba(0, 0, 0, 0.92); paint-order: ${edge.paintOrder}; }
#line-secondary { font-family: ${fontStackOf(spec, target.secondaryLang)};
  font-size: ${round1(size.secondary)}px; font-weight: ${spec.secondaryWeight};
  letter-spacing: ${letterSpacing}; color: ${secondaryColor};
  text-shadow: ${edge.shadow}; -webkit-text-stroke-width: ${edge.stroke};
  -webkit-text-stroke-color: rgba(0, 0, 0, 0.92); paint-order: ${edge.paintOrder}; }
/* 振假名：只有官方这行本来就渲染了 <rt> 时才会出现（跟随官方，见 pushText 的 richTokens）。
   比原文小一号、稍淡，不吃原文的字距；有注音时行距要抬高，否则上标会贴住上一行 */
#line-primary:has(ruby) { line-height: 1.7; }
#line-primary rt { font-size: .5em; font-weight: 400; letter-spacing: 0; opacity: .72; }
/* 分隔符：与 15-ja-break.js 视频内那套（那边是 ::after）同一份观感 */
.${SEP_CLASS} { margin: 0 .14em; opacity: .42; font-weight: 400; }
`].join('\n');
  }

  /**
   * 官方设置的落盘值 → 浮窗用得上的那几项。
   *
   * 三种形态都要兜：zustand persist 的对象 `{state, version}`、被 JSON.stringify 过的
   * 字符串、以及更早版本直接铺平的设置对象。缺键/读不成 → 退回官方默认。
   */
  function parseSettings(raw) {
    let value = raw;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value);
      } catch {
        value = null;
      }
    }
    const state = value && typeof value === 'object' && value.state ? value.state : value;
    if (!state || typeof state !== 'object') return { ...DEFAULT_APPEARANCE };

    return {
      style: typeof state.subtitleStyle === 'string'
        ? state.subtitleStyle
        : DEFAULT_APPEARANCE.style,
      scale: Number.isFinite(state.subtitleScale) && state.subtitleScale > 0
        ? state.subtitleScale
        : DEFAULT_APPEARANCE.scale,
      color: typeof state.subtitleColor === 'string'
        ? state.subtitleColor
        : DEFAULT_APPEARANCE.color,
      dual: state.dualSubtitles !== false,
      primaryLang: state.learningLanguage == null ? null : state.learningLanguage,
      secondaryLang: state.nativeLanguage == null ? null : state.nativeLanguage,
    };
  }

  /** 换一份外观：窗口开着就整张重写样式表，并强制重画一次文本（双语开关可能变了） */
  function applyAppearance(next) {
    appearance = next;
    if (!pipWin || !styleEl) return;
    styleEl.textContent = pipCss(appearance);
    lastKey = '';
    pushText();
  }

  /** 读一次官方外观设置。storage 不可用（被裁剪的包）时保持默认值即可 */
  function loadAppearance() {
    try {
      return chrome.storage.sync
        .get(SETTINGS_KEY)
        .then((res) => applyAppearance(parseSettings(res && res[SETTINGS_KEY])))
        .catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

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
  /** 上一次写进进度条的百分比（先比对再写，见 pushProgress） */
  let lastFill = '';
  /** PiP 里那张 <style>（窗口重建时换引用，关窗时清掉） */
  let styleEl = null;
  /** 当前生效的外观（官方设置的投影，见「原生外观」一节） */
  let appearance = { ...DEFAULT_APPEARANCE };
  /**
   * 常驻开关（落盘）。true = 希望它开着。
   *
   * **默认 false**（PLAN 025）：用户选择「视频内嵌字幕优先」—— 官方那层字幕本来就在
   * 画面里显示（还能点词查词），没表过态时不该再自动多弹一扇系统窗口。落盘里
   * `enabled: true`（也就是关掉之前一直在用的）的人不受影响，照旧自己开回来。
   */
  let enabled = false;
  /** 待开的一次性手势监听器（armed 非空即已挂上） */
  let armed = null;
  /** 防止 pointerdown 的预开与随后的 click 各开一次 */
  let opening = false;
  /** 包住我们主动调用的 close()，用来把「我们关的」和「别人关的」分开 */
  let closingByUs = false;
  /** 已经挂上 play/pause/ratechange 的那个 video（换视频时要换手） */
  let boundVideo = null;

  function supported() {
    return 'documentPictureInPicture' in window;
  }

  function warn(msg) {
    console.warn(`[桌面字幕] ${msg}`);
  }

  // ------------------------------------------------- 本地状态 vs 浏览器里的真实窗口
  //
  // 背景（详见文件头「常驻语义」）：窗口消失不归我们管，而且 `pipWin` 只在 pagehide
  // 与心跳（最多晚 1s）里才会被清空。这段空窗期里，**读 `pipWin` 的代码会做出与事实
  // 相反的判断** —— 按钮以为「还开着」于是走了 close()（把常驻开关写成 false）、
  // arm() 以为「不必武装」于是下一次手势没人接、canAutoOpen() 以为「已经有窗口」
  // 于是把用户那一下带激活的点击白白浪费掉。这两个函数就是用来消掉这段空窗期的。

  /**
   * 浏览器里**此刻真有**的那扇浮窗；没有就是 null。
   *
   * 两个判据都要看：
   *   · `pipWin.closed` —— 窗口自己知道它被关了（同步、最直接）；
   *   · `documentPictureInPicture.window` —— 浏览器那边一个窗口都没有了。
   *
   * **刻意不比 WindowProxy 身份**：身份一旦不成立就会去 requestWindow()，而
   * requestWindow() 会顺手把同一个文档里还开着的那扇窗关掉（规范 §6.5 / requestWindow
   * 步骤 8）—— 那是「我们自己发指令关窗」唯一的一条路，不能靠一个包装对象身份去碰运气。
   */
  function liveWindow() {
    if (!pipWin) return null;
    if (pipWin.closed) return null;
    if (supported() && !documentPictureInPicture.window) return null;
    return pipWin;
  }

  /**
   * 把本地状态跟浏览器对齐：窗口已经不在时清干净（stop()），返回「此刻是否真有窗口」。
   *
   * ⚠️ 校准**只清状态，绝不写 enabled** ——「谁关的」（用户点 X / 浏览器收走 /
   * 文档卸载）在这里同样分不清，写下去就会把用户的开关搞丢（见 save() 的注释）。
   */
  function syncWindow() {
    if (pipWin && !liveWindow()) stop();
    return !!pipWin;
  }

  // ---------------------------------------------------------------- 文案渲染

  function currentLines() {
    const lines = track.readLines();
    if (!lines) return { primary: '', secondary: '' };
    return lines;
  }

  /**
   * 原文行按日语「文节」切开，分隔符单独成段。
   *
   * 这里改的是**浮窗自己的节点**，与 15-ja-break.js「不许碰官方字幕行文本流」那条约束
   * 无关 —— 那条约束保护的是官方点词/拖拽选词的字符偏移，浮窗里没有这回事。
   *
   * 返回片段而不是拼好的字符串，是因为分隔符要单独压样式（原生那套挂在 ::after 上：
   * 半透明 + 字重 400 + 固定间距），纯文本做不到这件事。
   *
   * 尊重视频内断句的开关：关着、或 15-ja-break.js 没加载（扩展被裁剪过）时只有一段。
   */
  /** 分隔符长什么样（与 15-ja-break.js 的 ::after content 同一份来源） */
  function separatorText() {
    const jaBreak = globalThis.__llgModJaBreak;
    return (jaBreak && jaBreak.SEPARATOR) || '|';
  }

  /**
   * 当前这一行的文节切点（纯文本偏移，严格升序，最后一点落在文本末尾）。
   * 断句开关关着、或 15-ja-break.js 没加载（扩展被裁剪过）时返回空数组。
   */
  function cuePoints(text) {
    const jaBreak = globalThis.__llgModJaBreak;
    const segment = globalThis.__llgModJaSegment;
    if (!text || !jaBreak || typeof jaBreak.isEnabled !== 'function' || !jaBreak.isEnabled()) {
      return [];
    }
    if (!segment || typeof segment.cut !== 'function') return [];
    const points = segment.cut(text);
    return points && points.length ? points : [];
  }

  function primaryParts(text) {
    const plain = [{ text: text || '', sep: false }];
    const points = cuePoints(text);
    if (!points.length) return plain;

    // cut() 的切点严格升序、且最后一点落在文本末尾，所以这样切不会丢尾巴
    const words = [];
    let prev = 0;
    for (const point of points) {
      if (point > prev) words.push(text.slice(prev, point));
      prev = point;
    }
    if (prev < text.length) words.push(text.slice(prev));
    if (!words.length) return plain;

    // 间距交给 .llg-sep 的 margin（与原生一致），这里不往文本里塞空格
    const parts = [];
    for (const word of words) {
      if (parts.length) parts.push({ text: separatorText(), sep: true });
      parts.push({ text: word, sep: false });
    }
    return parts;
  }

  /**
   * 当前原文行的「带注音结构」。跟随官方：官方这行渲染了 `<ruby>/<rt>` 才有值。
   *
   * 只有当它的纯文本与轨道读到的原文**完全一致**时才敢用 —— 两者口径本就同源
   * （都剥掉 rt），一旦对不上（行里有别的空白形态）就退回纯文本，不猜字符归属。
   */
  function richTokens(text) {
    if (!track || typeof track.readPrimaryRich !== 'function') return null;
    const rich = track.readPrimaryRich();
    if (!rich || !Array.isArray(rich.tokens) || !rich.tokens.length) return null;
    if (rich.text !== text) return null;
    return rich.tokens;
  }

  /**
   * 带注音的片段 → 段落（每段是一串 token，段与段之间放分隔符）。
   *
   * 与 primaryParts() 共用同一份文节切点。**切点落在带注音的片段内部时放弃这个切点**：
   * 注音挂在汉字上，把汉字切成两半没法表达（分隔符只是视觉提示，少一个总比给出错的
   * 注音好）。
   */
  function richSegments(tokens, points) {
    const segments = [];
    let seg = [];
    let acc = 0;
    let pi = 0;

    for (const token of tokens) {
      let rest = token;

      // 切点落在片段内部：没注音的可以切开，带注音的放弃这个切点
      while (pi < points.length && points[pi] > acc && points[pi] < acc + rest.text.length) {
        if (rest.ruby) {
          pi += 1;
          continue;
        }
        const offset = points[pi] - acc;
        seg.push({ text: rest.text.slice(0, offset), ruby: '' });
        segments.push(seg);
        seg = [];
        rest = { text: rest.text.slice(offset), ruby: '' };
        acc = points[pi];
        pi += 1;
      }

      seg.push(rest);
      acc += rest.text.length;

      // 切点正好落在片段末尾：在这里断开
      if (pi < points.length && points[pi] === acc) {
        segments.push(seg);
        seg = [];
        pi += 1;
      }
    }

    if (seg.length) segments.push(seg);
    return segments;
  }

  /**
   * 拼接后的可读文本（测试与探针用）。
   * 渲染不走它 —— 渲染用 primaryParts()，间距由 CSS 给。这里补上窄空格，
   * 读出来才是「昨日 | 買った」而不是「昨日|買った」。
   */
  function displayPrimary(text) {
    return primaryParts(text)
      .map((part) => (part.sep ? `${THIN_SPACE}${part.text}${THIN_SPACE}` : part.text))
      .join('');
  }

  /** 分隔符节点（与视频内那套同一份观感，样式见 pipCss 的 .llg-sep） */
  function makeSeparator(d) {
    const span = d.createElement('span');
    span.className = SEP_CLASS;
    span.textContent = separatorText();
    return span;
  }

  /** 带注音的 token → `<ruby>汉字<rt>かな</rt></ruby>`（官方 ruby() 的同款结构） */
  function makeRuby(d, token) {
    const ruby = d.createElement('ruby');
    ruby.append(d.createTextNode(token.text));
    const rt = d.createElement('rt');
    rt.textContent = token.ruby;
    ruby.append(rt);
    return ruby;
  }

  /** 片段 → 子节点。空片段不渲染，否则 #line-primary 不再是 :empty，占位文案就出不来了 */
  function renderSegments(line, parts) {
    if (!line) return;
    const d = pipWin.document;
    const nodes = [];
    for (const part of parts) {
      if (!part.text) continue;
      if (part.sep) {
        nodes.push(makeSeparator(d));
        continue;
      }
      const span = d.createElement('span');
      span.textContent = part.text;
      nodes.push(span);
    }
    line.replaceChildren(...nodes);
  }

  /** 富片段 → 子节点（`<ruby>` 或纯文本），段与段之间插分隔符 */
  function renderRichSegments(line, segments) {
    if (!line) return;
    const d = pipWin.document;
    const nodes = [];
    segments.forEach((seg, index) => {
      if (index) nodes.push(makeSeparator(d));
      for (const token of seg) {
        if (!token.text) continue;
        nodes.push(token.ruby ? makeRuby(d, token) : d.createTextNode(token.text));
      }
    });
    line.replaceChildren(...nodes);
  }

  function pushText() {
    if (!pipWin) return;

    const lines = currentLines();
    // 官方这行带注音（有 <rt>）就走富渲染，否则维持纯文本 + 分隔符 —— 跟随官方
    const tokens = richTokens(lines.primary);
    const parts = tokens ? null : primaryParts(lines.primary);
    // 双语关掉时官方也不显示译文行 —— 浮窗跟着它，别自作主张多给一行
    const secondary = appearance.dual ? lines.secondary : '';
    // 注音形态 / 分隔符开关 / 双语开关都进键：用户中途改设置时浮窗要重绘
    const key = tokens
      ? `r\u0001${tokens.map((token) => `${token.text}\u0002${token.ruby || ''}`).join('\u0001')}\u0000${secondary}`
      : `${parts.map((part) => part.text).join('\u0001')}\u0000${secondary}`;
    if (key === lastKey) return;
    lastKey = key;

    const d = pipWin.document;
    const line = d.getElementById('line-primary');
    if (tokens) renderRichSegments(line, richSegments(tokens, cuePoints(lines.primary)));
    else renderSegments(line, parts);
    setText(d.getElementById('line-secondary'), secondary);
  }

  /**
   * 进度条的宽度。先比对再写：本函数由 PiP 窗口自己的 rAF 每帧调用，而字幕的句内
   * 进度在 60fps 下必然大量重复（同一毫秒的百分比一样）—— 无谓的样式写入会白白
   * 让合成器重绘（AGENTS.md §3 的幂等规矩同样适用于这里）。
   */
  function pushProgress() {
    if (!pipWin) return;
    const percent = `${track.getProgress() * 100}%`;
    if (percent === lastFill) return;
    lastFill = percent;
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

  // ---------------------------------------------------------------- 播放控制栏
  //
  // 浮窗里的按钮直接操作宿主页面的 video（同一个内容脚本上下文，同源，不需要跨进程）。
  // 控制逻辑集中在一个 command(act) 里：DOM 只负责把 data-act 递进来，
  // 于是 Node 侧冒烟测试可以绕开 DOM 直接驱动它（见 __llgModPip.command）。

  /** 宿主页面里的 video（与 10-subtitle-track.js 用同一套选择器） */
  function video() {
    return document.querySelector('#movie_player video') || document.querySelector('video');
  }

  function nextRate(current) {
    const index = RATES.indexOf(current);
    return index === -1 ? 1 : RATES[(index + 1) % RATES.length];
  }

  /**
   * 上一句 / 下一句。
   *
   * 「上一句」有两段语义：已经播到句中（超过 RESTART_CUE_AFTER 秒）时，先把**本句**拉回
   * 开头；否则才退到上一句。这样连点两次 = 回到上一句，符合听写场景的直觉。
   */
  function seekCue(delta) {
    const el = video();
    const cues = track.getCues();
    if (!el || !cues.length) return;

    const current = track.getCurrent();
    let index = current ? current.index : -1;

    if (delta < 0 && index >= 0 && el.currentTime - cues[index].start > RESTART_CUE_AFTER) {
      el.currentTime = cues[index].start;
      return;
    }

    index += delta;
    if (index < 0 || index >= cues.length) return;
    el.currentTime = cues[index].start;
  }

  /**
   * 执行一个浮窗控制动作。返回 false 表示没有 video / 未知动作（调用方据此不做状态回显）。
   * @param {string} act toggle | back | fwd | prev | next | rate
   */
  function command(act) {
    const el = video();
    if (!el) return false;

    switch (act) {
      case 'toggle':
        if (el.paused) el.play();
        else el.pause();
        break;
      case 'back':
        el.currentTime = Math.max(0, el.currentTime - SEEK_STEP);
        break;
      case 'fwd':
        // duration 可能是 NaN/Infinity（直播、元数据未就绪），那就只按步长前进
        el.currentTime = Number.isFinite(el.duration)
          ? Math.min(el.duration, el.currentTime + SEEK_STEP)
          : el.currentTime + SEEK_STEP;
        break;
      case 'prev':
        seekCue(-1);
        break;
      case 'next':
        seekCue(1);
        break;
      case 'rate':
        el.playbackRate = nextRate(el.playbackRate);
        break;
      default:
        return false;
    }

    syncBar();
    return true;
  }

  /** 先比较再写：浮窗每帧/每秒都会跑一次，无谓的 DOM 变更会白白让合成器重绘 */
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setDisabled(el, disabled) {
    if (el && el.disabled !== disabled) el.disabled = disabled;
  }

  /** 把 video 的真实状态回显到控制栏（播放/暂停图标、倍速、上下句可用性） */
  function syncBar() {
    if (!pipWin) return;
    const d = pipWin.document;
    const el = video();
    const paused = !el || el.paused;

    const toggle = d.getElementById('pip-toggle');
    setText(toggle, paused ? '▶' : '⏸');
    if (toggle) {
      const label = paused ? '播放' : '暂停';
      if (toggle.getAttribute('aria-label') !== label) toggle.setAttribute('aria-label', label);
    }

    const rate = d.getElementById('pip-rate');
    setText(rate, `${el ? el.playbackRate : 1}×`);

    const cues = track.getCues();
    const current = track.getCurrent();
    const index = current ? current.index : -1;
    const canPrev = index > 0
      || (index === 0 && !!el && el.currentTime - cues[0].start > RESTART_CUE_AFTER);
    setDisabled(d.getElementById('pip-prev'), !canPrev);
    setDisabled(d.getElementById('pip-next'), cues.length === 0 || index >= cues.length - 1);
  }

  /** 播放状态下按钮图标要跟着变，所以要在 video 上直接听这几个事件（心跳只作兜底） */
  function bindVideoEvents() {
    const el = video();
    if (el === boundVideo) return;
    if (boundVideo) {
      for (const type of VIDEO_STATE_EVENTS) boundVideo.removeEventListener(type, syncBar);
    }
    boundVideo = el;
    if (boundVideo) {
      for (const type of VIDEO_STATE_EVENTS) boundVideo.addEventListener(type, syncBar);
    }
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

  /**
   * 落盘常驻开关。
   *
   * ⚠️ `enabled` 的写入口**只有两个**：`open()`（写 true）与 `close()`（写 false）。
   * **不要在 PiP 窗口的 pagehide 里写盘** —— 那里分不清「用户点了 X」与「文档卸载
   * （刷新 / 导航）」，写下去就会把用户的开关搞丢（用户报的正是这个，见文件头与
   * handlePageHide 的注释）。
   */
  function save() {
    try {
      chrome.storage.local.set({ [STORE_KEY]: { enabled } }).catch(() => {});
    } catch {
      // storage 不可用：内存里的状态仍然有效
    }
  }

  /**
   * 播放页里的那个 video。
   *
   * 刻意**不带** video() 那个 `document.querySelector('video')` 兜底：首页的缩略图
   * 预览也是 `<video>`，用兜底会在首页把浮窗弹出来。`#movie_player` 只存在于播放页
   * （/watch、/live/…），它才是「这是个播放页」的判据。
   */
  function playerVideo() {
    return document.querySelector('#movie_player video');
  }

  /**
   * 现在这个时机自动开窗有没有意义（播放页 + 有视频）。
   *
   * 判据里**不再有 location.pathname**：从首页 / 搜索页点视频封面时，pointerdown 发生在
   * SPA 导航完成之前，那一刻 pathname 还是 `'/'` —— 拿它当条件会把用户第一次手势
   * 白白丢掉（而且 arm() 的回调会先 disarm()，那一次点击就彻底没了）。
   */
  function canAutoOpen() {
    // syncWindow() 而不是 `pipWin`：浏览器刚把窗口收走时 `pipWin` 还是旧的，
    // 用它会判「已经有窗口了」，于是用户「回来点一下」那一下带激活的手势被白白浪费
    if (!supported() || !enabled || syncWindow()) return false;
    return !!playerVideo();
  }

  function disarm() {
    if (!armed) return;
    for (const type of GESTURE_EVENTS) document.removeEventListener(type, armed, true);
    armed = null;
  }

  /**
   * 这次手势是不是落在**我们自己的**按钮 / 开关上。
   *
   * 是的话，开/关这件事归那个按钮自己的 click 处理器（控制栏按钮的 onClick、
   * 设置面板开关的 toggle）：arm() 若在 pointerdown 阶段抢先 open()，随后到达的
   * click 会看到「已经开着」，于是把它关掉 —— 用户看到的是「点了打不开」，而且
   * close() 会把 enabled 落盘成 false，把用户开过的开关一起搞丢。
   *
   * 判据用 composedPath() 而不是 target：设置面板的开关在 Linglass 的 shadowRoot
   * 里，事件冒到 document 时 target 已被重定向成宿主元素，只有 composedPath()
   * 能看见里面那个 [data-llg-toggle]。
   *
   * 拿不到事件（Node 侧的测试直接调监听器）时返回 false —— 按普通页面手势处理。
   */
  function onOurOwnUi(ev) {
    if (!ev || typeof ev.composedPath !== 'function') return false;
    return ev.composedPath().some((node) => {
      if (!node || node.nodeType !== 1) return false;
      if (node.id === BTN_ID) return true;
      return typeof node.closest === 'function' && !!node.closest(TOGGLE_SELECTOR);
    });
  }

  /**
   * 现在有没有**瞬时**用户激活（requestWindow() 要的就是它）。
   *
   * 取不到 userActivation（老浏览器 / 测试桩没给）时乐观放行：让 requestWindow()
   * 自己去判，不因为探测不到就把恢复能力关掉。
   */
  function hasActivation() {
    const ua = navigator.userActivation;
    return !ua || typeof ua.isActive !== 'boolean' ? true : ua.isActive;
  }

  /**
   * 武装「下一次用户手势就开」。
   * requestWindow() 必须在瞬时用户激活内调用，所以在没有手势的时机（心跳里发现窗口没了、
   * 页面刚加载）只能这样等 —— 「开着就一直开着」正是靠这条路径生效。
   */
  function arm() {
    // syncWindow() 而不是 `pipWin`：窗口被浏览器收走而本地还以为它在时，用 `pipWin`
    // 会把这次武装整个挡掉 ——「下一次手势就回来」这条路径于是永远等不到
    if (armed || !enabled || !supported() || syncWindow()) return;
    armed = (ev) => {
      // 我们自己的按钮/开关上的手势：交给它的 click 处理器，别抢同一次点击。
      // 这里**不 disarm()** —— 武装留在原处，等真正的页面手势
      if (onOurOwnUi(ev)) return;
      disarm();
      if (canAutoOpen()) {
        open();
        return;
      }
      // 这次手势落在「还不是播放页」的时刻（典型：从首页点视频封面，导航还没完成）：
      // 别把它丢掉，立刻重新武装 —— 用户的下一次点击/按键就能接住
      arm();
    };
    for (const type of GESTURE_EVENTS) document.addEventListener(type, armed, true);
  }

  async function open() {
    if (!supported() || opening) return false;

    // 先跟浏览器对齐：窗口其实已经被收走时，别把「开着」当真 —— 否则这次调用会被守卫
    // 挡掉，而按钮那边还会误以为该走 close()（那是把常驻开关写成 false 的那条路）
    if (syncWindow()) return false;

    // 没有瞬时激活就别去撞 requestWindow()：必然被拒，还会往控制台刷一条红字。
    // 这条路径是常态（刷新 / 真导航 / 回到浏览器本体 / 心跳里的兜底），不是异常，
    // 所以静默地等下一次手势 —— 那才是「开着就一直开着」真正的生效路径。
    // 注意这一判要在 disarm() 之前：重入已被上面两道守卫挡掉，这里不改任何状态。
    if (!hasActivation()) {
      arm();
      refreshButton();
      return false;
    }

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
      // 走到这里说明「有激活但 requestWindow 仍被拒」（系统拒绝、或激活在异步间隙里过期）
      // —— 上面那道 hasActivation() 已经把「压根没激活」的常态路径挡掉了
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
    bindVideoEvents();
    syncBar();
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
    styleEl = null; // 那张 <style> 随窗口一起没了
    lastKey = '';
    lastFill = '';  // 新窗口的填充条是从 0 开始的，别被上一扇窗的值挡住第一次写
    refreshButton();
  }

  /**
   * 控制栏的按钮表：id 为 null 表示不需要单独拿引用的普通按钮。
   * 文案用媒体控制字符（⏮ ⏭ ▶ ⏸），它们在任何系统字体里都在，不必再塞 SVG。
   */
  const BAR_BUTTONS = [
    { id: 'pip-prev', act: 'prev', glyph: '⏮', label: '上一句' },
    { id: null, act: 'back', glyph: '−5s', label: '后退 5 秒' },
    { id: 'pip-toggle', act: 'toggle', glyph: '▶', label: '播放' },
    { id: null, act: 'fwd', glyph: '+5s', label: '前进 5 秒' },
    { id: 'pip-next', act: 'next', glyph: '⏭', label: '下一句' },
    { id: 'pip-rate', act: 'rate', glyph: '1×', label: '倍速（点击循环）' },
  ];

  function buildWindow(win) {
    const d = win.document;
    d.documentElement.style.colorScheme = 'dark';

    styleEl = d.createElement('style');
    styleEl.textContent = pipCss(appearance);
    d.head.append(styleEl);

    const box = d.createElement('div');
    box.id = 'box';

    const stage = d.createElement('div');
    stage.id = 'stage';

    // 官方 classic 预设的底板是「整块一个矩形」（.subtitle-group），所以两行外面要有
    // 一个共同的容器；contrast 的逐行底板改画在 .kline 上（见 plateCss）
    const plate = d.createElement('div');
    plate.id = 'plate';
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
      plate.append(wrap);
    }
    stage.append(plate);

    const bar = d.createElement('div');
    bar.id = 'bar';
    for (const item of BAR_BUTTONS) {
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.dataset.act = item.act;
      btn.textContent = item.glyph;
      btn.setAttribute('aria-label', item.label);
      btn.title = item.label;
      if (item.id) btn.id = item.id;
      bar.append(btn);
    }

    box.append(stage, bar);
    d.body.append(box);

    // 委托：一个监听器覆盖全部按钮，按钮是浮窗自己的，不受页面影响
    d.addEventListener('click', (ev) => {
      const target = ev.target;
      const btn = target && typeof target.closest === 'function'
        ? target.closest('[data-act]')
        : null;
      if (!btn) return;
      ev.preventDefault();
      command(btn.dataset.act);
    });

    win.addEventListener('pagehide', () => handlePageHide(win));
  }

  /**
   * PiP 窗口关闭（无论是谁关的都会走到这里）。
   *
   * **只有我们自己的 close() 才算「关掉」**（控制栏按钮 / 设置面板开关）。其余一切
   * 让窗口消失的操作 —— 用户点 PiP 窗口的 X、切到别的应用被 UA 关、刷新页面、真导航、
   * 扩展重载 —— 都只是中间态：只要 enabled 还是 true，就立刻想办法把它弄回来；
   * 弄不回来（此刻没有用户手势，见 open() 的注释）就 arm() 等下一次手势。
   *
   * 详见文件头「常驻语义」一节（为什么不再区分「谁关的」）。
   */
  function handlePageHide(win) {
    // 我们主动关闭时 stop() 可能已经先跑（close() 是同步返回的），pagehide 反而晚到；
    // 这时用 closingByUs 兜住，其余「不属于当前窗口」的过期 pagehide 直接忽略
    if (win !== pipWin && !closingByUs) return;

    const byUs = closingByUs;
    closingByUs = false;
    stop();

    // 按钮/开关关的（close() 已经把 enabled 落盘成 false）→ 到此为止
    if (byUs || !enabled) return;

    // 立刻试一次：有用户手势激活期就直接回来；
    // 没有时 open() 内部会 arm()，等用户下一次点击/按键
    open();
  }

  // ---------------------------------------------------------------- 按钮

  function refreshButton() {
    const ok = shared.ensureButton({
      id: BTN_ID,
      icon: ICON_SVG,
      onClick: () => {
        // 先跟浏览器对齐：窗口其实是浏览器收走的（`pipWin` 陈旧）时，这一下的本意是
        // 「开回来」，而旧写法会走 close()，把常驻开关一起写成 false —— 那才是
        // 「被关掉之后就一直是关的，还得再点一次」的来源
        if (syncWindow()) close();
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
    // 兜底：窗口被系统**悄悄**销毁（pagehide 没走到我们这里）时，pipWin 与浏览器里的
    // 实际情况就不一致了。同样是「中间态」，按 handlePageHide 那套把它弄回来。
    // 判据走 liveWindow()：`pipWin.closed` 与 API 的引用谁先更新都算数（不再只比身份）。
    if (pipWin && !liveWindow()) {
      stop();
      if (enabled) open();
      return;
    }

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
    // 换视频后 video 元素会被换掉，事件监听要跟着换；状态回显也顺带兜底一次
    bindVideoEvents();
    syncBar();
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
      primaryParts,
      // 注音与文节切点怎么共存（切点落在带注音的片段内时要放弃它）——纯函数，便于单测
      richSegments,
      pipCss: () => pipCss(appearance),
      parseSettings,
      getAppearance: () => ({ ...appearance }),
      // 播放控制：测试与 probe 直接驱动 command()，不必模拟浮窗里的点击
      command,
      syncBar,
      RATES,
      SEEK_STEP,
    },
    configurable: true,
  });

  track.subscribe(() => {
    if (pipWin) pushText();
  });

  /**
   * 「用户回到这个页面」的时机：切回标签页（visibilitychange）、窗口重新获得焦点
   * （从别的应用点回来 / 从最小化恢复 —— 这种情况 visibilityState 未必跃迁，所以
   * 光靠 visibilitychange 会漏掉）。
   *
   * 这正是浏览器可能刚把浮窗收走的那一刻（见文件头「常驻语义」），所以两件事都要做：
   *   1. 先把本地状态跟浏览器对齐 —— 窗口真没了就别再以为它还在；
   *   2. 再尽量开一次：用户是「点着页面回来」的时候，这一刻还带着瞬时激活，浮窗当场
   *      就回来；没有激活时 open() 自己会 arm()，等下一次手势（与旧行为一致，
   *      只是不再因为 `pipWin` 陈旧而把这个时机整个错过）。
   */
  function wake() {
    if (syncWindow()) {
      refreshButton();
      return;
    }
    if (enabled) open();
    else refreshButton();
  }

  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);

  // 登记到设置面板（线框图标，与 Linglass 面板内的 .toggle-icon 同一套语言）
  shared.registerFeature({
    id: 'desktopSubtitles',
    title: '桌面字幕浮窗',
    desc: '默认关闭（画面里那层官方字幕优先）。打开后只有这里的开关或控制栏按钮能关掉它；点浮窗自己的 X、切后台、刷新页面都会让它自己回来',
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

  // 官方外观设置：启动读一次，之后跟着它的变更走（用户在外观页改字号/颜色/样式/双语）
  loadAppearance();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes || !(SETTINGS_KEY in changes)) return;
      applyAppearance(parseSettings(changes[SETTINGS_KEY].newValue));
    });
  } catch {
    // 没有 onChanged（旧实现 / 被裁剪过的包）：那就只在启动时读一次
  }

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

  // 心跳挂在 00-shared.js 的共享定时器上（PLAN 025）：整页只留一个 1s 定时器
  shared.onTick(heartbeat);
})();
