# 多 Agent 派发表：Dispatch / Runtime / IM 底层改造

> 创建日期：2026-05-29
> 使用方式：把下面每一份文档单独派发给一个 agent 执行。建议严格按顺序推进，前一份完成并提交结果后，再开始下一份。

---

## 目标

本轮改造不是单点修 bug，而是把以下几件长期纠缠的问题拆开治理：

1. `dispatch` 持久化状态机与内存运行态不一致，导致 `__latest__`、重启恢复、循环触发、僵尸 schedule 等问题。
2. 同一个 runtime 目前可能被多个来源直接异步调用 `agent.onCall()`，包括：
   - 调试器 / 常驻输入框
   - `ClawDispatchFeature`
   - QQ / 微信门户输入
3. IM 回复逻辑和 `onCall()` 调用路径绑得太死，导致“不是从 IM 进来的调用，IM 看不到结果”。

本轮的总目标是把系统逐步收敛到以下结构：

- `DispatchSchedule` 只负责“什么时候向谁投递什么”
- `CallEnvelope` 代表“一次真实调用请求”
- `RuntimeInbox` 代表“某个 runtime 的唯一输入队列”
- `CallArbiter` 代表“某个 runtime 唯一允许触发 `agent.onCall()` 的入口”
- IM 侧不再依赖“谁发起 onCall 就谁负责回复”，而是订阅统一的 `callfinish`

---

## 执行顺序

### 第 1 份

文档：[2026-05-29-dispatch-recovery-hardening-guide.md](./2026-05-29-dispatch-recovery-hardening-guide.md)

目标：
- 修掉当前最危险的 dispatch 状态机问题
- 先把 schedule 僵尸、恢复失效、`__latest__` key 错位等问题止血

建议执行人：
- 擅长读 `server.js`、偏后端修复型 agent

### 第 2 份

文档：[2026-05-29-runtime-inbox-foundation-guide.md](./2026-05-29-runtime-inbox-foundation-guide.md)

目标：
- 引入统一 `CallEnvelope` / `RuntimeInbox` 数据模型
- 先搭地基，不强行一次替换所有入口

建议执行人：
- 擅长抽象数据结构、愿意做兼容层的 agent

### 第 3 份

文档：[2026-05-29-call-arbiter-migration-guide.md](./2026-05-29-call-arbiter-migration-guide.md)

目标：
- 把 runtime 的唯一 `onCall()` 入口收敛到 arbiter
- 迁移 dispatch / Viewer 输入链路，避免多来源直调 `onCall()`

建议执行人：
- 擅长 runtime 生命周期、agentdev 框架底层的 agent

### 第 4 份

文档：[2026-05-29-im-callfinish-unification-guide.md](./2026-05-29-im-callfinish-unification-guide.md)

目标：
- 让 QQ / 微信从“直接 onCall 回调回复”切到“订阅 callfinish”
- 让 IM 变成结果出口而不是调用入口副作用

建议执行人：
- 熟悉 `qqbot` / `weixinbot` 工作方式和门户代理语义的 agent

### 第 5 份

文档：[2026-05-29-integration-verification-guide.md](./2026-05-29-integration-verification-guide.md)

目标：
- 做集成验证、边界场景验证、回归核查
- 不负责大改结构，负责验收和补漏

建议执行人：
- 细心、适合做验证和补测试的 agent

---

## 对所有执行 agent 的统一要求

1. 不要擅自扩展需求。
2. 只围绕自己那份文档授权的范围修改文件。
3. 如果发现前置文档未完成导致自己被阻塞，只记录阻塞点，不要自行改写上游方案。
4. 每个 agent 结束时必须给出：
   - 修改文件清单
   - 已完成步骤
   - 未完成步骤
   - 风险点
   - 建议下一位 agent 注意什么
5. 若涉及状态机或持久化结构变更，必须补最少一组验证方式；能写自动测试就写自动测试，写不了就写明确的手工验证步骤。

---

## 推荐派发节奏

建议串行而不是完全并行：

1. 先执行第 1 份，确保调度系统不再明显积尸体。
2. 再执行第 2 份，建立新数据模型和兼容层。
3. 接着执行第 3 份，把 runtime 调用入口统一。
4. 然后执行第 4 份，改 IM 回显逻辑。
5. 最后执行第 5 份，统一验收。

如果你确实要并行，最多建议：

- 第 1 份单独先跑
- 第 2 和第 4 可以预研但不要提前合并
- 第 3 必须等第 2 完成
- 第 5 必须最后执行

---

## 总体验收口径

全部执行完后，系统至少要满足以下验收口径：

1. `dispatch` 不再因为 server 重启永久积累 `fired` / 过期 `pending` 僵尸 schedule。
2. `__latest__` 解析后，respond / activity / loop re-arm 使用的是同一个真实 runtime 标识。
3. 同一个 runtime 不再允许多个来源直接各自 `agent.onCall()`。
4. 调试器输入、常驻输入框、dispatch、IM 输入进入同一条运行时队列或受同一仲裁器约束。
5. QQ / 微信可以看到非 IM 来源触发的调用结果，前提是该 runtime 配置了相应结果投递策略。
6. UI 展示的运行态、队列态、完成态不再明显漂移。

