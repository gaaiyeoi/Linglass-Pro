# 014 骨架必须真的读到：重试挂在心跳上、空结果不落账、索引没有就自己列

> 状态：**已实现，未提交**（`make test` / `make build` / `make check` 全绿；浏览器内行为待人工确认）
>
> ⚠️ 本文档是**补齐**：第 1～3 条改动在本轮之前就已经躺进工作区（`smoke.test.mjs` 里
> 有引用「PLAN 014」的注释与断言），但 `docs/plans/014-*.md` 当时没落盘 —— 违反 AGENTS.md
> §1。本轮把文档补上，并接着修第 4 条（那条没有做完，见「根因」）。

## 需求

用户反馈（PLAN 009 之后**仍然**出现）：「进度条没过完，人物就说下一句话了」「这个进度条
感觉不是非常准」。

## 根因

### 0. 进度条的分母从哪来（这是全部症状的落点）

`10-subtitle-track.js` 的 `progressEnd()`：**有下一句就用下一句的 `start`**，没有下一句
（= 当前句是轨道里最后一句）才退化成 `cue.start + estimatedSeconds()`，即**全片时长的中位数**
（首句无样本时 6s）。

而「正在播的那一句」在**没有骨架**时**永远是数组最后一句**（采样是边播边往后append的），
于是分母恒为中位数 —— 一个与当前这句真实长短无关的常数。

本机实测（`~/Library/.../Local Extension Settings/<Linglass id>`，2026-10-16 20:18，
用户当时正在看的那条视频 `SjSpIBe5Ktw`，`llgTrack:SjSpIBe5Ktw` 落盘值）：
**96 句、时间戳全是采样值（`475.262836` 这种浮点尾巴，官方缓存是 `4.08` 这种两位小数），
一句译文都没有来自骨架** —— 也就是**骨架没被采用**。它的真实句长分布是
`5.42 / 5.40 / 3.97 / 1.27 …` 秒：中位数约 4s，最短句只有 1.3s。

→ 1.3s 的那句，进度条只走到 **1.3 / 4 ≈ 32%** 就换行了；5.4s 的那句则在 4s 就顶满、
然后干等着换行。这正是「没过完就换句」+「不是非常准」。
**只要骨架能读到，分母就是下一句的真实起点（官方切行也是按 `start`/`end` 判的），
这两个症状一起消失。**

### 1. 重试次数被逐词高亮刷爆（真正的 bug，已修）

`maybeLoadSkeleton()` 原来挂在 `capture()` 上，而 `capture()` 是 Shadow DOM 的
MutationObserver 回调（`characterData` + `attributes` 全开）——**逐词高亮一秒触发好几次**
（模块自己的注释就是这么写的）。`skeleton.tries` 按「调用次数」计，于是
`SKELETON_MAX_TRIES = 4` 会在**不到一秒**内烧完并置 `done = true`：
官方字幕缓存是「取完整条轨再写」（网络往返 + 处理）后才出现的，我们必定先放弃 ——
**骨架只在「重看已经缓存过的视频」时才读得到**。

### 2. 空索引结果被落账（已修）

`if (!keys.length) { skeleton.keys = keys; ... }` 里 `[]` 是 truthy，写进 `skeleton.keys`
之后下一次调用会跳过重列直接 `done`，从此永久读不到骨架。

### 3. 我们只认官方索引（本轮修）

`listSkeletonKeys()` 只读 `subtitle-cache:index`。但**值比索引活得久**：官方索引有条数上限
（实测注释里写 50 条）与 24h TTL，而被挤掉的是**索引条目**，`subtitle-cache:v6:*` 的**值还躺在
storage 里**。本机实测：索引里 13 条，storage 里躺着 20 多条 `subtitle-cache` 值 ——
只要拿到 key 就能读值，索引里没有不该成为放弃的理由。

## 做什么

- **重试只挂在心跳上**（`heartbeat()`，1s 一次），`capture()` 不再触发列索引 ——
  否则次数会被逐词高亮刷爆（根因 1）。`heartbeat()` 已有注释说明为什么是它。
- **`SKELETON_MAX_TRIES` 4 → 60**（≈1 分钟窗口），并把「空结果不能落账」写在代码注释里。
- **索引落空时退化为枚举 storage 的 key**：`listStoredKeys()` 优先用 `getKeys()`
  （Chrome 130+，只回 key 不搬值），老版本退回 `get(null)`；筛 `subtitle-cache:v6:{videoId}:*:primary`。
  枚举比读索引贵，所以**只在第 1～5 次尝试与之后每 10 次做一次**（≤11 次），
  不会变成「每次心跳翻一遍 storage」。
- 补冒烟测试：索引里没有这个视频时也能捞到骨架；有 `getKeys()` 时不搬整份 storage；
  枚举次数有上限。

## 不做什么

