---
name: agentdev-usage
description: AgentDev框架使用指南 - Agent基础搭建、配置、会话管理、调试器集成、交互循环。配合agentdev-feature-guide(Feature开发)和agentdev-feature-packaging(打包规范)形成完整开发闭环。使用场景：创建新Agent项目、配置LLM、集成调试器、实现会话持久化、构建交互循环。
---

# AgentDev 框架使用指南

## 🔴 关键约束（使用前必读）

### 1. 调试服务器启动命令
- **正确命令**：`npx agentdev-server`
- **错误命令**：`agentdev-server`（PowerShell 中无法识别）
- **禁止行为**：不要在 Agent 代码中启动服务器进程

### 2. 服务器和 Agent 必须分离运行
```
终端 A → npx agentdev-server  （持久运行，Ctrl+C 关闭）
终端 B → npx tsx index.ts      （Agent 应用）
```

**原因**：服务器是持久进程，如果在 Agent 代码中启动会导致阻塞，无法正常退出。

### 3. 指令交付原则
- 给用户提供**分步指令**，让用户在独立终端中手动执行
- 不要使用 `Bash` 工具执行持久的 `npx agentdev-server` 命令
- 只提供命令文本，由用户自己执行

---

本指南覆盖 Agent 的基础搭建和框架使用。与另外两个技能的职责分工：

| 技能 | 职责 |
|------|------|
| **agentdev-usage** (本文档) | Agent 创建、配置、会话管理、调试器集成、交互循环 |
| **agentdev-feature-guide** | Feature 开发、工具/模板/钩子实现细节 |
| **agentdev-feature-packaging** | Feature npm 包构建、tsup 配置、模板 URL 规则 |

## 安装

```bash
npm install agentdev
```

**调试服务器启动方式**：

```bash
# 方式1：使用 npx（推荐，无需全局安装）
npx agentdev-server

# 方式2：全局安装后直接使用
npm install -g agentdev
agentdev-server

# 自定义端口
npx agentdev-server 3000

# 不自动打开浏览器
npx agentdev-server 2026 false
```

**重要**：调试服务器必须在**独立的终端**中运行，不要在 Agent 代码中启动服务器进程。

## 框架能力概览

### 预设 Agent

| Agent | 用途 | 内置 Feature |
|-------|------|-------------|
| `BasicAgent` | 通用 Agent | MCPFeature, SkillFeature, SubAgentFeature, OpencodeBasicFeature |
| `ExplorerAgent` | 代码探索 | SkillFeature, SubAgentFeature, OpencodeBasicFeature（轻量级） |

### 内置 Feature（打包进 agentdev）

| Feature | 功能 | 提供的工具 |
|---------|------|-----------|
| `MCPFeature` | MCP 服务器集成 | 自动挂载 `.agentdev/mcps/` 下的 MCP 服务 |
| `SkillFeature` | Skills 系统 | `invoke_skill` 工具、技能发现和加载 |
| `SubAgentFeature` | 子代理管理 | `agent_spawn`、`agent_send`、`agent_list`、`agent_close`、`wait` |
| `TodoFeature` | 待办事项管理 | `task_create`、`task_list`、`task_get`、`task_update`、`task_clear` |
| `UserInputFeature` | 命令行输入 | `request_user_input` 工具、交互式输入 |
| `OpencodeBasicFeature` | 文件操作 | `read`、`write`、`list`、`glob`、`grep`、`edit` |

### 独立 Feature 包（需单独安装）

