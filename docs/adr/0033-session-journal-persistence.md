# ADR 0033: 会话崩溃恢复——保留执行事实，回退非事务状态到安全检查点

日期：2026-10-27  
状态：提议（恢复协议与存储格式待实施审计定稿）

## 背景与目标

AgentDev 当前以单文件全量快照保存 Session。ReAct step 结束时保存快照；中断的 step 跳过该保存，Claw 宿主在 call 结束时另有兜底保存。进程若在一次工具操作中崩溃，恢复可能只能看到上一个快照：模型看不到它已经发起了什么操作，也无法分辨操作未开始、已完成但结果未保存，还是只完成了一部分。对有外部副作用的工具，盲目重试还可能重复执行。

本 ADR 的目标不是“把所有运行过程都写进日志”，也不是追求更小的文件或更快的保存，而是规定崩溃后的事实边界：

1. **工具事务的执行事实不能静默消失。** 恢复后的模型必须看到操作意图，以及已知的进度、结果或中断事实；如果无法确定外部操作是否完成，必须明确呈现“结果未知”，不能伪装成未执行或已失败。
2. **尽量保留崩溃前已观察到的执行情况。** 框架可以保存已收到的进度和输出；无法观察到的外部内部状态不得臆造。能否安全重试由工具的幂等契约或外部状态核验决定。
3. **非事务性会话状态可以回退。** 普通消息与 Feature 状态若未形成完整提交，可以一起回到最近的安全检查点；恢复后的对话必须自洽，不能留下“工具成功”的消息却没有对应结果，也不能留下结果却没有对应调用。

因此，持久化设计的首要划分是**不可丢的执行事实**与**可回退的工作状态**，不是“消息文件”和“Feature 文件”。

## 核心概念与权威边界

### 执行事务

一次可能产生外部副作用、或会改变不能随安全检查点回退之持久状态的工具操作，从模型提出调用开始，到执行结论写入恢复记录为止，称为执行事务。其持久化生命周期由以下记录组成：

- `tool_batch_intent`：执行前记录 assistant 原始调用批次、顺序与参数，是模型请求执行的事实；整批记录提交后才允许对任何成员 dispatch。
- `dispatch`：对单个 `callId` 记录“执行器已获准调用该工具”，必须先提交再进入工具代码。它不声称工具实现已启动或外部副作用已实际发生。
- `progress`（可选）：执行期间已观察到、且对恢复有用的阶段或输出。它只能表示框架实际收到的信息，不代表工具内部完整进度。
- `outcome`：记录 `succeeded`、`failed`、`interrupted` 或 `unknown` 结论，并保存最终交给模型的结果载荷（包括经 ToolResultTransform 后的文本/结构化显示、图片引用与有效调用信息）。同时记录副作用确定性：`none`（可证明未产生）、`possible`（无法排除部分/全部已产生）、`confirmed`（已核实产生）。未启动是独立的 `not_started` 终态，仅适用于尚未 dispatch 的调用，副作用必为 none。工具报告失败不自动意味着副作用为 none。一个已 dispatch 的 call 只有在工具结论与副作用确定性都已持久化后才算结清；unknown 是合法、不可覆盖的终态。
- `reconcile`：当外部系统查询、用户核验或旧工具迟到通知后来提供了先前 `unknown` 的新证据时，追加来源、时间、证据引用与核验结论；不改写原 outcome，模型可见历史保留“先未知、后核实”的过程。reconcile 只能补充外部事实，不能撤销已经确认发生的副作用，也不能把缺少证据的推断提升为 confirmed。它是 call 后续的审计事实，不重新打开已经结案的执行状态机。

事务记录是执行事实的权威来源。模型对恢复后事实的认知由这些记录构建；若中断时只能确定“已获准派发，最终状态未知”，就如实提供该事实及已收集的部分信息。

### 安全检查点

安全检查点是一份完整的 Session 工作状态基线，包含 Context、参与持久化的 Feature 状态及恢复所需 runtime 字段，并记录 `checkpointId`、`workEpoch` 与 `coversThroughSeq`（快照已折叠的最后一条前序 journal 记录序号；必须小于 checkpoint 自身的 `seq`）。快照不得跨过仍未结案的执行事务；其覆盖范围内的事务结果及核验事实必须已反映在快照的模型可见历史中。检查点只在稳定且 Context 协议完整的边界创建。检查点之后未纳入新检查点的普通消息与可回退 Feature 状态允许回退；执行事务及其后续核验记录不随之删除。Feature 快照不得成为不可逆外部副作用的唯一事实来源：此类事实必须由事务 journal 恢复；若 Feature 状态缓存了它，只能作为可重建投影，回滚后须从事务事实重建或明确标记过期，不能恢复成与真实副作用相矛盾的状态。

