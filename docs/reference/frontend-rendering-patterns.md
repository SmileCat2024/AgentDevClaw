# Claw 前端渲染机制与常见陷阱

> **活文档** — 本文持续积累前端渲染相关的设计契约与踩坑记录。
> 每次遇到渲染层的新问题或提炼出新结论时，请更新对应章节，或在文末追加新章节。
> 保持每个条目简短、有代码示例、有判断依据，便于后续 agent 直接复用。
>
> 最后更新：2026-10-26（会话重启与接续身份：完整 wire 投影、来源锚定、冷缓存占位与单叶子呈现）


---

## 对话欢迎态

欢迎语从当前 Session 的 `workspaceAgentId` 解析工作空间 `agents[].displayName`，解析逻辑在 `modules/workspace-agents.js`。工作空间名、Agent 名与会话标题分别独立；宿主 `activeSessionId` 不是当前视图的身份来源。绑定尚未加载时显示通用“新对话”，详情提交后重绘空态。声明契约见 [workspace-agents.md](../protocols/workspace-agents.md)。

欢迎/加载态的聊天容器取消消息列表底部留白与 `55vh` 最小高度，使用 composer 上方的剩余空间；composer 此时在主内容列中占据固定尺寸，仍位于聊天容器外。有消息后恢复悬浮输入框和消息列表滚动。两种排版共用输入槽位的 `--composer-bottom`（50px）底部基线；切换显示过程只更换上方内容，不改变输入卡坐标。不要仅隐藏滚动条而保留超高布局。浏览器验证入口为 `test/welcome-browser-check.mjs`。

## 编程小助手：目录与项目导航

- 保留工作空间主视图，左侧目录选择器确定工作位置，右侧归属选择器显示“默认（目录对话）”及该目录的项目。目录菜单可展开二级归属，一次进入目录与项目；点击目录本体进入默认集合。项目按绑定目录导航但以独立 ID 寻址，不能把路径或名称当项目身份。
- 两个选择器共同消费 `project-data.js` 的带类型浏览目标，不维护平行选中状态。切换视图只改变浏览归属，不转移已有 Session；新建对话显式传项目 ID，默认目录路径不推测项目。项目绑定目录（含托管目录）可投影为导航条目，但不因此写入旧目录 workspace state 或混入默认集合的会话。
- 新建项目默认当前目录；选择其他目录或托管目录时明确表达，成功后两个选择器按绑定事实同步。空项目可见，创建不自动建立会话。
- “移动到”是独立写操作：仅同目录、空闲且无排队输入的 Session 可转移，成功后刷新列表、搜索、恢复卡片与运行实例投影。后续配置由目标归属重建，不能仅改 DOM 分组或保留旧实例。批量选择绑定当前切片身份，导航或切片变化后不得携带旧选择。

## 1. 核心原则：渲染函数必须是纯函数

所有 `render*` 函数（`renderCurrentMainView`、`renderWorkspaceSurface`、`renderWorkspaceBlock`、`renderIMWorkspaceConfigEditor` 等）**不得产生副作用**。

具体而言，渲染函数内部**禁止**：

| 禁止的操作 | 原因 |
|---|---|
| 发起网络请求（fetch / refresh） | 请求耗时不确定，渲染函数可能在短时间内被调用数十次 |
| 设置"加载中"全局标志（如 `_refreshPromise`） | 标志会被后续同步代码读取，产生自致 loading 状态 |
| 直接修改业务 state（`imWorkspaceState`、`_dispatchSchedules` 等） | 破坏渲染幂等性，导致去重失效或状态不一致 |
| 调用 `renderCurrentMainView()` | 产生嵌套渲染，可能导致无限递归或去重混乱 |

**数据加载应在专门的 `ensure*Loaded` 函数或交互回调中完成**，渲染函数只负责读取已有数据。

### 反模式示例（已修复）

```js
// ❌ 渲染函数中触发 fetch + 设置 loading promise
function renderIMWorkspaceConfigEditor(block) {
  // ...
  window.refreshDispatchConsoleData({ render: true }).catch(() => {});
  //                                                          ↑ fetch 回来之前，下面的代码已经读到 promise = truthy
  var autostartBusy = !!window._dispatchSchedulesRefreshPromise;
  //                                          ↑ 被 fetch 自身设为 truthy → 显示"同步中..."
}
```

### 正确模式

```js
// ✅ 加载入口负责刷新和触发渲染
async function enterIMWorkspace() {
  await refreshDispatchConsoleData({ render: false });
  renderCurrentMainView();
}

// ✅ 渲染函数完全只读
function renderIMWorkspaceConfigEditor(block) {
  var autostartSchedules = (window._dispatchSchedules || []).filter(...);
  // ...生成 HTML
}
```

---

## 2. `renderCurrentMainView` 去重机制

### 工作原理

`renderCurrentMainView()` 生成完整 HTML 字符串，与 `lastRenderedWorkspaceHtml` 比对：

- **相同** → 不更新 DOM（性能保护）
- **不同** → 替换 `container.innerHTML`

### 去重导致的隐含约束

1. **HTML 字符串必须精确反映当前状态**。如果渲染函数在生成 HTML 时触发了异步操作（如 fetch），HTML 中包含的"加载中"状态可能是过时的——因为 fetch 结果还没回来，但 HTML 已经被写入 DOM 和 `lastRenderedWorkspaceHtml`。
2. **后续 re-render 可能被去重阻止**。如果异步操作完成后触发的 re-render 生成了相同的 HTML（因为数据没变），DOM 不会更新。这在正常情况下是正确的优化，但如果第一次渲染就带有"自致 loading"状态，用户会看到错误的中间态。
3. **嵌套 `renderCurrentMainView` 调用时，内层会先更新 `lastRenderedWorkspaceHtml`**。外层的比对可能因此被短路。这不是 bug，但需要理解。

### 开发建议

- 不要为了规避去重而添加随机标记或时间戳——应该从源头避免在渲染中产生副作用
- 如果需要强制刷新（如数据确认已变但 HTML 相同），将 `lastRenderedWorkspaceHtml = ''` 后再调 `renderCurrentMainView()`
- `isEditingWorkspaceForm()` 保护优先级高于去重——用户正在编辑表单时，任何 re-render 都会被跳过

---

## 2a. 空状态/欢迎页渲染必须去重（2026-08-17）

### 问题

切进空会话/新会话时，欢迎页动画会闪烁 2-3 次才正常播放。根因：欢迎页 DOM 写入路径完全没有去重，短时间内多条路径各自无条件执行 `container.innerHTML = getEmptyStateHtml()`，每次替换都重启 `.empty-welcome` 的 CSS 动画：

1. `renderCurrentMainView()` 空消息分支（app-ui.js）
2. `render()` 欢迎分支（chat-renderer.js）——且该分支清空 `_lastRenderedChatSig`，签名去重对其失效
3. poll 提交消息变化（optimistic `[]` → `[system msg]`）→ `appendNewMessages()` 在欢迎态转发 `render()`

### 修复模式

统一走 `renderChatEmptyState()`（chat-renderer.js）：内容级去重——生成的空状态 HTML 与上次相同，且 `container` 当前仍显示 `.empty-state` 时，跳过 innerHTML 重建。

```js
if (_lastRenderedChatEmptyHtml === emptyHtml && container.querySelector('.empty-state')) {
  return; // HTML 未变且 DOM 仍是空状态 → 不重建（动画不重启）
}
```

### 关键点

- `.empty-state` DOM 存在性检查是自愈的：欢迎页 → 消息列表 → 再回欢迎页时，DOM 检查失败 → 必然重建，无需在各处手动清缓存
- 不同 agent 的欢迎页 HTML（displayName 不同）→ 自然重建，动画重播一次，符合预期
- spinner（chat-loading）→ 欢迎页的过渡因 HTML 不同也会正确重建
- 任何"带 CSS 入场动画的静态内容"的渲染入口都应套用此模式：**动画重启次数 = DOM 重建次数**，去重必须在内容层做，不能只依赖消息签名

### 转场边界：增量追加的前提是容器已有历史行（2026-10-20）

欢迎态转发只覆盖"仍在欢迎态"的 append；首条 user 消息到达后 `shouldShowChatWelcome` 已为 false，`appendNewMessages()` 走增量路径——但容器里只有欢迎页 DOM，`[0, startIndex)` 的系统前缀从未物化，末尾签名却被记成"完整已渲染"。此后显示过程切换（只切类）与同数据全量 render（签名去重跳过）都无法恢复，用户滚到绝对顶部也看不到系统提示词，直到某次签名变化的全量重建。

守卫（chat-renderer.js `appendNewMessages()`，与欢迎态转发、错误组升级同族）：`startIndex > 0` 且容器无历史行（排除 `.optimistic-user-echo` 覆盖层——echo 不算历史行，全量重建后由 reconcile 的 isConnected 清理兜底）时升级 `render()` 全量构建。任何新增的增量 DOM 路径都要遵守同一前提：**渲染签名必须始终描述容器实际呈现的消息列表**，否则签名去重会把缺失的 DOM 判定为"已渲染"。

---

## 3. `resetRuntimeBackedSurfaceState` — 切换时的状态清理

### 调用时机

`selectWorkspaceSurface()` 在每次切换工作空间时调用 `resetRuntimeBackedSurfaceState()`。

### 设计意图

清理**与当前 agent 强绑定**的运行时状态（消息列表、input requests、hook inspector 等），防止切换后显示上一个 agent 的数据。

### 关键判断：什么该重置，什么不该

| 变量 | 是否重置 | 原因 |
|---|---|---|
| `currentMessages` | ✅ | 每个 agent 的对话消息不同 |
| `currentInputRequests` | ✅ | 每个 agent 的输入请求不同 |
| `_dispatchSchedulesLoaded` | ❌ | dispatch schedules 是全局数据，不随 agent 变化 |
| `lastRenderedWorkspaceHtml` | ✅ | 新 agent 的 HTML 一定不同，需要重建 |
| hook inspector / overview | ✅ | 与 agent runtime 绑定 |

**原则：只重置 agent 级别或 session 级别的状态，不要重置全局 / 跨 agent 的缓存数据。**

错误重置全局数据的后果：
- 切换回来时触发不必要的重新加载
- 加载期间用户看到 loading 状态而非已有数据
- 加载耗时取决于网络和服务器状态，体验不可控

---

## 4. 数据加载的职责分离

### 三层架构

```
┌─────────────────────────────────────────────┐
│  交互层 (click handlers, toggle functions)    │  ← 用户操作触发
│  例: togglePortalAgentAutostart()            │
│  职责: 发请求 + await refresh({ force:true })│
├─────────────────────────────────────────────┤
│  加载层 (ensure*Loaded, refreshDispatch)      │  ← 入口或切换时触发
│  例: ensureIMWorkspaceLoaded()               │
│  职责: fetch 数据 + 更新 state + re-render   │
├─────────────────────────────────────────────┤
│  渲染层 (render* 函数)                        │  ← 被动调用
│  例: renderIMWorkspaceConfigEditor()         │
│  职责: 只读 state → 生成 HTML                 │
└─────────────────────────────────────────────┘
```

