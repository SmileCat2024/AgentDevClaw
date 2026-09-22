# Vite + React 迁移计划

> 目标：将前端从纯 vanilla JS (645KB) 迁移到 Vite + React，根治 innerHTML 全量重建导致的滚动/刷新/状态丢失 bug，同时保持后端架构和 Feature 模板协议不变。

---

## 一、系统边界总览

迁移前必须明确哪些东西要动、哪些不动。

### 1.1 不动的部分（迁移后保持原样）

| 边界 | 说明 |
|------|------|
| **server.js** | Express 后端，所有 `/protoclaw/*` 路由、agent 管理、session 管理完全不动 |
| **ViewerWorker** | 独立进程（端口 2026），Claw 通过 `proxyToViewer()` 代理 `/api/*`、`/template/*`、`/features/*` 等请求，不动 |
| **Feature npm 包** | `@agentdev/shell-feature` 等包的 `dist/templates/*.render.js` 格式不变 |
| **render.js 模板协议** | `export default { call(args) → string, result(data, success, args) → string }` 不变 |
| **API 契约** | 所有 `/protoclaw/*` 和 `/api/*` 的请求/响应格式不变 |
| **CSS** | `base.css`、`layout.css`、`components.css` 可以原样搬入 Vite 项目 |
| **Flow Editor** | `flow-editor.js` (163KB) 暂时作为独立模块保持原样 |
| **local-features** | 后端 Feature 构建链（TypeScript → dist）不变 |
| **Tauri 桥接** | `tauri-bridge.js` 的 HTTP fallback 模式不变 |

### 1.2 要改的部分

| 边界 | 改动内容 |
|------|---------|
| **前端入口** | `index.html` → Vite 入口 + React root |
| **JS 模块加载** | `<script src="./src/app-*.js">` → ES Module import 链 |
| **渲染管线** | `container.innerHTML = html` → React 组件树 + 虚拟 DOM diff |
| **全局状态** | 50+ 全局变量 → React state / context / store |
| **轮询循环** | `setTimeout(poll, 300)` 递归 → 自定义 Hook 或保持轮询但用 React state 更新 |
| **事件绑定** | `onclick="functionName()"` 字符串 → React 声明式事件 |
| **DOM 查询** | `document.getElementById(...)` / `container.querySelectorAll(...)` → React ref + state |
| **构建工具** | 无 → Vite（开发服务器 + 生产打包） |

---

## 二、数据流全景

### 2.1 当前数据流

```
                          ┌─────────────────────────────────┐
                          │         server.js (:1420)        │
                          │                                   │
  浏览器 ──fetch──→ /protoclaw/* ──→ Express 路由 ──→ 文件系统/SQLite
       │                                  │
       │                          /api/* /template/* /features/*
       │                                  │
       │                          proxyToViewer()
       │                                  │
       │                                  ▼
       │                    ┌────────────────────────┐
       │                    │  ViewerWorker (:2026)   │
       │                    │  agentdev 框架运行时     │
       │                    └────────────────────────┘
       │                                  ▲
       │                                  │
       └─── dynamic import(template.js) ──┘
```

### 2.2 轮询驱动的状态同步

```
poll() [每 300ms]
  │
  ├── 无 runtimeAgentId 时
  │   ├── loadAgents() → GET /protoclaw/get_connected_agents + GET /api/agents
  │   │                  → 合并写入 allAgents[] → renderAgentList()
  │   ├── 刷新 workspace_sessions（每 3s）
  │   └── loadLogs()（如果 log panel 打开且 scope=all）
  │
  └── 有 runtimeAgentId 时
      ├── 并行请求 5 个端点：
      │   GET /api/agents/{id}/messages
      │   GET /api/agents/{id}/notification
      │   GET /api/agents/{id}/connection
      │   GET /api/agents/{id}/input-requests
      │   GET /api/agents/{id}/overview
      │
      ├── 消息 diff：
      │   ├── 新增 → appendNewMessages()（insertAdjacentHTML，增量）
      │   ├── 减少 → renderCurrentMainView()（全量重建）
      │   └── 末条变化 → updateLastMessage()（局部 innerHTML）
      │
      ├── 输入请求 diff → renderInputRequests()
      ├── 连接状态 → setConnectionStatus()
      ├── 通知状态 → updateNotificationStatus()
      ├── Overview diff → 更新 feature panel
      ├── Agent 列表刷新（每 3s）
      ├── Workspace session 刷新（每 3s）
      ├── Hook inspector diff
      └── Feature 模板重载（如果 map 为空，每 3s 重试）
```

