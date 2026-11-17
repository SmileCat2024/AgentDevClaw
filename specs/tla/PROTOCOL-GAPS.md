# 协议缺口的顺序验证

目标是分别找到违反既定契约的行为，以及需要产品裁决的语义边界。模型通过不等于实现证明；观察回放成功不等于被观察行为正确。生产代码不在本轮修改范围。

## 运行环境与基线

2026-11-17，本机 Claw 基线 `040328ce`、相邻 AgentDev `0de4836`；后者 core/viewer 已重新构建。官方 TLA+ Tools 1.7.4（TLC 2.19）安装在用户目录 `~/.local/share/tlaplus/1.7.4/tla2tools.jar`，支持 `TLA2TOOLS_JAR` / `JAVA` 覆盖。本机实际 Java 为 Eclipse Adoptium 11.0.31，不是首次报告的 Java 21。

原四个基准与十三个深化场景已在本机完整重跑，均匹配明确声明的通过/安全反例/活性反例结果。运行产物在 `artifacts/run-*` 与 `artifacts/deep-8q2mH1/`，不入 Git。

## 一、消费事实、快照与接续证据

### 独立描述的事实

`SuccessionEvidence.tla` 区分用户载荷在内存中、成功 Session 快照、发出事件、Board 收到事件、事务外读取证据、事务内分类与待核对通知。一个已 delivered 的命令、一次调用、一次证据读取、一次换头与一次崩溃，穷举这些动作的有限交错。`Integrity` 明确区分 ok/missing/corrupt/unreadable。

没有把所有 consumed 集合视为真实持久接管：这是原 `SuccessionWindow.tla` 所省略的证据接缝。模型不覆盖 HTTP 事件传播、磁盘损坏细节、多棒历史、Viewer ack 或用户取消。所有模型成功只支持这一范围。

### 结果与性质来源

运行 `node specs/tla/check-succession-evidence.mjs`：

- observations：每次成功换头必须分类为正向引用或 unresolved；未观察到证据不能证明已消费；unreadable 不推进 head；自动通知与 unresolved 同事务。有限探索完成。
- missing/corrupt/unreadable：分别完成有限探索，未降级成虚假正向证据。
- early-reference：`ClassificationRequiresSnapshot` 给出反例——开始事件发出并被 Board 看见，在保存之前即可被分类为已消费。
- durable-reference-control：只在模型内把消费证据发出点移到保存之后，强性质完成探索。这是对照，不是生产修复建议或完整修复证明。
- mutation-missing-is-consumed：故意将缺证据当已消费，`MissingNeverProvesConsumption` 正确拒绝，证明该检查有辨别力。

性质依据为 ADR-0047 的可靠正向消费证据、先快照后确认及不确定性不得静默遗忘。`classified` 表示分类 API 判定，不代表 Inbox 新增 consumed 状态。

### 真实实现回放

```bash
AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/succession-evidence-replay.test.mjs
REQUIRE_EVIDENCE_DURABILITY=1 AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test --test-name-pattern='early turn reference' specs/tla/succession-evidence-replay.test.mjs
```

基线三个用例通过；严格模式的目标断言失败（不是环境或导入失败）。回放使用真实 Agent 发出的 `turn.started`、真实 Board 记录与读取、真实 WorkThread 换头和分类；传输以进程内事件捕获/转交替代，不启动 server/runtime/Viewer，不读用户工作数据。Bridge 接受结果为测试传输桩，验证对象不包含 Viewer 接收协议。Session 保存注入失败，模型客户端不联网。

观察：成功快照 0、ack 0、模型调用 0，但换头结果 `consumedCommandIds` 含命令且 unresolved 为空。说明开始引用不足以证明持久接管，这是新增的分类层缺口；不声称已复现完整宿主崩溃后永久丢失。Board 事件经实际接口写入，未端到端验证 HTTP 事件传播；代码映射为 `Agent.executeCall` 在保存之前发开始事件，`classifyRetiredCommands` 接受该事件的 sourceRef。

