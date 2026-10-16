# 016 桌面字幕浮窗「默认开启」不可靠：刷新会把开关写成关

> 状态：**已完成**（Node 侧门禁全绿；浏览器内行为未验证，见文末）

## 需求

用户反馈：桌面字幕浮窗**从来没自动弹过**，进 watch 页之后必须手动点控制栏按钮才出现。
期望：只要用户没有通过我们的 UI 显式关掉，浮窗就该是**默认开着**的。

**同日补充（需求收紧）**：用户进一步明确 ——「**关闭只有我点击按钮才会关，其他任何操作
无法关闭悬浮窗**」。即：点 PiP 窗口自己的 X、切到别的应用、刷新页面、真导航换页，一律
不算关闭，窗口必须自己回来；能真正关掉它的只有控制栏按钮与设置面板开关这两个 UI。
这与本 PLAN 的修法同向，只是把「疑似点 X 就只 arm() 等手势」收紧成「一律立刻 `open()`、
失败再 `arm()`」，并删掉那一整套「谁关的」判定。

## 根因

### ① 落盘被「文档卸载」污染（主因）

`30-desktop-subtitles.js` 的 `handlePageHide()` 用 `isInvoluntaryClose()` 判断「谁关的」：

```js
function isInvoluntaryClose() {
  if (document.visibilityState === 'hidden') return true;
  return Date.now() - lastVisibleAt <= RECENT_VISIBLE_MS;
}
```

它只看**页面的可见性**与**最近一次 hidden→visible 的时刻**。而**刷新页面 / 真导航 / 关标签**
时，opener 文档被销毁 —— 规范（Document PiP §6.6 / §6.7）要求 UA **必须**关闭 PiP 窗口，
于是 `pagehide` 同样会在我们这里触发。此刻：

- `document.visibilityState` 仍然是 `'visible'`（刷新时页面不会先变 hidden）；
- `lastVisibleAt` 只在**真的** hidden→visible 跃迁时才刷新，所以它早已过期。

⇒ `isInvoluntaryClose()` 返回 `false` ⇒ 走「用户自己关的」分支：

```js
enabled = false;
save();          // ← chrome.storage.local.llgPip = { enabled: false }
```

**这是代码层面可以直接确认的事实，不需要任何关于浏览器时序的假设**：这段逻辑里
没有任何东西能把「文档正在卸载」与「用户点了 PiP 窗口的 X」区分开。

后果就是一个死循环：手动点按钮 → `open()` 把 `enabled` 写回 `true` → 任何一次刷新
又写回 `false` → 下一次进 watch 页不再 `arm()` → 只能再手点。表现就是用户说的
「每次都必须手点」。

### ② 首次手势可能被白白丢掉（次因）

`canAutoOpen()` 硬性要求 `location.pathname === '/watch'`：

```js
if (location.pathname !== '/watch') return false;
```

而从首页 / 搜索页点视频封面时，`pointerdown` 发生在 **SPA 导航完成之前**，那一刻
`pathname` 还是 `'/'` ⇒ 判 `false`。更糟的是 `arm()` 的回调先 `disarm()` 再判断，
所以这一次手势**直接被丢掉**，要等最多 1s 的 heartbeat 才会重新挂上。

`/live/<id>` 这类播放页也拿不到（虽然它同样有 `#movie_player`）。

### 为什么不按「加一个卸载标记」修

看似可以在宿主 `document` 的 `pagehide` 里置 `unloading = true`，再让 pipWin 的
`pagehide` 看到它就不落盘。但 **pipWin 的 pagehide 与宿主 document 的 pagehide
谁先派发没有规范保证**（Node 侧也测不了），把正确性押在一个没保证的顺序上，
等于把这个 bug 换成另一个更难查的 bug。见「实现方案」里的取舍。

## 做什么

- **`enabled` 的落盘只由我们自己的 UI 驱动**：
  - `open()` 成功后写 `true`（不变）
  - 控制栏按钮 / 设置面板开关的 `close()` 写 `false`（不变）
  - **PiP 窗口的 `pagehide`（不是 `closingByUs`）一律不改 `enabled`、不落盘**
