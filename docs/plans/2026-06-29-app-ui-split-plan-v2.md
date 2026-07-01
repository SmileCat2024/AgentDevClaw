# app-ui.js 拆分计划 v2（2026-06-29 创建，2026-07-01 更新）

> 基于 v1（2026-06-04）的全面复核与更新
> 当前文件：`public/src/app-ui.js` — **7,631 行**（Phase 1 + 2a + 2b 已完成）
> v2 创建时行数：9,871 行 / v1 时的行数：9,498 行

---

## 一、已完成拆分（Phase 1 + 2a + 2b）

| 模块 | 行数 | 来源域 | 完成状态 |
|------|------|--------|----------|
| `dispatch-ui.js` | 547 | 域 I | ✅ |
| `dispatch-actions.js` | 438 | 域 U (main) | ✅ |
| `im-ui.js` | 751 | 域 H | ✅ |
| `im-actions.js` | 502 | 域 T (main) | ✅ |
| `session-dialogs.js` | 390 | 域 R (main) | ✅ |
| `feature-setup-ui.js` | 517 | 独立页面 | ✅ |
| `session-ui.js` | 888 | 域 F | ✅ |
| `work-group-ui.js` | 4,123 | 群聊工作空间 | ✅ |
| `toast-notify.js` | 474 | 通知系统 | ✅ |
| `settings-overlay.js` | 700 | 域 I | ✅ Phase 2b |
| `feature-config.js` | 784 | 域 H | ✅ Phase 2b |
| `chat-context-bar.js` | 483 | 域 C | ✅ Phase 2b |
| `resources-viewer.js` | 460 | 域 M | ✅ Phase 2b |

**已移出总计：~11,057 行**

---

## 二、当前 app-ui.js 内部地图（380 函数 → 14 个残留域）

### 域 A: Workspace Surface 核心（~260 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L2–44 | `selectWorkspaceSurface` | agent/workspace 切换入口 |
| L1719–1741 | `shouldRenderWorkspaceSurface`, `isChatSurfaceActive` | 渲染守卫 |
| L6055–6074 | `renderWorkspaceBlock` | **block 类型分派器** |
| L6076–6089 | `renderWorkspaceSurface` | surface 组装 |
| L6091–6136 | `updateProjectDocsetChrome`, `isEditingWorkspaceForm` | chrome 更新 |
| L6138–6279 | **`renderCurrentMainView`** | **全局渲染中枢** (142 行) |
| L6321–6372 | `resetRuntimeBackedSurfaceState`, `renderWorkspaceTabs` | 状态重置/tab 渲染 |

**耦合级别：★★★★★** — `renderCurrentMainView` 被 app-main.js 调用 70 次。是全局渲染分派器。
**拆分策略：** 永远留在 app-ui.js（或最后一步移到 workspace-surface.js）。

---

### 域 B: Unit Mode 与 Agent 身份（~240 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L46–58 | `upsertConnectedAgent` | agent 列表更新 |
| L60–172 | unit mode 系列（`getUnitPreferenceKey`, `getPreferredUnitMode`, `setPreferredUnitMode`, `getPassiveWorkspaceSurfaceMode`, `getDefaultUnitMode`, `ensureUnitMode`, `getUnitTabs`, `getUnitTabLabel`） | workspace 模式管理 |
| L173–218 | `getRuntimeAwareAgentRecord`, `getRuntimeAwareAgentName` | runtime 感知的身份解析 |

**耦合级别：★★★☆☆** — 被 app-ui.js 和 app-main.js 广泛调用。
**拆分建议：** 可移到 `workspace-mode.js`，但风险中等。

---

### 域 C: Chat Context Bar + Title Popup（~466 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L219–358 | `updateChatContextBar` | 上下文栏主函数 (140 行) |
| L359–497 | `_formatTokens`, `_buildCcbPopupHtml`, `_showCcbPopup`, `_hideCcbPopup`, `_scheduleShowCcbPopup`, `_scheduleHideCcbPopup`, `_initCcbPopup` | token 弹窗 |
| L498–684 | `_collectActiveSessionMeta`, `_buildTitlePopupHtml`, `_showTitlePopup`, `_hideTitlePopup`, `_scheduleShowTitlePopup`, `_scheduleHideTitlePopup`, `_initTitlePopup` | 标题弹窗 |

**耦合级别：★★☆☆☆** — 自包含的 popup 系统。被 `renderCurrentMainView` 调用 `updateChatContextBar`。
**app-main.js 引用：** 仅通过 `renderCurrentMainView` 间接调用。
**拆分建议：** 提取为 `chat-context-bar.js`，风险低。

---

### 域 D: PH Model Config（~110 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L685–794 | `ensurePhModelConfigHost`, `renderPhModelConfigOverlay` | PH 模型配置覆层 |

**耦合级别：★★☆☆☆** — 被 `window.phOpenModelConfig` (app-main.js) 调用。
**拆分建议：** 与 settings-overlay 合并，或独立小模块。

---

### 域 E: Assembly 数据层（~700 行，分散在多处）

| 行号 | 函数 | 说明 |
|------|------|------|
| L795–838 | `isAssemblySession`, `isAssemblySessionRunning`, `getAssemblySessionStatus`, `buildWorkspaceProjectKey` | session 类型判断 |
| L1315–1411 | `sanitizeWorkspacePathFragment`, `isValidFeatureCreatorName`, `isValidAgentCreatorName`, `normalizeAssemblyDirectoryToken`, `findAssemblyConfigConflict`, `getFeatureCreatorOutputDirectory`, `getAgentCreatorOutputDirectory`, `normalizeFeatureCreatorStartupDraft`, `normalizeProgrammingHelperStartupDraft`, `normalizeWorkspaceStartupDraft`, `getExpectedAssemblyEnvDir` | 校验/规范化 |
| L1412–1532 | `normalizeAssemblyDraft`, `getAssemblyDisplayName`, `getAssemblyEnvironmentState`, `getAssemblyEnvironmentStatusLabel`, `getAssemblyEnvironmentStatusTone`, `renderAssemblyStatusChip`, `getAssemblySavedConfigSummary`, `getAssemblyEditorMode` | draft/env 状态 |
| L1533–1638 | `buildFeatureConfigLookupKeys`, `featureConfigKeyMatches`, `normalizeFeatureConfigMap`, `collectAssemblyProjectFeatureConfigs`, `buildAutoSavedAssemblyConfigs` | 配置聚合 |
| L1639–1718 | `getWorkspaceFormDraft`, `saveWorkspaceFormDraft`, `resetWorkspaceFormDraft`, `persistWorkspaceState` | draft 管理 |
| L6760–6874 | `captureAssemblyFieldFocus`, `restoreAssemblyFieldFocus`, `scheduleAssemblyWorkbenchRender`, `syncAssemblyEnvironmentDraft`, `requestAssemblyEnvironmentCreate`, `updateAssemblyDraftWithoutRender` | env 操作 |

**耦合级别：★★★★★** — app-main.js 对这些函数有 **88 处引用**。是跨文件耦合最严重的区域。
**拆分策略：** 必须谨慎，建议作为独立 Phase 处理。先移纯函数（校验/规范化），再移状态管理。

---

