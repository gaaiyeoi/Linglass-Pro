# 012 学习面板改为寄生在 YouTube 的推荐列里（不再遮挡推荐栏）

> 状态：**已实现，未提交**（Node 侧门禁全绿；Arc 实测被并行写入阻塞，见「完成情况」）

## 需求

用户反馈：面板会遮挡 YouTube 的内容 —— 点名「推荐栏」。

参考实现（PLAN 005 里已记录的实测事实）：**EnglishXYZ 2.2.5 把侧栏插进
`#columns #secondary` 的第一个子节点**（`#yf-sidepanel-shadow`，Shadow DOM），
挂在 YouTube 自己的两列栅格里 —— 宽度由 YouTube 自己算，所以它什么都盖不住。

本轮决定**改走这条路**（推翻了 PLAN 005 里「不插进 #secondary」的取舍）：
失去「全高 + 拖拽改宽」，换「天然不遮挡、不用自己维护让位规则」。

## 根因（待实测确认）

现有让位规则只有三条（`40-study-panel.js` 的 `LAYOUT_CSS`）：

```css
html[data-llg-panel] ytd-app { padding-right: var(--llg-panel-w) !important; }
html[data-llg-panel] #masthead-container { width: calc(100% - var(--llg-panel-w)) !important; }
html[data-llg-panel] ytd-miniplayer { right: var(--llg-panel-w) !important; }
```

它们只把**容器**收窄。而 `#secondary`（推荐列）的宽度是 YouTube 自己定的固定值（约 402px，
不跟着容器缩）—— 容器收窄到塞不下两列时，推荐列要么被挤出容器溢出到右边缘、要么被挤走，
**两种都会落在面板底下**。

证据缺口（这就是为什么本轮第一步是实测）：PLAN 005 的实测**只量了 `<video>` 的 clearance**
（默认视图 −52 → +91），从来没量过 `#secondary`。而 probe 的 `LAYOUT_PROBE` 其实已经 dump 了
`layout.secondary` 的矩形（`tools/probe.mjs:392`），只是没有被打印出来、也从没被比对过。

## 做什么

1. **先把探针的量测补全**：`tools/probe.mjs` 输出「面板矩形 vs 页面内容」的量化结果 ——
   与 `#columns` / `#secondary` / `#masthead-container` / `#movie_player` 各自是否相交，
   以及它们与面板之间的像素关系（复用现有 `clearance` 的写法）。默认 / 剧场 / 全屏三态各打一次。
2. **用 `--browser=arc` 实测现状**，把数据回写本 PLAN（这是"遮挡推荐栏"的直接证据）。
3. **改挂载点**：面板 host 插进 `#columns #secondary` 的第一个子节点；
   - SPA 换页 / YouTube 重建列时要重新挂载（EnglishXYZ 的做法是找不到 `#secondary` 时每 500ms 重试，
     我们复用现成的 1s 心跳即可，但要写清重试次数上限）；
   - 面板由 `position: fixed; height: 100vh` 改为「跟随列宽的块」（高度自适应，必要时上限）；
   - 宽度跟随列宽，**去掉拖拽改宽**（`.resize` 与 `setupResize()` 一起删）。
4. **删掉让位机制**：`data-llg-panel` 标记、`--llg-panel-w` 变量、`LAYOUT_CSS` + `injectLayoutStyle()`、
   宽度脉冲 `nudgeVideosLayout()` / `cancelNudges()`、全屏自动收起（`syncFullscreen` 的存在理由是
   "fixed 面板会压在视频上"，列布局下 YouTube 全屏本来就不显示列）、
   `LAYOUT_STYLE_ID` 在 `00-shared.js` `STALE_IDS` 里的登记。
5. **非 watch 页的挂载点**（首页 / 搜索页没有 `#columns #secondary`）：
   本轮不猜 —— 实测首布页的 DOM 后再定，候选是「挂 `#content`」或「该页面退回 fixed +
   保留一条最小让位规则」。两种都会把结论写回本 PLAN。

