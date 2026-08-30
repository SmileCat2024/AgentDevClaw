# R1-01 — 连接配置模型与存储

- **仓库**：AgentDevClaw
- **决策依据**：[ADR-0008](../../adr/0008-remote-claw-connection-architecture.md)
- **类型**：连接基础
- **前置**：无（本组工单起点）

## 背景

远程连接需要一个用户可编辑的配置源：每条连接描述"连到哪台服务器、用哪种隧道模式、映射到哪个本地端口"。配置属于本机用户环境，不属于项目仓库。

## 目标

新增连接配置存储：

```text
~/.agentdev/AgentDevClaw/remote-connections.json
```

Schema（每条连接）：

```js
{
  id: 'server-a',            // 稳定连接 ID，参与命名空间 remote:<connId>:<id>
  name: '开发服务器',         // 连接别名，用于界面分组"服务器名：项目"
  enabled: false,             // 默认关闭
  mode: 'manual' | 'managed',
  localPort: 22101,           // 本地隧道端口，每条连接固定
  ssh: {                      // managed 模式必填；manual 模式可省略
    host: 'dev.example.com',
    user: 'ubuntu',
    port: 22,
    hostAlias: null           // 可选，交给系统 OpenSSH 配置解析
  },
  remote: {
    appPort: 1420             // 只转发远程 Claw Server，ViewerWorker 不直接暴露
  }
}
```

## 执行步骤

1. 实现 `server/remote-connections/connection-store.js`：读写、校验、按 id 索引。
2. 校验规则：id 唯一且不含 `:` 与 URL 保留字符；localPort 在约定区间内且不与其他连接冲突、不与 APP_PORT/VIEWER_PORT 冲突；managed 模式必须有 ssh.host；mode 只允许两个枚举值。
3. 本地端口分配：每条连接 id 绑定固定端口（如 22100 起递增），重连不换端口——任何层都不需要失效处理。
4. 文件不存在或为空时返回空列表；文件损坏时报错并显式呈现，不静默重建。
5. **禁止存储**：SSH 密码、私钥内容、passphrase——凭证全部交给系统 OpenSSH（ssh-agent / ~/.ssh/config / 私钥路径）。

## 验收标准

- 配置读写、校验、端口冲突检测有单元测试（不读写真实用户目录，注入路径）。
- 默认状态（无配置文件）下系统行为与现状完全一致，远程功能不可见。
- 无任何机密字段进入配置文件。

## 明确不做

- 不建立 SSH 连接，不 spawn 进程。
- 不做配置 UI（R1-07）。
- 不做远程目录拉取。
