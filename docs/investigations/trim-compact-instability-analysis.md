# Trim/Partial-Compact 不稳定问题分析

> 提交 `300542fd50df364358f2427734d0e97536295457` 后出现
> 分析日期：2026-06-20

## 一、问题现象

| # | 症状 | 描述 |
|---|------|------|
| 1 | 新会话中实际上没有精简 | 执行 Trim（精简历史）后，产生的新会话中消息没有被实际裁剪/折叠 |
| 2 | 折叠后的工具调用内容直接消失 | 经过 partial-compact（从此处压缩）或 trim 折叠后，工具调用相关内容在 UI 中消失 |

用户判断：问题大概出现在 `300542fd` 提交之后。该提交修复了 branched session 的 turn/callIndex 脏数据问题，但修复本身似乎引入了回归。

---

## 二、关键提交内容速览

```
commit 300542fd
feat: 新增会话归档与部分压缩功能，更新默认模型
```

该提交修改了 **15 个文件**，与 trim/compact 直接相关的核心变更：

### 2.1 scripts/run-prebuilt-agent.js（+330 行）

| 变更 | 位置 | 说明 |
|------|------|------|
| 新增 `compact_from_call` action | `NEXT_TURN_ACTIONS` 数组（~L235） | 回退对话框新增"从此处压缩"选项 |
| 新增 `buildPartialCompactSummaryContent()` | ~L1082 | 构建压缩摘要 system 消息内容 |
| 新增 `generatePartialInProcessSummary()` | ~L1108 | 调用 LLM 生成部分摘要 |
| 新增 `rollbackToCallAndSave()` | ~L1204 | 提取回滚+保存为独立函数 |
| **新增 `triggerPartialCompact()`** | **~L1244** | **核心：in-session 部分压缩** |
| 修改 `handleInputResponse()` | ~L1350 | 新增 `compact_from_call` 分支 |
| **修改 `callFinished` 事件** | **~L1538** | **新增 `session_meta_sync` 推送** |

### 2.2 server.js（+287 行）

| 变更 | 位置 | 说明 |
|------|------|------|
| **修改 `/protoclaw/sessions/branch`** | **~L7238** | **`initialized: false→true`, `callIndex: 0→maxUserTurn`** |
| 新增 checkpoint/enrichedMessages 过滤 | ~L7277-7292 | 分支会话截断 rollbackHistory 和 enrichedMessages |
| 修改 `buildLightPrebuiltSessionRecord()` | ~L3240 | 从 `exists:false, count:0` 改为使用缓存元数据 |
| 新增 `META_VERSION` 和 fast path | ~L3414, ~L3393 | `summarizePrebuiltSession` 新增缓存命中快速路径 |
| 新增 `session_meta_sync` 端点 | ~L8389 | runtime 子进程在保存后推送元数据 |
| 新增 `archivePrebuiltSession()` | ~L3989 | 会话归档功能 |
| `requireAgent` 拆分为 `requireAgentLight` | ~L4842 | 多处改用轻量版 |

### 2.3 public/src/app-main.js（+392 行）

| 变更 | 位置 | 说明 |
|------|------|------|
| **新增 `findFirstChangedMessageIndex()`** | **~L4465** | **逐条比较消息变化，返回首个差异索引** |
| **重写 `poll()` 渲染逻辑** | **~L4667-4710** | **append 条件从"长度增加"变为"长度增加且前缀不变"** |
| 新增 `_partialCompactInFlight` 状态机 | ~L6171 | partial compact 进行中状态 |
| 新增 `showRollbackActionDialog()` | ~L6063 | 回退/压缩选择对话框 |
| 修改 `renderInputRequests()` | ~L5069 | partial compact 进行中时显示压缩状态 |
| 修改 `getRollbackInputRequest()` | ~L5865 | 同时匹配 `rollback_to_call` 和 `compact_from_call` |
| 新增 `ctxGenerateTitle()` | ~L2886 | AI 生成标题 |
| 新增 `ctxArchiveSession()` | ~L2925 | 归档会话 |
| 修改滚动监听逻辑 | ~L4161 | 向下滚动不再立即取消 follow |

### 2.4 新文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `server/conversation-renderer.js` | 880 | 对话导出为自包含 HTML |
| `public/src/modules/session-ui.js` | 781 | 从 app-ui.js 拆出的会话 UI |
| `test/partial-compact-rollback.test.js` | 103 | partial compact 回退测试 |
| `test/_render-test.mjs` | 66 | 渲染测试脚本 |

---

## 三、两条 Trim 路径的完整数据流

### 3.1 路径 A：Trim 精简历史（创建新会话）

