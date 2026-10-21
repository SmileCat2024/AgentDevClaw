# MCP 配置

MCP（Model Context Protocol）用于给助手接入外部工具服务器。本产品有两条配置路径，先按需求选择：

| 路径 | 入口 | 连接由谁持有 | 适合 |
|---|---|---|---|
| 共享 MCP 网关 | 设置 → MCP 网关 | Claw 主进程集中托管，所有会话复用同一连接 | 本机全局共享的 server；有状态面板与 HTTP API，出错可见、可重启 |
| 项目级配置文件 | 会话目录下 `.agentdev/mcps/*.json` | 每个会话独立启动自己的 server 进程 | 跟着项目走的 server，可进版本库与团队共享 |

两条路径可同时使用。为同一个服务选择一条路径，避免重复启动。项目配置文件之间同名 server 会加序号后缀；项目配置与网关同名时，当前实现采用网关条目，应使用不同 ID 区分。

**优先推荐网关路径**：连接集中管理、状态随时可查、保存后立即尝试连接。项目级路径出错时界面上几乎没有提示（见文末排查表），静默失败最难发现。

## server 配置字段（两条路径的共同规则）

一个 server 描述「怎么连上它」，按传输类型二选一：

- **本地进程（stdio）**：`"transport": "stdio"` + `command`（可执行程序）+ `args`（参数数组，可选 `env` 环境变量对象）
- **远程服务（http / sse）**：`"transport": "http"`（或 `"sse"`）+ `url`

项目配置文件支持 `type` 映射到 `transport`，建议统一显式使用 `transport`；网关 API 直接使用 `transport`，不做该映射。**项目级 stdio 条目必须写 `"transport": "stdio"` 或 `"type": "stdio"`**：包裹写法缺失时会走 HTTP 分支并报 Invalid URL，单对象写法缺失时文件会被忽略。JSON 能解析只证明语法正确，仍需验证工具调用。

例外：经网关添加的 server 不写 `transport` 时默认按 stdio 处理，不会踩这个坑；项目级文件则必须显式写。

## 路径一：共享 MCP 网关

### 界面操作

右侧栏底部齿轮 → MCP 网关 → 「+ 添加服务器」，表单字段：

- **服务器 ID**：即工具名前缀，工具形如 `mcp_<ID>_<工具名>`；
- **传输类型**：stdio / HTTP (StreamableHTTP) / SSE，默认 stdio；
- stdio 型填：**命令**（如 `npx`）、**参数**（每行一个）、**环境变量**（JSON 对象，可留空）；
- http / sse 型填：**URL**。

保存后立即尝试连接。列表中每项显示状态（已连接 / 连接中 / 错误 / 未连接）、工具数量与错误信息，支持重启、编辑、删除、启停。

### 助手代配（端到端操作，不依赖界面）

助手可以全程经本机 HTTP API 完成网关配置与验证，用户只需在对话里提需求。要点：

1. **定位当前实例**：先通过终端读取 `PROTOCLAW_SERVER_ORIGIN`，Claw 宿主会将当前服务地址传给 runtime，子进程可继承。缺失时才探测默认地址 `http://127.0.0.1:1420`，不能用默认端口替代已知实例地址。用户数据根取 `AGENTDEV_DATA_DIR`，未设置时为 `~/.agentdev/AgentDevClaw/`；安装目录、数据目录、当前项目目录是三个不同位置。经 `GET /protoclaw/mcp-gateway/status` 核实目标实例可达；认证失败时使用正常授权流程，不绕过访问保护。标准配置可经 API 或数据目录完成，无需安装目录；环境变量、API 与本机进程证据均无法定位，才询问用户服务地址或安装位置。
2. **读现状**：`GET /protoclaw/mcp-gateway/config` 返回当前全部 server 配置。
3. **写入配置**：`PUT /protoclaw/mcp-gateway/config`，body 形如：

   ```json
   {
     "servers": {
       "my-server": { "transport": "stdio", "command": "npx", "args": ["-y", "some-mcp-server"] },
       "remote-one": { "transport": "http", "url": "http://localhost:3000/mcp" }
     }
   }
   ```

   **PUT 是全量替换 `servers`**：必须先 GET 读出旧配置、合并目标条目后整体写回，否则已有 server 会被删掉。网关侧字段名用 `transport`（不写默认 stdio）。
