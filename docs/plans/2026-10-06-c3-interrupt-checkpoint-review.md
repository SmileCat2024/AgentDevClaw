# C3 评审材料：CallArbiter 中断检查点的收敛方案与时序差异清单

日期：2026-10-06
状态：**已评审通过并实施**（推荐方案落地：事件队列 + 原位 drain，4 处调用位；36 个既有特征用例零改动全绿，新增 3 个队列语义用例）
关联：[ADR-0021](../adr/0021-state-machine-unified-kernel.md)、[实施计划](2026-10-06-state-kernel-implementation.md)（阶段 1 已完成，C3 为阶段 2 占位）

## 结论与推荐

**推荐方案：中断事件队列 + drain 点保持原三检查点位置。** 该方案下三个检查点变为统一 drain 原语的三个调用位，中断状态所有权从 envelope 移到 arbiter，行为与现状**完全等价**——C1 的 36 个特征测试预期一行不改。

**不推荐**真 run-to-completion 邮箱模型（drain 点减到两个）：会产生两个可观察差异（D1/D2），虽然论证其生产不可达，但需要改 C1 用例构造，收益仅是删一个 drain 点，得不偿失。

## 现状解剖

### 中断机制的三层结构

1. **入口** `interruptActive(reason, { clearQueue })`：置 `envelope._interruptRequested = true`，同步写 `envelope.error = reason`，然后 `clearQueued()` 同步清扫队列（splice + 逐个 cancelled + resolve waitForCompletion）。
2. **标志读取**：`_finishInterruptedEnvelope(envelope)`——若标志置位：消费并丢弃 continuation（防泄漏）、置 envelope cancelled、error 归一，返回 true。
3. **三个检查点**（`_runEnvelope` 内）：
   - **A 段首**（while 循环顶）：裁决"barrier 后同步注入序列期间到达的中断不再启动下一段"
   - **B onCall settle 后、outcome 观察后**：裁决"中断优先于 outcome 终态分支"
   - **C barrier settle 后**：裁决"barrier 完整完成（checkpoint 已提交）但中断先于下一段生效"

### C1 用例锁定的五条裁决

| 用例 | 构造方式 | 锁定的裁决 |
|---|---|---|
| 1 pre-segment | `ctx.add` 同步钩子内调用 interruptActive（C 后、A 前的同步窗口） | 中断后绝不再启动任何 onCall 段 |
| 2 in-onCall | gate 悬挂 onCall，期间置位 | onCall 返回后收口；晚注册的 continuation 被丢弃 |
| 3 post-return pre-outcome | `getLastCallOutcome` 内部置位（与 outcome=cancelled 同时在场） | 中断 error 理由胜过 outcome.error.message；outcome 仍完整记录 |
| 4 inside barrier | barrier await 悬挂期间置位 | barrier 不被中断打断、完整完成后收口 |
| 5 no-active | 无 active envelope | 队列全清，返回 `{active: false, cleared}` |

### 生产中断源盘点（全文搜索取证）

| 调用方 | 位置 | 到达窗口 |
|---|---|---|
| DebugHub interrupt handler | `run-prebuilt-agent.js:902` | IPC 异步边界——任意 await 窗口 |
| context-guard `observeUsage` | `local-features/context-guard/src/index.ts:231` | onCall 执行栈内（chat observer 触发） |
| context-rotation-trigger | 同上模式（`:365`） | onCall 执行栈内 |

**关键事实**：`getLastCallOutcome` 与 `ctx.add` 是框架纯方法，生产代码不会在其中重入 interruptActive——用例 1/3 的同步重入窗口**仅存在于测试构造**。生产中断全部落在 W1（onCall 执行期间）或无 active 时，分别由检查点 B 与 clearQueued 覆盖。

## 目标形态设计

### 推荐方案：事件队列 + 原位 drain

```
interruptActive()          →  中断事件入队（arbiter 级队列，不再写 envelope 任何字段）
                              + clearQueued 同步清扫（保持现状同步语义）
_runEnvelope 循环：
  while (true) {
    if (drainInterrupts(envelope)) return;   // 点 0（原检查点 A 位置）
    budget 检查
    await onCall(input)
    outcome 观察
    if (drainInterrupts(envelope)) return;   // 点 1（原检查点 B 位置，仍在 outcome 终态分支之前）
    outcome 终态分支 / continuation 消费
    await barrier
    if (drainInterrupts(envelope)) return;   // 点 2（原检查点 C 位置）
  }
```

`drainInterrupts` 原语 = 取出队列内全部中断事件（取 reason 末值或首值，见决策点 4）+ 执行现有 `_finishInterruptedEnvelope` 的收口序列。

