# app-main.js 模块化拆分计划

> 创建日期：2026-07-03
> 状态：**已收口**（Phase A–D + 后续 workspace-actions / E 系列全部完成）
> 调研文件：`public/src/app-main.js` — 起始 **8,517 行** → 收口 **~1,270 行**（不可再压缩内核）
> 收口复核见文末「十二、收口复核（2026-08-23）」
> 最新指南：`docs/plans/2026-07-12-quality-improvement-guide.md`
> 关联文档：`docs/plans/2026-06-04-frontend-split-plan.md`（v1，已过时）、`docs/plans/2026-06-29-app-ui-split-plan-v2.md`（app-ui.js 拆分 v2，已接近完成）

---

## 一、背景与现状

### 1.1 为什么需要这份计划

app-ui.js 的模块化拆分（v1 + v2）非常成功：从 ~9,500 行瘦身到 ~3,977 行，拆出了 **24 个独立模块**（共 ~15,500 行）。然而 app-main.js 不仅没有被拆分，反而从 v1 记录的 **6,936 行** 膨胀到了 **8,517 行**（+1,581 行，增长 23%）。

膨胀的原因是 2026-06-04 以来新增的大量功能全部直接写进了 app-main.js，没有走模块化路径：

| 新增功能域 | 行数 | 说明 |
|-----------|------|------|
| 运行时通知状态栏 | ~715 | call.start/finish 状态、计时器、阶段标签 |
| 持久输入框/队列系统 | ~473 | 常驻输入、排队气泡、中断按钮 |
| Context Menu 项构建 | ~598 | 右键菜单项的 switch 构建 |
| 聊天消息渲染 | ~672 | render() / renderMessage() / 折叠 |
| 语音输入/ASR | ~347 | 录音→转写→注入 |
| Choice Input 卡片 | ~273 | 多题选择交互 |
| 滚动/Wheel 处理 | ~202 | Chrome scroll recovery |
| PH Model Config / Project | ~270 | PH 工作空间项目操作 |
| 全局事件监听器群 | ~525 | restart/stop/delete 操作绑定 |
| Auto Title 生成 | ~158 | 会话标题自动生成 |
| Recap 离开摘要 | ~171 | 已临时禁用（RECAP_DISABLED = true） |
| Partial Compact / Rollback | ~159 | 部分压缩对话框 |
| External Runtime 操作 | ~148 | 外部 agent 关闭/重启 |
| PH Session 搜索 | ~171 | 会话搜索面板 |
| **合计新增** | **~4,882** | 占当前文件 57% |

### 1.2 当前 script 加载顺序（index.html L332–358）

```
app-core.js                    ← 共享状态与基础设施
modules/toast-notify.js
modules/dispatch-ui.js
modules/dispatch-actions.js
modules/im-ui.js
modules/im-actions.js
modules/session-dialogs.js
modules/feature-setup-ui.js
modules/work-group-ui.js
modules/settings-overlay.js
modules/feature-config.js
modules/chat-context-bar.js
modules/ph-model-config.js
modules/project-data.js
modules/workspace-docset.js
modules/context-menu.js
modules/markdown-utils.js
modules/template-engine.js
modules/theme-lang.js
modules/overview-data.js
modules/chat-viewport.js
modules/debug-panels.js
app-ui.js                      ← 瘦身后的 UI 渲染骨架
modules/resources-viewer.js
modules/session-ui.js
modules/desktop-notify.js
app-main.js                    ← 本次拆分目标（最后加载）
```

**关键约束**：新模块文件必须在 `app-ui.js` 之后、`app-main.js` 之前加载（或紧邻 app-main.js 之前）。因为新模块中的函数被 app-main.js 的残留代码直接调用，且部分函数（如 `renderInputRequests`、`render`）被 app-ui.js 的 `renderCurrentMainView()` 反向调用。

> **例外**：如果新模块**不包含**被 app-ui.js 调用的函数（绝大多数情况），则放在 app-ui.js 之前也安全。

### 1.3 拆分原则（沿用 v1/v2 约束）

1. **不引入 ES module / import / export** — 保持 `<script>` 标签加载
2. **不引入构建工具** — 无 webpack/vite/rollup
3. **不改变全局状态访问方式** — 所有 `let/const` 全局变量照搬
4. **不改变 HTML 模板中的 onclick 绑定** — 保持 `onclick="window.xxx()"`
5. **不做逻辑重构** — 只做位置移动（move, not refactor）
6. **每个模块文件头部加依赖注释** — 标注依赖的全局状态和全局函数
7. **源文件原位留注释** — `// <函数名> → modules/xxx.js`

---

## 二、当前 app-main.js 功能域地图

> 以下行号基于 2026-07-03 的文件快照（8,517 行）。拆分过程中行号会变，每次拆完后以 grep 重新定位。

### 域 L: Agent 身份与辅助函数

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L1–112 | ~112 | ★★★★★ 极独立 | 不拆（纯函数，保留在 main 做基础设施） |

函数：`normalizeAgentIdentity`, `getCurrentHostAgentRecord`, `getCurrentRuntimeRecord`, `getCurrentVisualAgentTitle`, `updateCurrentAgentChrome`, `isAgentActive`, `getCurrentAgentRecord`, `groupConnectedAgents`, `isRuntimeItemActive`, `toEpochMs`

依赖全局：`allAgents`, `currentAgentId`, `currentRuntimeAgentId`, `currentAgentTitle`, `statusBadge`, `currentLanguage`
被调用方：几乎所有其他域

### 域 M: Sidebar / AgentList 渲染

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L639–1139 | ~500 | ★★★☆☆ 中 | **Phase E（高风险，最后评估）** |

函数：`renderSidebarChildItems`, `getAgentIconHtml`, `renderAgentGroup`（~350 行巨型函数）, `loadAgents`, `refreshAgentCallStates`, `getAgentListRenderSignature`, `renderAgentList`
常量：`AGENT_ICONS`, `_callStatesRefreshInProgress`, `lastAgentListRenderSignature`

难点：`loadAgents` 被 app-ui.js 反向调用（L2091），是双向耦合枢纽。`renderAgentList` 被 `updateNotificationStatus`、`interruptAgent`、`switchAgent` 高频调用。

### 域 N: Agent 点击与 Session 切换入口

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L1140–1497 | ~357 | ★★☆☆☆ | **Phase E（不拆，保留在 main）** |

函数：`window.handlePrebuiltAgentClick`, `applyOptimisticWorkspaceSession`, `window.switchPhSessionTab`, `window.phToggleSessionSort`, `window._buildPhSearchPanelHtml`, `_updatePhSearchPanelDom`, `window.phOnSearchInput`, `window.phClearSearch`, `window.phShowSessionCtxMenu`

### 域 O: Workspace Action Dispatcher

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L1497–2144 | ~647 | ★☆☆☆☆ 极低独立性 | **不拆（核心路由，永久保留在 main）** |

函数：`window.runWorkspaceAction`（~540 行巨型 switch，~20 种 action 类型）

### 域 P: Assembly Form Draft 操作

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L2144–2265 | ~121 | ★★☆☆☆ | **Phase C（与 assembly 操作一起评估）** |

函数：`window.updateWorkspaceFormDraft`, `window.toggleWorkspaceSelection`, `window.applyWorkspaceBundle`

### 域 Q: Assembly 全生命周期操作

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L2265–2910 + L3780–4091 | ~960（分散） | ★★☆☆☆ 低独立性 | **Phase C（高风险）** |

函数：`createAssemblyEnvironment`, `launchAssemblyInstance`, `getSavedAssemblyConfigs`, `canonicalizeAssemblyFeatureSelection`, `saveCurrentAssemblyConfig`, `resetAssemblyDraft`, `switchAssemblyEditingTarget`, `toggleAssemblyControlPanel`, `jumpAssemblyStage`, `loadSavedAssemblyConfig`, `launchAssemblyConfig`, `deleteSavedAssemblyConfig`, `launchSavedAssemblyRun`, `fwLaunchConfig`, `fwResumeRun`, `deleteAssemblySessionRecord`, `loadAssemblySessionIntoDraft`, `stopAssemblySessionRuntime`, `chooseWorkspaceDirectory`, `saveWorkspaceForm`, `resetWorkspaceForm`, `showCompactMenu`

难点：与 app-ui.js 的 assembly data 层（`getWorkspaceFormDraft`, `normalizeAssemblyDraft`, `persistWorkspaceState` 等）深度交叉。

### 域 R: Model Config / PH Project 操作

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L2908–3180 | ~272 | ★★★★☆ 高独立 | **Phase A-4（低风险）** |

函数：`window.phOpenModelConfig`, `window.phCloseModelConfig`, `window.phSaveModelConfig`, `window.phOpenProject`, `window.phSwitchProject`, `window.phToggleProjectDropdown`, `window.phOpenInExplorer`, `window.phToggleModelSlot`

### 域 S: Context Menu 项构建与分发

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L3181–3779 | ~598 | ★★★★☆ 高独立 | **Phase B-2（中风险）** |

函数：`getCtxMenuItems`（~500 行 switch）, `dispatchCtxAction`
依赖：`window.closeCtxMenu`（modules/context-menu.js）、`window.openBranchDialog`（modules/session-dialogs.js）、`window.openTrimDialog`（modules/session-dialogs.js）、`window.runWorkspaceAction`（app-main.js）

### 域 T: 全局事件监听器群

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L3780–4907 | ~1127（含域 Q 尾部） | ★☆☆☆☆ | **不拆（全局胶水代码，保留在 main）** |

内容：`markSessionLoading`, `markActionLoading`, `clearSessionLoading`, `restartAgentAction.addEventListener`, `stopAgentAction.addEventListener`, `openSessionAction.addEventListener`, `compactedResumeSessionAction.addEventListener`, `compactSummaryAction.addEventListener`, `compactTrimAction.addEventListener`, `compactBranchAction.addEventListener`, `deleteAgentAction.addEventListener`, `deleteSessionAction.addEventListener`, `deleteProjectAction.addEventListener`, `deleteFeatureAction.addEventListener`, `document.addEventListener('click')`, `window.addEventListener('resize')`, `window.addEventListener('scroll')`

### 域 U: Session Switch Orchestrator

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L4091–4232 | ~141 | ★☆☆☆☆ | **不拆（系统核心，永久保留）** |

函数：`flushPendingSwitch`, `requestSwitch`, `window.switchAgent`

### 域 V: External Runtime Close/Restart

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L4233–4381 | ~148 | ★★★★☆ 高独立 | **Phase A-5（低风险）** |

