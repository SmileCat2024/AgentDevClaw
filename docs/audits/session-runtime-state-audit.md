# 会话 / 运行时 / 工作空间 UI 状态审计

更新日期：2026-05-26

本文档用于整理 AgentDevClaw 当前与“会话、运行实例、工作空间 UI、当前对话”有关的真实状态模型、设计约束、近期修复、剩余债务，以及后续接手时必须遵守的改造边界。

这不是单个 bug 的排查记录，而是一份面向后续重构和多 agent 接手的基线文档。目标不是记流水账，而是把现状从“概念混用、状态分散、UI 代偿过多”提炼成一套清晰的产品语义与工程约束。

---

## 1. 为什么要写这份文档

近期连续暴露出的几个问题，本质上都不是孤立问题：

- 探索对话里的“生成摘要”一度失败。
- 左侧列表长期只能稳定表达一个“当前运行中的实例”。
- 历史会话打开后，中部 UI 会先空白、再乱闪、再跳转。
- 点击实例、点击历史会话、点击工作空间，常常会互相抢主视图。
- 启动会话时很慢，前端表现像“点了没反应”。

这些问题的共同根因不是某个接口或某个按钮，而是：

- 系统里同时存在多套“当前”。
- 会话实体、运行实例、工作空间宿主、前端显示态没有彻底分层。
- 前端 `allAgents[]` 承担了过多投影和补洞职责。
- 工作空间 UI 既想当监视器，又想当业务状态机，又想当跳转器，结果语义过重。

如果后续继续只修“现象”，这些问题会反复出现。要想真正收敛，必须先确认产品语义，再用语义反推代码约束。

---

## 2. 目标产品语义

这一节不是“将来可能怎么做”，而是当前已经明确的方向。后续实现判断都应以此为准。

### 2.1 工作空间 UI 的定位

工作空间 UI 应该是：

- 监视器
- 操作面板
- 索引和跳转入口

工作空间 UI 不应该继续承担“当前业务上下文是谁”的核心语义，也不应该自己维持复杂的内部页面状态机去和对话争主视图。

### 2.2 前台实体是谁

真正应该被当作前台实体的是：

- 一个个对话会话
- 一个个显式 runtime 实例
- 用户当前确实能观察、切换、交互的前台实例

对应到产品表现：

- 左侧树应优先表达“前台实例”而不是“历史会话目录”。
- prebuilt agent 更像宿主壳、分类、入口、索引根。
- 宿主被选中，不等于“业务 current 全都由宿主决定”。

### 2.3 什么不应成为前台实体

某些后台流程虽然会读写会话数据，但不应显示为前台聊天实例，例如：

- compact / summary mirror
- one-shot 的后台压缩辅助链路
- 不接入 Viewer 的临时执行流程

也就是说：

- “修改了会话”不等于“应展示为前台实例”
- “有 sessionId”不等于“左侧必须列出来”

### 2.4 核心分层原则

以后产品层必须显式承认以下几件事不是一回事：

1. 某条会话被选中了。
2. 某个 runtime 正附着在某条会话上。
3. UI 当前展示的是哪份消息内容。
4. 左侧当前高亮的是哪个宿主或实例。

历史上大量混乱，来自代码默认这几件事应该始终相等。

---

## 3. 已确认的设计约束

这一节是后续接手时最重要的部分。这里的约束不是“建议”，而是近期经过踩坑后确认出来的非退化边界。

### 3.1 Host identity 和 Runtime identity 不能再塌缩

在前端，宿主身份和实例身份必须显式分开：

- `currentAgentId` 表示当前宿主壳
- `currentRuntimeAgentId` 表示当前前台实例

对应实现位置：

- `D:/code/AgentDevClaw/public/src/app-main.js`
- `switchAgent(...)`

为什么：

- 点击 child runtime 时，如果把 `currentAgentId` 直接切成 child id，工作空间 surface、workspace action、session list、host metadata 都会失去宿主上下文。
- 如果宿主和实例塌缩，左侧、标题、右侧工作空间操作区会再次混成一层。

已经落实的行为：

- 点击 child runtime 后，`currentAgentId` 保持宿主 id。
- `currentRuntimeAgentId` 切到 child runtime id。
- 主视图直接进入 `chat`。

