# 022 桌面字幕浮窗：回到浏览器就被收走，且回来的时机全被错过

> 状态：**已完成**（Node 侧门禁全绿；浏览器内生行为未验证，见文末）

## 需求

用户反馈（原话）：「悬浮窗**还是**会在打开后，最小化或切走浏览器本体（**此时正常工作**）、
然后又回到浏览器本体后，被自动关闭。」

期望：

1. 回到浏览器本体时，浮窗**尽可能当场回来**（而不是一直等到下一次「刚好想起要动手势」）；
2. 「被浏览器收走」这件事**绝不能**被当成「用户不要了」——常驻开关不许被写成关；
3. 浮窗消失后，任何一次页面手势（点按钮、点播放器、按键）都必须能把它接回来。

## 根因

### ① 关窗不是我们干的（这条是本 PLAN 不能修的边界）

代码里能关掉浮窗的只有三处，全部可枚举：

| 位置 | 触发条件 | 与「回到浏览器」有关吗 |
|---|---|---|
| `close()`（30-:1070） | 控制栏按钮 `if (pipWin) close()`（:1208）、设置开关 `if (enabled) close()`（:1296） | 无关（要用户点我们自己的 UI） |
| `cleanupOrphan()`（30-:1332） | 只在**内容脚本重新注入**时（扩展重载 / 页面重载） | 无关（用户报的是「切走再回来」，不是重载） |
| `requestWindow()`（30-:1042） | 同一文档再开窗时，UA 会先关掉已开着的那扇（规范 §6.5 / requestWindow 步骤 8） | **唯一需要我们发指令的路径**，见下 |

而「回到浏览器本体」这一刻页面上真正跑的代码只有两段，**都不会关窗**：

```js
document.addEventListener('visibilitychange', () => {
  refreshButton();
  if (!pipWin) arm();          // 只挂一次性手势监听
});
```

```js
function heartbeat() {
  refreshButton();
  if (pipWin && supported() && documentPictureInPicture.window !== pipWin) {
    stop();                    // 只清本地状态
    if (enabled) open();       // 只是「试图开回来」
    return;
  }
  ...
}
```

那条唯一可能由我们发起的关闭（心跳误判 `pipWin` 已消失 → `stop()` → `open()` →
`requestWindow()` 先把浏览器里还开着的那扇关掉）被**用户自己的观察排除**：心跳一旦清空
`pipWin`，`stopFrame()` 会停掉浮窗自己的 rAF、`pushProgress()/pushText()` 全部短路，
最小化期间的字幕就不再更新了；而用户说「此时正常工作」⇒ `pipWin` 一直有效、`stop()` 没跑过。

⇒ **「回到浏览器本体时窗口被收走」是 UA 干的**：规范只把它列为裁量（§5 步骤 9
*"Optionally, the user agent can close any existing picture-in-picture windows."*、
§6.10 *"Giving system focus to the opener does not necessarily need to close the
document picture-in-picture window."*），而 `disallowReturnToOpener: true` **拦不住它** ——
MDN 与 Chrome 官方文档都写明它只是「不显示那个返回原标签页的 UI 控件」的
**hint**（且只在 Chrome 124+ 存在）。本 PLAN 不试图阻止关闭（阻止不了，与 PLAN 001 同结论）。

### ② 能修的部分：「回来」的时机被读陈旧的 `pipWin` 挡掉（4 处）

`pipWin` 只在 `pagehide`（`handlePageHide`）与心跳（最多晚 1s）里才会被清空。而在
「浏览器刚把窗口收走、`pagehide` 还没送到 / 心跳还没跑到」这段窗口里，**读 `pipWin`
的代码会做出与事实相反的判断**：

| 位置 | 现状 | 后果 |
|---|---|---|
| `visibilitychange`（:1279） | 只 `arm()`，且条件写死 `if (!pipWin)` | `pipWin` 陈旧时**连武装都不做**；而且这一刻从不试着开一次（这一刻若带着激活本来能当场开回来） |
| `arm()`（:1007） | 守卫里有 `pipWin` | 陈旧时武装被自己挡死 ⇒「下一次手势」永远等不到 |
| `canAutoOpen()`（:957） | 判据是 `pipWin` | 用户「回来点一下」的那一下手势被浪费（那一下是带瞬时激活的） |
| 控制栏按钮（:1208） | `if (pipWin) close(); else open();` | 陈旧时本意是「开回来」，却走了 `close()` ⇒ **把常驻开关落盘成 `false`**，功能真的被关掉，还得再点一次 |

