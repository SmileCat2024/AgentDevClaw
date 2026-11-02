# ADR-0037 容器阶段实施计划（M4–M6）

- **关联**: [ADR-0037](../adr/0037-runtime-execution-environment-unification.md)（决策 1 / 调查结论 D / E / F；M1–M3 已实施）
- **Status**: M4–M6 已实施。M5 镜像构建于 2026-11-02 修订为**按 agent 最小依赖镜像**（一 agent 一镜像；路线二 staging 轨道不接入容器构建，版本对齐经镜像 label 归产品层），见 ADR-0037 修订。
- **前置**: M1 TCP 传输、M2 `AGENTDEV_VIEWER_ORIGIN`、M3 注册协议与停止通道均已落地并验收

## 一、已定决策（方向层，grill 会话结论）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 容器化对象 | **仅 Agent runtime 进容器**；平台（server / 前端 / 索引 / 调度）留本机。平台整体容器化（服务器部署形态）不属本 ADR，将来另立决策 |
| 2 | 目的与深度 | **架构验证先行、产品能力导向**：本轮以实验形态交付（env / 配置文件驱动，无 UI），执行后端 seam 必须落地（兑现"执行环境经配置选择"）；配置入口产品化留下一里程碑。coder 容器沙箱被承认为后续真实价值驱动，影响验收场景但不扩大本轮产品面 |
| 3 | 托管范围 | **含托管 spawn 点容器化**（编程小助手 / coder 新会话可经配置选容器执行）；外部 agent 形态 M3 已验，仅作回归 |
| 4 | 验收场景 | 四条端到端全做：① 注册接入 ② 完整一轮对话（dequeue 真实出网）③ 数据面写路径（/workspace + 会话快照写回可恢复）④ 停止通道收敛；另加非功能判据（agent.js 零改动、业务路由零环境分叉审计、豁免清单成文） |
| 5 | 验收环境 | 本机 Docker Desktop（已装：CLI 29.0.1 / Compose v2.40.3，Linux 引擎），平台 TCP / HTTP 监听经 `host.docker.internal` 寻址 |

路径默认（小决策，评审可调）：

- 镜像经**本地预烘焙 base**（`node:24.19.0-slim` + `git` / `ca-certificates`，非 root）构建；base 联网准备一次，此后树级构建不再联网
- 构建入口新 npm script `pack:container`，本轮只实施**本地树直接取材**路线（断网可构建；开发态 `@agentdevjs/*` junction 先实体化）；staging 组装轨道（`--staging`，可复现版本轨道，需联网）**预留不在本轮实施**；不发布 registry
- 一容器一 runtime 进程；共享进程模式（shared-by-project / shared-global）不进容器（见 M4 约束）
- 用户数据按 D 节 bind mount 读写直写（文件契约不变）；"同一 agent 本地 + 容器并行"首版不仲裁，靠使用约束规避
- M1 遗留嵌套 env 泄漏随 M4 修掉

## 二、代码级事实依据（本计划新核实）

- **Seam 落点**：`server/routes/agent-startup.js` 单文件内两个 spawn——`startManagedSession` 内 `spawn(process.execPath, [RUNTIME_SCRIPT, …])`（约 :483，stdio 带 ipc）与 `startAssemblyRuntime`（:708，无 ipc）。`RUNTIME_SCRIPT = scripts/run-prebuilt-agent.js`（`server/shared/constants.js:14`）。env 组装形态：`sanitizeSpawnEnv({ ...childProcessEnv(), AGENTDEV_DEBUG_TRANSPORT / AGENTDEV_VIEWER_PORT / AGENTDEV_UDS_PATH / PROTOCLAW_SERVER_ORIGIN / PROTOCLAW_INTERNAL_TOKEN / PREBUILT_AGENT_ID / PREBUILT_SESSION_ID, …extraEnv, …buildSessionWorkspaceEnv() })`。
- **生命周期信号**：托管路径 = IPC `runtime-identity` → 宿主回 `runtime-identity-accepted`（ADR-0010 修订一权威边界）+ `session-exited`{persisted} + stdout `READY session=` / `Viewer Agent ID:`；exit 处理区分人为停止 / 崩溃（`stopped` 预标记，线程看板收敛）。`managedAgents` 记录强绑 `ChildProcess`（`isManagedRuntimeRunning` 依赖 `exitCode / signalCode`）。
- **共享进程模式**：`resolveManagedProcessPlacement`（:103）按 `processMode` + 项目目录分组；加入已存在共享进程经宿主→子进程 IPC `add-session` 消息——该通道跨不了容器边界。
- **cwd 注入现状**：`buildSessionWorkspaceEnv`（:73）仅对 programming-helper 注入 `PROTOCLAW_SESSION_WORKSPACE_CWD`；其余 workspace 型 agent 在 runtime 侧从索引 / state.json 解析宿主绝对路径（D 节既定实施项：通用化）。
- **staging 组装**：`scripts/pack-desktop.mjs` = 工作区导出 + 18 包 vendor tgz + 干净 install + local-features / features 构建 + prune + `runtime/node.exe`（**Windows 单 exe，`provisionPinnedNode` 非 Windows 直接报错**）+ `runtime/npm`（纯 JS，跨平台）+ 隔离端口 health 冒烟。镜像不能直接用 staging 自带 node。
- **M3 注册协议身份规则**：`viewerAgentId` 占用**运行中托管 runtime 或 prebuilt APP 身份**时 409 拒绝。托管容器 runtime 恰好就是 prebuilt APP 身份——现有规则会把合法的托管容器注册当冒充拒绝（见 M6 ticket 扩展）。
- **仓库零既有容器资产**（glob 全仓核实）；本机 Docker Desktop 已装未运行（验收时启动即可）。