| 包 | 功能 | 安装 |
|---|------|------|
| `@agentdev/shell-feature` | bash 命令、安全删除/恢复 | `npm install @agentdev/shell-feature` |
| `@agentdev/visual-feature` | 视觉理解（需 Python） | `npm install @agentdev/visual-feature` |
| `@agentdev/websearch-feature` | 网页抓取、crawl4ai | `npm install @agentdev/websearch-feature` |
| `@agentdev/audio-feedback-feature` | 音频反馈通知 | `npm install @agentdev/audio-feedback-feature` |
| `@agentdev/audit-feature` | 工具使用审计追踪 | `npm install @agentdev/audit-feature` |
| `@agentdev/memory-feature` | CLAUDE.md 自动注入 | `npm install @agentdev/memory-feature` |
| `@agentdev/plugin-compat-feature` | OpenClaw 插件兼容 | `npm install @agentdev/plugin-compat-feature` |
| `@agentdev/tts-feature` | 文本朗读 | `npm install @agentdev/tts-feature` |

## 快速开始

### ⚠️ 重要：服务器和 Agent 必须分别运行

**调试服务器和 Agent 应用必须在两个独立的终端中运行**：

1. **终端 A**：启动调试服务器（持久运行，Ctrl+C 关闭）
   ```bash
   npx agentdev-server
   ```

2. **终端 B**：运行你的 Agent 应用
   ```bash
   npx tsx index.ts
   ```

**为什么必须分开？**
- 调试服务器是持久进程，会一直占用终端
- 如果在 Agent 代码中启动服务器，会导致进程卡住无法正常退出
- 分离后可以随时独立控制服务器和 Agent 的启停

### 第一步：配置 API

创建 `config/default.json`，填入 API 信息：

```json
{
  "defaultModel": {
    "provider": "openai 或 anthropic",
    "baseUrl": "你的 API 地址",
    "apiKey": "直接填 key 或 ${环境变量名}",
    "model": "你的模型名称"
  }
}
```

**说明**：
- `provider`: openai 兼容 或 anthropic
- `baseUrl`: API 服务地址
- `apiKey`: 直接填 key 或用 `${变量名}` 引用环境变量
- `model`: 模型名称

**环境变量方式**（推荐）：
```bash
export 你的变量名=你的key
# 然后在配置中用: "${你的变量名}"
```

**直接填写方式**：
```json
"apiKey": "sk-your-actual-key-here"
```

### 第二步：创建交互式 Agent（基准模板）

这是**最常用**的 Agent 模式：使用 `UserInputFeature` 构建自循环交互。

```typescript
import { BasicAgent, UserInputFeature, FileSessionStore } from 'agentdev';

const SESSION_ID = 'my-agent-session';

async function main() {
  const agent = new BasicAgent({
    name: '我的助手',
    systemMessage: '你是一个友好的助手。',
  });

  const userInput = new UserInputFeature();
  const sessionStore = new FileSessionStore();

  agent.use(userInput);
  await agent.withViewer('我的助手', 2026, true);

  // 尝试恢复会话
  try {
    await agent.loadSession(SESSION_ID, sessionStore);
    console.log('已恢复上次会话');
  } catch {
    console.log('新会话启动');
  }

  console.log('调试器页面: http://localhost:2026\n');

  // 交互循环
  while (true) {
    const input = await userInput.getUserInput('请输入（输入 exit 退出）：');
    if (input === 'exit' || !input) break;

    const result = await agent.onCall(input);
    await agent.saveSession(SESSION_ID, sessionStore);
    console.log(`结果: ${result}\n`);
  }

  await agent.saveSession(SESSION_ID, sessionStore);
  await agent.dispose();
}

main().catch(console.error);
```

运行：
```bash
npx tsx index.ts
```

### 第三步：添加更多 Feature

```typescript
import { BasicAgent, UserInputFeature, TodoFeature } from 'agentdev';

const agent = new BasicAgent();
agent.use(new UserInputFeature());
agent.use(new TodoFeature()); // 添加待办事项功能
```

使用独立 Feature 包：
```typescript
import { BasicAgent } from 'agentdev';
import { ShellFeature } from '@agentdev/shell-feature';

const agent = new BasicAgent();
agent.use(new ShellFeature()); // 添加 bash 命令执行
```

## 配置系统

### API 配置

`config/default.json`:

