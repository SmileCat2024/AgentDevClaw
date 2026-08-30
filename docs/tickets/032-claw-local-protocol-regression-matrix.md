# 032 — 本地显式寻址协议回归矩阵

- **仓库**：AgentDevClaw + AgentDev
- **决策依据**：[ADR-0006](../adr/0006-local-explicit-resource-targeting-first.md)
- **类型**：测试与验收基线
- **前置**：026–031 按各票实际依赖
- **执行关系**：作为本批最终验收票，不阻塞单票开发测试

## 背景

Phase 0 的目标不是增加用户可见功能，而是把本地协议整理成后续可扩展、且不破坏当前体验的基线。必须用纯本地测试证明：显式寻址没有串 Agent，页面焦点没有重新成为服务端隐式状态，失败和写操作结果没有被伪造。

## 测试矩阵

### 身份与寻址

- 单 Agent 显式请求；
- 多 Agent 显式请求不会串目标；
- 多 Session 请求使用正确 Session；
- 子 runtime 使用 runtime ID；
- parent ID 不会替代缺失 runtime ID；
- 页面焦点变化不改变服务端目标；
- 删除非焦点 Agent 不清空当前页面；
- 删除焦点 Agent 按前端算法恢复，不依赖服务端 current。

### Runtime API

- messages、tools、hooks、overview、todo；
- input requests、input、user-turn、queued-inputs；
- interrupt、notification、running、connection；
- templates 的显式 agentId；
- debugger MCP 的显式 agentId 和 self 语义。

### Host/Session API

- workspace state；
- model config；
- Session 创建、激活、归档、分支或删除；
- 缺少必要身份时明确失败；
- 页面焦点不改变 Host API 目标。

### 操作和错误

- operationId/sourceRef/requestId 保留；
- idempotencyKey 重放不会制造重复写入；
- 目标不存在；
- runtime 未就绪；
- 本地 Viewer 不可用；
- 请求超时；
- 业务拒绝；
- 结果未知时不显示成功。

### 兼容性

- 本地现有 Feature 面板；
- User Input；
- Todo 控制；
- Hook 控制；
- 图片附件；
- ACP 本地调用；
- IM、群聊和 dispatch 本地调用；
- 前端刷新、快速切换和 stale response。

## 验收标准

- Claw `npm run test:core` 全绿；相关 local-feature 测试全绿。
- AgentDev 修改涉及框架包时，对应包构建和测试全绿。
- 前端相关测试全绿，并增加至少一组多 Agent/多 Session 请求隔离测试。
- 测试不连接互联网、不启动 SSH、不读取真实用户历史目录，不依赖远程服务器。
- 能用测试报告证明：Phase 0 没有改变本地成功路径，且所有目标都显式可追踪。

## 明确不做

- 不写远程连接测试。
- 不启动隧道、中继、WebSocket 或第二个 Claw Server。
- 不测试远程状态同步或跨主机故障恢复。
- 不因为本票而修改本地产品功能范围。
