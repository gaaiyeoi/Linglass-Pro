# 029 桌面字幕浮窗：上下文行（上一句 / 当前句 / 下一句）

> 状态：**已完成**（`make test` / `make build` / `make check` 全绿；浏览器内观感待人工确认）

## 需求

浮窗现在只有**当前这一句**（原文 + 译文）。看外语视频时想结合上下文理解，需要能同时看到
上一句与下一句 —— 用户原话：「我希望我能看到下一句话，或者也能看到上一句话，这样我能
结合上下文看得更好，然后这些字幕的话应该都需要是双语。」

用户选定：**三段式**（上一句 / 当前句 / 下一句各占一块，每块「原文 + 译文」；
上下文行字号 0.8×、不透明度 55%，当前句不变），**上下文行数可调并落盘**
（0 / 1 / 2，默认 1 = 只看下一句）。

## 根因（不是 Bug Fix，本节说明**硬约束**）

「下一句的双语」做不到，必须先说清：

- 原文拿得到：`__llgModTrack.getCues()` 是整条轨（官方写进 local 的整轨缓存 + 直播采样），
  `getCurrent()` 直接给 `{ index, next }`，所以上一句 / 下一句的**原文**现成。
- **译文拿不到**：`10-subtitle-track.js` 的 `fromSkeleton()` 明确「只取原文与时间，译文等采样
  来填」（`secondary: ''`）—— 官方缓存里根本没有译文，译文只在这句**被播到过**之后才有。
  所以：当前句必定双语；上一句基本有（刚播过）；**下一句通常只有原文**，重看同一视频时
  才会越攒越多。
- 想要「下一句也必定双语」，只能我们自己调官方翻译接口（要复用它的加密 token），
  那是另一个量级的工程且极脆 —— 本 PLAN **不做**，如实登记。

## 做什么

- `#stage` 改成三段结构：`#prev`（上一句）+ `#plate`（当前句，含进度填充）+ `#next`（下一句）。
  **当前句的 id 与结构一个字节都不动**（`#plate` / `#line-primary` / `#line-secondary` /
  `#fill-*`），既有语义与用例继续成立。
- 上下文行：`#prev-primary` / `#prev-secondary` / `#next-primary` / `#next-secondary`。
  - 字号 = 当前句字号 × 0.8；不透明度 55%（译文再叠官方的 `secondaryAlpha`）；
  - **不画底板、不带进度填充**（底板与填充只属于「正在读的那句」，这是刻意的取舍）；
  - **不带注音**：官方 DOM 只有当前句渲染了 `<ruby>/<rt>`，上下文行只有轨里的纯文本；
  - 断句分隔符沿用同一个开关（与当前句一致）；
  - 译文缺失就**留空**（不写占位、不留空行）。
- 上下文行数 `ctxLines` ∈ {0, 1, 2}，默认 **1**：
  - `0` = 只看当前句（旧样子）；`1` = 当前句 + 下一句；`2` = 上一句 + 当前句 + 下一句。
  - 落盘进 `chrome.storage.local['llgPipAppearance']`（PLAN 028 那个键）作为第 5 项。
- 样式条加一个 `≡` 按钮：点击循环 0 → 1 → 2 → 0，按钮上显示当前档（`≡0` / `≡1` / `≡2`），
  `ctxLines > 0` 时按钮带选中标记。
- 浮窗高度按内容现算（PLAN 027 的 `pipHeight()`）：每多一段上下文，加上那段的
  原文行（+ 译文行，若开双语）与一个 `#stage` 的 gap。
- `pushText()` 的重绘键把 `ctxLines` 与两段上下文的文本都算进去（改档位 / 换句要重绘）。

## 不做什么

- **不碰原生字幕**：不改官方 shadow DOM、不改 `15-ja-break.js` / `10-subtitle-track.js`
  （只读它的 `getCues()` / `getCurrent()`）。
- **不自己调翻译接口**给下一句补译文（见「根因」那节的硬约束）。
- **不给上下文行做注音 / 底板 / 进度填充**。
- 不做「上下文行的独立样式」（字号比例、透明度写死为 0.8 / 55%，不进样式条）——
  样式条这一轮只多一个「行数」按钮。
- 不改当前句的渲染、断句、注音、进度条逻辑；不动 `00-shared.js` / `40-study-panel.js` /
  `50-settings-panel.js` / `build.mjs` / `Makefile` / `tools/probe.mjs`。
- 不改常驻语义与播放控制栏行为（PLAN 001 / 004 / 022 / 027）。
- `复位（↺）` **不重置 `ctxLines`**：它不是官方外观页的维度，「把官方那套请回来」不该
  顺手把用户调的行数也抹掉。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/029-pip-context-lines.md
  - README.md            # 浮窗一节要补「上下文行」，否则文档与实现不一致
  - docs/images/pip.svg  # 配图里还是「两行 + 控制栏」，要补三段式与 Aa 样式条（用户要求）

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/test/contract.test.mjs
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

> `contract.test.mjs` 预计不改：新增的记号（`#prev*` / `#next*` / `.ctx` / `pip-ctx`）都是
> 我们自己的东西，没有新的官方选择器依赖。若实现时确实引入了，则登记并在此写明。

## 实现方案

1. **常量**：`CTX_MIN/CTX_MAX/CTX_DEFAULT = 0/2/1`、`CTX_FONT_RATIO = 0.8`、
   `CTX_OPACITY = 0.55`；`STAGE_GAP = 8`（与 `#stage { gap: 8px }` 对齐，供 `pipHeight()` 用）；
   `DEFAULT_APPEARANCE` 加 `ctxLines: CTX_DEFAULT`。
