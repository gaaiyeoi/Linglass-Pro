# 059 长难句一行多显示一些内容

> 状态：**已完成**（浏览器内观感仍需人工确认，见文末「遗留」）
>
> 编号说明：原为 045，与 `045-cast-progress-fill-and-cue-picker.md` 重复，2026-10-20 改为 059。

## 需求

日语难度调高后，长难句更长。视频内的 Linglass 字幕行与桌面浮窗都在句子中间折成 2～3 行，
有时断点落在词/假名中间，可读性明显下降。用户要求：**一行尽量多显示一些内容，断点更自然。**

## 现象与约束（实测/读源码）

- 视频内（官方 shadow DOM）：
  - `.linglass-subtitle-overlay { width: 95% }`，`.linglass-subtitle-primary { max-width: 90% }`
    → 一行最多约播放器宽的 **85.5%**。
  - 官方没有设置 `line-break`，日文可在任意假名处断行；行首出现小假名/标点时尤其像"断了"。
- 桌面浮窗（`30-desktop-subtitles.js`）：
  - 默认窗宽 `PIP_WIDTH = 860`，CJK 原文行在 100% 档是 27px
    （`BASE_FONT_PX 24 × CJK_FONT_RATIO 27/24`），去掉 `#stage` 的 32px 内边距后
    一行约 30 个日文字符。
  - `#line-primary` 用的是 `white-space: pre-wrap`，没有禁则与均衡折行。

字号不能在这里再乘系数：它是官方 `subtitleScale` 的派生值，浮窗的 `Aa` 与官方面板都在写它，
再缩放会让两处显示不一致，也会让"我设了 100% 却变小了"。

## 做什么

- 新增 `src/mod/12-longline.js`：往官方字幕 shadowRoot 注入一段**只改排版、不动 DOM/文本**
  的样式：
  - `.linglass-subtitle-overlay` 宽度 95% → **98%**；
  - `.linglass-subtitle-primary` / `-secondary` 的 `max-width` 90% → **96%**
    （合计一行上限 85.5% → ≈94%，多 3～5 个假名）；
  - `line-break: strict`（日文禁则：不让小假名、开括号、标点落在行首）；
  - `text-wrap: balance`（真要折两行时长度均衡，而不是"第一行满、第二行两个字"）。
- 浮窗：`PIP_WIDTH` 860 → **1040**（一行约 37 个日文字符，+23%），
  `#line-primary` / `#line-secondary` 补 `line-break: strict` 与 `text-wrap: balance`。
- 更新受影响的断言与契约登记。

## 不做什么

- **不改字号**（理由见上）。
- **不改官方文本流 / DOM 结构**：不插入 `<wbr>`、不加 `word-break: keep-all`。
  那套做法能保证"只在文节边界断行"，但需要往官方行里插节点，且 `keep-all` 在无空格日语里
  可能导致整句不可断而溢出，风险远高于收益。断点优化只交给 CSS 禁则。
- 不做"超长句自动缩字号"：字号会随句子跳动，观感更差。
- 不给这层样式加开关：它只是把官方的盒宽放宽 3～10 个百分点、并按禁则断行，
  没有改变语义；用户若不喜欢，撤掉这个模块即可。
- 不碰 `10-subtitle-track.js` / `15-ja-break.js` / `05-ja-segment.js` / `40-study-panel.js`。

## 修改范围

```yaml
allowed_paths:
  - src/mod/12-longline.js
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - tools/test/contract.test.mjs
  - docs/plans/045-long-sentence-wrap.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/05-ja-segment.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
```

## 实现方案

1. `12-longline.js`（注入顺序在 `10-subtitle-track.js` 之后、`15-ja-break.js` 之前）：
   - `#linglass-subtitle-overlay` 的 shadowRoot 里 `prepend` 一个 `<style id="llg-longline-style">`；
   - 已存在就早退（幂等）；官方重建浮层后由 `shared.onTick` 心跳补注入；
   - 对外只挂一个测试钩子 `__llgModLongline`（`refresh()` / `CSS`），与其它模块的做法一致。
2. `30-desktop-subtitles.js`：改 `PIP_WIDTH` 与 `#line-*` 的两条声明，同步注释。
3. 测试：
   - `smoke.test.mjs`：开窗宽度断言 860 → 1040；新增用例验证浮窗 CSS 含
     `line-break: strict` / `text-wrap: balance`；用最小沙箱加载 `12-longline.js`，
     断言样式注入、幂等（第二次不新增 style）。
   - `contract.test.mjs`：把新依赖的 `.linglass-subtitle-overlay` / `.linglass-subtitle-primary` /
     `.linglass-subtitle-secondary` 登记进官方契约表。

## 验证方式

- [ ] `make test`（新增用例：长句排版样式注入且幂等、浮窗折行声明）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：日语长句在视频内与浮窗里的折行位置、两处宽度变化是否可接受
      （Node 测不了真实排版，这一条只能人工）

## 预期量级

4 个文件 / +120 −15 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：（未提交，留待与本轮其它 PLAN 一起走 §4 的提交流程）
- 验证结果：
  - `node --test tools/test/smoke.test.mjs` → 114 / 114 通过（新增 2 例：
    「桌面字幕：长句按日文禁则断行，并尽量让两行一样长」「长句排版：往官方字幕浮层注入
    禁则与均衡折行样式，且幂等」）。
  - `node --test tools/test/contract.test.mjs` → 3 / 3 通过。
  - `make test` → 185 / 185 通过。
  - `make build` → 契约校验 ✓；注入顺序
    `mod/10-subtitle-track.js → mod/12-longline.js → mod/15-ja-break.js`；版本 1.12.900。
  - `make check` → 已注入列表包含 `mod/12-longline.js`。
- 遗留 / 与预期不符之处：
  - **浏览器内的真实排版未验证**：`line-break: strict` 与 `text-wrap: balance` 在日语长句上的
    落点、以及 98% / 96% 的宽度在 16:9 与窄播放器上的观感，只能人工确认。
  - `text-wrap: balance` 在 Chromium 中对超过 4～6 行的块会退化为普通折行（规范允许），
    属于预期行为，不是失效。
  - 浮窗默认宽度改成 1040 后，小屏（≤1080p、窗口分屏）上会被系统钳到可用宽度 ——
    `requestWindow` 的 width 本来就是建议值，不影响功能。
