# 041 浮窗设置面板：图标尺寸兜底（语言行巨型箭头）

> 状态：**已完成**

## 需求

用户实机截图：浮窗设置面板里左侧「日本語」被挤成竖排小瓷砖，右侧一个几乎占满窗口的白色大箭头，
同行另一个语言下拉被挤出可视区。要求恢复成正常的「语言 A → 语言 B」一行。

## 根因

设置面板的 `<style>` 是三段拼接（`30-desktop-subtitles.js` 约 3180 行）：

```text
[copied ? '' : PANEL_FALLBACK_CSS] + copied + PANEL_CSS
```

`copied` 是开窗时从官方面板 shadowRoot 里整份拷来的 CSS，取不到（用户没打开过官方面板）就是空串，
此时尺寸全靠 `PANEL_FALLBACK_CSS`。而箭头/雪佛龙的尺寸**只写在官方 CSS 里**：

```text
.lang-pair__arrow { width: 12px; height: 12px; flex-shrink: 0 }
.lang-trigger-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.font-btn svg { width: 14px; height: 14px }
.style-btn__art svg { width: 26px; height: 26px }
.logo-icon { width: 22px; height: 22px }
```

`svgIcon()` 只写 `viewBox`、不写 `width`/`height` 属性，所以兜底路径下这些 `<svg>` 按替换元素默认尺寸
（300×150）渲染：`.lang-pair__arrow` 抢占整行 → `.lang-trigger-name` 没有 nowrap，被压成竖排。
PLAN 036 只给 `.lang-chevron` 补了尺寸，漏了同一类图标。

## 做什么

- 把尺寸规则统一挪进 `PANEL_CSS`（**最后追加**，兜底与官方两条路径都生效）：
  `.lang-pair__arrow` / `.nav-row__chev` / `.lang-chevron` / `.toggle-icon` / `.nav-row__ic` /
  `.mode-row__cyc` / `.logo-icon` / `.font-btn svg` / `.style-btn__art svg`。
- 补 `.lang-trigger-name` 的 `flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`。
- 冒烟测试：扫描 `svgIcon(d, '<class>'` 的所有 class，断言 `PANEL_CSS` 里每条都有 `width`/`height`；
  另外断言 `.font-btn svg` / `.style-btn__art svg` 两条后代规则存在。

## 不做什么

- 不动官方 CSS 拷贝逻辑与 `darkPanelCss()` 的调色板替换。
- 不改面板结构、交互、字幕渲染。
- 不改 fallback 里已有的布局规则（除新增图标尺寸外）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/041-pip-panel-icon-size.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/50-settings-panel.js
  - src/mod/40-study-panel.js
```

## 实现方案

1. `PANEL_CSS` 里把 `.lang-chevron` 那条注释块替换成「图标尺寸」小节，枚举全部由 `svgIcon()` 生成的类。
2. 冒烟测试按上节两条断言。

## 验证方式

- [ ] `node --test tools/test/smoke.test.mjs`（新用例：面板图标尺寸兜底）
- [ ] `make test` / `make build` / `make check`
- [ ] 浏览器人工：断掉官方面板（不打开设置面板）直接开浮窗设置页，语言行应为一行、箭头 12px

## 预期量级

3 个文件 / +70 −8 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里另有 PLAN 032–040 的未提交改动）。
- 验证结果：`node --test tools/test/smoke.test.mjs` 109/109；`make test` 169/169；
  `make build`（契约校验 ✓、注入自检 ✓）；`make check` ✓。
- 新增用例：`桌面字幕：面板图标尺寸写在 PANEL_CSS 里，不依赖官方那份拷贝`。
- 未验证：浏览器实机观感（不打开官方面板直接开浮窗设置页，语言行是否恢复一行）。
- 与预期不符之处：无。
