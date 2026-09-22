# 前端拆分计划：app-ui.js 与 app-main.js 模块化

> 创建日期：2026-06-04
> 状态：**已收口**。后续由 v2（app-ui）与本仓库 app-main 专项计划接替执行，均已完成
> 最终状态：app-ui.js ~1,890 行 / app-main.js ~1,270 行 / `modules/` 下 80 个模块
> 权威后续文档：[2026-06-29-app-ui-split-plan-v2.md](/D:/code/AgentDevClaw/docs/plans/2026-06-29-app-ui-split-plan-v2.md)、[2026-07-03-app-main-split-plan.md](/D:/code/AgentDevClaw/docs/plans/2026-07-03-app-main-split-plan.md)
> 涉及文件：`public/src/app-ui.js` (9498行), `public/src/app-main.js` (6936行), `public/src/app-core.js` (1317行)
> 已完成的拆分：`public/src/modules/dispatch-ui.js`、`dispatch-actions.js`、`im-ui.js`、`im-actions.js`、`session-dialogs.js`、`feature-setup-ui.js`

---

## 一、问题诊断

### 1.1 现状数据

| 文件 | 行数 | 函数数 | window.* 赋值 | renderCurrentMainView() 调用次数 |
|------|------|--------|-----------------|-----------------------------------|
| app-core.js | 1317 | ~28 | ~2 | 0 |
| app-ui.js | 9498 | ~342 | ~64 | 定义所在 + 内部调用 ~6次 |
| app-main.js | 6936 | ~106 | ~64 | **~60次** |

脚本加载顺序（index.html）：`app-core.js → app-ui.js → app-main.js`，三者共享全局作用域，无模块化隔离。

### 1.2 核心问题

1. **单文件膨胀失控**：app-ui.js 接近 1 万行，app-main.js 超过 6 千行，任何修改都需要在巨大文件中定位目标函数
2. **全局平坦作用域**：三个文件通过 `<script>` 标签顺序加载，所有函数和变量共享全局作用域，无命名空间隔离
3. **隐式耦合严重**：大量函数通过全局变量（`allAgents`、`currentAgentId` 等）隐式通信，调用关系不透明
4. **职责边界模糊**：UI 渲染和业务操作混杂在同一文件中，同一个功能域的代码分散在多个不连续的行号范围
5. **拆分已经开始但还不均衡**：dispatch、IM、trim/branch、feature-setup 已经独立出来，但 app-ui.js 和 app-main.js 里仍有多个重块没有继续外移

---

### 1.3 当前已拆分模块

| 模块 | 行数 | 状态 | 备注 |
|------|------|------|------|
| `dispatch-ui.js` | 547 | 已完成 | dispatch 控制台 UI |
| `dispatch-actions.js` | 438 | 已完成 | dispatch 操作 |
| `im-ui.js` | 676 | 已完成 | IM 渠道管理 UI |
| `im-actions.js` | 437 | 已完成 | IM 操作 |
| `session-dialogs.js` | 355 | 已完成 | trim / branch dialog |
| `feature-setup-ui.js` | 328 | 已完成 | system feature config 页面 |

## 二、全局耦合地图

### 2.1 renderCurrentMainView() —— 全局渲染中枢

定义在 app-ui.js L6345-6442。被 app-main.js 调用约 60 次。几乎所有状态变更操作都以 `renderCurrentMainView()` 收尾：

- session 切换
- draft 更新
- assembly 操作（创建/启动/停止/删除/配置加载）
- IM 操作（渠道配置、绑定、登出）
- dispatch 操作（创建/取消调度）
- trim/branch dialog
- model config
- polling 后的消息更新

**这是整个前端最核心的紧耦合点，拆分时必须保持其函数签名和调用路径不变。**

### 2.2 共享全局状态（定义在 app-core.js）

以下变量被三个文件无差别读写，是拆分时最大的隐式依赖源：

