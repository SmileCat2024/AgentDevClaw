# 工作线程（Work Thread）设计与输入链路统一

> 状态：实施中（第二阶段：coder 线程版编程助手演示）
> 前置：`docs/plans/` 无相关计划文档；本文是该方向的第一份权威设计记录。
> 关联提交：`cd175ae`（悬置地基）、coder 工作空间移植与输入链路统一（未提交）。

---

## 1. 背景与原始需求还原

### 1.1 问题起点

Claw 长期以「会话」为一等单位。会话的接续（trim / summary）由产品层解决，
但都要求用户等待、手动切换页面、再补发指令。两个原始痛点：

1. **交互痛点**：对会话做 trim / summary 后想追加一句"请继续"，必须等
   新会话创建完成、手动切过去、再发送。接力期间的输入意图无处安放。
2. **愿景**：未来要做纯执行型编码智能体（工单 → 派活 → PR），需要一项
   工作跨多个会话持续推进直到交付。这催生了「工作线程」概念。

用户明确：当前阶段**不做** 24 小时自动执行、不做工单集成、不做 PR 闭环；
先在编程小助手形态里演示「线程版编程小助手」，感知丝滑程度。

### 1.2 用户约束与指导（设计宪法，原话要点复述）

以下约束在整个实施过程中反复被强调，是所有设计决策的仲裁标准：

1. **从根本上捋清线路，不打补丁**
   > "还是不要暴力打补丁实现，而是从根本上捋清线路，把线路接对，对于
   > 各种情况，特别是以前那种没有线程的那种，纯会话，也都能正确处理"

   曾被否决的方案：内存 Map 记录交接进行中 + 多处 set/clear + TTL 兜底。
   状态散落、清除点不原子、失败路径靠超时自愈 → 改为落盘第一等状态
   （见 §5）。

2. **三条输入链路的关系必须捋清**
   > "viewer 的输入队列处理，claw 的 envelope，还有新增的线程，这些东西
   > 对于输入这条线的关系得捋清，建设正确"

3. **所有输入源走同一条路子**
   > "除了 user input 的输入，比如 IM 渠道的输入，交互 ui 面板的输入，
   > 大家都得走一条路子，找清楚问题的层级，然后把不符合规则的内容往
   > 统一的一个思路去改"

4. **清理旧时代兼容，链路保持干净**
   > "东西该清理就清理，不要留有旧时代的兼容，确保最终的整体链路干净，
   > 整洁，后续 agent 接手不容易写错"

5. **不魔改 feature，兼容性要强**
   > "你的这套设计得兼容性足够强，而不至于魔改其他事情。就比如说
   > user input 输入框的这个通讯，向来是以前老是出 bug 的点……它是一种
   > 丝滑的切换，不要弄得乱七八糟……但是你的解决方案是从根本上设计对，
   > 而并不是去魔改这些一个个的 feature"

6. **线程哲学：线性交付，分支即新线程**
   > "从思想哲学上来看，我们的线程可以更偏向于它就是把一件事情做到底，
   > 会话之间是强关联的。先不考虑什么分支这个事情，线程就是独立的。
   > 如果是分支，那么是开新的工作线程，而不是在一个进行到底"

7. **群聊线程实验不算数，另起炉灶**
   > "群聊那一套就当实验吧，感觉不太成功，现在得另行设计"
   > "不要拿已有群聊功能，去承载接下来我们希望实现的东西"

   新体系不依赖群聊 sessionLineage / chat.sessions / 管理员 / 群聊事件。
   可复用的只有底层机制（handoff、CallArbiter、user-turn 契约）。

8. **线程是实验性质，可退回纯会话**
   > "把线程当做一个实验性质的一个事情，就是你依然是可以把它只跟一个
   > 会话进行绑定"

   即：线程宿主（当前仅 coder）之外的所有工作空间，行为与未接入线程时
   完全一致；coder 也能随时当作普通工作空间使用。

