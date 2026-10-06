# ADR 0021: 状态机统一内核（state-kernel）

日期：2026-10-06
状态：提议

## 背景与问题

框架与壳层目前存在七个手搓状态机（CallArbiter、WorkThread 锚点、看板、线程生命状态合成层、Studio Feature 状态、QQ gateway 连接、subagent pool），各自发明了同一套东西：状态赋值 + if/else 守卫 + 事件通知 + 终态保护。调研（对照 xstate v5 源码）确认四个结构性问题：

1. **语义发散**：没有共享的"状态定义 → 转换守卫 → 终态保护 → 事件日志"内核；thread-life-state.js 合成层的存在本身就是状态分散的症状。
2. **竞态处理手写且位置任意**：CallArbiter 在 `_runEnvelope` 循环 3 处手工检查中断标志；WorkThread 用 `HANDOFF_STALE_MS` 惰性清陈旧交接。正确性依赖作者当天的警觉程度。
3. **加状态的变更成本失控**：ADR-0019 为 `ExecutionReason` 增加 `suspended` 一个值，触点 5+ 文件——状态语义没有集中转换表，消费者各自加分支。
4. **可观测性手撒**：CallArbiter 满篇 console.log，DebugHub 体系要每处状态机自己接线。

xstate 调研同时确认**不直接引入**：其 snapshot 模型单进程内存态优先，与我们的持久化实体（WorkThread、QQ gateway 会话恢复）错配；分层状态图能力（嵌套状态、并行区域、history）盘点下来零使用；core 零重依赖纪律（ADR-0003）不引入状态语义权威的第二个来源。

本决策：在框架 core 自建轻量内核，借鉴 xstate 的四个架构决策（逻辑/运行时分离、集中转换表、run-to-completion 检查点收敛、系统级 inspection），不借鉴其 statechart 全集。

## 决策

### 1. 框架 core 新增 `state-kernel` 模块，范围严格限定为转换求值器

内核是一个**纯函数转换求值器**：声明式转换表 + 守卫求值 + 终态保护 + lifecycle 事件生成。约 300 行，零依赖。

**明确不在内核范围内**（防过度工程）：

- 不持有存储——持久化是外壳（store.update 事务）的职责
- 不定义序列化格式与版本迁移——WorkThread record 演进沿用现有机制
- 不做分层状态图、并行区域、history states、事件延迟调度——零使用者

### 2. API 形态

操作对象是**宿主实体**（envelope / thread record），status 只是其中一个字段（字段名可配置）。守卫与效果作用于完整实体，不限于 status：

```ts
const threadAnchorMachine = defineStateMachine({
  id: 'workthread-anchor',
  statusField: 'status',
  states: {
    open:             {},
    rotating:         {},
    rotation_failed:  {},
    closed:           { terminal: true },
  },
  transitions: [
    {
      event: 'handoff_failed',
      from: ['rotating', 'rotation_failed'],
      guard: (record) => Boolean(record.pendingSuccession), // 挡板仍在
      to: 'rotation_failed',
      effect: (record, event) => { /* 更新 stage、push 附带数据 */ },
    },
    // ...
  ],
});

// 纯函数求值，无副作用，可脱离运行时单测
const result = reduce(threadAnchorMachine, record, { type: 'handoff_failed', ... });
// result:
//   { type: 'transitioned', from, to, lifecycleEvent }
//   { type: 'rejected', reason: 'terminal' | 'guard' }
//   { type: 'unhandled' }   // 无匹配转换：抛错还是 no-op 由宿主决定
```

等价性论证方式（以 WorkThread K3 守卫为例）：

- 现状 `failSessionHandoff`：`closed 终态 → no-op；无 pendingSuccession → no-op；否则置 rotation_failed`
- 转换表：`closed` 声明为 terminal → 内核拒绝（K3 前半）；`from: '*'`（非终态）+ guard `挡板存在`（K3 后半"迟到失败者没有立卷资格"）——取证确认现状守卫不检查 status（构造态 `open`+挡板同样落卷），精确等价要求 from 覆盖全部非终态而非显式列举。

每条守卫迁移都按此方式逐条对照，现有测试全绿为验收线。精确转换对照表与差分测试设计见实施计划 [docs/plans/2026-10-06-state-kernel-implementation.md](../plans/2026-10-06-state-kernel-implementation.md)。

