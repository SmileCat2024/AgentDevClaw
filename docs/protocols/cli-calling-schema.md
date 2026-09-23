# AgentDevClaw CLI 调用 Schema

本文档梳理 AgentDevClaw 的 `claw` CLI 的完整调用方式、stdio 流（stdout / stderr）契约、输出消息格式，以及**编程小助手工作空间中的 `coder` 身份**（sessionType 会话身份）的线程调用面（`claw threads`）。

> **工作空间 coder**：编程小助手工作空间内的会话身份（`agentId=programming-helper` + `sessionType=coder`），以 **线程（thread）** 为执行承接单位，经 `claw threads` 命令族调用/审计（见 §10）。
>
> 权威补充文档：[`agents/README.md`](../../agents/README.md)。修改 CLI 行为时必须同步更新该文档与本文档。

---

## 1. 概述

`claw` CLI 有两层调用面：

- **Plain Agent 层**：面向无工作空间的轻量 agent（`claw run` / `claw agents`），不依赖 Claw server 也能运行。
- **Claw server 控制面**：通过 HTTP 访问正在运行的 Claw server（`claw threads` / `claw ws`），用于控制工作空间里的线程、会话等持久化对象。

Plain Agent 的核心设计意图：

- **轻量、可组合**：建一个目录写一个 `agent.js` 即可作为其他软件的组件被 CLI 集成。
- **无头审计模式**：agent 作为组件运行时，全过程可经 stdio 管道化消费（对齐 `codex exec` 契约），同时保持 "Web UI 监视可见" 与 "CLI 审计可用" 两个面互不干扰。

Plain Agent 入口链路：

```
bin/claw.mjs（薄壳，命令路由）
  └──> scripts/run-plain-agent.js（运行器：模型解析、viewer 连接/降级、会话落盘与索引）
        └──> agents/<name>/agent.js（Agent 类）或用户注册的独立 Agent 项目
```

CLI 顶层可用命令（通过 `claw help` 查看）：

| 命令 | 作用 |
|------|------|
| `claw` | 总览（Overview） |
| `claw help` / `--help` / `-h` | 查看全部命令用法 |
| `claw ws` | 工作空间相关操作（针对 prebuilt workspace providers） |
| `claw run <name> --goal "..."` | **运行一个 plain agent（核心命令）** |
| `claw agents` | 列出 / 注册 / 移除 / 查看 plain agent |
| `claw threads` | 持久化工作线程（thread）控制面（依赖 Claw server） |

---

## 2. Plain Agent 调用（核心）

### 2.1 `claw run`

运行单个 plain agent 的单次调用（`onCall`），结束后输出结构化结果。

```
claw run <agent-name> --goal "..." [--session <id>] [--cwd <dir>] [--headless]
                                [--debug] [--format result|text|json|quiet|jsonl] [--keep-alive]
```

| 参数 | 说明 | 默认 |
|------|------|------|
| `<agent-name>` | 必填。agent 标识（`agents/` 目录下的 agent 或已注册 ID） | — |
| `--goal "..."` | 必填。单次调用的目标/指令文本 | — |
| `--session <id>` | 可选。续接已落盘的历史会话 ID | 新建随机会话 |
| `--cwd <dir>` | 可选。指定工作目录 | 当前目录/`PROTOCLAW_AGENT_CWD` |
| `--headless` | 不连接 ViewerWorker（CI / 纯脚本场景） | 连接 viewer（可被面板监视） |
| `--debug` | 只用带 `--studio` 注册的 Agent，从 Studio 源码加载开发中 Feature | release（仓库 tgz） |
| `--format <fmt>` | 输出格式：`result` / `text` / `json` / `quiet` / `jsonl` | `result` |
| `--keep-alive` | 调用完成后不退出，保持 viewer 连接（Ctrl+C 结束） | 调用后自动退出 |

**监视模式与无头模式对比**：

| | 默认（监视模式） | `--headless` |
|---|---|---|
| ViewerWorker 连接 | 连接（面板"已连接"可实时监视） | 完全不连 |
| 连接失败行为 | 自动降级为 headless 继续执行，不报错 | 无此环节 |
| stdio 输出协议 | 与 headless **完全一致** | 同左 |
| 等效环境变量 | — | `PROTOCLAW_HEADLESS=1` |

