# T007 验收报告 — Thread 语义端到端回归与文档收口

- 分支：`feature/thread-semantics-tickets`（基于 17b908e）
- 全量结果：`npm run test:core` → **2673 tests / 0 fail / 7.2s 墙钟**（预算 ~15s，上限 30s；4 个 skipped 为 `speech-model.test.js` 既有 `skip: true` 声明，与本批无关）
- 基线说明：改动前干净树全量有 6 个既有平台相关失败（`coder-acp-routes.test.js` 2 个 Windows 大小写用例、`frontend-focus-state.test.js` 4 个 CRLF 提取标记），均为 Linux 平台假设漂移，与本批 thread 语义无关；已做平台可移植修正并纳入本 commit（见「附带修正」）。

## 一、16 场景逐条结果

### 身份与接力

| # | 场景 | 结果 | 证据位置 |
|---|---|---|---|
| 1 | coder root → compact → coder successor | 通过 | **新增** `test/t007-successor-identity.test.js`：会话侧身份继承（handoff.sourceRecord.sessionType=coder → successor 以 sessionType='coder' 创建，真实 tmp handoff 文件 + 全 stub deps）；Thread 侧提交经 `test/thread-succession.test.js`「compact / summary / trim 共享入口」+「READY successor is committed」；`test/trim-with-summary-convergence.test.js` 验证 handoff 包落 `sourceRecord.sessionType='coder'` |
| 2 | coder root → summary/trim → coder successor | 通过 | 同上（同一共享入口 `createCompactedResumeFromHandoff`，trim+summary 经 `runTrimTranscriptWithSummary` 产出 SuccessorSeed 后同路径落盘）；历史 handoff 缺 sessionType 时不伪造身份（新增用例）；`test/summarized-handoff.test.js` 验证 summary 路径 sourceRecord 字段透传 |
| 3 | successor 创建成功但 Runtime 未 READY：旧 head 保持有效 | 通过 | `test/thread-succession.test.js`「not-READY successor is rejected: head stays the old session, failure stage recorded, barrier converged」+「after READY-gate failure the old head is authoritative: staged commands deliver to it」；`test/thread-rotation.test.js` READY 超时 → rotation_failed + 旧 head 退役 |
| 4 | successor 身份错误：Thread 不推进，错误被明确报告 | 通过 | `test/thread-succession.test.js`「identity mismatch rejects the commit, records stage, leaves the thread untouched」+「successor outside the workspace host is rejected with session_workspace_mismatch」；`test/thread-identity-membership.test.js`「identity mismatch rejects the successor and leaves the thread untouched」（thread_identity_mismatch 稳定码） |
| 5 | 从历史 Session branch：新 coder Thread，原 Thread 不变 | 通过 | `test/thread-identity-membership.test.js`「branch from a historical session creates a new thread with the same identity」（新 threadId、身份继承、原线性链 `['root-c1','mid-c1']` 不被改写）；生产接线 = session.js branch 路由 → `onSessionCreated`（`test/thread-control.test.js`「onSessionCreated creates thread for host sessions only」） |

### 输入与生命周期

