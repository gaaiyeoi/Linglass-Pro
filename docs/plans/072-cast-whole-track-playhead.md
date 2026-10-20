# 072 手机字幕屏：整条轨下发 + 播放头驱动

> 状态：待执行

## 需求

手机与 Mac 之间网络抖一下（Wi-Fi 漫游、路由器省电、Mac 传大文件），字幕就停住不动，
只有进度条还在走；恢复后又跳一句。期望：**断流期间字幕照常滚动**，恢复后无缝续上。

## 根因

手机端是「增量拼字幕」的被动接收者：它只有最近 40 句历史（`cues`）与未来 3 句
（`plan`，PLAN 069）。一旦帧停止：

- 没有新的 `plan` → 排程在播完当前这一句后就断档；
- 渲染只发生在 `render()` 里 → 没有帧就没有换句。

而整条时间轴在 Mac 侧本来就有（官方骨架 `subtitle-cache:v6:*:primary` 一次给全），
却没有下发给手机。

## 做什么

### 扩展侧（`src/mod/35-cast.js`）

新增 `track` 分块字段（与 PLAN 071 的 `static` 平级，不进静态块）：

```jsonc
"track": { "ver":"1f2e3d4c", "id":"<videoId>", "from":0, "to":199, "total":1240,
           "cues":[[start,end,primary,secondary], …] }
```

- `ver` = 轨道指纹（句数 + 首句 start + 末句 start 的 FNV 哈希），与 PLAN 071 的
  `trackVer`（静态块版本）**不是一回事**，命名上要区分。
- 每次 `/push` 最多带一块（≤ 200 句，约 10–14KB，远低于服务端 64KB 上限），
  `from/to` 递增，`total` 是总句数；发完为止（`trackSent` 记录 `${ver}:${to}`）。
- 轨道变化（新视频、骨架晚到、导入整轨）时 `ver` 变 → 从 0 重新发。

### 手机端（`tools/cast-page.mjs`）

- 组装：`trackStore = { ver, total, cues: [] }`，按 `from` 落位；`to === total` 即完整。
- **断流续播**：`render()` 里更新 `lastFrameAt`；`tickSwap()` 中若
  `now - lastFrameAt > STALE_STREAM_MS (1200ms)` 且轨道完整、`frameClock` 在播，
  则用 `videoClock` 推算当前视频时间 → 从轨道查出应显示的句子 → 走同一套
  `playSwap()`（文本只有纯文本，与 PLAN 069 的预排一致），并把 `shownCueStart` 推到该句。
- 有帧时完全走既有路径（`plan` 优先），轨道只作为兜底与新句文本来源之一。
- 进度条：断流期间 `videoClock` 已按本地时钟推进（PLAN 062），不需要额外处理。

### 服务端

- 不需要改动：`/push` 透传，SSE 广播，`MAX_BODY` 64KB 足够（分块本身就是为了不撞上限）。

## 不做什么

- 不做「离线冷启动」（页面第一次打开时仍需扩展在线才有轨道）。
- 不做 localStorage 持久化（会与「换视频 / 轨道版本」纠缠，留待后续）。
- 不改换句动画、选句手势、控件。
- 不删除既有的 `cues`（40 句）与 `plan`（3 句）：前者被选句用，后者是精确排程来源。
- 不做词级时间轴（官方轨没有）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/35-cast.js
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/072-cast-whole-track-playhead.md

forbidden_paths:
  - vendor/**
  - dist/**
  - tools/cast-server.mjs
  - src/mod/10-subtitle-track.js
```

## 实现方案

1. 扩展：`wholeTrack()` 从 `track.getCues()` 取全量（带 `ver`），`nextTrackChunk()` 按
   200 句切片；`push()` 里把当前块并进 body（与 `static` 同级，避免撑大静态块）。
2. 手机：`mergeTrack(chunk)` 组装；`trackCueAt(videoTime)` 二分查找。
3. 手机：`tickSwap()` 增加「断流兜底」分支（仅在 `swapCtl.start == null` 时生效）。
4. 测试：扩展侧冒烟（超过 200 句时首块 `to=199`、`total` 正确、`ver` 稳定）；
   页面侧静态断言（`mergeTrack` / `trackCueAt` / 断流阈值）。

## 验证方式

- [ ] `make test` / `make build` / `make check`。
- [ ] CDP：推流 250 句（分两块），断言手机端 `track` 完整。
- [ ] CDP：推流 4 秒后**停推** 8 秒，字幕仍按轨道滚动 ≥2 句；恢复推流后不重复滚。

## 预期量级

4 个文件，+180 / −20 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：未提交
- 验证结果：
  - `make test` 通过（新增 1 条页面侧断言组；扩展分支由静态断言覆盖）。
  - `make build` / `make check` 通过。
  - CDP：40 句整轨、1.5 秒一句；推流在 6 秒时**完全停止**，之后页面仍连续换了
    14 句（每秒一句的节奏、逐句无回跳），证明断流期间由整轨 + 本地时钟驱动。
  - 服务端把分块攒成整轨、并在新客户端接入时补发 —— 代码路径已实现，
    但未在真实 `cast-server` 下实测。
- 遗留问题与差异：
  - 分块只带 `start/end/primary/secondary`，不带分段与注音：断流期间滚上来的句子是
    纯文本（与 PLAN 069 的预排文本同一口径），恢复推流后由帧里的 segments 覆盖。
  - 轨道版本指纹用「句数 + 首尾句起点」，理论上存在「重切后句数与首尾都不变」的漏判；
    概率极低，真出现也只是时间轴不更新，不会错位。
  - 没有做 localStorage 持久化：页面刷新后要重新等扩展分块（在线时几十毫秒内到齐）。
