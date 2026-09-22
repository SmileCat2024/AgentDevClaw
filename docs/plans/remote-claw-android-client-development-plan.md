# Remote Claw Android 客户端与自建中继服务开发文档

> 状态：设计草案  
> 日期：2026-07-10  
> 目标：为 AgentDevClaw 增加一个独立于现有 IM 渠道的远程客户端能力，使 Android 客户端可以通过自建公网中继服务稳定访问本地 Claw/Agent runtime。

## 1. 背景与目标

AgentDevClaw 当前已经有 IM 渠道能力，可以通过 QQ、微信、飞书、企业微信等平台把外部消息路由到内部 Agent 会话。但 IM 渠道的产品目标是“把第三方 IM 平台接入 Agent”，它天然受限于平台消息格式、bot 特性、单渠道绑定、线路转接、回复语义等边界。

本项目要解决的是另一类问题：用户在手机上直接使用自己的 Claw，就像使用一个自建的 GPT 客户端。公网服务器只承担中继与持久化，不理解业务，不替代本地 Claw。用户家中电脑没有公网 IP 时，本地 Claw 主动连公网服务器，Android 客户端也连公网服务器，三者通过可恢复的事件同步协议通信。

本项目的核心诉求是：

- 稳定可靠：消息不丢、顺序不乱、断线可恢复、重复可去重。
- 自建部署：服务端部署简单，适合用户自己在公网服务器上运行。
- 多用户共享：一台中继服务器可以服务多个用户、多个本地 Claw、多个 Android 设备。
- 独立于 IM：不能继承现有 IM 渠道的 carrier/line/portal 限制。
- 渐进实现：第一版只覆盖核心对话与状态同步，不追求覆盖 Claw 所有高级能力。

## 2. 非目标

第一阶段明确不做以下事情：

- 不把 Android 作为 `qq/weixin/feishu/wecom` 后的“第五个 IM 渠道”。
- 不复用 IM 工作空间的 portal agent、line binding、carrier 互斥模型。
- 不依赖 FCM、厂商推送、第三方长连接服务或任何付费推送服务。
- 不承诺 Android 后台被系统休眠时仍然秒级实时收到消息。
- 不在公网服务器上执行用户 Agent、读取用户本地文件或保存完整工作目录。
- 不做复杂多媒体、语音、文件管理、完整工具面板。
- 不要求服务器理解 AgentDev 的内部推理逻辑；服务器只保存事件与命令。

## 3. 与现有 IM 架构的关系

现有 IM 架构只能作为反例和局部技术参考。

### 3.1 可借鉴部分

- 配置写入串行化：`server/routes/im.js` 中的 `createConfigSerializer()` 证明并发配置写入需要串行队列。
- runtime 状态聚合：`/protoclaw/im_routable_targets` 聚合运行中会话、模型信息、执行状态的思路可参考。
- 群聊桥接机制：`local-features/group-admin/src/bridge.ts` 中 long-poll inbox、busy buffer、CallStart/StepStart 注入、CallFinish 回写等机制可参考。
- ViewerWorker 代理接口：`server.js` 已代理 `/api/agents/:agentId/input`、`queue-input`、`interrupt`、`notification` 等接口。

### 3.2 必须避免继承的限制

现有 IM 的核心模型是：

- `IM_CHANNELS` 注册表定义第三方平台。
- portal agent 选择一个 selectedChannel。
- line 绑定 carrier 和某个运行中 session。
- 同一个 carrier 不能被 portal 和多个 line 同时占用。
- 消息以“外部平台消息 -> Agent -> 平台回复”为主。

Remote Claw 的核心模型应该是：

- workspace/device/session/event/command。
- 每个会话是一条可恢复事件流。
- Android 可以看到完整会话镜像。
- 所有消息和状态变化都以事件形式同步。
- 可靠性由事件日志、ACK、cursor、幂等保证。

因此 Remote Claw 需要新建独立模块，而不是扩展 `server/shared/im-channels.js`。

### 3.3 代码审计后的强制修正

这一节是对前面设想的自我质疑：如果不按这里修正，设计看起来完整，但真正接到 AgentDevClaw 时会断。

| 原设计倾向 | 代码事实 | 必须修正 |
|---|---|---|
| 用 prebuilt `agentId` 直接发送输入 | 前端实际向 `/api/agents/:runtimeId/input` 和 `/queue-input` 发送，`runtimeId` 来自 `runtime_session_id` / `viewerAgentId` | Remote Session 必须同时保存业务身份 `agentId + localSessionId` 和运行时身份 `viewerAgentId` |
| 把消息同步设计成 token delta 流 | 现有前端主要轮询 `/messages`、`/notification`、`/overview`、`/todo`，`notification` 只提供运行状态和计数 | 第一版以本地 transcript snapshot 为准，实时连接只传 hint/status，delta 只能作为后续优化 |
| connector 可以读写 session 文件完成同步 | `scripts/run-prebuilt-agent.js` 通过 `FileSessionStore`、`enableStepAutoSave()`、`CallArbiter`、`/protoclaw/session_meta_sync` 维护会话一致性 | connector 只读 snapshot，不直接修改 session 文件；输入必须走 ViewerWorker 或本地 Remote API 包装后的同等路径 |
| `session_id` 可为空且仍按 `(workspace, session, seq)` 唯一 | SQLite 中 NULL 不会触发普通唯一冲突 | event 必须引入非空 `streamId`，workspace 级事件使用固定 stream |
| 所有 agent 会话都一样 | `feature-creator`、`agent-creator`、`programming-helper`、`flow-workspace` 是 workspace-bound agent，session 根目录和普通 prebuilt agent 不同；assembly runtime 又有另一套启动路径 | MVP 优先支持普通 managed prebuilt runtime；workspace-bound 可以展示和读取，但控制能力要逐个适配 |

现有真实输入链路应被视为 Remote Claw 的落地基线：

```text
Android Outbox
  -> Relay commands(clientMsgId)
  -> Local Connector pull
  -> resolve RemoteSession(agentId, localSessionId, viewerAgentId?)
  -> if needed: POST /protoclaw/prebuilt_sessions/activate
  -> POST /api/agents/{viewerAgentId}/queue-input
  -> ViewerWorker DebugHub queued handler
  -> CallArbiter.enqueue(source='queued-input')
  -> agent.onCall()
  -> enableStepAutoSave()
  -> /protoclaw/session_meta_sync
  -> connector observes transcript snapshot
  -> Relay transcript events
  -> Android Room cache/UI
```

## 4. 总体架构

系统由三部分组成：

```text
┌─────────────────────┐
│ Android Client       │
│ - UI                 │
│ - Local SQLite cache │
│ - Outbox             │
│ - WebSocket/HTTP sync│
└──────────┬──────────┘
           │ Internet
           │
┌──────────▼──────────┐
│ Relay Server         │
│ - Auth/device tokens │
│ - Event log          │
│ - Command queue      │
│ - ACK/cursor         │
│ - WebSocket/SSE/HTTP │
└──────────┬──────────┘
           │ outbound connection
           │
┌──────────▼──────────┐
│ Local Claw Connector │
│ - Runs near Claw     │
│ - Observes runtime   │
│ - Sends events       │
│ - Executes commands  │
└──────────┬──────────┘
           │ localhost
           │
┌──────────▼──────────┐
│ AgentDevClaw         │
│ - server.js          │
│ - ViewerWorker       │
│ - Agent runtime      │
│ - Session store      │
└─────────────────────┘
```

### 4.1 Relay Server

Relay Server 是公网中继服务。它不执行 Agent，不保存用户本地文件，不依赖 AgentDevClaw 项目代码。它负责：

- 用户和设备认证。
- workspace 注册。
- 本地 connector 在线状态维护。
- Android 设备在线状态维护。
- 持久化事件日志。
- 持久化 command queue。
- 为客户端提供增量同步接口。
- 为在线连接推送新事件提示。

### 4.2 Local Claw Connector

Local Claw Connector 运行在用户电脑上，与本地 AgentDevClaw 在同一机器或同一局域网中。它主动连接公网 Relay Server，因此不需要本地公网 IP。

它负责：

- 注册本地 workspace。
- 读取本地 AgentDevClaw 的 agent/session/runtime 状态。
- 监听或轮询本地会话消息变化。
- 将本地事件 append 到 Relay Server。
- 拉取 Android 发来的 command。
- 将 command 转换成本地 Claw API 调用。
- 将执行结果、错误、中断等同步回 Relay Server。

### 4.3 Android Client

Android 客户端是 Remote Claw 的主要用户界面。它负责：

- 设备登录和绑定。
- 展示 workspace、agent、session 列表。
- 展示会话消息流。
- 发送用户输入。
- 展示运行状态和排队状态。
- 本地缓存事件。
- 维护 outbox。
- 断线后补拉事件。

### 4.4 代码对齐的数据流

发送普通消息：

```text
Android Room Outbox
  -> POST Relay /commands(message.send, clientMsgId)
  -> connector GET /commands
  -> local /protoclaw/remote/sessions/:agentId/:sessionId/send
  -> local /protoclaw/prebuilt_sessions/activate when viewerAgentId is missing
  -> ViewerWorker /api/agents/:viewerAgentId/queue-input
  -> DebugHub queued input handler
  -> CallArbiter.enqueue()
  -> agent.onCall()
  -> session autosave + /protoclaw/session_meta_sync
  -> connector transcript snapshot
  -> Relay stream events
  -> Android stream cursor pull
```

打开会话：

```text
Android session.open command
  -> connector
  -> /protoclaw/prebuilt_sessions/activate
  -> startManagedAgent()
  -> parse/register viewerAgentId
  -> /protoclaw/get_connected_agents exposes runtime_session_id
  -> connector updates RemoteSession.viewerAgentId
```

读取消息：

```text
connector local snapshot
  -> message-normalizer(role/content/toolCalls/reasoning/images/usage)
  -> append or transcript.replaced
  -> Android Room Message/Event tables
```

## 5. 可靠性原则

由于不使用推送服务，系统必须把可靠性建立在协议层，而不是连接保活上。

### 5.1 可靠性承诺

第一阶段承诺：

- 前台在线时尽量实时。
- 网络断开后自动恢复。
- Android 发出的消息不会因为短暂断网丢失。
- Local Claw 离线时，Android command 会留在服务端等待 connector 上线。
- connector 上线后按顺序执行 command。
- 所有事件支持从 cursor 补拉。
- 重复提交不会产生重复消息。

第一阶段不承诺：

- App 被 Android 系统休眠后仍实时收到每条消息。
- App 被用户强杀后仍后台接收。
- 无用户授权的后台常驻。
- 第三方推送级别的实时提醒。

### 5.2 实时性分级

