# BCD SSE 改造准备（调研与实施方案）

状态：v2，可作为实施依据。v1 经对抗性审查（报告：`docs/audits/sse-migration-bcd-preparation-review.md`，5 严重 + 10 中等 + 6 轻微）修订而成：事件源清单升级为全量写入点审计表（§2.3）、`refreshAgentCallStates` 改造语义重写（§5.3）、新增事件消费事务边界与乐观 UI 对账（§5.5/§5.6）、两层断连区分与兜底（§6.5）、hello/eid/bell 三个实现级问题落入 §4.2。架构方向（路径 B）经审查未被动摇。

前置文档：ADR-0013（probe+tail）——本方案与其是接力关系，probe+tail 的分类契约与取数语义全部复用。

## 一、背景与目标

公网部署流量事故（30GB/10天）的根因是三因素叠加：高频轮询（正常 1s / 忙碌 300ms）、链路零压缩、后台 Worker 心跳绕过浏览器节流。止血方案 A（gzip，已落地于 server.js compression 中间件）与 D（焦点 notification 同周期复用，已落地于 refreshAgentCallStates 的 reuseNotification 参数）已上线。

本文档为剩余三项的 SSE 改造做准备：

- **B（后台挂机）**：Web Worker 每秒心跳驱动 N 个 notification + 每 2s choice_alerts，后台 tab 持续烧流量 → SSE 长连接下心跳降频为远程条目专用（本地条目退役，见 §5.4）
- **C（轮询间隔）**：状态端点轮询（notification/connection/todo/input-requests/overview/queued-inputs）→ 事件驱动，间隔参数消失
- **D（焦点重复请求）**：已在轮询内修复，SSE 下天然消解（单源推送）

上次评估结论：SSE 优于 WS（浏览器原生重连 + Last-Event-ID、纯 HTTP 代理兼容、写操作仍走 POST）；messages 沿用 probe 增量；总流量预期 -95%（30GB → 1-2GB/10天）。

## 二、现状全景（代码级调研结论，行号经审查核实）

### 2.1 进程与链路拓扑

```
浏览器 (1420)
  │  fetch /api/agents/:id/* （Cookie 鉴权）
  ▼
server.js Express 进程 ─── compression(全局) → securityHeaders → authMiddleware
  │  L1002 app.get(/^\/(api|tpl|r)/) → proxyToViewer
  │  proxyToViewer：缓冲式（fetch + arrayBuffer + res.end）── SSE 不兼容
  │  内嵌 ViewerWorker 实例（L167，@agentdevjs/viewer，HTTP 2026 + UDS server）
  │  /protoclaw/* 路由：Claw 侧自持数据（choice_alerts 聚合、prebuilt_sessions、context_guard_status…）
  ▼
ViewerWorker 内存（agentSessions Map）
  ▲  UDS IPC 推送（agent runtime 子进程内 DebugHub 客户端）
  │  push-notification / update-agent-overview / update-todo-plan /
  │  push-messages / request-input / input-request-cancelled /
  │  register-agent / unregister-agent
agent runtime 子进程
```

关键事实：

- **ViewerWorker 与 Express 同进程**。所有 HTTP 状态端点都是内存快照读取；数据变化的真实时刻是 IPC handler 的写入时刻。
- **代理是缓冲式**（`server/shared/proxy.js` L390 `await response.arrayBuffer()`）。ADR-0013 当年搁置 SSE 的两大阻力之一即此；路径 B 从架构上绕开它，代理不改。
- **鉴权兼容**：authMiddleware 走 Cookie session，GET 免 CSRF 检查（`server/auth.js` L311-333）——EventSource 同源自动携带 Cookie，无需任何改动。鉴权生命周期见 §6.11。
- **仓库内无 SSE 先例**（全仓库无 `text/event-stream`），需从零建立封装。
- session 无自动清理定时器（updateSessionActivity 仅更新时间戳），长连接无干扰。
- 注：框架存在第二传输模式 `AGENTDEV_DEBUG_TRANSPORT=claw`（debug-transport.ts，HTTP 直投 Claw），Claw 主场景默认 UDS 成立，本方案拓扑按 UDS 描述；该模式下事件 emit 点同样在 ViewerWorker 之外的直投路径上，P0 实现时需注记核实（非主场景，不阻塞）。

### 2.2 前端请求源全景（SSE 改造对象加粗）

