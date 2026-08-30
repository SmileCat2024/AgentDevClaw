# 024 — shell-feature 终止收集与 `<shell_metadata>`（bash + powershell 同步）

- **仓库**：AgentDev（packages/shell-feature）
- **决策依据**：ADR-0005；grill 会话 Q1（声明超时契约）、Q3（kill 后 drain）、
  Q4（元数据格式）、Q7（powershell 同步 + 抽共享核心）、Q8（manifest 配置）。
- **类型**：行为语义变更（Layer 1 主体）
- **优先级**：依赖 023 合入后执行

## 背景

bash（`tools.ts`）与 powershell（`powershell.ts`）平行实现：超时/打断路径 kill 后直接
reject（`Error('Command timed out...')` / abort listener），已积累输出全丢；正常完成才走
`processOutputWithPersistence` 截断落盘。Windows kill 已是 `taskkill /PID <pid> /T /F`
（进程树），无需改。

## 执行步骤

1. **抽共享核心**：bash / powershell 共用的「spawn + collect + 截断落盘 + 终止收集」
   抽到一个共享模块（两文件本就共享输出截断逻辑，此处把终止路径一并统一）。

2. **声明超时契约**（消费 023）：
   `timeout: { defaultMs: 120000, maxMs: 600000, fromArg: 'timeout' }`；
   **删除内部 `setTimeout` race**（计时职责移交 executor），`args.timeout` 参数保留
   （executor 经 `fromArg` 消费并 clamp）。

3. **终止收集**（`toolContext.signal` aborted 时）：
   kill（现有 taskkill /T /F 或 child.kill）→ 读取 executor 注入的绝对
   `terminationDeadline`，继续读 stdout/stderr 到 EOF（消费同一 1s settle 预算，保留安全余量；
   孙进程占 pipe 时到 deadline 兜底）→ **resolve**（不再 reject）。shell 不再另开独立的 1s
   预算。

4. **结果文本**：部分输出在前，末尾附加 `<shell_metadata>` 块，字段：
   `terminated: true`（signal 触发即 true）、`reason`（读 `toolContext.termination()`，
   timeout / user）、`durationMs`、`exitCode`（被杀时 null）、`outputBytes`、
   `truncated`、`logPath`（完整已积累输出落盘，复用 `bash-output-*.log` 机制）。
   **仅终止态出现**（正常完成保持现状干净输出；截断落盘提示维持现有行为）。
   reason 区分对模型有行为意义：timeout → 可调大重试；user → 不要重试。

5. **manifest 配置项**：`defaultTimeoutMs` / `maxTimeoutMs` 加入 getConfigManifest
   （feature-setup 面板自动发现；默认 120000 / 600000）。

6. **测试**：超时返回部分输出 + 元数据块；打断返回部分输出 + `reason: user`；
   正常完成无元数据块；args.timeout clamp；powershell 三态同 bash。

## 验收标准

- `npm install` 类长命令跑到一半超时：模型能看到已下载/已输出了什么 + 落盘路径，
  且对话轮继续（模型自行决策下一步）。
- 用户强制打断：对话中出现带部分输出的工具结果，本轮停止。
- powershell 行为与 bash 逐项一致（两工具 render 模板本就共用 `bash.render.ts`）。

## 风险提示

- 生态包 dist 变更，验证须整服重启。
- 终止态落盘文件数量增长：与现状截断落盘同目录同清理策略，无新增清理义务。