### Journal、checkpoint 与 `state.json`

- **Journal 是唯一权威历史**，承载工具事务记录以及完整检查点记录。检查点记录内含完整快照和 `coversThroughSeq`；恢复按序验证记录、折叠检查点与回滚，再将未被当前工作状态快照覆盖的事务事实投影给模型。检查点只可覆盖此前已结案、且工具结果及必要核验信息均已写入快照 Context 的事务；未结案事务永不被普通检查点吸收。
- **Checkpoint 是 journal 中一种有序记录**，不是第二个真相源。它保存“这个安全边界上的完整工作状态”；`coversThroughSeq` 标出快照已包含哪些事务结果，使恢复器能区分快照内状态与之后不可丢的事务事实。
- **首版不引入 `state.json`。** Journal 内的 checkpoint 已包含完整 Context 与 Feature 状态；单一权威来源让恢复只需按 seq 验证并重放。当前活跃会话开销已在毫秒级，没有证据支持为加速增加另一种存储形态。若以后实测确有必要，可加由 journal 重建的缓存；缓存损坏或删除不得改变恢复结果。

恢复按 journal 序号从头验证并折叠：每个 `checkpoint` 更新工作状态快照，每个 `rollback` 将当前快照切换到其目标 checkpoint，同时保留目标快照的 `coversThroughSeq`；由此得到的最后有效快照是普通状态基线。事务事实按事务身份归约，再依当前 checkpoint 的 `coversThroughSeq` 去重投影：序号已覆盖的事务结果及核验事实已在快照中，不能重复插入；序号未覆盖的事务和核验事实必须呈现，不能被 rollback 抹除。检查点覆盖只说明这些事实已进入工作状态快照，不删除 journal 原始记录；恢复扫描仍验证完整日志并保留事务身份索引。若末尾有未完成行，舍弃该行；中部损坏则隔离。

本 ADR 不预先要求“所有消息都逐条 journal 化”，也不要求 Feature 的每次内部变化都记录为事件。判断标准是：该信息属于不可丢的执行事实，还是允许回退的工作状态；只有前者必须越过检查点边界可靠保存。

首版 journal 记录类别固定为 `tool_batch_intent`、`dispatch`、`progress`、`outcome`、`reconcile`、`checkpoint`、`rollback`。`outcome` 对每个已获准调用记录工具结论、副作用确定性和最终送入 Context/模型的结果载荷；未获准调用以 `not_started` outcome 收尾。大型输出或图片可外置为内容寻址 blob，journal 保存哈希、长度和媒体类型；只有所有引用 blob 均完整持久化后，outcome 才可提交。每条记录包含格式版本、严格递增的 `seq`、记录类型及类型化 payload；同一 Session 的所有记录均携带 `sessionId` 与 `writerEpoch`，事务记录携带 `batchId` / `callId`，检查点与回滚记录携带目标/覆盖序号。不得用普通日志文本替代结构化事务记录。

## 决策

### 1. 工具批次采用先记意图、后执行、再记结果

工具批次与每项工具执行遵循以下顺序：

1. 模型响应中的 assistant 消息与整批 tool calls 作为一个 `tool_batch_intent` 记录提交，记录稳定的 `batchId`、每项 `callId`、原始 `ordinal`、工具名、参数与恢复策略。
2. 每项调用先经过工具存在性、权限与执行策略检查；若被拒绝则记录 `not_started/none`。准入通过后、进入工具实现及其副作用之前提交该项 `dispatch`。只有批次意图与该项 dispatch 都已提交，工具实现才可开始运行。
3. 执行期间，将框架实际观察到且有恢复价值的进度/输出作为 `progress` 持久化；具体节流频率由实现与工具特性确定，不承诺保存每个字节或每个 chunk。
4. 工具结束、失败或被中断后，持久化唯一终态 `outcome`，并与 `callId` 关联。未 dispatch 的成员若批次终止，写 `not_started` 终态。
5. 已结清成员按批次原始顺序构成模型可见的工具交换；尚未 dispatch 的成员先结为 `not_started/none`，已 dispatch 未结清的成员恢复为 `unknown/possible`，再提供给模型。

