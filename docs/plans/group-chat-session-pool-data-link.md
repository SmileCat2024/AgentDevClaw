# 群聊会话池：数据链路设计文档

> **状态**：已落地（2026-06-26 修复态势感知链路断裂、运行状态判定、popover 稳定性等问题）
> **定位**：群聊工作空间中"会话池"概念的权威数据链路参考。后续修改态势感知面板、成员 popover、中断控制等功能前必读。
> **关联文档**：[group-chat-command-center-design.md](./group-chat-command-center-design.md)、[investigations/2026-06-22-group-chat-investigation-and-ui-refactor.md](../investigations/2026-06-22-group-chat-investigation-and-ui-refactor.md)

---

## 1. 会话池概念定义

群聊中的每个 Agent 身份（如"编程小助手·主代理"）在群内可以拥有一个或多个会话。这些会话统称为该群聊的**会话池**。

会话池的成员有三个来源：

| 来源 | 数据位置 | 典型场景 |
|------|---------|---------|
| **持久映射** | `chat.sessions[identityRef] → sessionId` | persistent 身份首次被 @mention 后自动创建并复用 |
| **消息路由派生** | `chat.messages[].routing.targetSessionId` | one-shot 身份每次 @mention 创建新会话；或用户指定特定会话派发 |
| **外部导入** | `chat.importedSessions[]` | 用户从其他工作空间引入已有会话到本群管理 |

管理员（`work-group:admin`）有独立的会话管理机制（上下文滚动、健康度监控），不属于成员会话池，在态势感知面板中有独立的 chip 展示。

---

## 2. 态势感知面板：渲染链路

### 2.1 整体数据流

```
3s 轮询定时器 (startPolling)
  │
  ├─ loadActiveChat()
  │   GET /protoclaw/group_chats/:chatId
  │   → activeChat（完整群聊对象，含 messages、sessions、importedSessions）
  │
  ├─ fetchRuntimeStatus()
  │   GET /protoclaw/gc/runtime_status?chatId=:chatId
  │   → _runtimeStatusCache = { sessionId → { identityRef, sessionId, workspaceId, displayName, status, lastActivity } }
  │
  └─ refreshAdminBarOnly()
      │
      ├─ popover 正在显示？
      │   → _updateAwarenessDotsInPlace()：原地更新 chip 状态点（不替换 DOM）
      │   → _refreshPopoverIfOpen()：刷新 popover 内会话列表运行状态
      │
      └─ popover 未显示？
          → renderAwarenessBar(activeChat)：全量替换 DOM
          → 如果 _hoverIdentity 有值（120ms hover delay 窗口内），
             在新 DOM 中找到对应 chip 并重新绑定 hover timer
```

### 2.2 前端缓存生命周期

| 缓存 | 变量 | 何时清除 | 覆盖范围 |
|------|------|---------|---------|
| 运行时状态 | `_runtimeStatusCache` | `selectChat()` 切换群聊时重置为 `{}` | 当前群聊所有会话池成员的运行状态 |
| 会话数据 | `_sessionDataCache` | `selectChat()` 切换群聊时重置为 `{}` | 单个身份的群内会话列表 + 外部可引入会话 |

**关键不变量**：`selectChat()` 必须在渲染前清除这两个缓存，否则上一个群聊的数据会泄漏到新群聊的态势栏中。`selectChat()` 在清除缓存后会立即调用 `fetchRuntimeStatus()`，确保态势栏在首次渲染时就拿到正确数据。

**_sessionDataCache 不做 TTL**：`showMemberPopover` 每次悬停都重新调用 `fetchSessionData()` 拉取最新数据，不依赖缓存。这确保群内新建会话后 popover 能立即反映，不需要切换群聊刷新。

### 2.3 renderAwarenessBar：成员级 chip 渲染

态势栏渲染的是**成员级 chip**（每个群成员一个），而非 session 级 chip。每个成员 chip 的状态是该成员所有会话的聚合：

