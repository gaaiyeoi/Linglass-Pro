# 010 剥掉振假名 rt：字幕文本不该出现「夜よる」

> 状态：**已实现，未提交**（`make test` / `make build` / `make check` 全绿；浏览器内行为待人工确认）

## 需求

用户截图反馈：浮窗原文行里出现「夜よる」这种"重复标记"，问是不是字幕本身的问题。

期望：读到的原文是「夜」（汉字），不是「夜よる」；浮窗、面板逐句列表、Markdown / SRT 导出
三处口径一致，且与官方自己的「纯文本」口径一致。

## 根因

**不是官方字幕错，是我们读错了。**

官方对日语原文的振假名是用 `<ruby>` 渲染的：

```html
<span class="linglass-word" data-word="夜" data-start="0" data-end="1">
  <ruby>夜<rt>よる</rt></ruby>
</span>
```

（证据：`vendor/linglass-1.12.3/assets/promoCards-CtntZOE3.js` 的 `paintWord()` / `ruby()` ——
`document.createElement("ruby")` + `document.createElement("rt")`；是否渲染由官方设置
`readingMode`（`settings-*.js` 的 `pe.readingMode: {}`，按语言存 off/whole/runs）决定。）

而 `10-subtitle-track.js` 的 `readLines()` 直接取 `el.textContent`，`<rt>` 的假名会被一起读进来
→ 「夜」+「よる」拼成「夜よる」。这条错误文本随后流向：浮窗原文行、面板逐句列表、
导出的 Markdown / SRT。

官方自己取纯文本时是**专门剥掉 rt** 的（同一文件里就有这个函数）：

```js
function Tn(n) {
  if (!n.querySelector("rt")) return n.textContent || "";
  const e = n.cloneNode(!0);
  e.querySelectorAll("rt").forEach((t) => t.remove());
  return e.textContent || "";
}
```

`15-ja-break.js` 的 `textOf()` 已经照这个口径做了（因为它的插入位置必须与官方 slice 的字符偏移一致），
所以**同一份 DOM 上我们内部已经有两套文本口径**，这正是问题所在。

## 做什么

- `10-subtitle-track.js` 的 `readLines()` 改为取「剥掉 rt 的文本」，与官方 `Tn()` 同款：
  没有 rt 时走 `textContent` 快路径（不上 clone），有 rt 才 clone + 删 rt。
- 顺带保证 `onTimeline()`（画面文本 vs 时间轴文本的比对）两侧口径一致 —— 它同样走 `readLines()`，
  改完自动一致，但要写一条断言把它钉住。
- 补回归测试：
  - 造官方结构的行（`.subtitle.subtitle-primary` 里放 `ruby>rt`），断言 `readLines()` 的 primary 是「夜」；
  - 断言 `getProgress()` 在「画面有 rt、时间轴无 rt」时不误判成不一致（不返回假的 0）。

## 不做什么

- **不做振假名的显示**：这次只是把假名从文本里去掉，不在浮窗/面板里渲染 ruby。
  想看到注音是另一件事（另立 PLAN），别顺手做。
- 不动 `15-ja-break.js` 的插入逻辑（它本来就是对的）、不动它的分隔符观感。
- 不改导出格式（Markdown frontmatter、列表项结构、SRT 结构都不动）。
- 不改官方 `readingMode` 设置，也不去读它 —— 我们只要求"文本里不含 rt"。
- 不改 `cue.end` / 估计时长 / 进度分母。

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - tools/test/smoke.test.mjs
  - docs/plans/010-strip-furigana-rt.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/15-ja-break.js
  - src/mod/05-ja-segment.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

> 浮窗与面板**不需要改**：它们读的都是 `track.readLines()` / `track.getCues()`，源头干净了它们就干净了。
> 若实测发现浮窗另有 rt 来源，再另立 PLAN（不要在本轮扩范围）。

## 实现方案

1. `readLines()` 里把 `el.textContent.replace(...)` 换成 `plainText(el).replace(...)`，
   新增内部函数 `plainText(el)`（快路径 + clone 删 rt），注释里写明这是对齐官方 `Tn()`。
2. `tools/test/smoke.test.mjs`：harness 的字幕桩件要能造 `<ruby><rt>` 结构
   （官方结构：`[span.linglass-gap][span.linglass-word][gap][word]…`），再加两条断言。

### 需要实测确认的一处风险

**骨架匹配的口径**：`adoptSkeleton()` 拿官方缓存里的 `rawCues[i].text` 当 key，与采样到的
`readLines().primary` 做文本匹配。如果官方缓存里的 `text` **带**振假名（或带 rt 的形态不同），
剥 rt 之后匹配会变差（表现为「译文贴不回骨架句」）。

→ 验证方式里加一条：用 probe 把 `subtitle-cache:v6:*:primary` 的 `cues[0..3]` 原文打出来看，
确认它与我们剥 rt 后的文本一致。若不一致，本 PLAN 要不改匹配口径、要不改用 `rawText`，
**以实测为准**，不许猜。

## 验证方式

- [ ] `make test`（新增用例名：「字幕轨道：读原文时剥掉振假名 rt」「字幕轨道：画面有 rt 时进度不误判」）
- [ ] `make build` + `make check`
- [ ] probe 读一次官方缓存，核对骨架文本与我们剥 rt 后的文本是否一致（记录实际输出）
- [ ] 浏览器人工确认：日语视频里找一个带振假名的句子，浮窗/面板列表/导出的 Markdown 都不含 rt 假名

## 预期量级

2 个文件 / +60 −8 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交** —— 工作区里还躺着 PLAN 004~012 的改动，按「一个 PLAN = 一个提交」
  需要人先决定怎么收尾。
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 59   ℹ pass 59   ℹ fail 0
  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-CtntZOE3.js
  $ make check
  已注入  mod/…（7 个）
  ```

  新增用例：
  `字幕轨道：读原文时剥掉振假名 rt（不是「夜よる」）`（回归）、
  `字幕轨道：画面上的振假名不会让进度误判成 0`（回归）。

  **回归确认（先红后绿）**：把 `plainText()` 的条件临时改成 `if (false && el.querySelector('rt'))`
  跑一次 → 恰好这 2 例变红、其余 54 例仍绿；改回来 → 59 例全绿。

- 骨架匹配口径的实测结论：用 `--browser=arc` 的 probe 读了你本机 Arc 的
  `subtitle-cache:v6:*:primary`：`rawCues[].text` 与 `rawText` **都不含振假名**
  （样本：「みなさん、こんにちは！Bite Size Japaneseのレイラです😊」「僕らは恋愛初心者じゃない」）。
  所以剥 rt 之后，带注音的行与骨架的**文本**匹配只会更准 —— 此前那种行匹配不上，
  会退化到按时间匹配（译文偶尔贴错句）。风险解除，不需要改 `adoptSkeleton()`。

- 遗留 / 与预期不符之处：
  1. `tools/test/smoke.test.mjs` 的桩件新增了三样东西（`primaryPlain` / `primaryRt` /
     `showFurigana()`），`secondaryEl` 也补上了 `querySelector` / `cloneNode` —— 真 DOM
     本来就有，桩件之前没建。这是测试侧的改动，不是实现妥协。
  2. **浏览器内未验证**：那次 probe 跑的时候官方浮层是空的（视频没开字幕），没抓到活的
     带 ruby 字幕。要确认「浮窗/面板/导出都不含假名」，得在一个真开了振假名的日语视频上看。
  3. 没做振假名的**显示**（浮窗/面板里渲染 ruby）—— 那是另一件事，本 PLAN 明确不做。