| 场景 | 机制 | 预期 |
|---|---|---|
| Android 前台 | WebSocket | 实时 |
| Android 后台但前台服务开启 | Foreground service + WebSocket/轮询 | 尽量实时 |
| Android 后台且被系统限制 | WorkManager/下次打开补拉 | 不保证实时，但不丢 |
| Local Claw 在线 | WebSocket 到 Relay | 实时执行 command |
| Local Claw 离线 | command 持久化 | 上线后补执行 |

### 5.3 可靠性核心机制

- Event log：服务端保存每个 stream 的事件日志。
- Cursor：每个客户端保存已经处理到的 stream sequence 和 workspace global sequence。
- ACK：客户端处理事件后上报 ack。
- Idempotency key：客户端写 command 时必须带 `client_msg_id`。
- Outbox：Android 先写本地 outbox，再尝试上传。
- Inbox：connector 从服务端拉取待执行 command。
- Dedup：服务端按 idempotency key 去重。
- Gap detection：客户端发现 seq 不连续时强制补拉。
- Retry with backoff：所有网络失败都指数退避重试。

## 6. 数据模型

以下是 Relay Server 的核心实体。

### 6.1 User

```ts
interface User {
  id: string;
  username: string;
  passwordHash?: string;
  createdAt: string;
  disabledAt?: string | null;
}
```

第一版可以支持单管理员创建邀请码，也可以支持环境变量初始化第一个管理员。

### 6.2 Workspace

```ts
interface Workspace {
  id: string;
  ownerUserId: string;
  name: string;
  deviceName: string;
  connectorId: string;
  status: 'online' | 'offline';
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Workspace 对应一台本地 Claw 实例，而不是一个 Agent。

### 6.3 Device

```ts
interface Device {
  id: string;
  userId: string;
  type: 'android' | 'connector';
  name: string;
  tokenHash: string;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt?: string | null;
}
```

Android 和 connector 都是 device。权限由 device token 控制。

### 6.4 Remote Session

```ts
interface RemoteSession {
  id: string;
  workspaceId: string;

  // Stable local business identity.
  agentId: string;
  localSessionId: string;

  // Runtime identity exists only while the local managed runtime is running.
  viewerAgentId?: string | null;
  runtimeSessionId?: string | null;

  title: string;
  status: 'idle' | 'running' | 'queued' | 'offline' | 'error';
  streamId: string;          // "session:{id}"
  lastSeq: number;           // last seq in this session stream
  lastMessageAt: string | null;

  sessionType?: string | null;
  archived?: boolean;
  todo?: boolean;
  openDirectory?: string | null;
  messageCount?: number;
  preview?: string | null;
  tokenUsage?: unknown;
  savedAt?: string | null;
  fileMtimeMs?: number | null;
  fileSize?: number | null;
  metaVersion?: number;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}
```

`localSessionId` 是 AgentDevClaw 本地 session id。Relay Server 不需要理解其内部存储路径，但必须保存 `agentId + localSessionId` 到 remote `id` 的映射。

`viewerAgentId` 不是 session id。它来自本地 managed runtime 启动后打印和登记的 ViewerWorker 运行时 ID，前端现有 `/api/agents/:id/input`、`queue-input`、`interrupt` 都依赖它。它可能为空，也可能在 runtime 重启后变化。

### 6.5 Event

```ts
interface RemoteEvent {
  id: string;
  workspaceId: string;
  streamId: string;          // "workspace" or "session:{remoteSessionId}"
  scopeType: 'workspace' | 'session' | 'runtime';
  scopeId: string;           // workspaceId, remoteSessionId, or viewerAgentId
  seq: number;               // monotonic inside streamId
  globalSeq: number;         // monotonic inside workspace, for notification ordering
  source: 'connector' | 'android' | 'server';
  type: RemoteEventType;
  payloadJson: string;
  clientMsgId?: string | null;
  createdAt: string;
}
```

`seq` 在同一个 `streamId` 内单调递增。workspace 级事件使用固定 `streamId = "workspace"`，session 级事件使用 `streamId = "session:{remoteSessionId}"`。客户端按 stream cursor 补拉，列表页也可以按 `globalSeq` 快速拉取 workspace 级通知。

### 6.6 Command

```ts
interface RemoteCommand {
  id: string;
  workspaceId: string;
  target: {
    remoteSessionId?: string | null;
    agentId?: string | null;
    localSessionId?: string | null;
    viewerAgentId?: string | null;
  };
  sessionId?: string | null;
  seq: number;
  type: RemoteCommandType;
  payloadJson: string;
  clientMsgId: string;
  status: 'pending' | 'delivered' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  resultJson?: string | null;
  error?: string | null;
  createdByDeviceId: string;
  createdAt: string;
  updatedAt: string;
}
```

Command 是 Android 发给本地 Claw connector 的控制请求。Command 自身也应产生 event，让 UI 可以展示“已发送、等待本地电脑、执行中、完成/失败”。

`target.viewerAgentId` 只能作为命令创建时的提示，不能作为长期真实身份。connector 执行前必须用 `remoteSessionId` 重新解析当前本地 runtime；如果 runtime 未启动，必须先根据 command 类型决定是否启动 session。

## 7. Event 类型

第一阶段建议支持以下事件。

### 7.1 会话结构事件

```ts
type RemoteEventType =
  | 'workspace.snapshot'
  | 'workspace.status'
  | 'agent.list'
  | 'session.list'
  | 'session.created'
  | 'session.updated'
  | 'session.deleted'
  | 'session.status';
```

用途：

- Android 首次进入时加载 workspace 概览。
- connector 定期上报 session 列表。
- session 标题、更新时间、运行状态变化同步。

### 7.2 消息事件

```ts
type MessageEventType =
  | 'message.user'
  | 'message.assistant'
  | 'message.system'
  | 'message.tool_call'
  | 'message.tool_result'
  | 'message.error';
```

建议 payload：

```ts
interface MessagePayload {
  localMessageId?: string;
  ordinal: number;
  transcriptVersion: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  turn?: number | null;
  callIndex?: number | null;
  toolCallId?: string | null;
  toolCalls?: unknown[] | null;
  reasoning?: string | null;
  usage?: unknown;
  images?: Array<{
    mimeType?: string | null;
    url?: string | null;
    dataRef?: string | null;
    width?: number | null;
    height?: number | null;
  }>;
  source?: string | null;
  raw?: unknown;
  contentHash: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

这组字段来自现有渲染和会话文件的真实需求：`server/conversation-renderer.js` 会处理 `role/content/turn/toolCallId/toolCalls/reasoning/usage`，前端聊天渲染还会处理 user `images`、assistant `reasoning/toolCalls`、tool result 的 JSON 内容。Remote 的 normalize 不能只保留纯文本，否则 Android 会从第一版开始丢工具调用、图片输入、reasoning 和 usage。

不要把 `localMessageId = turn + role + index` 当成永久真相。rollback、compact、分支恢复、session 文件重写都可能让消息序列变化。更稳的模型是：

- 每次同步产生一个 `transcriptVersion`。
- 消息使用当前 transcript 的 `ordinal` 表示显示顺序。
- `contentHash` 用于辅助去重和检测替换。
- Relay 支持 `transcript.replaced` 事件，让 Android 用新快照替换某个 session 的本地消息表。

### 7.3 流式事件

第一版不应该实现 token 级流式，只做“运行中状态 + transcript snapshot”。理由不是偷懒，而是现有 AgentDevClaw 前端的数据流本来就是：

- `/api/agents/:viewerAgentId/messages` 提供消息快照。
- `/api/agents/:viewerAgentId/notification` 提供 runtime 阶段、`callActive`、字符数、tool 计数、当前工具名等状态。
- `/api/agents/:viewerAgentId/overview`、`/todo`、`/input-requests` 提供旁路状态。

如果 Remote 第一版自己发明 token delta，会比现有网页端更难验证，而且会制造另一套会话重建规则。后续如果要实现流式，建议事件类型：

```ts
type StreamEventType =
  | 'stream.started'
  | 'stream.delta'
  | 'stream.finished'
  | 'stream.failed';
```

流式 payload：

```ts
interface StreamDeltaPayload {
  streamId: string;
  messageId: string;
  delta: string;
  index: number;
}
```

客户端必须支持 delta 丢失后回退到全量补拉。不能只依赖 delta 重建最终消息。

### 7.4 工具与运行状态事件

```ts
type RuntimeEventType =
  | 'runtime.status'
  | 'runtime.call_started'
  | 'runtime.call_finished'
  | 'runtime.call_failed'
  | 'runtime.queue_updated'
  | 'runtime.interrupted'
  | 'runtime.input_request';
```

第一版 UI 只需展示：

- running/idle/offline。
- 当前是否有待输入。
- 是否可 interrupt。
- 最近错误。

## 8. Command 类型

Android 第一阶段需要的 command：

```ts
type RemoteCommandType =
  | 'session.open'
  | 'session.create'
  | 'session.rename'
  | 'message.send'
  | 'message.queue'
  | 'runtime.interrupt'
  | 'input_request.respond'
  | 'workspace.refresh';
```

### 8.1 message.send

```ts
interface SendMessageCommand {
  text: string;
  mode?: 'queue';
  attachments?: Array<{
    name: string;
    mimeType: string;
    objectId: string;
  }>;
}
```

执行语义：

- connector 先用 `remoteSessionId -> agentId + localSessionId` 解析目标。
- 如果没有当前 `viewerAgentId`，先激活本地 session。
- 默认调用 `/api/agents/:viewerAgentId/queue-input`。
- 只有 `input_request.respond` 带明确 request/choice 时，才调用 `/api/agents/:viewerAgentId/input`。
- 服务端必须记录 command 状态变化。

### 8.2 runtime.interrupt

```ts
interface InterruptCommand {
  reason?: string;
}
```

connector 解析当前 `viewerAgentId` 后调用本地 `/api/agents/:viewerAgentId/interrupt`。如果 session 当前没有运行时，返回 succeeded/no-op，并产生 `runtime.interrupt.noop` 或 command result，不能让 Android 无限等待。

### 8.3 workspace.refresh

触发 connector 立即重新拉取本地 workspace/session/runtime 状态，并 append snapshot event。

## 9. Relay Server API 设计

Relay Server 建议使用 Node.js + Express/Fastify + SQLite。第一版优先简单可靠。

### 9.1 认证 API

```http
POST /api/auth/login
POST /api/auth/logout
POST /api/devices/register
POST /api/devices/revoke
GET  /api/me
```

设备 token 只在创建时返回一次，服务端只保存 hash。

### 9.2 Workspace API

```http
GET  /api/workspaces
POST /api/workspaces/register
GET  /api/workspaces/:workspaceId
PATCH /api/workspaces/:workspaceId
```

connector 第一次启动时调用 register，拿到 workspace id。

### 9.3 Event API

```http
GET  /api/workspaces/:workspaceId/events?after_global_seq=123&limit=500
GET  /api/workspaces/:workspaceId/streams/:streamId/events?after_seq=123&limit=500
POST /api/workspaces/:workspaceId/events
POST /api/workspaces/:workspaceId/ack
```

`POST /events` 主要由 connector 调用，也允许 Android 写本地用户消息镜像事件，但推荐 Android 只写 command，由 connector 执行后产生最终事件。

### 9.4 Session API

```http
GET /api/workspaces/:workspaceId/sessions
GET /api/workspaces/:workspaceId/sessions/:sessionId
GET /api/workspaces/:workspaceId/sessions/:sessionId/transcript
```

### 9.5 Command API

```http
POST /api/workspaces/:workspaceId/commands
GET  /api/workspaces/:workspaceId/commands?after_seq=123&status=pending
POST /api/workspaces/:workspaceId/commands/:commandId/ack
POST /api/workspaces/:workspaceId/commands/:commandId/result
```

Android 写 command，connector 拉 command。

### 9.6 Realtime API

```http
GET /api/realtime/ws
```

WebSocket 消息类型：

```ts
type WsEnvelope =
  | { type: 'hello'; deviceId: string; workspaceIds: string[] }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number }
  | { type: 'event_hint'; workspaceId: string; streamId: string; latestSeq: number; latestGlobalSeq: number }
  | { type: 'command_hint'; workspaceId: string; latestSeq: number }
  | { type: 'ack'; ref: string }
  | { type: 'error'; error: string };
```

注意：WebSocket 只负责“提示有新东西”，真正的数据仍通过 HTTP 增量接口拉取。这样断线恢复简单，且不会因为 WebSocket 消息丢失导致数据丢失。

## 10. Relay Server 数据库设计

第一版使用 SQLite，表结构建议：

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  connector_device_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  last_seen_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(owner_user_id) REFERENCES users(id)
);

