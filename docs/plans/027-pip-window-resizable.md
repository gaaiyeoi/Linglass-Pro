# 027 浮窗尺寸：默认贴合内容，而且能往小拖

> 状态：**已完成**（代码与门禁绿；浏览器内的实际观感与「能拖到多小」待人工确认）

## 需求

用户在同一个话题里连着提了两件事，改的是同一处（浮窗尺寸），所以合成一份 PLAN：

1. 「浮窗字幕不能调整窗口大小了 —— 只能变大，看起来有设定最小尺寸」。
   期望（二选一里选定的原话）：**窗口可自由拉伸（含往小拖），字号不变**。
2. 「默认大小应该是正好把字幕和一些按钮全部显示出来，但是中间基本上没有空隙」。
   期望：**开窗时按内容贴合**，不要上下各留一大块黑边。

## 根因

### 一、窗口拖不小

先说**不成立**的两条，免得下次又去查：

1. 不是我们主动复位窗口 —— 全仓没有任何 `resizeTo` / `resizeBy` / `resize` 监听 /
   `ResizeObserver`（`git log -S` 也确认历史上从来没出现过）。窗口尺寸我们一次都不写。
2. 不是那次性能改动引入的 —— `55a792b` 对 `30-desktop-subtitles.js` 的改动里
   没有任何一行涉及 `height` / `width` / `padding` / `font-size`（逐行过滤过 diff）。

**真正的可识别约束在 CSS 里**：`PIP_BASE_CSS` 给内容设了一串固有最小尺寸，而 Document PiP
窗口能被拖到多小取决于文档内容的 min-content：

- `#bar button { min-width: 42px }`（`#pip-toggle` 更是 54px）+ `gap: 6px` + `padding: 0 10px`
  与 `#bar` 的 `padding: 8px 12px 10px` → 六个按钮那一排的 min-content ≈ 320px，
  等于给窗口宽度钉了一个下限；
- flex 子项默认 `min-width: auto`：`#box` / `#stage` / `.kline` / `#plate` 都没有显式
  `min-width: 0`，内容的 min-content 会一路把容器（也就是窗口）撑住；
- `#stage { padding: 10px 34px 0 }` 再给宽度加上 68px、给高度加上 10px。

### 二、默认尺寸不贴合

`requestWindow({ width: 1000, height: 264 })` 是写死的，而**字号不跟窗口走**
（PLAN 008 的取舍，本轮用户再次确认保留）：100% 档下内容只有约 133px 高，
264 里多出来的部分在 `#stage` 里上下居中 → 上下各留 60 多像素黑边；
反过来档位一调大（150%、200%）264 又不够，字会被裁。两个方向都不对。

宽度 1000 同理：字幕居中，两侧各留几百像素，对读字幕毫无帮助。

**证据与其局限（如实登记）**：

- 代码证据是硬的：上面几条规则就在文件里，`min-width: auto` 是 CSS 明定的默认值。
- 我写过一个隔离实验（`.scratch/pip-size-probe.mjs`，不进版本控制）想直接量出窗口下限，
  但那次实验**取错了 target**（量到的是 1200×710 的主窗口，`Browser.setWindowBounds`
  读回的 240×86 因此不能算作 PiP 窗口的数据），**不作为证据**。用户随后要求「不要再启动
  浏览器测试，直接改」，所以没有重做。
- 因此：窗口下限里有多少来自浏览器自身（macOS/Chrome 对系统窗口也有自己的下限），
  有多少来自我们的内容，**这一轮没有量出来**。本次改动只把「由我们掌控的那部分」去掉。

## 做什么

尺寸（第 1~6 条）：

1. `#bar`：`gap` 6px → 4px、`padding` 12px → 6px（左右），并显式 `min-width: 0`。
2. `#bar button`：去掉 `min-width: 42px`，改 `flex: 0 1 auto; min-width: 0; padding: 0 6px;
   white-space: nowrap` —— 窄窗口下按钮一起收窄，文字不折行。
3. `#pip-toggle`：去掉 `min-width: 54px`（保留 `font-size: 15px`）。
4. `#box` / `#stage` / `.kline` / `#plate` 各补 `min-width: 0`，解除 flex 固有的
   `min-width: auto` 牵制。
5. `#stage` 的 `padding: 10px 34px 0` → `8px 16px 0`（少给窗口下限抬一层）。
6. `PIP_WIDTH` 1000 → 700；删掉写死的 `PIP_HEIGHT = 264`，改成按当前外观现算的
   `pipHeight(appearance)`（两行字幕 + 底板内边距 + 控制栏 + 12px 注音余量），
   `open()` 里把它交给 `requestWindow`。
7. 两条冒烟用例锁住这两件事。

## 不做什么

- **不改字号跟随窗口缩放**：用户明确选择「窗口可自由拉伸，字号不变」。`fontSizeOf()`
  仍按官方档位算固定 px，`字号不许跟浮窗尺寸走` 这条既有断言**原样保留**（本次改动
  用的全是固定 px，没有 `clamp()` / `vw`，所以那条断言不受影响）。
