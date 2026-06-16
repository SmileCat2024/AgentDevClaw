# CLAUDE.md

本文件用于帮助新进入项目的 agent 快速建立“产品目标 -> 核心对象 -> 代码入口 -> 数据流 -> 当前边界”的连续认知，避免只看到零散页面或单个 feature 就误判项目重心。

## 先看这里

如果你刚进入项目，建议按下面顺序读：

1. 本文件
2. [docs/agentdev-claw-product-overview.md](/D:/code/AgentDevClaw/docs/agentdev-claw-product-overview.md)
3. [docs/flow-layer-design.md](/D:/code/AgentDevClaw/docs/flow-layer-design.md)
4. [docs/flow-feature-mode-dual-surface-design-plan.md](/D:/code/AgentDevClaw/docs/flow-feature-mode-dual-surface-design-plan.md)
5. [docs/dev-context-index.md](/D:/code/AgentDevClaw/docs/dev-context-index.md)

如果涉及前端 UI 渲染、workspace 切换、数据加载时序等问题，额外必读：

- [docs/frontend-rendering-patterns.md](/D:/code/AgentDevClaw/docs/frontend-rendering-patterns.md) — 前端渲染机制、去重策略、常见陷阱与自检清单

如果任务直接涉及实现，优先再看这些真实入口：

