# CLAUDE.md

本文件用于帮助新进入项目的 agent 快速建立"产品目标 -> 核心对象 -> 代码入口 -> 数据流 -> 当前边界"的连续认知，避免只看到零散页面或单个 feature 就误判项目重心。

## 先看这里

如果你刚进入项目，建议按下面顺序读：

1. 本文件
2. [docs/agentdev-claw-product-overview.md](/D:/code/AgentDevClaw/docs/agentdev-claw-product-overview.md)
3. [docs/dev-context-index.md](/D:/code/AgentDevClaw/docs/dev-context-index.md)

如果涉及前端 UI 渲染、workspace 切换、数据加载时序等问题，额外必读：

- [docs/frontend-rendering-patterns.md](/D:/code/AgentDevClaw/docs/frontend-rendering-patterns.md) — 前端渲染机制、去重策略、常见陷阱与自检清单

如果任务直接涉及实现，优先再看这些真实入口：

- 服务端入口：[server.js](/D:/code/AgentDevClaw/server.js)
- 前端壳层入口：[public/index.html](/D:/code/AgentDevClaw/public/index.html)
- 前端公共状态与基础能力：[public/src/app-core.js](/D:/code/AgentDevClaw/public/src/app-core.js)
- 前端 UI 与 workspace 渲染主逻辑：[public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
- 前端运行与轮询主逻辑：[public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
- 编程小助手预制 agent：[prebuilt-agents/official/programming-helper/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/programming-helper/agent.js)
- IM 门户代理：[prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)
- 群聊管理员工具集：[local-features/group-admin/src/index.ts](/D:/code/AgentDevClaw/local-features/group-admin/src/index.ts)
- 运行时信封：[server/runtime-call-envelope.js](/D:/code/AgentDevClaw/server/runtime-call-envelope.js)

## 当前项目定位

`AgentDevClaw` 是一个以 Agent 为中心的可扩展工作台架构，整合配置、会话、调度、协作等多重职责。

当前主要维护的工作空间（★）：

1. **编程小助手**（`programming-helper`）— 核心工作空间，对标 Claude Code 的 AI 编程 Agent，拥有完整的可视化交互层和强大的会话管理能力
2. **Agent Studio**（`agent-studio`）— 上游制造端：在对话中开发 Feature、装配目标 Agent，经隔离 Test Runtime 形成证据驱动的验证闭环（见「Agent 制造 → 消费链路」一节）
3. **IM 渠道**（`qqbot`）— IM 门户代理，支持 QQ/微信/企业微信/飞书的多渠道消息接入与路由
4. **工作群**（`work-group`，Beta）— 多 Agent 协作模式，以群聊形式指挥和协调多个 Agent
5. **Runtime 配置**（`feature-setup`）— 全局 Feature 参数配置面板

以下预制 agent 代码保留但已悬置，不再积极迭代：

- `flow-workspace`（Flow 工作空间）
- `feature-creator`（Feature 开发工具，能力已由 `agent-studio` 接替）
- `agent-creator`（Agent 装配工具，能力已由 `agent-studio` 接替）
- `dispatch-console`（调度台）

> 悬置 agent 的代码、路由和前端逻辑仍然存在于项目中，但产品重心已不在此。涉及这些区域时，以"读懂现有代码、不引入新复杂度"为原则。

## 启动方式（install → build → start 三段式）

```bash
npm install   # 物化全部 file: 依赖为 junction（开发态）/ 安装正式包（发布态）
npm run build # 一次完成当前形态下全部构建与链接修复（见下）
npm start     # 纯净启动（prestart 只做轻量校验）
```

`npm run build`（`scripts/build-all.mjs`）按**依赖形态**自动分流：

- **开发态**（`@agentdev/core` 为 `file:../AgentDev/packages/*`，node_modules 是 junction）：
  1. `check:agentdev` — 校验/修复全部 18 条 `@agentdev/*` 链接（4 框架包 + 14 生态包）；链接被 `npm install` 冲掉而相邻 `../AgentDev` 仓库构建可用时自动重建
  2. 框架仓库构建 — 若相邻 `../AgentDev` 存在，`npm run build`（其 build 统一为 `scripts/build-all.mjs`，一次产出全部 18 包 dist）
  3. `build:local-features` — 编译 `local-features/`
  4. `build:features` — 构建 `features/` 下被预制 agent 按源码路径引用的 feature 包（当前为 `force-continuation`、`tickets-build-flow`），其 dist 不入库
- **发布态**（`@agentdev/core` 为 semver，node_modules 是 npm 正式包自带 dist）：跳过 1/2，只做 3/4

`npm start` / `npm run dev` 的 prestart 只跑 `scripts/preflight.mjs`：开发态校验 18 条链接，发布态直接放行。真正的构建工作都在 `npm run build` 里。

默认端口：

- Web UI: `http://127.0.0.1:1420`
- ViewerWorker: `http://127.0.0.1:2026`

常见环境变量：

- `PORT`: Web UI 端口，默认 `1420`
- `AGENTDEV_VIEWER_PORT`: ViewerWorker 端口，默认 `2026`
- `AGENTDEV_UDS_PATH`: ViewerWorker UDS / named pipe
- `AGENTDEV_DEBUG_TRANSPORT`: 预制 runtime 启动时使用 `viewer-worker`

## 仓库边界与依赖来源

这一节非常重要。后续 agent 如果不先读清这里，最容易出现"改错仓库、改了安装产物、把 feature 来源搞混"的问题。

### 1. 两个仓库的角色

- [D:\code\AgentDevClaw](D:/code/AgentDevClaw) 是产品壳层仓库。
  这里负责 Web UI、预制 agent、runtime 托管、ProtoClaw 服务端、以及对外消费 `@agentdev/*` 框架包与若干 feature 包。
- [D:\code\AgentDev](D:/code/AgentDev) 是框架仓库（npm workspace monorepo）。
  这里负责框架本体（`packages/core|llm|viewer|mcp`）、ViewerWorker、DebugHub、核心通知系统，以及部分独立 feature 包源码。

### 2. `@agentdev/*` 框架包如何接入 Claw

- npm 上的旧单包 `agentdev` 已退役。Claw 的 [package.json](/D:/code/AgentDevClaw/package.json) 以四个框架包 `@agentdev/core` + `@agentdev/llm` + `@agentdev/viewer` + `@agentdev/mcp` 加 14 个生态包（`@agentdev/shell-feature`、`@agentdev/qqbot-feature` 等）声明依赖。
- 全部 18 个包尚未发布 npm，当前依赖形态为 `file:../AgentDev/packages/<name>`：`npm install` 会将其物化为 junction（Windows 实测为 Junction 链接），指向相邻框架仓库的包目录。
- 本机联动开发时，正常 `npm install` 即可建立链接；链接被冲掉或相邻仓库不在默认位置时，`npm run build` 会先自动校验/修复全部 18 条链接（`check:agentdev`），无需手动干预。仅当相邻仓库路径非常规时需要显式指定：`AGENTDEV_LOCAL_PATH=... npm run build` 或 `npm run agentdev:local <路径>`。
- 不要用 `npm link` 做这件事。`npm link` 会触发 npm 重新整理/prune 依赖树，可能把 Claw 运行时需要的顶层依赖移走；这里需要的是纯文件系统 junction。
- `npm run agentdev:published` 当前是占位命令：四包发版前不存在"切回发布版"路径；发版后应把 `file:` 依赖改为 semver 并重写该脚本。
- 结论：
  任何"框架本体"改动都必须在 [D:\code\AgentDev](D:/code/AgentDev) 的源码里改。
  不能把修复只留在 Claw 侧的 `node_modules/@agentdev/*/dist`。
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

#### B. Claw 依赖的生态 feature 包（源码在框架仓库，tgz 仅为发布产物）

Claw 的 [package.json](/D:/code/AgentDevClaw/package.json) 中 14 个生态包依赖（`@agentdev/qqbot-feature`、`@agentdev/weixin-bot`、`@agentdev/audit-feature`、`@agentdev/websearch-feature` 等）自 2026-08-21 起全部为 `file:../AgentDev/packages/<name>` junction，开发态直接消费框架仓库源码。

[resources/features](/D:/code/AgentDevClaw/resources/features) 下的 tgz **只是发布产物**（供 Feature Repository UI 与独立消费方安装），经 `npm run pack:features` 统一产出，不参与本机开发解析。

需要注意的一层现实情况：

- 某些预制 agent 的最终行为，不一定完全等于生态包内部的默认实现。
- 例如 `qqbot-feature` / `weixin-bot` 当前在 Claw 中是"生态包底座 + Claw 项目层运行时包装"的组合关系。
- 典型位置见 [prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)：这里会在创建 `QQBotFeature` / `WeixinBot` 实例后，再补一层项目侧接线，例如把消息入口重新导向 Claw 当前的 runtime 协调逻辑。
- 因此，不要简单把"当前 Claw 表现出来的行为"直接等同于"生态包本体已经升级到相同行为"。

规则：

- 生态包的权威源码在 [D:\code\AgentDev\packages](D:/code/AgentDev/packages)，修改在那里进行并构建。
- 如果你要判断"某个行为到底是生态包原生提供的，还是 Claw 项目层后包了一层才得到的"，要一起检查对应预制 agent 的装配入口。

#### C. Claw 仓库自己的本地 feature 与 feature 仓库内容

这类内容不是 `@agentdev/*` 框架包依赖本身，要和上面两类区分开。

1. Claw 自带本地 feature

- [local-features](/D:/code/AgentDevClaw/local-features)

当前活跃维护的本地 feature：

- [local-features/dispatch/src/index.ts](/D:/code/AgentDevClaw/local-features/dispatch/src/index.ts) — 调度系统核心
- [local-features/group-admin/src/index.ts](/D:/code/AgentDevClaw/local-features/group-admin/src/index.ts) — 群聊管理员工具集
- [local-features/checkpoint/src/index.ts](/D:/code/AgentDevClaw/local-features/checkpoint/src/index.ts) — 会话检查点
- [local-features/context-compaction-mirror/src/index.ts](/D:/code/AgentDevClaw/local-features/context-compaction-mirror/src/index.ts) — 上下文精简
- [local-features/continuity-participant/src/index.ts](/D:/code/AgentDevClaw/local-features/continuity-participant/src/index.ts) — 连续性参与方协议（框架 declareContinuity 薄封装，CONTINUITY_FIELD_KEY 读旧写新）
- [local-features/conversation-export/src/index.ts](/D:/code/AgentDevClaw/local-features/conversation-export/src/index.ts) — 对话导出
- [local-features/feature-wrappers/src/index.ts](/D:/code/AgentDevClaw/local-features/feature-wrappers/src/index.ts) — 基础包装层：框架 feature 的 Claw 协议薄包装（ControlledTodoFeature / ContinuityAwareOpencodeBasic），编程小助手与 official coder 共享
- [local-features/agent-studio/src/index.ts](/D:/code/AgentDevClaw/local-features/agent-studio/src/index.ts) — Agent Studio 控制面 feature（studio_* 工具集、Test Runtime 生命周期、结构化断言测试）

local-features 的基础层/应用层分层约定见 [local-features/README.md](/D:/code/AgentDevClaw/local-features/README.md)。

以下本地 feature 代码保留但已悬置：

- `local-features/flow/` — Flow 运行时核心
- `local-features/feature-dev/` — Feature Creator 后端

这类 feature 属于 Claw 项目自身实现，权威修改点就在 Claw 仓库。

2. feature 仓库 / 用户仓库 / 导入仓库内容

- [resources/features](/D:/code/AgentDevClaw/resources/features) 中的发布包集合
- 用户工作区、导入结果、Feature Repository UI 中展示的可安装 feature

这类内容更多是"被管理、被分发、被装配"的对象，不等同于当前 Claw 运行时直接维护的源码包。

#### D. 双路径问题（历史坑，已随四包拆分收敛）

**历史上这是高频踩坑点，2026-08-21 四包拆分后已结构性消除。**

旧形态下许多 feature 同时存在于 AgentDev 仓库的两个位置（`packages/<name>-feature/` 独立包 + `src/features/<name>/` 框架内部副本），修改时必须两侧同步。四包拆分提交（框架 `f5c19eb` 系列）已删除 `src/features/*` 中的生态包副本，当前每个生态 feature 的唯一权威源码在 `AgentDev/packages/<name>/`。

若发现代码仍从 `@agentdev/core` 导入 `ShellFeature` / `AuditFeature` 等生态包符号，属于待清理残留（悬置 agent 的旧引用可能存在），应改为从对应独立包导入。

#### E. Claw 预制 agent 的 feature 消费路径速查

| 预制 agent | 从 `@agentdev/core` 导入（走框架包） | 从 `@agentdev/llm` / `@agentdev/viewer` / 生态包导入 |
|-----------|--------------------------------|----------------------------------|
| `programming-helper` ★ | BasicAgent, TemplateComposer, TodoFeature, UserInputFeature, LspFeature | AudioFeedbackFeature, AuditFeature, MemoryFeature, ShellFeature, WebSearchFeature |
| `agent-studio` ★ | BasicAgent, ShellFeature, TemplateComposer, TodoFeature, UserInputFeature | AuditFeature, WebSearchFeature（AgentStudioFeature 从 `local-features/dist` 导入） |
| `qqbot` ★ | BasicAgent, TemplateComposer, TodoFeature | QQBotFeature, WeixinBot, ShellFeature, WebSearchFeature |
| `work-group` ★ | BasicAgent, TemplateComposer, TodoFeature | （按需装配） |
| `feature-setup` ★ | （纯 UI，无 Agent 进程） | （无） |
| `flow-workspace`（悬置） | BasicAgent, TemplateComposer, UserInputFeature | createLLM（从 `@agentdev/llm`） |
| `agent-creator`（悬置） | BasicAgent, ShellFeature, TemplateComposer, TodoFeature, UserInputFeature | AuditFeature, WebSearchFeature |
| `feature-creator`（悬置） | BasicAgent, ShellFeature, TemplateComposer, TodoFeature, UserInputFeature | AuditFeature, WebSearchFeature |

注意：悬置 agent 若仍从 core 包导入生态 feature 符号，属于双路径残留；活跃 agent 均从独立生态包导入。

### 4. 预制 agent 与 feature 实现不要混为一谈

例如 [prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)：

- 它是 Claw 侧的预制 agent 定义与装配入口。
- 它负责把 `QQBotFeature`、`WeixinBot`、`TodoFeature`、`IMOperatorFeature` 等挂到 agent 上。
- 但它不是这些 feature 的实现源码归属地。

判断规则：

- 如果问题是"这个 agent 怎么组合 feature、怎么选线路、怎么启动 gateway"，看 Claw 预制 agent。
- 如果问题是"QQ/微信 feature 本身的行为、协议、网关循环、消息处理有 bug"，看 feature 源码包。
- 如果问题是"通知、DebugHub、ViewerWorker、Agent 生命周期、框架级 call 状态"有 bug，看 `AgentDev` 框架本体。

### 5. 禁止的做法

- 不要把框架修复只留在 Claw 侧的 `node_modules/@agentdev/*/dist`。
- 不要把 feature 修复只留在 Claw 侧的 `node_modules/@agentdev/*`。
- 不要因为 Claw 当前能跑起来，就把安装产物误当成权威源码。
- 不要混淆"Claw 自带本地 feature""AgentDev/packages 下的生态 feature 源码""resources/features 发布 tgz""feature 仓库里的可安装 feature"这几层。
- **不要在开发流程中手工 pack/拷贝 tgz**——开发态全部走 junction；tgz 只经 `npm run pack:features` 在发布时产出。

### 6. 推荐修改流程

1. 先判断问题属于哪一层：
   框架本体 / 框架侧生态包 feature / Claw 本地 feature / Claw 预制 agent 装配。
2. 在权威源码位置修改（框架与生态包都在 `AgentDev/packages/`）。
3. 在对应包完成构建（具体步骤见下方 7 节）。
4. 重启 Claw 服务或对应 agent，回到 Claw 验证消费结果。
5. 如果 Claw 侧只是消费方，避免在消费层留下无法回溯到源码的临时补丁。

### 7. feature 构建与消费更新流程

**开发态（2026-08-21 起）：全部 18 个 `@agentdev/*` 依赖（4 框架包 + 14 生态包）均为 `file:../AgentDev/packages/*` junction。开发过程没有任何 tgz 拷贝环节**——改框架或生态包源码 → 在 AgentDev 根目录跑 `npm run build`（统一为 `scripts/build-all.mjs`，一次产出全部 18 包 dist）→ 重启 Claw 服务/agent 即生效。只改个别包可用 `cd packages/<name> && npm run build` 提速。

```bash
# 框架侧任一改动（core/llm/viewer/mcp 或 14 生态包）后：
cd D:/code/AgentDev && npm run build     # 全部 18 包 dist
# 或只构建单个包提速：
cd D:/code/AgentDev/packages/<name> && npm run build
# 然后重启 Claw 服务（或对应 agent）
```

#### 发布：产出 tgz 到 resources/features/

`resources/features/*.tgz` 只是发布产物（供 Feature Repository UI 与独立消费方安装），不参与本机开发解析。

```bash
cd D:/code/AgentDevClaw
npm run pack:features              # 全部生态包 build + pack + 写入 resources/features/
npm run pack:features shell-feature weixin-bot   # 只打包指定包
```

注意：tgz 文件名含版本号，发布前先在框架仓库推进版本；同版本重打包会因 lock integrity 变化报 `EINTEGRITY`，此时删除 lock 中该包条目的 `integrity` 字段后重新 `npm install` 即可。

#### 双路径 feature（同时存在于 `packages/*` 和旧 `src/features/*` 副本）

历史上 shell/audit/qqbot/websearch 等存在双路径副本。四包拆分后框架内 `src/features/*` 副本已随单包退役，当前唯一权威源码在 `AgentDev/packages/<name>/`。若发现仍从 `@agentdev/core` 导入某生态包的旧引用，属于待清理残留。

## 系统总览

### 1. 服务端

入口文件：[server.js](/D:/code/AgentDevClaw/server.js)

职责：

- 启动并托管 `ViewerWorker`
- 扫描 `prebuilt-agents/`
- 管理预制 agent runtime 与会话切换
- 代理前端到 ViewerWorker 的 API / 模板 / tools / chunk 请求
- 提供 `ProtoClaw` 自己的工作空间、session 管理接口
- IM 线路管理（线路绑定、转接、可路由目标查询、渠道配置）
- 调度系统（定时任务、调度轮询、调用信封与运行时状态）
- 模型预设管理与会话增强（分支、精简、AI 标题生成）
- 群聊系统（群聊创建、消息分发、管理员会话管理）

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
- IM 渠道配置面板、群聊管理、模型预设管理 UI

### 3. 预制 agent runtime

入口文件：[scripts/run-prebuilt-agent.js](/D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js)

职责：

- 动态加载 `prebuilt-agents/*/*/agent.js`
- 挂到本地 ViewerWorker
- 管理预制 agent 会话恢复
- 针对部分 agent 处理附加启动逻辑，例如 QQ gateway

### 4. 项目内本地 Feature

目录：[local-features](/D:/code/AgentDevClaw/local-features)

当前活跃维护的本地 feature：

- [local-features/dispatch/src/index.ts](/D:/code/AgentDevClaw/local-features/dispatch/src/index.ts) — 调度系统核心（ClawDispatchFeature、定时调度）
- [local-features/group-admin/src/index.ts](/D:/code/AgentDevClaw/local-features/group-admin/src/index.ts) — 群聊管理员工具集
- [local-features/checkpoint/src/index.ts](/D:/code/AgentDevClaw/local-features/checkpoint/src/index.ts) — 会话检查点
- [local-features/context-compaction-mirror/src/index.ts](/D:/code/AgentDevClaw/local-features/context-compaction-mirror/src/index.ts) — 上下文精简
- [local-features/continuity-participant/src/index.ts](/D:/code/AgentDevClaw/local-features/continuity-participant/src/index.ts) — 连续性参与方协议（框架 declareContinuity 薄封装，CONTINUITY_FIELD_KEY 读旧写新）
- [local-features/conversation-export/src/index.ts](/D:/code/AgentDevClaw/local-features/conversation-export/src/index.ts) — 对话导出
- [local-features/feature-wrappers/src/index.ts](/D:/code/AgentDevClaw/local-features/feature-wrappers/src/index.ts) — 基础包装层，编程小助手与 official coder 共享
- [local-features/agent-studio/src/index.ts](/D:/code/AgentDevClaw/local-features/agent-studio/src/index.ts) — Agent Studio 控制面（studio_* 工具、Test Runtime、结构化测试）

悬置的本地 feature（代码保留，不再积极迭代）：

- `local-features/flow/` — Flow 运行时核心
- `local-features/feature-dev/` — Feature Creator 后端

构建命令：

```bash
npm run build:local-features
```

## 当前工作空间

### 编程小助手（programming-helper）★

核心工作空间，对标 Claude Code 的 AI 编程 Agent，但在浏览器中提供完整的可视化交互层。Agent 的每一次文件读取、命令执行、代码修改都实时可见。

定义位于：

- [prebuilt-agents/official/programming-helper/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/programming-helper/metadata.json)
- [prebuilt-agents/official/programming-helper/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/programming-helper/agent.js)

该工作空间含两个会话身份，runtime 按 `sessionType` 分派 Agent 类：

- **编程小助手（main，缺省）**：用户交互式编程 Agent。
- **coder（`sessionType=coder`）**：无人值守自主编码身份，装配 [prebuilt-agents/official/programming-helper/coder-agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/programming-helper/coder-agent.js)，配置独立于主身份（`.agentdev/agent-configs/coder.json`）。coder 会话是线程宿主（自动建 WorkThread，trim/摘要后自动接力），只能由调度面创建（ACP / `claw threads` / workspace-coder-dispatch 技能），用户不能在 UI 创建。Web UI 左侧「coder」是同一工作空间的独立投影入口（线程列表视图）。归档宾语是线程（先中断再归档，已归档线程拒绝新指令）。旧 `prebuilt-agents/official/coder/` 独立工作空间已移除，其数据留在原地废弃。

核心能力（main 身份）：

- 集成 Shell（命令执行）、LSP（符号跳转 / 类型查看 / 引用查找）、Web 搜索等完整工具链
- 会话分支、上下文精简（trim / compact / summary）、checkpoint / rollback
- AI 生成会话标题
- 支持语音输入与声音反馈（需在全局设置中配置语音模型）

### Agent Studio（agent-studio）★

上游制造端：在对话中统一开发 Feature、装配目标 Agent，并通过 Test Runtime 形成可追溯的运行验证闭环。

定义位于：

- [prebuilt-agents/official/agent-studio/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/agent-studio/metadata.json)
- [prebuilt-agents/official/agent-studio/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/agent-studio/agent.js)
- feature 本体：[local-features/agent-studio/src/index.ts](/D:/code/AgentDevClaw/local-features/agent-studio/src/index.ts)

核心角色分工：dev agent（AgentStudioAgent）只做控制面，持有 14 个 `studio_*` 工具；被测 Feature 跑在隔离的 Test Runtime 子进程（[scripts/run-studio-runtime.js](/D:/code/AgentDevClaw/scripts/run-studio-runtime.js)），以 `studio-sandbox:<项目名>` 出现在左侧 Agent 列表（可看不可输入）。Test Runtime 有两种模式：`feature-harness`（最小 Agent + 全部开发中 Feature）与 `agent-debug`（真实 Agent + "仓库 tgz 底座 + 开发源码覆盖"混装）。

Feature 状态机由运行证据推进：`implemented → mounted → verified → snapshotted`，源码一变热载后降回 mounted。验证通过的 Feature 经 `studio_create_snapshot` 打成不可变 tgz 写入用户 Feature 仓库，成为下游消费的交接物。

dev agent 注入四个配套技能（位于 [local-features/agent-studio/skills](/D:/code/AgentDevClaw/local-features/agent-studio/skills)）：`agent-studio-workflow`（权威工作流）、`agentdev-feature-guide` 与 `agentdev-feature-packaging`（权威源在 AgentDev 框架仓库，经 `npm run adv-docs:sync` 同步）、`agentdev-agent-assembly`（Claw 本地维护）。

### IM 渠道（qqbot）★

IM 门户代理，支持 QQ/微信/企业微信/飞书的多渠道消息接入与路由。

定义位于：

- [prebuilt-agents/official/qqbot/metadata.json](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/metadata.json)
- [prebuilt-agents/official/qqbot/agent.js](/D:/code/AgentDevClaw/prebuilt-agents/official/qqbot/agent.js)

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

### 工作群（work-group）★ Beta

多 Agent 协作模式，以群聊形式指挥和协调多个 Agent。管理员是特殊的群成员，负责查看全局状态、分配任务、生成摘要。

核心能力：

- 群聊创建、Agent 身份分配
- `@mention` 派发任务给特定 Agent
- 管理员协调与上下文重建
- 群聊工具集位于 [local-features/group-admin/src/index.ts](/D:/code/AgentDevClaw/local-features/group-admin/src/index.ts)

### Runtime 配置（feature-setup）★

全局 Feature 参数配置面板，自动发现所有 Feature 暴露的 manifest 配置项。纯 UI（无 Agent 进程），配置写入后对所有工作空间生效。当前主要消费方是编程小助手。

## Plain Agent 与 claw CLI（无工作空间运行模式）

**板块定位**：与 workspace / prebuilt agent 平行的第三种 agent 形态——不建立工作空间、不进 `prebuilt-agents`、不依赖 Claw server 运行，通过全局命令 `claw` 直接调用。设计意图有二：一是提供"轻量、可组合"的 agent 装配形态（建个目录写个 agent.js 即可运行，适合作为其他软件的组件被 CLI 集成）；二是作为无头审计模式的载体——agent 作为组件运行时，全过程可经 stdio 管道化消费（codex exec 契约），同时保持"Web UI 监视可见"与"CLI 审计可用"两个面互不干扰。

```bash
claw agents                          # 列出已注册的 plain agent
claw run <name> --goal "..."         # 单次调用（默认连接 ViewerWorker 可被面板监视）
claw run <name> --goal "..." --headless --format jsonl   # 纯无头 + 会话事件流（CI / 管道消费）
```

结构与关键文件：

- agent 定义：`agents/<name>/agent.js`（export default Agent 类）+ 可选 `metadata.json`；或任意独立 Agent 项目目录（经 `claw agents register` 注册接入）
- 入口链路：[bin/claw.mjs](/D:/code/AgentDevClaw/bin/claw.mjs)（薄壳）→ [scripts/run-plain-agent.js](/D:/code/AgentDevClaw/scripts/run-plain-agent.js)（运行器：模型解析、viewer 连接/降级、会话落盘与索引）
- 会话事件渲染：[scripts/headless-session-renderer.js](/D:/code/AgentDevClaw/scripts/headless-session-renderer.js)，与 [scripts/run-one-shot-agent.js](/D:/code/AgentDevClaw/scripts/run-one-shot-agent.js)（prebuilt agent 的 server 派生单次调用入口）共用；事件发射点在框架 `AgentDev/src/core/session-events.ts`（见上文"会话事件流"小节）
- 输出契约遵循"统一日志契约"章节：过程信息走 stderr，stdout 只承载结果数据（`--format result|text|json|quiet|jsonl`）

**完整用法文档（五种格式输出形态、jsonl 事件 schema、监视/无头对照、会话续接、落盘位置）在 [agents/README.md](/D:/code/AgentDevClaw/agents/README.md)，修改 CLI 行为时必须同步更新该文档。**

### ACP 适配层

ACP coder 适配层是独立 stdio 进程（`claw acp coder`），只做协议转换与本机 HTTP 调用，执行权威留在 Claw server；详见 [coder-acp-adapter-design.md](/D:/code/AgentDevClaw/docs/coder-acp-adapter-design.md) 与 [ADR-0004](/D:/code/AgentDevClaw/docs/adr/0004-acp-adapter-external-stdio-process.md)。适配器改动只需新起子进程；018 类 server 路由改动需要重启整个 Claw 服务。

## Agent 制造 → 消费链路（agent-studio → claw CLI）

上游（agent-studio 工作空间）制造 Feature 与 Agent，下游（`claw` CLI / plain agent runner）消费它们。交接物与解析链如下。

### 交接物

| 交接物 | 位置 | 说明 |
|--------|------|------|
| Feature 快照 tgz | `~/.agentdev/AgentDevClaw/user-features/` | `studio_create_snapshot` 产出，不可变（同版本不同字节会被拒绝） |
| 独立 Agent 项目 | 任意目录（用户在对话中确认） | `agent.js` + `metadata.json`（`deployment.kind: "standalone"`，`features[]` 声明精确版本的包名） |
| Agent 注册表 | `~/.agentdev/AgentDevClaw/agent-registry.json` | `claw agents register <dir> [--studio <studio-dir>]` 写入；`--studio` 关联后 `claw run <id> --debug` 才可用源码覆盖 |

### 消费端共享解析链（server/feature-runtime/）

`claw run`（release/debug）、Studio agent-debug 模式、server 侧共用同一条链，保证"Studio 验证过的装配 = 消费端运行的装配"：

1. `schemas.js` — 校验 metadata（release 与注册时强制 `features[].version` 为精确 semver）
2. `catalog.js` — 扫描两个 tgz 仓库：`resources/features/`（官方）+ `~/.agentdev/AgentDevClaw/user-features/`（用户，同版本时优先）
3. `resolver.js` — 生成 runtime plan：release 全部解析为仓库 tgz；debug 允许 Studio 同名包源码覆盖（`resolvedFrom: 'source'`）
4. `provisioner.js` — 内容寻址环境 `~/.agentdev/AgentDevClaw/runtime-envs/<agentId>/<depHash>/`（npm install `file:` tgz + `@agentdev/core|llm|viewer` 本地目录依赖，依赖不变则复用；Agent 源码复制进 `agent-source/`，排除 node_modules/.agent-studio/.git）
5. `loader.js` — 动态 import Feature 类 → `static inject` 拓扑排序 → `mountFeature`（重名/环/缺失依赖直接报错）

### Studio 项目的落盘布局

```
<projectDir>/                        ← 用户任意目录，agent-studio.json 为项目档案
  agent-studio.json                  ← goal / features 注册表 / tests / 状态机 / agent 登记
  features/<name>/                   ← 标准 npm Feature 项目（src/ + dist/）
  .agent-studio/
    runs.json                        ← 运行记录（保留 30 条，含断言判定与证据）
    runtime-sessions/                ← default 会话 + cp-* 检查点
    runtime-plan.json / source-overrides.json   ← agent-debug 模式运行计划
~/.agentdev/AgentDevClaw/workspaces/agent-studio/
  state.json                         ← openDirectory 等工作空间状态
  projects.json                      ← 项目索引（前端首页 studio-projects block 数据源）
```

### 修改注意事项

- Studio feature 源码（`local-features/agent-studio`）改动后：`npm run build:local-features` + 重启 agent-studio runtime。
- `agent-studio-workflow` SKILL 是 dev agent 行为的权威描述；新增/改名 `studio_*` 工具、调整状态机或会话策略时，必须同步更新 [local-features/agent-studio/skills/agent-studio-workflow/SKILL.md](/D:/code/AgentDevClaw/local-features/agent-studio/skills/agent-studio-workflow/SKILL.md) 与 [prebuilt-agents/official/agent-studio/.agentdev/prompts/system.md](/D:/code/AgentDevClaw/prebuilt-agents/official/agent-studio/.agentdev/prompts/system.md)（两处都注入给 dev agent）。
- feature-guide / feature-packaging 两个技能的权威源在 AgentDev 框架仓库，Claw 侧副本由 `npm run adv-docs:sync` 同步，不要直接改 Claw 副本。

## 关键数据流

### 1. 编程小助手的会话生命周期

主链路：

1. 用户选择项目目录，新建对话
2. 服务端创建新 session，绑定 `cwd`
3. Agent 通过 Shell、LSP 等工具执行用户需求
4. 用户可对会话进行分支、精简、checkpoint 等管理操作

关键字段：

- `cwd` — 会话绑定的项目目录
- session ID — 唯一会话标识

### 2. IM 消息路由

主链路：

1. IM 平台消息到达门户代理（qqbot）
2. 接线员根据通道配置路由到对应的工作空间会话
3. 目标 Agent 处理消息并回复
4. 回复经接线员传回 IM 平台

关键配置：

- 线路绑定（`im_line_binding`）
- 通道配置（渠道 + 绑定会话）
- 可路由目标查询（`im_routable_targets`）

### 3. 会话管理（分支 / 精简 / 摘要）

主链路：

1. 用户在会话列表中右键触发操作
2. 分支：从指定消息节点创建新会话
3. 精简：裁剪早期历史（Trim）或压缩为摘要（Compact）
4. 摘要导出：将会话导出为结构化摘要
5. Checkpoint / Rollback：保存与恢复会话状态

## 会话连续性三层模型（消费框架 continuity，ticket 008）

权威设计与决策记录：[docs/adr/0002-session-continuity-as-transformation.md](/D:/code/AgentDevClaw/docs/adr/0002-session-continuity-as-transformation.md)。Claw 不再自带连续性引擎实现，全部消费 `@agentdev/core` 框架导出；理解三层概念是改动任何 trim / compact / 摘要 / 线程代码的前提。

### 三层概念

| 层 | 概念 | 说明 |
|----|------|------|
| Session | 会话快照 / SuccessorSeed | 源会话的可变换快照（`runtime.context.messages`）与变换产物（seedMessages + importantFiles 等元数据），落盘为 handoff 包 |
| Transformation | 官方变换 | 框架实现的 `TrimTranscriptTransformation` / `SummaryTransformation` / `TrimTranscriptWithSummaryTransformation`（`agentdev.summary.*` / `agentdev.trim-transcript.*`），LLM 经 `TransformContext.llm` 进程内注入 |
| WorkThread | 线程核心 + 看板 | `WorkThread`（线程状态机、命令、接力）/ `WorkThreadBoard`（模式、执行事件、resume）/ `WorkThreadStore`（持久化）/ `WorkThreadRuntimeBridge`（runtime 接线），替代 Claw 原 ThreadController |

### Claw 消费路径表（官方实现 → Claw 装配点）

| 能力 | @agentdev/core 导出 | Claw 装配点（薄封装/装配层） |
|------|--------------|---------------------------|
| trim 引擎 | `buildTrimmedSeedMessages` / `normalizeExportPolicy` / `DEFAULT_EXPORT_POLICY` / `HANDOFF_SCHEMA_VERSION` / `HANDOFF_COMPILER_VERSION` | [server/context-continuity/handoff-package.js](/D:/code/AgentDevClaw/server/context-continuity/handoff-package.js)（薄封装 + Claw 落盘格式） |
| trim+summary 组合 | `TrimTranscriptWithSummaryTransformation`（组合语义唯一权威，thread 接力与手动精简共用） | [server/context-continuity/trim-appended-summary.js](/D:/code/AgentDevClaw/server/context-continuity/trim-appended-summary.js)（装配器：快照读取 + llm 注入 + 重试/超时）；落盘经 handoff-package.js 的 `writeTrimWithSummaryHandoffPackage`（handoff JSON v1 格式化） |
| 摘要生成 | `generateSummaryText` / `buildSummaryPrompt` / `stripCompactAnalysis` / `scanFilesAndSkills` / `buildSummarySeedMessage` / `normalizeSummaryPolicy` | [server/context-continuity/inprocess-summary.js](/D:/code/AgentDevClaw/server/context-continuity/inprocess-summary.js)（`system` 角色模型解析 + 重试/超时，`resolveSummaryLLM` 供各装配层共用）；summarized-handoff.js / session.js 的 `session_generate_summary` 路由经此调用 |
| seed feature | `HandoffSeedFeature` | [scripts/run-prebuilt-agent.js](/D:/code/AgentDevClaw/scripts/run-prebuilt-agent.js) 与 [scripts/run-one-shot-agent.js](/D:/code/AgentDevClaw/scripts/run-one-shot-agent.js) 装配（原 local-features/context-handoff-seed 已删除，不留薄壳） |
| 连续性字段 | `CONTINUITY_FIELD_KEY`（`__agentdev_continuity__`） | [local-features/continuity-participant](/D:/code/AgentDevClaw/local-features/continuity-participant/src/index.ts)：读旧写新（兼容 `__claw_continuity__`），协议字符串保留 `claw.*` 命名空间 |
| 线程控制 | `WorkThread` / `WorkThreadBoard` / `WorkThreadStore` / `WorkThreadRuntimeBridge` | [server/thread-control/thread-controller.js](/D:/code/AgentDevClaw/server/thread-control/thread-controller.js)：`createThreadControl()` 返回 `{core, board, store}` 双对象装配；数据目录为全局 `~/.agentdev/AgentDevClaw/threads/`（含 boards/ 与 archive-index.json）；宿主判定为会话级（programming-helper + sessionType=coder） |

### 已知边界与注意

- 旧 mirror 子进程管线（scripts/run-compact-mirror.js）已删除；title/recap mirror 子进程仍在（不同管线，不在本层）。
- 旧 thread record 中 `executionEvents` / `mode` 字段为惰性数据，看板事件从 `boards/` 重新累积；旧状态词（idle/running/waiting_input/failed）在 store 读取时归一为 `open`。
- 重启范围：框架 dist（`AgentDev/dist/*`）变更高于以上任何消费点时，必须重启整个 Claw 服务（见「进程架构与重启范围」）。

## 统一日志契约（重要）

两套日志系统的边界与分流契约，改动日志相关代码前必读。

### 边界：agent 内 vs agent 外

| 范围 | 正当通道 | 约束 |
|------|---------|------|
| agent 运行时内部（feature 提供、agent.js 装配层） | `@agentdev/core` 的 `createLogger()` → DebugHub → Web UI（query_logs / debugger MCP） | ESLint `no-console: error`（存量文件在 ratchet 清单中降为 warn） |
| 非 agent 运行（server.js 进程、scripts/、bin/） | console / stdio（没有前端显示载体） | `no-console: off`；推荐 `server/shared/claw-logger.js` 的 `createClawLogger()` 获得等级与分流纪律 |
| 前端 public/ | 浏览器 console | 不在此约束范围 |

关键事实：

- 无头运行（无 ViewerWorker 连接，如 run-one-shot-agent.js）时框架日志自动 fallback 到 stdio，审计不丢失。
- 框架 emitLog 在 hub 连接时默认只推 hub（`npm start` 前台终端保持安静）；`AGENTDEV_LOG_CONSOLE_MIRROR=on` 可开启 stdio 镜像用于 CLI 调试。
- agent 侧绕过 logger 直接 `console.log` 会丢失等级与命名空间（console 桥只在 log scope 内生效），这就是 lint 强制的理由。

### stdio 分流契约（CLI 审计接口）

- 等级：trace/debug/info/warn/error —— 所有日志必须带等级，这是审计前提。
- `AGENTDEV_LOG_STREAM=auto`（默认）：trace/debug/info → stdout，warn/error → stderr。
- `AGENTDEV_LOG_STREAM=stderr`（无头模式）：全部日志 → stderr，stdout 只承载结果输出（如 `ONE_SHOT_RESULT:`、`PLAIN_AGENT_RESULT:` 协议行），保证可安全管道化。无头入口脚本负责设置此环境变量。
- 无头入口必须以 `import './headless-log-preamble.js'` 作为**第一个 import**（现成范例：run-one-shot-agent.js、run-plain-agent.js）。它设置 env 并安装简版 console 分流补丁，覆盖"框架 console 桥（Agent 构造时才装）生效之前"的模块顶层窗口。两个坑：静态 import 会提升，入口模块体里再设 env 已经太晚；@agentdev/core 依赖图含 top-level await，会异步化依赖它的前导模块，因此 preamble 严禁依赖框架包。
- Claw 侧 `CLAW_LOG_LEVEL` 可过滤非 agent 日志的 stdio 冗长度（默认全量）。

### 会话事件流（无头模式的 stdout 数据协议）

无头模式 stdout 的主要数据形态是 codex exec 风格的会话事件 JSONL 流，与运行日志（stderr）严格分离：

- 事件模型（对齐 `codex exec --json`）：`thread.started` / `turn.started` / `item.started|completed`（item 类型：`agent_message` / `reasoning` / `tool_call`，tool_call 通过 call.id 配对 started/completed）/ `turn.completed`（含 token 用量）/ `turn.failed` / `error`。
- 框架侧实现：`AgentDev/src/core/session-events.ts`（进程内订阅 API `subscribeSessionEvents`，无订阅者零开销）。发射点：`context.addAssistantMessage` / `context.addToolMessage`（消息变更单点）+ `agent.ts` 的 call start/finish。与通知系统（notification.ts）的分工：通知是节流的 UI 状态信号；会话事件是不节流的审计数据。
- Claw 侧渲染：`scripts/headless-session-renderer.js`。`--format jsonl` → 事件流写 stdout（机器消费）；其余格式 → human 可读行写 stderr（对齐 codex exec 默认形态：过程信息全走 stderr，stdout 干净）。
- 入口：`run-plain-agent.js` 的 `--format jsonl`；`run-one-shot-agent.js` 的 `--format jsonl` flag。`PLAIN_AGENT_RESULT:` / `ONE_SHOT_RESULT:` 协议行在 jsonl 模式下不输出（事件流已含结果），其他格式保持不变。

### 修改注意事项

- 框架日志实现在 `AgentDev/src/core/logging.ts`；改动后需在 AgentDev 仓库 `npm run build` 并重启整个 Claw 服务。
- ESLint 边界与 ratchet 清单在 `eslint.config.js` 末尾两个 block；agent 侧文件迁移到 logger 后应从清单移除。

## 前端结构现状

### index.html 已经瘦身

`[public/index.html](/D:/code/AgentDevClaw/public/index.html)` 现在主要只保留：

- HTML 壳
- 第三方资源引用
- `app-core.js`
- `app-ui.js`
- `app-main.js`

不要再把它当成主要业务脚本文件。

### 三个前端脚本的大致分工

- [public/src/app-core.js](/D:/code/AgentDevClaw/public/src/app-core.js)
  - 基础常量、i18n、fetch/invoke、公共 DOM 引用、初始化底座
  - `getRuntimeContextKey()`、optimistic runtime cache (`_agentRuntimeCache`)、session input cache
- [public/src/app-ui.js](/D:/code/AgentDevClaw/public/src/app-ui.js)
  - workspace surface 渲染骨架、block 分发
  - `renderCurrentMainView()`、`renderWorkspaceSurface()`、`selectWorkspaceSurface()` 等核心入口
  - 注意：已拆分至 ~1890 行，具体功能域由 `modules/` 下 80 个模块承接（加载顺序见 index.html）
- [public/src/app-main.js](/D:/code/AgentDevClaw/public/src/app-main.js)
  - agent 切换与轮询核心：`switchAgent()`、`requestSwitch()`、`handlePrebuiltAgentClick()`、`navigateToWorkspaceSession()`、`poll()` 主循环
  - 会话创建与压缩续接：`openPrebuiltWorkspaceSession()`、`createCompactedResumeSession()`
  - 注意：已拆分收口至 ~1270 行（commit a406168）。原属 main 的功能已模块化：`loadAgentData` → modules/agent-data-loader.js，`loadAgents`/`renderAgentList` → modules/sidebar-render.js，`render()` → modules/chat-renderer.js，`renderInputRequests` → modules/input-render.js，`runWorkspaceAction` → modules/workspace-actions.js

### 一个重要经验

`renderCurrentMainView()` 是主视图状态机入口，很多 workspace 问题最终都会回到这里。

### app-core.js 全局状态纪律（ticket 021）

app-core.js 的全局状态区只减不增：新增前端状态默认放入所属 modules 文件的局部作用域，确需跨模块共享时使用 `window.ClawFW` 命名空间（先例：modules/fw-config-panel.js），不再向 app-core.js 追加顶层 `let` 声明。

## 预制 agent 与 workspace 首页模型

预制 agent 的 `metadata.json` 仍然支持 `ui` 声明和 block 渲染，这套机制仍是基础壳能力。

仍然常见的 block / 入口概念包括：

- `ui.entry`
- `ui.tabs`
- `ui.home.blocks`

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

会话数据优先落在用户目录下，不污染仓库。

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

装配预检（假设性装配检查，见 [server/routes/preflight.js](/D:/code/AgentDevClaw/server/routes/preflight.js)）：

- `POST /protoclaw/preflight` — body `{ features?, modulePaths? }`，返回 issues（policy 唯一性等）+ 装配预览（拓扑序、工具归属、钩子清单）

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

## 资源与依赖

### AgentDev 依赖

当前依赖形态（18 个 @agentdev 包尚未发布 npm，走本地 junction）：4 框架包 + 14 生态包均为 `file:../AgentDev/packages/<name>`。

这意味着：

- `npm install` 会把全部 `file:` 目录依赖物化为 junction，指向相邻框架仓库的包目录
- 本机框架联动开发的标准流程是 install → build → start 三段式：

```bash
npm install        # 全部 18 条链接物化
npm run build      # 自动校验/修复链接 + 构建框架（若相邻仓库存在）+ local-features + features
npm start          # 纯净启动
```

- 链接被冲掉或异常时，`npm run build` 的 `check:agentdev` 会自动重建（无需手动）；仅相邻仓库路径非常规时才需要 `AGENTDEV_LOCAL_PATH` 或 `node scripts/use-agentdev-local.mjs <path>`
- 发版后切回 npm 正式包时，`@agentdev/*` 改为 semver 依赖；`npm run agentdev:published` 目前仍是占位指引命令。build/preflight 会按依赖形态自动分流（`file:` → 开发态，semver → 发布态）
- 可用 `Get-Item node_modules/@agentdev/core | Format-List LinkType,Target` 验证是否指向期望的本地 AgentDev 仓库
- 修改框架后：`cd D:/code/AgentDev && npm run build`（统一脚本产出全部 18 包 dist），再重启 Claw 服务/agent 生效
- 任何"这是 Claw 问题还是 AgentDev 问题"的判断，都要考虑两个仓库一起看

### Feature 包资源

发布产物目录（tgz，经 `npm run pack:features` 产出）：

- [resources/features](/D:/code/AgentDevClaw/resources/features)

## 当前已知边界

这些边界不是遗漏，而是当前阶段的真实状态：

- 工作群（Beta）基础闭环已初步可用，深度功能仍在开发中
- 前端 `app-ui.js`（~1890 行）/ `app-main.js`（~1270 行）模块化拆分已完成，`modules/` 下共 80 个模块。当前新的膨胀风险点：
  - `modules/work-group-ui.js`（~4360 行）与 `modules/wg-core.js`（~3030 行）——工作群（★ Beta）前端主体，最大的待拆分对象
  - [local-features/agent-studio/src/index.ts](/D:/code/AgentDevClaw/local-features/agent-studio/src/index.ts)（~2120 行）——活跃域单文件
  - `app-core.js`（~2000 行，6 月以来 +50%）——共享全局状态持续堆积，新增状态时注意约束
  - 悬置域的大文件（`public/flow-editor.js` ~3690 行、`local-features/feature-dev`、`local-features/flow`）按约定不再投入拆分
  - 拆分历史与规范：[docs/plans/2026-07-03-app-main-split-plan.md](/D:/code/AgentDevClaw/docs/plans/2026-07-03-app-main-split-plan.md)（含收口复核）、[docs/plans/2026-06-29-app-ui-split-plan-v2.md](/D:/code/AgentDevClaw/docs/plans/2026-06-29-app-ui-split-plan-v2.md)
- 项目中保留了若干悬置工作空间（flow-workspace、feature-creator、agent-creator、dispatch-console）的代码，这些代码仍可运行但不再积极迭代

## 测试体系

### 命令

```bash
npm test                                  # 运行全部测试（core + features）
npm run test:core                         # 运行 test/*.test.js（无需构建）
npm run test:file -- test/call-arbiter.test.js # 运行单个核心测试文件
npm run test:features                     # 编译并运行全部 local-features 测试
npm run test:coverage                     # 运行 core 测试并输出覆盖率报告
```

### 统一测试格式

本仓库所有测试（core 和 local-features）均使用 Node 内置的 `node:test` 与 `node:assert/strict`，由 `node --test` 驱动。不要在本仓库新增 Vitest/Jest 导入或 `expect` / `vi` 写法；它们属于 `AgentDev` 框架仓库的独立测试体系。

### 测试文件结构

```
test/                                          ← 服务端核心逻辑测试（node:test 格式）
  call-arbiter.test.js                         ← CallArbiter 调用仲裁
  runtime-call-envelope.test.js                ← 运行时信封
  session-model-meta.test.js                   ← 会话模型元数据
  fs-helpers.test.js                           ← 文件系统辅助函数（readJson, ensureDir, normalizePathCasing）
  fs-operations.test.js                        ← 文件系统操作（runCommand, validateEmptyDirectory）
  server-smoke.test.js                         ← 服务端模块导入冒烟 + 路由注册验证 + 导出契约
  claw-mcp.test.js                             ← MCP 服务端工具/资源/提示注册完整性
  ...                                          ← 其他 ~40 个测试文件覆盖各路由模块

local-features/                                ← 本地 Feature 功能测试（node:test 格式，TypeScript）
  flow/test/flow-feature.test.ts               ← FlowFeature（节点转换、prompt 注入、分支边）[悬置]
  context-compaction-mirror/test/smoke.test.ts ← ContextCompactionMirror（工具禁用）
  dispatch/test/smoke.test.ts                  ← ClawDispatchFeature（双模式注入状态机）
  checkpoint/test/smoke.test.ts                ← CheckpointFeature（checkpoint/rollback）
  continuity-participant/test/*.test.ts        ← 连续性参与方（OnInitiate 防护 + legacy key 读旧兼容）
```

### 何时跑测试

- 修改某个核心测试覆盖的逻辑后，先运行 `npm run test:file -- test/<相关文件>.test.js`；涉及多个模块或提交前再运行 `npm run test:core`
- 修改 `local-features/` 下的 TS 源码后 → `npm run test:features`（会自动先构建）
- 提交前、合并前 → `npm test` 确保全绿
- 想看覆盖率 → `npm run test:coverage`

### 测试时长预算与超时标准

测试慢几乎从来不是断言慢，而是卡住或句柄泄漏。**超过预算就当 bug 排查，不要调大预算。** node --test 按文件并行，全量墙钟 ≈ 最慢单文件，所以单文件墙钟是最重要的控制指标。

| 层级 | 常规预算 | 超过即异常 |
|------|---------|-----------|
| 单用例（it） | < 100ms | 2s（真实 IO / 子进程用例可放宽到此） |
| 单文件墙钟（test:file） | < 1.5s | 10s 硬上限 |
| 全量 test:core | ~13-15s | 30s |

（基线为 2026-08 实测，24 核机器，2176 用例）

已知合理慢文件——生产语义决定，不要"修复"：

- `test/oauth-codex.test.js`（~7s）：`requestDeviceCode` 有 `interval >= 3s` 生产下限 + 300ms 网络重试退避，测试必须真实等待
- `test/feature-runtime.test.js`（~7s）：真实子进程生命周期
- `test/session-summary.test.js`（~8s）：慢路径每次扫描真实用户 `context-handoffs` 目录，耗时随用户历史增长（已知待办：注入 summaryMap 隔离）

**慢测试三步排查法**：

1. 逐文件计时定位：`for f in test/*.test.js; do s=$(date +%s%3N); node --test "$f" >/dev/null 2>&1; e=$(date +%s%3N); echo "$((e-s))ms $f"; done | sort -rn | head`
2. 残留句柄探针（断言毫秒级完成但墙钟秒级时必做）：用 `node -e` 直接 import 测试文件，`setInterval` 周期打印 `process.getActiveResourcesInfo()`。`Timeout` = 未清理的 setTimeout；`PipeWrap`×2 = 一个未退出的子进程/socket；`ProcessWrap` = 活着的子进程
3. 定时器来源定位：在 import 前包一层 `setTimeout` 补丁，打印 ≥100ms 调用的创建堆栈

历史案例：`waitForProcessExit` 的 `Promise.race` 忘了 `clearTimeout`，测试断言 0.8s 完成但进程被残留定时器挂住 15s，独占全量套件墙钟（2026-08 已修复，16.3s → 1.4s）。

写测试时的规则：

- 模拟等待优先用最小 interval 值或 `node:test` 的 `mock.timers`，测试内禁止真实 sleep > 500ms
- `Promise.race` 竞速的 fallback 定时器，胜出分支必须 `clearTimeout`
- `after()` / `finally` 必须杀掉 spawn 的子进程、restore 全局补丁（fetch 等）
- 不读取真实用户数据目录（`USER_DATA_ROOT` 下的内容），耗时随用户数据量增长且不可复现

### 新增测试的约定

- 服务端纯逻辑（server.js 中的决策函数、工具函数）→ 新建 `test/xxx.test.js`，用 `node:test` 格式
- local-feature 功能 → 新建 `local-features/<name>/test/xxx.test.ts`，用 `node:test` 格式（`describe/it/assert`）
- local-feature 测试需要在 `local-features/tsconfig.json` 的 `include` 中添加 `./<feature>/test/**/*.ts` 才能被编译
- `test:features` 自动发现 `local-features/dist/*/test/*.test.js`，不为单个测试维护脚本路径
- 前端 JS 目前仅有 `frontend-vm.js` 沙箱测试覆盖 `app-core.js` 纯函数

### 重要注意事项

- local-features 测试依赖编译产物，`npm run test:features` 的 `pretest:features` 钩子会自动构建
- 测试代码中 inline 复刻的 server.js 逻辑（如 `session-model-meta.test.js` 中的 `resolveSessionModel`）需要在 server.js 对应逻辑变更时同步更新

---

## 开发时的建议心智

进入实际开发前，优先先回答这些问题：

1. 这次改的是壳层（前端 JS）、预制 agent 装配（`agent.js`），还是 feature 实现？
2. 当前数据的真相在前端草稿、服务端 workspace state，还是 session index？
3. 当前行为是预制 agent 首页行为，还是运行时行为？
4. **用户看到的是哪个前端管线？** 如果涉及面板显示、inspector 渲染，先确认该面板是 Claw 前端（`app-ui.js`，端口 1420）还是 DebugHub 查看器（`viewer-html.ts`，端口 2026）渲染的。改错管线 = 白改。
5. **stale check 依赖的全局变量在 `await` 期间会变吗？** `allAgents`、`focusedAgentId` 等全局状态会被 poll / `loadAgents()` 异步修改。在 `await fetch()` 前后比较基于这些变量计算的值（如 `getRuntimeContextKey`）会产生虚假判定。stale check 只能用同步设置的 `currentRuntimeAgentId`。

把这些问题先想清楚，通常就能避免在错误层面下手。

## 跨项目上下文索引

[docs/dev-context-index.md](/D:/code/AgentDevClaw/docs/dev-context-index.md) 记录了 AgentDev 框架与 AgentDevClaw 产品之间的关键连接关系、文件速查表、核心数据流和已知改进方向。需要跨仓库联动排查时，优先阅读它。

## 两套前端渲染管线（重要）

用户日常使用的 Web UI 运行在端口 1420，有一个**独立于框架**的前端渲染管线。框架侧也有自己的 DebugHub 查看器（端口 2026）。这两套系统的渲染代码完全不同，改错地方会导致"代码明明对了但用户看不到效果"。

### 端口 1420：Claw 主前端（用户看到的）

| 文件 | 职责 |
|------|------|
| `public/src/app-core.js` | i18n、基础常量、公共函数 |
| `public/src/app-ui.js` | Feature 面板渲染（`renderFeaturesPanel`）、workspace surface、面板状态管理 |
| `public/src/app-main.js` | 轮询主循环（`poll`）、agent 切换（`switchAgent`）、会话导航与 bootstrap |
| `public/src/modules/overview-data.js` | `normalizeHookInspector`、`setCurrentHookInspector` |
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
  → Claw 前端: app-main.js poll 发起 fetch → normalizeHookInspector()（modules/overview-data.js）→ currentHookInspector
  → app-ui.js: renderFeaturesPanel() 渲染
```

### 关键陷阱：normalizeHookInspector 丢字段

`normalizeHookInspector()` 函数**存在于两个地方**，作用是把 API 返回的 inspector snapshot 重构为前端使用的标准化对象。新增 inspector snapshot 字段时，**必须同时更新两处**，否则字段会在重构时被丢弃：

1. **Claw 前端**：`public/src/modules/overview-data.js` — 影响**用户日常看到**的面板
2. **框架侧**：`AgentDev/src/core/viewer-html.ts` — 影响 DebugHub 查看器（端口 2026）

历史上真实踩过的坑：在框架 `agent.ts` 的 `buildHookInspectorSnapshot()` 中新增了 `standaloneTools` 字段，框架和 API 都正确返回了数据，但 `normalizeHookInspector()` 在重构时没有透传这个字段，导致前端始终看不到。

## 会话切换与异步渲染的关键约束

会话切换链路（`switchAgent` → `loadAgentData` → `poll`）的详细渲染契约、去重策略和自检清单见 [docs/frontend-rendering-patterns.md](/D:/code/AgentDevClaw/docs/frontend-rendering-patterns.md)。以下是最容易踩坑的三条不变量：

1. **`getRuntimeContextKey` 不是 stable 的**：它依赖 `allAgents`（由 `loadAgents()` 异步更新），在 `await` 前后会返回不同值。**不能用于 stale check**，只能用于 cache key（miss 无害）。stale check 只用 `currentRuntimeAgentId`。
2. **切换不依赖服务端 current 状态**：`switchAgent` 先设全局状态 + optimistic 渲染，再 `await loadAgentData(runtimeId)`（所有 URL 用显式 `agentId`）；焦点仅持久化到 `localStorage['claw:lastFocusedRuntimeId']`（服务端 current agent 语义已移除，commit 99e0245）。
3. **控制投递的 id 空间**：前端→agent 运行时控制 IPC（开关 / 中断 / 热切换类）**必须优先用 `runtimeId`（viewerAgentId，即 `currentRuntimeAgentId`，与轮询数据源 `/api/agents/:id/...` 的 `:id` 同空间）定位**；`allAgents` 缓存派生的 sessionId 会暂态错位，只能作 fallback，且 server 端禁止跨 session fallback 投递 session 级状态。前端必须检查 `payload.ok`，失败要回滚乐观态。参考实现：`todo_control`（agent-lifecycle.js）与 `swap_model`（model-config.js）。详见 frontend-rendering-patterns.md §8d。

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

## Capability 控制面与 slash 命令系统（ticket 0007）

权威设计与全部裁决记录：[docs/adr/0007-capability-registry-as-control-plane.md](/D:/code/AgentDevClaw/docs/adr/0007-capability-registry-as-control-plane.md)。改 capability / slash / 跨 feature 通讯相关代码前必读。

核心模型：feature 通过 `getCapabilities()` 声明能力（command），框架 `CapabilityRegistry` 提供进程内 invoke（哑注册表，无依赖图、无状态共享）；slash 菜单是人机入口，`GET /protoclaw/commands` 聚合宿主域 + 动态命令，`POST /protoclaw/capability_invoke` 投递（三元组 agentId/runtimeId/sessionId 寻址，runtimeId 优先——镜像 todo_control 模式）。命令分 `kind: invoke`（表单+执行+toast）与 `kind: prompt`（挂 pill、发送时以结构化 `capabilityActivations` 随消息流动，经 viewer 队列/线程交接到达任意后继会话，由 feature 的 `onCapabilityActivations` 消费注入）。

关键边界：

- 注册表是进程内语义，跨进程投递归宿主层（server + IPC 通用分支 `capability-invoke` / `capability-list-request`，位于 scripts/capability-ipc.js）
- 永不提供 bind/reactive/watch-state；共享权威状态与跨 feature 事务是负面清单（上移宿主或重构）
- entryPoints 是契约约束兼访问控制（缺省 `['feature']`），不是安全边界
- capability 收集发生在 feature `onInitiate` 成功之后（skill 类动态能力依赖初始化后的状态）
- 前端 slash 系统（modules/slash-menu.js）与输入框解耦：document 级 capture 监听，双输入框（idle `input-<requestId>` / 运行中 `input-persistent`）经 `.user-input-textarea` class 统一触发，删掉该模块系统照常工作
- invoke 生命周期日志由框架兜底（namespace `capability`），不依赖 feature 自觉
