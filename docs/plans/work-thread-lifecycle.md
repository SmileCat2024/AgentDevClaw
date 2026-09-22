# 工作线程生命周期接线（Work Thread Lifecycle）

> 状态：现行实现的事实描述（T001–T006 落地后的收口文档）；对象模型与
> 设计背景见 [`work-thread-design.md`](work-thread-design.md)。
>
> 本文回答「每个生命周期动作由谁接线、在哪个事务点落盘、失败如何收敛」。
> 术语以 `.agentdev/tickets/GLOSSARY.md` 为准。

---

## 1. 接线总览

```
会话生命周期钩子（server 侧，agent/feature 零感知）
  onSessionCreated      thread-integration.js   宿主会话 → 自动建线程（root）
  beginSessionSuccession  thread-integration.js   接力开始 → 交接挡板落盘
  applySessionSuccession  thread-integration.js   回退路径（无 succession 服务时）
  onSessionDeleted       thread-integration.js   head 被删 → 线程取消

上下文变换（三条路径共享一个 successor 创建入口与一个提交点）
  compact_and_resume    server/routes/session.js  → beginSessionSuccession（挡板）
                            → createCompactedResumeFromHandoff（会话侧，身份继承）
                            → commitSuccession（thread-succession.js，提交点）
  summary / trim+summary  同入口：createCompactedResumeFromHandoff
                            （compactAndResumeCurrentSession /
                             compactAndResumeFromProvidedSummary 两个 helper 收敛）
  context guard 轮换     thread-rotation.js        同提交点（begin → 退役 → 变换 → commit）

统一目标解析（T003）
  server/routes/session.js + thread-routes.js + ACP + CLI
  全部经 target-resolution.js：archive / resume / delete 按成员关系定位
  Thread；trim / summary / compact 只作用于 head（历史 → stale_session）

生命周期事务
  归档   thread-lifecycle.js   seal 事务（hold + 取消 pending + 收敛挡板）→ 停 runtime
  删除   thread-delete.js      begin（hold + deleting）→ 收尾 inflight → seal（closed）
                               → 级联清理（sessions / handoffs / runtimes / board / archive / record）
  恢复   board.resume          恢复可调度资格（不产生 successor、不复活 cancelled）

崩溃恢复
  thread-succession.js createThreadRecoveryService.convergeInterruptedSuccessions
  server 启动时对每条带 pendingSuccession 挡板的线程按落盘状态收敛
  （状态驱动，不依赖 TTL）
```

---

## 2. 身份连续性（T001）

- 线程记录落盘第一等字段 `identity`，新建线程时从 root Session 经注入的
  identitySource（生产 = `thread-identity.js` 的 session index / 会话文件
  → sessionType）解析；解析不到记 `null`，绝不默认成 main。
- successor 加入 head 前的事务内校验（`advanceHead`，per-thread 锁）：
  `session_workspace_mismatch` / `thread_identity_mismatch` /
  `thread_identity_missing` / `session_already_in_thread`；失败时线程记录
  零变更，旧 head 保持有效。
- 成员归属事实唯一来源是框架 `WorkThread.findThreadBySession`
  （sessionChain 链记录）；`host-agents.js` 的 `isThreadHostSession` 只回答
  「新会话是否自动建线程」，不承担身份词汇表。

## 3. 接力提交点与失败收敛（T002）

- 提交点唯一：`thread-succession.js` 的 `commitSuccession`。successor 必须
  READY（compact 流程的 ready 证据）且身份一致才提交：head 推进（含
  sessionChain 链记录与状态收敛）、挡板清除在同一事务内原子完成，随后
  补投递暂存指令；不存在「head 已换但交接意图还在」的中间态。
- READY 门禁失败（`successor_runtime_not_ready`）、身份失败、handoff 材料
  校验失败（`handoff_invalid`）都走 `failSuccession` 收敛：挡板清除、
  线程落 `rotation_failed`（或恢复 open）、失败阶段与原因留审计事件、
  pending 指令保留归属（可投递给仍有效的旧 head）。
- 崩溃恢复：挡板随线程记录落盘；server 重启后 `convergeInterruptedSuccessions`
  按 stage 收敛——commit 未达 → 不推进 head、旧 head 有效；旧 head 会话
  已不存在 → 其 pending 指令以 `head_session_missing` 失败（永不投向
  未知目标）。
- 会话侧身份继承：`createCompactedResumeFromHandoff`（
  `server/routes/session-handoff-helpers.js`）从 handoff 材料的
  `sourceRecord.sessionType` 继承 successor 的 sessionType；缺失时不伪造
  （回落到会话创建侧按来源 Session 回读）。回归证据见
  `test/t007-successor-identity.test.js`。

## 4. 统一目标解析与 Session 兼容入口（T003）