2. **数据**：`parseOwn()` 多校验一项 `ctxLines`（有限数 → `round` 后夹到 [0,2]，否则用默认值），
   于是 `seedFrom()` 播种时自然是默认 1；`resetAppearance()` 保留用户当前的 `ctxLines`
   （`setOwn({ ...seedFrom(officialAppearance), ctxLines: own.ctxLines })`）。
3. **取数**：`contextCue(offset)` = `getCurrent().index` + `getCues()[index + offset]`，
   返回 `{ primary, secondary }` 或 `null`。
4. **渲染**：`pushText()` 里除当前句外，把 `#prev` / `#next` 也渲染出来：
   文本按 `primaryParts()` 切（分隔符单独压样式），译文 `setText`，然后按 `ctxLines`
   与文本是否为空 `show()` / 隐藏（复用样式条那节已有的 `show()`）。
5. **高度**：`pipHeight()` 加 `ctxLines` 段的高度（每段 = 原文行 × 0.8 + 可选译文行 × 0.8，
   再加每段一个 `STAGE_GAP`）。
6. **样式**：`PIP_BASE_CSS` 加 `.ctx` 骨架；`pipCss()` 里按当前外观生成四个
   `#prev-primary` / `#prev-secondary` / `#next-primary` / `#next-secondary` 规则
   （与当前句同一套字体栈 / 描边 / 阴影，只改字号与不透明度）。
7. **样式条**：`buildStyleBar()` 加 `≡` 按钮（id `pip-ctx`）；`syncStyleBar()` 回显档位与选中态；
   `appearanceCommand()` 加 `case 'ctx'` 循环。

## 验证方式

- [ ] `make test`（新增用例名：
      ① 桌面字幕：默认只显示下一句，且下一句只有原文（译文要等它被播到过）
      ② 桌面字幕：档位拉到 2 时上一句也显示，并且带译文
      ③ 桌面字幕：≡ 循环 0/1/2 并落盘，0 时两段都收起来
      ④ 桌面字幕：上下文行数进了开窗高度）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：字幕区出现三段；上下文行明显更淡更小；`≡2` 时上一句能带译文；
      拉到 `≡0` 回到旧样子；关窗重开 / 刷新后档位还在；高度不裁字、不顶到控制栏

## 预期量级

3 个文件 / +200 −40 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：待定（未提交）
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 127   ℹ pass 127   ℹ fail 0

  $ make build
  [build] 基线      vendor/linglass-1.12.4
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js
  [build] 版本      1.12.900

  $ make check
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js

  $ git diff --stat
   README.md                       |   2 +
   src/mod/30-desktop-subtitles.js | 150 +++++++++++++++++++++++++++++--
   tools/test/smoke.test.mjs       | 191 ++++++++++++++++++++++++++++++++++--
  ```

（新增用例 5 条：默认只给下一句且无译文、档位 2 时上一句带译文、`≡` 循环与落盘、
`↺` 不动行数、上下文行的断句跟随开关；另改写了 PLAN 027 那条高度区间断言。）

### 既有断言的改写（按 AGENTS.md §3 登记）

本 PLAN 让「默认内容」多了一段上下文行，直接改变了开窗高度，所以 PLAN 027 的
`桌面字幕：开窗尺寸贴合内容，不再写死 1000×264` 里那条高度区间断言必须改：

| 旧断言 | 新断言 |
| --- | --- |
| `fit.height > 120 && fit.height < 180`（只有当前句 ≈ 145px） | `fit.height > 180 && fit.height < 230`（当前句 + 1 段上下文 ≈ 202px），并**新增**两条：`ctxLines=0` 要比它矮 30px 以上、`ctxLines=2` 要比它高 30px 以上 |

原测试的意图（高度贴合内容、跟着字号走、不写死）一条没丢；「档位调大高度要长」那条原样保留。
另外 `src/mod/30-desktop-subtitles.js` 里 `pushContext()` 收起上下文行时**用 `replaceChildren()`
清节点**（原文行是「片段 → 子节点」渲染出来的）—— 这不只是为了让桩件能断言，真 DOM 下
「清掉这一行的所有节点」本来就比「把 textContent 置空」更直白。

### 遗留 / 与预期不符之处

1. **下一句通常没有译文**（见「根因」）：这是官方数据的限制，本 PLAN 如实登记，不是漏做。
2. **上下文行没有注音 / 底板 / 进度填充**：官方 DOM 只有当前句渲染 `<ruby>`，底板与填充
   是「正在读的那句」的专属 —— 刻意取舍，已在代码注释与 README 写明。
3. **最后一格高度余量**：`ctxLines=2` 但当前是**第一句**时，「上一句」不存在 → 少一个 gap，
   高度会多出 8px 的余量（`PIP_HEIGHT_SLACK` 本来就留着这类余量，不影响观感）。
4. **浏览器内观感未验证**：三段的疏密、上下文行 0.8× / 55% 够不够读、`≡` 按钮的位置是否顺手
   —— 属于人工确认范围；本轮按用户既往要求没有启动浏览器。
5. **`≡` 的语义是「上下文行数」，不是「显示上下文」开关**：0 就等价于旧的单句浮窗。
6. **配图 `docs/images/pip.svg` 按用户要求一并更新**（三段式 + `Aa` 样式条），
   因此把它加进了本 PLAN 的 `allowed_paths`；它是手写 SVG，零依赖，不影响任何代码路径。
   与实现的一致性靠肉眼核对（画布 960×612，三段字号 24 / 30 / 24，透明度 55%）。
