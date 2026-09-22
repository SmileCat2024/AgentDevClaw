# 移除 current agent 语义：详细改造方案

> 创建日期：2026-08-22
> 状态：方案定稿，待实施
> 前置调查：对话调查结论已并入本文（六类职责解剖、全触点地图、可行性论证）
> 关联仓库：AgentDev（框架，主战场）+ AgentDevClaw（消费方，轻改动）

---

## 一、背景与动机

### 1.1 为什么要删

`current agent` 是单 Agent 时代的遗产概念。多 Agent 化之后它演变为一个"说不清"的影子状态，历史上反复出问题：

- **双宿主**：ViewerWorker（`viewer-worker.ts:47`）和 DebugHub（`debug-hub.ts:62`）各存一份，靠 `set-current-agent` IPC 同步，另有 `ClawDebugClient.selectAgent`（claw 传输模式）第三条写入链
- **迁移化石**：`agent.ts:643` 框架注释已承认 "currentAgentId belongs to Viewer focus and says nothing about whether this host process has a usable transport"
- **主力 UI 已事实抛弃**：Claw 前端 56 处 `currentAgentId` 全是自己的全局变量，对服务端的 PUT 是 fire-and-forget，代码注释明确写着 "loadAgentData uses explicit agentId in all fetch URLs, so it doesn't depend on the PUT completing"

### 1.2 可行性结论（已论证）

- 系统所有关键路径（输入路由、会话管理、IM、群聊分发、中断）全部显式 agentId 驱动，**current 从不参与任何正确性决策**
- 唯一功能性依赖是静态资源 projectRoot 解析——且该机制在多 projectRoot 场景下**本身就是错的**（current 指向 A 时请求 B 的模板会从 A 的项目解析文件），本方案用显式 agentId 修复它
- 每个消费点都有语义等价或更强的替代（见 §4）

### 1.3 顺带收益

为远程 Agent 访问（见 `2026-07-23-remote-agent-access.md`）扫清路由层障碍：没有 current，就没有多实例 current 错位问题，所有请求强制显式 agentId，路由规则简化为一条。

---

## 二、设计原则

1. **焦点是 UI 私有状态，住在 UI 里**。每个前端（Claw 页面、DebugHub 网页）自己持有焦点变量、自己持久化（localStorage）、自己恢复。跨 UI 不同步焦点。
2. **服务端不再有任何"当前选中"概念**。ViewerWorker 是无焦点偏见的数据中枢。
3. **请求级上下文取代全局上下文**。需要 agent 上下文的地方（静态资源解析、日志查询），由请求显式携带 agentId。
4. **MCP 契约从"隐藏默认值"改为"显式必填"**。`self`（callerAgentId）机制保留。

---

## 三、改造总览

```
删除（纯删）                          改造（有替代设计）
─────────────────────────────       ─────────────────────────────
viewer-worker:                       viewer-worker:
  currentAgentId 字段                  GET /api/agents 响应 → 删 currentAgentId，
  GET/PUT /api/agents/current          增 per-agent pendingInputCount
  /api/messages /api/tools 死端点     静态资源 5 个 handler → 支持 ?agent= query
  注册/注销/删除的 current 逻辑       GET /api/templates/feature → 强制 agentId
  handleSetCurrentAgent (IPC)         queryLogs → 删 current 兜底
  agent-switched 回执/process.send
debug-hub:                           debugger-mcp:
  currentAgentId 副本                  删 get_current_agent 工具 + debug://agents/current 资源
  selectAgent 方法                     DataSource 接口删 getCurrentAgentId
  注销 fallback / 重连恢复段           工具 agentId 参数显式化
types:                               viewer-html (DebugHub 网页):
  SetCurrentAgentMsg / AgentSwitchedMsg 焦点初始化/切换/删除跟随 → 前端自持 + localStorage
claw-debug-client:                   Claw 前端:
  selectAgent 方法                     删 PUT；sidebar fallback → localStorage；
                                       loadFeatureTemplateMap 带 agentId
```

