# 编程小助手：目录对话与项目对话并存

状态：041–047 全部实施并完成验收（047 记录见 [工单](047-ph-project-coexistence-acceptance.md)）。

## 目标与范围

保留编程小助手现有的目录对话，新增由用户显式创建的独立项目。两种对话长期并存，归属互斥；不是旧格式向新格式的迁移。只在编程小助手新增项目使用路径，不推动其他工作空间或外围功能项目化。

- 目录对话直接归属目录，目录入口与目录级 Feature 配置继续有效。
- 项目对话归属独立项目，工作目录来自项目；多个项目可以绑定同一目录。
- 同目录的目录对话、项目 A、项目 B 是三个独立对话集合，但共享真实工作文件，不提供文件隔离。
- 项目可绑定外部目录；不指定时在 Claw 用户数据根下按项目 ID 分配专属工作目录。
- 工作空间保留原页面结构，左侧目录选择器确定工作位置，右侧项目选择器确定对话归属。目录菜单可二级展开，直接选择默认目录集合或该目录下的项目；点击目录本身进入默认集合，不恢复上次项目。
- 右侧始终提供“默认（目录对话）”与当前目录的项目。新建项目默认绑定当前目录，只需名称；其他目录与新托管目录作为显式选项。创建不自动建立对话或移动历史。
- 对话支持单条或批量“移动到”：同目录默认集合与项目之间、项目之间双向正式转移。只接受空闲且无排队输入的会话；保留 ID、历史、绑定 Agent 和工作文件，后续运行使用目标归属配置。执行中拒绝，不打断、不排队；跨目录转移不在范围内。
- 不批量转换历史会话、目录配置、调度引用或当前目录；不移动聊天正文或工作文件。
- ACP、CLI、桌面右键、调度、群聊等现有入口继续原逻辑，不新增项目选择、目录到项目的匹配或歧义报错。Coder 不纳入项目隔离。
- 项目内的新建、保存、恢复、分支、trim/summary 接续必须完整保留归属。线程化及旧会话转项目不在本批。

## 归属契约

以下字段与路径是本批实施约定，不是现有格式的描述。041 落实细节时如需更名，应同步修改所有后续工单的契约，不得由各票各创一套。

| 对象 | 约定 |
|---|---|
| 项目表 | `workspaces/programming-helper/projects.json`，包含 schemaVersion 与项目集合；缺文件表示尚无独立项目，不从目录历史自动生成 |
| 项目记录 | 字段定稿（041）：`id`（`prj_` 前缀 + 12 位十六进制随机；名称/目录不参与 ID 生成）、`name`、`workDirectory`、`directorySource`（`external`/`managed`，托管资产判定唯一依据，不按路径推断）、`archived`、`archivedAt`、`createdAt`、`updatedAt`；改名、改绑不改 ID |
| 项目管理 API | 定稿（041，仅 PH agentId）：`GET /protoclaw/ph_project/projects`（list）、`GET /protoclaw/ph_project/project?projectId=`（get）、`POST /protoclaw/ph_project/project_create`、`POST /protoclaw/ph_project/project_rename`；归档/改绑/删除端点由 046 定稿，不得提前提供 |
| 托管目录 | 数据根 `ph-projects/<projectId>/`，按项目 ID 分配；与会话存储（workspaces/programming-helper/sessions）分离，互不嵌套 |
| 目录会话 | 不带非空 `projectId`；继续按现有 `openDirectory` 归属 |
| 项目会话 | 索引明确保存非空 `projectId`；`openDirectory` 可以是创建时目录记录，但不是运行目录权威 |
| 当前浏览对象 | 前端明确区分 directory/project 及对应目录或项目 ID；不把项目路径写成旧 `phProjects` 条目。已有目录选择状态保持其原含义 |
| 配置层 | 目录链：全局 → 工作空间 → 目录 → 会话注入；项目链：全局 → 工作空间 → 项目 → 会话注入。两链不叠加 |
| 项目配置文件 | 位于 PH 的 feature-config 目录，以项目 ID 寻址；旧 dir 文件不迁移、不改写 |
| 侧栏组键 | 目录使用原目录身份；项目使用独立项目身份，并包含既有宿主寻址维度；显示名称不参与身份比较 |

明确提供的 `projectId` 无效、丢失或无法解析时应报错，不得退回目录对话。原入口未提供项目身份时继续目录语义，不根据同路径项目或页面焦点自动归属。来源会话的派生操作继承来源归属，不能被当前选择覆盖。

“外围不接项目”不等于公共目录查询可以收进项目会话：旧目录列表、调度的目录 latest、群聊目录候选及目录删除必须排除项目会话。允许在共享查询处增加归属隔离；不因此给外围增加项目能力。全工作空间审计/历史总览可以展示两类，但必须保留归属，不能误作目录集合。

## 运行与项目管理

