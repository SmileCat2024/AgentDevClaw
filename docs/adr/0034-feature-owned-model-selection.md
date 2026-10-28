# ADR 0034：模型选择由 Feature 管理，运行模型与宿主资产保持分层

- 日期：2026-10-28
- 状态：Accepted（已实施：AgentDev `a176c6a` + AgentDevClaw `a18d5fdf`；凭证刷新编排收编进本 Feature，见决策 6a）
- 关联：[ADR-0009 模型热切换](0009-model-hotswap-framework-api.md)、[ADR-0018 Feature-Panel 通信](0018-feature-panel-communication-transport.md)、[ADR-0028 凭证恢复与分层判据](0028-credential-recovery-and-layering-criteria.md)、[ADR-0002 会话连续性](0002-session-continuity-as-transformation.md)、[ADR-0011 远程写适配](0011-protoclaw-remote-write-adaptation.md)、[ADR-0032 编程小助手线程驱动](0032-programming-helper-thread-driven.md)

## 背景

输入框允许用户切换模型和思考强度。线程接续会创建新的 Agent 实例，当前切换仅改变旧实例的运行模型，没有成为随 Session 快照与 continuity 迁移的选择状态，因此接续后重新采用启动配置。

这不是缺少正式模型切换能力：ADR-0009 已提供 `setModel`、`setThinkingEffort` 和模型元数据版本。现有路径是输入框调用 Claw 专用 swap 路由，经专用 IPC 由宿主调用框架接口。已下线的模型轮转 Feature 也能调用这些接口，但它没有选择持久化，且到 StepStart 才获得 Agent 引用，不能直接满足启动恢复要求。

本次目标是把模型选择作为一个完整、可装配的 Feature：选择意图、恢复策略与对外交互集中在同一处，而不是只给专用 IPC 补一个模型名文件。Claw 仍提供专用输入框控件；本次不建设通用输入框插件机制。

## 决策

### 1. 三类状态各有唯一权威

| 所属层 | 负责什么 | 不负责什么 |
|---|---|---|
| 模型选择 Feature（Claw 本地 Feature） | 用户明确选择的模型、思考强度覆盖、恢复与回退策略、面向控件的状态与操作 | 不保存凭证、LLM 客户端或整份 preset，不成为实际运行模型的第二权威 |
| AgentDev 框架 Agent | 正式切换接口、实际生效模型及 `modelRevision`、初始化和恢复生命周期语义 | 不读 Claw 配置文件，不认识 `__default__` 的产品含义或某个工作空间 |
| Claw 宿主 | 预设和凭证资产、resolver 实现、运行时启动与就绪、通信寻址、输入框呈现 | 不平行持有用户模型选择，不按模型 Feature 名称编排恢复 |

Feature 优先复用 `captureState` / `restoreState` 和 continuity 自声明；不新增线程模型配置文件，不改全局或工作空间启动配置来模拟会话持久化。

控件显示的“当前模型”取 Agent 的实际模型状态。Feature 的选择意图与恢复失败原因单独呈现；回退后不能继续把原选择显示为已生效。

### 2. 继承与恢复是显式产品语义

| 场景 | 模型与思考强度选择 |
|---|---|
| 同一对话停止后重开、服务重启后恢复 | 恢复保存的选择 |
| 自动接续、手动 trim/summary 等连续性变换 | 继承源对话选择；新实例首个模型请求前完成恢复 |
| 从历史边界创建分支 | 继承源对话的**当前**选择，不回退到边界快照中的历史选择；此后两个对话独立 |
| 真正创建全新对话 | 无会话覆盖，遵循原有启动配置 |
| 当前对话回滚内容（包括检查点回滚） | 保留当前模型选择和思考强度，不随内容撤销 |

模型选择是随对话链传递的当前状态：回滚与分支都不从历史边界恢复它，链上改变选择的只有用户明确改选和恢复失败回退。分支继承取源对话当前值，不是边界快照里的历史值；实现上禁止以宿主 / server 读取 Feature 私有快照字段的方式达成，具体传递机制（continuity 声明或恢复来源语义）在文件级方案定形。

