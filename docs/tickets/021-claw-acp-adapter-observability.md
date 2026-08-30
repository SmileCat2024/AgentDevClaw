# 021 — ACP adapter 可观测性与黑盒 client 排障

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：[coder-acp-adapter-design.md](../coder-acp-adapter-design.md) §4 / §6 / §8 / §12；[ADR-0004](../adr/0004-acp-adapter-external-stdio-process.md)
- **类型**：adapter 诊断能力（通用、低侵入）
- **前置**：019（adapter 本体）；可与 020 并行

## 背景

第三方 ACP client 通常由编辑器或插件托管，可能不展示子进程日志，甚至完全
不提供可用的运行日志。排障不能依赖第三方配合，必须由 AgentDevClaw 自己
记录 ACP transport、Claw HTTP、thread event 和 runtime 之间的证据链。

本票只增加 adapter 的通用诊断能力，不改 ACP 协议语义，不采集第三方进程内部
状态，不建设前端诊断面板。

## 执行步骤

1. 在 `scripts/coder-acp/` 增加轻量结构化 trace logger：
   - `CLAW_ACP_DEBUG=1`：开启 debug 级 trace；
   - `CLAW_ACP_TRACE_FILE=<path>`：将 JSONL trace 写入指定文件；
   - `CLAW_ACP_TRACE_CONTENT=1`：显式开启脱敏、限长的 prompt / 参数内容；
   - `CLAW_ACP_WIRE_TRACE=1`：记录 ACP 入站/出站帧的元数据；默认不记录
     完整敏感内容。
2. 每条 trace 至少支持这些关联字段（有则记录，无则省略）：
   - `traceId` / `acpTraceId`；
   - `acpSessionId`、`clawSessionId`、`threadId`；
   - `commandId`、`eventId`、`runtimeInstanceId`、`turn`；
   - `promptGeneration`、`method`、`durationMs`、`errorCode`。
3. 记录三类关键证据：
   - ACP：method、request id、参数校验、session/update 顺序、response/error、
     request cancellation、adapter shutdown；
   - Claw HTTP：path、status、耗时、`ok`、业务错误码；
   - 事件轮询：`after`、返回 cursor、事件数量、eventId、最后事件类型、
     terminal event、timeout 时的最后已知状态。
4. 日志纪律：
   - stdout 永远只输出 ACP JSON-RPC；诊断写 stderr 或 trace 文件；
   - 默认不写完整 prompt、工具参数、工具结果、环境变量和凭据；
   - 内容调试必须显式开启，并做长度限制与基础敏感字段脱敏；
   - trace 文件支持父目录创建、单文件大小上限和至少一次轮转；
   - 捕获 `uncaughtException`、`unhandledRejection`、协议连接关闭并写入终止
     记录，但不吞掉原始退出语义。
5. 增加简短排障文档，说明如何根据 trace 区分：
   - 第三方 client 未启动 adapter；
   - 未发送 initialize / session/new / prompt；
   - Claw server 不可用或拒绝请求；
   - command 已接受但 runtime 未执行；
   - runtime 已产生事件但 adapter 未发送 update；
   - adapter 已发送 update 但 client 侧未正确显示。
6. 测试（Node 内置 `node:test`）：
   - 默认 stdout 无诊断污染；
   - trace 文件为合法 JSONL；
   - 入站/出站元数据包含 request id 与关联 ID；
   - 默认不落完整内容，显式内容模式按长度限制并脱敏；
   - prompt timeout / cancel / server error / adapter 异常均留下最后状态；
   - trace 文件轮转不会阻塞协议处理。

## 验收标准

- 第三方 client 无任何可用日志时，仅凭 adapter trace、Claw health、thread
  events 和 runtime 状态即可定位失败层级。
- ACP wire 测试仍断言 stdout 每行可被 `JSON.parse`，且无普通日志混入。
- 诊断功能关闭时不改变现有 ACP 请求、事件映射、取消和退出行为。
- 不新增第三方进程注入、内存读取或隐式内容采集。

## 明确不做

- 不把 ACP trace 混入 Claw agent 的 DebugHub 日志；
- 不要求第三方 client 转发或保存日志；
- 不默认持久化用户 prompt、代码、工具参数或工具输出；
- 不新增 Web UI、SSE、WebSocket 或 debugger MCP 面板；
- 不把诊断能力扩展为新的 ACP 协议方法。

## 风险提示

- trace 内容可能包含用户代码或路径，内容模式必须显式开启且文档警告；
- adapter 退出时应尽力 flush trace，但 flush 失败不能阻塞或改变 ACP 退出；
- 该票只覆盖 adapter 可观察范围，第三方 client 内部解析错误仍只能通过“已发出
  的 ACP 帧 + client 表现”间接判断。
