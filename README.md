# AgentDevClaw

一个实验性质的 AI Agent 工作空间平台，由自研[AgentDev](https://github.com/SmileCat2024/AgentDev) 框架驱动。

AgentDevClaw 充分发挥 AgentDev 框架的 **Feature 机制**：每个 Agent 都是独立进程，由不同的 Feature 组件组合装配而成——Shell、Web 搜索、LSP、IM 网关等等。不同的 Feature 像搭积木一样组合产生不同能力的 Agent。平台将这些 Agent 组织到多个**工作空间**中，每个工作空间面向一类使用场景，提供统一的会话管理、工作目录绑定和运行状态的清晰跟踪。

### 与 Agent 交互

- **浏览器对话** —— 在 Web UI 中直接与 Agent 对话，支持精美的 Markdown 渲染和实时的工具调用可视化，提供接近原生 IDE 的交互体验
- **IM 渠道** —— 已适配微信、QQ、企业微信、飞书四种渠道。在 IM 渠道工作空间中配置好线路后，IM 消息会被路由到内部 Agent 会话，Agent 的回复也会传回 IM
- **工作群（Beta）** —— 一种探索性的协作模式。创建多个群聊（每个群聊相当于一个话题空间），将多个 Agent 加入其中，在管理员 Agent 的协调下指挥多 Agent 协作。

AgentDevClaw 是一个以 Agent 为中心的，可扩展的工作台架构，整合配置、会话、调度、协作等多重职责，目标是让agent搭建与管理更加灵活，构建完全透明与可信任的运行过程。它本身也是一个持续迭代的项目，我们会充分发挥其架构优势，不断测试、推出新的 Agent 交互范式。

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

首次使用前需在 Web UI 左下角的设置面板中配置全局 LLM 模型预设方案（需填写Provider、Model、Base URL、API Key），否则 Agent 无法响应。配置完成后，还可在设置面板中创建多个**模型预设**，便于快速切换。**部分工作空间内部支持单独配置模型**，为工作空间下不同身份的agent分别配置不同的模型预设

### 模型兼容性

AgentDevClaw 当前支持以下几类模型接口，适配程度由高到低：

**1. Anthropic 兼容接口（`provider: "anthropic"`）— 推荐**

这是当前适配最好、稳定性最高的方案。以下三种来源均可：

- Anthropic 官方 API（`https://api.anthropic.com`）
- 支持 Anthropic 兼容协议的第三方服务（如 DeepSeek、OpenRouter 等提供 `/anthropic` 端点的平台）
- 本地部署的 Anthropic 兼容代理

**2. OpenAI 兼容接口（`provider: "openai"`）**

OpenAI 格式进一步分为两种 API 面（通过 `apiSurface` 字段区分）：

- **Chat Completions**（`apiSurface: "chat"`，默认）—— 传统的 `/v1/chat/completions` 接口，绝大多数 OpenAI 兼容服务都支持这种格式
- **Responses**（`apiSurface: "responses"`）—— OpenAI 较新的 Responses API 格式，部分新模型和服务提供此端点

> OpenAI 兼容接口总体可用，但在错误处理等底层细节上不如 Anthropic 兼容格式健壮。如果遇到异常行为，优先考虑切换到 Anthropic 兼容方案。

### 模型压缩阈值

每一个模型预设都可以配置压缩阈值，会话界面会时刻显示用量进度条。请注意，AgentDevClaw**不会对会话自动进行任何的压缩处理**，必须手动管理应对模型超限问题

## 核心工作空间

### 编程小助手

AgentDevClaw 的核心工作空间——一个对标 Claude Code 的 AI 编程 Agent，但在命令行工具之外，利用Claw所提供的能力，拥有完整的**可视化交互层**。Agent 的每一次文件读取、命令执行、代码修改，乃至提示词与动态注入的信息都实时可见，所有过程完全透明可追溯，你始终知道它在做什么，它的上下文里有什么。

编程小助手以**会话**为核心组织单位。每个会话绑定一个项目目录，拥有独立的上下文和历史。它的一大特色是**强大的会话管理能力**：

- **会话分支** —— 从任意对话节点分叉出新会话，探索不同方向而不丢失原始上下文
- **上下文精简** —— 对话过长时，可裁剪早期历史（Trim）或压缩为摘要（Compact），保持上下文聚焦
- **Checkpoint / Rollback** —— 随时保存检查点，出错了可以回退到之前的状态
- **探索会话与子代理** —— 派生只读的探索会话进行代码分析和知识收集，不修改任何文件
- **待办与归档** —— 将会话标记为待办，方便跟踪需要继续处理的任务；将已完成的会话归档，历史记录完整保留，需要继续时随时恢复

这些能力让长任务的上下文管理变得从容——不必担心对话太长，随时可以裁剪、分叉、回溯。以上操作均可在左侧会话列表或历史会话列表中右键触发。

**快速上手：** 选择项目目录、新建对话，用自然语言描述需求即可。Agent 会自主读取文件、执行命令、修改代码。

**能力清单：**

- 集成 Shell（命令执行）、LSP（符号跳转 / 类型查看 / 引用查找）等完整工具链
- 会话分支、上下文精简（trim / compact / summary）、checkpoint / rollback
- AI 生成会话标题
- 支持语音输入与声音反馈（需在全局设置中配置语音模型）

### IM 渠道 

整个 IM 渠道由一个门户代理和两个可指定通道组成，每个都需要配置其连接的IM 平台（需要在渠道配置中填写平台的连接凭证，如AppID、Token、Secret 等）当前支持 QQ、微信、企业微信、飞书四个平台。

- **门户代理**：IM 门户代理是一个"接线员"Agent，把外部 IM 消息接入到内部工作空间会话。门户代理同时只能连一个平台
- **通道**：每条通道也要选择一个 IM 平台，并绑定到一个运行中的工作空间会话（比如编程小助手的某个对话）。门户代理和各通道之间不能使用同一个平台——每个平台同时只能被一方占用

在 IM 渠道工作空间的首页配置面板中完成以上设置。通道的绑定也可以在运行时通过 UI 或对话中动态调整。

启动门户代理后，接线员开始监听主渠道的消息。IM 消息到达时，接线员根据通道配置路由到对应的会话，等待 Agent 回复后传回 IM。接线员能看到平台内部所有工作空间和运行中会话的状态。你还可以让它把某个会话渲染成 HTML 发到 IM 里，方便在手机上浏览。Agent 也支持向 IM 单向发送文件。

### 工作群— Beta

> **注意：** 工作群目前处于开发阶段，部分功能尚未完成或可能存在已知问题。仅供学习参考。

工作群用群聊的形式来指挥和协调多个 Agent——当同时运行多个会话时，在多个 tab 间切换和监控的成本会迅速失控，群聊提供了一种更自然的指挥方式。

群聊中呈现的是高信息密度的工作调度对话，主要包括人的指令、Agent 的回复与进展报告。但每个 Agent 实际上在各自的独立会话中执行任务，群聊是它们对外交流的窗口。这种设计的出发点在于：不同任务的上下文特点差异很大，高信息密度的编码任务和零散的日程管理混在同一个上下文窗口中很难兼顾，因此需要拥有独立的上下文。而繁杂的工具调用和调试细节留在各自的会话里，群聊中始终是干净、有意义的交流内容。

管理员是一个特殊的群成员，会话创建时从群聊中拉取最近一段范围内的消息来建立上下文，并持续跟进追踪新状态，协助查看全局状态、分配任务、生成摘要。上下文达到上限或用户手动指定时管理员会话自动重建，群聊消息始终完整保留可供管理员回看。

在群聊中 `@` 不同 Agent 身份来派发任务，Agent 执行后在群中报告结果。

> 基础闭环（建群 -> @mention -> Agent 执行 -> 状态可见 -> 管理员协调）已初步可用，深度功能仍在开发中。

### Runtime 配置

AgentDev 框架支持通过 Feature 的 manifest 声明自身的可配置项——Shell 可以配置可执行路径、LSP 可以配置语言服务器、声音反馈可以配置音量和音频文件。这让 Agent 不仅能灵活组装 Feature，还能高度自定义每个 Feature 的行为。

Runtime 配置工作空间把这个能力上升到了 Claw 项目整体的层面，是 AgentDevClaw 向 "Agent OS" 方向的探索。它是一个全局配置面板，自动发现所有 Feature 暴露的 manifest 配置项，以统一的 UI 呈现给用户。用户在此处的配置会被持久化，并在下游 Agent 启动时注入到对应 Feature 的参数中——相当于操作系统的"系统设置"面板，统一管理这些运行时环境参数的入口。

> 该工作空间为纯 UI 配置面板（无 Agent 进程），配置写入后对所有工作空间生效。目前实际消费这些配置的是编程小助手——它的 Shell 路径、语言服务器、声音反馈等参数均来自此处。

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
