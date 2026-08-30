# Tickets 索引

## 批次 1：AgentDev 下游暴露面改进（P0）（2026-08-21）

来源：2026-08-21 grill 会话（Round 1，Q1–Q4 全部确认）。
上游调研：AgentDev 框架四条暴露通道（npm 导出 / ViewerWorker API / 通知与事件流 /
debugger MCP）对照 Claw 侧实际消费的缺口检查。

## 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| Q1 | 范围 | **只做 P0**：类型整理 + 导出补齐，零运行时行为变化。P1（hook 观测通道）、P2（debugger MCP 扩面）暂缓 |
| Q2 | 导出判据 | **"已被公共面引用"才导出**，不按"将来可能有用"。快照类型族（HookInspectorSnapshot / AgentOverviewSnapshot / TodoPlanSnapshot / Notification / API 响应类型）暂缓，等第一个真实 TS 消费者出现 |
| Q3 | 同名冲突修法 | 通知版（types.ts）重命名为 **`AgentRuntimeStateSnapshot`** 并导出；持久化版（session-store.ts）保持 `AgentRuntimeSnapshot` 原名。`UsageInfo` 双定义合并方向由依赖方向锁定：权威定义放 usage.ts，types.ts re-export |
| Q4 | 报告佐证修正 | 承认混淆：Claw 直接改写会话文件 `runtime.usageStats`（session-token-refresh.js）是**数据所有权问题**，类型导出解决不了；本次只解决"读"的类型契约，写越权单独记债（见 004） |

原则性决策已固化为 [ADR-0001](../adr/0001-agentdev-export-surface-governance.md)。

## 本批 tickets

执行顺序：**001 → 002 → 003 线性串行**（001/002 同改 `types.ts` + `index.ts`，
禁止并行；003 核查的是终态导出面，必须在 001/002 之后）。004 为债务记录，
不参与调度。

| 票 | 仓库 | 内容 |
|----|------|------|
| [001](001-agentdev-usage-type-consolidation-and-export.md) | AgentDev | UsageInfo 双定义合并 + usage 类型族导出 |
| [002](002-agentdev-split-runtime-state-snapshot.md) | AgentDev | 通知版 AgentRuntimeSnapshot 拆分重命名并导出 |
| [003](003-agentdev-export-reference-closure-types.md) | AgentDev | 已导出类型的引用闭包核查与补齐（FeatureCheckpoint 等） |
| [004](004-claw-usagestats-session-write-debt.md) | AgentDevClaw | 越权写路径债务记录（不排期，不修复） |

## 术语区分（本次讨论 crystallize）

- **AgentRuntimeStateSnapshot**（新名，原 types.ts 内部 `AgentRuntimeSnapshot`）：
  实时运行时状态，由通知系统驱动，经 `/api/agents/:id/notification` 的 `runtime`
  字段与 overview 合并返回。字段：stage / callActive / charCount / lastOutcome 等。
- **AgentRuntimeSnapshot**（session-store.ts，维持原名）：可序列化持久化快照，
  出现在会话文件 `runtime` 字段与 `AgentSessionSnapshot` 中。字段：
  initialized / callIndex / context / featureStates / usageStats / lastCallOutcome。
- **读契约 vs 写路径**：类型导出只覆盖"下游如何正确读框架数据"；
  "下游能否直接写框架持久化数据"是独立的数据所有权问题，两者不得混同。

## 明确暂缓项（决策树已关闭的分支及重开条件）

| 项 | 暂缓理由 | 重开条件 |
|----|---------|---------|
| Hook 执行观测进 DebugHub（P1） | 通道形态（环形缓冲大小 / 推送粒度 / 节流）取决于第一个真实消费者；当前唯一需求方 studio runtime 仅 console 打印，形态定了易返工 | 出现需要跨进程消费 hook 调用历史（耗时 / decision）的真实场景 |
| debugger MCP 扩面（P2） | 依赖 P1 数据先到位；当前诊断盲区可由 query_logs 部分覆盖 | P1 落地后 |
| 快照类型族导出 | 零 TS 消费者，导出即公共契约 | 第一个 TS 消费者出现（如 Claw server 层 TS 化、外部 plain agent 开发者需要） |
| `UsageInfo`（types.ts 版）双定义之外的文档漂移（dev-context-index.md 的 EnrichedMessage） | Q1=a 范围外 | 下次更新该文档时顺带修正 |

## 验收与发布注意（全批次通用）

- AgentDev 侧：`npm run build` + 框架测试全绿；导出面冒烟测试（type-level import
  断言，tsc 不会因"漏导出"报错）由 003 统一创建。
- Claw 侧验证：本机 junction（`npm run agentdev:local`）下，在任一 TS 文件
  `import type { ... } from 'agentdev'` 能解析即生效；无需运行时验证。
- 发布：新增导出 + 重命名（零破坏）按 semver 应 bump minor；走现有
  agentdev:local / agentdev:published 机制，package-lock 保持 registry 解析。

---

## 批次 2：Session Continuity 与 WorkThread 框架化（2026-08-21）

来源：2026-08-21 grill 会话（第二轮 Q1–Q6 全部确认）。上游调研：Claw 上下文
接续协议（context-continuity 三模块 + handoff 编排 + seed feature）与
2026-08-20 WorkThread 设计（server/thread-control/ 七模块）的耦合点评估——
结论为数据层与消费层近零耦合可下沉、控制面核心机制通用、宿主接线
（integration/rotation/gateway/路由/前端）为 Claw 产品本体不迁移。

