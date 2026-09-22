# 排查：左侧 / 工作空间会话列表排序异常

> 创建时间：2026-06-21  
> 状态：**已修复（第二轮：synthetic entry 去重遮蔽根因）**  
> 修复位置：`public/src/app-main.js` — `collectRuntimeEntriesForPrebuilt()`  
> 根因：synthetic entry 先于 child entries 添加，其 `createdAt: null` 通过去重逻辑遮蔽了同 runtimeId 的 child entry，导致最新会话排序到底部。

---

## 1. 用户描述的问题

### 原始描述（口语化）

> 整个产品的左侧列表，对于编程小助手工作空间下的那些运行中的会话，显示顺序不太符合预期。
>
> **期望行为**：每次出现新会话就出现在最上面，不断叠加，新的会话不断往前加。一旦有新的消息，对应会话也应该往前排。
>
> **实际行为**：新的会话**确实**会放到最前面（这一点是对的）。但是如果再出一个会话，那么前面创建的那个会话**不会**往下变成第二位，而是直接变成了**最后一位**。

### 提炼为可测试的规则

| 场景 | 期望 | 实际 |
|------|------|------|
| 创建 Session A（唯一会话） | [A] | [A] ✓ |
| 创建 Session B | [B, A] | [B, ..., A]，A 跳到最后 |
| 创建 Session C | [C, B, A] | [C, ..., ?, A]，B 也可能跳到最后 |

**核心症状**：排序不是稳定的"最新在前"。某些会话的排序位置会异常跳到列表底部，而不是简单地"向下移一位"。

### 用户提到的触发条件

- "一旦有新的消息" —— 暗示新消息到达时排序应该刷新，但实际可能没有正确刷新。
- "编程小助手工作空间下的那些运行中的会话" —— 可能指工作空间内部的 session 列表，也可能指左侧侧边栏的 runtime 子项。需要向用户确认。

---

## 2. 已排查的完整数据流链路

以下是从服务端数据源到前端渲染的完整链路，**每一步都标注了是否有排序、排序依据是什么**。

### 2.1 服务端：session 索引文件

**文件**：`%USERPROFILE%\.agentdev\AgentDevClaw\workspaces\programming-helper\sessions\index.json`

- 由 `createPrebuiltSession()` 写入，新 session 被 **prepend** 到 `sessions` 数组头部。
- 每个 record 的初始 `updatedAt = createdAt`。
- 后续通过 `_metaWriteback` 机制（见 2.3）更新 `updatedAt`、`savedAt` 等字段。

**结论**：index 文件中的顺序是"最新创建在前"，但这不影响最终排序——因为 `listPrebuiltSessions` 会重新排序。

### 2.2 服务端：`listPrebuiltSessions(agentId)` — 核心 API 返回

**文件**：`server.js` 第 3866–3926 行

```
listPrebuiltSessions(agentId)
  → readSessionIndex(agentId)            // 读 index.json
  → 对每个 record 调用 summarizePrebuiltSession()
  → 收集 _metaWriteback 批量回写 index    // 第 3872–3908 行
  → sessions.sort(...)                    // 第 3910–3918 行 ← 关键排序点
  → 返回 { activeSessionId, sessions, ... }
```

**排序代码（第 3910–3918 行）**：

```javascript
sessions.sort((left, right) => {
  const aUpdated = String(right.updatedAt || '');  // 注意：right 在前
  const bUpdated = String(left.updatedAt || '');
  if (aUpdated !== bUpdated) return aUpdated.localeCompare(bUpdated);
  const aCreated = String(right.createdAt || '');
  const bCreated = String(left.createdAt || '');
  if (aCreated !== bCreated) return aCreated.localeCompare(bCreated);
  return String(right.id || '').localeCompare(String(left.id || ''));
});
```

- 主键：`updatedAt` **降序**（最新在前）
- 次键：`createdAt` **降序**
- 末键：`id` **降序**
- ISO 8601 字符串用 `localeCompare` 比较，时间顺序与字典序一致。

**结论**：服务端排序逻辑本身看起来正确。

### 2.3 服务端：`summarizePrebuiltSession()` — `updatedAt` 的计算

**文件**：`server.js` 第 3416–3617 行

此函数有三条路径计算 `updatedAt`：