| 状态 | 类型 | 读写频率 | 主要消费者 |
|------|------|----------|------------|
| `allAgents` | Array | 极高 | ui+main 都读写 |
| `currentAgentId` | String | 极高 | ui+main 都读写 |
| `currentRuntimeAgentId` | String | 极高 | ui+main 都读写 |
| `currentMessages` | Array | 高 | main 写入(polling)，ui 读取 |
| `currentInputRequests` | Array | 高 | main 写入，ui 读取 |
| `currentLanguage` | String | 高 | ui+main 都读 |
| `_agentCallActive` | Map | 中 | main 写，ui 读 |
| `currentOverviewSnapshot` | Object | 中 | main 写(polling)，ui 读 |
| `currentOverviewSignature` | String | 中 | polling diff |
| `currentLogs` / `currentLogsSignature` | Array/String | 中 | polling diff |
| `currentHookInspector*` | Object×3 | 中 | polling diff |
| `assemblyDraftRenderTimer` | Timer | 中 | ui+main 共用 |
| `assemblyLaunchInProgress` | Boolean | 中 | main 写，ui 读 |
| `assemblyControlPanelOpen` | Boolean | 中 | main 写，ui 读 |
| `assemblySideRailRevealTimer` | Timer | 低 | ui 内部 |
| `currentWorkspaceTab` | String | 高 | ui+main 都读写 |
| `shouldAnimateWorkspaceSurface` | Boolean | 中 | main 写，ui 读 |
| `expandedProjectIds` | Set | 低 | ui 内部 |
| `savedPhTabState` | Object | 低 | ui+main |
| `readOnlyMode` | Boolean | 低 | main 写 |
| `suppressSidebarRerender` | Boolean | 中 | main 写 |
| `loadAgentsInFlight` | Promise/null | 低 | main 内部 |
| `workspaceSurfaceModePreferences` | Object | 中 | ui 读写 |
| `FEATURE_TEMPLATE_MAP` | Object | 中 | core 定义，ui 消费 |
| `TOOL_NAMES` / `toolRenderConfigs` | Object | 中 | main 加载，ui 消费 |

### 2.3 window.* 全局函数 —— HTML onclick 事件入口

app-ui.js 中大量 HTML 模板通过 `onclick="window.xxx()"` 绑定事件处理器，这些处理器实际定义在 app-main.js 中。关键的跨文件 window.* 函数：

**app-main.js 定义，app-ui.js HTML 中引用的：**
- `window.runWorkspaceAction` — workspace 操作总入口
- `window.runWorkspaceActionFromEvent` — 事件委托版
- `window.updateWorkspaceFormDraft` — 表单字段更新
- `window.saveWorkspaceForm` — 表单保存
- `window.resetWorkspaceForm` — 表单重置
- `window.launchAssemblyInstance` — 启动 assembly
- `window.saveCurrentAssemblyConfig` — 保存 assembly 配置
- `window.resetAssemblyDraft` — 重置 draft
- `window.phOpenModelConfig` / `phCloseModelConfig` / `phSaveModelConfig` — 模型配置
- `window.phSelectDirectoryAndCreateSession` — PH 新建项目
- `window.switchPhSessionTab` — PH session tab
- `window.showCompactMenu` — compact 菜单
- `window.toggleProjectDocsetOverlay` — 文档集覆层
- `window.startProjectRequirementEdit` 等 — 需求编辑
- `window.chooseWorkspaceDirectory` — 目录选择
- `window.openTrimDialog` / `closeTrimDialog` / `submitTrimCompact` — trim dialog
- `window.openBranchDialog` / `closeBranchDialog` / `submitBranch` — branch dialog
- `window.openIMChannelConfig` / `closeIMChannelConfig` — IM 渠道配置
- `window.toggleIMDropdown` / `imSelectChannel` / `imSelectLine` — IM 下拉
- `window.startWeixinBinding` / `refreshWeixinBinding` / `logoutWeixinBinding` — 微信
- `window.createReceptionistSession` / `launchReceptionistSession` — IM 会话
- `window.loadDispatchAgents` / `loadDispatchSchedules` / `cancelDispatchSchedule` — 调度
- `window.openDispatchModalFor` / `showDispatchDetail` / `closeDispatchDetail` — 调度 UI
- `window.handleSessionTitleDoubleClick` — 标题编辑

