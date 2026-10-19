# 046 评审修复批次：AI 翻译健壮性、高频路径性能、中转站安全

> 状态：**待人工确认**（代码与门禁已完成；浏览器内行为见「完成情况」第 1 条）

## 需求

对当前工作区（AI 翻译 / 手机字幕屏 / PiP 进度条三个新功能）做一次第三方代码评审后，
按评审结论一次性修掉 16 项问题。用户明确要求「一个 PLAN、1-16 全部改」，
所以本文是**一个批次**而不是五个独立需求；每一项都标了来源编号，回写时逐条对账。

评审来源：2026-10-19 的 code review 会话。编号与本 PLAN 的「做什么」一一对应。

## 做什么

### 阻断级

1. **`readErrorText` 二次读 body**：先 `res.json()` 再 `res.text()`，后者必然抛
   "body used already"，非 JSON 错误（502 / 限流页 / 代理 HTML）拿不到原因。
   改为先 `text()`，再尝试 `JSON.parse`。
2. **AI 请求没有超时**：只有用户手动 abort，模型挂住时 `aiRunning` 永久为 true、
   按钮永久 disabled。引入 120s 超时（`AbortSignal.timeout`，与用户 abort 用
   `AbortSignal.any` 组合，不支持时退回其一），并把 `TimeoutError` 翻成人话。
3. **PiP 三条进度条每帧写 `style.width`**：`width` 走 layout，60fps 持续触发布局。
   - `#fill-primary` / `#fill-secondary`（纯色块，无伪元素）→ `transform: scaleX()`
     + `transform-origin: left`，与 `tools/cast-page.mjs` 已有做法一致。
   - `#progress-fill` **保留 width**：它的 `::after` 是进度圆点，`scaleX` 会把圆点
     拉成椭圆。改为把比例量化到 0.25%（长视频上写入次数降一个数量级）。
4. **AI 翻译每批全量 `renderAll()`**：1000 句 × 50 批 ≈ 5 万次节点重建，同步卡顿。
   改为按 `start` 索引只更新受影响的行（`updateRow`，不重建节点，兼容测试桩）。

### 性能

5. **`castLines()` 无缓存**：手机屏常开时由 250ms rAF、1s 心跳、`track.subscribe`
   三个源驱动，约 5~6 次/秒重复做 `richTokens`（4 次 querySelector）+ 分词 +
   `richSegments`。按「当前句 index + 原文 + 译文 + 双语开关」做单槽 memo。
6. **`snapshot()` 在去重之前完整构建**：先算廉价 `frameKey()`（只碰内存对象 +
   `readLines()`），命中就跳过 snapshot 与两次整帧 `JSON.stringify`。
   保留原有的完整 `lastBody` 比对作为兜底。
7. **`35-cast` 的 `rafId` 失配**：`loop()` 在 `enabled` 变 false 时直接 return 却
   不归零 `rafId`，经 `setConfig({enabled:true})` 后 `start()` 被 `if (rafId) return`
   挡掉，开关显示「开」但永不推送。退出时归零。
8. **`keepalive: true` 用在 250ms 的请求上**：Chrome 对 keepalive 请求体有全局配额，
   且 keepalive 请求会忽略 abort（4s 超时失效）。去掉。
9. **`send()` 与文件头注释相反**：注释论证「从内容脚本直发、少一层转发」，
   实现却是 SW 优先。改为**直连优先、失败回 SW**，并同步注释。
10. **SSE 广播没有背压**：忽略 `res.write()` 返回值，慢客户端会让 Node 写缓冲增长。
    用 `drain` 事件标记慢客户端并跳过后续帧。
11. **手机端每帧无条件写 DOM**：`setStatus` 的 `textContent` 与 `document.title`
    改为先比对再写（`renderCtx` 已经是这个口径）。

### 安全 / 可行性

12. **中转站主动关掉 PNA 保护**：`allow-origin: *` + `allow-private-network: true`
    让任意公网页面都能 POST `/push` / `/control`。改为**回显 Origin + 白名单**：
    扩展源、YouTube 系、本机/私有网段/`.local`（手机页面自己）放行，其余 403。
    白名单判断抽成 `cast-control.mjs` 的纯函数 `isAllowedOrigin()`，便于单测。
13. **`rooms` Map 无上限**：任意 `?room=` 都能创建条目且永不删除。加 32 个房间
    的 LRU 上限（只淘汰无客户端的房间），并记录 `lastSeen`。