### `ensure*Loaded` 模式

以 `ensureIMWorkspaceLoaded` 为例的标准模式：

```
1. 有缓存且无错误 → 直接返回缓存（快速路径）
2. 已有进行中的请求 → 返回同一 promise（并发保护）
3. 需要加载 → 设 loading → renderCurrentMainView() → fetch → 更新 state → finally { renderCurrentMainView() }
```

关键点：
- loading 设为 true 后**立即 render** 一次（显示 loading 骨架）
- fetch 完成、state 更新后**在 finally 中 render**（显示最终数据）
- finally 中的 render 覆盖了成功和失败两种情况

### 后台刷新模式

后台刷新也必须由加载层、轮询层或交互层触发。`render:false` 只能表示刷新函数自身不触发渲染，不代表可以从 render 函数内部调用它。

```js
// ✅ 正确：轮询/入口层静默刷新，数据变化后再渲染
async function refreshWorkspaceData() {
  const changed = await refreshDispatchConsoleData({ force: false, render: false });
  if (changed) renderCurrentMainView();
}

// ❌ 错误：无论 render 参数是什么，都不应从 render 函数里发起刷新
function renderWorkspace() {
  refreshDispatchConsoleData({ render: false });
  return buildHtml();
}
```

### 工作空间首页面板的导航刷新（memo 先例）

带数据面的 workspace 首页 block（memo 总览 / 便签 / 提醒）按 SWR 语义取数：缓存先显（零闪烁），后台重取后自行 repaint。取数时机全部在渲染之外：

1. **导航事件**：`setPreferredUnitMode` 末尾经 `refreshVisibleWorkspacePanelData` 分发——进入工作空间 / 切分页 / 返回总览都汇经该函数，每次真实导航恰好一次。分发表 `WORKSPACE_PANEL_REFRESHERS` 按 block.type 登记（与 renderWorkspaceBlock 的分发表同构），不按 agent id 硬编码；新面板接入时在此登记 `refresh` 入口。
2. **窗口聚焦**：模块自挂 focus 监听（阅读/编辑态跳过，避免打断）。
3. **冷启动兜底**：render 仅在无缓存且无在途请求时幂等取一次（im-ui lazy ensure 先例），此后 render 纯投影——「F5 直接落在工作空间首页」没有导航事件，靠这条兜住。

面板的取数函数内置在途去重（in-flight 标志）：导航重取与渲染兜底并发时只发一次，杜绝「render 内 fetch × 双渲染 = 请求翻倍」。

---

## 5. `_dispatchSchedulesRefreshPromise` 生命周期

### 设计用途

`_dispatchSchedulesRefreshPromise` 是 `loadDispatchSchedules` 的并发锁，防止多个调用者同时触发相同的 fetch。

### 生命周期

```
loadDispatchSchedules() 被调用
  → _dispatchSchedulesRefreshPromise = async IIFE  (设为 truthy)
    → await fetch(...)
    → 更新 _dispatchSchedules, _dispatchSchedulesUpdatedAt, _dispatchSchedulesLoaded
    → finally { _dispatchSchedulesRefreshPromise = null }  (保证清空)
```

### 注意事项

- `finally` 块**保证执行**，无论 fetch 成功或失败
- 如果 fetch 失败（网络错误），`_dispatchSchedulesLoaded` **不会被设为 true**，下次 staleness 检查仍会触发重新加载
- **永远不要在渲染函数中依赖此变量作为 UI 状态**——它是 fetch 的并发控制机制，不是 UI loading 状态

---

## 6. poll 循环与 switchAgent 的竞态

### 背景

Claw 前端有一个持续的 `poll()` 循环（`app-main.js`），每 300ms-1000ms 轮询当前 runtime agent 的消息、输入请求和 overview。同时 `switchAgent()` 是用户切换 agent 时的入口。两者并发运行，**必须防范 stale 数据覆盖**。

### 已修复的竞态：poll 的 fetch 结果与 agent 切换

**问题**：`poll()` 用 `currentRuntimeAgentId` 拼接 URL 发起 fetch，但在 `await` 返回后没有检查该 ID 是否已经改变。如果用户在 fetch 进行期间切换了 agent，poll 拿到的是旧 agent 的数据，会覆盖 `currentMessages` 并触发 `renderCurrentMainView()`，导致页面闪回旧会话。

```
T0: poll 用 OLD_ID 发 fetch
T1: 用户切换 → switchAgent(NEW_ID) → loadAgentData → 渲染新会话 ✅
T2: poll 的旧 fetch 返回 → currentMessages = 旧消息 → renderCurrentMainView() → 闪回 ❌
T3: 下一轮 poll 用 NEW_ID → 恢复正确 ✅
```

用户看到的现象：切过去 → 闪回 → 再切回来。

**修复**：在 fetch 返回后、处理数据前，检查完整 runtime context 是否仍与发起时一致。如果已变，丢弃这批响应直接进入下一轮 poll。

```js
const pollRuntimeId = currentRuntimeAgentId;
const pollContextKey = getRuntimeContextKey(pollRuntimeId);

const [msgsRes, inputRes, overviewRes] = await Promise.all([...]);

// stale check
if (
  normalizeAgentIdentity(currentRuntimeAgentId) !== normalizeAgentIdentity(pollRuntimeId)
  || getRuntimeContextKey(pollRuntimeId) !== pollContextKey
) {
  setTimeout(poll, 300);
  return;
}
```

### 同文件已有参考实现

`refreshCurrentRuntimeStatus()`（modules/agent-data-loader.js）已经有正确的 stale check：

```js
async function refreshCurrentRuntimeStatus(runtimeId = currentRuntimeAgentId) {
  const expectedRuntimeId = normalizeAgentIdentity(runtimeId);
  // ... fetch ...
  if (normalizeAgentIdentity(currentRuntimeAgentId) !== expectedRuntimeId) {
    return null;  // 已过时，丢弃
  }
  // ... parse ...
  if (normalizeAgentIdentity(currentRuntimeAgentId) !== expectedRuntimeId) {
    return null;  // 二次确认
  }
}
```

### 规则：stale check 应使用 runtime ID，不应使用 `getRuntimeContextKey`

`getRuntimeContextKey(runtimeId)` 内部依赖 `allAgents` 全局数组来查找 workspace session ID。但 `allAgents` 由 `loadAgents()` 异步更新，在 `await` 前后可能返回不同的值。

这意味着在 `await fetch(...)` 前后各调用一次 `getRuntimeContextKey` 进行比较，会因为 `allAgents` 在此期间被更新而产生**虚假的 stale 判定**，导致：

- `loadAgentData` 提前 return，不做任何渲染（用户看到的是 optimistic 缓存数据，可能已过期）
- `poll` 丢弃有效数据，增加延迟和卡顿感
- `_syncPersistentInputUi` 静默失败

**正确做法**：stale check 只比较 `currentRuntimeAgentId`（同步设置，不会在 await 期间变化）。同一 runtime 的 session 切换由 `prebuiltSessionSwitchInFlight` 保护（poll 在此期间整体跳过）。

涉及的位置：

| 函数 | stale check 方式 | 状态 |
|------|------|------|
| `poll()` 消息处理 | 校验 `currentRuntimeAgentId` | 已修复（曾误用 context key 导致虚假丢弃） |
| `refreshCurrentRuntimeStatus()` | 校验 `currentRuntimeAgentId` | 已有 |
| `loadAgentData()` | 不需要额外 stale check（由 `switchAgent` 串行调用保证） | 已修复（曾误用 context key 导致提前 return） |
| `_syncPersistentInputUi()` | 校验 `currentRuntimeAgentId` | 已修复（曾误用 context key） |
| `poll()` 的 404 fallback 分支 | 隐含在 stale check 后 | 被 stale check 覆盖 |

### `_prebuiltSessionSwitchDepth` 的保护范围与局限

`_prebuiltSessionSwitchDepth` 是一个引用计数器（替代了原来的布尔 `prebuiltSessionSwitchInFlight`），在 `runWorkspaceAction` 的 `needsManagedSession` 分支（prebuilt agent 的 `open_session` / `create_session`）中 `++`，在 `finally` 中 `--`（floor 0）。poll 在此计数 > 0 时会跳过整轮。

**为什么是计数器而非布尔**：用户快速连续切换 session（A→B→C）时，两个 `runWorkspaceAction` 会并发进入 `needsManagedSession` 分支。如果用布尔，B 的 `finally` 会把标志设为 `false`，导致 poll 在 C 的切换尚未完成时就恢复轮询，可能获取到旧 session 的消息造成闪回。计数器确保 poll 被阻塞直到**所有**并发切换都完成。

**保护范围**：同一 prebuilt agent 内不同 session 之间的切换（如 flow-workspace 中从 A 会话切到 B 会话）。

**不保护的场景**：
- 左侧列表中不同 runtime agent 之间直接点击切换（走 `agentList.click` → `switchAgent`）
- 外部 agent 之间的切换

因此 `_prebuiltSessionSwitchDepth` 是对特定场景的优化保护，不能替代 poll 内部的 stale check。两者互补，不能只用其中一个。

---

## 6a. SSE 与异步快照：视图身份有效不代表输入数据仍新鲜

`SessionView` token 的身份/代次校验防跨会话提交；同一会话内还需独立的输入请求版本校验。全量 poll 和 `loadAgentData` 都可能在等待其他接口时，被 SSE 的新输入请求超越；旧空快照随后提交会移除历史 user 消息的编辑按钮，旧非空快照则可能复活已消费的 lease。

- `captureSessionViewToken` 在 I/O 前捕获 `inputRequestsRevision`；规范写入点 `applySessionViewPatch` 每次接受输入快照都推进版本，包括内容相同的事件与本地清空。
- `commitSessionViewPatch` 拒绝过期的 **inputRequests 字段**，其他字段与视图事务仍正常提交；返回 `true` 仅代表视图事务执行，不代表全部字段获准写入。
- `commitMetadataUpdate` 在签名比较和副作用之前检查输入版本；相同内容也要提交观察版本，但不触发聊天按钮重构。不要在响应返回后重新捕获 token，也不要用刷新、追加轮询或延时掩盖时序覆盖。
- 同步导航/缓存恢复直接写入仍有效；它们也使更早的在途输入快照失效。版本不随输入值清空而归零，避免 ABA。

回归测试：`test/frontend-rollback-edit-buttons-race.test.js` 用受控 Promise 驱动真实 poll / load / SSE 消费及聊天渲染，验证最终编辑按钮、未变事件、lease 清除与后续新请求。

