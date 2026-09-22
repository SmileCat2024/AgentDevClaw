# 群聊模块管理员上下文信息设计

> 本文档定义群聊模块中管理员会话的上下文注入设计原则、实现规范和已知边界。
> 适用于 `server/routes/group-chat.js`、`local-features/group-admin/src/bridge.ts`、`local-features/group-admin/src/index.ts`。

---

## 1. 设计原则

### 1.1 两层结构

管理员会话的每次激活都遵循统一的两层角色结构。线程中心化升级后，第一层 system 证据中增加“当前工作线程态势”，但不增加新的消息角色，也不改变 user 块语义：

```
┌─────────────────────────────────────────┐
│ system-reminder                          │ ← 第一层：环境证据
│ ─── 当前工作线程态势 ───                  │    现在有哪些工作、head 状态、Task、最近消息
│ [进行中·空闲] 线程A · Task 1/4           │
│ ─── 你未读的群聊消息（共N条）───          │    水位线追赶，解释刚刚发生了什么
│ [时间] 发送者：消息原文                   │
├─────────────────────────────────────────┤
│ user                                     │ ← 第二层：事件通知
│ {事件类型描述}                            │    一句话，只说"发生了什么类型的事"
└─────────────────────────────────────────┘
```

**核心区分**：

| 维度 | system-reminder (catch-up) | user 块 |
|------|---------------------------|---------|
| 角色 | 证据（现在怎样、发生了什么） | 指令（本轮为何激活） |
| 内容 | 当前工作线程态势 + 原始消息全文 | 用户原文或事件类型描述 |
| 长度 | 不限 | 一句话 |

### 1.2 唯一例外：用户直接 @管理员

当用户直接 @管理员时，user 块 = 用户原文。此时用户确实在跟管理员说话，user 角色语义正确，不需要封装。

### 1.3 user 块的设计约束

- **不过度预设语义**：不写"无需回复"、"请知悉即可"等行为预设
- **复用已有表达习惯**：延续群聊消息通知的既有措辞风格
- **保持极简**：一句话描述事件类型，不包含消息原始内容

### 1.4 运行中插入（busy 路径）

管理员正在 call 中时，新到达的消息不触发新 call，而是作为新的水位线（catch-up）在 `@StepStart` 注入为 system-reminder。

- 非 @admin 场景：只注入 catch-up（text 已被 catch-up 覆盖，跳过）
- @admin 直达场景：注入 catch-up + text（catch-up 不含触发消息，text 是用户原话）

### 1.5 工作线程态势块

线程态势块由服务端基于会话血缘、当前 head、runtime、Task、上下文用量和最近消息实时编译。它属于 system 证据层，回答“管理员现在面对的工作现场是什么”，不能放进 user 块。

基本规则：

- 运行中/排队中的线程不得重复派发；
- 空闲且进行中的线程可以继续；
- 有 Task 且全部完成的空闲线程归为已完成；
- 没有 Task 表示尚未结构化，不代表完成；
- 归档或缺失的 head 只进入历史统计；
- 完整血缘不默认注入，需要时通过线程详情工具拉取。

线程态势与 catch-up 分工明确：态势回答“现在是什么”，catch-up 回答“刚刚怎么变成这样”。即使管理员 session 发生轮转，也应先依靠态势块恢复当前管理视角，而不是要求模型仅从群消息重新推理所有 head。

---

## 2. 激活场景与注入规范

### 场景总览

| # | 场景 | 触发条件 | user 块 | catch-up 含触发消息 |
|---|------|---------|---------|-------------------|
| A | 用户直接 @管理员 | 任何模式 | 用户原文 | 否 |
| B | 用户 @其他 Agent（execute 模式） | initiativeMode=execute | `用户 @了 {targetName}` | 是 |
| C | 用户 @其他 Agent（plan 模式） | initiativeMode=plan | `用户 @了 {targetName}` | 是 |
| D | 用户发普通消息（plan 模式） | initiativeMode=plan，无 @ | `用户发送了消息` | 是 |
| E | Agent 完成回复（plan 模式） | writeback → plan 模式通知 | `{senderName}{sessionLabel} 回复了` | 是 |
| F | 系统事件（task_started，plan 模式） | kind=event | `系统事件：{identity}{session} 已开始处理` | 是 |

### 场景 A — 用户直接 @管理员

```
system: ─── 你未读的群聊消息（共2条）───
 [18:50] 用户：刚才那个任务做完了吗？
 [18:53] 编程小助手 [会话:X]：已完成...

user: 群管，帮我看看那个任务的情况
```

**实现**：`dispatchToIdentity` 传 `{ includeCurrentMessage: false }`，user 块 = `message.text` 原文。

