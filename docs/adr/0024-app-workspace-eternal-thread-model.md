# ADR 0024: APP 型工作空间——业务单对话与可选线程连续性

日期：2026-10-10
状态：已接受（实施计划见 [docs/plans/2026-10-10-app-workspace-eternal-thread.md](../plans/2026-10-10-app-workspace-eternal-thread.md)）

## 背景与问题

智能编码空间之后，Claw 要长出第二类产品化工作空间：日程管理 / 记事本定位的 APP 型工作空间。它的形态与编码工作空间根本不同：

- **对话流就是主界面**。用户打开工作空间即进入一条与 APP 的多轮对话（充分利用既有 AI 交互界面，不另起炉灶），没有「项目目录」「新建会话」概念——session 从用户操作对象降级为实现细节。
- **长期常驻**。确定性职责（存储、定时触发、到期投递）由 feature/宿主代码持有——产品承诺（"记下的不会丢、到点一定提醒"）必须由数据库与定时器刚性担保，不依赖 LLM 上下文记忆；LLM 会话是按需唤醒的语义处理器（理解输入、生成提醒文案、唤醒后决策）。
- **上下文自动轮换**。一致性要求弱于编码场景但频率更高：接续更频繁、上下文压缩更激进，且接续过程**对用户完全不可见**——界面永不"卡一下切换"。
- **可拔插**（用户裁决的产品约束）：任何一个应用型工作空间可以整体撤掉、删掉代码，剩下的工作空间全部正确运行。

现有 WorkThread 已提供持久连续性锚点、接力事务、Inbox 暂存和按 head 语义路由的输入网关；Claw 前端仍以 runtime/session 为消息数据源，coder 线程界面则采用显式跳转。APP 需要保持一条稳定对话体验，但“唯一活动对话”是 APP 的业务状态，不能由 WorkThread 模式表达。需要补齐的基础能力是提醒输入进入线程路由、线程状态变化通知，以及跨 successor 的一致消息流投影。

具体缺口集中在四处：

1. **单一活动对话没有通用安放点**。"当前展示哪条对话"是 APP 的业务状态，不能寄生于通用线程列表（"查唯一线程再创建"有并发窗口，也无法表达"清空重来"）；qqbot 的 receptionistSessionId 是既有先例（workspace 配置选定 session、启动按配置恢复、门户重启收敛），APP 型工作空间需要各自以业务状态实现同构机制。
2. **前端只有"多棒并列 + 显式跳转"投影**。coder 的线程投影（coder-threads-ui：行 = 线程、打开 head 每次动态解析、绝不静默跳转）与"一条对话 = 一条连续消息流、接续对投影不可见"是相反的设计纪律；且打开 head 走 `open_session` 完整导航事务（缓存交接、乐观绑定、状态轮换、runtime 切换）——这正是要消灭的"切换感"。
3. **换头发现只有 20s 轮询**。SSE 事件（sse-events.js）全部按 viewerAgentId 寻址、kind 固定七种，无线程维度；接续完成（advanceHead）对前端是盲的。
4. **唤醒无法进入线程域**。APP 的常态输入形态是定时唤醒（feature 定时器到点 → 唤醒 head 会话），但 input-gateway 对 `kind: 'reminder'` 在线程路由上显式拒绝（WorkThread command 契约无输入身份槽位，入箱后只能以用户消息落地——身份被静默改写比拒绝更糟）。唤醒若绕过网关直投 runtime，交接窗口内会投给即将退役的旧 head。

## 决策

### 1. WorkThread 提供连续性；APP 自己定义唯一活动对话

WorkThread 是可选的连续性机制：宿主将一个 session 显式登记为线程 root，接续时由该线程承接 successor。它不声明某个 workspace 只能有一条线程，也不负责选择 APP 当前展示哪条对话。

APP 的“只有一个接线员对话”属于产品规则。APP 自己持久化当前对话的权威引用（例如 active session / conversation reference），并负责创建、恢复、切换和清除该引用。QQBot 的 receptionistSessionId 是本地先例：接线员对话由 workspace 配置选择，门户启动按该配置选择 session；它不是 WorkThread 的 singleton 模式。

因此：

- 移除 `thread: { mode: 'singleton' }` 与 `ensureSingletonThread` 这类通用宿主语义。通用线程服务不限制线程数量、不替 APP 决定 canonical conversation。
- coder 保持现有 per-session 建线程行为；是否将该现有判定声明化属于独立的通用化决策，不作为 APP 单对话需求的前提。
- APP 的唯一活动对话引用及 bootstrap / 并发创建防重 / 恢复策略由 APP 装配或其业务 feature 持有；必要时该 session 可显式关联一个 WorkThread，以复用接续，但“唯一”约束由 APP 的权威状态与创建事务保证。
- metadata 的 `identities[]` 不承担唯一对话语义；Feature 配置 scope、安装 scope 与线程连续性也彼此独立。

### 2. APP 对话生命周期由 APP 自身管理

