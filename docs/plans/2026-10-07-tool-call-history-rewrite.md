# 实施计划：工具调用历史改写（ADR-0023）

日期：2026-10-07
状态：已实施（PR-1～PR-5 于 2026-10-08 完成编码、自动化测试与双管线实机核验）
关联：[ADR-0023](../adr/0023-tool-call-history-rewrite.md)（状态：已接受）
范围：场景 1（参数自修正）与场景 2（A→B 改名）。场景 3（跨 feature sub-call）不在本计划。

改动主体在 AgentDev 框架仓库（`packages/core`、`packages/viewer`）；Claw 仓库仅前端标注渲染与文档同步。两个仓库各出各的 PR，按序合入。

## 0. 总原则

1. **声明制即总开关**：没有任何工具声明 `rewritable` 时，全链路零行为变化。回滚 = revert。
2. **每个 PR 独立可验收、可 revert**：前置修复、协议、UI 三类改动不混在一个 PR。
3. **永不原地修改已发射对象**：改写创建新 `ToolCall` 对象替换数组元素，不修改原对象属性——防污染事件流与已推送的 DebugHub 快照。
4. **事实先于改写**：无头 JSONL 事件流发射原始调用（发射点在写入时刻、改写之前），这是不可破坏的时序约束。

## 1. 现状基准（取证结论，2026-10-07 读码验证）

### 1.1 引用拓扑（改写机制的物理基础）

- `Context.addAssistantMessage`（`AgentDev/packages/core/src/core/context.ts`）push 消息时 `toolCalls: response.toolCalls` —— **数组引用共享**：context 历史、react-loop 手里的 `toolCalls` 变量、`getAll()` 浅拷贝产物，三者持有同一个数组。
- `cloneMessages`（`message.ts`）为 `{ ...m }` 浅拷贝——数组与元素引用继续共享；真正的值快照只发生在 `toJSON` 序列化与 IPC 传输时。
- 结论：在 context 内替换数组元素即可让下一次 `getAll()` / LLM 编译看到新值；已序列化发出的 DebugHub 推送不受影响。

### 1.2 写入链路（改写应用点）

`react-loop.ts` 统一注入循环（按原始顺序 `context.addToolMessage(call, result, callIndex)`）：

- `addToolMessage` 内部先 `emitToolResultEvents(call, result, turn)`（无头事件流，发射原始 call——时序天然满足原则 4），再序列化结果写入消息。
- `tool-executor.ts` 中 `ToolResultTransform` 链在返回 `execResult` 之后、react-loop 写入之前执行——**协议校验插在 ToolResultTransform 之后**，看到的是最终结果。

### 1.3 已知缺陷（前置修复项）

`Context.apply(middleware)` 只替换 `this.messages`，不同步 `enrichedMessages`、不重建 `indexes`、generation 会递增。`rewriteToolCall` 若沿用同样的单数组写法，`query()` / `getByTurn()` 立即与主历史分叉。

### 1.4 展示元数据通道（现成，直接复用）

`ToolExecResult.display?: unknown`（"前端展示数据，不注入 LLM，仅 tool 消息"）经 `addToolMessage → addSerializedToolMessage` 落到 tool 消息上。前端标注所需的原调用快照走此通道，零新增协议。

## 2. 协议终稿

```ts
// packages/core/src/core/types.ts —— Tool 定义新增
export interface Tool {
  // ...
  /** 声明本工具的执行体可在结果中声明 effectiveCall 改写自身调用（ADR-0023） */
  rewritable?: boolean;
}

// packages/core/src/core/context.ts —— ToolExecResult 扩展
export interface ToolExecResult {
  // ...
  /** 实际生效的调用。id 必须与原调用一致；name/arguments 为生效值（ADR-0023） */
  effectiveCall?: ToolCall;
}
```

框架侧新增（context.ts）：

```ts
/**
 * 按 id 定位 assistant 消息中的 toolCall 并替换为 effective（新对象）。
 * 同步 messages / enrichedMessages / tool-name 索引。返回是否命中。
 * 未命中 = id 不存在（本轮无 assistant 消息含该 id），调用方记日志放弃改写。
 */
rewriteToolCall(effective: ToolCall): boolean;
```

**校验链**（tool-executor.ts，ToolResultTransform 之后；任一失败 → error 日志 + 放弃改写，历史按原始调用写入，结果原样——行为退回现状，不中断本轮）：

1. `effectiveCall.id === call.id`（禁止改 id，保配对）
2. `tools.get(call.name)?.rewritable === true`（声明制，ADR-0023 决策 3）
3. `tools.get(effectiveCall.name)` 存在（目标在清单内，ADR-0023 决策 4）

**应用时序**（react-loop 统一注入循环，addToolMessage 之前）：

```
execResult.effectiveCall 存在且校验通过
  → context.rewriteToolCall(effectiveCall)          // assistant 历史：替换元素（新对象）
  → result.display = { ...display, rewrittenCall: { name: 原名, arguments: 原参数 } }
  → logger（namespace 'agent.tool', event 'tool.rewrite', 携带 original/effective 对照）
  → addToolMessage(原始 call, result)               // 事件流发射原始 call；display 随消息落库
```

快照：`toJSON` 序列化改写后历史（单轨，ADR-0023 决策 6），`stepSaveFn` 自然持久化，无额外工作。

## 3. PR 划分

### PR-1（AgentDev · core）：Context 修复 + rewriteToolCall API