### 场景 B — execute 模式，用户 @其他 Agent

```
system: ─── 你未读的群聊消息（共1条）───
 [18:55] 用户：@编程小助手 请简单介绍一下你自己

user: 用户 @了 编程小助手
```

**实现**：`dispatchToIdentity` 传 `{ includeCurrentMessage: true }`，user 块 = `用户 @了 ${targetName}`。

> 注：当前 execute 与 plan 模式在注入结构上完全一致，差异体现在 runtime 行为（是否自动派发）。未来 execute/plan 的进一步区分（用户确认流程等）不影响注入结构。

### 场景 C — plan 模式，用户 @其他 Agent

```
system: ─── 自动派发状态 ───
 目标：编程小助手（programming-helper:main）
 操作：创建了新会话「xxx」
 sessionId: xxx
 系统已自动将此消息派发给编程小助手，你不需要重复派发。

 ─── 你未读的群聊消息（共1条）───
 [18:55] 用户：@编程小助手 修复

user: 用户 @了 编程小助手
```

**实现**：`notifyAdminWithPrompt` 传 `includeCurrentMessage=true`，user 块 = `用户 @了 ${targetName}`，systemNote 含自动派发状态。

### 场景 D — plan 模式，用户发普通消息

```
system: ─── 你未读的群聊消息（共1条）───
 [18:53] 用户：咱们总共是有几个阶段要做呀？

user: 用户发送了消息
```

**实现**：`notifyAdminForActivity` 传 `includeCurrentMessage=true`，user 块 = `用户发送了消息`。

### 场景 E — Agent 完成回复

```
system: ─── 你未读的群聊消息（共1条）───
 [19:07] 编程小助手 [会话:群聊设置页重构 #4]：
 Phase 1 已全部完成。以下是实施摘要...
 （完整回复全文）

user: 编程小助手 [会话:群聊设置页重构 #4] 回复了
```

**实现**：`notifyAdminForActivity` 中 `activityDesc = ${senderName}${sessionLabel} 回复了`，Agent 回复全文只出现在 catch-up（system-reminder），不进入 user 块。

### 场景 F — 系统事件

```
system: ─── 你未读的群聊消息（共1条）───
 [19:05] [系统事件] 编程小助手 [会话:X] 已开始处理

user: 系统事件：编程小助手 [会话:X] 已开始处理
```

**实现**：`notifyAdminForActivity` 中 `kind === 'event'` 分支。

---

## 3. 注入链路

### 3.1 服务端组装（group-chat.js）

```
群聊消息到达
 │
 ├─ @管理员 → dispatchToIdentity('work-group:admin', message.text, { includeCurrentMessage: false })
 │
 ├─ execute 模式 @其他 Agent → dispatchToIdentity('work-group:admin', "用户 @了 X", { includeCurrentMessage: true })
 │
 ├─ plan 模式 @其他 Agent
 │   ├─ dispatchToIdentity(target, prompt)        ← 派发给执行 Agent
 │   └─ notifyAdminWithPrompt("用户 @了 X", systemNote, includeCurrentMessage=true)  ← 通知管理员
 │
 ├─ plan 模式普通消息 → notifyAdminForActivity(includeCurrentMessage=true)
 │
 └─ Agent writeback → notifyAdminForActivity(includeCurrentMessage=true)

每个调用点最终都汇聚到 enqueueGcInbox(runtimeKey, msg):
  msg.text         = 事件通知（user 块内容）
  msg.contextText  = prepareAdminContext() 返回的 catch-up（system 块内容）
  msg.textInCatchUp = includeCurrentMessage（标记 text 是否已被 catch-up 覆盖）
```

### 3.2 prepareAdminContext 组装内容

```
prepareAdminContext(chatId, allIdentities, ts, msgId, isNew, includeCurrentMessage)
 │
 ├─ [isNew=true] 群聊基本信息（formatGroupInfoBlock）
 ├─ [isNew=true] GROUP.md 群聊背景
 ├─ [isNew=true] 群记忆（composeGroupMemory + formatGroupMemoryPrompt）
 ├─ [每次激活] 当前工作线程态势（buildThreadSituation + formatAdminThreadSituation）
 │
 └─ [catch-up] 水位线追赶
     ├─ includeCurrentMessage=false：排除触发消息（场景 A）
     └─ includeCurrentMessage=true：包含触发消息（场景 B-F）
```

`isNew=true` 的静态背景块只在 session 首次注入，后续轮次不重复。线程态势是动态视图，每次管理员激活时重新编译；它保持精简，不默认展开历史线程和完整血缘。

### 3.3 bridge 注入（bridge.ts）

