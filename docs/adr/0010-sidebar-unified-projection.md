# 0010 — 侧栏统一投影：工作空间 → 项目目录 → 运行中会话

- **Status**: Accepted
- **Date**: 2026-08-27
- **来源**: R1 Phase 1 落地评审（2026-08-27）。首轮实现后用户对呈现范式做出关键纠正：远程连接不是、也永远不应是用户可见的侧栏层级；本 ADR 记录随之确立的投影模型。
- **关系**: 细化 [ADR-0008](0008-remote-claw-connection-architecture.md) Phase 1 的侧栏呈现层。0008 的远程权威 / 无状态透传 / SSH 隧道 / 命名空间决策全部不变。

## Context

R1 首轮实现暴露出三个对象模型错误，全部源于把"远程"当成侧栏的一等公民：

1. **连接层级入侵**：远程目录被渲染进独立的 `remote-agent-zone` DOM 区，用户先看到 `LAB-B`（连接别名），再看到 `Lab-B: agent-1-36456`（runtime 宿主 ID），最后才是会话。内部寻址信息直接成为用户可见分组名。
2. **宿主 agent 被误当工作空间**：runtime 的 `parent_id` 被用作项目组名。实际上宿主 ID 是寻址概念，不是用户认知概念。
3. **叶子身份错误**：早期版本用 prebuilt 会话索引制造叶子，runtime 与会话两层混叠；后续用 agent-ID fallback 注入伪条目，同一远程会话可能同时以 agent 条目和 runtime 条目出现两次。

用户的范式纠正非常明确：

> 基本延续本地心智，给人一种"只是额外打开了远程主机的目录"的感觉。

即远程目录与本地目录**同层并列**，归属同一工作空间入口；连接本身只存在于后台（寻址、断线状态、能力判定）。

## Decision

### 1. 侧栏唯一渲染模型：来源无关的三层投影

```text
Workspace（工作空间入口）
├── 直属运行中会话（无目录归属的 runtime）
└── ProjectGroup（项目目录组）
    └── 运行中会话（runtime 叶子）
```

渲染器（`renderSidebarChildItems` / `renderAgentGroup`）只消费统一条目形状，**不感知条目来源是本地还是远程**。来源（`source`）、连接（`remoteConnectionId`）、读写能力等保留为条目元数据，供寻址与状态渲染使用，默认不产生任何 UI 层级。

远程模块（`remote-connections.js`）的职责收缩为：维护远程 catalog 数据 + 提供按工作空间筛选的投影（`getRemoteSidebarProjection(workspaceAgentId, ownerAgentId)`）。不再拥有 DOM。

### 2. 叶子 = 运行中的 runtime

叶子条目唯一来源是远程 `get_connected_agents` 中存活的 child runtime。prebuilt 会话索引、workspace_sessions 历史不再是叶子来源——"左侧叶子 = 正在运行的会话"，与本地列表语义完全一致。

### 3. 连接的可见痕迹只剩项目组标签

远程目录组显示为 `主机名：目录名`（ADR-0008 的 `服务器名：项目` 语义落点），嵌在对应本地工作空间入口之下。连接别名的作用是区分不同远程实例下的同名目录，**不是**侧栏层级。无目录的远程 runtime（如 IM 门户）与本地无目录 runtime 一样作为工作空间直属会话，不制造伪项目组。

### 4. 身份归属：元数据推导，禁止类型硬编码

远程 runtime 归属哪个并列身份（如编程小助手的主身份 vs coder）由元数据决定，任何位置禁止 `if (agentId === 'programming-helper')` 式分支：

```text
显式 sidebar_entry_id        → 直接归属
缺失时 sessionType = main    → 宿主入口（parent_id）
缺失时其他 sessionType       → parent_id:sessionType
```

身份不明确时只归主入口，**不复制到并列身份**。

### 5. 数据源优先级：connected 主源，viewer 补充