### 2.3 迁移后数据流（React 版）

```
poll() [保持 300ms，但只写 state]
  │
  ├── API 响应 → React setState
  │   ├── allAgents → setAllAgents()
  │   ├── currentMessages → setMessages()
  │   ├── connection → setConnectionStatus()
  │   ├── inputRequests → setInputRequests()
  │   ├── notification → setNotification()
  │   ├── overview → setOverview()
  │   └── hooks → setHookInspector()
  │
  └── React 自动 diff + 渲染
      ├── AgentList 组件：allAgents 变化 → 只更新变化的 agent 项
      ├── MessageList 组件：messages 变化 → 只追加/更新变化的消息
      ├── ToolCallBlock 组件：独立渲染，不影响其他消息
      ├── FeaturePanel 组件：独立渲染
      └── InputRequestPanel 组件：独立渲染
```

**核心变化**：poll 不再直接操作 DOM，只负责写 state。React 的 diff 机制决定哪些 DOM 节点需要更新。

---

## 三、API 端点完整清单

### 3.1 Claw 自有路由（server.js 直接处理）

| 路由 | 方法 | 用途 | 前端消费者 |
|------|------|------|-----------|
| `/protoclaw/health` | GET | 健康检查 | 启动时 |
| `/protoclaw/get_prebuilt_agents` | GET | 预置代理列表 | 侧边栏 |
| `/protoclaw/get_agents_status` | GET | 所有代理状态 | 侧边栏 |
| `/protoclaw/get_connected_agents` | GET | 已连接代理 | poll / loadAgents |
| `/protoclaw/agent_detail` | GET | 单个代理详情（workspace_data/sessions/state） | workspace surface |
| `/protoclaw/start_agent` | POST | 启动代理 | 侧边栏点击 |
| `/protoclaw/stop_agent` | POST | 停止代理 | 右键菜单 |
| `/protoclaw/restart_agent` | POST | 重启代理 | 右键菜单 |
| `/protoclaw/prebuilt_sessions` | GET/POST | 会话列表/创建 | workspace sessions |
| `/protoclaw/session_record` | GET | 会话记录 | session 详情 |
| `/protoclaw/session_trim_preview` | GET | 裁剪预览 | compact 操作 |
| `/protoclaw/session_summary` | GET | 会话摘要 | compact 操作 |
| `/protoclaw/session_generate_summary` | POST | 生成摘要 | compact 操作 |
| `/protoclaw/workspace_state` | GET/PUT | 工作空间状态 | workspace surface |
| `/protoclaw/workspace_artifacts` | GET | 工作空间产物 | workspace artifacts |
| `/protoclaw/project_docset/import_materials` | POST | 导入项目材料 | docset |
| `/protoclaw/qqbot_config` | GET/PUT | QQBot 配置 | qqbot workspace |
| `/protoclaw/model_config` | GET/PUT | 模型配置 | settings |
| `/protoclaw/refresh_session_token_count` | POST | 刷新 token 计数 | session 面板 |
| `/protoclaw/context_handoffs/export` | POST | 上下文导出 | context handoff |
| `/protoclaw/context_handoffs/compacted_resume` | POST | 压缩续接 | context handoff |
| `/protoclaw/context_handoffs/compact_and_resume` | POST | 压缩并续接 | context handoff |
| `/protoclaw/context_handoffs/summary_resume` | POST | 摘要续接 | context handoff |
| `/protoclaw/context_handoffs/summary_export` | POST | 摘要导出 | context handoff |
| `/protoclaw/spawn_one_shot` | POST | 一次性代理 | 工具调用 |
| `/protoclaw/resume_sub` | POST | 恢复子代理 | 工具调用 |
| `/protoclaw/assembly_environment/create` | POST | 创建 Assembly 环境 | assembly |
| `/protoclaw/assembly_runtime/start` | POST | 启动 Assembly 运行时 | assembly |
| `/protoclaw/assembly_runtime/stop` | POST | 停止 Assembly 运行时 | assembly |
| `/protoclaw/prebuilt_sessions/activate` | POST | 激活会话 | session 切换 |
| `/protoclaw/prebuilt_sessions/delete` | POST | 删除会话 | session 管理 |
| `/protoclaw/prebuilt_project/delete` | POST | 删除项目 | 项目管理 |
| `/protoclaw/feature_repository/delete` | POST | 删除 Feature 仓库 | feature 管理 |
| `/protoclaw/feature_repository/parse_upload` | POST | 解析上传的 Feature 包 | feature 导入 |
| `/protoclaw/feature_repository/confirm_import` | POST | 确认导入 | feature 导入 |
| `/protoclaw/feature_repository/cancel_import` | POST | 取消导入 | feature 导入 |
| `/protoclaw/feature_repository/upload` | POST | 上传 Feature 包 | feature 导入 |
| `/protoclaw/validate_empty_directory` | POST | 验证空目录 | 项目创建 |
| `/protoclaw/feature_creator/initialize` | POST | 初始化 Feature 创建器 | feature 创建 |
| `/protoclaw/agent_creator/initialize` | POST | 初始化 Agent 创建器 | agent 创建 |
| `/protoclaw/flow_graphs` | GET | 获取所有 Flow 图 | flow editor |
| `/protoclaw/flow_graph/:id` | GET | 获取单个 Flow 图 | flow editor |
| `/protoclaw/flow_graph` | POST | 创建 Flow 图 | flow editor |
| `/protoclaw/flow_graph/:id` | PUT | 更新 Flow 图 | flow editor |
| `/protoclaw/flow_graph/:id` | DELETE | 删除 Flow 图 | flow editor |
| `/protoclaw/flow_capabilities` | GET | 获取 Flow 能力 | flow editor |
| `/protoclaw/agent_model_presets` | PUT | 保存模型预设 | settings |