### 域 F: Project/Creator 数据层（~332 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L839–1036 | `compareByRecency`, `getFeatureCreatorProjects`, `getAgentCreatorProjects` | creator 项目列表 |
| L1037–1140 | `getPathLeaf`, `toFeatureDisplayName`, `getFeatureSessionDisplayName`, `getFeatureProjectDisplayName`, `getAgentProjectDisplayName`, `getProgrammingHelperProjects`, `getProgrammingHelperProjectDisplayName`, `hasWorkspaceSessions`, `canEnterWorkspaceChat` | 显示名/项目元数据 |
| L1141–1170 | `getWorkspaceFormStorageKey`, `getAgentWorkspaceState`, `updateAgentWorkspaceState` | workspace state |
| L1285–1314 | `updateAgentRecord`, `applyManagedPrebuiltAgent` | agent 记录更新 |
| L1315–1320 | `getWorkspaceBlockData` | block 数据获取 |

**耦合级别：★★☆☆☆** — app-main.js 引用 6 次，session-ui.js 引用 9 次。
**拆分建议：** 提取为 `project-data.js`，风险低-中。

---

### 域 G: Workspace Block 渲染（~820 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L1742–2090 | `shouldRenderBlock`, `renderActionButton`, `renderWorkspaceHero`, `renderWorkspaceActionGroup`, `renderWorkspaceLauncherGrid`, `renderWorkspaceField`, `renderWorkspaceForm`, `renderFlowEditorBlock`, `getDirectorySummaryData`, `renderDirectorySummaryPanel`, `renderWorkspaceStatusGrid` | 通用 workspace blocks |
| L2091–2521 | `getFeatureRepositoryData`, `getRepoLocaleText`, `parseWorkspaceListField`, `serializeWorkspaceListField`, `getAssemblyPresetLabel`, `getAssemblyPresetDescription`, `getAssemblyFeaturePackageToken`, `getAssemblyStageLabel`, `formatAssemblyFeatureToken`, `getAssemblyFeatureLabel`, `buildAssemblyGeneratedPrompt`, `getAssemblyPromptValue`, `formatRepoFileSize`, `normalizeRepoUrl`, `renderRepoLink`, `getFeatureTypeLabel`, `getCompatibilityTagLabel`, `renderFeatureRepositoryBlock` | feature 仓库 block (431 行) |
| L2522–2543 | `renderAssemblyWorkbenchBlock` | assembly workbench 入口 |

**耦合级别：★★★☆☆** — 被 `renderWorkspaceBlock` 分派器调用。包含大量 HTML 模板。
**拆分建议：** 提取为 `workspace-blocks.js`。

---

### 域 H: Feature Config 渲染（~730 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L1171–1284 | `getFeatureConfig`, `normalizeFeatureConfigEntry`, `findFeatureConfigMapEntry`, `removeMatchingFeatureConfigAliases`, `updateFeatureConfigField`, `writeFeatureConfig` | config 数据 CRUD |
| L4232–4823 | `resolveFeaturePackageRecord`, `findFeatureManifestForSelection`, `getFeatureManifestPropertyEntries`, `getFeatureManifestDisplayName`, `formatManifestDefaultValue`, `normalizeManifestComparableValue`, `getFeatureConfigStatusMeta`, `coerceFeatureManifestValue`, `parseInlineDataValue`, `normalizeAcceptList`, `matchesFeatureConfigAccept`, `featureControlDomId`, `renderFeatureConfigControl`, `renderFWFeatureSettings` | manifest 解析 + config 控件渲染 |

**耦合级别：★★☆☆☆** — **app-main.js 零引用**。所有引用在 app-ui.js 内部（ClawFW 调用）。
**拆分建议：** 提取为 `feature-config.js`，风险低。

---

### 域 I: Settings Overlay（~684 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L2751–2796 | `ensureSettingsHost`, `openSettings`, `closeSettings` | 入口 |
| L2797–2925 | `renderSettingsOverlay` | 主渲染 |
| L2926–3100 | `renderSpeechModelSection`, `renderSpeechPresetEditForm` | 语音模型 |
| L3101–3252 | `saveSpeechFullConfig`, `renderSettingsEditForm`, `createSettingsHeaderRowHTML` | 编辑表单 |
| L3253–3434 | `addSettingsPreset`, `editSettingsPreset`, `cancelSettingsEdit`, `deleteSettingsPreset`, `toggleApiKeyVisibility`, `saveSettingsPreset`, `applySettingsPreset`, `saveSettingsConfig` | preset CRUD |

**耦合级别：★☆☆☆☆** — **app-main.js 零引用**。完全自包含。状态通过 `window.ClawFW.settings*` 管理。
**拆分建议：** 提取为 `settings-overlay.js`，风险极低。**首选拆分目标。**

---

### 域 J: ClawFW Flow Workspace（~1,700 行，分散）

| 行号 | 函数 | 说明 |
|------|------|------|
| L2526–2604 | `window.ClawFW` 对象定义 + `getFWFeatureCapabilityState`, `buildFWFeatureCapabilityKey`, `requestFWFeatureCapabilities`, `ensureFWFeatureCapabilities` | 状态机初始化 + 能力缓存 |
| L2605–2750 | `parseWorkspaceTimeMs`, `findAssemblyConfigForSession`, `fetchAssemblyGraphSummary`, `inspectAssemblySessionDrift`, `ensureAssemblyDriftDialogHost`, `closeAssemblyDriftDialog`, `confirmAssemblyDriftDialogProceed`, `renderAssemblyDriftDialog`, `maybeWarnAssemblySessionDrift` | drift dialog |
| L3435–4231 | `fwRerender`, `fwEnterDetail`, `fwBackToList`, `fwSwitchSection`, `fwOpenPromptEditor`, `fwClosePromptEditor`, picker 系列, feature import 系列, project picker, create/confirm dialogs, `renderFWSwitchProjectDialog`, `renderFWCreateDialog`, `renderFWConfirmDialog`, `renderFWPromptDialog`, `renderFWFeatureImportDialog`, `groupAssemblyRunsByProject`, `renderFWList` | ClawFW 方法群 (797 行) |
| L4824–5124 | `renderFWDetail`, `renderFWFeatures`, `renderFWConfigPane`, `renderFWOrchestrate`, `renderFlowWorkspaceProjectHero`, `renderAssemblyLibraryBlock` | FW 详情页 |
| L5125–5474 | `renderAssemblyStageHeader`, `renderAssemblyFeatureCards`, `renderAssemblyWorkbenchStageFlow` | assembly 阶段流 (350 行) |

**耦合级别：★★★☆☆** — app-main.js 引用 12 次（主要是 `window.ClawFW.*` 和 `fwRerender`）。内部依赖域 E (assembly data) 和域 H (feature config)。
**拆分建议：** 提取为 `flow-workspace-ui.js`。但必须先拆出 assembly-data 和 feature-config，否则依赖链太深。

---

### 域 K: Overview / Debug / Inspector（~816 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L6955–7125 | `shortenSourcePath`, `getHookInspectorSignature`, `getEmptyOverviewSnapshot`, `normalizeRuntimeSnapshot`, `normalizeOverviewSnapshot`, `getOverviewSignature`, `normalizeHookInspector`, `setCurrentHookInspector`, `setCurrentOverviewSnapshot`, `setCurrentLogs` | 数据规范化 |
| L7126–7256 | `formatMetricNumber`, `formatRate`, `getLatestCallSummary`, `getUsageBreakdown`, `renderTokenBar`, `renderRateRing`, `renderUsageCard`, `renderCacheCard`, `renderContextChip` | 用量/Token 渲染 |
| L7257–7398 | `setCurrentMcpInfo`, `getLevelWeight`, `formatLogTimestamp`, `safePrettyJson`, `getFilteredLogs`, `renderLogsPanel` | 日志面板 |
| L7418–7714 | `renderMcpPanel` | MCP 面板 (297 行) |
| L7715–7770 | `selectOverviewLifecycle`, `openFeatureDetails`, `closeFeatureDetails`, `openRepositoryPackageDetails`, `closeRepositoryPackageDetails` | 生命周期选择器 |