只持久化用户明确的覆盖；未覆盖部分继续遵循启动配置或模型预设。模型选择变化不复制历史用量，也不清零用量。

思考强度状态必须区分“没有覆盖”和“显式值”，并与框架支持的显式 `null` 语义对齐；不能用 truthy/falsy 归一化丢失选择。具体请求 schema 与控件“默认”文案需在实施方案中明确，避免把预设默认与供应商默认混为一谈。

### 3. 回退只发生在恢复选择失败时

- 手动切换失败：保留原选择和实际模型，报告失败，不触发默认回退。
- 恢复保存选择失败（例如 preset 不存在、客户端构造所需凭证缺失）：明确提示原因，回退到 Claw **全局默认模型**，不是任意工作空间的启动 preset。
- 全局默认也不可恢复：启动明确失败，不继续寻找其他模型，不作为空白新会话运行。
- 回退后保留原选择；下次实例恢复再次尝试，当前实例不后台自动切回。用户明确重新选择后，以新选择为准。
- 模型已恢复，但实际请求限流、网络失败或认证失败：仍走现有错误处理和凭证恢复，不因此自动切换供应商或模型。
- 凭证刷新是同一选择下的客户端实例轮换，不得把 `credential-refresh` / `auth-recovery` 当成用户改选。

恢复“成功”指解析与应用选择成功，不宣称已通过一次真实供应商请求验证。

### 4. 框架提供通用初始化与恢复能力

Feature 应在初始化阶段取得窄的模型控制接口，复用 Agent 正式方法，不等待首轮对话，不读取 Agent 私有字段。

恢复入口应明确传递本次操作的语义。启动恢复、continuity 导入、回滚、热重载状态迁移不能靠 Feature 内“此前是否调用过 restoreState”猜测。恢复上下文需要贯通框架 checkpoint、Session 恢复、continuity 包装及宿主导入；旧 Feature 不消费新增上下文时保持原有行为。

`onHostRequest` 从 Claw duck-typing 约定沉淀为框架类型契约；HTTP、IPC、通道声明和认证仍属于宿主，不搬入 core。

这两类能力以通用生命周期语义设计，不在框架中识别模型选择 Feature。确切接口名称、调用顺序及错误传播在实施前定形，本 ADR 不把尚未实现的接口描述为现有能力。

### 5. 恢复成功是可执行与可保存的前提

宿主启动需要区分：创建实例、恢复状态、允许执行。已保存模型可用而启动默认模型不可用时，不能在恢复前因默认模型构造失败而失去恢复机会。

因此启动方案必须满足：

1. 保存选择有机会在首个模型请求前生效；不先用默认模型运行一步再切换。
2. 所有必要恢复完成前，不接受外部变更或进入输入消费；READY 必须代表恢复已成功。
3. 区分“没有快照”和“读取/恢复失败”。后者不得由 catch 转成创建新会话。
4. 恢复失败后的资源清理不能把半恢复实例保存回原 Session，覆盖原快照。
5. 失败不提交 successor 为线程 head，复用既有接续 READY 提交约束。

是否通过框架显式延迟模型绑定等方式实现，需完成接口评审；禁止用假 LLM 客户端、吞错或宿主读取 Feature 私有快照字段绕过此问题。本次不依赖尚未实施的 ADR-0033 journal 方案。

### 6. 交互统一走 Feature 通信，远程降级为不可操作

输入框仍是 Claw 专用控件，但选择状态和控制请求经既有 feature-comms 交互；是否可操作以 Feature 装配和就绪事实为准，不维护工作空间 ID 白名单。

