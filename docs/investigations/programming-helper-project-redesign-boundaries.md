# 编程小助手项目化改造：边界分析与数据流

## 一、当前系统架构理解

### 1.1 两层数据模型

系统中有两个概念容易混淆：

**Workspace Session（工作空间会话）**：
- 持久化的会话记录
- 存储位置：`~/.agentdev/AgentDevClaw/prebuilt-sessions/<agentId>/`
- 数据结构：
  - `index.json`：会话注册表，包含 `activeSessionId` 和 `sessions[]`
  - `session-<id>.json`：各次会话的完整快照
- 作用：记录历史，可恢复、可查看

**Runtime Session（运行时会话）**：
- 实际运行的 agent 实例
- 在 ViewerWorker 中注册，有独立的消息流
- 出现位置：左侧"外部代理"列表
- 数据标识：`runtime_session_id` 或 `runtimeSessionId`
- 生命周期：随 agent 启动/停止

### 1.2 activeSessionId 的语义

`activeSessionId` 存在于两个层次：

1. **Session Index 中**：`index.json.activeSessionId`
   - 标记当前活跃的 workspace session
   - 作用：前端判断哪个会话是"当前"的

2. **Agent Record 中**：`agent.active_workspace_session_id` 或 `agent.workspace_sessions.activeSessionId`
   - 动态数据，从 session index 读取
   - 作用：前端渲染时显示"当前"标记

### 1.3 当前对话的显示位置

在当前实现中，"当前对话"出现在：

1. **工作空间内**：session-list block 中显示 `<span class="workspace-history-active">当前</span>`
2. **外部代理列表**：runtime session 作为独立项显示
3. **live block**：`visibility: 'chat-header-only'` 的 block 显示运行时信息

### 1.4 feature-creator 的折叠菜单实现

**关键代码**（`app-ui.js:1249-1273`）：

```javascript
'<details class="feature-project-disclosure">',
'<summary>',
'<div class="feature-project-row">',
...
'</summary>',
'<div class="feature-project-body">',
sessionsHtml,  // 该项目的所有会话
'</div>',
'</details>',
```

**项目分组逻辑**（`app-ui.js:194-275`）：

```javascript
function getFeatureCreatorProjects(agent) {
  const projects = new Map();

  // 1. 从 workspace state.featureProjects 读取项目元数据
  const stateProjects = workspaceState?.featureProjects || [];
  stateProjects.forEach((project) => upsertProject(project));

  // 2. 从 startup-form 读取当前正在创建的项目
  upsertProject({
    featureName: startupForm.feature_name,
    targetDir: startupForm.target_dir,
    ...
  });

  // 3. 从所有 sessions 中提取项目（按 openDirectory 分组）
  sessions.forEach((session) => {
    const project = upsertProject({
      featureName: session.featureName,
      openDirectory: session.openDirectory,
      ...
    });
    project.sessions.push(session);
  });

  return Array.from(projects.values());
}
```

**关键观察**：
- 项目 ID 生成：`buildWorkspaceProjectKey({ openDirectory, featureName })` → `dir:<path>` 或 `feature:<name>@<dir>`
- 项目去重：用 `Map` 按 ID 合并来自 state/form/session 的数据
- 会话归属：每个 session 通过 `openDirectory` 或 `featureName` 关联到项目

## 二、目标产品形态

### 2.1 用户期望

1. **工作空间内**：
   - 显示项目列表（折叠菜单）
   - 每个项目显示该项目的所有会话
   - **不显示"当前对话"标记**（这是关键改动）
   - 每个项目可以点击"新建会话"

2. **外部代理列表**：
   - 所有运行中的会话都出现在这里
   - 点击某个会话 = 切换到对应的 runtime session

3. **项目概念**：
   - 项目 = 工作目录（`openDirectory`）
   - 项目名称 = 目录名的最后一段

### 2.2 与 feature-creator 的差异

| 维度 | feature-creator | programming-helper（目标） |
|------|----------------|--------------------------|
| 项目标识 | `featureName + targetDir` | `openDirectory`（纯目录） |
| 项目来源 | startup-form 的 feature_name | workspace state 的 openDirectory |
| 会话归属 | `session.featureName + session.openDirectory` | `session.openDirectory` |
| 表单依赖 | 强依赖（feature_name 必填） | 弱依赖（目录可选） |

## 三、数据流调整

### 3.1 当前数据流（feature-creator）

```text
用户填写 startup-form
  ↓
写入 workspace.state.forms['startup-form']
  ↓
创建 session 时，从 form 读取 featureName、targetDir
  ↓
session 记录 featureName、openDirectory
  ↓
前端渲染时，按 featureName+openDirectory 分组项目
```

### 3.2 目标数据流（programming-helper）

```text
用户选择/切换工作目录
  ↓
写入 workspace.state.openDirectory
  ↓
创建 session 时，从 workspace state 读取 openDirectory
  ↓
session 记录 openDirectory
  ↓
前端渲染时，按 openDirectory 分组项目
  ↓
点击项目的"新建会话" = 创建新 session（继承项目的 openDirectory）
```

