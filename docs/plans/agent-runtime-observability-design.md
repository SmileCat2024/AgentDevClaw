# Agent Runtime Observability 设计与问题审计

更新日期：2026-06-06

本文档用于沉淀这次围绕 Agent 对话左上角实时状态、Anthropic 工具调用显示缺失、模型 API 连接与重试反馈缺失等问题的完整分析，并给出一套面向 AgentDev + AgentDevClaw 长期演进的全新设计。

这不是一次局部 bug 修复记录，而是一份面向框架、宿主、前端三层协作边界的设计文档。目标不是补一批 if/else，而是把“模型在做什么、框架在做什么、用户现在该看到什么”彻底分层。

---

## 1. 这次调研的结论先行

当前问题不是单一的 Anthropic 适配器问题，也不是单一的 Claw 前端显示问题，而是三类问题叠加：

- 模型适配器输出的是 provider 风格的碎片事件，不是稳定的跨 provider 运行态语义。
- AgentDev 框架没有把 LLM、工具执行、重试、连接、call 生命周期收敛成一套统一状态机。
- Viewer / Claw 前端只能消费“最后一条瞬时状态”，因此天然会出现丢帧、覆盖、卡住、闪没、无语义反馈。

从长期看，主责层必须放在 AgentDev 框架，而不是 Claw UI。Claw 应该消费统一协议，而不应继续承担状态推理器。

---

## 2. 重要观察与现状问题

### 2.1 左上角状态条当前依赖的是瞬时 notification，而不是稳定快照

Claw 当前通过轮询 `/api/agents/:id/notification` 获取状态，前端消费的核心逻辑在：

- `public/src/app-main.js`
- `../AgentDev/src/core/viewer-worker.ts`
- `../AgentDev/src/core/notification.ts`

其中最关键的事实是：

- `ViewerWorker` 只保存一份 `session.currentState`
- 新的 state notification 到来时会直接覆盖旧值
- `/notification` 只返回这份最新状态，而不是完整运行态快照

这会导致：

- 短生命周期状态极易被覆盖
- 一个阶段刚显示就被另一个阶段顶掉
- 前端只能根据最后一条状态猜“现在是不是还在忙”

### 2.2 Anthropic 的“工具调用中”在 UI 上天然会断层

Anthropic 当前的执行链路是：

1. LLM 流式输出 thinking / content / input_json_delta
2. Anthropic 适配器发 `llm.char_count`
3. 流结束时发 `llm.complete`
4. ReAct loop 才开始真正执行 tool calls

现状关键点：

- `Anthropic` 适配器在流结束时会主动发 `llm.complete`
- Claw 前端收到 `llm.complete` 后会立即隐藏状态条
- `ToolExecutor` 当前没有发 `tool.start` / `tool.complete`

于是用户看到的就是：

- 思考中
- 工具调用中
- 状态条消失
- 工具其实还在执行，但前端没有反馈

这不是单点 bug，而是 “LLM 流结束” 与 “call 结束” 被混淆了。

### 2.3 `tool_calling` 现在几乎没有真实进度含义

Anthropic 对 `input_json_delta` 的处理当前会把 phase 标记为 `tool_calling`，但：

- `charCount` 增量是 `0`
- notification payload 只包含 `phase + charCount`
- `toolCallCount` 虽然在适配器内部有，但没有进入前端协议

这意味着 UI 只能显示：

- “工具调用” 这个标签
- 一个不增长的数字

从用户体感上，这和卡死几乎没有区别。

### 2.4 连接、重试、退避等待在框架中有实现，在前端中几乎不可见

当前 AgentDev 已经具备：

- 指数退避与 jitter
- `Retry-After` 解析
- 连接错误分类
- SSL / DNS / timeout / 429 / 529 等区分
- 全局 undici keep-alive 与代理支持

但这些状态目前基本停留在框架内部，前端看不到：

- 当前是否正在重试
- 第几次重试
- 还要等待多久
- 是连接失败、超时、限流还是服务过载

结果就是：

- 用户只能看到一个停住的数字
- 不能区分“真的卡死”和“正在等待上游恢复”

### 2.5 状态轮询与消息轮询被绑在一起，慢接口会拖住状态反馈

Claw 当前在一次 `Promise.all` 中同时拉取：

- messages
- notification
- connection
- input requests
- overview

其中任意一个变慢，notification 更新就跟着慢。于是：

- 状态条刷新延迟不是由状态本身决定
- 而是由一组混合接口里最慢的那个决定

这也是“状态像卡住”的重要原因。

### 2.6 usage 与左上角状态条不是同一语义源

目前至少存在两套不同性质的数据：

- `notification`：过程态、瞬时态、覆盖式
- `overview`：累计快照、上下文统计、usage 汇总

而前端展示上又经常把它们理解成一类“当前进度”。这会导致：

- 顶部状态条和 usage 面板不一致
- thinking/tool calling 过程里面板数字明显滞后
- 用户分不清哪些是“实时”，哪些是“事后”

