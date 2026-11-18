------------------------- MODULE HostDeliveryPlane -------------------------
EXTENDS Naturals, Sequences, Integers

(***************************************************************************)
(* 宿主投递面模型（2026-11-18 大幅细化版）：Thread Inbox 指令从 pending     *)
(* 到 delivered 的最后一跳，按本日调查钉死的真实机制建模。                   *)
(*                                                                         *)
(* 相对首版（H2 死锁验证用）新增的表达能力——首版明确留白、本版补齐：        *)
(*                                                                         *)
(*   1. 双投递路径：用户输入有两条互不相通的路——线程队列（appendCommand    *)
(*      + FIFO 消费）与直投（submitUserTurn 直达 runtime 当前绑定会话）。  *)
(*      路由由注册表事实决定（input-gateway）：runtime 在位且绑定 head →    *)
(*      入箱；绑定历史成员 → 409 拒收；其余（缺位/漂移）→ 直投，直投       *)
(*      成功 = 消息落在 runtime 当前会话，可能根本不是线程 head（wt-        *)
(*      1ab8a75b「两个世界」形态的直接表达）。                              *)
(*   2. 诚实的投递触发面：消费只有四个触发点——入箱即试（非 force，受退避   *)
(*      约束）、runtime 就绪补投（force，一次性，信号可丢失）、接续换头     *)
(*      导流（force，commit 事务内）、janitor 扫描（force 对账 / 唤醒）。   *)
(*      没有周期性投递轮询：触发点不来，指令就躺着。首版的「票池」抽象      *)
(*      由这四个显式触发点取代。                                            *)
(*   3. 线程级退避（delivery-consumer）：一次失败消费（attempted>0 且       *)
(*      delivered<attempted）冷却整个线程——之后所有非 force 消费直接       *)
(*      no-op，不只挡失败条目；退避到期没有任何内部重试，等外部触发点。     *)
(*      force 消费跳过退避检查，但失败后同样置退避。                        *)
(*   4. runtime 三态生命周期与绑定漂移：absent → starting（activate 拉起    *)
(*      但不等 READY——用户此刻已能输入）→ running；runtime 绑定会话可      *)
(*      漂移（shared-by-project / 用户切会话）：head（在位服务 head）、     *)
(*      member（历史成员——resolve(AGENT,HEAD) 为 null，队列不可达）、       *)
(*      foreign（无关会话——直投会静默落错地方）。                           *)
(*   5. spawn 身份注入开关（ADR-0047 构造性保证）：spawn-for-head 是否      *)
(*      携带线程身份；FALSE = legacy spawn（采纳缺口 = H2 死锁入口之一）。  *)
(*   6. ready 信号丢失开关：11-16 迟到就绪补偿之前的语义（信号无人消费     *)
(*      即丢，wt-a258c93b 事故类）；重启收割也丢信号（进程内内存语义）。    *)
(*   7. 采纳反复失败探针：adopt-thread-head 可无限失败（活 runtime 永不     *)
(*      采纳）——投递活性对此的依赖显式化。                                  *)
(*                                                                         *)
(* 保留首版的骨架：双真相源（宿主事实 vs viewer 采纳身份）、fencing 拒收、  *)
(* janitor 对账修复开关、换头/崩溃干扰预算、变异辨别力。                    *)
(*                                                                         *)
(* 不建模（诚实边界）：deliverPendingCommands 循环内的中途事实变化（K20，  *)
(* 单次消费抽象为全有或全无）、failed 终态（回执边界模型域）、多线程、     *)
(* 多 runtime 进程（单 runtime + 绑定漂移近似 shared-by-project）、        *)
(* 退避/滞留阈值的数值时间（TLA 无秒）、滞留水位告警（D11 观感域）。       *)
(***************************************************************************)

