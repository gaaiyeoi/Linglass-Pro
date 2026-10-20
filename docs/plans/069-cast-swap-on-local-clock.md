# 069 手机字幕屏：换句改成按本地时钟排程（消除网络节拍）

> 状态：待执行

## 需求

手机字幕屏的换句动效已经做了「两块板并行拼合滚动」（PLAN 065 → 068），但真实设备上看仍然生硬：
有时顺滑滚一格，有时「啪」地瞬变；连续对话时整屏像在按固定节拍一下一下地跳，
无法形成歌词式的连续卷动观感。

期望：对话连续时，滚动的**结束时刻**与该句实际开始播放的时刻对齐，
滚动速度只由「距下一句还有多久」决定，网络抖动不体现在动效上；
快速对白时也保持连续卷动，而不是硬切。

## 根因

现象、定位过程与证据如下（只读不改）。

### 1. 换句事件本身被量化到 250ms 网格

```44:45:src/mod/35-cast.js
  /** 推送节拍：rAF 里按时间门限发，约 4 次/秒；暂停且内容没变时不会发 */
  const PUSH_INTERVAL_MS = 250;
```

扩展侧虽然在 `MutationObserver` 里能瞬时知道换句，但真正发到手机的帧最多 4 次/秒。
因此「换句」这一事实到达手机的时刻，天然落在 0–250ms 的不确定区间内。

### 2. 手机端把「到达时刻」当成换句起点

```1117:1124:tools/cast-page.mjs
    // 画面换句（含空档、第一次收到字幕）：这一帧就是新句的起点。这里**不用 progress**
    // —— 换句窗口里它可能是上一句的尾巴、也可能是 null，都不是这一句的起点。
    if (!cueClock.active || cueClock.text !== text) {
      cueClock = {
        active: cueDuration > 0, playing, start: cue ? cue.start : null,
        duration: cueDuration, baseMs: now, baseProgress: 0, text,
      };
      return;
    }
```

PLAN 062 已经把**进度条**从「每帧重设宽度」改成「推送给基准、rAF 本地插值」，
但**换句本身**仍然以到达时刻 `now` 为起点，动画也是 `render()` 里检测到文本变化才起跑：

```1258:1269:tools/cast-page.mjs
    applyPrefs();
    if (lineChanged) {
      // 首次收到字幕、或 220ms 内连续换句：直接切，不叠动画
      const canAnimate = lastCurKey && plateEl.textContent
        && performance.now() - lastSwapAt > 220;
      if (canAnimate) {
        playSwap(cur, swapDir);
      } else {
        resetGhost();
        plateEl.getAnimations().forEach((anim) => anim.cancel());
        applyLineText(cur);
      }
    }
```

于是「动画开始时刻 = 帧到达时刻」，这个时刻随 WiFi 抖动（几十到数百毫秒），
时序不均匀，观感就是一顿一顿。

### 3. 快速对白直接跳过动效

上面的 `220ms` 门限意味着：两句字幕间隔小于 220ms 时完全不滚，直接换字。
同一段对话里「滚 / 不滚」混着出现，会强化「跳」的感觉。

### 4. 滚动的两个高度不一致

PLAN 068 用「旧窗口高度 H」当位移量；新句更高时起始帧会从下沿多露出一截，
视觉上像「下一句先探进来再上移」，也会被读成不连续。

### 5. 真机观感从未验证

两份前序 PLAN 都写明了这一点：

```96:99:docs/plans/065-cast-line-swap-animation.md
- 遗留问题与差异：
  1. 真机手感未验证（150/210ms，语速快时是否够跟）。
```

```85:89:docs/plans/068-cast-swap-scroll.md
  - 真机 iOS 的观感（260ms 是否偏快/偏慢）未人工确认。
```

综上：不是缓动曲线的问题，而是**换句的触发时刻不在本地时钟上**。

## 做什么

### A. 协议：帧里补上「时间戳」与「未来句时间表」（向后兼容）

`src/mod/35-cast.js` 的 `snapshot()` 增加两个字段，`v` 仍为 1（可选字段）：

```jsonc
{
  "sentAt": 1712345678901,   // 扩展侧 Date.now()，仅用于手机端估计延迟
  "plan": [                  // 从 track 轨道取，最多 3 句；[0] 是当前句，[1] 是下一句
    { "start": 12.4, "end": 15.1, "primary": "…", "secondary": "…" }
  ]
}
```

- `plan` 的数据源是 `__llgModTrack.getCues()`（骨架已把整条原文轨铺好），不新增采集逻辑。
- `plan` 里 `secondary` 可能为空（译文是播放后才采到的），此时换句先出原文，
  译文到达后按 PLAN 066 的既有规则补写，**不重启动画**。
