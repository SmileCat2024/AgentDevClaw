# R1-09 — 远程会话顶部信息收敛（对话名称 / 模型名 / 用量）

- **仓库**：AgentDevClaw
- **决策依据**：ADR-0010（统一投影）、ADR-0011（protoclaw 适配）
- **类型**：前端状态模型收敛 + 少量 accessor
- **前置**：无（本票是 R2-01 的**硬前置**——施工项 A 的 `focusedAgentId` host 级收敛是 Phase 3 会话端点寻址的前提）
- **状态**：施工项 A–E 已合入（2026-08-28，T21 系列 commit），剩余 F 项测试与验收；R2-01 开工以 F 项合入为前置
- **实施记录**：341ab3c（D 项 accessor）/ 2910dee + dc06e87 + a5d54c0（B+C 项）/ 87cf825（A 项）/ 3e85110 + 123b893（E 项，含 R3 裁决）

## 背景（实测缺陷 + 根因）

实测：远程会话顶部三项（对话名称、模型名、用量）空白。根因**不是**字段没转发——overview 数据已成功加载进 `viewState`（`/api/agents/:id/overview` 走 Phase 1 读白名单），但 `updateChatContextBar`（`public/src/modules/chat-context-bar.js`）以 `getRuntimeAwareAgentRecord()` 查到发现记录为 gate，而远程 runtime 按设计**不进本地 `allAgents`**（ADR-0010）→ 整条 bar 被清空。数据在、UI 空，gate 错位。

本质：会话元数据的权威散在"发现模型"（allAgents）与"选中视图"（session-view-state）两处，本地两处恰好都有，远程只有后者。根修复是确立 **session-view-state 为选中会话的权威模型**，header 消费统一视图状态——不是给远程打补丁。

## 已定决策（grill 批复，不再讨论）

1. `focusedAgentId` 远程收敛为 **host 级命名空间 id**（与本地 "focusedAgentId = host id" 语义同构）；`currentRuntimeAgentId` 保持 runtime 级（传输寻址键）。
2. session-view-state 增加 `sessionMeta` slot；**title 与 modelName 不入 slot**（活源：catalog 轮询标题 / overview 轮询模型），slot 只存富元数据（createdAt / updatedAt / messageCount / tokenUsage / openDirectory / sessionId）。实施时富字段清单最终收敛为 sessionId / sessionType / createdAt / updatedAt / openDirectory / messageCount（totalTokens 无数据源，复审裁决去掉）。
3. 本地与远程**同一条**写入/读取链（视图状态优先 → 发现记录回退），不分叉。
4. 标题变更跟随接受轮询延迟（catalog TTL 4s + 前端周期，最坏 ~8s）。

## 施工项现状（2026-08-28 已合入，commit 链 87cf825 → a5d54c0）

以下内容保留为**已实施事实记录**，函数/结构名以合入代码为准，与最初设计稿的命名差异不再回改：

### B. sessionMeta slot（已合入：2910dee / dc06e87 / a5d54c0）

- `public/src/modules/session-view-state.js`：`sessionMeta` slot 在模块内部（`_sessionMeta` + `normalizeSessionMeta`），`readCurrentSessionViewState()` 返回 `sessionMeta`，`applySessionViewPatch()` 有 `has('sessionMeta')` 分支。注意：**不在 app-core.js 全局状态区**（遵循 CLAUDE.md "全局状态只减不增"），设计稿的 app-core 布点已被否决。
- 切换隔离：`app-main.js`（`sessionMeta: undefined` 于 switch 提交路径）负责清空；`resetRuntimeBackedSurfaceState()` 未加 `sessionMeta` patch（单点清理，无双保险分支）。

### D. remote-connections accessor（已合入：341ab3c，语义修正：a5d54c0）

- `public/src/modules/remote-connections.js`：`getEntrySessionTitle(id)`（sessionTitle → name 回退）、`getEntryRuntimeSessionId(id)`、`getEntryHostNamespaceId(id)` 已导出（:801 附近导出块）。
- **注意：`getEntryRuntimeSessionId` 返回命名空间化会话 id（`remote:<conn>:<sid>`），不是裸 id**。命名空间剥离在服务端完成；任何"与裸 sessionId 直接比较"的消费方必须先在服务端还原，前端不做裸化。这是复审裁决（a5d54c0）定下的契约，与最初设计稿相反。