`get_connected_agents` 的 child 条目是主源（身份、目录、活跃会话字段齐全）。远程 `/api/agents` 的 viewer 条目降级为补充源：只填充主源中不存在的 runtime，**不覆盖任何已有字段**。此前的反向覆盖会用 viewer 的空 `open_directory` / `sidebar_entry_id` 抹掉主源身份，导致目录组消失、并列身份串线。

### 6. projectKey（内部身份）与 projectName（呈现）分离

折叠状态、组身份用 `projectKey`（含完整目录与来源编码），显示名用 `projectName`。本地与远程同名目录天然隔离，用户无感知。归一化目录分隔同时匹配正反斜杠（Windows 路径切分陷阱）。

### 7. 高亮谓词的空值守卫

选中工作空间（surface）时 `currentRuntimeAgentId` 为空。任何"兜底比较"（如 `resolveRuntimeRef` 未命中归一化为空串）不得与空当前值对称相等，否则全量运行会话误高亮。规则：无选中运行时直接判非；兜底解析必须实际命中。

### 8. 归属事实先于可见性（修订一，2026-10-23）

新会话短暂闪入"外部代理"分组（随后又归回工作空间）的根因：托管 runtime 先在 Viewer 列表可见、归属（viewerAgentId → `managedAgents` 记录）后补，且 `get_connected_agents` 在读取工作空间元数据**之前**就冻结归属映射。两条修订消除该窗口，保证"出现在 viewer 列表中的托管 runtime 必然已在归属映射中"：

- **发布握手**（`scripts/run-prebuilt-agent.js` + `server/routes/agent-startup.js`）：子进程在 `withViewer` 注册前经 IPC 发布 `runtime-identity`（agentId / sessionId / viewerAgentId），并阻塞等待 `runtime-identity-accepted`；服务端在写入 `managedAgents` 记录后才回 ack（新 spawn 与共享进程 add-session 两条路径同构）。ack 超时（2s）即会话启动失败——归属不可靠时宁可失败，不静默放行。未托管运行时（无 IPC、env 不匹配，如装配运行时与外部代理）不参与握手，行为不变。
- **后置快照**（`server/routes/agent-connected.js`）：归属映射在工作空间元数据加载完成后才构建，查询等待期间补齐的身份同样参与本轮分类。

回归：`test/agent-lifecycle.test.js`（身份在元数据读取期间补齐仍归类 child、真实外部代理仍为 external）；`test/workspace-agents-runtime.test.js`（身份发布先于 Viewer 注册、ack 前不注册，含共享进程 add-session 路径）。

## Consequences

- **产品语义边界被刻意抹平**：本机与远程的边界感下降（早期产品的取舍，用户明示接受）。未来要恢复边界（来源徽标、远程目录筛选、按来源区分交互）时，只改投影策略与条目元数据的呈现层，不动数据契约与点击链路。
- **远程独有并列身份合成已撤销**（原 Phase 1.5，ADR-0025 退役会话身份投影时移除）：coder 升格独立 APP 后，远程并列身份不再经聚合器合成——远程 catalog 条目按 APP 归属直接投影（`sidebar_entry_id` 为呈现归属，缺席即父 APP），`hasLiveSession` 合成判定与纪元守卫随 `remote-identity-projection` 一并删除。
- **只读判定依赖命名空间 id**：`switchAgent` 解析成功后 `currentRuntimeAgentId` 可能丢失 `remote:` 前缀，只读判定必须按用户点击的原始命名空间 id 做。Phase 2 起该判定演化为 capability 门控（远程且握手 `capabilities.write` 为 false 才只读），但"解析后丢前缀"的陷阱依然约束所有按命名空间寻址的调用点。
- **往返测试是硬约束**：`test/remote-sidebar-projection.test.js` 用真实聚合输出直接驱动真实前端投影函数（非手写 fixture），字段改名、分流规则变化、数据形状断链都会在测试层暴露。
