# 026 — 本地资源身份契约：Agent / Session / Runtime 分层

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0006](../adr/0006-local-explicit-resource-targeting-first.md)；2026-08-22 grill-with-docs Phase 0
- **类型**：本地数据模型与契约整理
- **前置**：无
- **执行关系**：本票完成后，027–032 才能使用统一术语

## 背景

现有本地数据同时出现 `id`、`runtime_session_id`、`parent_id`、`active_workspace_session_id` 和页面 `currentAgentId`。这些字段在不同层有不同含义，但调用点容易把它们当成同一个“当前 Agent”。框架的服务端 current 语义已移除，本票负责把 Claw 消费层的资源身份关系明确下来。

## 目标

建立只服务于本地链路的显式资源身份模型，暂不加入任何连接、远程或跨实例字段。

推荐的规范名称：

```text
agentId       逻辑 Agent / 工作空间身份
sessionId     工作会话身份
runtimeId     ViewerWorker 中一次运行时实例身份
parentId      子运行时所属宿主 Agent 身份
focusedId     页面展示焦点，仅 UI 状态
```

## 执行步骤

1. 在 Claw 侧选择一个已有 shared module 作为身份归一化位置；不要新建远程专用模块。
2. 增加纯函数，至少覆盖：
   - 解析 Agent 记录的逻辑 ID；
   - 解析 runtime ID；
   - 解析 parent Agent ID；
   - 解析 active session ID；
   - 构造用于日志和测试的本地资源引用。
3. 为每个函数定义空值和冲突字段的行为；禁止用名称、PID 或列表位置猜测身份。
4. 将 sidebar、agent-data-loader、session mutation、todo/model/debug 面板中重复的身份取值逐步改为统一函数。
5. 保持现有 JSON 字段和 HTTP URL 不变；本票不修改协议版本、不新增请求参数。
6. 增加纯函数单元测试，覆盖宿主 Agent、子 runtime、停止 runtime、无 session、字段同时存在但值冲突等场景。

## 验收标准

- 每个资源字段的定义和所有权在代码注释或模块文档中唯一明确。
- 页面焦点不会被身份归一化函数返回为 runtime 目标。
- runtime ID 不会被当作逻辑 Agent ID 写入 workspace/session API。
- parent ID 只表达归属关系，不作为缺失 runtime ID 的 fallback。
- 现有 Claw 核心测试全绿，现有 API 响应字段不变。
- 新测试不启动真实 Agent、不连接网络、不读取真实用户历史数据。

## 明确不做

- 不实现 SSH、隧道、远程连接、远程 Agent 列表或跨主机 ID。
- 不新增 remote/connection/scope 字段。
- 不改变页面焦点命名；焦点重命名由 027 单独处理。
- 不修改 AgentDev 框架运行时协议。
