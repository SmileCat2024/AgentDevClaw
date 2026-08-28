# 0011 — protoclaw 域远程适配套路：写操作端点切片

- **Status**: Accepted
- **Date**: 2026-08-28
- **来源**: Phase 2 第一刀工单（远程写操作端点切片）；上游原则承接 [ADR-0008](0008-remote-claw-connection-architecture.md)（远程权威、命名空间、Host 显式、失败三分类）

## Context

Phase 1（只读）已交付：远程会话经统一投影进入本地侧栏（[ADR-0010](0010-sidebar-unified-projection.md)），读走白名单透传，写一律被本地代理闸以 `remote_write_disabled` 拒绝。Phase 2 把"远程只读"翻转为"远程可写"：远程会话像本地会话一样接收输入、切换模型、中断。本 ADR 固化翻转时所有 protoclaw 域写端点必须遵守的同一条适配套路，避免每个端点各发明一套。

## Decision

### 1. 本地优先：本地 scope 现行为字节级不动

任何路由的远程适配都以分支形式叠加在既有本地路径之上：本地请求的解析、IPC、响应形态保持与改动前逐字节一致。远程分支只由显式的 `remote:` 命名空间身份触发；本地身份永不进入远程分支，远程身份也永不 fallback 到本地执行（ADR-0008 #1）。

### 2. 目标身份统一走 request-target 家族

agentId / runtimeId / sessionId 别名族（`request-target.js` 的 `IDENTITY_FIELDS`）是唯一合法身份入口。远程命名空间的编解码只由服务端完成（`parseRemoteNamespace`），前端与远程端把 `remote:<connId>:<id>` 当不透明字符串。

### 3. 远程适配 = 转发基址 + 裸 id + operation 契约失败形态

- **转发基址**：`forwardBase(target) = target.origin || target.viewerOrigin`。远程 target 由 `resolveRuntimeTarget` / `resolveHostTarget` 解析出隧道 origin（`http://127.0.0.1:<localPort>`，ADR-0008 #3）；本地 target 沿用本地 viewerOrigin。
- **裸 id**：转发前剥离 `remote:<connId>:` 前缀（`bareId`）。URL 中的命名空间由 `rewriteProxyUrl` 还原（代理闸路径），body/query 中的命名空间由路由内分支自行还原。
- **失败形态**：三分类 + retryable，复用 `operation-contract.js`（`transport_unavailable` 可重试 / `target_not_found` 404 / `operation_rejected` 403-502 显式拒绝）。禁止为远程写新造错误码、确认弹窗、特殊重试层或离线队列——失败与本地同一套契约：乐观提交 + 契约失败形态提示。

共享取用收敛在 `server/shared/remote-forward.js`（转发基址、裸 id、命名空间 → 显式 host target）。不放进 `request-target.js`：后者是无 I/O、无单例的纯解析层且被 `proxy.js` 依赖，转发需要读取宿主装配态（ConnectionStore 查找，注册于 proxy），反向依赖会成环。

### 4. 写放行两道闸（本地强制）

代理闸路径（`/api/agents` 族）：

- **白名单扩列**：`input`、`queued-inputs`、`interrupt`、`user-turn` 四个写资源放行，转发语义与读一致（隧道 origin + `rewriteProxyUrl` 还原裸 id）。白名单之外的写维持 `remote_write_disabled`。
- **幂等闸**：远程写请求必须携带幂等键（既有 operationId 体系的 `idempotencyKey`，经 `x-idempotency-key` 头或 query 传递）；无键本地闸直接 400（`idempotency_key_required`，不可重试），请求不过隧道。本地请求不要求幂等键——本地分支零改动。

protoclaw 族（路由内命名空间分支，不走代理闸）：路由识别 `remote:` 前缀身份 → 经共享 helper 转发到远程同名路由（裸 id），返回远程响应原文；本地分支保持既有 IPC 路径。Host 域读（`model_config` preset 列表）按当前会话命名空间派生 connectionId，经 `resolveHostTarget` 显式转发（ADR-0008 #5：host 默认本地、远程必须显式），远程返回自己的 preset 列表，远程端零改动（ADR-0008 #6）。

### 5. 门控：capabilities.write 随握手流动

- 远程 `app_info` 增加 `capabilities.write` 布尔（生产侧 `agent-lifecycle.js` 的 app_info 路由）；本地握手（`connection-health.js`，现做版本校验处）采集之，旧远程无此字段视为 `false`。
- capability 经连接状态（`statusOf.appInfo`）→ 目录聚合（catalog section）→ 前端连接表流动；断线清空、重连握手后自动刷新。
- 前端 readOnlyMode 从"远程 = 只读"改为"远程且无写能力才只读"；具备写能力的远程会话体验与本地完全一致，UI 不出现任何远程标识。本地会话永不 readOnly（按能力判定）。

### 6. 语音链路零改动

浏览器 MediaRecorder → 本地 `/protoclaw/speech_to_text`（host 域，本地 ASR）→ 文本进 textarea → 提交走 input 链路。用谁的麦克风就用谁的 ASR，远程语音模型配置不参与。

## 首个消费者清单

| 端点 / 位置 | 家族 | 远程适配 |
|---|---|---|
| `POST /api/agents/:id/input`、`/queued-inputs`、`/interrupt`、`/user-turn` | 代理闸 | 白名单放行 + 幂等闸，转发语义与读一致 |
| `submitUserTurn`（`server/shared/user-turn.js`，input-gateway / embedded-connector 的服务端投递客户端） | protoclaw | `forwardBase` 修转发基址（远程 target 不再拼出 undefined URL），agentId 已是裸 id |
| `POST /protoclaw/swap_model`、`POST /protoclaw/swap_thinking_effort` | protoclaw | 路由内命名空间分支 → 转发远程同名路由（裸 runtimeId/agentId/sessionId） |
| `GET /protoclaw/model_config` | protoclaw（host 域） | 会话命名空间 → `resolveHostTarget` 显式转发，远程返回自己的 preset 列表 |
| `GET /protoclaw/app_info` + 握手 | capability | 生产 `capabilities.write`；握手采集；catalog 透传；前端门控 |

## Consequences

- 写路径与读路径共用同一条隧道与同一套失败契约；远程写故障的表现形态与本地一致，不再有独立通道需要独立排查。
- 幂等闸只在本地代理层强制：旧前端对远程提交会得到显式 400（而非静默丢失），推动客户端统一携带幂等键。
- 语音自动发送路径（`voice-input.js`）不在本刀授权范围内，不携带幂等键；对远程会话将被闸显式拒绝并按既有失败形态提示，记录为已知边界。
- capability 依赖握手周期与 catalog 刷新节奏，断线→重连之间存在一个刷新周期的"仍只读"窗口，属保守方向的偏差，可接受。
