# Trim 确定性分级精简设计

> 状态：设计讨论稿，供后续实现与接手使用  
> 日期：2026-07-19  
> 当前范围：只设计和稳定 Trim；暂不合并 Branch 交互与后端事务  
> 核心约束：不依赖大模型生成摘要，不把新元数据下沉到 AgentDev 消息结构

## 1. 文档目的

本文沉淀 2026-07-19 围绕 Trim 的调查结果、产品判断和后续设计方向，避免后续开发重新讨论或遗忘关键边界。

本次讨论最终形成的主线是：

1. 先把 Trim 做成一套可靠、可重复、可选择精简程度的历史投影体系。
2. 第一档是现有 Trim 的改良版：保留对话文本，确定性折叠工具过程。
3. 第二档是更深的“对话心流折叠”：保留用户输入和最终助手回答，将中间助手发言与工具轨迹压缩为一个由纯代码生成的 system reminder 块。
4. 深度精简不是 LLM 摘要。它不生成新的语义结论，只重排、截取、标注已经存在的历史证据。
5. 连续执行 Trim 时，前一次生成的折叠信息不能被后一次无声删除。
6. 精简产物及其来源信息优先保存到 handoff sidecar，不修改 AgentDev 的原生消息槽结构。
7. 等 Trim 的数据模型、编译器和 UI 稳定后，再让 Branch 复用同一套历史投影体系。

## 2. 先明确当前存储结构

当前 Trim / Summary 并不是原地修改同一个 session 文件，而是通过 handoff 派生新 session：

```text
源 Session A（保留完整原始历史）
  │
  ├─ 导出 Handoff H1
  │    ├─ seedMessages
  │    ├─ policy / stats
  │    ├─ featureContinuity
  │    └─ sourceSessionId / sourceSessionPath
  │
  └─ 创建派生 Session B
       └─ metadata.handoffId / handoffPath / sourceSessionId
```

因此，系统已经天然具备三类对象：

- **源 session**：保存完整消息、工具调用、工具结果、checkpoint 和 Feature state。
- **handoff sidecar**：保存从源历史编译得到的上下文投影、策略、统计和来源引用。
- **派生 session**：消费 handoff，在新的运行时中继续工作。

本文建议把新增的精简 artifact 放在 handoff 中。派生 session 只需要继续保存已有的 `handoffPath` 引用，不要求在 AgentDev `messages[]` 中持久化新的 metadata 字段。

### 2.1 为什么不直接依赖 session 中的 system 消息

当前 `Context.addSystemMessage(content, turn, source)` 的 `source` 只存在于 `enrichedMessages`，普通 `messages[]` 只保留 `role/content/turn`。而 Trim 导出读取的是普通 `messages[]`。

这意味着第二次 Trim 只看到一条普通 system 消息，无法可靠区分它是：

- 固定系统提示；
- 运行时临时 reminder；
- Todo 等 Feature 注入的提醒；
- 上一次 Trim 生成的工具折叠块；
- handoff 注入的重要文件或技能内容。

因此不能用 `role === 'system'` 判断它是否应该在下一次精简中保留。

## 3. 已确认的现有问题

### 3.1 Assistant 身份错觉已经修正，但产生了二次 Trim 丢失

旧实现将 `[Folded tool activity]` 作为 assistant 消息注入。模型会把它理解为“这是我以前说过的话”，形成错误的自我认知。

当前实现已将默认角色改为 system。对 Anthropic 来说，首个 user 之后的 system 消息会被编译成 `<reminder>`，因此模型能把它理解为系统提供的历史提示，而不是自己的原始发言。这个方向正确，不应改回 assistant。

但当前默认 Trim 策略又设置了 `includeSystemMessages: false`。于是：

1. 第一次 Trim 把工具活动变成 system fold note。
2. 派生 session 保存这条 system 消息。
3. 第二次 Trim 将它当成普通 system 消息过滤。
4. 第一次精简仅存的工具名、文件名和过程信息完全消失。

已经用当前代码复现这一行为。现有测试只验证“第一次生成的 fold note 是 system”，没有验证“第二次 Trim 后它仍然存在”。