> 关键认知：**监视可见性与 stdio 数据协议不互斥**。连不连 viewer 只影响 Web UI 里能否看到，stdout/stderr 的输出契约两种模式下完全一致。

### 2.2 `claw agents`

管理 plain agent（`agents/` 目录 + 用户注册）。

```
claw agents                              # 列出所有 plain agent
claw agents register <project-dir> [--studio <studio-dir>]   # 注册独立 Agent 项目
claw agents unregister <agent-id>        # 移除注册
claw agents inspect <agent-id>           # 查看 Agent 源与项目元数据
```

---

## 3. stdio 流契约（stdout / stderr 各发什么）

**统一原则**：

- **过程信息**（reasoning、工具执行的 human 渲染、`[PlainAgent]` 运行日志）**一律走 stderr**；
- **stdout 只承载结果数据**，任何格式下都可安全管道化；
- **错误信息永远在 stderr**，出错时 exit code 为 `1`；
- PowerShell 下丢弃 stderr 用 `2>$null`（`2>/dev/null` 是 bash 语法）。

### 3.1 各输出格式下的流分配

| 格式 | stdout 内容 | 过程信息（stderr） | 适用场景 |
|---|---|---|---|
| `result`（默认） | 单行 `PLAIN_AGENT_RESULT:<json>` | reasoning / 工具执行 human 行 / `[PlainAgent]` 日志 | 程序化消费，向后兼容 |
| `text` | 分隔线 + 响应全文 + 分隔线 + 摘要行 | 同上 | 人看的一次性结果 |
| `json` | pretty-print 全量结果 JSON | 同上 | 调试结果结构 |
| `quiet` | **仅响应正文** | 同上 | 管道接续（如 `\| jq`、写文件）；stdout 整体重定向到 stderr 以拦截绕过 console 的直写 |
| `jsonl` | **codex exec 风格会话事件 JSONL 流**（机器消费全过程） | 同上 | CI / 管道实时消费 |

非 `jsonl` 格式下，会话事件流会以 human 可读行渲染到 **stderr**（`tool: read {...}` / `succeeded: <preview>` / 缩进 reasoning / `agent:` 回复块 / `tokens:` 汇总），对齐 `codex exec` 默认形态。

### 3.2 运行日志（stderr）

`run-plain-agent.js` 会在 stderr 输出如下过程日志（供审计/调试）：

```
[PlainAgent] agent=coder source=built-in session=plain-... cwd=... headless=false debug=false
[PlainAgent] goal="..."
[PlainAgent] model preset => ZCode GLM-5.3
[PlainAgent] ✓ 已连接 ViewerWorker (port 2026)，可在 Claw 面板监视
[PlainAgent] 开始执行 agent.onCall()...
[PlainAgent] agent.onCall() 完成，响应长度=...
[PlainAgent] ✓ 会话已保存: plain-...
[PlainAgent] --keep-alive：agent 保持运行（viewer 连接不断开），按 Ctrl+C 结束
```

### 3.3 human 事件行（stderr，text / json / quiet / result 格式下）

对齐 `codex exec` 的可读形态：

```
session: plain-...                    # 会话开始
tool: read {"filePath":"..."}         # 工具调用开始
  succeeded: <preview>                # 工具成功（结果截断到 120 字符）
  failed: <error>                     # 工具失败
  <缩进的 reasoning 文本>              # 推理过程
agent:                                # 回复块
  <缩进的回复全文>
tokens: input=... output=...          # 单轮 token 用量汇总
failed: <message>                     # turn 失败
cancelled: <reason>                   # guard 轮换 / 宿主中断
error: <message>                      # 致命错误
```

---

## 4. 输出消息格式详解

### 4.1 `result`（默认）

stdout 输出**单行**协议行：

```
PLAIN_AGENT_RESULT:<json>
```

JSON 字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | bool | 是否成功（`status === 'completed'`） |
| `status` | string | `completed` / `failed` |
| `reason` | string? | call 未完成时的终止原因（如有） |
| `response` | string? | Agent 最终回复全文（成功时） |
| `error` | string? | 错误信息（失败时） |
| `errorDetail` | object? | call 的详细错误对象（如有） |
| `agentId` | string | agent 标识 |
| `sessionId` | string | 会话 ID（threadId） |
| `durationMs` | number | 单次调用耗时（毫秒） |
| `timestamp` | string | ISO 时间戳 |

