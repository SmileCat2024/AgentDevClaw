# 长期会话存储、增量回滚与归档分层：现状调查及根本性改造设计

> 文档日期：2026-07-18
> 涉及仓库：`D:/code/AgentDev`、`D:/code/AgentDevClaw`
> 文档性质：架构调查、设计决策记录与实施计划；不是已经完成的实现说明
> 数据口径：按要求不记录当前项目的容量、文件数、会话数、占用比例等规模统计
> 调查方式：只读检查代码、测试、现有设计文档与持久化结构；没有修改用户会话文件

---

## 1. 文档目的

这份报告集中记录此前围绕长期会话存储、回退、压缩、归档、内部消息和上下文重复问题所做的观察、调查、讨论与设计收敛。它要回答的不是“磁盘上现在有多少数据”，而是以下设计问题：

1. 当前会话到底保存了什么，哪些信息是必要状态，哪些只是同一信息的重复投影。
2. 为什么普通 call rollback 会导致会话文件随历史增长而快速膨胀。
3. “Context 保存两份信息”到底是什么意思，这两份数组能否简单合并。
4. “内部消息重复”到底是同一条消息被复制，还是同一业务事件被多次协议化和持久化。
5. 当前“归档”究竟做了什么；压缩存储、冷存储、上下文 compact 又分别是什么。
6. 为什么用户提出的直觉——“回退本质上就是把当前会话后面的分支切掉”——对普通 call rollback 是正确的，但不能无条件套用到所有 checkpoint。
7. 根本性修复应该落在 AgentDev 框架、AgentDevClaw 产品层还是两边同时修改。
8. 如何在不破坏 Feature 状态、usage、branch、partial compact、provider 消息协议和旧会话兼容性的前提下，把普通回退改成增量模型。
9. 哪些看似简单的方案已经被否定，为什么否定；哪些旧结论只是适用范围有限，需要纠正而不是简单推翻。

本文的最终主张是：

> 普通 call rollback 应从“每个回退点保存一份完整 Context”改成“当前会话只保存一份完整 Context，每个回退点保存一个同源前缀边界，加上少量真正需要恢复的运行态”。

与此同时：

- 命名 checkpoint 第一阶段继续保存完整快照，因为它具有跨分支恢复语义，不能安全地退化为当前数组的长度边界。
- Step checkpoint 继续保留为内存中的异常恢复快照，不把它当作磁盘膨胀的主因。
- archive、无损文件压缩、冷存储和语义 compact 必须被视为四种不同能力。
- Claw 中直接读写 session JSON 的路径必须同步升级，尤其是 branch 与 partial compact。
- 会话格式必须显式版本化；新旧 AgentDev/Claw 需要锁步发布并阻止危险降级。

---

## 2. 范围与非目标

### 2.1 本报告覆盖的范围

- AgentDev 的 `Context` 数据结构与快照格式。
- AgentDev 的 session snapshot、call rollback、named checkpoint、step checkpoint、step auto-save。
- AgentDevClaw 的会话文件、会话索引、搜索索引、handoff、branch、partial compact、archive。
- 群聊和内部 continuation 消息进入 Context 后的重复传播。
- 会话格式 v2 的建议结构、迁移、兼容、风险和测试。
- 后续 warm/cold storage 的分层方向。

### 2.2 本报告刻意不做的事

- 不记录或复述当前用户数据的具体规模。
- 不引用用户会话正文，只讨论结构、类型和控制流。
- 不直接实施迁移，不批量重写现有 session。
- 不承诺回退文件写入、Shell 命令、网络请求、数据库更新、IM 发送等外部副作用。
- 不把长期记忆、向量检索、知识图谱等更大议题混入第一阶段存储修复。
- 不立即把整个会话系统重写成 event sourcing、内容寻址 DAG 或数据库事务系统。

---

## 3. 先统一术语：几个经常被混为一谈的“压缩”

### 3.1 语义上下文压缩（compact）

语义 compact 是有损的上下文重建：从旧对话中选择、摘要或重新组织信息，构造下一次 LLM 应看到的 Prompt View。它的目标主要是降低模型输入、移除低价值历史并保留任务连续性。

它不是一种磁盘编码技术，也不保证能够逐字恢复原始对话。

### 3.2 无损文件压缩

无损文件压缩是把同一个 session 文件用 gzip、zstd 等编码保存。解压后字节语义不变。它可以降低静态占用，但不会消除快照模型里的逻辑重复，也不会改变回退复杂度。

### 3.3 结构性去重

结构性去重是不再把同一 Context 前缀保存多次。本文提出的增量 rollback 属于这一类：它改变持久化表达方式，但不改变用户可见的回退语义。

### 3.4 归档

归档是产品生命周期状态：一个任务是否仍在活跃列表、是否仍参与默认加载、是否允许继续写入。归档本身可以只是一条 metadata，也可以触发存储迁移；当前实现属于前者。

### 3.5 冷存储

冷存储是物理存储层级：把长期不活跃、低频访问的会话移出热路径，按需解压或 hydrate。冷存储通常应建立在结构性去重之后，否则只是把冗余搬到另一个目录。

### 3.6 一句话区分

```text
compact       = 改变模型下一次看到什么，通常有损
file compress = 同一文件换一种无损编码
deduplicate   = 不再重复保存同一逻辑内容
archive       = 标记生命周期状态
cold storage  = 改变低频数据放在哪里、如何按需加载
```

这五者可以组合，但不能互相代替。

---

## 4. 正确的三层心智模型

此前关于 compact 与 successor session 的讨论形成了一个非常重要的纠偏：不要再把 `messages[]` 同时当作事实日志、运行时状态和下一次 prompt。

### 4.1 Raw Conversation Log

Raw Log 回答“发生过什么”。它可以包含：

- 用户输入；
- assistant 输出；
- tool call 与 tool result；
- system 注入；
- Feature/Flow hook 注入；
- 群聊事件、调度事件和内部 continuation；
- compact、rollback、handoff 等控制事件。

它偏向审计和历史事实。

### 4.2 Runtime State

Runtime State 回答“系统现在处于什么状态”。当前 AgentDev session runtime 至少涉及：

- `initialized`；
- `callIndex`；
- Feature 的 `captureState()` 结果；
- usage 统计；
- rollback history；
- named checkpoint；
- Context 当前内容。

Flow 节点、Feature 模式、todo、subagent 管理状态等也可能属于这一层。它们不能可靠地只靠历史消息反推。

### 4.3 Prompt View

Prompt View 回答“这一次真正要让模型看见什么”。它可以由 Raw Log 与 Runtime State 编译而来，但不必等于完整历史。

语义 compact 更准确的描述应是：

```text
Raw Log + Runtime State + Compaction Policy
                  ↓
       Context Compiler / Prompt Rebuilder
                  ↓
             Prompt View
```

### 4.4 本次修复与三层模型的关系

本次增量 rollback 不要求立刻把三层完全拆成新框架，但会避免继续加深混淆：

- 当前完整 Context 仍作为运行时可见的 Prompt/Context 载体。
- 普通 rollback 不再保存多个完整 Prompt/Context 副本，只保存边界。
- Feature state 与 usage 仍作为 Runtime State 独立保存。
- archive/cold storage 不冒充 compact。
- 后续若引入 Raw Log，应由投影器生成 Prompt View，而不是继续把所有派生消息当作唯一事实源。

---

## 5. 当前持久化分层

### 5.1 Claw 用户数据根目录

AgentDevClaw 的持久化根路径在：

- `server/shared/constants.js:17`：`USER_DATA_ROOT`
- `server/shared/constants.js:19`：`PREBUILT_SESSIONS_ROOT`
- `server/shared/constants.js:20`：`PREBUILT_WORKSPACES_ROOT`
- `server/shared/constants.js:29`：`GROUP_CHATS_ROOT`

长期会话相关信息分散在几类物理对象中：

1. workspace 下的完整 session JSON；
2. session `index.json` 一类轻量索引；
3. `search-index.json` 搜索读模型；
4. `context-handoffs` 中的交接包；
5. group chat 自己的消息记录；
6. usage ledger 等旁路状态。

这意味着“同一业务信息出现多处”不一定是 bug：某些是写模型、读模型和交接产物的合理分离。真正的问题在于是否有清晰权威层、是否有生命周期、是否保存了本不需要的完整副本。

### 5.2 Session index 不是 Session 本体

Session index 应是列表和查询所需的读模型，保存标题、状态、时间、预览、活动会话等 metadata。完整 session 文件才保存可恢复运行态。

