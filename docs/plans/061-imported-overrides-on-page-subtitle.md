# 061 导入的译文覆盖画面里的字幕行

> 状态：**已完成**（浏览器人工确认未做，见「完成情况」）
>
> 编号说明：原为 050，与 `050-copy-without-furigana.md` 重复，2026-10-20 改为 061。

## 需求

导入译文 SRT 之后，**视频画面里的字幕**也应该显示导入的译文，而不是 Linglass 自己翻的那句
（用户口径：「导入了 好像还是没有覆盖原来的 YouTube」）。

## 根因

不是导入失败。本机 `chrome.storage.local` 实测（2026-10-19）：
`llgTrack:RYlmJUAIGtM` 里有大量 `"origin":"imported"`，译文确实贴回并落盘了。

没覆盖画面是 **PLAN 031 明确划下的边界**：

> 不覆盖官方画面里那层字幕（用户明确要求）。我们的三个出口 —— 桌面字幕浮窗、
> 学习面板、导出 —— 用自己的译文；官方 Shadow DOM 一律不碰。

现在需求反转：导入的译文要成为画面里那行译文的来源。官方那层字幕是
`#linglass-subtitle-overlay` 的 shadowRoot 里的
`.subtitle-group > .subtitle.subtitle-primary / .subtitle.subtitle-secondary`，
其中 `subtitle-secondary` 是**纯文本节点**（vendor 的 `updateSecondary()` 直接写
`secondaryElement.textContent`），没有 `linglass-word` 那套按字符切片的 DOM ——
所以替换译文行的文本不会破坏官方的点词/拖选（那只发生在 primary 行）。

## 做什么

- 新增 `src/mod/16-imported-subtitle.js`（注入顺序由文件名决定：10 → 12 → 15 → **16** → 30）：
  - 监听官方字幕 shadowRoot 的变化（`MutationObserver`），并在共享心跳里兜底重绑
    （官方重建播放器会换一棵 shadowRoot）。
  - 当前句满足「`origin === 'imported'` 且有译文」时，把 `.subtitle-secondary` 的文本
    换成导入的译文，并在官方把它隐藏（`display:none`）时重新显示（`inline-block`）。
  - **先比对再写**：文本相同、或本来就是可见状态时不写 DOM（仓库铁律：对挂了
    MutationObserver 的树无脑赋值会把自身打成死循环）。
  - 句间空档（`currentTime >= cue.end`）与非导入句一律**不碰**：那种情况交给官方
    自己隐藏/显示，避免把上一句译文留在画面上。
  - 官方仍有译文时也覆盖（用户要的就是「以导入的为准」）；`origin` 已经是
    PLAN 031 建立的优先级标记，不需要新状态。
- `tools/test/imported-subtitle.test.mjs`（新增，纯 vm 沙箱）：
  1. 导入句 → 译文行被替换且从隐藏变可见；
  2. 非导入句 → 官方文本一个字都不动；
  3. 句间空档 → 不写（官方自己会收）；
  4. 官方重渲染覆盖了我们的文本 → 观察器回调后重新覆盖；
  5. 官方重建 shadowRoot → 心跳重绑后仍然生效。
- `README.md`：学习面板 / 离线翻译一节补一句「导入的译文会直接替换画面里的译文行」。
- `tools/test/smoke.test.mjs`：harness 不必加载本模块（它只碰官方 DOM，沙箱里已有桩），
  保持现状。

## 不做什么

- **不改 primary 行**：原文、振假名、点词与拖选全部保持官方原样（PLAN 010 / 015 的口径）。
- 不改浮窗与学习面板（它们本来就读 `track` 的译文）。
- 不做「导入后自动关闭官方字幕」：只替换译文行，原文行继续由官方渲染。
- 不新增设置开关：规则就是「有导入译文就用导入译文」，与 PLAN 031 的优先级一致。
- 不改导出格式、不写官方 `subtitle-cache:*`。
- 不处理 YouTube 自带的 CC（那是另一个开关；如果用户同时开了 YouTube 原生字幕，
  两层会同时出现，需要用户自己关掉原生 CC）。

## 修改范围

```yaml
allowed_paths:
  - src/mod/16-imported-subtitle.js
  - tools/test/imported-subtitle.test.mjs
  - README.md
  - docs/plans/050-imported-overrides-on-page-subtitle.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/05-srt.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - build.mjs
```

## 实现方案

1. 取 `globalThis.__llgModTrack`；没有就报错退出（与其它模块同款）。
2. `bind()`：`document.getElementById('linglass-subtitle-overlay')?.shadowRoot`，
   换树就重挂 `MutationObserver`。
3. `paint()`：
   - `cue = track.getCurrent()`；`cue.origin !== 'imported'` 或没有 `secondary` → 返回；
   - 读 `<video>.currentTime`，`time >= cue.end` → 返回（空档）；
   - 取 `.subtitle.subtitle-secondary`；文本不同才写；`display === 'none'` 才改。
4. 启动：`bind(); paint();`，`track.subscribe(paint)`，`shared.onTick(() => { bind(); paint(); })`。
5. 测试与 README。

## 验证方式

- [x] `node --test tools/test/imported-subtitle.test.mjs`（6 例）
- [ ] `make test`：本次新增用例全绿；**另有 1 条桌面字幕用例在红**，属于行内未提交的
      PLAN 047 改动（详见「完成情况」），与本模块无关
- [x] `make build` / `make check`
- [ ] 浏览器人工确认：导入译文后，画面里原有译文被替换；拖到没导入的句子恢复官方译文；
      间隙不残留上一句

## 预期量级

4 个文件 / +220 −10 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区同时有 PLAN 047 / 048 / 049 的改动，按「一个 PLAN 一个提交」分开收）
- 验证结果（实际输出）：

  ```text
  $ node --test tools/test/imported-subtitle.test.mjs
  ℹ tests 6   ℹ pass 6   ℹ fail 0

  $ make build
  [build] 契约校验  ✓  index-BPWpLD_h.css, promoCards-P4bxe-Fj.js
  [build] 注入      … → mod/15-ja-break.js → mod/16-imported-subtitle.js
                    → mod/30-desktop-subtitles.js → …

  $ make check
  已注入  …, mod/16-imported-subtitle.js, …

  $ make test
  ℹ tests 192   ℹ pass 191   ℹ fail 1
  ✖ 桌面字幕：换句时给滚轮动效打方向标记，改外观不滚
    （'up' !== 'down'）
  ```

- 遗留 / 与预期不符之处：
  1. **那条红的是行内未提交的改动**：`30-desktop-subtitles.js` 有 634 行未提交改动、
     `smoke.test.mjs` 有 976 行未提交改动（PLAN 047 液态玻璃 + 滚轮方向），断言在
     `smoke.test.mjs:3464`。本模块（16）**没有被 smoke harness 加载**，不可能影响它。
  2. **浏览器人工确认没做**：需要重载 `dist/`，在已导入译文的视频上看画面译文行是否被替换。
  3. 如果画面上同时还有 **YouTube 原生 CC**（播放器右下角 CC 按钮），那是另一层，
     本模块不负责关它；两层同时出现时请关掉原生 CC。
  4. 用户如果在官方设置里关掉了「双语」，本模块仍会把导入的译文行显示出来 ——
     这是「导入即覆盖」的直接后果，暂不另设开关。
