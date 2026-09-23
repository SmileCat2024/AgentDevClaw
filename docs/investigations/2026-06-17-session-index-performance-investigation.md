# Session Index 性能问题调研报告

> **状态**：调研完成，待实施
> **日期**：2026-06-17
> **背景**：工作空间首次加载极慢、会话列表偶尔显示空、已打开会话不能秒切

---

## 1. 问题现象

用户报告了三个具体的性能问题：

1. **首次加载极慢**：打开编程小助手工作空间时，首次加载耗时数秒甚至更久
2. **偶发"无会话"空状态**：首次加载后有时显示没有会话，需要手动重新选择
3. **会话切换不秒切**：点击新对话或历史会话时加载极慢；有些会话已经打开过，切换过去仍不能即时响应

## 2. 数据现状

以编程小助手（`programming-helper`）为典型样本：

| 指标 | 数值 |
|------|------|
| Session 文件数量 | 198 个 |
| Session 文件总体积 | 447 MB |
| 单文件平均体积 | 2.3 MB |
| 最大单文件体积 | 21 MB |
| Index 条目数 | 198 条 |

Session 文件存储路径：

```
~/.agentdev/AgentDevClaw/workspaces/programming-helper/sessions/
├── index.json                                    ← Claw 维护的索引
├── session-1781139334188-f56363.json             ← 21MB，框架写入的完整快照
├── session-1781246724844-5942d9.json             ← 18MB
├── ...（共 198 个）
```

---

## 3. 数据存储分层全景

### 3.1 三层存储及其职责

| 层 | 文件 | 写入方 | 写入时机 | 内容 | 体积 |
|----|------|--------|---------|------|------|
| **写模型** | `session-xxx.json` | AgentDev 框架 (`FileSessionStore.save`) | 每次 CallFinish / step auto-save | 完整快照：messages、enrichedMessages、featureStates、usageStats、rollbackHistory | 2.3MB 平均 |
| **读模型** | `index.json` | Claw `server.js` | 仅创建/激活时 | id、title、formId、openDirectory、modelName、createdAt、updatedAt | ~100KB |
| **工作区状态** | `workspace-state.json` | Claw `server.js` | 表单提交时 | forms、openDirectory、phProjects | 小 |

### 3.2 框架侧 Session 文件结构

来源：`AgentDev/src/core/session-store.ts` + `AgentDev/src/core/agent.ts`

```typescript
// AgentDev/src/core/session-store.ts:43-52
interface AgentSessionSnapshot {
  version: number;
  sessionId: string;
  savedAt: number;
  agentType: string;
  runtime: AgentRuntimeSnapshot;  // ← 包含 messages、usageStats、featureStates
  rollbackHistory: CallRollbackSnapshot[];
  namedCheckpoints?: NamedCheckpoint[];
}
```

实际 session 文件的 JSON 结构（以 3.1MB 的文件为例）：

```
version:                    number
sessionId:                  string(28)
savedAt:                    number (timestamp ms)
agentType:                  string
runtime:
  initialized:              boolean
  callIndex:                number
  context:
    version:                number
    messages:               list[167]     ← 占据文件绝大部分体积
    enrichedMessages:       list[164]
    sequence:               number
  featureStates:            list[4]
  usageStats:
    totalUsage:             dict
    calls:                  list
    totalRequests:          number
    totalCacheHitRequests:  number
    lastRequestUsage:       dict
rollbackHistory:            list
modelName:                  string
updatedAt:                  string(ISO)
```

### 3.3 Claw 侧 Index 结构

来源：`server.js:2710` `readSessionIndex()`

每条 index 记录包含：

```json
{
  "id": "session-xxx",
  "title": "会话标题",
  "featureName": "",
  "agentName": "",
  "taskTitle": "",
  "taskType": "",
  "goal": "",
  "constraints": "",
  "expectedOutput": "",
  "targetFiles": "",
  "referenceMaterials": "",
  "formId": "",
  "openDirectory": "D:\\code\\xxx",
  "sessionType": "main",
  "metadata": {},
  "modelName": "glm-5.2",
  "contextLength": 500000,
  "createdAt": "2026-06-17T10:20:01.577Z",
  "updatedAt": "2026-06-17T10:27:53.968Z"
}
```

