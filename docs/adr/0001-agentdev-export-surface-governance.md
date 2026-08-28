# AgentDev 导出面治理：Runtime 双类型拆分与按引用导出

AgentDev 框架向下游（AgentDevClaw 及外部 plain agent 开发者）的类型导出面按
**"已被公共面引用"** 判据治理：公共 API（已导出的类、函数、类型的字段与返回值）
引用到的类型必须可从包入口 `agentdev` 导入，type-only 导出优先，不扩大运行时面；
**不为假设性消费者预先导出**（explicit no：`HookInspectorSnapshot`、
`AgentOverviewSnapshot`、`TodoPlanSnapshot`、`Notification` 及各 ViewerWorker API
响应类型当前零 TS 消费者，暂缓导出，等第一个真实消费者出现再补）。

据此将通知系统的实时运行时状态类型（原 `types.ts` 内部名 `AgentRuntimeSnapshot`，
含 stage/callActive/charCount/lastOutcome 等字段）公开导出为
**`AgentRuntimeStateSnapshot`**，与会话持久化快照 **`AgentRuntimeSnapshot`**
（`session-store.ts`，含 initialized/callIndex/featureStates/usageStats）拆分命名——
两者原名相同但字段完全不同，是真实的类型陷阱。

## Considered Options

- **全量导出调试快照族**（rejected）：当前下游前端为纯 JS、TS 代码零处 import
  快照类型；导出即公共契约，以后改字段就是 breaking change。收益是假设性的。
- **反向重命名持久化版**（rejected）：语义错配——session-store 版确实是 snapshot，
  通知版才是实时 state；且原名 `AgentRuntimeSnapshot` 已从 index.ts 导出（虽暂无
  消费者），保留原名避免无谓 churn。
- **别名导出不改名**（rejected）：源码中仍存在两个同名类型，陷阱本身未消除。

## Consequences

- 通知版重命名时两版均零外部消费者，破坏面为零；一旦 `AgentRuntimeStateSnapshot`
  被外部使用，再改名即 breaking——命名即长期契约。
- 下游若需类型化消费 `/api/agents/:id/notification` 的 `runtime` 字段，应使用
  `AgentRuntimeStateSnapshot`；消费会话文件 `runtime` 字段使用 `AgentRuntimeSnapshot`。

（来源：2026-08-21 grill 会话，决策记录见 [docs/tickets/README.md](../tickets/README.md)）
