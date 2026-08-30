# R1-05 — 远程工作空间目录聚合

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0008](../../adr/0008-remote-claw-connection-architecture.md) 第 4、8 条
- **类型**：目录聚合
- **前置**：R1-03（连接 connected 才聚合）、R1-04（命名空间编码复用）

## 背景

本地左侧列表按工作空间（projectName）分组；远程聚合的单位也是工作空间——"工作空间通常代表一个 Agent，也可以包含多个 Agent/会话身份"，这是本地既有心智的自然扩展。连接后本地看到：项目A、项目B、`开发服务器：项目C`、`开发服务器：项目D`。

## 目标

服务端聚合端点（仅聚合远程部分，本地数据流不动）：

```text
GET /protoclaw/remote_catalog
```

返回按连接分组的工作空间条目：

```js
{
  connections: [{
    connectionId: 'server-a',
    name: '开发服务器',
    status: 'connected',            // 来自 R1-03，断开时也保留分组与身份
    workspaces: [{
      groupKey: 'remote:server-a:project-c',   // 分组键，防与本地同名项目冲突
      displayName: '开发服务器：项目C',
      entries: [{ id: 'remote:server-a:agent-3-22040', /* 名称、会话身份等 */ }]
    }]
  }]
}
```

## 执行步骤

1. 实现 `server/remote-connections/catalog-aggregator.js`：对每条 connected 连接，经其 origin 拉取远程现有目录端点组合（`/protoclaw/get_connected_agents`、`/protoclaw/get_prebuilt_agents`、`/protoclaw/prebuilt_sessions`、`/api/agents`——以远程实际返回为准组合，**不要求远程新增接口**）。
2. 远程返回的 agent/session ID 一律加 `remote:<connId>:` 前缀后再给前端——前端从此只处理不透明 ID，永不自行拆解。
3. 工作空间分组键 `remote:<connId>:<projectName>`；展示名 `${连接别名}：${项目名}`。一个工作空间下多个 Agent/会话身份自然归入同组。
4. 失败语义：某连接 disconnected 时该分组保留、状态标记断开、条目可显示最后已知身份但不提供数据——**不删除分组、不伪装正常**；其他连接与本地分组不受影响。
5. 聚合节奏对齐 sidebar 既有轮询，每连接独立超时；超时不阻塞整体响应（该连接返回降级状态）。
6. 本地 sidebar 数据流完全不动：前端在渲染层把 remote_catalog 与本地列表合并（R1-07）。
7. 单元测试：mock 远程响应，覆盖多工作空间、同项目名跨连接、连接断开、单连接超时降级。

## 验收标准

- 本地 + 多远程连接下，分组键全局唯一，同名项目不串组。
- 断开连接的分组身份稳定（重连后同 groupKey 复用，折叠状态等 UI 状态不丢）。
- 一条远程连接挂起时端点整体响应时间不超过该连接的独立超时。
- 前端拿到的所有远程 ID 均已命名空间化，grep 前端代码无手工拼前缀逻辑。

## 明确不做

- 不做统一 `agent_catalog`（本地+远程一体端点，Q28 完整形态）——留待后续阶段，本票只做远程侧增量。
- 不缓存远程目录数据（每次轮询透传拉取）。
- 不做 Host 管理面信息（模型配置、Feature 配置等不进目录）。