**app-ui.js 定义，app-main.js 调用的：**
- `renderCurrentMainView` — 渲染中枢（最高频）
- `renderAgentList` — 侧边栏渲染
- `selectWorkspaceSurface` — workspace 切换
- `shouldRenderWorkspaceSurface` — 渲染守卫
- `updateChatContextBar` — 上下文栏更新
- `getWorkspaceFormDraft` / `saveWorkspaceFormDraft` / `resetWorkspaceFormDraft` — draft 管理
- `normalizeAssemblyDraft` / `normalizeFeatureConfigMap` — 数据规范化
- `syncAssemblyEnvironmentDraft` / `requestAssemblyEnvironmentCreate` — 环境操作
- `getSavedAssemblyConfigs` / `collectAssemblyProjectFeatureConfigs` — 配置读取
- `getAssemblyEnvironmentState` — 环境状态
- `findAssemblyConfigConflict` / `isValidFeatureCreatorName` — 校验
- `persistWorkspaceState` — 状态持久化
- `normalizeWorkspaceStartupDraft` — 启动草稿
- `getFeatureCreatorOutputDirectory` / `getAgentCreatorOutputDirectory` — 输出目录

**app-ui.js 调用 app-main.js 定义的：**
- `loadAgents()` — 在 3 处调用
- `renderInputRequests()` — 在 2 处调用

### 2.4 app-core.js DOM 引用

app-core.js L183-225 批量获取 DOM 元素引用（约 40 个），这些引用被 app-ui.js 和 app-main.js 直接使用。

---

## 三、功能域划分

### 3.1 app-ui.js 功能域

> 说明：`dispatch-ui`、`dispatch-actions`、`im-ui`、`im-actions`、`session-dialogs`、`feature-setup-ui` 已经拆出到 `modules/`，下面的功能域图是“原始职责地图”，用于继续切分剩余代码。

#### 域 A: Workspace Surface 核心/路由层（~350行）

行号范围：L2-39, L1607-1644, L6885-7132

核心函数：`selectWorkspaceSurface`, `shouldRenderWorkspaceSurface`, `isChatSurfaceActive`, `renderWorkspaceBlock`, `renderWorkspaceSurface`, `renderCurrentMainView`, `isEditingWorkspaceForm`, `renderWorkspaceTabs`

耦合级别：**极高** — 所有其他域都通过 renderCurrentMainView 路由

#### 域 B: Agent/Session 数据层（~600行）

行号范围：L41-438, L835-1008

核心函数：unit mode 系列、session 数据获取、`renderSessionTokenBar`、`window.generateSessionTitle`、`getAgentWorkspaceState`、`updateAgentRecord`、`applyManagedPrebuiltAgent`

耦合级别：高 — 被所有 UI 域广泛读取

#### 域 C: Assembly 配置与规范化（~900行）

行号范围：L505-570, L1033-1407, L3346-3520, L7244-7360

核心函数：`isAssemblySession`, `normalizeAssemblyDraft`, `getAssemblyEnvironmentState`, `getWorkspaceFormDraft`, `saveWorkspaceFormDraft`, `persistWorkspaceState`, `syncAssemblyEnvironmentDraft`, `requestAssemblyEnvironmentCreate`

耦合级别：高 — 被 flow-workspace UI 和 app-main 广泛依赖

#### 域 D: Feature Creator / Agent Creator 项目管理（~350行）

行号范围：L544-828, L1060-1094

核心函数：`getFeatureCreatorProjects`, `getAgentCreatorProjects`, `getProgrammingHelperProjects`, `getPathLeaf`, 各 display name 函数

耦合级别：中 — 主要被 session 列表渲染和 app-main 使用

#### 域 E: Feature Config 管理（~700行）

行号范围：L866-978, L1236-1282, L5128-5718

核心函数：Feature manifest 解析、config 状态计算、config 控件渲染（`renderFeatureConfigControl`）

耦合级别：中-高 — 被 ClawFW 和 assembly 配置广泛使用

#### 域 F: Workspace Session 列表渲染（~490行）

行号范围：L1646-2130

核心函数：各类 workspace（prebuilt、feature-creator、agent-creator、programming-helper、flow-workspace、qqbot/receptionist）的 session 列表 HTML 生成

耦合级别：中 — 被 renderWorkspaceSurface 调用

#### 域 G: Assembly Form 渲染（~1210行）

行号范围：L2130-3340

核心函数：`renderWorkspaceFormField`、Feature 选择 UI、assembly stage 渲染、workspace form 整体组装

耦合级别：高 — 包含大量 HTML 模板和 onclick 绑定

#### 域 H: IM 渠道管理 UI（~470行）