14. **`host_permissions` 无条件申请本机访问**：不用手机屏的用户也要授权
    「读取 127.0.0.1」。改为 `optional_host_permissions`，在用户打开开关时
    （用户手势内）`chrome.permissions.request`；未授权时直连那条路仍然可用。
15. **`skipExisting` 默认 false**：第二次点「AI 翻译」会把已有译文（含手工导入的
    SRT）整片重翻并覆盖，直接烧额度。默认改为 true（只翻缺失）。
16. **API Key 的边界没有提示**：明文存 `chrome.storage.local`，`baseUrl` 可填任意
    地址。接口不是 `https` 且不是本机时，在状态行明确提示「Key 会明文过网」。

### 附带的一致性修复（同属第 5 条的性能路径）

- `12-longline.js` 心跳里每秒 `querySelector('#id')`：用模块级 `injectedRoot`
  做短路，宿主重建时才重新查。

## 不做什么

- **不改** `40-study-panel.js` 面板自己的句内进度条（`:992-996` 仍在写 `width`）。
  它与 PiP 的 `.kfill` 分属两个 shadowRoot，改动互不影响；不在本次 16 项内，
  登记为已知遗留（面板窗口不是每帧可见，优先级低）。
- **不改** `resolveAssignments` 的 `O(items × cues)`、`buildWholeMessages` 的
  重复序列化、AI 翻译的串行并发 —— 这三条属于评审的「建议级」，不在 1-16。
- **不改** `10-subtitle-track.js`、`00-shared.js`、`50-settings-panel.js`、
  `15-ja-break.js` 的任何行为。
- **不引入依赖**、不改 `globalThis.__llgMod*` 既有成员的签名（只新增内部函数）。
- **不做**中转站的 token 鉴权（第 12 条按「Origin 白名单」这一支实现）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/06-ai-translate.js
  - src/mod/12-longline.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/35-cast.js
  - src/mod/40-study-panel.js
  - build.mjs
  - tools/cast-control.mjs
  - tools/cast-server.mjs
  - tools/cast-page.mjs
  - tools/test/ai-translate.test.mjs
  - tools/test/cast-control.test.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/046-review-fixes-ai-cast-pip.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/00-shared.js
  - src/mod/15-ja-break.js
  - src/mod/50-settings-panel.js
  - package.json
