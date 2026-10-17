# 038 — 通知基座：权限项族、统一投递出口与完成通知迁移（editingSurface 首落地）

仓库：AgentDevClaw（`D:\code\AgentDevClaw`）
权威设计：[ADR-0030](../adr/0030-os-notification-delivery-and-app-adoption.md)
前置：无（本票是批次 12 首票）

## 目标

实施 ADR-0030 的基座三件，使"面向用户的桌面通知"从 Claw 硬编码全局行为变为 OS 机制件 + APP 承接：

1. **通知权限项族**进 `PERMISSION_ITEMS` 封闭枚举；
2. **统一投递出口**：server 侧权限闸 + SSE `app-notification` 帧 + APP 主动投递端点；
3. **editingSurface**：智能编码空间设置面板新增"通知"选项（宿主集中承接），全局工作空间面板通知项只读审计；
4. **完成 / choice 通知迁移**到统一出口（通道验收用例：runtime 状态类事件源）。

## 决策已定死（不得偏离）

以下契约在 grill 会话裁决、ADR-0030 固化，实施时逐字遵守：

- **权限项**：`notifications.finish`（完成通报）、`notifications.reminder`（提醒类）、`notifications.input`（输入请求），全部 `valueType: 'boolean'`。
- **三层判定链**：用户显式覆盖（workspace-settings resourcePolicy，按 agentId 键控）> 作者默认（metadata `permissionDefaults`）> 兜底 `false`。
- **作者默认值载体**：prebuilt metadata.json 新增可选字段 `permissionDefaults`（对象，键为权限项 ID，值须通过该项 validate；未知项或值非法时启动扫描报错，与 `permissions` 声明同等级校验），经 `server/routes/agent-discovery.js` 投影给前端。
- **首个作者默认差异**：编程小助手 `notifications.finish=true`（现状保持）；coder `notifications.finish=false`（无人值守任务不默认骚扰，升级期行为收紧已在 ADR 风险节声明）；memo `notifications.reminder=true`、`notifications.input=true`。choice 请求通知权限 `notifications.input` 编程小助手与 memo 都声明，默认 true（保持现状）。
- **SSE 帧名**：`app-notification`（全局帧，不按 thread 过滤，环形缓冲 + eid + Last-Event-ID 重放语义照既有事件）。**严禁与既有 `notification` 快照帧（call 状态感知）混淆或复用**——两者语义不同（ADR 背景节的词汇撞车条目）。
- **完成语义** = call.finish（每轮结束），与线程归档等看板域事实无关。
- **去重拆层**：server 做事件级（同一事实只发一帧，键对齐现状 desktop-notify 的完成判定事实键）；前端做呈现级（既有 dedup 逻辑保留）。
- **呈现策略留前端**：前台判定（document.hidden / focus）、前台宽限期、呈现去重、通知文案预览组装（含 fetch 最后回复做正文）都是设备端状态，留在 desktop-notify；server 只发结构化素材。
- **在线投递语义**：SSE 只投在线连接，不落全局通知历史、不做离线补投（ADR 不做清单）。

## 实施清单

### A. 权限项族（server）

- `server/shared/permission-registry.js`：`PERMISSION_ITEMS` 加三项布尔项（`valueType: 'boolean'`，validate 收窄 `typeof value === 'boolean'`）。
- metadata 作者声明与默认值：
  - `server/routes/agent-discovery.js`：解析并投影 `permissionDefaults`（校验：键必须 ∈ 该 metadata `permissions` 声明集且值合法，否则启动扫描报错）；
  - `prebuilt-agents/official/programming-helper/metadata.json`：`permissions: ["notifications.finish", "notifications.input"]` + 对应 `permissionDefaults`；
  - `prebuilt-agents/official/coder/metadata.json`：`permissions: ["notifications.finish"]` + `permissionDefaults`（false）;
  - `prebuilt-agents/official/memo/metadata.json`：`permissions: ["notifications.reminder", "notifications.input"]` + `permissionDefaults`（均 true）。

### B. 统一投递出口（server）

- 新建投递模块（建议 `server/shared/app-notification-outlet.js` 或就近 sse-events 内聚，按现有代码组织习惯定），导出单一致入口：
  - `deliverAppNotification({ agentId, type, title, body, ...素材 })`：按判定链查权限 → 通过则发布 `app-notification` SSE 帧 + 事件级去重；不通过静默跳过（返回 false 供调用方观测，不报错）。
  - 权限查询辅助：读 workspace-settings resourcePolicy 的通用读取（`server/routes/workspace-settings.js` 已有读写基建，复用其读取路径，勿另建存储）。
