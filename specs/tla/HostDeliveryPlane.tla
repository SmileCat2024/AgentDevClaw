------------------------- MODULE HostDeliveryPlane -------------------------
EXTENDS Naturals, Sequences, Integers

(***************************************************************************)
(* 宿主投递面模型：Thread Inbox 指令从 pending 到 delivered 的最后一跳，  *)
(* 建模 2026-11-18 构造性复现的永久滞留死锁所在的层。                        *)
(*                                                                         *)
(* 与既有模型的分工：ReceiptBoundary* 建模框架域（领取→保存→ack 回执边界、  *)
(* runtime 单抽象节点）；SuccessionWindow 建模交接窗口。本模型补上它们显式  *)
(* 留白的一层（DEEP-MODELS.md：「真实轮询、失败退避、runtime-ready 事件     *)
(* 是否满足公平假设尚未验证」）：                                            *)
(*                                                                         *)
(*   1. 双真相源：hostEntry（宿主注册表：进程在位且绑定当前 head）与        *)
(*      adoptedGen（runtime 实际采纳的 head 代际）是两个可分离的事实。      *)
(*      错位态 hostEntry="present" ∧ adoptedGen ≠ hostHead 下，投递被       *)
(*      viewer fencing 永拒（可重试失败：指令保持 pending 且盘上无痕）。    *)
(*   2. 投递触发票 tickets：投递不是自由 action——它由触发点驱动（gateway   *)
(*      append 即时投、runtime-ready 补投）。票耗尽即「没人再调投递」，    *)
(*      这正是死锁的触发面形态。                                             *)
(*   3. janitor 自愈：EnableReconcile=FALSE 对应修复前语义（条目在位即      *)
(*      跳过，死锁无自愈）；TRUE 对应修复后语义（滞留时强制重投 + 身份      *)
(*      采纳重试，不消费票——自驱动新触发源）。                              *)
(*                                                                         *)
(* 不建模（诚实边界）：deliverPendingCommands 的 FIFO 细节、退避数值、      *)
(* failed 终态（回执边界模型已覆盖）、多线程并发、多 runtime 进程、         *)
(* runtime-ready 补投的无限重复（票池封顶 TicketCap，重启循环下补投票      *)
(* 合并表达）。                                                             *)
(***************************************************************************)

CONSTANTS CommandCount,       \* 1..CommandCount 条指令
           MaxGen,             \* head 代际上限 1..MaxGen
           TicketCap,          \* 投递触发票池上限（状态空间有界化）
           EnableReconcile,    \* janitor 对「条目在位 + 滞留」的对账（修复开关）
           EnableHandoff,      \* 允许换头（CommitHead 推进 head 代际）
           EnableRuntimeExit,  \* 允许 runtime 退出/重启（宿主清表）
           InjectAdoptFail,    \* 一次性身份采纳失败注入（死锁入口）
           JanitorFairness,    \* janitor 弱公平（15s 周期扫描持续发生的假设）
           DeliverFairness,    \* 触发点投递弱公平（gateway 即时投总会执行）
           MutateStaleDeliver, \* 变异：故意放行错位投递（验证不变式辨别力）
           BoundHandoff,        \* TRUE=换头尝试受预算约束（活性假设显式化）；
                               \* FALSE=无限干扰且不递减计数器——饥饿 lasso 的
                               \* 精确环要求状态可重复，递减计数器会消灭环
           BoundExit,           \* 同上，runtime 退出预算
           HandoffBudget,       \* 换头尝试次数预算（BoundHandoff=TRUE 时生效）
           ExitBudget           \* runtime 退出次数预算（BoundExit=TRUE 时生效）

Commands == 1..CommandCount

Min(a, b) == IF a < b THEN a ELSE b

(***************************************************************************)
(* cmd[i]  ∈ {"none","pending","delivered"}                                 *)
(* dgen[i] ∈ 0..MaxGen  ghost：指令投出时刻的 head 代际（0=未投出）         *)
(* hostHead   ：线程 head 代际（单调递增，CommitHead 推进）                  *)
(* hostEntry  ：宿主注册表条目（"present"=进程在位且绑定当前 head）          *)
(* adoptedGen ：runtime 采纳的 head 代际（0=不持有线程身份）                 *)
(* barrier    ：交接挡板（竖起期间投递被 handoff_in_progress 挡）            *)
(* tickets    ：投递触发票（gateway append / runtime-ready 发放）            *)
(* adoptFailUsed：一次性注入已烧掉                                           *)
(***************************************************************************)
VARIABLES cmd, dgen, daligned, hostHead, hostEntry, adoptedGen, barrier,
          tickets, adoptFailUsed, handoffLeft, exitLeft

