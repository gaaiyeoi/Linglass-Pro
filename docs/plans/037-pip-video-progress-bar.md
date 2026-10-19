# 037 桌面字幕浮窗：加一条整片进度条

> 状态：**已完成**

## 需求

「浮窗加上进度条」。

## 理解与边界

浮窗里已有的进度只有**句内填充**（`.kfill` 铺在文字身后，PLAN 036 刚按用户偏好回退）。
这次要的是**整片进度**：视频播到哪了、能不能直接跳。两者不是一回事，都要保留：

- 句内填充：这一句读了多少（跟随句级时间轴插值）。
- 整片进度条：整个视频的位置（`currentTime / duration`），可点/可拖。

## 做什么

- 控制栏正上方加 `#progress > #progress-fill`：轨道 `rgba(255,255,255,.12)`、
  已播放白色 + 轻发光、3px → hover 5px、`999px` 圆角、hover 出现端点圆点。
- 点击 / 拖动（pointerdown + document 上的 pointermove/up）按 `getBoundingClientRect`
  算比例 → `seekToFraction()`；比例夹到 `[0,1]`。
- `duration` 不是有限正数（直播 / 元数据未加载）时 `seekToFraction()` 返回 `false`，不猜。
- `pushTimeline()` 在 PiP 自己的 rAF 与 `push()` 里调用，先比对百分比再写样式；
  同步更新 `aria-valuenow`。
- 打开设置页时与字幕区一起隐藏；回到字幕恢复。
- 对外暴露 `pushTimeline` / `seekToFraction` 供测试与 probe 使用。

## 不做什么

- 不做缓冲条（`buffered`）、不做时间码文本、不做章节标记。
- 不改句内填充与播放控制逻辑（`command()` / `seekCue()`）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - README.md
  - docs/plans/037-pip-video-progress-bar.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/15-ja-break.js
  - src/mod/50-settings-panel.js
```

## 验证方式

- [x] `node --test tools/test/smoke.test.mjs`
- [x] `node --test tools/test/contract.test.mjs`
- [x] `make build` / `make check`
- [ ] 浏览器人工：拖动跟手、hover 变粗、设置页里不出现

## 预期量级

2 个文件 / +110 −5 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 验证结果：smoke 104/104、contract 3/3、`make build` 与 `make check` 通过。
- 未验证：真实指针拖动（测试桩没有 PointerEvent，单测走 `seekToFraction()` 直入口）。
