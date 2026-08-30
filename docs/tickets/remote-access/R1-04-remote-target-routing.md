# R1-04 — 远程目标路由：request-target 扩展与命名空间重写

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0008](../../adr/0008-remote-claw-connection-architecture.md) 第 3、4、5 条；[ADR-0006](../../adr/0006-local-explicit-resource-targeting-first.md)
- **类型**：路由层
- **前置**：R1-01（连接表与端口解析）

## 背景

Phase 0 建立的 `server/shared/request-target.js` 只解析本地目标。本票为它增加第二种解析结果：`scope: 'remote'`。这是"Feature 不分叉"的核心交付——前端继续用相对路径 + 不透明 agentId 发请求，本地/远程的判断全部收敛在此层。

## 目标

命名空间与解码：

```text
前端请求：  /api/agents/remote%3Aserver-a%3Aagent-3-22040/messages
                ↓ request-target 解码
内部结构：  { scope: 'remote', connectionId: 'server-a', agentId: 'agent-3-22040' }
                ↓ 连接表查 origin
远程实际收到：http://127.0.0.1:22101/api/agents/agent-3-22040/messages
```

## 执行步骤

1. 扩展 `resolveProxyTarget` / `resolveRuntimeTarget`：识别 `remote:` 前缀（复用既有 `decodeIdentity`，兼容百分号编码），拆出 connectionId 与原始 ID。
2. 目标 origin 从连接存储解析：`http://127.0.0.1:<connection.localPort>`——**路由层到此为止，不知道 SSH 存在**。
3. 转发重写：URL 路径中的命名空间 ID 还原为原始 ID 后再转发（path、query 中的 agentId / agent 参数都要重写）。
4. 未知 connectionId（配置已删）→ `target_not_found`；命名空间格式非法 → `invalid_target`；连接 disabled → `transport_unavailable`。全部走 Phase 0 的 RequestTargetError 形态。
5. 无命名空间的请求行为与现状**逐字节一致**（本地路径零改动，这是 Q25/ADR-0006 的硬约束）。
6. 操作元数据头（X-Claw-Operation-Id 等，见工单 031 契约）原样透传，远程不感知额外语义。
7. Host-scoped 预留：解析器支持 `connectionId` 显式参数将 host 请求定向到远程 origin base；本票只做解析能力，不接入任何 host 端点（供 R1-05 服务端内部调用使用）。
8. 单元测试：解码/重写往返、非法前缀、未知连接、本地路径回归。

## 验收标准

- 命名空间请求经代理后远程收到的 URL 与前端直接访问远程（剥前缀）完全一致。
- 本地全量测试零回归；无 `remote:` 前缀时新增代码不产生任何行为差异。
- decode → resolve → rewrite 全链路纯函数可测，无网络副作用。

## 明确不做

- 不做读/写白名单（R1-06）。
- 不做聚合端点与前端改动（R1-05/R1-07）。
- 不做 Host 端点的公开远程化。