### 3.2 代理到 ViewerWorker 的路由

| 路由模式 | 方法 | 用途 |
|---------|------|------|
| `/api/agents` | GET | 所有运行时代理 |
| `/api/agents/:id/messages` | GET | 代理消息列表 |
| `/api/agents/:id/notification` | GET | 当前通知状态 |
| `/api/agents/:id/connection` | GET | 连接状态 |
| `/api/agents/:id/input-requests` | GET | 输入请求列表 |
| `/api/agents/:id/overview` | GET | 概览快照 |
| `/api/agents/:id/hooks` | GET | Hook 检查器数据 |
| `/api/agents/:id/running` | GET | 是否运行中 |
| `/api/agents/current` | PUT | 设置当前代理 |
| `/api/agents/:id/input` | POST | 发送用户输入 |
| `/api/agents/:id/queue-input` | POST | 队列输入 |
| `/api/agents/:id/queued-inputs` | GET | 获取队列输入 |
| `/api/agents/:id/dequeue-input` | POST | 出队输入 |
| `/api/agents/:id/interrupt` | POST | 中断代理 |
| `/api/agents/:id` | DELETE | 删除代理 |
| `/api/templates/feature` | GET | Feature 模板映射 |
| `/template/agentdev/**/*.render.js` | GET | 模板文件 |
| `/features/**/*` | GET | Feature 资源 |
| `/tools/**/*` | GET | 工具资源 |
| `/npm/**/*` | GET | npm 资源 |
| `/chunk-*`, `/BasicAgent-*` 等 | GET | ViewerWorker JS chunks |

### 3.3 静态资源路由

| 路由 | 来源 |
|------|------|
| `/vendor/*` | `node_modules/` 目录（Express static） |
| `/*`（其余） | `public/` 目录（Express static） |

---

## 四、前端状态域划分

当前 50+ 个全局变量需要按职责归组到 React 的 state/context 中。

### 4.1 应用级状态（App Context）

