# 压缩产品语义混淆问题分析

> **文档类型**：问题分析 / 产品语义混淆
>
> **发现时间**：2026-05-22
>
> **影响范围**：探索记录的摘要生成、子代理上下文注入准确性

---

## 一、问题概述

用户发现 Claw CLI 和 Web UI 执行探索摘要压缩时存在以下问题：

1. **摘要格式混乱**：生成的摘要有时是九段式交接信息格式，有时是三段式探索摘要格式
2. **Agent 模式不匹配**：压缩 Agent 使用固定配置（主对话模式），无论压缩什么类型的会话
3. **报错问题**：压缩时偶尔出现 "Unexpected non-whitespace character after JSON at position 2" 错误

核心问题：**产品语义混淆——"摘要"（Exploration Summary）和"交接信息"（Handoff Context）被混为一谈**。

---

## 二、产品语义澄清

### 2.1 两个不同的概念

根据 `docs/plans/claw-cli-redesign.md` 和 `docs/plans/context-compaction-structured-output-design.md`，当前系统中有**两个不同但相关的概念**：

#### 概念 1：探索摘要（Exploration Summary）

- **用途**：读给**主代理**看的，用于快速判断"这条探索记录跟我的当前任务相关吗"
- **场景**：一览列表中的快速扫描和相关度评估
- **形态**：独立产物，存储在探索记录目录下
- **格式**：三段式结构
  1. 探索目标与范围
  2. 关键发现与结论
  3. 重要的代码位置与文件
- **产物**：`.agentdev/AgentDevClaw/handoffs/exploration-<id>-summary.json`
- **生成命令**：`claw compact <exploration-id>`

#### 概念 2：交接信息（Handoff Context）

- **用途**：用于**注入子代理上下文**，让子代理恢复操作能力
- **场景**：从探索记录派生子代理时，交接上下文给子代理
- **形态**：handoff package 的一部分，与 seedMessages 并行注入
- **格式**：九段式结构 + 重要文件 + 重要技能
  1. 主要请求与意图
  2. 关键技术概念
  3. 文件与代码段
  4. 错误与修复
  5. 问题解决过程
  6. 用户方向调整
  7. 待办事项
  8. 当前工作
  9. 可选的下一步
- **产物**：`.agentdev/AgentDevClaw/handoffs/<handoff-id>.json`
- **包含字段**：
  ```json
  {
    "seedMessages": [...],
    "sourceSummary": "九段式摘要文本",
    "importantFiles": ["src/auth.ts", ...],
    "importantSkills": ["weather", ...],
    "fileRanges": {...}
  }
  ```

### 2.2 两者的关系

```
探索记录（Exploration Record）
  ├─ 探索摘要（Exploration Summary）← 给主代理看的
  └─ 交接信息（Handoff Context）← 给子代理注入用的
      ├─ sourceSummary（九段式摘要）
      ├─ seedMessages（可选的完整历史）
      ├─ importantFiles
      └─ importantSkills
```

**关键区别**：
- 探索摘要是**独立产物**，直接存储在探索记录目录下
- 交接信息是**派生产物**，存储在 handoffs 目录下，用于启动子代理

---

## 三、当前实现分析

### 3.1 压缩提示词的实现

位置：`server/context-continuity/claude-compact-prompts.js`

```javascript
// 探索摘要提示词（三段式）
const EXPLORATION_SUMMARY_PROMPT = `你的任务是为一次代码探索生成一份精炼的探索摘要，帮助读者快速判断"这条探索记录跟我的当前任务相关吗"。

摘要面向主代理，用于一览列表中的快速扫描和相关度评估，不注入子代理上下文。

