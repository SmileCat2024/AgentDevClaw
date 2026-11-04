# ADR 0041: 标题属于 Session，生成策略属于应用

- 日期：2026-11-04
- 状态：Accepted（1–5 步已实施；编程小助手 / coder / memo 均已迁移）
- 关联：[ADR-0026 Session 视图统一](0026-session-view-identity-and-data-sources.md)、[ADR-0032 编程小助手线程驱动](0032-programming-helper-thread-driven.md)、[ADR-0025 coder 升格](0025-coder-workspace-promotion.md)、[ADR-0024 APP 型工作空间](0024-app-workspace-eternal-thread-model.md)、[ADR-0034 模型选择 Feature 化](0034-feature-owned-model-selection.md)

## 背景与问题

当前会话标题由 Claw 统一生成，编程小助手只是消费方。实现分三段：

- 前端 `public/src/modules/auto-title.js` 在消息轮询里比对前后快照，据此判断哪些会话该生成标题；
- 服务端 `POST /protoclaw/generate_session_title` 拉起 `scripts/run-title-mirror.js` 子进程；
- 子进程用固定提示词（`scripts/mirror-runtime.js` 的 `TITLE_RULES`）、固定模型角色（`system`）、固定上下文范围（最近 32 条消息 + 首条用户消息）调用模型，结果写回会话索引。

这套机制有三个结构性问题，都与"谁拥有策略"有关：

1. **标题文本被当成业务状态。** 前端用 `^新对话\d+$` 判断"还没有标题"、用 `/^（/` 判断"这是衍生会话"；服务端 `selectEmptySessions` 也用 `^新对话\d+$` 判断"这是空会话、可清理"。同一段展示文案同时承担展示与业务条件，标题格式一变，三处业务行为一起变。

2. **策略硬编码在 OS。** 提示词、模型角色、上下文范围都固定在 Claw 里，应用没有任何入口调整。想做更贴合自身语境的标题，只能改 Claw。

3. **触发是轮询的副产品。** 生成时机由消息数组的变化与 assistant 消息计数基线推导，既不是轮次结束事件，也不是应用意图；用户观察到的"时机莫名其妙"由此而来。

在应用化方向（工作空间可插拔、Claw 提供 OS 能力）下，标题策略应当是应用的行为，而不是 OS 的隐式默认。

## 决策

### 1. 标题是 Session 的持久属性，Thread 不持有标题

- 会话标题属于 Session 索引记录，是唯一权威。
- 线程宿主工作空间的列表行显示**当前 head Session 的标题**，接续换头后自然跟随新 head。
- Thread 记录中的 `title` 字段**保留但停止写入、停止消费**：不迁移、不清理，现存值不再影响任何产品行为。它不构成新的产品概念，也不被扩展成契约。

### 2. 标题状态结构化，不再由文案推导

Session 索引新增 `titleState`，取值：

| 值 | 含义 | 产生方式 |
|---|---|---|
| `placeholder` | 尚未起名，显示占位 | 创建会话时写入 |
| `auto` | 由应用生成策略写入 | 生成能力成功落盘 |
| `user` | 用户手动改名 | 改名端点写入 |

规则：

- 所有"是不是新会话""是不是衍生会话"的判断改读 `titleState`，不再匹配标题文本。
- 空会话清理条件改为"`titleState=placeholder` 且无消息"，不再用 `^新对话\d+$`。
- 占位文案（如"新对话 N"）是纯展示值，不作为业务输入。占位编号的计算只扫描 `titleState=placeholder` 的记录——这些文案由系统自己写入、格式自有，解析它不构成"用文案推断业务状态"；用户标题永远不参与该解析。
- 历史记录缺 `titleState` 时按"已有标题但来源未知"处理，不猜它是占位还是用户标题；此类记录不参与自动生成，除非应用显式请求。

### 3. 能力归 OS，策略归应用

Claw 提供两类能力，都不包含"该不该生成"的判断：

- **按会话生成**：输入目标 Session 身份、提示词规则、模型选择、上下文范围；OS 负责读取会话内容、调用模型、校验结果并落盘。
- **直接写入**：应用自行得到标题文本，OS 只校验身份、授权、长度与非法字符，然后落盘。

同时提供：

- **轮次生命周期事件**：以明确 `agentId` / `sessionId` / 轮次号报告开始、完成、失败、取消、挂起等事实，供应用订阅。事件只报告事实，不触发标题生成。
- **官方样板策略**：把当前这套做法整理成可装配、可整体替换的参考实现（默认"首轮完成生成一次"，采用事件订阅）。

Claw 不做的事：不规定跨应用统一的提示词、长度或风格；不在应用未声明策略时自动套用样板；不依据标题文本推断会话状态。

### 4. 接续与分支的标题规则

| 场景 | 新 Session 的标题 |
|---|---|
| 全新对话 | 占位标题（`titleState=placeholder`），等待应用策略 |
| 精简 / 摘要接续 | 继承来源标题，不附加任何前缀 |
| 分支 | 继承来源标题，保留"（分支）"前缀 |
| 回滚 | 不变 |

