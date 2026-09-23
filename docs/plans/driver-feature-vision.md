# Driver 作为系统级 Feature 的理念备忘录

> 本文档用于沉淀 AgentDevClaw / AgentDev 下一阶段关于“驱动”方向的理念、问题意识、判断依据与探索边界。
>
> 这不是一份详细实现设计，也不是通信机制的定稿规范。本文档的目标是帮助后续 agent 或开发者快速理解：
>
> - 为什么会提出“驱动”
> - “驱动”与现有 Feature 体系是什么关系
> - 当前代码里已经有哪些前兆
> - 为什么现在应该讨论方向，但不应该把 feature 间通信设计说死
> - 后续如果继续推进，应该重点观察哪些文件、文档和运行时边界

---

## 一、文档定位

这份文档的定位是“方向备忘录”，不是 RFC，也不是 API 设计稿。

它要回答的是：

- 在坚持 `feature is all you need` 的前提下，为什么还会提出“驱动”
- “驱动”到底想解决什么问题
- 这个想法和当前 Flow、Feature mode、系统级 feature、工具权限控制之间是什么关系
- 为什么我们更倾向于把它视为一种系统级 Feature 的演化，而不是另造一个产品层面的重抽象

它刻意不回答以下问题的最终细节：

- feature 之间通信应该精确暴露哪些 API
- event / service / capability 应该采用什么最终命名
- runtime 中如何调度、排序、仲裁各类跨 feature 调用
- 哪一种“驱动协议”应该成为唯一标准

这些问题都很重要，但现在阶段更重要的是先让方向、边界、判断依据和风险意识被沉淀下来。

---

## 二、当前项目背景

从当前仓库状态看，AgentDevClaw 的产品主线已经明确围绕 `flow-workspace` 展开，而不是停留在“若干预制 agent + 若干独立 feature”的松散集合。

可以优先阅读以下材料建立上下文：

- [AGENT.md](../../AGENT.md)
- [docs/reference/agentdev-claw-product-overview.md](../reference/agentdev-claw-product-overview.md)
- [docs/plans/flow-layer-design.md](./flow-layer-design.md)
- [docs/plans/flow-feature-mode-dual-surface-design-plan.md](./flow-feature-mode-dual-surface-design-plan.md)
- [docs/protocols/feature-metadata.md](../protocols/feature-metadata.md)

几个特别关键的现状：

1. 当前产品模型已经明确采用：

```text
Agent Project = Persona + Enabled Features + One Orchestration Graph + Runtime Sessions
```

见：

- [AGENT.md](../../AGENT.md)
- [docs/plans/flow-layer-design.md](./flow-layer-design.md)

2. Flow 已经不是一个外围补充能力，而是运行时与编辑器双侧都在持续扩张的主线。

关键入口：

- Flow 编辑器：[public/flow-editor.js](../public/flow-editor.js)
- Flow 运行时 Feature：[local-features/flow/src/index.ts](../../local-features/flow/src/index.ts)
- Flow-aware 基类：[local-features/flow/src/flow-aware-feature.ts](../../local-features/flow/src/flow-aware-feature.ts)
- Flow 类型：[local-features/flow/src/types.ts](../../local-features/flow/src/types.ts)
- Flow capability 聚合接口：[server.js](../server.js)

3. Feature 已经不只是“提供工具”。

在当前 AgentDev / Claw 语境里，一个 Feature 可能提供：

- tools
- async tools
- context injectors
- reverse hooks
- flow variables
- flow modes
- flow node templates
- manifest / static settings contract
- runtime state snapshot / restore

相关参考：