```
用户点击"精简历史（Trim）"
  │
  ▼ session-dialogs.js L67: openTrimDialog()
  │   GET /protoclaw/session_trim_preview?agentId=...&sessionId=...
  │   server.js L7214-7236: 读取 session 文件 → buildSessionTrimPreview()
  │   server.js L3358-3408: 按 user 消息分组 → rounds[]
  │
  ▼ 用户选择保留轮次，点击提交
  │   session-dialogs.js L175: submitTrimCompact()
  │   计算 fullPreserveFromTurn = rounds[firstKeptIndex].turnStart
  │   调用 createCompactedResumeSession(agentId, sessionId, '', null, fullPreserveFromTurn, policy)
  │
  ▼ app-main.js L1212-1283: createCompactedResumeSession()
  │   strategy='' → 跳过 live-runtime 快捷路径
  │   POST /protoclaw/context_handoffs/compact_and_resume { detached: false, policy }
  │
  ▼ server.js L9244-9292: compact_and_resume 端点
  │   调用 compactAndResumeCurrentSession()
  │     server.js L4436-4451
  │     → exportContextHandoffForSession(sessionId, agentId, policy)
  │       server.js L4324-4361
  │       strategy !== 'summarized-nine-section'
  │       → exportHistoryOnlyHandoffPackage()
  │         handoff-package.js L493-537
  │         读取 session 文件 → buildTrimmedSeedMessages(rawMessages, policy)
  │         handoff-package.js L306-491
  │         写入 handoff JSON 文件
  │     → createCompactedResumeFromHandoff()
  │       server.js L4363-4434
  │       创建新 session → startManagedAgent() 启动 runtime
  │
  ▼ runtime 子进程启动
  │   run-prebuilt-agent.js L1447-1455: 挂载 ContextHandoffSeedFeature
  │   run-prebuilt-agent.js L1482-1488: loadSession() 失败（新 session，无文件）
  │   → _callIndex = -1, _initialized = false
  │
  ▼ 用户发送第一条消息
  │   agent.ts L265: nextCallIndex = -1+1 = 0
  │   agent.ts L304-323: onInitiate 运行，系统提示词注入（turn=0）
  │   agent.ts L334: CallStart hooks
  │     context-handoff-seed/src/index.ts L153-205: 注入 seedMessages
  │     → ctx.context.add({ ...message, turn, source: 'handoff-seed' })
  │     → agentRef._callIndex = injectionTurn - 1
  │   agent.ts L346: context.addUserMessage(finalInput, this._callIndex)
  │     ⚠️ this._callIndex 已被 seed feature 修改！
  │
  ▼ 前端轮询检测到新消息
      app-main.js L4621: poll()
      findFirstChangedMessageIndex(messages, currentMessages)
      → currentMessages 为空，firstChangedIndex = 0
      → appendNewMessages(messages, 0)
```

### 3.2 路径 B：Partial Compact 从此处压缩（原地修改当前会话）

```
用户在回退对话框选择"从此处压缩"
  │
  ▼ app-main.js L6063: showRollbackActionDialog() → 点击 compact
  │   设置 _partialCompactInFlight = true
  │   submitInputAction(request.requestId, 'compact_from_call', { callIndex })
  │
  ▼ runtime 接收 action
  │   run-prebuilt-agent.js L1395-1402: handleInputResponse() → compact_from_call
  │   调用 triggerPartialCompact(callIndex, feedback)
  │
  ▼ run-prebuilt-agent.js L1244-1348: triggerPartialCompact()
  │   1. 获取 rawMessages = context.getAll()
  │   2. 通过 callIndex 查找 pivotMsgIndex
  │   3. keptMessages = rawMessages.slice(0, pivotMsgIndex)
  │   4. generatePartialInProcessSummary() 调用 LLM 生成摘要
  │   5. rollbackToCallAndSave(callIndex) → agent.rollbackToCall()
  │      → restoreRuntimeSnapshot() 恢复 checkpoint
  │      → _callCheckpoints 过滤掉 >= callIndex 的
  │   6. ctx.restore({ messages: [...keptMessages, summaryMsg], enrichedMessages: [], sequence: 0 })
  │      ⚠️ enrichedMessages 被清空！
  │   7. agent.saveSession() → 保存到磁盘
  │   8. agent['pushToDebug'](ctx.getAll()) → 推送到 DebugHub
  │
  ▼ 前端轮询
      poll() 检测到消息变化
      findFirstChangedMessageIndex → full rebuild
      renderCurrentMainView() → render(currentMessages)
```

---

## 四、逐项分析

### 4.1 已确认正常的部分

以下环节经代码审查确认逻辑正确，**不是**根因：

| 环节 | 文件位置 | 结论 |
|------|----------|------|
| `buildSessionTrimPreview()` | server.js L3358-3408 | 正确按 user turn 分组 |
| `buildTrimmedSeedMessages()` | handoff-package.js L306-491 | 正确执行 fold/drop/preserve |
| `normalizeExportPolicy()` | handoff-package.js L111-130 | 正确归一化 policy |
| `exportHistoryOnlyHandoffPackage()` | handoff-package.js L493-537 | 正确读取 session 文件并写入 handoff |
| `createCompactedResumeFromHandoff()` | server.js L4363-4434 | 正确创建新 session 并启动 runtime |
| Trim 不走 `/sessions/branch` | — | trim 用 `compact_and_resume`，不经过 branch 端点 |
| `render()` 中 tool 消息渲染 | app-main.js L6860-6897 | 完整渲染：搜索 toolCallId → 渲染结果 |
| `appendNewMessages()` 中 tool 消息渲染 | app-main.js L6486-6529 | 完整渲染：搜索 currentMessages 中的 toolCall |
| `updateLastMessage()` 中 tool 消息更新 | app-main.js L6567-6601 | 完整渲染：更新 tool-result-body |

### 4.2 重点怀疑项

---

#### 怀疑 1：`ContextHandoffSeedFeature` 的 `_callIndex` 推进导致 turn 碰撞

**文件**：`local-features/context-handoff-seed/src/index.ts` L153-181

```typescript
// L159: fallbackTurn = agent._callIndex = 0（首次 onCall 时）
// L166-172: 遍历 seedMessages，injectionTurn = max(所有 seed turn + 1)
//   例如 seed turns = [0,1,2,3,4,5] → injectionTurn = 6
// L178-179: agentRef._callIndex = injectionTurn - 1 = 5
```

然后在 `agent.ts` L346：

```typescript
context.addUserMessage(finalInput, this._callIndex);
// this._callIndex 已经被 seed feature 修改为 5
// 用户消息获得 turn = 5，与最后一条 seed 消息（turn=5）碰撞！
```