示例：

```
PLAIN_AGENT_RESULT:{"ok":true,"status":"completed","response":"你好！我是 coder...","error":null,"agentId":"coder","sessionId":"plain-1755628800000-ab12cd","durationMs":8123,"timestamp":"2026-08-20T..."}
```

### 4.2 `text`

stdout 输出分隔线 + 响应全文 + 分隔线 + 摘要行：

```
────────────────────────────────────────────────────────────
<响应全文>
────────────────────────────────────────────────────────────
# agent=coder session=plain-... duration=8123ms ok=true
```

### 4.3 `json`

stdout 输出 pretty-print 的全量结果 JSON（字段与 `result` 相同）。

### 4.4 `quiet`

stdout **仅输出响应正文**（可安全接管道）：

```
<仅响应正文，无其他任何内容>
```

> 注意：quiet 模式会把 `process.stdout.write` 整体重定向到 stderr，拦截框架 logger / MCP SDK 等绕过 console 的直写；结果经原始 stdout 输出。

### 4.5 `jsonl`（会话事件 JSONL 流）

stdout 输出 **codex exec `--json` 风格**的会话事件流，**每行一个 JSON**，顺序即生命周期。**不输出** `PLAIN_AGENT_RESULT:` 行，成败由 **exit code** 表达。

```
{"type":"thread.started","threadId":"plain-..."}        // threadId 即 sessionId
{"type":"turn.started","turn":0}
{"type":"item.completed","item":{"type":"reasoning","text":"..."}}
{"type":"item.started","item":{"id":"call_...","type":"tool_call","tool":"read","arguments":{...},"status":"in_progress"}}
{"type":"item.completed","item":{"id":"call_...","type":"tool_call","status":"completed","result":"...(≤1000 字符)"}}
{"type":"item.completed","item":{"type":"agent_message","text":"最终回复全文"}}   // 不截断
{"type":"turn.completed","turn":0,"usage":{"inputTokens":...,"outputTokens":...}}
{"type":"turn.failed",...} / {"type":"error","message":"..."}
```

**事件模型**（对齐 `codex exec --json`）：

- `thread.started` / `turn.started` / `item.started|completed`（item 类型：`agent_message` / `reasoning` / `tool_call`）/ `turn.completed`（含 token 用量）/ `turn.failed` / `error`。
- `tool_call` 靠 `id`（call.id）配对 started / completed。
- 工具 `result` **截断到 1000 字符**；超限时带 `resultTruncated:true, fullLength:N`。事件流是推送渠道不是全量存储——完整结果已随会话落盘，用 `threadId`（sessionId）回查。
- `agent_message` 的 `text`（最终回复）**不截断**。

---

## 5. 退出码（exit code）

| 场景 | exit code |
|------|-----------|
| 调用成功（`status === 'completed'`） | `0` |
| 调用失败 / 出错 / 参数错误 / fatal | `1` |

> 在 `jsonl` 格式下，成功与否完全由 exit code 表达（stdout 事件流已含结果）。

---

## 6. 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PROTOCLAW_HEADLESS=1` | 跳过 viewer 连接（等效 `--headless`） | — |
| `AGENTDEV_VIEWER_PORT` | ViewerWorker 端口 | `2026` |
| `PROTOCLAW_AGENT_CWD` | agent 工作目录 | 当前目录 |
| `PROTOCLAW_MODEL_PRESET_ROLE` | 模型角色（`default` 等） | `default` |
| `PORT` | Claw server Web UI 端口（threads 命令使用） | `1420` |

---

## 7. 数据落盘

Plain agent 会话与索引写入用户目录（不污染仓库）：

```
~/.agentdev/AgentDevClaw/agents/<name>/sessions/
  index.json          # 会话索引（与 server 侧格式对齐）
  <sessionId>.json    # 会话文件
```

--keep-alive 下会话已先落盘，Ctrl+C 优雅退出，之后可用 `--session <id>` 续接。

---

## 8. 现代独立 Agent（用户/Studio 制造）调用

