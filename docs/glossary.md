# Glossary — 领域词汇表

本表收敛全仓库最容易混淆的**工程开发术语**，每词带 **Avoid** 负面清单（最容易犯的错）。目标是让任何新进入的 agent / 开发者在改代码前用对词、找对层。详细装配点与索引见 [AGENT.md](../AGENT.md)；本文只管"这个词是什么、不是什么"。

与根 [CONTEXT.md](../CONTEXT.md) 的分工：CONTEXT.md 收**运行时协议术语**（工具终止、资源寻址、远程连接等，协议语义的权威定义）；本表收**工程开发术语**（仓库结构、开发形态、渲染管线）。同一概念两侧出现时，协议语义以 CONTEXT.md 为准，本表只补工程侧易错。

## 身份与寻址

协议语义（逻辑 Agent / 工作会话 / 运行时实例的完整定义）见 [CONTEXT.md](../CONTEXT.md)；本节只记工程入口与易错。

- **agentId** — 逻辑 Agent 的标识。工程入口：配置、会话存储、侧栏身份按它组织。
  _Avoid_: 用 agentId 定位"正在运行的那个实例"——运行实例用 runtimeId。
- **runtimeId** — 运行时实例的标识。工程入口：前端 → agent 控制 IPC 的首选定位键。
  _Avoid_: 持久化 runtimeId 或当稳定缓存 key 用。
- **sessionId** — 工作会话的标识。前端从 `allAgents` 缓存派生的 sessionId 会暂态错位，只能 fallback；server 禁止跨 session fallback 投递。
- **投递三元组** — agentId / runtimeId / sessionId，capability 跨进程投递的寻址组合，runtimeId 优先。
- **sessionType** — 同一工作空间内分派会话身份的键（programming-helper：`main` / `coder`）。身份归属：main → 宿主；其余 → `parent_id:sessionType`。
  _Avoid_: 用 Agent 类型硬编码推导身份归属。

## Agent 形态

- **prebuilt agent** — 预制 agent（`prebuilt-agents/*/*/agent.js`），由 Claw server 托管为子进程，有工作空间。
- **plain agent** — `claw` CLI 直调的轻量装配，无工作空间、不依赖 Claw server，`agents/` 注册制。
  _Avoid_: 说"Claw 里的 agent"时不区分这两种形态——归属判定完全不同。
- **studio runtime**（`studio-sandbox:<项目名>`）— agent-studio 的 Test Runtime 子进程，跑被测 Feature，出现在左侧 Agent 列表但可看不可输入。
- **child runtime** — 被托管的运行实例，侧栏叶子的唯一来源。
  _Avoid_: 把 prebuilt 历史会话索引当侧栏叶子。

## 会话连续性（消费 @agentdevjs/core）

- **Session（快照）** — 会话快照 + SuccessorSeed（变换产物），落盘为 handoff 包。
- **Transformation** — 官方变换：Trim / Summary / 组合。LLM 经 `TransformContext.llm` 进程内注入。
  _Avoid_: 在 Claw 侧自写 trim + summary 组合逻辑——唯一权威是框架 `TrimTranscriptWithSummaryTransformation`。
- **WorkThread** — 线程状态机与看板，数据目录 `~/.agentdev/AgentDevClaw/threads/`。
  _Avoid_: 把旧 thread record 的 `executionEvents` / `mode` 当看板事实（惰性数据，事件从 `boards/` 重新累积）。
- **Trim / Summary / Compact** — 精简三语义：Trim = 裁剪早期历史；Summary = 压缩为摘要；Compact 在口语上泛指精简操作。

## Feature 生态（三类来源，改错层 = 白改）

- **生态 feature 包** — `@agentdevjs/*` 发布包，权威源码在 `AgentDev/packages/<name>`。
- **Claw 本地 feature** — `local-features/`，权威修改点在本仓库。
- **发布产物 / 用户仓库** — `resources/features/*.tgz` 与 `~/.agentdev/AgentDevClaw/user-features/`，被分发被装配的对象，不参与本机开发解析。
  _Avoid_: 把框架修复只留在 Claw 侧 `node_modules`（会被安装冲掉，不回流源码）；开发流程手工 pack / 拷贝 tgz。
- **Capability** — feature 经 `getCapabilities()` 声明；两类命令：`invoke`（表单 + 执行）与 `prompt`（挂 pill，随消息以 `capabilityActivations` 流动）。
  _Avoid_: 期待 CapabilityRegistry 共享状态或提供 bind / reactive / watch-state——负面清单，永不提供。

## 渲染与前端状态

- **Claw 主前端（端口 1420）** — `public/src/*`，用户日常看到的界面。
- **DebugHub Viewer（端口 2026）** — `AgentDev/src/core/viewer-html.ts` + `viewer-worker.ts`，框架侧。
  _Avoid_: 改错管线 = 白改。面板显示问题先问"用户看到的是哪个管线渲染的"。
- **normalizeHookInspector** — 同名实现存在两处（Claw 前端 + 框架 `viewer-html.ts`），新增 inspector snapshot 字段必须两边同步，否则字段在重构时被丢弃。
- **stale check** — 异步渲染的过期判定，只能用同步设置的 `currentRuntimeAgentId`。
  _Avoid_: 用 `getRuntimeContextKey` / `allAgents` 派生 key 做 stale check——它们在 `await` 期间会被 poll 异步修改。
- **renderCurrentMainView()** — 主视图状态机入口，多数 workspace 问题最终回到这里。
- **projectKey vs projectName** — projectKey 是侧栏组身份与折叠状态的键；projectName 只是呈现文本（远程为 `主机名：目录名`）。
  _Avoid_: 用 projectName 参与身份比较。

## 日志与可观测

- **createLogger()** — agent 运行时内部（feature / agent.js 装配层）→ DebugHub → Web UI。
  _Avoid_: 装配层直接 console.log——ESLint `no-console: error`，且丢等级与命名空间。
- **claw-logger / console** — 非 agent 运行（server.js 进程、scripts/、bin/）的日志通道。
- **stdio 分流** — CLI 审计接口：`AGENTDEV_LOG_STREAM=auto` 时按等级分 stdout/stderr；无头模式 stdout 只承载结果协议行（`ONE_SHOT_RESULT:` 等）。
- **JSONL 会话事件流** — 无头 stdout 的数据形态（`thread.started` / `turn.*` / `item.*`），与运行日志严格分离。

## 开发形态

- **开发态 / 发布态** — package.json 中 `@agentdevjs/*` 声明形态：`file:`（junction 指向相邻框架仓库）vs semver（registry 实体）。安装形态与声明形态必须一致，`check-agentdev-local` 强制校验。
- **agentdev:local / agentdev:published** — 切换脚本，语义不对称：local 只链接不改声明（临时调试框架源码）；published 改声明 + 摘链 + install + build（版本对齐）。
  _Avoid_: 用 `npm link` 做本地链接（触发依赖树 prune）；手动改 features/ 子包声明来切换形态。
- **悬置区** — `flow-workspace`、`feature-creator`、`agent-creator`、`dispatch-console` 等代码保留但不再迭代的区域。原则：读懂现有代码、不引入新复杂度。