---

## 四、分模块详细方案

### 4.1 框架 · `packages/viewer/src/viewer-worker.ts`

#### 4.1.1 删除项

| 位置 | 内容 |
|------|------|
| `:47` | `private currentAgentId: string | null = null;` |
| `:55` | debuggerMcp 构造参数中的 `getCurrentAgentId: () => this.currentAgentId` |
| `:341-346` | GET `/api/agents/current` 路由（`handleGetCurrentAgent` 整个方法随之删除，`:522-545`） |
| `:347-352` | PUT `/api/agents/current` 路由（`handleSetCurrentAgentHttp` 整个方法删除，`:547-580`，含其中的 `process.send({type:'agent-switched'})`——父进程消费方已查证为空） |
| `:474-495` | `/api/messages`、`/api/tools` 隐式兼容端点（全仓库零调用方） |
| `:969-972` | DELETE agent handler 中的 current fallback（`:979` 响应里的 `currentAgentId` 字段一并删） |
| `:1466-1467` | 注册时"恢复活跃输入请求自动切 current" |
| `:1475-1478` | 注册时"首个 Agent 自动成为当前" |
| `:1764-1774` | `handleSetCurrentAgent` 方法 + UDS case `:236-241`（含 agent-switched 回执）+ `:2611-2613` case |
| `:1785-1788` | `handleUnregisterAgent` 中的 current fallback |
| `:587` | `handleGetFeatureTemplates` 中 `|| this.currentAgentId` 兜底 |
| `:2021,2043` | `queryLogs` 中 `query.agentId || this.currentAgentId` 兜底（两处） |
| `:2082` | queryLogs 响应中的 `currentAgentId` 字段 |

#### 4.1.2 改造项

**A. `handleGetAgents`（:505-520）：响应契约变化**

```ts
// 删除 currentAgentId 字段；新增 pendingInputCount
const agents = Array.from(this.agentSessions.values()).map(session => ({
  id: session.id,
  name: session.name,
  createdAt: session.createdAt,
  messageCount: session.messages.length,
  connected: this.isSessionConnected(session),
  inputAccepted: session.inputPolicy !== 'none',
  pendingInputCount: session.inputLease ? 1 : 0,   // 新增：前端焦点恢复信号
}));
res.end(JSON.stringify({ agents }));               // 不再含 currentAgentId
```

`pendingInputCount` 的用途：替代原服务端"恢复输入请求时自动切焦点"体验——前端从列表数据看到谁有活跃输入请求，自行决定焦点（见 §7）。

**B. 静态资源 5 个 handler 支持 `?agent=` query（:2213 起的五个 handler）**

五个 handler：`handleStaticToolFile`、`handleFeatureTemplate`、`handleTemplateFile`（/template/）、`handleNpmFeatureTemplate`、`handleStaticAsset`。

统一改造模式（以 handleStaticToolFile 为例）：

```ts
// 改造前
const currentSession = this.currentAgentId ? this.agentSessions.get(this.currentAgentId) : undefined;
const projectRoot = currentSession?.projectRoot || process.cwd();

// 改造后：从 URL query 解析 agent 上下文
const agentId = this.extractAgentFromUrl(url);
const session = agentId ? this.agentSessions.get(agentId) : undefined;
const projectRoot = session?.projectRoot || process.cwd();
```

新增辅助方法：

```ts
/**
 * 从静态资源 URL 提取 agent 上下文（?agent=<agentId>）。
 * URL 由 handleGetFeatureTemplates 生成时编码，闭环保证。
 */
private extractAgentFromUrl(url: string): string | null {
  const idx = url.indexOf('?agent=');
  return idx >= 0 ? decodeURIComponent(url.substring(idx + 7)) : null;
}
```

