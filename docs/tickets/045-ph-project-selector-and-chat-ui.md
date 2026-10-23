# 045 — 分组选择器、项目对话与配置 UI

状态：已实施并完成定向验收；整批端到端验收见 [047](047-ph-project-coexistence-acceptance.md)。
仓库：AgentDevClaw。前置：[044](044-ph-project-projection-and-directory-isolation.md)。
共同契约：[目录对话与项目对话并存](2026-10-22-ph-project-coexistence.md)。

## 目标

沿用智能编码空间现有选择器，分目录与项目两组；旧目录操作不增加步骤，项目路径显式使用稳定项目身份，创建到配置的链路完整可用。

## 实施

1. “打开目录”继续原行为；新增“新建项目”，填写名称并可指定目录，未指定由服务端分配托管目录。创建项目本身不创建会话。
2. selector 使用带类型的当前浏览目标；目录按旧目录身份，项目按项目 ID。当前目标持久化沿既有本地 UI 模式，不能由轮询的 workspace 当前目录覆盖项目选择。没有显式选择项目的桌面/目录入口继续目录模式。
3. 项目新对话显式传 projectId；现有 workspaceAgentId 选择保持。项目列表读取项目过滤，不以项目目录调用旧目录过滤；空项目可见。打开历史、分支、精简后仍留正确归属。
4. 配置按钮：目录打开原 dir scope；项目打开 project scope，并显示项目名与实际目录。配置继承状态复用现有三态编辑器。ph-model-config/feature-config 等不能再用目录相等确定当前项目。
5. 历史列表、搜索定位、侧栏运行中组、乐观 upsert、恢复卡片按完整归属投影；projectKey 不用名称或目录代替独立项目 ID。已有目录组及其折叠态不必重置。
6. Git 与文件操作仍用会话的有效工作目录，不能把项目 ID 当路径，也不能取错误页面的 workspace 当前目录。项目新路径不调用旧目录 docset 同步或旧目录项目删除。
7. 使用现有前端状态封装，不在 app-core 全局状态区加散落变量；跨模块确需共享时用 ClawFW。未知/元数据加载中不退回另一个项目；异步 stale check 遵守 currentRuntimeAgentId 规则。

## 主要入口

`project-data.js`、`ph-project-actions.js`、`session-list-render.js`、`ph-session-list.js`、`session-ui.js`、`app-main.js`、`workspace-actions.js`；侧栏/render/runtime-status；`ph-model-config.js`、前端 `feature-config.js`、`dir-config-dialog.js`、`feature-config-editor.js`；搜索定位、Git 与恢复卡片按实际调用补齐。

改前必读 `docs/reference/frontend-rendering-patterns.md`、`design-system.md`，复用已有选择器、表单和弹窗配方。管理动作的改绑/归档/删除在 046 接入，不能临时连到目录删除端点。

## 验收

- 纯目录用户操作与现有版本一致；同目录 D/A/B 可明确选择且列表不串。
- 新建托管/外部项目、取消创建、空项目新对话、名称相同但 ID 不同的项目均正确。
- 快速切换 A/B、选择项目后轮询、打开其他目录 Session 后再返回，目标不被异步状态错误覆盖。
- A 项目内分支、精简、重启恢复、内容搜索定位保留归属；配置编辑保存命中 A 文件。
- VM 测试和浏览器验证覆盖目录/项目两组、窄屏、深浅主题，记录未验证项，不连接真实用户会话或模型。

## 边界

不改 CLI、ACP、桌面参数协议、群聊和调度 UI 为项目入口。不因同路径有项目给“打开目录”弹项目选择。不整体重写前端导航、选择器或侧栏系统。
