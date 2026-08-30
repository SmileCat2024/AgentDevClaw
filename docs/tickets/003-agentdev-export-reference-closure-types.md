# 003 — 已导出类型的引用闭包核查与补齐

- **仓库**：AgentDev（`D:\code\AgentDev`）
- **决策依据**：grill Q2=b——判据是"已被公共面引用"，本票把这个判据机械执行一遍
- **类型**：公共面增量，零运行时行为变化
- **前置依赖**：001、002 全部完成（核查对象是终态导出面，先行执行会产出错误清单）

## 背景

存在"已导出类型引用了未导出类型"的客观缺口。已知项：

- `AgentRuntimeSnapshot.featureStates: FeatureCheckpoint[]`（session-store.ts:13，
  `FeatureCheckpoint` 定义在 checkpoint.ts:4，未导出）
- `AgentSessionSnapshot` 同样引用 `FeatureCheckpoint`

其他候选按同判据现场判定：`ToolExecResult`（context.ts:54）、
`ContextTombstoneSummary` / `ContextTombstoneEntry`（context.ts:97/115）、
`FeatureOrderResult`（feature-graph.ts:36）——**若被已导出类型的字段引用则补，
否则不补**（后者属于"将来可能有用"，Q2 已明确拒绝）。

## 执行步骤

1. 从 `src/index.ts` 导出面出发，遍历每个已导出类型的字段/返回值类型引用，
   列出引用闭包中不可从入口导入的类型清单。
   方法建议：tsc 生成 declaration（`dist/**/*.d.ts`）后逐个 grep import 可解析性，
   或手工沿类型链核查（导出面规模可控，手工成本可接受）。
2. 对清单逐个补 type-only 导出到 `index.ts`。已知确定项：
   ```ts
   export type { FeatureCheckpoint } from './core/checkpoint.js';
   ```
3. 明确不在清单内时在导出处留一行注释标记"核查过，未被引用"不必要——
   沉默跳过即可，README 暂缓表已记录原则。
4. 创建导出面导入冒烟测试（**本批唯一创建处**，覆盖 001/002/003 全部新增导出）：
   断言各新类型可 `import type { ... } from 'agentdev'` 解析，形式从简，
   纳入框架测试体系（node:test）。

## 验收标准

- 引用闭包中不存在"不可从 `agentdev` 入口导入"的类型（自动化检查或人工复核清单）。
- `npm run build` 成功；框架测试全绿。

## 明确不做

- 不导出快照类型族（HookInspectorSnapshot / AgentOverviewSnapshot /
  TodoPlanSnapshot / Notification / API 响应类型）——它们只被未导出的类型与
  HTTP API 引用，不在"已导出类型引用闭包"内（Q2 暂缓清单）。
