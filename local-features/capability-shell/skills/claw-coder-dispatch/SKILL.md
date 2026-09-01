---
name: claw-coder-dispatch
description: "Claw Coder 智能体调度（claw-coder-dispatch feature 内嵌技能）：用 coder_shell 工具创建 Coder 工作线程、派发工单并阻塞等落定、监视执行、处理超时/接力/待投递命令，完成后按仓库和板块收口。仅适用于智能编码工作空间中的 Coder 智能体；不要用于 plain agent 的 claw run coder。"
---

# Coder 智能体调度 Skill

本 Skill 调度**智能编码工作空间**中的 **Coder 智能体**（自主编码的子代理）。

**本 Skill 是 `coder_shell` 工具的权威用法手册**：全部动词用法、参数约束、
语法限制（只放行字面量参数、管道、少量重定向）与调度纪律都在本文；
工具的拒绝报文（`unknown_verb` / `arg_rejected` 等）会引用本文的处置方式。
派发 Coder 智能体干活前先读完本文，再使用 `coder_shell`。

- 工作空间 agent ID：`programming-helper`
- Coder 智能体的会话由调度面（本 Skill / ACP / 调度面）创建；用户在 Web UI 中不能创建
- 调度入口：`coder_shell` 工具（受控命令管线，全程审计）——调度控制面是 Claw server 的 `/protoclaw/threads*`
- 会话和线程在 Web UI 左侧「coder」入口下可见，可发生 WorkThread head 接力
- 归档：线程级操作（执行中归档会直接打断收纳；已归档线程拒绝新指令）
- 线程生命周期语义（接力、投递、归档的权威定义）：`docs/work-thread-lifecycle.md`——本文只写调度方视角的操作要点，与其冲突时以该文档为准
- `claw` CLI 对外部调用方（第三方 agent / ACP / 脚本 / 人工）仍可用；内部调度不再走 CLI，统一经 `coder_shell`

## 不要混淆的路径

以下命令是 plain agent，不是本 Skill 的目标：

```text
claw run coder --goal "..."
```

工作空间 coder 必须先创建预制 workspace session，再通过对应 WorkThread 投递指令。不要用 `claw spawn`、`claw resume` 或 plain `claw run coder` 替代线程调度。

## coder_shell 用法

全部调度经 `coder_shell({ command })` 完成，command 是一条管道命令字符串。可用动词（8 个）：

| 动词 | 语义 |
|---|---|
| `create <agentId> <sessionId> ['标题']` | 创建线程，返回 threadId |
| `send <threadId> <idempotencyKey> '<指令文本>'` | 派发并**阻塞**等本轮落定 |
| `watch <threadId>` | 续挂监视，落定即返 |
| `list [agentId]` | 线程列表 |
| `show <threadId>` | 线程详情（含事件尾摘要） |
| `archive <threadId>` / `unarchive <threadId>` | 归档/恢复 |
| `deliver <threadId>` | 恢复闸重投 pending 指令 |

`advance` / `resume` **不在动词表**：调用会得到 unknown_verb 和结构化指引——rotation_failed 残局需人工介入（见故障表），不要在 shell 内重试。`rm`、`curl` 等其他动词同样被拒并附可用动词清单。

超时唯一闸门是工具自身的 timeout 契约：超时返回结构化 `done reason=timeout`（不是错误），指令仍在执行，用 `watch <threadId>` 续挂即可。不要试图给动词加时间参数。

## 核心不变量

1. **依赖由调度方控制，不由 coder 自主轮询。** 前置工单未完成时，可以创建线程但不要发送施工指令。
2. **一个工单一个线程。** 不要把多个互不相关工单塞进同一条线程。
3. **有文件交集的工单必须串行。** 无交集且不共享构建产物的工单才可以并行。
4. **发送成功不等于执行开始。** `send` 在同一次调用内阻塞等待本轮落定，返回的 `done reason=...` 字段判定落定；超时返回 `done reason=timeout`（正常续挂信号），用 `watch` 续挂，不要靠再查一遍 events 人工确认。
5. **以证据判定完成。** 最终报告、文件 diff、测试输出、构建产物和 git 状态必须相互吻合。
6. **绝不覆盖其他会话的工作。** 禁止使用 `git reset --hard`、`git clean`、`git checkout -- .` 清理未知改动。
7. **默认不让 coder 自行 push。** commit、push、分支操作由调度方在验收后执行，除非工单明确授权。
8. **幂等键是防重发保险。** `send` 必填唯一幂等键（服务端按键去重）；**不要**故意重发同键指令去"验证去重是否生效"。

