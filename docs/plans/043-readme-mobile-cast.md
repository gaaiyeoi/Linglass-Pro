# 043 README 补手机字幕屏一节

> 状态：**已完成**

## 需求

README 的功能表与目录都没有手机字幕屏（`35-cast.js` / `tools/cast-server.mjs`），
用户指出「怎么没有手机的部分」。

## 做什么

- 功能表加一行「📱 手机字幕屏」，并把「三大功能总览」图注改为「功能总览」。
- 新增「📱 手机字幕屏」一节：启动命令、手机打开地址、扩展侧开关位置、
  手机端可调项与「添加到主屏幕」，以及房间号 / 无鉴权 / 换端口三条说明。
- 新增 `docs/images/cast.svg`：Mac 扩展 → 本机 8899 中转 → 手机（SSE）示意。
- 日常命令表补 `make cast` / `make cast-demo`；模块表补 `35-cast.js`、`35-cast.sw.js`；
  目录结构的 `tools/` 一行补 cast-server / cast-page；已知限制补两条。

## 不做什么

- 不改任何代码与测试，不改 `Makefile` / `build.mjs`。
- 不重画 `overview.svg`（它的三个格子仍是示意图，图注已去掉「三大」）。

## 修改范围

```yaml
allowed_paths:
  - README.md
  - docs/images/cast.svg
  - docs/plans/043-readme-mobile-cast.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
  - tools/**
```

## 验证方式

- [x] `xmllint` 解析 `cast.svg`
- [x] `rsvg-convert -w 1440` 渲染目视检查（底部说明不越界）
- [x] 文中命令、端口、接口名与源码核对：`make cast` / `make cast-demo`、
  `PORT` / 默认 8899、`__llgModCast.setConfig`、`Linglass-Pro` 分组里的
  「手机字幕屏」「测试手机字幕屏连接」

## 预期量级

3 个文件 / README +31 行，新增 1 个 SVG 与 1 份 PLAN

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 验证结果：见上（三条均已跑）。
- 遗留：手机端截图不放进仓库，图是矢量示意。
