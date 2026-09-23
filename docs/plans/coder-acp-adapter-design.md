# coder 工作空间 ACP v1 适配设计

- 日期：2026-08-21
- 状态：已定稿（grill 会话 Q1–Q27 全部确认；执行为 [docs/tickets](../tickets/README.md) 批次 6，017–020）
- 协议参考：`D:\GithubDownload\agent-client-protocol`（规范）、`D:\GithubDownload\typescript-sdk`（TS SDK，包名 `@agentclientprotocol/sdk`）
- 适配参考：`D:\GithubDownload\codex-acp`（官方 Codex 的 ACP 适配；协议入口 / session 管理 / 事件转换三层结构与本设计同构）
- 架构决策：[ADR-0004](../adr/0004-acp-adapter-external-stdio-process.md)

## 1. 目标与范围

让外部 ACP client（编辑器插件、CLI 工具）以 **stdio JSON-RPC（ndjson）** 驱动 Claw 的
**coder 工作空间**（线程宿主 agent，`THREAD_HOST_AGENT_IDS` 成员）。

范围（v1 全集）：

- ACP **v1 稳定版**协议，仅 **client → agent** 方向
- 方法集：`initialize`、`session/new`、`session/prompt`、`session/cancel`、
  `session/list`（2026-08-24 增量）、`session/resume`（2026-08-24 增量）、
  `session/load`（2026-08-24 增量，历史回放，见 §4.8）、
  `session/close`（2026-08-24 并行增量：转发 Claw 线程归档）
- 出站通知：`session/update`

非目标（明确不做，client 传入即拒绝而非静默忽略）：

- `authenticate` / `requestPermission`
- `session/set_mode` / session modes
- MCP 配置（`mcpServers` 仅接受空数组）
- `additionalDirectories`（非空拒绝）
- ACP v2、HTTP / WebSocket 传输
- token 级流式输出（见 §13）

## 2. 总体架构

```text
ACP Client（编辑器 / CLI）
  │ stdio（JSON-RPC over ndjson）
  ▼
claw acp coder ──spawn──> scripts/run-coder-acp.js（ACP adapter，独立子进程）
  │ 本机 HTTP（默认 http://127.0.0.1:1420）
  ▼
Claw server（前置运行时：必须已启动，未启动报错，不自动拉起）
  ├ POST /protoclaw/acp/coder/sessions                 原子创建（018 新增）
  ├ GET  /protoclaw/acp/coder/sessions?cwd=…           会话发现（线程视角，2026-08-24 增量）
  ├ POST /protoclaw/acp/coder/sessions/:id/resume      会话续接（急切挂载，2026-08-24 增量）
  ├ GET  /protoclaw/acp/coder/sessions/:id/history     会话历史投影（session/load 数据面，2026-08-24 增量）
  ├ POST /protoclaw/threads/:threadId/commands         prompt 投递（现有）
  ├ GET  /protoclaw/threads/:threadId/events?after=N   事件增量读取（现有）
  └ POST /protoclaw/acp/coder/sessions/:id/interrupt   精确中断（018 新增）
  ▼
coder runtime（CallArbiter → CoderAgent；事件经 turn-event-mapping 写入 WorkThreadBoard）
```

三条不可违反的边界：

1. **adapter 只做协议转换**：不 import `@agentdev/*`、不实例化任何 Agent、
   不读 Claw 内部数据文件。唯一对外依赖是 ACP SDK 与本机 HTTP。
2. **Claw server 是唯一执行权威**：session / thread / runtime / interrupt 的
   真相全部在 server 进程；adapter 不做任何第二套执行。
3. **adapter 进程生命周期 ≠ Claw 数据生命周期**：adapter 退出 / 断开只释放
   自身内存映射，不删除、不停止任何 Claw 持久化对象（Q12）。

## 3. 对象与 ID 映射

