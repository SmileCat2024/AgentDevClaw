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

`coder` 是交付时点的完整拷贝（agent.js、feature 包装类、提示词均为独立副本），
不 import `prebuilt-agents` 下任何代码；上游编程小助手后续演进不影响它。

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

# 运行结束后不自动关闭 agent（保持 viewer 连接，Ctrl+C 结束）
claw run coder --goal "..." --keep-alive

# 列出已注册的 plain agent
claw agents
```

### 输出与退出码约定

- 过程日志一律走 stderr，stdout 只承载结果数据，任何格式下都可安全管道化
- `--format result`（默认）输出单行 `PLAIN_AGENT_RESULT:<json>`，字段：`ok / response / error / agentId / sessionId / durationMs / timestamp`
- 出错时 exit code 为 1，错误信息在 stderr
- `--keep-alive` 下会话已先落盘，Ctrl+C 优雅退出，之后可用 `--session <id>` 续接

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
