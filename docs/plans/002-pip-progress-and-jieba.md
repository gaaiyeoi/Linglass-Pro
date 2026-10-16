# 002 桌面字幕：进度条修正 + 原文行带文节分隔符

> 状态：**已完成**（Node 侧门禁全绿；浏览器视觉未验证，见文末）

## 需求

1. 桌面字幕浮窗里的歌词式进度条**还是错的**。
2. 浮窗里**没有分隔符**，但 Linglass 视频内的原文行已经有了（那是 `15-ja-break.js` 加的）。

## 根因

### 1. 进度条：分母被「活跃句自己的 end」吃掉了

`10-subtitle-track.js` 里有两条互相打架的语义：

- 活跃句的 `end` 会被 `extendActive()` **一路推到当前播放位置**（:150-159），
  这是为了 SRT 导出时能拿"播到哪儿了"当结束时间——**导出语义是对的**；
- 但 `getProgress()`（:340-347）走 `getCurrent()` → `resolveEnd(cue, next)`（:323-330），
  而 `resolveEnd` 优先取 `cue.end`。活跃句的 `cue.end` 就是刚刚被推上去的 `currentTime`：

  ```text
  分母 = resolveEnd = cue.end ≈ currentTime = t
  进度 = (t - start) / (t - start) = 1
  ```

  1s 心跳（`HEARTBEAT_MS = 1000`）一次，所以**每句开始不到 1 秒，进度就顶到 100% 并停在那里**。
  中途拖动进度条回到句中某句时会正常，因为那时它不是活跃句、`end` 已定稿 ——
  这正是"看着像随机错"的来源。

- 次级问题：活跃句（通常是最后一句）`next == null` 时，`resolveEnd` 因为没有 `next`
  才退到 `start + DEFAULT_CUE_SECONDS`，所以"有没有下一句"决定了进度是 1 还是线性插值。

**证据**：`10-subtitle-track.js:150-159`（写 `active.end`）、`:322-330`（`resolveEnd`）、
`:340-347`（`getProgress`）；既有冒烟测试 `字幕轨道：句内进度按线性插值，暂停时不推进`
之所以是绿的，是因为它手动把 `currentTime` **倒回**到 11 之后才断言 0.5 —— 真实播放不会倒回。

### 2. 分隔符：浮窗走的是纯文本，压根没接文节切分

`30-desktop-subtitles.js:81-94` 的 `pushText()` 直接 `p.textContent = lines.primary`，
`lines` 来自 `track.readLines()`（官方原文的**干净文本**）。
文节切分器 `05-ja-segment.js` 与它的渲染方 `15-ja-break.js` 只作用于**视频内的原文行**，
浮窗完全没用到 —— 所以视频里有点、浮窗里没有。

## 做什么

- **进度**：给进度单独算一个**预测结束时间**，不再用活跃句被推进的 `end`：
  - 分母 = `下一句已存在 ? 下一句.start : start + 估计时长`
  - 估计时长 = 已定稿句子的**中位时长**（无样本时退回 `DEFAULT_CUE_SECONDS = 6`），下限 1s
  - `cue.end` 的既有语义（导出 SRT 用）**保持不变**
  - 新增只读接口 `__llgModTrack.getProgressEnd()`，供测试直接断言分母
- **分隔符**：`30-desktop-subtitles.js` 渲染原文行时，若 `__llgModJaBreak.isEnabled()` 为真，
  用 `__llgModJaSegment.cut()` 的切点把原文切成文节、以 `__llgModJaBreak.SEPARATOR`（`|`）连接，
  两侧用窄空格 `\u2009` 贴近官方 `margin: 0 .14em` 的观感
  - 浮窗是纯文本（不是官方字幕行），**不涉及**「不许改官方文本流」那条约束
  - 尊重用户的开关：`__llgModJaBreak` 不存在或关闭时不插分隔符
  - 涉及开关状态的去重键要带上开关状态，否则切换开关后浮窗不重绘
- 补冒烟测试：回归（活跃句播 3s 后进度必须明显 < 1）、有下一句时分母等于下一句 start、
  估计时长取中位数、分隔符插入/不插入

## 不做什么

