# SSE 改造 P0-P2 实现对抗性审查报告

- 审查对象：AgentDev `417f5b8`（P0）、AgentDevClaw `07f241a`（P1）/ `7dcae49`（测试修复）/ `e3e9be1`（P2）
- 设计依据：`docs/plans/sse-migration-bcd-preparation.md`（v2）；上轮方案审查：`docs/audits/sse-migration-bcd-preparation-review.md`（S1-S5 / M1-M10 / L1-L6）
- 审查方式：只读 + 测试运行。两仓库 4 个提交的 diff 逐行核对；三段抽取函数与 `e3e9be1^` 原实现逐段比对；全部相关测试实际运行。
- 审查日期：2026-09-20

---

## 一、结论摘要

**需修复后合入。**

架构与主体质量是高的：P0 的轻载荷事件总线 + 快照组装单点（事件路径与 GET 端点永远同构）是对 §4.1 的合理改良；P1 的连接时序（常驻订阅 + 全局环形缓冲 + 同步重放序）比设计文档的"每连接私有缓冲"方案更简单且无丢帧窗口；P2 的事件消费事务边界（`captureSessionViewToken` + `commitMetadataUpdate` 共用）忠实落实了 §5.6。S1-S5/M1-M4/M6-M10 绝大多数已正确落实，M2（重启 eid 判定）的实现比文档要求更精确。

但存在 2 个严重缺陷，均产生用户可见错误状态：

1. **F1（严重）**：SSE 非焦点 `input-requests` 事件路径未过滤 `mode === 'choices'`，普通文本输入请求会误弹"等待用户选择"ClawToast——与轮询路径（服务端过滤）和 hello 快照路径（服务端过滤）行为不一致。
2. **F2（严重）**：`refreshAgentCallStates` 重构后，断连 agent 的 `agent.callActive` 覆写链路丢失（新旧版均受影响，视觉被 `connected` 条件掩盖）；SSE 激活且无远程条目时，提前返回分支跳过孤儿清理，`_agentCallActive` 断连条目残留，agent 重连后侧栏错误转圈可持续到 visibilitychange；且 `forceFullPollOnce` 的全量形态对 `refreshAgentCallStates` 不生效（`sseSkipLocal` 不看 forceFull），看门狗/resync/reconnected 的对账轮在 call 状态维度空转——这同时削弱了 S3/S5 与 F4（P0 register 对账偏差）的兜底闭环。

两个缺陷修复量都不大（F1 是一个过滤条件；F2 是把覆写循环与孤儿清理的遍历范围与旧版对齐、并让 `sseSkipLocal` 尊重 forceFull 语义），修复合入。

验证记录：

| 验证 | 结果 |
|---|---|
| `npx vitest run packages/viewer`（框架） | 16 文件 / 137 tests 全过 |
| `npm run test:file -- test/sse-events.test.js` | 18 pass / 0 fail |
| `npm run test:file -- test/frontend-sse-client.test.js` | 22 pass / 0 fail |
| `npm run test:file -- test/frontend-sidebar-call-states.test.js` | 9 pass / 0 fail |
| `npm run test:core`（全量） | 3565 pass / 0 fail / 4 skip |

---

## 二、攻击点分级

### 致命级

无。

### 严重级

#### F1. 非焦点 input-requests 事件未过滤 choices mode：文本输入请求误报"等待用户选择"

**证据**（`public/src/modules/sse-client.js`）：

```js
// L126-131  handleInputRequestsEvent 非焦点分支
} else {
  notifyChoiceAlerts(requests.map((lease) => ({
    requestId: lease?.requestId,
    agentId: frame.agentId,
  })));
}
```

`requests` 来自 P1 帧的 `getInputRequestsSnapshot`（lease 全量，含 `mode: 'text'` 等普通输入请求），映射时 **mode 字段被丢弃**；`notifyChoiceAlerts`（L159-184）只做 `_seenChoiceAlertIds` 去重，无任何 mode 判定，对每个 requestId 弹 `ClawToast`「等待用户选择」。

**对照两条正确路径**——均按 choices 严格过滤：