| # | 请求 | 频率 | 触发点（文件） | SSE 后 |
|---|---|---|---|---|
| 1 | **notification**（焦点） | 每轮 | refreshCurrentRuntimeStatus（agent-data-loader.js L185） | 事件替代 |
| 2 | **connection**（焦点） | 每轮 | 同上 L186 | 事件替代 |
| 3 | context_guard_status | 每轮（仅 ContextGuard 工作空间） | 同上 L184 | 保留（低频面窄）；三请求同函数的拆分见 §5.2 |
| 4 | **input-requests** | 每轮 | app-main.js L1015 | 事件替代 |
| 5 | **overview** | 每轮 | app-main.js L1016 | 事件替代（含 probe 组装） |
| 6 | **todo** | 每轮 | app-main.js L1017 | 事件替代 |
| 7 | messages | probe 决定（0-1 次） | app-main.js L1102+ | **沿用 probe+tail**，事件仅作变更信号 |
| 8 | **notification × N**（含远程条目） | 每轮 | refreshAgentCallStates（sidebar-render.js L744） | 本地条目事件替代；远程条目经心跳每 tick 轮询（§5.3 内部分流，无远程条目零请求） |
| 9 | **queued-inputs** | 每轮 | _syncPersistentInputUi（persistent-input.js L823） | 事件替代 |
| 10 | **choice_alerts** | 每 3s | checkGlobalChoiceAlerts（auto-title.js L409-438，非焦点 ClawToast）+ Worker 2s | SSE 激活时整段跳过：首发 toast + 桌面通知由 input-requests 事件帧驱动，bell 双入口在服务端 sse-events（§5.4）。该端点仅聚合本地 runtime，不含远程条目 |
| 11 | loadAgents / workspace sessions | 每 3s | app-main.js L1373 / L1393 | loadAgents 降频 30s 兜底 + connection 事件即时触发（注意：loadAgents **无** revision 短路——那是 workspace sessions 的机制，两者不要混算成本）；workspace sessions 保留 revision 短路 |
| 12 | hooks（面板激活时） | 每轮 | app-main.js L1461 | 保留（面板态低频） |
| 13 | **Worker 心跳**：N × notification + choice_alerts | 后台每秒 | desktop-notify.js L349-373 IIFE | SSE 激活：call 轮询内部降为远程专用（无远程零请求）、choice 30s 低频重扫（重提醒/离场补发）、前台时钟刷新保留；降级回基线全量（§5.4） |

消费方状态（事件驱动后需继续维护的核心）：

- `_agentCallActive` Map + `_interruptSuppression` 粘性中断态（app-core.js L485-489）——由 notification 事件继续驱动
- `_appliedMessagesSeq`（messages seq 对账，app-main.js L799）——probe+tail 复用不动
- `_queuedTexts`（队列气泡）——由 queued-inputs 事件驱动，乐观项对账见 §5.5
- 通知去重族（_notifiedFinishMap、_seenChoiceAlertIds 等，desktop-notify.js / auto-title.js）——保留，由事件直接调用 _tryNotifyAgentFinished / _tryNotifyInputRequest
- 前台宽限期 / 前台观察标记（FOREGROUND_GRACE_MS 族）——保留。注意其时钟源依赖 Worker 心跳的 `_syncForegroundState()`（L356），心跳退役后时钟源迁移见 §5.4

### 2.3 事件源清单：全量写入点审计表

每个 ViewerWorker 内存写入点即一个 SSE 事件源。v1 只列了 IPC handler 主入口，审查发现多条**非 IPC 的写入路径**（lease 提交、队列转交、注册对账、会话删除）同样改变前端可见状态，漏挂即用户可见回归。全量清单如下（`packages/viewer/src/viewer-worker.ts`）：

**notification（含 callActive / state / event）**

| 写入点 | 行号 | 触发场景 |
|---|---|---|
| handlePushNotification | L1906 | IPC push-notification（call.start/finish、llm.*、tool.*、state/event；`session.events.push` 唯一写入点在 L2063，push 时 lastEventCount 同步 ++） |
| handleRegisterAgent 重连对账 | L1448-1451 | runtime 重连时作废旧 call 状态（callActive=false、currentState=null） |

**overview / todo**

| 写入点 | 行号 |
|---|---|
| handleUpdateAgentOverview | L1486（/overview 含 _messagesProbe 组装 L703-705） |
| handleUpdateTodoPlan | L1497 |

**messages（probe 信号）**

