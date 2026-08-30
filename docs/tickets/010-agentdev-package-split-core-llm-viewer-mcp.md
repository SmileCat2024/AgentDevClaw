# 010: AgentDev — 包结构原子拆分（core / llm / viewer / mcp，agentdev 退役）

- 批次：3（库结构原子重构；本票与 011、012 构成原子批次，不对外发布中间态）
- 前置：009 完成（BasicAgent 纯基类化后 core 才干净）
- 依据：ADR-0003 决策 1/2/3/4/5
- 仓库：D:\code\AgentDev

## 背景

单包全量捆绑的现状与拆分依据见 ADR-0003。目标分层：

| 包 | 内容 | 依赖纪律 |
|---|---|---|
| `@agentdev/core` | Agent / Context / ToolRegistry / lifecycle / message / Feature 系统 / FileSessionStore / session-events / logging / template / skills 系统 / BasicAgent+TemplateComposer（纯基类）/ LLM 与 MCP **契约类型** / continuity（005）/ WorkThread（007）/ 轻量内置 feature 白名单 | 零原生依赖、零重 SDK、零 feature 包反向依赖 |
| `@agentdev/llm` | AnthropicLLM / OpenAILLM / OpenAIResponsesLLM / createLLM / compile* | 依赖 core |
| `@agentdev/viewer` | ViewerWorker / viewer-html（DebugHub IPC 协议类留 core——logging 契约依赖它） | 依赖 core |
| `@agentdev/mcp` | MCP 集成 + MCPFeature | 依赖 core + MCP SDK |
| `@agentdev/feature-*` | 现有 packages/* 生态包 | peer 依赖 core（011 处理） |

轻量内置 feature 白名单（留 core bundle，须逐一验证零原生零重 SDK）：lsp、todo、user-input、skill、subagent、file-history、opencode-basic、output-guard。

## 实施步骤

1. AgentDev 转 npm workspace：新增 `packages/core`、`packages/llm`、`packages/viewer`、`packages/mcp`，锁步版本 0.1.0（changesets 或脚本保障）
2. 按上表迁移源码；`src/` 顶层结构同步收缩
3. 双路径收敛：9 对（shell / audit / audio-feedback / memory / qqbot / tts / visual / websearch / plugin-compat）移出 `src/features`，唯一源码在 `packages/*`；sharp 随 visual、better-sqlite3 随 audit 归位
4. `agentdev` 主包退役：最后发布版标记 deprecated，指向新包组合
5. tsup / eslint / vitest 基建适配 workspace 结构
6. CI 新增断言：`@agentdev/core` 的 dependencies 不含原生模块与重 SDK

## 验收标准

- `@agentdev/core` 依赖清单零原生、零重 SDK（CI 断言生效）
- 9 对双路径在 AgentDev 仓库只剩一份源码（grep 验证）
- 四个新包各自可独立 install 且测试绿
- npm 上 `agentdev` deprecated 指引生效

## 风险与回滚

- workspace 改造工程量最大（构建、测试、发布脚本全动）；锁步版本纪律需要机械保障
- 回滚：原子批次整体回退

## 阻塞项 / 未决

- DebugHub 的最终切分（协议类留 core、服务端归 viewer）在实施时以 logging 契约的实际 require 图为准，允许微调
- `create-feature` 脚手架模板的默认依赖域在本票内同步调整（生成新 feature 项目默认 peer 依赖 `@agentdev/core`）
