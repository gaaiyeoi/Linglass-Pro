# 044 AI 翻译：贴不上轨道的句子与整片模式重试

> 状态：**已移除**（PLAN 048 下线页面内 AI 翻译；正文留档）

## 需求

真实长播客（476 句、勾选「整片放进上下文」）跑完后状态行是：

```text
已贴 456 / 476 句，20 句没翻成，其中 20 句没贴到轨道上，最近一次原因：条数不符（期望 20，实际 15）
```

这行字给出三条信息，但其中一条是**假的**：

1. `failed == missedAxis == 20` 说明这 20 句**模型已翻好**，失败发生在最后一步
   `applyTranslations` —— 按 `start` 在当前轨道里找不到对应句（容差 0.05s）。
2. 「最近一次原因：条数不符」是**陈旧**信息：`lastReason` 只在 `lines == null`（解析失败）
   时更新，贴不上时不会更新。它来自该批更早一次整片模式的失败，不是最终原因。
3. 该批之所以更早失败过，是因为整片模式**任意一次**失败就把 `wholeMode` 永久置为
   `false`，后面所有段都退回分段上下文 —— 用户为「整片」付了输入成本，只享受到第一段。

## 做什么

- 贴回前先解析一次 `start`：当前轨道里找不到就用**原文文本唯一匹配**兜底
  （轨道被官方重新断句 / 骨架重建后，`start` 会变但原文还在；重复文本一律不用，
  贴错比不贴更糟）。
- 贴不上时更新 `lastReason`，让汇总里的「最近一次原因」反映真实原因，而不是陈旧的解析错误。
- 整片模式下出现「条数不符」（模型合并相邻句）时，先在**整片模式**下换编号对象重试一次；
  仍失败或本来就是上下文超限（400）才退回分段。
- 翻译开始时记一次原文轨指纹，结束时比对：不一致且在汇总里说明
  「原文轨在翻译期间变了（换视频 / 官方重新断句）」，解释为什么会有贴不上的句子。

## 不做什么

- 不放宽 `0.05s` 的 `start` 容差（容差放大会把译文贴到隔壁句，错位比缺失更糟）。
- 不改 `applyTranslations` / `srt.planImport` 的既有语义（导入 SRT 的行为保持不变）。
- 不做「自动续翻失败的批」，那是 034 遗留第 2 条，另立 PLAN。
- 不改 `06-ai-translate.js` 的 prompt 与解析判据；「条数不等就判失败」这条底线不动。

## 修改范围

```yaml
allowed_paths:
  - src/mod/40-study-panel.js
  - tools/test/smoke.test.mjs
  - docs/plans/044-ai-translate-missed-cues.md
  - docs/plans/034-ai-translate-with-own-key.md

forbidden_paths:
  - vendor/**
  - dist/**
  - src/mod/06-ai-translate.js
  - src/mod/10-subtitle-track.js
  - src/mod/05-srt.js
```

## 实现方案

1. `resolveAssignments(job, lines)`：先扫一次当前轨道的 `cue.start`，命中（≤0.05s）
   直接用；未命中再查「原文 → 唯一 cue」的索引；两者都不中计入 `unresolved`。
2. 汇总里 `missed = assignments.length - applied + unresolved.length`；
   `unresolved` 非空时把 `lastReason` 换成「轨道上找不到对应原文」。
3. 整片模式重试：`whole && countIssue` → 用 `{indexed:true}` 带全片重试；
   仍失败才 `wholeMode = false` 并用分段重试（每次失败最多多花一次请求）。
4. 指纹：开始时 `srt.fingerprint(cues)`，结束时 `srt.fingerprint(track.getCues())`，
   `sameFingerprint` 为 false 时在汇总末尾加一句说明。

## 验证方式

- [ ] `node --test tools/test/smoke.test.mjs`（新增 3 例：整片编号重试、文本唯一兜底、
      贴不上时原因不再陈旧）
- [ ] `make test` 全绿
- [ ] `make build` + `make check`
- [ ] 浏览器人工确认：真实长播客整片模式跑一轮（本次不做，如实登记）

## 预期量级

3 个文件 / +180 −40 行

## Definition of Done

见 AGENTS.md §6。

## 完成情况（完成后回写）

- 执行提交：未提交（工作区另有 030s~043 的未提交改动，不混在一起）。
- 验证结果：
  - `make test` → `tests 183 / pass 183 / fail 0`。
  - `make build` → 基线 `vendor/linglass-1.12.4`，契约校验 ✓，注入顺序正常。
  - `make check` → 已注入 10 个 mod 脚本，无残留告警。
- 实际量级：2 个源文件 + 1 个 PLAN（`40-study-panel.js` +100 −20 左右，
  `smoke.test.mjs` +150）。比预期多了「start 撞车」的处理：轨道整体平移后，
  批次里某句的旧 start 可能正好等于另一句的新 start，直接按 start 命中会贴错，
  所以改成「start 命中但原文对不上时，以唯一原文为准」。
- 遗留 / 与预期不符之处：
  1. 真实长播客（真实 Key）**没有**跑过，浏览器内行为仍未人工确认。
  2. 指纹只看「句数 + 首句 + 末句」，官方重新断句但首末句不变时检测不到；
     这类情况仍由「原文唯一匹配」兜底，而不是靠提示。
  3. 官方重新断句后如果原文被合并/改写，文本匹配也会落空，这些句子仍会报「没翻成」。
