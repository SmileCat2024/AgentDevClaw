# Coder 线程状态矩阵与测试体系

> 活文档。线程（WorkThread）是接续编排、归档事务、调度投递、重启收敛四个子系统的交汇点，本文件把「状态 × 事件」的每个格子钉死，作为测试建设的锚——测试按格子 ID 对齐，禁止无格补测、禁止格子无锚漂移。
>
> 权威实现：框架状态机在 `AgentDev/packages/core/src/core/workthread/core.ts`（状态机内核 + 锚点转换表，ADR-0021）；Claw 装配层在 `server/thread-control/`。本文只记录语义与覆盖索引，不复制实现。

## 1. 状态轴

| 轴 | 取值 | 权威载体 | 说明 |
|---|---|---|---|
| A1 status | `open` / `rotating` / `rotation_failed` / `closed` | `WorkThreadRecord.status` | `closed` 为硬终态（K3） |
| A2 hold | `false` / `true` | `WorkThreadRecord.hold` | 伴随字段门禁（K9），归档 seal 先落 hold |
| A3 挡板 | `absent` / `fresh`(<5min) / `stale`(≥5min) | `WorkThreadRecord.pendingSuccession` | freshness 判定 `isHandoffActive`：**只看 startedAt 与 HANDOFF_STALE_MS(5min)，不看 status** |
| A4 指令 | `pending` / `delivered` / `failed` / `cancelled` | `WorkThreadCommand.status` | cancelled 是意图终态，永不覆写 |
| A5 归档 | `active` / `archived` | Claw `ThreadArchiveIndex` | 独立于 status 的轴；`archived` 隐含 `hold=true`（seal 事务落下） |
| A6 runtime | head 在 / head 不在 | server 内存注册表 | 非持久态；调度入口的唤起闸依赖它 |
| A7 lifeState | `executing` / `pending-commands` / `idle`（+failed 标志） | Claw `synthesizeThreadLifeState` | A1+A4+A6 的合成投影，仅用于路由守卫与 UI |

指令 kind 补充轴（`user_message` / `system_continuation` / …）：`system_continuation` 由接续编排播种（R3），对投递门禁无特赦——挡板期间同样 pending。

## 2. 事件轴

| 事件 | 入口 | 说明 |
|---|---|---|
| E1 begin | `core.beginSessionHandoff` | 接续开始：竖挡板 + status→rotating + R3 播种，同笔原子。`seedContinuation=false` 免播（Claw 手动接续路径：精简/摘要变换后新 head 停住，不自动续跑；自动接续 thread-rotation 缺省播种）；免播时 continuationPolicy 不参与 |
| E2 fail | `core.failSessionHandoff` | 接续失败落账：→rotation_failed，**挡板保留**（供 resume 查 stage） |
| E3 complete | `core.advanceHead` | 提交点：head CAS 推进 + 清挡板 + 回 open |
| E4 deliver | `core.deliverPendingCommands` | 投递 pending 指令（K20 逐条重读） |
| E5 append | `core.appendCommand` | 新指令入箱（幂等键去重） |
| E6 archive / unarchive | Claw `thread-lifecycle.js` | 归档 seal 事务 / 恢复 |
| E7 close | `core.closeThread` | 无守卫终态化（Claw 归档不走此路，走 hold 语义） |
| E8 restart | Claw `convergeInterruptedSuccessions` | server 重启扫描收敛 |

## 3. 核心矩阵

格子 ID：`M<事件>[-<子场景>]-<状态签名>`（O=open, R=rotating, RF=rotation_failed, C=closed；F=fresh挡板, S=stale挡板, ∅=无挡板, *=任意）。**空白格 = 不可能组合或无需锁定**。