| 路径 | 条件 | `updatedAt` 来源 | 行号 |
|------|------|------------------|------|
| **Fast path** | index record 的 `fileMtimeMs`/`fileSize`/`metaVersion` 与文件实际一致 | `record.savedAt ? new Date(record.savedAt).toISOString() : (record.updatedAt \|\| stat.mtime.toISOString())` | 3494 |
| **Full path** | 文件有变化 | `typeof parsed?.savedAt === 'number' ? new Date(parsed.savedAt).toISOString() : (record.updatedAt \|\| stat.mtime.toISOString())` | 3548 |
| **Catch block** | 文件不存在（`fs.stat` 抛异常） | `record.updatedAt \|\| record.createdAt \|\| new Date().toISOString()` | 3605 |

**`savedAt` 的来源**：由 agent runtime 调用 `agent.saveSession()` 写入 session 文件，值为 `Date.now()`（epoch ms）。见 `AgentDev/src/core/agent.ts` 第 581 行。

**`_metaWriteback` 机制**（第 3872–3908 行）：

Full path 会附着一个非可枚举的 `_metaWriteback` 对象（第 3566–3583 行），`listPrebuiltSessions` 收集所有 writeback 后批量回写 index：

```javascript
// writeback 收集
writebacks.push({ id: s.id, updatedAt: s.updatedAt, ...s._metaWriteback });

// writeback 回写
sessionMap.set(wb.id, {
  ...existing,
  fileMtimeMs: wb.fileMtimeMs,
  fileSize: wb.fileSize,
  messageCount: wb.messageCount,
  preview: wb.preview,
  tokenUsage: wb.tokenUsage,
  savedAt: wb.savedAt,       // ← 可能为 null
  metaVersion: wb.metaVersion,
  updatedAt: wb.updatedAt,   // ← 用 summarizePrebuiltSession 的结果覆盖
});
```

**关键注意点**：
- 如果 session 文件没有 `savedAt` 字段（runtime 未保存过），`_metaWriteback.savedAt = null`。
- Fast path 中 `record.savedAt` 为 `null` 时会 fallthrough 到 `record.updatedAt`。
- writeback 回写使用 `sessionMap`，不改变 index 中的数组顺序（Map 保持插入序，`set` 已有 key 不改变位置）。

### 2.4 服务端：`createPrebuiltSession()` — 创建新 session

**文件**：`server.js` 第 3937–4127 行

```javascript
const record = {
  // ...
  createdAt,              // new Date().toISOString()
  updatedAt: createdAt,   // ← 初始等于 createdAt
};
const nextIndex = await updateSessionIndex(agentId, (index) => {
  return {
    activeSessionId: sessionId,
    sessions: [record, ...index.sessions.filter((session) => session.id !== sessionId)],
    //           ↑ prepend 到数组头部
  };
});
```

- `returnSummary === false`（POST 路径）时返回 `buildLightPrebuiltSessionRecord(agentId, record)`。
- `buildLightPrebuiltSessionRecord` 中 `updatedAt: record.updatedAt || record.createdAt || new Date().toISOString()`。

### 2.5 服务端：`POST /protoclaw/prebuilt_sessions` — 创建 + 启动 runtime

**文件**：`server.js` 第 9000–9017 行

```javascript
app.post('/protoclaw/prebuilt_sessions', express.json(), async (req, res, next) => {
  const agent = await requireAgentLight(req.body.agentId);
  const session = await createPrebuiltSession(agent.id, { returnSummary: false, ... });
  const status = await startManagedAgent(agent, session.id);  // ← 注意：创建后立即启动 runtime
  res.json({ session, status, agent: null });
});
```

**重要**：创建 session 后**立即启动 runtime**。

### 2.6 服务端：`startManagedAgent()` — runtime 生命周期

**文件**：`server.js` 第 5553–5700 行

对于 programming-helper（非 qqbot）：
- `getAgentRuntime(agent.id, requestedSessionId)` 查找 `managedAgents` Map 中 key = `programming-helper::session-X`。
- 如果是新 session，key 不存在，`existing = null`。
- **不会停止旧 session 的 runtime**（只有 qqbot 有停止 sibling 的逻辑，第 5566–5576 行）。
- 新 runtime 进程 spawn，通过 UDS 连接 ViewerWorker。