- 轮询路径（`server.js` L978-981，`/protoclaw/choice_alerts` 聚合）：
  ```js
  const isChoice = r && r.mode === 'choices'
    && Array.isArray(r.questions) && r.questions.length > 0
    && typeof r.requestId === 'string';
  ```
- hello 快照路径（`server/routes/sse-events.js` L141-143，`scanChoiceAlerts`）：同样的 `isChoice` 判定。

**影响**：SSE 激活时，任意非焦点 agent 的普通文本输入请求（agent 每次向用户提问）都会触发语义错误的 toast，且该 requestId 被写入 `_seenChoiceAlertIds`（去重集被非 choice 请求污染）。这是高频用户路径上的可见错误通知。SSE 关闭（`?sse=0`）或熔断降级时无此问题。

**测试缺口**：`test/frontend-sse-client.test.js` L213 非焦点用例只 emit 了 `mode: 'choices'` 的 lease，恰好绕开了该缺陷。

**修复建议**：非焦点分支按 `scanChoiceAlerts` 同一谓词过滤后再映射；建议把该谓词提取为共享判定以免三处漂移。

#### F2. 断连 agent 的 call 状态覆写链路丢失 + SSE 提前返回跳过孤儿清理 + forceFullPollOnce 不穿透 refreshAgentCallStates

三个相互叠加的子问题：

**F2a. 覆写循环遍历范围收窄，断连 agent 的 `agent.callActive` 永不覆写为 false**（新旧版均受影响，重构引入）。

旧版（`e3e9be1^` sidebar-render.js，agents 全集遍历）：

```js
for (const agent of Array.isArray(agents) ? agents : []) {
  if (agent?.source === 'prebuilt') { ... continue; }
  const runtimeId = getAgentRuntimeId(agent);
  if (!runtimeId) continue;
  const nextCalling = nextCallStates.get(runtimeId) === true && ...;
  if (agent.callActive !== nextCalling) { agent.callActive = nextCalling; changed = true; }
}
```

断连 agent（`collectActiveCallRuntimeIds` L688 `filter((agent) => agent?.connected)` 排除）不在 `nextCallStates`，`nextCalling=false`，**每轮覆写 false**。

新版（sidebar-render.js L846-851）：

```js
for (const runtimeId of polledIds) {          // polledIds ⊆ connected agents
  ...
  changed = applyCallStateToAgentRecords(runtimeId, calling) || changed;
}
```

断连 agent 不在 `polledIds` → `agent.callActive` 无任何覆写路径。

**视觉影响评估**：侧栏渲染的 calling 判定含 `connected` 条件（sidebar-render.js L313-316 `const calling = !prebuilt && connected && ... && (isRuntimeCalling(runtimeId) || agent.callActive === true)`），断连期间转圈被断连态样式掩盖——**即时视觉无回归**；数据层与旧版不等价。

**F2b. SSE 激活 + 无在线远程条目时，提前返回分支整体跳过孤儿清理，`_agentCallActive` 断连条目残留**。

```js
// sidebar-render.js L790-796
if (polledIds.length === 0) {
  if (sseSkipLocal) {
    cleanPrebuiltHostRows(agents);
    return; // 本地条目归事件管，远程为空：无需动作
  }
  ...（原"全清"分支，含孤儿清理）
}
```

场景推演：agent A 调用中（`_agentCallActive` 有 A、`agent.callActive=true`）→ runtime 崩溃 → UDS close → `connection{connected:false}` 帧 → 前端 `handleConnectionEvent`（sse-client.js L82-98）只做 `setConnectionStatus` + `record.connected=false` + `loadAgents`，**不清理任何 call 状态** → 下一轮 `refreshAgentCallStates`：A 因 `connected=false` 退出 `runtimeIds`，SSE 下 `polledIds` 过滤后为空 → 提前 return，**孤儿清理未执行** → `_agentCallActive` 的 A 残留。有在线远程条目时走正常孤儿清理（存活集为全量 `runtimeIds`），A 被正确清理——残留仅限"无远程条目"形态。

