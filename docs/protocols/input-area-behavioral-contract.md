# 输入区行为契约（重构基线）

本文档把聊天输入区（`#user-input-container` 及其附属组件）从现有实现中反推出**产品行为需求**，作为重构的验收基线：重构前后，本文档描述的所有可观察行为保持不变。

本文回答两个问题：

1. **契约**——输入区在什么条件下显示什么、用户操作触发什么、什么事件刷新什么（§3–§9、§13）。
2. **耦合现状**——今天有哪些独立的行为组件被物理捆进了输入区模块（§10 耦合盘点）。重构时逐项解耦，但每项的可观察行为仍是契约。

## 0. 范围与边界

**在范围内**：主前端（端口 1420）聊天视图的 `#user-input-container` 槽位及其全部子组件，含 persistent 常驻条、input lease 请求卡、choice 选择卡、回退对话框、队列气泡、meta bar（计时胶囊/压力 chip）、模型与思考强度选择器、语音输入、slash 浮层、图片附件、会话草稿。

**不在范围内**（独立系统，仅标注边界）：

- 工作群（work-group）工作空间的群聊输入系统（`wg-*` 自带 composer 与语音）。
- workspace surface / IM 门户的表单输入。
- DebugHub Viewer（端口 2026）。
- `#workspace-tabs-bar`、`#chat-nav-timeline`：位于 chat 容器上方，由主视图渲染管理，不属于输入区。

## 1. 术语

- **sessionKey**：会话身份键（当前实现为 `getRuntimeContextKey()`）。草稿、语音、recap、模式签名都以它关联会话。契约要求：同一运行会话的 key 稳定，切换会话必变，且同步可取（不依赖异步缓存）。
- **input lease**：runtime 主动请求输入的槽位。worker 侧不变量：一个 agent 实例同时最多持有一个 lease；渲染器同样防御性单取 `requests[0]`。
- **delivery**：`POST /user-turn` 响应的投递语义：`direct`（空闲立即消费）/ `queued`（call 间排队）/ `thread_queued`（交接中兜底进 Thread Inbox）。
- **interrupting 粘性态**：打断请求发出后的过渡态，直到同 call 终态（call.finish / callActive:false）才解除；期间任何中间轮询状态都不得把 UI 恢复成 idle。

## 2. 数据契约（与输入区直接交互的 API）

| API | 方法 | 用途 | 关键语义 |
|---|---|---|---|
| `GET /api/agents/:id/input-requests` | GET | 拉 input lease | 返回数组；单 lease 不变量由 worker 保证，渲染器防御性单取第一个 |
| `POST /api/agents/:id/input` | POST | 响应请求卡 | body: `{ requestId, input, response: { kind: 'text'\|'action'\|'choices', ... } }`；必须带幂等键 |
| `POST /api/agents/:id/user-turn` | POST | 常驻条提交 | body: `{ text, images?, source, capabilityActivations?, operationId }`；响应 `{ delivery: 'direct'\|'queued'\|'thread_queued' }` |
| `GET /api/agents/:id/queued-inputs` | GET | 真实排队队列 | 每轮 poll 同步，是排队气泡的真相源 |
| `POST /api/agents/:id/interrupt` | POST | 打断 | 幂等键；失败才回滚本地乐观态 |
| `POST /protoclaw/images/upload` | POST | 附件上传 | base64 → `{ path, mediaType, url }` |
| `POST /protoclaw/speech_to_text` | POST | ASR | 5xx/429 退避重试 2 次；4xx 直接报错 |
| `GET /protoclaw/speech_model_config` | GET | ASR 配置检查 | |
| `POST /protoclaw/swap_model` / `swap_thinking_effort` | POST | 模型/思考热切换 | 携带宿主 agentId + sessionId/runtimeId |
| `GET /protoclaw/model_config?agentId=` | GET | preset 列表 | 按会话命名空间（远程会话取远程自己的列表） |
| `GET /protoclaw/commands` | GET | slash 清单 | 唤起时拉取一次，按 agentId/runtimeId/sessionId 三元组 |
| `POST /protoclaw/capability_invoke` | POST | slash invoke 执行 | 控制动作，不构造 user-turn |
| `POST /protoclaw/generate_recap` | POST | 离开摘要 | **当前已禁用**，链路保留 |

所有写类请求携带 `x-idempotency-key`（ADR-0011，远程代理闸强制）。