## 不做什么

- 不改面板的视觉令牌、结构与交互（玻璃令牌、列表、导出、toast、清空照旧），
  也不改它的宽度上下限常量之外的观感。
- 不改 `30-desktop-subtitles.js`（浮窗与面板挂载点无关）。
- 不做 MAIN world 注入、不碰 `vendor/`、不改 `build.mjs` 与 manifest 生成。
- 不改 `50-settings-panel.js`（设置面板里的功能行与操作行原样）。
- 不引入任何依赖（含 devDependencies）。
- **不与 PLAN 011 混做**：进度填充的观感改动属于 011，本轮只碰挂载点与让位机制。

## 修改范围

```yaml
allowed_paths:
  - src/mod/40-study-panel.js
  - src/mod/00-shared.js
  - tools/probe.mjs
  - tools/test/smoke.test.mjs
  - tools/test/contract.test.mjs
  - docs/plans/012-study-panel-into-secondary.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
```

> `00-shared.js` 只允许删/改 `STALE_IDS` 里的 `LAYOUT_STYLE_ID` 一条，不动按钮工厂与功能注册表。

## 实现方案

1. probe：把 `LAYOUT_PROBE` 的结果按行打印（含 `secondary` / `columns` / `masthead` 的左右边界
   与"是否与面板相交"），并在三态对比里一起输出。
2. `--browser=arc` 跑一次，数据回写本 PLAN 的「实测结论」。
3. `40-study-panel.js`：
   - 新增 `mountPanel()`：`#columns #secondary` 存在就 `prepend`，否则（非 watch 页）按步骤 5 的结论处理；
   - `:host { all: initial }` 要调整 —— `all: initial` 会把宿主重置成 `display: inline`，
     插进列里必须显式给定 `display: block; position: static`（这类坑要写进注释）；
   - 删掉 `.resize` / `setupResize()` / `state.width` 的落盘（`llgStudyPanel` 只留 `open`；
     旧记录里的 `width` 字段忽略即可，不做迁移）；
   - 删掉让位相关的全部代码与常量（见「做什么」第 4 条）。
4. 测试口径要跟着改（**必须写明理由**，AGENTS §3）：
   - `smoke.test.mjs` 里「打开时给页面让位」「宽度脉冲」等断言固化了**旧语义（fixed + 让位）**，
     本轮实现不再有这些行为，所以断言要改成新语义：打开后 host 是 `#secondary` 的第一个子节点、
     `<html>` 上没有 `data-llg-panel`、没有注入任何页面级 `<style>`；
   - `contract.test.mjs` 的 `PLATFORM_CONTRACT` 要登记新依赖（`#columns`、`#secondary`，
     以及 YouTube 重建列时的恢复路径），旧的让位相关登记清理掉。
5. 全屏行为：列布局下面板随 YouTube 的列一起被隐藏，所以删掉我们的 `syncFullscreen()`；
   若实测发现全屏下 `#secondary` 仍可见而面板跟着出现，则在 PLAN 里登记并按实测补一条规则。

## 验证方式

- [ ] `make test`（说明改了哪几条既有断言、为什么）
- [ ] `make build` + `make check`
- [ ] `node tools/probe.mjs --browser=arc --headed --keep`：默认 / 剧场 / 全屏三态下
      **面板矩形与 `#columns` 之外的内容都不相交**，且 `#secondary` 完整可见（`secondary.right` 不被面板压住）
- [ ] 首页 / 搜索页人工确认：面板仍在且不遮挡（按步骤 5 的结论）
- [ ] 浏览器人工确认：换视频（SPA 导航）后面板自动回到新页面的列里

## 预期量级

