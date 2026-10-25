# 编程小助手线程驱动：对话身份从 Session 提升为 Thread

状态：048–052 计划确认，未开工。原则性决策固化于 [ADR-0032](../adr/0032-programming-helper-thread-driven.md)。

## 目标与范围

编程小助手的「对话」从 Session 提升为 WorkThread：一段对话一个列表条目，精简（trim / summary）在对话内接续而不产生新条目与页面切换，历史以「精简前的完整对话原貌」存档呈现。目录对话与项目对话一并覆盖（`threadHost` 为 APP 级声明，与 `projectId` 归属正交）。

已确认决策（详见 ADR-0032）：

- 机制先行、迁移第二步：机制批上线后新会话即刻线程化；存量迁移独立批次执行，终态全量（含已归档会话）。
- 接续只做手动：`/trim` `/summary` 与精简配置页保留，行为改为触发线程 succession 事务，不再导航切换。自动阈值接续与 adaptive 轮换策略不在本批。
- 前端以「对话」为行概念：未迁移 Session 行是「没有历史的对话」的自然特例，混合渲染期不做伪线程包装。历史存档用时间锚 + 触发方式呈现（不出现「第 N 代」），只读，可「从这段继续」创建分支。
- 输入改线程寻址（服务端解析 head；接续窗口暂存 Inbox）。侧栏零改动（ADR-0010 投影天然覆盖）。
- 「移动对话」改为整链移动（head + 全部历史代），沿用 046 的执行中拒绝与空闲判定。
- 不声明 `maxLiveThreads`（缺省不限额）。搜索 Thread 聚合为独立后续票（052），不阻塞本批。

## 契约要点

- 存量血缘口径：index `metadata.sourceSessionId` + `resumeMode: 'compacted'`（接续边）、`metadata.branchSourceSessionId`（分支边，存量预计为零，链数为下限）。
- 迁移排除项：`resumeMode: one-shot` 的派生子代理会话、无索引记录的孤儿文件（不迁、不改、不清理）。
- 迁移原则：有明确无冲突证据的链合并为一个线程；无证据单例各自成单代线程；歧义关系（多后继、悬空边）进入人工确认清单，不自动合并。
- 迁移执行纪律：先备份、生成预览清单、确认后执行；幂等可重跑（中断重跑不重复创建）。不做 UI 产品化。
- 接续后旧 head 会话的归档状态沿用现状（trim 归档源会话）；历史存档入口独立于归档区，不依赖会话归档字段。
- slash `/trim` `/summary` 的 `applies` 谓词从「线程宿主即隐藏」改为按「是否装配自动接续」或 APP 声明显式区分（coder 行为不变）。

## 已核对的实现入口

- 声明与注册：[prebuilt-agents/official/programming-helper/metadata.json](../../prebuilt-agents/official/programming-helper/metadata.json)（加 `threadHost: true`）、[server/thread-control/host-agents.js](../../server/thread-control/host-agents.js)（声明派生注册）。
- 钩子链（已通用，接线验证为主）：[server/thread-control/thread-integration.js](../../server/thread-control/thread-integration.js)、[thread-rotation.js](../../server/thread-control/thread-rotation.js)、[input-gateway.js](../../server/thread-control/input-gateway.js)、[thread-routes.js](../../server/thread-control/thread-routes.js)、[sse-events.js](../../server/routes/sse-events.js)（publishThreadEvent）。
- 接续编排：[server/routes/session-handoff-helpers.js](../../server/routes/session-handoff-helpers.js)、[server/context-continuity/](../../server/context-continuity/)（trim-appended-summary / inprocess-summary；adaptive-rotation 本批不接）、session 路由的 compact/trim/summary 端点。
- 前端精简：[public/src/modules/trim-page.js](../../public/src/modules/trim-page.js)（现状：提交后等待 successor runtime 并导航切换——本批改为等待线程事件）、[ctx-menu-items.js](../../public/src/modules/ctx-menu-items.js)、[ctx-menu-handlers.js](../../public/src/modules/ctx-menu-handlers.js)、[slash-menu.js](../../public/src/modules/slash-menu.js)（applies 消费）。
- 前端列表与视图：[ph-session-list.js](../../public/src/modules/ph-session-list.js)、[session-list-render.js](../../public/src/modules/session-list-render.js)、[project-data.js](../../public/src/modules/project-data.js)、[session-ui.js](../../public/src/modules/session-ui.js)、[workspace-actions.js](../../public/src/modules/workspace-actions.js)、[runtime-status.js](../../public/src/modules/runtime-status.js)。
- 会话移动：[server/routes/ph-projects.js](../../server/routes/ph-projects.js)（sessions_move）、[public/src/modules/ph-session-move.js](../../public/src/modules/ph-session-move.js)、[ph-project-actions.js](../../public/src/modules/ph-project-actions.js)。
- 搜索（052）：[server/routes/session-search-index.js](../../server/routes/session-search-index.js) 及其测试。
- 存量迁移（051）：`workspaces/programming-helper/sessions/index.json` 血缘字段、[server/thread-control/thread-store.js](../../server/thread-control/thread-store.js)（写入格式与幂等性）、临时分析脚本 `analyze-ph-lineage.mjs` 的口径（重写进 scripts/，含测试）。
- coder 参照实现：[prebuilt-agents/official/coder/](../../prebuilt-agents/official/coder/)（metadata 声明形态）、coder-threads 前端视图、接续等待表面（pending chat surface / awaitSessionId）。

