# ADR 0026: Session 视图统一——APP 对话身份为页面锚，Session 身份为数据锚

日期：2026-10-11  
状态：已接受

## 背景与问题

Claw 的聊天界面以 Viewer runtime 为主要数据入口：消息、工具、输入请求、概览、待办与运行状态由多个端点读取，再写入前端当前视图。另一方面，Session 的持久快照由服务端保存，Thread 维护 head、接续状态与待投递输入。接续期间旧 head runtime 已退役而 successor 尚未就绪，用户仍应能查看上一棒 Session 的历史内容；此时 runtime 不是可用的消息读取源。

当前模型没有统一表达“页面正在展示哪个 Session”及“每项视图数据属于谁”。多数数据以 runtime 为请求对象；Thread 又维护独立的 `activeConversation`；接续等待读取则新增了从会话文件直接取消息并写入全局 `currentMessages` 的旁路。结果是同一 Session 的内容依 runtime 生命周期切换读取路径，而消息之外的附属状态也可能仍留在旧 runtime 视图中。

纯 Session 与 Thread 会话不应形成两种聊天体系。Session 承载对话及其会话级数据；Runtime 提供该 Session 运行期间的实时观测；Thread 管理连续性、head 与线程输入路由。界面需要按同一 Session 视图契约呈现这些不同所有者的数据，并在接续换头时明确切换 Session。

## 决策

### 1. 页面身份与数据身份分层

纯 Session 聊天视图以 `{ agentId, sessionId }` 标识当前 Session。APP 型工作空间可以有稳定的 APP 对话引用作为页面身份；该身份在 Thread 接续换头时保持不变，底层当前 Session 身份则从旧 head 切换到 successor。APP 页面状态（如草稿、滚动位置）按 APP 对话身份归属；会话内容及会话级数据按 `{ agentId, sessionId }` 寻址。此分层延续 ADR-0024 的“换头不换 APP 对话身份”，并以 Session 身份落实数据隔离。

Runtime ID、Thread ID、消息数组和附属状态均是当前 SessionView 的来源或投影，不替代页面身份或 Session 数据身份。每个异步读取和提交都绑定发起时的页面身份、Session 身份与视图代次；只有仍匹配的结果可以提交。运行中 runtime、服务端 host 的 active session、最近选择的 Thread 等均不得隐式替代当前 Session。

用户主动切换对话时，页面身份及其当前 Session 身份随导航改变。Thread head 推进只替换 APP 对话所绑定的 Session 数据身份，不触发 APP 页面导航。用户离开后，迟到的消息或状态响应不得把页面拉回旧对话。

### 2. Session 是会话内容与会话级事实的权威所有者

持久化在 Session 中的对话内容、标题及会话元数据以该 Session 的记录为权威事实。会话可读取能力不依赖 runtime 是否存活。

每个 Session 都通过同一个会话视图读取契约加载内容。该契约根据 Session 是否有可用 runtime，分别由 live-runtime adapter 或 persisted-session adapter 提供数据；适配器差异对调用者隐藏，返回值携带 Session 身份、数据版本/来源及字段可用性。runtime 在运行时提供的消息视图与持久化快照必须遵循同一消息契约。runtime 不可用时，持久化快照提供该 Session 最后已保存的内容。Thread 接续必须先等待旧 head runtime 完成 `saveSession` 并收到 `session-exited` 确认，再读取该快照、生成 successor；确认失败时接续失败，不得读取未经确认的旧快照继续接续。读取不得启动 runtime、改变 Thread head 或改变 Session 所属关系。

统一读取契约不意味着所有运行时状态都要伪装成持久数据。没有 runtime 时，正在执行的工具调用、输入 lease、实时连接、调用阶段等运行态字段明确标记为 unavailable 或空值，不从其他 Session 或 Thread 补值。只有经过归属确认、且持久化数据确实以该 Session 为键的数据，才可在 runtime 不可用时恢复呈现。

### 3. Runtime 是有明确 Session 绑定的运行时数据源

Runtime 提供实时消息增量及其生命周期内的观测数据。每次读取 Runtime 数据时，必须能够确认该 runtime 当前服务的 Session；数据进入视图前校验 runtime 与当前 `{agentId, sessionId}` 一致。