---

## 3. 问题本质：哪一层出了问题

### 3.1 不是单独的 UI 层问题

如果只在 Claw UI 里加判断，可以短期缓解 Anthropic 的显示问题，但无法解决：

- OpenAI 后续 reasoning/tool call 扩展
- 连接 / 重试 / timeout 反馈
- 不同 provider 的阶段语义统一
- 状态被覆盖和丢帧

所以 UI 不是主责层。

### 3.2 不是单独的 provider adapter 问题

Anthropic 只是把问题暴露得更明显。未来 OpenAI 一旦继续接入：

- reasoning delta
- responses 风格阶段
- parallel tool calls
- 更复杂 usage

同样会遇到状态语义不统一的问题。

所以不能把方案写死在 Anthropic 适配器里。

### 3.3 主责必须落在 AgentDev runtime / framework core

只有框架 core 同时知道：

- LLM 调用阶段
- 工具执行阶段
- retry / transport 状态
- call 生命周期
- interrupt / rollback / subagent 等运行时事实

因此，长期方案必须由 core 定义统一运行态协议，provider 只负责翻译，UI 只负责展示。

---

## 4. 新设计目标

### 4.1 目标一：统一“当前正在发生什么”的事实来源

系统需要有且只有一套“当前运行态”定义。

这套定义必须回答：

- 当前 call 是否仍在活跃
- 当前处于哪个大阶段
- 当前是否在执行工具
- 当前是否在重试或等待上游
- 当前有哪些可展示的进度指标

### 4.2 目标二：区分“事件流”和“状态快照”

必须把两类东西分开：

- 事件流：记录发生过什么
- 状态快照：回答此刻是什么状态

不能继续让 `/notification` 只返回“最后一条事件样式的 state”，再让前端自己推理当前状态。

### 4.3 目标三：provider 差异只能停留在 adapter 层

Anthropic 和 OpenAI 的差异应该通过 adapter 翻译成统一事件，而不是把 provider 特例一直向上泄漏到 UI。

### 4.4 目标四：工具执行与重试必须成为一等运行态

真正让用户焦虑的通常不是“字符数有没有涨”，而是：

- 现在到底卡在模型还是工具
- 是在重试还是在等待
- 还能不能中断

因此：

- tool execution
- retry waiting
- transport failure

必须进入统一状态模型。

---

## 5. 全新分层设计

### 5.1 第一层：LLM Adapter 输出“统一阶段事件”

provider adapter 的职责应该是：

- 解析 provider 原始流事件
- 提取 usage
- 提取 tool call 构建过程
- 提取 retry / transport 层错误
- 翻译为统一的 LLM 事件

它不应该负责：

- 决定前端状态条何时隐藏
- 决定工具执行阶段如何展示
- 决定 call 是否完成

建议统一事件语义包括：

- `llm.stream.started`
- `llm.phase.changed`
- `llm.delta`
- `llm.tool_call_building`
- `llm.stream.completed`
- `llm.retry.scheduled`
- `llm.retry.started`
- `llm.retry.exhausted`
- `llm.transport.failed`

Anthropic / OpenAI 都走同一套翻译面。

### 5.2 第二层：AgentDev Runtime 维护统一状态机

框架 core 应该把来自 LLM、ToolExecutor、call lifecycle 的事实汇总成单一状态机。

建议状态机至少包含这些大阶段：

- `idle`
- `llm_thinking`
- `llm_content`
- `llm_tool_call_building`
- `awaiting_runtime`
- `tool_executing`
- `retry_waiting`
- `retry_requesting`
- `completed`
- `failed`

同时保留结构化字段：

- `callActive`
- `charCount`
- `thinkingChars`
- `contentChars`
- `toolCallCount`
- `activeToolNames`
- `activeToolCount`
- `retryAttempt`
- `maxRetries`
- `nextRetryDelayMs`
- `lastErrorType`
- `lastErrorMessage`
- `updatedAt`

注意：

- `llm.complete` 只表示“本次 LLM 流结束”
- 不等于 “整个 call 完成”
- 只有 runtime 才有资格判断是否已经进入 `completed`

### 5.3 第三层：Viewer / Claw Host 存储“运行态快照 + 事件流”

ViewerWorker 不应只保存：

- `currentState`

而应同时保存：

- `runtimeState`
- `events`
- `logs`

建议接口语义：

- `/api/agents/:id/notification`
  返回当前运行态快照，兼容携带最近 state
- `/api/agents/:id/overview`
  返回上下文统计、usage 汇总、当前 runtime 快照
- 事件流接口后续可独立扩展，不再让 UI 依赖“最后一条 state”

### 5.4 第四层：Claw UI 只消费统一协议

Claw 前端只应负责：

- 展示当前阶段
- 展示关键进度指标
- 展示等待原因

不应继续负责：

