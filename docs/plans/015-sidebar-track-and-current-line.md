# 015 侧栏字幕列表：看全、找回、当前句沉底

> 状态：**已实现**（Node 侧门禁全绿；浏览器内行为待人工确认 —— 本项目约定不自动起实体浏览器）

## 需求

用户实测反馈（Arc，一次给出三条，都是同一个界面区域）：

> 1. 侧边栏没有显示所有字幕；
> 2. 滚动之后没有办法快速回到正在播放的位置；
> 3. 正在说的那句话应该放在侧边栏底部，这样能和原生字幕一样高度。

三条同属「侧栏字幕列表」这一处体验，故合并为一个 PLAN（分三个 PLAN 会各改同一文件、
互相冲突）。但三条的边界与验收各自独立，逐条对照。

## 根因

### 第 1 条：列表看不到整条轨 —— 骨架读取的空结果短路（Bug）

PLAN 006 已实现「骨架」：面板列表的句子来自官方缓存的整条原文轨
（`chrome.storage.local` 的 `subtitle-cache:v6:{videoId}:{lang}:primary`）。
但 `10-subtitle-track.js` 的 `maybeLoadSkeleton()` 有一段短路逻辑：

```js
if (!skeleton.keys) {
  skeleton.tries += 1;
  skeleton.keys = await listSkeletonKeys(videoId);
  if (!skeleton.keys.length) { ... return; }
}
```

`listSkeletonKeys()` 返回的是**过滤后**的候选（只保留当前 videoId 的 `:primary` 条目）。
用户在本次会话之前看过别的视频时，索引 `subtitle-cache:index` 非空、但**当前视频的条目
可能还没写进去**（官方是在拿到整条轨之后才 `chrome.storage.local.set`，晚于扩展加载与
面板打开）。此时：

- 第 1 次调用：`skeleton.keys = []`（空数组），`tries = 1 < 4`，直接 return；
- 第 2 次调用：`!skeleton.keys` 为 **false**（`[]` 是 truthy）→ 跳过重新列索引 →
  `while (skeleton.next < 0)` 不执行 → `skeleton.done = true`。

**从此永远不再读骨架**，列表只剩「播放过的句子」——正是用户看到的「没有显示所有字幕」。

证据（源码，改动前）：`skeleton.keys` 只在 `maybeLoadSkeleton()` 里被赋值两处，
其中一处就是 `await listSkeletonKeys(...)`（可能是空数组），而没有「空结果不落账」的处理。

### 第 2 条：滚开之后回不去

PLAN 013 加了「回到当前句」，但它挂在两处**错误的时机/位置**上：

- 显隐只由 `follow` 驱动，而 `follow` 只在 **`wheel`** 事件里被关掉。
  用触控板/鼠标**拖滚动条**（只发 `scroll`，不发 `wheel`）时 `follow` 仍是 true，
  按钮不出现 —— 013 的 PLAN 已把这条如实登记为「已知边界」，用户这次撞上的就是它；
- 按钮挤在 `.head` 里（与标题、关闭按钮同行），列形态下面板只有几百像素宽，
  它被标题 `-webkit-line-clamp: 2` 的文本挤到不显眼的位置。

### 第 3 条：当前句的位置

`.stage`（大字号双语当前句）目前在标题下方、列表上方。原生字幕在**视频底部**，
眼睛要在「画面底部」与「面板顶部」之间来回跳。

## 做什么

- **（第 1 条）** `maybeLoadSkeleton()` 里空结果**不落账**：`skeleton.keys` 只在候选非空时赋值，
  空结果只累加 `tries` 并等待下一次尝试；
- **（第 1 条）** 骨架重试改由**心跳**驱动（1s 一次，不再由逐词高亮频繁触发），
  上限从 4 次提到 60 次（≈ 官方写缓存后 1 分钟内必然能读到）；
- **（第 2 条）** 「回到当前句」改成**悬浮在列表右下角**的胶囊按钮（不再占 header）；
- **（第 2 条）** 列表的 `scroll` 事件也算「用户滚开了」：当前行不在列表可视区内时停止跟随、
  按钮出现（覆盖拖滚动条 / 触控板 / `wheel` 三种方式）；
- **（第 3 条）** `PANEL_HTML` 里把 `.stage` 移到 `.list` 之后、`.foot` 之前（沉底），
  分隔线从 `border-bottom` 改为 `border-top`；
- 三条都补冒烟测试。

## 不做什么

- **不翻译没看过的句子**（README 已声明的边界）：骨架构只提供原文，译文仍然只来自实际播放。
  若用户期望的「所有字幕」是**双语全给**，那不在本 PLAN 范围内（要另立 PLAN 去读官方的
  译文分块缓存，见 006 的「不做什么」）；
- 不改官方 `chrome.storage` 里那批 key（只读，绝不写/删）；
- 不改导出的 Markdown / SRT 格式；
- 不改挂载形态（column / float）与页面让位逻辑；
- 不改桌面字幕浮窗（`30-desktop-subtitles.js`）；
- 不给「回到当前句」加快捷键、不做虚拟滚动、不做骨架之外的第二个数据源；
- 不动 `follow` 的持久化（仍是会话内临时状态）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - src/mod/40-study-panel.js
  - tools/test/smoke.test.mjs
  - docs/plans/015-sidebar-track-and-current-line.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
  - tools/probe.mjs
  - tools/test/contract.test.mjs
  - build.mjs
  - Makefile
  - README.md
