# 群聊管理员线程中心化升级设计

> 状态：详细设计草案，不包含代码改动  
> 日期：2026-07-12  
> 前置审计：[group-chat-admin-thread-awareness-audit.md](../audits/group-chat-admin-thread-awareness-audit.md)  
> 关联设计：[group-chat-session-lineage-design.md](./group-chat-session-lineage-design.md)、[group-chat-admin-context-injection-design.md](./group-chat-admin-context-injection-design.md)

## 1. 设计命题

本设计所说的“管理员心智升级为工作线程”，不是给管理员新增一个 `gc_session_threads` 工具，也不是在系统提示词里把“会话”替换成“线程”。它要求管理员的完整工作闭环都以线程为第一对象：

```text
观察：现在有哪些工作线程？
判断：每条线程处于什么工作状态和执行状态？
定位：用户说的“继续那个工作”对应哪个线程？
操作：把指令派到该线程当前 head，而不是猜一个 session。
追踪：head 因 trim/summary 迁移后，仍然追踪同一项工作。
恢复：管理员自身轮转后，能重建全部线程态势。
解释：发生分叉时，能说明新线程从哪里来，但不被完整树结构淹没。
```

最终目标是让人类工作面板和管理员共享同一个事实视图：人看到两条进行中、三条已完成，管理员也必须看到同样的两条和三条；人点击“派发指令”命中的 head，与管理员调用工具命中的 head 必须一致。

## 2. 为什么现有“隐含工作线程”已经不够

原设计把工作线程定义为血缘关系的展示层投影，不持久化 ID、不维护状态机。这在只做 UI 浏览时非常合适，因为它避免引入项目、工单等重型概念。

但管理员升级后出现了新的必要条件：

1. 管理员需要在自然语言和工具参数中稳定引用一条线程；
2. head 从 session-A 迁移到 session-B 后，引用不能失效；
3. 同一身份有多个 head 时，需要保存默认焦点，而不能依赖最后写入的 session；
4. 管理员会话轮转后，需要恢复“我刚才管理的是哪条工作”；
5. 旧节点再次派生时，需要判断它是同线程延续还是新线程；
6. UI 和管理员需要对同一线程状态进行版本化读取。

因此建议做一次有限升级：

> 工作线程从“纯展示投影”升级为“轻量、可寻址的路由索引”，但仍不升级为需要人工维护的 Task/Issue 实体。

线程仍然：

- 不要求用户创建；
- 不要求用户手动关闭；
- 不保存独立正文；
- 不复制 session 对话；
- 工作状态主要从 head、Task 和 runtime 推断。

它只持久化无法从静态血缘可靠恢复的最小语义：稳定 ID、当前 head、分叉来源、默认焦点和状态版本。

## 3. 管理员的新核心心智

### 3.1 一句话定义

建议将管理员系统提示中的核心定义改为：

> 你管理的是群聊中的工作线程。每条工作线程代表一项持续推进的工作，当前 head session 是接收下一条指令的上下文入口。会话用于承载上下文，血缘用于追溯历史；日常判断和操作都以线程为准。

### 3.2 管理员每轮必须回答的五个问题

管理员被唤醒后，应按以下顺序形成判断：

1. **发生在谁身上**：哪个 Agent 身份？
2. **属于哪条线程**：稳定 `threadRef` 是什么？
3. **线程当前怎样**：进行中、已完成、历史，是否需要关注？
4. **head 是否能接指令**：running、queued、idle、offline、archived？
5. **现在是否应行动**：派发、等待、中断、询问用户、回复说明或保持静默？

管理员不应先问“最近的 session 是哪个”，因为“最近”只是时间关系，不是业务归属。

### 3.3 两套状态必须分开

线程同时拥有工作状态和执行状态。

#### 工作状态 `workStatus`

| 值 | 含义 | 主界面分类 |
|---|---|---|
| `active` | 工作尚未完成，或没有足够证据判断完成 | 进行中 |
| `completed` | 有明确 Task，且本轮工作全部完成 | 已完成 |
| `history` | head 已归档、缺失或明确退出管理 | 历史 |
| `attention` | 数据冲突或失败，需要人工判断 | 进行中顶部提示 |

