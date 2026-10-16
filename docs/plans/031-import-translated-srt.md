# 031 导入自己翻译的字幕（离线翻译工作流）

> 状态：**已完成**（执行中扩过一处范围，见「实现方案」第 5 节）

## 需求

现在有一个只带**单语原文字幕**的视频（例如日语），官方没有给它译文，所以桌面字幕浮窗
只有原文一行，看不到中文。

期望：把这条单语原文导出来 → 在扩展之外（自己顺手用什么工具都行）翻好 →
回到同一个视频，把翻好的字幕**导回去**，浮窗里就能看到双语（原文 + 我的译文）。

即：**翻译这件事在扩展之外完成，扩展只负责「导出原文」与「导入译文」两端的文件交换。**

## 根因

不适用（新增能力，非 Bug Fix）。

## 做什么

### 1. 导出单语原文 SRT（我们自己的，干净的单语）

现成的 `toSrt()` 是 `[cue.primary, cue.secondary].filter(Boolean).join('\n')` ——
一旦某几句已经被官方翻过（播放过的部分），导出的就是「有的句两行、有的句一行」的
混合文件，喂给翻译工具会乱。

所以加一个**只导原文**的口子：`toSrt(snap, { sourceOnly: true })`，
并在面板页脚与设置面板各加一个「导出原文 SRT」入口（与既有「导出双语 SRT」并列）。

### 2. 导入译文 SRT

- 面板页脚 + 设置面板各加一个「导入译文 SRT」入口，打开文件选择框（`accept=".srt"`）。
- 解析 SRT → 贴回当前轨道 → 写入 `cue.secondary` → 落盘 → 浮窗/面板/导出立刻都能看到。
- 贴回结果如实反馈：`已贴 118 / 124 句`（贴不上的要报数，不许假装全对）。

### 3. 优先级：导入的译文 > 采样来的译文

- 给 cue 加来源标记 `origin: 'imported'`，`capture()` 采样填译文时跳过它，
  绝不把导入的译文覆盖成官方/空。
- 落盘时 `origin` 一起存，跨刷新保持优先级。

### 4. 「视频有没有变」的廉价保险

用户口径是**默认没变，不对再重新生成**。所以不做自动重翻，只做一条提示：
把导入当时的原文轨指纹（句数 + 首句 + 末句）存在轨道 meta 里，下次加载时比对，
不一致就在 toast 里提示「原文字幕与导入时不同，可能有对不齐的句子」。

## 不做什么

- **不覆盖官方画面里那层字幕**（用户明确要求）。我们的三个出口 —— 桌面字幕浮窗、
  学习面板、导出 —— 用自己的译文；官方 Shadow DOM 一律不碰。
- **不调用任何在线 API**，不存 API key，不做实时翻译。
- **不做「视频变了自动重翻 / 自动失效」**，只给提示。
- 不支持 Markdown / VTT / ASS 导入，**只吃 SRT**。
- 不做拖拽导入、不做批量导入、不做多语言选择。
- 不改官方 `subtitle-cache:*` 那批 key（只读红线）。
- 不改导出 SRT 的既有格式（只是多一个 `sourceOnly` 参数分支）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/05-srt.js
  - src/mod/10-subtitle-track.js
  - src/mod/40-study-panel.js
  - tools/test/srt.test.mjs
  - tools/test/smoke.test.mjs
  - tools/test/contract.test.mjs
  - docs/plans/031-import-translated-srt.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/05-ja-segment.js
  - src/mod/15-ja-break.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
  - build.mjs