- [local-features/flow/src/flow-aware-feature.ts](../../local-features/flow/src/flow-aware-feature.ts)
- [local-features/feature-dev/skills/agentdev-feature-guide/references/foundation/feature-model.md](../../local-features/feature-dev/skills/agentdev-feature-guide/references/foundation/feature-model.md)
- [local-features/feature-dev/skills/agentdev-feature-guide/references/runtime/reverse-hooks-reference.md](../../local-features/feature-dev/skills/agentdev-feature-guide/references/runtime/reverse-hooks-reference.md)
- [node_modules/agentdev/src/core/feature.ts](../node_modules/agentdev/src/core/feature.ts)

也正因为这三点叠加，系统开始逼近一个新阶段：

> Feature 不再只是能力包，越来越多 Feature 已经开始承担系统底层通道、环境访问入口和运行时行为边界管理的角色。

这正是“驱动”概念被提出的土壤。

---

## 三、为什么会提出“驱动”

### 3.1 提出动机不是概念创新，而是现实演化

“驱动”这个想法，不是为了追求新的术语层，而是因为当前系统里已经出现了一类特殊 Feature：

- 它们不是单纯面向最终业务语义的
- 它们承担了其他 Feature 复用的底层能力
- 它们经常被多个 Feature 间接依赖
- 它们的状态、模式和限制，本身会影响整个 agent 的行为边界

最直观的例子有两个：

#### 例 1：shell

当前系统中，shell 明显不只是“一个工具集合”。

相关实现和使用痕迹：

- Shell feature 包：[node_modules/@agentdev/shell-feature/dist/index.js](../node_modules/@agentdev/shell-feature/dist/index.js)
- Shell 类型声明：[node_modules/@agentdev/shell-feature/dist/index.d.ts](../node_modules/@agentdev/shell-feature/dist/index.d.ts)
- 本地 feature-dev 对 shell 的依赖接口：[local-features/feature-dev/src/index.ts](../../local-features/feature-dev/src/index.ts)

`feature-dev` 已经把 shell 当成可复用底层通道来使用，而不是只把它当成“给 LLM 看的 bash 工具”。例如：

- 通过 `ctx.getFeature('shell')` 拿到 shell feature
- 假设它暴露一个 `run(command)` 风格的公开 API
- 基于这个 API 执行 build、pack、validate 等内部工作流

这说明系统内部已经在把 shell 当作一种“执行设备入口”使用。

#### 例 2：audio feedback

音频提醒最初的设计目标非常简单：在一次 call 完成后播放提示音。

但它现在已经具备了更多系统属性：

- 有 Feature manifest
- 有 Flow modes
- 有 Flow variables
- 有公开 runtime API（如 `setEnabled()`、`setVolume()`）
- 能被 Flow 在不同节点切换到不同模式

关键实现：

- [node_modules/agentdev/src/features/audio-feedback/index.ts](../node_modules/agentdev/src/features/audio-feedback/index.ts)

这意味着它虽然名字上还是 `audio-feedback`，但行为上已经开始像一个“音频能力控制器”。

### 3.2 更深一层的原因：系统中有一些能力天然会被复用

随着 Flow feature 打通和系统 feature 增多，以下能力几乎必然会被多个场景重复使用：

- shell / 命令行执行
- 音频播放
- TTS / 声音输出
- 外部通知
- 浏览器或视觉上下文
- 安全审计
- 状态持久化
- 外部事件监听

这些能力和普通业务 Feature 最大的区别在于：

- 它们更像宿主系统的“基础通道”
- 它们经常被其他 Feature 间接消费
- 它们的控制面不能只停留在“对外给几个工具”

因此，“驱动”想描述的不是一种新的运行时实体，而是一种新的观察视角：

> 某些 Feature 在系统中承担了类似底层驱动的职责。

---

## 四、驱动与 `feature is all you need` 的关系

### 4.1 驱动不是对 Feature 哲学的否定

这件事最需要避免的误解是：

> 一旦提出“驱动”，是不是等于要放弃 `feature is all you need`？

当前判断恰恰相反：

> “驱动”应该被理解为一种系统级 Feature，而不是 Feature 之外的新第一性实体。

也就是说：