### 3.2 当前所谓“精简某轮”实际上只折叠工具

当前 UI 将未勾选的轮次写入 `preservedTurns`。被勾选的轮次仍会保留：

- user 文本；
- assistant 文本。

只有 assistant tool calls 与 tool messages 被折叠。因此当前产品更准确的语义是“折叠工具活动”，还不是一般意义上的对话精简。

### 3.3 工具结果摘要配置尚未真正生效

后端已有 `foldToolResultSummary`、`summarizeToolPayload()` 和 `pendingFold.toolResults` 等设计痕迹，但工具结果并未进入最终 fold note。

当前 fold note 主要记录：

- 调用了哪些工具；
- 部分工具的文件名或技能名；
- 重复调用次数。

它还不能稳定保留：

- 成功或失败；
- 测试是否通过；
- 修改了哪些目标；
- 是否出现错误；
- 最后一个工具调用停在什么状态。

## 4. 产品定义：Trim 的两个精简等级

第一阶段只实现两个对用户清晰的精简等级。底层可以保留高级策略字段，但不应一开始把大量布尔开关暴露给用户。

### 4.1 Level 1：工具折叠（Tool Fold）

这是当前 Trim 的稳定升级版。

每轮行为：

- 保留 user 原始输入；
- 保留所有 assistant 文本；
- 将 tool calls 和 tool results 折叠为确定性 system reminder；
- 保留必要的工具名、目标、次数、结果状态；
- 删除大段原始工具输出；
- 不使用 LLM。

概念示例：

```text
User
请检查登录失败的问题。

Assistant
我先查看认证中间件和 token 刷新逻辑。

System reminder · 折叠的工具活动
读取 auth.ts、token.ts；搜索 refreshToken；修改 auth.ts；运行认证测试，23 项通过。

Assistant
问题已经修复，原因是刷新 token 时没有更新过期时间。
```

这个块的文本必须由结构化规则生成，不是模型摘要。

#### Level 1 的连续精简契约

Level 1 必须具备近似幂等性：

```text
ToolFold(ToolFold(history)) ≈ ToolFold(history)
```

允许发生：

- 同类工具调用去重；
- 重复项合并为 `×N`；
- 重新应用新的显示预算；
- 统计更新。

不允许发生：

- 文件名无声消失；
- 技能名无声消失；
- 已记录的成功/失败状态无声消失；
- 仅因 artifact 被注入成 system role 就被过滤。

### 4.2 Level 2：对话心流折叠（Dialogue Flow Fold）

Level 2 从“折叠工具”上升到“折叠整轮中间执行过程”，但它仍然不是语义摘要。

每轮最终结构是：

```text
User 原始输入

System reminder · 本轮历史心流
  - Agent 当时说过的中间话语片段
  - 穿插的工具活动标签
  - 本轮完成、失败或中断状态

最终 Assistant 原始输出（若存在）
```

具体规则：

- user 输入原样保留；
- 一轮中最后一次有效的最终 assistant 输出原样保留；
- 其余 assistant 中间发言不再逐条作为 assistant 消息回放；
- 每条中间发言仅截取几十个可见字符，按原始顺序列在 system reminder 中；
- 工具调用压缩成短标签，穿插在对应位置；
- 大段工具结果、代码、日志和 reasoning 被省略；
- system reminder 明确说明这是“历史折叠视图”，不是 agent 当时的逐字输出；
- 全部由纯代码完成，不调用大模型。

概念示例：

```text
User
修复登录失败，并确认测试没有回归。

System reminder · 本轮历史心流
本轮已折叠中间执行过程：
1. Agent：“我先检查认证中间件和 token 刷新……”
2. 工具：read(auth.ts), read(token.ts), grep(refreshToken)
3. Agent：“看起来问题出在刷新后没有同步更新……”
4. 工具：edit(auth.ts), test(authentication)
5. Agent：“相关测试通过，我再确认一下类型检查……”
6. 工具：typecheck；结果：成功
状态：本轮已完成，最终回答保留在下方。

Assistant
问题已经修复。根因是刷新 token 后没有更新过期时间……
```

