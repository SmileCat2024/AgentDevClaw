# 上下文压缩 × 重启接力 讨论备忘录

> 本文档用于沉淀一轮围绕“上下文压缩（context compaction）”的探索性讨论。
>
> 它的目标不是给出最终方案，而是保留：
>
> - 我们到底在讨论哪一层问题
> - 哪些判断已经相对稳定
> - 哪些判断仍然故意保持开放
> - 当前代码中哪些位置最值得继续追踪
>
> 因此，这不是 RFC，不是定案设计，也不是实施计划。它更接近一份“后续接力用的思想地图 + 代码索引”。

---

## 一、文档定位

这份文档主要回答下面几类问题：

- 为什么“上下文压缩”不能只被理解成“做一个摘要”
- 为什么这件事在 AgentDev / AgentDevClaw 里会天然碰到 runtime 级问题
- 为什么当前更值得沿着“压缩与重启接力并列发展”的方向思考
- 为什么不应该过早把问题上升到一个确定的 OS / Driver 架构定案
- 当前代码里已经有哪些 seam 可以支撑后续探索

它刻意不做以下事情：

- 不定义最终压缩算法
- 不定义最终消息数组格式
- 不承诺一定采用“successor agent”模型
- 不定义最终 session lineage schema
- 不把本文中的判断写成必须服从的框架约束

一句话说：

> 本文只沉淀问题意识、方向判断和代码入口，不沉淀最终定案。

### 1.1 为什么需要把“讨论过程”本身保留下来

对这条线来说，只保留一个压缩后的结论是不够的。

原因是：

- 我们讨论的问题跨越了产品语义、运行时机制、会话恢复、feature contract、flow 编排语义几个层次
- 很多判断不是“对/错”的简单二选一，而是“现在先不要这么做”的边界判断
- 后续接棒的人如果只看到最后一句结论，很容易不知道我们为什么刻意避开某些路线

因此本文特别强调三件事的完整保留：

1. 讨论的起点是什么  
2. 讨论中途发生了哪些认知纠偏  
3. 哪些说法后来被主动收窄，而不是被否定

### 1.2 本文建议的阅读方式

如果后续接棒者时间有限，更建议按下面顺序阅读：

1. 先读第二章和第三章，理解我们究竟在讨论哪一层  
2. 再读第五章到第十章，理解为什么后来转向“上下文重建 + successor handoff”  
3. 再读第十一章到第十三章，定位代码 seam 和未定问题  
4. 最后读附录，快速进入代码入口、术语和后续可能的讨论顺序

也就是说：

> 本文不是为了“快速看完”，而是为了“快速对齐语境”。

### 1.3 这份文档的最新收束点

在最初版本之后，这条线又发生了一轮比较重要的产品化收束。为了避免后续接棒者把本文误读成“已经决定先做 successor runtime”，这里先把最新结论写在最前面。

当前更稳的理解不是：

- 先做一个万能 compaction 系统
- 先把 restart / successor / subagent clone 一次性打通
- 先改 Agent 核心 restore 语义

而是：

- 先把问题理解成一条 `context continuity` 产品线
- 先区分 `Exact Restore`、`Trimmed Resume` 与 `Summarized Resume`
- 先让系统能够产出一份可审计、可复用的 `Handoff Package`
- 先用手动路径验证“旧 session -> handoff package -> 新 session 继续”是否成立

这里有几个需要明确下调的旧说法：

1. **`successor agent / successor session` 仍是有价值的工作直觉，但不应再被理解成当前第一实现目标。**  
   原因是：当前代码里的 session restore 语义其实更接近“精确恢复旧快照”，而不是“压缩后用新 prompt 重新开跑”。如果过早把实现目标写死成 successor runtime，很容易把产品动作、运行时动作和中间产物混在一起。

2. **“压缩”不再适合被当成一个单独产品动作，而更像一个上下文变换步骤。**  
   它未来可以服务于：
   - `Compacted Resume`
   - `Fork Branch`
   - `Delegate`
   - 其他 handoff 场景

3. **当前第一步更适合做 `history-only` 的 handoff package，而不是 feature-state-aware 的完整 successor。**  
   原因是：这条路最容易验证价值，同时又不会提前承诺当前框架并不具备的状态连续性能力。

4. **不要把现有 `restart / loadSession()` 路径直接包装成“压缩恢复”。**  
   原因是：这会让产品语义失真。用户以为自己是在“轻量继续”，系统实际上却是在“恢复旧现场”。

因此，接下来阅读本文时，最好始终带着下面这条最新边界：

> 当前最该先证明的，不是“successor runtime 已经成立”，而是“handoff package + compacted resume 的手动路径成立，而且不会污染现有 exact restore 语义”。

### 1.4 最新术语纠偏：`Light / Lightweight` 已经被重新定义

随着实现推进，我们又发现了一个必须前置修正的点：

之前讨论中曾经把某些“不是完整 restore、但也不是原样延续”的路径笼统叫作：

- `Light Resume`
- `Lightweight Resume`
- `Compacted Resume`

这个说法后来被证明不够精确，因为它把两种实质不同的路径混在了一起：

1. **`Trimmed Resume`**
   中文：`裁剪式续接 / 轻量加载`

   含义：

   - 仍然保留原始对话骨架
   - 只是删掉或折叠低价值部分
   - 更像“瘦身后的真实上下文继续”

2. **`Summarized Resume`**
   中文：`摘要式续接`

   含义：

   - 不再保留原始对话主体
   - 用一段 summary / digest 重新启动一个新会话
   - 更像“带着交接摘要重新开局”

这两者在产品价值、用户心智和技术实现上差异都很大。

当前最新判断是：

- 用户真正认为“有实用价值的轻量加载”，更接近 `Trimmed Resume`
- `Summarized Resume` 仍然有底层价值，但更像基础 handoff 能力验证，不应冒充“轻量加载”的主形态

因此本文后续如果再次出现：

- `Compacted Resume`
- `Light Resume`

应优先按下面方式理解：

- 如果是在产品主线语境下：优先理解为 `Trimmed Resume`
- 如果是在早期实验 / handoff 基础设施语境下：它可能指向 `Summarized Resume`

为了避免歧义，后续更推荐直接使用：

- `Exact Restore`
- `Trimmed Resume`
- `Summarized Resume`
- `Fork`

而尽量少再单独使用 `Light Resume` 这种容易混淆的说法。

---

## 二、这轮讨论里，真正有两个不同层次的问题

这轮讨论一开始有一个很重要的错位：

### 2.1 高层问题：信息管理 / 产品语义

这是偏“Agent 应该如何理解和保留信息”的问题，例如：

- 什么是长期偏好
- 什么是任务状态
- 什么是短期对话上下文
- 哪些信息应该遗忘、压缩、冷冻

这一层更像产品语义、信息生命周期、交互哲学。

相关讨论和参考：

- [docs/cases/analysis-interaction-philosophy.md](../cases/analysis-interaction-philosophy.md)
- [docs/cases/00-deep-reflection.md](../cases/00-deep-reflection.md)

### 2.2 底层问题：runtime 是否能承受“强上下文压缩”

用户真正更关心的是这一层：

> 当前 AgentDev runtime，是否真的能承受上下文压缩这种“大规模上下文改写”能力？

这里关心的不是信息分类哲学，而是：

- 触发点在哪里
- 是原地改写还是新建接力
- 历史消息怎么重组
- feature 注入消息怎么办
- flow prompt 怎么办
- tool_use / tool_result 配对怎么保
- 当前 live agent 的循环是否会被污染

这层问题更接近：

- context assembly
- session restore
- checkpoint / rollback
- prompt view rebuild

这两层不能混为一谈。

### 2.3 这次错位为什么容易发生

这个错位非常自然，因为“上下文压缩”这个词本身就有双重含义：

- 从产品角度看，它像是在说“信息太多，怎么更聪明地保留有用部分”
- 从 runtime 角度看，它像是在说“消息数组太长了，下一次 API 调用前怎么重写输入”

在普通对话 agent 里，这两层经常被混在一起，因为：

- 历史消息几乎就是主要上下文
- 状态大都隐式存在于对话文本里

但在 AgentDevClaw 里，这种混谈会马上出问题。因为系统里不仅有对话历史，还有：

- feature 的注入消息
- flow 的节点 prompt
- feature 自己的 captureState / restoreState 状态
- 工具启停状态
- mode 状态
- 子代理、视觉、任务、审计等运行时侧产物

所以这里“上下文”这个词本身就已经不是一个单纯对象。

### 2.4 为什么必须先区分层次

如果不先区分层次，讨论会不断在下面几种路线之间来回跳：

- “是不是应该做长期记忆”
- “是不是应该做摘要”
- “是不是应该做消息裁剪”
- “是不是要改 Agent 核心”
- “是不是要加 Driver”

这些问题当然都相关，但它们不是同一层问题。

更准确地说：

- “长期记忆怎么表达”是高层语义问题
- “摘要什么时候做”是策略问题
- “消息数组怎么改写”是 runtime 问题
- “谁来组装 prompt view”是 framework seam 问题
- “这会不会长成 driver / OS”是系统抽象问题

这轮讨论后期最大的进步之一，就是终于开始把这些问题拆开看。

---

## 三、最初的一个方向判断：不要先从 OS 角度设计世界

这轮讨论较早形成的一个稳定判断是：

> 现在不应主动从 OS 顶层抽象出发设计，而应先围绕一批“系统级 feature 能力”做落地探索。

更具体地说：