**F2c. 用户可见的暴露面：重连后错误转圈**。F2b 残留的 A 若被用户重启（register 重连，`connected=true` 恢复），侧栏 calling 判定的 `connected` 条件重新满足，`isRuntimeCalling(A)`（读残留的 `_agentCallActive`）或残留的 `agent.callActive=true` 立即为真 → **空闲的新 runtime 显示转圈**。救济路径只有 visibilitychange（`includeSseLocals: true` 全量对账）或 A 的下一次 notification 事件——窗口可以很长。P0 的 register 重连对账（作废 callActive）只改 ViewerWorker 内存，**不 emit notification**（见 F4），事件通道不会带来纠正帧。

**F2d. `forceFullPollOnce` 的全量形态对 `refreshAgentCallStates` 无效**。看门狗 / resync / reconnected 三条兜底链都触发 `forceFullPollOnce`（app-main.js L859-864），它只切换 `runPollCycle` 的形态（`sseActiveThisCycle=false` → 拉 notification 等端点），但：

```js
// sidebar-render.js L786
const sseSkipLocal = typeof isSseActive === 'function' && isSseActive() && !includeSseLocals;
```

`refreshAgentCallStates` 的跳过判定只看 `isSseActive()`（连接仍健康）与 `includeSseLocals`（仅 visibilitychange 传）——**forceFull 轮里它照旧跳过本地条目**。即"全量对账轮"在 call 状态维度是空转，S3/S5 的兜底闭环（§6.5：任何一层丢失的最长盲窗 ≈ 30s 且有兜底闭环）在 call 维度不成立。同时这直接削弱 F4（register 对账偏差）的补偿链。

**修复建议**：覆写循环恢复 agents 全集遍历（断连行覆写 false，与旧版对齐）；提前返回分支保留孤儿清理（存活集为全量 `runtimeIds` 的既有逻辑本就安全）；`sseSkipLocal` 增加 forceFull 维度或全量形态下传 `includeSseLocals` 等价物。

### 中等级

#### F3. messages 404 的 runtime 消失处理延迟一轮

旧版 probe 循环内 `/messages` 404 就地触发 `handleCoreResponsesNotFound`（视图清理 + fallback 切换），原注释明言 "/messages can also 404 after the probe step (runtime died between the two waves), so the branch is shared"。

新版 `runMessagesProbeCycle` 把 404 折算为返回值 `'handled404'`（app-main.js L1027 等），但两个调用方都未消费该语义：

```js
// app-main.js L1535-1539（fallback 路径）
const probeOutcome = await runMessagesProbeCycle(pollToken, msgProbe);
if (probeOutcome !== 'committed') {
  schedulePoll(POLL_FAST_INTERVAL_MS);   // 'handled404' 与 'stale' 同途
  return;
}
```

sse-client.js 的 `handleMessagesEvent`（L144-153）同样忽略返回值。runtime 在两波 fetch 之间死亡时，404 专属处理（`_agentCallActive.delete` + fallback 切换 + `renderCurrentMainView`）延迟到下一轮 input/overview 404 才触发。最终收敛（下一轮 300ms / SSE 下等 forceFull），非永久黑洞，但属于对既有防御语义的静默降级。

#### F4. register 重连对账的两类内存写入无独立事件（对 §2.3 审计表的有意偏差）

§2.3 与 §4.1.2 明确要求：register 租约对账（设/`delete inputLease`）emit `input-requests`、重连 call 状态作废属 notification 源。实现（viewer-worker.ts L1608-1633）对账后仅 emit `connection{connected:true, reconnected:isReconnect}`，且用测试把该偏差固化为契约（`viewer-worker-session-events.test.ts` L236 用例名"……不额外 emit input-requests，由 connection 事件驱动对账"）。

对账链核验：connection 帧 → P2 `handleConnectionEvent` 的 `reconnected → forceFullPollOnce`（sse-client.js L93-97）→ 全量形态 poll 拉全量快照 → 状态最终一致 ✅（notification/input-requests/todo/queued-inputs 维度闭合）。**但 call 状态维度经 F2d 缝隙对账不完整**——F4 单独可接受，与 F2d 叠加后重连场景的兜底链变弱。落实或修正二选一：要么补 emit（按审计表），要么修 F2d 让对账轮真正覆盖 call 维度。

