# 编程小助手 Compact 系统设计参考

> 本文档面向后续接手的 agent，目标是避免重复出现概念混淆。
>
> 模型配置路径现以 Claw 用户数据目录中的 `presets.json` 和 `agent-configs/<agentId>.json` 为准；本文中的 `config/presets.json` 路径均指配置角色，不代表当前文件位置。
>
> 读完本文后，应能回答：compact 有几种模式、走哪些路径、每条路径的完整数据流是什么、哪些概念容易搞混以及为什么。

---

## 一、核心概念词典

本文档出现的产品术语有严格定义，不可随意替换或合并。

### 1.1 四种会话续接动作

| 动作 | 含义 | 产物 | LLM 参与 |
|---|---|---|---|
| **Exact Restore** | 精确恢复旧 session 快照，沿用旧上下文 | 无新产物 | 否 |
| **Trimmed Resume** | 保留对话骨架，折叠工具活动，创建新 session | Trim Handoff Package | 否 |
| **Summarized Resume** | LLM 生成摘要，以 system 消息注入新 session | Summary Handoff Package | 是 |
| **Fork Branch** | 从当前任务分出新支线（未实现） | — | — |

**最常见的混淆来源**：Trimmed Resume 和 Summarized Resume 是两种完全不同的动作，共享同一套 handoff 消费链路，但编译链路完全不同。

### 1.2 Handoff Package

Handoff Package 是 compact 的核心中间产物——一个 JSON 文件，描述"旧会话要把什么材料交给新会话"。

存储位置：`~/.agentdev/AgentDevClaw/handoffs/<agentId>/handoff-<timestamp>-<uuid>.json`

两种 Handoff Package 的结构差异：

#### Trim Handoff Package（`mode: 'trim-transcript'`）

```json
{
  "schemaVersion": 1,
  "handoffId": "handoff-...",
  "compilerVersion": "trim-transcript-v1",
  "seedKind": "message-replay",
  "mode": "trim-transcript",
  "sourceAgentId": "programming-helper",
  "sourceSessionId": "session-xxx",
  "sourceRecord": { "title": "...", "goal": "...", ... },
  "policy": { "strategy": "trim-transcript", "includeUserMessages": true, ... },
  "stats": { "totalMessages": 120, "keptMessages": 45, ... },
  "sourceSummary": "Task: ...\nGoal: ...\nWorking directory: ...",
  "seedMessages": [
    { "role": "user", "content": "帮我分析一下...", "turn": 0 },
    { "role": "assistant", "content": "好的，我来...", "turn": 1 },
    { "role": "system", "content": "[已折叠 3 次工具调用：read, grep, read]", "turn": 2 }
  ]
}
```

**关键特征**：
- `seedKind: 'message-replay'` — 种子是裁剪后的对话消息数组
- `sourceSummary` 仅是 Task/Goal/Working directory 元数据（`buildCompactOverview` 产物），不是 LLM 摘要
- 不走 LLM，纯规则裁剪

#### Summary Handoff Package（`mode: 'summarized-nine-section'`）

```json
{
  "schemaVersion": 1,
  "handoffId": "handoff-...",
  "compilerVersion": "summarized-nine-section-v1",
  "seedKind": "summary-message",
  "mode": "summarized-nine-section",
  "sourceAgentId": "programming-helper",
  "sourceSessionId": "session-xxx",
  "sourceRecord": { "title": "...", "goal": "...", ... },
  "policy": { "strategy": "summarized-nine-section", ... },
  "stats": { "attemptCount": 1, "summaryChars": 1200 },
  "sourceSummary": "1. 主要请求与意图\n2. 关键技术概念\n...",
  "summaryArtifact": { "shape": "claude-nine-section-v1", "rawResponse": "...", "summaryText": "..." },
  "compactOutput": {
    "sessionTitle": "调试 Flow 节点工具权限逻辑",
    "importantFiles": ["src/auth.ts", "src/middleware.ts"],
    "importantSkills": ["code"],
    "fileRanges": { "src/auth.ts": "1-50" }
  },
  "seedMessages": [
    { "role": "system", "content": "本次会话由之前因上下文耗尽而中断的对话继续而来。\n\n摘要：\n...", "turn": 0 }
  ]
}
```

