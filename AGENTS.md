# AI Coding Rules（本仓库的「Vibe Coding 宪法」）

> 这份文件约束的是 **AI 在这个仓库里的行为**，不是人类研发流程规范。
>
> 普通项目的规范主要在防「人写错代码」；这份规范主要在防 **AI 的修改失控**：
> 一次改太多、越界改无关文件、把官方基线搞脏、嘴上说「已完成」。
>
> **8 条宪法（展开见下文）**
>
> 1. 一个需求 = 一个 PLAN（§1）
> 2. PLAN 必须定义修改范围（§2）
> 3. AI 不得修改 PLAN 范围之外的代码（§2）
> 4. `vendor/` 与 `dist/` 只读，一个字节都不改（§3）
> 5. Bug Fix 必须带回归测试，新逻辑必须有冒烟测试（§3）
> 6. 提交前必须看 diff，确认改动量与 PLAN 预期相符（§4）
> 7. 门禁是 `make test` + `make check`，改了什么跑什么（§5）
> 8. 通过验证 ≠ 完成，必须满足 PLAN 的 Definition of Done（§6）

---

## §0 这个仓库是什么

**本仓库不是 Linglass，而是在 Linglass 之上做增量改造的「壳」。**

```text
vendor/linglass-<版本>/   官方商店下发的扩展（只读基线，一字节不改）
src/mod/                  我们的全部代码
        ↓  make build
dist/                     可加载的完整扩展（生成物，不进版本控制）
```

- 官方基线**不进版本控制**（`vendor/` 在 `.gitignore` 里，是 Linglass 的专有代码）。
  第一次使用必须先 `make vendor-update`。官方发新版时也只换 `vendor/`，`src/mod/` 原样可用。
- **分发口径**（PLAN 024 起）：`make package` 产出两个包 —— **安装器版**只含我们自己的代码，
  官方基线由对方的电脑在安装那一刻自己去商店取；**完整版**会把官方代码一起打进 zip
  （下载即用，但重新分发的风险由分发者承担，README「只想装上用」一节有完整说明）。
  无论哪种包，`vendor/` 与 `dist/` 都**不进版本控制**。
- 我们的代码**寄生在官方产物之上**：读它的 Shadow DOM、插它的控制栏、挂它的设置面板。
  官方一改版，这些依赖可能静默失效（表现为「字幕不动了」而不是抛错）——所以有契约测试。
- **零第三方依赖**（`node:test` / `node:vm` / 原生 `fetch` / CDP 手写 WebSocket）。
  这是刻意保持的：内容脚本叠加进用户浏览器，不该为了测试便利往仓库里塞依赖树。
- 目标运行时：Node 18+（实际开发在 Node 24）、macOS、Arc 或 Chromium 116+
  （桌面字幕浮窗需要 `documentPictureInPicture`）。

## §1 一个需求 = 一个 PLAN

**没有 PLAN 就不开工。** 需求来源可以是聊天，但落地前必须先写成文件：

```text
docs/plans/
├── 001-desktop-subtitles-persistent.md
├── 002-pip-progress-and-jieba.md
└── 003-study-panel-liquid-glass.md
```

编号连续递增，格式 `NNN-<短横线描述>.md`。**一个 PLAN 只解决一个需求**，
不允许「反正都在改这块，顺手把 B 也做了」。

PLAN 不需要写成公司技术方案，但下面五节**缺一不可**（模板见文末附录）：

| 节 | 回答的问题 | 缺了会怎样 |
|---|---|---|
| 需求 | 用户要什么 | AI 自己发明需求 |
| 做什么 / 不做什么 | 边界在哪 | 范围无限膨胀 |
| 修改范围 | 允不允许碰这些文件 | 顺手改了 A、B、C |
| 验证方式 | 怎么证明做到了 | 「代码写完」当成「功能完成」 |
| Definition of Done | 何时算完成 | AI 自称完成 |

**「不做什么」比「做什么」更重要。** 不写清不做的事，AI 就会去做。

Bug Fix 的 PLAN 还必须有第六节：**根因**。写不出根因就说明还没定位到问题，
不许直接从「现象」跳到「改法」——那是在猜。

## §2 修改范围

每个 PLAN 必须带一段 `yaml` 代码块，声明允许与禁止触碰的路径：

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

**越界时的正确反应是停下报告，不是自行判断「顺手改一下也没关系」。**
如果你认为确实需要改 `forbidden_paths` 里的文件 → 停下来告诉人，由人决定是扩范围还是另立 PLAN。

⚠️ **本仓库还没有机械防线**：这里没有 `scripts/check-plan-scope.sh`。
所以 §2 目前靠**人工核对** + §4 的 `git diff --stat` 量级比对。

要把它机械化就得新增脚本文件 —— 那是**新增文件**，必须由一个 PLAN 明确要求（§1），
不允许顺手加。

## §3 写代码的规矩

### 通用