**chunk 类共享资源的多 root 兜底**（仅 `handleStaticAsset`）：chunk 文件名为内容 hash，不同版本框架的 chunk 文件名不同，按文件名查找不会错配。查找顺序：`process.cwd()` → 遍历所有注册 agent 的 projectRoot（保持注册顺序）。

```ts
// handleStaticAsset 改造示意
const searchRoots = [process.cwd(), ...this.collectProjectRoots()];
for (const root of searchRoots) {
  const candidate = join(root, fileName);
  if (existsSync(candidate)) { /* serve */ }
}
```

**C. `handleGetFeatureTemplates`（:585-612）：URL 生成端编码 agentId**

```ts
// 改造后：agentId 变为必选；返回的 URL 携带 ?agent= 编码
const targetAgentId = searchParams?.get('agentId') || null;
if (!targetAgentId) {
  res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'agentId query parameter is required' }));
  return;
}
// ... 原有逻辑不变，URL 生成时追加编码：
const url = this.templatePathToUrl(normalizedPath, projectRoot);
if (url) {
  featureTemplateMapForFrontend[templateName] = `${url}?agent=${encodeURIComponent(targetAgentId)}`;
}
```

无 agentId 返回 400 而非静默空对象：让调用方（前端）的遗漏在开发期立刻暴露，符合"禁止静默 fallback"原则。DebugHub 网页已在调用时带 agentId（`js-state.ts:7`）；Claw 前端需同步改造（§4.6）。

**D. `queryLogs`（:2019-2109）**

- `scope: 'current'` 且无 `agentId` → 返回空结果集并在响应中标注 `error: 'agentId is required when scope is current'`（保持 200，避免打破轮询），或直接 400（推荐 400，此端点只有面板和 MCP 两个调用方，均可处理）
- 响应删除 `currentAgentId` 字段，保留 `selectedAgentId`

### 4.2 框架 · `packages/core/src/core/debug-hub.ts`

| 位置 | 操作 |
|------|------|
| `:62` | 删 `private currentAgentId: string \| null = null;` |
| `:407-409` | 删注册时"首个 Agent 自动成为当前"段 |
| `:468-484` | 删注销时 current fallback 段（含 claw 模式 `clawClient.selectAgent` 调用与 viewer-worker 模式 `set-current-agent` 推送） |
| `:490-517` | 删 `selectAgent()` 整个方法（调用方已查证：仅本文件内部两处，均随上述删除而消失） |
| `:823-830` | 删 UDS 重连时"恢复当前 Agent"段 |
| `:875-877` | 删 `agent-switched` 消息消费 case |

### 4.3 框架 · `packages/core/src/core/types.ts` + `claw-debug-client.ts`

- `types.ts:799-803`：删 `SetCurrentAgentMsg` 接口
- `types.ts:963-968`：删 `AgentSwitchedMsg` 接口
- `claw-debug-client.ts:120-126`：删 `selectAgent` 方法

**claw 传输模式（3030）边界说明**：`ClawDebugClient.selectAgent` 打到的 `PUT {runtimeUrl}/api/agents/current` 属于 ProtoClaw 生态（`AGENTDEV_DEBUG_TRANSPORT=claw` 时启用，Claw 自身用 viewer-worker 模式）。本方案只删客户端调用；3030 服务端端点成为孤儿，后续由 ProtoClaw 侧清理，不在本期范围。

### 4.4 框架 · `packages/viewer/src/debugger-mcp.ts`（MCP 契约迁移）

#### 删除

| 位置 | 内容 |
|------|------|
| `:47` | `DebuggerMCPDataSource.getCurrentAgentId(): string \| null`（接口方法） |
| `:58-60` | `get_current_agent` 工具定义 |
| `:81-82` | `debug://agents/current` 资源定义 |
| `:194-206` | `get_current_agent` 工具注册与 handler |
| `:319-333` | `current-agent` 资源注册与 handler |
| `:29-31` | `DebuggerLogQuery` 的 `currentAgentId` / `selectedAgentId` 字段中前者（selectedAgentId 保留为响应字段） |

