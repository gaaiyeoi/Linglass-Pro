# 050 复制字幕时剥掉振假名与文节分隔符

> 状态：**已完成**（`make test` / `make build` / `make check` 全绿；页面侧 shadow DOM 复制待人工确认）

## 需求

用户反馈：从字幕里复制一句话，粘出来变成
「色々いろいろなテーマについて」「自然しぜんなスピードでほんの」——
振假名（`<rt>`）被一起复制进去了。

期望：复制到的一句话只有原文：`色々なテーマについて`、`自然なスピードで`。

## 根因

官方的振假名是 `夜<rt>よる</rt>` 这样的 `<ruby>` 结构。浏览器对选区的默认复制
会把 `<rt>` 的文本按顺序拼进去，于是「夜」+「よる」=「夜よる」。

我们自己的读取路径（`10-subtitle-track.js` 的 `plainText()`，PLAN 010）早就剥掉了 rt，
但**剪贴板不经过我们的读取路径** —— 它是浏览器对选区 DOM 的默认序列化，
所以浮窗里渲染的 `<ruby>` 与页面里官方的 `<ruby>` 都会漏。

另外浮窗原文行里的文节分隔符（`.llg-sep` 节点）也会被复制进去，
粘出来是「色々|いろいろな|テーマについて」。同一个出口，一并处理。

## 做什么

- `00-shared.js` 新增复制清道夫 `installCopySanitizer(win)`：
  - 监听 `copy`，把选区的每个 range `cloneContents()` 后遍历，
    **跳过 `<rt>` 与 `.llg-sep` 节点**，拼出干净纯文本；
  - 只有选区里**确实含** rt / 分隔符时才接管（`preventDefault` + 写 `text/plain`），
    其余复制保持浏览器原生行为（换行、富文本粘贴都不变）；
  - 去掉分隔符两侧的窄空格（`\u2009`）。
- 在页面 document 上装一次（官方页面字幕里的 ruby 也会被剥）；
- `30-desktop-subtitles.js` 在 `buildWindow()` 里给浮窗自己的 document 也装一次
  （浮窗是另一个文档，页面上的监听器管不到它）。

## 不做什么

- 不改字幕渲染：浮窗仍然显示振假名（PLAN 017），只是不进剪贴板。
- 不改 `10-subtitle-track.js` / `15-ja-break.js` 的既有文本口径。
- 不接管不含 rt / 分隔符的普通复制（不重排换行、不删空行）。
- 不做「复制为 Markdown」之类的新入口（面板已有导出 / 复制 Markdown）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/00-shared.js
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/050-copy-without-furigana.md
  - README.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/cast-page.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. `00-shared.js`：`copyTextOf(node)`（递归、跳过 RT / `.llg-sep` / 文本节点取 `data`）、
   `hasCopyNoise(node)`、`selectionCopyText(win)`（多 range 用换行拼）、
   `installCopySanitizer(win)`（同一个 window 只装一次）。
2. 模块加载时对 `document` 调一次；`30-` 开窗时对 `pipWin.document` 调一次。
3. 冒烟测试：造一棵含 `<ruby><rt>` 与 `.llg-sep` 的选区桩件，触发 `copy`，
   断言 `clipboardData.setData('text/plain', …)` 收到的是干净原文；
   再断言不含注音的选区**不接管**这次复制。

## 验证方式

- [ ] `make test`（新增用例：复制时剥掉注音与分隔符；普通复制不接管）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：浮窗 / 页面字幕里各选一句 ⌘C，粘到文本编辑器里没有假名与 `|`

## 预期量级

4 个文件 / +120 −5 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里还躺着 PLAN 047 / 048 的改动）
- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 184
  # pass 184
  # fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js

  $ make check
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  新增用例：
  `复制：选区里的振假名与文节分隔符不会进入剪贴板`、
  `复制：不含注音 / 分隔符的选区不接管，保持浏览器原生行为`。

- 遗留 / 与预期不符之处：
  1. **页面侧（官方 shadow DOM 里的字幕）未在浏览器里验证**：清道夫装在 `document` 上，
     依赖 `document.getSelection()` 能拿到 shadow tree 内节点的 range。Chrome 通常可以，
     但如果某个版本返回的是宿主元素，这条路径会静默退回原生复制（仍然带假名）——
     届时需要在 15-ja-break 的宿主侧另找接入口，另立 PLAN。
  2. 只写了 `text/plain`，没写 `text/html`：粘进富文本编辑器时拿到的是纯文本。
     这是有意为之（保证假名一定不会漏），但会丢掉原页面的富文本格式。
  3. 分隔符节点是整块跳过的：像「色々|な」复制成「色々な」（日文不需要补空格）；
     如果以后分隔符改成带空格的形态，需要同时补空格逻辑。
  4. 复制 PiP 里的富渲染行（ruby）已在 Node 侧用同形状的节点树覆盖；
     真实 PiP 文档里的 `getSelection()` 行为未单独验证（与浮窗同一套 DOM 结构）。