### 3.4 Index 缺失的字段

Session 列表 UI 需要但 index 中**没有**的字段（当前靠读取完整 session 文件提取）：

| 缺失字段 | 来源（session 文件中的路径） | 用途 |
|---------|---------------------------|------|
| `messageCount` | `runtime.context.messages.length` | 显示消息条数 |
| `preview` | `runtime.context.messages` 最后一条非 system 消息的 content | 显示会话预览文本 |
| `tokenUsage` | `runtime.usageStats.totalUsage` | 显示 token 消耗 |
| `bytes` | `fs.stat()` | 显示文件大小 |
| `exists` | `fs.stat()` 成功与否 | 标记文件是否存在 |
| `hasSummary` | `context-handoffs/` 目录中是否有对应 handoff | 标记是否有压缩摘要 |

---

## 4. 根因分析

### 4.1 核心矛盾：index.json 是"出生证"不是"档案"

**index.json 只在 session 创建时写入一次基本字段，此后框架无数次保存 session 都不会更新 index。**

Session 生命周期中 index 的更新情况：

| 生命周期事件 | 触发方 | index 是否更新 |
|-------------|--------|--------------|
| 创建 session | Claw `createPrebuiltSession` | ✅ 写入基本字段 |
| 框架保存 session（CallFinish） | `run-prebuilt-agent.js:1461` | ❌ **不更新** |
| 框架 step auto-save | 框架内部 | ❌ **不更新** |
| 激活 session | Claw `activatePrebuiltSession` | ❌ 只改 `activeSessionId` |
| 删除 session | Claw `deletePrebuiltSession` | ✅ 删除条目 |

**后果**：session 列表 UI 需要的 `messageCount`、`preview`、`tokenUsage` 等运行时元数据始终不在 index 中。Claw 被迫在每次渲染列表时读取每个 session 的完整文件来"现场体检"。

### 4.2 性能黑洞：summarizePrebuiltSession 全量读取

`server.js:3357` `summarizePrebuiltSession()` 对每个 session 执行：

```
1. readWorkspaceState(agentId)                    ← 读 workspace-state.json（有 5s 缓存）
2. fs.stat(sessionPath)                           ← 文件 stat
3. fs.readFile(sessionPath, 'utf8')               ← ★ 读取完整文件（平均 2.3MB）
4. JSON.parse(raw)                                ← ★ 解析完整 JSON
5. 提取 messageCount / preview / tokenUsage / updatedAt
```

`listPrebuiltSessions()`（`server.js:3517`）对 index 中的**所有** session 调用 `summarizePrebuiltSession()`：

```
listPrebuiltSessions('programming-helper')
  → readSessionIndex()                            读 index.json（快）
  → buildSessionSummaryMap()                      readdir + 读 handoff 文件
  → buildSessionModelInfoMap()                    读 metadata.json × 3 roles
  → Promise.all(index.sessions.map(summarize))    ← 对 198 个 session 逐个读全文件
```

**总计：每次调用读取 + 解析 447MB 的 JSON 文件。**

### 4.3 调用频率：poll 循环每 3 秒触发一次

`app-main.js:4447` `poll()` 函数中的 workspace session 刷新：

```javascript
// app-main.js:4648-4672
if (Date.now() - (window._lastWsSessionRefreshAt || 0) > 3000) {
  const wsHostAgent = allAgents.find((a) => a.id === currentAgentId && isWorkspaceHostUnit(a));
  if (wsHostAgent && loadedAgentDetailIds.has(wsHostAgent.id)) {
    // → GET /protoclaw/prebuilt_sessions?agentId=programming-helper
    // → server.js 调用 listPrebuiltSessions()
    // → 重新读取全部 198 个 session 文件（447MB）
  }
}
```

**即使用户只是在浏览 workspace 首页，服务器也每 3 秒重新读取 447MB 文件。**

### 4.4 requireAgent 的放大效应

`server.js:4698` `requireAgent()` 调用 `getAgents()`：

