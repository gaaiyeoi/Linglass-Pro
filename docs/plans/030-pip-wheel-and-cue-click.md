# 030 桌面字幕浮窗：滚轮式切换、上下文行更淡、点上下文行跳过去重播

> 状态：**待执行** → 执行中 → 已完成（完成后回写本节）

## 需求

用户看着三段式的浮窗提了三条：

1. **切换句子要动效** —— 「类似苹果闹钟的那种滚轮那种感觉」：换句时整列像滚轮一样推进一格。
2. **上下两条要更「朦胧」** —— 「上下那两个（第 0 条和第 2 条）应该有一种不透明的感觉，
   只有正在播放的那一条才会有那个感觉」。现在上下两条是 55% 不透明度，看着仍偏亮。
3. **点上下文行能跳过去重播** —— 「点上一句，它就会马上跳到上一句去播，从头开始播放」。

（另外用户问「为什么第三句话没有中文字幕」——那是 PLAN 029 登记的硬约束：译文只在
这句话被播到过之后才有。**本轮不改这条**，能改它的前提见下面「不做什么」最后一条。）

## 做什么

- **滚轮动效**：三段（上一句 / 当前句 / 下一句）外面包一层 `#reel`；**当前句的序号一变**
  就给 `#reel` 打一个方向标记 —— 前进（往后播）是 `data-roll="up"`，后退是 `data-roll="down"`，
  CSS 动画让整列从对应方向推入（`translateY(±22px)` + 透明度 0.3 → 1，260ms，
  `cubic-bezier(.22,.61,.36,1)`）。同一个方向连续换句要能重放（先删标记、读一次
  `offsetWidth` 强制重排、再打标记）。
  尊重 `prefers-reduced-motion: reduce`（关掉动画）。
- **上下两条更淡**：把不透明度从**行级**（`.55`）挪到**块级**（`.ctx`），值降到 **0.4**；
  这样「淡」是整段（原文 + 译文一起），而且**只有当前句（`#plate`）是不透明的**。
  鼠标悬停上下文行时提到 `.75`，明示「这一段可以点」。
- **点上下文行跳过去重播**：`#prev` / `#next` 上挂 `data-act="cue-prev"` / `"cue-next"`，
  `command()` 里处理：取相邻那句的 `start`，`video.currentTime = start` 然后 `video.play()`
  —— 就是「马上跳到那一句、从头开始播」。鼠标指针改成手型。
  与既有控制栏按钮的区别：控制栏的 `prev` / `next` 保留原语义（播到句中超过 1s 时先回到
  本句开头，PLAN 004），这里点的是**字幕行**，直接跳过去重播，不绕。

## 不做什么

- **不改当前句的排版 / 注音 / 进度条**（PLAN 002 / 017 / 029 的口径不动）。
- **不做真正的「滚动容器」**：条目高度不相等（当前句 30px、上下文 24px），做真滚动要么
  强制等高（牺牲当前句的地位）、要么滚动距离随句而变（换来抖动）。用「位移 + 淡入」的
  一次性动画表达同样的观感，稳且不碰布局。
- **不给上下文行加模糊**：用户要的是「结合上下文读」，模糊会反过来伤可读性 —— 用不透明度
  表达层次就够。
- **不加新的样式条控件**：动效与点击都是行为，不是外观档位，不进 `llgPipAppearance`
  （省得落盘里塞一个没人会关的开关）。
- **不做「下一句的译文」**：那要先确认官方 `subtitle-cache:v6:<视频>:<学习语言>:<目标语言>`
  这份**整轨译文缓存**是否真的存在、能不能按时间对齐 —— 若成立，另立 PLAN（用户已被告知
  需要在扩展上下文里跑一行诊断确认）。本 PLAN 不碰 `10-subtitle-track.js`。
- 不动 `00-shared.js` / `15-ja-break.js` / `40-study-panel.js` / `50-settings-panel.js` /
  `build.mjs` / `Makefile` / `tools/probe.mjs` / `tools/test/contract.test.mjs`。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/030-pip-wheel-and-cue-click.md
  - README.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/test/contract.test.mjs
  - docs/images/pip.svg      # 动效与「可点」是行为，静态图这轮不动
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

## 实现方案

1. **结构**：`buildWindow()` 里把 `#prev` / `#plate` / `#next` 装进 `#reel`，`#stage` 只放 `#reel`；
   `#reel` 与既有链条一致地声明 `min-width: 0`（否会给浮窗设下拖不下去的下限，
   见 PLAN 027 与「窗口能拖小」那条用例）。