CONSTANTS CommandCount,       \* 1..CommandCount 条用户输入（索引序 = 发送序）
           MaxGen,             \* head 代际上限 1..MaxGen
           EnableReconcile,    \* janitor 对账（2026-11-18 修复开关）
           EnableHandoff,      \* 允许换头（BeginHandoff / CommitHead / Abort）
           EnableCrash,        \* 允许 runtime 退出与宿主重启收割
           InjectAdoptFail,    \* 一次性身份采纳失败注入（H2 死锁入口）
           AdoptFailForever,   \* 采纳可反复失败（饥饿探针；TRUE 时永不成功采纳）
           SpawnInjectsIdentity, \* spawn-for-head 注入线程身份（ADR-0047；FALSE=legacy）
           EnableReadyDrop,    \* ready 信号可无人消费而丢（TRUE=11-16 补偿前语义）
           EnableBindDrift,    \* 共享 runtime 绑定可漂移到无关会话
           MutateStaleDeliver, \* 变异：错位也放行（验证不变式辨别力）
           JanitorFairness,    \* janitor 弱公平（15s 周期扫描持续发生）
           DeliverFairness,    \* 就绪补投弱公平（ready 信号总会被消费）
           SpawnFairness,      \* spawn 终局弱公平（starting 必然 Ok 或 Fail）
            BoundHandoff,       \* TRUE=换头受预算约束（活性假设显式化）
            HandoffBudget,
            BoundCrash,         \* TRUE=崩溃/收割受预算（崩溃循环饥饿的边界）
            CrashBudget,
            BoundDrift,         \* TRUE=绑定漂移受预算（漂移风暴饥饿的边界：
            DriftBudget         \*   janitor 两拍收敛下，漂移快于扫描即饿死对账）

Commands == 1..CommandCount

(***************************************************************************)
(* cmd[i] ∈ {"none","pending","delivered","direct","lost"}                 *)
(*   pending   ：已入 Thread Inbox 待投                                     *)
(*   delivered ：经线程队列 FIFO 送达 head runtime（唯一受 fencing 保证）   *)
(*   direct    ：经直投路径落在 runtime 当前绑定会话（可能不是 head——       *)
(*              不经线程队列、不受 fencing、不清偿任何 pending）            *)
(*   lost      ：响亮失败（session_not_head 409 / 直投无 runtime 可达），   *)
(*              用户立即看到错误——与 pending 的静默滞留形成可见性对比      *)
(* dgen/daligned：ghost，队列送达时刻的 head 代际与对齐事实                 *)
(* hostHead  ：线程 head 代际（CommitHead 单调推进）                        *)
(* rt        ∈ {"absent","starting","running"}（absent=无进程；starting=   *)
(*             已拉起未就绪——activate 返回而 READY 未至的窗口）            *)
(* rtBound   ∈ {"head","member","foreign"}：runtime 绑定会话与线程的关系    *)
(* adoptedGen：runtime 采纳的 head 代际（0=不持线程身份）                   *)
(* barrier   ：交接挡板（竖起期间消费 gated no-op——等待不是失败）           *)
(* backoff   ：线程级退避中（非 force 消费直接 no-op；到期无内部重试）       *)
(* readySignal：未消费的 runtime-ready 补投信号（进程内，收割即丢）         *)
(***************************************************************************)

VARIABLES cmd, dgen, daligned, hostHead, rt, rtBound, adoptedGen, barrier,
          backoff, readySignal, adoptFailUsed, handoffLeft, crashLeft, sweepTick,
          driftLeft

vars == <<cmd, dgen, daligned, hostHead, rt, rtBound, adoptedGen, barrier,
          backoff, readySignal, adoptFailUsed, handoffLeft, crashLeft, sweepTick,
          driftLeft>>