### 3.1 E1 begin（守卫序：closed → hold → rotating+fresh(R8) → head_mismatch）

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M1-O-∅ | open, hold=F, 无挡板, head=from | ✓ →rotating + 挡板fresh + R3 播种（同笔原子；策略抛错=整体失败不留半套挡板） | 框架 core.test 825/840/851；Claw succession T002 |
| M1-O-H | open, hold=T | ✗ `thread_held`（K9） | 框架 750 |
| M1-R-F | rotating, 挡板fresh | ✗ `handoff_in_progress`（R8 单飞） | 框架 797；Claw rotation「begin gate rejects」 |
| M1-R-S | rotating, 挡板stale | ✓ 覆写重开（stale 视为无交接，恢复重走） | 框架 811 |
| **M1-RF-F** | **rotation_failed, 挡板fresh** | **✓ 覆写**（R8 只拦 `status==='rotating'`，**F2 锁定：反直觉，严禁顺手修正**） | 框架 958（RF→rotating）；Claw `thread-state-matrix` G1 |
| M1-RF-S | rotation_failed, 挡板stale | ✓ 覆写 | 同上 |
| M1-RF-∅ | rotation_failed, 挡板被懒清/abort | ✓ 正常 begin | 框架（隐含） |
| M1-C-* | closed | ✗ `thread_closed`（硬终态） | 框架 391/401 |
| M1-*-MM | head ≠ fromSessionId | ✗ `head_mismatch` | 框架 356/381 |
| M1-R3 | begin 播种幂等键 `succession:<tid>:<from>` | 同一移交易重走不重复播种；跨移交易（head 换代后再接续）新播一条；`seedContinuation=false` 的 begin（Claw 手动接续）不占用也不产生播种 | 框架 825；R3 语义 |

### 3.2 E2 fail（守卫：closed 硬拒；无挡板 = 迟到者无立卷资格）

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M2-R-F | rotating, 挡板存在 | ✓ →rotation_failed，**挡板保留**，stage 补写 | 框架 720；Claw rotation「marks rotation_failed」 |
| **M2-RF-F** | **rotation_failed, 挡板仍在（重复 fail）** | ✓ 再落一条 handoff_failed 事件，stage 可改写（**F2 锁定**） | 框架 921 |
| M2-O-F | open + 挡板（构造态） | ✓ 落卷 rotation_failed（守卫**不查 status**，F2 锁定勘误锚） | 框架 942 |
| M2-*-∅ | 无挡板 | no-op（已成功推进/从未开始，迟到失败者无资格） | 框架 880/893 |
| M2-C-* | closed | no-op 零写入（K3/C8：迟到失败不得覆写终态） | 框架 869 |

### 3.3 E3 complete（守卫：closed → hold → head CAS → already_head → duplicate_session）

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M3-R-F-OK | rotating, successor READY | ✓ →open + head 推进 + 链追加 + 清挡板 + staged 指令投新 head | Claw succession T002「READY committed」 |
| M3-GATE | successor 未 READY | ✗ 提交拒绝 → fail 落账（stage=successor_ready）+ 挡板收敛，旧 head 权威 | Claw succession T002「not-READY rejected」「old head authoritative」 |
| M3-RACE | 并发提交 head 竞速输家 | void（非失败落账），赢家提交为准 | Claw succession T002「losing race is a void」 |
| M3-*-H | hold=T | ✗ `thread_held`（hold 同样门禁完成） | 框架 764/780 |
| M3-MM | head CAS 失败 | ✗ `head_mismatch` | 框架 356 |

### 3.4 E4 deliver（入口序：closed → hold → 挡板；循环内 K20 逐条重读四门禁）

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M4-O-∅ | open, 无挡板, head 在 | ✓ 投递 | 框架 669；consumer FIFO |
| M4-C-* | closed | ✗ `thread_closed` 停 | 框架 600 |
| M4-*-H | hold=T | ✗ `thread_held` 停 | 框架 623 |
| **M4-R-F** | **rotating, 挡板fresh** | ✗ `handoff_in_progress`，指令保持 pending 等接续后导向新 head | 框架 610/669；consumer「no-op 不退避」 |
| **M4-RF-F** | **rotation_failed, 挡板fresh** | ✗ **同样挡投递**（`isHandoffActive` 不看 status——失败事实还在窗口内，优先重试接续而非往旧 head 投） | Claw `thread-state-matrix` G2 |
| M4-R-S | rotating, 挡板stale | 懒清理（→open）后照常投 | 框架 644 |
| **M4-RF-S** | **rotation_failed, 挡板stale** | 懒清理（**status 保持 rotation_failed**，F2 锁定）后照常投旧 head | 框架 972；Claw `thread-state-matrix` G2 |
| M4-K20-head | 循环中 head 换代 | `head_changed` 停（剩余 pending 交下个触发点，不盲投旧棒） | 框架（K20 语义） |
| M4-K20-cancel | 循环中指令被 cancel | 跳过该条，不覆写终态 | 框架 831；Claw lifecycle「cancels pending appended concurrently」 |
| **M4-R3-VOID** | **R3 唤醒指令（幂等键 `succession:<tid>:<from>`）待投且 head 仍 == 播种 from** | 作废：`succession_precondition_violated`（FAILED 不可重试）——措辞前提「上下文已精简接续」在 head 未推进时为假，不得宣读给从未精简的旧 head（wt-58471cd9 事故链）；普通 pending 指令照常投。FAILED 不占幂等键，重试接续（同 from 再 begin）重新播种 | 框架 workthread-core「voids the seeded succession instruction」；Claw succession「after READY-gate failure」 |

