# 任务文档：编程小助手项目持久化 — 支持空项目

## 一、目标与意图

### 问题描述

当前 `programming-helper`（编程小助手）工作空间中，"项目"不是独立持久化的实体，而是从 session 列表按 `openDirectory` 字段动态分组派生的虚拟视图。这带来两个问题：

1. **新建项目必须立即创建 session**：用户点击"新项目"→ 选目录后，代码立即创建一个新 session 并自动切进去。没有"只建项目不建对话"的路径。
2. **空项目自动消失**：某个目录下所有 session 被删完后，该项目卡片从 UI 完全消失，无法保留。

### 期望行为

1. 项目作为独立实体持久化，允许存在空项目（零 session）
2. "新项目"按钮只创建项目记录（选目录 → 保存），不自动创建 session
3. 空项目卡片在 UI 中可见，显示"暂无对话"和醒目的"新对话"入口
4. 删除项目时同时删除所有关联 session 和项目记录本身
5. 老用户升级时，已有 session 的目录自动迁移为持久化项目

### 制约因素（绝对不能动）

- **`feature-creator` 和 `agent-creator`** 的项目逻辑完全不动。它们有自己的 `featureProjects` / `agentProjects` 体系。
- **`flow-workspace`** 的 `assembly-form` / `agentProjects` 不动。它有完全不同的项目管理模型。
- **session 创建/激活/切换流程**不动，只改"新建项目"入口的行为。
- **"新对话N"标题逻辑**不动（上一轮已完成）。
- **`startup-form` 清理**不动（上一轮已完成）。

---

## 二、现有架构分析

### 2.1 项目如何派生（当前实现）

**文件：`public/src/app-ui.js` L773-824**

`getProgrammingHelperProjects(agent)` 函数：
1. 获取该 agent 的所有 workspace sessions
2. 按 `openDirectory`（路径归一化后）分组到 `Map`
3. 每个 group 生成一个 project 对象，包含 `id`、`name`、`sessions`、`conversationCount`、`latestSessionId`、`updatedAt`
4. 按 `updatedAt` 降序排列返回

**关键特征**：如果一个 `openDirectory` 没有任何 session，它不会出现在结果中。

### 2.2 "新项目"按钮流程（当前实现）

**文件：`public/src/app-main.js` L2073-2107**

`window.phSelectDirectoryAndCreateSession()`：
1. 调用 `invoke('select_directory')` 弹出系统目录选择器
2. 调用 `openPrebuiltWorkspaceSession('programming-helper', { type: 'create_session', openDirectory: chosenPath })`
3. `openPrebuiltWorkspaceSession` 内部 POST 到 `/protoclaw/prebuilt_sessions`
4. 服务端 `createPrebuiltSession()` 创建 session 记录
5. `startManagedAgent()` 启动 runtime
6. 前端 `switchAgent(runtimeId)` 切入对话界面

**问题**：整个流程是"选目录 → 创建 session → 切入对话"，没有中间态。

### 2.3 项目删除流程（当前实现）

**文件：`public/src/app-main.js` L3494-3541**

programming-helper 分支：
1. `confirm()` 弹窗确认
2. 从 `getProgrammingHelperProjects()` 找到目标项目
3. 过滤出匹配 `openDirectory` 的所有 session
4. 逐个 POST `/protoclaw/prebuilt_sessions/delete` 删除 session
5. 如果删的是当前活跃 session，调用 `applyManagedPrebuiltAgent(pendingAgentId, null)`
6. 刷新 session 列表和 UI

**特征**：只删 session，没有"删项目记录"的概念（因为项目本来不存在）。

### 2.4 Workspace State 存储位置与结构

**位置**：`%USERPROFILE%\.agentdev\AgentDevClaw\workspaces\programming-helper\state.json`

**当前结构**（经上一轮 startup-form 清理后）：
```json
{
  "forms": {},
  "assemblyConfigs": [],
  "featureProjects": [],
  "agentProjects": [],
  "openDirectory": "",
  "updatedAt": "2026-05-27T15:16:57.659Z"
}
```

**关键函数**：
- `readWorkspaceState(agentId)` — server.js L1277，带 5 秒内存缓存
- `writeWorkspaceState(agentId, rawState)` — server.js L1297，写入前经过 `normalizeWorkspaceState()`
- `normalizeWorkspaceState(raw)` — server.js L684，标准化所有字段

### 2.5 Session Index 存储位置与结构

**位置**：`%USERPROFILE%\.agentdev\AgentDevClaw\workspaces\programming-helper\sessions\index.json`

