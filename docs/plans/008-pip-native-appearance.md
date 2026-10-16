# 008 桌面字幕浮窗：外观照搬官方（字号固定、跟随换色/样式/双语）

> 状态：**已实现，未提交**（`make test` / `make build` / `make check` 全绿；浏览器视觉待人工确认）

## 需求

1. 浮窗里原文行的**文节分隔符不明显**，样式要直接照搬 Linglass 原生（视频内那套）的排版。
2. 浮窗能不能像原生 Linglass 一样**换色**。
3. **字幕大小不许变**：设置成多少就是多少（现在拉大浮窗字就变大）。

## 根因

### 1. 字号跟浮窗尺寸绑死了

`30-desktop-subtitles.js` 的 `PIP_CSS` 里：

```
#line-primary   { font-size: clamp(20px, 3.2vw, 44px); }
#line-secondary { font-size: clamp(14px, 2.1vw, 29px); }
```

`3.2vw` = 浮窗宽度的 3.2%：窗口一拉大（默认 1000×264，用户随时可以拉），字号立刻跟着变；
它跟官方外观页里的「字号」档位（`subtitleScale`）也**毫无关系** —— 用户在原生面板里
调到 150%，浮窗一点反应都没有。所以「设置是多少就是多少」两件事都不成立。

### 2. 颜色/字体/底板是我们自己拍的，不是官方的

同一段 CSS 里写死了 `color: #fff` / `#c8c8d0`、
`font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", …`、
`text-shadow: 0 2px 10px …`。官方那套（`vendor/linglass-1.12.3/assets/`）：

| 项 | 官方出处 | 值 |
|---|---|---|
| 字体栈 | `settings-*.js` 的 `f.classic.font` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| 字号 | `settings-*.js` 的 `Se()`（`P=.0333, U=24, y=11, D.FONT_SIZE_RATIO=27/24, x.SECONDARY_RATIO=20/24`） | 基座 `max(11, max(playerH*.0333, 24) * scale/100)`；原文（CJK）基座 ×27/24、译文 ×20/24 |
| 颜色 | `settings-*.js` 的 `pe.subtitleColor` + 色板 `he` | `#FFFFFF` / `#FFD60A` / `#64D2FF` / `#30D158` |
| 译文行 | `promoCards-*.js` 的 `adjustColorOpacity(color, styleSpec.secondaryAlpha)` | classic 同色 ×0.75，其余 ×1 |
| 样式预设 | `settings-*.js` 的 `f`（`classic`/`cinema`/`comic`/`contrast`） | 字重、字距、底板（`plate`）、`plateOpacity`、`outlineEm`、`shadow` |
| 文字描边/阴影 | `settings-*.js` 的 `re()`（`R()` + 8 向描边环 + `paint-order`） | 按 preset 与基座字号推导 |
| 底板底色 | 各 `index.ts-*.js` / `reviewPrompt-*.js` 的 `primaryBgColor` 默认 | `#000000` |
| 双语开关 | `pe.dualSubtitles` | `true` |
| 落盘 | `settings-*.js` 的 `ps()` | `chrome.storage.sync['linglass-settings']`，`{version:4, state:{…}}` 或 JSON 字符串 |

### 3. 分隔符的排版与视频内不一致

`displayPrimary()` 拼的是 `\u2009|\u2009` 纯文本，直接 `textContent` 写进去，于是分隔符
**继承原文行的字重（CJK 下 600/700）与满不透明度**，看起来像正文里的一个竖线；
而视频内那套（`15-ja-break.js` 的 `MARK_CSS`）是
`margin: 0 .14em; opacity: .42; font-weight: 400` —— 半透明、细、带固定间距。
浮窗又是纯文本，没法只压分隔符的样式，所以只能改成节点渲染。

## 做什么

- **读官方外观设置**（新增一小节，纯函数 + 异步读）：
  - `chrome.storage.sync.get('linglass-settings')`，兼容「对象」与「JSON 字符串」两种形态；
  - 只取浮窗用得上的：`subtitleStyle` / `subtitleScale` / `subtitleColor` / `dualSubtitles`
    / `learningLanguage` / `nativeLanguage`；缺键或读失败 → 退回官方默认
    （`classic` / `100` / `#FFFFFF` / 双语开）；
  - 监听 `chrome.storage.onChanged`（`area === 'sync'` 且含该键）→ 立刻重画样式。