- 修改前先读相关代码与相邻实现，**照抄现有风格**，不夹带个人偏好
- 注释、文档、提交说明**一律用中文**（全仓库一致），不要在一堆中文注释里塞英文段落
- 不允许为了完成需求顺手重构无关代码
- 不允许修改我们对外暴露的 `globalThis.__llgMod*` 接口签名，除非 PLAN 明确要求
- 优先复用现有代码，**不引入新依赖**（含 devDependencies），除非 PLAN 明确要求
- 不允许删除或弱化现有测试
- **不允许通过改测试来迁就错误实现** —— 测试红了先怀疑实现，不是先改断言。
  若确认是**旧测试固化了旧（错）语义**，必须在本 PLAN 里写明为什么改断言，并同时补一条
  能复现新语义的断言
- 遇到官方库/浏览器的行为与文档不一致时：以**实测**为准，并在注释里记下实测事实，不猜

### 本项目技术栈（实测，非推测）

- **零依赖**：构建 = `node build.mjs`（无打包器、无 babel）；测试 = `node --test`
- 内容脚本是**自执行 IIFE**，用 `globalThis.__llgMod*` 互相取用，不走消息传递
- `src/mod/` 的**数字前缀就是注入顺序**（同一 `content_scripts` 条目内 Chrome 保证按数组顺序执行）：
  - `00-` 共享设施（按钮工厂、功能注册表、僵尸 DOM 清理）
  - `05-` 纯函数（可测、无 DOM 副作用）
  - `10-` 字幕轨道（各功能的共同底座）
  - `15-` / `30-` / `40-` 具体功能
  - `50-` 把功能挂进官方设置面板
  - `*.dev.js` 只在 `make dev` 注入；`*.sw.dev.js` 只挂到官方 service worker，**绝不作为内容脚本**
- `make build` 会做**注入自检**（顺序、SW 泄漏）与**字幕浮层契约校验**；
  `make check` 校验 `dist/` 是否已正确注入
- 样式：控制栏按钮的布局用**内联样式**（YouTube 的 `.ytp-button` 规则与我们同优先级，
  只有内联才稳定）；伪类用 `!important` 压过去（官方自己也这么做）
- 软上限 **120 列**（既有文件最长 136 列，是长字符串/注释，不要再去追这个数）

### 三条血泪规矩（都是踩过的坑，别踩第二次）

1. **幂等**：只要我们对某个 shadowRoot 挂了 `MutationObserver`，而自己又改它的子树，
   就必须**先比对目标状态再写**。无脑赋值 `textContent`/`classList` 即使内容相同也是 DOM 变更，
   会把自己打成死循环（见 `15-ja-break.js`、`50-settings-panel.js`）。
2. **僵尸 DOM**：`make dev` 每次保存都会重载扩展，上一轮 content script 的上下文连同监听器一起销毁，
   但它创建的 DOM 还留在页面里。新上下文若复用这些元素，就会出现「按钮在、面板在、点了没反应」。
   `00-shared.js` 的 `STALE_IDS` 与 `50-settings-panel.js` 的 `SESSION` 标记就是干这个的；
   新增会被重载残留影响的 DOM 时，**必须登记进去**。
3. **不碰官方的文本流**：官方靠 `.linglass-word` 的 `data-start/end` 对整行文本做 slice 来实现点词、
   拖拽选词。往字幕行里塞任何可见字符都会让它整体错位。要加视觉分隔符就挂空 span + CSS `::after`
   （见 `15-ja-break.js`），一个字符都不进 `textContent`。

### 测试

- 新增业务逻辑 → 必须有冒烟测试
- 修改已有逻辑 → 必须检查该逻辑的既有测试
- **Bug Fix → 必须有回归测试**（先写一条能复现 bug 的测试，它红了，再修）
- 两层测试，改哪层跑哪层：

  ```bash
  make test          # = node --test tools/test/*.test.mjs（契约 + 冒烟，共 20+ 例）
  ```

  - **契约测试** `tools/test/contract.test.mjs`：断言我们对官方产物、YouTube 平台的所有依赖
    仍然成立。**新增任何对官方 DOM 的依赖（选择器、id、class、属性名）都必须在这里登记**，
    否则「漏登记检测」会直接失败 —— 这是设计好的摩擦，不要绕。
    （扫描边界：只扫带 `.` / `#` 前缀的字符串字面量；`className = 'xxx'` 这种赋值式写法扫不到，
    只能手工维护，所以登记表是主，漏登记检测是辅。）
  - **冒烟测试** `tools/test/smoke.test.mjs`：用 `node:vm` 开沙箱、把 `document` / `chrome` /
    `MutationObserver` 换成桩，把 `src/mod/*.js` **原封不动**跑起来。
    定时器是**手动驱动**的（`h.tick()` / `h.runTimers()`），真定时器会让测试变慢并让 `node:test` 挂住不退出。
    新增模块若要被测，就在 `harness()` 里按依赖顺序加载它。
- 契约测试要读 `vendor/`，所以**跑测试前得先有基线**（`make vendor-update`）
- 测不了的缺口要在 PLAN 里**如实登记**，不许假装测过
- 浏览器内的视觉与交互（面板滑入、画中画是否真的留在桌面、MutationObserver 真实时序）
  **Node 测不了**，属于人工确认范围 —— 有 `make probe`（CDP 驱动真实浏览器）可以半自动跑，
  但它需要 `--headed` 且要下载/复用浏览器，不是每次都跑

