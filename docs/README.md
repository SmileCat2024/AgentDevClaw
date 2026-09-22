# docs/ — 文档地图

按"你想做什么"导航。各目录的用途约定与写文档规范见文末。

## 了解产品与架构

- [产品总览](agentdev-claw-product-overview.md) — AgentDev + Claw 产品全貌
- [架构图](architecture/agentdevclaw-architecture.html) — 系统架构可视化（浏览器打开；visual-check 验证件为本地产物）
- [开发上下文索引](dev-context-index.md) — AgentDev 框架与 Claw 的跨仓库连接关系速查
- [领域词汇表](glossary.md) — 工程开发术语 + Avoid 负面清单（运行时协议术语见根 `CONTEXT.md`）

## 改代码前

- [AGENT.md](../AGENT.md) — agent 认知地图（入口，含 ADR 索引与协作纪律）
- [前端渲染机制与常见陷阱](frontend-rendering-patterns.md) — 涉及前端 UI / workspace 切换必读
- [输入区行为契约](input-area-behavioral-contract.md) — 输入区重构基线
- [Runtime input lease 协议](runtime-input-lease-protocol.md)
- [CLI 调用 Schema](cli-calling-schema.md)
- [Feature 元数据](feature-metadata.md)

## 查设计决策

- [adr/](adr/) — 架构决策记录（编号递增；改动相关领域前先读对应篇）
- [plans/](plans/) — 设计与执行计划（SSE 改造、group-chat 系列、compact/trim、IM 渠道转接、CLI 重设计等）

## 排查问题

- [investigations/](investigations/) — 问题调查与分析
- [audits/](audits/) — 对抗性审查与审计报告（SSE 改造评审、显式寻址审计、测试覆盖审计等）
- [Postmortem: handoff 环境变量泄漏](postmortem-2026-07-09-handoff-env-leak.md)
- [Coder ACP 排障](coder-acp-troubleshooting.md)

## 工单与发布历史

- [tickets/](tickets/) — 工单记录（`remote-access/` 子目录为远程访问系列）
- [release-notes/](release-notes/) — 版本发布说明

## 本地文档（不入库）

- `cases/` — 50 用例反思与框架校准研究
- `stress/` — 压力测试素材
- `design-proposals/` — 探索性设计草案

## 写文档的约定

- **类型与去向**：架构决策 → `adr/`（编号递增，含状态标记）；设计 / 执行计划 → `plans/`；问题调查分析 → `investigations/`；审查 / 审计 → `audits/`；发布说明 → `release-notes/`；协议契约 / 行为规范等长期活文档 → 根级（与 glossary 同级）
- **命名**：`plans/` `investigations/` `audits/` 用 `YYYY-MM-DD-主题.md`；同主题系列共用前缀（如 `sse-migration-*`、`group-chat-*`）
- **入库**：`adr/` `tickets/` `plans/` `investigations/` `audits/` `release-notes/` 目录经 gitignore 白名单自动入库；根级活文档逐文件 `git add -f`；`cases/` `stress/` `design-proposals/` 与 visual-check 验证件保持本地
- **引用**：统一用 `docs/<路径>.md` 形式引用（从仓库根视角）；移动文件时同步更新引用，全库断链扫描可验证：`grep -rhoE "docs/[A-Za-z0-9._/-]+\.md" --include="*.md" AGENT.md README.md CONTEXT.md docs/ | sort -u` 后逐项检查目标存在
