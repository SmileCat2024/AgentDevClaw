# SSE 改造准备文档 对抗性审查报告

所有行号、函数名均已对照两仓库真实代码核实。以下按严重程度分级。

---

## 一、致命级

无"架构方向不可行"级问题。路径 B（Express 侧 SSE + 进程内订阅）经查证成立：`server.js` L167 `new ViewerWorker(VIEWER_PORT, false, resolveInstanceUdsPath())` 确认 ViewerWorker 与 Express 同进程，进程内订阅 API 可行。**但存在两条若按文档字面实施将直接产生核心功能回归的设计缺陷**（下述严重级 #1、#2），在补设计之前文档不具备实施条件。

---

## 二、严重级

### S1. 事件源清单实质不完整：inputLease 有 5 个写入点，文档只列了 2 个

文档 §2.3 声称"事件源清单 = ViewerWorker 内存写入点"全景，input-requests 事件源只列 `handleRequestInput L2259 / L2304`。实际 `session.inputLease` 的变更点：

| 写入点 | 行为 | 文档是否覆盖 |
|---|---|---|
| `handleRequestInput` (viewer-worker.ts L2295) | 设置 lease | 是 |
| `handleInputRequestCancelled` (L2309) | 清除 | 是 |
| `handlePostInput` (L884 起，lease 提交后 `delete session.inputLease`) | 清除 | **否** |
| `submitUserTurn` lease 直投分支 (L1002 `delete session.inputLease`) | 清除 | **否** |
| `handleRegisterAgent` 租约对账 (L1455-1473，设置或 `delete`) | 设置/清除 | **否** |

**影响**：用户提交问答卡（`handlePostInput` 是前端提交输入卡的唯一路径）后，若 SSE 只在 request-input/cancelled 时 emit，**输入卡永远不消失**——这是最高频用户路径上的硬回归。同理 `handleRegisterAgent` 的重连对账不发事件，runtime 重连后输入卡状态不一致。

### S2. queued-inputs 事件源漏掉排队转交路径，队列气泡会永久滞留

文档 §2.3 queued-inputs 事件源仅列 `submitUserTurn enqueue / handleDequeueInput L1164`。但 viewer-worker.ts `handleRequestInput` L2273-2281 存在第三条队列消费路径：新输入请求到达时**直接 `session.queuedInputs.shift()` 转交**（L2277），完全不经过 `handleDequeueInput`。按文档清单实施，这条路径发生的队列排空不产生事件 → 前端排队气泡滞留，直到下一次无关事件或 resync。`enqueueQueuedInput` 的 push 点在 `submitUserTurn` L1023（文档写的 L1115 实为 `enqueueQueuedInput` 函数定义行，`submitUserTurn` 在 L942——函数名与行号交叉指认错位）。

### S3. §5.3 分流设计存在状态擦除竞态：SSE 会周期性清掉本地条目的 call 状态

文档 §5.3："SSE 激活时对本地条目不再 fetch：notification 事件直接进入现有状态机"。但 `refreshAgentCallStates`（sidebar-render.js L701）**并不只是 fetch 函数**，poll 主循环每轮仍在调用它（app-main.js L1253 带 reuseNotification、L956 无 runtime 分支、L1529 visibilitychange、sidebar-render.js L625 loadAgents 后）。函数体：

- L755 `backendCalling = nextCallStates.get(runtimeId) === true` —— 本地条目不再 fetch 后，`nextCallStates` 中无本地条目，恒为 false；
- L803-806 `agent.callActive = nextCalling` —— **本地 agent 的 callActive 被每轮 poll 强制覆写为 false**；
- L782-790 孤儿清理循环同样基于完整 `runtimeIds` 集合清 `_agentCallActive`。

即：SSE 事件刚写入的 `_agentCallActive` / `agent.callActive`（转圈动画、打断按钮、true→false 完成检测的输入）会在 1s 内被轮询路径的"缺席=空闲"语义**系统性擦除**，表现为侧栏 call 指示闪烁/消失、完成通知的转换检测错乱、`_interruptSuppression` 提前清除。文档只设计了"数据入口变化"，没有回答"SSE 下这个函数的执行范围是什么"——必须整函数跳过本地条目或重构为远程子集专用，这是状态机级改动，恰是 §6.7 声称"不重构"已消化的那类风险。