TypeOK ==
  /\ cmd \in [Commands -> {"none","pending","delivered","direct","lost"}]
  /\ dgen \in [Commands -> 0..MaxGen]
  /\ daligned \in [Commands -> BOOLEAN]
  /\ hostHead \in 1..MaxGen
  /\ rt \in {"absent","starting","running"}
  /\ rtBound \in {"head","member","foreign"}
  /\ adoptedGen \in 0..MaxGen
  /\ barrier \in BOOLEAN
  /\ backoff \in BOOLEAN
  /\ readySignal \in BOOLEAN
  /\ adoptFailUsed \in BOOLEAN
  /\ handoffLeft \in 0..HandoffBudget
  /\ crashLeft \in 0..CrashBudget
  /\ sweepTick \in BOOLEAN
  /\ driftLeft \in 0..DriftBudget

PendingSet == {i \in Commands : cmd[i] = "pending"}
NoneSet == {i \in Commands : cmd[i] = "none"}

(* 发送序 = 索引序（WLOG：UserSend 总取最小 none 索引） *)
MinNone == CHOOSE i \in NoneSet : \A k \in NoneSet : i <= k

(* 队列投递的客观门禁（bridge.deliver）：挡板关 + runtime 就绪且绑定 head *)
QueueGatesOpen == ~barrier
RuntimeOnHead == rt = "running" /\ rtBound = "head"
ViewerPresent == RuntimeOnHead
Aligned == adoptedGen = hostHead
CanDeliver == QueueGatesOpen /\ RuntimeOnHead /\ (Aligned \/ MutateStaleDeliver)

(* 身份采纳成功的条件（换头后显式采纳 / 重启收敛通道）：
   runtime 在位且绑定 head（采纳目标必须存在），注入未烧且无永久失败 *)
CanAdopt == rt # "absent" /\ rtBound = "head"
    /\ (~InjectAdoptFail \/ adoptFailUsed) /\ ~AdoptFailForever

(*************************** actions ***************************************)

(* 用户输入 —— 线程路由（thread 寻址入口恒走此路；runtime 寻址命中 head 同）：
   入箱 + 非 FORCE 即时投递尝试（唯一受退避约束的触发点） *)
SendEnqueue ==
  /\ NoneSet # {}
  /\ LET i == MinNone IN
     IF ~QueueGatesOpen
       THEN /\ cmd' = [cmd EXCEPT ![i] = "pending"]
            /\ UNCHANGED <<dgen, daligned, backoff>>     \* gated no-op：等待不是失败
       ELSE IF CanDeliver
         THEN /\ cmd' = [c \in Commands |->
                          IF c \in PendingSet \/ c = i THEN "delivered" ELSE cmd[c]]
              /\ dgen' = [c \in Commands |->
                          IF c \in PendingSet \/ c = i THEN hostHead ELSE dgen[c]]
              /\ daligned' = [c \in Commands |->
                          IF c \in PendingSet \/ c = i THEN Aligned ELSE daligned[c]]
              /\ backoff' = FALSE                        \* delivered>0 清退避
         ELSE /\ cmd' = [cmd EXCEPT ![i] = "pending"]
              /\ backoff' = TRUE                         \* 队首 retryable 失败 → 线程退避
              /\ UNCHANGED <<dgen, daligned>>
  /\ UNCHANGED <<hostHead, rt, rtBound, adoptedGen, barrier, readySignal,
                 adoptFailUsed, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* 用户输入 —— runtime 寻址未命中 head（缺位 / 历史成员 / 绑定漂移）：
   member → 409 响亮拒收；foreign 且 running → 直投静默落在非 head 会话；
   其余 → 直投无 runtime 可达，响亮失败。不经线程队列，不清偿 pending。 *)
SendRuntimeMiss ==
  /\ NoneSet # {}
  /\ rt = "absent" \/ rtBound # "head"
  /\ LET i == MinNone IN
     /\ cmd' = [cmd EXCEPT ![i] =
                  IF rtBound = "foreign" /\ rt = "running" THEN "direct" ELSE "lost"]
  /\ UNCHANGED <<dgen, daligned, hostHead, rt, rtBound, adoptedGen, barrier,
                 backoff, readySignal, adoptFailUsed, handoffLeft, crashLeft, sweepTick, driftLeft>>