#### F5. 乐观气泡乱序窗口短暂重复（POST 响应晚于事件帧）

§5.5 只定义了"POST 先到"的对账（id 锚点）。反向乱序：queued-inputs 帧先到（快照已含新项，`applyQueuedInputsTexts` 覆盖显示）→ POST 响应后到 → persistent-input.js L752-758 乐观 push + `noteQueuedOptimistic(id)` → 气泡重复显示。自愈路径存在：runPollCycle SSE 分支每轮 `_syncPersistentInputUi`（app-main.js L1482）→ SSE 缓存路径 `reconcileQueuedTexts` 确认 id → 约 1s 内消除。窗口短，但修复廉价（push 前查快照/锚点是否已含该 id）。

#### F6. 连接上限与错误标记与设计不符

设计 §4.2：上限"建议 64"、503 + `sse_unavailable` 标记。实现（sse-events.js L21-26、L183-186）：`maxClients: 16`、`{ error: 'sse-connections-full', maxClients }`。功能等价（前端按 503 status 走 onerror 熔断，不解析标记字段），但 16 收紧了 §6.6 论证过的多 tab + long-poll 槽位余量，且字面背离设计未记录理由。

### 轻微级

| # | 发现 | 证据 |
|---|---|---|
| F7 | 事件帧结构 `{kind, agentId, data}` 与 §4.3 示例 `{"agentId","payload"}` 字段名不符；三层（P0/P1/P2）自洽，纯文档偏差 | sse-events.js L100 |
| F8 | `Cache-Control: no-cache` vs 设计 `no-store`；SSE 语义 no-cache 更规范，无害 | sse-events.js L190 |
| F9 | `?sse=1` 为弱强制：连接失败仍熔断降级，与"强制"字面不符，无危害 | sse-client.js L50-57、L298 |
| F10 | 慢客户端背压：`writeConn` 返回 false 不清理连接，依赖 15s 心跳 write 失败收敛；公网慢客户端有内存积压窗口 | sse-events.js L163-167、L236-238 |
| F11 | `_optimisticQueued` 在 SSE 关闭后无 reconcile 驱动，条目滞留（脏内存，量小） | sse-client.js L43-44 |
| F12 | `applyQueuedInputsTexts` 的 `_pendingQueuedCount` 在 fetch 路径传过滤前 `queue.length`，旧版为过滤后文本数；边缘无实际影响 | persistent-input.js L809-823、L868 |
| F13 | persistent-input fetch 路径签名不变时不再执行 `_localQueuedInputPending=false` 重置（旧版无条件重置）；触发前提窄（POST queued 成功后服务端队列必非空） | persistent-input.js L864-869 vs 旧版 L833-840 |
| F14 | 设计 §6.12 要求 P0 对 `AGENTDEV_DEBUG_TRANSPORT=claw` 模式的 emit 覆盖"注记核实"；提交与代码未见注记（非主场景，不阻塞） | 417f5b8 提交全文 |

---

## 三、§2.3 事件源审计表逐条核对（P0）

| 审计表条目 | 实现位置（viewer-worker.ts） | 判定 |
|---|---|---|
| handlePushNotification（notification） | L2234 尾部 emit；`log.entry` 早期 return 不 emit（只写 session.logs，不改快照可见状态，正确） | ✅ |
| register 重连对账 → notification（callActive 作废） | L1608-1615 对账无 notification emit，仅 L1633 connection{reconnected} | ⚠️ 偏差（F4） |
| handleUpdateAgentOverview | L1653 | ✅ |
| handleUpdateTodoPlan | L1662 | ✅ |
| handlePushMessages（probe 信号） | L1746-1753，真实变更才 emit；`_messagesNeedsResync` 静默分支与 no-op 推送不 emit（符合设计） | ✅ |
| handleRequestInput 设 lease | L2470 | ✅ |
| handleInputRequestCancelled | L2484 | ✅ |
| handlePostInput 清 lease（前端提交唯一路径） | L951-952，forward 成功后才 emit，404/409/400 失败路径不 emit（正确） | ✅ |
| submitUserTurn lease 直投清 lease | L1029-1030 | ✅ |
| register 租约对账（设/delete inputLease） | L1615-1630 对账无 input-requests emit | ⚠️ 偏差（F4） |
| submitUserTurn 排队 | L1052 | ✅ |
| handleDequeueInput | L1214（空队列 return 不 emit，正确） | ✅ |
| handleRequestInput 队列转交（非 dequeue 路径） | L2445-2450 | ✅ |
| handleRegisterAgent（含 reconnected 判定） | L1633，`isReconnect = agentSessions.has(agentId)` 先于 getOrCreateSession，判定正确 | ✅ |
| handleUnregisterAgent | L2060 | ✅ |
| handleDeleteAgent（第三删除点） | L875-877 | ✅ |
| UDS close/error 反查 clientId | L1382-1395 `emitDisconnectedByClientId` 遍历 agentSessions；error 后不保证 close，双发幂等（注释明示） | ✅ |