| 写入点 | 行号 | 说明 |
|---|---|---|
| handlePushMessages | L1526（_messagesChangeSeq L1574） | full/append/tail + generation |
| `_messagesNeedsResync` 静默分支 | L1556-1560 | 增量校验失败时不更新内存、**不产生任何变更**；下一次 full 到达自愈。此分支无需 emit（内存未变），但意味着**前端 seq 可能长于 Viewer 内存**——前端对账矩阵已容忍（`_appliedMessagesSeq` 高于 probe seq 时不动作），P0 测试需覆盖该场景 |

**input-requests（inputLease，共 5 个写入点）**

| 写入点 | 行号 | 行为 |
|---|---|---|
| handleRequestInput | L2259（设置 lease，L2295） | IPC request-input |
| handleInputRequestCancelled | L2304-2309（清除） | IPC input-request-cancelled |
| handlePostInput | L880 起（提交校验后清除） | **前端提交输入卡的唯一路径**，POST /input-response |
| submitUserTurn lease 直投分支 | L995-1002（forward 成功后 `delete session.inputLease`） | runtime 在线时 lease 直投 |
| handleRegisterAgent 租约对账 | L1455-1473（按注册快照恢复或 `delete`） | runtime 重连：DebugHub 给出的 lease 是唯一仍有 resolver 的所有者，旧租约必须替换。实现偏差（已审定）：对账本身不单独 emit input-requests/notification，改由对账尾部 `connection{reconnected:true}` 驱动前端全量对账轮覆盖（含 call 维度，forceFull 轮 includeSseLocals）——避免重连风暴下的事件放大 |

**queued-inputs（共 3 个写入点 + 1 个消费转交点）**

| 写入点 / 消费点 | 行号 | 说明 |
|---|---|---|
| submitUserTurn 排队分支 | L1023（enqueueQueuedInput 调用；函数定义 L1115） | POST /user-turn 排队 |
| handleDequeueInput | L1164 | 常规出队 |
| handleRequestInput 队列转交 | L2273-2281（`session.queuedInputs.shift()`，L2277） | 新输入请求到达时直接转交队首，**不经过 dequeue 端点** |

**connection / 会话生命周期**

| 写入点 | 行号 | 说明 |
|---|---|---|
| handleRegisterAgent | L1369 | 含重连场景（旧状态作废 + 租约对账 + reRegisterAgents 全量重推，见 §6.5） |
| handleUnregisterAgent | L1889 | 正常注销 |
| handleDeleteAgent | L835-857 | 删除已断开会话（第三个 agentSessions 删除点） |
| UDS client close/error | L249-257 | 断连。close 回调只携带 clientId，一个 UDS 连接可承载多 session（L1383-1386），P0 实现时需遍历 `agentSessions` 反查 `session.clientId` 求 agentId 集合 |

事实修正（v1 误述）：`/notification` GET 的 hasNewEvents 字段**没有**"读即消费"副作用——L2063-2064 push 与 lastEventCount++ 同步执行，`events.length > lastEventCount` 恒为 false，L731-732 的对齐是无效果操作。SSE 不依赖该字段，此修正只影响对通知链路的其他推断。

## 三、核心架构决策：SSE 端点位置

### 路径 A：ViewerWorker 加 `/api/agents/:id/events` 端点 + 代理流式改造

- 框架包承担 SSE 协议实现；proxyToViewer 需新增流式分支（Readable.fromWeb pipe + 头部特判）
- 跨两个仓库联动；per-agent 连接（N runtime = N 条连接）
- ADR-0013 当时认知下的方案

### 路径 B（选定）：Express 侧端点 + 框架暴露进程内事件订阅 API

- 框架侧唯一改动：ViewerWorker 暴露订阅接口（如 `onSessionEvent(listener)` / EventEmitter），在 2.3 审计表各写入点 emit。协议无关、无 HTTP 语义
- Claw 侧 server.js 已持有 viewerWorker 实例（L167），SSE 路由**进程内直连事件流，完全绕开缓冲式代理**——ADR-0013 的阻力 1 直接消解
- 单条聚合流 `/protoclaw/events`（事件帧携带 agentId 路由），每页 1 条连接，天然覆盖 B/C/D
- 降级、鉴权、心跳、Nginx 头全部在 Claw 侧掌控，框架不感知部署形态
- 发版：viewer 包小版本单独发（解耦 Claw 迭代节奏）；开发态 junction 即时生效，发布态走 `agentdev:published` 对齐

选择 B。

## 四、服务端设计

### 4.1 框架侧最小改动（AgentDev/packages/viewer）

1. `ViewerWorker` 增加事件总线与订阅 API：

