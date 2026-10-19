# 048 移除页面内 AI 翻译，只保留离线翻译链路

> 状态：**已完成**（浏览器人工确认未做，见「完成情况」）

## 需求

用户明确表态：**不再需要页面内的 AI 翻译**。更推荐的做法是
「导出原文 SRT → 在扩展之外翻译 → 把译文 SRT 导回来」，认为这样更准。

PLAN 031 已经把这条离线链路做完了（导出原文 SRT / 导入译文 SRT），
所以本次要做的是把 PLAN 034/044 的 AI 翻译整套能力移除，
并顺手清掉用户本机 `chrome.storage.local` 里残留的 API Key。

## 根因

不适用（能力下线，非 Bug Fix）。

## 做什么

- 删除 `src/mod/06-ai-translate.js`（纯函数：切批 / prompt / 返回解析）。
- `src/mod/40-study-panel.js`：
  - 删除页脚「AI 翻译」按钮、AI 设置层（`.sheet`）的 HTML 与全部 CSS。
  - 删除点击分发里的 `aiTranslate` / `aiClose` / `aiRun` / `aiStop` / `aiForget` 分支。
  - 删除整个「AI 翻译（PLAN 034）」代码段：配置表单、请求、重试、整片上下文、
    全片语境摘要、逐批贴回、进度与停止。
  - 删除设置面板注册表里的 `aiTranslate` 操作行。
  - 删除只为 AI 逐批刷新服务的 `refreshRowsFor()` / `updateRow()` / `rowByStart`（移除后无调用方）。
  - 启动时**清理一次** `llgAiTranslate` 键（用户选择「启动时清理一次」，避免本地残留 Key）。
- 删除 `tools/test/ai-translate.test.mjs`。
- `tools/test/smoke.test.mjs`：删除 `06-ai-translate.js` 的加载与 9 条 AI 面板用例，
  以及注册表用例里对 `aiTranslate` 入口的断言。
- `README.md`：删除功能总览里的 AI 翻译行、AI 翻译整节、模块表里的 `06-ai-translate.js`；
  在「学习面板」一节补一小段离线翻译流程（导出原文 → 外部翻译 → 导入译文）。
- 删除 `docs/images/ai-translate.svg`。
- 在 PLAN 034 / 044 头部补一行「已移除」指向本 PLAN。

## 不做什么

- **不动** PLAN 031 的导出原文 / 导入译文链路（`05-srt.js`、`10-subtitle-track.js`
  的 `applyTranslations`、面板里的 `srtSrc` / `importSrt`）。
- 不改任何 prompt 之外的官方 DOM 依赖，不新增契约登记项。
- 不改 `build.mjs`（`scanMod()` 按文件名自动扫描，删文件即少一项注入）。
- 不删除 PLAN 034 / 044 的正文（留档），只加一行状态说明。
- 不引入新依赖、不改 `globalThis.__llgMod*` 其余接口签名。

## 修改范围

```yaml
allowed_paths:
  - src/mod/06-ai-translate.js        # 删除
  - src/mod/40-study-panel.js
  - tools/test/ai-translate.test.mjs  # 删除
  - tools/test/smoke.test.mjs
  - README.md
  - docs/images/ai-translate.svg      # 删除
  - docs/plans/034-ai-translate-with-own-key.md
  - docs/plans/044-ai-translate-missed-cues.md
  - docs/plans/048-remove-ai-translate.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/05-srt.js
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
  - build.mjs
```

## 实现方案

1. 先删模块与测试文件，再改面板：面板里 `aiModule()` 等引用一并删除，
   避免留下「模块未加载」的死路径。
2. 面板删除顺序（按行号自上而下，逐段 `replace_in_file`）：
   CSS（`.sheet*` / `.field*` / `.sheet-actions*`）→ 页脚按钮 → 设置层 HTML →
   `els` 角色列表与 `setupAiForm()` → 点击分发 → AI 代码段 → 注册表操作行 → 启动读取。
3. 启动清理：`chrome.storage.local.remove('llgAiTranslate').catch(() => {})`，
   不读取、不回填、不提示（只在代码里留一行注释说明为什么删）。
4. README 的离线翻译说明只写操作路径与格式约定（每句文本整块当译文，来自 PLAN 031），
   不重新介绍已删除的能力。

## 验证方式

- [x] `make test`：AI 相关用例全部消失（172 例，比下线前少 20 例）
- [x] `make build`：注入列表里不再出现 `mod/06-ai-translate.js`，自检无告警
- [x] `make check`：`dist/` 内无 `06-ai-translate.js` 残留
- [x] 全仓搜索 `__llgModAiTranslate` / `06-ai-translate` 只剩 PLAN 留档
- [ ] 浏览器人工确认（**未做**）：页脚只剩 Markdown / SRT / 原文 SRT / 导入译文 / 复制 / 清空

## 预期量级

9 个文件 / 约 +40 −1500 行（删除为主）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里另有行内未提交的 PLAN 047 液态玻璃改动，等它们一起收）
- 验证结果（实际输出）：

  ```text
  $ make build
  [build] 注入      mod/00-shared.js → mod/05-ja-segment.js → mod/05-srt.js
                    → mod/10-subtitle-track.js → mod/12-longline.js → mod/15-ja-break.js
                    → mod/30-desktop-subtitles.js → mod/35-cast.js
                    → mod/40-study-panel.js → mod/50-settings-panel.js
  （06-ai-translate.js 已不在列表里；契约校验无告警）

  $ make check
  已注入  mod/00-shared.js, …, mod/40-study-panel.js, mod/50-settings-panel.js
  $ ls dist/mod | grep -i ai   → 无输出

  $ make test
  ℹ tests 172   ℹ pass 172   ℹ fail 0
  ```

- 遗留 / 与预期不符之处：
  1. **工作区里还有别人没提交的改动**（行内 PLAN 047 液态玻璃：00-shared.js / 15-ja-break.js /
     30-desktop-subtitles.js）。本次没有碰这些文件；但提交时要注意别把两件事混进一个提交。
     中途跑测试时这 3 条桌面字幕用例曾因这几个文件处于写入中间态而红过一次，
     文件稳定后连续两次 `make test` 都是 172/172。
  2. **浏览器人工确认没做**：页脚按钮布局、导入译文链路在真实页面上的观感未人眼过。
  3. 实际量级比预估略大：`src/mod/40-study-panel.js` 净删除约 800 行（其中 AI 代码段 638 行），
     本次涉及的文件整体 -2297 / +115（+115 里含行内未提交的玻璃令牌改动与本 PLAN 文档）。
  4. 本地旧 Key 的清理是一次性 `remove()`，没有回执或提示；用户看不到「已清理」的反馈，
     这符合「静默清掉凭据」的预期，但如果以后要排查，只能看代码注释。