历史性能调研曾正确指出：列表查询不应为了显示 metadata 而反复读取所有完整 session。这个结论依然成立。

但那份调研中的“框架侧 session 文件无需修改”只能限定在“修复列表读取性能”这个问题上。对于本次发现的 rollback 结构性重复，框架正是根因所在，因此需要修改 AgentDev。二者并不矛盾：

```text
列表慢               → Claw 读模型维护问题
rollback 快照重复    → AgentDev snapshot schema 问题
```

### 5.3 Search index 是派生读模型

`server/routes/session-search-index.js` 维护搜索索引。该索引会保存可搜索文本，因此会把 session 内容再次投影到另一个文件中。

这不是 rollback 增量化可以自动消除的内容。正确方向是：

- 明确 search index 可重建，不是权威历史；
- 为 archived/cold session 设计单独索引策略；
- 避免默认热路径加载所有归档全文；
- 允许索引按版本重建或按需 hydrate；
- 删除 session 时同步删除或失效对应索引条目。

### 5.4 Handoff package 是交接产物

`server/routes/session-handoff-helpers.js` 会读取、写入并聚合 handoff package。它可能保存摘要、seed messages、compact output、重要文件和技能等。

Handoff 不应被简单称为 session 的“备份”。它表达的是 Exact Restore 之外的另一种恢复：把旧任务编译成可以由新实例消费的交接包。它可以重复部分信息，但必须有：

- `sourceSessionId` / lineage；
- 明确的生成模式；
- 生命周期或引用计数；
- 是否可重建的标记；
- 源 session 删除或冷迁移后的处理规则。

### 5.5 Group chat 是独立事实源

`server/routes/group-chat.js:548` 的 `appendGroupChatMessage()` 保存群聊业务事件。之后同一业务内容会通过 dispatch 转换成 agent 能消费的上下文。

群聊记录与 agent Context 同时存在并非天然错误：前者是群聊事实源，后者是某个 agent 当时看到的 Prompt View/运行历史。问题是当前两者之间缺少 event identity 和投影边界，导致无法区分：

- 原始群消息；
- catch-up 聚合；
- system reminder；
- 自动 user continuation；
- rollback 快照中的重复副本。

---

## 6. AgentDev 当前 Session Snapshot 的真实结构

核心类型在 `D:/code/AgentDev/src/core/session-store.ts`。

### 6.1 AgentRuntimeSnapshot

当前结构包含：

```ts
interface AgentRuntimeSnapshot {
  initialized: boolean;
  callIndex: number;
  context?: ContextSnapshot;
  featureStates: FeatureCheckpoint[];
  usageStats?: UsageStatsSnapshot;
}
```

这说明一次 runtime snapshot 不是“消息数组快照”，而是：

```text
Context + call counter + Feature state + usage
```

### 6.2 CallRollbackSnapshot

当前普通 call checkpoint 结构是：

```ts
interface CallRollbackSnapshot {
  callIndex: number;
  draftInput: string;
  runtime: AgentRuntimeSnapshot;
}
```

由于 `runtime` 内含完整 `context`，每个 rollback entry 都拥有当时 Context 的完整深拷贝。

### 6.3 AgentSessionSnapshot

当前会话快照同时包含：

```ts
interface AgentSessionSnapshot {
  version: number;
  sessionId: string;
  savedAt: number;
  agentType: string;
  runtime: AgentRuntimeSnapshot;
  rollbackHistory: CallRollbackSnapshot[];
  namedCheckpoints?: NamedCheckpoint[];
}
```

也就是说，一个 session JSON 中同时出现：

- 当前完整 runtime；
- 每次普通 call 之前的完整 runtime；
- 每个命名 checkpoint 的完整 runtime。

如果消息历史持续追加，普通 checkpoint 就形成“越来越长的前缀副本序列”：

```text
current:        M0 M1 M2 M3 M4 M5
checkpoint 0:  [边界前状态]
checkpoint 1:  M0
checkpoint 2:  M0 M1
checkpoint 3:  M0 M1 M2
checkpoint 4:  M0 M1 M2 M3
checkpoint 5:  M0 M1 M2 M3 M4
```

保存完整前缀时，总表达成本随着会话增长呈三角形累加。它不是“偶尔重复几条消息”，而是数据模型把本可用边界表达的历史，表达成了多份完整状态。

### 6.4 整文件 pretty JSON 写入

`D:/code/AgentDev/src/core/session-store.ts:66-70` 的 `FileSessionStore.save()` 使用：

```ts
writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8')
```

这带来四个性质：

1. 每次保存都重新序列化整个 session；
2. 缩进会增加静态体积，但它只是次要因素；
3. step auto-save 会放大整文件写入成本；
4. 当前写入不是“临时文件 + 原子 rename”，崩溃时存在半写或损坏风险。

因此根本修复应先减少结构性内容，再做原子写和可选压缩；只移除 pretty print 不是根治。

---

## 7. Context 为什么看起来“保存了两份消息”

核心实现位于 `D:/code/AgentDev/src/core/context.ts`。

### 7.1 两个数组

`ContextSnapshot` 当前为：

```ts
interface ContextSnapshot {
  version: number;
  messages: Message[];
  enrichedMessages?: EnrichedMessage[];
  sequence?: number;
}
```

内部同时维护：

- `messages`：兼容现有 LLM、UI 和通用消息消费方的基础消息数组；
- `enrichedMessages`：带 id、tags、parsed、sequence 等内核化信息的增强表示；
- `indexes`：从增强消息重建的内存索引；
- `sequence`：增强消息序列游标。

`Context.toJSON()` 会把 `messages` 和 `enrichedMessages` 都复制进快照；`Context.restore()` 又会同时恢复两者并重建索引。

### 7.2 它们不是严格的一对一镜像

一个容易产生严重错误的假设是：

```text
messages.length === enrichedMessages.length
```

当前代码并不保证这一点：

- 通用 `Context.add()` 只追加 `messages`；
- `addUserMessage()`、`addAssistantMessage()`、`addToolMessage()`、`addSystemMessage()` 等 typed API 会维护增强表示；
- 一些 Feature 和 Claw 代码直接调用 `context.add({...})`；
- 老版本会话、handoff replay、显式 `restore()` 和历史修复路径也可能产生不对齐。

因此“只保存一个 message count，然后同时截断两个数组”是不正确的。

### 7.3 两份信息是否都不该存

当前阶段不能武断地删除任一数组：

- 大量 Claw 代码直接读取 `runtime.context.messages`；
- Feature query/index 依赖 enriched data；
- 旧会话兼容依赖当前快照结构；
- enriched message 可能不是从基础 Message 无损、稳定地重新推导出来的。

长期可以考虑把基础内容与增强 metadata 归一为单一 canonical record，再按需投影旧 `Message[]`。但这是一项独立的 Context schema 重构，不应与 rollback 增量化绑成一次高风险发布。

### 7.4 对本次设计的直接约束

普通 rollback 边界必须至少保存：

```ts
interface ContextBoundary {
  messagesLength: number;
  enrichedMessagesLength: number;
  sequence: number;
  generation: number;
}
```

两份长度分开保存，是对现状的尊重，不是认可永远保留双数组。

---

## 8. 当前普通 Call Rollback 的语义

### 8.1 checkpoint 在哪里捕获

`D:/code/AgentDev/src/core/agent.ts` 的 `onCall()` 当前大致顺序是：

1. 初始化 Context 与 Agent；
2. 执行 `CallStart` hooks；
3. 在用户消息加入前捕获 `preCallRuntime`；
4. 添加本次 user message；
5. 提交 call checkpoint；
6. 进入 ReAct loop；
7. 完成时保留当前 Context；
8. SessionStore 在需要时保存当前 runtime 与 rollbackHistory。

关键位置：

- `agent.ts:339`：捕获 pre-call runtime；
- `agent.ts:349`：加入用户消息；
- `agent.ts:355`：提前提交 checkpoint；
- `agent.ts:1502`：`commitCallCheckpoint()`。

“用户消息前捕获”决定了 rollback 的产品语义：回退到 call N，就是回到 N 的用户输入尚未进入 Context 的状态，并把原输入作为 `draftInput` 返回。

### 8.2 rollback 实际做什么

`agent.ts:650` 的 `rollbackToCall(callIndex)`：

