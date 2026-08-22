# Plain Agents

不建立工作空间、不进 prebuilt-agents 的轻量 agent 目录。

## 目录约定

```
agents/<name>/
  agent.js        # 必须：export default 一个 Agent 类（extends BasicAgent）
  metadata.json   # 可选：name / description / modelPresets

# 或者：任意 Agent 项目目录（通过注册表接入）
my-agent/
  agent.js
  metadata.json   # id / entry / deployment.kind=standalone / modelPresets / features[]
```

模型配置优先级（与 prebuilt agent 一致）：

1. `.agentdev/agent-configs/<name>.json` 的 `modelPresets`（推荐，不入库）
2. `agents/<name>/metadata.json` 的 `modelPresets`

## 内置 plain agents

| | coder |
|---|---|
| 定位 | 编程小助手能力的独立快照（CLI 裁剪版） |
| 提示词 | 本目录 `.agentdev/prompts/`（system.md / explore.md / reminder） |
| feature | 编程小助手 v2.0.0 裁剪：保留 todo / shell / lsp / memory / websearch / github / context-guard / audio-feedback / image-reader / opencode-basic；移除 audit / user-input / generative-ui / claw-dispatch / group-chat-bridge / subagent |
| 依赖 | `@agentdev/core|llm|viewer|mcp`（本地 junction）+ `@agentdev/*` tgz 包与 `local-features/dist` |
| 模型 | metadata.json 指定（`ZCode GLM-5.3`），可用 `.agentdev/agent-configs/coder.json` 覆盖 |

`coder` 的装配与提示词是交付时点的独立拷贝（agent.js 不 import `prebuilt-agents` 下任何代码），
feature 包装类与 local-features 为共享实现（上游修复自动生效）；上游编程小助手后续演进不影响其装配结构。

## 使用

```bash
# 启动（默认连接 ViewerWorker，可在 Claw 面板"已连接"中监视）
claw run coder --goal "介绍一下你自己"

# 纯 headless（CI / 脚本场景）
claw run coder --goal "..." --headless

# 指定工作目录 / 续接会话
claw run coder --goal "..." --cwd D:/code/some-project --session <sessionId>

# 输出格式（默认 result）
claw run coder --goal "..." --format text    # 分隔线 + 响应全文 + 会话摘要（人类可读）
claw run coder --goal "..." --format json    # pretty-print 全量结果 JSON
claw run coder --goal "..." --format quiet   # stdout 仅响应正文，可安全管道化（日志全走 stderr）
claw run coder --goal "..." --format jsonl   # stdout 输出 codex exec 风格会话事件 JSONL 流

# 运行结束后不自动关闭 agent（保持 viewer 连接，Ctrl+C 结束）
claw run coder --goal "..." --keep-alive

# 列出内建与用户注册的 plain agent
claw agents

# 注册 Studio/用户开发的独立 Agent（项目源码不复制进 Claw）
claw agents register D:/code/my-agent

# 如果该 Agent 项目由 Studio 管理，关联 Studio 项目以允许 --debug 源码覆盖
claw agents register D:/code/my-agent --studio D:/code/my-agent-studio

# 查看或移除注册
claw agents inspect my-agent
claw agents unregister my-agent

# release 默认从 Feature 仓库使用 metadata.features 的精确 tgz 版本
claw run my-agent --goal "..."

# 只对带 --studio 注册的 Agent：开发中 Feature 从 Studio 构建产物加载
claw run my-agent --goal "..." --debug
```

### 监视模式 vs 无头模式

| | 默认（监视模式） | `--headless` |
|---|---|---|
| ViewerWorker 连接 | 连接（Claw 面板"已连接"里可实时监视该会话） | 完全不连（CI / 纯脚本场景） |
| 连接失败行为 | 自动降级为 headless 继续执行，不报错 | 无此环节 |
| stdio 输出协议 | 不受影响，与 headless 完全一致 | 同左 |
| 等效环境变量 | — | `PROTOCLAW_HEADLESS=1` |

关键认知：**监视可见性与 stdio 数据协议不互斥**。连不连 viewer 只影响 Web UI 里能否看到，stdout/stderr 的输出契约两种模式下完全一致。

### 输出格式与 stdio 契约

通用契约：**过程信息（reasoning / 工具执行的 human 渲染 + 运行日志）一律走 stderr；stdout 只承载结果数据，任何格式下都可安全管道化**；错误信息永远在 stderr，出错时 exit code 为 1。PowerShell 下丢弃 stderr 用 `2>$null`（`2>/dev/null` 是 bash 语法）。

