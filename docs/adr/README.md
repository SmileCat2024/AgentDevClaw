# ADR 索引 — 架构决策记录

架构决策记录（ADR）沉淀"为什么这样设计"与关键取舍。改动相关领域前先读对应篇，避免与既定决策冲突。决策内容、修订记录与实施进展以**各篇正文为唯一权威**，本索引只维护领域定位与状态速查。

状态约定：未标注 = 已接受并实施（当前代码的权威依据）；例外才标注——**Proposed**（已决策、未实施或未完全实施，不能据此假设代码现状）、**Archived**（已退役）、**实施中**（Proposed 但主体已在落地）。

维护约定：新增 ADR 时登记到对应分组，一句话领域即可；不要把修订内容或实施细节复制进索引。

## 会话与连续性

- [0002 Session Continuity as Transformation](0002-session-continuity-as-transformation.md) — 会话接续 = 快照变换的框架化原则（Session / Transformation / WorkThread 三层）
- [0013 消息轮询的增量探测](0013-message-poll-probe-tail.md) — probe + tail
- [0014 会话导航事务](0014-session-navigation-transaction.md) — 导航生命周期的统一封装（Proposed）
- [0019 轮次挂起语义](0019-turn-suspension-semantics.md) — suspended 与 pending-work 事实层
- [0021 状态机统一内核 state-kernel](0021-state-machine-unified-kernel.md) — 框架 core 纯函数转换求值器（Proposed）
- [0023 工具调用历史改写](0023-tool-call-history-rewrite.md) — 工具自声明生效调用、框架零语义判断、双视图与单轨快照
- [0026 Session 视图统一](0026-session-view-identity-and-data-sources.md) — Session 身份为锚，Runtime 为运行态数据源，Thread 为连续性与输入控制投影
- [0032 编程小助手线程驱动](0032-programming-helper-thread-driven.md) — 对话身份从 Session 提升为 Thread，目录/项目对话一并覆盖
- [0033 会话崩溃恢复](0033-session-journal-persistence.md) — journal 为唯一权威 + checkpoint 回退（Proposed）
- [0035 正常输入与输入租约解耦](0035-input-channel-decoupling.md) — composer 单一 user-turn 通道，lease 专职请求应答（Proposed）
- [0036 会话索引存储迁移 SQLite](0036-session-index-sqlite-storage.md) — node:sqlite 替换 index.json 单文件（Proposed，实施中）
- [0039 归档对话只读浏览](0039-archived-session-readonly-browsing.md) — 启动与浏览分离，只读浏览唯一实现与视图冻结
- [0040 上下文守卫三态与过界自动接续](0040-context-guard-tri-state-auto-rotation.md) — badge 三态 + coder 同构接力链路复用，关闭 0032 预留条目
- [0041 标题属于 Session，生成策略属于应用](0041-title-generation-as-app-capability.md) — 标题状态结构化、OS 提供能力与应用自持策略、接续继承去前缀（Accepted）
- [0042 IM 渠道线程化](0042-im-channel-thread-binding.md) — 线路绑定与接线员均线程化，平台连接归门户，轮次结果事件回流（Proposed）

## 运行时与执行环境

- [0005 工具终止语义](0005-tool-termination-as-result.md) — 中断即结果
- [0009 模型热切换框架 API](0009-model-hotswap-framework-api.md) — 资产归应用层，状态由 agent 自持
- [0024 APP 型工作空间](0024-app-workspace-eternal-thread-model.md) — 业务单对话、WorkThread 可选连续性与接续硬切换视图（memo 是首个实体）
- [0025 coder 升格独立工作空间](0025-coder-workspace-promotion.md) — 无人值守编码 APP 独立化，会话身份投影机制退役
- [0029 模型调用超时治理](0029-model-call-timeout-governance.md) — 首段 / chunk idle / transform 预算三段治理与逃生门
- [0037 Runtime 执行环境统一](0037-runtime-execution-environment-unification.md) — 平台-runtime 分离，本地/容器/远程同一架构，执行后端 seam（Proposed，主体已实施、收口中）

