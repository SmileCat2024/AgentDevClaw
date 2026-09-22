# Hooks Enable/Disable 框架改动设计文档

> **状态**: 设计待审计 (v2 — 修正 P1/P2 审计意见)
> **日期**: 2026-08-09
> **涉及仓库**: `AgentDev`（框架本体）、`AgentDevClaw`（产品壳层）
> **前置条件**: 工具级 enable/disable 已在 Claw 侧完成（IPC + API + 前端 toggle）

---

## 1. 需求背景

### 1.1 已完成的工作

Claw 右侧 Feature 监视面板已支持工具级 toggle（enabled ↔ disabled），用户可在面板上直接开关 Feature 提供的工具。整条链路为：

```
前端 toggle → POST /protoclaw/agent/tool_state → IPC { type:'tool-state' } → agent.tools.enable/disable()
```

工具控制只涉及 Claw 壳层，不需要改框架——因为 `ToolRegistry` 早已内置 enable/disable/remove 三态机制。

### 1.2 当前需求

将同样的控制能力扩展到**反向钩子（reverse hooks）**，让用户能在面板上直接开关 Feature 注册的 `@CallStart`、`@ToolUse`、`@StepFinish` 等钩子。

### 1.3 为什么需要改框架

`HooksRegistry` 当前**完全没有 enable/disable 机制**。四个执行方法（`execute`、`executeDecision`、`executeVoid`、`executeTransform`）无条件遍历所有注册的钩子，inspector snapshot 也不暴露 `enabled` 字段。必须在框架侧增加状态管理和过滤逻辑。

### 1.4 产品语义

- **toggle 只有 enabled ↔ disabled 两态**，不引入 remove
- 钩子对 LLM 不可见（纯运行时行为），因此 disable 钩子不影响前缀缓存、不改变 prompt
- disable 的语义是"跳过执行"，等同于该钩子从未注册过

---

## 2. 现有架构分析

### 2.1 HooksRegistry 数据结构

```typescript
// AgentDev/src/core/hooks-registry.ts

class HooksRegistry {
  private hooks = new Map<CoreLifecycle, Array<{
    feature: AgentFeature;
    methodName: string;
    source?: { file?: string; line?: number; column?: number; display: string };
  }>>();
}
```

钩子按生命周期分组存储。每个条目是 `{ feature, methodName, source }` 三元组，存在数组中。

### 2.2 钩子注册流程

```
Feature 类定义 → @CallStart / @ToolUse / ... 装饰器写入元数据
→ Agent.use(feature) / mountFeature(feature)
→ hooksRegistry.collectFromFeature(feature)
→ 从元数据提取 lifecycle → methodName 映射，push 到 hooks Map
```

注册在 feature 挂载时一次性完成，运行时没有动态注册。

### 2.3 钩子执行流程

共有 **4 个执行入口**，但实际只有 **2 个独立循环**：

| 方法 | 调用者 | 循环实现 | 用途 |
|------|--------|---------|------|
| `execute(lifecycle, ctx)` | 内部核心 | **独立循环** | 顺序遍历，遇到 Approve/Deny 停止 |
| `executeDecision(lifecycle, ctx)` | react-loop, tool-executor | 委托 `execute()` | 返回 DecisionResult |
| `executeVoid(lifecycle, ctx)` | agent, react-loop, tool-executor | 委托 `execute()` | 返回 void |
| `executeTransform(lifecycle, initial, buildCtx)` | tool-executor | **独立循环** | 链式传递数据 |

**关键结论：过滤逻辑只需加在 2 处** — `execute()` 和 `executeTransform()` 的循环中。

### 2.4 执行调用点全景

```
agent.ts:350      executeVoid(CallStart)     ← 每次用户输入开始
agent.ts:405,470  executeVoid(CallFinish)    ← 每次用户输入结束
react-loop.ts:131 executeVoid(StepStart)     ← 每个 ReAct 步骤开始
react-loop.ts:304 executeDecision(StepFinish)← 步骤结束决策（是否继续循环）
react-loop.ts:514 executeDecision(StepFinish)← 无工具调用时的步骤结束决策
tool-executor.ts:157  executeDecision(ToolUse)        ← 工具执行前决策（是否允许）
tool-executor.ts:133,209,354 executeVoid(ToolFinished) ← 工具执行后通知
tool-executor.ts:322  executeTransform(ToolResultTransform) ← 工具结果变换（截断等）
```

### 2.5 Inspector 数据流