```javascript
renderAwarenessBar(chat)
  │
  ├─ 管理员 chip（renderAdminChip）
  │   → 独立区域，含在线状态 + 健康度 + 重启按钮
  │   → 数据来自 _adminStatus（由 loadActiveChat 并行加载）
  │
  ├─ 成员 chips（.wg-awareness-members）
  │   遍历 chat.members（排除 user 和 admin）
  │   → 每个成员一个 .wg-member-chip
  │   → 带 data-wg-member-identity（触发 hover popover 的关键属性）
  │   → 聚合状态点：getMemberAggregateStatus(identityRef)
  │     running（任一 session running）> idle（任一 online）> offline
  │
  └─ 引入按钮 → 打开会话导入弹窗
```

**设计理由**：态势栏的空间有限。一个成员可能有多个会话，但用户首先关注的是"谁在线、谁在跑"。成员级 chip 让态势栏保持紧凑，详细会话信息通过 hover popover 查看。

### 2.4 服务端 GET /protoclaw/gc/runtime_status

**文件**：`server.js`

此接口是态势感知面板的唯一实时数据源。它从三个来源聚合会话池，然后逐一查询实际运行时状态。

```
输入：chatId
  │
  ├─ readGroupChat(chatId)
  ├─ collectIdentities() → 身份显示名解析
  │
  ├─ 聚合会话池（三路合并，去重 key = identityRef:sessionId）
  │   ├─ Source 1: chat.sessions 映射（排除 admin，排除空值）
  │   ├─ Source 2: chat.messages 路由（排除 failed，排除 admin）
  │   │   含 pending / delivered / completed / interrupted 状态
  │   └─ Source 3: chat.importedSessions（通过 workspaceId 匹配群成员身份）
  │
  ├─ 对每个会话查运行时状态
  │   getManagedRuntimeKey(workspaceId, sessionId) → managedAgents.get(key)
  │   ├─ runtime 不存在/已退出/已停止 → status: 'offline'
  │   └─ runtime 存活 → readViewerJson('/api/agents/:viewerAgentId/notification')
  │       ├─ callActive === true  → status: 'running'
  │       └─ callActive === false → status: 'idle'
  │
  └─ 返回 { sessions: [...] }
```

**关键设计决策**：

- **使用 `/notification` API 而非 `/running` API**。ViewerWorker 的 `/running` 端点仅检查 UDS socket 连通性，在进程存活时永远返回 `{running: true}`，无法区分"有 call 正在执行"和"进程空闲等待"。`/notification` 的 `callActive` 字段由 `call.start` / `call.finish` 事件精确维护，能准确反映会话是否真正处于调用中。
- **已完成的会话（routing status = completed）不会被过滤掉**。任务完成后会话仍然存在于池中，只是运行状态变为 idle/offline。用户需要看到所有池内会话的全貌。
- **管理员会话（work-group:admin）在所有来源中被排除**。管理员有独立的展示和健康度监控机制。
- **failed 状态的路由条目被排除**。失败的任务不应当在态势栏制造噪音。

---

## 3. 成员 Popover：会话列表链路

### 3.1 Hover 交互时序

```
用户鼠标进入 member chip
  │
  ├─ onContainerMouseOver(e)
  │   e.target.closest('[data-wg-member-identity]') 匹配
  │   → 清除 _popoverHideTimer
  │   → 如果 _hoverIdentity 变化：设置 120ms 延迟
  │     _hoverTimer = setTimeout(() => showMemberPopover(...), 120)
  │
  ├─ showMemberPopover(identityRef, anchorEl)
  │   │
  │   ├─ 每次重新 fetchSessionData(identityRef)
  │   │   GET /protoclaw/group_chats/:chatId/sessions/:identityRef
  │   │   → _sessionDataCache[identityRef] = {
  │   │       inChatSessions: [{ id, title, isActive, createdAt }],
  │   │       externalSessions: [{ id, title }],
  │   │       sessionModel, activeSessionId
  │   │     }
  │   │
  │   ├─ 构造 popover HTML
  │   │   ├─ header（成员名 + 模式标签/管理员状态）
  │   │   ├─ 派发设置区（仅当成员被 @mention 时）
  │   │   ├─ 会话列表区（见 3.2）
  │   │   └─ 引入外部会话区（仅非管理员，可折叠）
  │   │
  │   └─ appendChild 到 body + 定位（anchorEl 下方 4px）
  │
  └─ 用户鼠标离开
      │
      ├─ onContainerMouseOut(e)
      │   relatedTarget 不是 popover 或其他 chip → 80ms 延迟后 hideMemberPopover()
      │
      └─ 鼠标进入 popover 自身
          clearTimeout(_popoverHideTimer) → 保持显示
```

