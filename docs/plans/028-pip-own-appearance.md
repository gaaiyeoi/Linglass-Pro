# 028 桌面字幕浮窗：浮窗自己一套样式（可在浮窗里直接调）

> 状态：**已完成**（`make test` / `make build` / `make check` 全绿；浏览器内视觉待人工确认）

> ⚠️ 编号说明：本文原本编号 027，写完 PLAN 后工作区里出现了另一份
> `027-pip-window-resizable.md`（不是本轮创建的，会话开始时也不存在），故改号 028。

## 需求

浮窗现在的外观完全由官方「外观」设置页决定（PLAN 008）：能用，但**调不了** ——
想改字号 / 样式 / 颜色 / 双语，必须切回浏览器、点开 Linglass 的设置面板。
而桌面字幕的典型用法（全屏、最小化浏览器、浮窗留在桌面上）里，浮窗是手边唯一的东西。

期望（用户原话「我还是希望能够在浮窗里面弄一套单独的调整样式」，并在两种口径中选了
**完全独立**）：**在浮窗里就能直接调一套属于浮窗的样式**，改完立刻生效、下次打开还在；
官方外观页那边怎么改都与浮窗无关。

## 做什么

- 浮窗控制栏右端加一个 `Aa` 按钮：点它把控制栏整条**换成样式条**（同一位置、同一高度，
  点 `✓` 换回）。选这个形态的原因：**不增加浮窗高度、不遮挡字幕、不需要 resize 系统窗口**
  （PLAN 027 遗留 6 的「大字号顶到控制栏」不受影响）。
- 样式条内容（一行，浮窗默认 1000px 宽放得下）：

  | 控件 | 行为 |
  | --- | --- |
  | `A−` / 当前档位 / `A+` | 字号档位 50–150、step 10（与官方同一套档位，省得学两套） |
  | 经典 / 影院 / 漫画 / 对比 | 四个样式预设（`classic`/`cinema`/`comic`/`contrast`），当前项高亮 |
  | 四个色块 | 官方色板 `#FFFFFF` / `#FFD60A` / `64D2FF` / `#30D158`，当前项高亮 |
  | `CC` | 双语开 / 关（浮窗自己的开关，不再只能跟官方） |
  | `↺` | 把官方**此刻**的设置重新拷一份当浮窗样式 |
  | `✓` | 收起样式条，回到播放控制栏 |

- 落盘：`chrome.storage.local['llgPipAppearance']`，存**完整的四项**
  （`{style, scale, color, dual}`）。**首次打开时**从官方外观页拷一份当前值当初始值并落盘；
  此后官方再改都不动 —— 完全独立之后缺项没法再去官方补，所以一存就存全。
- 生效链路：`appearance = composeAppearance(own, langs)`；样式条上改一下 →
  立刻重画整张样式表 + 落盘。
- 纯函数 + 测试钩子：`parseOwn()` / `seedFrom()` / `composeAppearance()` / `clampScale()` /
  `stepScale()`；`__llgModPip` 加 `appearanceOwn` / `setAppearanceOwn` / `resetAppearance` /
  `parseOwn` / `stepScale` / `barMode` / `STYLE_CHOICES` / `COLOR_PRESETS`。

## 不做什么

- **不给浮窗发明官方没有的外观维度**：不做自定义取色器（只用官方 4 档色板）、
  不做字体选择、不做底板不透明度、不做垂直位置（浮窗是系统窗口，没有「离播放器多远」）。
- **不碰原生字幕**：不往官方 shadow DOM 注入样式，不改 `15-ja-break.js` /
  `10-subtitle-track.js`。本轮只改浮窗自己的渲染。
- **不把浮窗的样式写回官方 `storage.sync`**：那会污染官方面板，且官方 render 会覆盖它。
- 不在官方面板里加「浮窗样式」的行（`50-settings-panel.js` 不动）：入口就在浮窗里。
- 不改常驻语义（PLAN 001 / 022）、不改播放控制栏的行为（PLAN 004）、
  不改进度条与注音渲染（PLAN 002 / 017）。