9. **交接期体验要求**
   > "进行交接期间，user input 发不出消息（观感上就是进队列了，出现那个
   > 暂存气泡），然后输入会暂存，并在新对话完成后直接接续。并且左侧列表
   > 的占位提醒也需要按照线程的风格去调整，不能给人一种还是创建了一个
   > 新会话的感受"

10. **验收标准：与编程小助手功能对等 + 丝滑接续**
    > "核心的验证功能就是它是否能在跟编程小助手这样的功能体验情况下，
    > 在切换会话的时候，这个页面就不用再跳了，而是能丝滑的衔接。然后以及
    > 各种功能都能跑通。比如说实际的 feature 在跟右端面板的通讯，其实也
    > 就证明那些 ID 有没有选对"

11. **阶段边界（24h 愿景仅作背景，不进当前实现）**
    工作池（WorkPool）、外部工单源、善后/协调 Agent、错误分类仲裁、
    PR 闭环等属于未来阶段。当前只做「线程版编程小助手」的连续性演示。

---

## 2. 概念模型：会话、线程、运行时、信封

现有对象分层（保持不变）：

```
Host / Workspace      一个产品工作空间（programming-helper / coder / …）
 └─ Session           一段可恢复、可审计的对话与状态（磁盘上的真相）
     └─ Runtime       承载 Session 的进程实例（可消失、可重建）
         └─ Call      Runtime 内一次串行的 Agent 调用（CallArbiter 仲裁）
```

新增的一层（仅线程宿主）：

```
Host / Workspace
 └─ Work Thread       连续性锚点：把一组先后接力的 Session 认定为同一项工作
     ├─ sessionChain  线性链：root → … → head（当前承接会话）
     ├─ commands      Thread Inbox：持久化的待投递指令
     └─ pendingSuccession  交接意图（第一等落盘状态，见 §5）
```

线程的四件事（全部职责）：

1. 这项工作当前由哪个 Session 承接（headSessionId + revision）；
2. Session 更替时连续性如何不丢（advanceHead 原子推进 + handoff 材料）；
3. 更替期间新指令如何不丢（Thread Inbox）;
4. 对这条工作的操作入口（暂停 / 继续 / 接力 / 终止）。

线程**不负责**：定义工单字段、判断任务完成、取代 Todo/Dispatch、驱动
Agent 无限循环。上层产品语义（多变、脆弱）全部留在线程之上，不进地基。

**关键架构判断：Thread 不能是 Feature。** Feature 挂在 Runtime 内，
Runtime 停止即消失；而线程恰恰要跨 Runtime 存续。线程控制面必须住在
Claw 服务端（`server/thread-control/`），Agent / Feature 对它零感知。

---

## 3. 对象与真相关系

```
~/.agentdev/AgentDevClaw/threads/
 ├─ index.json                 线程索引摘要（前端轮询数据源）
 └─ <threadId>.json            单线程完整记录（record + commands 同盘原子写）
```

- **Session 文件与 metadata 白名单不受线程污染**：线程数据独立存储，
  会话侧只有工作空间 state 的既有机制，无线程字段写入。
- **索引摘要 vs 完整记录**：摘要只带前端渲染所需轻量字段
  （sessionIds / chainEdges / handoffStartedAt / pendingTexts / revision）；
  任何需要完整状态的操作（投递判定、head 推进）必须回读完整记录，
  不得用摘要做权威判定（早期 bug：gateway 用摘要判 fresh 恒 false）。
- **双集合漂移事故教训**：`WORKSPACE_SESSION_AGENT_IDS` 曾在
  server/shared/constants.js 与三个 mirror 脚本各存一份副本，coder 加入
  一份漏掉其余 → compact mirror ENOENT。已全部统一为从权威常量 import。

---

## 4. 三条输入链路的分工（核心设计）

### 4.1 分层原则

输入的归属层级决定它走哪条物理通道，这是唯一的路由依据：

