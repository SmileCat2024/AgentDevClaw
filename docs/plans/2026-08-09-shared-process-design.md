# 壳层共享进程技术设计

## 1. 目标与范围

### 目标

将 `run-prebuilt-agent.js` 从"一个进程承载一个 Agent 实例"扩展为"一个进程可承载多个同级 Agent 实例"，使同一 agent 在同一项目目录下的多个 session 可以共享一个进程。

### 试点范围

- **试点 agent**：`programming-helper`
- **分组策略**：同 agent + 同项目目录 → 共享进程
- **双模式并存**：共享模式（`shared-by-project`）和独立模式（`isolated`）同时支持，用户可在创建 session 时选择
- **默认行为不变**：非试点 agent 保持 `isolated` 模式，零行为变化

### 不在本次范围

- IM Gateway / Dispatch Loop / GroupChatBridge 的 per-process 化（programming-helper 不使用这些功能）
- 跨 agent 类型的进程共享
- Agent 池化 / headless 模式 / 生产级限流（这是后续方向，本次不涉及）

---

## 2. 配置模型

### 2.1 metadata.json 声明

在 prebuilt agent 的 `metadata.json` 中新增可选字段：

```json
{
  "id": "programming-helper",
  "processMode": "shared-by-project"
}
```

取值：
- `"isolated"`（默认）：每个 session 独占进程（当前行为）
- `"shared-by-project"`：同 agent + 同项目目录的 session 共享进程

未声明 `processMode` 的 agent 一律视为 `"isolated"`。

### 2.2 用户运行时选择

`metadata.processModeOverride` 是 session 级基础设施覆盖字段；创建界面是否暴露该选择属于后续产品层工作，不是共享进程宿主的前置条件。

- **共享进程（推荐）**
  - 多个会话共享内存和工具实例，启动更快，内存占用更低
  - 一个会话的异常可能影响同进程的其他会话
- **独立进程**
  - 完全隔离，更安全，一个会话崩溃不影响其他
  - 每个会话独立加载，内存占用更高，启动更慢

用户选择存储在 session record 的 `metadata.processModeOverride` 字段中，覆盖 metadata.json 的默认声明。

### 2.3 配置读取入口

```js
// agent-startup.js 中
function resolveProcessMode(agent, sessionMetadata) {
  // 1. Session 级 override 优先
  if (sessionMetadata?.processModeOverride === 'isolated') return 'isolated';
  if (sessionMetadata?.processModeOverride === 'shared-by-project') return 'shared-by-project';
  // 2. Agent 级 metadata.json 声明
  return agent.processMode || 'isolated';
}
```

---

## 3. 进程组抽象

### 3.1 processGroupKey 计算

```js
function computeProcessGroupKey(agentId, projectDir) {
  if (!projectDir) return null; // 无项目目录时不共享
  const normalized = projectDir.replace(/\\/g, '/').toLowerCase();
  return `${sanitizeSessionFragment(agentId)}::${normalized}`;
}
```

### 3.2 managedAgents 数据结构扩展

`managedAgents` Map 保持 1 条目 / session 不变。每个 runtime 条目新增字段：

```js
{
  // ... 现有字段保持不变
  processGroupKey: null | string,  // null = isolated 模式
}
```

### 3.3 新增辅助函数（agent-access.js）

```js
/** 查找同一进程组中正在运行的 runtime */
export function findSharedProcessRuntime(processGroupKey) {
  if (!processGroupKey) return null;
  return Array.from(managedAgents.values())
    .find(rt => rt.processGroupKey === processGroupKey && isManagedRuntimeRunning(rt)) || null;
}
```

---

## 4. run-prebuilt-agent.js 重构方案

### 4.1 核心思路：提取 SessionLifecycle

将当前 `main()` 中围绕单个 session 的全部生命周期逻辑提取为 `SessionLifecycle` 类。进程本身从"单 agent 脚本"变为"session 生命周期管理器"。

### 4.2 SessionLifecycle 类

```js
class SessionLifecycle {
  constructor({ agentId, sessionId, agentDir, agentName, workspaceCwd, serverOrigin }) {
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.agent = null;
    this.callArbiter = null;
    this.resolved = null;
    this.disposed = false;
    this.imBridge = null;
    this.summaryHandlers = null;
    this.inputLoopAbort = null;
  }

  async start() {
    // 包含当前 main() 中的全部逻辑：
    // 1. import agent module + resolve AgentClass
    // 2. resolve model preset
    // 3. new AgentClass(...)
    // 4. wire local features (ContextCompactionControl, ContextHandoffSeed)
    // 5. agent.withViewer(agentName, VIEWER_PORT, ...)
    // 6. agent.loadSession(sessionId, sessionStore) or preInjectCallStart
    // 7. push restored state to Viewer
    // 8. output: "READY session=xxx"
    // 9. create CallArbiter
    // 10. setInterruptHandler(agent.agentId, ...)
    // 11. wire callArbiter events (callFinished → save, IM dispatch)
    // 12. start input loop (async, non-blocking)
  }

  async handleInput(message) {
    // 接收来自 IPC 的用户输入，通过 callArbiter 入队
  }

  async remove() {
    // 1. abort input loop
    // 2. disableStepAutoSave
    // 3. saveSession
    // 4. agent.dispose()
    // 5. output: "SESSION_EXITED session=xxx"
  }
}
```

