# ADR 0025: coder 升格独立工作空间——会话身份投影机制退役

日期：2026-10-11
状态：已接受（实施计划见 [docs/plans/2026-10-11-coder-workspace-promotion.md](../plans/2026-10-11-coder-workspace-promotion.md)）

## 背景与问题

2026-08-24 的工程（[docs/plans/2026-08-24-coder-into-programming-helper.md](../plans/2026-08-24-coder-into-programming-helper.md)）把当时的独立工作空间 coder 并入编程小助手，捆绑了两件可分离的事：产品面（移除探索代理、确立 coder 为唯一无人值守形态、仅调度面创建）与建模面（用 `sessionType` 身份投影实现"coder 属于编码域"的归属感）。产品面决策保留；建模面决策失败，本 ADR 定向替换它。

失败的机制链：该设计规定"左侧投影条目仅在该身份有存活 runtime 时出现"——**入口存在性绑定运行态**。接续换头窗口内旧 head runtime 退役，条件瞬间为假，条目消失；为阻止消失补出"撑存条目"（第四存活来源）；撑存条目继而毒化前端身份解析（合成投影 id 与真实宿主 id 冲突），引发连续多轮修复（条目失联、恢复卡片乱入、徽标失联、标题串线、输入串扰、activate 与 rotation 相撞），每轮修复一个消费点，下一个消费点再爆。砍掉 fallback 链路后又出新问题——身份靠推导时，fallback 是推导失败时唯一的兜底，砍掉即"无身份"。

根因定性：**会话身份是分布式推导出来的，不是结构事实**。sessionType 没有唯一权威落点，散落在约九层消费点（服务端投影合成、线程域身份解析、进程组键、feature 作用域、runtime 分派、前端焦点/投影/标题/输入路由、调度面契约、装配声明、远程并列合成），各自推导、各自 fallback。这个结构下不存在"修好"，只存在"下一个消费点"。

概念债同步清算：智能编码空间（工作空间名）与编程小助手（main 身份名）是一个本体的两层名；coder 被迫以"身份"而非实体存在。

## 决策

### 1. 对象模型：OS → APP（工作空间）→ agent

- **APP 是 OS 的应用单元**：侧栏条目、可寻址（HTTP/CLI/ACP）、可拔插（验收约束沿用 ADR-0024 §5）、可声明呈现策略。
- **agent 是 APP 内对话实体**：持有装配（提示词、工具集、运行时类）与名字。本 ADR 落地后所有 APP 均为单 agent；APP 内多 agent 是模型允许、本 ADR 不实现的未来工程。agent 不产生侧栏入口、不参与会话寻址分支——身份投影不会借这层还魂。
- **智能编码空间**（主 APP，`programming-helper`）：内含编程小助手 agent。APP 名与 agent 名两层保留，各司其职。
- **Coder**（后台型 APP，新建 `prebuilt-agents/official/coder/`）：内含 coder agent（`coder-agent.js` 迁回）。与主 APP 在侧栏**平行**；声明 `host: programming-helper` 关联——表达同域绑定，落点为侧栏排序相邻（hosted APP 跟随宿主分组，如 Coder 紧随智能编码空间同在工具与效率组）。host 是 APP 级元数据与呈现属性，不是身份机制，不产生嵌套层级。
- 本 ADR 是 2026-08-24 合并的定向回摆：保留其产品面决策，替换其建模面决策。

### 2. 侧栏呈现：APP 身份与可见性策略