**关键特征**：
- `seedKind: 'summary-message'` — 种子是一条 system 角色的摘要消息
- `sourceSummary` 是 LLM 生成的九段式摘要（或三段式探索摘要）
- `compactOutput` 包含 `sessionTitle`、`importantFiles`、`importantSkills`
- 必须经 LLM

### 1.3 三种 compact 提示词格式

| 格式 | 适用场景 | 段落结构 |
|---|---|---|
| **九段式**（`BASE_SUMMARY_PROMPT`） | 主对话会话压缩 | 请求→概念→文件→错误→解决→调整→待办→当前→下一步 |
| **三段式**（`EXPLORATION_SUMMARY_PROMPT`） | 探索会话压缩 | 目标与范围→关键发现→重要文件 |
| **交接信息**（Handoff Context） | 子代理上下文注入 | 九段式 + importantFiles + importantSkills |

**最容易搞混**：三段式探索摘要和九段式交接信息。它们是不同产物，服务不同消费者：

```
探索记录
  ├─ 探索摘要（三段式）← 给主代理看，用于相关度判断
  └─ 交接信息（九段式 + 文件 + 技能）← 给子代理注入上下文
```

### 1.4 `record_compaction_context` 工具

这是 compact 系统的结构化输出工具，定义在 `ContextCompactionControlFeature` 中。

**设计意图**：让 LLM 把压缩结果以结构化参数（而非自由文本）输出，便于提取 `session_title`、`important_files`、`important_skills` 等字段。

**参数**：
- `session_title`（必填）：对话的一句话概括
- `summary`：完整摘要文本（九段或三段）
- `important_files`：重要文件路径列表
- `important_skills`：重要技能名称列表

**生命周期**：
1. 在主 agent 的 ToolRegistry 中注册，默认 disabled
2. Mirror 子进程 / In-process 路径中 enable 它
3. LLM 调用它，结果从 `response.toolCalls[0].arguments` 提取
4. `execute()` 函数本身不做任何事（返回 `{ ok: true }`），因为 mirror 是裸 `llm.chat()` 不走 execute

---

## 二、执行路径全景图

compact 有三条触发路径，两条执行引擎，两种 handoff 编译策略。以下从触发到消费画全链路。

### 2.1 触发入口

```
┌──────────────────────────────────────────────────────────────────┐
│                         触发入口                                   │
├──────────────┬───────────────────┬────────────────────────────────┤
│  前端 UI      │  Agent 内部命令    │  CLI                           │
│              │                   │                                │
│ session 右键  │ /compact-summary  │ claw compact <exploration-id> │
│ → trim       │ /compact-summary  │                                │
│   -resume    │   -resume         │                                │
└──────┬───────┴────────┬──────────┴──────────────┬─────────────────┘
       │                │                         │
       ▼                ▼                         ▼
```

### 2.2 前端 UI 触发的两条路径

前端 `createCompactedResumeSession()` 会判断目标 session 是否为当前 live runtime：

```
createCompactedResumeSession(agentId, sessionId, strategy)
  │
  ├─ 是 live runtime？
  │   │
  │   ▼ 路径 A：In-process（无论 trim 还是 summary 都走这条路）
  │   POST /api/agents/{id}/input { input: '/compact-summary-resume' }
  │   → run-prebuilt-agent.js handleInputResponse()
  │   → triggerSummaryCompactionResume()
  │   → generateInProcessSummary()           ← 进程内调 LLM
  │   → POST /protoclaw/context_handoffs/summary_resume
  │   → server: compactAndResumeFromProvidedSummary()
  │   → writeSummarizedHandoffPackage()
  │   → createCompactedResumeFromHandoff()
  │
  └─ 非 live session
      │
      ▼ 路径 B：Server → Mirror 或 Trim
      POST /protoclaw/context_handoffs/compact_and_resume
        { policy: { strategy } }
      → server: compactAndResumeCurrentSession()
      → exportContextHandoffForSession()
        │
        ├─ strategy === 'summarized-nine-section'
        │   → exportSummarizedHandoffPackage()
        │   → spawn run-compact-mirror.js            ← 子进程调 LLM
        │   → writeSummarizedHandoffPackage()
        │
        └─ 其他（含空字符串）
            → exportHistoryOnlyHandoffPackage()       ← 纯规则裁剪
      → createCompactedResumeFromHandoff()
```

