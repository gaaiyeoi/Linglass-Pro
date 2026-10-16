# 001 桌面字幕常驻：默认开启、只有显式关闭才关

> 状态：**已完成**（Node 侧门禁全绿；浏览器内行为未验证，见文末）

## 需求

点开桌面字幕（系统级画中画浮窗）后，只要切回浏览器它就被关掉，而且再也回不来。
期望：**常驻**（切回浏览器 / 刷新页面 / 换视频之后依然在）、**默认开启**（不需要每次手点）、
**只有显式关闭才关**。

## 根因

### 1. 关掉它的不是「我们点错了」，而是 UA 有裁量权

- 规范层面，切回 opener 标签页**不是**自动关闭条件：
  Document Picture-in-Picture §6.10 原文 *"Giving system focus to the opener does not necessarily
  need to close the document picture-in-picture window."* —— "not necessarily" 就是留给 UA 的实现裁量；
  Chrome for Developers 也把 `disallowReturnToOpener` 描述为**纯 UI 开关**（只隐藏 PiP 窗口里那个
  「返回标签页」按钮），不改变开关行为。MDN 同样只列出「用户点浏览器控件 / 网站调 `close()` /
  opener 被销毁」三类。
- 但 UA **可以**主动关：§5 步骤 9 *"Optionally, the user agent can close any existing
  picture-in-picture windows."*、§6.4；opener 文档被销毁或导航时**必须**关（§6.6 / §6.7）。
  刷新页面、换视频（真导航）、扩展重载都落在这一档。

结论：**无法阻止 UA 关闭**。能改的是「关掉之后不再管」这个行为。

### 2. 我们的代码把「被关掉」当成了终态

`src/mod/30-desktop-subtitles.js`：

- `pipWin.addEventListener('pagehide', stop)`（:214）→ `stop()`（:222）只做 `pipWin = null`
  与 `stopFrame()`，**没有任何恢复动作**；
- 唯一的打开入口是控制栏按钮的 `onClick: () => start()`（:149）、以及设置面板的 `toggle`（:253），
  都是「用户此刻必须再点一次」；
- 状态**不落盘**，所以页面一刷新连「原本是开着的」这件事都丢了。

⇒ 于是表现为「一回到浏览器就没了，而且不会自己回来」。

### 3. 打开动作受用户手势限制（决定了恢复该怎么做）

`requestWindow()` 必须在**瞬时用户激活**（transient activation）内调用，否则 Promise reject。
所以「发现被关了 → 默默重开」只能在**关掉的那一刻恰好有手势激活**时成功。
因此恢复策略必须是两段的：**先立刻试一次，不行就武装「下一次用户手势」**。

## 做什么

- 新增持久化开关 `llgPip = { enabled }`，**默认 `true`**（默认开启）
- 区分「谁关的」：
  - **显式关闭**（我们自己的 `close()`；点 PiP 窗口自带的 X）→ `enabled = false`，不再自动开
  - **非显式关闭**（页面处于 hidden，或刚从 hidden 回到 visible 的 `RECENT_VISIBLE_MS` 内）
    → 判定为「切回浏览器时被 UA 关掉」→ 立刻重开；失败则武装一次性手势监听
- `enabled` 为 `true` 时，在 watch 页且有 `video` 元素的前提下，**首次用户手势自动打开**（默认开启）
- 控制栏按钮语义：PiP 已开 → 点击 = 显式关闭；未开 → 点击 = 打开并置 `enabled = true`
- 设置面板开关语义：反映 `enabled`（常驻开关），关掉时同时关窗并取消待开
- 扩展重载遗留的孤儿 PiP 窗口：清理之后不再一走了之，按 `enabled` 武装恢复
- 新增测试钩子 `globalThis.__llgModPip = { open, close, setEnabled, isEnabled, isOpen }`
  （与 `15-ja-break.js` / `40-study-panel.js` 的既有做法一致，便于 Node 侧冒烟）

## 不做什么

- 不改 `10-subtitle-track.js`（进度与时间轴属于 PLAN 002）
- 不改 `40-study-panel.js` 的视觉（属于 PLAN 003）
- 不引入 `chrome.sidePanel`、不用 `<video>` 原生 PiP、不做「系统级置顶」的自绘窗口
- 不加任何第三方依赖
- 不去猜／不去硬扛 UA 的关闭行为（不试图用 `beforeunload`、不重建 opener）
- 不改 `00-shared.js` 的按钮工厂接口
- 不动 `vendor/`

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/001-desktop-subtitles-persistent.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/40-study-panel.js
  - src/mod/00-shared.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
