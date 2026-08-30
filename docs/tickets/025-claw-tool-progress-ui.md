# 025 — 执行中可见性：tool.progress 推送 + 工具卡片进度呈现

- **仓库**：AgentDev（shell-feature render 模板 + 进度发射）→ AgentDevClaw（前端轮询与呈现）
- **决策依据**：ADR-0005；gr 会话 Q5（notification 复用）、Q6（call 态卡片）、
  Q8（配置面板）、Q10（主 poll 1s + 本地走秒）。
- **类型**：纯增量呈现（Layer 2，零行为语义变更）
- **优先级**：023/024 验证稳定后执行

## 背景

执行中界面零反馈：用户不知道命令在跑、跑了多久、什么时候会自己停（痛点 1 的"不安全感"）。
通道事实：notification 系统已有 100ms 节流 + DebugHub + `/api/agents/:id/notification`
端点（当前仅 switchAgent 预热拉一次，不在主 poll）；前端工具卡片已有 call/result 双态
渲染模板（`bash.render.ts`，powershell 复用）；主 poll 间隔 1000ms。

## 执行步骤（AgentDev 侧）

1. **进度发射**（024 抽出的共享核心 collect 循环）：执行中周期
   `emitNotification(createToolProgress({ callId, toolName, startedAt, elapsedMs,
   timeoutMs, outputTail }))`，发射节流 ~300ms（notification 层 100ms 节流兜底）；
   `outputTail` 取尾部 5 行；`callId` 用 `toolContext.callId`（023 注入）。
   timeoutMs 为本次实际生效值（含 args 覆盖后的 clamp 结果），executor 经
   toolContext 暴露生效值。

2. **render 模板 call 态扩展**（`bash.render.ts`）：`> command` 下追加
   `(已运行 12s · 超时 2m)` + 尾部输出预览块（等宽小字、限 5 行高、overflow ellipsis、
   直接可见不折叠）；结果落地后 call 态消失、走 result 态（完成态不保留 tail）。
   数据经 render 上下文传入（前端 progress 状态 → 模板入参，接线方式实施时按
   InlineRenderTemplate 现有数据流定）。

## 执行步骤（AgentDevClaw 侧）

3. **主 poll 纳入 notification**：`poll()` 的并行 fetch 组加入
   `/api/agents/:id/notification`（与 messages/overview 等同批，1s 粒度）。

4. **progress 状态管理**：normalize `tool.progress`（含 stale check 纪律：只用同步设置的
   `currentRuntimeAgentId`，禁止 `getRuntimeContextKey`）；`startedAt` 本地走秒插值
   （两次 poll 之间 elapsed 平滑增长）；以 `callId` 与执行中工具卡片配对，结果落地即清除。

5. **feature-setup 验证**：`defaultTimeoutMs` / `maxTimeoutMs`（024 manifest 声明）
   在 Runtime 配置面板自动出现，可改且生效（执行中显示的 timeoutMs 随之变化）。

## 验收标准

- 跑一条 3 分钟长命令：卡片实时显示递增秒数、超时上限、尾部 5 行滚动输出；
  超时/打断后 call 态消失，结果含部分输出与 `<shell_metadata>`。
- 关闭进度场景（无工具执行中）：poll 无额外渲染抖动；notification 拉取失败不影响
  其他 poll 分支。
- 修改面板 timeout 配置后，下一次执行中显示的生效值同步变化。

## 风险提示

- AgentDev 侧 render 模板与发射逻辑改动触 shell-feature dist；Claw 侧前端 JS 触静态
  文件——两者都需整服重启，建议同批合入一次重启验证。
- DebugHub notification 若为单条快照语义会漏中间帧——tail 显示只关心最新，无影响；
  elapsed 靠 `startedAt` 插值不受漏帧影响。
- 子代理 / dispatch 派生调用的进度不可见（各自独立 notification scope，前端只 poll
  当前查看的 agent）：现状亦不可见，无回归；审计由 023 的 `interrupted` 字段覆盖。
