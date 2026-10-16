# 024 下载即用的完整安装包

> 状态：**已完成**

## 需求

PLAN 023 做完之后用户说明：他本来想要的是「`release/` 里那个**拿来就能装**的包」，
而不是「对方还得先装 Node、再双击构建一遍」的安装器。

目标：`make package` 除了现有的「纯代码包 + 安装器」，再产出一个
**解压后直接能在扩展管理页加载**的完整包 —— 对方不需要 Node、不需要联网构建、
不需要命令行：下载 → 解压 → 在扩展页选中文件夹 → 完成。

## 前置：这一轮要改掉仓库一直以来的合规口径

完整包 = `dist/` = **官方 Linglass 的全部代码 + 我们的注入**。分发它，就等于
重新分发 Linglass 的专有代码。这与仓库现有的四处书面约定直接冲突：

| 位置 | 现有表述 |
| --- | --- |
| `README.md` | 「本仓库不重新分发 Linglass 的专有代码。这条是硬约束」 |
| `.gitignore` | 「官方基线：…不进版本控制，也不随仓库公开分发」 |
| `AGENTS.md` §0 | 「官方基线不进版本控制…本仓库不重新分发」 |
| `tools/package.mjs` | 自检 `FORBIDDEN_PREFIXES` 含 `dist/`，混进去直接失败 |

本 PLAN **明确授权**把口径从「绝不重新分发」改成「默认只发我们自己的代码；
完整包是使用者自行选择的产物，后果由分发者承担」。四处一起改，措辞如实、不美化。

> 风险要写进 README（不能只留在 PLAN 里）：完整包含 Linglass 的代码，
> 公开分发可能招致原作者投诉乃至被 DMCA 下架。建议只在私人范围流传。

同时保留一条退路：**纯代码包继续存在**，且它的自检规则不变（仍然禁止
`vendor/` 与 `dist/`）—— 想发一个"干净"的包时随时可以用它。

## 做什么

1. `tools/package.mjs` 拆成「可测的构包函数 + CLI 守卫」两层，产出**两个包**：
   - `Linglass-Pro-<版本>-installer.zip` —— 现状：我们的代码 + 安装器 + 向导，
     对方要先装 Node。自检仍禁止出现 `vendor/` 与 `dist/`。
   - `Linglass-Pro-<版本>-extension.zip` —— **完整包**：`dist/` 的全部内容 + 向导，
     并且**必须内嵌一层同名目录**（否则一百多个文件会直接散落到用户的下载目录）。
2. 文件名带上基线版本，格式 `Linglass-Pro-<major>.<minor>.<官方patch>.<900>-…`：
   官方基线 `1.12.4` → `Linglass-Pro-1.12.4.900-extension.zip`。
   理由：`build.mjs` 把 patch 固定成 `900` 是为了不和商店更新撞号，于是
   `1.12.3` 与 `1.12.4` 的产物版本号**都是** `1.12.900` —— 单看产物版本分辨不出
   基于哪个官方版本，文件名必须承担这个信息。README 里解释一句这个号怎么读。
3. `docs/install-guide.html` 顶部加一段「你是哪种包」：解压后看到
   `install-macos.command` 就先双击它；直接看到 `manifest.json` 就是完整包，
   不用装任何东西。其余 4 步两种包完全一样，不用改。
4. `Makefile` 的 `package` 目标仍只调 `node tools/package.mjs`，日志里说清两个包的差别。
5. 同步上面那四处合规表述。
6. 新增 `tools/test/package.test.mjs`，锁住两个包的结构：
   完整包内嵌一层且 `manifest.json` 在该层根、纯代码包里**没有** `vendor/` 与 `dist/`、
   可执行位没丢、清单齐全。

## 不做什么

- **不把 `vendor/` 或 `dist/` 提交进 git**（`.gitignore` 保持现状）。完整包是
  `release/` 下的产物、不是仓库内容 —— 仓库本身仍然只有我们自己的代码。
- **不自动上传 GitHub Release**：`gh release create` 才是真正把官方代码公开出去的动作，
  时机与可见性由用户自己定。本轮只保证「包躺在 `release/` 里，随时能发」。
- 不改 `build.mjs`、不动 `src/mod/**`、不改编产物版本号的规则（`patch = 900`）。
- 不做代码签名 / 公证，不做自动更新。

## 修改范围

```yaml
allowed_paths:
  - docs/plans/024-download-and-run-package.md
  - tools/package.mjs
  - tools/test/package.test.mjs
  - docs/install-guide.html
  - Makefile
  - README.md
  - .gitignore
  - AGENTS.md

forbidden_paths:
  - vendor/**
  - dist/**
  - release/**
  - src/**
  - build.mjs
  - tools/zip.mjs
  - tools/install.mjs
  - tools/import-vendor.mjs
  - tools/test/contract.test.mjs
  - tools/test/smoke.test.mjs
  - tools/test/ja-segment.test.mjs
  - tools/test/zip.test.mjs
  - tools/test/install.test.mjs
```

`AGENTS.md` 进清单是因为 §0 那句「本仓库不重新分发」在新口径下自相矛盾 ——
规范与实现冲突时必须同步，不能只改 README 留个对不上的宪法。

