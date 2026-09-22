# 集成验收报告：多 Agent 派发表改造

> 日期：2026-05-29
> 执行文档：第 5 份 — 集成验收与回归核查

---

## 一、验证结论概览

| 核查维度 | 结论 | 关键发现 |
|---------|------|---------|
| A. Dispatch 状态机收口 | **基本通过，有 1 个 bug 已修复** | `on-ready + repeat` re-arm 后 scheduleDispatchFire 不处理 on-ready 类型，导致僵尸 pending |
| B. Runtime 调用入口唯一 | **部分通过** | viewer-input 和 dispatch 走 arbiter；IM 来源仍直调 onCall() |
| C. IM 结果出口统一 | **通过** | callfinish 订阅机制正确；IM 来源跳过、非 IM 来源投递到 IM；无双发 |
| D. UI 状态一致性 | **大体通过** | RuntimeInbox/ExecutionState API 可用；前端仍使用独立 dispatch 状态 |

---

## 二、已验证场景列表

### A. Dispatch 状态机

| # | 场景 | 预期 | 代码验证结果 |
|---|------|------|-------------|
| A1 | `__latest__` 解析后 respond 使用真实 key | 优先 `resolvedTargetSessionId` / `resolvedRuntimeKey` | **通过** — server.js:5497-5498 正确使用解析后的值 |
| A2 | `fired` 不会永久悬挂 | 5 分钟看门狗超时标 failed | **通过** — server.js:493-506 看门狗 + 启动恢复 sweep |
| A3 | 过期 timer 不永久 pending | 恢复时立即 fire | **通过** — server.js:577-579 expired timer 立即触发 |
| A4 | `on-ready + repeat` 重启后续上 | re-arm 后 scheduleDispatchFire 设置定时器 | **已修复** — 原代码 on-ready 类型 re-arm 后不设置定时器，修复后将 trigger.type 切换为 timer |
| A5 | `on-idle` 不会因一次丢 respond 永久僵死 | 看门狗超时后标 failed | **通过** — 失败后 schedule 终止（合理行为） |
| A6 | 启动恢复 sweep 覆盖所有状态 | fired/pending timer/on-idle/on-ready 全处理 | **通过** — `restoreDispatchSchedulesOnBoot` 完整覆盖 |

### B. Runtime 调用入口唯一

| # | 场景 | 预期 | 代码验证结果 |
|---|------|------|-------------|
| B1 | viewer-input 经 arbiter | `callArbiter.enqueue({ source: 'viewer-input' })` | **通过** — run-prebuilt-agent.js:977 |
| B2 | dispatch 经 arbiter | `arbiterRef.enqueue()` + `waitForCompletion()` | **通过** — dispatch/index.ts:80-87 |
| B3 | IM 来源经 arbiter | 应通过 arbiter 串行化 | **未完成** — QQBotFeature/WeixinBot 内部仍直调 agent.onCall() |
| B4 | 同一 runtime 多来源串行 | 不会并发进入 onCall | **部分** — viewer+dispatch 串行；IM 与 arbiter 可并发 |
| B5 | `run-one-shot-agent.js` | 独立脚本，不影响主 runtime | **可接受** — 它是独立进程，不在预置 agent runtime 内 |

### C. IM 结果出口统一

| # | 场景 | 预期 | 代码验证结果 |
|---|------|------|-------------|
| C1 | IM 来源正常回复 | Feature 自身 gateway adapter 回复 | **通过** |
| C2 | 非 IM 来源结果同步到 IM | callfinish → sendIMMessage | **通过** — run-prebuilt-agent.js:410-451 |
| C3 | IM 来源不双发 | IM_SOURCES 跳过 callfinish | **通过** — line 416 检查 |
| C4 | 无 IM 渠道时安全跳过 | `!channel` 时 return | **通过** — line 424 |
| C5 | Weixin 非IM结果投递 | apiClient.sendTextMessage | **通过** — qqbot/agent.js:175-184 |
| C6 | QQ 非IM结果投递 | 当前仅 log，adapter 不支持主动发送 | **已知限制** — qqbot/agent.js:194-195 |

### D. UI 状态一致性

