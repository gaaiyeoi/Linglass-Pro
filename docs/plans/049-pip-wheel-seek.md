# 049 桌面字幕浮窗：滚轮上下滑动选句跳转

> 状态：**已完成**（`make test` / `make build` / `make check` 全绿；浏览器内手感待人工确认）

## 需求

用户反馈：手机字幕屏可以上下滑动挑句子并跳过去（PLAN 045），
桌面浮窗也应该能用滚轮 / 触控板上下滑动调整播放进度。

期望：在浮窗字幕区上滑 = 往更早的句子翻，下滑 = 往更晚的句子翻；
停手之后把播放位置跳到选中那一句的开头 —— 与手机端同一套语义。

## 做什么

- 浮窗里新增选句浮层 `#picker`（覆在字幕区上，`#picker-rows` 只画选中句 ±2 句，
  `#picker-time` 显示选中句的时间），样式沿用浮窗的液态玻璃令牌。
- 滚轮事件挂在浮窗自己的 document 上（只在自己造的那份 DOM 里，不碰页面）：
  - 累计 `deltaY`（line / page 单位先换算成像素），每 `PICK_ROW_PX` 像素移动一句；
  - 第一次滚轮从「当前句」起算，之后按基准句 + 位移取整，并夹在轨道首尾；
  - 停手 `PICK_COMMIT_MS` 毫秒后把 `video.currentTime` 设到选中句开头并关闭浮层。
- 设置页开着时（`barMode !== 'play'`）不接管滚轮 —— 那一页自己需要滚动。
- 刚跳完的一小段时间内再滚，从「刚跳到的那句」起算（此时轨道里的当前句可能还没跟上）。
- 关窗 / 打开设置页时撤掉浮层与挂起的计时器。

## 不做什么

- 不做横向滑动 / 拖动整片进度（已有 `#progress` 的点击拖动，PLAN 037）。
- 不改手机端的 `tools/cast-page.mjs`（它已经实现了同一套选句，只是手势来源不同）。
- 不改字幕文本、注音、外观档位与落盘结构。
- 不做「滚轮微调秒数」（那是 ±5s 按钮的语义，混在一起会让人分不清）。
- 不动 `10-subtitle-track.js` / `40-study-panel.js` / `50-settings-panel.js`。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/049-pip-wheel-seek.md
  - README.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/cast-page.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. 常量：`PICK_ROW_PX = 60`（滚轮位移换一句）、`PICK_COMMIT_MS = 300`（与手机端同值）、
   `PICK_ROWS_AROUND = 2`（浮层行数）。
2. `buildWindow()` 往 `#stage` 里追加 `#picker`（`#picker-rows` + `#picker-time`），
   并挂一个 `wheel` 监听（`{ passive: false }`）。
3. 选句状态与函数：`openPicker()` / `renderPicker()` / `commitPick()` / `closePicker()`，
   列表直接取 `track.getCues()`（完整轨道，比手机端的 40 句窗口更全）。
4. `stop()` 里清掉浮层与计时器；`setPanelMode()` 打开设置页时先 `closePicker()`。
5. 跳转用 `video.currentTime = cue.start`（不强制 play / pause，保持当前播放状态）。

## 验证方式

- [ ] `make test`（新增用例：滚轮上滑选到更早的句子并跳过去；夹在首尾；
      设置页里不接管滚轮）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：鼠标滚轮一格跳几句是否顺手、触控板惯性期间浮层是否跟着走、
      松手后是否真的从那一句开头播放

## 预期量级

3 个文件 / +150 −10 行

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
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js（注入自检无告警）

  $ make check
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  新增用例：
  `桌面字幕：滚轮上滑选到更早的句子，停手后跳过去`、
  `桌面字幕：滚轮选句夹在轨道首尾，跳完再从新句起算`、
  `桌面字幕：设置页里滚轮不接管选句`。

- 遗留 / 与预期不符之处：
  1. **浏览器内未验证**：60px/句 的手感、触控板惯性期间浮层跟随、松手 300ms 的实际观感
     都要在真实 Mac 上确认；三个数都在 30- 的常量区（`PICK_ROW_PX` / `PICK_COMMIT_MS` /
     `PICK_ROWS_AROUND`），改一处即可。
  2. 鼠标滚轮一格（约 100px）会跳 1–2 句；触控板轻扫更细。若觉得快，把 `PICK_ROW_PX`
     调大即可（与手机端 46px 不是同一个物理量）。
  3. 跳转用的是 `cue.start`，与手机端一致；`track` 的「当前句」要等下一次采样（≤1s）才更新，
     这期间的选中基准用 `PICK_ANCHOR_MS` 内的锚点兜住（已写进实现与用例）。
  4. `#picker` 的排版只在 Node 侧断言了节点/文本，视觉（玻璃底、五行高度）未在 PiP 里看过。