**结构**：
```json
{
  "activeSessionId": "session-1779890101225-26b52f",
  "sessions": [
    {
      "id": "session-1779890101225-26b52f",
      "title": "新对话1",
      "formId": "",
      "openDirectory": "D:\\GithubDownload\\openclaw",
      "sessionType": "main",
      "metadata": {},
      "createdAt": "2026-05-27T13:55:01.225Z",
      "updatedAt": "2026-05-27T13:59:50.525Z"
    }
  ]
}
```

**关键函数**：
- `readSessionIndex(agentId)` — server.js L1916
- `writeSessionIndex(agentId, index)` — server.js L1993
- `updateSessionIndex(agentId, fn)` — server.js L2002，带互斥锁的读写

### 2.6 其他 workspace 的项目持久化模式（参照）

**flow-workspace**：
- workspace state 中存 `agentProjects` 数组
- `syncFlowAssemblyProjects(state, timestamp)` 在每次 `writeWorkspaceState` 时自动同步
- `upsertWorkspaceAgentProject(state, project, timestamp)` 做 upsert
- 项目对象包含 `id`、`agentName`、`openDirectory`、`goal`、`managedBy` 等

**feature-creator**：
- workspace state 中存 `featureProjects` 数组
- `syncFeatureCreatorProjects(state, timestamp)` 在每次 `writeWorkspaceState` 时同步
- `upsertWorkspaceFeatureProject(state, project, timestamp)` 做 upsert

**模式总结**：normalize → upsert/remove → sync → write。programming-helper 需要照此模式新增 `phProjects`。

### 2.7 已有项目删除基础设施

**`deletePrebuiltProject(agentId, projectId)`** — server.js L3259-3317

这是一个通用函数，已经处理了：
- 从 workspace state 的项目数组中移除项目记录
- 从 session index 中过滤并删除匹配的 session
- 清理 session 文件
- 返回删除结果

当前 `projectsKey` 选择逻辑：
```javascript
const projectsKey = normalizedAgentId === 'feature-creator' ? 'featureProjects' : 'agentProjects';
```
只需加一个 `programming-helper` 分支指向 `phProjects` 即可复用。

### 2.8 已有前端 workspace state 更新函数

**`updateAgentWorkspaceState(agentId, nextState)`** — app-ui.js L852
```javascript
function updateAgentWorkspaceState(agentId, nextState) {
  for (const agent of allAgents) {
    if (agent.id === agentId) {
      agent.workspace_state = nextState;
    }
  }
}
```
前端刷新 workspace state 的标准方式。调完 `fetch('/protoclaw/workspace_state?agentId=...')` 后用它更新本地缓存。

---

## 三、设计方案

### 核心决策：在 workspace state 中新增 `phProjects` 数组

为什么不复用 `agentProjects`？因为 `agentProjects` 承载了 `agentName`、`installMode`、`runtimeStyle`、`plannedFeatures` 等 flow-workspace 专属语义。programming-helper 的项目只需要 `openDirectory` + 时间戳，用 `phProjects` 更干净，也避免 normalize 函数互相干扰。

### 3.1 数据结构

```javascript
// phProjects 中每个条目
{
  id: "dir:d:/githubdownload/openclaw",       // 'dir:' + 归一化路径小写
  openDirectory: "D:\\GithubDownload\\openclaw", // 原始路径保留
  createdAt: "2026-05-28T10:00:00.000Z",
  updatedAt: "2026-05-28T10:00:00.000Z",
}
```

`id` 的生成规则与前端 `getProgrammingHelperProjects()` 中完全一致：`'dir:' + openDirectory.replace(/\\/g, '/').toLowerCase()`。

### 3.2 server.js 修改清单

#### 3.2.1 新增 `normalizeWorkspacePhProject(raw)`

位置：与其他 normalize 函数同区（~L1035 附近）。

```javascript
function normalizeWorkspacePhProject(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const openDirectory = typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '';
  if (!openDirectory) return null;
  return {
    id: 'dir:' + openDirectory.replace(/\\/g, '/').toLowerCase(),
    openDirectory,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}
```

#### 3.2.2 修改 `normalizeWorkspaceState(raw)` — 增加 `phProjects`

位置：server.js ~L745（`agentProjects` 之后）。

```javascript
const phProjects = Array.isArray(raw?.phProjects)
  ? raw.phProjects.map(p => normalizeWorkspacePhProject(p)).filter(Boolean)
  : [];
```

返回对象中加 `phProjects`。

#### 3.2.3 新增 `upsertWorkspacePhProject(state, rawProject, timestamp)`

位置：与 `upsertWorkspaceFeatureProject` 同区（~L1160）。

