# 030 — Runtime 操作与宿主操作边界整理

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0006](../adr/0006-local-explicit-resource-targeting-first.md)
- **类型**：本地 API 语义分类与调用参数整理
- **前置**：026、029

## 背景

当前 `/api/agents/:id/*` 主要操作 ViewerWorker runtime；`/protoclaw/*` 中既有 Session/Agent 相关操作，也有模型配置、workspace、dispatch、图片和项目文件等宿主操作。若不区分两类，调用方容易把页面焦点或 Agent ID当成宿主目标，导致数据写入错误位置。

## 目标

在不引入任何新传输方式的前提下，明确两类本地操作：

### Runtime-scoped

目标是某个运行时 Agent/Session，例如：

```text
messages / tools / hooks / todo / input / interrupt / notification
```

必须携带显式 Agent/Runtime 身份。

### Host-scoped

目标是当前 Claw 宿主上的配置、目录、进程、调度或资源，例如：

```text
model_config
workspace_state
feature_config
images
prebuilt_project
 dispatch
```

本阶段明确其默认本地归属，禁止根据页面焦点隐式改变宿主。

## 执行步骤

1. 为现有 `/protoclaw/*` 路由建立分类表：Runtime、Session、Host、Global。
2. 为每个路由记录真正的数据所有者：ViewerWorker、session 文件、用户配置、项目目录、进程注册表或全局服务。
3. 对 Runtime/Session 路由补齐显式 `agentId`、`sessionId` 或 runtime ID校验。
4. 对 Host/Global 路由保留现有本地 URL 和行为，但在代码注释、参数校验和测试中明确“不得从页面焦点推导目标”。
5. 对同一路由同时处理 Runtime 与 Host 的情况拆出纯函数或明确请求字段，不进行大范围路由改名。
6. 为至少三个容易混淆的接口补测试：workspace state、model config、session mutation。

## 验收标准

- `/protoclaw/*` 分类表完整，并标明数据所有权。
- 页面焦点变化不会改变 Host API 的目标。
- Runtime/Session 请求缺少必要身份时明确失败。
- 现有本地 workspace、模型配置、调度和会话功能行为不变。
- 不新增远程字段、不新增连接参数、不新增转发分支。

## 明确不做

- 不实现 Host API 的跨实例访问。
- 不新增 connectionId、remote scope 或连接配置。
- 不重写所有 `/protoclaw/*` 路由。
- 不把页面焦点改造成新的服务端 current。
