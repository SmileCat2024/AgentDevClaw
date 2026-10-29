# ADR 0035：正常输入与输入租约解耦——composer 单一 user-turn 通道

- 日期：2026-10-29
- 状态：Proposed
- 关联：[ADR-0031 后台工作与领域 Shell](0031-background-work-and-domain-shell.md)（sourceRef 输入身份）、[ADR-0032 编程小助手线程驱动](0032-programming-helper-thread-driven.md)（线程输入域）、[docs/reference/frontend-rendering-patterns.md](../reference/frontend-rendering-patterns.md)（输入面渲染契约）

## 背景与问题

前端存在两套几乎同构的消息提交编排：`persistent-input.js` 的 `submitQueuedInput`（POST `/user-turn`）与 `input-helpers.js` 的 `submitInput`（POST `/input` + requestId）。这不是一次设计的产物，而是历史叠加：

1. 2026-05-11 公开发布（`f9164f1f`）：只有回答式输入——agent 挂 input request，用户作答，提交 `/input` 回填。
2. 2026-05-24（`71400615`）：为支持 calling 期间排队发言，新增常驻输入框与 `/user-turn` 通道。原路径未退役。
3. 2026-07-04（`bd77df2d`）：两路径随 app-main.js 拆分固化为两个模块文件。此后每个横切功能（图片、会话引用、线程路由）都双写两遍。

概念错位的根源在宿主侧：`run-prebuilt-agent.js` 的 `runInputLoop` 在 agent 空闲时**常驻挂起一个文本 input lease** 等待输入（`getUserInputEvent`）。用户的"正常发言"在空闲时实际是**回填这个挂着 lease 的提问请求**；只有 agent 忙时（lease 不在场）才走真正的 user-turn 排队通道。同一个用户行为在两套协议间按 agent 状态自动翻转，工单 036 的 composer 常驻化让翻转在视觉上无缝，用户无法感知——但代码里它始终是两份。

事故实证（2026-10-28，三层连续缺陷）：线程域图片方言不匹配（服务端 400 "text must be non-empty"）之后，前端两个入口的线程直投分支各漏一处图片桶清理（缩略图滞留、残留图重复带出）。三层缺陷全部发生在双写拷贝区。

## 决策

### 1. 输入通道语义三分，各归其位

| 通道 | 语义 | 承载 |
|---|---|---|
| `/user-turn`（经 server `deliverUserInput` 网关） | 对话轮次：真人主动发言 | 空闲直投、calling 排队、线程域路由；图片、会话引用、能力激活随行 |
| lease 应答（`/input` + requestId） | 对挂起请求的回应 | choice 选择（`ask_user_choice` 工具，call 中挂起）、rollback / compact 操作决策（宿主 actions 回填） |
| viewer 邮箱（queue-input） | 排队与机器通报 | reminder / resume kind、消费循环（`passiveMailboxLoop`） |

**正常输入只走 user-turn**。lease 协议专职请求应答，不再被宿主 inputLoop 挪用为空闲期的正常输入通道。

### 2. composer 不再按 lease 翻转端点

输入面九级优先级矩阵中第 7 级 `requests` 模式退役：composer 恒为 persistent 形态、恒经 `submitQueuedInput` 提交。空闲、排队、线程三态的**端点与协议仲裁**由 server 网关与 viewer 完成（前端不感知协议切换）；线程域的即时拦截判定（交接窗口改投 Thread Inbox 的即时暂存反馈）仍在前端 `submitQueuedInput` 内，server input-gateway 是兜底真相，两者不冲突。`submitInput` 的文本提交编排（`_submitInputInner`）随之退役。

requests 渲染管道上挂着两条与"回答请求"无关的伴生反馈，随模式退役迁移到 persistent 渲染主干（前端内搬移，协议不动）：**输入动作失败提示**（rollback / compact 执行失败原因随下一次 lease actions 广播，`_notifyLeaseActionError` 原在 `renderRequestComposer` 内触发）改为 lease 到达即查；**草稿回填**（宿主 `setNextDraftInput` 经下一轮 lease `initialValue` 回传的 rollback 草稿，`user-input/index.ts` `initialValue: request.initialValue ?? nextDraftInput`）改为 persistent composer 按 requestId 去重回填，仅当前无草稿时写入，不覆盖用户已输入内容。

**协议层零新增**：viewer `submitUserTurn` 已内置三段式路由——choice lease 挂起时 409（`input_mode_conflict`）；文本 lease 挂起时自动转换为该 lease 的应答（`delivery: 'input'`，`createTextInputResponse` 保留 images / capabilityActivations / metadata / sourceRef 全字段）；无 lease 时入邮箱排队（`delivery: 'queued'`）。本决策只是把前端的通道选择从 `/input` 切到 `/user-turn`，对宿主 inputLoop 完全透明（它收到的应答形态不变）。

### 3. lease 协议保留，三个既有消费者不动

- **宿主 `runInputLoop`**：零改动，照常在空闲时挂文本 lease。空闲发言经 `/user-turn` 由 viewer 回填给它，行为等价。这是**终态定性**：空闲常驻 lease 不是待治理的欠账——mailbox 路线会同时失去 actions 通道（rollback / compact）、`setNextDraftInput` 草稿回传与 `/exit` 会话关闭语义，属结构性不可替代；三段式路由落地后常驻 lease 对前端完全透明，不再产生外部复杂度。后续不再规划 inputLoop 退役。
- **choice 卡**（`choice-input.js` 独立渲染面）：不动。`UserInputFeature` 工具面只有 `ask_user_choice`，它已是"提问归属工具卡"的正确形态。
- **rollback / compact 操作**：继续以 actions 挂在空闲 lease 上（`getNextTurnActions`），前端 `rollback-dialog` 经 `submitInputAction` 走 `/input` 回填。这是合法的请求应答语义（宿主请求用户决策），不迁移到独立 IPC。