CREATE TABLE remote_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  local_session_id TEXT NOT NULL,
  viewer_agent_id TEXT,
  runtime_session_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT,
  session_type TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  todo INTEGER NOT NULL DEFAULT 0,
  open_directory TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  token_usage_json TEXT,
  saved_at TEXT,
  file_mtime_ms INTEGER,
  file_size INTEGER,
  meta_version INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, stream_id),
  UNIQUE(workspace_id, agent_id, local_session_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  global_seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  client_msg_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, stream_id, seq),
  UNIQUE(workspace_id, global_seq),
  UNIQUE(workspace_id, client_msg_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  remote_session_id TEXT,
  target_agent_id TEXT,
  target_local_session_id TEXT,
  target_viewer_agent_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  client_msg_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_by_device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, seq),
  UNIQUE(workspace_id, client_msg_id),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);

CREATE TABLE client_cursors (
  device_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_command_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(device_id, workspace_id, stream_id)
);
```

实现 seq 分配时必须放在事务里：

```sql
BEGIN IMMEDIATE;
SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE workspace_id = ? AND stream_id = ?;
SELECT COALESCE(MAX(global_seq), 0) + 1 FROM events WHERE workspace_id = ?;
INSERT INTO events (...);
COMMIT;
```

后续可以维护单独的 counters 表优化性能。

## 11. Local Claw Connector 设计

Local Connector 可以先作为 AgentDevClaw repo 内的 Node.js 脚本实现，例如：

```text
scripts/remote-claw-connector.js
server/remote-claw/
```

后续再拆成独立包。

### 11.1 启动配置

建议支持：

```bash
node scripts/remote-claw-connector.js \
  --relay https://relay.example.com \
  --token rc_xxx \
  --local http://127.0.0.1:1420 \
  --workspace-name "Home PC"
```

环境变量：

```bash
REMOTE_CLAW_RELAY_URL=
REMOTE_CLAW_DEVICE_TOKEN=
REMOTE_CLAW_LOCAL_ORIGIN=http://127.0.0.1:1420
REMOTE_CLAW_WORKSPACE_NAME=
```

### 11.2 本地状态采集

connector 第一版可以轮询本地接口：

- `GET /protoclaw/get_connected_agents` 获取 prebuilt agent、running runtime、`runtime_session_id`、`callActive`。
- `GET /protoclaw/prebuilt_sessions?agentId=...` 获取本地 session index。
- `GET /protoclaw/session_record?agentId=...&sessionId=...` 获取单个 session 的简化消息。
- `GET /protoclaw/render_conversation` 可作为消息渲染兼容性的对照接口。
- `GET /api/agents/:viewerAgentId/notification` 获取 running/callActive、stage、字符数、工具计数、当前工具名、错误等。
- `GET /api/agents/:viewerAgentId/queued-inputs` 获取队列。
- `GET /api/agents/:viewerAgentId/connection` 获取 ViewerWorker 连接状态。

如果现有接口不足，可以在 AgentDevClaw 本地 server 增加只读接口：

```http
GET /protoclaw/remote/snapshot
GET /protoclaw/remote/sessions
GET /protoclaw/remote/sessions/:agentId/:sessionId/messages?since_turn=...
```

现有 session index 字段必须认真映射，不能只取标题：

| 本地字段 | Remote 字段 | 说明 |
|---|---|---|
| `id` | `localSessionId` | 本地 session 文件身份 |
| `title` / `taskTitle` | `title` | Android 列表主标题 |
| `featureName` / `agentName` | `metadata.agentName` | 用于区分不同 agent 类型 |
| `taskType`、`goal`、`constraints`、`expectedOutput` | `metadata.*` | 这些是任务上下文，不应在远端丢失 |
| `targetFiles`、`referenceMaterials` | `metadata.*` | 未来文件/附件能力的入口 |
| `openDirectory` | `openDirectory` | workspace-bound agent 特别重要 |
| `sessionType` | `sessionType` | 区分普通会话、任务会话、特殊工作流 |
| `archived`、`todo` | `archived`、`todo` | Android 列表筛选需要 |
| `metadata.messageCount` / `messageCount` | `messageCount` | 列表摘要和同步校验 |
| `metadata.preview` / rendered preview | `preview` | 列表摘要 |
| `metadata.tokenUsage` | `tokenUsage` | 成本/上下文展示 |
| `metadata.savedAt` / file mtime | `savedAt`、`fileMtimeMs` | 增量同步依据 |

workspace-bound agent 要单独标记。代码里 `feature-creator`、`agent-creator`、`programming-helper`、`flow-workspace` 的 session 根目录不同，不能假设所有 session 都在 `prebuilt-sessions/{agentId}` 下。

### 11.3 本地 command 执行

connector 根据 command 调用本地 API：

| Command | 本地动作 |
|---|---|
| `message.send` | 默认先确保 session runtime 已启动，然后 `POST /api/agents/:viewerAgentId/queue-input` |
| `message.respond_input_request` | 有明确 `requestId` 时才 `POST /api/agents/:viewerAgentId/input` |
| `message.queue` | 同 `message.send`，保留为兼容别名 |
| `runtime.interrupt` | 仅当当前有 `viewerAgentId` 时 `POST /api/agents/:viewerAgentId/interrupt`，否则返回 no-op |
| `session.open` | `POST /protoclaw/prebuilt_sessions/activate`，等待返回/刷新出的 `runtime_session_id` |
| `session.create` | `POST /protoclaw/prebuilt_sessions`，随后按需要 activate |
| `workspace.refresh` | 重新上报 snapshot |

`message.send` 不应优先走 `/input`。现有 UI 在跨会话/持久输入场景使用 `/queue-input`，`scripts/run-prebuilt-agent.js` 的 `DebugHub.setQueuedInputHandler()` 会把它送入 `CallArbiter.enqueue({ source: 'queued-input', ... })`。这条路径不要求当前正挂起某个 input request，更适合 Android 远程发送。

执行 `message.send` 的最小算法：

```ts
async function executeMessageSend(cmd) {
  const target = await resolveRemoteSession(cmd.target.remoteSessionId);
  let viewerAgentId = target.viewerAgentId;

  if (!viewerAgentId) {
    const activated = await postLocal('/protoclaw/prebuilt_sessions/activate', {
      agentId: target.agentId,
      sessionId: target.localSessionId,
    });
    viewerAgentId = activated?.agent?.runtime_session_id
      || activated?.agent?.runtimeSessionId
      || activated?.runtime?.viewerAgentId;
  }

  if (!viewerAgentId) {
    throw new Error('Local runtime did not expose viewerAgentId after activation');
  }

  await postLocal(`/api/agents/${encodeURIComponent(viewerAgentId)}/queue-input`, {
    text: cmd.payload.text,
    images: cmd.payload.images || [],
    clientMsgId: cmd.clientMsgId,
  });
}
```

connector 必须记录 command 状态：

1. 拉到 command 后标记 delivered。
2. 开始执行标记 running。
3. 本地 API 成功后标记 succeeded。
4. 本地 API 失败后标记 failed，并写入错误。

### 11.4 消息同步策略

第一版最稳妥方式：

- connector 定期读取本地 session snapshot。
- 将本地 messages 规范化成 transcript snapshot。
- 如果只是尾部追加，发送 `message.*` 事件。
- 如果发现历史 ordinal、turn、hash 变化，发送 `transcript.replaced` 事件。
- Relay Server 按 `streamId + transcriptVersion + ordinal` 保存 Android 可重放状态。

推荐 localMessageId：

```text
{agentId}:{localSessionId}:{transcriptVersion}:{ordinal}:{contentHash8}
```

connector 需要维护每个 session 的上次 transcript 指纹：

```text
snapshotHash = sha256(JSON.stringify(messages.map(m => [
  m.role,
  m.turn,
  m.toolCallId,
  m.contentHash,
  hash(m.toolCalls),
  hash(m.reasoning),
  hash(m.images)
])))
```

如果新 snapshot 的前缀和旧 snapshot 完全一致，只追加新增消息事件。如果前缀不一致，不能硬 append，必须发 `transcript.replaced`，Android 清空该 session 的 message table 后按新 snapshot 插入。

这一点是为了兼容 rollback、compact、手动编辑/恢复 session、以及未来分支能力。Remote 的可靠性不是“永远 append”，而是“最终和本地真实 transcript 一致，并且替换动作可审计”。

### 11.5 连接循环

伪代码：

```ts
async function mainLoop() {
  await registerOrResumeWorkspace();
  connectWebSocket();

  setInterval(reportHeartbeat, 15_000);
  setInterval(syncLocalSnapshot, 5_000);
  setInterval(pullCommands, 2_000);

  onWebSocket('command_hint', pullCommands);
  onNetworkRecovered(syncEverything);
}
```

`syncEverything`：

1. 上报 workspace online。
2. 拉 pending commands。
3. 执行 commands。
4. 采集本地 sessions。
5. append session/status/message events。

## 12. Android 客户端设计

### 12.1 技术选型

推荐第一版原生 Android：

- Kotlin。
- Jetpack Compose。
- Room SQLite。
- OkHttp WebSocket + Retrofit/ktor client。
- WorkManager。
- DataStore 保存 token 和设置。

理由：

- 后台限制、前台服务、网络恢复、SQLite、WorkManager 都是 Android 原生问题。
- 原生 Kotlin 对稳定性、后台行为、崩溃诊断更可控。
- 不需要先引入 React Native/Flutter 的额外桥接复杂度。

### 12.2 本地数据库

Android 本地 Room 表：

```kotlin
@Entity
data class WorkspaceEntity(
  @PrimaryKey val id: String,
  val name: String,
  val status: String,
  val lastSeenAt: String?,
  val updatedAt: String
)

