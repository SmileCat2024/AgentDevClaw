# 029 — Runtime 接口显式寻址审计与隐式 fallback 清理

- **仓库**：AgentDevClaw + AgentDev（按实际触点分拆提交）
- **决策依据**：[ADR-0006](../adr/0006-local-explicit-resource-targeting-first.md)；current agent 移除后的本地协议基线
- **类型**：本地接口契约审计与兼容性清理
- **前置**：026；028 的目标校验可作为参考
- **执行关系**：依赖 026；不得与 028 同时覆盖同一端点

## 背景

current agent 已从框架服务端、ViewerWorker 和 DebugHub 协议中移除，但仍需确认所有 Runtime 接口都遵守显式 Agent/Runtime 身份。历史兼容端点和参数兜底可能在未来多目标场景下重新制造歧义。

## 审计范围

至少检查：

```text
messages
 tools
 hooks
 overview
 todo
 input-requests
 input
 user-turn
 queued-inputs
 interrupt
 notification
 running
 connection
 templates
 logs
 debugger MCP
```

同时检查 Claw 侧直接访问 Viewer 的内部调用：choice alerts、group-chat、ACP、dispatch、user-turn 和 agent discovery。

## 执行步骤

1. 建立端点清单：方法、路径、目标字段、是否 Runtime-scoped、缺失字段现状、调用方。
2. 对已确认的 Runtime 端点统一要求显式 `agentId` 或 `runtimeId`。
3. 删除无调用方的隐式兼容端点；对仍有调用方的端点先迁移调用方，再清理 fallback。
4. 缺失目标返回稳定错误，不根据页面焦点、current、列表第一项、名称或 parentId 猜测。
5. 检查静态模板、日志和 MCP 参数是否把页面焦点误当作目标。
6. 对 Claw 的直接 Viewer 调用逐个确认：调用方是否已有明确 runtime ID；没有则补齐真实调用链参数，不从 UI 状态偷取。
7. 同步框架测试和 Claw 测试，保留本地兼容响应字段，不扩大本票的协议改名范围。

## 验收标准

- 端点清单覆盖所有 Runtime 读写入口和实际调用方。
- 任一 Runtime 请求不会因为缺少目标而落到另一个 Agent。
- 多 Agent、多 Session、子 runtime、停止 runtime 的本地测试全部通过。
- 删除的兼容路径有调用方证据或测试证明，不依赖猜测。
- Claw `npm run test:core` 与 AgentDev 相关包测试全绿。
- 失败响应包含稳定错误码，且不伪造成功。

## 明确不做

- 不新增跨主机身份编码。
- 不实现统一远程 Catalog 或任何网络路由。
- 不将所有 Host-scoped API 强行改造为 Runtime API；Host 边界由 030 记录和整理。
