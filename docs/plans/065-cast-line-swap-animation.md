# 065 手机字幕屏：换句动效（歌词式滚动）

> 状态：已完成（v2：改为原字幕板上滚动，不再复制覆盖层）

## 需求

换句是瞬间替换，连续看时「啪」地跳一下，容易丢失当前句。希望像歌词一样滚动切换。
v2 追加约束：动效必须做在原来的字幕板上，不要另外渲染一层覆盖物。

## 做什么

### v1（已废弃）

克隆 `#plate` 成固定定位的 ghost 做离场动画。问题：body 下会短暂出现第二块字幕板，
属于额外覆盖层，且复制了 `#plate / #line-primary / #fill-primary` 的 id。

### v2（当前）

- `tools/cast-page.mjs`
  - 新增 `#reel` 包住 `#plate`：`overflow: hidden`，高度跟随字幕板，作为歌词滚动窗口；
    译文的下边距（16px）从 `#plate` 移到 `#reel`；
  - `playSwap(cur, dir)` 只动 `#plate`：
    1. 旧句整块向上一格（`translateY(-reelHeight)`，往回翻时向下），150ms，
       滚出窗口的部分被 `#reel` 裁掉；
    2. 同一帧换掉板上文字并重排（`applyLineText`），新句从另一侧滚回原位，210ms；
  - 没有 `cloneNode`、没有 ghost、DOM 里始终只有一块字幕板；
  - `prefers-reduced-motion: reduce` 时不做滚动，直接换句；
  - 220ms 内连续换句直接切，并取消未播完的动画。
- `tools/test/cast-page.test.mjs`
  - 断言：不存在 `makeGhost` / `cloneNode`；存在 `#reel` 且 `overflow: hidden`；
    `plateEl.animate` 恰好两处；有 `getAnimations()` 取消逻辑。

## 不做什么

- 不改换句判定（PLAN 062 的 `cueClock.text`）。
- 不改进度条、控件、字号与排版。
- 不引入 CSS transition 改高度（会触发布局），只用 `transform`。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-page.mjs
  - tools/test/cast-page.test.mjs
  - docs/plans/065-cast-line-swap-animation.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/**
  - tools/cast-server.mjs
  - tools/cast-control.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. `#reel`（裁剪窗口）→ `#plate`（字幕板）。
2. `playSwap` 读 `#reel` 的高度作为滚动距离；旧句滚出后在同一帧替换文本，
   再让新句从 `dir * nextHeight` 滚回 0。
3. `applyLineText` 负责原文、译文与 `fitBothLines`（自适应一行）。

## 验证方式

- [x] `make test` / `make build` / `make check`
- [x] CDP：换句瞬间 DOM 只有一个 `#plate`，`#plate` 的 transform 为 `translateY(-114.8px)`，
      `#reel` 高度 123px（即滚了一整块）
- [ ] 真机确认滚动观感（未做）

## 预期量级

3 个文件 / +70 −35 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况

- 执行提交：未提交
- 验证结果：

  ```text
  $ make test
  ℹ tests 209   ℹ pass 209   ℹ fail 0

  $ make build / make check
  契约校验通过，注入 11 个模块
  ```

  CDP（390×844，动画临时拉长到 2500ms 观测）：
  `#plate` 数量 1、`body > #plate` 数量 0；transform `translateY(-114.8px)`；
  `#reel` 高度 123px。

- 遗留问题与差异：
  1. 真机手感未验证（150/210ms，语速快时是否够跟）。
  2. 换句瞬间（旧句滚出 → 新句滚入）由同一帧衔接，理论上无空白帧；
     若真机看到闪一下，需要改成双槽位轨道（旧句/新句各占一层）。
  3. 220ms 内连续换句直接硬切，不排队。
