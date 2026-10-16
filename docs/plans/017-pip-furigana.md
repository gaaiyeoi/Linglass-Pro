# 017 浮窗显示振假名：与官方原文字幕一致

> 状态：**已完成**（Node 侧门禁全绿；浏览器内的排版观感未验证，见文末）

## 需求

用户反馈：浮窗字幕和 Linglass 官方字幕**还是有不一样的地方**，例子是官方原文行有
「汉字 + 假名注音」（`<ruby>夜<rt>よる</rt></ruby>`），浮窗里只剩光秃秃的「夜」。

期望（用户已确认口径）：**完全跟随 Linglass 设置** —— 官方原文行当前显示注音，
浮窗就显示；官方关着，浮窗就保持纯净原文。也就是说：**照抄官方 DOM 的形态，零猜测**。

## 根因

不是漏做，是 PLAN 010 **有意**把注音剥掉的：

- `10-subtitle-track.js` 的 `plainText()` 会 clone 掉 `rt` 再取文本，为的是让
  「轨道里记的原文」「导出的 Markdown / SRT」与官方自己取纯文本的口径（`Tn()`）一致；
- 010 在「不做什么」里明确写了：**注音的「显示」是另一件事，另立 PLAN**。

浮窗读的是 `track.readLines()`，所以它拿到的是剥干净的纯文本，也就没有注音。

官方渲染逻辑（已实测确认，`vendor/linglass-1.12.3/assets/promoCards-CtntZOE3.js`）：

```js
paintWord(el, word, seg) {
  const i = Gi(seg, this.readingMode);
  if (i.kind === 'none') { el.textContent = word; return; }        // 不显示注音
  if (i.kind === 'whole') { el.appendChild(this.ruby(word, i.text)); return; }
  for (const run of i.runs) el.appendChild(run.r ? this.ruby(run.t, run.r) : textNode(run.t));
}
ruby(base, reading) {
  const r = document.createElement('ruby');
  r.appendChild(document.createTextNode(base));
  const rt = document.createElement('rt');
  rt.textContent = reading;
  r.appendChild(rt);
  return r;
}
```

即：`readingMode`（官方设置项，默认 `{}`，按语言存 `off` / `whole` / `runs`）决定原文行里
**有没有 rt**。所以「跟随官方」这件事只需要读 DOM：**行里有没有 `<rt>`，浮窗里就跟着有**。

## 做什么

1. `10-subtitle-track.js` 新增只读接口 `readPrimaryRich()`：

   - 取 `.subtitle.subtitle-primary`；
   - **行里没有任何 `rt` → 返回 `null`**（调用方走既有纯文本快路径，一个字节的渲染都不变）；
   - 有 `rt` → 按 DOM 顺序收集片段 `{ text, ruby }`：普通文本 / `.linglass-gap` 的文本
     成为 `ruby: ''` 的片段，`<ruby>` 收起成「base 文本 + rt 文本」一个片段，
     `rt` 自身不计入文本（与 `plainText()` 同一口径）；
   - 返回 `{ text, tokens }`，其中 `text` 是**空白归一后**的纯文本（与 `readLines().primary`
     完全同款）。**若 `tokens` 拼起来的原文与 `text` 不等（行里有多余空白/换行），返回 `null`**
     —— 宁可退回纯文本，也不猜某个字符属于哪个注音。

2. `30-desktop-subtitles.js` 的 `pushText()`：当 `readPrimaryRich()` 有值且
   `rich.text === lines.primary` 时走**富渲染**，否则维持现状（纯文本 + 断句分隔符）。

3. 富渲染与既有的「文节分隔符」共存（这俩必须同时在，不能二选一）：
   - 先拿 `05-ja-segment.js` 的切点（复用 `primaryParts()` 里那段逻辑，抽成一个小函数）；
   - 把 token 序列按切点切成**若干段**，段与段之间放一个 `.llg-sep`（与现在同一份样式）；
   - **切点落在带注音的片段内部时，放弃这个切点**（注音挂在汉字上，把汉字切开没法表达；
     分隔符只是视觉提示，少一个比给出错的注音好）——这条要写进注释和测试。

4. 浮窗 CSS：给 `#line-primary` 里的 `rt` 上样式（小一号、稍淡、取消字距继承），
   并照顾 ruby 撑高行时的行距。

## 不做什么

- **不改 010 的既有口径**：`readLines()` / 导出 / 面板逐句列表仍然是不含注音的纯文本，
  一个字都不动。「注音只出现在浮窗」是本轮的范围。
