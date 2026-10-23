# 044 — 项目投影与旧目录操作隔离

状态：已实施并完成定向验收；整批端到端验收见 [047](047-ph-project-coexistence-acceptance.md)。
仓库：AgentDevClaw。前置：[043](043-ph-project-feature-config.md)。
共同契约：[目录对话与项目对话并存](2026-10-22-ph-project-coexistence.md)。

## 目标

项目会话不重复落入目录列表、搜索分组、目录 latest 或目录批量删除。历史 Session 列表与运行中 child runtime 分别完整投影归属，不能只补一个 wire 白名单。

## 实施

1. 为显式项目过滤提供独立身份条件；原目录过滤同时要求非项目会话。分页、计数、标题搜索、内容搜索、selectFallbackSession/归档删除后的回选使用同一归属规则。
2. 贯通轻记录、summarize、wire 白名单、sessionRecordToWorkspaceMeta、buildChildRuntimeAgent、agent-connected 手工 child 条目、agent-discovery 活跃 Session 元数据。目录字段用于文件环境，项目身份用于归组。
3. 补搜索索引条目与结果归属，既有 search-index 缓存不能导致项目被误归目录。优先从 Session 元数据补归属，避免为新增字段全量重扫历史正文；必须重建派生缓存时说明范围，不称其为历史会话迁移。
4. open-sessions-tracker 恢复卡片从 Session 索引补项目身份，原目录条目不强制改写或补字段；恢复不能改变对话归属。
5. 审计所有“按目录取会话”的旧集合消费，尤其 dispatch adapter 的 extractProjectId/list/latest、群聊目录候选、workspace.js 从历史补目录以及 server.js 的目录删除。只加归属隔离，不给这些外围提供项目列表或项目创建。
6. 项目会话缺少项目元数据时明确呈现异常，不推断为目录。公共远程字段保持身份透传，不把远端项目当本地目录组；不增加远程项目管理协议，不借本票升级远程传输。远程项目 UI 不得落入本地目录操作。
7. 外部“展示所有会话”与“某目录的会话”分开处理，不能为隔离而让全局审计历史丢记录。

## 主要入口

`session-helpers.js`、`session-helpers-pure.js`、`session-search-index.js`、`agent-connected.js`、`agent-discovery.js`、`workspace.js`、`server.js`、`open-sessions-tracker.js`。隔离消费方包括 `dispatch.js`/`dispatch-engine.js`、group-chat session-resolver 及远程 catalog/embedded 投影；不是全面重写这些模块。

## 验收

- D/A/B 同目录：每个过滤条件只返回本集合，分页计数和搜索一致。
- 旧调度 latest 与群聊目录候选不选中 A/B；原目录删除不删除 A/B 索引或正文。
- 删除/归档 A 内 Session 不回选 D 或 B；恢复卡片归属不漂移。
- 真实 connected-agents 输出驱动前端投影，D/A/B 三组分开；同时覆盖创建响应乐观 child 与后续轮询 child。
- 旧无 projectId 记录与旧搜索缓存仍可正常查询，不重写历史正文；全工作空间总览可以发现三类会话。

## 边界

不重写调度持久化目录 ID，不新增 CLI/群聊项目参数，不给目录添加项目消歧规则，不迁移 open-sessions 或 search-index 为业务权威。不改旧目录 normalize 的 ID 生成规则。