**结论**：programming-helper 支持多个并发 runtime（每个 session 一个），创建新 session 不会停止旧 session 的 runtime。

### 2.7 服务端：`getConnectedAgents()` — 侧边栏数据源

**文件**：`server.js` 第 5329–5490 行

```
getConnectedAgents()
  → prebuiltAgents.map(...) push 到 connectedAgents（source: 'prebuilt'）
  → runtimeAgents (from viewer /api/agents) 遍历：
      → 如果匹配 managedRuntimeByViewerId → push 为 source: 'child', parent_id: agentId
      → 否则如果匹配 prebuilt → 原地更新 prebuilt entry
      → 否则 push 为 source: 'external' 或 'child'
```

**侧边栏子项的顺序 = viewer `/api/agents` 返回的 runtimeAgents 顺序**。

### 2.8 ViewerWorker：`/api/agents` — agent 列表顺序

**文件**：`AgentDev/src/core/viewer-worker.ts` 第 494–508 行

```typescript
private handleGetAgents(req: IncomingMessage, res: ServerResponse): void {
  const agents = Array.from(this.agentSessions.values()).map(session => ({...}));
  // ← 没有 sort！直接返回 Map 的 values()
```

**Map 的迭代顺序 = 插入顺序**（JavaScript 规范）。

**Agent 注册顺序**：`getOrCreateSession()`（第 1250–1273 行）：
- 新 agentId → `agentSessions.set(agentId, session)` → 追加到 Map 末尾。
- 已有 agentId → 返回已有 session，不改变 Map 位置。

**Agent 注销**：`handleUnregisterAgent()`（第 1600–1611 行）：
- `agentSessions.delete(agentId)` → 从 Map 中删除。
- 如果之后重新注册 → 追加到 Map **末尾**。

**viewer agent ID 生成**：`AgentDev/src/core/debug-hub.ts` 第 343 行：
```typescript
const id = `agent-${this.nextId++}-${this.processId}`;
```
每个 runtime 进程有独立 PID，因此每个 session 的 viewer agent ID 唯一。

### 2.9 前端：`loadAgents()` — 构建 `allAgents`

**文件**：`public/src/app-main.js` 第 798–870 行

```
loadAgents()
  → Promise.all([invoke('get_connected_agents'), fetch('/api/agents')])
  → connectedAgents = getConnectedAgents() 结果
  → runtimeAgents = /api/agents 结果
  → allAgents = connectedAgents.map(...) // 保持 connectedAgents 顺序
```

- `connectedAgents.length > 0` 时，`allAgents` 完全来自 `connectedAgents` 的顺序。
- 对于已加载详情的 agent（`loadedAgentDetailIds`），保留旧的 `workspace_sessions`，只更新 `activeSessionId`。

### 2.10 前端：侧边栏渲染链路（runtime 子项）

**文件**：`public/src/app-main.js`

```
renderAgentList()                          // 第 1038 行
  → groupConnectedAgents(allAgents)        // 第 85–106 行 ← 不排序，只分组过滤
  → renderAgentGroup(list, ..., agents)    // 第 683–755 行 ← 不排序
      → collectRuntimeEntriesForPrebuilt(agent, allAgents)  // 第 153–171 行 ← 不排序
          → filter allAgents by parent_id === prebuiltAgent.id
          → forEach addEntry(buildChildRuntimeEntry(agent))
      → renderSidebarChildItems(entries)   // 第 622–658 行 ← 不排序，直接 map
```

**整个侧边栏子项渲染链路：零排序。** 顺序完全由 `allAgents` 的原始顺序决定，而 `allAgents` 的顺序来自 `getConnectedAgents()`，最终取决于 ViewerWorker Map 的插入顺序。

**这意味着侧边栏 runtime 子项的顺序 = agent 注册到 ViewerWorker 的先后顺序（最早注册在前）**。

### 2.11 前端：工作空间 session 列表渲染链路（workspace 内部）

**文件**：`public/src/modules/session-ui.js` + `public/src/app-ui.js`

