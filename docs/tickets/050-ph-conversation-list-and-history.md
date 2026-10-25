# 050 — PH 列表对话聚合与历史存档（ADR-0032）

| | |
|---|---|
| 状态 | 已完成（隔离环境端到端冒烟 050 断言面 17/17；LLM 轮次等待 2 项因 Input lease 消费竞态超时，见「验证边界」） |
| 上游 | [ADR-0032](../../docs/adr/0032-programming-helper-thread-driven.md) · [批次总入口](2026-10-24-ph-thread-driven.md) · 前置 [049](049-ph-trim-inplace-succession.md) |
| 仓库 | [AgentDevClaw](https://github.com/dangeHub/AgentDevClaw) |

## 交付边界

- 服务端 thread 详情端点带代际元数据（`sessionChainMeta`：链事实时间锚/触发方式合并会话索引标题/规模，倒序）；列表接口行语义不变（见实施决策）。
- 前端会话列表聚合：head 行挂「历史 · N」徽标入口；归档区收敛历史代成员（只经入口可达）；混合期未建线会话自然特例。
- 历史存档面板：存档卡列表（时间锚 + 触发方式 + 规模）→ 只读查看（既有 `view_session_record` 路径）→「从这段继续」分支（既有 `sessions/branch`，整代保留）。
- `sessions_move` 整链移动：选中 head 时历史代成员并入移动集合，走完全相同校验与落盘。

## 实施决策：前端聚合而非列表接口改行语义

工单原文「服务端列表接口吐对话分组投影」。实施时改为**前端聚合**（threads 数据已在客户端 `ClawThreads` store，渲染层达成「行 = 对话」），服务端只扩展 thread 详情元数据。理由：`/protoclaw/prebuilt_sessions` 有大量非列表消费方（dispatch / external-runtime / model-settings / remote-connections），改行语义影响面远超本票范围；且归档代成员只存在于归档切片，主列表聚合实际只需 head 行加徽标，服务端投影不产生增量信息。「行 = Thread」的用户可见语义在前端渲染层完整达成。

## 验收标准

混合渲染（已建线对话与未迁移 Session 行并存）呈现正确；两次精简的对话在列表中一行、历史两份存档可读、分支标注正确；整链移动后两代归属一致且配置跟随目标。

## 实施记录

- 服务端：`GET /protoclaw/threads/:id` 响应新增 `sessionChainMeta`（每代 sessionId/role/endKind/endedAt/title/messageCount，倒序）；`movePhSessions` 选中线程 head 时按 `sessionChain` 扩链，扩链成员走完整校验与落盘（048 引入的线程域 busy 判定覆盖全部扩链成员）。
- 前端：`session-list-render.js` 行徽标「历史 · N」（仅精简过的对话显示）与归档区收敛（历史代成员不散落归档列表）；新模块 `ph-thread-history.js` 历史存档面板（存档卡 → 只读查看 → 从这段继续）。
- 定向测试：`thread-detail-chain-meta`（4）、`ph-project-session-move` 追加整链用例（3）、`frontend-thread-list-aggregation`（7）、`frontend-ph-thread-history`（4），均通过并做破坏验证；全量回归 fail=1（`ph-project-selector-ui`，stash 对照证明为 HEAD 遗留，与本批无关）。
- 端到端冒烟（隔离环境 + 真实模型）：建线 → 对话 → 两次精简 → 链 3 代 → 归档 → 只读数据源 → 建项目 → 整链移动 3 代 → 项目切片 3 代，全部通过；移动重试窗口验证了「未消化输入拒绝 → 消化完成放行」的完整语义。

## 验证边界与已知发现

- Input lease 消费竞态（**独立链路问题，非本批改动面**）：直发空闲 runtime 的 `user-turn` 走 viewer Input lease 通道，消费延迟不定（同环境实测 8 秒至 6 分钟以上），trim 后 resume 的 runtime 上更易长悬置。thread 队列路径（非 head 成员转投 / 收件箱转投）消费秒级正常。050 冒烟以「等待线程空闲」绕开；该竞态影响接续完成后立即输入的响应性，建议单独排查（线索：UserInputFeature 等待循环的重试周期与 resume 后初始化时序）。
- 接续期间排队输入随 trim 转投到 successor 执行（ADR-0019 pending-work 语义）；线程带未消化输入时移动被拒（048 引入的 queued_inputs 判定），输入消化完成后放行。
