# Linglass-Pro

Linglass-Pro 是基于 [Linglass](https://chromewebstore.google.com/detail/nhncklckpmkkhjcijjgfcgclfpbbkcba)（YouTube 双语字幕扩展）构建的 Chrome 扩展，提供桌面字幕浮窗、手机字幕屏、学习面板与日语句内断句。

Linglass 商店版本作为只读基线存放于 `vendor/`，扩展源码位于 `src/mod/`，`make build` 将两者合并为可直接加载的 `dist/`。

## 功能

| 功能 | 说明 | 默认状态 |
| --- | --- | --- |
| 桌面字幕浮窗 | 将字幕显示在系统级画中画窗口，浏览器最小化后仍然可见 | 关闭，手动开启 |
| 手机字幕屏 | 通过局域网在同一 Wi-Fi 的手机上全屏显示字幕 | 关闭，手动开启 |
| 学习面板 | 侧栏显示完整字幕，支持逐句跳转与 Markdown / SRT 导出 | 常驻 |
| 句内断句 | 日语字幕按文节断开 | 跟随设置 |

以上开关位于 Linglass 设置面板的 `Linglass-Pro` 分组。

![功能总览](docs/images/overview.svg)

## 安装

从 [Releases](https://github.com/gaaiyeoi/Linglass-Pro/releases) 下载 `Linglass-Pro-<版本>-installer.zip`，然后：

1. 安装 Node.js 18 或更高版本，下载地址为 [nodejs.org](https://nodejs.org)。
2. 解压下载的 zip。
3. 双击 `install-macos.command`；Windows 双击 `install-windows.bat`。macOS 首次运行需右键选择「打开」。
4. 安装脚本从 Chrome 商店下载 Linglass 当前版本到本机 `vendor/`，并构建 `dist/`。
5. 打开扩展管理页，启用开发者模式，选择「加载已解压的扩展程序」，选中 `dist/` 目录。

zip 内含图文向导 [`docs/install-guide.html`](docs/install-guide.html)。

安装完成后需要登录 Linglass 账号，字幕才会显示。支持 Google、Apple 登录与邮箱注册；Google 登录在部分网络下无法打开时，可使用邮箱注册，功能一致。

## 使用

### 桌面字幕浮窗

![桌面字幕浮窗示意](docs/images/pip.svg)

- 字幕区分「上一句 / 当前句 / 下一句」三段，当前句高亮显示。
- 控制栏上方显示整片进度条：已播放部分为白色，悬停时加粗，点击或拖动可跳转到对应位置。直播等无法确定时长的情况不跳转。
- 在字幕区上下滚动可切换句子：上滑向前，浮层显示选中句前后各两句，停止滚动后跳转到该句开头。
- 从浮窗或页面字幕复制句子时，会移除振假名与文节分隔符，粘贴结果为原始文本。
- 控制栏右端的 `Aa` 按钮打开整页设置面板，包含根页、外观页与观看模式页，末尾为 `Linglass-Pro` 分组。设置写回 Linglass 的同一份配置，页面内字幕同步变化。
- 浮窗默认关闭，只有控制栏的「桌面字幕」按钮或设置面板中的开关会打开。打开后持续生效：点击浮窗的 `×`、刷新页面或切换视频都会重新打开，只有设置面板中的开关会关闭浮窗。
- 译文只在实际播放到对应句子时出现。Linglass 不缓存整条译文，这是数据来源的限制。

### 手机字幕屏

![手机字幕屏：Mac 推送至局域网中转，中转通过 SSE 发送至手机](docs/images/cast.svg)

将当前播放的句子同步到手机，在手机上全屏查看字幕。

```bash
make cast        # 启动局域网中转，默认端口 8899，终端输出手机访问地址
make cast-demo   # 使用模拟字幕预览手机端排版
```

1. 手机与 Mac 连接同一个 Wi-Fi，在手机浏览器中打开终端输出的地址，例如 `http://192.168.x.x:8899/?room=demo` 或 `http://<主机名>.local:8899/?room=demo`。首次运行需要在 macOS 防火墙弹窗中允许访问。
2. 在 YouTube 播放页点击控制栏的「手机字幕屏」按钮，按钮变为「关闭手机字幕屏」后开始推送。设置面板的 `Linglass-Pro` 分组中也有同一开关与「测试手机字幕屏连接」。
3. 手机端排版与浮窗一致，包含上一句 / 当前句 / 下一句、文节分隔、注音与双语。底部为整片进度条与常驻播放控制条（`−5s`、播放暂停、`+5s`、倍速），右上角 `⚙` 可调整样式、字号、颜色、双语、上下文与进度条。通过「分享 → 添加到主屏幕」从图标打开时不显示地址栏，iOS 仅在 standalone 模式下支持全屏。
4. 上滑字幕区可按句回看，滑动距离决定翻动句数，浮层中间一行是将要跳转的句子；松手后 Mac 上的播放器跳转到该句开头。下滑则移向更晚的句子。

- 推送使用 SSE，手机断线后自动重连；Mac 暂停且字幕未变化时不重复发送。
- 播放控制使用反向通道：手机将命令发送至中转，扩展在下一拍推送的响应中读取并操作 Mac 上的 `video`。暂停时每秒发送一次空推送，用于传递命令。
- 房间号 `?room=` 仅用于隔离多台手机或多个标签，不做鉴权。同一 Wi-Fi 下访问该地址的用户均可看到字幕。
- 更换端口：执行 `PORT=9000 node tools/cast-server.mjs`，同时通过 `__llgModCast.setConfig` 修改扩展侧的 `endpoint`。
- 修改中转站或接收页代码后需重启 `make cast`；手机端也需重新加载页面，SSE 断线重连不会重新拉取 HTML。

### 学习面板

![学习面板的两种挂载形态](docs/images/panel.svg)

- 在视频播放页插入 YouTube 推荐列，不遮挡页面内容；其他页面显示为右侧悬浮面板。
- 宽度可拖动，范围 300–760px；关闭状态会被记住。
- 提供实时双语字幕、当前句高亮、逐句点击跳转，以及中日对照 Markdown、双语 SRT 导出与复制到剪贴板。
- 面板与导出默认使用整条原文轨。原文与时间戳来自 Linglass 缓存的完整字幕，未播放过的句子也会列出；译文只出现在实际播放过的句子上。

### 离线翻译

扩展不提供内置在线翻译，也不需要填写第三方 API Key。翻译在扩展之外完成，扩展负责文件导入与导出：

1. 在学习面板页脚或设置面板的 `Linglass-Pro` 分组中选择「原文 SRT」，导出仅含原文的单语 SRT。
2. 在扩展之外翻译每一句，保持条数与时间戳不变。
3. 回到同一视频，选择「导入译文」，选中翻译后的 SRT。

- 导入的译文直接替换视频画面中的译文行，原文行、振假名与点词拖选保持 Linglass 原样。
- 导入时每一句的文本整体作为译文；一句包含多个文本行时以空格拼接。
- 按时间戳对齐，容差 ±1.5s；未对齐的句子数会在结果中报告为「已贴 x / N 句」。
- 导入译文优先于 Linglass 采样，继续播放不会被覆盖；切换视频后返回仍然保留。
- 播客类 ASR 轨断句较碎、长难句较多时，可使用整条轨道导入：设置面板 → `导入整条轨道`，选择双语 SRT，第一行为原文，其余行为译文。

### 句内断句

```text
私は|昨日|図書館で|日本語の|本を|借りました。|
```

分隔符为空 `span` 的 CSS `::after`，不进入文本流，Linglass 的点词查词与拖拽选词不受影响。切分规则见 [`docs/plans/020-ja-segment-rules.md`](docs/plans/020-ja-segment-rules.md)。

## 开发

要求 Node.js 18 或更高版本、macOS 或 Windows，以及 Chrome、Arc 或其他 Chromium 116 及以上浏览器。

```bash
make vendor-update   # 获取 Linglass 基线到 vendor/ 并构建
make open            # 打开浏览器扩展管理页
```

在扩展管理页启用开发者模式，选择「加载已解压的扩展程序」，选中 `dist/` 目录。日常开发使用 `make dev`，修改后自动重建并重载扩展。

`vendor/` 不纳入版本控制，首次使用需执行一次 `make vendor-update`。npm 脚本与 Makefile 目标等价，也可使用 `npm run build`、`npm test`。

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `make help` | 列出全部命令 |
| `make build` | 构建 `dist/` |
| `make dev` | 监听源码，自动重建并重载扩展 |
| `make test` | 运行契约测试与冒烟测试 |
| `make check` | 检查 `dist/` 的注入结果 |
| `make probe` | 启动带扩展的浏览器进行实测 |
| `make cast` | 启动手机字幕屏的局域网中转，默认端口 8899 |
| `make cast-demo` | 使用模拟字幕启动局域网中转 |
| `make open` | 打开扩展管理页 |
| `make package` | 生成发布包到 `release/` |
| `make vendor-update` | 获取 Linglass 最新版本作为基线并重新构建 |
| `make clean` | 删除 `dist/` |

### 目录结构

```text
Linglass-Pro/
├── .github/workflows/      CI 配置
├── AGENTS.md               开发规范
├── CONTRIBUTING.md         贡献指南
├── Makefile                构建与检查命令
├── build.mjs               构建脚本
├── package.json            脚本入口与 Node.js 版本要求
├── docs/
│   ├── images/             README 配图
│   ├── install-guide.html  安装向导
│   └── plans/NNN-*.md      需求与设计记录
├── src/mod/                扩展源码
├── tools/                  开发、安装、打包、测试与局域网中转脚本
├── vendor/                 Linglass 基线，不纳入版本控制
├── release/                发布包产物，不纳入版本控制
└── dist/                   构建产物，不纳入版本控制
```

### 构建与模块

构建采用只读基线加增量合并的方式：Linglass 商店版本存放于 `vendor/`，扩展源码位于 `src/mod/`，构建后生成 `dist/`。Linglass 发布新版本时只需替换 `vendor/`，`src/mod/` 无需改动。

![src/mod 的模块依赖与注入顺序](docs/images/module-map.svg)

文件名前缀决定注入顺序，模块之间通过 `globalThis.__llgMod*` 直接调用，不使用消息传递。

| 文件名 | 作用 |
| --- | --- |
| `00-shared.js` | 共享设施：按钮工厂、功能注册表、共享心跳、僵尸 DOM 清理 |
| `05-ja-segment.js` | 将日文切分为文节，纯函数实现 |
| `05-srt.js` | SRT 解析与译文回填计划，纯函数实现 |
| `10-subtitle-track.js` | 字幕轨道记录器 |
| `12-longline.js` | 长句排版：调整 Linglass 字幕行宽度，按日文禁则换行 |
| `15-ja-break.js` | 句内断句 |
| `16-imported-subtitle.js` | 导入译文覆盖页面译文行 |
| `30-desktop-subtitles.js` | 桌面字幕浮窗 |
| `35-cast.js` | 手机字幕屏发送端，包含控制栏按钮与推送 |
| `35-cast.sw.js` | Service Worker 转发，仅注册为 Service Worker，不作为内容脚本注入 |
| `40-study-panel.js` | 学习面板 |
| `50-settings-panel.js` | 集成至 Linglass 设置面板 |

资源占用由三条约束控制：所有模块共用 `00-shared.js` 中的同一个 1 秒定时器；每帧 rAF 循环不访问 Shadow DOM，结果由 MutationObserver 缓存；本地存储有上限，每个视频最多 5000 句，最多保留 30 个视频、30 天。

### 测试

`make test` 使用 `node --test`，不依赖第三方库：

- 契约测试：验证对 Linglass DOM 与 YouTube 平台的依赖仍然成立，新增依赖必须登记。
- 冒烟测试：在 `node:vm` 沙箱中运行 `src/mod/*.js`。
- 工具链测试：断句切点、zip 往返、安装脚本与打包结构。

浏览器内的视觉与交互无法由 Node 测试覆盖，需要人工确认；`make probe` 可执行部分自动化检查。

## 已知限制

- 仅支持 YouTube，且需要登录。
- 字幕句子与时间戳来自 Linglass 缓存的原文轨，译文只在实际播放后才有。
- 振假名仅在浮窗中随 Linglass 显示，面板与导出文件不包含注音。
- 浮窗高度根据内容确定，字号变化后不会自动重算窗口大小，需手动拖动。
- 无法获取词级时间戳，词内进度为线性插值近似。
- 手机字幕屏需在 Mac 上运行 `make cast`，仅传输字幕，不传输画面与声音；Mac 页面关闭后停止推送。
- 手机端播放控制与上滑选句跳转由 Mac 标签页中的扩展执行，该页面需保持打开。
- 手机字幕屏使用局域网 HTTP，没有鉴权，同一 Wi-Fi 下知道地址的用户均可访问。
- 安装需要 Node.js 18 或更高版本，扩展运行时不依赖 Node。
- Linglass 发布新版本后不会自动同步，需重新执行安装流程。

## 贡献

贡献流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，开发规范见 [`AGENTS.md`](AGENTS.md)。

- 一个需求对应一份 PLAN，PLAN 声明修改范围；`vendor/` 与 `dist/` 只读。
- 需求与设计记录存放于 [`docs/plans/`](docs/plans)。
- 修改 `src/mod/**` 时需运行 `make build`、`make test` 与 `make check`。
- 仓库不引入第三方依赖。