- `handlePageHide()` 只剩**一条**恢复路径：只要不是 `closingByUs` 且 `enabled` 仍为 true，
  就立刻 `open()`（失败时 `open()` 内部会 `arm()`，等下一次手势）。「谁关的」不再区分 ——
  `isInvoluntaryClose()` / `RECENT_VISIBLE_MS` / `lastVisibleAt` / `pageHidden` 一并删除。
- `heartbeat()` 补一道兜底：窗口被系统**悄悄**销毁（`pagehide` 没送到我们手里）时，
  `documentPictureInPicture.window !== pipWin`，同样按中间态把它弄回来。
- `canAutoOpen()`：去掉 `pathname === '/watch'` 硬条件，改为「宿主页面存在
  `#movie_player video`」—— 这才是「这是个播放页」的真正判据，也顺带覆盖 `/live/`。
  注意**不能用 `video()` 那个带 `document.querySelector('video')` 兜底的版本**：
  首页的缩略图预览也是 `<video>`，用它会在首页乱弹。
- `arm()` 的回调：`canAutoOpen()` 为假时**立即重新 `arm()`**，不让这一次手势白白作废。
- 文案同步（`registerFeature` 的 `desc`）：写明「默认开启，而且只有这里的开关或控制栏
  按钮能关掉它；点浮窗自己的 X、切后台、刷新页面都会让它自己回来」。旧文案
  「关掉之后不再自动打开」已经与新语义不符，留着会误导。

## 不做什么

- 不改 `10-subtitle-track.js`（字幕轨道与本次无关）。
- 不改浮窗的视觉、排版、控制栏按钮集合（`pipCss` / `PIP_BASE_CSS` / `BAR_BUTTONS` 原样）。
- 不碰振假名相关的事（那是 PLAN 017，独立需求）。
- 不改 `00-shared.js` / `50-settings-panel.js` 的接口与结构（只改 `30-` 里传过去的文案）。
- 不改 `40-study-panel.js`、`build.mjs`、`Makefile`、`vendor/`、`dist/`。
- **不引入任何对浏览器事件派发顺序的依赖**（见根因末尾）。
- 不做「阻止 UA 关闭」的尝试（001 已经论证过做不到）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/016-pip-default-on-reliable.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/00-shared.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

## 实现方案

1. 删掉 `handlePageHide()` 里的 `enabled = false; save();` 分支与 `isInvoluntaryClose()`
   判定；非 `closingByUs` 的关闭一律 `open()`。连带删掉只服务于该判定的
   `RECENT_VISIBLE_MS` / `lastVisibleAt` / `pageHidden`（含测试钩子里的 `RECENT_VISIBLE_MS`）。
2. `save()` / `enabled` 的写入口收敛：全文只允许 `open()`（写 true）与 `close()`（写 false）
   两处落盘，并在注释里把这条约束写死（防止以后有人又往 `pagehide` 里加写盘）。
3. `canAutoOpen()`：`pathname` 判据换成 `!!document.querySelector('#movie_player video')`。
4. `arm()` 的回调改为：

   ```js
   armed = () => {
     disarm();
     if (canAutoOpen()) open();
     else arm(); // 这次手势落在「还不是播放页」的时刻，别把它丢掉
   };
   ```

   注意 `arm()` 自身的守卫（`armed || !enabled || pipWin || !supported()`）就够防重入，
   不需要额外标志。
5. 测试口径调整（AGENTS.md §3 要求写明理由）：
   - **改**「用户点 PiP 窗口自己的 X 也算显式关闭」这条既有断言：它固化的是 001 的旧语义
     （点 X 能永久关掉）。新语义下点 X 与刷新**不可区分**，所以「点 X 永久关掉」这个行为
     被有意放弃 —— 断言改为「点 X 之后窗口会自己回来，且不落盘 `enabled=false`」。
   - **保留**「显式关闭之后不再自动弹回来」：走的是 `pip.close()`（我们自己的 UI），
     这条语义没变。
   - **新增**：
     - 「刷新页面不会把常驻开关写成关」（模拟：pipWin 的 pagehide + 页面可见 →
       落盘里不出现 `enabled:false`；重新加载后仍会 `arm()`）
     - 「点 X 之后不落盘 false，且窗口自己回来」
     - 「窗口被系统悄悄销毁（没收到 pagehide）时，心跳把它弄回来」
     - 「非 watch 页的第一次手势不会被丢掉」（`canAutoOpen` 为假时立即重新 arm，
       下一次手势成功开窗）
     - 「`#movie_player` 存在即可开窗（不再要求 pathname === '/watch'）」