调用结论至少区分：`succeeded`、`failed`、`interrupted`、`unknown`。`interrupted` 表示执行器已确认停止，但操作效果仍需单独判断；副作用状态另以 `none` / `possible` / `confirmed` 表示。若恢复时无法判断执行器或外部操作的最终状态，结论用 `unknown`，副作用为 `possible`。恢复视图同时呈现结论和副作用确定性，不能把“工具报错/被中断”错误等同于“外部操作没有发生”。

本地日志与外部系统无法共同原子提交。`dispatch` 提交后、工具代码启动前仍存在一个无法消除的微小窗口；因此任何 `dispatch` 无 `outcome` 都按“可能启动、结果未知”处理，不能仅靠本地记录证明外部副作用发生与否。即使工具支持幂等键、事务句柄或按 `callId` 查询，首版恢复器也不主动调用外部系统核验或自动重放；这些能力由恢复后模型或用户在看到 unknown 事实后使用。这是协议明确保留的不确定性，不把它伪装成 exactly-once。

恢复器对 `requested` 无 `dispatch` 的调用可确定未启动，应追加 `not_started/none` outcome，再交由模型决定是否重新提出；对 `dispatch` 无 `outcome` 的调用首版不执行外部查询或自动重放，而是写入持久 `unknown/possible` outcome，并附已保存 progress。后续由模型或用户决定是否核验/重试；若外部证据可得，以 `reconcile` 追加。重试是新的调用身份，工具支持时沿用业务幂等键以降低重复副作用风险。若原工具进程仍在运行，必须先等待其退出或由宿主隔离；单纯写入 unknown 不代表已经停止该进程。旧进程退出后到达的完成通知按 `reconcile` 追加，并附原事务身份与证据；工具未停止前，Session 不得接受可能与其并发冲突的新调用。

已有的 `padDanglingToolCalls` 在消息协议层补齐悬空工具调用，继续作为一致性兜底；它不能替代 intent/outcome 记录，因为单看对话消息无法可靠判断外部副作用是否开始或完成。

### 2. 并发工具批次与确定性提交顺序

当前 ReAct loop 可并发执行同一模型响应中的 parallelizable 工具，再按模型原始调用顺序将结果写入 Context；非 parallelizable 工具按序执行。因此持久化不能把“完成先后”误作“模型看到的顺序”，也不能让并行任务绕过单写者提交纪律。

- **批次准入**：模型返回一组 tool calls 后，先在一个 `tool_batch_intent` 记录中原子提交 assistant 原始消息、按原始顺序排列的每个 `callId` / 工具名 / 参数 / 执行策略，以及批次标识。该记录提交前，本批任何工具都不得启动。若写入失败，整批不执行，并将持久化错误作为运行失败处理。
- **单项 dispatch**：每个工具实际调用前，再为该 `callId` 追加 `dispatch` 记录；只有 dispatch 已提交后才调用工具代码。恢复时“仅有 intent、无 dispatch”可确定该工具尚未启动；“有 dispatch、无 outcome”表示可能已经启动，首版一律恢复为 `unknown/possible`，不由恢复器自动查询或重放。dispatch 与工具启动之间仍存在原子性无法跨越的微小窗口，因此 dispatch 只能提供保守判定，不能证明外部副作用已发生。
- **事务身份与顺序**：每条 journal 记录由单写者分配严格递增的 `seq`；批次内每个调用另有稳定 `callId` 与 `ordinal`。`seq` 定义持久化提交顺序，`ordinal` 定义模型协议顺序；两者不可互相替代。Progress/outcome 总是引用 `callId`，不依赖并发完成次序。
- **并行运行**：批次准入提交后，按既有工具并发策略逐项 dispatch 并启动调用。progress 和 outcome 可按实际完成次序进入 journal；同一 `callId` 的记录由单写者串行追加。恢复呈现仍按批次与 ordinal 排序，不能按 outcome 到达顺序重排模型历史。
- **单一结论、可追加核验**：每个已 dispatch 的 `callId` 只能有一个结案 `outcome`（包括 unknown）；未 dispatch 的 call 只能结为 `not_started`。正常完成、异常、超时、用户中断和恢复收敛都通过单写者队列仲裁。后续外部核验或旧工具迟到的完成通知只追加 `reconcile`，不改写原 outcome。终态后的迟到 progress/outcome 不改变事实；恢复器提交合成终态前须在同一 writer queue 检查其仍未结案。
- **批次收尾**：并行成员全部结清或明确标为中断/未知后，ReAct loop 按原始 ordinal 构造工具结果消息并继续；结果消息必须包含工具结论、副作用确定性及最终模型可见载荷。工具策略钩子拒绝、工具不存在、exclusive 批次校验失败、用户中断导致未进入执行器的调用都没有 dispatch，记录 `not_started/none`（附 `denied` / `cancelled` 等原因）；已写 dispatch 但没有终态的调用一律标为“可能已执行、结果未知”，不可伪称确定未启动。
- **中断不等于进程已停止**：现有无 timeout 工具路径在 AbortSignal 竞争胜出时可能让工具 Promise 在后台继续运行。恢复或新输入不得与仍存活的旧执行并行；宿主必须先确认旧 runtime/子进程退出，或通过执行代理隔离并撤销其副作用权限。只发 abort 信号不是写权交接证明。

