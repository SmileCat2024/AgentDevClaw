# 子任务 4：门户代理适配 + 接待员控制 Feature

## 目标

1. 门户代理（qqbot agent）需要在自身挂载一个"IM 控制台 Feature"，提供工具让接待员 agent 本身也能查询和管理线路转接
2. 简化门户代理中旧的 `_activeIMChannel` 单一通道逻辑，适配新的多通道绑定模型

## 文件

- `D:\code\AgentDevClaw\prebuilt-agents\official\qqbot\agent.js` — 门户代理
- 可能需要新建：`D:\code\AgentDevClaw\local-features\im-control\src\index.ts` — 控制台 Feature（可选，也可以内联）

## 详细上下文

### 当前门户代理状态

`QQBotProgrammingHelperAgent`（qqbot/agent.js）：

- 主模式下挂载 QQBotFeature + WeixinBot + TodoFeature + AuditFeature + WebSearchFeature + ShellFeature + UserInputFeature
- 有 `setCallArbiter()`、`sendIMMessage()`、`startSelectedIMGateway()` 等方法
- `_activeIMChannel` 单值跟踪当前活跃渠道
- `_lastIMTarget` 记录最近 IM 对端

### 新模型下门户代理的定位

门户代理是"接待员"：
1. 自己不一定是 IM 消息的最终处理者
2. 接待员可以通过工具查看当前线路状态
3. 接待员可以通过工具发起线路转接
4. 但实际的转接执行由 server.js API 完成（前端 UI 或 agent 工具都可以触发）

### 接待员控制 Feature 的能力

一个轻量 Feature，挂载到门户代理上，提供以下工具：

1. **`check_line_status`** — 查询所有渠道的当前绑定状态
2. **`transfer_line`** — 将指定渠道转接到目标 session（调用 server API）

这个 Feature 类似 `ClawDispatchFeature` 的模式：通过 HTTP 调用 server API 执行操作。

## 详细步骤

### 步骤 1：创建 IM 控制台 Feature

**方案 A（推荐）**：内联在 qqbot/agent.js 中，作为简单类

因为功能很轻量，不需要独立的 npm 包或构建步骤：

```js
class IMControlFeature {
  constructor() {
    this.name = 'IMControlFeature';
    this._serverOrigin = 'http://127.0.0.1:1420';
  }

  getTools() {
    return [
      {
        name: 'check_line_status',
        description: '查询所有 IM 渠道的当前线路绑定状态',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'transfer_line',
        description: '将指定 IM 渠道转接到目标 agent session',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: '渠道ID: qq 或 weixin' },
            agentId: { type: 'string', description: '目标 agent ID' },
            sessionId: { type: 'string', description: '目标 session ID' },
          },
          required: ['channelId', 'agentId', 'sessionId'],
        },
      },
    ];
  }

  async onInitiate(ctx) {
    // 无需特殊初始化
  }

  async onDestroy() {
    // 无需清理
  }
}
```

工具执行逻辑需要在 agent 的 `onCall` 流程中处理。
但 AgentDev 框架的工具注册是通过 `getTools()` 返回工具定义，然后框架在 LLM 调用 tool_use 时自动路由到 feature。

实际上需要检查 AgentDev 框架如何将 tool call 路由到 feature 的 tool handler。

**替代方案 B**：不做独立 Feature，而是在门户代理的 system prompt 中告诉 LLM 使用前端 UI 操作线路转接。

考虑到用户说"接待员控制上述事情（写一个控制feature，挂载进门户代理）"，还是需要做方案 A。

但当前阶段 AgentDev 框架的 tool 路由机制需要确认：
- `agent.use(feature)` 后，`feature.getTools()` 返回的工具定义会被收集
- LLM 返回 `tool_use` 时，框架会按工具名找到对应的 feature，然后调用 feature 上的对应方法

查看 AgentDev 框架的 feature tool 执行机制：

```js
// 在 agentdev 的 core/feature.ts 中
// Feature 的 tool 执行是通过 tool handler 机制
// 通常 feature 会在 onInitiate 中注册 tool handler
// 或者框架会查找 feature 上与工具名匹配的方法
```

实际上更简单的做法是：Feature 的 `getTools()` 返回工具定义，
然后在 agent 的 tool 执行流程中，feature 可以通过 `registerToolHandler` 或类似机制注册处理器。

**最简洁方案**：在 agent 中覆盖 `handleToolCall` 或使用框架已有的 tool handler 注册机制。

考虑到复杂度，在测试阶段可以：
1. Feature 只提供 `getTools()` 返回工具定义（让 LLM 知道有这些工具可用）
2. 工具的实际执行在 `run-prebuilt-agent.js` 中处理（因为那里有 agent 的 tool 执行入口）

但这不对 — AgentDev 框架应该有标准的 tool 执行路由。

让我检查 AgentDev 的 tool 执行方式。

从 `dispatch-system-design.md` 和 `local-features/dispatch/src/index.ts` 中看到：
`ClawDispatchFeature` 是一个 AgentFeature，它通过 `getTools()` 返回工具列表，
框架自动处理 tool_use 的路由。

关键在于：AgentDev 框架如何将 tool_use 调用映射到 feature 上的方法？

答案在框架源码中，但由于我们不需要修改框架，只需要遵循已有模式。

**最终方案**：创建一个简单 Feature 类，内联在 agent.js 中。
Feature 的 `getTools()` 返回工具定义，`onInitiate()` 不做特殊处理。
框架在执行 tool call 时，会查找注册了该工具的 feature，然后调用 feature 实例上的工具名对应方法。

如果框架不支持这种自动路由，则可以参考 `ClawDispatchFeature` 的实现方式。

### 步骤 2：在门户代理中挂载 IMControlFeature

在 `QQBotProgrammingHelperAgent` 构造函数的主模式分支中：

```js
if (!isExploration) {
  // ... 现有 feature 挂载 ...
  this.use(new IMControlFeature());
}
```

### 步骤 3：清理旧逻辑

旧的 `_activeIMChannel` 单值逻辑可以保留（用于兼容），
但在注释中标明这是过渡状态，后续会由转接管理器接管。

`startSelectedIMGateway()` 在门户代理自身启动时仍然有用（用于门户代理自己的通道），
但它不再代表全局唯一的 IM 通道绑定。

## 验证

1. 门户代理启动正常，IMControlFeature 被挂载
2. 在对话中，LLM 能看到 `check_line_status` 和 `transfer_line` 工具
3. 调用 `check_line_status` 返回当前线路状态
4. 调用 `transfer_line` 触发转接（依赖子任务 3 的 runtime 支持）