- 不在浮窗里做「即使官方关着也强行显示注音」（用户已明确选择「跟随官方」）。
- 不碰 `15-ja-break.js`（它往官方行里插的是空 span + CSS `::after`，与本轮无关）。
- 不改 `05-ja-segment.js` 的切分规则。
- 不改 `40-study-panel.js`（面板列表不做注音）。
- 不引入依赖，不改 `build.mjs` / `Makefile` / `vendor/` / `dist/`。
- 不重构浮窗的外观体系（原生外观一节照旧）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/017-pip-furigana.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/15-ja-break.js
  - src/mod/05-ja-segment.js
  - src/mod/00-shared.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
  - tools/test/contract.test.mjs
```

> 契约测试不改：本轮新增的选择器只有标签名（`ruby` / `rt`），不在
> `contract.test.mjs` 的「`.` / `#` 选择器登记表」的扫描范围内（`rt` 已被 010 用过）。

## 实现方案

1. `readPrimaryRich()` 的实现要点：遍历 `childNodes`（`nodeType === 3` 取 `data`），
   `RT` 跳过，`RUBY` 取其「非 rt 子树文本」与「rt 子树文本」，其余元素递归。
2. `30-desktop-subtitles.js`：
   - 新增 `cuePoints(text)`（从 `primaryParts()` 里抽出的切点计算，供纯文本与富渲染共用）；
   - 新增 `richSegments(tokens, points)` → 段数组；
   - 新增 `renderRichSegments(line, segments)`（`<ruby>` + `<rt>` 或文本节点，段间插 `.llg-sep`）；
   - `pushText()` 里加分支与 `lastKey` 的口径（把 token 形态一起进 key，否则改注音不重绘）。
3. 测试桩件：`smoke.test.mjs` 的「原文行」桩件要能表达 ruby 树。现有桩件只有
   `textContent` / `querySelector('rt')` / `cloneNode()`，**需要补一份可遍历的 `childNodes`**
   （最简形态：`h.primaryNodes` 存在时用它，否则维持旧行为），并新增用例：
   - 「浮窗：官方行带注音时渲染 `<ruby>/<rt>`，文本仍是不含 rt 的原文」
   - 「浮窗：官方行没有注音时一字不变（走纯文本快路径）」
   - 「浮窗：注音与文节分隔符共存，切点落在注音片段内时放弃该切点」

## 验证方式

- [ ] `make test`（新增用例名见上）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：找一个**官方开了注音**的日语视频，确认浮窗原文行的注音位置、
      字号、行距与视频内那行基本一致；再把官方 `readingMode` 关掉，确认浮窗回到纯净原文
- [ ] 浏览器人工确认：带注音的句子 + 打开「字幕句内断句」，浮窗里分隔符与注音不打架

## 预期量级

3 个文件 / +190 −30 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交** —— 与 PLAN 016 同一个工作区（还有 004~012 与并行会话的改动）。
  编号同理：原写 014，落盘时避开已被占用的 015，改成 **017**。

- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 68   ℹ pass 68   ℹ fail 0
  $ make build   → 契约校验 ✓ / 注入自检 ✓
  $ make check   → ✓
  ```

  新增用例（3 条，冒烟）：
  `桌面字幕：官方原文行带注音时，浮窗渲染成 ruby（跟随官方）`、
  `桌面字幕：官方原文行没有注音时，浮窗一个字符都不变`、
  `桌面字幕：注音与文节分隔符共存，切点落在注音片段内时放弃那个切点`。

  **回归确认（先红后绿）**：把 `pushText()` 里的 `richTokens(lines.primary)` 临时改成
  `null`（等于不启用富渲染）→ 恰好前两条变红、其余 63 例仍绿；改回来 → 65 例全绿。
  第三条只守「无注音路径不受影响」，本来就不该被这个回退打红。

- 遗留 / 与预期不符之处：
  1. **浏览器内观感未验证**：`#line-primary rt` 的字号（`.5em`）、透明度（`.72`）与
     `:has(ruby)` 时的行距（`1.7`）都是推理性取值，没在真实视频里比过官方那行的排版。
     上面「验证方式」里的两条人工确认还没跑。
  2. **只有「当前画面上这一句」有注音**：官方缓存的那份整条原文轨（`subtitle-cache:v6:*`）
     里本来就不含 rt（PLAN 010 实测过），所以面板逐句列表、导出的 Markdown / SRT 仍然是
     不含注音的纯文本 —— 这是 010 定下的口径，本轮明确不动。
  3. 测试桩件新增了三样东西（`primaryNodes` / `createTextNode` / `pipPlain`），
     属于测试侧补齐真 DOM 该有的能力，不是实现妥协。
  4. `readPrimaryRich()` 在行里有额外空白（片段拼起来 ≠ 归一化后的纯文本）时返回 `null`，
     退回纯文本。这是有意的保守策略（不猜字符归属），代价是那种行看不到注音。