**耦合级别：★★★☆☆** — app-main.js 在 polling 中调用 12 处（`normalizeHookInspector`, `setCurrentHookInspector`, `setCurrentOverviewSnapshot`, `setCurrentLogs`, `setCurrentMcpInfo`）。其余为 UI 渲染。
**拆分建议：** 分两步：先提取数据规范化函数到 `overview-data.js`（被 polling 依赖），再提取 UI 面板到 `debug-panels.js`。

---

### 域 L: Debug 面板渲染（~379 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L7771–8118 | `getOrCreateSummaryOverlay`, `renderSummaryBodyContent`, `updateSummaryOverlayDOM`, `openSummaryPopup`, `closeSummaryPopup`, `regenerateSummary`, `setRepoSearchQuery`, `setRepoSourceFilter`, `openFeatureUploadDialog`, `closeFeatureUploadDialog`, `handleFeatureUploadFile`, `submitFeatureUpload` | Summary + Upload |
| L8119–8403 | `renderStructurePanel`, `renderMonitorPanel`, `renderFeaturesPanel`, `renderReverseHooksPanel` | 结构/监控/特性/hook 面板 |
| L9166–9259 | `renderFeaturePanel`, `toggleFeaturePanel` | 面板入口 |

**耦合级别：★★☆☆☆** — app-main.js 引用 12 处（主要是面板渲染调用）。
**拆分建议：** 与域 K 合并提取为 `debug-panels.js`。

---

### 域 M: Resources / Viewer（~438 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L8404–8631 | `_getResourcesChatId`, `loadResourcesPanelData`, `createResourceFile`, `deleteResourceFile`, `renameResourceFile`, `_showFilesPanelError`, `renderResourcesPanel` | 资源面板 |
| L8632–8841 | `openViewer`, `loadViewerContent`, `_setViewerSaveStatus`, `saveViewerFile`, `_viewerAutoSave`, `renderViewerPanel` | 文档查看器 |

**耦合级别：★☆☆☆☆** — **app-main.js 零引用**。所有引用在 app-ui.js 内部（`renderCurrentMainView` 中的 group-chat 分支）。只在 work-group workspace 激活。
**拆分建议：** 提取为 `resources-viewer.js`，风险极低。

---

### 域 N: Chat Viewport / Scroll 管理（~573 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L6281–6372 | `updateAssemblySideRailPosition`, `resetRuntimeBackedSurfaceState`, `renderWorkspaceTabs`, `getToggleButtonLabel` | side rail + tabs |
| L6373–6945 | `isNearBottom`, `updateFollowLatestButton`, `markManualScrollIntent`, `getChatViewportMetrics`, `getChatViewportBottomTop`, `setChatViewportTop`, `lockChatViewportToBottomNow`, `suppressChatViewportObservers`, `resumeChatViewportObservers`, `shouldIgnoreChatViewportObserverEvent`, `runWithSuppressedChatViewportObservers`, `cancelFollowLatestAnimation`, `startFollowLatestAnimation`, `ensureChatViewportObservers`, `interruptFollowLatest`, `registerManualScrollIntent`, `hasRecentManualScrollIntent`, `beginFollowLatestCooldown`, `isFollowLatestCooldownActive`, `beginFollowLatestEntryWindow`, `isFollowLatestEntryWindowActive`, `cancelChatScrollSettlement`, `notifyChatViewportMutation`, `scrollToLatest`, `setFollowLatest`, `scheduleFollowLatestSettlePass`, `requestFollowLatest`, `scheduleScrollToLatest`, `scheduleScrollToLatestWithVersion` | viewport 滚动/跟随系统 |

**耦合级别：★★★☆☆** — app-ui.js 内部 38 处引用，app-main.js 33 处引用。函数密集调用但自成闭环。
**拆分建议：** 提取为 `chat-viewport.js`。注意 `ensureChatViewportObservers` 被 `renderCurrentMainView` 直接调用。

---

### 域 O: Markdown / Template 引擎（~962 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L8842–9077 | `escapeHtml`, `extractDisplayMathBlocks`, `renderDisplayMathLatex`, `renderMarkdown`, `enhanceMathInElement`, `clearTruncatedHighlightData`, `renderJsonHighlight`, `expandTruncatedResult`, `getTemplateFallback` | Markdown/数学/JSON 渲染 |
| L9078–9165 | `setConnectionStatus`, `showAgentStartError`, `renderThemeToggle`, `applyLanguage`, `applyTheme` | 连接/主题/语言 |
| L9538–9871 | `formatError`, `interpolateTemplate`, `applyTemplate`, `parseToolResult`, `resolveTemplatePath`, `loadTemplate`, `collectTemplateNames`, `warmTemplatesInBackground`, `getToolRenderTemplate`, `getToolDisplayName`, `getAgentRuntimeId`, `getAgentDisplayId`, `escapeHtmlCtx`, `renderCtxItems`, `showCtxMenu`, `closeCtxMenu` | 模板引擎 + 工具渲染 + 右键菜单辅助 |

**耦合级别：★★★☆☆** — app-main.js 引用 **76 处**（`renderMarkdown`, `escapeHtml`, `parseToolResult`, `applyTemplate`, `getToolDisplayName` 等）。但全是纯函数调用，无状态依赖。
**拆分建议：** 分两步提取：
1. `markdown-utils.js` — `escapeHtml`, `renderMarkdown`, `extractDisplayMathBlocks`, `renderDisplayMathLatex`, `enhanceMathInElement`, `renderJsonHighlight` (~236 行)
2. `template-engine.js` — `formatError`, `interpolateTemplate`, `applyTemplate`, `parseToolResult`, `resolveTemplatePath`, `loadTemplate`, `collectTemplateNames`, `warmTemplatesInBackground`, `getToolRenderTemplate`, `getToolDisplayName` (~334 行)
3. `theme-lang.js` — `renderThemeToggle`, `applyLanguage`, `applyTheme`, `setConnectionStatus`, `showAgentStartError` (~88 行)

---

### 域 P: Context Menu（~278 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L9260–9537 | `closeAgentContextMenu`, `closeSessionContextMenu`, `closeProjectContextMenu`, `closeFeatureRepoContextMenu`, `closeCompactMenu`, `openCompactMenu`, `openFeatureRepoContextMenu`, `openProjectContextMenu`, `openAgentContextMenu`, `openSessionContextMenu` | 右键菜单系统 |

**耦合级别：★★☆☆☆** — 被 HTML onclick 调用。app-main.js 通过 `window.*` 间接调用。
**拆分建议：** 提取为 `context-menu.js`，或保留在 app-ui.js 壳层。

---

### 域 Q: Workspace Artifacts / Docset（~514 行，v1 计划中不存在）

| 行号 | 函数 | 说明 |
|------|------|------|
| L5475–5613 | `getWorkspaceArtifactData`, `getArtifactKindLabel`, `buildArtifactPreview`, `getSelectedArtifactId`, `renderArtifactPayloadDetails`, `getWorkspaceLabelFromId`, `renderWorkspaceArtifactsBlock` | 工件面板 |
| L5614–5988 | `getProjectDocsetData`, `getCurrentProjectDocset`, `getSelectedProjectDocsetDetail`, `getWorkspaceUiBlock`, `isProjectRequirementEditing`, `getProjectRequirementDraft`, `resetProjectRequirementDraft`, `renderProjectDocsetFields`, `renderProjectRequirementCards`, `renderProjectDocsetList`, `renderProjectDocsetSidebarItem`, `renderProjectDocsetDetailList`, `resolveProjectDocsetDetail`, `renderProjectDocsetDetailPane`, `getProjectDocsetPage`, `renderProjectDocsetContent`, `renderProjectDocsetBlock` | 项目文档集系统 |

