# 工具创建指南

## 工具接口的当前事实

```typescript
interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, any>;
  execute: (args: any, context?: any) => Promise<any>;
  render?: ToolRenderConfig;
}
```

`parameters` 当前就是普通对象形态的 JSON Schema，不必执着某个特定 TS schema 类型名。

## 基本工具

```typescript
import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';

export const myTool: Tool = createTool({
  name: 'my_tool',
  description: '根据输入生成结果。',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '要处理的输入内容' },
    },
    required: ['input'],
  },
  render: { call: 'my-tool', result: 'my-tool' },
  execute: async ({ input }) => {
    return `结果: ${input}`;
  },
});
```

## `createTool()` 的几个现实用法

### 1. 最常见：显式指定模板名

```typescript
render: { call: 'my-tool', result: 'my-tool' }
```

### 2. 简写

```typescript
render: 'my-tool'
```

等价于 call/result 共用同一个模板名。

### 3. 传 `sourceFile`

`createTool(config, sourceFile)` 会尝试推断同目录 `.render.ts` 路径。但多数 Feature 场景下，还是更推荐把模板名显式写清楚，方便 agent 理解和排错。

## 工具描述怎么写才更 agent-friendly

优先写：

- 这个工具做什么
- 输入是什么
- 输出是什么
- 什么时候应该调用
- 有什么限制

避免写成：

- 过于抽象的“执行操作”
- 只有人类看得懂的内部术语
- 一长串实现细节但没有使用条件

## 参数定义建议

### 要写 `description`

```typescript
parameters: {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要读取的文件路径' },
  },
  required: ['path'],
}
```

对 agent 来说，`description` 的价值通常比你多补几层类型更高。

### 保持窄参数面

如果一个工具参数过多，先怀疑是不是应该拆成两个工具，或把一组固定行为收进 Feature 内部状态。

## 工具返回值怎么想

工具返回值会同时影响：

- LLM 下一轮读到的工具结果
- 调试界面的模板渲染

推荐优先返回：

- 简单字符串
- 清晰的结构化对象

如果是错误：

- 可以抛错
- 也可以返回 `{ success: false, error: '...' }`

但不要返回一大坨层级混乱、名字不直观的对象，否则模板和后续推理都会变难。

## 工具上下文的当前事实

工具执行签名虽然是：

```typescript
execute: async (args, context) => { ... }
```

但 `context` 里**没有默认标准 agent/feature 注入**。当前最可靠的来源是 Feature 自己的 `getContextInjectors()`。

例如：

```typescript
getContextInjectors() {
  return new Map([
    ['invoke_skill', () => ({ _context: { skills: this.skills } })],
  ]);
}
```

然后工具里再读取：

```typescript
execute: async (args, context) => {
  const skills = context?._context?.skills;
}
```

所以写工具时不要先假设：

- `context.agent` 一定存在
- `context.feature` 一定存在

## 工具日志怎么写

如果工具属于 Feature，并且你已经有 Feature 状态或初始化 logger，优先走结构化日志，而不是继续扩散裸 `console.*`。

原因很实际：

- 结构化日志能带上 `agent / feature / tool / lifecycle` 上下文
- 成功送达 debugger hub 的日志才能被 `Logs` 面板和 `query_logs` 看见
- debugger 未连接时，这些日志会回退到本地 console，而不是静默消失

对 agent 来说，这比“有时看得到，有时看不到但不知道为什么”更可靠。

## 工具工厂模式

当工具需要访问 Feature 实例状态时，优先用工厂。

```typescript
import { createTool } from '../../core/tool.js';

export function createToggleAwareTool(feature: { isEnabled(): boolean }) {
  return createTool({
    name: 'toggle_aware_tool',
    description: '读取 feature 的启用状态并执行操作。',
    execute: async () => {
      return { enabled: feature.isEnabled() };
    },
  });
}
```

然后在 Feature 中：

```typescript
getTools() {
  return [createToggleAwareTool(this)];
}
```

## 业务 Feature 内封装 MCP 的推荐方式

当前更推荐：

1. 在 Feature 内保留自己的 MCP config
2. 用 `mountMCPToolsFromConfig()` 得到标准 `Tool[]`
3. 统一在这一层做重命名、禁用、描述和渲染

这样 agent 读 skill 时更容易理解“这是一组领域工具”，而不是“外面先挂一个通用 MCP，再在别处做补丁”。

## 易错点

### 1. 工具名和模板名不是一回事

- 工具名：常用 `snake_case`
- 模板名：通常手写成 `kebab-case`

两者要显式对齐。

### 2. `getAsyncTools()` 不是为了拿 Agent 实例

它是为了异步准备工具，不要把它当“访问全部内部运行时”的后门。

### 3. 不要把复杂业务逻辑都塞到 `execute()`

如果逻辑开始需要状态、校验、分支控制、模板、上下文注入，通常已经说明它属于一个 Feature，而不是裸工具。
