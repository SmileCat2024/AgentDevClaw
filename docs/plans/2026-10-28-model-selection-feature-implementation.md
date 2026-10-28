# 模型选择 Feature 化：文件级实施方案

- 日期：2026-10-28
- 状态：已闭环，待实施
- 决策权威：[ADR-0034](../adr/0034-feature-owned-model-selection.md)（本文不重复论证，只落实施细节；两者冲突时以 ADR 为准并回改本文）

本文目标是：实施期间不再需要阅读新代码段落即可动手。每个改动点给出文件、落点与行为；所有事实均已在当前代码中核实。

## 0. 总览

三层改造，按依赖顺序：

1. **AgentDev 框架**（`D:\code\AgentDev`）：初始化模型控制面、恢复来源贯通、延迟模型绑定、`onHostRequest` 契约化。
2. **Claw 本地 Feature**：新建 `local-features/model-selection`，持有选择意图与恢复策略，经 feature-comms 通道对外。
3. **Claw 宿主 / server / 前端**：三阶段启动、分支注入、请求面投递闸、swap 链路退役、输入框改造。

跨仓库生效路径：AgentDev `npm run build` → Claw 重启（开发态 junction 直接生效）。

---

## 1. 框架侧改造（AgentDev 仓库）

### 1.1 `packages/core/src/core/feature.ts`

**新增类型**（与 `agent.ts` 现有 hook ctx facade 的模型族同构，见 agent.ts L2501-2508；不含 `setLLM`——Feature 不直接注入客户端实例）：

```ts
export interface FeatureModelControl {
  setModel(presetName: string, opts?: { thinkingEffort?: string | null; source?: string }): boolean;
  setThinkingEffort(effort: string | null, opts?: { source?: string }): boolean;
  getLLMMeta(): LLMMeta;
  hasModelResolver(): boolean;
}

/** restoreState 的恢复来源（ADR-0034 决策 4） */
export type RestoreOrigin =
  | { kind: 'session-revive' }                                  // loadSession 快照恢复
  | { kind: 'continuity-import'; sourceSessionId?: string }     // 接续 / trim / summary 导入
  | { kind: 'branch-import'; sourceSessionId: string }          // 分支继承（源当前值）
  | { kind: 'rollback' }                                        // call / step / named checkpoint 回滚
  | { kind: 'hot-reload' };                                     // reloadFeature 状态迁移

export interface RestoreContext { origin: RestoreOrigin }
```

**接口变更**：

- `FeatureInitContext` 增加字段 `modelControl: FeatureModelControl`。
- `AgentFeature.restoreState` 签名放宽：`restoreState?(snapshot: FeatureStateSnapshot, ctx?: RestoreContext)`。旧 Feature 不消费第二参，行为不变。
- `AgentFeature` 增加可选方法（把宿主 duck-typing 沉淀为契约，见 §3.4）：
  ```ts
  onHostRequest?(requestType: string, payload: unknown, ctx: { channelId: string; sessionId?: string }): Promise<unknown>;
  ```

### 1.2 `packages/core/src/core/agent.ts`

**initContext 注入**：`ensureFeatureTools` / `initSingleFeature` 构造 `FeatureInitContext` 处（现状只有 agentId/config/logger/featureConfig/getFeature/registerTool/dataSourceRegistry，见 feature.ts L34-49）增加：

```ts
modelControl: {
  setModel: (p, o) => this.setModel(p, o),
  setThinkingEffort: (e, o) => this.setThinkingEffort(e, o),
  getLLMMeta: () => this.getLLMMeta(),
  hasModelResolver: () => this.hasModelResolver(),
}
```

已核实时序：`restoreSessionSnapshot` 先 `ensureFeatureTools()`（L909，各 Feature `onInitiate` 在此发生）再 `restoreRuntimeSnapshot`（L911）——**恢复时 Feature 已持有控制面**。反向顺序（热重载：restoreState 先于 mountFeature/onInitiate）由 Feature 侧幂等模式覆盖（§2.3）。