**影响**：
- 用户消息与 seed 消息共享同一个 turn
- 后续 trim 时 `buildSessionTrimPreview` 可能将它们归入同一 round
- 两次 trim 同一个 compacted session 时，round 边界不正确

**注意**：此问题是 **pre-existing** 的，并非 `300542fd` 引入。但 `300542fd` 修改了 branched session 的 `callIndex` 赋值方式后，branched → trim → 再 trim 的链路中可能暴露此问题。

---

#### 怀疑 2：`triggerPartialCompact` 的 `enrichedMessages: []` 破坏上下文一致性

**文件**：`scripts/run-prebuilt-agent.js` L1335

```javascript
ctx.restore({ version: 2, messages: finalMessages, enrichedMessages: [], sequence: 0 });
```

**Context 类的数据结构**（`AgentDev/src/core/context.ts`）：

```
Context
├── messages: Message[]           ← getAll() 返回此数组
├── enrichedMessages: EnrichedMessage[]  ← query()/getByTurn() 依赖此数组
└── sequence: number
```

`enrichedMessages` 是带元数据（tags, parsed, turn）的消息副本，供 Feature 的 `context.query()` 等高级查询使用。

**restore 之后的状态**：
- `messages`：[keptMessages..., summary] ✓ 正确
- `enrichedMessages`：[] ✗ 空！

**后续 onCall 时的新消息会同时写入两个数组**：
- `addUserMessage()` → `this.messages.push(...)` + `this.addMessage(msg, meta)` → `this.enrichedMessages.push(enriched)`
- 但 pre-existing 的 keptMessages 只在 `messages` 中，不在 `enrichedMessages` 中

**影响路径**：
1. session 保存时 `context.toJSON()` 包含 `enrichedMessages: []`
2. session 重新加载后 `enrichedMessages` 为空
3. 如果后续对修改后的 session 执行 trim，`buildSessionTrimPreview` 读取的是 `messages`（正确）
4. 但如果有 Feature 依赖 `enrichedMessages` 做决策（例如 FlowFeature 的 `@CallStart` hook 收集变量），行为可能异常

---

#### 怀疑 3：`triggerPartialCompact` 中 `keptMessages` 与 rollback 后的 context 不一致

**文件**：`scripts/run-prebuilt-agent.js` L1303, L1310, L1324-1335

```javascript
// L1257: rawMessages = context.getAll()  ← 回滚前的完整消息
// L1303: keptMessages = rawMessages.slice(0, pivotMsgIndex)  ← 基于回滚前数据切片
// L1310: rollbackToCallAndSave(callIndex)  ← 回滚修改了 context
// L1324: finalMessages = [...keptMessages, summaryMsg]  ← 用回滚前的切片
// L1335: ctx.restore({ messages: finalMessages })  ← 覆盖回滚后的 context
```

**时序**：
1. `rawMessages` 在回滚前捕获
2. `rollbackToCall` 恢复了 checkpoint 的 context（消息截至 callIndex-1）
3. 但 `keptMessages` 来自回滚前的 `rawMessages.slice(0, pivotMsgIndex)`
4. `ctx.restore` 用 `keptMessages` 覆盖了回滚后的 context

**分析**：正常情况下，checkpoint 的消息 = `rawMessages.slice(0, pivotMsgIndex)`。但如果 checkpoint 与 rawMessages 前缀不一致（例如 session 经历过 partial-compact 后 enrichedMessages 为空，checkpoint capture 的 context 有差异），则 `keptMessages` 可能包含比 checkpoint 更多或更少的消息。

---

#### 怀疑 4：`findFirstChangedMessageIndex` + `render()` dedup 交互

**文件**：
- `findFirstChangedMessageIndex()`：`app-main.js` ~L4465
- `render()` dedup：`app-main.js` ~L6745-6752

**`findFirstChangedMessageIndex` 实现**：

```javascript
function findFirstChangedMessageIndex(nextMessages, previousMessages) {
  const length = Math.min(nextMessages.length, previousMessages.length);
  for (let i = 0; i < length; i++) {
    if (JSON.stringify(nextMessages[i]) !== JSON.stringify(previousMessages[i])) {
      return i;
    }
  }
  return nextMessages.length === previousMessages.length ? -1 : length;
}
```

**`render()` dedup 签名**：

```javascript
const _sig = messages.length + ':'
  + messages[messages.length - 1].role + ':'
  + (messages[messages.length - 1].content || '').length + ':'
  + Object.keys(toolRenderConfigs).length;
if (_sig === _lastRenderedChatSig && container.querySelector('.message-row')) {
  return;  // 跳过渲染！
}
```

**poll 渲染逻辑变化**（核心差异）：

```
旧代码：
  messages.length > currentMessages.length → 总是 append

新代码：
  messages.length > currentMessages.length && firstChangedIndex === currentMessages.length → append
  否则 → full rebuild (renderCurrentMainView)
```

**潜在问题场景**：

1. `appendNewMessages` 追加消息后，`_lastRenderedChatSig` **不更新**（只在 `render()` 内更新）
2. 后续 poll 触发 full rebuild → `render()` 检查 dedup
3. 如果消息总数、最后消息 role/content.length、toolRenderConfigs 数量恰好匹配 → **渲染被跳过**
4. 变更（如 tool call 内容更新）不可见

**但**：追加消息后总数增加，dedup 签名中的 `messages.length` 必然变化，所以此场景在实践中 **难以触发**。除非存在消息先增后减（如 retry 空响应时 pushToDebug 临时消息）的中间态。

---

#### 怀疑 5：`pushToDebug` 临时消息造成 firstChangedIndex 偏移

**文件**：`AgentDev/src/core/agent/react-loop.ts` L215-218