用户或 Agent Studio 制造的独立 Agent（`deployment.kind: "standalone"` + `features[]` 精确版本）需先注册，再运行：

```bash
# 注册（关联 Studio 项目以启用 --debug 源码覆盖）
claw agents register D:/code/my-agent --studio D:/code/my-agent-studio

# release：从 Feature 仓库使用 metadata.features 的精确 tgz 版本
claw run my-agent --goal "..."

# debug：只对带 --studio 注册的 Agent，开发中 Feature 从 Studio 构建产物加载
claw run my-agent --goal "..." --debug
```

`claw run` 会为现代 Agent 在 `~/.agentdev/AgentDevClaw/runtime-envs/<id>/<dependency-hash>/` 准备隔离依赖环境（npm install `file:` tgz + agentdev junction，依赖不变则复用；Agent 源码复制进 `agent-source/`）。

---

## 9. 与 prebuilt agent 的区别速查

| | prebuilt agent | plain agent |
|---|---|---|
| 位置 | `prebuilt-agents/*/*/` | `agents/<name>/` 或用户 Agent registry |
| workspace 列表 | 出现 | 不出现 |
| UI 声明 | metadata.json 的 ui 字段 | 不需要 |
| 启动方式 | server 托管（start_agent / 面板） | CLI 直接 spawn |
| 被监视 | 常驻连接 ViewerWorker | 运行期连接 ViewerWorker（可 `--headless` 跳过） |
| 依赖 server | 是 | 否 |

> Prebuilt 编程小助手另有 `scripts/run-one-shot-agent.js`（server 派生单次调用入口，用于 blocking 子代理），其 stdout 协议行为与 plain agent 类似，但使用 `ONE_SHOT_RESULT:` 协议行，且不面向 CLI 直接使用。

---

## 10. 编程小助手工作空间中的 coder 身份与线程调用

### 10.1 什么是 coder

**coder** 是**编程小助手工作空间**（`prebuilt-agents/official/programming-helper/`）内的一个会话身份：`agentId=programming-helper` + `sessionType=coder` 的会话由独立的 `CoderAgent` 类装配（`coder-agent.js`，runtime 按 `sessionType` 分派），定位为 **24 小时自主编码智能体**：

- 会话在线程内接续（trim / 摘要后自动接力，无人值守）；
- 指令经线程收件箱（inbox）投递；
- 全程 **可通过 `claw threads` 审计**。

| 项 | 值 |
|---|---|
| 位置 | `prebuilt-agents/official/programming-helper/coder-agent.js`（工作空间内身份，非独立工作空间） |
| 会话创建 | `POST /protoclaw/prebuilt_sessions`，`{"agentId":"programming-helper","sessionType":"coder",...}` |
| UI 入口 | Web UI 左侧「coder」独立入口（同一工作空间的投影条目）；coder 会话由调度方创建，用户不能创建 |
| 进程模式 | `shared-by-project`（进程组键含 sessionType，coder 与 main 会话不同组） |
| 会话模型 | `persistent` |
| 依赖 server | **是**（经 Claw server 托管，CLI 需通过 HTTP 访问） |

feature 集：`todo` / `force-continuation` / `tickets-build-flow` / `audit` / `websearch` / `memory` / `shell` / `lsp` / `context-rotation-trigger`（自动接力，替代交互式 context-guard）/ `image-reader` / `github` / `skill`。配置独立：`.agentdev/agent-configs/coder.json`。

> agent 本身**不感知线程**：会话创建/trim/摘要的线程接线由 Claw server 侧（`server/thread-control/thread-integration.js`）在会话生命周期钩子上完成（判定维度是 sessionType，不是 agentId），runtime 只按普通会话运行。
>
> 历史数据：旧 `prebuilt-agents/official/coder/` 工作空间已移除；旧会话留在 `workspaces/coder/`、旧线程留在全局 `threads/` 索引（`agentId=coder` 记录），**均未迁移原地废弃**——`list --agent programming-helper` 天然过滤掉它们。

### 10.2 线程（Thread）模型

**线程**是一个稳定、可寻址的**连续性锚点**：把一组先后接力的 Session 认定为同一项进行中的工作，并把"之后要做什么"送到当前承接的 Session。

核心概念：