| # | 场景 | 结果 | 证据位置 |
|---|---|---|---|
| 6 | head 正常输入直达 Runtime | 通过 | `test/thread-control.test.js` InputGateway「no handoff: passthrough delivery to viewer user-turn」（delivery='delivered'，零经过 Inbox）；「delivers pending command to head runtime via user-turn after head advance」 |
| 7 | 接力窗口输入进入 Inbox，接力完成后只投递一次 | 通过 | `test/thread-control.test.js`「handoff in progress reroutes to Thread Inbox with explicit thread_queued result」；`test/thread-succession.test.js`「committed commands are never re-delivered (no duplicate Inbox delivery)」+「READY successor is committed」（staged command 补投递恰 1 次，`turns.length===1`）；竞态闭合「race closure: delivers immediately when succession lands between route resolution and append」（append 后补投递，确定性 gate，不靠 sleep） |
| 8 | 历史 Session 输入返回过期目标错误，不静默转投 | 通过 | `test/thread-control.test.js`「historical thread sessions reject writes instead of silently targeting the head」（`session_not_head`，409）；变换侧 `test/target-resolution.test.js`「historical session returns stale_session with thread id and current head; never heads it」；图片显式拒绝「image-only input during handoff fails explicitly」 |
| 9 | 归档前 Inbox command 被取消 | 通过 | `test/thread-archive-cancellation.test.js`「cancels every pending command with reason and time; unarchive does not revive them」（保留 lastReason + 时间戳）；`test/thread-lifecycle.test.js`「seals atomically: hold + cancel pending + converge handoff in one store write」（commandsCancelled 计数） |
| 10 | 归档时已开始调用自然完成，但不继续消费后续旧 command | 通过 | `test/thread-archive-cancellation.test.js`「keeps started (in_flight) calls uncancellable-to-cancelled; completion trigger no longer consumes the next command」；`test/thread-lifecycle.test.js` inflightDrain 清单 + 「records partial cleanup when one runtime cannot be stopped」 |
| 11 | 恢复后新 command 可执行，已取消 command 不复活 | 通过 | `test/thread-archive-cancellation.test.js`「new commands after unarchive can be delivered normally」；`test/thread-lifecycle.test.js`「unarchive restores schedulability without reviving cancelled commands or starting a runtime」 |
| 12 | 删除 Thread 级联清理全部关联数据，运行中调用按收尾策略处理 | 通过 | `test/thread-delete-cascade.test.js`：「deletes record/index, session data, handoff, runtimes, board, archive without orphans」；收尾策略三态「prefers natural completion within budget」/「force-stops when the call does not finish within the budget」/「reports drain as structured residual when a runtime refuses to stop」；「partial failure; retry converges to complete」；「seal cancels pending and in_flight commands with the deleting reason」 |

### 产品兼容

| # | 场景 | 结果 | 证据位置 |
|---|---|---|---|
| 13 | main Session 的创建、输入、compact、summary、archive、delete 不变 | 通过 | `test/thread-identity-membership.test.js`「pure-session lifecycle hooks are no-ops and unaffected by the identity gate」+「main sessions of the host workspace stay threadless」；`test/thread-lifecycle.test.js`「leaves main (non-thread) sessions to independent session semantics」；`test/thread-archive-cancellation.test.js`「non-member sessions never enter thread archive」+「session archive route redirects thread members via lifecycle target resolution」；`test/thread-delete-cascade.test.js`「main independent Session 不受影响」两例；`test/session-archive-contract.test.js`（archive-and-replace 既有契约 8 例）；`test/target-resolution.test.js`「standalone main session resolves to itself (behavior unchanged)」 |
| 14 | coder UI 按 Thread 展示，历史棒只读 | 通过 | `test/frontend-thread-store-t006.test.js`（4 例：历史成员 activate 置 browseOnly 只读事实、打开 head 清除残留、Session 入口返回 Thread 时刷新 Thread、非 Thread 不触发）；`test/frontend-coder-threads-t006.test.js`（归档取消文案以 cleanup 事实为准、删除确认级联范围）；`test/agent-lifecycle.test.js`「keeps the coder projection visible while its runtime is spawned but not yet registered」/「drops the coder projection once no live process remains」/「routes a coder child by the spawn-time sessionType snapshot」（侧栏投影三态） |
| 15 | UI、CLI、ACP 从成员 Session 目标触发生命周期动作时，响应主体是实际 Thread | 通过 | 统一解析：`test/target-resolution.test.js`「thread member (head) resolves to its thread」/「historical thread member resolves to the same thread (lifecycle is thread-scoped)」；UI/HTTP 面：`test/thread-archive-cancellation.test.js`「session archive route redirects thread members」+`test/thread-life-state.test.js` archive 409 守卫；**CLI 面新增** `test/threads-cli.test.js`「maps lifecycle subcommands (archive/unarchive/close/resume) to Thread HTTP routes」（整 Thread 语义，archive 响应透传 cleanup 事实）；ACP 面：`test/coder-acp-routes.test.js`「resolves a non-head member session to the current head via sessionChain fallback」+「rejects an archived thread (409)」+「lists one entry per active thread (head view)」+`test/coder-acp-wire.test.js`「session/resume rebinds to the thread head and prompts land on it」 |
| 16 | 重启 server/runtime 后 Thread、head、Inbox 和归档结果仍能恢复 | 通过 | **新增** `test/t007-thread-restart-recovery.test.js`：跨 control 实例读回 head/chain/identity/inbox/board/归档标记并继续服务（4 例：完整现场恢复、归档跨重启 + unarchive 不复活 cancelled、pendingSuccession 挡板跨重启保留并由恢复服务收敛、归档与并发 append 的 hook 确定性交错）；崩溃收敛细节见 `test/thread-succession.test.js`「进程重启按落盘状态收敛」（状态驱动非 TTL，head_session_missing 永不投向未知目标） |