#### 执行状态 `runtimeStatus`

| 值 | 含义 |
|---|---|
| `running` | head 正在执行 call |
| `queued` | 已有请求等待执行 |
| `idle` | runtime 在线但当前空闲 |
| `offline` | runtime 未启动，但 session 仍可打开和派发 |
| `unavailable` | head 已归档、文件缺失或不可派发 |

“已完成”不等于“离线”，“进行中”也不等于“正在运行”。管理员的行为规则必须以两个维度共同判断。

### 3.4 基础决策表

| workStatus | runtimeStatus | 管理员默认行为 |
|---|---|---|
| active | running / queued | 等待，不重复派发；用户明确要求时可中断 |
| active | idle / offline | 可以向当前 head 派发增量指令 |
| completed | idle / offline | 不主动续作；等待验收或新需求 |
| completed | running / queued | 说明状态正在变化，暂按 active 处理 |
| history | unavailable | 只读；如需继续，创建新线程或从历史节点派生 |
| attention | 任意 | 拉取详情并向用户说明冲突，不自动猜测 |

## 4. 线程数据模型

### 4.1 最小持久模型

建议在群聊数据中增加：

```json
{
  "workThreadsVersion": 1,
  "workThreads": {
    "wt-01J...": {
      "threadRef": "wt-01J...",
      "identityRef": "programming-helper:main",
      "title": "部署位置预览与国王塔激活功能",
      "rootSessionId": "session-A",
      "headSessionId": "session-C",
      "parentThreadRef": null,
      "forkedFromSessionId": null,
      "createdAt": 1783,
      "updatedAt": 1799,
      "revision": 7
    },
    "wt-01K...": {
      "threadRef": "wt-01K...",
      "identityRef": "programming-helper:main",
      "title": "部署方案备选分支",
      "rootSessionId": "session-D",
      "headSessionId": "session-D",
      "parentThreadRef": "wt-01J...",
      "forkedFromSessionId": "session-A",
      "createdAt": 1801,
      "updatedAt": 1801,
      "revision": 1
    }
  },
  "identityThreadFocus": {
    "programming-helper:main": {
      "threadRef": "wt-01J...",
      "selectedAt": 1799,
      "reason": "user_selected"
    }
  },
  "threadStateRevision": 42
}
```

不建议在 `workThreads` 中持久化 Task 完成数、运行状态、上下文用量或最近消息。这些信息变化频繁，应由统一聚合器实时读取，避免出现多份真相。

### 4.2 `threadRef` 的性质

`threadRef` 必须满足：

- 在 head 迁移时不变；
- 对人类 UI 和管理员工具使用同一个值；
- 不依赖标题；
- 不把 session ID 当成 thread ID；
- 可在日志、事件和 API 中稳定传递；
- 无需对用户展示完整值，UI 可以显示标题和短标识。

推荐使用不可读稳定 ID，例如 ULID。标题是展示属性，可以调整；ID 不应随标题变化。

### 4.3 session 到 thread 的反向索引

需要快速回答“某个 session 属于哪些线程、在其中是什么角色”。由于多个线程可以共享早期历史节点，不能只保存 `sessionId -> threadRef` 单值。

建议由血缘图动态生成反向索引：

```text
session-A -> [
  { threadRef: wt-01J, role: ancestor },
  { threadRef: wt-01K, role: fork_point }
]
session-C -> [{ threadRef: wt-01J, role: head }]
session-D -> [{ threadRef: wt-01K, role: head }]
```

持久模型只保存每条线程的 root/head/parent，完整路径继续由 `sessionLineage` 负责。

### 4.4 为什么不能用“叶子 session ID”当 threadRef

如果 `threadRef = headSessionId`，每次 trim/summary 都会改变 threadRef。管理员上下文、用户选择、历史消息、事件引用和默认焦点会全部失效，等于仍然以会话为对象。