```json
{
  "defaultModel": {
    "provider": "你的 provider",
    "baseUrl": "你的 API 地址",
    "apiKey": "直接填 或 ${环境变量}",
    "model": "你的模型名称"
  }
}
```

**说明**：
- 文件位置：项目根目录 `config/default.json`
- apiKey 可以直接填写，或用 `${变量名}` 引用环境变量
- `BasicAgent` 默认自动加载此配置

### .agentdev 目录配置（可选）

| 目录/文件 | 用途 | 何时需要 |
|-----------|------|----------|
| `.agentdev/mcps/*.json` | MCP 服务器配置 | 使用 GitHub、crawl4ai 等 MCP 服务 |
| `.agentdev/skills/` | 自定义 Skills | 使用自定义技能 |
| `.agentdev/bashrc` | Shell 安全配置 | 自定义 bash 行为 |
| `.agentdev/prompts/*.md` | 提示词模板 | 自定义系统提示词 |
| `.agentdev/sessions/` | 会话存储 | 使用 `FileSessionStore` 时自动创建 |

**MCP 配置示例**（`.agentdev/mcps/github.json`）：
```json
{
  "enabled": true,
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token"
      }
    }
  }
}
```

## 核心 API

### Agent 核心 API

| 方法 | 说明 | 返回值 |
|------|------|--------|
| `onCall(input)` | 执行一次对话 | `Promise<string>` |
| `withViewer(name, port, openBrowser)` | 连接调试器 | `Promise<this>` |
| `saveSession(sessionId, store)` | 保存会话 | `Promise<void>` |
| `loadSession(sessionId, store)` | 恢复会话 | `Promise<this>` |
| `rollbackToCall(callIndex)` | 回滚到指定轮次 | `Promise<{draftInput}>` |
| `use(feature)` | 注册 Feature | `this` |
| `dispose()` | 清理资源 | `Promise<void>` |
| `createSessionSnapshot(sessionId)` | 创建会话快照 | `Promise<AgentSessionSnapshot>` |
| `restoreSessionSnapshot(snapshot)` | 恢复会话快照 | `Promise<this>` |

### AgentConfig 配置选项

```typescript
interface AgentConfig {
  /** LLM 客户端实例 */
  llm: LLMClient;
  /** 最大轮次（默认 10） */
  maxTurns?: number;
  /** 系统提示词 */
  systemMessage?: string | TemplateSource;
  /** 预置工具 */
  tools?: Tool[];
  /** Feature 配置 */
  features?: {
    /** 启用的 Feature 列表 */
    enabled?: string[];
    /** Feature 特定配置 */
    [key: string]: unknown;
  };
  /** Agent 名称 */
  name?: string;
}
```

### Feature 注册

```typescript
// 内置 Feature
import { BasicAgent, TodoFeature, UserInputFeature } from 'agentdev';
agent.use(new TodoFeature());
agent.use(new UserInputFeature());

// 独立 Feature 包
import { ShellFeature } from '@agentdev/shell-feature';
agent.use(new ShellFeature());

// 自定义本地 Feature
import { MyFeature } from './features/my-feature.js';
agent.use(new MyFeature());

// 带 Feature 配置
agent.use(new TodoFeature({
  reminderTemplate: '.agentdev/prompts/reminder.md',
  reminderThresholdWithTasks: 3,
}));
```

### 消息系统

```typescript
import { system, user, assistant, toolResult, createMessage } from 'agentdev';

// 创建消息
const sysMsg = system('你是一个助手');
const userMsg = user('你好');
const assistMsg = assistant('收到', [{name: 'tool', args: {}}]);
const resultMsg = toolResult('call-id', '执行结果');

// 通用创建方法
const msg = createMessage('user', '内容');
```

### Context 上下文管理

```typescript
import { Context } from 'agentdev';

const context = new Context();

// 添加消息
context.addSystemMessage('系统提示');
context.addUserMessage('用户输入');
context.add({ role: 'assistant', content: '响应' });

// 获取消息
const all = context.getAll();
const last = context.getLast();
const byRole = context.getByRole('user');

// 工具执行结果
context.addToolResult(toolCall, result);

// 序列化
const snapshot = context.toJSON();
const restored = Context.fromJSON(snapshot);
```

