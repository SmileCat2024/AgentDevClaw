# 压缩 Agent 模式匹配问题

> **文档类型**：问题分析 / 设计缺陷
>
> **发现时间**：2026-05-22
>
> **影响范围**：`claw compact` 命令、探索记录的摘要生成

---

## 一、问题概述

**核心问题**：压缩 Agent（Compact Agent）当前使用固定配置（主对话模式），无论压缩什么类型的会话。这导致压缩探索会话时，提示词和功能挂载与原始会话不匹配。

**预期行为**：压缩 Agent 应该根据被压缩会话的类型动态调整配置：
- 压缩主对话会话 → 使用主对话模式
- 压缩探索会话 → 使用探索模式

**当前行为**：压缩 Agent 始终使用主对话模式，无论压缩什么类型的会话。

---

## 二、背景知识

### 2.1 三种运行时配置

编程小助手（`programming-helper`）有三种运行时配置：

| 配置类型 | 环境变量值 | 系统提示词 | 功能挂载 | 使用场景 |
|---------|-----------|-----------|---------|---------|
| **主对话模式** | (未设置或非 `exploration`) | `.agentdev/prompts/system.md` | 完整功能：Todo、Audit、AudioFeedback、WebSearch、Memory、Shell、UserInput | 主对话会话、完整工作空间 |
| **探索模式** | `exploration` | `.agentdev/prompts/explore.md` | 轻量级功能：Shell、WebSearch、Memory | 探索记录（裸 spawn）、子代理对话 |

**关键代码位置**：`prebuilt-agents/official/programming-helper/agent.js`

```javascript
const isExploration = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';

if (isExploration) {
  // 轻量级功能：探索/子代理模式
  this.use(new ShellFeature({ workspaceDir }));
  this.use(new WebSearchFeature());
  this.use(new MemoryFeature());
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

### 2.2 系统提示词差异

**主对话模式**（`.agentdev/prompts/system.md`）：
- 完整的 Claude Code Mini 提示
- 包含所有能力描述（编辑文件、运行测试、Todo 管理、审计等）
- 包含 skills 列表
- 包含 MCP 工具说明

**探索模式**（`.agentdev/prompts/explore.md`）：
- 只读探索代理提示
- 强调搜索和分析能力
- 明确说明"不具备编辑能力"
- 引导 agent 快速、彻底地搜索代码库

### 2.3 压缩机制

压缩（Compact）是生成会话摘要的过程，通过以下命令触发：

```bash
claw compact <exploration-id>
```

**技术实现**：
1. CLI 调用 `/protoclaw/context_handoffs/compact_and_resume` API
2. 服务端启动镜像子进程（Mirror Process）
3. 子进程运行 `scripts/run-compact-mirror.js`
4. 加载原始会话，禁用所有工具
5. LLM 生成摘要（九段式结构）
6. 写入 handoff package 文件

---

## 三、当前实现分析

### 3.1 压缩 Agent 的启动流程

**入口**：`server.js` 的 `/protoclaw/context_handoffs/compact_and_resume` 路由

**关键代码路径**：
```
server.js (compact_and_resume 路由)
  → scripts/run-compact-mirror.js
    → 创建 ProgrammingHelperAgent 实例
    → agent.loadSession(sessionId)
    → 禁用所有工具
    → llm.chat() 生成摘要
```

### 3.2 压缩 Agent 的配置

**问题代码**：`scripts/run-compact-mirror.js`

```javascript
// 当前实现：直接创建 ProgrammingHelperAgent，没有传递任何模式信息
const agent = new ProgrammingHelperAgent({
  agentId: sessionId,
  workspaceDir: process.cwd(),
});

