# 工作空间条目操作面与侧栏会话条目呈现策略：设计与实施计划

日期：2026-11-15
状态：已实施（[ADR-0050](../adr/0050-workspace-entry-operations-and-sidebar-session-visibility.md) 承载决策，本文承载形状与阶段明细；P1–P3 全部落地，定向测试与全量回归通过，memo 经隔离实例真实界面验收）
关联：[ADR-0050](../adr/0050-workspace-entry-operations-and-sidebar-session-visibility.md)、[ADR-0049](../adr/0049-session-ops-fact-and-menu-declaration.md)、[ADR-0010](../adr/0010-sidebar-unified-projection.md)、[ADR-0024](../adr/0024-app-workspace-eternal-thread-model.md)、[ADR-0025](../adr/0025-coder-workspace-promotion.md)

## 问题

侧栏工作空间条目没有任何操作入口：无右键菜单、无 ⋯ 按钮。菜单合成的基建（ADR-0049 的事实选族 + 贡献项模型）已就绪，但工作空间条目不在其覆盖内。

同时，APP 型工作空间（memo 是首个实体）的运行中会话条目对用户是冗余暴露——对话入口在首页（hero 恢复 / 新建），侧栏叶子呈现的是运行细节，用户想收起无处下手。

首个落地的操作项：memo 声明呈现策略能力后，用户可从条目菜单隐藏 / 恢复该工作空间的侧栏会话区。

## 已定决策

| 决策 | 内容 | 性质 |
|---|---|---|
| ADR 分工 | ADR-0050 只定机制（操作面模型 + 策略三层），菜单项内容、文案、默认值在本文 | 已裁决 |
| 可视入口 | 工作空间条目做 ⋯ 按钮，与右键同源同菜单 | 已裁决 |
| 首批范围 | 唯一菜单项是 sidebarSessions 切换；重启 / 关闭 runtime 等生命周期项不顺带（语义需单独审） | 已裁决 |
| memo 默认值 | 作者默认 `visible`（不改变现有用户习惯，想隐藏的用户自己操作一次） | 已裁决 |
| 粒度 | per-APP 整区开关；单条会话收起由归档承担 | 设计定案（ADR-0050 §3） |
| 隐藏语义 | 隐藏 ≠ 关闭；当前活动会话不豁免；策略跟 APP 走（换代 / 接续零接力处理） | 设计定案（ADR-0050 §3） |
| 过滤层 | 侧栏呈现层过滤，数据源不滤（child 条目是多消费方数据，数据源过滤会误伤 runtime 启动探测） | 设计定案（ADR-0050 §3） |
| 远程叶子 | 本地覆盖统一作用于挂在该 APP 下的远程投影叶子；远程主机策略不投影 | 设计定案（ADR-0050 §3） |
| 贡献项管道 | `ui.workspaceMenu.items` 模型位置保留，v1 不实施（无消费方不建管道） | 设计定案（ADR-0050 §1） |

## 数据形状

**metadata 声明（APP 作者）**

```jsonc
{ "sidebarSessions": "visible" }   // 或 "hidden"；不声明 = 无此能力（无菜单项，会话区照常显示）
```

**用户覆盖（workspace-settings.json 新节）**

```jsonc
{ "sidebarSessionsVisibility": { "memo": "hidden" } }   // hidden | visible；缺省条目 = 作者默认
```

值域终审（P1 前，2026-11-15）：覆盖域与声明/生效域统一为 `visible | hidden`，不采用原先草案的 `shown`。理由：删条目语义已承担「回作者默认」（对应 workspaceVisibility 的 auto），覆盖条目永远是具体目标值，与生效域同域即可，省掉一层词表映射；若覆盖域用 `shown`，用户手写 `visible` 进文件会被投影函数静默丢弃，是自造的失效模式。

**投影字段（agent-connected 挑选清单新增两项）**

- `sidebarSessions`：作者默认（声明值原样）。
- `sidebarSessionsPolicy`：生效值 = 覆盖 ?? 作者默认。
- 未声明 APP：两字段均不下发。

**菜单项（宿主事实族生成，非声明）**

- 生效 `visible` → 「隐藏对话条目 / Hide conversations」
- 生效 `hidden` → 「显示对话条目 / Show conversations」
- action：`claw:toggle-sidebar-sessions`（分发器剥 `claw:` 前缀后落 `toggle-sidebar-sessions` case）

**写入语义**：点击提交目标生效值（当前值取反）。目标值等于作者默认时，服务端删覆盖条目（等效 auto，与 `workspaceVisibility` 的 auto 语义同构）；否则写条目。作者默认值由服务端从发现层读取（测试缝注入，对齐 `readVisibilityOverrides` 注入先例），不信任前端传入。

## 模块边界与数据流

服务端三处：

- `server/routes/agent-discovery.js`：`sidebarSessions` 声明归一（值域校验，非法值丢弃并警告，对齐 `normalizeSessionMenu` 先例——增益 UX 不阻塞发现）。
- `server/routes/agent-connected.js`：投影挑选清单登记两字段；合流处读新覆盖节（与 `visibilityPolicy` 合流同处同构）。
- `server/routes/workspace-settings.js`：新节投影函数 + `PUT /protoclaw/workspace_settings/sidebar_sessions`（body `{ agentId, policy }`）；整文件读改写、按路径锁、原子写全部复用。

前端四处：

