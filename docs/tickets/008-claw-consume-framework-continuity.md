# 008 — AgentDevClaw 消费切换与瘦身

- **仓库**：AgentDevClaw（`D:\code\AgentDevClaw`）
- **决策依据**：grill 批次 2 全部决策的消费侧落点；前置依赖 006 + 007
- **类型**：import 切换 + 接线保留 + 文档更新，产品行为零变化

## 背景

框架侧（005-007）就位后，Claw 从"自持实现"切换为"框架消费方"。耦合点
评估（批次 README 引言）已划清边界：**宿主接线不迁移**——
`thread-integration.js`（THREAD_HOST_AGENT_IDS 白名单 + 会话生命周期钩子）、
`thread-rotation.js`（context guard 触发的接力编排）、`input-gateway.js`
（runtime 注册表反查 + 路由判定）、`thread-routes.js`、`claw threads` CLI、
前端 thread-store/coder-threads-ui、mirror 摘要子进程，全部留在 Claw。

## 执行步骤

1. **trim 引擎切换**：`server/context-continuity/handoff-package.js` 的策略
   引擎改为薄封装调用框架实现（Claw 特有的 handoff 文件落盘路径、
   `setSessionHasSummary` 等编排保留在封装层）。
2. **seed feature 切换**：prebuilt agent / plain agent 装配处
   （run-prebuilt-agent.js、run-one-shot-agent.js、run-plain-agent.js）的
   ContextHandoffSeedFeature 改 import 框架 feature；
   `local-features/context-handoff-seed` 删除（不留薄壳，env 解析逻辑本就在
   runner 脚本里）。continuity 字段一次性读旧写新（`__claw_continuity__` →
   框架中性名，见 006 风险项）。
3. **thread controller 切换**：`server/thread-control/` 保留
   store 薄壳（数据目录指向不变，历史线程记录无需迁移）+ integration /
   rotation / gateway / routes 原样；controller 核心调用改走框架
   WorkThread。若 hold 开关落地（007），gateway 的投递门槛中调度状态判断
   改为相应接线。
4. **看板模块接线**（可选，若同期落地）：`executionEvents` /
   `recordRuntimeEvent` / `resume` 改用框架 WorkThreadBoard；未落地则 Claw
   侧调度字段暂以本地扩展表维持，009 待续。
5. **mirror 摘要的去留**：`summarized-handoff.js` / `trim-appended-summary.js`
   切换到官方 summary 实现 + 进程内 llm 注入（模型配置解析复用现有 mirror
   的装配逻辑，改为函数注入）；mirror 子进程脚本在切换验证后删除。
6. **文档更新**：CLAUDE.md 增补——三层概念（Session / Transformation /
   WorkThread）与 ADR-0002 链接、`agentdev` 导出面新增条目、官方变换与
   seed feature 的消费路径表、重启范围（框架 dist 变更需整服重启）。

## 执行前需收敛

- **切换策略**：005-007 全量落地后一次性切换（本票默认），或按模块逐票
  切换（trim 先行）。倾向一次性：三块切换面小（各 1-2 处 import 点），
  分批切换徒增中间态验证成本。

## 执行参考：Q6 重命名影响清单（来自 014 对齐核查）

对照框架 `AgentDev/src/core/workthread/`（007，commit cdac853）与 Claw
`server/thread-control/` 消费点（2026-08-21 核查）。

### 锚点 API：5/5 名称与签名一致，切换零改名

| Claw 消费 | 框架 WorkThread | Claw 消费点 |
|---|---|---|
| `findThreadByHeadSession(agentId, sessionId)` | 同名同签名 | thread-integration.js:70,98,136,157,197 / thread-rotation.js:68 / input-gateway.js:110 |
| `beginSessionHandoff({threadId, fromSessionId, reason})` | 同名 | thread-integration.js:72 |
| `advanceHead({threadId, toSessionId, fromSessionId, expectedRevision, endKind})` | 同名（含 `endKind`） | thread-integration.js:101 / thread-routes.js:131 |
| `appendCommand({threadId, kind, text, source, idempotencyKey})` | 同名同参数；返回 `{command, duplicate, threadRevision}` | thread-rotation.js:95 / thread-routes.js:107 / input-gateway.js:69 |
| `deliverPendingCommands(threadId)` | 同名；返回 `{attempted, delivered, reason, results}` | thread-integration.js:110,176 / thread-routes.js:118,148 |

### 锚点外差异（008 切换动作点）

1. **`createThread` → `start`（改名 + 参数重组）**：Claw
   `createThread({agentId, sessionId, title, mode, workspaceId})` →
   框架 `WorkThread.start({sessionRef: {agentId, sessionId}, title, workspaceId})`；
   `agentId`/`sessionId` 合并为 `sessionRef` 对象，`mode` 不在锚点层
   （归 `WorkThreadBoard.setMode`）。消费点：thread-integration.js:45、
   thread-routes.js:54。
2. **`resumeThread` → `resume`（改名 + 移层）**：框架为
   `WorkThreadBoard.resume(workThreadId, {source})`。消费点：
   thread-routes.js:169。
3. **`recordRuntimeEvent` / `getExecutionEvents`（同名移层）**：从单一
   controller 迁到 `WorkThreadBoard`（与本票步骤 4 预期一致）。消费点：
   thread-routes.js:81,95、thread-controller.js:114。
4. **`isOpen(record)`（概念域差异）**：框架锚点层无 `isOpen`，仅
   `isTerminal`；`WORKTHREAD_BOARD_OPEN_STATUSES` 判定的是看板状态域而非
   thread.status。切换时用 `!isTerminal` 映射或走 board 判定。
5. **装配形态**：Claw `new ThreadController({store, bridge})` 单对象 →
   框架拆为 `WorkThread`（core）+ `WorkThreadBoard`（board，构造时经
   `core` 关联）两个对象，装配点需拆分。
6. **框架新增 `setHold` / `getBridge`**：Claw 当前无消费点，无改名影响；
   对应本票步骤 3 的 hold 接线预留。

备注：Claw 侧 `THREAD_HOST_AGENT_IDS`（thread-integration.js:28）仍用于
新会话自动建线程与 input-gateway 路由判定——这是 993dd7f 有意保留的宿主
策略，框架无此概念，按本票"宿主接线不迁移"原则留在 integration 层不动。

## 验收标准

- Claw 全量 `npm test` 全绿（thread-control 32+ / envelope / server-smoke /
  call-arbiter 等随迁或改写后不回退）。
- 端到端行为等价：coder 工作空间手动触发 compact 接力 → 挡板 → successor
  创建 → head 推进 → 暂存指令补投，全链路与切换前一致；纯会话工作空间
  （PH）行为逐字节不变。
- `local-features/context-handoff-seed` 与 mirror 脚本删除后 grep 无残留
  import。

## 风险提示

- junction 联动开发期间切换后必须整服重启（框架 dist 变更语义），
  仅重启 agent 子进程不生效——验证时先重启再排查，避免误判切换失败。
- 一次性切换意味着 005/006/007 的验收缺陷会集中在本票暴露，golden 对照
  （006）与测试随迁（007）是唯一防线，不可跳过。
