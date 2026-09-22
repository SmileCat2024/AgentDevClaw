# SSE 改造 P3 对抗性审查报告（commit fe5526e）

- 审查对象：`fe5526e`（P3：Worker 心跳按 SSE 状态分流），追踪上下游至 P1/P2 已合入的 `sse-client.js` / `sse-events.js` / `sidebar-render.js` / `server.js` choice_alerts 路由。
- 审查方式：只读 + 测试运行（`test/frontend-sse-client.test.js`、`test/frontend-core-helpers.test.js`、`test/frontend-sidebar-call-states.test.js` 全部通过，63 + 12 用例 0 失败）。
- 结论先行：**需修复后合入**。1 项严重（服务端 terminal bell 在 SSE 激活期间全状态失效，且设计文档明确要求迁移而未迁移）、3 项中等、4 项轻微。5 条声明中 3 条成立、2 条部分成立；未发现任何重复通知/重复 toast 路径。

---

## 一、五条核心声明逐条裁决

### 声明 1：SSE 激活时事件帧"全量覆盖"焦点与非焦点 choice 桌面通知，心跳轮询可安全跳过 —— **部分成立**

事件路径的首发通知覆盖本身是完备的：

- 焦点分支：`sse-client.js:124-130`（choice 租约 `.pop()` 后调 `_tryNotifyInputRequest`）；
- 非焦点分支：`sse-client.js:134-141` → `notifyChoiceAlerts`（`sse-client.js:190-192` 新增通知调用）；
- 首连/重连重扫：hello 快照 `scanChoiceAlerts()`（`server/routes/sse-events.js:131-155, 232`）→ `onHello` → `notifyChoiceAlerts`（`sse-client.js:261-263`），覆盖连接建立前已 pending 的请求；
- 谓词三方同源：`mode === 'choices' && questions.length > 0`（`sse-client.js:124-126, 135-136` ≡ `server.js:979-981` ≡ `sse-events.js:141-143`）。

但"全覆盖"在三个维度不成立：

1. **前台到达→离开场景丢失后续通知**（见严重/中等 finding M1）：事件在 tab 前台到达时 `_tryNotifyInputRequest` 走前台分支标记 `_foregroundObservedInputMap`（`desktop-notify.js:242-245`）后返回；用户之后切走，input-requests 事件仅由 worker 写入点驱动（`sse-events.js:107-128`），无周期性重播，该 requestId 再也不会触发通知。改造前心跳路径（`desktop-notify.js:370-373` 的旧逻辑）会在用户离开超过 5s 宽限期后补发通知。
2. **30s 重提醒职责静默消失**（见 M2）：基线心跳每 2s 重扫 pending 请求，`_tryNotifyInputRequest` 的 30s 去重窗口（`desktop-notify.js:269-271`）使长 pending 请求每 30s 重发一次桌面通知；事件路径 `_seenChoiceAlertIds` 无 TTL（`sse-client.js:184-186`），同一 requestId 整个页面生命周期只通知一次。
3. **服务端 bell 无人接手**（见 S1）：心跳跳过后 `GET /protoclaw/choice_alerts` 在 SSE 激活期间零调用，挂在该路由内的 `playSoundOnServer`（`server.js:993-1001`）永久静音。

结论：对"首发桌面通知"声明成立；对心跳承载的完整通知职责（离场补发、周期重提醒、bell）不成立。`desktop-notify.js:362` 注释"（焦点 + 非焦点全覆盖）"表述过强。

### 声明 2：`_tryNotifyInputRequest` 新调用不会在任何时序下产生重复桌面通知或重复 toast —— **成立**

对抗性穷举各交叉时序，未找到重复路径：

