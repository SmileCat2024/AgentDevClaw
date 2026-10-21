---
name: claw-coder-dispatch
description: "Claw Coder 智能体调度（claw-coder-dispatch feature 内嵌技能）：用 coder_shell 工具创建 Coder 工作线程、派发工单并后台监视、监视执行、处理超时/接力/待投递命令，完成后按仓库和板块提交并归档线程收口（未归档线程占用线程并发名额，工单闭环以归档收口）。仅适用于智能编码工作空间中的 Coder 智能体。"
---

# Coder 智能体调度 Skill

本 Skill 调度**智能编码工作空间**中的 **Coder 智能体**（自主编码的子代理）。

派发 Coder 智能体干活前先读完本文，再使用 `coder_shell`。

- 会话和线程在 Web UI 左侧「coder」入口下可见，可发生接力
- 归档是线程级操作：执行中归档会直接打断当前轮，已归档线程拒绝新指令
- 工作空间有「线程并发上限」（用户设置，缺省不限）：限制未归档线程数量，满额时新建线程被拒、已有线程不受影响——**收口归档是释放名额的唯一途径，工单闭环以归档收口**

## 适用范围与限制（先读）

- **仅限领域内使用**：coder_shell 只做一件事——调度智能编码工作空间中的 Coder 智能体（建线程、派发工单、监视、收口）。它不是通用 bash：文件操作用 read/write/edit 工具，代码搜索用 glob/grep 工具，一律不要塞进这个 shell。
- **工具受限**：只认识下表动词；语法只放行**字面量参数、声明 flag（如 `--dispatch-only`、`--status=executing`，`=` 赋值 flag 可出现在参数任意位置）、管道 `|`、重定向 `> >> <`**。命令替换 `$()`/反引号、变量 `$x`、进程替换、glob 通配、heredoc、后台 `&` 一律拒绝；`rm`、`curl`、`git` 等不在动词表内的动词直接拒绝并附可用动词清单。拒绝是终态，换正确的动词重试，不要绕。

## coder_shell 用法

全部调度经 `coder_shell({ command })` 完成，command 是一条管道命令字符串。可用动词（10 个）。`new-session` / `create` 的 agentId 参数**恒为 `coder`**——coder 是独立 APP（ADR-0025），Coder 会话直接以 `agentId=coder` 寻址创建，传其它值会被结构化拒绝：

| 动词 | 语义 |
|---|---|
| `new-session <agentId> <目标工作目录> ['标题']` | 创建 Coder 会话并自动建线（标准第一步，返回 sessionId + threadId）；**目标工作目录必填**（已存在的绝对路径，服务端拒绝目录回退默认） |
| `create <agentId> <sessionId> ['标题']` | 给已存在的会话加挂线程，返回 threadId |
| `send <threadId> <idempotencyKey> '<指令文本>' [--dispatch-only]` | 提交并默认登记后台监视，快速返回；--dispatch-only 只提交不监视 |
| `watch <threadId> [threadId...] [--command=<commandId>]` | 查询/建立监视并请求一次性待命；目标已结束则直接返回结果 |
| `result <threadId> [--turn=N]` | 取线程末轮回复全文（coder 的最终报告，落定后取证用）；多轮回复时附全部轮次索引，--turn=N 取指定轮回复全文 |
| `list [agentId] [过滤flag]` | 线程列表（默认按最近活动倒序取 10 条非终态线程；支持状态/目录/标题检索，见下文「线程检索」） |
| `show <threadId>` | 线程详情（pending 指令数 + 事件尾摘要） |
| `archive <threadId>` / `unarchive <threadId>` | 归档/恢复 |
| `deliver <threadId>` | 恢复闸重投 pending 指令 |

裸 `help` 输出动词表用法（管线级，不占动词表）；`advance` / `resume` **不在动词表**：调用会得到 unknown_verb 和结构化指引——rotation_failed 残局需人工介入（见故障表），不要在 shell 内重试。`rm`、`curl` 等其他动词同样被拒并附可用动词清单。

控制面提交受工具 timeout 契约约束。请求结果未知时先查询幂等回执，不换键重派。观察不占用工具超时窗口；后台读取失联会明确通知。

### 线程检索（list）

