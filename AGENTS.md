# 开发规范

本文件规定本仓库的开发流程与代码约束，适用于人工改动与自动化工具。

规范的目的是控制改动范围、保护只读基线，并要求所有改动经过验证。

## §0 仓库结构

本仓库在 Linglass（YouTube 双语字幕扩展）基础上进行增量开发。

```text
vendor/linglass-<版本>/   Linglass 商店版本，只读基线
src/mod/                  扩展源码
        ↓  make build
dist/                     可加载的完整扩展，构建产物
```

- Linglass 基线不纳入版本控制，`vendor/` 已在 `.gitignore` 中。首次使用需执行 `make vendor-update`。Linglass 发布新版本时只需替换 `vendor/`，`src/mod/` 无需改动。
- 发布包：`make package` 在 `release/` 生成 zip，包含 `src/mod/` 源码、安装脚本与图文向导，不包含 `vendor/` 与 `dist/`。安装时由本机从 Chrome 商店获取 Linglass 当前版本并构建 `dist/`。`vendor/`、`dist/`、`release/` 均不纳入版本控制。
- 扩展通过 Linglass 产物的 Shadow DOM、控制栏与设置面板接入功能。Linglass 改版后相关依赖可能静默失效，因此设置了契约测试。
- 仓库不引入第三方依赖。构建使用 `node build.mjs`，测试使用 `node --test`。内容脚本运行于用户浏览器，不为测试便利增加依赖。
- 目标运行环境为 Node 18 及以上、macOS、Arc 或 Chromium 116 及以上。桌面字幕浮窗依赖 `documentPictureInPicture`。

## §1 需求与 PLAN

每个需求对应一份 PLAN 文件；未建立 PLAN 不进入实施阶段。需求可以来自讨论，但实施前必须写入 `docs/plans/`：

```text
docs/plans/
├── 001-desktop-subtitles-persistent.md
├── 002-pip-progress-and-jieba.md
└── 003-study-panel-liquid-glass.md
```

文件编号连续递增，格式为 `NNN-<描述>.md`。一份 PLAN 只对应一个需求，不合并范围外的改动。

PLAN 至少包含以下五节：

| 章节 | 内容 |
|---|---|
| 需求 | 需要解决的问题 |
| 做什么 / 不做什么 | 本次改动的边界 |
| 修改范围 | 允许与禁止修改的路径 |
| 验证方式 | 证明改动有效的方法 |
| Definition of Done | 完成判定条件 |

「不做什么」与「做什么」同等重要，用于限定范围。

Bug 修复的 PLAN 必须额外包含「根因」一节，说明现象、定位过程与证据。无法说明根因时不进入修改阶段。

## §2 修改范围