> `claw` CLI 对外部调用方（第三方 agent / ACP / 脚本 / 人工）仍可用；内部调度不再走 CLI，统一走 `coder_shell`。

## 前置检查

调度前确认 Claw server 可访问（`coder_shell` 直连 `http://127.0.0.1:1420`，可被 `PROTOCLAW_SERVER_ORIGIN` 覆盖），并确认目标仓库工作区：

```text
coder_shell: list programming-helper
```

同时用文件工具确认目标仓库和工作区状态（git status / branch）。如果已有未提交改动，先按文件和时间线判断归属，不要直接清理。

## 调度流程

### 1. 阅读并建立工单图

调度方先读取：

- `docs/tickets/README.md`
- 目标工单全文
- 工单引用的 ADR、相关入口和验收命令

为每张票记录：

```text
ticket
├── repo
├── cwd
├── target branch
├── dependency tickets
├── touched files
├── validation commands
└── status
```

建议状态：

```text
planned
→ session-created
→ waiting-dependency
→ dispatched
→ executing
→ validating
→ completed
→ committed
→ pushed
```

### 2. 创建 coder 会话（一步返回 threadId）

```text
coder_shell command="create programming-helper <session-id> '工单025 工具进度UI'"
```

返回单行 `threadId=... lifeState=... status=... head=...`。Coder 会话会自动建立线程——标准路径是先经调度面创建 Coder 会话，响应带 `threadId`，无需再调 `create`。只有确认自动建线未发生（响应 `threadId` 为 null）时才手动建线：

```text
coder_shell command="create programming-helper <session-id> '工单025 工具进度UI'"
```

`create` 的 `sessionId` 来自已创建的 coder 会话；标题在创建时一次写入，线程标题自动跟随会话标题。线程列表用 `list programming-helper` 核对。

### 3. 依赖满足后发送开工指令（send 阻塞等落定）

长指令先写文件再读入内容拼进 command（单引号字面量；文本内单引号按 shell-quote 规则转义）。发送必须带唯一幂等键：

```text
coder_shell command="send wt-xxx ticket-025-dispatch '<指令全文>'"
```

`send` 一次调用完成"派发 + 确认开工 + 等干完"：投递后 adapter 内部轮询线程事件，直到**本轮落定**（turn.completed 且 lifeState 离开 executing，链式多轮自动跟随）才返回。输出：

- `sent <commandId> duplicate=... delivered=...`（投递确认）
- `done reason=turn.completed | failed | idle-no-pending | timeout | unreachable  life=... failed=... newEvents=...`（落定摘要）+ 事件尾

`done reason=timeout` 不是错误：指令仍在执行，用 `watch` 续挂。幂等键是防重发保险，缺失时参数校验道直接拒绝（`arg_rejected`）。

开工指令必须包含：

- 工单号和工单路径
- 目标仓库、工作目录和允许修改范围
- 已完成前置工单及 commit / 验收证据
- 验收命令
- 不得 reset、clean、覆盖其他会话改动
- 需要最终报告哪些通过项、失败项、未验证项和风险

不要把"前置未满足时每 15 分钟自查"交给 coder。那会消耗模型调用，并且 turn 结束后不会自动醒来；依赖等待必须由调度方完成。

## 监控（send 阻塞 + watch 续挂）

**标准路径**：`send` 自带阻塞等落定，一次调用完成派发到落定，无需单独 watch。返回 `done reason=timeout` 时改用 `watch` 续挂。

**续挂监控**（指令仍在执行 / 分轮盯进度）：

```text
coder_shell command="watch wt-xxx"
```

**纯监视已运行线程**（不派发任何指令，只挂到一条正在执行的线程上等它干完）：同一条 `watch` 命令——不派发、不修改线程状态，可安全挂在任何执行中的线程上。

watch / send 的落定摘要行为一致：