#### 工具参数显式化

所有带 `agentId` 参数的工具（`get_agent`、`get_hooks`、`query_logs`、`diagnose` 等，`:209` 起）：

- 描述从 `Defaults to current` / `Omit for current` 改为 `Required unless "self"` 
- `'current'` 字面量解析分支删除；传 `'current'` 返回明确错误："the 'current' pseudo-id was removed; pass an explicit agentId or 'self'"
- `'self'`（callerAgentId）机制原样保留——它不依赖服务端 current

#### 迁移通告

MCP 是外部契约。消费方（Claw mcp-gateway 转发的 AI 客户端、直接连接 `:2026/mcp` 的工具）需要知晓：

1. `get_current_agent` 工具与 `debug://agents/current` 资源被移除，等价能力为 `list_agents` + 显式 `get_agent`
2. 所有工具的 `agentId` 不再有 `current` 缺省值，必须显式传 ID 或 `self`
3. 通告渠道：AgentDev 仓库 CHANGELOG + Claw 侧文档更新

#### 测试同步

`packages/viewer/test/debugger-mcp.test.ts`：

- `:142`（current 资源存在断言）、`:151-152`（读取 current 资源用例）→ 删除，替换为"current 资源返回 not found"与"工具 agentId 缺省返回引导错误"的负向用例

### 4.5 框架 · `packages/viewer/src/viewer-html/`（DebugHub 网页焦点前端化）

现状：网页焦点变量 `currentAgentId`（`js-state.ts:55`）已自持，但三个场景被服务端 current 驱动。改造为完全前端自持：

#### A. `js-agents.ts` `loadAgents()`（:2-19）

```js
// 删除服务端跟随逻辑（原 :11-15）
// if (data.currentAgentId && data.currentAgentId !== currentAgentId) { ... }

// 替换为前端焦点初始化（仅首次，焦点为空时）：
if (!currentAgentId && allAgents.length > 0) {
  currentAgentId = restoreFocus(allAgents);   // 见 §7 焦点恢复
  if (currentAgentId) {
    setFollowLatest(true);
    await loadAgentData(currentAgentId);
  }
}
renderAgentList();
renderFeaturePanel();
```

#### B. `js-agents.ts` `switchAgent()`（:56-74）

```js
window.switchAgent = async (newAgentId) => {
  if (newAgentId === currentAgentId) return;
  closeAgentContextMenu();
  currentAgentId = newAgentId;                    // 直接本地切换，不再 PUT
  persistFocus(newAgentId);                       // localStorage 记忆
  setFollowLatest(true);
  await loadAgentData(newAgentId);
  renderAgentList();
};
```

#### C. `js-agents.ts` 删除 agent 后的焦点处理（:106-120）

```js
// 原逻辑读 DELETE 响应的 data.currentAgentId 跟随，替换为：
await loadAgents();
if (contextMenuAgentId === currentAgentId /* 被删的是焦点 */) {
  currentAgentId = restoreFocus(allAgents);       // inputRequest 优先 → localStorage → 第一个
  if (currentAgentId) {
    await loadAgentData(currentAgentId);
  } else {
    /* 原有的清空态逻辑保留（:112-119） */
  }
}
```

#### D. 其余文件

`js-poll.ts`、`js-state.ts`、`js-panels.ts`、`js-logs.ts`、`js-ui-base.ts`、`js-choice-input.ts` 中的 `currentAgentId` 全部是网页自己的变量且已显式用于 URL 构造，**无需改动**。`js-state.ts:7` 的模板加载已带 `?agentId=`，配合 §4.1.2-C 的 400 契约正常工作。

### 4.6 AgentDevClaw · 前端

#### A. `public/src/app-main.js:716-728`：删除 PUT 段