```javascript
// server.js:4693-4707
async function getAgents() {
  const lightAgents = await getAgentsLight();
  return Promise.all(lightAgents.map(enrichAgent));  // ← 对所有 agent 执行 enrichAgent
}

async function requireAgent(agentId) {
  const agents = await getAgents();  // ← enrich 所有 agent（含 listPrebuiltSessions）
  // ...
}
```

`enrichAgent()`（`server.js:4684`）对每个 workspace session agent 都调用 `listPrebuiltSessions()`。

**`requireAgent` 被 `activate`、`start_agent`、`delete_session` 等多个端点调用**，意味着每次 session 操作都会触发对所有 workspace session agent 的全量 enrich。

---

## 5. 三个用户可感问题的具体链路

### 5.1 首次加载极慢

```
页面加载
  → app-main.js:6996  waitForViewerReady()
  → app-main.js:6998  loadFeatureTemplateMap()
  → app-main.js:6999  loadAgents()
      → app-core.js:108   invoke('get_connected_agents')   → server.js:4912 getConnectedAgents()
      → fetch('/api/agents')                                 → ViewerWorker
      → 自动选择 home agent
      → app-core.js:25  loadAgentDetail(homeAgent.id)
          → GET /protoclaw/agent_detail?agentId=programming-helper
          → server.js:5991  enrichAgent()
              → server.js:4687  listPrebuiltSessions('programming-helper')
                  → ★ 读取 198 个 session 文件（447MB）
```

如果用户直接点击编程小助手：

```
app-main.js:1084  handlePrebuiltAgentClick('programming-helper')
  → container.innerHTML = '加载中...'
  → app-core.js:25  loadAgentDetail('programming-helper')
      → GET /protoclaw/agent_detail
      → enrichAgent → listPrebuiltSessions → ★ 读 447MB
  → selectWorkspaceSurface()
```

### 5.2 偶发"无会话"空状态

`getConnectedAgents()`（`server.js:4912`）对 prebuilt agent 返回的 `workspace_sessions` 通过 `readWorkspaceSessionSnapshot()`（`server.js:4792`）生成：

```javascript
// server.js:4792-4797
async function readWorkspaceSessionSnapshot(agentId) {
  const index = await readSessionIndex(agentId);
  return {
    activeSessionId: index.activeSessionId || null,
    sessions: [],  // ← 永远是空数组！
  };
}
```

时序：

1. `loadAgents()` 返回 prebuilt agent，`workspace_sessions.sessions = []`
2. 前端渲染 workspace surface → **显示"无会话"**
3. `loadAgentDetail()` 完成后才填充完整 sessions（但对 198 个 session 要数秒）
4. 在此期间用户看到的就是空列表

### 5.3 会话切换不秒切

点击已有会话的"打开"按钮时（`app-main.js:1278` `runWorkspaceAction` → `needsManagedSession` 分支）：

```
1. prebuiltSessionSwitchInFlight = true            ← poll 整体暂停（app-main.js:1619）
2. openPrebuiltWorkspaceSession()                  ← app-main.js:1145
   → POST /protoclaw/prebuilt_sessions/activate
     → server.js:8164  requireAgent(agentId)        ← ★ enrich 所有 agent
     → activatePrebuiltSession()                    更新 index activeSessionId
     → startManagedAgent()                          spawn 或复用 runtime
3. requestSwitch → switchAgent → loadAgentData     5 个并行 fetch 到 ViewerWorker
4. loadAgents().catch(...)                          ← 又触发 getConnectedAgents()
5. prebuiltSessionSwitchInFlight = false            ← poll 恢复
```

步骤 2 中 `requireAgent` 对所有 workspace session agent 执行 `listPrebuiltSessions`，导致 activate 请求本身就要数秒。期间 `prebuiltSessionSwitchInFlight = true` 使 poll 整体跳过，用户看不到任何反馈。

前端的 optimistic cache（`app-core.js:397` `_agentRuntimeCache`）首次切换时为空无法命中，只有第二次切换同一会话才能秒切。

---

## 6. 架构判断

### 6.1 框架侧不需要改

AgentDev 框架的 `SessionStore`（`AgentDev/src/core/session-store.ts:54-59`）是一个纯粹的 KV 持久化接口：