```
GroupChatBridgeFeature 轮询 /protoclaw/gc/inbox
 │
 ├─ 空闲（idle）
 │   ├─ pendingContext = msg.contextText  （存待 CallStart 注入）
 │   └─ dispatchViaArbiter(msg.text)      （text 成为新 call 的 user 输入）
 │       └─ @CallStart: pendingContext → role=system
 │
 └─ 活跃（busy）
     └─ pendingBuffer.push(msg)
         └─ @StepStart:
             ├─ msg.textInCatchUp=true:  只注入 contextText（新水位线）
             └─ msg.textInCatchUp=false: 注入 contextText + text（含用户原话）
```

---

## 4. 身份提醒强化注入

管理员身份提醒（`[管理员身份提醒]`）是刻意设计的强化认知机制，由 `GroupAdminFeature` 的 `@CallStart` 和 `@StepStart` hook 注入，与 catch-up 体系独立。

- **目的**：在长会话中持续强化管理员的身份边界和行为约束
- **频率**：`REMINDER_INTERVAL = 1`（每轮 call 注入），`STEP_REMINDER_INTERVAL = 3`（call 内每 3 步注入变体）
- **与 system prompt 的关系**：system prompt 提供完整规则，身份提醒是高频摘要强化
- **实现位置**：`local-features/group-admin/src/index.ts`

---

## 5. 已完成的修复（2026-07-02）

### 5.1 user 块角色混乱修复

**问题**：活动通知（Agent 回复、系统事件等）的原始内容被注入为 `role=user`，导致模型无法从角色字段区分"谁在说话"。Agent 回复全文（可能数千字符）作为 user 消息注入，角色完全错位。

**修复**：所有非 @admin 场景的触发消息纳入 catch-up（system-reminder），user 块只保留一句话事件通知。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `server/routes/group-chat.js` | `prepareAdminContext` 增加 `includeCurrentMessage` 参数 |
| `server/routes/group-chat.js` | `dispatchToIdentity` 增加 `opts` 参数透传 |
| `server/routes/group-chat.js` | execute 模式 `coordinatorPrompt` 简化为 `用户 @了 ${targetName}` |
| `server/routes/group-chat.js` | plan 模式 `observationText` 简化，移除 `[观察]` 前缀和原话 |
| `server/routes/group-chat.js` | `notifyAdminWithPrompt` 传 `includeCurrentMessage=true` |
| `server/routes/group-chat.js` | `notifyAdminForActivity` 的 `activityDesc` 移除原始内容 |
| `server/routes/group-chat.js` | 所有 `enqueueGcInbox` 调用增加 `textInCatchUp` 标记 |
| `local-features/group-admin/src/bridge.ts` | `GcMessage` 接口增加 `textInCatchUp` 字段 |
| `local-features/group-admin/src/bridge.ts` | busy 路径根据 `textInCatchUp` 决定是否注入 text |

### 5.2 busy 路径一致性修复

**问题**：同一消息在 idle 时 text 成为 user 消息，busy 时 text 与 contextText 合并为 system — 两套行为不一致。

**修复**：busy 路径根据 `textInCatchUp` 标记，对非 @admin 场景只注入 contextText（新水位线），不再拼接 text。idle 和 busy 的语义统一为"catch-up（system）+ 事件通知（user，仅 idle）"。

---

## 6. 通知闭环修复（已完成）

群聊的通知闭环原由 agent 子进程（bridge feature）负责。以下三个修复将闭环责任转移到 server 主进程，覆盖中断、进程死亡和重启三种场景。

### 6.1 中断原因补齐（层 1）

**问题**：管理员点击"中断"后，agent 的 `onInterrupt` 基类返回 `[执行被中断: interrupted]`，bridge 正常 writeback 到群聊。但管理员不知道**为什么**被打断。`gc/control` 掌握完整上下文（谁中断了哪个 session），但这个信息没有写入群聊或通知管理员。

**修复**：`gc/control` 中断成功后，异步写入 `kind: 'event'`（`type: 'session_interrupted'`）消息到群聊。plan 模式下调用 `notifyAdminForActivity` 通知管理员。

管理员在 catch-up 中会看到：
```
[19:07] [系统事件] 编程小助手（会话已被管理员中断）
[19:07] 编程小助手 [会话:X]：[执行被中断: interrupted]
```

事件消息说明**为什么**，bridge 的 writeback 说明 agent **输出了什么**。

**实现**：
- `server/routes/group-chat.js` `POST /protoclaw/gc/control`（L805），中断成功后异步写入事件 + 通知管理员
- `notifyAdminForActivity`（L1721）增加 `session_interrupted` 事件类型描述

### 6.2 Agent 进程死亡闭环（层 2）

