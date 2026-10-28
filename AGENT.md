# AGENT.md

本文件是新进入项目的 agent 的认知地图，用于建立"产品目标 → 核心对象 → 代码入口 → 数据流 → 边界"的连续认知。写作原则：只留概念理解、易错点与索引；细节指向权威文档与代码；不写行数、数量等易漂移的快照数据。

## 先看这里

1. 本文件
2. [docs/README.md](docs/README.md) — 文档地图：全部文档按意图导航 + 写文档约定
3. [docs/reference/agentdev-claw-product-overview.md](docs/reference/agentdev-claw-product-overview.md) — 产品总览
4. [docs/reference/glossary.md](docs/reference/glossary.md) — 领域词汇表：术语 + Avoid 负面清单，改代码前先对齐用词
5. [docs/reference/dev-context-index.md](docs/reference/dev-context-index.md) — AgentDev 框架与 Claw 的跨仓库连接关系速查
6. 涉及前端 UI 渲染、workspace 切换、数据加载时序 → 必读 [docs/reference/frontend-rendering-patterns.md](docs/reference/frontend-rendering-patterns.md)
7. 修改前端样式、新增 UI 控件 → 必读 [docs/reference/design-system.md](docs/reference/design-system.md)：视觉配方清单与节奏表，先复用既有配方，禁止自造同类控件
8. 架构决策记录（ADR），改动相关领域前先读对应篇（[docs/adr/](docs/adr/)）：
   - 0001 导出面治理：Runtime 双类型拆分与按引用导出
   - 0002 Session Continuity as Transformation：会话接续的框架化原则
   - 0003 AgentDev 包结构破坏性拆分：无伞包、core 零重依赖
   - 0004 ACP 适配器外置为独立 stdio 进程
   - 0005 工具终止语义：中断即结果
   - 0006 本地显式资源寻址优先
   - 0007 Capability Registry as the Unified Control Plane
   - 0008 远程 Claw 连接架构
   - 0009 模型热切换框架 API：资产归应用层，状态由 agent 自持
   - 0010 侧栏统一投影：工作空间 → 项目目录 → 运行中会话，连接不产生侧栏层级；修订一：托管 runtime 归属先于 Viewer 可见性（子进程注册前 IPC 握手 runtime-identity，服务端记录后 ack；查询在元数据加载后取归属快照）
   - 0011 ProtoClaw 远程写适配
   - 0012 远程会话历史统一呈现
   - 0013 消息轮询的增量探测：probe + tail
   - 0014 会话导航事务：导航生命周期的统一封装（Proposed）
   - 0015 内嵌浏览器 viewer：浏览器所有权翻转（Archived，调查完成暂不实施）
   - 0016 用户数据存储分区治理与 feature 持久资产收敛
   - 0017 Feature Manifest v2 与宿主侧 Feature Registry
   - 0018 Feature-Panel 通信基座：feature-comms 通道
   - 0019 轮次挂起语义：suspended 与 pending-work 事实层（实施计划见 [docs/plans/2026-09-27-turn-suspension-semantics.md](docs/plans/2026-09-27-turn-suspension-semantics.md)）
   - 0020 Feature 配置累加型多值字段的跨层叠加
   - 0021 状态机统一内核 state-kernel（框架 core 纯函数转换求值器，WorkThread / CallArbiter 先行迁移；实施计划见 [docs/plans/2026-10-06-state-kernel-implementation.md](docs/plans/2026-10-06-state-kernel-implementation.md)）
   - 0022 Agent Studio Feature-First 模式：feature 一级实体、目录降级为运行环境、会话多对多绑定（实施记录见 [docs/plans/2026-10-07-agent-studio-feature-first-refactor.md](docs/plans/2026-10-07-agent-studio-feature-first-refactor.md)）
   - 0023 工具调用历史改写：工具自声明生效调用、框架零语义判断、双视图与单轨快照（实施计划见 [docs/plans/2026-10-07-tool-call-history-rewrite.md](docs/plans/2026-10-07-tool-call-history-rewrite.md)）
   - 0024 APP 型工作空间：业务单对话、WorkThread 可选连续性与接续硬切换视图（实施计划见 [docs/plans/2026-10-10-app-workspace-eternal-thread.md](docs/plans/2026-10-10-app-workspace-eternal-thread.md)）
   - 0025 coder 升格独立工作空间：会话身份投影机制退役（实施计划见 [docs/plans/2026-10-11-coder-workspace-promotion.md](docs/plans/2026-10-11-coder-workspace-promotion.md)）
   - 0026 Session 视图统一：Session 身份为锚，Runtime 为运行态数据源，Thread 为连续性与输入控制投影
   - 0027 Agent OS 治理面：同意模型与 per-workspace 线程配额；修订一：计数改非终态线程数（未归档占名额，归档释放），权限项 `maxLiveThreads`（原 `maxLiveRuntimes` 不迁移），强制点迁至建线入口前置检查（会话落盘之前，实现 `server/routes/thread-quota.js`），spawn 闸与 rotation 豁免（spawnIntent）退役；权限模型独立后行
   - 0028 凭证失效恢复与分层判据：llm auth 错误语义 + core setModel 恢复编排，LLM 实例=参数快照、凭证轮换=实例轮换；修订一：凭证变更（重登/换 key/连接字段变更）server 主动广播 refresh-credentials，运行中会话同 preset 重 resolve（旧凭证仍有效时无 401 可触发反应式恢复）；修订二：存量 OpenCode preset（无 catalogProvider 标记、providerName 为 'OpenCode Go/Zen'）resolver 读时归一到登录凭证（与前端归类口径对齐）+ opencode 路径自动注入 x-opencode-session（go tier 端点强制要求）
   - 0029 模型调用超时治理：对话默认首段（首 token）120s / chunk 间隔 60s idle / 5 次重试，transform 预算 600s 经装配层实例分离，undici headersTimeout / bodyTimeout 双锚 TRANSFORM_MODEL_TIMEOUT_MS（保底层垫在最大可配预算之下），preset 级 timeoutMs/maxRetries 逃生门（timeoutMs 显式值管首段与间隔两段）
   - 0030 OS 通知投递面：统一出口、通知权限项与应用承接（notifications.* 权限族往 PERMISSION_ITEMS 加项；editingSurface 挂账落地、全局设置通知项只读审计；server 投递闸 + SSE app-notification + 前端哑呈现器；不建 OS 定时器服务）
   - [0031 后台工作的薄接入层与领域 Shell 的独立组合](docs/adr/0031-background-work-and-domain-shell.md)（代码已实施，在线冒烟待执行）：执行关联、`BackgroundAccess` / Bash 迁移、Coder 非阻塞监视、领域 Bash 基座（`local-features/capability-shell/src/bash-program.ts` / `bash-runtime.ts`，`just-bash` AST 预检与解释执行，支持变量/循环/条件，展开后再校验领域参数）与 Claw 面板协议接入已落地；Bash 语法不开放系统命令，`send` 返回提交回执后循环继续，`watch` 待命只在整次调用返回后生效；复用 pending-work / suspended，监控策略归领域，不建设脚本挂起续跑；[实施方案](docs/plans/2026-10-21-background-work-and-coder-monitoring.md)
   - 0032 编程小助手线程驱动：对话身份从 Session 提升为 Thread（048–051 已实施）：`threadHost` 声明接入（目录/项目对话一并覆盖，与 projectId 正交）；手动 `/trim` `/summary` 改对话内 succession 事务（自动接续后话）；列表行=对话、历史以时间锚存档呈现（不用「代」）；存量迁移按 index 血缘建线，歧义分量跳过，备份+预览+幂等；服务启动自动执行，失败告警不阻断；本机真实数据已迁移并验收；移动对话=整链移动；不声明线程配额；搜索 Thread 聚合独立后续（052；工单 048–052 见 [docs/tickets/2026-10-24-ph-thread-driven.md](docs/tickets/2026-10-24-ph-thread-driven.md)）
   - [0034 模型选择 Feature 化](docs/adr/0034-feature-owned-model-selection.md)（Proposed）：Feature 持有选择与恢复策略，Agent 持有实际模型，Claw 管资产与通信；选择是链级当前状态——重启/接续保留、分支继承源对话当前选择（非边界快照历史值）、回滚不撤销；恢复失败提示并回退全局默认；远程会话不保持模型切换，入口降级不可操作。[文件级实施方案已闭环](docs/plans/2026-10-28-model-selection-feature-implementation.md)，尚未实施。

