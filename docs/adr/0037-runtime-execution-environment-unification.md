# 0037 — Runtime 执行环境统一：平台-runtime 分离与传输网络原生化

- **Status**: Proposed（六项执行前调查已完成、结论在篇内；M1 TCP 传输、M2 HTTP 面地址化、M3 平台注册协议与停止通道、M4 执行后端 seam、M5 镜像与构建、M6 容器后端与端到端验收已实施——四场景 8/8 隔离实例验收通过，容器阶段实施收口，见「实施进展」；M6 后续开放点治理已实施：feature-comms 经 viewer host-request 通道化、会话索引委托快照读（跨边界读写统一走显式协议）；容器阶段方向决策（仅 runtime 容器化、实验形态、含托管 spawn 点、四场景端到端验收、本机 Docker Desktop）与实施计划见 [docs/plans/2026-10-31-runtime-container-phase.md](../plans/2026-10-31-runtime-container-phase.md)；断网 / 桌面树实测待补，多会话同容器与产品化配置面为开放点；远程阶段待容器定型后另立决策）
- **Date**: 2026-10-30
- **来源**: 2026-10-30 容器化方向 grill 会话 + 同日代码级执行前调查（认证 / 传输 / HTTP 盘点 / 数据面 / 生命周期 / 镜像）

## Context

容器化调研（Claw 仓库 runtime 启动、通信、数据链路核查）确认：把 Agent runtime 放进容器在进程边界上可行，平台（server / 前端 / 会话索引 / 调度）可以不动，但现有 runtime↔平台链路存在三处隐式「同机假设」：

1. **控制通道**：runtime 经 `AGENTDEV_UDS_PATH` 连 ViewerWorker 的 UDS/命名管道（框架 `debug-hub.ts` / `viewer-worker.ts`）。线上协议为换行分隔 JSON——协议本身与 UDS 无绑定，但承载管道跨不了容器/主机边界。
2. **业务 HTTP 面**：runtime 调 ViewerWorker HTTP 端口取排队输入等，地址按本机硬拼：宿主侧 `scripts/runtime-passive-mailbox.js`、框架侧 `agent/react-loop.ts`（读 `AGENTDEV_VIEWER_PORT` 默认 2026，拼 `127.0.0.1`）。
3. **生命周期 IPC**：宿主与 runtime 之间用 Node 子进程 IPC（`process.send`）完成 runtime-identity 握手与就绪/退出通知（ADR-0010 修订一）；容器与远程下不存在父子进程关系。

对现状有利的一面：**ViewerWorker 是 Claw server 进程内组件**（server.js `new ViewerWorker(VIEWER_PORT, false, resolveInstanceUdsPath())`），不占独立进程；runtime 侧全部为出站连接（UDS 连接、HTTP dequeue、protoclaw 上报），平台侧持有全部监听——「平台是唯一监听方」在现状里已经成立一半，缺的只是把承载管道换成跨边界可达的形式并补认证。

**动机**：驱动力不是产品功能需求，而是验证架构成熟度——本地进程、容器、远程节点三种执行环境下体验一致，且一致来自链路统一，而非逐点适配的暴力兼容。历史教训：ADR-0008 的平台-平台远程模型中，protoclaw 写端点需按 ADR-0011 套路逐路由接入远程分支（Phase 3 列 16 个端点逐个改造），一致性靠纪律而非架构，该链路已停止维护。

**工程核实（2026-10-30，AgentDev 仓库源码）**：

- DebugHub 全部 1208 行中传输专用代码约 53 行（`connectToWorker` 分帧与连接管理 + `sendViaUDS` 三行）；其余为传输无关的消息/状态层（注册对账、输入租约、增量推送计划、重连后全量重推）。
- Node `net` 模块中 UDS 与 TCP 同为 Socket API（`connect(path)` vs `connect(port, host)`），JSON-lines 分帧、客户端注册表、重连退避两边复用；ViewerWorker 侧 `createNetServer` 换 `listen` 参数即 TCP 监听，消息分发器与业务 handler 不动。
- AgentDev 框架还保留 `claw` 模式（`debug-transport.ts` / `ClawDebugClient`），经 HTTP 对接独立 Claw Runtime；AgentDev README、Claw smoke 脚本与调试文档仍记录该模式。Claw 产品的两个 runtime 启动入口都显式注入 `AGENTDEV_DEBUG_TRANSPORT=viewer-worker`，因此 Claw 托管 Agent 实际使用 UDS 一条链路；`claw` 是框架面向另一种宿主拓扑的适配，不是 Claw 产品里的第二条并行链路。其支持与否不作为本 ADR 的前提，框架传输改造需保持该适配现有契约或另行明确退役。

## Decision

### 1. 目标形态：平台-runtime 分离（三态一致）

Claw 平台是唯一权威与监听方；Agent runtime 是可部署的执行单元，执行环境（本地进程 / 容器 / 远程节点）经配置选择；**runtime 永远是出站连接方**，平台不主动连接 runtime。前端与业务路由只认平台内的 runtime 身份，不感知执行环境；环境差异收敛在宿主执行层一处消化。

容器与远程是同一架构的两次部署距离测试：先容器（验证边界切割：通信、数据、生命周期），后远程（验证网络与凭证边界）。ADR-0008 的「远程 = 完整 Claw 实例」模型在此形态下实质退役：现有 remote-connections / proxy / 命名空间改写代码**冻结**（不拆、不改、不扩展），新形态落地后再定迁移或退役。

### 2. 传输改造在框架层完成，禁止宿主垫片

AgentDev 框架的 DebugHub / ViewerWorker 传输收敛为传输接口：UDS/命名管道成为「本机优化特例」，新增网络原生承载（TCP 上的既有 JSON-lines 协议，不新造协议）。禁止 Claw 侧垫片（代理进程持 UDS 向容器转发）——垫片即暴力兼容，掩盖框架传输层的真实缺陷，出问题时隔着两跳排查，重现旧远程的调试之苦。

TCP 监听是 viewer 包内改动（`createNetServer` 回调结构与 UDS 监听共享 clientId 注册表与消息分发），由 server.js 经构造参数开启。Claw 托管 runtime 当前只用 `viewer-worker`/UDS；框架的 `claw` HTTP 适配服务于独立 Claw Runtime 拓扑，本 ADR 不将它算作 Claw 产品内的并行链路，也不预设退役。传输接口收敛必须保留该适配的现有契约，若实现上需调整或退役，另作明确决策；本地 UDS 与容器/远程网络传输则属于同一 ViewerWorker 通道的不同承载。第三种执行环境接入应新增传输实现，不在 DebugHub 业务方法逐点增加分支。

### 3. HTTP 业务面：地址配置化 + 统一认证

