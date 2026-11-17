# 前端 ESM P2 交付与保留边界

日期：2026-11-17。范围：ADR-0051、迁移计划 §P2。业务迁移已完成；全量测试存在下述既有失败，不声明全量绿。P3 未实施。

## 交付内容

- 活跃域消费方原位转为原生 ESM，以命名导入调用已迁能力；模块私有状态不再借宿 `ClawFW`。项目、会话操作、装配、设置、菜单、输入交互、消息呈现、SSE、调试可迁部分均进入生产模块图。
- `kernel-entry.js → p2-entry.js` 汇合生产入口，移除已迁文件的 classic 标签；不引入构建器，不修改后端、CSS、悬置域与插件协议。
- 测试迁移到真实 classic 宿主链与逐用例隔离的真实 ESM 图；不通过剥除 import/export 或重新发布退役顶层函数来迁就测试。
- 缓存、目录设置、选择卡草稿等零外部消费状态私有化。仅模块消费的桥即时注销；最后收口注销十条桥，命名导出保留。

## 保留的唯一同步实现

这不是“全部文件均已 ESM 化”。以下边界由原有同步调用或事件时点决定，保留唯一实现，不加 ready 队列、空守卫、第二实例或放行后补画：

| 范围 | 原行为及保留原因 |
|---|---|
| app-core / app-ui / app-main、markdown bootstrap、身份与视图同步部分 | 首屏 `applyLanguage → renderCurrentMainView` 仍同步执行；保留初始化、引用身份与原时点 |
| chat-viewport / chat-scroll、输入渲染与输入辅助薄壳、voice / persistent input | 首屏调用与 focus / visibility 监听可能先于模块执行；状态 owner 与可迁交互已经拆入 ESM |
| debug-logs / debug-features-hooks、日志写入入口 | 模块下载期间 rail 按钮已可点击，必须能立即渲染；overview / MCP / preflight 进入 ESM |
| thread-store 刷新引擎 | 保留原 2s 启动、20s 周期、visibilitychange 与 finally 指示器；交互主体由 thread-store-domain 提供 |
| 调用状态与中断抑制引擎 | 前台事件在模块执行前真实可达；唯一实现保留于 app-main。ESM 经窄宿主面复用，不重复构建实例 |
| desktop-open / desktop-notify、后台任务及面板同步注册 | 外部唤起和早期事件入口不延后；不改已有一次性入口或面板协议 |

完整 classic 清单以 `public/index.html` 为准，兼容面消费依据以各 owner / bootstrap 文件头注为准。P3 再处理同步壳与剩余全局协议，不把这些边界计作整域 ESM 完成。

## 度量与基线审批

本次对比基点为 `c3e18d71`，不是计划最初的快照。静态全局台账、静态桥调用点和真实页面桥键是不同量纲，不能相加减或互相替代。

| 指标 | 基点 | 本次 | 说明 |
|---|---:|---:|---|
| 全局台账 state | 733 | 413 | 净减少 320 |
| 全局台账 behavior | 2143 | 973 | 净减少 1170；同步工厂等新增行为同样入账 |
| 全局台账有条目的文件 | 129 | 72 | 包含悬置域和静态扫描识别出的全局赋值 |
| script-tags gate 的 src 标签总数 | 146 | 69 | 包含已登记 module 标签，非业务模块数量 |
| 静态 defineKey 调用点 | 109 | 261 | **上调 152**，不是减债；循环体一次调用注册多个键 |
| 静态 claim 调用点 | 33 | 87 | **上调 54**，不是已认领键数 |
| 真实页面注册 / 认领键 | 未重新测基点 | 336 / 330 | Chromium 实测，访问器数 336；6 个键属于保留的同步引擎，无需 ESM 再认领 |
| inline-events gate | 11 | 11 | 无新增；两处注释误计已修正文案，基线未增加 |

主助手批准本次桥基线建立增量，依据是逐域 owner 头注、真实消费面审计及浏览器验证，而非单凭当前总数。迁移消费方本身又成为旧壳消费的提供方，因而本阶段仍需新建兼容桥；台账下降不等于全局依赖清零。已无消费的本次十键已先注销，不计入批准的保留面。

### 新增桥保留依据（按域列键）

以下逐键清单来自消费面审计；同一行键共享所列消费面类别。具体读写与初始化契约见相应域文件头注。classic 与内联模板仍需桥，ESM import 本身不构成保桥理由。