```
renderWorkspaceSessionList(agent)                    // session-ui.js 第 ~580 行
  → getProgrammingHelperProjects(agent)              // app-ui.js 第 838–893 行
      → getWorkspaceSessions(agent)                  // session-ui.js 第 23–25 行
          → agent.workspace_sessions.sessions
      → 按 openDirectory 分组到 projects
      → 每个 project 的 sessions.sort(compareByRecency)    // 第 887 行 ← 排序点 1
      → projects.sort(compareByRecency)                     // 第 892 行
  → sortPhSessionsByMode(mainSessions)                     // 第 646 行 ← 排序点 2
  → 渲染 HTML
```

**排序点 1** — `compareByRecency()`（app-ui.js 第 599–607 行）：
```javascript
function compareByRecency(a, b) {
  const aUpdated = String(a?.updatedAt || '');
  const bUpdated = String(b?.updatedAt || '');
  if (aUpdated !== bUpdated) return bUpdated.localeCompare(aUpdated); // updatedAt 降序
  const aCreated = String(a?.createdAt || '');
  const bCreated = String(b?.createdAt || '');
  if (aCreated !== bCreated) return bCreated.localeCompare(aCreated); // createdAt 降序
  return String(b?.id || '').localeCompare(String(a?.id || ''));       // id 降序
}
```

**排序点 2** — `sortPhSessionsByMode()`（session-ui.js 第 31–46 行）：
```javascript
function sortPhSessionsByMode(sessions) {
  var mode = phSessionSortMode === 'createdAt' ? 'createdAt' : 'updatedAt';
  var sorted = sessions.slice();
  sorted.sort(function (a, b) {
    var primary = String(a?.[mode] || '');
    if (primary !== String(b?.[mode] || '')) {
      return String(b?.[mode] || '').localeCompare(primary);  // updatedAt 降序
    }
    var aSec = String(a?.[secondaryKey] || '');
    if (aSec !== String(b?.[secondaryKey] || '')) return bSec.localeCompare(aSec);
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  });
  return sorted;
}
```

**注意**：`phSessionSortMode` 默认为 `'updatedAt'`（app-core.js 第 394 行），用户可切换为 `'createdAt'`。

**结论**：两个排序点使用相同的比较逻辑（updatedAt 降序），应该产生一致的结果。

### 2.12 前端：poll 循环中的 session 刷新

**文件**：`public/src/app-main.js` 第 4829–4853 行

```javascript
// 仅在 !currentRuntimeAgentId 时执行（workspace surface 模式）
if (Date.now() - (window._lastWsSessionRefreshAt || 0) > 3000) {
  const wsHostAgent = allAgents.find((a) => a.id === currentAgentId && isWorkspaceHostUnit(a));
  if (wsHostAgent && loadedAgentDetailIds.has(wsHostAgent.id)) {
    const freshRes = await fetch('/protoclaw/prebuilt_sessions?agentId=' + encodeURIComponent(wsHostAgent.id));
    if (freshRes.ok) {
      const freshSessions = await freshRes.json();
      const prevSig = JSON.stringify(wsHostAgent.workspace_sessions || {});
      const nextSig = JSON.stringify(freshSessions);
      if (prevSig !== nextSig) {
        wsHostAgent.workspace_sessions = freshSessions;  // ← 直接替换
        if (shouldRenderWorkspaceSurface(wsHostAgent)) {
          renderCurrentMainView();  // ← 触发重渲染
        }
      }
    }
  }
}
```

- 每 3 秒刷新一次 session 数据。
- `freshSessions` 来自 `listPrebuiltSessions()`，已经按 `updatedAt` 降序排好。
- 替换 `wsHostAgent.workspace_sessions` 后触发 `renderCurrentMainView()`。

**注意**：仅在 workspace surface 模式（`!currentRuntimeAgentId`）刷新。在 chat 模式（有活跃 runtime）时不刷新 session 列表。

### 2.13 前端：乐观更新（session 创建后）

**文件**：`public/src/app-main.js` 第 1189–1210 行

```javascript
function applyOptimisticWorkspaceSession(agentId, session) {
  const existingSessions = hostAgent?.workspace_sessions?.sessions || [];
  const nextSessions = [session, ...existingSessions.filter((item) => item?.id !== session.id)];
  //                    ↑ 新 session prepend 到头部
  return updateAgentRecord(agentId, {
    workspace_sessions: { ..., sessions: nextSessions },
  });
}
```