**restoreState 来源贯通**（五个调用点全部传 origin）：

| 入口 | 现状代码位置 | origin |
|---|---|---|
| `restoreSessionSnapshot` | L908 → `restoreRuntimeSnapshot(normalized.runtime)` | `session-revive` |
| `rollbackToCall` v2 分支 | L1167 `restoreRuntimeStateWithoutContext` | `rollback` |
| `rollbackToCall` v1 分支 / `rollbackToNamedCheckpoint` | L1170 / L1271 `restoreRuntimeSnapshot` | `rollback` |
| `reloadFeature` 状态迁移 | L2306 `newFeature.restoreState(capturedState)` | `hot-reload` |
| `rollbackToStepCheckpoint`（checkpoint.ts L62） | `restoreFeatureSnapshots(...)` | `rollback` |

实现：`restoreRuntimeSnapshot` / `restoreRuntimeStateWithoutContext` / `restoreFeatureSnapshots` 私有链路加可选 `origin` 参数透传；`restoreFeatureSnapshots`（checkpoint.ts）同样加参。continuity-import / branch-import 的 origin 由 Claw 宿主导入时显式传入（§4.3）。

**延迟模型绑定**（ADR 决策 5）：

- `AgentConfig.llm` 允许省略。构造函数 `this.llm = config.llm`（L207）后允许 `undefined`；`getLLMMeta()` 在未绑定时返回 `{ modelRevision: 0 }` 级别的空 meta（`modelName` 为 undefined），不抛错。
- 已核实 `ReActLoopRunner` 仅在发起请求时读 `this.agent.llm.chat`（react-loop.ts L118/L145），构造期不校验——llm 缺省构造不崩。
- `executeCall` 入口（L415 `ensureFeatureTools` 之后）加显式检查：`this.llm == null` 时抛 `Error('model not bound: …')`（提示装配层在 READY 前完成绑定或恢复回退）。语义：未绑定的 Agent 可构造、可恢复状态、不可执行。
- 现有 setLLM/setModel 不变；绑定即 `setLLM`。

### 1.3 `packages/core/src/index.ts`

导出 `FeatureModelControl`、`RestoreOrigin`、`RestoreContext`。

### 1.4 框架测试（AgentDev `packages/core/test/`）

- restoreState 收到正确 origin（五入口各一断言；用 spy feature）。
- 旧签名 Feature（不接第二参）在五入口下行为不变。
- llm 缺省构造 + 恢复后 setModel 绑定 + executeCall 正常；未绑定 executeCall 抛错。
- `FeatureInitContext.modelControl` 转发行为与直调一致。

---

## 2. 模型选择 Feature（`local-features/model-selection`）

### 2.1 状态 schema（captureState 返回值）

```ts
{
  schemaVersion: 1,
  // 用户明确的模型覆盖；null = 无覆盖（遵循启动配置）
  presetName: string | null,
  // 思考强度覆盖：键缺席 = 未覆盖（跟随 preset 配置档）；string = 显式值。
  // 不使用 null 态——"厂商默认"经编辑 preset 配置表达，不进入会话覆盖状态
  //（取舍依据见 §7）
  thinkingEffort?: string,
  // 恢复失败事实（呈现用；不影响再次尝试）
  lastRestoreFailure?: { reason: string; at: number },
  __agentdev_continuity__: { protocol: 'claw.model-selection.v1', importMode: 'replace' },
}
```

continuity 声明用 `declareContinuity(ModelSelectionFeature, { protocol: 'claw.model-selection.v1', importMode: 'replace' })` 包装（复用框架 `continuity/participant.ts`）。协议在 `server/context-continuity/feature-continuity.js` 的 `PROTOCOL_ADAPTERS` 不登记（通用透传）。

不保存：凭证、LLM 客户端、整份 preset、用量数据。

### 2.2 行为矩阵（按 RestoreOrigin）