另两个回放保护既定边界：读取后才到的正向事件不反向误判，生成 unresolved 和自动通知，独立 Store 重新读取仍可见；missing/corrupt 转 unresolved，unreadable 拒绝换头且保留旧 head 和挡板。该回放只验证进程内捕获/转交边界，不包含真实事件网络传输。

### 需要区分的决定

**明确的不可靠判据**：回合开始引用不能证明快照成功或 durable ownership。修复归属横跨框架事件含义、消费证据和 Claw 宿主装配，不能简单删除所有开始事件或把终态都当成保存成功。

**待设计的证据契约**：独立的持久接管事件/回执如何产生与恢复；Board 中相关性引用与可靠消费证明是否应分开字段；已消费但证据迟到所建 unresolved 如何后续升级。这些不由本轮对照模型自动裁定。

## 二、取消截点与跨层取消

`CancellationCheckpoint.tla` 用三个身份区分截点前已进 Viewer、截点前仅在 Inbox、截点后才到达的输入。Viewer 落盘取消、UDS 帧接收、runtime 清队列及 Inbox 异步回写分别建模，不假设跨进程事务。

运行 `node specs/tla/check-cancellation-checkpoint.mjs`：四个场景均匹配声明。局部截点性质完成探索；旧 Inbox pending 仍可投递和新 runtime 输入被迟到清队列误取消各有反例；同时改变 Inbox 范围和 runtime 清理范围的模型对照通过，不代表生产修复。

实现回放：

```bash
AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/cancellation-checkpoint-replay.test.mjs
REQUIRE_GLOBAL_CANCEL_CUTOFF=1 AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/cancellation-checkpoint-replay.test.mjs
```

观察模式三个用例通过；严格模式 1 通过、2 失败，失败分别命中以下目标，不是环境错误：

- 停止前已入 Inbox、尚未到 Viewer 的 pending 指令不在 Viewer 的取消集合，之后仍可实际投递并 claim。违背 ADR-0047 §6.2 对 Inbox pending 的范围要求。
- Viewer 截点之后、runtime 收到中断帧之前进入 CallArbiter 队列的输入，被无范围的 clearQueue 清理。回放真实 Viewer 中断处理生成帧及真实 Arbiter 收口，模拟帧延迟；证明这两个边界组合允许错误取消，不声称覆盖完整用户输入路由或真实 UDS 调度。
- 正向对照确认 Viewer 本地取消确实持久化、迟到 ack 拒绝、截点后新的 Viewer 输入保留。HTTP 受理成功时 Inbox 旧命令仍可能是 delivered，不能把响应理解为全链取消已完成。

Viewer 不启动监听、队列在临时目录；中断处理直接通过真实处理器与响应收集器调用。Inbox 和 Bridge 真实执行；模型客户端无网络。最初回放曾因把 Bridge 的 user_message 方言原样传入 Viewer 而失败，修正测试适配后重跑通过。缺口不能靠取消所有后续输入来修复，需要携带跨层可比较的范围或其他等价协议。停止受理、当前执行结束、取消事实全链同步是不同承诺，响应/UI 应明确区分。

## 三、换头、runtime 退役与崩溃恢复

`RetirementRecovery.tla` 区分 successor READY、head 提交、旧 runtime 退役、身份采纳、进程丢失、注册表恢复与投递。手动路径允许先提交再停止；自动路径依代码先等待旧 runtime 保存/退出。五个场景均匹配声明：手动窗口与停止失败可发生旧 runtime 领取；自动先停对照完成安全检查；有界故障与公平恢复前提下最终投递；故意缺少注册表重建则活性反例。公平性与注册表重建是模型假设，不是已证明生产一定自动恢复。