实现层真实入口：

- 服务端：[server.js](server.js)（路由按域分文件于 `server/routes/`）
- 前端壳层：[public/index.html](public/index.html)（瘦壳）→ [public/src/app-core.js](public/src/app-core.js) / [app-ui.js](public/src/app-ui.js) / [app-main.js](public/src/app-main.js) + `public/src/modules/`
- 预制 agent runtime 宿主：[scripts/run-prebuilt-agent.js](scripts/run-prebuilt-agent.js)
- 编程小助手：[prebuilt-agents/official/programming-helper/agent.js](prebuilt-agents/official/programming-helper/agent.js)
- IM 门户代理：[prebuilt-agents/official/qqbot/agent.js](prebuilt-agents/official/qqbot/agent.js)
- 群聊管理员工具集：[local-features/group-admin](local-features/group-admin)
- 运行时信封：[server/runtime-call-envelope.js](server/runtime-call-envelope.js)
- 桌面壳（Tauri，2a 渲染 + 2b sidecar 生命周期切片已验收）：[desktop/](desktop)，宿主契约见 [docs/protocols/service-lifecycle.md](docs/protocols/service-lifecycle.md)。Windows 右键目录空白处「在编程小助手中打开/创建会话」：注册表项由 [desktop/installer-hooks.nsh](desktop/installer-hooks.nsh) 安装时写入 HKCU，参数链路 exe argv（`--claw-open`/`--claw-new-chat`）→ 冷启动窗口 URL query / 已运行实例 webview eval → 前端 [public/src/modules/desktop-open.js](public/src/modules/desktop-open.js) 统一消费，三处参数键名需同步修改。钩子里 exe 必须引用 NSIS 模板变量 `${MAINBINARYNAME}`（实际二进制名来自 Cargo package name，与 productName 不同；硬编码 productName 会指向不存在的文件、点击菜单静默无反应），菜单图标直接引用 exe 内嵌 logo，无需分发独立 ico

## 项目定位

`AgentDevClaw` 是以 Agent 为中心的可扩展工作台，整合配置、会话、调度、协作。当前活跃维护的工作空间：

- **编程小助手**（`programming-helper`）★ — 对标 Claude Code 的 AI 编程 Agent，浏览器可视化交互层
- **Coder**（`coder`）★ — 无人值守自主编码 APP：线程化执行，仅调度面创建（[ADR-0025](docs/adr/0025-coder-workspace-promotion.md)）
- **Agent Studio**（`agent-studio`）★ — 上游制造端：对话中开发 Feature、装配 Agent，经 Test Runtime 验证闭环
- **IM 渠道**（`qqbot`）★ — 多渠道消息门户代理与路由（QQ / 微信 / 企业微信 / 飞书等）
- **工作群**（`work-group`，Beta）— 群聊形式指挥与协调多 Agent
- **Memo 智能备忘录**（`memo`，壳）— 备忘录 APP：首页内容门户 + 唯一活动线程承接连续对话，新建对话即换代归档（ADR-0024）

