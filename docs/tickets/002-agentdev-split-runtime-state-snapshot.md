# 002 — 通知版 AgentRuntimeSnapshot 拆分重命名并导出

- **仓库**：AgentDev（`D:\code\AgentDev`）
- **决策依据**：grill Q3=a；原则记录见 [ADR-0001](../adr/0001-agentdev-export-surface-governance.md)
- **类型**：重命名 + 公共面增量，零运行时行为变化

## 背景

`AgentRuntimeSnapshot` 同名双定义，字段完全不同：

| | 通知版（types.ts:109） | 持久化版（session-store.ts:8） |
|---|---|---|
| 语义 | 实时运行时状态 | 可序列化会话快照 |
| 字段 | stage / callActive / charCount / thinkingChars / activeToolNames / streamToolNames / callStartedAt / lastErrorType / lastErrorMessage / lastOutcome | initialized / callIndex / context / featureStates / usageStats / lastCallOutcome |
| 消费面 | `/api/agents/:id/notification` 的 `runtime`、overview 合并 | 会话文件 `runtime`、`AgentSessionSnapshot` |

`index.ts` 当前只导出持久化版。下游 import 同名类型去消费 notification API 的
`runtime` 字段会类型错位。已查明：**两版在 Claw 全仓库均零 import**，重命名破坏面为零。

## 执行步骤

1. `types.ts:109` 的 `AgentRuntimeSnapshot` 重命名为 `AgentRuntimeStateSnapshot`。
2. 更新全部内部引用（执行前全仓库 grep 逐个区分两版，已知引用点）：
   - `types.ts` 内：`NotificationStateResponse.runtime`、`AgentOverviewSnapshot.runtime`、
     `AgentSession.runtimeState`
   - `viewer-worker.ts`：`createEmptyRuntimeState` / `cloneRuntimeState` /
     `updateRuntimeStage` / `getSessionRuntimeState` / `getRuntimeStageFromLLMPhase`
     全链
   - `debug-hub.ts`、`viewer-html.ts`（如引用）
   - session-store.ts 一律**不动**（持久化版保持原名）
3. `index.ts` 补导出：
   ```ts
   export type { AgentRuntimeStateSnapshot, RuntimeStage } from './core/types.js';
   ```
   （`RuntimeStage` 随行导出：被 `AgentRuntimeStateSnapshot.stage` 引用，符合判据。）

## 验收标准

- `npm run build` 成功；框架测试全绿。
- grep 确认通知版引用无旧名残留；session-store.ts 及其下游引用零改动。
- type-level 冒烟：`import type { AgentRuntimeStateSnapshot, RuntimeStage }
  from 'agentdev'` 编译通过。

## 风险提示

重命名波及面以 grep 实测为准；若 viewer-html.ts（框架查看器 HTML 生成）内嵌引用
较多，注意只改类型引用，不改运行时字段名（API payload 的字段名不变，这是纯
TS 层重命名）。
