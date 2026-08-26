# CLAUDE.md

本文件是新进入项目的 agent 的认知地图，用于建立"产品目标 → 核心对象 → 代码入口 → 数据流 → 边界"的连续认知。写作原则：只留概念理解、易错点与索引；细节指向权威文档与代码；不写行数、数量等易漂移的快照数据。

## 先看这里

1. 本文件
2. [docs/agentdev-claw-product-overview.md](docs/agentdev-claw-product-overview.md) — 产品总览
3. [docs/dev-context-index.md](docs/dev-context-index.md) — AgentDev 框架与 Claw 的跨仓库连接关系速查
4. 涉及前端 UI 渲染、workspace 切换、数据加载时序 → 必读 [docs/frontend-rendering-patterns.md](docs/frontend-rendering-patterns.md)
5. 架构决策记录（ADR），改动相关领域前先读对应篇（[docs/adr/](docs/adr/)）：
   - 0001 导出面治理：Runtime 双类型拆分与按引用导出
   - 0002 Session Continuity as Transformation：会话接续的框架化原则
   - 0003 AgentDev 包结构破坏性拆分：无伞包、core 零重依赖
   - 0004 ACP 适配器外置为独立 stdio 进程
   - 0005 工具终止语义：中断即结果
   - 0006 本地显式资源寻址优先
   - 0007 Capability Registry as the Unified Control Plane
   - 0008 远程 Claw 连接架构
   - 0009 模型热切换框架 API：资产归应用层，状态由 agent 自持

实现层真实入口：

- 服务端：[server.js](server.js)（路由按域分文件于 `server/routes/`）
- 前端壳层：[public/index.html](public/index.html)（瘦壳）→ [public/src/app-core.js](public/src/app-core.js) / [app-ui.js](public/src/app-ui.js) / [app-main.js](public/src/app-main.js) + `public/src/modules/`
- 预制 agent runtime 宿主：[scripts/run-prebuilt-agent.js](scripts/run-prebuilt-agent.js)
- 编程小助手：[prebuilt-agents/official/programming-helper/agent.js](prebuilt-agents/official/programming-helper/agent.js)
- IM 门户代理：[prebuilt-agents/official/qqbot/agent.js](prebuilt-agents/official/qqbot/agent.js)
- 群聊管理员工具集：[local-features/group-admin](local-features/group-admin)
- 运行时信封：[server/runtime-call-envelope.js](server/runtime-call-envelope.js)

## 项目定位

`AgentDevClaw` 是以 Agent 为中心的可扩展工作台，整合配置、会话、调度、协作。当前活跃维护的工作空间：

- **编程小助手**（`programming-helper`）★ — 对标 Claude Code 的 AI 编程 Agent，浏览器可视化交互层
- **Agent Studio**（`agent-studio`）★ — 上游制造端：对话中开发 Feature、装配 Agent，经 Test Runtime 验证闭环
- **IM 渠道**（`qqbot`）★ — 多渠道消息门户代理与路由（QQ / 微信 / 企业微信 / 飞书等）
- **工作群**（`work-group`，Beta）— 群聊形式指挥与协调多 Agent

预制 agent 完整清单以 `prebuilt-agents/official/*/metadata.json` 为准。`flow-workspace`、`feature-creator`、`agent-creator`、`dispatch-console`、`flow-test` 等代码保留但已悬置，不再积极迭代；涉及悬置区域时以"读懂现有代码、不引入新复杂度"为原则。

全局 Feature 参数配置已并入前端设置菜单（多作用域三态编辑器），不再是独立工作空间。

## 启动与依赖模式

`npm install` → `npm run build` → `npm start` 三段式。build 与 prestart 都按 package.json 中 `@agentdevjs/*` 依赖声明形态自动分流：

| 形态 | package.json 声明 | node_modules | build 行为 |
|---|---|---|---|
| 开发态 | `file:../AgentDev/packages/<name>` | npm install 物化为 junction，指向相邻框架仓库 | 校验/修复链接 → 构建框架仓库（若相邻存在）→ local-features → features |
| 发布态 | semver（如 `^0.1.0`） | npm registry 正式包，自带 dist | 跳过链接与框架构建，只做 local-features → features |

两个切换脚本语义不对称（易错）：