- 不改 `15-ja-break.js`（视频内断句已上线且是对的，浮窗只是复用它的切分结果）
- 不改 `05-ja-segment.js`（纯函数切分器）
- 不改导出格式（Markdown / SRT 的既有断言一条都不许动）
- 不给侧边面板的逐句列表加分隔符（没要求，别扩大范围）
- 不做词级/逐字进度（官方不给逐词时间戳，属于 PLAN 之外的坑）
- 不新增依赖、不动 `vendor/`、不动 `30-desktop-subtitles.js` 里 PLAN 001 刚加的常驻逻辑

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - src/mod/30-desktop-subtitles.js
  - tools/test/smoke.test.mjs
  - docs/plans/002-pip-progress-and-jieba.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/05-ja-segment.js
  - src/mod/15-ja-break.js
  - src/mod/40-study-panel.js
  - build.mjs
  - Makefile
```

## 实现方案

1. `10-subtitle-track.js`：
   - 新增 `MIN_CUE_SECONDS = 1`
   - `estimatedSeconds()`：取已定稿（`end` 有效）句子的时长中位数，空则 `DEFAULT_CUE_SECONDS`
   - `progressEnd(cue, next)`：`next ? next.start : cue.start + estimatedSeconds()`
   - `getProgress()` 改用 `progressEnd`；新增 `getProgressEnd()` 进 API
2. `30-desktop-subtitles.js`：新增 `displayPrimary(text)`（切分 + 拼接），
   去重键带上分隔符开关状态；`PIP_CSS` 里给原文行加 `font-variant` 之外无需改动
   （窄空格已在文本里）
3. `tools/test/smoke.test.mjs`：
   - 改掉固化了旧语义的那条进度用例，写明"旧断言依赖把 currentTime 倒回"，
     并补一条真实播放路径的回归断言
   - 新增分隔符用例（需要 `__llgModJaBreak` 桩 + 加载 `30-desktop-subtitles.js`）

## 验证方式

- [ ] `make test`（23 → 28+ 例）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：`make probe --headed` 看浮窗 `fill-primary` 的 width 是否随播放推进，
      以及原文行是否出现 `|` 分隔（探针的 `PIP_PROBE` 会原样打印这两个字段）

## 预期量级

3 个文件 / +120 −40 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**未提交**（见 PLAN 001 的说明）
- 验证结果（实际输出）：

  ```text
  make test   →  ℹ tests 35   ℹ pass 35   ℹ fail 0
  make build  →  契约校验 ✓；注入自检通过；版本 1.12.900
  make check  →  已注入 7 个 mod 脚本
  ```

  新增用例：`字幕轨道：活跃句的 end 不再吞掉进度分母`（回归，旧实现下 progress 恒为 1）、
  `字幕轨道：有下一句时，进度分母用下一句的起点`、
  `字幕轨道：估计时长取已定稿句子的中位数，且不含活跃句`、
  `桌面字幕：原文行按文节插分隔符，并跟随视频内断句的开关`、
  `桌面字幕：浮窗原文行真的带上了分隔符`、
  `桌面字幕：浮窗进度条按新的分母走`

- 遗留 / 与预期不符之处：
  1. **重写了一条旧断言**：`字幕轨道：句内进度按线性插值，暂停时不推进`。
     它的 0.5 之所以成立，是因为它手动把 `currentTime` **倒回**到句中 —— 真实播放不会倒回，
     而那正是让旧 bug 藏住的写法。重写后的用例保留了「暂停时 end/进度都不动」的断言，
     并在注释里写明了为什么要改（AGENTS.md §3 允许改固化旧语义的断言，但要求写明理由）。
  2. **长句的进度会在末段停在 100%**：官方不暴露 cue 时间轴，一句的真实时长只有它
     结束那一刻才知道，所以活跃句只能用中位数估计。这是信息缺失造成的上限，
     不是实现 bug（文件头注释本来就记着这个限制）。
  3. `estimatedSeconds()` 加了**失效式缓存**：它位于 `getProgress()` 每帧调用的路径上，
     不缓存就是每帧对全部 cue 排一次序。
  4. 分隔符**只做了浮窗**：侧边面板的逐句列表没加（没要求，避免扩大范围）。
  5. `displayPrimary()` 依赖 `__llgModJaBreak`（15-ja-break.js）。它不存在或开关关着时
     原样返回 —— 所以视频内断句的开关会同时管住两处，行为一致。
  6. **浏览器视觉未验证**：`make probe --headed` 会打印 `PIP_PROBE` 里的
     `primary`（带不带 `|`）与 `fillPrimary` 宽度，是人工确认的正路。
