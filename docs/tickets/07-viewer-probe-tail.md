# Ticket 07 — ViewerWorker 增量取数能力（?since / ?tail / changeKind / probe）

> 依赖：无（本批工单的起点）。权威设计读 `docs/adr/0012-message-poll-probe-tail.md`。
> 仓库：AgentDev（框架）。涉及：`packages/viewer/src/viewer-worker.ts`、
> `packages/viewer/test/`。本票**只加能力，不改任何现有行为**——不带参数的
> `/messages` 响应必须逐字节不变。

## 背景

前端对选中 agent 的 `/messages` 轮询是全量重拉。本票让 ViewerWorker 具备
"变更分类 + 按需取增量 + 探测线索"三个能力，供前端（Ticket 08）消费。
现有相关设施：`hasMessagesChanged` / `getLastMessageSignature`
（viewer-worker.ts:1533-1570）、`enforceMemoryLimits`（:1203）、
`getMergedOverview`（:1522）、`handlePushMessages`（:1366）。

## 任务

1. **推送时刻计算 changeKind**（改 `handlePushMessages`，新旧数组都在手上时）：
   - `append`：新数组以旧数组为前缀（逐条引用相等或末条前旧数组全等），且变长
   - `tail`：条数相同，仅最后一条不同
   - `rewrite`：其余（含现有盲区：中段变化但 count 与末条签名不变——现状
     `hasMessagesChanged` 会丢弃这次推送，必须一并修正：分类为 rewrite 即更新
     `session.messages`）
   - 结果存 session：`{ changeKind, sinceIndex }`（sinceIndex = append 时旧数组长度）
   - 未变化时清空分类
2. **session 总字节缓存**：`enforceMemoryLimits` 已逐条 `JSON.stringify` 求
   字节——改为增量维护 `session._totalBytes`（修剪时减、追加时加），并在推送
   时记录 `fakeFullBytes = _totalBytes`（假想全量响应体字节）。
3. **`/messages` 取数参数**（`handleAPI` 的 messages 分支）：
   - `?since=<n>`：返回 `{ messages: session.messages.slice(n), baseCount: n }`；
     `n > length` 时返回空数组（客户端会走长度校验降级）
   - `?tail=1`：返回 `{ messages: [最后一条] }`
   - 均可与无参数共存：无参数行为完全不变（全量数组，响应形状不变）
4. **probe 字段挂 overview 响应**（`getMergedOverview` 的 HTTP 组装处，不进
   `AgentOverviewSnapshot` 类型、不进 session.overview 存储）：
   ```json
   { "...现有overview字段": {},
     "_messagesProbe": { "count": 123, "changeKind": "append|tail|rewrite|null",
                          "sinceIndex": 100, "fakeFullBytes": 45678 } }
   ```
   - `_totalBytes` 未初始化（旧路径未走过 push）时 probe 可缺省——前端按
     "探测不可用"处理（08 负责）
5. **测试**（`packages/viewer/test/`，沿用现有 viewer-worker 测试模式）：
   - changeKind 三分类各自命中 + 未变化为 null
   - rewrite 盲区修正：构造中段替换、count 与末条签名均不变的用例，断言
     `session.messages` 已更新
   - `?since`/`?tail` 切片正确；无参数响应与改造前逐字节一致（回归）
   - probe 字段出现在 overview 响应且类型正确

## 验收命令

```bash
cd /home/dev/AgentDev
npm run build            # 或定向构建 viewer 包
npx vitest run packages/viewer/test/
```

## 边界

- 不改 `hasMessagesChanged` 对外语义之外的东西；不动 DebugHub MCP 输出
- 不动代理层、不动前端——本票合入后线上行为零变化
- 禁止 reset / clean / 覆盖其他会话改动
