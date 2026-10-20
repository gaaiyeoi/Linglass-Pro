# 022 远端仓库名改成 Linglass-Pro

> 状态：**已完成**

## 需求

用户要求：GitHub 仓库名跟着项目名一起改 ——
`https://github.com/gaaiyeoi/linglass-Pro` → `https://github.com/gaaiyeoi/Linglass-Pro`。
（PLAN 021 已经把仓库内**文件里**的项目名统一成 `Linglass-Pro`，这一轮改的是**远端仓库名**
与本地 `origin` 的地址。）

## 做什么

1. 用 `gh repo rename`（`gh` 已以 `gaaiyeoi` 登录，token 有 `repo` 权限）把仓库改名为
   `Linglass-Pro`。GitHub 会自动为旧名保留重定向，所以已有的 clone / 链接不会立刻失效。
2. 把本地 `origin` 的地址同步成新的规范地址
   `https://github.com/gaaiyeoi/Linglass-Pro.git`。
3. 复验：`gh repo view` 拿到新名字与 URL、`git ls-remote` 新地址可用、
   `git push` 仍然正常。

## 不做什么

- **不改 `dist/manifest.json` 的扩展名**（那是官方基线的身份，理由见 PLAN 021）。
- **不改本地仓库目录名**（`linglass-mod/`，不在版本控制里，改名会打断工作区与绝对路径）。
- 不转移 owner、不改仓库可见性、不动其它任何仓库设置。
- 不改任何代码：仓库里没有硬编码旧地址的引用（已用 `grep -rn 'gaaiyeoi'` 确认，只命中
  `.git/config` 里的 remote，那是本轮要同步的对象）。

## 修改范围

```yaml
allowed_paths:
  - docs/plans/022-rename-github-repo.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/**
  - tools/**
  - build.mjs
  - Makefile
  - README.md
```

本轮**没有代码/文档内容改动**，唯一的产物是本 PLAN 文件；`git remote set-url` 改的是
`.git/config`（本地配置，不进版本控制）。

## 实现方案

```bash
gh repo rename Linglass-Pro -R gaaiyeoi/linglass-Pro -y   # 远端改名（旧名自动重定向）
git remote set-url origin https://github.com/gaaiyeoi/Linglass-Pro.git
```

## 验证方式

- [ ] `gh repo view gaaiyeoi/Linglass-Pro --json name,url` 返回新名字与 URL
- [ ] `git remote -v` 指向新地址，且 `git fetch` / `git push` 正常
- [ ] 旧地址仍可访问（GitHub 的重定向）：`gh repo view gaaiyeoi/linglass-Pro` 能解析到同一个仓库
- [ ] `make test`（确认没有任何东西依赖旧仓库名 —— 严格说本轮不改代码，跑一次是兜底）

## 预期量级

1 个新文件（本 PLAN）/ 0 行代码改动

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：本 PLAN 一个提交（只有本文件）。仓库名与 `.git/config` 里的 remote URL
  不进版本控制，所以提交内容只有这份留档。

- 验证结果（实际输出）：

  ```text
  $ gh repo rename Linglass-Pro -R gaaiyeoi/linglass-Pro -y
  （退出码 0，无输出）

  $ gh repo view gaaiyeoi/Linglass-Pro --json name,url,isPrivate
  {"isPrivate":false,"name":"Linglass-Pro","url":"https://github.com/gaaiyeoi/Linglass-Pro"}

  $ gh repo view gaaiyeoi/linglass-Pro --json name,url      # 旧名仍可解析（重定向）
  {"name":"Linglass-Pro","url":"https://github.com/gaaiyeoi/Linglass-Pro"}

  $ git remote -v
  origin  https://github.com/gaaiyeoi/Linglass-Pro.git (fetch)
  origin  https://github.com/gaaiyeoi/Linglass-Pro.git (push)

  $ git fetch origin                                          # 走新地址正常
  （无报错，origin/main = 1a8ec65）
  ```

  改名前确认过仓库里没有硬编码旧地址：`grep -rn 'gaaiyeoi'`（排除 vendor/ dist/
  .git/.scratch）无命中。

- 遗留 / 与预期不符之处：
  1. **旧地址仍是重定向，不是失效**：GitHub 会把 `gaaiyeoi/linglass-Pro` 301 到新名，
     所以别人手里已有的 clone / 链接继续能用。哪天有人重建同名仓库，重定向才会让位。
  2. **`git remote set-url` 写了 `.git/config`**（本地配置、不进版本控制）——
     按「不改 git config」的规矩，这一步单独请用户确认过才做。除 remote URL 外没有改动
     任何 git 配置（user.name / email / hooks 都没碰）。
  3. 本地目录名仍是 `linglass-mod/`（同 PLAN 021 的理由，不在版本控制里）。
  4. 未改任何代码/文档内容，所以本轮 `make test` 只是兜底；本轮**没有**跑
     `make build`（未碰 `src/**` 与 `build.mjs`）。