**关键事实：对 live session，前端没有 trim 分支。** 无论用户在 UI 上选 trim 还是 summary，live session 只走路径 A（in-process summary）。这是因为 trim 需要读取 session 文件快照，而 live session 的最新内容只在内存中，必须先 saveSession 再做摘要。

### 2.3 CLI 触发路径

```
claw compact <exploration-id>
  → bin/claw.mjs cmdCompact()
  → spawn run-compact-mirror.js
  → runSingleAttempt()                        ← 子进程调 LLM
  → 结果写入 result.json
  → 产出探索摘要（三段式），存储在探索记录目录下
```

### 2.4 Agent 内部命令触发

编程小助手的主循环 `handleInputResponse()` 匹配两种命令：

| 命令 | 处理函数 | 效果 |
|---|---|---|
| `/compact-summary` | `triggerSummaryCompaction()` | 生成 summary handoff 并导出（不创建新 session） |
| `/compact-summary-resume` | `triggerSummaryCompactionResume()` | 生成 summary handoff 并创建新 resume session |

两者都调用同一个 `generateInProcessSummary()` 做 LLM 摘要。

### 2.5 两种执行引擎对比

| 维度 | In-process（`run-prebuilt-agent.js`） | Mirror 子进程（`run-compact-mirror.js`） |
|---|---|---|
| 进程 | 在当前 runtime 进程内 | 独立子进程 |
| Agent 实例 | 复用当前 agent | 新建 Agent 实例 |
| 会话加载 | 已在内存中 | `loadSession()` 从文件加载 |
| 工具处理 | 从当前 ToolRegistry 取工具 | 新建 ToolRegistry，禁用全部，enable `record_compaction_context` |
| LLM 调用 | `agent.llm.chat(messages, tools)` | `agent.llm.chat(compactMessages, compiledTools)` |
| 结果提取 | 从 `toolCalls.arguments.summary` 取，fallback `stripCompactAnalysis` | 同左 |
| 生命周期 | 调用完恢复 LLM 参数 | 子进程退出，写 result.json |

### 2.6 各执行路径的模型解析机制

编程小助手的所有 runtime 实例都通过同一套模型预设系统解析 LLM。核心解析链路：

```
resolveAgentModelLLM(agentDir, role)
  → 读 metadata.json 的 modelPresets[role]（fallback 到 modelPresets.default）
  → 拿 preset name 去 config/presets.json 查 provider + model + apiKey
  → 返回 { llm, modelName } 或 null
```

`modelPresets` 支持三个角色：

| 角色 | 语义 | 典型消费者 |
|---|---|---|
| `default` | 主对话模型 | 前台对话、主对话压缩 |
| `exploration` | 探索会话模型 | 探索子代理 |
| `sub` | 子代理模型 | one-shot 子代理 |

所有角色均可通过前端 UI 的模型预设面板修改（`PUT /protoclaw/agent_model_presets`），修改写入 Claw 用户数据目录的 `agent-configs/<agentId>.json`，覆盖 metadata 默认值。因此 `modelPresets` 是**用户配置**而非代码常量。

#### 五条路径的具体解析方式

**路径 A — 前台主对话**

```
server.js: startManagedAgent()
  → spawn run-prebuilt-agent.js
  → run-prebuilt-agent.js:572
    resolveAgentModelLLM(agentPath, 'default')
  → 读 modelPresets.default → config/presets.json → 构建 LLM 实例
  → 注入到 new AgentClass({ llm })
```

模型角色：`default`

**路径 B — In-process 摘要（live session 压缩）**

```
run-prebuilt-agent.js: generateInProcessSummary()
  → 直接使用 agent.llm（主代理已初始化的 LLM 实例）
  → 不走 resolveAgentModelLLM，不复读配置
```

模型：天然与主代理同款，无需独立解析。只通过 `tuneSummaryLLM()` 临时调低 `maxTokens` 和关闭 `thinkingBudgetTokens`，完成后恢复。

