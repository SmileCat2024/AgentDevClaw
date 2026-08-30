# Ticket 08 — 前端增量轮询消费 + dev 计量

> 依赖：Ticket 07（需要 `?since`/`?tail` 参数与 `_messagesProbe` 探测字段）。
> 仓库：AgentDevClaw。涉及：`public/src/app-main.js`（poll 数据获取段）、
> `public/src/modules/overview-data.js`（probe 剥离）、`test/frontend-*.test.js`。

## 背景

ADR-0013（`docs/adr/0013-message-poll-probe-tail.md`）已定契约。本票把
poll 循环中 `/messages` 的"无条件全量拉"改为"探测 → 按分类取增量 → 拼回
全量 → 校验 → 走原提交路径"。**渲染状态机一行不动**：
`commitSessionViewPatch` + `findFirstChangedMessageIndex` + 三分支
（appendNewMessages / updateLastMessage / renderCurrentMainView）原样消费
拼好的完整数组。

## 任务

1. **probe 读取**（`overview-data.js`）：
   - `normalizeOverviewSnapshot` 忽略 `_messagesProbe`（现状已剥离未知字段，
     显式加注释说明"探测字段在读取处单独提取，不入视图快照"）
   - 新增导出 `extractMessagesProbe(snapshot)` → `{count, changeKind, sinceIndex,
     fakeFullBytes} | null`
2. **poll 数据获取改造**（`app-main.js` poll 函数内，仅替换 msgsRes 获取逻辑）：
   - 每周期先从 overview 响应提取 probe（overview 本来就在 `Promise.all` 里）
   - **探测不可用**（probe 缺省 / 首次加载 / 拼接基线缺失）→ 全量拉（现状路径）
   - `changeKind=null`（未变化）→ 跳过 `/messages` 请求，复用现有消息数组
   - `append` → `/messages?since=<本地已知count>`；校验
     `delta.length === probe.count - since`，通过则
     `[...prevKnown.slice(0, since), ...delta]` 拼回；失败降级全量
   - `tail` → `/messages?tail=1`；校验返回恰为 1 条且 `probe.count === prevKnown.length`，
     通过则 `[...prevKnown.slice(0, -1), last]`；失败降级全量
   - `rewrite` → 全量拉
   - **降级与基线重建**：任何校验失败或 probe.count < 本地已知 count
     （Worker 重启 / 修剪）→ 全量拉一次重建基线，下周期恢复探测
   - stale check 语义不变：探测与取数沿用现有 `captureSessionViewToken` /
     `isSessionViewTokenCurrent` 时序（探测数据来自本周期 overview 响应，
     与 msgsRes 同代）
3. **dev 计量**（默认关闭）：URL 带 `?msg_metrics=1`（或 localStorage 开关，
   取实现简单者）时，每次消息刷新 `console.debug('[msg-metrics]', {...})`：
   `{ actualBytes, fakeFullBytes, savedRatio, changeKind, downgraded }`。
   实际字节 = 本周期 /messages 响应体字节数（未发请求时为 0）。
4. **测试**（`test/frontend-msg-probe.test.js`，沿用 frontend-vm 沙箱模式）：
   - 四条路径：未变化零请求 / append 拼接正确 / tail 替换末条 / rewrite 全量
   - 降级：delta 长度不匹配、count 回退、probe 缺省 → 全量且基线重建
   - probe 不污染 overview signature（`getOverviewSignature` 对含/不含
     `_messagesProbe` 的快照返回一致）
   - 计量开关关闭时无 console 输出

## 验收命令

```bash
cd /home/dev/AgentDevClaw
npm run test:file -- test/frontend-msg-probe.test.js
npm run test:core        # 全量回归：既有 frontend-* 测试不得失败
npm run lint
```

## 边界

- 不动渲染三分支、不动 `session-view-state.js` 的提交机制、不动代理层
- 不改轮询间隔；远程 agent 路径自然生效（`messages`/`overview` 已在
  `REMOTE_READ_RESOURCES` 白名单，query 透传已验证），无需远程专项代码
- 禁止 reset / clean / 覆盖其他会话改动