## 三、M4 — 执行后端 seam 与本地平移（零行为变化）

**范围**：把两个 spawn 点的"启动 + 生命周期接线"抽象为执行后端契约，本地后端逐字复刻现状；本里程碑不依赖 Docker，容器后端在 M6 接入。

新增 `server/runtime-executor/`：

- `contract`：`start(spec)` → handle。spec = `{ argv, env, cwd, ipc: boolean }`；handle 暴露 `pid` / `kill()` / 退出态（`exitCode / signalCode`）/ `onExit` / stdout tail，以及语义事件：`identity`（携 viewerAgentId，需回执）、`sessionExited(persisted)`、`ready`。契约即 ADR E 节的 `start(env, argv) → 就绪事件 → 生命周期事件 → stop` 形式化。
- `local-backend.js`：包装现有 `spawn` + IPC 消息接线 + stdout 探测 + 进程树收割（`killProcessTree`），行为与现逐字等价；`managedAgents` 记录改持 handle（字段兼容：`isManagedRuntimeRunning` / `waitForProcessExit` / `listRuntimesByProcess` 继续工作，共享进程按 handle 身份分组语义不变）。
- **executor 选择**（实验形态）：server env `CLAW_RUNTIME_EXECUTOR`（`local` 默认 / `container`）+ `CLAW_RUNTIME_EXECUTOR_AGENTS`（逗号清单，空 = 全部托管 spawn）。选 `container` 但 agent 为共享进程模式 → 回退 local 并记 warn 日志（共享进程 IPC 加入语义容器内不成立）；Docker 不可用 → 启动**报错**，不静默回退。
- **assembly 路径**：契约形状覆盖（同一 seam），容器后端不接通（agent-creator 已隐藏，低价值），维持 local。

随行修复（对应第一节路径默认）：

1. **嵌套 env 泄漏**（M1 开放点）：`run-supervised.js` 启动入口检测嵌套特征（env 存在 `PROTOCLAW_PREBUILT_AGENT_ID` = 正跑在托管 runtime 内）时剥离宿主 runtime 专属 env（`AGENTDEV_UDS_PATH` / `AGENTDEV_VIEWER_ADDR` / `AGENTDEV_VIEWER_ORIGIN` / `PROTOCLAW_PREBUILT_SESSION_ID` 等），使 per-instance 派生不再被短路。刻意保留显式注入路径（pack:desktop 冒烟显式设 `AGENTDEV_UDS_PATH`）不受影响。
2. **cwd env 通用化**（D 节实施项）：`buildSessionWorkspaceEnv` 扩展为对全部托管 agent 注入 `PROTOCLAW_SESSION_WORKSPACE_CWD`；runtime 侧（`run-prebuilt-agent.js` 会话 cwd 解析）改为 env 显式值优先于索引 / state.json 记录。

**验收**：现有托管启动 / 停止 / 共享进程 / 线程宿主回归全绿（零行为变化）；executor 契约测试（fake backend 驱动 start → identity → ready → sessionExited → stop 语义与回执时序）；嵌套启动用例（预置泄漏 env 的隔离实例确认 per-instance 派生生效）。

