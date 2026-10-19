# 039 桌面字幕浮窗：默认开启，进视频页点一下（或点封面）就出现

> 状态：**已撤回**（被 PLAN 040 推翻：用户要求「手动点击才弹出」，默认值与封面预开都已回滚）
>
> 本文保留根因与验证记录，仅作历史参考。

## 需求

用户反馈：**浮窗必须点控制栏的「桌面字幕」按钮才会打开**，期望「进视频页就自动出现」。

已确认的口径（用户选定）：

1. 纯自动弹（一次手势都没有）受 Document PiP 规范限制，做不到 ——
   `requestWindow()` 必须发生在**瞬时用户激活**内（PLAN 019 / PLAN 032 已论证）；
2. 折中目标：**进播放页后点一下任意处（不必点按钮）就出现**；
3. 更进一步：从首页 / 搜索页**点视频封面**的那一下也算 —— 这是最常见的入口，
   做到它，用户就不会再感到「还要额外点一下」。

## 根因

PLAN 025 把 `enabled` 的默认值从 `true` 改成了 `false`（「视频内嵌字幕优先」）。
于是**从没点过开关的人**，`arm()`（「下一次手势就开」）根本不会被挂上：

```js
// 30-desktop-subtitles.js
function arm() {
  if (armed || !enabled || !supported() || syncWindow()) return;
  ...
}
```

没有 `arm` 就没有任何自动路径，只能靠控制栏按钮的 `onClick` 调 `open()` ——
这正是用户看到的现象。**这不是新 bug，是 025 有意改的默认值。**

第二个问题在 `arm()` 的判据上：从首页点封面时 `pointerdown` 先于 SPA 导航发生，
那一刻 `canAutoOpen()` 里的 `playerVideo()` 还是空 —— 代码的做法是「重新武装，
等下一次手势」。用户于是又要点第二下。

## 做什么

- **`enabled` 默认值改回 `true`**（推翻 PLAN 025 的默认值；落盘里 `enabled: false`
  的人照旧是关的，不受影响）。
- `arm()` 的预开判据补一条：这次手势落在**通往播放页的链接**上
  （`a[href^="/watch"]` / `a[href^="/live/"]`）时也 `open()`。
  YouTube 是 SPA，导航不销毁文档，窗口会保留到导航完成、轨道就绪后自动填充内容。
  带修饰键（meta/ctrl/shift/alt）或中键的手势不预开 —— 那是「后台开新标签」，
  首页不会导航，预开只会在首页留下一个空窗口。
- 文案同步：设置面板 `desc`、README 的默认值一栏与浮窗小节。
- 测试：
  - 把 `桌面字幕：默认关闭（视频内嵌字幕优先），没开过就不弹窗` 改写为
    `桌面字幕：默认开启，进播放页后第一次手势就开窗`（旧断言固化的是 025 的默认值，
    本轮需求就是改掉它）；
  - 新增 `桌面字幕：从首页点视频封面就预开，不用再点第二下`；
  - 新增 `桌面字幕：带修饰键点封面不预开（那是后台开新标签）`。

## 不做什么

- 不尝试「零手势自动弹窗」（规范做不到，只在回答里如实说明）。
- 不改窗口消失后的常驻恢复语义（PLAN 016 / 019 / 022 不变）。
- 不改浮窗视觉、控制栏按钮集合、进度条、注音、上下文行。
- 不改 `src/mod/` 其它文件，不动 `vendor/` 与 `dist/`。
- 不把默认值改回 `true` 这件事写进 025（那是历史记录，保持原样，改动写在本 PLAN）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - tools/test/contract.test.mjs
  - README.md
  - docs/plans/039-pip-default-on-and-open-from-cover-click.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/05-ja-segment.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/35-cast.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

## 实现方案

1. `let enabled = false` → `let enabled = true`，注释改成「默认开启，等第一次手势
   （规范和用户激活的限制）」。
2. 新增常量与判据：

   ```js
   const WATCH_LINK = 'a[href^="/watch"], a[href^="/live/"]';

   function opensWatch(ev) {
     if (!ev || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button === 1) {
       return false;
     }
     const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [ev.target];
     return path.some((node) => node && node.nodeType === 1
       && typeof node.closest === 'function' && !!node.closest(WATCH_LINK));
   }
   ```

3. `arm()` 的回调：

   ```js
   disarm();
   if (canAutoOpen() || opensWatch(ev)) {
     open();
     return;
   }
   arm();
   ```

4. `tools/test/contract.test.mjs`：平台契约表登记 `a[href^="/watch"]` 与
   `a[href^="/live/"]`（YouTube DOM 依赖；漏登记检测只扫 `.` / `#` 前缀，扫不到它们，
   所以手工登记）。
5. 测试桩：`h.gesture(type, ev)` 已支持传 `ev`，用例里手工构造带 `closest()` 的锚点节点。

## 验证方式

- [ ] `make test`
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（未做就如实写）：
      从 YouTube 首页点封面进 watch 页，浮窗在导航后出现，不需要再点；
      直接刷新 watch 页时，点一下页面任意处浮窗出现（刷新本身无手势）。

## 预期量级

5 个文件 / +90 −30 行（PLAN 与测试占一半）。

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里还有 PLAN 032~038 的未提交改动，按「一个 PLAN = 一个提交」
  需要人先决定怎么收尾）。
- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 170
  # pass 170
  # fail 0

  $ make build
  [build] 基线      vendor/linglass-1.12.4
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js
  [build] 版本      1.12.900

  $ make check
  版本    1.12.900
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  回归确认（先红后绿）：
  1. `let enabled = false` → 新增的 3 条用例全红（默认值与「封面预开」都失去前提）；
  2. 把 `canAutoOpen() || opensWatch(ev)` 改回 `canAutoOpen()` →
     `从首页点视频封面就预开` 恰好 1 例变红，其余全绿。

- 遗留 / 与预期不符之处：
  1. **浏览器内未验证**：Arc / Chrome 里「从首页点封面 → 导航完成后浮窗在且有字幕」
     尚未人工确认。SPA 导航期间窗口内容会是空的（几百毫秒到几秒），属预期。
  2. 落盘里 `enabled: false` 的用户（曾经显式关过）**不会**被这次默认值改动影响 ——
     按「用户显式关过就该尊重」，需要再点一次按钮把自己加回来。
  3. 直接打开 / 刷新 watch 页时没有任何用户手势，规范上无法自动弹，仍需点一下。

