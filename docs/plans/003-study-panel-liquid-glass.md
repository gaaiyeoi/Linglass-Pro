# 003 学习面板：换成 Linglass 的「液态玻璃」观感

> 状态：**已完成**（Node 侧门禁全绿；观感需人工确认，见文末）

## 需求

侧边学习面板（`40-study-panel.js` 建的页面内 Shadow DOM 面板）看起来是「我们自己的深色面板」，
不像 Linglass 原生的那块玻璃。要求：观感与 Linglass 一致（半透明玻璃、模糊 + 饱和、
发丝级描边、柔和投影、官方圆角与缓动）。

## 根因

官方那套设计令牌是 `--lg-*`（颜色 / 描边 / 投影 / 文字层级）与 `--glass-*`（模糊 + 饱和），
定义在**它自己的样式作用域**里（`vendor/linglass-1.12.3/src/content/translate/styles.css`、
`assets/sidepanel-*.css`）。我们的面板拿不到它们，有两重原因：

1. **`:host { all: initial }`**（`40-study-panel.js:47`）把宿主上的一切可继承属性重置为初始值，
   **自定义属性也一起被重置**（`all` 覆盖全部属性，含 custom property）。
2. 面板挂载点是 `document.body`（:277），而官方的 `:root` 块定义在它自己的 shadow root /
   侧边栏文档里，**不会**出现在 YouTube 页面的 `:root` 上。

所以现存的 `var(--radius-sm, 8px)` / `var(--duration-normal, .2s)` / `var(--ease-out, ...)`
**永远走兜底值**，"复用 Linglass 的 CSS 变量"这条设计意图实际从未生效
（文件头注释 :13 就是这么写的，属实现与注释不符）。

**证据**：`40-study-panel.js:47`（`all: initial`）、`:68`、`:104`、`:110`、`:134`、`:137`
（四处 `var(--…)`）；`grep -- '--radius-sm:' vendor/linglass-1.12.3` 只在官方产物里命中，
我们的源码里一个定义都没有。

## 做什么

- 把官方的玻璃令牌**显式抄成我们自己的 `--llg-*`**，定义在 `.panel` 上（`all: initial` 之后，
  所以我们自己必须给全），取值来自 `vendor/linglass-1.12.3` 实测：

  | 用途 | 令牌 | 深色取值（官方） |
  | --- | --- | --- |
  | 玻璃底 | `--lg-bg-glass` | `rgba(28, 28, 30, .92)` |
  | 抬起玻璃 | `--lg-bg-glass-elevated` | `rgba(28, 28, 30, .92)` |
  | 模糊/饱和 | `--glass-blur` / `--glass-saturate` | `blur(20px)` / `saturate(180%)` |
  | 高光渐变 | `--lg-glass-overlay` | `linear-gradient(135deg, rgba(255,255,255,.06), rgba(255,255,255,.02))` |
  | 描边 | `--lg-border-subtle` / `--lg-border-default` | `rgba(255,255,255,.08)` / `.12` |
  | 分隔线 | `--lg-divider` | `rgba(255,255,255,.06)` |
  | 投影 | `--lg-shadow-glass` / `--lg-shadow-elevated` / `--lg-shadow-soft` | `0 2px 12px rgba(0,0,0,.2)` / `0 8px 32px rgba(0,0,0,.4)` / `0 4px 16px rgba(0,0,0,.3)` |
  | 行 hover | `--lg-row-hover` | `rgba(255,255,255,.04)` |
  | 次级按钮 | `--lg-button-secondary` / `-hover` | `rgba(255,255,255,.08)` / `.15` |
  | 强调色 | `--lg-accent` / `--lg-accent-light` | `#0A84FF` / `rgba(10,132,255,.15)` |
  | 文字层级 | `--lg-text-primary/secondary/tertiary/quaternary` | `#FFFFFF` / `#8E8E93` / `#8E8E93` / `#AEAEB2` |
  | 圆角 | `--radius-md` / `--radius-sm` | `12px` / `8px` |
  | 缓动 | `--duration-normal` / `--ease-out` | `.2s` / `cubic-bezier(0, 0, .2, 1)` |

- 面板结构与布局**完全不动**，只换视觉令牌与 `backdrop-filter`
- 加一层 `::before` 玻璃高光（`--llg-glass-overlay` + `inset 0 0 0 1px` 发丝描边），
  让边缘有"液态玻璃"的折光感