- 乐观更新后立即 `renderCurrentMainView()`（第 1813 行）。
- 但后续 `sortPhSessionsByMode` 会重新排序，所以 prepend 的位置只是临时的。

---

## 3. 实际 session 索引数据样本

从用户机器上读取的实际 index.json 数据（`workspaces/programming-helper/sessions/index.json`）：

| # | session ID（后缀） | title | createdAt | updatedAt | savedAt (epoch ms) |
|---|---------------------|-------|-----------|-----------|---------------------|
| 1 | d91a43 | 左侧会话列表排序逻辑异常排查 | 10:17:50.105 | 10:35:28.562 | 1782038128562 |
| 2 | d83425 | 工作群聊系统下阶段功能落实 | 10:15:45.729 | 10:35:28.459 | 1782038128459 |
| 3 | 8af633 | 实现输入框上方的对话间隔时间显示 | 10:00:10.882 | 10:24:46.479 | 1782037307473 |
| 4 | 9daabf | 历史会话搜索功能开发与优化 | 08:32:44.309 | 10:01:41.544 | 1782036101544 |
| 5 | 01cb74 | 群聊代理调度闭环系统设计 | 05:49:12.432 | ... | ... |

**观察**：`updatedAt` 值看起来是正确的（最近的 session 有最新的 updatedAt）。按 updatedAt 降序排应该是 [1, 2, 3, 4, 5]，与 index 文件中的顺序一致。

**但这可能是在"稳定状态"下读取的数据**。问题可能出现在"创建新 session 时的过渡态"。

---

## 4. 当前疑点（未验证的假设）

### 疑点 A：`updatedAt` 在写入回写（writeback）时被错误覆盖

`listPrebuiltSessions` 中的 writeback 逻辑（第 3872–3908 行）会更新 index record 的 `updatedAt`。

**假设**：如果 writeback 使用了过时的 `savedAt`（如 `null`）或错误的 `updatedAt` 值，可能导致排序异常。

**需要验证**：在创建新 session 后立即查看 index.json，检查旧 session 的 `updatedAt` 是否被修改。

### 疑点 B：session 文件 `savedAt` 为 0 或异常值

如果 session 文件的 `savedAt` 字段为 `0`（epoch 起始），`new Date(0).toISOString()` = `"1970-01-01T00:00:00.000Z"`，会导致该 session 排到最后。

**需要验证**：检查所有 session 文件的 `savedAt` 值是否都是合理的 epoch ms。

### 疑点 C：writeback 回写导致 index 中的 record 顺序被打乱

虽然分析认为 `sessionMap` 不改变顺序，但 **存在并发写竞态**：`listPrebuiltSessions` 中的 writeback 是 `.catch(() => {})`（fire-and-forget，第 3907 行），如果 `createPrebuiltSession` 的 `updateSessionIndex` 和 `listPrebuiltSessions` 的 writeback `updateSessionIndex` **同时执行**，由于 `_indexLocks` 是串行的，不会真正并发，但可能导致 writeback 基于过时的 index 数据操作。

**具体场景**：
1. `listPrebuiltSessions` 开始，读取 index → [A, B, C]
2. 对 A, B, C 计算 writeback
3. 同时 `createPrebuiltSession` 创建 D → index 变为 [D, A, B, C]
4. writeback 的 `updateSessionIndex` 被排队
5. writeback 读取最新 index → [D, A, B, C]
6. 创建 sessionMap from [D, A, B, C]
7. 更新 A, B, C（D 不在 writebacks 中，不被更新）
8. 返回 [D, A, B, C]（顺序应该保持）

**这个分析看起来安全，但实际行为需要验证。**

### 疑点 D：前端 `workspace_sessions` 被乐观更新后，poll 刷新前渲染了旧数据

1. 用户创建 session B
2. `applyOptimisticWorkspaceSession` prepend B → `nextSessions = [B, A]`
3. `renderCurrentMainView()` 渲染 → 列表显示 [B, A]（B 在顶部）
4. `loadAgents()` 异步执行 → 从 `getConnectedAgents()` 获取数据
5. `loadAgents()` 中，对已加载详情的 agent，保留旧 `workspace_sessions`，只更新 `activeSessionId`
6. **问题**：`loadAgents()` 可能不会刷新 `workspace_sessions.sessions`！
7. 只有 3 秒后的 poll 刷新（第 4829 行）才会获取最新 session 列表

