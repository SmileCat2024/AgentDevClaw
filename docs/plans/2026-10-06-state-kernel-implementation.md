# 实施计划：state-kernel 内核 + WorkThread / CallArbiter 迁移（ADR-0021 阶段 1）

日期：2026-10-06
关联：[ADR-0021](../adr/0021-state-machine-unified-kernel.md)（状态：提议）
范围：仅阶段 1（行为保持）。阶段 2（中断检查点收敛）本计划只留占位，实施前另行评审。

## 0. 总原则（TDD 与安全线）

1. **特征测试先行**：动任何实现之前，先把现状行为（包括怪行为）用测试锁死。特征测试不判断对错，只记录现状——迁移后必须一字不差地复现。
2. **差分测试兜底**：WorkThread 迁移配逐位差分测试（旧实现副本 vs 新内核实现，随机事件序列驱动，逐步深比较 record 与抛错），这是"绝对安全"要求下的最强等价性证据。
3. **每个 PR 独立可验收、可 revert**：纯新增（内核）、纯测试（特征补齐）、行为切换（迁移）三类改动不混在一个 PR。
4. **发现现行為可疑不改**：记录到"发现清单"，走独立修复，不混入迁移。

## 1. 现状基准（取证结论）

### 1.1 WorkThread 锚点状态机（迁移对象）

状态词汇：`open | rotating | rotation_failed | closed`（`closed` 终态，`WORKTHREAD_TERMINAL_STATUS`）。
落盘字段：`status / pendingSuccession / hold / lifecycleEvents / lastLifecycleEvent`；事务由 `store.update` 保证（per-thread 串行 + revision + no-op 跳写）。

六个转换入口的事务体语义（精确基准，等价性对照以此为准）：

| 入口 | 守卫（按现有代码顺序） | 状态效应 | 事件 |
|---|---|---|---|
| `beginSessionHandoff` | closed → throw `thread_closed`；hold → throw `thread_held`；`rotating` + fresh 挡板 → throw `handoff_in_progress`；head ≠ from → throw `head_mismatch` | → `rotating`；置挡板（from/reason/stage=started/startedAt）；R3 同笔播种接续指令（幂等键 `succession:{threadId}:{from}`，策略抛错=整体失败不留半挡板） | `handoff_started` |
| `failSessionHandoff` | closed → **no-op**；无挡板 → **no-op**。**对 status 无要求**（取证修正：open+挡板的构造态也会落 rotation_failed，见 §4 发现清单） | → `rotation_failed`；挡板保留，stage 补写（缺省 `unknown`） | `handoff_failed`（含 reason/stage/error） |
| `advanceHead` | closed → throw；hold → throw；head ≠ from → throw `head_mismatch`；to = head → throw `already_head`；to ∈ chain → throw `duplicate_session`；**异步三道**（identitySource：workspace/identity/成员独占，throw） | → `open`（恒定）；chain 末尾追加、旧 head 段收口（role/endedAt/endKind/successor）；清挡板；身份缺字段时事实回填 `draft.identity` | `handoff_completed` |
| `clearStaleHandoff`（私有，投递路径惰性触发） | 无挡板 → no-op | 清挡板；**仅 `rotating` → `open`**（rotation_failed 保持）；closed + 挡板构造态：清挡板但 status 不动 | `handoff_stale` |
| `closeThread` | closed → no-op（幂等） | → `closed`；closedAt/closeReason；pending 指令全部 CANCELLED（lastReason=thread_closed） | `closed` |
| `setHold` | —（不改 status，纯伴随字段） | hold = want | 无事件 |

**不进锚点状态机**（阶段 1 边界）：`appendCommand / cancelCommand / deliverPendingCommands` 的指令箱状态（PENDING/DELIVERED/CANCELLED/FAILED）——它们不改锚点 status（仅读 closed 门禁）。记为后续可选迁移，本期只在转换表定义旁留注释锚点。

**时间依赖**：`isHandoffActive` = `Date.now() - startedAt < HANDOFF_STALE_MS`（5min）。begin 的 fresh 守卫与 deliver 的门禁都依赖它。

### 1.2 CallArbiter（阶段 1 迁移对象：envelope 状态词汇）

envelope.status 词汇：`queued | running | completed | failed | cancelled`。赋值点散布 5 处：

