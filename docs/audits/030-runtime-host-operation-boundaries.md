# 030 Runtime / Host 操作边界审计

状态：实现完成，未提交。范围仅为 AgentDevClaw 本地 `/protoclaw/*` 路由分类、数据所有者和显式目标边界；不包含 029 Runtime Viewer 全量复审、031 元数据错误契约或 032 最终回归矩阵。

## 规则

- `Runtime`：目标是一个运行中的 Agent/Session；请求必须携带显式 `agentId + sessionId`，或 Runtime 控制携带 `agentId + runtimeId/sessionId`。
- `Session`：目标是持久化会话及其 session index / session JSON；不得从页面焦点、列表位置或其他 Agent 扫描推导目标。
- `Host`：目标是当前 Claw 主机上的配置、目录、项目、资源或宿主运行过程；保留本地 URL，不读取页面焦点决定宿主归属。
- `Global`：当前 Claw 用户/进程的集合、注册表、能力或全局服务；不绑定页面焦点。

## 分类表与数据所有者

| 分类 | 路由 | 显式目标 | 真正数据所有者 / 目标 | 边界结论 |
|---|---|---|---|---|
| Global | `GET /protoclaw/health` | 无 | Claw 主进程 + Viewer 端口 | 本地服务健康集合 |
| Global | `GET /protoclaw/get_prebuilt_agents` | 集合 | 预制 Agent 注册/metadata、session index 投影 | 不绑定焦点 |
| Global | `GET /protoclaw/get_agents_status` | 集合 | 进程注册表 `managedAgents` | 不绑定焦点 |
| Global | `GET /protoclaw/get_connected_agents` | 集合 | ViewerWorker `/api/agents` + 进程注册表 + session metadata | 全量集合查询 |
| Runtime | `GET /protoclaw/runtime_status` | `agentId + sessionId` | 进程注册表 + ViewerWorker + session 文件 metadata | 已显式校验 |
| Runtime | `GET /protoclaw/runtime/inbox` | `agentId + sessionId` | 进程内 RuntimeInbox | 已显式校验，不再用无 session runtime key |
| Runtime | `GET /protoclaw/runtime/execution_state` | `agentId + sessionId` | 进程内 runtime execution state | 已显式校验 |
| Global | `GET /protoclaw/runtime/execution_states` | 集合 | 进程内 execution state registry | 集合诊断 |
| Global | `GET /protoclaw/runtime/envelope` | `envelopeId` | 进程内 CallEnvelope registry | 资源自身 ID |
| Global | `GET /protoclaw/runtime/envelopes_by_source` | `sourceRef` | 进程内 CallEnvelope registry | 集合诊断 |
| Runtime | `GET /protoclaw/force_continuation_status` | `agentId + sessionId` | 精确 Session runtime IPC | 已显式校验 |
| Runtime | `POST /protoclaw/force_continuation_control` | `agentId + sessionId` | 精确 Session runtime IPC | 已显式校验 |
| Runtime | `POST /protoclaw/todo_control` | `agentId + runtimeId/sessionId` | Viewer runtime / Session IPC | 缺少运行目标明确 400，不主 runtime fallback |
| Runtime | `POST /protoclaw/agent/tool_state` | `agentId + runtimeId/sessionId` | Viewer runtime / Session IPC | 缺少运行目标明确 400，无广播 fallback |
| Runtime | `POST /protoclaw/swap_model` | `agentId + runtimeId/sessionId` | 单一运行时内存 LLM | 缺少运行目标不成功，不广播 |
| Runtime | `POST /protoclaw/swap_thinking_effort` | `agentId + runtimeId/sessionId` | 单一运行时内存 LLM | 缺少运行目标不成功，不广播 |
| Runtime | `GET /protoclaw/dispatch/poll` | `agentId + sessionId` | Dispatch runtime queue / waiter | 已显式校验 |
| Runtime | `POST /protoclaw/dispatch/agent_status` | `agentId + sessionId` | Dispatch runtime activity map | 已显式校验 |
| Session | `GET /protoclaw/prebuilt_sessions` | `agentId` | session index + session files | 已显式校验 |
| Session | `GET /protoclaw/search_sessions` | `agentId` + query | session search index / session files | Agent 是显式 owner |
| Session | `GET /protoclaw/session_record` | `agentId + sessionId` | session JSON | 已显式校验 |
| Session | `POST /protoclaw/render_conversation` | `agentId + sessionId` | session JSON；输出项目 temp HTML | 删除 `qqbot` 默认 Agent |
| Session | `GET /protoclaw/session_trim_preview` | `agentId + sessionId` | session JSON | 已显式校验 |
| Session | `POST /protoclaw/sessions/branch` | `agentId + sourceSessionId` | session index + session JSON | 已显式校验 |
| Session | `GET /protoclaw/session_summary` | `agentId + sessionId` | user context-handoffs + session index | 已显式校验 |
| Session | `POST /protoclaw/session_generate_summary` | `agentId + sessionId` | session JSON + handoff 文件 | 已显式校验 |
| Session | `POST /protoclaw/refresh_session_token_count` | `agentId + sessionId` | session JSON / index + 用户模型配置 | 已显式校验 |
| Session | `POST /protoclaw/prebuilt_sessions` | `agentId`，可带 sourceSessionId | session index / session JSON；启动由进程注册表完成 | Agent 必须显式 |
| Session | `PUT /protoclaw/prebuilt_sessions/:sessionId/title` | body `agentId + path sessionId` | session index | 已显式校验 |
| Session | `POST /protoclaw/generate_session_title` | `agentId + sessionId` | session JSON + title mirror | owner 只按显式 Agent 检查 |
| Session | `POST /protoclaw/generate_recap` | `agentId + sessionId` | session JSON + recap mirror | owner 只按显式 Agent 检查 |
| Session | `POST /protoclaw/context_handoffs/export` | `agentId + sessionId` | session JSON + context-handoffs | 已显式校验 |
| Session | `POST /protoclaw/context_handoffs/compacted_resume` | `agentId + handoffId/path` | handoff 文件 + 新 session index / JSON | handoff-id 必须显式 Agent |
| Session | `POST /protoclaw/spawn_one_shot` | `agentId` + handoff/exploration refs | session index / JSON + one-shot 进程 | 删除 `programming-helper` 默认 |
| Session | `POST /protoclaw/resume_sub` | `agentId + sessionId` | session index / JSON + one-shot 进程 | 删除固定 programming-helper |
| Session | `POST /protoclaw/context_handoffs/compact_and_resume` | `agentId + sessionId` | session JSON + handoff + 新 session | 已显式校验 |
| Session | `POST /protoclaw/prebuilt_sessions/activate` | `agentId + sessionId` | session index + 进程注册表 | 已显式校验 |
| Session | `POST /protoclaw/prebuilt_sessions/delete` | `agentId + sessionId` | session index + session JSON + 进程注册表 | 已显式校验 |
| Session | `POST /protoclaw/prebuilt_sessions/archive` | `agentId + sessionId` | session index | 已显式校验 |
| Session | `POST /protoclaw/prebuilt_sessions/todo` | `agentId + sessionId` | session index | 已显式校验 |
| Session | `POST /protoclaw/context_guard_event` | `agentId + sessionId` | session index + thread rotation | 已显式校验 |
| Session | `GET /protoclaw/context_guard_status` | `agentId + sessionId` | session index | 已显式校验 |
| Session | `POST /protoclaw/session_meta_sync` | `agentId + sessionId` | session JSON mtime + session index | 已显式校验 |
| Host | `GET/PUT /protoclaw/workspace_state` | `agentId` | 用户 workspace state 文件 | Host workspace 由显式 Agent 记录，绝不读取页面焦点 |
| Host | `GET /protoclaw/workspace_artifacts` | `agentId` | 用户 workspace artifact 目录 | 同上 |
| Host | `GET/PUT /protoclaw/model_config` | 无 | 用户模型配置文件 + presets 文件 | 全局本地配置，不绑定焦点 |
| Host | `GET/PUT /protoclaw/speech_model_config` | 无 | 用户模型配置文件 | 全局本地配置 |
| Host | `POST /protoclaw/speech_to_text` | 无 | 用户配置 + 当前 Claw 到配置的 ASR provider | 本地宿主代理，非 Runtime |
| Host | `GET/PUT /protoclaw/agent_process_mode` | `agentId` | Claw 用户数据中的 `agent-configs/<agentId>.json`（默认根目录 `~/.agentdev/AgentDevClaw/`） + metadata | 显式 Agent 配置，不是页面焦点 |
| Host | `GET/PUT /protoclaw/agent_model_presets` | `agentId` | metadata + Claw 用户数据 Agent config | 显式 Agent 配置 |
| Host | `POST /protoclaw/dispatch/schedules` | schedule target fields | 用户 dispatch-schedules.json + 宿主调度器 | 保留已有 programming-helper 默认；不来自焦点 |
| Global | `GET /protoclaw/dispatch/schedules` | 无 | 用户 dispatch-schedules.json | 全局调度注册表 |
| Global | `DELETE /protoclaw/dispatch/schedules/:id` | schedule id | 用户 dispatch-schedules.json + 宿主调度器 | 全局 schedule owner |
| Host | `GET/PUT /protoclaw/system_feature_config` | 无 | 用户 feature-setup.json | 本地全局配置 |
| Host | `GET /protoclaw/shell_availability` | 无 | 当前宿主 PATH / shell 文件 | 能力探测，不绑定焦点 |
| Host | `GET /protoclaw/browse_dirs` | query path | 项目/用户文件系统目录 | 路径是显式请求字段 |
| Global | `GET /protoclaw/system_feature_manifests` | 无 | 当前安装 feature 类/manifest | 本地安装集合 |
| Host | `GET/PUT /protoclaw/feature_config/*` | `agentId` + optional dir/layerId | 全局/Agent/目录层配置文件 | 层目标由显式 scope/dir/layerId 解析 |
| Host | `/protoclaw/feature_repository/*` | package/upload id | 官方/用户 Feature repository 文件 | 宿主资源仓库 |
| Host | `/protoclaw/flow_*` | flowId（图资源） | 用户 Flow 文件 | 宿主项目资源，不是页面焦点 |
| Host | `/protoclaw/project_docset/import_materials` | project/docset fields | 项目目录 docset | 目录字段显式提供 |
| Host | `/protoclaw/ph_project/*` | agentId + directory/projectId | workspace state 文件 + 项目目录 | 保留本地 URL；默认仅是既有兼容，不由焦点解析 |
| Host | `/protoclaw/prebuilt_project/delete` | agentId + projectId | workspace state + session index/files + managed process registry | 显式 Agent/project |
| Host | `/protoclaw/assembly_environment/create` | agentId/assemblyName | 用户 assembly workspace 目录 + workspace state | 030 只记录边界 |
| Host/Runtime | `/protoclaw/assembly_runtime/start` | agentId；可带 sessionId | assembly 项目目录 + session index + assembly process registry | 已删除按 session 扫描/默认 flow-workspace owner；Agent 必须显式 |
| Host | `/protoclaw/assembly_runtime/stop` | sessionId | assembly process registry | session 是进程注册表 key |
| Global | `/protoclaw/choice_alerts` | 无 | ViewerWorker runtime 集合 + 进程内去重集合 | 明确是全量集合，不随焦点变化 |
| Global | `/protoclaw/images/upload` | 无 | 用户 images 目录 + hash cache | 本地全局资源 |
| Global | `GET /protoclaw/images/:filename` | filename | 用户 images 目录 | 路径 basename 校验 |
| Global | `/protoclaw/identities*` | workspace/identity path params | Identity registry / session 数据 | 显式 registry key |
| Global | `/protoclaw/open_sessions*` | agentId；restore 带 sessionIds | open-sessions tracker + session index + 进程注册表 | Agent/session 显式，集合恢复为宿主恢复操作 |
| Global | `POST /protoclaw/shutdown` | 无 | Claw 主进程 | 本机进程操作 |
| Global | `/protoclaw/oauth/codex/*` | OAuth session/provider path ids | 用户 OAuth token/config + OAuth 临时状态 | 本地用户服务 |
| Global | `/protoclaw/mcp-gateway/*` | serverId | 宿主 MCP gateway registry/config/process | 全局宿主服务 |
| Global | `/protoclaw/acp/coder/sessions*` | ACP session / Claw session path id | ACP adapter/session registry + Claw session/runtime | 协议会话显式寻址 |
| Global | `/protoclaw/claw-mcp*` | MCP protocol session | Claw MCP server/session | 全局 MCP 服务 |
| Global | `/protoclaw/preflight` | feature/module path fields | 当前装配预检逻辑、项目文件 | 纯预检，不绑定焦点 |

