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
| A4 指令 | `pending` / `delivered` / `in_flight` / `failed` / `cancelled` | `WorkThreadCommand.status` | cancelled 是意图终态，永不覆写 |
| A5 归档 | `active` / `archived` | Claw `ThreadArchiveIndex` | 独立于 status 的轴；`archived` 隐含 `hold=true`（seal 事务落下） |
| A6 runtime | head 在 / head 不在 | server 内存注册表 | 非持久态；调度入口的唤起闸依赖它 |
| A7 lifeState | `executing` / `pending-commands` / `idle`（+failed 标志） | Claw `synthesizeThreadLifeState` | A1+A4+A6 的合成投影，仅用于路由守卫与 UI |

指令 kind 补充轴（`user_message` / `system_continuation` / …）：`system_continuation` 由接续编排播种（R3），对投递门禁无特赦——挡板期间同样 pending。

## 2. 事件轴

| 事件 | 入口 | 说明 |
|---|---|---|
| E1 begin | `core.beginSessionHandoff` | 接续开始：竖挡板 + status→rotating + R3 播种，同笔原子 |
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
| **M1-RF-F** | **rotation_failed, 挡板fresh** | **✓ 覆写**（R8 只拦 `status==='rotating'`，**F2 锁定：反直觉，严禁顺手修正**） | 框架 958（RF→rotating）；**Claw 层缺口 G1** |
| M1-RF-S | rotation_failed, 挡板stale | ✓ 覆写 | 同上 |
| M1-RF-∅ | rotation_failed, 挡板被懒清/abort | ✓ 正常 begin | 框架（隐含） |
| M1-C-* | closed | ✗ `thread_closed`（硬终态） | 框架 391/401 |
| M1-*-MM | head ≠ fromSessionId | ✗ `head_mismatch` | 框架 356/381 |
| M1-R3 | begin 播种幂等键 `succession:<tid>:<from>` | 同一移交易重走不重复播种；跨移交易（head 换代后再接续）新播一条 | 框架 825；R3 语义 |

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
| **M4-RF-F** | **rotation_failed, 挡板fresh** | ✗ **同样挡投递**（`isHandoffActive` 不看 status——失败事实还在窗口内，优先重试接续而非往旧 head 投） | **缺口 G2** |
| M4-R-S | rotating, 挡板stale | 懒清理（→open）后照常投 | 框架 644 |
| **M4-RF-S** | **rotation_failed, 挡板stale** | 懒清理（**status 保持 rotation_failed**，F2 锁定）后照常投旧 head | 框架 972；**Claw 层缺口 G2** |
| M4-K20-head | 循环中 head 换代 | `head_changed` 停（剩余 pending 交下个触发点，不盲投旧棒） | 框架（K20 语义） |
| M4-K20-cancel | 循环中指令被 cancel | 跳过该条，不覆写终态 | 框架 831；Claw lifecycle「cancels pending appended concurrently」 |
| **M4-R3-VOID** | **R3 唤醒指令（幂等键 `succession:<tid>:<from>`）待投且 head 仍 == 播种 from** | 作废：`succession_precondition_violated`（FAILED 不可重试）——措辞前提「上下文已精简接续」在 head 未推进时为假，不得宣读给从未精简的旧 head（wt-58471cd9 事故链）；普通 pending 指令照常投。FAILED 不占幂等键，重试接续（同 from 再 begin）重新播种 | 框架 workthread-core「voids the seeded succession instruction」；Claw succession「after READY-gate failure」 |

### 3.5 E5 append

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M5-O-* | open（含挡板期） | ✓ 入箱；挡板期保持 pending，接续完成导向新 head | 框架 424；**调度端到端缺口 G4** |
| M5-C-* | closed | ✗ `thread_closed` | 框架 448；Claw routes 116 |
| M5-IDEM | 同幂等键 | no-op 返回既有指令 | 框架 424/513 |
| M5-KIND | 未知 kind | ✗ 400（封闭词表，无静默降级） | 框架 460 |

### 3.6 E6 archive（Claw seal 事务；顺序：归档标记先落 → seal 单笔 → runtime 停止 best-effort → 事件）

| 格 | 前置 | 预期 | 覆盖 |
|---|---|---|---|
| M6-OK | open, 无挡板 | 标记先落（期间新 send 拒）→ seal：hold=T + pending 指令批量 cancelled + archived 事件 | Claw lifecycle「seals atomically」 |
| **M6-R-F** | **rotating, 挡板存在** | seal 内：挡板清 + status→open + `handoff_aborted` 事件（stage=archived）；pending 照常取消 | Claw lifecycle（converge in one write） |
| **M6-RF-F** | **rotation_failed, 挡板存在** | 挡板清 + **status 保持 rotation_failed**（与 M4-RF-S 懒清理同语义）；事件照落 | **缺口 G3** |
| M6-IF | in_flight / delivered 指令 | **不取消**（已下沉 runtime 的调用自然完成，hold 保证不再消费下一条） | Claw lifecycle |
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
| M8D-R-F | rotating 挡板期 dispatch | 指令 ✓ 入箱保持 pending（M5-O-*），投递被挡（M4-R-F）；接续完成后自动导向新 head | **缺口 G4（端到端）** |
| M8D-RF | rotation_failed 挡板期 dispatch | 入箱 ✓；投递视挡板 freshness（M4-RF-F/RF-S） | 缺口 G2 联动 |
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

### 缺口

以下格子曾无 Claw 层测试锁定（G 编号），锚定文件 `test/thread-state-matrix.test.js`：

- G1 = M1-RF-F/S 在 Claw 编排层（接续失败后立即重试：begin 覆写成功流转）
- G2 = M4-RF-F / M4-RF-S 在 Claw 投递消费层（失败态挡板：fresh 挡投 / stale 懒清后投旧 head）
- G3 = M6-RF-F（rotation_failed 中归档：挡板清 status 保持）
- G4 = M8D-R-F 端到端（挡板期 dispatch 指令 → 接续完成 → 指令+R3 播种导向新 head，全程不丢不重）
- G5 = M8-RF-F（重启收敛扫描对已失败挡板的再收敛）

## 6. 维护约定

1. 新增状态轴取值或事件：先在本文建格（预期行为 + 实现锚点），再写测试，用例名携带格子 ID。
2. 发现行为与矩阵格不符：先判实现 bug 还是矩阵过时——F2 清单内的差异按实现 bug 处理（框架锁定），清单外先对齐语义再动代码。
3. 严禁删除 F2 锁定格的测试；重构状态机（如再迁移 state-kernel）必须保持差分测试等价。
4. 本文记录的行号是语义锚点（找代码用的路标），不是契约；契约是行为描述本身。