1. 先识别出哪些问题已经反复以系统能力缺口的形式出现  
2. 先尝试用 feature 形态落地这些能力  
3. 如果 feature 形态落地得还不错，说明现有框架抽象暂时够用  
4. 如果落地过程中反复卡在同类问题上，再把这些卡点上升为框架 contract  
5. 等这些 contract 被真实落地验证后，再讨论是否自然上升为 driver / OS 方向

这和 [docs/plans/driver-feature-vision.md](./driver-feature-vision.md) 中“Driver is a system-grade feature role”的判断是相容的，而不是冲突的。

相关参考：

- [docs/plans/driver-feature-vision.md](./driver-feature-vision.md)

### 3.1 这个判断背后的态度，不是反对 OS，而是反对“超前 OS 化”

这里有一个容易误解的点：

“不要先从 OS 角度设计世界”，不等于：

- OS 方向不重要
- Driver 方向是错的
- 不值得讨论系统抽象

真正的意思是：

- 当前两个项目都还在快速演化
- 许多系统能力的边界并未在真实使用中稳定下来
- 如果现在太早把世界观写死，后续很可能被自己的定义反噬

也就是说，这里的保守不是胆怯，而是一种顺序判断：

> 先让真实问题把 contract 逼出来，再决定哪些 contract 值得上升为系统抽象。

### 3.2 为什么这个顺序对“上下文压缩”尤其重要

上下文压缩是那种特别容易诱发“先做大统一抽象”的问题。

因为它天然会勾连很多宏大命题：

- 记忆模型
- 会话生命周期
- agent 身份连续性
- 提示词工程
- feature 状态边界
- flow 运行时语义

一旦从 OS 角度先画大图，很容易出现下面的危险：

- 名词特别完整
- 分层特别漂亮
- 真正贴到代码上时才发现 seam 不存在

这轮讨论后期的一个核心反应，其实正是对这种风险的警惕。

### 3.3 所以，“先做系统 feature”到底意味着什么

这里的“先做系统 feature”不一定等于马上写代码，更准确地说是：

- 先用 feature 视角描述问题
- 先以 feature 可落地点来检查框架 seam 是否足够
- 先把“需要 framework 才能做”的部分和“现有 feature 也能做”的部分分离

例如在上下文压缩这条线上，后来逐渐浮现出的判断就是：

- 轻量摘要、边界标记、阶段归档，可能 feature 也能做
- 真正的 prompt view 重建、successor handoff、message compaction pipeline，很可能要碰 framework seam

这种拆法就比一开始直接喊“做 agent os 的记忆子系统”更接近现实。

---

## 四、对“系统 feature 缺口”的初步观察

这轮讨论里，一度把缺口大致分成了三块：

- 上下文相关能力
- 任务/事件相关能力
- 异步交互 / 守护观察 / 条件触发相关能力

但后续逐渐发现：

### 4.1 “上下文 feature”这个说法太容易误导

如果直接说“做一个上下文管理 feature”，很容易让问题滑向：

- agent 该采用什么固定记忆分层
- 平台是否要规定某种统一上下文本体
- 不同 agent 的“性格底子”是否会被写死

这是讨论中明确被质疑的点，而且这个质疑非常合理。

因此后续更谨慎的表述是：

- 不要急着规定统一“记忆 ontology”
- 更应该先讨论“上下文生命周期”和“上下文重建机制”

### 4.2 早期“三层”提法，只能当分析框架，不能当框架定案

曾经用过“身份知识 / 任务状态 / 对话上下文”这类三层表述，但后来明确意识到：

- 它适合作为分析视角
- 不适合作为当前框架定案

因为这类命名一旦写死，就会隐含一种过早的 agent 世界观。

更稳妥的说法应是：

> 我们已经能观察到，不同信息具有不同寿命和不同再水化方式；但不应过早规定所有 agent 必须采用同一套固定桶。

### 4.3 为什么“上下文 feature”最容易让人误入歧途

“任务 feature”“观察 feature”“通知 feature”这些说法都还相对中性，
但“上下文 feature”很容易听起来像：

- 有一个平台规定的上下文总线
- 有一个统一的记忆总控中心
- agent 的一切认识活动都必须受它支配

这会产生两个不必要的副作用：

1. 它会把讨论过早拉到“世界观层面”
2. 它会让接棒者误以为当前已经决定“上下文管理是平台强约束”

所以后续更稳妥的表述是：

- 不是先设计一个大一统的 Context Feature
- 而是先定位上下文相关的具体 seam：触发、边界、压缩、再水化、接力

### 4.4 三个系统缺口之间其实不是并列孤岛

最初看起来像三块：

- 上下文
- 任务/事件
- 异步交互

但讨论越往后越发现，它们之间耦合很强：

- 没有任务态，压缩就没有稳定的中间落点
- 没有事件/触发，就很难定义哪些边界值得压缩
- 没有异步交接，就很难让 successor runtime 真正自然出现

换句话说：

> 上下文压缩不是孤立能力，它天然会把任务态、边界语义和接力模型一起拉进来。

这也是为什么本文虽然聚焦“上下文压缩”，但始终没有把视野收窄到“只研究摘要提示词”。

---

## 五、讨论的一个重要转折：不要把“压缩”理解成信息管理，要把它理解成“上下文重建”

在引入 Claude Code 的上下文压缩实践之后，讨论发生了一个关键转折。

### 5.1 转折前的直觉

较容易把问题想成：

- 怎么提取重要信息
- 怎么分类长期和短期信息
- 怎么做摘要

这更像“信息管理”问题。

### 5.2 转折后的直觉

Claude Code 的实践提醒我们：

> 压缩的本质不是“做摘要”，而是“重建下一次发给模型的上下文视图”。

也就是说，真正关键的不是：

- 我能不能写出一段 summary

而是：

- 下一次 API 调用前，最终 `messages[]` 是怎么重新构造出来的
- 哪些内容进 summary
- 哪些内容不进 summary，而是作为附件 / 状态 / 再注入物重新补回

这个视角对于 AgentDevClaw 尤其重要，因为系统里不仅有普通对话历史，还有：

- feature 注入消息
- flow 节点 prompt
- flow warning / transition guidance
- tool scope 变化
- feature mode 影响
- feature runtime state

所以这里逐渐形成了一个新的 runtime 级抽象：

### 5.3 三个对象的区分

#### 1. Raw Conversation Log

真实发生过的消息事件流。

可能包含：

- user / assistant
- tool result
- system 注入
- feature 注入
- flow 注入
- hook 产物

它回答的是：

> 发生过什么

#### 2. Runtime State

系统当前活状态，不应完全靠消息历史隐式承载。

例如：

- 当前 active flow / node
- feature mode
- todo 状态
- visual 开关
- subagent 运行状态

它回答的是：

> 系统现在处于什么状态

#### 3. Prompt View

下一次真正发给 LLM 的上下文视图。

它不必等于 raw log。

它回答的是：

> 这一次要让模型看见什么

### 5.4 因此，“上下文压缩”更像一次 prompt rebuild

所以后续更贴近工程的说法是：

> 上下文压缩本质上是一次从 raw log + runtime state 出发，对 next prompt view 的重新编译。

这比“上下文管理 feature”更接近问题本体。

### 5.5 这个转折为什么重要到足以改变整条路线

如果把问题理解成“信息管理”，默认会走向这些路线：

- 给历史做摘要
- 引入长期记忆
- 定义任务态抽取规则
- 讨论哪些信息该沉淀

这些并不是错的，但它们会天然把重心放在：

- “内容是什么”

而不是：

- “下一次 LLM 输入怎么构造”

一旦改成“上下文重建”视角，问题会立刻变成：

- 谁拥有最终 prompt 组装权
- 哪些消息是原始事件，哪些只是运行时投影
- 哪些东西要被保留 verbatim
- 哪些东西应该重新生成
- 哪些东西只能从 state 恢复，不能再从历史里捞

这就从“知识整理”问题转成了“runtime 编译”问题。

### 5.6 为什么这对 feature / flow-heavy 系统是刚需

在一个纯聊天 agent 里，`messages[]` 可能已经足够代表大部分上下文。

但在 AgentDevClaw 里，显然不是这样。

当前系统至少有这几类不完全等价的信息载体：

- 历史消息本身
- `Context` 里的 system/user/assistant/tool message
- feature 的 `captureState()`
- flow 的运行时状态
- ToolRegistry 当前状态
- feature mode 当前生效值
- 外部运行资源状态（如 subagent pool、visual 缓存）

如果仍然把“上下文压缩”理解成“把 messages 总结一下”，其实已经先天忽略掉一半系统。

### 5.7 Prompt View 概念为什么值得反复强调

这轮讨论里，`Prompt View` 是一个很关键但也很容易被低估的概念。

它的重要性在于：

- 它允许 `raw history` 和 `next prompt` 不再被视为同一件事
- 它为“压缩后仍能保留原始历史”提供了空间
- 它为“交接包”和“再水化工件”提供了天然落点

换句话说，如果未来这条线真的要往 framework seam 走，
最有可能被逼出来的新 contract 之一，不是“memory layer”，而是：

> prompt view 是否需要成为一个显式概念

### 5.8 这并不等于现在就要改 Context

这里也要保留一个谨慎边界：

- 说 `Prompt View` 值得显式化
- 不等于现在就判断 `Context` 一定要拆层

当前更稳的态度仍然是：

- 先让这个概念帮助我们看清问题
- 再看代码 seam 是否真的撑不住
- 再决定要不要把它提升成正式 runtime 结构