| 格式 | stdout 内容 | 适用场景 |
|---|---|---|
| `result`（默认） | 单行 `PLAIN_AGENT_RESULT:<json>`，字段 `ok / response / error / agentId / sessionId / durationMs / timestamp` | 程序化消费，向后兼容 |
| `text` | 分隔线 + 响应全文 + 分隔线 + 摘要行（agent/session/duration/ok） | 人看的一次性结果 |
| `json` | pretty-print 全量结果 JSON（同 result 字段） | 调试结果结构 |
| `quiet` | 仅响应正文本身 | 管道接续（如 `\| jq`、写文件）；stdout 整体重定向到 stderr 以拦截绕过 console 的直写 |
| `jsonl` | codex exec `--json` 风格会话事件 JSONL 流（见下） | 机器实时消费全过程 |

`jsonl` 事件流形态（每行一个 JSON，顺序即生命周期）：

```json
{"type":"thread.started","threadId":"plain-..."}      // threadId 即 sessionId
{"type":"turn.started","turn":0}
{"type":"item.completed","item":{"type":"reasoning","text":"..."}}
{"type":"item.started","item":{"id":"call_...","type":"tool_call","tool":"read","arguments":{...},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"call_...","type":"tool_call","status":"completed","result":"...(≤1000 字符)"}}
{"type":"item.completed","item":{"type":"agent_message","text":"最终回复全文"}}   // 不截断
{"type":"turn.completed","turn":0,"usage":{"inputTokens":...,"outputTokens":...}}
{"type":"turn.failed",...} / {"type":"error","message":"..."}
```

- `tool_call` 靠 `id`（call.id）配对 started / completed
- 工具 `result` 截断到 1000 字符，超限时带 `resultTruncated:true, fullLength:N`——事件流是推送渠道不是全量存储，完整结果已随会话落盘，用 `threadId` 回查
- jsonl 模式**不输出** `PLAIN_AGENT_RESULT:` 行（事件流已含结果），成败由 exit code 表达

非 jsonl 格式下，同样的事件流会以 human 可读行渲染到 stderr（`tool: read {"filePath":...}` / `succeeded: <preview>` / 缩进的 reasoning / `agent:` 回复块 / `tokens:` 汇总），对齐 codex exec 默认形态。

## ACP coder 适配器

ACP 适配器是一个独立的 stdio 子进程：它只做 ACP JSON-RPC 与 Claw 本机 HTTP 的协议转换，实际 session、WorkThread、runtime 和 interrupt 执行权威仍在已运行的 Claw server。完整设计见 [`docs/coder-acp-adapter-design.md`](../docs/coder-acp-adapter-design.md) §10 / §11 / §13，架构决策见 [`docs/adr/0004-acp-adapter-external-stdio-process.md`](../docs/adr/0004-acp-adapter-external-stdio-process.md)，本次 CLI 与文档收尾对应 [`docs/tickets/020-claw-acp-cli-and-docs.md`](../docs/tickets/020-claw-acp-cli-and-docs.md)。Claw server 必须先通过 `npm start` 启动；适配器不会自动拉起它。

### 启动配置

ACP client 的 agent 启动项配置为调用 `claw acp coder`，例如：

```json
{
  "command": "claw",
  "args": ["acp", "coder"]
}
```

如果 client 不继承包含 `claw` 的 PATH，也可以直接配置 Node 与仓库脚本：

```json
{
  "command": "node",
  "args": ["D:/code/AgentDevClaw/scripts/run-coder-acp.js"]
}
```

CLI 通过 `stdio: inherit` 直通适配器的 stdin/stdout/stderr，不在 JSON-RPC 帧外增加包装层。

### 能力边界

支持的 client → agent 方法只有：

- `initialize`：返回 ACP v1 握手与 coder 能力声明，不访问 Claw server。
- `session/new`：要求 `cwd` 为非空字符串；`mcpServers` 必须为空（可省略，非空拒绝）；`additionalDirectories` 与 `sessionModes` 必须为空或省略（非空拒绝）；由 server 原子创建 coder session 与 WorkThread。
- `session/prompt`：只接受一个或多个 `type: "text"` block，按顺序以两个换行符分隔并合并为一条 user message；同一 ACP session 只允许一个 active prompt。受理后先回显 `user_message_chunk`（client 转录完整性）；正常结束返回 `stopReason: "end_turn"`，turn 事件携带用量时随响应返回 `usage`；turn 失败同样返回 `end_turn` 并以 `_meta.claw.terminalFailure` 携带结构化失败（codex-acp 风格，不抛 JSON-RPC error，对话保持连续）。
- `session/cancel`：notification；与请求级取消汇入同一状态机，最多对对应 Claw session 触发一次精确 interrupt。
- `session/close`：显式归档——转发 Claw 关闭对应 WorkThread 并释放映射；有 active prompt 时拒绝（先 cancel）。client 断开不会自动触发（断开只清 adapter 内存，Claw 对象保留）。