1. 按 callIndex 找 checkpoint；
2. 调用 `restoreRuntimeSnapshot(checkpoint.runtime)`；
3. 只保留 `callIndex < target` 的普通 checkpoints；
4. 推送恢复后的 Context；
5. 返回目标 call 的 draft。

这与用户直觉一致：

```text
回退到某轮之前
  = 恢复该轮之前的运行态
  + 切掉该轮及其之后的对话分支
  + 把该轮输入重新交给调用者编辑或重试
```

### 8.3 为什么普通 rollback 天然适合增量边界

普通 call checkpoint 是随着同一会话按时间顺序创建的 pre-call 状态。只要 Context 没有中途被非追加式重写，它就是当前 Context 的严格前缀。

调查中对旧快照做了结构验证：绝大多数 call checkpoint 的 `messages` 与 `enrichedMessages` 都能被当前 Context 的相应前缀精确解释；同时也发现少量历史异常，因此迁移不能假设所有旧文件都完美。

正确结论不是“所有旧 checkpoint 都直接替换成长度”，而是：

> 新版本从产生时就保存边界；旧版本只有在严格前缀校验通过时才能转成边界，否则保留 legacy full snapshot。

---

## 9. Step Checkpoint 为什么不是本次磁盘修复重点

Step checkpoint 位于：

- `D:/code/AgentDev/src/core/checkpoint.ts:21`：`createStepCheckpoint()`；
- `D:/code/AgentDev/src/core/checkpoint.ts:31`：`rollbackToStepCheckpoint()`；
- `D:/code/AgentDev/src/core/agent/react-loop.ts:100`：每步建立；
- `react-loop.ts:506`：错误时恢复。

它确实捕获完整 Context 与支持快照的 Feature state，但它是当前 ReAct step 的内存异常恢复点，不直接作为一组历史 checkpoint 写入 `AgentSessionSnapshot.rollbackHistory`。

因此需要纠正一个旧直觉：

> “每个 step 都建立完整 checkpoint，所以磁盘上一定保存了所有 step checkpoint”——不正确。

真正写入 session 的主要是：

- 当前 runtime；
- 普通 call rollback history；
- named checkpoints。

Step auto-save 会触发整份 session 保存，但保存的是当时的会话快照，不是把每个 step checkpoint 累加到文件中。它是写放大器，不是历史副本的来源。

---

## 10. Named Checkpoint 为什么暂时不能照搬边界模型

Named checkpoint 位于：

- `D:/code/AgentDev/src/core/agent.ts:718`：`createNamedCheckpoint()`；
- `agent.ts:747`：`rollbackToNamedCheckpoint()`；
- `D:/code/AgentDevClaw/server/call-arbiter.js:376`：checkpoint barrier；
- `call-arbiter.js:397`：rollback barrier。

它与普通 call checkpoint 的差异不是名字，而是分支语义。

### 10.1 普通 call checkpoint

- 面向线性 call history；
- rollback 后会剪掉目标及之后的普通 checkpoints；
- 目标通常是当前 Context 的过去前缀；
- 不需要在剪枝之后恢复已删除的未来。

### 10.2 Named checkpoint

- 由 Agent 主动建立；
- 具有稳定 id；
- 可能跨多个 continuation segment 被引用；
- 当前 `rollbackToCall()` 不会自动删除所有 named checkpoint；
- 一个 named checkpoint 可能指向后来已从当前 Context 剪掉的分支内容。

如果 named checkpoint 只保存 `{messagesLength}`，而当前数组已经回退到更短分支，那么长度边界无法凭空重建被剪掉的内容。

### 10.3 第一阶段决策

第一阶段只增量化普通 call rollback。Named checkpoint 继续保存完整 runtime snapshot。

这不是认为 named checkpoint 的现状最优，而是避免把两种不同语义硬塞进同一个模型。后续若要对 named checkpoint、branch、fork 做统一去重，更合适的底层可能是：

- immutable message segments；
- content-addressed blocks；
- segment DAG；
- branch head + parent references；
- 独立 runtime state blocks。

那是第二代分支存储模型，不应成为第一阶段的前置条件。

---

## 11. Branch 路径是最高风险的 Claw 集成点

`D:/code/AgentDevClaw/server/routes/session.js:278` 的 `/protoclaw/sessions/branch` 当前直接读取并重写 session JSON。

它会：

1. 截取 `runtime.context.messages`；
2. 根据保留消息计算最大 user turn；
3. 过滤 `rollbackHistory`；
4. 截取或过滤 `enrichedMessages`；
5. 从 cut 之后或 cut 当时的 checkpoint runtime 选择 Feature/usage 状态；
6. 拼装新的完整 branch snapshot；
7. 直接 pretty-print 写入新 session 文件；
8. 启动新 managed runtime。

### 11.1 它为什么会受 v2 影响

v1 checkpoint 内有 `checkpoint.runtime.context`，branch route 可以拿它当任意历史点的完整状态。v2 普通 checkpoint 将不再保存完整 Context，所以 branch 不能继续假设该字段存在。

### 11.2 当前算法还存在的语义风险

Branch 需要的是“保留到某个消息位置后的运行态”。消息位置、user turn 和 call boundary 并不天然等价：

- 一个 call 内可以有多条 user message；
- Feature 在 CallStart 注入消息；
- tool/system 消息可能位于 cut 附近；
- cut 在某个 call 结束处时，想要的是该 call 执行后的 Feature 状态；
- pre-call checkpoint 保存的是该 call 执行前状态。

当前代码优先找 `maxUserTurn + 1` 的 checkpoint runtime，实际上是借“下一轮开始前状态”近似“上一轮完成后状态”。如果 branch 切在最后一轮且不存在下一轮 checkpoint，就会退回 cut 当轮之前的状态，可能出现“消息包含了该轮结果，但 Feature state 仍是该轮之前”的不一致。

### 11.3 根本修复方向

Branch 不应再自行理解 session JSON 内部细节。AgentDev 应提供框架级变换原语，例如：

```ts
interface BranchBoundary {
  messageIndexEnd?: number;
  callIndexEnd?: number;
}

agent.createBranchSnapshot({
  sourceSnapshot,
  boundary,
  newSessionId,
}): Promise<AgentSessionSnapshot>
```

或者提供纯函数：

```ts
transformSessionSnapshot(source, {
  kind: 'branch',
  boundary,
  targetSessionId,
})
```

框架负责：

- 解释 v1/v2/mixed checkpoint；
- 截断 Context 两个数组；
- 确定 callIndex；
- 恢复或选择 Feature/usage 状态；
- 过滤 rollback history；
- 处理 named checkpoint 的 lineage；
- 返回可加载的完整新 snapshot。

Claw 只负责产品 metadata、文件命名、索引更新和启动 runtime。

### 11.4 必须补的测试

当前 helper 级测试不足以证明真实 branch 能加载并继续回退。需要真正的端到端测试：

```text
建立多轮 source session
→ 让 Feature state 每轮发生可观察变化
→ 在不同消息/轮次边界创建 branch
→ 用 fresh Agent 加载 branch
→ 验证 Context、callIndex、Feature、usage
→ 在 branch 中再执行一轮
→ rollback 到保留的历史轮
→ 保存并重新加载验证
```

---

## 12. Partial Compact 与普通 Rollback 的关系

`D:/code/AgentDevClaw/scripts/runtime-summary.js:353` 的 `rollbackToCallAndSave()` 是回退并保存的产品包装；`triggerPartialCompact()` 在同一 session 内执行：

1. 在回退前读取将被移除的消息；
2. 先生成摘要；
3. 调用普通 `rollbackToCall()`；
4. 在恢复后的 Context 中注入 system summary；
5. 再次保存并同步 UI。

这个产品动作本质是：

```text
读取失败/冗长分支
→ 生成有损摘要
→ 用无损 rollback 切掉该分支
→ 把摘要作为新信息接回保留前缀
```

因此它正好依赖普通 rollback 的边界语义，v2 可以支持它，但必须满足：

- `truncateToBoundary()` 同时正确处理 messages 与 enrichedMessages；
- rollback 恢复 Feature/usage/callIndex；
- 摘要通过 typed Context API 注入，避免只更新一个数组；
- rollback 与最终 summary 保存之间有清晰事务屏障；
- fallback 不再手工构造可能不一致的 `ContextSnapshot`；
- 失败时不能留下“已剪枝但摘要未保存”的静默半状态。

更长期的方向是把 partial compact 也做成框架认可的 session transformation，而不是让产品层直接拼接 Context。

---