| 赋值点 | 事件语义 | 前置 |
|---|---|---|
| `enqueue` | → `queued` | 无守卫（入队总是成功） |
| `_kick` 出队 | → `running` | `!active && queue.length > 0` |
| `_runEnvelope` 正常完成 | → `completed` | 无 continuation 注册 |
| `_runEnvelope` outcome 观察 | → `failed` / `cancelled` | `outcome.status ∈ {failed, cancelled}` 且无强制续跑 |
| `_finishInterruptedEnvelope` / `clearQueued` | → `cancelled` | `_interruptRequested` / 队列清理 |

中断机制（阶段 1 不动）：`_interruptRequested` 布尔 + 3 处检查点（段首 / onCall 返回后 / 障碍后）。continuation 循环、budget、drain 均不动。

`_status` 实际语义（C1 取证勘误，与直觉相反）：空闲 enqueue 后**立即 `running`**（`enqueue → _kick` 为同步链，`queued` 从空闲态不可外部观察）；运行中再 enqueue 才落到 `queued`（enqueue 无条件赋值、`_kick` 因 active 早退）。`queued` 表示"有积压"，与"是否已启动"正交。C1 用例 6 按实际行为锁定。

### 1.3 测试覆盖现状

- **WorkThread**：`packages/core/test/workthread/workthread-core.test.ts`（54 用例，1059 行）。K3 三连（closed / 无挡板 / open-idle）、K9（hold × begin/advance/在途）、R8 single-flight、R3 播种与策略抛错、stale 自愈、mid-loop 三态（head_changed / 取消 / handoff）均已有覆盖。
- **CallArbiter**：`test/call-arbiter.test.js`（30 用例，847 行）。串行化、多段 continuation、三个 budget、force-continuation 两条、interrupt 两条、queued-input 路径、reminder 身份均有覆盖。

### 1.4 特征测试缺口（PR-F2 / PR-C1 补齐清单）

WorkThread 侧：

1. `failSessionHandoff` 在 `rotation_failed` 上重复调用：挡板仍在则再次记录事件、stage 可更新（现状允许重复立卷）。
2. 构造态 `open` + 挡板（手工置盘）调 `failSessionHandoff`：现状**会**落 `rotation_failed`——锁定此行为（同时作为 ADR 示例修正的回归锚，见 §4）。
3. `beginSessionHandoff` 在 `rotation_failed` 状态：允许（恢复重走），`rotation_failed → rotating`。
4. `clearStaleHandoff` 在 `rotation_failed` + stale 挡板：清挡板，status **保持** `rotation_failed`。
5. `closeThread` 在 `rotating` / `rotation_failed`：允许，pending 指令取消逻辑同样生效。
6. `advanceHead` 在 `rotation_failed`：允许，落 `open` 清挡板。
7. `beginSessionHandoff` fresh 判定的时钟边界：`startedAt + HANDOFF_STALE_MS - 1` 拒绝、`+ HANDOFF_STALE_MS` 放行（mock clock）。

CallArbiter 侧（PR-C1）：

8. 中断时序矩阵：中断落在 段首检查前 / onCall 进行中 / onCall 返回后检查前 / 障碍 await 中 / 无 active envelope 时——五点的 envelope 终值与队列状态。
9. `enqueue` 时 `_status` 的迁移（idle→queued / running 保持 running）；`clearQueued` 后 `_status` 回落（active ? running : idle）。

## 2. 内核 API 终稿（含两处取证驱动的修正）

```ts
// packages/core/src/core/state-kernel/index.ts（新增模块）

export interface StateMachineDef<R> {
  id: string;
  statusField: string;                    // R 上承载状态的字段名（'status'）
  states: Record<string, { terminal?: boolean }>;
  transitions: TransitionDef<R, any>[];
}

export interface TransitionDef<R, E> {
  event: string;
  from: string[] | '*';                   // '*' = 全部非终态
  guards?: Array<(record: R, event: E, ctx: KernelCtx) => boolean | GuardRejection>;
  to: string | ((record: R, event: E, ctx: KernelCtx) => string | null);  // null = status 不变
  effect?: (record: R, event: E, ctx: KernelCtx) => void;  // 就地修改 record 伴随字段
}

export interface KernelCtx { now(): number }   // 时钟注入（stale 判定等），测试可控

export type GuardRejection = { code: string }; // 守卫可结构化拒绝，code 供外壳重建精确错误

export type ReduceResult<R> =
  | { type: 'transitioned'; from: string; to: string; lifecycleEvent: R['lifecycleEvents'][number] }
  | { type: 'rejected'; reason: 'terminal' | string }   // string = guard code
  | { type: 'unhandled' };

export function defineStateMachine<R>(def): StateMachineDef<R>;  // 定义期静态校验
export function reduce<R>(def, record, event, ctx?): ReduceResult<R>;
```