```typescript
interface SessionStore {
  save(sessionId, snapshot): Promise<string>;
  load(sessionId): Promise<AgentSessionSnapshot>;
  list(): Promise<string[]>;
  delete(sessionId): Promise<void>;
}
```

`FileSessionStore.save()`（`session-store.ts:66-71`）将整个内存快照序列化为单个 JSON 文件写盘。这个设计简洁正确：
- 框架的职责是 session 生命周期管理（创建、运行、保存、恢复）
- session 文件只在实际恢复时需要完整读取
- 框架不应该承担 UI 读模型的维护职责

**结论：session 文件的存储格式和写入逻辑无需修改。** 无论 JSON 还是 JSONL，一旦 index 修好，稳态列表渲染不应再读取完整 session 文件；只有旧数据回填、mtime/size 不匹配、index 缺字段或文件损坏兜底时，才允许读取单个完整 session 文件。

### 6.2 问题本质：缺少读模型维护

这是经典的 CQRS（Command Query Responsibility Segregation）问题：

```
当前架构：
  写模型 (session-xxx.json) → 每次查询时现场投影 → 读模型 (session 列表 UI)
  成本：O(N × 文件体积)，每次列表渲染读取 447MB

应该的架构：
  写模型 (session-xxx.json) ← 写入时增量更新 → 读模型 (index.json)
  列表查询只读 index.json
  成本：O(1) 单次更新 + O(N) 查询（只读 100KB index）
```

### 6.3 修复应在 Claw 侧完成

理由：
1. **Claw 拥有 session 的完整生命周期管理**——创建、激活、删除都是 Claw 管的
2. **数据在保存时已在内存中**——`run-prebuilt-agent.js:1461` 的 `callFinished` 回调运行时，agent 内存中完整保有 messages、usageStats
3. **已有 HTTP 回调通道**——runtime 子进程已有 `SERVER_ORIGIN` 环境变量（`run-prebuilt-agent.js:25`），可以向 server.js 发 HTTP 请求
4. **改框架影响面太大**——需要改 `session-store.ts` + `agent.ts`，重建 dist，所有消费方受影响

---

## 7. 修复方案

### 7.1 第一步（止血）：mtime 驱动的懒增量

修改 `summarizePrebuiltSession()`（`server.js:3357`），不再无条件读全文：

```
1. fs.stat(sessionPath) 获取 mtime + size
2. 检查 index 中该 session 是否有缓存元数据且 fileMtime/fileSize 匹配
   → 匹配：直接用 index 中的 messageCount/preview/tokenUsage
   → 不匹配：读文件提取元信息，回写 index
```

**效果**：稳态下 O(N × stat) 替代 O(N × 2.3MB)。198 个 stat 调用在毫秒级完成。

需要同步扩展 index record 的缓存字段：

| 字段 | 来源 | 用途 |
|------|------|------|
| `fileMtimeMs` | `fs.stat(sessionPath).mtimeMs` | 判断 session 文件是否变化 |
| `fileSize` | `fs.stat(sessionPath).size` | 辅助判断 session 文件是否变化 |
| `messageCount` | `runtime.context.messages.length` | 列表消息数 |
| `preview` | 最后一条非 system 消息 content | 列表预览 |
| `tokenUsage` | `runtime.usageStats.totalUsage` + `lastRequestUsage` | 列表 token 展示 |
| `savedAt` | `parsed.savedAt` 或保存回调时间 | 更新 `updatedAt` 的稳定来源 |
| `metaVersion` | Claw 自定义版本号 | 后续读模型 schema 演进 |

读取策略必须保持保守：只有 `fileMtimeMs` 与 `fileSize` 同时匹配，且上述缓存字段存在、`metaVersion` 为当前版本时，才走 index 快路径；否则回退到读取完整 session 文件并回写 index。

### 7.2 第二步（根治）：callFinished 回调增量更新 index

在 `run-prebuilt-agent.js:1461` 的 `callFinished` 回调中，`saveSession()` 之后从 agent 内存提取元信息，通过 HTTP 通知 server.js 更新 index：