也就是说，这里仍是“工作抽象”，不是“立即重构指令”。

---

## 六、Claude Code 实践带来的几个关键启发

用户额外提供了对 Claude Code compaction 系统的调查。这里不复述其全部细节，只保留对当前项目最有启发的判断。

### 6.1 启发一：压缩不是单一路径，而是一个分层 fallback 体系

Claude Code 里存在：

- session memory compact
- full compact
- partial compact
- microcompact
- cached microcompact

这提示我们：

- 上下文压缩不应只有一种策略
- 轻量裁剪、阶段性摘要、完整重建，可能应并列存在
- 当前项目不必一上来追求“终极唯一 compact 机制”

### 6.2 启发二：统一的中间结果对象非常重要

Claude Code 会将不同压缩路径统一输出成 `CompactionResult`。

这启发当前项目后续也许需要一类中间对象，例如：

- compact boundary
- summary payload
- preserved segment
- rehydrated artifacts
- lineage metadata

即使最终命名不同，这种“中间层结果对象”也很值得保留。

### 6.3 启发三：摘要不是全部，rehydration 同样关键

Claude Code 在压缩后会重新注入：

- 文件附件
- plan 内容
- skills
- async status
- tool schema delta

这对 AgentDevClaw 非常关键，因为我们这里更复杂：

- flow 状态
- feature modes
- 当前可用工具
- feature 注入材料
- subagent 状态

其中很多东西不适合被 LLM自由摘要，而更适合以“可再水化工件”的形式重新补回。

### 6.4 启发四：边界信息很重要

Claude Code 使用 compact boundary。

对 AgentDevClaw 来说，flow / node / workflow 本身可能就是更强的语义边界来源：

- 节点完成
- workflow 切换
- subagent 完成并回传
- todo 阶段收束

这提示我们：

> 当前系统未来的压缩边界，也许不应只靠 token 触发，而应部分借助 flow 语义边界。

### 6.5 Claude Code 给我们的最大提醒，不是 prompt，而是“消息数组不是神圣不可改的”

这轮讨论里，一个非常深的潜台词其实是：

Claude Code 并不是把“历史消息”当成永远不可触碰的神圣真相。

它已经默认：

- 可以摘要旧段
- 可以保留最近段
- 可以删除部分 tool_result
- 可以再补回附件
- 可以在下一次 API 请求时把不同来源的信息拼成新的 `messages[]`

这对当前项目的心理障碍有一个很重要的冲击：

> 如果我们一直把当前 `Context` 想成必须原样延续的唯一真相，那么很多压缩思路一开始就被自己封死了。

### 6.6 但 Claude Code 的做法也不能直接照搬

同时，这轮讨论也很清楚地意识到：

不能因为 Claude Code 这么做了，就直接把它复刻到 AgentDevClaw。

原因包括：

1. Claude Code 的历史主体仍然更接近“对话 + 工具交互”
2. AgentDevClaw 有更重的 flow 语义
3. AgentDevClaw 有更显式的 feature 状态文化
4. AgentDevClaw 有更多系统级注入消息，不是简单的 transcript

所以更准确的态度是：

- 借鉴它的“压缩是重建消息视图”这一思想
- 但不要假设它的消息结构、触发策略、附件补回策略可以直接平移

### 6.7 Claude Code 为什么强化了“接力式 successor”直觉

用户提供的细节里有一个特别值得注意的工程事实：

- 压缩后会生成 compact boundary
- 会生成 summary messages
- 会生成 attachments / hookResults / messagesToKeep
- 下一次 API 调用时，本质上拿到的是“一个新拼出来的消息数组”

这使得压缩更像一次“会话续接构造”，而不是当前 live loop 的一小步内部变换。

这点对后续的 successor 直觉有明显推动作用：

- 旧会话被折叠
- 新视图被构造
- 后续对话从新视图继续

这种工程感和“successor session”很接近。

### 6.8 为什么 attachments / hookResults 这类概念对当前项目意义很大

Claude Code 会在压缩后恢复：

- plan
- skills
- async status
- tool schema delta

这一点对 AgentDevClaw 的影响在于：

未来如果这里也做 compact，
则可能也需要思考哪些东西应该属于“压缩后再补回”的附件层，例如：

- flow workspace 当前图摘要
- 当前 workflow / node 信息
- feature modes 生效表
- 当前启用 features 的 manifest 摘要
- 当前 ToolRegistry 的可见工具投影
- 当前子代理状态汇总

这些内容未必要原样落在 summary 里，但很可能需要以某种附件式材料再次注入。

### 6.9 Claude Code 的 boundary 思维和 flow 边界可能是天然互补的

Claude Code 的 boundary 主要仍是 compaction event 自身。

而 AgentDevClaw 比它多了一个很重要的潜在优势：

- flow / node / workflow 自带阶段语义

这意味着后续如果要探索“语义压缩边界”，AgentDevClaw 反而可能比普通对话 agent 更有土壤。

当然，这里也只是方向判断，不代表当前代码已经提供了完整支持。

---

## 七、这轮讨论里逐渐成形的一个新抽象：Rehydratable Artifact

在讨论 feature / flow / runtime state 与压缩关系时，一个很值得保留的中间概念是：

> Rehydratable Artifact（可再水化上下文工件）

它描述的是：

- 不应该直接进摘要主体
- 也不应该简单地留在原始消息里
- 但压缩后下一轮仍然可能需要再次补回的上下文材料

在当前项目中，潜在候选包括：

- 当前 flow 状态摘要
- 当前节点 prompt 投影
- 当前 feature modes
- 当前 tools / delta
- todo 当前状态
- subagent 当前汇总
- visual 当前观测摘要

这个概念很有用，因为它把问题从“所有东西都进 summary 吗”转向了：

- 什么该被摘要
- 什么该被保留
- 什么该被重建

但这里仍然只是工作概念，不应过早写死为框架正式接口。

### 7.1 为什么它值得保留，但又不能太早 formalize

`Rehydratable Artifact` 这个概念的价值在于，它帮我们避免两个极端：

#### 极端 A：所有东西都塞进 summary

这样会导致：

- 精度不稳定
- 很多运行时语义被模糊化
- 一些本来结构化的状态被迫退化成 prose

#### 极端 B：所有东西都 verbatim 保留

这样会导致：

- token 压力依旧存在
- 历史消息越来越承担本不该它承担的状态职责
- 压缩名义上发生了，系统实际上仍然背着旧负担

`Rehydratable Artifact` 恰好提供了第三条路：

- 不是删掉
- 也不是全文保留
- 而是在交接后按需重建

### 7.2 当前项目里哪些东西最像这类工件

按照讨论里的直觉，下面这些都很像：

- 当前 flow 所在 workflow / node 的结构化状态
- 当前 feature mode 生效情况
- Todo 列表的摘要投影
- 当前工具可见性差异
- 当前 active subagent 的汇总信息
- 某些 recent visual observations 的压缩摘要

### 7.3 哪些东西不应过早归入这类工件

反过来，也有一些内容不能因为“看起来结构化”就急着归入这类工件：

- 用户原话中的关键偏好
- 某次错误日志的原始细节
- 某段对后续判断高度关键的代码片段

这些信息很可能仍需要：

- 保留 verbatim
- 或者在 summary 中明确引用

所以这里并不存在一个“所有重要信息都变工件”的简单结论。

### 7.4 这也意味着压缩结果可能天然是混合结构

如果把这个概念继续往下推，一个更自然的未来形态其实是：

- 一部分内容进入 compact summary
- 一部分内容成为 kept segment
- 一部分内容成为 rehydratable artifacts
- 一部分内容只保留在 raw log，不再进入 next prompt

也就是说，压缩不是二选一的“保留 / 删除”，而更像多通道分流。

这点很值得后续继续保留。

---

## 八、一次非常关键的方向判断：压缩应当沿着交接包与新会话继续这条线演化

用户随后提出了一个更大胆但也更贴近 runtime 的方向：

> 压缩不应首先被理解成“在同一个 live agent 里原地修补上下文”，而更应被理解成“旧运行体产出一份交接材料，再由新运行体继续”。

这条判断后来仍被保留，但在产品化梳理后发生了一个重要收缩：

- **值得守住的是“显式接力”边界**
- **不应过早把第一实现目标写死成 `successor agent / successor session`**

换句话说，当前更稳的优先级是：

1. 先让系统能稳定产出 `Handoff Package`
2. 先让新 session 能消费它，形成 `Compacted Resume`
3. 再决定未来是否要把这条线继续上升成更强的 successor runtime 语义

### 8.1 为什么这个判断仍然重要

因为它把“压缩”从：

- 原地改写 live agent

转向：

- 在旧运行体和新运行体之间做一次显式交接

只要这条边界被守住，很多复杂度就会从：

- 活体原地改写

转移到：

- 交接包编译
- 新会话启动语义
- lineage 与审计

### 8.2 为什么要下调对 `successor` 名词的承诺

早期文档里对 `successor agent / successor session` 的表述较强，这在讨论阶段是有价值的，因为它帮助我们明确反对“live loop 内原地再生”。

但继续往产品落地推进后，这个说法需要被刻意降级为：

- 一种工作直觉
- 一种可能的远期运行时形态
- 而不是当前第一版必须兑现的产品承诺

原因主要有三点：