函数：`getExternalRuntimeAgent`, `isAssemblyExternalRuntime`, `closeExternalRuntime`, `restartExternalRuntime`, `resolveSidebarAssemblyRuntimeTarget`, `closeSidebarExternalRuntime`, `restartSidebarExternalRuntime`, `refreshSidebarRuntimeAfterMutation`

### 域 W: 滚动/Wheel/Visibility 处理

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L4915–5117 | ~202 | ★★★★☆ 高独立 | **Phase B-3（中风险）** |

函数：`normalizeWheelDeltaY`, `canElementScrollVertically`, `hasScrollableWheelTarget`, `isChromeWithoutEdge`, `shouldUseManualWheelScroll`, `markChatPageResumed`
状态：`chatScrollNeedsWheelRecovery`
事件绑定：`container.addEventListener('wheel'...)` ×2, `container.addEventListener('touchmove'...)`, `container.addEventListener('pointerdown'...)`, `container.addEventListener('contextmenu'...)`, `container.addEventListener('keydown'...)`, `container.addEventListener('scroll'...)` ×2, `followLatestButton.addEventListener`, `document.addEventListener('visibilitychange')`, `window.addEventListener('focus'/'pageshow')`

> 注意：contextmenu 事件监听中包含对 `getCtxMenuItems` 和 `window.showCtxMenu` 的调用，域 S 拆出后此监听器内的调用仍可正常工作（全局函数）。但 contextmenu 监听器与域 W 的其他滚动相关监听器混在一起，需要按事件类型精确切割。

### 域 X: Poll 主循环与数据加载

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L5118–5806 | ~688 | ★☆☆☆☆ 极低独立性 | **Phase D（高风险，最后评估）** |

函数：`loadLogs`, `loadMcpInfo`, `loadAgentData`, `refreshCurrentRuntimeStatus`, `poll`（~300 行）
依赖：几乎所有其他域的函数

### 域 Y: Auto Title 生成

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L5310–5468 + L5476–5505 | ~188 | ★★★★★ 极独立 | **Phase A-3（零风险）** |

函数：`getAutoTitleSessionInfo`, `markAutoTitleCandidate`, `_messagesEqual`, `findFirstChangedMessageIndex`, `tryAutoTitleGeneration`, `autoGenerateSessionTitle`, `checkGlobalChoiceAlerts`
状态：`_autoTitlePending`, `_autoTitleAttempts`, `_autoTitleRetryAt`, `_autoTitleTriggered`（注意：`_autoTitleTriggered` 定义位置需 grep 确认，可能在 app-core.js 或附近）
依赖全局：`currentRuntimeAgentId`, `currentAgentId`, `currentMessages`, `allAgents`, `currentLanguage`, `ClawToast`

### 域 Z: 通知状态 DOM 更新

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L5808–5998 | ~190 | ★★★☆☆ | **Phase B-1（与域 AA 合并）** |

函数：`updateNotificationStatus`
依赖域 L（运行时状态 helper）、`_agentCallActive`、`renderAgentList`、`renderInputRequests`、`_syncPersistentActionButton`、`_syncQueueFromBackend`

### 域 AA: 运行时状态/通知 Helper 群

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L113–638 | ~525 | ★★★★☆ 高独立 | **Phase B-1（与域 Z 合并）** |

函数：`buildSyntheticRuntimeEntry`, `buildChildRuntimeEntry`, `collectRuntimeEntriesForPrebuilt`, `isRuntimeCalling`, `resolveNotificationCallingState`, `normalizeNotificationRuntimeSnapshot`, `getRuntimeStageLabel`, `getCompactRuntimeLabel`, `formatRuntimeCompactNumber`, `formatRuntimeDuration`, `summarizeRuntimeToolNames`, `getPendingToolCallsFromMessages`, `getDerivedStageFromState`, `getNotificationActionSource`, `getEffectiveRuntimeSnapshot`, `getRuntimeSummary`, `getRuntimeTimerLabel`, `renderRuntimeTimer`, `refreshNotificationTimerDisplay`, `ensureNotificationClockTimer`, `getRuntimeStageClass`, `shouldShowRuntimeStatus`, `shouldStatusUseQueueSync`, `getInputSurfaceMode`
状态：`currentRuntimeConnected`, `lastNotificationStatusPayload`, `_runtimeStatusMemory`, `_lastRenderedNotificationRuntime`, `_notificationClockTimer`

### 域 AB: 输入面板渲染

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L6000–6251 | ~251 | ★★☆☆☆ | **不拆（聚合分发器，保留在 main）** |

函数：`getInputRenderSignature`, `renderInputRequests`
原因：调用 D12 的 `renderPersistentInput`、D13 的 `renderChoiceInputRequest`、语音子系统的状态变量，是多子系统的聚合点。拆出 D12/D13 后，此函数变薄但仍需协调多个子系统。

### 域 AC: 持久输入框/队列系统

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L6252–6725 | ~473 | ★★★★☆ 高独立 | **Phase B-4（中风险）** |

函数：`formatCallElapsed`, `_ensureInputMetaBar`, `_cleanupInputMetaBar`, `_renderLastCallElapsed`, `renderPersistentInput`, `onPersistentBtnClick`, `_setActionBtnStop`, `_setActionBtnSend`, `_syncPersistentActionButton`, `_renderQueueBubbles`, `_syncQueueFromBackend`, `handlePersistentInputKey`, `submitQueuedInput`, `updateQueueIndicator`, `_syncPersistentInputUi`, `interruptAgent`
状态：`_pendingQueuedCount`, `_queuedTexts`, `_persistentUiSyncInFlight`, `_localQueuedInputPending`, `_lastQueueBubbleSignature`, `_lastCallFinishTime`, `_callFinishTimerInterval`

注意：`_lastCallFinishTime` 也被域 Z（`updateNotificationStatus`）读写，需要确认是留在 main 还是移到模块。

### 域 AD: Choice Input 卡片

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L6773–7046 | ~273 | ★★★★★ 极独立 | **Phase A-2（零风险）** |

函数：`isChoiceInputRequest`, `getChoiceRequestById`, `getChoiceState`, `getChoiceOptionCount`, `buildChoiceAnswer`, `rememberCurrentChoice`, `renderChoiceInputRequest`, `rerenderChoiceRequest`, `collapsePrimaryChoiceRequest`
window 函数：`selectChoiceOption`, `collapseChoiceRequest`, `expandChoiceRequest`, `updateChoiceCustomText`, `handleChoiceKey`, `handleChoiceCustomKey`, `confirmChoiceQuestion`
依赖全局：`currentInputRequests`, `choiceInputState`（app-core.js 定义）, `currentRuntimeAgentId`, `lastRenderedInputSignature`, `renderInputRequests`（回调）

### 域 AE: Rollback/Compact 对话框 + Process Visibility

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L7048–7318 | ~270 | ★★★☆☆ 中 | **Phase B-5（中风险）** |

函数：`syncRollbackActionButtons`, `updateRollbackActionVisibility`, `autoResize`, `handleInputKey`, `submitInput`, `getPrimaryInputRequest`, `requestSupportsAction`, `getRollbackInputRequest`, `getAvailableCallIndices`, `canRollbackMessage`, `saveChatProcessVisibility`, `hasConversationProcessContent`, `updateChatProcessToggle`, `syncAssistantProcessOnlyRows`, `applyConversationProcessState`, `window.toggleChatProcessVisibility`, `submitInputAction`

> 注意：`autoResize`、`handleInputKey`、`submitInput` 被域 AB（`renderInputRequests`）的 HTML onclick 引用。`canRollbackMessage` 被域 AF（`render`/`renderMessage`）调用。拆出时需确保这些函数在全局可用。

### 域 AF: Partial Compact 状态 + Rollback Dialog

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L7320–7479 | ~159 | ★★★★☆ 高独立 | **Phase A-6（低风险）** |

函数：`getPartialCompactStorageKey`, `readPartialCompactStartedAt`, `writePartialCompactStartedAt`, `clearPartialCompactStartedAt`, `clearPartialCompactState`, `showRollbackActionDialog`, `window.requestRollbackEdit`
状态：`_partialCompactInFlight`, `_partialCompactRuntimeId`, `_partialCompactContextKey`, `_compactTimerInterval`, `_rollbackDialogOpen`

> 注意：`_partialCompactInFlight` / `_partialCompactRuntimeId` 被 poll() 和 renderInputRequests() 读取。如果模块化和 main 之间共享这些变量，需要确保它们挂在全局作用域（不使用 let 而用 `window._partialCompactInFlight` 或保持 `let` 在全局）。

### 域 AG: 聊天消息渲染

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L7481–8153 | ~672 | ★★★☆☆ 中 | **Phase D（高风险）** |

函数：`renderMessage`, `appendNewMessages`, `updateLastMessage`, `render`（~200 行全量重建）, `getCollapseThresholdForRow`, `syncRowCollapseState`, `syncCollapseStates`, `applyCollapseLogic`, `restoreUserCollapseState`, `window.toggleMessage`, `window.toggleReasoning`
依赖 modules：`renderMarkdown`, `parseToolResult`, `getToolDisplayName`, `getToolRenderTemplate`, `renderJsonHighlight`, `applyTemplate`, `enhanceMathInElement`
依赖全局：`currentMessages`, `toolRenderConfigs`, `TOOL_NAMES`, `_lastRenderedChatSig`, `allAgents`, `container`

关键耦合：`render(currentMessages)` 被 app-ui.js 的 `renderCurrentMainView()` 直接调用（L3348）。`appendNewMessages` 和 `updateLastMessage` 被 `poll()` 调用。

### 域 AH: 语音输入/ASR

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L8155–8502 | ~347 | ★★★★★ 极独立 | **Phase A-1（零风险，最先拆）** |

函数：`_playVoiceSound`, `_updateVoiceUI`, `toggleVoiceRecording`, `startVoiceRecording`, `stopVoiceRecording`, `_cancelVoiceRecording`, `sendAudioToASR`, `insertTextAtCursor`, `_cacheSessionInput`, `_restoreSessionInputDraft`, `_storeSessionInputDraft`, `_storeVisibleSessionInputDraft`, `_injectPendingVoiceResult`, `_getSessionInputCacheKey`
状态：`_voiceRecording`, `_voiceTranscribing`, `_voiceMediaRecorder`, `_voiceAudioChunks`, `_voiceTargetBtn`, `_voiceCancelled`, `_voicePendingSend`, `_voiceAgentId`, `_voiceCacheKey`, `_pendingVoiceResults`, `_sessionInputCache`