UserSend == SendEnqueue \/ SendRuntimeMiss

(* 打开会话 / C2 恢复 / ensureHead 的统一抽象：为 head 拉起或重绑 runtime。
   activate 语义：拉起立即返回不等 READY（starting 窗口内用户已可输入）。
   重绑（在位进程切回 head）不产生新的 ready 信号——补投只能等下一触发点。 *)
ActivateHead ==
  /\ IF rt = "absent"
       THEN /\ rt' = "starting" /\ rtBound' = "head"
       ELSE /\ rt' = rt /\ rtBound' = "head"
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, adoptedGen, barrier, backoff,
                 readySignal, adoptFailUsed, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* spawn 终局 —— 成功：就绪 + 补投信号 + （按开关）身份注入 *)
SpawnOk ==
  /\ rt = "starting"
  /\ rt' = "running"
  /\ adoptedGen' = IF SpawnInjectsIdentity THEN hostHead ELSE 0
  /\ readySignal' = TRUE
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rtBound, barrier, backoff,
                 adoptFailUsed, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* spawn 终局 —— 失败（崩溃循环轴） *)
SpawnFail ==
  /\ EnableCrash
  /\ ~BoundCrash \/ crashLeft > 0
  /\ rt = "starting"
  /\ rt' = "absent"
  /\ adoptedGen' = 0
  /\ readySignal' = FALSE
  /\ crashLeft' = IF BoundCrash THEN crashLeft - 1 ELSE crashLeft
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rtBound, barrier, backoff,
                 adoptFailUsed, handoffLeft, sweepTick, driftLeft>>

(* 单次 runtime 退出（进程死亡） *)
RtExit ==
  /\ EnableCrash
  /\ ~BoundCrash \/ crashLeft > 0
  /\ rt = "running"
  /\ rt' = "absent"
  /\ adoptedGen' = 0
  /\ readySignal' = FALSE
  /\ crashLeft' = IF BoundCrash THEN crashLeft - 1 ELSE crashLeft
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rtBound, barrier, backoff,
                 adoptFailUsed, handoffLeft, sweepTick, driftLeft>>

(* 宿主重启收割：整棵进程树全灭（service-lifecycle 契约）。与单次退出的
   差别：进程内消费面状态一并丢失——退避清空、未消费 ready 信号丢弃。
   盘上事实（挡板/指令）不受影响。 *)
RestartHarvest ==
  /\ EnableCrash
  /\ ~BoundCrash \/ crashLeft > 0
  /\ rt # "absent"
  /\ rt' = "absent"
  /\ adoptedGen' = 0
  /\ readySignal' = FALSE
  /\ backoff' = FALSE
  /\ crashLeft' = IF BoundCrash THEN crashLeft - 1 ELSE crashLeft
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rtBound, barrier,
                 adoptFailUsed, handoffLeft, sweepTick, driftLeft>>

(* 共享 runtime 绑定漂移：用户在同进程切到无关会话（selectedSessionId 漂移，
    shared-by-project 注册键漂移的同类事实）。预算模式与换头/崩溃一致：
    无界漂移风暴饿死 janitor 两拍收敛（唤醒拍永远追不上漂移速度，
    对账拍永不发生）——D12 之外的第三条饥饿轴。 *)
BindDrift ==
  /\ EnableBindDrift
  /\ ~BoundDrift \/ driftLeft > 0
  /\ rt # "absent"
  /\ rtBound = "head"
  /\ rtBound' = "foreign"
  /\ driftLeft' = IF BoundDrift THEN driftLeft - 1 ELSE driftLeft
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rt, adoptedGen, barrier,
                 backoff, readySignal, adoptFailUsed, handoffLeft, crashLeft, sweepTick>>

(* 退避到期：时间抽象——到期本身不触发任何投递（无内部重试），只是
   解除对后续非 force 消费的短路 *)