- APP 以自己的持久化业务状态标识唯一活动对话。创建、恢复、切换和数据清除均由 APP 的装配/feature 决定；并发创建必须在该业务状态的权威写入处防重，不能靠“查一条线程再创建”模拟唯一性。
- APP 若把活动对话关联到 WorkThread，继续复用既有接力事务；上下文接续只改变该对话的 head，不改变 APP 的活动对话身份。
- **接续变换由 APP 选择**：变换压缩成什么、保留什么是产品决策。APP 可在框架接续协议（ADR-0002）内新写变换，而非定制官方 Trim/Summary 变换的参数。Claw 接续装配链现状固定 trim-transcript + appendSummary 策略，为 APP 接入自定义变换的参数化属 APP 接入时的宿主适配，本 ADR 不预设任何特定变换。框架与宿主不引入 APP 产品语义。
- **删除入口按实际连续性对象守卫**：若 APP session 属于 WorkThread，通用会话删除不得绕过线程级限制；若 APP 业务数据要求禁止删除，则由 APP 的业务删除入口执行该规则。代码目录卸载不修改 WorkThread record，也不自动删除用户数据；卸载后遗留数据的保留与清除由用户数据生命周期策略决定。

### 3. 输入与唤醒：线程寻址统一入口 + Thread command 身份槽位

- **新薄入口 `/protoclaw/threads/:threadId/input`**：解析当前 head runtime → 复用 `deliverUserInput` 的全部路由判定（head 健康 → 直投；交接窗口 / 非 head → Inbox 暂存；终态 → 拒绝）。前端对话视图只持 APP 对话引用，不计算目标 session / viewer id；线程关联的对话由服务端解析为当前 head——发送竞态全部在服务端收敛（现状前端守卫 `resolveThreadInputRoute` 是为"会话寻址的 UI"设计的补丁，服务端寻址模式下由其取代）。
- **WorkThread command 契约增加 turn 身份槽位**（框架侧改动）：command 携带 `kind: 'user_message' | 'reminder'`，投递时 bridge 原样转发。这消除 input-gateway 对 reminder 的线程域拒绝——APP 的定时唤醒是常态输入形态，必须与用户消息同享线程行政检查（交接窗口内暂存而非误投旧 head / 丢弃），不该有任何"绕行政检查"的直投特例。

### 4. 前端视图：接续硬切换（2026-10-10 修订，原单流投影方案废弃）

- **页面身份锚 = APP 对话引用**。视图状态（滚动位置、输入草稿、焦点）挂 APP 对话键下；数据源引用（当前 head runtime / threadId）是可替换的从属字段——接续换头不换身份，APP 重置对话（换业务引用）才换页面身份。
- **接续硬切换，不做跨会话拼接**：换头后视图直接呈现新 head 会话自己的记录（其开头为变换产物——裁剪主干 / 摘要，形态由变换语义决定）。拼接式单流被否决：接续是变换（ADR-0002），新会话是变换产物、新的开始，拼接会把它抹平为"假装连续"；历史以变换后形态呈现是变换语义的自然结果，不是缺陷。接续前的原始记录保留在旧会话文件中，可经会话历史查看。
- **换头 = 数据源重绑，不是导航**：前端发现 headSessionId 变化 → 把数据源换绑到新 head runtime → 按 ADR-0013 的 rewrite 语义全量重建消息基线 → 滚动/草稿不动（页面身份不动的自然结果）。**不进入 ADR-0014 的 NavigationHandle 事务**——那是"把用户带到某处"的用户导航，换头是数据层事实，两者正交；用户主动离开对话视图（切到别的工作空间）仍走既有导航。
- **换头发现**：SSE 新增按 threadId 订阅的事件源，在线程创建、head 提交、归档和删除事务落定后发布事实事件；前端以事件触发数据源重绑，线程 contentHash 轮询作为断连恢复机制。事件只负责发现状态变化，不承载消息数据。
- **功能投影按 APP 声明裁剪**：APP 的单对话页面不出现新建会话、会话列表、手动 trim / compact / branch / checkpoint / rollback 等通用会话操作；具体可用操作由 APP UI 声明决定，不从 WorkThread 数量模式推导。工作空间首页渲染 APP 声明的 block（app-ui 分发链，未知类型渲染空串的既有行为保证可拔插）。活动对话未关联 WorkThread 或线程已被删除时，退回普通会话视图，不得无路可走。
- **侧栏身份按 APP 对话引用键控**：APP 的稳定侧栏条目代表业务对话，不随 successor session/runtime 更换而闪烁；由 APP 投影提供稳定业务身份，不能把 threadId 作为通用 APP 身份契约。关联 WorkThread 时可用 threadId 实现该投影，但这属于该 APP 的映射。
- **接力可见性**：换头后新会话开头的变换产物即接续的自然呈现，无额外接缝 UI；rotation_failed 显示一条可恢复的错误状态条。

### 5. 可拔插工作空间（验收约束）

线程能力、对话视图和相关 UI 行为由 APP 的声明与装配驱动，公共代码不按具体 APP ID 分支。可拔插验收分开检查代码与用户数据：