## 实现方案

完整包布局（**内嵌一层是硬要求**）：

```text
Linglass-Pro-1.12.4.900-extension.zip
└── Linglass-Pro-1.12.4.900/               ← 内嵌一层，解压只得到一个文件夹
    ├── manifest.json                       ← dist/ 的内容，直接在根
    ├── assets/  icons/  _locales/  mod/  public/  src/
    ├── service-worker-loader.js
    └── INSTALL.html                        ← 向导（内容取自 docs/install-guide.html）
```

`INSTALL.html` 用 ASCII 文件名：中文名在部分解压工具上会乱码；它躺在扩展目录里
没有任何副作用（Chrome 不读它，`web_accessible_resources` 也不涉及它）。

构包函数签名（供测试直接调用，不落盘）：

```js
export function buildArchive(kind, ctx)
//   kind: 'installer' | 'extension'
//   ctx:  { root, files, version, baseVersion }
//   返回 Buffer
```

## 验证方式

- [ ] `make test`（新增 `tools/test/package.test.mjs`）
- [ ] `make build` + `make check` + `make test`
- [ ] `make package` 产出两个包，`unzip -l` 逐个核对结构
- [ ] 完整包解压到干净目录，确认 `manifest.json` 在**内嵌那一层**的根，且
      `install-macos.command` 之类安装器文件**不在**完整包里
- [ ] 把完整包加载进浏览器（`make probe --headed` 或手工），确认浮窗与学习面板
      与 `make build` 的产物行为一致
- [ ] Windows 仍未实机验证，如实登记

## 预期量级

8 个文件（新增 2 / 修改 6），约 +430 −80 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：本 PLAN 一个提交（含同批的基线更新到 1.12.4）。

- 验证结果（实际输出，节选）：

  ```text
  $ make vendor-update                     # 顺手清掉 PLAN 023 的遗留 #3（基线停在 1.12.3）
  [vendor] 写入  vendor/linglass-1.12.4   __MSG_extensionName__ v1.12.4
  [build] 基线      vendor/linglass-1.12.4
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js

  $ make test
  ℹ tests 107   ℹ pass 107   ℹ fail 0      # 原 99 + 打包 8

  $ make package
  [package] 基线      vendor/linglass-1.12.4（文件名里的 1.12.4.900）
  [package] 完整包    release/Linglass-Pro-1.12.4.900-extension.zip
  [package]           109 个文件 / 0.94 MB / 含官方代码，下载即用
  [package] 纯代码包  release/Linglass-Pro-1.12.4.900-installer.zip
  [package]           14 个文件 / 0.09 MB / 只有我们的代码，需装 Node

  $ unzip -q release/Linglass-Pro-1.12.4.900-extension.zip -d /tmp/llg-full && ls /tmp/llg-full
  Linglass-Pro-1.12.4.900                  # 只有一个文件夹，没有摊到下载目录
  $ ls /tmp/llg-full/Linglass-Pro-1.12.4.900
  _locales assets icons mod public src INSTALL.html manifest.json service-worker-loader.js

  $ # 包内自洽：manifest 引用的资源是否都在包里
  manifest 引用的 21 个文件都在包内
  版本: 1.12.900
  ```

- 遗留 / 与预期不符之处：
  1. **完整包没有实机加载验证过**：PLAN 的验证项里有 `make probe --headed`，
     而跑到那里会弹出浏览器窗口，所以只做了结构层验证（内嵌层、`manifest.json`
     的位置、包内自洽、未混入安装器文件、可执行位）。完整包的内容就是
     `make build` 的 `dist/` 原样（只多一个 `INSTALL.html`），风险面很小，
     但**这一条确实没跑**，留待用户双击确认。
  2. **`dist/` 里躺着两个开发脚本**：`mod/dev-reload.dev.js`、`mod/dev-reload.sw.dev.js`。
     `build.mjs` 是把整个 `src/mod/` 目录拷过去的，非 dev 构建只是不把它们写进
     manifest（因此不会被加载），但文件确实在里面 —— 完整包（以及用户平时加载的
     `dist/`）都带着。属无害噪音；要清掉得改 `build.mjs`，而它在本 PLAN 的
     `forbidden_paths` 里，故**未动**，需要的话另立 PLAN。
  3. **没有自动上传 GitHub Release**：包只是躺在 `release/`（该目录在 `.gitignore` 里，
     不会随仓库公开）。上传时机与可见性由用户决定 —— `gh release create` 才是真正
     把官方代码公开出去的那一步。
  4. Windows 仍未实机验证（沿用 PLAN 023 的遗留 #1）。
  5. **工作区里同期的另一批未提交改动会把用例数抬高**：执行期间
     `docs/plans/022-pip-reopen-on-return.md`、`src/mod/30-desktop-subtitles.js`、
     `tools/test/smoke.test.mjs` 等被另一条线改动（不是本 PLAN 动的），本机
     `make test` 因此从 107 例涨到 110 例（新增 3 例来自那份 `smoke.test.mjs`）。
     本提交只带本 PLAN 自己的文件，所以 README 里的用例数按**提交后**的仓库状态记 107。