vars == <<cmd, dgen, daligned, hostHead, hostEntry, adoptedGen, barrier,
          tickets, adoptFailUsed, handoffLeft, exitLeft>>

TypeOK ==
  /\ cmd \in [Commands -> {"none","pending","delivered"}]
  /\ dgen \in [Commands -> 0..MaxGen]
  /\ daligned \in [Commands -> {FALSE, TRUE}]
  /\ hostHead \in 1..MaxGen
  /\ hostEntry \in {"present","absent"}
  /\ adoptedGen \in 0..MaxGen
  /\ barrier \in {FALSE, TRUE}
  /\ tickets \in 0..TicketCap
  /\ adoptFailUsed \in {FALSE, TRUE}
  /\ handoffLeft \in 0..HandoffBudget
  /\ exitLeft \in 0..ExitBudget

PendingSet == {i \in Commands : cmd[i] = "pending"}

\* FIFO：一轮投递处理队首一条（deliverPendingCommands 逐条循环的最小化）
MinPending == CHOOSE i \in PendingSet : \A k \in PendingSet : i <= k

\* 身份对齐：runtime 采纳的代际等于宿主侧线程 head 代际
Aligned == adoptedGen = hostHead

\* 投递单条的公共门：客观门禁（bridge enabled + 挡板关闭 + 条目在位）
CanAttemptDelivery ==
  /\ hostEntry = "present"
  /\ barrier = FALSE
  /\ PendingSet # {}

\* 投递结果判定：对齐 → 送达；错位 → viewer fencing 永拒（可重试失败，
\* 指令保持 pending、盘上无痕——模型中体现为状态不变）
\* MutateStaleDeliver 变异：错位也放行（验证 DeliveredAtOrBeforeHead 辨别力）
DeliveryAccepted == Aligned \/ MutateStaleDeliver

\* 发放触发票（封顶）
GrantTicket == Min(tickets + 1, TicketCap)

(*************************** actions ***************************************)

\* 用户输入入箱（gateway：head 指令一律入箱 + 即时投递尝试发一张票）
EnqueueInput ==
  /\ \E i \in Commands :
       /\ cmd[i] = "none"
       /\ cmd' = [cmd EXCEPT ![i] = "pending"]
  /\ tickets' = GrantTicket
  /\ UNCHANGED <<dgen, daligned, hostHead, hostEntry, adoptedGen, barrier, adoptFailUsed,
             handoffLeft, exitLeft>>

\* 消费一张票的投递轮：身份匹配送达队首；错位被拒（只烧票，无其他状态
\* 变化——这正是「触发点烧掉了但投不进」）
TryDeliver ==
  /\ tickets > 0
  /\ CanAttemptDelivery
  /\ tickets' = tickets - 1
  /\ IF DeliveryAccepted
       THEN /\ cmd' = [cmd EXCEPT ![MinPending] = "delivered"]
            /\ dgen' = [dgen EXCEPT ![MinPending] = hostHead]
            /\ daligned' = [daligned EXCEPT ![MinPending] = Aligned]
            /\ UNCHANGED <<hostHead, hostEntry, adoptedGen, barrier, adoptFailUsed, handoffLeft, exitLeft>>
       ELSE /\ UNCHANGED <<cmd, dgen, daligned, hostHead, hostEntry, adoptedGen, barrier, adoptFailUsed,
             handoffLeft, exitLeft>>

\* 一次性身份采纳失败注入（死锁入口）：需要采纳（错位）且注入未烧时，
\* 采纳尝试失败且无任何其他效果
AdoptAttemptFail ==
  /\ InjectAdoptFail
  /\ ~adoptFailUsed
  /\ adoptedGen # hostHead
  /\ adoptFailUsed' = TRUE
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, hostEntry, adoptedGen, barrier, tickets,
             handoffLeft, exitLeft>>

\* 身份采纳成功（换头提交后 / 新线程锚定后 / janitor 重试 / spawn 注入后
\* 的显式采纳通道）：注入未烧时被拒（失败不烧注入——烧注入只经
\* AdoptAttemptFail / JanitorReconcile 的失败拍）
AdoptSuccess ==
  /\ adoptedGen # hostHead
  /\ ~InjectAdoptFail \/ adoptFailUsed
  /\ adoptedGen' = hostHead
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, hostEntry, barrier, tickets, adoptFailUsed,
             handoffLeft, exitLeft>>