BackoffExpires ==
  /\ backoff
  /\ backoff' = FALSE
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rt, rtBound, adoptedGen,
                 barrier, readySignal, adoptFailUsed, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* ready 信号丢失（11-16 迟到就绪补偿之前的语义） *)
ReadyDrop ==
  /\ EnableReadyDrop
  /\ readySignal
  /\ readySignal' = FALSE
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rt, rtBound, adoptedGen,
                 barrier, backoff, adoptFailUsed, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* runtime 就绪补投（handleRuntimeReady）：force 消费——跳过退避检查，
   但失败同样置退避（delivery-consumer 语义）。一次性信号。 *)
ReadyReplenish ==
  /\ readySignal
  /\ readySignal' = FALSE
  /\ IF ~QueueGatesOpen \/ PendingSet = {}
       THEN UNCHANGED <<cmd, dgen, daligned, backoff>>
       ELSE IF CanDeliver
         THEN /\ cmd' = [c \in Commands |->
                          IF c \in PendingSet THEN "delivered" ELSE cmd[c]]
              /\ dgen' = [c \in Commands |->
                          IF c \in PendingSet THEN hostHead ELSE dgen[c]]
              /\ daligned' = [c \in Commands |->
                          IF c \in PendingSet THEN Aligned ELSE daligned[c]]
              /\ backoff' = FALSE
         ELSE /\ UNCHANGED <<cmd, dgen, daligned>>
              /\ backoff' = TRUE
  /\ UNCHANGED <<hostHead, rt, rtBound, adoptedGen, barrier, adoptFailUsed,
                 handoffLeft, crashLeft, sweepTick, driftLeft>>

(* 一次性采纳失败注入（H2 死锁入口）：只烧注入，无其他效果 *)
AdoptAttemptFail ==
  /\ InjectAdoptFail
  /\ ~adoptFailUsed
  /\ adoptedGen # hostHead
  /\ adoptFailUsed' = TRUE
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rt, rtBound, adoptedGen, barrier, backoff,
                 readySignal, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* 显式身份采纳成功（换头后通道 / 重启收敛；采纳目标必须在 head 在位） *)
AdoptSuccess ==
  /\ adoptedGen # hostHead
  /\ CanAdopt
  /\ adoptedGen' = hostHead
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rt, rtBound, barrier, backoff,
                 readySignal, adoptFailUsed, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* 交接窗口：竖挡板。BoundHandoff 把「换头尝试收敛」活性假设显式化——
   无限换头风暴饿死一切依赖挡板关闭的消费（饥饿 lasso 需要精确状态环，
   预算递减会消灭环，故 FALSE 时不递减计数器） *)
BeginHandoff ==
  /\ EnableHandoff
  /\ ~BoundHandoff \/ handoffLeft > 0
  /\ ~barrier
  /\ barrier' = TRUE
  /\ handoffLeft' = IF BoundHandoff THEN handoffLeft - 1 ELSE handoffLeft
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rt, rtBound, adoptedGen,
                 backoff, readySignal, adoptFailUsed, crashLeft, sweepTick, driftLeft>>

(* 换头提交（applySessionSuccession 的事务抽象）：
   head 推进 + 挡板清除 + 在位 runtime 重绑为新 head（successor READY 门
   的单 runtime 抽象）+ 身份归零（successor spawn 不含线程身份，ADR-0047
   阶段 5）+ 事务内采纳尝试（失败不回滚换头——H2 语义保留）+ force 导流。 *)