@Entity
data class SessionEntity(
  @PrimaryKey val id: String,
  val workspaceId: String,
  val agentId: String,
  val localSessionId: String,
  val viewerAgentId: String?,
  val streamId: String,
  val title: String,
  val status: String,
  val lastSeq: Long,
  val messageCount: Int,
  val preview: String?,
  val archived: Boolean,
  val todo: Boolean,
  val updatedAt: String
)

@Entity(indices = [Index(value = ["workspaceId", "streamId", "seq"], unique = true)])
data class EventEntity(
  @PrimaryKey val id: String,
  val workspaceId: String,
  val streamId: String,
  val scopeType: String,
  val scopeId: String,
  val seq: Long,
  val globalSeq: Long,
  val type: String,
  val payloadJson: String,
  val createdAt: String
)

@Entity
data class OutboxEntity(
  @PrimaryKey val clientMsgId: String,
  val workspaceId: String,
  val remoteSessionId: String?,
  val streamId: String?,
  val commandType: String,
  val payloadJson: String,
  val status: String,
  val retryCount: Int,
  val nextAttemptAt: Long,
  val createdAt: Long
)

@Entity(primaryKeys = ["workspaceId", "streamId"])
data class CursorEntity(
  val workspaceId: String,
  val streamId: String,
  val lastEventSeq: Long
)
```

### 12.3 页面结构

第一版页面：

1. 登录/绑定页
   - Relay URL。
   - 用户名/密码或设备 token。
   - 测试连接。

2. Workspace 列表页
   - 本地 Claw 名称。
   - online/offline。
   - 最后在线时间。

3. Session 列表页
   - Agent 名称。
   - Session 标题。
   - running/idle/offline。
   - 最近消息摘要。

4. Chat 页
   - 消息流。
   - 输入框。
   - 发送/排队按钮。
   - 中断按钮。
   - 连接状态条。
   - 未同步 outbox 提示。

5. 设置页
   - 后台同步策略。
   - 是否启用前台服务。
   - 同步间隔。
   - 清理缓存。
   - 退出登录。

### 12.4 同步流程

App 启动：

```text
load token
GET /api/me
GET /api/workspaces
for selected workspace:
  GET /sessions
  GET /events?after_global_seq=local_global_cursor
  for active streams: GET /streams/:streamId/events?after_seq=stream_cursor
connect websocket
flush outbox
```

发送消息：

```text
生成 client_msg_id
写 OutboxEntity(status=pending)
UI 立即显示本地 pending bubble
POST /commands
成功：标记 uploaded，等待 command/result event
失败：保留 outbox，退避重试
```

收到 event_hint：

```text
GET /streams/:streamId/events?after_seq=cursor
校验 seq 连续
写入 Room
更新 cursor
POST /ack
刷新 UI
```

断线恢复：

```text
重新登录校验 token
重新连接 websocket
按 cursor 补拉
flush outbox
```

### 12.5 后台策略

无推送服务时，后台策略分三档：

1. 省电模式
   - 不保持长连接。
   - WorkManager 定期同步。
   - 打开 App 时补拉。

2. 平衡模式
   - App 前台实时。
   - 后台定期补拉。
   - 网络恢复后触发一次同步。

3. 实时模式
   - 用户手动开启前台服务。
   - 状态栏常驻通知。
   - 尽量保持 WebSocket。
   - 仍需承认系统可能限制网络。

UI 必须清楚说明：实时模式需要常驻通知和电池优化豁免，且不同手机厂商行为不同。

## 13. 安全设计

### 13.1 传输安全

- 生产必须 HTTPS/WSS。
- 自签证书模式需要 Android 用户明确导入或配置证书 pin。
- token 不能出现在 URL query 中，使用 Authorization header。

### 13.2 设备 token

- token 只展示一次。
- 服务端只存 hash。
- 支持 revoke。
- token 权限应区分 Android 和 connector。

### 13.3 权限模型

第一版：

- 用户只能访问自己拥有的 workspace。
- connector 只能写自己绑定 workspace 的事件、读取 command。
- Android 只能读自己用户下的 workspace、写 command。

后续多用户共享服务器时增加：

- workspace share。
- read-only device。
- session-level permission。

### 13.4 数据最小化

Relay Server 会保存会话消息，所以必须明确：

- 服务端管理员理论上可读消息。
- 可以后续做端到端加密，但第一版不做。
- 第一版至少支持按 workspace 清理事件日志。

### 13.5 端到端加密预留

为了未来支持 E2EE，payload 应保持 `payloadJson` 独立字段。未来可变为：

```ts
interface EncryptedPayload {
  alg: 'xchacha20-poly1305';
  keyId: string;
  nonce: string;
  ciphertext: string;
}
```

第一版不实现，但不要把服务端查询逻辑写死依赖 payload 内部字段。

## 14. 部署设计

### 14.1 Relay Server 部署目标

部署体验目标：

```bash
docker run -d \
  --name remote-claw-relay \
  -p 8080:8080 \
  -v /opt/remote-claw:/data \
  -e REMOTE_CLAW_BASE_URL=https://relay.example.com \
  -e REMOTE_CLAW_ADMIN_USER=admin \
  -e REMOTE_CLAW_ADMIN_PASSWORD=change-me \
  remote-claw-relay:latest
