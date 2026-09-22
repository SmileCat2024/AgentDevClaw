# 上下文压缩结构化输出方案

> 本文档定义上下文压缩（Context Compaction）的下一阶段设计：将压缩输出从纯文本摘要升级为结构化工具调用产物，使新 session 能在启动时动态恢复关键文件和技能上下文。

---

## 一、背景

### 1.1 已完成的基础

当前项目已实现两条压缩路径：

- **Trimmed Resume**（`server/context-continuity/handoff-package.js`）：保留对话骨架，折叠工具活动。以 seed messages（`system`/`user`/`assistant` 角色的消息数组）形式注入新 session。
- **Summarized Resume**（`server/context-continuity/summarized-handoff.js` + `scripts/run-compact-mirror.js`）：通过镜像子进程调用 LLM 生成九段式摘要，以 `system` 角色的 seed message 注入新 session。

两条路径共享的注入机制是 `local-features/context-handoff-seed/src/index.ts`（Feature），在 `@CallStart` + `ctx.isFirstCall` 时将 handoff 内容写入新 session 的 Context。

### 1.2 已验证的架构决策

在前期开发中（见 `docs/plans/context-compaction-successor-session-notes.md`），我们形成了以下核心判断：

1. 压缩的本质是 **交接**，不是模拟长期记忆。每个 session 是一个完整的历史记录，交接是让新 agent 带着 briefing 继续工作。
2. 不污染 live agent 循环。压缩在独立的镜像子进程中完成，结果写入 handoff 文件，新 session 消费 handoff。
3. Flow 节点是业务级恢复的自然锚点，但本轮先不实现 Flow 恢复——先解决通用的文件和技能恢复。

### 1.3 当前的问题

Summarized Resume 生成的纯文本摘要有一个实际缺陷：新 session 启动后，agent 知道"之前在做什么"，但不具备恢复工作能力所需的**操作上下文**。

具体来说：

- **文件上下文丢失**：agent 知道曾经读过 `src/auth.ts`，但新 session 的上下文中没有文件内容。agent 不会主动重新阅读——尤其是历史中存在旧的 `read` 调用记录时，模型倾向于照猫画虎地使用过时信息，而非重新读取。
- **技能上下文丢失**：技能（Skills）在系统提示词中以摘要形式列出，agent 可以通过 `invoke_skill` 激活。但如果 agent 不知道之前激活过哪些技能，它不会主动重新激活。

核心矛盾是：摘要告诉 agent "你做了什么"，但没有重建"你当前需要的操作环境"。

---

## 二、设计目标

让压缩产物携带结构化的恢复指令，使新 session 在首次 `CallStart` 时能：

1. 拿到摘要文本（延续已有的九段式摘要）
2. 拿到 LLM 判定的重要文件名列表，并在注入时动态读取最新内容
3. 拿到 LLM 判定的重要技能名列表，并在注入时动态查找技能内容
4. 保留机械化强制注入最近 N 个文件/技能的能力（控制变量暂不暴露，数据结构预留）

关键原则：**文件和技能只记录名称，内容在新 session 启动时动态获取**。这保证了注入的内容始终是最新版本，避免过时信息。

---

## 三、核心设计思路

### 3.1 结构化压缩工具

在 `ContextCompactionControlFeature`（`local-features/context-compaction-control/src/index.ts`）中新增一个 tool：

- **始终注册到主 agent 的 ToolRegistry 中**
- **默认处于 disabled 状态**——主 agent 的 LLM 能看到 tool schema，但 ToolExecutor 会拦截实际调用
- **仅在镜像压缩子进程中被 enable**——mirror 脚本在禁用所有工具后，单独 enable 此工具

工具参数：

```
summary:          string   (九段式摘要全文，与现有输出一致)
important_files:  string[] (LLM 判定的重要文件路径)
important_skills: string[] (LLM 判定的重要技能名称)
```

工具的命名和 description 需要中性、无强引导性——它不应诱导主 agent 去使用它。

### 3.2 Mirror 子进程的改动

当前 mirror 流程：

```
加载 agent + session → 禁用所有工具 → 裸调 llm.chat(messages, toolSchemas)
→ 检测 response.toolCalls → 有 toolCall 则抛错重试 → 无则提取 summaryText
```