CommitHead ==
  /\ EnableHandoff
  /\ barrier
  /\ hostHead < MaxGen
  /\ LET newHead == hostHead + 1
         newRtBound == IF rt # "absent" THEN "head" ELSE rtBound
         burn == InjectAdoptFail /\ ~adoptFailUsed /\ rt # "absent"
         newAdopted ==
           IF rt = "absent" THEN 0
           ELSE IF burn THEN 0
           ELSE IF AdoptFailForever THEN 0
           ELSE newHead
         deliverable == rt = "running" /\ newRtBound = "head"
                          /\ (newAdopted = newHead \/ MutateStaleDeliver)
     IN
     /\ hostHead' = newHead
     /\ barrier' = FALSE
     /\ rtBound' = newRtBound
     /\ adoptedGen' = newAdopted
     /\ adoptFailUsed' = (adoptFailUsed \/ burn)
     /\ IF deliverable /\ PendingSet # {}
          THEN /\ cmd' = [c \in Commands |->
                           IF c \in PendingSet THEN "delivered" ELSE cmd[c]]
               /\ dgen' = [c \in Commands |->
                           IF c \in PendingSet THEN newHead ELSE dgen[c]]
               /\ daligned' = [c \in Commands |->
                           IF c \in PendingSet THEN (newAdopted = newHead \/ MutateStaleDeliver)
                           ELSE daligned[c]]
               /\ backoff' = FALSE
          ELSE /\ UNCHANGED <<cmd, dgen, daligned>>
               /\ backoff' = IF PendingSet # {} THEN TRUE ELSE backoff
  /\ UNCHANGED <<rt, readySignal, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* 交接失败收敛：挡板清除、head 不动（挡板不会永久竖起） *)
AbortHandoff ==
  /\ EnableHandoff
  /\ barrier
  /\ barrier' = FALSE
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, rt, rtBound, adoptedGen,
                 backoff, readySignal, adoptFailUsed, handoffLeft, crashLeft, sweepTick, driftLeft>>

(* janitor 唤醒与对账的语义已并入 JanitorActs（单 action 按状态分流）。 *)

(* janitor 扫描的两半（15s 周期定时器，按状态分流——与生产同构）。
   两个 action 都携带 sweepTick' = ~sweepTick 专属哑效果（定时器人格化）：
   生产的定时器扫描绝对发生，不依赖「是否被用户操作代偿」；但 TLA+ 的
   action 是状态对谓词——用户切回（ActivateHead）的重绑效果与 Wake 完全
   重合，重合转移即算 ⟨Wake⟩ 发生，WF 会被无限漂移/切回环代偿满足
   （实测：BindDrift↔ActivateHead 环饿死滞留指令而活性不守）。哑效果使
   任何不带 tick 翻转的转移无法代偿 WF(JanitorActs)（方法论坑 #2，
   与 #1 并列记录于 PendingLeadsToDelivered 注记）。 *)

(* janitor 唤醒（requeue 的 ensureHead 路径，修复前后语义相同）：
   条目缺位（runtime 不在 head：缺进程 / 未就绪 / 绑定漂移）时为 head
   拉起或重绑。重绑不产生 ready 信号——本轮不投递，下一轮对账接管
   （两拍收敛结构是真实的：唤醒拍只管把 runtime 带回 head）。 *)
JanitorWake ==
  /\ sweepTick' = ~sweepTick
  /\ PendingSet # {}
  /\ ~ViewerPresent
  /\ IF rt = "absent"
       THEN /\ rt' = "starting" /\ rtBound' = "head"
       ELSE /\ rt' = rt /\ rtBound' = "head"
  /\ UNCHANGED <<cmd, dgen, daligned, hostHead, adoptedGen, barrier, backoff,
                 readySignal, adoptFailUsed, handoffLeft, crashLeft, driftLeft>>

(* janitor 对账（2026-11-18 修复引入）：条目在位且滞留 → 强制重投
   （force）；仍有滞留且错位 → 重试身份采纳 → 复投。组合 action 一拍
   完成（reconcileStalledDelivery 的抽象）。挡板中 gated no-op。
   修复前语义：EnableReconcile=FALSE 时此 action 不存在。 *)
JanitorReconcile ==
  /\ sweepTick' = ~sweepTick
  /\ EnableReconcile
  /\ PendingSet # {}
  /\ ViewerPresent
  /\ IF ~QueueGatesOpen
       THEN UNCHANGED <<cmd, dgen, daligned, adoptedGen, backoff, adoptFailUsed>>
       ELSE IF Aligned \/ MutateStaleDeliver
         THEN /\ cmd' = [c \in Commands |->
                          IF c \in PendingSet THEN "delivered" ELSE cmd[c]]
              /\ dgen' = [c \in Commands |->
                          IF c \in PendingSet THEN hostHead ELSE dgen[c]]
              /\ daligned' = [c \in Commands |->
                          IF c \in PendingSet THEN Aligned ELSE daligned[c]]
              /\ backoff' = FALSE
              /\ UNCHANGED <<adoptedGen, adoptFailUsed>>
         ELSE IF InjectAdoptFail /\ ~adoptFailUsed
           THEN /\ adoptFailUsed' = TRUE        \* 烧注入，本轮无进展，下轮重试
                /\ backoff' = TRUE              \* 首次 force 失败已置退避
                /\ UNCHANGED <<cmd, dgen, daligned, adoptedGen>>
           ELSE IF AdoptFailForever
             THEN /\ backoff' = TRUE
                  /\ UNCHANGED <<cmd, dgen, daligned, adoptedGen, adoptFailUsed>>
             ELSE /\ adoptedGen' = hostHead     \* 采纳成功 → 复投全清
                  /\ cmd' = [c \in Commands |->
                              IF c \in PendingSet THEN "delivered" ELSE cmd[c]]
                  /\ dgen' = [c \in Commands |->
                              IF c \in PendingSet THEN hostHead ELSE dgen[c]]
                  /\ daligned' = [c \in Commands |->
                              IF c \in PendingSet THEN TRUE ELSE daligned[c]]
                  /\ backoff' = FALSE
                  /\ UNCHANGED <<adoptFailUsed>>
  /\ UNCHANGED <<hostHead, rt, rtBound, barrier, readySignal, handoffLeft, crashLeft, driftLeft>>