## 已补校验点

- `server/shared/operation-target.js`：Host、Agent、Session、Runtime observation/control 纯函数；无页面焦点读取、无远程字段。
- `server.js` Runtime inbox/execution state：必须显式 `agentId + sessionId`。
- `session.js`：render、handoff export/resume、one-shot、sub resume、compact/resume 使用显式目标；删除 render 的 `qqbot` 默认和 one-shot/resume 的固定 Agent。
- `session-helpers.js`：显式 Agent 存在时只检查该 Agent 的 session index，不扫描其他 Agent 修复目标。
- `agent-lifecycle.js`：todo/force-continuation Runtime 控制必须有 `runtimeId` 或 `sessionId`。
- `tool-state.js`：Runtime 控制必须有 `runtimeId` 或 `sessionId`，删除广播 fallback。
- `model-config.js`：hot-swap 必须有 `runtimeId` 或 `sessionId`，删除广播 fallback；无投递时 `ok:false`。
- `dispatch.js`：poll、agent_status 必须有 `agentId + sessionId`；调度创建保留既有 Host 默认目标行为。
- `server.js` assembly runtime start：必须显式 `agentId`，删除按 session 扫描 owner 及 `flow-workspace` fallback。
- Host/Global 注释已加到 workspace、model config、system feature config、dispatch、tool state、choice alerts、image storage 等入口。