停止在接续路径上生成"（精简）""（摘要）"前缀。存量标题不改写：前缀与用户手写文本无法可靠区分，批量处理会误改用户内容。

接续与分支继承标题时一并继承 `titleState`：来源是占位则新会话仍是占位，来源是用户改名则新会话仍受用户接管保护，来源是自动生成则可继续被应用策略更新。

### 5. 生成写入的并发与覆盖保护

- 生成请求携带目标 Session 身份；结果落盘前校验该 Session 仍存在、`titleState` 仍为可覆盖状态。
- 用户在其间改名（`titleState=user`）时，迟到的生成结果必须丢弃，不得覆盖。
- 生成失败不影响会话创建、接续、对话进行与列表展示；标题是辅助能力。
- 应用卸载不删除已有标题；Claw 通用会话界面仍可展示与手动改名。

### 6. 迁移范围：生产对话的应用全部迁移，壳层旧触发硬屏蔽

- 编程小助手、coder、memo 三个产生对话会话的应用均已迁移（metadata 声明 `titlePolicy: 'app'`，装配 `AutoTitlePolicyFeature` 并转交轮次事件总线）。
- 壳层 `public/src/modules/auto-title.js` 的旧触发**保留代码但硬屏蔽**：`isShellTitleTriggerDisabled()` 恒返回 `true`，三个对外入口与真正发请求的生成函数都在副作用之前直接返回。
- 为什么不是"只对未声明应用生效"的兜底：那样等于让漏装配的应用静默回落到壳层，形成第二套触发链路——同一会话可能被两条链路各起一次名，而且问题只在标题里显现，不容易被发现。屏蔽必须是无条件的，新增对话型应用要自己装配 `AutoTitlePolicyFeature`。
- 为什么保留代码而不删除：这段逻辑记录着历史上"何时起名"的判断依据（首个 assistant 回复、前台/后台会话、缺索引快照时延后判定），是理解旧行为的参照。保留它的前提是入口全部不可达，且由 `test/frontend-auto-title-legacy-disabled.test.js` 守住这个前提。
- 不要把它改成配置项或 `window` 开关：那会让"屏蔽"重新变成可被误用的扩展点。恢复壳层触发必须是一次可见的代码改动。


## 现状锚点

以下是改造涉及的当前位置（以代码为准确认，不是已完成声明）：

| 环节 | 位置 | 现状 |
|---|---|---|
| 候选判定与触发 | `public/src/modules/auto-title.js` | 比对消息快照与 assistant 计数，用 `^新对话\d+$`、`^（` 判断候选 |
| 生成入口 | `server/routes/session.js` 的 `POST /protoclaw/generate_session_title` | 拉起子进程，不接收提示词与模型参数 |
| 生成实现 | `scripts/run-title-mirror.js`、`scripts/mirror-runtime.js` | 固定 `TITLE_RULES`、`system` 模型角色、最近 32 条 + 首条用户消息 |
| 改名 | `server/routes/session.js` 的 `PUT /protoclaw/prebuilt_sessions/:sessionId/title` | 直接写标题与 `updatedAt`，不记录来源 |
| 空会话清理 | `server/routes/session-helpers-pure.js` 的 `selectEmptySessions` | 用 `^新对话\d+$` 判定可清理 |
| 占位编号分配 | `server/shared/session-access.js` 的 `computeNextSessionNumber` | 扫描同归属会话的标题，匹配 `^新对话(\d+)$` 取最大编号 +1 |
| 接续前缀 | `server/routes/session-handoff-helpers.js` | 生成"（摘要）""（精简）"前缀 |
| 分支前缀 | `server/routes/session.js` 分支创建 | 生成"（分支）"前缀 |
| Thread 标题写入 | `server/thread-control/thread-integration.js`、`thread-routes.js` | 建线时写入，创建接口接收 `title` |
| Thread 标题消费者 | `coder-shell`、`session-reference`、`acp.js`、`sidebar-snapshot.js`、`coder-threads-ui.js`、`runtime-status.js`、`agent-connected.js` | 部分以 `headSessionTitle` 优先、`thread.title` 兜底，部分直接读 `thread.title` |

## 实施顺序

每一步直接迁到目标契约，不建立双读双写。

1. **状态结构化**：Session 索引加 `titleState`，创建 / 改名 / 生成三条写入路径设置对应值；把前端与 `selectEmptySessions` 的文本判断全部替换为读 `titleState`。此步不改变标题生成时机，只移除"用文案推导状态"。
2. **能力收口**：把生成逻辑从路由内联流程抽成可复用服务端能力（参数化提示词、模型、上下文范围），补充直接写入能力；保留既有远程转发语义与幂等要求。
3. **事件面**：把现有内部 `turn.*` 事件扩成应用可订阅的轮次事件面，带会话身份与终态区分。
4. **策略下放**：编程小助手以装配方式接入新能力（触发时机、提示词、模型由应用声明），并停止走旧的前端轮询触发；壳层旧触发对已声明应用让位。同时提供官方样板实现。三个应用迁移完成后，壳层触发改为无条件硬屏蔽（见"迁移范围"）。
5. **接续与展示收口**：接续停止生成前缀；列表与各消费者改为只读 head Session 标题，停止消费 Thread `title`。

