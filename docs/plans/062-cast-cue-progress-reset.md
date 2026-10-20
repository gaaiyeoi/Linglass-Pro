# 062 手机字幕屏：句内进度在换句前被拽回句首

> 状态：执行中

## 需求

手机字幕屏上「文字背后那条逐字填充的句内进度」每句都走不满：走到一半左右先回到 0 再重走一段，
紧接着画面换到下一句。1× 播放，未调倍速。

## 根因

### 现象与观察

- 只有句内进度（`.kfill`）有问题；底部整片进度条（`#progress-fill`）看着正常。
- 1× 播放时本地时钟与推送值同速，`syncClocks()` 的漂移重设（阈值 0.5s）不会周期性触发，
  所以回退只可能来自**推送值本身变小**。

### 定位过程

1. 手机端的句内时钟完全由一帧快照的两个字段驱动（`tools/cast-page.mjs`）：
   - 显示文本：`payload.cur` ← `__llgModPip.castLines()` ← **画面上的 DOM 字幕**；
   - 句范围：`payload.cue` 与 `payload.progress` ← `__llgModTrack.getCurrent()` / `getProgress()`
     ← **时间轴（`currentTime` 二分）**。
2. 换句那一拍这两个来源必然错开：画面已经渲染下一句，时间轴还停在上一句（或反之）。
3. `getProgress()` 在「画面文本 ≠ 时间轴句文本」时按设计返回 `0`（PLAN 009：
   「宁可空着也不画假的满格」），本意是让浮窗/面板的进度条**空着**。
4. 手机端把 `progress` 当成绝对基准：`syncClocks()` 在漂移时执行
   `baseProgress = progress`（`tools/cast-page.mjs` 的 cue 分支）。于是换句窗口里收到
   `progress = 0`，正在走的句内进度被拽回 0，再按本地时钟重新走一段，直到文本切到新句。
   这正好是「没走完 → 回到起点重走 → 下一句」，并且**每句**都会发生。

### 证据

- `src/mod/10-subtitle-track.js:1106-1118`：`getProgress()` 在 `onTimeline()` 失配时 `return 0`，
  同一个 `0` 既表示「这句刚开头」也表示「现在不可信」。
- `tools/cast-page.mjs:844-890`：`syncClocks()` 的 cue 分支里 `baseProgress: progress`
  （漂移重设），没有区分「0」与「不可信」。
- `src/mod/35-cast.js:190-193`：`cue` 来自 `getCurrent()`（时间轴），`cur` 来自
  `castLines()`（画面），两个来源在换句窗口本来就不同步。

## 做什么

- `src/mod/10-subtitle-track.js`
  - 抽出内部 `progressValue()`：不可信时返回 `null`；
  - `getProgress()` 保持原语义（`null → 0`），新增导出 `getProgressOrNull`。
- `src/mod/35-cast.js`
  - 快照的 `progress` 用 `getProgressOrNull()`（旧 track 没有该入口时退回原值）；
  - `frameKey()` 把 `null` 与 `0` 分开编码，避免换句那一拍被去重掉。
- `tools/cast-page.mjs`
  - `cueClock` 增加 `text`：**换句只认画面文本**（`payload.cur.primary`），不跟时间轴；
  - `progress == null` 时不重设基准，保持本地推进；
  - 时间轴句（`payload.cue.start`）与当前句对不上时，整帧不碰时钟；
  - 有可信进度时只接受**前进方向**的校正（回退一律忽略），消除回跳。
- 测试
  - `tools/test/smoke.test.mjs`：`getProgressOrNull()` 在画面与时间轴不一致时为 `null`，
    `getProgress()` 仍为 `0`；一致时返回数字。
  - `tools/test/cast-page.test.mjs`：钉住「换句依据是文本」「缺失进度不重设基准」两条静态口径。

## 不做什么

- 不改底部整片进度条（`videoClock`）：它由 `timeline` 驱动，与本次现象无关。
- 不改 `getProgress()` 的旧返回语义（浮窗、侧边面板依赖它）。
- 不改推送频率、`paintProgress()` 的 rAF 结构、外观/字号/设置面板。
- 不做「横向拖动整片进度」（仍属 PLAN 042 的「不做什么」）。
- 不动 `vendor/`、`dist/`、`tools/cast-server.mjs`、`tools/cast-control.mjs`。

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - src/mod/35-cast.js
  - tools/cast-page.mjs
  - tools/test/smoke.test.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/062-cast-cue-progress-reset.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/cast-server.mjs
  - tools/cast-control.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. `10-subtitle-track.js`：`progressValue()` 返回 `number | null`；`getProgress()` 包一层
   `value == null ? 0 : value`；API 增加 `getProgressOrNull`。
2. `35-cast.js`：`snapshot()` 的 `progress` 改走新入口；`frameKey()` 用 `'n'` 表示缺失。
3. `cast-page.mjs` 的 `syncClocks()` 按以下优先级处理 cue 分支：
   1. 没有句时长 → `active = false`；
   2. 首次 / 画面文本变化 → 新句时钟，`baseProgress = 0`（不用 `progress`）；
   3. `payload.cue.start` 与当前句不同 → 本帧忽略（时间轴跑到了别的句子）；
   4. 句长变化（活跃句 `end` 被推长）→ 保持已走比例；
   5. 播放/暂停切换 → 用当前估值定基准；
   6. 进度可信且比本地快 0.5s 以上 → 采纳；明显回退 → 忽略。
4. 测试按上表补两条 / 三条断言。

## 验证方式

- [ ] `make test`
- [ ] `make build` 与 `make check`
- [ ] 真机确认（未做就如实写）：1× 连续播放 3 句以上，句内进度走到接近满格再换句，不再回跳
- [ ] 重启 `make cast` 后手机刷新（页面由服务端现渲染）

## 预期量级

5 个文件 / +120 −25 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（本轮改动仍在工作区）
- 验证结果：

  ```text
  $ node --check src/mod/10-subtitle-track.js && node --check src/mod/35-cast.js
  （无输出）

  $ make test
  ℹ tests 197   ℹ pass 197   ℹ fail 0

  $ make build
  [build] 契约校验  通过  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 版本      1.12.901

  $ make check
  版本    1.12.901
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  `renderPage('demo', null)` 的输出里 `cueClock.text`、`const rawProgress = payload.progress`、
  `if (progress == null) return` 各出现 1 次。

- 遗留问题与差异：
  1. **真机未验证**：1× 连续播放 3 句以上的实际观感仍需 iPhone 确认。
  2. **需要重启与服务端 + 重载扩展**：`make cast` 进程里跑着旧版 `cast-page.mjs`，不重启手机仍会拿到旧页面；
     `10-subtitle-track.js` / `35-cast.js` 属内容脚本，构建后要在 `arc://extensions` 刷新一次。
  3. 相邻两句原文完全相同时（「はい」连发），画面文本不变 → 句内进度不会重置，会跨这两句连续走完。
     这是「换句只认文本」的已知代价；发生频率极低，若真机上遇到再改成「文本 + cue.start 双键」。
