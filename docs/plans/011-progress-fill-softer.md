# 011 进度填充减轻视觉：保留「文字背后填充」，只是别再糊住字

> 状态：**已实现，未提交**（纯观感改动，只能人工确认；Node 侧门禁全绿）

## 需求

用户反馈：进度条"看着不清"（截图中原文行左侧有一整块蓝，压在字上）。

用户已确认口径：**保留"文字背后填充"这个形态**（不改成细线、不改成整片视频的总进度），
只把视觉减轻 —— 调透明度与圆角。

即：进度语义（跟着当前句的出现时长走）不变，改的只是观感。

## 根因

两处进度填充的取值本来就偏重：

- 浮窗：`30-desktop-subtitles.js` 的 `#fill-primary { background: rgba(10, 132, 255, .30) }`、
  `#fill-secondary { rgba(10, 132, 255, .22) }`；
- 面板：`40-study-panel.js` 的 `.kfill { background: var(--llg-accent-light) }`，
  而 `--llg-accent-light` 是 `rgba(10, 132, 255, .15)`（浅色主题 `.12`）。

浮窗里 `.kfill` 还会被 `plateCss()` 生成的底板色（`rgba(0,0,0,.8)` 之类）叠一层，
深底 + 30% 蓝 → 对比很强，读字就成了"蓝块上的白字"。

**这不是实现错误，是取值问题**，所以是纯观感改动，没有"根因"可深挖。

## 做什么

- 浮窗两个填充统一减轻：建议 alpha `.30 → .16`、`.22 → .11`；
  圆角继续用 `var(--radius-sm, 8px)`，与 `.kline` 的圆角一致（不引入新形状）。
- 面板 `.kfill` 同步减轻：建议给 `.kline` 单独定义一个更轻的填充色
  （例如 `--llg-fill-active: rgba(10, 132, 255, .10)`，浅色主题 `.08`），
  `.kfill` 用它，不再复用 `--llg-accent-light`（那个令牌还用在 `.row.is-active` 上，
  改它会连带改列表选中态 —— 这是本轮明确不要的副作用）。
- 具体数值以人工在浏览器里看的结果为准，PLAN 里给的是起点值。

## 不做什么

- 不改进度语义：分母（`progressEnd()`）、分子、`estimatedSeconds()`、`cue.end` 语义都不动。
- 不改成细线/独立进度条，也不改成"整片视频总进度"（用户明确选了保留填充）。
- 不改 `.row.is-active` 的选中态背景（那就是共用令牌的坑，见上）。
- 不动 `10-subtitle-track.js`（PLAN 009 的范围）。
- 不改浮窗的底板/描边/字号等官方外观投影（PLAN 008 的范围）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - docs/plans/011-progress-fill-softer.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/00-shared.js
  - tools/probe.mjs
  - tools/test/**
  - build.mjs
  - Makefile
```

## 实现方案

1. `30-desktop-subtitles.js`：`PIP_BASE_CSS` 里 `#fill-primary` / `#fill-secondary` 的 rgba 降下来，
   注释写明"为什么不是 .30"（读字优先）。
2. `40-study-panel.js`：`.panel` 的令牌区加 `--llg-fill-active`（深/浅两套），`.kfill` 改用它。
   注意 `.row.is-active` 保持 `--llg-accent-light` 不变。
3. 这两处都是纯样式字符串，测试无法断言"好看"，只能断言"令牌被改了、没有误伤 accent-light"
   —— 若写不出有意义的断言，就在 PLAN 里如实登记"靠人工确认"，不许编一条空测试凑数。

## 验证方式

- [ ] `make test` + `make build` + `make check`（不新增测试则说明理由）
- [ ] 浏览器人工确认（`--browser=arc`）：浮窗原文行读字清楚；面板当前句的填充不再糊住字；
      面板列表选中态与改动前一致（没被共用令牌误伤）

## 预期量级

2 个文件 / +12 −6 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交**（同上：工作区里还躺着其它 PLAN 的改动）。
- 验证结果（实际输出）：`make test` 59/59 绿、`make build` 契约 ✓、`make check` ✓。
  **故意没有新增测试** —— 这两处改的是颜色字符串与令牌，Node 侧断言不出「好看」，
  编一条「断言 rgba 是 .16」的空测试只是自欺（AGENTS §3 要求测不了的缺口如实登记）。
- 最终取值（**未经人工确认**，按 PLAN 给的起点值落地）：
  - 浮窗 `30-desktop-subtitles.js`：`#fill-primary` alpha `.30 → .16`、`#fill-secondary` `.22 → .11`；
  - 面板 `40-study-panel.js`：新增令牌 `--llg-fill-active`（深色 `rgba(10,132,255,.10)`、
    浅色 `rgba(0,122,255,.08)`），`.kfill` 改用它；`--llg-accent-light` 保持原值，
    继续供给 `.row.is-active` 与拖拽手柄 hover（没有被误伤，这是本轮特意避开的副作用）。
- 遗留 / 与预期不符之处：**浏览器内未验证**。要确认「读字清楚 + 选中态没变」，
  得在浮窗与面板上各看一眼。