调用阶段、连接、当前工具/调用状态、输入请求与 lease 等瞬态数据归其实际 runtime / call 所有。若这些状态自身携带 Session 身份，按该身份纳入会话视图；若不携带，则只作为当前绑定 runtime 的状态呈现，不跨 runtime 或跨 Session 继承。进程内缓存可以优化读取，但不是权威来源，也不能在身份缺失时充当 fallback。

### 4. Thread 是连续性与输入控制投影，不是消息容器

Thread 权威持有线程生命周期、当前 head、接续事务、pending inbox、归档与删除事实。Thread 通过 `agentId + sessionId` 成员关系关联 Session；该关联决定 head 状态和线程输入路由，不改变 Session 消息的所有权。

Thread 面板/指示器是当前 SessionView 上的控制投影，不改变 APP 页面身份：

- 当前 Session 是 Thread head 且无接续时，输入走该 Session 的运行时输入路径。
- Thread 接续中，旧 head Session 的可读持久内容仍显示；新输入进入 Thread inbox，不投给即将退役的 Runtime。
- head 推进后，当前视图绑定 successor Session，显示 successor 自己的变换后历史；不拼接旧、新 Session 消息。
- 浏览历史 Session 时展示该 Session 自己的持久内容，并按其与 Thread 的成员关系呈现只读/前往 head 等控制状态。

Thread 事实不能由侧栏条目、`activeConversation` 缓存或 runtime 推导。前端缓存仅用于投影和加速；以服务端 Thread 事实及会话成员关系校验。

### 5. 所有视图数据按权威归属分类

统一会话视图的字段按权威所有者分类，读取和提交时不得跨类别借值：

| 数据域 | 权威所有者 | runtime 不可用时的规则 |
|---|---|---|
| 消息、会话标题与会话元数据 | Session | 从同一 Session 的持久记录读取 |
| 执行中的调用、调用阶段、连接与输入 lease | Runtime / 当前 call | 标记不可用或为空；不从旧 runtime 恢复为当前状态 |
| Thread head、接续状态、pending inbox、归档事实 | Thread | 按 Thread 权威状态读取并投影到当前 Session |
| Feature 持久状态、Todo、摘要/概览等 | 按其实际写入契约确定为 Session、Runtime、Thread 或 Workspace | 只有契约明确绑定当前 Session 的数据才能随 Session 视图恢复；Workspace 级数据保持 Workspace 级，不伪装成 Session 状态 |
| 用户输入草稿、滚动位置等本地视图状态 | 明确的 Session 视图键 | 按 `{agentId, sessionId}` 隔离；Thread 连续性不会合并不同 Session 的本地状态 |

实施时须逐项核验附属状态的真实写入键与生命周期。无法证明归属的数据不得用 runtime 当前值、host active session 或 Thread 缓存猜测归属；应明确显示不可用，或先修正其所有权契约。

### 6. 一个读取/提交接口，多个内部适配器

Claw 前端依赖统一的 SessionView 读取与提交接口，而不直接组合 Viewer `/messages`、overview、hooks、todo、input requests 与线程专用快照端点。接口以 Session 身份寻址，返回身份绑定的视图快照；增量更新、重写、运行态刷新、Thread 事实变化都经同一身份校验与提交路径进入视图。

live-runtime、persisted-session、Thread control 是该接口内部按数据所有权选择的适配器/数据源，不是面向调用方的并行 UI 模式。接口不提供“先试 runtime、失败后猜另一个 Session”的 fallback；数据源选择由当前 Session 的权威绑定事实决定，来源变化必须作为明确的视图更新提交。

## 实施顺序

实施分步用于隔离依赖和验证边界；每一步直接迁移到本 ADR 的目标契约，不建立兼容期、双读双写或长期 fallback。