| 概念 | 说明 |
|---|---|
| `threadId` | 线程唯一标识（格式 `wt-<uuid>`） |
| `rootSessionId` | 线程的根会话（创建时的初始会话） |
| `headSessionId` | 当前承接会话（正在执行的那一棒） |
| `sessionChain` / `sessionIds` | 接力的会话链（每棒 = 一次 trim/摘要接力） |
| `commands` | 线程收件箱（待投递指令） |
| `status` | 核心技术状态：`open` / `rotating` / `rotation_failed` / `closed` |
| `lifeState` | **合成生命状态**（推导值，非存储字段）：`executing` / `pending-commands` / `idle` / `archived` / `closed`；另有 `failed` 布尔（注意力信号，不占生命位置）。优先级 archived > executing > pending-commands > idle |
| `mode` | `interactive`（交互） / `autonomous`（自主） |

**指令（command）** 状态机：`pending` → `in_flight` → `delivered` / `failed` / `cancelled`。指令类型 `kind`：`user_message` / `system_continuation` / `external`。

**线程关键工程不变量**（见 `thread-controller.js`）：

- **任一时刻线程要么明确指向旧 head，要么明确指向新 head**（head 推进与指令状态在同一次落盘中原子变更）；
- 交接（compact/summary 接力）期间写入 `pendingSuccession` 挡板，新指令保持 pending，不投给即将退役的旧 head；`advanceHead` 推进后统一投给新 head；
- 指令以 `idempotencyKey` 幂等入队（重复提交不产生副作用）；终态指令保留 200 条上限。

### 10.3 `claw threads` 命令族

`claw threads` 是线程的 **CLI 控制面**，通过 HTTP 调用运行中的 Claw server（默认 `http://127.0.0.1:1420`，可用 `PORT` 覆盖）。这些命令对应 `server/thread-control/thread-routes.js` 提供的 `/protoclaw/threads*` 接口。

> 线程由编程小助手工作空间的 coder 会话消费（sessionType 级判定）；其他会话不创建线程。`claw threads` 也是审计线程状态、投递指令、推进 head 的主要 CLI 手段。

#### 列表

```
claw threads list [--agent ID] [--format text|json]
```

- `--agent programming-helper`：只列该工作空间的线程（coder 线程归属 `agentId=programming-helper`）。
- `text` 格式输出：`Threads (N):  <threadId>  [status|lifeState]  agent=...  head=...  "标题"`——`lifeState` 与标题直接可见，便于调度方定位与判活。
- `json` 格式输出完整线程索引 JSON（含 `lifeState` / `failed` / `archived`）。

#### 创建

```
claw threads create --agent ID --session ID [--title T] [--mode interactive|autonomous]
```

- 必填 `--agent`（如 `programming-helper`）与 `--session`（初始会话 ID，成为 root 与初始 head）。
- `--mode` 默认 `interactive`。
- 返回 201 + 完整 thread 记录。

#### 详情

```
claw threads show <thread-id> [--format text|json]
```

- 输出线程详情：`title` / `agent` / `workspace` / `status` / `lifeState` / `failed` / `mode` / `root` / `head` / `sessions`（数量）/ `commands`（数量与 pending 数）/ `revision` / `last event`。监控判据（`lifeState` / `failed`）在 text 格式直接可读，无需解析 JSON。

#### 执行事件

```
claw threads events <thread-id> [--after N] [--format text|json|jsonl]
```

- `--after N`：游标增量拉取（`after` 之后的 events），返回 `events` + 新 `cursor`。
- `jsonl` 格式逐行输出会话事件 JSON（`turn.started` / `turn.completed` / `turn.failed` 等）。
- 事件流形态与 plain agent 的 `--format jsonl` 会话事件**同一套 schema**（codex exec 风格）。

#### 指令追加（派发）

```
claw threads send <thread-id> --text TEXT [--kind K] [--source S] [--idempotency-key K]
```

- `--kind`：`user_message`（默认）/ `system_continuation` / `external`。
- `--source`：指令来源（默认 `ui`，CLI 调用常用 `cli`）。
- `--idempotency-key`：幂等键（重复提交返回 `duplicate:true`，不产生副作用）。
- **已归档线程拒绝新指令**（`thread_archived` 错误）；要继续工作就开新线程。
- 追加后若 head runtime 已就绪会**即时投递**；否则保持 `pending`，等 head 推进 / `deliver` / runtime ready 时补投。

