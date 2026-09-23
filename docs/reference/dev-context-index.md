# 开发上下文索引

框架（AgentDev）与产品（AgentDevClaw）的跨仓库连接关系速查。

> 分工：[AGENT.md](../../AGENT.md) 是 agent 认知地图（仓库边界、依赖形态、启动方式、协作纪律，以它为准）；本文只做一件事——框架侧的路径与机制速查，让新会话不必全量阅读两个仓库。

## 一、两仓库关系

```
D:\code\AgentDev          框架（TypeScript npm workspace monorepo）
  ↓ 构建产出 dist/，发布为 @agentdevjs/core|llm|viewer|mcp
D:\code\AgentDevClaw      产品（JavaScript 运行时 + Web UI）
```

依赖形态（开发态 `file:` 链接 / 发布态 semver）、切换脚本与硬约束见 AGENT.md「启动与依赖模式」；本仓库 `check-agentdev-local` 按声明形态校验安装形态。

## 二、框架关键路径速查（ADR-0003 后 packages 布局）

| 路径 | 职责 |
|------|------|
| `packages/core/src/core/feature.ts` | `AgentFeature` 接口（约 19 个可选方法：getTools / getAsyncTools / getSkills / getContextInjectors / getCapabilities / snapshot 等） |
| `packages/core/src/core/tool.ts` | `createTool()` 工厂 + `ToolRegistry` |
| `packages/core/src/core/context.ts` | `Context` 消息容器，enrichment 与 query |
| `packages/core/src/core/checkpoint.ts` | Session 快照与 rollback |
| `packages/core/src/core/hook-declarations.ts` | 声明式钩子：`kind` 只能 `observe / guard / transform`，guard 的 `role` 只能 `policy / advisor`（非法值在源码中直接报错修复提示） |
| `packages/core/src/core/hooks-registry.ts` | 钩子注册表与执行 |
| `packages/core/src/core/capability.ts` | `CapabilityRegistry`（进程内哑注册表，见 ADR-0007） |
| `packages/core/src/core/continuity/` `workthread/` | 会话连续性与线程状态机 |
| `packages/core/src/core/session-store.ts` `session-events.ts` | 会话持久化与 JSONL 事件流 |
| `packages/core/src/features/` | core 内框架级 feature（todo / subagent / skill / handoff-seed / lsp / opencode-basic 等） |
| `packages/<name>-feature/` | 生态 feature 包（shell / qqbot / websearch / memory / weixin-bot 等，npm 分发） |
| `packages/llm/` | LLM 抽象层（OpenAI / Anthropic 兼容） |
| `packages/viewer/` | ViewerWorker、DebugHub |
| `packages/mcp/` | MCP 协议实现 |
| `packages/create-feature/` | `npx @agentdevjs/create-feature` 脚手架 CLI |

## 三、产品侧消费框架的关键连接点

- **Feature 挂载**：`agent.use(feature)` 构造期只存 Map，首次 `onCall` 时 `ensureFeatureTools()` 统一注册工具（时序细节与同名覆盖见 AGENT.md「工具注册时序与同名覆盖」）。
- **Context 注入**：Feature 可实现 `getContextInjectors(): Map<string | RegExp, ContextInjector>`，框架执行 Tool 时按工具名匹配合并注入。产品侧消费方如 `local-features/checkpoint`、`local-features/flow`。AI 写 Feature 时经常遗漏这一步，导致 Tool 的 `execute` 收到的 context 为空。
- **Feature 包加载**：装配层靠 `/Feature$/` 类名约定找到包内 Feature 类——导出类名必须以 `Feature` 结尾，否则装配失败。当前装配权威链在 `server/feature-runtime/`（schemas → catalog → resolver → provisioner → loader）。

## 四、常见排障速查

**"我改了框架代码，产品没生效"**
→ 框架仓库 `npm run build` → 重启 Claw 服务（junction 链接下重启即生效；发布态先 `agentdev:local`，见 AGENT.md）

**"改了 local-features 的 TS 代码"**
→ `npm run build:local-features` → 重启对应 agent

**"声明式钩子没触发"**
→ 检查 `hook-declarations.ts` 返回的 kind / role 是否合法（非法值框架直接抛错并给出修复提示）

**"Tool 注册了但 Agent 看不到"**
→ 检查是 `getTools`（同步）还是 `getAsyncTools`（异步注册，等 `onInitiate` 阶段）；检查 ToolRegistry enable/disable 状态

**"Feature 打包后装配不上"**
→ 检查导出类名是否以 `Feature` 结尾；检查 package.json `main` 指向 dist；元数据规范以 ADR-0017（Manifest v2）为准

## 五、相关文档

- [AGENT.md](../../AGENT.md) — 仓库边界、问题归属判定、依赖形态
- [ADR-0002](../adr/0002-session-continuity-as-transformation.md) — 会话连续性三层模型
- [ADR-0003](../adr/0003-agentdev-package-split-no-umbrella.md) — 框架包结构拆分（本文路径布局的由来）
- [ADR-0017](../adr/0017-feature-manifest-and-registry.md) — Feature Manifest v2 与宿主侧 Registry
