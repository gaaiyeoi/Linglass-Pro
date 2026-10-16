# 025 卡顿与内存：每帧热路径、常驻定时器、落盘无上限

> 状态：**已完成**（代码与门禁绿；浏览器内行为未人工确认，见文末）

## 需求

用户报「看视频变卡，严重时标签页内存溢出崩掉」，并给了四条线索：

1. 桌面浮窗与学习面板**各自**一个 `requestAnimationFrame` 循环，每帧都调
   `track.getProgress()` → `onTimeline()` → `readLines()` → `plainText()`，而
   `plainText()` 在字幕带振假名时要 `cloneNode(true)` 整行 —— 「面板 + 浮窗同时开着」
   时同一行文本每秒被查询/克隆上百次（日语学习场景振假名常开，尤其明显）。
2. 五个模块各挂一个 `setInterval(fn, 1000)`，外加两个 `MutationObserver` 挂在同一个
   高频变动的字幕 shadowRoot 上；标签页越多，叠加越多。
3. `chrome.storage.local` 里的 `llgTrack:<videoId>` 没有条数上限、没有 TTL，只有用户
   手动点「清空」才会删；默认配额约 10MB，写满之后 `set()` 静默失败。
4. 超长视频 / 直播的 `cues` 数组与学习面板的 `<li>` 没有硬上限，随时间线性增长。

另外用户要求「弹窗字幕与 Linglass 视频内嵌字幕只留一个，开了一个就关另一个，
以节省资源」。**这条经过问询后被否掉了一半**，理由见下面「不做什么」与「根因」。

## 根因（逐条定位）

1. **每帧读 DOM（真问题，主因）**：`getProgress()` 里那次 `onTimeline()` 是**唯一**
   需要读字幕 DOM 的地方，而它被两个 rAF 循环每帧调用。`readLines()` 每次要做
   3 次 `shadowRoot.querySelector`，`plainText()` 在行内有 `<rt>` 时还要
   `cloneNode(true)` 整行再删 rt —— 每帧一次 DOM 树克隆，纯粹是喂给 GC 的垃圾。
2. **克隆的必要性本身也不成立**：同文件里已经有 `subtreeText(node, only)`，它按
   `childNodes` 递归、跳过 `RT`，得到的就是「剥掉 rt 的文本」，且**不创建任何节点**。
   两个口径完全一致（15-ja-break.js 的 `textOf()` 也要求一致），所以
   `plainText()` 根本没有理由去 clone。
3. **常驻定时器（真问题，次因）**：`10/15/30/40/50` 五个模块各一个 1s 定时器，
   做的都是「一秒看一眼」，没有任何一个需要独立时间源。
4. **落盘无上限（真问题）**：`save()` 直接 `set({ [llgTrack:<id>]: {...} })`，从不清理；
   `clear()` 是唯一会 `remove()` 的路径，且用户不会去点。
5. **cues / DOM 无上限（真问题）**：`insertCue()` 只做二分插入，从不过滤；面板
   `renderAll()` 按 cues 全量建 `<li>`。
6. **「两个字幕面同时渲染」不是卡顿主因（否掉了这条）**：视频内嵌字幕由官方组件渲染，
   它的 JS 由播放状态/翻译事件驱动，**不看自己的可见性**（实测官方产物
   `promoCards-*.js` 里的 `requestAnimationFrame` 只有「拖拽字幕位置」与
   「气泡入场」两处，没有常驻循环；`setInterval` 只有下载按钮刷新与一个播放器状态轮询）。
   把宿主 `display:none` 只省掉那层文字的合成/绘制，**不省它一行 JS**；而我们的浮窗
   仍然要读同一个 shadowRoot，成本一分不少。反过来它会带来实打实的损失：画面内字幕
   消失 = Linglass 的「点词查词」入口消失（用户明确回答「不可接受」），且
   `measureBlockHeight()` 读到 0 会让官方反复重算位置。
   所以按用户的判据（「影响不大就不隐藏」）→ **不做互斥隐藏**；「只留一个」改由
   「默认只留视频内嵌字幕」实现（见「做什么」第 6 条）。

## 做什么

1. `plainText()` 改用已有的 `subtreeText(el, null)`，不再 `cloneNode(true)`。
2. `getProgress()` 的「画面与时间轴是不是同一句」判据改用 `capture()` 缓存的
   `lastLines`（每次字幕 DOM 变化 / 每秒心跳都会刷新），**每帧零 DOM 查询**。
