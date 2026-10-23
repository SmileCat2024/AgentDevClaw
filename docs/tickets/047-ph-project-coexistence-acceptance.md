# 047 — 并存方案端到端回归与发布收尾

状态：已完成并归档（2026-10-23）。验收记录见文末。
仓库：AgentDevClaw。前置：[046](046-ph-project-rebind-and-retirement.md)，以及 041–045 全部交付。
共同契约：[目录对话与项目对话并存](2026-10-22-ph-project-coexistence.md)。

## 目标

证明新增项目能力完整可用，同时现有目录对话与外围功能保持原语义。本票不是一次历史数据迁移，不替前票补全部定向测试。

## 验证矩阵

| 场景 | 必须观察到的结果 |
|---|---|
| 纯目录旧用户升级并重启 | 目录状态、Session 归属、dir 配置、旧调度引用不因项目功能被批量重写；项目表为空或缺失，不自动建项目 |
| 同目录 D/A/B | 三组会话列表、搜索、运行中侧栏互斥；同名项目也不合并；文件真实共享 |
| 三份配置 | D 目录层与 A/B 项目层各自生效，项目不继承目录层；同进程与 shared-global 下也不串配置 |
| 保存、分支与 trim/summary | projectId/workspaceAgentId 继承且保存重启后仍在；目录会话仍无项目归属 |
| 运行中实例改绑 | 无执行轮次的存活实例失效，后续运行用新目录；共享进程其他成员不受影响；busy 改绑明确失败 |
| 双选择器与创建 | 目录二级菜单可直达默认集合或项目；右侧只列当前目录归属；创建默认当前目录，其他/托管目录显式选择，创建不建会话 |
| 同目录对话整理 | 默认↔项目、项目↔项目支持单条/批量移动；历史与 Agent 绑定保留，目标配置后续生效；busy/排队/跨目录明确拒绝，其他共享实例不受影响 |
| 归档、删除与回选 | A 操作不影响 D/B，外部目录保留，托管文件删除明确选择 |
| 旧外围入口 | CLI 两套目录创建入口、桌面目录打开/新建、调度目录 latest、群聊目录候选继续原逻辑，不匹配同路径项目；ACP/Coder 原测试不回归 |
| 异常资源 | 未知项目不回退目录；目录暂时不可用时项目与历史仍可见，执行明确报错 |
| 投影与重启 | 乐观响应与轮询 child 一致，恢复卡片/搜索定位回到正确归属；无全量迁移再执行 |

## 测试与记录

- node:test + assert/strict；逐文件定向测试先跑，再扩大到 test:core。遵守时长预算，不提高超时掩盖资源泄漏。
- 重点复核现有 workspace-normalize/workspace-projects、session-index-cache、session-extraction、workspace-agents/runtime、process-group、frontend-ph-project-guard、frontend-runtime-status、remote-session-history/remote-sidebar-projection 相关测试。旧目录断言原则上保留，不把它们一律改成项目 ID。
- 浏览器验证实际选择器、创建/取消、配置保存、对话导航、归档/删除确认；隔离数据与端口，不重启用户正式服务。真实模型调用不作为默认测试依赖。
- 升级无批量改写验证针对目标元数据及归属集合；不要把运行系统正常更新 updatedAt 等事实一律误判为迁移。
- `git diff --check`、相关语法/lint、`npm run check:cycles`；说明已有失败和未验证项。

## 文档与发布

1. 同步 CONTEXT.md、glossary 工程索引、AGENT.md 入口和前端渲染文档，明确两种归属都属正式模型。现有历史目录设计不整体标记废弃。
2. 更新本批工单和 README 的实际完成状态、接口/字段，以及需要整服重启与 agent 重启的范围；记录浏览器验证结果。
3. 发布说明强调：新增项目需用户主动创建，旧目录入口与历史不迁移，配置独立但工作文件不隔离；外围不支持选择项目。
4. 项目 UI 在 041–046 齐备后才正式开放。分票提交不等于版本原子切换，不发布“能建项目但保存/派生会丢归属”的中间状态。

## 不做

不运行真实用户迁移脚本，不做 Thread 化和历史链重建，不改旧调度项目 ID，不增加 ACP/CLI/桌面/群聊项目能力，不自动部署、push 或重启正式服务。若验收发现新增能力必须改变既有外围契约，停止并报告，不能顺手扩大边界。

## 验收记录（2026-10-23）

- 全量 `npm run test:core`：4976 项，0 失败、4 项跳过（套件既有跳过项）。独立复跑确认。
- 真实 Chromium 浏览器检查 `test/ph-project-browser-check.mjs`（隔离 fixture：真实 session index + 真实 `sessions_move` 路由）：PASS。覆盖双选择器渲染与同步、目录二级展开、一键切换、目录本体回默认集合、新建项目默认当前目录、批量/单条真实索引归属往返、busy 409 可读提示且索引零变化、错误 payload.error、键盘操作、重载持久化、深浅主题 × 1280/375 视口。
- 定向回归：选择器 / 移动 / 上下文菜单 / 守卫共 96 项通过（`ph-project-session-move` / `ph-session-move-runtime` / `ph-session-move-ui` / `ph-project-selector-ui` / `frontend-ctx-menu-items` / `frontend-ph-project-guard`），含释放窗口并发 gate（重叠移动 / 新输入 / 派生 / 改绑·归档·删除双向互斥）、反向竞态（生命周期事务先行时锁内 fresh 重验）、真实共享进程按目标配置重装配且兄弟会话不受影响。
- 矩阵逐行核对：升级无批量改写（workspace-normalize / workspace-projects）、同目录 D/A/B 互斥与同名不合并、三份配置不串层（含 shared-global）、保存分支 trim 继承归属、运行中实例改绑（ph-project-rebind-retirement）、归档删除不串组、旧外围入口原逻辑（CLI / 桌面 / 调度 / 群聊 / ACP / Coder 测试全绿，归属门闩在无窗口时空表短路不影响非 PH 流量）、异常资源显式失败不回退、投影与重启一致（typed target 不被轮询漂移覆盖、恢复卡片双向刷新）。
- 收尾检查：`check:cycles` 0 新增环；`git diff --check` 通过；改动 JS 语法检查通过。
- 生效范围：前端与 server 路由改动需整服重启后生效；本验收未重启正式服务、未推送。本机 Chromium 与 playwright 依赖版本不匹配时，浏览器检查经 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定本机 chromium 实体运行。