**inputRequests 单元形状**：`{ requestId, mode?, placeholder?, initialValue?, actions?: [{ id, label, variant?, data? }], questions?（mode==='choices' 时） }`。

**动作过滤契约**：请求卡 footer 不渲染 `rollback_to_call` / `compact_from_call` 动作——这两个动作由消息行的"编辑此轮"按钮与回退对话框消费。

## 3. 显示模式矩阵

输入槽位（`#user-input-container`）按优先级从上到下判定唯一模式：

| 优先级 | 条件 | 模式 | 显示 |
|---|---|---|---|
| 1 | 非 chat surface（workspace/IM 等） | `hidden` | 无 |
| 2 | `readOnlyMode`（远程只读/workspace 只读） | `readonly` | 禁用 textarea，opacity 0.5、not-allowed 光标；远程会话用专属只读 placeholder |
| 3 | 回退对话框打开 | 冻结 | 输入面整体被对话框接管，重渲染 no-op |
| 4 | 会话内压缩 in-flight（且为发起 runtime） | 压缩状态卡 | spinner + "压缩中/已用时 Xs" 计时，禁输入；仅对发起 runtime 生效 |
| 5 | choice 请求未 reject | 选择卡 | 键盘问答卡，容器加 `choice-input-active` |
| 6 | 有本地排队输入（乐观态） | `persistent` | 即使有请求也显示常驻条（排队中不弹请求卡） |
| 7 | 有非 choice 请求 | 请求卡 | 单 lease 渲染 |
| 8 | 选中 runtime（calling 或 idle） | `persistent` | 常驻条 |
| 9 | 都不满足 | `hidden` | 容器清空 |

跨模式补充规则：

- 请求卡是**单 lease**：渲染器防御性只取 `requests[0]`，多 lease 视为 worker 侧违例（渲染器仍防御单取，防止陈旧轮询响应把一个聊天面变成多个答题口）。
- choice 请求优先于普通请求卡：choice 未处理时普通输入卡不渲染（本地 reject 后立即恢复）。
- 只读模式是**明确的只读提示面**，不渲染可交互输入框。
- 模式判定读取多个全局状态（chat surface 激活性、readOnlyMode、当前 runtime、inputRequests、本地排队乐观态、runtime calling 态）；**"什么状态决定什么模式"是契约，判定代码结构不是**。

## 4. 组件清单（物理捆绑现状）

以下组件今天全部捆在输入区（主要在 `persistent-input.js` 796 行 + `input-render.js` 331 行）里，各自的可观察行为是契约，物理归属不是。§10 给出解耦地图。

| # | 组件 | 现所在模块 | 触发/刷新源 |
|---|---|---|---|
| 1 | 文本 composer（textarea + 自动增高 ≤200px + placeholder i18n） | input-render / persistent-input | 签名变化整块重建 |
| 2 | 发送/停止/打断 三态按钮 | persistent-input | runtime calling 状态 + 乐观态 + 提交中重入保护 |
| 3 | 队列气泡栈（排队 + 线程暂存两种变体） | persistent-input | 每轮 poll 拉 `queued-inputs` + 本地乐观 + 打断清空 |
| 4 | 计时胶囊（倒计时） | persistent-input | **模块加载即启动的 1s `setInterval`**；运行时快照确认起始时间 |
| 5 | 图片附件（粘贴/选择/预览/静默上传） | persistent-input | onpaste/onchange + 上传 promise |
| 6 | 模型选择器 | input-model-switcher | 按会话命名空间拉 preset，热切换 |
| 7 | 思考强度选择器 | input-model-switcher | 协议档位表 + 本地乐观缓存 |
| 8 | 语音按钮 + ASR 生命周期 | voice-input | 见 §6.7 |
| 9 | slash 浮层 | slash-menu（document 级，逻辑解耦） | 共享 `.user-input-textarea` class 契约 |
| 10 | 上下文压力 chip | persistent-input（数据源在 chat-context-bar） | 每轮 poll 由上下文栏计算回写 |
| 11 | recap 提示 | recap-hint（已禁用） | 链路保留 |
| 12 | 会话草稿缓存 | **voice-input.js**（错位） | oninput 写入 / 重建回填 |
| 13 | 焦点与光标保持 | input-render | 重建前后记录/恢复 |
| 14 | 打断粘性状态机 | persistent-input + runtime-status 通知栏联动 | interrupt 请求发出 → 粘性到 call 终态 |
| 15 | Thread Inbox 路由 | persistent-input / input-helpers | `resolveThreadInputRoute` 快路径 + 服务端兜底 |
| 16 | follow-latest 视口联动 | 提交成功后强制开启 | chat-viewport mutation 通知 |
| 17 | 侧栏 agent 列表副作用 | persistent-input 提交/打断后调 `renderAgentList()` | 乐观 calling 标记 |
| 18 | 桌面通知权限申请 | persistent-input 提交时申请；desktop-notify 拥有状态 | 首次发送（用户手势内） |
| 19 | 通知状态栏联动 | interruptAgent 直接操作 `#notification-status` DOM | 跨模块 DOM 直改 |