```
意图归属 = 工作（work）
 → Thread Inbox（持久，跨会话 / 跨重启 / 跨 runtime 更替）
 → 仅在目标 runtime 不可靠时使用：交接窗口内、会话非 head
 → 出口 = 普通消息入口（submitUserTurn），不发明新执行语义

意图归属 = runtime（当前正在运行的这轮对话）
 → viewer user-turn（忙时自动进 viewer 队列，call 间排队）
 → runtime 健康、会话是 head 时永远直走；PH 等纯会话零经过
 → UserInputFeature 槽位（/input）不属于本层（见 §4.5）

意图归属 = 调度（dispatch 系统的定时/触发调用）
 → RuntimeInbox / CallEnvelope
 → 聊天不走这条通道；envelope 不承载 thread 元数据（已清理，见 §6）
```

判定规则只有两个客观事实，没有第三种主观状态：

1. **会话是否是线程 head**（不是 → 消息属于工作，进 inbox）；
2. **线程是否在交接窗口内**（是 → head 即将退役，直投结果会留在旧会话
   不被 successor 带走 → 进 inbox）。

> 术语澄清：本文的 CallEnvelope 指服务端 RuntimeInbox（dispatch 队列，
> `runtime-call-envelope.js`）。CallArbiter 内部同样用「envelope」称呼其
> 内存中的串行执行条目——那是 runtime 进程内的概念，与服务端
> CallEnvelope 是两个同名不同物，分析输入链路时不要混用。

### 4.2 服务端 InputGateway：单一真相

`server/thread-control/input-gateway.js` 的 `deliverUserInput()` 是所有
服务端用户输入投递的必经点：

```
deliverUserInput({ viewerAgentId, text, images, source, sourceRef })
  ├─ runtime 反查（getRuntimeByViewerAgentId）
  ├─ agentId 是线程宿主 且 selectedSessionId 是线程 head 且交接 fresh
  │    → Thread Inbox 暂存，返回 { delivery: 'thread_queued', threadId, commandId }
  ├─ 交接窗口收到纯图片 → 显式 409（thread_handoff_images_unsupported）
  └─ 其余情况 → 原样透传 submitUserTurn（delivery: delivered|queued|input）
```

设计要点：

- **网关只拦「交接窗口」这一个客观事实**。「非 head」是调用方 UI 路由
  问题（用户停留在旧会话页），由前端守卫负责——否则网关会吞掉合法的
  历史会话查看场景的错误报告路径。边界必须可解释。
- **投递响应显式化**：`delivery: 'thread_queued'` 让任何调用方（聊天框、
  面板、未来 IM）都能正确渲染"已暂存"反馈，而不是各自猜测投递结果。
- **幂等**：idempotencyKey = `gw-${sourceRef}`（有 sourceRef 时），网络
  重试不会重复入队。
- **append 后补投递尝试（竞态闭合）**：路由判定与 appendCommand 落盘
  之间 succession 可能已完成（advanceHead 清挡板 + applySessionSuccession
  投递过一轮）——补一次投递尝试，交接仍在进行时它是 no-op
  （handoff_in_progress），已完成时当场送达，不留无触发点的 pending。
- **接入点**：
  - `server.js` `/api/agents/:agentId/user-turn`（聊天 / 语音输入必经）；
  - `server/routes/ui-surfaces.js` 面板 action 提交。
- **IM 边界（当前声明，不实现）**：qqbot 经 CallArbiter 在 runtime 内路由，
  不经 server user-turn。未来 IM 绑定线程宿主时，应在目标会话解析处改调
  本入口——规则写在网关头注释里，防止后续 agent 接错。

### 4.3 前端守卫：UX 快路径，不是真相

`resolveThreadInputRoute()`（public/src/modules/thread-store.js）：

```
'direct'  → 会话是 head（或无线程）且无交接 → 现有输入契约，零改动
'thread'  → 非 head（session_not_head）或交接窗口（handoff_in_progress）
            → submitThreadCommand() → Thread Inbox
```

前端守卫的价值是**即时气泡反馈**（不等网络往返）；服务端网关是兜底真相
（前端预判 direct 但实际已进入交接窗口 → 响应 delivery=thread_queued →
前端再渲染气泡）。两层判定规则相同、代码各自独立、结论可以不一致但
结果收敛：要么直投成功，要么进 inbox，没有第三种"消息消失"状态。