## 二、真实本地运行链（coder successor 未退回 main）

**新增 `test/t007-coder-assembly.test.js`**（spawn 子进程 + HOME 隔离，fixture `test/fixtures/t007-coder-assembly-probe.mjs`）：

- 真实 import 生产模块 `prebuilt-agents/official/programming-helper/agent.js`，经 `resolveAgentClass({runtime:{sessionType}})` 分派并真实实例化（与 `scripts/run-prebuilt-agent.js:724` 同一分派键）；
- `ensureFeatureTools({strict:true})` 全量装配 + `onInitiate` 渲染真实系统提示词 + 读回真实工具表；
- 断言三层：
  1. **身份分派**：coder → `CoderAgent`，main → `ProgrammingHelperAgent`（两类互斥）；
  2. **提示词**：coder 提示词含「自动化编码智能体」标记且不含「编程小助手」标记（互斥，防装配退回）；main 反之；两套提示词长度不同（非同一模板）；
  3. **工具**：coder（57 工具）不含 main 独有的 `ask_user_choice` / `ui_surface_*` / `mcp_*` 交互工具（无人值守场景会永久 pending），保留 coder 专属 `tickets_flow_skill`；共享底座工具（read/write/edit/bash/glob/grep）两侧齐备。

左侧投影不退回 main 由既有 `test/agent-lifecycle.test.js` 三例（场景 14 证据）覆盖：coder 子进程按 spawn 时 sessionType 快照路由，index 缺失也不回落 main 分类。

## 三、文档一致性核对结果