| 状态域 | 当前变量 | 说明 |
|--------|---------|------|
| **AgentList** | `allAgents`, `pendingPrebuiltAgentIds` | 所有代理列表，按 source 分组 |
| **CurrentAgent** | `currentAgentId`, `currentRuntimeAgentId`, `readOnlyMode` | 当前选中的代理和运行时 ID |
| **Theme** | `currentTheme` | 主题（dark/light） |
| **Language** | `currentLanguage` | 语言（zh/en） |
| **Connection** | （通过 `statusBadge` DOM 直接操作） | ViewerWorker 连接状态 |

### 4.2 消息/聊天状态（Chat Context）

| 状态域 | 当前变量 | 说明 |
|--------|---------|------|
| **Messages** | `currentMessages` | 当前代理的消息列表 |
| **InputRequests** | `currentInputRequests`, `choiceInputState` | 输入请求和选择状态 |
| **Scroll** | `followLatestEnabled`, `suppressFollowScrollEvent`, `pendingFollowToBottom`, `lastManualScrollIntentAt`, `followScrollSettleToken`, `_progScrollCooldownUntil` | 滚动追踪状态 |
| **Notification** | （notification DOM 直接操作） | LLM 通知（thinking/content/tool_calling） |
| **ToolRender** | `toolRenderConfigs`, `TOOL_NAMES` | 工具渲染配置 |
| **TemplateMap** | `FEATURE_TEMPLATE_MAP`, `templateCache` | Feature 模板映射和缓存 |

### 4.3 Workspace 状态（Workspace Context）

| 状态域 | 当前变量 | 说明 |
|--------|---------|------|
| **WorkspaceTab** | `currentWorkspaceTab`, `workspaceSurfaceModePreferences`, `unitModePreferences` | 当前 workspace 标签页 |
| **Assembly** | `assemblyDraftRenderTimer`, `assemblyLaunchInProgress`, `assemblyControlPanelOpen`, `assemblySideRailRevealTimer` | Assembly 配置相关 |
| **ProjectDocset** | `currentWorkspaceDocsetDetail`, `currentProjectDocsetOpen`, `currentProjectRequirementEdit`, `currentProjectDocsetPage` | 项目文档集 |
| **ArtifactDetail** | `currentWorkspaceArtifactDetail` | 产物详情 |
| **ExpansionState** | `expandedProjectIds`, `savedPhTabState` | 展开/选中状态 |

### 4.4 Feature Panel 状态

| 状态域 | 当前变量 | 说明 |
|--------|---------|------|
| **PanelState** | `activeFeaturePanel`, `featurePanelWidth` | 面板激活状态和宽度 |
| **HookInspector** | `currentHookInspector`, `currentHookInspectorSignature` | Hook 检查器数据 |
| **Overview** | `currentOverviewSnapshot`, `currentOverviewSignature`, `selectedOverviewLifecycle`, `selectedFeatureName` | 概览快照 |
| **Logs** | `currentLogs`, `currentLogsSignature`, `logPanelScope`, `logFilters` | 日志面板 |
| **MCP** | `currentMcpInfo` | MCP 信息 |
| **Repository** | `selectedRepositoryPackageId`, `repoSearchQuery`, `repoSourceFilter` | Feature 仓库浏览 |

### 4.5 UI 临时状态

| 状态域 | 当前变量 | 说明 |
|--------|---------|------|
| **ContextMenu** | `contextMenuAgentId`, `contextMenuAgentMode`, `contextMenuSessionId`, `contextMenuProjectId`, `contextMenuFeatureRepoPackageId` | 右键菜单状态 |
| **Animation** | `shouldAnimateWorkspaceSurface` | workspace 切换动画 |
| **RenderCache** | `lastRenderedWorkspaceHtml`, `lastRenderedInputSignature`, `lastRenderedInputMode` | 渲染缓存（迁移后大部分不需要） |

---

## 五、Feature 模板系统：迁移方案

### 5.1 当前模板渲染管线

```
1. Feature npm 包构建时 → tsup 编译 src/templates/bash.render.ts → dist/templates/bash.render.js
                                                    ↓
2. ViewerWorker 启动时 → 收集所有 Feature 的模板路径 → 注册到路由 /template/agentdev/{feature}/{name}.render.js
                                                    ↓
3. 前端启动 → GET /api/templates/feature → FEATURE_TEMPLATE_MAP（toolName → URL 映射）
                                                    ↓
4. 渲染消息 → getToolRenderTemplate(toolName) → 从 templateCache 取或 await import(url) 加载
                                                    ↓
5. 模板函数执行 → template.call(args) → 返回 HTML string
                                                    ↓
6. HTML string → innerHTML 塞入 .tool-call-container / .tool-result-body
```

