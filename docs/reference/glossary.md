# Glossary — 领域词汇表

本表收敛全仓库最容易混淆的**工程开发术语**，每词带 **Avoid** 负面清单（最容易犯的错）。目标是让任何新进入的 agent / 开发者在改代码前用对词、找对层。详细装配点与索引见 [AGENT.md](../../AGENT.md)；本文只管"这个词是什么、不是什么"。

与根 [CONTEXT.md](../../CONTEXT.md) 的分工：CONTEXT.md 收**运行时协议术语**（工具终止、资源寻址、远程连接等，协议语义的权威定义）；本表收**工程开发术语**（仓库结构、开发形态、渲染管线）。同一概念两侧出现时，协议语义以 CONTEXT.md 为准，本表只补工程侧易错。

## 身份与寻址

协议语义（逻辑 Agent / 工作会话 / 运行时实例的完整定义）见 [CONTEXT.md](../../CONTEXT.md)；本节只记工程入口与易错。

- **agentId** — 逻辑 Agent 的标识。工程入口：配置、会话存储、侧栏身份按它组织。
  _Avoid_: 用 agentId 定位"正在运行的那个实例"——运行实例用 runtimeId。
- **runtimeId** — 运行时实例的标识。工程入口：前端 → agent 控制 IPC 的首选定位键。
  _Avoid_: 持久化 runtimeId 或当稳定缓存 key 用。
- **sessionId** — 工作会话的标识。前端从 `allAgents` 缓存派生的 sessionId 会暂态错位，只能 fallback；server 禁止跨 session fallback 投递。
- **投递三元组** — agentId / runtimeId / sessionId，capability 跨进程投递的寻址组合，runtimeId 优先。
- **sessionType** — 会话类型标签（`main` 缺省 / `exploration` 探索 / `archived`），qqbot 渠道等按需使用。会话身份不再由它分派：coder 已升格独立 APP（ADR-0025），会话归属是 agentId 结构事实。
  _Avoid_: 用 sessionType 推导身份归属或合成侧栏条目——身份投影机制已退役。

## 编程小助手的工作归属

- **目录与项目** — 目录选择工作位置，项目选择长期组织的对话与配置归属；项目按绑定目录显示，但改绑不改变其身份。定义见 [CONTEXT.md](../../CONTEXT.md)。
  _Avoid_: 用目录路径当项目 ID，或把同目录默认集合当成项目配置父层。
- **默认（目录对话）** — 无项目归属的正式对话集合，不是临时会话或待迁移数据。
- **移动对话** — 同目录内显式转移空闲会话的归属，后续按目标配置重建运行实例；浏览选择器只切视图，不移动会话。
  _Avoid_: 仅改列表分组却保留旧实例配置，或把转移理解为复制消息、移动工作文件。

## Agent 形态

- **prebuilt agent** — 预制 agent（`prebuilt-agents/*/*/agent.js`），由 Claw server 托管为子进程，有工作空间。
- **plain agent** — `claw` CLI 直调的轻量装配，无工作空间、不依赖 Claw server，`agents/` 注册制。
  _Avoid_: 说"Claw 里的 agent"时不区分这两种形态——归属判定完全不同。
- **studio runtime**（`studio-sandbox:<目录名>`）— agent-studio 的 Test Runtime 子进程，跑被测 Feature，出现在左侧 Agent 列表但可看不可输入。
  _Avoid_: 说「Studio 项目」——没有这个概念；feature 是一级实体，目录只是运行环境（ADR-0022）。
- **child runtime** — 被托管的运行实例，侧栏叶子的唯一来源。
  _Avoid_: 把 prebuilt 历史会话索引当侧栏叶子。

## 治理面（Agent OS）

- **同意模型（consent）** — 治理面的价值定位：用户确认与有序扩展；配额 = 一次性策略同意，权限提示 = 逐次行动同意。
  _Avoid_: 把权限系统当遏制手段设计——满 bash 权限下对 agent 的绝对技术防御不存在（ADR-0027）。
- **三面（宿主面 / 用户面 / 应用面）** — 调用 server API 的三类主体：宿主面（server 内部路由，恒可信）、用户面（CLI / ACP / UI，代表用户本人）、应用面（runtime 内 feature 的 HTTP 调用，唯一需要管束的面）。
- **runtime 配额（resourcePolicy）** — per-workspace（agentId 键）的存活 runtime 数上限，强制点在 startManagedAgent 内核漏斗；缺省不限；存量豁免、rotation 豁免（经意图标记）。
  _Avoid_: 在 feature 层做强制（CLI / ACP 绕过）；只在 session create 路由拦（恢复 / 接续 / activate 击穿）。
- **OS 词汇对照** — 程序 = agent 装配（agent.js + features + metadata.json）；进程 = runtime 子进程；syscall 边界 = server HTTP/IPC API；内核 = Claw server。
  _Avoid_: 引入"子代理"新分类做治理单位——治理单位是 workspace（agentId），与 ADR-0025 身份收敛方向一致。
- **用户通知（app-notification）** — 面向用户的桌面 toast，经 server 统一出口（权限闸 → SSE `app-notification` 帧 → 前端呈现器）；权限项族 `notifications.finish / reminder / input`，三层判定链：用户覆盖 > metadata `permissionDefaults` > false（ADR-0030）。
  _Avoid_: 与框架 `core/notification.ts`（DebugHub 的 call 状态 UI 信号，SSE `notification` 快照帧）混淆——两者语义不同；前端在 runtime 状态感知路径上直接弹通知（触发判定已上移 server）。
- **editingSurface（设置承接）** — APP 设置面按 metadata 权限声明渲染编辑控件的通用机制；宿主可集中承接所管理子工作空间的项；全局工作空间面板只读审计。
  _Avoid_: 在全局 Claw 设置里编辑 APP 通知项——"编辑位置迁就业务语义，知情权不迁就"（ADR-0027/0030）。

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