改动后：

```
加载 agent + session → 禁用所有工具 → enable 'record_compaction_context'
→ 修改 prompt（引导调用该工具而非输出自由文本）
→ 裸调 llm.chat(messages, toolSchemas)
→ 检测 response.toolCalls：
   - 有 'record_compaction_context' 调用 → 从 arguments 提取结构化输出
   - 有其他工具调用 → 抛错重试（与现有逻辑一致）
   - 无工具调用 → 走原有 stripCompactAnalysis() fallback
```

### 3.3 为什么这不会大改现有逻辑

核心改动集中在三个点：

1. **新增一个 tool 定义**（在已有的 Feature 中加一个 `createTool`）
2. **Mirror 脚本中加一行 `toolRegistry.enable('record_compaction_context')`** 和一段结果提取逻辑
3. **Prompt 改为引导调用工具**（替代现有的 `NO_TOOLS_PREAMBLE`）

其余所有链路（handoff 采集、写入文件、新 session 创建、runtime 拉起、handoff 解析、seed 注入）都是在现有数据结构上扩展新字段，不改变原有字段语义。

### 3.4 关键边界：为什么可行

**ToolRegistry 的 `getAll()` 返回 enabled + disabled 的工具 schema。**

验证位置：`D:\code\AgentDev\src\core\tool.ts:193`

```ts
getAll(): Tool[] {
  return Array.from(new Set([...this.enabled, ...this.disabled]))
    .map(name => this.tools.get(name))
    .filter((t): t is Tool => t !== undefined);
}
```

这意味着：
- 主 agent 中，`record_compaction_context` 被 disabled，但 LLM 能看到 schema。ToolExecutor 会拦截实际调用。
- Mirror 子进程中，该工具被 enable 后，`llm.chat()` 的 tools 参数包含它的 schema。LLM 可以调用它。

**Mirror 的 LLM 调用是裸 `llm.chat()`，不走 ReAct 循环。**

验证位置：`scripts/run-compact-mirror.js:189`

```js
const response = await agent.llm.chat(compactMessages, compiledTools);
```

这意味着：
- LLM 返回的 `response.toolCalls` 不经过 ToolExecutor
- Mirror 脚本直接从 `response.toolCalls` 中提取结构化参数
- `toolCalls` 的结构是 `{ id, name, arguments }`，其中 `arguments` 已被 JSON.parse 为对象

验证位置：`D:\code\AgentDev\src\llm\openai.ts:172`

```ts
toolCalls = Array.from(accumulatedToolCalls.values()).map(tc => ({
  id: tc.id,
  name: tc.name,
  arguments: JSON.parse(tc.arguments),
}));
```

---

## 四、涉及的文件与改动说明

### 4.1 `local-features/context-compaction-control/src/index.ts`

**改动：** 新增 `record_compaction_context` tool

在 `getTools()` 返回数组中追加一个 `createTool`，参数包含 `summary`、`important_files`、`important_skills`。

命名和 description 设计原则：
- 名称不包含 "compact" / "compress" / "summarize" 等可能诱导主 agent 使用的词汇
- description 中性描述其功能，不主动引导

`execute` 函数返回 `{ ok: true }`——因为主 agent 中该工具 disabled 永远不会执行，mirror 中是裸 `llm.chat()` 也不走 execute。

### 4.2 `scripts/run-compact-mirror.js`

**改动：** 四处

1. **挂载 `ContextCompactionControlFeature`**（在 `agent.loadSession()` 之前）：
   当前 mirror 脚本只创建原始 agent，不挂载 `ContextCompactionControlFeature`。因此 `record_compaction_context` 工具从不在 mirror 的 ToolRegistry 中注册，enable 调用会返回 false，LLM 看不到它。
   修正方法：在 `prepareRuntime()` 之后、`loadSession()` 之前，显式挂载 Feature：
   ```js
   if (typeof localFeatures.ContextCompactionControlFeature === 'function') {
     agent.use(new localFeatures.ContextCompactionControlFeature({
       serverOrigin: 'http://127.0.0.1:1420',
       agentId,
       sessionId,
     }));
   }
   ```

