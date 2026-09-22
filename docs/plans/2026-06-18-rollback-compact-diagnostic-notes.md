# 会话局部压缩 (partial compact) 与回退到此轮 (rollback_to_call) 功能诊断记录

> 创建日期：2026-06-18  
> 涉及仓库：AgentDevClaw（产品壳层） + AgentDev（框架）  
> 涉及文件跨越前端 JS、后端 JS、框架 TS 三层  
> 状态：**诊断未完成，根因尚未最终确认**。本文档完整记录截至当前的全部调查过程。

---

## 一、任务背景

### 1.1 功能概述

在 AgentDevClaw 的预制 agent runtime（`scripts/run-prebuilt-agent.js`）中，存在两个基于"会话检查点回退"机制的用户功能：

1. **回退到此轮 (rollback_to_call)**：用户在聊天历史中点击某条用户消息上的"编辑此轮"按钮，选择"回退到此轮"后，runtime 调用框架的 `Agent.rollbackToCall(callIndex)`，将整个 runtime 状态（context / featureStates / callIndex / usageStats）恢复到该轮调用之前，并把该轮的原始输入文本注入到输入框供用户重新编辑。

2. **从此处压缩 (compact_from_call)**：用户在同样的入口选择"从此处压缩"后，runtime 先调用 LLM 对该轮及之后的所有消息生成摘要，然后执行与回退相同的 `rollbackToCall`，最后在回退后的 context 上追加一条 system 消息（摘要内容）。效果是"保留早期消息 + 用摘要替换近期消息"。

两个功能共享同一个底层回退通道（`rollbackToCallAndSave` 辅助函数），区别仅在于压缩功能在回退后额外注入摘要。

### 1.2 代码变更状态

这些功能属于一组**未提交的本地变更**（`git diff` 可见），涉及以下文件：

| 文件 | 变更类型 | 关键改动 |
|------|---------|---------|
| `scripts/run-prebuilt-agent.js` | 新增 + 重构 | 新增 `compact_from_call` action、`triggerPartialCompact`、`generatePartialInProcessSummary`、`rollbackToCallAndSave` 辅助函数；重构 `handleInputResponse` 中 rollback 路径使用新辅助函数；新增 `callFinished` 的 `session_meta_sync` |
| `public/src/app-main.js` | 新增 + 重构 | 新增 `showRollbackActionDialog` 双选对话框；新增 partial compact 前端状态管理（`_partialCompactInFlight` 等）；重构消息变化检测（`findFirstChangedMessageIndex`）；新增 `compact_from_call` action 过滤；重构 poll 中 input-request 与消息变化的处理逻辑 |
| `public/src/app-ui.js` | 大量删除 | （与本次诊断无直接关系） |
| `server.js` | 新增 | `session_meta_sync` 路由、`generate_session_title` 路由等 |
| `public/styles/components.css` | 新增 | partial compact 状态卡片样式、rollback dialog 样式 |

### 1.3 用户报告的问题

用户在测试这组未提交变更后报告：

> **回退到此轮**：点击后消息完全没有变化（好像什么都没发生），那一轮曾经输入的内容也没有注入到输入框中。  
> **从此处压缩**：压缩完成后无事发生——既没有正确截断消息，也没有注入摘要。

这两个症状**同时出现**，且用户确认已重启服务。

---

## 二、架构全景：从用户点击到消息更新

### 2.1 完整调用链路

以下是用户点击"编辑此轮" → 选择"回退到此轮" → 消息更新的**完整链路**，每一步都标注了所在文件和行号：