**如果 `loadAgents()` 不刷新 sessions**，那么 `applyOptimisticWorkspaceSession` 的 `nextSessions` 就是唯一的数据来源。而 `nextSessions` 的构造方式是 `[session, ...existingSessions.filter(item => item.id !== session.id)]`。

**这里 `existingSessions` 来自 `hostAgent.workspace_sessions.sessions`**。如果这个数组之前已经被 `getProgrammingHelperProjects` 中的 `project.sessions.sort(compareByRecency)` **原地排序**过（第 887 行的 `.sort()` 会 mutate 数组），那么 `existingSessions` 的顺序可能不是原始的 API 返回顺序。

但这应该不影响——因为 `renderWorkspaceSessionList` 会再次用 `sortPhSessionsByMode` 排序。

### 疑点 E（高优先级）：`getConnectedAgents()` 返回的 `workspace_sessions` 缺少完整的 session 数据

`getConnectedAgents()` 中，每个 prebuilt agent 的 `workspace_sessions` 来自 `readActiveWorkspaceSessionMeta(agent)`：

```javascript
const { workspaceSessions, sessionMeta } = await readActiveWorkspaceSessionMeta(agent);
```

`readActiveWorkspaceSessionMeta` 调用 `readWorkspaceSessionSnapshot`，后者用 `buildLightPrebuiltSessionRecord` 构建轻量 session 记录。

**但**，在 `loadAgents()` 中（第 840–853 行），对已加载详情的 agent：

```javascript
...(prev && loadedAgentDetailIds.has(agent.id) ? {
  workspace_data: prev.workspace_data,
  workspace_state: prev.workspace_state,
  workspace_sessions: {
    ...(prev.workspace_sessions || {}),
    // 只更新 activeSessionId，sessions 数组保留旧的
    ...(agent.workspace_sessions?.activeSessionId
      && agent.workspace_sessions.activeSessionId !== prev.workspace_sessions?.activeSessionId
      ? { activeSessionId: agent.workspace_sessions.activeSessionId }
      : {}),
  },
} : {}),
```

**这意味着 `loadAgents()` 不会刷新 `sessions` 数组**——它保留了之前由 `loadAgentDetail` 或 poll 刷新获取的 sessions。

**只有在 poll 循环中（第 4829 行）或 `loadAgentDetail` 中才会完整刷新 sessions。**

### 疑点 F（最高优先级）：用户可能指的是"左侧侧边栏"而非"工作空间 session 列表"

如果用户说的是**侧边栏 runtime 子项**（左侧面板中 programming-helper 下面展开的运行时会话列表），那么：

- 这个列表**完全没有排序**（见 2.10 节分析）。
- 顺序完全取决于 ViewerWorker Map 的插入顺序。
- **最早注册的 runtime 在顶部**。
- 如果 runtime 被停止后重启（如切换 session 再切回来），该 runtime 会重新注册到 Map 末尾。

**这个路径最可能导致用户描述的"跳到最后一位"现象**，因为：
1. Session A 的 runtime 最先注册 → Map 顶部
2. Session B 的 runtime 注册 → Map 中间
3. 用户切换到 Session A（或 Session A 的 runtime 因某种原因重启） → A 注销后重新注册 → Map 末尾
4. 侧边栏显示：A 在最后

**但这需要向用户确认**：是侧边栏的 runtime 子项顺序问题，还是工作空间内部的 session 列表顺序问题。

---

## 5. 关键代码文件索引

### 服务端（server.js）

| 功能 | 函数/位置 | 行号 |
|------|-----------|------|
| Session 列表 API | `listPrebuiltSessions()` | 3866–3926 |
| Session 摘要（含 updatedAt 计算） | `summarizePrebuiltSession()` | 3416–3617 |
| 轻量 session record | `buildLightPrebuiltSessionRecord()` | 3272–3304 |
| 创建 session | `createPrebuiltSession()` | 3937–4127 |
| 激活 session | `activatePrebuiltSession()` | 4129–4190 |
| 连接 agent 列表（侧边栏数据源） | `getConnectedAgents()` | 5329–5490 |
| 启动 managed runtime | `startManagedAgent()` | 5553–5700 |
| Runtime key 管理 | `getManagedRuntimeKey()` | 708–712 |
| 查找 runtime | `getAgentRuntime()` / `pickPrimaryAgentRuntime()` | 731–736 / 723–729 |
| Session 索引读写 | `readSessionIndex()` / `updateSessionIndex()` | 2762–2801 / 2861–2876 |
| POST 创建 session | route handler | 9000–9017 |
| GET session 列表 | route handler | 7237–7247 |
| POST 激活 session | route handler | 9718–9731 |
| Runtime 显示名 | `resolveRuntimeDisplayName()` | 5181–5207 |