默认行为：按**最近活动倒序**取 **10 条**非终态线程（已归档/已关闭不出现，隐藏量在尾部附提示行）；每行含 threadId / lifeState / failed（异常才打印）/ status≠open（异常才打印）/ pending 指令数 / title / dir（head 会话项目目录）/ created / upd。检索语法（valued flag 一律 `=` 赋值形态，可出现在参数任意位置）：

`status=rotating` = 上下文接续进行中（正常中间态，无需干预，watch 会自动跟随到新 head）；`status=rotation_failed` 配合 `failed=true` 才是接力失败（按故障表处置）。

```text
list coder                                  # 某 agent 的线程
list --status=executing,pending-commands                 # 只看执行中 / 有待投递指令的
list --dir=/home/dev/AgentDevClaw                        # 按项目目录检索（含子目录归属）
list --title=工单025                                     # 按标题关键字检索
list --failed                                            # 只看 failed=true（接力失败 / 看板失败）
list --all                                               # 含已归档/已关闭（翻查历史工单用）
list -n=0                                                # 不限条数；-n=50 显式指定条数
```

- 过滤可叠加（如 `list --dir=/home/dev/AgentDevClaw --status=executing`）；`--dir` 匹配相等或子目录（大小写与 `\` / `/` 归一）
- 检索返回空且无终态隐藏时是真空结果；翻查归档线程用 `--all`
- `list` 是轻量核对入口：核对建线结果、按仓库收口归档时按目录检索，不要逐条 `show` 烧上下文

## 核心不变量

1. **依赖由调度方控制，不由 coder 自主轮询。** 前置工单未完成时，可以创建线程但不要发送施工指令。
2. **一个工单一个线程。** 不要把多个互不相关工单塞进同一条线程。
3. **有文件交集的工单必须串行。** 无交集且不共享构建产物的工单才可以并行。
4. **提交成功不等于业务完成。** send 默认登记后台监视后返回；可以继续工作，重要执行事件自动通知。只有显式 --dispatch-only 不登记监视。
5. **以证据判定完成。** 最终报告、文件 diff、测试输出、构建产物和 git 状态必须相互吻合。
6. **绝不覆盖其他会话的工作。** 禁止使用 `git reset --hard`、`git clean`、`git checkout -- .` 清理未知改动。
7. **默认不让 coder 自行 push。** commit、push、分支操作由调度方在验收后执行，除非工单明确授权。
8. **幂等键是防重发保险。** `send` 必填唯一幂等键（服务端按键去重，同键重发三种结局见下文"幂等键语义"）；**不要**故意重发同键指令去"验证去重是否生效"。
9. **使用后台监视，不用模型定期轮询。** show/list/result 是主动取证入口，不用 sleep 加查询模拟监视。
10. **可以结束轮次等待自动通知。** watch 表达一次性待命；自然结束且仍有监视时按 suspended 等待。监视失效时按通知重新建立，不能假设旧连接仍有效。
11. **工单闭环以归档收口。** 验收提交完成、工单了结后归档线程——未归档线程持续占用线程并发名额，攒着不归档会挡住后续工单的创建（429）。只归档**自己创建并已验收**的线程；不是自己建的线程不要动，拿不准归属就先问用户。


## 前置检查

调度前先确认线程面可达：

```text
coder_shell: list coder
```

同时用文件工具确认目标仓库和工作区状态（git status / branch）。如果已有未提交改动，先按文件和时间线判断归属，不要直接清理。目标项目目录在这里一并确认（创建 coder 会话时必须显式指定该目录）。

`list coder` 的返回同时是并发余量的核对入口：非终态线程就是占用中的名额。工作空间配了线程并发上限时，未归档线程数到达上限，新的 new-session 会被拒（预检与 429 报文都会提示）——此时先收口归档自己的已完成线程，再派发新工单。

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
→ archived
```

push 需授权可能延迟：`committed` 后即可归档收口（归档不影响后续 push，push 由调度方在主线任务里执行）；不要为了等 push 把已了结的线程一直晾在非终态占名额。

### 2. 创建 coder 会话并建线（标准第一步）

```text
coder_shell command="new-session coder /home/dev/AgentDevClaw '工单025 工具进度UI'"
```

输出两行：`sessionId=...` 与 `threadId=...`，threadId 直接用于 `send` 派发。线程列表用 `list coder` 核对。