| origin | 行为 |
|---|---|
| `session-revive` | 应用快照选择（见 §2.3 应用流程）；`presetName: null` 时无操作 |
| `continuity-import` | 同上（源为接续前最新选择） |
| `branch-import` | 同上（源为分支创建时刻源会话当前选择；边界快照值先被 loadSession 恢复，此处覆盖） |
| `rollback` | **忽略快照中的 presetName / thinkingEffort**，保留当前值；其余字段（lastRestoreFailure）正常恢复 |
| `hot-reload` | 全量恢复（含选择），应用流程同 session-revive |

### 2.3 应用流程（幂等，两钩子都可触发）

```
restoreState(snapshot, ctx) / onInitiate(ctx) 都调用 applyPendingChoice():
  if (未持有 modelControl) { 存为 pendingChoice; return; }   // 热重载顺序：restore 先到
  choice = ctx?.origin 为 rollback ? 当前内存值 : 快照值
  if (choice.presetName == null && 无 thinkingEffort 键) { 已是启动配置；清 pendingChoice; publish; return; }
  ok = modelControl.setModel(choice.presetName ?? modelControl.getLLMMeta().presetName,
        { ...(choice 有 thinkingEffort 键 ? { thinkingEffort: choice.thinkingEffort } : {}) ,
          source: 'model-selection:restore' })
  if (ok) { 清 pendingChoice 与 lastRestoreFailure }
  else {
    // 恢复失败（ADR 决策 3）：回退全局默认，保留原选择
    fallbackOk = modelControl.setModel('__default__', { source: 'model-selection:fallback' })
    lastRestoreFailure = { reason: 'preset_unavailable', at: Date.now() }
    if (!fallbackOk) throw（宿主据此不 READY，§4.2）
  }
  publish 状态快照到通道
```

- `onInitiate` 里调用时机：拿到 `ctx.modelControl` 后立即 `this.modelControl = ctx.modelControl; applyPendingChoice()`。**不等待首轮对话**。
- `onLLMSwap` 钩子：不区分来源地 publish 通道快照（呈现以 Agent 实际模型为准，Feature 不自算"当前模型"）。
- 手动切换（onHostRequest，§2.4）成功后更新内存 choice 并 publish；失败不改 choice、返回业务错误。
- 当前实例不后台自动切回；下次实例恢复时再次尝试（快照仍带原选择）。

### 2.4 通道与请求面

- 声明：`featureId: 'model-selection'`，`channelId: 'selection'`；`onInitiate` 末尾经 `FeatureCommunicationClient.declareChannel` 声明（serverOrigin / agentId / sessionId 由宿主构造注入，同 annotations 模式）。
- 快照（publishSnapshot）：`{ choice, lastRestoreFailure, ready: true }`。
- `onHostRequest(requestType, payload, ctx)`：

| requestType | payload | 返回 |
|---|---|---|
| `getStatus` | – | `{ ok: true, choice, lastRestoreFailure }` |
| `selectModel` | `{ presetName: string, thinkingEffort?: string }`（键缺席=不动档位） | `{ ok: true, meta: getLLMMeta() }`；resolve 失败 `{ ok: false, code: 'preset_resolve_failed' }`（choice 不变） |
| `clearThinkingOverride` | – | 同上（删除覆盖） |

- `selectModel` 内部：`setModel(presetName, { ...(payload 有 thinkingEffort 键 ? { thinkingEffort: payload.thinkingEffort } : {}), source: 'user' })`。`thinkingEffort` 载荷不使用 null（§7 契约）。
- 请求成功（`ok !== false`）后宿主已有 `scheduleCommsSave()` 去抖补存（run-prebuilt-agent.js L515）——"已应用"回执 ≠ "已持久化"；写盘失败仅 warn（现状语义），通道快照不宣称落盘。

### 2.5 工程接入

- 新建 `local-features/model-selection/src/index.ts` + `test/model-selection.test.ts`（假 modelControl 断言行为矩阵与应用流程）。
- 注册 `local-features/index.ts` barrel 与 `local-features/tsconfig.json` include。
- 不提供工具、不提供 capability（输入框是唯一交互面）。