```
HooksRegistry.getSnapshot()
  → 返回 HookLifecycleSnapshot[]
  → 每组: { lifecycle, kind, entries: HookEntryMetadata[] }
  → 每条: { order, featureName, methodName, lifecycle, kind, source?, description? }

Agent.buildHookInspectorSnapshot()
  → 合并 hooks + tools + features 数据
  → 返回 HookInspectorSnapshot
  → 通过 pushInspectorSnapshot() 推送到 DebugHub/ViewerWorker

前端:
  → GET /api/agents/:id/hooks
  → normalizeHookInspector() (overview-data.js) — 展开运算符透传所有字段
  → renderReverseHooksPanel() (debug-features-hooks.js) — 渲染面板
```

### 2.6 HooksRegistry 实例共享

`agent.hooksRegistry` 是 `private`，但通过构造函数参数传递给 `ToolExecutor` 和 `ReActLoopRunner`：

```typescript
// agent.ts:1546 — 传给 ToolExecutor
this.hooksRegistry

// agent.ts:1562 — 传给 ReActLoopRunner
hooksRegistry: this.hooksRegistry

// react-loop.ts:69 — 存储引用
this.hooksRegistry = agent.hooksRegistry;

// tool-executor.ts:52 — 构造函数参数
private hooksRegistry: HooksRegistry
```

所有执行路径共享同一个 `HooksRegistry` 实例。对实例的任何修改立即对所有调用者可见。

### 2.7 现有测试

| 文件 | 覆盖内容 |
|------|---------|
| `src/test/hook-constraint.test.ts` | 装饰器约束（decision 钩子单例限制） |
| `src/test/hook-constraint-verify.test.ts` | 装饰器约束验证 |

没有针对 `execute()` / `executeTransform()` 执行逻辑的测试，也没有针对 inspector snapshot 的测试。

---

## 3. 改动方案

### 3.1 改动文件清单

| 仓库 | 文件 | 改动类型 | 改动量 |
|------|------|---------|--------|
| AgentDev | `src/core/hooks-registry.ts` | 修改 | 核心：entry 加 enabled 标志 + 快照过滤 + snapshot |
| AgentDev | `src/core/agent.ts` | 修改 | 新增 Agent 级 API 方法 |
| AgentDev | `src/core/types.ts` | 修改 | `HookEntryMetadata` 加 `enabled?` 字段 |
| AgentDev | `src/test/hooks-disable.test.ts` | 新增 | 单元测试 |
| AgentDev | `dist/*` | 重建 | 构建产物 |
| AgentDevClaw | `server/routes/tool-state.js` | 修改 | 按 scope 分支校验 + hook scope 支持 |
| AgentDevClaw | `scripts/run-prebuilt-agent.js` | 修改 | IPC handler 按 scope 分支 + hook 分支 |
| AgentDevClaw | `public/src/modules/debug-features-hooks.js` | 修改 | 反向钩子面板加 toggle |
| AgentDevClaw | `test/tool-state-hook.test.js` | 新增 | IPC/路由自动化测试 |

下面逐文件详述。

---

### 3.2 `AgentDev/src/core/hooks-registry.ts` — 核心改动

#### 3.2.1 在 hook entry 上存储 enabled 状态（不用字符串 key Set）

**审计修正**：v1 使用 `Set<string>` 存储 disabled key（`${lifecycle}:${featureName}:${methodName}` 拼接），存在歧义风险——框架只将 featureName / methodName 约束为普通字符串，没有运行时校验确保不含 `:`。`a:b` + `c` 与 `a` + `b:c` 会产生相同 key，可能联动禁用错误钩子。

**修正方案**：将 `enabled` 标志直接存储在 entry 对象上，用对象身份定位，彻底消除 key 歧义。

```typescript
class HooksRegistry {
  // entry 类型扩展
  private hooks = new Map<CoreLifecycle, Array<{
    feature: AgentFeature;
    methodName: string;
    source?: { file?: string; line?: number; column?: number; display: string };
    enabled: boolean;  // 新增：运行时启用状态，默认 true
  }>>();
}
```

**设计理由**：
- 对象身份天然唯一，不存在拼接歧义
- 不需要额外的 key 生成 / 查找逻辑
- `collectFromFeature()` push 时设置 `enabled: true`
- `getSnapshot()` 直接读 `hook.enabled`，无需二次查找
- 不需要 `pendingDisabled`——hooks 在 feature 挂载时一次性收集，不存在"先禁用再注册"的时序问题

#### 3.2.2 新增 enable/disable 方法