- 服务端入口：[server.js](/D:/code/AgentDevClaw/server.js)
- 前端壳层入口：[public/index.html](/D:/code/AgentDevClaw/public/index.html)
- 前端公共状态与基础能力：[public/src/app-core.js](/D:/code/AgentDevClaw/public/src/app-core.js)
- 前端 UI 与 workspace 渲染主逻辑：[public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- 前端运行与轮询主逻辑：[public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
- Flow 编辑器：[public/flow-editor.js](/D:/code/AgentDevClaw/public/flow-editor.js)
- Flow 运行时 Feature：[local-features/flow/src/index.ts](/D:/code/AgentDevClaw/local-features/flow/src/index.ts)
- Flow 工作空间预制 agent：[prebuilt-agents/official/flow-workspace/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/flow-workspace/agent.js)
- IM 门户代理：[prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)
- 调度 Feature：[local-features/dispatch/src/index.ts](/D:/code/AgentDevClaw/local-features/dispatch/src/index.ts)
- 运行时信封：[server/runtime-call-envelope.js](/D:/code/AgentDevClaw/server/runtime-call-envelope.js)

## 当前项目定位

`AgentDevClaw` 当前不是单纯的“Viewer 消息调试器”，也不再只是“给几个预制 agent 做首页壳”。

它现在的主线是：

1. 继续作为 `AgentDev ViewerWorker` 的 Web 调试前端
2. 以 `flow-workspace` 为核心，承载 Agent Project 的"项目管理 / 组装 / 编排 / 运行测试"一体化工作空间
3. 通过 `qqbot` 门户代理提供 IM 线路管理（QQ/微信）、消息路由与动态转接
4. 通过 `dispatch-console` 提供定时调度、调用仲裁与运行时信封管理

当前最重要的产品判断是：

```text
Agent Project = Persona + Enabled Features + One Orchestration Graph + Runtime Sessions
```

也就是说：

- 用户当前开发的核心对象不是单条对话，而是一个 `Agent Project`
- 一个 `Agent Project` 绑定一张唯一的 `agent-flow-graph`
- 组装页改动会真实影响运行时
- 编排页编辑的是这同一个项目的行为蓝图

## 最近一轮重心变化

最近提交反映了三条并行演进的主线：

**Flow 主线**（持续迭代）：
- `61d669c`~`bc757da`: flow-workspace 工作空间重构、Assembly 增强、Feature mode 编排、提示词编辑器等

**IM 线路与门户代理**（新增主线）：
- `b11ac0e`~`4d203ae`: 多 IM 渠道支持、线路管理与动态路由、IMOperatorFeature 接线员工具、开机自启配置
- `qqbot` 已从经典样例转型为 IM 门户代理，承载 QQ/微信线路管理

**调度与运行时系统**（新增主线）：
- `4218f78`~`b131a94`: 调度台、ClawDispatchFeature、定时消息调度、CallArbiter 调用仲裁、RuntimeCallEnvelope 信封系统
- 新增 `dispatch-console` 预制 agent

**会话与前端增强**：
- 会话分支创建、会话精简（trim/compact）、AI 生成标题、模型预设管理
- 侧边栏重构、输入队列与中断、workspace host 适配

因此，理解项目时 `flow-workspace` 仍是核心产品主线，但 `qqbot`（IM 门户）和 `dispatch-console`（调度控制台）已成为同等重要的并行主线。

## 启动方式

```bash
npm install
npm start
```

默认端口：

- Web UI: `http://127.0.0.1:1420`
- ViewerWorker: `http://127.0.0.1:2026`

常见环境变量：

- `PORT`: Web UI 端口，默认 `1420`
- `AGENTDEV_VIEWER_PORT`: ViewerWorker 端口，默认 `2026`
- `AGENTDEV_UDS_PATH`: ViewerWorker UDS / named pipe
- `AGENTDEV_DEBUG_TRANSPORT`: 预制 runtime 启动时使用 `viewer-worker`

## 仓库边界与依赖来源

这一节非常重要。后续 agent 如果不先读清这里，最容易出现“改错仓库、改了安装产物、把 feature 来源搞混”的问题。

### 1. 两个仓库的角色

- [D:\code\AgentDevClaw](D:/code/AgentDevClaw) 是产品壳层仓库。
  这里负责 Web UI、预制 agent、runtime 托管、ProtoClaw 服务端、以及对外消费 `agentdev` 与若干 feature 包。
- [D:\code\AgentDev](D:/code/AgentDev) 是 `agentdev` 框架仓库。
  这里负责框架本体、ViewerWorker、DebugHub、核心通知系统，以及部分独立 feature 包源码。

### 2. `agentdev` 本体如何接入 Claw

- Claw 的 [package.json](/D:/code/AgentDevClaw/package.json) 里，`agentdev` 依赖是 `file:../AgentDev`。
- 因此 [node_modules/agentdev](/D:/code/AgentDevClaw/node_modules/agentdev) 在当前环境里是一个 `junction`，直接指向 [D:\code\AgentDev](D:/code/AgentDev)。
- 结论：
  任何“框架本体”改动都必须在 [D:\code\AgentDev](D:/code/AgentDev) 的源码里改。
  不能把修复只留在 Claw 侧的 `node_modules/agentdev/dist`。
  正确流程是：改 [D:\code\AgentDev](D:/code/AgentDev) 源码，然后在那边重建 `dist`，再让 Claw 侧消费同步后的结果。

### 3. feature 的三种来源必须严格区分

#### A. `AgentDev/packages/*` 中的源码 feature

这类 feature 的权威编辑位置在 [D:\code\AgentDev\packages](D:/code/AgentDev/packages)。

当前至少包括：

- [D:\code\AgentDev\packages\qqbot-feature](D:/code/AgentDev/packages/qqbot-feature)
- [D:\code\AgentDev\packages\weixin-bot](D:/code/AgentDev/packages/weixin-bot)
- 以及其他框架侧维护的 feature 包

规则：

- 如果问题属于这些 feature 的实现本身，要在对应 `packages/*` 源码目录里改。
- 改完后应在该源码包或框架侧完成构建，再由 Claw 消费结果。
- 不要直接把补丁只打在 Claw 侧安装出来的 `node_modules/@agentdev/*` 上。

#### B. Claw 仓库直接依赖的 tgz feature 包

Claw 的 [package.json](/D:/code/AgentDevClaw/package.json) 里有多项依赖来自：

- [resources/features](/D:/code/AgentDevClaw/resources/features)

例如：

- `@agentdev/qqbot-feature`
- `@agentdev/weixin-bot`
- `@agentdev/audit-feature`
- `@agentdev/websearch-feature`

这些 tgz 包在 Claw 仓库里承担“可直接安装、可直接发布消费”的角色。

当前还要额外注意一层现实情况：

- Claw 运行时确实会真实加载这些 tgz 包，它们不是“只放在仓库里但没用上”的摆设。
- 但某些预制 agent 的最终行为，不一定完全等于 tgz 包内部的默认实现。
- 例如 `qqbot-feature` / `weixin-bot` 当前在 Claw 中是“tgz 包作为底座 + Claw 项目层运行时包装”的组合关系。
- 典型位置见 [prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)：这里会在创建 `QQBotFeature` / `WeixinBot` 实例后，再补一层项目侧接线，例如把消息入口重新导向 Claw 当前的 runtime 协调逻辑。
- 因此，不要简单把“当前 Claw 表现出来的行为”直接等同于“tgz 包本体已经升级到相同行为”。
- 更准确地说，当前可接受的事实是：
  Claw 已经真实引用这些 tgz 包；
  同时，Claw 也可能在项目层对它们做运行时包装、覆写或补接线；
  所以最终运行效果可能是“tgz 底座 + 项目层适配”共同产生的。

规则：

- Claw 侧可以继续依赖 tgz 包。
- 但凡进入 Claw 仓库并被当作内建依赖使用的 feature，应该具有直接面向发布的形态。
- 同时，这些 feature 如果属于框架侧维护资产，必须在 [D:\code\AgentDev\packages](D:/code/AgentDev/packages) 或等价源码目录中留存一份源码版本，不能只剩 tgz 和安装产物。
- 如果你要判断“某个行为到底是 tgz 包原生提供的，还是 Claw 项目层后包了一层才得到的”，不要只看 `resources/features/*.tgz`，还要一起检查对应预制 agent 的装配入口。

#### C. Claw 仓库自己的本地 feature 与 feature 仓库内容

这类内容不是 `agentdev` npm 依赖包本身，要和上面两类区分开。

1. Claw 自带本地 feature

- [local-features](/D:/code/AgentDevClaw/local-features)

例如：

- [local-features/flow/src/index.ts](/D:/code/AgentDevClaw/local-features/flow/src/index.ts)
- [local-features/feature-dev/src/index.ts](/D:/code/AgentDevClaw/local-features/feature-dev/src/index.ts)

这类 feature 属于 Claw 项目自身实现，权威修改点就在 Claw 仓库。

2. feature 仓库 / 用户仓库 / 导入仓库内容

- [resources/features](/D:/code/AgentDevClaw/resources/features) 中的发布包集合
- 用户工作区、导入结果、Feature Repository UI 中展示的可安装 feature

这类内容更多是“被管理、被分发、被装配”的对象，不等同于当前 Claw 运行时直接维护的源码包。

#### D. 同一 feature 的双路径问题（高频踩坑点）

**这是一个容易被忽略、但已经真实踩过多次坑的问题。**

许多 feature 同时存在于 AgentDev 仓库的两个位置：

| 位置 | 说明 | 被 Claw 消费方式 |
|------|------|-----------------|
| `AgentDev/packages/<name>-feature/` | 独立 npm 包源码，`npm pack` 后成为 tgz | `@agentdev/<name>-feature`（从 Claw 的 `resources/features/*.tgz` 安装） |
| `AgentDev/src/features/<name>/` | 框架内部副本，被 tsup bundle 进框架 dist | `agentdev`（通过 junction 直接消费 `AgentDev/dist`） |

当前已知存在双路径的 feature：

- `shell`：`packages/shell-feature/` + `src/features/shell/`
- `audit`：`packages/audit-feature/` + `src/features/audit/`
- `audio-feedback`：`packages/audio-feedback-feature/` + `src/features/audio-feedback/`
- `memory`：`packages/memory-feature/` + `src/features/memory/`
- `qqbot`：`packages/qqbot-feature/` + `src/features/qqbot/`
- `tts`：`packages/tts-feature/` + `src/features/tts/`
- `visual`：`packages/visual-feature/` + `src/features/visual/`
- `websearch`：`packages/websearch-feature/` + `src/features/websearch/`
- `plugin-compat`：`packages/plugin-compat-feature/` + `src/features/plugin-compat/`

**踩坑场景**：你修改了 `packages/shell-feature/src/tools.ts`，在 package 侧构建成功，以为已经搞定。但实际上：

- `agent-creator` 和 `feature-creator` 通过 `import { ShellFeature } from 'agentdev'` 消费的是 **框架 dist** 中的 bundle，不经过 tgz
- `qqbot` 和 `programming-helper` 通过 `import { ShellFeature } from '@agentdev/shell-feature'` 消费的是 **Claw 安装的 tgz 包**，不经过框架 dist

因此修改这类 feature 时，**两侧源码都要改，两个构建都要做，两条消费路径都要更新**。

#### E. Claw 预制 agent 的 feature 消费路径速查

| 预制 agent | 从 `agentdev` 导入（走框架 dist） | 从 `@agentdev/*` 导入（走 tgz 包） |
|-----------|--------------------------------|----------------------------------|
| `qqbot` | BasicAgent, TemplateComposer, TodoFeature | QQBotFeature, WeixinBot, ShellFeature, WebSearchFeature |
| `programming-helper` | BasicAgent, TemplateComposer, TodoFeature, UserInputFeature, LspFeature | AudioFeedbackFeature, AuditFeature, MemoryFeature, ShellFeature, WebSearchFeature |
| `agent-creator` | BasicAgent, **ShellFeature**, TemplateComposer, TodoFeature, UserInputFeature | AuditFeature, WebSearchFeature |
| `feature-creator` | BasicAgent, **ShellFeature**, TemplateComposer, TodoFeature, UserInputFeature | AuditFeature, WebSearchFeature |
| `flow-workspace` | BasicAgent, TemplateComposer, UserInputFeature, createLLM | （无） |
| `flow-test` | BasicAgent, createTool, UserInputFeature | （无） |

注意 `ShellFeature` 同时出现在两条路径中：`agent-creator` / `feature-creator` 从框架导入，`qqbot` / `programming-helper` 从 tgz 包导入。

### 4. 预制 agent 与 feature 实现不要混为一谈

例如 [prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)：

- 它是 Claw 侧的预制 agent 定义与装配入口。
- 它负责把 `QQBotFeature`、`WeixinBot`、`TodoFeature`、`IMOperatorFeature` 等挂到 agent 上。
- 但它不是这些 feature 的实现源码归属地。

判断规则：

- 如果问题是“这个 agent 怎么组合 feature、怎么选线路、怎么启动 gateway”，看 Claw 预制 agent。
- 如果问题是“QQ/微信 feature 本身的行为、协议、网关循环、消息处理有 bug”，看 feature 源码包。
- 如果问题是“通知、DebugHub、ViewerWorker、Agent 生命周期、框架级 call 状态”有 bug，看 `AgentDev` 框架本体。

### 5. 禁止的做法

- 不要把框架修复只留在 Claw 侧的 `node_modules/agentdev/dist`。
- 不要把 feature 修复只留在 Claw 侧的 `node_modules/@agentdev/*`。
- 不要因为 Claw 当前能跑起来，就把安装产物误当成权威源码。
- 不要混淆“Claw 自带本地 feature”“Claw 依赖的 tgz feature”“AgentDev/packages 下的 feature 源码”“feature 仓库里的可安装 feature”这四层。
- **不要只改了 `packages/*` 就以为全部搞定**——如果该 feature 在 `src/features/*` 也有副本（双路径），走框架导入的 agent 仍会消费旧代码。
- **不要只构建了 framework dist 就以为 tgz 也更新了**——tgz 包是独立打包的，需要单独 `npm pack` 并同步到 Claw。

### 6. 推荐修改流程

1. 先判断问题属于哪一层：
   框架本体 / 框架侧源码 feature / Claw 本地 feature / Claw 预制 agent 装配 / Claw 消费的 tgz 包。
2. **如果是双路径 feature（见上方 3D 节），两侧源码都要改。**
3. 在权威源码位置修改。
4. 在对应仓库完成构建或打包（具体步骤见下方 7 节）。
5. 再回到 Claw 验证消费结果。
6. 如果 Claw 侧只是消费方，避免在消费层留下无法回溯到源码的临时补丁。

### 7. feature 构建与 tgz 更新标准流程

不同来源的 feature 有不同的构建和消费更新路径。以下是每种情况的具体操作步骤。

#### 情况 A：只走框架路径的 feature（仅存在于 `src/features/*`）

例如：`lsp`、`todo`、`user-input`、`skill`、`subagent`、`mcp`、`file-history` 等。

```bash
# 1. 修改 AgentDev/src/features/<name>/ 下的源码
# 2. 构建框架 dist
cd D:/code/AgentDev && npm run build
# 3. 重启 Claw 服务（junction 生效）
```

无需 tgz 操作。Claw 通过 `node_modules/agentdev` junction 直接消费 `AgentDev/dist`。

#### 情况 B：只走 tgz 路径的 feature（仅存在于 `packages/*`，无框架副本）

例如：`weixin-bot`、`create-feature`。

```bash
# 1. 修改 AgentDev/packages/<name>/ 下的源码
# 2. 构建 package dist
cd D:/code/AgentDev/packages/<name> && npm run build
# 3. 打包 tgz
npm pack
# 4. 复制到 Claw resources（注意替换旧文件）
cp <name>-<version>.tgz D:/code/AgentDevClaw/resources/features/
# 5. 更新 Claw 中安装的包（见下方"tgz 安装注意"）
# 6. 重启对应 agent
```

#### 情况 C：双路径 feature（同时存在于 `packages/*` 和 `src/features/*`）

例如：`shell`、`audit`、`qqbot`、`websearch` 等（完整列表见 3D 节）。

```bash
# 1. 修改 packages/<name>-feature/src/ 下的源码
# 2. 同步修改到 src/features/<name>/（import 路径可能不同，注意适配）
# 3. 构建 package dist
cd D:/code/AgentDev/packages/<name>-feature && npm run build
# 4. 打包并复制 tgz 到 Claw
npm pack
cp <name>-<version>.tgz D:/code/AgentDevClaw/resources/features/
# 5. 构建 framework dist
cd D:/code/AgentDev && npm run build
# 6. 更新 Claw 中安装的 tgz 包（见下方"tgz 安装注意"）
# 7. 重启整个 Claw 服务（框架 dist 变更需要完整重启）
```

#### tgz 安装注意：integrity hash 问题

当 tgz 文件内容变更但文件名不变时（版本号未升级），npm 会因为 `package-lock.json` 中记录的旧 integrity hash 不匹配而拒绝安装，报 `EINTEGRITY` 错误。`npm install --force` 也无法绕过此检查。

正确处理方式：

```bash
# 方案 1（推荐）：用新 tgz 重新计算 hash 并更新 lock
cd D:/code/AgentDevClaw
# 获取新 tgz 的 hash
npm cache verify  # 或直接看 npm install 报错信息中 "got" 后面的值
# 编辑 package-lock.json，找到对应包的 "integrity" 字段，替换为新 hash
# 然后清理安装
rm -rf node_modules/@agentdev/<name>
npm install

# 方案 2：直接删掉 lock 中的 integrity 字段，让 npm 重新计算
# 编辑 package-lock.json，删除对应包条目的 "integrity" 行
# 然后 npm install 会重新计算并填充
```

验证安装结果：

```bash
# 确认 node_modules 中已包含新代码（用 Claw 内置的 grep 工具，不要用 bash grep）
# bash grep 在 Windows 上可能因编码问题给出假阴性
```

## 系统总览

### 1. 服务端

入口文件：[server.js](/D:/code/AgentDevClaw/server.js)

职责：

- 启动并托管 `ViewerWorker`
- 扫描 `prebuilt-agents/`
- 管理预制 agent runtime 与会话切换
- 代理前端到 ViewerWorker 的 API / 模板 / tools / chunk 请求
- 提供 `ProtoClaw` 自己的工作空间、session、flow、assembly 管理接口
- IM 线路管理（线路绑定、转接、可路由目标查询、渠道配置）
- 调度系统（定时任务、调度轮询、调用信封与运行时状态）
- 模型预设管理与会话增强（分支、精简、AI 标题生成）
- IM 线路管理（线路绑定、转接、可路由目标查询、渠道配置）
- 调度系统（定时任务、调度轮询、调用信封与运行时状态）
- 模型预设管理与会话增强（分支、精简、AI 标题生成）

### 2. 前端壳层

壳层入口：[public/index.html](/D:/code/AgentDevClaw/public/index.html)

注意：`index.html` 现在只是瘦身后的页面壳，不再承载主要业务逻辑。主逻辑已拆到：

- [public/src/app-core.js](/D:/code/AgentDevClaw/public/src/app-core.js)
- [public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- [public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)

职责：

- 左侧 agent / workspace 列表
- 右侧主工作区、调试面板、功能面板壳层
- workspace surface 与 chat surface 的切换
- 预制 workspace block 渲染
- `flow-workspace` 的 detail / assembly / orchestrate 前端状态机

### 3. Flow 编辑器

核心文件：

- [public/flow-editor.js](/D:/code/AgentDevClaw/public/flow-editor.js)
- [public/flow-editor.css](/D:/code/AgentDevClaw/public/flow-editor.css)

职责：

- 编排图加载、保存、视图管理
- 工作流与节点 Inspector
- 节点工具权限编辑
- onEnter / exitWhen / 变量 / prompt 编辑
- Feature tools / variables / templates 能力消费

### 4. 预制 agent runtime

入口文件：[scripts/run-prebuilt-agent.js](/D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js)

职责：

- 动态加载 `prebuilt-agents/*/*/agent.js`
- 挂到本地 ViewerWorker
- 管理预制 agent 会话恢复
- 针对部分 agent 处理附加启动逻辑，例如 QQ gateway

### 5. 项目内本地 Feature

目录：[local-features](/D:/code/AgentDevClaw/local-features)

当前最重要的不是泛泛的“本地 TS Feature 支持”，而是：

- [local-features/flow/src/index.ts](/D:/code/AgentDevClaw/local-features/flow/src/index.ts) 是当前 Flow 运行时核心
- [local-features/feature-dev/src/index.ts](/D:/code/AgentDevClaw/local-features/feature-dev/src/index.ts) 服务于 `feature-creator`
- [local-features/dispatch/src/index.ts](/D:/code/AgentDevClaw/local-features/dispatch/src/index.ts) 是调度系统核心（ClawDispatchFeature、定时调度）

构建命令：

```bash
npm run build:local-features
```

## 当前主对象模型

### Agent Project

当前主对象是 Agent Project，而不是单条消息流。

典型字段包括：

- `assembly_name`
- `target_user`
- `goal`
- `constraints`
- `custom_system_prompt`
- `selected_features`
- `env_dir`
- 唯一绑定的 `agent-flow-graph`
- 该项目的测试运行会话

这些字段主要通过 `flow-workspace` 的 `assembly-form` 管理。

关键位置：

- 前端草稿与 UI：[public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- 提交、启动与会话处理：[public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
- runtime 读取：[prebuilt-agents/official/flow-workspace/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/flow-workspace/agent.js)

### Orchestration Graph

每个 Agent Project 绑定唯一一张图：

```text
~/.agentdev/AgentDevClaw/flows/<agentProjectId>/agent-flow-graph.json
```

当前 `<agentProjectId>` 主要来自 `assembly-form.assembly_name`。

图包含：

- `nodes`
- `edges`
- `workflows`
- `variables`
- `viewport`

### Workflow

Workflow 不是外部独立对象，而是图中的一个连通分量。

每个 Workflow 典型元数据包括：

- `id`
- `name`
- `description`
- `mode`: `auto` 或 `agent-initiated`
- `entry`
- `reminderFrequency`
- `variables`

一张图中最多只有一个 `auto` Workflow。

### Node

Node 是阶段上下文，当前支持的关键能力包括：

- `prompt`
- `tools.rules`
- `onEnter`
- `exitWhen`
- `reminderFrequency`
- `workflowId`
- `position`

当前产品方向上，Node 正在从“直接配底层工具”进一步走向“Feature mode + 高级 override”双层控制面。

## 当前产品主线：flow-workspace

### 为什么它是主线

`flow-workspace` 已经不只是一个预制 agent 首页，而是当前产品的一体化工作空间宿主。

定义位于：

- [prebuilt-agents/official/flow-workspace/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/flow-workspace/metadata.json)
- [prebuilt-agents/official/flow-workspace/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/flow-workspace/agent.js)

它当前承载：

- 项目列表
- 项目详情
- 组装编辑
- Feature 选择
- 运行环境目录管理
- 编排图编辑
- 装配会话恢复与运行测试

### 当前前端实现形态

`flow-workspace` 前端不是简单 block 列表，而是“通用壳 + 专项状态机”的混合架构：

- 通用 block 与 workspace 渲染：主要在 [public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- 运行与提交逻辑：主要在 [public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
- 专项前端状态机：`window.ClawFW`
- 编排页专项编辑器：[public/flow-editor.js](/D:/code/AgentDevClaw/public/flow-editor.js)

`ClawFW` 管理的典型状态：

- 项目列表 / 详情
- 当前 section：`features` / `config` / `orchestrate`
- prompt editor
- drift dialog
- feature capabilities cache

### 当前 runtime 形态

`flow-workspace` 有两种主要运行形态：

1. 工作空间模式：展示项目、组装与编排 UI
2. 装配会话模式：真实挂载用户选择的 Features + 当前项目配套编排图，进入调试对话

`agent.js` 里已经会：

- 读取当前 `assembly-form`
- 解析 `selected_features`
- 构造或刷新运行环境
- 加载当前项目的 `agent-flow-graph`
- 把图转换成运行时 flows
- 挂载 `FlowFeature`

## Flow 运行时

### 核心文件

- [local-features/flow/src/index.ts](/D:/code/AgentDevClaw/local-features/flow/src/index.ts)

### 当前定位

`FlowFeature` 是当前编排层运行时核心，不修改 AgentDev 主循环，而是通过 hook 驱动阶段行为。

关键能力：

- `@CallStart`
  - 缓存 agent / ToolRegistry
  - 收集变量
  - 自动激活 `auto` Workflow
  - 注入 Flow 状态
- `@StepStart`
  - 处理 pending transition
  - 处理 `exitWhen`
  - 执行 `onEnter`
  - 注入节点 prompt
  - 应用节点工具权限
- tools
  - `enter_flow`
  - `complete_node`
  - `exit_flow`
- state snapshot
  - 保存 / 恢复活跃 workflow、node、工具基线等状态

### ToolRegistry 关键事实

当前已验证：Flow 工具权限要从 `ctx.agent.tools` 拿 `ToolRegistry`，不能只假设存在 `getToolRegistry()`。

这点是历史上真实踩过坑的地方，后续如果再改 Flow runtime，务必先确认这一层没有退化。

## Feature 与 Flow 的当前关系

### 当前已落地

当前 `flow_capabilities` 已经能从当前项目启用的 Feature 中收集：

- features
- tools
- variables
- node templates

服务端接口：

- `GET /protoclaw/flow_capabilities?agentId=...`

相关聚合逻辑在 [server.js](/D:/code/AgentDevClaw/server.js)。

### 当前演进方向

下一阶段的重要方向不是继续把所有复杂度都暴露成底层 tools，而是：

- 默认主路径：Feature mode 编排
- 高级层：显式展开的 tool overrides

设计文档见：

- [docs/flow-feature-mode-dual-surface-design-plan.md](/D:/code/AgentDevClaw/docs/flow-feature-mode-dual-surface-design-plan.md)

当前代码已经开始朝这个方向前进，但尚未完全落地，因此写实现时不要默认“文档中的 mode contract 已全部完成”。

## 关键数据流

### 1. Agent Project -> 运行时装配

主链路：

1. 用户在 `flow-workspace` 编辑 `assembly-form`
2. 前端草稿保存在 workspace draft / state
3. 启动或恢复装配会话时，前端把配置提交给服务端
4. 服务端确保 `env_dir`、会话索引与持久状态一致
5. `flow-workspace` runtime 读取 `assembly-form`
6. 根据 `selected_features` 实例化 Feature
7. 读取图并挂载 `FlowFeature`
8. 进入调试对话

关键字段：

- `selected_features`
- `custom_system_prompt`
- `assembly_name`
- `env_dir`

### 2. Agent Project -> Flow 编辑器

主链路：

1. 前端进入 `orchestrate`
2. `flow-editor.js` 根据当前 `assembly-form` 解析 projectId
3. 请求 `GET /protoclaw/flow_graphs?agentId=<projectId>`
4. 请求 `GET /protoclaw/flow_capabilities?agentId=flow-workspace` 获取已启用 Feature 的能力
5. 在编辑器中渲染 workflows / nodes / inspector
6. 保存时通过 `PUT /protoclaw/flow_graph/<graphId>` 回写

### 3. Feature 能力 -> 编排可见性

主链路：

1. 组装页修改 `selected_features`
2. 服务端聚合当前项目可用 Feature 能力
3. Flow 编辑器消费 capabilities
4. 用户在 Inspector 中选择 tools / variables / templates

因此，如果你看到“编辑器里能力不对”，首先要检查的不是 UI，而是：

- 当前项目的 `selected_features`
- `flow_capabilities` 返回是否正确
- 运行环境是否真的装上了对应 Feature

## 前端结构现状

### index.html 已经瘦身

`[public/index.html](/D:/code/AgentDevClaw/public/index.html)` 现在主要只保留：

- HTML 壳
- 第三方资源引用
- `flow-editor.js`
- `app-core.js`
- `app-ui.js`
- `app-main.js`

不要再把它当成主要业务脚本文件。

### 三个前端脚本的大致分工

- [public/src/app-core.js](/D:/code/AgentDevClaw/public/src/app-core.js)
  - 基础常量、i18n、fetch/invoke、公共 DOM 引用、初始化底座
  - `getRuntimeContextKey()`、optimistic runtime cache (`_agentRuntimeCache`)、session input cache
- [public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
  - workspace surface 渲染、block 渲染
  - `flow-workspace` 的 UI 逻辑
  - IM 渠道配置面板、调度控制台 UI、模型预设管理 UI
  - `renderCurrentMainView()`、`renderWorkspaceSurface()` 等核心入口
  - 注意：此文件已膨胀至 ~9700 行，后续需要模块化拆分
- [public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
  - agent 加载、轮询、session / runtime 切换
  - `switchAgent()`、`loadAgentData()`、`poll()` 核心循环
  - `render(messages)` 聊天消息渲染（含 `_lastRenderedChatSig` 去重）
  - assembly 启动、恢复、提交、环境处理
  - 输入队列与中断处理、会话分支与精简
  - 注意：此文件已膨胀至 ~6600 行，后续需要模块化拆分

### 一个重要经验

`renderCurrentMainView()` 是主视图状态机入口，很多 workspace 问题最终都会回到这里。

但像 Flow 编辑器这种重交互区域，不能简单把所有问题都归结为外层渲染；要先分清楚问题来自：

- 壳层 workspace 替换
- `flow-editor.js` 自己的局部重绘

这是最近真实修过的一类问题。

## 预制 agent 与 workspace 首页模型

预制 agent 的 `metadata.json` 仍然支持 `ui` 声明和 block 渲染，这条线没有消失。

仍然常见的 block / 入口概念包括：

- `ui.entry`
- `ui.tabs`
- `ui.home.blocks`

但要注意主次：

- 这套机制仍是基础壳能力
- 它已经不是最值得优先理解的产品主线
- 当前复杂工作主要集中在 `flow-workspace`

## 预制 agent 会话模型

### 当前实现

预制 agent 会话当前采用多 session 模型：

- 新对话创建新 session
- 可以恢复历史 session
- 当前激活 session 由服务端显式维护
- 会话切换会等待目标 runtime `READY`
- 会话分支创建（`POST /protoclaw/sessions/branch`）
- 会话精简与上下文压缩（trim preview、compact resume、summary export）
- AI 生成标题（`POST /protoclaw/generate_session_title`，通过 `scripts/run-title-mirror.js` 执行）

### 存储位置

预制 agent 会话数据位于用户目录：

```text
%USERPROFILE%\.agentdev\AgentDevClaw\prebuilt-sessions\<agentId>
```

Flow 工作空间自己的 workspace / session / flow 数据也优先落在用户目录下，不污染仓库。

## 仍然重要的次级样例

### QQBot（IM 门户代理）

定义位于：

- [prebuilt-agents/official/qqbot/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/metadata.json)
- [prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)

`qqbot` 已从经典样例转型为 **IM 门户代理**，是当前 IM 线路管理的主入口。

核心能力：
- 多 IM 渠道管理（QQ/微信），通过 `QQBotFeature` 和 `WeixinBot` 驱动网关
- `IMOperatorFeature` 提供接线员工具：`im_overview`、`im_browse`、`im_connect_line`、`im_disconnect_line`
- 线路到工作空间会话的动态路由与转接
- `CallArbiter` 调用仲裁，统一管理并发调用
- 开机自启动配置与 IM 渠道配置面板

配置文件：
- [.agentdev/qqbot.config.json](/D:/code/AgentDevClaw/.agentdev/qqbot.config.json)
- [.agentdev/weixin-bot.config.json](/D:/code/AgentDevClaw/.agentdev/weixin-bot.config.json)
- [.agentdev/im-workspace.config.json](/D:/code/AgentDevClaw/.agentdev/im-workspace.config.json)

### Feature Creator

定义位于：

- [prebuilt-agents/official/feature-creator/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/feature-creator/agent.js)
- [local-features/feature-dev/src/index.ts](/D:/code/AgentDevClaw/local-features/feature-dev/src/index.ts)

它仍然是本地 Feature 驱动 workspace 的代表性样例，尤其适合理解：

- workspace state 注入 prompt
- `cwd` 与工作目录绑定
- 本地 skills / local feature 的协作方式

### Dispatch Console（调度控制台）

定义位于：

- [prebuilt-agents/official/dispatch-console/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/dispatch-console/metadata.json)
- 调度核心：[local-features/dispatch/src/index.ts](/D:/code/AgentDevClaw/local-features/dispatch/src/index.ts)

调度控制台提供定时任务管理、调度触发、调用信封查看等能力。配套服务端接口在 `server.js` 的 `dispatch/*` 路由组。

### Programming Helper（编程助手）

定义位于：

- [prebuilt-agents/official/programming-helper/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/programming-helper/metadata.json)

编程助手集成调度能力，支持项目选择与定时调度任务绑定。

## 关键 ProtoClaw 接口

基础接口：

- `GET /protoclaw/health`
- `GET /protoclaw/get_prebuilt_agents`
- `GET /protoclaw/get_agents_status`
- `GET /protoclaw/get_connected_agents`
- `POST /protoclaw/start_agent`
- `POST /protoclaw/stop_agent`

预制 session 相关：

- `GET /protoclaw/prebuilt_sessions?agentId=...`
- `POST /protoclaw/prebuilt_sessions`
- `POST /protoclaw/prebuilt_sessions/activate`

Flow / workspace 主线相关：

- `GET /protoclaw/flow_graphs`
- `PUT /protoclaw/flow_graph/:id`
- `GET /protoclaw/flow_capabilities`

IM 线路管理相关：

- `GET /protoclaw/im_workspace_bundle`
- `PUT /protoclaw/im_workspace_bundle`
- `GET /protoclaw/im_line_binding`
- `POST /protoclaw/im_line_transfer`
- `POST /protoclaw/im_line_disconnect`
- `GET /protoclaw/im_routable_targets`
- `POST /protoclaw/im_workspace_bundle/weixin_bind/start`
- `GET /protoclaw/im_workspace_bundle/weixin_bind/status`
- `POST /protoclaw/im_workspace_bundle/weixin_logout`

调度系统相关：

- `GET /protoclaw/dispatch/projects`
- `GET /protoclaw/dispatch/schedules`
- `POST /protoclaw/dispatch/schedules`
- `DELETE /protoclaw/dispatch/schedules/:id`
- `GET /protoclaw/dispatch/poll`
- `POST /protoclaw/dispatch/respond`
- `POST /protoclaw/dispatch/agent_status`

运行时信封与状态：

- `GET /protoclaw/runtime/inbox`
- `GET /protoclaw/runtime/execution_state`
- `GET /protoclaw/runtime/execution_states`
- `GET /protoclaw/runtime/envelope`
- `GET /protoclaw/runtime/envelopes_by_source`

会话增强相关：

- `POST /protoclaw/sessions/branch`
- `GET /protoclaw/session_trim_preview`
- `POST /protoclaw/generate_session_title`
- `GET /protoclaw/session_summary`
- `POST /protoclaw/session_generate_summary`
- `POST /protoclaw/context_handoffs/export`
- `POST /protoclaw/context_handoffs/compacted_resume`

模型配置：

- `GET /protoclaw/model_config`
- `PUT /protoclaw/model_config`
- `PUT /protoclaw/agent_model_presets`

如果任务涉及编排能力、Feature 列表、运行环境或项目恢复，优先先看 `flow_*` 和 assembly 相关链路，不要只盯基础 agent 接口。

## 资源与依赖

### AgentDev 依赖

当前依赖本地 AgentDev 仓库：

`agentdev: file:../AgentDev`

这意味着：

- 当前项目默认与本地 `D:\code\AgentDev` 联动开发
- 修改框架后常常需要重新安装 / 重启当前项目
- 任何“这是 Claw 问题还是 AgentDev 问题”的判断，都要考虑两个仓库一起看

### Feature 包资源

内置 feature 包目录：

- [resources/features](/D:/code/AgentDevClaw/resources/features)

它们既是产品资源，也是 `flow-workspace` 当前装配路径的重要输入。

## 当前已知边界

这些边界不是遗漏，而是当前阶段的真实状态：

- `flow-workspace` 是核心工作空间，但还不是完整的多 runtime workspace 编排器
- 一张图里虽然可以有多个 Workflow，但当前运行时核心仍围绕单活跃 workflow 状态管理
- Feature mode 双层控制面是明确方向，但不是所有 contract 都已落地
- `onEnter` 目前仍有 tool-call 兼容语义，尚未完全升级为正式 workflow functions
- block 壳层仍存在，但主复杂度已转移到 Flow 主线
- `app-ui.js`（~9700 行）和 `app-main.js`（~6600 行）极度膨胀，是当前技术债最大的风险点
  - 完整拆分计划：[docs/plans/2026-06-04-frontend-split-plan.md](/D:/code/AgentDevClaw/docs/plans/2026-06-04-frontend-split-plan.md)
  - 包含：功能域划分（11域）、耦合地图、分 3 Phase 拆分顺序、风险缓解策略

## 测试体系

### 命令

```bash
npm test              # 运行全部测试（core + features）
npm run test:core     # 只跑 test/*.test.js（无需构建）
npm run test:features # 只跑 local-features 的 smoke test（需要先构建 dist）
```

### 测试文件结构

```
test/                                          ← 服务端核心逻辑测试
  call-arbiter.test.js                         ← CallArbiter 调用仲裁（序列化、队列、事件）
  runtime-call-envelope.test.js                ← 运行时信封（创建、入队、出队、状态查询）
  session-model-meta.test.js                   ← 会话模型元数据（持久化优先级、回退逻辑、sessionType 映射）

local-features/                                ← 本地 Feature 功能测试
  flow/test/flow-feature.test.ts               ← FlowFeature（节点转换、prompt 注入、分支边）
  context-compaction-mirror/test/smoke.test.ts ← ContextCompactionMirror（工具禁用、状态）
```

### 两种测试格式

1. **`test/*.test.js`** — 使用 `node:test` 的 `describe/it/assert` 格式，由 `node --test` 驱动，输出 TAP 协议。**新增服务端逻辑测试放这里。**

2. **`local-features/*/test/*.test.ts`** — 自执行 `main().catch(...)` 格式，用 `process.exitCode = 1` 标记失败，输出 `[PASS]`/`[FAIL]`。编译后产物在 `local-features/dist/*/test/`。**新增 feature 功能测试放对应 feature 的 `test/` 目录下。**

### 何时跑测试

- 修改 `server.js`、`server/` 目录、`scripts/` 目录中的逻辑后 → `npm run test:core`
- 修改 `local-features/` 下的 TS 源码后 → 先 `npm run build:local-features`，再 `npm run test:features`
- 提交前、合并前 → `npm test` 确保全绿

### 新增测试的约定

- 服务端纯逻辑（server.js 中的决策函数、工具函数）→ 新建 `test/xxx.test.js`，用 `node:test` 格式
- local-feature 功能 → 新建 `local-features/<name>/test/xxx.test.ts`，用自执行 `main()` 格式
- local-feature 测试需要在 `local-features/tsconfig.json` 的 `include` 中添加路径才能被编译
- local-feature 测试的产物路径需加入 `package.json` 的 `test:features` 脚本
- 前端 JS 目前无自动化测试（需要浏览器环境）

### 重要注意事项

- local-features 测试依赖编译产物，必须先 `npm run build:local-features`
- `test:features` 脚本中的每个测试用 `&&` 链接，任何一个失败会终止后续测试并返回非零 exit code
- 测试代码中 inline 复刻的 server.js 逻辑（如 `session-model-meta.test.js` 中的 `resolveSessionModel`）需要在 server.js 对应逻辑变更时同步更新

---

## 开发时的建议心智

进入实际开发前，优先先回答这 8 个问题：

1. 这次改的是壳层、`flow-workspace`、`flow-editor`，还是 `FlowFeature` runtime？
2. 问题属于项目配置、运行时装配、编排图数据，还是调试 UI？
3. 当前数据的真相在前端草稿、服务端 workspace state、session index，还是 `agent-flow-graph.json`？
4. 当前能力来自静态 block、`ClawFW` 前端状态机，还是 `flow_capabilities` 动态聚合？
5. 当前行为是预制 agent 首页行为，还是装配运行时行为？
6. 这是当前已实现能力的 bug，还是文档中"下一阶段设计"尚未落地导致的预期偏差？
7. **用户看到的是哪个前端管线？** 如果涉及面板显示、inspector 渲染，先确认该面板是 Claw 前端（`app-ui.js`，端口 1420）还是 DebugHub 查看器（`viewer-html.ts`，端口 2026）渲染的。改错管线 = 白改。
8. **stale check 依赖的全局变量在 `await` 期间会变吗？** `allAgents`、`currentAgentId` 等全局状态会被 poll / `loadAgents()` 异步修改。在 `await fetch()` 前后比较基于这些变量计算的值（如 `getRuntimeContextKey`）会产生虚假判定。stale check 只能用同步设置的 `currentRuntimeAgentId`。

把这 8 个问题先想清楚，通常就能避免在错误层面下手。

## 跨项目上下文索引

[docs/dev-context-index.md](/D:/code/AgentDevClaw/docs/dev-context-index.md) 记录了 AgentDev 框架与 AgentDevClaw 产品之间的关键连接关系、文件速查表、核心数据流和已知改进方向。需要跨仓库联动排查时，优先阅读它。

## 两套前端渲染管线（重要）

用户日常使用的 Web UI 运行在端口 1420，有一个**独立于框架**的前端渲染管线。框架侧也有自己的 DebugHub 查看器（端口 2026）。这两套系统的渲染代码完全不同，改错地方会导致"代码明明对了但用户看不到效果"。

### 端口 1420：Claw 主前端（用户看到的）

| 文件 | 职责 |
|------|------|
| `public/src/app-core.js` | i18n、基础常量、公共函数 |
| `public/src/app-ui.js` | Feature 面板渲染（`renderFeaturesPanel`）、workspace surface、面板状态管理 |
| `public/src/app-main.js` | 轮询、数据获取、`normalizeHookInspector`、`setCurrentHookInspector` |
| `public/styles/layout.css` | 所有面板样式（包括 `.feature-badge.status-*` 系列） |

这些文件是静态 JS/CSS，由 server.js 直接 serve，**不需要编译**。修改后重启 Claw 服务即可生效。

### 端口 2026：DebugHub Viewer（框架侧）

| 文件 | 职责 |
|------|------|
| `AgentDev/src/core/viewer-html.ts` | DebugHub 查看器的完整 HTML/JS/CSS 生成 |
| `AgentDev/src/core/viewer-worker.ts` | ViewerWorker HTTP 服务、inspector 数据存储与 API |

修改这个管线需要在 AgentDev 侧 `npm run build` 后重启 Claw 服务。

### Inspector 数据流

```
Agent 进程: buildHookInspectorSnapshot()
  → IPC → ViewerWorker: 存储 hookInspector
  → API: GET /api/agents/:id/hooks
  → Claw 前端: app-main.js fetch → normalizeHookInspector() → currentHookInspector
  → app-ui.js: renderFeaturesPanel() 渲染
```

### 关键陷阱：normalizeHookInspector 丢字段

`normalizeHookInspector()` 函数**存在于两个地方**，作用是把 API 返回的 inspector snapshot 重构为前端使用的标准化对象。新增 inspector snapshot 字段时，**必须同时更新两处**，否则字段会在重构时被丢弃：

1. **Claw 前端**：`public/src/app-ui.js` — 影响**用户日常看到**的面板
2. **框架侧**：`AgentDev/src/core/viewer-html.ts` — 影响 DebugHub 查看器（端口 2026）

历史上真实踩过的坑：在框架 `agent.ts` 的 `buildHookInspectorSnapshot()` 中新增了 `standaloneTools` 字段，框架和 API 都正确返回了数据，但 `normalizeHookInspector()` 在重构时没有透传这个字段，导致前端始终看不到。

## 会话切换与异步渲染的关键约束

会话切换链路（`switchAgent` → `loadAgentData` → `poll`）的详细渲染契约、去重策略和自检清单见 [docs/frontend-rendering-patterns.md](/D:/code/AgentDevClaw/docs/frontend-rendering-patterns.md)。以下是最容易踩坑的两条不变量：

1. **`getRuntimeContextKey` 不是 stable 的**：它依赖 `allAgents`（由 `loadAgents()` 异步更新），在 `await` 前后会返回不同值。**不能用于 stale check**，只能用于 cache key（miss 无害）。stale check 只用 `currentRuntimeAgentId`。
2. **PUT 不阻塞渲染**：`switchAgent` 先设全局状态 + optimistic 渲染，PUT `/api/agents/current` 与 `loadAgentData` 并行。`loadAgentData` 所有 URL 用显式 `agentId`，不依赖服务端 "current" 状态。

## 进程架构与重启范围

Claw 启动后存在两类进程：

1. **server.js 主进程**（PID 固定）：包含 Express 服务 + ViewerWorker + DebugHub
2. **agent 子进程**（per-runtime）：由 server.js 通过 `spawn()` 创建，每个运行的 agent 一个

```
server.js 主进程
├── Express (port 1420) → serve 静态前端 + protoclaw API
├── ViewerWorker (port 2026) → DebugHub 查看器
└── agent 子进程 (spawn)
    └── run-prebuilt-agent.js → 动态 import agent.js
```

**重启 agent（通过 API 或 UI 重新启动）只重建子进程**，不会重新加载 server.js 主进程中的模块。因此：

- 修改 `prebuilt-agents/*/agent.js` → 重启 agent 即可生效
- 修改框架 dist（`AgentDev/dist/*`）→ **必须重启整个 Claw 服务**（server.js 才会重新 import）
- 修改 Claw 前端 JS/CSS → **必须重启整个 Claw 服务**（静态文件由 server.js serve）
- 修改 `local-features/dist/*` → 重启 agent 即可（子进程动态 import）

## 工具注册时序与同名覆盖

### Agent 生命周期中的工具注册顺序

```
1. new AgentClass()        → 构造函数：this.use(feature) 只存 Map
2. agent.onCall(input)     → 第一次调用时：
   a. ensureFeatureTools() → 遍历 features，调用 feature.getTools()，注册到 ToolRegistry
                             → pushInspectorSnapshot()  ← 初始 inspector 在此推送
                             → featureToolsReady = true
   b. onInitiate()         ← 仅首次 onCall 时执行
   c. _initialized = true
3. 后续 onCall             → ensureFeatureTools() 直接 return（已 ready）
```

### 同名工具覆盖（superseded）机制

`ToolRegistry` 内部用 `Map<string, Tool>` 存储，同名工具的 `register()` 会覆盖前值。被覆盖的旧条目保存在 `superseded` Map 中，通过 `getEntries()` 返回 `state: 'superseded'`。

**时序关键点**：如果需要在所有 feature 工具注册之后再注册一个统一工具（覆盖同名 feature 工具），不能放在构造函数中（会被 feature 工具覆盖），也不能放在 `onInitiate` 中（首次 `onCall` 才执行，初始 inspector 不包含）。正确做法是使用 `onFeatureToolsReady()` 虚方法，它在 `ensureFeatureTools()` 的 feature 循环结束后、`pushInspectorSnapshot()` 之前被调用。

### inspector 中的工具分类

`buildHookInspectorSnapshot()` 中，工具按 `source`（注册时传入的第二个参数）分类：

- source 在 `this.features.keys()` 中 → 归入对应 feature 的 tools 列表
- source 不在任何 feature name 中 → 归入 `standaloneTools`（游离工具）
- source 为 undefined → 用 `'__no_source__'` 作为 key，归入 standaloneTools

这意味着直接通过 `this.tools.register(tool, 'custom-source')` 注册的工具，只要 source 不等于任何 feature name，就会自动出现在 inspector 的 `standaloneTools` 中。