- 修 `apply()`：middleware 结果同时应用到 messages 与 enrichedMessages（enriched 侧按消息对象对齐重建），`rebuildIndexes()`。
- 新增 `rewriteToolCall(effective)`，实现纪律：定位 → 新对象替换元素 → 索引重建。
- 测试（core 仓库测试体系）：
  - `apply()` 后 `getAllEnriched()` 与 `getAll()` 内容一致；
  - `rewriteToolCall` 命中：messages / enrichedMessages 同步替换、id 不变、`query()` 按新工具名可检索、旧名不再检索到该消息；
  - 未命中（id 不存在）返回 false，历史不变；
  - `toJSON()` 快照含改写后调用；`restore` 往返一致。

### PR-2（AgentDev · core）：协议类型 + 校验链 + 应用

- `Tool.rewritable` / `ToolExecResult.effectiveCall` 类型；
- tool-executor 校验链（含三条失败路径的日志与放弃行为）；
- react-loop 应用时序（rewrite → display 附加 → 日志 → addToolMessage）；
- 测试：
  - 未声明 rewritable / 目标不在注册表 / id 不匹配：三条失败路径均"error 日志 + 历史记原始调用 + 结果原样"；
  - 合法改写：assistant 历史 name/arguments 替换、id 不变、`display.rewrittenCall` 为原调用快照、tool result 配对完好；
  - 事件流：发射的 tool_call completed 事件携带原始 name/arguments（时序原则 4）；
  - 端到端：装一个最小 rewritable 测试工具，跑完整 ReAct 循环，断言第二次 LLM 请求的 messages 中 assistant 调用已是生效值（用假 LLM 捕获请求）。

### PR-3（AgentDev · viewer）：DebugHub 标注渲染

- `viewer-html.ts` 工具卡片：检测 `display.rewrittenCall` → 显示"已修改"标注，展开可见原始调用（name + arguments）。
- 卡片主体显示生效调用（与结果配对，ADR-0023 决策 5）——消息流里 toolCalls 本就是改写后的，无需改动，仅加标注。
- 测试：viewer 仓库现有渲染测试模式，构造带 `display.rewrittenCall` 的消息断言标注与展开内容。

### PR-4（AgentDevClaw · 前端）：Claw 管线同规则

- `public/src/modules/` 工具卡片渲染（`app-ui.js` block 分发相关模块）：同 PR-3 规则——主体生效调用 + "已修改"标注 + 展开原始。
- i18n：`已修改` / `Modified`（文案为用户定案，不得改写）。
- 注意两条管线各自实现（历史坑：inspector 归一化曾因双处不同步丢字段）——PR-3 与 PR-4 验收清单互相引用，防止只改一条。
- 验证：手动跑 `npm start`，用测试 rewritable 工具触发改写，确认 1420 端口界面与 2026 端口 DebugHub 均可见标注。

### PR-5（AgentDevClaw · 文档同步）

- `AGENT.md` ADR 索引追加 0023；
- `docs/README.md` 文档地图（如有 ADR 清单段落）；
- ADR-0023 状态链接到本计划；
- 不涉及 glossary 新词（"改写/生效调用"为普通词义）。

## 3.1 验收状态（2026-10-08）

| PR | 状态 | 证据 |
|---|---|---|
| PR-1 apply() 修复 | 完成 | core 测试 |
| PR-2 协议与校验 | 完成 | `tool-call-rewrite.test.ts` / `context-rewrite.test.ts`（15 用例） |
| PR-3 viewer 标注 | 完成 | `packages/viewer/test/viewer-html-tool-rewrite.test.ts`（8 用例） |
| PR-4 Claw 标注 | 完成 | `test/frontend-tool-rewrite-badge.test.js`（7 用例） |
| PR-5 文档同步 | 完成 | AGENT.md ADR 索引、`docs/README.md` plans 段落、ADR-0023 关联 |

双管线实机核验：`npm start` 起服务后，1420 端口 `chat-renderer.js` 已携带 `.tool-result-name` 与 `renderToolCallCardHtml`（改写徽章挂载点）；2026 端口 DebugHub 页面已包含 `tool-rewrite-badge` 与 `tool-rewrite-detail` 样式与渲染函数。真实改写路径（工具执行体经 `withRewrite` 声明生效调用）在框架层由 PR-2 用例覆盖；界面标注的 DOM 契约由两管线各自的用例锁定（真实会话样本中尚无触发改写的记录，未做真人操作级复现）。

## 4. 明确不做（对齐 ADR-0023 不做清单）

语义分级与校验、强制说明字段、别名退役机制、快照双轨、thinking 剥离、跨工具改写——均不实现。工具作者文档面（如何使用 rewritable / effectiveCall）：在框架仓库 `docs/` 或 feature 开发指南侧补一段使用说明，属 PR-2 附带交付。

## 5. 风险与回滚

- **全链路开关**：无工具声明 `rewritable` 则零行为变化；线上问题可临时摘除某工具的声明（无需改框架）。
- **回滚**：各 PR 独立 revert；PR-1 的 `apply()` 修复即使改写能力回滚也应保留（它修复的是既有缺陷）。
- **缓存影响**：改写集中在最近一条 assistant 消息（写入后、下一次 LLM 请求前），prompt cache 前缀失效范围即该消息之后，影响最小化由时序自然保证。
- **审计兜底**：`tool.rewrite` 日志事件与无头事件流双通道记录原始调用；日志分级配置需保证 error 级（校验失败路径）可达。