```typescript
/**
 * 禁用钩子
 * @returns 是否成功（钩子存在且之前为启用状态）
 */
disableHook(lifecycle: CoreLifecycle, featureName: string, methodName: string): boolean {
  const hooks = this.hooks.get(lifecycle);
  if (!hooks) return false;

  const entry = hooks.find(h => h.feature.name === featureName && h.methodName === methodName);
  if (!entry || !entry.enabled) return false;

  entry.enabled = false;
  return true;
}

/**
 * 启用钩子
 * @returns 是否成功（钩子存在且之前为禁用状态）
 */
enableHook(lifecycle: CoreLifecycle, featureName: string, methodName: string): boolean {
  const hooks = this.hooks.get(lifecycle);
  if (!hooks) return false;

  const entry = hooks.find(h => h.feature.name === featureName && h.methodName === methodName);
  if (!entry || entry.enabled) return false;

  entry.enabled = true;
  return true;
}
```

#### 3.2.3 `execute()` — 入口快照过滤（修正 P1 竞态）

**审计修正**：v1 在 for 循环每次迭代中实时检查 `isHookEnabled()`。但 `execute()` 内部有 `await`，IPC 可能在前一个 hook 的 `await` 窗口中禁用后续 hook，导致同一次 `execute()` dispatch 只执行了部分钩子。这对安全相关的 decision/transform 链是危险的。

**修正方案**：在 `execute()` 入口处一次性快照本次 dispatch 的有效钩子列表。mid-dispatch 的 enable/disable 切换从下一次生命周期触发开始生效。

```typescript
async execute(lifecycle: CoreLifecycle, context: DecisionContext): Promise<HookExecutionResult> {
  const allHooks = this.hooks.get(lifecycle);
  if (!allHooks || allHooks.length === 0) {
    return { handled: false };
  }

  // ★ 入口快照：冻结本次 dispatch 的有效钩子
  // mid-dispatch 的 enable/disable 不影响本次执行，从下一次生命周期触发生效
  const activeHooks = allHooks.filter(h => h.enabled);

  if (activeHooks.length === 0) {
    return { handled: false };
  }

  for (const { feature, methodName, source } of activeHooks) {
    try {
      // ... 原有执行逻辑不变
    }
  }

  return { handled: true, decision: Decision.Continue };
}
```

#### 3.2.4 `executeTransform()` — 同样入口快照

```typescript
async executeTransform<T>(
  lifecycle: CoreLifecycle,
  initialResult: T,
  buildContext: (current: T) => DecisionContext,
): Promise<T> {
  const allHooks = this.hooks.get(lifecycle);
  if (!allHooks || allHooks.length === 0) {
    return initialResult;
  }

  // ★ 入口快照
  const activeHooks = allHooks.filter(h => h.enabled);

  if (activeHooks.length === 0) {
    return initialResult;
  }

  let current = initialResult;

  for (const { feature, methodName, source } of activeHooks) {
    try {
      // ... 原有变换逻辑不变
    }
  }

  return current;
}
```

#### 3.2.5 `getSnapshot()` 读 entry.enabled

```typescript
getSnapshot(): HookLifecycleSnapshot[] {
  return Object.values(CoreLifecycle).map((lifecycle) => {
    const entries = (this.hooks.get(lifecycle) || []).map((hook, index) => ({
      order: index + 1,
      featureName: hook.feature.name,
      methodName: hook.methodName,
      lifecycle,
      kind: lifecycle === CoreLifecycle.StepFinish || lifecycle === CoreLifecycle.ToolUse
        ? 'decision' as const
        : lifecycle === CoreLifecycle.ToolResultTransform
          ? 'transform' as const
          : 'notify' as const,
      source: hook.source,
      description: typeof (hook.feature as any).getHookDescription === 'function'
        ? (hook.feature as any).getHookDescription(lifecycle, hook.methodName)
        : undefined,
      enabled: hook.enabled,  // 直接读 entry 字段
    }));

    return { lifecycle, kind: ..., entries };
  });
}
```

#### 3.2.6 `removeFromFeature()` 无需额外清理

enabled 标志存储在 entry 对象上，entry 随 feature 一起从数组中移除，无需额外清理逻辑。`removeFromFeature()` 原有实现不变。

#### 3.2.7 `clear()` 无需额外清理

`this.hooks.clear()` 会清空所有 entry，enabled 标志随之消失。无需额外操作。

---

### 3.3 `AgentDev/src/core/types.ts` — 类型扩展

**审计修正**：v1 定义为必填 `enabled: boolean`，但兼容性说明中称其为"可选字段"，自相矛盾。修正为可选字段，并明确规定缺省语义。