### 3.3 关键差异

1. **不需要表单**：
   - feature-creator 必须填 feature_name
   - programming-helper 只需要 openDirectory（可为空）

2. **项目名称来源**：
   - feature-creator：用户填写的 `feature_name`
   - programming-helper：`openDirectory` 的最后一段（如 `D:\code\AgentDevClaw` → `AgentDevClaw`）

3. **项目元数据**：
   - feature-creator：有 `featureProjects` 数组（显式项目列表）
   - programming-helper：不需要，从 sessions 动态分组即可

## 四、关键修改点

### 4.1 metadata.json

**当前状态**：
- 只有 `session-list` block
- `headerAction` 创建 session 时没有 `openDirectory`

**目标状态**：
- 保留 `session-list` block，但改造渲染逻辑
- 新增 `project-list` block（或复用 session-list，换渲染函数）
- `headerAction` 创建 session 时需要传入 `openDirectory`（从项目上下文获取）

### 4.2 app-ui.js：新增 `getProgrammingHelperProjects`

仿照 `getFeatureCreatorProjects`，实现：

```javascript
function getProgrammingHelperProjects(agent) {
  if (agent?.id !== 'programming-helper') return [];

  const workspaceState = getAgentWorkspaceState(agent);
  const sessions = getWorkspaceSessions(agent);
  const projects = new Map();

  const upsertProject = (rawProject = {}) => {
    const openDirectory = String(rawProject.openDirectory || '').trim();
    if (!openDirectory) return null;

    const id = `dir:${openDirectory.replace(/\\/g, '/').toLowerCase()}`;
    const projectName = getPathLeaf(openDirectory);

    const existing = projects.get(id);
    const merged = existing ? {
      ...existing,
      updatedAt: existing.updatedAt || rawProject.updatedAt,
      sessions: existing.sessions || [],
    } : {
      id,
      type: 'directory',
      openDirectory,
      name: projectName,
      sessions: [],
      createdAt: rawProject.createdAt,
      updatedAt: rawProject.updatedAt,
    };
    projects.set(id, merged);
    return merged;
  };

  // 从所有 sessions 中提取项目
  sessions.forEach((session) => {
    const project = upsertProject({
      openDirectory: session.openDirectory,
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
    });
    if (project) {
      project.sessions.push(session);
    }
  });

  return Array.from(projects.values())
    .map((project) => ({
      ...project,
      sessions: project.sessions.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))),
      conversationCount: project.sessions.length,
      updatedAt: project.sessions[0]?.updatedAt || project.updatedAt || '',
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}
```

### 4.3 app-ui.js：新增 `renderProgrammingHelperProjects`

仿照 `renderFeatureCreatorProjects`，实现折叠菜单：

```javascript
function renderProgrammingHelperProjects(agent) {
  const projects = getProgrammingHelperProjects(agent);
  const activeSessionId = agent?.active_workspace_session_id || agent?.workspace_sessions?.activeSessionId || null;

  if (projects.length === 0) {
    return '<div class="workspace-empty-note">' + escapeHtml(currentLanguage === 'zh' ? '暂无项目，点击下方按钮选择工作目录并开始新的对话' : 'No projects yet. Select a working directory to start.') + '</div>';
  }

  return '<div class="feature-project-list">' + projects.map((project) => {
    const sessionsHtml = project.sessions.length > 0
      ? project.sessions.map((session) => renderProjectSessionItem(session, project.openDirectory, activeSessionId)).join('')
      : '<div class="feature-project-empty-note">' + escapeHtml(currentLanguage === 'zh' ? '该项目下暂无对话记录' : 'No conversations in this project') + '</div>';

    return [
      '<div class="feature-project-card" data-prebuilt-project-agent-id="' + escapeHtml(agent.id) + '" data-prebuilt-project-id="' + escapeHtml(project.id) + '">',
      '<details class="feature-project-disclosure">',
      '<summary>',
      '<div class="feature-project-row">',
      '<div class="feature-project-summary">',
      '<div class="feature-project-titlebar">',
      '<div class="workspace-history-title">' + escapeHtml(project.name) + '</div>',
      // 注意：不再显示"当前"标记
      '</div>',
      '<div class="feature-project-meta-line"><span>' + escapeHtml(formatWorkspaceDate(project.updatedAt)) + '</span></div>',
      project.openDirectory ? '<div class="workspace-history-meta">' + escapeHtml(project.openDirectory) + '</div>' : '',
      '</div>',
      '<div class="feature-project-toggle" data-label-collapsed="' + escapeHtml(t('workspace_expand_records')) + '" data-label-expanded="' + escapeHtml(t('workspace_collapse_records')) + '" aria-hidden="true"><span class="feature-project-count">' + escapeHtml(String(project.conversationCount || 0)) + '</span></div>',
      '</div>',
      '</summary>',
      '<div class="feature-project-body">',
      sessionsHtml,
      '</div>',
      '</details>',
      '</div>',
    ].join('');
  }).join('') + '</div>';
}
```