- APP metadata 声明呈现策略默认值：`persistent`（常驻）或 `on-demand`（有存活 Runtime 承载会话才显示）。智能编码空间、Agent Studio、IM 渠道、工作群为 persistent；Coder 为 on-demand。工作空间作者经 metadata 声明自己工作空间的默认策略，代码不写死任何 APP 专属判断。
- on-demand 的生效策略由服务端合流（工作空间设置）：作者默认（auto / always）+ 用户覆盖（设置 → 工作空间，服务端存储跨浏览器一致）。`auto` 的判定源是**当前存活且绑定 Session 的 managed Runtime**；有未归档、非终态线程但其 Runtime 已停止，不得撑住左侧入口。左侧投影表达实际运行态；线程记录与历史仍保留在 APP 首页，不等同于正在运行。用户选择「始终显示」时可保留 APP 入口，但无存活 Runtime 时仍不产生运行会话叶子。入口消失后的找回路径是设置的「始终显示」（类比手机的应用管理），前端不保留任何粘性记忆。
- **接续挡板例外（无感连续）**：接续窗口（线程 `status=rotating`，pendingSuccession 挡板在途）内三个 runtime 存活来源可能全部落空，但接续是已立挡板的持久化事务事实，不是运行态中断。挡板在途期间入口保持显示，使前端接续占位（disconnected 过渡条目）可见，无感连续不被打破；挡板清除（接续提交或失败收敛）后回到 Runtime 事实裁决。归档线程不适用此例外。
- **演进注记（2026-10 线程生命周期定案）**：可见性事实由「存活 Runtime + rotating 挡板」扩展为**资产驱动**——存在未归档线程资产（含 hold 等非终态；删除事务窗口内除外）即保留入口，上文「未归档线程不得撑住入口」的限制不再成立。判定实现见 `server/routes/agent-connected.js` 的 `hasRunningSessions`。APP 首页仍是全量线程列表，侧栏叶子仍只表达运行态，两者分工不变。
- **APP 身份与可见性判定分离**：侧栏中的 APP 身份来自 metadata 声明，不由 runtime 或线程临时合成；`sidebarVisible` 是 APP 的呈现策略结果。`persistent` 常驻；`on-demand` 按作者默认与用户覆盖合流，自动策略可明确选择当前存活 Runtime 作为可见性事实。runtime 仅影响 APP 是否显示及其下运行会话叶子，不改变 APP 身份。`sidebarVisible` 由 wire 下发，前端纯消费。
- Coder 条目下完全遵循 ADR-0010 统一投影（工作空间 → 目录组 → 存活 runtime 叶子，叶子 = 运行中线程 head 会话），零特例。Coder APP 首页为全量线程列表（行 = 线程，含归档 tab），沿用现 coder-threads 视图：侧栏答"现在活着什么"，首页答"我有哪些线程"。

### 3. sessionType 身份投影语义退役

- **退役范围**：sessionType 作为"工作空间内身份"的全部语义——并列身份合成（`sidebar_entry_id` 的 `owner:type` 投影）、`identities[].sidebarEntry` 条件展开、runtime 按 sessionType 分派 agent 类、进程组键的 sessionType 分段、coder 取值本身。
- **保留范围**：字段降级为**运行形态标签**（`plain` / `studio-debug` 照旧），不参与任何身份、呈现、寻址判定。
- `identities[]` 声明机制保留（qqbot 接线员等轻量使用，无侧栏投影）；编程小助手的 identities 收敛为单 agent 声明——是正名，不是投影。

### 4. 会话与线程归属结构化

- 会话归属 = 所属 APP，创建时写定，任何层不再推导。编程小助手 agent 会话与 coder agent 会话分属两个 APP。
- 线程记录 `workspaceId = coder`；线程宿主判定从 (agentId, sessionType) 组合恢复为 APP 级（coder APP 的会话即线程宿主）。
- 输入路由目标 = 当前视图所属 APP + 会话，无跨身份兜底——把"砍 fallback"的既有方向结构性地完成。输入隔离不变量：前端全局线程指向（`ClawThreads.activeConversation`）是缓存而非真相，其消费点（输入提交、草稿缓存键）必须经宿主 + 当前视图一致性校验；等待重绑豁免以宿主焦点为界，切走即清残留。点击接续中的线程条目进入接续等待表面（pending chat surface，`awaitSessionId`）聚焦线程本身，不落工作空间首页。
- 创建纪律不变：coder 会话仅由调度面创建（ACP / `claw threads` CLI / dispatch 技能）。ACP 与 CLI **外部契约不变**，内部寻址改为 coder APP。
- feature 安装作用域与配置层对齐到 coder APP（`agent-configs/coder.json` 与 install-service 的 coder 作用域现已按 `agentId=coder` 存放，改动为收敛而非迁移）。

### 5. 数据处置：遗弃搬移，零兼容

- **coder 侧全部现存数据一次性物理搬移**至带日期的遗弃目录：threads 全局库中的 coder 线程记录（2026-08 遗留的 `workspaceId=coder` 条目、合并期的 `programming-helper + identity=coder` 及无 identity 早期条目）及 boards / 归档索引连带、programming-helper 会话存储中的全部 coder 会话记录、open-sessions 相关条目。不格式转换、不删除（遗弃目录留在用户数据区，可考古、可整体还原回滚）。
- **逻辑层零兼容分支、零老数据识别**。新 Coder 线程域从零开始：切换上线后 Coder 条目不出现，首次派遣（线程创建）后出现。
- **main 会话数据完全不动**，照常可用。
- 切换时刻正在执行的 coder 派遣中断失联，需重新派遣（已接受的产品代价）。
- 新库纪律：身份不明即报错，不猜。

