# 033 — Capability Shell 基座（管线四道检查点 + 领域策略声明）

- **仓库**：AgentDevClaw（local-features/capability-shell，新建）
- **决策依据**：2026-08-31 Capability-Scoped Shell grill 会话（设计树全部确认）；
  调研报告（sh-syntax AST 残缺 → 弃用；bwrap 移出 v1；不引 execa）
- **类型**：新建 local-feature 基座
- **前置**：无
- **执行关系**：034 的前置；本票完成前 034 不得开工

## 背景

Agent 通过通用 bash 调用 `node bin/claw.mjs threads ...` 派发 coder 工单，调用
发生在通用 bash 工具里，系统无法审计与约束。调研结论（2026-08-31）：以 feature
为基座实现 Capability-Scoped Shell——每个领域 shell 是一份策略声明 + 若干
adapter 映射，边界靠「解析验收 → 动词白名单 → 参数校验 → 分派」管线本身，
不做任何环境隔离（非沙箱）。claw CLI 为对外契约原样保留，本 feature 只服务
内部 agent 的调度链路。

## 核心语义（已裁决，不得偏离）

1. **不是沙箱**：无环境隔离、无 bwrap。边界 = 管线确定性拒绝：合法 bash 语法
   → 结构分段 → 逐段动词白名单 → 参数校验，任一道命中拒绝即终态，给出可用
   动词清单的报错文案。不静默降级、不打运行时补丁。
2. **语法 = bash 方言**，两端统一，无 PowerShell。语法验收用 `bash -n`（只读
   不执行；bash 缺失时降级为纯 shell-quote 分段 + 更保守白名单，缺席状态在
   启动日志声明）。结构分段用 `shell-quote`。
3. **v1 语法白名单**：字面量参数 + 管道 + 少量重定向。命令替换 `$(...)`、
   反引号、变量 `$x`、进程替换 `<(...)`、glob 通配、heredoc、后台 `&` 一律拒绝。
4. **执行层复用框架 `runCollectedProcess`**（@agentdevjs/shell-feature
   shell-core，终止语义 ADR-0005）。不引入 execa / sh-syntax / bwrap / Cedar /
   OpenTelemetry。
5. **数据通道与命令通道分离**：argv 只收字面量小参数；大数据走 stdin 管道或
   经路径校验的文件（workspace 相对路径内，拒绝 `..` 逃逸与绝对路径）。
6. **阻塞 = adapter 实现语义**，CLI 风格的时间 flag 不进动词表；超时唯一闸门
   = 框架 Tool.timeout 契约（defaultMs/maxMs/fromArg），skill 不提时间参数。
7. **审计**：每次调用落结构化事件（createLogger，capability 命名空间）：shell
   名、原文、分段结果、逐段判定、分派去向、结果摘要。字段按未来 Web UI 可呈现
   设计，本票只落日志，不做 UI。

## 执行步骤

1. 新建 `local-features/capability-shell/`（进 tsconfig include 与 barrel）。
   基座导出：管线四道检查点（纯函数，可独立测试）+ 领域 shell 注册类型 +
   一个 bash 形态工具工厂 `createCapabilityShellTool(policy, adapters)`。
2. 管线四道（每道独立导出、独立测试）：
   - 语法验收：优先 `bash -n`（bash 可得时，复用 shell-feature 的
     findGitBashPath 查找逻辑）；不可得时跳过并记录降级状态；
   - 结构分段：shell-quote 切段；命中拒绝特征（命令替换/变量/glob 等）即拒绝；
   - 逐段动词校验：首词必须在策略动词表内；未命中 → 拒绝并列出可用动词；
   - 参数校验：按动词声明的参数约束（字面量、路径边界、必填项）。
3. 分派执行：动词声明的 adapter（进程内函数）或文本工具（`runCollectedProcess`
   数组 spawn，上游输出写下游 stdin）；管道中间数据内存串流，不落盘、不进 env。
4. 拒绝报文契约：`unknown_verb` / `syntax_rejected` / `arg_rejected` 等稳定
   错误码 + 文案列出该 shell 可用动词，模型可自我纠正。
5. 测试：管线纯函数全覆盖 + 每道检查点的放行/拒绝用例；格式为项目统一
   node:test + assert/strict；测试进 `local-features/capability-shell/test/`。

## 验收标准

- 管线四道检查点均为纯函数（语法验收道除外），放行/拒绝用例锁死。
- `gh pr list --json number,title | jq '.[:5]'` 形态的输入可被分段并逐段判定
  （本票只验管线，不实现 github 动词表）。
- 含命令替换/变量/glob 的输入 100% 被拒绝且报错含可用动词清单。
- `npm run build:local-features` 通过；本票测试全绿；全量 `npm run test:core`
  无回归。

## 明确不做

- 不实现 bwrap / 任何环境隔离；不做 Windows 专属执行后端。
- 不实现 github_shell（034 的 github_shell 属后续票）。
- 不做 Web UI 判定明细呈现（字段设计为可呈现即可）。
- 不引入 execa / sh-syntax / OpenTelemetry。