- 运行目录由目标 Session 归属决定，不由工作空间当前选项决定。项目对话解析项目当前目录；目录对话保留现有解析方式。
- 共享进程内每个 Session 有独立 SessionLifecycle/Agent，配置按实例构造。传递项目身份到每个实例，不使用进程级项目配置缓存；不为配置隔离强制修改现有进程模式，不关闭 shared-global 的项目配置。
- 项目改绑沿用已确认规则：项目无执行中轮次时才能改绑；保存相关空闲会话并使其旧运行实例失效，后续输入前按新目录重新装配。不得杀掉共享进程中其他目录或项目的会话，不自动移动工作文件。
- 日常管理提供项目归档/恢复。永久删除明确列出会话、配置及托管目录的删除范围；外部目录始终保留。删除一个项目不得按目录批量删除其他归属的对话。
- 项目操作不经过目录项目清单的 docset 同步，不往外部目录投影项目清单；现有目录链路及悬置工作空间 docset 逻辑保持不变。
- Git 等文件视图使用实际工作目录；gitDefaultRepos 保持目录键，无须人为按项目复制文件环境偏好。

## 已核对的实现入口

- 目录身份与状态：`server/routes/workspace-projects.js`、`workspace.js`、`server.js` 的 ph_project 路由。旧 normalize/upsert 仍是目录专属，不能拿来保存独立项目。
- 会话：`session-helpers.js`、`session.js`、`session-handoff-helpers.js`、`server/shared/session-access.js`。激活会话目前会把目录写回 state；项目分支不能借此改变旧目录选择。
- 运行时：`agent-startup.js`、`scripts/run-prebuilt-agent.js`、`mirror-runtime.js`、`run-one-shot-agent.js`。启动时已经存活的 runtime 会复用，改绑必须处理实例失效，不能只改下次启动的解析函数。
- 配置：`feature-config-layers.js`、服务端 `feature-config.js`、`feature-mount.js`、PH `agent.js`。项目层需读写双向接通，$mount 仍只限既有允许层，不开放项目装配。
- 投影：`session-helpers-pure.js` 的轻记录/wire、workspace meta、child runtime 是不同出口；还包括 `agent-connected.js`、`agent-discovery.js`、`session-search-index.js` 与 open-sessions-tracker。
- 前端：project-data、ph-project-actions、session-list-render、ph-session-list、session-ui、侧栏/runtime-status、ph-model-config、feature-config、dir-config-dialog、app-main/workspace-actions。

实现前仍须阅读对应完整函数与测试。入口清单不是授权全文件重构，也不证明所有相邻逻辑都需要改。

## 工单与执行

| 票 | 交付 |
|---|---|
| [041](041-ph-project-store-and-api.md) | 独立项目存储与基本管理端点 |
| [042](042-ph-project-session-lifecycle.md) | 会话归属、派生与运行时装配 |
| [043](043-ph-project-feature-config.md) | 项目级 Feature 配置读写与实例隔离 |
| [044](044-ph-project-projection-and-directory-isolation.md) | 列表、搜索、运行时投影及旧目录操作隔离 |
| [045](045-ph-project-selector-and-chat-ui.md) | 分组选择器、项目对话与配置 UI |
| [046](046-ph-project-rebind-and-retirement.md) | 改绑、归档与明确删除 |
| [047](047-ph-project-coexistence-acceptance.md) | 端到端回归与发布收尾 |

默认 **041 → 042 → 043 → 044 → 045 → 046 → 047 串行**。多票有公共文件交集，不安排并行。每票带定向测试，047 不承担替前票补全部测试。可以分票提交，但项目入口只在整批链路齐备后对外发布；不是最后一票自动使前面修改原子生效。

## 验证与不做项

必须同时覆盖：纯目录用户升级无需迁移；目录 D 与同目录 A/B 项目三组互斥；三份配置分别生效；共享进程按实例隔离；分支/精简保留归属与 workspaceAgentId；归档/删除不串组；运行实例已存在时改绑生效；重启恢复；旧目录外围入口照常使用且不收编项目会话。

全部用隔离用户数据目录，不读写真实用户记录；Node node:test + assert/strict，前端沿现有 VM/浏览器验证方式。真实模型验证需另行授权，未运行不得标通过。正常升级只读已有数据并按需创建新项目文件，没有历史归属迁移器或迁移版本闸。

本批不做：Thread 创建与历史链归并、跨目录会话转移、外围项目入口、远程项目创建/管理及传输升级、框架仓库改造、项目层 $mount、重写目录规范化逻辑。公共远程投影如携带项目会话，必须透传身份且不误归目录；缺项目元数据时不能伪造本地项目。远程项目交互不得借旧目录写入口执行。

历史设计 `docs/plans/workspace-project-abstraction-design.md` 与 `task-ph-project-persistence.md` 的目录能力继续有效，不整体标记取代。领域术语见 [CONTEXT.md](../../CONTEXT.md)。