### 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| Q1 | 变换抽象边界 | **两层**：窄契约 `transform(sourceSnapshot, policy) → SuccessorSeed` 为核心；宽边界编排（successor 创建/接力收口）作为框架可替换默认实现 |
| Q2 | Session 一等公民程度 | **分阶段**：本批只做变换所需契约级消费面（快照契约），列表/分支/归档管理留宿主；对象级上收为远期方向不堵死 |
| Q3 | 摘要变换 LLM 基座 | **进程内注入**：框架提供 `transformContext.llm` 注入点；mirror 子进程降级为 Claw 实现细节（008 切换后删除） |
| Q4 | WorkThread 职责纯度 | **拆开 + 可选看板**：框架 WorkThread = 连续性锚点 + 接续编排状态（rotating/rotation_failed）；执行调度看板（idle/running/waiting_input/failed、executionEvents、resume、mode）为平行可选模块 WorkThreadBoard，永不反写锚点状态 |
| Q5 | WorkThread 创建时机 | **显式 opt-in**：`workThread.start({ sessionRef })` 唯一创建入口，支持认既有会话为 root；Claw coder 自动建线程是宿主策略非框架语义 |
| Q6 | 命名 | 框架概念定名 **WorkThread**；codex exec 契约 `thread.started`（thread=会话）原样保留永不改义；Claw HTTP/CLI 对外名不动 |

原则性决策已固化为 [ADR-0002](../adr/0002-session-continuity-as-transformation.md)。

### 本批 tickets

执行顺序：**005 → (006 ∥ 007) → 008**。006/007 分别依赖 005 契约与
WorkThread 命名，互不依赖可并行；008 是 Claw 侧一次性消费切换，依赖前两者
全量落地。

| 票 | 仓库 | 内容 |
|----|------|------|
| [005](005-agentdev-continuity-contract.md) | AgentDev | Continuity 契约层（Transformation 窄契约 / SuccessorSeed / llm 注入接口） |
| [006](006-agentdev-official-transforms-foundation.md) | AgentDev | 官方变换与基座下沉（trim 引擎 / handoff-seed feature / continuity 协议中性化 / summary 新实现） |
| [007](007-agentdev-workthread-core.md) | AgentDev | WorkThread 核心（锚点+接续编排）+ 可选看板 WorkThreadBoard + 职责拆分 |
| [008](008-claw-consume-framework-continuity.md) | AgentDevClaw | 消费切换与瘦身（import 切换 / 接线保留 / mirror 删除 / CLAUDE.md 更新） |

### 术语区分（本次讨论 crystallize）

- **Session**：第一等单位，可恢复、可审计的对话与状态载体。事件流契约中
  codex 术语 thread 指的也是它（`thread.started` = 会话开始），永不改义。
- **Transformation（变换）**：session → SuccessorSeed 的接续变换，绝对自由的
  框架扩展点。trim / summary / trim&summary 是官方参考实现，不是内建策略。
- **SuccessorSeed**：变换产物，下一个 session 的种子数据（seedMessages +
  featureContinuity + 重要文件/技能元信息），以现行 handoff JSON v1 为蓝本。
- **WorkThread**：框架对「Session + 接续变换」的封装——sessionChain 线性链
  （每条边记录一次变换）、head 承接、交接挡板（pendingSuccession）、指令
  暂存 Inbox。连续性锚点，非调度器、非工单、不含执行状态。
- **WorkThreadBoard（看板）**：平行可选模块——执行状态机、executionEvents
  审计、resume。与 WorkThread 经 id 关联，永不反写锚点状态。

### 明确暂缓项（决策树已关闭的分支及重开条件）

| 项 | 暂缓理由 | 重开条件 |
|----|---------|---------|
| 组合子机制（`compose(trim, summary)` 通用组合） | trim&summary 现状是官方单实现硬编码混合，无第二个真实组合需求 | 第一个真实自定义组合变换出现 |
| Session 对象级上收（列表/分支/归档进框架） | 变换契约不需要会话管理权；Claw 会话体系约 2000 行迁移工程量大 | 出现第二宿主需要框架级会话管理，或 Claw 主动启动上收 |
| 双基座（进程内 llm + 子进程 mirror 并存） | mirror 的动机全是 Claw 装配问题，非变换本体需要 | 官方 summary 实现验证中发现注入式 llm 无法覆盖的场景（如必须完整 agent 环境的变换） |
| WorkThreadBoard 是否随 008 同期接线 | 看板语义（昨日刚推翻重构）仍在演化，不阻塞核心切换 | 008 执行时按当时 Claw 调度字段现状定 |
| 多宿主进程共用 WorkThread store 的并发定义 | 当前单宿主前提 | 第二宿主出现 |

### 验收与发布注意（全批次通用）