---

## 7. Agent 切换的渲染时序

### 切换入口与调用链

左侧列表的点击根据 agent 类型走不同路径：

```
用户点击左侧列表 agent 条目
  ├── prebuilt agent → handlePrebuiltAgentClick
  │     ├── workspace host / surface unit → loadAgentDetail → selectWorkspaceSurface
  │     └── 有 runtime 的 prebuilt → switchAgent(runtimeId)
  └── 外部 runtime agent → switchAgent(agentId)
```

workspace 内 session 按钮的点击走另一条路：

```
用户点击 session 的 "打开对话" 按钮
  → runWorkspaceAction({type: 'open_session', sessionId})
    → needsManagedSession 分支
      → prebuiltSessionSwitchInFlight = true
      → openPrebuiltWorkspaceSession(agentId, sessionAction)
      → requestSwitch(nextRuntimeId, 'session-open')
        → setTimeout(flushPendingSwitch, 0)
          → switchAgent(runtimeId)
      → loadAgents().catch(...)
      → finally { prebuiltSessionSwitchInFlight = false }
```

### `switchAgent` 的渲染步骤

`switchAgent` 内部（`app-main.js`）的关键渲染步骤：

```
1. setViewerSessionBinding(...)      ← 冻结 viewer 侧会话身份（用户主动切换，见 §8a）
2. currentAgentId / currentRuntimeAgentId = ...  ← 同步设置全局状态
3. restoreRuntimeFromCache           ← 按 session context 尝试恢复 optimistic runtime cache
4. renderAgentList() / renderCurrentMainView()  ← optimistic 渲染
5. localStorage 写 claw:lastFocusedRuntimeId    ← 焦点已前端化，无服务端 current 语义
6. await loadAgentData(runtimeId)   ← fetch 真实消息、input requests、工具、hooks
7. loadAgents().catch(...)          ← fire-and-forget 刷新 agent 列表数据（epoch 守卫）
```

`loadAgentData` 的消息、工具、hooks、overview、todo、input requests、宿主详情与运行状态并行加载、按数据域独立提交。正文不等待辅助请求；工具配置迟到时仅在配置变化后重绘当前消息。每个提交仍使用进入会话前捕获的 SessionView token，辅助请求失败独立记录，不吞掉已就绪的正文。

宿主详情的 `sessionMeta` 按 token 中选中的 `sessionId` 查找，不能用宿主 `activeSessionId` 替代；分页详情缺少目标记录时保留现有元数据。详情不得改变当前视图身份或使同次消息加载的 token 失效。

消息写入会推进独立的 `messagesRevision`。进入会话时发出的全量响应提交前校验该版本，避免实时消息已上屏后被旧加载快照回退。`loadAgentData` 仍等待各加载任务收尾后返回，但正文可以提前显示。**所有迟到回调都必须通过原 token 校验，不能重新捕获 token 使旧响应获得当前视图所有权。**

回归测试：`test/frontend-agent-load-latency.test.js` 使用真实加载、缓存、详情与 SessionView 模块，受控阻塞辅助请求的响应头/响应体，验证正文提前显示、选中身份稳定、缓存切回与迟到消息隔离。

### `requestSwitch` 的延迟机制

`requestSwitch` 通过 `setTimeout(flushPendingSwitch, 0)` 延迟到下一个事件循环再执行 `switchAgent`。这是为了：

1. 允许连续多次 `requestSwitch` 调用中只有最后一次生效（serial 递增，旧 serial 被跳过）
2. 让调用方有机会在 switch 之前完成一些同步状态设置

**注意**：`requestSwitch` 返回的 Promise 要到 `switchAgent` 完成才 resolve。`await requestSwitch(...)` 会等待整个切换完成。

---

## 7a. 同 runtime 会话切换：必须重新加载数据

### 问题描述

当切换到同一 workspace host 下的不同会话时，如果 `nextRuntimeId === currentRuntimeAgentId`（runtime 进程没有变，只是 server 端激活了不同的 session），原有代码仅调用 `renderCurrentMainView()` 而不重新加载消息。

`currentMessages` 仍然保存着**前一个会话**的消息。`render()` 的去重机制（`_lastRenderedChatSig`）还会跳过渲染。用户看到的场景：

1. 点击会话 B → 页面短暂显示会话 A 的消息（"闪回"）
2. `_prebuiltSessionSwitchDepth` 归零后 poll 恢复轮询
3. Poll 获取到会话 B 的消息 → 渲染 B

### 根因

```js
if (nextRuntimeId === currentRuntimeAgentId) {
  // ❌ 没有 reload 数据！currentMessages 还是旧会话的
  renderCurrentMainView();
}
```

### 修复

新增 `reloadRuntimeForSessionSwitch(runtimeId)` 函数，在三处同 runtime 分支中调用：

```js
async function reloadRuntimeForSessionSwitch(runtimeId) {
  _lastRenderedChatSig = '';
  setFollowLatest(true);
  beginFollowLatestCooldown();
  beginFollowLatestEntryWindow();
  currentMessages = [];        // 清空旧消息，显示 loading 状态
  renderCurrentMainView();
  await loadAgentData(runtimeId);  // 重新获取新会话的消息
}
```

### 为什么 `loadAgentData` 的 stale check 不会阻止这次加载

`loadAgentData` 内部的 stale check 比较的是 `currentRuntimeAgentId !== agentId`。在同 runtime 场景下两者相同，所以 check 始终通过。这正是我们期望的行为——同一个 runtime 进程上切换了不同的 session，数据确实需要刷新。

---

## 7b. 会话进入时的 followLatest 与滚动

### 规则

每次进入一个会话（无论是 `switchAgent`、同 runtime 切换、还是点击 Chat 标签），都必须：

1. `setFollowLatest(true)` — 强制启用自动跟随
2. 清除 `_lastRenderedChatSig` — 确保渲染不被去重跳过
3. 不恢复 `_restoredScrollTop` — 旧的滚动位置不代表用户意图

### 为什么不用缓存中的 `followLatest` 值

`restoreRuntimeFromCache` 会恢复 `followLatestEnabled = cached.followLatest`。如果用户在上次浏览此会话时向上滚动了（导致 follow 被禁用），切换回来后会保持禁用状态，视口不会滚到底部。

用户预期：**每次点击一个会话，都自动滚到最下面**。因此 `setFollowLatest(true)` 必须在 `restoreRuntimeFromCache` **之后**调用，覆盖缓存值。

---

## 8. 会话 UI 状态：按业务上下文建模，不要按 DOM 类型或 runtime 建模

### 本次修复推翻的错误认识

以下方案都曾看起来合理，但不能覆盖真实渲染链路：

1. **只缓存 `input-persistent`**：真实页面还可能显示 `input-${requestId}` request 输入框。两种输入面会在异步数据返回后互相替换。
2. **只在 `loadAgentData()` 最后 restore**：后续 `renderInputRequests()`、queue sync、poll 仍可能再次重建 DOM。
3. **只在一个“唯一 restore 点”恢复**：如果 UI 有多个合法渲染形态，每个形态的创建点都必须消费同一份业务草稿。
4. **用 runtime ID 作为草稿 key**：runtime 是进程身份。同一 session 可能重连到新 runtime；同一 runtime 相关状态也可能在 session 切换期间变化。
5. **只要缓存对象里还有值就算修好**：缓存正确但当前 DOM 为空，用户看到的仍是失败。必须验证最终 DOM 稳定状态。

### 真实失败链路：persistent 先恢复，request 随后覆盖

```
切回 session A
  → optimistic cache 未保存 inputRequests
  → currentInputRequests 暂时为 []
  → 渲染 persistent textarea
  → 草稿恢复，用户看到内容闪现
  → /input-requests 返回
  → 输入面切换为 request textarea
  → request textarea 未接入草稿缓存
  → 页面最终为空
```

因此“闪了一下”不是视觉噪声，而是重要证据：它通常说明第一次 restore 成功，随后发生了第二次合法渲染或模式替换。

### 正确模型：Session Draft 与输入面解耦

草稿属于 session，不属于某个 textarea，也不属于 persistent/request 模式：

```text
Session Draft
  ├── persistent textarea
  └── request textarea
```

两类输入面必须统一执行：

1. 创建时绑定冻结的 `data-session-key`
2. 创建后从同一 `_sessionInputCache` 恢复
3. `oninput` 实时写回
4. DOM 销毁前做最后一次写回
5. 提交成功后清理对应 session 草稿

### Session key 的身份规则

workspace session 使用：

```text
host:<hostId>|session:<sessionId>
```

非 workspace runtime 才回退为：

```text
runtime:<runtimeId>
```

不要把 runtime ID 拼入 workspace 草稿 key。草稿的生命周期跟随业务 session，而不是承载它的进程。

解析 session 时，目标 runtime record 上明确绑定的 `active_workspace_session_id` 优先于可能刷新滞后的 host active 字段。

### 输入模式也是 optimistic cache 的一部分

如果切回时只缓存 messages、overview，却把 `currentInputRequests` 清空，UI 会先渲染错误输入模式，再被真实请求纠正，产生闪烁和覆盖。

runtime optimistic cache 至少应同时保存：

- messages
- inputRequests
- tool / hook / overview 数据
- 对应的 session context key

输入请求虽然是短生命周期数据，但它决定当前 UI 形态，不能在 optimistic render 中无条件丢弃。

### `initialValue` 的优先级

request textarea 可能在 `setTimeout` 中写入后端 `initialValue`。优先级必须是：

```text
用户当前值 / session draft > 后端 initialValue > 空字符串
```

异步赋值前必须再次检查：

- 元素仍属于目标 session
- session draft 是否存在
- textarea 当前是否已有值

否则 restore 成功后仍会在几十毫秒后被覆盖。

---

## 8a. Viewer 会话绑定：会话身份必须来自 viewer，不能被动跟随 server（2026-08-19）

### 问题

"用户正在查看的会话"与"server 端 host 级 activeSessionId"是两个语义。server 端
`createPrebuiltSession` 会**无条件**把 host 的 `activeSessionId` 指向新会话（session-helpers.js），
IM 转接 / CLI / 调度 / 其他标签页都会触发。而 `getRuntimeContextKey` 曾经由
allAgents 的 `active_workspace_session_id` 派生 sessionId——外部入口创建会话后，
正在查看会话的 contextKey 会在用户毫无操作时整体漂移，同时导致：

- 输入签名（`persistent|${contextKey}|rw`）突变 → 输入面整块重建 → 失焦
- 语音保护 `_voiceCacheKey === cacheKey` 失败 → `_cancelVoiceRecording()` → 录音被丢弃
- `_storeVisibleSessionInputDraft` 把草稿写进新会话的槽位 → 草稿丢失 + 新会话被污染