**路径 C — Mirror 子进程摘要（非 live session 压缩）**

```
server.js → spawn run-compact-mirror.js
  → run-compact-mirror.js:166-172
    modelPresetRole = sessionType === 'exploration' ? 'exploration'
                     : sessionType === 'sub' ? 'sub'
                     : 'default'
    resolveAgentModelLLM(agentDir, modelPresetRole)
  → 读对应角色的 preset → config/presets.json → 构建 LLM 实例
  → 注入到 new AgentClass({ llm })
```

模型角色：根据被压缩会话的 `sessionType` 选择 `default` / `exploration` / `sub`。

**路径 D — One-shot 子代理（探索/子对话）**

```
server.js: spawn_one_shot / resume_sub
  → 设置环境变量 PROTOCLAW_MODEL_PRESET_ROLE
    （exploration → 'exploration'，其他 → 'sub'）
  → spawn run-one-shot-agent.js
  → run-one-shot-agent.js:225-226
    modelPresetRole = process.env.PROTOCLAW_MODEL_PRESET_ROLE || 'sub'
    resolveAgentModelLLM(agentPath, modelPresetRole)
```

模型角色：由 server.js 根据会话类型决定，通过环境变量传递。

**路径 E — CLI compact（`claw compact <id>`）**

```
bin/claw.mjs: cmdCompact()
  → spawn run-compact-mirror.js（同路径 C）
```

模型角色：同路径 C，由 `run-compact-mirror.js` 内部根据 `sessionType` 决定。

#### 独立性与干扰分析

| 维度 | 结论 |
|---|---|
| 进程隔离 | 路径 A/C/D/E 各自独立子进程，路径 B 在主进程内 |
| 配置来源 | 全部读同一份 `metadata.json → config/presets.json` |
| 配置可变性 | `metadata.json` 可被前端 UI 和 API 修改，属于用户配置 |
| 互相干扰 | 无。每个子进程启动时独立解析，运行期间不共享 LLM 实例 |
| 回退风险 | 如果 `resolveAgentModelLLM` 返回 null，Agent 构造函数会使用框架默认 LLM（通常不符合预期） |

#### 设计约束

1. **不得在代码提交中夹带具体的 `modelPresets` 值变更**——它是用户配置，不是程序常量。
2. **新增 runtime 路径必须显式调用 `resolveAgentModelLLM`**——不能依赖环境默认模型。
3. **`modelPresets` 的三个角色应对同一模型族**——`default`/`exploration`/`sub` 不应出现跨模型族的随意混搭。

---

## 三、数据模型与关系

### 3.1 会话类型

编程小助手有三种运行时配置：

| 类型 | 环境变量 | 系统提示词 | 功能挂载 | 会话存储中的字段 |
|---|---|---|---|---|
| 主对话 | （未设置） | `.agentdev/prompts/system.md` | 完整功能 | `sessionType` 未设置或为空 |
| 探索 | `PROTOCLAW_SESSION_TYPE=exploration` | `.agentdev/prompts/explore.md` | 轻量级 | `sessionType: "exploration"` |
| 子代理 | `PROTOCLAW_SESSION_TYPE=exploration` | `.agentdev/prompts/explore.md` | 轻量级 | `sessionType: "sub"` |

会话类型影响 compact 的两个地方：
1. **提示词选择**：`buildClaudeCompactPrompt({ sessionType })` 根据 `sessionType` 决定用三段式还是九段式
2. **Agent 模式**：`run-compact-mirror.js` 根据 `sessionType` 设置 `PROTOCLAW_SESSION_TYPE` 环境变量

### 3.2 Session Record

```json
// ~/.agentdev/AgentDevClaw/workspaces/programming-helper/sessions/<sessionId>.json
{
  "savedAt": 1716451200000,
  "session": {
    "sessionType": "exploration",
    "title": "探索 Flow 运行时 Hook 驱动机制"
  },
  "runtime": {
    "context": {
      "messages": [...]
    },
    "featureStates": {...}
  }
}
```

`sourceRecord` 是 session record 中用户可见元数据的提取，用于 handoff 包和摘要生成：

```
sourceRecord ─── buildCompactOverview() ──→ "Task: ...\nGoal: ...\nWorking directory: ..."
                   │
                   └── buildSourceRecord() ──→ { title, goal, constraints, ... }
```

