# 005 — AgentDev Continuity 契约层

- **仓库**：AgentDev（`D:\code\AgentDev`）
- **决策依据**：grill 批次 2 Q1=C（两层契约）、Q2=C（契约级 session 消费面）、
  Q3=A（进程内 LLM 注入）、Q6=WorkThread 命名；原则记录见
  [ADR-0002](../adr/0002-session-continuity-as-transformation.md)
- **类型**：新增契约与类型，零运行时行为变化

## 背景

Claw 的会话接续协议当前散落三处且耦合宿主：`server/context-continuity/`
（交接物编译）、`server/routes/session-handoff-helpers.js`（编排）、
`local-features/context-handoff-seed`（注入消费）。框架侧没有任何接续概念。
本票建立框架契约层，是后续 006（官方实现下沉）与 007（WorkThread 核心）的
前置依赖。

## 执行步骤

1. `src/core/continuity/` 新建契约模块（建议名，落点以框架目录惯例为准）：
   - **Transformation 窄契约**（Q1 核心）：
     ```ts
     interface SessionTransformation {
       id: string;                      // 如 'official.trim-transcript'
       transform(input: TransformInput, ctx: TransformContext): Promise<SuccessorSeed>;
     }
     interface TransformInput {
       sourceSnapshot: AgentSessionSnapshot;  // 复用 session-store 既有类型（Q2 契约级）
       policy?: Record<string, unknown>;      // 变换自定义策略面
     }
     ```
   - **SuccessorSeed 契约**：以 Claw 现行 handoff JSON（`HANDOFF_SCHEMA_VERSION=1`
     的 seedMessages / featureContinuity / importantFiles / importantSkills /
     fileRanges / 元信息）为蓝本框架化，保留版本字段。
   - **TransformContext.llm 注入接口**（Q3=A）：宿主注入 LLM 调用能力
     （摘要类变换的执行基座），接口形态从官方 summary 实现的真实需要出发
     定义，不预设工具调用等重能力。
2. `index.ts` 导出契约类型（遵守 ADR-0001 按引用导出判据：契约类型即公共面，
  随 006 官方实现引用一并导出亦可，以 006 落地时最小导出为准）。
3. 不做：会话列表/分支/归档管理（Q2 显式留宿主）、宽边界编排（属 007 默认
   实现层）、变换的 npm 分发（暂走框架 dist 路径，无双路径问题）。

## 执行前需收敛（本票阻塞项）

- **变换注册/发现机制**：静态 import 官方实现 + 宿主传入实例（最简）vs
  manifest/注册表（为未来第三方包预留）。倾向前者，待实施时定案。
- **SuccessorSeed 版本化与兼容策略**：`schemaVersion` 递增规则与旧 seed 的
  拒绝/迁移语义。

## 验收标准

- `npm run build` 成功，框架测试全绿。
- 契约类型可从 `agentdev` 入口 type-level import。
- 窄契约接口评审通过：`transform` 输入输出不包含任何 Claw 私有概念
  （prebuilt session、managed runtime 等）。

## 风险提示

- 契约一旦被 006/007 及 Claw 消费即成长期契约，字段命名一次定准；
  SuccessorSeed 直接以已稳定运行的 handoff JSON v1 为蓝本可显著降低风险。