## 实施记录

| 步骤 | 状态 | 落点 |
|---|---|---|
| 1 状态结构化 | 已实施 | `titleState` 三态；`session-access.js` 占位编号、`session-helpers-pure.js` 空会话清理、前端候选判定均改读字段 |
| 2 能力收口 | 已实施 | `server/shared/session-title-service.js`（生成 / 直接写入）、`title-text.js`（规范化单一实现）；路由只保留身份、转发、幂等与响应封装 |
| 3 事件面 | 已实施 | `server/shared/turn-event-bus.js`；`run-prebuilt-agent.js` 在 `CallArbiter` 回调处广播，与上报链解耦 |
| 4 策略下放 | 已实施 | `local-features/auto-title-policy`（官方样板）；编程小助手 / coder / memo 均装配并声明 `titlePolicy: 'app'`；前端旧触发硬屏蔽（`isShellTitleTriggerDisabled()` 恒真） |
| 5 展示收口 | 已实施 | 接续停止前缀（分支保留）；Coder 面板 / 侧栏 / CLI / ACP / memo / 会话引用改读 head Session 标题 |

**壳层旧触发的处置**：三个对话型应用迁移完成后，壳层 `auto-title.js` 的触发不再作为兜底启用，而是无条件硬屏蔽。代码保留作历史参照，但入口全部不可达，由 `test/frontend-auto-title-legacy-disabled.test.js` 守住。


## 验收不变量

- 任意时刻，会话标题只有一个权威来源：Session 索引记录。
- 任意时刻，"是否占位 / 是否用户改名"由 `titleState` 判定；除占位编号的计算外，任何业务分支不匹配标题文本。
- 标题格式变化（含占位文案、是否带前缀）不改变任何业务行为。
- 用户手动改名的标题不会被后台自动生成覆盖；用户显式重新生成时可以被更新。
- 接续换头后，列表行标题来自新 head Session，不出现双标题回退。
- 壳层不自动发起标题生成：无论会话状态如何、应用是否声明 `titlePolicy`，Web 壳层的轮询路径都不产生标题请求。
- 用户显式发起的标题操作（会话右键「生成标题」、标题栏生成按钮）不受上述屏蔽影响——它们是用户指令，不是后台自动行为。
- 标题生成失败不阻塞会话生命周期，也不产生悬挂子进程。


## 不做清单

- 不批量改写存量标题（无法可靠区分系统前缀与用户输入）。
- 不删除 Thread `title` 字段，也不做数据迁移；只停止写入与消费。
- 不为所有应用统一提供标题设置界面；策略归应用。
- 不改动线程状态机、接续事务语义、消息存储格式。
- 不为标题时效引入额外主动刷新机制。

## 后果

**正面**：标题从"OS 猜应用意图"变为"应用声明策略、OS 提供能力"；文案与业务解耦后，标题格式可以独立演进；接续不再制造括号前缀与双标题回退，列表标题单一来源。

**代价**：需要改动前端触发链路、服务端生成路径与多个 Thread 标题消费者（Coder 面板、CLI、会话引用、ACP、侧栏快照等），并新增 `titleState` 字段的历史兼容处理。

**风险与失效条件**：

- 若 Thread `title` 的某些消费者实际把它当作与"对话标题"无关的业务字段，必须先厘清其用途再停止写入，不能简单改读 head Session 标题。
- 若应用接入成本过高，样板会被复制粘贴而非复用，重新退化为多套实现；官方样板的接入复杂度是本设计的实际成败点。
- 若新增对话型应用漏装配 `AutoTitlePolicyFeature`，它会完全没有自动标题（壳层已硬屏蔽，不再兜底）。这是有意的取舍：静默兜底会形成两条触发链路，问题只在标题里显现；漏配的代价则是显式的——标题保持占位，一眼可见。应用开发模板需把装配列为必需步骤。


## 关联

- [ADR-0026](0026-session-view-identity-and-data-sources.md)：会话标题的权威所有权归 Session，本 ADR 沿用并补齐状态字段。
- [ADR-0032](0032-programming-helper-thread-driven.md)：列表行 = 对话，显示当前 head 的标题；本 ADR 明确该标题的生成与更新权责。
- [ADR-0025](0025-coder-workspace-promotion.md)：身份即归属；Thread 不承担标题语义。
- [ADR-0034](0034-feature-owned-model-selection.md)：应用持有选择与策略、Agent 持有实际运行状态的分层先例，本 ADR 对标题采用同一思路。