按以下三段输出：
1. **探索目标与范围**
2. **关键发现与结论**
3. **重要的代码位置与文件**
...`;

// 交接信息提示词（九段式）
const BASE_SUMMARY_PROMPT = `你的任务是为当前对话创建一份详细摘要，重点关注用户的明确请求和你之前采取的行动。
这份摘要应保留恢复工作所需的任务连续性关键信息。
...九段式结构...`;

export function buildClaudeCompactPrompt(options = {}) {
  const isExploration = options.sessionType === 'exploration';
  if (isExploration) {
    return [
      EXPLORATION_SUMMARY_PREAMBLE,
      '',
      EXPLORATION_SUMMARY_PROMPT,  // ← 三段式
      ...
    ].join('\n');
  }
  return [
    TOOL_CALL_PREAMBLE,
    '',
    BASE_SUMMARY_PROMPT,  // ← 九段式
    ...
  ].join('\n');
}
```

**关键点**：提示词已正确区分两种格式，通过 `options.sessionType` 判断。

### 3.2 调用链分析

#### 路径 A：CLI 命令（`bin/claw.mjs`）

```javascript
// bin/claw.mjs line 421-427
const args = [
  join(projectRoot, 'scripts', 'run-compact-mirror.js'),
  agentDir,
  'programming-helper',
  sessionId,
  JSON.stringify({ sessionType: 'exploration' }),  // ← 硬编码为 exploration
  resultPath,
];
```

**问题**：硬编码 `sessionType: 'exploration'`，总是生成探索摘要（三段式），无法生成交接信息（九段式）。

#### 路径 B：Server API（`server.js`）

```javascript
// server.js line 2610-2618
return exportSummarizedHandoffPackage({
  userDataRoot: USER_DATA_ROOT,
  agentId: ownerAgentId,
  sessionId,
  sourceRecord: record,  // ← 包含 sessionType
  policy,
  agentRelativeDir: agent.relativeDir,
  projectRoot: __dirname,
});
```

```javascript
// server/context-continuity/summarized-handoff.js line 255-258
JSON.stringify({
  maxAttempts: policy.maxAttempts,
  additionalInstructions: policy.additionalInstructions,
  // ← 没有 sessionType！
}),
```

**问题**：`sourceRecord` 包含 `sessionType`，但没有传递给 mirror 脚本，导致总是使用默认的九段式提示词。

#### 路径 C：Mirror 脚本（`scripts/run-compact-mirror.js`）

```javascript
// scripts/run-compact-mirror.js line 308-311
const prompt = options.promptOverride || buildClaudeCompactPrompt({
  additionalInstructions: options.additionalInstructions,
  sessionType,  // ← 从 options.sessionType 读取
});
```

**关键点**：Mirror 脚本正确接收和使用了 `sessionType` 参数。

### 3.3 压缩 Agent 模式问题

位置：`scripts/run-compact-mirror.js` line 170-175

```javascript
const agent = new AgentClass({
  name: agentName,
  projectRoot: PROTOCLAW_ROOT,
  workspaceDir,
  maxTurns: 1,
});
// ← 没有根据被压缩会话的类型设置环境变量
```

**问题**：
- 没有读取被压缩会话的 `sessionType`
- 没有设置 `process.env.PROTOCLAW_SESSION_TYPE`
- Agent 默认使用主对话模式（完整功能 + `system.md`）

---

## 四、问题详细分析

### 4.1 问题 1：探索摘要生成时提示词不匹配

**场景**：用户执行 `claw compact <exploration-id>`

**期望行为**：
- 生成探索摘要（三段式）
- 摘要给主代理看，用于快速扫描相关度
- 存储在探索记录目录下

**当前行为**：
- CLI 硬编码 `sessionType: 'exploration'`（正确）
- 但 Server API 路径没有传递 `sessionType`
- 导致有些情况下使用九段式提示词

**影响**：
- 探索摘要是九段式而不是三段式
- 主代理扫描时看到的是"交接信息"格式，不是"探索摘要"格式

### 4.2 问题 2：交接信息生成时 Agent 模式不匹配

**场景**：从探索记录派生子代理

**期望行为**：
- 压缩 Agent 使用探索模式（轻量级功能 + `explore.md`）
- 生成的交接信息准确反映探索会话的上下文

