# 027 — 页面焦点状态重命名为 focusedAgentId

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0006](../adr/0006-local-explicit-resource-targeting-first.md)
- **类型**：本地前端语义重命名，零行为变更
- **前置**：026

## 背景

框架服务端的 current agent 语义已经移除，但 Claw 前端仍使用 `currentAgentId` 表示页面当前展示的 Agent。这个名称容易让后续代码误以为它是服务端权威状态、运行时目标或跨页面共享状态。

## 目标

将前端页面焦点变量统一命名为 `focusedAgentId`，明确它只表示：

> 当前页面正在展示哪个逻辑 Agent 或工作区宿主。

## 执行步骤

1. 阅读并更新 `app-core.js`、`app-main.js`、`app-ui.js` 及前端模块的依赖注释。
2. 将全局变量、函数参数、局部变量、测试夹具和注释中的 `currentAgentId` 按语义改为 `focusedAgentId`。
3. 对确实表示 runtime 目标的变量保留或改用 `currentRuntimeAgentId`，不能机械替换成 `focusedRuntimeId`。
4. 保持 `currentRuntimeAgentId` 的 stale guard 纪律不变：它仍表示当前显示数据所绑定的 runtime，不是服务端 current。
5. 保持 localStorage key 的兼容读取；如需迁移旧 key，采用一次性读取旧值并写入新值，不改变焦点选择算法。
6. 删除或改写会把焦点描述为“当前服务端 Agent”的过时注释。

## 验收标准

- Claw 前端源码中不再以 `currentAgentId` 表示页面焦点。
- 页面初始化、切换、删除、刷新、输入请求优先恢复和 workspace surface 行为不变。
- 任何 fetch URL 仍使用显式 runtime/agent 参数，不从焦点变量推导缺失目标。
- 前端相关测试全绿；至少覆盖刷新恢复、快速切换 stale response、删除焦点 Agent 和删除非焦点 Agent。
- 关闭或不存在 localStorage 时，页面仍按现有 fallback 正常工作。

## 明确不做

- 不改变页面焦点算法。
- 不新增远程 Agent 或连接状态。
- 不改 HTTP API 路径和响应字段。
- 不把页面焦点提升为新的全局权威状态。