| # | 场景 | 预期 | 代码验证结果 |
|---|------|------|-------------|
| D1 | RuntimeInbox 快照 API | `GET /protoclaw/runtime/inbox` | **通过** — server.js:5545-5551 |
| D2 | ExecutionState API | `GET /protoclaw/runtime/execution_state` | **通过** — server.js:5553-5559 |
| D3 | 全局状态列表 | `GET /protoclaw/runtime/execution_states` | **通过** — server.js:5561-5563 |
| D4 | 前端消费 inbox 数据 | 调度台 UI 消费 dispatch schedule 状态 | **通过** — app-main.js dispatch 相关函数 |
| D5 | RuntimeInbox 与 dispatch queue 并行 | 两者独立但可交叉验证 | **观察** — 目前两套并行存在，未来应统一 |

---

## 三、通过项

1. **Dispatch 恢复逻辑完整**：`restoreDispatchSchedulesOnBoot` 覆盖 fired 超时、过期 timer、on-idle、on-ready 四种场景
2. **`__latest__` key 不再错位**：fire 阶段存储 `resolvedTargetSessionId` 和 `resolvedRuntimeKey`，respond 使用解析后的真实值
3. **`fired` 看门狗有效**：5 分钟超时，启动恢复也会检查并标记超时 fired 为 failed
4. **CallArbiter 串行性保证**：viewer-input 和 dispatch 两条路径经过 arbiter，`_active` 标志确保不并发
5. **callfinish 机制正确**：IM 来源跳过、非 IM 来源投递、截断保护、空结果跳过
6. **Weixin 侧完整实现**：sendIMMessage 通过 apiClient.sendTextMessage 投递，peer 信息通过 setLastIMTarget 捕获
7. **CallEnvelope/RuntimeInbox 数据模型完整**：工厂、入队、出队、快照、状态更新、查找辅助函数齐全

---

## 四、未通过项 / 已知限制

### BUG-1（已修复）：`on-ready + repeat` re-arm 失效

- **问题**：当 on-ready schedule 设置了 repeatInterval 时，respond 回来后 re-arm 调用 `scheduleDispatchFire(s)`，但该函数对 `on-ready` 类型不做任何处理（只对 timer 和 on-idle 生效）。Schedule 永远停留在 `pending`，无人触发。
- **修复**：re-arm 时检测 trigger.type 是否为事件驱动类型（on-ready/on-idle），若是则将 trigger.type 切换为 timer 并保留 originalType。
- **文件**：`server.js` line ~5501
- **验证方式**：创建 `on-ready + repeatInterval=60` 的 schedule，触发一次后观察是否在 60 秒后再次触发。

### LIMIT-1（未修复）：IM 来源调用仍绕过 arbiter

- **问题**：QQBotFeature 和 WeixinBot 的 gateway adapter 内部直接调用 `agent.onCall()`，不经过 CallArbiter。这意味着 IM 消息和 arbiter 管理的调用（viewer-input、dispatch）可能并发执行。
- **原因**：Feature 包源码在 AgentDev 仓库（`packages/qqbot-feature`、`packages/weixin-bot`），需要修改 Feature 包才能让 IM 消息也走 arbiter。
- **影响**：违反"同一 runtime 唯一入口"目标。如果 IM 消息和 dispatch/viewer 消息同时到达，可能出现并发 onCall。
- **建议**：作为下一轮改造目标，在 Feature 包的 gateway adapter 中注入 arbiter 调用路径。

### LIMIT-2（未修复）：QQ 渠道非 IM 结果投递受限

- **问题**：QQ adapter 不暴露主动发送 API，`sendIMMessage` 对 QQ 渠道只做 log。
- **影响**：从 dispatch/viewer 触发的调用结果无法通过 QQ 回传给用户。
- **建议**：需要 QQBotFeature adapter 升级支持主动发送。

### LIMIT-3（观察）：RuntimeInbox 与 dispatchQueue 并行存在

- **问题**：当前 `dispatchQueue`（server.js:72）和 `RuntimeInbox`（runtime-call-envelope.js:106）并行存在。dispatch fire 时同时写入两者。
- **影响**：不造成功能问题，但增加维护复杂度。
- **建议**：后续迭代中将 `dispatchQueue` 迁移到统一使用 RuntimeInbox。

---

## 五、剩余风险

