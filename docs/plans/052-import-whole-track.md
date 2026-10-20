# 052 长难句：允许用一份 SRT 直接替换整条轨道

> 状态：**已完成**（浏览器人工确认未做，见「完成情况」）

## 需求

播客类视频的 ASR 轨长难句多、滚动断句碎。用户希望：

1. 翻译按句做（内容侧，另交付 `.zh.srt`，不在本 PLAN 的代码范围）；
2. 显示侧长句可读（PiP 已在 PLAN 059 按宽度与日文禁则折行，面板本身自然换行）；
3. **可以把重新断句好的 SRT 当成整条新轨道导入**，不再受「只能按时间戳贴译文」的限制。

本 PLAN 只做第 3 件。

## 根因

`applyTranslations()` 只能把译文**贴到已有 cue 上**（PLAN 031 的 `planImport` 按 start 匹配，
一个 cue 只贴一次）。所以：

- 用户无法把「一句一条」的新断句引入轨道；
- 原轨的滚动重复（同一句跨 2~3 条 cue）无法消除，只能照它翻译。

## 做什么

- `src/mod/05-srt.js`：
  - 新增 `parseSrtBlocks(text)`：与 `parseSrt` 同一套解析，但每项多带 `lines`
    （正文按行保留，`text` 仍是拼成一行）；
  - `parseSrt` 改为 `parseSrtBlocks` 的投影，**输出结构不变**（既有测试不受影响）。
- `src/mod/10-subtitle-track.js`：
  - 新增 `replaceCues(list)`：用文件里的句数/时间轴**整体替换**轨道；
    每句 `{start, end, primary, secondary, origin:'imported'}`；
  - 替换后：清空当前活跃句、重建骨架状态、禁止骨架再覆盖（`skeleton.done = true`）、
    `meta.import = { at, wholeTrack: true }`、落盘（`flush()`）、`notify()`；
  - 空文件 / 全是坏块 → 不动原轨道，返回 `{ applied: 0 }`。
- `src/mod/40-study-panel.js`：
  - 文件选择器复用，但记住模式：`导入译文`（贴回）与 `导入整条轨道`（替换）；
  - 整条轨道模式用 `parseSrtBlocks`：**第一行当原文、其余行拼成译文**；
    只有一行时视为纯译文（原文列为空）；
  - 设置面板 `Linglass-Pro` 分组新增一行「导入整条轨道（按文件重新断句）」。
- `tools/test/srt.test.mjs`：`parseSrtBlocks` 保留行边界、`parseSrt` 结构不变。
- `tools/test/smoke.test.mjs`：`replaceCues` 替换句数/时间轴、写入 `origin='imported'`、
  空输入不动轨道。

## 不做什么

- 不改 `planImport` / `applyTranslations`（贴回语义保持原样）。
- 不自动判断「这份文件是不是重新断句过」：模式由用户点哪个入口决定，不猜。
- 不做显示侧的「只显示当前句」：PiP 已有按宽度折行；再按句隐藏会让跨句 cue 闪断，
  等真实观感反馈后另立 PLAN。
- 不碰官方 `subtitle-cache:*`；替换只写我们自己的 `llgTrack:*`。
- 单语 SRT 也能替换，但原文列会是空的（不自动从旧轨补，避免错配）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/05-srt.js
  - src/mod/10-subtitle-track.js
  - src/mod/40-study-panel.js
  - tools/test/srt.test.mjs
  - tools/test/smoke.test.mjs
  - README.md
  - docs/plans/052-import-whole-track.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/15-ja-break.js
  - src/mod/16-imported-subtitle.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
  - build.mjs
```

## 实现方案

1. `parseSrtBlocks`：把现有 `parseSrt` 的循环体原样搬过去，`out.push({ start, end, text, lines })`；
   `parseSrt` = `parseSrtBlocks(...).map(({start,end,text}) => ({start,end,text}))`。
2. `replaceCues`：规范化 start/end（非有限 end 用 `start + DEFAULT_CUE_SECONDS`）、
   丢弃空句、按 start 排序、套 `enforceCueLimit()`，然后按上面的重置清单收尾。
3. 面板：`let importMode = 'paste'`；`onImportSrt(mode)` 只设置模式并打开选择器；
   `readTranslations(file)` 按模式分流。
4. 测试与 README（新增一段「整条轨道导入」的用法与格式约定）。

## 验证方式

- [x] `make test`（新增 4 例全绿，共 195 例）
- [x] `make build` + `make check`
- [ ] 浏览器人工确认：用一份双语 SRT 走「导入整条轨道」→ 面板句数变成文件句数；
      刷新后仍在；画面译文行按新句显示

## 预期量级

6 个文件 / +180 −20 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区同时有 047 / 048 / 049 / 050 的改动）
- 验证结果（实际输出）：

  ```text
  $ node --test --test-name-pattern="整条轨" tools/test/srt.test.mjs tools/test/smoke.test.mjs
  ℹ tests 5   ℹ pass 5   ℹ fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      … mod/05-srt.js → mod/10-subtitle-track.js → …
  $ make check → 通过
  $ make test  → ℹ tests 195   ℹ pass 195   ℹ fail 0
  ```

- 遗留 / 与预期不符之处：
  1. **浏览器人工确认没做**：设置面板新行、文件选择、刷新后是否保留都未人眼过。
  2. 单语 SRT 走整条轨导入时原文列为空（`（无原文）`），这是刻意不猜；
     要保留原文请用双语文件（第一行原文、其余行译文）。
  3. 发现并堵住一个连带风险：整条轨替换后，官方骨架晚到会把用户的断句覆盖回去。
     已用 `manualTrack` 拦住 `maybeLoadSkeleton()` 与 `onStorageChanged`，
     并从落盘的 `meta.import.wholeTrack` 在刷新后还原；冒烟用例覆盖了这条。
  4. 显示侧的「只显示当前句」没做：PiP 已有按宽度 / 日文禁则折行（PLAN 059），
     再按句隐藏会让跨句 cue 闪断，等实际观感反馈再定。
