# coder 迁入编程小助手工作空间 — 设计共识与执行蓝图

> 状态：历史设计记录；迁移结果与现行 Thread 生命周期以 [`docs/plans/work-thread-lifecycle.md`](../work-thread-lifecycle.md) 为准。
> 日期：2026-08-24

## 1. 背景与目标

「自动化编码智能体」（`prebuilt-agents/official/coder/`）此前是一个独立工作空间。本工程将其彻底迁入「编程小助手」（`programming-helper`）工作空间，同时移除编程小助手中的探索代理与子代理形态。迁移后的编程小助手工作空间承载两种身份：

| 身份 | sessionType | 形态 | 创建方 |
|------|-------------|------|--------|
| 编程小助手（main） | 缺省 | 交互式编程助手 | 用户（UI 新建） |
| coder | `coder` | 无人值守线程宿主 | 仅调度面（ACP / `claw threads` CLI / dispatch 技能） |

**用户不能创建 coder 会话。** UI 的「新建」动作只产生 main 会话。

## 2. 核心哲学：session 是实体，thread 是连接结构

- **session 是唯一的实体层**：进入线程的落点仍是普通会话，chat surface、消息渲染、runtime 交互全部复用 claw 既有机制，不发明新控制面。
- **thread 是叠加在 session 之上的视图/索引层**：把链条成员折叠成一行避免会话炸屏，持有始终指向最新 head 的指针。历史分片会话是一等公民，随意进出，可见性由线程视图折叠——不存在「解锁/考古」概念。
- 整体是**拼出来、连接起来的结构**，不是硬性规定出来的结构。不做自动跳转等硬性行为。

## 3. 导航层：左侧按身份投影（条件出现）

- 底层单工作空间（agentId 同为 `programming-helper`、同一 runtime）。coder 的常驻浏览入口在**工作空间内部**：项目卡片 tab 栏「主代理 / 已归档 / coder」，coder tab 内嵌该项目的线程列表（替代原探索代理 tab 位置）。
- **左侧投影条目仅在该身份有存活 runtime 会话时出现**（coder 会话进程在线）：「工具与效率」分组下与编程小助手并列，承载运行中的 coder 会话子项与全局线程视图。身份闲置时左侧不出现面板——「当 coder 运行的时候，它才在工作空间之外有自己的分类归属」。
- **通用机制，声明驱动**：metadata 中 `identities[].sidebarEntry: true` 的身份展开为独立条目。投影只在 sidebar 数据源（`get_connected_agents`）展开且带存活条件；`get_prebuilt_agents` 不展开（其 id 被会话创建方直接消费，投影 id 不是合法工作空间）。未声明的维持单条目现状，无特判。
- 固定投影形态，无显示模式开关。
- 入口记忆与 PH 会话列表记忆互不干扰；投影条目不继承宿主会话级字段（runtime_session_id / active_workspace_* / workspace_sessions），否则会在 coder 条目下合成 main 会话镜像。
- 状态显示：共享 runtime 基础状态；coder 栏在存在 `executing` 线程时叠加活跃标记。
- **tab 分家，不混排**：
  - 编程小助手项目卡片：「主代理」（main 会话）/「已归档」（归档会话）/「coder」（该项目线程）
  - coder 投影入口（运行时出现）：线程列表 /「已归档」（归档线程）

## 4. coder 入口：线程视图

- **行 = 线程**；行入口每次动态解析当前 headSessionId（不自动跳转，去不去由用户决定）。
- 线程行操作：
  - **中断**：按钮在线程行上，语义「中断此线程」，实现路由到当前 head 的 turn 中断通道。
  - **归档**：触发 Thread 级归档事务，自动中断 head、取消 pending、停止链上 Runtime、关闭 Board，并记录 complete/partial 清理结果。
  - **取消归档**：翻转 archived 标记，交互对齐工作群 wg-threads-panel 先例。
  - **第一版无删除入口**。
- UI 不提供向线程发消息的通道（保持调度纪律：依赖由调度方控制）。
- 会话顶部线程条（仅 coder 会话显示）：复用 thread-store.js 既有 `updateThreadHeaderIndicator`——线程标识 + 承接状态；非 head 会话提供显式「前往当前会话」入口（点击跳转，绝不静默跳转）。
- **非 head 分片只读**：历史会话可以打开查看，但输入返回 `session_not_head`（409）并引导用户打开当前 head；不得静默转投 Thread Inbox。Thread Inbox 只承接 head 在交接窗口内的输入。
- 归档线程**拒绝新投递**：threads send / deliver 对 archived 线程报错「线程已归档」，保护 ACP 复用逻辑不挂到死线程。
- 空态：教育文案（线程由调度创建：ACP 编辑器集成 / `claw threads` CLI / dispatch 技能），无任何创建动作。
- 线程行标题：线程 title 优先，无则回退 head 会话标题。