`new-session` 是标准第一步：创建会话时线程宿主工作空间会自动建线，不需要再单独 create。threadId 为 null（未自动建线）时，按报文提示用 `create` 手动建线。

**目标工作目录必须显式指定且不可省略**（第二个位置参数）：coder 会话绑定到该目录开工，目录选错 = 在错误的项目里施工。服务端拒绝目录回退默认（缺省会绑定 workspace 最近目录，几乎必然绑错项目），本地也会校验目录存在与绝对路径。目录必须是工单对应的目标仓库根目录，从工单内容确认，不要沿用上次派发的目录。

`create` 仅用于给**已存在**的 Coder 会话加挂线程（例如会话已存在但线程丢失的补建场景）。给不存在的 sessionId 调 `create` 会被拒绝——先用 `new-session` 创建会话再派发。

```text
coder_shell command="create coder <session-id> '工单025 工具进度UI'"
```

返回单行 `threadId=... lifeState=... status=... head=...`。标题在创建/建线时一次写入，线程标题自动跟随会话标题。线程列表用 `list coder` 核对。

### 3. 依赖满足后发送开工指令并登记监视

长指令先写文件再读入内容拼进 command（单引号字面量；文本内单引号按 shell-quote 规则转义）。发送必须带唯一幂等键：

```text
coder_shell command="send wt-xxx ticket-025-dispatch '<指令全文>'"
```

`send` 返回真实提交回执和监视状态，不等待业务执行结束。只提交不监视时显式使用 `--dispatch-only`；旧 `--no-wait` 已删除，不再使用。

提交成功、监视失败是两个独立事实：回执仍然有效，按返回的 commandId 重新 `watch`，不要换键重派。重复幂等提交复用同一观察目标；同线程不同提交各自关联。

并行派发无须专门 flag：分别 send 即可。需要待命时调用 `watch wt-aaa wt-bbb`，也可以自然结束轮次等待通知。

**幂等键语义（同键重发的三种结局，服务端真实契约）**：

| 场景 | 服务端行为 | 调度方该做什么 |
|---|---|---|
| 新键 | 指令入箱，runtime 就绪即内联投递（HTTP 201） | 等 `send` 落定或 `watch` |
| 同键，指令尚在（pending/滞留） | `duplicate=true`，**不重复入箱、不做内联投递**；但每次 send 都会先尝试唤起 head runtime，唤起成功后由投递消费者异步拾取 pending 指令 | 唤起失败的显式重投用 `deliver`；不要换新键重发同一指令 |
| 同键，指令已执行 | `duplicate=true`，不会重新执行 | 修正/追加指令必须用**新键** |

即：同键重发是"唤醒 + 等消费者"的恢复动作，不是再执行；想真正再跑一遍就换新键。`delivered=0` 时优先 `deliver`（恢复闸语义更直接）。

开工指令按派发目的撰写。派发前先想清楚这张工单要 coder 做什么：独立调查，还是执行施工。

**调研 / 审查 / 探索类：指令界定问题域和边界，结论留给 coder。** 你可以指明调查方向——方向本身就是边界，防止调查失焦；但不要把判断塞进问题里。"评估 X 模块在并发场景下的健壮性"是在划定问题域；"X 是否存在 Y 竞态"则预先限定了答案的方向，coder 会顺着你的怀疑去找证据，你没想到的问题反而无人覆盖。指令写清楚：要回答的问题域、调查范围与排除项、只读或允许修改的范围、输出要求。你自己的怀疑不必写进指令，留到验收时对照报告：coder 未覆盖的点，再针对性追问。

**施工类：指令交代清楚目标、范围、约束和验收标准，环境层面的决策在派发前想好并明确写入。** 包括：是否允许 commit、push、分支操作；在目标目录直接施工，还是开 worktree / 独立分支；与当前其他活跃线程是否有文件或构建产物交集（决定串行还是并行）；工单完成后工作区允许的最终状态。coder 不掌握全局——有几条线程在跑、验收时 git 该是什么样，只有你知道；涉及明显副作用（提交、分支）、多 Agent 并发的环境冲突或复杂依赖的工单，边界尤其要写完整，避免 coder 在信息不全时自行决策。

开工指令必须包含：