```typescript
// LLM 返回空响应时，pushToDebug 推送临时错误消息（不入 context）
this.pushToDebug([
  ...context.getAll(),
  { role: 'assistant', content: '[Error: LLM returned empty response]', turn: callIndex },
]);
```

**场景**：
1. Poll N：获取到 [..., error_msg]（debug hub 中的临时状态）
2. `currentMessages` = [..., error_msg]
3. Poll N+1：retry 成功，debug hub 更新为 [..., user(1), assistant(1), tool(1)]
4. `findFirstChangedIndex` 在 error_msg 位置检测到变化
5. 新代码：因为 `firstChangedIndex !== currentMessages.length`，走 full rebuild
6. 旧代码：因为 `messages.length > currentMessages.length`，走 append → error_msg 残留在 DOM

**结论**：新代码在 **此场景下行为更正确**（旧代码有 bug）。但新代码更频繁地触发 full rebuild 可能暴露 `render()` dedup 的潜在问题。

---

#### 怀疑 6：`session_meta_sync` 的 fast path 返回过期元数据

**文件**：
- 推送：`run-prebuilt-agent.js` L1540-1565
- 接收：`server.js` L8389-8450 (`session_meta_sync` 端点)
- 消费：`server.js` L3393-3451 (`summarizePrebuiltSession` fast path)

**fast path 判断条件**：

```javascript
if (
  record.fileMtimeMs === stat.mtimeMs &&  // 文件未修改
  record.fileSize === stat.size &&
  record.metaVersion === META_VERSION &&
  typeof record.messageCount === 'number' &&
  typeof record.preview !== 'undefined' &&
  record.tokenUsage
) {
  // 直接返回缓存数据，不读取文件
}
```

**潜在问题**：
- `session_meta_sync` 在 `saveSession` 完成后异步推送
- 如果 `saveSession` 和 `session_meta_sync` 之间有另一个 save（step auto-save），stat 可能不匹配 → fast path 不命中 → 安全
- 但如果文件系统 mtime 精度不足（Windows FAT32 等），两次快速连续 save 可能产生相同 mtime → fast path 误命中

**对 trim 的影响**：trim 直接读取 session 文件（`fs.readFile`），**不走 fast path**。但 trim preview 的 session 列表显示可能不准确（messageCount 不对），让用户误以为"没有精简"。

---

#### 怀疑 7：branched session 的 `initialized: true` 跳过 onInitiate

**文件**：`server.js` L7317-7331

```javascript
const branchSnapshot = {
  ...sourceSnapshot,
  runtime: {
    ...(sourceSnapshot.runtime || {}),
    initialized: true,          // 旧值: false
    callIndex: maxUserTurn,     // 旧值: 0
    context: {
      ...(sourceSnapshot.runtime?.context || {}),
      messages: branchMessages,
      enrichedMessages: branchEnriched,
    },
  },
  rollbackHistory: branchCheckpoints,
};
```

**影响**：
- `initialized: true` → 下次 `onCall` 时跳过 `onInitiate`（`agent.ts` L304）
- 系统提示词不会被重新注入（但已在 messages 中，OK）
- Feature 的 `onInitiate` 不会重新执行（`context-handoff-seed` 的 `onInitiate` 只设置 logger，OK）
- `isFirstCall = nextCallIndex === 0` → 对于 branched session，`nextCallIndex = maxUserTurn + 1 ≠ 0` → `isFirstCall = false`
- seed feature 的 `@CallStart` 检查 `!ctx.isFirstCall` → **不注入**（OK，branched session 没有 handoff）

**但对 branched → compact 链路的影响**：
- branched session 的 `callIndex = maxUserTurn`
- 后续新消息获得 `turn = maxUserTurn + 1, maxUserTurn + 2, ...`
- session 保存时 `_callIndex` 正确
- trim 此 session 时，turn 值连续，`buildSessionTrimPreview` 分组正确

**结论**：此变更本身正确，但与怀疑 1（seed feature turn 碰撞）组合时可能产生复合问题。

---

## 五、问题复现路径推测

### 5.1 "新会话中实际上没有精简"的最可能路径

```
1. 用户有一个经过 partial-compact 的 session
   → session 文件中 messages 正确，但 enrichedMessages = []
   → _callIndex 可能与 messages 中的最大 turn 不一致

2. 用户对此 session 执行 Trim
   → buildSessionTrimPreview 读取 messages（正确）
   → 但如果 messages 的 turn 值有问题（如怀疑 1 的碰撞），
     rounds 分组可能不正确
   → fullPreserveFromTurn 可能 = 0（如果第一个 user message 的 turn=0
     且用户保留了第一轮）
   → buildTrimmedSeedMessages 中 hasPreserveBoundary=true && fullPreserveFrom=0
     → 所有消息 turn >= 0 → 全部保留 → 无精简！
```

**关键**：当 `fullPreserveFromTurn = 0` 时，所有消息的 `turn >= 0` 都满足 preserve 条件，**不会折叠任何内容**。

这在以下场景中发生：
- compacted/resumed session 的 seed 消息包含 turn=0 的 user message
- 用户在 trim 对话框中保留了第一轮
- `rounds[0].turnStart = 0` → `fullPreserveFromTurn = 0`

### 5.2 "折叠后的工具调用内容直接消失"的最可能路径