> 注意：`_voiceRecording` / `_voiceTranscribing` / `_voicePendingSend` 被 `renderInputRequests()`（域 AB）读取判断录音状态。`_sessionInputCache` 被 `submitQueuedInput`、`submitInput` 读写。`autoResize` 被语音函数调用但在域 AE 定义。拆分后这些变量和函数在全局作用域仍可访问（script 标签共享全局），但需确认没有闭包隔离。

### 域 AI: Recap 离开摘要（已临时禁用）

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L6339–6510 | ~171 | ★★★★★ 极独立 | **Phase A-7（零风险）** |

函数：`_getRecapAgentAndSession`, `_maybeFetchRecap`, `_dismissRecap`, `_clearRecapForNewMessage`, `_renderRecapHint`, `_trackRecapSessionPresence`
状态：`RECAP_DISABLED`, `_recapLastSeenBySession`, `_recapShownForSession`, `_recapDismissedForSession`, `_currentRecapText`, `_recapFetchInFlight`, `_recapPendingTrigger`, `RECAP_AWAY_THRESHOLD_MS`

> 注意：`_renderRecapHint` 被 `renderInputRequests()` 调用。`_trackRecapSessionPresence` 被 `poll()` 调用。`_currentRecapText` / `_recapPendingTrigger` 被 `updateNotificationStatus()` 和 `loadAgentData()` 读写。当前 `RECAP_DISABLED = true`，所有函数入口提前返回，拆分零风险但需确认状态变量全局可访问。

### 域 AJ: Bootstrap

| 行号 | 行数 | 耦合 | 拆分优先级 |
|------|------|------|-----------|
| L8504–8517 | ~13 | ★☆☆☆☆ | **不拆（永远保留在 main 尾部）** |

内容：`applyTheme(currentTheme)`, `applyLanguage()`, `(async () => { await waitForViewerReady(); ... poll(); })()`

---

## 三、拆分目标结构

### 3.1 目标模块清单

```
public/src/
  app-core.js              (不变，~1,317 行)
  app-ui.js                (不变，~3,977 行)
  app-main.js              (瘦身目标：~4,500–5,000 行)

  modules/                  （已有 24 个模块保持不变）
    voice-input.js         (~347 行)  域 AH — 语音录制→ASR→注入     [新]
    choice-input.js        (~273 行)  域 AD — 选择卡片交互          [新]
    auto-title.js          (~188 行)  域 Y  — 自动标题生成          [新]
    ph-project-actions.js  (~272 行)  域 R  — PH 项目操作           [新]
    external-runtime.js    (~148 行)  域 V  — 外部 runtime 操作     [新]
    rollback-dialog.js     (~159 行)  域 AF — partial compact dialog [新]
    recap-hint.js          (~171 行)  域 AI — 离开摘要（已禁用）     [新]
    runtime-status.js      (~715 行)  域 AA+Z — 运行时状态/通知     [新]
    ctx-menu-items.js      (~598 行)  域 S  — context menu 项构建   [新]
    chat-scroll.js         (~202 行)  域 W  — 滚动/wheel 处理       [新]
    persistent-input.js    (~473 行)  域 AC — 持久输入/队列         [新]
    input-helpers.js       (~270 行)  域 AE — rollback/process/submit [新]
    chat-renderer.js       (~672 行)  域 AG — 聊天消息渲染          [新,高风险]
```

**Phase A–B 完成后预估减少 ~2,328 行 → app-main.js 降至 ~6,189 行**
**Phase C–D 完成后预估减少 ~1,457 行 → app-main.js 降至 ~4,732 行**

### 3.2 index.html 加载顺序变更

在现有 L357（`desktop-notify.js`）和 L358（`app-main.js`）之间，按依赖顺序插入新模块：

```html
  <!-- ... 现有 24 个 modules ... -->
  <script src="./src/modules/desktop-notify.js?v=XXX"></script>

  <!-- ↓↓↓ Phase A: 零风险子系统（自包含，无被 app-ui.js 调用的函数） ↓↓↓ -->
  <script src="./src/modules/voice-input.js?v=XXX"></script>
  <script src="./src/modules/choice-input.js?v=XXX"></script>
  <script src="./src/modules/auto-title.js?v=XXX"></script>
  <script src="./src/modules/recap-hint.js?v=XXX"></script>
  <script src="./src/modules/rollback-dialog.js?v=XXX"></script>

  <!-- ↓↓↓ Phase B: 中风险子系统（部分函数被 app-main.js 或 app-ui.js 调用） ↓↓↓ -->
  <script src="./src/modules/ph-project-actions.js?v=XXX"></script>
  <script src="./src/modules/external-runtime.js?v=XXX"></script>
  <script src="./src/modules/runtime-status.js?v=XXX"></script>
  <script src="./src/modules/ctx-menu-items.js?v=XXX"></script>
  <script src="./src/modules/chat-scroll.js?v=XXX"></script>
  <script src="./src/modules/persistent-input.js?v=XXX"></script>
  <script src="./src/modules/input-helpers.js?v=XXX"></script>

  <!-- ↓↓↓ Phase D: 高风险（被 app-ui.js renderCurrentMainView 反向调用） ↓↓↓ -->
  <script src="./src/modules/chat-renderer.js?v=XXX"></script>

  <script src="./src/app-main.js?v=XXX"></script>
```

> `?v=XXX` 使用 Date.now() 整数，每次修改 index.html 时更新。

---

## 四、分 Phase 拆分计划

### Phase A: 零风险子系统提取

> **目标**：7 个完全自包含的子系统/功能群，合计 ~1,558 行
> **风险**：★☆☆☆☆ ~ ★★☆☆☆
> **原则**：每个模块的模块级变量全部搬走，window 函数保持全局注册，在 app-main.js 原位留注释

---

#### Phase A-1: voice-input.js（语音输入/ASR）

| 属性 | 值 |
|------|-----|
| 来源行号 | L8155–8502 |
| 预估行数 | ~347 |
| 风险 | ★☆☆☆☆ |
| 拆出函数 | `_playVoiceSound`, `_updateVoiceUI`, `toggleVoiceRecording`, `startVoiceRecording`, `stopVoiceRecording`, `_cancelVoiceRecording`, `sendAudioToASR`, `insertTextAtCursor`, `_cacheSessionInput`, `_restoreSessionInputDraft`, `_storeSessionInputDraft`, `_storeVisibleSessionInputDraft`, `_injectPendingVoiceResult`, `_getSessionInputCacheKey` |
| 搬走的变量 | `_voiceRecording`, `_voiceTranscribing`, `_voiceMediaRecorder`, `_voiceAudioChunks`, `_voiceTargetBtn`, `_voiceCancelled`, `_voicePendingSend`, `_voiceAgentId`, `_voiceCacheKey`, `_pendingVoiceResults`, `_sessionInputCache` |

**模块文件头模板**：
```js
/**
 * voice-input.js — 语音输入 / ASR
 * 从 app-main.js 拆出（Phase A-1）
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentRuntimeAgentId, currentLanguage
 * 依赖全局函数:
 *   autoResize (app-main.js / input-helpers.js)
 *   submitQueuedInput, submitInput (app-main.js / persistent-input.js)
 *   renderInputRequests (app-main.js)
 *   getRuntimeContextKey (app-core.js)
 *   ClawToast (modules/toast-notify.js)
 * 导出全局函数:
 *   toggleVoiceRecording, _cacheSessionInput, _restoreSessionInputDraft,
 *   _storeVisibleSessionInputDraft, _injectPendingVoiceResult,
 *   _getSessionInputCacheKey, _cancelVoiceRecording, stopVoiceRecording
 * 全局变量（HTML onclick 引用）:
 *   _sessionInputCache, _pendingVoiceResults
 */
```

**执行前 grep 验证清单**：
- [ ] grep `_voiceRecording\b` — 确认仅被 `renderInputRequests`（L6038–6050）和语音函数内部引用
- [ ] grep `_voiceTranscribing\b` — 确认被 `onPersistentBtnClick`（L6544）、`handlePersistentInputKey`（L6624）、`submitInput`（L7107）、`submitQueuedInput`（无直接引用，间接通过 _voicePendingSend）引用
- [ ] grep `_sessionInputCache\b` — 确认被 `submitQueuedInput`（L6654）、`submitInput`（L7135）读写
- [ ] grep `_pendingVoiceResults\b` — 确认仅在语音函数内部使用
- [ ] grep `toggleVoiceRecording\b` — 确认被 HTML onclick 引用（renderInputRequests 和 renderPersistentInput 中的模板字符串）
- [ ] grep `_getSessionInputCacheKey\b` — 确认被 renderInputRequests、poll、auto-title 等多处调用（这个函数可能不适合搬走，考虑保留在 main 或移到 app-core.js）

> **⚠️ 注意**：`_getSessionInputCacheKey()` 调用 `getRuntimeContextKey()`，被多个域引用（renderInputRequests、poll、auto-title、persistent-input）。建议此函数**保留在 app-main.js** 或移到 app-core.js，不随语音模块搬走。仅搬走语音专用函数和 `_sessionInputCache`。

**执行步骤**：
- [ ] 1. 创建 `public/src/modules/voice-input.js`，写入文件头注释
- [ ] 2. 将 `_sessionInputCache` 和语音专用变量/函数从 app-main.js 剪切到新文件
- [ ] 3. 将 `_getSessionInputCacheKey` 保留在 app-main.js（或移到 app-core.js）
- [ ] 4. 在 app-main.js 原位加注释 `// 语音输入/ASR → modules/voice-input.js`
- [ ] 5. 在 index.html 的 desktop-notify.js 之后插入 `<script src="./src/modules/voice-input.js?v=XXX"></script>`
- [ ] 6. 重启 Claw 服务
- [ ] 7. 验证（见下方验证清单）

**验证清单**：
- [ ] 页面正常加载，无 JS 报错（F12 Console）
- [ ] 点击语音按钮 → 开始录音 → 停止 → ASR 转写 → 文本注入输入框
- [ ] 录音期间切换会话 → 确认跨会话暂存正常
- [ ] 录音期间点击发送 → 确认 auto-send 正常
- [ ] 输入框草稿在会话切换后恢复正常
- [ ] 无录音时提交消息 → 确认 `_sessionInputCache` 清除正常

---

#### Phase A-2: choice-input.js（选择卡片交互）