## 5. 生命状态模型（四态，推导值）

**状态是合成出来的推导值，不是线程实体上的存储字段。**

| 状态 | 含义 |
|------|------|
| `executing` | turn 进行中 |
| `pending-commands` | 有已投递未执行命令 |
| `idle` | open 且无活动 |
| `archived` | 已归档 |

每态附带最后事件时间。优先级 `executing > pending-commands > idle`。

- 无 `awaiting-input` 态：coder agent 不装配 UserInputFeature，不会产生 input request。
- **合成位置在 server threads 控制面**（数据源：board 事件 + pending commands + runtime execution_state 三路聚合），前端只渲染。
- 第一版不做「idle 超时自动降级」类时间判定，如实展示最后事件时间。

## 6. 归档语义

- 归档宾语从会话升维为线程：归档线程 = 宣告工作结束，整条链沉入归档区。
- **数据动作：线程级归档事务**，成员 Session 数据保留；暂停指令、中断 head、取消 pending、尝试停止链上 Runtime、关闭 Board，并将 cleanup 结果写入归档记录。
- 代价（已接受）：任何会话级既有视图（全局搜索、最近会话跳转等）必须统一加「coder 会话按所属线程归档态折叠」规则。
- 归档区 coder 侧一线程一行，与 coder 入口同构；查阅单位与工作单位一致。

## 6a. 生命状态与归档（后端实现，#14 落地）

- 生命状态合成（推导值非存储字段）：`thread-life-state.js` — `archived > executing > pending-commands > idle`，另含 `closed` 系统终态；`executing` = 看板 running 或锚点 rotating；`pending-commands` = commands 含 pending/in_flight；`failed` 单独布尔。`lastEventAt` = max(锚点 updatedAt, 看板 updatedAt)。
- 归档记录：`thread-archive.js` — `threads 根/archive-index.json` 保存 `archivedAt` 与 `archiveCleanup.status=running|complete|partial`。归档是 Thread 级清理事务，原子写 + 串行锁，幂等。
- 路由（thread-routes.js）：list/detail 附带 lifeState 与 cleanup；`POST .../archive` 自动 hold、interrupt head、取消 pending、停止链上 Runtime、关闭 Board；`POST .../unarchive` 解除 hold 并 reopen Board，但不自动启动 Runtime；commands/deliver 对已归档线程拒 409 `thread_archived`。
- ACP `session/close` 语义重定义：adapter 转发 Thread archive；归档事务统一负责中断 head、取消 pending、停止链上 Runtime、关闭 Board，并返回 cleanup 结果。锚点 closeThread 保留给系统硬清理（ACP 创建回滚 / head 会话删除），HTTP close 路由不作为普通用户归档的替代。
- CLI：`claw threads archive|unarchive` 子命令；legacy 探索别名（exp/subs/spawn/compact/resume/show）全部移除，仅保留 new-session。
- 已知边界：succession 交接窗口内归档（board 瞬时非 running）可能放行，pending 命令仍会投递到新 head——HTTP 与 ACP 主路径均有闸，极端竞态可接受。

## 6b. 前端投影与 coder 入口（#15 落地）

- **投影机制（server 两处）**：`collectSidebarIdentityEntries`（agent-discovery.js 纯函数）提取 `sidebarEntry: true` 的非 main 身份；仅 `getConnectedAgents` 在状态落定后展开（带存活条件：存在该 sessionType 的 child runtime）——投影条目 `{ ...host, id: 'programming-helper:coder', agentId: host.id, sessionType: 'coder', ui: identity.ui }`，紧邻宿主插入，不继承会话级字段。共享 runtime 状态（connected/callActive/pending_input），runtime 匹配循环看不到投影条目（id 含 `:`）。child runtime 条目带 sessionType（从会话记录解析），前端 `collectRuntimeEntriesForPrebuilt` 据此把 coder 会话子项路由到投影条目、宿主条目排除之。
- **前端消费**：
  - `handlePrebuiltAgentClick` 投影分支：详情按宿主命名空间加载（`loadAgentDetail(hostAgentId)`），surface 键挂条目自身；`isWorkspaceHostUnit` 按 `agent.agentId` 归入 host 语义（tabless host：无 tab 栏，surface 由 runtime 选择驱动——点条目回入口首页，开 head 会话进 chat）。
  - 入口记忆：`claw:lastFocusedEntryId`（停留在入口首页时）；进入会话浏览由 `switchAgent` 清除（记忆让位给 runtime 记忆）。bootstrap 恢复时投影条目走完整入口点击流程，不按宿主直落。
  - `groupConnectedAgents` 归组按 `agent.agentId || agent.id` 取宿主键。
