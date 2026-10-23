# 043 — 项目级 Feature 配置读写与实例隔离

状态：已实施并完成定向验收；整批端到端验收见 [047](047-ph-project-coexistence-acceptance.md)。
仓库：AgentDevClaw。前置：[042](042-ph-project-session-lifecycle.md)。
共同契约：[目录对话与项目对话并存](2026-10-22-ph-project-coexistence.md)。

## 目标

两条正式配置链并存：目录对话读目录层，项目对话读项目层；项目不继承同路径目录配置。沿用成熟队列、三态与累加字段逻辑，不新造一套配置系统。

## 实施

1. 在 feature-config-layers 中新增按项目 ID 寻址的项目层文件读写定位，复用全局/工作空间层。旧 encodeDirConfigFile/readDirLayer 保留原语义，无文件复制或旧配置清洗。
2. PH agent 构造时依据显式运行时身份选择目录层或项目层：
   - 目录：global → agent → dir → session；
   - 项目：global → agent → project → session。
   使用 resolveFeatureConfig/collapseAccumulatedFields/extractFeatureMounts 既有能力。不缓存进程级项目层。
3. 接通服务端 resolved 查询、buildScopeLayers 参数及 resolveWriteTarget 写回定位，项目 scope 使用 project:<id>，解析真实项目后定位文件。不能只改读队列而遗漏 PUT 保存。
4. 项目配置不得写到 dir 文件；目录配置也不因同路径有项目改变效果。全局、工作空间配置的继承/覆盖规则保持不变。
5. `$mount` 项目层维持拒绝，更新服务端前缀校验与错误文案；不能因换 scope 名绕过校验。全局/工作空间装配能力不变。
6. shared-by-project/shared-global 共用进程时，按每个 Agent 实例的 projectId 构造配置。不能通过禁用项目层或强制拆进程掩盖传递错误。

## 主要入口

`server/shared/feature-config-layers.js`、`feature-mount.js`、`server/routes/feature-config.js`、`prebuilt-agents/official/programming-helper/agent.js`。先阅读现有 resolved/PUT 和累加字段测试。前端编辑器接入由 045 负责。

## 验收

- D 目录层、A/B 项目层各配置不同参数，同目录三类会话各得其值。
- 修改 D 目录层不影响 A/B；修改 A 不影响 D/B；全局与 agent 层仍按原规则继承。
- resolved 与保存后重新 resolved 一致；项目继承/null/累加字段与既有配置契约一致。
- 无效项目 scope 明确失败，项目 `$mount` 在写回及装配两个入口都不能绕过。
- 同一真实共享进程内至少两个不同项目实例验证配置分离（沿既有 workspace-agents-runtime 测试模式，隔离数据、无模型请求）；保留目录层现有回归。

## 边界

不迁移 dir-*.json，不给 Coder 添加项目层，不改框架配置合并语义，不建设项目级 Feature 包装配功能。运行中配置是否即时刷新继续既有契约，不顺带引入热更新。
