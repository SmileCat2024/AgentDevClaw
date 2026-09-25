# 应用配置与用户数据边界收敛计划

**状态：已实施。** 应用配置统一使用 Claw 用户数据目录；服务启动时将已知旧位置配置复制到缺失的新位置。旧文件保留，运行时不再回读旧位置。

## 目标与范围

桌面安装目录最终应可视为只读应用资源。应用自己的设置、凭据和运行状态需存放于稳定、可写、升级不覆盖的用户数据位置；用户选定项目中的文件则继续由项目目录拥有。

本阶段将应用配置从仓库目录收敛到既有用户数据目录，为后续只读应用资源运行做准备；不包含桌面打包，也不迁移用户项目的 `.agentdev`。

## 路径分类

| 类别 | 数据例子 | 当前权威位置 | 归属与处理原则 |
|---|---|---|---|
| 应用资源 | `prebuilt-agents/**/metadata.json`、prompt 模板、静态 UI、内置 Feature 与安装依赖、`config/default.example.json` | `PROJECT_ROOT` | 随应用发布，运行时只读；资源定位需适配打包布局，但不迁入用户数据目录。 |
| 全局应用设置 | 模型默认值、模型预设、语音模型设置 | `USER_DATA_ROOT/default.json`、`USER_DATA_ROOT/presets.json` | 当前 API 写用户目录；启动时优先从旧 `PROJECT_ROOT/config/default.json`、`presets.json` 迁移；仅缺失时从只读应用资源 `config/default.example.json` 初始化默认模型文件。 |
| 应用级可写配置 | Agent 身份启动模型/进程模式、IM 渠道凭据与线路、MCP Gateway、Remote Claw | `USER_DATA_ROOT` 与 `USER_DATA_ROOT/agent-configs/` | 单一权威用户目录，不依赖仓库或安装目录。 |
| 应用运行数据 | 会话、workspace state、线程、handoff、远程连接、Feature 仓库、runtime env、Agent 注册表、OAuth token、代理配置、日志/诊断、图片等 | `USER_DATA_ROOT`，默认 `~/.agentdev/AgentDevClaw`；由 `AGENTDEV_DATA_DIR` 控制 | 已有稳定用户数据边界；不与应用配置混同。需要验证打包宿主和全部子进程一致继承数据根。 |
| 用户项目数据 | 项目源文件、项目级 Feature 配置、MCP 定义、skills、项目文档集、输出文件 | 用户选择的 `workspaceDir` / 项目根目录下 `.agentdev/` | 必须保持在原项目目录；多项目间可跟随项目共享。应用升级不得迁移或重写。 |
| 应用内置 Agent 资产 | 预制 Agent 自带的 `.agentdev/prompts/**` | 随 `prebuilt-agents/**` 发布 | 是只读应用资源，不是应用设置，也不是用户项目 `.agentdev`。新建 Agent Studio 项目写入其输出目录的 `.agentdev/prompts` 则属于该生成项目。 |
| Feature 安装环境 | 已解析 Feature 的内容寻址依赖环境 | `USER_DATA_ROOT/runtime-envs`；Feature 仓库分为随包 `resources/features` 与用户 `user-features` | 属于运行资产/扩展环境，不应当成普通设置迁移；其依赖安装策略单独在后续阶段评估。 |

## 应用级配置清单与调用链

### 全局模型与语音配置

- 路径定义：`server/shared/constants.js` 的 `APP_CONFIG_ROOT`、`MODEL_CONFIG_PATH`、`MODEL_PRESETS_PATH`；`APP_CONFIG_ROOT` 直接等于现有 `USER_DATA_ROOT`，没有额外配置根环境变量。
- 读写：`server/routes/model-config.js`；启动时由 `server.js` 在用户目录初始化缺失配置，模板 `config/default.example.json` 是只读应用资源。
- Runtime 消费：`server/model-preset-resolver.js`；ACP 与 plain/prebuilt Agent 解析器通过共享常量读取同一用户目录。

### Agent 身份配置

当前权威文件为 `USER_DATA_ROOT/agent-configs/<agentId>.json`，既有 `modelPresets`，也有 `processMode` 等宿主覆盖值。启动时会把旧仓库 `.agentdev/agent-configs/*.json` 复制到缺失的新文件；旧文件保留，但运行时不再读取。Plain Agent 的覆盖配置也使用此目录。

- 读：`server/routes/agent-discovery.js` 用于 Agent 列表/身份投影；`server/routes/model-config.js` 用于会话模型信息和进程模式；`server/model-preset-resolver.js` 用于 Agent 启动模型；`server/routes/acp.js` 读取 coder 启动配置；`scripts/run-prebuilt-agent.js` 的 coder 分支明确指定 coder 配置文件；`scripts/run-plain-agent.js` 也显式把路径传给模型解析器。
- 写：`server/routes/model-config.js` 的 Agent 模型预设和进程模式接口；`server/routes/acp.js` 的 ACP `model` 参数会持久化成 coder 默认启动预设。
- 易错点：coder 是 programming-helper 内部身份，但它的文件是独立 `coder.json`；迁移不能只处理 `programming-helper`。所有读取与写入使用同一用户数据根；runtime 重启/新建后读取该处配置。

### IM 渠道与线路配置

权威路径由 `server/shared/constants.js` 的 `APP_*_CONFIG_PATH` 指向 `USER_DATA_ROOT`：`qqbot.config.json`、`weixin-bot.config.json`、`feishu-bot.config.json`、`wecom-bot.config.json`、`rokid.config.json`、`im-workspace.config.json`。启动时从仓库 `.agentdev/` 复制缺失的新文件，旧位置不再读取。

