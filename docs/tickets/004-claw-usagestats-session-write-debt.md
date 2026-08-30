# 004 — Claw 越权改写会话文件 usageStats（债务记录，不排期）

- **仓库**：AgentDevClaw
- **决策依据**：grill Q4=a——与类型导出工作显式解耦，本次不修
- **类型**：债务记录，无执行内容

## 问题

`server/routes/session-token-refresh.js:180-183` 在进程外直接改写会话文件中的
`runtime.usageStats.lastRequestUsage`，注释自认："写入路径须与 summarizePrebuiltSession
读取路径一致: runtime.usageStats.lastRequestUsage"。

这是数据所有权问题，不是类型导出问题：

- 会话文件的 `runtime` 块由框架持久化层（`Agent.createSessionSnapshot` /
  `UsageStats.toSnapshot`）生成，Claw 以文件写方式绕过了 `UsageStats` 的全部
  不变量（累加、lastRequestUsage 语义、快照一致性）。
- 框架一旦调整 `usageStats` 字段形状（合法的内部演进），该写入会**静默错位**，
  读取侧（session-helpers-pure.js、group-chat pure-functions.js）随之读到错误用量。
- 类型导出（本批 001）让"读"有了契约，但对这个"写"路径毫无约束力。

## 正确方向（二选一，届时决策）

1. 框架提供受控刷新 API：如 `Agent` 层暴露用量回写入口，或 session store 提供
   原子 patch 接口，Claw 调 API 而非写文件。
2. Claw 停止写：改为由 runtime 进程内在正确时机回写（如 call.finish 后的
   auto-save 路径已覆盖，则直接删除该写入）。

## 触发条件

下次任何触碰以下区域的需求开工前，必须先偿还此债务：

- session 持久化格式 / usageStats 字段形状的任何变更
- token 用量展示 / 刷新链路的改动
- AgentDev `UsageStats` / session store 的演进

## 关联

- 本批类型导出（001）完成后，"读契约"已成立；本票是"写路径"的另一半。