```javascript
function upsertWorkspacePhProject(state, rawProject, timestamp) {
  const project = normalizeWorkspacePhProject({
    ...(rawProject || {}),
    updatedAt: timestamp,
  });
  if (!project) return state;
  const projects = Array.isArray(state.phProjects) ? [...state.phProjects] : [];
  const existingIndex = projects.findIndex(item => item?.id === project.id);
  const existing = existingIndex >= 0 ? projects[existingIndex] : null;
  const merged = {
    ...(existing || {}),
    ...project,
    createdAt: existing?.createdAt || project.createdAt || timestamp,
    updatedAt: timestamp,
  };
  if (existingIndex >= 0) {
    projects.splice(existingIndex, 1, merged);
  } else {
    projects.push(merged);
  }
  projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { ...state, phProjects: projects };
}
```

#### 3.2.4 新增 `removeWorkspacePhProject(state, projectId)`

```javascript
function removeWorkspacePhProject(state, projectId) {
  const projects = Array.isArray(state.phProjects)
    ? state.phProjects.filter(p => p.id !== projectId)
    : [];
  return { ...state, phProjects: projects };
}
```

#### 3.2.5 修改 `deletePrebuiltProject()` — L3268

当前：
```javascript
const projectsKey = normalizedAgentId === 'feature-creator' ? 'featureProjects' : 'agentProjects';
```
改为：
```javascript
const projectsKey = normalizedAgentId === 'feature-creator'
  ? 'featureProjects'
  : normalizedAgentId === 'programming-helper'
    ? 'phProjects'
    : 'agentProjects';
```

session 过滤逻辑不需要改——现有的 `matchesDir` 逻辑（L3291）已经按 `openDirectory` 匹配，适用于 programming-helper。

但注意 `matchesName` 逻辑（L3292）会因 `projectFeatureName` 为空而跳过，不影响。唯一需要注意的是 `projectOpenDirectory` 的获取：当前从 `project.openDirectory` 读取（L3279），`phProjects` 中也有这个字段，所以无需改动。

#### 3.2.6 新增 `POST /protoclaw/ph_project/add` 端点

位置：与其他 programming-helper 端点同区。

```javascript
app.post('/protoclaw/ph_project/add', express.json(), async (req, res, next) => {
  try {
    const openDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!openDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
```

注意：不需要独立的 `ph_project/delete` 端点，因为已有的 `/protoclaw/prebuilt_project/delete`（L6336）调用 `deletePrebuiltProject()`，扩展后即可覆盖 programming-helper。

#### 3.2.7 迁移：`readWorkspaceState()` 中为 programming-helper 自动 seed `phProjects`

位置：server.js `readWorkspaceState()` 函数内（L1277），在现有 `startup-form` 清理逻辑之后加。

```javascript
if (key === 'programming-helper' && !Array.isArray(data.phProjects) || (Array.isArray(data.phProjects) && data.phProjects.length === 0)) {
  // 从 session index 中提取所有 openDirectory，回填到 phProjects
  const sessionIndex = await readSessionIndex(key);
  const directories = new Map();
  for (const session of (sessionIndex?.sessions || [])) {
    const dir = String(session.openDirectory || '').trim();
    if (dir && !directories.has(dir.replace(/\\/g, '/').toLowerCase())) {
      directories.set(dir.replace(/\\/g, '/').toLowerCase(), {
        openDirectory: dir,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      });
    }
  }
  if (directories.size > 0) {
    const timestamp = new Date().toISOString();
    data.phProjects = Array.from(directories.values()).map(d =>
      normalizeWorkspacePhProject({ ...d, createdAt: d.createdAt || timestamp, updatedAt: d.updatedAt || timestamp })
    ).filter(Boolean);
    writeWorkspaceState(key, data).catch(() => {});
    _wsCache.delete(key);
  }
}
```

**设计考量**：只在 `phProjects` 为空时执行迁移（非空说明已经迁移过或用户通过新流程创建过）。取每个 session 的最早 `createdAt` 和最晚 `updatedAt` 作为项目时间戳。

### 3.3 public/src/app-ui.js 修改清单

#### 3.3.1 修改 `getProgrammingHelperProjects()` — L773-824

在 session 循环之前，加 `phProjects` seed：