| 域 | 保留键 | 消费面 |
|---|---|---|
| app-chat-input / app-info | AppChatInput；renderBrandCard | app-ui / voice-input；theme-lang |
| assembly-actions | updateWorkspaceFormDraft, toggleWorkspaceSelection, createAssemblyEnvironment, launchAssemblyInstance, switchAssemblyEditingTarget, toggleAssemblyControlPanel, jumpAssemblyStage, fwLaunchConfig, fwResumeRun, stopAssemblySessionRuntime, chooseWorkspaceDirectory, getSavedAssemblyConfigs | app-ui 与原装配模板 |
| assembly-data | isAssemblySession, isAssemblySessionRunning, getAssemblySessionStatus, normalizeAssemblyDraft, getAssemblyDisplayName, getAssemblyEnvironmentState, getAssemblyEnvironmentStatusLabel, getAssemblyEnvironmentStatusTone, renderAssemblyStatusChip, getAssemblySavedConfigSummary, getAssemblyEditorMode, getWorkspaceFormDraft, updateAssemblyDraftField, commitAssemblyDraftField, toggleAssemblyStage | app-ui、flow-editor 及旧模板 |
| auto-title | markAutoTitleCandidate, findFirstChangedMessageIndex, tryAutoTitleGeneration, checkGlobalChoiceAlerts | app-main 动作与旧调用链 |
| chat-process-visibility | applyConversationProcessState, toggleChatProcessVisibility | chat-renderer / app-ui |
| chat-row-visibility | refreshMeasuredChatRows, revealMeasuredChatRow | chat-viewport / chat-renderer |
| choice-input | isChoiceInputRequest, isChoiceInputConsumed, getChoiceInteractionSignature, renderChoiceInputRequest | input-render / input-composer |
| context-menu / ctx-menu-handlers / ctx-menu-items | closeAgentContextMenu, closeProjectContextMenu, closeCompactMenu, openCompactMenu；openAgentActions；getCtxMenuItems, dispatchCtxAction | app-main、sidebar-render 与菜单入口 |
| conversation-export-dialog | openConversationExportDialog | app-main 动作 |
| debug-mcp / debug-overview / debug-preflight | renderMcpPanel, loadMcpInfo；renderStructurePanel, renderMonitorPanel, openFeatureDetails, closeFeatureDetails, openRepositoryPackageDetails；renderPreflightPanel | app-ui 面板与详情动作 |
| external-runtime | refreshSidebarRuntimeAfterMutation | 旧 runtime 管理入口 |
| feature-config / feature-store | renderFWFeatureSettings；clawOpenPluginManager | app-ui / 设置入口 |
| fw-config-panel | fwSwitchSection, fwOpenPromptEditor, fwOpenProjectPicker, fwBackToList, fwToggleFeature, fwSetFeatureFilter, fwOpenFeatureImport, fwSetFeatureQuery, fwCommitFeatureQuery, fwGetFeatureQuery, fwRerender, fwCreateNewAgent, fwOpenProjectDetail, renderProjectListBlock, renderFWCreateDialog, renderFWConfirmDialog, renderFWPromptDialog, renderFWSwitchProjectDialog, renderFWFeatureImportDialog | app-ui block、弹窗与动作分发 |
| generative-ui-renderer | renderGenUISpec, createGenUIViewState | generative-ui-panel |
| input-actions | updateRollbackActionVisibility, canRollbackMessage, autoResize | app-main、chat-renderer、同步输入薄壳 |
| input-call-elapsed / input-composer | _lastCallFinishTime；_sessionInputCache | persistent-input、input-render |
| input-model-switcher | updateInputModelSwitcher, updateThinkingEffortSwitcher, toggleInputModelDropdown, toggleThinkingEffortDropdown | persistent-input / 输入控件动作 |
| input-queue | _renderQueueBubbles, updateQueueIndicator, _syncQueueFromBackend, _syncPersistentInputUi, _pendingQueuedCount, _queuedTexts, _localQueuedInputPending, _lastQueueBubbleSignature, _queuedProjectionRuntimeId | persistent-input / app-main |
| lazy-tool-content | clearProcessDistance, freezeProcessWindowing, unfreezeProcessWindowing, runLandingCollapseScan, setProcessWindowingDisabled | chat-renderer / chat-viewport |
| mcp-gateway-ui | openMcpGateway | app-main 动作 |
| message-timeline | attachMessagesTimestamps, resolveEchoTimeSeparator, formatChatTimestamp, renderTimeSeparatorHtml, prependTimeSeparatorHtml | chat-renderer |
| model-preset-cache | getClawModelPresets, setClawModelPresets, ensureClawModelPresets | app-ui 与 memo 插件现有 window 协议 |
| model-settings | openSettings, closeSettings, renderSettingsOverlay | app-main / app-ui |
| overview-data | shortenSourcePath, getHookInspectorSignature, getEmptyOverviewSnapshot, extractMessagesProbe, normalizeOverviewSnapshot, getOverviewSignature, normalizeHookInspector, setCurrentHookInspector, setCurrentOverviewSnapshot | debug-features-hooks / app-main / 同步视图链 |
| ph-project-actions / ph-session-list | phOpenProjectDirectory, phSwitchProject, phLoadProjectSessions, phSetupLoadMoreAutoScroll；applyPhSessionTabDom | app-main、sidebar-render |
| project-data | getPathLeaf, resolveSidebarChildProjectGroup, ensurePhProjectEntitiesLoaded, getPhBrowsingTarget, getPhSessionOwnershipParams, canEnterWorkspaceChat, getAgentWorkspaceState, updateAgentRecord | sidebar-render / app-ui / app-main |
| proxy-overlay / remote-claw-settings | openProxySettings；openRemoteClawSettings | app-main 设置入口 |
| recap-hint | _recapPendingTrigger, _maybeFetchRecap, _clearRecapForNewMessage, _renderRecapHint, _trackRecapSessionPresence | persistent-input / chat-renderer |
| rollback-dialog | readPartialCompactStartedAt, writePartialCompactStartedAt, clearPartialCompactState, _partialCompactInFlight, _partialCompactRuntimeId, _partialCompactContextKey, _compactTimerInterval, _rollbackDialogOpen | 同步 rollback / chat / app-main 链 |
| rollback-dialog-runtime | requestRollbackEdit | chat-renderer |
| runtime-status | currentRuntimeConnected, lastNotificationStatusPayload, _lastRenderedNotificationRuntime | app-main / runtime-status 同步渲染 |
| session-list-render | renderWorkspaceSessionList, onPhSessionDragStart | app-ui、模块输出的内联拖拽属性 |
| session-mutation / session-ui | getSessionReplacementMutation；getWorkspaceSessions | runtime-status；app-ui / sidebar-render |
| session-readonly-view | openReadOnlySession, closeReadOnlySession, getReadOnlySessionTarget, updateReadOnlySessionIndicator | app-main / app-ui 与 coder 插件现有协议 |
| sidebar-operations | queueSidebarDiagnosticEvent, recordSidebarOperationCheckpoint, beginSidebarOperationMainThreadObservation, sidebarDiagnosticNow, createSidebarOperationId, isRuntimeStopPending, reconcilePendingRuntimeStops, listSidebarOperations, findSidebarOperation, captureSidebarSnapshotToken, isSidebarSnapshotTokenCurrent, getSidebarOperationVersion, mergeWorkspaceSessionSnapshots | sidebar-render、runtime-status、app-main |
| sidebar-pin-color | SIDEBAR_TODO_COLORS, onSidebarPinPointerDown | sidebar-render 模板 |
| speech-config-cache | ensureClawSpeechModelConfig | app-ui |
| sse-client | isSseActive | app-main |
| template-engine | clearTruncatedHighlightData, renderJsonHighlight, applyTemplate, parseToolResult, getToolRenderTemplate, getToolDisplayName | chat-renderer / 同步模板消费方 |
| thread-store | openConversationTarget, submitThreadInput | app-main / thread-store 与既有插件宿主 |
| tool-progress | applyToolProgressNotification, clearToolProgressState, resolveToolProgressForCall, syncToolProgressDom | chat-renderer / app-main |
| usage-info-overlay | openUsageInfo | app-main |
| voice-input | _voiceRecording, _voiceStopping, _voiceTranscribing, _voicePendingSend, _voiceTargetBtn, _voiceTargetId | 输入同步消费方 |
| workspace-actions | runWorkspaceAction | app-main / app-ui / thread-store / 悬置域 |
| workspace-blocks | shouldRenderBlock, renderWorkspaceHero, renderWorkspaceActionGroup, renderWorkspaceLauncherGrid, renderWorkspaceForm, renderFlowEditorBlock, renderWorkspaceStatusGrid, getFeatureRepositoryData, getRepoLocaleText, parseWorkspaceListField, getAssemblyPresetLabel, getAssemblyPresetDescription, ASSEMBLY_PRESET_FEATURES, ASSEMBLY_BUNDLE_FEATURES, applyAssemblyPreset, setBundleFilter, getAssemblyStageLabel, getAssemblyFeatureLabel, buildAssemblyGeneratedPrompt, getAssemblyPromptValue, getFeatureTypeLabel, renderFeatureRepositoryBlock, renderAssemblyWorkbenchBlock | app-ui primitive 与装配模板 |
| workspace-docset | renderWorkspaceArtifactsBlock, renderProjectDocsetBlock, renderProjectDocsetContent, toggleProjectDocsetOverlay | app-ui / 同步 workspace-docset 薄壳 |
| workspace-settings | openWorkspaceSettings | app-main |