```
路径 A（trim 后的系统消息被隐藏）：
1. Trim 折叠 tool calls → 生成 role='system' 的 fold note
   handoff-package.js L290-304: flushPendingToolFold()
   → createSeedMessage('system', '[Folded tool activity]...', turn)
2. 新 session 启动，seed 消息注入
3. 前端渲染
4. applyConversationProcessState() 隐藏所有 system 消息：
   app-main.js L6102: row.classList.toggle('process-hidden', !showChatProcess)
5. 如果 showChatProcess = false → fold note 不可见！
   → 用户看到"工具调用内容消失了"

路径 B（partial-compact 后 pushToDebug 与 poll 的竞态）：
1. triggerPartialCompact 执行
2. ctx.restore() 替换 messages
3. agent.saveSession() 保存
4. pushToDebug(ctx.getAll()) 推送新消息
5. 但前端 poll 可能在步骤 3-4 之间执行：
   → 获取到回滚后但未注入 summary 的中间态
   → 消息突然变少 → tool call 内容"消失"
6. 下一次 poll 获取到最终态 → full rebuild → 内容恢复
   → 但用户可能已经看到了中间态
```

---

## 六、代码位置索引

### 6.1 Trim 核心逻辑

| 功能 | 文件 | 行号 |
|------|------|------|
| `buildSessionTrimPreview()` | `server.js` | L3358-3408 |
| `buildTrimmedSeedMessages()` | `server/context-continuity/handoff-package.js` | L306-491 |
| `normalizeExportPolicy()` | `server/context-continuity/handoff-package.js` | L111-130 |
| `getMessageTurn()` | `server/context-continuity/handoff-package.js` | L221-223 |
| `getRetainedTurnSet()` | `server/context-continuity/handoff-package.js` | L225-234 |
| `getFoldedToolTurnSet()` | `server/context-continuity/handoff-package.js` | L236-247 |
| `getSkillInvokeProtectedTurns()` | `server/context-continuity/handoff-package.js` | L262-278 |
| `createSeedMessage()` | `server/context-continuity/handoff-package.js` | L280-288 |
| `flushPendingToolFold()` | `server/context-continuity/handoff-package.js` | L290-304 |
| `shouldKeepDialogueMessage()` | `server/context-continuity/handoff-package.js` | L249-254 |
| `shouldHandleToolActivity()` | `server/context-continuity/handoff-package.js` | L256-260 |
| `summarizeAssistantToolCalls()` | `server/context-continuity/handoff-package.js` | L207-219 |
| `exportHistoryOnlyHandoffPackage()` | `server/context-continuity/handoff-package.js` | L493-537 |
| `exportContextHandoffForSession()` | `server.js` | L4324-4361 |
| `compactAndResumeCurrentSession()` | `server.js` | L4436-4451 |
| `createCompactedResumeFromHandoff()` | `server.js` | L4363-4434 |
| Trim preview 端点 | `server.js` | L7214-7236 |
| Compact & resume 端点 | `server.js` | L9244-9292 |
| 前端 Trim 对话框 | `public/src/modules/session-dialogs.js` | L67-215 |
| 前端 `createCompactedResumeSession()` | `public/src/app-main.js` | L1212-1283 |

### 6.2 Partial Compact 核心逻辑

| 功能 | 文件 | 行号 |
|------|------|------|
| `triggerPartialCompact()` | `scripts/run-prebuilt-agent.js` | L1244-1348 |
| `generatePartialInProcessSummary()` | `scripts/run-prebuilt-agent.js` | L1108-1200 |
| `buildPartialCompactSummaryContent()` | `scripts/run-prebuilt-agent.js` | L1082-1098 |
| `rollbackToCallAndSave()` | `scripts/run-prebuilt-agent.js` | L1204-1236 |
| `compact_from_call` action 处理 | `scripts/run-prebuilt-agent.js` | L1395-1402 |
| 前端 `showRollbackActionDialog()` | `public/src/app-main.js` | L6063-6156 |
| 前端 partial compact 状态管理 | `public/src/app-main.js` | L6171-6220 |
| 前端 partial compact 渲染 | `public/src/app-main.js` | L5069-5126 |

### 6.3 Seed Feature

| 功能 | 文件 | 行号 |
|------|------|------|
| `ContextHandoffSeedFeature` 类 | `local-features/context-handoff-seed/src/index.ts` | L91-363 |
| `injectHandoffSummary()` `@CallStart` | 同上 | L153-205 |
| `_callIndex` 推进逻辑 | 同上 | L174-180 |
| `injectImportantContext()` | 同上 | L207-225 |
| Seed feature 挂载 | `scripts/run-prebuilt-agent.js` | L1447-1455 |
| `Context.add()` 方法 | `AgentDev/src/core/context.ts` | L55-58 |
| `Context.getAll()` 方法 | `AgentDev/src/core/context.ts` | L73-75 |
| `Context.restore()` 方法 | `AgentDev/src/core/context.ts` | L148-160 |
| `Context.toJSON()` 方法 | `AgentDev/src/core/context.ts` | L123-134 |

### 6.4 Agent 生命周期与 Turn 赋值

| 功能 | 文件 | 行号 |
|------|------|------|
| `_callIndex` 初始化 | `AgentDev/src/core/agent.ts` | L105 |
| `onCall` 入口：nextCallIndex 计算 | `AgentDev/src/core/agent.ts` | L265-274 |
| `onInitiate` 执行（首次） | `AgentDev/src/core/agent.ts` | L304-323 |
| CallStart 反向钩子 | `AgentDev/src/core/agent.ts` | L334 |
| 用户消息添加（turn 赋值） | `AgentDev/src/core/agent.ts` | L346 |
| `captureRuntimeSnapshot()` | `AgentDev/src/core/agent.ts` | L1417-1426 |
| `restoreRuntimeSnapshot()` | `AgentDev/src/core/agent.ts` | L1428-1443 |
| `rollbackToCall()` | `AgentDev/src/core/agent.ts` | L637-650 |
| `restoreSessionSnapshot()` | `AgentDev/src/core/agent.ts` | L598-614 |
| `loadSession()` | `AgentDev/src/core/agent.ts` | L766-769 |
| `commitCallCheckpoint()` | `AgentDev/src/core/agent.ts` | L1445-1449 |