取证驱动的两处修正（相对 ADR-0021 决策 2 示意）：

1. **`reduce` 严格同步纯函数；异步守卫一律留外壳**。`advanceHead` 的身份三道校验依赖 `identitySource`（I/O）与 `store.list`（跨线程查询）——它们不是 record 上的事实，保持在外壳事务内、`reduce` 之前执行（现状代码本身就是"结构守卫在前、身份校验在后"两段，此分层无行为变化）。内核纯度是差分测试与脱离运行时单测的根基，不让步。
2. **`to` 支持函数与 null**：`clearStaleHandoff` 的目标状态依赖当前值（仅 `rotating` 回 `open`），转换表需要条件目标。

其他要点：

- **lifecycleEvent 生成是内核职责**：`{ type, status: to, at: ctx.now(), ...payload }`——payload 由 transition 上的 `eventPayload?: (record, event, ctx) => object` 提供（现有落盘格式的字段差异大，如 `handoff_failed` 带 reason/stage/error，`handoff_completed` 带 from/to/reason）。`maxEvents=200` 截断与 `lastLifecycleEvent` 维护留在 `pushLifecycleEvent` 辅助函数（外壳侧，effect 内调用），格式逐字节兼容现状。
- **guards 顺序求值，首个失败即 rejected（携带 code）**：错误对象构造（code/status/message）留外壳错误工厂——内核不知道 HTTP status。守卫顺序 = guards 数组顺序，等价于现有代码的守卫书写顺序。
- **定义期静态校验**（`defineStateMachine` 抛错）：from/to 引用未声明状态、终态出现在 from（含 `'*'` 之外的显式引用）、同 event+from 重叠的转换对（含 `'*'` 与显式并存的歧义）。
- 模块零依赖、不 import DebugHub / store / 任何框架内部模块。观测桥接 = 外壳在 `transitioned` 时按需调用自有 logger（WorkThread 本期不加新日志——行为保持；日志增强是后续自由项）。

## 3. WorkThread 锚点转换表（精确等价对照）

```
事件 begin_handoff:
  from: '*'（非终态）
  guards: [hold→thread_held, rotating+fresh挡板→handoff_in_progress, head≠from→head_mismatch]
  to: 'rotating'
  effect: 置挡板 + R3 播种（调 continuationPolicy）+ pushLifecycleEvent
  payload: { fromSessionId, reason }

事件 handoff_failed:
  from: '*'（非终态）          ← 修正：现状守卫不查 status，构造态 open+挡板也落卷
  guards: [挡板存在，否则无立卷资格 no-op]
  to: 'rotation_failed'
  effect: stage 补写 + pushLifecycleEvent
  payload: { reason, stage, error }

事件 advance_head:
  from: '*'（非终态）
  guards: [head≠from→head_mismatch, to=head→already_head, to∈chain→duplicate_session]
          ← closed/hold/异步三道留外壳（closed 由终态保护统一 rejected(thread_closed)，见下）
  to: 'open'
  effect: chain 收口+追加、清挡板、身份回填 + pushLifecycleEvent
  payload: { fromSessionId, toSessionId, reason }

事件 clear_stale:
  from: '*'（非终态）
  guards: [挡板存在]
  to: (record) => record.status === 'rotating' ? 'open' : null
  effect: 清挡板 + pushLifecycleEvent
  payload: {}

事件 close_thread:
  from: '*'（非终态）
  to: 'closed'
  effect: closedAt/closeReason + pending 指令批量 CANCELLED + pushLifecycleEvent
  payload: { reason }
```