## Feature 体系与装配

- [0007 Capability Registry 控制面](0007-capability-registry-as-control-plane.md) — 能力声明、entryPoints 契约与负面清单（bind / reactive / watch-state 永不提供）
- [0017 Feature Manifest v2 与宿主 Registry](0017-feature-manifest-and-registry.md) — 包元数据契约与宿主侧 Feature Registry
- [0018 Feature-Panel 通信基座](0018-feature-panel-communication-transport.md) — feature-comms 通道：事件 SSE 镜像 + 定向请求
- [0020 Feature 配置累加型多值字段的跨层叠加](0020-feature-config-accumulated-fields.md)
- [0022 Agent Studio Feature-First 模式](0022-agent-studio-feature-first-model.md) — feature 一级实体、目录降级为运行环境、会话多对多绑定
- [0034 模型选择 Feature 化](0034-feature-owned-model-selection.md) — Feature 持有选择与恢复策略，Agent 持有实际模型
- [0038 资源读取协议](0038-resource-fetch-protocol.md) — runtime 持有资产的跨边界只读资源面 `/res/`
- [0045 外部插件包与工作空间装配](0045-external-plugin-package-and-workspace-assembly.md) — Plugin/feature 两层、单 tgz 三面、仓库导入与工作空间装配分离、呈现配置权威（Proposed）

## 远程与外部协议

- [0004 ACP 适配器外置](0004-acp-adapter-external-stdio-process.md) — 独立 stdio 进程，只做协议转换，执行权威留在 server
- [0008 远程 Claw 连接架构](0008-remote-claw-connection-architecture.md) — 平台间远程模型（ADR-0037 后实质退役，存量冻结待处置）
- [0011 ProtoClaw 远程写适配](0011-protoclaw-remote-write-adaptation.md)
- [0012 远程会话历史统一呈现](0012-remote-session-history-unified-presentation.md)

## 前端呈现

- [0010 侧栏统一投影](0010-sidebar-unified-projection.md) — 工作空间 → 项目目录 → 运行中会话；连接不产生侧栏层级
- [0015 内嵌浏览器 viewer](0015-embedded-browser-viewer.md) — 浏览器所有权翻转（Archived，调查完成暂不实施）
- [0043 home 门户小组件契约](0043-home-portal-widgets.md) — 工作空间向首页提供只读 widget 的模块协议与隔离边界（Proposed）
- [0044 右栏面板插件化与效果归属](0044-frontend-panel-plugins-and-effect-ownership.md) — panels 进插件协议、装载/按钮/生命周期注册表派生、host.effect 撤销面（Proposed）

## 工程治理

- [0001 AgentDev 导出面治理](0001-agentdev-export-surface-governance.md) — Runtime 双类型拆分与按引用导出
- [0003 AgentDev 包结构破坏性拆分](0003-agentdev-package-split-no-umbrella.md) — 无伞包、core 零重依赖；生态 feature 唯一权威源码在 `AgentDev/packages/`
- [0006 本地显式资源寻址优先](0006-local-explicit-resource-targeting-first.md)
- [0016 用户数据存储分区治理](0016-user-data-storage-partitioning.md) — 分区约定与 feature 持久资产收敛
- [0027 Agent OS 治理面](0027-agent-os-consent-governance-and-runtime-quota.md) — 同意模型与 per-workspace 线程配额（`maxLiveThreads`）
- [0028 凭证失效恢复与分层判据](0028-credential-recovery-and-layering-criteria.md) — llm auth 错误语义、恢复编排、框架/应用分层判据（LLM 实例=参数快照）
- [0030 OS 通知投递面](0030-os-notification-delivery-and-app-adoption.md) — 统一出口、通知权限项与应用承接
- [0031 后台工作薄接入与领域 Shell](0031-background-work-and-domain-shell.md) — 执行关联、BackgroundAccess、Coder 非阻塞监视、just-bash 领域 Shell 基座
