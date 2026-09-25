# docs/ — 文档地图

按"你想做什么"导航。各目录的用途约定与写文档规范见文末。

## 了解产品与架构

- [产品总览](reference/agentdev-claw-product-overview.md) — AgentDev + Claw 产品全貌
- [开发上下文索引](reference/dev-context-index.md) — AgentDev 框架与 Claw 的跨仓库连接关系速查
- [领域词汇表](reference/glossary.md) — 工程开发术语 + Avoid 负面清单（运行时协议术语见根 `CONTEXT.md`）
- [架构图](architecture/) — 系统架构可视化产物（浏览器打开 html；visual-check 验证件为本地产物）

## 改代码前

- [AGENT.md](../AGENT.md) — agent 认知地图（入口，含 ADR 索引与协作纪律）
- [前端渲染机制与常见陷阱](reference/frontend-rendering-patterns.md) — 涉及前端 UI / workspace 切换必读（活文档）
- [Runtime input lease 协议](protocols/runtime-input-lease-protocol.md)
- [输入区行为契约](protocols/input-area-behavioral-contract.md)
- [CLI 调用 Schema](protocols/cli-calling-schema.md)
- [Claw 服务生命周期契约](protocols/service-lifecycle.md)
- [Feature-Panel 通信基座接入指引](protocols/feature-communication.md) — feature-comms 通道：声明 / 发布 / 订阅 / onHostRequest（ADR-0018）
- [Feature 元数据（v1，已被 ADR-0017 取代）](protocols/feature-metadata.md)

## 查设计决策

- [adr/](adr/) — 架构决策记录（编号递增；改动相关领域前先读对应篇）
- [plans/](plans/) — 设计与执行计划（SSE 改造、group-chat 系列、compact/trim、IM 渠道转接、CLI 重设计、dsh 差异化战略等；含悬置域 Flow 系列与 ACP 适配器设计）

## 排查问题

- [investigations/](investigations/) — 问题调查、分析与复盘（含 postmortem）
- [audits/](audits/) — 对抗性审查与审计报告
- [Coder ACP 排障](reference/coder-acp-troubleshooting.md)

## 工单与发布历史

- [tickets/](tickets/) — 工单记录（`remote-access/` 子目录为远程访问系列）
- [release-notes/](release-notes/) — 版本发布说明

## 本地文档（不入库）

- `cases/` — 50 用例反思与框架校准研究
- `stress/` — 压力测试素材
- `design-proposals/` — 探索性设计草案

## 写文档的约定

### 类型与去向

| 类型 | 去向 | 命名 |
|---|---|---|
| 架构决策 | `adr/` | `NNNN-主题.md`（编号递增，含状态标记） |
| 设计 / 执行计划 / 战略 | `plans/` | `YYYY-MM-DD-主题.md`；同主题系列共用前缀（如 `sse-migration-*`、`group-chat-*`） |
| 问题调查 / 分析 / 复盘 | `investigations/` | `YYYY-MM-DD-主题.md`（postmortem 用 `postmortem-YYYY-MM-DD-主题.md`） |
| 审查 / 审计报告 | `audits/` | `YYYY-MM-DD-主题.md` |
| 发布说明 | `release-notes/` | `vX.Y.Z.md` |
| 协议契约 / 行为规范 | `protocols/` | 自由命名 |
| 长期参考 / 活文档 | `reference/` | 自由命名 |

根级只放本地图（README.md），不放任何文档。

### 文档生命周期（过时处理）

- **被取代**：新方案经 ADR 或新文档裁决后，旧文档**不删**，头部加引用块声明"状态：已被 X 取代"，正文保留作当时行为的参考（例：`protocols/feature-metadata.md`）。
- **活文档**：持续积累的参考（如 frontend-rendering-patterns）头部标注"活文档"性质与"最后更新"日期；每次增补时刷新。
- **域悬置 / 功能下线**：相关设计与计划移入 `plans/` 留档（历史决策有价值，位置归类即可），入口文档不再指向它；AGENT.md 保留一句悬置说明。
- **发现过时内容**：直接修正到与当前代码一致；无法确认时在对应段落标记"待核实"，不要凭记忆改写。

### 入库

`adr/` `tickets/` `plans/` `investigations/` `audits/` `release-notes/` 目录经 gitignore 白名单自动入库；`reference/` `protocols/` 逐文件 `git add -f`；`cases/` `stress/` `design-proposals/` 与 visual-check 验证件保持本地。

### 引用与断链

统一用 `docs/<路径>.md` 形式引用（从仓库根视角）；同目录互引可用相对路径。移动文件时同步更新全库引用。断链扫描两条都要跑：

```bash
# 1. docs/ 前缀引用
grep -rhoE "docs/[A-Za-z0-9._/-]+\.md" --include="*.md" AGENT.md README.md CONTEXT.md docs/ | sort -u
# 2. 相对引用（逐文件检查目标存在）
for f in AGENT.md README.md CONTEXT.md docs/*.md docs/*/*.md; do
  dir=$(dirname "$f")
  grep -oE '\]\([^)#]+\.md' "$f" | sed -E 's/\]\(//' | grep -vE "^docs/|^http|^/"
  | while read ref; do [ ! -f "$dir/$ref" ] && echo "$f -> $ref"; done
done
```

扫描结果应收敛到零，或明确确认的例外（如计划文本中对未来产出的引用）。
