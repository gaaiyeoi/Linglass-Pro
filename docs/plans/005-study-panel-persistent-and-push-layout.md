# 005 学习面板：常驻 + 让出视频位置（不遮挡播放器）

> 状态：**待执行**

## 需求

两个问题：

1. **不常驻**：面板的开关只活在内存里 —— 刷新页面、`make dev` 重载扩展、重开标签页之后它就没了，
   用户每次都要再点一次。
2. **遮挡视频**：面板是 `position: fixed; right: 0; height: 100vh`，直接压在页面上。
   默认视图下它盖住右侧推荐列的一部分，剧场/大屏视图下会盖住视频本体。

参考实现（EnglishXYZ 2.2.5，实测其产物）：

- 它的侧栏是插进 **`#columns #secondary` 的第一个子节点**（`#yf-sidepanel-shadow`，Shadow DOM），
  挂在 YouTube 自己的两列栅格里 —— 所以视频那块自然不被盖住，宽度由 YouTube 自己算。
- 它的常驻靠「注入一次就记住」（`Dt.youtubeSidepanel` 标志 + 找不到 `#secondary` 时每 500ms 重试）。

我们**不照抄「插进 `#secondary`」**：我们的面板是带拖拽改宽的全高面板，插进推荐列会变成
跟随页面滚动的一段内容，剧场模式下还会跑到视频下方（要滚屏才看得到）。本轮改成
「面板仍是 fixed 全高 + 打开时给页面让出右侧宽度」。

## 做什么

- **常驻**：`llgStudyPanel` 落盘里加 `open`（沿用现有的宽度落盘），加载时恢复；
  `yt-navigate-finish`（换视频）不改变开关状态；扩展重载后能自己回来。
- **让位**：面板打开时
  - 给 `<html>` 打上 `data-llg-panel="open"`；
  - 把面板宽度写进 `--llg-panel-w`（拖拽改宽时同步更新）；
  - 往 `document.head` 注入一段**页面级**样式（`#llg-panel-layout-styles`，只注册一次），
    规则把播放器所在的这块内容整体让出 `var(--llg-panel-w)`（具体选择器与取值按实测确定，
    实测结论写进本 PLAN 的「完成情况」）。
- **全屏时让位**：视频全屏（`document.fullscreenElement` 非空，或
  `ytd-watch-flexy[fullscreen]`）时面板自动收起（`translateX(100%)`），退出全屏恢复原状态；
  全屏判定同时监听 `fullscreenchange` 与既有的 1s 心跳。
- **探针**：`tools/probe.mjs` 增加布局探针 —— 面板 `left/width`、视频 `rect`、
  两者是否重叠、`html` 上的标记与 CSS 变量值。这是「不遮挡视频」唯一可自动化的验收手段。
- **契约登记**：新增的官方 DOM 依赖（页面级让位选择器涉及的节点）登记进
  `tools/test/contract.test.mjs` 的 `PLATFORM_CONTRACT`；新增的样式 id 登记进
  `00-shared.js` 的 `STALE_IDS`（扩展重载后的僵尸 `<style>` 必须清掉，否则旧规则会残留）。

## 不做什么

- 不改面板的视觉与结构：玻璃令牌、行布局、导出、toast、拖拽改宽的手感都不动
- 不把面板插进 `#secondary`（即不采用 EnglishXYZ 的那种挂载点）
- 不做 MAIN world 注入、不碰 `vendor/`、不改 `build.mjs` 与 manifest 生成
- 不改 `50-settings-panel.js`（设置面板里的功能行与操作行原样）
- 不改 `30-desktop-subtitles.js`（浮窗与面板的让位无关）
- 不做「拖拽过程中的布局节流优化」：YouTube 自己有 ResizeObserver，先按最朴素的写法做

## 修改范围

```yaml
allowed_paths:
  - src/mod/40-study-panel.js
  - src/mod/00-shared.js
  - tools/probe.mjs
  - tools/test/contract.test.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/005-study-panel-persistent-and-push-layout.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
```

> `00-shared.js` 只允许加一条 `STALE_IDS`（僵尸样式清理），不动按钮工厂与功能注册表。

## 实现方案

1. `state` 增加 `saved.open`；`setOpen()` 里落盘（宽度与 open 合并成一个对象写完）。
2. `applyLayout()`：写 `data-llg-panel`、`--llg-panel-w`；`injectLayoutStyle()` 幂等注入样式。
3. 让位 CSS：按实测（probe 的布局探针）选定让位节点 —— 目标是在**默认视图与剧场视图**下
   视频矩形都不与面板矩形相交；实测记录写回本 PLAN。
4. 全屏判定 `isFullscreen()` + `syncFullscreen()`，在心跳与 `fullscreenchange` 上跑。
5. `setupResize()` 的 `onMove` 里同步 `--llg-panel-w`（拖动时实时让位）。
6. probe 增加 `LAYOUT_PROBE`，并在实测步骤里输出。
7. 冒烟测试：
   - 落盘里 `open:true` 时加载即打开（并注入样式、带上 `data-llg-panel`）；
   - `open:false`/无记录时不自动打开；
   - 关闭后标记与样式被撤掉；
   - 契约测试新增的选择器登记完备。

## 验证方式

- [ ] `make test`（新增用例名：「学习面板：开关落盘并在加载时恢复」「学习面板：打开时给页面让位」）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed`）：默认视图与剧场视图下
      视频矩形与面板矩形**不相交**；拖宽后面板变宽、视频同步变窄；全屏时面板消失

## 预期量级

5 个文件 / +180 −25 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：
- 验证结果（贴实际输出）：
- 实测结论（让位选择器与取值、默认/剧场/全屏三种情况）：
- 遗留 / 与预期不符之处：