// 没有设置 PROTOCLAW_SESSION_TYPE 环境变量
// 因此 agent 默认使用主对话模式（完整功能 + system.md）
```

**结果**：
- 压缩 Agent 始终使用主对话模式
- 系统提示词是 `system.md`（完整助手）
- 功能挂载是完整功能（Todo、Audit、AudioFeedback 等）
- 虽然工具被禁用，但 Feature 挂载和提示词都不匹配

### 3.3 被压缩会话的类型信息

**会话类型存储**：会话 JSON 文件中的 `session.sessionType` 字段

```json
{
  "session": {
    "sessionType": "exploration",  // 或 "sub" 或未设置（主对话）
    ...
  }
}
```

**关键问题**：
- `run-compact-mirror.js` 在启动压缩 Agent 时**没有读取**被压缩会话的 `sessionType`
- 因此无法根据会话类型调整 Agent 配置

---

## 四、问题详细分析

### 4.1 场景一：压缩主对话会话

**被压缩会话**：
- 类型：主对话会话（`sessionType` 未设置或非 `exploration`）
- 系统提示词：`system.md`
- 功能挂载：完整功能

**压缩 Agent**（当前实现）：
- 系统提示词：`system.md` ✓ 匹配
- 功能挂载：完整功能 ✓ 匹配
- 工具状态：禁用（为了防止 LLM 调用工具）

**评估**：✓ **正确**
- 提示词匹配
- 功能挂载匹配
- 虽然工具被禁用，但这是为了引导 LLM 生成摘要而不是执行操作
- 保留工具 schema 可以利用 prompt caching（系统提示词不变）

### 4.2 场景二：压缩探索会话

**被压缩会话**：
- 类型：探索会话（`sessionType: "exploration"`）
- 系统提示词：`explore.md`（只读探索代理）
- 功能挂载：轻量级功能（Shell、WebSearch、Memory）

**压缩 Agent**（当前实现）：
- 系统提示词：`system.md` ✗ **不匹配**
- 功能挂载：完整功能 ✗ **不匹配**
- 工具状态：禁用

**问题**：
1. **提示词不匹配**：
   - 被压缩会话用的是"只读探索代理"提示
   - 压缩 Agent 用的是"完整工作助手"提示
   - LLM 看到的角色定位与原始会话不一致

2. **功能挂载不匹配**：
   - 被压缩会话只有轻量级功能
   - 压缩 Agent 挂载了完整功能
   - 虽然 tool 能力被禁用，但 Feature 挂载的语义不对

3. **语义错位**：
   - 探索会话的语义是"只读探索，收集情报"
   - 压缩 Agent 用"完整工作助手"的视角去理解
   - 可能导致摘要的语气、重点、风格与原始会话不一致

**评估**：✗ **错误**
- 提示词不匹配
- 功能挂载不匹配
- 压缩结果可能不能准确反映探索会话的上下文和意图

### 4.3 场景三：压缩子代理会话

**被压缩会话**：
- 类型：子代理会话（`sessionType: "sub"`）
- 系统提示词：`explore.md`（子代理使用探索模式）
- 功能挂载：轻量级功能（Shell、WebSearch、Memory）

**压缩 Agent**（当前实现）：
- 与场景二相同的问题

**评估**：✗ **错误**（与探索会话相同的问题）

---

## 五、影响分析

### 5.1 直接影响

1. **摘要质量下降**：
   - 压缩探索会话时，LLM 看到的系统提示词与原始会话不一致
   - 可能导致摘要的语气、重点、风格偏离
   - 例如：探索会话强调"只读搜索"，但压缩 Agent 用"完整助手"视角，可能过度强调"编辑"和"执行"

2. **上下文理解偏差**：
   - 压缩 Agent 用完整功能的视角去理解探索会话
   - 可能误解探索会话的意图和能力范围
   - 例如：探索会话只做了搜索和分析，但压缩 Agent 可能期待有编辑操作

3. **语义不一致**：
   - 同一个会话，原始运行时用"探索代理"，压缩时用"完整助手"
   - 违反了"透明代理"原则：压缩应该镜像原始会话的配置

### 5.2 间接影响

1. **子代理上下文不准确**：
   - 子代理从探索记录派生时，会消费摘要（sourceSummary）
   - 如果摘要不准确，子代理的上下文理解就会有偏差
   - 影响子代理的任务执行质量

2. **知识沉淀失真**：
   - 探索记录的目的是沉淀知识供后续复用
   - 如果摘要不能准确反映探索内容，知识就会失真
   - 影响主代理的决策质量

---

## 六、设计意图

### 6.1 预期行为

压缩 Agent 应该是**透明代理**（Transparent Proxy）：
- 它的配置应该**镜像被压缩会话**的类型
- 压缩主对话会话 → 用主对话模式
- 压缩探索会话 → 用探索模式
- 压缩子代理会话 → 用探索模式

### 6.2 设计原则

1. **配置一致性**：压缩 Agent 的提示词和功能挂载应该与被压缩会话一致
2. **上下文准确性**：压缩结果应该准确反映原始会话的上下文和意图
3. **语义透明性**：压缩过程不应该引入语义偏差

### 6.3 实现目标

```javascript
// 伪代码：期望的实现
const session = loadSession(sessionId);
const sessionType = session.sessionType;  // "exploration" | "sub" | undefined

const agent = new ProgrammingHelperAgent({
  agentId: sessionId,
  workspaceDir: process.cwd(),
  mode: sessionType === 'exploration' || sessionType === 'sub'
    ? 'exploration'  // 使用探索模式
    : 'normal',      // 使用主对话模式
});

// 或者通过环境变量
process.env.PROTOCLAW_SESSION_TYPE =
  (sessionType === 'exploration' || sessionType === 'sub') ? 'exploration' : '';
