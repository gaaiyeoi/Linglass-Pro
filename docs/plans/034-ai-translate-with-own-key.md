# 034 用自己的 API Key 在扩展里翻译原文

> 状态：**已移除**（PLAN 048 下线页面内 AI 翻译，改推荐「导出原文 SRT → 外部翻译 → 导入译文」；正文留档）

> 原状态：**已完成**（浏览器内人工确认未做，见「完成情况」）

## 需求

播客（YouTube 长音频）上官方的中文翻译质量不稳定，学起来别扭。

期望：在扩展里提供一个入口，填**自己的 API Key**（以及接口地址、模型、目标语言），
点一下就按句把**原文**翻译成目标语言，结果直接进学习面板 / 桌面字幕浮窗 / 导出文件。
即把 PLAN 031 的「导出原文 → 外部翻 → 导入译文」那条离线链路，收成页面内的一个按钮。

## 根因

不适用（新增能力，非 Bug Fix）。

## 做什么

### 1. 学习面板里加一个「AI 翻译」入口

- 页脚加一个 `AI 翻译` 按钮，点开面板内的设置层（sheet），不是新开标签页。
- 设置层字段：服务商预设、接口地址、模型、API Key、目标语言、是否跳过已有译文。
- API Key 走 `chrome.storage.local`（我们自己的键），**不进页面存储、不写日志**；
  输入框 `type=password`，另给一个「清除 Key」。
- 设置面板（Linglass 自己的）里也登记一行 `AI 翻译（用自己的 API Key）`，点了打开同一个层。

### 2. 逐批翻译原文

- 只翻有原文（`cue.primary`）的句子；按「最多 40 句 / 最多 2000 字」切批。
- 每批发一次 `POST <接口地址>`（OpenAI 兼容的 `/chat/completions`），
  要求模型返回**等长、同序的 JSON 字符串数组**，只翻这一批的原文。
- 每批回来就贴回轨道（复用 PLAN 031 的 `track.applyTranslations`），
  所以中途停止／报错时**已经翻好的部分不会丢**，且 `origin='imported'`
  的优先级保护让官方采样不会覆盖我们的译文。
- 面板里显示进度（第几批 / 已贴多少句），可随时「停止」。

### 3. 失败要如实报

- 单批失败（HTTP 非 2xx / 返回不是等长数组 / 网络错误）**重试一次**，仍失败就跳过该批、
  累计失败句数，最后一句 toast 报：`已贴 x / y 句，z 句失败`。
- 跨域被浏览器拦截时，明确提示「该接口不允许浏览器直连（CORS）」，而不是笼统的「网络错误」。

## 不做什么

- **不改官方画面里的那层字幕**（与 PLAN 031 同一条红线）。
- **不碰 `vendor/`**，也不改 manifest：实测主流厂商的 `/chat/completions`
  预检回包都放行 `https://www.youtube.com`（见「实现方案」第 0 节），
  内容脚本直连即可。自定义网关若不开 CORS，只给提示，不为它加 `<all_urls>` 权限。
- 不做流式输出、不做逐句实时翻译、不做翻译记忆/术语表、不做多 Key 管理。
- 不改 `10-subtitle-track.js`：AI 译文与导入译文本就是同一套落盘与优先级机制。
- 不改 PLAN 031 的「原文 SRT / 导入译文」那两个口子。

## 修改范围

```yaml
allowed_paths:
  - src/mod/06-ai-translate.js
  - src/mod/40-study-panel.js
  - tools/test/ai-translate.test.mjs
  - tools/test/smoke.test.mjs
  - README.md
  - docs/plans/034-ai-translate-with-own-key.md

forbidden_paths:
  - vendor/**
  - dist/**
  - build.mjs
  - src/mod/00-shared.js
  - src/mod/05-srt.js
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
```

## 实现方案

### 0. 为什么不需要新增权限（实测记录）