### 修复模型：viewer 绑定优先

```js
// app-core.js
_viewerSessionBindings = Map<runtimeId, sessionId>   // 只在用户主动切换时写入

getRuntimeWorkspaceSessionId(runtimeId):
  1. getViewerSessionBinding(runtimeId)   ← 命中即返回（viewer 真相）
  2. _deriveRuntimeSessionIdFromAgents()  ← 回退 server 派生值（初始恢复）
```

**写入点**（全部是用户主动操作）：

| 位置 | 场景 |
|---|---|
| `switchAgent`（app-main.js） | 所有切换汇聚点；写入前用 allAgents 派生值（点击时刻的列表状态） |
| `runWorkspaceAction` needsManagedSession（workspace-actions.js） | 同 runtime 会话切换不经 switchAgent，用显式 targetSessionId 绑定 |

**规则**：

- 绑定代表"用户正在看什么"，server activeSessionId 代表"server 下次激活谁"，二者可以合法不一致
- 用户重新点击列表条目时会重建绑定（所见即所得，外部抢占后点击进入的是列表当前显示的会话）
- 不需要失效管理：runtime 是 per-session 的，绑定指向的 runtime 消失后无人读取

回归测试：`test/session-ui-context.test.js` 的
`viewer session binding freezes context key against host active drift`。

---

## 8b. 输入面重建必须恢复焦点；提交成功必须清 live 元素（2026-08-19）

### 焦点保持

`renderInputRequests` 签名变化 → `innerHTML` 重建 → textarea 是新元素，焦点/IME/选中态必然丢失。
修复：签名确认要重建后，先记录"焦点是否在输入 textarea 内 + selectionStart/End"，
在 requests/persistent 分支重建完成后恢复（仅当焦点原本就在输入区，避免抢占他处焦点）。

### 提交成功清空 live 元素（幽灵暂存复活）

`submitQueuedInput` / `submitInput` 在 `await fetch` 前抓取的 `textarea` 引用，
在 await 期间输入面重建后会指向**脱离 DOM 的僵尸元素**。旧顺序：

```text
textarea.value = ''（作用于僵尸元素，live 输入框仍有值）
delete _sessionInputCache[key]
renderInputRequests([]) → 重建前 _storeVisibleSessionInputDraft 读到 live 框的值 → 写回缓存
→ 已提交文本作为草稿"复活"，未来某次重建时重新显示
```

修复：成功分支重新 `getElementById` 解析 live 元素（persistent 分支校验 sessionKey
仍属同一会话），先清 DOM 再删缓存。空草稿（用户清空后）本身可正常写入与恢复
（`_sessionInputCache[key] = ''`），"清空存不住"的根因是 8a 的双 key 漂移，随绑定修复消失。

---

## 输入请求在场时的后台唤醒

文本 input lease 可在后台通知唤醒 Agent 后继续存在。`requests` / `persistent` 是提交端点，不是运行态：两种模式都保留同一个 `persistent-action-btn`，由 `_syncPersistentActionButton()` 更新发送、打断和正在停止状态，提交反馈结束也回到此入口。请求模式移除按钮 ID 或固定恢复 send，会使 notification 已报告 `callActive:true` 时按钮仍不可打断。

回归：`test/frontend-input-convergence.test.js` 驱动真实 notification、composer 与点击路径，覆盖保留/迟到文本 lease、打断粘性与拒绝投递；`test/input-wakeup-browser-check.mjs` 验证实际图标、请求、刷新恢复和重试。

## 8c. 运行胶囊计时状态属于会话，切换必须清零（2026-08-19）

`_renderLastCallElapsed`（1s interval）依赖三个模块级变量：`_lastCallFinishTime`、
`_runCapsuleStartAt`、`_runCapsuleStartConfirmed`。切换会话时若只清 `_lastCallFinishTime`：

- 切到正在运行的会话：快照未到达时沿用**上一会话**的起始时间
- `confirmed=true` 遗留 → 只接受更晚的快照值 → 若新会话本轮 call 起得更早（并行会话常态），错误时长永远无法纠正

计时状态与 DOM 由 `persistent-input.js` 的 `resetCallElapsedForSwitch()` 一起清理，经统一 `resetRuntimeStatusForSwitch()` 在首次乐观渲染前调用；加载入口与线程接续重绑复用该入口，不在加载层散落赋值。`updateNotificationStatus(null)` 同样清理计时投影；空对象不是重置信号。1s interval 只负责时长刷新，不承担会话切换清理。

`.input-meta-bar` 绝对定位于输入槽位上方，不参与槽位高度与欢迎区剩余空间分配。跟随按钮只测量 `.user-input-card`，不按 `persistent-input` 提交模式类寻址，也不回退测量整个槽位：请求模式会移除该类，容器仍可能含排队气泡等辅助内容。欢迎/加载态隐藏跟随按钮，即使消息数组已有系统提示词。

回归：`test/welcome-browser-check.mjs` 使用真实计时渲染、composer 模式切换与按钮定位，验证显隐前后几何恒定、切换同步清理及欢迎态不滚动；`test/frontend-layout-adaptive.test.js` 覆盖卡片定位与无卡片时清除定位覆盖。

---

## 8d. 前端→agent 控制投递必须用 runtimeId 定位，sessionId 仅作 fallback（2026-08-19）

### 问题

前端→agent 运行时控制 IPC（开关 / 中断 / 热切换类，如 `todo_control`、`tool_state`；
模型热切换已改走 feature-comms 请求面，见 ADR-0034）
存在两个 id 空间：

| id 空间 | 例子 | 来源 | 稳定性 |
|---|---|---|---|
| `runtimeId`（viewerAgentId） | `agent-6-57532` | `currentRuntimeAgentId`，与轮询数据源 `/api/agents/:id/todo` 的 `:id` 同空间 | 稳定：UI 显示哪个 runtime，id 就指向哪个 runtime |
| workspace sessionId | `session-1787…` | `getRuntimeWorkspaceSessionId()` → allAgents 缓存派生（含 server 派生 fallback） | 暂态错位：会话切换/新建后 `allAgents` 未刷新的窗口内指向不存在的 runtime entry |

`todo_control` 曾只认 agentId+sessionId：错位窗口内投递命中不了 `managedAgents` 的
`agentId::sessionId` key，server 返回 `{ok:false}`（HTTP 200，静默失败）。前端只 catch
网络异常、不检查响应体 → 乐观更新 3 秒宽限期后被轮询快照（真实值）覆盖 → 开关"自己关回去"。

实测（2026-08-19）：对全部 17 个历史 session id 投递均 `{ok:false}`，只有真实 active
session 的 id 成功——错位不是理论风险。

**感知差异陷阱**：同一链路的"完成后停止"（taskId，一次性动作）投递失败只表现为标记未出现，
用户重点一次即可；"任务未完自动继续"（forceContinue，持续状态）失败则开关弹回、非常显眼。
两条路径失败率相同，但用户会误判为"新功能选错了链路"。排查时先确认 id 空间，不要被表象带偏。

### 修复模型：三级优先解析（对齐 todo_control / tool_state 已验证模式）

```js
// server 路由（agent-lifecycle.js todo_control 为参考实现）
// Priority 1: runtimeId (viewerAgentId) — 与前端轮询数据源同一 id 空间
const rt = getRuntimeByViewerAgentId(runtimeId);
if (rt && isRunning(rt)) {
  sendIPCToRuntime(rt, message);  // 自动附加 __targetSessionId = rt.selectedSessionId
}
// Priority 2: agentId + sessionId 精确路由（老客户端 fallback）
sendIPCtoSession(agentId, sessionId, message);
// 禁止: pickPrimaryAgentRuntime 类跨 session fallback（会把 session 级状态投给别的会话）
```

```js
// 前端（todo-plan.js sendTodoForceContinue 为参考实现）
body: { agentId: currentAgentId, runtimeId: currentRuntimeAgentId, sessionId, ... }
// 必须检查 response.ok && payload?.ok === true；
// 失败时续期用户操作时间戳（防轮询覆盖乐观态）→ loadAgents() 后重试一次 → 仍失败回滚 UI
```

### 规则（MUST / NEVER）

1. **MUST**：新增前端→agent 运行时控制 IPC 时，body 必须带 `runtimeId: currentRuntimeAgentId`；
   server 端 Priority 1 用 `getRuntimeByViewerAgentId()` + `sendIPCToRuntime()` 解析。
2. **MUST**：控制投递的定位 id 与该面板轮询数据源的 id 保持同一空间——
   显示哪个 runtime 的快照，就控制哪个 runtime。
3. **NEVER**：`allAgents` 缓存派生的 `active_workspace_session_id` / `runtime_session_id`
   不得作为投递定位的**唯一**依据，只能作 fallback。
4. **NEVER**：session 级状态（开关、中断目标等）投递禁止跨 session fallback
   （`pickPrimaryAgentRuntime` / broadcast 会污染其他会话；全局性状态如工具启停除外，见 `tool_state`）。
5. **MUST**：投递类路由的失败必须可被前端判定（检查 `payload.ok`，不能只看 HTTP 状态码）；
   失败后 UI 必须有感知（回滚乐观态或提示），禁止 3 秒后被轮询"悄悄"弹回。

回归测试：`test/agent-lifecycle.test.js` 的 `todo_control route` describe
（含 `delivers via runtimeId even when sessionId is stale` 关键场景）。

---

## 9. DOM 元素身份必须冻结，不能从可变全局状态反推

### 问题描述

`document.getElementById('input-persistent')` 在会话切换后可能返回一个**全新的 DOM 元素**（新的 textarea，属于新会话），但 ID 相同。如果代码仅检查元素是否存在而不验证它是否属于当前会话，会导致状态写入错误的会话。

### 已修复的案例：语音 ASR 结果注入错误会话

```js
// ❌ 错误：只检查 textarea 是否存在
const textarea = document.getElementById(targetId);
if (textarea) {
  insertTextAtCursor(textarea, text);  // 可能注入到了新会话的 textarea！
}

// ✅ 正确：同时验证 session context
if (textarea && _getSessionInputCacheKey() === _voiceCacheKey) {
  insertTextAtCursor(textarea, text);  // 确认是同一个会话
} else if (_voiceCacheKey) {
  _pendingVoiceResults[_voiceCacheKey] += text;
}
```

### 根因分析

会话切换时 `renderInputRequests` 会清空 `inputContainer.innerHTML` 并重新创建 textarea。新 textarea 的 `id="input-persistent"` 与旧的相同。如果在异步回调（如 ASR fetch 完成）中用 `getElementById` 查找，拿到的是新会话的 textarea，而非录音发起时的那个。

### 规则

任何在异步操作后重新查找 DOM 元素的代码，都必须验证完整 session context。仅比较 runtime ID 不够。