- 旧扩展没有这两个字段时，手机端走原有「到达即换句」路径，行为不变。

### B. 手机端：延迟估计

- 维护一个长度为 20 的滑动窗口，记录每帧的 `arrivalWall - sentAt`。
- 取窗口**最小值**作为 `clockOffset`（最小样本最接近「无排队」那次，含时钟差 + 最小单程延迟）。
- `sendLocal(frame) = arrivalPerf - (arrivalWall - sentAt - clockOffset)`，
  即「扩展发出这一帧时，手机的 `performance.now()` 大约是多少」。
- 视频位置估值：`videoPos(now) = timeline.position + (now - sendLocal) / 1000 * rate`（仅 `playing`）。

### C. 手机端：把换句排程到本地时间轴上

- 收到帧后，用 `plan[1].start` 算出目标时刻：

  ```text
  dueLocal = sendLocal + (plan[1].start - timeline.position) / rate * 1000
  startAt  = dueLocal - swapDuration
  ```

- 由 rAF 监视器驱动：到达 `startAt` 才启动 `playSwap()`，**滚动结束的那一刻正好是该句开始的时刻**。
- 新句文本取自 `plan[1]` 的预排内容（原文先到，译文可后补），不再依赖「换句那一帧」是否已经到达。
- **校正**：若实际帧的换句到达时刻与 `dueLocal` 相差超过 120ms（源端断句与轨道时间不符、
  缓冲、seek、暂停恢复），以新到达的帧为准重排；动画已经在跑时用
  `animation.currentTime` 把进度拉到对应位置，不 `cancel()` 重开（重开会造成二次顿挫）。
- 暂停 / `playing=false` / `timeline.position` 跳变超过 0.8s（沿用 `syncClocks` 的漂移判定）
  → 清空排程，回到「到达即换句」，等下一帧重建。
- 拿不到 `sentAt` / `plan` / `timeline`（直播、旧扩展）→ 整体退回现有行为。

### D. 动画时长：按剩余时间决定，取消硬切

- 删除 `220ms 内直接切` 的分支。
- `swapDuration = clamp(dueLocal - now, MIN_SWAP_MS, MAX_SWAP_MS)`，初始取
  `MIN_SWAP_MS = 140`、`MAX_SWAP_MS = 260`；只剩不到 80ms 才做硬切（此时人眼也接不住）。
- 同一句的「分步上屏」（无骨架时一句被采样成多条）仍由现有文本比对过滤，不参与排程。

### E. 位移量取两块板的较大高度

- `travel = max(oldReelHeight, newPlateHeight)`，新句先写入后再测量；
- 两块板仍从 `0 → -travel` / `+travel → 0` 并行，`#reel` 继续裁切，拼合关系不变。

### F. 边缘行同步

- `nudgeCtx(dir)` 的时长改为与本次 `swapDuration` 一致，避免上下文行比主句先停。

## 不做什么

- 不做词级（逐字）进度或逐字滚动，句内仍然只有进度条。
- 不做时钟往返同步（ping-pong / NTP 式对时）：只用单程最小延迟估计。
- 不改 `cast-server.mjs` 的 SSE 结构与 `/push` 语义，新字段只做透传。
- 不改 `PUSH_INTERVAL_MS` 本身（不在临近换句时提速到 8Hz）——排程已经消除对推送准点性的依赖。
- 不改选句手势（PLAN 067）、不改控件、不改字号与排版（PLAN 063）。
- 不动桌面 PiP（`30-desktop-subtitles.js`）与 `10-subtitle-track.js`。
- 不为 `#ghost` 再做一层独立动画体系：仍复用 PLAN 068 的两块板。

## 修改范围