| 属性 | 值 |
|------|-----|
| 来源行号 | L6773–7046 |
| 预估行数 | ~273 |
| 风险 | ★☆☆☆☆ |
| 拆出函数 | `isChoiceInputRequest`, `getChoiceRequestById`, `getChoiceState`, `getChoiceOptionCount`, `buildChoiceAnswer`, `rememberCurrentChoice`, `renderChoiceInputRequest`, `rerenderChoiceRequest`, `collapsePrimaryChoiceRequest` |
| window 函数 | `selectChoiceOption`, `collapseChoiceRequest`, `expandChoiceRequest`, `updateChoiceCustomText`, `handleChoiceKey`, `handleChoiceCustomKey`, `confirmChoiceQuestion` |
| 不搬走 | `choiceInputState`（定义在 app-core.js，保持原位） |

**执行前 grep 验证清单**：
- [ ] grep `isChoiceInputRequest\b` — 确认被 renderInputRequests（L6026）、poll（无直接引用）调用
- [ ] grep `renderChoiceInputRequest\b` — 确认仅被 renderInputRequests（L6166）调用
- [ ] grep `confirmChoiceQuestion\b` — 确认被 HTML onclick 引用
- [ ] grep `selectChoiceOption\b` — 确认被 HTML onclick 引用
- [ ] grep `collapsePrimaryChoiceRequest\b` — 确认被 renderInputRequests 的 onclick 调用

**执行步骤**：
- [ ] 1. 创建 `public/src/modules/choice-input.js`，写入文件头注释
- [ ] 2. 将函数从 app-main.js 剪切到新文件（保留 `choiceInputState` 在 app-core.js）
- [ ] 3. 在 app-main.js 原位加注释
- [ ] 4. 在 index.html 插入 script 标签
- [ ] 5. 重启服务
- [ ] 6. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] Agent 发起 choice 请求 → 确认选择卡片正常渲染
- [ ] 键盘 ↑↓ 选择选项 → 正常高亮
- [ ] ←→ 切换题目 → 正常翻页
- [ ] Enter 确认 → 正常提交
- [ ] 点击"其他"→ 自定义文本输入 → 提交正常
- [ ] 点击 × 折叠 → 再展开 → 正常恢复

---

#### Phase A-3: auto-title.js（自动标题生成）

| 属性 | 值 |
|------|-----|
| 来源行号 | L5310–5468 + L5476–5505 |
| 预估行数 | ~188 |
| 风险 | ★☆☆☆☆ |
| 拆出函数 | `getAutoTitleSessionInfo`, `markAutoTitleCandidate`, `_messagesEqual`, `findFirstChangedMessageIndex`, `tryAutoTitleGeneration`, `autoGenerateSessionTitle`, `checkGlobalChoiceAlerts` |
| 搬走的变量 | `_autoTitlePending`, `_autoTitleAttempts`, `_autoTitleRetryAt` |
| 不搬走 | `_autoTitleTriggered`（需 grep 确认定义位置）、`_seenChoiceAlertIds`、`_lastChoiceAlertCheckAt`（可能在 app-core.js） |

**执行前 grep 验证清单**：
- [ ] grep `_autoTitleTriggered\b` — 确认定义位置（可能遗漏在 grep 中，因为可能是 `let _autoTitleTriggered = new Set()`）
- [ ] grep `_seenChoiceAlertIds\b` — 确认定义位置
- [ ] grep `_lastChoiceAlertCheckAt\b` — 确认定义位置
- [ ] grep `markAutoTitleCandidate\b` — 确认仅被 poll（L5636）调用
- [ ] grep `tryAutoTitleGeneration\b` — 确认仅被 poll（L5732）调用
- [ ] grep `findFirstChangedMessageIndex\b` — 确认仅被 poll（L5637）调用
- [ ] grep `checkGlobalChoiceAlerts\b` — 确认仅被 poll（L5517）调用

**执行步骤**：
- [ ] 1. grep 确认所有 `_autoTitle*` 和 `_seenChoiceAlert*` 变量定义位置
- [ ] 2. 创建 `public/src/modules/auto-title.js`
- [ ] 3. 剪切函数和变量到新文件
- [ ] 4. 在 app-main.js 原位加注释
- [ ] 5. 在 index.html 插入 script 标签
- [ ] 6. 重启服务
- [ ] 7. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 新建会话 → 发送一条消息 → 等待 Agent 回复 → 确认标题自动生成
- [ ] 确认 `findFirstChangedMessageIndex` 在 poll 中正常工作（消息增量渲染不受影响）
- [ ] 确认 choice alert toast 在其他 agent 有 choice request 时正常弹出

---

#### Phase A-4: ph-project-actions.js（PH 项目操作）

| 属性 | 值 |
|------|-----|
| 来源行号 | L2908–3180 |
| 预估行数 | ~272 |
| 风险 | ★★☆☆☆ |
| 拆出函数 | `window.phOpenModelConfig`, `window.phCloseModelConfig`, `window.phSaveModelConfig`, `window.phOpenProject`, `window.phSwitchProject`, `window.phToggleProjectDropdown`, `window.phOpenInExplorer`, `window.phToggleModelSlot` |
| 搬走的变量 | `window.phModelConfigAgentId`（L2922 赋值） |

**执行前 grep 验证清单**：
- [ ] grep `phOpenModelConfig\b` — 确认被 HTML onclick 引用
- [ ] grep `phSaveModelConfig\b` — 确认被 HTML onclick 引用
- [ ] grep `phOpenProject\b` — 确认被 HTML onclick 引用
- [ ] grep `phSwitchProject\b` — 确认被 HTML onclick 引用
- [ ] grep `phModelConfigAgentId\b` — 确认引用点
- [ ] grep `phToggleModelSlot\b` — 确认被 HTML onclick 引用

**执行步骤**：
- [ ] 1. 创建 `public/src/modules/ph-project-actions.js`
- [ ] 2. 剪切函数到新文件
- [ ] 3. 在 app-main.js 原位加注释
- [ ] 4. 在 index.html 插入 script 标签
- [ ] 5. 重启服务
- [ ] 6. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 打开 programming-helper → 点击"打开项目"→ 项目选择正常
- [ ] 切换项目 → 会话列表正常刷新
- [ ] 模型配置 → 打开/修改/保存 → 正常
- [ ] "在资源管理器中打开"→ 正常
- [ ] 模型插槽切换 → 正常

---

#### Phase A-5: external-runtime.js（外部 runtime 操作）

| 属性 | 值 |
|------|-----|
| 来源行号 | L4233–4381 |
| 预估行数 | ~148 |
| 风险 | ★★☆☆☆ |
| 拆出函数 | `getExternalRuntimeAgent`, `isAssemblyExternalRuntime`, `closeExternalRuntime`, `restartExternalRuntime`, `resolveSidebarAssemblyRuntimeTarget`, `closeSidebarExternalRuntime`, `restartSidebarExternalRuntime`, `refreshSidebarRuntimeAfterMutation` |

**执行前 grep 验证清单**：
- [ ] grep `getExternalRuntimeAgent\b` — 确认被事件监听器（restartAgentAction L4391, stopAgentAction L4451）调用
- [ ] grep `closeSidebarExternalRuntime\b` — 确认被事件监听器（stopAgentAction L4456）调用
- [ ] grep `restartSidebarExternalRuntime\b` — 确认被事件监听器（restartAgentAction L4403）调用
- [ ] grep `resolveSidebarAssemblyRuntimeTarget\b` — 确认仅被 close/restart 函数调用
- [ ] grep `refreshSidebarRuntimeAfterMutation\b` — 确认被 stopAgentAction（L4465）调用

**执行步骤**：
- [ ] 1. 创建 `public/src/modules/external-runtime.js`
- [ ] 2. 剪切函数到新文件
- [ ] 3. 在 app-main.js 原位加注释
- [ ] 4. 在 index.html 插入 script 标签
- [ ] 5. 重启服务
- [ ] 6. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 右键外部 agent → 重启 → 确认正常
- [ ] 右键外部 agent → 停止 → 确认正常
- [ ] flow-workspace 中启动 assembly → 停止 → 确认正常

---

#### Phase A-6: rollback-dialog.js（Partial Compact / Rollback Dialog）

| 属性 | 值 |
|------|-----|
| 来源行号 | L7320–7479 |
| 预估行数 | ~159 |
| 风险 | ★★☆☆☆ |
| 拆出函数 | `getPartialCompactStorageKey`, `readPartialCompactStartedAt`, `writePartialCompactStartedAt`, `clearPartialCompactStartedAt`, `clearPartialCompactState`, `showRollbackActionDialog` |
| window 函数 | `requestRollbackEdit` |
| 搬走的变量 | `_partialCompactInFlight`, `_partialCompactRuntimeId`, `_partialCompactContextKey`, `_compactTimerInterval`, `_rollbackDialogOpen` |

> **⚠️ 关键注意**：`_partialCompactInFlight` 和 `_partialCompactRuntimeId` 被 `poll()`（L5591, L5716–5720）和 `renderInputRequests()`（L6113）读取。这些变量必须保持在全局作用域可见。
>
> 如果使用 `let _partialCompactInFlight = false;` 定义在新模块文件的顶层，在非-module 脚本中它就是全局变量，app-main.js 中的 poll() 和 renderInputRequests() 可以直接读写。**不需要改成 `window.xxx`**。

**执行前 grep 验证清单**：
- [ ] grep `_partialCompactInFlight\b` — 确认被 poll（L5591, L5716）、renderInputRequests（L6113）读取
- [ ] grep `_partialCompactRuntimeId\b` — 确认被 poll（L5591, L5717）、renderInputRequests 读取
- [ ] grep `_rollbackDialogOpen\b` — 确认被 renderInputRequests（L6019）读取
- [ ] grep `clearPartialCompactState\b` — 确认被 poll（L5592, L5720）调用
- [ ] grep `requestRollbackEdit\b` — 确认被 HTML onclick 和 syncRollbackActionButtons 调用
- [ ] grep `_compactTimerInterval\b` — 确认仅在 partial compact 函数内部使用

**执行步骤**：
- [ ] 1. 创建 `public/src/modules/rollback-dialog.js`
- [ ] 2. 剪切函数和变量到新文件
- [ ] 3. 在 app-main.js 原位加注释
- [ ] 4. 在 index.html 插入 script 标签
- [ ] 5. 重启服务
- [ ] 6. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 发送消息 → Agent 回复后出现"编辑此轮"按钮 → 点击 → 确认 rollback/compact dialog 正常弹出
- [ ] 选择"回退到此轮"→ 确认消息回退正常
- [ ] 选择"从此处压缩"→ 确认 partial compact 状态显示 → 压缩完成后输入框恢复
- [ ] 点击 × 关闭 dialog → 确认输入框恢复

