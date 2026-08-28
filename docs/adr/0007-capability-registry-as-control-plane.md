# ADR 0007: Capability Registry as the Unified Control Plane

日期：2026-08-25
状态：已接受（P0/P1 已落地，P2/P3 待启动）

## 背景与问题

"控制 Agent 的能力"散落在四个互不相识的地方：前端专属模块、专属 HTTP route、专属 IPC 消息、`handleIPC` 专属分支。每新增一个可控 feature 都要重复这套"四件套"（force-continuation 与 context-guard 的 IPC 分支几乎逐行同构，是项目在自发收敛的证据）。同时 feature 之间只有 `getFeature` 直引一条强耦合通路：无事件、无广播、要 import 对方类型。

外部需求是补上 slash 命令系统（`/` 唤起菜单、显式调用能力）；内部需求是解决跨 feature 通讯。裁决：这两件事加上 flow 机制转生，是同一个东西——**统一的能力注册表（Capability Registry）**。

## 根本裁决

### 1. 命令式优先，不做状态传递

第一层一旦想成"状态共享/绑定"，就会滑进 ownership → 一致性 → 传播拓扑 → 依赖图的管理学滑坡。项目局部早已各自投票：FlowVariable 是 pull resolver、`exitWhen` 是轮询评估、checkpoint 是快照回灌——全是命令式/pull。

### 2. 三动词契约，没有第四个

```
invoke — 让 B 做某事（命令，request/ack，超时即失败）
query  — 问 B 现在怎么样（只读快照，永不缓存镜像）
emit   — 广播"X 已发生"（不可变事实；observe 是消费侧）
        — 不存在 bind / reactive / watch-state
```

负面清单（写进契约、不是待办）：**共享权威状态**、**跨 feature 事务**——出现这类需求时的正确答案是上移宿主层或重构，不是让注册表变复杂。

### 3. emit 用事实语义

事件是过去式、不可变的"X 已发生"，不携带当前状态、不节流（节流是消费端的事）。与框架 session-events（审计事实）对齐；UI 信号归 notification 体系。

### 4. 注册表是进程内语义

跨进程投递是宿主层（Claw server + IPC）的既有职责，注册表不为它建模。invoke 参数是普通 JS 值。宿主跨进程投影命令子集时自己定义投影协议。

### 5. 命令分域：宿主域直执，会话域转发

宿主域命令（`/new`、会话生命周期）前端直执——目标会话可能尚不存在，无处投递。会话域命令前端零语义、纯转发，权威在 agent 进程内注册表。命令清单是结构化数据（名称/参数 schema/kind/destination），触发源（slash / 调度 / IM / 无头 CLI）对链路透明。

### 6. kind 是声明，不是流程

`kind: 'invoke' | 'prompt'`（框架层缺省 invoke）。**框架对两种 kind 完全同质处理**——都是一条 invoke；全部行为差异（表单+执行+toast / pill+发送时附带激活+无 toast）是 Claw 应用层的消费逻辑。

- invoke 型：选中即执行（带参数则弹表单，参数 schema 复用 `FeatureManifestSettingProperty` 词汇表，`readCurrentValues()` 回显当前值，dirty-only 提交）。Claw 侧触发成功发 toast；feature 进程内调用不经过前端，天然无 toast。
- prompt 型：选中只挂 pill（显示短名、携带完整 ref），零触发。**激活通知由发送行为本身附带**（见裁决 8）。

### 7. 触发是结构化状态，不是字符串解析

pill 渲染出来的那一刻，选中事实已被输入框模块记住（结构化 `ref` 列表）。解析不依赖文本里存的是短名还是全名——显示归显示，触发归状态。曾经短暂实现过"user 消息文本 token 匹配注入"（onCallStart 解析 `/技能名`），已废弃：文本解析是错误方向，激活通知应随消息流动而非靠事后还原。

### 8. 激活随消息流动（activations travel with the turn）

prompt 型命令的激活通知是**用户回合的结构化组成部分**（`capabilityActivations: string[]`），沿完整发送链路流动：

```
前端发送（一次消费，失败归还）
 → POST /input 或 /protoclaw/user_turn（body 字段）
 → viewer：UserTurnInput 校验 → 队列/lease payload 持久化
 → 投递路径（三选一，全携带）：
    a. idle → input-response IPC payload → arbiter envelope → onCall 第 3 参
    b. busy → viewer 排队 → react-loop 步边界 addUserMessage
    c. 线程交接 → Thread 命令（core.appendCommand 持久化）→ 桥接 → 后继会话
 → Agent 在消息落地点 dispatch（executeCall 开头 / react-loop 边界）
 → feature.onCapabilityActivations(refs, {context}) 消费
```

消费点统一为 feature 可选方法 `onCapabilityActivations`，语义是"这些能力随这条消息激活了，feature 自行决定注入什么"——注入格式与时机完全是 feature 的领域（skill 注入 SKILL.md 全文于 system 位置，与 flow 提示词、force-continuation 续跑提示同形态）。

### 9. entryPoints 是契约约束兼访问控制，不是安全边界

缺省 `['feature']`（最小暴露）。slash 侧不可见即不可达；feature 侧被拒时 invoke 返回结构化错误 `entry_point_denied`。绕过路径依然存在（getFeature 直引），类比 TS 类型挡不住 any——这是已知边界而非漏洞。

### 10. 兜底审计

框架保证每次 invoke 的生命周期日志（成功 info / 契约拒绝 warn / 执行失败 error，namespace `capability`）不依赖 feature 自觉——Web UI 日志面板与 `query_logs` 可查，无头模式落 stdio。

## 已落地范围（P0 + P1）

| 层 | 位置 | 内容 |
|----|------|------|
| 框架核心 | `AgentDev/packages/core/src/core/capability.ts` | CapabilityDefinition / Registry（register/list/invoke/kindOf/resolveRef/entryPoints 校验/超时） |
| 框架集成 | `agent.ts` / `feature.ts` | `getCapabilities()` 收集（onInitiate 后）/ `invokeCapability` / `getCapabilitySnapshot` / `dispatchTurnActivations` / `onCapabilityActivations` |
| skill 命令化 | `AgentDev/packages/core/src/features/skill/` | 每个已发现 skill 动态注册 `skill.<name>` 命令（kind prompt），激活消费注入文档 |
| 子进程端点 | `scripts/run-prebuilt-agent.js` + `scripts/capability-ipc.js` | `capability-invoke` / `capability-list-request` 通用 IPC 分支（request/ack） |
| server 路由 | `server/routes/capability.js` | `GET /protoclaw/commands`（聚合宿主+动态）/ `POST /protoclaw/capability_invoke`（三元组寻址 runtimeId 优先） |
| 前端 | `modules/slash-menu.js` + `slash-commands.js` | 菜单（按 `/` 拉取、外部定宽对齐输入框、参数表单回显 dirty-only）、pill、发送链激活消费/归还、`claw:capability-invoked` 事件 |
| 样本 feature | force-continuation / audio-feedback | `configure` 命令（声明即入菜单，零前端改动） |

## 未落地（后续阶段）

- **P2**：BridgeFeature（会话内信号统一入口 + 派发策略家）、emit/observe 事件面、收编存量四件套（force-continuation-control 等 route/IPC 退役）
- **P3**：flow 引擎改接注册表（exitWhen→query、onEnter→invoke、`{{var}}`→注册表读）
- force-continuation.continue（注入续跑提示类命令，待会话输入原语）
- 事后新增 skill 的清单刷新（当前为启动时枚举一次）
