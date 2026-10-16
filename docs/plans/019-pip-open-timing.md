# 019 桌面字幕浮窗打不开：开窗时机撞上「我们自己的 UI」，且无激活时硬开

> 状态：**已完成**（Node 侧门禁全绿；浏览器内行为未验证，见文末）

## 需求

用户反馈：**桌面字幕浮窗打不开**，控制台里是

```text
[桌面字幕] 无法打开画中画窗口：Failed to execute 'requestWindow' on
'DocumentPictureInPicture': Document PiP requires user activation
  mod/30-desktop-subtitles.js:519 (warn)
  mod/30-desktop-subtitles.js:989 (open)
```

期望：

1. 点控制栏里的「桌面字幕」按钮、或设置面板里的开关，浮窗**一次就能开/关**，不会闪一下就没；
2. 没有用户手势激活的时机（刷新 / 导航 / 点浮窗自己的 X 之后的自动恢复）**不要**去撞
   `requestWindow()` —— 那条红字会让人以为功能坏了。等下一次手势即可。

## 根因

### ① `arm()` 的手势预开会和我们自己的 UI 抢同一次点击（功能性问题）

`arm()` 把 `pointerdown` / `keydown` 挂在 **`document` 的捕获阶段**，用来实现「点页面
任意位置就把浮窗带回来」。它的回调里直接 `open()`。

问题在于：**用户点「桌面字幕」按钮或设置面板开关时，那也是一次 `pointerdown`。**
于是同一次点击被两个处理器各读一遍，顺序固定（捕获阶段早于目标阶段）：

```text
pointerdown（document 捕获）→ arm() 回调 → canAutoOpen() 为真 → open()
                                          → requestWindow() 成功，pipWin 设立
                     ↓ 几十 ms 后
click（按钮 / 开关）→ 自己的处理器 → 看到「已经开着」→
    · 控制栏按钮：onClick 里是 `if (pipWin) close(); else open();` → close()
    · 设置面板开关：feature.toggle() 里是 `if (enabled) close(); else open();`
      —— open() 刚把 enabled 写成了 true，所以这里同样走 close()
```

结果就是：**点了「打开」，浮窗被开了又被同一次点击关掉**（用户看到「打不开」/ 闪一下），
而且 `close()` 还会把 `enabled = false` **落盘** —— 「默认开启」跟着一起丢，之后只能再点
一次才回来。这与 PLAN 016 里用户抱怨的「从来没自动弹过、必须手点」是同一族症状。

`opening` 标志挡不住这个：它只挡「`pipWin` 还是 null 时的第二次 `open()`」，挡不住
「`pipWin` 已就绪时的 `close()`」。

### ② 没有瞬时激活时硬调 `requestWindow()`（控制台噪音）

`handlePageHide()` 与 `heartbeat()` 的兜底都直接 `open()`。这两个时机**都没有**用户激活
（刷新 / 真导航 / 点浮窗自己的 X / 系统销毁窗口），而 `requestWindow()` 要求瞬时用户
激活（Document PiP 规范），于是必然被拒 → `warn()` 一条红字。

这是 PLAN 016 有意设计的「先试一次，失败就 arm()」，**功能上能恢复**（用户下一次点击时
`arm()` 的手势路径会把它开回来），但每次刷新/换视频都会刷一条红字，用户合理地把它读成
「功能坏了」。

## 做什么

- `open()` 在真正调用 `requestWindow()` 之前先问一句「现在有没有瞬时用户激活」：
  - 有 → 照旧调用；
  - 没有 → **不调用**（少一次注定被拒的请求，也不刷红字），直接走原有的 `arm()` +
    `refreshButton()` 分支，等下一次手势。
  - `warn()` 只在「有激活但 `requestWindow()` 仍然失败」时打 —— 那才是真异常。
- `arm()` 的手势回调忽略「落在我们自己的 UI 上」的手势：控制栏的 `#llg-pip-btn` 与
  设置面板的开关（`[data-llg-toggle]`）。这类手势 **不 `disarm()`、直接返回**，武装保持
  在原处，交给那个按钮/开关自己的 click 处理器去开或关。