3. 五个 1s 定时器合并成一个：`00-shared.js` 出 `onTick(fn)`，模块按注册顺序挂上去。
4. 轨道落盘加上限与 TTL：索引键 `llgTrackIndex`（`{entries:[{key,savedAt}]}`），
   最多 30 个视频 / 30 天；超出的在 `save()` 里 `remove()` 掉；`clear()` 同步摘索引。
5. 单视频句数上限 `MAX_CUES = 5000`，超出丢最旧的（列表与导出只保留最近的 5000 句）。
6. **桌面字幕浮窗默认改为关闭**（「视频内嵌字幕优先」）。用户没表过态时不再自动开窗；
   落盘里 `enabled: true` 的老用户不受影响，控制栏按钮与设置面板开关照旧。
7. 每帧的 DOM 写入先比对再写：`pushProgress()`（浮窗进度条）与面板 `paint()` 的
   填充条都加「值没变就不碰 `style.width`」。
8. README 与代码注释里「默认开启」的口径一并改掉。

## 不做什么

- **不做**「浮窗开着时隐藏画面内字幕」的互斥开关（根因第 6 条：省不了资源，
  却会丢掉点词查词；用户回答是「性能影响不大就不可接受」）。
- **不动**官方字幕组件的可见性、不写任何页面对官方浮层的样式。
- 不改两个 `MutationObserver` 的观察范围与过滤条件 —— 它们各自服务一件事
  （轨道采样 / 句内断句），合并或收窄过滤会带来「字幕不动了」这类静默失效，
  而实测它们已经是按批回调（同一 task 内的多次改动只触发一次），不是每帧。
- 不给面板列表做虚拟滚动（本轮只保证**有上限**，不保证 5000 行滚动丝滑）。
- 不申请 `unlimitedStorage` 权限（那会改 manifest 权限面，属于另立 PLAN 的事）。
- 不动 `05-ja-segment.js` / dev 脚本 / 打包与安装脚本。

## 修改范围

```yaml
allowed_paths:
  - src/mod/00-shared.js
  - src/mod/10-subtitle-track.js
  - src/mod/15-ja-break.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/40-study-panel.js
  - src/mod/50-settings-panel.js
  - tools/test/smoke.test.mjs
  - README.md
  - docs/plans/025-perf-hot-path-and-storage-hygiene.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/05-ja-segment.js
  - src/mod/dev-reload.dev.js
  - src/mod/dev-reload.sw.dev.js
  - build.mjs
  - tools/test/contract.test.mjs
```

## 实现方案

1. **共享心跳**（`00-shared.js`）：`tickers` 数组 + 一个 `setInterval(dispatchTicks, 1000)`，
   回调抛错就地 `console.warn` 不中断其余回调；返回注销函数（本轮没人用，但
   「注册了不能撤」是设计缺陷）。
2. **轨道热路径**（`10-subtitle-track.js`）：`lastLines` 只由 `capture()` 写；
   `onTimeline()` 只读它。语义代价：最多 1 秒陈旧（心跳兜底），而字幕换行本身由
   MutationObserver 保证零延迟 —— 与旧行为在「换行那一刻」完全一致。
3. **句数上限**：`enforceCueLimit()` 在 `insertCue()` 与 `adoptSkeleton()` 之后调用；
   丢最旧的句，并清掉它在 `officialCues`（WeakSet）与 `officialByText`（Map）里的引用，
   否则 Map 会一直拽着被丢弃的句子不放（那正是「内存只涨不降」的一半原因）。
4. **落盘上限**：`readIndex()` → `pruneIndex(entries, currentKey)` → 一次
   `set({ [key]: payload, [llgTrackIndex]: keep })`，再对 `drop` 里的 key 调 `remove()`。
   索引与轨道放在**同一次 `set()`** 里：既少一次写，也让「轨道写了、索引没写」不可能发生。
5. **浮窗默认关闭**：`let enabled = false`，落盘仍读 `llgPip.enabled` 覆盖。
   文件头「常驻语义」一节与设置面板的文案同步改口径。
6. **先比对再写**：`pushProgress()` / `paint()` 各加一个上一次值的缓存。

## 验证方式

- [x] `make test` —— 新增回归用例：
  - `字幕轨道：每帧读进度不再反复查询 Shadow DOM（卡顿的根因）`
  - `字幕轨道：超长视频/直播的句数有上限（不会无限增长）`
  - `字幕轨道：落盘带上限与 TTL，超出部分真的被删掉`
  - `桌面字幕：默认关闭（视频内嵌字幕优先），没开过就不弹窗`
  - 改断言：`桌面字幕：默认开启，但要等第一次用户手势才真正开窗`（见下）