### 3.2 Workspace host 的中央区域必须是二元态

对 `programming-helper`、`feature-creator`、`agent-creator`、`flow-workspace` 这类 workspace host：

- 有 `currentRuntimeAgentId` 或 `readOnlyMode` 时，只显示 `chat`
- 否则只显示 `workspace`

对应实现位置：

- `D:/code/AgentDevClaw/public/src/app-ui.js`
- `getPassiveWorkspaceSurfaceMode(...)`
- `ensureUnitMode(...)`
- `shouldRenderWorkspaceSurface(...)`
- `isChatSurfaceActive(...)`
- `renderWorkspaceTabs(...)`

为什么：

- 旧模型里 host 内部还有 `home / chat / sessions` 等多层 tab 状态，导致“工作空间页面”和“对话页面”相互争夺中央区域。
- 用户实际观察到的问题就是：打开历史会话后，中央区域先空、再闪、再跳。

已经落实的行为：

- 对 workspace host，顶部 tab 被隐藏。
- 主视图不再由 host 的复杂 tab 状态驱动，而是被动二选一。

### 3.3 左侧树表达实例，不表达长会话目录

左侧列表的职责是表达：

- 哪些宿主存在
- 哪些显式前台 runtime 正在运行
- 当前高亮的是哪个宿主 / 实例

左侧列表不应直接展开成长会话目录。

对应实现位置：

- `D:/code/AgentDevClaw/public/src/app-main.js`
- `collectRuntimeEntriesForPrebuilt(...)`
- `renderSidebarChildItems(...)`

为什么：

- 会话目录和实例目录不是同一件事。
- 左侧如果展开成所有 session，会把“实例树”和“历史记录视图”重新混在一起。
- 用户已经明确要求左侧更像 Codex 风格的实例列表，极简且干净。

已确认的视觉约束：

- 子项保持单行。
- 只保留状态灯 + title。
- 不再堆 `runtime id`、消息数、运行前缀、附加说明。

### 3.4 同一宿主下允许多个前台 managed runtime 并存

这是本轮最关键的运行时模型变更之一。

当前服务端已经不再是“一个宿主只能有一个 managed runtime”，而是：

- `managedAgents` 仍是一个 `Map`
- 但 key 已经改成 `agentId + sessionId`
- 同一宿主下，不同 session 可以有多个托管 runtime 并存

对应实现位置：

- `D:/code/AgentDevClaw/server.js`
- `getManagedRuntimeKey(...)`
- `listAgentRuntimes(...)`
- `pickPrimaryAgentRuntime(...)`
- `getAgentRuntime(...)`
- `startManagedAgent(...)`
- `stopManagedAgent(...)`
- `waitForManagedRuntimeReady(...)`

为什么：

- 用户要的不是“当前 agent 下的唯一 current 对话”，而是“多个前台实例并存，工作空间只是监视器”。
- 如果宿主仍然唯一化 runtime，左侧树永远不可能真正表达多实例。

### 3.5 打开历史会话时，不能再复用旧 runtime id 作为 ready 信号

这是此前“打开成功但 UI 乱闪、连接灯不稳、输入没反应”的直接根因之一。

对应实现位置：

- `D:/code/AgentDevClaw/public/src/app-main.js`
- `waitForPrebuiltRuntimeSession(...)`
- `runWorkspaceAction(...)` 中的 `open_session` 分支

已经形成的约束：

- 打开 session 时必须记录 `previousRuntimeId`
- 等待 ready 时必须确认新的 runtime id 不等于旧值
- 不能把宿主旧 `runtime_session_id` 误判成“新实例已经 attach”

为什么：

- 如果旧 runtime id 被误当成新实例 ready，前端会过早切主视图，后续轮询又会发现状态不对，于是出现来回跳。

### 3.6 工作空间列表和实例树不能互相代偿

`workspace_sessions` 的职责是：

- 提供 session 目录
- 提供 activeSessionId
- 支撑工作空间内部的会话管理、摘要、查看历史记录

它不是左侧实例树的数据源本体。

为什么：

- `workspace_sessions` 代表“会话目录”
- 左侧树代表“当前前台实例”
- 两者可能有关联，但不应互相替代

### 3.7 Summary / compact 需要走 session index 权威层