**耦合级别：★★☆☆☆** — app-ui.js 内部 21 处引用，app-main.js 2 处。主要被 `renderWorkspaceBlock` 和 `renderCurrentMainView` 调用。
**拆分建议：** 提取为 `workspace-docset.js`，风险中-低。

---

### 域 R: Work Group Chat Block（~66 行）

| 行号 | 函数 | 说明 |
|------|------|------|
| L5989–6054 | `renderWorkGroupChatBlock`, `_ensureWorkGroupEventDelegation` | 群聊 workspace block 入口 |

**耦合级别：★★☆☆☆** — 被 `renderWorkspaceBlock` 分派调用。委托事件到 `window.WorkGroupUI`。
**拆分建议：** 保留在 app-ui.js 或并入 work-group-ui.js。

---

## 三、跨文件耦合数据（精确统计）

### 被 app-main.js 引用的 app-ui.js 函数（按引用次数排序）

| 域 | 代表函数 | app-main.js 引用数 | 风险 |
|----|----------|-------------------|------|
| 域 E (Assembly Data) | `getWorkspaceFormDraft`, `normalizeAssemblyDraft`, `getAssemblyEnvironmentState`, `persistWorkspaceState`, `collectAssemblyProjectFeatureConfigs`, `findAssemblyConfigConflict`, `syncAssemblyEnvironmentDraft`, `requestAssemblyEnvironmentCreate`, `updateAssemblyDraftWithoutRender` 等 | **88** | ★★★★★ |
| 域 O (Template/Markdown) | `renderMarkdown`, `escapeHtml`, `parseToolResult`, `applyTemplate`, `getToolDisplayName` | **76** | ★★★☆ |
| 域 N (Viewport) | `setFollowLatest`, `scrollToLatest`, `ensureChatViewportObservers`, `interruptFollowLatest`, `notifyChatViewportMutation` | **33** | ★★★☆ |
| 域 K+L (Debug) | `renderLogsPanel`, `renderMcpPanel`, `renderStructurePanel`, `renderMonitorPanel`, `renderFeaturesPanel`, `renderFeaturePanel`, `toggleFeaturePanel`, `renderReverseHooksPanel` | **12** | ★★☆ |
| 域 K (Overview) | `normalizeHookInspector`, `setCurrentHookInspector`, `normalizeOverviewSnapshot`, `setCurrentOverviewSnapshot`, `setCurrentLogs`, `normalizeRuntimeSnapshot` | **12** | ★★☆ |
| 域 J (ClawFW) | `window.ClawFW.*`, `fwRerender`, `renderProjectListBlock` | **12** | ★★★ |
| 域 C (CCB) | `updateChatContextBar` | 间接 (通过 renderCurrentMainView) | ★★☆ |
| 域 F (Project) | `getFeatureCreatorProjects`, `hasWorkspaceSessions`, `canEnterWorkspaceChat` | **6** | ★★☆ |
| 域 Q (Docset) | `toggleProjectDocsetOverlay` | **2** | ★☆☆ |
| 域 L (Summary) | `openSummaryPopup`, `closeSummaryPopup` | **2** | ★☆☆ |
| 域 I (Settings) | — | **0** | ★☆☆ |
| 域 H (Feature Config) | — | **0** | ★☆☆ |
| 域 M (Resources) | — | **0** | ★☆☆ |

### 关键不变量

1. **`renderCurrentMainView()` 调用 70 次**（从 60 增长到 70）— 全局渲染中枢，拆分时必须保持全局可见
2. **assembly-data 函数被 app-main.js 引用 88 次** — 最高耦合域，不可轻率移动
3. **viewport 函数被两个文件共引用 71 次** — 密集但自包含
4. **settings/feature-config/resources 对 app-main.js 零耦合** — 最安全的提取目标

---

## 四、更新后的目标拆分结构

### 拆分后 app-ui.js 保留壳层（~800 行）

```
保留内容：
  - selectWorkspaceSurface (L2-44)
  - upsertConnectedAgent + unit mode 系列 (L46-218) ← 可选移出
  - shouldRenderWorkspaceSurface, isChatSurfaceActive (L1719-1741)
  - renderWorkspaceBlock 分派器 (L6055-6074)
  - renderWorkspaceSurface (L6076-6089)
  - isEditingWorkspaceForm (L6130-6136)
  - renderCurrentMainView (L6138-6279) ← 核心
  - renderWorkspaceTabs (L6343-6372)
  - renderWorkGroupChatBlock (L5989-6054)
  - renderAssemblyWorkbenchBlock (L2522-2524) ← 2 行委托
```

### 新模块清单

| 模块 | 来源域 | 估计行数 | app-main 引用 | 风险 |
|------|--------|----------|--------------|------|
| `settings-overlay.js` | 域 I | ~684 | 0 | ★☆☆☆☆ |
| `resources-viewer.js` | 域 M | ~438 | 0 | ★☆☆☆☆ |
| `feature-config.js` | 域 H | ~730 | 0 | ★☆☆☆☆ |
| `chat-context-bar.js` | 域 C | ~466 | 0（间接） | ★★☆☆☆ |
| `workspace-docset.js` | 域 Q | ~514 | 2 | ★★☆☆☆ |
| `project-data.js` | 域 F | ~332 | 6 | ★★☆☆☆ |
| `markdown-utils.js` | 域 O-a | ~236 | 高(76总) | ★★★☆☆ |
| `template-engine.js` | 域 O-b | ~334 | 高(76总) | ★★★☆☆ |
| `theme-lang.js` | 域 O-c | ~88 | 中 | ★★☆☆☆ |
| `chat-viewport.js` | 域 N | ~573 | 33 | ★★★☆☆ |
| `overview-data.js` | 域 K-a | ~171 | 12 | ★★★☆☆ |
| `debug-panels.js` | 域 K-b+L | ~950 | 12 | ★★★☆☆ |
| `context-menu.js` | 域 P | ~278 | 0(onclick) | ★★☆☆☆ |
| `workspace-blocks.js` | 域 G | ~820 | 0（通过分派器） | ★★★☆☆ |
| `assembly-data.js` | 域 E | ~700 | **88** | ★★★★★ |
| `flow-workspace-ui.js` | 域 J | ~1,700 | 12 | ★★★★☆ |
| `ph-model-config.js` | 域 D | ~110 | 低 | ★★☆☆☆ |

**预计拆出总计：~9,023 行 → app-ui.js 残留 ~848 行**

---

## 五、执行顺序（更新版）

### Phase 2b：零耦合自包含模块（风险 ★☆☆）✅ 完成

> **状态：✅ 完成（2026-07-01）**
> app-ui.js：10,008 → 7,631 行（-2,377 行）

**实际执行与原计划的差异：**

1. **4 个模块一次性提取**：原计划 2b-1 到 2b-4 分步执行，实际在一次提交中完成全部 4 个模块的提取，因为它们之间无依赖关系。

2. **行数偏差**：计划估计合计 ~2,318 行，实际提取 2,427 行（偏差 +4.7%），主要来自 `feature-config.js`（计划 ~730 行 → 实际 784 行）和 `settings-overlay.js`（计划 ~684 行 → 实际 700 行）。

3. **index.html 加载顺序**：`resources-viewer.js` 放在 `app-ui.js` **之后**（而非全部之前），因为它的函数只在 `renderCurrentMainView` 的 group-chat 分支中被调用，延迟加载无影响。