```
[前端] public/src/app-main.js

1. 用户点击消息上的"编辑此轮"按钮
   → onclick="requestRollbackEdit(${index})"  (L6164 / L6587)
   
2. window.requestRollbackEdit(messageIndex)  (L6048-6067)
   → getRollbackInputRequest()  (L5864-5872) — 从 currentInputRequests 中找到支持 rollback/compact 的 pending request
   → 从 currentMessages[messageIndex] 取出 msg
   → 计算 callIndex = msg.turn (或 fallback)  (L6060-6064)
   → showRollbackActionDialog(request, callIndex, msg)  (L6066)

3. showRollbackActionDialog(request, callIndex, msg)  (L6069-6155)
   → 设置 _rollbackDialogOpen = true
   → 渲染双选对话框（"回退到此轮" / "从此处压缩"）
   → 用户点击"回退到此轮"按钮：
     a. close() — 关闭对话框，_rollbackDialogOpen = false，重新渲染 input requests
     b. submitInputAction(request.requestId, 'rollback_to_call', { callIndex, draftInput: msg.content })

4. submitInputAction(requestId, actionId, payload)  (L5898-5930)
   → POST /api/agents/${currentRuntimeAgentId}/input
     body: { requestId, input: '', response: { kind: 'action', actionId, payload } }
   → res.ok 后：
     a. 清空 currentInputRequests / lastInputRequests
     b. renderInputRequests([])
     c. poll()  — 立即触发一次轮询

━━━━━━━━━━ HTTP ━━━━━━━━━━

[ViewerWorker] AgentDev/src/core/viewer-worker.ts

5. handlePostInput(req, res, agentId)  (L988-1050)
   → 从 body 解析 { requestId, input, response }
   → 检查 session.pendingInputRequests.has(requestId)  (L997)
     → 如果不存在 → 404 "Request not found or expired"  (L998-1001)
   → pendingRequests.delete(requestId)  (L1009)
   → 通过 UDS 发送 { type: 'input-response', agentId, requestId, response } 到 DebugHub  (L1017-1023)
   → res 200

━━━━━━━━━━ UDS ━━━━━━━━━━

[Agent 子进程] AgentDev/src/core/debug-hub.ts

6. handleWorkerMessage(msg)  (L758-803)
   → case 'input-response':  (L765)
   → 查找 pendingInputRequests.get(msg.requestId)  (L766)
   → resolver(msg.response)  — 解除 requestUserInputEvent 的 await  (L768)

[Agent 子进程] AgentDev/src/features/user-input/index.ts

7. requestUserInputEvent 返回 response  (L108-140)
   → 返回到 getUserInputEvent  (L151-161)
   → 返回到 main loop

[Agent 子进程] scripts/run-prebuilt-agent.js

8. main loop while(true)  (L1577-1614)
   → handled = await handleInputResponse(userInput, response)  (L1589)

9. handleInputResponse(userInput, response)  (L1288-1346)
   → if (response.kind === 'action' && response.actionId === 'rollback_to_call')  (L1317)
   → callIndex = response.payload?.callIndex  (L1318)
   → result = await rollbackToCallAndSave(callIndex, { draftInput })  (L1321-1325)

10. rollbackToCallAndSave(callIndex, { draftInput })  (L1165-1182)
    → agent.rollbackToCall(callIndex)  (L1171)
    
    ┌─────────────────────────────────────────────────┐
    │ [框架] AgentDev/src/core/agent.ts               │
    │ rollbackToCall(callIndex)  (L629-642)           │
    │ → _callCheckpoints.find(entry => entry.callIndex │
    │   === callIndex)  (L631)                        │
    │ → 如果找不到 → throw Error("Rollback checkpoint │
    │   for call ${callIndex} not found")  (L633)     │
    │ → restoreRuntimeSnapshot(checkpoint.runtime)     │
    │   (L636) — 替换 persistentContext / callIndex /  │
    │   featureStates / usageStats                     │
    │ → _callCheckpoints.filter(< callIndex)  (L637)   │
    │ → pushToDebug(getContext().getAll())  (L638)     │
    │   — fire-and-forget，通过 UDS 发到 ViewerWorker  │
    │ → pushInspectorSnapshot()  (L639)                │
    │ → return { draftInput: checkpoint.draftInput }   │
    └─────────────────────────────────────────────────┘
    
    → setNextDraftInput(result.draftInput)  (L1326-1328)
    → saveSession(sessionId, sessionStore)  (L1177)
    → return { ok: true, draftInput }  (L1181)

11. handleInputResponse 返回 { kind: 'continue' }  (L1329)
12. main loop: continue → 回到 getUserInputEvent  (L1596)
    → 推送新的 input-request（含 NEXT_TURN_ACTIONS）到 ViewerWorker

━━━━━━━━━━ 前端 poll ━━━━━━━━━━

[前端] public/src/app-main.js

13. poll()  (L4491-...)
    → fetch /api/agents/${pollRuntimeId}/messages  (L4547)
    → fetch /api/agents/${pollRuntimeId}/input-requests  (L4548)
    → 消息变化检测  (L4601-4635)
      → findFirstChangedMessageIndex(messages, currentMessages)
      → 如果长度减少 → renderCurrentMainView() 全量重建
    → input-request 变化 → renderInputRequests
```

### 2.2 compact_from_call 的链路差异

compact 的链路在步骤 9 之后不同：

```
9'. handleInputResponse → response.actionId === 'compact_from_call'  (L1332-1342)
    → triggerPartialCompact(callIndex, feedback)  (L1340)

10'. triggerPartialCompact(callIndex, feedback)  (L1189-1289)
     → [a] 从 context.getAll() 获取 rawMessages  (L1201-1202)
     → [b] 查找 pivotMsgIndex（按 user turn 匹配 callIndex）(L1208-1232)
     → [c] messagesToSummarize = rawMessages.slice(pivotMsgIndex)  (L1238)
     → [d] generatePartialInProcessSummary(messagesToSummarize, feedback)
           — 调用 LLM 生成摘要（耗时数秒）(L1246)
     → [e] rollbackToCallAndSave(callIndex, { draftInput: '' })  (L1258)
     → [f] ctx.restore({ messages: keptMessages + summary, ... })  (L1276)
           — 当前未提交代码的做法：手动拼接消息列表全量替换 context
     → [g] saveSession + pushToDebug + pushInspectorSnapshot  (L1279-1281)
```

**关键差异**：compact 在回退后额外执行了 `ctx.restore()` 全量替换 context，而 rollback 只依赖 `rollbackToCall` 内部的 `restoreRuntimeSnapshot`。

---

## 三、框架层关键代码位置索引

### 3.1 Agent 类 (`AgentDev/src/core/agent.ts`)

