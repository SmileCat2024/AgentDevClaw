# R2-05 — 面板资源远程扩列：日志与 MCP（viewer 平面读白名单扩列）

- **仓库**：AgentDevClaw
- **决策依据**：ADR-0011（白名单扩列先例）、ADR-0008 #2（零镜像透传读）
- **类型**：代理闸读白名单扩列
- **前置**：R1-06 只读透传已合入（`server/shared/proxy.js` 白名单机制）
- **状态**：已立项待派发

## 背景

右侧「日志」面板（`debug-logs.js`）与「MCP」面板（`debug-mcp.js`）的数据源是 ViewerWorker 平面端点 `/api/logs`、`/api/mcp-info`（`AgentDev/packages/viewer/src/viewer-worker.ts:344/349`，query 或无参寻址）。代理闸的远程读白名单（`server/shared/proxy.js` `isRemoteReadWhitelisted`）不覆盖这两个路径，远程会话打开日志 / MCP 面板被 403（`Remote read path is not whitelisted`）。ADR-0011 曾把 `/api/logs` 列入 Phase 4 排除项——本票即该扩列。

## 范围

| 端点 | 方法 | 寻址 | 前端消费方 |
|---|---|---|---|
| `/api/logs` | GET | query（核实 query key，应为 agentId） | `debug-logs.js:337` |
| `/api/mcp-info` | GET | 当前无参（viewer-worker 全局） | `debug-mcp.js:100` |

## 关键语义边界（施工前必读）

- 两个都是 **viewer 平面读端点**（远程 ViewerWorker 直接服务），走代理闸白名单扩列，**不需要** protoclaw 路由分支、无幂等闸（读）。
- query 身份还原：远程请求 query 里的 `agentId=remote:<connId>:<id>` 必须在转发前还原为裸 id。核实 `readAgentQueryIdentity` + `rewriteProxyUrl`（`server/shared/proxy.js`）对该形态的处理已覆盖（AGENT_QUERY_KEYS 家族）；`/protoclaw/agent_detail` 是同型先例。
- 前端零远程特判：调用点用当前会话身份拼 query，本地身份行为不变（ADR-0012 呈现层无分支纪律）。

## 服务端改动

- `server/shared/proxy.js`：`isRemoteReadWhitelisted` 加 `/api/logs`、`/api/mcp-info`（照 `/protoclaw/agent_detail` 的条目形态）。
- 核实 `rewriteProxyUrl` 对这两条路径 query 中命名空间 agentId 的还原；`/api/mcp-info` 无参形态不会被远程分支命中（resolveProxyTarget 为 null 走本地），属预期。

## 前端改动

- `public/src/modules/debug-logs.js`：核实请求参数含当前会话 agentId（远程时为命名空间 id）——若已是 currentRuntimeAgentId 派生则零改动。
- `public/src/modules/debug-mcp.js`：`fetch('/api/mcp-info')` 补带当前会话 agentId query（本地身份也带，行为不变，服务端忽略）。

## 测试

- `/api/logs`、`/api/mcp-info` 远程读转发用例（query 裸 id 还原、转发形状、非白名单路径仍 403）。
- 全量回归 + eslint + `git diff --check`。

## 验收标准

- 本地会话日志 / MCP 面板行为不变；远程会话两面板显示远程数据。
- 白名单外路径维持 403（回归确认）。

## 明确不做

- 不动 ViewerWorker 端点实现（框架侧零改动）。
- 不做日志流的远程适配增项（现有轮询形态原样转发）。