合法事务状态转移如下；`progress` 可以重复出现，但不能改变终态：

| 当前状态 | 事件 | 下一状态 | 规则 |
|---|---|---|---|
| 无 | `tool_batch_intent` | 每个成员 `requested` | 一条原子记录建立整批成员与 ordinal |
| `requested` | `not_started` outcome | `not_started/none` | 适用于拒绝、未调度、取消；此后不得 dispatch |
| `requested` | `dispatch` | `dispatched` | 仅执行器准入后；dispatch 提交后才调用工具 |
| `dispatched` | `progress` | `dispatched` | 可重复，进度序号递增；不得覆盖终态 |
| `dispatched` | 终态 outcome | `settled` | 终态唯一；成功、失败、中断、未知均在此结清 |
| `dispatched`（恢复） | 无 outcome | `unknown/possible` | 恢复器合成唯一 unknown outcome，副作用状态为 possible |
| `settled` / `not_started` | `progress` / `outcome` | 非法 | 拒绝迟到记录并记诊断；后续证据只允许追加 `reconcile` |

并发成员各自按此状态机推进。批次只有在所有成员终态均已提交后才算结清，且模型视图按 ordinal 构造；一项成员的失败不抹掉其他成员已提交的结果。

### 3. 检查点、回滚与命名检查点

安全检查点在稳定且 Context 协议完整的边界创建：收到并提交本次用户输入后、发起 LLM 请求前；工具批次全部结清并写入完整结果后；以及无工具调用的 assistant step 完成后。若 call 内存在可回滚的 Feature 状态更新，只有其完整快照与对应普通 Context 一并写入 checkpoint 后，该状态才算持久提交；checkpoint 间的更新按本 ADR 定义允许回退。检查点不得落在 assistant tool-call 已写入但其批次结果尚未结清的中间状态。一次 checkpoint 记录包含完整 Context、Feature 快照、runtime 恢复字段、`checkpointId`、`workEpoch` 及 `coversThroughSeq`。创建 checkpoint 是一条完整 journal 记录；只有该行完整提交后它才成为可恢复基线。损坏或 torn 的 checkpoint 行不生效，恢复按前序记录折叠到最后一个有效工作状态基线。用户输入随起始 checkpoint 保存，避免崩溃后丢失已提交请求；checkpoint 之间未完成的普通模型文本与 Feature 状态允许回退。

用户回滚通过追加 `rollback` 记录，引用目标 checkpoint、操作身份及新 `workEpoch`；它不删除或改写此前的事务事实。该记录本身不能将 checkpoint 之后的事务标记为已覆盖；`coversThroughSeq` 仍取目标快照原有值，事务结果需由恢复投影重新附加。该记录同时成为当前工作状态基线切换点。每个 checkpoint 的 `coversThroughSeq` 明确快照包含哪些已结案事务；恢复投影只重建该序号之后的事务，以及所有未被当前快照覆盖的 `reconcile` 审计事实，避免重复注入已包含结果，也避免回滚抹去之后发生的外部副作用。新 epoch 中的调用使用新的事务身份；旧 epoch 的未决事务必须先结案为 unknown 或经核验后才能提交 rollback。若用户要从回滚点开启完全独立的执行历史，应创建新 Session/分支；原 Session 的 journal 保留完整事实。

