# MCP 配置

MCP（Model Context Protocol）用于给助手接入外部工具服务器。本产品有两个配置层，按「配置跟着谁走」区分：

| 配置层 | 入口 | 适合 |
|---|---|---|
| 项目级配置文件 | 项目目录下 `.agentdev/mcps/*.json` | 跟着项目走的 server，可进版本库与团队共享 |
| 共享 MCP 网关 | 设置 → MCP 网关 | 本机全局共享的 server；含系统内置服务 |

两层可同时使用，配置的 server 会合并生效；同名 server 自动加序号后缀共存，不会互相覆盖。

## 项目级配置文件

在项目根目录创建 `.agentdev/mcps/` 目录，每个 server 一个 json 文件。文件内容支持三种写法：

**写法一：`servers` 包裹（标准格式）**

```json
{
  "servers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  }
}
```

**写法二：`mcpServers` 包裹（Claude 格式，直接兼容）**

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  }
}
```

**写法三：单个 server 对象（文件名即 server 名）**

```json
{
  "command": "npx",
  "args": ["-y", "some-mcp-server"]
}
```

server 配置的写法与 Claude 系工具一致：本地进程型填 `command` / `args` / `env`，远程型填 `url` 及认证信息。

**从 `.mcp.json` 迁移**：把原文件里 `mcpServers` 的内容保存为 `.agentdev/mcps/` 下的 json 文件即可，格式无需改动。

配置文件在会话启动时加载；新增或修改后重开会话（或重启助手会话）生效。

## 共享 MCP 网关

设置 → MCP 网关打开管理界面：

- **系统内置服务**：Claw MCP、Debugger MCP 等随产品提供，界面上开关启用；
- **自定义服务器**：在界面上添加，添加后对本机所有工作空间的会话生效，不必逐项目配置。

## 确认 server 已生效

- server 连接成功后，它提供的工具会出现在会话中，工具名以 `mcp_` 开头；
- 直接在对话里让助手调用对应工具验证；
- server 状态异常时先看设置 → MCP 网关中的状态，再按 references/troubleshooting.md 排查。

## 常见问题

**server 加了但工具没出现？**
依次检查：json 文件是否在项目根目录的 `.agentdev/mcps/` 下、格式是否为上述三种写法之一、会话是否在修改之后启动。本地进程型 server 还要确认 `command` 在本机可执行（依赖是否安装）。

**想知道当前会话有哪些 MCP 工具？**
右侧栏「功能」面板查看当前会话装载的能力与工具清单；或直接在对话里询问。
