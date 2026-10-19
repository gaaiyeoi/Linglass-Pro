# 038 桌面字幕浮窗：默认开窗尺寸放大

> 状态：**已完成**

## 需求

默认宽度大一点，高度也加大一点。

## 做什么

- `PIP_WIDTH` 700 → **860**（约能放下一行 30 个日文字符，长句换行少一些，控制栏也不那么挤）。
- `pipHeight()` 的结果加 **48px** 呼吸位（`PIP_HEIGHT_EXTRA`）。这 48px 会落到 `#stage`
  的 flex 空间里，字幕仍垂直居中，只是上下更松。
- 同步更新「开窗尺寸」用例的边界（高度 220–300、宽度 ≥ 840）。

## 不做什么

- 不记忆用户手动拖过的窗口尺寸（Document PiP 每次开窗都按默认值来）。
- 不动字号规则（字号仍不跟窗口走）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/038-pip-default-size.md

forbidden_paths:
  - vendor/**
  - dist/**
```

## 验证方式

- [x] `node --test tools/test/smoke.test.mjs`
- [x] `make build` / `make check`
- [ ] 浏览器人工：默认窗口在 1080p / 2K 屏上的观感

## 预期量级

2 个文件 / +15 −6 行

## 完成情况

- 验证结果：smoke 107/107、`make build` 与 `make check` 通过。
- 未验证：不同缩放 / 分辨率下的实际观感。
