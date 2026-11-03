# ADR 0040: 编程小助手上下文守卫三态化与过界自动接续

日期：2026-11-03
状态：已接受

## 背景与问题

ADR-0032 决策 2 末条预留：「上下文阈值自动接续（coder 的 ContextRotationTriggerFeature 同构）与 adaptive 轮换策略为后续独立决策；本 ADR 期间上下文提醒沿用 context-guard 既有提示。」

此前编程小助手的上下文守卫（context-guard badge）只有两态（关闭 / 自动打断）：过界后依赖人工精简或人工批准继续。coder 已有完整的过界自动接续（过界 → 工具结果落地后打断 → 服务端 thread-rotation 执行线程接力），编程小助手作为线程宿主却用不上。本 ADR 关闭该预留：守卫升级为三态，第三档「自动接续」复用 coder 的接力链路。

## 决策

### 1. badge 三态：关闭 / 自动打断 / 自动接续

- **循环点击**：关闭 → 自动打断 → 自动接续 → 关闭；控制载荷从布尔 `armed` 换为 `{mode, strategy}`；
- **allowRotation 是装配能力声明**：编程小助手（线程宿主）装配传 `true`；agent-studio 不声明（会话非线程宿主，无接力事务可走）→ badge 两态循环、manifest 不含自动接续档与策略项、配置初值 `rotate` 被钳制为 `interrupt`；
- interrupt 态保险丝语义保持：触发不翻转手动选择；触发后拦截机器唤醒直到人工输入，人工输入即视为批准继续，本次越界期间不再拦截；用量回落阈值下方后再次越界重新触发。

### 2. rotate 态 = coder 同构的接力链路，coder/memo 零改动

过界 → 工具结果落地后打断本轮（与 interrupt 共用触发时机）→ 本轮完全结束（CallFinish）时上报 `/protoclaw/context_guard_event`（载荷携带会话级策略）→ 服务端 thread-rotation 执行线程接力（挡板 → 变换 → successor → head 接续推进）。coder 的 `ContextRotationTriggerFeature`（无控制面版本）与 memo 链路保持原样。

### 3. 策略判定链：会话级优先

thread-rotation 的策略解析变为：**事件载荷中的会话级策略（三枚举值之一）> APP 级判定链（resourcePolicy 用户覆盖 > metadata 作者默认）> 组合语义（未声明，memo 形态）**。非枚举载荷值视为未携带，回落 APP 级判定链。策略每次接力现读，改选择对下一次接力即时生效。

### 4. mode / strategy 会话级持久化与继承

`{mode, strategy}` 经 feature 快照持久化（`captureState` / `restoreState`）+ `declareContinuity` 接续转移（model-selection 同款机制）：同会话重启恢复、线程接力继承、分支继承（框架默认语义）；trip 事实、越界事件闩锁、拦截状态是一次性尽职数据，不迁移，successor 全新一轮。

### 5. 失败语义：人工输入节流，不自动重试

接力事务失败（变换 / 存储 / successor 就绪）时：线程落 `rotation_failed` 信号、挡板显式收敛回旧 head、过界 runtime 退役（coder 同语义——留着只会接收注定超限的投递）。下一次人工输入重启 runtime 后的**首次过界观测**会再次上报重试：重试节奏由人工输入节流，不存在无人值守的自动重试循环。失败后不可能「拦在旧 runtime 等人工输入」——接力尝试先停 runtime，旧 runtime 不再存活。

### 6. 提示收敛：接续过程提示只保留顶栏一个

- rotate 触发**零新增 toast**：接续过程由顶栏「上下文接力中…」既有线程提示承载；
- interrupt trip 的打断 toast 保留（trip 记录携带触发时的 `mode` 快照，rotate trip 不弹）；
- 会话控制面板最上方新增接续策略选择器（自适应 / 纯精简 / 纯摘要，与 coder 面板同标签），仅守卫可用且 allowRotation 的会话显示，写经 `context_guard_control {strategy}`，应答回填 badge 缓存；
- 全局系统 feature 配置（system-feature-config 内联副本）同步三态声明，旧布尔值（`enabled: true/false`）兼容读取。

## 影响

- ADR-0032 决策 2 末条预留正式关闭；该 ADR 其余决策不变。
- 手动接续入口（`/trim` `/summary` 与精简页）不受影响：策略选择器只驱动自动接续，不兼作手动接续参数。
- 远程旧版 runtime 的 `{armed}` 布尔状态回报由前端映射为两态基线（rotate 能力未知按无处理）。
- 涉及：`local-features/context-guard/src/index.ts`、`server/thread-control/thread-rotation.js`、`server/routes/session.js`（事件策略载荷）、`server/routes/agent-lifecycle.js`（控制载荷）、`public/src/modules/context-guard-toggle.js` / `runtime-status.js` / `session-controls-panel.js` / `chat-context-bar.js`、`prebuilt-agents/official/programming-helper/agent.js`、`prebuilt-agents/official/agent-studio/agent.js`、`server/routes/system-feature-config.js`。