### 6.5 前端渲染

| 功能 | 文件 | 行号 |
|------|------|------|
| `findFirstChangedMessageIndex()` | `public/src/app-main.js` | ~L4465 |
| `poll()` 渲染决策 | `public/src/app-main.js` | ~L4667-4710 |
| `render()` 全量渲染 + dedup | `public/src/app-main.js` | L6732-6928 |
| `render()` dedup 签名 | `public/src/app-main.js` | L6745-6752 |
| `renderMessage()` 单条消息 | `public/src/app-main.js` | L6333-6465 |
| `renderMessage()` tool 返回空 | `public/src/app-main.js` | L6454 |
| `appendNewMessages()` | `public/src/app-main.js` | L6468-6553 |
| `updateLastMessage()` | `public/src/app-main.js` | L6556-6626 |
| `renderCurrentMainView()` | `public/src/app-ui.js` | L5740-5836 |
| `applyConversationProcessState()` | `public/src/app-main.js` | L6101-6121 |
| `syncCollapseStates()` | `public/src/app-main.js` | L6682-6688 |
| `syncRowCollapseState()` | `public/src/app-main.js` | L6635-6680 |
| `restoreUserCollapseState()` | `public/src/app-main.js` | L6698-6730 |
| `syncAssistantProcessOnlyRows()` | `public/src/app-main.js` | L6079-6099 |

### 6.6 Branch 端点变更

| 功能 | 文件 | 行号 |
|------|------|------|
| `/protoclaw/sessions/branch` 端点 | `server.js` | L7238-7400 |
| maxUserTurn 计算 | `server.js` | L7270-7275 |
| checkpoint 过滤 | `server.js` | L7277-7284 |
| enrichedMessages 过滤 | `server.js` | L7286-7292 |
| branchSnapshot 构造 | `server.js` | L7317-7332 |

### 6.7 Session 元数据同步

| 功能 | 文件 | 行号 |
|------|------|------|
| `callFinished` 事件处理 | `scripts/run-prebuilt-agent.js` | L1538-1565 |
| `session_meta_sync` 端点 | `server.js` | L8389-8450 |
| `META_VERSION` 常量 | `server.js` | L3414 |
| `summarizePrebuiltSession` fast path | `server.js` | L3393-3451 |
| `buildLightPrebuiltSessionRecord()` | `server.js` | L3240-3257 |
| `listPrebuiltSessions()` writeback | `server.js` | L3605-3649 |

### 6.8 ReAct 循环中的消息添加

| 功能 | 文件 | 行号 |
|------|------|------|
| assistant 消息添加 | `AgentDev/src/core/agent/react-loop.ts` | L221 |
| tool 消息添加（成功） | `AgentDev/src/core/agent/react-loop.ts` | L393 |
| tool 消息添加（失败） | `AgentDev/src/core/agent/react-loop.ts` | L312 |
| 空响应 retry + pushToDebug 临时消息 | `AgentDev/src/core/agent/react-loop.ts` | L215-218 |
| 排队输入添加 | `AgentDev/src/core/agent/react-loop.ts` | L557 |
| 错误消息添加 | `AgentDev/src/core/agent/react-loop.ts` | L514 |

### 6.9 DebugHub 消息推送

| 功能 | 文件 | 行号 |
|------|------|------|
| `pushToDebug()` (agent) | `AgentDev/src/core/agent.ts` | L1404-1409 |
| `pushMessages()` (debug hub) | `AgentDev/src/core/debug-hub.ts` | L464-477 |
| `pushMessages()` (claw client) | `AgentDev/src/core/claw-debug-client.ts` | L125 |

---

## 七、建议排查方向

### 7.1 最高优先级

1. **验证 seed feature 的 turn 碰撞**（怀疑 1）
   - 在 compacted session 的第一条用户消息后检查 `message.turn` 是否与 seed 消息碰撞
   - 修复方案：`agentRef._callIndex = injectionTurn`（而非 `injectionTurn - 1`），使首条用户消息获得 `turn = injectionTurn + 1`（onCall 的 `nextCallIndex = injectionTurn + 1`）
   - 文件：`local-features/context-handoff-seed/src/index.ts` L178-179

2. **验证 `fullPreserveFromTurn = 0` 时的行为**（怀疑 → 症状 1）
   - 当 `rounds[firstKeptIndex].turnStart = 0` 时，`fullPreserveFromTurn = 0`
   - `buildTrimmedSeedMessages` 中 `hasPreserveBoundary = true && turn >= 0` → 全部保留
   - 需要确认：用户是否在 trim 时保留了第一轮？
   - 文件：`server/context-continuity/handoff-package.js` L360

### 7.2 中等优先级

3. **修复 `triggerPartialCompact` 的 enrichedMessages 清空**（怀疑 2）
   - 替代方案：从 keptMessages 重建 enrichedMessages，而非传空数组
   - 或使用 `ctx.restore({ ..., enrichedMessages: keptEnriched })` 其中 `keptEnriched` 从 rawMessages 的 enriched 副本中截取
   - 文件：`scripts/run-prebuilt-agent.js` L1335

4. **验证 partial-compact 的竞态窗口**（怀疑 → 症状 2 路径 B）
   - 在 `rollbackToCallAndSave` 和 `ctx.restore` 之间，前端 poll 可能获取到中间态
   - 建议在 `triggerPartialCompact` 开始时设置某种"压缩中"标志，阻止前端渲染中间态
   - 前端已有 `_partialCompactInFlight` 标志，但仅影响输入区域渲染，不影响消息渲染

