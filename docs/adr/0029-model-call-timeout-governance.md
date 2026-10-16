# ADR 0029: 模型调用超时治理 — 对话默认 60s idle / transform 场景预算分层

日期：2026-10-16
状态：已接受（已实施）

## 背景与问题

框架 `DEFAULT_MODEL_TIMEOUT_MS = 600s` / `DEFAULT_MODEL_MAX_RETRIES = 10` 全线生效：summary 与对话走同一条 resolver → `createLLM` 链路，拿到同一份默认值。后果：

- **对话场景**：大上下文 + 高思考档位时首 token 静默 1–3 分钟在预算内，用户面对无反馈的"等待响应"；可重试错误静默重试叠加退避，感知等待可达数分钟。治理原则：**任何一段静默（首段 / chunk 间隔）不应超过 60 秒**。
- **transform 场景**：`generateSummaryText` 对 anthropic 协议传 `noStream: true`——非流式摘要整个结果生成完之前收不到响应头，idle 计时从调用创建计到响应头，600s 预算真实需要。此前结构里没有场景分层：summary 的长预算只存在于外层 attempt 超时（`SESSION_TRANSFORMATION_TIMEOUT_MS`）与框架默认值的巧合对齐，对话与摘要共用同一默认。

## 根本裁决

### 1. 对话默认：60s idle / 5 次重试

- `DEFAULT_MODEL_TIMEOUT_MS = 60_000`：空闲语义不变（持续无远端活动才中止；思考期间 reasoning delta 持续流出的调用不受限）。首段静默与 chunk 间隔统一 60s 硬边界；空闲超时以 TimeoutError 中止，按中断处理**不重试**。
- `DEFAULT_MODEL_MAX_RETRIES = 5`。
- 已知接受的边界：等待思考结束才发首 chunk 的静默型端点会在 headers 后 60s 被误杀——按 preset 逃生门覆盖，不为此放宽全局默认。

### 2. transform 预算：装配层实例分离（ADR-0028 的应用）

- 框架新增 `TRANSFORM_MODEL_TIMEOUT_MS = 600_000`；`deadlineMs` / `maxRetries` 从 private 暴露为装配层可调优字段（与 `tuneMirrorLLM` 调优 thinkingEffort 等实例字段的既有模式一致）。
- Claw 摘要实例在 `resolveSummaryLLM` / plain agent 摘要轮经 `tuneMirrorLLM({ deadlineMs })` 拿长预算；标题 / recap 等小任务不传，沿用默认。场景差异 = 不同实例，不引入 per-call 覆盖 API（与"LLM 实例 = 参数快照"同构）。

### 3. undici 层锚点

`HTTP_HEADERS_TIMEOUT_MS` 从锚定 `DEFAULT_MODEL_TIMEOUT_MS` 改锚 `TRANSFORM_MODEL_TIMEOUT_MS`：非流式请求的 headersTimeout 事实上是"非流式总等待预算"，必须 ≥ 场景最大 idle deadline；对话默认 idle（60s）必先于它触发。Claw `proxy-manager` 镜像同一锚定（server 主进程 dispatcher 与子进程 http-client 各自生效）。`bodyTimeout` 60s 与对话 idle 同值，保持不动。

### 4. per-preset 逃生门

presets.json preset 条目可配 `timeoutMs` / `maxRetries`，resolver 透传进 `createLLM`；非法值不透传（落回框架默认），不把非法值放大成无超时保护。default.json 的 defaultModel 为完整 ModelConfig 摊平传入，天然支持。

## 落点索引

- 框架 core：`AgentDev/packages/core/src/core/retry.ts`（常量）、`config.ts`（timeoutMs 语义注释）、`index.ts`（导出）
- 框架 llm：三个适配器字段暴露、`http-client.ts`（headersTimeout 锚定）、`test/__tests__/http-client.test.ts`
- Claw：`server/model-preset-resolver.js`（`pickPresetCallPolicy` 透传）、`server/shared/llm-tuning.js`（`deadlineMs` 参数）、`server/context-continuity/inprocess-summary.js`（`SUMMARY_TUNED_IDLE_MS` 装配约定）、`scripts/run-plain-agent.js`（摘要轮）、`server/shared/proxy-manager.js` + `test/proxy-manager.test.js`（锚定）
- 外层 attempt 预算：`SESSION_TRANSFORMATION_TIMEOUT_MS`（600s ≥ 内层摘要 idle，注释更新）

## 与既有 ADR 的关系

- 应用 ADR-0028："LLM 实例 = 参数快照"延伸到超时预算：场景差异用不同实例表达，框架不感知"这是摘要调用"。
- 分层判据复核：超时语义（idle / 重试策略 / 常量）归框架；哪个实例拿什么预算（装配约定）归应用层——两层各就各位，无下沉信号。