JanitorActs == JanitorWake \/ JanitorReconcile

Next ==
  \/ UserSend
  \/ ActivateHead
  \/ SpawnOk \/ SpawnFail
  \/ RtExit \/ RestartHarvest
  \/ BindDrift \/ BackoffExpires \/ ReadyDrop
  \/ ReadyReplenish
  \/ AdoptAttemptFail \/ AdoptSuccess
  \/ BeginHandoff \/ CommitHead \/ AbortHandoff
  \/ JanitorActs

Init ==
  /\ cmd = [i \in Commands |-> "none"]
  /\ dgen = [i \in Commands |-> 0]
  /\ daligned = [i \in Commands |-> FALSE]
  /\ hostHead = 1
  /\ rt = "absent"
  /\ rtBound = "head"
  /\ adoptedGen = 0
  /\ barrier = FALSE
  /\ backoff = FALSE
  /\ readySignal = FALSE
  /\ adoptFailUsed = FALSE
  /\ handoffLeft = HandoffBudget
  /\ crashLeft = CrashBudget
  /\ sweepTick = FALSE
  /\ driftLeft = DriftBudget

Spec == Init /\ [][Next]_vars

(* 公平性假设（显式化）：
    - 挡板收敛：交接事务最终 commit 或 abort（SuccessionWindow 域）
    - janitor 周期扫描持续发生（15s 一拍）——由 sweepTick 翻转人格化：
      生产的定时器扫描是绝对发生的机制，不依赖「是否被用户操作代偿」；
      但 TLA+ 的 action 是状态对谓词——用户切回（ActivateHead）的重绑
      效果与 Wake 完全重合，重合转移即算 ⟨JanitorActs⟩ 发生，WF 会被
      无限漂移/切回环代偿满足（实测：BindDrift↔ActivateHead 环饿死滞留
      指令而活性不守）。两个 janitor action 都携带 tick 翻转哑效果，
      代偿通道即被切断（方法论坑 #2，与 #1 并列记录于 PendingLeadsToDelivered）
    - ready 信号总会被补投消费（事件循环不丢拍；ReadyDrop 关掉此假设的
      历史形态另由 EnableReadyDrop 表达）
    - spawn 终局必然发生（starting 不悬停）；Ok 还是 Fail 由环境决定 *)