交接窗口的前端信号有两个（OR 关系）：

- `thread.handoffStartedAt` fresh（服务端落盘状态，20s 轮询同步）；
- 本地 sidebar operation（type='create' 未 settled）——覆盖本页面发起
  交接的头 20 秒轮询滞后窗口。

### 4.4 viewer 队列与 Thread Inbox 的关系

两者不竞争，是上下游：

```
Thread Inbox（持久，意图层）
 → 交接完成 / head 就绪时由 controller 出队
 → submitUserTurn 投递给 head runtime
 → viewer 忙时进 viewer 队列（runtime 内排队）
 → call 间被消费
```

viewer 队列保持原语义：同一个 runtime 活着时的 call 间排队。它从不
跨 runtime 迁移——跨 runtime 的连续性由 inbox 承担。

### 4.5 UserInputFeature 槽位（/input）的定位

`submitInput`（input-helpers.js）是 agent 主动提问时的**回答卡**通道，
语义上是"当前 call 的一部分"。线程宿主上它遵循与主聊天相同的输入
三分工（意图归属决定通道），不做特殊例外：

- route = 'thread'（非 head / 交接窗口）：改走 Thread Inbox。直投会
  「成功但投错目标」——消息被旧 runtime 消费、留在即将退役的会话里；
  转 inbox 后经 bridge → user-turn 落到当前 head，若 head runtime 恰有
  活跃 input lease，viewer 以 delivery='input' 应答，回答语义保留；
- 兜底：槽位投递失败 / 网络异常，且会话属于活跃线程、输入为纯文本时，
  同样落 Thread Inbox（指令不丢，head 就绪后由服务端投递）；
- 带图片的 route='thread' 提交显式拒绝并提示（与主聊天入口
  persistent-input 的拒绝语义一致），保留输入，绝不静默丢弃附件；
- 正常会话（head / 无线程 / 其他工作空间）零改动（requestId / 乐观
  UI / 状态机全部原样）。

---

## 5. 交接挡板：pendingSuccession 第一等落盘状态

### 5.1 为什么不用内存态

内存方案（Map + set/clear + TTL）的三个不可接受点：

1. 状态散落在多个 set/clear 调用点，失败路径靠超时自愈 → 不可审计；
2. 服务重启即丢失 → 交接窗口重启后挡板失效，指令误投旧 head；
3. 清除点与 head 推进不原子 → 存在"head 已推进但挡板还在"或反例的窗口。

### 5.2 生命周期（单一真相）

```
写入点唯一：beginSessionHandoff
  由 integration.beginSessionSuccession 在两个路由入口各一处调用：
  - compact_and_resume（L1209 后，公共入口覆盖 detached + 同步两分支）
  - summary_resume（L1350 后）
  记录 { fromSessionId, reason, startedAt } 落盘

存活期：deliverPendingCommands 见 fresh → 返回 handoff_in_progress，
  指令保持 pending；InputGateway 见 fresh → 直投改暂存

清除点原子：advanceHead 推进 head 的同一次落盘内
  draft.pendingSuccession = null
  → 不存在"head 已换但交接意图还在"的中间态
```

### 5.3 fresh 派生与 stale 惰性自愈

`isHandoffActive(record)` 从 startedAt 派生（HANDOFF_STALE_MS = 5min），
不存过期布尔：

- **为什么派生**：落盘的过期标记需要后台扫描或读取时重写，派生则天然
  无需维护；
- **stale 的语义**：交接意图超时 = compact 流程大概率已死（失败/崩溃）。
  此时 head 仍是旧会话，把 pending 指令投向它是**正确语义**（工作回到
  交接前状态继续），deliverPendingCommands 惰性清除意图后照常投递。
- 前端同步维护同一常量与派生规则（thread-store.js 注释要求两侧同步）。

### 5.4 非 thread 宿主 / 无线程会话