| 功能 | 方法 | 行号 | 说明 |
|------|------|------|------|
| 回退入口 | `rollbackToCall(callIndex)` | L629-642 | 公开方法；查找 checkpoint → 恢复 → 推送 |
| 检查点提交 | `commitCallCheckpoint(checkpoint)` | L1437-1441 | 过滤旧条目 + concat 新条目 |
| 快照捕获 | `captureRuntimeSnapshot(context, callIndexOverride)` | L1409-1418 | 捕获 context.toJSON() + featureStates + callIndex + usageStats |
| 快照恢复 | `restoreRuntimeSnapshot(snapshot)` | L1420-1435 | `persistentContext = Context.fromJSON(snapshot.context)` + 恢复 featureStates / callIndex / usageStats |
| 检查点字段 | `_callCheckpoints` | L107 | `protected _callCheckpoints: CallRollbackCheckpoint[] = []` |
| 会话保存 | `buildSessionSnapshot()` | L565-584 | 包含 `rollbackHistory: _callCheckpoints.map(...)` |
| 会话恢复 | `restoreSessionSnapshot(snapshot)` | L590-606 | `_callCheckpoints = normalized.rollbackHistory.map(...)` |
| 旧格式兼容 | `normalizeSessionSnapshot(snapshot)` | L1443-1465 | 如果无 `runtime` 字段，`rollbackHistory` 设为 `[]` |
| onCall 主体 | `onCall(input)` | L244-418 | 包含 checkpoint 捕获 (L326) 和提交 (L357/L407) |
| 推送消息 | `pushToDebug(messages)` | L1396-1401 | 调用 `debugHub.pushMessages(agentId, messages)` |
| 推送 inspector | `pushInspectorSnapshot()` | L1473-1476 | 调用 `debugHub.updateAgentInspector` |
| 获取 context | `getContext()` | L799-801 | 返回 `this.persistentContext ?? new Context()` |
| 加载会话 | `loadSession(sessionId, store)` | L758-761 | `store.load(sessionId)` → `restoreSessionSnapshot` |
| 重置 | `reset()` | L766-773 | 清空 persistentContext / _callCheckpoints / _callIndex |

### 3.2 检查点生命周期详解

```
onCall(input) 开始
  │
  ├─ _callIndex = nextCallIndex (++递增)                    L274
  │
  ├─ preCallRuntime = captureRuntimeSnapshot(               L326
  │     context, _callIndex - 1)
  │   ★ 在 CallStart hooks 之前捕获
  │   ★ 此时 context 中还没有本轮的 user message
  │
  ├─ CallStart hooks 执行                                    L334
  │   (Feature 可能注入消息到 context)
  │
  ├─ context.addUserMessage(finalInput, _callIndex)         L346
  │   ★ user message 的 turn = _callIndex
  │
  ├─ ReAct loop 执行                                        L353
  │   (多步推理 + 工具调用)
  │
  ├─ commitCallCheckpoint({                                 L357
  │     callIndex: _callIndex,
  │     draftInput: finalInput,
  │     runtime: preCallRuntime
  │   })
  │   ★ checkpoint.callIndex = _callIndex
  │   ★ checkpoint.runtime = 快照（CallStart hooks 之前的状态）
  │
  └─ onCall 返回
```

**关键不变量**：`user message turn === checkpoint callIndex === _callIndex`，三者同源。

### 3.3 Context 类 (`AgentDev/src/core/context.ts`)

| 功能 | 方法 | 行号 | 说明 |
|------|------|------|------|
| 获取所有消息 | `getAll()` | L73-75 | 返回 `cloneMessages(this.messages)` |
| 添加用户消息 | `addUserMessage(content, turn)` | L190-197 | 写入 messages + enrichedMessages |
| 添加系统消息 | `addSystemMessage(content, turn, source?)` | L262-269 | 写入 messages + enrichedMessages |
| 快照序列化 | `toJSON()` | L123-134 | 返回 `{ version, messages, enrichedMessages, sequence }` |
| 快照恢复 | `restore(snapshot)` | L148-160 | 替换 messages + enrichedMessages + sequence + rebuildIndexes |
| 从 JSON 创建 | `Context.fromJSON(snapshot)` | L139-143 | `new Context()` + `restore(snapshot)` |

### 3.4 DebugHub (`AgentDev/src/core/debug-hub.ts`)

| 功能 | 方法 | 行号 | 说明 |
|------|------|------|------|
| 推送消息 | `pushMessages(agentId, messages)` | L464-477 | viewer-worker 模式：`sendToWorker({type:'push-messages'})` |
| 请求用户输入 | `requestUserInputEvent(agentId, request, timeout)` | L635-690 | 创建 requestId，存 resolver，发 UDS |
| 处理 Worker 回消息 | `handleWorkerMessage(msg)` | L758-803 | `input-response` → resolver(msg.response) |
| UDS 发送 | `sendToWorker(msg)` | L970-975 | 检查 udsClient，调 sendViaUDS |
| 传输模式 | `transportMode` | L47/L100 | `'viewer-worker'` 或 `'claw'`（由 `AGENTDEV_DEBUG_TRANSPORT` 决定） |

