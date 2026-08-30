# 001 — UsageInfo 双定义合并 + usage 类型族导出

- **仓库**：AgentDev（`D:\code\AgentDev`）
- **决策依据**：grill Q2=b（按"已被公共面引用"判据导出）、Q3（合并方向由依赖方向锁定）
- **类型**：重构 + 公共面增量，零运行时行为变化
- **前置依赖**：无（本批首票）

## 背景

- `UsageInfo` 存在双定义：`src/core/types.ts:362` 与 `src/core/usage.ts:19`，结构
  巧合相同。`agent.ts` / `react-loop.ts` 从 types.js 导入，`UsageStats` 使用自己
  文件内那份。
- 依赖方向已锁定合并路径：`types.ts:460` 已 `import type { UsageStatsSnapshot }
  from './usage.js'`，反向（usage.ts → types.ts）会引入循环。因此**权威定义放
  usage.ts，types.ts 改为 re-export**。
- `UsageInfo` / `UsageStatsSnapshot` / `CallUsageSummary` / `UsageStats` 类均未从
  `src/index.ts` 导出，但它们全部被公共面引用：
  - `Agent.getUsage(): UsageStats`（公开方法，agent.ts:1123）
  - `AgentRuntimeSnapshot.usageStats`（session-store.ts:13，已导出类型）
  - `AgentOverviewSnapshot.usageStats`（types.ts:591）
- 下游佐证（为何这是真缺口）：Claw 前端 `overview-data.js` 逐字段 `typeof` 手工
  normalize；`run-prebuilt-agent.js:884` 直接调 `getUsage().toSnapshot()`。

## 执行步骤

1. `usage.ts` 的 `UsageInfo` 保持为权威定义（不动）。
2. `types.ts:362` 删除本地定义，改为 `export type { UsageInfo } from './usage.js'`；
   文件内对 `UsageInfo` 的引用（`LLMResponse.usage` 等）确认走 re-export 解析。
3. `index.ts` 补导出：
   ```ts
   export type { UsageInfo, UsageStatsSnapshot, CallUsageSummary } from './core/usage.js';
   export type { UsageStats } from './core/usage.js';  // type-only，不扩大运行时面
   ```

## 验收标准

- `npm run build` 成功；框架测试全绿。
- type-level 冒烟：`import type { UsageInfo, UsageStatsSnapshot, CallUsageSummary,
  UsageStats } from 'agentdev'` 编译通过（冒烟测试由 003 统一创建，本票不单独建）。
- 全仓库 grep 确认 `UsageInfo` 只有一处 interface 定义（usage.ts）。

## 明确不做

- 不导出 `UsageStats` 的值形式（类导出）——无下游需要 instanceof/继承。
- 不触碰 Claw 侧任何代码（前端 JS 防御式 normalize 不在本票范围）。