- [x] `make build`（契约校验 + 注入自检）
- [x] `make check`
- [ ] 浏览器内行为（浮窗默认不弹、开关能开回来、进度条照走）—— **未做人工确认**，如实登记

### 为什么改现有断言（AGENTS.md §3 要求写明）

1. `harness({ withPip: true })` 现在默认预置落盘 `llgPip: { enabled: true }`。
   这一批用例（十余条）测的是「开关**开着之后**的常驻行为」——窗口被 UA 收走后能不能
   靠下一次手势回来、点 X 算不算关闭……它们在旧默认值下天然成立。新默认值是「关」，
   不预置就等于测不到那批行为。**默认值本身**由新增的
   「桌面字幕：默认关闭（视频内嵌字幕优先）」覆盖，语义没有被掩盖。
2. 原 `桌面字幕：默认开启，但要等第一次用户手势才真正开窗` → 改写为
   `桌面字幕：默认关闭（视频内嵌字幕优先），没开过就不弹窗`：旧断言固化了
   PLAN 016 的旧语义（默认开启），而本轮需求就是**改掉**它（用户选择「视频内嵌字幕
   优先」）。新用例同时断言「显式打开之后照旧常驻」，避免把旧能力一起丢掉。
3. `showFurigana()` 桩件补上 `childNodes` 子树。旧桩只实现了 `cloneNode()` 那条路径
   （`primaryPlain`），而实现不再 clone —— 桩件必须描述**真实 DOM**（`<ruby>夜<rt>よる</rt></ruby>`）
   而不是某一种实现路径。文本口径（剥掉 rt）没有变，断言一个字没改。

## 预期量级

7 个文件 / +330 −60 行左右（`src/mod/**` 与 `tools/test/smoke.test.mjs` 各占一半）。

**实际**：8 个文件 / +460 −48 —— 多出来的主要是注释（每个「为什么必须这样」都写在了
代码旁，省得下次有人把它改回去）与 5 条新用例的桩件注释。量级没有跳档。

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：**尚未提交**。工作区里本来就有 PLAN 026 的未提交改动
  （`README.md` / `docs/install-guide.html` / `docs/plans/026-*.md`），本轮又改了同一个
  `README.md` —— 两者要拆成两个提交的话，得先把 026 单独提交掉。
- 验证结果（实际输出）：
  - `make test` → `ℹ tests 115 / pass 115 / fail 0`（新增 5 例，改断言 2 处，见上）
  - `make build` → `契约校验 ✓ index-BPWpLD_h.css, promoCards-P4bxe-Fj.js`；
    `注入 mod/00-shared.js → 05 → 10 → 15 → 30 → 40 → 50`
  - `make check` → `已注入 mod/00-shared.js, …, mod/50-settings-panel.js`
  - `git diff --numstat` → 8 个文件 / +460 −48（含 026 的 README 改动）
- 遗留 / 与预期不符之处（都要如实说）：
  1. **浏览器内行为未人工确认**：浮窗默认不弹、开关能开回来、进度条照走、
     学习面板照常跟读 —— Node 测不了，`make probe --headed` 也没跑。
  2. **两个 MutationObserver 一个都没减**：它们各自服务一件事（轨道采样 / 句内断句），
     删或并会带来「字幕不动了」这种静默失效；实测它们本来就是**按批**回调
     （同一 task 内多次 DOM 改动只触发一次），不是每帧。真正每帧的那份开销在
     `getProgress()` 上，已消掉。
  3. **学习面板的列表没有虚拟滚动**：只保证「有上限」（5000 行），不保证 5000 行滚动丝滑。
     正常视频几百句无感，超长直播打开面板那一下仍可能有一次性卡顿 —— 另立 PLAN 的事。
  4. `MAX_CUES` / `MAX_STORED_TRACKS` 这几个上限在用例里是**字面量**（5000 / 30 / 30 天），
     改实现常量时用例会红 —— 这是故意的，但要知道它会红。
  5. 「只留一个字幕面」只做到了**默认值**层面（浮窗默认关），没有做互斥隐藏 ——
     理由见「根因」第 6 条，用户对这条的原话是「影响不大就不可接受（画面内字幕必须始终可见）」。