```yaml
allowed_paths:
  - src/mod/35-cast.js
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/069-cast-swap-on-local-clock.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - tools/cast-server.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. **扩展侧**（`35-cast.js`）
   - `snapshot()` 增 `sentAt: Date.now()`。
   - 新增 `upcomingCues(current, n)`：从 `track.getCues()` 取 `[index, index + n]`，
     输出 `{ start, end, primary, secondary }`；取不到时返回 `[]`。
   - 注意 `sentAt` 不参与 `frameKey()`：它是每帧都变的字段，进了指纹就等于「每 250ms 必发」，
     会打破现有的去重与暂停省电策略。
2. **手机侧状态机**（`cast-page.mjs`）
   - 新增 `latency`（min-filter）与 `scheduler`（`{ dueLocal, startAt, cueStart, timerRaf }`）。
   - `render()` 拆成两步：`applyFrame(payload)`（数据落地）与 `syncSwapSchedule()`（重排）。
   - `playSwap(cur, dir, duration, travel)` 改为接收外部给定时长与位移。
   - 提供 `testSwapSchedule(payload, now)` 之类的纯函数入口供冒烟测试使用（沿用该文件既有测试钩子风格）。
3. **测试**（`cast-page.test.mjs` / `smoke.test.mjs`）
   - `smoke.test.mjs`：快照含数字 `sentAt` 与 `plan` 数组，`plan[0].start` 等于当前句 start；
     轨道为空时 `plan === []` 且不抛错。
   - `cast-page.test.mjs`：断言存在 min-filter、存在「按 `dueLocal - duration` 起跑」的排程、
     不再出现 `> 220` 的硬切门限；`travel` 取两高度较大值。

## 验证方式

- [x] `make test`：新增/改写的断言全部通过，附实际输出。
- [x] `make build`、`make check`。
- [x] CDP（自造带 `sentAt` / `plan` 的推流）：采样「动画结束时刻」与该句边界，偏差 ≤ 2ms；
      同一段连续 7 次换句每次**只有一次**动画，没有来回翻。
- [ ] CDP 人为注入 0 / 120 / 400ms 网络延迟：未做（探针是本地环回，见「遗留问题」）。
- [ ] CDP：连续 3 句间隔 < 200ms 的对白，三句都滚（不再硬切）——未单独构造该场景。
- [ ] 真机（iOS Safari、Android Chrome 各一次）：未做。
- [x] 回退路径：官方 `--demo` 推流（无 `sentAt` / `plan`）仍是「到达即换句」，每次一句、
      260ms、动画结束后 `#ghost` 隐藏、`#reel` 高度已交还内容。

## 预期量级

5 个文件，约 +260 / −80 行（其中测试约 +80）。

实际：`35-cast.js` +59，`cast-page.mjs` 净增约 +330（含改写），测试 +197（含改写的断言）。
工作区里还叠加着 PLAN 065–068 的未提交改动，所以 `git diff --stat` 的合计大于本 PLAN 的量。

## Definition of Done

见 AGENTS.md §6。

- 重点确认：`35-cast.js` 的 `frameKey()` 未被 `sentAt` 污染（暂停时不应每 250ms 全量发帧）。

## 完成情况

- 提交：未提交（按 PLAN 单独提交；工作区里 065–068 的改动尚未提交，需分开）
- 验证结果：

  ```text
  $ make test
  ℹ tests 214   ℹ pass 214   ℹ fail 0

  $ make build / make check
  契约校验通过，注入 11 个模块
  ```

  CDP（390×844 级别的 headless Chromium，自造 3 秒一句、100ms 一帧的推流）：
  7 次换句的动画时长 238–256ms，起跑时刻都在句边界前约一个时长，
  「滚动结束」与句边界的偏差 ≤ 2ms；`#ghost` 在结束时被清空、`#reel` 行内高度被清空。
  回退路径（`node tools/cast-server.mjs --demo`，帧里没有 `sentAt` / `plan`）：
  3 次换句各一次 260ms 动画，方向正确，结束后状态干净。

- 遗留问题与差异：
  1. **实现与 PLAN 的差异（位移量）**：§E 写的是 `travel = max(旧高, 新高)`。实测发现
     `#reel` 的高度跟着 `#plate` 走，新句更高时窗口会**当场长高**，用 max 反而让旧句下方
     露出一条空档。改为「动画期间把 `#reel` 的行内高度钉在旧高度，结束后交还内容」，
     滚动结束那一帧窗口才长到新高度。
  2. **计划外新增：陈旧帧守卫 `isStaleFrame()`**。排程换句在句边界「那一刻」滚完，
     但此时 250ms 节拍内还有几帧在报上一句：不挡的话实测会「滚上去 → 立刻滚回来 →
     再滚上去」地来回跳。判据用本地时钟（动画在跑，或视频估值已越过该句起点），
     真实的往回拖进度条不会被误挡。
  3. 计划外新增：`planSwap()` 跳过「已经滚上来的那一句」，否则陈旧帧会把上一个换句点
     重新算出来，再触发一次同向滚动。
  4. 排程检查寄生在 `paintProgress()` 的 rAF 循环里（未新开循环），因此换句精度上限
     等于屏幕刷新率（16.7ms 级）。
  5. 未做：真机手感；人为注入网络延迟（本机环回下 `sentAt` 的排队量恒为 0，延迟估计
     代码路径只是被走到、没有被真正压测）。
  6. 未做：`plan` 里的 `secondary` 通常是空的（译文是播放后才采到的），排程换句先出原文，
     译文到达后补写、不重启滚动 —— 这条路径靠代码阅读保证，没有单独构造用例。