```js
// 删除整段 _putPromise（fire-and-forget PUT）及 :731 的 await _putPromise;
// loadAgentData(runtimeAgentId) 保留，它本来就全显式 agentId
```

#### B. `public/src/modules/sidebar-render.js:429-438`：fallback 改造

原逻辑：`!currentAgentId` 时 home agent 优先，否则读 `data.currentAgentId` 找 runtime agent。

改造：home 优先逻辑保留；`data.currentAgentId` 分支替换为 localStorage 恢复：

```js
if (!currentAgentId) {
  // home 优先逻辑不变（:421-428）
  const remembered = localStorage.getItem('claw:lastFocusedRuntimeAgent');
  if (remembered) {
    const match = allAgents.find((agent) => (
      agent.connected !== false
      && (getAgentRuntimeId(agent) === remembered
        || normalizeAgentIdentity(agent.runtime_session_id || agent.runtimeSessionId) === normalizeAgentIdentity(remembered))
    )) || null;
    if (match) {
      currentAgentId = match.parent_id || match.id;
      await loadAgentData(getAgentRuntimeId(match));
      return;
    }
  }
}
```

写入时机：`switchAgent()` 成功后 `localStorage.setItem('claw:lastFocusedRuntimeAgent', runtimeAgentId)`（`app-main.js:439` 附近，与 `currentAgentId = agentId` 同点）。

> 注：runtime agentId 含 PID 类动态段（会话重启后变化），localStorage 命中失败是常态，自然回退到 home/列表首选。这是预期行为，不需要迁移逻辑。

#### C. `public/src/app-core.js:5-8`：模板映射加载带焦点

```js
async function loadFeatureTemplateMap() {
  // 改造：带当前焦点 runtime agentId；焦点未定时跳过（由后续焦点变化触发重载）
  const agentId = typeof currentRuntimeAgentId !== 'undefined' ? currentRuntimeAgentId : null;
  if (!agentId) return false;
  const response = await fetch('/api/templates/feature?agentId=' + encodeURIComponent(agentId));
  // ...
}
```

**时序注意**：需检查 `loadFeatureTemplateMap()` 的调用点。若存在"焦点确定前调用"的路径，需在焦点变化处（`switchAgent` / `loadAgentData`）触发一次重载。实现时以 grep 调用点为准（调研时见 `app-core.js` 顶部与消息渲染路径引用 `FEATURE_TEMPLATE_MAP`）。

#### D. `server.js:837-839`：删除 PUT 透传路由

```js
// 删除：
app.put('/api/agents/current', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});
```

#### E. `server/routes/agent-connected.js:27`：清理假依赖

```js
// 改造：catch 默认值去掉 currentAgentId 字段（从未被读取）
const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [] }));
```

### 4.7 AgentDevClaw · MCP gateway

`server/mcp-gateway/manager.js` 转发 debugger-mcp（`:31-33`），工具列表由 MCP 服务端动态注册，客户端无需改动。删除 `get_current_agent` 后 gateway 自动少一个工具，无配置残留。

---

## 五、契约变化总表（破坏性声明）

### HTTP API（ViewerWorker :2026，经 Claw :1420 代理）

| 端点 | 变化 | 破坏性 |
|------|------|--------|
| `GET /api/agents/current` | **删除** | 零调用方（已查证），无破坏 |
| `PUT /api/agents/current` | **删除** | Claw 前端 PUT 容忍 404（代码显式 `status !== 404` 才告警）；改造后无调用方 |
| `GET /api/agents` | 响应删 `currentAgentId`，增 `pendingInputCount` | 消费方两侧前端同步改造 |
| `DELETE /api/agents/:id` | 响应删 `currentAgentId` | DebugHub 网页同步改造 |
| `GET /api/messages`、`GET /api/tools` | **删除** | 零调用方 |
| `GET /api/templates/feature` | `agentId` 必填，缺省 400；返回 URL 含 `?agent=` | 两个前端均已/将带参 |
| `GET /api/logs` | `scope=current` 时 `agentId` 必填；响应删 `currentAgentId` | 面板调用已带参 |
| 静态 `/template /features /npm /tools` | 支持 `?agent=`；chunk 无参时多 root 兜底 | 向后兼容（无参回退 cwd） |