- 服务端读写：`server/routes/im-config.js`；bundle/二维码绑定与来源路径投影在 `server/routes/im-workspace-bundle.js`；QQ 运行流程还在 `server/routes/im.js` 使用相应路径。
- Agent 子进程：`prebuilt-agents/official/qqbot/agent.js` 从共享常量读取默认应用配置路径；可选的显式 `configPath` 仍由宿主/Feature 装配传入。已移除仓库和相邻 AgentDev 源码仓库路径候选。
- 连接令牌和 bot token 属于敏感凭据；配置路由会返回部分渠道配置给受保护的设置 UI，日志不得输出 secret。

### MCP Gateway 配置

- 路径：`MCP_GATEWAY_CONFIG_PATH` 指向 `USER_DATA_ROOT/mcp-gateway.json`。启动时仅当新文件不存在时从仓库 `.agentdev/mcp-gateway.json` 复制；运行时不再读取旧位置。
- 读写：`server/mcp-gateway/manager.js` 的 `MCPGatewayManager` 默认加载并持久化该文件；其 stdio server 定义还可包含子进程命令、参数和环境变量。
- 配置中的环境变量可能含密钥，命令路径可能依赖用户机器；不要把 Gateway 配置与项目 `.agentdev/mcps` 发现目录合并。

### Embedded Remote Claw 配置

- 路径：`server/shared/constants.js` 的 `REMOTE_CLAW_CONFIG_PATH` 指向 `USER_DATA_ROOT/remote-claw.json`，由服务端和 embedded connector 共用。
- 读写：`server.js` 的连接/配置路由写入，embedded connector 独立读取以启动连接。启动迁移会在目标缺失时从仓库 `.agentdev/remote-claw.json` 复制；运行时不再读取旧位置。
- 配置含 relay token，属于敏感应用凭据；服务路由与 connector 共用同一配置文件。

## 不应迁移的 `.agentdev` 路径

以下路径中的 `.agentdev` 依赖其**所在项目/工作区**语义，不是 Claw 安装目录的应用配置：

- Programming Helper 以当前 `workspaceDir` 装配目录层 Feature 配置：`server/shared/feature-config-layers.js` 的 `dirLayerPath()`，以及 `prebuilt-agents/official/programming-helper/agent.js` 的 `readDirLayer(workspaceDir)`。
- Agent 运行时按用户工作区扫描 `.agentdev/mcps`、`.agentdev/skills`，并可读取项目级配置；这些是项目的扩展与指令。
- `server/routes/session.js` 把大工具输出写入 `process.cwd()/.agentdev/temp`；工作区工具/导出产物也可能写入项目内 `.agentdev/temp` 或资源目录。
- `server/shared/session-access.js` / `PROJECT_DOCSET_SUBPATH` 的 `.agentdev/claw-workspace` 文档集，以及 Agent Studio 创建到输出项目中的 `.agentdev/prompts/system.md`。
- `server/routes/group-chat/format-helpers.js` 的 `<chat.workDir>/.agentdev/resources` 属于群聊工作目录。
- 预制 Agent 代码目录内的 `.agentdev/prompts/**` 是随应用发布的内置 prompt；它与用户选定项目的同名目录不是同一存储对象。

特别注意：仓库根下旧 `.agentdev/agent-configs` 等应用设置已不再参与运行；运行时 `workspaceDir/.agentdev/**` 仍属于项目数据。仅凭目录名不能批量搜索替换或移动。

## 收敛边界

1. 所有应用级可写配置直接使用现有 `USER_DATA_ROOT`；不新增配置目录环境变量或第二套路由。
2. 启动时按明确白名单迁移旧应用配置：仅当目标不存在时复制，目标已存在则保留现值；复制采用排他创建，不覆盖；旧文件保留，应用不再读取或写入它们。
3. 迁移清单限于模型 `default.json` / `presets.json`、指定 IM/MCP/Remote Claw 文件和 `.agentdev/agent-configs/*.json`。`AGENTDEV_DATA_DIR` 是已有的用户数据根覆盖选项；旧仓库配置迁移仍从当前 `PROJECT_ROOT` 查找，不扫描其它 checkout。用户项目 `workspaceDir/.agentdev/**`、随应用发布的 `prebuilt-agents/**/.agentdev/prompts/**` 与内置资源 `config/default.example.json` 不迁移。
4. `AGENTDEV_DATA_DIR` 仍是既有数据根覆盖入口，服务及子进程都从进程环境继承；本次没有增加新的路径注入约定。
5. 桌面打包仍不在本次范围内；应用资源只读情况下的全量启动验证留待只读资源目录阶段。

## 验证与剩余工作

- 路径常量测试覆盖模型、Agent 身份、IM、MCP Gateway、Remote Claw 的用户目录落点；模型身份覆盖测试注入隔离 fixture 路径。
- `server/app-config-migration.js` 在服务启动阶段迁移已知旧配置，仅填补目标缺失项，采用排他复制并保留来源文件；冲突跳过，复制失败记录告警。
- `server.js`、ACP、plain/prebuilt runtime、IM Agent 与 Remote Claw connector 使用共享路径常量；项目工作区 `.agentdev` 读取链未改。
- 迁移单测验证缺失目标复制、已有目标不覆盖、旧文件保留及项目 `.agentdev` 不进入用户数据；尚无真实服务端启动迁移演练。
- 尚需补充/执行 IM 子进程运行时集成验证，以及将应用资源目录设为只读的全量启动测试；桌面打包仍在后续阶段。