```

或：

```bash
remote-claw-relay --data ./data --port 8080
```

### 14.2 配置项

```env
REMOTE_CLAW_PORT=8080
REMOTE_CLAW_DATA_DIR=/data
REMOTE_CLAW_BASE_URL=https://relay.example.com
REMOTE_CLAW_ADMIN_USER=admin
REMOTE_CLAW_ADMIN_PASSWORD=
REMOTE_CLAW_DATABASE=/data/remote-claw.sqlite
REMOTE_CLAW_LOG_LEVEL=info
REMOTE_CLAW_EVENT_RETENTION_DAYS=90
REMOTE_CLAW_MAX_EVENT_PAYLOAD_BYTES=262144
REMOTE_CLAW_MAX_DEVICES_PER_USER=20
```

### 14.3 反向代理

Nginx 示例：

```nginx
server {
  listen 443 ssl http2;
  server_name relay.example.com;

  ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location /api/realtime/ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

## 15. AgentDevClaw 本地改造点

为了让 connector 稳定工作，建议在 AgentDevClaw 本地 server 增加 Remote 专用只读/控制 API，而不是让 connector 拼凑过多现有 UI API。

### 15.1 新增本地 remote routes

建议文件：

```text
server/routes/remote-claw.js
server/remote-claw/session-snapshot.js
server/remote-claw/message-normalizer.js
```

接口：

```http
GET  /protoclaw/remote/snapshot
GET  /protoclaw/remote/sessions
GET  /protoclaw/remote/sessions/:agentId/:sessionId/messages
POST /protoclaw/remote/sessions/:agentId/:sessionId/open
POST /protoclaw/remote/sessions/:agentId/:sessionId/send
POST /protoclaw/remote/sessions/:agentId/:sessionId/respond-input-request
POST /protoclaw/remote/sessions/:agentId/:sessionId/interrupt
```

这些接口必须是现有能力的稳定包装，而不是第二套 runtime：

| Remote local API | 内部调用 |
|---|---|
| `GET /remote/snapshot` | 聚合 `/protoclaw/get_connected_agents`、`/protoclaw/prebuilt_sessions?agentId=...`、runtime `/notification` |
| `GET /remote/sessions/:agentId/:sessionId/messages` | 读取 session store 或复用 `/protoclaw/session_record`，再走 `message-normalizer` |
| `POST /remote/sessions/:agentId/:sessionId/open` | `/protoclaw/prebuilt_sessions/activate` |
| `POST /remote/sessions/:agentId/:sessionId/send` | resolve/activate runtime 后 `/api/agents/:viewerAgentId/queue-input` |
| `POST /remote/sessions/:agentId/:sessionId/respond-input-request` | `/api/agents/:viewerAgentId/input`，必须带 requestId/choice |
| `POST /remote/sessions/:agentId/:sessionId/interrupt` | `/api/agents/:viewerAgentId/interrupt` |

Remote API 不允许直接写 `FileSessionStore`。session 文件只能由现有 Agent runtime、autosave、session meta sync 等路径维护。

### 15.2 snapshot 格式

```ts
interface LocalRemoteSnapshot {
  workspace: {
    id: string;
    name: string;
    projectRoot: string;
    appVersion: string;
  };
  agents: Array<{
    id: string;
    name: string;
    icon?: string | null;
    status: string;
  }>;
  sessions: Array<{
    remoteSessionKey: string;     // `${agentId}:${sessionId}` before relay id is known
    agentId: string;
    sessionId: string;
    title: string;
    status: 'idle' | 'running' | 'queued' | 'offline';
    messageCount: number;
    updatedAt: string | null;
    viewerAgentId?: string | null;
    runtimeSessionId?: string | null;
    sessionType?: string | null;
    archived?: boolean;
    todo?: boolean;
    openDirectory?: string | null;
    preview?: string | null;
    tokenUsage?: unknown;
    workspaceBound?: boolean;
    file?: {
      mtimeMs?: number | null;
      size?: number | null;
    };
  }>;
}
```

### 15.3 message normalize

本地 session snapshot 中可能包含 AgentDev 内部字段。Remote API 应输出稳定格式：

```ts
interface LocalRemoteMessage {
  localMessageId: string;
  ordinal: number;
  transcriptVersion: number;
  role: string;
  content: string;
  turn?: number | null;
  callIndex?: number | null;
  toolCallId?: string | null;
  toolCalls?: unknown[];
  reasoning?: string | null;
  usage?: unknown;
  images?: unknown[];
  contentHash: string;
  createdAt?: string | null;
  metadata?: Record<string, unknown>;
}
```

### 15.4 为什么需要本地 Remote API

直接复用 UI 的 `/api/agents` 和 session 文件读取会带来问题：

- ViewerWorker agent id 与 prebuilt agent id 映射不稳定。
- 有些状态在 server.js，有些在 ViewerWorker。
- session index、runtime map、message context 分散。
- Android 同步需要稳定 contract，不应依赖前端渲染细节。

### 15.5 现有运行时身份规则

必须在代码里把下面几个名字分开：

| 名称 | 来源 | 生命周期 | 用途 |
|---|---|---|---|
| `agentId` | prebuilt/official agent 定义 | 稳定 | 找 session、创建/激活 managed runtime |
| `localSessionId` | session index/file | 稳定 | 找本地会话 |
| `viewerAgentId` | `startManagedAgent()` 启动后从 stdout 解析并登记 | runtime 存活期间有效，重启可能变化 | `/api/agents/:id/input`、`queue-input`、`interrupt`、`notification` |
| `remoteSessionId` | Relay Server | 稳定 | Android/Relay 内部引用 |

Remote 相关代码不得用 `agentId` 代替 `viewerAgentId` 调用 ViewerWorker API。也不得把 `viewerAgentId` 写成会话的永久主键。

### 15.6 Flow / workspace-bound agent 的边界

`feature-creator`、`agent-creator`、`programming-helper`、`flow-workspace` 在代码里被列为 workspace-bound agent。它们的 session 根目录和普通 prebuilt agent 不同，部分能力还可能经 assembly runtime 进入系统。

MVP 建议：

- 列表和历史消息读取：支持 workspace-bound agent。
- 普通文本输入：只在能解析出 managed runtime `viewerAgentId` 时支持。
- Flow/assembly 特有控制：暂不承诺，需要后续为 assembly runtime 单独做 adapter。
- Android UI 对不支持的 command 显示“当前会话类型暂不支持远程控制”，不能静默失败。

## 16. 开发阶段规划

### Phase 0：协议与本地 API 准备

目标：

- 定义 TypeScript schema。
- 增加本地 `/protoclaw/remote/*` API。
- 写测试覆盖 session/message normalize。

产物：

- `server/routes/remote-claw.js`
- `server/remote-claw/*.js`
- `test/remote-claw-*.test.js`

验收：

- 启动本地 Claw 后可通过 remote snapshot 获取 workspace、agent、session、message。
- 测试覆盖空 session、running session、tool message、queued input。

### Phase 1：Relay Server MVP

目标：

- 独立 Relay Server。
- SQLite 持久化。
- 用户、设备、workspace、event、command API。
- WebSocket hint。

产物：

- `remote-relay/` 或独立包。
- Dockerfile。
- migration。
- API 测试。

验收：

- 可以注册 connector device。
- 可以注册 Android device。
- connector append events。
- Android 按 cursor 拉 events。
- Android 写 command。
- connector 拉 command 并回写 result。

### Phase 2：Local Connector MVP

目标：

- connector 能连接 Relay。
- 能上报 snapshot。
- 能同步消息。
- 能执行 Android 发来的 send/interrupt command。

产物：

- `scripts/remote-claw-connector.js`
- connector 配置文档。
- connector 集成测试或 mock relay 测试。

验收：

- 本地 Claw 无公网 IP，仅 connector 主动外连。
- Android 写 command 后，本地 Agent 收到输入。
- 本地 Agent 回复后，Relay 上出现消息事件。

### Phase 3：Android MVP

目标：

- 登录。
- Workspace 列表。
- Session 列表。
- Chat 页面。
- 发送消息。
- 断线补拉。
- outbox retry。

验收：

- 手机前台可实时看到回复。
- 断网发送后恢复网络可自动上传。
- Local Claw 离线时消息显示等待，connector 上线后执行。
- App 重启后消息不丢。

### Phase 4：可靠性与后台体验

目标：

- WorkManager 定期同步。
- Foreground service 实时模式。
- 电池优化提示。
- 更完整的错误和状态 UI。

验收：

- App 后台一段时间后打开，能补齐所有事件。
- 前台服务开启时，长时间运行不明显丢连接。
- 断线/重连/重复 command 测试通过。

### Phase 5：扩展能力

候选：

- 文件附件。
- tool call 折叠展示。
- input request 交互。
- session 创建/切换。
- 多 workspace 快速切换。
- 端到端加密。
- 服务端管理后台。

## 17. 测试计划

### 17.1 Relay Server 单元测试

- token hash 与鉴权。
- event seq 单调递增。
- command seq 单调递增。
- client_msg_id 幂等。
- cursor ack。
- WebSocket hint。
- device revoke。

### 17.2 Connector 测试

- 本地 snapshot normalize。
- command 执行成功。
- command 执行失败。
- connector 重启后不重复同步历史消息。
- Relay 离线时退避重试。
- Local Claw 离线时状态上报 offline。

### 17.3 Android 测试

- Room migration。
- outbox retry。
- seq gap detection。
- WebSocket 断线重连。
- App 进程重启恢复。
- token 过期/撤销。

### 17.4 端到端测试场景

1. 正常在线对话。
2. Android 发送后立刻断网。
3. Local Claw 离线时 Android 发送。
4. connector 执行 command 中途崩溃。
5. Relay Server 重启。
6. Android 重复提交同一个 client_msg_id。
7. session 里连续产生多条 tool call/tool result。
8. running 状态下发送 queue message。
9. interrupt 正在运行的 Agent。
10. Android 长时间后台后重新打开补拉。

## 18. 观测与运维

Relay Server 应提供：

```http
GET /healthz
GET /metrics
GET /api/admin/workspaces
GET /api/admin/devices
```

日志字段：

- requestId。
- userId。
- deviceId。
- workspaceId。
- remoteSessionId。
- streamId。
- commandId。
- eventSeq。
- globalSeq。
- latencyMs。
- errorCode。

关键指标：

- online connectors。
- online android devices。
- pending commands。
- failed commands。
- event append QPS。
- sync pull QPS。
- websocket reconnect count。
- average command execution latency。

## 19. 风险清单

### 19.1 Android 后台实时性风险

不使用推送服务时无法保证后台秒级实时。缓解：

- 明确产品文案。
- 默认保证恢复后一条不丢。
- 提供前台服务实时模式。
- 提供电池优化引导。

### 19.2 本地消息 ID 不稳定

AgentDev message 结构可能变化。缓解：

- 增加本地 Remote API 做稳定 normalize。
- 引入 localMessageId。
- 测试覆盖 rollback、queued input、tool message。

### 19.3 Relay Server 保存敏感消息

自建服务器管理员可读数据。缓解：

- 文档明确。
- 支持清理。
- 预留 E2EE。
- 后续实现 payload 加密。

### 19.4 多设备并发发送

多个 Android 同时给同一 session 发消息可能导致顺序复杂。缓解：

- command 在 workspace/session 内有 seq。
- connector 单线程按 seq 执行。
- busy 时默认 queue。

### 19.5 Connector 与本地 Claw 版本不匹配

本地 API 变化会导致 connector 失败。缓解：

- `/protoclaw/remote/snapshot` 返回 `apiVersion`。
- connector 检查版本。
- Relay event payload 带 schema version。

## 20. 第一版推荐目录结构

如果先在本 repo 内实现：

```text
server/
  routes/
    remote-claw.js
  remote-claw/
    message-normalizer.js
    snapshot-builder.js
    command-adapter.js

scripts/
  remote-claw-connector.js

remote-relay/
  package.json
  src/
    index.ts
    app.ts
    db/
      migrations/
      sqlite.ts
    routes/
      auth.ts
      devices.ts
      workspaces.ts
      events.ts
      commands.ts
      realtime.ts
    services/
      auth-service.ts
      event-service.ts
      command-service.ts
      websocket-hub.ts
    schema/
      remote-events.ts
      remote-commands.ts
  Dockerfile
  README.md

android/
  RemoteClaw/
    app/
      src/main/java/...
```

如果 Android 项目不放本 repo，也至少保留 `docs/android-client-api.md` 和 OpenAPI schema。

## 21. 关键实现细节

### 21.1 事件 append 必须事务化

错误做法：

```ts
const seq = await getMaxSeq() + 1;
await insertEvent(seq);
```

正确做法：

```ts
await db.transaction(async () => {
  const seq = await nextSeqForStream(workspaceId, streamId);
  const globalSeq = await nextGlobalSeq(workspaceId);
  await insertEvent({ seq, globalSeq, streamId, ...event });
});
```

### 21.2 WebSocket 不能作为唯一数据源

WebSocket 消息只发 hint：

```json
{
  "type": "event_hint",
  "workspaceId": "ws_123",
  "streamId": "session:sess_123",
  "latestSeq": 882,
  "latestGlobalSeq": 1401
}
```

客户端收到后必须 HTTP 拉取：

```http
GET /api/workspaces/ws_123/streams/session%3Asess_123/events?after_seq=771
```

### 21.3 Android 发送必须先写 outbox

不能先发网络请求再更新 UI。正确流程：

1. 写 Room outbox。
2. UI 显示 pending。
3. 后台 worker 上传。
4. 服务端 ACK 后更新状态。
5. 等 connector 事件确认最终执行结果。

### 21.4 Connector 执行 command 必须幂等

connector 拉到 command 后可能崩溃。恢复后会再次看到 pending/running command。必须根据 command id/client_msg_id 判断：

- 已成功执行过：补发 result。
- 未执行：继续执行。
- 状态不确定：优先查询本地 session 是否已有对应 user message。

### 21.5 大消息与附件限制

第一版限制：

- 单 event payload 最大 256KB。
- 超过限制的消息由 connector 截断并标记 `truncated: true`。
- 附件走单独 object API，第一版可不实现。

## 22. 开发顺序建议

最稳的顺序：

1. 写 schema 和测试。
2. 做 Relay event/command API。
3. 做本地 `/protoclaw/remote/snapshot`。
4. 做 connector，把本地 snapshot 推到 Relay。
5. 做一个最小 Web 调试页验证 Relay 数据。
6. 做 Android 登录和列表。
7. 做 Android chat 只读同步。
8. 做 Android 发送 command。
9. 做 connector 执行 command。
10. 做 outbox 和断线恢复。
11. 做后台同步和前台服务。

这样每一步都有可观察产物，不会一上来同时陷入 Android、Relay、Claw 三端联调。

## 23. MVP 验收标准

MVP 可以认为完成，当以下场景全部通过：

1. 用户在公网服务器部署 Relay Server。
2. 用户在本地电脑启动 AgentDevClaw。
3. 用户启动 connector，connector 显示 online。
4. Android 登录后看到该 workspace。
5. Android 看到本地 Claw 的 session 列表。
6. Android 打开 session 能看到历史消息。
7. Android 发送一条消息，本地 Agent 收到并开始执行。
8. 本地 Agent 回复后，Android 前台能看到回复。
9. Android 断网期间发送消息，恢复后自动送达。
10. 本地 Claw 离线期间 Android 发送消息，Claw 上线后自动执行。
11. Relay Server 重启后，Android 和 connector 能恢复连接并补齐事件。
12. 重复发送同一 `client_msg_id` 不会产生重复 Agent 输入。

## 24. 命名建议

为了避免与 IM 混淆，建议命名：

- 产品名：Remote Claw。
- 服务端：remote-claw-relay。
- 本地连接器：remote-claw-connector。
- Android App：Remote Claw。
- 协议对象：workspace/session/event/command。

避免命名：

- android channel。
- app IM。
- mobile carrier。
- line。
- portal。

这些词会把实现引回现有 IM 模型。

## 25. 总结

Remote Claw 的本质不是 IM 网关，而是一个自建的远程同步系统。它要解决的是 NAT 后本地 Claw 与移动端之间的可靠通信问题。公网服务器是中继和事件账本，本地 connector 是执行者，Android 是会话镜像与控制端。

在不使用第三方推送服务的前提下，正确的可靠性目标不是“任何后台状态都实时”，而是：

> 在线实时，后台尽力，恢复后一条不丢。

围绕这个目标，第一版必须优先实现 event log、cursor、ACK、outbox、command queue 和幂等执行。只要这些协议基础打牢，后续再增加流式输出、附件、工具详情、端到端加密和多用户协作都会比较自然。

## 26. 完整开发 Spec

本章是第一版实现契约。前文解释设计取舍；开发、联调、验收时以本章为准。

### 26.1 协议版本与通用 Envelope

所有 Relay API 与本地 Remote API 均使用 JSON。第一版核心协议不使用 multipart，不把 WebSocket 当数据源。

请求头：

```http
Authorization: Bearer <device_token>
Content-Type: application/json
X-Remote-Claw-Protocol: 1
X-Request-Id: <uuid>
Idempotency-Key: <client_msg_id_or_operation_id>
```

成功响应：

```ts
interface ApiSuccess<T> {
  ok: true;
  requestId: string;
  protocolVersion: 1;
  data: T;
}
```

失败响应：

```ts
interface ApiFailure {
  ok: false;
  requestId: string;
  protocolVersion: 1;
  error: {
    code: RemoteErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}
```

兼容规则：

- 请求 `X-Remote-Claw-Protocol > serverSupportedVersion` 时返回 `426 protocol_unsupported`。
- 所有 event/command payload 必须包含 `schemaVersion: 1`。
- 新字段只能追加；不能改变已有字段含义。
- Android 遇到未知 enum 值必须降级展示，不能崩溃。
- Relay 不解析 Agent 推理内容；只按 envelope、stream、seq、cursor 处理同步。

### 26.2 身份模型与权威来源

| 字段 | 生成方 | 权威来源 | 生命周期 | 用途 |
|---|---|---|---|---|
| `userId` | Relay | `users` | 稳定 | 用户和权限归属 |
| `deviceId` | Relay | `devices` | 稳定 | Android/connector 鉴权、cursor |
| `workspaceId` | Relay | `workspaces` | 稳定 | 一台本地 Claw 实例 |
| `agentId` | AgentDevClaw | agent 定义 | 稳定 | 找本地 session、启动 runtime |
| `localSessionId` | AgentDevClaw | session index/file | 稳定 | 找本地会话 |
| `remoteSessionId` | Relay | `remote_sessions` | 稳定 | Android/Relay 引用 |
| `streamId` | Relay | `events` | 稳定 | 事件流 cursor，`workspace` 或 `session:{remoteSessionId}` |
| `viewerAgentId` | AgentDevClaw runtime | managed runtime / ViewerWorker | 易变 | 调 `/api/agents/:id/*` |
| `runtimeSessionId` | AgentDevClaw frontend contract | `/protoclaw/get_connected_agents` | 易变 | 与 `viewerAgentId` 兼容 |
| `clientMsgId` | Android | `commands` | 稳定 | command 幂等 |
| `sourceEventId` | connector | `events` | 稳定 | event append 幂等 |

硬约束：

- 不能用 `agentId` 调 `/api/agents/:id/queue-input`。
- 不能用 `viewerAgentId` 作为远端 session 主键。
- Android 不能构造本地 session 文件路径。
- Relay 不能直接读写 AgentDevClaw session 文件。
- connector 不能直接修改 session 文件；写入必须走本地 Remote API 或现有 ViewerWorker 输入路径。

### 26.3 Relay API

#### 26.3.1 设备注册

```http
POST /api/devices/register
```

请求：

```json
{
  "schemaVersion": 1,
  "type": "android",
  "name": "Pixel 8",
  "pairingCode": "optional"
}
```

响应 data：

```json
{
  "deviceId": "dev_123",
  "deviceToken": "rcd_plaintext_only_once",
  "userId": "usr_123"
}
```

规则：

- `type` 只能是 `android` 或 `connector`。
- 明文 `deviceToken` 只返回一次；服务端只保存 hash。
- revoke 后 token 立即失效，但历史 event/command 不删除。

#### 26.3.2 Workspace 注册与心跳

```http
POST /api/workspaces/register
POST /api/workspaces/:workspaceId/heartbeat
```

register 请求：

```json
{
  "schemaVersion": 1,
  "workspaceName": "Home PC",
  "localOrigin": "http://127.0.0.1:1420",
  "connectorVersion": "0.1.0",
  "agentDevClawVersion": "unknown",
  "capabilities": {
    "transcriptSnapshot": true,
    "queueInput": true,
    "inputRequest": true,
    "interrupt": true,
    "attachments": false,
    "e2ee": false
  }
}
```

heartbeat 请求：

```json
{
  "schemaVersion": 1,
  "status": "online",
  "connectorStartedAt": "2026-07-10T03:00:00.000Z",
  "lastLocalSnapshotAt": "2026-07-10T03:21:00.000Z"
}
```

规则：

- connector 只能主动外连 Relay；Relay 不反连用户电脑。
- workspace 超过 `CONNECTOR_STALE_SECONDS` 未心跳，状态为 `offline`。
- workspace offline 时 Android 仍可创建 command，command 保持 `pending`。

#### 26.3.3 Session Upsert

connector 上报本地 session 列表：

```http
POST /api/workspaces/:workspaceId/sessions/upsert
```

请求：

```json
{
  "schemaVersion": 1,
  "sessions": [
    {
      "agentId": "programming-helper",
      "localSessionId": "20260710-abc",
      "viewerAgentId": "viewer_456",
      "runtimeSessionId": "viewer_456",
      "title": "修复同步协议",
      "status": "running",
      "sessionType": "task",
      "archived": false,
      "todo": false,
      "openDirectory": "D:/code/AgentDevClaw",
      "messageCount": 42,
      "preview": "已经补齐协议字段...",
      "tokenUsage": { "inputTokens": 100, "outputTokens": 50, "totalTokens": 150 },
      "savedAt": "2026-07-10T03:21:47.000Z",
      "fileMtimeMs": 1783653707000,
      "fileSize": 123456,
      "metadata": {
        "featureName": "Programming Helper",
        "agentName": "编程助手",
        "goal": "远程客户端 spec",
        "targetFiles": ["docs/plans/remote-claw-android-client-development-plan.md"]
      }
    }
  ]
}
```

响应 data：

```json
{
  "sessions": [
    {
      "remoteSessionId": "sess_123",
      "streamId": "session:sess_123",
      "agentId": "programming-helper",
      "localSessionId": "20260710-abc",
      "created": false,
      "updated": true
    }
  ]
}
```

规则：

- upsert 匹配键固定为 `(workspaceId, agentId, localSessionId)`。
- Relay 创建 remote session 时同时创建稳定 `streamId = session:{remoteSessionId}`。
- title/status/runtime id/messageCount 等变化时，Relay 必须 append `session.updated` 到 `workspace` stream。
- Android 不直接创建 remote session；Android 只能请求 `session.create` command，由 connector 本地创建后 upsert。

#### 26.3.4 Event Append

```http
POST /api/workspaces/:workspaceId/events
```

请求：

```json
{
  "schemaVersion": 1,
  "events": [
    {
      "sourceEventId": "src_programming-helper_20260710-abc_v7_o42",
      "streamId": "session:sess_123",
      "scopeType": "session",
      "scopeId": "sess_123",
      "type": "message.assistant",
      "payload": {
        "schemaVersion": 1,
        "remoteSessionId": "sess_123",
        "transcriptVersion": 7,
        "ordinal": 42,
        "localMessageId": "programming-helper:20260710-abc:7:42:abcd1234",
        "role": "assistant",
        "content": "已经完成。",
        "contentHash": "sha256:abcd...",
        "turn": 12,
        "toolCallId": null,
        "toolCalls": [],
        "reasoning": null,
        "usage": null,
        "images": [],
        "createdAt": "2026-07-10T03:21:47.000Z"
      }
    }
  ]
}
```

响应 data：

```json
{
  "events": [
    {
      "id": "evt_123",
      "sourceEventId": "src_programming-helper_20260710-abc_v7_o42",
      "streamId": "session:sess_123",
      "seq": 88,
      "globalSeq": 1401,
      "createdAt": "2026-07-10T03:21:47.100Z"
    }
  ]
}
```

幂等和顺序：

- `sourceEventId` 在 `(workspaceId, sourceEventId)` 内唯一。
- 重复 append 同一个 `sourceEventId` 必须返回原 event，不分配新 seq。
- 同一批 events 在一个事务内 append；批内失败则整批失败。
- `seq` 按 `(workspaceId, streamId)` 分配。
- `globalSeq` 按 `workspaceId` 分配。
- `streamId = workspace` 用于 workspace/session 列表级事件。

#### 26.3.5 Event Pull 与 ACK

```http
GET /api/workspaces/:workspaceId/events?after_global_seq=1400&limit=500
GET /api/workspaces/:workspaceId/streams/:streamId/events?after_seq=87&limit=500
POST /api/workspaces/:workspaceId/ack
```

pull 响应 data：

```json
{
  "events": [
    {
      "id": "evt_123",
      "streamId": "session:sess_123",
      "scopeType": "session",
      "scopeId": "sess_123",
      "seq": 88,
      "globalSeq": 1401,
      "source": "connector",
      "type": "message.assistant",
      "payload": {},
      "clientMsgId": null,
      "createdAt": "2026-07-10T03:21:47.100Z"
    }
  ],
  "hasMore": false,
  "nextAfterSeq": 88,
  "nextAfterGlobalSeq": 1401
}
```

ack 请求：

```json
{
  "schemaVersion": 1,
  "acks": [
    { "streamId": "workspace", "lastEventSeq": 33 },
    { "streamId": "session:sess_123", "lastEventSeq": 88 }
  ],
  "lastGlobalSeq": 1401
}
```

规则：

- ACK 只表示某 device 已处理到对应位置，不作为删除事件的依据。
- Android 必须先写入 Room 并提交事务，再 ACK。
- 如果 pull 到的 `seq` 不连续，Android 不得 ACK，必须触发补拉或 transcript 全量修复。

#### 26.3.6 Command API

Android 创建 command：

```http
POST /api/workspaces/:workspaceId/commands
```

请求：

```json
{
  "schemaVersion": 1,
  "clientMsgId": "cm_0190...",
  "type": "message.send",
  "target": {
    "remoteSessionId": "sess_123"
  },
  "payload": {
    "schemaVersion": 1,
    "text": "继续",
    "images": [],
    "attachments": []
  }
}
```

响应 data：

```json
{
  "command": {
    "id": "cmd_123",
    "workspaceId": "ws_123",
    "seq": 77,
    "clientMsgId": "cm_0190...",
    "type": "message.send",
    "status": "pending",
    "createdAt": "2026-07-10T03:22:00.000Z"
  }
}
```

connector 拉取与回写：

```http
GET  /api/workspaces/:workspaceId/commands?after_seq=76&status=pending&limit=100
POST /api/workspaces/:workspaceId/commands/:commandId/ack
POST /api/workspaces/:workspaceId/commands/:commandId/result
```

ack 请求：

```json
{
  "schemaVersion": 1,
  "status": "running",
  "connectorDeviceId": "dev_connector",
  "startedAt": "2026-07-10T03:22:01.000Z"
}
```

成功 result：

```json
{
  "schemaVersion": 1,
  "status": "succeeded",
  "result": {
    "localAccepted": true,
    "agentId": "programming-helper",
    "localSessionId": "20260710-abc",
    "viewerAgentId": "viewer_456",
    "queued": true
  },
  "finishedAt": "2026-07-10T03:22:01.500Z"
}
```

失败 result：

```json
{
  "schemaVersion": 1,
  "status": "failed",
  "error": {
    "code": "local_runtime_not_ready",
    "message": "Local runtime did not expose viewerAgentId after activation",
    "retryable": true
  },
  "finishedAt": "2026-07-10T03:22:10.000Z"
}
```

Command 状态机：

```text
pending -> delivered -> running -> succeeded
pending -> delivered -> running -> failed
pending -> cancelled
pending -> expired
failed(retryable=true) -> pending
```

规则：

- `(workspaceId, clientMsgId)` 唯一；重复 `POST /commands` 返回原 command。
- connector 执行前必须把 command 标记为 `delivered` 或 `running`。
- running command 必须有 lease，例如 120 秒；connector 掉线且 lease 过期后可回到 `pending`。
- `succeeded/cancelled/expired` 不再执行。
- command result 必须同时 append `command.updated` 到 `workspace` stream，方便 Android UI 更新 outbox。

### 26.4 Event Payload Schema

基础 payload：

```ts
interface BaseEventPayload {
  schemaVersion: 1;
  remoteSessionId?: string;
  agentId?: string;
  localSessionId?: string;
  viewerAgentId?: string | null;
  createdAt?: string;
}
```

`workspace.snapshot`：

```ts
interface WorkspaceSnapshotPayload extends BaseEventPayload {
  workspace: {
    id: string;
    name: string;
    status: 'online' | 'offline' | 'error';
    lastSeenAt: string | null;
    connectorVersion?: string;
    agentDevClawVersion?: string;
  };
  agents: Array<{
    agentId: string;
    name: string;
    source: 'prebuilt' | 'child' | 'external';
    status: 'stopped' | 'running' | 'error';
    runtimeSessionId?: string | null;
    viewerAgentId?: string | null;
    connected: boolean;
    callActive?: boolean;
    pendingInputCount?: number | null;
  }>;
}
```

`session.updated`：

```ts
interface SessionUpdatedPayload extends BaseEventPayload {
  remoteSessionId: string;
  streamId: string;
  agentId: string;
  localSessionId: string;
  title: string;
  status: 'idle' | 'running' | 'queued' | 'offline' | 'error';
  viewerAgentId?: string | null;
  runtimeSessionId?: string | null;
  messageCount: number;
  preview?: string | null;
  archived: boolean;
  todo: boolean;
  savedAt?: string | null;
  fileMtimeMs?: number | null;
  fileSize?: number | null;
  metadata?: Record<string, unknown>;
}
```

`message.*`：

```ts
interface MessageEventPayload extends BaseEventPayload {
  remoteSessionId: string;
  transcriptVersion: number;
  ordinal: number;
  localMessageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  contentHash: string;
  turn?: number | null;
  toolCallId?: string | null;
  toolCalls?: unknown[] | null;
  reasoning?: string | null;
  usage?: unknown;
  images?: Array<{
    id?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    objectId?: string;
    dataRef?: string;
  }>;
  source?: 'session_snapshot' | 'runtime' | 'android_pending';
  raw?: unknown;
}
```

消息事件类型映射：

- `role=user` -> `message.user`
- `role=assistant` -> `message.assistant`
- `role=tool` -> `message.tool_result`
- 无法识别 -> `message.system` 或 `message.error`
- assistant 的 `toolCalls` 不拆成独立消息；Android 在同一 assistant 消息下渲染工具区块。

`transcript.replaced`：

```ts
interface TranscriptReplacedPayload extends BaseEventPayload {
  remoteSessionId: string;
  previousTranscriptVersion: number | null;
  transcriptVersion: number;
  reason: 'rollback' | 'compact' | 'session_file_rewrite' | 'hash_mismatch' | 'initial_snapshot';
  messageCount: number;
  snapshotHash: string;
  messages: MessageEventPayload[];
}
```

Android 处理 `transcript.replaced`：

1. 开启 Room 事务。
2. 删除该 `remoteSessionId` 下所有本地 message rows。
3. 按 `messages.ordinal` 插入新消息。
4. 更新 session `messageCount/preview/transcriptVersion`。
5. 提交事务后 ACK。

`runtime.status`：

```ts
interface RuntimeStatusPayload extends BaseEventPayload {
  remoteSessionId?: string;
  viewerAgentId: string;
  runtimeSessionId?: string;
  connected: boolean;
  callActive: boolean;
  stage?: string | null;
  charCount?: number;
  thinkingChars?: number;
  contentChars?: number;
  toolCallCount?: number;
  activeToolNames?: string[];
  callStartedAt?: string | null;
  updatedAt?: string | null;
  lastErrorMessage?: string | null;
  queuedInputCount?: number | null;
}
```

字段来源：`/api/agents/:viewerAgentId/notification`、`/queued-inputs`、`/connection`。Relay 只保存 connector 上报值，不推导运行状态。

### 26.5 Command Payload Schema

`message.send`：

```ts
interface MessageSendCommandPayload {
  schemaVersion: 1;
  text: string;
  images?: Array<{
    objectId?: string;
    dataUrl?: string;
    mimeType?: string;
    width?: number;
    height?: number;
  }>;
  attachments?: Array<{
    objectId: string;
    name: string;
    mimeType: string;
    size: number;
  }>;
}
```

规则：

- `text` 和 `images` 不能同时为空。
- `text` 最大 64KB。
- 第一版 `attachments` 只保留字段，不实现对象上传。
- connector 调本地 `/queue-input` 时 body 必须是现有前端兼容格式：`{ text, images }`。

`input_request.respond`：

```ts
interface InputRequestRespondCommandPayload {
  schemaVersion: 1;
  requestId: string;
  response: {
    text?: string;
    choiceId?: string;
    value?: unknown;
  };
}
```

第一版可以只展示 input request 状态，不实现复杂交互。若实现，connector 必须先确认 `/api/agents/:viewerAgentId/input-requests` 仍存在该 `requestId`，否则返回 `input_request_expired`。

`session.open/create/rename`：

```ts
interface SessionOpenCommandPayload {
  schemaVersion: 1;
}

interface SessionCreateCommandPayload {
  schemaVersion: 1;
  agentId: string;
  formId?: string;
  featureName?: string;
  agentName?: string;
  openDirectory?: string;
  targetDir?: string;
}

interface SessionRenameCommandPayload {
  schemaVersion: 1;
  title: string;
}
```

本地映射：

- `session.open` -> `/protoclaw/prebuilt_sessions/activate`
- `session.create` -> `/protoclaw/prebuilt_sessions`
- `session.rename` -> `PUT /protoclaw/prebuilt_sessions/:sessionId/title`

### 26.6 本地 Remote API 契约

本地 Remote API 位于 AgentDevClaw 本地 server。connector 默认访问 `http://127.0.0.1:1420`。第一版只允许 localhost，除非用户显式配置 LAN allowlist。

`GET /protoclaw/remote/snapshot` 响应：

```ts
interface LocalRemoteSnapshotResponse {
  schemaVersion: 1;
  workspace: {
    localId: string;
    name: string;
    projectRoot: string;
    appVersion: string | null;
  };
  agents: LocalRemoteAgent[];
  sessions: LocalRemoteSession[];
  capturedAt: string;
}
```

实现必须聚合：

- `/protoclaw/get_connected_agents`
- `/protoclaw/prebuilt_sessions?agentId=...`
- 对 running session 调 `/api/agents/:viewerAgentId/notification`

`POST /protoclaw/remote/sessions/:agentId/:sessionId/send` 请求：

```json
{
  "schemaVersion": 1,
  "clientMsgId": "cm_0190...",
  "text": "继续",
  "images": []
}
```

执行步骤：

1. 校验 `agentId/sessionId` 存在。
2. 如果没有 running `viewerAgentId`，执行等价于 `/protoclaw/prebuilt_sessions/activate` 的启动。
3. 解析 `viewerAgentId`。
4. 调 `/api/agents/:viewerAgentId/queue-input`，body 为 `{ text, images }`。
5. 返回 accepted，不等待 Agent 完整回复。

响应：

```json
{
  "schemaVersion": 1,
  "accepted": true,
  "queued": true,
  "agentId": "programming-helper",
  "localSessionId": "20260710-abc",
  "viewerAgentId": "viewer_456"
}
```

`GET /protoclaw/remote/sessions/:agentId/:sessionId/messages` 响应：

```ts
interface LocalRemoteMessagesResponse {
  schemaVersion: 1;
  agentId: string;
  localSessionId: string;
  sessionType?: string | null;
  transcriptVersion: number;
  snapshotHash: string;
  messageCount: number;
  messages: LocalRemoteMessage[];
}
```

`LocalRemoteMessage` 必须保留 `toolCalls/reasoning/usage/images/toolCallId/turn/raw`。现有 `/protoclaw/session_record` 只返回 `role/content`，不足以作为最终 Remote API，只能作为临时 fallback 或调试接口。

### 26.7 Connector 主循环

启动流程：

```text
load config
POST /api/workspaces/register
GET /protoclaw/remote/snapshot
POST /sessions/upsert
POST /events(workspace.snapshot, session.updated)
connect websocket
start loops
```

循环：

| 循环 | 间隔 | 动作 |
|---|---:|---|
| heartbeat | 15s | workspace heartbeat |
| command pull | 2s 或 ws hint | 拉 pending commands，按 seq 执行 |
| snapshot sync | idle 5s / active 1s | session upsert、runtime.status |
| transcript sync | idle 5s / active 1s | 对活跃 session 做 message diff |
| full reconciliation | 5min | 全量校验 session hash/mtime |

命令幂等：

- connector 本地保存 `executedCommands`，键为 `commandId/clientMsgId`。
- 如果 command 已本地执行成功但 result 回写失败，重试时只补 result，不再次调用 `/queue-input`。
- 如果状态不确定，先检查本地 transcript 是否已有对应 user message/contentHash，再决定是否执行。

### 26.8 Android 同步规范

发送消息本地事务：

```text
BEGIN Room transaction
insert Outbox(clientMsgId, status='pending')
insert PendingMessage(remoteSessionId, clientMsgId, text, createdAt)
COMMIT
enqueue WorkManager UploadOutbox
```

上传成功只表示 Relay 收到 command：

```text
Outbox pending -> uploaded
PendingMessage remains pending
```

收到 command result 或 transcript 中出现对应 user message 后：

```text
PendingMessage pending -> confirmed
Outbox uploaded -> succeeded
```

事件应用顺序：

1. 每个 `streamId` 按 `seq` 连续应用。
2. 如果第一条 `seq != localCursor + 1`，不得 ACK，必须补拉或拉 transcript。
3. `transcript.replaced` 必须在 Room 事务中替换消息。
4. 成功写入 Room 后再 ACK。

### 26.9 错误码

```ts
type RemoteErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'protocol_unsupported'
  | 'rate_limited'
  | 'workspace_offline'
  | 'connector_offline'
  | 'command_conflict'
  | 'command_expired'
  | 'local_api_unreachable'
  | 'local_agent_not_found'
  | 'local_session_not_found'
  | 'local_runtime_not_ready'
  | 'local_runtime_timeout'
  | 'viewer_agent_id_missing'
  | 'input_request_expired'
  | 'payload_too_large'
  | 'stream_gap'
  | 'internal_error';
```

HTTP 映射：

| HTTP | code | retryable |
|---:|---|---|
| 400 | `validation_failed` | false |
| 401 | `unauthorized` | false |
| 403 | `forbidden` | false |
| 404 | `not_found` / local not found | false |
| 409 | `command_conflict` / `stream_gap` | case by case |
| 413 | `payload_too_large` | false |
| 426 | `protocol_unsupported` | false |
| 429 | `rate_limited` | true |
| 503 | `connector_offline` / `local_api_unreachable` | true |
| 504 | `local_runtime_timeout` | true |
| 500 | `internal_error` | true |

### 26.10 端到端验收矩阵

| 场景 | 预置状态 | 操作 | 必须观察到 |
|---|---|---|---|
| 首次绑定 Android | Relay 有管理员，Android 无 token | 注册设备 | `devices` 有 android，token 只显示一次 |
| 首次绑定 connector | 本地 Claw 可访问 | connector register + snapshot | Relay 有 workspace、sessions、workspace.snapshot |
| 打开离线 session | session 未运行 | Android 发 `session.open` | 本地启动 runtime，Relay session 出现 `viewerAgentId` |
| 空闲发送消息 | runtime 已运行且空闲 | Android 发 `message.send` | command succeeded，本地 `/queue-input` 收到，后续出现 user/assistant message |
| 忙碌发送消息 | `callActive=true` | Android 发 `message.send` | command succeeded，queuedInputCount 增加，后续按 CallArbiter 顺序执行 |
| connector 离线发送 | connector offline | Android 发消息 | command 保持 pending，connector 上线后执行 |
| Android 断网发送 | Android offline | 输入消息 | Room outbox 存在，联网后上传 command |
| WebSocket 丢 hint | 强制断开 ws | 本地产生消息 | Android 下次 HTTP poll/打开页面按 cursor 补齐 |
| command 重复提交 | 同 `clientMsgId` POST 两次 | 上传 outbox | Relay 返回同一 command，不重复本地输入 |
| connector result 丢失 | 本地 queue 成功但 result 回写失败 | connector 重启 | 不重复 queue-input，补写原 result |
| rollback/compact | 本地 transcript 前缀变化 | connector sync | Relay 产生 `transcript.replaced`，Android 替换消息表 |
| interrupt 无 runtime | session 未运行 | Android interrupt | command succeeded/no-op，不无限等待 |
| runtime id 变化 | 本地重启 runtime | connector snapshot | Relay 更新 `viewerAgentId`，旧 id 不再用于发送 |
| workspace-bound session | `programming-helper` session | snapshot + send | session 路径正确，能读消息；只有 managed runtime 可发送 |

### 26.11 第一版范围裁决

必须实现：

- Relay auth/device/workspace/session/event/command API。
- SQLite migrations 与事务 seq 分配。
- connector register、heartbeat、snapshot、command pull、message send、interrupt、transcript sync。
- 本地 `/protoclaw/remote/*` 包装接口，至少覆盖 snapshot/open/send/messages。
- Android Room、outbox、event pull、stream cursor、chat UI、重试。
- `transcript.replaced`。
- 错误码与 `retryable` 标记。

可以延期：

- token delta streaming。
- 真正附件上传/下载。
- E2EE。
- 多人协同编辑同一 session。
- 完整工具面板操作。
- Android 后台无前台服务时的实时提醒。

不能延期：

- 幂等。
- cursor 补拉。
- connector 离线 command 持久化。
- `viewerAgentId` 与 `agentId` 的严格区分。
- 不直接写本地 session 文件。

### 26.12 通信方式总表

| 链路 | 方向 | 协议 | 数据类型 | 是否可靠数据源 | 失败恢复 |
|---|---|---|---|---|---|
| Android -> Relay auth | Android 到 Relay | HTTPS JSON | login/register/revoke | 是 | token 重试或重新登录 |
| Android -> Relay command | Android 到 Relay | HTTPS JSON | `RemoteCommand` | 是 | Room outbox + `clientMsgId` 幂等 |
| Android <- Relay event pull | Android 从 Relay 拉 | HTTPS JSON | events/transcript/session | 是 | stream cursor / global cursor 补拉 |
| Android <-> Relay realtime | 双向 | WebSocket | `event_hint` / `command_hint` / ping | 否，只是 hint | 断开后 HTTP cursor 补拉 |
| Connector -> Relay register/heartbeat | connector 到 Relay | HTTPS JSON | workspace/device 状态 | 是 | 周期重试 |
| Connector -> Relay event append | connector 到 Relay | HTTPS JSON | snapshot/message/runtime events | 是 | `sourceEventId` 幂等 |
| Connector <- Relay command pull | connector 从 Relay 拉 | HTTPS JSON | pending commands | 是 | command lease + seq |
| Connector -> Local Claw snapshot | connector 到本地 | HTTP JSON localhost | session/runtime/messages | 是，本地事实源 | 本地不可达时标记 workspace offline |
| Connector -> Local Claw send | connector 到本地 | HTTP JSON localhost | send/open/interrupt | 是，执行入口 | command retry / no-op / failed |
| Local Claw -> ViewerWorker | 本地 server 到 ViewerWorker | HTTP JSON | `/api/agents/:viewerAgentId/*` | 是，runtime 入口 | 本地 Remote API 包装重试 |

原则：

- WebSocket 永远不能承载唯一数据；只提示“去拉”。
- Relay event log 是移动端恢复的唯一远端数据源。
- 本地 session/runtime snapshot 是 connector 判断真实状态的唯一事实源。
- command queue 是 Android 控制本地 Claw 的唯一跨公网入口。

### 26.13 Command 与 Event 的 UI 回执

Android 发送消息后，UI 需要两个层面的确认：

1. Relay 已接收 command：Outbox 从 `pending` 到 `uploaded`。
2. 本地 Claw 已接受/执行 command：收到 `command.updated` 或 transcript 中出现对应 user message。

`command.updated` event 使用 `workspace` stream：

```ts
interface CommandUpdatedPayload extends BaseEventPayload {
  commandId: string;
  clientMsgId: string;
  type: RemoteCommandType;
  status: 'pending' | 'delivered' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  target: {
    remoteSessionId?: string | null;
    agentId?: string | null;
    localSessionId?: string | null;
    viewerAgentId?: string | null;
  };
  result?: {
    localAccepted?: boolean;
    queued?: boolean;
    agentId?: string;
    localSessionId?: string;
    viewerAgentId?: string;
    noOp?: boolean;
  } | null;
  error?: {
    code: RemoteErrorCode;
    message: string;
    retryable: boolean;
  } | null;
  updatedAt: string;
}
```

Android 映射：

| command 状态 | Pending bubble | Outbox |
|---|---|---|
| `pending` | 等待电脑上线/接收 | pending/uploaded |
| `delivered` | 电脑已收到 | uploaded |
| `running` | 正在送入本地 Claw | uploaded |
| `succeeded` | 等待 transcript 确认，或已确认 | succeeded |
| `failed retryable=true` | 可重试 | retryable |
| `failed retryable=false` | 失败 | failed |
| `cancelled/expired` | 已取消/过期 | terminal |

如果 transcript 后续出现同 `clientMsgId` 或同 `contentHash + createdAt window` 的 user message，Android 应把 pending bubble 与真实 transcript message 合并，避免同一条用户输入显示两次。

### 26.14 字段流转矩阵

| 字段 | Android 创建 | Relay 存储 | Connector 使用 | Local Claw 使用 | Android 最终展示 |
|---|---|---|---|---|---|
| `clientMsgId` | 是 | commands/events | 幂等、防重复执行 | 可透传到本地 Remote API | outbox/pending 合并 |
| `remoteSessionId` | 引用 | remote_sessions | 解析 agent/session | 不使用 | session 路由 |
| `agentId` | session.create 可创建 | remote_sessions/commands | 本地 API 路径参数 | `/protoclaw/prebuilt_sessions*` | agent 标签 |
| `localSessionId` | 否 | remote_sessions/commands | 本地 API 路径参数 | session store | 调试/错误详情 |
| `viewerAgentId` | 否，只可缓存展示 | remote_sessions 缓存 | 调 ViewerWorker | `/api/agents/:viewerAgentId/*` | runtime 状态 |
| `streamId` | 否 | events/cursors | append events | 不使用 | cursor/事件应用 |
| `seq` | 否 | events | append 响应 | 不使用 | stream 顺序 |
| `globalSeq` | 否 | events | append 响应 | 不使用 | 列表级补拉 |
| `sourceEventId` | 否 | events | event 幂等 | 不使用 | 不展示 |
| `transcriptVersion` | 否 | events/messages | diff/replace | 不使用 | message 表版本 |
| `ordinal` | 否 | events/messages | diff/replace | 不使用 | 消息排序 |
| `contentHash` | pending 时可算 | events/messages | diff/去重 | 不使用 | pending 合并 |

### 26.15 OpenAPI / Schema 产物要求

实现 Phase 0 时必须把本章落成机器可校验产物：

```text
remote-claw/
  schemas/
    protocol-version.ts
    relay-api.openapi.yaml
    events.schema.json
    commands.schema.json
    local-remote-api.openapi.yaml
  tests/
    protocol-fixtures/
      message-send-command.json
      transcript-replaced-event.json
      runtime-status-event.json
```

最低要求：

- Relay API 请求/响应由 OpenAPI 描述。
- event payload 和 command payload 有 JSON Schema。
- connector 和 Android 共享由 schema 生成或复制的枚举常量，避免字符串分叉。
- 所有 fixtures 必须能被 schema validator 通过。
- 文档中的示例 JSON 应与 fixtures 保持一致。