### 3.5 ViewerWorker (`AgentDev/src/core/viewer-worker.ts`)

| 功能 | 方法 | 行号 | 说明 |
|------|------|------|------|
| 处理输入提交 | `handlePostInput(req, res, agentId)` | L988-1050 | 检查 pendingInputRequests → 删除 → UDS 回传 |
| 获取输入请求列表 | `handleGetInputRequests(req, res, agentId)` | L961-983 | 返回 pendingInputRequests |
| 处理推送消息 | `handlePushMessages(msg)` | L1403-1419 | 消息变化检测 → 更新 session.messages |
| 消息变化检测 | `hasMessagesChanged(session, newMessages)` | L1511-1527 | 长度不同 → true；否则比较最后一条签名 |

### 3.6 UserInputFeature (`AgentDev/src/features/user-input/index.ts`)

| 功能 | 方法 | 行号 | 说明 |
|------|------|------|------|
| 设置下轮草稿 | `setNextDraftInput(input)` | L93-95 | 设置 `this.nextDraftInput` |
| 获取用户输入事件 | `getUserInputEvent(prompt, actions, timeout)` | L151-161 | 调用 `requestUserInputEvent`，用 `nextDraftInput` 作 `initialValue` |
| 请求用户输入事件 | `requestUserInputEvent(request, timeout)` | L108-140 | 调用 `debugHub.requestUserInputEvent`，完成后清空 `nextDraftInput` |

### 3.7 ClawDebugClient (`AgentDev/src/core/claw-debug-client.ts`)

仅在 `transportMode === 'claw'` 时使用。预制 agent runtime 使用 `viewer-worker` 模式，所以此类的 `requestUserInput` 方法（L125-197，通过 HTTP polling 等待响应）**不适用于当前场景**。当前场景中，输入响应通过 UDS 传递。

---

## 四、Claw 产品层关键代码位置索引

### 4.1 `scripts/run-prebuilt-agent.js`

| 功能 | 函数/变量 | 行号 | 说明 |
|------|----------|------|------|
| Action 定义 | `NEXT_TURN_ACTIONS` | L233-243 | 包含 `rollback_to_call` 和 `compact_from_call` |
| 全局 agent 引用 | `let agent` | L246 | `null` 初始，在 `main()` 中赋值 |
| 是否有检查点 | `getNextTurnActions()` | L819-822 | `_callCheckpoints.length > 0` 时返回 actions |
| LLM 参数临时调整 | `tuneSummaryLLM(llm)` | L877-903 | 压缩时临时降低 maxTokens / 清除 thinking |
| 是否保留工具 | `shouldPreserveSummaryTools(agent)` | L905-912 | Claude 模型保留所有工具 |
| 部分摘要生成 | `generatePartialInProcessSummary(messages, feedback)` | L1087-1163 | 调用 LLM 对消息子集生成摘要 |
| **回退+保存辅助** | **`rollbackToCallAndSave(callIndex, {draftInput})`** | **L1165-1182** | 调用 `agent.rollbackToCall` + `saveSession`，返回 `{ok, draftInput}` |
| **部分压缩主函数** | **`triggerPartialCompact(callIndex, feedback)`** | **L1189-1289** | 生成摘要 → 回退 → 注入摘要 → 保存推送 |
| **输入动作处理** | **`handleInputResponse(userInput, response)`** | **L1288-1346** | 处理 text / rollback_to_call / compact_from_call |
| 主循环 | `main()` 的 while(true) | L1577-1614 | `getUserInputEvent` → `handleInputResponse` → `onCall` |
| 会话恢复 | `agent.loadSession(sessionId, sessionStore)` | L1425 | 启动时恢复 |
| 会话恢复后推送 | pushToDebug / syncRegisteredTools / pushInspector | L1441-1451 | 确保重启后历史立即可见 |
| callFinished 处理 | `callArbiter.on('callFinished')` | L1478-1510 | saveSession + session_meta_sync |

### 4.2 `public/src/app-main.js`

| 功能 | 函数 | 行号 | 说明 |
|------|------|------|------|
| **请求回退入口** | **`window.requestRollbackEdit(messageIndex)`** | **L6048-6067** | 获取 request + msg → 计算 callIndex → 显示对话框 |
| **双选对话框** | **`showRollbackActionDialog(request, callIndex, msg)`** | **L6069-6155** | "回退到此轮" / "从此处压缩" |
| 查找回退请求 | `getRollbackInputRequest()` | L5864-5872 | 从 currentInputRequests 查找支持 rollback/compact 的请求 |
| 判断消息可回退 | `canRollbackMessage(msg)` | L5874-5876 | `getRollbackInputRequest() && msg.role === 'user'` |
| 检查请求支持 action | `requestSupportsAction(request, actionId)` | L5859-5862 | `request.actions.some(a => a.id === actionId)` |
| **提交动作** | **`submitInputAction(requestId, actionId, payload)`** | **L5898-5930** | POST input → 清空 requests → poll |
| **轮询主函数** | **`poll()`** | **L4491-...** | 消息 + input-request 轮询 |
| 消息变化检测 | `findFirstChangedMessageIndex(next, prev)` | L4404-4419 | 逐条 JSON.stringify 比较 |
| 消息变化处理 | poll 内 messages.length 比较 | L4601-4635 | 长度增加+前缀不变→追加；否则→全量重建 |
| partial compact 状态 | `_partialCompactInFlight` 等 | L5932-5982 | 前端 compact 进行中状态管理 |
| input-request 渲染抑制 | `if (_rollbackDialogOpen) return` | L4932 | 对话框打开时不重渲染 |
| input-request 中 action 过滤 | `filter(a => a.id !== 'rollback_to_call' && ...)` | L5075 | 这些 action 不在 input 卡片上显示按钮 |

