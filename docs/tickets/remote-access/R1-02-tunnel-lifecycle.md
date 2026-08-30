# R1-02 — 隧道生命周期管理（managed 与 manual 双模式）

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0008](../../adr/0008-remote-claw-connection-architecture.md) 第 3、9 条
- **类型**：连接基础
- **前置**：R1-01

## 背景

managed 模式下 Claw 托管每条连接一个长期 SSH 子进程；manual 模式下用户自己维护隧道（`ssh -L` 或其他任何方式把远程 1420 映射到 localPort），Claw 只读端口。manual 是永久诊断路径，也让后续工单（握手/路由/视图）可以在托管进程管理完成前先行验证。

## 目标

实现 `server/remote-connections/tunnel-manager.js`：

- **manual 模式**：不创建任何进程；仅暴露"该连接的 origin = `http://127.0.0.1:<localPort>`"，连接状态由健康检查（R1-03）推导。
- **managed 模式**：为每条 enabled 连接 spawn 系统 OpenSSH：

```text
ssh -N
    -L 127.0.0.1:<localPort>:127.0.0.1:1420
    -o ExitOnForwardFailure=yes
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=3
    [-o BatchMode=yes]
    <user@host | hostAlias>
```

## 执行步骤

1. 子进程生命周期沿用 `server/shared/agent-access.js` 的 managed 进程模式（exit 监听、运行状态查询、退出等待常量）；超时/退避常量进 `server/shared/constants.js`。
2. 零新增 npm 依赖：直接 spawn `ssh`（Windows OpenSSH 9.9p1 已确认可用）。
3. 退避重连：SSH 进程非预期退出后按指数退避重启（初始 1s，封顶 30s）；`enabled=false` 或连接删除时停止并清理子进程。
4. 状态上报：每条连接暴露 `tunnel: 'up' | 'down' | 'starting' | 'stopped'`，供 R1-03 状态机与 R1-07 UI 消费；进程 stderr 尾部若干行保留用于诊断。
5. Claw 退出时清理全部子进程（server 关停钩子）。
6. 半开连接交给 SSH 原生 `ServerAliveInterval×3` 检测，不自研心跳。
7. 单元测试：mock spawn（不真起 SSH），验证参数拼接、退避序列、disable 停止、退出事件归类。

## 验收标准

- managed 参数完整（`-N`、ExitOnForwardFailure、keepalive 选项、仅绑定 127.0.0.1）。
- 进程退出 → 退避重启 → 手动 disable → 彻底停止，全链路有测试。
- manual 模式零进程、零副作用。
- Claw 重启不遗留孤儿 SSH 进程。

## 明确不做

- 不做健康检查与握手（R1-03）——隧道 up 不等于远程可用。
- 不做密码/私钥管理，不做 SSH 连接测试 UI。
- 不支持一台连接多条隧道或转发多个远程端口。