### IPC（UDS JSON 行协议）

| 消息 | 变化 |
|------|------|
| `set-current-agent` | **删除**（类型 + 两处 case + handler） |
| `agent-switched` | **删除**（类型 + 回执 + process.send + 消费 case） |

### MCP

| 项 | 变化 |
|----|------|
| `get_current_agent` 工具 | **删除** |
| `debug://agents/current` 资源 | **删除** |
| 工具 `agentId` 参数 | `'current'` 缺省/字面量移除，显式 ID 或 `self` |

---

## 六、静态资源 agentId 化：闭环设计

```
生成端                                消费端
──────                                ──────
handleGetFeatureTemplates             /template /features /npm /tools handler
  输入: ?agentId=X                      输入: URL 含 ?agent=X（由生成端编码）
  查: featureTemplateMap.get(X)         查: agentSessions.get(X).projectRoot
  出: {name: "/npm/...js?agent=X"}      解析文件路径 → serve
                                        无 ?agent= → process.cwd()（chunk 再多 root 兜底）
```

关键性质：

1. **闭环**：前端拿到的模板 URL 天然带 agent 编码，动态 import 时原样使用，无需前端理解编码
2. **修复既有 bug**：多 projectRoot 场景（编程小助手 cwd=Claw 根 + studio Test Runtime cwd=项目目录）下，原实现按 current 解析会拿错文件；现在每个请求精确路由
3. **chunk 特殊性**：chunk 文件名含内容 hash，不同版本不重名；`handleStaticAsset` 无参时按 `process.cwd() → 各 agent projectRoot` 顺序查找，同名不冲突。多版本框架共存的完全一致性作为已知边界记录，不扩大本期范围

---

## 七、焦点恢复机制（前端统一模式）

两个前端（Claw 页面、DebugHub 网页）采用同一优先级算法：

```
restoreFocus(agentList):
  1. pendingInputCount > 0 的 connected agent 优先   // 替代原"服务端恢复输入请求自动切焦点"
  2. localStorage 记忆且仍在列表中                    // 跨刷新记忆
  3. 列表第一个 connected agent                      // 兜底
  4. null（清空态）                                   // 列表为空
```

Claw 前端的 home agent 优先逻辑是产品语义（workspace 首页），在其现有分支结构中位于 `restoreFocus` 之前，保持不变。

---

## 八、实施顺序与中间态兼容性

### 顺序：框架先行（PR-1），Claw 后行（PR-2）

中间态安全性论证（框架已删、Claw 未改时）：

| Claw 旧行为 | 对新框架的请求 | 结果 |
|------------|---------------|------|
| `PUT /api/agents/current`（fire-and-forget） | 端点已删 | 404 → 前端代码显式容忍 404，仅其余状态告警，无感 |
| sidebar 读 `data.currentAgentId` | 响应无此字段 | `undefined` → 分支不生效，降级到 home/列表首选，安全 |
| `loadFeatureTemplateMap()` 无参 | 400 | 返回 false，模板映射为空 → 渲染降级为纯文本。**这是中间态唯一的体验损失**（模板渲染缺失），因此 PR-2 应紧随 PR-1，不留长间隔 |

反向兼容（Claw 新、框架旧）：`?agentId=` 参数旧框架本就支持；`?agent=` 静态参数被旧 handler 忽略（前缀匹配不受 query 影响），回退 current 解析——即 Claw 新代码在旧框架上仍工作。

### 构建与重启

- 框架侧改动 → `cd D:/code/AgentDev && npm run build`（产出全部 18 包 dist）
- **必须重启整个 Claw 服务**（框架 dist 变更高于任何消费点，见 CLAUDE.md「进程架构与重启范围」）

