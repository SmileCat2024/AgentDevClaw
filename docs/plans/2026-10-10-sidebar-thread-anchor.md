# 侧栏线程锚改造：消除接续空窗

状态：提议中（待用户确认方案后转实施）
关联：[ADR-0010](../adr/0010-sidebar-unified-projection.md)（侧栏统一投影）、[ADR-0024](../adr/0024-app-workspace-eternal-thread-model.md)（APP 型工作空间与线程基础设施）

## 1. 问题

coder 线程自动接续（上下文满触发 rotation）时，左侧列表条目立即消失，接续完成后新条目才出现，中间存在与接续耗时等长的空窗（trim + 新 runtime 启动 READY，通常数秒到数十秒）。用户感知为"对话断了"。

手动 replacement（侧栏发起）没有这个问题：旧条目显示"正在交接"（`isThreadRelay` 分支，`replacementMutation` 前端本地状态）直到新会话出现。自动接续不走这条路径。

## 2. 现状链路（2026-10-10 调查核证）

**条目身份锚是 runtime，不是线程**：

- 侧栏 coder 条目由 `collectRuntimeEntriesForPrebuilt`（`public/src/modules/runtime-status.js:167`）从 ViewerWorker `/api/agents` 的 runtime 列表构建，锚 `entry.runtimeId`（`sidebar-render.js:202`）。
- 条目的全部状态（calling / suspended / retiring 等）围绕 runtime 生灭派生。

**自动接续的空窗由服务端时序决定**（`server/thread-control/thread-rotation.js:68-125`）：

1. `beginSessionSuccession` 立挡板
2. **`stopManagedAgent`——旧 runtime 立即退役**（第 90 行；必须先行：trim 要在旧会话上下文上执行变换，旧 runtime 不能继续消费消息）
3. `compactAndResumeCurrentSession`：trim + 新会话创建 + 新 runtime 启动并等待 READY
4. `commitHead`：`advanceHead` + 补投递 + 发布 `thread.head-advanced` 事件（`thread-integration.js:189`）

旧 runtime 在第 2 步从 ViewerWorker 列表消失（前端经 agent SSE / 轮询感知，旧条目消失）；新 runtime 在第 4 步前后才注册可见（新条目出现）。空窗 = 第 3 步全程。**退役顺序是正确设计，不能靠延迟退役消除空窗**。

**已就绪但未被侧栏消费的地基**：

- `window.ClawThreads`（`public/src/modules/thread-store.js`）：周期拉取 `GET /protoclaw/threads`（20s，contentHash 条件刷新），维护 threadId / sessionId 双向索引，`sessionIndex` 可查任意链成员所属线程。
- `thread.head-advanced` SSE 事件（ADR-0024 PR-2 交付）：advanceHead 事务落定即时发布，本计划的条目刷新与 §6 换头切换均由它触发。
- 线程记录含渲染所需事实：threadId / title / status / headSessionId / lifeState（`thread-routes.js:165` 列表端点）。

## 3. 方案对比

| 方案 | 思路 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 线程锚渲染 | coder 子树条目改为从线程记录构建（threadId 锚），runtime 降为条目属性 | 条目常驻、身份稳定；与 ADR-0024"线程稳定、head 可变"同锚；地基全部现成 | 改造范围大（条目构建 + 状态映射 + 交互适配）；偏离 ADR-0010"叶子=存活 runtime"模型，需补 ADR | **推荐** |
| B. 空窗占位条目 | 保留 runtime 锚；旧条目消失时若 sessionId 命中线程链则合成临时"接续中"条目 | 改动局部 | 两套锚并存长期维护；runtime 崩溃与接续空窗无法区分（误显"接续中"）；本质是在 runtime 锚上打补丁 | 不推荐 |
| C. 服务端弥合 | server 聚合 `/api/agents` 时按线程记录合成 retiring 条目 | 前端近乎零改动 | 改写 ViewerWorker API 语义；绕过前端已有的 ClawThreads 数据源；与现有"前端聚合投影"架构相反 | 否决 |

推荐 A 的决定性理由：ADR-0010 的"叶子 = 存活 runtime"是线程宿主工作空间出现之前的模型，coder 的存在已经让它出现不适配场景——该修模型而不是打补丁（方案 B）。对话视图（ADR-0024 决策 4）已按"线程稳定身份 + head 可变数据源"设计，侧栏与视图同锚是概念一致性的要求。

## 4. 方案 A 设计

### 4.1 条目构建（coder 子树）

`collectRuntimeEntriesForPrebuilt` 的 coder 投影分支改为双源合并：

