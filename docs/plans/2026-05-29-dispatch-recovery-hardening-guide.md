# 执行手册 1：Dispatch 恢复与状态机止血

> 适用对象：后端修复型 agent
> 优先级：最高
> 前置条件：无
> 目标：先把当前调度系统里最危险、最容易积累隐性脏状态的问题修掉

---

## 你要解决的不是“代码味道”，而是明确的线上风险

当前 `dispatch` 系统已经支持：

- `timer`
- `on-idle`
- `on-ready`
- `repeatInterval`
- `__latest__` 目标会话

但实现上仍是“把 schedule 触发后，直接推一条消息到 runtime 队列，再等 respond 回来补状态”。这导致两个事实源割裂：

1. 持久化 schedule 状态，保存在 `dispatch-schedules.json`
2. 运行时活动状态，保存在 `dispatchRuntimeActivity`、`dispatchIdleCheckers`、`dispatchTimers` 等内存结构

当前最危险的问题已知包括：

1. `__latest__` 解析后没有回写真实 sessionId，respond 阶段 activity key 写错。
2. server 重启后，`fired` 状态的 schedule 没有恢复路径，也没有超时失败路径。
3. server 重启后，已经过期的 timer schedule 会永久留在 `pending`。
4. 带循环的 `on-ready` 调度重启后失效。
5. `on-idle` 循环 fire 后依赖 respond 才能重新 arm，窗口太脆弱。

你这一份文档只负责先止血，不负责引入完整 `RuntimeInbox` / `CallArbiter`。

---

## 允许修改的文件

- [server.js](D:/code/AgentDevClaw/server.js)

如确实需要补文档，可额外更新：

- [docs/plans/dispatch-system-design.md](D:/code/AgentDevClaw/docs/plans/dispatch-system-design.md)

但不要主动改：

- `node_modules/agentdev/**`
- `local-features/dispatch/**`
- `scripts/run-prebuilt-agent.js`
- `prebuilt-agents/official/qqbot/agent.js`

---

## 核心上下文

重点阅读以下位置：

- 调度定时 / 事件 arm 逻辑：[server.js](D:/code/AgentDevClaw/server.js:243)
- `on-ready` 事件触发逻辑：[server.js](D:/code/AgentDevClaw/server.js:301)
- 单目标 fire 逻辑：[server.js](D:/code/AgentDevClaw/server.js:320)
- fire 总入口：[server.js](D:/code/AgentDevClaw/server.js:443)
- 启动恢复循环：[server.js](D:/code/AgentDevClaw/server.js:463)
- cancel 逻辑：[server.js](D:/code/AgentDevClaw/server.js:5301)
- respond 逻辑：[server.js](D:/code/AgentDevClaw/server.js:5342)
- agent status 上报：[server.js](D:/code/AgentDevClaw/server.js:5383)

---

## 施工目标

### 目标 A

确保 `__latest__` 一旦被解析，后续的 activity 更新、结果归档、循环 re-arm 使用的是同一个真实 runtime 标识。

### 目标 B

server 启动时，对所有 schedule 做统一恢复健康检查，不再只恢复 `pending + timer/on-idle`。

### 目标 C

任何 `fired` 状态都不能无限期存在。必须引入超时兜底，超时后转 `failed` 或 `cancelled`，并记录原因。

### 目标 D

已经过期的 timer 不能永久卡在 `pending`。要么立即 fire，要么明确标记取消，不允许沉默悬挂。

### 目标 E

循环 `on-ready` 调度在重启后仍要能继续生效，至少要重新挂回监听体系。

---

## 强约束

1. 不要在这一轮顺手引入大的抽象重构。
2. 不要把 schedule 数据结构搞成大范围破坏性变化。
3. 可以新增少量字段，但要保持兼容旧记录。
4. 如果新增字段，代码必须对旧 schedule 缺字段时安全退化。
5. 如果你引入阈值常量，请放在靠近 dispatch 相关常量的位置，命名清晰。

---

## 推荐实现步骤

### 第 1 步：给 schedule 增加最小必要的恢复字段

目标：
- 让一次 fire 能留下足够信息给 respond 和恢复逻辑使用

建议增加的字段，按需选用：

- `resolvedTargetSessionId`
- `resolvedRuntimeKey`
- `lastDispatchMessageId`
- `awaitingResponseSince`
- `lastError`

要求：
- 这些字段必须是“兼容新增”，旧 schedule 不存在时不能报错
- 多 target 情况下，若现阶段难以完全细分，也至少保证单 target 路径正确

### 第 2 步：修 `__latest__` 解析后的 key 错位

