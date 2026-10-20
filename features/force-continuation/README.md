# API 重试（@agentdevjs/force-continuation）

两类独立策略默认开启，无总开关，共享最大重试次数（默认 5，范围 1–10）。包名和 runtime feature ID 保持 `force-continuation`。

## 行为与分工

- **正文输出达到上限**：Provider 返回 `max_tokens` 或 `length`，且已有非空正文。框架保留正文、返回的 reasoning / thinkingBlocks，丢弃本次响应全部工具调用且不执行。Feature 在 StepFinish 注入继续指令，在同一个 Call 的下一步请求继续；不调大输出预算、不拼接工具参数、不保证逐字无缝续写。
- **网络错误**：Call 因可重试的超时、断连、限流、过载或服务端错误失败后，宿主 CallArbiter 询问 Feature，在预算内开启下一段。模型客户端内部请求重试与此处的任务重试是不同层级。
- 只有思考或工具调用、尚无正文时耗尽输出预算，框架报告 `output_truncated` 错误，Feature 不介入。关闭正文重试或预算耗尽时，已有正文仍保留，截断不会伪装成正常完成。
- 用户停止、认证失败、普通运行错误、正常回答结束和框架 step 上限均不触发 API 重试。
- 快照保存两类策略、次数上限、计数及最近结果。原总开关、Provider 分项和 step 恢复配置已移除，不做旧字段兼容映射。

## 配置

```ts
new ForceContinuation({
  outputTruncation: true,
  apiErrorRetry: true,
  maxConsecutiveContinuations: 5,
});
```

Feature manifest、`configure` capability 与构造配置使用同一组字段。Claw 设置页及会话控制面板统一展示“API 重试”，下分“正文输出达到上限”“网络错误”。会话面板只修改当前会话；工作空间配置用于 runtime 装配。

## 控制与开发

不向模型暴露工具；用户面板通过 session IPC 控制，slash / feature 可通过 `configure` capability 控制。`setTriggers` 接收 `{ outputTruncation?, apiErrorRetry? }`，`setMaxConsecutive` 设置共享预算。

```bash
npm run build
node --test test/force-continuation.test.js
```