runtime → 平台的全部 HTTP 调用（ViewerWorker dequeue、Server protoclaw 域）统一从宿主注入的连接配置取址：`PROTOCLAW_SERVER_ORIGIN`（已存在）与新增的 `AGENTDEV_VIEWER_ORIGIN`（完整 origin，缺省回退现状 `127.0.0.1:AGENTDEV_VIEWER_PORT`）。网络传输与 HTTP 面共用同一 token 体系（见调查结论 A）。

### 4. 生命周期：Node IPC 替代为平台注册协议

runtime 经平台 HTTP 注册与心跳替代 `process.send` 握手，承载改变、语义保留：沿用 ADR-0010 修订一的身份事实（托管 runtime 归属先于 Viewer 可见性），容器启动成功 ≠ 就绪，平台以「注册完成 + 身份核对 + Session 可用」为就绪准绳；停止、崩溃、重启映射到同一协议。

### 5. 验收判据：「自然一致」的可判定形式

- **硬验收**：业务路由零环境分叉（寻址与传输统一在宿主执行层一处）；Feature 与 agent 装配零感知（同一 `agent.js` 三环境加载行为一致）。
- **自然推论**：前端零环境分支（环境只体现为地址与状态元数据）。
- **显式豁免清单**：真环境绑定能力（OS 通知、本地文件路径呈现等）逐项列出、不强行一致——强行一致本身是另一种暴力兼容。

## 执行前调查结论（2026-10-30，全部代码级核实）

### A. 认证现状与网络认证设计

现状事实：

- 内部 token 已存在且稳定：`server/auth.js` 启动时从用户数据 `auth.json` 读取/生成 `serviceToken`（`randomBytes(32)` hex，持久化、跨重启稳定），写入 `process.env.PROTOCLAW_INTERNAL_TOKEN`；spawn runtime 时经 env 注入（`agent-startup.js` 的 `getInternalAuthToken()`）。token 的存在与登录保护开关（`enabled`）相互独立——未开启登录保护时 serviceToken 同样生成并持久化。
- ViewerWorker HTTP 端点（dequeue-input / user-turn 等）零认证，信任边界 = HTTP 服务器仅监听 `127.0.0.1`。
- UDS/命名管道零认证，信任边界 = 同机文件系统可见性。
- ViewerWorker 为 server 进程内组件，token 可经构造参数/进程内配置直达，无跨进程传递问题。

设计结论：复用 `PROTOCLAW_INTERNAL_TOKEN` 作为唯一内部 token，不新造 token 体系。TCP 传输认证 = 连接建立后首条协议消息前必须完成 auth 帧（携带 token），未认证连接不进入消息分发、失败即断；HTTP 面（runtime 消费的 dequeue 等端点）在非回环监听启用时要求 Bearer。本机回环模式行为不变（本地分支零改动，沿 ADR-0011 本地优先纪律）。token 轮换沿用 `auth.json` 持久化语义，轮换通知可挂接既有 refresh-credentials 广播机制（ADR-0028 修订一 / ADR-0034 决策 6a），容器 runtime 与本机 runtime 同等待遇。

### B. 传输改动面（TCP 监听与接口收敛）

现状事实：ViewerWorker `startUDSServer()` = 计数器 clientId + `udsClients` Map 注册表 + 按行分帧 + close → `emitDisconnectedByClientId` 广播，注释明示「一个 UDS 连接可承载多个 agent session」；DebugHub 侧 `connectToWorker()` 对称同构。DebugHub 传输专用代码约 53 行 / 全文件 1208 行。

设计结论：TCP 监听复用同一 `createNetServer` 回调结构换 `listen(port, host)`，与 UDS 共享 clientId 注册表与消息分发，仅在每连接加 A 节认证前置闸。runtime 侧新增 `AGENTDEV_VIEWER_ADDR`（host:port）env，显式设置时优先于 `AGENTDEV_UDS_PATH`；连接、分帧、重连退避、重连后全量重注册逻辑全部复用。改动面合计（双侧监听/连接 + 认证闸 + env 解析 + 双传输回归测试）为数百行级，无协议重写。

### C. runtime 侧 HTTP 调用点盘点

本机地址硬编码的完整清单：

- 框架：`agent/react-loop.ts` dequeue（`AGENTDEV_VIEWER_PORT` + 硬编码 `127.0.0.1`）——框架侧唯一消费点。
- 宿主：`scripts/runtime-passive-mailbox.js` dequeue（同模式）——宿主侧唯一消费点。
- runtime→Server：`PROTOCLAW_SERVER_ORIGIN` 已 env 注入（`agent-startup.js`），无硬编码。
- Server→Viewer：`VIEWER_ORIGIN`（`server/shared/constants.js`）为平台进程内同机寻址，平台不动，保留。

设计结论：地址配置化 = 两个 dequeue 消费点改读 `AGENTDEV_VIEWER_ORIGIN` + 宿主 spawn env 注入，工作量极小；无其他隐藏消费点（grep 全仓核实）。

### D. 数据面与供给

现状事实（runtime 进程直接读写的平台数据）：

- 会话快照：FileSessionStore → `USER_DATA_ROOT/{workspaces/<agentId>/sessions | prebuilt-sessions/<agentId>}`；`USER_DATA_ROOT = resolveUserDataDir()` 且支持 `AGENTDEV_DATA_DIR` 覆盖（多实例隔离机制已存在）。
- 会话索引：runtime 经 session-access 同源读 `index.db`（ADR-0036）解析会话工作目录；WAL 支持父子进程并发读。
- 模型配置与凭证：runtime import `server/model-preset-resolver.js` 读用户数据 `default.json` / `presets.json`（`MODEL_CONFIG_PATH` / `MODEL_PRESETS_PATH`）、模型连接配置（`MODEL_CONNECTIONS_PATH`）与 agent 用户配置（`AGENT_USER_CONFIG_PATH`），含 OAuth token 启动预刷新（oauth-codex 走 `preflightRefreshTokens`）。
- 工作目录：programming-helper 会话 cwd 直接取 `PROTOCLAW_SESSION_WORKSPACE_CWD` env（宿主计算后注入）；其余 workspace 型 agent 从 `state.json` / 索引记录解析宿主绝对路径。

设计结论（容器阶段）：以挂载供给——用户数据子集（该 agent 的 sessions 目录 + 模型配置与凭证文件）挂载进容器并以 `AGENTDEV_DATA_DIR` 指向；项目目录挂载 `/workspace`；会话 cwd 走 env 注入通道（PH 已就绪，其余 workspace 型 agent 需把 env 覆盖提升为通用路径，列入实施项）。索引双读沿用 WAL 并发事实。远程阶段挂载失效，数据面归属（runtime 本地持有 + 平台投影 vs 平台权威 + runtime 无状态化）是进入远程前必须另立的方向决策；本篇只确立「容器阶段不改变文件契约」。