行号范围：L2252-2720

核心函数：`renderQQBotConfigField`、IM 下拉组件、`renderIMWorkspaceSurface`、微信二维码 dialog

耦合级别：中 — 只在 qqbot agent 下激活

#### 域 I: Dispatch 控制台 UI（~320行）

行号范围：L2730-3050

核心函数：`renderDispatchWorkspace`、`renderDispatchList`、`renderDispatchDetailModal`、`renderDispatchModal`

耦合级别：低-中 — 只在 dispatch-console agent 下激活

#### 域 J: ClawFW Flow Workspace UI（~2500行）

行号范围：L3782-5120, L5718-6880

核心函数：`window.ClawFW` 对象定义及全部方法、prompt editor、drift dialog、Feature capabilities 缓存、assembly editing 前端状态机

耦合级别：高 — 与 assembly data（域 C）、feature config（域 E）紧耦合

#### 域 K: Chat 消息渲染（~2600行）

行号范围：L7132-9717

核心函数：消息渲染、chunk 处理、debug 面板渲染、hook inspector 渲染、工具调用渲染

耦合级别：中 — 被 renderCurrentMainView 调用，依赖 currentMessages

### 3.2 app-main.js 功能域

> 说明：`trim/branch`、`IM`、`dispatch` 的对应用例已经拆到 `modules/`。这里仍保留原始职责地图，方便继续沿着现有依赖把剩余代码拆薄。

#### 域 L: Agent 识别与辅助（~170行）

行号范围：L1-170

核心函数：`normalizeAgentIdentity`, `getCurrentHostAgentRecord`, `getCurrentRuntimeRecord`, `isAgentActive`, `groupConnectedAgents`, `buildSyntheticRuntimeEntry`, `resolveNotificationCallingState`, `getInputSurfaceMode`

耦合级别：低 — 纯辅助函数，被多处调用

#### 域 M: Sidebar 渲染（~340行）

行号范围：L222-563

核心函数：`renderSidebarChildItems`, `renderAgentGroup`, `loadAgents`, `refreshAgentCallStates`, `renderAgentList`

耦合级别：高 — loadAgents 是核心 orchestrator

#### 域 N: Agent 点击/Workspace Session 操作（~240行）

行号范围：L565-806

核心函数：`window.handlePrebuiltAgentClick`, `openPrebuiltWorkspaceSession`, `applyOptimisticWorkspaceSession`, `createCompactedResumeSession`, `window.switchPhSessionTab`

耦合级别：高 — 涉及 agent 切换和 session 管理

#### 域 O: Workspace Action Dispatcher（~440行）

行号范围：L808-1251

核心函数：`window.runWorkspaceAction` — **单个巨型 switch 函数**，处理约 20 种 action 类型

耦合级别：极高 — 是 workspace 操作的总入口

#### 域 P: Assembly Form 操作（~740行）

行号范围：L1379-2116

核心函数：`window.updateWorkspaceFormDraft`, `window.toggleWorkspaceSelection`, `window.applyWorkspaceBundle`, `window.createAssemblyEnvironment`, `window.launchAssemblyInstance`, `window.saveCurrentAssemblyConfig`, `window.resetAssemblyDraft`, `window.loadSavedAssemblyConfig`, `window.launchAssemblyConfig`, `window.deleteSavedAssemblyConfig`, `window.launchSavedAssemblyRun`, `window.fwLaunchConfig`, `window.fwResumeRun`

耦合级别：极高 — 与 assembly data 层（域 C）紧耦合

#### 域 Q: Model Config / PH Project（~100行）

行号范围：L2117-2217

核心函数：`window.phOpenModelConfig`, `window.phCloseModelConfig`, `window.phSaveModelConfig`, `window.phSelectDirectoryAndCreateSession`

耦合级别：低 — 自包含

#### 域 R: Trim/Branch Dialog（~330行）

行号范围：L2317-2650

核心函数：trim dialog 全套（open/close/render/submit）、branch dialog 全套（open/close/render/submit）

耦合级别：低-中 — self-contained dialog 系统

#### 域 S: Assembly Session 管理（~180行）

行号范围：L2652-2830

