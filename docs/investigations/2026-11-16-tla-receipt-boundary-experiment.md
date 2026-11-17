# TLA+ / TLC 回执边界试验报告

- 日期：2026-11-16（首次验证），2026-11-17 复核
- 性质：方法试验 + 边界调查。生产实现未因本试验改动。
- 基准：AgentDevClaw `b5507f7e`、AgentDev `47a8c5f7`（均为当日快进更新后的最新代码）；TLA+ Tools 1.7.4（TLC 2.19），Java 21。
- 复现材料：`specs/tla/`（模型、四份配置、驱动脚本、实现回放）；运行说明与结果见其 [README](../../specs/tla/README.md)。

## 试验目标

验证 TLA+ / TLC 能否对 Claw 的跨进程协作协议给出 fast-check 之外的增量发现。选定的切片：线程命令从 Viewer 持久队列领取、进入 Agent 内存 Context、保存 Session 快照、ack 确认，与保存失败、取消、runtime 恢复的交错。该切片跨越 Viewer 队列文件与 Session 快照两个持久化域，且文档已声明 fast-check 性质测试不覆盖 Viewer claim/ack 与 cancel 的全链竞争（见 `docs/reference/thread-state-matrix.md`）。

## 方法

两层证据，互相约束：

1. **模型检查**：`ReceiptBoundary.tla` 把上述流程抽象为状态机（不建模消息正文与真实 IO），TLC 枚举全部可达交错。四份配置分别声明不同性质（见 specs/tla/README.md 的表格），其中两份预期通过、两份预期给出指定反例——驱动脚本据此判定"反例是否成功重现"，避免把工具失败当成通过。
2. **实现回放**：`receipt-boundary-replay.test.mjs` 用真实 Agent、CallArbiter、ViewerWorker（不监听端口/UDS、数据落独立临时目录）在确定性时序下重演反例路径，确认模型反例在当前实现上真实可达，而非建模偏见的产物。

## 发现 1：ack 可以在没有成功快照的情况下发生（明确契约违约）

ADR-0047 §6.1 要求 ack 意味着"会话快照已持久包含该输入"。TLC 反例与实现回放给出同一路径：

1. 命令从 Viewer 持久队列领取，追加进 Agent 内存 Context；
2. 快照保存失败（回放注入存储故障；生产中磁盘满、权限、瞬态 IO 错误均属此类）；CallArbiter 记 failed envelope，宿主 `callFinished` 的补偿保存同样未落盘；
3. 下一轮空闲邮箱轮询（`scripts/runtime-passive-mailbox.js`）检查内存 Context 发现回执已存在，判定"已持久化过"，走捷径直接 ack——判断依据是内存而非任何持久事实；
4. Viewer 收到 ack，原子地从持久队列文件删除该命令并记入 consumedSourceRefs（回放已核对磁盘文件）；
5. 结果：Viewer 侧命令已消费、不可重投，但两处持久化域都没有包含该输入的成功快照。若此后进程崩溃，Context 仅能从最后一次成功快照恢复，该命令静默丢失。

证据：TLC `AckRequiresSnapshot` 反例（86 状态内即达）；实现回放 `prematureAck=true, durableSnapshots=0` 且磁盘队列文件 items 为空。严格模式（`REQUIRE_RECEIPT_DURABILITY=1`）下该回放测试失败，可直接用作修复后的回归验证。

判断：这是对已记录契约的违约，不是设计争议。ADR 文字明确，链路两端的实现（邮箱捷径的"已持久化"判定、Viewer 对 ack 的信任）各自局部合理，组合出窗口。修复方向建议（未实施）：邮箱的 Context 回执捷径不能作为"已持久保存"的证据，需要以持久保存的成功事实（或等价的显式标记）为界。未直接修的原因：链路横跨 Claw 宿主脚本与 AgentDev core，当前另一环境正在并发开发同层测试，改动宜先与本报告一起裁决归属。

## 发现 2：取消后的残留载荷会进入后续无关调用的模型输入（待裁决语义）

TLC 与回放显示的路径：命令已领取并成功保存快照 → 用户取消（Viewer `cancelDurableQueuedInputs` 生效）→ ack 被正确拒绝（409）→ 该次调用不执行。但载荷已留在内存 Context 中；用户下一次发送完全无关的请求时，真实发送给模型的输入序列仍包含这条已取消命令的用户文本。

两端各自的行为都有依据：取消原语的职责是"停止执行 + 拒绝消费确认"；Context 的职责是保留对话历史。组合语义——**取消是否要求从后续上下文隔离载荷，还是仅要求停止当次执行**——ADR-0047 未覆盖。这可能是有意的（保留历史供人阅读）也可能是缺口（模型会响应一条用户已撤销的指令）。属于产品语义裁决，本试验不改行为，仅以 `cancel-policy` 配置与回放记录该窗口。

## 发现 3（与本试验无关的既有失败）

更新到最新代码后，`test/thread-succession-timing.test.js` 的 G3 并发风暴用例稳定失败（3/3 复现，非偶发）：并发换头的败者返回 `handoff_failed`，而测试期望 void 家族原因（`head_mismatch` / `no_thread_for_session` / `duplicate_session`）。日志显示败者通过了 `findThreadByHeadSession`（旧 head 仍可寻址），但 `beginSessionHandoff` 时胜者已提交、挡板已消耗，抛 `no active session handoff`，落入 `handoff_failed` 分支——该分支还会写 rotation_failed 并收敛挡板，与"线程状态已是权威、幂等作废"的注释意图相悖。失败在当日更新后的最新代码上稳定复现；是否由本次更新引入未验证（未在更新前代码上回跑）。本试验未修复它，需要与并发开发方核对是已知进行中事项还是回归。

## 模型边界（结果不能外推的范围）

- `CommandCount=2`、单线程单 runtime、head 代际固定：不覆盖换代 fencing、旧代际迟到回执、ack 响应丢失、去重历史裁剪。
- 不建模跨进程写锁、Viewer 文件损坏、断电持久性（`tmp + rename` 原子性按假设接受）。
- stuttering 允许，不检查活性与死锁。
- 模型通过的部分（observations、always-save 配置）只证明模型内的有限安全性质，不是生产可靠性声明。

## 重跑

```bash
node specs/tla/check-receipt-boundary.mjs                                  # 四份配置，需 Java + tla2tools.jar
AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/receipt-boundary-replay.test.mjs   # 基线观察（应全过）
REQUIRE_RECEIPT_DURABILITY=1 AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 \
  node --test --test-name-pattern='TLC durability trace' specs/tla/receipt-boundary-replay.test.mjs  # 契约检查（当前应失败）
```

当日复核结果：四份配置全部按预期（258/254 状态完整探索、两个反例重现）；回放基线 2/2 通过；严格模式失败信息与发现 1 一致。