- AgentDev 侧：`npm run build` + 框架测试全绿；本批全部走框架 dist 路径
  （src/core + src/features），**无双路径纪律负担**（不新增 packages/* tgz）。
- Claw 侧验证：本机 junction 下全量 `npm test` + coder 接力端到端 +
  PH 纯会话零影响对照；切换后必须整服重启（框架 dist 变更语义）。
- 发布：新增公共面按 semver bump minor；WorkThread store 数据目录由宿主
  传入（Claw 现行 `~/.agentdev/AgentDevClaw/threads/` 不迁移）。

---

## 批次 3：库结构原子重构（009–012，未开工）

来源：2026-08-21 grill 会话（第二轮 R1–R5 全部确认）。上游调研：agentdev
单包全量捆绑诊断（无 exports 字段 / tsup bundle 全部 / 重依赖全量携带）、
9 对双路径 feature、BasicAgent 反向依赖 4 个 feature、sharp 与
better-sqlite3 的全库唯一引用点、MCP 在 core 的 type-only 耦合、Claw 27 处
import 零深路径。前置认知：批次 2 的 continuity 契约与 WorkThread 正在进
主包——框架的根本差异点不应埋进全量桶。

### 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| 切换方式 | 破坏性切换 | **无伞包、无兼容层、无并存版本**：框架发包 + 15 tgz 重发 + Claw 切换在同一原子批次完成 |
| 包名 | `agentdev` 退役 | npm deprecated 指向新包；新名 `@agentdev/core` / `@agentdev/llm` / `@agentdev/viewer` / `@agentdev/mcp` / `@agentdev/feature-*` |
| core 纪律 | 零重依赖 | 零原生依赖、零重 SDK、零 feature 包反向依赖；LLM 与 MCP 只留契约类型；CI 断言 |
| BasicAgent | 纯基类化 | 内置装配全部移除（SubAgent / MCP / Skill / OpencodeBasic），装配权归还宿主；ExplorerAgent 同步；接受破坏性变更 |
| 原生依赖归位 | 随能力域走 | sharp → visual 包；better-sqlite3 → audit 包（viewer 不背 sqlite） |
| 双路径 | 收敛 packages/* | 9 对全部移出 `src/features`，框架 dist 不再 bundle 生态 feature |
| 版本 | 0.1.0 起步 | 0.x 保留破坏自由；接续协议与 WorkThread 稳定后再 1.0 |
| 时机 | 008 之后 | **即时生效项**：007 WorkThread 落位即按 core 域纪律（`src/core/workthread/`，不 import features/llm/viewer） |

原则性决策已固化为 [ADR-0003](../adr/0003-agentdev-package-split-no-umbrella.md)。

### 本批 tickets

执行顺序：**009 → 010 → 011 → 012**。009（BasicAgent 纯基类化）可与批次 2
并行，不触碰 continuity / WorkThread 文件；010–012 构成原子批次，不对外
发布任何中间态。

| 票 | 仓库 | 内容 |
|----|------|------|
| [009](009-agentdev-basicagent-pure-base.md) | AgentDev | BasicAgent / ExplorerAgent 纯基类化（移除全部内置装配） |
| [010](010-agentdev-package-split-core-llm-viewer-mcp.md) | AgentDev | workspace 化 + core/llm/viewer/mcp 四包拆分 + 双路径收敛 + agentdev 退役 |
| [011](011-ecosystem-peer-switch-tgz-republish.md) | AgentDev → Claw | 15 个生态包 peer 依赖切换 + tgz 重发 + integrity 更新 |
| [012](012-claw-switch-new-packages.md) | AgentDevClaw | Claw 全量切换新包（import / 模板 / junction 脚本 / 文档 / 悬置代码处置） |

### 术语区分（本次讨论 crystallize）

- **伞包（umbrella package）**：只 re-export 子包、不实现功能的门面包，
  用于多包拆分后的迁移兼容。**本批明确 rejected**——它制造永久过渡态与
  双链路，与"链路唯一"原则冲突。_langchain 的 `langchain` 伞包是其生态
  迁移策略，不适用于本产品。_
- **core 纪律**：`@agentdev/core` 的三条不可违反约束——零原生依赖、零重
  SDK、零 feature 包反向依赖。core 是框架差异点（接续协议、WorkThread）
  的宿主，必须可被第三方单独依赖。
- **原子批次**：批次内允许多 PR 分步合入（框架先、Claw 后），但不对外
  发布任何"新旧并存可用"的版本——npm 上不出现伞包过渡版，Claw 不存在
  双依赖窗口。

### 明确暂缓项（决策树已关闭的分支及重开条件）

| 项 | 暂缓理由 | 重开条件 |
|----|---------|---------|
| DebugHub 协议类与 viewer 的最终切线 | 以 logging 契约实际 require 图为准（010 执行时定） | 010 实施中 |
| 轻量内置 feature 白名单的逐包验证 | 白名单已定（lsp/todo/user-input/skill/subagent/file-history/opencode-basic/output-guard），但每个都需验证零原生零重 SDK | 010 实施中，不达标者移出 |
| 悬置代码处置（下线 vs 迁移） | Claw 内部事务，不属框架分层决策 | 012 执行时 Claw 自行定夺 |
| `@agentdev/core` 1.0 | WorkThread / continuity 仍在快速演化，现在承诺 semver 稳定会频繁 major | 两者稳定后 |

### 验收与发布注意（全批次通用）

- AgentDev 侧：workspace 四包各自独立 install + 测试绿；CI 断言 core 依赖
  清单零原生零重 SDK；`agentdev` npm deprecated 生效。
- Claw 侧：`grep "from 'agentdev'"` 零残留；`npm test` 全绿；PH / qqbot /
  agent-studio 冒烟；junction 预检脚本在新 scope 路径下工作。
- 发布：**一次性原子切换**，无 semver 渐进；本机联动（agentdev:local →
  新包 junction）机制由 012 重写。

---

## 批次 4：coder 运行质量修正（013–015）（2026-08-21）

来源：2026-08-21 coder 会话质量审计（会话 79761-146c84 与 80590-8e766c
双会话证据链）+ thread 配置链路核查。上游调研：debugger MCP 事件流、
线程存储、guard/rotation 接线源码、两侧 grep 事实。

### 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| Q1 | read 去重短路 | **彻底移除**（013）：正确性优先于 token 优化；三独立样本实测踩坑。readDedupState 双职责只移除去重，先读后写保护保留 |
| Q2 | guard→rotation 判定基准 | **会话归属**（已落地 993dd7f）：事件响应钩子去 agentId 白名单；THREAD_HOST_AGENT_IDS 收窄为环境存在性开关（创建 + 路由闸）。与 007/008 分层对齐：框架管锚点事实，宿主管环境策略与事件编排 |
| Q3 | coder 的 guard 启用 | **装配层强制 enabled:true**（已落地 e0a3f2d）：线程宿主的 guard 是 rotation 唯一触发器，不受全局面板误关闭影响；阈值等参数仍可配置 |
| Q4 | request_summary_compaction 去留 | **B 卸载**（015，2026-08-21 拍板）：coder 上下文管理收敛为 guard→rotation 单一路径；判定用唯一权威集合 THREAD_HOST_AGENT_IDS，PH 等非宿主挂载保持现状 |

### 本批 tickets

执行顺序：**013（加急，007 合入后立即）→ 014（依赖 007 合入）**；
015 独立小票随时可做。013 与 007 改动面不重叠但共享 AgentDev 工作树，
串行执行避免覆盖。

| 票 | 仓库 | 内容 |
|----|------|------|
| [013](013-agentdev-remove-read-dedup-stub.md) | AgentDev | 移除 read 的 file_unchanged 去重短路（加急；写保护保留） |
| [014](014-claw-workthread-alignment-patch.md) | AgentDevClaw | 007 落地后：判定语义与随迁测试对齐补丁 |
| [015](015-claw-coder-context-discipline.md) | AgentDevClaw | request_summary_compaction 去留与 system.md 上下文纪律 |

### 术语区分（本次讨论 crystallize）

- **线程环境判定 vs 环境存在性开关**：前者是事件响应事实——"该会话是否
  为某活跃线程的 head"（findThreadByHeadSession，993dd7f 起为事件钩子唯一
  基准）；后者是宿主策略——"哪些工作空间的新会话自动建立线程"
  （THREAD_HOST_AGENT_IDS，仅 onSessionCreated 与 input-gateway 消费）。
  框架 WorkThread（007）只拥有前者的事实查询，不拥有后者的策略。

### 明确暂缓项（决策树已关闭的分支及重开条件）

| 项 | 暂缓理由 | 重开条件 |
|----|---------|---------|
| turn cancel 后的自动恢复（8e766c 靠人工"继续"救活） | 恢复机制本身验证良好；自动重发涉及误中断场景边界，未收敛 | 再次发生无人值守下的意外中断，或调度层提出明确需求 |
| skill 双轨制（指令内联 vs SKILL 规范权威漂移） | 属工作流治理，涉及 grill 派发模板改动，需单独一轮收敛 | 下一批 grill 会话 |
| DEBUG 日志残留（hasActiveAgents / hasPendingMessages） | 小清理，不值得独立票 | 顺带任意一张触线票处理 |

### 验收与发布注意（全批次通用）

- 013/014 触框架 dist 的须整服重启验证；015 只需重启 coder runtime。
- 013 验收含行为冒烟：二次 read 全量返回 + 先读后写保护双方向不回退。

---

## 批次 5：工作群临时屏蔽（016）（2026-08-21）

来源：2026-08-21 grill 会话（第一轮 Q1–Q4 一次收敛）。事实调研：
HIDDEN_PREBUILT_AGENT_IDS 现成机制（悬置空间同款）、metadata `enabled`
字段语义边界（只影响身份注册不影响列表可见性）、前端空分组自动隐藏。

### 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| Q1 | 屏蔽手段 | **仅 `HIDDEN_PREBUILT_AGENT_IDS` 加 `work-group`**（服务端 1 行）；不用 metadata `enabled:false`（身份禁用语义，超出"隐藏曝光"意图，且恢复要记两处） |
| Q2 | runtime 与数据 | 群聊数据保留不动；执行时先停运行中的 work-group runtime（避免幽灵进程） |
| Q3 | 首页 Dashboard 入口 | **保持现状不处理**（用户拍板"其他地方首页啥的都不管"，死入口可接受） |
| Q4 | 恢复机制 | 常量硬编码即可，不加配置开关；恢复 = 删 1 行 + 整服重启 |

### 本批 tickets

| 票 | 仓库 | 内容 |
|----|------|------|
| [016](016-claw-hide-work-group-workspace.md) | AgentDevClaw | HIDDEN_PREBUILT_AGENT_IDS 加入 work-group（左侧列表条目 + 分类分组隐藏，前端零改动） |

### 验收与发布注意

- 修改属 server 侧常量，须**整服重启**生效（重启单个 agent 无效）。
- 测试断言同步固化（shared-modules.test.js）。
- 已知连带效果：IM 可路由目标中 work-group"管理员会话"同步消失，执行前
  确认无绑定该目标的 IM 线路。

---

## 批次 6：coder 工作空间 ACP v1 对外接入（017–020）（2026-08-21）

来源：2026-08-21 grill 会话（Q1–Q27 全部确认）。上游调研：ACP 规范与
TypeScript SDK（`D:\GithubDownload\agent-client-protocol` /
`typescript-sdk`）、官方 Codex 适配 `D:\GithubDownload\codex-acp` 三层结构、
Claw thread 事件链路 / ViewerWorker interrupt 协议 / WorkThreadBoard 裁剪
行为源码核查。完整设计见
[coder-acp-adapter-design.md](../coder-acp-adapter-design.md)。

### 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| 范围 | 协议版本与传输 | **ACP v1 稳定版 + 仅 stdio**，仅 client→agent 方向；v2 / HTTP / WS 不做 |
| Q1 | 承载形态 | **独立 adapter 进程 + 本机 HTTP 复用 Claw server**；不混入 server.js、不直接实例化 CoderAgent、不走 ViewerWorker API |
| Q2/Q7 | 会话映射 | 每次 `session/new` 新建 coder session + thread；ACP session ID 独立管理，thread ID 不外泄为协议标识 |
| Q3 | 前置条件 | Claw server 必须已运行；未运行返回明确 ACP error（-32000），不自动拉起 |
| Q5 | 方法集 | 仅 initialize / session/new / session/prompt / session/cancel；load / resume / close / 权限 / MCP / modes 全部拒绝 |
| Q9 | 并发 | 一 session 一 active prompt，并发返回 SESSION_BUSY；不做 steering |
| Q21 | session 创建响应 | server 新增**原子编排路由**直接返回 { clawSessionId, threadId, viewerAgentId }，不做 headSessionId 反查 |
| Q26 | 事件游标缺陷 | **框架权威修复**（board 绝对游标，017）；server 侧补偿层 rejected |
| Q27 | prompt 归因 | 基线排除 + 首个终态事件判定；UI 并发输入误归因文档化接受；command-id 透传列为后续框架改进 |
| 事件粒度 | 流式 | 接受整段消息粒度（`agent_message_chunk` 承载完整消息），不伪 token 流 |

架构原则性决策已固化为 [ADR-0004](../adr/0004-acp-adapter-external-stdio-process.md)。

### 本批 tickets

执行顺序：**017 ∥ 018 → 019 → (020 ∥ 021)**。017（框架）与 018（server 路由）互不
依赖可并行；019 联调依赖两者合入（017 是事件正确性硬前置）；020 文档收尾与
021 adapter 诊断能力可并行。

| 票 | 仓库 | 内容 |
|----|------|------|
| [017](017-agentdev-workthread-board-monotonic-cursor.md) | AgentDev | WorkThreadBoard 单调游标（baseOffset + 绝对 cursor + 持久化 + clamp 兼容） |
| [018](018-claw-acp-server-routes.md) | AgentDevClaw | ACP 支撑路由（原子创建 + 回滚阶梯 + 精确中断 + events 附加字段） |
| [019](019-claw-coder-acp-adapter.md) | AgentDevClaw | ACP stdio adapter 本体（五模块 + 方法集 + 事件映射 + 双层取消 + 测试） |
| [020](020-claw-acp-cli-and-docs.md) | AgentDevClaw | `claw acp coder` CLI + agents/README 与 CLAUDE.md 文档 |
| [021](021-claw-acp-adapter-observability.md) | AgentDevClaw | ACP adapter 结构化 trace、脱敏内容调试与第三方黑盒 client 排障 |

### 术语区分（本次讨论 crystallize）

- **ACP Session vs Claw Session vs WorkThread**：ACP session 是 client 视角
  的协议会话（adapter 内存对象，ID 独立生成）；Claw session 是持久化的工作
  空间会话；WorkThread 是连续性锚点。三者一对一映射但 ID 域互不通用，
  thread ID 永不外泄为协议标识。
- **ACP Adapter vs coder runtime**：adapter 是协议端点进程（零框架依赖、
  零 Agent 实例化）；runtime 是唯一执行体（CallArbiter → CoderAgent）。
  adapter 崩溃不影响 runtime，反之亦然。
- **协议取消 vs 运行时中断**：前者是 `session/cancel` 通知与
  `$/cancel_request`（ctx.signal）汇入的 adapter 状态机；后者是
  ViewerWorker `interrupt-agent`（clearQueue）→ CallArbiter 的 runtime 链
  路。一次协议取消触发恰好一次运行时中断，两者不混同。
- **基线排除（baseline exclusion）**：prompt 归因判定术语——投递前记录
  { cursor, knownEventIds, maxTurn }，只认「命令接受后出现且不在基线中」的
  事件。
- **绝对游标 vs 数组游标**：前者 = baseOffset + 数组长度（跨裁剪单调，
  017 语义）；后者 = 裁剪后数组长度（现状缺陷，跨裁剪会丢事件）。

### 明确暂缓项（决策树已关闭的分支及重开条件）

| 项 | 暂缓理由 | 重开条件 |
|----|---------|---------|
| session/load / resume / close | Claw 会话持久化与 ACP resume 语义无直接等价物，需独立设计 | 第一个需要恢复/显式关闭 ACP 会话的真实 client 需求 |
| requestPermission | coder 工具审批语义未定型 | 工具交互权限模型定稿 |
| MCP 配置（非空 mcpServers） | 会话级 MCP 与 Claw 全局 MCP 配置的映射未设计 | 映射设计收敛 |
| token 级流式 | runtime 在 callFinished 批量写 item 事件，无实时发射点 | 框架级事件桥（实时 item.* 发射）落地 |
| prompt 精确归因（command-id 透传） | 需改框架 mailbox → user-turn → 事件映射三层 | v1 出现误归因实例，或框架透传改造排期 |
| image / embeddedContext / additionalDirectories 输入 | coder 无对应输入路径 | coder 对应能力出现 |
| steering（prompt 注入进行中 turn） | 当前无 steering 协议设计 | 出现真实需求并单独收敛语义 |

### 验收与发布注意（全批次通用）

- 017 框架 dist 变更、018 server 路由变更 → **整服重启**验证；019/020 的
  adapter 与 CLI 改动只需新起子进程。
- adapter 纪律机械可验：进程内无 `@agentdev/` import；stdout 每行可
  JSON.parse（wire 测试断言）。
- 全部测试不依赖真实模型；Claw HTTP 以本地 mock 替身。
- `@agentclientprotocol/sdk` 从 registry 锁精确版本；升级视为协议面变更，
  重跑 wire 测试。

---

## 批次 7：工具终止语义与执行中可见性（023–025）（2026-08-23）

来源：2026-08-23 grill 会话（Q1–Q11 全部确认）。上游调研：Claude Code
（`D:\GithubDownload\claude-code-source-code`）、opencode（`D:\GithubDownload\opencode`）、
codex（`D:\GithubDownload\codex`）三家的超时/中断/输出处理对照，及 VS Code 终端架构
（xterm.js + node-pty）问询。范围：前两层（Layer 1 终止语义 + Layer 2 执行中可见性）；
PTY 持久终端（Layer 3）明确不在本批。

### 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| Q1 | 超时归属 | **框架统一契约**：Tool 声明 `timeout: { defaultMs, maxMs, fromArg? }`，executor 统一计时，超时经合并 AbortSignal 通知工具；shell-feature 删内部 race。未声明工具行为不变 |
| Q2 | 结果表达 | `ToolExecResult` 增加可选 `interrupted: { reason: 'timeout' \| 'user' }`，`success: true`；序列化与 session-events 双透传 |
| Q3 | settle/drain | **1s**（用户拍板，自 codex 2s 收紧）；超窗降级为现状路径 |
| Q4 | 元数据标注 | `<shell_metadata>` 末尾块，仅终止态出现（正常完成保持干净输出）；reason 区分 timeout（可重试）/ user（勿重试） |
| Q5 | 进度通道 | 复用 notification 系统（`tool.progress`，category `state`）；session-events **不加**中途事件 |
| Q6 | 前端呈现 | bash.render call 态扩展：`(已运行 Ns · 超时 Xm)` + 尾部 5 行限高直接可见；完成态不保留 tail |
| Q7 | powershell | 同步改，bash/powershell 抽共享核心（render 模板本就共用） |
| Q8 | 配置面板 | `defaultTimeoutMs`/`maxTimeoutMs` 进 feature-setup manifest，默认 120s / 上限 600s |
| Q9 | 打断响应性 | 接受最多 1s 延迟换输出保留；user 终止后 react-loop 仍退出（timeout 不退出，模型自行决策） |
| Q10 | 前端拉取 | `/notification` 纳入主 poll（1s）；`startedAt` 本地走秒插值 |
| Q11 | 实施切分 | **分两批连续交付**：Layer 1（023+024）验证稳定后 Layer 2（025） |

原则性决策已固化为 [ADR-0005](../adr/0005-tool-termination-as-result.md)。

### 本批 tickets

执行顺序：**023 → 024 → 025** 严格串行（协议 → 声明方消费 → 呈现）。

| 票 | 仓库 | 内容 |
|----|------|------|
| [023](023-agentdev-tool-termination-protocol.md) | AgentDev | 框架终止协议：超时契约 + signal 合并 + settle 窗口 + `interrupted` 字段 + `tool.progress` schema |
| [024](024-agentdev-shell-termination-and-metadata.md) | AgentDev | shell-feature 终止收集 + `<shell_metadata>` + 共享核心 + manifest 配置（Layer 1） |
| [025](025-claw-tool-progress-ui.md) | AgentDev → AgentDevClaw | 进度发射 + 卡片呈现 + 主 poll 接线 + 配置面板验证（Layer 2） |

### 术语区分（本次讨论 crystallize）

见根目录 [CONTEXT.md](../../CONTEXT.md)：**工具终止**（reason: timeout / user，
不称"中断"）、**部分输出**、**settle 窗口**、**进度信号**（不进上下文）、
**超时契约**。

### 明确暂缓项（决策树已关闭的分支及重开条件）

| 项 | 暂缓理由 | 重开条件 |
|----|---------|---------|
| 超时转后台任务（Claude Code 路线） | 依赖整套后台任务管理；本批先把"终止即结果"做对 | Layer 3 PTY 落地后，或出现"长任务不想被杀"的真实需求 |
| PTY 持久终端（Layer 3：人机协同交替输入） | 独立大件；架构已定（opencode 范本 = xterm.js + node-pty + WebSocket + ring buffer replay，VS Code 同构），PTY 会话建议独立子进程持有 | 本批验收后单独立批 |
| session-events 中途 progress 事件 | 不节流审计流加 tail 会让无头 jsonl 爆炸；终态 `interrupted` 已覆盖审计 | 无头 CLI 出现实时输出的真实消费者 |
| 子代理 / dispatch 场景进度可见 | 现状亦不可见，无回归；审计由 `interrupted` 字段覆盖 | 前端出现查看子代理执行的界面需求 |
| 其他工具（read/grep/lsp…）声明超时与进度 | 框架契约就绪后按需声明，零框架改动 | 各工具出现真实长任务场景 |

### 验收与发布注意（全批次通用）

- 023 触框架 core dist、024/025 触 shell-feature dist 与前端静态文件 →
  全部需**整服重启**验证；建议每票合入后重启冒烟，023+024 为 Layer 1 验收单元
  （三态场景：正常完成 / 超时 / 用户打断）。
- AgentDev 侧 `npm run build`（单包提速可 `cd packages/<name> && npm run build`）；
  Claw 侧 `npm test` 全绿 + 编程小助手手工冒烟。
- 本批零新依赖、零 Claw server 路由变更（复用现有 `/notification` 端点）。

---

## 批次 8：本地显式资源寻址协议标准化（026–032）（2026-08-22）

来源：2026-08-22 grill-with-docs 会话。背景是 current agent 语义已从 AgentDev
框架服务端、ViewerWorker、DebugHub IPC 和 debugger MCP 中彻底移除；本批只把 Claw
现有本地协议整理为显式资源寻址和可关联错误契约，为未来能力扩展提供稳定本地基线。

### 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| Q1 | 本批范围 | **只做本地协议标准化**；不实现 SSH、隧道、远程 Catalog、跨主机路由、中继、WebSocket 或远程专用服务 |
| Q2 | 执行归属 | 现有本地 Agent 继续由本地 Claw/ViewerWorker 执行；本批不改变执行链 |
| Q3 | 身份边界 | `agentId`、`sessionId`、`runtimeId`、`parentId` 与页面焦点分离；缺少目标不静默 fallback |
| Q4 | 操作边界 | Runtime-scoped 与 Host-scoped 操作分开记录和校验，不用页面焦点推断 Host 目标 |
| Q5 | 交付方式 | 每张票可独立测试、逐步提交；本地旧链路保持兼容 |
| Q6 | 远期传输 | 未来传输层只能作为目标解析后的实现细节，不反向污染业务 Feature |

原则性决策已固化为 [ADR-0006](../adr/0006-local-explicit-resource-targeting-first.md)。

### 本批 tickets

执行顺序：**026 → (027 ∥ 028) → 029 → 030 → 031 → 032**。026 是身份术语前置；027
是纯前端重命名，可与 028 并行；029 依赖身份模型与本地目标解析器；030 在寻址审计后整理
Runtime/Host 边界；031 统一关联元数据和错误契约；032 做最终本地回归矩阵。

| 票 | 仓库 | 内容 |
|----|------|------|
| [026](026-claw-resource-identity-contract.md) | AgentDevClaw | Agent / Session / Runtime 本地资源身份契约 |
| [027](027-claw-rename-focus-state.md) | AgentDevClaw | 页面焦点状态重命名为 `focusedAgentId` |
| [028](028-claw-local-request-target-resolver.md) | AgentDevClaw | 本地请求目标解析器与代表性调用点接入 |
| [029](029-claw-explicit-runtime-addressing-audit.md) | AgentDevClaw + AgentDev | Runtime 接口显式寻址审计与隐式 fallback 清理 |
| [030](030-claw-runtime-host-operation-boundaries.md) | AgentDevClaw | Runtime 操作与宿主操作边界整理 |
| [031](031-claw-operation-metadata-and-error-contract.md) | AgentDevClaw + AgentDev | 操作关联元数据与本地失败错误契约 |
| [032](032-claw-local-protocol-regression-matrix.md) | AgentDevClaw + AgentDev | 本地显式寻址协议回归矩阵 |

### 术语区分

见根目录 [CONTEXT.md](../../CONTEXT.md)：逻辑 Agent、工作会话、运行时实例、页面焦点、
Runtime-scoped 操作、Host-scoped 操作、显式资源寻址、操作关联元数据和结果未知。

### 明确暂缓项

| 项 | 暂缓理由 | 重开条件 |
|----|---------|---------|
| SSH / 隧道 / 连接配置 | Phase 0 严格不包含传输实现 | 批次 8 全票完成且本地回归矩阵全绿 |
| 远程 Agent Catalog | 需要先有经过本地验证的目标模型 | 批次 8 完成后单独发起新批次 |
| 业务状态镜像 / snapshot relay | 本批不引入跨执行端状态副本 | 出现明确的实时同步需求并单独完成设计 |
| 自动重试 / 离线队列 | 写操作结果未知与幂等语义尚未在本地闭环验证 | 031 完成后基于真实需求另行收敛 |

### 验收与发布注意

- 本批所有测试均为本地测试，不连接互联网、不启动 SSH、不依赖远程服务器。
- 026–031 的每张票都必须保持本地成功路径兼容；032 作为最终回归验收。
- AgentDev 框架 dist 触点变更后按现有规则构建并整服重启；不得在本批引入新的远程运行时。

---

## 批次 9：远程访问 Phase 3 —— 远程会话历史与工作流（R1-09 / R2-01 / R2-02）（2026-08-30）

来源：2026-08-30 grill-with-docs 会话（Round 1 Q1–Q8 全部批准，含一次基于 Phase 2 现状的 Q3 推翻重立）。
上游调研：session.js 21 个 protoclaw 路由盘点（Phase 3 端点 100% 在 protoclaw 域，ADR-0011 套路直接适用）、
checkpoint/rollback 确认为 runtime continuation 机制（经 input 链路，Phase 2 已覆盖）、
Phase 2 已落地的 remote-forward 共享 helper 与 6 端点接入模式、
前端 15 个会话端点消费模块清单。票目录：[remote-access/](remote-access/)。

### 已确认决策

| # | 决策 | 结论 |
|---|------|------|
| Q1 | R1-09 与 Phase 3 顺序 | **先完整施工 R1-09**（其施工项 A 的 `focusedAgentId` host 级收敛是 Phase 3 会话端点寻址的硬前置） |
| Q2 | 切片 | **R2-01 = 读 + activate + 管理操作**（发现→打开→管理闭环）；**R2-02 = branch / trim / compact / summary**（重操作独立验证） |
| Q3 | 转发模式 | **照 Phase 2 现状：逐路由薄分支（8-12 行）+ remote-forward 共享 helper**；族级中间件 rejected（21 路由 body/query 重写规则异质，规则表不赢显式性） |
| Q4 | 历史会话呈现 | **同一 workspace surface 会话列表混合排序**，无来源分区无徽标；侧栏保持纯运行时（ADR-0010 延伸） |
| Q5 | activate 语义 | **与本地一致直接激活**，无远程确认层；副作用由 ADR-0011 三分类失败契约兜底 |
| Q6 | 危险操作矩阵 | **R2-01 全部开放**（delete/archive/改名/todo），delete 复用既有二次确认 UI |
| Q7 | /api/logs（远程 403） | **推迟 Phase 4**（ViewerWorker 域传输路径与主线不同，Phase 3 验收不依赖） |
| Q8 | 列表规模 | **照本地全量 index 模型**，分页暂缓 |

原则性决策已固化为 [ADR-0012](../adr/0012-remote-session-history-unified-presentation.md)（统一呈现与激活语义）。

### 本批 tickets

执行顺序：**R1-09 → R2-01 → R2-02** 严格串行（R1-09 施工项 A 是 R2-01 寻址前置；R2-01 定型模式与幂等闸是 R2-02 前置）。

| 票 | 内容 | 状态 |
|----|------|------|
| [R1-09](remote-access/R1-09-header-info-convergence.md) | 远程会话顶部信息收敛（sessionMeta 权威模型 + focusedAgentId host 级收敛） | 施工项 A–E 已合入（T21 系列），剩 F 项测试 |
| [R2-01](remote-access/R2-01-session-history-open-manage.md) | 远程会话历史：发现、打开与管理（十端点转发 + 幂等闸补齐 + 前端列表统一） | 已立项未派发 |
| [R2-02](remote-access/R2-02-session-write-workflows.md) | 远程会话写工作流：分支与上下文精简（六端点转发 + checkpoint 验收） | 已立项未派发（依赖 R2-01） |

### 术语区分

见根目录 [CONTEXT.md](../../CONTEXT.md)：**会话激活（session activation）**——本批新固化；
与既有"运行时实例""工作会话""只读远程视图"的关系以该文件为准。

### 明确暂缓项（决策树已关闭的分支及重开条件）

| 项 | 暂缓理由 | 重开条件 |
|----|---------|---------|
| /api/logs 远程日志 | ViewerWorker/DebugHub 域，需独立传输路径设计；运维域归 Phase 4 | Phase 4 立项 |
| 会话列表分页 | 两端同产品形态同量级，链路一致优先 | 单目录数百会话、真实体感卡顿 |
| 远程激活确认层 | 违背本地/远程一致原则 | 接入稀缺共享主机，按连接级 capability 加确认 |
| capability 域 slash 命令远程矩阵 | 独立票，不阻塞会话主线 | R2-02 后按需立项 |
| session-controls-panel 模型轮换远程回源 | 遗留观察项（不在五端点清单） | 实测暴露问题时随 R2 线处理 |
| 远程语音模型配置 | 语音 ASR 已定本地链路语义 | 出现"远程会话用远程语音模型"真实需求 |
| 远程独有工作空间全虚拟合成 | 同代码库部署下无真实场景 | 异构部署需求真实出现 |

### 验收与发布注意（全批次通用）

- 三票均为 Claw 侧改动（server 路由 + 前端静态文件）→ **整服重启**验证。
- 服务端转发测试照 `test/remote-write.test.js` harness；前端 vm 沙箱测试照 `frontend-core-helpers.test.js` 模式（overrides 经 `ctx.run` 赋值）。
- 双机冒烟是各票验收的一部分（本地双实例可替代）；mock 测试不能替代物理链路验收。
- 远程端必须运行同等代码版本（R2-01 之后 = 两端都含 Phase 2 + 对应票改动），版本漂移走既有握手告警。