### 3. 两种外壳模式

| | 内存态外壳（CallArbiter） | 持久化外壳（WorkThread） |
|---|---|---|
| 状态载体 | 进程内 envelope + 队列 | store.update 事务 draft |
| unhandled 策略 | throw（未知事件是 bug） | no-op（迟到信号无立卷资格） |
| lifecycle 事件 | inspection 通道（logger/DebugHub 桥接） | append 到 record（沿用现有落盘格式） |
| 事务性 | 不需要 | 由 store.update 既有事务保证 |

内核不 import DebugHub；外壳通过 `onTransition` 回调桥接观测通道，无 ViewerWorker 环境照常运行。

### 4. 行为保持与阶段边界

**阶段 1（纯重构，行为零变化）**：只收敛转换表与守卫。CallArbiter 的 mailbox 结构、中断检查点、continuation 循环原样保留；WorkThread 的 stale 惰性清除逻辑原样保留（它在外壳层，不上内核）。验收 = 现有测试全绿 + 关键路径行为对照。

**阶段 2（时序写法收敛，需专门验证后另行评审）**：CallArbiter 的 `_interruptRequested` 布尔 + 3 处手工检查点，收敛为"中断进入统一事件槽 + 段边界统一检查函数"。语义目标不变（中断在段边界生效，不抢断进行中的 onCall），但检查点从手工选择变为结构性保证。因极端时序下与现状可能有可观察差异，单独列出差异清单确认后才做，不与阶段 1 混在一起。

### 5. 事件日志格式兼容

WorkThread 现有 lifecycle 事件落盘格式（`type/status/at` 字段）**保持不变**——内核生成的 lifecycleEvent 按现有格式产出，`boards/` 重放与惰性字段读取零改动。若未来统一格式，须另立读侧兼容方案，不在本 ADR 授权范围内。

### 6. 迁移顺序（按仓库依赖而非竞态收益排序）

1. **内核 + WorkThread 锚点迁移**（框架仓库，一次 PR 闭环；已有事件日志与全量测试，迁移成本最低，内核 API 先在持久化外壳上验证）
2. **框架发版** → **CallArbiter 迁移**（Claw 仓库；转换表收敛 + console.log 接入 logger，日志文本变化如实记录在 PR 描述）
3. 看板 / Studio Feature 状态：记账为后续迁移候选，"改动即迁移"，不立项专项重写
4. QQ gateway、subagent pool：不承诺。已稳定低频改动的状态机不为统一而统一

新状态机一律用内核定义（规范要求，ESLint 层面不强推）。

### 7. 不做清单（显式边界）

- **不引入 xstate 依赖**：借鉴架构决策，不引代码与类型体系
- **不做统一任务管理面**：各域生命周期语义根本不同（ADR-0019 决策 9 已裁决），状态内核只统一"转换纪律"，不统一各域语义
- **thread-life-state.js 合成层保留**：它解决的是状态投影问题，不是转换问题；输入逐渐统一为 snapshot 形态即可
- **Todo 四态枚举等简单字段**：直接赋值即正确，上内核是过度工程
- **不借重构改行为**：状态集合、转换规则、终态语义全部保持现状；发现现行為有 bug 走独立修复，不混入迁移

### 8. 失效信号

- 内核落地后半年内使用者停留在 WorkThread + CallArbiter 两个且无新增——说明抽象没有命中真实需求，考虑降级为两个模块各自的局部整理
- 后续开发持续绕过内核手写 if/else 状态赋值——API 形态不顺手，先改 API 而不是加规范约束
- 阶段 2 的时序差异清单无法收敛到可接受范围——放弃检查点收敛，保留阶段 1 成果即止

## 后果

**正面**：加状态值类变更（参照 ADR-0019 的 suspended）从"5+ 文件加分支"收敛为"转换表加行 + 消费者按需订阅"；守卫、终态保护、事件日志的纪律由内核结构性保证；转换表可脱离运行时纯函数测试；inspection 有统一挂载点。

**代价**：WorkThread 守卫抽离的行为等价性是唯一真风险，靠逐条对照 + 现有测试化解；Claw 侧迁移受框架发版节奏约束（junction 调试可缓解）。

**中性**：console.log 日志文本变化影响 grep 习惯；两阶段拆分拉长了整体周期，但每阶段独立可验收、可回退。
