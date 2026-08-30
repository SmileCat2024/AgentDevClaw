# 011: 生态包 — peer 依赖 @agentdev/core 切换 + tgz 重发

- 批次：3（与 010、012 原子合入，不发布中间态）
- 前置：010 完成（新包已发布）
- 依据：ADR-0003 决策 1/2/3
- 仓库：D:\code\AgentDev（packages/*）→ D:\code\AgentDevClaw（resources/features）

## 背景

15 个 `packages/*` 生态包当前 `dependencies: agentdev`（常规依赖）。拆分后应改为 peer 依赖 `@agentdev/core`，避免生态包各自捆绑框架、保证宿主侧 core 单例。

## 实施步骤

1. 15 个 packages/* 逐包调整：`dependencies.agentdev` → `peerDependencies.@agentdev/core`；用到 LLM 实现的包补 `@agentdev/llm`
2. 各包版本推进、构建、`npm pack`
3. 全量同步 Claw `resources/features/`（15 个 tgz 替换）
4. Claw `package-lock.json` integrity 更新与重装（按 CLAUDE.md 第 7 节既定流程处理 EINTEGRITY）
5. agent-studio 消费链验证：catalog 双源扫描（官方仓库 + user-features）、resolver、provisioner 在新 peer 结构下工作正常

## 验收标准

- Claw `npm install` 后 `node_modules/@agentdev/*` 全部为新 peer 结构
- agent-studio 快照安装与 agent-debug 模式冒烟通过
- `grep` 确认 packages/* 无残留 `agentdev`（非 `@agentdev/`）依赖声明

## 风险与回滚

- integrity hash 踩坑（有既定流程兜底）；15 包一次性重发的协调成本
- 回滚：原子批次整体回退

## 阻塞项 / 未决

无。