4. **`chat-context-bar.js` 的 `updateChatContextBar`**：被 `renderCurrentMainView` 调用，移动后通过全局作用域可见，验证通过。

**新增文件清单：**

| 文件 | 行数 | 来源域 | app-main.js 引用 |
|------|------|--------|-----------------|
| `public/src/modules/settings-overlay.js` | 700 | 域 I | 0 |
| `public/src/modules/feature-config.js` | 784 | 域 H | 0 |
| `public/src/modules/chat-context-bar.js` | 483 | 域 C | 0（间接） |
| `public/src/modules/resources-viewer.js` | 460 | 域 M | 0 |

**目标：** 把 app-main.js 完全不引用的域先移走，零风险。

#### 2b-1. settings-overlay.js

| 项 | 值 |
|----|-----|
| 来源 | L2751–3434 |
| 行数 | ~684 |
| 移动函数 | `ensureSettingsHost`, `openSettings`, `closeSettings`, `renderSettingsOverlay`, `renderSpeechModelSection`, `renderSpeechPresetEditForm`, `saveSpeechFullConfig`, `renderSettingsEditForm`, `createSettingsHeaderRowHTML`, `addSettingsPreset`, `editSettingsPreset`, `cancelSettingsEdit`, `deleteSettingsPreset`, `toggleApiKeyVisibility`, `saveSettingsPreset`, `applySettingsPreset`, `saveSettingsConfig` |
| 移动的全局状态 | `window.ClawFW.settingsOpen`, `settingsData`, `settingsEditing`, `_modelPresets`, `_speechModelConfig`, `_speechPresets` |
| 依赖 | `invoke()` (app-core.js), `escapeHtml` (将留在 app-ui.js 或 markdown-utils.js) |
| index.html 插入位置 | app-ui.js **之前**（当前 settings 函数在 app-ui.js 中定义，被 onclick 引用） |
| 验证 | 打开设置面板 → 编辑 preset → 保存 → 应用 → 语音模型配置 |

#### 2b-2. resources-viewer.js

| 项 | 值 |
|----|-----|
| 来源 | L8404–8841 |
| 行数 | ~438 |
| 移动函数 | `_getResourcesChatId`, `loadResourcesPanelData`, `createResourceFile`, `deleteResourceFile`, `renameResourceFile`, `_showFilesPanelError`, `renderResourcesPanel`, `openViewer`, `loadViewerContent`, `_setViewerSaveStatus`, `saveViewerFile`, `_viewerAutoSave`, `renderViewerPanel` |
| 移动的全局状态 | `_filesPanelResources`, `_filesPanelLoadedChatId`, `_resourcesSwitcherChatId`, `_viewerFile`, `_viewerContent`, `_viewerChatId`, `_viewerIsGroupMd`, `_viewerPreview` |
| 依赖 | `invoke()` (app-core.js), `escapeHtml`, DOM 引用 |
| index.html 插入位置 | app-ui.js **之前** |
| 验证 | 进入群聊 workspace → 打开 resources 面板 → 创建/删除/重命名文件 → 打开 viewer → 编辑保存 |

#### 2b-3. feature-config.js

| 项 | 值 |
|----|-----|
| 来源 | L1171–1284 + L4232–4823 |
| 行数 | ~730 |
| 移动函数 | `getFeatureConfig`, `normalizeFeatureConfigEntry`, `findFeatureConfigMapEntry`, `removeMatchingFeatureConfigAliases`, `updateFeatureConfigField`, `writeFeatureConfig`, `resolveFeaturePackageRecord`, `findFeatureManifestForSelection`, `getFeatureManifestPropertyEntries`, `getFeatureManifestDisplayName`, `formatManifestDefaultValue`, `normalizeManifestComparableValue`, `getFeatureConfigStatusMeta`, `coerceFeatureManifestValue`, `parseInlineDataValue`, `normalizeAcceptList`, `matchesFeatureConfigAccept`, `featureControlDomId`, `renderFeatureConfigControl`, `renderFWFeatureSettings` |
| 依赖 | `invoke()` (app-core.js), `escapeHtml`, ClawFW 调用 |
| 注意 | `renderFWFeatureSettings` 是大函数（~335 行），被 ClawFW detail 渲染调用 |
| index.html 插入位置 | app-ui.js **之前** |
| 验证 | flow-workspace → detail → features → 展开 feature config 控件 → 修改值 → 验证保存 |

#### 2b-4. chat-context-bar.js

| 项 | 值 |
|----|-----|
| 来源 | L219–684 |
| 行数 | ~466 |
| 移动函数 | `updateChatContextBar`, `_formatTokens`, `_buildCcbPopupHtml`, `_showCcbPopup`, `_hideCcbPopup`, `_scheduleShowCcbPopup`, `_scheduleHideCcbPopup`, `_initCcbPopup`, `_collectActiveSessionMeta`, `_buildTitlePopupHtml`, `_showTitlePopup`, `_hideTitlePopup`, `_scheduleShowTitlePopup`, `_scheduleHideTitlePopup`, `_initTitlePopup` |
| 依赖 | `getCurrentAgentRecord`, `currentRuntimeAgentId`, DOM 引用 (`ccbBar`, `ccbPopup` 等) |
| 注意 | `updateChatContextBar` 被 `renderCurrentMainView` 调用，移动后需保证全局可见 |
| index.html 插入位置 | app-ui.js **之前** |
| 验证 | 切换到有 session 的 agent → 查看 token 进度条 → hover 查看详情 popup → 点击标题查看 AI 标题 popup |

---

### Phase 2c：低耦合 UI 面板（风险 ★★☆）

#### 2c-1. workspace-docset.js

| 项 | 值 |
|----|-----|
| 来源 | L5475–5988 |
| 行数 | ~514 |
| 移动函数 | 全部 artifact/docset 函数（见域 Q） |
| 依赖 | `getCurrentAgentRecord`, `escapeHtml`, `localizeWorkspaceValue`, `invoke()` |
| 注意 | `updateProjectDocsetChrome` 被 `renderCurrentMainView` 调用（L6091），`renderWorkspaceBlock` 通过 block type 分派到 `renderProjectDocsetBlock` |
| 验证 | flow-workspace agent → 进入 chat → 打开项目文档覆层 → 查看需求卡片 → 编辑需求 → 查看工件面板 |

#### 2c-2. project-data.js

| 项 | 值 |
|----|-----|
| 来源 | L839–1140 + L1285–1320 |
| 行数 | ~332 |
| 移动函数 | `compareByRecency`, `getFeatureCreatorProjects`, `getAgentCreatorProjects`, `getPathLeaf`, `toFeatureDisplayName`, 各 display name 函数, `getProgrammingHelperProjects`, `hasWorkspaceSessions`, `canEnterWorkspaceChat`, `getWorkspaceFormStorageKey`, `getAgentWorkspaceState`, `updateAgentWorkspaceState`, `updateAgentRecord`, `applyManagedPrebuiltAgent`, `getWorkspaceBlockData` |
| 依赖 | `invoke()` (app-core.js), `allAgents` |
| 注意 | 被 session-ui.js 引用 9 处 |
| 验证 | 切换 feature-creator / agent-creator / programming-helper → 查看 session 列表 → 验证项目名正确 |

#### 2c-3. context-menu.js

| 项 | 值 |
|----|-----|
| 来源 | L9260–9537 |
| 行数 | ~278 |
| 移动函数 | 所有 `close*ContextMenu`, `open*ContextMenu`, `openCompactMenu` |
| 依赖 | DOM 引用, `invoke()`, 全局 agent/session 数据 |
| 注意 | HTML onclick 调用这些函数 |
| 验证 | 右键 agent / session / project / feature-repo → 验证菜单弹出和操作 |