## 四、M5 — 镜像与构建入口（pack:container）

**范围**：产出可运行 runtime 镜像 + 落地 M2/M3 遗留的服务端非回环监听与 Bearer 强制。

**构建走本地树直取路线（断网可用）；staging 组装轨道预留、不在本轮实施**（离线是偏好而非门槛，本轮路线不依赖网络通达）。

- **路线一（本轮实施）：本地树直接取材，断网可构建**。上下文 = 本地树，无现场 `npm install`——依赖安装由"本地能跑"这一前提消解（staging 组装链的 registry install 正是离线障碍，故本路线不经 `pack:desktop`）：
  - 源码版发布态（registry 实体）与桌面版安装树：node_modules 全实体，树即上下文（桌面树经 `.dockerignore` 排除 `runtime/node.exe`）。
  - 源码版开发态（`@agentdevjs/*` 为 junction）：构建前实体化——相邻 AgentDev 仓库 `npm pack` 出 tgz 解包替换（本地操作无网络；pack 产物即发布形态，与 vendor 化同语义），`features/*/node_modules/@agentdevjs/core` 同口径。
  - `local-features/dist`、`features/*/dist` 就地复用；缺失或过时则本地重建（`build:local-features` / `build:features`，构建依赖已在本地 devDeps，无网络）。
  - 内容一致性：镜像 = 本地树现状（可含未提交改动与开发态框架源码），开发迭代形态。
- **路线二（`--staging`）：预留，不在本轮实施**。设计定型为：以 `pack:desktop` staging 树为上下文——干净安装、同一 tgz 清单 = 可复现版本轨道、prune 后体积精简；需 registry 网络。预留形态 = 与路线一共用同一 Dockerfile（只做 COPY）与 `.dockerignore` 差异说明，将来接入只是新增上下文来源与入口 flag 的小增量。正式分发与跨机一致性、以及围绕它的配置面与 UI（路线选择、构建参数、tag 对表与镜像清单管理）归产品化里程碑。
- **base 镜像预烘焙**：`container/base.Dockerfile`（`FROM node:24.19.0-slim` + `apt-get install git ca-certificates` + 非 root 用户）产出本地镜像 `agentdev-claw-base:24.19.0`；应用镜像 `FROM agentdev-claw-base` 只做 COPY，Dockerfile 内无网络步骤。**联网需求收敛为 base 首次准备一次**：`pack:container` 检测 base 缺失时自动构建（需网络，日志明示）；断网且 base 缺失 → 报错并给出指引（联网首建，或经 `docker save` / `docker load` 从他机离线导入）。base 经 docker 层缓存长期复用。
- `container/Dockerfile`：`FROM agentdev-claw-base:24.19.0` → `COPY` 树 → `ENTRYPOINT ["node", "scripts/run-prebuilt-agent.js"]`。镜像内 node 与桌面 pin 同版本（路线二将来复用同一 Dockerfile，差别只在上下文内容）。
- `.dockerignore`：清单以路线一为准（`.git`、`.env*`、`.agentdev/`（本地临时产物与敏感配置）、`desktop/`、`dist/`、`logs/`、`test/`、`features/*/node_modules`（构建期依赖）、根 `node_modules` 中的构建期包如 `typescript`；路线二启用时 staging 树天然无这些内容，仅共通排除 `runtime/node.exe`）——实施时核定，原则 = 运行时不需要的不进镜像。
- **构建时机：预构建、手动触发，运行时不构建**。`npm run pack:container` 一次完成准备性变换 + `docker build`；M6 容器后端启动会话时只 `docker run` 既有镜像 tag，镜像缺失直接报错，不代为触发构建、不静默回退。开发迭代 = 改代码后重建镜像；调试本地框架改动的挂载 dist 覆盖属实施细节（ADR F 节）。
- **镜像内容来源：构建期随本地树 COPY，运行时挂载只承担用户数据**。`@agentdevjs/*` 框架包（含未发布版本）经实体化进树（路线二预留：vendor 安装），与 registry 发布状态无关；`local-features` / `features` dist、官方 feature tgz 仓库（`resources/features`）、预制 agent 源码（`prebuilt-agents/`）随树进镜像。运行时从用户 feature 仓库（`user-features/`）解析装配的路径（Agent Studio / plain agent 形态）不在 M6 范围；将来扩展时把 `user-features/` 加入挂载表即可，文件契约不变。
- **框架侧（AgentDev 仓库）**：ViewerWorker HTTP 监听支持非回环绑定（新 env，如 `AGENTDEV_VIEWER_HTTP_BIND=0.0.0.0`），非回环启用时 dequeue 等 runtime 消费端点强制 Bearer（M2 既定 sequencing 的服务端落地；回环行为不变）。跨仓库 build / 版本对齐成本已计入。
- **镜像冒烟**：容器内隔离端口起 server（`scripts/run-supervised.js`）→ `/protoclaw/health` ready → `POST /shutdown` → 退出码 0。证明树完整性 + 纯 JS 前提（如存在平台特定 native 依赖，此处当场暴露）。