**终态 rejected 与现有错误码的映射**：现状所有入口对 `closed` 的处理分两型——begin/advance/append 抛 `thread_closed`，fail/close 为 no-op。因此终态保护不能由内核统一成 throw：**外壳按事件决定 rejected 的处置**（throw 或 no-op），内核只给 `rejected: 'terminal'` 事实。hold 守卫同理：begin/advance 抛 `thread_held`，而 append/deliver 不查 hold——**hold 不进转换表**，作为各入口的显式守卫留在方法序言（它不是 status 轴的转换条件，是伴随字段的门禁）。此两点是"内核给事实、外壳定策略"的具体化。

> 修正记录：ADR-0021 决策 2 的 K3 示例写 `from: ['rotating', 'rotation_failed']`，取证发现精确等价应为 `'*'` + 挡板守卫（构造态 open+挡板现状会落 rotation_failed）。以本表为准，ADR 该处同步勘误。

## 4. 发现清单（不改，仅记录）

1. `failSessionHandoff` 构造态 `open`+挡板会落 `rotation_failed`：正常流不可达（挡板存在则 status ∈ {rotating, rotation_failed}），但 stale 清除与 fail 的竞态窗口理论存在。转换表按精确等价实现，行为不变；是否收紧为显式 from 集合，独立决策。
2. `clearStaleHandoff` 对 `closed`+挡板构造态：清挡板、发事件、status 保持 closed——投递路径进入前已有 closed 门禁，正常不可达。等价保留。
3. CallArbiter `_discardQueuedOnInterrupt` 为已标注的 dead field（2026-07-25 deprecated 注释），阶段 1 原样保留，PR-C2 不顺手删除（删除属独立清理）。

特征测试补齐（F2/C1）追加发现：

4. **rotation_failed 上 R8 单飞失效**：`handoff_in_progress` 守卫只拦 `status === 'rotating'`；rotation_failed + fresh 挡板时并发 begin 可直接覆写挡板（F2 用例 3 依赖此放行）。迁移必须精确保留，收紧与否独立决策。
5. **closeThread 不清挡板**：closed 记录上 `pendingSuccession` 永久残留（F2 用例 5 锁定）；对只读消费方无害，属状态残留。
6. **rotation_failed + stale 清挡板后状态悬空**：挡板 null 而 status 仍 rotation_failed，无自愈归 open 路径（F2 用例 4 锁定），此后仅 begin / advanceHead / closeThread 可离开。
7. **CallArbiter `_terminalEnvelopes` 是只写不进的死 Map**：无任何写入路径；对已收口且未预注册 `waitForCompletion` 的 envelope 调用会永久挂起（现有调用方都是先注册后等待，未踩中）。
8. **障碍后检查点与段首检查点观察不可区分**（C1 用例 1 与 4 可观察结果完全相同）：阶段 2 收敛检查点时这两用例即天然差异清单的对照行。
9. **中断优先于 outcome 终态**（C1 用例 3 锁定）：中断在 outcome 观察处置位时 envelope.outcome 仍完整记录，终态裁决走中断分支——阶段 2 若调整两者顺序，该用例上显形。

## 5. 差分测试设计（PR-F3 核心）

**形态**：测试文件内置 legacy 参考副本——将现有六个事务体逐字拷贝为独立纯函数（`legacyBegin(draft, opts)` 等，仅剥离 store.update 包装），文件头注明来源 commit 与"迁移稳定一个版本周期后删除"。拷贝忠实性以 git diff 人工核验（PR 检查项）。

**驱动**：确定性 PRNG（固定 seed，失败信息打印 seed 可复现）生成随机事件序列：

- 词汇：`begin(from∈池, reason) / fail(reason, stage) / advance(from, to) / close() / setHold(bool) / tick(Δms)`；`tick` 推进注入时钟，跨 `HANDOFF_STALE_MS` 边界制造 stale 态。
- 身份校验：注入确定性 identitySource（池内 sessionId→固定 identity，池外→null），使异步三道在两侧行为一致。
- 不含 `deliver`（bridge I/O，行为已由特征测试覆盖）。

**对比**：每步之后深比较两侧 record（status / pendingSuccession / hold / commands / lifecycleEvents / lastLifecycleEvent / identity / closedAt / closeReason），以及抛错的 code（old throw code vs new rejected→外壳 throw code）与 no-op 的 revision 不变。