### 3.5 E5 append

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M5-O-* | open（含挡板期） | ✓ 入箱；挡板期保持 pending，接续完成导向新 head | 框架 424；Claw `thread-state-matrix` G4 |
| M5-C-* | closed | ✗ `thread_closed` | 框架 448；Claw routes 116 |
| M5-IDEM | 同幂等键 | no-op 返回既有指令 | 框架 424/513 |
| M5-KIND | 未知 kind | ✗ 400（封闭词表，无静默降级） | 框架 460 |

### 3.6 E6 archive（Claw seal 事务；顺序：归档标记先落 → seal 单笔 → runtime 停止 best-effort → 事件）

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M6-OK | open, 无挡板 | 标记先落（期间新 send 拒）→ seal：hold=T + pending 指令批量 cancelled + archived 事件 | Claw lifecycle「seals atomically」 |
| **M6-R-F** | **rotating, 挡板存在** | seal 内：挡板清 + status→open + `handoff_aborted` 事件（stage=archived）；pending 照常取消 | Claw lifecycle（converge in one write） |
| **M6-RF-F** | **rotation_failed, 挡板存在** | 挡板清 + **status 保持 rotation_failed**（与 M4-RF-S 懒清理同语义）；事件照落 | Claw `thread-state-matrix` G3 |
| M6-IF | delivered 指令（包含 runtime 执行中） | **不取消**（已下沉 runtime 的调用自然完成，hold 保证不再消费下一条） | Claw lifecycle |
| M6-C | closed | ✗ `thread_closed`（Claw 层拒绝归档终态） | lifecycle 75 |
| M6-PARTIAL | runtime 停止失败 | cleanup `partial` + failures 落账（不回滚归档） | Claw lifecycle「partial cleanup」 |
| M6-UNARCH | unarchive | setHold(false) 恢复可调度；cancelled 指令**不复活**；不自动拉 runtime | Claw lifecycle「unarchive restores」 |
| M6-ARCHIVED | archived 线程收新指令 | ✗ 409 `thread_archived`（标记先于 seal 生效） | life-state routes；dispatch-recovery |

### 3.7 E8 restart（`convergeInterruptedSuccessions`：状态判定非时间判定——**挡板非空即 interrupted**）

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M8-R-F | rotating, 挡板fresh（崩溃残留） | 失败事实先落（fail + stage）→ 挡板收敛（abort）→ 旧 head 权威 | succession「fresh interrupted converged」 |
| M8-HEAD-GONE | 挡板在 + 旧 head 会话已失 | pending 指令显式 `failed`（lastReason=head_session_missing），**永不投向未知目标** | succession「unusable old head」 |
| M8-STAGE | 挡板带 stage | stage 透传落账 | succession「stage carried through」 |
| **M8-RF-F** | **rotation_failed, 挡板仍在（已失败已落账）** | **同样收敛**：再落一条 handoff_failed（reason=restart_convergence）+ 清挡板 + status 保持 RF。重启使 fresh 挡板失效——投递恢复 | G5 |
| M8-∅ | 无挡板（含纯 open / RF-∅） | 不动 | succession「untouched」（仅 RF-∅ 外加 open 隐含） |
| M8-C-* | closed | 跳过 | 实现锚 334 行 |