```js
const el = document.getElementById('some-id');
if (el && el.dataset.sessionKey === expectedSessionKey) {
  // 元素仍属于发起操作时的 session
} else {
  // 暂存、丢弃，或等待目标输入面重新创建
}
```

事件处理也应优先读取元素冻结的 `data-session-key`，不能在事件发生时重新用全局 `currentAgentId/currentRuntimeAgentId` 推导归属。全局状态可能已经切换，而旧 DOM 的事件或销毁逻辑仍在执行。

---

### "跨工作空间" vs "跨会话"：agent 最容易混淆的层次

在 Claw 中存在两种切换：

| 切换类型 | 触发方式 | 代码路径 | `currentRuntimeAgentId` | 渲染复杂度 |
|---------|---------|---------|------------------------|-----------|
| **跨工作空间** | 点击左侧不同 agent 卡片 | `switchAgent` → `loadAgentData` | 变化 | 较简单（直接进 chat） |
| **同一工作空间跨会话** | workspace session 列表中切换 | `runWorkspaceAction` → `prebuiltSessionSwitchInFlight` → `requestSwitch` → `loadAgentData` | 可能变化，也可能复用/重连 | **更复杂**（输入模式和 runtime 元数据均可能异步变化） |

**关键经验**：跨工作空间测试通过 ≠ 跨会话也通过。同一工作空间内的会话切换经过更复杂的渲染路径（`prebuiltSessionSwitchInFlight` 保护、workspace surface → chat surface 过渡等），更容易暴露渲染时序问题。

**调试策略**：当用户报告"切换后状态丢失"类问题时，首先确认是哪种切换。如果是跨工作空间正常但跨会话异常，问题几乎一定在渲染时序或 `prebuiltSessionSwitchInFlight` 相关的路径上。

---

## 10. 自检清单

修改 Claw 前端代码时，如果涉及以下场景，请对照检查：

### 新增或修改 render 函数时

- [ ] 函数内是否有 fetch / refresh 调用？→ 移到 ensure*Loaded 或交互回调
- [ ] 是否依赖 `_refreshPromise` 类变量决定 UI 状态？→ 改为读取已有数据
- [ ] 是否直接调用了 `renderCurrentMainView()`？→ 确认是否有必要，是否会产生嵌套

### 新增 workspace 状态变量时

- [ ] 该变量是 agent 级别还是全局的？→ 只在 `resetRuntimeBackedSurfaceState` 中重置 agent 级别的
- [ ] 是否需要跨 agent 保持缓存？→ 不重置，用 staleness 判断是否需要刷新

### 新增 ensure*Loaded 函数时

- [ ] 是否有并发保护（request promise 复用）？
- [ ] loading 状态变化后是否调了 `renderCurrentMainView()`？
- [ ] finally 块中是否清理了 loading 状态和 request promise？

### 在 poll 循环或异步回调中使用 `currentRuntimeAgentId` 时

- [ ] 是否在 `await` 之前将 `currentRuntimeAgentId` 保存到局部变量？→ 避免中途被修改导致请求不一致
- [ ] 是否在 `await` 返回后检查 `currentRuntimeAgentId` 是否仍是快照值？→ 不是则丢弃过时响应
- [ ] 是否直接将 fetch 结果写入 `currentMessages` 等"源真相"变量？→ 如果没有 stale check，写入旧数据会导致渲染回退
- [ ] 是否依赖 `_prebuiltSessionSwitchDepth` 作为唯一保护？→ 它只覆盖 prebuilt session 切换路径，不覆盖直接 `switchAgent` 路径
- [ ] stale check 是否误用了 `getRuntimeContextKey`？→ 该函数依赖异步更新的 `allAgents`，不能用于 `await` 前后的比较

### 切换工作空间 / agent 出现异常时

- [ ] 检查 `resetRuntimeBackedSurfaceState` 是否重置了不该重置的全局缓存
- [ ] 检查 render 函数是否有副作用导致自致 loading
- [ ] 检查 `ensure*Loaded` 的快速路径是否正确（有缓存时是否跳过了加载）
- [ ] 如果出现"闪回"现象（切过去又闪回来），优先排查：
  - 同 runtime 会话切换是否走了 `reloadRuntimeForSessionSwitch`（而不是仅 `renderCurrentMainView`）
  - poll/异步回调的 stale 数据覆盖
  - `_prebuiltSessionSwitchDepth` 是否在并发切换中被过早归零
- [ ] 用浏览器 DevTools 的 Network 面板确认：切换后是否有旧 agent ID 的请求仍在返回并触发渲染
- [ ] 如果切换后不滚动到底部：检查 `setFollowLatest(true)` 是否在 `restoreRuntimeFromCache` 之后调用，以及 `_lastRenderedChatSig` 是否被清除

### 新增 per-session 状态（输入框缓存、草稿、语音结果等）时

- [ ] 状态 key 是否代表业务 session，而不是 runtime 进程？
- [ ] 是否枚举了所有可能承载该状态的 UI 形态，而非只处理当前看到的一种 DOM？
- [ ] 每种输入面创建时是否绑定冻结的 `data-session-key` 并恢复同一份 session draft？
- [ ] 是否在 `oninput` 中实时缓存，并在 DOM 销毁前做最后写回？
- [ ] optimistic cache 是否保留决定 UI 形态的数据（例如 `inputRequests`），避免先渲染错误模式？
- [ ] 后端 `initialValue` 等异步默认值是否服从“用户值 / 草稿优先”？
- [ ] 提交成功后是否先清空 DOM，再删除草稿，避免销毁钩子把已提交文本重新存回？
- [ ] 异步回调是否校验 `currentRuntimeAgentId`？→ **不要**使用 `getRuntimeContextKey` 做 stale check，因为它依赖异步更新的 `allAgents`，在 `await` 前后会返回不同值
- [ ] 是否区分了"跨工作空间"和"同一工作空间跨会话"两种切换路径并都测试了？→ 后者渲染路径更复杂
- [ ] 是否观察了切换后至少数轮异步刷新，而不是只看内容曾经闪现？

### 验证“闪一下后消失”类问题时

- [ ] 记录每次输入区重建的 render mode、context key、textarea ID 和最终 value
- [ ] 同时检查 persistent 与 request 输入面，不要只 grep `input-persistent`
- [ ] 检查 optimistic 状态和真实 fetch 状态是否使用相同的数据形状
- [ ] 在切回后的多个时间点取样（例如 100ms、300ms、1s、3s），确认最终 DOM 稳定
- [ ] 验证缓存对象和当前 DOM 两个层面；缓存命中不代表用户界面正确

---

## 11. poll 循环中的渲染顺序与中断抑制

### 消息渲染必须在非关键异步操作之前

`poll()` 循环每 300ms 执行一轮。曾经消息渲染位于 `await statusTask`、`await refreshAgentCallStates`、`_syncPersistentInputUi` 等操作之后，导致用户提交消息后看到数百毫秒的延迟。

**当前正确顺序**（`app-main.js` poll 函数内）：

```text
1. fetch messages + input-requests + overview (Promise.all)
2. parse messages (msgsRes.json())
3. ★ render messages (appendNewMessages / updateLastMessage) ← 立即执行
4. await statusTask (notification + connection)
5. await refreshAgentCallStates (batch /notification for all agents)
6. _syncPersistentInputUi (fetch /queued-inputs)
7. process overview / input requests
```

**规则**：消息渲染不依赖 calling 状态、队列状态或 overview 数据。将消息渲染提前到所有非关键异步操作之前，消除可见延迟。

### 中断行为（框架级无延迟）

**设计**：中断完全由框架层执行，前端不做任何伪抑制。

框架层（AgentDev `tool-executor.ts`）的 `Promise.race` 机制：
- 当 `AbortSignal` 触发时，正在执行的工具立即返回 `ToolInterruptError`，不等工具完成
- 工具的实际执行在后台 fire-and-forget，其结果被丢弃
- LLM streaming 通过 `signal` 传给 fetch，HTTP 请求立即 abort
- React 循环在每个 step 开头和每个工具执行前检查 `signal.aborted`，如果已中断则跳过

前端行为（`app-main.js`）：
- `interruptAgent()` 做乐观 UI 更新（清 calling 状态、隐藏状态栏、按钮切 send）
- 不设置任何抑制窗口
- 下一轮 poll 的 `/notification` 如果仍返回 `callActive: true`，会短暂恢复 calling 状态
- 但由于后端 abort 在毫秒级完成（LLM stream + tool race），最多 1-2 轮 poll（600ms）即可稳定
- 这比伪抑制窗口更可靠，不会在处理下一次输入时造成状态混乱

**为什么不用伪抑制窗口**：曾经的 `_interruptSuppression` 机制（10s 安全超时窗口）引入了复杂度和边界条件：
- 切换 agent 时需要清除
- 提交新输入时需要清除
- `refreshAgentCallStates` 中清除判断必须用 `backendCalling` 而非 `isCalling`
- 用户处理下一次输入时，抑制窗口可能仍在生效，导致 calling 状态显示不正确
- 这些隐性约定极难维护，且掩盖了后端中断速度不够快的真正问题

---

## 12. 用户展开/折叠状态的持久化

### 问题描述

会话中用户手动展开的思考块（reasoning block）或手动折叠/展开的消息块，在 `render()` 全量重建（`container.innerHTML = html`）后会丢失，恢复为默认状态。

### 根因

`render()` 函数在消息列表签名变化时执行 `container.innerHTML = html`，销毁所有 DOM。随后 `syncCollapseStates` 只应用**自动**折叠规则（基于消息长度、system/Read/Edit 类型），不感知用户之前的操作。

### 解决方案

使用三个全局 `Set`（定义在 `app-core.js`，按消息索引 keyed）记录用户的显式操作：

| 变量 | 记录内容 |
|------|---------|
| `_userExpandedReasoning` | 用户展开的 reasoning block 对应的消息索引 |
| `_userCollapsedMsgs` | 用户手动折叠的消息索引 |
| `_userExpandedMsgs` | 用户手动展开（取消折叠）的消息索引（覆盖自动折叠） |

**记录时机**：`toggleMessage(id)` 和 `toggleReasoning(id)` 中，根据 toggle 后的 DOM 状态记录到对应 Set。

**恢复时机**：`render()` 中 `syncCollapseStates` + `applyConversationProcessState` 之后调用 `restoreUserCollapseState(container)`，确保用户操作优先级最高。

**清理时机**：`resetRuntimeBackedSurfaceState()` 中清空所有三个 Set（切换 agent/session 时）。

### 优先级链

```text
1. process-hidden 行 → 强制展开（不受任何折叠影响）
2. syncCollapseStates 自动规则 → 基于长度和类型的默认折叠
3. restoreUserCollapseState → 用户显式操作覆盖自动规则
```

---

## 12a. 侧栏统一投影与运行会话高亮（2026-08-27）