### 3.3 Handoff 消费链

新 session 创建后，handoff 通过以下路径注入：

```
server: createCompactedResumeFromHandoff()
  → createPrebuiltSession(agentId, { metadata: { handoffPath } })
  → startManagedAgent(agent, session.id, { extraEnv: { PROTOCLAW_HANDOFF_PATH: handoffPath } })
  → 新 runtime 启动，环境变量指向 handoff 文件

run-prebuilt-agent.js main():
  → loadRuntimeHandoff()
    → 读取 PROTOCLAW_HANDOFF_PATH 环境变量
    → parseHandoffContent() 解析 JSON
    → 提取 seedMessages, sourceSummary, mode, importantFiles, importantSkills
  → new ContextHandoffSeedFeature({ handoff: parsedPayload })
  → agent.use(handoffSeedFeature)

context-handoff-seed @CallStart:
  → injectHandoffSummary()
    → 注入 seedMessages（对话消息回放或摘要 system 消息）
    → 注入 sourceSummary system 消息（根据 mode 选择措辞）
    → 注入 importantFiles 文件内容
    → 注入 importantSkills 技能内容
```

### 3.4 消费端的关键区分：Trim vs Summary 的注入差异

`ContextHandoffSeedFeature` 在 `@CallStart` 时根据 `handoff.mode` 选择不同的注入策略：

| | Trim 模式 | Summary 模式 |
|---|---|---|
| seedMessages 内容 | 裁剪后的完整对话（user/assistant/system） | 一条 system 角色的摘要消息 |
| sourceSummary 注入 | 用 `buildTrimContextLabel` 包装（"会话续接元信息 / 上方已注入裁剪后的完整对话历史"） | 用 `buildSummarySeedMessage` 包装（"上下文交接摘要 / 以下压缩上下文来自更早的会话导出"） |
| importantFiles/Skills | 通常为空（trim 不走 LLM） | 有 LLM 判定的重要文件和技能 |
| LLM 感知 | "我在继续一段已有对话" | "我带着一份摘要重新开局" |

**为什么必须区分**：如果 trim 模式用 summary 的措辞（"压缩上下文来自更早的一次会话导出"），LLM 会误以为那条 Task/Goal 元数据就是全部上下文，忽略上方 seedMessages 中的完整对话。

---

## 四、完整文件索引

### 4.1 编译端（生成 handoff）

| 文件 | 职责 | 关键导出/函数 |
|---|---|---|
| `server/context-continuity/handoff-package.js` | Trim handoff 编译 + handoff 读写工具 | `exportHistoryOnlyHandoffPackage()`, `readHandoffPackage()`, `DEFAULT_EXPORT_POLICY` |
| `server/context-continuity/summarized-handoff.js` | Summary handoff 编译 + mirror 调度 | `exportSummarizedHandoffPackage()`, `writeSummarizedHandoffPackage()`, `runMirrorCompaction()` |
| `server/context-continuity/claude-compact-prompts.js` | 压缩提示词模板 + 结果解析 | `buildClaudeCompactPrompt()`, `stripCompactAnalysis()`, `scanFilesAndSkills()` |
| `scripts/run-compact-mirror.js` | Mirror 子进程入口 | `runSingleAttempt()`, `main()` |
| `scripts/run-prebuilt-agent.js` | In-process 摘要 + runtime 主循环 | `generateInProcessSummary()`, `triggerSummaryCompaction()`, `triggerSummaryCompactionResume()` |

### 4.2 服务端路由

| 路由 | 行号 | 用途 |
|---|---|---|
| `POST /protoclaw/context_handoffs/export` | `server.js:4837` | 导出 handoff（不创建新 session） |
| `POST /protoclaw/context_handoffs/compacted_resume` | `server.js:4853` | 从已有 handoff 创建 resume session |
| `POST /protoclaw/context_handoffs/compact_and_resume` | `server.js:5187` | 压缩并 resume（前端主要入口） |
| `POST /protoclaw/context_handoffs/summary_resume` | `server.js:5237` | 从 in-process 提供的摘要创建 resume |
| `POST /protoclaw/context_handoffs/summary_export` | `server.js:5271` | 从 in-process 提供的摘要导出 handoff |