**Hover 稳定性保证**：

轮询期间 `refreshAdminBarOnly()` 会替换 `.wg-awareness` DOM。如果替换发生在 120ms hover delay 窗口内，原 anchor chip 已被销毁。修复：替换后检查 `_hoverIdentity`，在新 DOM 中找到对应 chip 并重新绑定 timer。当 popover 正在显示时（`_popoverEl && _hoverIdentity`），不做全量替换，改为原地更新状态点 + 刷新 popover 内容。

### 3.2 成员会话列表渲染

**渲染函数**：`_renderPopoverSessionList(identityRef, data)`

每个会话项包含：

| 元素 | 说明 |
|------|------|
| 状态点 | running（脉冲动画）/ idle（静态绿点）/ offline（灰点），从 `_runtimeStatusCache` 交叉引用 |
| 会话标题 | `s.title`，活跃会话追加 `<span>当前</span>` 标记 |
| 派发至此按钮 | 仅当成员被 @mention 且该会话未被选为派发目标时显示 |
| 中断按钮 | 仅当 `rtStatus === 'running'` 时显示，点击后调 `gc/control` 中断 |
| 导航行为 | `data-wg-session-nav`：点击跳转到会话（交互式，可发送消息） |

**关键设计决策**：成员会话一律使用 `data-wg-session-nav`（跳转导航），不论是否为活跃会话。成员会话点击后是可交互的会话视图，不是只读记录。

### 3.3 管理员会话列表渲染

**渲染函数**：`_renderAdminSessionList(data)` → 返回 `{ activeHtml, historyHtml, historyCount }`

管理员的 popover 与成员有本质区别：

| | 成员 popover | 管理员 popover |
|---|---|---|
| header | 成员名 + 模型标签 | "管理员" + 在线状态 badge |
| 活跃会话 | 混在会话列表中，标记"当前" | 顶部独立跳转按钮"跳转到当前会话" |
| 历史会话 | 与活跃会话一起，全部 `data-wg-session-nav` 跳转 | 独立"历史会话记录"列表，`data-wg-session-record` 只读 |
| 会话命名 | `s.title` | `_formatSessionTime(s.createdAt)` → `MM-DD HH:MM` |
| 运行状态点 | running/idle/offline | 统一 offline（静态） |
| 派发选项 | 有（@mention 时） | 无 |
| 中断按钮 | 有（running 时） | 无 |
| 引入功能 | 有 | 无 |

**设计理由**：管理员会话的管理价值（管理元数据）远大于其会话池管理价值（查看会话内容）。活跃会话给一个跳转入口即可，历史会话只需以只读方式查阅。用创建时间而非 title 命名是因为管理员会话的 title 通常是自动生成的，缺乏可读性。

### 3.4 服务端 GET /protoclaw/group_chats/:chatId/sessions/:identityRef

**文件**：`server.js`

此接口返回指定身份在本群中的完整会话视图。与 `runtime_status` 不同，它不查询运行时状态，而是返回会话的元数据（标题、创建时间、是否活跃）。

群内会话的判定条件（满足任一即属于群内）：
1. 出现在 `chat.sessions[identityRef]` 映射中（精确匹配 identityRef）
2. 出现在消息路由中（`msg.routing.targetIdentityRef === identityRef`）
3. 是管理员的历史会话（`chat.adminSessionHistory`）
4. 是已导入的外部会话（`chat.importedSessions` 中 workspaceId 匹配）

返回字段 `inChatSessions` 包含 `{ id, title, isActive, createdAt }`。`createdAt` 从会话索引（`readSessionIndex`）中解析。

外部会话 = 该 workspace 的全部会话中，不在上述群内会话集合中的会话（取最近 20 条）。

---

## 4. 中断控制链路

### 4.1 数据流

