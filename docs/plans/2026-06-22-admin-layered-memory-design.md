# 群聊管理员：分层记忆模型设计

> **日期**：2026-06-22（2026-06-23 更新）
> **状态**：核心机制已实现并持续迭代
> **前置文档**：
> - [2026-06-21-post-phase1-design-discussion.md](./2026-06-21-post-phase1-design-discussion.md)
> - [2026-06-22-group-chat-investigation-and-ui-refactor.md](../investigations/2026-06-22-group-chat-investigation-and-ui-refactor.md)

---

## 1. 核心理念

管理员（以及其他群聊 agent）的记忆不是单一的"一个 session"，而是**两层混合**：

```
┌─────────────────────────────────────────────┐
│  群聊长线记忆 (Group Memory)                  │
│  · 基于 memoryRange (1d/3d/1w) 提取           │
│  · append-only，只增不删                      │
│  · 给 agent 充足的时序认知                     │
│  · 群聊完整记录的「视图」，不可能全塞进上下文    │
└──────────────────┬──────────────────────────┘
                   │ 启动时注入 / 续接时增量注入
                   ▼
┌─────────────────────────────────────────────┐
│  管理员工作 Session (Working Memory)          │
│  · 有预设的上下文长度/比例限制                  │
│  · 超限 → 新建 session + 预注入群记忆          │
│  · 未超限 → 续接 session + 注入增量消息        │
│  · 运行时的实际工作记忆                        │
└─────────────────────────────────────────────┘
```

**关键洞察**：长线记忆稳定（不随 session 重建而丢失），具体执行时的 session 靠谱（有明确的上下文边界）。分层设计让两者各司其职。

---

## 2. 群聊设置项

在群聊设置面板中新增：

| 设置 | 选项 | 说明 |
|------|------|------|
| 记忆范围 | 1天 / 3天 / 1周 / 全部 | 提取群聊消息的时间窗口 |
| 上下文限制模式 | 按长度 / 按比例 | 二选一 |
| 上下文限制值 | 按长度：如 8000 tokens；按比例：如 40% | 控制 session 何时滚动 |

存储位置：群聊 JSON 的新字段

```json
{
  "adminMemory": {
    "range": "3d",            // "1d" | "3d" | "1w" | "all"
    "limitMode": "tokens",    // "tokens" | "ratio"
    "limitValue": 8000        // tokens 数 或 百分比(如 40)
  }
}
```

---

## 3. Session 解析逻辑（重写 `resolveGroupChatSession`）

当前 `resolveGroupChatSession` 对 persistent 身份永远复用同一 session。新逻辑：

```
admin 启动时：
  1. 检查是否有历史 session（chat.sessions['work-group:admin']）
     ├─ 无 → 新建 session + 预注入群记忆
     └─ 有 → 检查该 session 的上下文使用量
        ├─ 未超限 → 续接 session + 注入增量消息
        └─ 已超限 → 新建 session + 预注入群记忆
```

### 3.1 上下文使用量判断

框架的 session index 已经记录了 `tokenUsage.lastRequestUsage`（最近一次 API 请求的 token 消耗），这就是当前上下文的使用量。无需自行估算。

数据来源：`readSessionIndex(agentId)` → session record → `tokenUsage.lastRequestUsage.totalTokens`

- **按 tokens**：如果 `lastRequestUsage.totalTokens >= limitValue`，判定超限。
- **按比例**：`lastRequestUsage.totalTokens / contextLength > limitValue%`。`contextLength` 来自 `resolveSessionModelInfo()`。

### 3.2 预注入群记忆（新建 session 时）

新建 session 时，**不是让 agent 自己去扒群聊信息**，而是服务端预先组装好上下文，注入 session 的初始消息或 system prompt：

```text
[群聊：系统重构]
[记忆范围：最近 3 天]
[群目标：对 auth 和 payment 模块进行重构]

=== 群聊记录摘要（最近 3 天）===

[2026-06-20 14:30] 用户：@主代理 检查 auth 模块的登录逻辑
[2026-06-20 14:31] 主代理：已开始处理
[2026-06-20 15:20] 主代理：发现 3 处 token 验证问题（writeback 摘要）
...

[2026-06-21 10:00] 用户：@管理员 总结一下昨天的工作
[2026-06-21 10:15] 管理员：昨天完成了 auth 模块的检查...

=== 待处理事项 ===
（从消息中提取的未完成任务、待回复问题等）

你是这个群聊的管理员。以上是最近 3 天的群聊记录摘要。
```

**要点**：
- 消息摘要不是全文——每条消息提取关键信息（from、time、前 100 字）
- 按时间正序排列，保证时序认知
- 已完成的任务标记状态
- 这段预注入内容是"长线记忆"的一部分，不会因为 session 滚动而丢失

### 3.3 增量注入（续接 session 时）

**这是管理员专属的能力——只有管理员拥有群聊的整体感知权。**

其他身份（如编程小助手）只收到派发给它的那条消息，不需要群聊其他上下文。管理员被 @唤醒时，服务端会检查 `lastActiveAt['work-group:admin']`，计算它与当前消息之间群聊里发生的所有消息（排除当前消息本身），作为 catch-up 上下文。