```javascript
function getProgrammingHelperProjects(agent = getCurrentAgentRecord()) {
  if (agent?.id !== 'programming-helper') return [];

  const workspaceState = getAgentWorkspaceState(agent);  // ← 新增
  const sessions = getWorkspaceSessions(agent);
  const projects = new Map();

  const upsertProject = (rawProject = {}) => {
    // ... 现有逻辑完全不变 ...
  };

  // ↓↓↓ 新增：从持久化的 phProjects seed ↓↓↓
  const stateProjects = Array.isArray(workspaceState?.phProjects) ? workspaceState.phProjects : [];
  stateProjects.forEach(project => upsertProject(project));
  // ↑↑↑ 新增结束 ↑↑↑

  sessions.forEach((session) => {
    // ... 现有逻辑完全不变 ...
  });

  return Array.from(projects.values())
    .map(/* ... 现有逻辑完全不变 ... */)
    .sort(/* ... 现有逻辑完全不变 ... */);
}
```

**效果**：
- `phProjects` 中的目录即使没有任何 session 也会生成一个 project 条目（`sessions: []`, `conversationCount: 0`）
- 有 session 的目录会叠加 session 数据，与现有行为一致

#### 3.3.2 空项目卡片渲染增强 — L1976-1977

当前空项目的 session 列表区域只显示一个灰色的"暂无对话"提示。修改为在提示下方加一个"新对话"按钮：

当前代码（L1976-1977）：
```javascript
sessionsHtml = '<div class="feature-project-session-group"><div class="feature-project-session-list">'
  + (mainSessions.length > 0 ? mainSessions.map(s => renderPhSessionItem(s, 'main')).join('') : '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>')
  + '</div></div>';
```

修改为：
```javascript
const emptyNote = '<div class="feature-project-empty-note">' + escapeHtml(t('workspace_feature_no_sessions')) + '</div>';
const emptyChatBtn = '<div class="feature-project-empty-actions"><button class="workspace-action" type="button" data-workspace-action="' + newChatAction + '" onclick="window.runWorkspaceActionFromEvent(event, this.dataset.workspaceAction)">' + escapeHtml(t('workspace_new_chat')) + '</button></div>';

sessionsHtml = '<div class="feature-project-session-group"><div class="feature-project-session-list">'
  + (mainSessions.length > 0 ? mainSessions.map(s => renderPhSessionItem(s, 'main')).join('') : emptyNote + emptyChatBtn)
  + '</div></div>';
```

同理，tabs 模式下的 main panel（L1972）也需要同样处理。

### 3.4 public/src/app-main.js 修改清单

#### 3.4.1 修改 `phSelectDirectoryAndCreateSession()` — L2073-2107

**改为只创建项目，不创建 session**：

```javascript
window.phSelectDirectoryAndCreateSession = async () => {
  const currentAgent = getCurrentAgentRecord();
  if (!currentAgent || currentAgent.id !== 'programming-helper') {
    console.error('Not in programming-helper workspace');
    return;
  }

  try {
    const result = await invoke('select_directory');
    const chosenPath = Array.isArray(result?.paths) ? String(result.paths[0] || '').trim() : (typeof result?.path === 'string' ? result.path.trim() : '');
    if (!chosenPath) return;

    // 只添加项目记录，不创建 session
    const addRes = await fetch('/protoclaw/ph_project/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openDirectory: chosenPath }),
    });
    if (!addRes.ok) {
      throw new Error(await addRes.text().catch(() => 'Failed to add project'));
    }

    // 刷新本地 workspace state
    const stateRes = await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent('programming-helper'));
    if (stateRes.ok) {
      const nextState = await stateRes.json();
      updateAgentWorkspaceState('programming-helper', nextState);
    }

    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  } catch (error) {
    console.error('Failed to add project:', error);
    window.alert((currentLanguage === 'zh' ? '添加项目失败：' : 'Failed to add project: ') + (error?.message || error));
    lastRenderedWorkspaceHtml = '';
    renderCurrentMainView();
  }
};
```

#### 3.4.2 修改项目删除 — L3494-3541

**改用统一的 `deletePrebuiltProject` 端点**：