这个设计的目标不是让模型记住所有细节，而是维持历史心流：

- 模型仍能感知“我当时大致按什么顺序推进”；
- 模型仍能认出自己曾经做过这些工作；
- 具体细节和大体积上下文被有意识地遗忘；
- 不会把机器生成的概括伪装成 assistant 原话。

## 5. 深度精简的确定性截取算法

Level 2 的关键是“截取”，不是“总结”。算法必须可解释、可测试、相同输入得到相同输出。

### 5.1 Assistant 中间发言片段

对每条被折叠的 assistant 文本：

1. 统一换行和空白，但不改变词语顺序。
2. Markdown 标题、列表符号可移除或简化为普通文本。
3. 代码块不复制正文，替换为确定性标签，例如 `[代码片段，约 24 行]`。
4. 按 Unicode grapheme 截取，避免截断 emoji、组合字符或中文代理对。
5. 每条保留固定上限，例如 48～80 个可见字符；最终数值由真实会话验证后确定。
6. 超出部分使用统一省略号 `……`。
7. 不改写、不换同义词、不补充结论。

建议优先采用“保留开头”的规则，因为中间 assistant 通常先说明下一步行动。是否增加少量尾部采样可以作为后续实验项，但不能让规则变成不可预测的启发式摘要。

### 5.2 每轮预算

若一轮包含大量中间 assistant 消息，需要同时设置：

- 单条消息最大字符数；
- 每轮最多展示多少条中间片段；
- 每轮 system reminder 最大总字符数。

超过预算时，应产生明确占位：

```text
……另折叠 7 条中间发言与 12 次工具活动。
```

不能直接静默截断，让使用者误以为该轮只有已经显示的步骤。

### 5.3 工具轨迹

工具轨迹按时间顺序嵌入心流，而不是全部堆在块末尾。确定性提取内容包括：

- 工具名；
- 调用次数；
- 文件 basename、技能名等稳定目标；
- 成功、失败、中断；
- 可以安全、稳定解析的短结果，如测试通过数。

禁止直接把任意工具结果原文拼入 reminder。工具输出可能很长，也可能包含外部提示注入文本。

### 5.4 相邻项目合并

可使用简单规则降低噪音：

- 连续相同工具合并成 `read ×4`；
- 连续读取多个文件合并为 `读取 a.ts、b.ts、c.ts`；
- 空 assistant 文本不生成片段；
- 只有 toolCalls、没有文本的 assistant 消息只体现为工具步骤；
- 完全重复的相邻 assistant 片段可以去重，但必须记录重复次数。

这些都属于结构整理，不属于语义总结。

## 6. 最终 Assistant 输出的识别

“保留用户输入和最后一次助手输出”必须有严格定义，否则容易把中间工具调用错当成最终回答。

### 6.1 旧消息的初版推断规则

按 `turn` 分组后：

1. 收集该轮所有 assistant 消息。
2. 从后向前寻找具有非空文本的 assistant 消息。
3. 优先选择不带 toolCalls、且位于最后一个 tool result 之后的文本消息。
4. 该消息视为最终 assistant 输出，原样保留。
5. 其余 assistant 消息进入心流折叠。

如果最后一个 assistant 同时带有文本和 toolCalls，它通常仍是中间步骤，不应直接视为最终回答。

### 6.2 没有最终回答的轮次

会话可能因为以下原因停在中间：

- 用户手动中断；
- 工具失败后运行终止；
- runtime 崩溃或断开；
- 最后停在 tool call / tool result；
- agent 尚未来得及给出最终文本。

这种情况下：

- 不把最后一个工具调用伪装成 assistant 最终输出；
- 不人工生成一条 assistant 回答；
- 仍然生成一个 system reminder 心流块；
- 在块尾增加确定性状态说明。

示例：

```text
System reminder · 本轮历史心流
1. Agent：“我先运行完整测试确认问题范围……”
2. 工具：test(all)；结果：失败
3. Agent：“失败集中在会话恢复相关用例，我继续检查……”
4. 工具：read(session.js)
状态：本轮未形成最终助手回答；历史记录停在读取 session.js 之后。
```