### LLM 客户端

```typescript
import { createLLM, createOpenAILLM, createAnthropicLLM } from 'agentdev';

// 自动创建（从配置）
const llm = createLLM(config);

// OpenAI 兼容
const openaiLLM = createOpenAILLM({
  apiKey: 'sk-...',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4',
});

// Anthropic
const anthropicLLM = createAnthropicLLM({
  apiKey: 'sk-ant-...',
  model: 'claude-3-5-sonnet-20241022',
});
```

**注意**：框架内使用 Agent 时，LLM 调用通过 `onCall()` 方法自动处理，无需直接调用 LLM 客户端。直接使用 LLM 客户端主要用于框架扩展或自定义场景。

## 自定义 Agent

```typescript
import { BasicAgent } from 'agentdev';
import type { BasicAgentConfig, AgentInitiateContext } from 'agentdev';

export class MyAgent extends BasicAgent {
  constructor(config: BasicAgentConfig = {}) {
    super(config);
    // 注册 Feature
  }

  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    await super.onInitiate(ctx);
    // 自定义初始化
  }
}
```

完整示例见 [references/custom-agent.md](references/custom-agent.md)

## 开发工作流

1. **配置 API** - 创建 `config/default.json`
2. **创建交互式 Agent** - 使用 `UserInputFeature` 构建自循环
3. **添加 Feature** - 按需添加功能
4. **连接调试器** - 使用 `withViewer()` 观察
5. **会话持久化** - 使用 `FileSessionStore` 保存/恢复

**需要开发 Feature**：切换到 [agentdev-feature-guide](agentdev-feature-guide)
**需要打包 Feature**：切换到 [agentdev-feature-packaging](agentdev-feature-packaging)

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| API 401/403 | 检查 `config/default.json` 和环境变量 |
| 配置不生效 | 确保配置在项目根目录 `config/default.json` |
| 调试器看不到数据 | 使用交互循环模式，不要单次调用后退出 |
| 调试器连接失败 | 确认 `npx agentdev-server` 已在独立终端启动 |
| PowerShell 中 `agentdev-server` 无效 | 使用 `npx agentdev-server` 而不是直接 `agentdev-server` |
| Agent 卡住不动 | 检查是否错误地在代码中启动了服务器 |

### PowerShell 用户注意

在 PowerShell 中，本地 npm bin 命令不会自动识别，**必须使用 `npx`**：

```powershell
# ✅ 正确
npx agentdev-server

# ❌ 错误（PowerShell 中无法识别）
agentdev-server
```

### 禁止在 Agent 代码中启动服务器

**错误示例**（会导致卡住）：
```typescript
// ❌ 不要这样做！
import { exec } from 'child_process';
exec('npx agentdev-server');  // 会阻塞进程
```

**正确做法**：让用户在独立终端手动启动服务器。

## 参考资源

| 需求 | 参考 |
|------|------|
| 调试器测试 | [references/debugger-testing.md](references/debugger-testing.md) |
| 交互循环 | [references/interactive-loop.md](references/interactive-loop.md) |
| 自定义 Agent | [references/custom-agent.md](references/custom-agent.md) |
| 调试器使用 | [references/debugger.md](references/debugger.md) |

---

## 框架内置系统详解

### Skills 系统

Skills 是可复用的领域知识包，存储在 `.agentdev/skills/` 目录下。

**Skill 结构**：
```
.agentdev/skills/
├── my-skill/
│   ├── SKILL.md          # 技能描述（必需）
│   ├── example.ts        # 示例代码（可选）
│   └── resources/        # 资源文件（可选）
```

**SKILL.md 格式**：
```markdown
---
name: 技能名称
description: 一句话描述
tags: [tag1, tag2]
---

详细的技能说明、使用方法、示例等。
```