### E. 容器执行后端边界

现状事实（`agent-startup.js`）：

- 两个 spawn 点：`startManagedAgent`（stdio 含 ipc，runtime-identity 握手）与 `startAssemblyRuntime`（无 ipc，stdout 就绪探测）。
- IPC 协议消息：`runtime-identity`（子→宿主，携 viewerAgentId；宿主校验 agentId/sessionId 匹配后更新托管记录）→ `runtime-identity-accepted`（身份交接权威边界，ADR-0010 修订一）；`session-exited`{persisted}；就绪 = stdout `[ProtoClaw Runtime] READY session=`；exit 处理区分人为停止 / 崩溃（线程看板收敛语义）。
- 宿主注入 env 全集：`AGENTDEV_DEBUG_TRANSPORT` / `AGENTDEV_VIEWER_PORT` / `AGENTDEV_UDS_PATH` / `PROTOCLAW_SERVER_ORIGIN` / `PROTOCLAW_INTERNAL_TOKEN` / `PROTOCLAW_PREBUILT_AGENT_ID` / `PROTOCLAW_PREBUILT_SESSION_ID` / `PROTOCLAW_SESSION_WORKSPACE_CWD` / `PROTOCLAW_SESSION_TYPE` / `PROTOCLAW_GC_CHAT_ID` / `PROTOCLAW_MODEL_PRESET_ROLE` /（assembly 分支）`PROTOCLAW_ASSEMBLY_RUNTIME` / `PROTOCLAW_ASSEMBLY_WORKSPACE`。

设计结论：执行后端 seam 落在两个 spawn 点——后端契约 = `start(env, argv)` → 就绪事件 → 生命周期事件（exit / session-exited）→ `stop`（宽限后强杀，对应现有进程树收割语义）。本地后端保留 IPC 不动；容器后端把 IPC 三消息映射为平台 HTTP 注册协议（新 protoclaw 端点，payload 同构），stdout tail → 容器日志。就绪语义不变：容器启动 ≠ 就绪，注册完成 + 身份核对 + READY 才可用。

### F. 镜像供给与版本对齐

现状事实：`pack:desktop`（`scripts/pack-desktop.mjs`）组装链 = 框架构建 → 工作区导出 → 18 包 tgz vendor（`file:vendor/*.tgz` 实体安装，无 junction 语义）→ 干净 install → 构建 local-features / features → 瘦身 → 拷贝 node（pinned 24.19.0）→ 隔离端口冒烟；staging 树即「发布形态 runtime」的权威组装产物。

设计结论：容器镜像内容直接复用 desktop-staging 组装产物作为镜像构建上下文——同一 tgz 清单 = 同一版本轨道，桌面与容器天然对齐；Linux 基础镜像 + 同 pin node。开发态 `file:` junction 永不进镜像（镜像只从 vendor tgz 构建，即发布形态）；调试本地框架改动走重建镜像或挂载 dist 覆盖，属实施细节。镜像入口冒烟复用 pack:desktop 的隔离端口冒烟思路。

修订（2026-10-31，容器阶段实施计划）：本轮镜像构建只实施**本地树直接取材**路线（断网可构建：依赖复用本地 node_modules，开发态 `@agentdevjs/*` 经相邻仓库 `npm pack` 实体化，镜像内容 = 本地树现状，开发迭代形态）；原 staging 组装轨道（干净安装、可复现版本轨道，需 registry 网络）作为路线二**预留**——共用 Dockerfile，将来接入为小增量，正式分发、跨机一致与配置面 UI 归产品化里程碑。Linux 基础镜像 + 系统依赖（git）收敛为本地预烘焙 base 镜像（联网准备一次，此后树级构建不再联网）。见 [docs/plans/2026-10-31-runtime-container-phase.md](../plans/2026-10-31-runtime-container-phase.md)。

修订（2026-11-02，按 agent 最小依赖镜像）：镜像从"全局单镜像"改为**一 agent 一镜像**——`pack:container [-- --agent=<id>]` 按 agent 构建，内容 = run-prebuilt-agent 宿主闭包 + 该 agent 的 agent.js 闭包（含其引用的 local-features / features 子包）+ bare import 依赖的递归闭包，node_modules 只含闭包集合；全局镜像与 `latest` tag 退役，容器后端按 agentId 选 `agentdev-claw-runtime:<agentId>` 主 tag（`CLAW_RUNTIME_CONTAINER_IMAGE` 保留为显式整体覆盖）。构建持续本地树直取，**不引入 npm install / registry 耦合**（路线二 staging 组装轨道不作为容器构建路径）；版本对齐归产品层——镜像副 tag `<agentId>-<版本>-<hash>[-dirty]` 与 OCI revision label 记录来源，供运行时核对。

## Consequences

- **正面**：三态一致由架构保证而非逐端点纪律；框架传输层缺陷被显式修正而非垫片掩盖；旧远程「每端点补一个远程分支」的模式不再复发。六项执行前调查全部落定，实施前无未知阻塞项；改动面收敛为：框架传输接口 + TCP 监听（数百行级）、两处 dequeue 地址化、agent-startup 执行后端 seam、镜像复用 pack 组装、容器数据以挂载供给。
- **代价**：跨仓库改动，AgentDev build / 发版 / 版本对齐的流程成本大于代码成本；双传输并存期测试面翻倍（重连、认证失败、输入租约跨断线在两种传输下都要成立）；回环信任被替换为显式 token 认证（回环模式行为保持不变）。
- **风险**：远程阶段数据面归属未决（D 节，进入远程前另立决策）；框架 `claw` HTTP 适配需在传输接口实现时保持兼容；非 PH 的 workspace 型 agent cwd env 通道需通用化（实施项）。
- **非目标**：本篇不决定容器安全基线细节（非 root、挂载白名单作为工程卫生默认项执行，不做对抗性逃逸验收）；不决定远程阶段的产品形态与部署拓扑（容器阶段定型后另立决策）。

## 实施进展

### M1 — 外部 agent 经 TCP 接入（2026-10-31 已实施，隔离实例验收通过）

范围 = 决策 2 的最小闭环：只做传输承载与认证，不动 HTTP 面、不动生命周期 IPC、不做容器。它把「平台-runtime 分离」第一次作为真实约束验证：独立进程、跨 TCP、token 认证，而非依赖 Claw spawn 子进程的父子关系。

实施（两个仓库，已验证、未提交）：

