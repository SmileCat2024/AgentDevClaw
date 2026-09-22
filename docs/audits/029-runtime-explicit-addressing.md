# 029 Runtime 接口显式寻址审计

状态：实现完成，未提交。审计范围限于本地 Runtime 读写接口、Claw 直接 Viewer 调用和 Viewer debugger MCP；不包含远程路由、Catalog、SSH、连接编码或 Host API 整理。

## 端点清单

| 面 | 方法 / 路径 | 目标字段 | Runtime-scoped | 缺失目标现状 | 主要调用方 / 结论 |
|---|---|---|---|---|---|
| Viewer | `GET /api/agents` | 无（集合） | 否 | 合法集合查询 | Claw agent discovery/connected、Viewer sidebar；保留 |
| Viewer | `GET /api/agents/:agentId/messages` | path `agentId`（Viewer runtime ID） | 是 | 路径缺失匹配不到 | Viewer poll、Claw 代理；显式 |
| Viewer | `GET /api/agents/:agentId/tools` | path `agentId` | 是 | 路径缺失匹配不到 | Viewer initial load、Claw 代理；显式 |
| Viewer | `GET /api/agents/:agentId/hooks` | path `agentId` | 是 | 路径缺失匹配不到 | Viewer poll/inspector、Claw 代理；显式 |
| Viewer | `GET /api/agents/:agentId/overview` | path `agentId` | 是 | 路径缺失匹配不到 | Viewer poll、Claw 代理；显式 |
| Viewer | `GET /api/agents/:agentId/todo` | path `agentId` | 是 | 路径缺失匹配不到 | Claw work-group dispatch、todo UI；显式 |
| Viewer | `GET /api/agents/:agentId/notification` | path `agentId` | 是 | 路径缺失匹配不到 | Claw connected/group/IM polling；显式 |
| Viewer | `GET /api/agents/:agentId/connection` | path `agentId` | 是 | 路径缺失匹配不到 | Viewer poll；显式 |
| Viewer | `GET /api/agents/:agentId/input-requests` | path `agentId` | 是 | 路径缺失匹配不到 | Viewer poll、Claw pending-input discovery；显式 |
| Viewer | `POST /api/agents/:agentId/input` | path `agentId` + body `requestId` | 是 | 路径/lease 不匹配失败 | Viewer choice/input UI；runtime-bound request state |
| Viewer | `POST /api/agents/:agentId/user-turn` | path `agentId` | 是 | Claw resolver 400 `invalid_target` | Claw `submitUserTurn`、proxy、generative UI/voice/persistent input；显式 |
| Viewer | `GET /api/agents/:agentId/queued-inputs` | path `agentId` | 是 | 路径缺失匹配不到 | Viewer/Claw mailbox inspection；显式 |
| Viewer | `POST /api/agents/:agentId/dequeue-input` | path `agentId` | 是 | 路径缺失匹配不到 | AgentDev core react loop；显式 |
| Viewer | `POST /api/agents/:agentId/interrupt` | path `agentId` | 是 | 无 client/socket 时 409 `runtime_not_accepting_input` | Claw choice rejection, ACP, group-chat, remote connector；不再伪造成功 |
| Viewer | `GET /api/agents/:agentId/running` | path `agentId` | 是 | 路径缺失匹配不到 | Claw group dispatch tracking；当前 runtime ID 必须存在 |
| Viewer | `DELETE /api/agents/:agentId` | path `agentId` | 是 | 路径缺失匹配不到 | Viewer disconnected-agent deletion；显式 |
| Viewer | `GET /api/templates/feature?agentId=...` | query `agentId` | 是（模板按 runtime 装载） | 400 `agentId query parameter is required` | Claw and Viewer template loaders；不再发无目标请求 |
| Viewer | `GET /api/logs?scope=current&agentId=...` | query `agentId` for current | 是（current scope） | 400 `invalid_target` | Claw debug logs、Viewer logs；`scope=all` 仍是集合查询 |
| Viewer | `GET /api/logs?scope=all` | 无（集合） | 否 | 合法集合查询 | Viewer/Claw all-log view；保留 |
| Viewer | `GET /api/mcp-info` | 无 | 否 | 合法 Host/metadata 查询 | Claw MCP panel；不绑定 Runtime |
| Viewer | `POST /mcp` debugger MCP | tool args `agentId` for single-runtime tools/prompts; `scope=all` exception | 是或集合，依操作 | 单 runtime 缺失目标 MCP error；all 可无 agentId | debugger tools/resources/prompts；移除隐式 current/空目标路径 |
| Claw | direct Viewer `interrupt` | resolved `viewerAgentId` | 是 | 无 ID/失败不返回成功 | ACP, group-chat, embedded connector |
| Claw | direct Viewer `notification` / `todo` / `running` | resolved `runtime.viewerAgentId` | 是 | 缺失 runtime ID 不发请求；dispatch marks failed | group-chat/IM/dispatch |
| Claw | direct Viewer `input-requests` | resolved runtime session/viewer ID | 是 | 缺失则读取失败，不猜测 | agent discovery |