稳定 threadRef 是本次升级的基础，不是可选优化。

## 5. 线程创建与 head 迁移规则

### 5.1 新派发

当没有目标线程并明确创建新工作时：

1. 创建新 session；
2. 创建新 `threadRef`；
3. `rootSessionId = headSessionId = newSessionId`；
4. 默认焦点是否切换，取决于触发来源；
5. 写入 `thread_created` 事件。

### 5.2 当前 head 的 trim/summary/compact

如果 source session 是线程当前 head：

1. 新 session 继承同一个 `threadRef`；
2. `headSessionId` 原子更新到 successor；
3. 原 head 成为 ancestor；
4. 如果该线程是身份默认焦点，焦点不变，因为焦点指向 threadRef；
5. 写入 `thread_head_advanced` 事件。

这是最常见、最顺畅的上下文生命周期迁移。

### 5.3 branch

branch 无论发生在哪个节点，都创建新线程：

1. 新 `threadRef`；
2. 新 session 同时是新线程 root 和 head；
3. `parentThreadRef` 指向来源线程；
4. `forkedFromSessionId` 记录切点；
5. 不自动切换身份默认焦点，除非 UI 操作明确表达“进入新分支”；
6. 写入 `thread_forked` 事件。

### 5.4 非 head 节点再次 trim/summary

操作名虽然是 trim/summary，但因为 source 已不再是当前 head，它产生的是并行未来：

1. 创建新线程，而不是推进旧线程 head；
2. `parentThreadRef` 指向包含 source 的原线程；
3. `forkedFromSessionId = sourceSessionId`；
4. 事件类型使用 `thread_revived_from_history`，不能伪装成普通 head 前移；
5. 不自动抢占默认焦点。

### 5.5 已归档 session 再派生

如果底层 session 文件仍存在，允许 branch 或 summary：

- 归档 source 保持只读和归档状态；
- successor 是新线程的可用 head；
- 新线程标题应说明其来源，但不继承“已归档”状态；
- 默认焦点不自动切换；
- 事件明确为“从归档历史派生新线程”。

如果文件已不存在，只保留血缘元数据，则工具应返回不可操作错误，不得创建无上下文空壳。

### 5.6 head 归档

归档当前 head 且没有 successor 时：

- 线程进入 `history`；
- `headSessionId` 保留用于追溯，但 `canDispatch=false`；
- 如果它是身份默认焦点，应清除焦点或选择唯一剩余 active 线程；
- 多个候选线程时不得自动选择最近一条，必须进入“焦点未确定”。

## 6. 统一线程态势 DTO

### 6.1 设计目标

人类工作面板、成员 popover、管理员工具和管理员上下文快照必须消费同一个 DTO。禁止不同消费方分别从 session pool、lineage、Task 和 runtime 自行拼装。

### 6.2 建议结构

```json
{
  "snapshotRevision": 42,
  "generatedAt": 1783,
  "totals": {
    "running": 1,
    "active": 2,
    "completed": 3,
    "history": 2,
    "attention": 0
  },
  "identities": [
    {
      "identityRef": "programming-helper:main",
      "identityName": "编程小助手",
      "focusedThreadRef": "wt-01J...",
      "threads": [
        {
          "threadRef": "wt-01J...",
          "title": "部署位置预览与国王塔激活功能",
          "head": {
            "sessionId": "session-C",
            "title": "部署位置预览与国王塔激活功能",
            "available": true,
            "archived": false
          },
          "workStatus": "active",
          "runtimeStatus": "idle",
          "canDispatch": true,
          "taskSummary": {
            "total": 4,
            "completed": 1,
            "inProgress": 0,
            "pending": 3
          },
          "contextUsage": {
            "usedTokens": 20341,
            "contextLength": 200000,
            "percent": 10,
            "compressRatio": 80
          },
          "latestMessage": {
            "role": "assistant",
            "text": "现在做部署系统的设计局限性调查……",
            "timestamp": 1782
          },
          "lineageSummary": {
            "depth": 3,
            "lastTransition": "trim",
            "parentThreadRef": null,
            "forkedFromSessionId": null
          },
          "updatedAt": 1782,
          "attentionReasons": []
        }
      ]
    }
  ]
}
```