- **AgentDev 框架**（`debug-hub.ts` / `viewer-worker.ts`）：新增 `AGENTDEV_VIEWER_ADDR`（host:port）env，显式设置时 TCP 承载优先于 `AGENTDEV_UDS_PATH`，未设置时行为不变。TCP 连接在首条业务消息前必须完成 auth 帧（携带 `PROTOCLAW_INTERNAL_TOKEN`），收到 `auth-ok` 才进入既有 JSON-lines 消息分发；认证失败即断开。ViewerWorker 侧 TCP 监听与 UDS 监听并存。测试：`packages/core/test/debug-hub-tcp-transport.test.ts`、`packages/viewer/test/viewer-worker-tcp-transport.test.ts`（真实 socket 鉴权与注册）。
- **Claw**（`server/shared/string-helpers.js`）：`childProcessEnv()` 剥离平台专属 env（`AGENTDEV_VIEWER_ADDR`）。全部托管 runtime spawn 点（`agent-startup.js` 两处、`session.js` 两处）经此函数取 env，因此 server 进程开启 TCP 监听时，托管 runtime 仍按显式注入的 `AGENTDEV_UDS_PATH` 走 UDS。契约测试：`test/child-process-env.test.js`。

验收（隔离实例：独立端口 `PORT=1520` / `AGENTDEV_VIEWER_PORT=2526` / `AGENTDEV_VIEWER_ADDR=127.0.0.1:2527`，`AGENTDEV_DATA_DIR` 指向独立数据目录，per-instance UDS 管道按 dataRoot 派生；外部 agent 为独立 Node 进程，经框架 `Agent.withViewer()` 接入）：

- TCP 监听与 UDS 监听并存启动（日志双确认）。
- 外部 agent 经 TCP 完成认证并注册：平台日志出现「已认证 TCP 客户端」与「Agent 已注册 [client: tcp-client-*]」，ViewerWorker `/api/agents` 返回该 agent `connected: true`。
- 错误 token 收到 `auth-error` 且连接被关闭（端到端负例）。
- 同实例托管 runtime（coder）经 per-instance UDS 管道注册，无新增 TCP 认证日志——托管隔离端到端生效；外部 agent（TCP）与托管 runtime（UDS）并存工作。

已知缺口与开放点：

- **外部 runtime 的注册与生命周期路由（决策 4 的实际内容，纯路由工作）**：侧栏呈现是既有能力，无需新工作——server `projectConnectedAgents` 把 viewer 注册、无托管记录且无 prebuilt 宿主的 runtime 以 `source: 'external'` 并入 `/api/agents`（`agent-connected.js`），前端 `groupConnectedAgents` 将其渲染进「外部代理」分组（`external-agent-list`），并配有关闭/重启菜单（`modules/external-runtime.js`）。与 ADR-0010 修订一的分工：托管归属模型约束的是托管 child 的工作空间→目录→会话投影；viewer-only runtime 走独立的外部组通道，两条通道并行、互不覆盖。真正缺的是路由层事实：外部 runtime 在 server 侧没有注册记录——关闭/重启菜单因无宿主通道而禁用、无会话归属元数据（目录/项目投影为空）、退出与崩溃只能靠 viewer 连接断开被动感知。决策 4 = 把注册/退出/停止通道协议化。
- **token 分发**：`auth.json` 仅在启用登录保护时落盘，未启用时 `serviceToken` 只存在于 server 进程内存，外部 runtime 无从获得（本次验收以预置 `auth.json` 固定 token 规避）。平台注册面设计需一并解决 token 引导。
- **嵌套启动 env 泄漏（既有问题，非本次引入）**：在托管 runtime 内启动 Claw server 时，宿主注入的 `AGENTDEV_UDS_PATH` 等变量会穿透 `resolveInstanceUdsPath()` 的 per-instance 派生（explicit 分支短路），隔离实例会抢占全局默认管道。验收时以 `env -u` 显式清理规避；是否在启动入口默认剥离这类宿主变量，另行小决策。

下一步：HTTP 面地址配置化（决策 3，`AGENTDEV_VIEWER_ORIGIN`）→ 执行后端 seam 与平台 HTTP 注册（决策 4）→ 容器执行后端与镜像（决策 E / F）。

### M2 — HTTP 面地址配置化（2026-10-31 已实施，测试验收通过）

范围 = 决策 3 的 runtime 侧：两个 dequeue 消费点（框架 `agent/react-loop.ts`、宿主 `scripts/runtime-passive-mailbox.js`）改读 `AGENTDEV_VIEWER_ORIGIN`（完整 origin），未注入时回退现状 `http://127.0.0.1:AGENTDEV_VIEWER_PORT`；`PROTOCLAW_INTERNAL_TOKEN` 存在时随请求携带 Bearer——「网络传输与 HTTP 面共用同一 token 体系」的客户端侧落地。服务端 Bearer 强制与非回环 HTTP 监听绑定同一开关（调查结论 A：非回环监听启用时才要求 Bearer，本机回环行为不变），随容器/部署步落地；本步服务端零改动，回环行为不变。

实施（两个仓库，已验证、未提交）：

- **AgentDev**（`packages/core/src/core/agent/react-loop.ts`）：`fetchQueuedInput` 寻址改 origin 优先 + Bearer。测试 `packages/core/test/viewer-http-origin.test.ts`：真实 `onCall` 驱动 react-loop step 边界探测，断言 dequeue URL 与 Authorization 头（origin 生效 / 回退回环+端口 / Bearer 有无，共 4 用例）。
- **AgentDevClaw**（`scripts/runtime-passive-mailbox.js` + `server/shared/string-helpers.js`）：mailbox 同口径寻址（优先级 `ctx.viewerOrigin`（测试注入）> env `AGENTDEV_VIEWER_ORIGIN` > 回环 + `ctx.viewerPort`/env 端口）与 Bearer；`childProcessEnv()` 剥离 `AGENTDEV_VIEWER_ORIGIN`——托管本地 runtime 固定回环 + 注入端口，不消费平台面向外部 runtime 的部署 origin（与 M1 剥离 `AGENTDEV_VIEWER_ADDR` 同一纪律：平台视角书写的地址对同机 runtime 可能不可达）。测试：mailbox 新增 4 用例、`test/child-process-env.test.js` 扩展覆盖两个平台专属键。

验收：框架 4 个测试文件 20 用例通过（`viewer-http-origin` 新增 4 例，含 `turn-source-association` / `call-turn-kind` dequeue 回归与 M1 TCP 回归），core 构建后 dist 含新寻址逻辑；Claw 15 用例通过（mailbox 既有 8 例回归 + 寻址/认证新增 4 例 + childProcessEnv 契约 3 例）。验收边界：origin 仅在 runtime 与平台分处不同网络命名空间时产生行为差异，本步证据 = 以注入 origin 驱动两条真实消费路径（react-loop step 边界探测、mailbox 轮询）并对 dequeue URL 与 Authorization 头断言；跨进程部署距离的实机验收留待执行后端步（首个真实非本机 runtime）。

下一步：执行后端 seam 与平台 HTTP 注册（决策 4：外部 runtime 的注册/退出/停止路由与生命周期通道；呈现层由既有外部代理分组承接，无新工作；同时消化 token 分发开放点）→ 容器执行后端与镜像（决策 E / F，届时落地非回环 HTTP 监听 + Bearer 强制）。