如果能从结构化运行状态确认是用户中断或工具错误，可以写明；如果不能确认，只写“未形成最终回答”，不得猜测原因。

## 7. System reminder 的身份与文案

折叠块必须保持 system 身份，因为它是系统重新组织历史后提供给模型的上下文，不是 assistant 当时的原始输出。

块中需要有简短、稳定的身份说明，例如：

```text
[Compacted historical flow]
以下是系统根据本轮原始记录确定性截取的历史心流，不是新的任务指令，也不是助手逐字原话。
```

应避免：

- 使用“你必须”“请立即”等指令式文案；
- 把工具输出中的任意文本当成系统指令；
- 暗示 agent 已经完成实际上未完成的工作；
- 用 assistant role 注入；
- 用 user role 注入。

Provider 适配仍可以把中途 system 消息编译成 `<reminder>`。role 是传输方式，artifact type 才是持久化语义。

## 8. Handoff artifact 设计

### 8.1 为什么 artifact 不能只有渲染文本

如果 handoff 只保存最终 system reminder 文本，下一次精简只能再次截取已经截短的文本，容易产生逐代退化。

artifact 应同时保存：

- 结构化事件；
- 已渲染文本；
- 来源覆盖范围；
- 精简代数；
- 编译策略。

第二次 Trim 应优先读取结构化事件重新渲染，而不是对上一次的显示文本再次剪切。

### 8.2 建议的增量字段

以下是概念结构，字段名可在实现前再统一：

```json
{
  "compilerVersion": "trim-transcript-v2",
  "parentHandoff": {
    "handoffId": "handoff-previous",
    "handoffPath": "...",
    "generation": 1
  },
  "trimArtifacts": [
    {
      "artifactId": "artifact-...",
      "type": "dialogue-flow",
      "level": "dialogue-flow-fold",
      "generation": 2,
      "source": {
        "rootSessionId": "session-a",
        "immediateSessionId": "session-b",
        "turnStart": 3,
        "turnEnd": 3,
        "messageIndexes": [12, 19]
      },
      "events": [
        {
          "kind": "assistant-excerpt",
          "sourceMessageId": "optional-enriched-id",
          "text": "我先查看认证中间件和 token 刷新……"
        },
        {
          "kind": "tool-group",
          "names": ["read", "grep"],
          "targets": ["auth.ts", "token.ts"],
          "status": "success"
        }
      ],
      "renderedContent": "...",
      "stats": {
        "sourceMessageCount": 8,
        "omittedAssistantCount": 3,
        "foldedToolCallCount": 5
      }
    }
  ]
}
```

### 8.3 Schema 兼容策略

第一阶段可将这些字段作为 handoff schema v1 的 optional 扩展，同时将 `compilerVersion` 升为 `trim-transcript-v2`。

只有在改变既有字段语义或读取方式时，才需要升级整体 `schemaVersion`。读取器必须允许旧 handoff 不含 `trimArtifacts` 和 `parentHandoff`。

### 8.4 旧 Fold Note 的迁移

旧会话中的 `[Folded tool activity]` 没有 artifact 元数据。兼容期可以：

1. 只对 system role 且内容严格匹配旧编译器固定格式的消息做识别。
2. 将它包装成 `legacy-tool-fold` artifact。
3. 标记来源精度为 `legacy-inferred`。
4. 不把普通用户或系统消息中偶然出现的同名文本当成可信 artifact。

字符串识别只用于迁移，不能成为长期主协议。

## 9. 连续 Trim 的组合规则

连续精简必须显式定义，而不是让消息过滤规则偶然决定结果。

### 9.1 Level 1 → Level 1

- 已有 tool artifact 原样保留或按同类项合并；
- 新产生的工具活动追加到对应轮次；
- 从结构化 events 重新渲染；
- generation 增加，但信息不应逐代衰减。

### 9.2 Level 1 → Level 2

- 已有 tool artifact 作为该轮心流的工具事件输入；
- 中间 assistant 文本生成 excerpt；
- 工具 artifact 与 assistant excerpt 按原顺序组合；
- 生成新的 dialogue-flow artifact；
- 旧 artifact 作为 ancestor，不重复注入模型上下文。