- 不新增依赖、不动 `build.mjs` / `Makefile` / `tools/probe.mjs`。

> 与 PLAN 008 的关系：008「不做什么」里那两条（**不给浮窗单独做字号滑块、不给浮窗调色板**）
> 由本 PLAN 明确取代。008 的其余结论继续有效 —— 照搬官方四预设的排版规则、
> 字号**固定 px 不随窗口尺寸**、分隔符节点化。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/028-pip-own-appearance.md
  - README.md            # 原「观感跟随官方」一条与本 PLAN 的新口径不符，必须同步

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/test/contract.test.mjs
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

> `contract.test.mjs` **没改**（与本文原先的预估一致）：本轮新增的记号
> （`llgPipAppearance`、`pip-style-*` / `pip-color-*` 等 id、中文标签）都是我们自己的东西；
> 新引用的颜色字面量（`#FFD60A` 等）被 `isColorLiteral()` 排除；样式条那些 CSS 写在
> 模板字符串里，选择器都是我们自己的 `#stylebar` / `#scale-val`，不触发漏登记检测。
> 已实测：`make test` 的契约用例全绿。

## 实现方案

1. **数据（纯函数）**：`APPEARANCE_KEY`、`SCALE_MIN/MAX/STEP`、`STYLE_CHOICES`、
   `STYLE_LABELS`、`COLOR_PRESETS`、`HEX_COLOR`；`clampScale()` 把档位夹到 50–150 的档位上；
   `stepScale()` 按档位加减；`ownOf()` 从完整外观里摘出浮窗持有的四项；
   `parseOwn()` 逐项校验 + 逐项兜底（一项脏数据不牵连其余三项，整个值读不成则返回 `null`
   表示「没存过」）；`seedFrom()` = `parseOwn(ownOf(official))`，让**播种与落盘走同一道校验**
   —— 官方那份也可能被写坏（未知预设名、档位缺失、颜色乱填）。
2. **读盘**：`loadAppearance()` = `Promise.all([readLocal(APPEARANCE_KEY), readOfficial()])`
   → 有落盘就用落盘；没有就拿官方当前值 `seedFrom()` 播种（`applyOwn` 顺手落盘）。
   语言（`learningLanguage` / `nativeLanguage`）每次都与样式一起读出来，但**单独存**。
3. **写盘**：`applyOwn(next)` = 落盘 + `applyAppearance(composeAppearance(own, langs))`，
   是浮窗外观的**唯一写入口**；`setOwn(patch)` 合一项并回显；`resetAppearance()` =
   `setOwn(seedFrom(officialAppearance))`。
4. **官方的变更只取语言**：`applyOfficialAppearance()` 比对 `langs`，变了才重画
   （样式 / 字号 / 颜色 / 双语一律不动 —— 完全独立）。语言是刻意的例外：换了学习语言，
   字体栈与 CJK 的字号比例必须跟着换，否则浮窗会拿错字面。
5. **UI**：`buildWindow()` 把 `#bar` 与 `#stylebar` 放进同一个 `#bars` 容器；
   `setBarMode('play'|'style')` 只切两者的 `display`（**先比较再写**，遵守 AGENTS.md §3 的
   幂等规矩）；`syncStyleBar()` 回显档位数字、选中的预设 / 色块 / 双语（选中态用 `data-on`，
   节点引用存在 `styleNodes` 里 —— 桩件没有选择器引擎，样式条又是我们自己造的）。
6. **动作**：`appearanceCommand(act)` 处理 `appearance` / `scale±` / `style:<名字>` /
   `color:<#RRGGBB>` / `dual` / `reset`，放在 `command()` 的 video 闸门**之前**
   （调字号跟播放器无关）；不认得的预设名与色板外的颜色**直接不生效、不落盘**。
