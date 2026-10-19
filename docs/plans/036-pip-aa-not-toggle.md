# 036 浮窗 `Aa` 只负责打开设置，不再切换收起

> 状态：**执行中**

## 需求

浮窗控制栏右端的 `Aa` 目前是**切换式**：第一次点打开设置面板，第二次点把面板收起、
回到字幕界面。用户反馈：

> 现在的浮窗按钮 如果连续点击设置中的按钮两次 会重新返回浮窗初始界面

期望：`Aa` 只表示「打开设置」。连点两次不该把面板收掉，也不该弹回任何一页。

## 根因

`settingsCommand()` 里 `appearance` 这一支写的是切换：

```js
case 'appearance':
  if (barMode === 'play') openPanel('root');
  else closePanel();
```

第二次点击命中 `else closePanel()`，`barMode` 被改回 `'play'`，`setPanelMode()` 于是
隐藏 `#settings`、显示 `#stage` + `#bar` —— 用户看到的就是「浮窗回到初始界面」。

这条语义来自 PLAN 028 的「样式条」形态（那时 `Aa` 展开/收起一条紧贴控制栏的样式条，
切换是合理的）。PLAN 033 把它换成**整页设置面板**并加了面板自己的 `×`（返回字幕），
`Aa` 的切换语义就失去了存在理由：收起这件事已经有专门的关闭控件，再让入口兼作出口
只会让「想继续设置」的那一次点击变成「退出设置」。

## 做什么

- `case 'appearance'` 改成**只打开**：`barMode === 'play'` 时 `openPanel('root')`；
  已经在设置页（含子页）时**什么都不做**（保持当前页，不弹回 root、不收起）。
- 补一条回归测试：连点两次 `Aa` 仍在设置页；在子页上点 `Aa` 保持子页；收起只走 `×`。

## 不做什么

- 不动 `×`（`settings-close`）与 `←`（`page-back`）的语义 —— 收起入口保持唯一、明确。
- 不改 `Aa` 的图标 / 文案 / 位置，也不改控制栏其它按钮。
- 不改「窗口消失后自己回来」那一套常驻语义（`open()` / `arm()` / `pagehide`）。
- 不改浮窗设置面板里的功能开关清单（`desktopSubtitles` 自己也列在里面这件事，
  与本次需求无关；若要处理另立 PLAN）。
- 不动 `vendor/`、`dist/`、`50-settings-panel.js`（官方面板里的开关不在浮窗内）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/036-pip-aa-not-toggle.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/50-settings-panel.js
  - src/mod/40-study-panel.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

## 实现方案

1. `settingsCommand('appearance')`：

   ```js
   case 'appearance':
     if (barMode === 'play') openPanel('root');
     return true;
   ```

   已经打开时保持原样即可 —— 不调用 `setPanelMode()` / `syncPanel()`，
   避免多一次无谓的 DOM 写入（AGENTS.md §3 的幂等规矩）。
2. 冒烟测试（`tools/test/smoke.test.mjs`，紧挨既有的「设置页与字幕区互斥」用例）：

   ```js
   h.pipClick('appearance');   // play → root
   h.pipClick('appearance');   // 连点：仍在 root
   h.pipClick('page:modes');   // root → modes
   h.pipClick('appearance');   // 子页上连点：仍在 modes
   h.pipClick('settings-close'); // 收起只走 ×
   ```

## 验证方式

- [ ] `make test`（新用例：`桌面字幕：Aa 只负责打开设置，连点两次不会收起面板`）
- [ ] `make build`（契约校验 + 注入自检）
- [ ] `make check`
- [ ] 浏览器人工确认：Arc 里点 `Aa` 打开面板，再点 `Aa` 位置/连点两次不会回到字幕界面
      —— 未验证时如实标注

## 预期量级

2 个文件 / +30 −4 行（PLAN 文档另计）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：待定（本轮改动：`src/mod/30-desktop-subtitles.js` 3 行、
  `tools/test/smoke.test.mjs` +27 行、本 PLAN）
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 157 / pass 157 / fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      … → mod/30-desktop-subtitles.js → …

  $ make check
  已注入  mod/00-shared.js, …, mod/30-desktop-subtitles.js, …
  ```

- 遗留 / 与预期不符之处：
  1. **浏览器内行为未人工确认**：Node 侧只钉住了「`appearance` 不再触发 `closePanel()`」，
     Arc 里连点 `Aa` 的实际观感仍需人工看一眼。
  2. 用户反馈里「可能会回到浏览器 YouTube 画面」**不在本次改动范围内**：
     `closePanel()` 只改 `display`，不会关窗口。浮窗内能关掉窗口的路径只有设置面板里
     那行 `桌面字幕浮窗` 开关（`feature:desktopSubtitles` → `close()`），
     以及 Arc 在焦点变化时收走窗口（PLAN 032 已实测、结论是无法在内容脚本里阻止）。
     若该现象复现，需先确认是哪一条，再另立 PLAN。