#### 投递重试

```
claw threads deliver <thread-id> [--format text|json]
```

- 显式触发接收箱投递（交接中 / runtime 未就绪时指令保持 pending，可调用本命令重试）。
- 返回 `{ attempted, delivered, reason?, results[] }`。

#### head 推进（会话接力）

```
claw threads advance <thread-id> --to-session ID [--from-session ID] [--expected-revision N] [--end-kind K]
```

- `--to-session ID`：必填，新承接会话（successor）。
- `--from-session ID`：期望的当前 head（防错投）。
- `--expected-revision N`：乐观并发检查（非负整数）。
- `--end-kind K`：旧 head 结束原因（`manual` / `context_rotation` / `restart` 等，默认 `manual`）。
- 推进成功 → status 回 `idle`，`pendingSuccession` 原子清除，暂存指令统一投递给新 head。

#### 交接失败 / 看板恢复 / 关闭

```bash
claw threads handoff-failed <thread-id> [--reason R] [--stage S] [--error E]   # 交接失败 → rotation_failed
claw threads resume <thread-id> [--source S]    # 恢复 failed / waiting_input 看板状态
claw threads close <thread-id> [--reason R]     # 系统硬关闭（终态），pending 指令一并取消
```

`resume` 只恢复 Board 的执行观察状态，不创建 successor、不启动 Runtime、不推进 Thread head。

#### 归档 / 取消归档

```bash
claw threads archive <thread-id> [--format text|json]      # 归档整条 Thread，并清理执行资源
claw threads unarchive <thread-id> [--format text|json]    # 恢复可调度资格，不自动启动 Runtime
```

归档事务会暂停新指令、中断 head、取消 pending commands、尝试停止 `sessionChain` 中全部 Runtime、关闭 Board，并返回 `cleanup.status=complete|partial`。Session 数据和历史消息保留。

取消归档会解除 hold、reopen Board，并返回 `runtimeStarted=false`；下一次发送指令或打开 head 时再按需启动 Runtime。
有些命令必须在 server 可访问时才有输出；错误处理：`thread_not_found → 404`、`revision/head 冲突 → 409`、`thread_archived → 409`、参数问题 → 400。

### 10.4 CLI 调用示例（coder 身份）

```bash
# 列出编程小助手工作空间的全部线程（coder 线程归属该 agentId）
claw threads list --agent programming-helper

# 列出一个线程的详情
claw threads show wt-xxxx-...

# 给线程派发一条新指令（无人值守直接执行）
claw threads send wt-xxxx-... --text "继续排查那个报错并修复" --kind external --source cli

# 幂等派发（重试安全）
claw threads send wt-xxxx-... --text "..." --idempotency-key <key>

# 查看线程执行事件流（jsonl 机器消费）
claw threads events wt-xxxx-... --format jsonl

# 显式触发待投递指令重试
claw threads deliver wt-xxxx-...

# 会话接了新棒后推进 head
claw threads advance wt-xxxx-... --to-session <new-session> --from-session <old-session>

# 交接失败标记 / 恢复 / 关闭
claw threads handoff-failed wt-xxxx-... --reason "compact 失败" --stage advance_head
claw threads resume wt-xxxx-...
claw threads close wt-xxxx-... --reason operator_closed

# 工作收口：归档线程（自动中断并清理整条 Session 链路）
claw threads archive wt-xxxx-...
claw threads unarchive wt-xxxx-...
```

创建 coder 会话（新线程的起点）走 server API：

```http
POST /protoclaw/prebuilt_sessions
Content-Type: application/json

{ "agentId": "programming-helper", "sessionType": "coder", "targetDir": "D:/code/AgentDevClaw" }
```

### 10.5 线程数据落盘

```
~/.agentdev/AgentDevClaw/threads/
  index.json              # 线程索引（threadId/agentId/title/status/headSessionId/updatedAt）
  threads/<threadId>.json # 每条线程一个文件（thread record + inbox commands，原子写）
  boards/                 # 看板状态（执行事件累积）
  archive-index.json      # 归档索引（threadId → archivedAt + archiveCleanup；生命周期数据源）
```