### S4. 事件消费侧没有 stale-check 设计，fetch 路径的事务机制没有事件路径对应物

现有 fetch 路径每一环都有 `captureSessionViewToken` / `isSessionViewTokenCurrent` / `commitSessionViewPatch` 三件套（app-main.js L1008/L1021/L1082/L1143...共十余处），保证"fetch 期间切换了会话则丢弃响应"。事件路径按 agentId 路由，但**事件到达与会话切换之间没有事务边界**：用户切走会话的瞬间，旧会话的 notification/todo/input-requests 事件在途，handler 收到后写的是哪个视图？§6.7 用"payload 同构 + 消费函数复用"论证零重构，却回避了 token 机制本身是消费函数不可分割的一部分这一事实。同窗口内还有排队气泡乐观态与事件帧的乱序：POST /user-turn 响应（persistent-input.js L751-755 乐观 push `_queuedTexts`）与 enqueue 事件的 SSE 帧分属两条 TCP 连接，**到达顺序不确定**；事件先到则快照覆盖后乐观再 push → 气泡重复，且 SSE 模式下没有周期性 GET 对账来纠正（现状靠每秒全量覆盖自愈）。文档对乐观 UI（排队气泡 L754、乐观回显 L761 `reconcileOptimisticUserEchoes`、打断粘性态 app-core.js L489）与事件流的交互零着墨。

### S5. messages 停摆窗口失去周期对账兜底

现状 probe 每秒必达（随 overview），seq 对账矩阵（app-main.js L1113-1196）实际是**每秒一次的前端基线 vs Viewer 内存校验心跳**。SSE 化后 probe 只随变更事件到达，而框架存在推送丢失窗口：debug-hub.ts L1082-1086 注释明确 UDS 断连期间 `sendToWorker` 静默丢弃 push，重连退避上限 30s（L1101-1103）；窗口内 ViewerWorker 内存停旧、不产生任何事件，SSE 前端**没有任何周期信号能发现滞后**。文档 §6.5 的 Last-Event-ID/resync 只覆盖"SSE 连接丢失"，覆盖不了"上游 UDS 推送丢失"——两个断连层被混为一谈。另外 viewer-worker.ts L1556-1560 `_messagesNeedsResync` 分支静默 `return` 不 emit，也是无信号变更。

---

## 三、中等级

### M1. hello 帧与订阅的时序未定义
§4.2 写 `res.write(retry)` 后发 hello，§5.1 说"收到 hello 帧 → 激活"。若实现先 `onSessionEvent` 订阅再组装 hello 快照，订阅点到 hello 发出之间的事件帧先于 hello 到达，被前端丢弃（未激活）→ 静默丢事件，且 Last-Event-ID 无法补救（前端没记录过这些 id）。必须规定"先组装快照 → 再订阅 → hello 携带快照 + 起始 eid"。

### M2. 服务端重启场景的 Last-Event-ID 判定未点名
eid 计数器与 512 环形缓冲都是进程内存。Claw server 重启（P1 上线必然发生）后 eid 归零、缓冲清空，客户端重连携带的旧 eid **必然 miss**。文档 §6.5 只写"断线过久"，未把"eid 不在缓冲范围（含计数器重置）→ resync"列为强制实现要求，实现者容易写成"eid < 最旧缓冲则重放"从而对重启后的大 eid 误判。

### M3. 服务端 bell 迁移的初始化盲区
§4.2 将 terminal bell 从 GET /protoclaw/choice_alerts（server.js L984-992 全量扫描 + `_seenChoiceRequestIds`）迁到"收到 input-requests 事件时触发"。但事件只在变更时 emit：**服务端重启或 SSE 首连时已 pending 的 choice 请求不会再有 request-input 事件**，bell 永远不响。需要 hello 帧携带 pending choice 快照或首连补一次全量扫描，文档未提。

