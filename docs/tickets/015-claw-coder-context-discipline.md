# 015 — coder 卸载 request_summary_compaction（已定案：B 卸载）

- **仓库**：AgentDevClaw
- **决策依据**：8e766c 会话审计——主动精简工具全程零调用（死代码）；
  guard 已强制启用（e0a3f2d）自动轮换恢复。2026-08-21 拍板：**B 卸载**
  （单一路径，轮换全权归 guard；放弃任务边界主动精简的选项）
- **类型**：微改动（挂载条件）
- **优先级**：可加急——不依赖 007，独立小票随时可派

## 背景

`run-prebuilt-agent.js:723` 给所有预制 agent 统一挂载
`ContextCompactionControlFeature`，向模型暴露 `request_summary_compaction`
工具。coder 的 system.md 没有任何引导（8e766c 会话 182k input 全程零调用），
对 coder 是死代码。coder 的上下文管理路径已收敛为单一机制：
ContextGuard（强制启用）→ thread-rotation 自动轮换。保留一个无引导、
无人调用的主动工具只会增加工具面噪音与心智负担。

**范围边界**：只卸载 coder（线程宿主）。编程小助手等非宿主的挂载
**保持现状**（人机交互场景，用户自控精简时机，不在本票范围）。

## 执行步骤

1. `run-prebuilt-agent.js:723` 统一挂载处增加条件：当前 runtime 的
   agentId 属于线程宿主（`THREAD_HOST_AGENT_IDS` 成员）时跳过挂载。
2. 判定来源用**唯一权威集合**（`server/thread-control/thread-integration.js`
   的 `THREAD_HOST_AGENT_IDS`），禁止复制集合造成双份真相。若直接 import
   引入不希望的模块级副作用（thread-controller 初始化链），则把集合定义
   上提到无副作用的轻量模块（如 `server/thread-control/host-agents.js`），
   thread-integration.js 与 run-prebuilt-agent.js 都从它 import。
3. 重启 coder runtime 验证。

## 验收标准

- coder runtime 的 hook inspector（或 tools 列表）中不再出现
  `request_summary_compaction`。
- 编程小助手 runtime 的工具列表中该工具仍在（范围外不受影响）。
- Claw 全量 `npm test` 全绿。

## 风险提示

- 极低。注意与 013/014 无耦合：015 在 Claw 仓库，可与 AgentDev 侧工作
  完全并行；但若 coder 的 thread 正在跑票，重启 runtime 前确认线程处于
  idle（避免打断执行中的 call）。