### 4. choice 挂起时的 409 兜底

choice lease 挂起期间提交 user-turn 会被 viewer 拒绝（409 `input_mode_conflict`）。矩阵第 5 级 choice 模式优先接管输入面，正常路径下用户没有发言入口，409 只出现在弹出竞态窗口；前端将 409 转为"请先完成选择"提示，不静默失败。choice 接管时 composer 仅隐藏不销毁，竞态窗口用户已敲的文本与附件原地保留，choice 完成后可继续编辑发送。

## 不做清单（显式边界）

- 不改框架（AgentDev）、宿主（`run-prebuilt-agent.js`）、server 协议——三段式路由已存在。
- 不建设"文本提问工具卡"——`UserInputFeature` 没有文本提问工具，choice 卡已覆盖全部工具提问。
- 不迁移 rollback 到独立通道——lease actions 是合法请求语义，迁移是复杂度转移而非减少。
- 不动 `.protoclaw-boot.mjs` 引导路径（`getUserInput` 一次性引导输入）。
- 不做双端点共享编排的"适配器统一"——被本方案取代：单通道后无从共享。

## 依据与实施入口

- viewer 三段式路由：`AgentDev/packages/viewer/src/viewer-worker.ts` `submitUserTurn`（choice 409 / lease 回填 / 邮箱排队）。
- 宿主 inputLoop 与 actions：`scripts/run-prebuilt-agent.js` `runInputLoop` / `getNextTurnActions` / `runtime-summary.js` `handleInputResponse`。
- server 网关：`server.js` `/api/agents/:agentId/user-turn` → `deliverUserInput`（线程域路由已在 ADR-0032 语境落地）。
- 前端退役面：`public/src/modules/input-composer.js`（`resolveInputSurfaceMode` 第 7 级、`readInputSurfaceModeState` 的 `hasRequests` 状态源、`applyComposerMode` requests 分支与 lease footer——footer 因动作过滤契约恒空，无功能损失）、`input-render.js` requests 分支（签名函数、渲染分支、`renderRequestComposer`）、`input-helpers.js` `_submitInputInner` 与 `_submitInputViaThread`（仅被前者调用）、`voice-input.js` requests 提交分支与 `_shouldPreserveVoiceInputForRender` 的 `'requests'` 枚举项（`submitInputAction` / rollback 查询纯函数保留）。
- 测试迁移：`test/frontend-input-composer.test.js`、`test/frontend-input-convergence.test.js` 的 requests 模式断言；行为锁定新增"composer 恒 persistent 端点"。

## 被否决的替代方案

- **双端点共享编排（适配器）**：保留 requests 端点，抽取公共提交逻辑注入端点差异。只减拷贝，概念错位仍在；模式翻转、双 UI 反馈、双测试面全部保留。被"单通道"取代。
- **回答走 user-turn + 服务端自动关联 requestId**：消灭 lease 回填语义，但要求框架重设计 UserInputFeature 回填路径与等待态并发语义，跨两仓库，收益不抵风险。
- **宿主 inputLoop 退役，全走邮箱消费**：`passiveMailboxLoop` 确能承载空闲输入，但会同时失去 lease 的 actions 通道（rollback）、`setNextDraftInput` 草稿回填与 `/exit` 会话关闭语义，复杂度从前端转移到宿主，不是净减少。

## 后果

- 双提交编排消灭：`_submitInputInner` 约 260 行退役，横切功能（图片、引用、线程）不再双写；2026-10-28 事故类别（双写漏改）整体消失。
- 模式翻转及其附属复杂度消失（端点切换、绑定切换、placeholder 切换、焦点/IME 保持的翻转边界）。
- 空闲发言的服务端路径变化（`/input` 回填 → `/user-turn` 转 lease 回填）：对 inputLoop 透明，但排查输入问题时需知道新路径。
- requests 渲染管道上的两条伴生反馈（输入动作失败 toast、lease `initialValue` 草稿回填）迁移到 persistent 渲染主干，语义不变；lease 广播（`input-requests` 事件与 `inputRequests` 快照）继续作为其载体。
- `inputRequests` 快照数据保留（rollback 按钮可见性、choice 卡渲染仍消费），仅 composer 不再据此切模式。

## 验收条件

- 场景回归全绿：空闲直投发言、calling 排队、choice 问答、rollback / compact 操作（含失败提示与草稿回填）、图片（两入口合并后的唯一入口）、语音输入（persistent 路径）、线程域（PH / coder）、memo 唯一活动线程。
- 空闲发言（lease 回填路径）的反馈等价性逐项锁定：乐观回显、action button 切 calling 态、立即轮询触发（`submitQueuedInput` else 链已覆盖，断言测试固化）；输入动作失败 toast 与 rollback 草稿回填在 persistent 渲染主干可达。
- `submitInput` 文本路径、requests 模式分支删除后全库无残留引用（`submitInputAction` 除外）。
- 既有 requests 断言测试完成迁移；新增行为锁定：空闲态（lease 挂起）提交走 `/user-turn` 且收到 `delivery: 'input'` 回执。
- choice 挂起竞态窗口的 409 呈现为可理解提示，且用户已敲文本未丢失。

## 代价与实施

前端中型重构，以删除为主。分阶段实施计划见 [docs/plans/2026-10-29-input-channel-decoupling.md](../plans/2026-10-29-input-channel-decoupling.md)：① composer 端点统一与测试迁移（行为切换）；② requests 模式与翻转逻辑退役（删除）；③ 观察窗口后清理残骸。