---

## 五、已排除的可能性

### 5.1 已排除：`agent.rollbackToCall` 方法不存在

**检查方式**：在编译产物 `dist/chunk-JZQDO5XF.js` L15852 搜索到 `async rollbackToCall(callIndex)`。  
**结论**：方法存在且为公开方法（TypeScript `public` 编译后为普通原型方法）。

### 5.2 已排除：`_callCheckpoints` 不可访问

**检查方式**：在编译产物中搜索 `_callCheckpoints`，确认是普通类字段（`_callCheckpoints = []`），不是 `#privateField`。  
**结论**：`agent._callCheckpoints` 可直接访问。

### 5.3 已排除：`addSystemMessage` 不可访问（第一轮修复尝试）

**检查方式**：`Context.addSystemMessage` 在 `context.ts` L262 定义为公开方法。编译后存在。  
**结论**：方法可用。但第一轮修复使用此方法的方案已被用户否决。

### 5.4 已排除：`setNextDraftInput` 不存在

**检查方式**：在 `user-input/index.ts` L93 定义。  
**结论**：方法存在。但用户报告草稿未注入，说明 `setNextDraftInput` 可能从未被调用（因为 `rollbackToCall` 抛出，错误被外层 catch 捕获）。

### 5.5 已排除：input request 在对话框期间过期

**检查方式**：`UserInputFeature` 默认超时为 `Infinity`（L90）。Agent 在 `requestUserInputEvent` 中轮询直到收到响应或超时。  
**结论**：request 不会过期。requestId 在用户点击按钮时仍然有效。

### 5.6 已排除：前端 `showRollbackActionDialog` 有 JS 语法错误

**检查方式**：逐行审查 L6069-6155，所有括号/引号/模板字符串均正确。  
**结论**：无语法错误。

### 5.7 已排除：`runWithSuppressedChatViewportObservers` 未定义

**检查方式**：在 `app-ui.js` L5971 找到定义。  
**结论**：函数存在。

---

## 六、核心怀疑方向（按可能性排序）

### 6.1 最高怀疑：`rollbackToCall(callIndex)` 抛出 "checkpoint not found"

**推理链**：

1. 用户报告回退后"消息完全没有变化" + "草稿未注入"。
2. 如果 `rollbackToCall` 正常执行，它会调用 `pushToDebug`（推送截断后的消息到 ViewerWorker）+ 返回 `draftInput`。
3. 如果 `rollbackToCall` **抛出**：
   - `pushToDebug` 不会执行 → ViewerWorker 中的消息不变 → 前端 poll 检测不到变化 → **"消息完全没有变化"** ✓
   - 错误传播到 main loop 的 `try { handled = await handleInputResponse(...) } catch` → `setNextDraftInput` 从未执行 → **"草稿未注入"** ✓
4. compact 的症状也吻合：`triggerPartialCompact` 内部 `rollbackToCallAndSave` 抛出 → 被 `triggerPartialCompact` 的 try/catch 捕获 → 摘要已生成但未注入 → `compactSummaryInFlight` 在 finally 中清除 → 前端检测到新 input-request → "压缩中"消失 → **"压缩完之后无事发生"** ✓

**未解之谜**：为什么 checkpoint 找不到？

可能的原因：
- **(A) 会话恢复后 `_callCheckpoints` 为空或不完整**：如果 `loadSession` 失败（catch 分支 "创建新会话"），agent 从空白状态启动。用户进行了至少一轮对话后，会有 1 个 checkpoint。但如果用户回退到的是更早的轮次（来自恢复的消息历史），对应的 checkpoint 可能不存在。
- **(B) `callIndex` 不匹配**：前端发送的 `callIndex = msg.turn`，后端查找 `checkpoint.callIndex === callIndex`。如果 `msg.turn` 与 checkpoint 的 `callIndex` 不一致（例如 turn 字段在序列化/反序列化过程中发生了变化），则找不到。
- **(C) 推测：`_callCheckpoints` 在 `callFinished` 的异步 saveSession 完成之前被修改**：`callFinished` 中的 `saveSession` 是 fire-and-forget（`.then()` 不阻塞），如果在这期间有其他操作修改了 `_callCheckpoints`，保存的可能不是预期状态。但这不太可能导致完全找不到 checkpoint。

### 6.2 次高怀疑：pushToDebug 的 fire-and-forget 竞态

**推理**：

`rollbackToCall` 内部调用 `this.pushToDebug(this.getContext().getAll())`（L638）。这是通过 UDS 发送到 ViewerWorker 的。如果 UDS 连接出现问题，`sendToWorker` 静默返回（L971-972: `if (!this.udsClient) return`），消息不会被推送。