每份 PLAN 必须包含一段 `yaml` 代码块，声明允许与禁止修改的路径：

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/001-desktop-subtitles-persistent.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
```

超出申报范围时应停止修改并报告，由负责人决定扩大范围或另立 PLAN。

本仓库目前没有自动化的范围检查脚本，范围核对依赖人工审查与 §4 中的 `git diff --stat` 比对。如需引入检查脚本，必须由单独的 PLAN 明确要求，不得在无关改动中添加。

## §3 编码规范

### 通用

- 修改前阅读相关代码与相邻实现，遵循现有风格。
- 注释、文档与提交信息使用中文。
- 不为完成需求重构无关代码。
- 不修改对外暴露的 `globalThis.__llgMod*` 接口签名，除非 PLAN 明确要求。
- 优先复用现有代码，不引入新依赖，包括开发依赖，除非 PLAN 明确要求。
- 不删除或弱化现有测试。
- 不通过修改测试使错误实现通过。测试失败时先检查实现；若确认旧测试固化了旧语义，必须在 PLAN 中说明修改断言的原因，并补充覆盖新语义的断言。
- 当库或浏览器行为与文档不一致时，以实测结果为准，并在注释中记录实测事实。

### 技术栈

- 构建使用 `node build.mjs`，不使用打包器与 babel；测试使用 `node --test`。
- 内容脚本为自执行 IIFE，模块之间通过 `globalThis.__llgMod*` 直接调用，不使用消息传递。
- `src/mod/` 的数字前缀决定注入顺序。同一 `content_scripts` 条目内，Chrome 按数组顺序执行：
  - `00-` 共享设施：按钮工厂、功能注册表、僵尸 DOM 清理
  - `05-` 纯函数，无 DOM 副作用
  - `10-` 字幕轨道，各功能共用的基础模块
  - `15-` / `30-` / `40-` 具体功能
  - `50-` 集成至 Linglass 设置面板
  - `*.dev.js` 仅在 `make dev` 时注入；`*.sw.dev.js` 仅注册为 Service Worker，不作为内容脚本注入
- `make build` 执行注入自检与字幕浮层契约校验；`make check` 校验 `dist/` 的注入结果。
- 控制栏按钮布局使用内联样式。YouTube 的 `.ytp-button` 规则与扩展规则优先级相同，内联样式更稳定。伪类使用 `!important` 覆盖。
- 单行长度软上限为 120 列。现有文件最长为 136 列，均为长字符串或注释，不作为修改目标。

### 关键约束

1. 幂等：在 shadowRoot 上注册 `MutationObserver` 并同时修改其子树时，必须先比对目标状态再写入。对 `textContent` 或 `classList` 重复赋值即使内容相同也会触发 DOM 变更，可能导致循环。参考 `15-ja-break.js` 与 `50-settings-panel.js`。
2. 僵尸 DOM：`make dev` 每次保存都会重载扩展，上一轮内容脚本的上下文与监听器随之销毁，但其创建的 DOM 仍保留在页面中。新上下文复用这些元素会导致控件存在但无响应。`00-shared.js` 的 `STALE_IDS` 与 `50-settings-panel.js` 的 `SESSION` 标记用于识别这些元素；新增可能受重载残留影响的 DOM 时必须登记。
3. 不修改 Linglass 的文本流：Linglass 通过 `.linglass-word` 的 `data-start/end` 对整行文本做切片，实现点词与拖拽选词。向字幕行插入可见字符会导致位置错乱。需要视觉分隔时使用空 span 与 CSS `::after`，参考 `15-ja-break.js`，不向 `textContent` 写入字符。

### 测试

- 新增业务逻辑必须提供冒烟测试。
- 修改已有逻辑必须检查相关既有测试。
- Bug 修复必须提供回归测试：先编写能复现问题的测试，确认失败后修改实现。
- 测试分为两层：

  ```bash
  make test          # node --test tools/test/*.test.mjs
  ```

  - 契约测试 `tools/test/contract.test.mjs`：验证对 Linglass 产物与 YouTube 平台的依赖仍然成立。新增对 Linglass DOM 的依赖时必须登记，否则漏登记检测会失败。
    检测范围为带 `.` 或 `#` 前缀的字符串字面量；`className = 'xxx'` 这类赋值写法无法自动检出，需人工维护。登记表是主要依据，漏登记检测为辅助。
  - 冒烟测试 `tools/test/smoke.test.mjs`：使用 `node:vm` 创建沙箱，替换 `document`、`chrome` 与 `MutationObserver`，直接运行 `src/mod/*.js`。
    定时器由测试手动驱动，避免测试变慢或进程无法退出。新增模块需在 `harness()` 中按依赖顺序加载。
- 契约测试读取 `vendor/`，运行前需先有基线。
- 无法覆盖的测试缺口必须在 PLAN 中记录。
- 浏览器内的视觉与交互无法由 Node 测试覆盖，需要人工确认。`make probe` 基于 CDP 驱动真实浏览器，可执行部分自动化检查，需要 `--headed` 并下载或复用浏览器。

## §4 Git 与提交