| 概念 | 归属 | 生命周期 | 说明 |
|------|------|---------|------|
| ACP session | adapter 内存 | client 会话期间 | 协议层标识；**ID 即 Claw sessionId**（resume/list 要求跨进程可恢复，见 Q28）|
| Claw session (`clawSessionId`) | Claw server 持久化 | 持久 | coder 会话，`agentId: programming-helper` + `sessionType: coder` |
| WorkThread (`threadId`) | Claw server 持久化 | 持久 | 连续性锚点；session/new 时由 thread-integration 自动创建；**不外泄为协议标识**（仅出现在 list 响应元数据中，不作为投递/续接的协议键） |
| runtime (`viewerAgentId`) | ViewerWorker | 进程级 | 精确中断定位用；adapter 不直接使用，经 018 interrupt 路由间接生效 |

adapter 内每个 ACP session 的状态结构（session-manager.js）：

```js
{
  acpSessionId,      // 对 client 的协议 ID
  clawSessionId,     // Claw workspace session
  threadId,          // 连续性锚点（事件读写）
  cwd,               // 创建时的工作目录
  eventCursor,       // 上次轮询到的绝对游标
  activePrompt,      // null 或 { generation, abortController, cancelled, baseline }
  cancelGeneration,  // 单调递增的取消代数
}
```

## 4. 协议契约

> 代码片段为结构示意；准确 API 名以锁定版本的 `@agentclientprotocol/sdk`
> 类型声明为准（写法参考 `codex-acp/src/index.ts`）。

### 4.0 错误 taxonomy

| JSON-RPC code | 场景 | data |
|--------------|------|------|
| `-32602` | 参数非法：非 text block、`mcpServers` 非空、`additionalDirectories` 非空、未知 sessionId | 字段级说明 |
| `-32000` | `CLAW_SERVER_UNREACHABLE`：Claw server 未启动 / 连接失败 | `{ hint: '先启动 Claw server（npm start）' }` |
| `-32001` | `SESSION_BUSY`：该 session 已有 active prompt（resume 到 busy 会话同样拒绝） | 当前 prompt 代数 |
| `-32002` | `PROMPT_TIMEOUT`：等待终态事件超时（不自动 interrupt） | `{ waitedMs }` |
| `-32003` | `CLAW_ERROR`：server 返回业务错误 | 透传 server 错误体（含 resume/list 的 `thread_not_found` / `thread_archived` / `cwd_mismatch` / `runtime_ready_timeout` 等 code） |
| `-32601` | 未实现方法 | SDK 默认行为 |

`initialize` 不触网（Claw server 未运行时握手仍成功），连接类错误在首个触网
方法（`session/new` / `session/prompt` / `session/resume` / `session/list`）报告
——保持 ACP 连接可响应（Q14）。

### 4.1 initialize

```json
响应：
{
  "protocolVersion": "<SDK PROTOCOL_VERSION>",
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": { "image": false, embeddedContext: false },
    "sessionCapabilities": { "resume": {}, "list": {} }
  },
  "agentInfo": { "name": "agentdevclaw-coder-acp", "title": "AgentDevClaw Coder", "version": "<Claw version>" }
}
```

不声明：fs / terminal / recentEvents / MCP / sessionModes / authMethods。
`sessionCapabilities.resume` / `.list` 与 `loadSession: true` 自 2026-08-24
起声明（Q28–Q32）。

### 4.2 session/new

校验（任一失败返回 `-32602`）：

- `cwd`：必填字符串，原样传给 server 校验（存在且为目录；不隐式创建、不回退）
- `mcpServers`：必须存在且为空数组；非空拒绝
- `additionalDirectories`：非空拒绝
- `sessionModes`：非空拒绝

内部调用 `POST /protoclaw/acp/coder/sessions`（018 原子路由，见 §5 / §9.2），
响应 `{ clawSessionId, threadId, viewerAgentId, cwd }`（`viewerAgentId` 存映射、
不用于请求路径）。ACP 响应只含 `{ sessionId: acpSessionId }`。

### 4.3 session/prompt

输入规则：

- `prompt[]` 仅允许 `type: "text"` 的 block，多块按顺序合并为**一条** Claw user
  message（`\n\n` 连接）
- image / resource / resource_link / embedded context 一律 `-32602` 拒绝
- 同一 ACP session 同时只允许一个 active prompt；违反返回 `-32001`（Q9）