| 文档 | 核对结果 | 处理 |
|---|---|---|
| `docs/work-thread-design.md` | §5.2 写入点引用已不存在的 `summary_resume` 路由（行号式描述漂移）；§8 含过期测试数量快照与「2 个已知既有失败」断言；§9 路由表 `DELETE` 应为 `POST .../delete`、`resume` 描述错（实为 board 调度恢复，非恢复归档 head）、`unarchive` 标「兼容别名」（实为正式动作）、CLI 清单缺 `archive`/`unarchive`；§10 速查缺 T002–T005 五个新模块、引用的 `thread-runtime-bridge.js` 不存在 | 全部修正：§5.2 改为 compact_and_resume 公共入口 + thread-rotation 两处生产接线；§8 快照改为指向 T007 回归矩阵；§9 路由/CLI 表对齐 `thread-routes.js` 与 `bin/claw.mjs` 现行实现；§10 补 host-agents / thread-succession / target-resolution / thread-lifecycle / thread-archive / thread-delete(-resources) |
| `docs/work-thread-lifecycle.md` | **文件不存在**（被 design:3/:282、ADR-001:5、T001:31、T007:44 共 5 处引用） | 新建：按 T001–T006 落地事实描述接线总览、身份连续性、提交点与失败收敛、统一目标解析、输入路由（§5，design 文档 §4.2 指向它）、归档/删除/恢复/重启恢复面，末尾列「未实现的未来能力」 |
| `agents/README.md` | ACP 能力清单过期：`session/list` / `session/resume` / `session/load` 三个已实现方法仍列在「未声明或不支持」；「无 load/resume」限制条款与 wire 测试矛盾；`session/close` 描述为「关闭 WorkThread」（实为转发归档，成员保留）；4 个死链（coder-acp-adapter-design.md / ADR-0004 / tickets 020/021 均不在仓库） | 能力清单补齐三方法并修正 close 语义为「转发 Claw 归档」；限制条款改为「断开不删除 Claw 对象，重连经 resume/load」；死链改为指向现行权威（`scripts/coder-acp/main.js` 头注释 + `server/routes/acp.js` 路由契约 + `test/coder-acp-wire.test.js`） |
| `.agentdev/tickets/GLOSSARY.md` | 「Resume / Unarchive」把两个独立动作混写（unarchive=清归档标记，resume=board 调度恢复；T003/T004 后语义已分离） | 拆为 Unarchive / Resume 两条目，各自边界明确 |
| `.agentdev/tickets/ADR-001-session-thread-role-boundary.md` | 仅第 5 行引用 lifecycle 文档（随新建文件闭环）；决策内容与实现一致，无需改动 | 不改（引用已有效） |
| `CLAUDE.md` | 提及 `docs/adr/`、`docs/frontend-rendering-patterns.md` 等本仓库未跟踪的文档（上游文档体系漂移），不在 T007 四份核对对象内 | 不扩范围，报告记录即可 |

## 四、未实现的未来能力（明确边界，不是已完成）

1. **24 小时自主执行 / 外部工单源 / WorkPool / PR 闭环**：设计宪法（work-thread-design.md §1.2-11）划定的未来阶段，本批未做；
2. **交接完成后自动投递的续接指令模板化**：当前依赖用户在交接窗口暂存的指令；
3. **context threshold 触发 rotation 的 coordinator 决策层**：当前 context guard 只做「过界即打断上报 + 线程接力」（`thread-rotation.js`），不含任务级决策；
4. **IM 渠道绑定线程宿主时的 input-gateway 改接**：规则已写在 `input-gateway.js` 头注释（防止接错），未接线；
5. **autonomous 模式 + 完成协议**（测试 / git / PR 证据链）：`claw threads create --mode autonomous` 参数保留但无完成判定语义；
6. **ACP token 级流式 / 多模态 prompt / session modes / MCP 透传**：v1 明确不支持（agents/README.md「未声明或不支持」清单）。

## 五、附带修正（非 thread 语义，平台可移植性）

- `test/frontend-focus-state.test.js`：源码提取标记依赖 CRLF（`\r\n\r\n`），源文件为 LF → Linux 下 4 例失败；改为读取时行尾归一化 + LF 标记（Windows 不受影响）；
- `test/coder-acp-routes.test.js` 2 例：「Windows 大小写不敏感 cwd」用例把大小写差异放在文件系统侧（`validCwd().toLowerCase()` 需真实存在），Linux 上 `validateAcpCwd` 报 400；差异改放数据侧（记录 openDirectory 大小写变体，请求侧用真实存在目录），验证 `acpPathKey` 归一化比较语义本身——该语义跨平台不变。

## 六、交付物清单

- 回归测试：`test/t007-successor-identity.test.js`（6 例）、`test/t007-thread-restart-recovery.test.js`（4 例）、`test/t007-coder-assembly.test.js`（3 例 + probe fixture）、`test/t007-helpers.js`（共享夹具）；`test/threads-cli.test.js` 增补生命周期子命令映射（1 例）
- 文档：新建 `docs/work-thread-lifecycle.md`；修正 `docs/work-thread-design.md`（§5.2/§8/§9/§10）、`agents/README.md`（ACP 能力面 + 死链）、`.agentdev/tickets/GLOSSARY.md`（Resume/Unarchive 拆分）
- 验收报告：本文件