#### 2c-4. ph-model-config.js

| 项 | 值 |
|----|-----|
| 来源 | L685–794 |
| 行数 | ~110 |
| 移动函数 | `ensurePhModelConfigHost`, `renderPhModelConfigOverlay` |
| 注意 | 被 `window.phOpenModelConfig` (app-main.js) 调用 |

---

### Phase 2d：渲染工具函数（风险 ★★★）

#### 2d-1. markdown-utils.js

| 项 | 值 |
|----|-----|
| 来源 | L8842–9077 |
| 行数 | ~236 |
| 移动函数 | `escapeHtml`, `extractDisplayMathBlocks`, `renderDisplayMathLatex`, `renderMarkdown`, `enhanceMathInElement`, `clearTruncatedHighlightData`, `renderJsonHighlight`, `expandTruncatedResult` |
| 依赖 | `marked` (全局), `katetex` (全局), `Prism` (全局) |
| 注意 | `escapeHtml` 被全项目调用（约 100+ 处）。`renderMarkdown` 被 app-main.js 大量调用。但都是纯函数，移动后通过全局作用域可见即可 |
| **关键风险** | `escapeHtml` 是最基础的工具函数。移动它不会造成功能问题（全局作用域），但会让 grep 定位变难。建议在 app-ui.js 原位留一行注释 `// escapeHtml -> modules/markdown-utils.js` |
| 验证 | 发送消息 → 查看 markdown 渲染 → 代码高亮 → 数学公式 → JSON 工具结果展开 |

#### 2d-2. template-engine.js

| 项 | 值 |
|----|-----|
| 来源 | L9538–9800 |
| 行数 | ~334 |
| 移动函数 | `formatError`, `interpolateTemplate`, `applyTemplate`, `parseToolResult`, `resolveTemplatePath`, `loadTemplate`, `collectTemplateNames`, `warmTemplatesInBackground`, `getToolRenderTemplate`, `getToolDisplayName`, `getAgentRuntimeId`, `getAgentDisplayId` |
| 依赖 | `invoke()` (app-core.js), `marked` (全局), 全局模板缓存 |
| 注意 | `parseToolResult` 和 `applyTemplate` 被 app-main.js 的 `render()` 大量调用 |
| 验证 | 发送消息 → 查看 tool call 渲染 → 验证模板正确加载和应用 |

#### 2d-3. theme-lang.js

| 项 | 值 |
|----|-----|
| 来源 | L9078–9165 |
| 行数 | ~88 |
| 移动函数 | `setConnectionStatus`, `showAgentStartError`, `renderThemeToggle`, `applyLanguage`, `applyTheme` |
| 依赖 | DOM 引用, `currentLanguage` |

---

### Phase 2e：Viewport 系统（风险 ★★★）

#### 2e-1. chat-viewport.js

| 项 | 值 |
|----|-----|
| 来源 | L6281–6372（部分） + L6373–6945 |
| 行数 | ~573 |
| 移动函数 | `updateAssemblySideRailPosition`, `getToggleButtonLabel`, `isNearBottom`, `updateFollowLatestButton`, `markManualScrollIntent`, `getChatViewportMetrics`, `getChatViewportBottomTop`, `setChatViewportTop`, `lockChatViewportToBottomNow`, `suppressChatViewportObservers`, `resumeChatViewportObservers`, `shouldIgnoreChatViewportObserverEvent`, `runWithSuppressedChatViewportObservers`, `cancelFollowLatestAnimation`, `startFollowLatestAnimation`, `ensureChatViewportObservers`, `interruptFollowLatest`, `registerManualScrollIntent`, `hasRecentManualScrollIntent`, `beginFollowLatestCooldown`, `isFollowLatestCooldownActive`, `beginFollowLatestEntryWindow`, `isFollowLatestEntryWindowActive`, `cancelChatScrollSettlement`, `notifyChatViewportMutation`, `scrollToLatest`, `setFollowLatest`, `scheduleFollowLatestSettlePass`, `requestFollowLatest`, `scheduleScrollToLatest`, `scheduleScrollToLatestWithVersion` |
| 依赖 | `container` (DOM), `currentMessages`, `render()` (app-main.js), `followLatest` 等全局状态 |
| 注意 | `ensureChatViewportObservers` 被 `renderCurrentMainView` 直接调用。`scrollToLatest`, `setFollowLatest` 被 app-main.js 的 `render()` 和 poll 调用。`runWithSuppressedChatViewportObservers` 被 `renderCurrentMainView` 调用。 |
| **关键风险** | viewport 函数被两个文件密集引用（71 处），但它们形成自闭环。移动后通过全局作用域仍可访问。风险在于遗漏某个被 `renderCurrentMainView` 直接调用的函数 |
| 验证 | 发送消息 → 验证自动滚动 → 手动滚动 → 验证 follow 中断 → 新消息到达 → 验证恢复跟随 → workspace surface 切换 → 验证 scroll 重置 |

---

### Phase 2f：Debug 面板（风险 ★★★）

#### 2f-1. overview-data.js

| 项 | 值 |
|----|-----|
| 来源 | L6955–7125 |
| 行数 | ~171 |
| 移动函数 | `shortenSourcePath`, `getHookInspectorSignature`, `getEmptyOverviewSnapshot`, `normalizeRuntimeSnapshot`, `normalizeOverviewSnapshot`, `getOverviewSignature`, `normalizeHookInspector`, `setCurrentHookInspector`, `setCurrentOverviewSnapshot`, `setCurrentLogs` |
| 依赖 | `currentHookInspector`, `currentOverviewSnapshot`, `currentLogs` 等全局状态 |
| 注意 | 这些函数被 app-main.js polling 调用。是纯函数 + setter。 |

#### 2f-2. debug-panels.js

| 项 | 值 |
|----|-----|
| 来源 | L7126–7256 + L7257–7398 + L7418–8403 + L7715–8118 + L9166–9259 |
| 行数 | ~950 |
| 移动函数 | usage 渲染, log 面板, MCP 面板, summary overlay, upload dialog, structure/monitor/features/reverseHooks 面板, feature panel |
| 依赖 | `currentHookInspector`, `currentOverviewSnapshot`, `currentLogs`, `currentMcpInfo`, DOM 引用, `renderMarkdown`, `escapeHtml` |
| 注意 | `renderFeaturePanel` 和 `toggleFeaturePanel` 被 `renderCurrentMainView` 和 app-main.js 间接调用 |

---

### Phase 3a：Workspace Blocks 渲染（风险 ★★★）

#### 3a-1. workspace-blocks.js

| 项 | 值 |
|----|-----|
| 来源 | L1742–2090 + L2091–2521 + L2522–2543 |
| 行数 | ~820 |
| 移动函数 | `shouldRenderBlock`, `renderActionButton`, `renderWorkspaceHero`, `renderWorkspaceActionGroup`, `renderWorkspaceLauncherGrid`, `renderWorkspaceField`, `renderWorkspaceForm`, `renderFlowEditorBlock`, `getDirectorySummaryData`, `renderDirectorySummaryPanel`, `renderWorkspaceStatusGrid`, 全部 feature-repository 函数, `renderAssemblyWorkbenchBlock` |
| 注意 | 这些函数通过 `renderWorkspaceBlock` 分派器调用。HTML 模板中有大量 onclick 引用 app-main.js 的 `window.*` 函数。 |
| 验证 | 逐 agent 类型验证 workspace 首页渲染 |

---

### Phase 3b：Assembly 数据层（风险 ★★★★★）