1. **确定字段所有权并定义 SessionView 契约。** 以代码与持久化格式为依据，盘点视图读取/写入的全部数据域；明确每个字段的权威对象、Session 键、可用条件、更新方式及 runtime 缺席语义。无法确定的字段在进入统一接口前先裁决其数据契约。
2. **实现统一 SessionView 入口与身份提交边界。** 由 `{agentId, sessionId}` 寻址，内部选择 live-runtime 或 persisted-session 数据源；返回一致的身份信封、版本/来源与字段可用性。所有异步提交由视图身份和代次校验，不允许模块直接覆盖另一视图的全局数据。
3. **迁移消息及附属状态消费者。** 主聊天渲染、消息增量/重写、工具历史、输入请求、概览、待办、运行状态、上下文控制、草稿/滚动等各消费方改读 SessionView 或其明确归属的投影；删除其直接拼接 runtime 与 Session/Thread 全局状态的路径。
4. **将 Thread 接续接入统一视图。** 等待接续时读取旧 head Session 的持久内容并投影 Thread 状态；输入走 Thread inbox；head 推进时通过统一视图提交边界切换到 successor Session。移除线程专用消息读取与直接修改全局消息数组的实现。
5. **删除重复真相和旁路，按不变量验收。** 清除被统一接口替代的 runtime/session 视图身份推导、线程专用消息旁路与重复状态副本。以纯 Session、运行中的 Thread head、接续等待、接续完成、历史 Session、runtime 退役/恢复、快速切换及迟到响应等场景验证身份隔离、字段归属和换头行为。

## 验收不变量

- 任一时刻，聊天内容和全部会话级附属数据都能追溯到唯一 `{agentId, sessionId}`；Thread 控制投影可以关联该 Session，但不能改变其数据归属。
- runtime 可用与否只影响可提供的瞬态字段，不影响读取对应 Session 的持久内容。
- Thread 接续等待显示旧 head Session 的最后已持久化内容；输入进入 Thread inbox；head 推进后视图切到 successor Session，不拼接两棒消息。
- 纯 Session 和 Thread Session 使用相同的 SessionView 调用契约；线程能力仅在关联 Thread 时增加控制投影与路由行为。
- 任意旧请求、旧 runtime 事件或外部 active-session 变化均不能覆盖或重定向当前视图。
- runtime 缺席时未持久化的运行态标为 unavailable/empty；不得伪装为仍在运行，也不得从别的 Session 借值。
- 不存在只供 Thread 接续等待使用的消息读取/渲染旁路，也不存在按失败顺序尝试其他身份的隐式 fallback。

## 不做清单

- 不把 Session、Runtime、Thread 合并成一个持久化对象或统一存储。
- 不把 Thread 的 inbox、head 和接续状态写进 Session transcript。
- 不跨 Session 拼接历史消息；successor 按变换产物呈现。
- 不要求 runtime 不可用时恢复未持久化的执行态；历史记录不是活运行态。
- 不以兼容旧视图模型为由保留双真相、双读写或不确定的 fallback。
- 不在本 ADR 改变 ViewerWorker 的消息轮询协议、Thread 接力事务语义或各 Feature 自有业务数据契约；这些机制在统一 SessionView 接口内按其既有权威归属接入。

## 后果

**正面**：纯 Session、Thread head、接续等待和历史会话共享同一个视图身份与读取/提交契约；运行态与持久态的可用性边界清楚；Session 切换和接续换头都能由身份校验阻止旧数据串入。

**代价**：需要跨越前端读取、状态归属和 Thread 接续链路进行一次系统性迁移；附属数据必须逐项查证真实持久化范围，不能把所有当前 runtime 状态直接投射成离线 Session 状态。统一接口内部仍有不同数据源，但其选择与组合只由 SessionView 实现承担。

## 关联

- [ADR-0002](0002-session-continuity-as-transformation.md)：Session 接续是变换，successor 保存变换产物。
- [ADR-0010](0010-sidebar-unified-projection.md)：侧栏投影；侧栏身份不替代聊天视图的 Session 身份。
- [ADR-0013](0013-message-poll-probe-tail.md)：消息增量、tail 与 rewrite 的取数语义由统一 SessionView 消费。
- [ADR-0019](0019-turn-suspension-semantics.md)：Runtime 挂起是运行态；不得与 Session 持久内容或 Thread 生命周期混同。
- [ADR-0024](0024-app-workspace-eternal-thread-model.md)：APP 对话与 WorkThread 连续性，接续换头是视图数据源重绑而非消息拼接。
- [ADR-0025](0025-coder-workspace-promotion.md)：Coder Session 归属与 Thread 宿主 APP 的结构化身份。
