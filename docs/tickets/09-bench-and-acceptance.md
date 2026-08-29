# Ticket 09 — 合成压测与端到端验收

> 依赖：Ticket 07 + 08（全部合入后执行）。
> 仓库：两者（脚本落 AgentDevClaw `scripts/experiments/`，报告落本票附录）。
> 这是 ADR-0012 验收清单的确定性部分。

## 任务

1. **合成压测脚本** `scripts/experiments/msg-metrics-bench.mjs`：
   - 构造大 transcript fixture（如 2000 条消息、~2MB，含长 assistant 流式块）
   - 注入本地 ViewerWorker（或直接以 ViewerWorker 测试态驱动），按序驱动：
     a) 流式输出期（连续 20 次 tail 变更）→ b) 追加期（连续 10 次 append）→
     c) 一次 rewrite（rollback 中段替换）
   - 每步记录：`{ actualBytes, fakeFullBytes, savedRatio, changeKind }`
2. **确定性断言**（脚本内置，退出码非零即失败）：
   - tail 期 actualBytes / fakeFullBytes < 5%
   - append 期 < 30%
   - rewrite 期 = 100%（全量，符合设计）
   - 三种 changeKind 各被触发 ≥1 次（对应前端三分支各自走到）
   - 全程无降级（`downgraded` 恒 false——分类正确性）
3. **真实抽查指引**（人工，写入票尾附录）：
   - 启动带 `?msg_metrics=1` 的前端，跑一个真实长编码会话 ≥30 分钟
   - 从 console 收集 `[msg-metrics]` 行，汇总 savedRatio 分布
   - 这份数据是将来评估 SSE 的决策输入（ADR-0012），归档到本票附录
4. **回归**：全量测试两仓库各跑一遍。

## 验收命令

```bash
cd /home/dev/AgentDevClaw
node scripts/experiments/msg-metrics-bench.mjs   # 退出码 0 + 汇总表
npm run test:core
cd /home/dev/AgentDev && npx vitest run
```

## 边界

- 脚本是实验工具，允许 console 输出（scripts/ 不受 no-console 约束）
- 不修改任何产品代码——发现问题回对应票修，本票只报告
- 禁止 reset / clean / 覆盖其他会话改动