已确认的后端约束：

- `sessionType` 不能再从 session file 盲读
- 应优先从 session index 解析

对应实现位置：

- `D:/code/AgentDevClaw/server.js`
- `resolvePrebuiltSessionType(...)`

为什么：

- `sessionType` 是产品级分类字段，不是 runtime saveSession 的天然字段。
- 之前“摘要按钮失效”就是因为链路里把它当成 session file 内字段读取。

### 3.8 Compact mirror 必须走模型预设解析

对应实现位置：

- `D:/code/AgentDevClaw/scripts/run-compact-mirror.js`

为什么：

- 如果 compact mirror 不走和其它 runtime 一样的 preset 解析，它会退回环境默认模型。
- 之前 mirror 实际跑成默认 `glm-5.1`，导致不打 `record_compaction_context`，摘要链路失败。

---

## 4. 当前系统里到底有哪些对象

现状至少包含以下对象层次。

### 4.1 Prebuilt Agent

预置 agent 的产品身份，例如：

- `programming-helper`
- `feature-creator`
- `agent-creator`
- `flow-workspace`

它更像产品宿主、工作空间入口、分类壳，而不是具体某次运行的唯一身份。

### 4.2 Session Index Record

每个 agent 名下的会话索引记录，保存在 index 文件中。它描述：

- 该 agent 下有哪些 session
- 哪条是 `activeSessionId`
- 每条 session 的轻量级产品元信息
- `sessionType`
- `title`
- `updatedAt`

### 4.3 Session File

真正的消息历史、tool 调用、runtime 保存数据，由 runtime 的 `saveSession/loadSession` 读写。

它更接近运行持久化快照，而不是完整产品索引层。

### 4.4 Workspace State

工作空间 UI 草稿和项目态，例如：

- `forms`
- `openDirectory`
- assembly 相关配置
- feature / agent 项目工作区状态

### 4.5 Managed Runtime

由服务端托管的常驻运行进程，接入 ViewerWorker，可持续轮询：

- messages
- input requests
- overview
- hooks
- connection status

当前已经支持“同一宿主下多个 session 启多个 managed runtime”。

### 4.6 Assembly Runtime

按 session 启动的独立 runtime，和普通 managed runtime 并列存在，但生命周期、生成方式、宿主关系不同。

### 4.7 One-shot Runtime

只执行一次任务、完成后退出，不接入 Viewer。它会修改 session 数据，但不应默认被视为前台 live chat。

### 4.8 Frontend Surface State

前端还有一层独立显示态，不属于上述任何后端对象：

- `currentAgentId`
- `currentRuntimeAgentId`
- `readOnlyMode`
- `currentMessages`
- `allAgents[]`
- `currentWorkspaceTab`

这层状态决定“用户当前看到什么”。

---

## 5. 当前真实的状态源在哪里

可以把现状简化成 4 个主要权威源。

| 模型 | 主要位置 | 保存什么 |
|---|---|---|
| Managed Runtime | `D:/code/AgentDevClaw/server.js` 中 `managedAgents` / `assemblyRuntimeProcesses` | 进程、viewerAgentId、selectedSessionId、ready、pid、runtime id |
| Session Index | `~/.agentdev/.../index.json` | `activeSessionId`、session 目录、轻量元信息、`sessionType` |
| Workspace State | `~/.agentdev/.../state.json` | 表单、项目草稿、openDirectory、部分 workspace 配置 |
| Frontend Global State | `D:/code/AgentDevClaw/public/src/app-main.js` / `app-ui.js` 内存 | 当前宿主、当前实例、当前显示模式、扁平 agent 投影、只读消息 |

这 4 层之间没有一个绝对统一中心，前端和服务端都在做一定程度的投影、补洞和同步。

---

## 6. “当前”到底有哪几种

这一节是理解现状的关键。

### 6.1 当前选中的会话

通常来自：

- `index.activeSessionId`
- 或前端乐观更新后的 `agent.workspace_sessions.activeSessionId`

这是一种“列表选择态”。

### 6.2 当前 runtime 实际附着的会话

通常来自：

- `managedRuntime.selectedSessionId`

这是一种“进程绑定态”。

### 6.3 当前 UI 的宿主

通常来自：

- `currentAgentId`

