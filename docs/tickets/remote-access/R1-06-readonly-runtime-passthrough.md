# R1-06 — 只读 Runtime 视图透传（白名单与响应重写）

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0008](../../adr/0008-remote-claw-connection-architecture.md) 第 2、7、8 条
- **类型**：Runtime 读路径
- **前置**：R1-04

## 背景

Phase 1 的远程体验是"看远程 Agent 干活"：消息流、工具、Hook、Todo、模板渲染全部只读可用，写路径显式拒绝。读路径透传天然成立（proxyToViewer 已走 resolveProxyTarget），本票定义白名单边界与必要的响应重写。

## 目标

读白名单（命名空间化的请求才匹配）：

```text
GET /api/agents/:id/messages | tools | hooks | overview | todo
   | notification | input-requests | running
GET /api/templates/feature?agentId=...
GET /template/* | /features/* | /npm/* | /chunk-*   （含 agent 参数重写）
```

写拒绝：

```text
POST/PUT/DELETE /api/agents/:id/input | queue-input | interrupt | user-turn ...
→ { ok: false, code: 'remote_write_disabled', retryable: false }
```

## 执行步骤

1. 在 R1-04 的远程转发路径上实施方法+路径白名单；非白名单写方法返回 `remote_write_disabled`（HTTP 403 + Phase 0 错误结构），绝不透传到远程。
2. **响应体 URL 重写（关键细节）**：`/api/templates/feature` 的响应是 URL 映射表，其中 agent 参数是远程原始 ID——必须重写为命名空间 ID 再返回前端，否则后续静态资源请求会绕过路由。重写原则：只重写前端将用于发起后续请求的 URL 字段；消息体等数据内的远程内部引用保持原样。
3. 静态资源（/template/*、/features/*、/npm/*、chunk）转发时反向重写：命名空间 agent 参数 → 远程原始 ID。
4. 模板缓存隔离：template-engine 的缓存键天然含完整 agentId（命名空间化后全局唯一），确认无跨连接串染；必要时按连接前缀分区清理。
5. 透传保持无状态：不做响应缓存、不做增量合并——前端轮询节奏与本地一致，每次拿远程真值。
6. SSE/流式端点若存在于白名单内，按远程原样透传，不解析不加工。
7. 单元测试：白名单匹配、写拒绝、模板 URL 双向重写往返、消息响应不被误改。

## 验收标准

- 远程 Agent 的消息流、Todo、Hook 面板、Feature 模板在本地页面完整渲染，与直连远程页面的内容一致。
- 任何写路径在本地服务端被拦截，返回结构化错误，远程零感知。
- 模板重写往返（前端 URL → 远程 URL → 响应 URL → 前端）闭环无死链。
- 本地 Agent 的读写行为零变化。

## 明确不做

- 不做输入/中断/排队的远程透传（Phase 2，需幂等契约）。
- 不做响应缓存、压缩优化、断点续传。
- 不做远程日志/审计的聚合查询。