但如果 UDS 完全断开，agent 注册、工具注册、消息推送等全部功能都会失效，用户看不到任何消息。这与会话历史可见矛盾。

**可能性较低**，但无法完全排除 UDS 连接不稳定导致部分消息丢失的情况。

### 6.3 较低怀疑：前端 poll 未检测到消息变化

**推理**：

ViewerWorker 收到了 pushToDebug 的消息并更新了 `session.messages`，但前端 poll 的变化检测逻辑有缺陷。

检查 `findFirstChangedMessageIndex`（L4404-4419）和 poll 的消息处理（L4601-4635）：当消息数量减少时，进入 `else` 分支，执行 `currentMessages = messages; renderCurrentMainView()`。这应该正确处理回退后的消息截断。

**可能性低**，因为逻辑看起来正确。但实际测试中可能存在边界情况。

### 6.4 低怀疑：compact 的 `ctx.restore()` 导致消息不一致

这是前一会话诊断的原始方向。原始 `triggerPartialCompact` 在回退后使用 `ctx.restore()` 全量替换 context，引入了三个问题：

1. `keptMessages` 从回退前的 `rawMessages` 切取，与 checkpoint 捕获时的消息集可能不一致（CallStart hooks 注入的消息在 `rawMessages` 中但不在 checkpoint 中）。
2. `restore({ enrichedMessages: [] })` 清空了所有 enrichment 元数据和索引。
3. 双重 saveSession + pushToDebug 存在竞态。

但这个方向**已被用户的反馈推翻**——用户报告即使回退（不涉及 `ctx.restore()`）也不工作，说明问题出在更底层。

---

## 七、已尝试的修复与结果

### 7.1 第一轮修复（已撤销）

**方案**：将 `triggerPartialCompact` 中的 `ctx.restore()` 替换为 `ctx.addSystemMessage()`。

**改动**：
- 移除 `keptMessages = rawMessages.slice(0, pivotMsgIndex)` 和 `finalMessages` 拼接
- 移除 `ctx.restore({ version: 2, messages: finalMessages, enrichedMessages: [], sequence: 0 })`
- 替换为 `ctx.addSystemMessage(summaryContent, reminderTurn)`
- 移除 `ctx.restore` 能力检查，改为 `ctx.addSystemMessage` 能力检查

**结果**：用户反馈"修复的完全不对，甚至回退到此轮功能都不正常了"。

**教训**：
1. 诊断方向错误——原始问题不仅仅是 `ctx.restore()` 的问题，回退本身就有问题。
2. 不应在未理解完整问题的情况下执行修复。
3. 当前代码已**撤销**回到原始未提交状态。

---

## 八、待执行的下一步

### 8.1 添加诊断日志

在 `rollbackToCallAndSave` 函数中添加详细日志，捕获以下信息：

```javascript
// 在 rollbackToCallAndSave 中（L1165-1182）：
async function rollbackToCallAndSave(callIndex, { draftInput } = {}) {
  if (typeof agent?.rollbackToCall !== 'function') {
    console.warn('[ProtoClaw Runtime] 当前 Agent 不支持 rollbackToCall');
    return { ok: false, draftInput: '' };
  }

  // === 诊断日志 ===
  const checkpoints = Array.isArray(agent?._callCheckpoints) ? agent._callCheckpoints : [];
  const checkpointIndices = checkpoints.map(cp => cp.callIndex);
  const context = typeof agent?.getContext === 'function' ? agent.getContext() : null;
  const messages = context?.getAll?.() || [];
  const userTurns = messages.filter(m => m.role === 'user').map(m => m.turn);
  console.log(`[ProtoClaw Runtime] rollbackToCallAndSave 诊断:
    callIndex=${callIndex}
    _callIndex=${agent?._callIndex}
    checkpoints.callIndex=[${checkpointIndices.join(',')}]
    user message turns=[${userTurns.join(',')}]
    total messages=${messages.length}`);

  try {
    const result = await agent.rollbackToCall(callIndex);
    console.log(`[ProtoClaw Runtime] rollbackToCall 成功: draftInput=${result?.draftInput?.slice(0, 50)}`);
    // ... 后续不变
  } catch (error) {
    console.error(`[ProtoClaw Runtime] rollbackToCall 失败: ${error.message}`);
    throw error;
  }
}
```

### 8.2 在 `handleInputResponse` 中添加错误日志

当前 main loop 的 catch 会吞掉错误（只 `console.error`），需要确认错误内容：

```javascript
// 在 main loop 中（L1587-1593）：
try {
  handled = await handleInputResponse(userInput, response);
} catch (error) {
  console.error('[ProtoClaw Runtime] 处理输入动作失败，已忽略本次请求:', error);
  // === 添加：打印完整错误堆栈 ===
  console.error(error.stack);
  continue;
}
```

### 8.3 测试步骤

1. 添加上述诊断日志
2. 重启 agent
3. 进行至少 2 轮对话
4. 点击第 1 轮用户消息的"编辑此轮" → 选择"回退到此轮"
5. 查看 agent 控制台输出中的诊断日志
6. 根据日志中的 `checkpoints.callIndex` 和 `callIndex` 对比，确认是否存在不匹配