Context 的边界截断、整体恢复、命名检查点恢复等 mutation 必须落为完整 `checkpoint` 或 `rollback` 记录，不能以多条互不原子的写入模拟一次状态切换。`rollback` 记录必须包含目标 checkpoint ID、目标 `coversThroughSeq`、旧/新 `workEpoch` 和操作身份；目标快照必须属于同一 Session。实现需以“完整重放后的 Context.toJSON() 与目标快照一致”为检查点验收断言，并另验事务记录不因 rollback 丢失。

### 4. 单写者提交、尾部恢复与写权交接

单个 Session 同一时刻只有一个持有写入权的 runtime。所有并发工具、恢复器、checkpoint 与 rollback 请求经该 Session 的单写者队列串行提交；只读 mirror 不可写。写者代际必须由宿主侧互斥与 fencing 实际执行：每次提交校验当前 epoch，旧 runtime 失去所有权后，其迟到 progress/outcome 均拒绝。仅把 epoch 写入记录但不在写入入口校验，不能构成 fencing。取得新 epoch 前，宿主先确认旧 runtime/工具进程已退出或已隔离；否则不开放 Session 写入与模型调用。

journal 逻辑提交单位是一条带格式版本、严格递增 seq、schema 与校验和的 JSONL 记录。单写者先写完整 JSON 正文，成功后再写末尾换行作为 commit delimiter；恢复器只接受具有完整 delimiter、校验通过、schema 有效且 seq 严格递增的记录。JSON 字符串中的换行必须转义。写正文或 delimiter 失败时，当前记录不向调用者确认提交、不允许其后副作用开始；写者停止追加并隔离/修复尾部后再继续。进程崩溃后不完整尾记录及其后缀截断到最近有效前缀。有效前缀中部损坏不得跳过继续执行，必须只读隔离并报告。

所有写入都经过同一 Session writer queue，包括并行工具的 progress/outcome、恢复器的合成终态、checkpoint 和 rollback。队列串行化给记录分配 seq；批次内调用以 ordinal 决定模型可见顺序。写入成功是逻辑提交点；首版承诺进程崩溃恢复，不宣称 OS 崩溃/断电持久性。若未来要求断电耐久，必须明确 fsync 文件与目录的提交协议并验证各平台语义，不能只打开一个布尔选项。

journal 写入失败时，writer 进入 fail-stop：拒绝该 Session 后续写入、阻止尚未 dispatch 的调用启动、停止向 Context/模型交付任何未提交 outcome，并使 Session 暂停。若已有工具在运行，尽力发出取消；在确认进程退出前不允许恢复或交接。无法取消的操作按“可能继续产生副作用”处置。这样磁盘故障不会让运行时继续执行一串无法留下事实的操作。

检查点与事务记录共用 journal，因此不存在“checkpoint 文件已更新、日志边界未更新”的双文件原子窗口。未来若经性能实测增加独立 checkpoint/cache 文件，必须以临时文件 + 原子替换写入，内容包含 journal seq 与校验和；只有对应 journal 前缀有效时才可用，损坏/超前/落后时回退为 journal 重放，绝不能成为第二真相。

### 5. 记录粒度由恢复承诺决定

首版必须逐项裁决下列记录策略：

- 批次调用意图、单项 dispatch 与结论：必须持久化；工具存在性、权限和策略拒绝也须形成 `not_started` 且副作用为 `none` 的结果；执行前置入由单写者执行，工具代码不得绕开此门。
- 工具进度/部分输出：尽可能持久化已观察且有恢复价值的信息；设定有界节流与体积策略，并在恢复时标明其为部分信息。最终模型可见的结果载荷由 outcome 完整保存；大 payload 以先落 blob、后提交引用的顺序处理，禁止 journal 引用缺失资产。若最终 payload 或必需 blob 无法持久化，该 Session 进入 fail-stop；不能把工具结果交给模型后再假称它已记录。若工具副作用已发生但 outcome 写入失败，模型不得接收该未提交结果；恢复时以已有 dispatch/progress 合成为 `unknown/possible`。最终结果载荷是模型恢复后必须看到的执行事实，不因 `progress` 节流而省略。
- 用户输入：在进入模型调用前写入起始 checkpoint，作为已接收请求保存；模型生成的普通 assistant 文本和非事务性 Feature 状态随工具批次结清后的 checkpoint 保存，未完整提交部分可以整体回退。事务中用于配对的 assistant tool-call 由 `tool_batch_intent` 保存，不依赖普通消息 checkpoint。
- 消息改写、截断、rollback、命名检查点：必须以不会让事务事实与普通 Context 分叉的方式表达；具体事件 payload 由 Context mutation 审计定稿。此类 mutation 与 checkpoint/rollback 在同一 Session writer queue 线性化，目标序号必须引用已提交的同一 Session 记录。

