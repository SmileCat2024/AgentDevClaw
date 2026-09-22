# SSE 改造 P3 修复验证报告（commit 9e1bb69）

- 验证对象：`9e1bb69`（对 `docs/audits/sse-migration-p3-review.md` 中 S1/M1/M2 的修复），对照基线 `fe5526e`。
- 验证方式：只读 + 测试运行。`test:core` 全量 3590 用例（3586 pass / 0 fail / 4 skip）无回归；重点文件 `test/sse-events.test.js`、`test/frontend-sse-client.test.js`、`test/frontend-core-helpers.test.js` 合计 88 用例全绿。
- 结论先行：**可合入**。三条修复声明全部属实（修复确认 ×3），未发现重响/漏响缝隙或新的重复通知路径。残留项均为轻微：补发延迟相位注记、焦点分支 opts 断言缺口、M3 根因未动（影响已被有界化）、L1 文档同步仍未做。

---

## 一、修复声明逐条验证

### 声明 1（S1）：bell 双入口落地 —— **修复确认**

**双入口实现**（`server/routes/sse-events.js`）：

- 入口一（hello 首连/重连快照）：`bellForChoiceAlerts(helloChoiceAlerts)` 在 hello 帧写出前执行（sse-events.js:264-267）；
- 入口二（input-requests 事件帧 flush）：`flushPending` 对快照按谓词过滤后调 `bellForChoiceAlerts`（sse-events.js:107-114）；
- 谓词同源核对：`mode === 'choices' && Array.isArray(questions) && questions.length > 0 && typeof requestId === 'string'`——事件入口过滤（:108-112）、`scanChoiceAlerts`（:141-143）、路由聚合（server.js:979-981）三处逐字一致；
- `server.js:186-191` 注入 `playSound: playSoundOnServer`（函数声明，提升可用）与 `seenChoiceRequestIds: () => _seenChoiceRequestIds`（惰性取值）。

**TDZ 规避核实**：`_seenChoiceRequestIds` 的 const 声明在 server.js:907，晚于模块创建（:186）。惰性 getter 是必要的且充分的——server.js 顶层无任何 await（全文检索确认），模块体从 :186 同步执行到 :907 不让出事件循环；`bellForChoiceAlerts` 仅能从 HTTP 处理器或 flush 定时器触发，二者都需要事件循环轮次，不可能插入同步执行段。即使病态情形触发 TDZ，`flushPending` 的 try/catch（sse-events.js:86-104）也只丢单帧不断管线。**规避方案成立。**

**三入口交叉时序矩阵**（hello / 事件帧 / 降级期路由）：

| 时序 | 结果 | 依据 |
|---|---|---|
| 同一 requestId 跨任意入口先后到达 | 首个入口响并标记，其余入口 `seen.has` 跳过，不重响 | 共享 `_seenChoiceRequestIds`（server.js:995-998 与 sse-events.js:190-195 同一 Set）；三处循环体均为同步代码（无 await），Node 单线程下各自原子执行 |
| 无已连接客户端时事件帧到达 | 不响、**不标记**；客户端接入后 hello 扫描补响 | `clients.size === 0` 早退在标记之前（sse-events.js:185-186）；测试 5 精确锚定此序列 |
| hello 与重放帧同连接 | 重放帧永不响铃（原始 publish 时已标记，或当时无客户端→未标记→由本次 hello 扫描补响） | bell 只在 hello 扫描与 live flush 两点触发，重放写入（:263）不触发 |
| 服务端重启（seen 清空）+ 挂起 choice | hello 响一次，对齐基线轮询语义 | 测试 3 锚定重连不重响；重启场景由 seen 清空自然覆盖 |
| 服务端重启后挂起 R1 + 新写入触发事件帧 | flush 快照含未标记的 R1 → 响一次 | 基线路由对重启后首次轮询行为相同 |
| 多客户端 | 全局只响一次（首个入口标记后其余入口/客户端 hello 均命中 seen） | |
| SSE 激活期 M2 重扫（30s）命中路由 | 路由成为事实上的第三活跃入口，共享 seen 去重，纯冗余兜底 | 防御纵深，无害 |

**每批至多一次**：`bellForChoiceAlerts` 响后立即 `return`（sse-events.js:194-196），与路由 `break`（server.js:999）对齐；未响的剩余新 id 留待后续批次——与基线"每周期至多一响"语义一致（测试 4 锚定 r1 已标记 + r2 新增 → 恰响一次）。