### 6.3 状态推断顺序

建议统一聚合器按以下顺序计算：

1. head 是否存在、可打开、未归档；
2. runtime 是否 running/queued；
3. Task 是否存在、是否全部完成；
4. 本次派发是否发生在最后一次“全部完成”之后；
5. routing 是否失败、中断或长时间悬挂；
6. 是否存在数据冲突。

基础规则：

```text
if head 不可用:
  history
else if 数据冲突或 routing 异常:
  attention
else if runtime running/queued:
  active
else if tasks.total > 0 and tasks.completed == tasks.total
        and 没有更新的派发:
  completed
else:
  active
```

没有 Task 永远不能自动判断为 completed。

### 6.4 “全部完成后追加指令”的处理

Task 可能全部完成，但用户又向同一线程派发新要求。仅看 Task 快照会继续显示 completed。

建议在线程聚合中比较：

- `lastDispatchAt`；
- `allTasksCompletedAt`；
- `runtimeStatus`；
- 最新用户消息与最新 assistant 消息。

只要 `lastDispatchAt > allTasksCompletedAt`，线程先回到 active，直到 Task 或执行结果形成新的完成证据。

## 7. 默认焦点与无歧义路由

### 7.1 默认焦点只是便利，不是真相

每个身份可以有零或一个 `focusedThreadRef`。它用于用户只说“@编程小助手”而未指定线程时提供候选，但不能把其他线程隐藏或标记为不活跃。

焦点来源必须带原因：

| reason | 含义 | 可信度 |
|---|---|---|
| `user_selected` | 用户在 UI 或明确指令中选择 | 最高 |
| `admin_selected` | 管理员基于明确语义选择 | 高 |
| `head_advanced` | 当前焦点线程完成 successor 迁移 | 高，threadRef 不变 |
| `single_candidate` | 当时只有一条可派发线程 | 中 |
| `legacy_migration` | 从旧 `chat.sessions` 推断 | 低 |

### 7.2 管理员路由算法

管理员派发前按以下规则解析：

```text
1. 用户或消息已经携带 threadRef
   -> 直接使用该线程当前 head

2. 用户明确提到线程标题，且唯一匹配
   -> 使用匹配线程

3. 只有一条 canDispatch 的 active 线程
   -> 可以自动使用，并记录 single_candidate

4. 有多个 active 线程，但上下文中存在高可信 focusedThreadRef
   -> 仅当用户表达是明显增量续作时使用

5. 仍有多个合理候选
   -> 向用户列出标题和最近消息，请求选择

6. 没有合理候选，且需求是新工作
   -> 创建新线程
```

禁止使用“最近更新时间最高”作为最终业务路由规则。它只能参与候选排序。

### 7.3 head 在操作瞬间变化

管理员读取 overview 后，用户可能刚好 trim，导致 head 变化。线程级派发应使用乐观并发参数：

```json
{
  "threadRef": "wt-01J...",
  "expectedRevision": 7,
  "text": "继续实现部署预览"
}
```

服务端执行时：

- revision 未变：派到当前 head；
- revision 已变但只是同线程 head 前移：可自动解析新 head，并在返回中说明；
- thread 已归档、分裂或不可用：返回冲突，要求管理员重新读取；
- 不允许悄悄退回旧 session。

## 8. 管理员工具重构

### 8.1 主工具集合

#### `gc_thread_overview`

用途：获取当前群聊全部线程的决策摘要。

参数建议：

```json
{
  "identityRef": "可选",
  "status": "active|completed|history|attention|all",
  "includeLatestMessage": true
}
```

默认只返回 active、completed 和 attention；历史按需读取。

#### `gc_thread_detail`

用途：在路由不明确、需要验收或需要追溯时深入查看。

