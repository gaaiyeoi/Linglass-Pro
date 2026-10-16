# linglass-Pro

在 [Linglass](https://chromewebstore.google.com/detail/nhncklckpmkkhjcijjgfcgclfpbbkcba) 之上做增量改造的浏览器扩展：桌面字幕浮窗、边栏学习面板、逐句字幕轨道与中日对照导出。

## 设计原则

**只读基线 + 增量叠加。** 官方扩展的打包产物放在 `vendor/` 下，一个字节都不改；我们所有的代码都在 `src/mod/`，构建时叠加到 `dist/`。

这样做的好处：官方发新版时只需换 `vendor/` 目录（一条命令），`src/mod/` 原样可用；`git diff` 里永远不会出现官方代码，一眼能分清哪些是我们写的。

构建脚本会顺着官方产物动态校验我们依赖的 DOM 契约，官方改版时在构建阶段就告警，而不是等你打开视频发现功能失效。

## 环境要求

- Node.js 18+（用到 `node:test` 与全局 `fetch`）
- macOS（`make vendor-update` 依赖系统的 `unzip`）
- Arc 或任意 Chromium 116+ 浏览器（桌面字幕浮窗需要 `documentPictureInPicture`）

## 起步

```bash
make vendor-update   # 从 Chrome 商店下载官方基线到 vendor/，然后构建
make open            # 打开浏览器扩展管理页
```

在 `arc://extensions`（或 `chrome://extensions`）里打开开发者模式，点「加载已解压的扩展程序」，选本项目的 `dist/` 目录。

> `vendor/` 不在版本控制里 —— 那是 Linglass 的专有代码，本仓库不重新分发它。第一次使用必须先跑 `make vendor-update`。

## 日常命令

| 命令 | 作用 |
| --- | --- |
| `make help` | 列出全部命令 |
| `make build` | 构建 `dist/`（正式版） |
| `make test` | 跑契约测试与逻辑冒烟测试 |
| `make check` | 自检 `dist/` 是否已正确注入 |
| `make open` | 打开浏览器扩展管理页 |
| `make dev` | 监听源码，自动重建并让扩展自动重载 |
| `make vendor-update` | 从 Chrome 商店拉取官方最新版作为基线，并重新构建 |
| `make vendor-from FROM=~/x.crx` | 从本地 crx / zip / 解压目录导入基线 |
| `make clean` | 删除 `dist/` |

## `src/mod/` 的文件名约定

数字前缀决定注入顺序。同一扩展的所有内容脚本共享一个 isolated world，因此各模块直接通过 `globalThis.__llgMod*` 互相取用，不走消息传递。

| 文件名 | 作用 |
| --- | --- |
| `00-shared.js` | 共享设施：Linglass 风格的控制栏按钮工厂、功能注册表 |
| `05-format.js` | 纯函数：时间格式化、Markdown / SRT 导出 |
| `10-subtitle-track.js` | 字幕轨道记录器（各功能的共同底座） |
| `30-desktop-subtitles.js` | 桌面字幕浮窗（系统级画中画 + 歌词式进度） |
| `40-study-panel.js` | 边栏学习面板（实时字幕、逐句列表、导出） |
| `50-settings-panel.js` | 把我们的功能挂进 Linglass 自己的设置面板 |
| `*.dev.js` | 只在 `make dev` 时注入的内容脚本 |
| `*.sw.dev.js` | 只在 `make dev` 时挂到官方 service worker 上的模块 |

## 验证方式

`make test` 包含两层：

- **契约测试** —— 断言我们对官方产物的全部依赖仍然成立（DOM class、shadowRoot 模式、点击处理器的短路行为、面板的裁剪机制）。它从源码里提取我们实际用到的选择器，而不是读一份手写清单。
- **逻辑冒烟测试** —— 在 Node 里用桩件驱动真实的轨道模块与格式化模块，覆盖时间轴推导、去重、暂停保护、导出格式与持久化。

浏览器内的视觉与交互行为需要在 Arc / Chrome 里人工确认。

## 已知限制

- 目前只支持 YouTube。
- 译文来自 Linglass 自己渲染的字幕，因此只能覆盖它已经展示过的句子。