- **主源：线程记录**（`ClawThreads.threads`，非终态）——条目身份 `threadId`，标题、目录、status 来自线程记录。
- **属性源：head runtime**（agent 列表中 `sessionId === headSessionId` 的 runtime）——运行态（calling / suspended / just-finished）与 runtimeId（控制 IPC 寻址仍用）从 runtime 记录补。
- head runtime 不在（空窗 / rotation_failed 停滞）→ 条目保留，状态显示"接续中"（head 在链上推进过）或失败态，禁用输入类操作。

### 4.2 状态映射

| 线程事实 | head runtime | 条目状态 |
| --- | --- | --- |
| status=open/executing | 在且 running | 现有 calling 语义 |
| status=open | 在且 idle | 现有 idle / suspended 语义 |
| 接续空窗（head runtime 不在，thread 非终态） | 不在 | "接续中"（新样式，词表复用 thread-stream 状态条） |
| status=rotation_failed | — | 失败态（显式标记，提示人工介入） |
| lifeState=closed/archived | — | 条目移除（现行为） |

### 4.3 空窗起点的即时感知（可选增强）

`PR-2` 事件词汇扩展 `thread.rotation-begun`（`beginSessionSuccession` 落挡板时发布）：让前端在旧 runtime 退役的同一时刻获得"这是接续"的显式事实，而不是用"runtime 消失 + sessionIndex 命中"推断。推断法的缺陷：runtime 崩溃同样命中，无法区分"接续中"与"失联"。

**推荐包含此增强**（服务端单点发布，前端消费干净），不包含亦可落地（首版用推断 + 20s 轮询收敛，体验降级为"短暂误态后纠正"）。

### 4.4 SSE 接入

`thread.head-advanced`（及 4.3 的 rotation-begun）→ 刷新对应条目（threadId 寻址，ClawThreads 即时重拉该线程）。

### 4.5 ADR 更新

- ADR-0010：补"线程宿主工作空间例外"——coder 子树叶子锚线程记录而非存活 runtime，统一投影模型其余不变。
- ADR-0024 关联段补侧栏线程锚条目。

### 4.6 交互适配清单（实施时逐项核对）

点击条目的目标视图、选中态键（runtimeId → threadId）、待办 pin 关联、拖拽、右键菜单、`data-ctx-*` 上下文属性。点击目标视图为 head 会话的普通对话视图（见 §6），选中态与控制 IPC 寻址仍按 head runtimeId 落地。

## 5. 实施切片

- **S1 服务端**：rotation-begun 事件发布（若采纳 4.3）+ 线程列表端点字段核对（title/dir/status 齐备性）。
- **S2 前端条目**：coder 分支双源合并构建 + 状态映射 + 空窗态样式。
- **S3 前端事件**：SSE 订阅接入条目刷新。
- **S4 交互适配**：§4.6 清单逐项 + `test/remote-sidebar-projection.test.js` 等既有投影测试对齐。
- **S5 验收**：真实线程触发接续（上下文压缩或手动 trim），全程侧栏条目不消失、状态从"接续中"过渡到新 head 运行态；runtime 崩溃场景显示非"接续中"的正确状态。

依赖：S2 依赖 S1 字段核对；S3 独立；S4 与 §6 视图接入衔接（点击行为接线）。

## 6. 配套工作：coder 线程视图接续硬切换（消除对话视图断流）

侧栏条目点击后进入 head 会话的普通对话视图。接续发生时页面不断开：条目保留（本计划主体），视图自动切换到新 head 会话（S4 点击行为接线指向此处）。

接续的 UI 呈现遵循 ADR-0002 变换语义：换头后视图直接显示新会话自己的记录（开头为变换产物——裁剪主干与摘要），不做跨会话拼接；历史以变换后形态呈现是接续的自然结果。接续前的原始记录保留在旧会话文件中，经会话历史查看。

机制现成，本项是 UI 接入与交互设计：

- **换头切换**：`thread.head-advanced` 事件到达 → 若用户正开着该线程的视图，数据源重绑到新 head runtime，按 ADR-0013 rewrite 语义重建消息基线（页面身份、滚动、草稿不动）。
- **接续中的页面处理**（实现时设计）：加载标志、控件禁用、输入排队提示。输入排队有现成机制：接续中指令进 Thread Inbox，head 推进后自动补投（`delivery-consumer` 已实现），UI 负责呈现"已排队"状态。
- **输入框**：coder 保持不可 UI 直接输入的既有规则，禁用/隐藏。