1. **IM 并发风险**：IM gateway adapter 直调 `onCall()` 与 arbiter 管理的调用可能并发，在 IM 高频场景下可能出现状态竞争。当前风险较低，因为 IM 消息通常间隔较长。
2. **Server 重启后 RuntimeInbox 丢失**：RuntimeInbox 是纯内存数据结构（`new Map()`），不持久化。Server 重启后所有 inbox 状态丢失。这不影响 dispatch 恢复（dispatch 有独立的持久化），但意味着 API 消费者在重启瞬间看到空快照。
3. **Dispatch `__latest__` 解析依赖 session 列表排序**：如果 `listPrebuiltSessions` 排序不稳定，`__latest__` 可能指向非预期的 session。
4. **CallArbiter 无超时**：如果 `agent.onCall()` 永不返回，arbiter 将永远卡在 running 状态，后续所有入队请求排队等待。建议未来为 arbiter 增加单次调用超时。

---

## 六、验收测试资产

### 自动化测试

| 文件 | 测试数 | 覆盖范围 |
|------|--------|---------|
| `test/runtime-call-envelope.test.js` | 22 | CallEnvelope 工厂、RuntimeInbox 操作、状态更新、ExecutionState、查找辅助 |
| `test/call-arbiter.test.js` | 6 | 串行化保证、错误处理、事件监听、并发控制 |

**运行方式**：
```bash
node --test test/runtime-call-envelope.test.js test/call-arbiter.test.js
```

**结果**：28/28 通过

### 手工验证场景（建议执行）

1. **Dispatch 恢复**：
   - 创建 timer schedule（未来 1 分钟）
   - 创建 on-idle schedule
   - 重启 server
   - 确认 timer 正常触发、on-idle checker 恢复

2. **on-ready + repeat**：
   - 创建 on-ready + repeatInterval=30 的 schedule
   - 启动目标 runtime，观察第一次触发
   - 等待 30 秒，确认第二次触发
   - 观察日志中 `[CallArbiter]` 串行执行记录

3. **多来源串行**：
   - 在 arbiter 管理的 runtime 中同时提交 viewer-input 和 dispatch
   - 观察日志确认两条请求串行处理（`[CallArbiter] executing` 和 `finished` 交替出现）

4. **IM callfinish**（需 Weixin 配置）：
   - 从 Weixin 发一条消息，确认正常回复
   - 通过 dispatch 触发一条调用，确认 Weixin 能收到结果
   - 确认 Weixin 来源消息不会双发

---

## 七、修改文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `server.js` | **Bug fix** | 修复 `on-ready + repeat` re-arm 后 trigger 类型不匹配导致僵尸 pending 的问题 |
| `test/runtime-call-envelope.test.js` | **新增** | CallEnvelope/RuntimeInbox 单元测试（22 条） |
| `test/call-arbiter.test.js` | **新增** | CallArbiter 串行性测试（6 条） |

---

## 八、对底线问题的回答

> 1. 同一个 runtime 现在是否真的只有一个执行入口？

**部分是**。viewer-input 和 dispatch 经过 CallArbiter 串行化，保证不并发。但 IM 来源（QQBot/WeixinBot gateway adapter）仍直接调用 `agent.onCall()`，绕过 arbiter。要完全实现唯一入口，需要修改 AgentDev 仓库中的 Feature 包。

> 2. `dispatch` 重启后是否真的不会再明显积尸体？

**是**。`fired` 有 5 分钟看门狗，启动恢复 sweep 也会检查超时 fired 并标记为 failed。过期 timer 会立即触发。`on-ready + repeat` 的 re-arm bug 已修复。`on-idle` checker 会在恢复时重建。

> 3. IM 是否已经从输入副作用变成结果出口？

**是**。callfinish 订阅机制已实现：非 IM 来源的调用结果会通过 `sendIMMessage` 投递到活跃 IM 渠道。IM 来源自身回复保持不变，不会双发。QQ 渠道因 adapter 限制暂不支持主动发送。

> 4. 现有 UI / 状态展示是否还能被人信任？

**大体可以**。RuntimeInbox 和 ExecutionState API 已就位，dispatch schedule 状态有独立的持久化恢复。前端调度台 UI 正确消费 dispatch schedule 数据。但 RuntimeInbox 是内存态，重启后为空，需注意 API 消费者不应假设 inbox 数据跨重启存活。

---

## 九、建议

1. **可以进入下一轮更深层重构**，但需优先解决 IM → arbiter 路径的收敛。
2. RuntimeInbox 与 dispatchQueue 的统一是必要的简化步骤，建议在下一轮推进。
3. CallArbiter 需要增加单次调用超时，防止 onCall 永不返回导致死锁。
4. QQ adapter 的主动发送能力是产品侧的硬需求，建议协调推进。
