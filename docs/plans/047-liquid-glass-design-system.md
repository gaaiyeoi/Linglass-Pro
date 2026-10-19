# 047 统一设计语言（液态玻璃）+ 三处字幕独立外观

> 状态：**执行中**

## 需求

用户原话：

> 请你从美学角度、统一样式的角度统一一下现在插件的所有设计语言。我挺喜欢液态玻璃、
> 毛玻璃，但是我感觉现在选项太多了，然后样式也不统一。最好三个字幕显示的地方是
> 三个地方单独调整。

拆成三条：

1. **同一套设计语言**：玻璃（毛玻璃 / 液态玻璃）成为唯一表面材质，颜色、模糊、
   高光、描边、圆角、间距、动效时长全部来自同一份令牌，不再各处各写一个近似值。
2. **选项收敛**：外观页按「显示位置」分组，每组只放这一处真正需要的项；不再让
   4 个全局项同时作用于所有渲染位置。
3. **三处独立调整**：视频内字幕 / 桌面字幕浮窗（PiP）/ 学习面板，各自持有自己的
   外观设置，互不牵连。

## 做什么

- 在 `00-shared.js` 建立设计令牌：三层玻璃（thin / regular / thick）、文字四级灰、
  强调色、圆角阶梯、间距阶梯、动效时长与缓动。导出 `shared.design`。
- PiP 窗口、PiP 设置面板、学习面板、投屏页统一改用这套令牌的数值（投屏页受
  `cast-page.test.mjs` 禁止 `backdrop-filter` 的限制，只统一色彩 / 形状 / 动效，
  不加模糊 —— 这是性能取舍，不是遗漏）。
- 外观页改成先选「调整位置」，再显示该位置专属控件：
  - **视频内字幕**：文字样式（官方 4 预设）、字号、颜色、句内分隔符（竖线 / 圆点 / 无）
  - **桌面浮窗**：玻璃质感（清透 / 磨砂 / 深邃）、字号、上下文行数
  - **学习面板**：玻璃质感、字号
- 浮窗不再无条件读取官方的 `subtitleScale` / `subtitleColor`：有自己的值时用自己
  的，没有时才回落到官方值（旧用户升级后观感不变）。
- 句内分隔符的观感统一为同一组数值（视频内 / 浮窗 / 投屏），并让「无」成为可选项。

## 不做什么

- 不改官方字幕的 DOM 结构，不往字幕行里塞可见字符（`15-ja-break.js` 的既有约束）。
- 不动语音识别 / 翻译 / 投屏协议 / 播放控制。
- 不新增第三方依赖。
- 不重命名官方契约里的 class（`toggle-row` / `nav-row` / `style-btn__art` 等）。
- 不给投屏页加 `backdrop-filter`（手机性能，见 `cast-page.test.mjs`）。
- 不重构 `40-study-panel.js` 的字幕列表结构（`.kline` / `.ktext` 保持原样）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/00-shared.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/15-ja-break.js
  - src/mod/35-cast.js
  - tools/cast-page.mjs
  - tools/test/smoke.test.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/047-liquid-glass-design-system.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/35-cast.js
  - src/mod/50-settings-panel.js
```

## 实现方案

1. `00-shared.js`：
   - `GLASS` 三层参数表（背景、模糊、饱和度、描边、内高光、投影）。
   - `TOKENS` 语义令牌（`--llg-glass-*`、`--llg-text-*`、`--llg-accent*`、
     `--llg-r-*`、`--llg-space-*`、`--llg-dur-*`、`--llg-ease`）。
   - `tokensCss(selector)` 生成深色 + `prefers-color-scheme: light` 两块。
   - `glassCss(level)` 生成某一档玻璃的表面片段。
2. `30`：`PIP_BASE_CSS` 开头拼 `tokensCss(':root')`；`#box` / `#bar button` /
   `#progress` / 等待文案全部换令牌；`pipCss()` 里浮窗字号 / 颜色优先取 own。
   `PANEL_CSS` 的纯色底改为玻璃层。
3. `30` 设置面板：外观页顶部加位置分段（官方 `.segmented`），三组控件按位置切换；
   新增 `location:` / `glass:` / `sep:` 动作。
4. `40`：`PANEL_CSS` 令牌值对齐；面板根节点读取 `panelGlass` / `panelScale`，
   以 `data-glass` 与 `--llg-panel-scale` 生效。
5. `15`：`MARK_CSS` 按 `sep` 生成，`content` 分别为 `"|"` / `"·"` / 空。
6. 测试：分隔符断言改为新的统一值；补「分隔符三档」「浮窗独立字号不写官方 storage」
   「学习面板玻璃档位落到 data 属性」三类冒烟断言。

## 验证方式

- [ ] `make test`
- [ ] `make build`（契约校验 + 注入自检）
- [ ] `make check`
- [ ] 浏览器人工确认：三处玻璃观感一致、三个位置的设置互不影响（**未验证则如实标注**）

## 预期量级

5 个源文件 + 2 个测试文件 / 约 +420 −180 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里同时有 PLAN 048/049/050 的未提交改动，按 §4 不混提交）
- 验证结果：
  - `make test` → 176 passed / 0 failed
  - `make build` → 契约校验 ✓、注入顺序 ✓、SW 挂载 ✓
  - `make check` → 通过
- 与预期不符 / 遗留：
  1. **PiP 窗口无法真正透明**：系统 Document PiP 没有「透到桌面」的能力，玻璃感由
     「半透明层 + 顶部内高光 + 一圈 hairline」模拟。`backdrop-filter` 仍写了，但在
     无下层内容时不产生视觉效果。
  2. **投屏页不加模糊**：`cast-page.test.mjs` 明确禁止 `backdrop-filter`（手机性能）。
     投屏页只统一了色彩、圆角、动效与分隔符数值，属于「同族但不带模糊」。
  3. **学习面板字号用四档离散类**（small/normal/large/xlarge），不是连续百分比：
     排版下限测试要求 `font-size: Npx` 字面量，`calc()` 会让断言取不到值。
  4. **视频内的文字样式 / 字号 / 颜色仍是官方全局设置**：官方字幕由官方渲染，
     我们只额外控制句内分隔符。要让这三项也对「视频内」独立，需要覆盖官方 shadow
     DOM 的 `.subtitle-*` 规则，侵入性远超本轮范围（已登记为后续候选）。
  5. **浏览器内观感未验证**：Node 测试覆盖行为与样式文本，玻璃层次、模糊强度、
     三档观感的实际效果需要人工在 Arc/Chromium 里确认。
