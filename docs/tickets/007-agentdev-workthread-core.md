# 007 — AgentDev WorkThread 核心与可选看板

- **仓库**：AgentDev（`D:\code\AgentDev`），源码来自 AgentDevClaw
- **决策依据**：grill 批次 2 Q4=C（锚点+接续编排进框架，执行看板拆为可选
  平行模块）、Q5=B（显式 opt-in 创建）、Q6=WorkThread 命名；原则见
  [ADR-0002](../adr/0002-session-continuity-as-transformation.md)
- **类型**：从 Claw `server/thread-control/` 上收核心纯逻辑 + 职责拆分重构

## 背景

Claw 的 thread-controller（728 行）混装三种性质不同的职责（grill Q4 分析）：
连续性锚点（chain/head/pendingSuccession 挡板/Inbox，已实战稳定）、执行调度
看板（idle/running/waiting_input/failed 状态机、executionEvents、resume，
昨天刚推翻重构过一次、仍在演化）、接续编排状态（rotating/rotation_failed，
本质是挡板的细化）。上收时按 Q4=C 拆分。

## 执行步骤

1. **WorkThread 核心（框架契约）**：移植 `thread-store.js`（原子写/per-thread
   锁/revision 乐观并发）+ `thread-inbox.js`（幂等入队/稳定排序/终态裁剪）+
   controller 的锚点层成员：`sessionChain` / `headSessionId` /
   `beginSessionHandoff` / `isHandoffActive` / `advanceHead`（换代+清挡板
   原子成对）/ `appendCommand` / `deliverPendingCommands` /
   `findThreadByHeadSession`。**含** `rotating` / `rotation_failed` /
   `failSessionHandoff(stage)`——接续编排状态归锚点层。
   类型与 API 统一 `WorkThread` 前缀命名（Q6）。
2. **显式创建 API**（Q5=B）：`workThread.start({ sessionRef })` 为唯一创建
   入口；支持把既有会话认作 root。不提供"session 创建即自动建线程"的框架
   语义——Claw coder 的自动建线程是宿主策略（integration 层），随 008 保留。
3. **投递门槛重新设计**（Q4 拆分的显式成本）：现 `deliverPendingCommands`
   的调度状态门槛（`failed`/`waiting_input` → `thread_waiting`）不再存在于
   锚点层。锚点层投递判定只保留客观事实：closed？交接窗口 fresh？runtime
   接收就绪（注入的 `resolveRuntime`）。宿主级"暂停投递"需求经锚点层的
   显式 `hold` 开关表达（待实施时定案，见执行前收敛）。
4. **可选看板模块 WorkThreadBoard**：executionEvents 持久化、
   `recordRuntimeEvent`（codex `turn.*` 事件 → 看板状态翻译）、resume、mode
   作为框架提供的平行模块（经 workThreadId 关联），宿主选用。**纪律写入
   模块头注释：看板永不反写锚点状态。**`idle`/`running`/`waiting_input`/
   `failed` 状态机归看板。
5. **命名兼容注释**：`src/core/session-events.ts` 头部加术语注释——事件流
   `thread.started` 的 thread 指会话本身（codex exec 对外契约，永不改义），
   框架接续链概念为 WorkThread，一处不混用。
6. 测试随迁：`test/thread-control.test.js`（约 800 行，21+32 用例）按拆分
   归位为框架测试；看板相关用例随看板模块。

## 执行前需收敛（本票阻塞项）

- **hold 开关形态**：布尔开关（宿主 set/clear）vs 投递策略回调注入。
  倾向布尔开关（与挡板同为落盘第一等状态，重启不丢）。
- **持久化落点**：WorkThread store 的数据目录约定（框架是否定义默认根、
  还是构造时必传 rootDir）。倾向必传，宿主决定归属（Claw 现落
  `~/.agentdev/AgentDevClaw/threads/`）。

## 验收标准

- 框架 build + 随迁测试全绿；bridge 注入接口（submitTurn / resolveRuntime）
  保持可 stub（现有测试注入模式不破坏）。
- 职责拆分可验证：核心模块 import 面不含看板状态值（grep
  `waiting_input` 等仅命中看板模块及其测试）。
- Claw 侧行为等价性由 008 切换后全量 core 测试兜底。

## 风险提示

- `closeThread` 当前同时做锚点收口（取消 pending 指令）与调度终态
  （status=closed）——拆分时 pending 取消归核心，closed 语义两边都要有
  （核心的 terminal 判定 + 看板终态），边界写进接口注释。
- 框架首次拥有宿主级长寿对象（ADR-0002 后果项），store 并发模型
  （per-thread 串行锁）在多宿主进程共用同一数据目录时未定义——当前单宿主
  前提下接受，接口注释声明。
