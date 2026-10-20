# 057 README 配图：补 AI 翻译示意图，更新浮窗设置面板

> 状态：**已完成**
>
> 编号说明：原为 042，与 `042-cast-remote-controls.md` 重复，2026-10-20 改为 057。

## 需求

README 这一轮补了「AI 翻译」整节，但那一节没有配图；同时 `docs/images/pip.svg` 还停留在
PLAN 033 之前的形态（点 `Aa` 出现「样式条」），与现在的**整页设置面板**、**整片进度条**不符。

## 做什么

- 新增 `docs/images/ai-translate.svg`：学习面板页脚入口 → AI 翻译弹层（服务商 / 接口地址 /
  模型 / Key / 目标语言 / 两个复选项 / 开始与停止）→ 结果流向（面板、浮窗、导出）。
- 重绘 `docs/images/pip.svg`：上半是浮窗本体（三段字幕、句内填充、控制栏上方的整片进度条、
  控制栏），下半是点 `Aa` 之后的整页设置面板（根页 + `Linglass-Pro` 分组）。
- `README.md`：AI 翻译一节插入配图；「三个开关」改为覆盖四项功能的说法。

## 不做什么

- 不改任何 `src/mod/**`、`tools/**`、`build.mjs`、`Makefile`。
- 不改动图里尚未实现的交互（例如不画同步模式页、不画 AI 块进浮窗设置面板）。

## 修改范围

```yaml
allowed_paths:
  - README.md
  - docs/images/ai-translate.svg
  - docs/images/pip.svg
  - docs/plans/042-readme-images-ai-translate-and-pip-panel.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
  - tools/**
```

## 验证方式

- [x] 两个 SVG 均能被 `xmllint` 解析
- [x] `rsvg-convert` 渲染成 PNG 目视检查（文字不重叠、无溢出、暗底文字可见）
- [x] `make test` 168 例全绿（核对 README 里的数字）
- [x] `git diff --stat` 与预期量级相符
- [x] 只碰了文档，按 AGENTS.md §5 不跑构建门禁

## 预期量级

4 个文件 / 新增 1 个 SVG，改 1 个 SVG 与 README

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 验证结果：`xmllint` 通过；`rsvg-convert -w 1440` 渲染后逐张目视检查；
  `make test` 168 例全绿（与 README 描述一致）。
- 遗留：AI 弹层里的字段宽度、设置面板里的开关状态是示意值，不随真实配置变化。