---

## 3. 宿主改造（`scripts/run-prebuilt-agent.js`）

### 3.1 三阶段启动（重排 `SessionLifecycle.start`，现状 L819-1068）

```
阶段一 构造：
  resolve 启动模型失败（resolveAgentModelLLM 与 resolveGlobalDefaultLLM 均 null，
  两者均不抛错只返回 null，见 model-preset-resolver.js L214/L289）
  → 不再视为致命：构造 Agent 时不传 llm（框架 §1.2 已允许），继续阶段二。
  resolve 成功 → 现状行为不变（构造注入 + setLLM 贴 boot meta，L860-902）。

阶段二 恢复：
  现状 L1007-1044 流程保持：loadSession →（新会话）continuity 导入 → enableStepAutoSave。
  变更点 a（loadSession catch 区分，L1015-1027）：
    store.load 抛错（快照存在但损坏/读取失败）→ 不再静默转新会话：
    记 sessionRestoreFailed = true，跳过 preInjectCallStart 与 saveSession（禁止覆盖原快照），
    继续阶段三校验（将以失败告终）。
    快照不存在（ENOENT 类）→ 现状新会话路径不变。
  变更点 b（branch 注入消费，L1028）：
    条件从 `!sessionLoaded && handoff.featureContinuity` 改为
    `(!sessionLoaded || handoff.mode === 'branch') && handoff.featureContinuity`；
    importFeatureContinuity 调用加 origin：
      handoff.mode === 'branch' → { kind: 'branch-import', sourceSessionId }
      其余 → { kind: 'continuity-import', sourceSessionId }
    导入成功后现状的 saveSession（L1034）保留——branch 注入一次性落盘进分支快照。

阶段三 READY 门禁（新增，插在 L1066 READY 输出之前）：
  sessionRestoreFailed → 不输出 READY，进程以非零码退出并 console.error 原因（server 侧
    spawn 失败处理链自然接管；不覆盖任何会话文件）。
  agent.llm == null（默认不可用且恢复未绑定任何模型）→ 同上退出。
  通过 → 现状 READY 输出、CallArbiter、输入循环（L1066 起）不变。
```

- READY 之前不接受外部变更：现状 handleIPC 在 start 完成前不可达（IPC 注册在 main 流程 start 之后，L1373-1400），无需额外闸。
- 恢复失败后的资源清理：阶段二失败路径不调用 saveSession（变更点 a 已保证），半恢复实例不会写回原 Session。

### 3.2 feature-comms 请求面（现状 L495-520）

行为不变；`onHostRequest` 已是 duck-typing 调用点，框架契约化（§1.1）后此代码无需改动（类型对齐即可）。

### 3.3 swap IPC 分支退役（L633-712 `swap-model` / `swap-thinking`）

随 §6 前端与路由退役一并删除（保留至 §8 步骤 4 执行）。

### 3.4 `refresh-credentials`（L611-631）保持现状

同 preset 重 resolve、thinkingEffort 原样透传（含显式 null）、`source: 'credential-refresh'`——已是 ADR 决策 3 的"凭证刷新≠改选"实现，不动。

---

## 4. server 侧改造

### 4.1 分支注入（`server/routes/session.js` 分支路由，L654-718）

在 `buildBranchSnapshot` 生成 `branchSnapshot` 后、写盘（L718）之前：

```js
const branchContinuity = exportFeatureContinuity(sourceSnapshot, { mode: 'branch' });
```

写盘分支快照后，若 `hasFeatureContinuity(branchContinuity)`，将注入文件 `{ mode: 'branch', sourceSessionId, featureContinuity: branchContinuity }` 落盘（无 sourceSummary/seedMessages 字段，宿主 L910 的 HandoffSeedFeature 判断天然不触发），并把注入文件路径写入分支会话 index record 的 `metadata.handoffPath`——启动链路既有机制自动消费（agent-startup.js L265 读 record → L287 env `PROTOCLAW_HANDOFF_PATH` → L444 spawn 消息 → run-prebuilt-agent.js L1393/L1497 加载），与接续 handoff 同一传递面。分支会话删除时随既有 handoff 清理路径一并 unlink（session.js L933-934 同型）。