补充核对：`agentSessions.delete` 全仓仅 L875/L2057 两处，无遗漏删除点；`hasSessionEventListeners` 启动探测（L1360-1363）落实 §6.10；无订阅者时 `emitSessionEvent` 首行 guard（L1375），P0 验收"零开销"成立。

## 四、P1 要点核对（§4.2）

| 设计要求 | 实现 | 判定 |
|---|---|---|
| compression filter 排除 text/event-stream | server.js L166-169 `createSseCompressionFilter(compression.filter)`；onHeaders 时机 `res.getHeader('Content-Type')` 可读 writeHead 头；测试含真实 compression 交互（SSE 不压缩逐帧达、JSON 仍 gzip） | ✅ |
| 连接固定时序（订阅早于快照） | 变体且更稳：模块级常驻订阅 + 全局环形缓冲；`handleEvents` 同步块内完成 注册（live=false）→ 重放决策 → resync/replay → hello → live=true，Node 单线程下 publish 与该块互斥，无连接级丢帧窗口 | ✅ |
| eid 失配 → resync（含重启归零） | sse-events.js L207-217：`lastEventId > eidSeq`（来自更新服务器）与 `ring[0].eid > lastEventId+1`（缓冲超界）均 resync，带 reason 区分；比文档"eid 不在缓冲内"表述更精确 | ✅（M2 落实且优于文档） |
| bell 双入口 | hello 快照 `scanChoiceAlerts()`（L232，服务端侧过滤 choices）+ 后续 input-requests 事件（P2）；`_seenChoiceAlertIds` 共享去重 | ✅（M3 落实；事件入口的 mode 过滤缺失见 F1） |
| 心跳 15s 注释帧 | L236-239 per-conn interval，unref，写失败即 closeConn | ✅ |
| 连接上限 | 16 vs 设计 64、标记字段名不符 | ⚠️（F6） |
| shutdown 收口 | server.js L1459-1460 `sseEvents.closeAll()`（清合并窗口 → shutdown 帧 → 断连 → 退订），先于 viewerWorker.stop | ✅ |
| 250ms 合并窗口 | 同 `(kind, agentId)` 窗口覆盖（connection OR-merge reconnected、messages 取最新 probe）；快照 flush 时组装（被合并的中间事件不浪费组装） | ✅ |
| 旧框架 501 降级 | L179-182 + `supported` 启动探测 | ✅（§6.10） |

## 五、回归风险核对（P2 fallback 完整性与三段抽取）

**fallback 路径（SSE 关闭/熔断/forceFull 轮）与 `e3e9be1^` 逐段比对结论：主体语义等价。**