```
runtime 子进程 (run-prebuilt-agent.js):
  callFinished
    → agent.saveSession(sessionId, sessionStore)
    → 从 agent.getContext().getAll() 提取:
        - messageCount = messages.length
        - preview = 最后一条非 system 消息的 content 前 140 字符
        - tokenUsage = agent runtime usageStats
    → fs.stat(sessionPath) 获取 fileMtimeMs/fileSize
    → POST {SERVER_ORIGIN}/protoclaw/session_meta_sync
        { agentId, sessionId, messageCount, preview, tokenUsage, savedAt, fileMtimeMs, fileSize, metaVersion }

server.js:
  收到 → updateSessionIndex(agentId, (index) => {
    更新对应 session 的 messageCount, preview, tokenUsage, updatedAt,
    savedAt, fileMtimeMs, fileSize, metaVersion
  })
```

实现时要注意当前 `callFinished` 监听器里 `agent.saveSession(sessionId, sessionStore)` 是异步 fire-and-forget。为了保证 `fileMtimeMs/fileSize` 对应的是刚保存后的文件，meta sync 必须串在 `saveSession()` 成功之后执行；失败时只记录 warning，不阻塞 call finish，也不影响下一次 mtime 懒回填兜底。

**效果**：index 在正常保存路径上持续更新。稳态下 `listPrebuiltSessions` 不读完整 session 文件；只有 sync 失败、旧数据迁移或外部文件变化时，才通过 7.1 的 mtime/size 兜底重新投影。

### 7.3 第三步：修 requireAgent 放大效应

修改 `requireAgent()`（`server.js:4698`），不再调用 `getAgents()`（enrich 所有 agent），改为只查单个 agent：

```javascript
// 改前
async function requireAgent(agentId) {
  const agents = await getAgents();  // ← enrich 所有 agent
  // ...
}

// 改后（方向）
async function requireAgent(agentId) {
  const lightAgents = await getAgentsLight();
  const agent = lightAgents.find(item => item.id === agentId);
  if (!agent) throw notFoundError;
  return agent;  // 不再隐式携带 workspace_sessions/workspace_data/workspace_state
}
```

这一项需要先审查所有 `requireAgent()` 调用点。当前 `requireAgent()` 返回的是 enrich 后的对象，调用方可能隐式依赖 `workspace_sessions`、`workspace_data` 或 `workspace_state`。安全落地方式是拆成两个函数：

| 函数 | 用途 |
|------|------|
| `requireAgentLight(agentId)` | 只做存在性检查和基础 metadata，供 activate/start/delete 等热路径使用 |
| `requireAgentDetail(agentId)` 或显式 `enrichAgent(await requireAgentLight(agentId))` | 仅在确实需要 workspace 详情的端点使用 |

避免直接改原函数语义导致非性能路径出现数据缺失。

### 7.4 自愈式迁移

不需要单独的迁移脚本。部署后：

```
第一次 listPrebuiltSessions()
  → index 中的 session 没有 fileMtimeMs/fileSize 字段（旧数据）
  → 触发全量读取 + 回写 index
  → 这次和现在一样慢，但之后不会了

后续框架保存 session
  → callFinished 回调 → HTTP 通知 → index 更新
  → listPrebuiltSessions 只读 index 快路径

即使 HTTP 回调偶尔失败
  → index 中 fileMtimeMs/fileSize 与当前 stat 不匹配
  → 下次 listPrebuiltSessions 自动触发一次全量读取兜底
  → 重新投影并回写 index，不会丢数据
```

自愈回写需要走现有 `writeSessionIndex()` / `_indexLocks` 路径，避免多个并发 list 请求同时发现旧数据时互相覆盖。若一次请求中多个 session 都需要回填，建议先并发读取缺失元数据，再合并成一次 index 写入，避免 198 次小写放大。

### 7.5 可选优化：getConnectedAgents 返回 session 列表

当前 `getConnectedAgents()`（`server.js:4912`）对 prebuilt agent 返回 `sessions: []`，导致首次加载显示"无会话"。可以改为使用 `buildLightPrebuiltSessionRecord()`（`server.js:3219`，只从 index 读取，不读 session 文件）填充轻量 session 列表。