- 分支会话首次启动：宿主 §3.1 变更点 b 消费（loadSession 成功仍导入，origin=branch-import），导入后 saveSession 把源当前选择固化进分支快照，注入文件消费后删除（防止重启重复导入；重复导入同值无害，删除只为语义干净）。
- `exportFeatureContinuity` 从源会话**最新快照**采集（现状语义，feature-continuity.js L151-153 读 `runtime.featureStates`）——即源会话当前值，链级当前状态语义（ADR 决策 2）在分支场景的实现点。
- server 不解析 continuity 内容、不识别模型 Feature（无白名单、无私有字段读取）。
- 同末尾分支（case：`length === messages.length && idle`，session-branch.js L42-44）：快照 featureStates 本就是当前值，注入仍统一走（同值覆盖，幂等）。

### 4.2 请求面投递闸（`server/routes/feature-communication.js` L143 request 路由）

在 `isDeclared` 检查后、runtime 存活检查（L151-152）前，注入接续挡板检查：

```js
if (await isSessionSucceeding(target.agentId, target.sessionId)) {
  return res.status(409).json({ ok: false, code: 'session_succeeding', error: 'Session is rotating; model selection is paused' });
}
```

`isSessionSucceeding` 由 `getThreadIntegration()` 派生（thread record 的 succession 挡板状态；beginSessionSuccession 立挡板到 commit/fail 收敛期间为真）。非线程会话恒 false。

竞态说明（ADR 决策 7 已点名"单次检查后异步投递存在竞态"）：检查通过后挡板才立的窗口内，请求进入旧 runtime 被应用 → `stopManagedAgent({ waitForPersistence: true })` 保存屏障（含去抖窗口，scheduleCommsSave 注释 L408-409）把变更持久化进源快照 → 变换在 stop 完成后读盘（thread-rotation.js L133-134 顺序）→ continuity 打包带走 → successor 恢复。**结果正确**；闸的作用是把大概率窗口从"静默接受"变为"明确拒绝"，双层满足 ADR。

### 4.3 swap 路由退役（`server/routes/model-config.js`）

删除 `/protoclaw/swap_model`（L1184-1243）与 `/protoclaw/swap_thinking_effort`（L1119-1175），含两路由内的远程转发段（ADR-0034 决策 6：远程降级，不保持）。`requestModelSwapAck` helper 若无其余消费者一并删除。

### 4.4 远程降级呈现

`feature-comms` 的 channels/stream/request 路由只查本地 store 与本地 runtime（feature-communication.js 全文无远程转发）：远程会话在本地 store 无通道声明、无 runtime——`listChannels` 返回空、request 无从投递。前端 §5.1 按"无声明即降级"呈现，无需 server 侧新代码。远程模型切换随 swap 路由退役（§4.3）不再有通路，符合 ADR 决策 6 的降级裁决。

---

## 5. 前端改造（`public/src/modules/`）

### 5.1 `input-model-switcher.js`

- `_performInputModelSwap` / `_performThinkingEffortSwap`：`fetch('/protoclaw/swap_model'…)` 改为 `window.ClawFeatureCommunication.request({ agentId, sessionId, featureId: 'model-selection', channelId: 'selection' }, 'selectModel', { presetName })`（思考强度：带 thinkingEffort 键；"默认"项改发 `clearThinkingOverride`）。
- 通道寻址：`sessionId` 取 `getActiveWorkspaceSessionId()`，`agentId` 取会话宿主 ID（`_getInputAgentId` 现状逻辑）；投递目标必须是**会话 runtime**（精确四元组），不再用 runtimeId 双寻址（feature-comms 以 sessionId 寻址唯一 runtime，server 路由已做）。
- 回执处理：保留 `captureSessionViewToken(runtimeId)` + `commitSessionViewPatch(viewToken, { model: 结果 meta })` 代次拒绝（现状机制原样复用）；`meta` 从请求回执取（Feature 返回 `getLLMMeta()`）。
- 控件可用性：打开下拉前先 `listChannels(agentId, sessionId)`，无 `model-selection/selection` 声明（未装配 / 远程旧端 / runtime 未起）→ 按钮置灰，title 提示"当前会话不支持模型切换"（远程会话即此呈现，不报错弹窗）。列表缓存一次/会话即可（通道声明在 runtime 生命周期内稳定）。
- preset 列表：`model-preset-cache.js` 会话命名空间机制原样保留（远程会话拿远程列表的行为不变，仅切换入口降级）。