### 5.2 迁移后模板渲染管线

**模板协议（步骤 1-4）完全不变**，变化只在步骤 5-6：

```
步骤 1-4：完全不变（ESM export default，dynamic import，templateCache 都不变）
                    ↓
5. 模板函数执行 → template.call(args) → 仍然返回 HTML string
                    ↓
6. React 组件消费：
   function ToolCallBlock({ toolName, args, template }) {
     const html = template.call(args)
     return (
       <div className="tool-call-container">
         <div className="tool-header">
           <span className="tool-header-name">{displayName}</span>
         </div>
         <div className="tool-content">
           <div dangerouslySetInnerHTML={{ __html: html }} />
         </div>
       </div>
     )
   }
```

### 5.3 关键区别

| 维度 | 当前 | 迁移后 |
|------|------|--------|
| 模板加载 | `await import(path)` — 不变 | 不变 |
| 模板缓存 | `templateCache` Map — 不变 | 不变 |
| 模板执行 | `applyTemplate(template, data)` → HTML string | 不变，仍然返回 string |
| 消费方式 | `container.innerHTML = html`（全容器替换） | `dangerouslySetInnerHTML`（单条消息粒度） |
| 重新渲染 | 整个 container 重建 | 只有新增/变化的消息更新 |
| 模板加载中 | 消息已经渲染 → 显示 fallback → 模板加载后重新 renderCurrentMainView() → 全量重建 | 可以用 Suspense 或 placeholder 等待，不影响已有消息 |

### 5.4 未来可选升级

模板协议可以保持向后兼容地渐进升级：

```
Phase 1（迁移初期）：模板返回 HTML string → dangerouslySetInnerHTML
Phase 2（可选）：模板也可以返回 React 组件
  - render.js export default { call: (args) => ({ type: 'react', component: BashCallView, props: args }) }
  - 前端检测返回值类型，string 走 dangerouslySetInnerHTML，{ type: 'react' } 走 <Component />
```

---

## 六、组件树架构

### 6.1 顶层结构

```
<App>
  <AppProvider>          ← 主题、语言、全局配置
    <Layout>
      <Sidebar />        ← 代理列表、分组、右键菜单
      <MainContent>      ← 右侧主区域
        <Header />       ← 代理名、状态、通知
        <WorkspaceTabs /> ← workspace/chat 标签切换
        <ContentArea>    ← 根据 currentWorkspaceTab 切换
          <ChatSurface />        ← 消息列表 + 输入框
          <WorkspaceSurface />   ← workspace 配置界面
          <HomeSurface />        ← 首页
          <AssemblySurface />    ← Assembly 配置
          <ProjectSurface />     ← 项目管理
        </ContentArea>
        <ProjectDocsetOverlay /> ← 文档集侧边面板
      </MainContent>
      <FeaturePanel />   ← 右侧 Feature 检查面板
    </Layout>
  </AppProvider>
</App>
```

### 6.2 ChatSurface 组件树

```
<ChatSurface>
  <MessageList messages={currentMessages}>
    {messages.map((msg, i) => (
      <MessageRow key={i} message={msg}>
        {msg.role === 'user' && <UserMessage content={msg.content} />}
        {msg.role === 'assistant' && (
          <AssistantMessage message={msg}>
            {msg.reasoning && <ReasoningBlock content={msg.reasoning} />}
            <MarkdownContent content={msg.content} />
            {msg.toolCalls?.map(call => (
              <ToolCallBlock key={call.id} call={call} />
            ))}
          </AssistantMessage>
        )}
        {msg.role === 'tool' && (
          <ToolResultBlock message={msg} />
        )}
      </MessageRow>
    ))}
  </MessageList>
  <InputArea />
  <FollowLatestButton />
</ChatSurface>
```

### 6.3 WorkspaceSurface 组件树