### M4. checkGlobalChoiceAlerts（ClawToast）的去向未设计
auto-title.js L409-438 每 3s 扫描**全部** agent 的 choice 请求并弹非焦点提示。§2.2 #10 一句"事件覆盖"，但 §4.3 事件表 input-requests 的前端动作只写了焦点会话的卡片逻辑；非焦点 agent 的 input-requests 事件到达时由谁触发 ClawToast、`_seenChoiceAlertIds` 去重如何迁移，均无设计。

### M5. Worker 心跳退役范围收窄漏掉了两个心跳副作用
desktop-notify.js L349-373 IIFE 每秒做三件事：`_syncForegroundState()`（L356，`_lastForegroundTs` 宽限期时钟源）、`refreshAgentCallStates(force)`（L361）、`refreshChoiceAlertStates()`（L365-368）。§5.3/5.4 只处理了第二个的本地/远程分流：**第三个是远程 agent choice 请求在后台 tab 触发桌面通知的唯一路径**（其数据源 /protoclaw/choice_alerts 含远程条目聚合），心跳退役后远程 choice 的后台通知静默丢失；第一个的退役使宽限期时间戳精度依赖 visibilitychange/focus/blur 事件（L56-59），文档对宽限期只说了"误判率反而下降"，未做这个依赖分析。

### M6. refreshCurrentRuntimeStatus 三请求同函数的改造耦合未指出
agent-data-loader.js L184-187：notification、connection、context_guard_status 在**同一个 `Promise.all`** 里。§2.2 把 #1/#2 列为"事件替代"、#3 列为"保留"，但三者在同一函数同一原子块内，且返回值经 `commitSessionViewPatch` 一起提交（L207-219，还供 refreshAgentCallStates 的 reuseNotification 复用）。SSE 改造要么整函数退役（guard 跟着丢）要么就地重构（违背"仅换数据入口"承诺）。文档的 2.2 表把同一函数内的请求拆成三行独立决策，掩盖了这个耦合。

### M7. 鉴权生命周期与 EventSource 的 401 行为未列入 §6
auth.js L16 `SESSION_IDLE_TTL_MS = 3 天`（闲置过期）+ L17 绝对 7 天。纯 SSE 挂机期间心跳帧不经过 authMiddleware、不刷新 `lastActiveAt`；3 天后断线重连将得到 401，而 EventSource 对非 200 响应的规范行为是 fail 后按 retry 重试——形成 401 重连循环（被 §5.1 熔断压到每 60s 一次），logout 后同理。§6.9 只论证了"Cookie 自动携带"，没有论证"过期后的行为闭环"。

### M8. hasNewEvents"读即消费"是死语义，§2.3 的机制描述与事实不符
viewer-worker.ts 中 `session.events.push` 唯一写入点 L2063，且 L2064 **push 时同步 `lastEventCount++`**。因此 GET /notification L731 `hasNewEvents = session.events.length > session.lastEventCount` 恒为 false，L732 的"读即消费"只是无效果的对齐。"SSE 不依赖 hasNewEvents 与 GET 语义不冲突"的结论碰巧成立，但论证所依赖的机制描述是错的——这类事实错误会误导实施者对通知链路的其他推断。

### M9. P2 验收标准"正常态稳态请求数 ≈ 0"不可验证
§5.2 保留项（ws sessions 3s、hooks、context_guard、loadAgents 30s 兜底、messages probe 增量拉取）在正常态依然产生稳定请求流。"≈0"无法证伪。应改为明确的请求清单断言（如"稳态仅剩 ws-sessions/3s + loadAgents/30s"）。

### M10. §2.2 #11"loadAgents 每 3s（revision 短路）"归属错误
revision 短路是 workspace sessions 的机制（`_wsSessionsRevisionByHost`，app-main.js L805/L810 `sinceRevision`）；loadAgents（L1373-1375）是无短路的每 3s 全量 fetch + 富化。两行合并表述会让实施者误以为 loadAgents 已"便宜"，影响 §5.2 降频决策的成本评估。

