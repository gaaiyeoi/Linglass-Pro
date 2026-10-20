# 067 手机字幕屏：选句直接做在字幕上，不再弹浮层

> 状态：已完成

## 需求

在手机字幕屏（tools/cast-page.mjs）上下滑动选句时，会弹出一张盖住整屏的浮层：
深色遮罩、另一个字号的五行候选句、中间一行高亮。反馈是这个浮层「像在操作另一个
界面」，希望在**原来的字幕上**选句。

## 做什么

- 删掉 `#picker` 覆盖层（遮罩 + 卡片 + 五行候选 + 顶部提示）。
- 手势改为直接驱动字幕位：候选句写进现有的 `#plate`（`#line-primary` /
  `#line-secondary`），上下句继续用现有的 `#prev` / `#next`，字号、颜色、投影
  全部沿用当前外观设置。
- 选中态只用一层极淡的蓝底 + 内描边标在 `.kline` 上，不改变字号与位置，
  因此打开选句的瞬间画面没有跳动。
- 新增唯一界面元素：底部一行 `0:42 · 早 3 句` 说明（`#pick-badge`），
  松手后 300ms 仍可见，然后发 `seek` 并收起。
- 拖动期间 `render()` 跳过文字更新，只刷控件与状态；否则 250ms 一帧的推送
  会把手里的候选句抢回正在播的那句。
- 收起时立刻用上一帧推送恢复实时字幕（推送迟到 / 断流也不会把候选句留在屏上）。

## 不做什么

- 不改 seek 的命令格式、300ms 延时、46px/句的手感阈值。
- 不动 PiP（桌面浮窗）的滚轮选句 —— 那边仍是原有的五行浮层实现。
- 不改 `cueHistory` 兜底、`pickBlocked` 防误触（PLAN 064）。
- 不给候选句补译文：`cues` 窗口只有 `[start, primary]`，凭空配一句中文会错位；
  只有「打开选句那一刻正在播」的那句带原文对应的译文。

## 根因

PLAN 045 把选句实现成独立浮层（`#picker`：全屏 76% 黑遮罩 + 居中卡片 +
16/21px 的另一套字号）。它不是字幕的一部分，滑动时视线要从字幕跳到屏幕中央
再看回字幕，且候选句的排版与字号和字幕本身不一致，读起来像两份不同的文本。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/067-cast-pick-on-subtitle.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
```

## 实现方案

1. CSS：删掉 `#picker / .picker-*`，新增 `#stage.picking .kline`（淡蓝底 +
   内描边）与 `#pick-badge`。
2. DOM：删掉 `#picker` 结构，新增 `<div id="pick-badge"><span id="pick-badge-text">`。
3. 状态：`pickerOpen / pickerList` → `picking / pickList`；新增
   `pickAnchorIndex / pickAnchorStart / pickAnchorSecondary`，在打开选句时冻结
   实时句，避免拖动期间视频继续播放导致「第几句」「有没有译文」漂移。
4. `paintPick()`：把候选句写进 `#line-primary`（纯文本）、按 `prefs.ctx` 决定
   上下句、写 `#pick-badge`；`lastCurKey` 置空，交回推送时按 segments 重建原文。
5. `openPick()` / `closePick()`：只切 `#stage.picking` 与徽标，不新建任何层；
   关闭时 `applyLineText(lastPayload.cur)` + `applyPrefs()` 恢复。
6. `render()`：`picking` 期间只调 `paintControls` / `setStatus` 后返回。

## 验证方式

- [x] `make test`：新增静态断言（无 `#picker`、候选句写进 `#line-primary`、
      拖动期间推送不抢文字、关闭时恢复实时字幕）；PLAN 064 的 `pickBlocked`
      断言保持通过。211/211 通过。
- [x] `make build`、`make check`：契约校验与注入自检无告警。
- [ ] 真机：上滑时字幕原位变蓝、候选句随手指翻动、松手跳转 —— 未实测。

## 预期量级

2 个文件，约 +90 / −70 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：待提交
- 验证结果：`make test` 211 通过；`make build` / `make check` 通过。
- 遗留问题与差异：
  - 真机手势与观感未人工确认（Node 侧只能覆盖生成出来的结构）。
  - 候选句的长句仍需按 `fitLine` 缩字号（与实时字幕同一套规则），
    极端长句在拖动时会看到字号变化。
