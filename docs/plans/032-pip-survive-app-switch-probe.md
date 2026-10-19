# 032 桌面字幕浮窗：切走标签页 / 应用时是否存活（实测）

> 状态：**已完成**（探针已写、未跑；结论来自用户实测观察，见「完成情况」）

## 需求

用户期望：切到别的标签页、别的应用去干活时，字幕浮窗**留在桌面**。
点名参照 Arc 的「切走就有视频小浮窗」（Little Arc / 原生 PiP）。

当前仓库只有一条间接证据（PLAN 022）：用户报的是「切走时正常，**切回来**被收走」。
而本次需求说的是「**切走时**应该还在」。两者是不同的时刻，修法完全不同：

- 若「切走就没了」→ 说明 Arc 对 Document PiP 的处理与 Chrome 不同，或者压根没开，
  那就只剩原生 helper（路线 B）一条路；
- 若「切走还在、只是切回来被收走」→ 现状已经拿到目标行为的大部分，
  剩下的只是重开时机问题，不值得为它引入原生层。

**先用一次实测把「到底哪个时刻丢的」钉死，再决定投哪条路线。**

## 待回答的问题

| 编号 | 问题 | 为什么要问 |
|---|---|---|
| Q1 | 目标浏览器里 `'documentPictureInPicture' in window` 是否为真 | Arc 若没实现这个 API，一切讨论都归零 |
| Q2 | 切到同一浏览器的**另一个标签页**，浮窗是否还在 | 区分「标签页可见性变化」与「系统焦点变化」 |
| Q3 | 切到**别的应用**（Finder），浮窗是否还在 | 这是用户真正要的能力 |
| Q4 | 切回浏览器本体，浮窗是否还在 | PLAN 022 说不在，需要复现确认 |
| Q5 | 窗口丢了之后，**一次真实页面点击**能否把它弄回来 | 决定「现状是否已经够用」 |
| Q6 | 结论落在哪条路线 | A（优化重开时机）/ B（原生 helper） |

## 做什么

- `tools/probe.mjs` 新增三个探针与一段实测：
  - `PIP_ALIVE_PROBE`：一次采样给出 `windowOpen / closed / document.visibilityState /
    document.hasFocus() / 控制栏按钮 on`；
  - `pipTimeline()`：按给定的时间点连续采样，打印成表，并记下「第一次发现窗口没了」的时刻
    （只说「没了」不够，还要知道它是**立刻**没的，还是延迟几秒才没的）；
  - `pipTabSwitch()`：用 CDP `Target.createTarget` 开一个空白标签页并激活，
    采样后用 `Target.activateTarget`（失败则 `Page.bringToFront`）切回来；
  - `pipAppSwitch()`：macOS 上用 `open -a Finder` 切走、`open -a <浏览器 .app>` 切回；
  - `restorePipByClick()`：窗口丢了之后，在 `#movie_player` 上派发一次真实
    mousePressed/mouseReleased，验证「arm() 的一次性手势」能把它接回来。
- 新实测块接在「实测⑤：宿主窗口最小化」之后；⑤ 之后窗口若不在了，先点一次控制栏按钮重开，
  否则 ⑥⑦ 无物可测。

## 不做什么

1. **不改 `src/mod/` 的任何文件** —— 本轮只测量，不修。
2. 不引入原生代码、不加依赖、不动 `vendor/` 与 `dist/`。
3. 不试图「阻止 UA 关闭窗口」（PLAN 001 / 022 已论证做不到）。
4. 不把实测结论当成已验证：**没跑过的浏览器就是没跑过**，结论里要写清是哪台机器、哪个浏览器。
5. 不顺手改布局探针 / 面板探针 / 既有 PiP 探针的输出格式（`PIP_PROBE` 保持原样）。

## 修改范围

```yaml
allowed_paths:
  - tools/probe.mjs
  - docs/plans/032-pip-survive-app-switch-probe.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
  - build.mjs
  - Makefile
  - tools/test/**
  - tools/package.mjs
```

## 实现方案

1. `PIP_ALIVE_PROBE` 放在既有 `PIP_PROBE` 之后：**新增**一个探针而不是改旧的，
   旧的被「实测④」的既有输出口径钉着。
