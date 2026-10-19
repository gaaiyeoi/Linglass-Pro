# 044 手机字幕屏：控制条常驻 + 整片进度条看得见

> 状态：**已完成**

## 需求

真机反馈两条：

1. 底部整片进度条**看不见**（字幕与句内进度都正常）。
2. 播放 / 暂停 / ±5 秒 / 倍速 / 齿轮要**常驻**，不想每次点画面才浮出来。

## 根因

### 进度条

真机页面已经是新版（控制条存在，说明不是旧进程的问题）。不可见由两处叠加造成：

- 轨道只有 `3px` 高、背景 `rgba(255,255,255,.12)`，在 `#141518` 上对比度约 1.2:1；
- `bottom: calc(env(safe-area-inset-bottom) + 16px)`，iPhone 横屏的 home indicator 区正好压在附近，
  系统指示条与它重叠。

不是「没渲染」：`#progress-fill` 由 `paintProgress()` 每帧写 `scaleX`，逻辑本身正常
（`#progress.off` 只有设置里显式关掉时才会 `display:none`）。

### 控制条

PLAN 042 的交互是「点画面浮出、5 秒自动收（`showChrome()`）」。真机上这条交互不可发现：
用户不知道要点，也就永远看不到按钮。

## 做什么

- `tools/cast-page.mjs`
  - `#controls` / `#gear` 改为默认可见（`opacity: 1; pointer-events: auto`），
    删掉 `show` 类与 `showChrome()` / `gearTimer` 自动收起逻辑。
  - 打开设置面板时不再隐藏控制条（面板 `z-index: 30` 本来就盖住它）。
  - `#progress`：高度 `3px → 5px`，轨道背景 `.12 → .2`，`bottom` 提到
    `safe-area + 18px`，补 `z-index: 21`（高于控制条，永不被遮）。
  - 给常驻底栏让位：`#stage` 的 `padding-bottom` 由 `+26px` 提到 `+104px`；
    竖屏提示 `#hint` 同步上移。
- `tools/test/cast-page.test.mjs`
  - 断言控制条 CSS 不再带 `opacity: 0` 隐藏态、页面里不再出现 `showChrome`；
  - 断言 `#progress` 高度为 `5px`。

## 不做什么

- 不做「点画面隐藏 / 显示」的开关（用户明确要常驻）。
- 不改推送频率、`syncClocks()` / `paintProgress()` 的插值算法。
- 不改控制条按钮集合、倍速档位、外观预设。
- 不动 `src/mod/**`、`vendor/`、`dist/`、`tools/cast-server.mjs`、`Makefile`。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/044-cast-chrome-always-visible.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
  - tools/cast-server.mjs
  - tools/cast-control.mjs
  - build.mjs
  - Makefile
```

## 验证方式

- [ ] `make test`（新增 2 组断言）
- [ ] `curl` 重启后的 `/?room=demo`：`#controls` 无 `opacity: 0`、`#progress` 为 `5px`
- [ ] 真机确认（未做就如实写）：底部白条清晰可见且每帧平滑；控制条一直可点

## 预期量级

3 个文件 / +60 −25 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（手机字幕屏整条线的改动仍在工作区）。
- 验证结果（实际输出）：

  ```text
  $ node --test tools/test/*.test.mjs
  ℹ tests 189   ℹ pass 189   ℹ fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 版本      1.12.900

  $ make check
  版本    1.12.900
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  重启 8899 后的真页面（curl 抓取）：

  ```text
  #progress        height: 5px; background: rgba(255,255,255,.2); z-index: 21
  #controls        无 opacity: 0 / 无 transition（常驻）
  页面内 showChrome 出现 0 次
  剩余的唯一 opacity: 0 是 #install.gone（安装提示横幅，与本轮无关）
  ```

- 遗留 / 与预期不符之处：
  1. **真机未验证**：本轮只按上一轮「控制条已存在但进度条看不见」的反馈改了可见性，
     没有 iPhone 实机截图确认 5px 在横屏下的观感。
  2. 需要**重启 `make cast`**（本轮已重启 8899）+ **手机重新加载页面**才生效；
     SSE 断线重连不会重新拉 HTML。
  3. 5px 仍可能被 iOS 的 home indicator 压住一部分；`bottom` 已从 +16px 提到 +18px，
     若实机仍然贴得太近，下一步应提到 +30px 以上而不是继续加粗。