```bash
node specs/tla/check-retirement-recovery.mjs
AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/retirement-recovery-replay.test.mjs test/thread-rotation-save-barrier.test.js test/thread-rotation-resume.test.js
REQUIRE_RETIRED_RUNTIME_FENCE=1 AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/retirement-recovery-replay.test.mjs
```

新增回放与已有保存屏障/恢复测试合计 17 通过；严格隔离探针 1 失败。回放执行真实手动 head 路由、WorkThread 事务、Viewer 队列与 claim；进程停止接口注入失败，READY/采纳接口注入成功，不生成真实子进程或 socket。观察到 head 已变 new、指令已入 unresolved、路由返回成功，但旧 Viewer 槽仍能领取同一命令。独立 Store 读回新 head，说明不是事务回滚。

这把旧模型的“旧 runtime 接受”探针推进为带真实路由及停止失败的实现证据。它证明全局换头没有立即撤销旧 Viewer 的本地权力；没有执行 LLM/工具，不报告成已证实重复业务副作用。手动路径停止失败后仅告警而响应成功的代码，与“fencing 兜底”的注释不足以提供全局隔离保证。需裁决退役完成与 head 提交之间是否允许旧执行、失败是否需要隔离状态/持久恢复责任，不能回滚已提交 head 假装成功未发生。

已有自动保存屏障测试确认保存失败/超时/进程退出异常不得读取旧快照继续变换，恢复入口测试确认失败接力可重做及不可唤醒时如实失败。尚未新增真实进程强杀、归档/删除并发和迟到工具输出回放；模型中的一次主机崩溃也不能代表多文件损坏或无限重启。

## 四、去重历史与上下文变换后的迟到重投

`DedupContinuity.tla` 分开 Viewer 窗口、Context 身份、Inbox delivered 不自动重投和 generation 变化。四个有限场景均匹配声明：丢回执 + 超窗 + 同 generation 重新提交可再次进入执行；保留身份、正常 Inbox 重试、换 generation 拒绝旧身份三个模型对照成立。

```bash
node specs/tla/check-dedup-continuity.mjs
AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/dedup-continuity-replay.test.mjs specs/tla/deep-viewer-replay.test.mjs
```

直接运行官方变换观察到：默认 trim 保留用户正文但不带 inputReceipt；preserve 区保留该字段；summary 无逐条回执。邮箱与真实 Agent 的条件回放证实：调用方若提供无回执的变换后 Context，并再次提供相同 generation 的同一命令，该载荷会作为新输入追加并进入模型请求。首次夹具未用 withContext 绑定 Context，不能证明旧内容保留，修正后重新执行。

**这不是正常接续路径的重复执行证明，也不构成新增确定 bug**：正常 successor 推进 generation，旧身份被 Viewer 拒绝；Inbox 不自动重投 delivered，显式 reissue 使用新命令身份，原本就允许作为新的执行决定。条件回放中的 claim 由传输桩提供，未证明生产存在“同 generation 下原地变换 Context 并再次提交”的上游路径；Viewer 超窗重新准入及 generation 拒绝已有独立真实回放。不能把这些分别成立的条件拼成已发生的端到端事故。

契约依据 ADR-0047 阶段 3 已明确去重为有界重试窗口，而不是永久账本。因此 500 条裁剪不是新发现的违约；设计待确认点是是否要跨 Context 变换保留独立身份集合，以及新增旁路是否仍服从 generation/Inbox 防线。不应为承诺业务 exactly-once 而无限保留 transcript。未覆盖断电文件损坏、所有外部重投入口及真实工具副作用。

## 五、待核对生命周期与恢复活性

`UnresolvedLifecycle.tla` 描述 open 待核对项、同一项显式处置、重复处置、通知投递、再次换头、归档/解档、关闭及历史裁剪。八个场景分别检查持久不丢、同一项单次重发、手动免播、后继发现、已处置旧格式命令重新开项、误裁 open 的变异，以及有/无通知丢失的活性对照。通知投递公平不代表必定到达模型：没有重新发现动作时，已投递通知丢失可以导致活性反例。