### 5.2 `input-composer.js`

无改动（按钮渲染无条件，控件可用性由 5.1 呈现层处理）。

### 5.3 呈现口径

"当前模型"继续以 session-view-state 的 overview（getLLMMeta 轮询）为准——现状已如此（`_getInputDefaultPresetName` L56-71 优先 overview.presetName）。恢复失败提示：通道快照的 `lastRestoreFailure` 经 `getStatus` 对账后以 toast 呈现一次（"模型 X 恢复失败，已回退全局默认；原选择保留"），不占用模型名字段。

---

## 6. 消费者装配清单

装配方式：各 `prebuilt-agents/official/<id>/agent.js` 的构造函数 `this.use(new ModelSelectionFeature())`（无参数；serverOrigin/agentId/sessionId 由宿主经构造配置注入——与 time-awareness 等基础 Feature 同层）。

| 工作空间 | 装配 | 依据 |
|---|---|---|
| programming-helper | 是 | 主消费者（交互式 + 线程驱动） |
| coder | 是 | 自主线程接续场景 |
| agent-studio（dev agent） | 是 | 会话视图有持久输入框 |
| memo | 是 | 唯一活动线程承接连续对话 |
| qqbot | 是 | 会话视图可打开即有输入框；IM 线路的模型切换不经输入框，装配无副作用 |
| work-group | 是 | 群会话视图同上；群聊 @mention 派发不经模型控件 |
| home / claw-guide | 是 | 统一装配避免白名单（决策 6"不维护工作空间 ID 白名单"） |
| flow-workspace / feature-creator / agent-creator / feature-repository / dispatch-console / flow-test（隐藏） | 是 | 隐藏工作空间照装（成本为零，行为统一；flow-workspace 构造期自解析路径不受影响——Feature 只消费框架 setModel，不触碰其 preResolvedLLM 构造） |
| studio Test Runtime（`scripts/run-studio-runtime.js`） | 否 | 只读被测环境 |
| plain agent（`claw` CLI / agents/） | 否 | 无交互输入框 |
| agent-studio 新建 agent 模板 | 默认带上 | 防止新制造的 agent 失去基础能力（模板落点：studio agent 装配模板，实施时按 agent-studio-workflow 技能的模板清单同步） |

前端不维护清单：控件可见性 = 通道声明事实（§5.1）。

## 7. 思考强度契约（定案）

- **快照与请求载荷均为两态**：`thinkingEffort` 键缺席 = 未覆盖（跟随 preset 配置档）；string = 显式覆盖。不引入"显式 null"会话态。
- 依据：框架 `setModel` opts 已区分"未传"与"显式 null"（agent.ts L1090-1092 `'thinkingEffort' in opts`）；"厂商默认档"经编辑 preset 配置（`agent-configs/<id>.json` 的 `modelPresets.default.thinkingEffort`）表达即可，无需会话级第三态。ADR 决策 2 要求的"区分未覆盖与显式值、不混淆预设默认与供应商默认"由此满足：会话状态里根本不出现供应商默认标记。
- 现状控件"默认（预设）"项发送 null（实际语义=厂商默认，input-model-switcher.js L481 `effort || null`）——**语义偏差在本次修正**：改发 `clearThinkingOverride`（删除覆盖，回 preset 配置档）。无存量快照迁移问题（Feature 尚不存在）。
- 控件文案保持"默认（预设）"，行为与文案对齐。