---

## 8. 完整代码索引

### 8.1 服务端（server.js）

| 函数 | 行号 | 职责 |
|------|------|------|
| `readWorkspaceState` | 2040 | 读 workspace-state.json（有 `_wsCache` 5s TTL 缓存，`server.js:2038`） |
| `resolveWorkspaceData` | 2648 | 解析 workspace blocks 数据 |
| `readSessionIndex` | 2710 | 读 index.json |
| `writeSessionIndex` | 2787 | 写 index.json（有 `_indexLocks` 并发控制，`server.js:2785`） |
| `buildSessionSummaryMap` | 3193 | 读 context-handoffs 目录中所有 handoff 文件 |
| `buildLightPrebuiltSessionRecord` | 3219 | 从 index record 构建轻量 session 摘要（不读 session 文件） |
| **`summarizePrebuiltSession`** | **3357** | **★ 性能黑洞：读取完整 session 文件提取元数据** |
| **`listPrebuiltSessions`** | **3517** | **★ 对所有 session 调用 summarizePrebuiltSession** |
| `activatePrebuiltSession` | 3741 | 激活 session（只更新 activeSessionId） |
| `discoverAgents` | 4645 | 递归扫描 prebuilt-agents/ 目录（无缓存） |
| `getAgentsLight` | 4678 | discoverAgents + buildStatus |
| **`enrichAgent`** | **4684** | **调用 listPrebuiltSessions + resolveWorkspaceData + readWorkspaceState** |
| **`getAgents`** | **4693** | **getAgentsLight + Promise.all(enrichAgent)** |
| **`requireAgent`** | **4698** | **★ 调用 getAgents（enrich 所有 agent）** |
| **`getConnectedAgents`** | **4912** | **★ 无缓存，全量 I/O + HTTP round-trips** |
| `startManagedAgent` | 5136 | spawn runtime 子进程 |
| `readWorkspaceSessionSnapshot` | 4792 | 返回 `{ sessions: [] }`（永远空） |

关键端点：

| 端点 | 行号 | 说明 |
|------|------|------|
| `GET /protoclaw/get_connected_agents` | 5983 | 调用 getConnectedAgents() |
| `GET /protoclaw/agent_detail` | 5991 | 调用 enrichAgent() |
| `GET /protoclaw/prebuilt_sessions` | 6033 | 调用 listPrebuiltSessions() |
| `POST /protoclaw/prebuilt_sessions/activate` | 8164 | 调用 requireAgent() + activatePrebuiltSession() |

关键常量：

| 常量 | 行号 | 值 |
|------|------|-----|
| `WORKSPACE_SESSION_AGENT_IDS` | 54 | `['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']` |
| `isWorkspaceSessionAgent` | 772 | 判断 agentId 是否在上述集合中 |

### 8.2 前端（app-main.js）

| 函数 | 行号 | 职责 |
|------|------|------|
| 初始化入口 | 6996 | `waitForViewerReady → loadFeatureTemplateMap → loadAgents → poll`（串行） |
| `waitForPrebuiltRuntimeSession` | 745 | 轮询等待 runtime 就绪 |
| `loadAgents` | 792 | 刷新 allAgents + renderAgentList |
| `handlePrebuiltAgentClick` | 1084 | prebuilt agent 点击入口 |
| `openPrebuiltWorkspaceSession` | 1145 | POST 创建/激活 session |
| `runWorkspaceAction` | 1278 | workspace 按钮动作分发 |
| `runWorkspaceAction` needsManagedSession 分支 | 1611 | session 切换核心（`prebuiltSessionSwitchInFlight`） |
| `requestSwitch` | 3266 | 延迟切换（serial 去重）→ switchAgent |
| `switchAgent` | 3275 | agent 切换：optimistic 渲染 + PUT 并行 + loadAgentData |
| `loadAgentData` | 4214 | 加载消息/工具/hooks/overview（5 个并行 fetch） |
| `poll` | 4447 | 主轮询循环 |
| poll 中的 workspace session 刷新 | 4648 | 每 3s 调用 `/protoclaw/prebuilt_sessions` |