内部流程（详见 §6）：

```text
捕获基线（cursor + knownEventIds + maxTurn）
→ POST /protoclaw/threads/:threadId/commands
   { kind: "user_message", text, source: "acp", idempotencyKey: "acp-<uuid>" }
→ 每 500ms 轮询 GET /protoclaw/threads/:threadId/events?after=cursor
→ 新事件经 §7 映射为 session/update 发送
→ 终态事件 → 返回 PromptResponse
```

响应：`{ stopReason: "end_turn" }`（turn.completed）或
`{ stopReason: "cancelled" }`（turn.cancelled 或取消时序，见 §8）；
`turn.failed` → `-32003` 携带失败原因。

### 4.4 session/cancel

ACP 侧为 notification（无响应）。收到后：

1. 标记 `activePrompt.cancelled = true`、`cancelGeneration++`
2. 调 `POST /protoclaw/acp/coder/sessions/:clawSessionId/interrupt`
3. 不再向 client 发送该代 prompt 的迟到 update（记 stderr 日志）
4. in-flight 的 `session/prompt` 请求尽快以 `cancelled` 返回

与 JSON-RPC 请求级取消（`$/cancel_request`，SDK 暴露为 handler `ctx.signal`）
**汇入同一取消状态机**——两条路径只触发一次 interrupt。

### 4.5 session/update（出站）

映射规则见 §7。粒度为 thread 事件粒度（v1 为整段消息，不伪流，见 §13）。

### 4.6 session/list（2026-08-24 增量，Q28–Q30）

会话发现：客户端重连后枚举可续接的对话。

```json
请求：{ "cwd": "D:\\code\\demo", "cursor": "可选分页游标" }
响应：{ "sessions": [ { "sessionId": "session-…", "cwd": "D:\\code\\demo",
                        "title": "修复登录 bug", "updatedAt": "2026-08-24T…" } ] }
```

语义：

- **线程 = 对话**。每个活跃 WorkThread 只出一条，取 head 的 sessionId / cwd /
  title / updatedAt；compact 接力的历史成员不重复出现。
- 归档线程不列出；resume 到归档线程报 `thread_archived`。
- `cwd` 可选过滤：必须是已存在目录（与 session/new 同一校验），按
  head 会话持久化 `openDirectory` 规范化匹配（Windows 大小写/分隔符不敏感）。
- `cursor` 分页当前未启用（线程数量级小，全量返回）；保留协议字段，
  未来需要时加法式引入。
- server 路由 `GET /protoclaw/acp/coder/sessions` 返回的 `threadId` 是
  Claw 内部锚点元数据，adapter 不透传给 ACP client。

### 4.7 session/resume（2026-08-24 增量，Q28–Q32）

续接既有对话：恢复上下文、**不回放历史**，就绪即返回 `{}`；此后照常
`session/prompt`。

校验与解析顺序（任一失败即拒绝，错误前置）：

1. 参数校验（protocol.js `validateResumeSessionParams`）：`sessionId` 必填；
   `mcpServers` 非空 / `additionalDirectories` 非空 → `-32602`；
   `cwd` 提供时必须为已存在的绝对路径目录。
2. cwd 一致性：请求 `cwd` 与该会话持久化 `openDirectory` 不一致 →
   `-32003`（`cwd_mismatch`），防止拿错目录续接另一项目的上下文。
3. 线程解析：先按 head 命中（`findThreadByHeadSession` 快路径）；未命中再走
   thread-integration 成员链扫描（`findThreadBySession`，sessionChain 全成员
   匹配）。两者皆未命中 → `thread_not_found`。
4. 绑定到当前 head：无论请求的是哪个历史成员，一律绑定到该线程**当前
   head 会话**——客户端视角\"线程 = 对话\"，接力细节对其透明；resume 不改变 Thread 链。