## 13. 内部消息“重复”到底是什么意思

### 13.1 不是只有一种重复

内部消息问题至少有四层：

1. **业务事实重复保存**：例如群聊原消息存在 group chat 文件中，也进入 agent session。
2. **协议投影重复**：一个业务事件同时产生 system detail 和短 user continuation。
3. **快照物理重复**：上述消息进入 Context 后，又被当前 runtime 和多个完整 rollback snapshot 复制。
4. **派生索引重复**：session 内容又进入 search index 或 handoff package。

只有第三层能被本次增量 rollback 直接大幅消除。其他层需要各自的权威源、引用和生命周期设计。

### 13.2 群聊路径

关键链路：

- `server/routes/group-chat.js:548`：保存 group message；
- `group-chat.js:2443-2473`：构建并投递 `contextText` 与实际 text；
- `local-features/group-admin/src/bridge.ts:62`：CallStart 注入 pending context；
- `bridge.ts:93`：StepStart 注入 busy 期间的 buffer；
- `server/call-arbiter.js`：把 envelope text 作为 user input 交给 `onCall()`。

所以同一业务消息可能有如下形态：

```text
GroupChat raw event
  ├─ group chat 持久化记录
  ├─ contextText / catch-up 聚合
  │    └─ Context system message
  └─ envelope text
       └─ Context user message
```

这不一定是“完全相同字符串存了两次”，而是同一事件被分别表示为背景和当前指令。若没有 event id，它们后续无法关联或去重。

### 13.3 Checkpoint continuation 路径

`server/call-arbiter.js:412-459` 在 checkpoint/rollback 后会：

- 注入一条详细 system message，携带 checkpoint 状态、summary 和外部副作用警告；
- 构造一条很短的自动 user input，让下一 physical `onCall` segment 继续。

这是为了满足 provider 和 Agent 执行协议：新的 `onCall` 需要一个输入，而详细控制信息又更适合作为 system reminder。它们是两个协议消息，但属于一个逻辑 control event。

正确的长期模型不是简单删除其中一个，而是引入 metadata：

```ts
interface InternalControlEventRef {
  eventId: string;
  kind: 'checkpoint-committed' | 'rollback-applied' | 'group-catchup';
  projection: 'system-detail' | 'user-trigger' | 'ui-event';
  synthetic: true;
  visibleToUser?: boolean;
  rebuildable?: boolean;
}
```

有了 event identity，Raw Log 可以只记录一次逻辑事件，不同 Prompt/UI 投影可以按需重建；在当前架构下，也至少可以在搜索、handoff 和显示层识别 synthetic control message。

### 13.4 近期不应做的过度修复

- 不应通过字符串匹配自动删除所有“系统自动发送”消息。
- 不应把 system detail 和 user continuation 合并成一条而不验证 provider/onCall 协议。
- 不应从 agent Context 中完全去掉群聊消息，因为 agent 必须保留它当时实际看到的信息。
- 不应把 search index 当权威源再反向恢复 session。

---

## 14. 当前 Archive 的真实含义

`D:/code/AgentDevClaw/server/routes/session-helpers.js:812` 的 `archivePrebuiltSession()` 只修改 session index record：

```js
session.id === sessionId
  ? { ...session, archived: !!archived, todo: archived ? false : session.todo }
  : session
```

它不会自动：

- 移动 session JSON；
- gzip/zstd 压缩；
- 删除 rollback history；
- 删除 search text；
- 把 handoff 移到冷层；
- 从所有扫描路径排除；
- 合并小文件；
- 延迟 hydrate。

因此需要纠正：

> “会话已经归档，所以它应该已经进入压缩或冷存储”——当前不成立。

当前 archive 是产品状态位，不是 storage tier transition。

---

## 15. 推荐的会话格式 v2

### 15.1 设计目标

1. 当前 runtime 只保留一份完整 Context。
2. 普通 call checkpoint 不再嵌入完整 Context。
3. rollback 仍恢复 Feature state、usage、initialized 与 callIndex。
4. Context 两个数组分别截断。
5. 非追加式 Context mutation 不允许错误复用旧边界。
6. 旧会话按严格校验迁移，异常会话保留完整 legacy checkpoint。
7. Named checkpoint 第一阶段保持完整快照。

### 15.2 建议类型

```ts
interface ContextBoundaryV2 {
  messagesLength: number;
  enrichedMessagesLength: number;
  sequence: number;
  generation: number;
}

interface RuntimeStateWithoutContextV2 {
  initialized: boolean;
  callIndex: number;
  featureStates: FeatureCheckpoint[];
  usageStats?: UsageStatsSnapshot;
}

interface IncrementalCallRollbackSnapshotV2 {
  kind: 'context-boundary';
  callIndex: number;
  draftInput: string;
  contextBoundary: ContextBoundaryV2;
  runtimeState: RuntimeStateWithoutContextV2;
}

interface LegacyCallRollbackSnapshotV2 {
  kind: 'legacy-full-snapshot';
  callIndex: number;
  draftInput: string;
  runtime: AgentRuntimeSnapshot;
  legacyReason?: string;
}

type CallRollbackSnapshotV2 =
  | IncrementalCallRollbackSnapshotV2
  | LegacyCallRollbackSnapshotV2;

interface AgentSessionSnapshotV2 {
  version: 2;
  sessionId: string;
  savedAt: number;
  agentType: string;
  runtime: AgentRuntimeSnapshot;
  rollbackHistory: CallRollbackSnapshotV2[];
  namedCheckpoints?: NamedCheckpoint[]; // 第一阶段仍为完整 runtime
}
```

### 15.3 为什么 runtimeState 仍保存 Feature 和 usage

“rollback 就是截断消息”只描述了用户最直观的对话效果，但不完整。Feature 可能在每轮修改自身状态，usage 也随请求累积；只截断 Context 会形成混合时间线：对话回到了过去，Feature 和 usage 仍停留在未来。

当前 Feature 快照和 usage 相对于 Context 通常很轻，但更重要的是它们具有不同语义，不能从消息长度推导。因此应完整保留。

### 15.4 generation 的必要性

仅存长度会遇到 ABA/同长度不同内容问题：

```text
Context A 长度为 10
→ clear / restore / apply 重写
→ Context B 长度也为 10
```

旧边界 `{length: 5}` 不能因为长度看似合法就用于 B。为此 Context 需要 lineage generation：

- 纯追加 typed message：generation 不变；
- rollback 的合法截断：generation 可以保留或按明确定义更新；
- `clear()`、任意重排的 `apply()`、从外部 full snapshot `restore()`：generation 增加；
- boundary 必须与当前 generation 匹配；
- 跨 generation 只能使用完整 snapshot 或经严格内容校验的迁移边界。

generation 不应只是序列化字段，还要成为 Context API 的运行时不变量。

---

## 16. 建议新增的 Context 原语

不要让 Agent、Claw、Feature 各自直接 splice 私有数组。应由 Context 自己提供原子边界操作。

### 16.1 捕获边界

```ts
captureBoundary(): ContextBoundaryV2 {
  return {
    messagesLength: this.messages.length,
    enrichedMessagesLength: this.enrichedMessages.length,
    sequence: this.sequence,
    generation: this.generation,
  };
}
```

### 16.2 截断到边界

```ts
truncateToBoundary(boundary: ContextBoundaryV2): void {
  this.assertBoundaryCompatible(boundary);

  this.messages = this.messages.slice(0, boundary.messagesLength);
  this.enrichedMessages = this.enrichedMessages.slice(
    0,
    boundary.enrichedMessagesLength,
  );
  this.sequence = boundary.sequence;
  this.rebuildIndexes();
}
```

### 16.3 边界校验

至少检查：

- generation 一致；
- 两个长度均为非负整数；
- 长度不超过当前数组；
- `sequence` 合法；
- 截断后 index 可重建；
- 可选 debug build 中验证 enriched ids/tags 一致性。

### 16.4 Context mutation 收口

当前 `add()`、`clear()`、`apply()` 和 `restore()` 的语义差异很大。长期应把它们分成：

- append-only mutation；
- rollback truncate；
- full replace/restore；
- transform/rebuild。

每种 mutation 明确是否：

- 保留 generation；
- 使现有 boundary 失效；
- 同步 enriched representation；
- 需要创建新的 branch lineage。

这也是此前 session integrity 调研得出的原则：Context 变化不能再被当作“普通数组编辑”，它是会话事务的一部分。

---

## 17. v2 普通 Rollback 的完整算法