**行为等价论证**：三个 drain 点与原三检查点位置一一对应，且都是同步代码中调用——JS 单线程下，"标志置位"与"事件入队"在同一点可观察，drain 结果一致。唯一变化是中间态：现状 `interruptActive` 在收口前就写 `envelope.error`（观察者可在 status=running 时看到 error 非 null）；事件化后 error 只在收口时写。该中间态无消费者（C1 无用例锁定它，`getStatus()` 不暴露 error）。

**结构收益**：
- 单写者原则：envelope 变异全部发生在 `_runEnvelope` 循环内，`interruptActive` 从外部直接变异 envelope 改为纯入队
- `_discardQueuedOnInterrupt` dead field 顺理成章删除（标志散落时代的遗迹，C1 已锁定其"set but never read"）
- 中断历史成为队列事实，为后续 inspection 通道（ADR-0021 决策 4）预留可观测接入点

### 替代方案：真 run-to-completion（不推荐）

drain 点减到两个（onCall settle、barrier settle），段首检查点删除，宏步语义 = "barrier 完成后注入系统消息 + 启动下一段"是一个原子宏步。

差异表（相对现状）：

| # | 场景 | 现状行为 | run-to-completion 行为 | 生产可达性 |
|---|---|---|---|---|
| D1 | C 后同步注入序列期间中断（用例 1 窗口） | 段首检查捕获，下一段不启动，cancelled | 中断事件排到下一段 settle 才处理，**多跑一段**后才 cancelled | 不可达（同步重入仅测试构造） |
| D2 | 中断与 outcome=cancelled 同时在场（用例 3 窗口） | 中断优先，error = 中断理由 | outcome 观察是宏步内 action 先执行，outcome 分支先裁决，error = outcome.error.message | 不可达（同上） |
| D3 | onCall 执行期间中断 | B 捕获 cancelled | settle 后 drain，cancelled | 可达，**等价** |
| D4 | barrier await 期间中断 | C 捕获，barrier 完整完成后 cancelled | settle 后 drain，等价 | 可达，**等价** |
| D5 | 无 active 时中断 | 队列全清 | 等价 | 可达，**等价** |
| D6 | 重复中断 | 标志幂等 | 队列多条事件，首条处理后 envelope 已终态，后续需静默丢弃（外壳策略需加宽容分支，envelopeMachine 的 unhandled→throw 会误伤） | 可达，需处理 |
| D7 | interruptActive 同步返回值 | `{active, cleared}` 同步 | 入队即返回，两值仍同步可算 | 可达，**等价** |
| D8 | 中断后立即 enqueue | 清队后新消息正常排队 | 事件顺序化，等价 | 可达，**等价** |

不推荐理由：两个真实差异（D1/D2）虽然生产不可达，但 C1 用例 1/3 的构造依赖同步重入，实施后必须改用例——安全网被削弱；换来的只是删一个 drain 点。

## 待评审决策点

1. **方案选择**：推荐方案（原位 drain，零行为差异）vs 替代方案（run-to-completion，D1/D2 差异）。本文档推荐前者。
2. **drain 取值语义**：多条中断事件排队时取哪条的 reason 作为收口 error——末值（最后一次中断的语义胜出）还是首值？现状标志位语义 = "最后一次 interruptActive 的 reason 覆盖 error"（因为每次调用都写 error），等价映射为**末值**。若评审倾向首值需明示（视为行为变更）。
3. **`_finishInterruptedEnvelope` 去留**：推荐方案下其收口序列并入 drainInterrupts 原语，原方法删除（其名暗示的"检查"职责由 drain 承担）。
4. **clearQueued 保持同步**：队列清扫不进事件队列（它是 arbiter 状态操作而非 envelope 生命周期事件），同步语义保留——外部直接调用方（若存在）不受影响。
5. **dead field 删除时机**：`_discardQueuedOnInterrupt` 随 C3 删除（deprecated 注释已备案）。`_terminalEnvelopes` 死 Map 是另一个独立问题（发现清单 #6），不随 C3 处理。

## 实施边界（若评审通过）

- 仅改 `server/call-arbiter.js`（envelopeMachine 不动——中断事件是 arbiter 级，不进 envelope 转换表）
- C1 的 36 用例**一行不改**是硬验收线；如实施中发现任何用例需要改，即视为方案与"零行为差异"承诺冲突，停下来重新评审
- 新增针对性测试：多条中断事件排队取末值、终态后到达的中断事件静默丢弃（D6 的宽容分支）
- 验收命令：`npm run test:file -- test/call-arbiter.test.js` + `npm run test:core`