预制 agent 完整清单以 `prebuilt-agents/official/*/metadata.json` 为准；已下线（隐藏但按 ID 可寻址，清单在 `HIDDEN_PREBUILT_AGENT_IDS`）的工作空间：`flow-workspace`、`feature-creator`、`agent-creator`、`feature-repository`、`dispatch-console`、`flow-test`，代码保留但不再积极迭代；涉及这些区域时以"读懂现有代码、不引入新复杂度"为原则。

全局 Feature 参数配置已并入前端设置菜单（多作用域三态编辑器），不再是独立工作空间。

工作空间内 Agent 通过 `metadata.agents` / `defaultAgentId` 声明名字，`agent.js` 的 `agents` 导出声明装配；会话索引 `workspaceAgentId` 固定绑定，恢复、分支及接续继承。欢迎页显示当前会话 Agent 名，不用工作空间名或标题猜测；该字段不参与 OS 寻址与侧栏层级，也不同于群聊 `identities[]`。权威契约见 [工作空间内 Agent 声明与会话绑定](docs/protocols/workspace-agents.md)。

## 启动与依赖模式

`npm install` → `npm run build` → `npm start` 三段式。`npm start` 经宿主 [scripts/run-supervised.js](scripts/run-supervised.js) 托管 server.js：宿主持有进程裁决权（优雅窗口后收割整棵进程树，杜绝 Ctrl+C 后端口残留），server 侧配套 stdin watchdog 与启动端口自愈，契约见 [docs/protocols/service-lifecycle.md](docs/protocols/service-lifecycle.md)。build 与 prestart 都按 package.json 中 `@agentdevjs/*` 依赖声明形态自动分流：

| 形态 | package.json 声明 | node_modules | build 行为 |
|---|---|---|---|
| 开发态 | `file:../AgentDev/packages/<name>` | npm install 物化为 junction，指向相邻框架仓库 | 校验/修复链接 → 构建框架仓库（若相邻存在）→ local-features → features |
| 发布态 | semver（如 `^0.1.0`） | npm registry 正式包，自带 dist | 跳过链接与框架构建，只做 local-features → features |

两个切换脚本均为"切换即就绪"（改声明 / 链接后自动完成 install + build），语义不对称（易错）：

- `npm run agentdev:published` — 改写依赖声明（`file:` → semver），目标版本取 npm registry 各包最新发布版（离线/未发布时回退读相邻仓库并明示日志，`--version` 可显式指定），并同步 features/ 子包的 core devDependency 到框架版本，随后摘除 `@agentdevjs/*` 残留链接、install + build、自检安装形态。版本更新后跑一次即可整体对齐。
- `npm run agentdev:local` — **不改声明**，只把相邻 AgentDev 仓库的包以 junction 链接进 `node_modules/@agentdevjs/`，并自动补建缺失的框架 dist。用于发布态下临时调试本地框架源码。注意：npm install **不会**替换"恰好满足声明"的链接（链接目标版本匹配 exact pin 即视为已安装），调试完必须经 `agentdev:published` 脱链（它会先摘链接再装 registry）。

与两形态平行的第三条路：`npm run pack:desktop` 组装桌面发布树 `dist/desktop-staging/`（框架包 vendor tgz 实体安装 + bundled node，自带实体自检与隔离端口冒烟），是 tauri bundler 的输入，不影响本机开发形态。

开发态硬约束：`node_modules/@agentdevjs/*` 必须是链接而非实体拷贝。发布态硬约束：反向成立，必须是 registry 实体目录。`check-agentdev-local`（prestart / build / `check:agentdev` 共用）按声明形态校验安装形态——开发态校验链接（含失效与错向目标），相邻框架仓库可用时自动重建；发布态发现本地链接 / 缺失 / dist 过期只报错并给出修复命令，**绝不自动改链**。形态不一致若不拦截，服务会静默跑在与声明脱节的框架版本上，只在运行期以 "framework too old" 一类错误暴露（历史事故：模型热切换、陈旧本地链接）。

features/ 下被预制 agent 源码引用的子包（清单在 `scripts/prebuilt-feature-dirs.mjs`，build:features 与 prestart 过时检测共用）对 core 的声明固定为 semver；构建时若相邻框架 core 可用（`dist/index.d.ts` 存在，缺失会自动编译）则按版本守卫分流——根声明为开发态时直接替换为本地 junction（使用未发布框架 API 的子包因此可构建）；发布态下仅当相邻 core 版本高于子包声明版本时才替换（本地落后或持平则保持 registry，避免陈旧本地副本劫持子包的 core 解析、与根安装分叉成两份副本）。不要手动改子包声明来切换形态。

预制 agent 一旦以源码路径静态导入 `features/<name>/dist/index.js`，必须同步把 `<name>` 登记进 [scripts/prebuilt-feature-dirs.mjs](scripts/prebuilt-feature-dirs.mjs)——该清单同时驱动 build:features、prestart 过时检测、`pack:desktop` 与 `agentdev:published`，桌面包只构建清单内的包。漏登记在开发机无感（本地已构建过 dist），打出的桌面包里 runtime 加载 agent.js 即崩、新旧会话全灭（历史事故：stylized-output）。`local-features/` 整树构建、生态包走 vendor/registry 链路，均无需登记。

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