核心函数：`window.deleteAssemblySessionRecord`, `window.loadAssemblySessionIntoDraft`, `window.stopAssemblySessionRuntime`, `window.chooseWorkspaceDirectory`, `window.saveWorkspaceForm`

耦合级别：高 — 涉及 session 删除、运行时停止

#### 域 T: IM 操作（~420行）

行号范围：L2830-3250

核心函数：IM workspace field 更新、receptionist session 创建/启动、微信绑定/登出、IM 渠道下拉操作

耦合级别：中 — 只在 qqbot workspace 激活

#### 域 U: Dispatch 操作（~180行）

行号范围：L3250-3430

核心函数：dispatch CRUD 操作、调度 modal 操作

耦合级别：低 — 只在 dispatch workspace 激活

#### 域 V: Polling/消息/Chunk 处理（~700行）

行号范围：L3430-4130

核心函数：`poll()` 主循环、chunk 处理、消息更新、overview/logs/hooks 数据同步

耦合级别：极高 — 系统心跳，与几乎所有域有交互

#### 域 W: 输入队列与中断（~300行）

行号范围：L4130-4430

核心函数：input request 处理、中断逻辑

耦合级别：中 — 依赖 currentInputRequests

#### 域 X: Context Menu / Settings（~220行）

行号范围：L4430-4650

核心函数：右键菜单、设置面板操作

耦合级别：低-中

#### 域 Y: 事件监听与 Bootstrap（~1700行）

行号范围：L4650-6339

核心函数：`window.switchAgent`、agent 启动/停止、所有 DOM 事件监听绑定、主题/语言切换、模块 bootstrap IIFE

耦合级别：极高 — 应用启动入口和全局事件绑定

---

## 四、拆分目标结构

```
public/src/
  app-core.js              (保持不变，1119行，共享状态与基础设施)
  app-ui.js                (瘦身目标 ~2500行，保留渲染骨架：域 A + B + F + G 部分)
  app-main.js              (瘦身目标 ~1500行，保留：域 L + M + V 部分 + Y bootstrap)

  modules/
    assembly-data.js       (~900行)  域 C — assembly 配置、draft、环境管理
    assembly-ui.js         (~1200行) 域 G — assembly form 渲染
    assembly-actions.js    (~920行)  域 P + S — assembly 操作 + session 管理
    feature-config.js      (~700行)  域 E — Feature manifest/config 管理
    flow-workspace.js      (~2500行) 域 J — ClawFW 状态机与 UI
    chat-renderer.js       (~2600行) 域 K — 消息渲染、debug 面板
    session-ui.js          (~490行)  域 F — workspace session 列表渲染
    session-dialogs.js     (~330行)  域 R — trim/branch dialog
    im-ui.js               (~470行)  域 H — IM 渠道管理 UI
    im-actions.js          (~420行)  域 T — IM 操作
    dispatch-ui.js         (~320行)  域 I — dispatch 控制台 UI
    dispatch-actions.js    (~180行)  域 U — dispatch 操作
    sidebar.js             (~340行)  域 M（从 main 拆出）
    agent-actions.js       (~680行)  域 N + O — agent 点击 + action dispatcher
    input-queue.js         (~300行)  域 W — 输入队列与中断
    polling.js             (~700行)  域 V — polling/chunk/消息更新
```

### index.html 加载顺序变更

```html
<!-- 现状 -->
<script src="./src/app-core.js"></script>
<script src="./src/app-ui.js"></script>
<script src="./src/app-main.js"></script>

<!-- 拆分后 -->
<script src="./src/app-core.js"></script>
<script src="./src/modules/assembly-data.js"></script>
<script src="./src/modules/feature-config.js"></script>
<script src="./src/modules/flow-workspace.js"></script>
<script src="./src/modules/chat-renderer.js"></script>
<script src="./src/modules/session-ui.js"></script>
<script src="./src/modules/session-dialogs.js"></script>
<script src="./src/modules/assembly-ui.js"></script>
<script src="./src/modules/assembly-actions.js"></script>
<script src="./src/modules/im-ui.js"></script>
<script src="./src/modules/im-actions.js"></script>
<script src="./src/modules/dispatch-ui.js"></script>
<script src="./src/modules/dispatch-actions.js"></script>
<script src="./src/modules/sidebar.js"></script>
<script src="./src/modules/agent-actions.js"></script>
<script src="./src/modules/input-queue.js"></script>
<script src="./src/modules/polling.js"></script>
<script src="./src/app-ui.js"></script>       <!-- 瘦身后 -->
<script src="./src/app-main.js"></script>     <!-- 瘦身后 -->
```