### 7.3 低优先级

5. **审查 `findFirstChangedMessageIndex` 的 `JSON.stringify` 稳定性**
   - 确认 DebugHub API 返回的消息字段一致性
   - 特别关注 `undefined` vs 不存在 vs `null` 的差异

6. **审查 `render()` dedup 签名的粗粒度问题**
   - 当前签名仅基于 `length:lastRole:lastContentLength:toolConfigCount`
   - 考虑加入首个变更消息的索引或内容 hash

---

## 八、测试用例建议

### 8.1 Seed Feature Turn 碰撞测试

```
1. 创建 seedMessages = [{role:'user',turn:0}, {role:'assistant',turn:0}, ..., {role:'user',turn:5}]
2. 启动新 session，挂载 seed feature
3. 发送第一条用户消息
4. 检查：user message 的 turn 是否与最后一条 seed message 碰撞
   期望：turn = 6（不碰撞）
   实际（疑似 bug）：turn = 5（碰撞）
```

### 8.2 Trim with fullPreserveFromTurn=0 测试

```
1. 创建 messages = [{role:'user',turn:0}, {role:'assistant',turn:0,toolCalls:[...]}, {role:'tool',turn:0}, ...]
2. 调用 buildTrimmedSeedMessages(messages, { fullPreserveFromTurn: 0 })
3. 检查：seedMessages 是否包含所有原始消息（未精简）
   期望：所有消息被保留（因为 turn >= 0 = fullPreserveFrom）
   实际：同期望（这是正确行为，但可能不是用户期望的行为）
```

### 8.3 Partial Compact + Reload + Trim 测试

```
1. 创建一个有多轮对话的 session
2. 执行 partial compact（从此处压缩）
3. 保存并重新加载 session
4. 检查：enrichedMessages 是否为空
5. 对此 session 执行 trim
6. 检查：trim 结果是否正确
```

### 8.4 Partial Compact 竞态测试

```
1. 在 triggerPartialCompact 执行过程中（rollbackToCall 之后、ctx.restore 之前）
2. 模拟前端 poll 获取消息
3. 检查：消息是否为回滚后的中间态（缺少 summary）
```

---

## 十、验证结论与修复记录（2026-06-20 续）

### 10.1 已确认并修复的 Bug

#### Bug 1：seed feature turn 碰撞（怀疑 1 → 已修复）

**状态**：已确认 + 已修复

**根因**：`context-handoff-seed/src/index.ts` L178 使用 `injectionTurn - 1` 设置 `_callIndex`。
而 `agent.ts` 在 CallStart hooks 返回后直接使用 `this._callIndex` 给用户消息赋 turn（L346：
`context.addUserMessage(finalInput, this._callIndex)`），不会再递增。

因此 `_callIndex = injectionTurn - 1` 导致首条用户消息获得 `turn = injectionTurn - 1 = maxSeedTurn`，
与最后一条 seed 消息的 turn 值完全碰撞。

**影响**：
- compacted session 的首条用户消息与 seed 最后一条消息共享同一个 turn
- `buildSessionTrimPreview` 将它们归入同一 round，后续 trim 的 round 边界不正确
- 对同一 compacted session 执行二次 trim 时行为异常

**修复**：`injectionTurn - 1` → `injectionTurn`

```diff
- if (typeof agentRef?._callIndex === 'number' && injectionTurn - 1 > agentRef._callIndex) {
-   agentRef._callIndex = injectionTurn - 1;
+ if (typeof agentRef?._callIndex === 'number' && injectionTurn > agentRef._callIndex) {
+   agentRef._callIndex = injectionTurn;
  }
```

修复后：首条用户消息获得 `turn = injectionTurn = maxSeedTurn + 1`，无碰撞。

**文件**：`local-features/context-handoff-seed/src/index.ts` L174-180

---

#### Bug 2：triggerPartialCompact 清空 enrichedMessages（怀疑 2 → 已修复）

**状态**：已确认 + 已修复

**根因**：`scripts/run-prebuilt-agent.js` `triggerPartialCompact()` 在回滚后调用
`ctx.restore({ ..., enrichedMessages: [], sequence: 0 })`。

Context 的 `enrichedMessages` 是带元数据的消息副本，供 Feature 的 `context.query()` /
`context.getByTurn()` 使用。传空数组后，所有 pre-existing 消息的 enriched 副本丢失。

**影响**：
- partial compact 后，依赖 `enrichedMessages` 的 Feature（如 FlowFeature 的 `@CallStart`
  变量收集）行为异常
- session 保存时 `toJSON()` 包含空的 enrichedMessages
- session 重新加载后 enrichedMessages 为空

**修复**：不再使用 `ctx.restore({ enrichedMessages: [] })`。回滚后 context 已有正确的
kept prefix（messages + enrichedMessages），改用 `ctx.addSystemMessage()` 追加摘要。
该方法同时写入两个数组，保持一致性。

对于回滚后消息数与预期不符的边界情况，fallback 到显式 `ctx.restore()` 但传入
post-rollback enrichedMessages（而非空数组）。

**文件**：`scripts/run-prebuilt-agent.js` L1315-1345

---

#### Bug 3：trim fold note 被 applyConversationProcessState 隐藏（症状 2 路径 A → 已修复）

**状态**：已确认 + 已修复

**根因**：`handoff-package.js` 的 `DEFAULT_EXPORT_POLICY.foldedToolNoteRole` 默认值为 `'system'`。
trim 折叠工具调用后生成的 fold note 消息角色为 system。

