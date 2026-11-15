# ADR 0050: 工作空间条目操作面与侧栏会话条目呈现策略

日期：2026-11-15
状态：已接受（P1–P3 已实施：右键/⋯ 同源操作面与内联处理器零新增、sidebarSessions 声明/覆盖/合流/过滤全链、memo 声明与隔离实例真实界面验收；实施明细见 [workspace-entry-menu plan](../plans/2026-11-15-workspace-entry-menu-and-sidebar-sessions.md)）
关联：[ADR-0049 会话操作事实与会话菜单的应用声明面](0049-session-ops-fact-and-menu-declaration.md)（模型复用与边界解除）、[ADR-0010 侧栏统一投影](0010-sidebar-unified-projection.md)、[ADR-0024 APP 型工作空间](0024-app-workspace-eternal-thread-model.md)、[ADR-0025 coder 升格独立工作空间](0025-coder-workspace-promotion.md)（visibility 语义辨析）、[ADR-0045 外部插件包与工作空间装配](0045-external-plugin-package-and-workspace-assembly.md)

## 背景与问题

侧栏工作空间条目（左侧列表最外层的 APP 条目）没有右键菜单。这是历史门控被应用化进程整体关闭的结果：`sidebar-render.js` 的 `contextMenuEnabled = !workspaceSurface && hasRuntime` 写于 prebuilt 条目还是 agent 形态的年代，随着全体官方 APP 声明 `kind: "workspace"`，门控恒假，菜单静默消失。该门控早于公开发布即存在，不是有意的应用化决策。

同时，APP 型工作空间（ADR-0024，memo 是首个实体）的运行中会话条目对用户是冗余暴露：对话入口在首页（hero 恢复 / 新建），侧栏叶子呈现的是运行细节。用户没有呈现偏好可表达——想收起，无处下手。

与既有呈现概念的关系必须先划清：ADR-0025 的 `visibility`（persistent / on-demand）管** APP 条目本身**在不在侧栏；本决策管**条目在时其下会话区**显不显示。两者正交。

## 决策

### 1. 工作空间条目拥有宿主操作面，右键与 ⋯ 按钮同源

菜单合成复用 ADR-0049 的模型：**事实选族（宿主求值）+ 贡献项（APP 声明）**。

- 可用性门控改为事实驱动：菜单项非空即可用（右键与 ⋯ 按钮同一条件）。旧 `!workspaceSurface && hasRuntime` 门控对 prebuilt 分支退役。
- 静态 `agent-context-menu`（重启 / 关闭 / 删除）保留服务 child / external runtime 条目，不迁移。
- 贡献项声明面 `ui.workspaceMenu.items` 在模型上与 `ui.sessionMenu` 同构（schema、`claw:` / `plugin:` 动作绑定、边界校验同源），v1 不实施管道——无消费方不建基础设施。

### 2. 侧栏会话条目呈现策略（`sidebarSessions`）

三层模型，与 `workspaceVisibility` 覆盖层同构：

- **声明（APP 作者，metadata 顶层）**：`"sidebarSessions": "visible" | "hidden"`。声明即能力开启，值即作者默认；未声明 = 无此能力（无菜单项、会话区照常显示，现状不变）。
- **覆盖（用户，workspace-settings.json 新节）**：值为 `hidden` / `shown`，缺省条目 = 回作者默认。存储复用整文件读改写、按路径锁与原子写。
- **生效（服务端合流，投影下发）**：agent 记录新增作者默认与合流生效值两字段，随 `get_connected_agents` 投影下发。投影挑选清单为显式清单，新字段必须同步登记并配契约测试（ADR-0049 实施期间 `sessionOps` 曾在投影层断链，测试即为防它而立）。

### 3. 策略语义的边界

- **粒度 per-APP**：作用对象是该 APP 侧栏条目下的整个会话区（本地叶子、远程投影叶子、项目分组头、过渡态条目、todo pin、状态指示）。单条会话的收起由会话归档承担，职责不重叠。
- **隐藏 ≠ 关闭**：runtime 继续运行，业务状态不动；找回入口是 APP 首页（APP 型工作空间的对话恢复 / 新建事务本就在首页）。
- **策略跟 APP 走**：不跟 thread / session。换代与接续无需任何策略接力处理。
- **当前活动会话不豁免**：隐藏立即生效，主视图停留不受影响。
- **过滤在呈现层**：过滤点在侧栏会话区渲染入口，不在数据源。child 条目是多消费方数据（runtime 启动探测、会话切换解析都读它），在数据源过滤会误伤这些路径。
- **远程叶子**：本地覆盖统一作用于挂在该 APP 下的远程投影叶子（呈现层过滤与来源无关）；远程主机自身的策略不投影、不协商。

### 4. 菜单项由事实选族派生，项的内容不进本 ADR

呈现策略的切换项由 `sidebarSessions` 事实选中、宿主生成，动作走 `claw:` 前缀内建分发。具体菜单项清单、文案、各 APP 的默认值属于产品层设计，由实施计划承载（ADR 只定机制，不定菜单内容——与 0049 的分工口径一致）。

## 不做清单（显式边界）

- 不做 per-session / per-thread 粒度的呈现策略。
- v1 不实施 `ui.workspaceMenu.items` 贡献项管道（模型位置保留，待真实需求出现再启动，对齐 ADR-0049 P3 的后置纪律）。
- 不做当前活动会话豁免、不做「折叠成一条状态行」的中间态。
- 策略不作用 APP 首页会话列表、归档历史、主视图、搜索——只作用侧栏呈现。
- 不做远程主机策略投影与版本协商。

## 后果

正面：APP 型工作空间获得侧栏降噪开关，运行细节的暴露成为可选项；工作空间条目操作面为后续事实驱动的操作族（设置入口、生命周期等）提供统一挂点；机制与 ADR-0049 同构，除 `sidebarSessions` 声明与一个 `claw:` 动作名外无新公开面。

代价：投影挑选清单与前端渲染签名各新增一个状态接入点；侧栏渲染链的门控语义变更（prebuilt 分支）；memo 需落地声明。

风险：`sidebarSessions` 是新的公开声明契约，值域只增语义不换义；`claw:` 动作名成为 APP 可引用的协议面，按 ADR-0049 的对外契约口径管理；呈现层过滤意味着 wire 上仍会下发被隐藏的 child 条目，消费方不得绕过呈现层自行渲染侧栏会话区。