### 8.3 前端（app-core.js）

| 函数 | 行号 | 职责 |
|------|------|------|
| `loadAgentDetail` | 25 | GET /protoclaw/agent_detail → Object.assign 到 allAgents |
| `_agentRuntimeCache` | 397 | optimistic runtime cache（内存 Map） |
| `getRuntimeContextKey` | 418 | cache key 生成（host:xx\|session:yy 或 runtime:zz） |
| `saveCurrentRuntimeToCache` | 429 | 保存当前 runtime 状态到 cache |
| `restoreRuntimeFromCache` | 447 | 从 cache 恢复 runtime 状态 |

### 8.4 前端（app-ui.js）

| 函数 | 行号 | 职责 |
|------|------|------|
| `selectWorkspaceSurface` | 2 | 切换到 workspace surface（调 loadAgentDetail） |

### 8.5 Runtime 子进程（scripts/run-prebuilt-agent.js）

| 位置 | 行号 | 说明 |
|------|------|------|
| `SERVER_ORIGIN` | 25 | `process.env.PROTOCLAW_SERVER_ORIGIN \|\| 'http://127.0.0.1:1420'` |
| **`callFinished` session save 回调** | **1461** | **★ 修复的 hook 点：saveSession 后可提取元信息** |
| `callFinished` IM 投递回调 | 1468 | IM callfinish delivery |
| `sessionSaveFn` | 1479 | checkpoint/rollback continuation barrier |

### 8.6 框架侧（AgentDev）

| 文件 | 行号 | 内容 |
|------|------|------|
| `src/core/session-store.ts` | 54-59 | `SessionStore` 接口定义 |
| `src/core/session-store.ts` | 63-95 | `FileSessionStore` 实现（save/load/list/delete） |
| `src/core/agent.ts` | 720-723 | `saveSession()` — 生成快照 + store.save |
| `src/core/agent.ts` | 566-584 | `createSessionSnapshot()` — 组装完整快照对象 |
| `src/core/agent.ts` | 729-753 | `enableStepAutoSave()` — step 级自动保存 |

---

## 9. 不推荐的替代方案

| 方案 | 否决理由 |
|------|---------|
| 改框架 SessionStore 写 sidecar `.meta.json` | 增加文件数，框架不该关心 UI 元数据，改完要重建 dist |
| 用 SQLite 替代 index.json | 过度工程，198 条记录 JSON 读写毫秒级，增加依赖和运维成本 |
| 让框架 `save()` 返回 metadata | 接口变更影响所有消费方，且框架不知道哪些字段是 UI 需要的 |
| 只加内存缓存不改 index | 缓存丢失后（重启）仍全量读取，治标不治本 |
| session 文件改为 JSONL 格式 | session 快照不是纯 append-only 日志（featureStates、usageStats 每次替换）；修好 index 后 session 文件格式对性能无影响 |

---

## 10. 验证方法

修复完成后，可通过以下方式验证：

1. **首次加载**：打开编程小助手，观察加载时间应从数秒降至 < 1s（首次仍需一次全量读取填充 index，之后秒级）
2. **Network 面板**：`GET /protoclaw/prebuilt_sessions` 响应时间应从数秒降至 < 100ms
3. **poll 循环**：确认每 3s 的 `/protoclaw/prebuilt_sessions` 请求不再触发服务端大量文件 I/O
4. **会话切换**：点击已有会话的"打开"按钮，activate 请求响应时间应 < 500ms
5. **无会话空状态**：首次加载后 session 列表应立即显示（不经过"无会话"中间态）
6. **Index 一致性**：手动检查 `index.json` 中的 session 条目应包含 `messageCount`、`preview`、`tokenUsage`、`fileMtimeMs`、`fileSize`、`metaVersion` 等字段，且值与实际 session 文件一致
7. **回调失败兜底**：临时阻断 `/protoclaw/session_meta_sync` 或模拟请求失败后，下一次列表刷新应通过 mtime/size 不匹配自动回填 index
8. **requireAgent 回归**：覆盖 `activate`、`start_agent`、`delete_session` 以及仍需 workspace 详情的端点，确认轻量查询没有造成字段缺失
