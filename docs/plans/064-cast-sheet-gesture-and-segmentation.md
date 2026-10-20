# 064 手机字幕屏：设置页误触选句 + 分词默认打开

> 状态：执行中

## 需求

1. 打开手机字幕屏的「字幕设置」后，在面板里滑动会触发「滑动选句 / seek」，属于误操作。
2. 手机上的分词组（文节之间的间距）应当默认显示。

## 根因

### 设置页滑动误触选句

- 选句手势挂在 `document` 上（`tools/cast-page.mjs` 的 `onPickStart / onPickMove / onPickEnd`）。
- `onPickStart` 里已经判断了 `ev.target.closest('#controls, #gear, #sheet')` 并 `return`，
  但**只 return 了这一次事件**：`pickStartY / pickTravel` 仍是上一次手势留下的值。
- 紧跟着的 `onPickMove` 没有任何屏蔽，拿当前 `clientY` 减去旧 `pickStartY`，
  得到一个很大的 `dy` → 直接 `openPicker()` 并翻句、松手后 `commitPick()` seek。
- 证据：`onPickStart` 的 `closest` 判断之后没有重置状态；`onPickMove` 首行只判断
  `touches` 数量。

### 分词默认打开

- 手机屏的 `segments` 来自 `30-desktop-subtitles.js::castLines()`，它调用
  `cuePoints()`；后者在 `jaBreak.isEnabled()` 为假时返回空数组 → 整句只有一段。
- 也就是说手机端的段间距被「视频内断句」开关绑死了。手机上并没有那个按钮，
  用户无法单独打开，默认看起来就是「没有分词」。

## 做什么

- `tools/cast-page.mjs`
  - 新增 `pickBlocked`：`touchstart` 落在 `#controls / #gear / #sheet` 时置位，
    `touchmove / touchend / touchcancel` 整段跳过（不只是跳过 start）。
  - 设置面板「显示」区新增「分词」开关（默认显示），关掉时只把 `.llg-seg` 的
    6px 间距归零（`.kline.no-seg`），文本流不变。
- `src/mod/30-desktop-subtitles.js`
  - 抽出 `segmentPoints()`：只问 `05-ja-segment`，不看开关。
  - `castLines()` 改用 `segmentPoints()`：手机端始终分词，不再跟随视频内断句开关。
  - `primaryParts(text, givenPoints)` 允许外部传入切点，避免二次计算。
- 测试
  - `tools/test/cast-page.test.mjs`：手势屏蔽三条、分词开关默认值；
  - `tools/test/smoke.test.mjs`：断句开关关闭时 `castLines()` 仍返回多段。

## 不做什么

- 不改手机端选句手势的灵敏度与 seek 时机。
- 不改视频内字幕的断句开关语义（浮窗与视频内仍跟随开关）。
- 不改 `llgJaBreak` 的已存值（不覆盖用户显式关闭的选择）。
- 不动 `vendor/`、`dist/`、`tools/cast-server.mjs`、`tools/cast-control.mjs`。

## 修改范围

```yaml
allowed_paths:
  - tools/cast-page.mjs
  - src/mod/30-desktop-subtitles.js
  - tools/test/cast-page.test.mjs
  - tools/test/smoke.test.mjs
  - docs/plans/064-cast-sheet-gesture-and-segmentation.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/15-ja-break.js
  - src/mod/05-ja-segment.js
  - tools/cast-server.mjs
  - tools/cast-control.mjs
  - build.mjs
  - Makefile
```

## 实现方案

1. `onPickStart` 先复位 `pickBlocked`，再判断目标是否在面板 / 控制条内；命中就置位并返回。
2. `onPickMove` 首行 `if (pickBlocked) return;`；`onPickEnd` 清标记并直接返回。
3. 手机设置新增 `seg` 偏好（`value.seg !== false`，默认 true），`applyPrefs()` 切 `.kline.no-seg`。
4. `castLines()` 用 `segmentPoints()`；`cuePoints()` 保留给浮窗 / 视频内，语义不变。

## 验证方式

- [ ] `make test`
- [ ] `make build` 与 `make check`
- [ ] 真机确认（未做就如实写）：设置面板里上下滑动只滚动面板，不翻句、不跳进度
- [ ] 重启 `make cast` + 重载扩展后，手机分词间距默认出现

## 预期量级

5 个文件 / +90 −10 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交
- 验证结果：

  ```text
  $ make test
  ℹ tests 206   ℹ pass 206   ℹ fail 0

  $ make build
  [build] 契约校验  通过
  [build] 版本      1.12.901

  $ make check
  已注入  mod/00-shared.js … mod/50-settings-panel.js
  ```

  浏览器内（390×844，CDP 模拟触摸）：
  - 在 `#sheet` 上从 y=600 滑到 200（400px）：`pickerOpen=false`、`sheetOpen=true`
    —— 修复前这个位移足以直接翻句并 seek。
  - `#line-primary` 的父级 class 为 `kline`（无 `no-seg`），`.llg-seg` 3 段，
    设置里「分词 → 显示」为 active。

- 追加（同一需求）：`SEGMENT_GAP_PX` 6 → 10。6px 在 36px 原文里只占字宽的 1/6，
  真机上几乎看不出词组分界；10px 才能一眼分出「昨日 / 買った / 本を / 読む」。
  390×844 预览确认间距与注音分组都清楚了。

- 遗留问题与差异：
  1. 真机未验证：设置面板的滚动与选句手势的边界仍需 iPhone 确认。
  2. 手机端分词默认开是**发送端**的行为，需要重新 `make build` 并在
     `arc://extensions` 刷新扩展；只重启 `make cast` 不生效。
  3. 手机设置的「分词 → 隐藏」只去掉段间距，不重新切分（切点来自扩展）。