### 投影模型

侧栏只有一套渲染模型：`工作空间 → 项目目录 → 运行中会话`（决策见 [ADR-0010](../adr/0010-sidebar-unified-projection.md)）。本地会话与远程会话在 `renderSidebarChildItems` 处汇合成统一条目流，渲染器不感知来源：

```js
// sidebar-render.js renderSidebarChildItems
const remoteEntries = typeof getRemoteSidebarProjection === 'function'
  ? getRemoteSidebarProjection(workspaceAgentId, ownerAgentId)
  : [];
const projectedEntries = [...visibleEntries, ...remoteEntries];
```

关键分离：

- **`projectKey` 是内部身份，`projectName` 只是呈现**。折叠状态（`_collapsedProjectGroups`）必须按 projectKey 持久化——按显示名持久化会让本地与远程同名目录互相折叠。
- **组身份与显示名同理**：组内身份用 `entry.projectKey || entry.projectDir`，标题显示 `projectName`（远程为 `主机名：目录名`）。
- **能力差异由条目元数据表达**：本地目录的"进入"按钮不适用于远程目录，渲染器按元数据判定，不按来源猜。
- **远程 catalog 变化必须进入渲染签名**（`getAgentListRenderSignature`），否则连接切换/断线/恢复后统一树停留在旧 DOM。

禁止为远程内容新建平行 DOM 区（历史上存在过 `remote-agent-zone`，已删）：远程条目一律经投影函数并入统一渲染。

### 线程分组缓存与宿主运行时投影

- 存活 head 的项目/目录归属每次按最新 wire 快照投影，不能从 `_coderThreadLiveEntries` 回灌旧 `projectKey`、`projectDir` 或 `projectName`。线程缓存只保持排序时间锚，并在 head runtime 缺席的接续窗口提供占位；否则第一次误分组会持续覆盖正确快照，项目改名与归属转移也只能靠刷新页面纠正。
- 宿主合成运行条目须透传 `active_workspace_session_project_id` 和 `active_workspace_session_dir`。宿主会话列表是分页切片，不能依赖该列表补齐活跃会话身份。两个宿主字段与 child 的 `project_id` / `open_directory` 都要进入 `getAgentListRenderSignature`，确保同一 runtime 的归属补齐能触发重绘。
- `runtime_status` 的 `agent` 与 start/restart 响应共用 `buildChildRuntimeAgent`，不能另拼一份省略归属的条目。就绪返回会被前端直接 upsert，必须带 `project_id` / `open_directory` / `sidebar_entry_id`，否则正确索引也会被投影成目录对话。
- 宿主 primary 在异步查询期间改变时，必须连同标题、目录和项目归属一起切换，不能只覆盖 `active_workspace_session_id` 与 runtime ID。
- 未提交的 successor 只有其 `source_session_id` 对应正在接续的 head 时才能归入该线程；同工作空间存在接续挡板不是成员关系证据。该血缘字段从会话索引经 discovery / child wire 投递，不能靠线程遍历顺序猜测。
- 无页面缓存的接续占位按线程列表的 `headProjectId` / `headProjectDir` 分组，两字段与血缘字段同样进入侧栏渲染签名，避免刷新中途归属丢失。
- 回归：`test/ph-project-frontend-projection.test.js` 驱动真实轮询、线程投影与 HTML 渲染，覆盖归属纠正、重启空窗及新 runtime、项目改名与项目/目录转移；隔离落盘索引经 discovery / connected 查询回读后再投影，验证恢复读取链。`node --test test/ph-project-restart-runtime.mjs` 启动隔离 Viewer 与挂载真实 UserInputFeature 的共享 runtime，通过 Chromium 点击重启并检查新运行条目、退役输入循环收尾后的持续存活、同进程兄弟会话、刷新后分组及索引归属（需要 Playwright Chromium）。测试必须同时隔离数据根、HTTP 端口和 `AGENTDEV_UDS_PATH`，不使用默认 Viewer socket。

### 高亮谓词：isRuntimeItemActive 的空值守卫

选中工作空间（surface）时 `selectWorkspaceSurface` 会清空 `currentRuntimeAgentId = null`。此时 `isRuntimeItemActive` 的两条比较都不得误判：

```js
// ❌ 空对空对称相等：本地条目 resolveRuntimeRef 未命中返回 null，
//    归一化 '' === '' 恒真 → 所有本地运行会话全部高亮
return normalizeAgentIdentity(resolveRuntimeRef(id)) === normalizeAgentIdentity(currentRuntimeAgentId);

// ✅ 无选中运行时直接判非；兜底解析必须实际命中
if (normalizeAgentIdentity(currentRuntimeAgentId) === '') return false;
const resolved = window.RemoteConnections?.resolveRuntimeRef?.(normalizedRuntimeId);
return !!resolved && normalizeAgentIdentity(resolved) === normalizedCurrent;
```

通用规则：**任何"解析后归一化再比较"的谓词，两侧都可能为空——必须先排除空值侧，或在比较中要求解析侧 truthy**。这类 bug 的用户表象是"选中 A，一堆不相关的条目高亮"，容易误排查为 CSS 或事件委托问题。

回归测试：`test/frontend-sidebar-runtime-active.test.js`（vm 沙箱加载真实源码，覆盖五种选中形态）。

---

## 左栏应用布局与持久折叠（2026-10-21）

- `modules/sidebar-layout.js` 是用户布局的唯一前端持有方。`groupConnectedAgents` 只提供作者默认分组与 host 相邻排序；用户布局在其上覆盖，应用可跨现有文件夹或移到顶层，不改变业务 host、agentId 和运行会话投影。
- 权威存储为用户数据根 `workspace-settings.json` 的 `sidebarLayout` 节，经 `/protoclaw/workspace_settings/sidebar_layout` GET/PUT 读写，复用设置文件写锁和原子落盘，保留 visibility/resourcePolicy 兄弟节。布局用稳定应用 ID 和文件夹 ID，隐藏只影响呈现、不删除位置；新应用追加到默认文件夹。设置文件或 `sidebarLayout` 节缺省时返回 `null`，前端按默认分组与展开状态呈现；首次排序或切换折叠才落盘，保留已有设置兄弟节。
- `sidebar-layout.js` 必须先于 `sidebar-render.js` 加载。首次加载与 agents 并行取布局；重新聚焦/前台恢复时读最新服务端布局。读取失败提示并禁止整理；保存期间禁止再次整理，失败提示并回滚，不退到本地浏览器存储。
- `renderAgentList` 在按压/拖动期间不替换 DOM，手势结束后消费最新 agents；布局与语言进入渲染签名。文件夹折叠从布局恢复，项目目录折叠仍归原逻辑，不混入布局。
- 长按拖动与键盘整理共用移动函数；短按保持导航/折叠，Esc、pointercancel、失焦取消不落盘，拖动松手抑制合成点击，下一次真实按压立即解除抑制。会话引用拖拽不是应用整理手势。
- 落点按布局矩形解析，行间空隙归属相邻插入位置，不按 `elementFromPoint` 命中的后代元素切换语义；文件夹标题触发放入，描边覆盖整个文件夹容器（标题与内容），鼠标与键盘共用；描边由不占布局、不可命中的上层伪元素绘制，不铺整块强调底色，保留内部卡片选中底色且不被卡片覆盖；应用区排序，左缘顶层排序。源条目整块（含运行会话）不作为目标。相同落点不重写高亮，源条目淡化；拖动过程只显示落点，不显示底部操作说明。保存状态与错误提示浮于左栏底部、不参与布局。浏览器回归须逐像素跨越行间空隙及标题边缘，并验证手势期间列表尺寸不变。
- 当前文件夹只有系统空间和工具与效率。读取存量 `work-group-group` 文件夹时原位展开其已保存应用为顶层条目，保留其他顺序、隐藏位置和折叠状态；后续保存只接受当前文件夹，不继续写入已退役分类。
- 回归：`test/sidebar-layout.test.js`、`test/frontend-sidebar-layout.test.js`；真实 Chromium 手势及共享 HTTP 存储验证运行 `test/sidebar-layout-browser-check.mjs`，隔离 fixture 不访问真实用户资产。

## 12b. 右侧面板注册表：面板清单的单一真相（2026-09-23）

右侧 rail 面板曾有三份平行真相：`index.html` 静态按钮、`app-ui.js` 的 `featurePanels` 表、`rail-customize.js` 的自定义清单（`CUSTOMIZABLE_IDS`/`LABELS`/`DESCS`）。新增面板要改三处，且新注册的面板不会进入自定义弹窗。现在统一收敛到宿主注册表 `modules/right-panel-registry.js`（`window.ClawPanels`）。

**注册**：面板经 `registerFeaturePanel(id, panel)`（`app-ui.js` 定义并挂 `window`）注册。注册项关键字段：

- `when`：适用性声明，支持 `surfaces`（`'chat'` / `'workspace'`）与 `agentIds` 两个维度，**声明的条件全部满足才适用（AND）**；缺省 `when` = 全局适用。上下文值缺失（如尚未解析出 agent）时，带条件的面板判为不适用。
- `label` / `description`：`{ zh, en }` i18n 元数据，面板显示名与自定义弹窗共用同一份。
- `title` / `render`：面板头部标题与渲染入口（沿用既有契约）。
- 同 ID 重复注册直接抛错（防止静默覆盖）；`render` 非函数抛错。

**rail 可见性**：`renderCurrentMainView` 每次渲染时用 `getAvailable({ agentId, surface })` 计算可用面板集合，控制按钮显隐；当前打开的面板不再适用时，清空 `activeFeaturePanel` 并立即 `renderFeaturePanel()`，旧上下文内容不得残留。注意 work-group 的 surface 判定：它是群聊但不是 chat 调试面板的宿主，registry 上下文里强制传 `surface: 'workspace'`。

**自定义面板（rail-customize）**：可自定义清单 = 已注册且 rail 上有按钮的面板（注册顺序 = 默认顺序）。没有 rail 按钮的程序化面板（如 preflight，从其他面板跳转打开）不进清单。用户偏好存 `localStorage`（用户级全局），加载时容忍旧配置：未知 ID 剔除、缺失面板按默认顺序追加、legacy ID 经 `LEGACY_ID_MAP` 映射。**用户隐藏偏好与面板适用性是两层独立过滤**：适用性决定"是否提供"，偏好决定"是否呈现"，隐藏始终全局生效。

**加载顺序约束（易错）**：`rail-customize.js` 初始化时从注册表派生清单，必须在所有面板贡献方之后加载——当前顺序为 `right-panel-registry.js` → `app-ui.js` → `resources-viewer.js` → `rail-customize.js`。新面板贡献方若在 rail-customize 之后注册，需自行调用 `window.applyRailConfig()` 重应用偏好。测试以 index.html 真实脚本序断言此约束。