```typescript
export interface HookEntryMetadata {
  order: number;
  featureName: string;
  methodName: string;
  lifecycle: string;
  kind: 'decision' | 'notify' | 'transform';
  source?: HookSourceLocation;
  description?: string;
  /**
   * 是否启用。false 表示被运行时禁用。
   * 缺省时视为 true（向后兼容旧版框架的 snapshot）。
   */
  enabled?: boolean;
}
```

**这是类型层面的向后兼容变更**：现有消费者不受影响，因为：
- Claw 前端 `normalizeHookInspector()` 使用展开运算符透传所有字段
- DebugHub Viewer (`viewer-html.ts`) 只读取已有字段，忽略未知字段
- 前端读取时统一用 `entry.enabled !== false`（`undefined` 和 `true` 都视为启用）

---

### 3.4 `AgentDev/src/core/agent.ts` — Agent 级 API

新增 2 个方法，参照现有 `enable(featureName)` / `disable(featureName)` 模式：

```typescript
// ========== 反向钩子运行时控制 ==========

/**
 * 禁用指定的反向钩子
 *
 * @example
 * agent.disableHook('ToolUse', 'audit', 'onToolUse')
 */
disableHook(lifecycle: string, featureName: string, methodName: string): this {
  const lc = lifecycle as CoreLifecycle;
  if (this.hooksRegistry.disableHook(lc, featureName, methodName)) {
    console.log(`[Agent] 已禁用钩子 ${lifecycle}:${featureName}.${methodName}`);
    this.pushInspectorSnapshot();
  }
  return this;
}

/**
 * 启用指定的反向钩子
 */
enableHook(lifecycle: string, featureName: string, methodName: string): this {
  const lc = lifecycle as CoreLifecycle;
  if (this.hooksRegistry.enableHook(lc, featureName, methodName)) {
    console.log(`[Agent] 已启用钩子 ${lifecycle}:${featureName}.${methodName}`);
    this.pushInspectorSnapshot();
  }
  return this;
}
```

**设计考量**：
- `lifecycle` 参数用 `string` 而非 `CoreLifecycle` 枚举——因为 IPC 消息传递的是字符串，agent.ts 入口做一次类型断言即可，调用方（IPC handler）不需要 import 枚举
- 操作成功后调用 `pushInspectorSnapshot()`，与工具控制的模式完全一致
- `pushInspectorSnapshot()` 是 agent 上已有的方法（内部调用 `buildHookInspectorSnapshot()` + `debugHub.updateAgentInspector()`），会触发前端轮询自动刷新

---

### 3.5 Claw 壳层改动

#### 3.5.1 `server/routes/tool-state.js` — 按 scope 分支校验

**审计修正**：v1 仅描述了 hook 分支的添加，忽略了现有路由在分流前强制要求 `name` 字段（`tool-state.js:21`）。hook scope 的请求不携带 `name`，会被 400 拒绝。

**修正方案**：将校验重构为 discriminated union——按 scope 分支，各分支校验各自必需的字段。

现有代码（有问题的前置校验）：

```javascript
// ❌ 当前：name 在所有 scope 前都被强制校验
const { agentId, runtimeId, sessionId, scope, name, action } = req.body || {};
if (!name || typeof name !== 'string') {
  return res.status(400).json({ error: 'name is required' });
}
const resolvedScope = scope === 'feature' ? 'feature' : 'tool';
const message = { type: 'tool-state', scope: resolvedScope, name, action };
```

修正后代码：

```javascript
const { agentId, runtimeId, sessionId, scope, action } = req.body || {};

// 公共校验
if (!agentId || typeof agentId !== 'string') {
  return res.status(400).json({ error: 'agentId is required' });
}
if (action !== 'enable' && action !== 'disable') {
  return res.status(400).json({ error: 'action must be "enable" or "disable"' });
}

// 按 scope 分支校验（discriminated union）
let message;
if (scope === 'hook') {
  const { lifecycle, featureName, methodName } = req.body;
  if (!lifecycle || typeof lifecycle !== 'string') {
    return res.status(400).json({ error: 'lifecycle is required for scope="hook"' });
  }
  if (!featureName || typeof featureName !== 'string') {
    return res.status(400).json({ error: 'featureName is required for scope="hook"' });
  }
  if (!methodName || typeof methodName !== 'string') {
    return res.status(400).json({ error: 'methodName is required for scope="hook"' });
  }
  message = { type: 'tool-state', scope: 'hook', lifecycle, featureName, methodName, action };
} else {
  // scope='tool' | 'feature'（默认 tool）
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  const resolvedScope = scope === 'feature' ? 'feature' : 'tool';
  message = { type: 'tool-state', scope: resolvedScope, name, action };
}

// IPC 投递逻辑（runtimeId > sessionId > broadcast）不变
```

