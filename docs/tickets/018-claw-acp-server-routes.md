# 018 — Claw ACP 支撑路由（原子创建 + 精确中断）

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：[coder-acp-adapter-design.md](../coder-acp-adapter-design.md) §5 / §8 / §9.2 / §10；grill Q3 / Q11 / Q21-A / Q22-A；[ADR-0004](../adr/0004-acp-adapter-external-stdio-process.md)
- **类型**：新增 server 路由（加法式；不改现有响应结构）
- **前置**：无（可与 017 并行）；019 联调依赖本票

## 背景

两个现有事实使 adapter 无法直接组合既有端点：

1. `POST /protoclaw/prebuilt_sessions` 是「session 写入 → runtime 启动 →
   thread 自动创建（THREAD_HOST_AGENT_IDS 宿主策略）」三步**无回滚**，且响应
   不含 `threadId`；逐端点组合失败会留孤儿对象（设计文档 §9.2）。
2. 精确中断需要 viewerAgentId 语境（`run-prebuilt-agent.js` 无普通
   `interrupt` IPC 分支；中断走 ViewerWorker
   `interrupt-agent` + DebugHub `setInterruptHandler` →
   `CallArbiter.interruptActive()` 链路），adapter 不应理解该概念
   （ADR-0004 决策 3）。

## 执行步骤

1. 新增 `server/routes/acp.js` 并在 server.js 按现有模式注册：
   `POST /protoclaw/acp/coder/sessions`（**仅接受 agentId=coder，硬编码；
   其他工作空间拒绝**），进程内编排（复用 session-helpers / agent 启动链路，
   非 HTTP 自调用）：
   1. 校验 `cwd`：路径规范化、必须存在且为目录（拒绝隐式创建 / 回退）
   2. 创建 coder session（`sessionType: main`）
   3. 启动精确 session runtime，等待 READY（默认 30s，
      `CLAW_ACP_READY_TIMEOUT_MS` 可配；等待实现不得阻塞事件循环）
   4. 从 thread store 按 `headSessionId === clawSessionId` 解析 `threadId`
   5. 取 `viewerAgentId`
   6. 返回 `{ clawSessionId, threadId, viewerAgentId, cwd }`

   失败回滚阶梯（设计文档 §5）：runtime 已启动 → 精确 stop；
   thread 已创建 → 关闭；session 已写入 → 从 index 删除。回滚失败**不掩盖**：
   错误响应附各步骤状态与遗留对象 ID。
2. 新增 `POST /protoclaw/acp/coder/sessions/:clawSessionId/interrupt`：
   server 内解析该 session 当前 runtime 的 `viewerAgentId`，走现有
   `/api/agents/:id/interrupt` 同链路（ViewerWorker `interrupt-agent` +
   `clearQueue: true`）。
3. `server/routes/thread-routes.js` events 响应**加法式**附加
   `eventId` / `receivedAt`（逐事件附加字段，不重构响应形态；现有调用方零
   破坏）。
4. 新增 `test/coder-acp-routes.test.js`：
   - `cwd` 三种非法（不存在 / 是文件 / 非绝对）拒绝且零副作用
   - READY 超时 / runtime 启动失败 / thread 缺失三种注入点，断言回滚阶梯
     完整执行、无孤儿对象
   - interrupt 按 session 精确定位（不命中其他 session 的 runtime）
   - 非 coder agentId 拒绝
   - events 附加字段与旧字段共存

## 验收标准

- `npm run test:file -- test/coder-acp-routes.test.js` 全绿；server-smoke
  路由注册回归通过。
- 既有 `prebuilt_sessions` / `threads` 路由调用方行为不变。

## 风险提示

- READY 等待与请求线程模型：必须用现有轮询 / await 模式，禁止同步阻塞。
- thread 由 thread-integration 在会话创建钩子中自动建立，回滚顺序需兜底
  「runtime 未 READY 但 thread 已创建」的中间态。
- 本票改动属 server 进程，验证需**整服重启**。
