# R2-03 — 面板资源远程扩列：交互页面（ui-surfaces）

- **仓库**：AgentDevClaw
- **决策依据**：ADR-0011（protoclaw 域适配套路）、ADR-0008（远程权威、命名空间、零镜像）
- **类型**：protoclaw 域远程转发（面板资源）
- **前置**：R2-01 / R2-02 已合入 main（转发模式、幂等闸、前端身份纪律已定型）
- **状态**：已立项待派发

## 背景

右侧「交互页面」面板（generative-ui）对远程会话不可用：前端轮询 `GET /protoclaw/agents/<命名空间 agentId>/ui-surfaces`，本地 store 按该字符串键控查不到任何 surface，面板恒空。Surface 真值天然落在远程机上（远程 agent 的 generative-ui feature 调远程 server 的 store，`PROTOCLAW_SERVER_ORIGIN` 指向远程本机），本地只缺浏览器方向的 GET / action 转发。

## 范围（5 端点，全部在 `server/routes/ui-surfaces.js`）

| 端点 | 方法 | 读/写 | 用途 |
|---|---|---|---|
| `/protoclaw/agents/:agentId/ui-surfaces` | GET | 读 | registry（前端 4s 轮询，ETag/304） |
| `/protoclaw/agents/:agentId/ui-surfaces/:surfaceId` | GET | 读 | 单 surface |
| `/protoclaw/agents/:agentId/ui-surfaces/:surfaceId` | PUT | 写 | agent 侧 upsert（本地 agent feature 调用，远程 agent 的 PUT 打远程 server，本票**不需要**为 PUT 建分支——但分支若统一加也不禁止） |
| `/protoclaw/agents/:agentId/ui-surfaces/:surfaceId` | DELETE | 写 | 浏览器关闭 surface |
| `/protoclaw/agents/:agentId/ui-surfaces/:surfaceId/actions/:actionId` | POST | 写 | 面板动作提交（远程端内部走它自己的 deliverUserInput/input-gateway） |

## 关键语义边界（施工前必读）

- **Store 真值在 runtime 所在机器**：本地 agent 的 surface 在本地 store，远程 agent 的在远程 store（远程 agent feature 的 `PROTOCLAW_SERVER_ORIGIN` 指向远程本机，ADR-0008 #6 远程零改动）。本票只做浏览器 → 远程的转发，远程端该路由本来就在，零改动。
- **幂等键**：POST action 的 `eventId` 即幂等凭证（本地 store `beginEvent(eventKey)` 去重）。转发分支把 eventId 作为幂等键契约（`x-idempotency-key` 头或照既有 protoclaw 幂等闸形态）；PUT/DELETE 依 R2 系列既定闸模式补齐。本地路径不强制幂等键（ADR-0011 #1）。
- **本地分支字节级不动**：本地身份永不进远程分支；远程身份永不 fallback 本地执行。
- **eventKey 去重的归属**：本地 store 的 beginEvent/completeEvent 只管本地路径；远程路径的幂等由远程端同构保证（远程也有本地同款 store 逻辑），本地分支不重复做 event 去重。

## 服务端改动

`server/routes/ui-surfaces.js` 五端点加远程命名空间分支（照 R2-01/R2-02 定型模式）：识别 `:agentId` 的 `remote:` 前缀 → `resolveForwardHostTarget` → `forwardProtoclawRoute`（路径内 agentId 用 `bareId` 还原）。参考锚点：`server/routes/session.js`、`tool-state.js`、`model-config.js` 的既有分支。若需"透传原始响应（含 ETag / 304）"的转发变体，允许在 `server/shared/remote-forward.js` **新增**纯 helper（不改既有函数契约），并在报告说明。

## 前端改动

- `public/src/modules/generative-ui-panel.js`：轮询/关闭/提交三个调用点已用 `currentRuntimeAgentId` 寻址（远程时即命名空间 id），GET 轮询预期零改动；POST action 请求补 `x-idempotency-key`（eventId）。
- 写门控：远程会话且 `capabilityFor(agentId, 'write')` 为 false 时，action 提交按钮禁用（照能力矩阵既有降级形态）；本地身份恒可写。

## 测试

- 五端点转发用例：转发形状 / 裸 id 展开 / 未知连接 404 契约 / 幂等闸 400 / 本地分支零网络。
- 远程 action 的 eventId 幂等键透传断言。
- 全量回归 + eslint + `git diff --check`。

## 验收标准

- 本地路径行为不变（既有 ui-surfaces 测试全绿）。
- 远程分支：转发形状正确、失败三分类契约形态（`transport_unavailable` retryable / `target_not_found` / `operation_rejected`）。
- 双机冒烟（调度方安排，不归 coder）：远程会话的面板出现远程 agent 创建的 surface；面板动作在远程端投递成功。

## 明确不做

- 不改 local-features/generative-ui 源码（agent 侧 feature 零改动——它本来就调本机 server）。
- 不动 store 的键控语义（本地 store 仍按裸 agentId 键控）。