- 我们仍然坚持 Feature 是能力单元
- 只是承认 Feature 内部会分化出不同角色
- 其中一类角色更接近系统基础设施

这和当前已有演化是相容的，因为代码里已经存在不同层级的 Feature：

- 业务 Feature
- 编排运行时 Feature
- 工作空间服务型 Feature
- 安全边界型 Feature
- 底层通道型 Feature

参考：

- [local-features/flow/src/index.ts](../../local-features/flow/src/index.ts)
- [local-features/feature-dev/src/index.ts](../../local-features/feature-dev/src/index.ts)
- [node_modules/@agentdev/audit-feature/dist/index.js](../node_modules/@agentdev/audit-feature/dist/index.js)
- [node_modules/agentdev/src/features/audio-feedback/index.ts](../node_modules/agentdev/src/features/audio-feedback/index.ts)

### 4.2 更准确的说法

相比“Feature 和 Driver 是两个并列系统”，当前更推荐的说法是：

```text
Driver is a system-grade feature role.
```

也就是：

- Driver 不是脱离 Feature 体系独立存在的
- Driver 是某类 Feature 的系统角色命名
- 这个命名更多用于帮助设计判断，而不是强行改变所有 runtime 接口

### 4.3 为什么不急着引入一个强感知的新顶层抽象

原因主要有三点：

1. 当前项目最稳定的核心概念仍然是 Feature 和 Flow  
2. 如果太早把 Driver 讲成新顶层对象，会增加团队心智分叉  
3. 当前代码里很多“驱动行为”已经是通过 Feature 接口暴露的，没必要先重写世界观

因此，更合适的推进方式是：

- 概念上承认驱动角色
- 代码上优先保持“系统级 Feature”落点
- 只有在真的出现持续稳定的通用 contract 之后，再考虑是否要提升概念显性程度

---

## 五、当前代码里已经出现的“驱动前兆”

这一节不是在宣称“驱动已实现”，而是在指出：仓库里已经有若干实现片段具备驱动雏形。

### 5.1 `FlowAwareFeature` 已经在推动 Feature 角色分层

`FlowAwareFeature` 的存在本身就说明 Feature 不再只是“给工具列表”。

它额外允许 Feature 暴露：

- `getFeatureManifest()`
- `getFlowModes()`
- `getFlowVariables()`
- `getFlowNodeTemplates()`
- `applyFlowMode()`
- `resetFlowModes()`

见：

- [local-features/flow/src/flow-aware-feature.ts](../../local-features/flow/src/flow-aware-feature.ts)

这意味着当前系统已经承认：

- Feature 对外可以暴露结构化配置契约
- Feature 可以有“模式”
- Feature 可以被外部运行时切换状态
- Feature 可以向 Flow 暴露状态投影

这是从“工具包”向“受控能力单元”迈出的关键一步。

### 5.2 Flow capability 聚合接口已经在消费这些高层契约

服务端的 `/protoclaw/flow_capabilities` 会基于当前启用 Features 去实例化能力并收集：

- tools
- variables
- node templates
- modes
- feature manifests

关键入口：

- [server.js](../server.js)

这进一步说明，系统已经在做的事情不是“枚举工具名”，而是“聚合 Feature 能力表面”。

这和驱动思路是同方向的：  
底层能力应该以结构化 capability 的形式被发现和消费，而不是只靠硬编码字符串。

### 5.3 `audio-feedback` 已经具备“设备控制器”气质

`audio-feedback` 当前不只是一个 `@CallFinish` 回调。

它还提供：

- manifest
- flow modes
- flow variables
- 公开的状态调整方法
- state snapshot / restore

见：

- [node_modules/agentdev/src/features/audio-feedback/index.ts](../node_modules/agentdev/src/features/audio-feedback/index.ts)

这就是一个很好的例子：

> 业务命名还是“提醒音”，但实现结构已经在向可复用、可受控的底层音频能力靠近。

