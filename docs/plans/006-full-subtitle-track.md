# 006 学习面板与导出：显示整条字幕轨（不再只显示播放过的句子）

> 状态：**已实现**（读取时机先后由 PLAN 014 与 PLAN 060 加固）

## 需求

侧边列表与导出（Markdown / SRT）目前只包含**播放过**的句子 —— 因为
`10-subtitle-track.js` 是从 Linglass 的 Shadow DOM 里「顺路采」出来的（见根因）。
期望：打开面板就能看到整条字幕（全部句子与时间戳），导出也是全部。

## 根因

- `10-subtitle-track.js` 的 `readLines()` 只读当前渲染在浮层上的那一句，
  `capture()` 在每次 DOM 变化时把它记下来 → 轨道 = 「播放过的句子集合」。
- 官方其实**一次就把整条轨取全了**，并存进 `chrome.storage.local`（实测其产物
  `vendor/linglass-1.12.3/assets/index.ts-CtsHbKHl.js`）：
  - key：`subtitle-cache:v6:{videoId}:{lang}:primary`（原/学习语言整条轨），
    索引 key `subtitle-cache:index`，值是 `{entries:[{key,cachedAt}]}`，TTL 24h，最多 50 条；
  - 值：`{cues, rawCues, mergePlan, isAsr, parts, cachedAt, videoId, primaryLang, secondaryLang}`，
    `cues[i] = {start, end, text, rawText, id}`（秒）；
  - 目标语言（母语）那一侧**不进 storage**：MT 是按块懒翻译的（只缓存已翻块），
    所以「整条译文轨」在本地拿不到 —— 这一点决定了本轮的边界（见「不做什么」）。

参考实现（EnglishXYZ 2.2.5，实测其 `web_accessible_resources.js`）：它是在 **MAIN world**
里用 `player.getPlayerResponse()` 拿 `captionTracks`，再 `POST /youtubei/v1/get_panel`
（`panelId: "PAmodern_transcript_view"`，参数是手写 protobuf）取整条 transcript，
失败则退回 `baseUrl`（带 `pot`）+ XML。那条路要注入 MAIN world、要复刻 YouTube 的
protobuf 参数，代价与失效风险都高得多 —— 本轮不走。

## 做什么

- `10-subtitle-track.js` 增加「骨架」数据源：
  - `loadSkeleton()`：`chrome.storage.local.get('subtitle-cache:index')` → 过滤出
    `subtitle-cache:v6:{当前 videoId}:…:primary` 的候选（按 `cachedAt` 降序）→ 读第一个
    存在的 key → 映射成轨道格式 `{start, end, primary: text, secondary: ''}`。
  - 载入时机：换视频后（`loadForCurrentVideo`）+ 首次采到直播字幕时；每个视频最多重试
    若干次（Linglass 可能在页面加载后才写缓存），用计数器限流，绝不在心跳里反复读 storage。
  - 只有**文字完全对不上**时才换下一个候选 key（避免拿到另一种学习语言的轨）。
- 合并规则（骨架优先）：
  1. 骨架 cue 是权威的 start/end 与原文；
  2. 直播采到一句时，先按**归一化文本**在骨架里找同一句，找到就填 `secondary`
     （骨架缺 `primary` 时也补上），**不改它的 start/end**；
  3. 文本找不到就退化为「时间落在 `[start-tol, end+tol]` 内且最近」的骨架句；
  4. 两者都没命中（骨架里没有这句，例如新上传视频的缓存过期）→ 按旧逻辑插入新句。
- 面板：
  - 列表与导出都走合并后的同一条轨道（骨架一到就整体重绘）；
  - 头部副标题从「N 句」变成「N 句 · 译文 x/N」（x = 已有 `secondary` 的句数），
    让「整条轨已就位、译文还在追」这件事对用户可见；
- 骨架缺失 / 读失败 / 视频没有字幕缓存时，**完全退回旧行为**（只记录播放过的句子），
  不报错、不空转。