**验收**：构建成功且容器冒烟通过；**断网构建实测**（base 就绪 + 本地树就绪，断开网络重跑成功）；框架侧非回环 + Bearer 测试（错 token 401、回环不校验）通过；镜像 tag 记录版本（`agentdev-claw-runtime:<package版本>`，附 git 短 hash、工作区脏时加 `-dirty` 标记，便于跨机对表）。

## 五、M6 — 容器后端与端到端验收

**范围**：容器执行后端 + 托管容器 runtime 的注册握手 + 四场景 E2E。

### 5.1 注册协议 ticket 扩展（`server/routes/runtime-registration.js`）

托管 spawn 在宿主侧先行创建 managed 记录（pending 态）并签发一次性 ticket（进程内随机 id，不落盘），经 env 注入容器。`POST /protoclaw/runtime/register` payload 增可选 `ticket`：携 ticket 且与 pending 记录的 agentId / sessionId 吻合 → 视为托管身份交接（等价 `runtime-identity` + `accepted`），不受 409 冒充规则约束；无 ticket → 既有外部路径不变。`session-exited` / 停止通道（M3）零改动复用。

### 5.2 runtime 侧注册客户端（`scripts/run-prebuilt-agent.js`）

检测 `PROTOCLAW_RUNTIME_REGISTER=1`（无 IPC 通道的托管形态）时：向 `PROTOCLAW_SERVER_ORIGIN` 注册（携 ticket）→ accepted 后接入 Viewer（TCP）→ 经 `DebugHub.setStopHandler` 注册优雅停止（persist + exited 上报 + 退出）。本地 IPC 形态不变。

### 5.3 容器后端（`server/runtime-executor/container-backend.js`）

服务端经 docker 守护进程 API 编程对接：npm 常规依赖 `dockerode`（纯 JS 无二进制，命名管道 / Unix socket 连接守护进程；Docker Desktop 为环境前置不随产品分发，管道地址对 Desktop 的实测属实施项）。镜像构建（M5）走 docker CLI（构建脚本、开发机必有 CLI）；运行时控制用库——需要事件流与状态查询，避免解析 CLI 文本输出。

- 启动：创建并启动容器（`claw-rt-<agentId>-<session片段>`，label `claw-runtime=1`），env / 挂载按下表；ready = 注册 accepted + stdout READY（容器日志流复用既有探测文案）。
- 生命周期：退出监测经容器状态 / 事件流；崩溃（非人为停止退出）走既有崩溃语义（线程看板保留 running 事实）。
- 停止：M3 `stop-agent` 经 TCP 连接下发（容器 runtime 注册的 handler 收尾）→ 宽限窗 → 强杀 + 删除容器兜底（对应本地进程树收割语义）。

### 5.4 挂载与 env 映射

| 宿主 → 容器 | 读写 | 说明 |
|---|---|---|
| `userDataRoot/{workspaces/<agentId>/sessions \| prebuilt-sessions/<agentId>}` → `<dataRoot>/` 同相对路径 | 读写 | 会话快照 + 索引（WAL 并发读，D 节事实） |
| 模型配置与凭证（`default.json` / `presets.json` / 连接配置 / agent 用户配置）→ `<dataRoot>/` 同相对路径 | 读写 | OAuth 预刷新需写回；具体文件清单以 `model-preset-resolver.js` 默认解析实测为准 |
| `context-handoffs/<file>`（存在注入时）→ 同相对路径 | 只读 | handoff 按 runtime 首启导入后自删的契约，容器内删除作用于挂载文件 |
| 会话 cwd（宿主绝对路径）→ `/workspace` | 读写 | 工具执行落盘宿主可见 |