| 时序 | 去重屏障 | 证据 |
|---|---|---|
| 同帧重放（Last-Event-ID replay + hello 快照同连接） | replay 帧先于 hello 写出（`sse-events.js:223→226`），帧路径先标记 `_seenChoiceAlertIds`，hello 重扫被 `sse-client.js:184` 跳过 | `sse-events.js:202-234` |
| SSE 激活→断连交叉（事件已通知，心跳恢复后同请求仍 pending） | `_notifiedInputRequestMap` 同 requestId 30s 窗口（`desktop-notify.js:270-271`） | 心跳路径不经过 `_seenChoiceAlertIds`（`desktop-notify.js:313-329` 设计如此），靠 30s 窗口吸收 |
| 焦点分支 → 焦点切换后同请求走非焦点分支 | 焦点分支不写 `_seenChoiceAlertIds`，但 `_tryNotifyInputRequest` 的 `_foregroundObservedInputMap`/30s 窗口按 normId 拦截（`desktop-notify.js:249-256, 269-271`） | |
| hello 重连重扫 vs 已通知请求 | `_seenChoiceAlertIds` 命中跳过；即使 Set 曾被 clear（>500，`sse-client.js:185`），30s 窗口兜底，超 30s 重发属基线重提醒语义 | |
| 双通知同 agent 并发租约 | `_notifiedInputRequestMap` 按 normId 单条目 + Notification 同 tag 替换（`desktop-notify.js:287, 292`）；toast 同 id 更新替换（`toast-notify.js:19` id 键控 Map） | |
| SSE 断连恢复期 toast 重复 | `_active=false` 期间事件源已关闭（`sse-client.js:311-312`），`checkGlobalChoiceAlerts` 与事件路径不会同时活跃 | |

注意：声明 2 只在"重复"维度成立。跳过心跳引入的是**丢失**维度问题（M1/M2/M3），不是重复问题。

### 声明 3：`refreshAgentCallStates` 保留调用安全，SSE 激活时自动降为远程条目轮询、无远程条目时零请求 —— **成立**

- 心跳 `force: true` 只绕过 1s 节流（`sidebar-render.js:795` 的 `!force &&` 短路），不绕过 SSE 分流；
- `includeSseLocals` 缺省 false（`sidebar-render.js:791`）→ `sseSkipLocal = true`（`:807`）→ `polledIds` 仅剩 remote 命名空间条目（`:808-810`，`isRemoteNamespaceAgentId` 定义于 `remote-connections.js:49`）；
- 无远程条目时走 `:811-819` 提前返回：零 fetch，仅做孤儿回收与 prebuilt 宿主行清理；孤儿回收用含本地条目的 `runtimeIds` 全集（`:816`），本地 call 状态键不会被"缺席=空闲"误清；
- 有远程条目时按条目 fetch `/api/agents/<remote>/notification`（`:834-853`），覆写循环对 SSE 管辖的本地条目豁免（`:873-881`）；
- 与 poll 主循环的并发由 `_callStatesRefreshInProgress` 互斥锁兜住（`:793`）；全量对账轮经 `includeSseLocals: forceFullThisCycle`（`app-main.js:1550-1551`）与 visibilitychange 强刷（`app-main.js:1634`）恢复本地轮询，与心跳形态不冲突。

测试锚定：本提交 `test/frontend-core-helpers.test.js:488-558` 锚定心跳层调用形态（force:true + SSE 跳过时零 choice fetch + 降级恢复）；`refreshAgentCallStates` 内部降级语义由既有 `test/frontend-sidebar-call-states.test.js`（S3，12 用例通过）覆盖。两层拼起来完整。

### 声明 4：`/protoclaw/choice_alerts` 仅聚合本地 ViewerWorker runtime、不含远程条目，移除 `!hasOnlineRemoteEntries` 无行为回归 —— **成立**

直读路由实现（`server.js:958-1007`）：数据源是 `${VIEWER_ORIGIN}/api/agents`（`:960`）+ 逐 agent `${VIEWER_ORIGIN}/api/agents/<id>/input-requests`（`:973`），全程只打本地 ViewerWorker；远程条目走 `/r/<connId>/` 代理命名空间（`server.js:1010-1013`），不在 `VIEWER_ORIGIN` 清单内。远程条目的 choice 请求从来就不在此端点的聚合范围——旧注释"前台对远程条目的 choice 检测现状只走本路径"（被本提交删除）与审查 M5 的原始断言（`docs/audits/sse-migration-bcd-preparation-review.md:67-71`"其数据源 /protoclaw/choice_alerts 含远程条目聚合"）均为事实错误，本提交的纠正正确。保留旧条件确实只产生"远程在线时每 3s 一次纯本地冗余请求"。

