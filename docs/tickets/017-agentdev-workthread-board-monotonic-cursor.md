# 017 — WorkThreadBoard 单调游标修复

- **仓库**：AgentDev（`D:\code\AgentDev`）
- **决策依据**：[coder-acp-adapter-design.md](../coder-acp-adapter-design.md) §9.1；grill Q26-A；[ADR-0004](../adr/0004-acp-adapter-external-stdio-process.md)（拒绝 server 侧补偿层的理由）
- **类型**：框架缺陷修复（增量消费正确性）；ACP 批次的正确性前置
- **前置**：无（可与 018 并行）

## 背景

`src/core/workthread/board.ts` 中 `MAX_EXECUTION_EVENTS = 500`，裁剪旧事件后
`cursor = events.length`、`events.slice(after)` 均为数组局部语义。ACP adapter
（019）是第一个**长期增量消费者**（轮询 `GET events?after=cursor`），跨裁剪
丢事件且**不可检测**：

```text
已读 cursor=500 → board 裁 100 追 100 → 数组仍 500 条
slice(500) = [] → 消费者永远看不到事件 500~599，响应无任何信号
```

eventId 去重只能防重复、不能防丢失，无法替代本修复。

## 执行步骤

1. `board.ts` 增加 `baseOffset`：裁剪时累加被移除事件数。
2. `getExecutionEvents(after)` 返回**绝对游标**
   `baseOffset + events.length`；`after < baseOffset` 时 clamp 到 0
   （从头返回当前可用窗口，兼容旧调用方，不返回空数组静默丢读）。
3. `baseOffset` 持久化：随 board 状态记录落盘，或由 store 已累积事件总数推导
   （`max(0, storedTotal - MAX)`）——实施时二选一，必须覆盖「进程重启后
   cursor 不回退」场景。
4. 框架测试：推入 >600 事件，跨裁剪点多次增量读，断言不丢不重；重启恢复后
   游标连续。
5. Claw 消费面核查：`server/routes/thread-routes.js` 的 events 路由若为
   cursor 透传则零改动；如有数组局部假设一并修正。

## 验收标准

- AgentDev `npm run build` + 框架测试全绿。
- Claw 侧新增 `test/thread-events-cursor.test.js`：直接
  `import { WorkThreadBoard } from '@agentdev/core'` 实例化，验证 017 语义
  （跨裁剪增量读不丢不重）。
- 既有单轮 prompt 场景（事件 < 500）行为逐字节不变。

## 风险提示

- 持久化遗漏会使 baseOffset 重启归零，丢事件以「重启后偶发」形态复发——
  验收必须含重启用例。
- 合入后 Claw 需**整服重启**（框架 dist 变更语义），仅重启 agent 子进程不生效。