env 映射（相对本地 spawn 的差异项）：`AGENTDEV_VIEWER_ADDR=host.docker.internal:<tcpPort>`（替代 UDS_PATH）、`AGENTDEV_VIEWER_ORIGIN=http://host.docker.internal:<viewerHttpPort>`、`PROTOCLAW_SERVER_ORIGIN=http://host.docker.internal:<appPort>`、`AGENTDEV_DATA_DIR=<dataRoot>`、`PROTOCLAW_SESSION_WORKSPACE_CWD=/workspace`、`PROTOCLAW_RUNTIME_REGISTER=1` + ticket；其余（token / agentId / sessionId / sessionType / gcChatId / modelPresetRole）同本地透传。平台侧实验开关经 `.env`（`CLAW_ENV_FILE` 机制）开启 TCP 监听与非回环 HTTP 绑定。

### 5.5 端到端验收（隔离实例 + 独立数据目录，不碰真实数据）

1. **注册接入**：托管容器 runtime 起容器 → ticket 注册 accepted → TCP 认证接入 → 合并列表 / 侧栏投影正确（coder 线程宿主形态优先验证）。
2. **完整一轮对话**：用户输入 → 容器内 runtime 经 `AGENTDEV_VIEWER_ORIGIN` dequeue（真实跨网络命名空间，M2 首次实机验收）→ 模型回复 → 前端呈现。
3. **数据面写路径**：runtime 工具在 `/workspace` 写文件（宿主同目录可见）+ 会话快照写回宿主 userData → 容器停止后本地重启该会话可恢复（索引 / 快照跨执行环境一致）。
4. **停止通道收敛**：UI / API 停止 → stop-agent 下发 → 容器优雅退出（退出码 0）→ managed 记录 / 容器清收敛；崩溃路径（docker kill 模拟）看板语义正确。
5. **非功能判据**：同一 `agent.js` 与 feature 装配零改动进镜像（对比本地加载行为一致）；`server/` `public/` 业务路由 grep 无环境分支新增；豁免清单初稿成文：OS 通知投递面在平台不受影响、本地路径呈现（容器内 `/workspace`）、Windows 专属工具（powershell）、LSP / 浏览器可选插件按镜像内可用性、容器时区显式设置。

**收尾**：实施进展写入 ADR-0037，AGENT.md 索引同步。

## 六、风险与开放项

- **Windows bind mount IO 性能**（gRPC-FUSE / 9p）：大仓库工具执行可能明显慢于本地——验收观察项，不阻塞，必要时记录为已知限制。
- **纯 JS 前提**：本地树的 node_modules 由 Windows npm 安装；如存在平台特定 optional 依赖，镜像冒烟当场暴露，届时容器内重装该依赖（实施时处置）。
- **构建上下文体积**：本地树含完整 node_modules（数百 MB）——`.dockerignore` 精简后接受；镜像分层缓存缓解重复构建。
- **镜像可复现性**：本轮镜像 = 构建时本地树快照，多机同名镜像内容不同、事后不可重建（tag 附 git hash 缓解对表）；跨机 / 正式分发依赖预留的路线二（staging 轨道）。
- **本地树健康度**（路线一）：镜像继承本地树一切状态（临时安装、未还原改动、半安装残留）；"本地能跑"只覆盖已运行路径，懒加载依赖问题在镜像内才暴露，冒烟只覆盖启动级——实验形态接受。
- **双写并发**：同一 agent 本地 + 容器并行首版不仲裁（已定使用约束）；凭证文件并发写靠原子写机制缓解，风险记录在案。
- **ticket 安全边界**：仅进程内签发与校验、一次性消费、不落盘；滥用面 = 平台进程内，与 token 同信任域。
- **feature-comms 请求面**（M3 开放点）：仍只投递托管 IPC 子进程，容器 runtime 收不到宿主请求——本轮验收场景不含 Feature 面板交互，维持开放点，待真实需要时接入。
- **平台整体容器化 / 远程阶段**：范围外（已定边界）；远程数据面归属是进入远程前的另立决策（ADR D 节）。

## 七、里程碑顺序与依赖

M4（seam + 本地平移 + 两项随行修复，零行为变化）→ M5（镜像 + 框架非回环监听，跨仓库）→ M6（容器后端 + ticket + E2E）。M4 与 M5 无代码依赖可并行推进；M6 依赖两者。每步独立提交、独立验收，沿用 M1–M3 的隔离实例纪律。