### 4.3 服务端核心函数

| 函数 | 行号 | 用途 |
|---|---|---|
| `exportContextHandoffForSession()` | `server.js:2648` | 根据 policy 分发到 trim 或 summary 编译 |
| `createCompactedResumeFromHandoff()` | `server.js:2687` | 从 handoff 文件创建新 session 并启动 runtime |
| `compactAndResumeCurrentSession()` | `server.js:2760` | compact_and_resume 路由的处理器 |
| `compactAndResumeFromProvidedSummary()` | `server.js:2777` | summary_resume 路由的处理器 |
| `exportProvidedSummaryHandoff()` | `server.js:2819` | summary_export 路由的处理器 |

### 4.4 消费端（注入 handoff）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `local-features/context-handoff-seed/src/index.ts` | 注入 handoff 种子到新 session | `ContextHandoffSeedFeature` |
| `local-features/context-compaction-control/src/index.ts` | 注册 compact 相关工具 | `ContextCompactionControlFeature` |
| `local-features/context-compaction-mirror/src/index.ts` | Mirror 中禁用工具 | `ContextCompactionMirrorFeature` |

### 4.5 前端入口

| 位置 | 行号 | 用途 |
|---|---|---|
| `createCompactedResumeSession()` | `app-main.js:299` | 前端 compact 主函数 |
| `compacted_resume_session` action | `app-main.js:491` | 右键菜单"压缩续接" |
| `compact_session_menu` action | `app-main.js:522` | 右键菜单 trim/summary 选择 |
| compact summary 菜单项 | `app-main.js:2336` | 绑定 compactType: 'summary' |
| compact trim 菜单项 | `app-main.js:2343` | 绑定 compactType: 'trim' |

### 4.6 CLI 入口

| 位置 | 行号 | 用途 |
|---|---|---|
| `cmdCompact()` | `bin/claw.mjs:439` | `claw compact <id>` 命令实现 |

---

## 五、历史踩坑记录

以下是实际发生过的问题和对应的代码设计约束。修改 compact 系统前必须确认不会重犯。

### 5.1 In-process 路径未对齐 mirror 路径的结果提取逻辑

**问题**：提示词从"自由文本输出"改为"调用 `record_compaction_context` 工具输出"后，mirror 路径正确地从 `toolCall.arguments.summary` 提取摘要，但 in-process 路径仍只从 `response.content` 文本提取。LLM 把摘要放在工具参数中，文本内容为空，导致"摘要模型返回了空结果"。

**代码位置**：`run-prebuilt-agent.js:generateInProcessSummary()`

**设计约束**：任何涉及 LLM 输出格式变更的改动，必须同时检查 in-process 路径和 mirror 路径两条代码。

### 5.2 Trim 模式注入了 Summary 风格的措辞

**问题**：`ContextHandoffSeedFeature` 不区分 mode，统一用 `buildFallbackSeedMessage` 包装 sourceSummary。trim 模式下 seedMessages 已包含完整裁剪对话，但 sourceSummary（仅 Task/Goal/Working directory 元数据）被以"上下文交接摘要 / 压缩上下文来自更早的一次会话导出"注入，LLM 误以为这是全部上下文。

**代码位置**：`local-features/context-handoff-seed/src/index.ts:injectHandoffSummary()`

**设计约束**：`ContextHandoffSeedFeature` 必须根据 `handoff.mode` 区分注入策略。trim 用 `buildTrimContextLabel`（"会话续接元信息"），summary 用 `buildSummarySeedMessage`（"上下文交接摘要"）。

### 5.3 Mirror 子进程未根据会话类型设置 Agent 模式

**问题**：`run-compact-mirror.js` 创建 Agent 时没有读取被压缩会话的 `sessionType`，始终使用主对话模式。压缩探索会话时，Agent 用完整功能 + `system.md` 去理解只读探索会话，语义错位。

**代码位置**：`run-compact-mirror.js:runSingleAttempt()` 第 170-178 行

**已修复**：在创建 Agent 前根据 `sessionType` 设置 `PROTOCLAW_SESSION_TYPE` 环境变量。

