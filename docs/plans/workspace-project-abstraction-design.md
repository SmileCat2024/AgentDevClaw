# 工作空间项目抽象设计

> 创建时间：2026-05-28
> 状态：Phase 1 实现中
> 策略：渐进式迁移，先实现 programming-helper

---

## 1. 背景与动机

### 1.1 当前问题

各工作空间的项目概念差异巨大：
- **programming-helper**：项目 = 目录（`openDirectory`）
- **feature-creator**：项目 = Feature（`featureName` + `targetDir`）
- **agent-creator**：项目 = Agent（`agentName` + `targetDir`）
- **flow-workspace**：项目 = Agent Project（`assembly-form`）

Dispatch 系统"创建新对话"时，无法统一指定"在哪个项目中"，只能 fallback 到"当前焦点"（`state.json`）。

### 1.2 设计目标

**项目是工作空间内的概念**：
- 每个工作空间有自己的项目定义
- 项目抽象层提供统一接口，各工作空间适配实现

**渐进式迁移**：
- 第一阶段：只实现 programming-helper 的项目抽象
- 其他工作空间逐步迁移，保持向后兼容

**兜底逻辑**：
- 如果工作空间没有实现项目抽象，使用"当前焦点"
- 不破坏现有功能

---

## 2. 核心抽象

### 2.1 项目数据结构

```typescript
interface WorkspaceProject {
  // 项目身份
  id: string;              // 项目唯一标识（工作空间内）
  name: string;            // 项目显示名称
  type: string;            // 项目类型标记（如 'directory', 'assembly', 'feature'）
  
  // 工作空间特定的配置
  config: Record<string, any>;
  
  // 会话归属
  sessionIds: string[];    // 属于该项目的所有会话 ID
  latestSessionId?: string; // 最近活跃的会话
  
  // 元数据
  createdAt?: string;
  updatedAt?: string;
}
```

### 2.2 项目适配器接口

```typescript
interface WorkspaceProjectAdapter {
  workspaceId: string;
  
  // 从 session 提取项目 ID
  extractProjectId(session: SessionRecord): string | null;
  
  // 获取所有项目
  listProjects(): WorkspaceProject[];
  
  // 获取当前激活的项目
  getCurrentProject(): WorkspaceProject | null;
  
  // 根据项目 ID 获取配置（用于创建新 session）
  getProjectConfig(projectId: string): Record<string, any>;
  
  // 更新当前激活的项目
  activateProject(projectId: string): Promise<void>;
}
```

### 2.3 Session Record 扩展

```typescript
interface SessionRecord {
  // ... 现有字段
  
  // 新增：项目归属（由工作空间填充）
  projectId?: string;   // 所属项目 ID
}
```

---

## 3. programming-helper 实现

### 3.1 项目定义

对于 programming-helper：
- 项目 = 目录
- 项目 ID = `dir:${openDirectory.toLowerCase()}`
- 项目配置 = `{ openDirectory }`

### 3.2 适配器实现

后端实现位于 `server.js`，核心接口：

```javascript
class ProgrammingHelperProjectAdapter {
  constructor() { this.workspaceId = 'programming-helper'; }

  // 从 session record 提取项目 ID
  extractProjectId(session) { /* → 'dir:{openDirectory}' */ }

  // 获取当前激活的项目（读 state.json）
  async getCurrentProject() { /* → WorkspaceProject | null */ }

  // 根据 projectId 获取配置（用于创建新 session）
  getProjectConfig(projectId) { /* → { openDirectory } */ }

  // 激活项目（更新 state.json 的 openDirectory）
  async activateProject(projectId) { /* → void */ }
}
```

项目列表聚合逻辑在 `GET /protoclaw/dispatch/projects` API 中：
- 从 `state.json.phProjects` 读取用户添加的项目
- 从 sessions 聚合按 openDirectory 分组的项目
- 合并去重

---

## 4. Dispatch 集成

### 4.1 DispatchSchedule 扩展

```typescript
interface DispatchSchedule {
  // ... 现有字段
  
  // 新增：项目指定（可选）
  projectId?: string;   // 目标项目 ID（由工作空间解释）
}
```

### 4.2 fireDispatchNow 改造

新建 session 时使用项目适配器获取配置：

```
fireDispatchNow(schedule)
  │
  ├─ isNewSession?
  │   │
  │   ├─ adapter = getProjectAdapter(agentId)
  │   │
  │   ├─ schedule.projectId?
  │   │   ├─ 有 → adapter.getProjectConfig(projectId)
  │   │   └─ 无 → await adapter.getCurrentProject() → adapter.getProjectConfig()
  │   │
  │   ├─ 有适配器?
  │   │   ├─ 是 → createOpts = { sessionType, ...projectConfig }
  │   │   └─ 否 → Fallback: 读 state.json.openDirectory
  │   │
  │   └─ createPrebuiltSession(agentId, createOpts)
  │
  └─ 已有 session → activatePrebuiltSession(agentId, sessionId)
```