```
popover 内"中断"按钮点击
  │
  ├─ popover click handler
  │   ev.target.closest('[data-wg-action="interrupt-session"]')
  │   ev.stopPropagation()
  │   按钮变为 disabled
  │
  ├─ handleInterruptSession(identityRef, sessionId, workspaceId)
  │   POST /protoclaw/gc/control
  │   body: { chatId, identityRef, sessionId, action: 'interrupt' }
  │
  ├─ 服务端 gc/control 处理
  │   1. resolveSessionId（传入的 sessionId 或从 chat.sessions 查找）
  │   2. getAgentRuntime(workspaceId, sessionId) → runtime
  │   3. POST ViewerWorker /api/agents/:viewerAgentId/interrupt
  │   4. appendGroupChatMessage → 写入 "[任务已中断]" 系统消息
  │   5. 返回 { ok: true }
  │
  └─ 前端回调
      fetchRuntimeStatus() → 刷新态势栏 + popover 内容
```

### 4.2 历史踩坑

**BUG（已修复 2026-06-26）**：`onContainerClick` 的 interrupt-session 分支使用了 `ev.stopPropagation()`，但函数参数名是 `e`。在 strict mode 下 `ev` 未定义，抛出 `ReferenceError`，导致中断按钮完全失效。修复：`ev` → `e`。

**BUG（已修复 2026-06-26）**：`runtime_status` 接口使用 ViewerWorker `/running` API 判定运行状态，该 API 在进程存活时永远返回 `running: true`（仅检查 UDS socket 连通），不反映 call 是否在执行。中断后进程仍存活，状态永远为 running，中断按钮永不消失。修复：改用 `/notification` API 的 `callActive` 字段。

---

## 5. 派发时的会话解析链路

### 5.1 resolveGroupChatSession

**文件**：`server.js`

当用户在群聊中 @mention 一个身份时，服务端需要解析或创建对应的会话。解析逻辑按优先级：

```
resolveGroupChatSession(chatId, identityRef, sessionModel, options)
  │
  ├─ identityRef === 'work-group:admin'
  │   → 加互斥锁（withAdminSessionLock），防止并发创建多个 admin session
  │
  ├─ _resolveGroupChatSessionInner()
  │   ├─ sessionModel === 'one-shot' → 总是创建新 session
  │   │
  │   ├─ options.targetSessionId → 精准路由到指定会话（更新映射）
  │   │
  │   ├─ options.forceNew → 强制创建新会话（更新映射）
  │   │
  │   └─ persistent（默认路径）
  │       ├─ chat.sessions[identityRef] 存在且有效 → 复用
  │       ├─ admin: 检查上下文是否超限 → 超限则滚动到新 session
  │       └─ 不存在或已失效 → 创建新 session 并更新映射
  │
  └─ 返回 { sessionId, isNew }
```

### 5.2 会话映射的持久化

`chat.sessions` 映射在每次 `resolveGroupChatSession` 创建/切换会话时通过 `writeGroupChat()` 持久化到 JSON 文件。

文件路径：`~/.agentdev/AgentDevClaw/group-chats/<chatId>.json`

```json
{
  "id": "chat-xxx",
  "sessions": {
    "programming-helper:main": "session-aaa111",
    "work-group:admin": "session-bbb222"
  },
  "importedSessions": [
    {
      "workspaceId": "flow-workspace",
      "sessionId": "session-ccc333",
      "title": "支付重构",
      "workspaceName": "Flow工作空间",
      "importedAt": 1719400000000
    }
  ]
}
```

---

## 6. 前端缓存与群聊隔离

### 6.1 跨群聊缓存清除

`work-group-ui.js` 中的模块级状态变量在 `selectChat()` 切换群聊时必须被重置：

| 变量 | 类型 | selectChat 中的处理 |
|------|------|-------------------|
| `_runtimeStatusCache` | `Object` | 重置为 `{}` |
| `_sessionDataCache` | `Object` | 重置为 `{}` |
| `_adminStatus` | `Object \| null` | 重置为 `null` |
| `_adminRestarting` | `Boolean` | 重置为 `false` |
| `activeChat` | `Object \| null` | 重置为 `null`，随后通过 `loadActiveChat()` 重新加载 |
| `openDropdown` | `String \| null` | 重置为 `null` |

`selectChat()` 执行流程：

