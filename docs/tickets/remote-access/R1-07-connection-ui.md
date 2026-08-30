# R1-07 — 连接管理 UI 与远程分组呈现

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0008](../../adr/0008-remote-claw-connection-architecture.md) 第 7、8、9 条
- **类型**：前端
- **前置**：R1-05、R1-06

## 背景

Phase 1 的用户可见面：设置里的连接管理 + 左侧列表的远程工作空间分组 + 只读主视图。无配置无连接时，界面与现状完全一致（默认关闭，Q31）。

## 目标

### 设置面板：远程连接管理页

- 连接列表：别名、模式（manual/managed）、状态（来自 R1-03 状态机：connecting/connected/degraded/disconnected）、握手结果（clawVersion + framework.version，版本警告可见）。
- 增删改连接（对应 R1-01 schema）、enable 开关、managed 模式的隧道状态与 SSH stderr 尾部诊断信息。
- 手动模式说明文案：如何自建 `ssh -L` 隧道及诊断用途。

### 左侧列表：远程工作空间分组

- 消费 `/protoclaw/remote_catalog`，与本地分组在渲染层合并；分组展示名 `服务器名：项目`，折叠状态按 groupKey 持久化（与本地同名项目天然隔离）。
- 分组头部带连接状态指示（正常/断开/降级）；断开时分组保留、显示断开时间，条目不可进入数据视图。
- 远程条目点击 → 进入只读主视图。

### 主视图：只读远程 Agent

- 消息流、工具执行、Todo、Hook、Feature 面板正常渲染（走 R1-06 白名单）。
- 输入区整体替换为禁用提示："远程操作将在下一阶段开放"——**不是可输入但不生效的假交互**；排队/中断等操作按钮对远程 Agent 隐藏或禁用并说明原因。
- 焦点恢复：focusedAgentId 存命名空间 ID，localStorage 机制照常工作；恢复优先级沿用现有算法（inputRequest 优先 → 记忆 → 第一个）。

## 执行步骤

1. 前端新增 `public/src/modules/remote-connections.js`（管理页逻辑）与 sidebar 合并渲染扩展；全局状态区只减不增，新状态放模块局部或 `window.ClawFW`。
2. 轮询节奏复用既有调度；remote_catalog 失败时本地列表照常渲染，远程分组显示降级状态。
3. i18n 文案随 app-core 既有体系补齐（中英）。
4. 无配置文件 / 全部 disabled / remote_catalog 404 时：不渲染任何远程 UI，DOM 与现状一致。

## 验收标准

- 从添加连接（manual）到看到远程工作空间分组，全程不重启 Claw。
- 断开 SSH → 分组标记断开、视图停用并明示；恢复 → 自动回到 connected，无需刷新页面。
- 版本不匹配的连接显示警告但不影响只读使用。
- 关闭全部连接后界面与现状逐像素一致（回归截图或 DOM 对比）。

## 明确不做

- 不做会话管理 UI（新建/切换/分支远程会话，Phase 3）。
- 不做 Host 管理面（模型配置、Feature 配置远程编辑）。
- 不做连接的拖拽排序、多服务器批量操作。
