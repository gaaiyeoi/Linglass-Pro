# 071 手机字幕屏：静态 / 动态拆帧，去掉每帧全量序列化

> 状态：待执行

## 需求

手机屏常开时，YouTube 页面的主线程每 250ms 要把整份快照序列化两次（含 40 句历史
字幕的 `cues`、当前句的 `segments`、样式）。期望稳态下每帧只传「播放头」，内容块
只在真的变化时传一次，并且每帧只序列化一次。

## 根因

```265:267:src/mod/35-cast.js
      cues: cueWindow(current),
      // 换句排程的时间表（PLAN 069）：当前句与未来两句，手机端据此在本地时钟上起跑
      plan: upcomingCues(current),
```

```496:497:src/mod/35-cast.js
    const body = JSON.stringify({ ...payload, seq: (seq += 1), ack: lastCid });
    const dedupeKey = JSON.stringify({ ...payload, seq: undefined });
```

- `cues`（40 句）、`plan`（3 句）、`cur.segments`、`style` 都是**低频变化**的内容，
  却跟着 4Hz 的播放头一起重传；
- 两次 `JSON.stringify` 都在 `frameKey()` 之后、发送去重之前执行，暂停时也照跑；
- 服务端只保留最后一条快照，新接入的手机靠它拿历史句 —— 拆帧后必须保证新接入
  仍能拿到完整帧。

## 做什么

### 协议（向后兼容，`v` 仍为 1）

帧分成两块：

```jsonc
// 动态块（每帧）
{ "v":1, "seq":…, "sentAt":…, "playing":…, "stalled":…, "rate":…,
  "timeline":{…}, "cue":{…}, "progress":…, "trackVer":"a1b2c3d4" }

// 静态块（只在变化时出现，`static` 字段）
{ "static": { "cur":{…}, "prev":…, "next":…, "cues":[…], "plan":[…], "style":{…} } }
```

- `trackVer` 是静态块内容的 FNV-1a 32 位哈希（十六进制）。
- 手机端缓存 `{ ver, block }`；收到带 `static` 的帧就替换，其余帧按 `trackVer` 取缓存。
- 旧手机页面（不认识 `static`）会一直读到缺失字段 —— 所以 **带上 `static` 的帧里同时
  保留旧的顶层字段**（`cur/prev/next/cues/plan/style`），保证旧页面行为不变。

### 扩展侧

- `staticKey()`：把静态块的字段拼成字符串（复用 `frameKey()` 的既有口径）。
- `staticVer` 只在内容变化时重算哈希。
- 发送时：`body` 只序列化一次；动态块 + （变化时）`static` + 旧顶层字段。
- 删除 `dedupeKey` 的第二次序列化：去重交给 `frameKey()`，`lastBody` 只做「同字符串
  不发」的兜底。

### 服务端

- 房间多存一份 `room.static`（最近一次完整静态块 + 版本）。
- 新客户端接入时先收到 `{...room.snapshot, static: room.static}`，保证首帧可用。

### 手机端

- `applyStatic(block)`：把 `cur/prev/next/cues/plan/style` 落到 `payload` 上再走原渲染。
- 帧里没有 `static` 且 `trackVer` 与缓存一致 → 直接用缓存；
  `trackVer` 不认识且没有 `static` → 用上一帧的静态块（不丢字）。

## 不做什么

- 不改渲染、换句排程、选句、控件。
- 不改 `/push` 的请求方法、路径、CORS。
- 不做 gzip（Node 内置 zlib 会引入分块传输的额外复杂度，本次不做）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/35-cast.js
  - tools/cast-server.mjs
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/071-cast-static-dynamic-split.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
```

## 实现方案

1. 扩展：`buildStatic()` 产块 → `ver = fnv1a(JSON.stringify(block))`；
   `pendingStatic = ver !== lastSentVer`。
2. 扩展：`push()` 里只对最终 `body` 做一次 `JSON.stringify`；`lastBody` 与 `frameKey`
   继续做两级去重（`lastBody` 现在比较完整 body，`seq` 已去掉）。
3. 服务端：`handlePush` 保存 `room.static`；`handleStream` 首帧合并。
4. 手机：`render()` 开头 `mergeFrame(payload)`，其余逻辑不动。
5. 测试：静态断言（`trackVer`、`static` 字段、无第二次 `JSON.stringify`）+
   一条纯函数冒烟（FNV 哈希稳定）。

## 验证方式

- [ ] `make test` / `make build` / `make check`。
- [ ] CDP：连续 6 秒推流，统计带 `static` 的帧占比 < 30%（句长约 3 秒时约 1/12）。
- [ ] CDP：新开一个页面（模拟新手机接入），首帧即能显示字幕（服务端合并逻辑生效）。

## 预期量级

5 个文件，+150 / −40 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：未提交
- 验证结果：
  - `make test` 通过（新增 2 条：静态字段清单/缓存补齐、扩展侧单次序列化）。
  - `make build` / `make check` 通过。
  - CDP 综合探针：98 帧里只有 11 帧带 `static`（11%，句长 2 秒时的预期值附近），
    其余 87 帧是纯播放头，手机端靠缓存补齐后字幕正常滚动。
- 遗留问题与差异：
  - 帧里不再重复携带顶层 `cur/prev/next/...`：手机页面与服务端是同一份代码、同一次
    `no-store` 下发的，不存在「新服务端 + 旧页面」的混用；如果有人在浏览器里缓存了旧页面，
    最坏表现为没有字幕（刷新即恢复）。这一点与原计划的「保留旧字段」不同，是有意的取舍。
  - **新客户端接入时服务端补齐静态块**这条路径只做了代码实现，没有在真实
    `cast-server` + 两个页面下验证（探针直接连自造服务端）。
  - `static` 的重建靠 `frameKey()` 变化触发；`frameKey()` 未覆盖的字段（例如 `cues`
    里历史句的文本本身）不会触发重建。现有字段口径下这是安全的（`cues` 只在换句时变）。
