# 023 一键安装包（非技术用户可装）

> 状态：**已完成**

## 需求

现在装这个扩展要求用户会开终端、会跑 `make`、懂「加载已解压的扩展程序」是什么。
目标：**把安装变成「下载 → 双击 → 照着图文点四下」**，覆盖 macOS 与 Windows。

同时修掉两个顺手就能碰到的毛病：

- `make open` 写死了 Arc（`Makefile:47`），用 Chrome 的人点了没反应。
- `make vendor-update` 依赖系统 `unzip`，Windows 上根本没有这个命令。

## 做什么

1. **`tools/zip.mjs`**：零依赖的 zip 读 + 写（Node 内置 `zlib.inflateRawSync` / `deflateRawSync`
   + 手写 header 与 CRC32）。读用于解 CRX，写用于打发布包。
   - 读：EOCD → 中央目录 → local header，逐条解压；`method 0` 直拷、`method 8` 走 inflate。
   - 权限位：从中央目录的 external attributes 恢复 Unix mode，决定文件是否可执行。
   - 边界：拒绝 `..` 与绝对路径（zip slip）；遇到 zip64 明确报错，不静默解错。
2. **`tools/import-vendor.mjs`**：把 `unzip` 子进程换成 `tools/zip.mjs`，macOS 不再依赖
   系统 `unzip`，Windows 也能跑。CLI 形态与日志口径不变。
3. **`tools/install.mjs`**：跨平台安装器（供 `.command` / `.bat` 调用）：
   - 检查 Node ≥ 18，不满足就用中文提示引导去 nodejs.org 并**停下**（装完再双击一次）；
   - 校验自己确实在发布包根目录（有 `build.mjs` 与 `src/mod/`），否则报错退出；
   - 依次 spawn `tools/import-vendor.mjs --download` 与 `build.mjs`，日志原样透出；
   - 打开浏览器扩展管理页，并在文件管理器里高亮 `dist/`；
   - 打开 `docs/install-guide.html` 图文向导，终端里同步打印四步。
4. **`install-macos.command`**：Finder 双击入口。检测 `node`，缺失则 `open` nodejs.org 后退出；
   否则 `cd` 到脚本所在目录并跑 `install.mjs`，结束后保留窗口（`read`）以免用户看不到输出。
   > 文件名用 ASCII —— 中文名在 Windows 解压 zip 时会乱码。
5. **`install-windows.bat`**：同上，用 `where node` 检测、`start` 打开网址。
   **文件内容全 ASCII**（cmd 对编码敏感），中文提示交给 `install.mjs` 打印。
6. **`tools/package.mjs`** + `make package`：产出
   `release/Linglass-Pro-<版本>-安装包.zip`，只装我们自己的东西：
   `install-macos.command`、`install-windows.bat`、`build.mjs`、`src/mod/**`、
   `tools/{zip,import-vendor,install}.mjs`、`docs/install-guide.html`。
   版本号从 `dist/manifest.json` 读（所以 `make package` 依赖 `make build`）。
7. **`docs/install-guide.html`**：自包含（内联 CSS + 手写 SVG 示意图、零外链）的图文向导，
   面向非技术用户。必须写清：开发者模式开关在哪、选哪个文件夹、装完怎么验证、
   以及三个坑（Gatekeeper 右键打开 / 需要 Node / 官方发版后要重装一次）。
8. **`Makefile`**：`open` 目标改成按 Chrome → Arc → Edge → Brave → Chromium 顺序探测已装的
   浏览器；新增 `package` 目标（依赖 `build`）。
9. **`README.md`**：把「面向非技术用户的安装」提到显眼位置，环境要求里删掉 `unzip` 依赖，
   补 `make package`。

## 不做什么

- **不动 `src/mod/**` 一个字符** —— 本轮与扩展运行时行为完全无关。
- **不做「免 Node」**。彻底免 Node 要么重写整套构建，要么让安装器自己下载便携版 Node
  （~40MB/平台，Windows 侧还得先解决「没有解压器」的鸡生蛋）。本轮**不做**，只在向导里
  把 Node 那一步写清楚。这是一次明确的取舍，不是遗漏。
- **不做上架 Chrome 商店**，**不做扩展自动更新**（官方发版后仍需重新双击一次）。
- 不把 `dist/` 打包分发。发布包里永远不含官方代码 —— vendor 由**用户本机**自己从商店拉。
- 不引入任何第三方依赖（zip 读写全部手写，只用 Node 内置 `zlib`）。
- 不改 `tools/dev.mjs`、`tools/probe.mjs`、既有的三个测试文件。
- 不做 `make package` 的签名/公证（需要 Apple 开发者账号，本轮不谈）。