另外：`window` 的 `focus`（从别的应用点回来 / 从最小化恢复，而 `visibilityState`
未必跃迁）**根本没有被监听**——这是「回到浏览器本体」最直接的信号。

## 做什么

- 新增 `liveWindow()` / `syncWindow()`：把本地状态和浏览器对齐。
  - `liveWindow()` 用**两个判据**：`pipWin.closed`（窗口自己知道它被关了）与
    `documentPictureInPicture.window` 为假（浏览器那边一个窗口都没有了）；
    **不比 WindowProxy 身份**（身份一旦不成立就会去 `requestWindow()`，
    而它会顺手把还开着的那扇关掉——正是 §根因①里那条路径）。
  - `syncWindow()`：不一致时 `stop()`（清状态），返回「此刻是否真有窗口」。
    **只清状态、绝不写 `enabled`**（「谁关的」在这里同样分不清，见 `save()`）。
- 所有「读 `pipWin` 决定开/关」的地方改走校准结果：`open()` 的守卫、`canAutoOpen()`、
  `arm()` 的守卫、`heartbeat()`、控制栏按钮的 `onClick`。
- 新增 `wake()`（先 `syncWindow()`、再尽量 `open()`）挂到 `visibilitychange` 与
  `window` 的 `focus`：**「回到浏览器」这个时机本身就有机会当场把窗口开回来**。
- 文件头「常驻语义」补一段：说明关窗归 UA、`wake()` 做什么、以及为什么不再比身份。

## 不做什么

1. **不试图阻止 UA 关闭**（阻止不了：规范只给 UA 裁量权，`disallowReturnToOpener`
   只是 UI hint）。本 PLAN 只改「回来得多快、多可靠」。
2. 不改回「区分谁关的」那套（PLAN 016 已论证 `pagehide` 里区分不了点 X 与文档卸载）。
3. **不改设置面板开关的语义**（`toggle()` 仍是 `if (enabled) close(); else open();`）：
   它渲染的就是 `enabled`（`isOn: () => enabled`），开关翻转的必须是这个持久状态；
   改成看「有没有窗口」会让开关与自己的显示不一致。控制栏按钮不同——它渲染的是
   `!!pipWin`，所以那一处才改成校准后的状态。
4. 不改浮窗视觉/排版/控制栏按钮集合/进度/注音/文节分隔符。
5. 不改 `10-subtitle-track.js` / `15-ja-break.js` / `40-study-panel.js` /
   `50-settings-panel.js` / `00-shared.js` / `build.mjs` / `Makefile` / `tools/probe.mjs`。
6. 不新增依赖、不引入对事件派发顺序的假设。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/022-pip-reopen-on-return.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/05-ja-segment.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

## 实现方案

1. `liveWindow()` / `syncWindow()`（放在 `supported()` / `warn()` 之后）。
2. `open()`：守卫里的 `pipWin` 换成 `syncWindow()`。
3. `canAutoOpen()` / `arm()` 的守卫、`heartbeat()` 的判断、控制栏按钮的 `onClick`
   全部改走 `syncWindow()`。
4. `wake()` + `document.visibilitychange` / `window.focus` 两个监听。
5. 测试（`tools/test/smoke.test.mjs`）：
   - 桩件：`sandbox.addEventListener/removeEventListener`（现在 `window` 就是 sandbox 自身，
     不加这一对，`window.addEventListener('focus', …)` 会直接抛）、
     `h.buttons`（记下 `ensureButton` 收到的 options，用来调**真实的** onClick）、
     `h.withActivation(fn)`（比 `h.gesture` 更直接：在某段同步代码里置真瞬时激活）、
     `h.focus()`；
   - 新增 3 条：
     - **回归（核心）**：`窗口被浏览器收走后，控制栏按钮那一下是「开回来」而不是把常驻开关关掉`
       —— 旧代码在这里会落盘 `enabled:false`（先红）；
     - **回归**：`回到浏览器且那一下带着激活时，浮窗当场回来`（`visibilitychange` 与
       `window focus` 两条路径各验一次；旧代码 requestCount 不动）；
     - **硬化**：`窗口自称 closed（API 的引用还没更新）时，心跳清干净并武装`。

## 验证方式