**问题**：Agent 崩溃/被杀时，bridge 永远不会触发 `@CallFinish`，无 writeback，群聊 routing 永远停在 `processing`，管理员不知道 agent 已下线。

**修复**：

1. **`agent-lifecycle.js`** 增加 `onAgentExit` 回调注册机制。`child.on('exit')` 中遍历 `_exitCallbacks`，传递 `(agentId, sessionId, exitCode, runtimeKey)`。
2. **`server.js`** 将 `agentLifecycle.onAgentExit` 传入 `setupGroupChatRoutes`。
3. **`group-chat.js`** 注册回调：
   - 扫描所有群聊，查找该 agent 在本群聊中 `routing.status === 'processing'` 的消息
   - 将 routing 状态更新为 `failed`（`failureReason: 'agent_process_exit'`）
   - 写入 `kind: 'event'`（`type: 'agent_offline'`）消息
   - plan 模式下通知管理员

### 6.3 启动时孤儿状态修复（层 3）

**问题**：Claw 重启后所有 agent 子进程被杀，但群聊 JSON 中 routing 仍为 `processing`，无机制检测和修复这些孤儿状态。

**修复**：`group-chat.js` 新增 `cleanupOrphanedRouting()` 函数，在 `server.js` 启动时调用：
- 扫描所有群聊文件
- 查找 `routing.status === 'processing'` 但对应 agent runtime 不在线的消息
- 标记为 `failed`（`failureReason: 'agent_unavailable_on_restart'`）

### 6.4 事件类型与通知描述对照

`notifyAdminForActivity` 中事件描述按 `event.type` 分支：

| `event.type` | user 块描述 | 触发场景 |
|-------------|-------------|---------|
| `task_started` | `系统事件：{name}{session} 已开始处理` | 消息派发成功 |
| `session_interrupted` | `系统事件：{name}{session} 会话已被管理员中断` | 管理员手动中断 |
| `agent_offline` | `系统事件：{name}{session} 进程已退出` | agent 进程死亡 |
| (default) | `系统事件：{name}{session}` | 其他事件类型 |

### 6.3 未来模式演进（观察/规划/执行）

当前三个模式在注入结构上完全一致，差异体现在 runtime 行为：

| 模式 | 注入结构 | 差异 |
|------|---------|------|
| 观察（assist） | catch-up + user 块 | 管理员不参与，无注入 |
| 规划（plan） | catch-up + user 块 + systemNote | systemNote 含自动派发状态 |
| 执行（execute） | catch-up + user 块 | 无 systemNote（管理员需自行派发） |

未来规划模式增加用户确认流程后（用户 UI 确认 → 拒绝则通知管理员），新的事件类型自然遵循 catch-up + user 块结构，无需特殊处理。当前设计已兼容这一演进方向。

---

## 7. 关键代码位置速查

| 职责 | 文件 | 函数/位置 |
|------|------|----------|
| catch-up 组装 | `server/routes/group-chat.js` | `prepareAdminContext()` L1244 |
| 消息派发到 identity | `server/routes/group-chat.js` | `dispatchToIdentity()` L1345 |
| execute 模式协调 | `server/routes/group-chat.js` | `case 'execute'` L1529 |
| plan 模式通知 | `server/routes/group-chat.js` | `notifyAdminWithPrompt()` L1612 |
| 活动通知 | `server/routes/group-chat.js` | `notifyAdminForActivity()` L1711 |
| 派发 prompt 组装 | `server/routes/group-chat.js` | `composeDispatchPrompt()` L591 |
| writeback 回写 | `server/routes/group-chat.js` | `POST /protoclaw/gc/writeback` L689 |
| 中断控制 | `server/routes/group-chat.js` | `POST /protoclaw/gc/control` L765 |
| 中断事件写入 | `server/routes/group-chat.js` | `gc/control` 中断后异步块 L808 |
| inbox 投递 | `server/routes/group-chat.js` | `enqueueGcInbox()` L650 |
| bridge 轮询与注入 | `local-features/group-admin/src/bridge.ts` | `GroupChatBridgeFeature` |
| 身份提醒 | `local-features/group-admin/src/index.ts` | `GroupAdminFeature` |
| agent 进程退出处理 | `server/routes/agent-lifecycle.js` | `child.on('exit')` L393 |
| agent 退出回调注册 | `server/routes/agent-lifecycle.js` | `onAgentExit` 返回项 L800 |
| agent 死亡闭环 | `server/routes/group-chat.js` | `onAgentExit` 回调注册 L2940 |
| 孤儿 routing 修复 | `server/routes/group-chat.js` | `cleanupOrphanedRouting()` L2894 |
| agent 中断基类 | `AgentDev/src/core/agent.ts` | `onInterrupt()` L1690 |