### 9.3 Level 2 → Level 2

- 若策略和预算不变，优先复用已有 dialogue-flow artifact；
- 不对 `renderedContent` 再次截短；
- 若预算改变，从 artifact events 重新渲染；
- 若源结构事件不可用，保留旧 renderedContent 并标记 degraded，不无声删除。

### 9.4 Level 2 → Level 1

Level 1 比 Level 2 更保真，但已经被 Level 2 删除的原始 assistant 消息不能仅靠派生 session 恢复。

有两种策略：

- 若 root source session 仍可读取，根据 artifact coverage 回源重建 Level 1；
- 若无法回源，保留 Level 2 artifact，不假装已经恢复为 Level 1。

UI 应明确提示“从更深精简恢复到更浅精简需要读取原始会话”。

## 10. 编译器结构

不建议在现有 `buildTrimmedSeedMessages()` 中继续堆叠大量条件。应逐步形成三段式编译器：

```text
raw session messages + previous handoff artifacts
  ↓
History IR（按 turn 排序的结构化历史）
  ↓
Trim policy compiler
  ↓
seedMessages + trimArtifacts + stats + diagnostics
```

### 10.1 History IR

概念结构：

```text
Turn
  userMessages[]
  events[]
    assistantText
    assistantToolCall
    toolResult
    systemMessage
    previousArtifact
  finalAssistant?
  completionState
```

IR 的职责是统一：

- turn 分组；
- 原始顺序；
- 最终 assistant 识别；
- tool call / tool result 配对；
- 上一代 artifact 的恢复；
- legacy fold note 迁移。

### 10.2 Policy compiler

第一版策略只需：

```text
level: tool-fold | dialogue-flow-fold
selectedTurns: number[]
preservedTurns: number[]
keepRecentSkillInvokes: number | null
budgets:
  assistantExcerptChars
  maxFlowItemsPerTurn
  maxArtifactCharsPerTurn
```

内部仍可保留 protected tools、最近轮次完整保留等规则。

### 10.3 Preview 必须复用同一编译器

前端预览不能再只依据消息数量和 checkbox 自己推算。服务端 preview 应真正运行编译器，但不写 handoff、不创建 session，并返回：

- 每轮识别出的 user；
- 最终 assistant；
- 将被折叠的 assistant 条数；
- 工具调用数量；
- 生成的 system reminder 预览；
- 未完成状态；
- 预计 seed message 数和 token；
- warnings / degraded reasons。

## 11. Trim UI 第一阶段设计

当前阶段不将 Branch 合入，只改造 Trim 面板。

### 11.1 核心控制

1. **选择精简轮次**
   - 继续支持逐轮选择；
   - 提供“精简到此处”的连续选择；
   - 最近两轮默认完整保留可以继续作为建议，而不是硬规则。

2. **选择精简程度**
   - 折叠工具过程；
   - 折叠整轮中间过程，仅保留问答骨架。

3. **保留规则**
   - 最近 N 次技能调用；
   - protected tool rules；
   - 以后再考虑逐轮不同等级，第一版可以只支持一个全局等级。

### 11.2 每轮预览

每轮卡片至少显示：

- 用户输入预览；
- 被识别为最终回答的 assistant 预览；
- 中间 assistant 条数；
- 工具调用次数；
- 完成 / 中断 / 未知状态；
- 点击后展开“精简后 system reminder”。

若没有最终 assistant，必须醒目标记：

```text
本轮未形成最终回答；精简后将保留一个未完成状态说明。
```

### 11.3 提交前汇总

显示：

- 精简多少轮；
- 完整保留多少轮；
- 折叠多少条 assistant 中间消息；
- 折叠多少次工具调用；
- 复用了多少上一代 artifacts；
- 是否存在 degraded / 无法回源情况；
- 预计 token 变化。

## 12. 与 Feature continuity 的边界

当前未提交改动正在把 Feature continuity 泛化为 descriptor-driven 协议，让 Todo、OpencodeBasic `readFiles` 等逻辑状态跨 Trim / Summary 恢复。

