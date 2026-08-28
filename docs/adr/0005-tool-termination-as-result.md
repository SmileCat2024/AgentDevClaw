# 工具终止语义：中断即结果

工具的超时与用户打断不是异常，而是正常返回值的一部分：执行器（`tool-executor.ts`）在终止信号
发出后给工具最多 1s 的 settle 窗口优雅收尾，窗口内返回的结果携带部分输出与结构化字段
`interrupted: { reason: 'timeout' | 'user' }`，且 `success: true`。超窗未收尾才降级为失败结果，
但仍保留真实的 `interrupted.reason`，不会把 timeout 伪装成 user 打断。

依据：`success: false` 但 result 有内容的语义拧巴，且前端对 failed 结果渲染错误态——被超时
但有输出的结果不是失败。模型只读序列化文本（含 `<shell_metadata>` 标注），机器消费方读
结构化字段，两者各取所需。

超时归框架统一管辖：工具定义声明 `timeout: { defaultMs, maxMs, fromArg? }`（不声明则行为
完全不变），执行器统一计时，超时与用户打断汇入同一个传给工具的 AbortSignal（工具不感知
reason，反正都要优雅终止；执行器自己记录 reason 用于结果标注）。模型传参覆盖超时值由
`fromArg` 声明式解决（如 shell 的 `timeout` 参数），不做运行时重设协议。

执行中可见性走通知系统（`tool.progress`，category `state`，自动获得 100ms 节流），不进
session-events 审计流——审计关心终态（`interrupted` 字段已覆盖），不节流的事件流加尾部
输出会让无头 jsonl 爆炸。

## Considered Options

- 超时即杀且 reject（现状）/ 超时转后台任务（Claude Code 路线）：rejected。前者丢输出，
  后者依赖整套后台任务管理，列为 PTY 批次后的演进方向。
- settle 窗口 2s（codex IO drain 同款）：用户拍板收紧为 1s，换打断响应性；kill + pipe
  close 实际几乎总在 100ms 内。
- 进度走 session-events 或新通道：rejected，见上。