1. 当前代码里的 `loadSession()` 更接近 **精确恢复旧快照**，而不是“压缩后新视图启动”。  
2. 当前第一步更适合验证的是 **handoff package 是否有用**，而不是“新旧运行体的身份连续性”这种更大命题。  
3. 如果现在就把产品动作命名成 `successor`，很容易让用户误以为系统已经解决了 lineage、feature 连续性、flow 恢复等更难的问题。

### 8.3 当前更合适的第一落点是什么

当前更稳的第一落点不是：

- mutate current context in place
- 直接生成 successor runtime
- 把 restart 按钮悄悄升级成 compact restart

而是：

- 从旧 session 导出一份 `history-only` 的 handoff package
- 让用户手动触发一次 `Compacted Resume`
- 在一个新 session 里，用当前 system prompt + handoff package 继续任务

这个选择的价值在于：

- 它不污染现有 `Exact Restore`
- 它能让交接包成为可审计工件
- 它为未来的 `Fork Branch` / `Delegate` 复用留下空间

### 8.4 这里最值得守住的不是名词，而是边界

也就是说，未来哪怕最后不叫：

- successor agent
- successor session
- handoff runtime

都没关系。

真正值得守住的是这条边界：

> 压缩不应被设计成对 live loop 的偷偷内部污染，而应被设计成一次显式交接；而当前第一步最适合把这次交接具体化为 `Handoff Package -> Compacted Resume`。

---

## 九、为什么“successor agent / successor session”思路在当前代码上是顺势的

这部分来自一轮针对当前代码的专门调查。

结论不是说“现在已经有 successor 机制”，而是说：

> 当前代码已经更偏向“恢复到一个新实例继续跑”，而不是“在同一个 live agent 里做复杂原地再生”。

### 9.1 当前代码里其实已经存在两类恢复语义

#### A. Step / Call Rollback

这是一种强原地语义。

- 在同一个 live agent 内恢复 `Context + feature snapshots`
- 目标是回退一步或回退一个 call 分支

关键位置：

- [node_modules/agentdev/src/core/checkpoint.ts](../node_modules/agentdev/src/core/checkpoint.ts)
- [node_modules/agentdev/src/core/agent/react-loop.ts](../node_modules/agentdev/src/core/agent/react-loop.ts)
- [node_modules/agentdev/src/core/agent.ts](../node_modules/agentdev/src/core/agent.ts)

#### B. Session Restore

这是一种弱接力语义。

- 保存 runtime snapshot
- 构造一个 fresh agent
- 在 fresh agent 上 `loadSession()`

关键位置：

- [node_modules/agentdev/src/core/session-store.ts](../node_modules/agentdev/src/core/session-store.ts)
- [node_modules/agentdev/src/core/agent.ts](../node_modules/agentdev/src/core/agent.ts)
- [node_modules/agentdev/src/test/session-restore.test.ts](../node_modules/agentdev/src/test/session-restore.test.ts)

### 9.2 这条链的工程意味

它说明当前框架已经认可：

- agent 的 runtime 可以被快照化
- 一个新 agent 可以从旧 snapshot 接着跑
- feature 的 `captureState / restoreState` 是这个过程的一等公民

这对“压缩后 successor agent 继续”是天然利好。

### 9.3 这条链为什么比“原地再生”更适合压缩

因为当前系统里已经有不少东西不适合 live 原地变形：

- flow runtime
- feature injected messages
- tool history
- subagent live runtime

尤其是 `SubAgentFeature` 自己已经明确表态：

> restore snapshot 时，live subagent runtime 会被丢弃并重置为空池

见：

- [node_modules/agentdev/src/features/subagent/index.ts](../node_modules/agentdev/src/features/subagent/index.ts)

这反过来说明：

- 当前系统已经接受“有些 live runtime 无法无损复活”
- 因而“接力式 successor”比“原地神奇再生”更贴近现实

### 9.4 代码调查里，一个很关键的证据：session restore 测试本身就是 fresh instance restore

这是这轮调查里非常值得保留的一个点。

测试 [node_modules/agentdev/src/test/session-restore.test.ts](../node_modules/agentdev/src/test/session-restore.test.ts)
并不是在同一个 agent 对象里 save 然后 restore，而是：

- `agent1` 跑第一段
- `agent1.saveSession(...)`
- 构造新的 `agent2`
- `agent2.loadSession(...)`
- `agent2.onCall(...)` 继续

这说明至少在框架作者自己写的验证路径里，
“恢复”已经天然被理解成：

> 在另一个实例里接着跑

这和 successor 直觉是高度一致的。

### 9.5 restore 的实际内容是什么，也非常值得保留

根据 [node_modules/agentdev/src/core/session-store.ts](../node_modules/agentdev/src/core/session-store.ts) 和 [node_modules/agentdev/src/core/agent.ts](../node_modules/agentdev/src/core/agent.ts)，
当前 runtime snapshot 至少包含：

- `initialized`
- `callIndex`
- `context`
- `featureStates`
- `usageStats`
- `rollbackHistory`

这说明当前系统已经不是“只恢复消息历史”，而是“恢复一个运行中 agent 的若干关键可序列化部分”。

但这一步还必须补一个后来才被明确核查出来的事实：

- 当前 restore 会直接恢复旧 `context`
- 如果 snapshot 里已经 `initialized = true`，后续 resumed call 不会重新走 system prompt 首次注入路径
- 测试也明确要求恢复后 system message 不重复注入

这意味着当前 restore 的产品语义更接近：

> exact restore / exact resume

而不是：

> compacted resume

从 compaction 角度看，这个事实非常重要，因为它意味着：

- 当前 restore seam 虽然顺势，但默认是在**沿用旧上下文**
- 不能把现有 `loadSession()` 路线直接包装成“压缩后的新会话继续”
- 如果未来要做 compacted resume，就必须刻意区分“恢复旧现场”和“带交接包开新现场”这两类动作

### 9.6 但当前 restore 仍然不是为 compaction 准备好的

虽然这条 seam 很顺势，但仍然不能误解成“现在已经差不多能做 compaction successor 了”。

至少还存在这些明显缺口：

- snapshot schema 里没有 compact lineage metadata
- `Context` 里没有 raw log / prompt view 区分
- restore 顺序仍是 feature 先 initiate，再恢复状态
- 缺失的 feature state 在恢复时主要是“跳过”，不是强校验
- restore 语义当前默认偏向 exact restore，而不是“当前 system prompt + 新编译上下文”

所以更准确的说法是：

> 当前 restore seam 是一个很好的起点，但它更适合作为“交接消费端”的参考，而不是直接当成 compaction handoff 的现成成品。

### 9.7 为什么 `Agent.reset()` 反而不值得作为主路线

在当前代码里，`reset()` 看起来像一个可能的切入点，但讨论后期对它的直觉其实是偏负面的。

原因在于：

- 它仍然是在同一个 agent 实例上清状态
- 它会保留 feature 实例对象本身
- 它不像 fresh instance restore 那样天然表达“新一棒”

所以如果 future compact 真的强调 successor 语义，
那么 `reset()` 更像是旧世界的便利 API，而不是新机制的正确底座。

### 9.8 这也解释了为什么 rollback 路线和 compaction 路线应刻意分开

rollback 的任务是：

- 回到过去的同一分支
- 保留同一 live agent 的连续性

而 compact successor 的任务是：

- 结束旧分支
- 从整理后的交接包继续

二者虽然都会“恢复状态”，但恢复的语义完全不同。

这点如果不在文档里强调，后续很容易有人想当然地说：

- “既然都能 restore，那 compaction 不就是 rollback 的变种吗？”

这轮讨论最后其实越来越清楚地反对这种简化。

---

## 十、但这里仍有一个需要谨慎保留的区分：重启恢复与压缩恢复不完全对称

讨论后期形成了一个更细的判断：

> 压缩和重启应共用同一条接力底座，但两者并不完全是同一个动作。

### 10.1 `Exact Restore`

更像：

- 老 snapshot
- 新实例恢复
- 旧 `context` 原样恢复
- 已有 system message 延续

也就是说，它回答的问题更接近：

> 我想回到原来的那个会话现场继续。

### 10.2 `Compacted Resume`

更像：

- 老 session / raw history
- 编译 `Handoff Package`
- 创建一个新的 session
- 用当前 system prompt + 交接包继续

所以它们的关系更准确地说应是：

- 共用 handoff substrate
- compact 在此基础上多一步“交接包编译”
- 并且 compacted resume 不应伪装成 exact restore

这个判断值得保留，因为它避免把 compact 简化成普通 restart。

### 10.2.1 这里后来又发生了一次重要分裂：`Compacted Resume` 不是单一实现

随着实现继续推进，我们后来发现：

`Compacted Resume` 这个说法本身还是过大，它至少包含两种差异明显的技术路线：

1. `Summarized Resume`

   - 旧 session / raw history
   - 编译出一段 summary / digest
   - 新 session 只吃这段摘要，再重新开局

2. `Trimmed Resume`

   - 旧 session / raw history
   - 不做全文摘要重写
   - 保留对话骨架，只裁剪 / 折叠低价值消息
   - 新 session 吃的是“裁剪后的消息视图”

当前最新判断是：

- `Summarized Resume` 更适合视作一种基础 handoff 编译能力
- `Trimmed Resume` 才更接近产品上真正有实用价值的“轻量加载”

因此如果后续需要继续落实现实产品形态，`Trimmed Resume` 应优先于 `Summarized Resume` 成为主线。

### 10.3 为什么“交接包编译”是一个非常关键的新说法

这轮讨论里，后来越来越不满足于只说：

- compact 和 restart 应绑定

