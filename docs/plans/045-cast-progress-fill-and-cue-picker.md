# 045 手机字幕屏：进度条填充修复 + 上下滑动选句跳转

> 状态：**已完成**

## 需求

1. 底部整片进度条**有轨道但永远没有填充**（PLAN 044 之后轨道已经可见了）。
2. 手机端可以上下滑动，精确挑到之前某一句并跳转播放。

## 根因（进度条，Bug Fix 必填）

`<i id="progress-fill">` 是**行内元素**（`<i>` 默认 `display: inline`），而 CSS 只给了
`width: 100%; height: 100%; transform: scaleX(0)`：

- `width` / `height` 对非替换行内元素**不生效** → 元素尺寸为 0，背景看不到；
- `transform` 同样不作用于行内元素 → `paintProgress()` 每帧写入的 `scaleX`
  一直在改一个**不产生任何渲染效果**的属性。

对照组：`.kfill` 也是 `<i>`，但它有 `position: absolute`，绝对定位会把它块级化，
所以句内进度一直正常 —— 这也解释了为什么「底部条完全没有、句内条有」。

结论：从 PLAN 038 起，底部进度条**从未真正显示过**，不是「太细」的问题
（PLAN 044 的加粗只让空轨道可见了）。

## 做什么

- `tools/cast-page.mjs`
  - `#progress-fill` 补 `display: block`，并把填充改成 `position: absolute; inset: 0`
    （脱离行内布局，尺寸与 `transform` 都稳定）。
  - 新增选句浮层 `#picker`：上滑打开，显示「选中句 ±2 句」，中间那行高亮；
    继续上下滑动按 46px/句移动选中项；松手后 300ms 发 `seek` 跳到该句开头并关闭。
  - 选句列表优先用快照里的 `cues`（当前句往前 40 句），没有时退回手机本地累积的历史。
- `src/mod/35-cast.js`
  - 快照新增 `cues: [[start, primary], …]`（当前句及之前 40 句）。
  - `applyControls()` 支持 `seek`：`v.currentTime = value`（夹到 `[0, duration]`）。
- `tools/cast-control.mjs`
  - `CONTROL_ACTIONS` 增加 `seek`；值夹到 `0–86400` 秒。
- 测试
  - `tools/test/cast-control.test.mjs`：`seek` 放行 / 负数夹到 0 / 超大夹到上限；
  - `tools/test/cast-page.test.mjs`：`#progress-fill` 是块级、页面含 `#picker` 与 `seek` 发送。

## 不做什么

- 不做横向滑动（拖动整片进度）—— 仍是 PLAN 042「不做什么」里的条目。
- 不做服务端存整条轨道：`cues` 只随快照走，手机不额外请求。
- 不改 `syncClocks()` / `paintProgress()` 的插值算法。
- 不改外观预设、字号、颜色、设置面板。
- 不动 `vendor/`、`dist/`、`Makefile`、`tools/probe.mjs`。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-page.mjs
  - tools/cast-control.mjs
  - tools/test/cast-page.test.mjs
  - tools/test/cast-control.test.mjs
  - src/mod/35-cast.js
  - docs/plans/045-cast-progress-fill-and-cue-picker.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/cast-server.mjs
  - build.mjs
  - Makefile
```

## 验证方式

- [ ] `make test`
- [ ] `make build` + `make check`（`35-cast.js` 在注入列表里）
- [ ] 真机（未做就如实写）：底部白条随播放推进；上滑浮层选句，松手后 Mac 播放器跳到该句

## 预期量级

6 个文件 / +230 −20 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（手机字幕屏整条线仍在工作区）。
- 验证结果（实际输出）：

  ```text
  $ node --test tools/test/*.test.mjs
  ℹ tests 192   ℹ pass 192   ℹ fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 版本      1.12.900

  $ make check
  版本    1.12.900
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  页面内联脚本单独抽出来 `node --check` 通过；`src/mod/35-cast.js` 同样通过。

  重启 8899 后真页面抓取：`#progress-fill { display: block; position: absolute; inset: 0 }`，
  `id="picker"` 与 `sendControl('seek'` 各出现 1 次。

- 遗留 / 与预期不符之处：
  1. **真机未验证**：滑动手感（46px/句）、浮层遮挡、iOS `touchmove` 的 `preventDefault`
     实际是否压住页面回弹，都需要 iPhone 确认。
  2. **扩展必须重载**：`cues` 与 `seek` 在 `src/mod/35-cast.js`，构建后要在
     `arc://extensions` 点一次刷新；否则手机端只能用本地历史兜底，`seek` 命令无人执行。
  3. 手机端本地历史只覆盖「本次连接之后看过的句子」（最多 200 句）；要翻更早的必须靠
     扩展推来的 `cues` 窗口（40 句）。
  4. 选句浮层只显示选中句 ±2 行，没有时间轴刻度与拖拽；一次手势定一句，松手即跳。