#### 3.5.2 `scripts/run-prebuilt-agent.js` — IPC handler 按 scope 分支

**审计修正**：v1 仅描述了 hook 分支的添加，忽略了现有 handler 的 `name` 前置 guard（`run-prebuilt-agent.js:389`）会静默丢弃 hook 消息。

现有代码（有问题的前置 guard）：

```javascript
// ❌ 当前：name guard 在 scope 分支前
if (msg.type === 'tool-state') {
  const { scope, name, action } = msg;
  if (!name || (action !== 'enable' && action !== 'disable')) return;  // hook 消息无 name，被静默丢弃
  // ...
}
```

修正后代码：

```javascript
if (msg.type === 'tool-state') {
  const { scope, action } = msg;
  if (action !== 'enable' && action !== 'disable') return;

  try {
    if (scope === 'hook') {
      // hook 分支：不需要 name
      const { lifecycle, featureName, methodName } = msg;
      if (!lifecycle || !featureName || !methodName) return;

      if (action === 'enable') {
        this.agent?.enableHook?.(lifecycle, featureName, methodName);
      } else {
        this.agent?.disableHook?.(lifecycle, featureName, methodName);
      }
      console.log(`[ProtoClaw Runtime] ✓ Hook ${lifecycle}:${featureName}.${methodName} ${action}d`);
    } else if (scope === 'feature') {
      // feature 分支：需要 name（不变）
      const { name } = msg;
      if (!name) return;
      if (typeof this.agent?.[action] !== 'function') {
        console.warn(`[ProtoClaw Runtime] tool-state: agent.${action} not available`);
        return;
      }
      this.agent[action](name);
      console.log(`[ProtoClaw Runtime] ✓ Feature '${name}' ${action}d`);
    } else {
      // tool 分支：需要 name（不变）
      const { name } = msg;
      if (!name) return;
      if (!this.agent?.tools || typeof this.agent.tools[action] !== 'function') {
        console.warn(`[ProtoClaw Runtime] tool-state: tools.${action} not available`);
        return;
      }
      this.agent.tools[action](name);
      console.log(`[ProtoClaw Runtime] ✓ Tool '${name}' ${action}d`);
    }
  } catch (err) {
    console.error(`[ProtoClaw Runtime] tool-state error:`, err);
  }
  return;
}
```

#### 3.5.3 `public/src/modules/debug-features-hooks.js` — 前端 toggle

在 `renderReverseHooksPanel()` 的每个 hook entry 卡片上添加 toggle 开关。新增 `buildHookToggleHtml()` 函数，类似已有的 `buildToolToggleHtml()`，但 data 属性携带 `lifecycle`、`featureName`、`methodName`：

```javascript
function buildHookToggleHtml(lifecycle, featureName, methodName, isChecked) {
  return [
    '<label class="tool-toggle" onclick="event.stopPropagation()">',
    `<input type="checkbox" class="tool-toggle-input" ${isChecked ? 'checked' : ''}`,
    ` onchange="toggleHookState('${lifecycle}','${featureName}','${methodName}', this.checked)"`,
    ` title="${escapeHtml(t('feature_toggle_hint'))}">`,
    '<span class="tool-toggle-slider"></span>',
    '</label>',
  ].join('');
}

function toggleHookState(lifecycle, featureName, methodName, enable) {
  const agentId = currentAgentId;
  const runtimeId = getRuntimeContextKey();
  const action = enable ? 'enable' : 'disable';
  invokeProtoclaw('/protoclaw/agent/tool_state', 'POST', {
    agentId, runtimeId,
    scope: 'hook',
    lifecycle, featureName, methodName,
    action,
  }).catch(err => {
    console.error('[toggleHookState] failed:', err);
    // 回滚 checkbox 状态
  });
}
```

前端读取 inspector 时统一用 `entry.enabled !== false`（缺省视为启用）。

---

## 4. 执行流程影响分析

### 4.1 各 hook kind 被 disable 后的行为

| kind | 生命周期 | disable 后行为 | 影响评估 |
|------|---------|---------------|---------|
| **notify** | CallStart, CallFinish, StepStart, ToolFinished | 钩子被跳过，不执行任何逻辑 | 钩子的副作用不发生（如不注入 memory、不播放音效） |
| **decision** | StepFinish | 钩子被跳过，等价于返回 `Continue` | 使用默认行为（有工具调用则继续循环，无则结束） |
| **decision** | ToolUse | 钩子被跳过，等价于返回 `Continue` | 使用默认行为（允许工具执行） |
| **transform** | ToolResultTransform | 钩子被跳过，数据原样传递 | 工具结果不被截断/变换 |