因为这个说法还不够精确。

真正需要额外强调的是：

- 普通 restart 只是在搬运一个 snapshot
- compact restart 需要先改造 snapshot 的输入材料

也就是说，在 compact 里，真正多出来的不是“又一次 restore”，
而是 restore 之前那一步：

> handoff package compilation

这是后续最可能真正长出系统复杂度的地方。

### 10.4 这一步编译，至少可能涉及哪些工作

虽然现在没有定案，但根据讨论，至少可能包括：

- 从 raw history 中选择要摘要的段
- 识别要 verbatim 保留的 recent segment
- 识别可以从 runtime state 重建的内容
- 重新形成 compact summary
- 形成 compact boundary metadata
- 将必要 artifacts 变成可再次注入的材料

所以 compact 不是：

- “压缩一下 context”

而更像：

- “把旧运行时包装成一个新的可继续运行起点”

### 10.5 为什么当前第一步更适合 `history-only handoff`

到这里，讨论后期又有一个很重要的进一步收束：

当前第一版更适合先做：

- `history-only handoff`
- 手动触发的 `Compacted Resume`
- 独立于现有 session snapshot 的交接包文件

而不适合先做：

- feature-state-aware 的完整 successor
- 自动阈值触发 compaction
- live runtime 内原地上下文改写

这样选择的原因是：

1. 它不会污染现有 `Exact Restore` 语义。  
2. 它能先验证“交接包是否真有用”。  
3. 它把更危险的 feature continuity、lineage、自动化策略问题后置。  

### 10.6 Flow 场景下为什么不能只靠当前节点 prompt

随着讨论推进，又额外暴露出一个 flow 相关的重要事实：

- 当前 flow 的 workflow / node prompt 主要是为“运行中的状态机提醒”设计的
- 它们的触发时机是 `on-enter / every-step / every-call / every-n-calls`
- 它们更像 operational prompt，而不是 cold-start resume prompt

因此，在 compacted resume 场景下，不能简单假设：

- 恢复当前 active node
- 再把当前节点 prompt 打进去

就足够让模型重新理解上下文。

更准确地说：

> flow 当前的提示词体系，更像阶段性增量提醒；它并不是为“失去大部分历史后重新起步”设计的完整恢复语义。

### 10.7 Flow-aware handoff 更适合增加哪些对象

当前讨论里，对 flow 的更稳妥补法不是“让每个节点都兼任冷启动 prompt”，而是单独增加一条 resume-aware 语义线，例如：

- `Workflow Resume Primer`
- `Node Resume Primer`
- `Resume Anchor`
- `Progress Ledger`

它们分别回答：

- 这条 workflow 整体在干什么
- 当前阶段在干什么
- 从哪里重新讲起最合适
- 到目前为止实际完成了什么

尤其需要强调的是：

- 当前 flow state 虽然保存了 `activeFlowId / currentNodeId / nodeHistory`
- 但并不会结构化保存每个节点的完成结果与阶段产出

这意味着未来如果要做 flow-aware compacted resume，
真正不可缺的一层，往往不是“再写一段更完整的 prompt”，
而是：

> 让 flow 拥有一份可恢复的阶段进展账本（progress ledger）。

### 10.8 这也说明 compaction policy 和 compaction result shape 应尽量分开讨论

这轮讨论后期其实已经隐约形成这个分离：

- `Compaction Policy`
  - 何时压
  - 压哪一段
  - 保留哪一段

- `Compaction Result`
  - summary
  - boundary
  - kept segment
  - artifacts
  - lineage metadata

这两个问题很容易被混在一起，但最好分开。

否则讨论很快会在下面几类问题之间跳来跳去：

- “token 到多少触发”
- “summary 怎么写”
- “feature state 怎么恢复”
- “messagesToKeep 如何选择”

分离之后，思路会清晰很多。

---

## 十一、当前代码最值得关注的 seam

下面按主题列出后续继续调查时最值得追踪的位置。

### 11.1 Agent runtime / session restore

- [node_modules/agentdev/src/core/agent.ts](../node_modules/agentdev/src/core/agent.ts)
  - `createSessionSnapshot()`
  - `restoreSessionSnapshot()`
  - `rollbackToCall()`
  - `saveSession()`
  - `loadSession()`
  - `captureRuntimeSnapshot()`
  - `restoreRuntimeSnapshot()`

- [node_modules/agentdev/src/core/session-store.ts](../node_modules/agentdev/src/core/session-store.ts)
  - `AgentRuntimeSnapshot`
  - `AgentSessionSnapshot`
  - `FileSessionStore`

### 11.2 Context data structure

- [node_modules/agentdev/src/core/context.ts](../node_modules/agentdev/src/core/context.ts)
  - `messages`
  - `enrichedMessages`
  - `toJSON()`
  - `restore()`
  - `addUserMessage()`
  - `addAssistantMessage()`
  - `addToolMessage()`
  - `addSystemMessage()`

这个文件特别值得关注，因为它现在同时承担了：

- raw message container
- enriched metadata
- snapshot serialization

但尚未显式区分 raw log 与 prompt view。

### 11.3 ReAct loop / live rollback

- [node_modules/agentdev/src/core/agent/react-loop.ts](../node_modules/agentdev/src/core/agent/react-loop.ts)
- [node_modules/agentdev/src/core/checkpoint.ts](../node_modules/agentdev/src/core/checkpoint.ts)

这条链告诉我们：

- live rollback 是怎么工作的
- 当前 step 内的失败回滚为什么天然属于“原地语义”
- 它为什么不适合作为 compact 的首选模型

### 11.4 Feature snapshot culture

可优先看这些样本：

- [local-features/flow/src/index.ts](../local-features/flow/src/index.ts)
- [node_modules/agentdev/src/features/todo/index.ts](../node_modules/agentdev/src/features/todo/index.ts)
- [node_modules/agentdev/src/features/visual/index.ts](../node_modules/agentdev/src/features/visual/index.ts)
- [node_modules/agentdev/src/features/audio-feedback/index.ts](../node_modules/agentdev/src/features/audio-feedback/index.ts)
- [node_modules/agentdev/src/features/subagent/index.ts](../node_modules/agentdev/src/features/subagent/index.ts)
- [local-features/agent-dev/src/index.ts](../local-features/agent-dev/src/index.ts)

### 11.5 Product runtime restart seam

后续如果 compact 真要走 successor session / successor runtime 方向，产品层这些位置也会很关键：

- [scripts/run-prebuilt-agent.js](../scripts/run-prebuilt-agent.js)
- [server.js](../server.js)
- [public/src/app-main.js](../public/src/app-main.js)

它们对应：

- 运行时拉起
- restart 路由
- 前端侧 restart 触发

### 11.6 还值得关注的几类文件

除了直接和 restore / restart 相关的位置，后续继续接这条线时，还建议顺手关注下面几类文件。

#### A. Feature 基础契约

- [node_modules/agentdev/src/core/feature.ts](../node_modules/agentdev/src/core/feature.ts)

特别要关注：

- `captureState()`
- `restoreState()`
- `beforeRollback()`
- `afterRollback()`
- `getContextInjectors()`

因为这决定了 feature 究竟以什么方式参与 handoff。

#### B. 当前最重的系统 feature 样本

- [local-features/flow/src/index.ts](../local-features/flow/src/index.ts)
- [node_modules/agentdev/src/features/subagent/index.ts](../node_modules/agentdev/src/features/subagent/index.ts)
- [node_modules/agentdev/src/features/visual/index.ts](../node_modules/agentdev/src/features/visual/index.ts)
- [node_modules/agentdev/src/features/todo/index.ts](../node_modules/agentdev/src/features/todo/index.ts)
- [node_modules/@agentdev/audit-feature/dist/index.js](../node_modules/@agentdev/audit-feature/dist/index.js)

这些 feature 是最能暴露 compaction 难点的地方，因为它们分别代表：

- flow runtime
- live subagent runtime
- heavy contextual injection
- task state
- hook-driven guardrail injection

另外，flow 这条线后续如果真的新增 `resume primer / resume anchor / progress ledger` 一类能力，
那么需要同时意识到：

- 这不只是 runtime state 问题
- 它还会触碰 flow graph schema 与 flow editor 这两个产品契约面

因此还建议一并关注：

- [local-features/flow/src/types.ts](../local-features/flow/src/types.ts)
- [public/flow-editor.js](../public/flow-editor.js)
- [server.js](../server.js)

因为这些位置共同决定了：

- flow 图 JSON 能表达什么字段
- 编辑器是否暴露这些字段
- runtime 从图文件到运行时 FlowGraph 的映射是否兼容

#### C. 当前装配运行时入口

- [prebuilt-agents/official/flow-workspace/agent.js](../prebuilt-agents/official/flow-workspace/agent.js)
- [scripts/run-prebuilt-agent.js](../scripts/run-prebuilt-agent.js)

因为这里决定了：

- 新 agent 是怎样被组装出来的
- feature 在 restore 前后以什么顺序挂载
- flow runtime 是何时被注入

### 11.7 哪些 seam 看起来顺势，哪些 seam 看起来危险

从当前调查结果出发，大致可以做一个还不算定案的判断：

#### 顺势 seam

- session snapshot schema
- fresh instance `loadSession()`
- product runtime restart path
- feature-level serializable state capture

#### 危险 seam

- live `Context` 原地重写
- 当前 ReAct loop 内部插入大规模 compaction 逻辑
- 把 rollback 路径硬改造成 compact 路径
- 假设所有 feature 都能无损续命

