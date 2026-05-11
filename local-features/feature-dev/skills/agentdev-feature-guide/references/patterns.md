# 设计模式

下面这些模式，优先服务于当前 AgentDev 的设计取向：Feature 应该是稀疏依赖、agent-first、便于被打包成 skill。

## 1. 能力包模式

一个 Feature 内聚地放：

- 工具
- 模板
- 少量状态
- 少量反向钩子

适合大多数业务能力。

## 2. 工具工厂模式

当工具需要读取 Feature 状态时，用工厂而不是把逻辑散落到多个自由函数。

```typescript
export function createTaskTool(feature: { listTasks(): unknown[] }) {
  return createTool({
    name: 'task_list',
    description: '列出当前任务。',
    execute: async () => feature.listTasks(),
  });
}
```

## 3. 初始化发现模式

如果工具列表依赖 discover 或远端能力探测：

- 在 `getAsyncTools()` 做 discover
- 或在 `onInitiate()` 先准备资源，再让工具读取资源

## 4. 受管 MCP 封装模式

业务 Feature 内封装 MCP 时：

- Feature 自己持有 config / manager / clients
- 统一 mapName / describe / render / disable
- 输出标准 `Tool[]`

这样 skill 化后，agent 看到的是一组稳定领域工具，而不是一套外部接线过程。

## 5. 稀疏依赖模式

如果 Feature A 真需要 Feature B：

- 用 `dependencies`
- 通过 `getFeature()` 读取 B 的公开 API

但只暴露小接口。

```typescript
type TodoApi = { listTasks(): unknown[] };

async onInitiate(ctx: FeatureInitContext): Promise<void> {
  const todo = ctx.getFeature<TodoApi & AgentFeature>('todo');
  this.todoApi = todo;
}
```

## 6. 提醒注入模式

适合 Todo、审计、预算、模式切换类 Feature。

核心思路：

- 在 `@StepStart` 判断条件
- 满足时向 `context` 注入一条 system 提示

这比让 agent 每次自己想起“我是不是忘了某事”更稳定。

## 7. 工具前拦截模式

适合：

- 危险命令阻断
- 权限校验
- 状态前置条件检查

统一放在 `@ToolUse`，不要把拒绝逻辑散在各个工具内部。

## 8. Step 续跑模式

适合：

- 子 agent 回传
- 等待外部状态变化
- LLM 本轮没出 tool call，但你明确知道还应继续

统一放在 `@StepFinish`。

## 9. 显式状态快照模式

适合：

- todo 列表
- read-history
- 模式开关
- reminder 计数器
- 增量注入状态

做法：

- 只快照真正影响行为的字段
- 保持快照是简单可序列化数据
- 恢复时完整覆盖这些字段

不适合：

- client
- worker
- 子进程
- 子代理活体运行态

## 10. 资源重建 / 降级模式

适合：

- MCP client
- websocket gateway
- worker pool
- subagent pool

做法：

- 新实例初始化时重建资源
- 不能真实恢复时，明确清空或降级
- 必要时打印 warning，而不是默默假装恢复成功

## 不推荐的模式

### 1. 稠密互调模式

多个 Feature 相互调用大量内部方法、共享大块状态。

这通常意味着 Feature 边界没立住。

### 2. 全部逻辑塞工具模式

如果工具开始承担：

- 大量状态迁移
- 大量运行时控制
- 大量上下文注入

说明它已经长成 Feature 了。

### 3. 为了“形式统一”强行上复杂抽象

AgentDev 更适合清晰的能力切片，不适合为了图式美观把本来简单的 Feature 改造成重 workflow。

## 做成 skill 时的额外建议

如果你预计未来这个 Feature 会进入 skill：

- 工具描述写得像给 agent 读，不像给工程师读
- 模板名和工具名要稳定
- 报错消息要让 agent 能据此修正行为
- 把“当前实现未直接提供”的点明确写出来