`beginSessionSuccession` / `applySessionSuccession` 在宿主判定处直接
no-op 返回——纯会话（PH 等）的 compact/summary 流程与未接入线程时
逐字节一致。

---

## 6. 清理的旧时代兼容（已删除，不留 fallback）

按用户"该清理就清理"的原则，以下内容在本阶段删除：

| 项 | 位置 | 理由 |
|---|---|---|
| `queue-input` / `dequeue-input` 代理路由 | server.js | 前端零使用的旧 viewer 契约残留 |
| envelope `threadId`/`commandId` 透传 | runtime-call-envelope.js 三处 | bridge 已改走 user-turn，envelope 通道无生产者；留着误导后续开发者以为线程走 envelope |
| mirror 脚本的集合副本 | mirror-runtime.js / run-compact-mirror.js / run-one-shot-agent.js | 双列表漂移事故根因，统一 import 权威常量 |

保留项：`EnvelopeSource.THREAD` 枚举值（未来 autonomous 派发的预留位，
无使用方、无行为）。

---

## 7. 前端承接层

### 7.1 会话列表徽标（renderSessionThreadBadge）

| 状态 | 显示 |
|---|---|
| head + 交接 fresh | `接力中…`（橙色脉动，handoffing） |
| head，链长 1 | `线程·承接中` |
| head，链长 N>1 | `线程·第N棒` |
| 非 head | `已接续`（灰色，continued） |
| 线程 cancelled | 无徽标（等同纯会话） |

### 7.2 交接期占位文案（线程风格改造）

左侧边栏的占位与过渡标签，从"删旧建新"语义改为"接力"语义（仅线程宿主）：

| 位置 | 原文案 | 线程宿主文案 |
|---|---|---|
| 占位条目（pending） | 正在生成精简会话… / 正在生成摘要会话… | 上下文接力中 · 精简… / 上下文接力中 · 摘要… |
| 源会话过渡标签（retiring） | 正在关闭 | 正在交接 |
| 降级（degraded） | 关闭未完成 / 精简会话启动失败 | 交接收尾未完成 / 接力会话启动失败 |
| archive-close / delete | 正在关闭 / 正在删除 | 不变（真实关闭语义） |

顶栏指示器同步：交接窗口内 head 显示 `上下文接力中…`（含 tooltip
"期间输入将暂存到线程"）。

### 7.3 暂存气泡（persistent-input.js）

- 提交快路径判定 `thread` → 文本走 `submitThreadCommand`，toast
  "已暂存 · 新会话就绪后自动继续"，输入框即时清空（观感 = 进队列）；
- 交接窗口收到图片 → 显式报错（inbox 不支持图片，不静默丢弃）；
- 服务端兜底响应 `delivery === 'thread_queued'` → 同样渲染气泡；
- 气泡渲染合并线程 pending（`_renderQueueBubbles` 签名纳入 thread pending，
  `thread-staged` 虚线样式 + ⏸ 前缀）；
- 气泡刷新链：refreshThreads 完成后同步调 `updateQueueIndicator()` +
  分隔条 DOM 同步，不等下一轮 poll。

### 7.4 接力分隔条（chat-renderer.js + thread-store.js）

非 root 棒的聊天区顶部渲染：

```
──── 已从「会话标题」接续 · 精简交接 ────
```

- 数据源：索引摘要新增 `chainEdges: [{sessionId, fromSessionId, relayKind}]`
  （relayKind ∈ trim | summary）；
- 渲染点：`render()` 在消息 html 前拼接（模块缺席 / root 棒 → 空串零影响）；
- 签名去重的补充：聊天渲染有消息签名去重，线程数据晚于首渲时分隔条不会
  随消息重渲出现 → `_syncThreadRelaySeparator()` 在每次 refreshThreads
  完成后直接增/删/替换 DOM 节点，不动消息区。

---

## 8. 兼容性边界（纯会话零影响）

- **服务端**：THREAD_HOST_AGENT_IDS = {'coder'}，之外的工作空间在
  integration 层直接跳过；InputGateway 对非宿主原样透传；