这条线是合理的，但必须与 transcript artifact 分开：

- Feature continuity 保存“新 runtime 继续工作需要的逻辑状态”；
- Trim artifact 保存“模型理解历史心流需要的上下文投影”；
- 原始 session 保存审计和回源证据。

不要把 dialogue-flow artifact 实现成某个 Feature 的 `captureState()`。它属于 session/handoff 编译层，不属于 Agent Feature 内存状态。

## 13. 正确性不变量

实现过程中必须守住以下不变量。

### 13.1 身份不变量

- 系统生成的折叠块不使用 assistant role；
- 不把工具调用伪装成 assistant 最终回答；
- 不把确定性截取描述成模型生成的摘要；
- system reminder 明确是历史投影，不是新任务指令。

### 13.2 信息不变量

- 相同等级连续 Trim 不得无声丢失已有 artifact；
- 更深等级可以主动丢弃细节，但必须通过策略和统计体现；
- 无法恢复更浅等级时必须显式 degraded；
- 源 session 保持不变，除非用户执行独立的删除操作。

### 13.3 顺序不变量

- excerpt 与工具步骤必须保持原始先后顺序；
- turn 不碰撞；
- tool result 若被原样保留，必须有对应 tool call；
- imported history 与新 session 的第一轮用户输入之间保持清楚边界。

### 13.4 确定性不变量

- 不调用 LLM；
- 相同消息、策略和编译器版本产生相同 artifact 内容；
- 字符预算、去重和合并规则可单元测试；
- Preview 与最终导出调用同一核心函数。

## 14. 测试设计

### 14.1 连续精简

- 原始历史 → Level 1 → Level 1，工具名和文件名不丢失；
- 原始历史 → Level 1 → Level 2，工具 artifact 正确进入心流；
- 原始历史 → Level 2 → Level 2，不再次截短；
- 旧 fold note → 新编译器，正确迁移为 legacy artifact；
- 普通 system 消息含有相似字符串时不被误识别。

### 14.2 最终回答识别

- 标准 user → tool loop → final assistant；
- 多条中间 assistant 后有 final assistant；
- assistant 文本同时携带 toolCalls；
- 只有工具调用，没有最终文本；
- 工具失败后中断；
- 用户中断；
- 一轮中存在多个 system reminders。

### 14.3 截取与预算

- 中文、英文、emoji、组合字符；
- Markdown 列表；
- 长代码块；
- 空文本；
- 超过单条预算；
- 超过每轮项目预算；
- 连续相同工具合并；
- 多个文件目标的稳定排序。

### 14.4 Provider 与注入

- system artifact 通过 handoff seed 注入；
- Anthropic 中途 system 被编译为 reminder；
- OpenAI 风格 provider 不把它误作 assistant；
- restart 不重复注入同一 handoff；
- handoff 缺失时给出降级告警而非静默丢失。

### 14.5 Preview 一致性

- Preview 中的 artifact 内容与实际 handoff 完全一致；
- Preview 统计与实际 stats 一致；
- 未完成状态在 Preview 和派生 session 中一致。

## 15. 分阶段实施建议

### Phase A：先解决连续 Tool Fold

目标：修复当前最明确的信息丢失问题。

- 扩展 handoff optional fields：`parentHandoff`、`trimArtifacts`；
- 让导出器沿 session metadata 的 `handoffPath` 读取上一代 artifact；
- 将当前 fold note 同步写成结构化 tool artifact；
- Level 1 重复执行时保留或合并 artifact；
- 补二次 Trim 回归测试；
- 迁移旧 `[Folded tool activity]`。

### Phase B：建立 History IR 和最终回答识别

- 按 turn 构建统一 IR；
- 配对 assistant tool call / tool result；
- 识别 intermediate assistant 与 final assistant；
- 识别 completed / incomplete / error / interrupted（仅使用可证实信息）；
- 将现有 Level 1 迁移到 IR 编译器，确保行为稳定。

### Phase C：实现 Dialogue Flow Fold