#### 3b-1. assembly-data.js

| 项 | 值 |
|----|-----|
| 来源 | L795–838 + L1315–1411 + L1412–1638 + L1639–1718 + L6760–6874 |
| 行数 | ~700 |
| 移动函数 | 全部 assembly session 判断, 校验/规范化, draft/env 状态, 配置聚合, draft 管理, env 操作 |
| **app-main.js 引用** | **88 处** — 全项目最高 |
| **关键约束** | 必须在所有其他涉及 assembly 的模块稳定后再拆。app-main.js 的 assembly actions (域 P) 直接调用这些函数。 |

**分步策略：**
1. 先移纯函数（`isAssemblySession`, `isValidFeatureCreatorName`, `normalizeAssemblyDraft`, `getAssemblyEnvironmentState` 等）
2. 再移状态管理（`getWorkspaceFormDraft`, `saveWorkspaceFormDraft`, `persistWorkspaceState`）
3. 最后移异步操作（`syncAssemblyEnvironmentDraft`, `requestAssemblyEnvironmentCreate`）

每步后立即验证完整 assembly 流程。

---

### Phase 3c：ClawFW Flow Workspace（风险 ★★★★）

#### 3c-1. flow-workspace-ui.js

| 项 | 值 |
|----|-----|
| 来源 | L2526–2604 + L2605–2750 + L3435–4231 + L4824–5124 + L5125–5474 |
| 行数 | ~1,700 |
| 移动函数 | `window.ClawFW` 对象定义 + 全部 fw* 方法 + 全部 renderFW* 函数 + drift dialog + assembly stage flow |
| 依赖 | assembly-data (域 E), feature-config (域 H), `renderCurrentMainView`, `escapeHtml` |
| 注意 | `window.ClawFW` 是全局命名空间，移动时需保证初始化时机。`renderProjectListBlock` 被 `renderWorkspaceBlock` 分派。 |

**前置条件：** assembly-data.js 和 feature-config.js 必须先完成（Phase 3b + 2b-3）。

---

### Phase 3d：Workspace Surface 核心（风险 ★★★★★）

#### 3d-1. workspace-surface.js（可选最后一步）

| 项 | 值 |
|----|-----|
| 来源 | 域 A 全部 |
| 行数 | ~260 |
| 移动函数 | `selectWorkspaceSurface`, `shouldRenderWorkspaceSurface`, `isChatSurfaceActive`, `renderWorkspaceBlock`, `renderWorkspaceSurface`, `isEditingWorkspaceForm`, **`renderCurrentMainView`**, `renderWorkspaceTabs`, `resetRuntimeBackedSurfaceState` |
| **关键风险** | `renderCurrentMainView` 被 app-main.js 调用 70 次。移动后必须保持全局可见。此函数的错误会导致**全站白屏**。 |

**建议：** 此步骤可以不做。保留 `renderCurrentMainView` 在 app-ui.js 壳层是安全的，260 行的壳层完全可以接受。

---

## 六、index.html 加载顺序（更新版）

```html
<!-- 第三方库（不变） -->
<script src="/vendor/marked/lib/marked.umd.js"></script>

<!-- Tauri bridge（不变） -->
<script src="./src/tauri-bridge.js"></script>

<!-- Flow Editor（不变） -->
<script src="./flow-editor.js"></script>

<!-- Core 基础设施（不变） -->
<script src="./src/app-core.js"></script>

<!-- Phase 1 已完成模块（不变） -->
<script src="./src/modules/toast-notify.js"></script>
<script src="./src/modules/dispatch-ui.js"></script>
<script src="./src/modules/dispatch-actions.js"></script>
<script src="./src/modules/im-ui.js"></script>
<script src="./src/modules/im-actions.js"></script>
<script src="./src/modules/session-dialogs.js"></script>
<script src="./src/modules/feature-setup-ui.js"></script>
<script src="./src/modules/work-group-ui.js"></script>

<!-- Phase 2b-2f 新模块（在 app-ui.js 之前） -->
<script src="./src/modules/settings-overlay.js"></script>
<script src="./src/modules/resources-viewer.js"></script>
<script src="./src/modules/feature-config.js"></script>
<script src="./src/modules/chat-context-bar.js"></script>
<script src="./src/modules/markdown-utils.js"></script>
<script src="./src/modules/template-engine.js"></script>
<script src="./src/modules/theme-lang.js"></script>
<script src="./src/modules/workspace-docset.js"></script>
<script src="./src/modules/project-data.js"></script>
<script src="./src/modules/context-menu.js"></script>
<script src="./src/modules/ph-model-config.js"></script>
<script src="./src/modules/chat-viewport.js"></script>
<script src="./src/modules/overview-data.js"></script>
<script src="./src/modules/debug-panels.js"></script>

<!-- Phase 3 新模块（在 app-ui.js 之前） -->
<script src="./src/modules/workspace-blocks.js"></script>
<script src="./src/modules/assembly-data.js"></script>
<script src="./src/modules/flow-workspace-ui.js"></script>

<!-- 瘦身后的壳层 -->
<script src="./src/app-ui.js"></script>

<!-- Phase 1 已完成模块（在 app-ui.js 之后，不依赖 app-ui.js 内函数） -->
<script src="./src/modules/session-ui.js"></script>

<!-- app-main.js -->
<script src="./src/app-main.js"></script>
```

**加载顺序原则：**
1. 被依赖的模块先加载
2. `app-core.js` 永远在最前（提供全局状态和 DOM 引用）
3. 所有从 app-ui.js 提取的模块在 app-ui.js 之前加载（因为 app-ui.js 中的 `renderCurrentMainView` 会调用它们）
4. `session-ui.js` 已在 app-ui.js 之后且验证正常，保持不变
5. `app-main.js` 永远最后（依赖所有其他文件）

---

## 七、风险清单与缓解措施

### 风险 1：assembly-data 88 处跨文件引用

**场景：** 移动 `getWorkspaceFormDraft` 等函数后，如果某个引用点遗漏或时序错误，assembly 流程会静默失败。

**缓解：**
- 使用 LSP `find_references` 或 grep 逐一验证每个被移动函数的所有引用点
- 分三步移动（纯函数 → 状态管理 → 异步操作），每步后完整验证
- 移动后在 app-ui.js 原位保留 `// <函数名> -> modules/assembly-data.js` 注释

### 风险 2：`renderCurrentMainView` 内联依赖

**场景：** `renderCurrentMainView` 直接调用了多个域的函数（`shouldRenderWorkspaceSurface`, `renderWorkspaceSurface`, `renderWorkspaceBlock`, `updateChatContextBar`, `updateProjectDocsetChrome`, `ensureChatViewportObservers`, `renderWorkspaceTabs`, `renderInputRequests`, `runWithSuppressedChatViewportObservers`, `cancelChatScrollSettlement`, `updateFollowLatestButton`, `updateAssemblySideRailPosition`, `updateChatProcessToggle`）。

**缓解：**
- 这些函数全部通过全局作用域可见（script 标签加载，非 ES module）
- 只要加载顺序正确（modules 在 app-ui.js 之前），运行时调用不会断裂
- **不要将 `renderCurrentMainView` 移出 app-ui.js**（除非作为可选的最后一步）

### 风险 3：`escapeHtml` 全局依赖

**场景：** `escapeHtml` 被全项目 100+ 处调用。移动到 `markdown-utils.js` 后，虽然全局可见，但新开发者 grep 定位变难。

**缓解：**
- 移动后在 app-ui.js 原位保留注释
- 考虑将 `escapeHtml` 移到 `app-core.js`（它是最基础的工具函数，符合 core 的定位）

