# ADR 0039: 归档对话只读浏览——打开入口与启动入口分离

日期：2026-11-03
状态：已接受

## 背景与问题

已归档的对话在列表里可见、可点，点进去却报错。根因不是「归档后不许看」，而是同一条打开链路被两个语义挤在一起：

- ADR-0026 早就确立 Session 是会话内容的所有者，runtime 不可用时从容器的持久记录读取内容；ADR-0032 把历史存档定义为「只读呈现、可从此继续」。
- 2026-10-28 统一会话生命周期时，`startManagedSession()` 增加了归档闸门（`session_archived` / `thread_archived`），理由成立：归档必须停运行并确认最终保存，不能有新写入者覆盖快照。
- 但列表行的「进入对话」仍走 `open_session` → 启动/挂载 runtime 的通用路径，于是**「禁止重新启动」被扩大成「禁止查看」**，归档对话完全打不开。

同时，线程历史面板的「查看原文」虽已被设计为只读读档，却只设置只读标记、写入消息，不登记视图身份、不切换 runtime 绑定。head 推进后的接续重绑与事实对账照样会把视图拉回最新 head——用户点开存档又被自动跳走。

## 决策

### 1. 启动与浏览是两条路径，不得互相代偿

归档后**不得启动 runtime** 的约束保持不变（`startManagedSession` 闸门保留）。归档后**必须可以查看内容**，经只读浏览实现，且**不得触发任何 runtime 启动**。

### 2. 唯一实现：`public/src/modules/session-readonly-view.js`

所有只读浏览入口共用这一条链路，不各自拼装只读面：

- 归档对话（会话级 `archived` 与线程级 `lifeState: archived`）
- 线程历史存档「查看原文」
- 工作群「查看会话记录」
- Coder 已归档线程的「查看内容」

### 3. 视图冻结在目标 Session 上

只读浏览建立三条同时成立的状态：SessionView identity 指向目标 Session、`currentRuntimeAgentId` 置空、`activeConversation = { readOnly: true, wasHead: false, runtimeId: '' }`。

接续重绑（`_rebindConversationToThreadHead`）、线程指向对账（`_reconcileConversationWithThreadHead`）、订阅同步（`_syncActiveThreadSubscription`）都以 `readOnly` / `wasHead` 为排除依据，因此只读视图不会被线程刷新拉回 head。点开存档被自动跳走的问题由此在状态层面消除，不依赖时序判断。

### 4. 渲染保真靠数据面同形，不靠第二套渲染

`/protoclaw/session_record` 按存活 runtime `/messages` 同一字段集投影消息（含 `display` / `images` / `thinkingBlocks` / `source` / `execution` / `usage` / `toolCalls`），并以 `enrichedMessages[].timestamp` 的平行投影给出与消息等长的 `timestamps`。只读视图因此走同一条渲染管线，工具卡片、图片、思考块、时间分隔线照常，不存在「残缺的只读界面」。

无 runtime 可取时，工具模板沿用最近一次已加载的 `toolRenderConfigs`（按 agent 缓存，未切 runtime 即未失效）；完全没有历史配置时退回 json 模板，属可接受降级。

### 5. 离开只读态必须在所有导航早退之前

`switchAgent` 的多处早退分支（如「已在宿主首页」）在只读态下会被命中（此时无 runtime）。只读清理因此前置于全部早退，否则标记残留会把随后的正常会话压痛（输入框仍禁用、顶栏仍挂只读）。

## 影响

- 归档对话、线程历史存档、工作群记录、coder 归档线程获得一致的只读体验；入口不再依赖列表是否已加载该会话（搜索结果可召回未加载的归档会话）。
- 「恢复归档」仍是继续对话的唯一途径，只读面不提供写入；输入区在只读态给出归档/历史两类说明。
- 只读浏览不参与线程跟随，head 推进不影响已打开的存档。

## 验证锚

- `test/session-record-readonly.test.js`：数据面字段保真、时间锚等长对齐与 turn 过滤不错位、归档事实与标题下发、404 语义。
- `test/frontend-session-readonly-view.test.js`：只读挂载不绑定 runtime、接续重绑与对账不改写视图、切走必须清除只读态、读档失败不残留空壳。