```
<WorkspaceSurface agent={currentAgent}>
  {currentWorkspaceTab === 'home' && <WorkspaceHome />}
  {currentWorkspaceTab === 'assembly' && <AssemblyConfig />}
  {currentWorkspaceTab === 'sessions' && <SessionManager />}
  {currentWorkspaceTab === 'artifacts' && <ArtifactBrowser />}
  {currentWorkspaceTab === 'project' && <ProjectManager />}
  {currentWorkspaceTab === 'agent-creator' && <AgentCreator />}
  {currentWorkspaceTab === 'feature-creator' && <FeatureCreator />}
  {currentWorkspaceTab === 'repository' && <FeatureRepository />}
</WorkspaceSurface>
```

---

## 七、迁移阶段规划

### Phase 0：基础设施搭建（1-2 天）

**目标**：Vite 项目可运行，React 可渲染，与现有 Express 后端通信正常。

- [ ] 在项目根目录初始化 Vite + React（不破坏现有 public/ 目录）
- [ ] 配置 `vite.config.ts`：
  - dev server 代理所有 `/api/*`、`/protoclaw/*`、`/template/*`、`/features/*` 到 Express
  - 排除 `/vendor/*` 和 ViewerWorker chunks 的处理
  - CSS 原样引入
- [ ] 创建 React 入口，渲染一个最小壳（sidebar + 空的 main content）
- [ ] 验证：Vite dev server 可以代理到 Express → Express 可以代理到 ViewerWorker → 数据流通
- [ ] 将现有 `index.html` 保留为 legacy 入口（通过 `?legacy=1` 可回退）

**Vite 代理配置关键点**：
```
server.proxy:
  /api/*       → http://localhost:1420  （Express 再转 ViewerWorker）
  /protoclaw/* → http://localhost:1420  （Express 自有路由）
  /template/*  → http://localhost:1420  （Express → ViewerWorker）
  /features/*  → http://localhost:1420
  /vendor/*    → http://localhost:1420
```

**重要**：Vite dev server 仅在开发时存在。生产模式下 Vite 构建出静态文件，仍由 Express 的 `express.static` 提供。所以 Express server.js 基本不需要改。

### Phase 1：聊天消息渲染（3-5 天）— 核心收益阶段

**目标**：消息列表用 React 渲染，根治滚动 bug。这是整个迁移的核心收益。

- [ ] 创建 `usePolling` Hook — 封装 poll 循环，返回 state
- [ ] 创建 `MessageList` + `MessageRow` + `UserMessage` + `AssistantMessage` + `ToolResultBlock` 组件
- [ ] 实现 Feature 模板加载 Hook（`useTemplateLoader`）— 封装 `await import(path)` + cache
- [ ] 实现 Markdown 渲染（复用现有 marked + highlight.js + katex 逻辑）
- [ ] 实现滚动追踪（`useFollowLatest` Hook — 利用 `scrollTop` + `IntersectionObserver`，不再需要全量 DOM 重建）
- [ ] 实现 ToolCallBlock / ToolResultBlock — 通过 `dangerouslySetInnerHTML` 消费模板 HTML
- [ ] 验证：消息可以正常显示、追加、滚动追踪、模板渲染正确

**为什么先做这个**：
- 这是滚动/刷新 bug 最密集的地方
- 消息渲染与 sidebar、feature panel、workspace surface 相对独立
- 完成后可以立即验证 React diff 是否真的解决了滚动问题

### Phase 2：侧边栏 + Agent 管理（2-3 天）

**目标**：Agent 列表、分组、启动/停止、右键菜单用 React 渲染。

- [ ] 创建 `Sidebar` + `AgentGroup` + `AgentItem` 组件
- [ ] 实现 Agent 启动/停止/重启操作
- [ ] 实现右键菜单（ContextMenu 组件）
- [ ] 实现 Agent 切换逻辑（selectWorkspaceSurface → React state 更新）
- [ ] 实现 Session 管理（会话列表、切换、创建、删除）
- [ ] 验证：Agent 切换正常，Session 管理正常

### Phase 3：Workspace Surface（5-7 天）— 最大工作量

**目标**：将 422KB 的 app-ui.js 中的 workspace 渲染逻辑转为 React 组件。

