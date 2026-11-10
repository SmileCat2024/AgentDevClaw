---
name: claw-test-isolation
description: 隔离 AgentDevClaw 测试或诊断用的第二个服务实例，避免占用真实服务的 Viewer UDS/命名管道、共享数据目录或端口。运行会启动 Claw server、ViewerWorker 或 runtime 子进程的测试时使用。
---

# 隔离 Claw 测试实例

启动测试服务前，隔离它的用户数据目录、Claw HTTP 端口、Viewer HTTP 端口和 Viewer UDS 地址。四者是不同的资源。只改端口不会隔离 UDS，也不会隔离会话与配置数据。

## 启动前核对

1. **确认被测对象。** 先检查测试或脚本的启动入口、实际子进程和清理逻辑。路由级 / 进程内集成优先运行仓库已有的隔离测试脚本；需要真实前端壳（完整路由 + rail 面板 + 静态资产）的 UI 端到端验证没有可复用脚本，按本清单四要素隔离后直接 `node server.js` 即可，PID 与资源归属照记。不要在无隔离的情况下手工启动第二个 `server.js`。
2. **分配独立资源。** 为测试实例使用独立的 `AGENTDEV_DATA_DIR`、`PORT`、`AGENTDEV_VIEWER_PORT` 和 UDS 地址。端口使用脚本的空闲端口分配器；不要假设某个备用端口当前空闲。
3. **净化继承环境。** 从 agent runtime 环境启动时，宿主注入的 `AGENTDEV_*` / `PROTOCLAW_*` 变量会整体继承并改变实例行为。已知例：`AGENTDEV_UDS_PATH` 显式覆盖派生地址（删除或设空）；`AGENTDEV_VIEWER_HTTP_BIND` 让 viewer 绑定非回环并强制全端点 Bearer（见下节 token 说明）。逐项审计：显式覆盖测试需要的，unset 不需要的，不要默认照单全收。
4. **确认地址未被改写。** Windows 命名管道必须使用 `\\.\pipe\<unique-name>` 形式。通过 Git Bash/MSYS 启动时，MSYS 可能转换路径参数；若出现 `EACCES`，先确认传入 Node 的实际值和运行壳层。Git Bash 下不能创建命名管道时，把环境变量设置与启动命令写进一个 `.ps1` 文件，用 `powershell -NoProfile -ExecutionPolicy Bypass -File <script>` 执行——脚本文件内容不经过 MSYS 参数转换，比命令行传参稳。不要反复换管道名碰运气。
5. **启动前记录资源归属。** 记录测试实例 PID、数据目录、端口和 UDS 地址。不要终止或删除无法确认归属的进程、socket 或目录。

## 确认隔离生效

启动后检查以下事实，再开始端到端操作：

- 测试实例监听的是分配给它的两个 HTTP 端口。就绪日志为 `product ui: http://127.0.0.1:<PORT>`。
- 测试实例绑定的是它自己的 UDS 地址。日志中的 `EADDRINUSE` 表示地址冲突；`EACCES` 要检查操作系统、壳层路径转换和权限。
- 测试数据写入专用数据目录，不是默认的 `~/.agentdev/AgentDevClaw`。直接证据是启动日志 `Created <隔离目录>/default.json from template`。
- 测试 runtime 连接测试实例的 Viewer，而不是正式服务。仅看到 HTTP health 成功不能证明 IPC 管道连接正确。

任一项无法确认时，停止测试实例并修正隔离配置。不要继续通过正式服务验证隔离实例的行为。

## Viewer HTTP 的 Bearer 认证

直连测试实例 Viewer 端口拿到 401 不代表服务没起来：非回环绑定（`AGENTDEV_VIEWER_HTTP_BIND`）时 ViewerWorker 全端点强制 Bearer。token 与数据目录同源——读 `<AGENTDEV_DATA_DIR>/auth.json` 的 `serviceToken`，请求带 `Authorization: Bearer <token>`（`server/auth.js` 按 ADR-0037 落盘并同步注入 `PROTOCLAW_INTERNAL_TOKEN`，外部进程从数据目录读 token 是官方路径）。经 Claw 端口的 `/api/*` 代理访问不需要 token，server 自动携带。回环绑定不校验；继承宿主 `AGENTDEV_VIEWER_HTTP_BIND` 的实例会进入校验模式，属预期行为而非故障。

## 模拟 runtime 推送数据（前端界面验证）

验证前端如何渲染 runtime 推送的数据（如 Plan 面板徽章）时，不必为隔离实例配模型或调 LLM：写一个 node 脚本直连测试实例的 UDS 地址，按 runtime→Viewer 的 JSON 行协议注入数据（每行一个 JSON 对象）。要点：

- 消息面：`{"type":"register-agent","agentId":...,"name":...,"projectRoot":...}` 注册，`{"type":"update-todo-plan","agentId":...,"plan":...}` 推送任务面板数据；完整消息类型见 viewer-worker 的 `handleUDSMessage`。
- UDS 连接无需认证；TCP 控制通道首条消息必须是 `{"type":"auth","token":...}`（token 同 auth.json 的 serviceToken）。
- agentId 对齐真实 runtime 的格式 `agent-<序号>-<PID>`（`DebugHub.allocateAgentId()`），前端按该 id 轮询 `/api/agents/<id>/todo` 等端点。
- 注入连接必须保持到验证结束：UDS 断开会触发 viewer 断连广播，前端侧栏叶子按存活 runtime 判定，条目会消失。
- 前端呈现：纯 viewer 注册条目出现在侧栏「外部代理」分组，可点击选中进入会话视图，右侧 rail 面板照常可用。
- 协议权威在框架仓库：`AgentDev/packages/core/src/core/debug-hub.ts`（发送端）与 `AgentDev/packages/viewer/src/viewer-worker.ts`（接收端）。

## 停止与清理

只停止本次启动且 PID 已确认的测试进程。等待其子进程退出后，再清理本次创建的临时目录。正式服务的默认数据目录、默认 Viewer 管道和其他进程不属于测试清理范围。

## 仓库依据

- `server/shared/constants.js` 的 `resolveInstanceUdsPath()` 让不同 `AGENTDEV_DATA_DIR` 派生不同 UDS 地址，但显式 `AGENTDEV_UDS_PATH` 会优先覆盖派生值。
- `server.js` 用 `resolveInstanceUdsPath()` 创建 ViewerWorker；runtime 启动也会注入该地址。
- `server/auth.js` 按数据目录落盘 `auth.json`（含 serviceToken）并注入 `PROTOCLAW_INTERNAL_TOKEN`；`server/shared/viewer-fetch.js` 是 server 侧消费 viewer HTTP 时的统一 token 入口。
- `test/user-data-dir.test.js` 覆盖默认路径、按数据目录稳定派生、不同目录地址不同和显式覆盖优先级。
- `test/ph-project-restart-runtime.mjs` 展示隔离数据目录、独立 HTTP 端口和独立 UDS 的集成测试做法。
- UDS JSON 行协议（register-agent / update-todo-plan 等）：发送端 `AgentDev/packages/core/src/core/debug-hub.ts`，接收端 `AgentDev/packages/viewer/src/viewer-worker.ts` 的 `handleUDSMessage`。
- `docs/protocols/service-lifecycle.md` 说明双服务实例的单例地址边界与测试隔离要求。
- `docs/audits/2026-10-26-session-identity-chain.md` 记录了早期测试漏隔离 Viewer socket 后影响现有服务 runtime 连接的事故。