关键约束：modules 在 app-ui.js 和 app-main.js 之前加载，因为后两者依赖 modules 中定义的函数。
已完成的模块已经在当前 `index.html` 中引入，不需要重新安排加载顺序。

---

## 五、推荐拆分顺序

### Phase 1: 已完成的低风险模块

#### 1a. dispatch-ui.js + dispatch-actions.js

- **来源**：app-ui.js 域 I (~320行) + app-main.js 域 U (~180行)
- **理由**：边界清晰，只在 dispatch-console agent 下激活，与主流程几乎无耦合
- **风险**：★☆☆☆☆
- **验证**：打开 dispatch-console → 查看列表 → 创建/取消调度 → 查看详情
- **状态**：已完成
- **注意点**：
  - `window._dispatchSchedules`、`window._dispatchAgents`、`window._dispatchSessions`、`window._dispatchProjects` 等全局状态随模块一起移动
  - `window.loadDispatchSchedules`、`window.loadDispatchAgents` 是 lazy load，UI 渲染时检查 `window._dispatchSchedulesLoaded`

#### 1b. im-ui.js + im-actions.js

- **来源**：app-ui.js 域 H (~470行) + app-main.js 域 T (~420行)
- **理由**：IM 渠道功能独立，只在 qqbot workspace 激活
- **风险**：★★☆☆☆
- **验证**：打开 qqbot → 配置渠道 → 绑定微信 → 创建 receptionist session
- **状态**：已完成
- **注意点**：
  - `window._imChannelConfigOpen`、`window._imChannelDetailId`、`window._creatingReceptionistSession` 等状态随模块移动
  - `window.openIMChannelConfig` 等在 HTML onclick 中被引用，必须保持全局注册

#### 1c. session-dialogs.js (Trim/Branch)

- **来源**：app-main.js 域 R (~330行)
- **理由**：自包含的 dialog 系统，有独立的状态（`trimDialogState`、`branchDialogState`）
- **风险**：★☆☆☆☆
- **验证**：在 session 上右键 → trim → branch → 确认 dialog 正常弹出和提交
- **状态**：已完成
- **注意点**：
  - `window.openTrimDialog`、`window.openBranchDialog` 被 context menu 调用
  - `submitTrimCompact` 调用 `createCompactedResumeSession`，需要确保后者在调用时可用

#### 1d. feature-setup-ui.js

- **来源**：独立的系统 feature config UI 页面
- **理由**：自包含页面，和主 workspace 渲染耦合较低
- **风险**：★☆☆☆☆
- **验证**：打开 feature-setup → 右侧 sections 导航 / 左侧表单编辑 / 自动保存
- **状态**：已完成

### Phase 2: 当前建议优先拆分的模块（中风险）

#### 2a. session-ui.js

- **来源**：app-ui.js 域 F（当前最大的单一 UI 段之一）
- **理由**：主要是 workspace session 列表渲染，边界清晰、复用面广
- **风险**：★★★☆☆
- **验证**：切换 feature-creator / agent-creator / programming-helper / flow-workspace / qqbot → session 列表与标题按钮正常
- **注意点**：
  - 保持 `renderWorkspaceSurface()` 现有调用方式不变
  - session 列表里混有 title / token / context / action 按钮，迁移时先保留 DOM 输出形态

#### 2b. feature-config / settings helpers

- **来源**：app-ui.js 域 E + settings overlay 片段
- **理由**：feature manifest / config / settings 面板的读取和渲染已经明显内聚
- **风险**：★★★☆☆
- **验证**：打开 settings / flow-workspace / feature repo → 配置读取与控件渲染正常
- **注意点**：
  - 先移动纯 helper，再移动 UI renderer，最后再考虑 action 入口
  - settings overlay 和 feature config 控件都仍然会被 `renderFeaturePanel()` 间接触发

#### 2c. chat-renderer.js / tool renderer