这是一种“宿主壳态”。

### 6.4 当前 UI 的前台实例

通常来自：

- `currentRuntimeAgentId`

这是一种“前台运行实例态”。

### 6.5 当前 UI 正展示的消息内容

这既可能来自：

- live runtime

也可能来自：

- 某条历史 session record 的只读加载结果

这是一种“显示内容态”。

### 6.6 当前用于 compact / summary / resume 的目标会话

压缩和摘要链路又引入了单独目标态：

- 当前 live session 原地 compact-resume
- 某条历史 session 做 detached / offline compact

这是一种“操作目标态”。

结论很明确：现状至少有 6 种“当前”，但代码长期倾向于把它们压缩成一个“当前对话”。

---

## 7. 关键实现文件和它们各自的责任

### 7.1 `D:/code/AgentDevClaw/server.js`

这是后端状态投影层和 runtime 管理层的交汇点。

当前尤其关键的职责：

- 管理 `managedAgents`
- 启停 managed runtime
- 把 viewer 连接态投影成前端可消费的 `getConnectedAgents()`
- 处理 session 创建、激活、删除、摘要、压缩

需要重点关注的函数：

- `getManagedRuntimeKey(...)`
- `listAgentRuntimes(...)`
- `pickPrimaryAgentRuntime(...)`
- `getAgentRuntime(...)`
- `getConnectedAgents(...)`
- `waitForManagedRuntimeReady(...)`
- `startManagedAgent(...)`
- `stopManagedAgent(...)`
- `resolvePrebuiltSessionType(...)`

### 7.2 `D:/code/AgentDevClaw/public/src/app-main.js`

这是前端全局状态编排层。

当前尤其关键的职责：

- 维护 `allAgents[]`
- 维护 `currentAgentId` / `currentRuntimeAgentId`
- 左侧树渲染
- `loadAgents()`
- `switchAgent(...)`
- `runWorkspaceAction(...)`
- 轮询 runtime 消息 / notification / connection / overview

需要重点关注的函数：

- `collectRuntimeEntriesForPrebuilt(...)`
- `renderSidebarChildItems(...)`
- `loadAgents(...)`
- `waitForPrebuiltRuntimeSession(...)`
- `applyOptimisticWorkspaceSession(...)`
- `switchAgent(...)`
- `runWorkspaceAction(...)`

### 7.3 `D:/code/AgentDevClaw/public/src/app-ui.js`

这是中央区域的显示决策层。

当前尤其关键的职责：

- 决定当前展示 workspace 还是 chat
- 决定 host 是否显示 tabs
- 渲染 workspace 内的 session 列表、摘要按钮、查看记录按钮

需要重点关注的函数：

- `isWorkspaceHostUnit(...)`
- `getPassiveWorkspaceSurfaceMode(...)`
- `ensureUnitMode(...)`
- `shouldRenderWorkspaceSurface(...)`
- `isChatSurfaceActive(...)`
- `renderWorkspaceTabs(...)`

### 7.4 `D:/code/AgentDevClaw/scripts/run-compact-mirror.js`

这是摘要 / compact mirror 的离线执行入口。

这里的重点不是 UI，而是：

- 模型预设解析必须和其它 runtime 一致
- 摘要镜像任务不应误退回默认模型

---

## 8. 当前最关键的耦合点

### 8.1 `allAgents[]` 仍是一个扁平杂交对象层

这是前端最值得警惕的一点。

`loadAgents()` 同时取：

- `invoke('get_connected_agents')`
- `fetch('/api/agents')`

然后把 prebuilt host、runtime、workspace session 投影、viewer 连接态，混进同一个 `allAgents[]`。

这导致单个前端 agent 对象里可能同时出现：

- host 身份字段
- runtime 连接字段
- workspace session 投影字段
- 当前显示所需字段

这是目前最大的历史债务之一。

### 8.2 Session index 和 Workspace state 仍然双向缠绕

`createPrebuiltSession()` 与 `activatePrebuiltSession()` 不只写 index，也会把 session 元数据回填进 workspace 投影层。

这意味着：

- 工作空间 UI 不只是“看 index”
- 它也在消费一份被加工过的会话投影

如果后续继续扩散这种投影，状态归属会越来越难说明。