6 个文件 / +200 −230 行（净减少：删掉的让位机制画掉的比补上的多）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交**。
- 实测结论（`--browser=arc --headed`，**你本机 Arc 的真实窗口** viewport 1549×1100，
  面板宽度 448px）：

  ```text
  [probe] 布局：面板压住了谁（现状）  viewport=1549×1100 panel=[1101..1549] (448px)
  [probe]   #movie_player  [0..1101] overlap=false clearance=0
  [probe]   #columns       [0..1101] overlap=false clearance=0
  [probe]   #secondary     [825..1161] overlap=true  clearance=-60
  [probe]   #masthead      [0..1101] overlap=false clearance=0
  ```

  **「推荐栏被遮挡」成立**：容器确实让开了（`#columns` 右边缘 1101 = 面板左边缘），
  但推荐列自己宽 336px、右边缘到 1161，从容器里溢出 60px，正好落在面板底下。
  这就是「只压容器宽度」这条路修不掉的部分 —— 也是本次改挂载点的直接理由。

- 实现（与 PLAN 的出入都记在下面）：
  - `syncMount()`：每次心跳 + `yt-navigate-finish` 决定形态 —— 有 `#columns #secondary`
    就 `prepend` 进列里（`data-mode=column`），否则退回悬浮（`data-mode=float`）；
    判据是「父节点还是不是同一个元素、宿主还在不在文档里」，因为 YouTube 换视频时会把整列重建。
  - 列形态：不注入让位样式、不写 `--llg-panel-w`、不写内联宽度（内联会盖住 CSS 的
    `width:100%`，会让面板 400px 宽地卡在列里）、不做全屏收起（整列都由 YouTube 收）；
    收开用 `display` 而不是 `translateX`（列里滑出会把页面顶宽）。
  - 面板高度：`62vh`，下限 320px、上限 640px。
- 与 PLAN 不符之处（三处，都是有意的）：
  1. **没有删掉整条让位机制**。首页/搜索页没有 `#columns #secondary`，面板在那里只能悬浮，
     仍然需要让位（那套规则在非播放页是实测有效的）。所以保留让位，只在 column 形态禁用。
     代价是双形态的状态空间；收益是不丢功能、不引入「首页看不到面板」这类回归。
  2. 面板高度 62vh / 320–640px 是**推理值，没有在浏览器里人工确认过观感**。
  3. 契约表新增 `#columns #secondary`（AGENTS §3 要求新依赖必须登记）；
     `00-shared.js` 的 `STALE_IDS` 不用动（宿主 id 没换、也没多出会残留的页面级 DOM）。
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 59   ℹ pass 59   ℹ fail 0
  $ make build   → 契约校验 ✓ / 注入自检 ✓
  $ make check   → ✓
  ```

  新增用例（3 条，均为新行为的冒烟测试）：
  `学习面板：watch 页寄生在推荐列里，不遮挡也不再让位`、
  `学习面板：没有推荐列（首页/搜索页）时退回悬浮 + 让位`、
  `学习面板：推荐列被 YouTube 重建后，心跳把宿主挂回新列`。

- 遗留 / 与预期不符之处：
  1. **Arc 实测（改完之后）没跑成**：`tools/probe.mjs` 在同一时间被另一个会话改写，
     当前**语法错误**（`layoutCompareProbe` 的模板字符串里，新加的 `boxes()` 用了未转义的
     反引号 → `SyntaxError: Unexpected identifier '$'`，`node --check` 直接退出 1），
     所以 `make probe` 现在完全跑不起来。另外 `measure()` 里出现了**重复的 `secondary:` 键**
     （我加的一份 + 对方加的一份），说明两个写入方确实在改同一个函数。
  2. 面板寄生进列里之后，「不遮挡」这件事的正确判据变了：面板与 `#secondary` 相交是**预期的**
     （它就在列里面）。所以探针的 `printPanelVsPage` 补了 `inside=` 一列；改完之后的验收标准是
     「面板被 `#secondary` 完全包含 → 它盖不住列以外的任何东西」，而不是「与谁都不相交」。
  3. 非 watch 页的挂载点：按上面第 1 条保留了悬浮形态，**没有**改挂 `#content`。
