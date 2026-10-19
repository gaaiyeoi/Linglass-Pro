# 033 浮窗设置面板：完整镜像官方设置 + 我们的开关

> 状态：**执行中**

## 需求

桌面字幕浮窗（PiP）里现在只有一条 `Aa` 样式条，能调的只有字号 / 预设 / 颜色 / 双语，
而且从 028 起这套外观是浮窗独立维护的副本。用户要求：

> 浮窗的设置需要包含 Linglass 原生的所有设置 + 我们自己加的设置，以及需要样式相同。

确认过的三条口径：

1. **生效范围 = 写回官方设置**。浮窗里改样式 / 字号 / 颜色 / 双语 / 语言 / 开关，
   写进 `chrome.storage.sync['linglass-settings']`，页面内嵌字幕与官方设置面板同时变化。
2. **覆盖清单 = 全量镜像**：根页 + 外观页 + 观看模式页（YouTube 上官方实际显示的页），
   语言下拉、分段控件、预设瓷砖都复刻；不含 AI 块、下载、账号/注册提示。
3. **形态 = 整页设置面板**：点 `Aa` 后字幕区整块换成设置面板（可滚动、带标题与返回），
   原生 CSS 从官方面板实时拷贝，观感 1:1。

## 做什么

- `Aa` 不再展开样式条，而是把浮窗切成「设置页」：隐藏 `#stage` 与 `#bar`，显示 `#settings`；
  面板头部的 `×` 回到字幕，子页用 `<` 返回上一页。
- 面板 DOM 结构复刻官方：`.settings-panel(-open) > .panel-header + .panel-stack >
  .panel-pages > .panel-page[data-page]`。
- **样式来源**：打开面板时从官方 `#linglass-settings-panel-v2` 的 shadowRoot 里取
  `<style>` 的全文，整份拷进 PiP 文档（含当前主题解析后的颜色）；再追加一小段我们自己的
  覆盖规则（页宽、单页显示、滚动、下拉菜单内联）。取不到时退回一段内置的紧凑骨架样式。
- 根页（对应官方面板 root）：
  - 学习语言 → 母语：两个下拉（国旗 + 名称 + 展开列表）
  - `Linglass 字幕` 总开关（`enabled`）
  - `双语字幕`（`dualSubtitles`）
  - `词语上方显示读音`（`readingMode`）+ 脚本分段控件（ja / zh / ko / th）
  - `配图`（`mediaCaptureEnabled`，YouTube 门控）
  - `观看模式` / `外观` 两个 nav-row（右侧显示当前值）
- 外观页：4 个预设瓷砖 + 说明行、`A− / A+` 字号、4 个色块、`字幕位置复位`
  （`subtitleVerticalOffset !== 0` 时出现，与官方一致）。
- 观看模式页：4 个模式瓷砖 + 说明、参数循环行、`翻译时暂停` / `视频上的提示` 两个开关。
- 我们的分区（标题沿用 `Linglass-Pro`）：`字幕句内断句`、`学习面板`、`桌面字幕浮窗`
  三个开关，以及学习面板的动作行（导出 Markdown）——数据来自 `shared.listFeatures()`，
  与官方面板里的分组同一份注册表。
- 浮窗自己的设置只剩 `上下文行数`（0/1/2），放在外观页里，用原生 `nav-row` 呈现。
- 写回官方：`{state: {...已有 state, ...patch, fontSize}, version: 4}` 保证串行（链式
  Promise），`fontSize = clamp(round(scale/100*24), 12, 32)`（官方 `ma()` 的口径）。
- 监听 `chrome.storage.sync` 的 `linglass-settings` 变化：面板回显与浮窗外观立即跟着改。
- 迁移：`llgPipAppearance` 只保留 `ctxLines`；旧值里的 style/scale/color/dual 忽略
  （它们已经以官方设置为唯一真相）。

## 不做什么

- **不做同步模式页**：官方在 YouTube 上不显示它（`In` 门控为 netflix/iqiyi/hbomax/
  crunchyroll），照官方门控不渲染。