- 文件头「常驻语义」一节与 `arm()` / `handlePageHide()` 的注释同步这层语义。

## 不做什么

- 不改「哪些时机该恢复」的既有语义（PLAN 016：只有按钮/开关能真正关掉它）。
- 不动浮窗的视觉、排版、控制栏按钮、进度、注音、文节分隔符。
- 不改 `00-shared.js` / `50-settings-panel.js`：`[data-llg-toggle]` 是**只读**依赖
  （50- 已经在用），不新加接口。
- 不改 `10-subtitle-track.js` / `15-ja-break.js` / `40-study-panel.js` （与本次无关）。
- 不做「刷新后不点任何东西就自动弹窗」的尝试 —— 新文档里 `arm()` 挂上时那次刷新的
  瞬时激活早已过期，规范上做不到（016 已论证）。
- 不引入任何对事件派发顺序的假设（① 的修法是「不让两个处理器读同一次点击」，
  而不是「赌 pointerdown 的 `requestWindow()` 比 click 慢」）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/019-pip-open-timing.md

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

1. 新增 `hasActivation()`：

   ```js
   function hasActivation() {
     const ua = navigator.userActivation;
     return !ua || typeof ua.isActive !== 'boolean' ? true : ua.isActive;
   }
   ```

   取不到这个 API（老浏览器 / 测试桩没给）时**乐观放行**，让 `requestWindow()` 自己判 ——
   不因为探测不到就把功能关掉。

2. `open()` 里在 `disarm()` 之前插一道：

   ```js
   if (!supported() || pipWin || opening) return false;
   if (!hasActivation()) {
     // requestWindow 要求瞬时用户激活；没有时不试，等下一次手势
     arm();
     refreshButton();
     return false;
   }
   ```

   注意顺序：`opening` 先判（避免重入），激活后判（避免白白 `disarm()` 掉武装）。

3. 新增 `onOurOwnUi(ev)` 并在 `arm()` 的回调开头短路：

   ```js
   armed = (ev) => {
     if (onOurOwnUi(ev)) return; // 保持武装，交给按钮自己的 click
     disarm();
     ...
   };
   ```

   判据用 `ev.composedPath()` 而不是 `ev.target`：设置面板的开关在 Linglass 的
   shadowRoot 里，事件冒到 `document` 时 `target` 已被重定向成宿主元素，只有
   `composedPath()` 能看见里面那个 `[data-llg-toggle]`。

4. 测试（`tools/test/smoke.test.mjs`）：
   - 桩里补 `navigator.userActivation`，由 `h.activation` 控制；
   - `h.gesture(type, ev)` 在调用监听器的**同步调用链内**把 `h.activation` 置真、
     调用结束后置假 —— 对应真实的瞬时激活：`open()` 在事件处理器里同步调
     `requestWindow()`，激活有效；等它 `await` 回来时已经不需要了。
     `ev` 用来模拟「这次手势落在哪个元素上」；
   - **改 4 条既有断言**（都是「无激活也要立刻把窗口开回来」那族，理由见下）：
     `恢复时没有用户手势，就等到下一次手势`（`requestCount` 2→1）、
     `点 PiP 窗口自己的 X 关不掉它`（新增「要等一次手势」两段）、
     `窗口被系统悄悄销毁…心跳把它弄回来`（改成「心跳清状态 + 武装，手势才开回来」）、
     `切回浏览器时被 UA 关掉，会自己回来` → 更名 `…下一次手势把它接回来`；
   - **新增 3 条**：
     - `只有页面上的普通手势才预开，我们自己的按钮/开关不抢跑`（验 ①：构造带
       `composedPath()` 的三种路径 —— `#llg-pip-btn`、`[data-llg-toggle]`、
       页面上的普通元素，前两个必须 `requestCount` 不动）；
     - `有激活但被系统拒绝时，仍然等到下一次手势`（验「有激活就试，失败了才等」）；
     - （既有）`默认开启，但要等第一次用户手势才真正开窗` 覆盖普通手势路径。

## 验证方式