## 验证方式

- [ ] `make test`（说明改了哪条既有断言、为什么）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed` 可半自动）：
      浮窗开着 → **刷新页面** → 打开 DevTools 所在上下文读 `chrome.storage.local.llgPip`，
      确认 `enabled` 仍是 `true`；随后在页面上点一下，浮窗自己回来
- [ ] 浏览器人工确认：从 YouTube 首页点视频封面进 watch 页，**第一次点击之后**再随便点一下，
      浮窗出现（不再需要去点控制栏按钮）

## 预期量级

2 个文件 / +90 −40 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交** —— 工作区里还躺着 PLAN 004~012 的改动，以及并行会话正在改的
  `40-study-panel.js`（不是本 PLAN 的范围，一个字节都没碰）。按「一个 PLAN = 一个提交」
  需要人先决定怎么收尾。

  编号让位：本 PLAN 一开始写成 013，落盘时发现 `013-study-panel-back-to-current.md`
  已被另一个会话占用（还有 015），按 AGENTS.md §1「编号连续递增」改成 **016**。

- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 69   ℹ pass 69   ℹ fail 0
  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-CtntZOE3.js
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js
  $ make check
  版本    1.12.900
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  新增用例（4 条，冒烟）：
  `桌面字幕：点 PiP 窗口自己的 X 关不掉它（只有按钮才算关闭）`（回归，替代 001 那条
  「点 X 也算显式关闭」）、
  `桌面字幕：窗口被系统悄悄销毁（pagehide 没走到我们这里）时，心跳把它弄回来`、
  `桌面字幕：还不是播放页时的第一次手势不会被丢掉`、
  `桌面字幕：判据是「播放页里有 video」，不再看 pathname（直播页也能开）`。

  **回归确认（先红后绿）**：把 `handlePageHide()` 末尾临时改回修复前的
  `enabled = false; save();` → 恰好那 1 例变红、其余 58 例仍绿；改回来 → 59 例全绿
  （当时 017 的用例还没加）。

- 遗留 / 与预期不符之处：
  1. **推翻了 PLAN 001 的一条语义**：001 里「用户点 PiP 窗口自己的 X = 显式关闭、不再自动
     弹回来」被有意放弃 —— 因为**在 pagehide 里它与「文档卸载（刷新/导航）」根本区分不了**
     （见「根因」），留着它就是留着这个 bug。现在按用户的要求收紧成：**只有控制栏按钮与
     设置面板开关能真正关掉它**，其余一切让窗口消失的操作都会让它自己回来（有手势激活期
     就立刻回来，没有就等用户下一次点击/按键）。UI 文案已经跟着改。
  2. **没有采纳「加一个卸载标记」的修法**：pipWin 的 `pagehide` 与宿主 `document` 的
     `pagehide` 谁先派发没有规范保证，Node 侧也测不了 —— 不把正确性押在没保证的顺序上。
  3. **浏览器内未验证**（Node 测不了）：刷新页面后 `chrome.storage.local.llgPip.enabled`
     是否仍为 `true`、点 X 之后窗口多久回来、Arc 到底在什么时机关 PiP 窗口。上面
     「验证方式」里的人工确认还没跑。
  4. 契约测试未改动（没有新增对官方 DOM 的依赖，判据用的是已有的 `#movie_player video`，
     它早已登记）。
  5. 量级超出预期：计划写「2 个文件 / +90 −40」，实际这一轮（016+017 合计，含测试桩件与
     回写）改动更大；工作区基线不干净（004~012 未提交），`git diff --stat` 无法单独量出
     本 PLAN 的增量，故未逐项比对。