### 5.4 sessionType 未传递给 mirror 脚本

**问题**：`summarized-handoff.js` 的 `exportSummarizedHandoffPackage()` 从 `sourceRecord` 读取了 `sessionType`，但没有传给 mirror 脚本的 `options`，导致 mirror 始终用九段式提示词。

**代码位置**：`server/context-continuity/summarized-handoff.js:exportSummarizedHandoffPackage()`

**已修复**：在 `runMirrorCompaction()` 调用的 args 中加入 `sessionType`。

### 5.5 CLI 硬编码 sessionType

**问题**：`bin/claw.mjs` 的 `cmdCompact()` 硬编码 `sessionType: 'exploration'`，无法处理其他类型的会话。

**代码位置**：`bin/claw.mjs:cmdCompact()`

**已修复**：从会话索引读取实际的 `sessionType`。

---

## 六、修改 compact 系统时的检查清单

修改任何 compact 相关代码前，逐项确认：

1. **改动影响哪条路径？** In-process（`run-prebuilt-agent.js`）、Mirror（`run-compact-mirror.js`）、还是两者都影响？
2. **LLM 输出格式是否变了？** 如果是，两条路径的结果提取逻辑都必须更新。
3. **提示词格式是否变了？** 如果是，确认 `buildClaudeCompactPrompt()` 和 `run-compact-mirror.js` 的 prompt 构建是否一致。
4. **Handoff JSON 结构是否扩展？** 如果是，确认 `parseHandoffContent()`（`run-prebuilt-agent.js`）和 `ContextHandoffSeedFeature` 构造函数都能读取新字段。
5. **Trim 和 Summary 的注入差异是否被保留？** 修改 `ContextHandoffSeedFeature` 时，确认 `mode` 区分仍然正确。
6. **会话类型（sessionType）是否被正确传递？** 从触发端到 prompt 构建到 Agent 模式设置，全链路确认。

---

## 七、正确的注入语义规范

本节是对前面"概念词典"和"数据流"的**精确约束补丁**。当历史实现与本文冲突时，以本文为准。

### 7.1 两种模式的注入清单

#### Trim 模式

**编译产物**（`exportHistoryOnlyHandoffPackage`）：

| 字段 | 内容 | 约束 |
|---|---|---|
| `seedMessages` | 全部轮次的对话消息 | **不做消息丢弃**。被精简轮次的 user/assistant 文本完整保留，工具调用折叠为摘要行；未精简轮次全部内容完整保留 |
| `sourceSummary` | `buildCompactOverview()` 产物 | **不在消费端注入**。仅作为 handoff 包的结构化字段保留，供元数据读取 |
| `importantFiles/Skills` | — | Trim 不走 LLM，通常为空 |

**消费端注入**（`ContextHandoffSeedFeature @CallStart`）：

| 步骤 | 注入 | 条件 |
|---|---|---|
| 1 | seedMessages（全部轮次） | seedMessages 非空 |
| 2 | sourceSummary system 消息 | **跳过**（seedMessages 非空时不注入 sourceSummary） |
| 3 | importantFiles/Skills | 通常无 |

**LLM 感知**：模型自然续接对话，无额外续接说明。折叠的工具调用以 `[Folded tool activity]` 形式提供上下文线索，不打断对话流。

**工具折叠边界控制**：policy 新增 `fullPreserveFromTurn` 字段（区别于旧的 `keepRecentTurns`）：

| 字段 | 语义 | 消息保留 | 工具折叠 |
|---|---|---|---|
| `keepRecentTurns`（旧） | 保留最后 N 个 turn | 丢弃 N 之前的消息 | 不区分 fold/keep |
| `fullPreserveFromTurn`（新） | 从该 turn 起工具完整保留 | **保留所有消息** | turn < 值 → 折叠；turn >= 值 → 完整保留 |

#### Summary 模式

**编译产物**（`writeSummarizedHandoffPackage`）：

| 字段 | 内容 | 约束 |
|---|---|---|
| `seedMessages[0]` | 1 条 system 角色消息（续接说明 + 摘要） | 这是唯一的摘要注入源 |
| `sourceSummary` | 原始摘要文本 | **不在消费端重复注入**。仅作为结构化字段保留 |
| `compactOutput` | `importantFiles/Skills/fileRanges` | 正常注入 |

