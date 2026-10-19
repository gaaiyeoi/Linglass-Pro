# 051 浮窗滚轮动效每句只播一次

> 状态：**已完成**（浏览器人工确认未做，见「完成情况」）

## 需求

用户实测：桌面字幕浮窗（PiP）里，**每一句**切换时整块字幕会上下位移抖动好几次（观感像滚轮动效被重复播放），之后才落到下一句。期望：一句只滚一次。

## 根因

`src/mod/30-desktop-subtitles.js::pushText()` 用**时间轴 index** 判断「换句了」：

```js
const index = track.getCurrent() ? track.getCurrent().index : -1;
if (lastCueIndex >= 0 && index >= 0 && index !== lastCueIndex) {
  roll(index > lastCueIndex ? 'up' : 'down');
}
lastCueIndex = index;
```

而 `10-subtitle-track.js::capture()` 用「整行文本」当 key：官方同一句若**分步上屏**
（原文先到 → 文本补全 → 译文后到），每一步的文本都不同，于是每步都会
`closeActive()` + `openCue()` 新建一条 `start` 几乎相同的 cue（`findDuplicate()`
要求文本完全相同才去重）。`index` 因此在一句之内连跳 2–3 格，`roll()` 被连调 2–3 次，
`#reel` 的 `llg-roll-up/down` 动画（`.26s`）逐次重放 —— 就是用户看到的「跳三次才切过去」。

证据链：

- `roll()` 只在 `index` 变化时调用，`#reel` 的 `data-roll` 一改就从头播一次动画；
- 有骨架（`officialCues`）时 `openCue()` 会 `matchOfficial()` 命中骨架句、不新建，
  所以这条路径只在**骨架尚未采用 / 官方没写缓存**的视频上出现 —— 与本机实测
  （PLAN 049：部分视频的 `:primary` 缓存缺失）相符；
- 主句文字本身是对的（`currentLines()` 实时读官方 Shadow DOM），所以现象是
  「文字没问题、位置在抖」。

## 做什么

- `pushText()` 的滚轮判据换成**屏幕上这句原文**：
  - 首帧（`lastShownPrimary === null`）不滚；
  - 只在 `lines.primary` 真的换成另一句时滚；
  - 新文本以旧文本开头（同一句渐进补全，如「あ」→「あい」）不算换句；
  - 译文后到、注音后到、上下文行变化、改设置都不滚（这些 key 变了但原文没换）；
  - 方向仍按 `index` 比较（`index >= lastCueIndex` → `up`），保留原来的语义。
- `stop()` 里重置 `lastShownPrimary`，新窗口第一句不滚（与原行为一致）。
- `tools/test/smoke.test.mjs`：把 `#reel.dataset` 换成计数 Proxy，断言
  「一句之内分步上屏只滚 1 次」「真换句仍滚第 2 次」。
- 既有用例「换句时给滚轮动效打方向标记」里，回退那一步补一次 `show()`：
  旧断言只改 `currentTime`、不改画面，是「时间轴后退但屏幕没换句」的不真实状态；
  新语义下动效跟画面走，真实播放里 YouTube 会同步重渲染字幕。

## 不做什么

- 不改字幕轨道的建句/去重策略（`10-subtitle-track.js` 不动）：半句入库是另一个问题，
  改它要重新评估导出与面板，另立 PLAN。
- 不改 `#stage` 的居中布局（长句折行时高度变化必然带来一次重排，那是正常换句）。
- 不改手机字幕屏（`35-cast.js` / `tools/cast-page.mjs`）：那边没有 `data-roll` 动效。
- 不改动画时长与位移距离。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/051-pip-roll-once-per-line.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/35-cast.js
  - tools/cast-page.mjs
  - src/mod/40-study-panel.js
```

## 验证方式

- [x] `make test`（新增 1 例；已用旧判据实测为红：`2 !== 1`）
- [x] `make build` + `make check`
- [ ] 浏览器人工确认：无骨架的视频上每句只滚一次（Node 测不到真实动画时序）

## 预期量级

2 个文件 / +70 −10 行（不含本 PLAN）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里同时有 PLAN 047–050 的改动，按「一个 PLAN 一个提交」先不合）
- 验证结果（实际输出）：

  ```text
  $ node --test --test-name-pattern="分步上屏只滚一次" tools/test/smoke.test.mjs
  ✔ 桌面字幕：一句之内分步上屏只滚一次（不重复播放滚轮动效）

  # 临时改回旧判据（index 变化）后同一条用例：
  ✖ AssertionError: 一句之内只滚一次 —— 2 !== 1

  $ node --test tools/test/*.test.mjs
  ℹ tests 192   ℹ pass 192   ℹ fail 0

  $ make build
  [build] 契约校验 ✓（无告警）；注入自检通过
  $ make check
  已注入 mod/00-shared.js, …, mod/30-desktop-subtitles.js, …, mod/50-settings-panel.js
  ```

- 遗留 / 与预期不符之处：
  1. **浏览器人工确认没做**：需要重载 `dist/`，在一条「官方整轨缓存缺失」的日语视频上看
     每句是否只滚一次。Node 侧只能数 `data-roll` 被打了几次，看不到真实 CSS 动画。
  2. **根因只堵了表现**：同一句的分步上屏仍会作为独立 cue 进入轨道（`10-subtitle-track.js`
     的去重只认文本完全一致），面板与导出里的「半句」还在。那需要另一个 PLAN（改采样合并
     策略，会影响到导出与骨架合并）。
  3. **近似前缀的换句会少滚一次**：真换句但新句恰好以旧句开头（「はい」→「はい、そうです」）
     会被当成同一句补全。取舍是「宁可少滚，也不重复滚」，已在代码注释里写明。