Fairness ==
  /\ WF_vars(AbortHandoff)
  /\ (JanitorFairness => WF_vars(JanitorActs))
  /\ (DeliverFairness => WF_vars(ReadyReplenish))
  /\ (SpawnFairness => WF_vars(SpawnOk \/ SpawnFail))
LiveSpec == Spec /\ Fairness

(*************************** properties ************************************)

(* 安全：队列送达只在投出时刻的 head 代际上（ghost dgen 记录） *)
DeliveredAtOrBeforeHead ==
  \A i \in Commands :
    cmd[i] = "delivered" => /\ dgen[i] >= 1 /\ dgen[i] <= hostHead

(* 安全：队列送达时刻身份对齐（fencing 语义；MutateStaleDeliver 击穿） *)
DeliveredOnlyWhenAligned ==
  \A i \in Commands :
    cmd[i] = "delivered" => daligned[i]

(* 安全：队列内 FIFO 无超车——后发指令经队列送达时，更早的入箱指令
   不可能仍 pending（FIFO + retryable break 的数学后果；应恒成立） *)
QueueFIFO ==
  \A i, j \in Commands :
    (i < j /\ cmd[j] = "delivered") => cmd[i] # "pending"

(* 探针（预期可达 = 不变式被击穿）：跨路径超车——更早入箱的指令还在
   pending，更晚的输入已经直投落在 runtime 当前会话（wt-1ab8a75b 的
   「10:09 新消息秒达而旧 4 条纹丝不动」形态）。暴露的是：线程 FIFO
   保证不跨路径成立，直投既不清偿也不保序。 *)
NoCrossPathOvertake ==
  \A i, j \in Commands :
    (i < j /\ cmd[i] = "pending") => cmd[j] # "direct"

(* 探针（预期可达）：输入静默落错地方——用户对着线程 head 会话发言，
   消息经直投落在漂移后的无关会话（"direct" 终态即证据） *)
NoOffThreadDirect ==
  \A j \in Commands : cmd[j] # "direct"

(* 死锁可达性（安全形式）：fencing 错位现场——runtime 在位绑定 head、
   身份错位、指令滞留、修复前语义（janitor 对此无 action） *)
DeadlockFencing ==
  /\ PendingSet # {}
  /\ rt = "running" /\ rtBound = "head"
  /\ ~Aligned
  /\ ~EnableReconcile
NotDeadlockFencing == ~DeadlockFencing

(* 全绿滞留现场（安全形式）：一切客观条件健康（runtime 在位绑定 head、
   身份对齐、挡板关、退避已过、无待消费信号）而指令滞留、修复前语义
   ——触发面上没有任何 action 会对这条指令负责。这是 wt-1ab8a75b
   09:52→11:24 静默窗口的精确形状：不是门敲不开，是没有人再敲门。 *)
StalledHealthy ==
  /\ PendingSet # {}
  /\ rt = "running" /\ rtBound = "head"
  /\ Aligned /\ ~barrier /\ ~backoff /\ ~readySignal
  /\ ~EnableReconcile
NotStalledHealthy == ~StalledHealthy

(* 活性：每条 pending 指令终达 delivered（leads-to）。
   方法论注记（首版踩过的坑）：不要写成 <>(\A i : cmd[i] # "pending")
   ——其否定从 Init 起不可满足，TLC 会永远报告通过。 *)
PendingLeadsToDelivered ==
  \A i \in Commands : (cmd[i] = "pending" ~> cmd[i] = "delivered")

=============================================================================
