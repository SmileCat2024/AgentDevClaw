# coder 升格独立工作空间 — 实施计划

> 状态：P0–P3 已实施（2026-10-11）。验收 1/2/5 已达成（全量回归、结构性 grep、搬移幂等单测）；验收 3/4（可拔插重启、端到端手测）需真实服务切换窗口执行——注意重启会触发数据搬移并中断在跑线程，切换前先归档在跑线程。
> 决策依据：[ADR-0025](../adr/0025-coder-workspace-promotion.md)。对象模型、呈现策略、退役范围、数据处置的全部决策以 ADR 为准，本文只排工程顺序、改造面锚点与验收。

日期：2026-10-11

## 目标终态

- `prebuilt-agents/official/coder/` 成为独立后台型 APP（`host: programming-helper`，`visibility: on-demand`），内含 coder agent；编程小助手收回单 agent。
- 会话归属、线程归属、进程组、feature 作用域、输入路由全部以 APP 为结构事实；sessionType 身份投影语义全库退役。
- coder 侧历史数据一次性遗弃搬移，新线程域从零开始。

## 阶段与依赖

```text
P0 骨架与遗弃搬移           独立可先行
P1 服务端身份结构化          依赖 P0（会话先有归属目标）
P2 前端呈现                  依赖 P1（消费 /api/agents 新形状）
P3 退役清除、文档与验收      依赖 P1/P2
```

### P0 骨架与遗弃搬移

- 新 workspace 目录：metadata.json（id `coder`、host、visibility、单 agent 声明、ui：线程列表首页 + 已归档 tab）；agent.js 转出口（`coder-agent.js` 从编程小助手目录迁回）。
- 遗弃搬移模块（参照 studio-feature-migration 的启动幂等先例，服务启动时执行一次）：
  - **白名单枚举**，只搬枚举对象：
    - threads 全局库（`~/.agentdev/AgentDevClaw/threads/`）：`workspaceId=coder` 条目；`workspaceId=programming-helper` 名下线程（main 会话不建线程，ph 名下全部为 coder 线程——含带 `identity=coder` 与合并早期无 identity 字段两类）及 boards / archive-index 连带条目。
    - programming-helper 会话存储（`workspaces/programming-helper/sessions/`，路径锚点 `session-access.js` 的 getPrebuiltAgentSessionDir）：sessionType=coder / agentType=CoderAgent 的会话记录与索引条目。
    - open-sessions 中 coder 相关条目。
  - 搬移前逐类计数写日志；任何一条失败拒绝启动（fail-hard）；目标 `~/.agentdev/AgentDevClaw/retired/coder-identity-20261011/`，整目录可还原回滚。

### P1 服务端身份结构化

- 会话域：coder 会话按 APP `coder` 存储与索引；`POST /protoclaw/prebuilt_sessions`、activate 等路由以 `agentId=coder` 寻址（ACP / `claw threads` 外部契约不变，内部换目标）；旧 `programming-helper + sessionType=coder` 调用形态直接报错，不留兼容。
- 线程域：host-agents 判定恢复 APP 级（coder APP 会话即线程宿主）；thread-identity 会话身份解析层删除；thread-integration 写入 `workspaceId=coder`。
- 输入网关 / target-resolution / deliver：按 APP + 线程寻址，去身份推导与跨身份兜底。
- 进程组：computeProcessGroupKey 收敛为 agentId 分段（删除 sessionType 段）。
- feature 作用域与配置层：install-service 作用域、feature-config-layers 对齐 APP 语义（`agent-configs/coder.json` 键不变）。
- runtime 宿主：run-prebuilt-agent 直接加载 coder APP agent.js；resolveAgentClass 分派与 `PROTOCLAW_SESSION_TYPE` 的 coder 用法删除。
- 投影出口：agent-connected / session-helpers-pure 删除并列身份合成与 `owner:type` sidebar_entry_id 投影；`/api/agents` 输出 APP 级条目并携带 visibility 字段。

### P2 前端

- 侧栏：工作空间清单消费 visibility（persistent 直显；on-demand = 当前存活且绑定 Session 的 Runtime，用户可覆盖为始终显示）；host 相邻排序；Coder 条目下统一投影叶子（运行中 head 会话，零特例）。
- Coder APP 视图：现 coder-threads-ui 迁为 coder APP 首页 block（行 = 线程、生命状态徽标、打开 head / 中断 / 归档 / 取消归档）。
- 宿主首页保留 Coder 入口 block（host 绑定的呈现落点）。
- 标题链单真相源（会话记录自身）；输入路由按当前视图所属 APP；删除投影 id 归一、撑存条目识别、focusedAgentId 投影写入路径；open-sessions 恢复卡片身份过滤补丁删除。