5. 历史成员可以 resume 到当前 head；Web/chat user-turn 不能直接写入历史成员，服务端返回 `session_not_head`。
6. 归档检查：归档线程 → `thread_archived`（先取消归档才能继续）。
6. 急切挂载：runtime 已运行则幂等复用；否则启动并等 READY（复用
   `CLAW_ACP_READY_TIMEOUT_MS` 预算）。失败 → `runtime_ready_timeout`
   等，**不拖到第一次 prompt 才暴露**。

server 路由 `POST /protoclaw/acp/coder/sessions/:clawSessionId/resume` 返回
`{ clawSessionId(head), threadId, viewerAgentId, cwd }`；adapter 据此建立映射，
ACP 响应只含 `{}`。

与 busy 交互：目标会话已有 active prompt 时按 §4.0 拒绝（`SESSION_BUSY`）。

### 4.8 session/load（2026-08-24 增量）

历史回放版续接：控制面完全复用 resume（§4.7 的全部校验与 head 解析），
数据面新增 head 历史回放。`initialize` 声明 `loadSession: true`。

链路（adapter `loadSession`）：

1. `validateLoadSessionParams`（与 resume 同构；协议要求 load 请求必带
   `mcpServers`，空数组即可）。
2. 调 resume 路由（控制面）：cwd 校验 → head/成员链解析 → 归档拒绝 →
   急切挂载等 READY。协议 ID 与映射登记 = head（同 resume）。
3. `GET /protoclaw/acp/coder/sessions/:headSessionId/history`（数据面，
   server 读完整会话快照后投影）：只保留 user/assistant/tool 三类的
   回放必需字段（content / toolCalls / toolCallId），system 提示、
   reasoning、turn/usage 等内部字段一律不外放。快照文件缺失 →
   `session_snapshot_missing`（404）。
4. 回放的是 **head** 的历史——与实际上下文一致（请求成员会话时，
   compact 接力后 head 上下文才是 prompt 的落点；回放旧成员历史会与
   实际上下文不符）。
5. 投影消息经 `buildSessionReplayNotifications` 转为有序
   `session/update` 通知：user → `user_message_chunk`；assistant 工具
   调用 → `tool_call`（kind 按工具名映射：read/edit/write/bash/grep/
   web_search 等 → read/edit/execute/search/fetch，未知归 other），
   文本 → `agent_message_chunk`；tool 结果 → `tool_call_update`
   （`status: completed` + 结果文本块）。孤儿 tool 结果（无对应
   tool_call）跳过。
6. 响应 `{ sessionId }`（head 协议 ID；协议本体为 void，此为复用 resume
   的非标扩展字段，client 亦可从回放通知的 sessionId 获知）。

ACP 响应后 client 照常 `session/prompt`（落在 head 上）。

## 5. session 生命周期

> Thread 级归档和 Session/Runtime/Board 的完整生命周期以 [`work-thread-lifecycle.md`](work-thread-lifecycle.md) 为准。ACP 的 `session/close` 只是把关闭意图转发为 Thread archive，不删除 Session 历史；adapter 断开不会触发 archive。

### 创建（原子性）

由 018 新增的 server 路由单事务完成（进程内编排，非 HTTP 自调用）：

```text
1. 校验 cwd（绝对路径规范化、存在、是目录）
2. 创建 coder session（复用 session-helpers；sessionType: main）
3. 启动精确 session runtime（复用 agent 启动链路）
4. 等待 READY（默认 30s 超时）
5. 从 thread store 按 headSessionId === clawSessionId 解析 threadId
6. 取 viewerAgentId
7. 返回 { clawSessionId, threadId, viewerAgentId, cwd }
```

失败回滚阶梯（**从未交付给 client 的半成品必须回滚**，与断开语义相反方向）：

```text
runtime 已启动 → 精确 stop（agentId=coder + sessionId）
thread 已创建  → 关闭该 thread
session 已写入 → 从 session index 删除
回滚自身失败   → 不掩盖：错误响应附各步骤状态与遗留对象 ID，供手动清理
```

### 断开 / 退出

adapter 进程退出或 client 断开：仅释放内存映射。Claw session / thread /
runtime 按 Claw 自身持久化与恢复机制保留（Q12）；`session/close` 由 client
显式调用（转发 Claw 线程归档，2026-08-24 并行增量），断开不触发。