## 定向测试

- `test/operation-target.test.js`：Host 不读焦点、Agent/Session/Runtime 显式字段。
- `test/workspace-normalize.test.js`：workspace state Host 边界。
- `test/model-config-normalize.test.js`：model config Host/Global 边界。
- `test/session-extraction.test.js`：session mutation 目标边界。
- `test/agent-lifecycle.test.js`：Runtime control 缺目标失败。
- `test/tool-state-hook.test.js`：Runtime control 显式 session 夹具及 Hook scope 回归。
- `test/request-target.test.js`、`test/proxy-behavior.test.js`、`test/user-turn-contract.test.js`：028 目标解析与代表性 Viewer 调用回归。

## 未覆盖路由与风险

1. 本票没有重做 029 的所有 Viewer Runtime 端点审计；Viewer `/api/agents/:id/*` 仍以 029/AgentDev 测试为准。
2. `group-chat` 大量 `gc/*` 路由按 chat/thread/identity 数据模型归类为 Host/Session 混合，未在本票重写其既有参数契约；其中 runtime_status 的边界需要后续单独矩阵化。
3. `assembly_runtime/stop` 目前以 assembly sessionId 为进程注册表 key，未新增 owner Agent 字段；保留现有本地 URL/行为，未扩展为跨实例操作。
4. `dispatch` schedule 创建保留历史 `programming-helper` 默认目标，以避免改变既有 Host 调度行为；它不是页面焦点 fallback，但仍是未来明确默认策略的风险点。
5. `model_config` 与 speech config 是全局用户配置；Agent-specific preset/process-mode 路由仍有 Agent 字段，但未在本票引入新 schema 错误元数据。
6. `remote_claw/*`、ACP、MCP gateway、OAuth 等属于本地宿主服务/协议会话，未新增远程字段或跨实例能力；remote_claw 的既有远程实现不在本票扩展。
7. 本票没有修改 `CONTEXT.md`、没有 reset/clean/checkout、没有提交或 push。
