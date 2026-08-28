# ADR 0003: AgentDev 包结构破坏性拆分——无伞包、core 零重依赖

- 日期：2026-08-21
- 状态：已接受（grill 会话定稿；执行为 docs/tickets 批次 3，009-012）
- 前置：ADR-0002（Session Continuity as Transformation，批次 2）

## 背景

`agentdev` 当前是单包全量捆绑：

- 无 `exports` 字段、单入口 `dist/index.js`，tsup 把 core + 19 个 src/features + agents + template + skills + mcp 全部 bundle 进一个 dist
- 重依赖全量携带：`better-sqlite3`（原生）、`sharp`（原生二进制）、`openai` SDK、`@openai/agents`、MCP 三件套、`sound-play`、`open`——只用 BasicAgent 的宿主也要承担全部安装成本与失败率
- 9 对双路径 feature（`packages/*` 与 `src/features/*` 各一份源码）两条构建、两条消费路径，是 CLAUDE.md 记录的高频踩坑点
- `BasicAgent` 反向依赖 4 个 feature（MCPFeature / SkillFeature / SubAgentFeature / OpencodeBasicFeature 内置装配），MCP SDK 经此渗入框架核心
- 批次 2 的 continuity 契约与 WorkThread 正在进主包——框架的根本差异点将被埋进全量桶，第三方无法单独依赖

同时具备有利条件：Claw 侧 27 处 `from 'agentdev'` 零深路径导入、实际符号约 30 个；`packages/* → agentdev` 依赖单向无环；sharp 的全库真实引用仅 `visual/capture-worker.ts` 一处、better-sqlite3 仅 `audit` 一处、MCP 在 core 仅 type-only 引用。

## 决策

1. **破坏性切换，无伞包，无兼容层**。不发布任何新旧并存的中间版本；框架发包、生态 tgz 重发、Claw 切换在同一个原子批次内完成。
2. **`agentdev` 包名退役**：npm 上标记 deprecated 并指向新包；新包为 `@agentdev/core`、`@agentdev/llm`、`@agentdev/viewer`、`@agentdev/mcp` 及 `@agentdev/feature-*`。
3. **core 纪律**：`@agentdev/core` 零原生依赖、零重 SDK、零 feature 反向依赖。BasicAgent / TemplateComposer 留 core 的前提是纯基类化（内置装配全部移除，装配权归还宿主）。
4. **双路径收敛**：9 对双路径 feature 全部收敛到 `packages/*` 唯一源码；框架 dist 不再 bundle 生态 feature；sharp 随 visual、better-sqlite3 随 audit 归位。
5. **版本**：`@agentdev/core` 从 0.1.0 起步（0.x 保留破坏自由），接续协议与 WorkThread 沉淀稳定后再 1.0。
6. **时机**：批次 3 在批次 2（005-008）之后执行。即时生效项：007 WorkThread 落位即按 core 域纪律放置（`src/core/workthread/`，不 import features / llm / viewer）。

## 备选方案（rejected）

- **伞包**（`agentdev` 保留为 re-export 门面，存量 import 零改动）：制造永久过渡态与双链路；"新代码禁用伞包"的纪律无法机械强制，与"链路唯一、彻底切换"的产品原则直接冲突。
- **`agentdev` 名字让给瘦身后的 core**：同名前后两种内容面——老 issue、老教程、肌肉记忆里的 agentdev 是全家桶，新 agentdev 是 core，沟通与检索双乱。名字即分层。
- **optionalDependencies + lazy require 处置原生依赖**：把安装失败变成静默降级，掩盖问题而非消除问题。
- **分步拆分**（core 先行、能力域包后续跟进）：无伞包前提下产生"主包内容漂移"的中间态，正是要避免的乱链路。
- **BasicAgent 保持预装配定位**（归独立组合层包）：内置装配对显式装配风格的主要消费方（Claw 全部 agent.js）是隐式行为；且保留装配则 core 无法做到零 feature 反向依赖。

## 后果

- **正面**：core 可被第三方单独依赖（只消费接续协议/WorkThread 的宿主不必安装 sharp、sqlite、LLM SDK）；双路径结构性消灭；包名即分层；安装体积与原生编译失败率显著下降。
- **负面**：生态全量改名的一次性成本（Claw 27 处 import、15 个 tgz 重发、模板与全部文档）；依赖内置装配的第三方宿主失去工具（预期内破坏）；悬置代码需同批定夺处置。
- **纪律执行**：core 永不依赖 feature 包；peer 依赖方向永远单调（feature 包 → core）；CI 断言 core 依赖清单不含原生/重 SDK 包。