- **coder 线程视图**（coder-threads-ui.js 重写）：线程卡片（生命状态徽标 + 棒数/接力方式摘要 + 标题回退链 + 最后事件时间 + cleanup 结果）；动作 = 打开 head（整卡可点）/ 中断（路由 `/api/agents/:headViewerAgentId/interrupt`）/ 归档（触发完整清理事务）/ 取消归档 / failed 时恢复；tabs = 线程 / 已归档；空态为教育文案。surface 可见期 5s 强刷（`.coder-threads` 不在 DOM 时不轮询）。
- **coder 会话在 PH 入口的过滤**：`getProgrammingHelperProjects`（project-data.js）与搜索结果（ph-session-list.js）排除 `sessionType === 'coder'` 的会话；会话右键归档仅对 programming-helper main 会话开放（context-menu.js）。
- **会话内线程感知**（thread-store.js 既有能力，会话级化后直接生效）：顶栏线程指示器（head 承接 / 非 head「前往当前会话」/ 交接窗口接力中）、聊天区接力分隔条（trim/摘要来源标注）、输入路由守卫（见 §4 修正）。
- 防回归：thread-control.test.js 增「无 bridge stub 的生产装配」用例（曾因 `resolveRuntimeViewerId` 重命名漏改在生产路径 ReferenceError 而 stub 测试全绿）。

## 7. 配置

- coder 配置保持独立：`.agentdev/agent-configs/coder.json` 按 `agentId=coder` 原键读取，不并入 programming-helper 域。
- 编辑入口：模型预设出现在现有全局模型配置面板（按 agentId 列出 coder）；其余配置第一版无 UI，文件即接口。

## 8. runtime / server 改造

- `agent.js` 按 `runtime.sessionType === 'coder'` 分派 `CoderAgent` / `ProgrammingHelperAgent`；CoderAgent 迁入 PH 目录独立文件，装配保持原样（无 UserInput/GenerativeUI/AudioFeedback/Dispatch/GroupChat/SubAgent，挂 tickets-build-flow，ContextRotationTrigger）。
- `THREAD_HOST_AGENT_IDS` 从 agent 级降维为 (agentId, sessionType) 组合级；`thread-integration.onSessionCreated` 与 `input-gateway` 增加 sessionType 判定。其余 thread 控制面（succession / rotation / 删除清理 / 补投）以「会话是否为线程 head」为判定，不动。
- `POST /protoclaw/prebuilt_sessions` 接受 `sessionType: 'coder'`，经 `PROTOCLAW_SESSION_TYPE` 传递（机制已有，exploration 同路）。
- 进程分组按 sessionType 隔离：交互（main）与无人值守（coder）分进程组，避免重启范围互相波及。
- **ACP 外部契约不变**：`/protoclaw/acp/coder/*` 路由与 `claw acp coder` adapter 进程不动，内部创建逻辑改为 PH + sessionType='coder'。
- 删除 `prebuilt-agents/official/coder/` 目录；`WORKSPACE_SESSION_AGENT_IDS` 等常量收敛。

## 9. 探索代理与子代理移除

- runtime：`isExploration` 分支、explorer identity、explore.md、SubAgentFeature 装配。
- server：`programming-helper.mjs` 的 explorations/subs 操作、`spawn_one_shot` / `resume_sub` 路由、claw-mcp 探索工具/资源/提示、inprocess-summary 的 exploration 角色、群聊 one-shot identity。
- 前端：探索记录 tab、搜索 tab、new-exploration 调度模式、探索模型预设栏、i18n 键。
- 连带清理：`run-compact-mirror.js` 引用为现存死代码。

## 10. 旧数据处置

**完全不迁移、不清理、不展示——装作不存在。** 新线程写到新宿主位置（`workspaces/programming-helper/threads/`），旧 `workspaces/coder/` 原样留档。无迁移脚本。

## 11. 明确不做的事

- plain agent `agents/coder`（`claw run coder`）不动，它是独立快照。
- coder 不进入群聊 identity（独立决策，本次默认不进）。
- IM 经 CallArbiter 路由的边界问题不在本次解决。
- 显示模式切换开关（按工作空间/按身份）不做。
- 线程删除、UI 发消息通道第一版不做。

## 12. 阶段与依赖

```
C 探索移除（runtime → server → 前端 → 测试）   独立可先行
A 合入（THREAD_HOST 降维 → CoderAgent 迁入 → ACP/删目录）
B 生命状态合成 + 前端投影与 coder 入口          依赖 A
E 文档与调度技能                                收尾
回归与冒烟
```

总量约 7-12 人天。数据迁移板块（原 D）已归零。
