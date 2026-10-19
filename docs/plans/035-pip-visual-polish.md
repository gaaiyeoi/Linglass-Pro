# 035 桌面字幕浮窗：视觉打磨（进度条 / 排版 / 控制栏 / 暗色调）

> 状态：**已完成**

## 需求

- 句内进度从「主字幕身后的蓝色填充块」改为**主字幕正下方的细进度条**：
  轨道 3px `rgba(255,255,255,.12)`、已播放白色 + 轻发光、`999px` 圆角、hover 5px。
- 字幕排版：注音与原文拉开、注音降到次级灰；文节分隔符更淡；上下文更小更淡。
- 控制栏：按钮统一 34px 高 / 8px 圆角；播放键做成圆形白底深色图标。
- 背景从纯黑改为极轻的深灰蓝 `#141518`，纵向间距略放大。

## 不做什么

- 不改播放控制逻辑（`command()` / `seekCue()` / 进度计算）。
- 不改设置面板（PLAN 033）与学习面板。
- 不加「逐词高亮框」：本项目浮窗里没有词级高亮，唯一的蓝色块就是句内进度填充；
  页面内官方字幕的词级高亮属于官方产物，不改。
- 不动浏览器自绘的 PiP 窗口控件（Back to Tab / 关闭由 UA 画，`disallowReturnToOpener`
  已经关掉了那个按钮；我们自己的面板头部本来就是无底色的）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - docs/plans/034-pip-visual-polish.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/15-ja-break.js
  - src/mod/50-settings-panel.js
```

## 实现方案

1. `PIP_BASE_CSS`
   - `html, body` 背景 `#141518`；`#stage` / `#reel` 间距 10px。
   - `.kfill`：`top:auto; bottom:0; height:3px; border-radius:999px; background:#fff;
     box-shadow:0 0 6px rgba(255,255,255,.4)`；`#fill-secondary { display:none }`
     （进度只画一条，跟着主字幕）。
   - `.kline:has(#line-primary)::after` 画轨道（全宽 3px、`rgba(255,255,255,.12)`），
     hover 时轨道与填充一起升到 5px。
   - `#bar button`：高 34px、圆角 8px、无边框、`rgba(255,255,255,.08)`；
     `#pip-toggle` 圆形白底、深色图标。
2. `pipCss()`
   - `#line-primary:has(ruby) { line-height: 1.9 }`；`rt { opacity:.6; line-height:1.15 }`。
   - 分隔符 `opacity:.2`。
   - 主字幕的 `.kline` 补 `padding-bottom: 9px`（给进度条让位；放在 plateCss 之后，
     免得被 contrast 的 `padding` 简写覆盖）。
3. 常量：`CTX_FONT_RATIO` 0.8 → 0.7；`STAGE_PAD_TOP` 8 → 10；`STAGE_GAP` 8 → 10，
   与 CSS 同步（`pipHeight()` 用它们算开窗高度）。

## 验证方式

- [ ] `make test`（含「按钮能收窄」等既有断言）
- [ ] `make build` + `make check`
- [ ] 浏览器人工：进度条位置/扫过、hover 变粗、注音间距、播放键对比度

## 预期量级

1 个文件 / +40 −20 行（纯 CSS 与 3 个常量）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：待定（本轮改动：`src/mod/30-desktop-subtitles.js`、`tools/test/smoke.test.mjs`、本 PLAN）
- 验证结果（实际输出）：
  - `node --test tools/test/smoke.test.mjs` → `tests 100 / pass 100 / fail 0`
  - `node --test tools/test/contract.test.mjs` → `3 / 3`
  - `make build` → 契约校验 ✓、注入自检 ✓；`make check` ✓
- 改了两条旧断言（理由写在 PLAN 里）：
  - 上下文行字号断言 `21.6px / 16px` → `18.9px / 14px`：比例由 0.8 改为 0.7（需求要求
    「上下文比主字幕小 1–2 个梯队」，22px→15px 就是 0.68 左右）。
  - 分隔符断言 `margin .14em / opacity .42` → `margin .16em / opacity .2`（需求要求「大幅调低」）。
- 与需求不完全对应之处（如实说明）：
  - **顶部栏**：本项目 PiP 没有自绘「Back to Tab / Close」栏（那是浏览器的媒体 PiP 控件；
    Document PiP 由 `disallowReturnToOpener` 关掉返回按钮）。我们自己的设置面板头部
    本来就是无底色图标按钮，无需改。
  - **逐词高亮框**：浮窗里没有词级高亮（`linglass-word` 只在页面内官方浮层，且 `src/mod/`
    约定不碰官方文本流）。需求里那块「深蓝实色背景」实为句内进度填充，已改为下方细条。
  - 浏览器内观感（进度条位置、hover 变粗、注音间距、白底播放键）**尚未人工确认**。