### 4.3 进程宿主（新的 main）

```js
// 模块级状态：session 注册表
const sessions = new Map(); // sessionId → SessionLifecycle

async function main() {
  // ── 首个 session：从 argv 初始化 ──
  const initialSession = new SessionLifecycle({
    agentId, sessionId, agentDir, agentName, workspaceCwd, serverOrigin
  });
  sessions.set(sessionId, initialSession);
  await initialSession.start();

  // ── IPC: add-session（仅共享模式会收到）──
  process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'add-session') {
      const newSession = new SessionLifecycle({
        agentId: msg.agentId,
        sessionId: msg.sessionId,
        agentDir: msg.agentDir,
        agentName: msg.agentName,
        workspaceCwd: msg.workspaceCwd,
        serverOrigin: SERVER_ORIGIN,
      });
      sessions.set(msg.sessionId, newSession);
      try {
        await newSession.start();
        process.send({ type: 'session-ready', sessionId: msg.sessionId, viewerAgentId: newSession.agent.agentId });
      } catch (err) {
        process.send({ type: 'session-error', sessionId: msg.sessionId, error: String(err) });
        sessions.delete(msg.sessionId);
        if (sessions.size === 0) process.exit(1);
      }
      return;
    }

    if (msg.type === 'remove-session') {
      const session = sessions.get(msg.sessionId);
      if (session) {
        await session.remove();
        sessions.delete(msg.sessionId);
      }
      if (sessions.size === 0) {
        console.log('[ProtoClaw Runtime] 最后一个 session 已退出，关闭进程');
        process.exit(0);
      }
      return;
    }

    // ── Session-scoped IPC：按 __targetSessionId 路由 ──
    const targetSessionId = msg.__targetSessionId;
    if (targetSessionId) {
      const session = sessions.get(targetSessionId);
      if (session) {
        session.handleIPC(msg);
      }
      return;
    }

    // ── Process-scoped IPC（旧式，单 session 兼容）──
    // 当只有一个 session 时，回退到旧行为
    if (sessions.size === 1) {
      const [onlySession] = sessions.values();
      onlySession.handleIPC(msg);
    }
  });
}
```

### 4.4 关键约束

1. **首个 session 的启动逻辑完全不变**——argv 参数、stdout 输出、READY 信号都保持一致。这保证了 `isolated` 模式和共享模式的首次 spawn 行为完全相同。

2. **IPC 向后兼容**——当 `__targetSessionId` 不存在时，如果进程内只有一个 session，回退到旧行为（直接操作唯一 session）。这使得 server 侧的 IPC 发送逻辑可以渐进式迁移。

3. **输入循环改为异步**——当前 `while(true)` 阻塞改为 per-session 的异步循环：
```js
async runInputLoop() {
  while (!this.disposed) {
    const response = await this.userInput.getUserInputEvent(...);
    // ... handle response
  }
}
```
多个 session 的输入循环并行运行（JS 事件循环天然支持）。

4. **`/exit` 不退出进程**——`summaryHandlers.handleInputResponse` 返回 `{ kind: 'exit' }` 时，调用 `session.remove()` 而非 `process.exit()`。进程只在最后一个 session 退出时 exit。

---

## 5. IPC 协议设计

### 5.1 新增 IPC 消息类型

#### Server → Process

| type | 说明 | 关键字段 |
|------|------|---------|
| `add-session` | 请求进程加载新 session | `sessionId, agentDir, agentName, workspaceCwd` |
| `remove-session` | 请求进程移除一个 session | `sessionId` |
| `swap-model` | 切换模型（session-scoped） | `__targetSessionId, presetName` |
| `swap-thinking` | 切换思考力度（session-scoped） | `__targetSessionId, thinkingEffort` |
| `tool-state` | 工具启停（session-scoped） | `__targetSessionId, scope, name, action` |
| `mount-im-carrier` | IM 载波挂载（session-scoped） | `__targetSessionId, ...` |

#### Process → Server

| type | 说明 | 关键字段 |
|------|------|---------|
| `session-ready` | 新 session 已就绪 | `sessionId, viewerAgentId` |
| `session-error` | 新 session 启动失败 | `sessionId, error` |
| `session-exited` | session 已退出（非错误） | `sessionId` |