## 三条实施纪律（失败条件）

1. **身份一步到位，不留 sessionType 兼容层**。中间态压缩在一次切换内；新旧身份并存等于消费点翻倍。
2. **归属与关联只挂 APP 级**。session 只认所属 APP；任何把身份、host 关系挂到 session 上的设计都是病原体复发。
3. **抽象必须做减法**。兼容层、session 级 host、长期迁移分支、读侧过滤补丁——凡把旧复杂度带进新抽象的做法，出现即判本 ADR 实施失败。

## 退役清单（身份伴生面，随实施清除）

- 并列身份合成与条件展开（agent-connected.js 的投影条目构造、collectSidebarIdentityEntries 消费）
- 挡板撑存条目（第四存活来源）及其前端识别（`source='prebuilt'` + `agentId` 回指宿主的归一补丁）
- session-helpers-pure 的 `owner:type` sidebar_entry_id 投影
- ADR-0010 Phase 1.5 的远程 hasLiveSession 并列身份合成
- open-sessions 的身份过滤补丁（读侧与写侧——coder 会话挂宿主下的情形结构性不存在）
- computeProcessGroupKey 的 sessionType 分段（APP 隔离天然分段）
- run-prebuilt-agent 的 resolveAgentClass 分派与 `PROTOCLAW_SESSION_TYPE` 的 coder 用法
- 前端投影 id 归一系列补丁（app-main / app-core 对 `programming-helper:coder` 的处理）
- thread-control 的会话身份解析层（thread-identity）
- 编程小助手 metadata identities 中的 coder 项、宿主项目卡片的 coder tab
- 上述防御对应的测试改写（如 frontend-thread-badge-residency 锁定的毒化场景随模型消失）

## 不做清单（显式边界）

- 不做 APP 内多 agent 机制（模型允许，实现另立项）
- 不做运行时动态安装子 APP（真·小程序商店）；Coder 可拔插按 ADR-0024 §5 静态验收
- 不做 Coder 线程的 UI 创建入口（派遣表单另立项）
- 不做 ADR-0024 的接续收尾（thread SSE 事件源、reminder 输入槽位）——本 ADR 接续机制零改动，全量回归为验收门槛
- 不迁移、不识别、不呈现历史 coder 数据（遗弃搬移，见决策 5）
- 不做通用"置顶"机制（host 相邻排序即绑定表达）

## 后果

**正面**：会话归属成为结构事实，历史 bug 类（条目消失、乱入、徽标失联、标题串线、输入串扰、撑存毒化）在结构上不可发生；侧栏零特例，统一投影覆盖所有 APP；对象模型与"Claw = agent OS、工作空间 = APP"的产品叙事对齐，为 ADR-0024 的 APP 型工作空间提供同一对象模型。

**代价**：破坏性一次性切换（切换窗内在跑派遣中断）；ACP / CLI 内部寻址重写；身份/投影相关测试大面积改写；远程投影测试面同步改写。

**风险与失效条件**：遗弃搬移误伤 main 数据——搬移走白名单枚举 + 搬移前计数校验 + 失败即拒启动（fail-hard），遗弃目录可整体还原；远程投影漏改——往返测试（remote-sidebar-projection 等）先行改写；测试基线大改导致回归信号弱——先按新模型改写身份相关测试（允许短暂红），再动实现转绿。

## 关联

- [ADR-0010](0010-sidebar-unified-projection.md)：三层统一投影不变；本 ADR 新增"可见性声明"呈现属性，并撤销其 Phase 1.5 的并列身份合成
- [ADR-0024](0024-app-workspace-eternal-thread-model.md)：workspace = APP 叙事的延续；可拔插验收约束沿用；接续机制本 ADR 零改动、受益于身份稳定
- [ADR-0002](0002-session-continuity-as-transformation.md)：接续协议权威；身份结构化后接续窗口内身份事实全程稳定，仅 head runtime 换绑
- [2026-08-24 合并计划](../plans/2026-08-24-coder-into-programming-helper.md)：本 ADR 回摆的对象，保留其产品面决策
