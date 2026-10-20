# 066 手机字幕屏：上下文行的中文忽隐忽现

> 状态：已完成

## 需求

上下两句（上文 / 下文预览）的中文字幕经常消失，随后又突然出现，观感割裂。

## 根因

三处各自都会造成「中文闪没」，叠在一起就是现在看到的现象。

### 1. `castLines()` 的缓存把「相邻句还没有译文」的帧存住了

`src/mod/30-desktop-subtitles.js::castLines()` 用单槽缓存，key 只包含当前句的
`index / primary / secondary / dual / tokens`，**不含相邻句的 `secondary`**。

而相邻句的译文是「播放到它之后才补进轨道」的（同文件 `contextCue()` 的注释已说明）。
于是：

- 第一次计算时 `prev.secondary === ''` 被缓存；
- 之后译文补进轨道，但 key 没变 → 继续返回缓存里的空译文；
- 手机上那句中文要么一直不出现，要么等到下一次换句（key 变了）才突然冒出来。

### 2. `frameKey()` 没把相邻句译文算进指纹

`src/mod/35-cast.js::frameKey()` 的字段与快照并非一一对应：漏了 `prev / next` 的
`secondary`。播放中靠 `Math.round(currentTime * 2)` 还能在 0.5s 内重推，
**暂停时 currentTime 不变**，相邻句译文补进来也永远不会推给手机。

### 3. 手机端单帧空值就立即隐藏

`tools/cast-page.mjs::renderCtx()` 直接 `toggle('hidden', !primary)`、
`toggle('hidden', !secondary)`。换句那一拍 `track.getCurrent()` 可能短暂为 null
（或新句还没采到译文），这一帧就把整行收起来，下一帧又展开 → 闪一下。

## 做什么

- `src/mod/30-desktop-subtitles.js`
  - `castLines()` 先算 `prev / next`，把它们的 `secondary` 纳入缓存 key，并复用同一份结果；
- `src/mod/35-cast.js`
  - `frameKey()` 增加 `current.index ± 1` 的 `secondary`，暂停时也能感知；
- `tools/cast-page.mjs`
  - `renderCtx()` 增加 `slot` 与 `ctxMemo`：
    - 同一句（`primary` 未变）且新帧没带译文时，沿用上一次的译文；
    - 整块延迟 260ms 再收起，换句瞬间的空帧不隐藏；
- 测试
  - `smoke.test.mjs`：相邻句译文补进轨道后，`castLines()` 必须返回新值（不能命中旧缓存）；
  - `cast-page.test.mjs`：粘性译文、延迟收起、两个槽位各自记忆。

## 不做什么

- 不伪造译文：某句确实还没被播放过时，就是不显示（`contextCue()` 的既有边界）。
- 不改 `castLines()` 的分词、注音与段落结构。
- 不改手机端的外观、排版与换句动效。

## 修改范围

```yaml
allowed_paths:
  - src/mod/30-desktop-subtitles.js
  - src/mod/35-cast.js
  - tools/cast-page.mjs
  - tools/test/smoke.test.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/066-cast-context-secondary-flicker.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/10-subtitle-track.js
  - src/mod/50-settings-panel.js
  - tools/cast-server.mjs
  - tools/cast-control.mjs
  - build.mjs
  - Makefile
```

## 验证方式

- [x] `make test`
- [x] `make build` / `make check`
- [ ] 真机确认（未做）：连续播放时上下句中文不再闪烁；换句瞬间不整行消失

## 预期量级

6 个文件 / +70 −10 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 执行提交：未提交
- 验证结果：

  ```text
  $ make test
  ℹ tests 211   ℹ pass 211   ℹ fail 0

  $ make build / make check
  契约校验通过，注入 11 个模块
  ```

  新增回归：
  - `castLines()` 在 `cues[0].secondary` 被补上后返回新对象，`prev.secondary` 立即可见；
  - 手机页包含 `ctxMemo` / 换句才清空译文 / 260ms 延迟收起 / 两个槽位。

- 遗留问题与差异：
  1. 真机未验证。
  2. 「下一句还没被播放过」时仍然只有原文 —— 这是轨道的数据边界，不是缓存问题；
     粘性只在同一句内生效，换句后该空还是空。
  3. 需要重载扩展（`30` / `35` 属内容脚本）+ 重启 `make cast`（手机页也改了）。