```

## 实现方案

1. `10-subtitle-track.js`
   - `SKELETON_MAX_TRIES`：4 → 60；注释改成「心跳驱动，约 1 分钟窗口」；
   - `maybeLoadSkeleton()`：空结果时只 `return`（不写 `skeleton.keys`），非空才赋值；
   - `heartbeat()` 里补一次 `maybeLoadSkeleton().catch(() => {})`；
     `capture()` 里那次调用移除（避免逐词高亮把重试次数刷爆）。
2. `40-study-panel.js`
   - `PANEL_HTML`：`.head` 里删掉 `follow` 按钮；`.list` 外包一层
     `<div class="list-wrap">`，按钮放进 wrap（`data-role="follow"` 不变，点击委托不变）；
     `.stage` 整段移到 `.list-wrap` 之后、`.foot` 之前；
   - `PANEL_CSS`：`.list-wrap` 定位上下文 + flex；`.follow` 改为绝对定位的悬浮胶囊
     （`position: absolute; right: 12px; bottom: 12px`，加阴影）；
     `.stage` 的 `border-bottom` → `border-top`；
   - JS：新增 `activeRowVisible()`（用两个 `getBoundingClientRect` 比对；桩件没有这个方法时
     返回 true，不误关跟随）；`els.list` 增加 `scroll` 监听 → 当前行不可见时 `setFollow(false)`；
   - `highlight()` 保持不动（仍按 `follow` / `center` 决定滚动方式）。
3. `tools/test/smoke.test.mjs`
   - `makeStubNode` 补一个可配置的 `getBoundingClientRect()`（默认全 0，即「可见」，
     不影响既有用例）；
   - 新增：骨架「索引先空、后补上」时仍然能读到整条轨（第 1 条的回归测试，改动前必红）；
   - 新增：拖滚动条（只发 `scroll`）也能让「回到当前句」出现；
   - 新增：`PANEL_HTML` 的结构断言 —— `.stage` 在 `.list` 之后（沉底）。

## 验证方式

- [ ] `make test`（新增用例名：
      「字幕轨道：索引里暂时没有本视频时，官方稍后写入仍能被采用」、
      「学习面板：拖滚动条滚开后同样能一键回到当前句」、
      「学习面板：当前句块排在列表之后（贴在面板底部）」）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（**由用户手动做**）：打开有官方缓存的视频 → 面板一打开就列出整条轨；
      滚动列表（滚轮与拖滚动条各试一次）→ 右下角出现「回到当前句」→ 点一下 → 列表居中回跳；
      当前句块显示在面板底部、与视频原生字幕大致同高

## 预期量级

4 个文件 / +200 −70 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（等用户在 Arc 里确认观感，与 013 一致）
- 为什么改断言（AGENTS.md §3 要求）：`tools/test/smoke.test.mjs` 的
  「字幕轨道：拿不到官方缓存就退回旧行为」原先断言 `索引读取次数 <= 4` —— 它固化的正是
  **旧的（错的）**语义「列索引试 4 次就永久放弃」。改动后语义变成「重试到窗口用完
  （SKELETON_MAX_TRIES 次心跳），但一定有上限」，所以把那一条拆成两条：
  `>= 2`（必须真的重试，不能试一次就放弃）+ `<= 61`（必须有上限，不能跟着心跳无限轮询）。
- 验证结果（贴实际输出）：
  - `make test` → `# tests 65 / # pass 65 / # fail 0`
  - `make build` → `[build] 契约校验 ✓` + 注入自检通过（7 个 mod 脚本按序注入）
  - `make check` → 通过（`dist/` 已正确注入，版本 1.12.900）
  - **回归测试先红后绿**（AGENTS.md §3 的 Bug Fix 要求）：把 `maybeLoadSkeleton()` 临时改回
    旧写法后，新用例「索引里暂时没有本视频时，官方稍后写入仍能被采用」输出
    `AssertionError: 官方稍后补上的骨架必须能被采用（不能永久放弃） 0 !== 3`；
    恢复修复后转绿。
- 遗留 / 与预期不符之处：
  - **本轮的回归测试覆盖不到的是「真机上到底有没有少句」**：Node 侧只能证明「索引先空后补」
    这条路径通了。用户反馈若在真机上仍然看不到整条轨，剩下的可能性只剩两条，都不在本 PLAN
    范围内，需要实测（`node tools/probe.mjs`）：① 官方 24h TTL 把缓存清掉了（README 已声明的
    边界）；② 用户期望的是**译文也全给** —— 那要另立 PLAN 去读官方的译文分块缓存（见 006）。
  - 「当前句沉底」的**观感**（是否真的与原生字幕同高）只能在浏览器里确认；Node 侧只断言了
    `PANEL_HTML` 里 `.stage` 排在 `.list` 之后。
  - `git diff --stat` 核不准本轮量级：工作区里**另有 013（浮窗默认开启、侧栏回到当前句）与
    014（浮窗振假名）两轮未提交的改动**（`git status` 里的 `30-desktop-subtitles.js` 不是本轮改的）。
    本轮实际只动三处：`10-subtitle-track.js`（骨架重试）、`40-study-panel.js`（按钮悬浮 + 当前句沉底）、
    `tools/test/smoke.test.mjs`（3 个新用例 + 1 处断言改写）；`vendor/` 与 `dist/` 未动。
  - 编号说明：本轮原写作 014，发现 `docs/plans/014-pip-furigana.md` 已被占用，遂改为 015
    （AGENTS.md §1「编号连续递增」）。