---

#### Phase A-7: recap-hint.js（离开摘要，已禁用）

| 属性 | 值 |
|------|-----|
| 来源行号 | L6339–6510 |
| 预估行数 | ~171 |
| 风险 | ★☆☆☆☆ |
| 拆出函数 | `_getRecapAgentAndSession`, `_maybeFetchRecap`, `_dismissRecap`, `_clearRecapForNewMessage`, `_renderRecapHint`, `_trackRecapSessionPresence` |
| 搬走的变量 | `RECAP_DISABLED`, `_recapLastSeenBySession`, `_recapShownForSession`, `_recapDismissedForSession`, `_currentRecapText`, `_recapFetchInFlight`, `_recapPendingTrigger`, `RECAP_AWAY_THRESHOLD_MS` |

> **注意**：`_currentRecapText` 和 `_recapPendingTrigger` 被 `updateNotificationStatus`（L5856–5858）和 `loadAgentData`（L5188–5189）读写。由于 `RECAP_DISABLED = true`，这些读写实际无副作用（所有函数入口提前返回），但仍需确保变量全局可见。

**执行前 grep 验证清单**：
- [ ] grep `_currentRecapText\b` — 确认被 updateNotificationStatus（L5856）、loadAgentData（L5188）读写
- [ ] grep `_recapPendingTrigger\b` — 确认被 updateNotificationStatus（L5856–5858）、loadAgentData（L5189）读写
- [ ] grep `_renderRecapHint\b` — 确认被 renderInputRequests（L6242）调用
- [ ] grep `_trackRecapSessionPresence\b` — 确认被 poll（L5798）调用
- [ ] grep `_clearRecapForNewMessage\b` — 确认被 submitQueuedInput（L6655）调用

**执行步骤**：
- [ ] 1. 创建 `public/src/modules/recap-hint.js`
- [ ] 2. 剪切函数和变量到新文件
- [ ] 3. 在 app-main.js 原位加注释
- [ ] 4. 在 index.html 插入 script 标签
- [ ] 5. 重启服务
- [ ] 6. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 确认无 JS 报错（所有函数因 RECAP_DISABLED 提前返回）
- [ ] 正常使用聊天功能不受影响

---

### Phase B: 中风险子系统提取

> **目标**：6 个有一定交叉依赖的子系统，合计 ~2,168 行
> **风险**：★★★☆☆
> **原则**：每个模块拆出前必须完成所有 grep 验证，特别注意被 poll() 和 renderInputRequests() 引用的变量和函数

---

#### Phase B-1: runtime-status.js（运行时状态/通知系统）

| 属性 | 值 |
|------|-----|
| 来源行号 | L113–638（域 AA）+ L5808–5998（域 Z） |
| 预估行数 | ~715 |
| 风险 | ★★★☆☆ |
| 合并理由 | 域 AA 是纯 helper 函数群，域 Z（updateNotificationStatus）是唯一消费者。合并后内聚度更高。 |

**搬走函数（域 AA）**：`buildSyntheticRuntimeEntry`, `buildChildRuntimeEntry`, `collectRuntimeEntriesForPrebuilt`, `isRuntimeCalling`, `resolveNotificationCallingState`, `normalizeNotificationRuntimeSnapshot`, `getRuntimeStageLabel`, `getCompactRuntimeLabel`, `formatRuntimeCompactNumber`, `formatRuntimeDuration`, `summarizeRuntimeToolNames`, `getPendingToolCallsFromMessages`, `getDerivedStageFromState`, `getNotificationActionSource`, `getEffectiveRuntimeSnapshot`, `getRuntimeSummary`, `getRuntimeTimerLabel`, `renderRuntimeTimer`, `refreshNotificationTimerDisplay`, `ensureNotificationClockTimer`, `getRuntimeStageClass`, `shouldShowRuntimeStatus`, `shouldStatusUseQueueSync`

**搬走函数（域 Z）**：`updateNotificationStatus`

**搬走变量**：`currentRuntimeConnected`, `lastNotificationStatusPayload`, `_runtimeStatusMemory`, `_lastRenderedNotificationRuntime`, `_notificationClockTimer`

> **⚠️ 关键变量**：
> - `currentRuntimeConnected` — 被 `loadAgentData`（L5177, L5296）、`poll`（L5527）、`refreshCurrentRuntimeStatus`（L5296）读写
> - `getInputSurfaceMode` — 被 `renderInputRequests`（L6024）调用。注意此函数被域 AB 使用，**不能随域 AA 一起搬走**，需保留在 app-main.js。
> - `ensureNotificationClockTimer()` — 在 L5116 被直接调用（顶层语句），拆出后需确认在模块文件顶层也执行此调用。
> - `isRuntimeCalling()` — 被 `_syncPersistentActionButton`（域 AC）、`interruptAgent`（域 AC）、`_tryNotifyAgentFinished`（modules/desktop-notify.js）、`_syncPersistentInputUi`（域 AC）等调用
> - `renderAgentList` — 被 `updateNotificationStatus` 调用，但此函数在域 M（app-main.js），不在本模块。调用方向是模块→main，加载顺序上模块在 main 之前，但因为是函数声明提升（function declaration hoisting），只要在调用时 main 已加载即可。

**执行前 grep 验证清单**：
- [ ] grep `currentRuntimeConnected\b` — 确认所有读写点（poll, loadAgentData, refreshCurrentRuntimeStatus, updateNotificationStatus）
- [ ] grep `isRuntimeCalling\b` — 确认被 _syncPersistentActionButton, interruptAgent, poll, tryAutoTitleGeneration 等调用
- [ ] grep `getInputSurfaceMode\b` — 确认被 renderInputRequests 调用（此函数保留在 main）
- [ ] grep `ensureNotificationClockTimer\b` — 确认在 L5116 被顶层调用
- [ ] grep `_runtimeStatusMemory\b` — 确认仅在域 AA 内部使用
- [ ] grep `lastNotificationStatusPayload\b` — 确认仅在域 Z 内部使用
- [ ] grep `_agentCallActive\b` — 确认被 updateNotificationStatus, interruptAgent, submitInput, submitInputAction, poll 读写（此变量定义在 app-core.js，不搬走）
- [ ] grep `_lastCallFinishTime\b` — 确认被 updateNotificationStatus 读写，也被域 AC 的 `_renderLastCallElapsed` 读写（协调归属）
- [ ] grep `_interruptSuppression\b` — 确认被 updateNotificationStatus, interruptAgent 读写（定义在 app-core.js）

**执行步骤**：
- [ ] 1. 完成所有 grep 验证
- [ ] 2. 确认 `getInputSurfaceMode` 保留在 app-main.js
- [ ] 3. 确认 `ensureNotificationClockTimer()` 顶层调用（L5116）移到模块文件尾部
- [ ] 4. 创建 `public/src/modules/runtime-status.js`
- [ ] 5. 剪切函数和变量到新文件
- [ ] 6. 在 app-main.js 原位加注释
- [ ] 7. 在 index.html 插入 script 标签（在 desktop-notify.js 之后，因为 updateNotificationStatus 调用 `_tryNotifyAgentFinished`）
- [ ] 8. 重启服务
- [ ] 9. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] Agent 运行时 → 状态栏正常显示（thinking/content/tool_calling 阶段标签）
- [ ] 计时器正常走时
- [ ] call.finish 后状态栏隐藏
- [ ] Agent 断开连接 → 状态栏显示 disconnected
- [ ] 多个 agent 并发 → 各自状态栏独立正常
- [ ] 中断按钮 → 点击后状态栏立即隐藏
- [ ] 通知时钟计时器正常（ensureNotificationClockTimer）

---

#### Phase B-2: ctx-menu-items.js（Context Menu 项构建）

| 属性 | 值 |
|------|-----|
| 来源行号 | L3181–3779 |
| 预估行数 | ~598 |
| 风险 | ★★★☆☆ |
| 拆出函数 | `getCtxMenuItems`（~500 行 switch）, `dispatchCtxAction` |

**依赖**：
- `window.closeCtxMenu`（modules/context-menu.js）
- `window.openBranchDialog`（modules/session-dialogs.js）
- `window.openTrimDialog`（modules/session-dialogs.js）
- `window.runWorkspaceAction`（app-main.js）
- `getCurrentAgentRecord`（app-main.js 域 L）
- `getWorkspaceSessions`（app-ui.js）
- `getSavedAssemblyConfigs`（app-main.js 域 Q）
- `getProgrammingHelperProjects`（modules/project-data.js）

**执行前 grep 验证清单**：
- [ ] grep `getCtxMenuItems\b` — 确认被 container.addEventListener('contextmenu')（L5012）调用
- [ ] grep `dispatchCtxAction\b` — 确认被 document.addEventListener('click')（L4862）调用
- [ ] grep `getRepoLocaleText\b` — 确认定义位置（可能在 app-core.js 或 app-ui.js）

**执行步骤**：
- [ ] 1. 创建 `public/src/modules/ctx-menu-items.js`
- [ ] 2. 剪切函数到新文件
- [ ] 3. 在 app-main.js 原位加注释
- [ ] 4. 在 index.html 插入 script 标签（在 context-menu.js 之后）
- [ ] 5. 重启服务
- [ ] 6. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 右键会话 → 确认菜单项正常显示
- [ ] 右键项目 → 确认菜单项正常
- [ ] 右键 Feature → 确认菜单项正常
- [ ] 点击菜单项 → 确认 dispatchCtxAction 正常分发
- [ ] 确认 trim / branch / compact 菜单项正常触发对应 dialog

---

#### Phase B-3: chat-scroll.js（滚动/Wheel 处理）

| 属性 | 值 |
|------|-----|
| 来源行号 | L4915–5117 |
| 预估行数 | ~202 |
| 风险 | ★★★☆☆ |
| 拆出函数 | `normalizeWheelDeltaY`, `canElementScrollVertically`, `hasScrollableWheelTarget`, `isChromeWithoutEdge`, `shouldUseManualWheelScroll`, `markChatPageResumed` |
| 搬走变量 | `chatScrollNeedsWheelRecovery`, `_stickyPadTop` |
| 事件绑定 | 7 个 `container.addEventListener`（wheel ×2, touchmove, pointerdown, keydown, scroll ×2）、`followLatestButton.addEventListener`、`document.addEventListener('visibilitychange')`、`window.addEventListener('focus'/'pageshow')` |

> **⚠️ 注意**：`container.addEventListener('contextmenu', ...)`（L5004–5057）与滚动无关，是右键菜单事件分发，**不要搬走**。只搬走 wheel/touchmove/pointerdown/keydown/scroll/visibilitychange/focus/pageshow 相关的监听器。