- **来源**：app-ui.js 域 K
- **理由**：消息渲染、markdown、tool result 展示、debug 面板可以再切细
- **风险**：★★★☆☆
- **验证**：发送消息 / 展开 reasoning / 查看 tool call / markdown / math / logs
- **注意点**：
  - `renderMarkdown`、`renderJsonHighlight`、`parseToolResult`、`getToolRenderTemplate` 之间是同一条渲染链
  - 这组 helper 适合先拆，再拆消息渲染本体

### Phase 3: 核心骨架（高风险）

#### 3a. flow-workspace.js (ClawFW)

- **来源**：app-ui.js 域 J
- **理由**：`window.ClawFW` 已有独立命名空间，逻辑内聚但体量大
- **风险**：★★★★☆
- **验证**：打开 flow-workspace → 查看项目列表 → 进入 detail → 编辑 assembly → 查看 features → 进入 orchestrate
- **注意点**：
  - ClawFW 依赖 assembly data（域 C）的多个函数
  - ClawFW 依赖 feature config（域 E）的多个函数
  - `window.ClawFW` 对象在 app-ui.js 的 `renderWorkspaceBlock` 等函数中被检查

#### 3b. assembly-data.js + assembly-ui.js + assembly-actions.js

- **来源**：app-ui.js 域 C+G + app-main.js 剩余的 assembly 操作片段
- **理由**：最核心的业务逻辑，与几乎所有其他域有交叉
- **风险**：★★★★★
- **验证**：完整 assembly 流程（创建环境 → 选择 feature → 保存配置 → 启动实例 → 停止 → 恢复 → 删除）
- **注意点**：
  - 这是跨文件调用最密集的区域
  - 域 C（assembly data）的数据函数被至少 6 个其他域调用
  - 域 G（assembly UI）包含大量 HTML 模板，模板中的 onclick 引用了 main 中定义的 window.* 函数
  - 域 P（assembly actions）调用了大量 ui 中定义的辅助函数
  - 建议先拆 assembly-data（纯数据层），再拆 assembly-ui（渲染层），最后拆 assembly-actions（操作层）

#### 3c. workspace-surface.js（最后拆）

- **来源**：app-ui.js 域 A
- **理由**：包含 `renderCurrentMainView` - 全局渲染中枢
- **风险**：★★★★★
- **验证**：全功能回归测试——每一个页面、每一个操作路径
- **注意点**：
  - **必须最后拆**
  - 拆分前确保所有其他模块已经稳定运行
  - 此函数的错误会导致全站白屏

---

## 六、风险与缓解策略

### 风险 1：全局状态隐式耦合

**问题**：所有文件通过全局变量通信（`allAgents`、`currentAgentId` 等），拆分后新文件仍需访问这些变量。

**缓解**：
- 第一阶段不改变通信模式，新文件继续读写 app-core.js 中的全局变量
- 保持脚本加载顺序不变
- 每个 module 文件顶部加注释标注依赖的全局状态：
  ```js
  // 依赖的全局状态（定义在 app-core.js）：
  //   allAgents, currentAgentId, currentLanguage
  // 依赖的全局函数（定义在 app-ui.js）：
  //   renderCurrentMainView, getWorkspaceFormDraft
  ```

### 风险 2：renderCurrentMainView() 调用链断裂

**问题**：此函数被 ~60 处调用，拆分时如果引入时机问题会导致 UI 不更新。

**缓解**：
- Phase 1-2 中此函数保持在 app-ui.js 原位不动
- 只有 Phase 3b 才考虑将其迁移到 workspace-surface.js
- 拆分每个模块后立即验证：加载页面 → 切换 agent → 操作 workspace → 确认渲染正常

### 风险 3：window.* onclick 事件断裂

**问题**：HTML 模板中的 `onclick="window.xxx()"` 要求对应函数在全局注册。

**缓解**：
- 所有拆出的模块仍通过 `window.xxx = function` 注册到全局
- 不改变 HTML 模板中的 onclick 绑定
- 每个 window.* 函数在原文件中保留 `// -> modules/xxx.js` 注释标注来源

### 风险 4：加载顺序敏感

**问题**：当前 `app-core → app-ui → app-main` 的顺序是有意义的（ui 依赖 core 的 DOM 引用，main 依赖 ui 的 renderCurrentMainView）。