物理捆绑 ≠ 契约。重构应把上表每行拆成独立组件/领域，只保持 §5–§9 的可观察行为。

## 5. 组件显示需求

### 5.1 常驻输入条（persistent）

- 显示条件：chat surface 激活 + 选中 runtime + 非 readonly + 无 pending 请求（或有本地排队输入）。
- 组成：textarea（placeholder i18n、Enter 提交、高度自动增长上限 200px）+ 工具栏（attach / 模型 / 思考 / 语音 / 发送-停止）。
- 发送-停止按钮三态：send（空闲）/ stop（calling 或提交乐观态）/ stop+busy（打断中，粘性）。
- 无 runtime 选中时不渲染。

### 5.2 请求卡（requests 模式）

- 同款工具栏（复制粘贴的两份模板之一，重构可合一），textarea id=`input-<requestId>`。
- footer 渲染请求 actions（过滤 rollback/compact 两个内部动作）。
- 50ms 后自动聚焦、光标到末尾、无草稿时回填 `initialValue`。
- 每张卡绑定渲染时 runtime；提交以绑定 runtimeId 为目标。

### 5.3 选择卡（choice）

- 逐题问答：题号进度、≤4 选项 + 可选自定义输入、上下文背景侧栏（收起/展开）、进度提示。
- 键盘：↑↓ 选选项、←→ 切题、Enter 确认、Esc 跳过并打断；textarea 内光标不处边缘时方向键归文本编辑（智能边界）。
- 临时收起为 mini 按钮（显示进度 n/m），点击展开；点击容器空白处也折叠。
- "跳过并打断"：本地立即标记 rejected + 恢复普通输入面（不等网络），后台发 interrupt。
- 状态（已选、自定义文本、折叠态、题号）按 requestId 存续，跨重绘保留。

### 5.4 队列气泡栈

- **viewer 排队气泡**（call 间排队）与**线程暂存气泡**（Thread Inbox pending）同栈渲染、样式变体区分语义。
- 双源：本地乐观气泡（发送后立即出现）+ 后端真实队列同步（每轮 poll），后端是真相。
- 文本截断 80 字符，title 全文。

### 5.5 meta bar（输入卡上方元信息条）

- **计时胶囊**：runtime calling 期间显示"已运行 X"；空闲且有上次结束时间时显示"上次对话 X 前"；仅 chat surface 显示。运行起始时间以运行时快照确认（快照未达时本地兜底，首个有效快照可回拨纠正，防旧值回拨）；1s 定时器刷新（模块加载即启动的 `setInterval`）。
- **上下文压力 chip**：上下文用量 ≥ 压缩阈值 100% 时出现在输入卡顶部，回落自动消失。数据源是上下文栏每轮 poll 的计算，无独立状态机。
- **recap 提示**（当前禁用）：链路保留，行为=不显示。

### 5.6 模型 / 思考强度选择器

**模型按钮**：

- 文案显示当前生效 preset 名；优先级：overview 快照 `presetName` > agent 配置默认；合成名 `__default__` 时显示 overview 的实际 modelName。
- 下拉列表按会话命名空间拉取（缓存按会话身份失效）；项显示名称、视觉支持图标、上下文长度（K）。
- 切换：loading → success（显示实际切到的模型名）/ error toast；成功后清思考强度覆盖、刷新 preset、同步上下文栏。
- 寻址用宿主 agent id（非 viewer 子 UUID），携带 sessionId/runtimeId。

**思考强度按钮**：