```ts
export type ViewerSessionEvent =
  | { kind: 'notification'; agentId: string; payload: NotificationSnapshot }
  | { kind: 'overview'; agentId: string }
  | { kind: 'todo'; agentId: string }
  | { kind: 'messages'; agentId: string; probe: MessagesProbe }
  | { kind: 'input-requests'; agentId: string }
  | { kind: 'queued-inputs'; agentId: string }
  | { kind: 'connection'; agentId: string; connected: boolean; reconnected?: boolean };

onSessionEvent(listener: (e: ViewerSessionEvent) => void): () => void
```

2. emit 点 = §2.3 审计表全量（含 handlePostInput、submitUserTurn 直投、register 租约对账、队列转交、handleDeleteAgent）。connection 事件在 register/unregister/UDS close·error 三类写入点 emit；register 重连场景携带 `reconnected: true`（供 §6.5 resync 语义）
3. 消息事件只发 probe（seq/count/changeKind/**sinceIndex/fakeFullBytes**——ADR-0013 契约字段补全，缺 fakeFullBytes 会使 msgMetrics 计量静默归零），不发消息体——增量取数仍由前端按 probe+tail 主动拉

### 4.2 Claw 侧 SSE 端点

路由：`GET /protoclaw/events`（authMiddleware 之后注册即可；/protoclaw 受保护路径）

```js
// 必须先于任何 write 设置，compression filter 依据它跳过
res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
res.setHeader('Cache-Control', 'no-cache');  // 允许缓存协商、禁止复用过期响应；no-store 会导致每次重连全量重建，无必要
res.setHeader('X-Accel-Buffering', 'no');   // Nginx 不缓冲，FRP 无感知

res.flushHeaders();
res.write(`retry: 3000\n\n`);
```

**连接建立的固定时序**（防 hello 前丢事件）：

1. 鉴权通过 → 2. `onSessionEvent` 订阅（到达的事件进连接私有缓冲）→ 3. 组装 hello 快照（当前会话清单 + 各 agent pending input-requests（含 choices，供 bell 首连）+ probe 基线）→ 4. 回放订阅缓冲中 eid 大于快照基线的帧 → 5. 写 hello 帧（含快照与起始 eid）→ 6. 进入常态推送。

订阅早于快照，快照与订阅间隙的变更必然以缓冲帧形式补齐；hello 之后前端从连续 eid 消费。禁止"先快照后订阅"——间隙变更既不在快照也未被订阅捕获，静默丢失且 Last-Event-ID 无法补救。

其余：

- **compression 冲突处理**（必须）：`text/event-stream` 是 compressible mime，被 compression 包装后 zlib 不主动 flush，事件帧滞留缓冲。改 server.js L165：

```js
app.use(compression({
  filter: (req, res) => {
    if (String(res.getHeader('Content-Type') || '').startsWith('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));
```

- **心跳**：15s 一帧 `: ping\n\n`（comment 帧，约 50B）。三重作用：Nginx proxy_read_timeout（默认 60s）、FRP 空闲断连、中间层活性探测。15s 心跳下 B 项挂机流量 ≈ 280KB/天/连接，可忽略。心跳只证明连接存活，不证明数据新鲜——数据新鲜由 §6.5 的对账兜底负责
- **事件 id 与重放**：进程内全局单调计数器 eid 写入 SSE `id:` 字段；环形缓冲最近 512 条事件帧。重连携带 Last-Event-ID 时的判定规则（唯一语义，无实现自由度）：eid 在缓冲内 → 重放其后帧；eid **不在缓冲内**（含断线过久、含服务端重启后计数器归零而客户端携带旧大值）→ 先发 `event: resync` 帧，前端触发一次完整 poll() 兜底对账（复用现有状态机）。禁止实现为"eid < 最旧缓冲则重放"——重启后旧大 eid 会误判
- **bell 首连**：terminal bell（playSoundOnServer + _seenChoiceRequestIds 去重）从 GET /protoclaw/choice_alerts 迁移到事件分发后，必须双入口：hello 快照扫描一次（覆盖服务端重启 / SSE 首连时已 pending 的 choice）+ input-requests 事件触发。仅事件入口则首连盲区，bell 永不响
- **连接管理**：`req.on('close')` 解除订阅；连接数上限（建议 64，超出返回 503 + `sse_unavailable` 标记，前端自动降级轮询）

### 4.3 事件帧格式

data 域为 `{kind, agentId, data}` 统一信封（与 P0 `ViewerSessionEvent` 对齐；kind 冗余于 event 名，便于非 EventSource 客户端单帧自描述）：

```
id: 1042
event: notification
data: {"kind":"notification","agentId":"session-x","data":{ ... 与 GET /notification 响应体同构 ... }}

id: 1043
event: messages
data: {"kind":"messages","agentId":"session-x","data":{"seq":37,"count":21,"changeKind":"tail","sinceIndex":120,"fakeFullBytes":4096}}

id: 1044
event: connection
data: {"kind":"connection","agentId":"session-x","data":{"connected":false}}
```

设计原则：**快照事件 payload 与现有 GET 端点响应体同构**——前端消费函数（updateNotificationStatus、normalizeTodoPlan、签名对比等）零改动，只是数据来源从 fetch 响应换成事件帧。消费侧事务边界与乐观 UI 对账是例外，见 §5.5/§5.6。

事件分类与前端动作：

| 事件 | payload | 前端动作 |
|---|---|---|
| notification | GET /notification 同构 | §5.6 事务边界 → updateNotificationStatus + _agentCallActive 维护 + _tryNotifyAgentFinished（true→false 转换检测） |
| connection | {connected, reconnected?} | setConnectionStatus + 触发即时 loadAgents；reconnected=true 时该 agent 走一次对账（§6.5） |
| todo | GET /todo 同构 | 签名对比 → plan badge / 面板渲染 / interruptTargetId 同步 |
| input-requests | 全量列表 | 焦点会话：卡片渲染 + _tryNotifyInputRequest；**非焦点 agent：ClawToast（checkGlobalChoiceAlerts 的通知逻辑迁移为事件驱动，_seenChoiceAlertIds 去重照旧）** |
| queued-inputs | 全量列表（含排队 id） | _queuedTexts / 队列气泡，乐观项按 id 对账（§5.5） |
| overview | GET /overview 同构 | overview 签名对比 + 上下文条 |
| messages | 仅 probe（含 sinceIndex/fakeFullBytes） | 复用 probe 对账 → 决定 /messages 增量拉取 |
| resync | 无 | 触发一次完整 poll() |

## 五、前端设计

### 5.1 新模块 `public/src/modules/sse-client.js`

职责（单例，模块局部状态）：

1. EventSource 生命周期：连接、`onerror` 熔断（连续 3 次失败 → 标记不可用，冷却 60s 后重试——防止服务端未部署/中间层剥离时死循环重连）
2. **鉴权闭环**：onerror 时（进入熔断前）探测一次任一受保护轻量 GET；401 → 停止重连、置 sseUnauthorized，交由现有登录过期流程接管。挂机期间 idle 过期由 §6.11 的看门狗顺带刷新，此路径只兜绝对过期（7 天）与主动 logout
3. 事件分发：按 event 类型 + agentId 路由到注册的 handler（分发前统一走 §5.6 事务边界）
4. 模式切换：`isSseActive()` 供 poll 循环与各模块查询；连接成功且收到 hello 帧 → 激活；熔断/主动关闭 → 降级
5. **30s 静默看门狗**：30s 未收到任何事件帧（心跳不算）→ 触发一次常规 poll()（§6.5 第 c 层兜底）。空闲 agent 无事件是正常态，此时 poll 检测"agent 开始干活而我不知情"，成本每 30s 一次可忽略
6. resync 处理：触发 `window.ClawFW.requestImmediatePoll()`
7. 开关：URL `?sse=0` 禁用 / `?sse=1` 强制建连（调试用；连接失败仍走熔断降级，不因开关停用降级路径）

### 5.2 poll 循环改造（app-main.js runPollCycle）

SSE 激活时：

- 跳过 2.2 表中"事件替代"项（#1/2/4/5/6/8 本地条目/9/10）
- **refreshCurrentRuntimeStatus 拆分**：该函数（agent-data-loader.js L184-187）在同一个 Promise.all 内拉 notification/connection/context_guard_status 三者并经 commitSessionViewPatch 一起提交。SSE 激活时前两者由事件供数，函数降级为仅 guard 的轻量形态（新拆出，仅 ContextGuard 工作空间调用）；fallback 时整函数原样
- **messages 拉取逻辑不动**：probe 到达路径从 overview 响应改为 messages 事件帧，seq 对账矩阵原样运行
- loadAgents：connection 事件触发即时刷新 + 30s 兜底（替代 3s 轮询）
- workspace sessions / hooks：保留现有节奏（revision 短路已很便宜）
- 会话切换 loadAgentData、visibilitychange 强刷、requestImmediatePoll：全部保留（SSE 只优化稳态，全量对账路径永远在线）

SSE 未激活时：现有行为逐字节不变（fallback 完整性要求）。

**验收口径**（P2 量化，替代"稳态请求 ≈ 0"的不可证伪表述）：SSE 激活且前台稳态（无用户操作、无 agent 活动）时，网络面板断言请求清单仅含：context_guard_status（ContextGuard 工作空间每轮）、workspace-sessions/3s、hooks（面板态）、loadAgents/30s、看门狗 poll/30s——除此之外零请求。

### 5.3 refreshAgentCallStates 改造（sidebar-render.js）——整函数语义切换

**该函数不是单纯的 fetch 驱动器**：每轮 poll 还执行"缺席=空闲"的状态覆写（L755 `backendCalling = nextCallStates.get(runtimeId) === true`、L803-806 `agent.callActive = nextCalling`、L782-790 孤儿清理）。若只停掉本地条目的 fetch，事件刚写入的 `_agentCallActive`/`agent.callActive`（转圈动画、打断按钮、true→false 完成检测输入）会在 1s 内被轮询路径系统性擦除——侧栏闪烁、完成通知错乱、_interruptSuppression 提前清除。

SSE 激活时的正确语义：

- **本地条目整函数跳过**：不 fetch、不参与 nextCallStates 构建、不进入覆写循环、不进入孤儿清理集合。本地条目的 _agentCallActive 与 agent.callActive 唯一写入源是 notification 事件 handler（走既有 resolveNotificationCallingState → _agentCallActive → 转换检测链路，逻辑复用，数据入口换事件帧）
- **远程条目（remote: 命名空间）保留完整现有行为**：fetch + 覆写循环照旧（远程数据在远程主机的 ViewerWorker，本地 SSE 覆盖不到）
- 调用方收敛：poll 主循环（app-main.js L1253）、无 runtime 分支（L956）、visibilitychange（L1529）、loadAgents 后（sidebar-render.js L625）四处调用点统一经 `shouldPollCallStates(agent)` 判定（本地条目在 SSE 激活时返回 false）

这是状态机级改动（ADR-0013 阻力 2 的真实残留），但被限定在单函数与其调用判定内，不扩散。

### 5.4 Worker 心跳改造（B 项，desktop-notify.js L349-373 IIFE）

心跳每秒做三件事，按 SSE 状态分流处理（最终实现，含 P3 审查修复）：

1. `_syncForegroundState()`（L356，_lastForegroundTs 时钟源）：**保留每秒执行**——宽限期判定（FOREGROUND_GRACE_MS 族）依赖它在后台 tab 持续刷新；纯内存操作成本为零
2. `refreshAgentCallStates(force)`（L361）：SSE 激活时函数内部自动降为**远程条目专用轮询**（§5.3，无远程条目时零请求，每 tick 保持）；本地条目由 notification 事件驱动
3. `refreshChoiceAlertStates()`（L365-368）：choice 首发通知由 input-requests 事件帧驱动（焦点 + 非焦点，bell 双入口在服务端 sse-events，与 choice_alerts 路由共享去重集合）；心跳保留 **30s 低频重扫**（基线 2s 的 1/15）补住两个基线职责——长挂起 choice 的 30s 周期重提醒、前台到达后离场的补发（markObserved:false 语义）。注意：choice_alerts 端点仅聚合本地 ViewerWorker runtime，**不含远程条目**（M5 审查断言有误，已直读路由与实测验证；远程 choice 检测在改造前后均不存在，属未来功能）

净效果：后台稳态请求 = 远程条目 call 轮询（无远程工作空间时零）+ 每 30s 一次 choice 重扫；SSE 断连/降级瞬间 isSseActive() 翻 false，下一 tick 自动回到基线全量节奏。

### 5.5 D 项与乐观 UI 对账

reuseNotification 机制保留在 fallback 路径；SSE 激活时单源推送，重复请求类别整体不存在。

**排队气泡乐观项对账**（POST /user-turn 响应与 enqueue 事件帧分属两条 TCP 连接，到达顺序不确定）：

- 乐观锚点：POST /user-turn 响应携带服务端排队 id（viewer-worker.ts L1025-1029 `delivery:'queued', id`）。前端乐观 push `_queuedTexts` 时记录该 id（POST 失败路径 runtime_not_accepting_input 不产生乐观项）
- SSE queued-inputs 快照按 id 对账：快照含该 id → 确认（清乐观标记）；连续两个快照不含该 id 且超过 10s TTL → 移除（已被消费/转交）
- 乐观回显（user echo）沿用 `reconcileOptimisticUserEchoes`（persistent-input.js）既有机制：messages 事件驱动的增量拉取完成后对账，逻辑不动

### 5.6 事件消费事务边界（等价于 fetch 路径的 sessionViewPatch）

fetch 路径每一环都有 `captureSessionViewToken` / `isSessionViewTokenCurrent` / `commitSessionViewPatch` 三件套（app-main.js 十余处），保证"fetch 期间切换会话则丢弃响应"。事件路径需要等价物：

- **焦点判定**：事件帧携带 agentId。到达时若 `agentId === currentRuntimeAgentId`（同步读取，不用异步态），事件 payload 经 `isSessionViewTokenCurrent` 校验后走与 fetch 响应完全相同的消费链（含 commitSessionViewPatch）；非焦点条目只更新侧栏级状态（_agentCallActive、连接标记、ClawToast），不触碰焦点视图状态
- **竞态窗口**：切换会话瞬间在途的旧会话事件按上一条规则自然落入"非焦点"分支，安全；切换后的新焦点会话由 loadAgentData 全量对账补齐（既有路径），事件只做增量
- handler 注册集中在 sse-client，消费函数复用现有实现，新增的只有分发前的这两个判定

## 六、兼容性与风险清单

| # | 风险 | 结论 / 对策 |
|---|---|---|
| 6.1 | compression 压坏 SSE | filter 排除 text/event-stream（§4.2），已验证挂载点在 L165 全局 |
| 6.2 | Nginx 缓冲 / 读超时 | X-Accel-Buffering: no + 15s 心跳帧；部署方 Nginx 零配置改动 |
| 6.3 | FRP TCP 隧道 | 纯 TCP 透传无 HTTP 感知；心跳帧防空闲断连；半开连接靠心跳 write EPIPE + req close 清理 |
| 6.4 | **远程工作空间（remote:）** | 本地 SSE 只覆盖本地 ViewerWorker 会话；远程条目保留轮询（读透传白名单机制不动）+ Worker 心跳 5s（§5.4）。远期远程主机升级后可扩展"server 订阅远程事件流"，本期明确不支持 |
| 6.5 | **两层断连要分开处理**（v1 混为一谈） | 层 1 = SSE 连接（server→浏览器）：Last-Event-ID + 512 环形缓冲重放，eid 失配（含服务端重启归零）→ resync 帧 → 一次完整 poll 对账。层 2 = UDS 推送（agent→server）：断连窗口内 DebugHub 静默丢弃 push、退避 30s 封顶（debug-hub.ts L1082-1086），ViewerWorker 内存停旧**且不产生事件**——SSE 重放机制完全覆盖不到。对策三层： UDS 重连后 DebugHub `reRegisterAgents` 全量重推（框架既有语义），ViewerWorker 在 register 重连对账（作废旧 call 状态 + 租约对账）尾部 emit `connection{reconnected:true}`，前端对该 agent 触发一次对账 poll； 前端 30s 静默看门狗（§5.1）； loadAgentData/visibilitychange/requestImmediatePoll 全量对账路径永远在线。净效果：任何一层丢失的最长盲窗 ≈ 30s，且有兜底闭环，不出现状态黑洞 |
| 6.6 | 多 tab 连接数 | 每 tab 1 条聚合流；HTTP/1.1 同域 6 连接预算要如实计算：1 SSE + dispatch long-poll（25-30s 挂起，若启用）+ group-chat long-poll（同前）+ 写请求 keep-alive 复用 + 偶发上传。**多 tab + dispatch/group-chat 同开的极端场景可能顶满 6 槽**：表现为 EventSource 或 long-poll 排队断连，前者自动重连 + 熔断降级可自愈，后者是既有现状（非本次引入）。标注不阻断；HTTP/2 部署形态下无此限制 |
| 6.7 | 前端竞态状态机 | 不是零重构：`refreshAgentCallStates` 整函数语义切换（§5.3）、事件消费事务边界（§5.6）、乐观 UI 对账（§5.5）是三处真实状态机改动。但各自限定在单函数/单分发层/单对账规则内，消费函数本体与 messages 对账矩阵原样复用。改动范围已在本文档逐处写明，无隐藏重构 |
| 6.8 | 服务端事件风暴（流式输出期 llm.char_count 高频） | notification 事件在服务端做 250ms 合并窗口（同 agent 只发最新快照）；事件帧本身很小（notification ~2.4KB raw），合并后忙碌态约 4 帧/s × 2.4KB，可接受。窗口值 P2 用 msg_metrics 实测调优 |
| 6.9 | EventSource 不可自定义 header | Cookie 鉴权同源自动携带，已确认兼容；不引入 token query 参数 |
| 6.10 | 框架发版耦合 | viewer 包加订阅 API 属纯增量；开发态 junction 即时生效，发布态走 `agentdev:published` 对齐；Claw 侧需防御旧框架无订阅 API（启动探测，缺失则 SSE 特性整体关闭，降级轮询）。定案：viewer 小版本单独发 |
| 6.11 | **鉴权生命周期闭环** | auth.js idle TTL 3 天 / 绝对 7 天。SSE 心跳帧不经 authMiddleware 不刷新 lastActiveAt，但前端 30s 看门狗 poll（§5.1）经鉴权，持续刷新 idle 时钟——**前端活着就不会 idle 过期**。绝对过期或 logout 后重连 401：EventSource 规范行为是按 retry 循环重试，由 §5.1 的 401 探测闭环拦截（停止重连 + 交登录流程），不产生重连风暴 |
| 6.12 | 第二传输模式注记 | `AGENTDEV_DEBUG_TRANSPORT=claw`（debug-transport.ts）下 IPC 推送走 HTTP 直投不经 UDS；Claw 主场景默认 UDS，本方案成立。P0 实现时注记核实该模式的 emit 覆盖（非主场景，不阻塞） |

## 七、分阶段实施计划

| 阶段 | 内容 | 仓库 | 验收 |
|---|---|---|---|
| P0 | viewer 包 onSessionEvent 订阅 API + §2.3 审计表全量写入点 emit（含 reconnected 标记、UDS close 反查）+ 单测 | AgentDev | 订阅收到全部事件种类（含 handlePostInput 清 lease、队列转交、register 对账三类非 IPC 路径）；无订阅者时零开销 |
| P1 | server.js SSE 端点（§4.2 固定时序 + eid 失配 resync + bell 双入口）+ compression filter + 心跳 + 重放缓冲 + 连接上限 | Claw | curl 长连接收到心跳与事件；Last-Event-ID 重放正确；**eid 归零场景（重启服务端）返回 resync**；压缩 JSON 不回归 |
| P2 | sse-client.js（熔断 + 401 闭环 + 看门狗）+ poll 开关 + refreshAgentCallStates 语义切换 + refreshCurrentRuntimeStatus 拆分 + 事件消费事务边界 + 乐观项对账 + 默认开启（`?sse=0` 可关） | Claw | §5.2 验收口径的请求清单断言；会话切换/断线重连/降级路径全过；`?msg_metrics=1` 计量验证（probe 含 fakeFullBytes 不归零） |
| P3 | Worker 心跳改造（本地退役、远程 5s、时钟源迁移）+ loadAgents 降频 + 观察期 | Claw | 后台挂机流量 ≈ 心跳帧级别（无远程条目 <1MB/天；有远程 ≈ 5s×远程条目数）；桌面通知时延 ≤1s 且无误报 |
| P4（远期，可选） | workspace sessions / hooks 事件化；远程条目事件隧道 | 两仓库 | 另立方案 |

每阶段独立可回退：P2 灰度开关随时切回轮询；P3 心跳改造是唯一"删除"动作，放在观察期后。

## 八、已定决策与遗留调优项

已定（本轮权衡落定，实施不再讨论）：

1. **远程条目心跳 = 5s**（§5.4）：远程 choice 后台通知无替代路径（唯一路径），5s 时延可容忍、流量与远程条目数线性相关
2. **乐观 UI 对账 = POST 响应排队 id 锚点**（§5.5）：比纯前端 uuid 强（服务端确认即有真 id），比时间窗抑制干净（无抑制副作用）
3. **S5 兜底 = reconnected resync + 30s 看门狗 + 全量对账常驻**（§6.5）：复用框架既有 reRegisterAgents 重推语义，不新造 probe-only 端点
4. **默认开启 SSE**（P2），`?sse=0` 灰度开关保底
5. **viewer 小版本单独发版**，不耦合框架大版本节奏

遗留调优项（不阻塞实施）：

- notification 合并窗口 250ms 初值，P2 用 msg_metrics 实测校准
- claw transport 模式的 emit 覆盖核实（P0 注记）