**执行前 grep 验证清单**：
- [ ] grep `chatScrollNeedsWheelRecovery\b` — 确认仅在域 W 内部使用
- [ ] grep `_stickyPadTop\b` — 确认仅在域 W 的 scroll 监听器内部使用
- [ ] grep `markChatPageResumed\b` — 确认被 visibilitychange/focus/pageshow 监听器调用
- [ ] grep `registerManualScrollIntent\b` — 确认来自 modules/chat-viewport.js
- [ ] grep `isChatSurfaceActive\b` — 确认来自 app-ui.js
- [ ] grep `shouldRenderWorkspaceSurface\b` — 确认来自 app-ui.js
- [ ] grep `updateAssemblySideRailPosition\b` — 确认来自 app-ui.js

**执行步骤**：
- [ ] 1. 创建 `public/src/modules/chat-scroll.js`
- [ ] 2. 剪切函数、变量和事件监听器到新文件（**排除 contextmenu 监听器**）
- [ ] 3. 在 app-main.js 原位加注释
- [ ] 4. 在 index.html 插入 script 标签（在 chat-viewport.js 之后）
- [ ] 5. 重启服务
- [ ] 6. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 聊天面板滚动 → 确认 follow latest 按钮正常切换
- [ ] 滚轮向上 → 确认 follow 取消
- [ ] 滚到底部 → 确认 follow 重新激活
- [ ] Chrome 浏览器切走再切回 → 确认 scroll recovery 正常
- [ ] PH 项目栏 sticky → 确认 pin/unpin 动画正常

---

#### Phase B-4: persistent-input.js（持久输入框/队列系统）

| 属性 | 值 |
|------|-----|
| 来源行号 | L6252–6725 |
| 预估行数 | ~473 |
| 风险 | ★★★☆☆ |
| 拆出函数 | `formatCallElapsed`, `_ensureInputMetaBar`, `_cleanupInputMetaBar`, `_renderLastCallElapsed`, `renderPersistentInput`, `onPersistentBtnClick`, `_setActionBtnStop`, `_setActionBtnSend`, `_syncPersistentActionButton`, `_renderQueueBubbles`, `_syncQueueFromBackend`, `handlePersistentInputKey`, `submitQueuedInput`, `updateQueueIndicator`, `_syncPersistentInputUi`, `interruptAgent` |
| 搬走变量 | `_pendingQueuedCount`, `_queuedTexts`, `_persistentUiSyncInFlight`, `_localQueuedInputPending`, `_lastQueueBubbleSignature`, `_callFinishTimerInterval` |
| 变量归属待定 | `_lastCallFinishTime`（被 updateNotificationStatus 也读写 — 建议保留在 main 或移到 app-core.js） |

> **⚠️ 关键交叉**：
> - `_lastCallFinishTime` 被 `updateNotificationStatus`（runtime-status.js）写入，被 `_renderLastCallElapsed`（本模块）读取。如果两者在不同模块，变量必须全局可见。建议保留在 app-main.js 或移到 app-core.js。
> - `_syncPersistentActionButton` 被 `updateNotificationStatus`、`renderInputRequests` 等调用。
> - `interruptAgent` 被 `onPersistentBtnClick` 调用，但也可能被其他地方调用。
> - `_syncPersistentInputUi` 被 `poll()`（L5670, L5727）和 `_syncQueueFromBackend` 调用。
> - `_syncQueueFromBackend` 被 `updateNotificationStatus`（L5891, L5963）调用。
> - `renderPersistentInput` 被 `renderInputRequests`（L6226）调用。

**执行前 grep 验证清单**：
- [ ] grep `_lastCallFinishTime\b` — 确认所有读写点
- [ ] grep `_callFinishTimerInterval\b` — 确认在 L6337 有顶层 `setInterval` 调用
- [ ] grep `_syncPersistentActionButton\b` — 确认被 updateNotificationStatus, loadAgentData 调用
- [ ] grep `_syncPersistentInputUi\b` — 确认被 poll 调用
- [ ] grep `_syncQueueFromBackend\b` — 确认被 updateNotificationStatus 调用
- [ ] grep `renderPersistentInput\b` — 确认被 renderInputRequests 调用
- [ ] grep `interruptAgent\b` — 确认所有调用点
- [ ] grep `submitQueuedInput\b` — 确认被 onPersistentBtnClick, handlePersistentInputKey, 语音 auto-send 调用
- [ ] grep `_clearRecapForNewMessage\b` — 确认被 submitQueuedInput（L6655）调用（方向：本模块→recap-hint.js）

**执行步骤**：
- [ ] 1. 完成所有 grep 验证
- [ ] 2. 确定 `_lastCallFinishTime` 归属（建议保留在 app-main.js 全局）
- [ ] 3. 确认 `_callFinishTimerInterval = setInterval(...)` 顶层调用（L6337）移到模块文件尾部
- [ ] 4. 创建 `public/src/modules/persistent-input.js`
- [ ] 5. 剪切函数和变量到新文件
- [ ] 6. 在 app-main.js 原位加注释
- [ ] 7. 在 index.html 插入 script 标签
- [ ] 8. 重启服务
- [ ] 9. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 常驻输入框正常显示
- [ ] 输入文本 → Enter 发送 → 消息正常提交
- [ ] Agent 运行中 → 发送按钮变为 stop 图标
- [ ] 点击 stop → 确认中断正常
- [ ] Agent 运行中发送消息 → 确认排队气泡显示
- [ ] 队列消息被消费后 → 气泡消失
- [ ] 上次对话结束时间显示 → 确认计时正常
- [ ] Ctrl+Enter / Shift+Enter → 确认换行正常

---

#### Phase B-5: input-helpers.js（Rollback/Process/Submit 辅助）

| 属性 | 值 |
|------|-----|
| 来源行号 | L7048–7318 |
| 预估行数 | ~270 |
| 风险 | ★★★☆☆ |
| 拆出函数 | `syncRollbackActionButtons`, `updateRollbackActionVisibility`, `autoResize`, `handleInputKey`, `submitInput`, `getPrimaryInputRequest`, `requestSupportsAction`, `getRollbackInputRequest`, `getAvailableCallIndices`, `canRollbackMessage`, `saveChatProcessVisibility`, `hasConversationProcessContent`, `updateChatProcessToggle`, `syncAssistantProcessOnlyRows`, `applyConversationProcessState` |
| window 函数 | `toggleChatProcessVisibility`, `submitInputAction` |

> **⚠️ 注意**：
> - `autoResize` 被 HTML `oninput="autoResize(this)"` 引用（renderInputRequests 和 renderPersistentInput 中的模板），也被语音模块调用。必须保持全局可见。
> - `handleInputKey` 被 HTML `onkeydown="handleInputKey(event, '...')"` 引用。
> - `submitInput` 被 HTML `onclick="submitInput('...')"` 引用，也被语音 auto-send 调用。
> - `submitInputAction` 被 HTML `onclick="submitInputAction('...','...')"` 引用，也被 rollback-dialog.js 调用。
> - `canRollbackMessage` 被 `renderMessage`/`render`（域 AG）和 `syncRollbackActionButtons` 调用。
> - `applyConversationProcessState` 被 `appendNewMessages`、`updateLastMessage`、`render`（域 AG）调用。

**执行前 grep 验证清单**：
- [ ] grep `autoResize\b` — 确认被 HTML onclick、语音模块、persistent-input 调用
- [ ] grep `submitInput\b` — 确认被 HTML onclick、语音 auto-send 调用
- [ ] grep `submitInputAction\b` — 确认被 HTML onclick、rollback-dialog 调用
- [ ] grep `canRollbackMessage\b` — 确认被 renderMessage/render、syncRollbackActionButtons 调用
- [ ] grep `applyConversationProcessState\b` — 确认被 appendNewMessages/updateLastMessage/render 调用
- [ ] grep `updateRollbackActionVisibility\b` — 确认被 render/appendNewMessages/updateLastMessage/poll 调用
- [ ] grep `saveChatProcessVisibility\b` — 确认 `CHAT_PROCESS_VISIBILITY_KEY` 和 `showChatProcess` 定义位置

**执行步骤**：
- [ ] 1. 完成所有 grep 验证
- [ ] 2. 创建 `public/src/modules/input-helpers.js`
- [ ] 3. 剪切函数到新文件
- [ ] 4. 在 app-main.js 原位加注释
- [ ] 5. 在 index.html 插入 script 标签
- [ ] 6. 重启服务
- [ ] 7. 验证

**验证清单**：
- [ ] 页面正常加载
- [ ] 输入框 autoResize → 多行输入时高度自适应
- [ ] "编辑此轮"按钮 → 仅在有 rollback request 时显示
- [ ] 显示/隐藏过程 → 按钮正常切换
- [ ] 提交 input request action → 正常
- [ ] 提交后乐观清空 → renderInputRequests 正常恢复

---

### Phase C: Assembly 操作提取（已完成）

> **目标**：将 assembly 相关操作从 app-main.js 拆出
> **风险**：★★★★☆
> **状态**：✅ 已完成（2026-07-04，commit 33b6ca6）

**已拆出模块**：`assembly-actions.js`（域 P + Q，1,080 行）

模块文件位于 `public/src/modules/assembly-actions.js`，包含全部 24 个目标函数（域 P 3 个 + 域 Q 21 个）。

交叉调用链已按预期变为：`assembly-data.js ← assembly-actions.js ← app-main.js`。
app-main.js 中仅保留调用站点（`window.launchAssemblyInstance()` 等），函数定义已全部移除。
注释标记位于 app-main.js L1994 和 L2040。

---

### Phase D: 聊天渲染提取（高风险）

> **目标**：将聊天消息渲染拆出
> **风险**：★★★★☆
> **前提**：Phase A-B-C 已全部完成

**待拆模块**：`chat-renderer.js`（域 AG，~672 行）

**关键耦合**：
- `render(currentMessages)` 被 app-ui.js 的 `renderCurrentMainView()` 直接调用（app-ui.js L3348）
- `appendNewMessages` / `updateLastMessage` 被 `poll()` 调用
- 依赖 modules/markdown-utils.js 的全部渲染函数
- 依赖域 AE 的 `canRollbackMessage`、`applyConversationProcessState`

**此 Phase 的复杂度在于 `render()` 被跨文件调用（app-ui.js → chat-renderer.js），需要确保加载顺序正确。建议最后执行。**

**此 Phase 在前面所有 Phase 完成后再启动。暂不细化执行清单。**