- 当前模型不支持思考 → 按钮禁用（半透明 + "不支持思考" + title 提示），点击无响应。
- preset 列表未加载时显示中性文案"思考强度"并异步回源（不得误报"不支持思考"，不得无限 fetch 循环）。
- 档位表按协议（openai/anthropic）区分；首项"默认（预设）"清除覆盖。
- 当前值来源优先级：本地乐观缓存 > overview 快照 > preset 默认。
- preset 缓存按会话身份失效（远程会话取远程自己的列表）。

### 5.7 语音按钮

见 §6.7。

### 5.8 slash 浮层

独立组件（document 级监听，与输入框解耦，移除该模块系统照常工作），与 composer 仅共享 `.user-input-textarea` class 契约。行为见 §6.9。

## 6. 交互行为契约

### 6.1 发送（persistent 条 → `POST /user-turn`）

1. Enter（无修饰键）提交；Ctrl+Enter / Shift+Enter 换行；点击发送按钮提交。
2. 空文本且无图片 → 不提交；有图片无文本 → 允许（text 占位 `' '`）。
3. 提交前：等待静默上传中的图片完成；消费 slash 激活（capabilityActivations）随消息流动；申请桌面通知权限（首次，用户手势内）。
4. 请求带幂等键 + `operationId`；响应 `delivery` 三分支：
   - `thread_queued`：已进 Thread Inbox → 刷新线程列表 + "已暂存 · 新会话就绪后自动继续" toast。
   - `queued`：本地乐观排队气泡 +1。
   - 其他（direct）：乐观标记 calling（侧栏重渲染、按钮切 stop、清打断抑制、记录 call 开始时间供桌面通知）。
5. 成功后：清空当前 live textarea（校验仍属同一会话，防重建后误清/复活）、删草稿键、清图片、清 recap、开启 follow-latest 窗口并强制跟随、`renderAgentList()` 乐观刷新。
6. 失败：error toast；归还 slash 激活（重试仍携带）；输入与图片保留。
7. 提交期间重入保护（防连点误触暂停）；按钮乐观切 stop 提供即时反馈，此期间点击不得触发打断。
8. **live 元素校验契约**：await 期间输入面可能整块重建；清空/写回必须重新定位当前 live 元素并校验 sessionKey——已发送文本不得残留或经草稿写回"复活"。

### 6.2 请求卡提交（`POST /input`，kind: text）

- 携带渲染时绑定的 `requestId` + runtimeId（`kind: 'text'`，含 images payload）。
- 成功：乐观清空 inputRequests 并重建输入面；follow-latest 窗口开启；乐观标记 calling；侧栏刷新；后台 poll。
- 卡片绑定渲染时 runtime：提交过程中切换会话，成功结果绝不写进新会话视图。
- 提交失败且当前会话属活跃线程：兜底落 Thread Inbox（带图片时不兜底，保留输入重试）。
- 全部失败：归还 slash 激活，输入保留供重试。

### 6.3 动作按钮（kind: action）

- 请求卡 footer 按钮 → `kind: 'action'` 提交；成功后乐观清空 + follow-latest + calling 标记，同请求卡。

### 6.4 打断（stop 按钮）

- 粘性 interrupting 态：请求发出后，中间轮询状态（排空中的 callActive:true）不得恢复按钮；直到同 call 终态。
- 请求未被接受（网络失败/显式失败）才回滚 interrupting 态 + error toast；成功请求无超时回滚（防旧轮询制造"假恢复"）。
- 打断同时：清本地排队乐观态、通知状态栏显示"正在停止…/等待当前步骤安全退出"过渡态、侧栏刷新。
- 打断优先于语音状态：录音中点停止 = 打断 Agent，不改写为"停止录音并发送"。

### 6.5 键盘

- Enter 提交 / Ctrl+Enter、Shift+Enter 换行（persistent 与请求卡一致）。
- slash 菜单激活（有可选项）时：Enter/↑/↓/Tab/Esc 归菜单（capture 拦截）；空态/关闭时归输入框（`/` 文本当普通消息发送，发送路径对 slash 零感知）。
- 选择卡：↑↓ 选项、←→ 切题、Enter 确认、Esc 跳过并打断（智能边界见 §5.3）。

### 6.6 图片附件

- 入口：粘贴图片、文件选择。>10MB 拒绝（console 提示）。
- 选择后立即本地 data URL 预览 + 静默后台上传（用户无感知）；发送前等待全部上传完成，消息携带服务端 path。
- 预览跨重建恢复；可单个移除；发送成功清空。
- Thread Inbox 不支持图片：快路径显式报错（保留输入与图片）；槽位路径带图片时不兜底。