### 8.3 `getConnectedAgents()` 仍是多模型投影器

`getConnectedAgents()` 现在已经被瘦身，但它仍然同时承担：

- 返回 prebuilt host
- 注入 active session 摘要
- 注入 workspace session snapshot
- 合成 child runtime 条目

它已经比之前轻量很多，但仍不是纯粹的“连接状态接口”。

### 8.4 前端切换事务和轮询线程仍在共享状态

打开会话、切实例、切只读记录时，前端会同时发生：

- 乐观更新
- `loadAgents()`
- `switchAgent(...)`
- runtime 轮询
- workspace surface 重绘

只要 ready 判定不稳，或 `loadAgents()` 途中把 current 状态改回去，就很容易再出现“先进去又闪出来”。

---

## 9. 本轮以前后踩坑确认出来的错误方向

这一节是给后续 agent 的“不要再重走一遍”。

### 9.1 错误方向：把左侧树改成长会话列表

为什么错：

- 左侧应表达实例，不应表达历史目录
- 会话列表已经有工作空间 surface 承担
- 展开成长会话列表后，会再次把“历史记录目录”和“前台实例树”混为一体

### 9.2 错误方向：点击 child runtime 时直接把 `currentAgentId` 切成 child

为什么错：

- 会丢失宿主上下文
- workspace actions 会失去目标宿主
- host surface 会错乱

### 9.3 错误方向：打开历史会话时先乐观切进半成品 chat

为什么错：

- 旧 runtime id 可能仍在轮询
- 新实例未 ready 时，中央区域会先显示一层不完整 chat
- 随后轮询和 `loadAgents()` 会把视图拉回去

### 9.4 错误方向：把工作空间 host 当作自己拥有复杂 tab 状态的页面容器

为什么错：

- 用户要的是“工作空间 / 对话”二选一
- 不是“工作空间首页 / 工作空间内聊天 / 工作空间内 session 页面”三四层叠加

### 9.5 错误方向：继续默认“一个宿主只有一个 runtime”

为什么错：

- 这与“前台实例为中心”的产品方向正面冲突
- 左侧树永远无法真正表达多实例

---

## 10. 近期已经落地的关键修复

### 10.1 摘要按钮恢复

根因修复分两层：

1. `sessionType` 改为从 session index 权威层解析
2. compact mirror 改为走模型预设解析，不再退回默认模型

关键文件：

- `D:/code/AgentDevClaw/server.js`
- `D:/code/AgentDevClaw/scripts/run-compact-mirror.js`

### 10.2 会话启动去阻塞化

关键变化：

- `getConnectedAgents()` 从重量级摘要装配改成更轻量的连接快照投影
- `/protoclaw/prebuilt_sessions` 与激活链路支持更早返回
- 前端使用 `applyOptimisticWorkspaceSession(...)` 先挂出 session

为什么重要：

- 这直接缓解了“点了半天没反应”的问题
- 但也引入了更高要求：切换事务必须谨慎处理 ready 时机

### 10.3 Managed runtime 改为按 `agentId + sessionId` 建模

这是“多实例前台化”的后端基础。

关键变化：

- `managedAgents` 的 key 改为 `agentId + sessionId`
- `startManagedAgent(...)` 不再强制同宿主唯一 runtime
- `stopManagedAgent(...)` 支持按 session 精确停止
- `waitForManagedRuntimeReady(...)` 支持按 session 等待
- `getConnectedAgents()` 会合成 child runtime 条目供前端渲染

### 10.4 前端切换语义收紧

关键变化：

- `switchAgent(...)` 保持宿主 / runtime 双身份分离
- child runtime 点击后直接进入 `chat`
- `loadAgents()` 不再盲信一个已断开的 `currentAgentId`
- `waitForPrebuiltRuntimeSession(...)` 支持 `previousRuntimeId`

### 10.5 Workspace host 主视图二元化

关键变化：

- `workspace` 与 `chat` 成为 host 主视图唯一二选一
- host tabs 隐藏
- `ensureUnitMode(...)` 不再让 host 自己玩复杂 tab 状态机

---

## 11. 当前仍未完成的根问题

### 11.1 `allAgents[]` 仍是过渡层，不是最终对象模型

虽然目前已经能支撑更多正确行为，但它仍混着：