- 模型预设目录继续由 Claw 资产接口提供；实际模型仍从 Agent 元数据呈现。
- 使用精确会话和运行时身份；切换会话后的迟到回执必须被视图代次拒绝，模型版本只在同一实例内比较。
- 通道投影不是持久化真相；丢事件或重连后通过请求面重新对账。
- 远程会话不保持模型切换：本次不为远程 feature-comms 投入适配，不制定旧端兼容期。远程会话的模型入口按通道不可达自然降级为不可操作，不报未处理错误；Feature 不认识远程连接。
- 降级不放开安全边界：模型切换请求不得静默落到本机执行；declare/publish 保持 runtime 内部认证。
- 不能在 Feature 通道失败后悄悄改走旧 swap 以掩盖错误。

### 6a. server 发起的凭证刷新走同一请求面（修订）

ADR-0028 修订一的凭证变更推送（重登 / 换 key / OpenCode 换档后运行中会话同 preset 重 resolve）原为宿主专用 IPC 分支，随本 ADR 收编：server 经 feature-comms 请求面广播（fire-and-forget 保持），由模型选择 Feature 的 `refresh-credentials` 请求类型承接。语义边界：凭证轮换是同一选择下的实例轮换（决策 3），不写选择状态、不写快照；档位按当前运行 meta 原样透传（键含显式 null 即透传）。宿主不再持有模型编排语义；未装配本 Feature 的 runtime 由宿主通用分支回 operation_unavailable，自然降级。

### 7. 接续期间的禁用必须有服务端保证

正常工作中允许切换，不取消已发出的模型请求，后续模型请求使用新实例。接续期间拒绝新切换，不把操作排队给未知 successor。

前端禁用控件只负责呈现。宿主准入、接续挡板和 runtime 关闭保存屏障必须共同保证：已接纳的变更完成后再捕获迁移快照；挡板后的新变更明确拒绝；成功回执不能只改到一个不会进入 successor 快照的旧实例。单次检查线程状态后再异步投递存在竞态，不能当作完整方案。

通道请求的“已应用”和“已持久化”也必须区分。现有请求后去抖补存及退出最终保存可复用，但不能把应用成功回执表述为已经落盘；写盘失败的处理与用户可见性应在实施方案中明确。

### 8. 统一迁移现有消费者，移除重复业务实现

迁移全部现有提供模型切换的工作空间，而非只修编程小助手。实际消费者以装配和输入框渲染链路为准；工作群独立 composer、只读 Test Runtime、隐藏 workspace、非 prebuilt 宿主需分别核实，不因目录存在就自动增加控件。

迁移后移除专用 swap 业务链路及活性引用，含其远程转发路由；不设兼容适配期，不保留两套选择权威或两套切换实现。凭证刷新、预设管理和模型元数据投影仍保留各自职责。

## 依据与实施入口

以下是当前实现的调查入口，不是代码已完成的声明：

| 领域 | 权威位置与已确认事实 |
|---|---|
| 模型能力 | AgentDev `packages/core/src/core/agent.ts`、`types.ts`：已有正式模型切换、resolver 和版本元数据 |
| 初始化与恢复 | AgentDev `packages/core/src/core/feature.ts`、`checkpoint.ts`、`agent.ts`：初始化上下文尚无模型控制面；Session 与回滚共享状态恢复入口 |
| 连续性包装 | AgentDev `packages/core/src/core/continuity/participant.ts`；Claw `local-features/continuity-participant/src/index.ts`、`server/context-continuity/feature-continuity.js`：新增恢复上下文必须穿透包装与导入 |
| 启动与保存 | `scripts/run-prebuilt-agent.js`：先 resolve 启动模型再构造 Agent，loadSession 的 catch 目前转新会话；Feature 请求后去抖补存，退出等待 host 请求和最终保存 |
| 资产解析 | `server/model-preset-resolver.js`：全局默认已具名 `__default__`，可复用现有 resolver 别名 |
| 通道 | `server/routes/feature-communication.js`、`server/feature-communication-store.js`、`local-features/shared/src/feature-communication.ts`、`public/src/modules/feature-communication.js` |
| 输入框 | `public/src/modules/input-model-switcher.js`、`session-view-state.js`、`model-preset-cache.js`；刷新入口在 `app-main.js`、`agent-data-loader.js`、`input-render.js` 等 |
| 分支 | `server/routes/session-branch.js`：现状从完整历史边界取得对应 Feature 状态，不混合当前状态与历史消息；模型选择需改为从源对话当前值传递（见决策 2） |
| 接续与准入 | `server/thread-control/thread-rotation.js`、`thread-integration.js`、`server/shared/session-operation.js`：准入与挡板存在，但完整切换/接续互斥方案尚需定形 |
| 远程 | `server/shared/remote-forward.js`、`request-target.js`、`operation-target.js`、`server/remote-connections/remote-auth.js`；现有 swap 转发在 `server/routes/model-config.js`，随旧链路退役 |
| 装配 | `prebuilt-agents/official/*/agent.js`；尤其 `flow-workspace` 有构造期自解析路径，不能直接套统一启动假设 |

