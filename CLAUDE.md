# CLAUDE.md

本文件用于帮助新进入项目的 agent 快速建立“产品目标 -> 核心对象 -> 代码入口 -> 数据流 -> 当前边界”的连续认知，避免只看到零散页面或单个 feature 就误判项目重心。

## 先看这里

如果你刚进入项目，建议按下面顺序读：

1. 本文件
2. [docs/agentdev-claw-product-overview.md](/D:/code/AgentDevClaw/docs/agentdev-claw-product-overview.md)
3. [docs/flow-layer-design.md](/D:/code/AgentDevClaw/docs/flow-layer-design.md)
4. [docs/flow-feature-mode-dual-surface-design-plan.md](/D:/code/AgentDevClaw/docs/flow-feature-mode-dual-surface-design-plan.md)
5. [docs/dev-context-index.md](/D:/code/AgentDevClaw/docs/dev-context-index.md)

如果任务直接涉及实现，优先再看这些真实入口：

- 服务端入口：[server.js](/D:/code/AgentDevClaw/server.js)
- 前端壳层入口：[public/index.html](/D:/code/AgentDevClaw/public/index.html)
- 前端公共状态与基础能力：[public/src/app-core.js](/D:/code/AgentDevClaw/public/src/app-core.js)
- 前端 UI 与 workspace 渲染主逻辑：[public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- 前端运行与轮询主逻辑：[public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
- Flow 编辑器：[public/flow-editor.js](/D:/code/AgentDevClaw/public/flow-editor.js)
- Flow 运行时 Feature：[local-features/flow/src/index.ts](/D:/code/AgentDevClaw/local-features/flow/src/index.ts)
- Flow 工作空间预制 agent：[prebuilt-agents/official/flow-workspace/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/flow-workspace/agent.js)

## 当前项目定位

`AgentDevClaw` 当前不是单纯的“Viewer 消息调试器”，也不再只是“给几个预制 agent 做首页壳”。

它现在的主线是：

1. 继续作为 `AgentDev ViewerWorker` 的 Web 调试前端
2. 以 `flow-workspace` 为核心，承载 Agent Project 的“项目管理 / 组装 / 编排 / 运行测试”一体化工作空间

当前最重要的产品判断是：

```text
Agent Project = Persona + Enabled Features + One Orchestration Graph + Runtime Sessions
```

也就是说：

- 用户当前开发的核心对象不是单条对话，而是一个 `Agent Project`
- 一个 `Agent Project` 绑定一张唯一的 `agent-flow-graph`
- 组装页改动会真实影响运行时
- 编排页编辑的是这同一个项目的行为蓝图

## 最近一轮重心变化

最近几次提交基本都围绕 Flow 主线展开：

- `61d669c`: `flow-workspace` 工作空间界面重构并加入上传能力
- `010eb3d`: Assembly 配置与工具状态三元化增强
- `84ea450`: Feature mode 编排与节点工具 override 分层架构
- `bee92c4`: 节点提示编辑器 `/` 选择器
- `f767ee6`: 提示词编辑器增强与内置技能特性
- `c6681d3`: 配置属性扩展与系统提示词解析优化
- `3cb4d40`: Assembly 启动性能优化与缓存
- `bc757da`: `index.html` 重构为外部 CSS / JS 壳层

因此，理解项目时应默认把 `flow-workspace` 视为当前产品主线，把 `qqbot`、`feature-creator` 等视为仍然重要但次级的预制 agent 样例。

## 启动方式

```bash
npm install
npm start
```

默认端口：

- Web UI: `http://127.0.0.1:1420`
- ViewerWorker: `http://127.0.0.1:2026`

常见环境变量：

- `PORT`: Web UI 端口，默认 `1420`
- `AGENTDEV_VIEWER_PORT`: ViewerWorker 端口，默认 `2026`
- `AGENTDEV_UDS_PATH`: ViewerWorker UDS / named pipe
- `AGENTDEV_DEBUG_TRANSPORT`: 预制 runtime 启动时使用 `viewer-worker`

## 系统总览

### 1. 服务端

入口文件：[server.js](/D:/code/AgentDevClaw/server.js)

职责：

- 启动并托管 `ViewerWorker`
- 扫描 `prebuilt-agents/`
- 管理预制 agent runtime 与会话切换
- 代理前端到 ViewerWorker 的 API / 模板 / tools / chunk 请求
- 提供 `ProtoClaw` 自己的工作空间、session、flow、assembly 管理接口

### 2. 前端壳层

壳层入口：[public/index.html](/D:/code/AgentDevClaw/public/index.html)

注意：`index.html` 现在只是瘦身后的页面壳，不再承载主要业务逻辑。主逻辑已拆到：

- [public/src/app-core.js](/D:/code/AgentDevClaw/public/src/app-core.js)
- [public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- [public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)

职责：

- 左侧 agent / workspace 列表
- 右侧主工作区、调试面板、功能面板壳层
- workspace surface 与 chat surface 的切换
- 预制 workspace block 渲染
- `flow-workspace` 的 detail / assembly / orchestrate 前端状态机

### 3. Flow 编辑器

核心文件：

- [public/flow-editor.js](/D:/code/AgentDevClaw/public/flow-editor.js)
- [public/flow-editor.css](/D:/code/AgentDevClaw/public/flow-editor.css)

职责：

- 编排图加载、保存、视图管理
- 工作流与节点 Inspector
- 节点工具权限编辑
- onEnter / exitWhen / 变量 / prompt 编辑
- Feature tools / variables / templates 能力消费

### 4. 预制 agent runtime

入口文件：[scripts/run-prebuilt-agent.js](/D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js)

职责：

- 动态加载 `prebuilt-agents/*/*/agent.js`
- 挂到本地 ViewerWorker
- 管理预制 agent 会话恢复
- 针对部分 agent 处理附加启动逻辑，例如 QQ gateway

### 5. 项目内本地 Feature

目录：[local-features](/D:/code/AgentDevClaw/local-features)

当前最重要的不是泛泛的“本地 TS Feature 支持”，而是：

- [local-features/flow/src/index.ts](/D:/code/AgentDevClaw/local-features/flow/src/index.ts) 是当前 Flow 运行时核心
- [local-features/feature-dev/src/index.ts](/D:/code/AgentDevClaw/local-features/feature-dev/src/index.ts) 服务于 `feature-creator`

构建命令：

```bash
npm run build:local-features
```

## 当前主对象模型

### Agent Project

当前主对象是 Agent Project，而不是单条消息流。

典型字段包括：

- `assembly_name`
- `target_user`
- `goal`
- `constraints`
- `custom_system_prompt`
- `selected_features`
- `env_dir`
- 唯一绑定的 `agent-flow-graph`
- 该项目的测试运行会话

这些字段主要通过 `flow-workspace` 的 `assembly-form` 管理。

关键位置：

- 前端草稿与 UI：[public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- 提交、启动与会话处理：[public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
- runtime 读取：[prebuilt-agents/official/flow-workspace/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/flow-workspace/agent.js)

### Orchestration Graph

每个 Agent Project 绑定唯一一张图：

```text
~/.agentdev/AgentDevClaw/flows/<agentProjectId>/agent-flow-graph.json
```

当前 `<agentProjectId>` 主要来自 `assembly-form.assembly_name`。

图包含：

- `nodes`
- `edges`
- `workflows`
- `variables`
- `viewport`

### Workflow

Workflow 不是外部独立对象，而是图中的一个连通分量。

每个 Workflow 典型元数据包括：

- `id`
- `name`
- `description`
- `mode`: `auto` 或 `agent-initiated`
- `entry`
- `reminderFrequency`
- `variables`

一张图中最多只有一个 `auto` Workflow。

### Node

Node 是阶段上下文，当前支持的关键能力包括：

- `prompt`
- `tools.rules`
- `onEnter`
- `exitWhen`
- `reminderFrequency`
- `workflowId`
- `position`

当前产品方向上，Node 正在从“直接配底层工具”进一步走向“Feature mode + 高级 override”双层控制面。

## 当前产品主线：flow-workspace

### 为什么它是主线

`flow-workspace` 已经不只是一个预制 agent 首页，而是当前产品的一体化工作空间宿主。

定义位于：

- [prebuilt-agents/official/flow-workspace/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/flow-workspace/metadata.json)
- [prebuilt-agents/official/flow-workspace/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/flow-workspace/agent.js)

它当前承载：

- 项目列表
- 项目详情
- 组装编辑
- Feature 选择
- 运行环境目录管理
- 编排图编辑
- 装配会话恢复与运行测试

### 当前前端实现形态

`flow-workspace` 前端不是简单 block 列表，而是“通用壳 + 专项状态机”的混合架构：

- 通用 block 与 workspace 渲染：主要在 [public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- 运行与提交逻辑：主要在 [public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
- 专项前端状态机：`window.ClawFW`
- 编排页专项编辑器：[public/flow-editor.js](/D:/code/AgentDevClaw/public/flow-editor.js)

`ClawFW` 管理的典型状态：

- 项目列表 / 详情
- 当前 section：`features` / `config` / `orchestrate`
- prompt editor
- drift dialog
- feature capabilities cache

### 当前 runtime 形态

`flow-workspace` 有两种主要运行形态：

1. 工作空间模式：展示项目、组装与编排 UI
2. 装配会话模式：真实挂载用户选择的 Features + 当前项目配套编排图，进入调试对话

`agent.js` 里已经会：

- 读取当前 `assembly-form`
- 解析 `selected_features`
- 构造或刷新运行环境
- 加载当前项目的 `agent-flow-graph`
- 把图转换成运行时 flows
- 挂载 `FlowFeature`

## Flow 运行时

### 核心文件

- [local-features/flow/src/index.ts](/D:/code/AgentDevClaw/local-features/flow/src/index.ts)

### 当前定位

`FlowFeature` 是当前编排层运行时核心，不修改 AgentDev 主循环，而是通过 hook 驱动阶段行为。

关键能力：

- `@CallStart`
  - 缓存 agent / ToolRegistry
  - 收集变量
  - 自动激活 `auto` Workflow
  - 注入 Flow 状态
- `@StepStart`
  - 处理 pending transition
  - 处理 `exitWhen`
  - 执行 `onEnter`
  - 注入节点 prompt
  - 应用节点工具权限
- tools
  - `enter_flow`
  - `complete_node`
  - `exit_flow`
- state snapshot
  - 保存 / 恢复活跃 workflow、node、工具基线等状态

### ToolRegistry 关键事实

当前已验证：Flow 工具权限要从 `ctx.agent.tools` 拿 `ToolRegistry`，不能只假设存在 `getToolRegistry()`。

这点是历史上真实踩过坑的地方，后续如果再改 Flow runtime，务必先确认这一层没有退化。

## Feature 与 Flow 的当前关系

### 当前已落地

当前 `flow_capabilities` 已经能从当前项目启用的 Feature 中收集：

- features
- tools
- variables
- node templates

服务端接口：

- `GET /protoclaw/flow_capabilities?agentId=...`

相关聚合逻辑在 [server.js](/D:/code/AgentDevClaw/server.js)。

### 当前演进方向

下一阶段的重要方向不是继续把所有复杂度都暴露成底层 tools，而是：

- 默认主路径：Feature mode 编排
- 高级层：显式展开的 tool overrides

设计文档见：

- [docs/flow-feature-mode-dual-surface-design-plan.md](/D:/code/AgentDevClaw/docs/flow-feature-mode-dual-surface-design-plan.md)

当前代码已经开始朝这个方向前进，但尚未完全落地，因此写实现时不要默认“文档中的 mode contract 已全部完成”。

## 关键数据流

### 1. Agent Project -> 运行时装配

主链路：

1. 用户在 `flow-workspace` 编辑 `assembly-form`
2. 前端草稿保存在 workspace draft / state
3. 启动或恢复装配会话时，前端把配置提交给服务端
4. 服务端确保 `env_dir`、会话索引与持久状态一致
5. `flow-workspace` runtime 读取 `assembly-form`
6. 根据 `selected_features` 实例化 Feature
7. 读取图并挂载 `FlowFeature`
8. 进入调试对话

关键字段：

- `selected_features`
- `custom_system_prompt`
- `assembly_name`
- `env_dir`

### 2. Agent Project -> Flow 编辑器

主链路：

1. 前端进入 `orchestrate`
2. `flow-editor.js` 根据当前 `assembly-form` 解析 projectId
3. 请求 `GET /protoclaw/flow_graphs?agentId=<projectId>`
4. 请求 `GET /protoclaw/flow_capabilities?agentId=flow-workspace` 获取已启用 Feature 的能力
5. 在编辑器中渲染 workflows / nodes / inspector
6. 保存时通过 `PUT /protoclaw/flow_graph/<graphId>` 回写

### 3. Feature 能力 -> 编排可见性

主链路：

1. 组装页修改 `selected_features`
2. 服务端聚合当前项目可用 Feature 能力
3. Flow 编辑器消费 capabilities
4. 用户在 Inspector 中选择 tools / variables / templates

因此，如果你看到“编辑器里能力不对”，首先要检查的不是 UI，而是：

- 当前项目的 `selected_features`
- `flow_capabilities` 返回是否正确
- 运行环境是否真的装上了对应 Feature

## 前端结构现状

### index.html 已经瘦身

`[public/index.html](/D:/code/AgentDevClaw/public/index.html)` 现在主要只保留：

- HTML 壳
- 第三方资源引用
- `flow-editor.js`
- `app-core.js`
- `app-ui.js`
- `app-main.js`

不要再把它当成主要业务脚本文件。

### 三个前端脚本的大致分工

- [public/src/app-core.js](/D:/code/AgentDevClaw/public/src/app-core.js)
  - 基础常量、i18n、fetch/invoke、公共 DOM 引用、初始化底座
- [public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
  - workspace surface 渲染
  - block 渲染
  - `flow-workspace` 的大量 UI 逻辑
  - `renderCurrentMainView()`、`renderWorkspaceSurface()` 等核心入口
- [public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
  - agent 加载
  - 轮询
  - session / runtime 切换
  - assembly 启动、恢复、提交、环境处理

### 一个重要经验

`renderCurrentMainView()` 是主视图状态机入口，很多 workspace 问题最终都会回到这里。

但像 Flow 编辑器这种重交互区域，不能简单把所有问题都归结为外层渲染；要先分清楚问题来自：

- 壳层 workspace 替换
- `flow-editor.js` 自己的局部重绘

这是最近真实修过的一类问题。

## 预制 agent 与 workspace 首页模型

预制 agent 的 `metadata.json` 仍然支持 `ui` 声明和 block 渲染，这条线没有消失。

仍然常见的 block / 入口概念包括：

- `ui.entry`
- `ui.tabs`
- `ui.home.blocks`

但要注意主次：

- 这套机制仍是基础壳能力
- 它已经不是最值得优先理解的产品主线
- 当前复杂工作主要集中在 `flow-workspace`

## 预制 agent 会话模型

### 当前实现

预制 agent 会话当前采用多 session 模型：

- 新对话创建新 session
- 可以恢复历史 session
- 当前激活 session 由服务端显式维护
- 会话切换会等待目标 runtime `READY`

### 存储位置

预制 agent 会话数据位于用户目录：

```text
%USERPROFILE%\.agentdev\AgentDevClaw\prebuilt-sessions\<agentId>
```

Flow 工作空间自己的 workspace / session / flow 数据也优先落在用户目录下，不污染仓库。

## 仍然重要的次级样例

### QQBot

定义位于：

- [prebuilt-agents/official/qqbot/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/metadata.json)
- [prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)

它仍然是“经典预制 agent workspace 样例”：

- `home/chat` 双 tab
- `hero + config + session-list`
- 项目级配置写回 [.agentdev/qqbot.config.json](/D:/code/AgentDevClaw/.agentdev/qqbot.config.json)

但不要把它再当成全项目的主叙事中心。

### Feature Creator

定义位于：

- [prebuilt-agents/official/feature-creator/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/feature-creator/agent.js)
- [local-features/feature-dev/src/index.ts](/D:/code/AgentDevClaw/local-features/feature-dev/src/index.ts)

它仍然是本地 Feature 驱动 workspace 的代表性样例，尤其适合理解：

- workspace state 注入 prompt
- `cwd` 与工作目录绑定
- 本地 skills / local feature 的协作方式

## 关键 ProtoClaw 接口

基础接口：

- `GET /protoclaw/health`
- `GET /protoclaw/get_prebuilt_agents`
- `GET /protoclaw/get_agents_status`
- `GET /protoclaw/get_connected_agents`
- `POST /protoclaw/start_agent`
- `POST /protoclaw/stop_agent`

预制 session 相关：

- `GET /protoclaw/prebuilt_sessions?agentId=...`
- `POST /protoclaw/prebuilt_sessions`
- `POST /protoclaw/prebuilt_sessions/activate`

Flow / workspace 主线相关：

- `GET /protoclaw/flow_graphs`
- `PUT /protoclaw/flow_graph/:id`
- `GET /protoclaw/flow_capabilities`

QQBot 配置相关：

- `GET /protoclaw/qqbot_config`
- `PUT /protoclaw/qqbot_config`

如果任务涉及编排能力、Feature 列表、运行环境或项目恢复，优先先看 `flow_*` 和 assembly 相关链路，不要只盯基础 agent 接口。

## 资源与依赖

### AgentDev 依赖

当前依赖本地 AgentDev 仓库：

`agentdev: file:../AgentDev`

这意味着：

- 当前项目默认与本地 `D:\code\AgentDev` 联动开发
- 修改框架后常常需要重新安装 / 重启当前项目
- 任何“这是 Claw 问题还是 AgentDev 问题”的判断，都要考虑两个仓库一起看

### Feature 包资源

内置 feature 包目录：

- [resources/features](/D:/code/AgentDevClaw/resources/features)

它们既是产品资源，也是 `flow-workspace` 当前装配路径的重要输入。

## 当前已知边界

这些边界不是遗漏，而是当前阶段的真实状态：

- `flow-workspace` 是核心工作空间，但还不是完整的多 runtime workspace 编排器
- 一张图里虽然可以有多个 Workflow，但当前运行时核心仍围绕单活跃 workflow 状态管理
- Feature mode 双层控制面是明确方向，但不是所有 contract 都已落地
- `onEnter` 目前仍有 tool-call 兼容语义，尚未完全升级为正式 workflow functions
- block 壳层仍存在，但主复杂度已转移到 Flow 主线

## 开发时的建议心智

进入实际开发前，优先先回答这 6 个问题：

1. 这次改的是壳层、`flow-workspace`、`flow-editor`，还是 `FlowFeature` runtime？
2. 问题属于项目配置、运行时装配、编排图数据、还是调试 UI？
3. 当前数据的真相在前端草稿、服务端 workspace state、session index，还是 `agent-flow-graph.json`？
4. 当前能力来自静态 block、`ClawFW` 前端状态机，还是 `flow_capabilities` 动态聚合？
5. 当前行为是预制 agent 首页行为，还是装配运行时行为？
6. 这是当前已实现能力的 bug，还是文档中“下一阶段设计”尚未落地导致的预期偏差？

把这 6 个问题先想清楚，通常就能避免在错误层面下手。

## 跨项目上下文索引

[docs/dev-context-index.md](/D:/code/AgentDevClaw/docs/dev-context-index.md) 记录了 AgentDev 框架与 AgentDevClaw 产品之间的关键连接关系、文件速查表、核心数据流和已知改进方向。需要跨仓库联动排查时，优先阅读它。