## 修改范围

```yaml
allowed_paths:
  - docs/plans/023-one-click-installer.md
  - .gitignore
  - tools/zip.mjs
  - tools/install.mjs
  - tools/package.mjs
  - tools/import-vendor.mjs
  - tools/test/zip.test.mjs
  - tools/test/install.test.mjs
  - install-macos.command
  - install-windows.bat
  - docs/install-guide.html
  - Makefile
  - README.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/**
  - build.mjs
  - tools/dev.mjs
  - tools/probe.mjs
  - tools/test/contract.test.mjs
  - tools/test/smoke.test.mjs
  - tools/test/ja-segment.test.mjs
  - AGENTS.md
```

新增 `install-macos.command` 与 `install-windows.bat` 是**新增文件**，故必须写进本 PLAN（§2）。

执行中发现原清单漏了两项，已补进上面的 `allowed_paths`（明细见「完成情况 → 范围微调」）：
`.gitignore` 要加一行 `release/`；以及 §3 要求「新增业务逻辑必须有冒烟测试」，
于是多出一个 `tools/test/install.test.mjs`（浏览器候选表可测，单独一个文件比塞进
`zip.test.mjs` 更不混淆职责）。

## 实现方案

### zip 读（`tools/zip.mjs`）

```text
EOCD（从尾部往前扫 0x06054b50） → 取中央目录偏移与条目数
  对每条中央目录项 0x02014b50：
    文件名 / method / 压缩与原始大小 / local header 偏移 / external attrs
  跳到 local header 0x04034b50，跳过文件名与 extra 得到数据起点
    method 0 → 原样拷贝；method 8 → zlib.inflateRawSync
    原始大小不符 → 抛错（宁可失败也不要写出半个文件）
```

写则是反向：`local header + 数据 + 中央目录 + EOCD`，CRC32 用查表法算
（Node 的 `zlib` 不导出 crc32）。

### 安装器骨架

`install-macos.command` 是薄壳，真正的逻辑全在 `install.mjs`（这样 Windows 侧不用重复实现）：

```bash
#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "还没有安装 Node.js（装扩展必须先装它）……"
  open "https://nodejs.org/zh-cn"
  read -n 1 -s -r -p "装完后关掉这个窗口，再双击一次本文件。按任意键退出。"
  exit 1
fi
node tools/install.mjs
```

### 打包清单

`package.mjs` 里一张数组列清楚要收哪些路径（白名单，不是黑名单 —— 漏一个大不了重打，
多收一个可能就把官方代码泄出去）。

## 验证方式

- [ ] `make test`（新增 `tools/test/zip.test.mjs`：stored/deflate 条目往返、权限位恢复、
      目录条目、zip slip 被拒、zip64 报错、CRC32 已知向量）