- `npm run agentdev:published` — 改写依赖声明（`file:` → semver）并 install，是形态切换的正向通道。
- `npm run agentdev:local` — **不改声明**，只把相邻 AgentDev 仓库的包以 junction 链接进 `node_modules/@agentdevjs/`。用于发布态下临时调试本地框架源码；之后的 `npm install` 会把链接冲回 registry 版。

默认端口：Web UI `1420`，ViewerWorker `2026`（`PORT` / `AGENTDEV_VIEWER_PORT` 可覆盖）。

框架改动的生效路径：AgentDev 仓库 `npm run build` 产出全部包 dist → 重启 Claw 服务。junction 链接下重启即生效；发布态下先用 `agentdev:local` 链接调试，正式生效走发版。

## 仓库边界与权威修改位置

两个仓库：

- [D:\code\AgentDevClaw](.) — 产品壳层：Web UI、预制 agent、runtime 托管、ProtoClaw 服务端、feature 运行时解析。
- [D:\code\AgentDev](../AgentDev) — 框架仓库（npm workspace monorepo）：框架本体（core / llm / viewer / mcp）、ViewerWorker、DebugHub、通知系统、生态 feature 包源码。`@agentdevjs/*` 已发布 npm，但权威源码始终在这里。

feature 三类来源（严格区分，改错层 = 白改）：