---

### Phase E: 不拆的域（永久保留在 app-main.js）

以下域是 app-main.js 的「不可压缩内核」，建议永久保留：

| 域 | 行数 | 保留理由 |
|-----|------|---------|
| 域 L: Agent 身份辅助 | ~112 | 纯函数基础设施，被所有域读取 |
| 域 M: Sidebar/AgentList | ~500 | `loadAgents` 是双向耦合枢纽（被 app-ui.js 调用） |
| 域 N: Agent 点击/PH 搜索 | ~357 | session 切换入口 |
| 域 O: runWorkspaceAction | ~647 | workspace 操作总路由（巨型 switch） |
| 域 T: 全局事件监听器 | ~525 | 全局胶水代码，每个监听器直接操作全局状态 |
| 域 U: Session Switch | ~141 | `switchAgent` 是系统核心 |
| 域 X: poll 主循环 | ~688 | 系统心跳 |
| 域 AB: renderInputRequests | ~251 | 多子系统聚合分发器 |
| 域 AJ: Bootstrap | ~13 | 应用启动入口 |
| **合计保留** | **~3,234** | |

Phase A-D 完成后，app-main.js 预估降至 **~4,700–5,000 行**（保留域 + 未归类的零散代码）。

---

## 五、标准操作流程（SOP）

> 每个模块拆分时，严格按照以下步骤执行。

### 5.1 拆分前

1. **阅读本计划中对应 Phase 的完整内容**
2. **执行该 Phase 的「执行前 grep 验证清单」**，所有项打勾
3. **确认行号仍准确**（如果之前有其他拆分导致行号偏移，用 grep 重新定位）
4. **确认 `?v=` 版本号策略**：使用 `Date.now()` 整数

### 5.2 拆分中

5. **创建模块文件**，写入文件头注释（依赖标注）
6. **从 app-main.js 剪切**（不是复制）函数和变量到新文件
7. **在 app-main.js 原位加注释**：`// <函数名/域描述> → modules/xxx.js`
8. **在 index.html 正确位置插入 `<script>` 标签**
9. **更新 `?v=` 版本号**

### 5.3 拆分后

10. **重启 Claw 服务**（`npm start` 或重启进程）
11. **打开 F12 Console**，确认无 JS 报错
12. **执行该 Phase 的「验证清单」**，所有项打勾
13. **git commit**（建议每个模块一个 commit）

### 5.4 回滚

如果验证失败：
1. **git revert** 对应的 commit
2. **分析失败原因**，记录到本计划的「执行记录」表中
3. **修正后重试**

---

## 六、共享变量归属决策表

以下变量被多个域读写，需要明确归属：

| 变量 | 当前位置 | 读写方 | 建议归属 | 理由 |
|------|---------|--------|---------|------|
| `_agentCallActive` | app-core.js | runtime-status, persistent-input, poll, submitInput, interruptAgent | **保留 app-core.js** | 已在全局基础层 |
| `_interruptSuppression` | app-core.js | runtime-status, persistent-input | **保留 app-core.js** | 已在全局基础层 |
| `currentRuntimeConnected` | app-main.js L689 | runtime-status, poll, loadAgentData | **移到 runtime-status.js** | 主要消费者 |
| `_lastCallFinishTime` | app-main.js L6261 | runtime-status (写), persistent-input (读写) | **保留 app-main.js** | 双向依赖，全局可见即可 |
| `_partialCompactInFlight` | app-main.js L7320 | rollback-dialog (写), poll (读), renderInputRequests (读) | **移到 rollback-dialog.js** | 全局可见 |
| `_rollbackDialogOpen` | app-main.js L7325 | rollback-dialog (写), renderInputRequests (读) | **移到 rollback-dialog.js** | 全局可见 |
| `_voiceRecording` / `_voiceTranscribing` | app-main.js L8157-8158 | voice-input (读写), renderInputRequests (读), persistent-input (读) | **移到 voice-input.js** | 全局可见 |
| `_sessionInputCache` | app-main.js L8167 | voice-input (读写), persistent-input/submitQueuedInput (读写), submitInput (读写) | **移到 voice-input.js** | 全局可见 |
| `_currentRecapText` / `_recapPendingTrigger` | app-main.js L6348-6350 | recap-hint (读写), runtime-status (读写), loadAgentData (写) | **移到 recap-hint.js** | 全局可见 |
| `choiceInputState` | app-core.js | choice-input (读写) | **保留 app-core.js** | 已在全局基础层 |
| `lastRenderedInputSignature` | app-core.js | renderInputRequests, choice-input, persistent-input, rollback-dialog | **保留 app-core.js** | 多模块共享的去重签名 |
| `_autoTitleTriggered` | 待确认 | auto-title | **移到 auto-title.js** | 仅 auto-title 使用 |
| `_seenChoiceAlertIds` / `_lastChoiceAlertCheckAt` | 待确认 | auto-title (checkGlobalChoiceAlerts), poll | **移到 auto-title.js** | 仅 auto-title 使用 |

> **核心原则**：在 `<script>` 标签加载模式下，所有顶层 `let/const/var` 和 `function` 声明都在全局作用域。只要变量不在 IIFE 或函数内部，拆到哪个文件不影响全局可见性。归属决策的主要依据是**内聚性**（变量与操作它的函数放在一起）。

---

## 七、风险与缓解策略

### 风险 1：函数声明提升 vs 加载顺序

**问题**：`function foo() {}` 声明在文件加载时即提升到全局作用域顶部。但如果 app-main.js 中的顶层代码在加载时直接调用模块中的函数（如 `ensureNotificationClockTimer()` 在 L5116），模块必须在 app-main.js 之前加载。

**缓解**：
- 所有新模块在 index.html 中排在 app-main.js 之前
- app-main.js 中的顶层调用（非函数声明内的调用）需检查目标函数是否已加载
- 已知的顶层调用：`ensureNotificationClockTimer()`（L5116）、`_callFinishTimerInterval = setInterval(...)`（L6337）、`applyTheme(currentTheme)`（L8504）、bootstrap IIFE（L8507）

### 风险 2：变量重复定义

**问题**：如果同一个变量名在 app-main.js 和新模块中都有 `let` 声明，会导致 SyntaxError（Identifier has already been declared）。

**缓解**：
- 每次搬走变量时，**确认 app-main.js 中没有残留的同名声明**
- 搬走后在 app-main.js 中 grep 确认：`grep 'let _voiceRecording'` 应无结果

### 风险 3：HTML onclick 找不到全局函数

**问题**：HTML 模板中的 `onclick="window.xxx()"` 或 `onclick="xxx()"` 要求函数在全局注册。

**缓解**：
- 所有 `window.xxx = function` 挂载的函数，搬走后仍用 `window.xxx = function` 定义
- 所有直接 `function xxx()` 声明的函数，在 `<script>` 标签模式下自动全局可见
- 拆出后刷新页面，F12 Console 输入函数名确认可访问

### 风险 4：顶层 setInterval / 顶层函数调用丢失

**问题**：如 `_callFinishTimerInterval = setInterval(_renderLastCallElapsed, 1000);`（L6337）是顶层语句，如果遗漏搬走，计时器不会启动。

**缓解**：
- SOP 步骤 6 强调「剪切」而非「复制」
- 搬走后 grep `setInterval` 确认没有遗漏
- 验证清单中包含计时器功能验证

### 风险 5：contextmenu 事件监听器误拆

**问题**：`container.addEventListener('contextmenu', ...)`（L5004–5057）混在滚动相关监听器之间，但其内容是右键菜单分发（调用 `getCtxMenuItems`），与滚动无关。

**缓解**：
- Phase B-3 明确标注「排除 contextmenu 监听器」
- 拆分时按事件类型精确切割，不按行号范围粗略搬移

---

## 八、执行跟踪表

> 每个模块完成时在此表中更新状态。日期格式 YYYY-MM-DD。

| Phase | 模块 | 预估行数 | 实际行数 | 风险 | 状态 | 完成日期 | app-main.js 拆后行数 |
|-------|------|---------|---------|------|------|---------|---------------------|
| A-1 | voice-input.js | ~347 | 456 | ★☆☆☆☆ | ✅ 完成 | 2026-07-10 | |
| A-2 | choice-input.js | ~273 | 305 | ★☆☆☆☆ | ✅ 完成 | 2026-07-03 | |
| A-3 | auto-title.js | ~188 | 415 | ★☆☆☆☆ | ✅ 完成 | 2026-07-11 | |
| A-4 | ph-project-actions.js | ~272 | 301 | ★★☆☆☆ | ✅ 完成 | 2026-07-03 | |
| A-5 | external-runtime.js | ~148 | 164 | ★★☆☆☆ | ✅ 完成 | 2026-07-03 | |
| A-6 | rollback-dialog.js | ~159 | 188 | ★★☆☆☆ | ✅ 完成 | 2026-07-03 | |
| A-7 | recap-hint.js | ~171 | 201 | ★☆☆☆☆ | ✅ 完成 | 2026-07-03 | |
| B-1 | runtime-status.js | ~715 | 836 | ★★★☆☆ | ✅ 完成 | 2026-07-12 | |
| B-2 | ctx-menu-items.js | ~598 | 875 | ★★★☆☆ | ✅ 完成 | 2026-07-11 | |
| B-3 | chat-scroll.js | ~202 | 169 | ★★★☆☆ | ✅ 完成 | 2026-07-04 | |
| B-4 | persistent-input.js | ~473 | 562 | ★★★☆☆ | ✅ 完成 | 2026-07-10 | |
| B-5 | input-helpers.js | ~270 | 355 | ★★★☆☆ | ✅ 完成 | 2026-07-07 | |
| C | assembly-actions.js | ~1,081 | 1,080 | ★★★★☆ | ✅ 完成 | 2026-07-04 | |
| D | chat-renderer.js | ~672 | 800 | ★★★★☆ | ✅ 完成 | 2026-07-09 | |
| S+A3 | workspace-actions.js（runWorkspaceAction 分发器） | ~620 | 820 | ★★★★☆ | ✅ 完成 | 2026-07-13 | |
| E1 | ctx-menu-handlers.js | ~670 | 670 | ★★★☆☆ | ✅ 完成 | 2026-07-23 | |
| E2 | sidebar-render.js | ~703 | 703 | ★★★★☆ | ✅ 完成 | 2026-07-23 | |
| E3 | workspace-docset.js（增补） | — | +102 | ★★☆☆☆ | ✅ 完成 | 2026-07-23 | |
| E4 | agent-data-loader.js / debug-logs.js / debug-mcp.js | ~250 | 192+37+21 | ★★☆☆☆ | ✅ 完成 | 2026-07-23 | |
| E5 | input-render.js | ~267 | 267 | ★★★☆☆ | ✅ 完成 | 2026-07-23 | |

