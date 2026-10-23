# 041 — 独立项目存储与基本管理端点

状态：已实施并完成定向验收；整批端到端验收见 [047](047-ph-project-coexistence-acceptance.md)。
仓库：AgentDevClaw。前置：无。
共同契约：[目录对话与项目对话并存](2026-10-22-ph-project-coexistence.md)。

## 目标

在现有目录能力旁新增独立项目，不转换 phProjects，不改历史对话归属，也不改变旧目录路由的输入语义。

## 实施

1. 在 `workspaces/programming-helper/projects.json` 持有版本化项目集合，封装读取、新建、改名与查询。项目包括稳定 ID、名称、workDirectory、external/managed 来源、归档及时间字段。名称和目录不参与 ID 生成；同名/同目录项目按 ID 区分。
2. 专属工作目录位于 Claw 用户数据根下的 PH 项目区域，以项目 ID 分配，目录与消息存储分离。记录 external/managed 来源，不根据路径恰好在数据根下就推断为可删除的托管资产。
3. 增加项目管理路由，复用现有鉴权、错误与显式资源寻址模式；只支持 PH。路径命名由本票定稿并同步共同契约，至少提供 list/get/create/rename。新建项目不自动创建 Session，不启动模型。
4. 外部目录校验复用现有目录解析；存量项目引用暂时不存在的目录不能因此从项目表消失。无文件表示空集合；损坏项目表不能静默当空再覆盖。
5. 不把独立项目塞进 `normalizeWorkspacePhProject` / `upsertWorkspacePhProject`，它们继续管理目录条目。项目记录不调用 writeWorkspaceState 的目录 docset 同步。
6. 项目表属于工作空间持久资产，前端选中项只负责浏览与恢复；不得把新增项目路径写回旧目录当前状态。若新增 workspace 投影字段，接通 `normalizeWorkspaceState` 白名单而不丢旧字段。

## 主要入口

`server/routes/workspace.js`、`workspace-projects.js`、`server.js` 的 ph_project 路由及路由装配；`server/shared/constants.js` 用户数据根。优先新增职责明确的项目存储/路由模块，旧目录实现只在确有公共接线需求处改动。

## 验收

- 同一目录新建 A/B 得到两个稳定 ID，改名后 ID 不变；重新读取仍存在。
- 外部目录不新增文件；托管项目创建专属目录，无 Session 文件或 runtime 副作用。
- 无项目表时旧目录状态、历史索引、目录配置和调度文件不被改写。
- 原目录 open/switch/add 测试保持成立，旧 normalize 的目录 ID 规则不被全局替换。
- 测试覆盖非法 ID、未知项目、路径及项目表损坏；使用临时用户数据根，node:test + assert/strict。

## 交付边界

本票只提供存储和基本 API，不开放未接通的前端项目入口。归档、改绑与永久删除由 046 完成，不能先提供会误用目录批量删除的端点。报告实际接口/字段、定向测试及未验证项。不改 Coder/ACP/CLI/桌面/调度/群聊，不批量迁移，不重启用户服务，不自行提交或 push。