实现前仍须阅读对应完整函数与测试。入口清单不是授权全文件重构，也不证明所有相邻逻辑都需要改。

## 工单与执行

| 票 | 交付 | 前置 |
|---|---|---|
| [048](048-ph-thread-host-declaration.md) | threadHost 声明与服务端线程域接线（建线、删除守卫、输入网关、SSE 事件、谓词调整、外围回归） | 无 |
| [049](049-ph-trim-inplace-succession.md) | 对话内接续体验（精简页提交改造、接续等待表面、换头数据源重绑、输入线程寻址） | 048 |
| [050](050-ph-conversation-list-and-history.md) | 列表对话聚合与服务端投影、历史存档入口与只读查看、分支标注、整链移动 | 049 |
| [051](051-ph-legacy-migration.md) | 存量迁移（血缘聚合脚本、预览清单、幂等执行、歧义人工确认；执行已等确认） | 050 |
| [052](052-ph-search-thread-aggregation.md) | 搜索对话聚合（结果聚合、跨代去重、归档状态、版本定位） | 051，可缓 |

默认 **048 → 049 → 050 → 051 串行**（多票有公共文件交集，不安排并行；051 必须在 050 验收后立即执行，混合渲染期不得无限期悬置）。052 独立后续，按需排期。每票带定向测试；真实浏览器验证是 049 / 050 验收的一部分。

### 各票交付边界与验收标准

**048 声明与服务端接线**：metadata 加 `threadHost: true`；验证新会话（含 branch、目录对话与项目对话）自动建线且归属继承不变；head 删除守卫、输入网关路由、SSE thread 事件对 PH 生效（head 删除走 T005 重定向语义：整线程删除事务）；`/trim` `/summary` applies 谓词按新口径调整（coder 行为零变化）；ACP / CLI / 桌面右键 / 调度 / 群聊外围入口回归。**验收**：新建对话（目录 / 项目各一）建线且 `projectId` 继承正确；head 会话删除重定向为整线程删除事务（`thread_deleted` + 级联清理 complete）；会话移动与项目改绑在线程域拒绝执行中线程；全量 server 回归与外围定向测试通过。

**049 对话内接续**：精简页提交后不再导航（等待 thread 事件：交接开始 → head 提交 → 数据源重绑新 head）；接续期间显示旧 head 最后已持久化内容 + 接力中状态；输入改线程寻址（服务端解析，交接窗口暂存）；滚动 / 草稿 / 焦点跨接续保留；变换产物作为当前对话开头如实呈现。**验收**：真实浏览器场景——手动 `/trim` 与精简页提交各一次，全程页面不离开、接续期间发送的输入在新 head 就绪后送达、列表不出现新条目。

**050 列表与历史**：服务端列表接口吐对话分组投影（行 = Thread：当前 head 标题 / 预览 / 时间 + 历史存档元数据）；前端行渲染与历史入口（「历史 · N」）；历史存档列表（时间锚 + 触发方式 + 规模）、存档只读查看（复用持久化会话读取路径）、「从这段继续」分支标注；`sessions_move` 改整链移动（含历史代归属与执行中拒绝扩展）。**验收**：混合渲染（已建线对话与未迁移 Session 行并存）呈现正确；两次精简的对话在列表中一行、历史两份存档可读、分支标注正确；整链移动后两代归属一致且配置跟随目标。

**051 存量迁移**：[迁移工单](051-ph-legacy-migration.md)记录迁移脚本、启动自动执行、备份与验收。干净血缘自动建线，歧义分量跳过不合并；升级用户在服务启动时迁移，失败告警且不阻断启动。本机存量已按此规则迁移并验收。

**052 搜索对话聚合**（独立后续）：搜索结果按对话聚合、命中标注来源代、跨代去重（同一内容被接续保留不重复计为独立证据）、归档筛选认准线程状态、命中定位绑定内容版本。**验收**：聚合与去重行为有定向测试；「精确打开命中」进入对应历史存档原文位置、「继续对话」进入当前 head。

## 验证与不做项

必须同时覆盖：机制批上线后新会话行为（建线 / 接续 / 输入 / 列表）；混合渲染期两种行形态并存；迁移批幂等与备份回滚；041–047 交付物（双选择器、会话移动、配置隔离、改绑 / 归档 / 删除）在线程域全部回归；coder / memo 行为零变化；远程投影携带 PH 线程会话时身份透传正确。

全部用隔离用户数据目录，不读写真实用户记录；Node node:test + assert/strict，前端沿现有 VM / 浏览器验证方式。真实用户数据迁移（051）需预览清单获用户确认后执行，未获确认不得动真实数据。

本批不做：自动接续与 adaptive 策略、搜索聚合（052 外无搜索改动）、跨 Session 拼接单流、任务看板、消息存储格式改动、coder / memo 行为改动、ADR-0026 未尽实施项重构、跨目录对话转移、外围入口项目化对接。历史设计 `docs/plans/workspace-project-abstraction-design.md` 与 `task-ph-project-persistence.md` 的目录能力继续有效。领域术语见 [CONTEXT.md](../../CONTEXT.md)。
