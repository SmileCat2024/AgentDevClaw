# 开发上下文索引

本文件是框架（AgentDev）与产品（AgentDevClaw）之间的跨项目关系索引。
目的：新会话时读取本文件即可快速恢复核心记忆，不必重新全量阅读两个项目。

---

## 一、两项目关系

```
D:\code\AgentDev          框架（TypeScript npm 包）
  ↓ 依赖方式: "agentdev": "file:../AgentDev"
D:\code\AgentDevClaw      产品（JavaScript 运行时 + Web UI）
```

- 框架是纯 TS 库，产出 `dist/` 供产品 `require/import`
- 产品通过 `file:` 协议依赖本地框架，改框架后需重新 `npm install` 或重启
- 产品中的 `local-features/` 是框架 Feature 的本地特化实现，构建产物在 `local-features/dist/`

**核心依赖链：**
```
AgentDev (框架) → 编译 → dist/
                         ↓
AgentDevClaw (产品) → require('agentdev') → 使用框架的 Agent/Feature/Tool 类型
                   → local-features/feature-dev/ → 本地 Feature，也 import agentdev
```

---

## 二、框架关键文件速查

| 文件 | 职责 |
|------|------|
| `src/core/feature.ts` | `AgentFeature` 接口定义（14 个可选方法） |
| `src/core/hooks-decorator.ts` | 反向钩子装饰器（`@CallStart`, `@ToolUse` 等），运行时通过 `_hookDecisions` 元数据注册 |
| `src/core/agent/lifecycle-hooks.ts` | 正向钩子 Mixin（`onInitiate`, `onCallStart` 等），Agent 子类 override |
| `src/core/tool.ts` | `createTool()` 工厂 + `ToolRegistry`，Tool 的 parameters 是 `Record<string, any>`（实际期望 JSON Schema） |
| `src/core/context.ts` | `Context` 类，消息容器，支持 enrichment 和 query |
| `src/core/checkpoint.ts` | Session 快照、rollback 机制 |
| `src/core/template/` | 模板系统（composer, resolver, loader） |
| `src/core/debugger-mcp.ts` | ViewerWorker MCP 集成 |
| `src/core/render.ts` | Tool 渲染配置 |
| `src/features/` | 内置 Feature（shell, websearch, todo, mcp, visual, subagent, skill, opencode-basic 等） |
| `src/skills/` | Skill 加载器 + 类型定义 |
| `src/mcp/` | MCP 协议实现（client, mount, config, adapter） |
| `src/llm/` | LLM 抽象层（OpenAI/Anthropic 兼容） |
| `packages/create-feature/` | `npx @agentdev/create-feature` 脚手架 CLI |

### 框架核心类型导出路径
```
agentdev  →  Agent, BasicAgent, AgentConfig
          →  AgentFeature, FeatureInitContext, FeatureStateSnapshot
          →  Tool, createTool, ToolRenderConfig
          →  Context, Message, EnrichedMessage
          →  CallStart, CallFinish, StepFinish, ToolUse, ToolFinished  (装饰器)
          →  Decision, DecisionResult, HookResult
          →  FileSessionStore, getDefaultSessionStore
          →  TemplateComposer, getPackageInfoFromSource
```

---

## 三、产品关键文件速查

| 文件 | 职责 |
|------|------|
| `server.js` | 主服务：启动 ViewerWorker、扫描预制 agent、管理 runtime 进程、代理前端请求 |
| `public/index.html` | 单页前端：左侧 agent 列表、右侧 workspace/chat 切换、block 渲染系统 |
| `scripts/run-prebuilt-agent.js` | 预制 agent runtime：加载 agent.js、挂到 ViewerWorker、管理会话 |
| `local-features/feature-dev/src/index.ts` | FeatureDevFeature：模式切换、文档集管理、打包入库 |
| `local-features/dist/index.js` | 上述 TS 的编译产物，被预制 agent 直接引用 |
| `package.json` | 依赖框架 `file:../AgentDev` + 内置 Feature tgz |

### 预制 agent 结构
```
prebuilt-agents/official/<agent-id>/
  ├── metadata.json    ← UI 声明（tabs, blocks, forms）、feature 列表、入口
  ├── agent.js         ← Agent 类，export 继承 BasicAgent
  └── .agentdev/
      └── prompts/     ← 系统提示词 markdown
```

### 预制 agent 一览
| Agent | 入口 | 用途 |
|-------|------|------|
| feature-creator | home → chat | 自然语言开发 Feature，打包入库 |
| agent-creator | my-chatbots / assembly / project | 装配 chatbot 或初始化 Agent 项目 |
| programming-helper | workbench | 面向真实编码任务的工作空间 |
| qqbot | home / chat | QQ Bot 集成，gateway 管理 |

---

## 四、核心数据流

