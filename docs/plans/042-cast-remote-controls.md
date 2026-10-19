# 042 手机字幕屏：在手机上控制播放（暂停 / 倍速 / ±5 秒）

> 状态：**待执行**

## 需求

手机当第二块屏幕看字幕时，还得回头用鼠标点 Mac 上的播放器。希望在手机页上直接：

1. 播放 / 暂停；
2. 快退 / 快进 5 秒；
3. 切换倍速（0.75 / 1 / 1.25 / 1.5 / 2）。

## 现状与约束

页面顶部注释里原本写着「没有播放控制栏（手机上控制的是 Mac 的播放器，没有意义）」——
本轮推翻这个判断：手机就在手边，暂停/快进/倍速是看字幕时最高频的三个动作。

链路是现成的，只缺「反向」这一半：

```text
扩展 --POST /push(快照)--> cast-server --SSE--> 手机
手机 --POST /control(命令)--> cast-server --随 /push 的响应带回--> 扩展 --操作 video-->
```

为什么把命令**搭在 `/push` 的响应里**而不是让扩展再开一条 SSE / 轮询：

- 扩展本来每 250ms 就 POST 一次，反向通道零新增定时器；
- 不需要在内容脚本里维护长连接（MV3 里也没有这个必要）；
- 手机 → 服务端是普通 POST，延迟只取决于下一拍（≤250ms），足够。

可靠性口径：命令带 `cid`，扩展在**下一次** `/push` 的请求体里回 `ack`；
服务端只保留 `cid > ack` 的命令。扩展按 `cid` 去重（同一命令可能被响应重复带回），
所以「至少一次」不会变成「暂停两次」。

## 做什么

- `tools/cast-control.mjs`（新）：`sanitizeControl(raw)` 纯函数，
  只放行 `toggle / play / pause / skip / rate`，`skip` 夹到 ±60 秒，`rate` 夹到 0.25–2。
- `tools/cast-server.mjs`：
  - room 增加 `pending` 与 `cmdSeq`；
  - 新增 `POST /control?room=`：消毒后入队（上限 8 条，丢最旧的）；
  - `POST /push` 响应用 `ack` 清理已确认命令，并带回剩余 `controls`。
- `src/mod/35-cast.js`：
  - 快照增加 `rate`（手机回显当前倍速）；
  - 请求体带 `ack: lastCid`；响应解析 `controls` 并应用到 `video`；
  - 按 `cid` 去重；`play()` 被拒（自动播放策略）时静默忽略。
- `src/mod/35-cast.sw.js`：转发响应里多带一段 `text`（目前只截 200 字符，
  改为 4000）—— 命令列表要从这里回传。
- `tools/cast-page.mjs`：
  - 新增 `#controls`：`−5s` / 播放暂停 / `+5s` / 倍速；
  - 与齿轮同一套「点画面才浮出来、5 秒后自己收」的显隐逻辑；
  - 点按钮 → `POST /control`；播放图标与倍速按快照回显。
- 测试：
  - `tools/test/cast-control.test.mjs`：消毒规则（白名单 / 夹取 / 非法值）；
  - `tools/test/cast-page.test.mjs`：控制条四个按钮存在、倍速档位正确。

## 不做什么

- 不做进度条拖拽跳转（底部条在手机上只有 3px，误触率高；要做得另立 PLAN）。
- 不做音量 / 静音 / 字幕开关（字幕开关已经在设置面板里）。
- 不做鉴权（与现有 `/push` 同一口径：同一 Wi-Fi 可用；README 已有说明）。
- 不改桌面浮窗、学习面板与 `src/mod/` 其它文件。
- 不动 `vendor/`、`dist/`、`build.mjs`、`Makefile`。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-server.mjs
  - tools/cast-control.mjs
  - tools/cast-page.mjs
  - tools/test/cast-control.test.mjs
  - tools/test/cast-page.test.mjs
  - src/mod/35-cast.js
  - src/mod/35-cast.sw.js
  - docs/plans/042-cast-remote-controls.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/probe.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. 命令形状：`{ action: 'toggle'|'play'|'pause', value: null }`、
   `{ action: 'skip', value: -5 }`、`{ action: 'rate', value: 1.25 }`。