---

## 5. 兜底逻辑

### 5.1 适配器注册表

```javascript
const projectAdapters = new Map();

function registerProjectAdapter(adapter) {
  projectAdapters.set(adapter.workspaceId, adapter);
}

function getProjectAdapter(agentId) {
  return projectAdapters.get(agentId) || null;
}

// 初始化时只注册 programming-helper
registerProjectAdapter(new ProgrammingHelperProjectAdapter());
```

### 5.2 Fallback 行为

```javascript
// 在 fireDispatchNow 中
const adapter = getProjectAdapter(agentId);
if (adapter && s.projectId) {
  // 使用适配器
  const projectConfig = adapter.getProjectConfig(s.projectId);
  createOpts = { ...createOpts, ...projectConfig };
} else {
  // Fallback：使用当前 state.json（现有行为）
  const currentState = await readWorkspaceState(agentId);
  if (currentState?.openDirectory) {
    createOpts.openDirectory = currentState.openDirectory;
  }
}
```

---

## 6. 数据流

### 6.1 UI 创建调度（明确指定项目）

```javascript
// 用户在前端选择"项目 A"和"10 分钟后提醒"
const schedule = {
  fireAt: '...',
  targetAgentId: 'programming-helper',
  projectId: 'dir:D:/code/project-a',  // 明确项目
  newSessionType: 'main',
  message: '检查测试结果',
};
```

### 6.2 UI 创建调度（使用当前焦点）

```javascript
// 用户只说"10 分钟后提醒"，不指定项目
const schedule = {
  fireAt: '...',
  targetAgentId: 'programming-helper',
  // 没有 projectId
  newSessionType: 'main',
  message: '检查测试结果',
};
// 系统使用 state.json 中的当前激活项目
```

### 6.3 Dispatch 执行

```
fireDispatchNow(schedule)
  ├─ 有 projectId？
  │   ├─ 是 → getProjectAdapter().getProjectConfig(projectId)
  │   └─ 否 → getProjectAdapter().getCurrentProject()?.config
  ├─ 有适配器？
  │   ├─ 是 → 使用适配器返回的配置
  │   └─ 否 → Fallback 到 state.json（现有逻辑）
  └─ createPrebuiltSession(agentId, { sessionType, ...projectConfig })
```

---

## 7. 迁移路径

### Phase 1：programming-helper（当前）

- [x] 定义项目抽象接口（`WorkspaceProjectAdapter` 概念）
- [x] 实现 `ProgrammingHelperProjectAdapter`（server.js）
- [x] 扩展 `DispatchSchedule` 添加 `projectId`
- [x] 改造 `fireDispatchNow` 使用适配器 + 兜底逻辑
- [x] 添加 `GET /protoclaw/dispatch/projects` API
- [x] 更新前端调度 UI 添加项目选择器
- [x] 更新前端 `createDispatchSchedule` 传递 `projectId`
- [ ] 端到端测试三种场景

### Phase 2：其他工作空间（后续）

- [ ] `flow-workspace`：项目 = Agent Project
- [ ] `feature-creator`：项目 = Feature
- [ ] `agent-creator`：项目 = Agent
- [ ] 移除兜底逻辑（所有工作空间都已适配）

---

## 8. 实现要点

### 8.1 向后兼容

- `projectId` 是可选字段
- 没有适配器的工作空间保持现有行为
- 不破坏已有的调度

### 8.2 前端改动

- 调度配置 UI 添加项目选择器
- 项目选择器根据工作空间动态渲染
- 支持不选择项目（使用当前焦点）

### 8.3 测试要点

- 明确指定项目的调度
- 不指定项目的调度（使用当前焦点）
- 跨工作空间的兜底逻辑
- 已有调度的兼容性

---

## 9. 开放问题

1. **项目 ID 格式**：是否需要统一前缀（如 `dir:`、`assembly:`）？
   - 建议：是，便于区分项目类型和调试

2. **项目配置的传递方式**：是通过 `options` 传递，还是直接展开到 `createPrebuiltSession` 参数？
   - 建议：展开到参数，保持现有接口风格

3. **Session Record 的 `projectId` 字段**：是否需要持久化？
   - 建议：需要，便于反向查询"某项目下的所有会话"

4. **前端项目选择器**：如何渲染不同工作空间的项目？
   - 建议：工作空间提供 `renderProjectSelector()` 方法