- [x] `make test`（既有断言改动见「实现方案」第 4 条）
- [x] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed` 可半自动）：
      浮窗关掉后点控制栏按钮，**一次**就能开；控制台不再出现
      `Document PiP requires user activation`
- [ ] 浏览器人工确认：刷新页面后控制台无那条红字，随后随便点一下页面，浮窗自己回来

## 预期量级

3 个文件 / +70 −25 行（其中 PLAN 与测试占大头，`30-` 只加 ~30 行）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交** —— 工作区里还躺着 PLAN 013~017 的改动（`10-subtitle-track.js`、
  `40-study-panel.js`、`smoke.test.mjs` 里 016/017 的用例），按「一个 PLAN = 一个提交」
  需要人先决定怎么收尾。
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 74   ℹ pass 74   ℹ fail 0

  $ make build
  [build] 基线      vendor/linglass-1.12.3
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-CtntZOE3.js
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js
  [build] 版本      1.12.900

  $ make check
  版本    1.12.900
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  **回归确认（先红后绿）**，两条修法各验一次：
  1. 把 `arm()` 里的 `if (onOurOwnUi(ev)) return;` 短路掉 → 恰好新增的
     `只有页面上的普通手势才预开，我们自己的按钮/开关不抢跑` 1 例变红，
     其余 73 例仍绿；改回来 → 74 例全绿。
  2. 把 `hasActivation()` 临时改成 `return true`（回到「无激活也硬开」的旧行为）→
     `恢复时没有用户手势…`、`点 PiP 窗口自己的 X 关不掉它`、
     `窗口被系统悄悄销毁…`、`切回浏览器时被 UA 关掉…` **恰好 4 例**变红，
     其余 70 例仍绿；改回来 → 74 例全绿。

- **改了 4 条既有断言的理由**（AGENTS.md §3 要求写明）：
  那 4 条都固化了同一个旧假设 ——「窗口消失后，`open()` 立刻就能把它开回来」。
  它们此前之所以是绿的，是因为测试桩的 `requestWindow()` **不检查瞬时激活**
  （只看 `h.pip.deny`）。真实浏览器里这 4 条路径（UA 关窗 / 点 X / 文档卸载 /
  定时器兜底）**都没有激活**，`requestWindow()` 必然被拒 —— 旧行为是「先撞一次墙、
  刷一条红字、再 arm() 等手势」，**功能结果与现在完全一样**（都要等下一次手势），
  只是多了一次注定失败的请求和一条吓人的控制台错误。新断言把「要靠下一次手势」
  这件事显式写出来（每条末尾都补了 `h.gesture()` 后窗口回来的断言），
  于是测试口径与规范一致了。

- 遗留 / 与预期不符之处：
  1. **浏览器内未验证**（Node 测不了）：真实 Chrome / Arc 里
     `navigator.userActivation.isActive` 在 pointerdown 事件处理器内是否确实为真、
     点按钮时浮窗是否一次就能开、控制台那条红字是否真的消失。上面「验证方式」里
     的人工确认还没跑。
  2. **量级超出预期**：计划写「3 个文件 / +70 −25」，实际约
     `30-desktop-subtitles.js` +80 / 测试 +120 / 本 PLAN +200。
     超出部分主要来自 PLAN 文档本身与测试断言的重写。
     工作区基线不干净（013~017 未提交），`git diff --stat` 无法单独量出本 PLAN
     的增量，故未逐项比对。
  3. **`setEnabled()` 测试钩子**（`__llgModPip.setEnabled`）现在在无激活时会静默返回
     `false`。当前没有测试或探针用它，故未改；若以后要用，得注意它是「有机会才开」。
  4. **`[data-llg-toggle]` 是跨模块的只读依赖**（50-settings-panel.js 生产、本文件消费）。
     它不是对官方产物的依赖，所以没进契约测试登记表；但它确实是一条「改 50- 时要记得
     同步」的隐式契约。若以后 50- 换掉这个属性名，本文件的「不抢跑」就会失效（表现为
     点开关时浮窗闪一下）—— 已在这两处注释里互相指明。