### 8.4 可能需要的修复方向

根据诊断结果：

- **如果是 checkpoint 不匹配**：检查会话恢复逻辑，确认 `rollbackHistory` 正确保存和恢复。可能需要在 `getNextTurnActions()` 中返回实际的 checkpoint callIndex 列表，前端根据可用 checkpoint 来决定哪些消息可以回退。
- **如果是 `callIndex` 值错误**：检查 `msg.turn` 的实际值，可能需要在发送前做转换。
- **如果是其他原因**：根据日志进一步分析。

---

## 九、文件清单

以下是本次诊断涉及的全部文件，按重要程度排序：

### 核心文件（必须阅读）

1. **`D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js`** — Claw 产品层 runtime 入口
   - L233-243: `NEXT_TURN_ACTIONS` 定义
   - L246: `let agent = null`
   - L819-822: `getNextTurnActions()`
   - L1087-1163: `generatePartialInProcessSummary()`
   - L1165-1182: `rollbackToCallAndSave()` ← **核心怀疑点**
   - L1189-1289: `triggerPartialCompact()`
   - L1288-1346: `handleInputResponse()`
   - L1317-1330: rollback_to_call 处理分支
   - L1332-1342: compact_from_call 处理分支
   - L1423-1437: 会话恢复 (`loadSession`)
   - L1478-1510: `callFinished` handler
   - L1577-1614: main loop

2. **`D:/code/AgentDev/src/core/agent.ts`** — 框架 Agent 类
   - L107: `_callCheckpoints` 字段
   - L244-418: `onCall()` — checkpoint 捕获 (L326) 和提交 (L357/L407)
   - L565-584: `buildSessionSnapshot()` — 包含 `rollbackHistory`
   - L590-606: `restoreSessionSnapshot()` — 恢复 `_callCheckpoints`
   - L629-642: `rollbackToCall()` ← **核心框架方法**
   - L758-761: `loadSession()`
   - L799-801: `getContext()`
   - L1409-1418: `captureRuntimeSnapshot()`
   - L1420-1435: `restoreRuntimeSnapshot()`
   - L1437-1441: `commitCallCheckpoint()`
   - L1443-1465: `normalizeSessionSnapshot()` — 旧格式兼容

3. **`D:/code/AgentDevClaw/public/src/app-main.js`** — 前端主逻辑
   - L4404-4419: `findFirstChangedMessageIndex()`
   - L4491-...: `poll()` 主函数
   - L4557-4655: poll 中的消息变化检测和处理
   - L4928-4932: input-request 渲染抑制（`_rollbackDialogOpen`）
   - L5072-5075: input request 中 action 过滤
   - L5859-5872: `requestSupportsAction()` / `getRollbackInputRequest()`
   - L5874-5876: `canRollbackMessage()`
   - L5898-5930: `submitInputAction()`
   - L5932-5982: partial compact 前端状态
   - L6048-6067: `requestRollbackEdit()`
   - L6069-6155: `showRollbackActionDialog()`

### 辅助文件（参考）

4. **`D:/code/AgentDev/src/core/context.ts`** — Context 类
5. **`D:/code/AgentDev/src/core/debug-hub.ts`** — DebugHub（UDS 通信）
6. **`D:/code/AgentDev/src/core/viewer-worker.ts`** — ViewerWorker（HTTP + UDS 服务端）
7. **`D:/code/AgentDev/src/features/user-input/index.ts`** — UserInputFeature
8. **`D:/code/AgentDev/src/core/claw-debug-client.ts`** — Claw 传输模式客户端（当前场景不使用）
9. **`D:/code/AgentDev/src/core/debug-transport.ts`** — 传输模式选择
10. **`D:/code/AgentDev/src/core/agent/react-loop.ts`** — ReAct 循环（确认不修改 `_callIndex`）
11. **`D:/code/AgentDev/dist/chunk-JZQDO5XF.js`** — 编译产物（确认方法名未被 minify）

---

## 十、关键数据结构

### 10.1 CallRollbackCheckpoint

```typescript
interface CallRollbackCheckpoint {
  callIndex: number;       // 对应 _callIndex（onCall 时递增后的值）
  draftInput: string;      // 该轮的用户输入文本（用于回退后注入输入框）
  runtime: AgentRuntimeSnapshot;  // 快照（在 CallStart hooks 之前捕获）
}
```

### 10.2 AgentRuntimeSnapshot

```typescript
interface AgentRuntimeSnapshot {
  initialized: boolean;
  callIndex: number;       // 快照时的 _callIndex（比 checkpoint.callIndex 小 1）
  context: ContextSnapshot | undefined;
  featureStates: FeatureSnapshot[];
  usageStats: UsageSnapshot | undefined;
}
```

### 10.3 ContextSnapshot

```typescript
interface ContextSnapshot {
  version: number;         // 2
  messages: Message[];     // 消息列表的浅拷贝
  enrichedMessages?: EnrichedMessage[];  // 带元数据的消息列表
  sequence?: number;       // 序列号
}
```