### 4.4 metadata.json：移除 activeSessionId 显示

在 `renderProjectSessionItem` 中，**不再渲染** `<span class="workspace-history-active">当前</span>`。

原因：用户明确说"不要有'当前对话'这个概念了"。

### 4.5 metadata.json：添加"新建会话"按钮到每个项目

有两种设计：

**方案A：在每个项目的折叠列表底部添加按钮**
```html
<div class="feature-project-body">
  sessionsHtml
  '<button class="workspace-action secondary" type="button" onclick="window.createProjectSession(\'' + escapeHtml(project.openDirectory) + '\')">新建会话</button>'
</div>
```

**方案B：在项目标题栏添加加号图标**
```html
'<div class="feature-project-titlebar">',
'<div class="workspace-history-title">' + escapeHtml(project.name) + '</div>',
'<button class="workspace-icon-btn" type="button" onclick="window.createProjectSession(\'' + escapeHtml(project.openDirectory) + '\')" title="新建会话">+</button>',
'</div>',
```

推荐**方案A**：更明确，用户容易发现。

### 4.6 app-main.js：添加 `createProjectSession`

```javascript
window.createProjectSession = async (openDirectory) => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || currentAgent.id !== 'programming-helper') {
    console.error('Not in programming-helper workspace');
    return;
  }

  try {
    const result = await openPrebuiltWorkspaceSession('programming-helper', {
      type: 'create_session',
      openDirectory: openDirectory || '',
    });

    if (result.session) {
      await loadAgents();
      const runtimeId = result.agent?.runtime_session_id || result.agent?.runtimeSessionId || result.agent?.id;
      if (runtimeId) {
        await window.switchAgent(runtimeId);
      }
    }
  } catch (error) {
    console.error('Failed to create session:', error);
    showAgentStartError(error);
  }
};
```

### 4.7 metadata.json：调整 entry 点

当前 `entry: "sessions"` 是正确的（进入后显示会话列表）。

但需要确保 `sessions` tab 上的 block 是新的 `project-list` 类型。

### 4.8 空状态处理

当用户首次进入时：
- 如果没有任何 session，显示"暂无项目"
- 提供"选择工作目录并开始新对话"按钮
- 点击后弹出目录选择器，然后创建 session

### 4.9 CLI 适配

当前 CLI 的 `claw ls` 已经支持 `--dir` 筛选，不需要改动。

但可以考虑添加：
```bash
claw projects          # 列出所有项目（按目录分组）
claw project <path>    # 显示某个项目的详情
```

这不是必须的，可以后续迭代。

## 五、边界与风险

### 5.1 兼容性

**已有数据**：
- 历史 sessions 仍然有 `openDirectory` 字段
- 改造后可以正常显示和分组
- **不影响**已有数据的读取

**前端渲染**：
- 如果 session 没有 `openDirectory`，归入"未分类"项目
- 或直接不显示（因为用户说"项目 = 目录"）

### 5.2 activeSessionId 的清理

**需要清理的位置**：
1. `renderProjectSessionItem`：不再渲染"当前"标记
2. `getProgrammingHelperProjects`：不需要读取 `activeSessionId`
3. `renderProgrammingHelperProjects`：不需要传递 `activeSessionId`

**不需要清理的位置**（因为它是 runtime 层面的）：
- `agent.runtime_session_id`：runtime session 仍然需要
- `agent.active_workspace_session_id`：保留（用于其他逻辑判断）

### 5.3 与 flow-workspace 的区分

- flow-workspace 仍然有"当前对话"概念（因为它是装配运行时）
- programming-helper 去掉"当前对话"（因为对话都在外部代理列表）
- 两者不冲突，因为它们的 agent id 不同

### 5.4 浏览器默认折叠状态

`<details>` 默认是折叠的。可以考虑：
- 默认展开最新的项目（在 HTML 中加 `open` 属性）
- 或记住用户的展开/折叠状态（localStorage）

这不是核心功能，可以后续优化。

## 六、总结

### 核心改动

1. **新增 `getProgrammingHelperProjects`**：按 `openDirectory` 分组 sessions
2. **新增 `renderProgrammingHelperProjects`**：渲染折叠菜单
3. **metadata.json**：将 `session-list` block 改为 `project-list` 类型
4. **移除"当前对话"标记**：不在工作空间内显示 `activeSessionId`
5. **添加"新建会话"按钮**：每个项目都可以创建新 session

### 数据流

```
用户选择目录 → workspace.state.openDirectory
      ↓
创建 session → session.openDirectory = workspace.state.openDirectory
      ↓
前端渲染 → 按 openDirectory 分组项目
      ↓
点击"新建会话" → 创建新 session（继承项目的 openDirectory）
```

### 不做的事

- 不改动 server.js 的 session 管理逻辑
- 不改动 session index 的存储结构
- 不改动"外部代理列表"的显示逻辑
- 不添加新的 npm 依赖

### 风险点

- 如果用户没有选择目录，session 的 `openDirectory` 为空，会话可能无法归类
- 解决：显示"未分类"项目，或在创建时强制要求选择目录