**缓解**：
- index.html 中在 app-core.js 之后、app-ui.js 之前加载 modules/*
- modules 之间按依赖关系排序：data 层在前，UI 层在中，actions 层在后
- 每个 module 文件不依赖 app-ui.js 或 app-main.js 中定义的函数（如果有，先移到 module 中或保持原位）

### 风险 5：函数碎片化

**问题**：同一个功能域的函数分散在多个不连续的行号范围，拆出时可能出现遗漏或误拆。

**缓解**：
- 每拆一个模块，用 grep 验证被拆函数的所有引用点
- 拆分后原文件中保留 `// <函数名> -> modules/xxx.js` 注释
- 每个模块文件头部列出导出的全局函数清单

---

## 七、操作边界

### 不做的事（避免过度工程）

1. **不引入 ES module / import / export**：当前项目是纯 script 标签加载，强行改 module 系统代价远大于收益
2. **不引入构建工具**（webpack/vite/rollup）：项目已有一次失败的 vite 迁移（见 docs/vite-migration-*.md），不应重蹈覆辙
3. **不改变全局状态的访问方式**：Phase 1-3 都保持全局变量通信，后续可以考虑引入 `ClawState` 对象做显式状态管理，但那是独立的工作项
4. **不重构 renderCurrentMainView() 的内部逻辑**：只做位置移动，不做逻辑重构
5. **不改变 HTML 模板中的 onclick 绑定方式**：保持 `onclick="window.xxx()"`

### 每个模块拆分时的标准操作步骤

1. 在 `public/src/modules/` 创建新文件，文件头加注释：
   ```js
   /**
    * xxx 模块
    * 从 app-ui.js / app-main.js 拆出
    * 
    * 依赖全局状态: xxx, yyy
    * 导出全局函数: window.xxx, window.yyy
    */
   ```
2. 把目标函数从源文件**移动**（不是复制）到新文件
3. 在源文件对应位置加 `// <函数名> -> modules/xxx.js` 注释
4. 在 index.html 的 `<script>` 标签中加入新文件（在正确位置）
5. 刷新页面，验证对应功能域：
   - 页面是否正常加载（无 JS 报错）
   - 对应功能域是否正常工作
   - 其他功能域是否不受影响
6. 确认后 git commit

### 可选的后续改进（不在本次拆分范围内）

- 引入 `ClawState` 命名空间，将散落的全局状态集中管理
- 将 `window.xxx = function` 替换为事件委托，减少全局污染
- 考虑使用 ES module 重写（需要构建工具支持）
- 为每个模块编写单元测试

---

## 八、执行跟踪

| Phase | 模块 | 状态 | 验证人 | 日期 |
|-------|------|------|--------|------|
| 1a | dispatch-ui + dispatch-actions | 已完成 | - | - |
| 1b | im-ui + im-actions | 已完成 | - | - |
| 1c | session-dialogs | 已完成 | - | - |
| 1d | feature-setup-ui | 已完成 | - | - |
| 2a | session-ui | 已完成 | - | - |
| 2b | feature-config / settings helpers | 已完成 | - | - |
| 2c | chat-renderer / tool renderer | 已完成 | - | - |
| E1 | ctx-menu-handlers (上下文菜单 action) | 已完成 | - | 2026-07-23 |
| E2 | sidebar-render (侧边栏渲染 + loadAgents) | 已完成 | - | 2026-07-23 |
| E3 | docset/素材操作 → workspace-docset.js | 已完成 | - | 2026-07-23 |
| E4 | loadLogs→debug-logs, loadMcpInfo→debug-mcp, loadAgentData→agent-data-loader | 已完成 | - | 2026-07-23 |
| E5 | input-render (renderInputRequests) | 已完成 | - | 2026-07-23 |
| E6 | workspace-actions (runWorkspaceAction 分发器) | 已完成 | - | 2026-07-13 |
| 3a | flow-workspace | 部分完成（ClawFW → modules/fw-config-panel.js），剩余取消（flow-workspace 已悬置） | - | - |
| 3b | assembly-data + assembly-ui + assembly-actions | 已完成（assembly-data.js / assembly-actions.js 已拆出，表单渲染随 app-ui v2 后续拆分落地） | - | - |
| 3c | workspace-surface | 已收口（renderCurrentMainView 保留在瘦身后的 app-ui.js 骨架中，app-ui.js 现 ~1,890 行） | - | - |

每个模块完成时在此表中更新状态。