```javascript
if (pendingAgentId === 'programming-helper') {
  const confirmed = window.confirm(
    currentLanguage === 'zh'
      ? '确定要删除项目「' + projectName + '」吗？该项目下的所有对话记录将一并删除，此操作不可撤销。'
      : 'Delete project "' + projectName + '"? All conversations under this project will also be deleted. This cannot be undone.'
  );
  if (!confirmed) return;
  (async () => {
    try {
      const response = await fetch('/protoclaw/prebuilt_project/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: pendingAgentId, projectId: pendingProjectId }),
      });
      if (!response.ok) {
        throw new Error(await response.text().catch(() => 'delete project failed'));
      }
      const result = await response.json();

      // 如果删的是当前活跃 session，清除 runtime
      const agent = allAgents.find(a => a.id === pendingAgentId);
      const activeSessionId = agent?.active_workspace_session_id || null;
      if (result.deletedSessionIds?.includes(activeSessionId)) {
        applyManagedPrebuiltAgent(pendingAgentId, null);
      }

      // 刷新本地数据
      if (result.sessions) {
        updateAgentRecord(pendingAgentId, {
          workspace_sessions: result.sessions,
          active_workspace_session_id: result.sessions?.activeSessionId || null,
        });
      }

      // 刷新 workspace state（phProjects 已被服务端清理）
      const stateRes = await fetch('/protoclaw/workspace_state?agentId=' + encodeURIComponent(pendingAgentId));
      if (stateRes.ok) {
        const nextState = await stateRes.json();
        updateAgentWorkspaceState(pendingAgentId, nextState);
      }

      await loadAgents();
      lastRenderedWorkspaceHtml = '';
      renderAgentList();
      renderCurrentMainView();
    } catch (error) {
      console.error('Failed to delete programming-helper project:', error);
      window.alert((currentLanguage === 'zh' ? '删除项目失败：' : 'Failed to delete project: ') + (error?.message || error));
    }
  })();
  return;
}
```

---

## 四、执行顺序

建议按此顺序实现，每步可独立验证：

1. **server.js**：`normalizeWorkspacePhProject` + `normalizeWorkspaceState` 加 `phProjects`
2. **server.js**：`upsertWorkspacePhProject` + `removeWorkspacePhProject`
3. **server.js**：`POST /protoclaw/ph_project/add` 端点
4. **server.js**：扩展 `deletePrebuiltProject` 的 `projectsKey` 选择
5. **server.js**：`readWorkspaceState` 迁移逻辑
6. **app-ui.js**：`getProgrammingHelperProjects` 加 phProjects seed
7. **app-ui.js**：空项目卡片渲染增强
8. **app-main.js**：`phSelectDirectoryAndCreateSession` 改为只建项目
9. **app-main.js**：项目删除改用统一端点

---

## 五、验证清单

1. `npm start` → 进入编程小助手
2. 点击"新项目" → 选目录 → 项目卡片出现，无 session，显示"暂无对话"+"新对话"按钮
3. 点空项目的"新对话" → 创建 session，标题"新对话1"
4. 同目录再建一个 session → "新对话2"
5. 删掉所有 session → 项目卡片仍在（空项目）
6. 删除整个项目 → 项目消失，session 全清
7. 选一个已有 session 的旧目录新建项目 → 应 upsert 而非重复
8. 老用户升级验证：重启后已有 session 的目录自动出现在项目列表中
9. feature-creator / agent-creator / flow-workspace 新建/删除流程不受影响

---

## 六、关键文件索引

| 文件 | 关键位置 | 作用 |
|------|----------|------|
| `server.js` L684 | `normalizeWorkspaceState()` | workspace state 标准化，需加 `phProjects` |
| `server.js` ~L1035 | normalize 函数区 | 新增 `normalizeWorkspacePhProject` |
| `server.js` ~L1160 | upsert 函数区 | 新增 `upsertWorkspacePhProject`、`removeWorkspacePhProject` |
| `server.js` L1277 | `readWorkspaceState()` | 加迁移：seed phProjects from sessions |
| `server.js` L1297 | `writeWorkspaceState()` | 不需改，normalize 已处理 |
| `server.js` L1916 | `readSessionIndex()` | 迁移逻辑中读取 session |
| `server.js` L2002 | `updateSessionIndex()` | 删除时修改 session index |
| `server.js` L3259 | `deletePrebuiltProject()` | 扩展 projectsKey 三路选择 |
| `server.js` L6336 | `POST /protoclaw/prebuilt_project/delete` | 已有端点，复用 |
| `server.js` 端点区 | 新增 `POST /protoclaw/ph_project/add` | 添加项目 |
| `app-ui.js` L773 | `getProgrammingHelperProjects()` | 加 phProjects seed |
| `app-ui.js` L846 | `getAgentWorkspaceState()` | 读取 workspace state |
| `app-ui.js` L852 | `updateAgentWorkspaceState()` | 更新本地 workspace state |
| `app-ui.js` L1887-2026 | programming-helper 渲染区 | 空项目卡片增强 |
| `app-main.js` L2073 | `phSelectDirectoryAndCreateSession()` | 改为只建项目 |
| `app-main.js` L3494 | programming-helper 项目删除 | 改用统一端点 |
| `app-main.js` L599 | `openPrebuiltWorkspaceSession()` | 不改，"新对话"按钮仍走此路径 |
