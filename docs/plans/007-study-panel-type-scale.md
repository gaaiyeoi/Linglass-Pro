# 007 学习面板：排版尺度对齐官方 Linglass（字号偏小）

> 状态：**已实现，未提交**（`make test` / `make build` / `make check` 全绿；浏览器观感待人工确认）

## 需求

学习面板（页面内 Shadow DOM 侧栏）的字号偏小。要求「样式参考 Linglass」——
即按官方侧边栏自己的排版尺度来定，而不是我们自己拍一组数。

## 现状与依据（实测，非推测）

官方侧边栏产物 `vendor/linglass-1.12.3/assets/sidepanel-BiK3qJ0g.css`：

```css
body{font-family:Inter,system-ui,sans-serif;font-size:var(--text-base);line-height:1.5;
     -webkit-font-smoothing:antialiased}
:root{--text-xs:.75rem;--text-sm:.875rem;--text-base:1rem;--text-lg:1.125rem;--radius-sm:8px}
```

- **官方正文基座是 `1rem` = 16px**（`--text-base`），行高 1.5，开启字形平滑；
  组件级覆盖集中在 **13 / 13.5 / 14 / 15px**，元信息 11–12px，标题/主文本 15–15.5px（700）。
- 我们的 `PANEL_CSS` 基座是 `400 13px/1.5`，列表行 `13.5 / 12.5px`，元信息 `11px`，
  底栏按钮 `12px` —— 整体比官方低一档，这就是「感觉字号有点小」的来源。

## 做什么

只改 `40-study-panel.js` 里 `PANEL_CSS` 的字号 / 行高 / 字重 / 内边距，逐项对齐官方尺度：

| 元素 | 现在 | 目标 | 对齐依据 |
| --- | --- | --- | --- |
| `.panel` 基座 | `400 13px/1.5` system-ui | `400 15px/1.5` Inter 优先 + antialiased | 官方 body 16px/1.5 + Inter |
| `.title` | 13px | 15px | 官方 `.qup__title` 15px/700 |
| `.sub` | 11px | 12.5px | 官方元信息 12–12.5px |
| `.icon` | 17px | 18px | 官方 `.code-box--compact` 18px |
| `.kline-ja` | 16px | 18px | 官方 `--text-lg` = 18px |
| `.kline-zh` | 13px | 15px | 官方 `.tr-tx` 16px 一档 |
| `.stage-empty` / 空列表提示 | 12px | 13.5px | 官方行文本下限 13.5px |
| `.stamp` | 11px | 12px | 官方 caption 12px |
| `.ja` | 13.5px | 15px | 官方行文本 13.5–15px |
| `.zh` | 12.5px | 14px | 官方行文本 13.5–15px 一档 |
| `.foot button` | 12px | 13.5px | 官方 `.sm` 13.5px |
| `.toast` | 12px | 13px | − |
| 行内距 | `.row` 6px / `.kline` 6px / `.head` 10px / `.stage` 14px | 9px / 8px / 12px / 16px | 字号上去后需要同步的呼吸感 |
| 时间戳列宽 | `44px` | `48px` | 12px 等宽数字下 `1:00:00` 需要 ~46px |

- 字号只增不减，**不动**颜色、玻璃令牌、结构、交互、拖拽、导出。

## 不做什么

- **不引入官方的 Inter / Onest 字体文件**（`@font-face` + `chrome-extension://assets/inter-latin-*.woff2`）：
  字体文件名带内容哈希，`make vendor-update` 换版就变，会新增一条对官方产物的脆弱依赖；
  而 Inter 只覆盖拉丁字母，面板正文是日文+中文，实际观感差异极小（macOS 上 system-ui 即 SF Pro）。
  仅在字体栈里把 `Inter` 放在最前 —— 本机装了就生效，没装就自然回落到系统字体。
- 不改面板宽度（默认 400px）与 `WIDTH_MIN` / `WIDTH_MAX`
- 不改 `50-settings-panel.js`（那部分在官方 shadowRoot 里，本来就吃官方样式）
- 不改 `30-desktop-subtitles.js`（桌面字幕浮窗，另一套 `PIP_CSS`）
- 不改 `10-subtitle-track.js`、`00-shared.js`、`build.mjs`、`Makefile`

## 修改范围

```yaml
allowed_paths:
  - src/mod/40-study-panel.js
  - tools/test/smoke.test.mjs
  - docs/plans/007-study-panel-type-scale.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/00-shared.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
  - tools/test/contract.test.mjs
  - build.mjs
  - Makefile
```

> `contract.test.mjs` 不改：本轮没有新增对官方 DOM 的选择器，也没有新增对官方产物的依赖
> （不加载官方字体文件）。`PANEL_CSS` 里的选择器全部已在既有登记表里。

## 实现方案

1. 改 `.panel` 的 `font` 简写与加 `-webkit-font-smoothing: antialiased`。
2. 按上表逐条改字号；`.row` / `.kline` / `.head` / `.stage` / `.foot` 的内边距同步放大。
3. `.row` 的 `grid-template-columns: 44px 1fr` → `48px 1fr`。
4. 在 `smoke.test.mjs` 的「玻璃令牌」用例旁加一条**排版尺度回归测试**：
   解析 `PANEL_CSS`，断言基座字号、`.ja`、`.zh`、`.title`、`.foot button` 不低于本轮目标值，
   且不低于官方 13.5px 行文本下限 —— 防止以后被无声改小回去。
   （纯字符串解析，不需要 harness：与既有令牌用例同一手法。）

## 验证方式

- [ ] `make test`（新增用例名：「学习面板：排版尺度不低于官方下限」；既有
      「学习面板：玻璃令牌都有定义」必须仍绿）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed` 或直接看页面）：面板打开后正文字号明显变大、
      不溢出/不错位，浅色深色两套都正常

## 预期量级

3 个文件 / +50 −20 行（其中 `40-study-panel.js` 只动 `PANEL_CSS` 一段）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：（尚未提交 —— 工作区里还躺着 PLAN 004 的未提交改动，见下方「遗留」）
- 验证结果（贴实际输出）：

  ```text
  $ make test
  # tests 39
  # pass 39
  # fail 0
  ---
  ok 32 - 学习面板：玻璃令牌都有定义，且不引用拿不到的官方变量
  ok 33 - 学习面板：排版尺度不低于官方下限      ← 本轮新增

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-CtntZOE3.js
  [build] 注入      … mod/40-study-panel.js …
  [build] 版本      1.12.900

  $ make check
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  改动量：`src/mod/40-study-panel.js` +25 −25（只动 `PANEL_CSS`）、
  `tools/test/smoke.test.mjs` +62（本轮新增用例）、本 PLAN。
- 遗留 / 与预期不符之处：
  1. **浏览器观感未验证**：字号/内边距变大后，400px 默认宽度下日文长句换行行数会变多，
     深色浅色两套都只在 Node 侧做了字符串断言，**视觉与溢出没有实测过**。需人工看一眼。
  2. `tools/test/smoke.test.mjs` 的 `git diff` 里混着 PLAN 004 尚未提交的改动
     （本轮只加了那条排版用例，其余为既有未提交内容）。两个 PLAN 的改动要分提交。
  3. 没引入官方 Inter 字体文件（理由见「不做什么」）—— 若之后觉得还是不像，
     那是字体而非字号的问题，另立 PLAN。
