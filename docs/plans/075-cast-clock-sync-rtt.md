# 075 手机字幕屏：用 RTT 显式测时钟差，替代「学出来的偏差」

> 状态：待执行

## 需求

PLAN 069 的 `swapCtl.bias` 是**学**出来的：首帧按 0 算，要经过几轮换句才收敛。
刚打开页面 / 刚换视频时，最初的几次换句仍可能偏早或偏晚；多台手机各自的收敛速度也不同。
期望首帧就用一个真实的时钟差起算。

## 根因

```javascript
const due = localAt(Number(next.start)) + swapCtl.bias;
```

`bias` 只能从「实到帧 vs 预测」里估，且必须先有一次完整的排程 + 换句才能采样。
而两台机器的时钟差其实**可以主动测**：`sentAt` 是扩展侧 `Date.now()`，扩展与中转进程
在同一台 Mac（localhost，延迟 <1ms），所以「手机 ↔ 中转」的时钟差就等于
「手机 ↔ 扩展」的时钟差。

## 做什么

### 服务端（`tools/cast-server.mjs`）

- 新增 `GET /ping`：返回 `{ ok: true, at: Date.now() }`，`cache-control: no-store`。
- 不改 `/push` / `/stream` 的既有结构。

### 手机端（`tools/cast-page.mjs`）

- 新增 `clockSync`：
  - 页面载入后做 3 次 `/ping`（间隔 120ms），取**最小 RTT** 的那次：
    `offset = at + rtt / 2 - arrivalWall`（服务端时间 → 手机墙钟）。
  - 之后每 30 秒复测一次（单次即可，仍只采纳更小的 RTT）。
- `noteQueueDelay()` 改为：
  ```text
  oneWay = (arrivalWall - sentAt) - clockSync.offset   // 期望 ≈ 单程延迟
  ```
  再用原有的 `min-filter` 扣掉排队量（保留兜底：`offset` 未知时退化为原逻辑）。
- `planSwap()` 里 `swapCtl.bias` 的初值改为 `clockSync.offset` 的相反数
  （`localAt()` 用的是 `performance.now()` 基准，`offset` 把墙钟对齐后，
  取样的系统误差就只剩单程延迟；`bias` 继续做残差微调，初值不再从 0 起步）。

## 不做什么

- 不做 NTP / PTP 式对时，不改服务器时间源。
- 不改 `/stream` 的 `at` 字段用途（它仍是「服务端广播时刻」，仅诊断用）。
- 不改手机端的渲染与排程结构。
- 不做多手机之间的对齐（各自测各自的）。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-server.mjs
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/075-cast-clock-sync-rtt.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/35-cast.js
  - tools/cast-control.mjs
```

## 实现方案

1. `fetch('/ping', { cache: 'no-store' })` → `{ at }`；用 `performance.now()` 前后夹住，
   RTT 取 `t1 - t0` 的墙钟差值（`Date.now()`）。
2. 单例 `clockSync = { offset: null, rtt: null, timer: 0 }`；`syncClock()` 幂等、可重入。
3. `noteQueueDelay(sentAt, arrivalWall)` 在有 `offset` 时：
   `excess = max(0, (arrivalWall - sentAt - offset) - minObservedOneWay)`。
4. `planSwap()` 之前确保 `swapCtl.bias` 至少在首帧前被 `offset` 播种
   （`bias = -offset`：把「墙钟差」从预测里扣掉，等价于把 `sentAt` 对齐到手机时钟）。

## 验证方式

- [ ] `make test` / `make build` / `make check`。
- [ ] 本机：`/ping` 的 RTT < 5ms，`offset` 稳定（连续 5 次极差 < 10ms）。
- [ ] CDP：给推流帧人为加 120ms 延迟，首帧即对齐（第一次换句偏差 < 80ms），
      不再需要「前两次换句用来学习」。

## 预期量级

4 个文件，+110 / −20 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：未提交
- 验证结果：
  - `make test` 通过（新增 1 条页面侧断言组：`/ping`、offset 公式、30 秒复测、播种条件）。
  - `make build` / `make check` 通过。
  - 本机 `/ping` 实测 RTT 0.9–4.2ms；CDP 综合探针确认页面载入时会打一次 `/ping`。
- 遗留问题与差异：
  - **偏差播种只在测到时钟差后才生效**（`clockSync.offset` 有限时才播种）。否则
    `queue.min` 里含两台机器的时钟偏移，直接拿来当单程延迟会把排程推到错误的位置。
    没有 `/ping`（旧服务端）时行为与 PLAN 069 完全一致。
  - 本机环回下单程延迟接近 0，播种量级只有几毫秒，无法体现「首帧即准」的收益；
    人为注入 120ms 延迟的那条验证没有做（探针未加延迟注入）。
  - 复测只采纳更小的 RTT；若某段时间网络持续变差，offset 会停留在历史最优值，
    这对「估计真实单程」是偏乐观的，但对字幕对齐无害（偏差由 EWMA 继续吸收）。
