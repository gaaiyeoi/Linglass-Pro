# 060 全文轨默认在位：官方写缓存就采用，不再靠 60 秒轮询

> 状态：**已完成**（浏览器人工确认未做，见「完成情况」）
>
> 编号说明：原为 049，与 `049-pip-wheel-seek.md` 重复，2026-10-20 改为 060。

## 需求

用户口径：学习面板与导出 SRT **永远默认是整条轨**（全部句子与时间戳），而不是
「播了 N 条就只有 N 条」。

## 根因

骨架（官方整条原文轨缓存）本来就已经实现，但**采用时机靠 60 次心跳轮询**：
`maybeLoadSkeleton()` 每秒试一次，`SKELETON_MAX_TRIES = 60` 用尽后置 `skeleton.done = true`，
此后不再尝试，只有刷新页面才会重置。

本机 `chrome.storage.local` 实测（`fdgjeldegkinekicfbdeamkepbfoafgi`，2026-10-19）：

| videoId | 官方 `…:ja:primary` | 我们的 `llgTrack:` |
|---|---|---|
| `OU-6Dzawk98` | 有 | 34 句，时间戳为官方两位小数 → 采用成功 |
| `b3P1qQfya0I` | 有 | 34 句，同上 → 采用成功 |
| `RYlmJUAIGtM` | 有（100+ 句） | 1 → 53 句，`start=301.136855` 浮点 → **从未采用** |

第三条的官方缓存 `cachedAt` 比我们第一次落盘早约 470 秒，但页面打开时间明显更早：
缓存是在我们 60 秒窗口**之后**才写进 storage 的 —— 于是骨架被永久放弃，面板与导出自始至终
只有播放过的句子。

EnglishXYZ 的做法（MAIN world 取 `captionTracks` / `get_panel`）能绕开官方缓存，
但官方缓存里本来就有同一条整轨；这里的缺陷是**采用时机**，不是数据源缺失。
复刻 MAIN world 的代价与失效风险见 PLAN 006「根因」，本轮不动。

## 做什么

- `src/mod/10-subtitle-track.js`：
  - 监听 `chrome.storage.onChanged`：`areaName === 'local'`、key 命中
    `subtitle-cache:v6:{当前 videoId}:*:primary` 且有 `newValue` 时，重置骨架状态并立刻
    尝试采用（**不受 60 次窗口限制**）。
  - `maybeLoadSkeleton()` 增加 `pending`：事件在加载中到达时，等当前这次结束再补一次，
    避免「事件来了但被 loading 挡掉、之后 done 又永久放弃」。
  - **更短的骨架不许覆盖已采用的整轨**：官方还有 `:yt-reseg` 之类的重切产物，
    若同视频出现更短的 `:primary`（或重写），采用它会把整条轨缩回去 —— 只在新骨架
    句数不少于当前骨架句数时才替换。
  - 事件里别的视频的缓存写入直接忽略。
- `tools/test/smoke.test.mjs`：
  - harness 的 `chrome.storage.onChanged` 区分 local / sync，新增 `h.emitLocal(changes)`；
  - 新增用例（**改前为红**）：
    1. 「60 次窗口耗尽后才写入缓存」→ 事件一到就采用；
    2. 「别的视频的缓存写入」不改变当前轨道；
    3. 「更短的骨架」不覆盖已采用的全文轨。
- `README.md`：学习面板一节明确「原文轨来自官方缓存，打开面板 / 导出即是整条；
  译文仍只在实际播放过的句子上出现」。
- `docs/plans/006-full-subtitle-track.md`：状态从「待执行」改为「已实现（由 014 / 049 加固）」。

## 不做什么

- **不注入 MAIN world、不复刻 YouTube `get_panel` / `captionTracks`**（EnglishXYZ 路线）。
  官方缓存缺失（Linglass 自己没取到整轨）时本轮仍退化为「播放过的句子」；
  真遇到这种视频另立 PLAN。
- 不改导出格式（`toSrt` / Markdown）、不改浮窗、不改面板渲染。
- 不改官方那批 `subtitle-cache:*` key（仍然只读）。
- 不把 `:yt-reseg` 当骨架（PLAN 014 的边界：语言语义未实测）。
- 不做「点导出时同步等待网络取轨」：导出保持同步、离线可用。

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - tools/test/smoke.test.mjs
  - README.md
  - docs/plans/006-full-subtitle-track.md
  - docs/plans/049-full-track-by-default.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/05-srt.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
```

## 实现方案

1. 骨架状态机加 `pending`；`finally` 里消费它。
2. `onStorageChanged(changes, areaName)`：只认当前视频的 `:primary` 新值；
   `loading` 时置 `pending`，否则重置 `done/keys/next/tries` 后调用 `maybeLoadSkeleton()`。
3. 采用循环里加「不许变短」判据（用 `officialCues` 统计当前骨架句数）。
4. 启动时注册监听（`typeof chrome.storage.onChanged?.addListener === 'function'` 兜底）。
5. 测试与文档。

## 验证方式

- [x] `make test`（新增 3 例）
- [x] `make build` + `make check`
- [ ] 浏览器人工确认：打开一条**没缓存过**的日语视频，等官方取完整轨（几秒~几分钟），
      面板句数应从「播放条数」跳到整条；导出 SRT 的行数 = 整条轨
- [ ] 本机 storage 复核：`llgTrack:<videoId>` 的 `end` 变成官方两位小数、句数与
      `subtitle-cache:v6:<videoId>:ja:primary` 一致

## 预期量级

5 个文件 / +150 −20 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区里同时有 PLAN 047 液态玻璃与 PLAN 048 的改动，按「一个 PLAN 一个提交」先不合）
- 验证结果（实际输出）：

  ```text
  $ node --test --test-name-pattern="轮询窗口耗尽|别的视频的缓存写入|更短的骨架" tools/test/smoke.test.mjs
  ℹ tests 3   ℹ pass 3   ℹ fail 0

  $ make test
  ℹ tests 184   ℹ pass 184   ℹ fail 0

  $ make build
  [build] 注入  mod/00-shared.js → … → mod/10-subtitle-track.js → … → mod/50-settings-panel.js
  （契约校验无告警）

  $ make check
  已注入  mod/00-shared.js, …, mod/10-subtitle-track.js, …, mod/50-settings-panel.js
  ```

- 遗留 / 与预期不符之处：
  1. **浏览器人工确认没做**：需要重载 `dist/` 后打开一条日语视频，看面板句数从「播放条数」
     跳到整条（这是「骨架真的采用」最直观的证据）。
  2. **官方缓存本身缺失时仍退化**：如果 Linglass 自己没取到整轨（无 `:primary` 值），
     本轮仍只有播放过的句子。要彻底独立于官方，需要 EnglishXYZ 那条 MAIN world 路线
     （PLAN 006「根因」列了代价），另立 PLAN。
  3. **60 次轮询窗口保留**：事件驱动是主路径，轮询继续做兜底（例如 storage 事件被浏览器
     节流、或同一次事件里值还没落盘）。两者叠加不影响正确性。
  4. `:yt-reseg` 仍不当骨架（沿用 PLAN 014 的边界，语言语义未实测）。
