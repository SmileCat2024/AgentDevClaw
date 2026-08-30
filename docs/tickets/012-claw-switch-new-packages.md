# 012: Claw — 全量切换至 @agentdev/* 新包（批次 3 原子收口）

- 批次：3（收口票；与 010、011 原子合入）
- 前置：010、011 完成
- 依据：ADR-0003 决策 1
- 仓库：D:\code\AgentDevClaw

## 背景

Claw 当前 27 处 `from 'agentdev'`（agents/coder、prebuilt-agents、scripts、server、test），零深路径导入。破坏性切换要求全部改名，不留 `agentdev` 精确包名残留。

## 实施步骤

1. `package.json`：`agentdev` → 按实际使用面拆为 `@agentdev/core` + `@agentdev/llm` + `@agentdev/viewer` + `@agentdev/mcp`
2. 全量 import 改名（27 处清单在批次 2 的 008 审查窗口已产出，直接消费）
3. feature import 路径调整：留 core 白名单的 feature（LspFeature、TodoFeature、UserInputFeature、OutputGuardFeature 等）改从 `@agentdev/core`；已独立成包的按包名
4. `use-agentdev-local` / `check:agentdev` 预检脚本适配 junction 目标变化（`node_modules/agentdev` → `node_modules/@agentdev/core`，注意 scope 目录）
5. `workspace-creators.js` 生成模板同步新 import 形态
6. 悬置代码处置（Claw 内部决策，随本票执行时定夺）：flow-workspace / agent-creator / feature-creator / dispatch-console 及悬置 local-features——下线或迁移 import，不阻塞切换主线
7. 文档全量更新：CLAUDE.md（3D/3E 消费路径速查表、第 7 节构建流程、agentdev:local 语义）、agents/README.md、docs/dev-context-index.md
8. `npm test` 全量 + 编程小助手 / qqbot / agent-studio 冒烟

## 验收标准

- `grep "from 'agentdev'"` 零残留（`@agentdev/*` 除外）
- `npm test` 全绿；三个主力工作空间冒烟通过
- `npm start` 预检（junction 检查）在新路径下工作

## 风险与回滚

- 悬置 agent 断链需同批处理，否则启动扫描即崩
- junction 脚本遗漏会导致 prestart 失败——步骤 4 是易漏点
- 回滚：原子批次整体回退

## 阻塞项 / 未决

- 悬置代码"下线 vs 迁移"的最终定夺留待执行时（属 Claw 内部事务，不属框架分层决策）
