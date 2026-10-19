# 036 浮窗设置面板：修掉「割裂」+ 语言箭头撑爆 + 进度条回退

> 状态：**已完成**

## 需求

用户实机截图反馈三点：

1. 浮窗里的设置面板与窗口观感割裂：窗口是暗的，面板是整张亮色卡片。
2. 语言那一行被撑成两块巨大瓷砖（截图顶部两个大灰箭头 + 小国旗），排版崩了。
3. 句内进度条还是 PLAN 035 之前的「文字身后蓝色扫过」那种更好，回退。

## 根因

1. **割裂**：面板 CSS 是从官方面板 shadowRoot 整份拷来的。官方跟系统主题走 —— 系统亮色时
   拷进来的就是亮色 CSS，而浮窗底色固定 `#141518`，于是白卡片浮在暗窗口里。
   另外面板 `max-width:360px` 居中，左右留两条暗边，进一步放大「漂浮卡片」感。
2. **巨型箭头**：官方 `.lang-chevron` **没有** width/height（它靠模板里的
   `<svg width="10" height="10">` 属性定尺寸）。我们用 `svgIcon()` 生成时只给了 class，
   没有这两个属性 → SVG 按默认 300×150 渲染，把 `.lang-trigger` 撑成截图里的大瓷砖。
3. **进度条**：PLAN 035 按设计稿改成「主字幕下方 3px 细条」，实机手感不如原来的整行填充。

## 做什么

- `darkPanelCss()`：把拷来的亮色调色板字面量换一套暗色值（官方 CSS 没有变量，只能换字面量）。
  已经暗色时原样返回；写死的投影（`rgba(0,0,0,0.15)`）不动。
- 面板铺满窗口：去掉 `max-width` / 圆角 / 边框 / 投影，底色与窗口同为 `#141518`，
  `#settings` 去掉外边距。
- 补 `.lang-chevron { width:10px; height:10px }`。
- 亮色里把 `#FFFFFF` 当「面」的两处（语言菜单、分段控件选中态）直接钉成暗色值。
- 进度条恢复 `.kfill` 铺满文字身后的蓝色半透明底（`rgba(10,132,255,.16/.11)`）。

## 不做什么

- 不改播放控制、字幕数据、官方设置写回逻辑。
- 不改浏览器自绘的 PiP 窗口标题栏（`Back to Tab` / `Close` 不在我们文档里）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/036-pip-panel-dark-and-chevron-fix.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/15-ja-break.js
  - src/mod/50-settings-panel.js
```

## 验证方式

- [x] `node --test tools/test/smoke.test.mjs`（新增 `darkPanelCss` 单测）
- [x] `node --test tools/test/contract.test.mjs`
- [x] `make build` / `make check`
- [ ] 浏览器人工：暗色面板、语言行恢复正常高度、进度条回到扫过式

## 预期量级

2 个文件 / +90 −25 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 验证结果：smoke 103/103、contract 3/3、`make build` 与 `make check` 通过。
- 未验证：实机观感（暗色转换后是否有遗漏的亮色元素、语言行高度、进度条）——需人工确认。
- 注意：PLAN 035 里「3px 细条」一节已被本 PLAN 回退，其余（注音间距、分隔符淡化、
  上下文 0.7×、控制栏 34px）保留。