### 3.8 调度视角（HTTP `/protoclaw/threads/:id/commands` + input；coder dispatch / `claw threads` / ACP 消费面）

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M8D-RUNTIME-OUT | head runtime 不在 | 唤起闸 ensureHeadRuntime：唤起成功→投递；**唤起失败→仍入箱 + 响应带 runtimeWake 失败事实**（调用方不误读为正常暂存） | dispatch-recovery 全套 |
| M8D-R-F | rotating 挡板期 dispatch | 指令 ✓ 入箱保持 pending（M5-O-*），投递被挡（M4-R-F）；接续完成后自动导向新 head | Claw `thread-state-matrix` G4（调度链路） |
| M8D-RF | rotation_failed 挡板期 dispatch | 入箱 ✓；投递视挡板 freshness（M4-RF-F/RF-S） | Claw `thread-state-matrix` G2 联动 |
| M8D-ARCHIVED | archived | ✗ 409 `thread_archived` | life-state / dispatch-recovery |
| M8D-EXEC | executing（runtime 忙） | 入箱 ✓（排队语义，不拒） | routes 54 语义；前端 await surface |
| M8D-RESTART | server 重启后 dispatch 到既有线程 | t007 读回链：记录/head/链/Inbox/board 可读可继续服务 | t007 |

### 3.9 lifeState 合成（A1+A4+A6 → 路由守卫/UI）

优先级 `executing > pending-commands > idle`；`closed` 过滤值；`rotation_failed` → failed 标志（不改变可调度性）。覆盖：life-state.test Q4/Q5；前端 badge/await surface 系列。

### 3.10 执行关联事实（ADR-0031，不新增线程状态）

提交回执、投递成功与执行完成是不同事实。`sourceRef` 关联触发指令，`consumedSourceRefs` 记录 busy 时并入当前轮的指令；两者都随失败、取消保留。挂起轮的 `pendingWakeups` 是当时等待快照，不能据任意 `turn.completed` 或 idle 推断业务完成。

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M8D-EXEC-REF | M8D-EXEC，当前轮执行中追加指令 | 追加指令可并入同轮，终态携带其 `consumedSourceRefs`，不要求独立 turn | Claw `thread-association-chain` busy-time；框架 `turn-source-association` |
| M8D-SUSPEND-REF | 执行轮挂起，后续 reminder 入箱 | 原轮保留等待快照；新指令以 `originSourceRef` 保留通知事件身份，metadata 保留工作引用，重放事件不重复入箱 | Claw `thread-association-chain` suspended、`input-gateway-queue` notice identity；框架 `association-chain` |
| M8D-ROTATE-REF | 已投递指令执行中被接力打断 | 旧 head 落 `turn.cancelled` 并保留指令身份，不伪报完成；观察器经 sessionChain 和接续指令关联后继落定 | Claw `thread-association-chain` succession interrupt、`coder-monitor` M8D-ROTATE-REF |
| M8D-PENDING-REF | pending 指令穿过 head 换代 | 投递到新 head，仍以原 commandId 关联事件 | 框架 `association-chain` succession |

### 3.11 Coder 监视链路（M9，ADR-0031）

本节覆盖 §3.10 执行关联事实的消费链路，不新增线程状态。权威实现为 `coder-shell.ts`（提交与目标选择）、`thread-routes.js`（事件窗口）、`coder-monitor.ts`（关联与终态）、`coder-shell-feature.ts`（通知、连续性与面板装配）及 `bg-panel.js`（呈现）。

**线程状态测试不能替代 HTTP → 监视 → 通知 → 面板的组合测试。** 空窗口必须与非空窗口遵守同一响应契约。历史漏检：路由测试曾将缺少 `baseOffset` 的空响应固化为预期，消费端测试却始终手写完整响应，两端分别通过而组合失败。

#### 状态轴与判据