- 测试：
  - 冒烟：骨架载入后 `getCues()` 就是整条、导出包含未播放句、译文按文本匹配填上、
    文本对不上时按时间匹配、骨架缺失时回退旧行为；
  - 契约：`subtitle-cache:v6:` 与 `subtitle-cache:index` 登记进 `LINGLASS_CONTRACT`
    （官方改 key 名时构建期就能发现）。

## 不做什么

- **不翻译没看过的句子**：母语译文仍然只来自 Linglass 的实际渲染，未观看的句子导出的
  译文留空（这一条写进 README 的「已知限制」）。不新增任何网络请求。
- 不注入 MAIN world、不调 YouTube 的 `get_panel` / `captionTracks`、不调 Linglass 的服务端
- 不读 `yt-mt-cache:v2:*`（另一套按块缓存的译文）—— 留作后续 PLAN（见遗留）
- 不做逐词时间轴（`parts` / `words` 不用）
- 不做虚拟滚动 / 分页（整条轨上千行时列表一次性渲染，性能影响登记为已知限制）
- 不改浮窗（`30-desktop-subtitles.js`）、不改导出格式（Markdown frontmatter 与 SRT 语法不动）
- 不改 `chrome.storage` 里官方那批 key（只读，绝不写/删）

## 修改范围

```yaml
allowed_paths:
  - src/mod/10-subtitle-track.js
  - src/mod/40-study-panel.js
  - tools/test/smoke.test.mjs
  - tools/test/contract.test.mjs
  - README.md
  - docs/plans/006-full-subtitle-track.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/00-shared.js
  - src/mod/30-desktop-subtitles.js
  - src/mod/50-settings-panel.js
  - build.mjs
  - Makefile
```

> `40-study-panel.js` 只允许改 `updateMeta()` 的副标题文案；其余面板代码若与之冲突，
> 由 005 负责（两份 PLAN 不同时执行）。

## 实现方案

1. `10-subtitle-track.js` 增 `SKELETON_PREFIX` / `SKELETON_INDEX_KEY` / `SKELETON_TOLERANCE_S`；
   `skeleton = { keys, tries, cues }` 状态机，`loadSkeleton()` 幂等且限次。
2. `mergeSkeleton(cues)`：骨架 cues 与既有 live cues 合并（文本匹配优先、时间匹配兜底），
   结果按 `start` 升序，保持 `insertCue` 的既有语义。
3. `openCue()` 分岔：有骨架时走「填充」路径，无骨架时走旧的 `insertCue` 路径。
4. `closeActive()` / `extendActive()`：骨架 cue 不改写 end（官方 end 更准）；
   标记方式用模块内 `WeakSet`（不往 cue 上挂会被落盘的字段）。
5. `finalizedCues()`：骨架 cue 的 `end` 优先，不做「夹到下一句 start」的降级
   （除非真的越界）。
6. `getCuesForExport`/`snapshot`/持久化沿用；`llgTrack:{videoId}` 里的合并结果照常落盘
   （骨架的完整副本，离线也能导出）。
7. `40-study-panel.js`: `updateMeta()` 加译文进度。
8. 测试与合同登记。

## 验证方式

- [ ] `make test`（新增用例：
      「字幕轨道：骨架提供整条轨，导出包含未播放句」
      「字幕轨道：直播句按文本匹配填译文，不改骨架时间」
      「字幕轨道：拿不到骨架时退回旧行为」）
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认（`make probe --headed`）：面板打开即列出整条轨；
      播放时译文逐句填上；导出文件行数 = 整条轨句数
- [ ] `node tools/probe.mjs --no-checks` 的 `subtitle-cache` 段用来核对缓存结构没变

## 预期量级

5 个文件 / +220 −30 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：
- 验证结果（贴实际输出）：
- 实测结论（缓存里到底有什么、骨架句数与直播句的匹配率）：
- 遗留 / 与预期不符之处：