### 5.2 IPC 分发规则

```
收到 IPC 消息
  ├─ type === 'add-session' → 创建新 SessionLifecycle
  ├─ type === 'remove-session' → 移除指定 SessionLifecycle
  ├─ msg.__targetSessionId 存在 → 路由到对应 session 的 handleIPC
  └─ msg.__targetSessionId 不存在
      └─ sessions.size === 1 → 回退到唯一 session（向后兼容）
      └─ sessions.size > 1 → 忽略（日志告警）
```

### 5.3 server 侧 IPC 发送适配（ipc.js）

`sendIPCtoSession` 必须是唯一的 session-scoped 发送入口：它根据目标 runtime 自动附加 `__targetSessionId`。任何直接 `runtime.process.send()` 的调用都必须先经过同一包装，以避免共享进程按旧式单 session 语义错误路由。

改造模式统一：
```js
// 之前
sendIPCtoSession(agentId, sessionId, { type: 'swap-model', presetName });

// 之后
sendIPCtoSession(agentId, sessionId, { type: 'swap-model', __targetSessionId: sessionId, presetName });
```

---

## 6. stdout 协议扩展

### 6.1 首个 session（不变）

```
Viewer Agent ID: agent-1-12345
[ProtoClaw Runtime] READY session=abc123
```

### 6.2 后续 session（新增）

后续 session 通过 IPC `add-session` 加入，其 ready 信号通过 IPC `session-ready` 回传，不走 stdout。

**原因**：server 侧的 stdout 监听（`child.stdout.on('data')`）只解析首个 session 的 `Viewer Agent ID` 和 `READY`。后续 session 的 ready 状态通过 IPC 回调设置。

### 6.3 server 侧适配（agent-startup.js）

在 `add-session` 的 IPC 发送后，等待 `session-ready` IPC 回复：

```js
// 伪代码：等待新 session ready
const readyPromise = new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('add-session timeout')), RUNTIME_READY_WAIT_MS);
  const handler = (msg) => {
    if (msg?.type === 'session-ready' && msg.sessionId === resolvedSessionId) {
      clearTimeout(timeout);
      process.removeListener('message', handler);
      resolve(msg);
    } else if (msg?.type === 'session-error' && msg.sessionId === resolvedSessionId) {
      clearTimeout(timeout);
      process.removeListener('message', handler);
      reject(new Error(msg.error));
    }
  };
  existing.process.on('message', handler);
});
existing.process.send({ type: 'add-session', ... });
const result = await readyPromise;
runtime.viewerAgentId = result.viewerAgentId;
runtime.ready = true;
```

---

## 7. agent-startup.js 改造方案

### 7.1 startManagedAgent 决策流程

```
startManagedAgent(agent, sessionId, options)
  │
  ├─ 解析 resolvedSessionId（现有逻辑不变）
  │
  ├─ 解析 processMode（从 metadata.json + session override）
  │
  ├─ processMode === 'isolated' 或 processGroupKey === null
  │   └─ 走现有 spawn 逻辑（完全不变）
  │
  └─ processMode === 'shared-by-project'
      │
      ├─ 计算 processGroupKey = agent.id::normalize(projectDir)
      │
      ├─ findSharedProcessRuntime(processGroupKey)
      │
      ├─ 找到运行中的共享进程
      │   ├─ 发送 IPC add-session
      │   ├─ 等待 IPC session-ready
      │   ├─ 创建 managedAgents 条目（process 引用共享）
      │   └─ return buildStatus
      │
      └─ 未找到运行中的共享进程
          └─ 走现有 spawn 逻辑，但 runtime 增加 processGroupKey 字段
```

### 7.2 进程退出处理

共享进程的 `child.on('exit')` 回调需要遍历所有共享该进程的 managedAgents 条目，逐一标记为 stopped：

```js
child.on('exit', (code, signal) => {
  // 找到所有共享该进程的 runtime
  const sharedRuntimes = Array.from(managedAgents.values())
    .filter(rt => rt.process === child);
  for (const rt of sharedRuntimes) {
    rt.exitCode = code;
    rt.signalCode = signal || child.signalCode || null;
    rt.stopped = true;
  }
  // exit callbacks（群聊等）也需要通知所有 session
  for (const rt of sharedRuntimes) {
    for (const cb of exitCallbacks) {
      cb(rt.agentId, rt.selectedSessionId, code, rt.key);
    }
  }
});
```

---

## 8. agent-lifecycle.js 改造方案

### 8.1 stopManagedAgent

停止一个 session 时：