- **提交**：拒绝 / 已入箱 pending / 已投递 delivered / 指令 failed 或 cancelled；`--dispatch-only` 不登记观察。回执不是业务结果。
- **读取**：首读或已初始化；board 未创建 / 空窗口 / 有事件 / 裁剪后窗口；成功 / 404 / 网络或协议错误。HTTP 空窗口也必须返回 `events: []、baseOffset: 0、cursor: 0`；`cursor = baseOffset + 保留事件总数`，不是本次切片长度。
- **关联执行**：pending / executing / suspended / rotating / completed / cancelled；身份是 threadId + commandId，唤醒还须匹配 source + workId + session，接力须匹配 sessionChain + system_continuation。idle、旧轮结果、无关失败均不能代替本次结果。
- **观察**：活跃 / 已终止 / 已销毁；终止原因区分业务失败、阻塞、失联。首读失败立即显式结束；初始化后连续三次读失败才结束，成功重置计数。空窗口与协议缺字段分别属于正常读取与协议错误，不靠重试混淆两者。
- **通知**：queued / inflight / delivered / unsent。业务终态与通知送达独立：未交付事实仍占 pending；补取不重派，重复观察不重复通知。
- **连续性**：首次启动无意图 / 有旧意图但无观察资源 / 显式重建。恢复意图不是恢复连接；失效提示只发一次，但尚未重建的意图不能因再次保存而丢失。
- **面板**：可选、只读、按通道四元组隔离；事件发布与 list 快照互为对账来源。断线不改业务状态。观察重建后的版本必须能替代旧投影；迟到旧版本不能覆盖新结果。

事件包括 send/watch、轮次开始/完成/失败/取消、reminder 入箱、head 推进、读失败/恢复、通知交付/补取、capture/restore/dispose、SSE/list 到达和会话切换。只枚举有不同行为的等价类，不对所有轴做无意义笛卡尔积；格中并列取值须参数化覆盖。

#### 测试层级

- **R** `test/coder-monitor-routes.test.js`：真实 WorkThread/Store/Board + 真实路由 + Feature/工具/监视器/BackgroundAccess + 面板发布。替换 runtime 执行、HTTP 传输和通知收件器，不手写正常事件响应。删除场景在 `core.getThread` 读接缝返回不存在；裁剪场景播种隔离的持久化窗口，再经真实 Board 追加触发裁剪；均不读写真实用户数据。
- **M** `local-features/capability-shell/test/coder-monitor-matrix.test.ts`：真实监视器与 BackgroundAccess，注入事件序列、可控读闸门和 mock timers，验证分支、交错与通知结算。
- **F** `local-features/capability-shell/test/coder-monitor-feature-matrix.test.ts`：真实工具和 Feature 生命周期，验证协议拒绝、待命、恢复与面板发布。
- **U** `test/frontend-bg-panel.test.js`：真实前端 JS 在 VM 中消费事件与列表；不启动浏览器，不冒充浏览器验收。
- 既有 `coder-monitor-http.test.ts` 只证明 HTTP 传输和显式收件会话；既有 `thread-association-chain.test.js` 证明 Agent/仲裁器到 Board 的生产端身份。二者不能替代 R。