分层判据（ADR-0028）：契约/语义/生命周期编排归框架；资产保管与 IO 实现归应用层；宿主/装配层够不着是下沉信号（普通代码复用不算）；其余先留应用层。LLM 实例=参数快照，凭证轮换=实例轮换——认证策略的复杂度收敛在 resolver 实现与 token 管理，框架不感知凭证形态。

禁止的做法：

- 把框架或生态包修复只留在 Claw 侧 `node_modules/@agentdevjs/*`（会被安装冲掉，不回流源码）
- 混淆三类 feature 来源；开发流程中手工 pack / 拷贝 tgz
- 用 `npm link` 做本地链接（会触发依赖树 prune）；需要的是文件系统 junction，用 `agentdev:local`

历史注：ADR-0003 四包拆分后，框架内 `src/features/*` 生态副本已删除，生态 feature 唯一权威源码在 `AgentDev/packages/<name>/`。若见从 `@agentdevjs/core` 导入生态 feature 符号，属待清理残留。

## 系统总览

**服务端**（[server.js](server.js)）：托管 ViewerWorker、扫描 `prebuilt-agents/`、管理预制 agent runtime 与会话切换、代理前端到 ViewerWorker 的请求、提供 ProtoClaw API。路由按域分文件于 `server/routes/*.js`（会话与上下文连续性、IM 线路与渠道、调度、群聊、模型配置、capability、feature 配置、workspace 管理、ACP、git、feature 仓库等大类），具体接口以各路由文件的 `app.<method>` 注册为准。

**前端壳层**：`public/index.html` 只是瘦壳。主逻辑在 `app-core.js`（常量 / i18n / 公共底座）、`app-ui.js`（workspace surface 渲染骨架与 block 分发）、`app-main.js`（agent 切换与轮询主循环），功能域在 `modules/` 下分模块。`renderCurrentMainView()` 是主视图状态机入口，多数 workspace 问题最终回到这里。右侧 rail 面板统一经宿主注册表（`modules/right-panel-registry.js`，`window.ClawPanels`）声明适用上下文（surface / agentIds）与 i18n 元数据，rail 可见性与自定义清单都从注册表派生，不维护平行清单（详见 frontend-rendering-patterns.md §12b）。

**预制 agent runtime**（[scripts/run-prebuilt-agent.js](scripts/run-prebuilt-agent.js)）：动态加载 `prebuilt-agents/*/*/agent.js`、挂到本地 ViewerWorker、管理会话恢复与附加启动逻辑（如 IM gateway）。会话数据落在用户目录 `~/.agentdev/AgentDevClaw/prebuilt-sessions/<agentId>`，不污染仓库。`metadata.json` 的 `ui` 声明（entry / tabs / home blocks）是首页 block 渲染的基础壳能力。

**本地 feature**（[local-features](local-features)）：顶层 `index.ts` barrel 聚合导出。活跃域：dispatch（调度）、group-admin（群聊管理）、checkpoint、context-compaction-mirror / context-guard（上下文精简与守卫）、continuity-participant（连续性参与方）、conversation-export（对话导出）、conversation-annotations（会话标注：用户在对话消息上选中文本创建高亮标注，前端 `modules/annotations.js` 经 ADR-0018 annotations 通道读写；存储走框架快照契约——feature 只持内存态，restoreState 实现按消息边界合并（回滚只删目标消息已消失的标注），declareContinuity 透传随 trim/branch 流转；宿主 `run-prebuilt-agent.js` 在 onHostRequest 成功后去抖补存；挂载于编程小助手）、time-awareness（时间感知：按节奏注入系统时间与长间隔提示，节奏可装配覆盖——memo 传 reportIntervalMs: 0 每次 call 都注入，状态经框架会话快照持久化）、craft-awareness（工程素养：条目化动态写法知识库，每会话每条目一次；条目一：首次写出成规模文档后注入读者视角写法标准，条目二：同一文档修改跨越两个用户输入边界——以 context 中最近一条用户消息为界，含 busy 排队插话——后的编辑注入协作/交付阶段判断；测试文件按文件名模式识别成功 write/edit，同文件持续修改时依次注入行为契约、辨别能力、验证交付；后两层限定 edit，模型在同一用户输入内的修改也可推进，文件进度与条目冷却随快照恢复；注入文案外置于 feature 的 knowledge/ 目录，md 维护，触发规则见 `local-features/craft-awareness/src/index.ts`；同时是 grill-me 技能载具——设计树拷问访谈，随 feature 的 skills/ 目录经 collectFeatureSkills 投递，挂载于编程小助手）、claw-help（使用帮助技能载具：`agentdevclaw-help` 技能经 collectFeatureSkills 投递，面向终端用户的使用问答——模型 / MCP / 技能配置、界面导览、上下文接续、故障排查、源码参与引导；挂载于编程小助手，路由与事实速查见 `local-features/claw-help/skills/agentdevclaw-help/SKILL.md`，界面入口与机制事实随 UI 演进需同步维护）、feature-wrappers（框架 feature 的 Claw 协议薄包装，含后台任务实时面板镜像 PanelShellFeature，ADR-0018 首个通道接入）、agent-studio、generative-ui、github、agent-dev、memo-notes（memo 便签存储：runtime 侧工具面 + server 侧首页便签墙数据面）。`flow` 与 `feature-dev` 已悬置。

app-core.js 全局状态纪律：全局状态区只减不增。新增前端状态放所属 modules 文件的局部作用域；确需跨模块共享用 `window.ClawFW` 命名空间。

## 当前工作空间

### 编程小助手（programming-helper）★

入口 `prebuilt-agents/official/programming-helper/`。用户交互式编程 Agent：Shell / Web 搜索 / MCP 完整工具链（LSP 与 Playwright 浏览器为官方可选插件，在设置里装配），会话分支、trim / compact / summary 精简、checkpoint / rollback、AI 标题、语音输入。