## §4 Git 与提交

### 提交信息

**中文**，主题行一句话说清「做了什么」（不用 `feat:` / `fix:` 前缀 —— 本仓库历史里就没有），
正文用 `- ` 列表写**为什么这么做**与**验证结果**，续行缩进 2 空格，宽度控制在 ~72 列：

```text
桌面字幕常驻：默认开启，只有显式关闭才关

- 官方把 PiP 窗口关掉时不再一走了之：pagehide 里区分「我们关的」与
  「别人关的」，后者立刻重开；缺用户手势就等下一次手势。
- enabled 落盘（默认 true），所以刷新页面 / 换视频之后依然是开着的。
- 补 4 条冒烟测试：默认开启、显式关闭不回弹、非显式关闭回弹、落盘。
```

### 一个 PLAN = 一个提交

不要把两个 PLAN 的改动混在一个提交里，也不要混入无关的格式化。

### 没有本地钩子

本仓库**没有** `lefthook` / `husky` / `.githooks`，也没有 CI 配置：
**门禁完全靠你自己在提交前跑**（§5）。所以「忘了跑」不是借口，是事故。

### 提交前必须看 diff

```bash
git status --short
git diff --stat      # 改了几个文件、增删多少行
git diff             # 具体改了什么
```

PLAN 里应写下**预期量级**（例如「2 个文件 / +80 −30」）。实际结果若差一个数量级
（9 个文件 / +900 −600），**停下检查**，不要直接 commit。

重点核对：有没有无关文件？有没有动到 `vendor/`（它被 gitignore，动了看不出来）？
有没有把整个文件重排版？`git status` 里出现 `dist/` 说明你在动生成物。

## §5 门禁

**门禁就是 Makefile 里那几个目标，不要再自己造一个 `verify.sh`**（本仓库没有，也不该有）：

```bash
make build     # 1. 有基线；2. 契约校验有告警要读；3. 注入自检必须通过
make test      # 契约测试 + 冒烟测试（node --test）
make check     # dist/ 是否已正确注入 mod 脚本、有没有残留 _metadata
```

按改动面取子集，但**改了什么就跑什么**：
- 碰了 `src/mod/**` → `make build` + `make test` + `make check`
- 只碰了 `tools/test/**` 或 `build.mjs` → `make test`（`build.mjs` 还要 `make build`）
- 只碰了 `*.md` → 不用跑，但要自己通读一遍

推送后**没有 CI 兜底**，所以「本地绿」就是你能拿到的全部保证 ——
更要如实说明哪些部分是**没有验证**的（尤其是浏览器内的视觉与交互）。

## §6 完成标准（Definition of Done）

**AI 不得自称「已完成」。** 完成与否由清单与检查结果决定：

```markdown
## Definition of Done

- [ ] 功能实现（对照 PLAN 的「做什么」逐条）
- [ ] Bug Fix 的回归测试通过（如适用）
- [ ] `make test` 全绿（贴实际输出）
- [ ] `make build` 的契约校验与注入自检无告警
- [ ] `make check` 通过
- [ ] `git diff --stat` 量级与 PLAN 预期相符
- [ ] 无 PLAN 范围外的文件改动
- [ ] PLAN 已回写（进度、遗留、与实现不符的出入）
- [ ] 浏览器内行为**要么人工确认过，要么如实标注「未验证」**
```

规矩：

- 没勾完就说「未完成」，并列出**哪几条没过、为什么**
- 测不了的、跳过的、猜的地方**必须如实说**，不许含糊成「已验证」
- 与既有文档/注释口径不一致的发现，登记进 PLAN 或另立 PLAN，**不要静默改掉**

## §7 文档最小集

**不要为了规范 AI 而创建 30 个 Markdown 文件。** 只需要：

```text
AGENTS.md            ← 本文件：AI 行为约束
docs/plans/NNN-*.md  ← 每个需求一份，做完留档
README.md            ← 面向使用者：怎么装、怎么跑、文件名约定、已知限制
```

其余按需再加（本文档**不复述** README 里已有的命令表与文件名约定，也不复述代码注释
里已写清的官方内部机制 —— 那些属于 README 与代码注释）。

不要删 `.codebuddy/`（本地 AI 配置，不是缓存）；`.scratch/` 是探针的持久化 profile 目录，
可以删。

---

## 附录：PLAN 模板

````markdown
# 001 桌面字幕常驻

> 状态：**待执行** → 执行中 → **已完成**（完成后回写本节）

## 需求

点开桌面字幕后，一切回浏览器它就被关掉。期望：常驻、默认开启、只有显式关闭才关。

## 根因（Bug Fix 必填）

（现象 → 定位 → 证据。写不出根因就别改代码。）

## 做什么

- …（逐条可勾选）

## 不做什么

- …（比「做什么」更重要）

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

1. …

## 验证方式

- [ ] `make test`（新回归测试名：…）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：…（`make probe --headed` 可半自动）

## 预期量级

2 个文件 / +80 −30 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：
- 验证结果（贴实际输出）：
- 遗留 / 与预期不符之处：
````
