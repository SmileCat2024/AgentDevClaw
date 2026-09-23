# Claw 前端渲染机制与常见陷阱

> **活文档** — 本文持续积累前端渲染相关的设计契约与踩坑记录。
> 每次遇到渲染层的新问题或提炼出新结论时，请更新对应章节，或在文末追加新章节。
> 保持每个条目简短、有代码示例、有判断依据，便于后续 agent 直接复用。
>
> 最后更新：2026-08-27（新增 12a：侧栏统一投影与运行会话高亮）

---

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

步骤 6 的 `loadAgentData` 完成后，页面已经正确渲染新 agent 的消息。**之后任何使用旧 agent ID 的异步回调都可能导致闪烁**。

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

## 8c. 运行胶囊计时状态属于会话，切换必须清零（2026-08-19）

`_renderLastCallElapsed`（1s interval）依赖三个模块级变量：`_lastCallFinishTime`、
`_runCapsuleStartAt`、`_runCapsuleStartConfirmed`。切换会话时若只清 `_lastCallFinishTime`：

- 切到正在运行的会话：快照未到达时沿用**上一会话**的起始时间
- `confirmed=true` 遗留 → 只接受更晚的快照值 → 若新会话本轮 call 起得更早（并行会话常态），错误时长永远无法纠正

修复：`loadAgentData` 与 `_lastCallFinishTime = 0` 同点清零全部三个变量；
`resetRuntimeBackedSurfaceState` 的 `updateNotificationStatus` 必须传 `null`（falsy）而非 `{}`——
`_lastCallFinishTime = 0` 只对 falsy 入参生效。

---

## 8d. 前端→agent 控制投递必须用 runtimeId 定位，sessionId 仅作 fallback（2026-08-19）

### 问题

前端→agent 运行时控制 IPC（开关 / 中断 / 热切换类，如 `todo_control`、`tool_state`、`swap_model`）
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

### 修复模型：三级优先解析（对齐 swap_model / tool_state 已验证模式）

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
| `renderInputRequests`、`getInputRenderSignature` | `modules/input-render.js` |
| 持久输入 / 队列 / `interruptAgent` / `_syncPersistentInputUi` | `modules/persistent-input.js` |
| `updateNotificationStatus`、`isRuntimeCalling`、运行状态栏 | `modules/runtime-status.js` |
| `normalizeHookInspector`、`setCurrentHookInspector` | `modules/overview-data.js` |
| runtime context key、per-session optimistic cache、viewer 会话绑定（`setViewerSessionBinding`） | `app-core.js` |
| session 草稿（`_sessionInputCache`、`_storeVisibleSessionInputDraft`） | `modules/voice-input.js` |
| `ensureIMWorkspaceLoaded`、IM 渠道 UI / 交互回调 | `modules/im-ui.js` / `modules/im-actions.js` |
| `loadDispatchSchedules`、`refreshDispatchConsoleData`、调度控制台 UI | `modules/dispatch-actions.js` / `modules/dispatch-ui.js` |
| session context、optimistic input mode、草稿恢复与 DOM key 的回归测试 | `test/session-ui-context.test.js` |