- 不做 AI 翻译块、下载页、通知、热键卡、注册提示——用户明确排除「AI/下载/账号」。
- 不做字幕垂直位置（PiP 是系统窗口，没有「离播放器多远」）。
- 不改 `50-settings-panel.js`（官方面板里的 `Linglass-Pro` 分组继续保持现状）、
  不改 `10-subtitle-track.js` / `15-ja-break.js` / `40-study-panel.js`。
- 不把浮窗面板写进官方 shadow DOM；不新增依赖；不动 `build.mjs` / `Makefile`。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - tools/test/contract.test.mjs   # 新增的官方 class / 存储字段登记
  - docs/plans/033-pip-full-settings-panel.md
  - README.md                      # 第 21 行「Aa 可以调字号…」按新形态改写

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
  - tools/probe.mjs
```

## 实现方案

1. **数据层（纯函数）**
   - `parseSettings(raw)` 扩成完整设置：`enabled / dualSubtitles / subtitleStyle /
     subtitleScale / subtitleColor / learningLanguage / nativeLanguage / readingMode /
     mediaCaptureEnabled / subtitleSyncMode / viewing / theme`，逐项校验、逐项兜底。
   - `normalizeViewing()`：mode ∈ normal/pause/repeat/listen；pause.at、pause.length、
     repeat.count、repeat.rate、listen.target、listen.cover、listen.length 全部按官方
     取值表夹取；`pauseOnTranslate` / `showHints` 布尔。
   - `readingScriptsOf(lang)`：官方 `hs` 表（ja kana/romaji/off、zh pinyin/off、
     ko romaja/off、th paiboon/off）；`readingModeOf(lang, readingMode)`。
   - `fontSizeFromScale(scale)`、`cycleValue(list, current)`、`viewingCaption(viewing)`
     （用官方中文片段拼，供测试直接断言）。
2. **存储层**
   - `readOfficial()` 已有；新增 `writeOfficial(state)`：读现有 state → 合并 → 写
     `JSON.stringify({state, version: 4})`；`patchOfficial(patch)` 先改内存再链式写盘，
     写盘失败只告警。
   - 删除浮窗自有外观的读写（`saveAppearance` / `applyOwn` / `ownOf` / `seedFrom` 的
     外观部分）；`own` 收缩为 `{ctxLines}`，落盘键仍是 `llgPipAppearance`（迁移友好）。
3. **面板 DOM（PiP 文档内）**
   - `buildSettings(d)` 用 `createElement` 逐个搭（不用 innerHTML：测试桩没有解析器，
     而且节点引用要留着做幂等回显）。
   - `panelNodes` 保存需要回显的引用（开关、瓷砖、色块、数值、页面容器、脚本分段、
     模式参数容器、语言 trigger/menu）。
   - `syncPanel()` 只做「先比较再写」：class/text/aria-hidden 都先比再改，遵守
     AGENTS.md §3 的幂等规矩。
4. **交互**
   - 全部走已有的 `data-act` 事件委托，`command()` 在 video 闸门之前处理设置动作：
     `settings-close` / `page:<名字>` / `page-back` / `lang-menu:<setting>` /
     `lang:<setting>:<code>` / `nat:<key>` / `reading` / `reading:<script>` /
     `mode:<名字>` / `mode-field:<字段>` / `mode-toggle:<字段>` / `feature:<id>` /
     `action:<feature>:<action>`，以及保留下来的 `scale±` / `style:` / `color:` / `dual` /
     `ctx`。
   - 页面切换只改 `panelPage` + 一页的 `aria-hidden`，不做位移动画（PiP 窗口窄，
     滑动会闪）。
5. **浮窗外观**
   - `appearance` 改为「官方设置投影 + 自己的 ctxLines」；`applyOfficial()` 重画样式表
     与文本。`Aa` 时 `barMode` 从 `'play'|'style'` 变成 `'play'|'settings'`。
6. **契约登记**：新增依赖的官方 class 名与设置字段全部登记进
   `LINGLASS_CONTRACT`（probe 在 vendor 里都能找到）。

## 验证方式

- [ ] `make test`：新增 / 改写的用例见下
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：`Aa` 打开面板；改样式 / 字号 / 颜色 / 双语 / 语言 / 开关后，
      浮窗与页面内字幕同时变化；官方面板改一项，浮窗面板回显跟着变；`×` 回字幕。

### 既有断言的改写（按 AGENTS.md §3 登记）

028 的用例固化的是「浮窗外观完全独立」这条旧语义，本 PLAN 刻意换成「官方设置是唯一
真相」，因此下列用例必须改写，并补新语义断言：

| 旧用例 | 处理 |
| --- | --- |
| `浮窗外观首次从官方拷来当初始值，之后官方再改都不动` | 改为 `浮窗外观始终跟随官方设置`：官方改任何一项，`pipCss()` 都跟着变 |
| `落盘里有浮窗外观时就用它` | 改为 `旧的 llgPipAppearance 只迁移上下文行数，外观字段一律忽略` |
| `样式条上改字号/预设/颜色/双语立即生效并落盘` | 改为 `设置面板改字号/预设/颜色/双语 → 立即生效并写回官方 storage` |
| `样式条与控制栏互斥，字幕区一个节点都不动` | 改为 `设置页与字幕区互斥，切换只改 display` |
| `↺ 把官方当前的设置重新拷一份当浮窗样式` | 删除（不再有「浮窗自有外观」这层语义） |

新增用例：`parseSettings 把脏值逐项夹回`、`viewing 逐字段夹取`、
`readingScriptsOf / viewingCaption`、`fontSizeFromScale 与官方 ma() 一致`、
`我们的功能注册表会出现在浮窗设置页`。

## 预期量级

5 个文件 / `30-desktop-subtitles.js` +750 −260、`smoke.test.mjs` +180 −120、
`contract.test.mjs` +40、README ±2、PLAN 新增。

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：待定（本轮改动：`src/mod/30-desktop-subtitles.js`、`tools/test/smoke.test.mjs`、
  `tools/test/contract.test.mjs`、`README.md`、本 PLAN）
- 验证结果（实际输出）：
  - `make test` → `tests 148 / pass 148 / fail 0`
  - `make build` → 契约校验 ✓，注入自检 ✓（顺序未变）
  - `make check` → 通过
  - `node --check src/mod/30-desktop-subtitles.js` → 通过
- 与实现对齐后的几处细节：
  - 面板本体放进 `#settings` 的 **shadowRoot**：官方面板 CSS 开头是
    `* { margin:0; padding:0 }` 的全局重置，直接注入文档会连带清掉字幕区排版。
    因此点击委托改成先走 `ev.composedPath()` 找 `[data-act]`。
  - 语言下拉的菜单在 PiP 里改成**内联展开**（官方是绝对定位浮层，会被面板滚动裁掉）。
  - 读音脚本分段只放「真脚本」（`kana / romaji` …），开关的 on/off 由上面的 toggle 负责，
    与官方 `refreshReadingRow()` 一致；官方默认 `Ne()` 回落到第一项，所以首次点开关是**关**。
  - 字号派生 `fontSize` 走官方 `ma()`：`clamp(round(scale/100*24), 12, 32)`。
- 遗留 / 与预期不符之处：
  - **量级**：预期 +750 −260，实际 `30-desktop-subtitles.js` **+1471 −316**（净 +1155）。
    多出来的是完整镜像的三页 DOM（语言下拉 + 预设瓷砖 + 模式参数行）与官方数据表，
    不是顺手改别的东西。
  - `tools/probe.mjs` 与 `docs/plans/032-*.md` 在本轮开始前就是**未提交状态**，不是本 PLAN 的改动。
  - 浏览器内观感**尚未人工确认**（面板滚动、语言菜单、与官方 CSS 的逐像素一致性）；
    测试只能钉住「取到官方 CSS → 用对 class → 写回官方 storage」这三件事。
  - 同步模式页按官方平台门控（YouTube 不显示）未实现，已在「不做什么」里写明。

