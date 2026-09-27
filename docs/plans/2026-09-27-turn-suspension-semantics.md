# 轮次挂起语义实施计划

日期：2026-09-27
决策依据：[ADR 0019](../adr/0019-turn-suspension-semantics.md)

两阶段：阶段 1 全部在 AgentDev 框架仓库（含 audio-feedback / shell-feature 生态包），阶段 2 在 AgentDevClaw。发布顺序宽松：老 Claw + 新框架安全降级（桌面通知 stage 白名单、runtime-status 默认分支天然排除 suspended），两阶段可各自独立发布。

## 阶段 1：框架（AgentDev 仓库）

### 1.1 core 类型与语义轴

**`packages/core/src/core/lifecycle.ts`**

- `ExecutionReason` 联合类型（~165 行）增加 `'suspended'`
- 新增 `PendingWakeup` 接口（与 `CallOutcome` 同处）：`{ source: string; id: string; summary: string }`
- `CallOutcome`（~190 行）增加 `pendingWakeups?: PendingWakeup[]`
- `StepFinishDecisionContext`（~404 行）增加 `hasPendingWakeups?: boolean`

**`packages/core/src/core/types.ts` 与 `index.ts`**：导出 `PendingWakeup` 类型。

### 1.2 Agent：申报通道 + 盖戳 + status 映射

**`packages/core/src/core/agent.ts`**

1. pending-work 申报通道（最小版）：
   - `private _pendingWorkProviders = new Map<string, () => PendingWakeup[]>()`
   - `registerPendingWorkProvider(source, provider)` / `collectPendingWakeups(): PendingWakeup[]`（扇出聚合，异常吞掉按空处理）
2. 主路径盖戳点（~510 行，`result` 返回后、`createCallOutcome` 调用前）：
   ```ts
   const pendingWakeups = this.collectPendingWakeups();
   if (result.finishReason === 'completed' && pendingWakeups.length > 0) {
     result.finishReason = 'suspended';
     result.completed = false;   // 陷阱 1：必须同步置 false
   }
   ```
3. `createCallOutcome`（~2332 行）：status 映射增加 `reason === 'suspended' → 'continued'` 分支（在 `completed` 三元之后、`cancelled` 之前判 `result.completed === false` 路径）；`pendingWakeups` 非空时附进 outcome
4. `emitTurnCompleted` 分支（~546 行）：条件改为 `result.completed || result.finishReason === 'suspended'`（陷阱 2：否则挂起会发 `turn.failed`），并把 outcome 传给 emitTurnCompleted

### 1.3 react-loop：决策上下文事实

**`packages/core/src/core/agent/react-loop.ts`**

- 两处 StepFinish 决策上下文（~318 无工具路径、~538 有工具路径）增加 `hasPendingWakeups: (this.agent.collectPendingWakeups().length ?? 0) > 0`
- 不改各 return 路径的 finishReason——盖戳集中在 agent.ts 单点，天然覆盖全部路径（自然完成、forward hook end、reverse hook deny）

### 1.4 session-events 与 notification

**`packages/core/src/core/session-events.ts`**

- `turn.completed` 事件类型（~103 行）增加 `suspended?: boolean; pendingWakeups?: PendingWakeup[]`
- `emitTurnCompleted`（~210 行）签名增加可选 outcome 参数（或显式 flags），透传标志

**`packages/core/src/core/notification.ts`**

- `createCallFinish`（~334 行）：确认 `data` 含 `reason`（或 `finishReason`）与 `pendingWakeups`，供宿主消费端区分；现状若只带 `completed` 布尔则补齐

### 1.5 消费端（框架内建与生态包）

**`packages/core/src/features/todo/index.ts`**

- `onCallStart`（~246 行）：`ctx.metadata?.shell` 命名空间存在时（bg reminder 唤醒）跳过 `buildCallStartBrief()` 注入——后台汇报自带全部信息，唤醒的 call 不该被催"继续推进任务计划"。CallStartContext 已有 `metadata` 透传（user-turn metadata 原样到达），数据链路已通

**`packages/audio-feedback-feature/src/index.ts`**

- ~295 行：`if (ctx.finishReason === 'suspended') return;` 与 `'continued'` 同一跳过分支（否则 ~299 行 `finishReason !== 'completed'` 会把它当失败播错误音效）

**`packages/shell-feature/src/index.ts`**

- 拿到 agent 引用后（首个 CallStart / 工具注册时机）`agent.registerPendingWorkProvider('shell', ...)`：从 BgRegistry 按 `agentId::workdir` 取 running 任务映射 `{ source: 'shell', id: taskId, summary: command }`