### 5.4 `feature-dev` 已经把 shell 当成共享基础设施在用

本地 `feature-dev` 中显式定义了一个 `SharedShellFeature` 接口，并依赖 `ctx.getFeature('shell')`。

见：

- [local-features/feature-dev/src/index.ts](../../local-features/feature-dev/src/index.ts)

它体现了两件事：

1. 框架当前已经允许 Feature 之间通过公开 API 协作  
2. shell 已经被看作“其他 feature 可复用的底层执行入口”

虽然这里的 API 还没有标准化，但方向已经出现了。

### 5.5 `audit` 是当前“暴力实现”的代表样本

`audit` 当前通过 `@ToolUse` 拦截名为 `bash` 的工具调用，并直接向上下文注入审计拦截信息。

关键实现：

- [node_modules/@agentdev/audit-feature/dist/index.js](../node_modules/@agentdev/audit-feature/dist/index.js)

这个实现非常有参考价值，因为它明确暴露出当前体系的局限：

- 它知道的是工具名，不是“shell execution capability”
- 它耦合的是 hook 时机，不是显式能力协议
- 它向 `context` 注入的是结果消息，而不是通过正式通信原语表达副作用

因此，`audit` 既是问题样本，也是驱动方向的论据来源。

---

## 六、驱动想解决的不是“工具复用”，而是“系统基础能力的归位”

如果只从表面看，似乎驱动只是为了避免重复写工具。但这还不是核心。

更本质的问题是：

> 系统里有一类能力，已经不适合继续以“一个普通业务 Feature 内部顺手写点逻辑”的方式存在。

这些能力往往具备以下特征：

### 6.1 被多个 feature 消费

例如：

- shell
- 音频播放
- 外部通知
- 浏览器访问

如果每个上层 Feature 都重新定义自己的访问方式，系统会越来越依赖隐式约定。

### 6.2 自身拥有独立状态和模式

例如：

- 音量是否开启
- shell 是否允许执行某类操作
- 某个底层能力当前处于严格模式还是宽松模式

这些状态已经不是“某个工具内部小参数”，而是系统级行为边界。

### 6.3 需要同时被 Flow、Feature、runtime 感知

很多底层能力不能只被 LLM 工具调用看到，还需要：

- 被 Flow 编排看到
- 被 inspector / debugger 观察到
- 被其他 feature 读取或控制

### 6.4 容易成为政策、守卫、审计、通知的挂载点

例如 shell 执行前后，天然会吸引：

- audit
- logging
- metrics
- policy
- approval
- replay

这类能力如果没有更清晰的系统归位，会让越来越多 Feature 去抢 hook 和字符串匹配。

---

## 七、为什么现在不应该把 feature 间通信设计说死

这部分很重要，因为它决定了这份文档为什么是一份理念备忘录，而不是通信规范。

### 7.1 复杂度不会消失，只会转移

这个方向最值得警惕的地方，不是“有没有抽象”，而是“复杂度转移是否有效”。

当前系统的复杂度已经存在，只是很多是隐性的，散落在：

- `ctx.getFeature()` 互调
- hook 时机
- hook 顺序
- 字符串工具名
- `context.add()` 注入副作用消息
- Flow capability 与 runtime capability 的半对齐状态

如果我们直接引入一套厚重的通信协议，但没有减少这些旧复杂度，那么系统只会更复杂。

### 7.2 agent 业务太灵活，不适合过早冻结“设备分类”

传统操作系统里，“显卡”“声卡”“网卡”之类分类有较强稳定性。

但 AgentDev 场景里的能力边界明显更流动：

- 一个能力今天看起来像通知系统，明天可能变成 TTS、音频、警报统一出口
- 一个能力今天叫 shell，明天可能包含本地命令、远端执行、沙箱运行、脚本代理
- 一个能力今天是浏览器，明天可能还要和视觉、DOM、截图、外部页面状态合并

因此，当前阶段如果直接定义一套“驱动类型学”，风险很高：

