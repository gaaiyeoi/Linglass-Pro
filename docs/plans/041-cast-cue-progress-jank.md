# 041 手机字幕屏：句内进度掉帧（底板模糊把动画拖进重栅格化）

> 状态：**待执行**

## 需求

用户反馈：真机 + 真视频（`make cast`）时，**文字背后的蓝色句内进度卡顿**；
同页底部那条整片进度条是顺的。

## 根因

两条进度条用的是**同一套机制**（`paintProgress()` 里每帧写 `transform: scaleX()`，
`will-change: transform`），推送频率也一样。唯一的结构差别：

| | 所在位置 | 祖先是否有 `backdrop-filter` |
|---|---|---|
| 底部整片进度 `#progress-fill` | `#stage` 之外，独立 fixed 元素 | 无 |
| 句内进度 `.kfill` | `#plate` 内部 | **有**（classic 底板，`blur(8px)`） |

`tools/cast-page.mjs` 的 `plateCss()` 照抄了浮窗的 classic 底板，带了
`-webkit-backdrop-filter: blur(8px)`。但手机屏幕的背景是**纯色** `#141518`：
模糊一层纯色在视觉上等于什么都没做（像素完全一致），代价却是 iOS Safari 会把
带 `backdrop-filter` 的子树排除在独立合成层之外 —— 内部元素的 `transform` 动画
不能只走合成器，**每帧都要把整块底板（文字 + 阴影 + 模糊）重新栅格化**。

这正好解释了「底部条顺、句内卡」：同样的 rAF + `scaleX`，一个在不透明层上，
一个在模糊层内部。也排除了「推送频率 / 本地时钟插值」这条线（否则两条都会卡）。

> 未实测的部分：没有在真机上跑 Safari Timeline 采样，因此「模糊层导致重栅格化」
> 是从代码结构与两条进度条的差异推出来的，不是采样结论。改完后仍需真机确认。

## 做什么

- `tools/cast-page.mjs`：classic 底板的 CSS 去掉 `backdrop-filter`（保留同一条
  渐变底色，画面上看不出差别），并在注释里写明「纯色背景上模糊无视觉效果，
  却会让 `.kfill` 掉帧，别再抄回来」。
- 新增 `tools/test/cast-page.test.mjs`：把这条结论钉成回归测试 ——
  `renderPage()` 的输出里**不允许出现** `backdrop-filter`；
  同时断言 `.kfill` / `#progress-fill` 仍走 `transform: scaleX()`（防止有人改回 `width`）。

## 不做什么

- 不改桌面浮窗（`30-desktop-subtitles.js`）：它的底板底下是视频画面，模糊有实际作用，
  与手机屏不是同一件事。
- 不改推送频率、`syncClocks()` / `paintProgress()` 的插值算法 —— 本轮不动逻辑。
- 不改配色、字号、布局、设置面板。
- 不动 `src/mod/**`、`vendor/`、`dist/`。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/041-cast-cue-progress-jank.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
  - tools/cast-server.mjs
  - tools/probe.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. `plateCss()` 的 `block` 分支删掉那两行 `backdrop-filter`。
2. 新增测试：

   ```js
   import { renderPage } from '../cast-page.mjs';
   test('手机接收页：底板不带 backdrop-filter（纯色背景上只会拖慢句内进度）', () => {
     const html = renderPage('demo', null);
     assert.ok(!html.includes('backdrop-filter'));
   });
   test('两条进度仍用 transform 驱动（不会触发布局）', () => {
     const html = renderPage('demo', null);
     assert.ok(html.includes('transform: scaleX(0)'));
     assert.ok(html.indexOf('scaleX(0)') >= 0);
   });
   ```

## 验证方式

- [ ] `make test`（新文件会被 `node --test tools/test/*.test.mjs` 自动带上）
- [ ] `make build` + `make check`（本轮不动内容脚本，用于确认没误伤）
- [ ] 真机确认（未做就如实写）：横屏播放，句内蓝底平滑推进；底部条仍顺滑

## 预期量级

3 个文件 / +60 −6 行（PLAN 与测试占大头）。

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里还有手机字幕屏本身的未提交改动）。
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 172   ℹ pass 172   ℹ fail 0

  $ make build
  [build] 版本      1.12.900
  [build] 产物      dist/

  $ make check
  版本    1.12.900
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  回归确认：把 `backdrop-filter: blur(8px)` 临时加回 `plateCss()` →
  `手机接收页：底板不带 backdrop-filter` 恰好 1 例变红；去掉后全绿。

- 遗留 / 与预期不符之处：
  1. **真机未验证**：本轮的根因是「结构差异 + 两条进度条的对照」推出来的，
     没有 Safari Timeline 采样。若改完仍顿，下一步应当采样确认（而不是继续猜）。
  2. 需要**重启 `make cast`** 才会拿到新页面（`renderPage()` 每次请求现生成，
     但进程里跑的是旧模块）。
  3. 一个 30 秒的 A/B 自检：在手机设置面板把外观切到「影院」（无底板、无模糊），
     若句内进度立刻变顺，就说明这条假设成立；切回「经典」应该仍然顺（本轮已去模糊）。