### 4.2 多钩子顺序不受影响

enabled 标志存储在 entry 对象上，过滤不改变数组本身。enable 后钩子回到原来的位置和执行顺序。

### 4.3 mid-dispatch 快照语义（修正 P1 竞态）

**审计修正**：v1 声称"不存在竞态"是错误的。`execute()` 内部有 `await`，JS 单线程虽然在同一微任务内不会被 IPC 中断，但**在 hook A 的 `await` 等待期间，Node.js 事件循环会处理 IPC message 事件**，从而在 hook B 执行前修改其 enabled 状态。

**快照方案的行为**：

```
execute(ToolUse) 开始
  ↓ 快照 activeHooks = [A, B, C] （此时全部 enabled）
  ↓ 执行 A (await 调用 feature 方法)
  ↓   ← IPC 到达：disable B（entry.enabled = false）
  ↓   ← 但 activeHooks 已冻结，B 仍在快照中
  ↓ 执行 B （按快照结果，仍然执行）
  ↓ 执行 C
execute() 返回

下一次 execute(ToolUse) 触发
  ↓ 快照 activeHooks = [A, C] （B 的 entry.enabled=false，被过滤）
  ↓ B 被跳过
```

**语义**：mid-dispatch 的 enable/disable 切换从下一次生命周期触发开始生效。同一次 dispatch 内的钩子链不受影响，保证 safety-critical 链的完整性（如 audit + file-history 都在 ToolUse 上，disable 其中一个不会导致同次 dispatch 中另一个意外跳过）。

**不影响的场景**：ReAct 多步循环中，Step 1 和 Step 2 是不同的 `execute()` 调用，Step 1 执行后 disable 的钩子会在 Step 2 中生效——这是符合直觉的行为。

### 4.4 与工具控制的差异

| 维度 | 工具 disable | 钩子 disable |
|------|-------------|-------------|
| LLM 可见性 | 工具定义仍发给 LLM，调用时被拦截 | LLM 完全无感知 |
| 前缀缓存 | 不受影响（工具列表不变） | 不受影响（钩子不涉及 prompt） |
| 副作用 | LLM 可能尝试调用被拦截的工具 | 行为直接改变，无错误反馈 |
| mid-turn 生效 | 下一个 turn | 下一次生命周期触发（同 dispatch 内不生效） |
| 恢复 | enable 即恢复 | enable 即恢复 |

---

## 5. 接口设计

### 5.1 HooksRegistry 公开 API

```typescript
class HooksRegistry {
  // 已有
  collectFromFeature(feature: AgentFeature): void;
  removeFromFeature(feature: AgentFeature): void;
  has(lifecycle: CoreLifecycle): boolean;
  get(lifecycle: CoreLifecycle): Array<{...}>;
  getSnapshot(): HookLifecycleSnapshot[];
  execute(lifecycle: CoreLifecycle, context: DecisionContext): Promise<HookExecutionResult>;
  executeDecision(lifecycle: CoreLifecycle, context: DecisionContext): Promise<DecisionResult>;
  executeVoid(lifecycle: CoreLifecycle, context: DecisionContext): Promise<void>;
  executeTransform<T>(...): Promise<T>;
  clear(): void;

  // 新增
  disableHook(lifecycle: CoreLifecycle, featureName: string, methodName: string): boolean;
  enableHook(lifecycle: CoreLifecycle, featureName: string, methodName: string): boolean;
}
```

### 5.2 Agent 公开 API

```typescript
class Agent {
  // 已有（工具级）
  enable(featureName: string): this;
  disable(featureName: string): this;
  remove(featureName: string): this;

  // 新增（钩子级）
  disableHook(lifecycle: string, featureName: string, methodName: string): this;
  enableHook(lifecycle: string, featureName: string, methodName: string): this;
}
```

### 5.3 IPC 消息协议（discriminated union）

```typescript
// 按 scope 区分的消息类型
type ToolStateIPCMessage =
  | { type: 'tool-state'; scope: 'tool' | 'feature'; name: string; action: 'enable' | 'disable' }
  | { type: 'tool-state'; scope: 'hook'; lifecycle: string; featureName: string; methodName: string; action: 'enable' | 'disable' };
```