- `target-resolution.js`：`resolveLifecycleTarget`（archive / resume /
  delete）与 `resolveTransformationTarget`（trim / summary / compact）。
  所有 UI / CLI / ACP / HTTP 入口消费同一解析结果，响应形状保留
  `request`（原目标）与 `actual`（实际生效对象）。
- 历史 Session 的 activate 是只读挂载（browse-only），不改变 head。
- 稳定错误码：`invalid_target` / `stale_session`（附 threadId 与当前
  head）/ `session_not_head`（写入历史棒）。

## 5. 输入路由（InputGateway）

`server/thread-control/input-gateway.js` 的 `deliverUserInput()`：

| 事实 | 路由 |
|---|---|
| head + 交接 fresh | Thread Inbox 暂存（`delivery: 'thread_queued'`） |
| 历史非 head（线程宿主） | 明确拒绝写入（`session_not_head`，409）——历史棒只读，不静默转投 |
| 交接窗口 + 纯图片 | 显式失败（`thread_handoff_images_unsupported`），不静默丢附件 |
| 其余（无线程 / 非宿主 / 无交接） | 原样透传 viewer user-turn |

竞态闭合：路由判定与 appendCommand 之间 succession 可能已完成——append
后补一次投递尝试（交接中为 no-op，已完成则当场送达新 head）。pending
指令的完整触发点集合：append（tryDeliver）、succession 提交
（applySessionSuccession）、runtime-ready（handleRuntimeReady）。

## 6. 归档（T004，取消不是暂停）

`thread-lifecycle.js` 的 `archiveThread`：

1. 归档标记先落（cleanup running）——routes 的 `_assertNotArchived` 与
   input-gateway 的 `thread_archived` 拒绝自此刻生效，先于 seal；
2. seal 事务（一次 store 落盘）：hold 置位 + 取消全部 pending（保留原因
   与时间）+ 收敛交接挡板；in_flight / delivered 进入 `inflightDrain`
   清单，不取消（已开始的调用允许自然完成，hold 保证完成后不再消费
   后续工作）；
3. 停止成员 runtime（graceful，不预先 interrupt）→ 收尾 board；
4. cleanup `complete` / `partial`（partial 附 stage 级 failures，不伪装成功）。

恢复（`unarchive`）：只恢复可调度资格与归档标记清除；不复活 cancelled、
不启动 runtime。运行中归档拒绝（`thread_busy`，先中断再归档）。

## 7. 删除（T005，直接级联，无回收站）

`thread-delete.js` 的 `deleteThread`（生产资源装配
`thread-delete-resources.js`）：

1. begin 事务：hold + deleting 标记同盘落盘——`thread_held` 挡投递，
   `thread_deleting` 在四处入口拒绝新写入 / 新派发（commands / deliver /
   input-gateway / beginSessionSuccession / commitSuccession）；
2. 收尾运行中调用：优先等待自然完成（默认 `forceWaitMs=5000` 预算），
   超预算强制停止；
3. seal：status=closed + 取消剩余 pending / in_flight（closed 是框架
   terminal：advanceHead / beginSessionHandoff 拒绝，deliver 返回
   `thread_closed`）；
4. 级联清理（每步幂等）：sessions → handoffs → runtimes → board → archive
   → record / index（最后删，partial 时保留作重试寻址对象）；
5. 结果 `complete` / `partial` + 结构化残留（stage + error）；重复执行
   可继续收敛到 complete。

删除后旧 ID 的读路径返回 not found；成员会话不能单独删除（经
`resolveLifecycleTarget` 定位到所属 Thread）。

## 8. 恢复（board resume）

`POST /protoclaw/threads/:threadId/resume` → `board.resume`：恢复 failed /
waiting_input 看板的调度资格；不是 unarchive 的别名（unarchive 恢复归档
标记），不产生 successor。

## 9. 重启恢复面（T007 场景 16）

server / runtime 重启后，新 control 实例从 `~/.agentdev/AgentDevClaw/threads/`
读回完整现场：thread 记录（head / chain / identity）、Inbox 指令与状态、
board 执行状态、归档索引、pendingSuccession 挡板（经 §3 的收敛服务处理）。
回归证据见 `test/t007-thread-restart-recovery.test.js`。

---

## 未实现的未来能力（明确边界，不是已完成）

- 24 小时自主执行 / 外部工单源 / WorkPool / PR 闭环（设计宪法划定的
  未来阶段，本批未做）；
- 交接完成后自动投递的续接指令模板化（当前依赖用户暂存的指令）；
- context threshold 触发 rotation 的 coordinator 决策层（当前
  context guard 只做「过界即打断上报 + 线程接力」）；
- IM 渠道绑定线程宿主时的 input-gateway 改接（规则已写在网关头注释，
  未接线）；
- autonomous 模式 + 完成协议（测试 / git / PR 证据链）。