**轻微注记**：`seenChoiceRequestIds` 未注入时的回退 `localSeenChoiceIds`（sse-events.js:178）是模块级 Set——该退化配置下事件/hello 两入口仍互去重，但与路由的跨入口去重失效。生产装配（server.js）恒传入 getter，仅影响测试或异常嵌入，不构成缺陷。

### 声明 2（M1）：`markObserved:false` 前台不写观察标记 —— **修复确认**

- 签名扩展 `_tryNotifyInputRequest(runtimeId, requestId, alertData, opts = {})`，前台分支仅在 `opts.markObserved !== false` 时写 `_foregroundObservedInputMap`（desktop-notify.js:242-248）；缺省行为不变（向后兼容）。
- 两个 SSE 调用点均透传：焦点分支（sse-client.js:131）、非焦点分支 `notifyChoiceAlerts`（sse-client.js:194）。
- **全调用方清点**（grep 全仓）：生产调用恰三处——上述两处（markObserved:false）+ 心跳重扫（desktop-notify.js:344，缺省 opts）。重扫只可能在上文 `document.hidden || !hasFocus()` 判定之后执行（:362 提前返回），且该状态下 `_isNotifyForeground()` 恒 false，前台标记分支不可达——**不存在任何重新引入 M1 的写入路径**。`_foregroundObservedInputMap` 的存活写入点只剩宽限期分支（离场 ≤5s 内的调用，:264-269），与基线心跳语义完全一致。
- **与新 requestId 替换语义的交互**（工单指定核查点）：推演 R1 宽限期标记（observed + notified 双写）→ R2 前台到达（markObserved:false，零写入）→ 离场后重扫 [R1, R2]：R1 命中 observed-map 且 prev 同 requestId → 跳过；R2 命中 observed-map 但 prev={R1}≠R2 → 删标记 → 通过 30s 窗口 → 补发 R2 ✓。多挂起请求间的交替重提醒是 per-agent 单条目 Map 的既有行为，本修复未改变。
- **M1 修复闭环验证**：前台到达（零标记）→ 离场 → 重扫补发。`test/frontend-core-helpers.test.js:565-580` 精确锚定该序列（含缺省 opts 仍标记的反向用例 :584-593）。

**轻微注记（补发延迟相位）**：`_lastChoiceNotifyCheckAt` 跨前台/后台周期持续。若最后一次扫描发生在进入前台前不久且前台停留短，离场后的首次补发要等 `lastCheck + 30s`——最坏约 30s 延迟（基线 ≤ 约 7s）。交付有保证、延迟有界，非功能缺失；但 `desktop-notify.js:371-372` 注释"进入后台首个 tick 即刻扫一次（时间戳 0 视为过期）"仅对页面加载后的首次后台进入（时间戳确为 0）成立，对后续后台重入是窗口过期触发而非首 tick 触发，注释表述略窄。
另注（既有语义，非本修复缺陷）：若离场后首次重扫落在 5s 宽限期内，宽限期分支双写标记使该 requestId 不再重提醒——与基线心跳在相同时序下的行为逐字节一致。

### 声明 3（M2）：SSE 激活态 30s 低频重扫 —— **修复确认**

- `choiceCheckIntervalMs = sseActive ? 30000 : 2000`（desktop-notify.js:376-380），逐 tick 求值，降级瞬间即回 2s 基流。
- **时间戳 0 即刻扫**：`_lastChoiceNotifyCheckAt` 初始 0（:335），`Date.now() - 0 > 30000` 恒真 → 进入后台首个 tick 即扫（测试 1 锚定：首 tick fetch 一次、次 tick 不重复）。
- **与 `_tryNotifyInputRequest` 30s 去重窗口的节拍对齐**（工单指定核查点）：扫描门控用扫描起始时间戳，通知 ts ≈ 起始 + ε（fetch 耗时）；下次扫描在 +31±1s（1s tick 粒度），`now - ts ≈ 31s > 30s` → 必然重发。有效重提醒节拍 ~31±1s，基线为 30-32s——对齐；且 ε 在分子分母近似抵消，fetch 延迟不拉长节拍。
- **SSE 激活瞬间的 2s→30s 拉长无覆盖缺口**：hello 帧携带 `choiceAlerts` 快照（sse-events.js:270）→ 客户端 `notifyChoiceAlerts` 首发补齐，激活窗口不丢新请求的首发通知。
- 测试锚定：`test/frontend-core-helpers.test.js:524-556` 重写后覆盖即刻首扫 + 30s 窗口不重复 + 降级后 2s 立即恢复（5s 时间戳样本同时验证两个区间的判别力）。