附带发现：`docs/plans/sse-migration-bcd-preparation.md:63`（#10"远程条目保留心跳路径"）与 `:287`（§5.4-2"choice_alerts 聚合含远程条目"）至今仍保留 M5 的错误前提，未随本提交更正（见 L1）。

### 声明 5：断连/降级瞬间 `isSseActive()` 翻 false，下一 tick 自动恢复全量职责 —— **部分成立**

翻 false 的路径核对：

- `onShutdown`（`sse-client.js:275-278`）：立即翻 false ✓，心跳 ≤1s 恢复（`test/frontend-core-helpers.test.js:533-542` 锚定）；
- `onerror` CLOSED（`:304-321`）：立即翻 false ✓；
- watchdog 半开降级（`:388-395`）：仅当 `readyState !== 1`（`:383`）✓。

**未覆盖的缝隙——半开-OPEN 静默态**：连接死但浏览器 `readyState === 1`（无 FIN 的网络断开、NAT 超时、休眠唤醒）时，`watchdogDecide` 返回 `{poll: true, deactivate: false}`（`:383`），`_active` 恒为 true。此期间：

- input-requests 事件帧不再到达 → 事件路径无输出；
- 心跳跳过 choice 轮询（`desktop-notify.js:368-370`）；
- 主循环跳过 `checkGlobalChoiceAlerts`（`app-main.js:1380-1384`）；
- 关键的是 watchdog 每 30s 触发的 `forceFullPollOnce` 全量轮**也不恢复** choice 拉取——`sseSkipChoiceAlerts` 只看 `isSseActive()`（`app-main.js:1380`），不受 `forceFullThisCycle` 影响（后者只作用于 `sseActiveThisCycle`，`app-main.js:1465`）。

即 choice 桌面通知与 toast 双路径全灭且无自愈，持续到 TCP 层最终报错（可能数分钟）。该缝隙的"无远程条目"形态在 P2 已存在，P3 将其扩展到远程条目在线场景并移除了心跳兜底（见 M3）。

"双路径长时间并跑"方向：未发现缝隙。`_active=false` 的各路径都伴随事件源关闭或服务端收口（`sse-events.js:252-260`），重连由 hello 重新激活，交叉窗口由 30s 去重吸收。

---

## 二、问题清单

### 严重

#### S1. SSE 激活期间服务端 terminal bell 全状态静音，且违反设计文档 §4.2 的强制要求

- bell（`playSoundOnServer('terminal-bell.mp3')`，`server.js:917, 998`）唯一触发点是 `GET /protoclaw/choice_alerts` 路由内的 `_seenChoiceRequestIds` 去重块（`server.js:993-1001`）。
- SSE hub 侧从未实现 bell：`scanChoiceAlerts()`（`sse-events.js:131-155`）只组装 hello 快照数据，不响铃；input-requests 事件 flush（`sse-events.js:84-105`）也不响铃。
- P3 之后 SSE 激活期间该路由的稳态调用方为零：主循环跳过（`app-main.js:1380-1384`）+ 心跳跳过（`desktop-notify.js:370-373`）。唯一残留调用方是 `probeAuthThenRetry` 的 401 探测（`sse-client.js:294`），仅出错时一过性触发（顺带：探测请求会触发响铃，属既有的怪异行为）。
- 设计文档 §4.2 明确要求"terminal bell …… 迁移到事件分发后，必须双入口：hello 快照扫描一次 + input-requests 事件触发"（`docs/plans/sse-migration-bcd-preparation.md:205`），P1 验收标准也含"bell 双入口"（`:332`）。P0-P2 实施评审将"hello.choiceAlerts + 事件双入口 + `_seenChoiceAlertIds` 共享去重"标为 bell 落实 ✅（`docs/audits/sse-migration-p0p2-implementation-review.md:215, 261`）——那是**客户端 toast** 的双入口，服务端**声音**从未迁移，评审结论与实现事实混淆。
- 归属精确化：前台 + SSE 的 bell 死于 P2（`sseSkipChoiceAlerts` 引入即跳过 `checkGlobalChoiceAlerts`，`e3e9be1`）；P3 移除心跳路径后，SSE 激活期间 bell 在**任何**焦点状态下都不再触发。
- 提交信息称 SSE 激活期间该 fetch"纯冗余"——对 toast/桌面通知职责成立，对 bell 职责不成立。该 fetch 是 bell 的唯一携带者。

