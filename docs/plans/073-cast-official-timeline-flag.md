# 073 手机字幕屏：区分「官方时间轴」与「采样时间」，只对官方句提前起跑

> 状态：待执行

## 需求

PLAN 069 的换句排程依赖 `plan` 里的 `start`。有骨架（官方整条原文轨）时这个时间是
官方给的；没有骨架时是**采样**出来的（`MutationObserver` 触发那一瞬的 `currentTime`）。
两者混在一个字段里，手机端无从区分：对采样句提前 260ms 起跑，滚动就会明显早于字幕切换。

## 根因

`10-subtitle-track.js` 已经能把骨架句标出来（`officialCues` 是 WeakSet），但**没有对外
暴露**；`35-cast.js` 的 `upcomingCues()` 于是把所有句一视同仁：

```javascript
out.push({ start, end, primary, secondary });
```

采样时间的不确定度来自两处（文件头已写明）：

```12:14:src/mod/10-subtitle-track.js
 * 「监听 DOM 变化 + 采样 video.currentTime」自建轨道。行级时间戳的精度取决于
 * MutationObserver 的触发时刻（实际就是字幕切换那一瞬），够用；但拿不到逐词
```

对这样的 `start` 做「提前一个动画时长起跑」，等于把这个误差放大成肉眼可见的
「滚早了 / 滚晚了」。

## 做什么

### 轨道模块（`src/mod/10-subtitle-track.js`）

- 新增只读接口 `isOfficialAt(start)`：按 `start` 二分定位轨道句，返回它是否属于骨架
  （`officialCues.has(cue)`）；找不到返回 `false`。不改任何既有口径与数据结构。

### 发送端（`src/mod/35-cast.js`）

- `upcomingCues()` 的每一项增加 `official`（布尔）。
- `plan` 仍是 3 项（当前 + 2 未来），字段只是多一个布尔，体积可忽略。

### 手机端（`tools/cast-page.mjs`）

- `planSwap()`：只有 `entry.official === true` 才排程；否则不排，退回「实到帧驱动」
  （PLAN 068 的行为）。这样：
  - 有骨架（绝大多数点播视频）→ 保持 PLAN 069 的精确滚动；
  - 直播 / 无缓存 / 骨架晚到 → 宁可晚一拍，也不要「滚早了再等字幕」。
- 已在跑的排程不受影响（`plan` 变化只在下一帧生效）。

## 不做什么

- 不改进采样精度本身（那需要另一套词级/帧级时钟，官方不提供）。
- 不把 `end` 也做来源区分（`end` 只影响进度条分母，PLAN 062 已有兜底）。
- 不改桌面浮窗（`30-desktop-subtitles.js`）的滚动：它不走 `plan`。
- 不改服务端。

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - src/mod/35-cast.js
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/073-cast-official-timeline-flag.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/30-desktop-subtitles.js
  - tools/cast-server.mjs
```

## 实现方案

1. `10-subtitle-track.js`：复用 `indexAt()` 的二分，`api.isOfficialAt`。
2. `35-cast.js::upcomingCues()`：`official: track.isOfficialAt ? track.isOfficialAt(start) : false`。
3. `cast-page.mjs::planSwap()`：`if (next.official !== true) return;`，注释写明为什么。
4. 测试：骨架到位 → `plan[*].official === true`；纯采样 → `false`；
   页面侧静态断言「非官方句不排程」。

## 验证方式

- [ ] `make test`（含既有 `plan` 结构断言的同步改写）。
- [ ] `make build` / `make check`。
- [ ] CDP：分别用「带骨架」与「不带骨架」两套帧，前者动画仍在句边界结束，
      后者退回到达驱动且只滚一次。

## 预期量级

6 个文件，+60 / −10 行。

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：未提交
- 验证结果：
  - `make test` 通过（新增 1 条：采样句不排程；`plan` 结构断言已同步加 `official`）。
  - `make build` / `make check` 通过。
  - 冒烟里用「start < 9 视为骨架句」的桩，确认 `plan[0..2]` 的 `official` 分别为
    true/true/false，发送端能区分来源。
- 遗留问题与差异：
  - 没有真实 YouTube 骨架轨做端到端验证；`isOfficialAt()` 依赖 `indexAt()` 的二分与
    20ms 容差（手机端拿到的是 JSON 往返后的浮点），已在注释里写明。
  - 骨架未就绪的前几秒会全部退到「实到帧驱动」，观感与 PLAN 068 相同（不倒退，但也没提前量）。
  - 断流兜底（PLAN 072）不看 `official`：它由播放位置在 rAF 上触发，不需要提前量，
    采样句与骨架句的误差对「到点才换」影响很小。