**起始行数**：8,517（2026-07-03）
**Phase A–D 完成后**：3,647（2026-07-12）
**E 系列完成后（commit a406168）**：1,219（2026-07-23）
**收口现状**：~1,270（2026-08-23 复核；后续功能迭代小幅回涨属正常，见「十二、收口复核」）
**Phase C 已完成**：assembly-actions.js（1,080 行）已于 2026-07-04 提取，commit 33b6ca6。app-main.js 当前 3,647 行已包含 Phase C 的成果——拆分发生在 Phase A/B 之前，后续 Phase A/B/D 的行数统计已基于 Phase C 完成后的基线。

> 实际行数会因注释行、空行、行号偏移等与预估略有差异。每次拆完后以 `wc -l` 为准。

---

## 九、与 v1 计划和 app-ui v2 计划的关系

### 9.1 本计划 vs v1（2026-06-04）

| 项 | v1 | 本计划 | 原因 |
|----|-----|--------|------|
| app-main.js 行数 | 6,936 | 8,517 | 新增功能直接堆入 main |
| 已拆出模块 | 0（针对 main） | 0 | v1 从未执行 main 的拆分 |
| 功能域分析 | 13 个域 (L–Y) | 22 个域 (L–AJ) | 新增 9 个功能域 |
| 新增域 | — | AA/AB/AC/AD/AE/AF/AG/AH/AI | 运行时状态、输入系统、语音、choice、recap 等 |
| 拆分策略 | 与 app-ui 混合描述 | **独立计划，仅针对 main** | app-ui 拆分已独立成 v2 |

### 9.2 本计划 vs app-ui v2（2026-06-29）

| 项 | app-ui v2 | 本计划 |
|----|-----------|--------|
| 目标文件 | app-ui.js（9,871 → 3,977） | app-main.js（8,517 → ~3,000–5,000） |
| 已完成 | Phase 1–2f（24 个模块） | 无 |
| 待执行 | Phase 3a–3d | Phase A–D |
| 交叉协调 | Phase 3b (assembly-data) | Phase C (assembly-actions) 需等 3b 完成 |

### 9.3 协调点

**Assembly 拆分协调**：
- app-ui.js v2 Phase 3b 拆出 `assembly-data.js`（域 C 数据层）
- 本计划 Phase C 拆出 `assembly-actions.js`（域 P+Q 操作层）
- 建议**先执行 v2 Phase 3b**，再执行本计划 Phase C
- 两者完成后，assembly 相关调用链变为：`assembly-data.js ← assembly-actions.js ← app-main.js`

---

## 十、附录

### 10.1 全局状态变量速查（定义在 app-core.js）

以下变量被 app-main.js 和各模块广泛读写，**不在本计划范围内搬移**：

```
allAgents, currentAgentId, currentRuntimeAgentId, currentMessages,
currentInputRequests, currentLanguage, _agentCallActive,
currentOverviewSnapshot, currentOverviewSignature, currentLogs,
currentLogsSignature, currentHookInspector, currentHookInspectorSignature,
currentTodoPlan, currentTodoPlanSignature, toolRenderConfigs, TOOL_NAMES,
FEATURE_TEMPLATE_MAP, _userExpandedReasoning, _userExpandedMsgs, _userCollapsedMsgs,
_lastRenderedChatSig, showChatProcess, readOnlyMode, suppressSidebarRerender,
followLatestEnabled, lastRenderedInputSignature, lastRenderedInputMode,
choiceInputState, _interruptSuppression, INTERRUPT_SUPPRESSION_MS,
loadedAgentDetailIds, prebuiltSessionSwitchInFlight
```

### 10.2 已有 modules/ 目录清单（24 个，截至 2026-07-03）

| 模块 | 行数 | 来源 |
|------|------|------|
| chat-context-bar.js | 531 | app-ui 域 C |
| chat-viewport.js | 516 | app-ui 域 N |
| context-menu.js | 153 | app-ui 域 P |
| debug-panels.js | 1,425 | app-ui 域 K-b+L |
| desktop-notify.js | 127 | 新增 |
| dispatch-actions.js | 438 | app-main 域 U (v1) |
| dispatch-ui.js | 547 | app-ui 域 I |
| feature-config.js | 784 | app-ui 域 H |
| feature-setup-ui.js | 517 | 独立页面 |
| im-actions.js | 502 | app-main 域 T (v1) |
| im-ui.js | 751 | app-ui 域 H |
| markdown-utils.js | 160 | app-ui 域 O-a |
| overview-data.js | 189 | app-ui 域 K-a |
| ph-model-config.js | 125 | app-ui 域 D |
| project-data.js | 382 | app-ui 域 F |
| resources-viewer.js | 460 | app-ui 域 M |
| session-dialogs.js | 390 | app-main 域 R (v1) |
| session-ui.js | 876 | app-ui 域 F |
| settings-overlay.js | 1,529 | app-ui 域 I |
| template-engine.js | 374 | app-ui 域 O-b |
| theme-lang.js | 95 | app-ui 域 O-c |
| toast-notify.js | 485 | 新增 |
| work-group-ui.js | 4,289 | 群聊工作空间 |
| workspace-docset.js | 575 | app-ui 域 Q |
| **合计** | **24,737** | |

### 10.3 模块文件头注释模板

每个新模块文件的第一行使用此模板：

```js
/**
 * <模块名>.js — <简述>
 * 从 app-main.js 拆出（Phase <X-Y>）
 * 拆出日期：YYYY-MM-DD
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   <变量名>, <变量名>
 * 依赖全局函数:
 *   <函数名> (<来源文件>)
 *   <函数名> (<来源文件>)
 * 导出全局函数:
 *   <函数名>, <函数名>
 * 导出全局变量:
 *   <变量名>, <变量名>
 * HTML onclick 引用:
 *   onclick="<函数名>(...)"
 */
```

### 10.4 app-main.js 原位注释模板

每次从 app-main.js 搬走函数后，在原位加注释：

```js
// ── <域描述> → modules/<模块名>.js (Phase <X-Y>, YYYY-MM-DD) ──
```

如果搬走的是单个函数：

```js
// <函数名> → modules/<模块名>.js
```

---

## 十一、执行记录（每次拆分后补充）

> 每次完成一个 Phase 后，在此记录实际情况。

### Phase A-1: voice-input.js

| 项 | 计划 | 实际 |
|----|------|------|
| 行数 | ~347 | |
| 拆出函数数 | 14 | |
| 搬走变量数 | 11 | |
| app-main.js 拆后行数 | | |
| grep 验证项 | 6 项 | |
| 验证清单项 | 6 项 | |
| 遇到的问题 | | |
| 备注 | | |

<!-- 后续 Phase 按此格式补充 -->

---

## 十二、收口复核（2026-08-23）

### 12.1 最终状态

| 阶段 | 日期 | 行数 |
|------|------|------|
| 计划创建基线 | 2026-07-03 | 8,517 |
| Phase A–D 完成 | 2026-07-12 | 3,647 |
| E 系列完成（commit a406168） | 2026-07-23 | 1,219 |
| 功能迭代小幅回涨 | 2026-08-23 | 1,271 |

v1 目标"瘦身至 ~1,500 行"已达成。**拆分结束，不再继续。**

### 12.2 剩余内容清单（不可压缩内核）

| 块 | 行数 | 内容 |
|----|------|------|
| Agent 身份辅助 | ~148 | `normalizeAgentIdentity`、`getCurrentHostAgentRecord/RuntimeRecord`、`isAgentActive`、`groupConnectedAgents` 等（域 L，计划明确保留） |
| 会话导航入口 | ~200 | `handlePrebuiltAgentClick`、`navigateToWorkspaceSession`、`runWorkspaceActionFromEvent` + 事件委托监听、`showCompactMenu`、loading 标记三件套 |
| 会话创建/压缩续接 | ~170 | `openPrebuiltWorkspaceSession`、`applyOptimisticWorkspaceSession`、`createCompactedResumeSession` |
| 切换核心 | ~190 | `requestSwitch` / `flushPendingSwitch` / `switchAgent`（域 U） |
| Poll 主循环 | ~480 | `schedulePoll` / `poll` / `runPollCycle`（域 X） |
| 杂项 | ~35 | `_getSessionInputCacheKey`（多域共享，计划明确保留） |
| Bootstrap | ~30 | `applyTheme`/`applyLanguage`、visibilitychange 监听、启动 IIFE（域 AJ） |

### 12.3 结论与可选后续

- 剩余内容即各 Phase 计划中标注"永久保留在 main"的域（L/U/X/AJ + 导航入口），边界已最干净，不再拆分。
- 可选后续（暂不建议主动做）：
  - poll 主循环拆出为 `modules/polling.js` 可将 main 降到 ~790 行，但系统心跳与几乎所有域有交互，跨文件后调试链路变长，收益/成本比不佳。历次计划均将 poll 视为不可压缩核心，维持现状。
  - `runPollCycle` 内有两段近似重复的"workspace session 增量刷新"块（无 runtime 分支 ~45 行、有 runtime 分支 ~62 行），下次触碰该区域时可顺手合并为单一 helper。属于行为等价重构，需按 `docs/frontend-rendering-patterns.md` 的渲染契约验证。

### 12.4 风险点交棒

app-main.js 不再是前端膨胀风险。当前最大的待拆分文件（悬置域按约定不投入）：

| 文件 | 行数 | 判断 |
|------|------|------|
| `modules/work-group-ui.js` | 4,364 | 工作群（★ Beta）前端主体，最优先拆分候选 |
| `modules/wg-core.js` | 3,035 | 工作群核心，与上者同域统筹拆分 |
| `local-features/agent-studio/src/index.ts` | 2,116 | 活跃域单文件，拆分候选 |
| `app-core.js` | 1,996 | 共享全局状态堆积（6 月 1,317 行 → +51%），新增状态时约束，`ClawState` 集中化是独立工作项 |
| `modules/runtime-status.js` / `model-settings.js` / `persistent-input.js` | 1,385 / 1,360 / 1,291 | 拆出后的回涨式增长（B-1 拆出时 836 行、B-4 拆出时 562 行），关注趋势即可 |

---

*本计划由调研 agent 于 2026-07-03 创建。执行 agent 请在完成每个 Phase 后更新执行跟踪表和执行记录。*
