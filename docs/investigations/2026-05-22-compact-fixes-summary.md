# 压缩产品语义混淆问题修复总结

> **修复时间**：2026-05-22
>
> **修复范围**：压缩 Agent 模式匹配、压缩提示词类型判断、产品语义文档更新

---

## 修复内容

### 1. 压缩 Agent 模式匹配问题

**文件**：`scripts/run-compact-mirror.js`

**问题**：压缩 Agent 使用固定配置（主对话模式），无论压缩什么类型的会话

**修复**：
```javascript
// 在创建 Agent 之前设置环境变量
if (sessionType === 'exploration' || sessionType === 'sub') {
  process.env.PROTOCLAW_SESSION_TYPE = 'exploration';
  logPhase(`set exploration mode for sessionType=${sessionType}`);
} else {
  delete process.env.PROTOCLAW_SESSION_TYPE;
  logPhase(`set normal mode for sessionType=${sessionType || 'main'}`);
}
```

**效果**：
- 压缩探索会话时使用探索模式（explore.md + 轻量级功能）
- 压缩主对话会话时使用主对话模式（system.md + 完整功能）
- 生成的摘要准确反映原始会话的上下文和意图

---

### 2. 压缩提示词类型判断问题

**文件**：`server/context-continuity/summarized-handoff.js`

**问题**：`exportSummarizedHandoffPackage` 没有传递 `sessionType` 给 mirror 脚本

**修复**：
```javascript
// 从 sourceRecord 读取 sessionType 并传递给 mirror 脚本
const sessionType = typeof sourceRecord.sessionType === 'string' ? sourceRecord.sessionType : '';

const mirrorResult = await runMirrorCompaction(
  mirrorScriptPath,
  [
    agentRelativeDir,
    agentId,
    sessionId,
    JSON.stringify({
      maxAttempts: policy.maxAttempts,
      additionalInstructions: policy.additionalInstructions,
      sessionType,  // ← 新增
    }),
  ],
  path.resolve(String(projectRoot || '').trim()),
);
```

**效果**：
- 探索会话使用三段式提示词（目标、发现、重要文件）
- 其他会话使用九段式提示词（请求、概念、文件、错误、解决、调整、待办、当前、下一步）
- 提示词格式与会话类型匹配

---

### 3. CLI 命令硬编码问题

**文件**：`bin/claw.mjs`

**问题**：硬编码 `sessionType: 'exploration'`，无法处理其他类型的会话

**修复**：
```javascript
// 使用从会话索引读取的 sessionType
const sessionType = cleanText(record.sessionType);

// ...
const args = [
  join(projectRoot, 'scripts', 'run-compact-mirror.js'),
  agentDir,
  'programming-helper',
  sessionId,
  JSON.stringify({ sessionType }),  // ← 使用实际的 sessionType
  resultPath,
];
```

**效果**：
- CLI 命令可以根据会话类型使用正确的提示词格式
- 不再硬编码为 `'exploration'`

---

## 产品语义澄清

### 探索摘要 vs 交接信息

#### 探索摘要（Exploration Summary）
- **用途**：给主代理看，用于快速判断相关度
- **格式**：三段式（目标、发现、重要文件）
- **场景**：`claw explorations` 列表扫描
- **产物**：独立存储在探索记录目录下

#### 交接信息（Handoff Context）
- **用途**：给子代理注入上下文
- **格式**：九段式 + 文件列表 + 技能列表
- **场景**：`claw spawn <exploration-id>` 派生子代理
- **产物**：handoff package 的一部分

### 两者的关系

```
探索记录（Exploration Record）
  ├─ 探索摘要（三段式）← 给主代理看
  └─ 交接信息（九段式）← 给子代理用
```

---

## 验证点

### 1. 探索摘要生成

```bash
# 生成探索摘要
claw compact <exploration-id>

# 验证点：
# 1. 摘要是三段式格式（目标、发现、重要文件）
# 2. Agent 使用探索模式（explore.md + 轻量级功能）
# 3. 摘要存储在探索记录目录下
```

### 2. 交接信息生成

```bash
# 从探索记录派生子代理
claw spawn <exploration-id> --goal "..."

# 验证点：
# 1. handoff package 包含九段式 sourceSummary
# 2. 包含 importantFiles 和 importantSkills
# 3. 子代理正确注入摘要 + 文件内容 + 技能内容
```

### 3. 主对话会话压缩

```bash
# 通过 API 压缩主对话会话
# 验证点：
# 1. 使用九段式提示词
# 2. Agent 使用主对话模式（system.md + 完整功能）
```

---

## 影响范围

### 正面影响
1. **摘要质量提升**：提示词格式与会话类型匹配
2. **上下文准确性**：压缩 Agent 使用正确的模式理解会话
3. **产品语义清晰**：探索摘要和交接信息不再混淆

### 风险评估
1. **低风险**：只修改了压缩逻辑，不影响主对话运行时
2. **向后兼容**：现有 handoff package 结构不变，只是新增字段
3. **可回滚**：如果出现问题，可以快速回滚修改

---

## 待办事项

1. **测试各种场景**：
   - 探索记录的摘要生成
   - 子代理的上下文注入
   - 主对话会话的压缩

2. **监控报错问题**：
   - 收集完整的错误日志
   - 分析 JSON 解析失败的具体原因
   - 可能需要调整提示词或添加 fallback 逻辑

3. **更新用户文档**：
   - 更新 `C:\Users\zty20\.claude\skills\claw-cli\SKILL.md`
   - 说明探索摘要和交接信息的区别

---

## 总结

本次修复解决了压缩产品语义混淆的问题：

1. **明确了两种产物的区别**：探索摘要 vs 交接信息
2. **修复了 Agent 模式匹配**：根据会话类型使用正确的模式
3. **修复了提示词类型判断**：根据会话类型使用正确的提示词格式
4. **统一了调用路径**：所有调用路径都正确传递 `sessionType`

这些修复确保了：
- 探索摘要是三段式格式，给主代理看
- 交接信息是九段式格式，给子代理用
- 压缩 Agent 使用正确的模式理解会话
- 生成的摘要准确反映原始会话的上下文和意图