- **按官方规则生成浮窗 CSS**（照搬，不是重设计）：
  - 字号**固定 px**：`base = max(11, 24 * scale/100)`，原文行 `base × 27/24`（学习语言是
    CJK 时）、否则 `base`；译文行 `base × 20/24`；字重 CJK 时 `min(700, primaryWeight+100)`；
  - 颜色：原文行 = `subtitleColor`，译文行 = 同色 × `secondaryAlpha`；
  - 样式预设：`classic` 整块底板（黑 `plateOpacity` 梯度 + 8px 模糊 + 圆角/内边距按
    `metricScale = base/24` 缩放）、`contrast` 逐行底板、`cinema`/`comic` 无底板 + 描边环；
  - 阴影/描边按 `re()`：`plate` → `0 2px 8px rgba(0,0,0,.8)`（100% 档），
    `depth`/`offset`/`none` 三种，`outlineEm > 0` 时优先 `paint-order: stroke fill`，
    浏览器不支持才铺 8 向描边环；
  - **删掉 `clamp(...vw...)`**：字号只由档位决定，浮窗拉大拉小、播放器进全屏都不动。
- **双语开关**：`dualSubtitles === false` 时不渲染译文行。
- **分隔符改成节点渲染**：
  - `primaryParts(text)` 返回 `[{ text, sep }]`；分隔符渲染成 `<span class="llg-sep">`
    并给它原生那套 `margin: 0 .14em; opacity: .42; font-weight: 400`；
  - 保留 `displayPrimary(text)`（拼成带窄空格的可读字符串）供既有测试与探针用 ——
    它只是「人读得懂的拼接结果」，渲染不走它（间距交给 CSS margin，与原生一致）；
  - 去重键带上分隔符开关状态与双语开关，中途改设置/改断句会重绘。

## 不做什么

- 不碰官方产物（`vendor/**` 一字节不改），也不改官方的设置面板结构：颜色/字号仍然只在
  原生「外观」页里改，浮窗只是**跟随**。
- 不支持「官方没有」的外观项：不给浮窗单独做字号滑块、不给浮窗调色板（用户原话是
  「和原生的 linglass 一样能换色」，那就在原生面板里换）。
- 不做垂直位置（`subtitleVerticalOffset`）：浮窗是系统窗口，没有「离播放器底部多远」。
- 不改学习面板（`40-study-panel.js`）的外观：本轮只对齐浮窗。
- 不改 `15-ja-break.js` / `05-ja-segment.js`（视频内断句已上线且是对的，浮窗复用其结果）。
- 不新增依赖、不动 `build.mjs` / `Makefile` / `tools/probe.mjs`。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - tools/test/contract.test.mjs
  - docs/plans/008-pip-native-appearance.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/05-ja-segment.js
  - src/mod/40-study-panel.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

## 实现方案

1. `30-desktop-subtitles.js` 新增「原生外观」小节（放在文案渲染之前）：
   - 常量：`SETTINGS_KEY`、`DEFAULT_APPEARANCE`、`STYLE_SPECS`（四套 preset 照抄官方字段名）、
     字体栈与 `COMIC_LANGS` / `CJK_LANGS` 两个集合、基座系数（`U=24`、`y=11`、
     `27/24`、`20/24`、`PAD_Y/PAD_X/RADIUS`、line 底板的 `.14/.42/.16/.14`）；
   - 纯函数：`parseSettings()`、`fontSizeOf()`、`fontStackOf()`、`textEdgeOf()`、
     `plateCss()`、`hexToRgba()`、`colorWithAlpha()`、`pipCss(appearance)`；
   - `loadAppearance()` + `chrome.storage.onChanged` 订阅 → `applyAppearance()`；
   - `buildWindow()` 里把 `<style>` 存进 `styleEl`，样式内容改为 `pipCss(appearance)`。
2. 文案渲染：新增 `primaryParts()` / `renderSegments()`；`pushText()` 改用它们，
   译文行受 `dualSubtitles` 控制。
3. `PIP_CSS` 拆成「与外观无关的结构 + 控制栏」与「由 `pipCss()` 生成的外观」两部分。
4. 测试：
   - `smoke.test.mjs`：假 `chrome.storage.sync`（含 `onChanged` 派发）、
     假 PiP 元素支持 `replaceChildren`、`h.pipText()` 按子节点拼回文本、
     新增 `h.pipSegments()` / `h.pipCss()`；
   - 新用例：字号跟档位走且与浮窗尺寸无关（CSS 里不再出现 `vw`/`clamp`）、
     颜色跟随 `subtitleColor`、预设切换（无底板 / 逐行底板）、双语关掉不渲染译文行、
     分隔符渲染成 `llg-sep` 节点、设置变更后即时重绘；
   - 既有用例「原文行真的带上了分隔符」的断言改为**按片段**断言（原断言钉的是
     「窄空格拼串」这个实现细节；新断言钉的是分隔符节点与文本，更贴近需求）。
5. `contract.test.mjs`：登记本轮新增的官方记号（`linglass-settings`、`subtitleStyle`、
   `subtitleScale`、`subtitleColor`、`dualSubtitles`、`learningLanguage`、`nativeLanguage`、
   `secondaryAlpha`）。