```

---

## 七、关键文件引用

### 7.1 核心文件

| 文件 | 作用 | 需要修改 |
|------|------|---------|
| `scripts/run-compact-mirror.js` | 压缩子进程入口 | ✓ 是 |
| `server.js` (compact_and_resume 路由) | 压缩 API 端点 | 可能需要 |
| `prebuilt-agents/official/programming-helper/agent.js` | Agent 配置逻辑 | × 否（已支持模式切换） |
| `.agentdev/prompts/system.md` | 主对话系统提示词 | × 否 |
| `.agentdev/prompts/explore.md` | 探索模式系统提示词 | × 否 |

### 7.2 相关文件

| 文件 | 作用 |
|------|------|
| `server/context-continuity/claude-compact-prompts.js` | 压缩提示词模板 |
| `server/context-continuity/summarized-handoff.js` | Handoff package 生成 |
| `local-features/context-compaction-control/src/index.ts` | 压缩控制 Feature |
| `bin/claw.mjs` (cmdCompact) | CLI 命令入口 |

---

## 八、技术细节

### 8.1 会话类型判断

**会话类型存储位置**：
```json
// ~/.agentdev/AgentDevClaw/workspaces/programming-helper/sessions/<sessionId>.json
{
  "session": {
    "sessionType": "exploration",  // 或 "sub" 或未设置
    ...
  }
}
```

**类型定义**：
- `undefined` 或未设置 → 主对话会话
- `"exploration"` → 探索会话
- `"sub"` → 子代理会话

**判断逻辑**：
```javascript
const isExplorationType = sessionType === 'exploration' || sessionType === 'sub';
```

### 8.2 环境变量传递

**当前实现**：
```javascript
// scripts/run-compact-mirror.js
const agent = new ProgrammingHelperAgent({
  agentId: sessionId,
  workspaceDir: process.cwd(),
});
// 没有设置 PROTOCLAW_SESSION_TYPE
```

**期望实现**：
```javascript
// 读取会话类型
const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const sessionType = sessionData.session?.sessionType;

// 设置环境变量
if (sessionType === 'exploration' || sessionType === 'sub') {
  process.env.PROTOCLAW_SESSION_TYPE = 'exploration';
}

// 创建 Agent
const agent = new ProgrammingHelperAgent({
  agentId: sessionId,
  workspaceDir: process.cwd(),
});
```

### 8.3 Agent 构造函数中的模式检测

**当前实现**（`prebuilt-agents/official/programming-helper/agent.js`）：
```javascript
constructor(config = {}) {
  const workspaceDir = config.workspaceDir || process.cwd();
  const isExploration = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';
  // ...
}
```

**关键点**：
- Agent 构造函数已经支持通过环境变量判断模式
- 只需要在创建 Agent 之前设置正确的环境变量
- 不需要修改 Agent 类本身

---

## 九、解决方案概述

### 9.1 核心修改

**文件**：`scripts/run-compact-mirror.js`

**修改点**：
1. 在创建 Agent 之前，读取会话 JSON 文件
2. 提取 `session.sessionType` 字段
3. 根据类型设置 `PROTOCLAW_SESSION_TYPE` 环境变量
4. 然后创建 Agent 实例

### 9.2 伪代码

```javascript
// 1. 读取会话数据
const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const sessionType = sessionData.session?.sessionType;

// 2. 设置环境变量
if (sessionType === 'exploration' || sessionType === 'sub') {
  process.env.PROTOCLAW_SESSION_TYPE = 'exploration';
} else {
  delete process.env.PROTOCLAW_SESSION_TYPE;
}

// 3. 创建 Agent（会根据环境变量自动选择模式）
const agent = new ProgrammingHelperAgent({
  agentId: sessionId,
  workspaceDir: process.cwd(),
});
```

### 9.3 验证点

修改后需要验证：
1. 压缩主对话会话 → Agent 使用主对话模式
2. 压缩探索会话 → Agent 使用探索模式
3. 压缩子代理会话 → Agent 使用探索模式
4. 生成的摘要准确反映原始会话的上下文和意图

---

## 十、总结

### 10.1 问题本质

压缩 Agent 使用固定配置（主对话模式），无法根据被压缩会话的类型动态调整。这导致压缩探索会话时，提示词和功能挂载与原始会话不匹配。

### 10.2 核心矛盾

- **预期**：压缩 Agent 应该镜像被压缩会话的配置
- **实际**：压缩 Agent 始终使用主对话模式

### 10.3 影响范围

- 所有探索会话的压缩（`claw compact <exploration-id>`）
- 所有子代理会话的压缩
- 影响摘要质量、子代理上下文准确性、知识沉淀可靠性

### 10.4 修复方向

在 `scripts/run-compact-mirror.js` 中：
1. 读取被压缩会话的类型
2. 设置 `PROTOCLAW_SESSION_TYPE` 环境变量
3. 让 Agent 构造函数自动选择正确的模式

### 10.5 修复难度

- **技术难度**：低（只是读取 JSON + 设置环境变量）
- **测试难度**：中（需要验证不同类型会话的压缩结果）
- **风险评估**：低（不影响主对话会话的压缩，只修正探索/子代理会话的压缩）

---

**文档状态**：待修复

**下一步**：实施修复方案