**贡献边界**：注册表面向 Claw 内置模块；Feature 不直接注册右栏面板（未来经宿主 API 贡献，见右侧面板演进共识）。

回归测试：`test/frontend-right-panel-registry.test.js`（注册、上下文筛选、宿主接线源码断言）、`test/frontend-rail-customize.test.js`（清单派生、legacy 容忍、隐藏清理、加载顺序）。

---

## 12b. 长会话的滚动与折叠内容（2026-09-27）

- 原生 wheel 的通常路径保持 passive；需要 `preventDefault()` 的 Chrome 恢复补偿只在恢复时临时附加，消费后移除。不可为了未启用的补偿在每次 wheel 中走祖先样式/高度检测。
- 聊天滚动时先按页面状态排除 workspace/sticky/assembly 监听器，不在历史 DOM 中反复查询不存在的控件。阅读锚点自动保存等待停顿，切换缓存边界仍同步捕获并按 context key 隔离。
- `content-visibility` 和折叠的 `max-height` 都不等于释放 DOM。离屏占位也不能持续做背景位置动画。Read 长结果在默认折叠时仅构建 8 行预览，明确展开才生成全文，收起释放全文，原消息保留。
- 内置模板与动态 Feature 模板必须一起验收。Read 行号使用明确 `data-line`，保留源码 offset，避免 CSS counter 和旧行号 span 双重绘制。模板归一化发生在 Claw 的模板边界，不改 `node_modules` 中的发布产物。
- 性能验收覆盖跟随与阅读、原生滚轮与程序滚动、窗口门槛两侧；确认消息、行数、实际位移与模板加载状态。测 renderer 原生内存时明确其与 JS heap/GPU 内存的区别，不能只凭某一轮平均 FPS 或 DOM 节点数宣布修复。
- 差异表行号的 sticky 只用于展开后的横向阅读。折叠预览仍吸附会让被裁剪的单元格生成大量合成层；本次在 DOM 数不变时，取消折叠状态的吸附将末段图层从 399 降至 114。判断滚动热点要关联 LayerTree 与具体元素并做恢复对照，不能只看首次 render 或布局耗时。
- 旧过程窗口被禁用时，长过程会话由 `chat-row-visibility.js` 先读取真实行高，再隐藏远处整行，限制绘制和可访问性更新。必须保持 height/min-height 与 flex-shrink 占位保护；普通滚动使用缓存位置和像素缓冲，不全树测量、不边滚边折叠。末条补丁、显式展开、图片加载和宽度释放需刷新真实高度；退出过程模式/切换窗口机制时解除高度锁。
- 不把“没有 DOM 写入”或“元素低于 70,000”当成滚动流畅保证：浏览器仍有 native 工作。屏外隐藏不等于卸载 DOM；浏览器查找/连续选择/可访问性遍历存在隐藏内容边界，完整搜索应基于消息数据。一次隔离跑分不能替代实际客户端的前台滚动和最长停顿验收。
- 流式背景补丁（append / updateLastMessage 的 `fromIndex` 路径）在两种分级下都必须保持 background patch 语义：窗口锚定用户真实视口。虚拟化分级没有增量路径可走、落全量路径时曾把 viewportIdx 硬编码为末行——用户上翻阅读中的行被 cv 隐藏，工具-only 的 assistant 行成片退化为徽标 + 灰色占位（“空 assistant 消息”，长会话专属），直到刷新/显隐切换才恢复。回归测试：`test/frontend-process-windowing-background-patch.test.js`。

详见 [显示过程滚动调查与修复](../investigations/2026-09-27-chat-process-scroll-performance.md)。

## 12c. 多会话缓存与后台任务面板的成本边界

- 消息增量对比必须覆盖会影响渲染的结构化字段，包括 tool 结果的 `images` 附件；只比较正文会导致结果块先出现、附件变化却不触发更新，刷新后才可见。末条消息的局部 patch 也必须同步更新图片节点，不能只重建工具结果正文，否则全量重绘才会补出图片。长会话全量渲染与批量追加按工具调用 ID 在本次渲染内建立索引；工具结果不能逐条重扫完整消息列表，否则大量工具消息时接近平方增长。索引不跨会话持久保留。
- `_agentRuntimeCache` 为切回会话保留完整消息数组，不是永久历史仓库；它按最近写入淘汰，只保留有限的会话视图。被淘汰的会话仍可从运行时重新加载，当前会话数据不依赖缓存项存活。多标签页/桌面窗口各有独立 DOM 和缓存；缓存上限不限制当前聊天 DOM、浏览器合成层或 agent 子进程占用。
- 后台任务面板开启时从 `feature-comms` 订阅 **live-only** 流，再通过 `list` 请求读取任务现状；新打开的面板无需重放输出事件缓冲。SSE 自身重连带 `Last-Event-ID` 时仍从游标续接；游标落在缓冲外走 `resync` + `list`。服务端事件缓冲同时按条数与字节预算约束，所有实时事件仍直送已连接订阅者。
- 面板运行任务的时长由本地秒钟只更新文本，不每秒对全部卡片重新排序、拼接与比对 HTML。`list` 返回可能晚于 SSE 新事件：面板按任务记事件版本，列表只填补未被更新的任务，不能把已结束状态或最新输出退回旧快照。引擎会淘汰较老的终态任务，面板在 `finalized` 后通过 `list` 对账并移除已退出登记表的卡片；不能只累积事件。会话切换、关闭和重开也必须让旧请求结果失效。面板未开启时徽标只走 `count` 请求，不能每隔数秒提取所有任务的输出尾巴；开启时由流内任务状态驱动徽标。`bg` 面板不依赖 hooks，主轮询不要额外拉 `/hooks`。
- 后台任务面板自行消费事件并更新 DOM，注册时声明 `preserveOnReRender`，避免宿主重渲染再次替换输出区。进程输出与智能体摘要共用 `data-bgp-tail` 滚动恢复；摘要、更新时间走定点文本更新。结构重建前按完整任务键保存可见输出区的位置与贴底状态，折叠期间不从零尺寸元素覆盖记录；任务移除或会话切换时清理。上翻阅读保持位置，停在底部继续跟随。回归：`test/bg-panel-browser-check.mjs` 加载真实面板注册和宿主，覆盖事件更新后的宿主刷新、状态切换、折叠期间更新与重新展开。
- 上述控制的是浏览器缓存、空闲徽标流量和事件回放。长会话仍保留整棵聊天 DOM；新模板与工具卡会增加单会话的原生渲染资源，不能用 JS heap 或少量任务样本推断多窗口压力。实测需分开记录 renderer/GPU 进程、消息和 DOM 量级、并行会话与面板订阅数。

## 12d. 常驻装饰动画与玻璃面叠加的 GPU 成本（2026-09-30）

- 现象：网页版前台挂机时核显 3D 引擎持续 100%（风扇转、共享显存抬升），切后台或关标签立即消失；桌面版同页面不受影响。JS 堆、DOM、帧间隔全部正常——负载在合成/GPU 侧，不在主线程。
- 根因：`body::before` / `body::after` 两张 160% 视口固定层承载环境光晕，无限期 transform 位移动画 + `will-change` 常驻合成层。只要前台可见，合成器按刷新率持续出帧；且全屏动画层与侧栏/输入卡/面板的 5 处 `backdrop-filter` 玻璃面重叠，背景持续移动迫使模糊反复重算。
- 修复：光晕按原颜色/大小/位置并入 body 静态画布背景（元素坐标 × 1.6 换算回视口坐标），删除动画载体与 will-change。CDP 取证：活动动画 2→0、合成层 16→13、"active accelerated transform animation" 合成原因消失，玻璃效果不变。真机确认空闲 GPU 归零。
- 教训：装饰动画的成本必须按"页面空闲时"界定——不是"有没有用户交互"，而是"合成器是否仍被强制逐帧工作"。全屏层动画与 backdrop-filter 叠加是持续 GPU 负载的经典组合；其余 infinite 动画（spinner/pulse/shimmer）都挂在短生命周期小元素上，随状态出现消失，不构成常驻负载。headless Chromium 不持续产出合成帧，无法量化这类负载，结论需真机 GPU 曲线确认。

---

## 12e. coder 线程条目：threadId 键控的单叶子投影（2026-10-10）

线程宿主投影（`runtime-status.js collectRuntimeEntriesForPrebuilt`，按线程 `agentId` 归属 APP）把侧栏叶子从「每个存活 runtime 一条」升级为「每条线程一条」（[ADR-0024](../adr/0024-app-workspace-eternal-thread-model.md) 决策 4：稳定条目不随 successor 闪烁）：