### P3 退役清除、文档与验收

- ADR-0025 退役清单逐项删除；对应测试改写（badge-residency / succession-sidebar / fallback-pruning 等锁定的毒化场景随模型消失，改写为结构归属断言）。
- 文档同步：AGENT.md（编程小助手章节、进程架构注记）、docs/protocols/cli-calling-schema.md、work-thread-design.md 的身份表述、ADR-0010 注记 Phase 1.5 撤销、glossary。

## 验收

1. 全量回归（4000+ 基线）零失败；eslint 零新增。
2. 结构性检查（grep 全库）：无 sessionType 身份分支消费（`plain` / `studio-debug` 标签用法除外）、无 `programming-helper:coder` 字面量、无 sidebar_entry_id 合成。
3. 可拔插：删除 `prebuilt-agents/official/coder/` 并重启，其余工作空间的服务启动、发现、路由、配置与 UI 全部正常。
4. 端到端手测：首次派遣 → Coder 条目出现 → 原地连续两轮接续（无踢出、无乱入、徽标与标题正常）→ main 会话输入不串 → 归档线程后条目仍在 → 重启服务后按 Runtime 存活事实显示。
5. 遗弃搬移：首次启动搬移成功、二次启动幂等跳过；编程小助手会话列表、checkpoint、历史完整无损。

## 收尾修订（2026-10-11，主链路验收后）

验收 4 的侧栏呈现模型按用户裁定修订，**粘性记忆已退役**：

- on-demand 可见性改为服务端合流：作者声明默认（metadata `visibility`）+ 用户覆盖（设置 → 工作空间，`server/routes/workspace-settings.js`，服务端存储）+ 判定事实「有存活且绑定 Session 的 managed Runtime，或接续挡板在途（线程 `status=rotating`）」。未归档线程记录不代表 Runtime 正在运行；Runtime 停止且无接续挡板时，默认 auto 隐藏入口，线程仍保留在 APP 首页。接续挡板例外保证接续空窗（旧 head 已退役、successor 未上线）期间入口不闪失，前端接续占位保持可见。wire 以 `sidebarVisible` 下发，前端纯消费（`localStorage` 粘性键 `claw:onDemandAppsSeen` 删除）。入口消失后的找回路径是设置的「始终显示」。
- hosted APP 跟随宿主分组：Coder 紧随智能编码空间，同在工具与效率组（此前"紧随"排序被分组拆断）。
- 宿主首页的 Coder 入口 block 移除（coder 呈现归侧栏条目与设置面板，不在宿主首页重复入口）。
- 侧栏 coder 线程条目右键恢复线程语义菜单：复制 Thread ID / 中断（busy 时可用）/ 归档（idle 时可用，即正常关闭；服务端 thread_busy 拒绝 busy 归档）/ 删除（危险区）。与线程视图行动作同一组端点。
- 接续占位条目（虚线）在接续窗口内不可点选与操作的根因修复：`switchAgent` 的 workspace-surface 分支前置到 runtime 守卫之前（宿主 APP 无 runtime 时直达工作空间首页，不再静默短路）。

## 风险登记

| 风险 | 缓解 |
|---|---|
| 遗弃搬移误伤 main 数据 | 白名单枚举、搬移前计数校验、fail-hard、遗弃目录整目录可还原 |
| 切换窗内正在执行的派遣中断失联 | 已接受（ADR 决策 5）；切换前手动归档在跑线程 |
| 合并早期无 identity 字段线程误判 | 枚举基于"main 会话不建线程"事实；搬移前人工核对分类计数 |
| 远程投影测试面漏改 | remote-catalog / remote-sidebar-projection / remote-identity-projection 往返测试在 P1 先行改写 |
| 测试基线大改削弱回归信号 | 先按新模型改写身份相关测试（允许短暂红），再动实现转绿 |

## 明确不做

见 [ADR-0025 不做清单](../adr/0025-coder-workspace-promotion.md#不做清单显式边界)：不做多 agent 机制、动态安装子 APP、UI 创建入口、ADR-0024 接续收尾、历史数据迁移呈现、通用置顶机制。