- 可能很快过时
- 会过早冻结业务想象空间
- 反而让 Feature 灵活性受阻

### 7.3 真正值得先统一的是“交互形状”，不是“领域名称”

现在更应该被观察和提炼的，是这些能力之间如何交互，而不是先强行定义它们属于哪一类设备。

换句话说，真正稳定的很可能不是：

- 什么叫声卡
- 什么叫显卡
- 什么叫驱动类型 A / B / C

而更可能是：

- 一个 Feature 如何提供可复用能力
- 一个 Feature 如何暴露可读状态
- 一个 Feature 如何响应外部运行时切换
- 一个 Feature 如何被编排层引用
- 一个 Feature 如何被其他 Feature 安全地消费

这也是为什么本文档只讨论方向，不把通信机制写成定案。

---

## 八、当前更合理的判断：把驱动视为系统级 Feature 角色

基于上面的考量，当前更合理的落点是：

> “驱动”优先以默认挂载或高频挂载的系统级 Feature 角色出现，而不是明显的新顶层产品抽象。

### 8.1 为什么这个层级更稳

因为它能兼容现有系统的几个基本事实：

1. 现有 runtime 已经天然以 Feature 为装配单位  
2. Flow capability 聚合也天然以 Feature 为发现单位  
3. 调试器和 inspector 已经以 Feature 为展示单位  
4. Feature manifest / mode / variable 体系已经在长出来

也就是说，如果现在把驱动定义成“系统级 Feature”，现有基础设施能最大限度复用。

### 8.2 为什么不建议现在搞一个强存在感的“Driver Layer”

主要担忧是：

- 会把当前最稳定的 Feature 心智打散
- 会让后续 agent 在接手时分不清“这是 Feature 问题还是 Driver 问题”
- 会诱发过早的厚协议设计

因此当前更推荐的表述是：

- Driver 是一种 Feature 角色
- Driver 可能由一个默认系统 Feature 或若干系统 Feature 提供基础设施支持
- 对上层作者暴露的应该是“能力 API”，不一定非要暴露“你正在使用 Driver 层”这件事

---

## 九、与通信相关的抽象，当前更适合以什么层级出现

这一部分不是在定义最终 API，而是在记录目前比较稳的方向判断。

### 9.1 推荐落点

更推荐的落点是：

- 对产品和文档层：它是系统能力
- 对 runtime 层：它可能由一个默认挂载的系统 Feature 承接
- 对 agent 内部：允许增加少量公共函数作为入口
- 对 feature 作者：表现为一组稳定但尽量克制的调用方式

也就是说，后续如果真要沉淀通信原语，比较好的外观不是：

- 再新造一个用户强感知的大层级

而更像：

- 框架默认有一套系统能力
- 某些系统级 Feature 负责承接它
- 上层作者通过统一入口使用它

### 9.2 这样做的好处

1. 不破坏 `feature is all you need`  
2. 不需要现在就把“驱动”抬成更高于 Feature 的对象  
3. 能让后续演进是渐进式的  
4. 便于和现有 Flow、manifest、mode、inspector 路径对齐

### 9.3 这样做的边界

这并不意味着：

- 所有复杂度都能隐藏掉
- 不需要新约定
- `getFeature()` 会立刻消失

更准确地说，这是一种“把复杂度集中到系统位置”的策略，而不是“把复杂度彻底消灭”的策略。

---

## 十、现阶段更重要的是建立哪些判断边界

如果后续 agent 继续推进这个方向，建议优先坚持下面这些边界。

### 10.1 先区分“角色判断”，再区分“协议设计”

先判断：

- 哪些 Feature 其实已经在扮演驱动角色
- 哪些 Feature 只是普通业务 Feature
- 哪些能力应该向系统底层沉淀

再讨论：

- 它们之间该怎么通信
- 能力引用和事件机制该如何收敛