## 验证方式

- [ ] `make test`（新增：字号固定、颜色跟随、预设、双语、分隔符节点、设置热更新）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed`，看 `PIP_PROBE` 的 `primary`；
      或肉眼）：原生面板把字号调到 150% / 换成黄色 / 换成 cinema 样式 / 关掉双语后，
      浮窗**立即**跟着变；拉动浮窗大小，字号不动

## 预期量级

4 个文件 / +260 −60 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交** —— 工作区里还躺着 PLAN 004 / 005 / 006 / 007 的未提交改动，
  按「一个 PLAN = 一个提交」本轮不应把它们裹进来（需要人先决定怎么收尾那几个 PLAN）。
- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 45   # pass 45   # fail 0
  $ make build
  [build] 契约校验  ✓
  [build] 版本      1.12.900
  $ make check
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  新增用例：
  `桌面字幕：字号来自官方档位，且不随浮窗尺寸变`、
  `桌面字幕：颜色、样式预设、双语都跟着官方外观走`、
  `桌面字幕：分隔符是独立节点，观感与视频内那套一致`。

  手写脚本（临时放 `/tmp`，未进仓库）把四套预设各生成一份样式表核对，与官方基线一致：

  ```text
  classic  100% #FFFFFF ja → 原文 27px/600，译文 20px/400 rgba(...,.75)，
                            #plate padding 8px 16px / radius 8px /
                            黑色梯度 .6→.8 + blur(8px)
  cinema   150% #FFD60A ja → 原文 40.5px/700，字距 .004em，无底板，
                            text-shadow 0 1.4px 4.7px + 描边 2px（stroke fill）
  comic    100% #64D2FF ja → 日语字面走 Hiragino Maru Gothic 栈，描边 2px
  contrast 100% #30D158 ja → 逐行底板 .kline padding 3.4px 10.1px / radius 3.8px /
                            rgba(0,0,0,.88) / 行距 3.4px
  ```

- 遗留 / 与预期不符之处：
  1. **字号与官方有一处刻意的偏差**：官方 `base = max(11, max(playerHeight*.0333, 24)
     * scale/100)`，会跟着播放器尺寸变大（剧场/全屏）；浮窗固定用基座 24px 乘档位。
     理由写在代码注释里：浮窗没有「播放器尺寸」概念，而用户要的是「设置是多少就是多少」。
     副作用：浮窗里的字号与**视频内**的字号在全屏时会不一致（那边更大）。
  2. **分隔符按文内那套照抄，所以是半透明的**（`opacity: .42; font-weight: 400`）。
     如果用户要的是「更醒目」而不是「和视频内一致」，改 `pipCss()` 里那一行即可
     （提到 1，或换更粗的字形）—— 这是本轮唯一没把握的判断点，已在对话里说明。
  3. **底板颜色固定黑**：官方 `primaryBgColor` 的默认值就是 `#000000`，外观页能让用户
     换的是**文字**颜色（4 档色板）。浮窗照搬这条，没有额外给底板配色。
  4. 官方还有 `subtitleVerticalOffset`（拖动改字幕高度），浮窗不做 —— 它是系统窗口，
     没有「离播放器底部多远」这个概念。
  5. 双语开关是「跟着官方走」：官方关掉双语时浮窗也不显示译文行。如果用户只是不想在
     视频里看双语、却想在浮窗看，那是一条新需求（另立 PLAN）。
  6. **大字号可能顶到控制栏**：150% 时两行合计约 100px，默认 264px 高的浮窗放得下；
     再叠上长句换行就可能被裁（`#stage` 是 flex + overflow 默认 visible，实际表现为
     内容压住控制栏）。本轮不做自适应，等实测到问题再说。
  7. **浏览器视觉未验证**：`make probe --headed`（看 `PIP_PROBE` 的 `primary`）或肉眼
     确认「原生面板改字号/颜色/样式/双语 → 浮窗立即跟着变」「拉动浮窗大小 → 字号不动」。
  8. 量级与预期对不上：PLAN 写「4 个文件 / +260 −60」，实际 `30-desktop-subtitles.js`
     净增约 450 行 —— 因为替换整段写死的 `PIP_CSS`（−30）之外，四套预设 + 描边/底板生成
     + 设置读取占了大部分。没有超出业务范围，只是估算偏乐观。
  9. `tools/test/smoke.test.mjs` 的桩件加了三样东西：`chrome.storage.sync` 与
     `onChanged` 派发、假元素的 `replaceChildren`、以及 `CSS.supports` 桩
     （Chrome 支持 `paint-order`，桩成 true 才与真实浏览器一致）。