### 6.7 语音输入

- 麦克风按钮 → toggle：录音中再点 = 停止；停止中/转写中忽略新启动。
- 未配置 ASR → alert 引导设置；非安全上下文 → 明确提示（SSH 端口转发场景引导 localhost）。
- 录音中：按钮 recording 态 + 开始/停止音效（Web Audio 预解码低延迟，首次回退 HTMLAudio）。
- 录音中点发送/Enter = 停止录音，转写完成后自动发送（意图跨重绘保留）。
- 转写中：发送按钮禁用（voice-disabled）、语音按钮转圈；Enter/点击发送不再触发提交或打断。
- ASR 失败：5xx/429 指数退避重试 2 次；4xx 直接报错；alert 提示。
- 转写结果插入光标位置并写入草稿缓存。
- **跨会话行为**：转写完成时会话已切 → 结果暂存，切回该会话时注入光标位置；录音中已点发送的自动发送跨会话直接 POST 原 agent（拼接原会话草稿文本），失败回滚到草稿 + error toast。
- 渲染重建边界：同会话 persistent↔requests 重绘保留录音（按钮引用重绑）；会话切换/离开输入面才取消录音。
- 录音期间切换会话（权限弹窗期）→ 立即释放麦克风放弃录音。

### 6.8 队列气泡

- 双源同栈：**线程暂存**（交接窗口/非 head 暂存）+ **viewer 排队**（call 间排队），样式变体区分。
- 本地乐观（发送后 delivery=queued）+ 后端真实队列同步（每轮 poll，in-flight 去重）双源，后端是真相。
- 打断时清空本地排队乐观态。

### 6.9 模型/思考强度切换

见 §5.6 显示契约。交互补充：切换成功后清思考强度覆盖缓存、刷新 preset 列表、同步上下文栏；失败仅 error toast，按钮显示不变。

### 6.10 slash 命令

- 触发：任一 `.user-input-textarea` 内容以 `/` 开头 → 浮层（宿主命令 + 会话命令动态拉取）。
- 键盘归属：菜单有可选项时 Enter/↑/↓/Tab/Esc 归菜单（capture 拦截）；空态/关闭时归输入框。
- invoke 型：执行控制动作，绝不构造 user-turn；prompt 型挂 pill 随消息流动（`capabilityActivations` 随 user-turn 提交，失败归还）。
- 输入框被重建时浮层跟随当前 live textarea。

### 6.11 选择卡交互（choice request）

- 逐题问答：进度 n/m、选项上限 4 + 可选自定义输入、上下文背景侧栏（收起/展开）、键盘（↑↓ 选项、←→ 切题、Enter 确认/下一题、Esc 跳过并打断）、临时收起为 mini 按钮（显示进度 n/m）、点击容器空白折叠。
- "跳过并打断"：立即恢复普通输入面（不等网络），后台发 interrupt。
- 提交：逐题记忆，最后一题提交 `kind: 'choices'` + 汇总文本；目标 runtime 绑定渲染时的 lease。
- 自定义输入 Enter 确认、Shift+Enter 换行。

### 6.12 回退对话框与压缩

- 消息行"编辑此轮"按钮显隐 = 存在 rollback 请求 + 该轮可回退（runtime 提供 availableCallIndices 时按其过滤；handoff seed 消息永不可回退）。
- 对话框打开期间输入面渲染冻结（`_rollbackDialogOpen`）。
- "回退到此轮" → 动作提交（携带原消息草稿）；"从此处压缩" → 进入会话内压缩状态（压缩状态卡 + 计时，禁输入，仅对发起 runtime 生效），完成后自动恢复输入。

## 7. 状态保持与恢复契约

| 状态 | 契约 |
|---|---|
| 未发送草稿 | 按 sessionKey 缓存；跨重建/跨会话不丢、不串；发送成功删除；oninput 实时写 |
| 焦点与光标 | 重建前焦点在输入 textarea 内 → 重建后恢复焦点+光标位置；不抢占他处焦点 |
| 语音意图 | 录音中点发送的自动发送意图跨重建/重绘保留；跨会话自动发送指向原 agent |
| 语音结果 | 会话切换期间完成的转写暂存，切回注入 |
| 图片附件 | 预览跨重建恢复；发送成功清空 |
| 排队气泡 | 本地乐观 + 后端真实双源，后端同步是真相 |
| 选择卡状态 | 跨重绘按 requestId 保留 |
| 打断粘性态 | 请求发出后到 call 终态前不可恢复 |
| 计时起始 | 快照未到用本地时间兜底，首个快照回拨纠正，确认后只接受更新值 |