7. **样式**：`#stylebar` / `#bars` / `#scale-val` / `.swatch` / `[data-on]` 加进
   `PIP_BASE_CSS`。控制栏那条 `#bar button` 规则**一字不动**（既有用例钉着它的形态），
   样式条的按钮声明另写一份。
8. **README**：第 21 行「观感跟随官方」按新口径改写。

## 验证方式

- [x] `make test`（新增 / 改写用例见下）
- [x] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed` 或肉眼）：
      `Aa` → 调字号 / 样式 / 颜色 / 双语**立即**生效；关掉浮窗重开、刷新页面后值还在；
      官方外观页改一项 → 浮窗里没调过的项也**不跟**；`↺` 后回到官方当前值

### 既有断言的改写（按 AGENTS.md §3 登记）

两条旧用例固化的是 PLAN 008 的**旧语义**（「浮窗跟随官方外观页」），本 PLAN 刻意把它换成
「完全独立」，所以断言必须改，并且每条都补了复现新语义的断言：

| 旧用例 | 处理 |
| --- | --- |
| `桌面字幕：字号来自官方档位，且不随浮窗尺寸变` | 拆成 ① `浮窗外观首次从官方拷来当初始值，之后官方再改都不动`、② `落盘里有浮窗外观时就用它`、③ `官方那份读不成/读坏了时，播种用默认值`（保留「字号不随浮窗尺寸变」这条断言） |
| `桌面字幕：颜色、样式预设、双语都跟着官方外观走` | 改成 `样式条上改字号/预设/颜色/双语立即生效并落盘`（预设排版那几条断言原样保留） |

新增用例：`样式条与控制栏互斥，字幕区一个节点都不动`、
`↺ 把官方当前的设置重新拷一份当浮窗样式`、`语言仍然跟随官方`、
`落盘里的浮窗外观被写坏时逐项夹回合法值`。

## 预期量级

3 个文件 / +300 −60 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：待定（未提交）
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 122   ℹ pass 122   ℹ fail 0

  $ make build
  [build] 基线      vendor/linglass-1.12.4
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js
  [build] 版本      1.12.900

  $ make check
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js

  $ git diff --stat
   README.md                       |   2 +-
   src/mod/30-desktop-subtitles.js | 451 +++++++++++++++++++++++++++++++++-
   tools/test/smoke.test.mjs       | 234 ++++++++++++++++++++++++++++--
  ```

- 遗留 / 与预期不符之处：
  1. **量级比预估大**：`30-desktop-subtitles.js` 净增约 400 行（预估 +300 −60 是三个文件
     合起来估的），主要来自样式条节点构建、外观数据层与注释。没有超出业务范围。
  2. **浏览器视觉未验证**：`Aa` 的观感、色块与选中态、窄窗口下样式条会不会挤成一团、
     13 个控件的实际手感 —— 全部属于人工确认范围，本轮按用户既往要求没有启动浏览器。
  3. **档位上限 150%**：与官方一致，没给浮窗放宽（独立之后其实可以更宽）。
     若想要 200%，改 `SCALE_MAX` 一处即可 —— 但那会同时影响 `↺` 之后的落盘值域。
  4. **`↺` 的语义变了**：从「清掉覆盖」变成「把官方此刻的设置重新拷一份」，
     因为完全独立之后没有「覆盖」这层概念了。
  5. **官方 `subtitleVerticalOffset` 仍然不做**（浮窗是系统窗口，没有「离播放器多远」）；
     `subtitleBackground` 在 1.12.4 已降级为派生字段（官方注释：plate is one property of
     a preset now），所以浮窗不读它是对的 —— 已在代码注释里记下。
  6. **编号冲突**：本文原为 027，工作区里出现了另一份 `027-pip-window-resizable.md`
     （非本轮创建），故改号 028。两份 PLAN 的文件重叠（同样改
     `30-desktop-subtitles.js` / `smoke.test.mjs`），提交时要注意别把两份改动裹成一个提交。