### 风险 4：`window.ClawFW` 初始化时序

**场景：** `window.ClawFW` 对象定义（L2526）如果移动到模块文件，但模块加载时某些依赖的 DOM 或全局变量尚未就绪。

**缓解：**
- `window.ClawFW` 只是对象字面量赋值，不依赖 DOM
- 只要模块在 app-core.js 之后加载，`window.ClawFW` 定义即可执行
- ClawFW 方法（fw*）在运行时才被调用，不依赖加载时序

### 风险 5：CSS 选择器与 HTML 模板分散

**场景：** 提取模块后，HTML 模板和对应的 CSS 可能在不同文件中，增加维护成本。

**缓解：**
- CSS 拆分是独立工作项，不在本计划范围
- 每个 module 文件头部注释中列出该模块使用的 CSS class 前缀
- 后续可考虑 CSS module 化（但需要构建工具支持，当前不做）

### 风险 6：viewport 模块的 observer 生命周期

**场景：** `ensureChatViewportObservers` 创建 MutationObserver，如果初始化时序变化可能导致 observer 绑定到错误的 DOM 元素。

**缓解：**
- `ensureChatViewportObservers` 内部有幂等检查（不会重复创建 observer）
- 它被 `renderCurrentMainView` 每次调用，移动后仍然如此
- 不改变函数逻辑，只改变物理位置

### 风险 7：settings-overlay 的 ClawFW 状态耦合

**场景：** settings overlay 使用 `window.ClawFW.settingsOpen`, `settingsData`, `settingsEditing`, `_modelPresets` 等状态。如果移动后 `window.ClawFW` 对象尚未定义（因为 ClawFW 定义在 L2526，settings 在 L2751）。

**缓解：**
- 加载顺序：`flow-workspace-ui.js`（定义 `window.ClawFW`）在 `settings-overlay.js` 之前
- 或在 settings-overlay.js 顶部添加防御性初始化：`window.ClawFW = window.ClawFW || {}`

---

## 八、验证检查表

每个模块拆分后，执行以下检查：

### A. 加载验证
- [ ] 页面正常加载，控制台无 JS 报错
- [ ] DevTools Network 标签确认新模块文件 200 加载
- [ ] DevTools Sources 标签确认函数可在正确文件中找到

### B. 功能验证（按模块）
- [ ] **settings-overlay**: 打开设置 → 编辑 preset → 保存 → 应用 → 语音配置
- [ ] **resources-viewer**: 群聊 workspace → resources 面板 → 创建/删除文件 → viewer 编辑
- [ ] **feature-config**: flow-workspace → detail → features → config 控件
- [ ] **chat-context-bar**: 切换 agent → token 进度条 → hover popup → 标题 popup
- [ ] **workspace-docset**: flow-workspace chat → 项目文档覆层 → 需求编辑
- [ ] **project-data**: 各 creator agent → session 列表 → 项目名正确
- [ ] **markdown-utils**: 发消息 → markdown → 代码高亮 → 数学公式 → JSON 展开
- [ ] **template-engine**: tool call 渲染 → 模板加载 → 工具名映射
- [ ] **chat-viewport**: 自动滚动 → 手动滚动 → follow 中断/恢复 → workspace 切换
- [ ] **overview-data**: polling 正常 → overview 数据更新 → hookInspector 正确
- [ ] **debug-panels**: logs/mcp/features/hooks 面板 → summary popup → upload
- [ ] **assembly-data**: 完整流程（创建→选择feature→保存→启动→停止→恢复→删除）
- [ ] **flow-workspace-ui**: 项目列表 → detail → assembly → features → orchestrate
- [ ] **workspace-blocks**: 逐 agent 类型 → workspace 首页 block 渲染

### C. 回归验证（每次拆分后）
- [ ] 切换 agent 不白屏
- [ ] 发送消息不白屏
- [ ] workspace surface 与 chat surface 切换正常
- [ ] 右键菜单正常
- [ ] polling 不中断

---

## 九、执行跟踪表

| Phase | 模块 | 行数 | 风险 | 状态 | 验证日期 |
|-------|------|------|------|------|----------|
| 2b-1 | settings-overlay.js | ~684 (实际 700) | ★☆☆ | ✅ 完成 | 2026-07-01 |
| 2b-2 | resources-viewer.js | ~438 (实际 460) | ★☆☆ | ✅ 完成 | 2026-07-01 |
| 2b-3 | feature-config.js | ~730 (实际 784) | ★☆☆ | ✅ 完成 | 2026-07-01 |
| 2b-4 | chat-context-bar.js | ~466 (实际 483) | ★★☆ | ✅ 完成 | 2026-07-01 |
| 2c-1 | workspace-docset.js | ~514 | ★★☆ | 待执行 | |
| 2c-2 | project-data.js | ~332 | ★★☆ | 待执行 | |
| 2c-3 | context-menu.js | ~278 | ★★☆ | 待执行 | |
| 2c-4 | ph-model-config.js | ~110 | ★★☆ | 待执行 | |
| 2d-1 | markdown-utils.js | ~236 | ★★★ | 待执行 | |
| 2d-2 | template-engine.js | ~334 | ★★★ | 待执行 | |
| 2d-3 | theme-lang.js | ~88 | ★★☆ | 待执行 | |
| 2e-1 | chat-viewport.js | ~573 | ★★★ | 待执行 | |
| 2f-1 | overview-data.js | ~171 | ★★★ | 待执行 | |
| 2f-2 | debug-panels.js | ~950 | ★★★ | 待执行 | |
| 3a-1 | workspace-blocks.js | ~820 | ★★★ | 待执行 | |
| 3b-1 | assembly-data.js | ~700 | ★★★★★ | 待执行 | |
| 3c-1 | flow-workspace-ui.js | ~1,700 | ★★★★ | 待执行 | |
| 3d-1 | workspace-surface.js | ~260 | ★★★★★ | 可选 | |

**预计拆出总计：~9,054 行**
**已完成拆出（Phase 1 + 2a + 2b）：~11,057 行**
**拆分后 app-ui.js 残留：7,631 行**（剩余 Phase 2c-3d 待执行）

---

## 十、与 v1 计划的差异说明

| 项 | v1 (2026-06-04) | v2 (2026-06-29) | 原因 |
|----|-----------------|-----------------|------|
| app-ui.js 行数 | 9,498 | 9,871 | 净增 373 行（docset/artifacts 等新功能） |
| renderCurrentMainView 调用次数 | ~60 | 70 | 功能增加导致调用点增多 |
| 已拆出模块 | 6 个 | 9 个 | 新增 session-ui, work-group-ui, toast-notify |
| session-ui.js | 计划中 | **已完成** | Phase 2a 完成 |
| work-group-ui.js | 未提及 | **已完成** (4,123 行) | 群聊工作空间新增 |
| 新增域 | — | 域 Q (docset/artifacts), 域 R (work-group block) | 产品新增功能 |
| 耦合统计 | 定性描述 | **精确计数** (88/76/33/12 等) | 使用 grep 精确统计 |
| 拆分顺序 | 3 Phase | **5 Phase (2b/2c/2d/2e/2f/3a/3b/3c/3d)** | 更细粒度的风险分级 |
| settings-overlay | 合并在 feature-config | **独立优先拆** | 发现 app-main.js 零引用 |
| resources-viewer | 未提及 | **新增** | 发现完全自包含 |
| escapeHtml | 未特别提及 | **建议移到 app-core.js** | 发现是最基础的跨域依赖 |
| workspace-surface (3d) | 必须拆 | **可选** | 260 行壳层可接受 |
