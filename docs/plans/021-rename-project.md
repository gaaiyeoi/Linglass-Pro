# 021 项目名统一为 Linglass-Pro

> 状态：**已完成**（Node 侧门禁全绿；设置面板里的字样属人工确认范围）

## 需求

用户要求：**项目名称改成 `Linglass-Pro`**。

现状是三套写法混用：

- `README.md` 的标题与目录树根写的是小写 `linglass-Pro`；
- `Makefile` / `build.mjs` 的头部注释、以及**扩展内设置面板的分组名**叫 `Linglass Mod`；
- GitHub 仓库名已经是 `linglass-Pro`。

## 做什么

把**项目自己的名字**统一成 `Linglass-Pro`（大小写与连字符固定），共 5 处：

1. `README.md` 的 h1 标题：`# linglass-Pro` → `# Linglass-Pro`
2. `README.md` 目录树里的根目录名：`linglass-Pro/` → `Linglass-Pro/`
3. `README.md` 描述设置面板分组那行：`Linglass Mod` 分组 → `Linglass-Pro` 分组
4. `Makefile` 顶部注释：`# Linglass Mod —— 常用命令` → `# Linglass-Pro —— 常用命令`
5. `build.mjs` 顶部注释：`Linglass Mod 构建脚本` → `Linglass-Pro 构建脚本`
6. `src/mod/50-settings-panel.js` 的 `SECTION_TITLE`：`'Linglass Mod'` → `'Linglass-Pro'`
   （用户在 Linglass 设置面板里看到的分组标题）

不改的：`Linglass` 单词本身（那是上游产品名，出现在「Linglass 自己的设置面板」
「Linglass 风格」等描述里，一旦改掉就指向错的东西）。

## 不做什么

- **不改 `manifest.json` 里的扩展名**。`dist/manifest.json` 是从官方基线复制出来再改版本号的，
  它的 `name`（Linglass）是**官方产品的身份**：改它会让加载进浏览器的扩展改名、和商店那份
  看起来是两个东西，也会影响「官方发新版只换 vendor/」这条工作流。项目自己的名字出现在
  文档、注释与设置面板分组上已经够用。用户若要连扩展名一起改，另立 PLAN。
- 不重命名**仓库目录**（本地是 `linglass-mod/`）：那是用户机器上的路径，不在版本控制里，
  改名会打断 IDE 工作区与所有绝对路径。
- 不改 `vendor/`、`dist/`、`tools/`、其它 `src/mod/*.js`。
- 不碰 `.scratch/`（探针的持久化 profile，里面的 `linglass-promo-budget` 之类是官方
  storage key，与本项目名无关）。

## 修改范围

```yaml
allowed_paths:
  - README.md
  - Makefile
  - build.mjs
  - src/mod/50-settings-panel.js
  - docs/plans/021-rename-project.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/05-ja-segment.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - tools/**
  - AGENTS.md
```

## 实现方案

逐处替换 + 一次全局复核（`grep -i` 确认没有漏网的 `Linglass Mod` / 小写 `linglass-Pro`）。

## 验证方式

- [ ] `make test`（改的是设置面板的字符串常量，先确认没有用例断言旧值）
- [ ] `make build` + `make check`（动了 `src/mod/50-settings-panel.js` 与 `build.mjs`）
- [ ] `grep -rn -i -e 'linglass mod' -e 'linglass-pro'` 只剩 `Linglass-Pro`
- [ ] 浏览器人工确认：设置面板里的分组标题显示为 `Linglass-Pro`（Node 测不了视觉）

## 预期量级

5 个文件 / +8 −8 行（纯改名，无逻辑改动）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：本 PLAN 一个提交（`README.md`、`Makefile`、`build.mjs`、
  `src/mod/50-settings-panel.js`、本文件）。工作区里仍有别的会话未提交的
  `src/mod/10/30/40-*.js`、`tools/test/smoke.test.mjs` 与 PLAN 013~017 / 019，
  不在本提交内。

- 验证结果（实际输出）：

  ```text
  $ grep -rn -i -e 'linglass mod' -e 'linglass-pro' --exclude-dir=vendor --exclude-dir=dist --exclude-dir=.scratch .
  （只剩下面的 Linglass-Pro，以及本 PLAN 里为了说明改了什么而引用的旧写法）

  Makefile:1:# Linglass-Pro —— 常用命令
  README.md:1:# Linglass-Pro
  README.md:81:…（`Linglass-Pro` 分组）…
  README.md:141:Linglass-Pro/
  build.mjs:3: * Linglass-Pro 构建脚本
  src/mod/50-settings-panel.js:47:  const SECTION_TITLE = 'Linglass-Pro';

  $ make test    → ℹ tests 85  ℹ pass 85  ℹ fail 0
  $ make build   → 契约校验 ✓ / 版本 1.12.900
  $ make check   → 版本 1.12.900，已注入 7 个 mod 脚本
  ```

  改前先确认过没有用例断言旧字符串（`grep -rn 'SECTION_TITLE\|Linglass Mod'`
  只命中实现本身），所以 85 例全绿不是「顺着改断言」来的。

- 遗留 / 与预期不符之处：
  1. **`dist/manifest.json` 的扩展名仍是官方的 `Linglass`**（有意不改，见「不做什么」）。
     用户若要求连扩展名一起改，另立 PLAN —— 那会影响「官方发新版只换 vendor/」
     这条工作流与商店更新路径。
  2. **本地仓库目录名仍是 `linglass-mod/`**（不在版本控制里，改名会打断工作区与
     绝对路径）。GitHub 仓库名本来就是 `linglass-Pro`。
  3. **设置面板里的分组标题属人工确认范围**：Node 测不了视觉，`make probe` 可半自动跑。
  4. 量级与预期相符：5 个文件 / 各 1 行的替换（+PLAN 文件）。