- `runMessagesProbeCycle`：seq 对账矩阵、降级全量重建、msgMetrics、commit 内渲染分支（append/updateLastMessage/renderCurrentMainView/reconcileOptimisticUserEchoes）逐行同源 ✅
- `commitMetadataUpdate`：签名对比、interrupt 终态清除、interruptTargetId/forceContinue 宽限期同步、partial-compact 清除、`updateRollbackActionVisibility` 分支逐行同源；三维度可选化（poll 传全量、事件传单 kind）语义正确（hasX false 时对应维度不进 patch、不触发渲染）✅
- `_runPollTailLowFrequency`：loadAgents 节流（SSE 30s / fallback 3s，§5.2/M10 落实）、ws-sessions 乐观 archived 保留与 contextLength/compressRatio 保留、hooks 面板跳过清单、final cache 提交逐行同源 ✅
- `handleCoreResponsesNotFound` 提取为带 `pollToken` 参数的顶层函数，内部与旧内联闭包逐行等价 ✅
- 差异点：F3（messages 404 处理延迟一轮）、F2a（断连 callActive 覆写丢失，视觉被掩盖）、F13（`_localQueuedInputPending` 重置条件收窄）。三者均有兜底或被掩盖，不构成"行为与改造前不等价"的硬回归，但应知晓。

**S3 语义切换核对**：整函数跳过 ✅、远程条目保留 ✅、孤儿清理存活集用全量 `runtimeIds`（本地事件态不被"缺席=空闲"清掉）✅、`cleanPrebuiltHostRows` 提前返回分支同样执行 ✅、visibilitychange `includeSseLocals` 恢复本地参与 ✅。缝隙即 F2b/F2d。

**§5.2 验收口径注记**：稳态请求清单实际还含 context_guard_status（每轮，`refreshContextGuardStatus`）——这是 §2.2 #3"保留"的正确执行，但 §5.2 验收清单未列该项（文档内部不一致，非实现缺陷）。`checkGlobalChoiceAlerts` 的跳过条件正确处理了远程条目（`hasOnlineRemoteEntries` 时保留轮询，sse-client 事件只覆盖本地）✅。

**P3 范围未泄漏**：desktop-notify.js / auto-title.js 零改动 ✅。

## 六、测试覆盖缺口清单

1. **F1 无测试暴露**：非焦点 input-requests 用例只发 `mode:'choices'` lease（frontend-sse-client.test.js L213）；缺"非 choices lease 不 toast"断言。
2. **persistent-input 乐观对账端到端链零覆盖**：POST 响应 → `noteQueuedOptimistic` → queued-inputs 帧 → `reconcileQueuedTexts` → `applyQueuedInputsTexts` 的完整链无测试；`noteQueuedOptimistic` 调用点（persistent-input.js L755-758）与 F5 乱序场景均无覆盖。reconcile 纯函数有 4 用例（L349-389），但只测了函数自身。
3. **app-main SSE 分支降级回归无端到端测试**：SSE 激活 → onerror CLOSED → poll 恢复全量形态 → 重连 hello 再激活的全链路无覆盖（isSseActive 翻转与 watchdogDecide 有单点测试，poll 形态切换无）。
4. **F2 场景无测试**：断连残留（提前返回分支不清 `_agentCallActive`）、重连错误转圈、forceFull 轮 call 维度空转均无断言；现有 9 用例覆盖了 includeSseLocals 与 prebuilt 行清理，恰好绕开缝隙。
5. **messages 404 → `'handled404'` 路径无测试**：两个调用方对该返回值的忽略行为无守护。
6. P1 测试主体用 fake worker（快照 Map 手工填充）；真实 ViewerWorker 契约仅 1 个存在性用例（sse-events.test.js L497）。缓解：快照与 GET 同构性由框架侧测试逐字段保证（viewer-worker-session-events.test.ts L344-377），可接受，注记。
7. `7dcae49`（Windows 命名管道）无独立测试——平台相关行为，与 `1cc0cbb` 同模式，可接受。

测试质量总评：**非 mock 回声**。三份核心测试都以真实对象为被测主体（P1 用真实 Express + fetch 流逐帧解析；P2 用 frontend-vm 沙箱加载真实 sse-client 源码 / 提取 sidebar-render 真实函数片段执行），mock 只用于注入边界依赖。`watchdogDecide`/`reconcileQueuedTexts` 纯函数抽取保证了关键判定可测。方向正确，缺口集中在跨模块链路（见上）。

## 七、上轮报告遗留项落实核对表