### 5.4 HTTP API

```
POST /protoclaw/agent/tool_state

// scope='hook' 的请求体
{
  "agentId": "...",
  "runtimeId": "...",
  "scope": "hook",
  "lifecycle": "ToolUse",
  "featureName": "audit",
  "methodName": "onToolUse",
  "action": "disable"
}

// scope='hook' 缺少必需字段时返回 400
{
  "error": "lifecycle is required for scope=\"hook\""
}
```

---

## 6. 风险分析

### 6.1 用户禁用关键钩子

| 钩子 | disable 后果 | 严重度 |
|------|-------------|--------|
| output-guard `@ToolResultTransform` | 工具输出不再截断，可能导致上下文溢出 | 高 |
| file-history `@ToolUse` | write/edit 前不自动备份，失去回滚能力 | 高 |
| subagent `@StepFinish` / `@ToolFinished` | 子代理等待机制失效，协调中断 | 高 |
| memory `@CallStart` | 不再注入记忆到上下文 | 中 |
| IM 渠道 `@CallStart` | 不再注入渠道 system prompt（如 QQ 身份信息） | 中 |

**缓解策略**：不在框架层硬编码"不可禁用"名单。这是用户自主决定的行为，与 disable shell 工具同理——产品层可在前端对 transform kind 钩子加视觉提示（如黄色警告标记），但不阻止操作。

### 6.2 mid-dispatch 竞态

**已修正**：入口快照方案保证同一次 dispatch 内的钩子链完整性。mid-dispatch 的切换从下一次生命周期触发生效。详见 4.3。

### 6.3 snapshot 兼容性

新增 `HookEntryMetadata.enabled?` 字段（可选，缺省视为 `true`）：

| 组合 | 行为 |
|------|------|
| 新版框架 + 新版前端 | `enabled` 字段存在，前端正常渲染 toggle |
| 新版框架 + 旧版前端 | `enabled` 字段被忽略（旧版不读取），无影响 |
| 旧版框架 + 新版前端 | `enabled` 为 `undefined`，前端用 `entry.enabled !== false` 判断，视为启用 |

类型层面是**向后兼容的增量变更**——`enabled?: boolean` 不破坏现有 `HookEntryMetadata` 的消费者。

### 6.4 与 ToolRegistry 模式的一致性

当前 `agent.enable(featureName)` / `disable(featureName)` 只操作工具，不操作钩子。如果后续要支持"feature 级批量 toggle 同时控制工具 + 钩子"，需要扩展这两个方法。**本次不扩展**——先做独立的 hook 级 toggle，批量功能后续讨论。

---

## 7. 测试方案

### 7.1 框架侧单元测试

新增 `AgentDev/src/test/hooks-disable.test.ts`，覆盖：

```
describe('HooksRegistry disable/enable 基础功能', () => {
  it('禁用 notify 钩子后 execute 跳过该钩子，副作用不发生')
  it('禁用 decision 钩子后 execute 等价于返回 Continue（不 Approve/Deny）')
  it('禁用 transform 钩子后 executeTransform 数据原样传递')
  it('enable 恢复后钩子正常执行')
  it('禁用不影响同 lifecycle 其他钩子的执行')
  it('disable 不存在的钩子返回 false')
  it('重复 disable 同一钩子返回 false')
  it('重复 enable 已启用钩子返回 false')
  it('getSnapshot 包含 enabled 字段且与实际状态一致')
})

describe('HooksRegistry mid-dispatch 快照语义', () => {
  it('execute 入口快照后，dispatch 期间禁用后续钩子不影响本次执行')
  it('executeTransform 入口快照后同理')
  it('dispatch 结束后的下一次 execute 生效新的 enabled 状态')

  // 具体验证方法：构造一个 hook A，在其 await 期间调用
  // hooksRegistry.disableHook(lifecycle, featureB, methodB)，
  // 验证 B 在本次 execute 中仍被执行，在下一次 execute 中被跳过。
})

describe('HooksRegistry 生命周期', () => {
  it('collectFromFeature 新注册的钩子 enabled 默认为 true')
  it('removeFromFeature 移除的钩子不会残留 enabled=false 状态')
  it('clear 后所有状态归零')
})
```

### 7.2 Claw 侧自动化测试

新增 `AgentDevClaw/test/tool-state-hook.test.js`（`node:test` 格式），覆盖：