**使用 Skills**：
- `SkillFeature` 自动发现 `.agentdev/skills/` 下的技能
- 使用 `invoke_skill` 工具激活特定技能
- 技能可以提供示例代码、领域知识、最佳实践

### MCP 系统

MCP (Model Context Protocol) 服务器配置位于 `.agentdev/mcps/`。

**配置格式**：
```json
{
  "enabled": true,
  "servers": {
    "server-name": {
      "transport": "stdio | sse | http",
      "command": "启动命令",
      "args": ["参数"],
      "env": {"环境变量": "值"},
      "url": "服务地址（http/sse）"
    }
  }
}
```

**传输类型**：
- `stdio`: 标准输入输出通信
- `sse`: Server-Sent Events
- `http`: HTTP 轮询

**常用 MCP 服务器**：
- `@modelcontextprotocol/server-github`: GitHub 集成
- `@modelcontextprotocol/server-filesystem`: 文件系统操作
- `@modelcontextprotocol/server-brave-search`: 网页搜索
- crawl4ai: 网页内容提取（需独立配置）

### 模板系统

支持动态系统提示词，使用 `TemplateComposer` 构建。

```typescript
import { TemplateComposer } from 'agentdev';

const prompt = new TemplateComposer()
  .add({ file: '.agentdev/prompts/system.md' })
  .add('\n\n## 角色\n\n')
  .add('你是一个专业的助手')
  .add({ skills: '- **{{name}}**: {{description}}' })
  .add('\n\n## 工具\n\n')
  .add('你可以使用以下工具...');
```

**占位符类型**：
- `{{variable}}`: 变量替换
- `{ file: "path" }`: 文件内容
- `{ skills: "format" }`: Skills 列表
- `{ config: "key" }`: 配置值

### 生命周期钩子

Agent 提供多个生命周期钩子用于扩展：

| 钩子 | 触发时机 | 用途 |
|------|----------|------|
| `onInitiate` | Agent 首次初始化 | 设置系统提示词、初始化资源 |
| `onDestroy` | Agent 销毁前 | 清理资源、保存状态 |
| `onCallStart` | 每次 `onCall()` 开始 | 输入预处理、命令解析 |
| `onCallFinish` | 每次 `onCall()` 结束 | 结果后处理、状态保存 |
| `onStepStart` | 每个 ReAct 步骤开始 | 步骤初始化 |
| `onStepFinished` | 每个 ReAct 步骤结束 | 步骤结果处理 |
| `onToolUse` | 工具调用前 | 权限检查、参数验证 |
| `onToolFinished` | 工具调用后 | 结果处理、错误恢复 |

**反向钩子装饰器**（Feature 使用）：
```typescript
import { CallStart, CallFinish, StepFinish, ToolFinished } from 'agentdev';

class MyFeature implements AgentFeature {
  @CallStart
  async handleCallStart(ctx: CallStartContext): Promise<void> {
    // 在每次对话开始时执行
  }

  @ToolFinished
  async handleToolFinished(ctx: ToolFinishedDecisionContext): Promise<DecisionResult> {
    // 在工具调用完成后执行，可控制流程
    return Decision.Approve;  // 或 Decision.Deny
  }
}
```

### 工具创建

```typescript
import { createTool } from 'agentdev';

const myTool = createTool({
  name: 'my_tool',
  description: '工具描述',
  parameters: {
    type: 'object',
    properties: {
      arg1: { type: 'string', description: '参数1' },
    },
    required: ['arg1'],
  },
  render: {
    call: 'my-tool-call',    // 调用时的渲染模板名
    result: 'my-tool-result' // 结果时的渲染模板名
  },
  execute: async ({ arg1 }) => {
    return `执行结果: ${arg1}`;
  },
});
```

### 会话管理

**会话快照**：
```typescript
// 创建快照
const snapshot = await agent.createSessionSnapshot('session-id');

// 恢复快照
await agent.restoreSessionSnapshot(snapshot);
```