2. **动效**：`PIP_BASE_CSS` 加 `@keyframes llg-roll-up / llg-roll-down` 与
   `#reel[data-roll="up"|"down"] { animation: … }`，外加 `prefers-reduced-motion` 关掉它。
   JS 侧 `roll(dir)`：删 `data-roll` → 读 `offsetWidth`（强制重排）→ 重新打上。
3. **触发时机**：`pushText()` 里记住 `lastCueIndex`；只有**序号真的变了**（且都不是 -1，即
   不是首次填充）才 `roll()` —— 改颜色 / 改字号 / 开关断句都不该滚。`stop()` 里复位
   `lastCueIndex = -1`。
4. **不透明度搬家**：`pipCss()` 里去掉 `#prev-*` / `#next-*` 的 `opacity`，
   改在 `PIP_BASE_CSS` 的 `.ctx { opacity: .4 }`；加 `.ctx:hover { opacity: .75 }` 与手型。
5. **点击跳转**：`ctxBlock()` 里给两块挂 `dataset.act`；`command()` 的 switch 加
   `cue-prev` / `cue-next` 两个分支（在 video 闸门之后 —— 没有 video 就没得跳）。
6. **常量**：`CTX_OPACITY = 0.4`（原 0.55）、`CTX_OPACITY_HOVER = 0.75` 写进 CSS 注释附近，
   `ROLL_SHIFT_PX = 22`、`ROLL_MS = 260` 出现在 keyframes 里（动画时长写死在 CSS，
   因为 JS 只负责打方向标记）。

## 验证方式

- [ ] `make test`（新增用例名：
      ① 桌面字幕：换句时给滚轮动效打方向标记，改外观不滚
      ② 桌面字幕：点上一句 / 下一句会跳到那一句的开头并从头播
      ③ 桌面字幕：上下文行整段变淡、悬停变亮、可点）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：换句时整列推进的手感；`prefers-reduced-motion` 下不动；
      点上一句真的从那句开头重播；上下两条是否够淡又仍然读得清

## 预期量级

3 个文件 / +130 −30 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：待定（未提交）
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 129   ℹ pass 129   ℹ fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      mod/00-shared.js → mod/05-ja-segment.js → mod/10-subtitle-track.js →
                    mod/15-ja-break.js → mod/30-desktop-subtitles.js → mod/40-study-panel.js
                    → mod/50-settings-panel.js   （注入自检无告警）

  $ make check
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js

  $ git diff --stat
   README.md                       |   4 +-
   src/mod/30-desktop-subtitles.js |  98 ++++++++++++++++++++++++++-------
   tools/test/smoke.test.mjs       |  86 +++++++++++++++++++++++++++++-
  ```

### 既有断言的改写（按 AGENTS.md §3 登记）

| 旧断言 | 处理 |
| --- | --- |
| `#next-primary { … opacity: 0.55`（PLAN 029 写的行级淡度） | 改成断言**块级**：`.ctx { opacity: .4 }`、`.ctx:hover { opacity: .75 }`，并**新增** `doesNotMatch(/#next-primary \{…opacity/)` —— 钉住「淡」只出现在一处，免得以后两头都写、叠出两种淡度 |

### 遗留 / 与预期不符之处

1. **动效未在浏览器里看过**：260ms / 22px 的位移与缓动是凭经验取的，手感（尤其句短时连续换句）
   需要你实测。两个数都在 `PIP_BASE_CSS` 的 keyframes 里，改一处即可。
2. **不是真滚动容器**：条目不等高（当前句 30px、上下文 24px），所以用「位移 + 淡入」一次性动画
   表达滚轮观感；真正的滚动容器会抖（见「不做什么」）。
3. **`data-roll` 标记不会被清掉**：动画播完标记仍在（值为 `up` / `down`）。这是有意的 ——
   CSS 动画只认「属性被设置的那一刻」，标记留着不影响下一次重放（重放靠先删再打）。
   用例里也据此断言。
4. **点击跳转不做「到句尾暂停」之类的花样**：就是 `currentTime = cue.start` + `play()`，
   与用户要求「马上跳过去从头播」一致。
5. **「下一句没有译文」本轮仍未解决**：需要先确认官方那份
   `subtitle-cache:v6:<视频>:<学习语言>:<目标语言>` 整轨译文缓存是否真的存在（已把诊断方法
   交给用户）—— 存在的话另立 PLAN 读它并对齐时间。
