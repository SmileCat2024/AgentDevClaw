# Coder 自适应接续策略：三选一配置与产品层验证

日期：2026-10-18
状态：已实施（本文档为实施记录）

## 背景与目标

coder 是线程宿主（ADR-0025），上下文过阈值时经 `ContextRotationTriggerFeature` → `thread-rotation.rotate()` 自动接力。原实现硬编码「trim + 追加摘要」组合策略（框架 `TrimTranscriptWithSummaryTransformation`）。

本次引入自适应接续策略并在 coder 上作为产品层验证，同时保留纯 trim 与纯摘要，三选一在智能编码空间设置窗的 Coder 策略分页配置（UI 形态照进程模式页的 `ph-pm-card` 单选卡片，未新增控件）。

## 设计定案（拷问收敛结果）

| 决策点 | 定案 |
|---|---|
| 实现归属（Q1） | 产品层编排（Claw `server/context-continuity/adaptive-rotation.js`）；引擎原语在框架侧；验证后视结果下沉框架官方变换 |
| 纯 trim 语义（Q2） | trim 系一律保最近 5 次工具调用（`keepRecentToolCalls`），不追求「纯粹」 |
| 默认与去留（Q3） | 默认 = 自适应；组合模式退出 coder 自动接力路径，代码保留（手动精简页、编程小助手仍用） |
| 口径与次数（Q4） | 字符总量比（content + toolCalls JSON，对称计量器）+ 一次性阶梯（摘要追加后不复测） |
| 失败语义（Q5） | 升级档摘要 LLM 失败 → rotation_failed，不引入隐式降级（与组合模式同语义） |

### 自适应阶梯

1. 进程内按「trim + keepRecentToolCalls=5」跑框架引擎（`buildTrimmedSeedMessages`，纯函数、零 LLM 成本）得试探 seed；
2. ratio = 试探 seed 字符总量 ÷ 原始消息字符总量：
   - ratio ≤ 0.5 → **trim 档**（`exportHistoryOnlyHandoffPackage`，内部重跑同策略 trim，确定性同结果）
   - 0.5 < ratio ≤ 0.8 → **trim+追加摘要档**（框架官方 `runTrimTranscriptWithSummary` + `writeTrimWithSummaryHandoffPackage`，不另写组合逻辑）
   - ratio > 0.8 → **纯摘要档**（`exportSummarizedHandoffPackage` 九段式，试探 seed 弃用；不保留任何消息——保 5 是 trim 系特征）
3. 非有限 ratio 视为 0（空上下文归 trim 档）；试探策略与 trim 系落盘策略同面（含 continuity 装饰），「测一套、写一套」分叉不存在。

参数 5 / 0.5 / 0.8 为常量（`ADAPTIVE_DEFAULTS`），不进配置页，试验反馈后再议参数化。

## 声明驱动的策略面（试验不波及其他宿主）

- 配置项：`PERMISSION_ITEMS.contextRotationStrategy`（枚举 adaptive / trim / summary），coder `metadata.json` permissions 声明 + `permissionDefaults: { contextRotationStrategy: "adaptive" }`，`resource_policy` 存储（与 maxLiveRuntimes 同链路）。
- 生效值判定链（与通知设置同构）：用户覆盖（resourcePolicy）> 作者默认（metadata permissionDefaults）> 'adaptive'。
- 未声明该权限项的线程宿主（如 memo）→ 解析为 null → 维持组合语义，行为不变。
- 策略在 `rotate()` 时现读（`resolveRotationStrategy` 由 server.js 注入），改配置对下一次接力即时生效，无需重启。
- 解析器异常 → 告警 + 回退组合语义（不因配置读取失败挂掉接力）。

## 改动清单

**框架仓（AgentDev，开发态 junction build 即生效）**

- `packages/core/src/core/continuity/transforms/trim-transcript.ts`：`normalizeExportPolicy` 新增 `keepRecentToolCalls`（保最近 N 个工具调用对：assistant 调用消息 + 按 toolCallId 配对的 tool 结果，其余照常折叠；默认 null 不影响既有调用方；`Infinity` 全量保护）。与 `keepRecentSkillInvokes`（技能专用）并存，未做泛化合并。
- 框架单测：`trim-transcript.test.ts` 新增 3 用例（保护最近 N 对、边界 N=1、与技能保护正交），32 用例全绿。

**Claw 仓**

- `server/context-continuity/adaptive-rotation.js`（新）：阶梯常量、`measureMessagesCharTotal`（对称计量器）、`decideAdaptiveTier`（纯函数）、`runAdaptiveRotationHandoff`（试探 + 三分派，三档全部复用既有产物路径，不落盘不改产物 schema；executors 参数为测试缝）。
- `server/context-continuity/session-handoff-helpers.js`：`exportContextHandoffForSession` 新增 `adaptive` 分支 → `runAdaptiveRotationHandoff`；结果附 `adaptive: { tier, ratio }` 供血缘与看板回看。
- `server/thread-control/thread-rotation.js`：`resolveRotationStrategy` 注入（依赖由 server.js 提供）+ `buildRotationHandoffOptions` 四路分派（adaptive / trim / summary / null→组合）。
- `server.js`：装配 `resolveRotationStrategy`（discoverAgents 作者默认 + readWorkspaceResourcePolicies 用户覆盖）。
- `server/shared/permission-registry.js`：`contextRotationStrategy` 枚举项。
- `prebuilt-agents/official/coder/metadata.json`：permissions 声明 + permissionDefaults。
- `public/src/modules/ph-model-config.js`：Coder 策略分页渲染三张策略卡（`ph-pm-card` + `ph-pm-radio`，形态照进程模式页）+ `phSetCoderRotationStrategy` 保存。
- 测试：`test/adaptive-rotation.test.js`（新，10 用例：阶梯边界、对称计量、三档分派、枚举校验）、`test/thread-rotation.test.js`（+6 用例：四路分派、解析失败回退、未注入保持组合）、`test/frontend-process-mode.test.js`（+4 用例：卡片渲染、作者默认链、保存 payload、非法值拦截）。

## 边界与不做

- 触发阈值与 context-guard 一次性锁定语义不动。
- memo / plain agent 宿主的同构推广不动（变换接口保持宿主无关，验证后统一下沉）。
- 手动精简页（统一精简页面）与编程小助手会话的接续策略不动，仍走组合 / 纯 trim / 纯摘要既有入口。

## 验证

- 框架仓 `packages/core` trim-transcript 32 用例全绿 + core build 通过。
- Claw 仓 `test:core` 全量通过（含新增 20 用例）。
- 前端卡片渲染 / 保存链路经 sandbox 测试覆盖（含用户覆盖压过作者默认的判定链断言）。
- 未验证项：真实 LLM 升级档摘要的端到端接力（需运行期观察 adaptive 日志 `[adaptive_rotation] tier=... ratio=...` 与 handoff meta）。
