# 023 — 框架工具终止协议：超时契约 + settle 窗口 + interrupted 字段

- **仓库**：AgentDev（packages/core）
- **决策依据**：ADR-0005（工具终止语义：中断即结果）。2026-08-23 grill 会话 Q1–Q3、Q9 确认。
- **类型**：协议扩展（Tool 接口 + 执行器行为 + 结果 schema）
- **优先级**：批次 7 首票，024/025 的硬前置

## 背景

现状三处割裂：超时是 shell-feature 内部 `setTimeout` race（reject 后输出全丢）；用户打断是
`tool-executor.ts` 的 `Promise.race` 直接抛 `ToolInterruptError`（结果固定
`'Interrupted by user'`，工具后台 fire-and-forget 丢弃）；超时值对前端不可见。
参考系：opencode（超时/中止是标记位，输出照常积累返回）、codex（kill 后 IO drain +
`timed_out` 结果字段 + `ExecCommandOutputDelta` 事件）、Claude Code（中断是正常返回值）。

## 执行步骤

1. **Tool 定义声明超时**（`types.ts`）：Tool 接口增加可选
   `timeout?: { defaultMs: number; maxMs: number; fromArg?: string }`。
   未声明的工具不受框架超时管辖，行为完全不变（只有外部用户 signal）。

2. **执行器统一计时与 signal 合并**（`tool-executor.ts`）：
   - 每次工具执行创建 per-call 合并 AbortController：外部
     `parentAgent._abortController.signal` abort → abort 合并 controller（reason=user）；
     超时计时器到 → abort 合并 controller（reason=timeout）。
     传给工具的 `toolContext.signal` 改为合并后的 signal。
   - 生效超时值：`clamp(fromArg ? args[fromArg] : defaultMs, 1, maxMs)`。
   - `toolContext` 注入 `callId`（`call.id`，progress 配对用）与
     `termination(): 'timeout' | 'user' | null` 查询函数（工具读它区分终止原因，
     填模型可读元数据；不往 AbortSignal 上挂非标属性）。

3. **单一终止预算与 settle 窗口**（`tool-executor.ts`）：终止信号触发时创建本 call 唯一的
   `TerminationState`（reason + 绝对 settle deadline = `now + 1000ms`），不再让下游各自
   开一个独立 1s 计时器。shell 等工具消费这个绝对 deadline，把 kill/drain 纳入同一预算。
   executor 在 deadline 前等待工具收尾：
   - 窗口内工具 resolve → 结果正常返回，`execResult.interrupted = { reason }`，
     `success: true`。
   - 窗口内工具 throw → 走现有 catch 逻辑（failed），不特殊处理。
   - 超窗未收尾 → 降级为带真实 reason 的 `ToolInterruptError`，timeout 不再被格式化为 user。
   - 常量 `TOOL_TERMINATION_SETTLE_MS = 1000`。

4. **结果 schema 透传**：
   - `context.ts` `ToolExecResult` 增加可选 `interrupted?: { reason: 'timeout' | 'user' }`；
     `addToolMessage` 序列化时透传。
   - `session-events.ts` `emitToolResultEvents` 的 tool_call item 透传 `interrupted`
     （无头 jsonl 审计同步受益）。

5. **react-loop 终止语义**：`interrupted.reason === 'user'` 或外部 signal aborted →
   退出循环（不再发起后续 LLM 轮），与现状打断语义一致；`reason === 'timeout'` **不**退出
   循环——模型看到元数据后自行决策（重试/调大 timeout/换路线）。

6. **通知类型**（`notification.ts`）：新增 `createToolProgress`：
   `{ type: 'tool.progress', category: 'state', data: { callId, toolName, startedAt,
   elapsedMs, timeoutMs, outputTail } }`（outputTail 由发射方截尾，本票只定 schema）。

7. **测试**（按框架仓库现有测试体系）：超时触发合并 signal、用户打断优先于超时、
   settle 窗口内返回带 `interrupted`、超窗降级、未声明 timeout 的工具零影响、
   fromArg clamp 边界。

## 验收标准

- 声明了 timeout 的工具：超时后 1s 内返回部分输出结果（`success: true` + `interrupted`）。
- 用户打断后循环退出，但对话中出现带部分输出的工具结果（而非仅 `'Interrupted by user'`）。
- 未声明 timeout 的全部现有工具：行为与改动前逐字节一致。
- react-loop：timeout 终止后模型收到元数据并继续；user 终止后循环退出。

## 风险提示

- 触框架 core dist，验证须整服重启。
- `ToolInterruptError` 消费方仅 tool-executor 自身与 react-loop 注释一处（已核查），
  降级路径保留原样，无外部破坏面。
