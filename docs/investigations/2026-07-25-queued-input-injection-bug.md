# 调查报告：暂存输入（Queued Input）注入机制缺陷与修复方案

> **调查日期**：2026-07-25
> **调查范围**：AgentDev 框架 (`D:\code\AgentDev`) + AgentDevClaw 产品壳层 (`D:\code\AgentDevClaw`)
> **问题严重度**：P1（通讯 bug 影响核心交互体验）
> **结论**：存在确定性的工程缺陷 + 可选的 UX 适配优化

---

## 目录

1. [问题概述](#1-问题概述)
2. [系统架构：暂存输入的两条路径](#2-系统架构暂存输入的两条路径)
3. [Bug 根因：useArbiterQueue 死区](#3-bug-根因usearbiterqueue-死区)
4. [修复方案：统一为单路径 HTTP dequeue](#4-修复方案统一为单路径-http-dequeue)
5. [mid-call user message 对下游机制的影响面分析](#5-mid-call-user-message-对下游机制的影响面分析)
6. [UX 适配项：trim preview 与 rollback button](#6-ux-适配项trim-preview-与-rollback-button)
7. [实施检查清单](#7-实施检查清单)

---

## 1. 问题概述

### 1.1 用户报告的现象

用户在 agent 运行期间通过 UserInputFeature 的"暂存输入"功能发送消息时：

- **纯文本消息**有时要等到整轮 call 完全结束后才被处理，而非在 step 间隙被注入
- **包含图片的消息**几乎总是要等当前 call 结束后才被处理
- 被延迟处理的消息最终会作为**新的 call** 被执行，而非作为当前 call 的补充信息

### 1.2 问题定性

| # | 问题 | 性质 | 是否阻塞 |
|---|------|------|----------|
| A | `useArbiterQueue` 标志位制造"双路皆空"死区 | **确定性工程 bug** | 是，必须修复 |
| B | 图片消息绕过 supplement 路径 | 工程设计限制（随 A 一并消除） | 随 A 修复 |
| C | mid-call user message 对 trim preview 的影响 | UX 显示层面 | 否，可选优化 |
| D | mid-call user message 对 rollback button 的影响 | UX 交互层面 | 否，可选优化 |

---

## 2. 系统架构：暂存输入的两条路径

暂存输入系统有**两条互斥的注入路径**，由 ViewerWorker 中的一个标志位 `useArbiterQueue` 切换。

### 2.1 路径 A：HTTP dequeue（react-loop 内置）

```
react-loop 每个 step 结束（stepResult === 'next'）
  → fetchQueuedInput()
  → POST /api/agents/:id/dequeue-input
  → ViewerWorker 返回队列中的第一条输入
  → context.addUserMessage(text, callIndex, images)   ← 注入为 user message
```

**代码位置**：
- `AgentDev/src/core/agent/react-loop.ts` 第 591-612 行
- `AgentDev/src/core/viewer-worker.ts` 第 1156-1184 行（`handleDequeueInput`）

**注入形式**：user message（支持图片）
**触发时机**：每个有 tool call 的 step 结束后

### 2.2 路径 B：UDS + CallArbiter supplement（Claw 运行时实际使用的路径）

```
Front-end → POST /queue-input → server.js proxyToViewer → ViewerWorker
  → ① 存入 session.queuedInputs
  → ② 设置 session.useArbiterQueue = !!targetSocket
  → ③ 通过 UDS 转发到 agent 子进程
      → DebugHub.udsClient.on('data')
      → handleWorkerMessage → queuedInputHandler
      → CallArbiter.enqueue({ source: 'queued-input', ... })
      → _active && !hasImages → _supplementBuffer
      → 下一个 onStepStart → drainSupplements()
      → context.addSystemMessage("用户补充信息：" + text)   ← 注入为 system message
```

**代码位置**：
- `AgentDev/src/core/viewer-worker.ts` 第 1084-1138 行（`handleQueueInput`）
- `AgentDev/src/core/debug-hub.ts`（`handleWorkerMessage` → `case 'queue-input'`）
- `AgentDevClaw/scripts/run-prebuilt-agent.js` 第 560-570 行（`setQueuedInputHandler`）
- `AgentDevClaw/scripts/run-prebuilt-agent.js` 第 585-602 行（`onStepStart` supplement drain）
- `AgentDevClaw/server/call-arbiter.js` 第 90-130 行（`enqueue` supplement 分流）

**注入形式**：system message（**不支持图片**）
**触发时机**：下一个 step 的 `onStepStart`

### 2.3 两路径的互斥机制

`ViewerWorker.handleDequeueInput`（第 1167-1170 行）：

```typescript
if ((session as any).useArbiterQueue) {
    res.writeHead(200, ...);
    res.end(JSON.stringify({ input: null, remaining: session.queuedInputs?.length || 0 }));
    return;  // ← 直接返回 null，跳过实际 dequeue
}
```

`useArbiterQueue` 在 `handleQueueInput` 中设置（第 1118 行）：

```typescript
(session as any).useArbiterQueue = !!targetSocket;
```

在 Claw 运行时中，UDS 连接几乎永远存在（agent 子进程启动后即连接），所以 `useArbiterQueue` 几乎永远为 `true`，路径 A（HTTP dequeue）**完全失效**。

---

## 3. Bug 根因：useArbiterQueue 死区

### 3.1 核心矛盾

当 `useArbiterQueue = true` 时：

- **路径 A（HTTP dequeue）被封死**——`handleDequeueInput` 永远返回 `{ input: null }`
- **路径 B（UDS supplement）成为唯一通路**
- 如果路径 B 因任何原因失败，消息就**卡死了**——没有 fallback

### 3.2 路径 B 失败的具体场景

#### 场景 1：时序竞争（纯文本消息"有时候"卡住）

UDS `data` 事件是 agent 进程 event loop 上的 macrotask。它必须在与 LLM 响应回调的竞争中"赢"才能在下一个 `onStepStart` 之前被处理：

```
Step N 开始:
  ├─ onStepStart → drainSupplements() → buffer 为空
  ├─ await llm.chat()  ←─── event loop 释放
  │   ├─ macrotask A: UDS data 到达 → enqueue → supplement 入 buffer
  │   └─ macrotask B: LLM 响应到达 → step 继续执行
  │       （A 和 B 的顺序不确定！）
  ├─ 如果 B 先于 A：step 走完 → return 'next'
  │   └─ fetchQueuedInput → useArbiterQueue=true → 返回 null（死路！）
  │       └─ Step N+1: onStepStart → drainSupplements
  │           ├─ A 已执行 → 找到 supplement ✓
  │           └─ A 未执行 → buffer 仍为空 ✗
  └─ ...
```

当 LLM 响应较快时，UDS data 可能来不及在 step 间隙被处理。如果持续错过多个 step 的 `onStepStart`，supplement 一直留在 buffer 里，直到 call 结束时被 `.finally()` 转为普通 envelope → 新 call。

**关键**：由于 `useArbiterQueue` 屏蔽了 HTTP dequeue，即使 UDS 消息延迟到达，HTTP 路径也无法补救。

#### 场景 2：图片消息确定性绕过（图片消息"总是"卡住）

`call-arbiter.js` 第 99-105 行：

```javascript
const hasImages = Array.isArray(envelope.images) && envelope.images.length > 0;
if (this._active && envelope.source === 'queued-input' && !hasImages) {
    // → supplement 路径（mid-call 注入）
}
// 有图片 → 绕过 supplement，进入普通 _queue → 等当前 call 结束
```

图片消息**永远**绕过 supplement 路径（因为 system message 无法携带图片），只能等当前 call 结束后作为新 call 执行。

### 3.3 影响范围

- **受影响的工作空间**：所有使用 `run-prebuilt-agent.js` 启动的 agent（programming-helper、qqbot 等）
- **不受影响**：不使用 CallArbiter 的运行模式（如 exploration sub-agent）
- **触发频率**：取决于 LLM 响应速度 vs UDS 传输速度的竞争，概率性发生

---

## 4. 修复方案：统一为单路径 HTTP dequeue

### 4.1 核心思路

移除 UDS supplement 机制和 `useArbiterQueue` 门控，让 `fetchQueuedInput`（react-loop 内置的 HTTP dequeue）成为**唯一的注入路径**。

这样做的好处：
- **消除时序竞争**——单一路径，无 macrotask 竞争
- **消除图片 bypass**——`fetchQueuedInput` 用 `addUserMessage(text, callIndex, images)` 天然支持图片
- **消除 system message 问题**——直接注入为 user message（而非 "用户补充信息：" 前缀的 system message）
- **大幅简化架构**——移除整套 supplement 机制

### 4.2 涉及文件与改动

#### 改动 1：AgentDev 框架侧 — 移除 `useArbiterQueue` 门控

**文件**：`AgentDev/src/core/viewer-worker.ts`

**`handleQueueInput`（第 1084-1138 行）**：
- 移除 `session.useArbiterQueue = !!targetSocket` 赋值（第 1118 行）
- 移除 UDS 转发逻辑（第 1119-1129 行）
- 保留：存储到 `session.queuedInputs`、返回 HTTP 200

**`handleDequeueInput`（第 1156-1184 行）**：
- 移除 `useArbiterQueue` 检查（第 1167-1171 行）
- 始终正常返回队列内容

#### 改动 2：AgentDevClaw 侧 — 移除 supplement 机制

**文件**：`AgentDevClaw/scripts/run-prebuilt-agent.js`

**`setQueuedInputHandler`（第 560-570 行）**：
- 移除整个 `DebugHub.getInstance().setQueuedInputHandler(...)` 调用

**`onStepStart` override（第 585-602 行）**：
- 移除 supplement drain 逻辑
- 保留对 `_originalOnStepStart` 的调用（如果存在）

**`CallArbiter` 中的 supplement 相关代码**：
**文件**：`AgentDevClaw/server/call-arbiter.js`
- `_supplementBuffer` 字段（第 30 行）
- `drainSupplements()` 方法
- `clearQueued()` 方法中对 `_supplementBuffer` 的清理
- `enqueue()` 中 `source === 'queued-input' && !hasImages` 的 supplement 分流（第 99-110 行）
- `.finally()` 中残留 supplement 转 envelope 的逻辑（第 299-314 行）
- 这些可以保留（不影响功能），也可以清理（减少代码量）。**建议保留 `drainSupplements` 和 `clearQueued` 的方法签名但清空实现**，避免其他引用处报错。

#### 改动 3：确认 react-loop 的 `fetchQueuedInput` 路径完整性

**文件**：`AgentDev/src/core/agent/react-loop.ts`

第 591-612 行的 queue check 逻辑已经正确：

```typescript
const queuedInput = await this.fetchQueuedInput(this.agent.agentId);
if (queuedInput) {
    context.addUserMessage(queuedInput.text, callIndex, queuedInput.images);
    this.pushToDebug(context.getAll());
    continue outerLoop;
}
```

注入为 user message，支持 images，使用当前 `callIndex` 作为 `turn`。**无需修改。**

### 4.3 改动后需要验证的点

1. **`fetchQueuedInput` 在 `stepResult === 'continue'` 时被跳过**
   - `react-loop.ts` 的 step result 处理顺序：`break` → `continue` → `interrupted` → object → `'next'`（queue check 仅在 `'next'` 后运行）
   - `'continue'` 仅在 StepFinish hook 显式请求时出现，实际使用中很罕见
   - 如果需要完全覆盖，可以将 queue check 移到 step result 判断之前（但这是框架改动，优先级低）

2. **前端 persistent input UI 同步**
   - `AgentDevClaw/public/src/modules/persistent-input.js` 中的 `_syncPersistentInputUi` 通过 `GET /api/agents/:id/queued-inputs` 获取队列状态
   - 改动后，`handleDequeueInput` 的 `shift()` 会从队列中移除已处理的消息
   - `consumeQueuedInput`（由 `drainSupplements` 调用）不再被触发，但因为 dequeue 本身已经 `shift()` 了，队列状态会正确更新
   - **需要验证**：前端队列指示器在消息被 dequeue 后是否正确消失

3. **DebugHub 的 `consumeQueuedInput` IPC 消息**
   - 改动后，`drainSupplements` 不再调用 `consumeQueuedInput`
   - 但 `handleDequeueInput` 的 `shift()` 已经从 `session.queuedInputs` 中移除了消息
   - 所以 `consumeQueuedInput` 的 IPC 消息不再需要，不会有遗留消息问题

### 4.4 构建与部署步骤

由于涉及跨仓库改动，需按以下顺序操作：

```bash
# 1. 修改 AgentDev 框架源码
#    AgentDev/src/core/viewer-worker.ts

# 2. 构建 AgentDev 框架 dist
cd D:/code/AgentDev && npm run build

# 3. 修改 AgentDevClaw 侧代码
#    scripts/run-prebuilt-agent.js
#    server/call-arbiter.js

# 4. 重启 Claw 服务（框架 dist 变更需要完整重启）
cd D:/code/AgentDevClaw && npm start
```

---

## 5. mid-call user message 对下游机制的影响面分析

修复后，暂存输入会以 **user message** 形式注入到当前 call 中间。以下是对每个下游机制的影响分析。

### 5.1 不受影响的机制（已确认安全）

#### 5.1.1 Call-level checkpoint / rollback

**机制**：每个 call 开始时，在 user message 添加之前捕获 context boundary（长度快照）。rollback 时按长度截断。

**代码位置**：
- `AgentDev/src/core/agent.ts` 第 354-377 行（checkpoint 创建）
- `AgentDev/src/core/context.ts` 第 476-483 行（`captureBoundary`）、第 530-540 行（`truncateToBoundary`）

**结论**：mid-call user message 只是多数组中多了一条消息。rollback 截断到 call 开始的 boundary 时，连同整个 call 的所有消息（包括 mid-call user message）一起被移除。**完全安全。**

#### 5.1.2 Step auto-save（步骤暂存）

**机制**：每个 step 完成后，`stepSaveFn` → `saveSession` → `createSessionSnapshot` 保存完整 runtime（包括 context 的所有 message）。

**代码位置**：
- `AgentDev/src/core/agent.ts` 第 818-842 行（`enableStepAutoSave` / `_createStepSaveFn`）
- `AgentDev/src/core/agent.ts` 第 607-622 行（`createSessionSnapshot`）
- `AgentDev/src/core/agent/react-loop.ts` 第 568-571 行（step 完成后触发 `stepSaveFn`）

**结论**：mid-call user message 随其他消息一起被保存和恢复。**完全安全。**

#### 5.1.3 Named checkpoint（agent 自主 set_checkpoint / rollback_to_checkpoint）

**机制**：通过 `createNamedCheckpoint` 捕获完整 runtime 状态。rollback 时恢复到该状态。

**代码位置**：
- `AgentDevClaw/local-features/checkpoint/src/index.ts`（CheckpointFeature 工具）
- `AgentDevClaw/server/call-arbiter.js` 第 417-450 行（`_checkpointBarrier` / `_rollbackBarrier`）

**结论**：mid-call user message 如果在 checkpoint 之前添加，会被保留；之后添加的会在 rollback 时被移除。**行为完全正确。**

#### 5.1.4 Continuation barrier（CallArbiter 内部的 checkpoint/rollback 循环）

**机制**：`_runEnvelope` 中的 continuation barrier 通过 `consumeContinuationRequest` 获取请求，通过 `createNamedCheckpoint` / `rollbackToNamedCheckpoint` 执行。独立于消息结构。

**代码位置**：`AgentDevClaw/server/call-arbiter.js` 第 343-400 行

**结论**：**完全安全。**

#### 5.1.5 Summary / compacted resume

**机制**：读取 session messages，过滤 `role !== 'system'`，全部传递给 summary 生成。不依赖 user/assistant 交替模式。

**代码位置**：
- `AgentDevClaw/server/routes/session-handoff-helpers.js` 第 371-380 行
- `AgentDevClaw/server/routes/session.js` 第 533-557 行（`session_summary`）、第 559+ 行（`session_generate_summary`）

**结论**：mid-call user message 自然包含在 summary 的消息历史中。**完全安全。**

#### 5.1.6 enrichedMessages 数组

**机制**：`addUserMessage` 内部调用 `addMessage`，同时更新 `messages` 和 `enrichedMessages` 两个数组。`captureBoundary` 和 `truncateToBoundary` 同时操作两个数组。

**代码位置**：`AgentDev/src/core/context.ts` 第 216-231 行

**结论**：**两套数据始终同步。完全安全。**

#### 5.1.7 Frontend chat rendering

**机制**：mid-call user message 按 `role === 'user'` 渲染为用户消息气泡。

**代码位置**：`AgentDevClaw/public/src/modules/chat-renderer.js` 第 50-79 行

**结论**：用户能在聊天界面看到自己中途发送的消息。**完全安全，且是期望行为。**

### 5.2 关键数据：`turn` 值的一致性

`react-loop.ts` 第 602 行：

```typescript
context.addUserMessage(queuedInput.text, callIndex, queuedInput.images);
```

`callIndex` 是从 `agent.onCall` 传入的当前 call 的 index。所以 **mid-call user message 的 `turn` 和原始 user message 完全相同**。

所有依赖 `turn` 的下游逻辑因此保持正确。

---

## 6. UX 适配项：trim preview 与 rollback button

以下两项**不阻塞主修复**，是可选的后续优化。

### 6.1 Trim preview 显示多余的 round

**问题**：`buildSessionTrimPreview` 按 `role === 'user'` 切分 round，mid-call user message 会创建一个额外的 "round"。

**代码位置**：`AgentDevClaw/server/routes/session-helpers-pure.js` 第 186-236 行

**实际影响**：
- trim preview 界面显示额外轮次（cosmetic）
- 实际 trim 操作按消息索引执行，不受 round 划分影响
- branch 的 `maxUserTurn` 用 `msg.turn`（= callIndex），mid-call message 和原始 message 有相同 turn，所以 checkpoint 过滤正确

**修复方案（可选）**：改为按 `turn` 值分组，而非按 `role === 'user'` 切分。在 `buildSessionTrimPreview` 中，只有当 user message 的 `turn` 与前一个 user message 的 `turn` 不同时，才开启新 round。

### 6.2 Rollback button 在 mid-call message 上也显示

**问题**：`canRollbackMessage` 检查 `available.includes(msg.turn)`，mid-call message 的 `turn` 与原始 message 相同，因此也通过检查，显示"编辑此轮"按钮。

**代码位置**：
- `AgentDevClaw/public/src/modules/input-helpers.js` 第 193-201 行（`canRollbackMessage`）
- `AgentDevClaw/public/src/modules/input-helpers.js` 第 178-191 行（`getAvailableCallIndices`）
- `AgentDevClaw/public/src/modules/chat-renderer.js` 第 55-56 行（按钮渲染）
- `AgentDevClaw/public/src/modules/rollback-dialog.js` 第 82-101 行（`requestRollbackEdit`）

**实际行为**：

| user message | 按钮显示 | 点击后效果 |
|---|---|---|
| 原始（call 开头） | "编辑此轮" ✓ | 回退到 call 开始 checkpoint，预填原始消息内容 |
| mid-call 注入的 | "编辑此轮" ✓ | 也回退到 call 开始 checkpoint，预填 mid-call 消息内容 |

两个消息指向同一个 checkpoint。点击 mid-call message 的"编辑此轮"，对话框说"丢弃此轮之后的所有消息"，但实际上 mid-call message 之前的 assistant 回复和 tool 调用也会被丢弃。

**修复方案（推荐，选项 A）**：在 `canRollbackMessage` 中增加判断——如果同一个 `turn` 已经有更早的 user message，则不显示按钮：

```javascript
function canRollbackMessage(msg) {
  if (!getRollbackInputRequest() || !msg || msg.role !== 'user') return false;
  if (msg.source === 'handoff-seed') return false;
  const available = getAvailableCallIndices();
  if (available === null) return true;
  if (!available.includes(msg.turn)) return false;
  // 新增：mid-call user message（同 turn 已有更早的 user message）不显示按钮
  const index = currentMessages.indexOf(msg);
  const hasEarlierUserInSameTurn = currentMessages
    .slice(0, index)
    .some(m => m.role === 'user' && m.turn === msg.turn);
  return !hasEarlierUserInSameTurn;
}
```

**文件**：`AgentDevClaw/public/src/modules/input-helpers.js` 第 193-201 行

---

## 7. 实施检查清单

### Phase 1：修复通讯 bug（必须）

- [ ] **AgentDev 框架**：`viewer-worker.ts` — 移除 `handleQueueInput` 中的 UDS 转发和 `useArbiterQueue` 赋值
- [ ] **AgentDev 框架**：`viewer-worker.ts` — 移除 `handleDequeueInput` 中的 `useArbiterQueue` 检查
- [ ] **AgentDev 框架**：构建 dist（`cd AgentDev && npm run build`）
- [ ] **AgentDevClaw**：`run-prebuilt-agent.js` — 移除 `setQueuedInputHandler` 调用
- [ ] **AgentDevClaw**：`run-prebuilt-agent.js` — 移除 `onStepStart` 中的 supplement drain 逻辑
- [ ] **AgentDevClaw**：`call-arbiter.js` — 清理 supplement 相关代码（建议保留方法签名）
- [ ] **验证**：启动 agent，在运行中发送纯文本暂存消息，确认在下一个 step 间隙被注入为 user message
- [ ] **验证**：发送含图片的暂存消息，确认同样在 step 间隙被注入
- [ ] **验证**：前端队列指示器在消息被处理后正确消失
- [ ] **验证**：`npm run test:core` 全绿

### Phase 2：UX 适配（可选）

- [ ] **AgentDevClaw**：`input-helpers.js` — `canRollbackMessage` 增加 mid-call message 隐藏按钮逻辑
- [ ] **AgentDevClaw**（可选）：`session-helpers-pure.js` — `buildSessionTrimPreview` 改为按 `turn` 分组
- [ ] **验证**：mid-call user message 不再显示"编辑此轮"按钮
- [ ] **验证**：trim preview 不再显示多余的 round

---

## 附录：关键文件索引

### AgentDev 框架侧

| 文件 | 关键行 | 职责 |
|------|--------|------|
| `src/core/viewer-worker.ts` | 1084-1138 | `handleQueueInput`：存储 + UDS 转发 + useArbiterQueue 设置 |
| `src/core/viewer-worker.ts` | 1156-1184 | `handleDequeueInput`：useArbiterQueue 门控 + 实际 dequeue |
| `src/core/viewer-worker.ts` | 216-257 | `handleUDSMessage`：UDS 消息分发 |
| `src/core/viewer-worker.ts` | 1339-1393 | `handleRegisterAgent`：session.clientId 设置 |
| `src/core/debug-hub.ts` | — | `handleWorkerMessage` → `case 'queue-input'`：queuedInputHandler 调用 |
| `src/core/agent/react-loop.ts` | 591-612 | `fetchQueuedInput`：step 级队列检查（改动后为唯一路径） |
| `src/core/agent/react-loop.ts` | 568-571 | step auto-save 触发 |
| `src/core/agent.ts` | 280-400 | `onCall`：call 生命周期、checkpoint 创建、ReAct 循环 |
| `src/core/agent.ts` | 607-622 | `createSessionSnapshot` |
| `src/core/agent.ts` | 665-687 | `rollbackToCall` |
| `src/core/agent.ts` | 818-842 | `enableStepAutoSave` / `_createStepSaveFn` |
| `src/core/agent.ts` | 1430-1480 | `ensureExecutorsInitialized`：ReActLoop 创建 |
| `src/core/agent.ts` | 1526-1530 | `commitCallCheckpoint` |
| `src/core/context.ts` | 225-231 | `addUserMessage`：turn 赋值 + 双数组更新 |
| `src/core/context.ts` | 476-483 | `captureBoundary`：长度快照 |
| `src/core/context.ts` | 530-540 | `truncateToBoundary`：长度截断 |

### AgentDevClaw 侧

| 文件 | 关键行 | 职责 |
|------|--------|------|
| `scripts/run-prebuilt-agent.js` | 336-346 | `getNextTurnActions`：availableCallIndices 来源 |
| `scripts/run-prebuilt-agent.js` | 560-570 | `setQueuedInputHandler`：UDS → CallArbiter.enqueue |
| `scripts/run-prebuilt-agent.js` | 585-602 | `onStepStart`：supplement drain + system message 注入 |
| `scripts/run-prebuilt-agent.js` | 761-803 | 主输入循环：getUserInputEvent → enqueue → waitForCompletion |
| `server/call-arbiter.js` | 90-130 | `enqueue`：supplement vs queue 分流 |
| `server/call-arbiter.js` | 250-330 | `_kick` / `_runEnvelope`：call 执行 + .finally() |
| `server/call-arbiter.js` | 343-400 | continuation barrier（checkpoint/rollback 循环） |
| `server/call-arbiter.js` | 417-450 | `_checkpointBarrier` / `_rollbackBarrier` |
| `server/shared/proxy.js` | 20-51 | `proxyToViewer`：HTTP 请求代理 |
| `server/routes/session.js` | 279-301 | `session_trim_preview` 路由 |
| `server/routes/session.js` | 303-420 | `sessions/branch` 路由（maxUserTurn 计算） |
| `server/routes/session-helpers-pure.js` | 186-236 | `buildSessionTrimPreview`：按 role='user' 切分 round |
| `server/routes/session-handoff-helpers.js` | 359-403 | summary 消息读取（过滤 system） |
| `local-features/checkpoint/src/index.ts` | 全文 | CheckpointFeature：set_checkpoint / rollback_to_checkpoint 工具 |
| `public/src/modules/persistent-input.js` | — | 前端暂存输入 UI + queue-input 请求发送 |
| `public/src/modules/input-helpers.js` | 168-201 | `canRollbackMessage` / `getAvailableCallIndices` |
| `public/src/modules/chat-renderer.js` | 50-79 | 消息渲染 + "编辑此轮"按钮 |
| `public/src/modules/rollback-dialog.js` | 82-188 | `requestRollbackEdit` + rollback dialog |