**重要：catch-up 包含事件消息**（task_started 等），让管理员知道哪些派发已经发生了，避免重复派发。

典型场景：
- 辅助模式下用户 @管理员（9:00），管理员处理完后休眠
- 之后群里用户 @编程小助手，系统派发，生成"已开始处理"事件卡片
- 用户再次 @管理员时，catch-up 包含用户消息 + 事件卡片，管理员知道编程小助手已经在处理了

**去重保证**：
1. catch-up 批次通过 `m.id !== message.id` 排除当前消息
2. 首轮（`isNew && lastActive === 0`）跳过 catch-up，群记忆已覆盖历史

**注入机制（2026-06-23 更新）**：

catch-up 和群记忆不再合并到 dispatch prompt（用户消息）中，而是通过 `contextText` 字段独立传递给 bridge。Bridge 在 `@CallStart` 时将其注入为 `<system-reminder>`，出现在用户消息**之前**。这样 agent 能清晰区分"系统给的环境背景"和"用户实际消息"。

```
gc inbox 消息结构:
{
  id, text (实际消息), contextText (群记忆/catch-up),
  gcChatId, gcIdentityRef
}
```

```
CallStart 时 context 中的消息顺序:
[system prompt]
[system: <system-reminder> 群记忆或catch-up ]   ← bridge 注入
[user: 实际消息]
```

---

## 4. 长线记忆的"视图"概念

用户描述的核心心智：

> 群聊是一个有相同话题的、完整的上下文信息的集合。agent（尤其是管理员）去消费这个东西，可以理解为一种视图——从一个超长的、不可能全塞进上下文的完整记录中提取你想要的。

实现上，这个"视图"就是 `composeGroupMemory(chat, range)` 函数（当前实现）：

```js
async function composeGroupMemory(chat, range) {
  const now = Date.now();
  const rangeMs = parseMemoryRange(range);
  const allIdentities = await collectIdentities();
  
  // 1. 按时间范围过滤（排除事件消息）
  const since = rangeMs === Infinity ? 0 : now - rangeMs;
  const recentMessages = (chat.messages || []).filter(
    (m) => (m.timestamp || 0) >= since && m.kind !== 'event'
  );
  
  // 2. 组装摘要文本
  const lines = recentMessages.map((m) => {
    const identityInfo = allIdentities.find((i) => i.identityRef === m.from);
    const from = m.from === 'user' ? '用户' : (identityInfo?.displayName || m.from);
    const time = new Date(m.timestamp).toLocaleString('zh-CN', { ... });
    const text = (m.text || '').slice(0, 200);
    return `[${time}] ${from}：${text}`;
  });
  
  return {
    name: chat.name,
    chatId: chat.id,
    summary: lines.join('\n'),
    messageCount: recentMessages.length,
  };
}
```

**注意**：2026-06-23 更新中移除了 `activeSessions`（活跃会话列表对管理员无意义）和 `goal`（群聊目标已改为 GROUP.md 文档体系）。

---

## 5. 实现状态（2026-06-23 更新）

| 维度 | 状态 | 说明 |
|------|------|------|
| Session 复用 | 已实现 | 基于上下文使用量决定续接/新建 |
| 群聊上下文预注入 | 已实现 | 新 session 时注入群记忆摘要（含群聊ID） |
| 增量消息 (catch-up) | 已实现 | 续接时自动注入，首轮跳过，含事件消息 |
| 记忆范围 | 已实现 | 可配置（1d/3d/1w/all） |
| 上下文限制 | 已实现 | 可配置（tokens 或比例） |
| agent 获取上下文方式 | 已实现 | 服务端预组装，通过 `contextText` → bridge → CallStart system-reminder 注入 |
| GROUP.md 文档体系 | 已实现 | 群聊绑定 workDir，`.agentdev/GROUP.md` 作为静态背景，通过 MemoryFeature 注入 |
| 群聊ID 注入 | 已实现 | 所有注入路径都包含 `群聊ID` 字段 |
| 上下文分离 | 已实现 | 环境背景用 `<system-reminder>` 注入，不混入用户消息 |
| 首轮 catch-up 去重 | 已实现 | `isNew && lastActive === 0` 时跳过 catch-up |

### 后续优化

1. 消息摘要质量优化（不只是截断，而是语义提取）
2. writeback 摘要：agent 回复写入群聊时自动生成精简版
3. `lastActiveAt` 跟踪的边界 case 处理（如 session 被手动删除后重置）

---

## 7. 与现有系统的关系

- **`composeDispatchPrompt()`**：每次派发时的消息原文，现在包含群聊ID。
- **`trackGroupChatDispatch()`**：不变，继续负责 running → idle 的状态跟踪。
- **GroupChatBridgeFeature (`bridge.ts`)**：已增强。新增 `contextText` 字段支持、`pendingContext` 缓冲、`@CallStart` system-reminder 注入。空闲路径下上下文不再混入用户消息。
- **GroupAdminFeature (`index.ts`)**：admin 的 `gc_*` 工具集已扩展（新增 `gc_scan_workdir`、`gc_save_group_md`），admin 的静态背景文档通过 GROUP.md（MemoryFeature）注入，动态上下文通过 bridge system-reminder 注入。