4. **验证注册**：PUT 保存后自动尝试连接；读取 status，确认目标 server `status: "connected"` 且 `toolCount > 0`。这只证明 MCP 连接及工具发现完成；随后必须按下文「端到端验收」实际调用工具。
5. **处理失败**：结合 `lastError` 与实际工具返回定位失败层。修改已有 server 后显式 `POST /protoclaw/mcp-gateway/<id>/restart`，再核对状态与实际调用；仅修复其下游应用时，先验证下游再决定是否需要重启连接。GET 成功或 POST 返回 `ok` 都不是业务操作成功的证据。

### 生效时机（重要）

会话在**首次运行（注册工具）时**一次性发现网关 server，且只发现「已连接且有工具」的。因此：

- 新会话注册工具时会发现已就绪的 server，前提是 MCP Feature 已启用、`enableGateway` 开启且该 ID 未被排除；
- 给已开着的会话补配置，需要新开会话（或重启 Claw 后重开原会话）；
- 状态为「错误」的 server 对会话不可见——必须先修好并重启连接。

### 配置文件

网关配置持久化在当前用户数据根下的 `mcp-gateway.json`（默认 `~/.agentdev/AgentDevClaw/mcp-gateway.json`）。运行中优先经 API 修改，避免磁盘与内存分叉；服务未运行时可编辑文件，启动后再验证。保留全部现有条目及 `systemServers` 开关，凭证不写入回复或版本库。

## 路径二：项目级 `.agentdev/mcps/`

在**会话绑定的目录**（新建对话时选择的那个项目目录，不是 Claw 安装目录）下创建 `.agentdev/mcps/`，每个 server 一个 json 文件。三种写法：

**写法一：`servers` 包裹（标准格式）**

```json
{
  "servers": {
    "my-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  }
}
```

**写法二：`mcpServers` 包裹（Claude 格式）**

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  }
}
```

**写法三：单个 server 对象（文件名即 server 名，如 `my-server.json`）**

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "some-mcp-server"]
}
```

规则与注意：

- **每个 server 必须带 `type` / `transport` 字段**（共同规则见上文）。缺字段时：包裹写法里该 server 连接失败、工具静默不出现；单对象写法整个文件被忽略——两种情况界面上都没有任何提示。
- **从 Claude Code / Claude Desktop 的 `.mcp.json` 迁移**：`mcpServers` 的内容可以直接搬过来，但 stdio 条目要补上 `"type": "stdio"`（Claude 配置里通常没有这个字段）。
- **加载时机**：会话首次运行时读取并连接，每个会话独立启动自己的 server 进程（互不共享）。新增或修改配置后，新开会话生效；已开着的会话要等运行进程重启（重启 Claw 后重开）。
- **排错界面差异**：项目级 server 的连接状态不出现在 MCP 网关面板里，验证主要靠在对话中实际调用工具。

## 端到端验收

助手代配的交付是「目标会话能执行用户需要的操作」，按顺序验证，不把中间层成功当作最终成功：

