---
name: claw-test-isolation
description: 隔离 AgentDevClaw 测试或诊断用的第二个服务实例，避免占用真实服务的 Viewer UDS/命名管道、共享数据目录或端口。运行会启动 Claw server、ViewerWorker 或 runtime 子进程的测试时使用。
---

# 隔离 Claw 测试实例

启动测试服务前，隔离它的用户数据目录、Claw HTTP 端口、Viewer HTTP 端口和 Viewer UDS 地址。四者是不同的资源。只改端口不会隔离 UDS，也不会隔离会话与配置数据。

## 启动前核对

1. **确认被测对象。** 先检查测试或脚本的启动入口、实际子进程和清理逻辑。优先运行仓库已有的隔离测试脚本，不要手工启动第二个 `server.js`。
2. **分配独立资源。** 为测试实例使用独立的 `AGENTDEV_DATA_DIR`、`PORT`、`AGENTDEV_VIEWER_PORT` 和 UDS 地址。端口使用脚本的空闲端口分配器；不要假设某个备用端口当前空闲。
3. **净化继承环境。** `AGENTDEV_UDS_PATH` 是显式覆盖，优先于按数据目录派生的实例地址。启动隔离实例时，删除从宿主 runtime 继承的 `AGENTDEV_UDS_PATH`，或显式设为空字符串。只有在确实需要固定地址时，才传入一个该测试独占的地址。
4. **确认地址未被改写。** Windows 命名管道必须使用 `\\.\pipe\<unique-name>` 形式。通过 Git Bash/MSYS 启动时，MSYS 可能转换路径参数；若出现 `EACCES`，先确认传入 Node 的实际值和运行壳层。Git Bash 下不能创建命名管道时，改用 PowerShell 或原生 Windows 进程启动，不要反复换管道名碰运气。
5. **启动前记录资源归属。** 记录测试实例 PID、数据目录、端口和 UDS 地址。不要终止或删除无法确认归属的进程、socket 或目录。

## 确认隔离生效

启动后检查以下事实，再开始端到端操作：

- 测试实例监听的是分配给它的两个 HTTP 端口。
- 测试实例绑定的是它自己的 UDS 地址。日志中的 `EADDRINUSE` 表示地址冲突；`EACCES` 要检查操作系统、壳层路径转换和权限。
- 测试数据写入专用数据目录，不是默认的 `~/.agentdev/AgentDevClaw`。
- 测试 runtime 连接测试实例的 Viewer，而不是正式服务。仅看到 HTTP health 成功不能证明 IPC 管道连接正确。

任一项无法确认时，停止测试实例并修正隔离配置。不要继续通过正式服务验证隔离实例的行为。

## 停止与清理

只停止本次启动且 PID 已确认的测试进程。等待其子进程退出后，再清理本次创建的临时目录。正式服务的默认数据目录、默认 Viewer 管道和其他进程不属于测试清理范围。

## 仓库依据

- `server/shared/constants.js` 的 `resolveInstanceUdsPath()` 让不同 `AGENTDEV_DATA_DIR` 派生不同 UDS 地址，但显式 `AGENTDEV_UDS_PATH` 会优先覆盖派生值。
- `server.js` 用 `resolveInstanceUdsPath()` 创建 ViewerWorker；runtime 启动也会注入该地址。
- `test/user-data-dir.test.js` 覆盖默认路径、按数据目录稳定派生、不同目录地址不同和显式覆盖优先级。
- `test/ph-project-restart-runtime.mjs` 展示隔离数据目录、独立 HTTP 端口和独立 UDS 的集成测试做法。
- `docs/protocols/service-lifecycle.md` 说明双服务实例的单例地址边界与测试隔离要求。
- `docs/audits/2026-10-26-session-identity-chain.md` 记录了早期测试漏隔离 Viewer socket 后影响现有服务 runtime 连接的事故。