**快照结构**：
```typescript
interface AgentSessionSnapshot {
  version: number;
  sessionId: string;
  savedAt: number;
  agentType: string;
  runtime: {
    initialized: boolean;
    callIndex: number;
    context: ContextSnapshot;
    featureStates: FeatureStateSnapshot[];
    usageStats: UsageStatsSnapshot;
  };
  rollbackHistory: CallRollbackSnapshot[];
}
```

**回滚功能**：
```typescript
// 回滚到指定轮次
const { draftInput } = await agent.rollbackToCall(2);
console.log(`回滚后待处理输入: ${draftInput}`);
```

### 调试器集成

**启动调试器**：
```typescript
await agent.withViewer('Agent名称', 2026, true);
// 参数：名称、端口、自动打开浏览器
```

**调试器功能**：
- 实时消息流查看
- 工具调用追踪
- 钩子执行状态
- Feature 状态快照
- 会话回滚控制
- 用户输入请求

**独立调试服务器**：
```bash
# 使用 npx（推荐）
npx agentdev-server [port] [no-browser] [uds-path]

# 全局安装后直接使用
npm install -g agentdev
agentdev-server [port] [no-browser] [uds-path]
```

### 日志系统

```typescript
import { createLogger, runWithLogScope } from 'agentdev';

const logger = createLogger('my-feature', {
  agentId: 'agent-123',
  agentName: 'MyAgent',
  tags: ['feature', 'custom'],
});

logger.info('信息消息', { data: 'value' });
logger.warn('警告消息');
logger.error('错误消息');

// 带作用域的日志
await runWithLogScope({
  agentId: 'agent-123',
  callIndex: 1,
  step: 2,
  tags: ['processing'],
}, async () => {
  logger.info('在作用域内执行');
});
```

**日志级别**：`trace`, `debug`, `info`, `warn`, `error`

---

## 常见场景

### 场景 1：带记忆的助手

```typescript
import { BasicAgent, UserInputFeature, FileSessionStore } from 'agentdev';
import { MemoryFeature } from '@agentdev/memory-feature';

const agent = new BasicAgent({
  name: '编程助手',
  systemMessage: '你是一个编程助手，擅长 TypeScript 开发。',
});

agent.use(new UserInputFeature());
agent.use(new MemoryFeature()); // 自动读取 CLAUDE.md

const store = new FileSessionStore();
await agent.withViewer();

while (true) {
  const input = await userInput.getUserInput('> ');
  if (input === 'exit') break;

  await agent.onCall(input);
  await agent.saveSession('memory-session', store);
}
```

### 场景 2：带 Todo 管理的 Agent

```typescript
import { BasicAgent, TodoFeature } from 'agentdev';

const agent = new BasicAgent();
agent.use(new TodoFeature({
  reminderTemplate: '.agentdev/prompts/reminder.md',
  reminderThresholdWithTasks: 3,  // 有任务时每 3 轮提醒
  reminderThresholdWithoutTasks: 6,  // 无任务时每 6 轮提醒
}));

// TodoFeature 会自动：
// - 在适当时候注入待办事项提醒
// - 提供 task_create/list/get/update/clear 工具
```

### 场景 3：多子代理协作

```typescript
import { BasicAgent, SubAgentFeature } from 'agentdev';

const agent = new BasicAgent();
agent.use(new SubAgentFeature());

// SubAgentFeature 提供：
// - agent_spawn: 创建子代理
// - agent_send: 向子代理发送消息
// - agent_list: 列出活跃子代理
// - agent_close: 关闭子代理
// - wait: 等待子代理消息

// 使用示例（通过工具调用）：
// 1. agent_spawn({ name: "researcher", systemMessage: "..." })
// 2. agent_send({ target: "researcher", message: "研究..." })
// 3. wait({ timeout: 30000 })  // 等待子代理响应
```

### 场景 4：使用 MCP 服务

