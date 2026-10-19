# Linglass-Pro

在 [Linglass](https://chromewebstore.google.com/detail/nhncklckpmkkhjcijjgfcgclfpbbkcba)（YouTube 双语字幕扩展）之上做**增量改造**：官方代码一个字节都不改，构建时叠加成一个新扩展。

![三大功能总览](docs/images/overview.svg)

| 功能 | 一句话说明 | 默认 |
| --- | --- | --- |
| 🖥️ 桌面字幕浮窗 | 把字幕投到系统级画中画窗口，最小化浏览器也看得见 | 关闭，自己开 |
| 📋 学习面板 | 侧栏显示整条字幕，点句跳转，能导出 Markdown / SRT | 常驻 |
| ✂️ 句内断句 | 日语字幕按「文节」断开，方便跟读 | 跟随设置 |

三个开关都挂在 **Linglass 自己的设置面板**（`Linglass-Pro` 分组）里，不是额外的悬浮按钮。

---

## 🖥️ 桌面字幕浮窗

![桌面字幕浮窗示意](docs/images/pip.svg)

- 字幕区是「上一句 / 当前句 / 下一句」三段，当前句最亮，上下文淡一些；控制栏右端 `Aa` 可以调字号 / 颜色 / 预设，与官方「外观」保持同一套观感。
- **开了就一直开着**：点浮窗自己的 `×`、刷新页面、换视频都会自动重开；只有设置面板的开关能真正关掉它。
- 播到哪一句，译文才会出现在哪一句（官方不缓存整条译文），这是官方数据本身的限制。
- 更多细节（进度驱动方式、窗口尺寸规则、注音跟随逻辑）见下方「已知限制」。

## 📋 学习面板

![学习面板的两种挂载形态](docs/images/panel.svg)

- 在视频播放页插进 YouTube 自己的推荐列，不遮挡任何东西；其它页面退回右侧悬浮。
- 宽度可拖（300–760px），关闭状态会记住。
- 实时双语字幕、当前句高亮、逐句点击跳转、导出中日对照 Markdown / 双语 SRT / 复制剪贴板。

## ✂️ 字幕句内断句

```text
私は|昨日|図書館で|日本語の|本を|借りました。|
```

- 分隔符只是一个空 `span` 的 CSS `::after`，**不进文本流**，官方的点词查词、拖拽选词完全不受影响。
- 切分规则见 [`docs/plans/020-ja-segment-rules.md`](docs/plans/020-ja-segment-rules.md)。

---

## 装好后需要登录

官方扩展**登录之后才翻译**——没有字幕数据，浮窗和面板都用不了。支持 Google / Apple 登录，也支持邮箱注册。**Google 登录在部分网络下打不开**，遇到这种情况直接用邮箱注册一个账号即可。

## 只想装上用（不写代码）

```bash
make package   # → release/Linglass-Pro-<版本>-extension.zip   （完整版，解压即用）
               #   release/Linglass-Pro-<版本>-installer.zip   （安装器版，需要先装 Node.js）
```

两种包最后都要在扩展页做同样 4 步：开发者模式 → 加载已解压的扩展程序 → 选中文件夹 → 完成。包里各带一份图文向导（[`docs/install-guide.html`](docs/install-guide.html)）。

> ⚠️ **版权说明**：完整版内含 Linglass 官方代码，仅限个人使用，请勿公开分发或上传至应用商店、论坛等公共渠道。如需对外分享，请改用不包含官方代码的安装器版。

## 起步（开发）

```bash
make vendor-update   # 下载官方基线到 vendor/，然后构建
make open            # 打开浏览器扩展管理页
```

在扩展管理页打开开发者模式 → 加载已解压的扩展程序 → 选 `dist/` 目录。日常开发用 `make dev`：改完自动重建并重载扩展。

`vendor/` 不进版本控制（官方专有代码，只读基线），第一次使用必须先跑一次 `make vendor-update`。

## 日常命令

| 命令 | 作用 |
| --- | --- |
| `make help` | 列出全部命令 |
| `make build` | 构建 `dist/` |
| `make dev` | 监听源码，自动重建并让扩展自动重载 |
| `make test` | 跑契约测试与逻辑冒烟测试 |
| `make check` | 自检 `dist/` 是否已正确注入 |
| `make probe` | 开一个带扩展的浏览器做实测 |
| `make open` | 打开扩展管理页 |
| `make package` | 打两个包到 `release/` |
| `make vendor-update` | 拉取官方最新版作为基线并重新构建 |
| `make clean` | 删除 `dist/` |

## 工作原理

![构建流程](docs/images/architecture.svg)

**只读基线 + 增量叠加**：官方产物在 `vendor/`（只读），我们的代码在 `src/mod/`，构建时叠加成 `dist/`。官方发新版只需换 `vendor/`；`git diff` 里永远不会出现官方代码。

![src/mod 的模块依赖与注入顺序](docs/images/module-map.svg)

数字前缀决定注入顺序，模块之间通过 `globalThis.__llgMod*` 直接取用，不走消息传递：

| 文件名 | 作用 |
| --- | --- |
| `00-shared.js` | 共享设施：按钮工厂、功能注册表、共享心跳、僵尸 DOM 清理 |
| `05-ja-segment.js` | 纯函数：把日文切成「文节」 |
| `10-subtitle-track.js` | 字幕轨道记录器 |
| `15-ja-break.js` | 字幕句内断句 |
| `30-desktop-subtitles.js` | 桌面字幕浮窗 |
| `40-study-panel.js` | 学习面板 |
| `50-settings-panel.js` | 挂进 Linglass 自己的设置面板 |

省资源靠三条硬约束：所有模块共用 `00-shared.js` 里**同一个** 1s 定时器；每帧 rAF 循环不碰 Shadow DOM（答案由 MutationObserver 缓存）；落盘有上限（每个视频最多 5000 句，最多留 30 个视频 / 30 天）。

## 验证方式

`make test` 当前 **123 例全绿**（零依赖，`node --test`）：

- **契约测试**：断言对官方 DOM / YouTube 平台的依赖仍然成立，新增依赖必须登记。
- **冒烟测试**：`node:vm` 沙箱里把 `src/mod/*.js` 原封不动跑起来。
- **断句 / 工具链测试**：断句切点、zip 往返、安装器、打包结构。

浏览器内的视觉与交互（面板滑入、浮窗是否真的留在桌面）Node 测不了，属于人工确认范围，`make probe` 可以半自动跑一部分。

## 已知限制

- 目前只支持 YouTube，且需要登录（见上文）。
- 字幕的句子与时间戳来自官方缓存的原文轨；**译文只在实际播放过才有**。
- 注音（振假名）只在浮窗跟随官方显示，面板与导出文件不含注音。
- 浮窗高度随内容定，字号变化不会自动重算窗口大小，拖一下即可。
- 词级时间戳拿不到（官方不暴露内部 cue 时间轴），词内进度是线性插值近似。
- 「免 Node 的干净包」做不到：安装器版要先装 Node；完整版自带官方代码。取舍见 [`docs/plans/023-one-click-installer.md`](docs/plans/023-one-click-installer.md)。
- 官方发新版不会自动同步，需要重新跑一次安装流程。

## 目录结构

```text
Linglass-Pro/
├── AGENTS.md               本仓库的 AI 行为约束（改代码前先读）
├── Makefile                门禁与日常命令
├── build.mjs               构建脚本
├── docs/
│   ├── images/             README 配图
│   ├── install-guide.html  图文安装向导
│   └── plans/NNN-*.md      一个需求一份 PLAN
├── src/mod/                我们的全部代码
├── tools/                  dev / import-vendor / install / package / probe / zip / test
├── vendor/                 官方基线（只读，不进版本控制）
├── release/                安装包产物（不进版本控制）
└── dist/                   构建产物（不进版本控制）
```

## 开发约定

- **改代码前先读 [`AGENTS.md`](AGENTS.md)**：一个需求一份 PLAN，PLAN 声明修改范围，越界要停下报告；`vendor/` 与 `dist/` 只读；Bug Fix 必须带回归测试。
- 需求与设计留档在 [`docs/plans/`](docs/plans)，编号连续递增。
- 提交前跑门禁（改 `src/mod/**` 就 `make build` + `make test` + `make check`），用 `git diff --stat` 核对改动量级。
- 全仓库零第三方依赖。
