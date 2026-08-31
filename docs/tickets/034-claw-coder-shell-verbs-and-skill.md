# 034 — coder_shell：调度动词表 + threads adapter + 调度技能重写

- **仓库**：AgentDevClaw
- **决策依据**：2026-08-31 Capability-Scoped Shell grill 会话（设计树全部确认）；
  线程生命周期语义以 [docs/work-thread-lifecycle.md](work-thread-lifecycle.md) 为准
- **类型**：领域 shell 落地 + 调度链路收编
- **前置**：033
- **执行关系**：依赖 033；不得与 033 并行

## 背景

main agent 目前经通用 bash 跑 `node bin/claw.mjs threads ...` 派发 coder 工单，
散装、不可审计。本票在 033 基座上落地第一个领域 shell：`coder_shell`，把调度
收编为受管线约束、全程审计的 feature 工具。claw CLI 不动（对外契约：第三方
agent / ACP / 脚本 / 人工继续走 CLI），内外分流。

## 已裁决要点（不得偏离）

1. **仅挂 main 身份**（programming-helper agent.js）。coder 身份不挂
   （不自派工单，避免递归调度）。
2. **一个 bash 形态工具** `coder_shell({ command })`：输入整条 pipeline 字符串，
   内部走 033 管线四道检查点。
3. **v1 动词表**（adapter 直调 `/protoclaw/threads*`，无鉴权层，同机回环）：

   | 动词 | 映射 | 读写级 | 语义 |
   |---|---|---|---|
   | `create` | POST /protoclaw/threads（或 sessions create + 自动建线语义） | 变更 | 建会话+线程，返回 threadId |
   | `send` | POST /protoclaw/threads/:id/commands | 变更 | 派发并阻塞等本轮落定（adapter 轮询实现 wait-done 语义） |
   | `watch` | GET /protoclaw/threads/:id/events 轮询 | 只读 | 续挂监视，落定即返 |
   | `list` | GET /protoclaw/threads | 只读 | 线程列表 |
   | `show` | GET /protoclaw/threads/:id（含事件尾摘要） | 只读 | 线程详情 |
   | `archive` / `unarchive` | 归档/恢复 | 变更 | 保留「归档即打断收纳」语义透传 |
   | `deliver` | POST /protoclaw/threads/:id/deliver | 变更 | 恢复闸重投 |

   `advance` / `resume` **不入表**：rotation_failed 场景输出结构化指引，
   人工介入（与技能故障表一致）。
4. **幂等键**：`send` 必填，复用 threads API 既有 idempotencyKey 字段；缺失时
   管线参数校验道直接拒绝。
5. **调度控制面 serverOrigin**：默认 `http://127.0.0.1:1420`，经 runtime 身份
   解析（同 ClawDispatchFeature 模式）。

## 执行步骤

1. 在 033 基座上实现 `coder` 领域 shell：动词表（上述 8 个）+ 参数 schema +
   threads adapter（Node fetch 直调 `/protoclaw/threads*`，参照
   `bin/claw.mjs` 已有调用形态；serverOrigin 解析参照
   `local-features/dispatch` 的 runtimeIdentity 模式）。
2. `send` 的阻塞语义：adapter 内轮询线程事件直到本轮落定（复用
   thread-routes 的 started/done 判定字段语义），映射为一次工具调用内等待；
   超时经 Tool.timeout 契约由 executor clamp，超时返回结构化状态
   （`done reason=timeout`，非错误），模型自然续挂 `watch`。
3. 仅在 ProgrammingHelperAgent（main 身份）构造函数挂载；CoderAgent 不挂。
4. 重写 `.agentdev/skills/workspace-coder-dispatch/SKILL.md`：
   - 调用示例全部从 `node bin/claw.mjs ...` 换成 `coder_shell` 用法；
   - 核心不变量（工单图、幂等键、验收证据、越界处置、故障表处置思路）原样保留；
   - 删除全部 CLI 时间 flag / wait-done / timeout 表述（归工具超时）；
   - 保留「claw CLI 对外部调用方仍可用」的一句说明（内部 agent 不再用）。
5. main 的 system prompt 不加调度指引（技能承载即可）。

## 验收标准

- 端到端：main 经 coder_shell 完成一次真实调度循环
  `create → send（阻塞等落定）→ show（取证据）→ archive`，全程 DebugHub
  capability 命名空间可见判定事件（原文/分段/判定/分派）。
- 越权动词（如 `advance`、`resume`、`rm`、`curl`）被拒绝且报错列可用动词。
- `send` 缺幂等键被参数校验道拒绝。
- 对外 CLI 回归：`node bin/claw.mjs threads list` 等命令行为不受影响（回归验证）。
- 033 + 034 测试全绿；`npm run build:local-features` 通过。
- 改动仅涉及：local-features/capability-shell、
  prebuilt-agents/official/programming-helper/{agent.js, .agentdev/skills/workspace-coder-dispatch/SKILL.md,
  .agentdev/prompts/system.md（如需一句挂载说明）}。

## 明确不做

- 不动 claw CLI、bin/claw.mjs、agents/README.md（对外契约零改动）。
- 不做 bash 工具旁路拦截（裁决：不拦截，收口靠技能不再喂旧链路）。
- 不给 CoderAgent 挂 coder_shell（coder 不自派工单）。
- 不做 github_shell、jq 管道、Web UI 判定明细（后续票）。
