# 执行手册 2：RuntimeInbox 与 CallEnvelope 地基搭建

> 适用对象：擅长抽象数据模型和兼容层的 agent
> 优先级：高
> 前置条件：建议等待第 1 份文档完成并合入
> 目标：引入统一调用请求与运行时输入队列模型，但不在这一轮强行替换所有入口

---

## 这份文档解决的根问题

当前系统里，“向 agent 发起一次调用”至少有三种来源：

1. Viewer / 常驻输入框
2. `dispatch`
3. IM 门户输入

这些来源目前没有共享统一的数据模型。于是：

- `dispatch` 认为自己投递的是 schedule message
- Viewer 认为自己维护的是 queued inputs
- runtime 认为自己只是在被不同地方直接 `onCall()`

这会让后面的“唯一调用入口”难以落地。所以这一份文档的目标不是改行为，而是先铺一个统一抽象层。

---

## 允许修改的文件

首选：

- [server.js](D:/code/AgentDevClaw/server.js)

如确有必要，可新增一个本地模块文件，例如：

- `server/dispatch-runtime-inbox.js`
- `server/runtime-call-envelope.js`

也可以仍然先写在 `server.js`，但如果你觉得新增小模块能显著提升可读性，可以做。

不要主动修改：

- `node_modules/agentdev/**`
- `scripts/run-prebuilt-agent.js`
- `local-features/dispatch/src/index.ts`
- `prebuilt-agents/official/qqbot/agent.js`

---

## 目标产物

你需要在代码里明确引入两个概念。

### 1. CallEnvelope

代表“一次真实调用请求”。

推荐字段：

- `id`
- `runtimeKey`
- `agentId`
- `sessionId`
- `source`
- `sourceRef`
- `text`
- `createdAt`
- `status`
- `deliveryMode`
- `replyPolicy`
- `result`
- `error`

你不需要一次把所有字段都用起来，但结构要留下来，后续文档会接着用。

### 2. RuntimeInbox

代表“某个 runtime 当前待处理的统一输入队列”。

最简可接受形式：

- 一个内存 Map：`runtimeKey -> CallEnvelope[]`

更好的形式：

- `runtimeKey -> { queue, activeEnvelopeId, updatedAt }`

注意：
- 这不是替换 `dispatchQueue` 的终局版
- 但你至少要让后续 agent 可以在这个基础上迁移 dispatch / Viewer / IM

---

## 强约束

1. 本轮不要求切掉旧 `dispatchQueue`。
2. 本轮不要求让 ViewerWorker 直接改用新 inbox。
3. 本轮不要求真的让 arbiter 接管 `onCall()`。
4. 但你必须让新模型已经“可被调用”，而不是只写文档不落代码。

换句话说，这一轮要做的是：

**把未来的新通路建出来，并给旧逻辑留兼容桥。**

---

## 推荐实现步骤

### 第 1 步：定义 envelope 创建函数

建议新增一个小工厂函数，例如：

- `createCallEnvelope(params)`

要求：
- 负责生成统一 id
- 规范化 `runtimeKey`
- 补齐 `createdAt` / 初始状态

推荐 `source` 值集合：

- `dispatch`
- `viewer-input`
- `queued-input`
- `qq`
- `weixin`
- `system`

### 第 2 步：定义 runtime inbox 的最小管理函数

建议至少有：

- `ensureRuntimeInbox(runtimeKey)`
- `enqueueRuntimeEnvelope(envelope)`
- `peekRuntimeEnvelope(runtimeKey)`
- `dequeueRuntimeEnvelope(runtimeKey)`
- `getRuntimeInboxSnapshot(runtimeKey)`

要求：
- 都是纯 runtime 层语义，不夹带 dispatch 专属概念
- 函数名要清晰，后续 agent 一看就知道能复用

### 第 3 步：给 dispatch 建一个兼容桥

目标：
- 即使 dispatch 目前还保留旧 `dispatchQueue`，也要能额外产出 envelope

建议：
- 在 dispatch fire 路径里生成 `CallEnvelope`
- 把 `scheduleId` 写进 `sourceRef`
- 把 `envelopeId` 回写到 schedule 上

你这一轮不一定要改“真正投递走向”，但至少要让 schedule 和 envelope 建立关联。

### 第 4 步：定义 runtime 状态快照结构

这一步不是完整状态机实现，而是给后续 arbiter 准备接口。

建议增加一个轻量的 runtime state 容器，例如：

- `runtimeExecutionState`

至少能表达：

- 当前是否有 active envelope
- 队列长度
- 最后更新时间

如果你愿意，可以提前放入：

- `status: ready|queued|running|idle`

但这一轮不强求完全接管旧的 `dispatchRuntimeActivity`。

### 第 5 步：补最小观测接口

后续 agent 需要快速确认 inbox 是否在工作，所以建议你增加一个只读接口或调试输出能力。

选择之一：

1. 新增一个内部函数给后续代码调用
2. 新增一个轻量 API 只用于本地调试

如果新增 HTTP API，请只做只读查询，不要引入复杂管理端点。

---

## 设计要求

### 要求 A：旧逻辑继续可跑

即使你引入了 `CallEnvelope` / `RuntimeInbox`，当前已有 dispatch 功能和常驻输入功能也不能立刻被你搞坏。

### 要求 B：命名要像正式基础设施

不要用临时味太重的命名，如：

- `newQueue2`
- `dispatchTempMessages`
- `arbiterDraft`

请使用后续可以长期保留的命名。

### 要求 C：结构要为下一份文档留出入口

第 3 份文档会做 arbiter 迁移，所以你要给它留出清晰入口，例如：

- runtime inbox 的 enqueue / dequeue 函数
- envelope 状态更新函数

---

## 最低验收标准

完成后至少满足：

1. 代码中存在明确的 `CallEnvelope` 概念，不是停留在注释里。
2. 代码中存在明确的 `RuntimeInbox` 管理函数或对象。
3. `dispatch schedule` 可以与某个 `envelopeId` 建立关联。
4. 新模型引入后，旧功能仍可跑。
5. 你能说明下一位 agent 应该从哪里接入 arbiter。

---

## 手工验证建议

1. 创建一个 dispatch schedule，确认 fire 时会产生 envelope 记录。
2. 查询或打印某个 runtime inbox，确认其中能看到你入队的 envelope。
3. 原有 dispatch 消息投递不应因你引入新模型而中断。

---

## 你不要做的事

1. 不要在这里改写 `BasicAgent.onCall()`。
2. 不要在这里把 `ClawDispatchFeature` 改成直接消费 inbox。
3. 不要在这里接管 ViewerWorker 的 `queue-input` 端点。
4. 不要在这里动 IM 回显逻辑。

你的职责是：

**把“统一调用请求”和“统一 runtime 输入队列”的地基铺好，并确保后续 agent 能无痛接着干。**