- 按官方口径补一套浅色值：`@media (prefers-color-scheme: light)`
  （官方 `--lg-bg-glass: rgba(255,255,255,.72)`、`--lg-text-primary: #1D1D1F`、
  `--lg-accent: #007AFF` 等）
- 新增测试：源码里出现的每个 `var(--llg-…)` 都必须在同一个文件的 CSS 里有定义
  （纯文本级检查，防拼错与"兜底值永远生效"的原病复发）

## 不做什么

- 不改面板的 DOM 结构、`data-role`、交互（拖拽改宽、点击跳转、导出、toast）
- 不改列表/舞台的排版尺寸（字号、内边距、行高保持原样，本轮只谈"玻璃"）
- 不引入 CSS 文件或构建步骤（样式仍内联在 JS 里，`dist` 是"叠加"而非"打包"）
- 不去改官方产物或给页面注入全局样式
- 不动 `30-desktop-subtitles.js`（浮窗自己那套黑底 CSS 不在本轮范围）
- 不新增依赖、不动 `vendor/`

## 修改范围

```yaml
allowed_paths:
  - src/mod/40-study-panel.js
  - tools/test/smoke.test.mjs
  - docs/plans/003-study-panel-liquid-glass.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - build.mjs
  - Makefile
```

> `contract.test.mjs` 不改：本轮只换自有样式的取值，没有新增对官方 DOM 的依赖。
> `.row.is-active` 已在 `SELF_OWNED` 里登记。

## 实现方案

1. `PANEL_CSS` 顶部加 `--llg-*` 定义块（`.panel { … }` 内，深色为默认）
2. 把现有四类硬编码值替换成令牌：
   `background` / `backdrop-filter` / `border-*` / `box-shadow` / `color` /
   `border-radius` / `transition`
3. 加 `.panel::before`（高光 + 发丝边）+ `.panel > *` 的 `position: relative`（避免遮住内容）
4. 加 `@media (prefers-color-scheme: light)` 覆盖块
5. `tools/test/smoke.test.mjs` 加一条源码级断言

## 验证方式

- [ ] `make test`（新增 1 条令牌定义完备性用例）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：`make probe --headed` 的面板检查（宽度/状态/样式存在性）＋ 肉眼比对
      与官方设置面板的观感

## 预期量级

2 个文件 / +110 −35 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交**（见 PLAN 001 的说明）
- 验证结果（实际输出）：

  ```text
  make test   →  ℹ tests 35   ℹ pass 35   ℹ fail 0
  make build  →  契约校验 ✓；注入自检通过；版本 1.12.900
  make check  →  已注入 7 个 mod 脚本
  ```

  新增用例：`学习面板：玻璃令牌都有定义，且不引用拿不到的官方变量`
  （既查「引用了却没定义」，也查「引用官方那套拿不到的变量」——
  后者是这条 bug 的根因，防它复发。只看 `PANEL_CSS` 那段，避免把注释里的反例写成误报。）

- 遗留 / 与预期不符之处：
  1. 玻璃令牌是 `vendor/linglass-1.12.3` 的**手工副本**（20+ 个 `--llg-*`）。
     官方改版时这份副本不会自动跟随 —— 表现为观感慢慢走样，**不影响功能**。
     真要自动化就得在构建期从 vendor 抽变量，那是新增机制，得另立 PLAN（§1）。
  2. 只抄了**视觉上必需**的那批。官方还有 `--lg-bg-glass-elevated`、`--lg-shadow-*` 等
     分档，本面板用不到就没搬（避免一堆没人引用的死令牌）。
  3. **观感只能人工比对**：Node 侧只能验「令牌有定义」。
     `make probe --headed` 能验面板宽度、`hasStyle`、状态切换，**验不了「像不像 Linglass」**。
  4. 顺带修了文件头一句**错的注释**：原文称「能直接复用 Linglass 的 CSS 变量
     （会穿透 shadow 继承）」—— 实测不成立（`:host{all:initial}` + 挂载在 `document.body`）。
     按 AGENTS.md §6，与既有口径不一致的发现登记在此，而不是静默改掉。
  5. `.panel::before` 只承担高光与发丝描边，`pointer-events: none`，
     不会影响 `.resize`（z-index: 2）与底部按钮的点击。
