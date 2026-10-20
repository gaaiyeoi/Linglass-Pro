# 贡献指南

## 开发环境

- Node.js 18 或更高版本
- Chrome、Arc 或其他 Chromium 116 及以上浏览器
- macOS 或 Windows；部分命令依赖 `make`，Windows 需在 Git Bash 或 WSL 中运行

首次检出仓库后执行：

```bash
make vendor-update   # 从 Chrome 商店获取 Linglass 基线并构建
make open            # 打开扩展管理页
```

在扩展管理页启用开发者模式，选择「加载已解压的扩展程序」，选中 `dist/`。

## 提交前

1. 阅读 [`AGENTS.md`](AGENTS.md)，确认改动符合开发规范。
2. 为需求建立 PLAN，文件位于 `docs/plans/`，格式为 `NNN-<描述>.md`。
3. 按改动范围执行检查：

   ```bash
   make build     # 修改 src/mod/** 时
   make test      # 所有代码与测试改动
   make check     # 修改 src/mod/** 或构建脚本时
   ```

4. 使用 `git diff --stat` 确认改动量与 PLAN 预期一致，且不包含无关文件。

## 代码约定

- 不引入第三方依赖，构建与测试使用 Node.js 内置能力。
- `vendor/` 与 `dist/` 只读，不提交到版本控制。
- 注释与文档使用中文。
- 单行长度上限 120 列。
- 新增对 Linglass DOM 的依赖时，在 `tools/test/contract.test.mjs` 中登记。
- Bug 修复需附带能复现问题的回归测试。

## 提交信息

主题行使用中文，一句话说明改动内容。正文以 `- ` 列表说明改动原因与验证结果。

```text
修复浮窗在切换视频后被关闭

- 记录 enabled 状态，页面切换后重新打开浮窗。
- 补充一条冒烟测试覆盖该场景。
```

## 文档

行为变更需要同步更新 `README.md`、`docs/install-guide.html` 或 `AGENTS.md` 中受影响的说明。