### 17.1 创建 call checkpoint

在 CallStart hooks 完成、用户输入加入之前：

```text
contextBoundary = context.captureBoundary()
runtimeState = captureRuntimeStateWithoutContext(callIndex - 1)
checkpoint = {
  kind: 'context-boundary',
  callIndex: currentCallIndex,
  draftInput: finalInput,
  contextBoundary,
  runtimeState
}
commit checkpoint
添加用户输入
进入 ReAct
```

现有代码是先捕获完整 runtime，再添加 user，再提交 checkpoint。实现 v2 时应谨慎保持 Feature 注入已经完成、user 尚未加入的语义；提交 checkpoint 的时间可以继续保证 step auto-save 不会保存“有消息无 checkpoint”的半状态。

### 17.2 保存 session

```text
capture one full current runtime
serialize incremental call checkpoints
serialize full named checkpoints
write temporary file
flush/close as平台允许
atomic rename to target
update index metadata only after success
```

### 17.3 加载 session

```text
read snapshot
validate version
restore current full runtime
load v2 boundaries as rollback entries
load legacy full checkpoints as fallback entries
load named checkpoints unchanged
run integrity diagnostics
```

注意：boundary 依赖当前 Context 的同一 lineage。持久化后重新加载时，`runtime.context.generation` 与 rollback boundary generation 必须作为同一个 session snapshot 一起恢复。

### 17.4 执行 rollback

对于 v2 boundary entry：

```text
acquire runtime/session mutation barrier
validate target checkpoint and generation
capture optional compensation snapshot
context.truncateToBoundary(target.contextBoundary)
restore initialized/callIndex/featureStates/usageStats
prune ordinary checkpoints at and after target call
save atomically and await success
push restored Context and inspector snapshot
release barrier
return draftInput
```

对于 legacy entry：继续走当前完整 runtime restore。

### 17.5 Feature restore 失败

当前多个 Feature 是顺序恢复，不具备数据库事务。如果中间失败，运行态可能部分恢复。正确行为必须 fail closed：

- 不继续 LLM 推理；
- 不声称 rollback 成功；
- 尝试用 compensation snapshot 恢复回退前状态；
- 如果 compensation 也失败，将 runtime 标记为 corrupted/restart-required；
- 保留清晰诊断，不覆盖最后一个已知可加载的磁盘文件。

---

## 18. 保存事务与崩溃一致性

### 18.1 当前问题

整文件直接覆盖意味着崩溃或进程终止可能发生在文件只写入一部分时。会话越复杂、保存越频繁，这一风险越值得处理。

### 18.2 建议的 FileSessionStore hardening

```text
serialize to bytes
→ write session-id.json.tmp-<nonce>
→ close / fsync（按平台能力）
→ rename target to optional .bak
→ atomic rename temp to target
→ verify target parse/version/sessionId
→ 清理过期 backup
```

Windows 上的 rename/replace 语义需要专门测试，不能照搬 POSIX 假设。

### 18.3 事务边界

对 checkpoint/rollback/partial compact，控制流应保证：

- 同一 session 同一时刻只有一个 mutation；
- continuation segment 等待 checkpoint 或 rollback 保存成功；
- search/index 更新晚于 session 主文件提交；
- index 更新失败可自愈，主 session 写失败不能继续；
- UI 只在主状态提交后收到“已完成”状态。

### 18.4 Step auto-save

`agent.ts:794-816` 的 step auto-save 应继续存在，但它必须使用同一原子 SessionStore，并与 session mutation lock 协调。否则 partial compact/rollback 与 step save 可能争相写入不同时间线。

---

## 19. v1 到 v2 的兼容与迁移

### 19.1 Reader 先行

新 AgentDev 先支持读取：

- v1 full checkpoint；
- v2 boundary checkpoint；
- v2 中的 `legacy-full-snapshot`；
- mixed rollback history。

Writer 默认写 v2。

### 19.2 严格前缀迁移

对每个 v1 call checkpoint：

1. 比较 checkpoint `messages` 是否与当前 runtime `messages` 的对应前缀逐项一致；
2. 单独比较 `enrichedMessages` 前缀；
3. 校验 sequence 与长度；
4. 校验 callIndex/turn 基本不变量；
5. 校验成功才转为 boundary；
6. 任何不确定都保留完整 legacy snapshot，并记录 reason code。

绝不能只比较长度，也不能因为大多数旧数据符合前缀就强制转换全部。

### 19.3 懒迁移

推荐：

```text
首次由新 runtime 成功 load
→ 内存 normalize 为 mixed v2
→ 下一次正常 save 时原子写出 v2
```

不推荐首先运行一次不可逆的全量批处理。懒迁移有以下优势：

- 只迁移真正访问的会话；
- 单个失败不影响其他会话；
- 可逐步发布与观察；
- 可以保留原文件 backup；
- 便于按 session 回退。

### 19.4 旧 runtime 降级风险

这是高风险项。旧 AgentDev 若读取 v2 并把缺少 `runtime.context` 的 checkpoint 当作普通 runtime，有可能：

- 恢复 Feature/callIndex，却不截断 Context；
- 表面报告 rollback 成功，实际保留未来消息；
- 保存时进一步破坏 v2 数据。

因此不能依赖“旧版本会报错”。必须：

- session 顶层显式 version gate；
- AgentDev 不认识更高版本时拒绝加载；
- Claw 启动 runtime 时校验 AgentDev schema capability；
- AgentDev 包与 Claw 资源依赖锁步发布；
- 文档明确不支持新 session 被旧 runtime 打开；
- 必要时在 v2 文件中加入 `minimumRuntimeVersion`。

---

## 20. Archive、Warm Storage 与 Cold Storage 的后续设计

结构性去重完成后，再做 storage tiering。

### 20.1 Hot

适合：

- 当前活跃会话；
- 最近使用的非归档会话；
- 正被 managed runtime 打开的 session。

建议格式：可直接加载的 v2 JSON，原子写；搜索 metadata 常驻索引。

### 20.2 Warm

适合：近期归档、仍可能打开的 session。

建议：

- 每个 session 独立无损压缩；
- index 保留标题、时间、状态、压缩编码、校验和、物理路径；
- 打开时解压到内存或短期 cache；
- 不需要为了列表展示解压全文；
- search index 可拆为轻量 metadata 与归档全文 shard。

独立文件优于一开始把全部归档打成单一大包，因为单 session hydrate、损坏隔离和删除更简单。

### 20.3 Cold

适合：长期不活跃、只为审计或偶尔恢复保留的 session。

可考虑：

- 移出 workspace 热扫描目录；
- 分块/打包存储；
- manifest 记录 session 到 block 的映射；
- 按需 hydrate 到 cache；
- 后台校验 checksum；
- 明确 retention 与删除策略。

### 20.4 Archive 状态机建议

```text
active
  └─ archive → archived-hot
                  └─ cooling policy → archived-warm
                                      └─ retention policy → archived-cold

open archived session
  → hydrate
  → read-only inspect 或显式 restore/fork
```

archive API 不应在请求线程内同步做大型压缩搬迁。它可以先提交状态，再由可恢复 job 完成 tier transition。

### 20.5 与搜索的关系

不要为了冷存储直接删除所有归档搜索文本。应先明确产品行为：

- 默认搜索是否包含归档；
- 全文搜索是否允许慢路径 hydrate；
- 是否只保留摘要/标题；
- search shard 是否可重建；
- 删除源 session 后索引如何失效。

---

## 21. 被放弃、延后或否定的方案

### 21.1 只对 JSON 开 gzip

**结论：不作为第一修复。**

理由：无损压缩会掩盖同一 Context 前缀被重复保存的事实；写入仍需构造和序列化整份快照；branch、rollback、迁移仍然面对冗余结构。它适合作为 warm storage 的第二层优化。

### 21.2 只去掉 JSON 缩进

**结论：只能算微优化。**

理由：pretty print 不是主要结构原因。去掉缩进不会改变每个 checkpoint 内嵌完整 Context。

### 21.3 rollback 时只 `messages.splice()`

**结论：否定。**

理由：会漏掉 enrichedMessages、indexes、sequence、callIndex、Feature state 和 usage，产生混合时间线。

### 21.4 两个 Context 数组共用一个长度

**结论：否定。**

理由：`Context.add()` 与 typed add API 的维护行为不同，历史数据中两数组不保证对齐。

### 21.5 把所有旧 checkpoint 无条件转换成 boundary