### 前端（app-main.js）

| 功能 | 函数/位置 | 行号 |
|------|-----------|------|
| 侧边栏子项收集 | `collectRuntimeEntriesForPrebuilt()` | 153–171 |
| Synthetic runtime entry | `buildSyntheticRuntimeEntry()` | 113–130 |
| Child runtime entry | `buildChildRuntimeEntry()` | 132–151 |
| 侧边栏子项渲染 | `renderSidebarChildItems()` | 622–658 |
| Agent 分组 | `groupConnectedAgents()` | 85–106 |
| Agent 组渲染 | `renderAgentGroup()` | 683–755 |
| Agent 列表渲染入口 | `renderAgentList()` | 1038–1052 |
| 加载 agents | `loadAgents()` | 798–870 |
| Poll 循环 | `poll()` | 4811–4860 |
| Session 列表刷新（poll 内） | poll 第 4829–4853 行 | 4829–4853 |
| 创建 session 请求 | `openPrebuiltWorkspaceSession()` | 1163–1187 |
| 乐观更新 session | `applyOptimisticWorkspaceSession()` | 1189–1210 |
| runWorkspaceAction（create_session 分支） | 第 1770–1870 行 | 1770–1870 |

### 前端（app-ui.js）

| 功能 | 函数/位置 | 行号 |
|------|-----------|------|
| 排序比较器 | `compareByRecency()` | 599–607 |
| PH 项目列表 | `getProgrammingHelperProjects()` | 838–893 |
| 更新 agent record | `updateAgentRecord()` | 1045–1053 |

### 前端（session-ui.js）

| 功能 | 函数/位置 | 行号 |
|------|-----------|------|
| 获取 workspace sessions | `getWorkspaceSessions()` | 23–25 |
| PH session 排序 | `sortPhSessionsByMode()` | 31–46 |
| 工作空间 session 列表渲染 | `renderWorkspaceSessionList()` | ~580–760 |
| PH session item 渲染 | `renderPhSessionItem()` | 656–711 |

### 前端（app-core.js）

| 功能 | 位置 | 行号 |
|------|------|------|
| `phSessionSortMode` 全局变量 | | 394 |
| `allAgents` 全局变量 | | 253 |

### ViewerWorker（AgentDev/src/core/viewer-worker.ts）

| 功能 | 函数/位置 | 行号 |
|------|-----------|------|
| `/api/agents` HTTP handler | `handleGetAgents()` | 494–508 |
| Agent 列表（debugger MCP） | `listAgentSummaries()` | 1785–1789 |
| Agent 注册 | `handleRegisterAgent()` | 1315–1369 |
| Agent 注销 | `handleUnregisterAgent()` | 1600–1611 |
| 获取/创建 session | `getOrCreateSession()` | 1250–1273 |
| UDS 断线处理 | 第 193–199 行 | 193–199 |
| 是否已连接 | `isSessionConnected()` | 1285–1287 |

### DebugHub（AgentDev/src/core/debug-hub.ts）

| 功能 | 函数/位置 | 行号 |
|------|-----------|------|
| 注册 agent（生成 agentId） | `registerAgent()` | 327–393 |
| 注销 agent | `unregisterAgent()` | 399–410 |
| Agent ID 生成 | 第 343 行 | 343 |

### Agent（AgentDev/src/core/agent.ts）

| 功能 | 函数/位置 | 行号 |
|------|-----------|------|
| 连接 Viewer | `withViewer()` | 491–546 |
| 创建 session 快照（含 savedAt） | `createSessionSnapshot()` | 574–593 |
| 保存 session | `saveSession()` | 728+ |
| 销毁（含 unregister） | `dispose()` | 912–952 |

### Runtime 脚本（scripts/run-prebuilt-agent.js）

