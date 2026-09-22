# 群聊系统：现状调查、已做调整与后续主线

> **日期**：2026-06-22（2026-06-23 更新）
> **状态**：调查 + UI 重构已完成，上下文注入和管理员增强已完成
> **定位**：供后续接手者快速建立完整认知，降低上手成本

---

## 目录

1. [用户原始意图](#1-用户原始意图)
2. [调查结论：当前系统实际状态](#2-调查结论当前系统实际状态)
3. [本次已完成的调整](#3-本次已完成的调整)
4. [代码索引](#4-代码索引)
5. [后续主线：产品定义与实际表现](#5-后续主线产品定义与实际表现)

---

## 1. 用户原始意图

### 1.1 核心诉求

用户在 QQ 中口述了以下诉求（原文转述整理）：

> 群聊里的 agent 概念，或者管理员概念，它是非常非常特殊的。它不是 agent 的会话实体，也不是工作空间的代称。目前 UI 表现上不太符合我的意思。比如我 @了编程小助手，我预期的是当编程小助手开始接活的时候，它就往群里发一个消息——可以是一个事件卡片，代表某个对话已经启动了，开始干活了，给人一种信心：你确实是干了，而不是苦等半天然后输出一段不对的话，或者卡死了就不发。
>
> 目前是一种很生硬的方式：完成事情以后往群里同步消息。同时，是弄个新会话还是继续个老会话？@管理员的时候管理员注入了什么上下文信息？这些事情目前是有点乱的。
>
> 请调查现状，把整个交互逻辑全部梳理打通。不是谈虚的做了什么，而是一个很清晰的交互逻辑：目标是什么，面临什么情景，做了什么操作，预期的用户心智感知是什么，界面上有什么反馈，对 agent 来说上下文是什么、权限是什么、能做什么。

### 1.2 第二轮指令（UI 风格）

> 落实调整，借着这个机会把 UI 整体表现全面调整。不希望群聊里出现任何 emoji 或挤在消息上的状态——显得臃肿，变成了大工作台的感觉。要追求效率、逻辑清晰。
>
> 界面风格要遵循 Claw 项目其他界面的设计：宽松的间距、呼吸感、排布、字体，不要出现特别细的小字。
>
> 但群聊和 AI 对话的区别在于：群聊要强调消息性——消息必须有块、有卡片包裹，边界清晰。AI 对话更像在读报告，是无界宽广的。消息则必须有包裹、有边界。

---

## 2. 调查结论：当前系统实际状态

### 2.1 完整数据流（代码级别，非设计意图）

以**辅助模式下用户 @编程小助手**为例：

```
用户在 work-group workspace 输入 "@编程小助手 做某事"
      │
      ▼
work-group-ui.js handleSend()
      │  纯文本匹配 displayName 解析 @mentions
      │  POST /protoclaw/group_chats/:chatId/messages
      │  body: { text, mentions: [{ identityRef: 'programming-helper:main' }] }
      │
      ▼
server.js POST handler (~line 7001)
      │  创建 message，routing = { status:'pending', targetIdentityRef, targetWorkspaceId }
      │  appendGroupChatMessage() 写入 JSON 文件
      │  异步 dispatchGroupChatMessage()
      │
      ▼
dispatchGroupChatMessage() (~line 6718)
      │  读 initiativeMode → 'assist' → 直接 dispatch
      │  调用 dispatchToIdentity()
      │
      ▼
dispatchToIdentity() (~line 6629)
      │  1. resolveGroupChatSession() → persistent 复用 chat.sessions[identityRef]
      │  2. startManagedAgent() 如果 runtime 不在跑
      │  3. waitForManagedRuntimeReady()
      │  4. enqueueGcInbox(runtimeKey, { id, text, gcChatId, gcIdentityRef })
      │  5. updateMessageRouting → status = 'delivered'
      │  6. [新增] 追加"任务已启动"事件卡片
      │  7. trackGroupChatDispatch() → 每 3s 轮询 running 状态
      │
      ▼
GroupChatBridgeFeature (bridge.ts) — 运行在 programming-helper 进程内
      │  runLoop() 长轮询 /protoclaw/gc/inbox
      │  agent 空闲 → dispatchViaArbiter() → callArbiter.enqueue() → agent.onCall(text)
      │  agent 忙 → buffer → @StepStart 注入为 system-reminder
      │  call 完成 → postWriteback()
      │
      ▼
server.js POST /protoclaw/gc/writeback (~line 6585)
      │  把 agent 完整 response 追加为一条 from=identityRef 的消息
      │
      ▼
trackGroupChatDispatch() 轮询到 running→idle → status='completed'
      │
      ▼
前端 3s 轮询 loadActiveChat() → 用户看到 agent 回复 + routing 状态变化
```

### 2.2 逐项断点

#### 断点 1：反馈延迟（已部分解决）

**问题**：用户 @agent 后只能看到消息上 routing badge 变化（⏳→🔄→✓），没有独立的"任务已启动"事件。agent 完整回复在处理完后一次性 dump 进群。

**已做**：在 `dispatchToIdentity` 成功投递后追加 `kind: 'event'` 消息（事件卡片）。

**未做**：writeback 仍然是 agent 完整回复的一次性 dump，没有流式/分段能力。群聊消息应该是精简汇报 + 导航链接，不是完整输出。

#### 断点 2：Session 管理

**现状**：`resolveGroupChatSession()` 对 persistent 身份执行 `chat.sessions[identityRef] → sessionId` 映射。同一群、同一身份永远复用同一 session。

**问题**：
- 没有"引用 session"的 UI 机制。设计文档说"引用=继续，不引用=新开"，代码完全未实现
- 每次复用同一 session，用户无法在同群里对同一 agent "新开一件不同的事"
- 用户无从知道消息发到了哪个 session

**未做**：session 引用选择器、新建/继续的显式选择。

#### 断点 3：管理员身份混乱

**设计意图**（文档）：管理员是"群聊的功能层"，不是 member，不是持续运行时。按需激活，用完释放。

**代码现状**：
- `work-group` prebuilt agent 就是管理员，有 runtime、session、system prompt
- `work-group:admin` 通过 `collectIdentities()` 被当作普通 identity 暴露（`groupChat: true`）
- 用户建群时能在成员选择里看到"管理员"，但它不是应该被选的"干活成员"
- 管理员是 persistent 运行时，和文档的"按需激活"矛盾

**未做**：管理员身份重新定义。

#### 断点 4：上下文注入（已解决）

**当时问题**：`composeDispatchPrompt()` 只做 `[群聊：chatName]` 前缀 + 原文。没有群聊上下文、近期消息摘要、群目标。

**已解决（2026-06-23）**：
- `composeDispatchPrompt` 现在包含群聊ID
- 新 session 时通过 `prepareAdminContext` 预注入群记忆摘要
- 续接时注入 catch-up（未读消息 + 事件消息）
- 所有上下文通过 `contextText` 分离传递 → bridge `@CallStart` 注入为 `<system-reminder>`
- GROUP.md 通过 MemoryFeature 注入
- 详见 [admin-layered-memory-design.md](../plans/2026-06-22-admin-layered-memory-design.md)

#### 断点 5：模式系统

| 模式 | 实际行为 | 问题 |
|------|---------|------|
| 辅助 (assist) | 直接 dispatch | 基本可用 |
| 规划 (plan) | 直接 dispatch + 通知 admin 观察 | admin 收到 `[观察 · 群名]`，但不一定做有意义的事 |
| 执行 (execute) | 转发 admin，admin 用 gc_dispatch 二次派发 | 多一层 LLM 理解，不可靠 |

`autonomyMode` 只在 execute 模式下被传入 admin prompt 文本，无结构化约束。

#### 断点 6：writeback 是完整输出 dump

agent 的 2000 字代码回复直接整条塞进群里，没有精简摘要 + 导航链接。

---

## 3. 本次已完成的调整

### 3.1 任务启动事件卡片（server.js）

**改动文件**：`server.js`，`dispatchToIdentity()` 函数内（~line 6706）

在成功 enqueue gc inbox 并更新 routing 为 `delivered` 之后，追加一条 `kind: 'event'` 的系统事件消息：

```js
await appendGroupChatMessage(chatId, {
  id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  chatId,
  from: 'system',
  kind: 'event',
  event: {
    type: 'task_started',
    identityRef,
    identityName: identityInfo?.displayName || workspaceId,
    sessionId,
    workspaceId,
  },
  // ...
});
```

**效果**：用户 @agent 后几秒内，群里出现一条事件卡片"编程小助手 已开始处理 · 查看会话"，给予即时反馈。

### 3.2 全面 UI 重构

**改动文件**：

| 文件 | 改动 |
|------|------|
| `public/styles/work-group.css` | 全新创建，覆盖 `components.css` 中的旧 wg- 样式 |
| `public/index.html` | 在 `components.css` 之后加载 `work-group.css` |
| `public/src/modules/work-group-ui.js` | 完整重写（976 行） |

**设计决策**：

1. **移除所有 emoji**
   - 模式选择器 `INITIATIVE_MODES` / `AUTONOMY_MODES` 的 `icon` 字段全部删除
   - routing badge 常量 `ROUTING_ICONS`（⏳🔄✓✗）替换为 `DISPATCH_STATUS_TEXT`（文字）
   - 输入区 `@` 和 `🔗` 按钮替换为"提及"和"链接"
   - 发送按钮的 SVG 图标移除
   - 设置按钮从齿轮 SVG 改为文字"设置"
   - 链接列表的 `🔗` 前缀移除

2. **状态指示用 CSS 元素**
   - 态势层 session chip 用 `.wg-session-dot`（6px CSS 圆点）替代 emoji
   - 处理中状态有 `wg-pulse` 脉冲动画
   - 用户消息下方的 dispatch 状态独立为 `.wg-msg-dispatch` 行，包含圆点 + 文字 + 链接
   - 事件卡片用 `.wg-event-dot`（带有限次脉冲动画）

3. **排版与间距**
   - 最小字号 13px（原来有 10px、11px）
   - 消息内边距 10px 14px
   - 消息间距 16px
   - 消息流 `max-width: 860px` 居中
   - 输入框改为带边框卡片式 `.wg-input-editor`

4. **消息性 vs 报告感**
   - 消息气泡有明确圆角（10px）和背景色
   - 用户消息右对齐 `--active-bg`，agent 消息左对齐 `--hover-bg`
   - 事件卡片居中、最大宽度 480px、有边框
   - 群头部、态势层、消息流、输入区之间有清晰的 border-bottom 分隔

5. **CSS 架构**
   - 新 `work-group.css` 加载在 `components.css` 之后，通过 cascade 覆盖旧规则
   - 旧 `components.css` 中的 wg- 规则不删除（避免大范围改动），用 `display: none !important` 抑制旧元素
   - 后续清理时可直接删除 `components.css` 中 6549-7564 行的 wg- 段落

---

## 4. 代码索引

### 4.1 服务端（server.js）

| 功能 | 位置 | 说明 |
|------|------|------|
| Identity 注册 | `collectIdentities()` ~line 6270 | 扫描 prebuilt-agents 的 metadata.json，过滤 `groupChat: true` |
| Identity API | `GET /protoclaw/identities` ~line 6303 | 返回所有可用身份列表 |
| Identity sessions API | `GET /protoclaw/identities/:ws/:id/sessions` ~line 6312 | 返回 persistent 身份的已有 session 列表 |
| 群聊存储 | `readGroupChat()` ~line 6414 / `writeGroupChat()` ~line 6424 | JSON 文件存储 `~/.agentdev/AgentDevClaw/group-chats/<chatId>.json` |
| 消息追加 | `appendGroupChatMessage()` ~line 6446 | append-only 追加消息 |
| Routing 更新 | `updateMessageRouting()` ~line 6458 | 更新消息的 routing 状态字段 |
| Session 解析 | `resolveGroupChatSession()` ~line 6474 | persistent 复用 / one-shot 新建 |
| Prompt 组装 | `composeDispatchPrompt()` ~line 6699 | 群名 + 群聊ID 前缀 + 原文 + 链接 |
| GC Inbox 队列 | `enqueueGcInbox()` ~line 6546 / `GET /protoclaw/gc/inbox` ~line 6561 | long-poll 机制，runtime 消费 |
| GC Writeback | `POST /protoclaw/gc/writeback` ~line 6585 | agent 回复写回群聊 |
| **核心派发** | `dispatchToIdentity()` ~line 6629 | session 解析 → runtime 启动 → inbox 投递 → 事件卡片 → 状态跟踪 |
| **模式路由** | `dispatchGroupChatMessage()` ~line 6718 | assist=直接 / plan=直接+通知 / execute=转发admin |
| Admin 观察 | `notifyAdminForObservation()` ~line 6801 | plan 模式下通知 admin |
| 状态跟踪 | `trackGroupChatDispatch()` ~line 6844 | 每 3s 轮询 `/api/agents/:id/running` |
| 群聊 CRUD | `GET/POST/PUT/DELETE /protoclaw/group_chats` ~line 6904-6977 | 标准 CRUD |
| 消息 API | `GET/POST /protoclaw/group_chats/:chatId/messages` ~line 6981-7054 | 消息读取 + 发送（触发 dispatch） |

### 4.2 前端

| 文件 | 说明 |
|------|------|
| `public/src/modules/work-group-ui.js` | 群聊 UI 模块，978 行。左侧群列表 + 右侧对话（群头部/态势层/消息流/输入区/设置面板） |
| `public/styles/work-group.css` | 群聊专用样式，覆盖 components.css 中的旧规则 |
| `public/src/app-ui.js` ~line 5627 | `renderWorkGroupChatBlock()` — workspace block 渲染入口，调用 `WorkGroupUI.render()` |
| `public/src/app-ui.js` ~line 5637 | `_ensureWorkGroupEventDelegation()` — 事件委托（click/input/change/keydown） |

### 4.3 运行时 Feature

| 文件 | 说明 |
|------|------|
| `local-features/group-admin/src/index.ts` | `GroupAdminFeature` — admin 的 gc_* 工具集（gc_overview, gc_messages, gc_dispatch, gc_reply, gc_status, gc_scan_workdir, gc_save_group_md）。内嵌 `generate-group-md` skill（通过 feature source 发现机制自动注册） |
| `local-features/group-admin/src/bridge.ts` | `GroupChatBridgeFeature` — 运行在目标 agent 进程内，轮询 gc/inbox，消费群聊派发的消息。空闲时通过 CallArbiter 起新 call，上下文通过 `@CallStart` 注入为 `<system-reminder>`；忙碌时 buffer，`@StepStart` 注入为 `<system-reminder>`。完成后 postWriteback |

### 4.4 预制 Agent

| 路径 | 说明 |
|------|------|
| `prebuilt-agents/official/work-group/metadata.json` | 群聊工作空间定义。identity: `admin`（persistent, groupChat: true） |
| `prebuilt-agents/official/work-group/agent.js` | WorkGroupAgent — 挂载 GroupAdminFeature + GroupChatBridgeFeature |
| `prebuilt-agents/official/work-group/.agentdev/prompts/system.md` | 管理员 system prompt |
| `prebuilt-agents/official/programming-helper/metadata.json` ~line 28 | identities 声明：`main`（persistent）和 `explorer`（one-shot），均有 `groupChat: true` |
| `prebuilt-agents/official/programming-helper/agent.js` ~line 19,121 | 挂载 GroupChatBridgeFeature（使编程小助手能接收群聊派发） |

### 4.5 运行时启动

| 文件 | 位置 | 说明 |
|------|------|------|
| `scripts/run-prebuilt-agent.js` ~line 1729 | GC Bridge 启动 | `gcBridgeFeature.startBridgeLoop(agent, callArbiter)` |

### 4.6 设计文档

| 文档 | 定位 |
|------|------|
| `docs/plans/group-chat-command-center-design.md` | 产品概念设计（最完整，1292 行） |
| `docs/plans/2026-06-19-group-chat-implementation-plan.md` | 实施规划（Phase 0-3） |
| `docs/plans/2026-06-20-group-chat-closed-loop-execution.md` | 闭环执行规格书 |
| `docs/plans/2026-06-21-post-phase1-design-discussion.md` | Phase 1 后深度设计讨论（决策沉淀） |

---

## 5. 后续主线：产品定义与实际表现

以下是需要继续收敛的产品问题，按优先级排列。

### 5.1 P0：Session 新建 vs 继续的选择机制

**当前**：persistent 身份在同一群里永远复用同一 session。用户无法选择"新开一件不同的事"。

**目标**：
- 用户 @agent 但不引用 session → 默认创建新 session（或由模式/管理员决定）
- 用户引用已有 session → 继续该 session
- 前端需要 session 选择器 UI（类似微信引用消息，或点击身份头像弹出 session 列表）

**需要改的地方**：
- `resolveGroupChatSession()` — 增加 `sessionRef` 参数支持
- `POST /protoclaw/group_chats/:chatId/messages` — 接受 `sessionRef` 字段
- `work-group-ui.js` — 在 @mention 后弹出 session 选择器
- 可能需要 `GET /protoclaw/identities/:ws/:id/sessions` 的数据来填充选择器

### 5.2 P0：Writeback 机制重新设计

**当前**：agent 完整回复（可能几千字代码）一次性 dump 进群聊。

**目标**：
- 群聊中只出现精简的状态消息（"已完成，修改了 3 个文件"）
- 完整回复留在 agent 自己的 session 里
- 群聊消息带"查看完整回复"导航链接

**需要改的地方**：
- `bridge.ts` `postWriteback()` — 不直接写完整 response，改为写精简摘要
- 可能需要 agent 在 prompt 中被要求输出两份（完整回复 + 群聊摘要）
- 或服务端在 writeback 时做截断 + 导航链接

### 5.3 ~~P1：管理员身份重新定义~~（已基本解决）

**当时问题**：`work-group:admin` 是一个 persistent prebuilt agent runtime，出现在成员选择列表里，与设计意图"群聊功能层"矛盾。

**2026-06-23 解决方案**：保持 admin 是 persistent runtime（选择 A），但大幅增强其上下文感知和身份定位：
- system.md 重写，明确"你的环境"和"你不是执行者"的身份认知
- 群聊ID 在所有注入路径中标注，管理员不会搞错 gc_* 工具参数
- 上下文通过 system-reminder 注入（不混入用户消息），管理员清晰区分环境背景与实际消息
- GROUP.md 文档体系：群聊绑定 workDir，`.agentdev/GROUP.md` 作为静态项目背景
- 内嵌 `generate-group-md` skill，管理员可主动生成项目背景文档
- 管理员默认对话不写入群聊（suppressAutoWriteback），需显式 `gc_reply`

### 5.4 ~~P1：上下文注入增强~~（已完成）

**当时问题**：`composeDispatchPrompt()` 只注入 `[群聊：chatName]` + 原文。

**已完成**：
- 新 session 时预注入群记忆摘要（群聊记录 + 群聊ID）
- 续接时注入 catch-up（未读消息 + 事件消息）
- 首轮跳过 catch-up 去重
- 所有注入路径包含群聊ID
- 上下文通过 `contextText` 分离传递 → bridge `@CallStart` 注入为 `<system-reminder>`
- GROUP.md 通过 MemoryFeature 注入（首轮）

### 5.5 P2：模式系统的结构化约束

**当前**：autonomyMode 只是 prompt 文本，无结构化约束。

**目标**：
- autonomyMode = `confirm` 时，admin 必须先出方案再执行（结构化 checkpoint）
- autonomyMode = `cautious` 时，admin 遇到不确定时必须停下来问
- 规则系统（禁止创建会话、禁止删除资源等）需要 checkbox 而非仅 prompt 文本

### 5.6 P2：每日总结 / 长期记忆

**设计文档描述**：群聊中有 `kind: 'summary'` 的特殊消息类型，由 admin 定期生成。

**当前**：admin 有 `gc_summary` 工具可以写 summary，但没有自动触发机制。

**需要做**：
- 定期触发机制（dispatch 系统已有定时能力，可复用）
- 上下文组装时读取最近的 summary

### 5.7 关键设计原则提醒

接手者务必先读 `docs/plans/2026-06-21-post-phase1-design-discussion.md`，其中记录了被否决的方案和核心理念：

- **群聊里的 Agent 是抽象身份**，不是进程、不是 session、不是工作空间
- **@mention 是标识符，不预设行为**。行为由模式 + session 引用共同决定
- **模式和状态栏正交**。模式管"怎么反应"，状态栏管"发什么"
- **态势感知的对象是活跃 session**，不是 agent 成员
- **Session 不引用时默认创建新 session**
- **管理员回复直接写入群聊**（区别于普通 agent 回复在自己 session 里）

这些原则在当前代码中**尚未完全落地**。后续开发应以这些原则为目标，逐步收敛实现。