2. 服务端 `handleControl()`：JSON 解析 → `sanitizeControl()` → `cid = ++room.cmdSeq` →
   `room.pending.push({ cid, ...cmd })`（超过 8 条 shift）→ `{ ok: true, cid }`。
3. 服务端 `handlePush()`：
   ```js
   const ack = Number(payload.ack) || 0;
   room.pending = room.pending.filter((cmd) => cmd.cid > ack);
   ...
   res.end(JSON.stringify({ ok: true, seq, clients, controls: room.pending }));
   ```
4. 扩展 `push()`：`body` 里加 `ack: lastCid`；成功后
   `const reply = JSON.parse(res.text || '{}')` → `applyControls(reply.controls)`。
5. `applyControls()`：
   ```js
   if (cmd.cid <= lastCid) continue;
   switch (cmd.action) {
     case 'toggle': v.paused ? v.play().catch(() => {}) : v.pause(); break;
     ...
   }
   lastCid = cmd.cid;
   ```
6. 手机页：`#controls` 与 `#gear` 共享显隐（点画面 → `.show`，5s 后移除）；
   倍速按钮在 `[0.75, 1, 1.25, 1.5, 2]` 里循环，显示 `1.25×`；
   播放图标由 `payload.playing` 决定（`▶` / `❚❚`）。

## 验证方式

- [ ] `make test`（新增 2 组用例）
- [ ] `make build` + `make check`（`35-cast.js` 在注入列表里，必须过自检）
- [ ] 手工（未做就如实写）：`make cast` + 手机打开 → 点画面出现控制条 →
      暂停 / 播放 / ±5s / 1.5×，Mac 上播放器跟着变；Mac 上改倍速，手机图标同步。

## 预期量级

8 个文件 / +260 −30 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（随手机字幕屏的未提交改动一起走）。
- 验证结果（实际输出）：

  ```text
  $ make test
  ℹ tests 180   ℹ pass 180   ℹ fail 0

  $ make build
  [build] SW 挂载   service-worker-loader.js += mod/35-cast.sw.js
  [build] 版本      1.12.900

  $ make check
  版本    1.12.900
  已注入  mod/00-shared.js, …, mod/50-settings-panel.js
  ```

  另外把手机页内联脚本单独抽出来跑过 `node --check`（`renderPage()` 的输出里
  `RATE_STEPS` 注入正确、客户端脚本语法通过）。

- 实现时补的一处（计划外但必要）：**内容没变时最多 1 秒也要发一次 `/push`**
  （`CONTROL_POLL_MS`）。否则暂停状态下内容去重会把推送全挡掉，手机点「播放」
  永远送不到扩展 —— 反向命令是搭这个响应回来的。代价是暂停时 1 req/s，局域网内可忽略。

- 遗留 / 与预期不符之处：
  1. **端到端未跑**：没有真的启动 `cast-server` + 扩展 + 手机走一遍（本地起服务会占端口，
     这次没跑）。HTTP 路由（`POST /control`）与 ack 语义只有单元测试覆盖
     （`sanitizeControl` / `enqueueControl` / `pruneControls`）。
  2. **真机未验证**：iOS 上点按钮的触感 / 控制条与齿轮的间距、以及 `video.play()`
     是否会被自动播放策略拒绝（被拒时静默忽略，需再点一次）。
  3. 底部进度条仍然不能拖拽跳转（本轮「不做什么」已写明）。
  4. 手机与 Mac 的状态最多有 1 秒不同步（命令随下一拍 `/push` 下发、状态随下一帧 SSE 回来）。