**当前行为**：
- 压缩 Agent 使用主对话模式（完整功能 + `system.md`）
- 用"完整工作助手"的视角去理解"只读探索代理"的会话

**影响**：
- 摘要的语气、重点、风格与原始会话不一致
- 子代理的上下文理解有偏差

### 4.3 问题 3：两种格式混用导致的产品语义混乱

**根本原因**：
1. 探索摘要和交接信息使用同一个压缩入口（`run-compact-mirror.js`）
2. 但通过 `sessionType` 参数区分格式
3. 不同调用路径对 `sessionType` 的处理不一致

**表现**：
- CLI 命令总是生成探索摘要（三段式）
- Server API 可能生成交接信息（九段式）
- 用户看到的摘要格式不确定

### 4.4 问题 4：报错问题

错误信息：`"Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)"`

**可能原因**：
1. LLM 返回的不是有效 JSON
2. `stripCompactAnalysis` 解析失败
3. 工具调用的 `arguments` 解析失败

**需要进一步调查**：具体的错误日志和 LLM 返回内容。

---

## 五、设计意图澄清

### 5.1 探索摘要（Exploration Summary）

**目的**：让主代理快速判断探索记录的相关度

**使用场景**：
```
主代理："我需要了解 Flow 编排的架构"
  ↓
主代理调用 `claw explorations` 列出所有探索记录
  ↓
主代理扫描每个探索记录的摘要（三段式）
  ↓
主代理判断："这条探索记录是关于 Flow Hook 的，跟我的任务相关"
  ↓
主代理调用 `claw spawn <exploration-id> --goal "深入分析 Hook 驱动机制"`
```

**关键特征**：
- 面向主代理，不注入子代理
- 精炼、聚焦相关度判断
- 三段式结构：目标、发现、重要文件

### 5.2 交接信息（Handoff Context）

**目的**：让子代理恢复操作能力

**使用场景**：
```
主代理："基于探索记录，深入分析 ToolRegistry 权限检查"
  ↓
主代理调用 `claw spawn <exploration-id> --goal "..."`
  ↓
系统生成 handoff package（包含九段式摘要 + 文件 + 技能）
  ↓
子代理启动，注入 handoff context
  ↓
子代理有完整的上下文（摘要 + 重要文件内容 + 重要技能）
```

**关键特征**：
- 面向子代理，注入上下文
- 详细、保留恢复工作所需的信息
- 九段式结构 + 文件列表 + 技能列表

### 5.3 两者的关系

```
探索记录
  ├─ 探索摘要（独立产物）
  │   └─ 用途：主代理扫描相关度
  └─ 交接信息（派生产物）
      └─ 用途：子代理恢复上下文
```

**关键理解**：
- 探索摘要是"概览"，给主代理看的
- 交接信息是"详情"，给子代理用的
- 两者可以同时存在，各有用途
- 当前实现中，交接信息中的 `sourceSummary` 是九段式，探索摘要应该是三段式

---

## 六、修复方案

### 6.1 修复压缩 Agent 模式匹配

**文件**：`scripts/run-compact-mirror.js`

**修改点**：
1. 在创建 Agent 之前，读取会话 JSON 文件
2. 提取 `session.sessionType` 字段
3. 根据类型设置 `PROTOCLAW_SESSION_TYPE` 环境变量
4. 然后创建 Agent 实例

**代码**：
```javascript
// 1. 读取会话数据
const sessionPath = join(getSessionStoreDir(agentId), `${sessionId}.json`);
const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
const sessionType = sessionData.session?.sessionType;

// 2. 设置环境变量
if (sessionType === 'exploration' || sessionType === 'sub') {
  process.env.PROTOCLAW_SESSION_TYPE = 'exploration';
} else {
  delete process.env.PROTOCLAW_SESSION_TYPE;
}

// 3. 创建 Agent（会根据环境变量自动选择模式）
const agent = new AgentClass({
  name: agentName,
  projectRoot: PROTOCLAW_ROOT,
  workspaceDir,
  maxTurns: 1,
});
```