```
stopManagedAgent(agentId, sessionId)
  │
  ├─ 找到 runtime
  ├─ runtime.processGroupKey 存在（共享模式）
  │   ├─ 发送 IPC remove-session
  │   ├─ 标记 runtime.stopped = true（不等进程退出）
  │   └─ 进程自己决定是否 exit（最后一个 session 时 exit）
  │
  └─ runtime.processGroupKey 为 null（独立模式）
      └─ 走现有 SIGTERM 逻辑（不变）
```

---

## 9. 向后兼容保障

### 9.1 默认行为零变化

- 未声明 `processMode` 的 agent → `isolated` → 走现有 spawn 逻辑
- `agent-access.js` 的新字段 `processGroupKey` 默认 `null`，不影响任何现有查询
- `agent-connected.js` 完全不需要改
- 前端侧栏完全不需要改
- `sendIPCtoSession` 不带 `__targetSessionId` 时，单 session 进程回退到旧行为

### 9.2 渐进式迁移路径

1. **Phase 1**：`run-prebuilt-agent.js` 重构为 SessionLifecycle + 多 session 宿主，但只有 isolated 模式被触发。此时行为完全等价于当前版本。
2. **Phase 2**：开启 `shared-by-project` 模式，编程小助手试点。
3. **Phase 3**：前端 session 创建 UI 增加模式选择。

---

## 10. 测试策略

### 10.1 单元测试（不需要运行时环境）

| 测试目标 | 覆盖场景 |
|---------|---------|
| `computeProcessGroupKey` | 同路径不同写法归一化；null 处理；特殊字符 |
| `findSharedProcessRuntime` | 多 runtime 中匹配正确进程组；已停止的 runtime 不匹配 |
| `resolveProcessMode` | metadata.json 声明优先；session override 覆盖；默认 isolated |
| IPC 分发逻辑 | `__targetSessionId` 路由正确；无 target 时单 session 回退；多 session 时忽略 |
| stdout 解析 | 首个 session 的 `Viewer Agent ID` + `READY` 解析不变 |

### 10.2 集成测试（需要 mock 子进程）

| 测试目标 | 覆盖场景 |
|---------|---------|
| 首个 session spawn | 共享模式下首个 session 走正常 spawn 路径 |
| add-session IPC | 已有进程时新 session 通过 IPC 加入 |
| remove-session IPC | 移除非末位 session 不退出进程；移除末位 session 退出进程 |
| 进程崩溃恢复 | 共享进程崩溃时所有 session 标记 stopped |
| IPC 路由 | `swap-model` 等消息正确路由到目标 session |

### 10.3 往返测试（字段透传完整性）

| 测试目标 | 覆盖场景 |
|---------|---------|
| add-session 消息字段 | `sessionId, agentDir, agentName, workspaceCwd` 全部正确传递到子进程 |
| session-ready 回复字段 | `sessionId, viewerAgentId` 全部正确回传到 server |
| swap-model 路由 | `__targetSessionId` 正确传递，目标 session 的 agent 收到正确的 presetName |
| managedAgents 条目 | 共享进程的多个 runtime 条目共享同一 `process` 引用，各自有独立的 `viewerAgentId` 和 `selectedSessionId` |

---

## 11. 已知限制（初始版本）

| 限制 | 说明 | 影响 |
|------|------|------|
| Dispatch Loop / GroupChatBridge | 多 session 各自启动 loop | programming-helper 会挂载这两个 Feature；它们必须从显式 runtime identity 读取 agent/session，而不能读取进程环境变量 |
| IM Gateway | 进程级单例资源，同进程多 session 会重复连接 | programming-helper 不使用。qqbot 保持 isolated 模式即可 |
| 进程内 session 上限 | 初始不设硬上限 | 极端情况下可能内存过高。后续可引入上限自动 spawn 新进程 |

---

## 12. 改造文件清单

### 框架侧（AgentDev）

无。框架基础设施已在前面完成。

### Claw 壳层（AgentDevClaw）

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `scripts/run-prebuilt-agent.js` | **重构** | 提取 SessionLifecycle 类；main 改为多 session 宿主；IPC 中心化分发 |
| `server/shared/agent-access.js` | **扩展** | 新增 `processGroupKey` 字段；新增 `findSharedProcessRuntime` |
| `server/routes/agent-startup.js` | **扩展** | `startManagedAgent` 增加 shared-by-project 决策分支；进程退出处理遍历共享 runtime |
| `server/routes/agent-lifecycle.js` | **扩展** | `stopManagedAgent` 增加 remove-session IPC 分支 |
| `server/shared/ipc.js` | **扩展** | session-scoped IPC 的统一目标注入入口 |
| `prebuilt-agents/official/programming-helper/metadata.json` | **配置** | 新增 `"processMode": "shared-by-project"` |
| 前端 session 创建 UI | **后续产品层工作** | 可选地暴露 `processModeOverride`，不影响基础设施正确性 |
| `test/` | **新增** | 覆盖进程分组、目标 IPC、退出确认和 session identity |