```
describe('tool-state 路由 — hook scope 校验', () => {
  it('scope=hook 且 lifecycle/featureName/methodName 齐全 → 生成正确 IPC payload')
  it('scope=hook 缺少 lifecycle → 返回 400')
  it('scope=hook 缺少 featureName → 返回 400')
  it('scope=hook 缺少 methodName → 返回 400')
  it('scope=hook 不携带 name → 不报 name required 错误')
  it('scope=tool 缺少 name → 仍返回 400（原有行为不受影响）')
  it('scope=feature 缺少 name → 仍返回 400（原有行为不受影响）')
  it('action 非法 → 返回 400')
})

describe('tool-state IPC handler — hook 分支独立性', () => {
  it('scope=hook 消息不携带 name 时不被 name guard 丢弃')
  it('handler 正确调用 agent.enableHook')
  it('handler 正确调用 agent.disableHook')
  it('agent 不存在 enableHook 方法时不崩溃（优雅降级）')
})

describe('tool-state IPC 投递策略', () => {
  it('runtimeId 有效时只投递到目标 runtime')
  it('runtimeId 无效时回退到 agentId + sessionId')
  it('runtimeId 和 sessionId 都无效时广播到所有会话')
})
```

**路由测试实现方式**：mock `sendIPCtoSession` / `sendIPCToAllSessions` / `sendIPCToRuntime` / `getRuntimeByViewerAgentId`，验证传入的 message 参数结构，而非真正启动 agent 进程。

**handler 测试实现方式**：mock `this.agent` 对象，验证 `enableHook` / `disableHook` 被以正确参数调用。

### 7.3 手动验证

- 启动 agent → 在反向钩子面板 toggle 一个 notify 钩子 → 观察面板状态刷新
- toggle 一个 decision 钩子 → 对话验证决策行为变化
- 在对话进行中 toggle 钩子 → 验证 mid-dispatch 不影响当前 turn

---

## 8. 实施顺序

```
 1. AgentDev/src/core/hooks-registry.ts  — entry 加 enabled 字段 + 快照过滤 + snapshot
 2. AgentDev/src/core/types.ts           — HookEntryMetadata 加 enabled? 字段
 3. AgentDev/src/core/agent.ts           — 加 enableHook / disableHook 方法
 4. AgentDev/src/test/hooks-disable.test.ts — 单元测试（含 mid-dispatch 竞态测试）
 5. cd AgentDev && npm run build          — 重建 dist
 6. 重启 Claw 服务                         — 框架 dist 变更需完整重启
 7. Claw server/routes/tool-state.js     — 按 scope 分支校验 + hook scope
 8. Claw scripts/run-prebuilt-agent.js   — IPC handler 按 scope 分支
 9. Claw test/tool-state-hook.test.js    — 路由 + handler 自动化测试
10. Claw debug-features-hooks.js          — 前端 toggle
11. npm run test:core                     — 验证 Claw 测试全绿
```

---

## 9. 后续方向（不在本次范围）

| 方向 | 说明 |
|------|------|
| Feature 级批量 toggle（工具 + 钩子） | 扩展 `agent.disable(featureName)` 同时 disable 工具和钩子；前端 feature 卡片加"全部禁用工具"/"全部禁用钩子"两个批量按钮 |
| 持久化 | 当前为运行时状态，重启丢失。后续可考虑写入 feature manifest 或 session 配置 |
| 危险钩子警告 | 前端对 `transform` kind 或特定 feature 的钩子加视觉提示 |
| Hook 级别 remove | 类似工具的 remove 机制，但从 hooks 数组中物理移除。当前不需要——disable 已满足需求 |

---

## 附录 A：审计意见响应记录

| # | 严重度 | 问题 | 修正 |
|---|--------|------|------|
| 1 | P1 | mid-turn 切换存在竞态，同一次 hook dispatch 可能只执行部分 | `execute()` / `executeTransform()` 入口快照，mid-dispatch 切换从下一次生命周期触发生效（§3.2.3, §3.2.4, §4.3） |
| 2 | P1 | HTTP/IPC 的 name 前置校验会拒绝 hook 请求 | 按 scope 分支的 discriminated union 校验，hook 分支不要求 name（§3.5.1, §3.5.2） |
| 3 | P1 | 字符串拼接的 hook key 不能保证唯一 | 改用 entry 对象上的 `enabled` 字段，用对象身份定位（§3.2.1, §3.2.2） |
| 4 | P2 | snapshot 类型定义为必填但说明称可选 | 改为 `enabled?: boolean`，明确缺省视为 true（§3.3, §6.3） |
| 5 | — | 测试方案仅 smoke test + 手测 | 扩展为含路由校验、IPC payload、handler 独立性、投递策略的完整自动化测试（§7.2） |
