# 命令回执边界：TLA+ / TLC 试验

深化验证入口见 [回执与接续协议深化检查](DEEP-MODELS.md)：独立 Viewer 回执与接续投递窗口模型、13 个场景（含活性和模型变异）、真实 500 条历史边界回放。运行 `node specs/tla/check-deep-models.mjs`；原始基准模型与以下命令保持独立。

本试验检查“领取命令 → 写入内存 Context → 保存 Session 快照 → ack”与保存失败、取消、runtime 重启的交错。它是诊断工具，不是新的产品契约，也不代表整个命令系统已获证明。生产实现未因本试验改变。

## 基准与前置条件

首次验证基准（2026-11-16）：

- AgentDevClaw：`b5507f7ee73f58832fa42f10c909a0cccc096070`
- AgentDev：`47a8c5f7c014cac0ff87052cc181288d33ddf12d`
- Java 21；官方 TLA+ Tools 1.7.4（TLC 2.19）。

模型运行入口只依赖 Java 与 `tla2tools.jar`，不依赖 npm 安装。当前容器默认 jar 位于 `~/.local/share/tlaplus/1.7.4/tla2tools.jar`；其他机器通过 `TLA2TOOLS_JAR` 指定。脚本固定 seed/fingerprint、单 worker、1 GB 堆、60 秒上限；超时或解析错误算运行失败，不算模型通过。

实现回放消费相邻 AgentDev 的 core/viewer 构建产物。根依赖为本地链接时，先在相邻仓库执行：

```bash
npm install --ignore-scripts --no-audit --no-fund
npm --prefix packages/core run build
npm --prefix packages/viewer run build
```

不要用陈旧 dist 或无关 registry 版本解释首次结果。后续修改代码时须重新构建并复核反例，不把旧行为永久固化成正确性要求。

## 运行

在 Claw 根目录：

```bash
# 四份配置：两份完成有限状态探索，两份应给出指定反例。
node specs/tla/check-receipt-boundary.mjs

# 实现观察回放：确认当前实现是否仍能复现两条路径。
AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 node --test specs/tla/receipt-boundary-replay.test.mjs

# 严格契约检查：首次基准上应失败，不是环境错误。
REQUIRE_RECEIPT_DURABILITY=1 AGENTDEV_VIEWER_HTTP_BIND=127.0.0.1 \
  node --test --test-name-pattern='TLC durability trace' specs/tla/receipt-boundary-replay.test.mjs
```

模型日志、完整反例、实际模型副本和提交信息保存在 `specs/tla/artifacts/run-*/`，目录不入 Git。驱动器返回 0 只表示“预期通过与预期反例均成功重现”，**不表示生产可靠性检查全绿**。直接运行 `ReceiptBoundary-durability.cfg` 得到退出码 12；严格实现回放得到退出码 1。

回放使用真实 Agent、CallArbiter、Viewer 队列/claim/ack 和空闲邮箱模块；SessionStore 为可注入失败的内存记录器，模型客户端只捕获发送内容。Viewer 不调用 `start()`，不监听端口或 UDS；队列写入独立临时目录并在用例后清理。取消路径调用 Viewer 的实际取消原语，不声称覆盖 HTTP/UDS 中断传播。邮箱恢复后的 resume 使用收集器截住，专门观察 ack 发生时的持久化前提，不执行真实后续业务。

## 四份配置各自声明什么

| 配置 | 性质与首次结果 | 解释 |
|---|---|---|
| observations | 类型、命令去向不消失、消费与取消不重叠；258 个可达状态，完成 | 仅证明模型内这些有限安全性质 |
| durability | 增加 `AckRequiresSnapshot`；反例 | 保存失败后 Context 残留，被邮箱当成已保存事实而直接 ack |
| always-save | 取消 Context 直接 ack 捷径；254 个可达状态，完成 | 对照实验，只改变模型，不是已实施或获批准的生产修复 |
| cancel-policy | 关闭保存失败动作，检查取消残留不再送往模型；反例 | 保存成功 → 取消 → ack 拒绝 → 下一普通请求仍携残留；需裁决语义与隔离方式 |

`ReceiptBoundary.tla` 不包含任务正文，仅以命令 ID 集合代表有身份的消息。`CommandCount=2`，一条保存失败路径、一次进程恢复、一次后续普通调用；runtime/head 身份固定，不检查换代 fencing、旧回执、ack 响应丢失、去重历史裁剪、跨进程写锁、Viewer 文件损坏或断电持久性。允许 stuttering（状态不变），本次不检查最终完成等活性或死锁性质。模型保留“快照已完成 / 未完成”的区别，不建模磁盘字节写到一半。

## 动作与真实实现的映射

| 模型动作 | 实现依据 |
|---|---|
| Claim | `AgentDev/packages/viewer/src/viewer-worker.ts::claimCommandInput`；`scripts/runtime-passive-mailbox.js` 的 Context 回执捷径 |
| AppendContext / SaveSnapshot | `AgentDev/packages/core/src/core/agent.ts::executeCall`：追加带身份消息后保存，再 ack |
| SaveFails | Agent catch 保留 Context；CallArbiter 结束失败 envelope；宿主 `callFinished` 的补存也可能失败或尚未完成 |
| AckAccepted | Viewer `acknowledgeCommandInput`，成功原子移除队列并保存消费引用；Viewer 信任消费方已完成保存 |
| CancelQueued / AckRejected | Viewer `cancelDurableQueuedInputs` 与 ack 不匹配拒绝；回放直接驱动真实原语 |
| OrdinaryCall / RunModel | Agent 后续调用复用 `persistentContext`，真实模型请求序列化仍含残留用户文本 |
| Restart | 仅抽象为 Context 从最后成功快照恢复，不是实际子进程崩溃实验 |

要求来源：ADR-0047 §5、§6.1、§6.3。最新 fast-check 测试范围见 `docs/reference/thread-state-matrix.md` 的“性质测试：操作过程与恢复边界”；其中明确不覆盖 Viewer claim/ack 与 cancel 全链竞争。本试验补充该跨层接缝，不替代现有性质测试。

调查结论、争议与定向回归结果见 [试验报告](../../docs/investigations/2026-11-16-tla-receipt-boundary-experiment.md)。
