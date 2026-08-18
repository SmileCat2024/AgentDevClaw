# Plain Agents

不建立工作空间、不进 prebuilt-agents 的轻量 agent 目录。

## 目录约定

```
agents/<name>/
  agent.js        # 必须：export default 一个 Agent 类（extends BasicAgent）
  metadata.json   # 可选：name / description / modelPresets
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
| 依赖 | `agentdev` + `@agentdev/*` tgz 包与 `local-features/dist` |
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

# 列出已注册的 plain agent
claw agents
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

### 其他约定

- `--keep-alive` 下会话已先落盘，Ctrl+C 优雅退出，之后可用 `--session <id>` 续接
- 模型配置：`agents/<name>/metadata.json` 的 `modelPresets`，推荐用 `.agentdev/agent-configs/<name>.json` 覆盖（不入库）

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
| 位置 | `prebuilt-agents/*/*/` | `agents/<name>/` |
| workspace 列表 | 出现 | 不出现 |
| UI 声明 | metadata.json 的 ui 字段 | 不需要 |
| 启动方式 | server 托管（start_agent / 面板） | CLI 直接 spawn |
| 被监视 | 常驻连接 ViewerWorker | 运行期连接 ViewerWorker（可 --headless 跳过） |
| 依赖 server | 是 | 否 |