## fallback 处置证据

### 删除

- AgentDev `ViewerWorker.forwardInputResponse`：删除 `session.clientId` 缺失时广播到所有 UDS clients。输入租约属于单 Runtime，缺失精确 client binding 现在返回失败，防止多 Agent/子 runtime 错投。
- AgentDev `ViewerWorker.handleInterrupt`：删除无 client/socket 时的成功响应；现在返回 HTTP 409、`success:false`、`code:runtime_not_accepting_input`。
- AgentDev debugger MCP：`get_agent`、`get_hooks`、三个诊断 prompt 要求显式 `agentId`；`query_logs` 仅允许 `scope=all` 省略 agentId，`scope=current` 缺失目标报错。`current` pseudo-id 继续明确拒绝，`self` 只在有 callerAgentId 时解析。
- AgentDev Viewer template loader：无 `currentAgentId` 时不请求 `/api/templates/feature`，有目标时始终显式传 query。
- Claw group-chat interrupt：删除 `sessionId` 缺失时从群聊配置推断当前 session 的 fallback；调用方均已有线程 session ID，缺失现在 400。
- Claw group dispatch running：删除 `runtime.viewerAgentId || viewerAgentId` 回退；只使用当前 managed runtime 的显式 Viewer ID，缺失标记消息失败。
- Claw choice input：拒绝/提交使用卡片绑定的 runtime ID；无目标不构造 URL、不发请求。

### 保留

- `GET /api/agents`、`GET /api/logs?scope=all`、`GET /api/mcp-info` 是集合或元数据入口，不是 Runtime 单体操作，不强行加入 agentId。
- Claw `request-target` 对旧字段别名（`agent_id`、`runtime_session_id` 等）保留本地兼容读取，但要求字段值不冲突；不改 HTTP URL/响应协议命名。
- `get_agent/get_hooks/query_logs` 的 `self` 仍是显式 caller 绑定解析，不是页面焦点/current fallback。
- 模板加载失败回退内置 JSON 模板属于渲染模板缺失处理，不是 Runtime 寻址 fallback；本票未扩展模板错误协议。
- 连接/进程查询中的集合枚举和显式 parent relationship 保留；`parentId` 不用于缺失 Viewer runtime 目标选择。

## 未迁移清单与边界

- 仍有若干 Claw 直接 `VIEWER_ORIGIN` 拼接点，但静态审计确认调用方已有 `viewerAgentId`：ACP interrupt、embedded connector interrupt、group-chat interrupt/todo/running、IM/awareness notification、agent-connected/discovery input requests。028 已明确不扩大全部 direct Viewer 调用迁移，本票仅清理已确认的隐式 fallback。
- `server/shared/proxy.js` 仍代理集合 `/api/agents`；Runtime path 请求由 `resolveProxyTarget` 校验，集合代理保留。
- `server/shared/agent-access.js:getAgentRuntime(agentId)` 的 primary-runtime 语义仍存在于若干 Host/生命周期场景；本票不替 030 整理 Runtime/Host 边界，Runtime-scoped Viewer 调用不再用它补 Viewer ID。
- Viewer HTML 的页面焦点 `currentAgentId` 仍是 UI 焦点命名，服务端 Runtime URL 使用该焦点时均为已选 Viewer runtime 路径；029 不重做 027 的命名范围。
- 未处理远程连接、SSH、Catalog、重试/离线队列、统一错误元数据（031）和最终矩阵（032）。
