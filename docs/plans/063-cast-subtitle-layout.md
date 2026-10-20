# 063 手机字幕屏：排版与视觉层级重构

> 状态：执行中

## 需求

手机字幕屏的排版按新规格重做，目标是「清爽、层级清楚、能长期看」。
（v2 按真机反馈放大 50%，并把控件移出底部。）

| 层 | 规格（100% 档位） |
|---|---|
| 上文预览 | 20px / 40% 白 / 行高 1.4 / 与主字幕间距 12px |
| 当前原文 | 36px / 600 / `#FFFFFF` / 行高 1.6（带注音时 2） |
| 假名注音 | 18px / 80% 白 / 汉字正上方，间距 4px |
| 主译文 | 24px / 400 / 85% 白 / 上 8px、下 16px |
| 下文预览 | 20px / 40% 白 / 行高 1.4 |

同时：

- 移除文字背后的蓝色句内进度块、移除竖线分隔符（`|`），文节之间只用 6px 微弱间距；
- 全部居中，容器竖向 flex 排列；
- v2：字幕块垂直居中；播放控制竖排贴右下，齿轮右上、连接状态左上，底部只留细进度条；
- v2：界面不使用任何 emoji 或依赖字体的符号字符，图标一律内联 SVG。

## 技术栈说明（与需求原文的差异）

需求里写的是「CSS / Tailwind 与 JSX 结构」，但手机字幕屏不是 React 应用：
`tools/cast-page.mjs` 的 `renderPage()` 返回一整页**内联 HTML 字符串**（样式表、DOM、
脚本都在同一个模板字符串里），手机端因此不发任何外部请求。所以本轮改的是：

- 模板里的静态 CSS（骨架：布局、间距、行高、注音）；
- `appearanceCss()` 生成的动态样式（字号随档位缩放、字重、颜色）；
- 模板里的 DOM 结构（去掉 `.kline` / `.kfill` 包装，文节改为 `.llg-seg`）；
- 页面脚本里的 `buildLine()`（不再插入分隔符字符）。

没有引入 Tailwind 或 JSX。

## 做什么

- `tools/cast-page.mjs`
  - 新增 `TYPE_SPEC`（v2：36 / 24 / 20 / 18）与 `SEGMENT_GAP_PX = 6`，替换原来的
    「按视口高度算基座」与 CJK / 译文 / 上下文的等比系数；
  - `appearanceCss()`：字号按档位缩放（50–150%，下限 11px）；主字幕 600、译文 400、
    上下文 400；主译文 85% 白、上下文 40% 白；注音按档位输出 18px；
  - 删除 `plateCss()`：不再画底板（classic 的模糊块、contrast 的行底），
    `STYLE_SPECS` 只保留描边 / 阴影 / 字距；
  - 静态 CSS：容器 `gap: 0` + 各行 margin 精确分层；`#stage` 底部内边距 24px
    （底部只剩进度条），字幕块垂直居中；`#line-primary` 行高 1.6、
    `:has(ruby)` 时 2；`#line-secondary` 上 8px、`#plate` 下 16px、`#prev` 下 12px；
    注音 `padding-bottom: 4px`；
  - v2 布局：`#controls` 改右侧竖排（`right` + `bottom: 40px`、`flex-direction: column`），
    `#gear` 移到右上、`#status` 移到左上；
  - v2 图标：播放 / 暂停、齿轮、分享全部改内联 SVG（幂等写入 `dataset.icon`），
    去掉 `⚙ / ▶ / ❚❚ / ⤴` 与文案里的箭头字符；
  - DOM：去掉 `.kline` / `.kfill`（含 `#fill-primary` / `#fill-secondary`）；
  - `buildLine()`：每个文节包一层 `.llg-seg`（段间 `margin-right: 6px`），不插入任何字符；
  - `paintProgress()`：底部整片进度 + **日语原文背后**的句内进度（v3 恢复，译文不铺）；
  - v3：译文固定冷色 `rgba(168, 199, 250, .88)`，与纯白原文拉开色相，字号再小一档；
  - v3：`.kline` 用 `max-content` 贴合短句宽度，长句换行后为整行宽；
  - v4：齿轮、回退、播放、快进、倍速全部收进同一个 `#controls` 竖排组，
    按钮一律为 SVG 图标（回退 / 快进用弧箭头内嵌数字 5，倍速用双箭头 + 9px 数值角标），
    组内用两条 1px 分隔线分成「设置 / 播放 / 倍速」三组。
- 测试
  - `tools/test/cast-page.test.mjs`：规格值注入、四条间距、注音 4px、控制条竖排 / 居中、
    图标无 emoji、句内进度只在原文、译文颜色独立；
  - 另断言 `.llg-sep` 已不存在。

## 不做什么