目录与项目：目录决定工作位置，项目提供稳定的对话与配置归属；默认项是目录对话集合，不是项目实体。两种归属共用对话操作，项目按绑定目录导航但不以目录为身份；项目链不继承目录配置，同路径不隔离工作文件。关键入口：`server/routes/ph-projects.js`（项目存储、生命周期与会话归属转移 `sessions_move`）、`server/shared/session-project.js`（有效运行目录）、`public/src/modules/project-data.js` / `session-list-render.js` / `ph-project-actions.js`（归属导航）/ `ph-session-move.js`（对话整理弹窗与多选）。项目会话仍是普通 Session，不自动线程化；线程驱动改造（对话身份升级为 Thread）计划已确认，见 [ADR-0032](docs/adr/0032-programming-helper-thread-driven.md)。概念边界见 [CONTEXT.md](CONTEXT.md) 的“编程小助手的对话归属”。

### Coder（coder）★

入口 `prebuilt-agents/official/coder/`（`agent.js` + `metadata.json`，`host: programming-helper` / `visibility: on-demand`）。无人值守自主编码 APP（[ADR-0025](docs/adr/0025-coder-workspace-promotion.md)，升格自原编程小助手的 coder 身份，旧数据经服务端启动搬移模块 [server/routes/coder-identity-retirement.js](server/routes/coder-identity-retirement.js) 迁入 `workspaces/coder/`）。配置层 `workspaces/coder/feature-config/agent.json`（`readAgentLayer('coder')`）。关键行为：线程宿主（自动建 WorkThread，`workspaceId=coder`，上下文过阈值自动接力）；接续策略声明驱动三选一（自适应 / 纯 trim / 纯摘要，`metadata.json` 权限项 `contextRotationStrategy` + `permissionDefaults: adaptive`，智能编码空间设置窗 Coder 策略分页配置，`rotate()` 时现读即时生效；未声明宿主维持组合语义，实现见 [docs/plans/2026-10-18-coder-adaptive-rotation.md](docs/plans/2026-10-18-coder-adaptive-rotation.md)）；只能由调度面创建（ACP / `claw threads` / claw-coder-dispatch 技能），用户不能在 UI 直接创建；Web UI 左侧 coder 入口（紧随智能编码空间，同在工具与效率组）是其线程列表投影，on-demand 可见性由服务端合流（有存活且绑定 Session 的 Runtime，或 rotating 接续挡板在途，删除事务窗口内除外，见 `hasRunningSessions`；未归档线程资产不撑入口，ADR-0025 2026-10-18 回摆；+ 用户覆盖，设置 → 工作空间，见 [server/routes/workspace-settings.js](server/routes/workspace-settings.js)）；线程归档是生命周期事务（执行中归档直接打断当前轮并收纳，任何状态不拒绝归档；已归档拒绝新指令）。会话身份投影机制（sessionType 寻址、sidebar_entry_id 会话级身份）已退役：coder 会话直接以 `agentId=coder` 寻址。

### Agent Studio（agent-studio）★

feature-first 工作空间（[ADR-0022](docs/adr/0022-agent-studio-feature-first-model.md)）：feature 是唯一一级实体，会话绑定 feature（`studioFeatureIds` 多对多，`studio_create_feature` / `studio_add_feature` 自动回写），目录只是会话运行环境（一个目录可开发多个 feature）。feature 状态与验证账本在全局注册表 `~/.agentdev/AgentDevClaw/workspaces/agent-studio/features.json`；目录内 `agent-studio.json`（schema 5）只是环境清单（工具链 / 测试 / agent 登记），懒创建，无「初始化」步骤。

Feature 包元数据契约（Claw 所有，勿回流框架仓库）：`studio_create_feature` 强制填写 `package.json.agentdev`（Manifest v2：id / displayName / type / capabilities / provides / depends / requirements / rollback），仓库浏览与详情展示按此渲染；缺 v2 时才回退按包名推断（`server/routes/feature-repository.js`）。权威说明见 `agent-studio-workflow` 技能 `references/feature-package-metadata.md`。首页 Feature 详情是弹窗（overlay 内嵌 home 视图），不是独立页面。

dev agent 只做控制面（`studio_*` 工具集），被测 Feature 跑在隔离的 Test Runtime 子进程（[scripts/run-studio-runtime.js](scripts/run-studio-runtime.js)，feature 清单经 env `STUDIO_FEATURES_JSON` 由父进程下发），以 `studio-sandbox:<目录名>` 出现在左侧 Agent 列表（可看不可输入）。两种模式：`feature-harness`（最小 Agent + 开发中 Feature）与 `agent-debug`（真实 Agent + 仓库 tgz 底座 + 开发源码覆盖）。Feature 状态机由运行证据推进（`implemented → mounted → verified → snapshotted`）；验证通过经快照打成不可变 tgz 写入用户 Feature 仓库（同版本不同字节会被拒绝）。

dev agent 注入技能：`agent-studio-workflow`（权威工作流）+ `agentdev-feature-guide` / `agentdev-feature-packaging`（权威源在框架仓库，经 `npm run adv-docs:sync` 同步，勿直接改 Claw 副本）+ `agentdev-agent-assembly`（本地维护）。

同步规则（易错）：新增 / 改名 `studio_*` 工具、调整状态机或会话策略时，必须同步更新 `local-features/agent-studio/skills/agent-studio-workflow/SKILL.md` 与 `prebuilt-agents/official/agent-studio/.agentdev/prompts/system.md`（两处都注入给 dev agent）。