- **不加任何 `resizeTo`**：开窗那一刻按外观算尺寸，之后的尺寸由用户说了算，
  我们不去动系统窗口。
- **宽度不按文本算**：文本长度开窗那一刻还不知道，且它决定换行、换行又反过来决定高度 ——
  所以宽度取一个紧凑的经验值（700），长句由 `#stage` 居中承载。
- 不把控制栏改成可换行 / 折叠 / 隐藏按钮（那会改交互，属于另一个需求）。
- 不动 `40-study-panel.js` 的面板拖拽手柄（那是宿主页面里的浮层，与 PiP 窗口无关）。
- 不改 `tools/test/contract.test.mjs`（本轮没有新增对官方产物或平台的依赖）。
- 不碰 PLAN 028（浮窗自己的样式条）的文件与实现 —— 它在同一时段由另一次会话推进。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/027-pip-window-resizable.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - tools/test/contract.test.mjs
  - README.md
  - docs/plans/028-pip-own-appearance.md
```

## 实现方案

1. **能拖小**：一条判据 —— 浮窗内容里任何一环都不该有固有最小尺寸。所以链条上每个
   flex 子项都写 `min-width: 0`，按钮这类「有默认宽度」的控件改成可收缩。
   注释写在 `PIP_BASE_CSS` 顶部，说明这几条是刻意的、别改回去。
2. **默认贴合**：`pipHeight(target)` 是纯函数，输入是已经生效的 `appearance`（样式预设 /
   档位 / 双语），输出 `ceil(控制栏 + #stage 上内边距 + 两行字幕 + 底板内边距 + 余量)`；
   classic 取整块底板的两份内边距，contrast 取逐行的两份 + 行间距。余量 12px 是给注音行的
   （`#line-primary:has(ruby)` 的 line-height 1.7 比 1.3 高约 11px，而开窗那一刻不知道
   当前句有没有注音）。

高度方向仍然只能做到「把外围 padding 压到 8px」：`#bar` 的按钮自身 30px 高 + 两行字幕
是刚性的 —— 字号不变时，窗口拖得比内容还矮就一定会被 `overflow: hidden` 裁掉
（见「遗留」第 2 条）。

## 验证方式

- [x] `make test` —— 新增两条用例：
  - `桌面字幕：窗口能拖小（内容里不许有固有最小尺寸）`
  - `桌面字幕：开窗尺寸贴合内容，不再写死 1000×264`
- [x] `make build`（契约校验 + 注入自检）
- [x] `make check`
- [ ] 浏览器人工确认：**把窗口往小拖，能明显小于 1000×264**；开窗时上下几乎不留黑边、
      按钮不成两行 —— 按用户要求本轮**没有启动浏览器实测**，如实登记为「未验证」

## 预期量级

2 个文件 / +110 −20 行左右（含注释与 2 条新用例）。

> ⚠️ 实测口径：`git diff --stat` 里的数字**不能直接用** —— 同一时段里 PLAN 028 的改动
> 也在 `src/mod/30-desktop-subtitles.js` 与 `tools/test/smoke.test.mjs` 里，两者混在
> 同一份工作区改动里。本 PLAN 贡献的部分见上面的清单；提交时要按 PLAN 拆开。

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交**（工作区里同时有 PLAN 028 的未提交改动，提交需按 PLAN 拆开）
- 验证结果：
  - `make test` → `ℹ tests 123 / pass 123 / fail 0`（含本 PLAN 的 2 条新用例）
  - `make build` → 契约校验 ✓ + 注入自检 ✓
  - `make check` → 通过
- 遗留 / 与预期不符之处：
  1. **浏览器内「能拖到多小」「开窗有多贴合」未验证**：用户要求不再启动浏览器。
     改动去掉的是「由我们代码造成的下限」；浏览器/系统自身的窗口下限（那台机器上
     实测过一次 240×86，但那次数据取错了 target，只能当参考）会一直在。
  2. **窗口拖得比内容矮会被裁**：字号固定不动，`#bar` 30px + 两行字幕是刚性的，
     `overflow: hidden` 会切掉下沿。用户选的正是「字号不变」，这是它的必然代价；
     若以后想要「矮窗口下自动缩字号」，那是另一个 PLAN（会推翻 PLAN 008 的取舍）。
  3. **开窗之后改档位不会重新贴合窗口**：`pipHeight()` 只在 `open()` 那一刻算一次
     （PLAN 028 的样式条让用户在浮窗里就能改字号）。档位调大而窗口没跟着长时，
     字会被裁 —— 用户把窗口拖一下即可，这也正是第 1 条需求的意义所在。
     要做「改档位自动跟着 resize」得引入 `resizeTo`，本轮明确不做（见「不做什么」）。