明确保留但不冒充有效消费证据的历史边界：

- `assembly-actions` 的 resetAssemblyDraft、loadSavedAssemblyConfig、launchAssemblyConfig、launchSavedAssemblyRun、deleteAssemblySessionRecord、loadAssemblySessionIntoDraft、deleteSavedAssemblyConfig：旧 app-ui 模板使用弯引号，静态命中不能证明真实点击可达。该存量 markup 问题未在本批修复，七键暂按原协议保留，P3 前需单独解决；不能据此宣称零冗余桥。
- createCompactedResumeSession、clearAgentRuntimeCache、openPrebuiltWorkspaceSession 三个基点已有桥已变成纯 import 消费，本轮冻结范围后未继续注销，作为显式剩余债务。
- memo / coder 等插件仍使用的 window 协议未改，不以插件 ESM 身份为由越界修改协议。

## 验证

主助手在最终稳定树执行：

- 325 个本次修改或新增 JS/MJS 文件 `node --check`：全部通过。
- 最后两批撤桥及相邻测试：108 项与 101 项通过，均 exit 0；侧栏归档退休测试仍检查真实刷新请求、失败后保留关闭抑制、不重复发送 stop，未削弱断言。
- 全局台账、script-tags、inline-events、桥债门禁通过；相对导入循环检查零新增、零循环（另有一条域外导入提示，未改扫描规则）。
- 真实 `index.html` Chromium 启动主链通过；阻塞 ESM 期间主题、语言与七个 rail 面板仍可交互，零 pageerror / console error / 未覆盖请求。网络对端为隔离 HTTP 契约 mock，未启动正式 Claw 或 Viewer，不能据此声称真实后端端到端全通过。
- 前端与 P2 测试集合：2404 项全部通过，零失败、零跳过，exit 0。
- 线程同步专项浏览器检查 14 项全部通过，保留真实计时与前台通知请求，使用真实实现而非空函数占位。
- `npm run test:core`：6623 项，6615 通过、4 失败、4 跳过，exit 1。三项平台失败（desktop-workspace、process-group、thread-conversation-search）已在纯净 `c3e18d71` 快照同断言复现；另有未修改的 thread-delivery-consumer FIFO 顺序波动，单独复跑通过。失败未被跳过或放宽，不声明全量绿。

### 变异抽查

只在 `.agentdev/temp/p2-final-mutation/` 隔离副本变异，生产工作树未被改坏：

1. 删除 model-preset-cache 的 getClawModelPresets 命名导出：原契约测试 8 项失败，原因明确为接口不存在；说明调用方测试能发现接口退化。
2. 将该域 claim setter 置空：兼容测试明确在“认领后写入应被接管”断言失败，exit 1；不是无关宿主异常。
3. 从本次副本备份恢复并与生产文件逐字比较一致，原树缓存/兼容/门禁测试通过。变异只能证明以上两类错误可被捕获，不代表所有缺陷均已覆盖。

## 接续与回滚

本次业务迁移、生产接线、真实图测试和基线是一个相互依赖的可运行组合，不按 Coder 工单拆成无法独立启动的中间提交。之前两个基础能力提交仍是前置依赖。回滚沿依赖逆序，不能只恢复 classic 标签而保留 ESM 源码。

后续为 P3：同步壳消解、剩余兼容桥和存量模板/插件协议的专项处理；不在本次提交里继续追加业务迁移。生效需重启整个 Claw 服务，本文没有执行正式服务重启或推送。