**结论：否定。**

理由：历史上存在 handoff replay、branch counter、半提交保存、显式 Context mutation 等异常。只能严格前缀校验后转换。

### 21.6 普通 call、named checkpoint、step checkpoint 全部用同一个 boundary 类型

**结论：否定。**

理由：三者生命周期与分支能力不同。普通 call 是线性前缀回退；named checkpoint 可能需要恢复已剪掉未来；step checkpoint 是当前 step 的内存异常恢复。

### 21.7 立即重写成完整 Event Store / DAG

**结论：延后。**

这可能是长期最干净的统一分支模型，但当前 session JSON 有许多直接消费者，立即重写会同时影响 runtime、Claw server、search、handoff、branch、UI、迁移和插件生态。第一阶段边界模型能以较小 contract 变化解决主要结构问题。

### 21.8 把 archive 当作删除 rollback history

**结论：否定。**

归档会话仍可能被恢复、fork 或审计。是否丢弃 rollback capability 是独立 retention policy，不能由 `archived=true` 暗中决定。

### 21.9 通过字符串去重内部消息

**结论：否定。**

相似字符串可能来自不同事件；不同字符串也可能是同一逻辑事件的 system/user 投影。需要 event identity 和 projection metadata，而不是文本去重。

### 21.10 在 Tool 内部直接 rollback 并继续旧 ReAct 栈

**结论：此前已否定，继续保持。**

旧执行栈持有原 Context 局部引用，rollback 替换 persistent Context 后，ToolExecutor/ReAct/onCall 收尾仍可能把旧分支写回。当前正确的控制流是让 physical `onCall` 完整退出，由 CallArbiter 在 segment 之间执行 barrier。

### 21.11 把 rollback continuation 当普通高优先级外部消息

**结论：否定。**

它会提前完成原 envelope、让 IM/dispatch 收到半结果，并允许外部消息插队。当前 logical envelope + sequential segments 的设计更符合“一项外部任务尚未完成”的语义。

---

## 22. 被纠正的旧观念

### 22.1 “归档已经等于压缩/冷存储”

更正：当前 archive 只是 index flag。物理文件没有自动迁移或压缩。

### 22.2 “Context 就是同一批消息保存两遍”

更正：`messages` 与 `enrichedMessages` 是两个相关但不严格一一对应的表示；真正严重的重复还包括每个 rollback runtime 再复制两份数组。

### 22.3 “内部消息都是完全相同文本的重复”

更正：很多情况是同一逻辑事件的多个协议投影，例如 system detail + synthetic user continuation；之后又被快照和索引物理复制。

### 22.4 “回退就是删消息，其他状态不用管”

更正：用户可见效果是剪掉后缀，但正确 runtime rollback 还必须恢复 callIndex、Feature state、usage 和 Context 内部索引。

### 22.5 “每个 step checkpoint 都被写入磁盘”

更正：step checkpoint 本身是内存异常恢复；step auto-save 只是频繁保存整个 session。

### 22.6 “所有 rollback 都能用当前 Context 的长度边界”

更正：普通 call 可以；named checkpoint 未必；branch/fork 需要能够持有多条分支 lineage。

### 22.7 “框架侧不需要改”

更正：对于 session 列表性能，问题主要是 Claw 读模型；对于 rollback 存储冗余，问题位于 AgentDev snapshot schema。旧结论不是整体真理。

### 22.8 “compact 就是把磁盘文件压小”

更正：compact 是有损 Prompt View 重建；gzip 是无损文件编码；两者解决不同问题。

### 22.9 “handoff replay 等于 runtime restore”

更正：seed message replay 只恢复某种历史视图，不自动恢复 call counter、rollback checkpoints 和 Feature runtime。Imported Context 不等于 Local Call History。

### 22.10 “同一个 user turn 一定对应一条 user message”

更正：queue/IM/Feature 可能让一个 callIndex 下出现多条 user message。UI 不能仅凭每条 user message 的 turn 假设它都有独立 rollback checkpoint。

### 22.11 “旧 runtime 打不开 v2 时自然会失败”

更正：更危险的是它可能部分理解并静默执行错误 rollback。因此必须显式版本拒绝和 lockstep release。

---

## 23. 风险清单与缓解措施

| 风险 | 严重度 | 触发方式 | 缓解措施 |
|---|---|---|---|
| Feature state 未恢复 | 高 | 只截断消息 | v2 checkpoint 保留完整 Feature snapshot；E2E 状态验证 |
| messages/enrichedMessages 错位 | 高 | 共用一个长度或外部 splice | 独立边界；Context 自有截断 API；重建 indexes |
| Branch 生成混合运行态 | 高 | 消息切在 call 后、Feature 取 pre-call | 框架级 branch transform；真实 load+rollback E2E |
| 旧 runtime 误读 v2 | 高 | 降级或依赖未锁步 | schema gate、minimum runtime、拒绝未知版本 |
| Named checkpoint 丢失未来分支 | 高 | 仅存当前数组长度 | 第一阶段继续 full snapshot |
| 旧异常会话迁移错误 | 中高 | 只按长度转换 | 严格逐项前缀；legacy fallback；backup |
| Context 非追加 mutation 复用旧边界 | 中高 | `clear/apply/restore` 后长度碰巧一致 | generation/lineage；mutation API 收口 |
| 保存时崩溃损坏 session | 中高 | 直接覆盖整文件 | temp + atomic rename + backup + parse verify |
| rollback 与 step auto-save 竞态 | 中高 | 并发写不同时间线 | session mutation lock；统一 SessionStore barrier |
| Partial compact 半提交 | 中高 | rollback 成功但 summary save 失败 | transformation transaction；compensation/明确失败态 |
| Provider tool pair 不完整 | 高 | 在活跃 ReAct 栈内切 Context | 继续使用 segment barrier；provider transcript tests |
| Search/handoff 索引不一致 | 中 | 主文件提交后派生更新失败 | 主文件为权威；索引可重建；mtime/version 自愈 |
| 外部副作用被误认为已撤销 | 高（产品） | rollback 文案过度承诺 | 明确警告；可快照状态与外部世界分离 |
| Session 直接 JSON 消费方漏改 | 高 | v2 不再有 cp.runtime.context | 全仓 schema consumer audit；adapter/normalizer |

---

## 24. 分阶段实施计划

### 阶段 0：冻结语义与建立保护网

- 写明 call rollback、named checkpoint、branch、partial compact、exact restore、compacted resume 的契约。
- 加 session schema capability 与未知版本拒绝测试。
- 补现有 v1 golden fixtures。
- 补 branch end-to-end 缺口。
- 枚举所有直接访问 `rollbackHistory[].runtime.context` 的代码。

### 阶段 1：AgentDev 增加边界原语

- `Context.generation`。
- `captureBoundary()`。
- `truncateToBoundary()`。
- generation invalidation rules。
- 独立 messages/enriched lengths。
- boundary 单元测试与 mutation property tests。

此阶段可以先不改变磁盘 writer，用内存测试证明原语。

### 阶段 2：AgentDev Session v2

- 新增 v2 union checkpoint schema。
- `captureRuntimeStateWithoutContext()`。
- `rollbackToCall()` 支持 v1 full、v2 boundary、mixed。
- reader version gate。
- writer 输出 v2。
- FileSessionStore 原子写与 backup。
- lazy migration 与 legacy reason diagnostics。

### 阶段 3：Claw 适配

- runtime 启动时检查 schema capability。
- partial compact 只调用框架 transformation/rollback API。
- branch route 改用框架 transform helper。
- UI 只按 capability 展示 rollback target。
- search/handoff/current-message readers 通过 adapter 读取当前 runtime。
- package/tarball/lockfile 锁步升级，禁止新 Claw 搭配旧 AgentDev。

### 阶段 4：迁移观察

- 只对被正常打开并成功保存的 session 懒迁移。
- 记录迁移结果类型：boundary 或 legacy fallback，不记录用户正文。
- 观察 rollback、branch、compact、restore 错误率。
- 提供单 session 恢复 backup 的运维路径。

### 阶段 5：Warm/Cold storage

- archive 状态机与后台 job。
- 单 session 无损压缩。
- manifest/checksum/hydrate cache。
- archived search policy。
- handoff 与 search artifact 生命周期。

### 阶段 6：进一步去重

- internal control event id 与 projection metadata。
- group event → Context projection lineage。
- Context canonical message record 研究。
- named checkpoint/branch 的 immutable segment DAG 可行性验证。