- 删除 APP 代码目录并重启后，其他工作空间的服务启动、发现、路由、配置与 UI 均不依赖该目录；缺少可选 APP 时不得因它的 metadata、agent module 或 feature 装配而报错。
- 全局 `threads/` 中该 APP 的线程记录属于独立用户数据；卸载代码后保留但不提供该 APP 的 UI / 写入入口。不得把记录自动改为 `closed`。
- 删除用户数据目录是明确的破坏性操作，必须与代码卸载区分；本 ADR 不规定自动删除或数据迁移。
- 未知首页 block 按既有行为渲染为空，但这只是 UI 解耦检查之一，不替代服务端依赖检查。

边界（不在本 ADR 清理范围）：

- **ACP coder 端点**（`/protoclaw/acp/coder/sessions` 及其 agentId/sessionType 常量）：ACP 是 coder 的调度面，随 coding 工作空间存亡——"删除 APP 工作空间不影响其余工作空间"不含"删除 coding 工作空间后 ACP 仍可用"。
- **`PH_STYLE_WORKSPACE_AGENT_IDS` 等 process-mode / 展示历史特判**：属进程治理域，另行收敛。

## 不做清单（显式边界）

- **不在 WorkThread 中实现 APP 唯一对话语义**：WorkThread 管理宿主明确创建的连续性链，不限制同一 workspace 可创建的线程数量。APP 对唯一活动对话的持久化与选择属于 APP 业务状态。
- **不做前端消息 SSE 推送**：ADR-0013 已裁决轮询优先；本 ADR 的 thread 事件只是"该换绑数据源"的发现信号，不是数据通道。
- **不做跨会话拼接的单流视图**（2026-10-10 修订）：接续后视图呈现新 head 会话自身记录（硬切换），不按 sessionChain 拼接历史链——见决策 4。线程流读取接口（`GET /threads/:id/stream`）与前端流视图模块曾随单流方案交付，因硬切换决策失去消费场景，已回收删除；seed 边界 marker 落盘保留为协议层事实（记录每次变换边界，供审计与会话历史查阅）。
- **不在本 ADR 内实现日程 APP 本身**：存储结构、定时器语义、提醒文案、通知通道是第一个消费者的产品决策，住 APP feature；本 ADR 只交付它依赖的宿主能力（对话引用状态、唤醒投递、换头切换视图）。
- **不做"删除工作空间"的 UI 与数据清除流程**：本 ADR 保证架构可拔插；操作入口属工作空间管理域，另行立项。
- **不收编 ADR-0014**：换头重绑与导航事务正交，见决策 4。

## 后果

**正面**：APP 单对话身份由业务状态定义，WorkThread 作为可选连续性机制复用既有接力协议；用户输入和提醒唤醒共用线程行政检查；对话视图在 succession 时保持页面身份并硬切换数据源到新 head；可拔插具有代码与用户数据分离的验收约束。

**代价**：WorkThread command 契约增加 turn 身份槽位需修改 AgentDev 并重新构建；SSE thread 事件需在 Claw 实现；APP 需自行实现唯一活动对话状态、启动恢复、数据生命周期与接续变换；前端需实现数据源重绑与换头切换。

**风险与失效条件**：

- 硬切换后用户在新 head 视图看到的是变换后的历史（裁剪 / 摘要形态）。变换产物的边界事实（seed 边界 marker，已随 PR-3 落盘为协议层要求）保留了对该边界的持久记录，供审计与会话历史查阅；若未来任何视图需要区分源记录与变换产物，以 marker 事实为准，不做消息内容启发式切分。
- APP 对话的"永续"依赖接力失败路径的收敛质量（rotation_failed + 旧 head 继续有效）。若实践中 rotation 失败率不可忽略，APP 的可用性承诺受损——监控指标随第一个 APP 落地时建立。

## 关联

- [ADR-0002](0002-session-continuity-as-transformation.md)：接续协议与变换概念的权威；APP 新写接续变换在该协议之内，硬切换呈现忠实于变换语义。
- [ADR-0010](0010-sidebar-unified-projection.md)：侧栏三层投影不变；APP 的稳定对话叶子由其工作空间投影提供身份。线程宿主的 coder 子树另按 [侧栏线程锚计划](../plans/2026-10-10-sidebar-thread-anchor.md) 以 threadId 锚定叶子，接续时由 head runtime 补充运行属性，消除 runtime 退役至新 head 出现间的侧栏空窗。
- [ADR-0013](0013-message-poll-probe-tail.md)：消息通道契约；换头重建基线复用其 rewrite 分支。
- [ADR-0014](0014-session-navigation-transaction.md)（Proposed）：导航事务；本 ADR 显式不与之重叠（换头是数据源重绑，非导航）。
- [ADR-0019](0019-turn-suspension-semantics.md)：挂起语义是 APP 会话的常态；唤醒投递按会话路由的纪律由本 ADR 的线程入口延续。