不要倒过来做。否则很容易出现“协议先设计得很漂亮，但系统里并没有真实稳定的角色分层”。

### 10.2 先提炼共性行为，不要先提炼设备 taxonomy

当前更稳的共性可能是：

- 能力提供
- 状态暴露
- 模式切换
- 生命周期观察
- 安全守卫
- 可诊断性

而不是：

- 显卡类
- 声卡类
- I/O 类
- 媒体类

后者以后也许会自然长出来，但现在不值得先写死。

### 10.3 先提高可观测性，不要急着提高抽象浓度

当前系统最缺的往往不是“术语”，而是“显式观测”。

如果未来推进通信相关能力，更值得优先考虑的是：

- 谁提供了什么能力
- 谁依赖了谁
- 哪些 hook 在拦截哪些事情
- 哪些 Feature 在读取别的 Feature 的公开状态
- 哪些 capability ref 失效了

这类观测能力会直接决定复杂度转移是否有效。

---

## 十一、为什么 `audit` 对这个方向特别有参考价值

`audit` 是当前最适合被反复研究的样本之一。

相关文件：

- [node_modules/@agentdev/audit-feature/dist/index.js](../node_modules/@agentdev/audit-feature/dist/index.js)
- [node_modules/@agentdev/audit-feature/dist/index.d.ts](../node_modules/@agentdev/audit-feature/dist/index.d.ts)

### 11.1 它当前做了什么

它会在 `@ToolUse` 阶段：

- 检查当前工具是不是 `bash`
- 拿到命令字符串
- 调用本地 LLM 做审计
- 命中高风险时拒绝工具执行
- 向上下文注入审计结论消息

### 11.2 它为什么是“暴力实现”

因为它本质上依赖的是：

- 工具名硬编码
- 特定 hook 时机
- 直接向上下文塞消息

它不是在说：

- 我正在消费一个“shell execution request”
- 我正在挂在某个底层能力前置策略点上
- 我正在对某种系统级能力做 policy check

### 11.3 它为什么又很有价值

因为它清楚地告诉我们：

- 系统里已经存在“基础通道 + 策略挂件”的需求
- 安全、日志、审批、通知这类横切能力，未来很可能都要围绕底层能力通道重组

因此，`audit` 不只是一个需要被重构的实现，它更是“驱动方向成立”的论据。

---

## 十二、为什么 `FlowCapabilityRef` 值得后续持续关注

当前 Flow 类型里已经存在一批很重要但尚未完全跑通的结构：

- `FlowCapabilityRef`
- `toolRef`
- `variableRef`
- `FlowNodeFeatureModeChange`

见：

- [local-features/flow/src/types.ts](../../local-features/flow/src/types.ts)

这说明系统已经在朝一个更可靠的方向迈步：

> 运行时和编辑器不应主要依赖裸字符串名，而应该依赖结构化能力引用。

这和“驱动”方向有天然一致性。

因为如果未来底层能力真的逐步沉淀为系统级 Feature / Driver role，那么 Flow 这一侧最稳的消费方式也应当更接近：

- 引用能力
- 引用模式
- 引用状态投影

而不是：

- 手写工具名
- 猜测某个 feature 内部有没有暴露某个变量
- 靠文档记忆某个 mode 是否存在

因此，后续如果推进驱动方向，建议持续把 `FlowCapabilityRef` 视为需要观察的桥梁，而不是孤立看待。

---

## 十三、当前不宜直接得出的过强结论

这一节专门记录“不该过早下的结论”，避免后续 agent 接手时把探索当成定案。

### 13.1 不宜直接宣布“驱动层已经确定”

现在更准确的说法应是：

- 已经识别出驱动角色
- 已经看到系统级 Feature 的底层化趋势
- 有必要围绕这类 Feature 的协作方式继续收敛

而不是：

- Driver layer 设计已经完成

### 13.2 不宜直接规定统一的设备分类

当前没有足够证据证明以下分类已经稳定：