2. **禁用工具后 enable 目标工具**（在 line ~161 之后）：
   ```js
   toolRegistry.enable('record_compaction_context');
   ```

3. **修改 `shouldPreserveToolSchema` 逻辑**，确保 `record_compaction_context` 的 schema 始终传给 LLM：
   当前 `shouldPreserveToolSchema` 只对 Claude 模型返回 true，非 Claude 模型（如当前项目使用的 GLM）`compiledTools` 为空数组。即使工具被注册并 enable，LLM 也看不到 schema。
   修正方法：将 `compiledTools` 的构建逻辑从"全有或全无"改为"始终包含 `record_compaction_context`"：
   ```js
   const allTools = toolRegistry?.getAll?.() || [];
   const compactTool = allTools.find(t => t.name === 'record_compaction_context');
   let compiledTools = shouldPreserveToolSchema(agent) ? allTools : [];
   if (compactTool && !compiledTools.includes(compactTool)) {
     compiledTools = [compactTool];
   }
   ```

4. **从消息历史中扫描文件和技能名列表 + 修改结果提取逻辑**：
   扫描逻辑（新函数）：
   - 遍历 `rawMessages`，找出 `role === 'assistant'` 且有 `toolCalls` 的消息
   - 对 `toolCalls` 中 `name === 'read'` 的调用，提取 `arguments.filePath`
   - 对 `toolCalls` 中 `name === 'invoke_skill'` 的调用，提取 `arguments.skill`（注意：参数名是 `skill`，不是 `skill_name`，见 `D:\code\AgentDev\src\features\skill\tools.ts:24`）
   - 对 `name === 'write'`、`name === 'edit'` 的调用，同样提取 `arguments.filePath`
   - 去重后作为参考列表附加到 prompt 中

   结果提取逻辑（line ~195）：
   - 检查 `response.toolCalls` 中是否有 `name === 'record_compaction_context'` 的调用
   - 如果有，从 `arguments` 中提取 `summary`、`important_files`、`important_skills`
   - 如果没有，走原有 `stripCompactAnalysis(response.content)` 的 fallback 路径
   - 写入 result.json 的 payload 新增 `importantFiles` 和 `importantSkills` 字段

### 4.3 `server/context-continuity/claude-compact-prompts.js`

**改动：** 修改 prompt 构建逻辑

当前 prompt 以 `NO_TOOLS_PREAMBLE`（"不要调任何工具"）开头。需要改为：
- 移除 `NO_TOOLS_PREAMBLE`
- 引导 LLM 调用 `record_compaction_context` 工具
- 在 prompt 中附加从消息历史扫描得到的文件和技能参考列表
- 保留九段式摘要的输出格式要求（放在 `summary` 参数中）

### 4.4 `server/context-continuity/summarized-handoff.js`

**改动：** 扩展 handoff 结构

`writeSummarizedHandoffPackage()` 产出的 handoff JSON 在 `summaryArtifact` 旁新增 `compactOutput` 字段：

```json
{
  "seedMessages": [...],
  "sourceSummary": "...",
  "summaryArtifact": { "shape": "...", "summaryText": "..." },
  "compactOutput": {
    "importantFiles": ["src/auth.ts", "src/middleware.ts"],
    "importantSkills": ["weather", "code"]
  }
}
```

`importantFiles` 和 `importantSkills` 放在 `compactOutput` 对象内，与现有 `summaryArtifact` 并列，避免顶层字段膨胀。

`exportSummarizedHandoffPackage()` 中从 mirror result 提取新字段并传入 `writeSummarizedHandoffPackage()`。

### 4.5 `scripts/run-prebuilt-agent.js`

**改动：** `parseHandoffContent()` 扩展

当前 `parseHandoffContent`（line ~39）从 handoff JSON 提取 `seedMessages`、`sourceSummary`、`mode` 等。需要新增提取：

- `compactOutput.importantFiles`（`string[]`）
- `compactOutput.importantSkills`（`string[]`）

这些字段最终传入 `ContextHandoffSeedFeature` 的构造函数 config。

### 4.6 `local-features/context-handoff-seed/src/index.ts`

**改动：** 扩展注入逻辑

当前 `injectHandoffSummary()` 在 `@CallStart` + `ctx.isFirstCall` 时注入 seed messages。需要扩展为：