- `done reason=...`：`turn.completed` 本轮落定（链式多轮自动跟随）；`idle-no-pending` 线程空闲无 pending；`failed` failed=true（按故障表介入）；`timeout` 工具超时（正常续挂信号，续挂 `watch` 即可）；`unreachable` 线程/server 连续不可达
- 摘要附事件尾（`turn.started` / `turn.completed` / `item.*` 等）供快速取证

超时不需要做别的——`watch` 续挂之间不需要 sleep、不需要查 git status；事件流停滞或摘要异常时才取证。

### 异常取证（仅在 watch 停滞 / done failed=true 时做）

**Debugger agent 活动**：用 debugger MCP 查目标 agent 最新日志（取最新 offset 或按时间过滤，旧窗口不代表当前状态），重点看最近的 `Step started`、工具成败、`command timed out`、是否发生接力。

**两个仓库的工作区**：

```bash
cd /home/dev/AgentDevClaw && git status --short && git diff --stat && git log -5 --oneline
cd /home/dev/AgentDev && git status --short && git diff --stat && git log -5 --oneline
```

状态解释：

```text
无文件变化 + agent 有新 step       = 调研或验证阶段
无文件变化 + agent 无新活动         = 可能卡住，查日志和线程
文件变化                         = 施工中，检查是否越界
工作区变干净 + 出现新 commit        = coder 可能自行提交，不是文件丢失
```

## 长命令、超时和卡住处理

`send` / `watch` 超时返回结构化 `done reason=timeout`（非错误）：指令仍在执行，续挂 `watch` 即可，不要重复派发。处理顺序：

1. 查线程事件尾摘要和 Debugger 最新日志。
2. 判断 agent 是否仍有新 step。
3. 若仍活跃，继续 `watch` 续挂等待。
4. 若已失败且命令滞留 pending（runtime 已死 / server 重启清空），用恢复闸重投：

   ```text
   coder_shell command="deliver wt-xxx"
   ```

   deliver 遇 runtime 不在时会自动唤起 head runtime 再投一次；唤起失败会在响应 `runtimeWake` 中带原因（按故障表处置）。

5. 如需修正，发送一条明确的恢复指令（`send` + 新幂等键），说明上次命令超时，禁止再次运行相同无界命令，改用定向测试或分段构建。
6. 只有确认旧 turn 已结束且线程可接收新指令时才 send。
7. 不要直接杀进程、重启 server 或删除临时状态来掩盖问题。

建议给 coder 的验证顺序：

```text
单文件/单包静态检查
→ 定向测试
→ 单包构建
→ 相关回归测试
→ 全量测试
```

### agent 自动接力

WorkThread 可能出现：

```text
旧 agent 下线
→ headSessionId 推进
→ 新 agent 实例接棒
→ 原线程继续执行
```

这通常是正常的上下文接力，不应当立即判定为失败。接力后重新确认：

- 新 `headSessionId`
- `sessionIds` / chain edges
- 新 agent 的日志活动
- 原工单上下文是否保留
- 是否出现重复施工或越界改动

仅在新 head 没有上下文、pending command 丢失、长期无事件或重复施工时介入。

接力失败的标记是线程 `status=rotation_failed`（列表里 `failed=true`）：旧 head 已退役、新 head 未生效，指令滞留在 Inbox。此时**不要重发施工指令**，按故障表的 rotation_failed 行恢复——`advance` / `resume` 不在动词表内，人工按故障表处置。

## 越界改动处理

发现工作区有工单未列出的改动时：

1. 不要 reset、clean 或 checkout 覆盖。
2. 查看修改文件、diff、文件修改时间和 git log。
3. 查询所有活跃 workspace agent，确认是否属于另一条线程。
4. 如果是完整且相关的独立模块：单独测试、单独 commit，不混入当前票。
5. 如果是其他会话的未完成工作：保持原样，等待其完成后再按模块收口。
6. 只有确认归属后才执行 `git add`。

"工作区干净"也可能意味着 agent 已自行 commit；必须检查最近 commit，而不是只看 `git status`。

## 完成验收

coder 报告完成后，调度方必须自己核验：

1. 工单要求的新文件和修改文件存在。
2. 被迁代码无残留，加载顺序和依赖关系正确。
3. 测试命令真实通过，记录测试数量。
4. 构建产物已更新；框架 dist 改动记录所需重启范围。
5. `git diff --check` 通过。
6. 无关文件未被纳入。
7. 明确区分"已验证"和"需要重启后补冒烟"。

