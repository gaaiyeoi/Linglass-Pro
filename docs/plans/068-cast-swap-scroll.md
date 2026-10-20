# 068 手机字幕屏：换句改成整格连续滚动

> 状态：已完成

## 需求

三句字幕（上文 / 当前 / 下文）在 0 → 1 → 2 换句时动效不明显：中间那块只是
「淡出再淡入」，上下两行在换句的同一帧直接换字，看不出「上一句升上去、下一句
升上来」的衔接感。

## 根因

PLAN 065 v2 的 `playSwap()` 是**串行两段**，且只在 `#plate` 一个元素上做：

1. 旧句用 150ms 滑出整格（位移 = `#reel` 高度），滑完后旧句完全在窗口外；
2. `onfinish` 里才换字，新句用 210ms 从另一侧滑入。

中间存在一段窗口全空的空档，观感是「消失一下再出现」。另外：

- 位移距离虽然是一整格，但旧句滑出时窗口里没有任何参照物，看不出滚动方向；
- `#prev` / `#next` 由 `renderCtx()` 在同一帧直接改 `textContent`，边缘两行是
  「瞬变」，进一步削弱了整体滚动的印象。

## 做什么

- 在 `#reel` 里加第二块板 `#ghost`（绝对定位，与 `#plate` 叠在同一卷轴窗口内）。
- `playSwap()` 改为**并行**：旧句搬到 `#ghost` 上从 `0` 滚到 `-H`，新句在
  `#plate` 上从 `+H` 滚到 `0`，同为 260ms、同一缓动。任一进度 `p`：
  旧句底边 = `(1-p)H`，新句顶边 = `(1-p)H`，两块板始终严丝合缝地拼合，
  半途看到的是「上半截旧句 + 下半截新句」，没有空档、没有重影。
- 旧句用 `replaceChildren(...Array.from(linePrimary.childNodes))` **移动节点**
  到 `#ghost`（不是 cloneNode），注音、文节、被 `fitLine` 缩过的字号原样带过去；
  动画结束清空并隐藏。
- `#ghost` 的字号 / 颜色 / 描边由 `appearanceCss()` 按同一档位输出
  （`#line-primary, #ghost-primary` 共用一条规则），骨架规则另行补齐。
- 新增 `nudgeCtx(dir)`：`#prev` / `#next` 在同一时间窗里从 `+10px`（往回翻时
  `-10px`）淡入到原位，边缘两行也有「跟着滚了一格」的方向暗示，不再瞬间换字。

## 不做什么

- 不改 `#reel` 的裁切方式、不改上下文行的字号规格（13px）。
- 不让 `#prev` / `#next` 做真正的整格位移：它们与主字幕字号不同（13px vs 24px），
  位移 + 缩放的中间帧会糊，且会与 `#ghost` 里的同一句重影。只做轻推淡入。
- 不改选句（PLAN 067）：选句期间 `paintPick()` 会取消 `#plate` 上的动画。
- 不改推送频率、seek 命令格式。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/068-cast-swap-scroll.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
```

## 验证方式

- [x] `make test`：PLAN 065 那条断言改写（原断言「两段动画」已不再成立，语义变化
      记录在此），新增 PLAN 068 断言：`#ghost` 绝对定位叠在同一窗口、节点移动而非
      复制、`plateEl.animate` 与 `ghostEl.animate` 各一次、不再有 150ms 的滑出段。
- [x] `make build` / `make check`。
- [x] 浏览器实测（`node tools/cast-server.mjs --demo`，headless Chromium）：
      一次换句中采样到 `plateY=106 / ghostY=-17`、`85 / -38`、`65 / -58`、`47 / -76`，
      两者恒差 123px（窗口高度）；动画结束后 `#ghost` 隐藏且子节点清空，
      `#plate` transform 归 `none`；`#next` 在换句窗口内有 `translateY(10px) → 0`
      与 `opacity 0 → 1` 的动画。

## 预期量级

2 个文件，约 +110 / −50 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 提交：待提交（与 065/066/067 的改动同在工作区，按 PLAN 分别提交）
- 验证结果：`make test` 211 通过；浏览器采样确认两块板拼合滚动、结束后状态干净。
- 遗留问题与差异：
  - 新旧两句高度不同时（例如一句有译文、一句没有），`H` 取旧窗口高度，
    新句若更高会在起始帧从窗口下沿露出一点。真机上属于「下一句探进来」，
    未做特殊处理。
  - 真机 iOS 的观感（260ms 是否偏快/偏慢）未人工确认。
