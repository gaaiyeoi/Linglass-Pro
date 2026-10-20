# 074 手机字幕屏：命令走独立下行通道（扩展持 SSE）

> 状态：待执行

## 需求

手机上点播放 / 暂停 / ±5 秒 / 选句跳转，最长要等 1 秒才生效。期望按下即达（局域网
内 5–30ms）。

## 根因

手机命令只能**搭扩展下一次 `/push` 的响应**回程：

```49:52:src/mod/35-cast.js
   * 手机发来的命令是搭 `/push` 的**响应**回来的：暂停时内容不变，若一直去重不发，
   * 手机上点「播放」就永远送不到 —— 所以这里保留一拍最多 1s 的空推送当反向通道。
   */
  const CONTROL_POLL_MS = 1000;
```

```237:242:tools/cast-server.mjs
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    seq: next.seq,
    clients: room.clients.size,
    controls: room.pending,
  }));
```

播放中命令最多等 250ms（推送节拍），暂停时最多等 1 秒。这不是按钮或网络的问题，
而是**没有下行推送通道**。

## 做什么

### 服务端（`tools/cast-server.mjs`）

- 新增 `GET /commands?room=`（SSE）：扩展订阅。
- `handleControl()` 入队后**立刻**把这条命令广播给 `/commands` 订阅者
  （保留 `pending` 队列与 ack 语义作为可靠性兜底：丢包时扩展仍能从下一次 `/push` 拿到）。
- 命令流同样设 `retry: 1000`、15s 心跳、背压保护；`/commands` 加入 CORS 白名单校验
  （沿用 `cors()`，YouTube 来源已放行）。

### 扩展（`src/mod/35-cast.js`）

- `start()` 时建立 `EventSource(endpoint + '/commands?room=…')`，`stop()` 时关闭。
- 收到消息 → `applyControls([cmd])`（`cid` 去重逻辑已有，重复下发不会执行两次）。
- 连不上（服务端没起 / 被策略拦）时静默重试由 `EventSource` 自己做；
  期间仍保留 `/push` 响应里的旧回程，功能不降级。
- 断线重连后不补发历史命令（`cid` 单调，旧命令已被 ack 或过期）。

## 不做什么

- 不换成 WebSocket（SSE 已够用，服务端与手机端都在用同一套写法，零依赖）。
- 不改手机端的 `sendControl()`（仍 POST `/control`）。
- 不改命令白名单 / 消毒逻辑（`cast-control.mjs` 不动）。
- 不做鉴权（与现状同一取舍，README 已写明）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/35-cast.js
  - tools/cast-server.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/074-cast-command-stream.md

forbidden_paths:
  - vendor/**
  - dist/**
  - tools/cast-control.mjs
  - tools/cast-page.mjs
```

## 实现方案

1. 服务端房间增加 `cmdClients: Set`；`/commands` 与 `/stream` 同一套 SSE 写法。
2. `handleControl` 在 `enqueueControl` 之后 `broadcastCmd(room, queued)`。
3. 扩展：`commandStream()` 惰性创建，`stop()` 关闭；`state.endpoint` 变化时重建。
4. 冒烟：断言 `35-cast.js` 里有 `/commands` 的 EventSource 与 `applyControls` 的复用。

## 验证方式

- [ ] `make test` / `make build` / `make check`。
- [ ] 本机起服务端，`curl -N /commands` 订阅后 `curl -XPOST /control`，
      断言命令在 <50ms 内到达（用 `Date.now()` 打印）。
- [ ] CDP：页面点暂停 → 断言 Mac 侧 `video.paused` 变化时间（探针里用桩模拟）。

## 预期量级

3 个文件，+90 / −10 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：未提交
- 验证结果：
  - `make test` 通过（新增 1 条扩展侧断言组：路由、EventSource、复用 `applyControls`、关闭）。
  - `make build` / `make check` 通过。
  - 集成实测（本机 `cast-server` + 一个 `GET /commands` 订阅者 + `POST /control`）：
    命令从 POST 到订阅端收到 **8ms**（旧路径暂停时最长 1000ms）。
- 遗留问题与差异：
  - 没有在真实扩展里验证（内容脚本的 `EventSource` 连本机、CORS 走白名单）；
    「扩展在 YouTube 页面上能否建立该长连」仍需 `make dev` 手工确认一次。
  - 命令流只下发、不做逐条 ack：可靠性仍由 `pending` 队列 + 下一次 `/push` 回程兜底，
    与计划的「保留队列」一致。
  - 同一条命令会从两条通道各到一次，靠既有 `cid` 去重，不会执行两次。