1. **生态 feature 包**（`qqbot-feature`、`shell-feature`、`weixin-bot` 等 `@agentdevjs/*`）：权威源码在 `AgentDev/packages/<name>`。改实现 → 框架仓库改 + build → 重启 Claw。
2. **Claw 本地 feature**（[local-features](local-features)）：权威修改点在本仓库，`npm run build:local-features` 构建。
3. **发布产物与用户仓库**（[resources/features](resources/features)/*.tgz、`~/.agentdev/AgentDevClaw/user-features/`）：被分发、被装配的对象，不参与本机开发解析。开发流程无 tgz 拷贝环节；发布统一经 `npm run pack:features`。

问题归属判定：

- "agent 怎么组合 feature、选线路、启动 gateway" → Claw 预制 agent（`prebuilt-agents/*/*/agent.js`）
- "feature 本身的行为、协议、网关循环" → feature 源码包
- "通知、DebugHub、ViewerWorker、Agent 生命周期、框架级 call 状态" → AgentDev 框架本体
- 装配关系以各 agent.js 的 import 为准，勿凭本文档或记忆判断；预制 agent 可能对生态包做项目层包装，"Claw 表现出的行为"不一定等于生态包原生行为。

禁止的做法：

- 把框架或生态包修复只留在 Claw 侧 `node_modules/@agentdevjs/*`（会被安装冲掉，不回流源码）
- 混淆三类 feature 来源；开发流程中手工 pack / 拷贝 tgz
- 用 `npm link` 做本地链接（会触发依赖树 prune）；需要的是文件系统 junction，用 `agentdev:local`

历史注：ADR-0003 四包拆分后，框架内 `src/features/*` 生态副本已删除，生态 feature 唯一权威源码在 `AgentDev/packages/<name>/`。若见从 `@agentdevjs/core` 导入生态 feature 符号，属待清理残留。

## 系统总览

**服务端**（[server.js](server.js)）：托管 ViewerWorker、扫描 `prebuilt-agents/`、管理预制 agent runtime 与会话切换、代理前端到 ViewerWorker 的请求、提供 ProtoClaw API。路由按域分文件于 `server/routes/*.js`（会话与上下文连续性、IM 线路与渠道、调度、群聊、模型配置、capability、feature 配置、workspace 管理、ACP、git、feature 仓库等大类），具体接口以各路由文件的 `app.<method>` 注册为准。

**前端壳层**：`public/index.html` 只是瘦壳。主逻辑在 `app-core.js`（常量 / i18n / 公共底座）、`app-ui.js`（workspace surface 渲染骨架与 block 分发）、`app-main.js`（agent 切换与轮询主循环），功能域在 `modules/` 下分模块。`renderCurrentMainView()` 是主视图状态机入口，多数 workspace 问题最终回到这里。

**预制 agent runtime**（[scripts/run-prebuilt-agent.js](scripts/run-prebuilt-agent.js)）：动态加载 `prebuilt-agents/*/*/agent.js`、挂到本地 ViewerWorker、管理会话恢复与附加启动逻辑（如 IM gateway）。会话数据落在用户目录 `~/.agentdev/AgentDevClaw/prebuilt-sessions/<agentId>`，不污染仓库。`metadata.json` 的 `ui` 声明（entry / tabs / home blocks）是首页 block 渲染的基础壳能力。

**本地 feature**（[local-features](local-features)）：顶层 `index.ts` barrel 聚合导出。活跃域：dispatch（调度）、group-admin（群聊管理）、checkpoint、context-compaction-mirror / context-guard（上下文精简与守卫）、continuity-participant（连续性参与方）、conversation-export（对话导出）、feature-wrappers（框架 feature 的 Claw 协议薄包装）、agent-studio、generative-ui、github、agent-dev。`flow` 与 `feature-dev` 已悬置。

app-core.js 全局状态纪律：全局状态区只减不增。新增前端状态放所属 modules 文件的局部作用域；确需跨模块共享用 `window.ClawFW` 命名空间。

## 当前工作空间

### 编程小助手（programming-helper）★

入口 `prebuilt-agents/official/programming-helper/`。一个工作空间、两个会话身份，runtime 按 `sessionType` 分派：

- **main（缺省）**：用户交互式编程 Agent。Shell / LSP / Web 搜索 / MCP 完整工具链，会话分支、trim / compact / summary 精简、checkpoint / rollback、AI 标题、语音输入。
- **coder（`sessionType=coder`）**：无人值守自主编码身份，装配 [coder-agent.js](prebuilt-agents/official/programming-helper/coder-agent.js)，配置独立于主身份（`.agentdev/agent-configs/coder.json`）。关键行为：线程宿主（自动建 WorkThread，trim / 摘要后自动接力）；只能由调度面创建（ACP / `claw threads` / workspace-coder-dispatch 技能），用户不能在 UI 创建；Web UI 左侧 coder 入口是同一工作空间的线程列表投影；线程归档是生命周期事务（先中断再归档，已归档拒绝新指令）。

### Agent Studio（agent-studio）★

dev agent 只做控制面（`studio_*` 工具集），被测 Feature 跑在隔离的 Test Runtime 子进程（[scripts/run-studio-runtime.js](scripts/run-studio-runtime.js)），以 `studio-sandbox:<项目名>` 出现在左侧 Agent 列表（可看不可输入）。两种模式：`feature-harness`（最小 Agent + 开发中 Feature）与 `agent-debug`（真实 Agent + 仓库 tgz 底座 + 开发源码覆盖）。Feature 状态机由运行证据推进（`implemented → mounted → verified → snapshotted`）；验证通过经快照打成不可变 tgz 写入用户 Feature 仓库（同版本不同字节会被拒绝）。

dev agent 注入技能：`agent-studio-workflow`（权威工作流）+ `agentdev-feature-guide` / `agentdev-feature-packaging`（权威源在框架仓库，经 `npm run adv-docs:sync` 同步，勿直接改 Claw 副本）+ `agentdev-agent-assembly`（本地维护）。

同步规则（易错）：新增 / 改名 `studio_*` 工具、调整状态机或会话策略时，必须同步更新 `local-features/agent-studio/skills/agent-studio-workflow/SKILL.md` 与 `prebuilt-agents/official/agent-studio/.agentdev/prompts/system.md`（两处都注入给 dev agent）。

### IM 渠道（qqbot）★

多渠道消息接入与路由（渠道包以 agent.js imports 为准）。`IMOperatorFeature` 提供接线员工具（`im_overview` / `im_browse` / `im_connect_line` / `im_disconnect_line`）；线路到工作空间会话的动态路由与转接；`CallArbiter` 统一并发调用仲裁；开机自启动与渠道配置面板。

配置文件：`.agentdev/qqbot.config.json`、`.agentdev/weixin-bot.config.json`、`.agentdev/im-workspace.config.json`。

### 工作群（work-group）★ Beta

多 Agent 协作群聊：群聊创建、Agent 身份分配、`@mention` 派发任务、管理员协调与上下文重建。工具集在 [local-features/group-admin](local-features/group-admin)。

## Plain Agent 与 claw CLI

与 workspace / prebuilt agent 平行的第三种 agent 形态：不建工作空间、不依赖 Claw server，经全局命令 `claw` 直接调用。两种用途：轻量可组合装配（`agents/<name>/agent.js`）；无头审计载体（`--headless --format jsonl`，stdout 只承载结果数据，过程信息走 stderr）。

- 入口链路：[bin/claw.mjs](bin/claw.mjs) → [scripts/run-plain-agent.js](scripts/run-plain-agent.js)
- 内建 plain coder 已移除（与工作空间 coder 重复），`agents/` 以注册制为主（`claw agents register`）
- 完整用法（输出格式、jsonl 事件 schema、会话续接、落盘位置）见 [agents/README.md](agents/README.md)——修改 CLI 行为时必须同步更新该文档

## ACP 适配层

独立 stdio 进程（`claw acp coder`），只做协议转换与本机 HTTP 调用，执行权威留在 Claw server。设计见 [docs/coder-acp-adapter-design.md](docs/coder-acp-adapter-design.md) 与 ADR-0004。适配器改动只需新起子进程；server 路由改动需要重启整个 Claw 服务。

## Agent 制造 → 消费链路（agent-studio → claw CLI）

上游 agent-studio 制造 Feature 与 Agent，下游 `claw` CLI / plain agent runner 消费。"Studio 验证过的装配 = 消费端运行的装配"由共享解析链保证，`claw run`（release / debug）、Studio agent-debug 模式、server 侧共用：

`server/feature-runtime/`：`schemas.js`（校验，release 与注册时强制精确版本）→ `catalog.js`（扫描官方 `resources/features/` 与用户 `user-features/` 两个 tgz 仓库，同版本用户优先）→ `resolver.js`（release 全解析为 tgz；debug 允许 Studio 同名包源码覆盖）→ `provisioner.js`（内容寻址环境，依赖不变复用）→ `loader.js`（拓扑排序 mountFeature，重名 / 环 / 缺依赖直接报错）。

Studio 项目落盘布局与运行记录：项目目录 `agent-studio.json` + `.agent-studio/`（runs / runtime-sessions / runtime-plan），工作空间状态在 `~/.agentdev/AgentDevClaw/workspaces/agent-studio/`。

## 关键数据流

**编程小助手会话生命周期**：用户选项目目录新建对话 → 服务端创建 session 绑定 `cwd` → Agent 经工具执行需求 → 用户可分支 / 精简 / checkpoint 管理。

**IM 消息路由**：IM 平台消息 → qqbot 门户代理 → 接线员按通道配置路由到工作空间会话 → 目标 Agent 处理 → 回复经接线员传回 IM 平台。

**会话管理**：分支 = 从指定消息节点创建新会话；精简 = 裁剪早期历史（Trim）或压缩为摘要（Compact）；checkpoint / rollback = 保存与恢复会话状态。

## 会话连续性三层模型

Claw 不自带连续性引擎，全部消费 `@agentdevjs/core`。权威设计与决策记录：[ADR-0002](docs/adr/0002-session-continuity-as-transformation.md)。

三层概念：

- **Session**：会话快照与 SuccessorSeed（变换产物），落盘为 handoff 包
- **Transformation**：官方变换（Trim / Summary / 组合），LLM 经 `TransformContext.llm` 进程内注入
- **WorkThread**：线程状态机与看板，替代 Claw 原线程控制

Claw 装配点索引：trim 引擎与落盘在 `server/context-continuity/`（handoff-package / trim-appended-summary / inprocess-summary，`resolveSummaryLLM` 供各装配层共用）；seed feature 由 `scripts/run-prebuilt-agent.js` 与 `run-one-shot-agent.js` 装配；连续性字段经 [local-features/continuity-participant](local-features/continuity-participant)（读旧写新，协议保留 `claw.*` 命名空间）；线程控制在 `server/thread-control/` 模块族，数据目录全局 `~/.agentdev/AgentDevClaw/threads/`；线程宿主判定为会话级（programming-helper + `sessionType=coder`）。

易错：

- trim + summary 组合语义以框架 `TrimTranscriptWithSummaryTransformation` 为唯一权威（thread 接力与手动精简共用），不要在 Claw 侧另写组合逻辑
- 旧 thread record 的 `executionEvents` / `mode` 字段为惰性数据，看板事件从 `boards/` 重新累积

## 统一日志契约

两套日志系统的边界（改动日志相关代码前必读）：

- **agent 运行时内部**（feature / agent.js 装配层）→ `createLogger()` → DebugHub → Web UI。ESLint `no-console: error`（存量文件在 ratchet 清单降 warn）。绕过 logger 直接 console.log 会丢等级与命名空间。
- **非 agent 运行**（server.js 进程、scripts/、bin/）→ console / stdio，推荐 [server/shared/claw-logger.js](server/shared/claw-logger.js)
- **前端 public/** → 浏览器 console，不在约束范围

stdio 分流（CLI 审计接口）：所有日志必须带等级；`AGENTDEV_LOG_STREAM=auto` 时 trace / debug / info → stdout、warn / error → stderr；无头模式全量 → stderr，stdout 只承载结果协议行（`ONE_SHOT_RESULT:` 等）。

会话事件流：无头 stdout 的数据形态是 codex exec 风格 JSONL 事件（`thread.started` / `turn.*` / `item.*`），与运行日志严格分离。框架实现 `AgentDev/src/core/session-events.ts`，Claw 渲染 [scripts/headless-session-renderer.js](scripts/headless-session-renderer.js)。

易错：无头入口必须以 `import './headless-log-preamble.js'` 作为**第一个 import**（静态 import 会提升，模块体内再设 env 已太晚；preamble 严禁依赖框架包——core 依赖图含 top-level await）。无 ViewerWorker 连接时框架日志自动 fallback stdio，审计不丢失。

框架日志实现在 `AgentDev/src/core/logging.ts`，改动后需框架仓库 build 并重启整个 Claw 服务。ESLint 边界与 ratchet 清单在 [eslint.config.js](eslint.config.js) 末尾。

## 前端两套渲染管线（易错）

- **端口 1420：Claw 主前端**（用户日常看到）— `public/src/*`，静态文件不需编译，改后重启 Claw 服务生效
- **端口 2026：DebugHub Viewer**（框架侧）— `AgentDev/src/core/viewer-html.ts` + `viewer-worker.ts`，改后需框架 build + 重启

改错管线 = 白改。渲染契约、去重策略与自检清单见 [docs/frontend-rendering-patterns.md](docs/frontend-rendering-patterns.md)。

Inspector 数据流：Agent `buildHookInspectorSnapshot()` → IPC → ViewerWorker → API → Claw 前端 `normalizeHookInspector()`（[modules/overview-data.js](public/src/modules/overview-data.js)）→ `renderFeaturesPanel()`。陷阱：`normalizeHookInspector` 存在于两处（Claw 前端 + 框架 `viewer-html.ts`），新增 inspector snapshot 字段必须同时更新两处，否则字段在重构时被丢弃（历史上踩过）。

## 会话切换与异步渲染不变量

详见 [docs/frontend-rendering-patterns.md](docs/frontend-rendering-patterns.md)。三条最易踩：

1. `getRuntimeContextKey` 不稳定（依赖异步更新的 `allAgents`），只能作 cache key，不能作 stale check；stale check 只用同步设置的 `currentRuntimeAgentId`
2. 切换不依赖服务端 current 状态：`switchAgent` 先乐观渲染再 `loadAgentData`，所有 URL 用显式 `agentId`；焦点只持久化到 `localStorage`
3. 前端 → agent 控制 IPC 优先用 `runtimeId` 定位；`allAgents` 缓存派生的 sessionId 会暂态错位，只能 fallback，且 server 禁止跨 session fallback 投递；前端必须检查 `payload.ok` 并回滚乐观态（参考 `todo_control`、`swap_model`）

## 工具注册时序与同名覆盖

Agent 生命周期：构造函数 `this.use(feature)` 只存 Map；首次 `onCall` 时 `ensureFeatureTools()` 注册工具并推送初始 inspector，随后 `onInitiate()`。

同名工具后注册覆盖前值（superseded）。要在全部 feature 工具之后注册统一覆盖工具，正确位置是 `onFeatureToolsReady()` 虚方法（feature 循环后、初始 inspector 推送前）——放构造函数会被 feature 工具覆盖，放 `onInitiate` 则初始 inspector 不含。

inspector 中工具按注册 source 分类：source 属于某 feature name → 该 feature 的 tools；否则归 `standaloneTools`。

## Capability 控制面与 slash 命令

权威设计与裁决：[ADR-0007](docs/adr/0007-capability-registry-as-control-plane.md)。核心模型：

- feature 经 `getCapabilities()` 声明能力；框架 `CapabilityRegistry` 是进程内哑注册表（无依赖图、无状态共享）
- slash 菜单是人机入口；命令两类：`kind: invoke`（表单 + 执行）与 `kind: prompt`（挂 pill，随消息以结构化 `capabilityActivations` 流动，经队列 / 线程交接到达任意后继会话）
- 投递三元组 agentId / runtimeId / sessionId 寻址，runtimeId 优先；注册表是进程内语义，跨进程投递归宿主层（[scripts/capability-ipc.js](scripts/capability-ipc.js)）

负面清单（永不提供）：bind / reactive / watch-state；共享权威状态与跨 feature 事务上移宿主或重构。`entryPoints` 是契约约束兼访问控制，不是安全边界。

前端 slash 系统（[modules/slash-menu.js](public/src/modules/slash-menu.js)）与输入框解耦：document 级 capture 监听，双输入框经 `.user-input-textarea` 统一触发；删掉该模块系统照常工作。invoke 生命周期日志由框架兜底（namespace `capability`），不依赖 feature 自觉。

## 进程架构与重启范围

server.js 主进程（Express 1420 + ViewerWorker 2026 + DebugHub）+ per-runtime agent 子进程（spawn `run-prebuilt-agent.js`，动态 import agent.js）。

重启范围（易错）：

- 改 `prebuilt-agents/*/agent.js` 或 `local-features/dist/*` → 重启对应 agent 即可生效
- 改框架 dist（`AgentDev/dist/*`）或 Claw 前端 JS / CSS → **必须重启整个 Claw 服务**（server.js 才会重新 import / 重新 serve）

## 测试体系

命令：`npm test`（core + features）/ `npm run test:core` / `npm run test:file -- test/<file>.test.js` / `npm run test:features` / `npm run test:coverage`。

统一格式：Node 内置 `node:test` + `node:assert/strict`。不要引入 Vitest / Jest / `expect` / `vi` 写法——那是 AgentDev 框架仓库的独立体系。

- 服务端纯逻辑 → 新建 `test/<name>.test.js`
- local-feature 功能 → `local-features/<name>/test/<name>.test.ts`，并加入 [local-features/tsconfig.json](local-features/tsconfig.json) 的 include；`test:features` 自动发现（pretest 钩子自动构建）
- 测试代码中 inline 复刻的 server 逻辑，需在 server 对应逻辑变更时同步更新
- 前端 JS 目前仅 frontend-vm.js 沙箱测试覆盖纯函数

时长预算（超预算当 bug 排查，不要调大预算）：单用例 < 100ms（真实 IO / 子进程放宽到 2s）、单文件墙钟 < 1.5s（硬上限 10s）、全量 `test:core` ~15s（上限 30s）。已知合理慢文件（生产语义决定，不要"修复"）：`oauth-codex`（设备码 interval 下限 + 网络退避）、`feature-runtime`（真实子进程生命周期）、`session-summary`（扫描真实 context-handoffs 目录，已知待办：注入隔离）。

写测试规则：模拟等待用最小 interval 或 `mock.timers`，禁止真实 sleep > 500ms；`Promise.race` 竞速的 fallback 定时器，胜出分支必须 `clearTimeout`；`after()` / `finally` 杀掉 spawn 的子进程、restore 全局补丁；不读真实用户数据目录。慢测试排查路径：逐文件计时定位 → `getActiveResourcesInfo()` 残留句柄探针（`Timeout` = 未清理定时器、`PipeWrap`×2 = 未退出子进程）→ 定时器创建堆栈补丁。

## 开发时的建议心智

进入实际开发前，先回答这些问题：

1. 这次改的是壳层（前端 JS）、预制 agent 装配（agent.js），还是 feature 实现？
2. 当前数据的真相在前端草稿、服务端 workspace state，还是 session index？
3. 当前行为是预制 agent 首页行为，还是运行时行为？
4. **用户看到的是哪个前端管线？** 面板显示 / inspector 渲染问题，先确认是 Claw 前端（`app-ui.js`，端口 1420）还是 DebugHub 查看器（`viewer-html.ts`，端口 2026）渲染的。改错管线 = 白改。
5. **stale check 依赖的全局变量在 `await` 期间会变吗？** `allAgents`、`focusedAgentId` 等会被 poll / `loadAgents()` 异步修改。stale check 只能用同步设置的 `currentRuntimeAgentId`。
6. 这次改动归属哪一层：框架本体 / 生态包 / Claw 本地 feature / 预制 agent 装配？（权威修改位置见"仓库边界"一节）
