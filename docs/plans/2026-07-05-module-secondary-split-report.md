# 二次拆分可行性分析报告

> 调研时间：2026-07-05
> 调研范围：work-group-ui.js、settings-overlay.js、debug-panels.js
> 所有结论基于通读全文 + 跨文件引用 grep，未做任何代码修改。

---

## 一、`work-group-ui.js`（4290 行，IIFE 包裹）

### 1.1 架构特征（关键约束）

整个文件是 **单个巨型 IIFE 闭包**，约 **50 个模块级 `let/const` 状态变量**全部共享于闭包内（`activeChat`、`activeChatId`、`identities`、`pendingLinks`、`pendingAttachments`、`_sessionDataCache`、`_runtimeStatusCache`、`_chatSessionSelection`、`_popoverEl`、`_voice*` 系列等）。这是拆分的**最大障碍**——几乎所有函数都直接读写这些共享状态。

### 1.2 函数清单（按域分类）

| 域 | 关键函数（行号/行数） | 小计行数 |
|----|----------------------|---------|
| **data/api** | apiGet(113/5)、apiPost(119/9)、apiPut(129/9)、apiDelete(139/5)、loadChatSummaries(147/9)、loadActiveChat(157/18)、loadIdentities(176/9)、fetchRuntimeStatus(1621/15)、fetchSessionData(2485/21) | ~100 |
| **chat-list** | _renderChatItem(321/19)、renderChatList(341/38)、refreshChatList(1517/4) | ~61 |
| **message-renderer** | renderGroupHeader(382/16)、renderModeDropdown(399/27)、renderAdminChip(429/37)、getMemberAggregateStatus(470/8)、resolveDispatchDisplayStatus(490/10)、renderAwarenessBar(501/41)、renderEventMessage(545/43)、renderDispatchCard(591/48)、renderDispatchPendingCard(640/72)、renderMessageBubble(715/**124**)、renderMessageList(840/4)、applyCollapsible(848/61)、_renderAnnotationBars(3866/23) | ~530 |
| **input/mention/session-bar** | renderMentionPicker(912/3)、renderInputArea(918/24)、renderSessionBar(2414/26)、renderSessionDropdown(2441/43)、toggleSessionDropdown(2507/12)、handleSessionOption(2520/11)、renderLinkList(2549/8)、renderAttachmentList(2558/15)、toggleLinksArea(2532/4)、addLink(2537/11)、_doInsertMention(2331/28)、insertMention(2360/10)、insertMentionWithSession(2371/18)、toggleMentionPicker(2244/9)、hideMentionPicker(2254/5)、showMentionLevel1(2260/23)、showMentionLevel2(2284/46)、getMentionedIdentities(2392/6)、getMentionableIdentities(2399/4)、getSessionSelection(2404/4)、setSessionSelection(2409/4) | ~330 |
| **popover** | _renderPopoverSessionList(1767/41)、_formatSessionTime(1812/10)、_renderAdminSessionList(1829/30)、**showMemberPopover(1860/216)**←最大、hideMemberPopover(2077/9)、onContainerMouseOver(2087/12)、onContainerMouseOut(2100/13)、_updateAwarenessDotsInPlace(1557/28)、_refreshPopoverIfOpen(1587/18) | ~400 |
| **settings-panel** | renderAdminModelOptions(945/16)、isManageableGroupIdentity(962/3)、normalizeGroupMembers(966/17)、getChatMemberRefs(984/3)、getAvailableMemberIdentities(988/6)、renderGroupMemberRows(997/38)、renderAddMemberControl(1037/3)、renderFilesBridgeSection(1043/33)、renderSettingsPanel(1077/53)、renderAdminConfigBody(1133/68)、loadAdminModelOptions(2747/28)、saveAdminModel(2776/14)、changeWorkDir(2729/17)、loadGroupMd(2660/22)、saveGroupMd(2683/17)、_wgMdAutoSave(2703/9)、_flushGroupMdAutoSave(2713/6)、_setMdSaveStatus(2720/8)、editGroupMd(2806/8)、toggleAdminConfig(2801/4)、openFilesPanel(2791/9)、handleSettingsFieldChange(2628/31)、updateGroupMembers(2815/10)、addGroupMember(2826/13)、removeGroupMember(2840/14)、addSelectedMember(2855/5)、renderAddMemberListItems(2863/24)、closeAddMemberModal(2888/10)、openAddMemberModal(2899/70) | ~580 |
| **actions** | handleSend(2114/70)、handleApproveDispatch(2187/13)、enterRejectDispatchState(2203/24)、exitRejectDispatchState(2228/5)、updateRejectInputVisual(2234/9)、handleAdminRestart(1744/15)、toggleDropdown(2574/4)、handleModeChange(2579/17)、navigateToSession(2597/14)、navigateToSessionRecord(2612/15)、handleDissolveChat(2970/21)、handleArchiveChat(2992/13)、handleUnarchiveChat(3006/13)、handleDeleteChat(3020/31)、handleNewChat(3054/**129**)、openImportModal(3186/63)、closeImportModal(3250/4)、renderImportedList(3255/16)、renderSearchResults(3272/20)、doImportSearch(3293/24)、doImportSession(3318/23)、doUnimportSession(3342/19)、handleInterruptSession(3365/26) | ~650 |
| **rendering/lifecycle** | _captureEditorSelection(1227/12)、_restoreEditorSelection(1240/49)、renderWorkGroupSurface(1290/98)、renderConversation(1210/13)、renderEmptyConversation(1204/3)、refreshMain(1391/35)、refreshMessagesOnly(1427/35)、refreshHeaderAndMessages(1463/53)、refreshAdminBarOnly(1522/33)、scrollToBottom(1606/8)、startPolling(1637/11)、stopPolling(1649/6)、_saveCurrentDraft(1658/10)、_loadDraft(1669/10)、_restoreEditorFromDraft(1680/10)、selectChat(1693/50)、init(3937/14)、setupScrollListener(3952/23)、deactivate(4182/15)、softRefresh(4258/3) | ~500 |
| **event-handlers** | **onContainerClick(3394/160)**←最大事件代理、onContainerInput(3555/40)、onContainerChange(3596/3)、onContainerKeyDown(3600/15)、onContainerContextMenu(3618/**109**)、onContainerDragOver(3892/9)、onContainerDragLeave(3902/8)、onContainerDrop(3911/23) | ~370 |
| **context-menu** | _showContextMenu(3729/39)、_hideContextMenu(3769/6) | ~45 |
| **annotations** | _openAnnotationEditor(3778/54)、_closeAnnotationEditor(3833/4)、_saveAnnotation(3838/13)、_deleteAnnotation(3852/12) | ~83 |
| **voice-input** | _playVoiceSound(3978/10)、_updateVoiceUI(3989/6)、toggleVoiceRecording(3996/7)、startVoiceRecording(4004/**100**)、stopVoiceRecording(4105/7)、_cancelVoiceRecording(4113/5)、sendAudioToASR(4119/31)、insertTextAtEditorCursor(4151/28) | ~194 |
| **utils** | esc(188/3)、formatTime(192/12)、_formatCreateDate(205/7)、_extractMdSummary(213/4)、getMemberName(218/5)、getIdentityName(224/4)、_avatarInitials(258/6)、generateAvatar(265/19)、collectActiveSessions(285/22)、collectSessionsByIdentity(309/9) | ~91 |

### 1.3 域间依赖矩阵

```
              data  chat  msg  input  pop   set   act  rend  evt  ctx  ann  voi
data/api       -
chat-list      ✓    -
msg-renderer   —    —     —    (依赖 utils+state，不直接依赖其他域函数)
input          ✓    —     —    -      (mention↔session-bar↔popover 互相调用)
popover        ✓    —     ✓    ✓      -     (渲染消息状态、读取 session 选择)
settings       ✓    —     —    —      —     -    (独立度最高，但写全局状态)
actions        ✓    ✓     —    ✓      ✓     ✓    -  (几乎依赖所有域)
rendering      ✓    ✓     ✓    ✓      ✓     —    ✓   -  (编排所有渲染)
event-handlers —    ✓     —    ✓      ✓     ✓    ✓   ✓    -   (统一派发入口)
context-menu   —    —     —    ✓      —     —    ✓   —    —    -
annotations    —    —     ✓    —      —     —    —   ✓    —    —    -
voice-input    —    —     —    ✓      —     —    ✓   —    —    —    —    -
```

**高耦合热点**：
- `rendering` 域编排所有渲染，依赖 data/popover/input/settings
- `actions` 域（尤其 `handleSend`、`selectChat`）几乎触碰所有状态
- `event-handlers`（`onContainerClick` 160 行）是统一派发入口，调用 actions/input/popover/settings 各域

### 1.4 跨文件引用

- **app-ui.js**：通过 `window.WorkGroupUI` 命名空间（行 4262-4288）调用 `render`/`init`/`deactivate`/`startPolling`/所有 `onContainer*` 事件代理（行 1940-2083，共 20 处）
- **app-main.js**：`WorkGroupUI.softRefresh()`（轮询轻量刷新，行 2723）
- **inline onclick**：`window._wg*` 系列（14 个，行 4200-4254）被 settings 面板 HTML 内 inline 调用

### 1.5 拆分可行性评估

**难度：高**。IIFE 闭包共享 ~50 个状态变量，纯物理拆分（多文件）会破坏闭包可见性。

### 1.6 建议方案

采用 **"共享状态对象 + 多文件挂载"** 模式（与当前 `window.WorkGroupUI` 风格一致）：

1. **抽取共享状态层** `wg-state.js`：把 50 个模块变量封装为单一 `WgState` 对象（或 `WgState` + 细分 `WgInput`/`WgVoice` 子对象），所有子文件通过 `WgState.xxx` 读写。
2. **按低耦合域优先拆出**（风险递增）：
   - `wg-voice-input.js`（voice 域，~194 行）：依赖少，仅写 `_voice*` 状态 + input 编辑器，**最易拆出**
   - `wg-annotations.js`（annotations 域，~83 行）：仅依赖 `_annotations` + message-list，**易拆出**
   - `wg-context-menu.js`（context-menu 域，~45 行）：通用工具，**易拆出**
   - `wg-settings-panel.js`（settings 域，~580 行）：独立度最高，但函数量大、含 modal，**中等**
   - `wg-popover.js`（popover 域，~400 行）：`showMemberPopover` 216 行是巨型函数，**中等偏高**
3. **保留核心** `wg-core.js`：rendering / event-handlers / actions / data 四个高耦合域（~1600 行）暂不拆，作为"主文件"继续承载，因为它们彼此调用密集。

**预计**：可拆出约 1300 行（voice+annotations+ctx+settings+popover），主文件降至 ~3000 行。

---

## 二、`settings-overlay.js`（1530 行，全局作用域）

### 2.1 架构特征

**全局作用域顶层函数 + `window.xxx` 导出**，无 IIFE 包裹。状态通过 `window.ClawFW.*` 集中存储（`settingsOpen`/`settingsData`/`settingsEditing`/`_speechModelConfig`/`_speechPresets`/`usageInfo`），天然跨文件友好。依赖全局函数：`escapeHtml`、`currentLanguage`、`getCurrentAgentRecord`、`updateChatContextBar`。

### 2.2 函数清单（按域分类）

| 域 | 关键函数（行号/行数） | 小计行数 |
|----|----------------------|---------|
| **settings host + 文本模型设置** | ensureSettingsHost(8/9)、openSettings(18/25)、closeSettings(44/9)、**renderSettingsOverlay(880/123)**←最大、switchSettingsTab(1004/4,w)、renderSettingsEditForm(1202/96)、createSettingsHeaderRowHTML(1299/18)、addSettingsHeaderRow(1318/18,w)、onSettingsHeaderModeChange(1325/10,w)、addSettingsPreset(1336/22)、editSettingsPreset(1359/4)、cancelSettingsEdit(1364/9)、deleteSettingsPreset(1374/7)、toggleApiKeyVisibility(1382/17)、saveSettingsPreset(1400/41)、applySettingsPreset(1442/47)、saveSettingsConfig(1490/27) | ~480 |
| **语音模型设置** | renderSpeechModelSection(1009/78)、renderSpeechPresetEditForm(1088/38)、addSpeechPreset(1127/4,w)、editSpeechPreset(1132/4,w)、cancelSpeechPresetEdit(1137/4,w)、deleteSpeechPreset(1142/7,w)、applySpeechPreset(1150/13,w)、saveSpeechPreset(1164/19,w)、saveSpeechFullConfig(1184/17) | ~200 |
| **usage-info（用量面板）** | ensureUsageInfoHost(54/9)、usageInfoLocalDateString(64/8)、usageInfoParseLocalDate(73/5)、usageInfoToday(79/3)、usageInfoDateDaysAgo(83/5)、usageInfoDefaults(89/19)、getUsageInfoState(109/4)、usageInfoRangeDates(114/6)、loadUsageInfoCalendarData(121/17)、openUsageInfo(139/9)、closeUsageInfo(149/5)、loadUsageInfoData(155/25)、usageInfoNumber(181/7)、usageInfoFullNumber(189/3)、usageInfoPct(193/3)、usageInfoLabel(197/18)、renderUsageMetric(216/9)、usageInfoDateRange(226/10)、usageInfoEventDate(237/6)、usageInfoEventHour(244/5)、usageInfoEmptyBreakdown(250/3)、usageInfoAddBreakdown(254/7)、usageInfoSmoothPath(262/**48**)←SVG贝塞尔、usageInfoBucketRows(311/51)、usageInfoModelOptions(363/9)、renderUsageInfoTrend(373/83)、renderUsageInfoBars(457/80)、renderUsageInfoCalendar(538/43)、renderUsageInfoMainChart(582/8)、renderUsageInfoChartControls(591/29)、renderUsageInfoGroups(621/35)、renderUsageInfoEvents(657/33)、renderUsageInfoGroupControls(691/15)、renderUsageInfoOverlay(707/78)、setUsageInfoRange(786/5,w)…setUsageInfoChartModelFromButton(871/8,w)共7个window、bindUsageInfoTooltip(817/21)、setUsageInfoGuide(839/6)、scrollUsageInfoCalendarToLatest(846/5)、moveUsageInfoTooltip(852/5) | **~760** |
| **window 集中导出** | (1518-1530) | ~13 |

> 注：`w` = 通过 `window.xxx` 导出

### 2.3 域间依赖矩阵

```
               settings-host   speech        usage-info
settings-host   -              调用 renderSettingsOverlay 互调
speech          依赖 renderSettingsOverlay 刷新  -
usage-info      独立            独立            -
```

**三域几乎完全独立**。usage-info 是最大的子域（760 行，占全文件 ~50%），且与 settings/speech 无函数级交叉，仅共享 `window.ClawFW` 容器和全局 `currentLanguage`。

### 2.4 跨文件引用

- **app-ui.js**：`closeSettings()`（行 2548）、`openSettings()`（行 2550）、`openUsageInfo()`（行 2557）——仅 3 处直接调用
- 其余交互（tab 切换、preset 增删、用量筛选）全部通过 **inline `onclick`** 调用 `window.xxx`，无 JS 层直接引用

### 2.5 拆分可行性评估

**难度：低**。三域逻辑正交，状态已集中在 `window.ClawFW`，无闭包耦合。

### 2.6 建议方案

**按域直接物理拆为 3 个文件**：

1. **`usage-info-overlay.js`**（~760 行）：usage-info 全部 40+ 函数 + 7 个 window 导出。这是**最值得优先拆出**的——它是一个完全自包含的"用量仪表盘"，包含 SVG 图表渲染（趋势/柱状/日历热力），逻辑最重、与模型设置无关。
2. **`speech-settings.js`**（~200 行）：语音模型预设管理 9 个函数。
3. **`model-settings.js`**（~480 行）：文本模型预设管理 + overlay host + `renderSettingsOverlay` 主编排。
4. 三文件均保持全局作用域风格，在 `index.html` 中按序加载即可，**无需重构状态层**。

**预计**：单文件最大 760 行（usage-info），其余两文件各 ~200/~480 行，可读性显著提升。

---

## 三、`debug-panels.js`（1426 行，全局作用域）

### 3.1 架构特征

**全局作用域顶层函数 + `window.xxx` 导出**。模块级状态仅 3 个：`summaryPopupData`、`_summaryGenGuard`(Map)、`featureUploadFile`。大量依赖**外部全局变量**（声明于 `app-core.js`）：`currentMcpInfo`、`logFilters`、`logPanelScope`、`selectedOverviewLifecycle`、`currentHookInspector`、`currentOverviewSnapshot`、`currentLogs`、`activeFeaturePanel`、`featurePanelBody` 等，以及外部全局函数：`t()`、`escapeHtml()`、`renderMarkdown()`、`getRuntimeAwareAgentRecord()`、`getFeatureStatus()`、`renderCurrentMainView()`、`featurePanels`(运行时注册表)。

### 3.2 函数清单（按面板域分类）

| 域 | 关键函数（行号/行数） | 小计行数 |
|----|----------------------|---------|
| **overview / monitor（Usage/Token 渲染）** | formatMetricNumber(63/6)、formatRate(70/6)、getLatestCallSummary(77/5)、getUsageBreakdown(83/27)、renderTokenBar(111/11)、renderRateRing(123/14)、renderUsageCard(138/24)、renderCacheCard(163/20)、renderContextChip(184/9) | ~122 |
| **MCP 面板** | setCurrentMcpInfo(198/3)、renderMcpItems(348/18)、renderMcpPanel(367/47) | ~68 |
| **logs 面板** | getLevelWeight(206/4)、formatLogTimestamp(211/10)、safePrettyJson(222/7)、getFilteredLogs(230/33)、renderLogsPanel(264/79) | ~133 |
| **lifecycle-docs + 选择器** | **lifecycleDocs 常量(419-666/~248)**←纯数据、selectOverviewLifecycle(672/6)、openFeatureDetails(681/6)、closeFeatureDetails(688/6)、openRepositoryPackageDetails(698/4)、closeRepositoryPackageDetails(703/4) | ~274 |
| **summary 弹窗** | getOrCreateSummaryOverlay(715/14)、renderSummaryBodyContent(730/50)、updateSummaryOverlayDOM(781/23)、openSummaryPopup(805/67)、closeSummaryPopup(873/5)、regenerateSummary(882/47) | ~206 |
| **repo 过滤 + feature upload** | setRepoSearchQuery(936/5)、setRepoSourceFilter(942/5)、openFeatureUploadDialog(955/40)、closeFeatureUploadDialog(996/5)、handleFeatureUploadFile(1002/26)、submitFeatureUpload(1029/37) | ~118 |
| **结构/监控/特性/Hook 面板 render** | renderStructurePanel(1075/48)、renderMonitorPanel(1124/48)、renderFeaturesPanel(1173/**101**)←最大、renderReverseHooksPanel(1275/64) | ~261 |
| **面板入口（编排）** | renderFeaturePanel(1344/72)、toggleFeaturePanel(1417/9) | ~81 |

### 3.3 面板间共享函数

- `renderFeaturePanel`（编排入口）通过 `featurePanels` 注册表（在 app-ui.js 行 2460-2484 定义）调用所有面板 render：`renderStructurePanel`/`renderMonitorPanel`/`renderFeaturesPanel`/`renderReverseHooksPanel`/`renderLogsPanel`/`renderMcpPanel`
- `renderMonitorPanel` 依赖 overview 域的 `getLatestCallSummary`/`getUsageBreakdown`/`renderUsageCard`/`renderCacheCard`/`renderContextChip`/`formatMetricNumber`
- `renderStructurePanel` 依赖 `lifecycleDocs` 常量 + `selectOverviewLifecycle`
- `renderFeaturesPanel`/`renderReverseHooksPanel` 共享 `getFeatureStatus`/`getStatusBadgeClass`（外部）+ `shortenSourcePath`（外部）
- `safePrettyJson` 被 `renderLogsPanel` 和 `renderMcpPanel` 共用
- summary/upload/repo 三组与面板 render 完全独立（独立弹窗）

### 3.4 跨文件引用

- **app-main.js**：`renderFeaturePanel()`（**~15 处**，最高频）、`setCurrentMcpInfo()`（2 处）、`window.openSummaryPopup()`（2 处）
- **app-ui.js**：`renderFeaturePanel()`（3 处）、`toggleFeaturePanel()`（1 处）、`featurePanels` 注册表内引用 6 个 render 函数（行 2460-2484）
- **inline onclick**：`selectOverviewLifecycle`/`openFeatureDetails`/`closeFeatureDetails`/`openSummaryPopup`/`closeSummaryPopup`/`regenerateSummary`/`setRepoSearchQuery` 等通过 `window.xxx` 调用

### 3.5 拆分可行性评估

**难度：中低**。全局作用域、状态少；主要风险在于各面板 render 共享外部全局变量（`currentHookInspector` 等），但这些是**只读消费**，拆分后多文件共享同一全局变量无副作用。

### 3.6 建议方案

**按面板域物理拆为 4 个文件**：

1. **`debug-overview.js`**（~400 行）：overview/monitor 渲染函数（9 个）+ lifecycleDocs 常量（248 行纯数据，可考虑单独 `lifecycle-docs.json` 或保留为常量文件）+ 选择器函数 + `renderStructurePanel`/`renderMonitorPanel`。这是耦合最紧的一组（monitor 强依赖 overview 工具函数）。
2. **`debug-logs.js`**（~70 行）：logs 域 5 个函数。`safePrettyJson` 可提升为共享（或复制一份给 mcp）。
3. **`debug-mcp.js`**（~50 行）：MCP 域 3 个函数 + 复用 `safePrettyJson`。
4. **`debug-features-hooks.js`**（~170 行）：`renderFeaturesPanel` + `renderReverseHooksPanel`。
5. **`debug-summary-upload.js`**（~320 行）：summary 弹窗（6 函数 ~206 行）+ repo 过滤（2 函数）+ feature upload（4 函数）。三者都是独立弹窗，与面板 render 无交叉。
6. **`debug-panel-host.js`**（~80 行）：`renderFeaturePanel` + `toggleFeaturePanel`（编排入口，最后加载）。

**预计**：最大单文件 ~400 行（overview），多数 < 200 行。

---

## 四、综合结论与优先级建议

| 文件 | 行数 | 拆分难度 | 收益 | 推荐优先级 |
|------|------|---------|------|-----------|
| **settings-overlay.js** | 1530 | **低** | **高** | ★★★ 第一优先 |
| **debug-panels.js** | 1426 | 中低 | 高 | ★★☆ 第二优先 |
| **work-group-ui.js** | 4290 | **高** | 高但风险大 | ★☆☆ 第三优先（需先抽状态层） |

### 关键判断

1. **settings-overlay.js 最值得立即拆**：三域正交、状态已集中在 `window.ClawFW`、跨文件 JS 引用仅 3 处，几乎零风险。usage-info 子域（760 行，含 SVG 图表）单独成文件后可读性提升最明显。

2. **debug-panels.js 拆分收益高且风险可控**：各面板 render 共享的全局变量都是只读消费，物理拆分不引入新耦合。`renderFeaturePanel` 作为编排入口必须最后加载，保持对 `featurePanels` 注册表的引用。

3. **work-group-ui.js 不建议贸然物理拆分**：~50 个闭包共享状态是其核心架构约束。若要拆，**必须先引入共享状态层（`WgState` 对象）**作为前置重构，否则拆出的子文件只能用 `window.` 全局变量传状态，反而增加混乱。建议仅先拆出 **voice-input**（~194 行，依赖最浅）和 **annotations**（~83 行）作为试点，验证状态抽取方案可行后再逐步推进。

4. **三文件共同的低成本优化**：`lifecycleDocs`（debug-panels.js 419-666，248 行纯文档常量）可独立为数据文件，立即给 debug-panels.js 减负 ~17%。