- **前端**：thread-store.js 所有入口在无线程数据时 no-op / 空输出；
  会话列表徽标、分隔条、指示器、守卫全部条件渲染；
- **coder 也可能被当纯会话用**：会话不属于任何线程时与 PH 行为一致；
- **既有测试**：runtime-call-envelope 24 项、server-smoke 16 项、
  thread-control 32 项全绿；全量 core 除 2 个已知既有失败
  （frontend-ctx-menu-items isAssemblySession，与本工作无关）外全绿。

---

## 9. 关键实现位置速查

```
服务端
 server/thread-control/
   thread-store.js            持久化（原子写 / per-thread 锁 / 索引摘要含 chainEdges）
   thread-controller.js       唯一入口（createThread / appendCommand /
                               beginSessionHandoff / advanceHead / deliverPendingCommands /
                               isHandoffActive / findThreadBySession / findThreadByHeadSession）
   thread-inbox.js            指令纯函数层（幂等入队 / 排序 / 终态裁剪）
    thread-runtime-bridge.js   inbox → submitUserTurn 最后一跳
    thread-integration.js      会话生命周期接线（onSessionCreated（含
                                branch 分支建线程）/ beginSessionSuccession /
                                applySessionSuccession / onSessionDeleted /
                                tryDeliver）
    thread-routes.js           HTTP API（GET/POST /protoclaw/threads…）
    input-gateway.js           统一输入网关 deliverUserInput
  server/shared/constants.js   WORKSPACE_SESSION_AGENT_IDS（权威集合）
  server/routes/session.js     compact/summary succession + branch 建线程
                                + delete 线程善后的接线点
  scripts/mirror-runtime.js 等 三个 mirror 脚本统一 import 权威集合

前端
 public/src/modules/thread-store.js   线程状态 + 徽标 + 指示器 + 守卫 +
                                      暂存气泡数据源 + 接力分隔条
 public/src/modules/persistent-input.js  主聊天入口守卫 + 暂存气泡渲染
 public/src/modules/input-helpers.js     槽位应答守卫（非 head 拦截）
 public/src/modules/chat-renderer.js     分隔条渲染点
 public/src/modules/session-list-render.js  徽标渲染点
 public/src/modules/runtime-status.js   占位名（线程风格）
 public/src/modules/sidebar-render.js   过渡标签（正在交接）

会话生命周期（既有能力，线程复用而非重造）
 compact_and_resume / summary_resume
   → beginSessionSuccession（挡板）
   → handoff 导出 → successor session 创建 → runtime ready
   → applySessionSuccession（advanceHead 原子推进 + 清挡板 + 投递暂存指令）
   → 前端导航到新会话（既有 requestSwitch 链路）
```

---

## 10. 已知边界与未来方向

**当前已知边界（接受，不修）**：

- inbox 暂存指令是纯文本（图片在交接窗口显式拒绝）；
- LLM 副作用无 exactly-once 承诺：runtime 崩溃窗口内命令是否执行过
  由新会话检查真实世界状态（git/文件）判定，与 CallArbiter rollback 的
  外部副作用原则一致；
- 线程链严格线性；branch 在线程宿主上创建独立新线程（branch 路由已接
  onSessionCreated，分支会话成为新线程的 root），不在线程内分叉；
- 会话删除善后：被删会话是线程 head 时线程随之取消（pending 指令一并
  取消，避免悬空 active 线程累积）；删除非 head 棒次不动线程（历史链
  对已删会话的引用由前端标题解析退化为短 id）；归档不动线程（取消
  归档即恢复承接）。

**未来方向（本阶段不做，架构已预留）**：

- 交接完成后自动投递的续接指令模板化（当前依赖用户暂存的"请继续"）；
- context threshold 触发的自动 rotation（coordinator 决策 → 复用同一
  succession 事务）；
- autonomous 模式 + 完成协议（测试/git/PR 证据链）；
- WorkPool / 外部工单 intake / 协调 Agent（消费线程控制面，不改动地基）；
- IM 渠道绑定线程宿主时在目标会话解析处改调 input-gateway。