| 编号 | 要求 | 落实状态 |
|---|---|---|
| S1 | inputLease 5 写入点全 emit | 4/5：postInput ✅ 直投 ✅ requestInput ✅ cancelled ✅；register 租约对账 ❌ → F4（以 reconnected 对账替代，测试固化） |
| S2 | 队列转交路径 emit | ✅ L2445-2450 + 专项测试（L275"不经过 dequeue 端点的第三条路径"） |
| S3 | refreshAgentCallStates 整函数语义切换 | 主体 ✅（跳过/远程保留/调用方收敛/includeSseLocals）；缝隙 F2a-d：断连覆写丢失、提前返回跳过孤儿清理、forceFull 不穿透 |
| S4 | 事件消费事务边界 + 乐观对账 | ✅ 焦点判定（同步 `currentRuntimeAgentId`）+ token 捕获 + `commitMetadataUpdate` 共用；乐观 id 锚点 + 10s TTL；残留 F5 乱序瞬时窗口（1s 自愈） |
| S5 | 断连分层兜底 | ✅ 机制齐全（resync 帧 + reconnected + 30s 看门狗 + forceFullPollOnce + 全量路径常驻）；效力折损见 F2d（call 维度空转） |
| M1 | hello/订阅时序 | ✅ 且方案更优（常驻订阅 + 全局环形缓冲 + 同步重放序，无连接级间隙；重放帧先于 hello 到达客户端无碍——dispatch 不依赖激活态） |
| M2 | 重启 eid 判定 | ✅ `lastEventId > eidSeq → resync('eid-from-newer-server')`，专项测试覆盖 |
| M3 | bell 首连盲区 | ✅ hello.choiceAlerts + 事件双入口 + 共享去重 + 测试 |
| M4 | ClawToast（非焦点）迁移 | ✅ notifyChoiceAlerts + `_seenChoiceAlertIds` 共享；但 F1 mode 过滤缺失使其语义宽于轮询路径 |
| M5 | Worker 心跳副作用分析 | P3 范围，本期正确地未动（desktop-notify.js 零改动）✅ |
| M6 | 三请求同函数拆分 | ✅ 新增 `refreshContextGuardStatus` guard-only 形态（guard 段与原函数逐行一致），fallback 整函数原样 |
| M7 | 401 闭环 | ✅ probeAuthThenRetry + `_unauthorized` 停机 + 测试 |
| M8 | hasNewEvents 死语义 | ✅ 快照不含该字段；已核实前端零引用 |
| M9 | 验收口径量化 | 文档层已量化；实现未提供自动化断言（网络面板口径，人工验收项）——部分落实 |
| M10 | loadAgents 无短路 | ✅ `agentListIntervalMs` 30s/3s 分流 |
| L1-L6 | 文档行号修正 / probe 契约字段 / UDS 反查 / handleDeleteAgent / 槽位注记 / claw transport 注记 | L2 ✅（probe 含 sinceIndex/fakeFullBytes，测试断言）；L3 ✅（emitDisconnectedByClientId + 测试）；L4 ✅；L1/L5 文档层已消化；L6 ❌ 未注记（F14，轻微） |

## 八、修复优先级建议

1. **F1**（严重，修复成本≈1 行过滤 + 1 个测试）：非焦点分支按 `mode === 'choices' && questions?.length > 0` 过滤，谓词与服务端 `scanChoiceAlerts` 对齐。
2. **F2**（严重，修复成本中等）：覆写循环恢复 agents 全集遍历；提前返回分支保留孤儿清理；`sseSkipLocal` 尊重 forceFull 全量形态。补 3 个测试：断连残留清理、重连转圈纠正、forceFull 轮本地条目对账。
3. **F4/F2d 二选一收敛**：要么 register 对账补 emit（input-requests + notification），要么确认 reconnected 对账链在 F2 修复后真正覆盖 call 维度，并把该契约写回 §2.3 文档。
4. **F3**（中等，成本低）：`runPollCycle` 与 `handleMessagesEvent` 消费 `'handled404'` 返回值触发 `handleCoreResponsesNotFound`。
5. **F5/F6**（低成本顺手修）：乐观 push 前查锚点；maxClients 与标记字段对齐文档或回写文档。
6. 文档同步：F7/F8/F9 的实现-文档偏差回写 v2 文档，避免后续实施者按旧字面施工。