```

## 实现方案

1. `40-study-panel.js`：`readErrorText` 重写；新增 `abortSignal()` 与
   `AI_REQUEST_TIMEOUT_MS`；`describeFetchError` 识别 `TimeoutError`；
   新增 `rowByStart` Map + `updateRow()`，`refreshRowsPreservingScroll()`
   换成 `refreshRowsFor(starts)`；新增 `endpointWarning()` 并在配置回填/防抖保存时
   更新状态行（仅 `!aiRunning`）。
2. `06-ai-translate.js`：`DEFAULT_CONFIG.skipExisting = true`；
   `normalizeConfig` 对非布尔值退回 `DEFAULT_CONFIG`。
3. `30-desktop-subtitles.js`：PiP CSS 的 `.kfill` 改 `width:100%` + `scaleX(0)`
   + `transform-origin`；`pushProgress` 写 `transform`；`pushTimeline` 量化 0.25%；
   `castLines` 加单槽 memo。
4. `35-cast.js`：`loop()` 退出归零 `rafId`；去掉 `keepalive`；`send()` 改直连优先；
   新增 `frameKey()` 并在 `push()` 里前置；新增 `requestCastPermission()`，
   由 `toggle()` 在「即将开启」时调用。
5. `build.mjs`：`CAST_ORIGIN` 从 `host_permissions` 挪到
   `optional_host_permissions`（并确保数组存在）。
6. `cast-control.mjs`：新增导出 `isAllowedOrigin(origin)`（纯函数）。
7. `cast-server.mjs`：`cors()` 收 `req`、按白名单回显 Origin 并返回是否放行；
   OPTIONS / 非白名单 403；`sendEvent` 加背压标记；`roomOf` 加 LRU。
8. `cast-page.mjs`：`setStatus` 与 `document.title` 先比对。
9. `12-longline.js`：`injectedRoot` 短路。

## 验证方式

- [ ] `make test`（新增/修改的用例见下）
- [ ] `make build` + `make check`（注入顺序、SW 泄漏、可选权限字段）
- [ ] 中转站手工验证：允许的 Origin 回显、公网 Origin 403、`/stream` 与 `/prefs` 仍可用
- [ ] 浏览器内人工确认（Node 测不了）：
      PiP 两条蓝底进度随播放平滑推进、hover 时进度圆点仍是圆的；
      手机屏播放/暂停/跳转仍生效；AI 翻译超时后按钮恢复可点

新增/修改的测试用例：

- `ai-translate.test.mjs`：`normalizeConfig(null).skipExisting === true`；
  显式 `false` 仍为 `false`（**这是有意修改旧断言**：旧用例把「默认 false」
  钉死了，本次改默认值是需求本身，理由见「做什么」第 15 条）。
- `cast-control.test.mjs`：`isAllowedOrigin` 的放行/拒绝矩阵
  （YouTube、chrome-extension、192.168/10/172.16、`.local` 放行；
  公网域名、`null`、非法 URL 拒绝；无 Origin 放行）。
- `smoke.test.mjs`：
  - `h.pipFill()` 改读 `style.transform`，断言 `scaleX(0)` / `scaleX(0.5)`
    （**有意修改旧断言**：DOM 表现从 width 换成 transform，语义不变）；
  - 新增：`castLines()` 连续两次调用只触发一次分词（用 `jaSegment.cut` 计数）；
  - 新增：`12-longline` 心跳多次触发只注入一张样式表（现有用例已覆盖，补一次
    宿主重建后重新注入的断言）。

## 预期量级

9 个源文件 + 3 个测试 + 本 PLAN / 约 +420 −180 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区改动）。本仓库历史是「一个 PLAN 一个提交」，
  但工作区里已经堆着 PLAN 032–045 的一大批未提交改动，无法把本批次单独切出来
  而不产生依赖断裂（045 的 `12-longline.js` 是本次第 5 条的同一条热路径）。
  提交时应把 032–045 与本 PLAN 一起提交，或在提交说明里写清「一次独立评审修复」。
- 验证结果（实际输出）：
  - `make test` → `# tests 189 / # pass 189 / # fail 0`
  - `make build` → 注入自检通过、`SW 挂载 service-worker-loader.js += mod/35-cast.sw.js`
  - `make check` → 11 个 mod 脚本全部正确注入
  - `dist/manifest.json` → `optional_host_permissions: ["http://127.0.0.1/*"]`，
    `host_permissions` 里已无 127.0.0.1
  - 中转站实测（`PORT=18899`）：
    - `Origin: https://www.youtube.com` → 200，且响应头回显该 Origin
    - `Origin: https://evil.example.com` → 403；其 `OPTIONS /push` → 403
    - `Origin: http://192.168.1.9:18899` → 200
    - `POST /push` 返回 `{"ok":true,...}`；`POST /prefs` 正常归一；`GET /?room=t` → 200
  - 新增用例：
    - `手机字幕屏：同一句重复取快照不重复分词`
    - `Origin 白名单：浏览器真实来源放行，公网站点拒绝`
    - `长句排版：…且幂等` 追加「换 shadowRoot 后重新注入」
- 遗留 / 与预期不符之处：
  1. **第 6/7/8/9 条（`frameKey`、`rafId`、`keepalive`、`send` 顺序）没有 Node 覆盖**。
     它们都住在 `35-cast.js` 的运行时里，要测就得重新搭一套 `chrome` + `track` +
     PiP 的桩，容易得到「看起来绿」的假保证。已人工读改后代码确认，但属
     **未验证**，需要在浏览器里跑一次手机屏（开 → 关 → 再开，确认仍在推送）。
  2. 第 3 条里 `#progress-fill` 仍写 `width`（改为量化 0.25%），因为它的 `::after`
     是进度圆点，`scaleX` 会把圆点拉成椭圆。如果你更在意那点布局开销，正确做法是
     把圆点拆成独立元素，那是一次 DOM 结构调整、不在本批次里。
  3. 第 14 条改成 optional 权限后，**旧用户升级时** 127.0.0.1 权限会被收回：
     直连仍然可用（第 9 条已改成直连优先），SW 兜底要等用户重新点一次开关。
  4. 面板自己的句内进度条（`40-study-panel.js:992-996`）仍在每帧写 `width`，
     见「不做什么」；它与 PiP 的 `.kfill` 不共享样式表，不影响本次改动。
  5. PLAN 预期「9 个源文件 + 3 个测试 / +420 −180」：实际触及 6 个源文件
     （`06`/`12`/`30`/`35`/`40`/`build.mjs`）+ 3 个工具 + 3 个测试，
     改动量约 +470 −60（源）+120（测试）。多出来的是注释（每条都写了「为什么」），
     没有额外的行为改动。
