# R2-04 — 面板资源远程扩列：会话控制面板（自动接续 / 上下文守卫 / capability）

- **仓库**：AgentDevClaw
- **决策依据**：ADR-0011（protoclaw 域适配套路）、ADR-0008（远程权威、显式寻址）
- **类型**：protoclaw 域远程转发（runtime control 族）
- **前置**：R2-01 / R2-02 已合入 main；`tool-state.js` / `todo_control` 是同一解析器的转发先例
- **状态**：已立项待派发

## 背景

右侧「会话控制」面板的自动接续（force continuation）、上下文守卫（context guard）、模型轮转状态与控制，对远程会话失效：这批端点经 `resolveRuntimeControlTarget`（`server/shared/operation-target.js`）解析后走**本地 IPC**（`requestSessionRuntimeState`），远程命名空间身份在本地 runtime 表中查无此会话，请求 503。远程会话的状态与控制必须落在远程 runtime 上（feature 状态真值在远程进程内）。

## 范围（6 端点）

| 端点 | 文件 | 方法 | 读/写 |
|---|---|---|---|
| `/protoclaw/force_continuation_status` | `server/routes/agent-lifecycle.js` | GET | 读 |
| `/protoclaw/force_continuation_control` | 同上 | POST | 写 |
| `/protoclaw/context_guard_status` | 同上 | GET | 读 |
| `/protoclaw/context_guard_control` | 同上 | POST | 写 |
| `/protoclaw/capability_invoke` | `server/routes/capability.js` | POST | 写 |
| `/protoclaw/capability_commands` | 同上 | GET | 读（远程会话 slash 菜单命令列表） |

## 关键语义边界（施工前必读）

- 这批端点全部经 `resolveRuntimeControlTarget`（runtimeId / sessionId 寻址）→ `requestSessionRuntimeState` / `requestCapabilityState` 本地 IPC。远程适配 = 路由内命名空间分支：识别身份字段的 `remote:` 前缀 → `resolveForwardHostTarget` → `forwardProtoclawRoute`（agentId / runtimeId / sessionId 全部 `bareId` 展开），远程端同名路由自己走它的 runtime IPC。
- **同一解析器族已有远程分支先例**：`tool-state.js`（todo_control / tool_state 的转发，commit 7145ae4）用的就是 `resolveRuntimeControlTarget` 产物——照它的形态接，不要发明新解析层。
- 写端点（两个 control、capability_invoke）幂等闸照 R2 系列既定模式（远程 + 无键 → 400 `idempotency_key_required`）；capability_invoke 的幂等键来源按前端既有 operationId 体系核实补齐。
- 本地分支字节级不动（ADR-0011 #1）。

## 服务端改动

- `server/routes/agent-lifecycle.js`：`force_continuation_status` / `force_continuation_control` / `context_guard_status` / `context_guard_control` 四端点远程分支（文件内已有远程分支锚点，同型照抄）。
- `server/routes/capability.js`：`capability_invoke`、`capability_commands`（GET）远程分支。
- `resolveRuntimeControlTarget`（`server/shared/operation-target.js`）是本地边界解析器——**不改它的契约**；命名空间识别放在路由分支（与既有套路一致），或按既有先例形态在解析前分流。

## 前端改动

- `public/src/modules/session-controls-panel.js`：status / control 调用点核实身份来源（query/body 中的 agentId / runtimeId / sessionId 应为当前会话的宿主级命名空间 id；本地身份行为不变）。
- capability invoke（`session-controls-panel.js:649` 附近）：转发后由远程 session 执行；无 write / sessionOps 能力时按既有能力矩阵降级（复核该面板现有门控点，缺则补）。

## 测试

- 六端点转发用例（转发形状 / 裸 id / 契约失败 / 本地分支零网络）。
- capability_commands 读转发 + capability_invoke 写幂等闸。
- 全量回归 + eslint + `git diff --check`。

## 验收标准

- 本地路径行为不变；远程分支转发形状与失败三分类契约正确。
- 双机冒烟（调度方安排）：远程会话的会话控制面板显示远程状态、开关在远程端生效。

## 明确不做

- 不改 framework IPC（requestSessionRuntimeState 等）。
- 不做 slash 命令远程矩阵的 UI 增项（只保证 commands 列表来自远程会话真实返回）。
- model_config / swap 系不在范围（已转发）。