### 续接（resume，2026-08-24 增量）

client 重连后经 `session/list` 发现会话（协议 ID 即 Claw sessionId，
无需额外映射持久化），再以 `session/resume` 续接：server 侧急切挂载
head runtime 并等 READY；adapter 仅在就绪后登记内存映射。历史消息
不回放——客户端如需展示历史，用 list 返回的 title / updatedAt 自行
呈现，或未来加法式引入 `session/load`。

## 6. prompt 执行管线

**串行约束**：一 ACP session 一 active prompt（Q9）。并发 prompt 直接
`-32001`，不排队、不 steering。

**投递语义澄清**：`POST threads/:id/commands` 的成功只代表 user-turn 已被
ViewerWorker mailbox 接受（`deliverPendingCommands.delivered`），**不代表执行
完成**。完成判定只看事件流终态。

**轮询**：固定间隔（默认 500ms，可配）`GET events?after=cursor`；每轮：

1. 对返回事件按 eventId 去重（二线防御，见 §9.1）
2. 映射为 `session/update` 发送
3. 终态判定（见下）
4. 更新 `eventCursor`

**终态判定**（事件流驱动，**不看看板状态**——`turn.cancelled` 后 board 状态
可能仍为 running）：

- `turn.completed` → `{ stopReason: "end_turn" }`
- `turn.failed` → `-32003`
- `turn.cancelled` → `{ stopReason: "cancelled" }`
- prompt 归因按 §9.3 三层判定

**超时**：默认 30 分钟，`CLAW_ACP_PROMPT_TIMEOUT_MS` 覆盖（`0` = 禁用）。
超时返回 `-32002`，**不自动 interrupt**——adapter 等待超时 ≠ runtime 应停止
（Q25）。

## 7. 事件映射

| thread 事件 | ACP session/update | 字段规则 |
|------------|--------------------|---------|
| `item.completed`（type=agent_message） | `agent_message_chunk` | `messageId = item.id`，`content = { type: "text", text: item.text }`；整段发送，不切分 |
| `item.started`（type=tool_call） | `tool_call` | `toolCallId = item.id`，`title = item.tool`，`name = item.tool`，`kind = classifyTool()`，`status: "in_progress"`，`rawInput` 仅当存在 |
| `item.completed`（type=tool_call） | `tool_call_update` | `toolCallId = item.id`，`status: failed→"failed" 其余→"completed"`，`rawOutput` 仅当存在 |
| `turn.failed` | （无 update）prompt 以 `-32003` 失败 | 失败原因入 data |
| `turn.completed` / `turn.cancelled` | （无 update）prompt 终态 | 见 §6 |
| `turn.started`、`item.*`（type=reasoning） | 不映射 | 不发送 |

**缺失字段规则**（当前 runtime 在 `callFinished` 经
`reportSessionItemsForTurn()` 批量写事件，字段天然不齐）：

- 缺 `item.id` → 生成稳定 fallback ID（`tool:<name>:<turn>:<seq>`）
- 只有 completed 没有 started 的 tool → 先补发最小 `tool_call`（status
  `in_progress`）再发 `tool_call_update`
- `rawInput` / `rawOutput` 不存在时省略字段，**不构造假值**；任意字符串不强转
  结构化 JSON

**kind 最小分类**（Q18）：

| 工具名匹配 | kind |
|------------|------|
| bash / shell / exec / powershell | `execute` |
| read / glob / grep / lsp_* | `read` |
| write / edit | `edit` |
| web / search | `search` |
| 其余 | `other` |

## 8. 取消语义

**双层取消汇流**：`session/cancel`（notification）与 `$/cancel_request`
（handler `ctx.signal`）→ 同一 `cancelGeneration` 状态机。第 N 代 prompt 被
标记取消后：

```text
标记 cancelled → cancelGeneration++
→ 调 interrupt 路由（一次）
→ 停止发送该代 update（迟到事件仅 stderr 日志）
→ in-flight prompt 请求返回 { stopReason: "cancelled" }
```