---

## 九、测试与回归计划

### 框架侧（AgentDev）

| 项 | 内容 |
|----|------|
| 改 | `packages/viewer/test/debugger-mcp.test.ts`：删 current 资源断言（:142,:151-152），增负向用例（current 伪 ID 报引导错误、agentId 缺省报错） |
| 增 | 静态资源 `?agent=` 解析测试：注册两个不同 projectRoot 的 agent，断言同 URL 按 agent 参数分别命中各自目录 |
| 增 | `GET /api/agents` schema 测试：无 `currentAgentId`、有 `pendingInputCount` |
| 跑 | `packages/viewer` 与 `packages/core` 全部既有测试（todo/overview/user-turn roundtrip 等不涉及 current，应全绿） |

### Claw 侧（AgentDevClaw）

| 项 | 内容 |
|----|------|
| 跑 | `npm run test:core` 全量（server-smoke 含路由注册验证，PUT 路由删除后断言需同步） |
| 改 | server-smoke 若断言了 `/api/agents/current` 路由存在，同步删除 |

### 手动回归清单（重启后）

- [ ] Claw 页面：切换 agent（编程小助手 → agent-studio），消息/工具/面板正常，模板渲染正常（含 shell 工具卡片）
- [ ] Claw 页面：刷新浏览器，焦点恢复到上次查看的 agent（localStorage）
- [ ] Claw 页面：agent 有活跃 choice input 时（`ask_user_choice`），刷新后焦点优先定位到该 agent，输入卡可见
- [ ] DebugHub 网页（:2026）：同上三项
- [ ] DebugHub 网页：删除断开的 agent，焦点按 §7 算法流转
- [ ] studio Test Runtime 在线时，DebugHub 网页切换到 Test Runtime agent，其 Feature 模板从项目目录正确加载（多 projectRoot 核心场景）
- [ ] MCP：`list_agents` 正常；`get_agent` 传显式 ID 正常；传 `'current'` 得到引导错误；`get_current_agent` 工具消失
- [ ] 日志面板：scope=current 带 agentId 正常；MCP `query_logs` scope=current 无 agentId 返回 400/引导错误

---

## 十、已知边界与后续清理

1. **ProtoClaw 3030 端点**：`ClawDebugClient.selectAgent` 删除后，3030 服务的 `PUT /api/agents/current` 成为孤儿端点，由 ProtoClaw 侧后续清理（跨仓库，不在本期）
2. **chunk 多版本一致性**：无参 chunk 查找的多 root 兜底覆盖开发态；发布态多版本框架完全一致性未专门设计，遇到再议
3. **localStorage 记忆失效**：runtime agentId 含动态段，agent 重启后记忆自然失配回退，属预期行为
4. **远程访问铺垫**：本改造完成后，`2026-07-23-remote-agent-access.md` 中的 Q4（多实例 current 语义）问题消失，路由层规则简化为"请求显式 agentId → 按命名空间路由"

---

## 十一、工作量汇总

| 模块 | 性质 | 估算 |
|------|------|------|
| viewer-worker.ts | 删 ~120 行 + 改 ~80 行（静态 agentId、agents 响应、templates 400、logs） | 中 |
| debug-hub.ts | 纯删 ~60 行 | 小 |
| types.ts + claw-debug-client.ts | 纯删 ~20 行 | 极小 |
| debugger-mcp.ts | 删工具/资源 + 参数显式化 ~150 行触及 | 中 |
| viewer-html（js-agents.ts 为主） | 改 ~60 行 + 新增 restoreFocus/persistFocus helpers | 小 |
| Claw 前端 + server | 删 ~20 行 + 改 ~30 行 | 小 |
| 测试 | 改 2 文件 + 增 2 组用例 + 手动清单 | 必要投入 |

总计约 500-600 行净变化，无新依赖，无 schema 迁移，两仓库各一个 PR。