首版不以“全量 Context 每次变化都写事件”为目标。最终 outcome 载荷、事务身份、结论与副作用确定性属于必须保存的执行事实；`progress` 只保存有界、尽力而为的已观察片段，不承诺每个输出字节。若后续产品要求任意中间态审计或逐步重建，再扩大日志范围。

## 恢复协议与一致性要求

恢复首先取得 Session 独占写入权并建立新的 fencing epoch；在确认旧 runtime 已停止写入后，才允许继续。journal 中的 `writerEpoch` 必须单调递增；每次 append 在队列入口校验当前 epoch，不能仅在记录 payload 中声明 epoch。若无法确认旧 runtime/执行代理已被隔离，则 Session 保持只读/暂停，不能并行恢复以免双执行。恢复扫描不得在发现缺少 outcome 时就立即 append 合成结果；先完成全 journal 验证、事务状态归约、按序折叠 checkpoint/rollback、确定当前普通状态基线与事务投影，再在同一 writer queue 中逐项条件化提交恢复结论和恢复 checkpoint。恢复中途再次崩溃时，下次启动按已提交记录继续折叠，不重复合成终态。

1. 从 journal 起始处扫描并验证版本、seq、记录完整性与状态机合法性；末尾不完整行截断到最后完整记录。中部损坏或状态转移非法时隔离 Session，不跳过记录继续执行。
2. 按序折叠所有完整 `checkpoint` 与 `rollback` 记录，得到当前工作状态基线；checkpoint 保存完整 Context 与 Feature 快照，rollback 将基线切换到目标快照。基线之后未形成新 checkpoint 的普通消息/Feature 变化回退。
3. 扫描全部事务记录，按每个 `callId` 重建状态（不能只看 checkpoint 之后，因为其后 rollback 可能选回较早工作状态）。`requested` 无 dispatch = 确定未启动，收尾为 `not_started/none`；已 dispatch 无 outcome = 可能启动，恢复为 `unknown/possible`（保留 progress）；有终态 outcome = 按结论与副作用确定性恢复；非法状态转移隔离，不自动猜测。
4. 对每个未决事务，首版不调用外部核验接口，也不自动重放；写入唯一合成 `unknown` outcome，副作用确定性设为 `possible`，包含恢复 epoch 和已知进度。尚无 dispatch 的 `requested` 项写 `not_started/none`，不得标为未知。所有补齐经同一单写者队列条件提交；恢复重入时按事务状态避免重复结案。后续由模型或用户取得的证据以 `reconcile` 追加，不覆写原 unknown。
5. 以按序折叠得到的普通 Context 为基线，按事务身份、`coversThroughSeq`、批次与 ordinal 合并未被快照覆盖的事务事实，生成协议完整的 assistant tool-call 与 tool-result 历史；已完成结果照实呈现，unknown 及副作用确定性显式标明，不能把未知折叠为普通失败。若合并产生重复调用、悬空结果或顺序冲突，阻止模型执行并报告。
6. 持久化恢复结论及模型视图后，才开放新输入与模型调用。恢复器首版不重放未决工具调用，也不主动调用外部状态查询；模型基于 `not_started` 或 `unknown/possible` 事实决定是否核验或发起新调用。若后续证据确认原操作结果，以 `reconcile` 追加，不改写原 outcome；若允许用户或模型重试，使用新的 callId，并在工具支持时携带同一业务幂等键。