- 实现 Unicode 安全截取；
- 实现代码块占位；
- 实现每条和每轮预算；
- 实现 assistant excerpt + tool event 的时序渲染；
- 实现无最终回答的 system 状态说明；
- 实现 Level 1 / Level 2 组合规则。

### Phase D：升级 Trim UI 与真实 Preview

- 精简等级选择；
- 每轮 final assistant / incomplete 预览；
- system reminder 展开预览；
- 预计 token 和 artifact 复用统计；
- warnings / degraded 展示。

### Phase E：稳定后再接 Branch

Branch 暂不进入上述 Phase A～D。

未来接入时，Branch 只增加两个正交维度：

- 历史截止点；
- 派生关系是 successor 还是 parallel branch。

Trim 的 History IR、artifact、精简等级、Preview 和 UI 卡片应全部复用。后端届时再统一为“从源 session 派生新 session”的事务。

特别注意：Branch + Trim 必须先根据分支点选择对应 checkpoint 和 Feature state，再进行历史编译，避免把分支点之后的 Todo、readFiles 等未来状态泄漏到新分支。

## 16. 预计实现触点

第一阶段可能涉及但不限于：

- `server/context-continuity/handoff-package.js`
  - handoff artifact schema；
  - previous handoff 读取；
  - History IR / policy compiler；
  - Level 1 / Level 2 输出。
- `server/routes/session-handoff-helpers.js`
  - 将 source record metadata / parent handoff 传给导出器；
  - Preview 与导出共享编译器。
- `server/routes/session-helpers-pure.js`
  - 现有轮次预览可能迁移或被新的 IR preview 取代。
- `public/src/modules/session-dialogs.js`
  - Trim 等级选择；
  - 新 Preview；
  - warnings 和 stats。
- `local-features/context-handoff-seed/src/index.ts`
  - 仍负责 seed 注入；
  - 第一阶段不要求修改 AgentDev 原生消息结构。
- `test/trim-compact-fixes.test.js`
  - 二次 Trim；
  - 等级组合；
  - artifact 迁移与幂等性。

实际实现时可以进一步拆出独立的纯函数模块，例如：

```text
server/context-continuity/trim-history-ir.js
server/context-continuity/trim-artifacts.js
server/context-continuity/trim-compiler.js
```

这比继续扩大单个 `handoff-package.js` 更容易测试和维护。

## 17. 尚待实验和确认的问题

以下问题不阻塞主方向，但实现前需要通过真实长会话样本确定：

1. 每条 assistant excerpt 默认保留 48、64 还是 80 个可见字符。
2. 是否只取开头，还是对极长文本采用“开头 + 少量结尾”。
3. 每轮最多展示多少个心流项目。
4. 哪些工具可以稳定提取结果摘要，例如测试通过数、退出码、修改文件。
5. 如何可靠区分用户中断、runtime 中断和未知未完成。
6. 一轮内多次工具失败时展示全部还是只展示最后一次。
7. 源 session 被真正删除后，artifact 链如何降级。
8. parent handoff 链达到多少代后需要扁平化或垃圾回收。
9. UI 是否允许单轮覆盖精简等级；建议第一版不做。
10. Level 2 回到 Level 1 时，是否自动回源重编译，还是要求用户确认。

## 18. 最终决策摘要

本轮讨论确认：

- Trim 先独立稳定，Branch 后接。
- Trim 第一阶段提供 Tool Fold 和 Dialogue Flow Fold 两个等级。
- Dialogue Flow Fold 是纯代码的确定性历史截取，不是 LLM 摘要。
- 深度精简保留 user 和最终 assistant；中间 assistant 与工具过程进入 system reminder 心流块。
- 没有最终 assistant 时，system reminder 必须说明本轮未完成及最后可证实状态。
- 工具调用不能被伪装成 assistant 最终输出。
- 连续 Trim 通过 handoff artifact 链保留或合并既有精简信息。
- 新增数据优先放进 handoff sidecar，不修改 AgentDev 消息槽结构。
- Preview 与实际导出必须共享同一确定性编译器。
- 等这套体系稳定后，Branch 再以“截止点 + 派生关系”接入并复用全部能力。