| 格 | 前置 / 事件 | 必须证明的结果（含禁止行为） | 测试层 |
|---|---|---|---|
| M9-EMPTY | send 首次观察在首条事件之前或之后 | 空窗口契约完整，submitted/executing，不误失联；随后取得真实完成报告 | R |
| M9-DISPATCH | dispatch-only 后显式 watch | 提交时无观察/面板项，watch 补建，不新增指令 | R |
| M9-IDEMPOTENT | 同键重发 + 重复 watch | Inbox、runtime 投递、观察各一份，终态通知不重复 | R |
| M9-PENDING | 投递暂缓后恢复 | pending 不是完成；deliver 后同 commandId 关联结果 | R |
| M9-WATCH-LATEST | 同线程多次派发后裸 watch | 每线程只观察最新 coder_shell 指令；--command 仍可精确观察历史，不重放全部旧报告 | R、adapter |
| M9-RESULT-TURN | 同一轮有过程说明和最终报告 | --turn 取该轮最后一条回复；不把第一条过程说明当交付报告 | R、adapter |
| M9-TERMINAL | 关联 turn.completed / failed / cancelled | 分别 completed / failed / cancelled；保留结果或错误，非监视失联 | R |
| M9-BUSY | 指令并入另一轮 consumedSourceRefs | 真实 Board 透传身份，按本次指令落定，不要求独立 turn | R |
| M9-SUSPEND | 挂起→进度唤醒仍挂起→最终唤醒 | 中间无完成通知；taskIds/workIds 关联到本次最终报告 | R、M |
| M9-ROTATE | 执行中取消或挂起→接力换 head | 真实链与接续指令带到后继；不把中断或接力中间态当完成 | R、M |
| M9-PENDING-ROTATE | 接力挡板期间 send pending | head 推进后仍关联原 commandId，不提前失联 | R |
| M9-CLOSED | 观察中归档 / 关闭 / 删除 | 明确 thread_archived / thread_closed / thread_deleted，均不伪报成功 | R |
| M9-WINDOW | 初次与增量读取裁剪窗口 | 保留身份可重放；读过边界等于 baseOffset 可继续；越过未读区 association_lost | R、M |
| M9-REWIND | 已读 cursor 后 board 流回退 | 显式 association_lost，不能静默回退游标继续假监视 | R、M |
| M9-PROTOCOL | 传输缺事件数组 / cursor / baseOffset / thread | 提交保留；首读 monitor_unreachable + monitor_lost，明确协议错误，不重派 | F |
| M9-READ-ERROR | 首读失败；初始化后 1/2/3 次失败及中间成功 | 首读立即失联；后续不足三次保持观察，成功重置，第三次终止且只通知一次 | M |
| M9-UNRELATED | 同线程旧轮、其他命令完成/失败/取消 | 不推进目标、不取无关报告，不产生假终态 | M |
| M9-WAKE-IDENTITY | reminder 的 source/workId/session/kind 不匹配 | 任一身份不匹配均不完成原等待；正确 taskIds/workIds 才能关联 | M |
| M9-WAKE-MISSING | suspended 缺 pendingWakeups | association_lost，不能永等或伪完成 | M |
| M9-REPORT | 报告跨读取分段、同 session 不同 turn、无报告 | 只取关联 session+turn；缺报告明确补取，不混入旧回复 | M |
| M9-PARTITIONS | 同一挂起/接力事件序列的全部相邻分段 | 单批与任意 poll 分段结果一致，且终态只一次 | M |
| M9-RUNTIME | 无 runtime 且未完成；正常长工具；接力窗口 | 直接缺失报 runtime_unavailable；正常长工具和接力无误报；已证完成优先 | M |
| M9-COMMAND | 指令 failed / cancelled | failed / cancelled，不当作 monitor_lost；含 lastReason | M |
| M9-CONCURRENT | 同身份并发 observe，读仍在途 | 合并一次读取、一个 pending、一条终态；不同身份互不串联 | M |
| M9-NOTICE | 终态通知 queued / inflight / delivered / unsent→补取 | 未送达保留 pending 和连续性意图；送达或补取后释放，不丢、不重复发送业务 | M |
| M9-REBUILD | 可恢复失联且通知已送达或补取 | 显式 watch 重建，版本连续、不留 endedAt，不新增业务指令 | M、F |
| M9-DISPOSE | 读在途销毁；销毁后迟到响应 | abort/释放 provider 和计时资源，无迟到投影/新通知，不停止业务 | M、F |
| M9-STANDBY | send；watch 活跃或已完成；下一轮 CallStart | send 不主动待命；watch 活跃仅一次，完成不空等，旧意图不影响新输入 | F |
| M9-RESTORE | 无意图启动；旧意图恢复；提示后再 capture/restore；重新 watch | 首次无误报，旧连接不假恢复；意图跨再次接续保留，重建收敛为活跃/完成 | F |
| M9-PANEL-FAIL | 面板关闭、未装配、发布失败 | 执行/监视/通知继续，list 可取真实结果，无业务控制按钮 | F、U |
| M9-UI-STATES | 各智能体状态的事件与列表 | 状态文案、颜色类、活跃徽标正确，失联不等于业务失败，智能体无 kill/report | U |
| M9-UI-ORDER | SSE 新事件与迟到 list、旧 revision，重建新版本 | 新状态不倒退；重新观察替代旧失联卡；同版本幂等应用 | U |
| M9-UI-ISOLATION | 通道断开/重连、来源消失、会话切换、关闭重开 | 断线只改连接提示；对账修复成员；关闭继续缓存，跨会话不串台 | U |

以上测试层的锚点需带格子 ID；`test/coder-monitor-matrix-contract.test.js` 校验本表与测试 ID 的双向对应、路径存在。该检查只阻止漏挂锚和文档漂移，**不证明断言正确**；断言须检查目标状态、通知/pending、派发次数，跨层格不得以手写成功响应替代真实生产者。

## 4. F2 反直觉锁定清单（改动状态机前必读，严禁"顺手修正"）