| 崩溃位置 | 磁盘上可确认的事实 | 恢复处置 | 模型看到什么 |
|---|---|---|---|
| 批次 intent 写完前 | 无本批准入记录 | 本批未启动；允许模型重新生成调用 | 上一安全 checkpoint |
| 批次 intent 后、单项 dispatch 前 | 批次调用已提出，该项无 dispatch | 收尾为 `not_started/none`，交由模型决定是否重新提出 | 已提出调用、明确未启动且副作用为 none |
| dispatch 后、工具开始/副作用前 | 调用已获准派发，实际是否开始不能证明 | 合成 unknown/possible；恢复器不自动查询或重跑 | 结果未知、possible、没有已观察进度 |
| 工具执行中 | intent + dispatch + 已提交 progress | 结为 interrupted/unknown，副作用为 possible；保留 progress；不安全重试 | 已中断/未知、possible 与部分进度 |
| 工具已完成、outcome 提交前 | 本地只有 dispatch/progress，外部完成与否未知 | 合成 unknown/possible；后续模型/用户核验的证据追加 reconcile | 结果未知、possible，不能假称成功或失败 |
| outcome 提交后、Context/checkpoint 更新前 | outcome 含终态、副作用确定性与模型载荷 | 从 journal 重建该工具结果，再完成批次视图 | 完整载荷一次，按 ordinal 排序 |
| checkpoint 写入过程中 | 只有完整换行且校验通过的 checkpoint 记录有效 | 忽略 torn checkpoint，使用上一个 checkpoint + 事务日志 | 已结清事务照常保留；普通状态回退 |
| rollback 与恢复并发 | 写者队列中的一个提交先后序明确 | 按 journal seq 线性化；rollback 不删事务事实 | 回滚后的普通 Context + 不可丢事务事实 |

由此形成的关键不变量：

- **工具代码开始执行 ⇒ 同一 `callId` 的 batch intent 与 dispatch 均已提交。**
- **操作结论、副作用确定性与模型可见载荷均已提交 ⇒ 恢复后模型看到同一事实。**
- **已 dispatch 无 outcome ⇒ 恢复后模型看到中断/未知及 `possible` 副作用；仅有 intent、无 dispatch ⇒ 可判定未启动且副作用为 `none`。**
- **普通状态可回退，但事务事实不因回退而消失。**
- **恢复输出与模型可见 Context 自洽，工具调用协议完整，不重复、不矛盾；同一事实由事务身份与 `coversThroughSeq` 恰好投影一次。**
- **每条接受的记录属于当前 `sessionId` 和 `writerEpoch`；旧写者的迟到写入被拒绝。**
- **无法确定的事实以未知呈现；不以推断替代记录。**

## 文件与格式方案

当前 Session 由单文件全量 JSON 保存。首版改为 `<sessionId>/` 目录，至少含 `journal.jsonl`；大工具输出或图片仅在需要时写入 `blobs/`，journal 通过哈希、长度和媒体类型引用。检查点完整快照内嵌 journal。首版不创建 `state.json`，避免第二种存储真相。格式决策必须满足：

- 每项事实只有一个权威来源；缓存可删除并可重建。
- 日志记录有明确提交边界；崩溃尾部可识别，不能把半条 intent/outcome 当成完整事实。
- 检查点可独立验证完整性，并能与 journal 序号/边界对应。
- 旧格式可迁移，迁移失败不损坏旧会话；读写方经统一 SessionStore/API，不直接猜文件形态。
- 会话删除、分支、只读加载、索引元数据、handoff history-only 等路径都使用格式无关接口。

JSONL 是合适候选，因为可 append、便于检查且支持 torn-tail 恢复；pi durable 的提交边界、单写者与故障恢复纪律可作为参照。但本 ADR 不把特定 JSONL 行格式、fsync 默认值、文件名、sidecar/reclaim 或数据库后端提前定成不可变决策。实施设计需验证平台文件系统上的 append/rename 语义及断电承诺。

## 实施验收

实现必须以状态机和故障注入证明协议，不以“文件看起来正确”或单次正常流程通过作为验收。