### 提交信息

主题行使用中文，一句话说明改动内容，不使用 `feat:`、`fix:` 等前缀。正文以 `- ` 列表说明原因与验证结果，续行缩进两个空格，宽度约 72 列。

```text
桌面字幕常驻：默认开启，只有显式关闭才关

- 外部关闭 PiP 窗口时不再视为终态：pagehide 区分扩展触发的关闭与外部
  触发的关闭，后者立即重新打开；缺少用户手势时等待下一次手势。
- enabled 状态持久化，默认 true，刷新页面或切换视频后保持开启。
- 补充 4 条冒烟测试：默认开启、显式关闭不回弹、非显式关闭回弹、持久化。
```

### 一份 PLAN 对应一次提交

不同 PLAN 的改动不混入同一次提交，也不混入无关格式化。

### 提交前检查

本仓库没有 Git 钩子与 CI 配置，检查需在提交前手动执行。

```bash
git status --short
git diff --stat
git diff
```

PLAN 中应写明预期改动量级。实际结果与预期相差一个数量级时，先检查原因再提交。

重点确认：是否存在无关文件；是否修改了 `vendor/`；是否重排了整个文件；`git status` 中是否出现 `dist/`。

## §5 检查项

检查项由 Makefile 提供，不额外编写脚本：

```bash
make build     # 构建；契约校验与注入自检
make test      # 契约测试与冒烟测试
make check     # 校验 dist/ 的注入结果
```

按改动范围执行：

- 修改 `src/mod/**`：执行 `make build`、`make test`、`make check`。
- 修改 `tools/test/**` 或 `build.mjs`：执行 `make test`；修改 `build.mjs` 还需执行 `make build`。
- 仅修改 `*.md`：无需执行，但需通读全文。

仓库没有 CI，本地检查结果是提交前的唯一保证。未验证的部分必须明确说明。

## §6 完成标准

完成状态由清单与检查结果决定，不以声明为准：

```markdown
## Definition of Done

- [ ] 功能实现，对照 PLAN 的「做什么」逐项确认
- [ ] Bug 修复的回归测试通过
- [ ] `make test` 通过，附实际输出
- [ ] `make build` 的契约校验与注入自检无告警
- [ ] `make check` 通过
- [ ] `git diff --stat` 量级与 PLAN 预期相符
- [ ] 无 PLAN 范围外的文件改动
- [ ] PLAN 已更新，记录进度、遗留问题与实现的差异
- [ ] 浏览器内行为已人工确认，或明确标注为未验证
```

- 未完成的项目需说明具体条目及原因。
- 未测试、跳过或推测的部分必须明确说明。
- 与现有文档或注释不一致的发现，应记录到 PLAN 或另立 PLAN。

## §7 文档

仓库文档保持最小集合：

```text
AGENTS.md            开发规范
docs/plans/NNN-*.md  每个需求的记录
README.md            安装、使用与开发说明
```

本文档不复述 README 中的命令表与文件名约定，也不复述代码注释中已说明的内部机制。

`.codebuddy/` 为本地开发配置，不得删除。`.scratch/` 为探针的持久化 profile 目录，可以删除。

---

## 附录：PLAN 模板

````markdown
# 001 桌面字幕常驻

> 状态：待执行 / 执行中 / 已完成

## 需求

点开桌面字幕后，切回浏览器时浮窗被关闭。期望浮窗常驻、默认开启，仅显式关闭时停止。

## 根因

Bug 修复必填。说明现象、定位过程与证据。

## 做什么

- ...

## 不做什么

- ...

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/001-desktop-subtitles-persistent.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
```

## 实现方案

1. ...

## 验证方式

- [ ] `make test`，注明新增的回归测试
- [ ] `make build` 与 `make check`
- [ ] 浏览器人工确认

## 预期量级

2 个文件，+80 / −30 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：
- 验证结果：
- 遗留问题与差异：
````