| 功能 | 行号 |
|------|------|
| 进程启动入口 `main()` | 1415 |
| 连接 ViewerWorker | 1479–1485 |
| SIGTERM/SIGINT 处理 | 858–864 |
| dispose（含 unregister） | 831–856 |

---

## 6. 下一步建议

### 第一步（必做）：向用户确认问题位置

用 `ask_user_choice` 确认用户说的是：

1. **左侧侧边栏**中 programming-helper 下面展开的 runtime 子项列表
2. **工作空间内部**的 session 列表（有 main/archived/exploration/sub 分页的那个）
3. 两者都有问题

这决定了排查方向完全不同。

### 第二步（如果确认是侧边栏 runtime 子项）：

**根因几乎确定**：侧边栏 runtime 子项**完全没有排序**，顺序是 ViewerWorker Map 的插入顺序。当 runtime 重启（注销后重新注册）时，会移动到 Map 末尾。

**修复方向**：在 `collectRuntimeEntriesForPrebuilt()`（app-main.js 第 153–171 行）中对收集到的 entries 按 `createdAt` 或 `startedAt` 降序排序。但 entries 本身不携带时间信息——需要在 `buildChildRuntimeEntry()`（第 132–151 行）中从 `allAgents` 的 agent 数据中提取 `created_at` 字段并加入 entry。

### 第三步（如果确认是工作空间 session 列表）：

需要在创建新 session 的瞬间观察 `updatedAt` 值的变化：

1. 在 `listPrebuiltSessions()` 的 sort 前后加临时日志，打印每个 session 的 `updatedAt`。
2. 在创建新 session 前后查看 index.json 中其他 session 的 `updatedAt` 是否被修改。
3. 特别检查 `_metaWriteback` 逻辑是否会将 `savedAt: null` 写入 record，导致下次 fast path 中 `updatedAt` 回退到旧值。

### 第四步（如果确认是过渡态问题）：

检查 `applyOptimisticWorkspaceSession` 后到 poll 刷新之间的渲染：

1. 乐观更新后的 `nextSessions` 中，旧 session 的 `updatedAt` 值是否正确。
2. `getProgrammingHelperProjects` 中的 `project.sessions.sort(compareByRecency)` 是否因为原地排序导致数据被意外修改。

---

## 7. 补充信息

### `managedAgents` 数据结构

- 类型：`Map<string, RuntimeEntry>`
- Key：`${agentId}::${sessionId}`（如 `programming-helper::session-1782037070105-d91a43`）
- 每个唯一 (agentId, sessionId) 对应一个独立 runtime 进程
- programming-helper 支持多个并发 runtime（创建新 session 不停止旧 runtime）
- 只有 qqbot 有"停止 sibling runtime"的逻辑（第 5566–5576 行）

### ViewerWorker session 生命周期

```
runtime 进程启动
  → UDS connect → clientId 分配
  → handleRegisterAgent → getOrCreateSession
      → 如果 agentId 已存在 → 返回已有 session（Map 位置不变）
      → 如果 agentId 不存在 → 创建新 session，追加到 Map 末尾

runtime 进程退出（SIGTERM → disposeAgent）
  → agent.dispose() → debugHub.unregisterAgent
      → clawClient.unregisterAgent 或 sendToWorker({ type: 'unregister-agent' })
      → handleUnregisterAgent → agentSessions.delete(agentId)
  → UDS socket close → udsClients.delete(clientId)

runtime 进程重启
  → 同"启动"流程 → 新 session 追加到 Map 末尾（旧位置已删除）
```

### 两个不同的"列表"总结

| | 侧边栏 runtime 子项 | 工作空间 session 列表 |
|---|---|---|
| 渲染文件 | app-main.js `renderSidebarChildItems` | session-ui.js `renderWorkspaceSessionList` |
| 数据来源 | `getConnectedAgents()` → viewer Map | `listPrebuiltSessions()` → session index |
| 排序 | `createdAt` 降序（已修复） | `updatedAt` 降序（三处排序点） |
| 刷新频率 | 每次 `loadAgents()` / `poll()` | poll 中每 3 秒（仅 workspace surface 模式） |
| 显示什么 | 运行中的 runtime（已连接 ViewerWorker） | 所有 session（含未运行的） |