- [ ] 创建 `WorkspaceSurface` 容器组件
- [ ] 逐个迁移 Workspace 标签页：
  - Home → `WorkspaceHome` 组件
  - Assembly → `AssemblyConfig` 组件（最复杂）
  - Sessions → `SessionManager` 组件
  - Artifacts → `ArtifactBrowser` 组件
  - Project → `ProjectManager` 组件
  - Agent Creator → `AgentCreator` 组件
  - Feature Creator → `FeatureCreator` 组件
  - Feature Repository → `FeatureRepository` 组件
- [ ] 实现 ProjectDocsetOverlay
- [ ] 实现 workspace 表单状态管理（当前 `getWorkspaceFormDraft` / `updateWorkspaceFormDraft`）
- [ ] 验证：每个 workspace 标签页功能完整

### Phase 4：Feature Panel + Header（2-3 天）

**目标**：右侧 Feature 检查面板和顶部 Header 用 React 渲染。

- [ ] 创建 `FeaturePanel` 组件（hooks/workspace/logs/inspector/mcp 五个标签）
- [ ] 创建 `Header` 组件（代理名、状态、通知、workspace 切换）
- [ ] 实现 Feature Panel 拖拽调整宽度
- [ ] 实现 HookInspector / Overview / Logs 子面板
- [ ] 验证：Feature Panel 功能完整

### Phase 5：Flow Editor 集成（2-3 天）

**目标**：将 Flow Editor 集成到 React 组件树中。

- [ ] 评估两种方案：
  - A）将 flow-editor.js 封装为 React 组件（`useEffect` 中初始化，ref 挂载）
  - B）用 iframe 隔离 flow-editor.js
- [ ] 推荐：方案 A，因为 flow-editor 需要与外部 API 通信
- [ ] 实现 `FlowEditorWrapper` React 组件
- [ ] 验证：Flow 编辑功能完整

### Phase 6：清理 + 生产构建（1-2 天）

**目标**：删除旧代码，配置生产构建。

- [ ] 删除 `public/src/app-*.js`、旧 `index.html`
- [ ] 配置 Vite 生产构建：输出到 `public/` 或独立 `dist/` 目录
- [ ] 更新 `server.js`：指向 Vite 构建输出目录
- [ ] 测试生产构建（`npm run build && npm start`）
- [ ] 验证 Tauri 打包兼容性（如果需要）

---

## 八、ESM / Import 兼容性分析

### 8.1 当前前端模块加载方式

```
index.html
  ├── <script src="./src/tauri-bridge.js">          ← 无 module，全局变量
  ├── <script src="./src/app-core.js">               ← 无 module，全局变量
  ├── <script src="./src/app-ui.js">                 ← 无 module，全局变量
  └── <script src="./src/app-main.js">               ← 无 module，全局变量

运行时动态加载：
  └── await import('/template/agentdev/shell/bash.render.js')  ← ESM dynamic import
```

所有 app-*.js 通过全局变量通信，没有 ES Module 的 import/export。唯一的 ESM import 是运行时动态加载 Feature 模板。

### 8.2 迁移后模块加载方式

```
Vite 入口 main.tsx
  ├── import App from './App'                        ← ESM import（Vite 处理）
  ├── import './styles/base.css'                     ← CSS import（Vite 处理）
  └── ...

运行时动态加载（不变）：
  └── await import('/template/agentdev/shell/bash.render.js')  ← 浏览器原生 import
```

### 8.3 dynamic import() 兼容性保证

| 场景 | 兼容性 |
|------|--------|
| Vite dev 模式 | `/template/*` 请求走 Vite proxy → Express → ViewerWorker。Vite 不干预这些 URL 的 import() |
| Vite 生产构建 | `/template/*` 不在 Vite 托管范围内，`import()` 保持浏览器原生行为。需要在 `vite.config.ts` 中排除 |
| Electron/Tauri 打包 | Express 仍在本地运行，模板 URL 仍是 `http://localhost:1420/template/...`，不涉及 `file://` 协议问题 |

**Vite 排除配置**：
```ts
// vite.config.ts 关键配置
build: {
  rollupOptions: {
    // 不把 /template/ 路径编译进 bundle
    external: []
  }
}
// dynamic import 的 URL 以 /template/ 开头
// Vite 默认不会把运行时字符串拼接的 URL 编译进 bundle
// 所以 import(`/template/agentdev/${path}.render.js`) 是安全的
```