- 工单号和工单路径
- 目标仓库、工作目录和允许修改范围
- 已完成前置工单及 commit / 验收证据
- 验收命令
- 不得 reset、clean、覆盖其他会话改动
- 需要最终报告哪些通过项、失败项、未验证项和风险

不要把"前置未满足时每 15 分钟自查"交给 coder。那会消耗模型调用，并且 turn 结束后不会自动醒来；依赖等待必须由调度方完成。

## 后台监视与待命

`send` 默认提交并登记监视，返回 `sent <commandId>` 与监视状态。可以继续处理其他工作，也可以自然结束本轮；存在有效监视时框架按 suspended 等待通知。完成、失败、需要干预和监视失效会自动送达，正常工具活动和正常接力不反复唤醒。

`watch wt-aaa wt-bbb` 查询或建立监视，对仍运行的目标请求一次性待命，工具完整返回后才结束本轮。已结束的目标直接返回结果。`watch wt-aaa --command=cmd-xxx` 精确选择一次提交；没有 `--command` 时查询该线程保留的 coder_shell 派发。重复观察不会重复派发任务或重复通知同一终态。

不要用 sleep 后轮询 show/list/result 替代后台监视。自然结束回合不会取消 Coder。只有明确要停止执行时才使用线程归档等领域操作；不要用归档来结束自己的等待。

完成通知含关联标识、实际终态及结果摘要或证据缺口。用 `result wt-xxx [--turn=N]` 补取完整报告，并核对 diff、测试与构建，不以自然语言“完成”代替验收。

主 Agent 接续或重启不会透明恢复观察连接。若提示此前监视未恢复，按提示先查询并重新 watch，获取空窗内结果；不要重发原任务。迟到通知仍固定投给原会话，不按界面焦点改投。

### 异常取证（仅在 watch 停滞 / done failed=true 时做）

**Debugger agent 活动**：用 debugger MCP 查目标 agent 最新日志（取最新 offset 或按时间过滤，旧窗口不代表当前状态），重点看最近的 `Step started`、工具成败、`command timed out`、是否发生接力。

**两个仓库的工作区**（路径按实际环境替换，本机开发仓通常为 `D:/code/AgentDevClaw` 与 `D:/code/AgentDev`）：

```bash
cd <AgentDevClaw 仓库根目录> && git status --short && git diff --stat && git log -5 --oneline
cd <AgentDev 仓库根目录> && git status --short && git diff --stat && git log -5 --oneline
```

状态解释：

```text
无文件变化 + agent 有新 step       = 调研或验证阶段
无文件变化 + agent 无新活动         = 可能卡住，查日志和线程
文件变化                         = 施工中，检查是否越界
工作区变干净 + 出现新 commit        = coder 可能自行提交，不是文件丢失
```

## 长命令、超时和卡住处理

监视异常通知与执行失败分别处理；提交请求超时不代表任务取消，不重复派发。处理顺序如下。

1. 查线程事件尾摘要和 Debugger 最新日志。
2. 判断 agent 是否仍有新 step。
3. 若仍活跃，继续 `watch` 续挂等待。
4. 若已失败且命令滞留 pending（runtime 已死 / server 重启清空），用恢复闸重投：

   ```text
   coder_shell command="deliver wt-xxx"
   ```

   deliver 遇 runtime 不在时会自动唤起 head runtime 再投一次；唤起失败会在响应 `runtimeWake` 中带原因（按故障表处置）。deliver 返回 `reason=handoff_in_progress` 时表示线程正在接续中：指令保持 pending，接续完成后自动导向新 head，无需干预。deliver 结果里单条指令带 `reason=succession_precondition_violated` 时，那是系统的接续唤醒指令被作废（接续未完成、措辞前提不成立），不是你的指令——你派的指令不受影响；要继续工作直接 `send` 新指令即可。

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

这通常是正常的上下文接力，不应当立即判定为失败。接力的直接信号是 `show` 报文的 `head=<sessionId>` 与之前不同，事件尾出现 `handoff_*` 事件。接力后重新确认（全部经 `show` + `watch` 即可完成）：

- 新 `head=<sessionId>`（show 第一行）
- 事件尾最近事件正常推进（turn.started / item.*）
- 新 agent 的日志活动（Debugger）
- 原工单上下文是否保留（`result` 看最近轮回复是否延续工单语境）
- 是否出现重复施工或越界改动（git diff）

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