```

## 实现方案

### 1. `src/mod/05-srt.js`（新增，纯函数，无 DOM 副作用）

注入顺序由 `build.mjs` 的 `scanMod()` 按文件名排序决定（`build.mjs:126-135`），
`05-ja-segment.js` < `05-srt.js` < `10-subtitle-track.js`，天然排在轨道之前，无需改构建。

两个纯函数，都挂在 `globalThis.__llgModSrt` 上（与 `05-ja-segment.js` 同款做法），
方便 Node 侧直接测：

- `parseSrt(text)` → `[{ start, end, text }]`
  边界要处理：UTF-8 BOM、CRLF、`,` 与 `.` 两种毫秒分隔、一句多行、空行分隔、
  时间戳乱序、坏块（跳过，不抛）、末块无尾换行。
- `planImport(trackCues, parsed, { tolerance })` → `{ assignments, matched, missed }`
  贴回计划（**纯函数，不碰轨道**）：
  - **判据以时间戳为主**：对每个导入句，取 `start` 落在 `[cue.start - tol, cue.end + tol]`
    的轨道句；有多个取重叠最大者；一个轨道句只能被贴一次（贴过就 consumed）。
  - 时间戳是首选判据，因为「导出 → 翻译 → 导入」这条链上时间戳不会被动过，
    而文本一定被改（改了才是译文）。
  - 容差取 ±1.5s（导出用的是同源时间戳，正常应该几乎零偏差；留这个是给
    手改/工具重排留余量）。
  - 匹配不上的进 `missed`，如实计数。
- `fingerprint(cues)` → `{ count, first, last }`，给上面第 4 条用。

### 2. `src/mod/10-subtitle-track.js`

- 新增 `api.applyTranslations(list)`：
  收到 `[{ start, secondary }]`，写回 `cues` 对应句：
  - `cue.secondary = text`、`cue.origin = 'imported'`
  - 记 `meta.import = { at, fingerprint }`
  - `await flush()` 落盘到我们自己的键（`llgTrack:<videoId>`，`10-subtitle-track.js:31`）
  - 返回 `{ applied, missed, fingerprintMismatch }`
- **优先级保护**（关键，不保护就会被采样冲掉）：
  - `openCue()` 的 `10-subtitle-track.js:664` 与 `:675` 两处写 `secondary` 的地方
    加 `&& cue.origin !== 'imported'`。
  - `adoptSkeleton()` 的 `:437` 已有 `if (!match.secondary && live.secondary)`，
    语义上已经保护了，但要补一条断言式测试锁住它。
- 加载时的指纹比对：`loadForCurrentVideo()`（`:834`）里读出 `meta.import`，
  与骨架指纹比对，把结果放进 `getMeta()` 供面板提示。

**落盘不会被吃掉（已确认的既有行为，不需要改）**：
`loadForCurrentVideo()` 先从 `llgTrack:<videoId>` 读出我们自己的 cues（`:856-863`），
`adoptSkeleton()` 再把译文搬回骨架句（`:437`），所以导入的译文刷新后还在。

### 3. `src/mod/40-study-panel.js`

- 页脚（`:370-375`）在「SRT」旁边加两个按钮：`原文 SRT`、`导入译文`。
- 新增隐藏的 `<input type="file" accept=".srt">`（Chrome 里内容脚本读不了本地路径，
  只能走 file input），选中后 `file.text()` → `parseSrt` → `planImport` →
  `track.applyTranslations` → toast 报数。
- 设置面板的行是在本文件里登记的（`:1074` 起，已有 `exportSrt` 等行），
  照同款再加「导出原文 SRT」与「导入译文 SRT」两行，**不用改 `50-settings-panel.js`**。

### 4. 导入文件的格式约定（写死在提示文案里）

> **导入的 SRT，每一句的文本整块当作译文。**

理由：翻译工具的输出格式千奇百怪，与其猜「哪行是原文哪行是译文」，不如定死一条，
让用户保证输出。一句里有多个文本行时，用空格拼成一行再存
（浮窗与面板都是单行渲染，多行会撑坏排版）。

### 5. 契约测试的扩展名排除（**执行中扩范围**）

执行时 `make test` 红了唯一一条：`源码里出现的每个选择器都已登记` 报出 `.srt`。
来源是 `40-study-panel.js` 的 `importInput.accept = '.srt'` —— `contract.test.mjs`
的扫描器（`extractSelectors()`）按「单引号、以 `.`/`#` 开头、含字母」认选择器，
扩展名被误伤。

`tools/test/contract.test.mjs` 原本在 `forbidden_paths` 里，**已征得用户同意扩进来**
（原话：扩范围，直接修检测器）。改动只有一条机制性排除：
新增 `isFileExtension(token)`（形状 = 一个点加字母数字，整串到底），在 `unknown`
过滤里一并排掉 —— 不是把 `.srt` 硬编码进白名单，这样以后扫到 `.vtt` 之类的扩展名
也不会再炸。**没有**改动任何既有契约登记项。

## 验证方式