目标：
- fire 阶段一旦把 `__latest__` 解析成真实 sessionId，respond 阶段必须使用真实 runtime key

实现建议：
- 优先不要在 respond 时从 `targetSessionId` 反推 runtime key
- 在 `fireSingleTarget()` 或 `fireDispatchNow()` 里把“真实投递目标”回写到 schedule

最低验收：
- `targetSessionId === '__latest__'` 的 schedule，respond 后更新到真实 runtime activity，而不是 `agent::__latest__`

### 第 3 步：引入统一恢复 sweep

目标：
- 替换当前启动时只恢复少部分 `pending` schedule 的逻辑

实现建议：
- 抽一个独立函数，如 `restoreDispatchSchedulesOnBoot()` 或同等语义名字
- 对所有 schedule 按状态处理：
  - `pending`
  - `fired`
  - 如你新增了 `awaiting-response` 一类中间状态，也要处理

你至少要覆盖以下场景：

- `pending + timer + fireAt 在未来`
- `pending + timer + fireAt 已过期`
- `pending + on-idle`
- `pending + on-ready`
- `fired + 刚触发不久`
- `fired + 已超时`

### 第 4 步：给 `fired` 引入超时失败

目标：
- 避免重启前后积累永远不结束的 `fired`

建议：
- 设一个明确常量，例如 5 分钟
- 超时后将其标记为 `failed`
- `result` 或 `lastError` 里留下可读原因，比如：
  - runtime did not respond before timeout
  - server restarted while awaiting dispatch response

注意：
- 不要写得太复杂
- 当前阶段不要求“自动重试”，只要求“不死不活的 schedule 能结束”

### 第 5 步：处理过期 timer

目标：
- 过期 timer 不能永久 `pending`

你要二选一，但必须在提交结果里说明选择理由：

方案 A：
- 启动恢复时发现 timer 已过期，则立即 fire

方案 B：
- 启动恢复时发现 timer 已过期，则标记 `cancelled`

推荐倾向：
- 如果这条 schedule 表达的是“错过时间也应执行”，用 A
- 如果表达的是“只在那个时刻执行一次，错过就没意义”，用 B

由于当前系统更偏“未来续接任务”，我倾向你在实现时优先选择 A，但请自行评估现有产品语义并在结果里说明。

### 第 6 步：修复循环 `on-ready` 重启失效

目标：
- `on-ready + repeatInterval` 不能在重启后沉默

实现要求：
- 恢复阶段必须重新让此类 schedule 进入 ready 事件监听体系
- 不要求你在本轮重构出完整监听注册中心，但至少不能继续依赖“下次碰巧又手动启动 agent”

### 第 7 步：保证 `on-idle` 循环不要因一次 respond 缺失永久停摆

目标：
- 减少 fire 和 re-arm 之间过于脆弱的窗口

允许的轻量修法：
- 保持当前 checker 设计，但补上恢复和超时失败路径，避免 schedule 彻底僵死

不要求你在本轮彻底重写 `on-idle` 观测体系，因为那会和后续 runtime inbox / arbiter 强耦合。

---

## 最低手工验证清单

你至少要自己验证这些场景：

1. 创建一个 `targetSessionId='__latest__'` 的 schedule，触发并完成后，检查 activity 更新是否写到真实 runtime。
2. 创建一个 timer schedule，手工把 `fireAt` 改成过去时间，重启 server，确认不会永久 `pending`。
3. 让一个 schedule 进入 `fired`，模拟 runtime 不 respond，然后重启或等待，确认它会结束为 `failed` 或你定义的兜底状态。
4. 创建 `on-ready + repeatInterval` 规则，重启 server 后再启动对应 runtime，确认还能再次触发。
5. 原有普通 timer 调度、普通 on-idle 调度不能被你修坏。

如果能补自动测试更好；如果补不了，必须把你实际执行的手工验证步骤和结果写清楚。

---

## 提交结果格式

交付时请明确写出：

1. 修改了哪些字段和函数
2. 你为过期 timer 选择了“立即 fire”还是“取消”
3. `fired` 超时阈值是多少
4. 哪些问题已经确认修复
5. 哪些问题你故意没动，留给下一份文档处理

---

## 你不要做的事

1. 不要在这里直接改造 `ClawDispatchFeature` 去接入新队列。
2. 不要在这里改 `agentdev` 的 `onCall()` 执行模型。
3. 不要在这里处理 QQ / 微信回复机制。
4. 不要在这里顺手把前端调度台全面重写。

你的职责只有一句话：

**先把当前 dispatch 后端从“容易积累脏状态”修到“可恢复、可结束、可观察”。**