### M3 — 平台注册协议与停止通道（2026-10-31 已实施，隔离实例端到端验收通过）

范围 = 决策 4：外部 runtime 的注册 / 退出 / 停止生命周期通道，及 token 磁盘引导（解决 M1 记录的 token 分发开放点）。呈现层零新工作：合并列表既有 viewer-only 外部分支直接承接。

实施（两个仓库）：

- **token 无条件落盘**（`server/auth.js`）：serviceToken 首次生成即持久化（原子写，与 auth 配置同文件），不再依赖登录保护配置触发。外部 runtime 从用户数据目录 `auth.json` 读取完成引导认证，跨重启稳定。
- **注册协议**（新 `server/routes/runtime-registration.js` + `server/shared/external-runtime-registry.js`）：`POST /protoclaw/runtime/register` / `POST /protoclaw/runtime/exited` 为机器通道，**无条件要求 internal Bearer**（登录保护未启用时全局中间件放行 `/protoclaw` 域且 server 监听全部网卡，机器通道的信任不能依赖该开关；与 TCP 控制通道同口径）；`POST /protoclaw/external_runtime/stop` 为浏览器会话通道，转投 ViewerWorker。身份规则：viewerAgentId 占用运行中托管 runtime 或 prebuilt APP 身份时 409 结构化拒绝（防冒充托管身份混入侧栏投影），格式非法 400 拒绝不改写。注册表进程内不落盘——外部 runtime 生命周期权威在自身进程，服务重启后重新注册。注册次序与托管 IPC 握手一致：归属先于 Viewer 连接，等 accepted 再接入。
- **停止下发**（框架）：ViewerWorker 新端点 `POST /api/agents/:id/stop`，与 interrupt 同一连接下发通路（TCP / UDS 认证客户端共用 clientId 注册表）；`DebugHub` 新增 `setStopHandler` 注册面与 `stop-agent` 分发——未注册回调只记录不动作，停止语义归宿主（持久化、收尾、断连由 runtime 自行决定），框架不代决定退出时机。
- **呈现接线**（`server/routes/agent-connected.js` + `public/src/modules/external-runtime.js`）：合并列表外部条目经注册表 join 补 `external_registered` 标志与声明目录（`open_directory` 回退）；前端侧栏关闭对已注册外部 runtime 走新停止通道，重启通道维持既有语义（纯外部 runtime 无重启宿主，重启归其所有者）。

验收：

- 测试：Claw `test/runtime-registration.test.js` 10 用例（鉴权边界、身份规则、退出幂等、停止转发与记录收敛——真实 express app + ViewerWorker stub）；auth 6 用例（含首启落盘 + 跨重启复用，隔离子进程）；框架 viewer 全量 162、debug-hub 全量 8（含新增 stop 经 TCP 下发与 stop-agent 分发用例）；Claw 回归 mailbox / childProcessEnv 15 用例；import 环 0。
- 隔离实例端到端（真实进程间）：首启 `auth.json` 自动落盘（无预置）→ 外部 Node 进程从磁盘读 token → 平台注册 accepted → TCP 认证接入 → 合并列表条目 `source: external / external_registered: true / open_directory: 声明目录` → `POST /protoclaw/external_runtime/stop` → 连接下发 stop-agent（runtime 日志实证「收到停止指令」）→ 退出上报 → 进程退出码 0 → 条目从合并列表消失、二次 stop 404（注册记录收敛）。

开放点：

- feature-comms 请求面（ADR-0018 `/protoclaw/feature-comms/request` → runtime `onHostRequest`）仍只投递托管 IPC 子进程，外部 runtime 收不到宿主请求——待外部 runtime 真实需要 Feature 面板交互时接入（同连接下发或注册协议扩展）。
- 注册协议依赖的 TCP 监听仍为 env 实验开关形态，产品化配置入口随容器 / 部署步一起做（与 M2 同口径）。

下一步：容器执行后端与镜像（决策 E / F；届时落地非回环 HTTP 监听 + Bearer 强制、数据挂载供给，注册协议与停止通道零改动复用）。

### M4 — 执行后端 seam 与本地平移（2026-10-31 已实施，测试验收通过）

范围 = 决策 1「执行环境经配置选择」的机制本体 + 计划两项随行修复（M1 遗留嵌套 env 泄漏、D 节 cwd 注入通道通用化）。不依赖 Docker；本地后端逐字平移现状，目标零行为变化。

实施（Claw 单仓）：

- **执行后端 seam**（新 `server/runtime-executor/`）：`index.js` 选择器 + `local-backend.js` 本地后端。选择器：`CLAW_RUNTIME_EXECUTOR=local|container` 实验开关（container 在 M6 接入前显式报错，不静默回退）；`CLAW_RUNTIME_EXECUTOR_AGENTS` 逗号清单支持单 agent 试点；共享进程模式（shared-by-project / shared-global）回退 local 并记 warn——add-session IPC 跨不了容器边界。本地后端把承载差异收敛为契约事件：`output`（stdout/stderr 统一来源，宿主在它上面单处实现 READY / Viewer Agent ID 探测，容器后端复用同一解析）、`identity`（携 `accept()` 回执 runtime-identity-accepted）、`session-exited`；handle 即 ChildProcess（pid / kill / exit / `__runtimeOutputTail` 原样保留，managedAgents 记录与共享分组语义不变），原生 message 事件不吞（共享进程 join 依赖）。
- **托管 spawn 点接入**（`server/routes/agent-startup.js`）：startManagedSession 经选择器取后端启动，消息 / stdout / stderr 接线改消费语义事件；startAssemblyRuntime 固定本地后端（同一 seam 形状，容器后端不接通）。`buildSessionWorkspaceEnv` 通用化：其余托管 agent 解析出运行目录时同样注入 `PROTOCLAW_SESSION_WORKSPACE_CWD`（PH 强约束不变，无目录不注入、runtime 侧维持原解析）。
- **cwd 通道消费侧**（`scripts/run-prebuilt-agent.js`）：非 PH workspace agent 的初始 cwd 解析改为 env 显式值优先于索引 / state.json——容器执行环境把宿主绝对路径映射为 `/workspace` 后经同一通道下发（PH 原本即 env-only；assembly 分支不注入该 env，不受影响）。
- **嵌套 env 剥离**（新 `server/shared/nested-runtime-env.js` + `scripts/run-supervised.js`）：宿主进程检测到嵌套特征（`PROTOCLAW_PREBUILT_AGENT_ID` 存在 = 自身跑在托管 runtime 内）时剥离宿主专属 env（UDS / TCP / origin 寻址与会话身份 / 装配形态共 13 键），per-instance 派生不再被宿主注入值短路（修 M1 遗留开放点）；正常启动与显式注入冒烟路径零改动。