```typescript
import { BasicAgent, MCPFeature } from 'agentdev';

const agent = new BasicAgent();
agent.use(new MCPFeature({
  mcpsDir: '.agentdev/mcps',  // MCP 配置目录
  excludeServers: ['disabled-server'],  // 排除的服务器
}));

// MCPFeature 会自动：
// - 扫描 .agentdev/mcps/ 下的配置
// - 连接启用的 MCP 服务器
// - 将 MCP 工具注册到 Agent
```

### 场景 5：自定义系统提示词

```typescript
import { BasicAgent, TemplateComposer } from 'agentdev';

const systemPrompt = new TemplateComposer()
  .add({ file: '.agentdev/prompts/base.md' })
  .add('\n\n## 专业领域\n\n')
  .add('你专注于 Web 开发，使用 TypeScript 和 React。')
  .add('\n\n## 可用技能\n\n')
  .add({ skills: '- {{name}}: {{description}}' })
  .add('\n\n## 代码规范\n\n')
  .add('- 使用 TypeScript 严格模式\n- 组件使用函数式声明\n- ...');

const agent = new BasicAgent({ systemMessage: systemPrompt });
```

---

## 完整配置示例

### config/default.json

```json
{
  "defaultModel": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o"
  },
  "agent": {
    "maxTurns": 20,
    "temperature": 0.7
  }
}
```

### .agentdev/prompts/system.md

```markdown
你是一个 AI 编程助手。

## 核心原则
1. 先理解问题，再提供解决方案
2. 代码要清晰、可维护
3. 添加必要的错误处理

## 技术栈
- TypeScript + React
- Node.js 后端
- TailwindCSS 样式
```

### .agentdev/mcps/github.json

```json
{
  "enabled": true,
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

---

## 高级用法

### 动态 Feature 加载

```typescript
import { Agent } from 'agentdev';

const agent = new Agent({ ... });

// 根据环境动态加载 Feature
if (process.env.NODE_ENV === 'development') {
  const { DebugFeature } = await import('./features/debug.js');
  agent.use(new DebugFeature());
}
```

### 条件工具注册

```typescript
import { ToolRegistry } from 'agentdev';

const registry = new ToolRegistry();

const tool = createTool({ ... });

// 根据配置决定是否启用
if (config.enableTool) {
  registry.register(tool);
} else {
  registry.register(tool, { enabled: false });
}
```

### 自定义 Context 中间件

```typescript
import type { ContextMiddleware } from 'agentdev';

const customMiddleware: ContextMiddleware = (messages) => {
  // 在每次 LLM 调用前处理消息
  return messages.map(msg => ({
    ...msg,
    content: `[PREFIX] ${msg.content}`
  }));
};

const agent = new Agent({
  contextMiddleware: customMiddleware
});
```

---

## 性能优化建议

1. **使用会话持久化**：避免重复初始化，快速恢复工作状态
2. **合理设置 maxTurns**：控制对话轮次，避免无限循环
3. **Feature 按需加载**：只加载需要的 Feature，减少初始化开销
4. **模板缓存**：`TemplateComposer` 会自动缓存文件内容
5. **日志级别控制**：生产环境使用 `warn` 或 `error` 级别

---

## 版本兼容性

| agentdev | Node.js | 说明 |
|----------|---------|------|
| 0.1.x | >=18.0.0 | ES2022 模块 |
| 未来 | >=20.0.0 | 可能需要 Node 20+ |

**依赖注意**：
- 独立 Feature 包通过 `peerDependencies` 声明兼容的 agentdev 版本
- 升级 agentdev 时，检查 Feature 包的兼容性
- `agentdev": ">=0.1.0"` 表示兼容 0.1.0 及以上版本

---

## 获取帮助

- **Feature 开发问题**：使用 `/agentdev-feature-guide`
- **Feature 打包问题**：使用 `/agentdev-feature-packaging`
- **GitHub Issues**：https://github.com/your-org/agentdev/issues
- **文档更新**：贡献改进建议