### 10.4 AgentSessionSnapshot

```typescript
interface AgentSessionSnapshot {
  version: number;
  sessionId: string;
  savedAt: number;
  agentType: string;
  runtime: AgentRuntimeSnapshot;
  rollbackHistory: CallRollbackCheckpoint[];  // ← _callCheckpoints 的持久化形式
  namedCheckpoints?: NamedCheckpoint[];
}
```

---

## 十一、编译产物验证

### 11.1 `_callCheckpoints` 在 dist 中

```
dist/chunk-JZQDO5XF.js:
  L15460:  _callCheckpoints = [];                          // 类字段声明
  L15810:  rollbackHistory: this._callCheckpoints.map(...)  // buildSessionSnapshot
  L15825:  this._callCheckpoints = normalized.rollbackHistory.map(...)  // restoreSessionSnapshot
  L15854:  const checkpoint = this._callCheckpoints.find(...)  // rollbackToCall
  L15859:  this._callCheckpoints = this._callCheckpoints.filter(...)  // rollbackToCall 过滤
  L15971:  this._callCheckpoints = [];                     // reset()
  L16118:  this._callCheckpoints = [];                     // 另一处重置
  L16520:  this._callCheckpoints = ...filter(...).concat(checkpoint)  // commitCallCheckpoint
```

### 11.2 `rollbackToCall` 在 dist 中

```
dist/chunk-JZQDO5XF.js:
  L15852:  async rollbackToCall(callIndex) {
  L15854:    const checkpoint = this._callCheckpoints.find(...)
  L15856:    throw new Error(`Rollback checkpoint for call ${callIndex} not found`)
  L15858:    await this.restoreRuntimeSnapshot(checkpoint.runtime)
  L15860:    this.pushToDebug(this.getContext().getAll())
  ...
```

### 11.3 `pushToDebug` 在 dist 中

```
dist/chunk-JZQDO5XF.js:
  搜索 "pushToDebug" 返回 17 处匹配
  方法定义和调用均保留原名（未被 minify）
```

---

## 十二、重要注意事项

### 12.1 两仓库联动

- **`agentdev` 依赖**：Claw 的 `package.json` 中 `agentdev: file:../AgentDev`，通过 junction 指向 `D:/code/AgentDev`。
- **框架改动**：任何对 `AgentDev/src/core/agent.ts`、`context.ts`、`debug-hub.ts` 等的修改，必须在 AgentDev 仓库中改源码，然后 `cd D:/code/AgentDev && npm run build`，再重启 Claw 服务。
- **Claw 改动**：`scripts/run-prebuilt-agent.js` 是纯 JS，修改后重启 agent 即可生效。

### 12.2 重启范围

- 修改 `scripts/run-prebuilt-agent.js` → 重启对应 agent 即可
- 修改框架 dist（`AgentDev/dist/*`）→ **必须重启整个 Claw 服务**
- 修改 Claw 前端 JS/CSS → **必须重启整个 Claw 服务**

### 12.3 当前代码状态

`scripts/run-prebuilt-agent.js` 的 `triggerPartialCompact` 函数目前处于**原始未提交状态**（第一轮修复已撤销）。代码使用 `ctx.restore()` 全量替换 context，这在之前的分析中被认为有问题，但由于回退本身也不工作，这个问题的优先级降低。

---

## 十三、用户反馈时间线

| 时间 | 事件 |
|------|------|
| 前一会话 | 用户阅读未提交变更，指出 partial compact 能生成摘要但不能正确回退；rollback 正常 |
| 前一会话末 | 诊断结论为 `ctx.restore()` 是根因；提出改用 `addSystemMessage` 方案 |
| 本会话开始 | 用户说"请执行修复" |
| 本会话 | 执行修复（`ctx.restore` → `addSystemMessage`），撤销 `keptMessages` 和手动消息拼接 |
| 本会话 | 用户反馈"修复完全不对，甚至回退到此轮功能都不正常了" |
| 本会话 | 撤销修复，回到原始状态 |
| 本会话 | 通过选择题收集用户反馈：rollback "消息完全没有变化"；compact "两者都不正确" |
| 本会话 | 用户进一步明确："回退不能回退，草稿也未注入；压缩完后无事发生"；确认已重启 |
| 本会话 | 编写本文档，准备添加诊断日志 |

---

## 十四、总结

当前的核心问题是：**`rollbackToCall(callIndex)` 很可能在执行时抛出 "checkpoint not found"**，导致回退和压缩功能均失效。但尚不确定为什么 checkpoint 找不到——检查点的创建、保存、恢复逻辑在代码层面看起来是正确的。

**最高优先级的下一步**：在 `rollbackToCallAndSave` 中添加诊断日志，打印实际的 `checkpoint callIndex` 列表和前端传来的 `callIndex`，通过一次真实测试确认不匹配的具体表现。

本文档应传递给下一位接手者，确保其理解：
1. 完整的调用链路（第二节）
2. 所有关键代码位置（第四节）
3. 已排除的可能性（第五节）
4. 当前最高怀疑方向（第六节第1点）
5. 待执行的诊断步骤（第八节）