- 声卡类
- 显卡类
- 执行器类
- 环境类
- 外设类

这些分类可以作为内部比喻帮助思考，但不应过早变成正式框架类型系统。

### 13.3 不宜直接废弃 `getFeature()`

当前 `getFeature()` 依然是一个现实存在、而且已经在被使用的 escape hatch。

相关入口：

- [node_modules/agentdev/src/core/agent.ts](../node_modules/agentdev/src/core/agent.ts)
- [node_modules/agentdev/src/core/agent/tool-executor.ts](../node_modules/agentdev/src/core/agent/tool-executor.ts)
- [local-features/feature-dev/src/index.ts](../../local-features/feature-dev/src/index.ts)

它的问题不是“绝对不能存在”，而是“不应继续成为跨 feature 复用的唯一主路径”。

### 13.4 不宜直接把 hook 当作最终通信方案

当前 hook 非常重要，但它更适合：

- 观察生命周期
- 做前置守卫
- 做后置通知
- 控制循环继续或结束

而不应天然被视为：

- feature 间业务通信的唯一标准通路

如果未来任何跨 feature 协作都要退回到 hook + 字符串判断，那复杂度只会继续堆积。

---

## 十四、后续 agent 接手时建议优先看的参考文件

下面按主题列出推荐入口，方便后续 agent 快速接手。

### 14.1 产品与主线背景

- [AGENT.md](../../AGENT.md)
- [docs/reference/agentdev-claw-product-overview.md](../reference/agentdev-claw-product-overview.md)
- [docs/reference/dev-context-index.md](../reference/dev-context-index.md)

### 14.2 Flow 主线与 Feature mode

- [docs/plans/flow-layer-design.md](./flow-layer-design.md)
- [docs/plans/flow-feature-mode-dual-surface-design-plan.md](./flow-feature-mode-dual-surface-design-plan.md)
- [docs/plans/flow-implementation-plan.md](./flow-implementation-plan.md)
- [local-features/flow/src/index.ts](../../local-features/flow/src/index.ts)
- [local-features/flow/src/types.ts](../../local-features/flow/src/types.ts)
- [local-features/flow/src/flow-aware-feature.ts](../../local-features/flow/src/flow-aware-feature.ts)
- [public/flow-editor.js](../public/flow-editor.js)
- [server.js](../server.js)

### 14.3 Feature 基础面与运行时边界

- [local-features/feature-dev/skills/agentdev-feature-guide/references/foundation/feature-model.md](../../local-features/feature-dev/skills/agentdev-feature-guide/references/foundation/feature-model.md)
- [local-features/feature-dev/skills/agentdev-feature-guide/references/runtime/hook-design.md](../../local-features/feature-dev/skills/agentdev-feature-guide/references/runtime/hook-design.md)
- [local-features/feature-dev/skills/agentdev-feature-guide/references/runtime/reverse-hooks-reference.md](../../local-features/feature-dev/skills/agentdev-feature-guide/references/runtime/reverse-hooks-reference.md)
- [local-features/feature-dev/skills/agentdev-feature-guide/references/foundation/design-patterns.md](../../local-features/feature-dev/skills/agentdev-feature-guide/references/foundation/design-patterns.md)
- [node_modules/agentdev/src/core/feature.ts](../node_modules/agentdev/src/core/feature.ts)
- [node_modules/agentdev/src/core/agent.ts](../node_modules/agentdev/src/core/agent.ts)
- [node_modules/agentdev/src/core/hooks-registry.ts](../node_modules/agentdev/src/core/hooks-registry.ts)
- [node_modules/agentdev/src/core/hooks-decorator.ts](../node_modules/agentdev/src/core/hooks-decorator.ts)
- [node_modules/agentdev/src/core/agent/tool-executor.ts](../node_modules/agentdev/src/core/agent/tool-executor.ts)

### 14.4 当前具备“驱动前兆”的重点样本