```json
{
  "threadRef": "必填",
  "includeTasks": true,
  "includeLineage": false,
  "recentMessages": 3
}
```

默认不展开完整 lineage。只有分叉或用户询问历史时才请求。

#### `gc_dispatch_thread`

用途：向线程当前 head 派发增量指令。

```json
{
  "threadRef": "必填",
  "expectedRevision": 7,
  "text": "本次增量需求",
  "done": true
}
```

不再要求重复填写 title，因为已有线程标题稳定存在。

#### `gc_start_thread`

用途：显式开始新工作。

```json
{
  "identityRef": "programming-helper:main",
  "title": "20 字以内标题",
  "text": "完整初始任务",
  "openDirectory": "可选",
  "focus": true,
  "done": true
}
```

把“创建新线程”和“向旧线程续作”拆成两个工具，消除 `forceNew` 与 `targetSessionId` 组合带来的歧义。

#### `gc_interrupt_thread`

用途：中断线程当前 head。必须返回实际中断的 session ID 和 thread revision。

### 8.2 保留的底层工具

以下工具保留，但降级为诊断或兼容层：

- `gc_sessions`：查看原始 session；
- `gc_session_tasks`：调试单 session Task 快照；
- `gc_session_summary`：应更名为 `gc_session_metadata`；
- 旧 `gc_dispatch`：内部适配新线程协议，并在多候选时拒绝静默路由。

### 8.3 工具返回文本

管理员真正进入 reasoning 的文本必须把主次写清楚：

```text
编程小助手：2 进行中 · 3 已完成 · 2 历史

[进行中/空闲] 部署位置预览与国王塔激活功能
threadRef: wt-01J…  revision: 7
Task 1/4 · 上下文 10% · 可派发
最近：现在做部署系统的设计局限性调查……

[进行中/运行中] 项目进度梳理与下一步开发计划
threadRef: wt-01K…  revision: 3
Task 未建立 · 不要重复派发
```

session ID 只在 detail 和执行结果中展示，不占 overview 主视觉。

## 9. 管理员 Context Package v2

### 9.1 每次激活的结构

```text
[system] 固定身份与协作规则

[system] 群聊静态背景
  群名、成员、工作目录、GROUP.md 版本

[system] 线程态势快照
  活跃/已完成/注意项、head、运行状态、Task、最近消息、默认焦点

[system] 自上次确认后的结构化增量
  threadRef、事件类型、before/after、seq

[system] 有预算时补充近期群聊叙事

[user] 当前真实用户请求
或
[user] [系统触发] 某线程发生需要判断的变化
```

管理员首先看到“现在”，再看到“变化”，最后处理“当前请求”。

### 9.2 什么情况下必须注入态势快照

以下场景必须注入：

- 管理员新 session 首次激活；
- 用户直接 @管理员；
- 管理员需要派发、中断或判断进度；
- `threadStateRevision` 自上次管理员确认后变化；
- 发生分叉、head 迁移、归档、完成状态变化或错误；
- 管理员上次处理失败或游标状态不确定。

如果管理员在同一个 call 内连续 step，快照 revision 未变，可以只注入增量，避免重复。

### 9.3 线程快照的裁剪策略

预算不足时按以下优先级：

1. attention 线程完整保留；
2. running/queued 线程完整保留；
3. active idle 线程保留标题、head、Task 和最近消息；
4. completed 线程保留标题、完成时间和摘要；
5. history 只保留数量，不逐条注入；
6. 完整 lineage 永不默认注入。

### 9.4 管理员轮转

管理员 session 达到上下文阈值后，新 session 不再重放一大段群聊作为主要记忆，而是：

1. 编译当前线程快照 `snapshotRevision=N`；
2. 附上尚未确认的事件 seq 区间；
3. 在剩余预算中选取近期普通消息；
4. 记录旧管理员 session 和新 session 的交接元数据；
5. 新管理员从快照直接恢复管理态势。

因此管理员轮转不再依赖模型从消息中重新推理所有线程。

## 10. 事件协议升级