**interrupt 链路**（adapter 全程不接触 viewerAgentId）：

```text
POST /protoclaw/acp/coder/sessions/:clawSessionId/interrupt（018）
→ server 内解析该 session 当前 runtime 的 viewerAgentId
→ 现有 /api/agents/:id/interrupt 同链路 → ViewerWorker
→ UDS 下发 { type: "interrupt-agent", clearQueue: true }
→ DebugHub setInterruptHandler → CallArbiter.interruptActive()
```

`clearQueue` 固定 true：同时取消 active call 与该 runtime 已排队 user-turn，
符合 coder 自主执行语义。

**cancel 早于 turn.started 的竞态**（Q24）：命令已被 mailbox 接受但 turn 尚未
开始时取消——adapter 立即返回 `cancelled` 并照常发 interrupt，**不等待**
`turn.cancelled` 事件（runtime 可能来不及产生）；迟到事件按 generation 丢弃。

## 9. 工程风险与解决方案

### 9.1 事件游标跨裁剪不稳定（框架缺陷，017 权威修复）

`WorkThreadBoard`（`AgentDev/src/core/workthread/board.ts`）：
`MAX_EXECUTION_EVENTS = 500`，裁剪旧事件后 `cursor = events.length`、
`events.slice(after)` 均为数组局部语义。丢事件场景**不可检测**：

```text
已读 cursor=500 → board 裁 100 追 100 → 数组仍 500 条（对应原事件 100~599）
slice(500) = [] → adapter 永远看不到事件 500~599，且响应无任何信号
```

修复（017，框架仓库）：

- `baseOffset` 累计被裁剪数；`getExecutionEvents` 返回绝对游标
  `baseOffset + events.length`
- `after < baseOffset` 时 clamp 到 0（从头返回可用窗口，兼容旧调用方）
- `baseOffset` 随 board 状态持久化（或由 store 事件总数推导），重启不归零

adapter 侧保留 eventId 去重作为**二线防御**（防重复，不防丢失；定位是防御，
不是解决方案——server 侧游标覆盖层方案已拒绝，理由见 ADR-0004 / Q26）。

### 9.2 session 创建非原子（018 解决）

现有 `POST /protoclaw/prebuilt_sessions` 是「session 写入 → runtime 启动 →
thread 自动创建」三步无回滚，且响应不含 `threadId`。逐端点组合调用失败时留
孤儿对象。解决：018 原子路由 + 回滚阶梯（见 §5）。

### 9.3 事件无 prompt 级关联 ID（三层判定，019 实现）

事件字段 `{ type, turn, eventId, item }` 中 `turn` 数字不能单独作为 prompt
标识（多 runtime 接力 / 旧事件回放 / 续跑场景）。v1 采用：

1. **基线排除（主判定）**：prompt 投递前记录 `{ cursor, knownEventIds,
   maxTurn }`；只处理「命令接受后出现且 eventId 不在基线中」的事件
2. **终态判定**：命令接受后观察到的**第一个**终态事件结束本 prompt（prompts
   已串行 + CallArbister FIFO，正常时序下即为本 prompt 的 turn）
3. **turn sanity check**：终态事件 `turn <= baseline.maxTurn` 视为旧事件回
   放，仅告警不判定终态，继续等待

**已知误归因场景（文档化，v1 接受）**：ACP prompt 执行期间，若有人在 Claw
Web UI 向**同一个** session 手动输入，其 turn 事件会交织进本 prompt 的
update 流。由于每个 ACP session 独占新建 session（Q2），实际发生率极低。
精确修复（runtime 在 `turn.started` 透传发起 command id）列为后续框架级改
进项。

## 10. 文件与模块清单

新增（Claw）：

