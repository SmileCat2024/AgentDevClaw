# ADR 0030: OS 通知投递面——统一出口、通知权限项与应用承接

日期：2026-10-17
状态：已接受

## 背景与问题

工作空间应用化（ADR-0022 / 0024 / 0025 / 0027 系列）走到需要"APP 主动触达用户"的形态：运行完成通报、定时提醒、输入请求，都是 APP 级产品能力。当前桌面通知的事实与之不符：

- **通知是 Claw 的硬编码全局行为，不是 APP 能力**。前端 `public/src/modules/desktop-notify.js` 对 call.finish 与 choice 请求两类事件自动弹 toast，对所有 workspace 无差别生效，没有任何 per-workspace 开关与权限语义。编程小助手与 coder 的完成通知无法差异化（无人值守后台任务与交互式助手理应有不同默认值，现状做不到）。
- **通知无统一出口**。完成/choice 通知由前端自行感知 runtime 状态并弹出；未来 APP 侧主动投递的通知（提醒类）没有可走的通道。若各自为政，每个 APP 各建一条触达路径，治理面碎片化。
- **权限模型的立项条件已被触发**。ADR-0027 挂账："第二个权限项（第一个真实跨应用需求）出现时激活权限模型"。通知授权正是该需求：完成通知（事件源是 runtime 状态）与提醒类通知（事件源是 APP 主动投递）是两类异构消费者，且不同工作空间需要不同默认值。
- **词汇撞车**：框架 `core/notification.ts` 是 DebugHub 的 UI 状态信号（call.start / call.finish 节流快照），与"面向用户的桌面通知"是两回事。本 ADR 所称"通知"一律指后者；glossary 须区分收录。

事实基础（读代码核验）：

- 权限治理基建现成：`server/shared/permission-registry.js` 的 `PERMISSION_ITEMS` 封闭枚举 + `server/routes/workspace-settings.js` 的通用读写（`writeWorkspacePermissionValue(agentId, permissionId, value)`）与 resourcePolicy 节——ADR-0027 留的缝，加项即用。
- SSE 基建现成：`server/routes/sse-events.js` 已有 `notification` 快照帧（call 状态感知链，由 worker `onSessionEvent` 事件入口驱动）、thread 事件的模块级发布入口先例（事务侧直接调用）、环形缓冲 + eid + Last-Event-ID 重放。
- 桌面壳已具备通知能力：Tauri notification 插件已装载，服务源 WebView 权限自动授予（`desktop/src/main.rs`，不向用户弹询问）。

## 决策

### 1. 定位：通知是 OS 机制件，APP 承接语义与设置现场

主线是应用化：OS（Claw 内核）不把通知作为全局行为持有，而是提供三件机制件——**权限项**（治理）、**editingSurface**（设置承接）、**统一投递出口**（通道）；APP 在自己的设置面呈现自己的通知语义、经通道主动触达用户。用户视角是"在某 APP 的设置里配置某 APP 的通知"，不是"在 Claw 全局设置里配置"。

### 2. 通知权限项族

- 往 `PERMISSION_ITEMS` 枚举加布尔项：`notifications.finish`（完成通报）、`notifications.reminder`（提醒类）、`notifications.input`（输入请求）。加项不改模型（ADR-0027 裁决的升级路径）。
- 三层结构：作者声明（metadata.json 声明使用的项 + 建议默认值）→ 用户覆盖（workspace-settings resourcePolicy，按 agentId 键控）→ 内核强制（投递闸）。
- 首个作者默认差异：编程小助手 `finish=true`（现状保持）；coder `finish=false`（无人值守任务不应默认每轮骚扰）。coder 默认值相对现状（无差别全弹）是显式收紧，须在发布说明告知，用户可改回。
- 运行结束通报的触发事实 = call.finish（每轮结束），与线程归档等看板域事实无关；通报结果按 CallOutcome 区分成功、失败、取消与移交，不把“有结束事件”一概表述为成功完成。

### 3. editingSurface：应用承接编辑面（ADR-0027 挂账概念的落地）