```bash
node specs/tla/check-unresolved-lifecycle.mjs
AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/unresolved-lifecycle-replay.test.mjs
REQUIRE_OPEN_UNRESOLVED_REDISCOVERY=1 AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test --test-name-pattern='two successions' specs/tla/unresolved-lifecycle-replay.test.mjs
REQUIRE_UNRESOLVED_RESOLUTION_FINALITY=1 AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test --test-name-pattern='legacy delivered' specs/tla/unresolved-lifecycle-replay.test.mjs
```

实现回放覆盖真实处置/查询路由、WorkThread 存储、归档服务与启动恢复扫描，Bridge 传输及 runtime 唤起为可控桩：

- 两个并发 reissue 返回同一新 commandId，原载荷身份关联与 capabilityActivations 持久保留；不同处置返回 409 `unresolved_already_resolved`。投递报错不回滚已持久处置和 pending 输入，独立 Store 读回仅有一条重发。
- 手动免播不生成恢复通知；归档后 open 项仍可经查询接口看到。当前归档不是 closed，允许显式 reissue 生成 held-pending，但不投递；closed 则拒绝 reissue，允许 discard 留存审计且不重新开启线程。
- open 项经过两次换头仍可查询，但第二次没有新歧义命令时不会为旧 open 项再建通知。严格重新发现探针按目标断言失败。
- 有 pending 通知时启动扫描确实唤起；通知已标 delivered、没有 running 看板时，即使存在 open 待核对项也不唤起。此正向/负向对照证明当前扫描不是 open 项重新发现机制。
- **确认的处置闭环缺陷**：兼容旧记录中 delivered 缺少 deliveredAt 时，第一次接续生成 unattributable 待核对项；显式 discard 并持久收口后，下一次接续又对同一 commandId 新建 open 项。独立 Store 读回同时有已处置和新开记录。根因是分类对缺失时间的命令每次都收集，未排除已分类/处置身份；这不同于允许幂等重试的同一 unresolvedId。严格 finality 探针 1 个目标断言失败。它至少导致已明确决定的事项重新成为待办；不直接声称已发生重复工具执行。

**新增的是重新发现与执行责任的接缝，不是 unresolved 持久丢失。** 第二棒之前看到的通知可能仍在 trim/summary 产物中；上述回放未执行完整 successor Context 变换，不能直接宣称第三棒必然看不到待核对项。当前代码只为本次新建项构造通知，没有核实旧通知已进入模型，也没有依 open 集合重新强制注入。其是否符合 ADR-0047 的“再次接续/通知失败不得使其消失、自动首轮不得依赖主动查询”要求，需补齐跨代发现契约；仅有 API 可查询不等于自动恢复保证。

归档期间显式 reissue 是否应允许、解档后是否自动处理 held-pending、已投递通知缺少消费证明时由谁重触发，均应明确裁决。当前关闭与归档语义不同，不能把归档等同 closed 写入模型。尚未覆盖 >200 条已处置记录裁剪后的 API 重试结果、实际前端可见性、ACP 通知全链、多项并发和真实进程崩溃；模型中的 Resolve 也不替代人或模型核实外部现实。

### D7 深入确认与自动接续修复（2026-11-17）

`unresolved-discovery-replay.test.mjs` 串起真实 Claw integration、Bridge 方言适配、Agent reminder 写入、FileSessionStore 保存/独立加载、官方变换、HandoffSeedFeature 及后继模型请求。所有存储使用临时目录；Bridge 传输被捕获而非真实 Viewer/子进程，LLM 为记录请求的可控客户端，不访问网络。