- `ctx-menu-items.js`：`getCtxMenuItems` 新增 `role = 'workspace'` 分支（事实族由 `sidebarSessions` 声明选中）；`dispatchCtxAction` 新增 `toggle-sidebar-sessions` case（invoke PUT → `loadAgents()` → 签名变化重渲；v1 不做乐观更新）。
- `sidebar-render.js`：prebuilt 分支的 `contextMenuEnabled` 门控改为「workspace 菜单非空」（旧 `!workspaceSurface && hasRuntime` 对 prebuilt 分支退役；非 prebuilt 分支不动，orphan / external 条目仍走静态菜单）；prebuilt 条目补 `data-ctx-*` dataset；⋯ 按钮复用 `agent-runtime-more` 样式与 `onSidebarSessionCtxMenu` 入口（布局拖拽命中判定已排除 button 元素，无冲突）。
- `sidebar-render.js` `renderSidebarChildItems`：owner 的 `sidebarSessionsPolicy === 'hidden'` → 整区不渲染（本地与远程投影叶子统一过滤）。
- `getAgentListRenderSignature`：agents 映射加 `sidebarSessionsPolicy`（仅声明 APP 有值；`sidebarVisible` 先例——工作空间设置覆盖翻转必须触发重渲）。

## 语义速查

| 面 | 是否受策略影响 |
|---|---|
| 侧栏该 APP 条目下的会话区（本地叶子 / 远程叶子 / 分组头 / 过渡态 / todo pin / 状态指示） | 是，整体不渲染 |
| APP 条目本身的存在性 | 否，归 `visibility`（ADR-0025）管 |
| APP 首页会话列表与总览 | 否，APP 自己的面 |
| 归档历史、主视图对话、搜索 | 否 |
| runtime 运行、业务状态、提醒通知 | 否，隐藏只是呈现 |

找回路径：APP 首页（memo hero「打开对话」恢复活动线程 head，事务端点已存在）。

## 迁移路径与阶段表

每阶段以测试收尾，测试不绿不进下一阶段。

- **P1 操作面基建**。`role = 'workspace'` 菜单分支与门控改造、⋯ 按钮、`claw:toggle-sidebar-sessions` 分发骨架。验收：frontend-vm 沙箱测试构造声明事实驱动，右键与 ⋯ 都能打开菜单，未声明 APP 无入口。
- **P2 策略管道**。服务端三处 + 前端呈现过滤与签名接入。验收：投影契约测试（防 sessionOps 式断链）、workspace-settings 新节读写测试、呈现过滤与签名重渲测试全绿。
- **P3 memo 落地**。memo metadata 声明 `"sidebarSessions": "visible"`；真实界面验收（playwright 驱动）：右键 memo 条目 → 隐藏 → 会话区消失 → 首页「打开对话」恢复对话 → ⋯ → 显示 → 条目回归；未声明 APP（如智能编码空间）无 ⋯ 无右键，行为与现状一致。
  - P3 实施记录（2026-11-15）：验收通过，完整回路含「隐藏态下 runtime 存活且会话活跃、侧栏子树仍不出现」。期间发现并修复既有缺陷：memo start 事务中 `adoptHeadIdentity` 在 runtime viewer 注册完成前调用（`isManagedRuntimeRunning` 进程存活即真，冷启动窗口内框架按 viewer registration inactive 拒绝），修复为采纳前等待 READY（换头路径 runtime 已 READY，等待 no-op；`server.js` 装配层，既有换头时序测试不受影响）。

行为变化记录：prebuilt 门控退役后，`kind: "agent"` 形态的 prebuilt 条目（flow-test）失去旧的重启 / 关闭菜单。该条目在 `HIDDEN_PREBUILT_AGENT_IDS` 清单中不可见，无实际消费方，记录在案。

## 测试面

- 服务端：discovery 归一（合法 / 非法值）；投影契约（声明 + 无覆盖 / 声明 + 覆盖 / 未声明三种形态，锚定字段必达）；settings 新节读写（兄弟节保留、目标值等于默认时的删条目语义、写锁）。
- 前端：菜单合成（事实 → 项、文案随生效值切换）；门控（声明 APP 有 ⋯ 与右键、未声明均无）；呈现过滤（hidden 整区不渲染，含远程叶子）；签名（policy 翻转触发重渲）。

## 接受的取舍

- 隐藏后侧栏无运行状态指示，感知渠道 = 提醒通知 + 首页进入对话（折叠成状态行的中间态是后续课题）。
- v1 无乐观更新：切换后经 PUT 回包 + `loadAgents()` 刷新可见，路径短，等待可接受。
- wire 仍下发被隐藏的 child 条目（呈现层过滤的代价）；侧栏会话区的消费方不得绕过呈现层自行渲染。

## 未决问题

- `ui.workspaceMenu.items` 贡献项管道的启动条件：第一个真实需求出现时再实施（对齐 ADR-0049 P3 后置纪律）。
- 首页要不要补运行状态指示，作为隐藏后的补偿入口。
- 工作空间设置面板（现只列 on-demand APP）要不要加 sidebarSessions 配置行。
- 命名终审（已定案，2026-11-15 P1 前）：`sidebarSessions`（metadata 声明）/ `sidebarSessionsVisibility`（settings 节）/ `sidebarSessionsPolicy`（投影生效值）/ `claw:toggle-sidebar-sessions`（动作）/ `PUT /protoclaw/workspace_settings/sidebar_sessions`（端点）全部按计划名落地；值域统一见「数据形状」节。