修复方向：按 §4.2 原设计把 bell 迁入 SSE 管线（`flushPending` 的 input-requests 分支 + hello `scanChoiceAlerts` 双入口，`_seenChoiceRequestIds` 服务端去重照旧），而非恢复前端轮询。

### 中等

#### M1. 前台到达的非焦点 choice 请求：用户离开后不再有桌面通知（基线行为回归）

时序：tab 前台、非焦点 agent 的 choice 到达 → 事件路径 toast + `_tryNotifyInputRequest` 前台分支标记 `_foregroundObservedInputMap`（`desktop-notify.js:242-245`）→ 用户未理会、切走（>5s）→ 请求仍 pending，但事件只在 worker 写入点发射（`sse-events.js:107-128`），心跳又被跳过（`desktop-notify.js:370`）→ 永不通知。

基线（`fe5526e~1`）：事件路径只 toast 不标记（`notifyChoiceAlerts` 无 `_tryNotifyInputRequest` 调用），后台心跳每 2s 轮询 `refreshChoiceAlertStates`，用户离开超过 `FOREGROUND_GRACE_MS` 后由 `_tryNotifyInputRequest` 补发通知（`desktop-notify.js:260-271` 全部放行）。P2 引入前台 toast、P3 引入前台标记 + 心跳跳过，两者叠加造成该回归。

根因：`_tryNotifyInputRequest` 的前台分支语义是"用户正看着，标记已观察"——这对焦点分支（choice 卡片在眼前）成立，对非焦点分支（只有一闪而过的 toast）是过强标记。

#### M2. 长 pending 请求的 30s 周期重提醒静默消失

基线：心跳 2s 轮询 × `_tryNotifyInputRequest` 30s 去重窗口（`desktop-notify.js:269-271`）= pending 请求每 30s 重发一次桌面通知（同 tag 替换，效果为持续提醒）。P3 后 SSE 激活期间：`_seenChoiceAlertIds` 无 TTL（`sse-client.js:184-186`），事件仅在变更时发射，同一 requestId 整个页面生命周期只通知一次（重连 hello 重扫是唯一例外）。

用户错过/误关第一条通知后不再有后续提醒。这是心跳承担的第三项职责，`sse-client.js:176-177` 注释"覆盖原 Worker 心跳 refreshChoiceAlertStates 的通知职责"未声明此差异，提交信息亦未提及。可辩护为有意简化，但属未声明的用户可见行为变更。

#### M3. 半开-OPEN 静默态下 choice 通知双路径全灭且无自愈（声明 5 缝隙，P2 既有、P3 扩大）

详见声明 5 分析。要点：`watchdogDecide` 对 `readyState === 1` 的静默连接只对账不降级（`sse-client.js:383`）；`forceFullPollOnce` 全量轮不含 choice 拉取（`app-main.js:1380` 不受 `:1465` 的 forceFull 影响）；心跳兜底被本提交移除。窗口时长由 TCP 层决定，远超看门狗的 30s 设计兜底周期。消息数据维度有全量对账兜底，通知维度没有。

修复方向（择一）：watchdog 连续 N 次对账后仍静默的 OPEN 连接也置 `deactivate`；或心跳侧独立于 `isSseActive()` 增加低频（如 30s）choice 兜底扫。

### 轻微

#### L1. 权威设计文档未随事实纠正更新

`docs/plans/sse-migration-bcd-preparation.md:63`（#10"远程条目保留心跳路径"）、`:287`（§5.4-2"choice_alerts 聚合含远程条目"）仍保留 M5 的错误前提；`:290`（§5.4-3"refreshChoiceAlertStates 保留"）与 P3 实现相反。提交信息宣称"已直读路由与实测验证"，但认知纠正只落在 commit message 与代码注释，文档（本仓库 SSE 改造的权威实施依据）未同步。

#### L2. `desktop-notify.js:361-367` 与 `sse-client.js:176-177, 187-189` 注释的"全覆盖/接替职责"表述过强