- [ ] `make build` + `make check`（确认没碰 src/ 也没影响产物）
- [ ] `make vendor-update` 用新手写 zip 重跑一遍，版本与内容与改造前一致
- [ ] `make package` 产出 zip，**手工 `unzip -l` 核对清单里没有 vendor/ 与 dist/**
- [ ] 把打出来的包解到一个干净目录，按向导走一遍（macOS 实机）
- [ ] Windows 路径**无法在本机验证**，如实登记为未验证
- [ ] 浏览器内行为（扩展加载成功、字幕正常）沿用既有验收方式

## 预期量级

11 个文件（新增 7 / 修改 4），约 +900 −90 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**本轮未提交**（等用户确认后再提交；提交信息建议见下）。

  ```text
  一键安装包：下载 → 双击 → 按图点四下

  - macOS / Windows 各一个双击入口，真正的逻辑都在 tools/install.mjs，
    两个平台共用一份，避免两套实现走偏。
  - 解 CRX 不再依赖系统 unzip：tools/zip.mjs 手写 zip 读写（只用内置 zlib），
    所以 macOS 不用要求命令行工具、Windows 也能跑；打包复用同一份写实现。
  - 合规红线写进代码：make package 只收白名单文件，打完读回来自检，
    混进 vendor/ 或 dist/ 直接失败 —— 官方基线一律由用户本机安装时自己拉。
  - 顺手修掉 make open 只认 Arc：改成按 Chrome → Arc → Edge → Brave 探测。
  - 补 14 条测试：zip 往返/权限位/zip slip/zip64/CRC 向量 + 安装器浏览器候选表。
  ```

- 验证结果（实际输出，节选）：

  ```text
  $ node tools/import-vendor.mjs --download --force     # 新手写 zip 解真实 CRX
  [vendor] 下载完成  0.85 MB
  [vendor] 解开  归档
  [vendor] 写入  vendor/linglass-1.12.3   __MSG_extensionName__ v1.12.3

  $ make build && make check && make test
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-CtntZOE3.js
  [build] 注入      mod/00-shared.js → … → mod/50-settings-panel.js
  [build] 版本      1.12.900
  版本    1.12.900
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ℹ tests 99   ℹ pass 99   ℹ fail 0          # 原 85 + zip 9 + 安装器 5

  $ make package
  [package] 版本      1.12.900
  [package] 内容      16 个文件（官方代码 0 个）
  [package] 产物      release/Linglass-Pro-1.12.900-installer.zip  94.4 KB

  $ unzip -l release/Linglass-Pro-1.12.900-installer.zip
  （16 项：install-macos.command / install-windows.bat / build.mjs /
    src/mod/*.js 7 个 / tools/{zip,import-vendor,install}.mjs / docs/install-guide.html）
  无 vendor/ 与 dist/ —— 合规自检通过。

  $ # 端到端：解压到干净目录后独立跑通
  $ unzip -q release/*.zip -d /tmp/llg-release-test
  -rwxr-xr-x install-macos.command      # 可执行位没丢（双击靠它）
  -rw-r--r-- install-windows.bat
  $ cd /tmp/llg-release-test && node tools/import-vendor.mjs --download && node build.mjs
  [vendor] 写入  vendor/linglass-1.12.4
  [build] 版本      1.12.900
  ```

- 范围微调（两处，均为执行中发现的清单不全，已回写进上面的 `allowed_paths`）：
  1. `.gitignore` 加一行 `release/`（`make package` 的产物不能进版本控制）。
  2. 新增 `tools/test/install.test.mjs` —— §3 要求新增业务逻辑必须有冒烟测试，
     而安装器的「候选浏览器表」正好是可测的纯数据（路径/顺序写错的表现是
     「双击后什么都不弹」，不会报错，所以值得锁住）。

- 遗留 / 与预期不符之处：
  1. **Windows 路径未实机验证**：`install-windows.bat` 与 Windows 候选浏览器表
     只做了静态审查 + 单测（断言反斜杠路径、覆盖 LOCALAPPDATA 用户级安装、缺环境变量
     时退回默认值），**没有在 Windows 上真跑过**。`tools/install.mjs` 里
     `explorer` / `cmd /c start` / `chcp 65001` 这几点尤其需要一台真机确认。
  2. **安装器最后一段（打开浏览器 / Finder / 向导）没有实机跑过**：
     跑到那里会真的弹出浏览器窗口，所以本轮只手工跑了解压 → 下载 → 构建三段，
     加断言式检查（可执行位、清单、合规）。真正双击一次需要用户来点。
  3. **商店已经发到 1.12.4**：做端到端验证时 `import-vendor --download` 拿到的是
     `linglass-1.12.4`（其中契约校验仍然通过，说明官方这套 Shadow DOM 契约没变）。
     本仓库本地基线仍是 `vendor/linglass-1.12.3` —— **本轮没有升级基线**，
     那属于另一件事（换 `vendor/` 会影响既有产物），按 §1 需要另立 PLAN。
  4. **macOS Gatekeeper 与「解压丢可执行位」只在向导里写了兜底文案，未实测**：
     两种失败形态都没在有隔离属性的真机上复现过。
  5. **没有代码签名 / 公证**：所以 macOS 首次要右键打开、Windows 会弹 SmartScreen，
     这是当前取舍（签名要 Apple 开发者账号，见「不做什么」）。
  6. `make` 目标本身只在 macOS 上验证过；Windows 用户走的是 `.bat` + `node`，
     不经过 Makefile。
  7. **实际量级比预估大**：预估是「11 个文件 / +900 −90」，实际 13 个文件 / 新增约 1670 行。
     多出来主要是本 PLAN 自己的留档（229 行）与向导 HTML（305 行），以及
     `zip` / `install` / `package` 三个脚本各比预估多了几十行。差 1.8 倍属于预估偏粗，
     不是范围失控（清单里没有预期外的文件）。