- **不动 `progressEnd()` 的口径**：官方切行判定是 `start <= t < end`（见下），骨架句首尾相接时
  `end_i === start_{i+1}`（本机实测的官方缓存正是如此），所以「下一句的 start」与「本句的 end」
  等价；句间有间隙时两者不同，但那是「静音段算不算这一句的」的口径选择，不是本次症状的原因，
  不顺手改（要改另立 PLAN）。
- **不把 `:yt-reseg` 槽位当骨架**：本机缓存里有 1 条只有 `:yt-reseg`（没有 `:primary`）的视频。
  这个槽位是 STT/AI 重切分的产物，`cues` 的**语言语义我没有实测确认**（可能是译文轨），
  误用会把译文当原文塞进面板/浮窗/导出。语义核实前只认 `:primary`（遗留见文末）。
- **不改 `estimatedSeconds()`（中位数）**：没有骨架时的分母仍然只能估。本轮的目标是「让骨架
  真的读到」，不是「换一个还是猜的估计器」——后者需要实测分布支撑（另立 PLAN）。
- 不改 `readLines()` / `snapshot()` / 落盘格式 / 导出格式；不碰浮窗与面板。

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - tools/test/smoke.test.mjs
  - docs/plans/014-skeleton-load-reliability.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/05-ja-segment.js
  - src/mod/15-ja-break.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

## 实现方案

1. `10-subtitle-track.js`
   - `listStoredKeys()`：`getKeys?` → `get(null)` 退化；
   - `listSkeletonKeys(videoId, tries)`：先索引（带 `cachedAt` 排序），落空则按
     `tries <= 5 || tries % 10 === 0` 枚举 storage key；
   - `heartbeat()` 调用点传入 `skeleton.tries`。
2. `tools/test/smoke.test.mjs`
   - harness 增加可选的 `getKeys` 桩（`withStorageGetKeys`）与 `storageGetKeysCalls` 计数；
   - 新用例 1：索引整体缺失、值在 storage 里 → 骨架照样被采用，`getProgressEnd()` 用骨架的下一句起点；
   - 新用例 2：有 `getKeys()` 时不得 `get(null)`；
   - 新用例 3：枚举次数有上限（不跟着心跳每次翻 storage）。

## 验证方式

- [ ] `make test`（新增 3 条用例）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed` 或直接看面板）：开一条**没看过**的视频 →
      面板的「N 句」应当**立刻**是整条轨的句数（而不是随播放慢慢长出来）；
      浮窗进度条应当正好在换行那一刻顶满。

## 预期量级

3 个文件 / +120 −20 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交** —— 工作区里还躺着 PLAN 013 / 015 / 016 / 017 的未提交改动
  （`40-study-panel.js`、`30-desktop-subtitles.js` 等），按「一个 PLAN = 一个提交」本轮
  不应把它们裹进来。**`tools/test/smoke.test.mjs` 同时被那几个 PLAN 改过**，所以本轮
  无法只挑出自己的测试改动提交（需要人先决定怎么收尾那几个 PLAN）。
- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 72   # pass 72   # fail 0
  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-CtntZOE3.js
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js
  $ make check
  已注入  mod/…（7 个）
  ```

  本轮新增的三个用例（都在改前是**红**的）：
  `字幕轨道：官方索引里没有这条时，直接从 storage 里把骨架捞出来`（改前 `getCues().length` 是 0）、
  `字幕轨道：有 getKeys() 就不搬整份 storage`（改前 `get(null)` 从未被调用，断言方向相反）、
  `字幕轨道：列不到骨架时，枚举 storage 不能变成每次心跳都翻一遍`（改前枚举次数是 0）。
- 遗留 / 与预期不符之处：
  1. **浏览器内未验证**：本轮的全部改动都只在 Node 侧断言。要用一眼确认，看面板的句数是否
     一打开就是整条（这是「骨架读到了」最直观的证据）。
  2. **官方切行的实测口径**（逆向 `vendor/linglass-1.12.3/assets/promoCards-CtntZOE3.js` 的
     `findCurrentCue/holds`）：`t >= cue.start && t < cue.end`，rAF 每帧判定；句间有间隙时
     才允许 ±0.15s 的「就近」提前/延后；**没有**对 `currentTime` 的固定偏移。
     这条写进这里是给将来的 PLAN 用（例如「分母该不该用本句 end」）。
  3. **`estimatedSeconds()` 仍是全片中位数**：没骨架的视频（含只有 `:yt-reseg` 的那条）
     分母仍然只能估，症状会残留。下一步的选择有两条：核实 `:yt-reseg` 的语言语义后把它也
     当骨架；或者按「句长（字符数）× 观测到的语速」做估计器 —— 后者需要实测分布，
     不许凭空调参。
  4. **索引落空时的枚举没有按 `cachedAt` 排序**（枚举路径拿不到它）：同一视频存在多份
     `:primary`（换过学习语言）时，先试哪一份是 storage 的顺序，选错了靠 `liveMisses`
     的失配检测换 —— 而 `SKELETON_MAX_SWITCHES = 1` 只允许换一次。三份以上的场景没覆盖。