- [x] `make test`
- [x] `make build` + `make check`
- [x] 回归确认（先红后绿，逐条单独验）
- [ ] 浏览器人工确认：**未跑**（用户明确要求本轮不要开浏览器跑探针）

## 预期量级

2 个文件 / +150 −10 行（`30-` 约 +75 −5，测试约 +110 −5，PLAN 文档另计）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里还有 PLAN 013~019 的未提交改动，按「一个 PLAN = 一个提交」
  需要人先决定怎么收尾）。

- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 110
  # pass 110
  # fail 0            （基线 107 → 110）

  $ make build
  [build] 基线      vendor/linglass-1.12.4
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      mod/00-shared.js → mod/05-ja-segment.js → mod/10-subtitle-track.js
                    → mod/15-ja-break.js → mod/30-desktop-subtitles.js
                    → mod/40-study-panel.js → mod/50-settings-panel.js
  [build] 版本      1.12.900

  $ make check
  版本    1.12.900
  已注入  mod/00-shared.js, mod/05-ja-segment.js, mod/10-subtitle-track.js,
          mod/15-ja-break.js, mod/30-desktop-subtitles.js, mod/40-study-panel.js,
          mod/50-settings-panel.js
  ```

- **回归确认（先红后绿，各条单独验过）**：
  1. 把 `syncWindow()` 的实现临时改成 `return !!pipWin;`（= 回到「读陈旧的 `pipWin`」）
     → `not ok 77`（控制栏按钮…）、`not ok 78`（回到浏览器本体…）恰好这两条变红，
     `# pass 108 / # fail 2`；改回 → 110 全绿。
  2. 只删掉 `liveWindow()` 里的 `if (pipWin.closed) return null;`（= 只信
     `documentPictureInPicture.window`）→ `not ok 79`（窗口自称 closed…）恰好这一条变红，
     `# pass 109 / # fail 1`；改回 → 110 全绿。

- 遗留 / 与预期不符之处：
  1. **浏览器内未验证**（用户明确要求本轮不要开浏览器）：`window focus` 在真实
     Chrome / Arc 里「从别的应用点回浏览器」时是否确实派发、`pipWin.closed` 与
     `documentPictureInPicture.window` 的一致性，都只有 Node 桩件层面的验证。
  2. **关窗本身修不掉**：UA 把焦点/可见性交还 opener 时收走 document PiP 窗口这件事，
     没有 API 能阻止（`disallowReturnToOpener` 是 UI hint，且只在 Chrome 124+ 存在）。
     本 PLAN 交付的是「回来的时机不再被错过」——**如果「回到浏览器」那一下不带页面手势，
     仍然只能等下一次手势**。
  3. **没做 `opening` 超时兜底**（计划里曾想加）：它的前提是 `requestWindow()` 的 promise
     悬着不落地。而那种情况下连**第一扇窗都开不出来**，与用户报告的「打开后……被关掉」
     矛盾，所以它不是本次的因；加了反而会引入一条没有测试覆盖的分支（AGENTS §3）。
     若以后真观测到「再也开不回来」，再加 5 行兜底并补测试。
  4. **测试桩件补了 `window.addEventListener/removeEventListener`**：沙箱里 `window` 就是
     sandbox 自身，此前没有这一对（30- 之前不监听 window，40- 只有拖拽路径会用、而测试
     从不拖拽）。这是**新增桩件**、不是新增产物依赖，故契约测试不动。
  5. **工具提示（`registerFeature` 的 `desc`）与 README 的口径未改**：它们仍写
     「切回浏览器会自己回来」，严格说本 PLAN 之后依然只在「有手势」时成立。
     改文案属于文档轮，留给后续 PLAN（避免把文档改动混进这个 bug fix）。
  6. **量级与基线**：本仓库 `git diff --stat` 无法单独量出本 PLAN 的增量（013~019 未提交，
     `30-desktop-subtitles.js` 显示 449 行、`smoke.test.mjs` 显示 724 行是好几轮 PLAN 的
     合计）。本轮实际新增约 +190 −8 行，超出「预期量级」的 +150 −10，超出部分主要是
     `liveWindow()/syncWindow()` 的注释与 3 条测试。
  7. **构建基线变成了 `vendor/linglass-1.12.4`**（PLAN 019 时是 1.12.3；`promoCards` 的
     内容哈希也跟着变了）。不是本轮改的，但两轮的门禁输出会因此不同——`make test` 的
     契约测试在 1.12.4 上全绿，说明我们依赖的那些官方记号仍然成立。