```

> 契约测试 `contract.test.mjs` 不改：本轮没有新增对官方 DOM 的依赖
> （`documentPictureInPicture` 已在 `PLATFORM_CONTRACT` 里登记）。

## 实现方案

1. 常量：`STORE_KEY = 'llgPip'`、`RECENT_VISIBLE_MS = 4000`
2. 状态：`enabled`（落盘，默认 true）、`pipWin`、`pendingOpen`（是否已武装手势恢复）
3. `arm(onGesture)`：`document` 上挂一次性 capture 监听（`pointerdown` / `keydown`），
   触发时若 `enabled && !pipWin` 则 `open()`
4. `open()`：`requestWindow()` → 建 DOM → 挂 `pagehide` → 置 `enabled = true` 落盘
5. `close({ explicit })`：`closingByUs` 包住 `pipWin.close()`；
   `explicit` 为真时 `enabled = false` 落盘并取消武装
6. `pagehide` 处理器：按上面的三分法判定；非显式且 `enabled` → 立刻 `open()`，
   reject 则 `arm()`
7. `visibilitychange`：`visible` 时记 `lastVisibleAt`
8. 启动：读 `llgPip`（默认 true）→ 读完后若 `enabled` 且未开 → `arm()`；
   清理孤儿窗口后同样 `arm()`
9. `refreshButton()` 文案：`pipWin ? '关闭桌面字幕' : '桌面字幕'`；
   `on` 只在窗口真的开着时为真（按钮表达「现在开/关」，面板开关表达「常驻」）

## 验证方式

- [ ] `make test`：新增 5 条冒烟测试（默认开启武装 / 首次手势自动打开 /
      切回浏览器被关会自己回来 / 显式关闭不回弹 / 落盘键名与默认值）
- [ ] `make build` 契约校验与注入自检无告警
- [ ] `make check`
- [ ] 浏览器人工确认（`make probe --headed` 可半自动）：
      PiP 开着 → 最小化宿主 → 恢复宿主 → PiP 仍在；关掉 PiP 的 X 之后不再自动弹

## 预期量级

3 个文件 / +200 −60 行（`30-desktop-subtitles.js` 大改，`smoke.test.mjs` 加桩与用例）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交**（等你确认；按 AGENTS.md §4 这三个 PLAN 应拆成三个提交）
- 验证结果（实际输出）：

  ```text
  make test   →  ℹ tests 35   ℹ pass 35   ℹ fail 0      （基线 23 → 35）
  make build  →  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-CtntZOE3.js
                 [build] 注入 mod/00-shared.js → … → mod/50-settings-panel.js
                 [build] 版本 1.12.900
  make check  →  版本 1.12.900 / 已注入 7 个 mod 脚本
  ```

  新增用例：`桌面字幕：默认开启，但要等第一次用户手势才真正开窗` /
  `切回浏览器时被 UA 关掉，会自己回来` / `显式关闭之后不再自动弹回来` /
  `用户点 PiP 窗口自己的 X 也算显式关闭` / `恢复时没有用户手势，就等到下一次手势` /
  `落盘里关掉的开关，下次加载不会被重新打开`

- 遗留 / 与预期不符之处：
  1. **浏览器内行为未验证**（Node 测不了）。沙箱验的是状态机：谁关的、该不该回弹、
     要不要等手势、落盘值。**验不了「Arc 到底在什么时候关这个窗口」**。
     需要在 Arc 里人工确认：PiP 开着 → 最小化宿主 → 恢复宿主 → PiP 是否还在；
     以及点 PiP 自己的 X 之后不再弹回来。`make probe --headed` 可半自动跑这一步。
  2. 根因只到「UA 有裁量权」这一层，**没有更硬的证据指认 Arc 具体走了哪条路径**
     （规范只给了 §5 步骤 9 这个可选项）。所以实现是「被关之后自己回来」，不是「阻止关闭」——
     后者做不到。
  3. **量级超出预期**：计划写「3 个文件 / +200 −60」，实际
     `30-desktop-subtitles.js` +310 −49、`smoke.test.mjs` +365 −8（这两个文件还含 PLAN 002 的改动）。
     多出来的部分主要是：(a) 常驻语义的注释块（AGENTS.md §3 要求把「为什么」写清）；
     (b) 冒烟沙箱要造一个画中画窗口假件（约 +140 行）。
  4. 契约测试未改动：本轮没有新增对官方 DOM 的依赖（`documentPictureInPicture` 早已登记）。
  5. **需要你知情的副作用**：「默认开启」意味着进 watch 页后**第一次点击/按键就会弹出浮窗**，
     和以前「必须手点按钮」的手感不同。如果你觉得太主动，把默认值改成 `false` +
     保留恢复逻辑即可（一行）。
  6. 实现上新增了测试钩子 `globalThis.__llgModPip`，与 `15-ja-break.js` / `40-study-panel.js`
     的既有做法一致（不是对外接口，仅 Node 侧与诊断用）。
