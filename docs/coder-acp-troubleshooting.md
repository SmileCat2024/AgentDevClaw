# Coder ACP adapter 排障

ACP adapter 的 stdout 只包含 JSON-RPC ndjson。排障时把诊断输出放到 stderr，或设置
`CLAW_ACP_TRACE_FILE` 保存 JSONL：

```text
CLAW_ACP_DEBUG=1 claw acp coder
CLAW_ACP_DEBUG=1 CLAW_ACP_WIRE_TRACE=1 CLAW_ACP_TRACE_FILE=.agentdev/coder-acp.trace.jsonl claw acp coder
```

`CLAW_ACP_TRACE_CONTENT=1` 只应在确有必要时开启。内容会做基础脱敏并限长；默认不保存
prompt、工具参数、结果、环境变量或凭据。可用 `CLAW_ACP_TRACE_MAX_BYTES` 调整单文件上限，
超限后写入 `.1`（最多保留两级轮转文件）。

## 先看哪些事件

按同一个 `acpTraceId`、`acpSessionId`、`clawSessionId`、`threadId` 和
`promptGeneration` 过滤。一次 prompt 通常按以下顺序出现：

1. `acp.inbound` / `acp.request.received`
2. `claw.http.*` 的 baseline、command 和 events 请求
3. `acp.prompt.command_accepted`
4. `acp.events.poll`、`acp.session_update.mapped`、`acp.session_update.outbound`
5. `acp.prompt.terminal` 或 `acp.prompt.*error|timeout`
6. ACP outbound response / `session/update`

HTTP 记录含 `path`、`status`、`ok`、`durationMs` 和业务错误码；事件轮询记录
`after`、返回 cursor、事件数量、eventId、最后事件类型和最后已知状态。

## 六种失败层级

### 1. client 没有启动 adapter

没有任何 adapter stderr 或 trace 记录，也没有 `acp.inbound`。问题在第三方 client 的
进程启动、命令路径、权限或工作目录；Claw server 和 ACP 协议尚未参与。

### 2. client 启动了 adapter，但没有发送 initialize / session/new / prompt

能看到 `adapter started`，但缺少相应 `acp.inbound`：

- 没有 `initialize`：client 没有完成 ACP 握手。
- 有 `initialize`、没有 `session/new`：client 没有创建会话，或在握手响应后停止。
- 有 `session/new`、没有 `session/prompt`：client 没有投递任务。

如果入站帧存在而有参数校验错误，查看对应的 ACP error outbound 和 `errorCode`。

### 3. Claw server 不可用或拒绝请求

看到 `acp.prompt.start` 或 `acp.session.new.validate`，但没有成功的 HTTP response：

- `claw.http.error` / `CLAW_SERVER_UNREACHABLE`：检查 Claw 是否已用正确端口启动，以及
  `CLAW_ACP_BASE_URL`。
- 有 HTTP status 但 `ok=false`：server 已收到请求；查看 `businessErrorCode`、path 和
  response 摘要，判断 cwd、session 或 command 被拒绝的原因。

`session/new` 的错误发生在会话创建阶段；prompt 的错误通常发生在 baseline、command
或 events 请求阶段。

### 4. command 已接受，但 runtime 没有执行

应能看到 `acp.prompt.command_accepted`，随后至少有 `acp.events.poll`。如果轮询持续返回
空事件，或最终出现 `acp.prompt.timeout`，说明 adapter 已把 command 交给 Claw，但在
观测窗口内没有看到 runtime 的 `turn.started`、item 或 terminal 事件。检查 Claw runtime
状态、threadId 对应的事件源和 runtimeInstanceId；timeout 不会自动 interrupt。

### 5. runtime 有事件，但 adapter 没有发送 update

看到 `acp.events.poll` 中有事件和 eventId，却没有对应的
`acp.session_update.mapped` / `acp.session_update.outbound`：

- `turn.started`、reasoning 和未知事件本来不会映射，这是预期行为。
- 对 `item.completed(agent_message)`、tool call 事件仍无 mapped 记录时，检查事件字段和
  event-mapper 规则。
- 若有 mapped 但无 outbound，检查 adapter 异常、连接状态和 `adapter.shutdown`；不要把
  Claw runtime 事件误当成 ACP wire 已发送。

### 6. adapter 已发送 update，但 client 没有显示

看到 `acp.session_update.outbound` 以及 wire trace 中带同一 `acpSessionId` 的
`acp.outbound`，但 client 没有可见内容。此时 adapter 已完成可观测范围内的发送，问题多半
在第三方 client 的 JSON-RPC 读取、ACP schema 处理、sessionId 关联或 UI 展示。将 outbound
帧的 method、sessionId、update 类型和 request/trace 关联交给 client 侧排查。

## 取消、异常与退出

`acp.cancel.received` → `acp.prompt.cancel_requested` → interrupt HTTP 记录是正常取消链路。
迟到事件不会再映射为该代 update。timeout、server error、`uncaughtException`、
`unhandledRejection` 和连接关闭都会留下最后可知的状态或终止记录；adapter 不会因为写
trace 而改变原有退出语义，也不会删除 Claw session、thread 或 runtime。
