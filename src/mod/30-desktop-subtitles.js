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
 *   外观 —— 与官方设置**同一份**（PLAN 033）：浮窗里的设置面板直接写回
 *           chrome.storage.sync['linglass-settings']，页面内字幕同步变化
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

  /**
   * 浮窗打开时的默认宽度。
   *
   * 取「一行放得下常见字幕」的紧凑值，而不是 1000 —— 字幕在窗口里居中，写死 1000 时
   * 两侧各留几百像素黑边，对读字幕没有任何帮助。文本长度事先不知道，所以不按文本算：
   * 长句会换行，由 #stage 居中承载（窗口之后仍可自由拖动，见 PIP_BASE_CSS 的说明）。
   *
   * PLAN 038：700 → 860。默认窗口偏窄时，长句换行频繁、控制栏也挤；860 大约能放下
   * 一行 30 个日文字符，仍不是「越宽越好」。
   *
   * PLAN 045：860 → 1040。日语难度调高后长句更长，860 仍会把 40 字左右的句子折成两行。
   * 1040 在 100% 档下约 37 个日文字符（1040 − 32 内边距 / 27px），折行明显减少；
   * 再宽就会在 1080p 屏幕上被系统钳制，而且左右黑边开始显眼。
   */
  const PIP_WIDTH = 1040;
  /**
   * 高度在「算出来的内容高度」之上再留的呼吸位（PLAN 038）。
   * 放进 `#stage` 的 flex 空间里，字幕仍然垂直居中，只是上下更松一点。
   */
  const PIP_HEIGHT_EXTRA = 48;
  /** 控制栏高度（按钮 30 + 上下内边距 8/10，与 PIP_BASE_CSS 的 #bar 一致） */
  const BAR_HEIGHT = 48;
  /** #stage 的上内边距（与 PIP_BASE_CSS 一致） */
  const STAGE_PAD_TOP = 10;
  /** #stage 的段间距（与 PIP_BASE_CSS 的 gap 一致）—— 上下文行数变化时高度要算进去 */
  const STAGE_GAP = 10;
  /**
   * 上下文行（上一句 / 下一句）相对当前句的字号比例。
   *
   * 比当前句小一号：上下文是用来「扫一眼」的，抢了当前句的对比就没法读了。
   * 这个数是刻意的固定值，不进样式条（PLAN 029 的「不做什么」）。
   * 「淡」不再走这条生成式样式 —— 它挪到了 PIP_BASE_CSS 的 `.ctx`（整段一起淡、可悬停，
   * 见 PLAN 030），所以这里只剩字号比例。
   */
  const CTX_FONT_RATIO = 0.7;
  /** 字幕行的 line-height（与 PIP_BASE_CSS 的 #line-* 一致） */
  const LINE_HEIGHT = 1.3;
  /**
   * 高度余量：原文行带注音时 line-height 会从 1.3 变 1.9（`#line-primary:has(ruby)`），
   * 而「当前这句有没有注音」在开窗那一刻还不知道。留一段固定余量兜住它：没注音时
   * 它变成上下各几个像素的呼吸位，有注音时正好不被裁。
   */
  const PIP_HEIGHT_SLACK = 12;

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

  /** 常驻开关的落盘键。默认 false —— 只有按钮/开关能打开它（PLAN 040） */
  const STORE_KEY = 'llgPip';

  /** 触发「下一次手势就开」的事件。pointerdown 覆盖鼠标/触摸，keydown 覆盖键盘用户 */
  const GESTURE_EVENTS = ['pointerdown', 'keydown'];

  /** 与 15-ja-break.js 的 ::after 观感对齐（那边是 margin: 0 .14em） */
  const THIN_SPACE = '\u2009';
  /** 浮窗里分隔符节点的 class（样式见 pipCss：与视频内那套同一份观感） */
  const SEP_CLASS = 'llg-sep';

  // ---------------------------------------------------------------- 浮窗外观与设置
  //
  // 浮窗的排版**规则**照搬官方字幕：字体栈、字重、字号比例、颜色、底板、阴影/描边用的都是
  // 官方那套公式（出处见本段末尾）。
  //
  // **取值**从 PLAN 033 起只有一处真相：chrome.storage.sync['linglass-settings']。
  // 浮窗里的设置面板不是副本 —— 它直接写回官方存储，页面内字幕与官方面板同时变化；
  // 反过来，官方面板改一项也会通过 storage.onChanged 回到浮窗（见 applyOfficial）。
  //
  // 浮窗自己只剩一项设置：上下文行数（ctxLines），落在 chrome.storage.local 的
  // APPEARANCE_KEY 里。它没有对应的官方维度，所以必须自己存；旧版本在这个键里还存过
  // 样式 / 字号 / 颜色 / 双语，PLAN 033 起一律忽略（迁移时只取 ctxLines）。
  //
  // 官方设置的读法：chrome.storage.sync['linglass-settings']，官方用 zustand persist
  // 落盘（{state, version:4}），值是对象还是 JSON 字符串两种形态都出现过，所以两种都兜。
  // 写回时同样按 version 4 的形态整份写，并把 subtitleScale 派生成官方要的 fontSize。
  //
  // 与官方唯一的偏差：**字号不乘播放器高度**。官方是
  //   base = max(11, max(playerHeight * .0333, 24) * scale/100)
  // 会跟着播放器尺寸变（剧场 / 全屏就放大）。浮窗没有「播放器尺寸」这个概念，
  // 而用户要的是「设置是多少就是多少」，所以这里只取官方的基座 24px 乘档位：
  // 浮窗拉大拉小、播放器进全屏，字号都不动。
  //
  // 取值出处（vendor/linglass-1.12.4/assets/，官方一发版文件哈希就变，只记名字前缀）：
  //   settings-*.js    默认设置 pe、预设表 f、字号 Se()、阴影/描边 re() 与 R()、色板、
  //                    语言表（学习 16 种 / 母语 24 种）、注音脚本表 hs、观看模式取值表
  //   promoCards-*.js  落盘读取 ys()/Ve()、存放读音的 us()、面板 CSS 的 getStyleContent()
  //   flags-*.js       语言下拉里的国旗 SVG
  //
  // 1.12.3 → 1.12.4 于 PLAN 027 核对过：settings-*.js 两版同哈希（预设表/Se()/re() 未变）；
  // promoCards 换了哈希，但 plate 梯度 / hexToRGBA / secondaryAlpha 那套一致；
  // subtitleBackground 已降级为派生字段（官方原话：plate is one property of a preset now,
  // not a switch of its own），所以浮窗不读它是对的。

  /** 官方设置的落盘键（chrome.storage.sync） */
  const SETTINGS_KEY = 'linglass-settings';

  /** 浮窗自己的设置落盘键（chrome.storage.local）：现在只存 { ctxLines } */
  const APPEARANCE_KEY = 'llgPipAppearance';

  /** 字号档位（与官方同一套：50–150、step 10，省得用户学两套） */
  const SCALE_MIN = 50;
  const SCALE_MAX = 150;
  const SCALE_STEP = 10;

  /** 官方四个预设：顺序就是面板里的瓷砖顺序 */
  const STYLE_CHOICES = ['classic', 'cinema', 'comic', 'contrast'];

  /** 预设的中文名与说明（官方 settings.style.*） */
  const STYLE_LABELS = {
    classic: '经典',
    cinema: '影院',
    comic: '漫画',
    contrast: '高对比',
  };
  const STYLE_DESCS = {
    classic: '两行文字共用一块底衬',
    cinema: '无底衬，细描边',
    comic: '粗描边，类似动画字幕',
    contrast: '每行文字各有底衬',
  };

  /**
   * 官方预设瓷砖里的示意图（settings-*.js 的 ue）。
   * 路径由官方的圆角矩形公式生成，这里直接把结果抄成常量 —— 它们只是 24×24 的示意图。
   */
  const STYLE_ICONS = {
    classic: '<path fill-rule="evenodd" fill="currentColor" d="M5.5,5.5h13a3,3 0 0 1 3,3v7a3,3 0 0 1 -3,3h-13a3,3 0 0 1 -3,-3v-7a3,3 0 0 1 3,-3zM6,9.3h12v2h-12zM8,13.2h8v2h-8z"/>',
    cinema: '<path fill="none" stroke="currentColor" stroke-width="1.7" d="M5.8,8.2h12.4a2.1,2.1 0 0 1 2.1,2.1v0a2.1,2.1 0 0 1 -2.1,2.1h-12.4a2.1,2.1 0 0 1 -2.1,-2.1v0a2.1,2.1 0 0 1 2.1,-2.1z"/><path fill="none" stroke="currentColor" stroke-width="1.7" d="M8.6,14.6h6.8a1.7,1.7 0 0 1 1.7,1.7v0a1.7,1.7 0 0 1 -1.7,1.7h-6.8a1.7,1.7 0 0 1 -1.7,-1.7v0a1.7,1.7 0 0 1 1.7,-1.7z"/>',
    comic: '<path fill="currentColor" opacity="0.34" d="M7.4,9.1h12.4a2.5,2.5 0 0 1 2.5,2.5v0.1a2.5,2.5 0 0 1 -2.5,2.5h-12.4a2.5,2.5 0 0 1 -2.5,-2.5v-0.1a2.5,2.5 0 0 1 2.5,-2.5z"/><path fill="currentColor" opacity="0.34" d="M10.4,16.6h6.4a2.1,2.1 0 0 1 2.1,2.1v0.1a2.1,2.1 0 0 1 -2.1,2.1h-6.4a2.1,2.1 0 0 1 -2.1,-2.1v-0.1a2.1,2.1 0 0 1 2.1,-2.1z"/><path fill="currentColor" d="M4.8,6.7h12.4a2.5,2.5 0 0 1 2.5,2.5v0.1a2.5,2.5 0 0 1 -2.5,2.5h-12.4a2.5,2.5 0 0 1 -2.5,-2.5v-0.1a2.5,2.5 0 0 1 2.5,-2.5z"/><path fill="currentColor" d="M7.8,14.2h6.4a2.1,2.1 0 0 1 2.1,2.1v0.1a2.1,2.1 0 0 1 -2.1,2.1h-6.4a2.1,2.1 0 0 1 -2.1,-2.1v-0.1a2.1,2.1 0 0 1 2.1,-2.1z"/>',
    contrast: '<path fill-rule="evenodd" fill="currentColor" d="M4.7,5.9h14.6a2.2,2.2 0 0 1 2.2,2.2v2.2a2.2,2.2 0 0 1 -2.2,2.2h-14.6a2.2,2.2 0 0 1 -2.2,-2.2v-2.2a2.2,2.2 0 0 1 2.2,-2.2zM5.6,8.3h12.8v1.9h-12.8zM8.2,14.3h7.6a2,2 0 0 1 2,2v1.8a2,2 0 0 1 -2,2h-7.6a2,2 0 0 1 -2,-2v-1.8a2,2 0 0 1 2,-2zM8.7,16.4h6.6v1.7h-6.6z"/>',
  };

  /** 官方色板；名字用于无障碍标签（settings-*.js 的 he） */
  const COLOR_PRESETS = ['#FFFFFF', '#FFD60A', '#64D2FF', '#30D158'];
  const COLOR_NAMES = {
    '#FFFFFF': '白色',
    '#FFD60A': '黄色',
    '#64D2FF': '青色',
    '#30D158': '绿色',
  };

  /** #RRGGBB（落盘里的颜色要过这一关才用） */
  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

  // ---------------------------------------------------------------- 原生设置的数据表
  //
  // 全部抄自官方 settings-*.js（见本节顶部的出处）。故意保持「一眼能与官方对照」的形状：
  // 官方改表时，改这里一处即可。

  /** 官方 de：学习语言（16 种） */
  const LEARNING_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' },
    { code: 'zh', name: '中文' },
    { code: 'ru', name: 'Русский' },
    { code: 'it', name: 'Italiano' },
    { code: 'pt-BR', name: 'Português (Brasil)' },
    { code: 'ar', name: 'العربية' },
    { code: 'tr', name: 'Türkçe' },
    { code: 'sv', name: 'Svenska' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'pl', name: 'Polski' },
    { code: 'th', name: 'ไทย' },
  ];

  /** 官方 ge：母语（23 种，顺序与官方一致） */
  const NATIVE_LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' },
    { code: 'zh', name: '中文' },
    { code: 'ru', name: 'Русский' },
    { code: 'it', name: 'Italiano' },
    { code: 'pt-BR', name: 'Português (Brasil)' },
    { code: 'pt-PT', name: 'Português (Portugal)' },
    { code: 'id', name: 'Bahasa Indonesia' },
    { code: 'vi', name: 'Tiếng Việt' },
    { code: 'th', name: 'ไทย' },
    { code: 'zh-Hant', name: '中文 (繁體)' },
    { code: 'tr', name: 'Türkçe' },
    { code: 'pl', name: 'Polski' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'ar', name: 'العربية' },
    { code: 'sv', name: 'Svenska' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'cs', name: 'Čeština' },
    { code: 'fa', name: 'فارسی' },
  ];

  /**
   * 官方注音脚本表（hs）：某门语言支持哪几种读音。
   * 顺序有意义：关掉再打开时取第一项（官方 Ne() 的口径）。
   */
  const READING_SCRIPTS = {
    ja: ['kana', 'romaji', 'off'],
    zh: ['pinyin', 'off'],
    ko: ['romaja', 'off'],
    th: ['paiboon', 'off'],
  };

  /** 官方注音脚本的中文名（settings.reading.*） */
  const READING_LABELS = {
    kana: '平假名',
    romaji: '罗马字',
    pinyin: '拼音',
    romaja: '罗马音',
    paiboon: '罗马音',
    off: '关闭',
  };

  /** 官方观看模式（settings-*.js 的 b、E、v、M） */
  const MODES = ['normal', 'pause', 'repeat', 'listen'];
  const MODE_LABELS = {
    normal: '普通',
    pause: '带暂停',
    repeat: '重复',
    listen: '听力',
  };
  const REPEAT_COUNTS = [2, 3, 5, 0];
  const REPEAT_RATES = [1, .75, .5];
  const DEFAULT_VIEWING = {
    mode: 'normal',
    lastMode: 'pause',
    pause: { at: 'after', length: 'manual' },
    repeat: { count: 2, rate: 1 },
    listen: { target: 'primary', cover: 'blur', length: 'manual' },
    pauseOnTranslate: true,
    showHints: true,
  };

  /** 各字段的取值表（循环行用；标签分「行内值」与「说明行片段」两套，与官方一致） */
  const VIEWING_FIELDS = {
    'pause.at': {
      values: ['after', 'before'],
      labels: { after: '行后', before: '行前' },
      frags: { after: '每行之后', before: '每行之前' },
    },
    'pause.length': {
      values: ['manual', 'fixed', 'cue'],
      labels: { manual: '手动继续', fixed: '3 秒', cue: '该行时长' },
      frags: {
        manual: '直到你自己继续播放',
        fixed: '持续 3 秒',
        cue: '与该行时长相同',
      },
    },
    'repeat.count': {
      values: REPEAT_COUNTS,
      labels: { 0: '∞', 2: '2', 3: '3', 5: '5' },
      frags: {
        0: '该行一直重复，直到你继续往下',
        2: '该行播放 2 次',
        3: '该行播放 3 次',
        5: '该行播放 5 次',
      },
    },
    'repeat.rate': {
      values: REPEAT_RATES,
      labels: { 1: '1×', 0.75: '0.75×', 0.5: '0.5×' },
      frags: {
        1: '与视频速度相同',
        0.75: '重复时慢四分之一',
        0.5: '重复时速度减半',
      },
    },
    'listen.target': {
      values: ['primary', 'both', 'secondary'],
      labels: { primary: '原文行', both: '两行', secondary: '译文' },
      frags: { primary: '原文行', both: '两行字幕', secondary: '译文行' },
    },
    'listen.cover': {
      values: ['blur', 'bar'],
      labels: { blur: '模糊', bar: '遮条' },
      frags: { blur: '用模糊隐藏', bar: '用遮条隐藏' },
    },
    'listen.length': {
      values: ['manual', 'fixed', 'cue', 'none'],
      labels: { manual: '手动继续', fixed: '3 秒', cue: '该行时长', none: '无' },
      frags: {
        manual: '该行结束后暂停，直到你自己继续播放',
        fixed: '该行结束后暂停 3 秒',
        cue: '该行结束后暂停，时长与该行相同',
        none: '不暂停',
      },
    },
  };

  /** 模式瓷砖的示意图（promoCards 的 modeGlyph） */
  const MODE_GLYPHS = {
    normal: '<rect x="2" y="10" width="5.6" height="4" rx="1.3"/><rect x="9.2" y="10" width="5.6" height="4" rx="1.3"/><rect x="16.4" y="10" width="5.6" height="4" rx="1.3"/>',
    pause: '<rect x="2" y="10" width="7" height="4" rx="1.3"/><rect x="10.9" y="8.3" width="1.5" height="7.4" rx=".6"/><rect x="13.5" y="8.3" width="1.5" height="7.4" rx=".6"/><rect x="16.4" y="10" width="5.6" height="4" rx="1.3"/>',
    repeat: '<rect x="4" y="14.4" width="16" height="4" rx="1.3"/><path d="M7.4 11.4A5.4 4.6 0 1 1 17.6 9.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M19.2 7.1 17.8 10.1 14.9 8.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
    listen: '<rect x="3.7" y="6.6" width="16.6" height="4.4" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.2 1.8"/><rect x="6.9" y="14" width="10.2" height="3.6" rx="1.8"/>',
  };

  /** 官方默认设置（settings-*.js 的 pe，只保留浮窗用得到的字段） */
  const OFFICIAL_DEFAULTS = {
    enabled: true,
    dualSubtitles: true,
    subtitleStyle: 'classic',
    subtitleScale: 100,
    subtitleColor: '#FFFFFF',
    learningLanguage: null,
    nativeLanguage: null,
    readingMode: {},
    mediaCaptureEnabled: false,
    subtitleSyncMode: 'matched',
    viewing: DEFAULT_VIEWING,
    theme: 'system',
  };

  /** 上下文行档位夹取：0 / 1 / 2，别的值一律走默认（落盘被写坏时兜住） */
  function clampCtxLines(value) {
    if (!Number.isFinite(value)) return CTX_DEFAULT;
    return Math.min(CTX_MAX, Math.max(CTX_MIN, Math.round(value)));
  }

  /** 字号夹到档位表上：落盘被写坏、或以后改档位表时都从这里兜住 */
  function clampScale(value) {
    const onStep = Math.round(value / SCALE_STEP) * SCALE_STEP;
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, onStep));
  }

  /** 面板上的字号加减：按档位表走，夹在首尾档 */
  function stepScale(scale, dir) {
    return clampScale(clampScale(scale) + dir * SCALE_STEP);
  }

  /**
   * 档位 → 官方落盘的 fontSize（官方 ma()：round(scale/100*24)，夹在 12–32）。
   * 官方每次保存都会重算这个派生字段，我们写回时也必须带上，否则官方的
   * 旧版迁移路径会拿它反推档位。
   */
  function fontSizeFromScale(scale) {
    return Math.min(32, Math.max(12, Math.round((clampScale(scale) / 100) * BASE_FONT_PX)));
  }

  /** 在取值表里循环到下一项（官方 ge() 的口径：找不到就回第一项） */
  function cycleValue(values, current) {
    const index = values.indexOf(current);
    return values[(index + 1) % values.length];
  }

  /** 一门语言支持哪几种读音（没有就是空数组：官方不显示读音行） */
  function readingScriptsOf(lang) {
    const key = String(lang == null ? '' : lang).toLowerCase().split('-')[0];
    return READING_SCRIPTS[key] ? [...READING_SCRIPTS[key]] : [];
  }

  /** 当前生效的读音脚本（官方 Ne()：落盘值不在表里就用第一项，表空则 off） */
  function readingModeOf(lang, readingMode) {
    const scripts = readingScriptsOf(lang);
    if (!scripts.length) return 'off';
    const key = String(lang == null ? '' : lang).toLowerCase().split('-')[0];
    const stored = readingMode && readingMode[key];
    return stored && scripts.includes(stored) ? stored : scripts[0];
  }

  /** 逐字段夹取观看模式（官方 H() / Rt()） */
  function normalizeViewing(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const pick = (list, value, fallback) => (list.includes(value) ? value : fallback);
    const pause = source.pause && typeof source.pause === 'object' ? source.pause : {};
    const repeat = source.repeat && typeof source.repeat === 'object' ? source.repeat : {};
    const listen = source.listen && typeof source.listen === 'object' ? source.listen : {};

    return {
      mode: pick(MODES, source.mode, DEFAULT_VIEWING.mode),
      lastMode: pick(MODES.slice(1), source.lastMode, DEFAULT_VIEWING.lastMode),
      pause: {
        at: pick(VIEWING_FIELDS['pause.at'].values, pause.at, DEFAULT_VIEWING.pause.at),
        length: pick(VIEWING_FIELDS['pause.length'].values, pause.length, DEFAULT_VIEWING.pause.length),
      },
      repeat: {
        count: pick(REPEAT_COUNTS, repeat.count, DEFAULT_VIEWING.repeat.count),
        rate: pick(REPEAT_RATES, repeat.rate, DEFAULT_VIEWING.repeat.rate),
      },
      listen: {
        target: pick(VIEWING_FIELDS['listen.target'].values, listen.target, DEFAULT_VIEWING.listen.target),
        cover: pick(VIEWING_FIELDS['listen.cover'].values, listen.cover, DEFAULT_VIEWING.listen.cover),
        length: pick(VIEWING_FIELDS['listen.length'].values, listen.length, DEFAULT_VIEWING.listen.length),
      },
      pauseOnTranslate: typeof source.pauseOnTranslate === 'boolean'
        ? source.pauseOnTranslate
        : DEFAULT_VIEWING.pauseOnTranslate,
      showHints: typeof source.showHints === 'boolean'
        ? source.showHints
        : DEFAULT_VIEWING.showHints,
    };
  }

  /**
   * 观看模式的说明行（官方 caption.* 的中文片段）。
   * 用数组拼而不是模板串，是为了让「一个状态读起来始终一样」这条官方口径也落在测试里。
   */
  function viewingCaption(viewing) {
    const current = normalizeViewing(viewing);
    const frag = (field, value) => VIEWING_FIELDS[field].frags[value];

    switch (current.mode) {
      case 'pause':
        return `${frag('pause.at', current.pause.at)}暂停，${frag('pause.length', current.pause.length)}。`;
      case 'repeat':
        return `${frag('repeat.count', current.repeat.count)}，${frag('repeat.rate', current.repeat.rate)}。`;
      case 'listen':
        return `${frag('listen.target', current.listen.target)}${frag('listen.cover', current.listen.cover)}。`
          + `${frag('listen.length', current.listen.length)}。把鼠标移到该行或暂停视频即可看到。`;
      default:
        return '无需设置——视频不间断播放。';
    }
  }

  /**
   * 浮窗自己那份设置（chrome.storage.local）。
   *
   * 旧版本在这里存过 style/scale/color/dual —— 现在外观以官方设置为唯一真相，
   * 那四项一律忽略，只迁移 ctxLines（缺省/写坏都走默认）。
   */
  function parseOwn(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return { ctxLines: clampCtxLines(raw.ctxLines) };
  }

  /**
   * 官方落盘值 → 完整设置。
   *
   * 三种形态都要兜：zustand persist 的对象 `{state, version}`、被 JSON.stringify 过的
   * 字符串、以及更早版本直接铺平的设置对象。**逐项校验、逐项兜底**：一项脏数据
   * 不该让其余项跟着回退。
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
    if (!state || typeof state !== 'object') return { ...OFFICIAL_DEFAULTS, viewing: normalizeViewing() };

    const readingMode = {};
    if (state.readingMode && typeof state.readingMode === 'object') {
      for (const [lang, script] of Object.entries(state.readingMode)) {
        const scripts = readingScriptsOf(lang);
        if (scripts.includes(script)) readingMode[lang] = script;
      }
    }

    return {
      enabled: state.enabled !== false,
      dualSubtitles: state.dualSubtitles !== false,
      subtitleStyle: STYLE_CHOICES.includes(state.subtitleStyle)
        ? state.subtitleStyle
        : OFFICIAL_DEFAULTS.subtitleStyle,
      subtitleScale: Number.isFinite(state.subtitleScale) && state.subtitleScale > 0
        ? clampScale(state.subtitleScale)
        : OFFICIAL_DEFAULTS.subtitleScale,
      subtitleColor: typeof state.subtitleColor === 'string' && HEX_COLOR.test(state.subtitleColor)
        ? state.subtitleColor.toUpperCase()
        : OFFICIAL_DEFAULTS.subtitleColor,
      learningLanguage: typeof state.learningLanguage === 'string' ? state.learningLanguage : null,
      nativeLanguage: typeof state.nativeLanguage === 'string' ? state.nativeLanguage : null,
      readingMode,
      mediaCaptureEnabled: state.mediaCaptureEnabled === true,
      subtitleSyncMode: state.subtitleSyncMode === 'original' ? 'original' : 'matched',
      viewing: normalizeViewing(state.viewing),
      theme: typeof state.theme === 'string' ? state.theme : OFFICIAL_DEFAULTS.theme,
    };
  }

  /**
   * 上下文行数（PLAN 029）：0 = 只看当前句（旧样子）、1 = 当前句 + 下一句、2 = 上一句 + 当前 + 下一句。
   * 默认 1：多给一句「下一句」最有价值，而「上一句」要看的人会自己再点一下。
   */
  const CTX_MIN = 0;
  const CTX_MAX = 2;
  const CTX_DEFAULT = 1;

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

  /**
   * 开窗时的默认高度 = 内容高度（字幕两行 + 底板内边距 + 控制栏 + 余量）。
   *
   * 为什么不写死一个数：字号**不跟窗口走**（见 fontSizeOf），而官方档位能拉到 150%
   * 以上 —— 写死 264 时 100% 档上下各留一大块黑边，档位一调大又反过来裁字。
   * 按当前外观现算，开窗那一刻就是贴合的；档位之后改了，用户把窗口拖一下即可
   * （窗口本来就可自由拉伸）。
   */
  function pipHeight(target) {
    const size = fontSizeOf(target);
    const spec = styleSpecOf(target.style);
    const scale = size.base / BASE_FONT_PX;

    let inner = size.primary * LINE_HEIGHT;
    if (target.dual) inner += size.secondary * LINE_HEIGHT;

    if (spec.plate === 'block') {
      // classic：整块底板，上下各一份内边距（按 metricScale 缩放）
      inner += 2 * PLATE_PAD_Y * scale;
    } else {
      // contrast：逐行底板，每行各有上下内边距，两行之间还有一段间距
      const padY = LINE_PAD_Y * size.base;
      inner += 2 * padY;
      if (target.dual) inner += 2 * padY + LINE_GAP * size.base;
    }

    // 上下文行（PLAN 029）：每段 = 原文行 × 0.8 +（开双语时的）译文行 × 0.8，
    // 再加一个 #stage 的 gap。不画底板，所以没有内边距要算
    const ctx = clampCtxLines(target.ctxLines);
    if (ctx > 0) {
      let perCtx = size.primary * CTX_FONT_RATIO * LINE_HEIGHT;
      if (target.dual) perCtx += size.secondary * CTX_FONT_RATIO * LINE_HEIGHT;
      inner += ctx * (perCtx + STAGE_GAP);
    }

    return Math.ceil(BAR_HEIGHT + STAGE_PAD_TOP + inner + PIP_HEIGHT_SLACK + PIP_HEIGHT_EXTRA);
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

  /**
   * 与外观无关的部分：结构、进度条、控制栏。字号一律写死 px，不跟浮窗尺寸走。
   *
   * ⚠️ 这里**不能出现任何固有最小尺寸**：Document PiP 窗口能被用户拖到多小，取决于
   * 文档内容的 min-content —— flex 子项默认 `min-width: auto`，会被内容撑住，于是
   * 「窗口只能拉大、拖不小」。所以以下几件事是刻意的，别改回去：
   *   · 链条上每一环（#box / #stage / .kline / #plate / #bar）都写 `min-width: 0`；
   *   · 控制栏按钮不再写死 `min-width: 42px`（六个按钮 + 间距会把窗口钉在 300px 以上），
   *     改成可收缩（`flex: 0 1 auto` + `min-width: 0`），窄窗口下按钮一起变窄；
   *   · 外围 padding / gap 取小值，不给「窗口下限」再抬一层。
   * 唯一不跟着窗口走的是**字号**（见 fontSizeOf 与本节顶部说明）：窗口怎么拉都是那个字号。
   */
  const PIP_BASE_CSS = `
:root { color-scheme: dark; }
/* 深灰蓝而不是纯黑：纯黑在暗环境里与桌面边界糊在一起，稍微提一点更像一块「面板」 */
html, body { height: 100%; margin: 0; overflow: hidden; background: #141518;
  -webkit-font-smoothing: antialiased; }
#box { height: 100%; min-width: 0; display: flex; flex-direction: column; box-sizing: border-box; }
#stage { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; padding: 10px 16px 0; gap: 10px; }
.kline { position: relative; display: inline-block; max-width: 100%; min-width: 0; }
/* 句内进度（PLAN 036 回到旧观感）：铺在文字身后的半透明蓝色底，按句内进度从左往右长。
   0.16 / 0.11 是踩过的值 —— 再高就跟白字抢对比。 */
/* 进度用 transform 而不是 width：width 每帧都要重新布局，而这两条由 PiP 自己的
   rAF 以 60fps 驱动（与 tools/cast-page.mjs 的 paintProgress 同一口径）。 */
.kfill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%;
  transform: scaleX(0); transform-origin: left center;
  border-radius: var(--radius-sm, 8px); }
#fill-primary { background: rgba(10, 132, 255, .16); }
#fill-secondary { background: rgba(10, 132, 255, .11); }
/* 长句折行（PLAN 045）：line-break: strict 按日文禁则断行（不让小假名 / 开括号 / 标点
   落在行首）；balance 让折两行时长度接近，而不是「第一行满、第二行两个字」 */
#line-primary, #line-secondary { position: relative; display: block;
  line-height: 1.3; text-align: center; white-space: pre-wrap;
  line-break: strict; text-wrap: balance; }
/* 上下文行（PLAN 029）：上一句 / 下一句各占一块，块内原文一行 + 译文一行。
   字号由 pipCss() 按当前外观生成（比当前句小一档），「淡」在块上 —— 整段一起淡，
   只有当前句（#plate）是不透明的（PLAN 030）。刻意不画底板、不带进度填充。 */
.ctx { display: flex; flex-direction: column; align-items: center;
  max-width: 100%; min-width: 0; opacity: .4; cursor: pointer;
  transition: opacity .18s ease; }
/* 悬停：提亮一档，明示「这两段点得动」（点了会跳到那一句的开头重播） */
.ctx:hover { opacity: .75; }
.ctx-line { display: block; line-height: 1.3; text-align: center; white-space: pre-wrap; }

/* 滚轮（PLAN 030）：换句时三段整列推进一格 —— 前进从下方推入、后退从上方推入。
   真正的滚动容器做不到这件事：当前句比上下文行大一档，条目不等高，硬滚会抖。
   动效只由 JS 打方向标记触发（data-roll），外观变化（改色/改字号）不滚。 */
#reel { display: flex; flex-direction: column; align-items: center;
  max-width: 100%; min-width: 0; gap: 10px; }
@keyframes llg-roll-up { from { transform: translateY(22px); opacity: .3; } to { transform: none; opacity: 1; } }
@keyframes llg-roll-down { from { transform: translateY(-22px); opacity: .3; } to { transform: none; opacity: 1; } }
#reel[data-roll="up"] { animation: llg-roll-up .26s cubic-bezier(.22, .61, .36, 1); }
#reel[data-roll="down"] { animation: llg-roll-down .26s cubic-bezier(.22, .61, .36, 1); }
/* 系统设了「减少动态效果」就别动（只在缩放/位移上做文章的那种动效，最容易引起不适） */
@media (prefers-reduced-motion: reduce) {
  #reel[data-roll] { animation: none; }
}
#stage:not(:has(#line-primary:not(:empty)))::before {
  content: "— 等待 Linglass 字幕 —";
  font-size: 15px; font-weight: 400; color: #7a7a80; letter-spacing: .04em; }

/* 播放控制栏：浮窗自己的按钮，直接操作宿主页面里的 video（同源）。
   字体栈是给控制栏用的 —— 字幕行不再继承它（那两行完全按官方外观走） */
#bar { display: flex; align-items: center; justify-content: center; gap: 6px;
  min-width: 0; padding: 7px 8px 7px;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif; }
/* min-width 必须是 0：写死按钮宽度等于给窗口设下限（见本节顶部说明）。
   窄窗口下按钮一起收窄，文字用 nowrap 保证不折行。
   高度 / 圆角统一 34px / 8px；不再画描边，靠底色分层（PLAN 035） */
#bar button { flex: 0 1 auto; min-width: 0; height: 34px; padding: 0 8px;
  border: 0; border-radius: 8px;
  background: rgba(255,255,255,.08); color: #fff;
  font: inherit; font-size: 13px; line-height: 1; white-space: nowrap; cursor: pointer;
  transition: background .15s ease, transform .12s ease; }
#bar button:hover { background: rgba(255,255,255,.16); }
#bar button:active { background: rgba(255,255,255,.24); transform: scale(.96); }
#bar button[disabled] { opacity: .32; cursor: default; transform: none; }
#bar button[disabled]:hover { background: rgba(255,255,255,.08); }
/* 主按钮：圆形白底 + 深色图标，一眼能认出来 */
#pip-toggle { flex: 0 0 34px; width: 34px; height: 34px; padding: 0;
  border-radius: 50%; background: #fff; color: #141518; font-size: 13px; }
#pip-toggle:hover { background: #f2f3f5; }
#pip-toggle:active { background: #e6e8ec; }
#pip-toggle[disabled], #pip-toggle[disabled]:hover { background: rgba(255,255,255,.3); color: #141518; }
#pip-rate { font-variant-numeric: tabular-nums; }

/* 整片进度条（PLAN 037）：控制栏正上方。轨道 3px、hover 5px，点 / 拖都能跳 */
#progress { position: relative; flex: 0 0 auto; height: 3px; margin: 0 12px 6px;
  border-radius: 999px; background: rgba(255, 255, 255, .12);
  cursor: pointer; touch-action: none; transition: height .16s ease; }
/* 加一圈透明命中区：3px 太细，鼠标很难点中 */
#progress::before { content: ""; position: absolute; left: 0; right: 0;
  top: -7px; bottom: -7px; }
#progress-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0;
  border-radius: 999px; background: #fff;
  box-shadow: 0 0 6px rgba(255, 255, 255, .4); }
#progress-fill::after { content: ""; position: absolute; right: -5px; top: 50%;
  width: 10px; height: 10px; margin-top: -5px; border-radius: 50%;
  background: #fff; transform: scale(0); transition: transform .15s ease; }
#progress:hover { height: 5px; }
#progress:hover #progress-fill::after { transform: scale(1); }
/* 控制栏与设置页共用这个容器：切换只改 display（见 setPanelMode） */
#bars { flex: 0 0 auto; min-width: 0; }
/* 设置页宿主：占满剩余高度、自己滚动（面板本体在里面，样式表也在它的 shadow 里） */
#settings { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  display: flex; justify-content: center; align-items: flex-start; padding: 0; }
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
  box-sizing: border-box; max-width: 100%; min-width: 0; }
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
/* 上下文行（PLAN 029）：同一套字体栈 / 描边 / 阴影，只把字号压到 0.8×。
   「淡」与「可点」在 PIP_BASE_CSS 的 .ctx 上（整段一起，只有当前句不透明）。
   注音不会有（官方只有当前句渲染 <ruby>），底板与进度填充也不给 */
#prev-primary, #next-primary { font-family: ${fontStackOf(spec, target.primaryLang)};
  font-size: ${round1(size.primary * CTX_FONT_RATIO)}px; font-weight: ${primaryWeightOf(spec, target)};
  letter-spacing: ${letterSpacing}; color: ${target.color};
  text-shadow: ${edge.shadow}; -webkit-text-stroke-width: ${edge.stroke};
  -webkit-text-stroke-color: rgba(0, 0, 0, 0.92); paint-order: ${edge.paintOrder}; }
#prev-secondary, #next-secondary { font-family: ${fontStackOf(spec, target.secondaryLang)};
  font-size: ${round1(size.secondary * CTX_FONT_RATIO)}px; font-weight: ${spec.secondaryWeight};
  letter-spacing: ${letterSpacing}; color: ${secondaryColor};
  text-shadow: ${edge.shadow}; -webkit-text-stroke-width: ${edge.stroke};
  -webkit-text-stroke-color: rgba(0, 0, 0, 0.92); paint-order: ${edge.paintOrder}; }
/* 振假名：只有官方这行本来就渲染了 <rt> 时才会出现（跟随官方，见 pushText 的 richTokens）。
   比原文小一号、降到次级灰，不与主文字抢视线；行距抬高，上标才不贴住上一行 */
#line-primary:has(ruby) { line-height: 1.9; }
#line-primary rt { font-size: .5em; font-weight: 400; letter-spacing: 0;
  opacity: .6; line-height: 1.15; }
/* 分隔符：与 15-ja-break.js 视频内那套（那边是 ::after）同一份观感。
   PLAN 035：再压淡一档，只当「停顿」用，不当竖线看 */
.${SEP_CLASS} { margin: 0 .16em; opacity: .2; font-weight: 400; }
`].join('\n');
  }

  /** 换一份外观：窗口开着就整张重写样式表，并强制重画一次文本（双语开关可能变了） */
  function applyAppearance(next) {
    appearance = next;
    if (!pipWin || !styleEl) return;
    styleEl.textContent = pipCss(appearance);
    lastKey = '';
    pushText();
  }

  /** 读 chrome.storage.local 的一个键；storage 不可用（被裁剪的包）时给 undefined */
  function readLocal(key) {
    try {
      return chrome.storage.local
        .get(key)
        .then((res) => (res ? res[key] : undefined))
        .catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  /** 读官方设置（chrome.storage.sync）；读不到就给 undefined，由 parseSettings 兜默认值 */
  function readOfficial() {
    try {
      return chrome.storage.sync
        .get(SETTINGS_KEY)
        .then((res) => (res ? res[SETTINGS_KEY] : undefined))
        .catch(() => undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  }

  /**
   * 把完整设置写回官方存储（zustand persist 的 version 4 形态）。
   *
   * 先读一次现有 state 再合并：官方可能又加了我们不认识的字段，不能整个覆盖掉。
   * `fontSize` 是官方从档位派生的字段，写回时必须一起带上（见 fontSizeFromScale）。
   */
  function writeOfficial(state) {
    try {
      return chrome.storage.sync
        .get(SETTINGS_KEY)
        .then((res) => {
          const raw = res ? res[SETTINGS_KEY] : undefined;
          let parsed = raw;
          if (typeof parsed === 'string') {
            try {
              parsed = JSON.parse(parsed);
            } catch {
              parsed = null;
            }
          }
          const base = parsed && typeof parsed === 'object' && parsed.state ? parsed.state : {};
          const next = {
            ...base,
            ...state,
            fontSize: fontSizeFromScale(state.subtitleScale),
          };
          return chrome.storage.sync.set({
            [SETTINGS_KEY]: JSON.stringify({ state: next, version: 4 }),
          });
        })
        .catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * 写盘串行化：连点 A+ 时，后一次必须等前一次读完 state 之后再合并，
   * 否则两次写会互相覆盖（前一次读到的还是旧 state）。
   */
  let writeChain = Promise.resolve();

  /**
   * 改官方设置：**面板上每一次调整都走这里**。
   * 先改内存并立即生效（点下去就有反馈），再链式写回（写盘失败只吞掉，不打断交互）。
   */
  function patchOfficial(patch) {
    applyOfficial({ ...officialSettings, ...patch });
    const snapshot = { ...officialSettings };
    writeChain = writeChain.then(() => writeOfficial(snapshot));
    return writeChain;
  }

  /**
   * 应用一份官方设置：外观、语言、面板回显一次同步。
   *
   * 这是浮窗外观的**唯一来源**（PLAN 033）—— 官方 storage 变了、面板上改了、
   * 启动时读到了，走的都是这里。`ctxLines` 是唯一不属于官方的那一项。
   */
  function applyOfficial(next) {
    officialSettings = parseSettings(next);
    langs = {
      primaryLang: officialSettings.learningLanguage,
      secondaryLang: officialSettings.nativeLanguage,
    };
    appearance = {
      style: officialSettings.subtitleStyle,
      scale: officialSettings.subtitleScale,
      color: officialSettings.subtitleColor,
      dual: officialSettings.dualSubtitles,
      ctxLines: clampCtxLines(own.ctxLines),
      primaryLang: langs.primaryLang,
      secondaryLang: langs.secondaryLang,
    };
    applyAppearance(appearance);
    syncPanel();
  }

  /** 把浮窗自己的那一项设置落盘（storage 不可用时内存里的那份仍然有效） */
  function saveOwn() {
    try {
      chrome.storage.local.set({ [APPEARANCE_KEY]: { ...own } }).catch(() => {});
    } catch {
      // 没有 storage：只在本次会话里有效
    }
  }

  /** 改浮窗自己的设置（目前只有上下文行数）：生效 + 落盘 + 回显 */
  function setOwn(patch) {
    own = { ...own, ...patch };
    saveOwn();
    applyOfficial(officialSettings);
  }

  /**
   * 启动时读一次：浮窗自己的 ctxLines + 官方设置。
   *
   * 官方设置读不到（首次安装 / 被裁剪的包）就走 `OFFICIAL_DEFAULTS`；
   * `llgPipAppearance` 里若只有旧版的 style/scale/color/dual，parseOwn 会把它们忽略。
   */
  function loadAppearance() {
    return Promise.all([readLocal(APPEARANCE_KEY), readOfficial()]).then(([rawOwn, rawOfficial]) => {
      const stored = parseOwn(rawOwn);
      if (stored) own = stored;
      applyOfficial(rawOfficial === undefined ? OFFICIAL_DEFAULTS : rawOfficial);
    });
  }

  const ICON_SVG = `
<svg viewBox="0 0 24 24" class="llg-mod-icon" aria-hidden="true">
  <rect x="2.5" y="4" width="19" height="13.5" rx="2.5" fill="currentColor" fill-opacity="0.16"/>
  <path d="M6.4 10.6h11.2" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-opacity="0.88"/>
  <path d="M8.8 13.8h6.4" stroke="currentColor" stroke-width="1.7"
    stroke-linecap="round" stroke-opacity="0.5"/>
</svg>`;

  // 设置面板上的小图标（与官方同一套线性风格；16px 由 CSS 决定）
  const ICON_CHEVRON_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  const ICON_CHEVRON_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  const ICON_ARROW_RIGHT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M14 7l5 5-5 5"/></svg>';
  const ICON_MODES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="6" width="12" height="6" rx="2"/><rect x="9" y="14" width="12" height="5" rx="1.8"/></svg>';
  const ICON_APPEARANCE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7V5h16v2M12 5v14M8 19h8"/></svg>';
  const ICON_CONTEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
  const ICON_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4" width="19" height="13.5" rx="2.5" fill="currentColor" fill-opacity=".16"/><path d="M6.4 10.6h11.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M8.8 13.8h6.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-opacity=".5"/></svg>';

  /** 我们自己的分组标题（与 50-settings-panel.js 注入官方面板时用的文案一致） */
  const SECTION_TITLE = 'Linglass-Pro';

  /** 观看模式参数行的中文名 */
  const FIELD_LABELS = {
    'pause.at': '暂停位置',
    'pause.length': '暂停时长',
    'repeat.count': '重复次数',
    'repeat.rate': '重复速度',
    'listen.target': '隐藏',
    'listen.cover': '方式',
    'listen.length': '暂停以核对',
  };

  let pipWin = null;
  let rafId = 0;
  let lastKey = '';
  /** 上一次写进进度条的百分比（先比对再写，见 pushProgress） */
  let lastFill = '';
  /** 上一次渲染的是第几句（-1 = 还没有）：只有它变了才播滚轮动效（见 pushText） */
  let lastCueIndex = -1;
  /** 整片进度的上一次百分比（与 lastFill 同理：先比对再写） */
  let lastTimeline = null;
  /** 在进度条上按住拖动时，document 上的 pointermove 也继续生效 */
  let timelineDragging = false;
  /** PiP 里那张 <style>（窗口重建时换引用，关窗时清掉） */
  let styleEl = null;
  /** 当前生效的外观（官方设置投影 + 浮窗自己的 ctxLines，见 applyOfficial） */
  let appearance = {
    style: OFFICIAL_DEFAULTS.subtitleStyle,
    scale: OFFICIAL_DEFAULTS.subtitleScale,
    color: OFFICIAL_DEFAULTS.subtitleColor,
    dual: OFFICIAL_DEFAULTS.dualSubtitles,
    ctxLines: CTX_DEFAULT,
    primaryLang: null,
    secondaryLang: null,
  };
  /** 浮窗自己持有的设置：只剩上下文行数（外观以官方设置为唯一真相） */
  let own = { ctxLines: CTX_DEFAULT };
  /** 跟随官方的语言（学习语言 / 母语） */
  let langs = { primaryLang: null, secondaryLang: null };
  /** 最近一次应用到的官方设置（完整：面板回显都从这里读） */
  let officialSettings = { ...OFFICIAL_DEFAULTS, viewing: normalizeViewing() };
  /** 面板当前显示的是哪一页：'play' = 字幕，'root' / 'appearance' / 'modes' = 设置页 */
  let barMode = 'play';
  /** 语言下拉当前展开的是哪一个（同一次只开一个）；null = 都收起 */
  let openMenu = null;
  /**
   * 设置面板上需要回显的节点（窗口重建时整份换掉）。
   * 直接存引用而不是 querySelector：桩件里没有选择器引擎，而且面板是我们自己造的。
   */
  let panelNodes = null;
  /**
   * 常驻开关（落盘）。true = 希望它开着。
   *
   * **默认 false**（PLAN 040 恢复 PLAN 025 的口径）：浮窗只由控制栏按钮 / 设置面板开关
   * 打开 —— 点视频封面、点播放器、点页面任意处都不许把它顶出来（用户明确要求
   * 「手动点击才弹出」）。落盘里 `enabled: true`（用户自己开过）的人不受影响，
   * 之后照旧按常驻语义自己回来。
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

  /**
   * 相邻的那一句（-1 = 上一句、+1 = 下一句）。
   *
   * 原文来自整条轨（官方写进 local 的整轨缓存 + 直播采样），**译文只有这句被播到过才有**
   * —— 见 10-subtitle-track.js 的 fromSkeleton()：缓存里只有原文。
   * 所以「下一句」常常只有原文，这不是 bug，是拿不到。
   */
  function contextCue(offset) {
    const current = track.getCurrent();
    if (!current || current.index == null) return null;
    const cue = (track.getCues() || [])[current.index + offset];
    if (!cue) return null;
    return {
      primary: cue.primary || '',
      secondary: appearance.dual ? cue.secondary || '' : '',
    };
  }

  /**
   * 滚轮动效（PLAN 030）：给 #reel 打一个方向标记，CSS 那边按标记播放 keyframes。
   *
   * 为什么要先删、读一次 offsetWidth、再打上：同一个动画名连着用第二次不会重放，
   * 而「连续换句」恰恰是最常见的场景（中间那次读 offsetWidth 强制重排是必须的）。
   */
  function roll(dir) {
    const reel = pipWin && pipWin.document.getElementById('reel');
    if (!reel) return;
    delete reel.dataset.roll;
    void reel.offsetWidth;
    reel.dataset.roll = dir;
  }

  /** 把一段上下文行写进 DOM：没内容（或档位不够）就整段收起来，不留空行 */
  function pushContext(id, visible, text) {
    const d = pipWin.document;
    const block = d.getElementById(id);
    if (!block) return;
    if (!visible || !text || !text.primary) {
      // 原文那行是「片段 → 子节点」渲染出来的，收起来时要把节点清掉（不只是清文本）
      const primaryEl = d.getElementById(`${id}-primary`);
      if (primaryEl) primaryEl.replaceChildren();
      setText(d.getElementById(`${id}-secondary`), '');
      show(block, false);
      return;
    }
    renderSegments(d.getElementById(`${id}-primary`), primaryParts(text.primary));
    setText(d.getElementById(`${id}-secondary`), text.secondary);
    show(block, true);
  }

  function pushText() {
    if (!pipWin) return;

    const lines = currentLines();
    // 官方这行带注音（有 <rt>）就走富渲染，否则维持纯文本 + 分隔符 —— 跟随官方
    const tokens = richTokens(lines.primary);
    const parts = tokens ? null : primaryParts(lines.primary);
    // 双语关掉时官方也不显示译文行 —— 浮窗跟着它，别自作主张多给一行
    const secondary = appearance.dual ? lines.secondary : '';
    // 上下文行：档位 0 时两段都收起来；1 = 只给下一句；2 = 上下都给
    const ctx = clampCtxLines(appearance.ctxLines);
    const prev = ctx >= 2 ? contextCue(-1) : null;
    const next = ctx >= 1 ? contextCue(1) : null;
    // 注音形态 / 分隔符开关 / 双语开关 / 上下文行都进键：用户中途改设置时浮窗要重绘。
    // 上下文行进键的是**切好的片段**（不是原始文本）：断句开关一关一开、哪怕原文一字没变，
    // 渲染结果也不同 —— 拿原文进键会让「上一句 / 下一句」留在旧的分隔符形态上。
    const ctxKey = (cue) => (cue
      ? `${primaryParts(cue.primary).map((part) => part.text).join('\u0001')}\u0002${cue.secondary}`
      : '');
    const ctxPart = `${ctx}\u0003${ctxKey(prev)}\u0003${ctxKey(next)}`;
    const key = tokens
      ? `r\u0001${tokens.map((token) => `${token.text}\u0002${token.ruby || ''}`).join('\u0001')}\u0000${secondary}${ctxPart}`
      : `${parts.map((part) => part.text).join('\u0001')}\u0000${secondary}${ctxPart}`;
    if (key === lastKey) return;
    lastKey = key;

    const d = pipWin.document;
    const line = d.getElementById('line-primary');
    if (tokens) renderRichSegments(line, richSegments(tokens, cuePoints(lines.primary)));
    else renderSegments(line, parts);
    setText(d.getElementById('line-secondary'), secondary);

    pushContext('prev', ctx >= 2, prev);
    pushContext('next', ctx >= 1, next);

    // 滚轮动效只跟着「当前句换了一句」走：改颜色 / 改字号 / 开关断句都不该滚。
    // 首次填充（上一次是 -1）也不滚 —— 开窗那一瞬间不该自己动一下。
    const index = track.getCurrent() ? track.getCurrent().index : -1;
    if (lastCueIndex >= 0 && index >= 0 && index !== lastCueIndex) {
      roll(index > lastCueIndex ? 'up' : 'down');
    }
    lastCueIndex = index;
  }

  /**
   * 进度条的宽度。先比对再写：本函数由 PiP 窗口自己的 rAF 每帧调用，而字幕的句内
   * 进度在 60fps 下必然大量重复（同一毫秒的百分比一样）—— 无谓的样式写入会白白
   * 让合成器重绘（AGENTS.md §3 的幂等规矩同样适用于这里）。
   */
  function pushProgress() {
    if (!pipWin) return;
    // 只写 transform：合成器就能完成，不触发布局（见 CSS 里 .kfill 的说明）
    const ratio = Math.max(0, Math.min(1, track.getProgress()));
    const value = `scaleX(${ratio})`;
    if (value === lastFill) return;
    lastFill = value;
    const d = pipWin.document;
    const f1 = d.getElementById('fill-primary');
    const f2 = d.getElementById('fill-secondary');
    if (f1) f1.style.transform = value;
    if (f2) f2.style.transform = value;
  }

  /**
   * 整片进度条（PLAN 037）。
   *
   * 和句内填充（`#fill-*`）分开：那条是「这一句读了多少」，这条是「整个视频放在哪」。
   * 画在控制栏正上方，是 PiP 里唯一能一眼看出播到哪的东西。
   * 同样先比对再写（每帧都会调）。
   */
  function pushTimeline() {
    if (!pipWin) return;
    const el = video();
    const duration = el && Number.isFinite(el.duration) ? el.duration : 0;
    const ratio = duration > 0
      ? Math.min(1, Math.max(0, (el.currentTime || 0) / duration))
      : 0;
    // 这一条**保留 width**（不像 .kfill 那样用 transform）：`#progress-fill::after`
    // 是那个 hover 才出现的圆点，scaleX 会把它一起拉成椭圆。折中办法是把比例量化到
    // 0.25% —— 长视频上写入次数比 60fps 低一个数量级，圆点形状也不受影响。
    const percent = `${Math.round(ratio * 400) / 4}%`;
    if (percent === lastTimeline) return;
    lastTimeline = percent;
    const d = pipWin.document;
    const fill = d.getElementById('progress-fill');
    if (fill) fill.style.width = percent;
    const bar = d.getElementById('progress');
    if (bar && typeof bar.setAttribute === 'function') {
      bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    }
  }

  /** 按 0–1 的比例跳转；直播 / 时长未知时返回 false（不猜） */
  function seekToFraction(fraction) {
    const el = video();
    const duration = el && Number.isFinite(el.duration) ? el.duration : 0;
    if (!el || !(duration > 0) || !Number.isFinite(fraction)) return false;
    el.currentTime = Math.min(duration, Math.max(0, fraction * duration));
    lastTimeline = null;
    pushTimeline();
    return true;
  }

  /** 指针位置 → 0–1；拿不到布局（测试桩）时返回 null */
  function timelineFraction(ev) {
    const bar = pipWin && pipWin.document.getElementById('progress');
    if (!bar || typeof bar.getBoundingClientRect !== 'function' || !ev) return null;
    const rect = bar.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    return Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  }

  function push() {
    pushText();
    pushProgress();
    pushTimeline();
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

  /** 当前生效的观看模式（每次都从官方设置里夹一遍，脏值不会漏进 UI） */
  function currentViewing() {
    return normalizeViewing(officialSettings.viewing);
  }

  /** 切到某一页；`'play'` 表示回到字幕。 */
  function openPanel(page) {
    barMode = page || 'root';
    openMenu = null;
    setPanelMode();
    syncPanel();
    pushTimeline();
  }

  function closePanel() {
    barMode = 'play';
    openMenu = null;
    setPanelMode();
  }

  /** 学习语言的短码（官方 Gt()：小写、去掉地区后缀） */
  function learningKey() {
    const lang = officialSettings.learningLanguage;
    return String(lang == null ? '' : lang).toLowerCase().split('-')[0];
  }

  /** 选一种读音脚本（'off' = 关闭）：写回 officialSettings.readingMode */
  function selectReading(script) {
    const lang = officialSettings.learningLanguage;
    const scripts = readingScriptsOf(lang);
    if (!scripts.includes(script)) return;
    patchOfficial({ readingMode: { ...officialSettings.readingMode, [learningKey()]: script } });
  }

  /** 读音行开关：关着就打开（取该语言第一项），开着就关掉（官方口径） */
  function toggleReading() {
    const lang = officialSettings.learningLanguage;
    const scripts = readingScriptsOf(lang);
    if (!scripts.length) return;
    const on = readingModeOf(lang, officialSettings.readingMode) !== 'off';
    selectReading(on ? 'off' : scripts[0]);
  }

  /** 选语言：只接受官方列表里的 code（脏值不落盘） */
  function selectLanguage(setting, code) {
    const list = setting === 'nativeLanguage' ? NATIVE_LANGUAGES : LEARNING_LANGUAGES;
    if (!list.some((item) => item.code === code)) return false;
    openMenu = null;
    patchOfficial({ [setting]: code });
    return true;
  }

  /** 观看模式里的循环行：`pause.at` / `repeat.count` / … */
  function cycleViewingField(field) {
    const spec = VIEWING_FIELDS[field];
    if (!spec) return false;
    const [group, key] = field.split('.');
    const viewing = currentViewing();
    viewing[group] = { ...viewing[group], [key]: cycleValue(spec.values, viewing[group][key]) };
    patchOfficial({ viewing });
    return true;
  }

  /**
   * 设置页与样式条上的动作。返回 false 表示「这不是设置动作」，交给下面的播放控制处理。
   *
   * 放在 video 那道闸门**之前**：调字号 / 换颜色 / 改开关跟播放器没关系，不该因为
   * 此刻取不到 video 就点不动（浮窗是系统窗口，它可以比 video 活得久）。
   */
  function settingsCommand(act) {
    if (!act) return false;

    switch (act) {
      // 只负责「打开设置」：旧写法是切换，连点两下会先开面板、再把它收起 ——
      // 用户看到的是「浮窗莫名其妙回到初始界面」（PLAN 036）。
      // 收起统一走面板自己的 ×（settings-close），这里不再兼作出口。
      case 'appearance':
        if (barMode === 'play') openPanel('root');
        return true;
      case 'settings-close':
        closePanel();
        return true;
      case 'page-back':
        openPanel('root');
        return true;
      case 'scale-':
      case 'scale+':
        patchOfficial({
          subtitleScale: stepScale(officialSettings.subtitleScale, act === 'scale+' ? 1 : -1),
        });
        return true;
      case 'dual':
        patchOfficial({ dualSubtitles: !officialSettings.dualSubtitles });
        return true;
      case 'ctx':
        // 0 → 1 → 2 → 0：只看当前句 / 加下一句 / 上下都给（浮窗自己的设置）
        setOwn({ ctxLines: (clampCtxLines(own.ctxLines) + 1) % (CTX_MAX + 1) });
        return true;
      case 'reading':
        toggleReading();
        return true;
      default:
        break;
    }

    if (act.startsWith('page:')) {
      const page = act.slice('page:'.length);
      if (!PANEL_PAGES.includes(page)) return false;
      openPanel(page);
      return true;
    }

    if (act.startsWith('lang-menu:')) {
      const setting = act.slice('lang-menu:'.length);
      openMenu = openMenu === setting ? null : setting;
      syncPanel();
      return true;
    }

    if (act.startsWith('lang:')) {
      const [, setting, code] = act.split(':');
      return selectLanguage(setting, code);
    }

    if (act.startsWith('toggle:')) {
      const key = act.slice('toggle:'.length);
      if (!['enabled', 'dualSubtitles', 'mediaCaptureEnabled'].includes(key)) return false;
      patchOfficial({ [key]: !officialSettings[key] });
      return true;
    }

    if (act.startsWith('reading:')) return readScript(act.slice('reading:'.length));

    if (act.startsWith('mode-field:')) return cycleViewingField(act.slice('mode-field:'.length));

    if (act.startsWith('mode-toggle:')) {
      const key = act.slice('mode-toggle:'.length);
      if (!['pauseOnTranslate', 'showHints'].includes(key)) return false;
      patchOfficial({ viewing: { ...currentViewing(), [key]: !currentViewing()[key] } });
      return true;
    }

    if (act.startsWith('mode:')) {
      const mode = act.slice('mode:'.length);
      if (!MODES.includes(mode)) return false;
      const viewing = currentViewing();
      const lastMode = mode === 'normal' ? viewing.lastMode : mode;
      patchOfficial({ viewing: { ...viewing, mode, lastMode } });
      return true;
    }

    // style:<名字> / color:<#RRGGBB>：值必须是我们认得的，脏值一律不打进落盘
    if (act.startsWith('style:')) {
      const name = act.slice('style:'.length);
      if (!STYLE_CHOICES.includes(name)) return false;
      patchOfficial({ subtitleStyle: name });
      return true;
    }
    if (act.startsWith('color:')) {
      const hex = act.slice('color:'.length).toUpperCase();
      if (!COLOR_PRESETS.includes(hex)) return false;
      patchOfficial({ subtitleColor: hex });
      return true;
    }

    // 我们自己的功能（注册表与官方面板里的 Linglass-Pro 分组同一份）
    if (act.startsWith('feature:')) {
      const feature = shared.listFeatures().find((item) => item.id === act.slice('feature:'.length));
      if (!feature || typeof feature.toggle !== 'function') return false;
      feature.toggle();
      syncPanel();
      return true;
    }
    if (act.startsWith('action:')) {
      const [, featureId, actionId] = act.split(':');
      const feature = shared.listFeatures().find((item) => item.id === featureId);
      const action = feature && (feature.actions || []).find((item) => item.id === actionId);
      if (!action) return false;
      action.run();
      syncPanel();
      return true;
    }

    return false;
  }

  /** `reading:<script>` 的具名分支（单独抽出来，避免 settingsCommand 里再套一层 if） */
  function readScript(script) {
    if (!readingScriptsOf(officialSettings.learningLanguage).includes(script)) return false;
    selectReading(script);
    return true;
  }

  /**
   * 执行一个浮窗动作。返回 false 表示没有 video / 未知动作（调用方据此不做状态回显）。
   * @param {string} act toggle | back | fwd | prev | next | rate
   *                     | appearance | settings-close | page:<页> | page-back
   *                     | lang-menu:<setting> | lang:<setting>:<code> | toggle:<键>
   *                     | reading | reading:<脚本> | mode:<名字> | mode-field:<字段>
   *                     | mode-toggle:<字段> | feature:<id> | action:<功能>:<动作>
   *                     | scale- | scale+ | dual | ctx
   *                     | style:<预设> | color:<#RRGGBB>
   */
  function command(act) {
    if (settingsCommand(act)) return true;

    const el = video();
    if (!el) return false;

    switch (act) {
      case 'toggle':
        if (el.paused) el.play();
        else el.pause();
        break;
      case 'cue-prev':
      case 'cue-next': {
        // 点上下文行（PLAN 030）：马上跳到那一句的**开头**并从那里继续播 ——
        // 与控制栏的 prev/next 不同（那两个在句内会先回到本句开头，见 PLAN 004）
        const offset = act === 'cue-prev' ? -1 : 1;
        const current = track.getCurrent();
        const cue = current && current.index != null
          ? (track.getCues() || [])[current.index + offset]
          : null;
        if (!cue) return false;
        el.currentTime = cue.start;
        el.play();
        break;
      }
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

    // 设置页上的回显跟控制栏同一拍（心跳里也会走到这里；收起时 syncPanel 会直接返回）
    syncPanel();
  }

  // ---------------------------------------------------------------- 设置面板（PLAN 033）
  //
  // 结构 / class 全按官方设置面板写（`.settings-panel` / `.panel-page` / `.toggle-row` …），
  // 样式表在开窗时从官方 shadowRoot 整份拷贝过来 —— class 用对就白拿原生观感。
  // 官方 CSS 的布局约定（并排分页、由 JS 设宽度与位移、弹层式语言菜单）在 PiP 里不适用，
  // 所以后面再追加一小段覆盖规则：一次只显示一页、整块可滚动、语言菜单内联展开。
  //
  // ⚠️ 幂等：`syncPanel()` 会被心跳（1s）反复调用，所有写入都必须先比较再写；
  // 需要重建的只有「学习语言变了 → 读音脚本列表」「观看模式变了 → 参数行」这两处，
  // 用 key 比对，绝不允许每秒 replaceChildren 一次。

  /** 官方设置面板宿主 id（50-settings-panel.js 用的是同一个） */
  const OFFICIAL_PANEL_ID = 'linglass-settings-panel-v2';

  /** 面板里的三页（顺序 = DOM 顺序）；'play' 表示回到字幕 */
  const PANEL_PAGES = ['root', 'appearance', 'modes'];
  const PANEL_TITLES = {
    root: '设置',
    appearance: '外观',
    modes: '观看模式',
  };

  /** 官方内置的国旗（flags-*.js）—— 语言下拉的视觉与官方面板一致 */
  const FLAG_SVG = {
    en: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#012169"/><path d="M0,0L60,40M60,0L0,40" stroke="#FFF" stroke-width="8"/><path d="M0,0L60,40M60,0L0,40" stroke="#C8102E" stroke-width="4"/><path d="M30,0V40M0,20H60" stroke="#FFF" stroke-width="12"/><path d="M30,0V40M0,20H60" stroke="#C8102E" stroke-width="7"/></svg>',
    de: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="13.3" fill="#000"/><rect y="13.3" width="60" height="13.4" fill="#DD0000"/><rect y="26.7" width="60" height="13.3" fill="#FFCC00"/></svg>',
    fr: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="20" height="40" fill="#002395"/><rect x="20" width="20" height="40" fill="#FFF"/><rect x="40" width="20" height="40" fill="#ED2939"/></svg>',
    es: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#AA151B"/><rect y="10" width="60" height="20" fill="#F1BF00"/></svg>',
    ja: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#FFF"/><circle cx="30" cy="20" r="12" fill="#BC002D"/></svg>',
    ko: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#FFF"/><circle cx="30" cy="20" r="10" fill="#CD2E3A"/><path d="M30 10a10 10 0 0 1 0 20 5 5 0 0 1 0-10 5 5 0 0 0 0-10z" fill="#0047A0"/></svg>',
    zh: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#DE2910"/><g fill="#FFDE00"><polygon points="10,5 11.8,10.5 17.5,10.5 12.9,14 14.6,19.5 10,16 5.4,19.5 7.1,14 2.5,10.5 8.2,10.5"/></g></svg>',
    ru: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="13.3" fill="#FFF"/><rect y="13.3" width="60" height="13.4" fill="#0039A6"/><rect y="26.7" width="60" height="13.3" fill="#D52B1E"/></svg>',
    it: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="20" height="40" fill="#009246"/><rect x="20" width="20" height="40" fill="#FFF"/><rect x="40" width="20" height="40" fill="#CE2B37"/></svg>',
    'pt-BR': '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#009C3B"/><polygon points="30,4 56,20 30,36 4,20" fill="#FFDF00"/><circle cx="30" cy="20" r="8" fill="#002776"/></svg>',
    'pt-PT': '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="40" fill="#006600"/><rect x="24" width="36" height="40" fill="#FF0000"/><circle cx="24" cy="20" r="7" fill="#FFFF00"/></svg>',
    id: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="20" fill="#CE1126"/><rect y="20" width="60" height="20" fill="#FFF"/></svg>',
    vi: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#DA251D"/><polygon points="30,10 32.9,18.5 42,18.5 34.6,23.5 37.5,32 30,27 22.5,32 25.4,23.5 18,18.5 27.1,18.5" fill="#FFFF00"/></svg>',
    th: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#A51931"/><rect y="6.7" width="60" height="6.6" fill="#FFF"/><rect y="13.3" width="60" height="13.4" fill="#2D2A4A"/><rect y="26.7" width="60" height="6.6" fill="#FFF"/></svg>',
    'zh-Hant': '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#FE0000"/><rect width="30" height="20" fill="#000095"/><circle cx="15" cy="10" r="6" fill="#FFF"/><circle cx="15" cy="10" r="4.5" fill="#000095"/></svg>',
    tr: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#E30A17"/><circle cx="22" cy="20" r="8" fill="#FFF"/><circle cx="24" cy="20" r="6.5" fill="#E30A17"/><polygon points="33,20 28.2,21.6 31.2,17.5 31.2,22.5 28.2,18.4" fill="#FFF"/></svg>',
    pl: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="20" fill="#FFF"/><rect y="20" width="60" height="20" fill="#DC143C"/></svg>',
    hi: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="13.3" fill="#FF9933"/><rect y="13.3" width="60" height="13.4" fill="#FFF"/><rect y="26.7" width="60" height="13.3" fill="#138808"/><circle cx="30" cy="20" r="3.5" fill="none" stroke="#000080" stroke-width="0.8"/></svg>',
    ar: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#FFF"/><rect width="60" height="13.3" fill="#00732F"/><rect y="26.7" width="60" height="13.3" fill="#000"/><rect width="15" height="40" fill="#FF0000"/></svg>',
    sv: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="40" fill="#006AA7"/><rect x="18" width="6" height="40" fill="#FECC00"/><rect y="17" width="60" height="6" fill="#FECC00"/></svg>',
    nl: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="13.3" fill="#AE1C28"/><rect y="13.3" width="60" height="13.4" fill="#FFF"/><rect y="26.7" width="60" height="13.3" fill="#21468B"/></svg>',
    cs: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="20" fill="#FFF"/><rect y="20" width="60" height="20" fill="#D7141A"/><polygon points="0,0 30,20 0,40" fill="#11457E"/></svg>',
    fa: '<svg viewBox="0 0 60 40" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="13.3" fill="#239F40"/><rect y="13.3" width="60" height="13.4" fill="#FFF"/><rect y="26.7" width="60" height="13.3" fill="#DA0000"/></svg>',
  };

  /** 官方面板 CSS 之后追加的覆盖规则（只改布局，不改观感） */
  const PANEL_CSS = `
.settings-panel { width: 100%; max-width: none; height: 100%; opacity: 1; visibility: visible;
  transform: none; overflow: visible; border: none; border-radius: 0; box-shadow: none;
  display: flex; flex-direction: column;
  /* 与浮窗同一个底色：面板不再是浮在暗窗口里的白卡片 */
  background: #141518; }
/* ---- 图标尺寸（PLAN 041）----
   svgIcon() 只写 viewBox，不写 width/height 属性，尺寸只能由 CSS 给。官方的尺寸规则写在
   拷来的那份 CSS 里，而那份 CSS 只在「用户先打开过官方面板」时才拷得到 —— 取不到就走兜底，
   于是这些 <svg> 按替换元素默认的 300×150 渲染（截图里的巨型箭头就是它把整行撑爆）。
   所以尺寸一律钉在本段（最后追加，兜底与官方两条路径都生效），缺一条就会再炸一次。 */
.lang-pair__arrow { width: 12px; height: 12px; flex: none; color: #8E8E93; }
.lang-chevron { width: 10px; height: 10px; flex: none; }
.nav-row__chev { width: 12px; height: 12px; flex: none; color: #8E8E93; }
.toggle-icon, .nav-row__ic { width: 16px; height: 16px; flex: none; }
.mode-row__cyc { width: 14px; height: 14px; flex: none; }
.logo-icon { width: 22px; height: 22px; flex: none; border-radius: 5px; overflow: hidden; }
.font-btn svg { width: 14px; height: 14px; }
.style-btn__art svg { width: 26px; height: 26px; display: block; }
/* 语言名不许换行：窄一点就省略号，而不是被挤成竖排单字 */
.lang-trigger-name { flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.panel-stack { height: auto !important; overflow: visible; }
.panel-pages { display: block; transform: none !important; }
.panel-page { display: none; width: 100% !important; }
.panel-page:not([aria-hidden="true"]) { display: block; visibility: visible; }
.panel-page[aria-hidden="true"] { display: none; }
.panel-content { padding-bottom: 10px; }
/* 语言菜单：官方是绝对定位的浮层；PiP 里改成内联展开，跟着面板一起滚 */
.lang-menu { position: static; display: none; margin-top: 4px; width: 100%;
  max-height: 220px; overflow-y: auto; }
.lang-dropdown.open .lang-menu { display: block; }
/* 我们的分组标题：直接用官方的 .section-label（50-settings-panel.js 注入时也用它） */
.section-label { margin-top: 14px; }
/* 官方面板里这两处把 #FFFFFF 当「面」用（暗色分支分别是 #2C2C2E / #48484A），
   转暗之后会变成白底白字，这里直接钉成暗色值 */
.lang-menu { background: #2C2C2E; }
.segmented-option.active { background: #48484A; color: #FFFFFF; }
`;

  /** 取不到官方样式时的兜底：只保证可读、可点，不追求与官方逐像素一致 */
  const PANEL_FALLBACK_CSS = `
.settings-panel { background: #1c1c1e; color: #f5f5f7; border-radius: 12px;
  border: 1px solid rgba(255,255,255,.1); font-family: -apple-system, BlinkMacSystemFont,
  "PingFang SC", system-ui, sans-serif; font-size: 12px; overflow: hidden; }
.panel-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
.header-title { font-weight: 600; }
.close-btn, .panel-back { background: none; border: none; color: inherit;
  cursor: pointer; display: flex; align-items: center; gap: 4px; padding: 2px; }
.panel-content { padding: 0 12px 10px; }
.toggle-row, .nav-row { display: flex; align-items: center;
  justify-content: space-between; gap: 8px; width: 100%; padding: 9px 0;
  border: none; border-top: 1px solid rgba(255,255,255,.1); background: none;
  color: inherit; font: inherit; text-align: left; }
.toggle-label { display: flex; align-items: center; gap: 8px; min-width: 0; }
.toggle-icon, .nav-row__ic { width: 16px; height: 16px; flex: none; }
.toggle { width: 36px; height: 20px; border: none; border-radius: 10px;
  background: rgba(120,120,128,.36); position: relative; cursor: pointer; flex: none; }
.toggle.on { background: #0a84ff; }
.toggle-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform .2s ease; }
.toggle.on .toggle-knob { transform: translateX(16px); }
.segmented { display: flex; gap: 2px; padding: 2px; border-radius: 8px;
  background: rgba(120,120,128,.2); }
.segmented-option { flex: 1 1 50%; border: none; background: none; color: inherit;
  padding: 6px; border-radius: 6px; cursor: pointer; font: inherit; }
.segmented-option.active { background: rgba(255,255,255,.16); }
.lang-pair { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
.lang-dropdown { position: relative; flex: 1 1 0; min-width: 0; }
.lang-trigger { display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 7px 8px; border: none; border-radius: 8px; background: rgba(255,255,255,.08);
  color: inherit; font: inherit; cursor: pointer; }
.lang-flag { width: 16px; height: 12px; display: inline-flex; flex: none; }
.lang-flag svg { width: 100%; height: 100%; }
.lang-menu { border-radius: 8px; background: #2c2c2e; }
.lang-option { display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 7px 8px; border: none; background: none; color: inherit; font: inherit;
  cursor: pointer; text-align: left; }
.lang-option.selected { color: #0a84ff; }
.style-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.style-btn { padding: 0; border: none; background: none; cursor: pointer;
  color: inherit; }
.style-btn__art { display: flex; align-items: center; justify-content: center;
  height: 46px; border-radius: 9px; background: rgba(255,255,255,.08); }
.style-btn.selected .style-btn__art { box-shadow: inset 0 0 0 2px #0a84ff; }
.style-cap, .mode-cap { margin: 6px 0 10px; font-size: 11px;
  opacity: .7; }
.appearance-controls { display: flex; align-items: center;
  justify-content: space-between; gap: 10px; }
.font-controls { display: flex; align-items: center; border-radius: 8px;
  background: rgba(255,255,255,.08); }
.font-btn { width: 32px; height: 28px; border: none; background: none;
  color: inherit; cursor: pointer; display: flex; align-items: center;
  justify-content: center; }
.font-divider { width: 1px; height: 16px; background: rgba(255,255,255,.2); }
.colors { display: flex; gap: 6px; }
.color-btn { width: 22px; height: 22px; border-radius: 50%;
  border: 2px solid transparent; cursor: pointer; }
.color-btn.selected { border-color: #fff; box-shadow: 0 0 0 2px #0a84ff; }
.mode-row { display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 9px 0; border: none; background: none; color: inherit; font: inherit;
  cursor: pointer; text-align: left; }
.mode-row__val { margin-left: auto; opacity: .7; }
.mode-row__cyc { width: 14px; height: 14px; opacity: .6; }
`;

  /** 显示 / 隐藏一个节点（先比较再写：心跳每秒都会走到这里） */
  function show(el, visible) {
    if (!el) return;
    const next = visible ? '' : 'none';
    if (el.style.display !== next) el.style.display = next;
  }

  /** 读 class（桩件与真 DOM 都能用） */
  function hasClass(el, name) {
    return !!(el && el.classList && el.classList.contains(name));
  }

  /** 先比较再写 class；桩件的 classList 只有 add/remove，所以不用 toggle(name, force) */
  function toggleClass(el, name, on) {
    if (!el || hasClass(el, name) === on) return;
    if (el.classList && typeof el.classList.add === 'function') {
      if (on) el.classList.add(name);
      else el.classList.remove(name);
      return;
    }
    el.className = on ? `${el.className} ${name}`.trim() : el.className;
  }

  /** 在字幕与设置页之间切换（只切 display；设置页自己滚动） */
  function setPanelMode() {
    if (!pipWin) return;
    const open = barMode !== 'play';
    const d = pipWin.document;
    show(d.getElementById('stage'), !open);
    show(d.getElementById('bar'), !open);
    show(d.getElementById('progress'), !open);
    show(d.getElementById('settings'), open);
    if (open) syncPanel();
  }

  function makeEl(d, tag, className, text) {
    const el = d.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  /**
   * 官方 CSS 里那一份 `<style>` 的全文。
   * 取不到（官方面板还没构造出来 / 被裁剪的包）时返回空串，由调用方退回兜底样式。
   */
  function officialPanelCss() {
    const host = document.getElementById(OFFICIAL_PANEL_ID);
    const shadow = host && host.shadowRoot;
    const style = shadow && typeof shadow.querySelector === 'function'
      ? shadow.querySelector('style')
      : null;
    return style && typeof style.textContent === 'string' ? style.textContent : '';
  }

  /**
   * 官方亮色面板 CSS → 暗色（PLAN 036）。
   *
   * 为什么需要：浮窗本身是暗的（#141518），而官方面板跟系统主题走 —— 系统是亮色时，
   * 拷进来的是一整张白卡片，在暗窗口里非常割裂。
   *
   * 做法：官方每种颜色都是构造时插值进去的**字面量**（没有 CSS 变量），所以把「亮色
   * 调色板」按字符串换一遍就行。只换**带空格的调色板写法**与模板里明确用于背景/边框的
   * 紧凑写法；`rgba(0,0,0,0.15)` 这类项目里写死的投影不动（换白了会变成发光）。
   * 已经是暗色时（找得到 #FFFFFF 作为 textPrimary、找不到 #1D1D1F）原样返回。
   */
  const LIGHT_TO_DARK = [
    // —— 调色板（selectionHandler 的 Nt.light / Nt.dark）——
    ['rgba(255, 255, 255, 0.72)', 'rgba(44, 44, 46, 0.72)'],   // bgGlass
    ['rgba(255, 255, 255, 0.88)', 'rgba(28, 28, 30, 0.92)'],   // bgGlassElevated
    ['#1D1D1F', '#FFFFFF'],                                     // textPrimary
    ['#007AFF', '#0A84FF'],                                     // accent / toggleOn
    ['#0056CC', '#3A9FFF'],                                     // accentHover
    ['rgba(0, 0, 0, 0.08)', 'rgba(255, 255, 255, 0.08)'],      // borderSubtle / shadowGlass
    ['rgba(0, 0, 0, 0.12)', 'rgba(255, 255, 255, 0.12)'],      // borderDefault / shadowElevated
    ['rgba(0, 0, 0, 0.15)', 'rgba(255, 255, 255, 0.15)'],      // toggleOff
    ['rgba(0, 0, 0, 0.06)', 'rgba(255, 255, 255, 0.08)'],      // buttonSecondary / selectBg
    ['rgba(0, 0, 0, 0.1)', 'rgba(255, 255, 255, 0.1)'],        // inputBorder
    ['rgba(0, 0, 0, 0.04)', 'rgba(255, 255, 255, 0.06)'],      // inputBg / rowHover
    // 面板表面的亮色渐变 / 投影（getStyleContent 里的三元分支）
    ['rgba(255,255,255,0.9)', 'rgba(255,255,255,0.06)'],
    ['rgba(255,255,255,0.7)', 'rgba(255,255,255,0.02)'],
    ['0 16px 40px -8px rgba(0,0,0,0.12)', '0 16px 40px -8px rgba(0,0,0,0.5)'],
    // —— 模板里「亮色分支」的紧凑写法 ——
    ['rgba(0,0,0,0.06)', 'rgba(255,255,255,0.1)'],
    ['rgba(0,0,0,0.05)', 'rgba(255,255,255,0.08)'],
    ['rgba(0,0,0,0.04)', 'rgba(255,255,255,0.07)'],
    ['rgba(0,0,0,0.035)', 'rgba(255,255,255,0.06)'],
    ['rgba(0,0,0,0.03)', 'rgba(255,255,255,0.05)'],
    ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.08)'],
    ['rgba(0,0,0,0.1)', 'rgba(255,255,255,0.1)'],
    ['rgba(0,0,0,0.07)', 'rgba(255,255,255,0.08)'],
    ['rgba(0,0,0,0.09)', 'rgba(255,255,255,0.1)'],
    ['rgba(0,0,0,0.4)', 'rgba(0,0,0,0.5)'],
    ['rgba(0,0,0,0.12)', 'rgba(0,0,0,0.5)'],
  ];

  function darkPanelCss(css) {
    if (!css || css.indexOf('#1D1D1F') === -1) return css; // 已经是暗色（或取不到）

    // 次级灰 / 三级灰在暗色里是「互换」关系，先各自占位，最后再落回去
    let out = css.split('#636366').join('\u0001');
    out = out.split('#8E8E93').join('\u0002');
    for (const [from, to] of LIGHT_TO_DARK) out = out.split(from).join(to);
    out = out.split('\u0001').join('#8E8E93');
    out = out.split('\u0002').join('#636366');
    return out;
  }

  /** 静态 SVG 片段 → 元素；片段都是我们自己的常量 */
  function svgIcon(d, className, markup) {
    const holder = d.createElement('span');
    holder.innerHTML = markup;
    const child = holder.firstElementChild || null;
    // SVG 元素的 className 是 SVGAnimatedString，赋值会被静默吞掉 —— 必须走 setAttribute
    if (child && className) child.setAttribute('class', className);
    return child;
  }

  function buildToggleRow(d, { act, title, icon, id, master }) {
    const row = makeEl(d, 'div', master ? 'toggle-row master-toggle-row' : 'toggle-row');
    const label = makeEl(d, 'div', 'toggle-label');
    const iconEl = svgIcon(d, 'toggle-icon', icon);
    if (iconEl) label.append(iconEl);
    label.append(makeEl(d, 'span', null, title));

    const toggle = makeEl(d, 'button', 'toggle');
    toggle.type = 'button';
    toggle.dataset.act = act;
    if (id) toggle.id = id;
    toggle.append(makeEl(d, 'span', 'toggle-knob'));
    row.append(label, toggle);
    return { row, toggle };
  }

  function buildNavRow(d, { act, title, icon, id }) {
    const row = makeEl(d, 'button', 'nav-row');
    row.type = 'button';
    row.dataset.act = act;
    if (id) row.id = id;

    const iconEl = svgIcon(d, 'nav-row__ic', icon);
    if (iconEl) row.append(iconEl);
    row.append(makeEl(d, 'span', 'nav-row__name', title));
    const value = makeEl(d, 'span', 'nav-row__val');
    row.append(value);
    const chevron = svgIcon(d, 'nav-row__chev', ICON_CHEVRON_RIGHT);
    if (chevron) row.append(chevron);
    return { row, value };
  }

  function buildStyleGrid(d) {
    const grid = makeEl(d, 'div', 'style-grid');
    grid.setAttribute('role', 'radiogroup');
    const tiles = new Map();

    for (const name of STYLE_CHOICES) {
      const btn = makeEl(d, 'button', 'style-btn');
      btn.type = 'button';
      btn.dataset.act = `style:${name}`;
      btn.setAttribute('role', 'radio');
      const label = STYLE_LABELS[name] || name;
      const desc = STYLE_DESCS[name] || '';
      btn.setAttribute('aria-label', `${label}。${desc}`);
      btn.title = `${label} — ${desc}`;

      const art = makeEl(d, 'span', 'style-btn__art');
      const svg = svgIcon(d, null, `<svg viewBox="0 0 24 24" aria-hidden="true">${STYLE_ICONS[name] || ''}</svg>`);
      if (svg) art.append(svg);
      btn.append(art);
      grid.append(btn);
      tiles.set(name, btn);
    }
    return { grid, tiles };
  }

  function buildColorPalette(d) {
    const colors = makeEl(d, 'div', 'colors');
    const buttons = new Map();
    for (const hex of COLOR_PRESETS) {
      const btn = makeEl(d, 'button', 'color-btn');
      btn.type = 'button';
      btn.dataset.act = `color:${hex}`;
      btn.setAttribute('aria-label', `字幕颜色 ${COLOR_NAMES[hex] || hex}`);
      btn.title = COLOR_NAMES[hex] || hex;
      btn.style.background = hex;
      colors.append(btn);
      buttons.set(hex, btn);
    }
    return { colors, buttons };
  }

  function buildLangDropdown(d, setting, list) {
    const wrap = makeEl(d, 'div', 'lang-dropdown');
    wrap.dataset.setting = setting;

    const trigger = makeEl(d, 'button', 'lang-trigger');
    trigger.type = 'button';
    trigger.dataset.act = `lang-menu:${setting}`;
    const flag = makeEl(d, 'span', 'lang-flag');
    const name = makeEl(d, 'span', 'lang-trigger-name');
    trigger.append(flag, name);
    const chevron = svgIcon(d, 'lang-chevron', ICON_CHEVRON_DOWN);
    if (chevron) trigger.append(chevron);

    const menu = makeEl(d, 'div', 'lang-menu');
    const options = new Map();
    for (const item of list) {
      const btn = makeEl(d, 'button', 'lang-option');
      btn.type = 'button';
      btn.dataset.act = `lang:${setting}:${item.code}`;
      const optionFlag = makeEl(d, 'span', 'lang-flag');
      optionFlag.innerHTML = FLAG_SVG[item.code] || '';
      btn.append(optionFlag, makeEl(d, 'span', null, item.name));
      menu.append(btn);
      options.set(item.code, btn);
    }

    wrap.append(trigger, menu);
    return { wrap, trigger, flag, name, menu, options };
  }

  /**
   * 搭整套设置面板。
   * 返回的 `nodes` 全是回显要用的引用 —— syncPanel() 只认它们，不再查选择器。
   */
  function buildSettingsPanel(d) {
    const nodes = {
      pages: {},
      toggles: new Map(),
      navs: new Map(),
      langs: {},
      features: new Map(),
      actions: new Map(),
      presets: new Map(),
      colors: new Map(),
      modeTiles: new Map(),
      modeToggles: new Map(),
      styleCap: null,
      modeCap: null,
      modeParams: null,
      readingRow: null,
      readingSegmented: null,
      _readingRow: null,
      readingKey: null,
      modeKey: '',
      back: null,
      backTitle: null,
      title: null,
      ctxValue: null,
    };

    const page = (name) => {
      const el = makeEl(d, 'div', 'panel-content panel-page');
      el.dataset.page = name;
      el.setAttribute('aria-hidden', 'true');
      nodes.pages[name] = el;
      return el;
    };

    // ---------------------------------------------------------------- 根页
    const root = page('root');

    const pair = makeEl(d, 'div', 'lang-pair');
    nodes.langs.learningLanguage = buildLangDropdown(d, 'learningLanguage', LEARNING_LANGUAGES);
    nodes.langs.nativeLanguage = buildLangDropdown(d, 'nativeLanguage', NATIVE_LANGUAGES);
    const arrow = svgIcon(d, 'lang-pair__arrow', ICON_ARROW_RIGHT);
    pair.append(nodes.langs.learningLanguage.wrap);
    if (arrow) pair.append(arrow);
    pair.append(nodes.langs.nativeLanguage.wrap);
    root.append(pair);

    const switches = makeEl(d, 'div', 'toggle-section');
    const rows = [
      {
        key: 'enabled',
        act: 'toggle:enabled',
        title: 'Linglass 字幕',
        master: true,
        icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11h4M7 15h2M15 11h2M13 15h4"/>',
      },
      {
        key: 'dualSubtitles',
        act: 'toggle:dualSubtitles',
        title: '双语字幕',
        icon: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
      },
      {
        key: 'reading',
        act: 'reading',
        title: '词语上方显示读音',
        icon: '<path d="M4 7h16"/><path d="M9 12h6M8 17h8"/>',
      },
      {
        key: 'mediaCaptureEnabled',
        act: 'toggle:mediaCaptureEnabled',
        title: '配图',
        icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.6"/><path d="m21 16-4.5-4L7 21"/>',
      },
    ];
    for (const item of rows) {
      const built = buildToggleRow(d, {
        act: item.act,
        title: item.title,
        icon: `<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>`,
        master: item.master,
      });
      switches.append(built.row);
      nodes.toggles.set(item.key, built.toggle);
    }
    root.append(switches);

    const scriptRow = makeEl(d, 'div', 'reading-script-row');
    nodes.readingRow = scriptRow;
    nodes.readingSegmented = makeEl(d, 'div', 'segmented');
    scriptRow.append(nodes.readingSegmented);
    root.append(scriptRow);

    const modesNav = buildNavRow(d, {
      act: 'page:modes',
      title: '观看模式',
      icon: ICON_MODES,
    });
    root.append(modesNav.row);
    nodes.navs.set('modes', modesNav.value);

    const appearanceNav = buildNavRow(d, {
      act: 'page:appearance',
      title: '外观',
      icon: ICON_APPEARANCE,
    });
    root.append(appearanceNav.row);
    nodes.navs.set('appearance', appearanceNav.value);

    // 我们自己的开关与动作：数据来自共享注册表（与官方面板里的分组同一份）
    const features = shared.listFeatures();
    const toggleable = features.filter((item) => typeof item.toggle === 'function');
    const actionable = features.flatMap((item) => (item.actions || []).map((action) => ({ item, action })));

    if (toggleable.length || actionable.length) {
      root.append(makeEl(d, 'div', 'section-label', SECTION_TITLE));
      const ours = makeEl(d, 'div', 'toggle-section');
      for (const feature of toggleable) {
        const built = buildToggleRow(d, {
          act: `feature:${feature.id}`,
          title: feature.title,
          icon: feature.icon || '',
        });
        ours.append(built.row);
        nodes.features.set(feature.id, built.toggle);
      }
      root.append(ours);

      if (actionable.length) {
        for (const { item, action } of actionable) {
          const built = buildNavRow(d, {
            act: `action:${item.id}:${action.id}`,
            title: action.title,
            icon: action.icon || '',
          });
          root.append(built.row);
          nodes.actions.set(`${item.id}:${action.id}`, built.value);
        }
      }
    }

    // ---------------------------------------------------------------- 外观页
    const appearancePage = page('appearance');

    const styleRow = makeEl(d, 'div', 'style-row');
    const head = makeEl(d, 'div', 'style-row__head');
    const headIcon = svgIcon(d, 'toggle-icon',
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2.5"/></svg>');
    if (headIcon) head.append(headIcon);
    head.append(makeEl(d, 'span', null, '样式'));
    const styleGrid = buildStyleGrid(d);
    for (const [name, btn] of styleGrid.tiles) nodes.presets.set(name, btn);
    nodes.styleCap = makeEl(d, 'p', 'style-cap');
    styleRow.append(head, styleGrid.grid, nodes.styleCap);
    appearancePage.append(styleRow);

    const controls = makeEl(d, 'div', 'appearance-controls');
    const fontControls = makeEl(d, 'div', 'font-controls');
    const minus = makeEl(d, 'button', 'font-btn');
    minus.type = 'button';
    minus.dataset.act = 'scale-';
    minus.setAttribute('aria-label', '字号调小');
    const minusIcon = svgIcon(d, null,
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="12" x2="18" y2="12"/></svg>');
    if (minusIcon) minus.append(minusIcon);
    const plus = makeEl(d, 'button', 'font-btn');
    plus.type = 'button';
    plus.dataset.act = 'scale+';
    plus.setAttribute('aria-label', '字号调大');
    const plusIcon = svgIcon(d, null,
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="6" x2="12" y2="18"/><line x1="6" y1="12" x2="18" y2="12"/></svg>');
    if (plusIcon) plus.append(plusIcon);
    fontControls.append(minus, makeEl(d, 'div', 'font-divider'), plus);

    const palette = buildColorPalette(d);
    for (const [hex, btn] of palette.buttons) nodes.colors.set(hex, btn);
    controls.append(fontControls, palette.colors);
    appearancePage.append(controls);

    // 上下文行数：浮窗自己的维度，用原生 nav-row 呈现（点击循环 0 / 1 / 2）
    const ctxRow = buildNavRow(d, {
      act: 'ctx',
      title: '上下文行数',
      icon: ICON_CONTEXT,
    });
    nodes.ctxValue = ctxRow.value;
    appearancePage.append(ctxRow.row);

    // ---------------------------------------------------------------- 观看模式页
    const modes = page('modes');
    const modeGrid = makeEl(d, 'div', 'style-grid');
    modeGrid.setAttribute('role', 'radiogroup');
    for (const mode of MODES) {
      const btn = makeEl(d, 'button', 'style-btn');
      btn.type = 'button';
      btn.dataset.act = `mode:${mode}`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', MODE_LABELS[mode] || mode);
      btn.title = MODE_LABELS[mode] || mode;
      const art = makeEl(d, 'span', 'style-btn__art');
      const svg = svgIcon(d, null,
        `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${MODE_GLYPHS[mode] || ''}</svg>`);
      if (svg) art.append(svg);
      btn.append(art);
      modeGrid.append(btn);
      nodes.modeTiles.set(mode, btn);
    }
    nodes.modeCap = makeEl(d, 'p', 'mode-cap');
    nodes.modeParams = makeEl(d, 'div', 'mode-params');
    modes.append(modeGrid, nodes.modeCap, nodes.modeParams);

    const modeToggles = makeEl(d, 'div', 'toggle-section mode-toggles');
    for (const item of [
      {
        key: 'pauseOnTranslate',
        title: '翻译时暂停',
        icon: '<rect x="6.5" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.3" fill="currentColor" stroke="none"/>',
      },
      {
        key: 'showHints',
        title: '视频上的提示',
        icon: '<path d="M4 5.5h16v10H13l-4 3.4V15.5H4Z"/><path d="M8 10.5h8" stroke-linecap="round"/>',
      },
    ]) {
      const built = buildToggleRow(d, {
        act: `mode-toggle:${item.key}`,
        title: item.title,
        icon: `<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>`,
      });
      modeToggles.append(built.row);
      nodes.modeToggles.set(item.key, built.toggle);
    }
    modes.append(modeToggles);

    // ---------------------------------------------------------------- 头部与外壳
    const panel = makeEl(d, 'div', 'settings-panel open');
    panel.id = 'llg-settings-panel';
    panel.setAttribute('role', 'dialog');

    const header = makeEl(d, 'div', 'panel-header');
    const back = makeEl(d, 'button', 'panel-back');
    back.type = 'button';
    back.dataset.act = 'page-back';
    back.hidden = true;
    const backIcon = svgIcon(d, null,
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18 9 12l6-6"/></svg>');
    if (backIcon) back.append(backIcon);
    nodes.backTitle = makeEl(d, 'span', 'panel-back__title', '设置');
    back.append(nodes.backTitle);

    const left = makeEl(d, 'div', 'header-left');
    const logo = svgIcon(d, 'logo-icon', ICON_LOGO);
    if (logo) left.append(logo);
    nodes.title = makeEl(d, 'span', 'header-title', '设置');
    left.append(nodes.title);

    const right = makeEl(d, 'div', 'header-right');
    const close = makeEl(d, 'button', 'close-btn');
    close.type = 'button';
    close.dataset.act = 'settings-close';
    close.setAttribute('aria-label', '返回字幕');
    close.title = '返回字幕';
    const closeIcon = svgIcon(d, null,
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>');
    if (closeIcon) close.append(closeIcon);
    right.append(close);

    // 顺序与官方一致：左边品牌，子页时品牌让位给返回按钮（官方 .panel-back 是 flex:1）
    header.append(left, back, right);
    nodes.left = left;

    const stack = makeEl(d, 'div', 'panel-stack');
    const pages = makeEl(d, 'div', 'panel-pages');
    pages.append(root, appearancePage, modes);
    stack.append(pages);
    panel.append(header, stack);

    const host = makeEl(d, 'div', 'llg-settings-host');
    host.id = 'settings';
    host.style.display = 'none';

    nodes.panel = panel;
    nodes.back = back;
    // 面板本体不在这里挂：调用方决定进 shadowRoot（浏览器）还是直接进宿主（测试桩）
    return { host, nodes, panel };
  }

  /** 重建读音脚本分段（只有学习语言变了才做） */
  function syncReadingScripts(nodes) {
    const lang = officialSettings.learningLanguage;
    const key = learningKey();
    if (nodes.readingKey === key) return;
    nodes.readingKey = key;

    const scripts = readingScriptsOf(lang);
    if (nodes.readingRow) nodes.readingRow.hidden = !scripts.length;

    const segmented = nodes.readingSegmented;
    if (!segmented || typeof segmented.replaceChildren !== 'function') return;
    segmented.replaceChildren();
    // 官方 refreshReadingRow()：分段里只放「真脚本」，on/off 由上面的开关负责
    for (const script of scripts.filter((name) => name !== 'off')) {
      const btn = makeEl(pipWin.document, 'button', 'segmented-option', READING_LABELS[script] || script);
      btn.type = 'button';
      btn.dataset.act = `reading:${script}`;
      btn.dataset.script = script;
      segmented.append(btn);
    }
  }

  /** 重建观看模式的参数行（模式 / 任一字段变了才做） */
  function syncModeParams(nodes) {
    const viewing = currentViewing();
    const key = JSON.stringify(viewing);
    if (nodes.modeKey === key) return;
    nodes.modeKey = key;
    if (!nodes.modeParams) return;

    const d = pipWin.document;
    const fields = viewing.mode === 'pause'
      ? ['pause.at', 'pause.length']
      : viewing.mode === 'repeat'
        ? ['repeat.count', 'repeat.rate']
        : viewing.mode === 'listen'
          ? ['listen.target', 'listen.cover', 'listen.length']
          : [];

    const [group] = fields.length ? fields[0].split('.') : [null];
    const rows = fields.map((field) => {
      const [, key2] = field.split('.');
      const spec = VIEWING_FIELDS[field];
      const row = makeEl(d, 'button', 'mode-row');
      row.type = 'button';
      row.dataset.act = `mode-field:${field}`;
      row.append(makeEl(d, 'span', 'mode-row__name', FIELD_LABELS[field] || field));
      row.append(makeEl(d, 'span', 'mode-row__val', String(spec.labels[viewing[group][key2]] ?? '')));
      const cyc = svgIcon(d, 'mode-row__cyc',
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5V8.6A3.6 3.6 0 0 1 7.6 5H18m-3-2.6L18 5l-3 2.6M20 14.5v.9a3.6 3.6 0 0 1 -3.6,3.6H6m3 2.6L6 19l3-2.6"/></svg>');
      if (cyc) row.append(cyc);
      return row;
    });
    nodes.modeParams.replaceChildren(...rows);
  }

  /**
   * 面板回显：所有写入都先比较再写（心跳每秒都会调它）。
   * 面板收起时直接返回 —— 没人看得到，没必要改 DOM。
   */
  function syncPanel() {
    if (!pipWin || !panelNodes || barMode === 'play') return;
    const nodes = panelNodes;
    const s = officialSettings;

    for (const [name, page] of Object.entries(nodes.pages)) {
      const hidden = name !== barMode;
      const value = String(hidden);
      if (page.getAttribute('aria-hidden') !== value) page.setAttribute('aria-hidden', value);
    }

    const sub = barMode !== 'root';
    if (nodes.back) {
      if (nodes.back.hidden !== !sub) nodes.back.hidden = !sub;
      if (sub) setText(nodes.backTitle, PANEL_TITLES[barMode] || '设置');
    }
    // 官方：子页时品牌区整块让位给返回按钮（.header-left[hidden] 才会真的 display:none）
    if (nodes.left && nodes.left.hidden !== sub) nodes.left.hidden = sub;
    if (nodes.title) setText(nodes.title, '设置');

    // 开关
    const readingOn = readingModeOf(s.learningLanguage, s.readingMode) !== 'off';
    for (const [key, toggle] of nodes.toggles) {
      const on = key === 'reading' ? readingOn : !!s[key];
      toggleClass(toggle, 'on', on);
    }
    for (const [key, toggle] of nodes.modeToggles) {
      const on = !!currentViewing()[key];
      toggleClass(toggle, 'on', on);
    }

    // 语言
    for (const [setting, lang] of Object.entries(nodes.langs)) {
      const code = s[setting];
      const list = setting === 'nativeLanguage' ? NATIVE_LANGUAGES : LEARNING_LANGUAGES;
      const item = list.find((entry) => entry.code === code) || null;
      setText(lang.name, item ? item.name : '选择语言');
      const open = openMenu === setting;
      toggleClass(lang.wrap, 'open', open);
      if (lang.flag) {
        const markup = item && FLAG_SVG[item.code] ? FLAG_SVG[item.code] : '';
        if (lang.flag._llgFlag !== markup) {
          lang.flag.innerHTML = markup;
          lang.flag._llgFlag = markup;
        }
      }
      for (const [optionCode, btn] of lang.options) {
        const selected = optionCode === code;
        toggleClass(btn, 'selected', selected);
      }
    }

    // 根页的 nav-row 数值
    setText(nodes.navs.get('modes'), MODE_LABELS[s.viewing.mode] || s.viewing.mode);
    setText(nodes.navs.get('appearance'), `${s.subtitleScale}%`);

    // 读音脚本
    syncReadingScripts(nodes);
    const script = readingModeOf(s.learningLanguage, s.readingMode);
    // 官方 refreshReadingRow()：读音关着、或这门语言只有一种脚本时，分段控件不显示
    const pickable = readingScriptsOf(s.learningLanguage).filter((name) => name !== 'off');
    if (nodes.readingSegmented) {
      const hide = script === 'off' || pickable.length < 2;
      if (nodes.readingSegmented.hidden !== hide) nodes.readingSegmented.hidden = hide;
    }
    for (const btn of nodes.readingSegmented.children || []) {
      toggleClass(btn, 'active', btn.dataset.script === script);
    }

    // 外观
    for (const [name, btn] of nodes.presets) {
      const selected = s.subtitleStyle === name;
      toggleClass(btn, 'selected', selected);
    }
    // 官方 renderStyleCaption()：预设名是 <b>，后面接「 — 说明」
    const capName = STYLE_LABELS[s.subtitleStyle] || s.subtitleStyle;
    const capDesc = STYLE_DESCS[s.subtitleStyle] || '';
    const capKey = `${capName}\u0000${capDesc}`;
    if (nodes.styleCap && nodes.styleCap._llgCap !== capKey) {
      nodes.styleCap.innerHTML = `<b>${capName}</b> — ${capDesc}`;
      nodes.styleCap._llgCap = capKey;
    }
    for (const [hex, btn] of nodes.colors) {
      const selected = s.subtitleColor === hex;
      toggleClass(btn, 'selected', selected);
    }
    setText(nodes.ctxValue, `${clampCtxLines(own.ctxLines)} / ${CTX_MAX}`);

    // 观看模式
    for (const [mode, btn] of nodes.modeTiles) {
      const selected = s.viewing.mode === mode;
      toggleClass(btn, 'selected', selected);
      const label = MODE_LABELS[mode] || mode;
      if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
    }
    setText(nodes.modeCap, viewingCaption(s.viewing));
    syncModeParams(nodes);

    // 我们自己的功能
    for (const feature of shared.listFeatures()) {
      const toggle = nodes.features.get(feature.id);
      if (toggle) {
        const on = typeof feature.isOn === 'function' ? !!feature.isOn() : false;
        toggleClass(toggle, 'on', on);
      }
      for (const action of feature.actions || []) {
        const value = nodes.actions.get(`${feature.id}:${action.id}`);
        if (value && typeof action.value === 'function') setText(value, String(action.value()));
      }
    }
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
      pushTimeline();
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
   *
   * 注意 `enabled` 默认是 false（PLAN 040）：没被按钮/开关打开过的用户**根本不会武装**，
   * 点页面任意处都不会弹窗。
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
      // 这次手势落在「还不是播放页」的时刻（导航还没完成 / 视频还没挂上）：
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
      // 尺寸按**当前外观**现算：字号不跟窗口走，那窗口就得跟着字号走（见 pipHeight）
      pipWin = await documentPictureInPicture.requestWindow({
        width: PIP_WIDTH,
        height: pipHeight(appearance),
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
    styleEl = null; // 那两张 <style> 随窗口一起没了
    panelNodes = null;
    timelineDragging = false;
    lastTimeline = null; // 设置面板的回显引用同理
    barMode = 'play';  // 新窗口从播放控制栏开始，不继承上一扇窗的样式条状态
    lastKey = '';
    lastCueIndex = -1; // 新窗口的第一次填充不播滚轮动效
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
    { id: 'pip-style', act: 'appearance', glyph: 'Aa', label: '字幕样式' },
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

    // 上下文行（PLAN 029）：当前句上面一段「上一句」、下面一段「下一句」。
    // 结构与当前句刻意不同 —— 它们没有底板、没有进度填充（那两样属于正在读的那句），
    // 而且整段是淡的（.ctx 上的 opacity），只有当前句不透明。
    // 两块都挂 data-act：点它 = 跳到那一句的开头重播（PLAN 030）
    const ctxBlock = (side, act) => {
      const block = d.createElement('div');
      block.className = 'ctx';
      block.id = side;
      block.dataset.act = act;
      for (const kind of ['primary', 'secondary']) {
        const text = d.createElement('span');
        text.className = 'ctx-line';
        text.id = `${side}-${kind}`;
        block.append(text);
      }
      return block;
    };
    const prev = ctxBlock('prev', 'cue-prev');
    const next = ctxBlock('next', 'cue-next');

    // 三段装在 #reel 里：换句时整列像滚轮一样推进一格（见 PIP_BASE_CSS 的 keyframes）
    const reel = d.createElement('div');
    reel.id = 'reel';
    reel.append(prev, plate, next);

    stage.append(reel);

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

    // 整片进度条（PLAN 037）：放在控制栏正上方
    const progress = d.createElement('div');
    progress.id = 'progress';
    progress.setAttribute('role', 'slider');
    progress.setAttribute('aria-label', '播放进度');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    progress.setAttribute('aria-valuenow', '0');
    const progressFill = d.createElement('i');
    progressFill.id = 'progress-fill';
    progress.append(progressFill);

    if (typeof progress.addEventListener === 'function') {
      const seekAt = (ev) => {
        const fraction = timelineFraction(ev);
        if (fraction !== null) seekToFraction(fraction);
      };
      progress.addEventListener('pointerdown', (ev) => {
        timelineDragging = true;
        if (typeof ev.preventDefault === 'function') ev.preventDefault();
        if (typeof progress.setPointerCapture === 'function' && ev.pointerId !== undefined) {
          try {
            progress.setPointerCapture(ev.pointerId);
          } catch {
            // 不支持就算了，document 上的 move 仍然能收到
          }
        }
        seekAt(ev);
      });
      d.addEventListener('pointermove', (ev) => {
        if (timelineDragging) seekAt(ev);
      });
      d.addEventListener('pointerup', () => {
        timelineDragging = false;
      });
      d.addEventListener('pointercancel', () => {
        timelineDragging = false;
      });
    }

    const bars = d.createElement('div');
    bars.id = 'bars';
    bars.append(progress, bar);

    // 设置页与字幕区互斥：切换只改 display（见 setPanelMode）
    const { host: settings, nodes: panel, panel: panelEl } = buildSettingsPanel(d);
    panelNodes = panel;

    // 面板整体放进 shadowRoot：官方 CSS 开头是一条 `* { margin:0; padding:0 }` 的全局重置，
    // 直接注入文档会把字幕区的排版一起清掉。shadow 里既保留原生观感，又把影响面锁在面板内。
    const copied = darkPanelCss(officialPanelCss());
    const panelStyle = d.createElement('style');
    panelStyle.id = 'llg-settings-style';
    panelStyle.textContent = [copied ? '' : PANEL_FALLBACK_CSS, copied, PANEL_CSS].join('\n');
    const panelShadow = typeof settings.attachShadow === 'function'
      ? settings.attachShadow({ mode: 'open' })
      : null;
    if (panelShadow) {
      panelShadow.append(panelStyle, panelEl);
    } else {
      // 测试桩没有 shadowRoot：退回直接挂（反正那里只看节点引用）
      d.head.append(panelStyle);
      settings.append(panelEl);
    }

    box.append(stage, bars, settings);
    d.body.append(box);

    setPanelMode();
    syncPanel();

    // 委托：一个监听器覆盖全部按钮，按钮是浮窗自己的，不受页面影响。
    // 面板在 shadowRoot 里，click 会被重定向到宿主，所以要先走 composedPath 找按钮。
    d.addEventListener('click', (ev) => {
      let btn = null;
      if (typeof ev.composedPath === 'function') {
        for (const node of ev.composedPath()) {
          if (node && node.dataset && node.dataset.act) {
            btn = node;
            break;
          }
        }
      }
      if (!btn) {
        const target = ev.target;
        btn = target && typeof target.closest === 'function'
          ? target.closest('[data-act]')
          : null;
      }
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

  /**
   * 切好的片段 → 手机端要的「段落数组」（PLAN 038）。
   *
   * 手机只有一个渲染器（外层 = 文节段，内层 = token），所以纯文本行也要折成同一个形状：
   * 分隔符不进数组，它由「段与段之间」隐式表达。
   */
  function partsToSegments(parts) {
    const segments = [];
    let seg = [];
    for (const part of parts) {
      if (part.sep) {
        if (seg.length) segments.push(seg);
        seg = [];
        continue;
      }
      if (part.text) seg.push({ text: part.text, ruby: '' });
    }
    if (seg.length) segments.push(seg);
    return segments;
  }

  /**
   * 当前这一屏的字幕结构（给手机字幕屏用）。
   *
   * 与 pushText() 共用 richTokens / cuePoints / primaryParts / richSegments，
   * 所以手机上的注音与文节断句跟浮窗**逐字一致**；区别只是这里返回数据、不碰 DOM ——
   * 因此浮窗没开（pipWin 为 null）时也能用。
   */
  /**
   * 单槽缓存：手机屏常开时这个函数每秒被调 5~6 次（250ms 的 rAF + 1s 心跳 +
   * track.subscribe），而同一句的分词 / 注音分段结果完全一样。不做缓存的话，
   * 光是「重复切同一句话」就是持续的 CPU 与 GC 开销。
   *
   * key 里带 `index`：同一段文本可能在相邻两句重复出现（「はい」），此时 prev/next
   * 不同，不能只按文本命中。
   */
  let castCache = { key: '', value: null };

  function castLines() {
    const lines = currentLines();
    const tokens = richTokens(lines.primary);
    const current = track && typeof track.getCurrent === 'function' ? track.getCurrent() : null;
    const key = [
      current ? current.index : -1,
      lines.primary,
      lines.secondary,
      appearance.dual ? 1 : 0,
      tokens ? 1 : 0,
    ].join('\u0000');

    if (castCache.key === key && castCache.value) return castCache.value;

    const value = {
      primary: lines.primary || '',
      segments: tokens
        ? richSegments(tokens, cuePoints(lines.primary))
        : partsToSegments(primaryParts(lines.primary)),
      // 双语关掉时官方也不显示译文行 —— 手机跟着它
      secondary: appearance.dual ? lines.secondary || '' : '',
      prev: contextCue(-1),
      next: contextCue(1),
    };
    castCache = { key, value };
    return value;
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
      // 官方设置（PLAN 033）：面板上的每一次调整都走 command()，这里给测试与探针留一个
      // 不必模拟点击的直入口；`patchOfficial` 会顺带写回 chrome.storage.sync
      official: () => ({ ...officialSettings }),
      patchOfficial,
      // 浮窗自己的设置只剩上下文行数
      pipOption: () => ({ ...own }),
      setPipOption: (patch) => {
        setOwn(patch);
        return { ...own };
      },
      parseOwn,
      fontSizeFromScale,
      normalizeViewing,
      viewingCaption,
      readingScriptsOf,
      readingModeOf,
      stepScale,
      barMode: () => barMode,
      // 亮色 → 暗色的面板换色（PLAN 036），纯字符串变换，便于单测
      darkPanelCss,
      PANEL_PAGES,
      STYLE_CHOICES,
      COLOR_PRESETS,
      // 上下文行（PLAN 029）：给测试留一个按偏移取相邻句的直入口（-1 上一句 / +1 下一句）
      contextText: (offset) => contextCue(offset),
      // 手机字幕屏（PLAN 038）：当前屏的切词 / 注音 / 上下文，与浮窗渲染同一份规则
      castLines,
      partsToSegments,
      CTX_DEFAULT,
      CTX_MAX,
      // 播放控制：测试与 probe 直接驱动 command()，不必模拟浮窗里的点击
      command,
      syncBar,
      pushTimeline,
      seekToFraction,
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
    desc: '默认关闭：点这里的开关或控制栏按钮才会弹出（点视频、点页面不会）。打开后只有这两处能关掉它；点浮窗自己的 X、切后台、刷新页面都会让它自己回来',
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

  // 浮窗外观：启动读一次（首次拿官方当前值播种），之后官方那边再改**只跟语言**
  // —— 样式 / 字号 / 颜色 / 双语由浮窗的样式条自己说了算（PLAN 027）
  loadAppearance();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes || !(SETTINGS_KEY in changes)) return;
      // 官方设置是唯一真相：官方面板改一项、我们自己写回一项，都从这里回到浮窗
      applyOfficial(changes[SETTINGS_KEY].newValue);
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