### 1.6 唤醒按会话路由（正确性修复）

**`packages/shell-feature/src/bg-core.ts`**

- 任务登记时记录建表会话 sessionId；`_httpDeliver`（~841 行）user-turn body 增加 `sessionId`

**`packages/viewer/src/viewer-worker.ts`**

- `handlePostUserTurn`（~492 行，per-agentId 队列）：body 带 sessionId 时按会话归属路由，修复共享进程多会话下唤醒固定打给首个建表会话的错位。**动手前先读** `handlePostUserTurn` 实现 + Claw 侧 `agent-lifecycle.js` 共享会话机制，确认队列归属数据结构；若路由改造范围超预期，允许拆为独立提交跟在同一阶段发布，但不砍需求

### 1.7 测试（AgentDev）

- `packages/core/test/turn-suspension.test.ts`（新建）：
  - 判定规则矩阵：pending 空/非空 × 自然完成 / deny 打断 / error / cancelled / continuation
  - 优先序：error 撞 pending 非空 → 仍 error；cancelled 同理
  - status 映射：suspended → continued；outcome.pendingWakeups 透传
  - turn.completed 带 suspended 标志（非 turn.failed）
  - provider 聚合与未注册降级（= 现状 completed）
- audio-feedback 既有测试补 suspended 分支（不播音、不播错误音效）
- shell-feature bg 测试：provider 快照内容；投递 body 带 sessionId
- todo 测试：metadata.shell 存在时 CallStart 不注入 brief

## 阶段 2：Claw 仓库

| 文件 | 改动 |
|---|---|
| `local-features/feature-wrappers/src/controlled-todo-feature.ts` | StepFinish guard（~120-145 行强续分支）读 `ctx.hasPendingWakeups`，非空时不 Approve，让回合挂起（数据驱动让位，替代顺序偶然仲裁） |
| `public/src/modules/runtime-status.js` | status `continued` + reason `suspended` → 显示"等待后台任务"（与 checkpoint 段切分的 continued 区分）；确认 stage 归一化对新组合走默认分支不报错 |
| `public/src/modules/desktop-notify.js` | 预期零改动（stage 白名单天然排除）；验证 call.finish 载荷链路后如有判定缺口补 reason 检查 |
| `scripts/headless-session-renderer.js` | turn.completed 的 suspended 标志渲染一行"等待后台任务"（无头/ACP 视角判段用） |
| `local-features/feature-wrappers/test/wrappers.test.ts` | 补"hasPendingWakeups 非空 → 不强续"用例 |

注意两套渲染管线：runtime-status / desktop-notify 在 Claw 前端（1420），DebugHub viewer（2026）若也渲染 call 终态，`normalizeHookInspector` 双写教训同款——实施时核对 `viewer-html.ts` 是否消费 status/reason，需要则同步。

## 实施陷阱（review 重点）

1. **盖戳必须同步 `completed = false`**：`createCallOutcome` 的 status 三元以 `result.completed` 为第一优先级，只改 finishReason 会短路进 `'completed'`。
2. **`turn.failed` 误发**：agent.ts ~546 行按 `result.completed` 二分事件，suspended（completed=false）必须显式走 `turn.completed`。
3. **provider 注册时机**：feature 在首个能拿到 agent 引用的钩子注册；未注册 = 降级现状（completed），无害但失去语义。
4. **盖戳点之后的连锁**：completed=false 会影响 checkpoint 提交、CallFinish 钩子的 `completed` 字段等既有分支，实施时对 agent.ts ~500-580 段逐行过一遍，确认无"失败路径专属副作用"被误触发。

## 验证清单（人工冒烟）

1. `bg_wait` 挂起：无音效、无"已完成"通知、状态条"等待后台任务"
2. 进度汇报唤醒的回合：无音效、无通知、todo 不注入催促
3. 任务终态唤醒后交付最终答复：完成通知恰好一次
4. "执行到此处"设了断点 + 后台任务挂起：不强续
5. 普通对话（无后台任务）：行为与现状完全一致
6. 无头 `claw run` 跑后台任务：jsonl `turn.completed` 带 `suspended: true`
7. 共享进程两个会话各自起后台任务：唤醒各自路由到所属会话

## 明确不做（本期）

统一任务管理面、跨 runtime 任务保活、IM 挂起推送、输入队列优先级——边界与失效条件见 ADR 0019 决策 9/10。
