# Agent 启动台（Dispatch Console）系统设计文档

> 最后更新：2026-05-28
> 状态：Phase 1 已完成，Phase 2+ 规划中

---

## 目录

1. [产品哲学：我们到底在做什么](#1-产品哲学我们到底在做什么)
2. [核心产品模型：四问统一表](#2-核心产品模型四问统一表)
3. [关键心智：Session 是可唤醒的工作现场](#3-关键心智session-是可唤醒的工作现场)
4. [用户故事全集](#4-用户故事全集)
5. [设计约束与范式](#5-设计约束与范式)
6. [已开发内容（Phase 1）](#6-已开发内容phase-1)
7. [当前状态与已知问题](#7-当前状态与已知问题)
   - [7.4 Session 类型与运行时模式](#74-session-类型与运行时模式)
   - [7.5 已知限制](#75-已知限制)
8. [迭代开发计划](#8-迭代开发计划)
9. [架构与数据流](#9-架构与数据流)
10. [关键文件索引](#10-关键文件索引)
11. [与现有系统的关系](#11-与现有系统的关系)
12. [附录](#12-附录)
    - [C. 工作空间接入 Dispatch 的迁移套路](#c-工作空间接入-dispatch-的迁移套路)

---

## 1. 产品哲学：我们到底在做什么

### 1.1 问题不是"让 AI 跑一次"

传统 agent 平台给用户的工具是 cron、heartbeat、webhook——它们本质上都在回答同一个工程问题："什么时候让 AI 执行一次？"

但这不是用户真正想表达的问题。

用户想说的是：

```
我希望哪些 AI，在什么情况下，接着什么上下文，收到什么消息，然后做什么？
```

这两者之间的差距，就是本产品的核心设计空间。

### 1.2 不是 AI 版 cron，不是 AI 版 Zapier

如果只是"定时让 agent 跑一次"，那做成 cron 就够了。
如果只是"事件触发 agent 执行"，那做成 webhook 就够了。

但用户真正需要的是：

```
管理一组 AI 在未来如何继续参与我的工作。
```

时间、循环和事件，都只是**重新唤醒 AI 工作现场的方式**。

### 1.3 产品定位

**面向多 agent 工作系统的启动与续接层。**

这个系统的核心职责：

- 不负责 agent 内部怎么工作（那是 Flow 编排的职责）
- 不负责 agent 有什么能力（那是 Feature 组装的职责）
- 负责回答：**什么时候、因为什么、带着什么上下文、唤醒哪个工作现场**

用户管理的是一组**启动规则**（Activation Rules）。每条规则回答四个问题：

```
什么时候？  → 触发条件（定时 / 循环 / 事件）
叫谁？      → 目标 agent / session（工作现场）
说什么？    → 注入的消息（指令 / 上下文 / 事件内容）
结果去哪？  → 执行后的落点（留在会话 / 通知 / 写入 / 同步）
```

### 1.4 关键心智转变

| 旧心智 | 新心智 |
|--------|--------|
| Agent 是聊天对象 | Agent 是长期存在的工作角色 |
| Session 是聊天历史 | Session 是可重新唤醒的工作现场 |
| Trigger 是 cron | Trigger 是重新激活某个工作现场的条件 |
| 消息注入是 prompt | 消息注入是把事件/指令/上下文交给正确的 agent |
| 执行结果是回复 | 执行结果可以落到会话/文档/渠道/任务/PR 等 |
| 多次执行之间没有关系 | 每次执行构成了一条可追踪的长期工作链 |

---

## 2. 核心产品模型：四问统一表

### 2.1 一张统一的启动表

用户进入启动台后，看到一张大表。不是分立的 cron 页面、heartbeat 页面、webhook 页面，而是**一张统一的表**。

顶部三个 tab 只是用户理解上的分类：

```
定时 | 循环 | 事件
```

- **定时**：未来某个具体时间发生一次
- **循环**：按固定频率或条件重复发生
- **事件**：某件事情发生时自动触发

表里的每一行都是一条**启动规则**。

### 2.2 每一行是一句自然的话

这张表不应该让用户感觉自己在写配置，而应该像在写一句话：

| 触发 | 目标 | 消息 | 结果 |
|------|------|------|------|
| 今晚 11 点 | 当前编程代理 | 整理今天的代码改动 | 留在当前会话，生成摘要 |
| 每 30 分钟 | 所有运行中的 coding agent | 检查当前任务是否阻塞 | 只在有问题时提醒我 |
| PR 更新时 | Review Agent | 重新审查改动 | 把结论回复到 PR |
| agent 空闲 20 分钟时 | 当前编程代理 | 保存现场和未完成任务 | 通知我 |
| 每天早上 9 点 | 项目助手 | 基于昨天最新会话生成日报 | 写入项目日报 |

**系统底下再把它翻译成触发、会话、消息、执行、结果。**

### 2.3 第二列是产品灵魂：目标选择

这张表最重要的不是触发时间，不是事件类型，而是**第二列——目标**。

因为它决定这件事是"从零启动一个 AI"，还是"续上一个正在进行的工作现场"。

目标选择应该覆盖这些自然语义：

```
当前会话                    → 续接用户正在做的事
指定会话                    → 唤醒某个具体的历史工作现场
某类 agent 的最新会话        → 找到正确的角色
某个项目下运行中的 agent     → 集中管理项目级 AI
新建 agent 会话             → 启动新的工作角色
所有相关 agent              → 广播
某个渠道 agent              → IM / 邮件 / GitHub 等渠道绑定
```

这个地方一旦设计清楚，整个产品语义就会非常稳。

### 2.4 第四列：让 AI 做完以后有去处

这类系统最容易缺的一环：**AI 做完了，结果应该去哪？**

结果处理列可以表达：

```
留在原会话              → 默认，沉淀为工作记录
通知用户                → 弹窗 / 提醒
写入日报 / 文档          → 结构化沉淀
同步到 IM 渠道           → QQ / 微信 / Slack
评论到 GitHub PR        → 代码协作场景
只在异常时提醒           → 减少噪音
```

用户会觉得这个系统不是"后台偷偷跑一下"，而是每次执行都有明确落点。

### 2.5 页面也是一张运行地图

这张表不只是配置页，它让用户一眼就知道自己的 AI 系统现在怎么运转：

```
已启用 / 暂停中
下次触发：今晚 23:00
上次触发：今天 09:00
最近结果：已生成日报
最近错误：GitHub 权限失效
```

用户不需要打开日志系统，也能理解：哪些 AI 会自动行动、什么时候行动、最近有没有成功、下一次会做什么。

---

## 3. 关键心智：Session 是可唤醒的工作现场

### 3.1 Session 语义的分层

在当前系统中，session 有多层含义，需要被启动台正确理解：

| 层面 | 含义 | 启动台如何使用 |
|------|------|--------------|
| 身份层 | Agent 是谁（编程代理 / 项目助手 / 邮件助手） | 目标选择的基础维度 |
| 工作现场层 | Session 是一个正在进行的工作上下文 | 续接还是新建的决定依据 |
| 渠道层 | Session 可能绑定某个 IM 渠道 | 结果投递的目标 |
| 任务层 | Session 中可能存在进行中的任务 | 消息注入时是否中断当前任务 |

### 3.2 续接 vs 新建

这是启动台最核心的决策：

- **续接**：找到一个已有的工作现场，往里面注入新消息。Agent 从上一次的上下文继续工作。
- **新建**：启动一个新的 agent + session，从零开始。

当前系统通过 `targetSessionId` 和 `newSessionType` 区分这两者。未来的目标选择器应该让这个区分变得自然——用户选择"当前编程代理"就是续接，选择"新建一个日报助手会话"就是新建。

### 3.3 上下文模式

当选择续接时，还有一个关键问题：**带着什么上下文继续？**

```
fresh          → 清空历史，从零开始（注入前 reset context）
continue       → 追加到现有对话（当前默认行为）
summary-resume → 先加载上次对话摘要，再注入（利用 handoff summary）
```

这让用户可以精确控制"唤醒工作现场时，agent 还记得多少"。

---

## 4. 用户故事全集

### 故事 1: 以后再对这个 AI 说一句话 ✅ 已实现

> "10 分钟后，问当前 agent 测试结果。"
> "今晚 11 点，让当前 agent 总结今天的代码。"

**已实现能力**：
- 定时创建调度（秒级延迟）
- 选择目标会话（已有 / 新建主 / 新建探索）
- 自动启动未运行的目标 runtime
- 消息注入后 agent 响应
- 结果在启动台可见

### 故事 2: 周期性检查或整理

> "每 30 分钟检查运行中任务是否卡住。"
> "每天早上生成昨日总结。"
> "每周五整理项目风险。"

**验收标准**：
- 可设定重复间隔
- 触发后自动重新入队，永续循环直到取消
- 每次触发独立记录结果
- 取消终止循环

### 故事 3: 事件发生后通知相关 AI

> "当 agent 空闲 20 分钟时，让它保存现场。"
> "当 runtime 就绪时，立即注入初始任务。"
> "当某个 agent 完成任务时，让日报助手记录结果。"

**验收标准**：
- 可创建事件触发规则（on-idle / on-ready / on-task-complete）
- 事件触发与定时触发共存
- 事件来源可观测

### 故事 4: 广播到多个 AI

> "每 30 分钟，让所有运行中的 coding agent 检查是否卡住。"
> "需求文档变化时，通知所有和这个项目相关的 agent。"

**验收标准**：
- 一条规则可以指定多个目标
- 触发时并行投递
- 每个目标独立追踪

### 故事 5: 带着上下文续接

> "明天早上 9 点，让项目助手基于昨天最新的开发会话生成日报。"
> "10 分钟后，让当前代理从干净状态开始重新分析。"

**验收标准**：
- 可选择上下文模式（fresh / continue / summary-resume）
- fresh 模式清空对话历史
- summary-resume 模式先加载摘要

### 故事 6: Agent 自己安排后续任务

> "处理完这个 bug 后，5 分钟后提醒我做 code review。"
> "完成当前任务后，检查是否还有待办。"

这不是用户通过 UI 创建的规则，而是 agent 在对话中通过 tool 自主创建的调度。

**验收标准**：
- Agent 可调用 `schedule_dispatch` tool
- 安排的消息出现在启动台
- 可在启动台中取消 agent 创建的调度

### 故事 7: 从对话中自然长出规则

> 用户在会话中说："今晚 10 点再帮我整理这个问题。"
> 系统识别后，旁边出现一个小卡片，确认后创建规则。

**验收标准**：
- 对话中可以自然语言触发规则创建
- 规则创建前有确认步骤
- 创建的规则统一汇总到启动表

### 故事 8: 结果有明确落点

> "每天凌晨 2 点，让项目 agent 整理变更，写入项目日报。"
> "当 PR 更新时，让 review agent 审查，结论回复到 PR。"

**验收标准**：
- 规则可指定结果处理方式
- 支持至少：留在会话 / 通知用户 / 写入文档
- 结果投递可追踪

### 故事 9: 看见 AI 系统的运行全景

> 用户打开启动台，一眼看到：哪些 AI 在自动行动、什么时候行动、最近结果、下一次会做什么。

**验收标准**：
- 每条规则显示启用状态、下次触发、最近结果
- 规则执行时间线
- 异常规则高亮
- 全局运行概览

---

## 5. 设计约束与范式

### 5.1 原语最小化，渐进式扩展

> "原语尽可能少的设置，不要铺开大量字段"
> "后面会在渐进式开发的过程中一点点去补"

每个阶段只增加最少必要的新字段。不为未来可能的需求提前设计。字段只有在被具体用户故事需要时才加入。

但**产品的格局不等于实现的复杂度**。格局要大——产品定位是"Agent 启动与续接层"；但每一步的实现要小——只加一个字段。

### 5.2 消息投递路径：Feature Long-Poll 模式

```
Server (调度队列) ←→ Feature (长轮询) → agent.onCall()
```

复用 IM 渠道（QQBot/WeixinBot）的成熟模式。不发明新的推送机制。

### 5.3 Runtime 自动托管

调度触发时，如果目标 runtime 未运行，server 端自动启动。消息先入队，runtime 启动后 feature 自动 poll 取走。调度不会因为 agent 未启动而丢失。

### 5.4 队列按 Runtime Key 分发

key 是 `agentId::sessionId`，不是 `agentId`。确保消息精确投递到目标会话，不串台。

### 5.5 启动台本身是 ui-only 工作空间

启动台不启动自己的 agent runtime，只提供管理界面。管理的对象是其他 agent 的 runtime 和 session。

### 5.6 产品可以从小处长出来

启动台不一定一开始就是独立大页面。它可以先从对话里长出来——用户说"10 分钟后再做"，旁边出现确认卡片，然后逐步汇总到统一启动表。实现上，Phase 6（agent 自调度）就是这个方向的入口。

---

## 6. 已开发内容（Phase 1）

### 6.1 已实现的故事 1 能力

| 能力 | 状态 |
|------|------|
| 定时创建调度（秒级延迟） | ✅ |
| 选择目标会话（已有/新建主/新建探索） | ✅ |
| 自动启动未运行的目标 runtime | ✅ |
| 消息注入 agent.onCall() | ✅ |
| 结果回传（completed/failed） | ✅ |
| 待执行/历史列表 + 取消 | ✅ |

### 6.2 新建文件

| 文件 | 用途 |
|------|------|
| `local-features/dispatch/src/index.ts` | ClawDispatchFeature — agent 侧长轮询接收器 |
| `prebuilt-agents/official/dispatch-console/metadata.json` | 启动台工作空间定义 |

### 6.3 修改文件

| 文件 | 改动内容 |
|------|---------|
| `server.js` | Dispatch Engine 数据结构 + 5 个 API 端点 + fireDispatchNow 自动启动 runtime |
| `local-features/index.ts` | 导出 ClawDispatchFeature |
| `local-features/tsconfig.json` | 加入 dispatch include |
| `prebuilt-agents/official/programming-helper/agent.js` | 挂载 ClawDispatchFeature |
| `scripts/run-prebuilt-agent.js` | ViewerWorker 连接后启动 dispatch loop |
| `public/src/app-ui.js` | isDispatchConfigEditor + renderDispatchConfigEditor |
| `public/src/app-main.js` | 调度状态管理 + CRUD 函数 |
| `public/styles/components.css` | 启动台 UI 样式 |

### 6.4 当前数据模型

```typescript
interface DispatchSchedule {
  id: string;                    // sched-{timestamp}-{random}
  fireAt: string;                // ISO timestamp
  targetAgentId: string;         // 'programming-helper'
  targetSessionId: string | null;
  newSessionType: string | null; // 'main' | 'exploration'
  projectId: string | null;      // 项目 ID（如 'dir:D:/code/my-project'）
  message: string;
  status: 'pending' | 'fired' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  firedAt: string | null;
  result: string | null;
}
```

### 6.5 ClawDispatchFeature 实现

```typescript
export class ClawDispatchFeature implements AgentFeature {
  readonly name = 'claw-dispatch';

  // Agent 引用在 startDispatchLoop(agent) 时设置（不用 onCreate，框架不保证调用它）
  private agentRef: any = null;
  private abortController = new AbortController();
  private processingLock = Promise.resolve();  // 串行处理（同 QQBot/WeixinBot）

  async onDestroy() { this.abortController.abort(); }

  async startDispatchLoop(agent: any) {
    this.agentRef = agent;
    this.started = true;
    this.runLoop().catch(...);
  }

  // 长轮询，携带 PROTOCLAW_PREBUILT_AGENT_ID + PROTOCLAW_PREBUILT_SESSION_ID
  private async runLoop() { /* poll /dispatch/poll?agentId=...&sessionId=... */ }

  // 收到消息 → agent.onCall → POST /dispatch/respond 回传结果
  private async handleMessage(msg, serverOrigin) {
    const result = await this.agentRef.onCall(msg.text);
    await fetch('/protoclaw/dispatch/respond', { body: JSON.stringify({ response: result }) });
  }
}
```

---

## 7. 当前状态与已知问题

### 7.1 已修复的 Bug

| Bug | 根因 | 修复 |
|-----|------|------|
| 全局函数 undefined | 插入代码时吞没了 `getDirectorySummaryData` 函数声明 | 恢复函数声明 |
| agentRef null | 框架不调用 `onCreate` | 改为 `startDispatchLoop(agent)` 显式传入 |
| 消息注入两次 | 同时入队 + resolve pending poll | 有 poll 在等时直接投递不入队 |
| 消息发到错误会话 | 队列按 agentId 分发 | 改为按 runtimeKey (agentId::sessionId) 分发 |
| agent 未启动时不自动启动 | fireDispatchNow 缺少启动逻辑 | 加入 startManagedAgent 逻辑 |
| sessionType 未传递到 runtime | fireDispatchNow 调用 startManagedAgent 时缺少 extraEnv | 通过 extraEnv 传递 PROTOCLAW_SESSION_TYPE |
| 已存在 session 的配置未更新 | fireDispatchNow 未调用 activatePrebuiltSession | 启动 runtime 前先调用 activatePrebuiltSession 更新 state.json |
| 探索代理出现在前台左侧列表 | 探索代理连接了 ViewerWorker，被 getConnectedAgents 捷名匹配到 prebuilt 条目 | 探索代理改为无头模式，不连接 ViewerWorker（详见 7.4） |
| 探索代理消息不落盘 | ViewerWorker 会话管理与 dispatch onCall 流程冲突 | 无头模式下 enableStepAutoSave 直接写 session 文件（详见 7.4） |

### 7.2 Dispatch 与工作空间的分层设计

#### 核心原则：职责分离

Dispatch 系统的优雅性来自于清晰的分层：

```
┌─────────────────────────────────────────────────────────┐
│  Dispatch 层（启动台）                                    │
│  职责：什么时候 + 叫谁 + 说什么                            │
│  扩展点：result routing、context mode 等 dispatch 特有能力 │
└─────────────────────────────────────────────────────────┘
                      │ 指定 sessionId 或 sessionType
                      ▼
┌─────────────────────────────────────────────────────────┐
│  工作空间层（createPrebuiltSession/activate）            │
│  职责：具体配置怎么加载、state.json 怎么写                 │
│  实现：每个工作空间自己解决细节                             │
└─────────────────────────────────────────────────────────┘
                      │ 准备好配置
                      ▼
┌─────────────────────────────────────────────────────────┐
│  Runtime 层（startManagedAgent/run-prebuilt）             │
│  职责：读 state.json，spawn 进程                          │
└─────────────────────────────────────────────────────────┘
```

#### state.json 作为"当前焦点"机制

Dispatch 不关心工作空间的具体配置细节，它只说"激活这个 session"，工作空间负责：

1. **读取项目上下文**：从 state.json 读取当前打开的项目、配置等
2. **更新工作状态**：激活时更新 state.json，确保 runtime 读到最新配置
3. **处理配置多样性**：每个工作空间（programming-helper、flow-workspace、agent-creator）读取的字段不同

**关键设计决策**：为什么 dispatch 不直接传递配置？

- 工作空间差异巨大：programming-helper 需要 `openDirectory`，flow-workspace 需要 `assembly-form`，agent-creator 需要其他字段
- 加载逻辑各不相同：每个工作空间有自己独特的初始化套路
- 配置归属明确：配置由工作空间管理，dispatch 只控制"什么时候、叫谁"

#### Dispatch 的原语

Dispatch 只暴露最小原语：

```typescript
// 指定目标
{
  targetSessionId?: string;      // 激活具体会话
  newSessionType?: 'main' | 'exploration';  // 新建会话类型
}

// 控制行为
{
  secondsFromNow: number;        // 什么时候
  message: string;               // 说什么
}
```

工作空间的 `createPrebuiltSession` 和 `activatePrebuiltSession` 实现各自负责具体配置加载。

#### 数据流：state.json 如何成为桥梁

```
用户操作 → dispatch 指定 sessionId
         ↓
    activatePrebuiltSession(agentId, sessionId)
         ↓
    工作空间写 state.json（当前焦点）
         ↓
    startManagedAgent 启动 runtime
         ↓
    run-prebuilt-agent.js 读 state.json
         ↓
    Agent 构造函数拿到项目上下文
```

这种设计让 dispatch 保持通用，能适配任何工作空间，同时工作空间保持自治。

### 7.4 Session 类型与运行时模式

> 这一节是编程小助手改造中踩坑后的提炼。它不只适用于 programming-helper，
> 而是所有未来接入 dispatch 的工作空间都需要理解的基础共识。

#### 核心认知：两种运行时模式

同一个 agent 定义（如 `programming-helper/agent.js`）可以产生两种运行时：

```
┌─────────────────────────────┬──────────────────────────────┐
│  前台代理 (main)             │  后台代理 (exploration)       │
├─────────────────────────────┼──────────────────────────────┤
│ 连接 ViewerWorker            │ 不连接 ViewerWorker（无头）    │
│ 出现在左侧列表               │ 前端不可见                     │
│ 消息通过 ViewerWorker UI     │ 消息通过 dispatch HTTP 轮询    │
│ 用户可交互查看对话            │ 用户只能在 session 历史中回顾   │
│ 有 UserInputFeature          │ 无 UserInputFeature            │
│ 可挂载 IM Gateway            │ 不挂载 IM Gateway              │
│ session 持久化由 Viewer 驱动  │ session 由 enableStepAutoSave  │
│ ready 判定 = viewerAgentId   │ ready 判定 = stdout READY      │
│     + runtime.ready          │     + runtime.ready            │
└─────────────────────────────┴──────────────────────────────┘
```

**关键判断标准**：`PROTOCLAW_SESSION_TYPE` 环境变量。Runner 脚本和 server 端都基于这个单一值做分流。

#### 判断树：一个 dispatch 请求的运行时应该怎么跑

```
dispatch 创建新 session，newSessionType = ?
│
├─ 'main'
│   → startManagedAgent() 注入 AGENTDEV_DEBUG_TRANSPORT=viewer-worker
│   → run-prebuilt-agent.js 连接 ViewerWorker
│   → 前台可交互
│
├─ 'exploration'
│   → startManagedAgent() 不注入 viewer-worker 环境变量
│   → run-prebuilt-agent.js 跳过 withViewer()
│   → 无头运行，ClawDispatchFeature 通过 HTTP 轮询收发消息
│   → 前端不可见
│
└─ 其他（'sub' 等）
    → 沿用 main 的行为（前台），但注入 sessionType 环境变量
    → agent.js 可根据 sessionType 选择不同 feature 组合
```

#### 为什么"在 getConnectedAgents 里过滤"是错误的

这是编程小助手改造中走的一条弯路。根本问题：

1. **ViewerWorker 是"看到"的根因**。只要 agent 连接了 ViewerWorker，它就会出现在 `/api/agents` 里。之后不管你在 `getConnectedAgents()` 里加多少层过滤，都是在和 ViewerWorker 的注册机制打补丁。
2. **名字匹配导致误合并**。探索代理和前台代理使用同一个 agent 定义（同名），ViewerWorker 看到的名字相同。`getConnectedAgents()` 会把探索代理通过名字匹配到前台 prebuilt 条目上，导致前台代理的状态被探索代理覆盖。
3. **viewerAgentId 的竞争**。`startManagedAgent` 在 stdout 里解析 viewerAgentId，但 ViewerWorker 注册可能更早。在这段时间窗口内，过滤逻辑找不到 managedRuntime，探索代理就漏过去了。

**正确做法**：从源头决定 agent 要不要被"看到"。不需要被看到的 agent，从一开始就不应该连接 ViewerWorker。

#### 三个改动点的分工

```
server.js / startManagedAgent()
│  判断 sessionType === 'exploration'
│  → 不注入 AGENTDEV_DEBUG_TRANSPORT / AGENTDEV_VIEWER_PORT
│  → 这是"门"：决定 agent 有没有机会被前端看到
│
run-prebuilt-agent.js
│  判断 IS_EXPLORATION
│  → 跳过 withViewer()、IM Gateway、pushToDebug
│  → 保留 ClawDispatch loop、session 加载、enableStepAutoSave
│  → 这是"内部适配"：决定无头模式下的行为
│
server.js / waitForManagedRuntimeReady()
   判断 runtime.sessionType === 'exploration'
   → 只检查 runtime.ready，不要求 viewerAgentId
   → 这是"握手"：决定 dispatch 什么时候认为 agent 可以收消息
```

#### 消息持久化的两条路径

```
前台代理:
  用户输入 → ViewerWorker → agent.onCall() → step lifecycle
  → enableStepAutoSave → 写 session 文件
  → 同时 ViewerWorker 维护自己的消息缓存（实时查看用）

后台代理:
  dispatch poll → ClawDispatchFeature.handleMessage() → agent.onCall()
  → step lifecycle → enableStepAutoSave → 写 session 文件
  → 结果 POST 回 /dispatch/respond（不经过 ViewerWorker）
```

两条路径共享 `enableStepAutoSave` 机制（step 级自动落盘），区别只在消息的"入口"和"出口"。

#### 对 agent.js 的要求

agent.js 通过 `process.env.PROTOCLAW_SESSION_TYPE` 判断当前模式，决定挂载哪些 feature：

```javascript
// 所有模式共享的 feature
this.use(new ClawDispatchFeature());

if (isExploration) {
  // 后台代理：只挂核心能力
  this.use(new ShellFeature({ workspaceDir }));
  this.use(new WebSearchFeature());
} else {
  // 前台代理：完整体验
  this.use(new UserInputFeature());
  this.use(new AuditFeature());
  // ... 其他前台 feature
}
```

**关键约束**：`ClawDispatchFeature` 必须在所有模式下都挂载。后台代理完全依赖它接收消息。

### 7.5 已知限制

1. 只控制 programming-helper（前端硬编码）
2. 不支持循环调度
3. 不支持事件触发
4. 结果只存截断文本
5. 前端不实时更新
6. 延迟单位是秒（测试阶段，正式需调整）
7. UI 是简单表单，还不是"统一启动表"形态

---

## 8. 迭代开发计划

### 设计原则

- 格局要大：每一步都朝着"Agent 启动与续接层"的方向走
- 实现要小：每次只加一个字段或一个能力
- 改动可控：每阶段 4-7 个文件

### 数据模型演进路线

```
P1: { fireAt, target, message, status }                           ✅ 已完成
P2: P1 + { repeatInterval }                                       → 循环
P3: P2 + { trigger }                                              → 事件
P4: P3 + { targets[] }                                            → 广播
P5: P4 + { contextMode }                                          → 续接
P6: P5 + (agent tool: schedule_dispatch)                          → 自调度
P7: P6 + (result routing, running map UI)                         → 结果/全景
```

每个阶段只追加字段，不修改已有字段语义，保证向前兼容。

---

### Phase 2: 循环调度

**解锁**：故事 2（周期性检查或整理）

**新增**：`repeatInterval: number`（秒，0 = 一次性）

**行为**：调度触发 → agent 响应 → 若 repeatInterval > 0 → fireAt = now + repeatInterval，状态回 pending，继续循环。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `server.js` fireDispatchNow | respond 回来后检查 repeatInterval，re-arm |
| `server.js` POST /schedules | 接受 repeatInterval 字段 |
| `server.js` schedule 模型 | +repeatInterval, +firedCount |
| `local-features/dispatch/src/index.ts` | respond 时附上 scheduleId |
| `public/src/app-ui.js` | 表单加"重复间隔"输入 + 循环标记 |
| `public/src/app-main.js` | 读取 repeatInterval |

**验收标准**：
- 创建时可设重复间隔（留空 = 一次性）
- 触发后自动循环，直到取消
- 每次触发独立记录结果
- 取消终止循环

---

### Phase 3: 事件驱动触发

**解锁**：故事 3（事件发生后通知相关 AI）

**新增**：`trigger: { type: 'timer' | 'on-idle' | 'on-ready', idleThreshold?: number }`

**架构**：Server 端增加事件桥接层，将 runtime 生命周期事件转化为调度触发源。

```
事件源:
├── runtime.ready     → stdout "[ProtoClaw Runtime] READY"
├── runtime.exit      → child process exit
├── agent.idle        → Feature POST /dispatch/agent_status { status: 'idle' }
└── session.created   → createPrebuiltSession 被调用
```

**idle 检测**：Feature 在 onCall 完成后 POST idle 状态到 server。Server 记录每个 runtime 的 lastActiveAt。on-idle 规则检查 `now - lastActiveAt > idleThreshold`。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `server.js` | 新增 dispatchEventBus，runtime lifecycle 中 emit 事件 |
| `server.js` | 新增 POST /dispatch/agent_status 接收 Feature 上报的状态 |
| `server.js` | fireDispatchNow 支持 trigger 匹配 |
| `server.js` | schedule 模型 +trigger 字段 |
| `local-features/dispatch/src/index.ts` | onCall 完成后 POST idle 事件 |
| `public/src/app-ui.js` | 触发类型选择器（定时/空闲/就绪） |
| `public/src/app-main.js` | 读取 trigger 配置 |

**验收标准**：
- 可创建 on-idle 类型规则
- 可创建 on-ready 类型规则
- 事件触发与定时触发共存

---

### Phase 4: 广播与多目标

**解锁**：故事 4（广播到多个 AI）

**新增**：`targets: [{ agentId, sessionId?, newSessionType? }]`

保留旧字段作为快捷方式。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `server.js` fireDispatchNow | 遍历 targets，分别 startRuntime + pushMessage |
| `server.js` POST /schedules | 接受 targets 数组 |
| `server.js` 模型 | +targets[] |
| `public/src/app-ui.js` | 目标选择从单选变为多选 |
| `public/src/app-main.js` | 构造 targets 数组 |

---

### Phase 5: 上下文续接

**解锁**：故事 5（带着上下文续接）

**新增**：`contextMode: 'fresh' | 'continue' | 'summary-resume'`

**三种模式**：
- `fresh`：注入前 agent.reset()，从零开始
- `continue`（默认）：追加到现有 context
- `summary-resume`：先加载 handoff summary，注入为 system message，再 onCall

**改动文件**：

| 文件 | 改动 |
|------|------|
| `local-features/dispatch/src/index.ts` | handleMessage 根据 contextMode 决定是否 reset |
| `server.js` 模型 | +contextMode |
| `public/src/app-ui.js` | 上下文模式选择器 |
| `public/src/app-main.js` | 读取 contextMode |

---

### Phase 6: Agent 自调度

**解锁**：故事 6（Agent 自己安排后续任务）+ 故事 7 的技术基础（从对话中长出规则）

**新增**：给 agent 暴露 `schedule_dispatch` tool

```typescript
{
  name: 'schedule_dispatch',
  description: '安排一个延迟消息在未来发给自己',
  parameters: {
    message: string,
    delaySeconds: number,
    repeatInterval?: number,
  }
}
```

Agent 在 ReAct 循环中可调用此 tool，POST 到 server 创建调度。target 自动设为当前 agent+session。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `local-features/dispatch/src/index.ts` | 新增 getTools() 返回 schedule_dispatch tool |

这是整个路线中改动最小的阶段（只需改 1 个文件），但解锁了 agent 自驱动的能力。

---

### Phase 7: 结果路由与运行全景

**解锁**：故事 8（结果有明确落点）+ 故事 9（看见运行全景）

**新增**：`resultRouting: { type: 'session' | 'notify' | 'document', target?: string }`

**UI 重构**：从简单表单 → 统一启动表（三个 tab：定时/循环/事件）

**运行地图**：每条规则显示实时状态、下次触发、最近结果、错误高亮。

**改动文件**：

| 文件 | 改动 |
|------|------|
| `server.js` respond endpoint | 存储完整响应 + tool 调用列表 + 耗时 |
| `local-features/dispatch/src/index.ts` | respond 附带 tool_calls、duration |
| `server.js` 模型 | +resultRouting, +resultDetail |
| `public/src/app-ui.js` | 重构为统一启动表 + 时间线视图 |
| `public/src/app-main.js` | 实时状态轮询 |
| `public/styles/components.css` | 启动表 + 运行地图样式 |

---

### 远期方向

**结果路由扩展**：结果不只能留在会话，还能同步到 IM 渠道、写入文档、评论到 PR。这需要与各 Feature（QQBot、WeixinBot、文档 Feature）集成。

**从对话中长出规则**（故事 7）：用户在对话中说"10 分钟后再做"，agent 识别后调用 `schedule_dispatch` tool 创建规则。这不需要新的基础设施，Phase 6 的 tool 就是入口。

**与 Flow 编排的集成**：Dispatch trigger 可以作为 Flow node 的外部触发源。Flow 节点的 `onEnter` 可以调用 `schedule_dispatch`。两者正交互补：Dispatch 决定什么时候激活 agent，Flow 决定激活后内部怎么运转。

**外部事件接入**：当内部事件驱动成熟后，接入外部 webhook（GitHub、Slack、邮件等），让启动规则能响应外部世界的变化。

---

## 9. 架构与数据流

### 9.1 系统架构图

```
┌─────────────────────────────────────────────────────────┐
│                      浏览器前端                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │  启动台 Workspace (dispatch-console)              │    │
│  │  ┌──────────┬──────────┬──────────┐              │    │
│  │  │  定时     │  循环     │  事件     │   ← 三个 tab  │    │
│  │  └──────────┴──────────┴──────────┘              │    │
│  │  ┌─────────────────────────────────────┐         │    │
│  │  │  统一启动表                           │         │    │
│  │  │  触发 | 目标 | 消息 | 结果 | 状态      │         │    │
│  │  │  ────────────────────────────────── │         │    │
│  │  │  今晚11点 | 编程代理 | 整理代码 | 留在会话 | 启用│  │    │
│  │  │  每30min | 所有agent | 检查阻塞 | 异常时通知 | 启用│ │    │
│  │  └─────────────────────────────────────┘         │    │
│  └────────────────────┬────────────────────────────┘    │
│                       │ REST API                         │
└───────────────────────┼─────────────────────────────────┘
                        │
┌───────────────────────┼─────────────────────────────────┐
│  ProtoClaw Server      │                                  │
│                        ▼                                  │
│  ┌─────────────────────────────────────────────┐        │
│  │  Dispatch Engine（调度层）                     │        │
│  │                                              │        │
│  │  dispatchSchedules  ← 规则存储 + 持久化       │        │
│  │  dispatchQueue      ← 按 runtimeKey 的消息队列│        │
│  │  dispatchPendingPolls ← 等待中的 poll resolver│        │
│  │  dispatchTimers     ← setTimeout 句柄         │        │
│  │  dispatchEventBus   ← 事件桥接层（Phase 3）   │        │
│  │                                              │        │
│  │  fireDispatchNow(schedule)                   │        │
│  │  ├─ 解析 targetSessionId / newSessionType    │        │
│  │  ├─ 调用工作空间的 activate/create           │        │
│  │  └─ 消息入队 dispatchQueue                   │        │
│  └─────────────────────────────────────────────┘        │
│                          │                                │
│  ┌──────────────────────┴─────────────────────────┐   │
│  │  工作空间层（Workspace Layer）                     │   │
│  │                                                    │   │
│  │  createPrebuiltSession(agentId, type, opts)       │   │
│  │  ├─ programming-helper: 写 openDirectory          │   │
│  │  ├─ flow-workspace: 写 assembly-form             │   │
│  │  └─ agent-creator: 写其他字段                     │   │
│  │                                                    │   │
│  │  activatePrebuiltSession(agentId, sessionId)      │   │
│  │  └─ 更新 state.json（当前焦点）                   │   │
│  └────────────────────┬───────────────────────────────┘  │
│                       │ state.json                      │
│                       ▼                                 │
│  ┌─────────────────────────────────────────────┐        │
│  │  Runtime 托管                                     │        │
│  │  startManagedAgent(agent, sessionId, opts)     │        │
│  │  ├─ spawn process                              │        │
│  │  ├─ 注入环境变量（agentId, sessionId, sessionType）│        │
│  │  └─ waitForManagedRuntimeReady()              │        │
│  └─────────────────────────────────────────────┘        │
└────────────────────┬────────────────────────────────────┘
                     │ spawn process
                     │ PROTOCLAW_PREBUILT_AGENT_ID
                     │ PROTOCLAW_PREBUILT_SESSION_ID
                     │ PROTOCLAW_SESSION_TYPE (main/exploration)
                     │ PROTOCLAW_SERVER_ORIGIN
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Agent Runtime (e.g. programming-helper)                 │
│                                                          │
│  scripts/run-prebuilt-agent.js                          │
│  ├─ resolveWorkspaceCwd() ← 读 state.json.openDirectory │
│  ├─ resolveSessionType() ← 读 PROTOCLAW_SESSION_TYPE    │
│  └─ 启动 dispatch loop                                  │
│                                                          │
│  ClawDispatchFeature                                     │
│  ├─ startDispatchLoop(agent)                             │
│  ├─ runLoop() → poll /dispatch/poll                      │
│  ├─ handleMessage() → agent.onCall(text)                 │
│  ├─ POST /dispatch/respond → 结果回传                    │
│  └─ POST /dispatch/agent_status → 状态上报 (Phase 3)    │
│                                                          │
│  Agent Core:                                             │
│  ├─ onCall(text) → ReAct loop → response                │
│  ├─ persistentContext → 对话历史                          │
│  └─ hooks: @CallStart @StepStart @StepFinish ...         │
│                                                          │
│  Tools (Phase 6+):                                       │
│  └─ schedule_dispatch → agent 可自建调度规则              │
└─────────────────────────────────────────────────────────┘
```

### 9.2 消息投递流程（完整分层视图）

```
1. 用户创建规则
   前端 → POST /dispatch/schedules
   Server → 创建 schedule → setTimeout 定时器

2. 定时器触发
   setTimeout → fireDispatchNow(schedule)

3. Dispatch 层：目标解析
   fireDispatchNow(schedule):
   ├─ 解析 targetSessionId 或 newSessionType
   ├─ 决定是"激活已有"还是"新建"
   └─ 调用工作空间层

4. 工作空间层：配置准备
   情况 A - 新建 session:
   ├─ createPrebuiltSession(agentId, sessionType, opts)
   ├─ 工作空间根据 sessionType 写 state.json
   └─ 返回 sessionId

   情况 B - 激活已有 session:
   ├─ activatePrebuiltSession(agentId, sessionId)
   ├─ 工作空间更新 state.json（当前焦点）
   └─ 配置已就绪

5. Runtime 启动（如需要）
   startManagedAgent(agent, sessionId, { extraEnv }):
   ├─ 注入 PROTOCLAW_SESSION_TYPE
   ├─ spawn process
   └─ 等待 READY

6. 消息投递
   pushDispatchMessage(runtimeKey, message):
   ├─ 有等待中的 poll → 直接 resolve → HTTP 200
   └─ 无等待中的 poll → 入 dispatchQueue → 等 poll 来取

7. Agent 处理
   ├─ resolveWorkspaceCwd() ← 读 state.json.openDirectory
   ├─ resolveSessionType() ← 读 PROTOCLAW_SESSION_TYPE
   ├─ Feature 收到消息
   ├─ agent.onCall(text) → ReAct 循环 → 响应
   └─ POST /dispatch/respond 回传结果

8. 结果回传
   Feature → POST /dispatch/respond { scheduleId, response }
   Server → 更新 schedule status → completed/failed

9. 前端刷新
   前端 loadDispatchSchedules() → 更新统一启动表
```

**关键分层点**：
- 步骤 3-4：Dispatch 层只说"哪个 session"，工作空间层负责"怎么配置"
- 步骤 7：Runtime 层读 state.json，不关心配置来自 dispatch 还是 UI

---

## 10. 关键文件索引

### 新建文件

| 文件 | 用途 |
|------|------|
| `local-features/dispatch/src/index.ts` | ClawDispatchFeature |
| `prebuilt-agents/official/dispatch-console/metadata.json` | 启动台工作空间 |
| `docs/plans/dispatch-system-design.md` | 本文档 |
| `docs/plans/workspace-project-abstraction-design.md` | 工作空间项目抽象设计文档 |

### 修改文件

| 文件 | 改动位置 |
|------|---------|
| `server.js:62-160` | 项目抽象层 + `ProgrammingHelperProjectAdapter` |
| `server.js:208-270` | `fireDispatchNow` 使用项目适配器 + sessionType 传递 |
| `server.js:~4354-4430` | `getConnectedAgents`（已移除探索过滤，探索代理不在 ViewerWorker 中） |
| `server.js:~4578-4650` | `startManagedAgent` 探索会话不注入 viewer-worker 环境变量 |
| `server.js:~4534-4550` | `waitForManagedRuntimeReady` 探索模式只检查 ready 标志 |
| `server.js:~5013-5070` | dispatch API 端点（含 `GET /dispatch/projects`） |
| `local-features/index.ts` | 导出 ClawDispatchFeature |
| `local-features/tsconfig.json` | 加入 dispatch include |
| `prebuilt-agents/official/programming-helper/agent.js:18,93` | 导入 + 挂载 |
| `scripts/run-prebuilt-agent.js:27` | `IS_EXPLORATION` 常量 |
| `scripts/run-prebuilt-agent.js:625-654` | 探索模式跳过 ViewerWorker 连接、IM Gateway |
| `scripts/run-prebuilt-agent.js:685-696` | 探索模式跳过 pushToDebug |
| `scripts/run-prebuilt-agent.js:656-664` | 启动 dispatch loop（两种模式共享） |
| `public/src/app-ui.js:2491-2625` | 启动台 UI 渲染（含项目选择器） |
| `public/src/app-ui.js:6264` | block 分发路由 |
| `public/src/app-main.js:2956-3035` | 状态管理 + CRUD（含项目加载） |
| `public/styles/components.css` | 启动台样式 |

### 依赖的系统文件（只读参考）

| 文件 | 为什么重要 |
|------|----------|
| `AgentDev/src/core/agent.ts` | onCall 实现、hook 系统、persistentContext |
| `AgentDev/src/core/hooks-decorator.ts` | Feature hook 装饰器 |
| `AgentDev/src/core/debug-hub.ts` | agentId 生成规则、registerAgent |
| `AgentDev/src/core/notification.ts` | 通知系统（Phase 3 事件桥接基础） |
| `AgentDev/src/features/subagent/pool.ts` | sendTo/report 模式参考 |
| `local-features/flow/src/index.ts` | FlowFeature hook 拦截模式参考 |

---

## 11. 与现有系统的关系

### 11.1 与 Flow 编排

正交互补，各管一层：
- **启动台**：什么时候激活 agent（外部触发层）
- **Flow**：激活后 agent 内部怎么运转（内部编排层）

潜在集成（远期）：dispatch trigger 作为 Flow node 的外部触发源。

### 11.2 与 IM 渠道

同一底层机制（Feature 长轮询 → agent.onCall），不同触发源：
- IM：外部用户通过 QQ/微信发消息
- 启动台：系统内部的规则触发

### 11.3 与 spawn_one_shot

spawn_one_shot 是"启动 → 执行 → 退出"。启动台是"唤醒 → 执行 → 继续存活 → 可再唤醒"。启动台更轻量且支持持续性。

### 11.4 与 Context Handoff

启动台的 `contextMode: 'summary-resume'`（Phase 5）复用 handoff 的 summary-export 能力。

### 11.5 与 DebugHub Notification

Phase 3 的事件驱动需要在 server 端观察 agent 事件。方案：Feature 主动 POST 状态到 server，不需要框架改动。

---

## 12. 附录

### A. 开发关键经验

**Feature 生命周期**：框架不保证调用 `onCreate`。需要 agent 引用时必须用显式调用（如 `startDispatchLoop(agent)`）。

**Agent ID 三种形态**：
- 预构建 agent ID（`programming-helper`）→ server 端调度目标
- ViewerWorker agentId（`agent-0-12345`）→ 框架内部标识
- 环境变量 `PROTOCLAW_PREBUILT_AGENT_ID` → Feature 轮询标识

**Runtime Key 必须精确**：消息队列必须按 `agentId::sessionId` 分发，否则串台。

**app-ui.js 脆弱性**：~8500 行单文件，插入代码后必须 `node -c` 验证。

### B. 术语表

| 术语 | 含义 |
|------|------|
| Activation Rule / 启动规则 | 一条定义了"什么时候、叫谁、说什么、结果去哪"的规则 |
| 工作现场 | 一个可被唤醒的 agent session，包含历史上下文和工作状态 |
| 续接 | 找到已有工作现场，注入新消息继续工作 |
| Runtime Key | `agentId::sessionId` 格式，消息路由的唯一标识 |
| Event Bridge | Server 端将 runtime 事件转化为调度触发源的桥接层 |
| 结果路由 | Agent 执行完成后结果的投递目标（会话/通知/文档/渠道） |
| 运行地图 | 启动台中展示所有规则实时状态的统一视图 |

### C. 工作空间接入 Dispatch 的迁移套路

> 基于 programming-helper 的实践提炼。其他工作空间（flow-workspace、feature-creator、
> agent-creator）接入 dispatch 时应遵循相同的步骤和检查清单。

#### Step 1：确定项目的概念和 ID 格式

每个工作空间首先要回答：**"这个工作空间的项目是什么？"**

| 工作空间 | 项目是什么 | 项目 ID 格式 | 配置字段 |
|----------|-----------|-------------|---------|
| programming-helper | 一个目录 | `dir:D:/code/my-project` | `openDirectory` |
| flow-workspace | 一个 Agent Project | `assembly:my-agent-project` | `assembly-form` |
| feature-creator | 一个 Feature | `feature:my-feature` | `featureName` + `targetDir` |
| agent-creator | 一个 Agent | `agent:my-agent` | `agentName` + `targetDir` |

ID 格式加前缀（`dir:`、`assembly:`）便于调试时一眼区分，也为未来跨工作空间引用留空间。

#### Step 2：实现 ProjectAdapter

在 `server.js` 中为该工作空间实现 adapter：

```javascript
class MyWorkspaceProjectAdapter {
  constructor() {
    this.workspaceId = 'my-workspace';
  }

  // 从 session record 中提取项目 ID
  extractProjectId(session) { /* 返回 'prefix:value' 或 null */ }

  // 读取当前激活的项目（从 state.json 或其他存储）
  async getCurrentProject() { /* 返回 WorkspaceProject 或 null */ }

  // 根据 projectId 返回创建 session 需要的配置
  getProjectConfig(projectId) { /* 返回 { key: value } 对象 */ }

  // 切换当前激活的项目
  async activateProject(projectId) { /* 更新 state.json */ }
}

registerProjectAdapter(new MyWorkspaceProjectAdapter());
```

adapter 的接口很小，但它让 dispatch 层完全不需要理解每个工作空间的内部细节。

#### Step 3：在 agent.js 中挂载 ClawDispatchFeature

```javascript
// 必须在所有模式下都挂载（前台 + 后台）
this.use(new ClawDispatchFeature());

// 根据模式选择 feature 组合
const isExploration = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';
if (isExploration) {
  // 只挂后台需要的 feature
} else {
  // 挂完整前台 feature，包括 UserInputFeature
}
```

**必须遵守**：`ClawDispatchFeature` 无条件挂载。后台代理靠它接收消息。

#### Step 4：确认 run-prebuilt-agent.js 的无头分支能覆盖你的工作空间

`run-prebuilt-agent.js` 已有 `IS_EXPLORATION` 判断，跳过 ViewerWorker 连接。如果你的工作空间有额外的初始化步骤依赖 ViewerWorker（如 `pushToDebug`、IM Gateway），确保它们在 `if (IS_EXPLORATION)` 分支中被跳过。

当前已跳过的操作：
- `agent.withViewer()`
- IM / QQBot Gateway 启动
- `pushToDebug` / `syncRegisteredToolsToDebug` / `pushInspectorSnapshot` / `pushOverviewSnapshot`

当前不受 IS_EXPLORATION 影响的操作（两种模式都执行）：
- agent 构造和 feature 挂载
- ClawDispatch loop 启动
- session 加载 / 创建
- `enableStepAutoSave`
- `READY session=` stdout 输出
- workspace 目录解析（`resolveWorkspaceCwd`）

#### Step 5：项目选择器 API

如果你的工作空间需要前端调度 UI 中的项目选择器，确认 `GET /protoclaw/dispatch/projects?agentId=...` 能正确返回项目列表。

如果项目聚合逻辑与 programming-helper 不同（如从 flow graph 聚合而非从 session 聚合），在 adapter 中实现 `listProjects()` 或扩展 API。

#### 检查清单

迁移完成后，逐项验证：

- [ ] **前台调度**：创建 main 类型的新会话 → agent 连接 ViewerWorker → 出现在左侧列表 → 消息可见
- [ ] **后台调度**：创建 exploration 类型的新会话 → agent 不连接 ViewerWorker → 不出现在左侧列表
- [ ] **消息落盘**：后台代理执行完 dispatch 消息 → session 文件包含完整对话历史 → 在工作空间 session 列表中可见
- [ ] **项目配置**：指定项目创建新会话 → agent 拿到正确的项目配置（目录 / assembly / feature 等）
- [ ] **已有 session 恢复**：dispatch 指向已有 session → runtime 正确恢复 → sessionType 一致
- [ ] **进程生命周期**：后台 agent 进程正常退出 → managedAgents 状态更新 → 不影响同工作空间的前台代理

#### 需要注意的常见陷阱

1. **不要在 getConnectedAgents 里过滤**。如果后台代理不该出现，从源头让它们不连接 ViewerWorker。
2. **同名 agent 的身份冲突**。同一定义（如 programming-helper）可能同时有前台和后台实例。ViewerWorker 只应该看到前台实例。
3. **waitForManagedRuntimeReady 的 ready 判定**。后台代理不连接 ViewerWorker，`viewerAgentId` 永远为 null。ready 判定必须只检查 `runtime.ready`。
4. **dispatch 消息投递不依赖 ViewerWorker**。ClawDispatchFeature 通过 HTTP 轮询收消息，`pushDispatchMessage` 按 runtimeKey 入队。这两条路径完全不经过 ViewerWorker。
5. **session store 路径一致性**。agent.js 中读 state.json 的路径必须和 server.js 中 session store 的路径使用相同的 `WORKSPACE_BOUND_AGENT_IDS` 逻辑。