完成后按板块提交，不要把多张互不相关工单揉成一个 commit：

```bash
git add <已验收文件>
git commit -m "<type>(<scope>): <最终状态描述>"
git status --short
git log -1 --oneline
```

默认由调度方负责 push；push 是共享状态变更，必须得到明确授权。

## 归档线程

工作收口后归档线程（归档宾语是线程，不是会话；成员会话随线程折叠）：

```text
coder_shell command="archive wt-xxx"
coder_shell command="unarchive wt-xxx"
```

规则（归档即打断收纳语义，2026-08 K17 裁决）：

- 归档不做 busy 检查：线程执行中归档会**直接打断当前轮并收纳**（interrupt head → 停全链 runtime → 拒收新指令），不会返回 409。建议确认最后一个 turn 已结束再归档，但系统不强制。
- 已归档线程拒绝 `send` / `deliver` 新指令；要继续工作就开新线程。
- 取消归档随时可做，用于翻查后恢复；恢复后 runtime **不会自动启动**，需要重新投递指令唤醒。

## 故障处置速查表

| 现象 | 先查 | 处理 |
|---|---|---|
| server 不可达 | `npm start` / `PORT` | 启动或确认端口，不重复发送命令 |
| `delivered=0` | thread `status`、`pendingTexts`、head session | runtime 无承接：重新 `send`（幂等键防重）即可，send/deliver 的恢复闸会自动唤起 head runtime 再投；仅 `runtimeWake` 失败时按上面两行处置 |
| `failed=true` / `status=rotation_failed` | 事件尾部 `handoff_failed`、pending commands | 接力失败：`advance` / `resume` 不在 coder_shell 动词表内，残局需人工介入——人工按 head CAS 语义恢复或重走手动 compact；恢复前不要重发施工指令 |
| 执行中误归档 | 事件尾部 turn 是否被打断 | 归档即打断收纳是预期行为；翻查后 `unarchive` 恢复，重新投递指令唤醒 runtime |
| `runtimeWake` 失败（`head_session_missing`） | 会话索引、线程 head | head 会话已被删除，线程无法恢复：取消 pending 指令后归档线程，重新建线程派发 |
| `runtimeWake` 失败（`runtime_ready_timeout`） | server 日志、agent 装配 | 唤起已尝试但 runtime 未 READY：查启动失败原因（如 worktree 缺 config），修复后重新 send（幂等键防重） |
| send/watch 返回 `done reason=timeout` | 线程 lifeState | 指令仍在执行，属正常续挂信号：用 `watch` 续挂，不重复派发 |
| 只有 `delivered=1` 无开工迹象 | 线程事件、agent 连接状态 | 保持 dispatched，查 runtime，不重复派发（send 已自动唤起 runtime；此态多为唤起超时） |
| 600 秒工具 timeout | 事件尾、最新日志和进程状态 | 指令仍在执行：`watch` 续挂；长指令改成分段/定向命令，避免重复无界命令 |
| 文件突然变干净 | `git log`、agent 最终报告 | 先确认是否自行 commit |
| agent 接力 | `headSessionId`、`sessionIds`、新 agent 日志 | 通常继续监控，不立即重派 |
| 线程长期无新事件 | show、agent lastActive、pending commands | 发一次明确恢复指令；仍无响应再 deliver / 人工介入 |
| 修改了不相关文件 | git diff、文件时间、其他 agent | 分离归属，禁止 reset 覆盖 |
| 测试失败 | 失败文件、是否基线失败 | 区分本票回归、环境失败、既有失败，报告真实边界 |

## 调度报告模板

每轮报告保持简短，使用：

```text
工单：025
线程：wt-...
head：session-...
状态：executing / validating / waiting-dependency / blocked

本轮证据：
- thread event：...
- agent step：...
- workspace diff：...
- 测试/构建：...

风险或阻塞：...
下一动作：续挂 watch / 发送恢复指令 / 验收 / 按板块提交
```

最终报告必须列出：

- 实际修改文件
- 验收命令和结果
- 已验证项
- 未验证项及原因
- 生成的 commit（如已授权）
- 仍需重启、补测或人工确认的事项