1. **确定目标与运行条件**：确认配置作用域、会话目录、上游服务的启动命令、需要的桌面模式或无界面模式、素材与输出目录。先读服务官方文档和本机 CLI 帮助，核对程序实际安装路径；不猜参数，不默认扩大文件权限。
2. **保存并回读**：保留已有配置，写入目标条目并回读。项目配置检查 MCP Feature 的 `scanAgentdevDir` 是否开启，或通过 `extraConfigFiles` 显式加载；网关配置检查 `enableGateway`。配置保存、JSON 解析、MCP 握手、工具枚举分别是不同阶段。
3. **实际调用**：优先从目标会话调用已挂载的 `mcp_<serverId>_<toolName>`，执行只读检查并确认返回对应目标应用。检查 MCP 的 `isError` 和内容里的业务错误，外层工具调用 `success: true` 不代表操作成功。工具尚未挂载时可用 MCP 客户端独立探测，但必须标注「独立探测通过，目标会话未验证」，不要冒充已挂载工具验证。
4. **验证所需能力**：按用户任务检查读文件、置入素材、编辑、保存或导出等必要环节。只读查询通过不能证明写操作可用。写入验证需使用单独测试文档与不会覆盖现有文件的新路径，事先说明副作用；不适合安全测试时明确保留未验证项。
5. **交付状态**：说明配置路径、服务端点、实际成功的操作、剩余阻断和生效动作。运行中的项目级 MCP 进程仍持有旧参数；改文件后让用户在对应目录新开会话，不擅自终止当前对话或重启 Claw。

### 桌面桥接服务的第二段连接

部分 MCP server 只是桥接进程：`会话 → MCP CLI → 桌面应用控制端口`。CLI 可以在桌面应用未启动时完成握手和列工具。此时网关也可能显示已连接、工具数大于 0，实际工具调用仍会失败。

- 检查桌面应用确实在监听，端口归属正确，并与 MCP 参数、启动快捷方式一致。端口被其他进程占用时不要杀进程，选空闲端口并同步所有入口；应用退出后连接也会失效。
- 核对两端使用同一凭证文件，验证真实只读调用；凭证内容不输出。不要把原生 TCP 控制端口当作 HTTP MCP URL。
- 文件权限由上游应用约束。素材和输出必须位于实际授权目录内；修改桥接 CLI 参数不一定能改变桌面应用的授权。
- 遇到明确拒绝（权限、模式或不支持的命令）时，报告失败层及错误，不通过重试掩盖。需要换成无界面模式、脚本调用或修改上游实现时，先与用户确认调用方式和可见效果的变化，不静默切换。

PhotoCraft 的已验证边界：桥接时读写根配置在桌面进程；`doc_open` 可走受限目录接口，但当前 `doc_place` 桥接到 `file.placeEmbedded`，会被桌面策略拒绝为 `uses ambient filesystem paths and is disabled`。这时连接成功也不等于素材置入可用，不能继续把问题归因于 Claw 的配置格式。

## 验证与排查

- 工具命名规则 `mcp_<serverId>_<toolName>`；右侧栏「功能」面板可查看工具是否注册；
- 网关 server：`GET /protoclaw/mcp-gateway/status` 查看 MCP 连接状态与 lastError，业务调用错误仍需检查工具返回；
- 项目级 server：查看会话日志及实际工具返回，连接状态不在网关面板里。

| 症状 | 原因与处理 |
|---|---|
| 工具已出现，但调用 connection refused | 检查下游应用是否运行、控制端口是否监听、MCP 与启动入口端口是否一致 |
| 调用返回路径超出授权根 | 核对素材与输出目录、上游实际授权；不要擅自扩大权限或搬移用户素材 |
| 查询成功，但编辑返回 disabled / unsupported | 查服务文档和模式限制；连接配置不一定有错，区分上游实现问题 |
| 工具没出现 | 先检查配置目录、Feature 开关与加载时机；项目级 stdio 条目再检查 `type` / `transport` |
| 单对象文件整个不生效 | 同样是缺 `type`，此时文件在加载阶段就被忽略。补字段 |
| 网关面板显示「错误」 | 看 lastError；修好上游后点「重启」（或 POST restart）。错误状态的 server 不会进入任何会话 |
| 配置就绪但会话里仍没有工具 | 会话创建早于配置生效：新开会话；并确认 server 已连接且 toolCount > 0 |
| command 无法执行 | 确认程序路径正确、依赖已安装（如 npx 可用）；Windows 带空格的路径写完整路径即可 |
| server 取名 `crawl4ai-official` | 该名字在编程小助手的内置排除名单里，换个名字即可 |