- **只由当前 head 会话的 runtime 呈现**：非 head 成员 runtime（换代已推进后的退役滞留 / 历史棒次）一律不渲染。否则换代窗口新旧 runtime 并存时同线程双条目并列，点击旧条目被解析到新 head，成为生硬跳转（历史 bug，2026-10-10）。
- **身份锚定**：`_coderThreadLiveEntries` 保留线程首见条目的排序时间锚；存活 head 的归属每次按新快照解析，缓存分组只用于空窗占位。child 与宿主合成 runtime 必须走同一线程锚定路径，避免已知 head runtime 与占位各呈现一行。
- **会话字段只读投影**：左栏叶子的存在性来自 runtime / thread，标题来自宿主按 revision 合并的会话索引；索引缺席时才取 runtime / thread 摘要，不从会话历史制造叶子。assembly 会话继续以 `agentName` 呈现，operation 条目保留操作文案。`applySessionMutationDelta` 提交后同时刷新左栏与主视图，重命名处理器不再分别写宿主、runtime、线程几份标题。编辑期间暂停左栏 DOM 替换，结束编辑后消费最新事实。
- **归档约束**：归档或 closed 的线程成员不再呈现为运行条目，包含仍滞留在 agents 快照中的 child 与宿主合成条目；同一事实也清除接续占位。归档与 runtime 下线的先后顺序不应影响最终左栏。
- **head 空窗补位**：head runtime 未上线（退役窗口 / successor 启动中）且线程活跃（handoff 进行 / 置换 operation / executing）时，以缓存条目 + `disconnected + transitionPending` 占位，不闪失；线程闭合 / 归档 / 不活跃则清缓存。PH 线程接续中不另投影 trim/summary 操作条目，保留原线程行身份；过程信息由聊天视图的接续提示承载，左栏不显示「接力中」或「正在精简」等状态文字。普通非线程会话创建以及失败态提示保持原行为。
- **点击 = 打开线程 head 会话**：条目带 `data-thread-id`，点击经 `openConversationTarget`（thread-store.js）解析到 head，不直连 runtime。
- **状态发现（SSE 优先，轮询兜底）**：侧栏显式使用 `/protoclaw/events?threads=*` 订阅全部线程（含新建线程），不把历史线程 ID 集合拼进 URL；请求长度必须与历史规模无关。按 ID 订阅仍可用，服务端实时投递与 Last-Event-ID 重放共用过滤规则；前端全线程与定向 handler 合并去重。后台线程与当前会话同样消费创建、交接、换头、归档与删除事件。事件只触发事实刷新；`refreshThreads` 在更新索引和会话指向后驱动左栏与主视图，周期刷新走同一提交边界。换头重绑仍校验当前视图归属，不因后台线程事件切换用户会话；`/protoclaw/threads` contentHash 周期刷新（20s）负责断连恢复。历史事故：枚举 ID 产生超长 `:path`，公网 HTTP/2 对端发送 `GOAWAY ENHANCE_YOUR_CALM` 并关闭整条连接，同连接的普通 API 与面板 SSE 一并报错；不能通过关代理、截断订阅或放宽入口限制掩盖无界寻址。回归：`test/frontend-sse-client.test.js` 使用真实 thread-store 与 SSE client 驱动大历史和新线程发现，`test/thread-sse-events.test.js` 覆盖全线程实时与重放。
- **渲染签名**：`getAgentListRenderSignature` 必须包含线程标题 `headSessionTitle`、归档 `archivedAt`、`status`，以及 head、运行态、挡板等投影输入；会话索引中的标题及 assembly 显示名也参与签名。数据变化后由提交方调用渲染，签名只负责跳过未变内容。
- **APP 身份与运行态可见性分离**：Coder APP 条目来自 metadata 声明，具体是否呈现由 `/api/agents` 的 `sidebarVisible` 决定。默认 `auto` 认「存活且绑定 Session 的 managed Runtime，或 rotating 接续挡板在途（删除事务窗口内除外）」——接续空窗（旧 head 退役、successor 未上线）期间入口保持，配合下方接续占位实现无感连续。未归档线程资产（open/hold/rotation_failed 等非终态）不代表运行态、不撑入口（ADR-0025 2026-10-18 回摆）；线程和历史仍可从 APP 首页查看；设置为 `always` 时 APP 入口常驻，但不合成运行会话叶子。相关合流见 `server/routes/agent-connected.js`，按接续帧覆盖的回归测试见 `test/sidebar-projection-succession.test.js`。
- **`handoffStartedAt` 是 wire 字段（服务端投影，勿在前端另造）**：顶栏「接力中」指示器、输入路由守卫（交接窗口内输入改走 Thread Inbox 暂存）、侧栏交接占位共用 `thread.handoffStartedAt`（>0 且 <5min 视为交接中）。权威值 = `/protoclaw/threads` 对 `status='rotating'` 线程补读的 `pendingSuccession.startedAt`（`thread-routes.js` `_attachLifeState`）。历史事故（2026-10-10）：前端三处消费一个服务端从未下发的字段名，指示器永不亮、自动轮换窗口内输入被判 direct 直投已退役 runtime。

回归测试：`test/frontend-sidebar-freshness.test.js`（归档 / 重命名 / 后台线程事件 / 编辑保护与去重跨模块链路）；`node test/sidebar-freshness-browser-check.mjs`（隔离 Chromium 的 Enter 保存与虚影退场）；`test/frontend-runtime-status.test.js`（coder live session projection：head 推进 / zombie 并存 / head 空窗全时间线）；`test/frontend-thread-store-t006.test.js`（thread 事件消费：handoff-started 状态刷新 / head-advanced 原地重绑）；`test/sidebar-projection-succession.test.js`（宿主层：接续窗口投影条目逐帧存续）；`test/thread-routes-command-fields.test.js`（wire：handoffStartedAt 挡板投影与收敛）；`test/thread-control.test.js`（挡板身份镜像的立/清对称）。

---

## 12f. APP 型工作空间首页快记输入框：app-chat-input block（2026-10-14）

宿主通用能力，APP 纯声明接入（首个消费者：memo 首页）。模块 `modules/app-chat-input.js`，样式 `styles/app-chat-input.css`，完整契约见模块头注。核心边界：

- **声明与分发分离**：APP 在 `metadata.json` `ui.home.blocks` 声明 `{ type: "app-chat-input", resolveEndpoint, ensureEndpoint, placeholder }`；`app-ui.js renderWorkspaceBlock` 按通用 type 分发，公共代码零 APP ID 分支。配置不完整渲染空串（与未知 block 同为可拔插基线，不报错不占位）。
- **双端点契约**：`resolveEndpoint`（GET，返回 `{ ok, threadId }` 或 `{ ok, activeThread: { threadId } }`）+ `ensureEndpoint`（POST，空态创建事务）。发送编排：resolve 有 threadId → 直接 `POST /protoclaw/threads/:threadId/input`（宿主通用：head runtime 唤起 + 投递 + 交接窗口 Inbox 暂存，直投与 `thread_queued` 同为成功）；无 → ensure 创建后再投递。常态一跳轻查询，重事务只在真需要创建时发生。
- **「唯一活动对话是 APP 业务状态」边界不动**（[ADR-0024](../adr/0024-app-workspace-eternal-thread-model.md) 决策 1）：宿主通用的是渲染与投递，对话选择逻辑（resolve/ensure 语义）留在 APP 端点。toast「查看回复」动作复用 `start_app_conversation` 导航链（endpoint 即 ensureEndpoint）。
- **语音复用主链路**：voice 按钮 `data-target` 指向 block textarea，录音/转写/声效/pendingSend 全部走 `voice-input.js` 既有逻辑；自动发送经 `_dispatchVoiceAutoSend` 的 `'app-chat-input-textarea-'` 前缀分支交回本模块 `submit`。新增同类输入面时优先扩前缀委托，不复制语音实现。
- **易错点**：`render()` 在 `innerHTML` 赋值前组串，DOM 修正（autoResize、录音态按钮重绑）必须 `setTimeout` 下一拍执行且 `getElementById` 落空安全 no-op（视图可能已切走）；草稿 key 为 `app-chat-input:<agentId>`（复用 `_sessionInputCache` 但独立命名空间，不污染对话视图会话草稿）；发送全程 in-flight 防重入；成功后清输入须按 id 重查 live 元素（await 期间重渲染会换节点）。

配套通用扩展：`ClawToast.show` 支持 `action: { label, onClick }`（`modules/toast-notify.js` + `styles/toast.css`）。

---

## 12g. 模型状态的统一提交与版本顺序（2026-10-20）

- 当前模型参数作为一组状态进入 `SessionView.overview`：`modelRevision`、`modelName`、`presetName`、`provider`、`thinkingEffort`、`contextLength`、`compressRatio`。归一化集中在 `session-view-state.js` 的 `normalizeSessionModelState`，回执与 Overview 共用。
- 模型/思考强度切换在请求前捕获视图 token，成功后通过 `commitSessionViewPatch(token, { model: result.meta })` 提交；SSE、poll 和初始加载通过同一入口提交 Overview。同 runtime 的较低版本仅保留其非模型数据，模型参数整组沿用已接收版本；不能按名称或档位是否出现“第三个值”猜测先后。
- 版本由框架 Agent 每次 `setLLM` 生效递增，回执与 Overview 同源输出；runtime 更换后重新比较。同步 reset / cache restore 通过 `applySessionViewPatch` 整体替换视图，不受上一视图版本阻挡。无版本的旧远端可以显示，但没有乱序判定保证（完整契约见 ADR-0009）。
- 输入框模型与思考强度、顶部模型名和用量条只读已提交状态；历史 Session 参数不填补当前模型，未知窗口呈空态。切模型保留已记录用量，只按新窗口重算占比；已展开的详情随顶栏数据刷新。`session-ui.js` 的窗口缓存仅服务历史会话列表。
- 回归覆盖：`test/input-model-swap-optimistic.test.js`（真实请求处理、统一提交与渲染，含乱序回执、旧快照、同名切换、Session 回访、runtime 重启、同步重置/缓存恢复、详情刷新）；`test/model-swap-smoke.test.js`（真实子进程版本回执）。

---

## 13. 相关文件索引

> 行号会随迭代漂移，定位时以 grep 为准，本表只给文件级归属（2026-08-23 复核）。

| 职责 | 文件 |
|---|---|
| `renderCurrentMainView`、`renderWorkspaceSurface`、`resetRuntimeBackedSurfaceState`、`shouldRenderWorkspaceSurface`、`selectWorkspaceSurface` | `public/src/app-ui.js` |
| `poll` 主循环（`schedulePoll`/`runPollCycle`）、`switchAgent`、`requestSwitch`/`flushPendingSwitch`、`handlePrebuiltAgentClick`、`navigateToWorkspaceSession`、`createCompactedResumeSession` | `public/src/app-main.js` |
| `loadAgentData`、`refreshCurrentRuntimeStatus`（stale check 范例） | `modules/agent-data-loader.js` |
| `loadAgents`、`renderAgentList`、`renderAgentGroup`、`renderSidebarChildItems`（统一投影消费）、侧边栏渲染 | `modules/sidebar-render.js` |
| 远程 catalog 数据、`getRemoteSidebarProjection`、`resolveRuntimeRef` | `modules/remote-connections.js` |
| `render`、`renderMessage`、`appendNewMessages`、`updateLastMessage` | `modules/chat-renderer.js` |
| `runWorkspaceAction`（workspace action 分发器）、`reloadRuntimeForSessionSwitch` | `modules/workspace-actions.js` |
| APP 型工作空间首页快记输入框（`app-chat-input` block：渲染、resolve/ensure 发送编排、语音接线） | `modules/app-chat-input.js` |
| `renderInputRequests`、`getInputRenderSignature` | `modules/input-render.js` |
| 持久输入 / 队列 / `interruptAgent` / `_syncPersistentInputUi` | `modules/persistent-input.js` |
| `updateNotificationStatus`、`isRuntimeCalling`、运行状态栏 | `modules/runtime-status.js` |
| `normalizeHookInspector`、`setCurrentHookInspector` | `modules/overview-data.js` |
| runtime context key、per-session optimistic cache、viewer 会话绑定（`setViewerSessionBinding`） | `app-core.js` |
| session 草稿（`_sessionInputCache`、`_storeVisibleSessionInputDraft`） | `modules/voice-input.js` |
| `ensureIMWorkspaceLoaded`、IM 渠道 UI / 交互回调 | `modules/im-ui.js` / `modules/im-actions.js` |
| `loadDispatchSchedules`、`refreshDispatchConsoleData`、调度控制台 UI | `modules/dispatch-actions.js` / `modules/dispatch-ui.js` |
| 右侧面板注册表（`ClawPanels`）、面板适用性与自定义清单派生 | `modules/right-panel-registry.js` / `modules/rail-customize.js` |
| session context、optimistic input mode、草稿恢复与 DOM key 的回归测试 | `test/session-ui-context.test.js` |
