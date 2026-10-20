# 070 手机字幕屏：缓冲 / 卡顿状态进协议

> 状态：待执行

## 需求

Mac 上视频进入缓冲（YouTube 转圈、网络卡住、切集加载）时，手机屏的字幕会先往前跑、
画面恢复后又跳回来。期望缓冲期间手机屏**冻结**，与画面完全同步。

## 根因

快照里只有播放 / 暂停，没有「在播但画面没动」这一状态：

```246:246:src/mod/35-cast.js
      playing: !!(v && !v.paused && !v.ended),
```

手机端所有时钟都只看 `playing`：

- `frameClock.playing` 决定 `localAt()` 是否按时长推进（PLAN 069 的换句排程靠它）；
- `syncClocks()` 用它决定进度条与句内进度是否本地推进（PLAN 062）。

缓冲时 `paused === false`，于是手机端认为视频在正常前进，按本地时钟把字幕滚到下一句；
缓冲结束后扩展推来真实位置，字幕再滚回去 —— 表现就是「跳两下」。

## 做什么

- `src/mod/35-cast.js`：
  - 快照增加 `stalled`：`v.readyState < 3`（`HAVE_FUTURE_DATA` 以下就是放不动了）。
  - `frameKey()` 加入同一判据（取 0/1），否则「开始缓冲」这一拍会被去重掉，
    手机要等到下一句才收到状态。
- `tools/cast-page.mjs`：
  - `updateFrameClock()`：`playing` 同时要求 `!stalled`。
  - `syncClocks()`：`const playing = payload.playing !== false && payload.stalled !== true;`
  - 不改渲染、不改选句、不改排程逻辑本身。

## 不做什么

- 不做「缓冲提示」UI（手机上转圈图标是额外界面，本次只求同步）。
- 不改 `seek` / 拖动进度条的处理。
- 不改服务端。

## 修改范围

```yaml
allowed_paths:
  - src/mod/35-cast.js
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/070-cast-stalled-state.md

forbidden_paths:
  - vendor/**
  - dist/**
  - tools/cast-server.mjs
  - src/mod/10-subtitle-track.js
```

## 实现方案

1. `video()` 拿到的元素直接读 `readyState`（没有元素时按未缓冲处理为 `false`）。
2. 手机端统一走 `playing` 的派生值，`tickSwap()` / `planSwap()` 自然冻结：
   缓冲期间既不排程也不换句。
3. 缓冲结束时下一帧 `stalled=false`，时钟以新的 `timeline.position` 重新起算。

## 验证方式

- [ ] `make test`：新增断言（快照带布尔 `stalled`、页面时钟同时看 `playing` 与 `stalled`）。
- [ ] `make build` / `make check`。
- [ ] CDP：注入一帧 `stalled:true` 后，`#line-primary` 在 2 秒内不变、进度条停住。

## 预期量级

4 个文件，+30 / −8 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：未提交
- 验证结果：
  - `make test` 215 通过 / 0 失败（新增 2 条：快照带 `stalled`、页面两处时钟都看 `stalled`）。
  - `make build` / `make check` 通过。
  - `frameKey()` 里加了同一判据，缓冲开始/结束各会立刻推一拍。
- 遗留问题与差异：
  - 没有在真实 YouTube 缓冲场景下做 CDP 复现（本地探针不好稳定制造 `readyState < 3`），
    这条只由代码路径与断言保证。
  - 只覆盖「在播但放不动」；「已暂停且未缓冲」仍由 `playing` 表达，两者互不影响。