### Feature 创建流程
```
用户填写表单（feature_name, goal, constraints, target_dir）
  ↓ 写入
~/.agentdev/AgentDevClaw/workspaces/feature-creator/state.json
  ↓ FeatureCreatorAgent.onCall() 读取
FeatureDevFeature.@CallStart 注入 workspace markdown 到上下文
  ↓ AI 对话开发
src/index.ts 写好 → npm run build → dist/index.js 产出
  ↓ featuredev_package_to_repository
自动补 agentdev-feature.json → npm pack → 复制 tgz
  ↓ 产出
~/.agentdev/AgentDevClaw/user-features/<name>-<version>.tgz
  或 resources/features/<name>-<version>.tgz
```

### Agent 装配流程
```
用户在 agent-creator 的 assembly-workbench 勾选 Feature tgz
  ↓ 前端提交 assembly-form
selected_features 字段写入 workspace state
  ↓ 创建会话 → server.js 启动 runtime
AgentCreatorAgent 构造函数读取 assembly-form
  ↓ onCall → ensureAssemblyFeaturesMounted()
instantiateSelectableFeature() 对每个 token:
  createRequire → import → /Feature$/.test(name) 找类 → new → agent.use()
  ↓ 组装完成
Agent 以装配模式运行，system prompt 动态拼接目标用户/约束/能力列表
```

### 会话管理路径
```
工作空间类 agent (feature-creator, agent-creator, programming-helper):
  ~/.agentdev/AgentDevClaw/workspaces/<agentId>/sessions/

普通预制 agent (qqbot):
  ~/.agentdev/AgentDevClaw/prebuilt-sessions/<agentId>/
```

---

## 五、框架 ↔ 产品的连接点

### 1. Feature 加载机制

产品侧 `instantiateSelectableFeature()`（agent-creator/agent.js:67-96）是框架 Feature 系统的消费者：

```js
// 产品侧：靠正则 /Feature$/.test(name) 找导出类
const entry = Object.entries(mod).find(([name, value]) =>
  typeof value === 'function' && /Feature$/.test(name)
);
const FeatureClass = entry[1];
return new FeatureClass(featureConfig);
```

**隐式契约：** Feature 包的导出类名必须以 `Feature` 结尾，否则装配失败且无明确错误。

### 2. Feature 注册到 Agent

框架侧 `agent.use(feature)` 的行为：
- 如果 feature 有 `getTools()` → 立即注册到 ToolRegistry
- 如果 feature 有 `getAsyncTools()` → 等待 `onInitiate` 阶段注册
- 如果 feature 有反向钩子装饰器 → 通过 `_hookDecisions` 元数据注册到 hooks executor

### 3. 反向钩子注册原理

```ts
// hooks-decorator.ts 运行时行为：
@CallStart                              // 装饰器在类构造函数上设置元数据
async injectWorkspaceState(ctx) { }     // hooks-executor 在对应生命周期扫描元数据并调用
```

关键约束（在 `DECISION_HOOKS` 中）：
- `@StepFinish` 和 `@ToolUse` 每个 Feature 只能各注册一个
- 其他钩子（`@CallStart`, `@ToolFinished` 等）可以多个

### 4. Tool 的 Context 注入

```ts
// Feature 声明注入器
getContextInjectors(): Map<string | RegExp, ContextInjector> {
  const map = new Map();
  map.set('my_tool', (call) => ({ myState: this.state }));
  return map;
}

// 框架在执行 Tool 时合并注入
execute(args, { ...contextInjectors匹配结果, ...frameworkContext })
```

AI 写 Feature 时经常遗漏这一步，导致 Tool 的 execute 收到的 context 为空。

---

## 六、已知痛点和改进方向

### 当前痛点（按优先级）

**P0：Feature 开发后无法立即验证**
- 写完代码 → 只能打包 → 进仓库 → 装配时才发现问题
- 计划：加结构验证层（dry-run import + 反射检查），AI 可自行调用
- 位置：`local-features/feature-dev/src/index.ts` 加 `featuredev_validate` 工具

**P0：AI 写 Feature 时对钩子映射理解不准**
- 用户需人工翻译"什么时机"对应"什么装饰器"
- 根因：skills 里缺少强意图→钩子映射表
- 位置：`local-features/feature-dev/skills/agentdev-feature-guide/SKILL.md`

**P1：装配时 Feature 加载失败的错误信息不透明**
- `instantiateSelectableFeature` 失败只 `console.warn`，不反馈给 LLM 和前端
- 位置：`prebuilt-agents/official/agent-creator/agent.js:87-95`

**P2：Feature 间无兼容性检查**
- assembly-form 多选 Feature 无冲突检测
- `dependencies?: string[]` 无版本约束无解析
- 当前阶段用户只有自己，ROI 低，不急

### 不做的事（当前阶段刻意保持）

- 不做全局 Feature marketplace / registry
- 不做多 Agent workspace 编排器
- 不做 Feature 级别版本管理 / semver
- 不做框架大重构（只加不改）