\* 交接窗口：竖挡板（生产 beginSessionHandoff）。BoundHandoff=TRUE 时预算
\* 把「换头尝试收敛」这一活性假设显式化——无限换头风暴会饿死一切依赖挡板
\* 关闭的对账/投递（starve-handoff-toggle 场景的发现）。FALSE = 无限干扰：
\* 不递减计数器（饥饿 lasso 需要精确状态环，递减会消灭环并使状态空间
\* 随预算数线性爆炸）。
BeginHandoff ==
  /\ EnableHandoff
  /\ ~BoundHandoff \/ handoffLeft > 0
  /\ ~barrier
  /\ barrier' = TRUE
  /\ handoffLeft' = (IF BoundHandoff THEN handoffLeft - 1 ELSE handoffLeft)
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, hostEntry, adoptedGen, tickets,
                adoptFailUsed, exitLeft>>

\* 换头提交：head 推进、挡板清除；身份不在此对齐（生产语义：采纳靠后续
\* adopt-thread-head，失败不回滚换头——错位态的来源之一）
CommitHead ==
  /\ EnableHandoff
  /\ barrier
  /\ hostHead < MaxGen
  /\ hostHead' = hostHead + 1
  /\ barrier' = FALSE
  /\ UNCHANGED <<cmd, dgen, daligned, hostEntry, adoptedGen, tickets, adoptFailUsed,
             handoffLeft, exitLeft>>

\* 交接失败收敛：挡板清除、head 不动（abortPendingSuccession；挡板不会
\* 永久竖起，避免活性反例来自挡板而非死锁本身）
AbortHandoff ==
  /\ EnableHandoff
  /\ barrier
  /\ barrier' = FALSE
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, hostEntry, adoptedGen, tickets, adoptFailUsed,
             handoffLeft, exitLeft>>

\* runtime 退出（进程死亡 / 宿主重启清表）：条目与身份一起消失。
\* 预算同换头：BoundExit=TRUE 时有限预算 = 「runtime 不无限崩溃循环」
\* 假设的显式化（starve-crash-loop 场景的发现：无限崩溃循环饿死投递，
\* 与死锁无关）；FALSE = 无限干扰（不递减，保留精确环）。
RuntimeExit ==
  /\ EnableRuntimeExit
  /\ ~BoundExit \/ exitLeft > 0
  /\ hostEntry = "present"
  /\ hostEntry' = "absent"
  /\ adoptedGen' = 0
  /\ exitLeft' = (IF BoundExit THEN exitLeft - 1 ELSE exitLeft)
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, barrier, tickets, adoptFailUsed,
                handoffLeft>>

\* runtime 拉起（janitor 唤醒 / 重启恢复）：条目重建 + spawn 注入身份对齐
\* + runtime-ready 补投发一张票
RuntimeSpawn ==
  /\ hostEntry = "absent"
  /\ hostEntry' = "present"
  /\ adoptedGen' = hostHead
  /\ tickets' = GrantTicket
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, barrier, adoptFailUsed, handoffLeft, exitLeft>>

(* janitor 对「条目缺位 + 滞留」的唤醒（修复前后语义相同：requeue 的
 * ensureHead 路径）。效果 = 拉起 runtime（spawn 注入对齐身份）+ runtime-ready
 * 补投发一张票——修复前生产代码对缺位形态也具备的完整自愈链。 *)
JanitorWake ==
  /\ hostEntry = "absent"
  /\ PendingSet # {}
  /\ hostEntry' = "present"
  /\ adoptedGen' = hostHead
  /\ tickets' = GrantTicket
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, barrier, adoptFailUsed, handoffLeft, exitLeft>>

(***************************************************************************)
(* janitor 对「条目在位 + 滞留」的对账（2026-11-18 修复引入）：             *)
(* 组合 action，一拍内完成「强制重投 → 仍有滞留则身份采纳重试 → 复投」。     *)
(* 不消费票（自驱动新触发源）。注入未烧时这一拍的采纳被拒、本拍无进展       *)
(* （仅烧掉注入，下一拍重试——与生产「失败下一轮扫描自然重试」一致）。        *)
(* EnableReconcile=FALSE 时此 action 不使能 = 修复前语义：条目在位即跳过。   *)
(***************************************************************************)
JanitorReconcile ==
  /\ EnableReconcile
  /\ CanAttemptDelivery
  /\ IF Aligned
       THEN /\ cmd' = [cmd EXCEPT ![MinPending] = "delivered"]
            /\ dgen' = [dgen EXCEPT ![MinPending] = hostHead]
            /\ daligned' = [daligned EXCEPT ![MinPending] = TRUE]
            /\ UNCHANGED <<hostHead, hostEntry, adoptedGen, barrier,
                           tickets, adoptFailUsed, handoffLeft, exitLeft>>
       ELSE IF ~InjectAdoptFail \/ adoptFailUsed
              THEN /\ adoptedGen' = hostHead
                   /\ cmd' = [cmd EXCEPT ![MinPending] = "delivered"]
                   /\ dgen' = [dgen EXCEPT ![MinPending] = hostHead]
                   /\ daligned' = [daligned EXCEPT ![MinPending] = TRUE]
                   /\ UNCHANGED <<hostHead, hostEntry, barrier,
                                  tickets, adoptFailUsed, handoffLeft, exitLeft>>
              ELSE /\ adoptFailUsed' = TRUE
                   /\ UNCHANGED <<cmd, dgen, daligned, hostHead, hostEntry,
                                  adoptedGen, barrier, tickets, handoffLeft, exitLeft>>