### 10.1 事件最小字段

```json
{
  "id": "evt-...",
  "seq": 1842,
  "type": "thread_head_advanced",
  "idempotencyKey": "thread:wt-01J:revision:8",
  "threadRef": "wt-01J...",
  "threadRevision": 8,
  "identityRef": "programming-helper:main",
  "sourceSessionId": "session-B",
  "headSessionId": "session-C",
  "operation": "trim",
  "workStatusBefore": "active",
  "workStatusAfter": "active",
  "timestamp": 1783
}
```

所有影响线程状态的事件必须带 `threadRef`。只带 identity 和 session title 的事件不足以支持管理员判断。

### 10.2 推荐事件类型

| 事件 | 含义 | 是否默认唤醒管理员 |
|---|---|---|
| `thread_created` | 新工作线程产生 | 取决于模式和触发来源 |
| `thread_head_advanced` | 当前 head 正常迁移 | 否，进入增量水位线 |
| `thread_forked` | 显式 branch 新线程 | 可选；多线程数量发生变化 |
| `thread_revived_from_history` | 从非 head/归档节点派生 | 是，属于注意项 |
| `thread_work_status_changed` | active/completed/history 变化 | completed 可按模式唤醒 |
| `thread_runtime_changed` | running/idle/offline 变化 | 通常不唤醒，只更新快照 |
| `thread_task_changed` | Task 状态变化 | 单 Task 不唤醒；全部完成可唤醒 |
| `thread_dispatch_failed` | 派发失败 | 是 |
| `thread_interrupted` | 用户或管理员中断 | 是或进入增量 |

### 10.3 事件不是消息文案

事件先保存结构化事实，再由两个展示器分别生成：

- 人类消息流中的薄事件线；
- 管理员上下文中的精确变化描述。

两者可以文案不同，但必须来自同一事件，不能各自拼 session title 和 identity，避免再次出现“编程小助手会话已精简，但不知道是哪条线程”。

## 11. 激活策略与响应模式

线程心智解决“管理员醒来后知道什么”，激活策略解决“什么时候值得叫醒管理员”，两者必须分离。

### 11.1 assist

- 管理员不因普通活动自动激活；
- 所有事件仍更新线程快照；
- 用户直接 @管理员时，读取最新快照；
- 生命周期变化不会因为未唤醒而丢失。

### 11.2 plan

- 用户消息和关键完成变化可以激活管理员观察；
- 已自动派发的线程不得重复派发；
- 普通 Task 完成只更新快照，全部完成或失败才触发判断；
- 管理员主要建议、澄清和跟踪，不越权执行。

### 11.3 execute

- 管理员可以根据明确规则派发和衔接线程；
- 仍然必须遵守 running 不重复派发、多候选不猜测；
- 条件编排应绑定 `threadRef`，不能绑定某个易变化的 session ID；
- head 迁移后依赖关系继续有效。

## 12. 人类 UI 与管理员的一致性

### 12.1 同一个列表，不同密度

人类面板和管理员不需要完全相同的排版，但必须有完全相同的排序和分组语义：

```text
第一层：attention
第二层：running / queued 的 active
第三层：idle / offline 的 active
第四层：completed
第五层：history
```

### 12.2 同一个操作语义

| 人类按钮 | 管理员工具 | 服务端动作 |
|---|---|---|
| 派发指令 | `gc_dispatch_thread` | threadRef -> 当前 head -> 派发 |
| 中断 | `gc_interrupt_thread` | threadRef -> 当前运行 head -> 中断 |
| 查看任务 | `gc_thread_detail(includeTasks)` | 读取 head Task |
| 查看脉络 | `gc_thread_detail(includeLineage)` | 展开线程路径 |
| 新建工作 | `gc_start_thread` | 创建 session + thread |

禁止 UI 直接传 session ID、管理员传 threadRef 后走两套不同路由。

### 12.3 用户选择要反哺管理员

用户在工作面板点击某条线程并从群聊输入框派发时，系统应：