### IM 渠道（qqbot）★

多渠道消息接入与路由（渠道包以 agent.js imports 为准）。`IMOperatorFeature` 提供接线员工具（`im_overview` / `im_browse` / `im_connect_line` / `im_disconnect_line`）；线路到工作空间会话的动态路由与转接；`CallArbiter` 统一并发调用仲裁；开机自启动与渠道配置面板。

配置文件：`.agentdev/qqbot.config.json`、`.agentdev/weixin-bot.config.json`、`.agentdev/im-workspace.config.json`。

### 工作群（work-group）★ Beta

多 Agent 协作群聊：群聊创建、Agent 身份分配、`@mention` 派发任务、管理员协调与上下文重建。工具集在 [local-features/group-admin](local-features/group-admin)。

### Memo（memo）壳

入口 `prebuilt-agents/official/memo/`。备忘录 APP，APP 型工作空间的第一个实体（[ADR-0024](docs/adr/0024-app-workspace-eternal-thread-model.md)）：首页是内容门户（hero 按钮承载「开始/新建对话」，action type `start_app_conversation`，服务端端点由 block 声明携带，公共分发器不按 APP ID 分支），对话从侧栏会话栏点开（叶子 = runtime 投影，threadId 锚点击）。空壳装配：UserInputFeature + ContextRotationTriggerFeature（与 coder 同构的阈值触发接续）；TimeAwarenessFeature 以每次输入注入的细粒度节奏装配（默认 4 小时节奏对提醒的相对时间解析太粗）。

- 唯一活动线程是 memo 的业务状态，权威持有方在服务端 [server/routes/memo-app.js](server/routes/memo-app.js)（start/new 事务经 in-flight 互斥串行；创建链失败回滚与 ACP 原子创建同构；新建换代 = 先落新引用再 best-effort 归档旧线程），状态文件 `workspaces/memo/app-state.json`
- runtime 按需拉起：首开经首页「开始对话」事务（有活动线程恢复其 head，无则空会话等首条消息）；`/threads/:id/input` 的 `ensureHeadRuntime` 唤起闸共用
- 线程宿主判定声明化：APP metadata 声明 `threadHost: true`，宿主启动按发现结果注册进 [host-agents.js](server/thread-control/host-agents.js) 派生集合（可拔插约束：公共代码不按 APP ID 硬编码）；测试用 `registerThreadHostAgents` 构造场景
- 工作空间形态由 metadata `kind: "workspace"` 声明驱动：前端 `isWorkspaceHostUnit` 读 kind，点开进首页、不经 start_agent 拉起 runtime（纯 UI 壳由 `launchMode: "ui-only"` 另行表达）。新工作空间只需正确声明 kind；未声明的 prebuilt 条目会走「无会话 start_agent 直接跳对话」的普通 agent 路径
- 线程宿主会话裁剪通用会话操作：slash /trim /summary 经命令 `applies` 谓词对线程宿主会话隐藏（线程事实驱动，coder 同口径）；ctx 会话操作菜单仍按 `CTX_SESSION_OPS_AGENTS` 白名单门控；精简页「归档原会话」勾选与分支归档意图（`archiveOriginal`）对线程宿主会话隐藏/钳制（`window.isThreadHostAgentId` 同口径——Session 归档语义在线程下只给链中旧快照打不可见标志），非线程会话（agent-studio）与远程透传契约不变

## Plain Agent 与 claw CLI

与 workspace / prebuilt agent 平行的第三种 agent 形态：不建工作空间、不依赖 Claw server，经全局命令 `claw` 直接调用。两种用途：轻量可组合装配（`agents/<name>/agent.js`）；无头审计载体（`--headless --format jsonl`，stdout 只承载结果数据，过程信息走 stderr）。

- 入口链路：[bin/claw.mjs](bin/claw.mjs) → [scripts/run-plain-agent.js](scripts/run-plain-agent.js)
- 内建 plain coder 已移除（与工作空间 coder 重复），`agents/` 以注册制为主（`claw agents register`）
- 完整用法（输出格式、jsonl 事件 schema、会话续接、落盘位置）见 [agents/README.md](agents/README.md)——修改 CLI 行为时必须同步更新该文档

## ACP 适配层

独立 stdio 进程（`claw acp coder`），只做协议转换与本机 HTTP 调用，执行权威留在 Claw server。设计见 [docs/plans/coder-acp-adapter-design.md](docs/plans/coder-acp-adapter-design.md) 与 ADR-0004。适配器改动只需新起子进程；server 路由改动需要重启整个 Claw 服务。

## Agent 制造 → 消费链路（agent-studio → claw CLI）

上游 agent-studio 制造 Feature 与 Agent，下游 `claw` CLI / plain agent runner 消费。"Studio 验证过的装配 = 消费端运行的装配"由共享解析链保证，`claw run`（release / debug）、Studio agent-debug 模式、server 侧共用：

`server/feature-runtime/`：`schemas.js`（校验，release 与注册时强制精确版本）→ `catalog.js`（扫描官方 `resources/features/` 与用户 `user-features/` 两个 tgz 仓库，同版本用户优先）→ `resolver.js`（release 全解析为 tgz；debug 允许 Studio 同名包源码覆盖）→ `provisioner.js`（内容寻址环境，依赖不变复用）→ `loader.js`（拓扑排序 mountFeature，重名 / 环 / 缺依赖直接报错）。

Studio 落盘布局与运行记录：目录环境清单 `agent-studio.json` + `.agent-studio/`（runs / runtime-sessions / runtime-plan），feature 注册表与工作空间状态在 `~/.agentdev/AgentDevClaw/workspaces/agent-studio/`。旧「项目」数据（projects.json + schema ≤ 4 档案）由服务启动迁移一次性换算（[server/routes/studio-feature-migration.js](server/routes/studio-feature-migration.js)，幂等）。

