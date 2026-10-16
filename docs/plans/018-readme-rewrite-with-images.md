# 018 重写 README：补配图、修掉与代码不符的口径

> 状态：**已完成**（Node 侧核对全过；GitHub 页面上的渲染观感属人工确认范围，见文末）

## 需求

用户要求：**重写一份规范的、带图片的 README.md，写完推送。**

现状：`README.md` 是早期版本的产物，只有文字，且有一处与代码不符
（表格里的 `05-format.js` 这个文件在 `src/mod/` 下**并不存在**，导出用的格式化函数
实际在 `40-study-panel.js` 里）。另外新功能（浮窗播放控制栏、注音跟随、面板两种挂载
形态、常驻语义）都没有在 README 里体现。

## 根因（文档类需求，记「为什么现在要改」）

- README 停留在 PLAN 002 前后的口径：命令表缺 `make probe` / `make dev`，
  文件清单缺 `05-ja-segment.js`，多出一个不存在的 `05-format.js`。
- 功能描述只写到「字幕浮窗 + 学习面板」，而 PLAN 004~017 做的事（播放控制栏、
  倍速档位、注音跟随官方、面板寄生进推荐列、常驻语义）读者完全看不到。
- 纯文字、无一张图，读者无法在 10 秒内知道这东西长什么样。

## 做什么

- 重写 `README.md`：定位 → 功能（配图）→ 环境要求 → 起步 → 日常命令 → 工作原理
  （配图）→ 目录结构 → 文件名约定 → 验证方式 → 已知限制 → 开发约定。
- 新增 4 张**手写 SVG** 配图（零依赖、可随主题缩放、纯文本可 diff）：
  - `docs/images/architecture.svg` —— 只读基线 + 增量叠加 → `build.mjs` → `dist/`
  - `docs/images/module-map.svg` —— `src/mod/` 的注入顺序与依赖关系
  - `docs/images/pip.svg` —— 桌面字幕浮窗长什么样（双语行 / 文节分隔符 / 句内进度 / 控制栏）
  - `docs/images/panel.svg` —— 学习面板的两种挂载形态 + 能力清单
- 修正与代码不符之处：删掉 `05-format.js`、补 `05-ja-segment.js`、
  命令表补 `make probe` 与 `make dev`。
- 测试用例数按**实测**写（`make test` → `tests 72 / pass 72 / fail 0`）。

## 不做什么

- 不改任何 `src/**`、`tools/**`、`build.mjs`、`Makefile`、`AGENTS.md`（README 只描述现状，
  现状有出入就照实写，顺手改代码属于另一个 PLAN）。
- 不碰 `vendor/**`、`dist/**`。
- 不新增 Markdown 文件（本次只有本 PLAN 一个），不做 i18n / 英文版。
- 不引入徽章（badge）等外部网络资源 —— 仓库零依赖的调子不因 README 破例，
  配图全部是仓库内的本地 SVG。

## 修改范围

```yaml
allowed_paths:
  - README.md
  - docs/images/architecture.svg
  - docs/images/module-map.svg
  - docs/images/pip.svg
  - docs/images/panel.svg
  - docs/plans/018-readme-rewrite-with-images.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/**
  - tools/**
  - build.mjs
  - Makefile
  - AGENTS.md
```

## 实现方案

1. 先核对事实：读 `Makefile`（命令表）、`build.mjs`（构建步骤与自检）、
   `src/mod/` 实际文件清单、四个模块的注册项（标题/开关/动作）、`make test` 的实际输出。
2. 写 4 张 SVG：`viewBox` 固定、`<style>` 内联在 SVG 里、字体族带 CJK 回退，
   白底圆角外框（在 GitHub 的浅色/深色两种主题下都读得清）。
3. 重写 README，图片用行内 Markdown 引用相对路径（`docs/images/*.svg`）。
4. 门禁：本 PLAN 只动 `*.md` 与 `*.svg`，按 AGENTS.md §5 不需要跑 `make build`
   （但 `make test` 仍跑一遍，为的是拿到写进 README 的真实用例数）。
5. 提交：只 `git add` 本 PLAN 的 `allowed_paths`，不夹带工作区里别的会话的改动。

## 验证方式

- [ ] `make test` 实际输出与 README 里引用的数字一致
- [ ] README 里出现的每个命令都能在 `Makefile` 里找到
- [ ] README 里出现的每个文件名都在 `src/mod/` 下真实存在
- [ ] 4 张 SVG 用浏览器打开无渲染错误（GitHub 侧的最终观感属人工确认范围）
- [ ] `git diff --stat` 只含 `allowed_paths`

## 预期量级

6 个文件 / +260 −40 行（其中 4 个 SVG 是新增）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：本 PLAN 单独一个提交（`README.md` + `docs/images/` 三张新图 +
  `docs/plans/018-*.md`）。工作区里还有别的会话未提交的 `src/mod/*`、
  `tools/test/smoke.test.mjs` 与 PLAN 013~017 / 019，**不在本提交内**。

- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 72
  # pass 72
  # fail 0

  $ git diff --stat --cached
   README.md                                    | 147 ++++++++++----
   docs/images/architecture.svg                 |  86 +++++
   docs/images/module-map.svg                   |  89 +++++
   docs/images/panel.svg                        |  89 +++++
   docs/images/pip.svg                          |  62 ++++
   docs/plans/018-readme-rewrite-with-images.md |  96 +++++
   6 files changed, 547 insertions(+), 22 deletions(-)
  ```

  README 内引用的每一项都做了机械核对（图片路径 / `make` 目标 / `src/mod/`
  文件名是否真实存在），全部 OK：

  ```text
  == 图片引用 ==   OK architecture.svg · module-map.svg · panel.svg · pip.svg
  == make 目标 ==  OK build · check · clean · dev · help · open · probe · test
                   · vendor-from · vendor-update
  == 源码文件 ==   OK 00/05/10/15/30/40/50-*.js · dev-reload.dev.js · dev-reload.sw.dev.js
  ```

  三张 SVG 用 XML 解析器校验语法合法（`xml.dom.minidom.parse` 全过）。

- 遗留 / 与预期不符之处：
  1. **量级超预期**：计划写「6 个文件 / +260 −40」，实际 `+547 −22` —— 差在 SVG 上，
     四张图各 60~90 行（手写矢量图的固有体量），README 正文本身与预期相符。
  2. **只跑 `make test`，没跑 `make build` / `make check`**：本 PLAN 未碰
     `src/**`、`build.mjs`、`Makefile`，按 AGENTS.md §5 取子集即可；跑测试只是为了拿到
     写进 README 的真实用例数（72）。
  3. **GitHub 上的最终渲染观感未验证**：SVG 的字体回退、深浅色主题下的可读性、
     行内 Markdown 图片在窄屏下的缩放，都需要在 GitHub 页面上人工看一眼。
  4. **修掉了原 README 的一处事实错误**：文件清单里的 `05-format.js` 不存在
     （导出格式化函数实际在 `40-study-panel.js` 内，通过 `__llgModPanel` 暴露）。
     本次只改 README 的描述，没有动代码。
  5. 未加徽章（badge）等外部网络资源：配图全部是仓库内的本地 SVG，
     保持「零依赖」的口径。
  6. 编号：原想用 018，落盘时确认 018 未被占用（另一会话已占用 019），沿用 018。