## 8. 实施顺序与退役步骤

1. **框架**（AgentDev）：§1 全部 + 测试；build。
2. **Feature**：§2 + 测试；`npm run build:local-features`。
3. **宿主 + server + 前端并行**：§3（三阶段/branch 消费）、§4.1、§4.2、§5.1；装配 §6 各 agent.js。
4. **退役**：§3.3 swap IPC 分支、§4.3 swap 路由、前端旧 fetch 残留、`requestModelSwapAck`；grep `swap_model|swap_thinking|model-swap-result|swap-model` 清理活性引用（文档/技能/AGENT.md）。
5. 每步后跑对应测试；全量 `npm test` + AgentDev core 测试。

## 9. 测试路线（对应 ADR 验收条件）

Claw 侧 `test/`（隔离数据目录 + 假 resolver，不触真实凭证）：

- 启动三阶段：默认不可用+保存选择可用 → 恢复成功；恢复失败 → `__default__` 回退 + READY；两者皆败 → 不 READY、不落盘、原快照字节不变（读写前后 hash 对比）。
- loadSession 损坏快照 → 非零退出、原文件不被覆盖（现状 catch 会覆盖，修复后不得回归）。
- 行为矩阵：五 origin × Feature 行为（Feature 单测，假 modelControl）。
- 分支：源会话选择 B、边界历史值 A → 分支快照含 B（branch 注入后 saveSession 落盘值断言）；末尾分支同值幂等。
- 接续：挡板期间 `selectModel` → 409 `session_succeeding`；挡板立起前窗口内被接受的切换 → successor 快照含该选择（保存屏障链路，mock stopManagedAgent 时序）。
- 请求面：preset 解析失败 → `ok:false` + choice 不变；成功 → meta 返回 + 去抖补存调用。
- 前端往返（沿用 remote-sidebar-projection.test.js 模式）：通道声明缺失 → 控件降级；视图代次拒绝（切会话后迟到回执）。

AgentDev 侧：§1.4。

## 10. 已核实的现状锚点（实施时免重查）

| 事实 | 位置 |
|---|---|
| `setModel` opts 已区分未传/显式 null | AgentDev agent.ts L1086-1100 |
| hook ctx facade 已有模型控制面转发 | AgentDev agent.ts L2501-2508 |
| `restoreSessionSnapshot` 先 ensureFeatureTools 后恢复 | AgentDev agent.ts L908-911 |
| 热重载 restore 先于 onInitiate | AgentDev agent.ts L2289-2319 |
| ReActLoopRunner 仅请求时读 llm | AgentDev agent/react-loop.ts L118/L145 |
| 普通回滚不走 beforeRollback 钩子 | AgentDev agent.ts L1156-1171 |
| resolver 失败返回 null 不抛错 | Claw model-preset-resolver.js L214/L289 |
| loadSession catch 静默转新会话并覆盖落盘 | Claw run-prebuilt-agent.js L1015-1027 |
| 请求面去抖补存（2s） | Claw run-prebuilt-agent.js L411-423 |
| onHostRequest duck-typing 调用点 | Claw run-prebuilt-agent.js L495-519 |
| exportFeatureContinuity 读源最新快照 | Claw feature-continuity.js L147-186 |
| 接续顺序：挡板→保存屏障→变换读盘→READY 提交 | Claw thread-rotation.js L120-187 |
| swap 双路由（含远程转发） | Claw model-config.js L1119-1243 |
| swap 前端唯一消费方 | Claw input-model-switcher.js |
| 持久输入框按钮无 agent 过滤 | Claw input-composer.js L265-278 |
| 视图代次提交机制 | Claw session-view-state.js（captureSessionViewToken/commitSessionViewPatch） |
| handoff 路径经 session record metadata 传递 | Claw agent-startup.js L265-287/L444；run-prebuilt-agent.js L1393/L1497 |