未提前台标记语义差异（M1）与重提醒消失（M2）。后续维护者按注释理解会认为通知职责等价迁移。

#### L3. 新增测试断言强度：心跳层测试 stub 掉了 `refreshAgentCallStates`，声明 3 的实质（内部降级/零请求）不由本提交测试锚定

`test/frontend-core-helpers.test.js:505` 用记录器替换 `refreshAgentCallStates`，`:529` 仅断言"被调用且 force:true"。"内部自降为远程条目专用轮询、无远程条目时零请求"由既有 `test/frontend-sidebar-call-states.test.js`（S3）覆盖，分层可接受，但报告在断言强度上应注明该依赖关系，避免误读本提交测试的覆盖面。`test/frontend-sse-client.test.js:262-283` 的新测试（toast + 通知同帧、同 requestId 去重）锚定真实，强度合格；前台标记语义（M1 场景）无测试。

#### L4. hello 快照对焦点会话的 pending choice 也走 `notifyChoiceAlerts`（含 P3 新增的通知调用）

`sse-client.js:261-263` 无焦点过滤：前台重载且焦点会话有 pending choice 时，choice 卡片已在眼前仍会多一条 toast（P2 既有）+ 一次前台观察标记（P3 新增，语义无害）。因 `_tryNotifyInputRequest` 前台分支与焦点分支谓词一致，不构成缺陷，仅记录。

---

## 三、声明之外的核查项（无问题）

- 谓词同源性：客户端两分支、`choice_alerts` 聚合、hello 快照三处 `mode === 'choices' && questions.length > 0` 完全一致（F1 修复未被 P3 破坏）。
- `_seenChoiceAlertIds` 的 500 上限 clear 在两处调用点行为一致（`sse-client.js:185`、`auto-title.js:417`）。
- `notifyChoiceAlerts` 传 `alertData = null` 仅损失 `agentName` 兜底（`desktop-notify.js:276` 有 allAgents 回退），无功能影响。
- 心跳 `_lastChoiceNotifyCheckAt` 在 SSE 激活期间不推进，降级后首 tick 立即恢复检查（`desktop-notify.js:370` 的窗口判断），无恢复延迟。
- 移除 `hasOnlineRemoteEntries` 未产生死代码：`getVisibleRemoteEntries` 仍被 `sidebar-render.js:691, 913` 使用。
- 宽限期时钟：worker tick 每秒 `_syncForegroundState()`（`desktop-notify.js:356`）在 SSE 激活期间照常运行，`_lastForegroundTs` 不因 P3 改动失准；事件到达侧的时钟刷新钩子（`sse-client.js:67-69`）为冗余增强。

## 四、测试运行结果

```
npm run test:file -- test/frontend-sse-client.test.js test/frontend-core-helpers.test.js
  → 63 tests, 63 pass, 0 fail
npm run test:file -- test/frontend-sidebar-call-states.test.js
  → 12 tests, 12 pass, 0 fail
```

## 五、总结论

**需修复后合入。**

- P3 的核心机制（心跳按 `isSseActive()` 分流、`refreshAgentCallStates` 保留、移除 `!hasOnlineRemoteEntries`）实现正确，5 条声明中 3（声明 2/3/4）经对抗验证成立，无重复通知路径，M5 错误前提的纠正属实。
- 阻塞项：**S1**（bell 静音——设计文档 §4.2 明确要求事件侧双入口，实现缺失且 P3 移除了最后触发路径；提交信息"纯冗余"的论断对 bell 职责不成立）。修复应按原设计在 `sse-events.js` 补 bell 双入口，而非回退前端改动。
- 应决策项：**M1**（前台标记过强导致离场丢通知）与 **M2**（30s 重提醒消失）是同一根因的两个表现——非焦点分支复用 `_tryNotifyInputRequest` 的前台观察语义 + 心跳职责移除。建议要么非焦点前台到达只 toast 不标记 observed，要么 SSE 激活下保留一条低频（30s 级）pending 重扫。
- 记录项：**M3** 半开缝隙建议给 watchdog 补降级条件或在心跳侧留兜底扫；**L1** 文档同步应随本系列收尾完成。