- host
- child runtime
- workspace 投影
- viewer 连接态

后续如果还继续往里塞职责，复杂度会再次爆炸。

### 11.2 宿主、会话、实例、显示 surface 还没有拆成独立 store

现在仍是全局变量互相推导：

- `currentAgentId`
- `currentRuntimeAgentId`
- `readOnlyMode`
- `currentWorkspaceTab`
- `allAgents[]`

这在项目继续长大后会成为明显瓶颈。

### 11.3 `getConnectedAgents()` 仍然过于中心化

它现在同时承担：

- 连接态
- host 摘要
- workspace session snapshot
- child runtime 合成

这虽然比之前好，但仍然是一个历史式“超级投影函数”。

### 11.4 打开历史会话的事务仍然脆弱

虽然已修掉最明显的问题，但这条链路仍然容易受以下因素影响：

- 轮询竞态
- `loadAgents()` 刷新时重建投影对象
- runtime attach 延迟
- optimistic session 更新与真实 runtime attach 的时间差

### 11.5 工作空间内部的 session list 仍和运行时切换强耦合

目前用户仍会通过工作空间列表进入会话，因此：

- 工作空间列表的打开动作
- runtime attach
- 左侧实例高亮
- 中央区域 chat/workspace 切换

仍然是一条强耦合链路。

---

## 12. 关键字段的推荐权威归属

这是后续继续拆模型时建议遵守的 source-of-truth 对照表。

| 字段 / 语义 | 推荐权威来源 | 理由 |
|---|---|---|
| `sessionType` | session index | 产品级分类，不应依赖 session file |
| `activeSessionId` | session index | 会话目录选择态，应由索引层控制 |
| `selectedSessionId` | managed runtime | 运行实例真实附着态，应由进程态控制 |
| 当前宿主 | `currentAgentId` | UI 壳态，需要稳定保持 host identity |
| 当前实例 | `currentRuntimeAgentId` | UI 前台实例态，应独立于宿主 |
| 当前是否显示聊天 | `readOnlyMode || currentRuntimeAgentId` | host 主视图应二元化 |
| 工作空间项目草稿 | workspace state | 与会话索引不同域 |
| 摘要内容是否存在 | session summary 产物 + index 元信息 | 不应从 runtime 临时态推导 |

---

## 13. 文件之间的联动关系

后续接手时，很多改动不是单文件问题。下面列出必须成组考虑的联动。

### 13.1 改 runtime 生命周期时，必须一起看

- `D:/code/AgentDevClaw/server.js`
- `startManagedAgent(...)`
- `stopManagedAgent(...)`
- `waitForManagedRuntimeReady(...)`
- `getConnectedAgents(...)`
- `D:/code/AgentDevClaw/public/src/app-main.js`
- `loadAgents(...)`
- `waitForPrebuiltRuntimeSession(...)`
- `switchAgent(...)`

原因：

- 后端 runtime 结构一变，前端实例树与切换 ready 判定几乎必受影响。

### 13.2 改 host / chat / workspace 主视图逻辑时，必须一起看

- `D:/code/AgentDevClaw/public/src/app-ui.js`
- `getPassiveWorkspaceSurfaceMode(...)`
- `ensureUnitMode(...)`
- `shouldRenderWorkspaceSurface(...)`
- `isChatSurfaceActive(...)`
- `renderWorkspaceTabs(...)`
- `D:/code/AgentDevClaw/public/src/app-main.js`
- `switchAgent(...)`
- `runWorkspaceAction(...)`

原因：

- `app-ui.js` 决定显示规则
- `app-main.js` 决定 current 状态和进入路径
- 只改一边，另一边通常会立刻出现“tab 没选中”或“主视图被拉回去”

### 13.3 改摘要 / compact 相关链路时，必须一起看

- `D:/code/AgentDevClaw/server.js`
- `resolvePrebuiltSessionType(...)`
- 相关 summary route
- `D:/code/AgentDevClaw/scripts/run-compact-mirror.js`

原因：

- 一边决定目标 session 的产品语义
- 一边决定离线 mirror 的模型 / 工具调用语义

### 13.4 改左侧树时，必须确认不会重新把“会话目录”塞回去

重点检查：