1. 从 config 中读取 `importantFiles` 和 `importantSkills`
2. 对每个文件路径：
   - `existsSync(filePath)` 检查是否存在
   - 存在：`readFileSync(filePath, 'utf8')` 读取内容（截断到单文件上限）
   - 不存在：记录为"曾阅读过 {filePath}"
3. 对每个技能名：
   - 在 `{projectRoot}/.agentdev/skills/{name}/SKILL.md` 查找
   - 存在：读取内容（截断到单技能上限）
   - 不存在：记录为"曾使用过技能 {name}"
4. 将所有内容合并为一条或多条 `system` 角色的 `<system-reminder>` 块注入
5. 超出总量上限的文件/技能只保留名称列表

**注入的 `<system-reminder>` 格式：**

```
<system-reminder>
以下文件在此会话的前一轮中被标记为重要，内容已重新加载：

### {fileName}
{文件内容，截断到上限}

--- 以下文件因超出显示上限仅保留路径 ---
- {filePath1}
- {filePath2}
</system-reminder>
```

```
<system-reminder>
以下技能在此会话的前一轮中被标记为重要：

### 技能: {skillName}
{技能内容，截断到上限}

--- 以下技能因超出显示上限仅保留名称 ---
- {skillName1}
- {skillName2}
</system-reminder>
```

**需要新增 `import`：** `fs` 模块的 `existsSync`、`readFileSync`，`path` 模块的 `join`。

**`ContextHandoffSeedPayload` 接口扩展：** 新增 `importantFiles?: string[]` 和 `importantSkills?: string[]`。

### 4.7 `local-features/context-compaction-mirror/src/index.ts`

**不需要改动。**

注意：当前 `run-compact-mirror.js`（line 132-134）只检查 `ContextCompactionMirrorFeature` 是否构建成功，但从未调用 `agent.use()` 挂载它。Mirror 中的工具禁用完全由脚本自身完成（line 157-161 的循环），不依赖此 Feature。因此 `ContextCompactionMirrorFeature` 的 `@CallStart` 在 mirror 子进程中从未被触发。

这不影响本方案。工具禁用和 enable 都在脚本中显式控制。

### 4.8 不需要改动的文件

- **AgentDev 框架**：零改动。ToolRegistry 的 `enable()`/`disable()`/`register()`/`getAll()` 已完全支持所需操作。
- **`server.js` 的 API 路由**：不需要改。`compact_and_resume` 路由只做 handoff 导出 + 新 session 创建，handoff JSON 扩展字段向后兼容。
- **`server/context-continuity/handoff-package.js`**：不需要改。Trimmed Resume 路径不受影响，它不涉及结构化工具输出。
- **FlowFeature**：不碰。Flow 恢复是独立话题，本轮不涉及。

---

## 五、Fallback 策略

当 LLM 没有调用 `record_compaction_context` 而是输出自由文本时：

1. Mirror 脚本检测到 `response.toolCalls` 中没有 `record_compaction_context` 调用
2. 走原有 `stripCompactAnalysis(response.content)` 路径提取摘要
3. `importantFiles` 和 `importantSkills` 为空数组
4. Handoff 正常生成，只是缺少文件和技能信息
5. 新 session 的 `context-handoff-seed` 只注入摘要 seed message，不注入文件/技能

这条 fallback 路径就是当前的现有行为，完全向后兼容。

当 LLM 调用了非 `record_compaction_context` 的工具时：与当前行为一致，抛错重试。

---

## 六、数据流全链路