验收：`test/runtime-executor.test.js` 9 用例（选择逻辑 6 + 真实子进程契约 3：identity 回执端到端——accept 送达由子进程实证打印 ACK、session-exited 直通、output / tail 截断 / 原生 message 透传、kill）；`test/nested-runtime-env.test.js` 3 用例；回归 agent-lifecycle（buildSessionWorkspaceEnv 用例按通用化口径更新）/ ph-project-session-lifecycle / run-supervised / child-process-env 全绿；import 环 0 新增。全量 core 5310 例中 27 失败经 stash 对照确认全部为存量（HEAD 同败：前端 VM 族系 911ede48 ADR-0035 遗留 fallout，codex-accounts / oauth-codex / memory-sampler 为 server 侧存量），M4 影响面内零新增失败。

开放点：run-prebuilt-agent.js 模块顶层即执行 argv 解析，cwd 优先级消费侧无法以导入方式单测——由注入侧用例 + M6 容器端到端（env 值映射 `/workspace`）补证；存量失败（7 文件 27 例，与本步无关）另行处理，不随本步扩大范围。

### M5 — 镜像与构建（2026-11-01 已实施，构建与镜像自检通过；2026-11-02 修订为按 agent 最小依赖镜像，见本节末）

范围 = 计划 M5 路线一（本地树直取，断网可构建；`--staging` 组装轨道预留未实施）+ M2 遗留的框架侧非回环监听与 Bearer 强制。跨两仓。

实施：

- **框架侧非回环 HTTP 监听**（AgentDev `packages/viewer/src/viewer-worker.ts`）：新 env `AGENTDEV_VIEWER_HTTP_BIND`（默认回环 `127.0.0.1` 行为不变）；绑定非回环时 `handleRequest` 入口统一拦截全端点 Bearer 校验（`PROTOCLAW_INTERNAL_TOKEN`，回环模式零校验）；无 token 且构造非回环绑定直接抛错（fail-fast）；openBrowser 始终走回环地址。runtime 消费侧零改动——M2 的两个 dequeue 消费点（react-loop 与宿主 `scripts/runtime-passive-mailbox.js`）自那时起即条件携带 Bearer。
- **base 镜像预烘焙**（`container/base.Dockerfile`）：`agentdev-claw-base:24.19.0` = node:24.19.0-slim + git + ca-certificates、非 root。联网仅此一次（或 docker save/load 离线导入），此后应用构建不依赖网络。
- **pack:container 构建器**（新 `scripts/pack-container.mjs` + `container/Dockerfile` + `scripts/container-selftest.js`，npm script `pack:container`）：
  - **镜像内容 = Agent runtime 运行闭包，正向收集**：仅装 Agent 有关内容，平台物（server.js / public / 未被 runtime 引用的平台路由）不进镜像。主 context = 白名单树（闭包文件 + prebuilt-agents / local-features / features 整树 + resources/features + package.json，5.9MB 无敏感物）；闭包入口 = run-prebuilt-agent.js + 全部 prebuilt agent.js（agent.js 动态加载、不在宿主静态链，漏入口即漏 server 文件）。
  - **nm 预组装**（`dist/container-nm`，单一 named context）：不依赖 BuildKit 排除特性——named-context 的 `<name>.dockerignore` 在 docker 29.0.1 Desktop 实测不可用（Dockerfile 旁与主 context 根均不生效），且 Windows junction 在 context tar 产生损坏条目（COPY 报 non-directory）。开发态 = 复制骨架（排除 @agentdevjs / typescript / .bin）+ 18 包 npm pack 实体化（安装目录名 = npm 包名短名，`PACKAGE_DIR_OVERRIDES` 仅用于定位框架仓库源目录）+ 传递依赖闭包补齐（83 个，从框架仓库 node_modules）；发布态 / 桌面树 = 复制时仅排除构建期包（`detectInstallForm` 一个探测点收敛四形态差异）。
  - **构建纯 COPY、零 RUN**：不在容器内 npm install——它会按镜像内 package.json 的 file: 开发态声明重建依赖链接、覆盖 @agentdevjs 实体（实测致装配链断裂）。native 依赖（依赖图递归检出 os/cpu 或 *.node，含 optionalDependencies 平台子包）在宿主侧补齐：本体已随骨架（平台无关纯 JS），按宿主包 optionalDependencies 取 linux + 容器架构（docker daemon 实测）子包 npm pack 解包进 nm（sharp 检出实证：4 个 x64 子包，全架构变体不拉）。
  - **镜像 tag**：`<version>-<git 短 hash>[-dirty]`；无 git 环境（桌面 staging 树）回退 `<version>-released`。
  - **镜像自检**（`scripts/container-selftest.js`）= runtime 语义：容器内加载全部 10 条 prebuilt agent 装配链，import 成功即依赖闭包完整，native 二进制真实加载。
- **tgz 工具共享**（`scripts/pack-tgz-lib.mjs`）：`PACKAGE_DIR_OVERRIDES` / tgzFileName / gunzip / untar 从 pack-desktop.mjs 提取共用，零逻辑变化。

验收：构建端到端通过（6m27s）；镜像 `agentdev-claw-runtime:0.2.3-6b8afa15-dirty`（643MB）自检 10 条装配链全部加载成功。框架侧新增 5 例测试全绿（绑定解析 / 回环不变 / 非回环无 token 401 / 有 token 200 / 无 token 构造抛错），viewer 包全量 167 例全绿，框架 build 已生效。构建期实测修入注释的坑：闭包正则 lastIndex 跨文件污染（短文件整文件 import 漏抓）、依赖队列快照腰斩（递归断在第二层）、npm install 的 file: link 副作用、junction tar 损坏条目。

开放点：断网实测与桌面树（pack:desktop staging 内运行 pack:container）实测待补；镜像内容 = 本地树现状快照（路线一既定语义，见调查结论 F 修订），可复现轨道留待路线二。

修订（2026-11-02，按 agent 最小依赖镜像，替代上述全局单镜像形态）：一 agent 一镜像，`pack:container [-- --agent=<id>]` 产出 `agentdev-claw-runtime:<agentId>`。主 context = run-prebuilt-agent 宿主闭包 + 该 agent 目录整树 + 其引用的 local-features / features 子包（resources/features 仅当闭包引用 server/feature-runtime 时携带）；nm named context = 该闭包 bare import 的递归依赖闭包（package.json 声明驱动展开，开发态 @agentdevjs 实体化 + 版本分叉嵌套仲裁语义不变；声明但本机未安装的 optional 平台变体 / optional peer 跳过复制，真实缺失由镜像自检兜底）。纯 COPY 零 RUN 零 npm install 不变；原路线二（staging 组装轨道）不接入容器构建，版本对齐归产品层（副 tag + OCI revision label）。自检改为"镜像内应恰好包含目标 agent"（零 agent 即失败）；e2e 预检改为按 agent 校验镜像存在。