---

## 25. 必须补充的测试矩阵

### 25.1 Context boundary

- 两数组长度相等时截断。
- 两数组长度不等时分别截断。
- 截断后 indexes 重建。
- sequence 恢复。
- 越界、负数、非整数拒绝。
- generation 不匹配拒绝。
- `clear/apply/restore` 使旧边界失效。
- typed add 后边界仍可用。
- direct `add()` 后边界仍按独立长度正确工作。

### 25.2 普通 call rollback

- 第一轮 call rollback 到空/初始化前后正确状态。
- 多轮保存、fresh process 加载、回退。
- rollback 后剪掉目标及未来 checkpoint。
- draftInput 返回。
- rollback 后重新提交同一输入形成新分支。
- Feature state 回退。
- usage 回退。
- debug/UI 收到缩短后的 Context。

### 25.3 v1/v2/mixed

- v1 full snapshot 正常加载。
- 合法 v1 前缀转 boundary。
- 非前缀保留 legacy full snapshot。
- mixed history 在不同 target 上回退。
- v2 保存后再次加载不改变语义。
- 旧 runtime 遇到 v2 明确拒绝。
- 新 runtime 遇到未来 version 明确拒绝。

### 25.4 Named checkpoint

- 第一阶段格式与语义不变。
- 普通 rollback 后 named checkpoint 行为按契约验证。
- named rollback 可以恢复当前 Context 中已不存在的未来内容。
- CallArbiter barrier 等待保存。
- continuation budget 与 envelope completion 不变。

### 25.5 Step rollback 与 auto-save

- Step exception 恢复不受 session v2 影响。
- step auto-save 写出的 session 总是包含当前 call checkpoint。
- 写入中断后主文件或 backup 至少一个可加载。
- rollback/compact 与 step save 不并发覆盖。

### 25.6 Partial compact

- summary 在 rollback 前生成。
- rollback 后保留正确前缀。
- summary 同步加入两种 Context 表示。
- Feature/usage 与 rollback target 一致。
- summary save 失败时进入明确失败/compensation 路径。
- compact 后保存、重启、继续运行。

### 25.7 Branch

- 从中间 call 分支。
- 从最后 call 分支。
- cut 落在 system/tool/assistant 消息附近。
- 一个 call 多 user message。
- 缺失或 legacy checkpoint 的保守行为。
- branch 加载后继续一轮并 rollback。
- Feature state 与保留消息时间线一致。
- named checkpoint lineage 处理明确。

### 25.8 Provider 协议

- OpenAI tool call/tool result 成对完整。
- Anthropic tool_use/tool_result 成对完整。
- rollback 不在活跃 tool batch 中切换 Context。
- continuation system + synthetic user 不破坏 provider 编译。

### 25.9 Group/IM/Dispatch

- 外部 envelope 在内部 segment 全部完成前不 resolve。
- rollback continuation 不允许新外部消息插队。
- group catch-up 注入不会产生不可回退 UI 假目标。
- restart 后 pending message 与 local callIndex 一致。

---

## 26. 可观测性与完整性诊断

诊断应只记录结构，不记录用户正文。建议输出：

```ts
interface SessionIntegrityDiagnostic {
  sessionIdHash: string;
  schemaVersion: number;
  runtimeCallIndex: number;
  checkpointKinds: Record<string, number>;
  rollbackTargetCallIndices: number[];
  messagesLength: number;
  enrichedMessagesLength: number;
  contextGeneration: number;
  namedCheckpointCount: number;
  anomalies: Array<{
    code: string;
    callIndex?: number;
  }>;
}
```

建议 anomaly code：

- `CHECKPOINT_NOT_PREFIX`；
- `ENRICHED_NOT_PREFIX`；
- `BOUNDARY_GENERATION_MISMATCH`；
- `BOUNDARY_OUT_OF_RANGE`；
- `USER_TURN_WITHOUT_CHECKPOINT`；
- `CHECKPOINT_WITHOUT_LOCAL_CALL`；
- `RUNTIME_CALL_INDEX_BEHIND_HISTORY`；
- `BRANCH_STATE_AMBIGUOUS`；
- `UNKNOWN_SESSION_VERSION`；
- `FEATURE_RESTORE_FAILED`；
- `ATOMIC_SAVE_VERIFY_FAILED`。

UI 的 rollback action 应由 capability 驱动：只有框架确认某条 local call 有合法 checkpoint 时才显示，不要单凭消息 role/turn 推断。

---

## 27. 关键代码索引

> 行号基于 2026-07-18 调查时的工作树，后续会漂移；维护时应优先按 symbol 搜索。

### 27.1 AgentDev：Context

| 文件 / 位置 | Symbol | 重要性 |
|---|---|---|
| `D:/code/AgentDev/src/core/context.ts:36` | `ContextSnapshot` | 同时保存 messages、enrichedMessages、sequence |
| `context.ts:56` | `Context.add()` | 只追加基础 messages，是两数组不对齐的重要来源 |
| `context.ts:91` 附近 | `clear()` / `apply()` | 非追加 mutation，需要使 boundary generation 失效 |
| `context.ts:124` | `toJSON()` | 当前深拷贝两个数组 |
| `context.ts:149` | `restore()` | 恢复两个数组并重建 indexes |
| `context.ts:191` | `addUserMessage()` | typed add 路径 |
| `context.ts:203` | `addAssistantMessage()` | typed add 路径 |
| `context.ts:236` | `addToolMessage()` | provider tool transcript 关键路径 |
| `context.ts:263` | `addSystemMessage()` | Feature/compact/system 注入关键路径 |

### 27.2 AgentDev：Session schema 与存储

| 文件 / 位置 | Symbol | 重要性 |
|---|---|---|
| `D:/code/AgentDev/src/core/session-store.ts:8` | `AgentRuntimeSnapshot` | runtime 当前完整状态 |
| `session-store.ts:16` | `CallRollbackSnapshot` | 当前每个 call 内嵌完整 runtime 的根因 |
| `session-store.ts:26` 附近 | `NamedCheckpoint` | 跨 segment 稳定恢复点，第一阶段保留 full snapshot |
| `session-store.ts:43` | `AgentSessionSnapshot` | 顶层 session schema |
| `session-store.ts:63` | `FileSessionStore` | 文件型实现 |
| `session-store.ts:66` | `save()` | 当前直接整文件 pretty JSON 覆盖写 |
| `session-store.ts:73` | `load()` | 当前没有显式 schema gate/normalization |

### 27.3 AgentDev：Call snapshot 与 rollback

| 文件 / 位置 | Symbol | 重要性 |
|---|---|---|
| `D:/code/AgentDev/src/core/agent.ts:339` | `captureRuntimeSnapshot()` 调用 | CallStart 后、user 前捕获边界 |
| `agent.ts:349` | `context.addUserMessage()` | 本轮用户输入进入 Context |
| `agent.ts:355` | `commitCallCheckpoint()` 调用 | ReAct 前提前提交，避免 auto-save 半状态 |
| `agent.ts:587` | `createSessionSnapshot()` | 当前复制 current + rollback + named runtime |
| `agent.ts:611` | `restoreSessionSnapshot()` | session restore/normalization 入口 |
| `agent.ts:650` | `rollbackToCall()` | 普通回退与 checkpoint pruning |
| `agent.ts:718` | `createNamedCheckpoint()` | 命名完整 runtime 快照 |
| `agent.ts:747` | `rollbackToNamedCheckpoint()` | 命名恢复与 named pruning |
| `agent.ts:785` | `saveSession()` | snapshot → store |
| `agent.ts:794` | `enableStepAutoSave()` | step 保存开关 |
| `agent.ts:812` | `_createStepSaveFn()` | 每 step 保存整份 session 的写放大路径 |
| `agent.ts:1474` | `captureRuntimeSnapshot()` | 总是调用 `context.toJSON()` 的核心根因 |
| `agent.ts:1485` | `restoreRuntimeSnapshot()` | Context + Feature + usage 恢复 |
| `agent.ts:1502` | `commitCallCheckpoint()` | 普通 checkpoint registry |

### 27.4 AgentDev：Step checkpoint

| 文件 / 位置 | Symbol | 重要性 |
|---|---|---|
| `D:/code/AgentDev/src/core/checkpoint.ts:21` | `createStepCheckpoint()` | 内存 step snapshot |
| `checkpoint.ts:31` | `rollbackToStepCheckpoint()` | step 异常恢复 |
| `D:/code/AgentDev/src/core/agent/react-loop.ts:100` | create call site | 每步建立 |
| `react-loop.ts:506` | rollback call site | 异常时恢复 |

