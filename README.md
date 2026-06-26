# AgentDevClaw

基于 [AgentDev](https://github.com/SmileCat2024/AgentDev) 框架构建的 AI Agent 工作空间平台。

你可以把它理解为**多个 AI Agent 的运行宿主和管理中心**。每个 Agent 是一个独立进程，拥有自己的 Feature 组合（工具链）、会话历史和工作目录。你可以通过浏览器与 Agent 对话，也可以通过 QQ / 微信将消息路由到 Agent，还可以在群聊中同时指挥多个 Agent 协作。

## 快速开始

**前置要求：** Node.js >= 20

```bash
git clone https://github.com/SmileCat2024/AgentDevClaw.git
cd AgentDevClaw
npm install
npm start
```

启动后，服务会同时占用两个本地端口：

| 端口 | 用途 | 说明 |
|------|------|------|
| **1420** | Web UI | 你需要访问的是这个：http://127.0.0.1:1420 |
| **2026** | ViewerWorker | 内部调试协议服务，不需要手动访问，但必须空闲可用 |

启动成功后浏览器打开 **http://127.0.0.1:1420** 即可看到工作空间界面。

> 如果 1420 或 2026 端口被占用，可以通过环境变量调整：`PORT=1500 AGENTDEV_VIEWER_PORT=2100 npm start`

## 配置模型

**首次使用前必须配置 LLM 模型，否则 Agent 无法响应。**

在 Web UI 左下角点击设置图标（齿轮），打开模型配置面板。你需要填写以下信息：

| 字段 | 说明 | 示例 |
|------|------|------|
| **Provider** | 模型提供商 | `anthropic` |
| **Model** | 模型名称 | `claude-sonnet-4-20250514` |
| **Base URL** | API 地址 | `https://api.anthropic.com` |
| **API Key** | 密钥 | 你的 API Key |

配置保存在 `config/default.json`。也可以直接编辑该文件：

```json
{
  "defaultModel": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "your-api-key"
  },
  "agent": {
    "maxTurns": 20,
    "temperature": 0
  }
}
```

**关于模型兼容性：**

当前对 **Anthropic 兼容接口**适配最好。推荐使用以下任一方案：

- Anthropic 官方 API（`https://api.anthropic.com`）
- 支持 Anthropic 兼容协议的第三方服务（如 DeepSeek、OpenRouter 等提供 `/anthropic` 端点的服务）
- 本地部署的 Anthropic 兼容代理

> OpenAI 兼容接口（`provider: "openai"`）也支持，且支持Responce格式，但使用稳定性不如 Anthropic 兼容格式。

配置完成后，在设置面板中可以创建多个**模型预设**，在不同会话之间快速切换。

## 核心工作空间

### 编程小助手 (Programming Helper)

面向真实编码任务的 AI 编程工作空间，对标 Claude Code 的交互体验。

**基本使用：**

1. 在左侧选择"编程小助手"工作空间
2. 点击"新建对话"，选择你要操作的项目目录
3. 直接用自然语言描述需求，Agent 会读取文件、执行命令、修改代码

**对话操作：**

| 操作 | 说明 |
|------|------|
| 新建对话 | 选择项目目录后开始全新会话 |
| 发送消息 | 底部输入框输入，支持 Markdown |
| 中断 | Agent 正在执行时点击停止按钮，打断当前工具调用 |
| Rollback | 回退到之前的 Checkpoint，丢弃之后的更改 |

**左侧栏右键菜单：**

在左侧会话列表中**右键点击运行中的会话条目**（带绿点的 Runtime 条目），可以执行高级操作：

| 菜单项 | 说明 |
|--------|------|
| AI 生成标题 | 调用 LLM 为当前会话自动生成标题 |
| 总结历史（摘要） | 将完整对话压缩为摘要，可选归档原会话 |
| 精简历史（Trim） | 裁剪指定位置之前的历史消息，可选归档原会话 |
| 创建分支 | 从当前会话分叉出一个新对话，可选归档原会话 |
| 归档会话 | 归档当前会话（从列表移至归档区），同时停止运行时 |
| 重启 Agent | 重启当前会话的 Agent 进程（清空运行时状态） |
| 关闭 Agent | 停止当前会话的 Agent 进程 |

**右键点击会话列表中的会话项**（非运行时条目），可以：

| 菜单项 | 说明 |
|--------|------|
| 设为待办 / 取消待办 | 标记会话为待办状态，方便跟踪未完成任务 |
| 归档 / 取消归档 | 将会话移入或移出归档区 |
| 删除对话 | 永久删除该会话（不可恢复） |

**能力清单：**

- 指向项目目录，直接开聊——不填表单，不配参数
- 集成 Shell（命令执行）、LSP（符号跳转 / 类型查看 / 引用查找）、Web 搜索、文件审计等完整工具链
- 会话分支、上下文精简（trim / compact / summary）、checkpoint / rollback
- 探索会话与子代理（只读分析、知识收集，不修改文件）
- AI 生成会话标题，对话导出为 HTML
- 支持语音输入与声音反馈

### IM 渠道 (QQBot / WeixinBot)

IM 门户代理，将 QQ / 微信消息路由到内部 Agent 会话。

**基本使用：**

1. 在左侧选择"IM 渠道"工作空间
2. 在首页配置面板中填写 QQ 或微信的连接信息（AppID、Token、Secret 等）
3. 启动门户代理，它会作为"接线员"监听 IM 消息
4. 在对话中，接线员可以将收到的 IM 消息路由到其他工作空间的运行中会话（如编程小助手）

**能力清单：**

- 多 IM 渠道管理（QQ / 微信），各自独立配置与网关
- 门户代理作为"接线员"，动态将消息线路转接到运行中的工作空间会话
- 用户在 IM 中发消息 -> 路由到 Agent -> Agent 回复传回 IM
- 支持 QQ 群消息与私聊消息

### 工作群 (Work Group) — Beta

群聊指挥台，以即时通讯的方式指挥多个 Agent 协作。

**基本使用：**

1. 在左侧选择"工作群"工作空间
2. 点击"新建群聊"，系统会自动注册所有声明了群聊身份的 Agent
3. 在群聊中 `@编程小助手` 或其他身份来派发任务
4. `@管理员` 可以请求协调：查看群状态、分配任务、生成摘要

**能力清单：**

- 在群聊中 @不同 Agent 身份，派发任务并跟踪执行状态
- 管理员 Agent 负责协调：查看群状态、分配任务、生成摘要
- 群聊消息流作为永久存储，上下文按需透明取用
- 主动性模式（辅助 / 规划 / 执行）与自决权模式正交配置

> 基础闭环（建群 -> @mention -> Agent 执行 -> 状态可见 -> 管理员协调）已可用，深度功能仍在迭代。

### Runtime 配置 (Runtime Config)

系统级功能配置面板，管理 Agent 运行时依赖的外部工具和 Feature 设置。

- **Shell 路径**：配置 Bash / PowerShell 的可执行路径，控制哪些 Shell 可用
- **语言服务器**：配置 LSP 相关路径
- **音频设置**：声音反馈相关的配置项

> 该工作空间为纯 UI 配置面板（无 Agent 进程），配置写入后对所有工作空间生效。目前实际消费这些配置的主要是编程小助手。

## 架构

```
server.js 主进程
├── Express (port 1420)
│   ├── 静态前端 (public/)
│   ├── ProtoClaw REST API
│   └── IM / Flow / Dispatch / GroupChat 路由
├── ViewerWorker (port 2026)
│   └── DebugHub 调试协议与数据
└── Agent 子进程 (per-runtime)
    └── run-prebuilt-agent.js -> 动态 import agent.js
```

**关键设计：**

- 每个预制 Agent 是一个独立子进程，通过 ViewerWorker IPC 通信
- Agent 的能力通过 Feature 组件化组装（ShellFeature、WebSearchFeature、TodoFeature 等）
- 会话数据存储在 `~/.agentdev/AgentDevClaw/` 下，不污染项目仓库
- 前端为原生 JS（无构建步骤），由 server.js 直接 serve

## CLI

安装后可通过 `claw` 命令在终端中操作工作空间：

```bash
npx claw                      # 查看工作空间概览
npx claw explorations         # 列出探索记录
npx claw show <sessionId>     # 查看会话详情
npx claw spawn "分析X模块"     # 创建探索会话
npx claw compact <sessionId>  # 精简会话上下文
npx claw resume <sessionId> "继续分析"  # 恢复子代理对话
```

## 目录结构

```
server.js                      Express 服务端入口
config/default.json            模型配置（gitignored，首次通过 UI 或手动创建）
bin/claw.mjs                   CLI 工具
server/                        服务端模块
  claw-core.mjs                CLI/MCP 共享核心（provider 注册与分发）
  claw-mcp.js                  MCP Server
  runtime-call-envelope.js     运行时调用信封
  model-preset-resolver.js     模型预设解析
  context-continuity/          上下文压缩与交接
  conversation-renderer.js     对话导出渲染

prebuilt-agents/official/      预制 Agent
  programming-helper/          编程小助手 ★
  qqbot/                       IM 渠道门户代理 ★
  work-group/                  群聊指挥台 (Beta)
  feature-setup/               Runtime 配置 (系统级 Feature 设置)
  flow-workspace/              Flow 工作空间 (悬置)
  feature-creator/             Feature 开发工具 (悬置)
  agent-creator/               Agent 装配工具 (悬置)
  dispatch-console/            调度台 (悬置)

local-features/                本地 Feature 源码（TypeScript）
  flow/                        Flow 运行时核心
  dispatch/                    调度系统
  group-admin/                 群聊管理员工具集
  feature-dev/                 Feature Creator 后端
  checkpoint/                  会话检查点
  context-compaction-mirror/   上下文精简
  context-handoff-seed/        上下文交接
  conversation-export/         对话导出

resources/features/            Feature tgz 包（自包含，随仓库分发）
public/                        Web 前端（无构建步骤）
scripts/                       运行时脚本与工具
```

> ★ = 当前主要维护的工作空间。其余为早期探索阶段的产物，代码保留但不再积极迭代。

## Feature 体系

AgentDevClaw 的 Agent 能力建立在 agentdev 框架的 Feature 机制之上：

- **框架内置 Feature**：TodoFeature、UserInputFeature、LspFeature、SkillFeature、MCPFeature 等，随 `agentdev` npm 包分发
- **独立 Feature 包**：ShellFeature、WebSearchFeature、QQBotFeature、WeixinBot 等，以 tgz 包形式随仓库分发，位于 `resources/features/`
- **本地 Feature**：项目自身的 TypeScript Feature（Flow、Dispatch、GroupAdmin 等），编译后通过 `prestart` 钩子自动构建

预制 Agent 通过组合不同 Feature 获得不同能力。例如编程小助手集成了 Shell + LSP + WebSearch + Audit + Memory，而 IM 渠道则集成 QQBot + WeixinBot + IMOperator。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `1420` | Web UI 端口 |
| `AGENTDEV_VIEWER_PORT` | `2026` | ViewerWorker 端口 |
| `AGENTDEV_UDS_PATH` | — | ViewerWorker UDS / named pipe |
| `AGENTDEV_DEBUG_TRANSPORT` | — | 调试传输模式 |
| `ANTHROPIC_API_KEY` | — | 可在模型配置中通过 `${ANTHROPIC_API_KEY}` 引用 |

## 技术栈

- **Runtime**: Node.js, agentdev 框架
- **Server**: Express, ViewerWorker (agentdev)
- **Frontend**: 原生 JavaScript (ES Modules), 无框架依赖
- **IM**: @sliverp/qqbot (QQ), WeixinBot (微信)
- **Language**: JavaScript (服务端/前端) + TypeScript (local-features)

## 开发

```bash
# 编译 local features（npm start 前自动执行）
npm run build:local-features

# 运行测试
npm test

# 仅核心测试（无需编译）
npm run test:core

# 仅 feature 测试（需先编译）
npm run test:features
```

## License

MIT