```
1. 触发压缩
   ↓
2. Mirror 子进程启动
   - 加载 agent + prepareRuntime
   - 挂载 ContextCompactionControlFeature（注册 record_compaction_context tool）
   - loadSession（含完整消息历史）
   - 禁用所有工具
   - enable 'record_compaction_context'
   - 扫描消息历史，提取文件路径和技能名列表
   - 构建压缩 prompt（含文件/技能参考列表 + 引导调用工具）
   - llm.chat(messages, toolSchemas)
   ↓
3. LLM 返回
   - 情况 A：调用了 'record_compaction_context' → 提取 { summary, important_files, important_skills }
   - 情况 B：输出自由文本 → stripCompactAnalysis() 提取摘要，files/skills 为空
   ↓
4. 写入 result.json
   { summaryText, importantFiles, importantSkills, rawResponse }
   ↓
5. 主进程读取 result.json
   ↓
6. 写入 handoff package JSON 文件
   { seedMessages, compactOutput: { importantFiles, importantSkills }, summaryArtifact, ... }
   ↓
7. 创建新 session + 启动新 runtime
   - PROTOCLAW_HANDOFF_PATH 环境变量指向 handoff 文件
   ↓
8. 新 runtime 中 parseHandoffContent() 解析 handoff
   - 提取 seedMessages、sourceSummary、compactOutput.importantFiles、compactOutput.importantSkills
   ↓
9. ContextHandoffSeedFeature 构造函数接收 handoff payload
   ↓
10. @CallStart + isFirstCall 时注入
    - 注入 seed messages（摘要或裁剪对话）
    - 按 importantFiles 列表动态读取文件内容，注入 <system-reminder> 块
    - 按 importantSkills 列表查找 SKILL.md，注入 <system-reminder> 块
```

---

## 七、待定参数

以下参数需要在实现时确定具体值，但不应阻塞设计：

| 参数 | 含义 | 建议值 | 说明 |
|------|------|--------|------|
| `MAX_FILE_CHARS` | 单文件注入内容上限 | 8000 | 超出截断，提示"已截断" |
| `MAX_TOTAL_FILE_CHARS` | 文件内容总量上限 | 30000 | 超出的文件只保留名称 |
| `MAX_SKILL_CHARS` | 单技能注入内容上限 | 5000 | 超出截断 |
| `MAX_TOTAL_SKILL_CHARS` | 技能内容总量上限 | 15000 | 超出的技能只保留名称 |
| `forcedRecentFiles` | 强制注入的最近文件数 | 暂不实现 | 数据结构预留，控制变量不暴露 |
| `forcedRecentSkills` | 强制注入的最近技能数 | 暂不实现 | 同上 |

这些参数可以先硬编码在 `context-handoff-seed` 中，未来需要可配置时再暴露。

---

## 八、实施顺序建议

1. **`context-compaction-control`**：新增 tool 定义，确认构建通过
2. **`run-compact-mirror.js`**：enable 工具 + 扫描文件/技能 + 修改结果提取逻辑
3. **`claude-compact-prompts.js`**：修改 prompt 引导调用工具
4. **`summarized-handoff.js`**：扩展 handoff 结构
5. **`run-prebuilt-agent.js`**：`parseHandoffContent` 扩展
6. **`context-handoff-seed`**：动态注入文件和技能内容
7. 构建 `npm run build:local-features`，端到端烟测

每一步都可以独立验证，不依赖后续步骤。

---

## 九、参考文件索引

| 文件 | 用途 |
|------|------|
| `local-features/context-compaction-control/src/index.ts` | 压缩控制 Feature，新增结构化输出 tool |
| `local-features/context-compaction-mirror/src/index.ts` | 镜像 Feature，禁用所有工具 |
| `local-features/context-handoff-seed/src/index.ts` | Handoff 注入 Feature，扩展动态文件/技能注入 |
| `scripts/run-compact-mirror.js` | 镜像子进程脚本，enable 工具 + 提取结果 |
| `server/context-continuity/claude-compact-prompts.js` | 压缩提示词，引导调用工具 |
| `server/context-continuity/summarized-handoff.js` | Summarized handoff 生成，扩展结构 |
| `server/context-continuity/handoff-package.js` | Trimmed handoff 生成（本轮不改动） |
| `scripts/run-prebuilt-agent.js` | Runtime 启动，handoff 解析扩展 |
| `D:\code\AgentDev\src\core\tool.ts` | ToolRegistry，enable/disable/getAll 行为确认 |
| `D:\code\AgentDev\src\llm\openai.ts` | LLM 响应结构，toolCalls 解析确认 |
| `D:\code\AgentDev\src\skills\loader.ts` | Skill 发现机制 |
| `D:\code\AgentDevClaw\.agentdev\skills\weather\SKILL.md` | 技能文件格式参考 |
| `docs/plans/context-compaction-successor-session-notes.md` | 前期讨论备忘录 |