1. **执行入口封闭**：所有工具执行（含批量、parallelizable、serial、exclusive、hook 拒绝、工具不存在、timeout 与用户 abort）均经持久化门；不存在能绕过 batch intent / dispatch 直接运行的调用路径。
2. **单写者与旧进程隔离**：并发工具可同时运行，但所有 journal 写入经单 Session writer queue；重启接管前旧 runtime 与仍在后台的工具执行已退出或被隔离；旧 epoch 的迟到进度/结果被拒绝。
3. **状态机校验**：测试所有合法状态转移、重复事件、终态后迟到进度、恢复合成终态重入；每个 `callId` 恰有一个终态，批次完成顺序与模型可见 ordinal 顺序分离。
4. **崩溃点矩阵**：对 batch intent、dispatch、progress、outcome、checkpoint、rollback 每次 append 的正文与 commit delimiter 前后注入进程终止；另覆盖 blob 写入/引用提交、checkpoint 回滚切换、写入失败 fail-stop 与旧工具迟到完成，验证磁盘事实、恢复动作与模型输入。
5. **外部操作窗口**：覆盖外部操作成功但 outcome 未提交、操作未启动但 dispatch 已提交、无幂等/查询能力等案例；恢复绝不重复未知副作用，模型收到准确的 unknown 事实。
6. **状态回退与模型视图**：覆盖 Feature 状态变化、step 失败整体恢复、call rollback、命名检查点回滚、分支；验证普通状态回到目标 checkpoint，事务事实不丢不重，tool-call/result 配对和批次顺序合法。
7. **文件消费与迁移**：扩展现有 `server/shared/session-access.js`，收口内容读写、删除、branch、handoff、只读消费者与格式分发；盘点所有调用者及直接路径，迁移失败不得损坏旧会话。
8. **兼容与协议回归**：验证旧格式迁移、`padDanglingToolCalls` 兼容、并行工具结果重建、Context `toJSON()` 等价性、日志尾部损坏与中部损坏的不同处置。

每个故障用例都断言四项：journal 最终有效前缀、恢复器采取的动作、恢复后模型实际收到的工具历史、是否可能重复外部副作用。任一项含糊或不一致即验收失败。

## 不做清单

- 不把“所有消息和 Feature 的每次变化都写进 journal”作为首版目标。
- 不承诺恢复工具内部不可观察的状态；无法核实的外部结果必须标为未知。
- 不对没有幂等保证或外部核验能力的未知副作用自动重试。
- 不为追求性能立项：当前活跃 Session 保存开销已实测在毫秒级；v1 大文件主要来自旧 rollbackHistory 格式，不代表当前持续成本。
- 不在本 ADR 建设 SQLite、多后端或日志压实；跨进程写通过 Session 单写者与 fencing 拒绝竞争写，不建设通用远程执行沙箱。
- 不改变 Feature `captureState` / `restoreState` 与 continuity 的业务契约；但恢复安全性所需的版本校验与一致性检查可在实施审计后提出最小契约扩展。

## 后果

**目标收益**：进程在工具执行期间崩溃后，模型不再把“未保存”误当“未发生”；它能看到已提交意图、已观察进度、最终交付载荷、工具结论与副作用确定性，或诚实的中断/未知状态，并据此核验或继续。普通消息和 Feature 状态采用完整检查点，未提交部分可安全回退，避免为不需要的中间态保存付出全量事件化复杂度。

**代价与边界**：执行前 intent 会增加同步持久化边界；每个工具需要明确重试/未知结果策略；部分输出持久化要控制频率与大小；工具事实与回退后的 Context 合并是核心正确性风险。对完全不可查询、不可幂等的外部操作，系统只能报告结果未知，不能保证自动恢复操作本身。

**验收不能只看文件**：必须以模型恢复后实际获得的工具历史为验收对象，覆盖成功、明确失败、执行中崩溃、操作已生效但结果未落盘、部分进度可得、部分进度不可得、回滚越过事务等情形。任何场景若让模型错误地认为操作未发生/已成功，或诱发不安全重试，均不通过。

## 关联

- [ADR-0002](0002-session-continuity-as-transformation.md)：Session 接续与 successor 变换。
- [ADR-0005](0005-tool-termination-semantics.md)：工具中断即结果；本 ADR 扩展到进程死亡后的执行事实恢复。
- [ADR-0019](0019-turn-suspension-semantics.md)：pending-work / suspended 事实与工具事务恢复的边界。
- [ADR-0026](0026-session-view-identity-and-data-sources.md)：Session 内容、Runtime 观测与 Thread 连续性的数据归属。
- [ADR-0031](0031-background-work-and-domain-shell.md)：后台工作与领域工具运行边界。
- 外部参照：pi durable 的提交日志、intent/recovery、torn-tail 与任务 checkpoint 设计；借鉴其提交纪律，不预设采用其整体状态模型。