前端 `applyConversationProcessState()` (app-main.js L6102) 在 `showChatProcess = false` 时
隐藏所有 `.message-row.system`。fold note 被隐藏，用户看到"工具调用内容消失了"。

**修复**：`foldedToolNoteRole` 默认值从 `'system'` 改为 `'assistant'`。

fold note 描述的是 assistant 的工具调用活动，作为 assistant 消息语义正确。
assistant 消息的内容文本不会被 `applyConversationProcessState` 隐藏（只有
`.tool-call-container` 和 `.reasoning-block` 会被隐藏）。

**文件**：`server/context-continuity/handoff-package.js` L19

---

### 10.2 已验证但非 Bug 的项目

#### fullPreserveFromTurn=0 的行为（怀疑 → 症状 1）

**结论**：这是**设计行为**，不是 Bug。

当 `fullPreserveFromTurn = 0` 时，`buildTrimmedSeedMessages` 中所有 `turn >= 0` 的消息
都进入 preserve zone，全部原样保留。这在以下情况发生：
- 用户在 trim 对话框中保留了第一轮（`rounds[0].turnStart = 0`）
- 任何 regular session 的首条用户消息 turn 始终为 0

但这是正确行为：保留第一轮 = 不精简。用户需要取消勾选第一轮才能真正精简。

**注意**：当 seed feature 的 turn 碰撞（Bug 1）导致 compacted session 的 turn 值异常时，
`buildSessionTrimPreview` 的 round 分组可能不正确，间接影响 trim 效果。修复 Bug 1 后此问题应缓解。

#### partial-compact 竞态窗口（症状 2 路径 B）

**结论**：存在理论窗口，但实际影响有限。

`triggerPartialCompact` 中 `rollbackToCallAndSave()` 和后续的摘要注入之间存在时间窗口。
如果前端 poll 恰好在此窗口内执行，可能获取到回滚后但未注入摘要的中间态。

但由于 `compactSummaryInFlight` 标志阻止了并发的 compact 操作，且前端 `_partialCompactInFlight`
状态管理已存在，实际触发概率低。暂不修复，后续可考虑在 runtime 侧增加消息版本号防中间态渲染。

---

### 10.3 已知但未修复的问题

#### `context.add()` 不同步 enrichedMessages

**文件**：`AgentDev/src/core/context.ts` L55-58

`Context.add()` 只写入 `messages`，不写入 `enrichedMessages`。
seed feature 使用 `ctx.context.add(...)` 注入 seed 消息，导致 seed 消息仅存在于 `messages`。

**影响**：Feature 通过 `context.query()` / `getByTurn()` 查询时看不到 seed 消息。

**建议**：后续在 AgentDev 框架侧统一修复（让 `add()` 也同步 enrichedMessages），
或让 seed feature 改用 `addSystemMessage` 等双写方法。

#### `findFirstChangedMessageIndex` 的 JSON.stringify 稳定性

**结论**：暂未发现问题，但使用 `JSON.stringify` 做深比较存在 `undefined` vs 不存在的潜在差异。
低优先级，后续可改用结构化比较。

#### `render()` dedup 签名粗粒度

**结论**：签名仅基于 `length:lastRole:lastContentLength:toolConfigCount`，确实粗粒度。
但追加消息后总数变化导致签名必然不同，实际触发概率低。低优先级。

---

### 10.4 新增/修改的测试

| 测试文件 | 说明 |
|----------|------|
| `test/trim-compact-fixes.test.js`（新增） | 验证 foldedToolNoteRole 默认值、fullPreserveFromTurn=0 行为、fold zone 折叠行为、seed feature turn collision 逻辑 |
| `test/partial-compact-rollback.test.js`（修改） | 第二个测试改用 `addSystemMessage` 替代 `ctx.restore({enrichedMessages:[]})`，新增 enrichedMessages 保留断言 |

---

### 10.5 修复清单

| # | 修复 | 文件 | 类型 |
|---|------|------|------|
| 1 | seed feature `_callIndex` 从 `injectionTurn-1` 改为 `injectionTurn` | `local-features/context-handoff-seed/src/index.ts` | Bug fix |
| 2 | partial compact 改用 `addSystemMessage` 保留 enrichedMessages | `scripts/run-prebuilt-agent.js` | Bug fix |
| 3 | `foldedToolNoteRole` 默认值从 `'system'` 改为 `'assistant'` | `server/context-continuity/handoff-package.js` | Bug fix |

**需要重建/重启**：
- Fix 1：`npm run build:local-features`（已执行）→ 重启 agent
- Fix 2：重启 agent（子进程动态 import）
- Fix 3：无需构建（server.js 直接 serve）→ 重启 Claw 服务

---

## 九、附录：`300542fd` 完整变更清单

```
prebuilt-agents/official/programming-helper/metadata.json      |   2 +-
public/index.html                                              |   2 +
public/src/app-core.js                                         |   1 +
public/src/app-main.js                                         | 392 ++++++++-
public/src/app-ui.js                                           | 793 +------------------
public/src/modules/session-ui.js                               | 781 ++++++++++++++++++
public/styles/components.css                                   |  63 ++
scripts/run-prebuilt-agent.js                                  | 330 +++++++-
server.js                                                      | 287 ++++++-
server/context-continuity/claude-compact-prompts.js            |  44 +-
server/conversation-renderer.js                                | 880 +++++++++++++++++++++
server/model-preset-resolver.js                                |   4 +
test/_render-test.mjs                                          |  66 ++
test/partial-compact-rollback.test.js                          | 103 +++
test/speech-model.test.js                                      |  12 +-
15 files changed, 2944 insertions(+), 816 deletions(-)
```