出站只发送 `session/update`，包括用户消息回显、整段 `agent_message_chunk`、reasoning 的 `agent_thought_chunk`（thinking 折叠区）、tool call 开始与完成更新。未声明或不支持的能力包括：

- `session/load`、`session/resume`
- `authenticate`、`requestPermission`
- `session/set_mode` 与 session modes
- 非空 `mcpServers`
- 非空 `additionalDirectories`
- ACP v2、HTTP / WebSocket 传输
- token 级流式输出
- image、resource、resource_link、embedded context 等非文本 prompt block

非法参数会返回 `-32602`；未实现方法返回 `-32601`。Claw server 不可达时，触网方法返回 `-32000`，不会静默降级。

### stdout / stderr 契约

- **stdout 只承载 JSON-RPC**：ACP ndjson 输入输出中的每一行都应是可解析的 JSON；CLI 和适配器不向 stdout 写启动提示、human 日志或诊断。
- **stderr 承载诊断**：启动、连接、轮询、取消和错误诊断均走 stderr，带等级与 `coder-acp` 命名空间；排障 trace 能力见票 [021](../docs/tickets/021-claw-acp-adapter-observability.md)。
- client 应分别消费两条流；不要把 stderr 当作协议输入，也不要从 stdout 中过滤日志来恢复 JSON-RPC。

### 配置项

| 环境变量 | 默认值 | 作用 |
|---|---:|---|
| `CLAW_ACP_BASE_URL` | `http://127.0.0.1:1420` | Claw server 本机 HTTP 地址 |
| `CLAW_ACP_PROMPT_TIMEOUT_MS` | `1800000` | 等待 prompt 终态事件的超时（30 分钟）；`0` 表示禁用，不自动 interrupt |
| `CLAW_ACP_POLL_INTERVAL_MS` | `500` | 事件增量轮询间隔（毫秒） |
| `CLAW_ACP_READY_TIMEOUT_MS` | `30000` | server 侧 `session/new` 等待 runtime READY 的超时（毫秒） |

### v1 已知限制

1. **整段消息粒度**：`agent_message_chunk` 是 runtime 批量事件中的整段文本，不是 token 级实时流。
2. **轮询延迟**：更新到达 client 的粒度受轮询间隔影响，默认约 500ms。
3. **UI 并发输入误归因**：ACP prompt 执行期间，若同一 Claw session 同时从 Web UI 输入，交织事件可能被归入当前 ACP prompt；精确 command-id 关联属于后续框架改进。
4. **无 load/resume**：没有 `session/load` 或 `session/resume`；client 断开不会删除 Claw session、WorkThread 或 runtime，重连需新建 ACP session；显式归档用 `session/close`。轮询期间 thread 已在 Claw 侧被关闭/删除时，prompt 以结构化 `CLAW_THREAD_LOST` 错误（`-32003`，data 含 threadId 与 hint）终止。
5. **仅文本输入**：image、resource、resource_link 和 embedded context 均不支持。

### 其他约定

- `--keep-alive` 下会话已先落盘，Ctrl+C 优雅退出，之后可用 `--session <id>` 续接
- 模型配置：`metadata.json` 的 `modelPresets`，推荐用 `.agentdev/agent-configs/<id>.json` 覆盖（不入库）
- 现代独立 Agent 的 `metadata.json` 必须提供 `id`、相对 `entry`、`deployment.kind: "standalone"`；正式运行的 `features[]` 每项必须是精确版本的包名。
- `claw run` 为现代 Agent 在 `~/.agentdev/AgentDevClaw/runtime-envs/<id>/<dependency-hash>/` 准备隔离依赖环境。Agent 源码不被修改；现代 metadata Agent 会复制到该生成环境，以便其 ESM import 与 Feature 包解析同一份 `node_modules`。
- `--debug` 只接受与 Studio 项目关联的注册 Agent，且只将 Studio 中同包名的标准 Feature 项目覆盖为源码 `dist`；未覆盖依赖仍使用仓库 tgz。

## 数据落盘

会话与索引写入用户目录，不污染仓库：

```
~/.agentdev/AgentDevClaw/agents/<name>/sessions/
  index.json          # 会话索引（与 server 侧格式对齐）
  <sessionId>.json    # 会话文件
```

## 与 prebuilt agent 的区别

| | prebuilt agent | plain agent |
|---|---|---|
| 位置 | `prebuilt-agents/*/*/` | `agents/<name>/` 或用户 Agent registry |
| workspace 列表 | 出现 | 不出现 |
| UI 声明 | metadata.json 的 ui 字段 | 不需要 |
| 启动方式 | server 托管（start_agent / 面板） | CLI 直接 spawn |
| 被监视 | 常驻连接 ViewerWorker | 运行期连接 ViewerWorker（可 --headless 跳过） |
| 依赖 server | 是 | 否 |
