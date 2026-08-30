# R1-09 — 远程会话顶部信息收敛（对话名称 / 模型名 / 用量）

- **仓库**：AgentDevClaw
- **决策依据**：ADR-0010（统一投影）、ADR-0011（protoclaw 适配）
- **类型**：前端状态模型收敛 + 少量 accessor
- **前置**：无（本票是 R2-01 的**硬前置**——施工项 A 的 `focusedAgentId` host 级收敛是 Phase 3 会话端点寻址的前提）
- **状态**：设计已批准（grill 三轮），未施工

## 背景（实测缺陷 + 根因）

实测：远程会话顶部三项（对话名称、模型名、用量）空白。根因**不是**字段没转发——overview 数据已成功加载进 `viewState`（`/api/agents/:id/overview` 走 Phase 1 读白名单），但 `updateChatContextBar`（`public/src/modules/chat-context-bar.js:43-57`）以 `getRuntimeAwareAgentRecord()` 查到发现记录为 gate，而远程 runtime 按设计**不进本地 `allAgents`**（ADR-0010）→ 整条 bar 被清空。数据在、UI 空，gate 错位。

本质：会话元数据的权威散在"发现模型"（allAgents）与"选中视图"（session-view-state）两处，本地两处恰好都有，远程只有后者。根修复是确立 **session-view-state 为选中会话的权威模型**，header 消费统一视图状态——不是给远程打补丁。

## 已定决策（grill 批复，不再讨论）

1. `focusedAgentId` 远程收敛为 **host 级命名空间 id**（与本地 "focusedAgentId = host id" 语义同构）；`currentRuntimeAgentId` 保持 runtime 级（传输寻址键）。
2. session-view-state 增加 `sessionMeta` slot；**title 与 modelName 不入 slot**（活源：catalog 轮询标题 / overview 轮询模型），slot 只存富元数据（createdAt / updatedAt / messageCount / tokenUsage / openDirectory / sessionId）。
3. 本地与远程**同一条**写入/读取链（视图状态优先 → 发现记录回退），不分叉。
4. 标题变更跟随接受轮询延迟（catalog TTL 3s + 前端周期，最坏 ~8s）。

## 施工项（B → D → C → A → E → F 顺序）

### B. session-view-state 增加 sessionMeta slot

- `public/src/session-view-state.js`：`readCurrentSessionViewState()`（:58-71）加 `sessionMeta: currentSessionMeta`；`applySessionViewPatch()`（:73-107）加 `has('sessionMeta')` 分支（对象则存，否则 null）。
- `public/src/app-core.js` 全局状态区（`currentOverviewSnapshot` :536 附近）：`let currentSessionMeta = null;`（与现有 let 全局同风格）。
- `public/src/app-ui.js` `resetRuntimeBackedSurfaceState()`（:1367-1374）的 patch 加 `sessionMeta: null`（切换隔离双保险）。

### D. remote-connections 只读 accessor

- `public/src/modules/remote-connections.js`：抽出私有 `findCatalogEntry(namespacedId)`（`getEntryHostAgentId` :232-245 的遍历上提），现有函数改薄委托；新增 `getEntrySessionTitle(id)` → `entry.sessionTitle || null`（活源标题）与 `getEntryRuntimeSessionId(id)` → `entry.sessionId` 的**裸** id（聚合器已命名空间化，必须剥壳）；:701 导出块追加。

### C. loadAgentDetail 统一提交路径（核心）

- `public/src/app-core.js:29-63`：
  - `const hostDetailPayloads = new Map();`——fetch 成功缓存 detail（`loadedAgentDetailIds` :32 一次性去重意味着同 host 第二个 runtime 切换时 fetch 被跳过，sessionMeta 必须能从缓存重算）。
  - 去重早退路径改为先 `resolveSessionMetaForCurrentRuntime(agentId, hostDetailPayloads.get(agentId))` 再 return（无网络开销）。
  - 新增 `resolveSessionMetaForCurrentRuntime(detailAgentId, detail)`：
    - `getCurrentControlAgentId() !== detailAgentId` → return（详情不属于当前选中 runtime 的宿主；复用 a782d4b 收敛点，不新造解析器）；
    - 裸 sessionId 来源：本地 `getCurrentRuntimeRecord()?.active_workspace_session_id`，远程 `getEntryRuntimeSessionId(currentRuntimeAgentId)`；
    - `detail.workspace_sessions.sessions` 中按裸 id 找到 active 会话 → `commitSessionViewPatch(captureSessionViewToken(), { sessionMeta: {...富字段} }, afterCommit)`；
    - `afterCommit` 显式调一次 `updateChatContextBar()`（detail 与 overview 在 `agent-data-loader.js:57-69` 的 `Promise.all` 并行，detail 常最后落定，不主动刷会白屏一个 poll 周期）。
  - 本地远程**同一函数同一条件**（Q6 定案：本地也写）。

