# 013 侧栏「回到当前句」：滚开之后能一键回到正在播放的句子

> 状态：**已实现**（Node 侧门禁全绿；浏览器内行为待人工确认 —— 本项目约定不自动起实体浏览器）

## 需求

用户实测反馈（Arc，配合 PLAN 012 的整条轨）：

> 整条字幕都展示了，但是滚动后很难定位到正在播放的位置。

## 根因（Bug Fix 必填）

不是渲染问题，是**入口缺失**：

- 列表默认跟随播放位置：`highlight()` 在 `follow` 为真时对当前行 `scrollIntoView`；
- 用户一旦用滚轮滚开，`follow` 就被置为 false —— 这是对的，不关的话他根本看不了后面的句子；
- 但把 `follow` 重新打开的**唯一**入口是「点某一行」（`makeRow` 的 click），
  而那恰恰要求用户**先自己找到**当前句。于是形成了闭环：想回去 ← 得先能找到。

证据（源码，改动前）：`follow` 全仓只有三处赋值 —— 初始 `true`、`els.list` 的 wheel → `false`、
`makeRow` 的 click → `true`；面板里没有任何「回到当前句」的控件。

## 做什么

- 面板头部加「回到当前句」按钮：跟随被关掉时出现，点击后滚到当前句（**居中**）并恢复跟随
- 没有当前句时给一句 toast，不静默失败
- 按钮状态跟着 `follow` 走，且先比对再写（幂等，见 §3 血泪规矩 1）
- 把跟随开关收敛成一个入口 `setFollow()`，三个赋值点都改走它

## 不做什么

- 不做跟随开关的持久化：这是会话内的临时状态，刷新后默认跟随才是对的
- 不做键盘快捷键（`J` / `↓` 之类）—— 没有需求，还要避开 YouTube 自己的快捷键
- 不改日常跟随的滚动策略（仍然 `nearest`，不打断阅读）；只有按按钮那一下用 `center`
- 不碰挂载形态（column / float）与让位逻辑 —— 那是 PLAN 005 / 012 的范围

## 修改范围

```yaml
allowed_paths:
  - src/mod/40-study-panel.js
  - tools/test/smoke.test.mjs
  - docs/plans/013-study-panel-back-to-current.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - tools/probe.mjs
```

## 实现方案

1. `PANEL_HTML` 的 `.head` 里加
   `<button class="follow" data-role="follow" data-act="follow" data-state="off">回到当前句</button>`
   （放在标题与关闭按钮之间；`data-act` 走既有的点击委托）
2. `PANEL_CSS` 加 `.follow`（小药丸，列形态下面板不宽）与 `.follow[data-state="off"] { display: none }`
3. JS：
   - `setFollow(value)`：唯一改 `follow` 的地方，变了才 `syncFollowButton()`
   - `syncFollowButton()`：`follow` 为真 → 按钮 `data-state=off`（藏起来）；反之 `on`
   - `onFollow()`：`setFollow(true)` → 取 `track.getCurrent()` → 没有就 toast →
     否则 `activeIndex = -1` 强制重画并 `highlight(index, { center: true })`
   - `highlight(index, { center })`：`center || follow` 才滚，`block` 取 `center` / `nearest`
   - 委托里加 `else if (act === 'follow') onFollow();`
   - `buildPanel()` 的角色表里加 `follow`，建完调用一次 `syncFollowButton()`

## 验证方式

- [ ] `make test`（新用例名：「学习面板：滚开之后能一键回到当前句」）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（**由用户手动做**）：滚到列表中段 → 头部出现「回到当前句」→
      点一下 → 列表滚回当前句并居中、按钮收起

## 预期量级

3 个文件 / +100 −10 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（等用户在 Arc 里确认观感）
- 验证结果（贴实际输出）：
  - `node --test tools/test/*.test.mjs`

    ```text
    ✔ 学习面板：滚开之后能一键回到当前句 (0.900625ms)
    ℹ tests 60
    ℹ pass 60
    ℹ fail 0
    ```

  - `make build` → `[build] 契约校验 ✓` + 注入自检通过（7 个 mod 脚本按序注入）
  - `make check` → 通过（dist/ 已正确注入）
  - `git diff --stat` → 2 个文件 / +150 −12（预期 +100 −10；多出来的 40 行是冒烟测试的
    桩件：`makeStubNode` 现在记录监听器与 `scrollIntoView` 参数、并把 DocumentFragment
    摊平 —— 不摊平的话 `els.list.children[index]` 在测试里拿到的是 fragment，
    `highlight()` 与「回到当前句」就完全测不到）
- 遗留 / 与预期不符之处：
  - 本用例**没有**覆盖真实滚动观感（Node 侧只能断言 `scrollIntoView` 的参数），必须人工确认
  - `follow` 只在**滚轮**时被关掉；如果用户是拖滚动条（`scroll` 事件而不是 `wheel`），
    按钮不出现 —— 此时仍在跟随，行为自洽，先记为已知边界
  - 按 §2 核对：只改了 `allowed_paths` 里的三个文件，`vendor/` / `dist/` 未动
    （`git status --short` 只有这两个改动文件 + 本 PLAN）
