# ADR 0019: 轮次挂起语义（suspended）与 pending-work 事实层

日期：2026-09-27
状态：已接受

## 背景与问题

shell-feature 的后台 bash 让任务在 call 边界之外存活（`BgRegistry`），任务经 ViewerWorker user-turn 端口以 reminder 唤醒 agent。但"回合结束"只有一个机器语义：`completed`。由此产生两类同形的"中间停止"——bg_wait guard 打断的回合、模型自然结束但任务仍在跑的回合——与真完成无法区分，四个消费端全部误判：

1. **audio-feedback**：每次回合结束都播音效，包括每条后台进度汇报唤醒的回合。
2. **Claw 桌面通知**：把汇报唤醒后的回合结束弹"已完成"（去重窗口 30s，小于汇报最小间隔 60s，每条汇报都能再 ping 一次）。
3. **TodoFeature CallStart**：对每个唤醒注入"请根据当前任务计划继续推进"。
4. **ControlledTodoFeature"执行到此处"**：强续 Approve 与 ShellFeature bg_wait guard 的 Deny 靠钩子注册顺序偶然仲裁，先注册者胜，另一方的副作用被跳过。

调研结论（含九场景压力测试）：唤醒通道（user-turn 端口）与状态投影（ADR-0018 feature-comms）已经通用，缺的只是结束侧的语义回写；统一任务管理面在当前没有第二消费者时属于过度工程。

## 决策

### 1. `ExecutionReason` 增加 `'suspended'`；status 轴复用 `'continued'`

`lifecycle.ts` 的 `ExecutionReason` 增加 `'suspended'`。`createCallOutcome`（agent.ts）将其映射为 `status: 'continued'`：挂起即"移交给后续唤醒单元"，与 continuationRequest 同属 ExecutionStatus 注释里"移交给后续单元"的语义。不新增 status 值——按 status 分流的既有消费端（如桌面通知的 stage 白名单）自动获得正确行为。

### 2. 判定规则：pendingWakeups 非空即挂起

回合结束时 pendingWakeups 非空且 finishReason 将为 `completed` → 改判 `suspended`。

产品裁决：**后台还有任务在跑，就是没做完**。据此否决两个替代方案：

- "仅显式订阅（bg_wait 在场）才算挂起"——订阅一次性消耗，汇报唤醒后的回合无订阅，同一段逻辑工作会出现挂起/完成交替的语义抖动。
- "教模型真完成前主动 bg_kill 收尾"的 prompt 契约——语义正确性不依赖模型记性；模型忘收尾时真完成会永久静默，比现状更糟。

真完成且不再需要任务时的 `bg_kill` 由模型按工具语义自然决定，不是语义正确性的依赖。

### 3. pendingWakeups 是运行时事实，进 CallOutcome

`CallOutcome` 增加可选 `pendingWakeups: PendingWakeup[]`（`{ source, id, summary }`）。它是回合结束时刻的运行时事实快照：不进对话上下文、不进 checkpoint 语义、随 runtime snapshot / notification / session-events 自然透传。会话恢复后保留为历史记录（描述"上次 call 结束时"的事实，恢复进程内任务必已死，见决策 9）。框架不解释 `source` 语义——与 user-turn metadata 同一纪律：key 由消费方命名空间化。

### 4. 优先序

多条件同时命中时报最强终态：`error > cancelled > suspended > continued > completed`。

### 5. Agent 级 pending-work 申报通道（最小版）

Agent 提供 `registerPendingWorkProvider(source, provider)` 与 `collectPendingWakeups()`；feature 拿到 agent 引用后申报，shell-feature 从 BgRegistry 取 running 任务。这是"框架提供事实、feature 做决策"既有模式（`hasActiveSubAgents` / `hasPendingMessages`）的延伸。

升格为通用 pending-work 声明 API + 统一投影的条件：出现第二个真实消费者（IM 线路等待、群聊回报等）。届时做，不提前猜。

### 6. `StepFinishDecisionContext` 增加 `hasPendingWakeups`

"执行到此处"的强续让位改为数据驱动：ControlledTodoFeature 的 StepFinish guard 读 `ctx.hasPendingWakeups`，非空时不 Approve，让回合正常挂起。不启用 hook `policy` role——它在框架内零真实使用者，首次启用等于立新契约，当前没有不可让位的场景。

### 7. session-events 向后兼容

`turn.completed` 事件增加可选 `suspended` 标志与 `pendingWakeups`，不加新事件类型。注意主链路 `if (result.completed)` 的分支：suspended 必须走 `turn.completed` 而非 `turn.failed`——挂起不是失败。

### 8. 唤醒投递按会话路由

bg-core 通知投递（user-turn）补 sessionId，ViewerWorker 按会话归属路由，修复"共享进程多会话时唤醒固定打给首个建表会话"的错位。这是正确性问题，随本期一并修，不等第二消费者。

### 9. 不做清单（显式边界）

- **统一任务管理面**：各域生命周期语义根本不同（进程 kill 树 / IM 断连重连 / subagent 消息回填 / coder 线程归档事务），管理面会压平成最低公分母。等第二个真实消费者。
- **跨 runtime 任务保活**：runtime 进程死 = 其后台任务死（exit guard 收割），是产品语义。会话 trim / 分支 / 接力不保活任务，用户教育靠任务面板。
- **IM 挂起推送**：挂起瞬间不向渠道推状态消息（噪声），任务完成唤起后的回复正常推。
- **输入队列优先级**：bg 汇报与用户消息同队列 FIFO，250ms 聚合窗当前够用，"汇报可合并、用户消息不可"留作演进记账。

### 10. 失效信号

- 若半年内没有任何消费端真正依赖 suspended 做差异化行为（只是顺手跳过），应考虑降级实现而非堆平行枚举。
- 当"任务跨 runtime 存活"（会话接力保任务、崩溃后任务收养）成为真实需求，server 级任务管理从过度工程变为必要——届时另立 ADR，本决策的"不做"边界即失效条件。

## 后果

**正面**：音效、桌面通知、todo 催促、强续让位四个误判由同一语义修复消掉；suspended 是既有枚举轴上的新值而非平行布尔，将来多源挂起（IM 线路、群聊回报、monitor）汇入同一条轴；pendingWakeups 是运行时事实，天然免疫 rollback / trim / compact 的语义漂移。

**代价**："完成但留任务"（如 dev server 常驻）判 suspended，完成提示延迟到任务收尾或用户插话——接受，留任务即没做完；provider 未注册时行为降级为现状（completed），无害但要求装配方注册。

**中性**：不认识 suspended 的旧消费端对 `status: 'continued'` 已有处理路径，安全降级。