**量级与预算**：序列数 × 长度参数化（初值 200 × 50 步），文件墙钟控制在项目预算 1.5s 内；超限先减序列数，不减断言强度。内存 store（沿用现有测试的 store 实现）。

## 6. PR 拆分、顺序与验收

| PR | 仓库 | 内容 | 验收 | 回退 |
|---|---|---|---|---|
| F1 | AgentDev | `state-kernel` 模块 + §7 内核测试矩阵全绿 | 纯新增，`npm test` 无回归；零 import（除 TS 内置） | 直接 revert |
| F2 | AgentDev | 特征测试补齐（§1.4 清单 1–7），**不改实现** | 新测试全绿（锁定现状）；`npm test` 无回归 | 直接 revert |
| F3 | AgentDev | WorkThread 六入口迁移到转换表 + 差分测试；旧守卫代码删除；ADR-0021 勘误一行 | 全部现有测试 + F2 特征测试 + 差分测试零差异 | revert 恢复旧实现（测试仍在，双向安全） |
| — | 发版 | AgentDev `npm run build` + 发版（版本号按仓库惯例） | `agentdev:published` 流程自检 | — |
| C1 | AgentDevClaw | CallArbiter 特征测试补齐（§1.4 清单 8–9），不改实现 | 新测试全绿；`npm run test:file -- test/call-arbiter.test.js` 无回归 | 直接 revert |
| C2 | AgentDevClaw | envelope 转换表收敛（§1.2 五个赋值点 → `envelopeMachine`）；console.log 文本变化记录于 PR 描述；dead field 不动 | 30+9 个测试全绿；getStatus/envelope 终值对照清单逐条打勾 | revert |
| C3（占位，另行评审） | AgentDevClaw | 阶段 2：中断检查点收敛。前置产出 = 时序差异清单 | 差异清单评审通过 | — |

执行纪律：

- F1→F2 可并行起草，F3 必须在 F2 合入后开工（特征测试是 F3 的安全网）。
- C1 不依赖发版，可与 F 系列并行；C2 依赖发版（或开发态 junction 调试）。
- 每个迁移 PR 的 PR 描述附"行为对照清单"（转换表 ↔ 旧守卫逐条）， reviewer 按表核对。

## 7. 内核测试矩阵（F1 的 TDD 素材，先红后绿）

定义期校验：未声明状态引用 / 终态入 from / 同事件 from 重叠（含 `'*'` 歧义）/ 缺 status 字段。

reduce 求值：

- from 命中：单值 / 数组 / `'*'`；from 不含当前状态 → unhandled
- event 无任何转换 → unhandled
- guards：顺序求值、首败即停、boolean false 无 code / `{code}` 携带 code、guard 抛错向上传播（对应 R3 策略抛错语义）
- 终态：任何事件 → `rejected: 'terminal'`（guards 不再求值）
- to：静态值 / 函数式 / null（status 不变，lifecycleEvent.status = 原值）
- effect：变异可见于 result 前；无 effect 仅换 status
- lifecycleEvent：type/status/at 字段、payload 展开、`ctx.now()` 可注入
- ctx：缺省 now = Date.now
- record 不含 statusField → 定义期或求值期显式报错（不留 undefined 静默路径）
- 同一 record 连续 reduce 的幂等性（无隐藏状态）

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 守卫抽离引入等价性偏差 | 特征测试补齐在前 + 差分测试逐位对比 + 转换表逐条对照评审 |
| 时钟依赖（stale 判定） | `KernelCtx.now()` 注入；差分序列含 tick 跨界步 |
| 异步身份校验塞进内核破坏纯度 | 明确分层：reduce 同步纯函数，异步守卫留外壳（§2 修正 1） |
| 双仓库节奏（Claw 等发版） | C1 先行不依赖发版；C2 可用 junction 调试，合入等发版 |
| 差分测试超时长预算 | 参数化规模，1.5s 墙钟内收敛；不减断言强度 |
| ADR 示例与代码不一致误导后来者 | F3 勘误 ADR-0021 决策 2，指向本计划对照表 |

## 9. 阶段 2 占位（不实施，仅记录方向）

`_interruptRequested` + 3 检查点 → 事件槽 + 段边界统一检查函数。前置产出：五点中断时序矩阵（C1 已建）在新旧实现下的差异清单。评审通过另立计划。