下一步：M6 容器后端接入 seam（注册握手 ticket、数据挂载供给）与四场景端到端验收。

### M6 — 容器后端与端到端验收（2026-11-01 已实施，四场景 8/8 隔离实例验收通过）

范围 = 计划 M6：容器后端接入 M4 seam、注册协议 ticket 化、runtime 侧注册客户端、四场景端到端验收。全部 Claw 仓改动。

实施：

- **注册协议 ticket 扩展**（新 `server/shared/runtime-spawn-tickets.js` + `server/routes/runtime-registration.js`）：一次性 spawn ticket——宿主创建 pending 托管记录时进程内签发（不落盘），经 env 注入容器；携 ticket 注册 = 托管身份交接（豁免防冒充 409、完成 managed 记录 identity 回执、不建外部 runtime 记录），无 ticket 的外部注册路径规则不变。身份不吻合、重复消费、过期（默认 5 分钟）均拒绝。exited 端点支持 session 级转发（容器 handle 上报按 agentId+sessionId 寻址托管记录）。
- **runtime 侧注册客户端**（`scripts/run-prebuilt-agent.js`）：`PROTOCLAW_RUNTIME_REGISTER=1` 时走网络路径——携 ticket 注册 → accepted 后经 `AGENTDEV_VIEWER_ADDR` TCP 认证接入 → 注册优雅停止 handler；本地 IPC 握手形态不变（同一握手块二分支）。closeHostedSession 在网络形态上报 session-exited；stop handler 收尾改走 closeHostedSession（持久化 + 上报 + 进程退出语义完备，不再裸 disposeAllSessions——裸退出不上报，宿主的持久化确认会落空）。
- **容器后端**（新 `server/runtime-executor/container-backend.js`，`index.js` 接入，dockerode 依赖）：经命名管道连 Docker daemon（纯 JS 无二进制）。env **白名单**透传（仅平台协议变量 + 平台寻址三址换 host.docker.internal——宿主全量 env 会以 Windows PATH 污染容器，`exec: "node": executable file not found` 实测）；数据挂载 = 会话存储（workspace-bound 整 `workspaces/<agentId>`、其余 `prebuilt-sessions/<agentId>`）+ 模型配置与凭证 + handoff + 会话工作目录 → `/workspace`（挂载源是 `PROTOCLAW_SESSION_WORKSPACE_CWD` 会话目录而非 seam cwd——后者是仓库根，实测文件落容器可写层）；退出监测经容器事件流；停止走宿主 stop-agent 通道 + 宽限强杀 + 容器实体清理兜底；镜像缺失显式报错不静默回退。
- **宿主停止路径容器分支**（`server/routes/agent-lifecycle.js`）：removeHostedSession 对无父子 IPC 的 handle 经 viewer stop-agent 下发、以 session-exited 回执确认持久化完成，exit 事件兜底（容器形态停止语义与本地 IPC 收敛一致）。
- **共享进程模式 executor 修订**（M4 回退语义修正）：join 路径（add-session）不经 executor、bootstrap spawn 与 isolated 同构可走容器——原「共享模式整体回退 local」覆盖过宽，实际只需守住 join 边界：join 到容器共享进程时显式 409 报错给出路，不静默回退。
- **viewer Bearer 消费点补全**（M5-A 遗漏的第 8 处，新 `server/shared/viewer-fetch.js`）：server→viewer 的全部消费面统一经 helper（与校验端同源读 `PROTOCLAW_INTERNAL_TOKEN`）——readViewerJson、ACP interrupt、群聊 dispatch ×3、embedded-connector、本地代理转发、`user-turn.js` submitUserTurn（仅本地基址注入，远程隧道路径不注入——远程端 token 不同）。E2E 实证：漏掉 user-turn 时输入投递 401、指令永久滞留 pending。
- **SQLite 会话索引锁驱逐**（`server/shared/session-access.js` 新 `evictSessionDb` + 容器分支调用）：**WAL 共享内存锁跨不过容器边界**（实验证明：Windows bind mount 上 node:sqlite 单侧正常；宿主与容器双开同一 index.db → `SQLITE_IOERR_LOCK` 4618 必炸）。容器 spawn 前驱逐宿主侧该 agent 长开连接——容器运行期索引归容器独占写，容器停止后宿主重开安全（跨执行环境恢复场景实测通过）。
- **镜像依赖嵌套仲裁**（`scripts/pack-container.mjs`）：镜像扁平复制无版本仲裁——Claw 根 openai 6.x 劫持框架 4.x 解析（6.x `ResponseAccumulator.assertNever` 对 API 新事件 `response.metadata` 直接抛错，容器内模型调用全灭，本机因 junction 解析到框架仓 4.x 而不炸）。修复 = 与 npm 冲突解析同构的嵌套仲裁：框架包直接依赖与根已装版本 major 分叉时嵌套复制框架本机实测版本；仲裁包的传递依赖递归改用框架仓库源（根版本依赖树不同，openai 4.x 的 node-fetch 等 7 包靠此补全）。
- **E2E 验收脚本**（`scripts/e2e-container-phase.mjs`）：隔离实例（独立数据根 / 三端口 / per-instance UDS）+ 真实容器 + 真实模型调用，四场景八断言全链驱动，自带环境净化（剥离 `AGENTDEV_UDS_PATH` 等宿主残留 env——工具链环境残留的显式管道名会短路隔离实例派生）。

验收（隔离实例端到端，8/8 通过）：① 注册接入（ACP 建线 → ticket 身份交接 → READY 确认 → 容器运行）；② 完整一轮对话（输入 → 容器内 dequeue → 模型回复 → 快照落盘宿主可读）；③a 数据面写路径（容器内 shell 写 /workspace → 宿主同目录可见 + 回执落盘）；④a 崩溃收敛（docker kill → wait 收敛 → 容器实体移除）；③b 崩溃恢复（新容器唤起 + 快照恢复 + 历史引用正确）；④b 优雅停止（stop_agent → 容器收敛 + 线程记录完好）；③c 跨执行环境一致（容器写快照 → 本地 runtime 恢复并正确引用）。单元与回归：runtime-executor / runtime-registration / runtime-spawn-tickets / session-index-cache / child-process-env 55 例全绿。

开放点：