## 8. 刷新触发源（重构必须保持"事件→显示"映射）

输入面显示由以下事件驱动（当前实现为 19 处手动调用 + 签名比对去重；重构可收敛为单一状态映射，但事件覆盖面不得减少）：

| 事件源 | 触发什么 |
|---|---|
| poll 每周期 | inputRequests JSON 变化 → 重渲染输入面；队列同步（拉 `queued-inputs`）；计时胶囊（1s 独立定时器）；压力 chip（随上下文栏） |
| 会话切换/加载 | 输入面随会话视图整体重渲染；草稿按新 sessionKey 恢复 |
| 主视图渲染 | 每次都附带输入面重渲染（容器空态/模式对齐） |
| runtime calling 状态翻转 | 按钮三态 + 输入面模式翻转时重渲染 |
| 提交成功（三条路径） | 乐观清空 inputRequests + 重建 + follow-latest + calling 标记 |
| 选择卡交互（选项/收起/展开/拒绝/切题） | 重渲染选择卡 |
| 回退对话框关闭 | 恢复输入面 |
| generative-ui input 型 action 提交 | 乐观清空请求 |
| 打断发起/失败 | 按钮粘性态 + 通知状态栏过渡态 + 队列清空 |
| 队列后端同步 | 气泡增量更新（签名比对） |
| 会话可见性恢复（tab 前台） | 强制刷新 calling 状态与通知状态（后台节流可能错过状态迁移） |

## 9. 错误与降级路径（契约）

| 场景 | 行为 |
|---|---|
| 提交失败（网络/HTTP） | error toast；归还 slash 激活；输入与图片保留 |
| 槽位投递失败且属活跃线程 | 兜底落 Thread Inbox（带图片时不兜底，保留输入） |
| Thread Inbox 不支持图片 | 显式报错（快路径 throw / 槽位路径拒绝兜底），绝不静默丢弃附件 |
| 打断请求失败 | 回滚 interrupting 态 + error toast；成功请求无超时回滚（必须等 call 终态，防"假恢复"） |
| ASR 失败 | 5xx/429 退避重试 2 次；4xx 直接报错；alert 提示 |
| 语音模型未配置 | alert 引导设置 |
| 麦克风不可用/非安全上下文 | 明确提示（含 SSH 端口转发场景引导） |
| 附件上传失败 | 预览保留（本地 data URL）；发送时不携带未成功的图片 |
| preset 加载失败 | 模型下拉不渲染；思考强度显示中性文案（不误报"不支持思考"）；不陷入无限 fetch |
| 模型/思考切换失败 | loading → error toast，按钮显示不变 |
| 语音跨会话自动发送失败 | 文本回滚草稿缓存 + error toast |
| slash 会话清单拉取失败 | 仅会话命令缺席，宿主命令可用，下次唤起重试 |

## 10. 耦合盘点（重构解耦地图）

当前输入区物理上捆绑了以下领域（各行的**可观察行为**是契约，物理归属不是）：

| 捆进来的东西 | 当前宿主 | 数据/状态真相在 | 与 composer 的真实关系 |
|---|---|---|---|
| 文本输入 composer | input-render / persistent-input | DOM + 草稿缓存 | 本体 |
| 发送/停止/打断按钮 | persistent-input | runtime calling 状态 + 本地乐观 | Agent 生命周期控制，非输入 |
| 队列气泡栈 | persistent-input | 本地乐观 + 后端 `queued-inputs` | 排队语义，非输入 |
| 计时胶囊 + 1s 定时器 | persistent-input（模块加载即启动） | 运行时快照 callStartedAt | 运行状态展示，非输入 |
| 图片附件 + 后台上传 | persistent-input | 模块内 `_pendingImages` | 消息组装，非输入 |
| 模型选择器 | input-model-switcher | overview 快照 + preset 缓存 | 模型热切换，非输入 |
| 思考强度选择器 | input-model-switcher | 乐观缓存 > overview > preset | 模型热切换，非输入 |
| 语音输入完整生命周期 | voice-input | voice-input | 独立域，恰好挂在工具栏 |
| 会话草稿缓存 | **voice-input.js**（错位） | voice-input | 纯 composer 状态 |
| slash 浮层 | slash-menu（document 级，已解耦） | slash-menu | 仅共享 textarea class 契约 |
| 上下文压力 chip | persistent-input（渲染）| chat-context-bar（计算） | 数据源在上下文栏域 |
| recap 提示 | recap-hint（已禁用） | recap-hint | 禁用状态 |
| 焦点/光标保持 | input-render | DOM | 重建的对抗性补丁 |
| 打断粘性状态机 | persistent-input + runtime-status | runtime-status | 通知栏直改 DOM |
| Thread Inbox 路由 | 提交路径内联 | thread-store | 提交路由语义 |
| follow-latest 视口联动 | 提交成功回调 | chat-viewport | 副作用联动 |
| 侧栏 agent 列表刷新 | persistent-input 提交/打断后 | sidebar-render | 跨域副作用 |
| 桌面通知权限申请 | persistent-input 提交时 | desktop-notify | 用户手势依赖 |

