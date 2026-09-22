# 执行手册 3：唯一调用入口 CallArbiter 迁移

> 适用对象：熟悉 agentdev runtime 生命周期的 agent
> 优先级：高
> 前置条件：第 2 份文档完成
> 目标：收敛同一个 runtime 的唯一 `onCall()` 入口，避免多个来源各自直接异步调用

---

## 问题本质

现在系统“能跑”，但不优雅的核心不是 UI，也不是 IM，而是：

**同一个 runtime 缺少唯一的调用仲裁器。**

当前至少存在两条直接 `onCall()` 路径：

1. 交互循环里收到输入就 `agent.onCall()`：[scripts/run-prebuilt-agent.js](D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js:712)
2. `ClawDispatchFeature` 收到调度消息后直接 `agent.onCall()`：[local-features/dispatch/src/index.ts](D:/code/AgentDevClaw/local-features/dispatch/src/index.ts:74)

这会导致：

- `callIndex`
- `_pendingInput`
- runtime status
- 队列可见性
- IM 回显

都可能漂移。

---

## 允许修改的文件

优先会涉及：

- [scripts/run-prebuilt-agent.js](D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js)
- [local-features/dispatch/src/index.ts](D:/code/AgentDevClaw/local-features/dispatch/src/index.ts)
- 第 2 份文档引入的新 inbox / envelope 基础代码

如确实需要，也可谨慎阅读但尽量少改：

- `node_modules/agentdev/src/core/agent.ts`
- `node_modules/agentdev/src/core/agent/react-loop.ts`
- `node_modules/agentdev/src/core/viewer-worker.ts`

除非绝对必要，不要改 `node_modules`。优先在本项目 runtime 层做仲裁。

---

## 本轮最终目标

要达到的最终效果不是“所有输入都完全统一走一个 HTTP 端点”，而是：

**所有来源都受同一个 runtime arbiter 串行约束，只有 arbiter 可以真正触发 `agent.onCall()`。**

允许存在多个上游入口，但不允许多个入口各自直接调用 `onCall()`。

---

## 你需要引入的概念

### CallArbiter

建议是一层 runtime 本地组件，职责是：

1. 从统一 inbox 取下一条 envelope
2. 标记其为 active / running
3. 调用 `agent.onCall()`
4. 捕获结果
5. 触发统一完成事件
6. 继续消费下一条

### Arbiter Loop

这可以是：

- 显式 while loop
- 事件驱动 pump
- 或一个“只要空闲就 kick 一次”的机制

无论你怎么实现，关键要求都是：

- 同一时刻一个 runtime 只能有一个 active call

---

## 强约束

1. 不要用粗暴全局锁把所有 agent runtime 串起来。
2. 锁或仲裁粒度必须是 `runtimeKey`。
3. 不要强依赖前端状态判断“当前是否在运行”。
4. 不要把 dispatch 和 Viewer 分开各做一个 arbiter。

---

## 推荐实现步骤

### 第 1 步：在 runtime 进程内建立 arbiter 容器

建议放在 `run-prebuilt-agent.js` 的 runtime 生命周期附近。

目标：
- 当前 runtime 启动后，创建一个本地 arbiter
- 这个 arbiter 知道如何：
  - enqueue
  - kick
  - run next envelope

### 第 2 步：改常驻输入 / 交互循环路径

当前逻辑：
- 收到输入后直接 `agent.onCall(handled.text)`

目标逻辑：
- 收到输入后先包成 envelope
- 入 runtime inbox
- 由 arbiter 消费

注意：
- 不要破坏 `UserInputFeature` 原有“等待下一次输入”的交互语义
- 你可以保留现有 UI 和 ViewerWorker 接口，只改 runtime 消费端

### 第 3 步：改 `ClawDispatchFeature`

当前逻辑：
- 收到 dispatch 消息后直接 `agent.onCall(msg.text)`

目标逻辑：
- 收到 dispatch 消息后转为 envelope
- 入同一个 runtime inbox
- 等 arbiter 处理

注意：
- `dispatch/respond` 的回传时机要对应 envelope 完成时，而不是“刚收到消息时”
- 如果 dispatch 需要知道是哪条 schedule 完成，记得保留 `scheduleId` / `envelopeId`

### 第 4 步：给 arbiter 补统一生命周期事件

至少需要统一发出两个时刻：

- call started
- call finished

第 4 份文档会基于这个完成事件做 IM 结果出口，所以你这里一定要把“完成后有统一事件”留出来。

事件形式不限：

- 本地 EventEmitter
- 回调注册
- 明确函数钩子

但不要只写日志，日志不是接口。

### 第 5 步：明确 runtime 状态切换

你至少要让 arbiter 管理以下状态变化：

- inbox 为空时：`idle` 或 `ready`
- 有待处理但未执行时：`queued`
- 正在执行时：`running`

不要再让这些状态完全散落在不同 feature 的自报里。

---

## 验收标准

完成后必须满足：

1. `ClawDispatchFeature` 不再直接调用 `agent.onCall()`。
2. 常规输入路径也不再绕过 arbiter 直接调用 `agent.onCall()`。
3. 同一个 runtime 同时收到两条不同来源的输入时，会排队串行处理，而不是并发碰撞。
4. call 完成后有统一完成事件或等价接口。
5. 原有用户交互流程仍然可用。

---

## 最低验证场景

你至少要验证：

1. agent 正在运行时，从常驻输入框快速提交 2 条输入，确认串行执行。
2. agent 正在运行时，再触发一条 dispatch，确认不会并发撞进 `onCall()`。
3. dispatch 完成后，respond 仍然能正确回传。
4. 普通 UI 对话仍能正常推进。

如果你能观察到统一队列长度或 active envelope，会更好。

---

## 风险提醒

这个阶段最容易犯的错误是：

1. 看起来用了 arbiter，实际上某条老路径还在直接 `onCall()`
2. 只改了 dispatch，不改常规输入，结果仍然存在双入口
3. 把队列做到 server 端，却没有真正约束 runtime 本地执行入口

你提交前必须自己检查一遍：

**项目里是否还存在第二条直接 `agent.onCall()` 的活跃运行路径。**

---

## 你不要做的事

1. 不要在这里彻底重构 IM 回复策略。
2. 不要在这里大量重写调度台前端。
3. 不要在这里做复杂优先级调度。

你的职责是：

**把“同一个 runtime 的唯一执行入口”这件事真正落到代码上。**