```
selectChat(chatId)
  │
  ├─ _saveCurrentDraft(oldChatId)
  ├─ 重置全部模块级缓存变量
  ├─ hideMemberPopover(true) + closeImportModal()
  │
  ├─ refreshMain()           ← 第一次渲染（态势栏此时为空或全 offline）
  ├─ loadActiveChat()        ← 加载群聊数据
  ├─ fetchRuntimeStatus()    ← 加载运行时状态（关键：在第二次渲染前执行）
  ├─ refreshMain()           ← 第二次渲染（态势栏已有正确数据）
  └─ _restoreEditorFromDraft(chatId)
```

### 6.2 按群聊隔离的输入状态

以下变量按 `chatId` 做 key 隔离，切换群聊时不清除（保存/恢复机制）：

| 变量 | key 结构 |
|------|---------|
| `_chatInputCache` | `chatId → { editorHtml, pendingLinks, pendingAttachments }` |
| `_chatSessionSelection` | `chatId → { identityRef → { mode, sessionId, sessionTitle } }` |

### 6.3 历史踩坑

**BUG（已修复 2026-06-26）**：`selectChat()` 不清除 `_runtimeStatusCache` 和 `_sessionDataCache`，导致从群 A 切到新群 B 时，群 B 的态势栏立即渲染群 A 的会话数据（"脏数据"）。用户看到新创建的空群里已经有会话。

**BUG（已修复 2026-06-26）**：`refreshAdminBarOnly()` 每 3 秒全量替换 `.wg-awareness` DOM。当 popover 正在显示时，替换会销毁 popover 的 hover 锚点链路，导致 popover 消失。修复：popover 打开时改为原地更新状态点。

---

## 7. 代码入口索引

### 7.1 服务端（server.js）

| 功能 | 位置（约） | 说明 |
|------|-----------|------|
| 群聊存储 | `readGroupChat()` / `writeGroupChat()` | JSON 文件读写 |
| 会话解析 | `resolveGroupChatSession()` ~L6747 | persistent 复用 / one-shot 新建 / 管理员滚动 |
| **态势感知** | `GET /protoclaw/gc/runtime_status` ~L7190 | 三路聚合会话池 + `/notification` 运行时状态查询 |
| 派发 | `dispatchToIdentity()` ~L7300 | 会话解析 → runtime 启动 → inbox 投递 → 事件卡片 |
| **中断控制** | `POST /protoclaw/gc/control` ~L7081 | ViewerWorker interrupt + 群聊状态消息 |
| 成员会话列表 | `GET /protoclaw/group_chats/:chatId/sessions/:identityRef` ~L8255 | 群内会话 + 外部可引入会话 |
| 管理员状态 | `GET /protoclaw/group_chats/:chatId/admin_status` ~L8412 | 在线状态 + 上下文健康度 |
| 导入会话 | `POST /protoclaw/group_chats/:chatId/import_session` ~L8537 | 外部会话引入到会话池 |

### 7.2 前端（work-group-ui.js）

| 功能 | 位置（约） | 说明 |
|------|-----------|------|
| **态势层渲染** | `renderAwarenessBar()` ~L371 | 成员级 chip，带 `data-wg-member-identity` |
| 成员聚合状态 | `getMemberAggregateStatus()` ~L362 | 按成员聚合 running/idle/offline |
| 管理员 chip | `renderAdminChip()` ~L311 | 独立的管理员状态展示 |
| 运行时状态拉取 | `fetchRuntimeStatus()` ~L1230 | 3s 轮询调 `gc/runtime_status` |
| **态势栏刷新** | `refreshAdminBarOnly()` ~L1134 | popover 打开时原地更新，否则全量替换 + hover 重绑 |
| **群聊切换** | `selectChat()` ~L1305 | 缓存清除 + fetchRuntimeStatus + 渲染 |
| **成员 popover** | `showMemberPopover()` ~L1464 | 每次重新 fetch + 渲染会话列表 |
| 成员会话列表 | `_renderPopoverSessionList()` ~L1371 | running/idle/offline 状态 + 导航 + 中断 |
| 管理员会话列表 | `_renderAdminSessionList()` ~L1433 | 活跃跳转 + 只读历史（创建时间命名） |
| 会话时间格式化 | `_formatSessionTime()` ~L1416 | `MM-DD HH:MM` |
| 会话数据拉取 | `fetchSessionData()` ~L1845 | 调 `sessions/:identityRef` 接口 |
| **中断处理** | `handleInterruptSession()` ~L2341 | 调 `gc/control` 中断指定会话 |
| Hover 事件 | `onContainerMouseOver()` ~L1691 / `onContainerMouseOut()` ~L1704 | 120ms 开启 / 80ms 关闭 |
| Popover 刷新 | `_refreshPopoverIfOpen()` ~L1168 | 轮询时刷新 popover 内会话运行状态 |
| 点击事件代理 | `onContainerClick()` ~L2370 | 所有按钮 action 分发 |