coder 报告完成后（`result wt-xxx` 取末轮回复全文），调度方必须自己核验：

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

验收提交完成后工单即了结，最后一步是归档线程收口（见下文「归档线程」）——未归档线程持续占用线程并发名额，工单闭环以归档收口。

## 归档线程

工作收口后归档线程（归档宾语是线程，不是会话；成员会话随线程折叠）。归档同时释放线程并发名额——这是工作空间「线程并发上限」体系内回收名额的唯一途径。

```text
coder_shell command="archive wt-xxx"
coder_shell command="unarchive wt-xxx"
```

规则：

- **只归档自己创建并已验收的线程**。不是自己建的线程（用户手建、其他会话派发、ACP / CLI 创建）不要动；归属拿不准就先问用户，宁可多问一次也不要错归档打断别人的工作。
- 归档不做 busy 检查：线程执行中归档会**直接打断当前轮并收纳**（interrupt head → 停全链 runtime → 拒收新指令），不会返回 409。建议确认最后一个 turn 已结束再归档，但系统不强制。
- 已归档线程拒绝 `send` / `deliver` 新指令；要继续工作就开新线程。
- 取消归档随时可做，用于翻查后恢复；恢复后 runtime **不会自动启动**，需要重新投递指令唤醒。

## 故障处置速查表

| 现象 | 先查 | 处理 |
|---|---|---|
| server 不可达 | `npm start` / `PORT` | 启动或确认端口，不重复发送命令 |
| new-session 预检拒绝（线程并发上限已满）/ 创建返回 429 | 未归档线程数、设置 → 工作空间的线程并发上限 | 归档**自己**已完成的线程（archive）释放名额后重试；或请用户调高上限；不要反复重试创建，也不要动别人的线程腾位 |
| `delivered=0` | thread `status`、`pendingTexts`、head session | runtime 无承接：重新 `send`（幂等键防重）即可，send/deliver 的恢复闸会自动唤起 head runtime 再投；仅 `runtimeWake` 失败时按上面两行处置 |
| `failed=true` / `status=rotation_failed` | 事件尾部 `handoff_failed`、pending commands | 接力失败：残局需人工介入——报告用户恢复；恢复前不要重发施工指令 |
| 执行中误归档 | 事件尾部 turn 是否被打断 | 归档即打断收纳是预期行为；翻查后 `unarchive` 恢复，重新投递指令唤醒 runtime |
| `runtimeWake` 失败（`head_session_missing`） | 会话索引、线程 head | head 会话已被删除，线程无法恢复：取消 pending 指令后归档线程，重新建线程派发；若环境无可用 Coder 会话，先 `new-session` 再派发 |
| `runtimeWake` 失败（`runtime_ready_timeout`） | server 日志、agent 装配 | 唤起已尝试但 runtime 未 READY：查启动失败原因（如 worktree 缺 config），修复后重新 send（幂等键防重） |




| 只有 `delivered=1` 无开工迹象 | 线程事件、agent 连接状态 | 保持 dispatched，查 runtime，不重复派发（send 已自动唤起 runtime；此态多为唤起超时） |

| 文件突然变干净 | `git log`、agent 最终报告 | 先确认是否自行 commit |
| agent 接力 | `headSessionId`、`sessionIds`、新 agent 日志 | 通常继续监控，不立即重派 |
| 线程长期无新事件 | show、runtime 存活事实 | 长工具调用无新事件正常；只在 runtime 明确失联或收到监视异常通知时取证 |
| monitor_unreachable / runtime_unavailable / association_lost | commandId、线程详情、保留事件 | 修复连接或核实证据后重新 watch，不重发任务；事件已裁剪时需主动验收 |
| thread_archived / thread_closed / thread_deleted | show / list --all | 确定生命周期终态，不当作任务成功；需要继续施工则新建线程 |
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
下一动作：续挂 watch / 发送恢复指令 / 验收 / 按板块提交 / 归档收口
```

最终报告必须列出：

- 实际修改文件
- 验收命令和结果
- 已验证项
- 未验证项及原因
- 生成的 commit（如已授权）
- 线程收口状态（已归档 / 留存原因——如等待 push 授权、尚有后续工单复用）
- 仍需重启、补测或人工确认的事项