---

## 四、轻微级

- **L1** §2.3 "submitUserTurn enqueue L1115"：L1115 是 `enqueueQueuedInput` 定义行；`submitUserTurn` 在 L942，enqueue 调用在 L1023。
- **L2** §4.3 messages 事件示例 `probe:{seq,count,changeKind}` 缺 ADR-0013 契约字段 `sinceIndex`/`fakeFullBytes`（ADR L31），后者缺失会使 msgMetrics 计量（app-main.js L1097）静默归零。
- **L3** connection 事件挂 UDS close（viewer-worker.ts L249-257）需遍历 `agentSessions` 反查 `session.clientId`（close 回调只有 clientId，一个 UDS 连接可承载多 session，L1383-1386），文档未写此映射逻辑。
- **L4** `handleDeleteAgent`（viewer-worker.ts L835-857，删除已断开会话）是 agentSessions 的第三个删除点，§2.3 事件源未列。
- **L5** §6.6 低估 HTTP/1.1 连接槽位竞争：dispatch/group-chat 存在 25-30s long-poll 挂起请求（server/routes/dispatch.js L507、group-chat.js L203/L757），叠加图片上传与多 tab，6 连接上限内不止"1 SSE + keep-alive 写请求"。
- **L6** DebugHub 存在 `AGENTDEV_DEBUG_TRANSPORT=claw` 的第二传输模式（debug-transport.ts L3-4，HTTP 直投 /api/agents/:id/input-response），§2.1 拓扑把 UDS 画成唯一路径；Claw 主场景默认 UDS 成立，但文档应注明条件。

---

## 五、查证后文档正确的关键点（简列）

- proxy.js L390 缓冲式 `arrayBuffer()`；server.js L165 compression 全局、L167 内嵌 ViewerWorker 同进程；auth.js L311-333 GET 免 CSRF、Cookie 同源免改动；`/protoclaw/*` 确在保护路径（auth.js L267）；CSP `connect-src 'self'`（security-headers.js L14）与同源 SSE 兼容。
- 前端行号：app-main.js L1015-1017 / L799 / L1373 / L1393 / L1461，agent-data-loader.js L184-186，desktop-notify.js L349-373 / L361，sidebar-render.js L744，persistent-input.js L823，app-core.js L485-489 —— 全部核实无误。
- viewer-worker.ts 各 handler 行号（1906/1486/1497/1526/1574/2259/2304/1369/1889/1164）全部准确；overview probe 组装 L703-705、lastEventCount L731-732 位置正确（机制描述除外，见 M8）。
- 全仓库无 `text/event-stream` 先例、session 无自动清理定时器、ViewerWorker 无 idle 回收定时器（grep 核实）；`resolveInstanceUdsPath` 多实例管道派生（constants.js L33-45）对路径 B 无影响。
- ADR-0013 的 probe+tail 契约复用叙述与 ADR 文本一致；SSE 优于 WS 的选型论据成立。

---

## 六、总体结论

**不能作为实施依据，需修订后再审。** 架构选型（路径 B）、鉴权兼容、压缩/心跳/重放等传输层设计经查证基本站得住；但事件模型层的三个核心设计——事件源清单（S1/S2：漏 4 个 inputLease 写入点与队列转交路径）、前端分流（S3：会周期性擦除 call 状态）、消费事务（S4：无 stale-check、乐观 UI 无对账节奏）——都存在按文档字面实施即产生用户可见回归的具体路径。M1/M2/M3 属于"实现者必然要回答但文档没有回答"的问题。建议：补齐 2.3 事件源清单为**真实全量写入点审计表**；重写 §5.3 明确 `refreshAgentCallStates` 在 SSE 下的执行语义；为事件消费定义与 `commitSessionViewPatch` 等价的会话事务边界；将 M1-M3 落入 §4.2；再把 P2 验收标准量化为请求清单断言。工作量约一轮修订，架构方向无需推翻。