2026-10-19 对以下端点发 `OPTIONS`，带 `Origin: https://www.youtube.com`：

| 端点 | 回包 |
|---|---|
| `api.deepseek.com/chat/completions` | `access-control-allow-origin: https://www.youtube.com` |
| `api.openai.com/v1/chat/completions` | `access-control-allow-origin: https://www.youtube.com` |
| `api.moonshot.cn/v1/chat/completions` | `access-control-allow-origin: https://www.youtube.com` |
| `api.siliconflow.cn/v1/chat/completions` | `access-control-allow-origin: *` |
| `openrouter.ai/api/v1/chat/completions` | `access-control-allow-origin: *` |
| `generativelanguage.googleapis.com` | `access-control-allow-origin: https://www.youtube.com` |

MV3 的内容脚本 fetch 以页面 Origin 走 CORS，所以这些厂商可直接调；
不加 `host_permissions`，安装时也不会多一条「读取所有网站数据」的警告。

### 1. `src/mod/06-ai-translate.js`（新增，纯函数）

注入顺序由文件名决定：`05-srt.js` < `06-ai-translate.js` < `10-subtitle-track.js`。<br>
挂在 `globalThis.__llgModAiTranslate`（与 `05-srt.js` 同款），Node 侧可直接测：

- `PROVIDERS` / `TARGETS` / `DEFAULT_CONFIG`
- `normalizeConfig(raw)` → 补默认值、裁剪未知服务商、去首尾空白、校验目标语言
- `chatUrl(baseUrl)` → 用户可能填 `https://api.deepseek.com`、`.../v1`、
  或完整 `.../v1/chat/completions`，统一补成后者
- `planBatches(cues, { maxItems, maxChars })` → `[{ items: [{ start, text }] }]`，
  按顺序切、只取有原文的句、字符上限按「本批文本总长」算
- `buildMessages(texts, targetLang)` → OpenAI 兼容的 `messages`
  （system 固定要求「等长同序 JSON 数组、只输出数组」）