### C. loadAgentDetail 统一提交路径（已合入，命名不同）

- `public/src/app-core.js`：`_agentDetailPayloadCache` Map（对应设计稿的 hostDetailPayloads）+ `getAgentDetailPayload()` accessor；`extractSessionMetaFromDetail(detail)` 从 detail 提取 active 会话富元数据。
- `loadAgentDetail()` 内联 gate：`agentId === focusedAgentId && currentRuntimeAgentId` 才提交（等价于设计稿的 `getCurrentControlAgentId()` 收敛点，a782d4b），经 `commitSessionViewPatch(sessionViewToken, { sessionMeta })` 提交。
- 与设计稿的差异：无独立 `resolveSessionMetaForCurrentRuntime` 函数；`afterCommit` 不主动刷 `updateChatContextBar()`（依赖既有渲染链兜底，实测无白屏窗口）。

### A. focusedAgentId host 级收敛（已合入：87cf825，1 处）

- `app-main.js` `switchAgent`：远程分支 `focusedAgentId = getEntryHostNamespaceId(runtimeAgentId) || newAgentId`（宿主级**命名空间** id）。比最初设计（`getEntryHostAgentId` 裸 id）更正确：控制类请求保持命名空间寻址，服务端负责剥壳。
- 消费者影响复核完成（见 123b893 R3 裁决：标题回退按运行时引用查询）。

### E. header 渲染收敛（已合入：3e85110 + 123b893）

- gate 解耦：`agent` record 缺失不再清空 bar；真·空数据 gate = 模型名空 + 用量 0 + contextLength 0（:148）。
- 标题回退：`getCurrentVisualAgentTitle` 远程分支按 `currentRuntimeAgentId`（运行时引用）查 `getEntrySessionTitle`。
- `updateCurrentAgentChrome` 断线徽章：远程经目录 `resolveRuntimeRef` 推导连接态。
- hover 弹窗 `_collectActiveSessionMeta`（chat-context-bar.js:575）：远程分支已接 accessor。

## 剩余工作（F 项：测试与验收）

### F. 测试（本票唯一未完成施工项）

- 新建 `test/frontend-session-header.test.js`（vm 沙箱，同 `frontend-core-helpers.test.js` 的 sandbox 模式；overrides 必须经 `ctx.run` 赋值以穿透模块内 `let` 遮蔽）：
  1. 远程形态：allAgents 无记录 + catalog stub → header 三项渲染、标题取 sessionTitle、`_collectActiveSessionMeta` 非 null；
  2. 切换隔离：runtime A 提交后推进 `_switchEpoch` → 旧 token 提交返回 false，bar 反映 B；
  3. 本地回归：record 存在 → 输出与改动前关键子串一致（golden）；
  4. 空态：无 record、无 overview 内容、无 sessionMeta → bar 清空。
- `test/remote-sidebar-projection.test.js`：补 accessor 断言（`getEntrySessionTitle` 回退链含 name 兜底；`getEntryRuntimeSessionId` 返回**命名空间化 id**——与设计稿相反，以合入代码为准）。
- `test/remote-write.test.js`：核对 a782d4b 的 agent_detail 断言是否硬编码 leaf 粒度，按需同步。

### 验收标准

- 定向测试 + 全量 `npm run test:core` 全绿；eslint 0 error；`git diff --check` clean。
- 双机冒烟（合入后人工）：远程会话 header 三项显示；hover 弹窗富元数据；AI 改名后跟随（catalog 周期 4s + 前端周期，最坏 ~8s+）；断线时 header badge 变 disconnected。

## 明确不做

- 不把远程条目注入 `allAgents`（ADR-0010 分治）。
- 不新增 remote-title / remote-model / remote-usage 平行状态。
- 不为标题时效做主动刷新机制（接受轮询延迟）。