- [ ] `make test`，新增用例：
  - `tools/test/srt.test.mjs`（纯函数）：
    BOM / CRLF / 逗号与点号毫秒 / 一句多行 / 时间戳乱序 / 坏块跳过 /
    `planImport` 的「多对一取重叠最大」「不许重复贴」「超容差进 missed」。
  - `tools/test/smoke.test.mjs`（在 `:900` 那个加载点按顺序加 `05-srt.js`）：
    1. 导入后 `cue.secondary` 生效；
    2. **导入后继续播放，采样不把 imported 的译文覆盖掉**（这条是本 PLAN 的核心回归）；
    3. 换视频 → 切回来，导入的译文仍在（走一遍 `loadForCurrentVideo` + `adoptSkeleton`）。
- [ ] `make build`：契约校验与注入自检无告警（新增文件要出现在注入列表里）。
- [ ] `make check` 通过。
- [ ] 浏览器人工确认（未做就在 PLAN 里如实标注）：
  真实日语单语视频 → 导出原文 SRT → 外部翻好 → 导入 → 浮窗双语对上；
  以及「故意改乱时间戳」时是否如实报 `已贴 x/N 句`。

## 预期量级

6 个文件 / 约 +480 −20 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：本提交（PLAN 031）
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 148   ℹ pass 148   ℹ fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      mod/00-shared.js → mod/05-ja-segment.js → mod/05-srt.js →
                    mod/10-subtitle-track.js → mod/15-ja-break.js →
                    mod/30-desktop-subtitles.js → mod/40-study-panel.js
                    → mod/50-settings-panel.js   （注入自检无告警）

  $ make check
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js

  $ git diff --cached --stat
   docs/plans/031-import-translated-srt.md | 231 ++++++++++++++++++++
   src/mod/05-srt.js                       | 186 +++++++++++++++++++
   src/mod/10-subtitle-track.js            | 117 ++++++++++++-
   src/mod/40-study-panel.js               | 135 ++++++++++++++-
   tools/test/contract.test.mjs            |  14 +-   ← 执行中扩范围（第 5 节）
   tools/test/smoke.test.mjs               | 166 +++++++++++++++++++
   tools/test/srt.test.mjs                 | 199 +++++++++++++++++++
   7 files changed, 1038 insertions(+), 10 deletions(-)
  （去掉本 PLAN 文件本身：代码与测试 6 个文件 / 约 +807 −10，
    比 PLAN 预估的 +480 −20 厚，多出来的是测试用例：srt 199 + smoke 166。）
  ```

### 新增用例（对照「验证方式」）

- `tools/test/srt.test.mjs`：BOM / CRLF / `.` 与 `,` 两种毫秒 / 一句多行 / 时间戳乱序 /
  坏块跳过，以及 `planImport` 的「多对一取重叠最大」「一个轨道句只贴一次」
  「超容差进 missed」「无 end 时按默认窗口兜底」、`fingerprint` 与 `sameFingerprint`。
- `tools/test/smoke.test.mjs`：
  1. 导入译文：贴回对应句、打上 `origin`，并落盘到我们自己的键；
  2. 导入译文：继续播放时**采样不覆盖导入的译文**（本 PLAN 的核心回归）；
  3. 导入译文：切走再切回来，译文与 `origin` 都还在（走一遍 `loadForCurrentVideo` + `adoptSkeleton`）；
  4. 导入译文：原文轨与导入时不一致时 `getMeta().importMismatch === true`（只提示、不自动失效）；
  5. 导入译文：没导入过的轨道不报 `importMismatch`。

### 遗留 / 与预期不符之处

1. **浏览器人工确认没做**：真实日语单语视频「导出原文 → 外部翻好 → 导入 → 浮窗双语对上」
   这条链路，以及「故意改乱时间戳时报 `已贴 x/N 句`」的读数，都还没在浏览器里跑过。
   下面这条与用户此前反馈的「某一句没有译文」直接相关，属于**优先要人眼过一遍**的部分。
2. **贴不上的句只报数、不报哪句**：`applyTranslations` 只回 `{ applied, missed }`，
   toast 也只有一个总数。用户要排查「为什么这一句没贴上」时，拿不到是哪句、差多少秒。
   （不进本次范围，需要时另立 PLAN 加「详情」入口。）
3. **`importMismatch` 目前只进 `getMeta()`**，面板上的提示是一行状态文案，没有「重新导入」按钮。
4. **与 PLAN 030 遗留的「下一句没有译文」是两回事**：那条是官方整轨译文缓存读不读得到，
   这条是用户自己贴的译文能不能贴上，互不覆盖，别混在一起排查。