### A. focusedAgentId host 级收敛（1 行，Phase 3 前置）

- `public/src/app-main.js:609-611`：远程分支 `focusedAgentId = newAgentId`（leaf）改为 `getEntryHostAgentId(newAgentId) || newAgentId`（catalog 未就绪时降级为现状）。
- 消费者影响已核对：`loadAgentDetail` 转发粒度自动修正（裸 host id → 远端 `getAgentsLight` 查得到，消除远端 404）；swap 转发的 `agentId` 从裸 runtime UUID 变裸 host id（更正确）；`getRuntimeContextKey`（app-core.js:904）hostId 组件语义修正（一次性输入草稿缓存键漂移，可接受）；`readOnlyMode` 判定用点击的 leaf id 不受影响。

### E. header 渲染收敛

- `chat-context-bar.js` `updateChatContextBar`（:21-173）：
  - Gate（:43-57）：`if (!agent)` → `if (!agent && !hasOverviewContent(viewState.overview) && !viewState.sessionMeta)` 才清空；`hasOverviewContent` = modelName 或 lastRequestUsage 或 contextLength > 0。
  - `runtimeRecord` 门（:75/:80/:87/:142）：去掉 record 条件、只看 `viewState.overview` 字段（viewState.overview 是身份绑定提交的，永远是当前 runtime 的数据；本地 record 恒在，行为不变）。
  - `activeSession` 回退（:60-65/:94-102）：record 查不到时由 `viewState.sessionMeta` 合成 session 形状对象。
- 同文件 `_collectActiveSessionMeta`（:574-599）：`sessionMeta` 优先，既有 record 路径保留为回退——hover 弹窗（title/createdAt/messageCount/tokenUsage/openDirectory/sessionId）全部可出。
- `app-main.js` `getCurrentVisualAgentTitle`（:30-44）：末尾回退链插入 `window.RemoteConnections?.getEntrySessionTitle?.(currentRuntimeAgentId)`（catalog `sessionTitle` 是聚合器 :129 从 `active_workspace_session_title` 映射的活值）。
- `app-main.js` `updateCurrentAgentChrome`（:61-64）：顺手修同域 bug——远程 `runtimeRecord` 为 null 时 `connected` 恒 true；改为 `isRemoteEntryOnline?.(currentRuntimeAgentId) !== false` 回退。

### F. 测试

- 新建 `test/frontend-session-header.test.js`（vm 沙箱，同 `frontend-core-helpers.test.js` 的 `createCoreSandbox` 模式；overrides 必须经 `ctx.run` 赋值以穿透模块内 `let` 遮蔽）：
  1. 远程形态：allAgents 无记录 + catalog stub → header 三项渲染、标题取 sessionTitle、`_collectActiveSessionMeta` 非 null；
  2. 切换隔离：runtime A 提交后推进 `_switchEpoch` → 旧 token 提交返回 false，bar 反映 B；
  3. 本地回归：record 存在 → 输出与改动前关键子串一致（golden）；
  4. 空态：无 record、无 overview 内容、无 sessionMeta → bar 清空。
- `test/remote-sidebar-projection.test.js`：accessor 断言（`getEntrySessionTitle` 活值；`getEntryRuntimeSessionId` 返回裸 id——命名空间剥离是易错点）。
- `test/remote-write.test.js`：核对 a782d4b 的 agent_detail 断言是否硬编码 leaf 粒度，按需同步。

## 验收标准

- 定向测试 + 全量 `npm run test:core` 全绿；eslint 0 error；`git diff --check` clean。
- 双机冒烟：远程会话 header 三项显示；hover 弹窗富元数据；AI 改名后 ≤8s 跟随；断线时 header badge 变 disconnected。

## 明确不做

- 不把远程条目注入 `allAgents`（ADR-0010 分治）。
- 不新增 remote-title / remote-model / remote-usage 平行状态。
- 不为标题时效做主动刷新机制（接受轮询延迟）。