- `collectRuntimeEntriesForPrebuilt(...)`
- `renderSidebarChildItems(...)`
- `loadAgents(...)`

验收原则：

- 左侧树表达实例，不表达历史长目录
- child 项应保持极简
- 不要再次把 `workspace_sessions.sessions` 直接铺进左侧

---

## 14. 其他 agent 接手时的工作方式建议

### 14.1 优先从语义入手，不要先补视觉

如果观察到：

- 左侧点不进去
- 中央区域先空白再乱闪
- 历史会话打开后连接灯不稳

优先检查：

- `currentAgentId`
- `currentRuntimeAgentId`
- `readOnlyMode`
- `previousRuntimeId`
- `waitForPrebuiltRuntimeSession(...)`

不要先从 CSS 或 DOM 拼接入手。

### 14.2 遇到“只显示一个实例”时，先判断是后端模型还是前端渲染

先看：

- `managedAgents` 里是否真有多个 runtime
- `getConnectedAgents()` 是否合成了多个 child
- 前端 `allAgents[]` 是否真的收到了多个 child

不要默认是左侧渲染问题。

### 14.3 遇到摘要或 compact 失败时，先分两层排查

1. session 目标语义是否从 index 正确解析
2. mirror runtime 是否走了正确模型预设

不要只盯某个按钮请求。

### 14.4 遇到 host surface 乱闪时，先假设是“工作空间页面状态机”回流

优先看：

- `shouldRenderWorkspaceSurface(...)`
- `isChatSurfaceActive(...)`
- `ensureUnitMode(...)`
- `switchAgent(...)`
- `runWorkspaceAction(...)`

不要默认是消息接口慢。

---

## 15. 推荐的下一阶段改造顺序

下面不是必须一次做完，而是建议的收敛路线。

### 第一步：继续巩固对象分层

目标：

- 在文档和代码层同时固定 `host / session / runtime / surface` 四层概念
- 任何新增逻辑都不要再把它们混回一个“current conversation”

### 第二步：把 `allAgents[]` 从杂交投影层拆成显式 store

目标：

- host store
- runtime store
- workspace session store
- view state store

原因：

- 这是减少“一个字段在多处兼任语义”的根本步骤

### 第三步：继续瘦身 `getConnectedAgents()`

目标：

- 把“连接状态”和“产品摘要投影”进一步拆开

原因：

- 现在它仍太像一个万能汇总口

### 第四步：把工作空间 session list 的打开动作变成更明确的事务

目标：

- 显式定义“打开历史会话”的阶段
- 阶段内哪些状态可以乐观更新
- 哪些状态必须等 runtime ready

### 第五步：继续收口只读记录与 live runtime 的主视图切换

目标：

- `readOnlyMode` 不只是布尔开关，而是更明确的 display-source 描述

---

## 16. 目前哪些事情已经不能再倒退

以下行为如果被未来改动破坏，应视为回归，而不是“实现细节变了”。

- `currentAgentId` 不能在点击 child runtime 后塌成 child id。
- workspace host 的中央区域不能重新变回多层 tab 状态机。
- 左侧树不能重新展开成长会话目录。
- 同宿主多 session 的 managed runtime 不能重新被强行唯一化。
- 打开历史会话时不能再把旧 runtime id 当成新实例 ready。
- `sessionType` 不能再从 session file 盲读。
- compact mirror 不能绕开模型预设解析。

---

## 17. 一句总结

当前系统真正要收敛的，不是某个按钮、某个列表、某个接口，而是把“宿主、会话、实例、显示面”四层语义彻底拆开；近期修复已经开始朝这个方向落地，但 `allAgents[]` 杂交投影、`getConnectedAgents()` 超级汇总、以及工作空间列表打开会话的事务脆弱性，仍然是后续最值得继续清理的根问题。

---

## 18. 建议后续补写的配套文档

如果继续推进，建议在本文件基础上再补两份：

1. “状态迁移图”

建议覆盖：

- 新建会话
- 激活会话
- 打开历史会话
- 点击左侧实例
- 只读查看记录
- generate summary
- compact-resume
- assembly runtime 启动

2. “source-of-truth 字段清单”

建议逐项列清：

- 字段名
- 权威来源
- 使用场景
- 允许谁写
- 允许谁投影
- 不允许从哪里猜