| 文件 | 职责 |
|------|------|
| `scripts/run-coder-acp.js` | 入口：stdio 装配、进程信号、退出清理 |
| `scripts/coder-acp/protocol.js` | 请求校验、响应构造、错误 taxonomy（§4.0） |
| `scripts/coder-acp/claw-client.js` | 本机 HTTP client：超时、错误归一、不依赖 Express / 框架 |
| `scripts/coder-acp/session-manager.js` | ID 映射、activePrompt、cancelGeneration、断开清理（仅内存） |
| `scripts/coder-acp/event-mapper.js` | thread event → SessionUpdate、kind 分类、eventId 去重、缺失字段规则 |
| `scripts/coder-acp/main.js` | SDK handler 注册、stderr 日志 |
| `server/routes/acp.js` | 原子创建 + 精确 interrupt（018） |

修改（Claw）：

| 文件 | 改动 |
|------|------|
| `bin/claw.mjs` | `claw acp coder` 子命令（spawn adapter，stdio inherit） |
| `server/routes/thread-routes.js` | events 响应**加法式**附加 `eventId` / `receivedAt`（不重构形态） |
| `server.js` | 注册 acp 路由（按现有路由注册模式） |
| `package.json` / `package-lock.json` | `@agentclientprotocol/sdk`（registry 精确版本） |
| `agents/README.md`、`AGENT.md` | ACP 使用说明与架构定位（020） |

修改（AgentDev，017）：`src/core/workthread/board.ts`（见 §9.1）。

## 11. 配置项

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `CLAW_ACP_BASE_URL` | `http://127.0.0.1:1420` | Claw server 地址 |
| `CLAW_ACP_PROMPT_TIMEOUT_MS` | `1800000` | prompt 终态等待超时；`0` 禁用 |
| `CLAW_ACP_POLL_INTERVAL_MS` | `500` | 事件轮询间隔 |
| `CLAW_ACP_READY_TIMEOUT_MS`（server 侧） | `30000` | session/new 内部等待 runtime READY |

## 12. 测试矩阵

全部 Node 内置 `node:test`，不引入 Vitest；不调用真实模型；Claw HTTP 以本地
mock server / 测试替身模拟。

| 文件 | 覆盖 |
|------|------|
| `test/coder-acp-event-mapper.test.js` | §7 映射表全行；reasoning 忽略；缺 id/缺 started/缺 raw 字段；重复 eventId；未知事件 |
| `test/coder-acp-session-manager.test.js` | 映射建立；串行约束（busy）；cancel 早于 turn.started；cancel 后迟到事件按 generation 丢弃；超时；server 错误；断开仅清内存 |
| `test/coder-acp-routes.test.js` | cwd 三种非法；READY 超时 / 启动失败 / thread 缺失三种注入的回滚阶梯断言；interrupt 精确性；非 coder 拒绝；events 附加字段与旧字段共存；list（归档过滤 / cwd 过滤 / head 出口）；resume（head 命中、成员链回退到 head、归档拒绝、无线程拒绝、cwd 不匹配拒绝） |
| `test/coder-acp-wire.test.js` | spawn adapter → stdin 喂 initialize / session/new / session/prompt；stdout 每行可 `JSON.parse`；收到 `session/update` 与 PromptResponse；无日志混入 stdout；诊断在 stderr；initialize 声明 `sessionCapabilities.{resume,list}`；session/list → mock server 条目透传；session/resume → prompt → end_turn 全链路 |
| AgentDev 侧 board 测试（017） | >600 事件跨裁剪增量读不丢不重；重启恢复 cursor 不回退 |
| `test/thread-events-cursor.test.js` | Claw 侧直接实例化 `WorkThreadBoard` 消费 017 语义 |

## 13. v1 已知限制（文档化边界）

1. **整段消息粒度**：coder runtime 在 `callFinished` 批量写 `item.*` 事件，
   `agent_message_chunk` 为整段文本而非 token 流。不伪造流式（Q17）；token 级
   实时流需框架事件桥（后续项）。
2. **轮询延迟**：update 到达粒度 = 轮询间隔（默认 500ms）。
3. **UI 并发输入误归因**：见 §9.3。
4. **无历史回放**：`session/resume` 只恢复上下文不回放消息（ACP 语义即如此，
   回放属 `session/load`，未实现）；client 断开期间的消息在续接后不会补发。
5. **仅文本输入**：image / resource / embedded context 均不支持。