- **宿主运行期读容器 agent 的 index.db 会撞锁** → 已由「M6 后续 — 开放点治理」收口（索引委托，快照读）。
- **feature-comms 请求面（ADR-0018）对容器 runtime 不可达** → 已由「M6 后续 — 开放点治理」收口（viewer host-request 通道）。
- **Feature 模板资产对容器 runtime 不可达**（`/tpl/` 挂载路径是容器内路径，宿主 ViewerWorker 读不到）→ 已由 [ADR-0038 资源读取协议](0038-resource-fetch-protocol.md) 收口（`/res/` 回源模式，worker 经 host-request 向 runtime 取内容）。
- **多会话同容器（add-session 跨容器边界）不支持**：共享进程模式 join 到容器共享进程显式 409；通道化（宿主中转 add-session）留待真实需求。
- **Coder 执行环境产品设置**：Coder 策略页保存 `runtimeExecutionMode`（standard / container / agent-choice）。固定模式是硬限制；agent-choice 要求派遣入口显式选择 standard 或 container。会话索引 metadata 持久化已裁定模式，接力创建继承；启动按会话模式覆盖 executor 实验开关，容器初始化失败保持失败、不回退。本阶段未改变其他 agent 的 executor 实验开关和环境选择。
- M5 欠账顺延：断网构建实测、桌面树（pack:desktop staging 内运行 pack:container）实测。

至此容器阶段（M4–M6）实施收口：三种执行环境（本地进程 / 容器 / 远程节点）中的前两种经同一 seam 与协议栈工作，远程阶段沿同一架构部署距离测试，待容器形态产品化定型后另立决策。

### M6 后续 — 开放点治理：跨边界读写统一走显式协议（2026-11-01 已实施）

范围 = 收口 M6 记录的前两个开放点。两个问题同源：宿主与容器 runtime 之间残留两处「同机隐式假设」（父子 IPC 通道、共享数据库文件锁），治理方向统一为收敛到既有 viewer 控制连接的显式协议。

实施：

- **feature-comms 请求面通道化**（跨仓：框架 + Claw）：宿主→runtime 定向请求不再依赖父子 IPC，走 viewer 控制连接（与 stop-agent 同模式）。框架侧（AgentDev）新增 `host-request`/`host-response` 帧类型——`DebugHub.setHostRequestHandler` 注册回调（同步 throw 也收口进 then 链，host-response 永不静默丢弃，定向单测抓到该缺陷）；`ViewerWorker` 新增 `POST /api/agents/:id/host-request` 端点（payload 不被 viewer 解释、60s 超时自结算、连接断开即 NAK、runtime 错误透传）。Claw 侧：runtime（run-prebuilt-agent）注册 host-request handler，IPC 分发的 feature-comms 逻辑提取为共享方法（本地 IPC 与网络通道同一实现）；宿主 `feature-communication.js` 对无 IPC handle 的 runtime 改走 viewer 通道（经 `viewerFetch` 携内部 token），两路超时语义一致（store 侧自结算 `request_timeout`）。外部 runtime（TCP 形态）同链路受益。
- **会话索引委托（宿主读治理）**：关键设计事实——宿主是索引唯一写者（runtime 只经 `readSessionIndexSync` 同步读），容器运行期索引内容本就冻结，**驱逐前快照即完整真相，无需向 runtime 代理查询**。`session-access` 新增 `delegateSessionDb`/`resumeSessionDb`：spawn 前驱逐连接并缓存最后快照（替代 M6 的裸 evict）；委托期读返回快照（对象身份稳定，兼容共享只读契约）、写显式拒绝（code `session_db_delegated`，调用方可编程识别重试时机）、`querySessionIndexPage` 走 SQL 版的 JS 等价实现（排序/归档/范围/搜索/分页/精确单查/线程成员谓词逐条镜像）；容器进程 exit 时 resume 恢复宿主直连（幂等）。

验收：框架 viewer 新增 5 例（往返/超时/断连/runtime 错误/输入校验）+ debug-hub 4 例（含同步 throw 收口缺陷）全绿，viewer 包全量 172/172；session-index-cache 29/29（委托 5 用例 + 分页等价性 8 参数组——**等价性测试在同一数据上比对 SQL 版与委托版，抓到 scope 谓词两处镜像缺陷**：无过滤条件时错误过滤空目录、projectId 过滤整体缺失，修复后逐参数组锁定）；E2E 扩展场景 ②b（容器运行期宿主调会话列表 → 委托快照返回、会话在列、不撞 `SQLITE_IOERR_LOCK`）。

剩余开放点（见上方 M6 列表）：多会话同容器（add-session 通道化）、配置入口产品化、M5 断网/桌面树实测欠账。

### 容器修订（2026-11-01 修订二）：索引读协议化，锁补偿机制退役

真机暴露委托机制的边界：`delegateSessionDb` 只能驱逐宿主 **server 进程内**的连接，驱逐不了本地 runtime **子进程**长持的 db 连接（`readSessionIndexSync` 的模块级连接缓存，进程活着就持有）。因此本地 runtime 存活时创建容器会话，容器打开 index.db 必报 `SQLITE_IOERR`（实测复现；对照实验证明与文件状态无关——字节相同的副本无连接持有时容器可正常打开）；反向亦然。编程小助手同时具备本地与容器两种会话形态后，该并存成为真实使用场景，M6 后续的「快照委托 + 启动闸」只能把互撞变成 409，不能消除互斥本身。

决策：**容器内索引访问整体协议化，锁问题域消除而非绕过**。

- 容器后端注入 `CLAW_SESSION_INDEX_REMOTE=1`；`run-prebuilt-agent` 的索引读经 `lookupSessionRecord` 分流——本地形态维持 `readSessionIndexSync` 直读（同内核文件锁有效，零开销），容器形态走平台 `POST /protoclaw/session_record_lookup`（内部 token；写侧 `session_meta_sync` 本就是 HTTP）。`resolveWorkspaceCwd` / `resolveSessionWorkspaceCwd` 随之 async 化（全部调用点均在 async 上下文）。
- `session-access` 在容器形态下 `openSessionDb` 直接抛 `session_index_remote_disabled`——未来任何直连调用立即显式失败，而不是静默撞锁损坏运行态。防护挡「新开连接」（容器是新进程必然新开），已开连接不受影响。
- 挂载不变（会话本体 `<id>.json` 仍直写，容器内无任何代码路径打开 index.db）；`delegateSessionDb` / `resumeSessionDb` / 委托快照读 / `queryDelegatedSessionPage` JS 镜像 / 并存启动闸（409）全部退役删除。受益：本地与容器会话可并存、多容器（coder 多线程批量派发）天然无锁问题、宿主在容器运行期可随时直连读写索引。
- E2E：②b 语义更新（独立宿主进程真开新连接直读 + 容器 meta_sync 推进宿主索引）；新增 ⑤b（容器会话运行中创建本地会话，双方共存——原 409 闸退役验证）。验收：E2E 11/11 隔离实例通过（含 ③b 崩溃恢复走容器内 HTTP 远程读）；session-index-cache 含容器防护用例（破坏校验：移除防护即失败）。
