# 026 README 瘦身 + 补账号说明

> 状态：**已完成**（文档改动，未跑 Node 门禁；见文末）

## 需求

1. README 太长太细（258 行），细节压过了「这是什么、怎么装、怎么用」，需要瘦身。
2. 补一条安装侧说明：官方扩展**登录后才翻译**，而 **Google 登录在部分网络下打不开**，
   此时应当用**邮箱注册一个自己的账号**，而不是在登录页反复重试。

## 做什么

- 重写 `README.md`：保留事实，去掉重复与长表；把「字幕断句」的 9 行规则表与 6 条边界
  压成两段并指向 `docs/plans/020-ja-segment-rules.md`；「验证方式」的 5 段长文压成 4 条。
- 新增「装好后要用账号」一节：登录是前提、Google 登录可能不可用、可改用邮箱注册。
- `docs/install-guide.html` 顶部补一条同样口径的提示（终端用户读的是包里那份 `INSTALL.html`，
  只改 README 等于没告诉他）。

## 不做什么

- 不改任何代码、测试、构建脚本、`Makefile`。
- 不删 README 里的事实性内容（只是压缩表达与合并重复），不新增猜测性的说法。
- 不动 `vendor/` 与 `dist/`。
- 不改 `docs/install-guide.html` 的样式与既有条目，只**新增**一段提示。

## 修改范围

```yaml
allowed_paths:
  - README.md
  - docs/install-guide.html
  - docs/plans/026-readme-simplify-and-account-note.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/**
  - tools/**
  - Makefile
  - build.mjs
  - AGENTS.md
```

## 实现方案

1. 事实核对（已做）：
   - 官方基线里存在 `loginWithGoogle()`、`signup.*`（邮箱 + 密码注册）、
     `sidepanel.auth.withoutAccount`（免账号入口）与 `err.oauthOnlyGoogle` 文案，
     → 「支持 Google 登录，也支持邮箱注册」有据。
   - `src/mod/10-subtitle-track.js` 的骨架来自官方落进 `chrome.storage.local` 的原文轨，
     官方不翻译它就不写缓存 → 「不登录就没有字幕数据」有据。
2. 按「是什么 → 怎么装 → 怎么跑 → 怎么测」重排 README，长表全部换成短表或一行引用。
3. 断句的判据与边界改为指向 PLAN 020，README 只留一句示例 + 一句边界小结。
4. `docs/install-guide.html`：在「先确认手上是哪个包」那个 `.note` 之后追加一个 `.note`，
   用同样的 `.note` 样式（不引入新 class）。

## 验证方式

- [x] 只碰 `*.md` 与 `*.html` → 按 AGENTS.md §5 不用跑门禁；通读一遍全文
- [ ] 逐条核对 README 里出现的路径都真实存在（`docs/images/*.svg`、`docs/plans/*.md`）
- [ ] 人工确认 `docs/install-guide.html` 在浅色/深色两种主题下可读（沿用既有 class，理论上无风险）

## 预期量级

3 个文件 / +60 −140 行左右（README 净减 80~100 行）

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：（待提交）
- 验证结果：
  - `git diff --stat`：`README.md | 145 +++---`、`docs/install-guide.html | 15 +`，
    与「3 个文件 / +60 −140」的量级相符（README 258 行 → 196 行，净减 62 行）；
    `git status` 里没有 `src/**`、`tools/**`、`vendor/`、`dist/` 的改动属于本 PLAN
    （`src/mod/**`、`tools/test/smoke.test.mjs` 是 PLAN 025 的未提交工作，不是本轮引入的）。
  - 链接核对：README 里出现的 10 个仓库内路径全部存在（4 个 SVG、3 份 PLAN、安装向导、AGENTS.md、docs/plans）。
  - 未跑 `make test` / `make build` / `make check` —— 本轮只碰 `*.md` 与 `*.html`，按 §5 取子集不必跑。
- 遗留 / 与预期不符之处：
  - README 的「断句」一节从 9 行规则表 + 6 条边界压成两段 + 指向 PLAN 020，
    细节没有丢，只是搬了位置。
  - 「装好后需要登录」这条提示目前只在 README 与安装向导里；
    发布包内的 `INSTALL.html` 由 `docs/install-guide.html` 生成，两边口径一致。
  - 未验证的部分：安装向导新增的 `.note` 在浅色 / 深色主题下的实际观感
    （沿用既有 `.note` 类，理论无风险），以及真机上「Google 登录打不开」的具体表现 ——
    那条结论来自官方基线里的 `loginWithGoogle()` / `signup.*` 文案与常见网络受限事实，
    本项目未做网络层实测。