---

## 二、原报告其余项的状态

| 项 | 状态 | 说明 |
|---|---|---|
| M3（半开-OPEN 缝隙） | **部分缓解，根因未动** | `sse-client.js` 看门狗零改动（`watchdogDecide` 对 readyState===1 静默仍不降级）。但 M2 的 30s 重扫运行在与事件流无关的 Worker tick 中，半开期间 `sseActive=true` → 每 ~31s 重扫一次——choice 通知延迟从"无界"收敛为"≤约 31s 有界"。实时（事件）路径与主循环 2s 对账在该窗口内仍然缺失；`desktop-notify.js:372-373` 注释"断连/降级瞬间 isSseActive() 翻 false"对半开路径仍不成立（表述过强的轻量残留）。作为已知限制记录可接受，看门狗降级条件仍是后续待办 |
| L1（文档失同步） | **未解决** | 本提交未触及 docs/。`sse-migration-bcd-preparation.md:63`（#10"远程条目保留心跳路径"）、`:287`（§5.4-2"choice_alerts 聚合含远程条目"）仍保留 M5 错误前提；`:290`（§5.4-3"refreshChoiceAlertStates 保留，间隔放宽到 5s"）现与实现双重不符（既非保留 5s 也非移除，实为 SSE 态 30s / 降级态 2s）。另注：§4.2 的 bell 双入口要求（`:205`）本次已真正满足 |
| L2（注释表述过强） | **基本解决** | `desktop-notify.js:365-373` 重写后准确（首发/重扫职责分离、markObserved 依赖关系写明）。残留一处：`sse-client.js:176-177` 区块注释"覆盖原 Worker 心跳 refreshChoiceAlertStates 的通知职责"未提及重提醒职责已改由 30s 重扫分担——措辞滞后，无误导实害 |
| L3（测试断言强度） | **解决** | 新增 `test/sse-events.test.js` bell 套件为真实 HTTP 流集成测试（5 用例：事件响铃+去重、文本不响、hello 响+重连不重响、跨入口共享 seen、无客户端跳过+补响），断言锚定行为而非实现；markObserved 正反两用例齐备。**残留微缺口**：焦点分支调用点的 opts 未断言——`test/frontend-sse-client.test.js:237` 的焦点分支测试仍用二元 stub，`markObserved: false` 仅在非焦点分支测试（:264-283）被断言 |
| L4（hello 对焦点会话的冗余 toast） | **未变（记录项）** | hello → notifyChoiceAlerts 仍不过滤焦点会话；markObserved:false 使副作用更弱（不再标记），冗余 toast 为 P2 既有行为 |

## 三、测试运行结果

```
npm run test:core
  → 3590 tests, 3586 pass, 0 fail, 4 skipped（无回归）
npm run test:file -- test/sse-events.test.js test/frontend-sse-client.test.js test/frontend-core-helpers.test.js
  → 88 tests, 88 pass, 0 fail
```

## 四、总结论

**可合入。**

- 三条修复声明逐条属实：S1 双入口按 §4.2 落地且三入口交叉时序无重响/漏响缝隙（TDZ 惰性注入经核实安全）；M1 的 markObserved:false 经全调用方清点后确认无标记泄漏路径，与既有替换语义交互正确；M2 的 30s 重扫与去重窗口节拍对齐（~31±1s vs 基线 30-32s），降级回切有测试锚定。
- 测试强度较 P3 显著提升：bell 套件为真实 HTTP 流集成测试，覆盖三入口与跨入口去重的全部关键序列。
- 随本次合入建议顺手完成（非阻塞）：L1 文档三处失同步更新（:63 / :287 / :290）；焦点分支 opts 断言补一行；`sse-client.js:176` 区块注释措辞同步。M3 看门狗降级条件维持"已知限制"记录，其通知层影响已由 30s 重扫有界化。
