# 004 桌面字幕浮窗：加播放控制

> 状态：**待执行**

## 需求

桌面字幕（系统级画中画）现在只能「看」：暂停/播放、快进快退、倍速都得切回浏览器。
期望：在浮窗里就能调这些播放参数 —— 最小集合是播放/暂停、前后 5 秒、上一句/下一句、倍速。

## 做什么

- 浮窗底部加一条控制栏（只出现在浮窗里，不碰页面）：
  | 按钮 | 行为 |
  | --- | --- |
  | ⏯ | `video.paused ? play() : pause()` |
  | −5s / +5s | `currentTime` 加减 5 秒，夹到 `[0, duration]` |
  | 上一句 / 下一句 | 跳到 `10-subtitle-track.js` 相邻 cue 的 `start`；已在首/末句时不动 |
  | 倍速 | 循环 0.75 → 1 → 1.25 → 1.5 → 1.75 → 2 → 0.75
- 倍速与播放状态要**回显**：按钮文案/图标跟随实际状态刷新（监听 video 的 `play` / `pause` /
  `ratechange`，外加既有的 1s 心跳兜底 —— 换视频后 video 元素会被换掉，只靠事件会漏）。
- 浮窗默认高度从 220 提到 260，给控制栏留位置；`PIP_CSS` 里字幕区改为占满剩余空间。
- 控制逻辑抽成 `command(act)` 一个内部函数，并挂到测试钩子 `__llgModPip.command` 上，
  供 Node 侧冒烟测试直接驱动（不必模拟 DOM 点击）。
- 浮窗里的按钮点击用**委托**（监听 PiP 窗口 document 的 click），不为每个按钮各挂一个监听器。

## 不做什么

- 不做字幕样式设置（字号/颜色/背景），不做逐词高亮
- 不做 AB 复读 / 循环当前句 / 自动暂停（本轮不做，避免范围膨胀）
- 不加速率滑块（用循环按钮；浮窗里拖滑块体验差且要多一套样式）
- 不改 `40-study-panel.js`、`10-subtitle-track.js`、`00-shared.js`
- 不改浮窗既有语义（常驻、被 UA 关掉后自己回来、文节分隔符）
- 不引入新依赖

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/004-pip-playback-controls.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/40-study-panel.js
  - src/mod/00-shared.js
  - build.mjs
```

> `contract.test.mjs` 不改：本轮没有新增对官方 DOM 的选择器（`#movie_player video` 已在
> PLATFORM_CONTRACT 里登记），PiP 窗口里的 `#pip-play` 等 id 是我们自己造的，
> 写进字符串时用 `getElementById` 而非 `'#...'` 字面量（不触发漏登记检测）。

## 实现方案

1. `PIP_CSS` 加控制栏样式：`.bar` 一行按钮、`#box` 改 `justify-content: space-between`，
   字幕区（`#stage`）`flex: 1` 居中。
2. `buildWindow()` 里除两行 `.kline` 外再建一个 `.bar`：6 个 `button[data-act]`。
3. `command(act)`：
   - 取 `video()`（复用 40 里同样的取法，本文件已有 `currentVideo` 语义：`#movie_player video`
     → 兜底任意 `video`）；
   - `play` / `pause` / `seek`（delta）/ `prev` / `next` / `rate`；
   - prev / next 用 `track.getCues()` + 当前播放位置的索引（`track.getCurrent()` 的 `index`）。
4. `syncBar()`：把 `paused` 与 `playbackRate` 写进按钮（先比较再写，避免无谓 DOM 变更）；
   在 `buildWindow` 后、心跳里、以及 video 的 `play`/`pause`/`ratechange` 事件上调用。
5. 视频换掉（`currentVideo()` 变了）时重新挂事件监听。
6. `__llgModPip` 增加 `command` 与 `syncBar`、`RATES`，供测试与 probe 使用。

## 验证方式

- [ ] `make test`（新增回归/冒烟用例名：
      「桌面字幕：浮窗控制栏——暂停/播放/跳转/上下句/倍速」）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed`）：浮窗里点 ⏯ 视频真的暂停；倍速按钮生效；
      上一句/下一句跳到相邻句；主窗口最小化后按钮仍可用（浮窗是独立窗口）

## 预期量级

2 个文件 / +150 −15 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：
- 验证结果（贴实际输出）：
- 遗留 / 与预期不符之处：
