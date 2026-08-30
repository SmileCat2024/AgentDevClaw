# 014 — 007 落地后：判定语义与 WorkThread 随迁对齐补丁

- **仓库**：AgentDevClaw（核查面含 AgentDev）
- **决策依据**：Claw 提交 993dd7f（事件钩子判定基准改会话归属）与
  007（WorkThread 核心上收）并行发生；008 票面"integration / rotation
  原样保留"的前提是两侧语义一致
- **类型**：事后对齐核查 + 小补丁
- **前置依赖**：007 合入

## 背景

007 执行期间，Claw 侧完成了 thread-control 判定基准改造（993dd7f）：

- 事件响应钩子（succession ×3 / onSessionDeleted / handleRuntimeReady /
  guard 触发的 rotation）判定从 `THREAD_HOST_AGENT_IDS` 白名单改为会话归属
  （`findThreadByHeadSession`）；
- `not_thread_host` reason 废弃，非宿主场景统一返回 `no_thread_for_session`；
- 测试断言同步（test/thread-control.test.js 三处 + thread-rotation.test.js
  新增白名单外 agent 的线程 head 会话触发用例）。

007 票面含"测试随迁：test/thread-control.test.js 按拆分归位为框架测试"，
随迁底稿若取自改造前版本，框架侧可能沉淀已废弃的 `not_thread_host`
断言语义；Q6 的 WorkThread 前缀重命名也会改变 Claw 消费点的 API 名。
两侧若不同步，漂移会在 008 一次性切换时集中暴露。

## 执行步骤

1. 007 合入后，框架侧 grep `not_thread_host`：预期**零命中**。命中则说明
   integration 层断言被误随迁——按会话归属语义修正，或退回 Claw 侧测试
   （锚点层测试不应含宿主接线语义）。
2. 对照框架 WorkThread 锚点 API 与 Claw 消费点（`findThreadByHeadSession` /
   `beginSessionHandoff` / `advanceHead` / `appendCommand` /
   `deliverPendingCommands`，见 thread-integration.js 与 thread-rotation.js
   的 threadController 调用），产出 Q6 重命名影响清单（为 008 切换预清障；
   无改名则清单为空）。
3. Claw 全量 `npm test` 兜底（thread-control / rotation / envelope /
   server-smoke）。

## 验收标准

- 框架侧 grep `not_thread_host` 零命中；两侧测试全绿。
- API 影响清单产出（允许为空），附在 008 执行参考处。

## 风险提示

- 低。最坏情况是框架侧随迁测试含旧断言且未修——008 切换时测试语义与
  Claw 实现漂移，排查成本远高于本票的一次 grep。
