# 053 浮窗一次只显示一整句完整的话

> 状态：**已完成**（门禁全绿；浏览器内观感未验证，见「完成情况」）

## 需求

用户原话：「能不能让字幕每次只显示一整局完整的话 可能需要重构进度条组件?」

确认后的口径（见下方「需求确认」）：

1. **整句提前显示**：用字幕轨道里的完整句替换官方正在分步上屏的半句；句子一进入时间区间就
   显示全文，允许比语音略早。
2. **上一句 / 下一句也必须是完整句**（上下文行保留，不收起）。
3. 句内进度条按**整句**走，不在半句交界处回零。

### 需求确认

- 「一整句」= 轨道里合并后的完整原文，不是官方 DOM 当前时刻那一截半句。
- 显示时机选「整句提前显示」，不是「等官方吐完再刷新」。
- 上下文行（PLAN 029）保留；只要求它们同样是完整句。

## 根因

`10-subtitle-track.js::capture()` 用「整行文本 + 译文」当换句判据：

```js
const key = lines ? `${lines.primary}\u0000${lines.secondary}` : '';
if (key === lastKey) { extendActive(); return; }
lastKey = key;
closeActive();
if (lines && (lines.primary || lines.secondary)) openCue(lines);
```

官方同一句分步上屏（原文先到 → 文本补全 → 译文后到）时，每一步文本都不同，于是：

- 同一条 start 附近被拆成 2～3 条 cue（`findDuplicate()` 要求文本**完全一致**才去重）；
- `30-desktop-subtitles.js::currentLines()` 直接读官方 Shadow DOM，浮窗显示的永远是
  「当前这一截」；
- 句内进度的分母是 `progressEnd()`，无骨架时就是「这一截到下一截」——
  半句走完就回零。

PLAN 051 只把滚轮动效的判据换成了原文前缀，明确把「半句入库」留给另一个 PLAN；
本 PLAN 就是那一个。

## 做什么

- `10-subtitle-track.js`
  - 新增 `absorbFragment()`：新采样与当前句**互为前缀**（「あの」→「あの、そうですね」）
    且相邻采样间隔 ≤ 2.5s 时，并入当前 cue（`primary` 取更长的那份、`secondary` 取新的、
    `start` 保持第一次出现的时间），不 `closeActive()`、不新建 cue。
  - `capture()` 在 `closeActive()` **之前**尝试合并；合并成功只 `notify()`，不重放换句。
  - 骨架句不参与合并：官方整条轨里的句子本身就是权威整句。
  - `onTimeline()` 的「画面与时间轴同一句」判据从「文本完全相等」放宽为
    「互为前缀」—— 否则轨道是整句、画面是半句时 `getProgress()` 会一直返回 0。
- `30-desktop-subtitles.js`
  - `currentLines()` 改为「官方实时文本 + 轨道当前句」取整句：
    官方文本是轨道句的前缀时用轨道句（提前显示），否则以画面为准（刚换句、轨道还没跟上）；
    空档期仍返回空，不硬塞轨道句。
  - 译文仍跟官方实时文本（轨道里的译文同样是采样来的，没有额外信息）。
- `tools/test/smoke.test.mjs`
  - 新增回归：同一句分步上屏合并为一条 cue（start / 文本 / 译文）。
  - 新增回归：浮窗提前显示整句，且句内进度按整句计算（不为 0）。
  - 新增回归：已合并的整句作为「上一句」时，上下文行也是完整句。

## 不做什么

- **不改官方 Shadow DOM**，不往官方字幕行插节点（AGENTS.md §3 的文本流约束）。
- **不改骨架读取 / 采用策略**（PLAN 049 的行为原样保留）。
- **不改导出与学习面板的数据结构**：它们共用轨道，合并后自然拿到整句，不额外处理。
- **不重构进度条组件**：句内填充与整片进度条都不动，合并后分母自动覆盖整句。
- **不给整句显示加开关**：用户已确认这是期望行为。
- 不碰 `35-cast.js`（它走 `pip.castLines()` → `currentLines()`，自动跟随）与
  `50-settings-panel.js`。
- 不为「提前显示」补注音：轨道里没有注音数据；提前显示期间原文行降级为纯文本，
  官方补全后 `richTokens()` 会自动恢复 —— 如实登记，不在本 PLAN 硬做。

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/053-whole-sentence-once.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/12-longline.js
  - src/mod/15-ja-break.js
  - src/mod/16-imported-subtitle.js
  - src/mod/35-cast.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/test/contract.test.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. 常量 `FRAGMENT_WINDOW_SECONDS = 2.5`（与 `DEDUPE_WINDOW_SECONDS` 同口径）。
2. `absorbFragment(lines, start)`：
   - `active` 为空、或 `active` 是骨架句 → 不合并；
   - 距上次采样超过窗口 → 不合并（拖进度条跨到新句）；
   - 文本归一后既不 `next.startsWith(prev)` 也不 `prev.startsWith(next)` → 不合并；
   - 合并时保留更长的文本，`secondary` 非空且不是导入译文才覆盖。
3. `capture()`：在 `closeActive()` 前插入合并分支。
4. `onTimeline()`：相等或互为前缀都算同一句。
5. `30-desktop-subtitles.js` 抽 `wholePrimary(live, complete)` 纯函数，`currentLines()` 用它。
6. 测试按上面的三条回归补在「字幕轨道 / 浮窗的进度与分隔符」两段附近。

## 验证方式

- [ ] `make test`（新增用例名见「做什么」）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：无骨架视频上，一句话不再分两三截上屏；进度条按整句走；
      有骨架视频上，整句提前显示且上下文行完整（Node 测不到真实观感）

## 预期量级

4 个文件 / +130 −25 行（含本 PLAN）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里同时有 PLAN 047–052 的改动，按「一个 PLAN 一个提交」先不合）
- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 198
  # pass 198
  # fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js
  [build] 版本      1.12.901

  $ make check
  已注入  mod/00-shared.js, …, mod/10-subtitle-track.js, …, mod/50-settings-panel.js
  ```

  新增 3 条用例：

  - 字幕轨道：同一句分步上屏合并成一条完整句
  - 桌面字幕：同一句分步上屏时提前显示整句，句内进度按整句走
  - 桌面字幕：合并后的整句会作为完整的上一句出现

- 遗留 / 与预期不符之处：
  1. **浏览器内观感未验证**：整句提前显示会不会「抢拍」、长句提前铺满一屏是否可接受，
     Node 测不到；需要重载 `dist/` 在真实日语视频上看。
  2. **提前显示期间没有注音**：轨道里不存 `<rt>`，`richTokens()` 因文本不再等于官方
     当前行而返回 null，原文行降级为纯文本；官方把整句补全后自动恢复。这与 PLAN 017
     的注音不冲突，但「提前的那零点几秒」确实没有注音。
  3. **互为前缀的真换句会被吞成一句**（如「はい」→「はい、そうです」），这是刻意的
     保守取舍；要区分它们需要语音级时间戳，官方不提供。
  4. **骨架断句与实时 DOM 不一致时退化为半句**：若官方缓存的整句不是当前半句的前缀
     （重新断句/合并过），`wholePrimary()` 以画面为准 —— 宁可显示半句，也不显示错句。
  5. 实际改动量：3 个代码/测试文件 +162 −2（不含本 PLAN），比「预期量级」里的
     +130 略多，主要来自测试与新注释。
