# 006 — AgentDev 官方变换实现与基座下沉

- **仓库**：AgentDev（`D:\code\AgentDev`），源码来自 AgentDevClaw
- **决策依据**：grill 批次 2 Q1=C（官方实现=可替换参考实现）、Q3=A（LLM 进程
  内注入）；前置依赖 005 契约层；原则见
  [ADR-0002](../adr/0002-session-continuity-as-transformation.md)
- **类型**：从 Claw 下沉三个已稳定模块 + 新增一个官方 summary 实现

## 背景

Claw 侧三块接续资产已稳定运行且耦合度极低（见批次 README 引言的耦合点
评估）：trim 策略引擎（零 Claw 依赖）、seed 注入 feature（已是标准 feature
形态，仅 import agentdev）、feature continuity 协议（标准 feature 形态但协议
名带 claw 前缀）。本票将它们以官方参考实现身份下沉框架。

## 执行步骤

1. **trim-transcript 引擎**：移植 `server/context-continuity/handoff-package.js`
   的策略引擎（`DEFAULT_EXPORT_POLICY` 的 fold/drop/keep/keepRecentTurns/
   preserveRanges 全策略面）为框架模块，实现 005 的 Transformation 契约。
   操作的 messages schema 本就是框架 Context 的，移植面主要是去掉
   `childProcessEnv` 等宿主小依赖。
2. **Seed 注入 feature**：移植 `local-features/context-handoff-seed` 为
   `src/features/` 下标准框架 feature（建议名 `handoff-seed`）。随迁已解决的
   关键实现：typed Context API 注入（messages/enrichedMessages 同步）、
   seed turn 对齐与 `_callIndex` 推进、serialized tool message 重放。
   env 传递约定（`PROTOCLAW_HANDOFF_PATH`）留宿主，框架只提供 feature 类。
3. **feature continuity 协议中性化**：移植 `local-features/continuity-participant`
   的 descriptor 协议，字段名 `__claw_continuity__` 与协议名
   `claw.feature-continuity.v1` 改为框架中性命名（如
   `__agentdev_continuity__` / `agentdev.feature-continuity.v1`）。Claw 侧
   feature-wrappers 的既有包装类随 008 对齐。
4. **官方 summary 实现（新增）**：基于 005 的 `transformContext.llm` 注入
   实现摘要变换（prompt 以 `claude-compact-prompts.js` 为蓝本）。**不移植**
   mirror 子进程管线——那是 Claw 装配细节（模型配置来源），由 008 决定
   Claw 何时切换到进程内注入。
5. 测试随迁：`test/session-summary.test.js` / context-compaction 相关用例中
   属于策略引擎的部分改为针对框架实现的测试。

## 执行前需收敛（本票阻塞项）

- **组合语义**：trim&summary 混合是实现为「组合子」（`compose(trim, summary)`
  通用机制）还是官方单实现（现状 `trim-transcript-with-summary` 是硬编码
  混合模式）。倾向：官方单实现先落（现状语义 1:1 迁移），组合子等第一个
  真实自定义变换出现再抽象，避免为假设需求设计。

## 验收标准

- 三个移植模块在 AgentDev 侧 build + 测试全绿。
- trim 引擎对同一输入产出的 seed 与 Claw 现实现逐字节等价（迁移期间以
  Claw 现行测试数据做 golden 对照）。
- `src/features/handoff-seed` 经标准 feature 装配可完成一次端到端注入
  （挂到任一框架测试 agent 上验证）。

## 风险提示

- 中性化改名触及快照数据的持久化字段：已落盘的 `__claw_continuity__` 字段
  在 Claw 历史会话中存在，008 切换时需读旧写新（一次性兼容读取，不保留
  双写）。
- summary 官方实现的 llm 注入接口若在 005 定得过窄（如缺多轮调用），
  以本票实现的真实需要回改 005 接口，宁可在批次内改契约也不带病落地。