修复前普通 trim 确定过滤 `source=thread` 的 system 通知；第二次换头无新歧义时不再通知，未结清项仍在独立读回的线程存储，却不在后继模型请求。summary 与 trim-summary 注入会遗漏该项的摘要结果，验证摘要忠实度不能替代发现保障；不声称测得真实摘要模型的遗漏概率。includeSystemMessages 的对照保留通知，证明观察点确实能看见。

修复位于框架 `core.ts::commitSessionSuccession`：通知在分类后按事务内 `openUnresolvedCommands(draft)` 构造，不依赖本次新建数量；返回的 `unresolved` 仍为本次新增项。Claw 通知文案区分当前退役会话与每项原始来源。框架回归修复前 35 通过、2 项目标失败；修复后补充混合新旧事项、已处置不再通知、手动免播及构造失败回滚。实际后继请求现在可发现旧项，即使历史 seed 不含旧通知。不改变通用 trim 的过滤策略，也不重放原任务。

重启补验执行真实 Viewer 通知入队和 dequeue，再以同目录、同 viewer id 重建 worker，确认 runtime 写 Session 前丢失时恢复队列为空；未结清记录仍在。另一路真实启动扫描确认没有 pending/running 时不会仅凭 open 项唤起。最初此 Viewer 夹具漏建已连接会话，提交被拒；补齐连接前提后回放成立，该失败是测试前置错误，不是新产品缺陷。两路均未做完整宿主强杀和启动，不能据此宣布所有重启后通知永久丢失；不得把 idle/failed/waiting_input 的人为暂停或等待状态改成强制运行。同代重启再发现未修，运行中重启，以及通知进入后继**首个**模型请求的严格排序仍需专项联测；当前回放执行实际投递顺序，断言后继收到请求而非首个请求必含清单。

复跑：

```bash
node --test specs/tla/unresolved-discovery-replay.test.mjs specs/tla/unresolved-lifecycle-replay.test.mjs
npm --prefix ../AgentDev/packages/core test -- test/workthread
node specs/tla/check-unresolved-lifecycle.mjs
```

本次最终相关 Claw 108 通过、0 失败，框架 WorkThread 164 通过、0 失败；core 构建、类型检查、相关 ESLint 与两仓库 diff 检查通过。TLC 9 场景匹配（含历史反例和当前携带/手动免播对照），不表示重启活性已证明。最终 Claw 日志 `.agentdev/temp/bg-output-20261117-174155-pr1505.log`；框架与 TLC 日志分别为 `bg-output-20261117-173504-v7b33c.log`、`bg-output-20261117-173453-skdy87.log`。以下结论记录初轮基线；当前 D7 的自动接续部分以上节为准。

## 结论与剩余范围

五个方向已各自形成有限模型、可重跑检查和实现证据；不是项目抽象完备性证明。当前最有依据的修复候选是保存前引用被当成消费证明、跨层取消范围不一致、手动换头后旧 Viewer 权力未可靠撤销，以及旧格式命令已处置却在下次接续重新开项。去重超窗属于已声明边界，跨变换重复执行仍是条件风险；open 待核对项跨代重新发现属于需要补齐的契约与验证。

模型对照是评估约束作用的实验，不是获批准的生产修复。下一轮应先裁决可靠消费证据、跨层取消截点、退役隔离和待核对发现责任，再用本目录严格探针验收实现。不应修改断言把既有违约解释为正确。

本轮新增五个模型共 28 个场景，均已实际运行且匹配声明（包括指定安全/活性反例，不表示生产性质全部通过）。最终全部观察回放和相关现有回归合计 57 通过、0 失败；严格探针另行保留目标断言失败。ESLint 最终 0 错误、0 警告，`git diff --check` 通过；未运行全量 npm test。

统一回放命令（含相关现有回归）见各节；全部实现变更均限于 `specs/tla/` 的模型、驱动、回放和说明，未改变生产行为、未提交或推送。原有模型及本次模型日志均在忽略目录 `artifacts/`，保留实际模型副本、配置、TLC 日志和提交版本供复核。