**消费端注入**：

| 步骤 | 注入 | 条件 |
|---|---|---|
| 1 | seedMessages[0]（续接说明 + 摘要） | seedMessages 非空 |
| 2 | sourceSummary system 消息 | **跳过**（seedMessages 非空时不注入，避免摘要重复） |
| 3 | importantFiles 文件内容 | compactOutput.importantFiles 非空 |
| 4 | importantSkills 技能定义 | compactOutput.importantSkills 非空 |

**LLM 感知**：模型明确知道自己在接续前一段工作，带着一份摘要继续。

### 7.2 sourceSummary 注入决策规则

`ContextHandoffSeedFeature` 对 sourceSummary 的注入决策：

```
if (seedMessages.length > 0) {
  // 现代格式：seedMessages 已包含完整上下文（trim 对话 或 summary 摘要）
  // → 不注入 sourceSummary
} else if (sourceSummary 存在) {
  // 传统回退：只有纯文本 sourceSummary，没有 seedMessages
  // → 注入 sourceSummary（用 mode 对应的包装文本）
}
```

此规则确保：
- Trim 不注入冗余元数据
- Summary 不重复注入摘要
- 传统格式（仅有 sourceSummary 字符串）仍能正常工作

### 7.3 衔接文本规范

#### Summary seedMessage（`summarized-handoff.js` 的 `buildSummarySeedMessage`）

正确措辞：

```
以下是前一会话的工作摘要，用于延续同一任务上下文。
摘要涵盖前一轮对话的关键内容。

摘要：
{summaryText}

请基于此摘要继续工作，无需要求用户重复陈述背景。
```

**禁止使用**：
- "因上下文耗尽而中断" — 压缩不一定是上下文耗尽触发，也可能是用户主动操作
- "本次会话由...继续而来" — 暗示被动中断而非主动选择，且引入"本次"的自我指涉歧义

#### Trim seedMessages

Trim 的 seedMessages 就是原始对话消息，**不加任何衔接文本**。模型应能自然地从消息流中理解上下文，不需要额外说明。

### 7.4 前端到编译端的参数传递

**Trim 操作的完整参数流**：

```
前端 submitTrimCompact()
  → 计算 fullPreserveFromTurn = 第一个未勾选轮次的 turnStart
  → createCompactedResumeSession(agentId, sessionId, '', null, fullPreserveFromTurn)
  → POST /protoclaw/context_handoffs/compact_and_resume { policy: { fullPreserveFromTurn } }
  → exportHistoryOnlyHandoffPackage({ policy: { fullPreserveFromTurn } })
  → buildTrimmedSeedMessages(rawMessages, { fullPreserveFromTurn })
    → hasPreserveBoundary = true
    → ALL dialogue messages kept (withinDialogueWindow always true)
    → turn < fullPreserveFromTurn: tools folded
    → turn >= fullPreserveFromTurn: tools kept inline
```

### 7.5 已知历史问题清单

以下问题已在本文档定义的规范中修复，记录于此供后续对照：

| 编号 | 问题 | 根因 | 修复方式 |
|---|---|---|---|
| T1 | 被精简的轮次对话完全丢失 | `keepRecentTurns` 用于消息保留过滤而非工具折叠控制 | 新增 `fullPreserveFromTurn`，只控制工具折叠边界，不丢弃消息 |
| T2 | 保留轮次的工具调用也被折叠 | 默认 `toolFoldScope: 'all'`，不区分精简/保留轮次 | `fullPreserveFromTurn` 使 turn >= 值时工具完整保留 |
| T3 | Trim 注入冗余的 Task/Goal 元数据 | sourceSummary 无条件注入 | seedMessages 非空时跳过 sourceSummary 注入 |
| S1 | Summary 摘要文本被注入两次 | seedMessages 含摘要 + sourceSummary 再次注入同一份文本 | seedMessages 非空时跳过 sourceSummary 注入 |
| W1 | 衔接文本预设"上下文耗尽" | `buildSummarySeedMessage` 硬编码中断原因 | 改为中性措辞"前一会话的工作摘要" |