- `parseTranslationContent(content, expected)` →
  `{ ok: true, lines }` 或 `{ ok: false, reason }`；
  容忍 ```json 围栏、数组前后有解释文字、元素是 `{ text }` 这类对象；
  **长度不等一律判失败**（宁可跳过这批，也不把错位的译文贴进去）

### 2. `src/mod/40-study-panel.js`

- 页脚加 `AI 翻译` 按钮（`data-act="aiTranslate"`）。
- `PANEL_HTML` 里加一个 `.sheet`（默认 `data-state="closed"`），
  含表单、状态行、`开始翻译 / 停止 / 清除 Key`。
- `PANEL_CSS` 里用面板同一套玻璃令牌写 `.sheet` 样式，位置 `absolute; inset: 0`。
- 配置读写：`AI_STORE_KEY = 'llgAiTranslate'`，启动时读、输入变化时防抖落盘。
- 运行循环 `runAiTranslate()`：
  1. 读表单、校验（没 Key / 没地址 / 没有原文都直接 toast，不发请求）；
  2. `planBatches` → 逐批 `fetch`（`AbortController` 支持「停止」）；
  3. `parseTranslationContent` 成功后 `track.applyTranslations` 贴回；
  4. 每批后 `renderAll()` + 更新状态行；
  5. 结束时报 `已贴 x / y 句`，失败句数如实带上。
- 设置面板登记 `id: 'aiTranslate'` 的 action 行，`run: openAiSheet`。

### 3. 测试

- 新增 `tools/test/ai-translate.test.mjs`：切批、URL 归一、prompt 内容、
  解析（纯数组 / 围栏 / 前后有废话 / 对象元素 / 长度不符 / 坏 JSON）。
- `tools/test/smoke.test.mjs`：加载 `06-ai-translate.js`，并加一例
  「面板里能打开 AI 设置层、没有 Key 时不发请求只提示」。

## 验证方式

- [ ] `make test`（新增用例见上）
- [ ] `make build`：注入顺序里出现 `mod/06-ai-translate.js`，自检无告警
- [ ] `make check`
- [ ] 浏览器人工确认：填 DeepSeek Key → 一段长播客点「开始翻译」→
      面板逐批出现译文 → 导出 Markdown 含译文。**未验证就如实标注**

## 预期量级

6 个文件 / 约 +600 −10 行（其中测试约 +180）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：尚未提交（工作区里还有上一轮 PLAN 032/033/035 的未提交改动，按 §4「一个 PLAN 一个提交」交由人决定怎么切）
- 验证结果（实际输出）：

  ```text
  $ make test
  # tests 168
  # pass 168
  # fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      mod/00-shared.js → mod/05-ja-segment.js → mod/05-srt.js
                    → mod/06-ai-translate.js → mod/10-subtitle-track.js
                    → mod/15-ja-break.js → mod/30-desktop-subtitles.js
                    → mod/40-study-panel.js → mod/50-settings-panel.js

  $ make check
  已注入  mod/00-shared.js, …, mod/06-ai-translate.js, …, mod/50-settings-panel.js
  ```

- 实际量级（只算本 PLAN）：
  `src/mod/06-ai-translate.js` 新增 264 行；`src/mod/40-study-panel.js` +441；
  `tools/test/ai-translate.test.mjs` 新增 163；`tools/test/smoke.test.mjs` +72；README +21。
  比预估厚一些，主要是面板里那层设置表单（CSS + HTML + 运行循环）。

### 新增用例（对照「验证方式」）

- `tools/test/ai-translate.test.mjs`（6 例）：配置归一、三种接口地址写法、按条数/字数切批、
  prompt 内容、解析（纯数组 / 代码围栏 / 前后夹解释 / 对象元素）、失败判据（条数不符 / 坏 JSON / 非数组 / 空）。
- `tools/test/smoke.test.mjs`（2 例）：
  1. 打开设置层、页面里没有 Key 时只提示、不发请求；
  2. 桩 `fetch` 跑完整链路：一次请求、`Authorization: Bearer` 正确、三句都贴回并打上 `origin='imported'`、
     状态行显示 `已贴 3 / 3 句`。

### 追加修复（2026-10-19，真实长播客反馈）

用户实测：`已贴 240 / 634 句，394 句失败`。240 恰好是 6 个整批，说明失败是**整段整段**
发生的 —— 16 段里 10 段两次都没拿到可用结果，不是个别句子贴不上。

推断（按可能性排序，未逐条取到用户日志）：

1. **输出被截断**：40 句 / 2000 字的译文容易顶到不少模型的默认输出上限（4096 tokens），
   JSON 被切断 → 解析失败 → 整段报废。这是最符合「整段失败」形状的原因。
2. **模型没按 JSON 输出**：返回编号列表或 `{"1": "…"}` 对象，原来的解析只认数组，一票否决。
3. 少数情况是 429 / 额度 / 网关限流（那样连第一次成功都不会有，且日志里会有状态码）。

改动：

- 批次从 40 句 / 2000 字降到 **20 句 / 1200 字**（`MAX_ITEMS` / `MAX_CHARS`），请求数翻倍但每段更不容易被截断。
- 解析加两级兜底：带序号的 JSON 对象、一行一条的纯文本（**行数必须相等**才接受，
  且拒绝仍带 JSON 残骸的行），条数不等这条底线不变。
- 仍然失败时**自动对半拆分重试**（20 → 10 → 5，`AI_SPLIT_DEPTH = 2`），
  把「整段报废」降级成「只丢少数几句」。
- 失败原因不再被吞掉：进度行实时显示，汇总带上「最近一次原因」，
  并把响应前 240 字符 `console.warn` 到控制台（判断截断与否只能看原文）。

新增用例：带序号对象、一行一条（含编号前缀）、行数不等仍失败、截断数组不被逐行兜底误收。

### 追加修复（2026-10-19，prompt 与上下文）

用户反馈：`丸ハラ` 被译成「丸原」，整段读下来「没有上下文的感觉」。确认两个原因：

1. **每句是孤立翻的**：一批 20 句只给模型一个字符串数组，句与句之间没有任何关系信息，
   缩写、指代、被时间切开的半句都无从判断。
2. **prompt 只说了「别合并/别拆句」**，没说「日本流行语与缩写不要硬音译」。

改动：

- `buildMessages(texts, targetLang, context)`：多带三样东西 —— 视频标题、
  **紧邻的 3 行前文与 3 行后文**（单独标注「只作参考，不要翻译，不要输出」）。
  前后文按全量原文列表的下标算，拆半后的段仍是连续切片，逻辑不变。
- system prompt 重写：明确「字幕是被时间切开的碎片，借助前后文理解、但只输出本条」、
  「脱离翻译腔、保留语气与称呼」、并给出反例：
  「丸ハラ」指「句号骚扰」，**不要音译成没有意义的汉字词**。
- 面板状态行不变，仍然只报进度；上下文只进请求，不进任何界面。

新增用例：`buildMessages` 的标签与前后文（含「没有标题/前后文时不出现空标签」）；
冒烟测试新增「23 句 → 20+3 两段，第一段带后文、第二段带紧邻三句前文、末段无后文」。

### 追加修复（2026-10-19，把上下文用满）

用户要求「一次尽量多吃上下文，应该更准」。这里有一条不能越的线：

**输入可以加，输出不能加。** 之前 40 句批量整段报废，根因是输出顶到模型上限被截断，
所以每段仍然只翻 20 句 / 1200 字；加的是「模型能看到多少上下文」：

1. **全片语境预处理**（`buildBriefMessages`）：轨道超过 30 句时，先发一次请求把整片字幕
   （最多 2 万字）读一遍，产出 ≤300 字的摘要 —— 主题、说话人与称呼、反复出现的术语/缩写
   的**建议译法**、整体语气。摘要 ≤1500 字，之后注入每一段的 system。
   失败不阻塞翻译（拿不到就按无摘要继续），阈值以下也不做（短片没东西可归纳）。
2. **前文窗口从 3 行扩到 3000 字**（约 100~150 条字幕），按**字数**封顶而不是行数
   （字幕长短差异太大，行数封顶不可靠）；后文仍只取 600 字，用于消解「半句没说完」。
3. prompt 增加第 7 条：全片语境里给出的术语译法优先级最高，全片保持一致。

代价：每条轨道多一次请求（只读输入，很便宜）；每段请求的输入 token 明显变大，但输出不变。

新增用例：前文按字数封顶且保留「最近的一段」；语境摘要 prompt 的要求与注入位置；
冒烟测试 40 句 → 3 次请求（1 次整理 + 2 段），第二段的 system 里带摘要与术语译法。

### 追加修复（2026-10-19，「条数不符（期望 20，实际 19）」反复出现）

现象：模型偶尔只返回 19 条。根因不是网络也不是截断，而是**模型把相邻两条合并了**
（字幕本身就是半句话，它觉得「这两句应该是一句」），我们按条数判失败后整段重试。

判据不能松（少一条就整段错位），能做的是降低发生率与提高重试命中率：

1. **把条数写死进 prompt**：`本次共 20 条`，并追加「哪怕只有半句话、一两个词或语气词，
   也必须单独占一条，绝不能和相邻条合并」。模型对具体数字比「等长」敏感得多。
2. **重试换格式**（`buildMessages(..., { indexed: true })`）：不要求数组，改成
   键为 `"1".."N"` 的 JSON 对象 —— 数组少一条看不出少哪条，编号对象必须逐号出现，
   模型也更容易自查。解析侧本来就能读编号对象（上一轮加的兜底），无需新逻辑。
3. **一次失败后本轮后续段落直接用编号格式**（`preferIndexed`）：同一部片子、同一个模型，
   爱合并的地方会反复合并，每段都先失败一次再换格式太浪费。

新增用例：编号格式的 prompt；冒烟测试「第一次返回 19/20 → 换格式重试 → 三句全贴上」。

### 追加能力（2026-10-19，整片上下文模式）

用户问「能不能整片放到里面翻译」。**整片一次翻完不行**：几百句的译文远超模型输出上限
（DeepSeek 默认 4096、上限 8192 tokens；gpt-4o-mini 16k），必然截断 ——
这正是最早整批报废的根因。可行的做法是**输入整片、输出分小批**：

- 设置层新增勾选「整片放进上下文（更准，更贵；需 64k+ 上下文模型）」。
- 勾选后每条请求都带 `{条号: 原文}` 的全片对象，只要求翻 `from..to`（默认 20 条），
  输出同样带条号的 JSON 对象；模型因此能看到这一条在整片里的确切位置。
- 整片输入上限 3 万字（`WHOLE_MAX_CHARS`）；超限直接退回分段。
- 整片模式跳过「语境摘要」预处理（全片已经在请求里，再整理一次纯属浪费）。
- 整片模式失败（多数是 8k 模型 400 上下文超限）→ **本轮自动退回分段**，不反复撞墙。
- `fromNumberedObject` 从「必须从 1 开始」放宽为「连续整数即可」，以支持 `{"41": "…"}`。

新增用例：整片请求只含指定条号、能解析不从 1 开始的编号对象、缺号/多号仍失败；
冒烟测试 30 句 → 2 次请求（无额外摘要请求），两次分别带 `1-20` / `21-30`，30 句全贴上。

### 追加修复（2026-10-19，整片模式 20 句「没翻成」但实际已翻好）

真实 476 句长播客：`已贴 456 / 476 句，20 句没翻成，其中 20 句没贴到轨道上，
最近一次原因：条数不符（期望 20，实际 15）`。这行字里有两个问题：

1. `failed == missedAxis` 说明这 20 句模型已翻好，是 `applyTranslations` 按 `start`
   找不到对应句（轨道在翻译期间被重建 / 官方重新断句）。
2. 「最近一次原因」是陈旧的：`lastReason` 只在解析失败时更新，贴不上时不会更新。

另外整片模式一次「条数不符」就把 `wholeMode` 置 false，后面所有段退回分段 ——
用户为整片付了输入成本却只享受到第一段。修法见 PLAN 044（原文唯一匹配兜底、
lastReason 如实更新、整片模式下先换编号格式重试、轨道指纹变化写进汇总）。

### 遗留 / 与预期不符之处

1. **浏览器人工确认没做**：没有拿真实 Key 跑过一段真实播客，所以「长轨道（几百句）下的分批节奏、
   toast/进度观感、翻完之后浮窗与导出是否都对」都**未验证**。Node 侧只证明了请求形状与贴回逻辑。
2. **单批失败只重试一次**：第二次仍失败就跳过该批并把句数计入「失败」，不会把整轮停下 ——
   用户翻长播客时可能看到「已贴 320 / 400 句，80 句失败」，需要再点一次才会补。
   要做「自动续翻失败的批」得另立 PLAN。
3. **贴回的译文与「导入译文 SRT」共用 `origin='imported'`**：所以面板区分不出「AI 翻的」与
   「文件导入的」；`meta.import` 的指纹也因此会被 AI 翻译刷新（语义上成立：都是用户自己的译文）。
4. **自定义网关必须允许 CORS**：不为它加 `<all_urls>` 权限。实测主流厂商都放行
   `https://www.youtube.com`，但自建 one-api 之类若没配 CORS，只会得到一句提示，不是可用方案。
5. **AI 译文不进官方字幕层**：与 PLAN 031 同一条边界，官方画面里的那层字幕仍然是官方的。
