# 045 — 分组选择器、项目对话与配置 UI

状态：已实施并完成定向验收；整批端到端验收见 [047](047-ph-project-coexistence-acceptance.md)。
仓库：AgentDevClaw。前置：[044](044-ph-project-projection-and-directory-isolation.md)。
共同契约：[目录对话与项目对话并存](2026-10-22-ph-project-coexistence.md)。

## 目标

保留智能编码空间页面布局，以目录与项目两个选择器表达工作位置和对话归属；目录二级展开可直达项目，项目路径显式使用稳定身份，创建到配置的链路完整可用。

## 实施

1. “打开目录”继续原行为；“新建项目”默认绑定当前目录，只需名称，其他目录或新托管目录需显式选择。创建项目本身不创建会话，不移动已有对话。
2. 目录与项目双选择器共用带类型的当前浏览目标；目录按旧目录身份，项目按项目 ID。目录菜单可二级展开默认集合与项目；点击目录本身进入默认集合，右侧只显示当前目录的默认项与项目。当前目标持久化沿既有本地 UI 模式，不能由轮询的 workspace 当前目录覆盖项目选择。没有显式选择项目的桌面/目录入口继续目录模式。
3. 项目新对话显式传 projectId；现有 workspaceAgentId 选择保持。项目列表读取项目过滤，不以项目目录调用旧目录过滤；空项目可见。打开历史、分支、精简后仍留正确归属。
4. 配置按钮：目录打开原 dir scope；项目打开 project scope，并显示项目名与实际目录。配置继承状态复用现有三态编辑器。ph-model-config/feature-config 等不能再用目录相等确定当前项目。
5. 历史列表、搜索定位、侧栏运行中组、乐观 upsert、恢复卡片按完整归属投影；projectKey 不用名称或目录代替独立项目 ID。已有目录组及其折叠态不必重置。
6. Git 与文件操作仍用会话的有效工作目录，不能把项目 ID 当路径，也不能取错误页面的 workspace 当前目录。项目新路径不调用旧目录 docset 同步或旧目录项目删除。
7. 使用现有前端状态封装，不在 app-core 全局状态区加散落变量；跨模块确需共享时用 ClawFW。未知/元数据加载中不退回另一个项目；异步 stale check 遵守 currentRuntimeAgentId 规则。
8. 对话整理入口（本地 PH only）：条目 ⋯ 菜单「移动到…」单条（归属从会话记录冻结解析，不取页面焦点）；列表工具条「多选」批量。移动弹窗只列同目录目标（目录默认 ↔ 项目 ↔ 项目），当前归属禁用，跨目录不支持；busy 409（ph_sessions_busy，经失败序列化后位于 legacyCode）可读提示且不假成功，其余错误呈现 payload.error。多选状态绑定 workspace + 浏览目标 + 当前切片，渲染期和解清理；异步成功后若浏览目标已切换不重拉不覆盖。实现见 `ph-session-move.js`。

## 主要入口

`project-data.js`、`ph-project-actions.js`、`ph-session-move.js`（会话移动）、`session-list-render.js`、`ph-session-list.js`、`ctx-menu-items.js`（移动菜单项分发）、`session-ui.js`、`app-main.js`、`workspace-actions.js`；侧栏/render/runtime-status；`ph-model-config.js`、前端 `feature-config.js`、`dir-config-dialog.js`、`feature-config-editor.js`；搜索定位、Git 与恢复卡片按实际调用补齐。

改前必读 `docs/reference/frontend-rendering-patterns.md`、`design-system.md`，复用已有选择器、表单和弹窗配方。管理动作的改绑/归档/删除在 046 接入，不能临时连到目录删除端点。

## 验收

- 纯目录用户操作与现有版本一致；同目录 D/A/B 可明确选择且列表不串。
- 新建托管/外部项目、取消创建、空项目新对话、名称相同但 ID 不同的项目均正确。
- 快速切换 A/B、选择项目后轮询、打开其他目录 Session 后再返回，目标不被异步状态错误覆盖。
- A 项目内分支、精简、重启恢复、内容搜索定位保留归属；配置编辑保存命中 A 文件。
- VM 测试和浏览器验证覆盖目录/项目两组、窄屏、深浅主题，记录未验证项，不连接真实用户会话或模型。

## 边界

不改 CLI、ACP、桌面参数协议、群聊和调度 UI 为项目入口。不因同路径有项目给“打开目录”弹项目选择。不整体重写前端导航、选择器或侧栏系统。