这类“顺势 / 危险”判断虽然不是绝对真理，但很值得保留给接棒者。

---

## 十二、当前最值得保留的几个工作概念

下面这些概念在讨论里很有帮助，但都还不应该视作最终框架术语。

### 12.1 Raw Log

真实发生过的消息历史。

### 12.2 Runtime State

不应完全依赖历史消息承载的活状态。

### 12.3 Prompt View

下一次真正发给模型的上下文视图。

### 12.4 Rehydratable Artifact

适合压缩后再注入，而不是自由落入 summary 的上下文工件。

### 12.5 Context Compiler / Prompt Rebuilder

未来可能需要的一类能力：  
把 raw log + runtime state 编译成新的 prompt view。

### 12.6 Handoff Package

一个比早期“successor snapshot”更稳妥的中间对象。

它回答的是：

> 旧会话到底要把什么材料交给新会话、分支运行体或其他消费者。

当前更稳的产品化落点是：

- 先让它成为独立工件
- 先让它和 session snapshot 分离
- 先用它支撑手动 `Compacted Resume`

### 12.7 Exact Restore / Compacted Resume / Fork Branch

后期讨论里，几个动作的边界也逐渐清楚起来：

- `Exact Restore`
  - 回到原来的会话现场
- `Compacted Resume`
  - 带着交接包，在新会话继续同一任务
- `Fork Branch`
  - 从当前任务分出一条新支线

其中“压缩”本身更适合作为：

- 上下文变换步骤

而不是：

- 与这些动作并列的终点动作

### 12.8 Compaction Policy

何时压、压哪一段、保留哪一段。

### 12.9 Semantic Boundary

不是只靠 token，而是借助 flow / task / phase 边界辅助决定压缩时机。

### 12.10 Successor Session / Successor Agent

压缩后不继续污染 live agent，而是交给一个新 runtime 继续。

这个说法在当前仍值得保留，但应更多被当成：

- 一个工作直觉
- 一个远期可能形态

而不是当前第一版必须立即兑现的产品承诺。

### 12.11 Flow Resume Primer / Resume Anchor / Progress Ledger

这是在 flow 场景里后期新增的一组更细的工作概念：

- `Resume Primer`
  - 重新解释当前 workflow / node 的背景
- `Resume Anchor`
  - 指示从哪一个阶段重新讲起最合适
- `Progress Ledger`
  - 记录到目前为止实际完成了什么

它们之所以值得保留，是因为当前 flow prompt 更像运行中提醒，而不是冷启动恢复语义。

这些概念对思考有帮助，但都还应该保持开放。

### 12.12 这些概念之间的关系，可以先这么理解

为了避免这些工作概念看起来像一堆散点，这里补一个更直观的关系图式描述。

#### A. 输入侧

- `Raw Log`
- `Runtime State`

#### B. 策略侧

- `Compaction Policy`
- `Semantic Boundary`

#### C. 编译侧

- `Context Compiler / Prompt Rebuilder`

#### D. 结果侧

- `Prompt View`
- `Rehydratable Artifact`
- `Handoff Package`

#### E. 交接侧

- `Exact Restore / Compacted Resume / Fork Branch`

如果写成一句更顺的描述，可以理解成：

> 在某个 semantic boundary 上，依据 compaction policy，用 context compiler 从 raw log 和 runtime state 编译出新的 prompt view、rehydratable artifacts 与 handoff package，并把它们交给 exact restore、compacted resume 或未来的 fork / successor 消费路径。

这个句子本身不一定会成为最终框架文案，但它很好地概括了这轮讨论的后期直觉。

### 12.13 为什么要刻意保留这些“半成品概念”

因为这类线索如果不被记下来，后续接棒的人很容易重复经历一遍：

- 先把问题想成摘要
- 再发现不够
- 再想到记忆分层
- 再发现还是太高层
- 最后才回到 runtime handoff

保留这些半成品概念的价值，不在于让人照抄，而在于减少重复兜圈。

---

## 十三、当前尚未定案、应该明确保持开放的问题

为了避免后续接手的人误把本文当定案，这里专门列出未定问题。

### 13.1 第一版 handoff package 是否只做 `history-only`

当前讨论已经明显偏向：

- 第一版先做 `history-only`
- 先不承诺 feature-state-aware 的完整 successor

但这里仍需明确产品边界：

- `history-only` 到底包含哪些消息
- 是否先做规则型裁剪再做摘要
- recent segment 要不要保留 verbatim

### 13.2 compact 发生时，旧 agent 是否必须彻底终止

如果未来真的进入自动 compact / successor 语义，当前直觉仍偏向“旧 agent 不再继续其循环”，但：

- 是立即退出
- 还是只冻结
- 还是保留只读 transcript

都还未定。

### 13.3 `Exact Restore` 与 `Compacted Resume` 的产品动作如何呈现

这里虽然已经有比较明确的方向，但仍有一些产品细节未定：

- 它们是两个独立按钮，还是同一入口下的两种模式
- `Compacted Resume` 是否默认创建新 session
- handoff package 是否对用户显式可见

当前偏向是：

- 产品上应显式区分
- `Compacted Resume` 更适合创建新 session
- handoff package 至少在调试 / 审计层面应可见

但最终 UI 形态还未定。

### 13.4 flow / feature 注入消息到底属于“历史”还是“可重建工件”

例如：

- 当前节点 prompt
- flow warning
- feature reminder
- audit 拦截提示

它们的归类方式还没有定。

### 13.5 flow-aware resume 是否要正式引入 primer / anchor / ledger 契约

当前讨论已经出现比较明确的方向：

- `Workflow Resume Primer`
- `Node Resume Primer`
- `Resume Anchor`
- `Progress Ledger`

但这里还没有正式定案：

- 它们是否真的进入 flow graph schema
- 是 runtime 内部生成，还是图作者显式填写
- 编辑器是否要暴露这些字段

这部分一旦落地，就已经不是纯 runtime 改动，而是产品契约变更。

### 13.6 compact 是否应该优先依赖 token 阈值，还是优先依赖语义边界

目前直觉偏向“两者结合”，但比例、优先级、冲突时机都未定。

### 13.7 feature 恢复前后生命周期是否需要调整

当前 restore 流程是：

1. `ensureFeatureTools()`
2. `onInitiate()`
3. `restoreSessionSnapshot()`

这意味着：

- feature 先启动，再恢复状态

这个顺序对 compact successor 是否足够好，还未定。

### 13.8 compact boundary / handoff 该不该对用户可见

如果真的走 successor / handoff 路线，就会出现一个产品层问题：

- 压缩边界是内部技术事件
- 还是用户可感知的会话接力节点

两边各有道理：

- 不可见：更顺滑，不打断使用
- 可见：更诚实，也更便于调试和回溯

当前对此没有定案。

### 13.9 `Compacted Resume` 是否应当拥有新的 session id

这其实是一个非常具体但很重要的问题：

- `Compacted Resume` 是沿用旧 session id
- 还是新建一个 session id，然后记录 predecessor / sourceSessionId

它会影响：

- transcript 管理
- 调试器展示
- 运行时 reconnect
- UI 中“这是同一段任务还是新一段任务”的表达

当前偏向是“新建 session id”，原因是：

- 它能更清楚地区分 `Exact Restore` 与 `Compacted Resume`
- 它能避免把压缩后的 prompt view 与原始历史混成同一个会话事实

但仍未正式拍板。

### 13.10 compact 后的 rollback 语义如何定义

这是当前文档里还没有真正展开、但后续几乎一定会碰到的问题：

- compact 前的 call rollback 还能否继续使用
- successor 生成后，旧 checkpoint 是继承、冻结，还是截断
- rollback 到 compact 前的某一步时，是回到旧 runtime，还是生成另一条新 successor

这类问题当前完全没有定案，但后续一定要正视。

### 13.11 调试器与日志如何描述 compact lineage

如果 compaction 真成了一等事件，调试器和日志侧也会有需求：

- boundary 如何展示
- predecessor / successor 如何跳转
- overview 是否要显示 lineage
- 用户看到的是一个 session，还是一串 linked sessions

目前都还没有结论。

---

## 十四、当前较稳定但仍非定案的方向判断

下面这些判断目前看相对稳定，但仍不应视作最终定案。

### 14.1 不应先从 OS 顶层抽象倒推实现

### 14.2 上下文压缩不应首先被理解为“摘要 feature”

### 14.3 更贴近现实的理解是“上下文重建 / prompt rebuild”

### 14.4 更合适的第一中间对象是 `Handoff Package`

也就是说，当前更该优先建设的不是：

- 直接修改 core restore 语义
- 直接承诺完整 successor runtime

而是：

- 让旧 session 能稳定产出一份可审计、可复用的 handoff package

### 14.5 在当前代码和 feature 状态文化下，压缩更适合沿着 session handoff / compacted resume 方向探索

### 14.6 不应为了压缩去污染 live agent 的当前循环

### 14.7 与其讨论“统一记忆 ontology”，不如先讨论“交接包、边界、再水化、恢复 seam”

### 14.8 当前更应优先关注“谁拥有 prompt view 组装权”

这轮讨论里，虽然没有把它写成最中心的一句话，但实际上有一个非常强的隐含判断：

> 真正的难点不是摘要模型，而是“谁拥有下一次 prompt view 的最终组装权”。

如果这个问题不解决，那么所谓 compaction 很容易退化成：

- 再往 context 里 `add()` 一条 summary 消息

而不是：