- 在消息 routing 中记录 `threadRef`；
- 更新 `identityThreadFocus`，原因 `user_selected`；
- 让管理员之后理解“这个”“继续刚才那个”时拥有可靠指代；
- 不要求管理员从消息文本猜测用户点击了哪个卡片。

## 13. 并发与一致性

### 13.1 原子更新边界

以下动作必须处于同一群聊级事务或串行队列：

1. 写入 session lineage edge；
2. 判断 source 是否为 thread head；
3. 创建线程或推进 head；
4. 更新 thread revision 和全局 snapshot revision；
5. 必要时更新 identity focus；
6. 追加结构化事件。

不能先写 lineage、稍后再异步覆盖 `chat.sessions`，否则管理员可能读取到半完成状态。

### 13.2 读一致性

`gc_thread_overview` 返回 `snapshotRevision`。所有变更工具接收 `expectedRevision`。这样管理员的“观察—操作”形成可检测的乐观事务。

### 13.3 幂等性

以下操作必须可重试：

- lineage 通知；
- Task 完成事件；
- inbox 投递；
- 管理员派发；
- head 迁移。

每个事件和命令都应携带稳定幂等键。重复收到同一 lineage 通知不能创建两条线程；重复 Task 完成不能增加两次进度；管理员工具超时重试不能派发两遍。

## 14. 旧数据迁移

### 14.1 从现有血缘重建线程

对每个群聊按 `sessionLineage.timestamp` 排序回放：

1. 每个没有 incoming edge 的 session 创建根线程；
2. `branch` edge 永远创建新线程；
3. trim/summary/compact edge 如果 source 是当时线程 head，则继承 threadRef；
4. 如果 source 已不是当时 head，则创建新线程；
5. 缺时间或顺序歧义时，宁可创建新线程，不要错误合并；
6. 当前 `chat.sessions[identityRef]` 只用于推断迁移后的低可信默认焦点；
7. 生成迁移报告，记录孤立节点、环、重复边和缺失 session。

### 14.2 没有 lineage 的扁平 session

- 每个独立群内 session 暂视为一条线程；
- imported session 创建独立线程并标记来源；
- 标题相同不能自动合并；
- 迁移后可通过 UI 查看，但不要求用户人工整理。

### 14.3 兼容期

建议一个版本内双写：

- 新逻辑写 `workThreads` 和 `sessionLineage`；
- `chat.sessions[identityRef]` 继续镜像 focused thread 的 head，供旧消费方使用；
- 新 UI 和管理员只读线程 DTO；
- 观察没有旧消费方后，再弱化 `chat.sessions` 的路由权威性。

## 15. 分阶段实施计划

### Phase 0：统一语义和 DTO

- 定义 `threadRef`、workStatus、runtimeStatus、focus reason；
- 抽出唯一 `buildThreadSituationSnapshot()`；
- 让工作面板改用统一 DTO，验证结果不回退；
- 暂不改变派发。

### Phase 1：稳定线程索引

- 增加最小 `workThreads` 持久模型；
- 实现 lineage 回放迁移；
- 实现 head advance、fork、history revival 规则；
- 增加 thread/snapshot revision；
- `chat.sessions` 保持兼容镜像。

### Phase 2：线程级管理员工具

- 新增 overview/detail/start/dispatch/interrupt 工具；
- 多候选时拒绝静默默认；
- UI 与管理员共用 threadRef 路由；
- Task、最近消息、上下文用量进入管理员工具文本。

### Phase 3：管理员提示词与 Context Package v2

- 系统提示改为线程心智；
- 每次关键激活注入线程快照；
- 增量事件带 threadRef；
- 新管理员 session 基于快照恢复；
- 旧群消息只作为有预算的叙事上下文。

### Phase 4：可靠水位线与投递

- 消息单调 seq；
- enqueued/acknowledged 游标；
- bridge 持续轮询与 busy 注入集成测试；
- 投递幂等与崩溃恢复；
- Task 事件持久去重。

### Phase 5：移除会话级默认心智

