# 031 — 操作关联元数据与本地失败错误契约

- **仓库**：AgentDevClaw + AgentDev（按实际公共类型触点分拆提交）
- **决策依据**：[ADR-0006](../adr/0006-local-explicit-resource-targeting-first.md)
- **类型**：本地请求/响应契约标准化
- **前置**：028、029、030

## 背景

项目中已经存在 `operationId`、`sourceRef`、`requestId` 和 `idempotencyKey`，但不同链路的使用和错误表达不完全一致。未来任何可靠传输都需要知道一次操作的关联关系和结果是否确定；本票只在本地链路统一这些信息，不加入重试或离线处理。

## 执行步骤

1. 盘点现有四类标识的语义和生命周期：
   - `requestId`：一次协议请求或输入请求；
   - `operationId`：一次用户/界面操作；
   - `sourceRef`：外部来源归因；
   - `idempotencyKey`：允许安全重放的写操作键。
2. 定义允许的请求元数据传递方式，优先复用现有 body/query 字段；只有跨层确实需要时才补统一请求头。
3. 让本地代理、用户输入投递和 Session mutation 在不改变业务结果的前提下保留关联 ID。
4. 建立最小稳定错误码：
   - `invalid_target`
   - `target_not_found`
   - `runtime_not_ready`
   - `transport_unavailable`
   - `request_timeout`
   - `operation_rejected`
   - `operation_result_unknown`
5. 统一错误响应中可安全提供的字段：`ok`、`code`、`retryable`、`operationId`、`message`。
6. 对旧响应字段保持兼容；调用方不能因为新增元数据而改变成功/失败判断。
7. 对结果未知的本地写操作，不自动重发、不落本地离线队列，前端明确显示未知状态。

## 验收标准

- 同一操作跨前端、Claw Server、ViewerWorker 的关联 ID 可追踪。
- 旧本地成功响应字段和业务行为不变。
- 错误码可由机器判断，用户消息仍可本地化。
- `retryable` 不被误用为“客户端必须自动重试”。
- 网络断开/服务未就绪/目标不存在/业务拒绝可分别测试。
- 不重复发送用户输入、不重复创建或删除 Session。

## 明确不做

- 不实现网络重试器。
- 不实现本地写入队列、补偿事务或状态镜像。
- 不加入远程连接头、远程身份或传输协议版本。
- 不要求一次性改造所有历史路由；未迁移项必须列清单。