### 8.4 vendor 依赖处理

当前 `index.html` 从 CDN 加载：
- marked（已通过 `/vendor/marked` 引用 node_modules）
- highlight.js（已通过 `/vendor/openclaw` 引用）
- katex（CDN）
- diff2html（CDN）

迁移方案：
- marked → `npm install marked`，Vite 正常打包
- highlight.js → `npm install highlight.js`，Vite 正常打包
- katex → `npm install katex`，Vite 正常打包
- diff2html → `npm install diff2html`，Vite 正常打包

不再需要 `/vendor` 路由和 CDN fallback。

---

## 九、滚动问题的终极解决方案

### 9.1 当前滚动 bug 的完整因果链

```
poll() → 消息变化 → renderCurrentMainView()
  │
  ├── workspace surface → container.innerHTML = newHtml → DOM 全部重建 → scrollTop 丢失
  │
  ├── chat surface（全量）→ container.innerHTML = html → DOM 全部重建 → scrollTop 丢失
  │                                        → 手动 save/restore → 不精确
  │                                        → 所有 input/select 状态丢失
  │                                        → 折叠/展开状态丢失 → 需要手动 syncCollapseStates
  │
  └── chat surface（增量）→ appendNewMessages → insertAdjacentHTML → 相对好
                          → updateLastMessage → 局部 innerHTML → 相对好
                          → 但只要触发一次全量 render()，前面的增量就白费了
```

### 9.2 React 如何根治

```
poll() → setState({ messages }) → React diff
  │
  ├── 新增消息 → React 追加新 DOM 节点 → 已有消息不动 → scrollTop 自然保持
  │
  ├── 末条消息变化 → React 只更新最后一个 MessageRow → 其他不动
  │
  ├── workspace surface → React diff 只更新变化的属性 → 不重建整个 DOM
  │
  └── 不再需要：
      - savedScrollTop 手动 save/restore
      - followLatestEnabled / suppressFollowScrollEvent 竞态控制
      - scheduleScrollToLatest 防抖
      - syncCollapseStates 手动同步
      - expandedProjectIds / savedPhTabState 手动保存
```

`useFollowLatest` Hook 可以简化为：

```
useFollowLatest(containerRef, messages.length)
  - 监听 messages.length 变化
  - 如果用户在底部（距底 < 100px），自动 scrollToBottom
  - 如果用户手动上滚，停止自动追踪
  - 不需要 suppressFollowScrollEvent / followScrollSettleToken 等复杂状态机
```

---

## 十、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Vite proxy 与 Express 路由冲突 | 低 | 高 | Phase 0 充分验证代理链路 |
| Feature 模板 dynamic import 被 Vite 拦截 | 低 | 高 | `/template/*` 路径以斜杠开头，Vite 默认不处理绝对路径的 import() |
| 迁移过程中功能回退 | 中 | 中 | 保持旧入口可用（`?legacy=1`），逐页面灰度切换 |
| Flow Editor 集成困难 | 中 | 低 | 备选方案：iframe 隔离 |
| CSS 与 React 组件不兼容 | 低 | 低 | CSS 是全局的，不依赖框架；className 映射即可 |
| 工作量超预期 | 中 | 中 | Phase 1 完成后可以暂停，新旧共存 |

---

## 十一、关键约束与原则

1. **后端不动**：server.js 所有路由逻辑、ViewerWorker 代理逻辑、agent 管理逻辑完全不变
2. **API 契约不变**：所有 HTTP 端点的 URL、请求格式、响应格式不变
3. **Feature 模板协议不变**：`export default { call, result }` 返回 HTML string 的契约不变
4. **渐进迁移**：每个 Phase 完成后系统可运行，不需要一次性切换
5. **可回退**：迁移过程中保持旧入口可用，直到 Phase 6 才删除旧代码
6. **CSS 先搬后优化**：先将现有 CSS 原样引入，功能稳定后再考虑 CSS Modules 或 Tailwind
7. **生产构建兼容 Express**：Vite 输出静态文件，由 Express 提供，不引入额外的静态文件服务器