新增本地 Feature 接入 `local-features/index.ts`、`local-features/tsconfig.json`，沿用现有构建和 Node 测试体系。框架实现与测试修改在相邻 AgentDev 仓库，不改 node_modules 副本。

## 被否决的替代方案

- **给宿主 swap 补一份线程模型文件**：只修重置现象，留下选择业务与 Feature 快照的双份权威。
- **直接恢复旧模型轮转 Feature**：轮转策略与用户选择职责不同，且缺少初始化控制面和持久化。
- **在 StepStart 才恢复**：打开对话时显示与实际选择不一致，无法满足启动就绪语义。
- **Feature 靠首次 restore 标记判断回滚**：热重载、连续性包装和多次恢复都会使调用次数失去语义。
- **所有恢复异常都回退或新建**：掩盖损坏快照与装配错误，可能覆盖历史。
- **请求失败自动切任意可用模型**：改变成本、能力与供应商，不属于本次授权。
- **为模型选择先建通用输入框插件协议**：本次只需要一个实际消费者，不提前建设通用 UI 扩展体系。
- **分支回退到边界快照的历史选择**：与"回滚保留当前选择"对同一历史节点给出矛盾语义（回滚保当前值、分支取历史值）；模型选择是链级当前状态，不随历史边界回退。

## 验收条件

- 新建、重启、自动/手动接续、历史分支、普通/命名/step 回滚分别验证，不能以单个快照往返测试替代。
- 默认不可用而保存选择可用时能够恢复；保存选择失败时提示并回退全局默认；两者皆失败时不 READY、不消费输入、不覆盖原快照。
- 回退仍保留原选择，下次实例恢复再次尝试；运行认证刷新不改选择意图。
- 运行中切换不打断在途请求；切换与接续竞态以可控屏障测试两个先后次序，不用 sleep 猜时序。
- 本地、只读、未装配 Feature、旧 runtime 回执、视图离开再返回、同实例乱序更新均有验证；远程会话模型入口降级为不可操作。
- 历史分支继承源对话当前选择，不取边界快照中的历史选择。
- 快照不含凭证或客户端；持久化失败不伪报已落盘。
- 旧专用链路及活性文档引用清理完整；有兼容适配时明确适用版本与退出条件。
- 测试使用隔离数据目录和假模型，不读取真实用户凭证，不依赖真实供应商服务。

## 代价与实施

改造跨越 AgentDev 通用生命周期与 Claw Feature/宿主/UI，不能只改一处输入框请求。应先完成框架契约，再实现 Feature 和宿主接入，最后迁移消费者与退役旧链路；不趁机重构无关领域。

实施前待闭环的五项（初始化接口与恢复来源、连续性二次 restore 兼容、通道同步与远程降级、接续原子性、消费者清单与思考强度契约）已全部定形于文件级实施方案：[docs/plans/2026-10-28-model-selection-feature-implementation.md](../plans/2026-10-28-model-selection-feature-implementation.md)（含接口签名、调用时序、跨仓库落点、消费者装配清单、思考强度两态契约、退役步骤、测试路线与现状代码锚点）。现有定向基线覆盖模型版本呈现、通道、分支、保存屏障和框架恢复；新增行为按本 ADR 验收条件在实施中补测。