- 真正改变下一次模型看到的上下文结构

所以这是一个虽然没被完全展开、但实际非常值得保留的稳定方向判断。

### 14.9 当前更值得先证明“handoff package + compacted resume 可行”，而不是先证明“摘要优秀”

换句话说，后续探索的优先级也许应当是：

1. 先证明旧 session 能产出有用的 handoff package
2. 先证明新 session 能消费它并形成稳定的 compacted resume
3. 再去优化 summary 质量、artifact 结构、policy 细节

因为如果交接包和消费路径本身不成立，那么再漂亮的 summary 都只是局部优化。

### 14.10 flow 恢复不能只依赖现有节点 prompt

在 flow 场景下，当前更稳的判断是：

- 现有节点 prompt 更像运行中提醒
- compacted resume 需要额外的恢复语义
- 将来大概率需要 `primer / anchor / progress ledger` 一类补充对象

---

## 十五、后续继续讨论时更建议采用的问题顺序

如果后续 agent 要继续接这条线，更建议按下面顺序，而不是同时讨论所有层面：

### 第一层：产品动作先分清

- `Exact Restore` 到底是什么
- `Compacted Resume` 到底是什么
- `Fork Branch` 是否进入当前讨论范围

### 第二层：handoff package 最小形态

- 第一版是否只做 `history-only`
- 哪些字段必须进 handoff package
- handoff package 是否独立于 session snapshot

### 第三层：消费路径

- 新 session 如何消费 handoff package
- 当前 system prompt 与交接包如何组合
- 是否需要新 session id

### 第四层：flow-aware resume

- 当前 flow prompt 哪些只是运行中提醒
- 是否需要 primer / anchor / progress ledger
- 哪些字段会触碰 flow graph schema 与 editor

### 第五层：trigger policy

- token threshold
- semantic boundary
- manual compact
- auto compact

### 第六层：高层信息生命周期

- 遗忘
- 压缩
- 冷冻
- 长短期信息流动

按这个顺序会比一开始就谈“记忆哲学”更稳。

### 15.1 为什么这个顺序刻意把“高层信息生命周期”放在最后

不是因为它不重要，而是因为：

- 它太容易吸走讨论注意力
- 它很容易产出一套很完整的世界观语言
- 但这些语言如果脱离 runtime seam，很快会失真

所以把它放在最后，是一种刻意的顺序控制：

- 先用 runtime 事实约束抽象
- 再让抽象去解释更高层的产品现象

### 15.2 如果后续必须立即做代码实验，更适合从哪一层开始

虽然本文不是实施计划，但基于这轮讨论的气味，最适合做实验的顺序仍可简要记一下：

#### 先实验

- handoff package 的最小可行 producer
- 手动 `Compacted Resume` 的最小可行 consumer
- history-only 路径下的规则型裁剪与摘要
- flow 场景下最小的 progress ledger 记账

#### 后实验

- feature-state-aware 的完整 successor
- 自动语义边界
- 更复杂的长期信息提取
- clone-like subagent / fork 路径

这不是因为后者不重要，而是因为前者更能快速暴露 framework seam 是否真实存在。

### 15.3 接棒者最不应该做的几件事

为了避免后续重复踩坑，这里顺手记下几条讨论中已经隐含反对的做法：

- 不要一上来把问题定义成“做个 summary feature”
- 不要一上来设计统一记忆 ontology
- 不要先把 compaction 硬塞进 rollback 模型
- 不要先修改 core restore 语义来伪装 compacted resume
- 不要先把 restart 按钮偷偷升级成 compact restart
- 不要默认 `Context` 当前结构就足以承载最终方案
- 不要把“同一实例原地续命”当作默认正确方向

这些不是绝对禁令，但至少从这轮讨论看，都不是首选起点。

---

## 十六、总结

这轮讨论最值得保留的，不是某个最终方案，而是下面几条边界意识：

1. 当前讨论里同时存在“高层信息管理”和“底层 runtime 能力”两层问题，不能混谈。  
2. 对 AgentDevClaw 来说，上下文压缩更接近“上下文重建 / prompt rebuild”，而不是“简单摘要”。  
3. Claude Code 的实践真正有启发的地方，不是某条提示词，而是：压缩后消息视图是被重新构造出来的，而且很多上下文依赖 rehydration。  
4. 当前项目不应先从 OS 顶层设计倒推实现，而应先让系统级能力在 feature / runtime seam 上逼出真实约束。  
5. 讨论后期形成的一个更稳方向是：先把压缩落实成 `Handoff Package -> Compacted Resume` 这条手动路径，而不是先承诺完整 successor runtime。  
6. 当前代码里的 session restore 语义更接近 `Exact Restore`，默认是在延续旧上下文，而不是“当前 system prompt + 新编译视图”。  
7. 因此 compaction 不应伪装成普通 restart / resume，而应被建模成独立的产品动作与中间工件。  
8. 在 flow 场景下，现有节点 prompt 更像运行中提醒；真正稳定的 compacted resume 很可能还需要 primer / anchor / progress ledger 一类补充对象。  
9. 但“handoff package 的最终形态是什么”“flow 恢复契约是否要进图 schema”“future successor 的最终命名和身份边界如何表达”等关键问题，目前都还没有定案。

一句话总结：

> 这条线当前最值得守住的，不是某个具体名词，而是三条边界：不要污染 live agent 循环；不要混淆 exact restore 与 compacted resume；先把 handoff package 做成独立、可审计、可复用的中间层。

---

## 十七、讨论脉络速记

为了让接棒者更快领会“我们是怎么一步步走到这里的”，这里再用近似时间顺序补一版简化脉络。

### 阶段一：从系统 feature 缺口谈起

最早的视角是：

- 项目想往 OS 方向走
- 但底子不扎实
- 系统 feature 太少
- flow 闭环还不够

在这个语境里，“上下文压缩”被提出为一个非常棘手、但显然绕不过去的问题。

### 阶段二：先把问题看成系统能力，而不是 OS 定案

随后讨论逐渐把重心落到：

- 先别讨论 OS 世界观
- 先看哪些系统能力值得增强或新写 feature

这一阶段还会自然地把问题分成：

- 上下文
- 任务/事件
- 异步交互

### 阶段三：发现“上下文 feature”这个说法太大、太危险

接着很快意识到：

- “上下文管理”太像总控中枢
- 它会过早引入 agent 统一性格
- 会把讨论变成记忆 ontology 之争

因此这时开始主动收窄：

- 不先谈统一记忆模型
- 先谈上下文生命周期和上下文重建

### 阶段四：明确高层和底层不在一层

这是一个关键纠偏点。

用户指出：

- 关心的是 runtime 是否承受得了大规模上下文改写
- 而不是先讨论高层信息分层

这个提醒使讨论明显从：

- 记忆 / 信息管理

转向：

- restore / restart / prompt rebuild / loop pollution

### 阶段五：引入 Claude Code 实践，重新理解“压缩”

Claude Code 的调查让讨论获得了新的支点。

这时出现了一个很重要的转向：

- 压缩不是“提炼信息”
- 压缩是“重建下一次送给模型的消息视图”

由此带来了：

- raw log
- runtime state
- prompt view
- rehydratable artifact

这些工作概念。

### 阶段六：出现“successor 而非原地再生”边界

用户提出了一个更强的方向：

- 压缩与重启应并列发展
- 新 agent 永远不是旧 agent
- 不要污染 live agent 循环

这一步实际上把整个问题从“上下文怎么压”推向了：

- 会话接力怎么定义

### 阶段七：代码调查验证这条边界并非空想

进一步调查后发现：

- rollback 是原地恢复
- session restore 则天然是 fresh instance continuation
- product runtime 也已经有 restart / respawn 逻辑

这使得 successor handoff 从“概念想象”变成了“顺着现有 seam 继续延长”。

### 阶段八：最终收敛到当前的暂时结论

最后并没有得出一个完整方案，而是收敛到几条边界：

- 不要先 OS 化
- 不要先 ontology 化
- 不要先摘要 feature 化
- 更适合沿 session handoff / successor 路线看
- compaction 的关键在于 context rebuild，而不只是 summary

也就是说，这轮讨论的最大成果不是方案，而是：

> 知道哪些路现在不该先走，以及为什么。

---

## 十八、代码索引补充表

下面再额外补一版更适合快速浏览的索引表。

### 18.1 会话恢复 / 接力

| 主题 | 文件 | 关注点 |
|------|------|--------|
| runtime snapshot 定义 | [session-store.ts](../node_modules/agentdev/src/core/session-store.ts) | `AgentRuntimeSnapshot`、`AgentSessionSnapshot` |
| 创建 session snapshot | [agent.ts](../node_modules/agentdev/src/core/agent.ts) | `createSessionSnapshot()` |
| 恢复 session snapshot | [agent.ts](../node_modules/agentdev/src/core/agent.ts) | `restoreSessionSnapshot()` |
| 从持久化加载 | [agent.ts](../node_modules/agentdev/src/core/agent.ts) | `loadSession()` |
| session 恢复测试 | [session-restore.test.ts](../node_modules/agentdev/src/test/session-restore.test.ts) | fresh agent 恢复旧 session |
| 运行时拉起与 restore | [run-prebuilt-agent.js](../scripts/run-prebuilt-agent.js) | runtime start / loadSession |

### 18.2 原地回滚