- 不改 `src/mod/**`（发送端快照字段不变；`style.separator` 仍会推送，手机端不再使用）。
- 不改推送频率、`syncClocks()` 的换句 / 校准逻辑（PLAN 062）。
- 不改设置面板、选句浮层、倍速 / 播放控制的指令协议。
- 不改底部整片进度条的外观（横条仍横贯底部，只是按钮不再占底部空间）。
- v2 不改字体栈 / 外观预设的语义，只去掉它们的底板与字号控制。
- 不动 `vendor/`、`dist/`、`tools/cast-server.mjs`、`tools/cast-control.mjs`、`build.mjs`。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/063-cast-subtitle-layout.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
  - tools/cast-server.mjs
  - tools/cast-control.mjs
  - tools/probe.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. 规格常量 `TYPE_SPEC` / `SEGMENT_GAP_PX` 放模块顶层，`renderPage()` 注入页内脚本。
2. `typePx(px, scale)` 统一档位换算，`MIN_FONT_PX` 兜底。
3. 层级间距全部落在静态 CSS（不随外观预设变化）；字号 / 字重 / 颜色走 `appearanceCss()`。
4. 文节改用 `.llg-seg` 包裹；注音仍是原生 `<ruby><rt>`，靠 `padding-bottom: 4px`
   把注音抬离汉字。
5. v2：控制条竖排贴右下（宽 60px 左右），字幕块保持垂直居中；
   带注音的行用 `:has(ruby)` 把行高提到 2，避免 rt 压到上一行。

## 验证方式

- [ ] `make test`
- [ ] `make build` 与 `make check`（未改 `src/mod`，用于确认没误伤）
- [ ] 真机确认（未做就如实写）：横屏 / 竖屏各看 3 句以上，注音不压行、长句不压控制条
- [ ] 重启 `make cast` 后手机刷新

## 预期量级

3 个文件 / +150 −90 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（本轮改动仍在工作区）
- 验证结果：

  ```text
  $ make test
  ℹ tests 203   ℹ pass 203   ℹ fail 0

  $ make build
  [build] 契约校验  通过  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 版本      1.12.901

  $ make check
  版本    1.12.901
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js

  $ node --check （页面内联脚本）
  inline script OK
  ```

  390×844 静态预览（注入一帧样例：带注音的主字幕 + 译文 + 下文）：
  主字幕 36px / 600，注音 18px / 80% 且悬在汉字上方，译文 24px / 85%，
  下文 20px / 40%，文节之间只有 6px 间距、无竖线；
  字幕块垂直居中，控制条竖排在右侧下方（−5s / 暂停 / +5s / 倍速），
  齿轮在右上、连接状态在左上、底部只剩整片进度条。

- v3（同日追加）：恢复句内进度，但**只铺在日语原文背后**（`.kline` + `#fill-primary`，
  淡蓝 13%），译文不铺；译文固定冷色 `rgba(168, 199, 250, .88)`，与纯白原文区分。
  390×844 预览确认：进度块随 `scaleX` 推进、译文呈浅蓝、原文保持纯白 600。

- v4（同日追加）：控件全部改成图标并收进一个竖排组——
  齿轮、回退 5s（弧箭头 + 5）、播放/暂停、快进 5s（弧箭头 + 5）、倍速（双箭头 + 数值角标），
  组内用分隔线分区；不再有 `−5s` / `+5s` 文字按钮。预览确认触控区 52×38、组高约 240px，
  仍在字幕块下方、不与中央字幕或底部进度条重叠。

- 遗留问题与差异：
  1. **真机未验证**：Safari 下 ruby 的 4px 抬升、`text-wrap: balance` 的两行均衡仍需 iPhone 确认。
  1.1 长句（单行放不下）时进度块宽度会变成整行宽，短句才贴合文字宽度（`max-content` 的必然结果）。
  2. **上文预览默认不显示**：是否渲染由既有的「上下文行数」设置控制（0 无 / 1 只下文 / 2 上下都有），
     默认是 1。规格已按 20px / 40% 写好，切到「上下都有」即生效；本轮没有改默认值，
     避免覆盖用户已存的偏好。
  3. 四套外观预设现在只差字体栈、描边、阴影与字距（字重与底板统一），
     不再有 classic 的模糊底板 / contrast 的行底 —— 这是「去背景修饰」的直接结果。
  4. **需要重启 `make cast`**：页面由服务端现渲染，不重启手机仍会拿到旧页面。
  5. 移除句内蓝底后，PLAN 062 的句内进度修复不再有可视对象；`syncClocks()` 的换句 /
     校准逻辑保留，仍服务于底部整片进度条在拿不到时长时的回退。
  6. 36px 下 390 宽的屏幕一行约 5–6 个汉字（含左右 12px 留白），长句会断成两行；
     这由字号档位（50–150%）决定，设置里下调到 90% 可让一行多放一个字。
  7. 带注音行的行高用 `:has(ruby)` 提高到 2；Safari 15.4 以下不支持 `:has`，
     会退回 1.6（注音可能与上一行贴近）。
