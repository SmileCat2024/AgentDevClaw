# 028 — 本地请求目标解析器：统一 Runtime 目标校验

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0006](../adr/0006-local-explicit-resource-targeting-first.md)
- **类型**：本地服务端请求边界抽象
- **前置**：026；027 可并行
- **执行关系**：先接入 1–2 个代表性调用点，再逐步迁移其他调用点

## 背景

本地服务端存在 `proxyToViewer`、`submitUserTurn` 以及多个直接使用 `VIEWER_ORIGIN` 的调用点。它们都在访问本地 ViewerWorker，但参数校验、错误形态和目标表达不完全统一。需要先建立一个只解析本地目标的薄层，避免业务调用点继续直接拼接 Viewer 地址。

## 目标

新增一个不包含远程实现的本地目标解析模块，例如：

```text
server/shared/request-target.js
```

当前解析结果只允许本地目标：

```js
{
  scope: 'local',
  agentId,
  sessionId: null,
  runtimeId: null,
  viewerOrigin: VIEWER_ORIGIN,
}
```

`scope` 在本票中只用于表达当前目标类型，不引入第二种目标，也不执行动态连接。

## 执行步骤

1. 定义 `resolveRuntimeTarget({ agentId, sessionId, runtimeId })` 或等价薄函数。
2. 对必填 Agent ID、空字符串、非法编码和字段冲突返回稳定的本地错误。
3. 只使用调用方显式提供的身份；禁止读取页面焦点、列表第一项、PID 或名称作为 fallback。
4. 保持 `VIEWER_ORIGIN` 的实际值和本地请求路径不变。
5. 先接入：
   - `server/shared/proxy.js` 的 Viewer 代理；
   - `server/shared/user-turn.js` 的用户输入投递。
6. 为解析器、代理和用户输入投递增加 mock fetch 测试，确认请求 URL 和 body 与改动前一致。
7. 记录尚未迁移的直接 Viewer 调用点，不在本票扩大迁移范围。

## 验收标准

- 本地请求成功时，目标 URL、方法、请求体和响应状态与改动前兼容。
- 缺少显式 Agent ID 时返回可识别的 400/`invalid_target`，不静默选择其他 Agent。
- `proxyToViewer` 和 `submitUserTurn` 测试全绿。
- 解析器是纯本地、无网络副作用的同步/轻量函数；不创建进程、不读连接配置。
- 其他直接 `VIEWER_ORIGIN` 调用点有清单，且没有被偷偷改成新路径。

## 明确不做

- 不支持远程目标、连接 ID、SSH、端口分配或目标前缀。
- 不做业务状态缓存、重试、离线队列或请求镜像。
- 不迁移全部服务端调用点。