- 机制：metadata 声明 APP 使用的权限项与建议默认值 → APP 设置页按声明渲染编辑控件 → 写 workspace-settings。控件渲染是通用机制，各 APP 不各自手搓设置逻辑。
- 宿主集中承接：宿主可在自身设置页集中编辑所管理子工作空间的项（ADR-0027 管理关系）。首个形态：智能编码空间设置页左栏新增"通知"选项，右侧集中配置自身与 coder 的完成通知开关。
- 全局设置 → 工作空间页：通知项**只读审计**（"编辑位置迁就业务语义，知情权不迁就"，ADR-0027 原文）。maxLiveThreads（ADR-0027 修订一，原 maxLiveRuntimes）现有的全局编辑能力不迁移，不顺手重构。

### 4. 统一投递出口

- 一切面向用户的桌面通知经 server 通知出口：投递请求（带 agentId 身份）→ 权限判定 → SSE `app-notification` 帧 → 前端呈现器弹 toast。
- 事件源两类，同走一出口：
  - **runtime 状态类**（完成 / 输入请求）：server 在既有 SSE 感知链上判定权限并发布通知帧；
  - **主动投递类**（APP 侧发起的提醒等）：经投递端点提交，server 判权限后发布。
- **呈现策略留呈现层**：前台判定、前台宽限期、呈现去重、文案预览组装依赖设备端可见性状态（document.hidden / focus），内核天然不可知，留在前端。去重随之拆层：server 做事件级（同一事实只发一帧），前端做呈现级（既有 dedup 逻辑保留）。
- **完成/choice 通知迁移即通道验收**：desktop-notify 的触发判定上移 server，前端退化为 `app-notification` 呈现器。两类异构事件源走通同一出口，通道的通用性才算立住。

### 5. 可达边界（如实陈述）

- 投递依赖前端页面存活：桌面壳关窗 = 藏托盘、webview 仍活；退出桌面程序或浏览器全关 = 不可达。通知是端能力，不是云推送。
- 在线投递语义：SSE 只投在线连接。不落全局通知历史、不做离线补投——需要持久记录的（如提醒列表）由各 APP 自持业务数据面。
- 本期投递面 = 桌面 toast + 应用内呈现；IM 渠道推送路由挂账。

## 不做清单

- **不建 OS 定时器服务**：定时触发属 APP 业务（feature 自持 + 持久机制件），OS 只担保通知投递与权限。
- 不做全局通知中心 UI、全局通知历史、离线补投。
- 不做 IM 渠道通道路由（数据面留扩展缝即可）。
- 不做安装时同意流程、首次询问弹窗——first-party 默认授予，显式开关可改（防同意疲劳，ADR-0027 第一设计约束）。
- 不做 per-notification 粒度治理（权限项到类型为止，不到单条）。
- crash respawn 不随本 ADR 立项（进程治理独立课题；本期涉及的 boot 自启以 IM 门户的 on-boot schedule 先例为上限）。

## 后果

**正面**：完成通知获得 per-workspace 差异化治理（coder 默认静默成为可能）；APP 主动触达有统一合规通道，不再各建路径；editingSurface 从挂账概念落为可用机制，后续权限项一律走此路；权限模型第二项落地，封闭枚举抽象获得第二个校准样本。

**代价**：desktop-notify 判定逻辑上移是本 ADR 最大改造件（触发判定、事件级去重进 server；前台判定、呈现去重留前端）；SSE 新帧及重放语义进入测试面；前端新增三处面（智能编码空间设置"通知"选项、后续各 APP 设置承接、全局审计视图）。

**风险**：coder 默认关是升级期行为变化，发布说明必须显式告知；`app-notification` 帧与既有 `notification` 快照帧名相近，前端消费代码与文档须明确区分，避免误接。

## 关联

- [ADR-0027](0027-agent-os-consent-governance-and-runtime-quota.md)：直接父——立项条件由本 ADR 触发，三层结构与 editingSurface 挂账在此落地。
- [ADR-0024](0024-app-workspace-eternal-thread.md)、[ADR-0025](0025-coder-workspace-promotion.md)、[ADR-0022](0022-agent-studio-feature-first-model.md)：应用化主线——通知是 APP 型工作空间的触达面配套。
- [ADR-0018](0018-feature-panel-communication-transport.md)：声明制授权记录的先例。
- [ADR-0013](0013-message-poll-probe-tail.md)：SSE / 轮询通道契约，通知帧复用其重放语义。