| # | 行为 | 锚 |
|---|---|---|
| F2-1 | rotation_failed + fresh 挡板上 begin **放行覆写**（R8 单飞只拦 rotating） | core.ts 142-143；框架测试 958 |
| F2-2 | fail 守卫不查 status（open+挡板构造态也落卷 RF） | core.ts 144-145；框架测试 942 |
| F2-3 | 挡板清理后 rotation_failed **status 保持**（不回 open） | core.ts 150-151；框架测试 972 |
| F2-4 | RF 上重复 fail 允许（再落事件，stage 可改写） | 框架测试 921 |

这四条是刻意的失败路径宽松性：失败态的恢复优先级高于单飞纪律（M1-RF-F 覆写即"立即重试接续"）。

## 5. 测试体系与覆盖索引

| 层 | 文件 | 覆盖格子群 |
|---|---|---|
| 框架 | `AgentDev/packages/core/test/workthread/workthread-core.test.ts` | M1/M2/M4/M5 全格 + F2 全部 + K20 |
| 框架 | `workthread-store/board/bridge/differential` | 持久化/看板/桥/差分 |
| Claw | `test/thread-succession.test.js` | M3 全部、M8-R-F/HEAD-GONE/STAGE/∅ |
| Claw | `test/thread-rotation.test.js` | E1 入口（guard 事件→编排）、策略分派 |
| Claw | `test/thread-lifecycle.test.js` | M6-OK/IF/PARTIAL/UNARCH |
| Claw | `test/thread-life-state.test.js` | §3.9 合成、M6-ARCHIVED 守卫 |
| Claw | `test/thread-dispatch-recovery.test.js` | M8D-RUNTIME-OUT 全套 |
| Claw | `test/t007-thread-restart-recovery.test.js` | M8D-RESTART 读回链 |
| Claw | `test/thread-archive-cancellation.test.js` | M6 与执行轮打断 |
| Claw | `test/coder-rotation-e2e.test.js` | 策略三档端到端（guard 入口→handoff→提交） |

### 已补齐的历史缺口

以下 G 编号保留作历史索引，均由 `test/thread-state-matrix.test.js` 锁定；不再表示当前缺测：

- G1 = M1-RF-F/S 在 Claw 编排层（接续失败后立即重试：begin 覆写成功流转）
- G2 = M4-RF-F / M4-RF-S 在 Claw 投递消费层（失败态挡板：fresh 挡投 / stale 懒清后投旧 head）
- G3 = M6-RF-F（rotation_failed 中归档：挡板清 status 保持）
- G4 = M8D-R-F 端到端（挡板期 dispatch 指令 → 接续完成 → 指令+R3 播种导向新 head，全程不丢不重）
- G5 = M8-RF-F（重启收敛扫描对已失败挡板的再收敛）

### 监视链路验证入口与边界

```bash
npm run build:local-features
node --test test/coder-monitor-matrix-contract.test.js test/coder-monitor-routes.test.js test/frontend-bg-panel.test.js local-features/dist/capability-shell/test/coder-monitor*.test.js local-features/dist/capability-shell/test/coder-shell.test.js
```

扩大验证时同时运行 `test/thread-state-matrix.test.js`、`test/thread-association-chain.test.js`、`test/coder-acp-routes.test.js`、`test/thread-dispatch-recovery.test.js` 及 thread 生命周期、通知队列相关测试。单独运行矩阵锚点检查不算行为验收。

这些测试不调用真实模型，不覆盖真实进程崩溃、网络代理、浏览器 DOM 布局或在线服务重启。线上冒烟仍须确认新线程在首条执行事件之前能够建立监视、任务完成后收到通知且面板落定；隔离测试通过不能替代该项验收。

## 6. 维护约定

1. 新增状态轴取值或事件：先在本文建格（预期行为 + 实现锚点），再写测试，用例名携带格子 ID。
2. 发现行为与矩阵格不符：先判实现 bug 还是矩阵过时——F2 清单内的差异按实现 bug 处理（框架锁定），清单外先对齐语义再动代码。
3. 严禁删除 F2 锁定格的测试；重构状态机（如再迁移 state-kernel）必须保持差分测试等价。
4. 本文记录的行号是语义锚点（找代码用的路标），不是契约；契约是行为描述本身。