2. `pipTimeline(cdp, sessionId, phase, gaps)`：`gaps` 是「距上一次采样等多久」，
   返回 `{ last, lostAt }`；每行打印 `+Nms 窗口=在/没了 可见=visible 焦点=true 按钮=on`。
3. `pipTabSwitch()`：
   - `Target.createTarget({ url: 'about:blank' })` 新建并自动激活；
   - 采样；`Target.activateTarget({ targetId: pageTarget.targetId })` 切回，采样；
   - `finally` 里 `Target.closeTarget` 收掉空白页。
   - Arc 上 `createTarget` 实测会被搬走（`probe.mjs` 既有注释已记），**失败只打印并跳过**，
     不影响其他实测。
4. `pipAppSwitch()`：
   - 只在 `process.platform === 'darwin'` 跑；其他平台打印跳过；
   - `appBundlePath()` 从可执行文件路径截到 `.app`（截不到就用原路径，失败只打印）；
   - `open -a Finder` 切走 → 采样 → `open -a <app>` 切回 → 采样。
     用 `open` 而不是 AppleScript：后者可能触发「自动化」权限弹窗。
5. `restorePipByClick()`：仅在窗口丢失时执行；点播放器左上角（会顺带切换播放/暂停，
   在输出里注明），采样两次看是否回来。
6. 每段末尾打印一句结论：`切走时就被收走 / 切走还在但切回被收走 / 两头都还在`。

## 验证方式

- [x] `node --check tools/probe.mjs`
- [x] `make test`（148 例全绿；本轮不动 `src/mod/` 与测试，用来确认没有误伤）
- [ ] 实跑对照组：`node tools/probe.mjs --headed --keep`（Chrome for Testing），
      记录 Q1–Q5 —— **未跑**（用户取消：这一步会弹窗抢焦点，收益不足以打扰）
- [ ] 实跑实验组：退掉用户的 Arc 后 `node tools/probe.mjs --browser=arc --headed --keep`，
      记录 Q1–Q5 —— **未跑**（需要先退掉用户正在用的 Arc）
- [x] Q6 路线判断：见下

## 预期量级

1 个文件 / +170 −0 行（PLAN 文档另计）

## Definition of Done

见 AGENTS.md §6。本轮额外一条：**必须明确写出「哪些浏览器跑过、哪些没跑过」**。

## 完成情况（完成后回写）

- 执行提交：未提交（探针与 PLAN 文档待随下一次提交一起走）。

- 验证结果：

  ```text
  $ node --check tools/probe.mjs
  CHECK_OK

  $ make test
  ℹ tests 148
  ℹ pass 148
  ℹ fail 0
  ```

- 实测数据：**探针未跑**。Q1–Q5 由用户口述的实测事实回答：

  > 「切页面后，浮窗就消失了。」

  - Q1 `documentPictureInPicture` 在 Arc 里存在（窗口能开出来，说明 API 在）。
  - Q2 切到另一个标签页/页面 → **浮窗消失**（不再回来）。
  - Q3 切到别的应用 → 与 Q2 同源，按「切走即消失」处理。
  - Q4 切回来 → 无物可回。
  - Q5 未测。

- Q6 结论：**路线 A 关闭**。Document PiP 在 Arc 上的生命周期不满足「切走仍留在桌面」，
  这不是「重开时机」能修的 —— 窗口已经不在了，而 `requestWindow()` 必须有用户手势，
  切走期间没有任何手势可用。要满足该需求只能换承载方式（原生 helper 或原生 video PiP）。

- 遗留 / 与预期不符之处：
  1. 探针代码已就位但**从未执行过**，`pipTabSwitch()` / `pipAppSwitch()` /
     `restorePipByClick()` 的真实行为未验证（只过了语法与既有测试）。
     不要把它当成「已验证的工具」。
  2. 结论的粒度只到「切页面就没了」，**没有区分**是 Arc 主动关闭、还是 Arc 归档了
     opener 标签页导致文档销毁（规范 §6.6/6.7 的强制关闭）。两者的区别只影响
     「有没有零代码的系统设置可绕过」，不影响 Q6 的路线判断。