## 关键数据流

**编程小助手会话生命周期**：用户选项目目录新建对话 → 服务端创建 session 绑定 `cwd` → Agent 经工具执行需求 → 用户可分支 / 精简 / checkpoint 管理。

**IM 消息路由**：IM 平台消息 → qqbot 门户代理 → 接线员按通道配置路由到工作空间会话 → 目标 Agent 处理 → 回复经接线员传回 IM 平台。

**会话管理**：分支 = 从指定消息节点创建新会话；精简 = 裁剪早期历史（Trim）或压缩为摘要（Compact）；checkpoint / rollback = 保存与恢复会话状态。

**Feature-Panel 实时通信**（[ADR-0018](docs/adr/0018-feature-panel-communication-transport.md)）：运行时 Feature 声明通道（四元组 agentId/sessionId/featureId/channelId）→ 事件镜像到 server 内存 store → 面板经专用 SSE 订阅渲染；反向定向请求（list/status/kill 类）走 `/protoclaw/feature-comms/request` → runtime IPC → `onHostRequest`。首个接入：后台任务面板（`feature-wrappers` 的 `PanelShellFeature`——继承 ShellFeature、通道 featureId=`shell`——+ `modules/bg-panel.js`）。

## 会话连续性三层模型

Claw 不自带连续性引擎，全部消费 `@agentdevjs/core`。权威设计与决策记录：[ADR-0002](docs/adr/0002-session-continuity-as-transformation.md)。

三层概念：

- **Session**：会话快照与 SuccessorSeed（变换产物），落盘为 handoff 包
- **Transformation**：官方变换（Trim / Summary / 组合），LLM 经 `TransformContext.llm` 进程内注入
- **WorkThread**：线程状态机与看板，替代 Claw 原线程控制

Claw 装配点索引：trim 引擎与落盘在 `server/context-continuity/`（handoff-package / trim-appended-summary / inprocess-summary，`resolveSummaryLLM` 供各装配层共用；自适应接续编排在 adaptive-rotation.js——试探 trim 定档三路分派，产品层验证，验证后视结果下沉框架）；seed feature 由 `scripts/run-prebuilt-agent.js` 与 `run-one-shot-agent.js` 装配；连续性字段经 [local-features/continuity-participant](local-features/continuity-participant)（读旧写新，协议保留 `claw.*` 命名空间）；线程控制在 `server/thread-control/` 模块族，数据目录全局 `~/.agentdev/AgentDevClaw/threads/`，状态 × 事件矩阵与测试锚见 [docs/reference/thread-state-matrix.md](docs/reference/thread-state-matrix.md)；线程宿主判定为 APP 级（`agentId=coder`，判定入口 `thread-integration.js` 的 `isThreadHostApp()`）。

易错：

- trim + summary 组合语义以框架 `TrimTranscriptWithSummaryTransformation` 为唯一权威（thread 接力与手动精简共用），不要在 Claw 侧另写组合逻辑
- 旧 thread record 的 `executionEvents` / `mode` 字段为惰性数据，看板事件从 `boards/` 重新累积

## 统一日志契约

两套日志系统的边界（改动日志相关代码前必读）：