---

## 七、开发时的快速定位指南

**"我改了框架代码，产品没生效"**
→ 框架根目录 `npm run build` → 产品根目录 `npm install` → 重启

**"Feature 打包后装配不上"**
→ 检查导出类名是否以 Feature 结尾
→ 检查 tsup.config.ts entry 是否包含 src/index.ts
→ 检查 package.json main 是否指向 dist/index.js

**"反向钩子没触发"**
→ 检查 tsconfig.json 是否开启 experimentalDecorators
→ 检查装饰器是否在方法上（不是属性上）
→ 检查是否同一个 Decision 钩子注册了两次（会编译报错）

**"Tool 注册了但 Agent 看不到"**
→ 检查是 getTools（同步）还是 getAsyncTools（异步）
→ 异步工具需要 onInitiate 触发后才注册
→ 检查 ToolRegistry 的 enable/disable 状态

**"改了 local-features 的 TS 代码"**
→ `npm run build:local-features` → 重启产品

---

## 八、运行时模式

### 两种模式

产品当前只有**两种运行时模式**，通过 `PROTOCLAW_SESSION_TYPE` 环境变量区分：

| 模式 | 环境变量值 | 功能挂载 | 使用场景 |
|------|-----------|---------|---------|
| **Normal mode** | (未设置或非 `exploration`) | 完整功能：Todo、Audit、AudioFeedback、WebSearch、Memory、Shell、UserInput | 主代理对话、完整工作空间 |
| **Exploration mode** | `exploration` | 轻量级功能：Shell、WebSearch、Memory | 探索记录、子代理对话 |

**关键事实**：
- 探索记录（裸 spawn）和子代理（从探索派生）**都使用 exploration mode**
- 探索模式是只读代理，不具备完整编辑能力（无 Todo、Audit、AudioFeedback、UserInput）
- `PROTOCLAW_SESSION_TYPE` 在 `server.js` 的 `startOneShotAgent()` 中设置

### 模式检测与功能挂载

位置：`prebuilt-agents/official/programming-helper/agent.js`

```js
const isExploration = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';

if (isExploration) {
  // 轻量级功能：探索/子代理模式
  this.use(new ShellFeature({ workspaceDir }));
  this.use(new WebSearchFeature());
  this.use(new MemoryFeature());  // CLAUDE.md 注入来源
} else {
  // 完整功能：主代理模式
  this.use(new TodoFeature({ ... }));
  this.use(new AuditFeature());
  this.use(new AudioFeedbackFeature({ ... }));
  this.use(new WebSearchFeature());
  this.use(new MemoryFeature());
  this.use(new ShellFeature({ workspaceDir }));
  this.use(new UserInputFeature());
}
```

### 系统提示词差异

| 模式 | 系统提示词文件 | 内容 |
|------|--------------|------|
| Exploration mode | `.agentdev/prompts/explore.md` | 只读探索代理提示，强调搜索和分析能力 |
| Normal mode | `.agentdev/prompts/system.md` | 完整 Claude Code Mini 提示 + skills + MCP |

### 子代理上下文注入

子代理从探索记录派生时，通过 `ContextHandoffSeedFeature` 注入两类上下文：

1. **全量历史**（`seedMessages`）：原始探索对话的完整消息，**不做任何处理**，保留所有字段（role、content、toolCalls、toolCallId、turn）
2. **交接班信息**：`sourceSummary`（九段式摘要）+ `importantFiles` + `importantSkills` + `fileRanges`

位置：`local-features/context-handoff-seed/src/index.ts`

```ts
// 全量历史：原始直通，不做规范化处理
seedMessages.forEach((message, index) => {
  const turn = typeof message?.turn === 'number' ? message.turn : (fallbackTurn + index);
  ctx.context.add({ ...message, turn });  // 保留所有原始字段
});

// 交接班摘要：始终注入，与 seedMessages 并行
if (this.handoff.sourceSummary) {
  ctx.context.addSystemMessage(buildFallbackSeedMessage(this.handoff), injectionTurn, this.name);
}
```

### 关键设计原则

1. **全量历史 = 对话重放**：本质上就是在老会话记录上继续，理论上不需要对老的会话内容有任何处理
2. **CLAUDE.md 来自 MemoryFeature**：不是特殊处理，而是 MemoryFeature 在所有模式下都提供的能力
3. **探索记录和子代理是同一模式**：字面意思上，"探索模式就是子代理的一种"
4. **sourceSummary 与 seedMessages 并行注入**：不是互斥关系，两者都注入到子代理上下文

### 相关文档

- `docs/claw-cli-redesign.md` - 产品语义设计（三种实体：Exploration、Sub-agent、Summary）
- `docs/context-compaction-structured-output-design.md` - 结构化压缩输出设计
- `C:\Users\zty20\.claude\skills\claw-cli\SKILL.md` - 用户面向的 claw-cli 技能文档