- shell：
  - [node_modules/@agentdev/shell-feature/dist/index.js](../node_modules/@agentdev/shell-feature/dist/index.js)
  - [node_modules/@agentdev/shell-feature/dist/index.d.ts](../node_modules/@agentdev/shell-feature/dist/index.d.ts)
  - [local-features/feature-dev/src/index.ts](../../local-features/feature-dev/src/index.ts)

- audio feedback：
  - [node_modules/agentdev/src/features/audio-feedback/index.ts](../node_modules/agentdev/src/features/audio-feedback/index.ts)

- audit：
  - [node_modules/@agentdev/audit-feature/dist/index.js](../node_modules/@agentdev/audit-feature/dist/index.js)
  - [node_modules/@agentdev/audit-feature/dist/index.d.ts](../node_modules/@agentdev/audit-feature/dist/index.d.ts)

### 14.5 对“跨 feature 数据契约 / 能力契约”有启发的案例分析

这些不是实现文档，但对判断问题空间很有参考价值：

- [docs/cases/00-deep-reflection.md](../cases/00-deep-reflection.md)

尤其值得关注其中关于以下问题的反思：

- 跨 Feature 数据契约缺失
- 安全策略声明式机制
- Feature 数量膨胀与结构重复
- Flow 与 Feature 的分层
- 多 Workflow / 多能力协作

---

## 十五、当前阶段的工作建议

如果后续 agent 继续沿这条线做探索，建议优先做以下类型的工作，而不是急着拍通信协议定稿。

### 15.1 优先做理念和边界澄清

例如：

- 哪些 Feature 更接近系统底层能力
- 哪些 Feature 是业务语义包
- 哪些能力值得长期沉淀为系统级 Feature

### 15.2 优先补可观测性和上下文文档

例如：

- 哪些 Feature 提供对外公开 API
- 哪些 Feature 依赖别的 Feature
- 哪些能力已经通过 Flow 暴露为 mode / variable / manifest
- 哪些 hook 正在承担横切逻辑

### 15.3 优先挑典型样本做小范围重构实验

最适合的候选样本通常是：

- shell
- audit
- audio-feedback

因为它们已经分别代表了：

- 底层执行通道
- 横切策略守卫
- 媒体输出能力

### 15.4 不要一开始就试图设计“终极统一模型”

这个方向一旦过早追求终极统一，最容易出现的问题是：

- 名词很多
- 契约很多
- 但旧路径一个都没删掉

那样复杂度不是转移，而是叠加。

---

## 十六、总结

当前提出“驱动”，并不是因为系统突然需要一套崭新的高层哲学，而是因为现有 Feature 体系已经自然分化出一批更接近底层基础设施的能力角色。

这个方向的核心判断是：

1. `feature is all you need` 仍然成立  
2. Driver 更适合先被理解为一种系统级 Feature 角色  
3. 现在最值得沉淀的是方向、边界和问题意识，而不是把 feature 间通信写成最终定案  
4. 真正应该优先统一的不是“设备分类”，而是“能力暴露、状态投影、模式切换、跨 feature 协作”的交互形状  
5. 如果未来要继续推进，这条线最适合从 shell / audit / audio-feedback 这些已有前兆最强的样本开始

一句话总结：

> “驱动”不是为了引入一个更高的抽象层，而是为了更诚实地描述当前系统里一类已经存在、正在变重要的系统级 Feature 角色。

---

## 十七、附录：当前文档的非目标

为避免误用，最后再次强调本文档不做以下事情：

- 不定义最终通信 API
- 不定义最终的 driver registry 结构
- 不规定 feature 间必须采用哪一种调用方式
- 不规定统一的设备类别 taxonomy
- 不承诺当前仓库已经具备完整驱动能力

它的唯一目标是：

> 为下一阶段围绕“驱动”方向的继续讨论、代码探索和文档接力，提供一个尽量完整、尽量可追溯的共同起点。