- SSE：`server/routes/sse-events.js` 加 `app-notification` 事件 kind，发布入口形态照 thread 事件的模块级先例（事务侧直接调用）。
- APP 主动投递端点：`POST /protoclaw/app_notifications`（命名对齐 `workspace_settings` 风格），body 带 `agentId`（必须为已知 prebuilt/workspace agent）+ `type`（finish / reminder / input 枚举外的自定义 type 允许吗？——**不允许**，type 限定 `finish | reminder | input`，对应权限项；素材字段：title / body / 可选 threadId 用于前端点击落点）。鉴权照既有"runtime 子进程调 server 端点"先例（读 `local-features/src/shared/internal-auth.ts` 与其 server 侧校验点，ContextRotationTriggerFeature 调 server 端点的链路是参照）。

### C. 完成 / choice 通知迁移（server 感知 + 前端退化）

- server：在既有 call.finish / choice 请求感知链上（sse-events.js 的 notification 快照帧事件入口，worker `onSessionEvent` 驱动）判定 `notifications.finish` / `notifications.input` → 经统一出口发布。事件级去重键对齐现状前端判定的事实键（读 `public/src/modules/desktop-notify.js` 现状 `_tryNotifyAgentFinished` 与 choice 感知的键构成后对齐，勿发明新键）。
- 前端 `public/src/modules/desktop-notify.js`：
  - 删除 call.finish / choice 的本地触发判定（含相关 poll 数据消费）；
  - 新增消费 `app-notification` SSE 帧（接入方式读 `public/src/modules/sse-client.js` 现状后对齐既有模式）；
  - 保留：前台判定、宽限期、呈现级去重、Tauri/Web 权限处理、markdown 剥离截断、toast 点击导航（帧内 threadId / agentId 落点）。
- **改前必读**：`docs/reference/design-system.md`（前端控件与样式纪律）、`docs/reference/frontend-rendering-patterns.md`（渲染管线与轮询契约）。

### D. editingSurface（前端）

- 主设置面板新增"通知"页签：`public/src/modules/model-settings.js` 的 settingsTab 体系加 `notification` 项（左栏选项 + 右侧内容形态照既有页签）。内容：两个开关——"编程小助手运行完成通知"、"Coder 运行完成通知"，读写 `/protoclaw/workspace_settings` 的 resourcePolicy `notifications.finish`（agentId 分别为 programming-helper / coder）；三态呈现（显式值 / 作者默认 / 未配置）与保存链路照该面板既有模式；开关控件复用既有配方（`proxy-toggle-row` 先例在 workspace-settings.js），**禁止自造同类控件**。
- 全局工作空间面板（`public/src/modules/workspace-settings.js`）：通知项**只读审计**——各 workspace 一行展示声明权限项与当前生效值（生效值 = 判定链结果），无编辑控件；maxLiveRuntimes 现有编辑能力不动。
- 文案中英双语照既有 i18n 模式（isZh 三元）。

### E. 测试（node:test + assert/strict）

- `test/`（服务端纯逻辑）：权限布尔项校验；判定链（覆盖>默认>兜底 false）三种取值；`app-notification` 帧发布与事件级去重；完成通知按权限通过/拦截；投递端点鉴权与参数校验（inline 复刻 server 逻辑的测试照 README 约定同步）。
- 前端若有可 vm 沙箱化的纯函数（如帧解析/去重键构成），照 `test/frontend-core-helpers.test.js` 模式补测；不强求。
- 预算纪律：单用例 <100ms、单文件 <1.5s；mock.timers，禁真实 sleep >500ms。

## 边界（禁止项）

- 不改 AgentDev 框架仓库（本票零框架改动；框架 `core/notification.ts` 是 DebugHub UI 状态信号，与本票无关，禁碰）。
- 不做 memo 提醒业务（039 范围）；不做 IM 渠道路由、通知中心、离线补投、安装同意流程。
- 不动 `docs/`（glossary / tickets README / AGENT.md 由调度方收尾）。
- 不动 qqbot 现有 on-boot schedule（挂账项，不顺手迁移）。
- 禁 `git reset --hard` / `git clean` / 覆盖未归属改动；不自行 push。

## 验收

1. `npm run test:file -- test/<新测试文件>.test.js` 逐文件绿；
2. `npm test`（core 全量）不回归；
3. `node --check` 或 lint 通过（改动文件）；
4. 最终报告列出：修改文件清单、测试数量与结果、已验证项、未验证项（整服重启后冒烟属调度方补验：设置面板"通知"页签呈现、开关读写、完成通知按 coder 默认不弹 / 编程小助手默认弹）、风险。