### 27.5 AgentDevClaw：Session 生命周期

| 文件 / 位置 | Symbol | 重要性 |
|---|---|---|
| `D:/code/AgentDevClaw/server/shared/constants.js:17-29` | storage roots | 用户数据物理分层 |
| `server/routes/session-helpers.js:812` | `archivePrebuiltSession()` | 证明 archive 当前只是 index flag |
| `server/routes/session.js:278` | `/protoclaw/sessions/branch` | 直接解析与重写 session schema，v2 高风险点 |
| `server/routes/session.js:320` 附近 | source checkpoints | 直接依赖 rollbackHistory |
| `server/routes/session.js:350` 附近 | runtime checkpoint selection | Branch Feature/usage 时间线选择 |
| `server/routes/session.js:378` 附近 | branch context construction | 手工截取 messages/enrichedMessages |
| `server/routes/session-search-index.js:29` | search index path | 派生全文读模型 |
| `server/routes/session-search-index.js:141` | indexed text | session 内容的搜索投影 |

### 27.6 AgentDevClaw：Rollback 与 partial compact

| 文件 / 位置 | Symbol | 重要性 |
|---|---|---|
| `D:/code/AgentDevClaw/scripts/runtime-summary.js:353` | `rollbackToCallAndSave()` | 产品层普通回退 + 持久化 |
| `runtime-summary.js:420` 附近 | `triggerPartialCompact()` | summary-before-rollback 流程 |
| `runtime-summary.js:461` | rollback call | partial compact 依赖普通回退 |
| `runtime-summary.js:480` 附近 | summary injection/fallback | 两种 Context 表示一致性风险 |
| `scripts/run-prebuilt-agent.js:293` | `compact_from_call` | UI/runtime action 注册 |
| `scripts/run-prebuilt-agent.js:691` | session save wiring | checkpoint/rollback barrier 保存 |

### 27.7 AgentDevClaw：Logical envelope 与 named checkpoint

| 文件 / 位置 | Symbol | 重要性 |
|---|---|---|
| `D:/code/AgentDevClaw/server/call-arbiter.js:313` | `_runEnvelope()` | 多 physical onCall segment 的逻辑任务边界 |
| `call-arbiter.js:376` | `_checkpointBarrier()` | named checkpoint 后等待保存 |
| `call-arbiter.js:397` | `_rollbackBarrier()` | named restore 后等待保存 |
| `call-arbiter.js:412` | `_injectContinuationSystemMessage()` | 详细 internal system projection |
| `call-arbiter.js:449` | checkpoint continuation input | synthetic user projection |
| `call-arbiter.js:458` | rollback continuation input | synthetic user projection |

### 27.8 AgentDevClaw：Group chat 投影

| 文件 / 位置 | Symbol | 重要性 |
|---|---|---|
| `D:/code/AgentDevClaw/server/routes/group-chat.js:548` | `appendGroupChatMessage()` | 群聊事实持久化 |
| `group-chat.js:2443-2473` | dispatch construction | contextText 与实际消息分离投递 |
| `local-features/group-admin/src/bridge.ts:62` | `onCallStartHook()` | 空闲路径 system context 注入 |
| `bridge.ts:93` | `onStepStartHook()` | busy buffer/catch-up 注入 |

### 27.9 需要一起阅读的历史设计记录

| 文档 | 价值 |
|---|---|
| `docs/plans/2026-06-15-agent-checkpoint-rollback-continuation-design.md` | logical envelope、barrier、外部副作用、被否决的 live-stack rollback |
| `docs/plans/2026-06-18-context-mutation-session-integrity-investigation.md` | message history ≠ call history；handoff/branch/auto-save 完整性 |
| `docs/plans/2026-06-18-rollback-compact-diagnostic-notes.md` | rollback/partial compact 调用链与历史排障 |
| `docs/investigations/2026-06-17-session-index-performance-investigation.md` | session 写模型与 index 读模型分离；旧结论适用范围 |
| `docs/audits/session-runtime-state-audit.md` | session file、index record、workspace state、managed runtime 分层 |
| `docs/investigations/2026-05-22-compact-product-semantics-mismatch.md` | exploration summary 与 handoff context 的产品语义差异 |
| `docs/plans/context-compaction-successor-session-notes.md` | Raw Log / Runtime State / Prompt View 与 Exact Restore / Compacted Resume 区分 |

---

## 28. 最终设计决策摘要

### 已收敛

1. 普通 call rollback 使用 Context boundary，不再保存完整 Context。
2. boundary 分别保存 messages 与 enrichedMessages 长度。
3. 引入 generation/lineage 防止非追加 mutation 后误用旧边界。
4. Feature state、usage、callIndex 继续在每个普通 checkpoint 保存。
5. 当前 runtime 保留一个完整 Context。
6. v2 reader 支持 v1/v2/mixed；旧异常 checkpoint 保留 legacy full snapshot。
7. Named checkpoint 第一阶段保持完整 runtime。
8. Step checkpoint 不作为磁盘格式首要优化对象。
9. Branch 改为框架级 session transformation，Claw 不再自行解释内部 schema。
10. FileSessionStore 使用原子写、backup 与版本校验。
11. AgentDev 与 Claw 锁步发布，并阻止旧 runtime 打开 v2。
12. archive 仍是产品状态；warm/cold storage 作为后续独立层建设。

### 尚需实现前定案

1. generation 在合法 truncate 后是否保持，还是创建新的 branch generation。
2. usage rollback 是恢复累计值，还是另设不可回退的计费 ledger；当前兼容方案是恢复现有 snapshot。
3. branch cut 的正式边界只允许 call boundary，还是支持任意 message boundary。
4. named checkpoint 在普通 call rollback 后的保留/失效契约是否需要进一步收紧。
5. archive 后默认打开是 read-only inspect、hydrate current，还是强制 fork。
6. search 对 archived/cold session 的默认可见范围。
7. internal event metadata 是先进入 Message 扩展字段，还是建立独立 Raw Event Log。

---

## 29. 建议验收标准

当第一阶段根本修复完成时，应满足：

- 新普通 call checkpoint 不含完整 Context。
- 回退用户可见语义与当前一致：目标 call 及之后分支被切掉，draft 可恢复。
- Feature、usage、callIndex 与 Context 保持同一时间线。
- messages/enrichedMessages 不要求等长，但回退后各自正确。
- 合法 v1 会话可懒迁移；异常 v1 会话仍可通过 legacy fallback 回退。
- named checkpoint、step exception rollback、logical envelope 不发生语义倒退。
- partial compact 可在同一 session 中正确摘要、回退、注入、保存、重启。
- branch 由真实 E2E 证明可加载、继续并再次回退。
- 保存中断不会让唯一主 session 静默变成不可解析文件。
- 未知/未来 schema 被明确拒绝，不出现静默部分恢复。
- archive、file compression、cold storage、compact 在 API 和文档中不再混用。
- 所有 integrity diagnostics 不记录用户消息正文。

---

## 30. 最终结论

当前长期会话存储最值得优先修复的，不是某个目录、某种压缩算法或 JSON 缩进，而是普通 rollback 的表达模型。

用户提出的直觉是本次设计的正确起点：在同一线性会话中，普通回退应当是“找到过去边界并切掉后缀”，而不是“把过去每一个边界都保存成一整份会话”。框架当前保存完整 snapshot，是因为它复用了通用 runtime restore 能力；这种实现简单，但把线性前缀问题表达成了完整状态复制问题。

最干净、同时风险可控的修复是：

```text
一个当前完整 Context
+ 多个普通 call 边界
+ 每个边界自己的 Feature / usage / callIndex 状态
+ 少量无法安全迁移的 legacy full snapshot
+ 暂时保持完整的 named checkpoint
```

在此基础上，再分别建设：

- 原子 SessionStore；
- 框架级 branch/compact transformation；
- archive 的 warm/cold tier；
- search/handoff 的派生数据生命周期；
- internal control event 的 identity 与可重建投影；
- 最终可能的 Raw Log / Runtime State / Prompt View 正式分层。

这个顺序既解决最主要的结构性错误，也避免一开始就把所有会话能力重写成高复杂度事件系统。它保留了未来走向 segment DAG 和显式 Prompt View 的空间，同时让第一阶段可以被明确测试、渐进迁移和安全回滚。