### 7.3 前端样式（work-group.css）

| 样式类 | 说明 |
|--------|------|
| `.wg-member-chip.running/.idle/.offline` | 成员 chip 状态（含脉冲动画） |
| `.wg-pop-dot.running/.idle/.offline` | popover 内 per-session 状态点 |
| `.wg-pop-interrupt-btn` | popover 内中断按钮 |
| `.wg-pop-admin-jump` | 管理员活跃会话跳转按钮（accent 色风格） |
| `.wg-pop-dispatch-to` | 派发至此按钮 |

### 7.4 测试

| 文件 | 覆盖范围 |
|------|---------|
| `test/group-chat-data-layer.test.js` | CRUD 操作、派发 prompt 组装、**会话池聚合逻辑**（`aggregateSessionPool`） |

---

## 8. 已知设计决策与局限性

### 8.1 已完成会话仍在态势栏可见

任务完成后（routing 变为 completed），会话不会从态势栏消失。它的运行状态会从 running 变为 idle 或 offline（取决于 runtime 是否仍存活）。

**理由**：用户需要看到完整的会话池全貌来做出管理决策。如果已完成的会话消失，用户会误以为会话被删除了。

**潜在问题**：如果一个群有大量历史会话，态势栏会比较拥挤。未来可能需要：
- 对 idle/offline 的会话做视觉弱化（灰显）
- 或在态势栏只展示 running + 最近 N 条 idle 会话

### 8.2 _sessionDataCache 的 key 设计

当前 `_sessionDataCache` 的 key 是 `identityRef`，不包含 `chatId`。这在 `selectChat()` 中通过整体清除来保证正确性。`showMemberPopover` 每次都重新 fetch，所以缓存实际上只服务于同一 hover 周期内的多次读取（如 popover 内交互后重新渲染）。

如果未来需要同时缓存多个群聊的会话数据（如分屏显示多个群聊），需要改为 `chatId:identityRef` 复合 key。

### 8.3 导入会话的 identityRef 解析

导入的外部会话可能来自不在群成员列表中的 workspace。此时 `identityRef` 回退为 `{workspaceId}:main`。如果该 workspace 的主身份 ID 不是 `main`，态势栏中的显示名可能不精确。

### 8.4 管理员会话的独立管理

管理员（`work-group:admin`）有独立的会话管理机制：
- 上下文超限时自动滚动到新 session
- 健康度（healthRatio / healthStatus）监控
- 管理员重启按钮（停止旧 runtime → 创建新 session → 启动新 runtime）

这些机制与会话池的通用逻辑正交，不会互相干扰。管理员会话在 `runtime_status` 和 `aggregateSessionPool` 中被显式排除。

### 8.5 运行状态判定的 ViewerWorker 依赖

态势栏的运行状态判定依赖 ViewerWorker 的 `/notification` API 返回的 `callActive` 字段。该字段由 agent 进程在每次 call 开始/结束时通过 IPC 通知 ViewerWorker 更新。如果 agent 进程异常退出（如 OOM 崩溃），最后一个 `call.finish` 可能丢失，导致 `callActive` 卡在 `true`。此时态势栏会显示会话永远 running，但中断按钮无效果（进程已不存在）。

**缓解措施**：`runtime_status` 接口在查询运行状态前会先检查 `runtime.process?.exitCode !== null`。如果进程已退出，直接返回 `offline`，不再查询 `/notification`。因此只有在"进程存活但 call.finish 通知丢失"的极端情况下才会出现此问题。