解耦方向（重构时）：composer 本体只保留"文本输入 + 草稿 + 发送意图"；其余各自成为独立组件，通过明确的契约（事件/订阅）接入，而不是共享一个 796 行模块的隐式全局。

## 11. 非契约（实现细节，可自由改动）

- 整块 `innerHTML` 重建 + 签名比对的渲染方式（重构目标即消灭它；但消灭后 §7 的恢复契约必须等价成立——理想情况是"无需恢复"）。
- 19 处 `renderInputRequests` 手动调用点与手动 `lastRenderedInputSignature = ''` reset 协议。
- inline `onclick` 与 window 全局函数导出。
- 两份复制粘贴的 toolbar 模板与重复 DOM id。
- 50ms/30ms/150ms setTimeout 节奏、150ms 下拉关闭动画。
- 队列气泡签名字符串格式、签名比对机制本身。
- 草稿缓存住在 voice-input.js 的物理位置。
- `getRuntimeContextKey` 作 sessionKey 的实现（保持"会话身份稳定可缓存"契约即可）。
- 事件→显示的映射实现（只要 §8 的事件覆盖与显示结果不变）。

## 12. 已知怪癖（不得恶化，允许改善）

1. "已发送文本不残留、不复活"是硬契约（当前靠 live 元素重查 + sessionKey 校验实现）。
2. 录音边界是 sessionKey 而非 DOM：同会话重建保留，跨会话取消。
3. 打断粘性：请求发出后任何中间轮询不得把按钮恢复成 send；失败才回滚。
4. 排队气泡"本地乐观 + 后端真相"双源，同步以后端为准。
5. slash 键盘归属是 capture 拦截，优先级高于输入框键盘处理。
6. stale check 只信同步设置的 `currentRuntimeAgentId`；`allAgents` 派生值会暂态错位。

## 13. 验收清单

- [ ] 七种模式（hidden/readonly/compacting/choice/requests/persistent + 回退对话框接管）显示条件与 §3 矩阵一致
- [ ] Enter / Ctrl+Enter / Shift+Enter 语义；请求卡与 persistent 条行为一致
- [ ] 发送三态按钮（send/stop/interrupting）状态机正确，中间阶段不伪装 idle
- [ ] 提交三 delivery（direct/queued/thread_queued）+ 请求卡 `/input` 行为不变
- [ ] 图片附件全流程 + Thread Inbox 拒绝语义
- [ ] 语音全流程（录音/停止/转写/自动发送/跨会话暂存注入/重试）
- [ ] 草稿跨重建、跨会话保持与清理；已发送文本不复活
- [ ] 焦点与光标恢复（不抢占他处焦点）
- [ ] 队列气泡双源同步与样式区分
- [ ] 计时胶囊两形态 + 刷新回拨纠正
- [ ] 模型/思考强度选择器显示优先级与禁用逻辑
- [ ] slash 键盘归属规则
- [ ] 选择卡键盘导航、折叠/展开、跳过并打断
- [ ] 回退对话框冻结输入面；"从此处压缩"状态卡与自动恢复
- [ ] 上下文压力 chip 出现/消失
- [ ] 会话切换：草稿不串、语音暂存注入、跨会话自动发送指向原 agent
- [ ] 所有错误路径（toast/归还激活/输入保留）行为不变
- [ ] 打断粘性态不被中间轮询破坏