| 主题 | 文件 | 关注点 |
|------|------|--------|
| step checkpoint | [checkpoint.ts](../node_modules/agentdev/src/core/checkpoint.ts) | `createStepCheckpoint()` |
| step rollback | [checkpoint.ts](../node_modules/agentdev/src/core/checkpoint.ts) | `rollbackToStepCheckpoint()` |
| react loop 内触发 rollback | [react-loop.ts](../node_modules/agentdev/src/core/agent/react-loop.ts) | step 出错回滚 |
| call rollback API | [agent.ts](../node_modules/agentdev/src/core/agent.ts) | `rollbackToCall()` |
| rollback API test | [rollback-call-api.test.ts](../node_modules/agentdev/src/test/rollback-call-api.test.ts) | 原地回滚后继续分支 |

### 18.3 Context 结构

| 主题 | 文件 | 关注点 |
|------|------|--------|
| 原始消息数组 | [context.ts](../node_modules/agentdev/src/core/context.ts) | `messages` |
| 丰富化消息数组 | [context.ts](../node_modules/agentdev/src/core/context.ts) | `enrichedMessages` |
| 序列化与恢复 | [context.ts](../node_modules/agentdev/src/core/context.ts) | `toJSON()`、`restore()` |
| 消息写入入口 | [context.ts](../node_modules/agentdev/src/core/context.ts) | `addUserMessage()`、`addAssistantMessage()`、`addToolMessage()`、`addSystemMessage()` |

### 18.4 Flow 与重状态 feature

| 主题 | 文件 | 关注点 |
|------|------|--------|
| Flow runtime state | [local-features/flow/src/index.ts](../local-features/flow/src/index.ts) | `captureState()`、`restoreState()` |
| Todo task state | [todo/index.ts](../node_modules/agentdev/src/features/todo/index.ts) | serializable task runtime |
| Visual runtime state | [visual/index.ts](../node_modules/agentdev/src/features/visual/index.ts) | 注入状态与缓存状态 |
| Subagent runtime state | [subagent/index.ts](../node_modules/agentdev/src/features/subagent/index.ts) | degraded restore |
| Audio feedback mode/state | [audio-feedback/index.ts](../node_modules/agentdev/src/features/audio-feedback/index.ts) | mode + state snapshot |

### 18.5 产品层 restart / respawn

| 主题 | 文件 | 关注点 |
|------|------|--------|
| managed runtime restart | [server.js](../server.js) | start / restart agent 路径 |
| 前端 restart 触发 | [public/src/app-main.js](../public/src/app-main.js) | UI 行为 |
| flow workspace 装配恢复 | [flow-workspace/agent.js](../prebuilt-agents/official/flow-workspace/agent.js) | feature mount + runtime config + flow mount |

### 18.6 Flow 图契约 / 编辑器

| 主题 | 文件 | 关注点 |
|------|------|--------|
| FlowGraph / FlowNode schema | [local-features/flow/src/types.ts](../local-features/flow/src/types.ts) | prompt、状态、未来 primer / anchor / ledger 落点 |
| flow 图读写 API | [server.js](../server.js) | graph 文件持久化与 runtime 映射 |
| flow 编辑器 | [public/flow-editor.js](../public/flow-editor.js) | 哪些恢复字段会成为真实产品契约 |

### 18.7 当前已落地进度（截至本轮）

这一小节专门记录“已经做出来了什么”，避免后续阅读者把本文全部内容都当成纯讨论。

当前已经落地的部分主要有三块：

1. **Handoff package 导出链已存在**

   相关文件：

   - [server/context-continuity/handoff-package.js](../server/context-continuity/handoff-package.js)
   - [server.js](../server.js)

   当前状态：

   - 服务端已经支持从旧 session 导出 handoff package
   - handoff package 已经不再只是 summary 文本
   - 最新主形态是 `seedMessages + policy + stats`

2. **Runtime handoff seed 注入链已存在**

   相关文件：

   - [scripts/run-prebuilt-agent.js](../scripts/run-prebuilt-agent.js)
   - [local-features/context-handoff-seed/src/index.ts](../local-features/context-handoff-seed/src/index.ts)

   当前状态：

   - runtime 启动时可消费 handoff package
   - 首次 `CallStart` 会注入 handoff seed
   - 现在支持回放裁剪后的 `system / user / assistant` 消息，而不只是注入一段 summary

3. **Trimmed Resume 的第一版已经代替 Summarized Resume 成为默认演示路径**

   当前默认 policy 不是“摘要续接”，而是：

   - 保留全部 `user / assistant` 对话
   - 折叠全部 tool activity
   - 不恢复旧 runtime snapshot
   - 用“裁剪后的消息视图”作为新 session 的启动种子

   这意味着：

   - 现在的默认演示形态已经更接近 `Trimmed Resume`
   - 之前那种 summary-only handoff 仍然算有底层价值，但已经不应再被理解成主线形态

此外，这轮落地里还顺手修掉了一个影响演示的回归问题：

- 预制 workspace agent 启动后返回给前端的 `agent` 对象过瘦，曾导致 `workspace_sessions` 被覆盖为空
- 当前已在 [server.js](../server.js) 中修复返回链，使预制 workspace 的启动/切换不再轻易把历史列表冲空

### 18.8 当前默认 trim policy 的真实语义

这部分必须明确写下来，因为它已经不是纯讨论，而是会直接影响体验判断。

当前默认 trim policy 更接近：

- `keepRecentTurns = null`
- `includeUserMessages = true`
- `includeAssistantMessages = true`
- `assistantToolCallMode = fold`
- `toolMessageMode = fold`
- `toolFoldScope = all`

对应到直观语义就是：

> 对话尽量原样保留，工具活动全部折叠。

因此它不是：

- 纯摘要
- 只保留最近 N 轮
- 精确恢复旧 session snapshot

而是：

- 一种以“保留对话骨架 + 折叠工具噪音”为核心策略的 `Trimmed Resume`

### 18.9 本轮还顺手修正的一个质量问题

在 trim 实测中，发现一个很具体的质量瑕疵：

- 旧实现会把正文中的换行、段落、列表结构压平
- 导致新会话读到的 handoff 内容像连成一整块字

这个问题已经在 [server/context-continuity/handoff-package.js](../server/context-continuity/handoff-package.js) 修正：

- 元数据使用单行清洗
- 对话正文使用多行清洗
- 保留段落换行和单个空行

这意味着当前 trim 导出的对话视图已经开始具备“可读性”，而不是只有“信息被保留”。

---

## 十九、从当前大局看，接下来最该做什么

如果从当前全局进度出发，而不是从最早的讨论出发，下一步不应该再回去强化 summary-only 路线，也不应该急着讨论 successor OS 化。

更合理的主线应是：

### 19.1 先把 `Trimmed Resume` 做成真正稳定、可调策略的主线

这是当前最值得继续投资的地方。

原因：

- 它已经有初步实现
- 用户心智清晰
- 实用价值高
- 不要求先解决 feature-state continuity

接下来最具体应推进的是：

1. 补齐 trim policy 的前端可调入口  
   例如：
   - 保留最近多少轮对话
   - tool 全折叠还是只折叠最近 N 轮
   - assistant tool call 是 keep / fold / drop

2. 让 policy 可审计、可复现  
   也就是让用户能明确知道：
   - 这次 resume 用了什么裁剪策略
   - 不是一个黑箱压缩

3. 继续打磨 trim 的展示质量  
   例如：
   - 折叠 tool activity 的文本格式更清晰
   - 列表、段落、代码块在 handoff 中尽量不损失可读性

### 19.2 把 `Summarized Resume` 明确降级成“基础能力”，不要再当主产品动作

这不是说它没有价值，而是它更适合作为：

- 极端压缩场景的 fallback
- 多 agent handoff 的基础设施
- 以后 summary + trim hybrid policy 的组成部分

但它不应再被理解成你当前要打磨的主演示路线。

### 19.3 在 trim 稳定之前，不要提前深挖 Flow-aware successor

Flow 这条线仍然重要，但当前最危险的误区是：

- 一边 trim 主线还没稳定
- 一边就去追 flow primer / anchor / progress ledger 的全套语义

更稳的顺序应该是：

1. 先把普通 session 的 trim resume 做稳定  
2. 再明确哪些 flow 问题是 trim 无法覆盖的  
3. 再为 flow 单独设计 resume-aware 语义层  

也就是说，Flow 现在更适合“下一阶段的专门子问题”，而不是“此刻继续扩展主线复杂度”。

### 19.4 不要现在就去改 AgentDev core contract

当前这条线之所以还算健康，一个关键原因就是：

- 到目前为止，大部分能力都还在 Claw app/runtime 层完成
- 还没有强行把它上升成 AgentDev core 的统一抽象

这依然是对的。

下一步除非出现明确的重复阻力，否则不要急着引入：

- `Prompt View` 正式一等对象
- `Context Compiler` 正式框架接口
- `captureHandoffState()` 一类新的 feature-level core contract

### 19.5 最实际的下一里程碑

如果只从“业务上最值得交付的下一点”来看，当前最合适的下一里程碑是：

> 把 `Trimmed Resume` 变成一个可选策略、可稳定演示、可明确解释的正式主入口。

比起继续扩大范围，更值钱的是把下面这件事彻底做扎实：

- 用户知道自己是在 `Trimmed Resume`
- 用户知道 tool activity 被怎么处理了
- 用户知道保留了多少轮对话
- 用户能明显感受到它比 summary-only 更可用

如果这一步成立，后面很多更大的问题才值得继续推进：

- flow-aware resume
- hybrid trim + summary
- fork / branch handoff
- feature-state-aware continuation