- **agent 运行时内部**（feature / agent.js 装配层）→ `createLogger()` → DebugHub → Web UI。ESLint `no-console: error`（存量文件在 ratchet 清单降 warn）。绕过 logger 直接 console.log 会丢等级与命名空间。
- **非 agent 运行**（server.js 进程、scripts/、bin/）→ console / stdio，推荐 [server/shared/claw-logger.js](server/shared/claw-logger.js)
- **前端 public/** → 浏览器 console，不在约束范围
- **崩溃取证**：`logs/supervisor.log` 的 `child exited` 行携带 pid/uptime（与 V8 OOM dump 头部 `[pid:…] uptime_ms` 同构，可直接对表归因到哪一代实例）；server 每 30s（`CLAW_MEM_SAMPLE_MS=0` 关闭）采样自身内存与常驻计数到 `logs/memory-samples.jsonl`（5MB 轮转 .1 备份，实现 [server/shared/memory-diagnostics.js](server/shared/memory-diagnostics.js)）。OOM 崩溃后重启，凭 dump pid + 这两份文件即可还原崩溃前的增长轨迹

stdio 分流（CLI 审计接口）：所有日志必须带等级；`AGENTDEV_LOG_STREAM=auto` 时 trace / debug / info → stdout、warn / error → stderr；无头模式全量 → stderr，stdout 只承载结果协议行（`ONE_SHOT_RESULT:` 等）。

会话事件流：无头 stdout 的数据形态是 codex exec 风格 JSONL 事件（`thread.started` / `turn.*` / `item.*`），与运行日志严格分离。框架实现 `AgentDev/src/core/session-events.ts`，Claw 渲染 [scripts/headless-session-renderer.js](scripts/headless-session-renderer.js)。

易错：无头入口必须以 `import './headless-log-preamble.js'` 作为**第一个 import**（静态 import 会提升，模块体内再设 env 已太晚；preamble 严禁依赖框架包——core 依赖图含 top-level await）。无 ViewerWorker 连接时框架日志自动 fallback stdio，审计不丢失。

框架日志实现在 `AgentDev/src/core/logging.ts`，改动后需框架仓库 build 并重启整个 Claw 服务。ESLint 边界与 ratchet 清单在 [eslint.config.js](eslint.config.js) 末尾。

## 前端两套渲染管线（易错）

- **端口 1420：Claw 主前端**（用户日常看到）— `public/src/*`，静态文件不需编译，改后重启 Claw 服务生效
- **端口 2026：DebugHub Viewer**（框架侧）— `AgentDev/src/core/viewer-html.ts` + `viewer-worker.ts`，改后需框架 build + 重启

改错管线 = 白改。渲染契约、去重策略与自检清单见 [docs/reference/frontend-rendering-patterns.md](docs/reference/frontend-rendering-patterns.md)。工具调用/结果卡片的宿主壳层（分层标题/正文、玻璃底色、长内容折叠）与 Feature 模板的内容层契约见 [docs/protocols/tool-rendering.md](docs/protocols/tool-rendering.md)。

Inspector 数据流：Agent `buildHookInspectorSnapshot()` → IPC → ViewerWorker → API → Claw 前端 `normalizeHookInspector()`（[modules/overview-data.js](public/src/modules/overview-data.js)）→ `renderFeaturesPanel()`。陷阱：`normalizeHookInspector` 存在于两处（Claw 前端 + 框架 `viewer-html.ts`），新增 inspector snapshot 字段必须同时更新两处，否则字段在重构时被丢弃（历史上踩过）。

## 会话切换与异步渲染不变量

详见 [docs/reference/frontend-rendering-patterns.md](docs/reference/frontend-rendering-patterns.md)。三条最易踩：

1. `getRuntimeContextKey` 不稳定（依赖异步更新的 `allAgents`），只能作 cache key，不能作 stale check；stale check 只用同步设置的 `currentRuntimeAgentId`
2. 切换不依赖服务端 current 状态：`switchAgent` 先乐观渲染再 `loadAgentData`，所有 URL 用显式 `agentId`；焦点只持久化到 `localStorage`
3. 前端 → agent 控制 IPC 优先用 `runtimeId` 定位；`allAgents` 缓存派生的 sessionId 会暂态错位，只能 fallback，且 server 禁止跨 session fallback 投递；前端必须检查 `payload.ok` 并回滚乐观态（参考 `todo_control`；模型切换已改走 feature-comms 请求面，ADR-0034）

## 侧栏统一投影（远程连接不可见）

侧栏唯一渲染模型：`工作空间 → 项目目录 → 运行中会话`（[ADR-0010](docs/adr/0010-sidebar-unified-projection.md)）。本地会话与远程会话在 `renderSidebarChildItems` 汇合成统一条目流（远程经 [modules/remote-connections.js](public/src/modules/remote-connections.js) 的 `getRemoteSidebarProjection`）；连接本身只作为寻址与状态元数据，不产生任何 UI 层级。

易错：

- 叶子 = 存活的 child runtime；prebuilt 历史会话索引不是叶子来源
- 身份归属是结构事实：prebuilt child 条目带 `sidebar_entry_id`（呈现归属 APP，缺席即父 APP），不再经 sessionType 推导（ADR-0025 退役会话身份投影）
- 数据源优先级：connected child 是主源；远程 `/api/agents` viewer 条目只补充不存在的 runtime，禁止覆盖身份/目录字段
- 组身份与折叠状态用 `projectKey`，`projectName` 只是呈现（远程为 `主机名：目录名`）
- 无选中运行时（停在 workspace surface）时高亮谓词直接判非；"解析归一化再比较"的兜底两侧都可能为空，空对空对称相等会全量误高亮（历史 bug，见 frontend-rendering-patterns.md §12a）
- 往返测试 `test/remote-sidebar-projection.test.js` 用真实聚合输出驱动真实前端投影，字段断链在测试层暴露

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

## import 循环依赖检查（ratchet）

`npm run check:cycles`（[scripts/check-import-cycles.mjs](scripts/check-import-cycles.mjs)）：扫描 server/、scripts/、prebuilt-agents/、local-features/、bin/ 的相对导入图，报告值级循环依赖（`import type` 不算边；动态 import 与 export-from 算边）。public/src 无静态 import 图（script 全局共享模式），不适用。存量环指纹固化在 [.import-cycles-baseline.json](.import-cycles-baseline.json)，`--update-baseline` 显式更新（修复存量环后应修剪），新增环 exit 1。

## 协作纪律（负面清单）

- 删除工具、feature、技能时，同步清理全部注入点（agent prompts、SKILL.md、本文件、i18n 文案、agents/README.md）的引用；活性文档指向已删除能力的链接一律清掉。
- 如实报告验证结果：未验证就说未验证，已有失败不得写成通过。
- 不用超时 / 重试掩盖同步问题；发现设计缺陷先对齐再动手，不通过增加兜底分支把问题盖住。

## 开发时的建议心智

进入实际开发前，先回答这些问题：

1. 这次改的是壳层（前端 JS）、预制 agent 装配（agent.js），还是 feature 实现？
2. 当前数据的真相在前端草稿、服务端 workspace state，还是 session index？
3. 当前行为是预制 agent 首页行为，还是运行时行为？
4. **用户看到的是哪个前端管线？** 面板显示 / inspector 渲染问题，先确认是 Claw 前端（`app-ui.js`，端口 1420）还是 DebugHub 查看器（`viewer-html.ts`，端口 2026）渲染的。改错管线 = 白改。
5. **stale check 依赖的全局变量在 `await` 期间会变吗？** `allAgents`、`focusedAgentId` 等会被 poll / `loadAgents()` 异步修改。stale check 只能用同步设置的 `currentRuntimeAgentId`。
6. 这次改动归属哪一层：框架本体 / 生态包 / Claw 本地 feature / 预制 agent 装配？（权威修改位置见"仓库边界"一节）