- 推理 provider 阶段
- 根据 `llm.complete` 猜 call 是否结束
- 把 `charCount` 当成完整运行态

建议 UI 展示模型：

- 阶段：思考中 / 生成中 / 组织工具参数 / 执行工具 / 重试中 / 已完成
- 进度：thinking chars、content chars、tool calls、active tool、elapsed
- 健康：连接、retry attempt、等待时长、错误类型

---

## 6. 协议草案

### 6.1 Runtime Snapshot 草案

```ts
type RuntimeStage =
  | 'idle'
  | 'llm_thinking'
  | 'llm_content'
  | 'llm_tool_call_building'
  | 'awaiting_runtime'
  | 'tool_executing'
  | 'retry_waiting'
  | 'retry_requesting'
  | 'completed'
  | 'failed';

interface AgentRuntimeSnapshot {
  stage: RuntimeStage;
  callActive: boolean;
  charCount: number;
  thinkingChars: number;
  contentChars: number;
  toolCallCount: number;
  activeToolNames: string[];
  activeToolCount: number;
  retryAttempt?: number;
  maxRetries?: number;
  nextRetryDelayMs?: number;
  lastErrorType?: string | null;
  lastErrorMessage?: string | null;
  updatedAt: number;
}
```

### 6.2 Notification Response 草案

```ts
interface NotificationStateResponse {
  state: Notification | null;
  runtime: AgentRuntimeSnapshot;
  callActive: boolean;
  hasNewEvents: boolean;
}
```

### 6.3 Overview Snapshot 草案

```ts
interface AgentOverviewSnapshot {
  updatedAt: number;
  context: AgentContextMetrics;
  usageStats: UsageStatsSnapshot;
  runtime: AgentRuntimeSnapshot;
}
```

---

## 7. 建议的改造顺序

### 7.1 第一批：先立统一运行态骨架

第一批只做最关键的底座：

- 在 AgentDev 类型层引入 `AgentRuntimeSnapshot`
- ViewerWorker 持久维护 runtimeState
- `/notification` 和 `/overview` 返回 runtime
- ToolExecutor 发 `tool.start` / `tool.complete`
- Claw 前端消费 runtime，而不是只看 `state.type`

这一批的目标不是一次完成所有设计，而是先消除：

- Anthropic 工具执行空窗
- `llm.complete` 过早隐藏状态条
- 左上角状态只会显示字符数而不会显示真实阶段

### 7.2 第二批：接入 retry / transport 状态

把以下状态提升为 UI 可见：

- 正在重试
- 等待限流恢复
- 连接超时
- DNS 失败
- SSL 失败
- 服务过载

### 7.3 第三批：让 adapter 输出更丰富的结构化增量

包括但不限于：

- thinkingChars
- contentChars
- toolCallCount
- provider stop reason
- provider usage 增量

### 7.4 第四批：优化 UI 表达和历史诊断

包括：

- 更清晰的顶部状态文案
- 更有语义的健康提示
- 事件流调试面板
- provider 无关的统一监控视图

---

## 8. 向后兼容与影响面

### 8.1 对 AgentDev 的影响

- 类型定义会扩展
- `notification` 语义会从“瞬时状态”逐步变成“事件输入 + 快照辅助”
- `viewer-worker` 的 session 结构会扩展
- `tool-executor` 需要显式参与状态协议

### 8.2 对 Claw 的影响

- `app-main.js` 状态条逻辑需要从“看最后一条 state”改成“看 runtime snapshot”
- `app-ui.js` 的 overview normalization 需要保留 runtime 字段
- 未来顶部状态条会更像“运行态监视器”，而不是“字符计数器”

### 8.3 对 Anthropic / OpenAI 适配器的影响

- 适配器职责会更清晰
- provider 差异被压缩在 adapter 内
- 后续 OpenAI 深入接入时，不需要再重写 UI 语义

---

## 9. 当前实现建议与边界

### 9.1 当前这轮实现应优先做什么

- 统一 runtime snapshot 类型
- 让 tool execution 进入可见状态
- 避免 `llm.complete` 直接让状态条消失
- 让前端优先消费 runtime，而不是消费最后一条 state

### 9.2 当前这轮不必一次做完什么

- 不必一次性改成 SSE 或 WebSocket
- 不必一口气重写完整日志面板
- 不必一次性把所有 retry 细节全部 UI 化

第一轮最重要的是把“状态事实来源”立住。

---

## 10. 一句话总结

这次暴露出来的不是“Anthropic 的工具调用不显示”这么简单，而是 AgentDev 当前缺少一套跨 provider、跨 runtime 阶段的统一可观测性协议。

长期正确的方向是：

- provider adapter 负责翻译
- framework core 负责汇总为统一状态机
- viewer / claw host 负责存储与分发快照
- UI 负责展示，不负责推理

只有这样，Anthropic 当前的问题能真正收敛，未来 OpenAI 的扩展也不会把同样的问题再重演一遍。