JanitorActs == JanitorWake \/ JanitorReconcile

Next ==
  \/ EnqueueInput
  \/ TryDeliver
  \/ AdoptAttemptFail \/ AdoptSuccess
  \/ BeginHandoff \/ CommitHead \/ AbortHandoff
  \/ RuntimeExit \/ RuntimeSpawn
  \/ JanitorActs

Init ==
  /\ cmd = [i \in Commands |-> "none"]
  /\ dgen = [i \in Commands |-> 0]
  /\ daligned = [i \in Commands |-> FALSE]
  /\ hostHead = 1
  /\ hostEntry = "absent"
  /\ adoptedGen = 0
  /\ barrier = FALSE
  /\ tickets = 0
  /\ adoptFailUsed = FALSE
  /\ handoffLeft = HandoffBudget
  /\ exitLeft = ExitBudget

Spec == Init /\ [][Next]_vars
\* 挡板收敛是无条件弱公平：生产语义里交接事务最终 commit 或超时 abort，
\* 挡板不会永久竖起（SuccessionWindow 已建模该窗口）。缺此假设，换头开启的
\* 活性场景会被「挡板永竖」污染，反例指向错误的对象。
Fairness ==
  /\ WF_vars(AbortHandoff)
  /\ (JanitorFairness => WF_vars(JanitorActs))
  /\ (DeliverFairness => WF_vars(TryDeliver))
LiveSpec == Spec /\ Fairness

(*************************** properties ************************************)

\* 安全不变式 2：指令只在投出时刻的 head 代际上投出（ghost dgen 记录），
\* head 单调不回退——捕获「投给旧头」类违规（MutateStaleDeliver 应击穿）
DeliveredAtOrBeforeHead ==
  \A i \in Commands :
    cmd[i] = "delivered" => /\ dgen[i] >= 1
                            /\ dgen[i] <= hostHead

\* 安全不变式 3：投出的指令必有投出时刻的身份记录（fencing 语义存在性）
NoDeliveryWithoutAdoption ==
  \A i \in Commands :
    cmd[i] = "delivered" => dgen[i] # 0

\* 安全不变式 4：投出时刻身份必须对齐（fencing 语义；MutateStaleDeliver
\* 放行错位投递时此不变式给出反例——辨别力证据）
DeliveredOnlyWhenAligned ==
  \A i \in Commands :
    cmd[i] = "delivered" => daligned[i]

(***************************************************************************)
(* 死锁可达性（安全形式的死锁证明）：                                       *)
(* DeadlockStalled 描述永久滞留现场——条目在位、身份错位、指令滞留、       *)
(* 触发票耗尽、且修复前语义（janitor 对此无 action）。                      *)
(*   deadlock-pre-fix 场景：NotDeadlockStalled 被违反（exit 12）= 死锁     *)
(*     状态可达——把构造性复现提升到模型层（无需活性假设）。                *)
(*   deadlock-post-fix 场景：该状态仍可能瞬时可达（对账下一拍才行动），     *)
(*     其不可持续性由活性性质保证（见 EventuallyAllDelivered）。            *)
(***************************************************************************)
DeadlockStalled ==
  /\ hostEntry = "present"
  /\ adoptedGen # hostHead
  /\ PendingSet # {}
  /\ tickets = 0
  /\ ~EnableReconcile

NotDeadlockStalled == ~DeadlockStalled

\* 活性：每条指令一旦 pending 必达 delivered（leads-to）。
\* 假设：JanitorFairness（周期扫描持续发生）+ DeliverFairness（触发点投递
\* 总会执行）+ 挡板收敛 + 无 runtime 退出（聚焦投递面）+ 用户输入可停。
\* 修复前该性质在滞留 lasso 失守；修复后 janitor 对账打破死锁，应通过。
\*
\* 方法论注记：不要写成 <>(\A i : cmd[i] # "pending")——其否定是
\* 「从首状态起恒有 pending」，而 Init 无 pending，否定式不可满足，
\* TLC 会永远报告通过（空转检查）。这一陷阱在本模型调试中实测踩过。
PendingLeadsToDelivered ==
  \A i \in Commands : (cmd[i] = "pending" ~> cmd[i] = "delivered")

=============================================================================