- 旧 `gc_dispatch` 仅作适配；
- `gc_sessions` 降级为诊断；
- 取消“默认最近 session”规则；
- 评估移除 `chat.sessions` 的路由权威性。

## 16. 测试矩阵

### 16.1 状态推断

- 无 Task + idle -> active；
- 4/4 Task + idle -> completed；
- 4/4 Task + 新派发 -> active；
- completed + running -> active；
- head archived -> history；
- routing failed -> attention。

### 16.2 血缘

- 当前 head trim -> 同 threadRef、revision +1；
- 当前 head summary -> 同 threadRef；
- branch -> 新 threadRef；
- 旧节点 summary -> 新 threadRef；
- 归档节点 branch -> 新 threadRef，source 仍归档；
- 重复 lineage 回调 -> 不重复建线程。

### 16.3 路由

- 单 active 线程可自动选择；
- 两个 active 线程且无指代 -> 必须询问；
- 用户 UI 选择 threadRef -> 管理员后续沿用；
- overview 后 head 前移 -> dispatch 自动解析同线程新 head；
- overview 后线程归档 -> revision conflict，不得派到旧 head。

### 16.4 管理员恢复

- 管理员首次激活获得完整 active/completed 快照；
- 自动轮转后线程数量、状态和焦点完全一致；
- 不重放全部历史事件也能恢复当前态；
- 同一批消息不同时出现在 snapshot delta 和 catch-up；
- 管理员进程崩溃后从 acknowledged seq 恢复。

### 16.5 人机一致性

- API DTO、工作面板计数、管理员 overview 计数相同；
- UI 派发和管理员派发命中同一 head；
- UI 中断后管理员事件带相同 threadRef；
- 已完成/进行中/历史分类一致；
- 最近消息和 Task 数据同源。

## 17. 可观测性

建议为每次管理员决策记录结构化日志：

```json
{
  "adminSessionId": "...",
  "triggerSeq": 1842,
  "snapshotRevision": 42,
  "candidateThreadRefs": ["wt-01J", "wt-01K"],
  "selectedThreadRef": "wt-01J",
  "selectionReason": "explicit_message_thread_ref",
  "resolvedHeadSessionId": "session-C",
  "action": "dispatch",
  "result": "delivered"
}
```

需要监控：

- 多候选澄清率；
- 错误路由或 revision conflict 率；
- 每次管理员上下文包 token 构成；
- 快照构建耗时；
- 重复事件去重次数；
- inbox 积压与最老未确认 seq；
- 管理员轮转后首次决策成功率。

这些指标才能验证线程心智是否真的降低了管理员错误，而不是仅改变了文案。

## 18. 明确不做的事情

本设计不建议同时引入以下复杂度：

- 不把工作线程变成用户必须维护的项目实体；
- 不要求用户给每条线程设置负责人、截止时间或优先级；
- 不把完整 lineage 默认注入管理员；
- 不让管理员自动决定所有分叉是否合并；
- 不基于标题相似度自动合并线程；
- 不把“全部 Task 完成”解释为业务已经验收；
- 不让默认焦点遮蔽其他并行线程；
- 不在本阶段实现跨群线程。

## 19. 最终交互心智

升级完成后，管理员的内部视角应当接近以下结构：

```text
这是一个群聊工作空间。

编程小助手当前有：
- 2 条进行中的工作线程
  - 1 条正在运行
  - 1 条空闲可继续
- 3 条已完成线程
- 2 条历史线程

用户当前指令明确指向“部署位置预览”线程。
该线程 head 已从旧 session trim 到新 session，threadRef 未变。
当前 head 空闲、Task 1/4、上下文 10%，可以接收增量指令。
因此把本次指令派到这条线程，而不是新建会话，也不影响另一条并行线程。
```

对用户而言，后台可能仍是一棵复杂的 session 树；对管理员而言，它始终是一组稳定、可操作、可恢复的工作线程。树负责保留历史可能性，线程 head 负责承载当前行动。这就是线程中心化设计要建立的核心秩序。