### 6.2 修复压缩提示词类型判断

**文件**：`server/context-continuity/summarized-handoff.js`

**修改点**：
1. 从 `sourceRecord` 读取 `sessionType`
2. 传递给 mirror 脚本的 `options`

**代码**：
```javascript
const mirrorResult = await runMirrorCompaction(
  mirrorScriptPath,
  [
    agentRelativeDir,
    agentId,
    sessionId,
    JSON.stringify({
      maxAttempts: policy.maxAttempts,
      additionalInstructions: policy.additionalInstructions,
      sessionType: sourceRecord.sessionType,  // ← 新增
    }),
  ],
  path.resolve(String(projectRoot || '').trim()),
);
```

### 6.3 修复 CLI 命令的硬编码

**文件**：`bin/claw.mjs`

**修改点**：
1. 从会话索引读取 `sessionType`
2. 根据类型传递正确的参数

**代码**：
```javascript
// 读取会话记录
const sessionType = cleanText(record.sessionType);
const isExploration = sessionType === 'exploration' || record.metadata?.clean === true;

// 传递正确的 sessionType
const args = [
  join(projectRoot, 'scripts', 'run-compact-mirror.js'),
  agentDir,
  'programming-helper',
  sessionId,
  JSON.stringify({
    sessionType: isExploration ? 'exploration' : '',  // ← 动态判断
  }),
  resultPath,
];
```

### 6.4 调查报错问题

**需要**：
1. 收集完整的错误日志
2. 检查 LLM 返回的原始内容
3. 分析 JSON 解析失败的具体原因
4. 可能需要调整提示词或添加 fallback 逻辑

---

## 七、验证点

修复后需要验证：

### 7.1 探索摘要生成

```bash
# 1. 生成探索摘要
claw compact <exploration-id>

# 2. 检查摘要格式
# 应该是三段式：目标、发现、重要文件

# 3. 检查 Agent 模式
# 应该使用探索模式（explore.md + 轻量级功能）
```

### 7.2 交接信息生成

```bash
# 1. 从探索记录派生子代理
claw spawn <exploration-id> --goal "..."

# 2. 检查 handoff package
# sourceSummary 应该是九段式
# 包含 importantFiles 和 importantSkills

# 3. 检查子代理上下文
# 应该注入了摘要 + 文件内容 + 技能内容
```

### 7.3 主对话会话压缩

```bash
# 1. 压缩主对话会话（通过 API）
# 应该生成交接信息（九段式）

# 2. 检查 Agent 模式
# 应该使用主对话模式（system.md + 完整功能）
```

---

## 八、总结

### 8.1 问题本质

产品语义混淆——探索摘要和交接信息被混为一谈，导致：
1. 提示词格式不确定（三段式 vs 九段式）
2. Agent 模式不匹配（探索模式 vs 主对话模式）
3. 产物用途不清（给主代理看 vs 给子代理用）

### 8.2 核心矛盾

- **预期**：探索摘要（三段式）+ 交接信息（九段式）
- **实际**：两种格式混用，生成哪种取决于调用路径

### 8.3 影响范围

- 所有探索记录的摘要生成
- 所有子代理的上下文注入
- 主代理的相关度判断准确性

### 8.4 修复方向

1. **区分两种产物**：探索摘要 vs 交接信息
2. **修复提示词判断**：根据 `sessionType` 选择正确的提示词
3. **修复 Agent 模式**：根据被压缩会话的类型设置正确的环境变量
4. **统一调用路径**：所有调用路径都正确传递 `sessionType`

### 8.5 修复难度

- **技术难度**：中（需要修改多个文件，理解调用链）
- **测试难度**：高（需要验证多种场景）
- **风险评估**：中（涉及核心功能，需要仔细测试）

---

**文档状态**：待修复

**下一步**：按照修复方案逐一实施，并验证各种场景
