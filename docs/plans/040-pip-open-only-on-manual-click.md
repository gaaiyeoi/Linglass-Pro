# 040 桌面字幕浮窗：只在手动点击时弹出

> 状态：**待执行**

## 需求

用户改口径（早上刚做的 PLAN 039 因此撤回）：

> 「现在点击视频就会弹出浮窗，我希望是我手动点击才弹出。」

即：

1. 点视频封面 / 点页面任意处**都不许**弹浮窗；
2. 只有**控制栏的「桌面字幕」按钮**与**设置面板里的开关**能打开它；
3. 「开了就一直开着」的既有语义不变（UA 收走窗口后等下一次手势恢复）。

## 根因

PLAN 039 做了两件让浮窗「自己冒出来」的事：

1. `enabled` 默认改成 `true` → 页面一加载就 `arm()`，点页面任意处（播放/暂停、拖动进度……）
   都会开窗；
2. `arm()` 的判据加了 `opensWatch(ev)` → 点视频封面那一下就预开。

两者叠加，用户看到的就是「点视频就弹」。

## 做什么

- 撤回 039 的两处改动：
  - `enabled` 默认值改回 `false`（回到 PLAN 025 的「视频内嵌字幕优先」）；
  - 删掉 `WATCH_LINK` / `opensWatch()`，`arm()` 只认 `canAutoOpen()`。
- 设置面板 `desc` 与 README 的默认值口径同步改回「默认关闭」。
- 测试：
  - 恢复 `桌面字幕：默认关闭（视频内嵌字幕优先），没开过就不弹窗`；
  - 删除 039 新增的「点封面预开」「修饰键不预开」两条用例；
  - 契约表删掉对应的两条平台登记。

## 不做什么

- 不动 `arm()` 的「显式打开后一直开着」语义（PLAN 016 / 019 / 022）。
- 不改浮窗视觉、控制栏按钮、进度、注音、上下文行。
- 不动 `src/mod/` 其它文件与 `vendor/`、`dist/`。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - tools/test/contract.test.mjs
  - README.md
  - docs/plans/039-pip-default-on-and-open-from-cover-click.md
  - docs/plans/040-pip-open-only-on-manual-click.md

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

1. `let enabled = true` → `false`，注释写明「默认关闭；打开只能来自按钮/开关（PLAN 040）」。
2. 删掉 `WATCH_LINK` 常量与 `opensWatch()`；`arm()` 回调恢复为
   `if (canAutoOpen()) { open(); return; }`。
3. 设置面板 `desc` / README 恢复「默认关闭」口径。
4. 测试与契约表同步回滚（见「做什么」）。
5. 在 039 的标题下加一行「已被 PLAN 040 撤回」，保留它的根因与验证记录。

## 验证方式

- [ ] `make test`
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（未做就如实写）：点视频封面不弹；点播放器控制区不弹；
      点控制栏「桌面字幕」按钮才弹。

## 预期量级

6 个文件 / +40 −80 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里还有 PLAN 032~038 的未提交改动）。
- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 168
  # pass 168
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

  回归确认：把 `let enabled = false` 临时改回 `true` →
  `桌面字幕：默认关闭（视频内嵌字幕优先），没开过就不弹窗` 恰好 1 例变红；改回来全绿。

- 遗留 / 与预期不符之处：
  1. **浏览器内未验证**：点封面 / 点播放器不再弹窗，需要人工确认。
  2. **落盘里 `enabled: true` 的人仍会按常驻语义在播放页点一下时回来** ——
     那是「开了就一直开着」的既有语义（016/022），本轮没动。如果用户之前用
     039 的版本点开过（落盘已被写成 true），需要**显式关一次**（控制栏按钮或设置面板开关）
     才会彻底不弹。
  3. 039 的两条用例与两条平台契约登记已删除。

