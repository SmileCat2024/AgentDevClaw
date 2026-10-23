# 042 — 项目会话归属、派生与运行时装配

状态：已实施并完成定向验收；整批端到端验收见 [047](047-ph-project-coexistence-acceptance.md)。
仓库：AgentDevClaw。前置：[041](041-ph-project-store-and-api.md)。
共同契约：[目录对话与项目对话并存](2026-10-22-ph-project-coexistence.md)。

## 目标

项目内创建、保存、打开、分支和接续的 Session 始终明确归属项目，并使用该项目的工作目录；目录会话继续原路径。项目化仍使用普通 Session，不自动建 Thread。

## 实施

1. `POST /protoclaw/prebuilt_sessions` 与 `createPrebuiltSession` 对 PH 新增显式 projectId 分支：解析项目并取得目录，保存归属。无项目参数继续旧目录语义，不查找同路径项目。显式非法/未知项目 ID 报错，不退回目录路径；其他 agent 不接受 PH 项目身份。
2. 明确索引为归属权威，补轻记录和创建响应传递。保留 workspaceAgentId 等既有绑定。项目下的新对话编号独立，不与同目录其他集合混用。
3. 分支、trim、summary/compact successor 从来源 Session 继承归属；不能由当前页面或 workspace 目录覆盖。覆盖直接构造分支索引的路径，不能只改 createPrebuiltSession。优先从来源索引取归属，不为项目化迁移历史 handoff 包。
4. activatePrebuiltSession 的项目分支不把 Session 保存的旧目录写回原目录选择。保存、session_meta_sync、标题和索引更新保留 projectId，不在元数据同步时根据目录重新判断。
5. `agent-startup.js` 及 prebuilt/mirror/one-shot 三类宿主从 Session 解析项目当前目录与项目身份，逐 Session 传入运行时装配。已有目录分支与非 PH 行为不变。避免三份代码各自实现不同归属规则。
6. 共享进程的首 Session 和 add-session 都带目标身份；每个 SessionLifecycle/Agent 独立解析，不沿用第一个实例的项目。现有进程模式不因项目配置而强制改变；shared-global 同样不能丢项目身份。

## 主要入口

`server/routes/session-helpers.js`、`session.js`、`session-handoff-helpers.js`、`agent-startup.js`；`server/shared/session-access.js`；`scripts/run-prebuilt-agent.js`、`mirror-runtime.js`、`run-one-shot-agent.js`。

## 验收

- D 目录对话与同路径 A/B 项目对话能分别创建，索引 ID/归属正确，无历史批量补字段。
- 分支和每种现有精简接续继承来源归属及 workspaceAgentId；当前选中 B 不影响 A 的派生。
- 保存后重启恢复仍保留归属；显式失效项目不被当目录会话继续运行。
- 同进程装配多 Session 时身份按实例传递，覆盖首 Session/add-session 两条路径；不发真实模型请求。
- 目录会话创建、激活、编号、派生与原配置解析的定向回归不变。

## 边界

配置层读写归 043；列表与目录批量操作隔离归 044；运行中改绑归 046。不要把“下次启动可解析新目录”报告为“已运行实例能自动改绑”。不扩展外围创建入口，不引入 Thread、无目录默认项目或历史归属迁移器。
