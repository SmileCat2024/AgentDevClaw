# ESM 迁移 P0.8：P1 九域逐键分桶定案

日期：2026-11-16
状态：定案冻结。两个开放边界问题（§2、§3）与遗留项（§8）均已裁决，P1 各域键清单以本文为准
输入：[2026-11-16-frontend-esm-strangler-migration.md](2026-11-16-frontend-esm-strangler-migration.md)（P1 九域表与附录 A）、`.frontend-globals-baseline.json`、`public/src/app-core.js`（全文逐行读）、`public/src/app-main.js`（全文逐行读）、`public/src/modules/session-view-state.js`（全文逐行读）、九域全部点名键与其余 app-core 台账键的源码级 grep 写点/消费面扫描
性质：只读调查。本文所有行号以 2026-11-16 的 `public/src` 源码为准；写方只列文件名，行号仅对关键写点给出。

---

## 0. 结论速览

1. **九域键清单已逐键定案**（§1）：每键有定义位置、写方文件、挂载形态（`defineKey` 状态桥 / 纯函数 export / window 赋值保留）。
2. **边界 a（域 6 vs 域 7）定案**：判据 =「函数只解析 record 参数 → 域 6；要翻 `allAgents` 列表或承载列表/详情/call 数据 → 域 7」。`findAgentByIdentity` / `getRuntimeRecord` / `resolveWorkspaceFallbackAgentId` / `isUiOnlyAgentId` 归域 7；`_agentRuntimeCache` 缓存族归域 5；`_agentDetailPayloadCache` 详情族归域 7；viewer 绑定族（`setViewerSessionBinding` / `_viewerSessionBindings` / `_deriveRuntimeSessionIdFromAgents`）归域 6。证据链见 §2。
3. **边界 b 定案**：`currentRuntimeAgentId` 归**域 9**（全部 6 个运行时写方文件都是切换/导航编排事务；域 5 只读它做 stale check）；`currentMessages` 归**域 5**（唯一运行时写点是 `session-view-state.js` 的 `applySessionViewPatch`，编排侧只读）。证据链见 §3。
4. **featurePanelWidth 甄别结论**：是**布局状态**（px 数值），不是 DOM 引用。随域 4 一起迁移但必须走 `defineKey` 状态桥。证据见 §4。
5. **数字核对**：fan-in 前十键 7 个与 plan 附录 A 完全一致，3 个实测略高（`escapeHtml` 80→83、`render` 57→60、`fetch` 94→95），不影响分桶。明细见 §5。
6. **勘误两条**：plan 域 2 的 `tHtml` 已不存在（源码、台账均无）；plan 域 1「纯函数、零状态」不准确（`markdown-utils.js` 有 1 个模块级状态键 `_currentBleed` + 2 处挂载副作用）。见 §7。

---

## 1. 九域逐域定案清单

挂载形态三值约定：

- **export**：纯函数 / 只读常量，无状态、无写点。ESM `export` 即可，不需要桥。
- **桥**：状态键。经 P0.1 `kernel-state.js` 的 `defineKey(domain, key, initial)` 挂访问器桥，未迁移消费方裸读裸写语义不变。
- **window 保留**：键本体就是 `window` 属性（如 `ClawToast`）。ESM 化后模块执行时继续 `window.X = ...`，消费方 `typeof X` / 裸读均不依赖访问器，无需 `set` 桥。

「写方」列只列赋值/变异发生的文件（不含纯读取）；只有定义处一个写点的键标「定义处」。短名约定：`app-core` / `app-main` / `app-ui` = `public/src/` 根级同名文件，其余为 `public/src/modules/` 下。

### 1.1 域 1：markdown / HTML 工具

落点：`modules/markdown-utils.js`（648 行）整文件 → ESM。fan-in 主键：`escapeHtml` 83、`renderer` 19。

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `renderer` | markdown-utils.js:5 | 定义处（`new marked.Renderer()`） | export（模块级实例，读多写无） |
| `escapeHtml` | markdown-utils.js:37 | 定义处 | export |
| `extractDisplayMathBlocks` | markdown-utils.js:70 | 定义处 | export |
| `FRONTMATTER_MAX_LINES` / `FRONTMATTER_MAX_CHARS` | markdown-utils.js:129/130 | 定义处 | export |
| `looksLikeFrontmatterBlock` / `unquoteYamlValue` / `parseFrontmatterRows` / `splitMarkdownFrontmatter` | markdown-utils.js:133/146/157/189 | 定义处 | export |
| `renderFrontmatterHtml` / `renderFrontmatterValue` / `renderDisplayMathLatex` | markdown-utils.js:208/218/224 | 定义处 | export |
| `splitMarkdownBlocks` / `isEditableMarkdownBlock` / `joinMarkdownBlocks` / `replaceMarkdownBlock` / `renderMarkdown` | markdown-utils.js:246/263/268/278/297 | 定义处 | export |
| `wrapMarkdownTables` / `updateMarkdownTableFadeState` / `upgradeWideTable` / `enhanceMarkdownTables` / `tableToMarkdown` / `findTableFromActionButton` | markdown-utils.js:321/334/350/381/422/436 | 定义处 | export |
| `copyMarkdownTable` / `openTableZoom` / `copyMarkdownCode` | markdown-utils.js:442/483/524 | 定义处 | export |
| `CHAT_ROW_MAX_WIDTH_PX` | markdown-utils.js:567 | 定义处 | export |
| `_currentBleed` | markdown-utils.js:568 | 定义处 + `refreshMarkdownTableBleed`(570) | **桥**（模块级状态；仅域内读写，若终局全消费方走 import 可不挂桥、域内私有化） |
| `refreshMarkdownTableBleed` / `initMarkdownTableBleedObserver` / `enhanceMathInElement` | markdown-utils.js:570/580/603 | 定义处 | export |

域内注意：

- plan 域 1 备注「纯函数、零状态」**需修正**：`_currentBleed` 是模块级 `let`（滚动渐隐判定读它），且文件有 2 处挂载副作用——`window.ClawFW.actions.registerMany({...})`（:638）与 `window.addEventListener('load', ...)`（:644）。迁移时副作用保留为模块顶层执行（时序不变），不新增 init 协议。
- `escapeHtml` 在 5 个 classic 文件里有 **IIFE 局部同名副本**（annotations.js:45、auth-client.js:43、bg-panel.js:102、claw-select.js:51、remote-claw-settings.js:462，均为函数内 `function escapeHtml` 局部定义，不遮蔽全局不覆盖全局）；另 2 个 ESM 插件有模块局部代理（plugins/agent-studio/index.js:17、plugins/claw-guide/guide-docset.js:32，走 `pluginHost.env.escapeHtml`）。这些副本**不是**定义方，域 1 迁移不影响它们；P2 清理局部副本是可选收尾，不在本域范围。
- `renderMarkdown` 在 plugins/claw-guide/guide-docset.js 有一处模块局部同名（代理实现），同理不受影响。

### 1.2 域 2：i18n / 环境

落点：`i18n.js`（936 行）+ `modules/theme-lang.js`（88 行）合并 → ESM（与 plan 一致）。本域另收编 app-core 中读 `currentLanguage` 的本地化格式化函数 8 个。

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `I18N` | i18n.js:1 | 定义处 | export |
| `t` | i18n.js:933 | 定义处 | export + **桥 get**（classic 消费面为超短键裸读，fan-in 未入前十但为全库最高频调用；走 defineKey 保裸读） |
| `currentLanguage` | app-core.js:587 | app-ui.js:1968（语言切换按钮） | **桥** |
| `currentTheme` | app-core.js:586 | theme-lang.js:69（`applyTheme` 内） | **桥** |
| `applyLanguage` / `applyTheme` / `setThemeStylesheet` / `renderThemeToggle` | theme-lang.js:18/68/83/10 | 定义处 | export |
| `showAgentStartError` | theme-lang.js:5 | 定义处 | export（语义是启动错误提示、非 i18n，仅因定义文件在此而随域走；不搬行文） |
| `formatPresetDisplayName` | app-core.js:593 | 定义处 | export |
| `localizeWorkspaceValue` | app-core.js:1230 | 定义处 | export |
| `formatWorkspaceDate` | app-core.js:1241 | 定义处 | export |
| `getTimeOfDayLabel` | app-core.js:1257 | 定义处 | export |
| `formatRelativeTime` | app-core.js:1274 | 定义处 | export |
| `getTimeGroupLabel` | app-core.js:1339 | 定义处 | export |
| `getSessionRecencyClass` | app-core.js:1361 | 定义处 | export |
| `getSessionShortTime` | app-core.js:1385 | 定义处 | export |

域内注意：

- **plan 勘误**：`tHtml` 不存在（源码 0 命中、台账无此键）。域 2 键清单只有 `t`。
- `applyTheme(currentTheme)` / `applyLanguage()` 在 app-main.js:1853-1854 顶层同步调用（R1：boot 前触达）→ 域 2 是 classic 消费方触达最高的域之一，桥必须先于 app-main 加载序就位（P0.1 桥文件插在 i18n/app-core 之后的既定安排覆盖此点）。
- `showAgentStartError` 的实际消费方在 app-main.js（`handlePrebuiltAgentClick` 的 catch）。定义文件与语义错位是既有事实，迁移不修（搬代码不改行为）。

### 1.3 域 3：toast

落点：`modules/toast-notify.js`（505 行）整文件 → ESM。

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `ClawToast` | toast-notify.js:499（IIFE 内 `window.ClawToast = {...}`） | 定义处 | **window 保留**（对象一次性赋值；36 个文件消费，大量 `typeof ClawToast === 'undefined'` 守卫式裸读，经 window 属性天然兼容） |

域内注意：无状态键、无写点、无时序敏感面，是最轻的域。IIFE 顶层执行即完成挂载，ESM 化后维持模块顶层执行。

### 1.4 域 4：DOM 引用

落点：新 ESM `dom-refs` 域 + 桥（与 plan 一致）。43 个 DOM 引用键全部定义在 app-core.js:441-485 的 `const X = document.getElementById('...')` 区块，**除 `featurePanelWidth` 外写方均为定义处**（R3：boot 一次性赋值，哑存储天然承接）。另有 3 键带挂载副作用（见下）。

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `container` | app-core.js:441 | 定义处 | 桥（get-only 语义，`set` 成对提供但终局无外部写方） |
| `agentList` / `prebuiltAgentList` / `toolAgentList` / `externalAgentList` | app-core.js:442-445 | 定义处 | 桥 |
| `prebuiltGroup` / `toolGroup` / `externalGroup` | app-core.js:446-448 | 定义处 | 桥 |
| `prebuiltCount` / `toolCount` / `externalCount` | app-core.js:449-451 | 定义处 | 桥 |
| `currentAgentTitle` | app-core.js:452 | 定义处 | 桥 |
| `sidebar` / `sidebarToggle` / `sidebarResizer` / `sidebarCollapseHint` | app-core.js:453-456 | 定义处 | 桥 |
| `featurePanel` / `featurePanelTitle` / `featurePanelBody` / `featurePanelResizer` / `featurePanelCollapseHint` | app-core.js:457-461 | 定义处 | 桥 |
| `agentContextMenu` / `restartAgentAction` / `stopAgentAction` / `deleteAgentAction` | app-core.js:462-465 | 定义处 | 桥 |
| `compactContextMenu` / `compactSummaryAction` / `compactTrimAction` / `compactBranchAction` | app-core.js:466-469 | 定义处 | 桥 |
| `projectContextMenu` / `deleteProjectAction` / `featureRepoContextMenu` / `deleteFeatureAction` | app-core.js:470-473 | 定义处 | 桥 |
| `ctxMenu` | app-core.js:474 | 定义处 | 桥 |
| `followLatestButton` | app-core.js:475 | 定义处 | 桥 |
| `workspaceTabsBar` | app-core.js:476 | 定义处 | 桥 |
| `projectDocsetToggle` / `chatProcessToggle` / `projectDocsetOverlay` / `projectDocsetSheet` | app-core.js:477-480 | 定义处 | 桥 |
| `languageToggle` / `themeToggle` / `settingsToggle` | app-core.js:483-485 | 定义处 | 桥 |
| **`featurePanelWidth`** | app-core.js:585（`let featurePanelWidth = 460`） | app-ui.js:1800/2122、ctx-menu-handlers.js:467 | **桥（状态语义，见 §4 甄别）** |

域内注意：

- app-core.js:486-498 有 3 段 `addEventListener` 挂载（`projectDocsetToggle`、`chatProcessToggle`、`projectDocsetOverlay` 的 click，转发到 `window.toggleProjectDocsetOverlay` / `window.toggleChatProcessVisibility`）。迁移时随域 4 顶层执行，顺序不变。
- `container` 的写点扫描有大量噪声文件（annotations/choice-input 等 20 文件），逐点核验均为**局部同名**（函数参数或 IIFE 局部 `const container`），全局 `container` 真实写方仅定义处。域 4 是全部九域中唯一「写方仅定义处」的状态域，setter 转发语义最简单。

### 1.5 域 5：会话视图状态

落点：`modules/session-view-state.js`（326 行）已高度内聚（与 plan 一致），追加两层归入：**(a)** runtime 视图缓存族（app-core.js，写方全部在 app-core.js 内的 3 个缓存函数）；**(b)** 会话数据兼容存储键（plan 未点名，但其唯一规范写入门就是本域的 `applySessionViewPatch`，头注自证："existing globals remain compatibility storage"，session-view-state.js:289）。

**5a. session-view-state.js 本体（22 键，全文件 → ESM）**

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `normalizeSessionViewIdentity` / `normalizeSessionViewRuntimeId` / `EMPTY_SESSION_META` / `normalizeSessionMetaField` / `normalizeSessionMetaCount` / `normalizeSessionMeta` / `normalizeSessionModelState` | session-view-state.js:22/29/33/43/47/51/67 | 定义处 | export |
| `_sessionMeta` | session-view-state.js:79 | 本文件内（`applySessionViewPatch`:254） | export + 域内私有（终局撤桥） |
| `_sessionViewIdentity` | session-view-state.js:80 | 本文件内（:209、:272） | 同上 |
| `_sessionViewGeneration` | session-view-state.js:85 | 本文件内（:283） | 同上 |
| `_sessionViewInputRequestsRevision` / `_sessionViewMessagesRevision` | session-view-state.js:87/89 | 本文件内（:214/219） | 同上 |
| `_sessionViewModelRuntimeId` | session-view-state.js:90 | 本文件内（:248） | 同上 |
| `getCurrentSessionViewIdentity` / `captureSessionViewToken` / `isSessionViewMessagesCurrent` / `isSessionViewInputRequestsCurrent` / `isSessionViewTokenCurrent` / `commitSessionViewState` / `readCurrentSessionViewState` / `applySessionViewPatch` / `commitSessionViewPatch` | session-view-state.js:92/102/113/117/121/144/164/181/295 | 定义处 | export + **桥 get**（消费面 12/12/11/8/5 个文件裸读；`applySessionViewPatch` 需要经桥转写外部状态键，见 5c） |

**5b. runtime 视图缓存族（从 app-core.js 划入，8 键）**

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `MAX_CACHED_RUNTIME_VIEWS` | app-core.js:802 | 定义处 | export |
| `_agentRuntimeCache` | app-core.js:803 | **仅 app-core.js**（save:1039/restore:1100/clear:1151 内部；app-core 外零直接消费） | 桥→终局域内私有 |
| `saveCurrentRuntimeToCache` / `restoreRuntimeFromCache` / `clearAgentRuntimeCache` | app-core.js:1031/1098/1149 | 定义处 | export |
| `_sessionViewIdentityFromContextKey` | app-core.js:1087 | 定义处 | export |
| `getRuntimeCacheTodoPlanFallback` / `getRuntimeCacheTodoPlanSignature` | app-core.js:1014/1024 | 定义处 | export |

**5c. 会话数据兼容存储键（从 app-core 台账划入，10 键 + 1 个跨文件键）**

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `currentMessages` | app-core.js:558 | **仅 session-view-state.js:215**（规范写入门） | **桥**（编排/渲染 19 文件裸读） |
| `currentInputRequests` | app-core.js:559 | **仅 session-view-state.js:220**（另同步 `window.lastInputRequests`:221） | **桥** |
| `toolRenderConfigs` | app-core.js:561 | 仅 session-view-state.js:230 | **桥** |
| `TOOL_NAMES` | app-core.js:562 | 仅 session-view-state.js:235 | **桥** |
| `currentHookInspector` | app-core.js:607 | overview-data.js:225 `setCurrentHookInspector`（经 :240 patch 门调用） | **桥** |
| `currentHookInspectorSignature` | app-core.js:608 | overview-data.js:228 | **桥** |
| `currentOverviewSnapshot` | app-core.js:609 | overview-data.js:234 `setCurrentOverviewSnapshot`（经 :244 patch 门调用） | **桥** |
| `currentOverviewSignature` | app-core.js:628 | overview-data.js:237 | **桥** |
| `currentTodoPlan` | app-core.js:629 | todo-plan.js:80 `setCurrentTodoPlan`（经 :251 patch 门调用） | **桥** |
| `currentTodoPlanSignature` | app-core.js:636 | todo-plan.js 内 setter | **桥** |
| `currentRuntimeConnected` | **runtime-status.js:26**（不在 app-core 台账） | session-view-state.js:276（patch 门）+ runtime-status.js 内部 | **桥**（写方在域外一文件，跨域写经桥转发的典型场景） |

域内注意：

- 域 5 是「机制 + 存储」复合域。`overview-data.js` / `todo-plan.js` 的 setter 与存储键同生命周期，随 5c 一起迁移或保留在原文件经桥写均可——**建议随迁**（否则 patch 门要跨文件调 setter，桥内转调复杂化）。
- `captureSessionViewToken` 读 `_switchEpoch`（app-core.js:731，域 9）：`session-view-state.js:106`。这是域 5 → 域 9 的唯一状态依赖，经桥读即可，不构成循环（域 9 对域 5 的依赖见 §3）。

### 1.6 域 6：身份解析（含边界定案，判据见 §2）

落点：从 app-core.js:3-5 + :840-1012 抽出 ESM `identity` 域。除标注外全部为**纯函数**（record → id 解析），无全局状态写点。

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `normalizeAgentIdentity` | app-core.js:3 | 定义处 | export |
| `normalizeResourceIdentity` | app-core.js:846 | 定义处 | export |
| `hasIdentityAlias` / `resolveIdentityAliases` | app-core.js:851/856 | 定义处 | export |
| `getParentAgentId` / `getLogicalAgentId` / `getRuntimeId` | app-core.js:865/869/891 | 定义处 | export |
| `getAgentRuntimeId` | app-core.js:938 | 定义处（template-engine.js:同名为 IIFE 局部，非全局） | export |
| `getActiveSessionId` / `getActiveWorkspaceSessionId` | app-core.js:925/953 | 定义处 | export |
| `buildLocalResourceRef` / `getCurrentControlAgentId` | app-core.js:942/914 | 定义处 | export |
| `_viewerSessionBindings` | app-core.js:964 | **仅 app-core.js**（set/get:966/977 函数体内） | 桥→终局域内私有 |
| `setViewerSessionBinding` / `getViewerSessionBinding` | app-core.js:966/977 | 定义处 | export |
| `_deriveRuntimeSessionIdFromAgents` | app-core.js:984 | 定义处 | export（读 `allAgents`，经桥） |
| `getRuntimeWorkspaceSessionId` | app-core.js:995 | 定义处 | export |
| `getRuntimeContextKey` | app-core.js:1003 | 定义处 | export + **桥 get**（10 文件消费，含 boot 窗口路径） |

域内注意：

- 域 6 依赖域 7 的三个数据键（`allAgents`、`focusedAgentId`、`currentRuntimeAgentId`，后者若按 §3 归域 9 则依赖域 9）与域 7 的 `getCurrentAgentRecord`（app-main.js:125，默认参数取当前记录）。全部**只读**，经桥读，方向单一无循环。
- `normalizeAgentIdentity` 在文件头（:1-5）有注释明示「必须在 app-core 提前声明：侧栏布局/渲染模块会在 app-main 启动完成前通过 focus/visibility 事件触发异步首屏渲染」——**R1 触线键**，域 6 的桥必须早于所有侧栏渲染模块可用（P0.1 桥加载序已覆盖）。

### 1.7 域 7：agent 列表与聚焦（含边界定案）

落点：`sidebar-render.js` 数据面 + app-core.js 状态合出 ESM `agent-store` 域（与 plan 一致）。本域分四组：核心状态、查询与形态判定、call 状态、数据加载与渲染。

**7a. 核心状态（10 键）**

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `allAgents` | app-core.js:505 | sidebar-render.js:444/583/597/618（`loadAgents` 内）、project-data.js:794 | **桥**（38 文件裸读，fan-in 前十） |
| `focusedAgentId` | app-core.js:500 | app-main.js:279/292/539/770/1177、app-ui.js:34、session-readonly-view.js:189、thread-store.js:784 | **桥**（25 文件裸读） |
| `readOnlyMode` | app-core.js:502 | app-main.js:542/806/809/815、app-ui.js:38、session-readonly-view.js:191、thread-store.js:786、workspace-actions.js | **桥** |
| `pendingPrebuiltAgentIds` | app-core.js:139 | 定义处 + app-main.js:308/312/319/326（`.add/.delete` 变异） | **桥** |
| `suppressSidebarRerender` | app-core.js:140 | ctx-menu-handlers.js、ctx-menu-items.js | **桥** |
| `restartingRuntimeIds` | app-core.js:141 | 定义处 + ctx-menu-handlers.js（`.add/.delete`） | **桥** |
| `PREBUILT_AGENTS` | app-core.js:138 | 定义处（空数组占位，运行时无写点） | export |
| `loadAgentsInFlight` | app-core.js:503 | sidebar-render.js（`loadAgents` 去重段） | **桥** |
| `lastAgentListRefreshAt` / `lastCallStateRefreshAt` | app-core.js:658/659 | app-main.js（poll 节流段） | **桥** |
| `expandedProjectIds` | app-core.js:575 | session-list-render.js / sidebar-render.js（`.add/.delete` 折叠交互） | **桥** |

**7b. 查询与形态判定（12 键，全部定义处无写点）**

| 键 | 定义位置 | 挂载 |
|---|---|---|
| `findAgentByIdentity` | app-core.js:1526 | export |
| `getRuntimeRecord` | app-core.js:1521 | export |
| `resolveWorkspaceFallbackAgentId` | app-core.js:1536 | export |
| `isUiOnlyAgentId` | app-core.js:1512 | export |
| `isUiOnlyUnit` / `isWorkspaceHostUnit` / `isWorkspaceSurfaceUnit` / `isTablessHostSurface` | app-core.js:1484/1488/1508/1496 | export |
| `PH_STYLE_WORKSPACE_AGENT_IDS` / `isPhStyleWorkspaceAgent` | app-core.js:1502/1504 | export |
| `getCurrentUnitUi` / `convertLegacyWorkspaceToUi` / `getLegacyActionLabel` / `getLegacyActionTarget` | app-core.js:1477/1425/1463/1470 | export |
| `getCurrentAgentRecord` / `getCurrentHostAgentRecord` / `getCurrentSessionHostAgentId` / `getCurrentRuntimeRecord` | app-main.js:125/5/1/11 | export + **桥 get**（`getCurrentAgentRecord` 33 文件消费，fan-in 前十） |
| `groupConnectedAgents` / `isPrebuiltAppVisible` / `orderPrebuiltByHost` / `isRuntimeItemActive` / `isAgentActive` | app-main.js:174/135/146/221/102 | export |
| `loadAgents` / `renderAgentList` | sidebar-render.js:506 / sidebar-render.js:1122 | export（`loadAgents` 为 **R2 触线键**：boot IIFE 首轮 `await loadAgents()`，app-main.js:1874） |
| sidebar-render.js 台账 state 8 键：`AGENT_ICONS`、`CONTEXT_MENU_ELEMENT_IDS`、`SIDEBAR_HANGING_PUNCT_RE`、`SIDEBAR_PIN_SVG`、`_callStatesRefreshInProgress`、`_collapsedProjectGroups`、`_sidebarRenderSuppressedByMenu`、`lastAgentListRenderSignature` | sidebar-render.js | 随文件 ESM 化：常量 4 个 export；状态 4 个域内私有 |

**7c. call 状态（11 键）**

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `_agentCallActive` | app-core.js:507 | app-main.js:881/883/1167、sidebar-render.js（`refreshAgentCallStates`:895 内 5 处）、runtime-status.js（5 处）、persistent-input.js（5 处）、input-helpers.js、voice-input.js、generative-ui-panel.js（`.set/.delete/.clear` 变异，共 7 文件） | **桥** |
| `_interruptSuppression` + `markInterruptPending` / `isInterruptSuppressed` / `clearInterruptSuppression` | app-core.js:511/522/533/550 | Map 变异仅经 3 函数（定义文件内）+ 外部调用点 | 函数 export；Map 随域私有 |
| `_recentlyFinishedRuntimes` | app-core.js:554 | app-main.js:782、runtime-status.js（`.add/.delete`） | **桥** |
| `_interruptTargetCache` + `getInterruptTargetId` / `setInterruptTargetId` | app-core.js:637/639/644 | Map 变异仅经 2 函数 | 函数 export；Map 随域私有 |
| `_lastInterruptUserActionAt` | app-core.js:638 | input-helpers.js / rollback-dialog.js（打断点击时间戳） | **桥** |
| `getNotificationCallStartedAt` | app-core.js:516 | 定义处 | export（**从 plan 域 6 清单移入域 7**：语义是 call 身份而非会话身份，唯一消费方是 `_markAgentCallStartedForNotify` / interrupt 链） |

**7d. 数据加载与详情缓存（5 键）**

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `loadAgentDetail` | app-core.js:63 | 定义处 | export |
| `loadedAgentDetailIds` | app-core.js:36 | app-core.js（loadAgentDetail 内）+ app-main.js:281/285/294（`.has/.add`） | **桥** |
| `_agentDetailPayloadCache` | app-core.js:39 | **仅 app-core.js**（loadAgentDetail:86 写、getAgentDetailPayload:42 读） | 桥→终局域内私有 |
| `getAgentDetailPayload` / `extractSessionMetaFromDetail` | app-core.js:40/44 | 定义处 | export |

域内注意：

- plan 备注「`loadAgents` 受 R2 约束，须先审 boot 时序」已核实：boot IIFE（app-main.js:1870-1884）首轮顺序为 `waitForViewerReady` → `loadFeatureTemplateMap` → `loadAgents` → `poll`。`loadAgents` 在域 7、前两者在域 9/引导层——**域 7 的 ESM 首次执行必须早于 boot 首轮**，即 classic 消费方（app-main boot）触达前桥必须就位；由于桥随 P0.1 在 classic 加载序内完成注册，此约束自动满足。**域 7 ESM 模块本身不可在顶层做任何依赖 `allAgents` 已就绪的初始化**（现状 `sidebar-render.js` 顶层无此类逻辑，迁移时保持）。
- `_agentDetailPayloadCache` 归域 7 的理由见 §2.3。

### 1.8 域 8：渲染入口

落点：app-ui.js 抽出 ESM `render-entry` 域，分发继续走 ClawHost.blocks（与 plan 一致）。含 chat-renderer 的消息渲染入口 4 函数与 debug-panel-host 的 `renderFeaturePanel`。

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `renderCurrentMainView` | app-ui.js:1319 | 定义处 | export + **桥 get**（40 文件消费，fan-in 前十；boot 窗口外高频被 poll/commit 回调裸调） |
| `selectWorkspaceSurface` / `setPreferredUnitMode` / `shouldRenderWorkspaceSurface` | app-ui.js:2 / app-ui.js:98 / app-ui.js:370 | 定义处 | export |
| `renderFeaturePanel` | debug-panel-host.js:132 | 定义处 | export + **桥 get**（21 文件消费） |
| `activeFeaturePanel` | app-core.js:570 | app-ui.js、debug-panel-host.js、rail-customize.js、resources-viewer.js、wg-core.js、wg-settings-panel.js、work-group-ui.js | **桥**（写方 8 文件，含悬置域 wg-*——桥必须兜住悬置域写） |
| `lastRenderedWorkspaceHtml` | app-core.js:723 | app-main.js:839、app-ui.js、ctx-menu-handlers.js、ctx-menu-items.js、ph-project-actions.js、ph-session-move.js、session-dialogs.js、session-list-render.js、session-mutation.js、sidebar-operations.js、thread-store.js、trim-page.js、workspace-actions.js | **桥**（写方 14 文件，九域中写方最多的状态键） |
| `lastRenderedWorkspaceScrollKey` | app-core.js:724 | app-ui.js、session-list-render.js | **桥** |
| `currentWorkspaceTab` | app-core.js:571 | app-main.js:547/822/1178、app-ui.js、assembly-actions.js、fw-config-panel.js、session-readonly-view.js、workspace-actions.js | **桥** |
| `shouldAnimateWorkspaceSurface` | app-core.js:572 | app-ui.js、assembly-actions.js、assembly-data.js、debug-summary-upload.js、feature-config.js、fw-config-panel.js、workspace-actions.js、workspace-blocks.js | **桥** |
| `workspaceSurfaceScrollCache` / `workspaceSurfaceScrollSaveRaf` | app-core.js:725/726 | app-ui.js（`saveCurrentWorkspaceSurfaceScroll` 内 Map 变异） | 桥（写方单文件） |
| `_lastRenderedChatSig` | app-core.js:727 | app-main.js:548/824、app-ui.js、chat-renderer.js、input-helpers.js、template-engine.js、thread-store.js | **桥**（写方 7 文件） |
| `render` | chat-renderer.js:1105（顶层 `function render(messages)`，全局权威） | 定义处 | export + **桥 get**（60 文件匹配；含大量同名局部：app-chat-input.js:72、sidebar-layout.js:95、remote-claw-settings.js、panel-plugins/git.js、panel-plugins/session-controls.js、plugins/coder、plugins/memo/* 均为函数内或模块内局部，不受影响） |
| `renderChatEmptyState` / `appendNewMessages` / `updateLastMessage` | chat-renderer.js:65/519/760 | 定义处 | export |
| `savedPhTabState` | app-core.js:576 | ph-session-list.js（tab 状态持久化） | **桥**（定案移入 P2 ph 域，见 §8.1；域 8 迁移时不含此键） |
| `currentWorkspaceArtifactDetail` / `currentWorkspaceDocsetDetail` / `currentProjectDocsetOpen` / `currentProjectRequirementEdit` / `currentProjectDocsetPage` | app-core.js:580-584 | app-main.js:543-546/817-821、app-ui.js、workspace-actions.js、workspace-docset.js、assembly-actions.js | **桥**（5 键同写方群，workspace surface 内容状态，成组迁移） |
| `unitModePreferences` / `workspaceSurfaceModePreferences` | app-core.js:722/504 | **app-ui.js:113/115**（`setPreferredUnitMode` 内索引写；app-ui.js:17 读） | **桥**（唯一写方是域 8 的 `setPreferredUnitMode`，随域 8 走而非域 7） |

域内注意：

- `renderCurrentMainView` 是「机制上最后可 ESM 化」的键：poll 的 commit 回调（app-main.js:1329/1335/1342 等）、switch 乐观渲染（:849/864/916）、cache restore（app-core.js:1138 区域内 applySessionViewPatch 后由调用方调）都在裸调它。R1/R2 审计：boot 窗口内无顶层直调（首个调用在 poll/switch 事务内），桥 get 就位后安全。
- `_lastRenderedChatSig` 写方含悬置域外的 thread-store.js / template-engine.js（活跃域），桥必须承载双向写。

### 1.9 域 9：编排（poll / switch）——最后动

落点：app-main.js 核心抽 ESM `orchestration` 域 + `agent-data-loader.js` 的 `loadAgentData`（与 plan 一致）。

| 键 | 定义位置 | 写方 | 挂载 |
|---|---|---|---|
| `poll` / `runPollCycle` / `runMessagesProbeCycle` / `commitMetadataUpdate` / `_runPollTailLowFrequency` / `handleCoreResponsesNotFound` | app-main.js:1058/1584/1198/1369/1459/1097 | 定义处（`poll` 的 mcp-gateway-ui.js / oauth-flow.js 命中为 IIFE 局部同名） | export + **桥 get**（poll 36 文件消费） |
| `schedulePoll` / `requestSwitch` / `flushPendingSwitch` / `switchAgent` | app-main.js:994/689/660/698 | 定义处（`switchAgent` 为 `window.switchAgent =` 赋值，全局写一处） | export（`switchAgent` 保留 `window.switchAgent` 兼容赋值或桥 get；thread-store.js:207 等 17 文件消费） |
| `getCurrentAgentRecord` | app-main.js:125 | 定义处 | 见域 7（查询面随域 7，域 9 经 import 消费；两域谁持有见 §2.4） |
| `loadAgentData` | agent-data-loader.js:18 | 定义处 | export |
| `fetchWorkspaceSessionsForPoll` / `createCompactedResumeSession` / `navigateToWorkspaceSession` / `handlePrebuiltAgentClick` / `_getSessionInputCacheKey` / `newIdempotencyKey` / `applyOptimisticWorkspaceSession` / `openPrebuiltWorkspaceSession` / `markSessionLoading` / `markActionLoading` / `clearSessionLoading` / `showCompactMenu` / `runWorkspaceActionFromEvent` / `_titleForBoundSession` / `getCurrentVisualAgentTitle` / `updateCurrentAgentChrome` / `toEpochMs` / `getInputSurfaceMode` / `isMsgMetricsEnabled` / `computeSerializedBytes` / `emitMsgMetrics` | app-main.js（各函数定义处，950/413/507/269/1846/405/381/333/629/636/640/608/575/33/61/92/253/260/1027/1036/1044） | 定义处 | export（`navigateToWorkspaceSession` / `handlePrebuiltAgentClick` / `showCompactMenu` / `runWorkspaceActionFromEvent` 现为 `window.X =` 赋值，保留 window 兼容赋值） |
| **`currentRuntimeAgentId`** | app-core.js:501 | app-main.js:540/784/1173、app-ui.js:39、agent-data-loader.js:20/30、session-readonly-view.js:193、thread-store.js:788 | **桥**（48 文件裸读，fan-in 前十；归属论证见 §3） |
| `_switchEpoch` | app-core.js:731 | app-main.js:708（`++_switchEpoch`） | **桥** |
| `pendingSwitchTarget` / `pendingSwitchSerial` | app-core.js:718/719 | app-main.js:661-692（读写均在 flushPendingSwitch/requestSwitch） | **桥** |
| `_navigationGuardEpoch` + `bumpNavigationGuard` | app-core.js:779/781 | app-main.js（多事务点 `++`）+ 消费方 ctx-menu 等经 `bumpNavigationGuard()` | **桥**（epoch 数值读点分散） |
| `_pendingSessionNavigation` + `beginPendingSessionNavigation` / `updatePendingSessionNavigation` / `clearPendingSessionNavigation` / `hasPendingSessionNavigation` | app-core.js:736/738/750/760/764 | 对象整体替换仅经 4 函数（定义文件内） | 函数 export；对象随域私有 |
| `_chatLoadingSession` / `_chatLoadingTimeout` + `beginChatLoadingSession` / `clearChatLoadingSession` | app-core.js:729/730/1202/1217 | 布尔/句柄变异仅经 2 函数；`_chatLoadingTimeout` 内部 setTimeout | 函数 export；状态随域私有 |
| `_restoredScrollTop` | app-core.js:728 | app-core.js:1141（restore 写）+ app-main.js:846/850（switch 读清） | **桥**（跨文件读写，注释明示 "set by restoreRuntimeFromCache, consumed by switchAgent"） |
| `_appliedMessagesSeq` / `_wsSessionsRevisionByHost` | app-main.js:942/948 | app-main.js 内（Map 变异） | 域内私有 |
| `_pollTimerId` / `_pollCycleInFlight` / `_pollImmediateRequested` / `_forceFullPollNextCycle` | app-main.js:935/936/937/1016 | app-main.js 内 | 域内私有 |
| `POLL_INTERVAL_MS` / `POLL_FAST_INTERVAL_MS` | app-core.js:514/515 | 定义处（feature-ui-registry.js / generative-ui-panel.js 命中为局部同名常量） | export |
| `_seenChoiceAlertIds` / `_lastChoiceAlertCheckAt` | app-core.js:556/557 | auto-title.js / checkGlobalChoiceAlerts 消费（`.add/.has`）+ app-main.js | **桥** |
| `followLatestEnabled` | app-core.js:700 | chat-viewport.js、app-core.js:1113（cache restore） | **桥**（跨域写典型：视口域写、域 5/9 读写） |
| `suppressFollowScrollEvent` / `lastManualScrollIntentAt` / `_progScrollCooldownUntil` / `followLatestEntryUntil` | app-core.js:701/702/703/704 | chat-viewport.js（跟随/冷却窗口） | **桥** |
| `FEATURE_TEMPLATE_MAP` / `loadFeatureTemplateMap` / `reloadFeatureTemplateMap` / `lastFeatureTemplateReloadAt` / `templateWarmupToken` / `_autoTitleTriggered` | app-core.js:8/14/124/657/660/563 | agent-data-loader.js:28（`FEATURE_TEMPLATE_MAP = {}`）、app-main.js（节流戳）、auto-title.js（`.add/.has`） | **桥**（R2 触线：`loadFeatureTemplateMap` 在 boot 首轮 app-main.js:1873 被 await） |

域内注意（本域为全计划时序最敏感处，与 plan 一致最后动）：

- boot IIFE（app-main.js:1870-1884）首轮触达链：`window.__clawAuthReady` → `waitForViewerReady` → `loadFeatureTemplateMap` → `loadAgents` → `ClawDesktopOpen.consumeBootOpenRequest` → `reloadFeatureTemplateMap` → `loadMcpInfo` → `poll`。域 9 的桥必须在这条链之前全部就位；由于域 9 是最后迁移，届时其余八域已 claim，桥仅承担 classic 残余消费方转发。
- `applyTheme(currentTheme)` / `applyLanguage()`（app-main.js:1853-1854）是域 9 文件顶层的**同步**语句（先于 async IIFE），依赖域 2 的函数与 `currentTheme` 键——迁移域 9 时这两行保持 classic 调用（经桥/裸标识符）直到域 2 消费方收敛。
- `poll` 循环自调度契约（app-main.js:931-934 注释「There must be exactly one owner of the self-scheduling poll loop」）随域内私有状态（`_pollTimerId` 等 4 键）整体迁移，无外部写点，安全。

---

## 2. 边界问题 a：域 6（身份解析）与域 7（agent 列表）的分界

### 2.1 事实底座

两组键全部定义在 app-core.js 相邻区域（:3-5、:840-1012 与 :1500-1547），但内聚性不同：

| 键 | 定义 | 全局写点 | 消费方（排除定义文件） | 读的全局状态 |
|---|---|---|---|---|
| `resolveIdentityAliases` | app-core.js:856 | 无 | 无直接消费（被 getLogicalAgentId/getRuntimeId/getActiveSessionId 组合调用） | 无（纯函数） |
| `getLogicalAgentId` | app-core.js:869 | 无 | 11 文件 | 无（record 参数） |
| `getRuntimeId` | app-core.js:891 | 无 | 16 文件 | 无（record 参数） |
| `getRuntimeContextKey` | app-core.js:1003 | 无 | 10 文件（app-main/app-ui/agent-data-loader/chat-viewport/input-render/session-readonly-view/session-reference-picker/thread-store/voice-input/workspace-actions） | `currentRuntimeAgentId`、`focusedAgentId`、`getCurrentAgentRecord()`→`allAgents` |
| `_viewerSessionBindings` | app-core.js:964 | 仅 set/get 函数体（:971/973/980） | 无直接（经 `getRuntimeWorkspaceSessionId`） | 无 |
| `setViewerSessionBinding` | app-core.js:966 | 定义处 | app-main.js（switchAgent:795）、thread-store.js、workspace-actions.js | 无 |
| `findAgentByIdentity` | app-core.js:1526 | 无 | **仅 app-main.js**（switchAgent:710） | `allAgents`（翻列表） |
| `getRuntimeRecord` | app-core.js:1521 | 无 | app-main.js、agent-data-loader.js、sse-client.js | `allAgents`（翻列表） |
| `resolveWorkspaceFallbackAgentId` | app-core.js:1536 | 无 | app-main.js（404 fallback:1158）、ctx-menu-handlers.js、ctx-menu-items.js、sidebar-render.js | `focusedAgentId`、`allAgents` |
| `isUiOnlyAgentId` | app-core.js:1512 | 无 | agent-data-loader.js:16 等 | `allAgents`（翻列表） |
| `_agentRuntimeCache` | app-core.js:803 | **仅 app-core.js**（save/restore/clear 三函数内） | app-core 外**零**直接消费 | `getRuntimeContextKey`、`container` |
| `_agentDetailPayloadCache` | app-core.js:39 | **仅 app-core.js**（loadAgentDetail:86 写） | `getAgentDetailPayload` 唯一外部消费 = workspace-agents.js | 无 |
| `loadAgentDetail` | app-core.js:63 | 定义处 | app-main.js、app-ui.js、agent-data-loader.js、debug-summary-upload.js、sidebar-operations.js、sidebar-render.js（6 文件） | `allAgents`（Object.assign 合并记录:90） |

### 2.2 证据推理

1. **「状态与函数同生命周期」成立与否**：
   - `_viewerSessionBindings` 与 `setViewerSessionBinding`/`getViewerSessionBinding` 定义于同一处（app-core.js:957-1001 一段连续注释块「Viewer-local session binding」），Map 变异只发生在 set 函数体内，写入口语义单一（「用户主动切换时冻结」，注释 :963 明示）。它没有自己的消费域——存在的唯一目的就是被 `getRuntimeWorkspaceSessionId`（身份链）优先读取。**拆到域 7 会让身份链跨域读一个与列表无关的 Map**；拆到独立小域则多一次桥成本。归域 6 内聚最强。
   - `findAgentByIdentity` / `getRuntimeRecord` / `isUiOnlyAgentId` 的实现体第一行就是翻 `allAgents`（`.find(...)`），且 `findAgentByIdentity` 全库唯一消费方是域 9 的 `switchAgent`——它们是**列表的查询面**，不是身份规范化。它们若归域 6，域 6 就从「纯解析」变成「解析+列表查询」复合域，与 `resolveIdentityAliases` 等纯函数的零状态性质冲突。归域 7。
   - `resolveWorkspaceFallbackAgentId` 读 `focusedAgentId` + `allAgents`，语义是「列表里挑兜底宿主」——同上，归域 7。它被 ctx-menu-handlers / sidebar-render 消费的事实也支持域 7（都在列表/菜单语境）。
2. **谁定义、谁消费**：plan 域 6 点名 `findAgentByIdentity` / `resolveIdentityAliases`，但「定义在 app-core」只是历史位置（app-core 是上帝模块），不是归属证据。消费面证据（上表）一致指向：纯解析函数消费方遍布 10-16 文件且不传列表；查询面函数消费方是编排（switchAgent）与列表 UI（sidebar-render/ctx-menu）。
3. **`getRuntimeContextKey` 的归属锚定域 6**：它是身份链终点（viewer 绑定 → allAgents 派生 → host active 回退，:995-1012），消费方 10 文件全是「需要会话槽位键」的域（草稿、视口、录音、输入签名）。它是域 6 对外的**主接口**，保持域 6。

### 2.3 缓存与详情数据的归属（plan 未明说的灰色区）

- **`_agentRuntimeCache` 缓存族**（`MAX_CACHED_RUNTIME_VIEWS`、`_agentRuntimeCache`、`saveCurrentRuntimeToCache`、`restoreRuntimeFromCache`、`clearAgentRuntimeCache`、`_sessionViewIdentityFromContextKey`、`getRuntimeCacheTodoPlanFallback/Signature`）：写入内容是 `readCurrentSessionViewState()` 的快照（messages/inputRequests/hookInspector/overview/todoPlan/sessionMeta，:1041-1053），恢复走 `applySessionViewPatch`（:1138-1140）。缓存物 = 域 5 的视图状态；缓存淘汰与域 5 的 `_userCollapseStateByContext` 联动（:1074-1079）。app-core 外零直接消费（switchAgent 调的是 save/restore 函数）。**归域 5**，作为「会话视图状态的离屏副本」。
- **`loadAgentDetail` 详情族**（`loadAgentDetail`、`loadedAgentDetailIds`、`_agentDetailPayloadCache`、`getAgentDetailPayload`、`extractSessionMetaFromDetail`）：`loadAgentDetail` 的副作用是 `Object.assign(agent, otherDetail)` **改写 `allAgents` 记录**（:90）——它是列表记录的数据加载器；`_agentDetailPayloadCache` 的注释（:37-38）自述「远程会话不在 allAgents，agent_detail 载荷在此按 agentId 留档」——是列表的溢出存储。**归域 7**。

### 2.4 定案建议（供拍板）

- **域 6 最终清单** = §1.6 表全部 16 键（`normalizeAgentIdentity` … `getRuntimeContextKey`），其中含状态 1 个（`_viewerSessionBindings`）。
- **域 7 吸收**：`findAgentByIdentity`、`getRuntimeRecord`、`resolveWorkspaceFallbackAgentId`、`isUiOnlyAgentId`（查询面 4 键）+ `loadAgentDetail` 详情族 5 键 + `getNotificationCallStartedAt`（自域 6 清单移出）。
- **域 5 吸收**：runtime 视图缓存族 8 键（§1.5b）。
- 分界判据一句话：**身份 = 给一条 record 求身份；列表 = 在一堆 record 里找/装/排序。前者域 6，后者域 7。**

---

## 3. 边界问题 b：`currentRuntimeAgentId` 与 `currentMessages` 的归属

### 3.1 `currentRuntimeAgentId`：全部证据

**写点（全库仅 8 处，7 个在编排事务内）：**

| 位置 | 事务 |
|---|---|
| app-core.js:501 | `let currentRuntimeAgentId = null` 定义 |
| app-main.js:784 | `switchAgent`：乐观渲染前赋新 runtime id |
| app-main.js:540 | `navigateToWorkspaceSession`：离开会话清空 |
| app-main.js:1173 | `handleCoreResponsesNotFound`：404 fallback 清空 |
| app-ui.js:39 | `selectWorkspaceSurface`：回工作空间首页清空 |
| agent-data-loader.js:30 / :20 | `loadAgentData`：加载事务头赋值 / ui-only 清空 |
| session-readonly-view.js:193 | 打开只读历史浏览清空 |
| thread-store.js:788 | 线程 head-advanced 重绑赋新值 |

**读方与 stale check**：域 5 的 `captureSessionViewToken`（session-view-state.js:102，默认参数取它）、`isSessionViewTokenCurrent`（:132/135）、`readCurrentSessionViewState`（:166）、`applySessionViewPatch`（:243）只**读**它。frontend-rendering-patterns.md:312 的约束原文：「stale check 只比较 `currentRuntimeAgentId`（同步设置，不会在 await 期间变化）」——该约束成立的前提恰是**它的全部写点都在同步事务边界上**（switch/导航/加载入口），没有任何异步回调中途改写。:255-276 记录的历史 bug（poll 用它拼 URL 后 await 期间被切换覆盖）进一步说明：这个键的写时序就是切换事务本身。

**结论建议：归域 9。** 写方全部是编排事务；域 5 是它的纯读方。若归域 5，则 switchAgent/loadAgentData/只读/重绑四个域都要经桥写一个「别人家」的键，桥债与跨域写都增加；且域 5 将持有「页面正在看哪个 runtime」这一编排事实，与它「selected runtime view 的 commit 资格裁判」的自我定位（session-view-state.js:10-11 头注：「This module owns commit eligibility… The poll timer and in-flight promises remain resources owned by the poll coordinator」）冲突——头注明确把「谁在轮询」划给了编排侧。

### 3.2 `currentMessages`：全部证据

**写点（全库仅 2 处）：**

| 位置 | 事务 |
|---|---|
| app-core.js:558 | `let currentMessages = []` 定义 |
| session-view-state.js:215 | `applySessionViewPatch` 的 messages 分支（规范写入门，附带 `_sessionViewMessagesRevision` 观察版本推进 :214） |

**消费方**：域 9 的 `runMessagesProbeCycle` 读它做增量对账基线（app-main.js:1200 `prevKnownMessages`、:1305 `currentMessages !== prevKnownMessages` 竞速守卫）、自动标题消费（:1712/1810 `tryAutoTitleGeneration(currentMessages)`）、chat-renderer 读它（乐观回显定位 :668）。全部只读。

**结论建议：归域 5。** 它是 selected runtime view 的消息槽位，唯一写入门就是域 5 的 patch 机制；plan 附录 A 描述的「poll 拿旧数据覆盖 currentMessages」历史竞态正是由域 5 的 token 机制治好的（commitSessionViewPatch 拒绝 stale token）。归域 9 会把视图存储键放进球员域、裁判键放进了场域，倒置。

### 3.3 一并定案的连带键

与两键同机制的连带归属（不再单独立题）：

- `currentInputRequests` / `toolRenderConfigs` / `TOOL_NAMES` / `currentHookInspector(+Signature)` / `currentOverviewSnapshot(+Signature)` / `currentTodoPlan(+Signature)` / `currentRuntimeConnected` → **域 5**（与 `currentMessages` 同理：唯一/规范写方是域 5 patch 门或其调用的 setter，§1.5c 已列）。
- `_restoredScrollTop` → **域 9**（app-core.js:728 注释自述 "set by restoreRuntimeFromCache, consumed by switchAgent"——写方域 5 的 restore 函数、读方 switch 事务；它是切换事务的传递参数，非视图状态本体。两域交界键，随域 9 走（消费方语义），桥承载域 5 写）。
- `_switchEpoch` / `_navigationGuardEpoch` / `pendingSwitch*` / `_pendingSessionNavigation` → **域 9**（域 5 的 token 只读快照它们，从不写）。

---

## 4. featurePanelWidth 甄别

**结论：是状态（布局数值），不是 DOM 引用。** 证据：

1. **定义形态**：app-core.js:585 `let featurePanelWidth = 460;`——`let` + 数值初值。同文件真 DOM 引用全部是 `const X = document.getElementById(...)`（:441-485），无一例外。
2. **运行时写点 3 文件 4 处，全部是数值赋值**：
   - app-ui.js:2122 手动拖动 resizer：`featurePanelWidth = Math.max(minWidth, Math.min(750, nextWidth, ceiling))`
   - app-ui.js:1800 窗口 resize 级联收窄：`featurePanelWidth = nextWidth`（前置 :1799 `nextWidth !== featurePanelWidth` 数值比较）
   - ctx-menu-handlers.js:467 菜单动作钳制：`featurePanelWidth = Math.max(_minPw, Math.min(750, featurePanelWidth))`
3. **消费形态是算术**：app-ui.js:1756 `_getPanelOccupiedWidth()` 返回它参与中央区可用宽度计算（:1760 `window.innerWidth - _getSidebarOccupiedWidth() - _getPanelOccupiedWidth() - 56`）；debug-panel-host.js:193 / app-ui.js:2123 / ctx-menu-handlers.js:469 以它为源值写 CSS 变量 `--feature-panel-width`。DOM 引用键没有任何一个被这样用。
4. **与 `featurePanel.style.setProperty('--feature-panel-width', ...)` 的关系**：CSS 变量是它的投影（写点总是成对出现），但真相源是 JS 数值——debug-panel-host.js:188 注释明示「不得覆写宽度，否则拖动调整中会被闪回全局 featurePanelWidth」，说明各处都以全局数值为准回写。

**迁移处置**：留在域 4（唯一消费语境是面板布局，与 `featurePanel`/`featurePanelResizer` 同生命周期），但挂 `defineKey` 状态桥（数值语义，setter 原值转发），**不**按 R3 哑存储一次性赋值处理。plan 标注「featurePanelWidth 是状态需甄别」就此关闭。

---

## 5. 数字核对：plan 附录 A vs 实测

口径：`\b<key>\b` 全文匹配（含注释与字符串，plan 同口径的合理近似），**只排除主定义文件单文件**。对多定义面键（escapeHtml/render/poll 等），IIFE 局部与 ESM 插件局部同名**计入** fan-in（它们是独立实现，不是对全局的消费——见各域注意；若扣除，数字再降，两种口径都列出供对照）。

| 键 | plan 附录 A | 实测（排主定义文件） | 差异 | 实测（排全部定义面） |
|---|---|---|---|---|
| `fetch` | 94 | 95 | **+1** | 92（另排 auth-client.js） |
| `currentLanguage` | 88 | 88 | 一致 | 88 |
| `escapeHtml` | 80 | 83 | **+3** | 76（另排 5 个 IIFE 局部 + 2 插件局部） |
| `render` | 57 | 60 | **+3** | 51（另排 9 个局部定义文件） |
| `currentRuntimeAgentId` | 48 | 48 | 一致 | 48 |
| `container` | 42 | 42 | 一致 | 24（另排 18 个局部同名文件） |
| `renderCurrentMainView` | 40 | 40 | 一致 | 40 |
| `allAgents` | 38 | 38 | 一致 | 38 |
| `poll` | 36 | 36 | 一致 | 34（另排 2 个局部） |
| `getCurrentAgentRecord` | 33 | 33 | 一致 | 32（另排 guide-docset 局部） |

解读：

1. 7/10 完全一致；3 个差键全部是**实测略高**（+1~+3），方向一致——最可能是 plan 快照后同日内有文件新增了引用（如 `bg-panel.js` 消费 `escapeHtml` 25 处的模块），或 plan 生成脚本排除了部分局部定义文件（右侧列显示排除全部定义面时数字落在 plan 之下）。两种口径都覆盖了 plan 值的邻域，**不构成分桶障碍**。
2. `container` 的 42 vs 24 差异说明 plan 用的是「排主定义文件」口径（与实测 42 吻合），佐证口径推断。
3. fan-out 前 5 未重测（plan 明示 `work-group-ui.js` 为已死文件，不属九域）；本轮无分桶决策依赖 fan-out 精确值。

---

## 6. 九域之外的 app-core 键去向

app-core 台账 170 个 state 键中，入九域 117 个，**余 53 个不属九域**。分类列出，防止读者把九域当成 app-core 全集：

| 类别 | 键 | 去向 |
|---|---|---|
| 传输 / 引导（**保持 classic**，plan §桥机制最后一条） | `nativeFetch`、`USE_SAME_ORIGIN_VIEWER_PROXY`、`VIEWER_BASE_URL`、`isServerServedPage`、`window.fetch` patch、`_showWebPicker` | 不迁移。`invoke` / `waitForViewerReady` 同此（boot 链与全部消费方的地基） |
| 视口跟随（12 键） | `chatViewportFollowRaf/Token/Transition`、`chatViewportMutationObserver`、`chatViewportObserverQuietUntil/SuppressDepth`、`chatViewportObserversReady`、`chatViewportResizeObserver`、`chatViewportSettlementContext/Raf/Timer/Token` | chat-viewport.js 域随 P2 批次（与 `followLatest*` 四键的写方同文件，届时经域 9 桥读写） |
| 折叠偏好（4 键） | `_userExpandedReasoning`、`_userCollapsedMsgs`、`_userExpandedMsgs`、`_userCollapseStateByContext` | P2 会话 UI 批次（写方 chat-renderer / input-render） |
| 右键菜单（6 键） | `contextMenuAgentId/AgentMode/CompactAction/FeatureRepoPackageId/ProjectAgentId/ProjectId` | P2 ctx-menu 批次（写方 ctx-menu-* 文件） |
| 面板数据（8 键） | `currentLogs/Signature/Truncation`、`logFilters`、`selectedOverviewLifecycle`、`currentMcpInfo`、`showChatProcess` + `CHAT_PROCESS_VISIBILITY_KEY` | P2 debug/MCP 面板批次 |
| IM / qqbot（5 键） | `qqbotConfigState/Request`、`imWorkspaceState/Request/AutoSaveTimer` | P2 IM 面板批次 |
| assembly（4 键） | `assemblyControlPanelOpen`、`assemblyDraftRenderTimer`、`assemblyLaunchInProgress`、`assemblySideRailRevealTimer` | P2 assembly 批次（写方 assembly-actions/assembly-data） |
| repo 检索（4 键） | `repoSearchQuery`、`repoSourceFilter`、`selectedRepositoryPackageId`、`selectedFeatureName` | P2 feature-repo 批次 |
| PH 检索（3 键） | `phSearchQuery`、`phSessionSortMode`、`_phSearchTimer` | P2 ph-session 批次 |
| choice 输入（1 键） | `choiceInputState` | P2 choice-input 批次（写方 choice-input.js 索引变异） |
| work-group（1 键） | `_workGroupEventsWired` | 随悬置域重做（永不进批） |

---

## 7. plan / 台账勘误与滞后标注

1. **`tHtml` 不存在**：plan 域 2 行写「`t` / `tHtml`（超短键…迁移时一并处理）」。实测 `public/src` 全树 0 定义 0 消费，台账 app-core 条目也无此键。域 2 清单只含 `t`。属 plan 文本滞后。
2. **域 1「纯函数、零状态」不准确**：`markdown-utils.js` 含模块级状态 `_currentBleed`（:568）与 2 处挂载副作用（:638 actions 注册、:644 load 监听）。不影响「首战验证配方」的定位，但迁移工单须按「26 export + 1 域内状态 + 2 副作用保留」执行。
3. **台账本身无滞后**：app-core 台账 245 键（state 170 + behavior 75）逐一在源码验证有定义形态，零缺失。plan 附录 A「漂移以基线文件为准」当前无触发点。
4. **`getNotificationCallStartedAt` 归域修正**：plan 域 6 备注「viewer 绑定族（setViewerSessionBinding / _viewerSessionBindings）…」未提此键，本调查扫描时将其列入域 6 草稿，按语义（call 身份）与消费方（interrupt/call 状态链）修正为域 7。
5. plan P1 域 8 落点「app-ui 抽出 EML `render-entry` 域」中「EML」为笔误，本文件按 ESM 理解。

---

## 8. 遗留不确定项

1. **`savedPhTabState` 归域**（域 8 vs P2 ph 域）：定义 app-core.js:576、写方 ph-session-list.js。**定案：移入 P2 ph 域**——写方唯一且在 ph 域文件，随其域整域迁移。同类灰键 `expandedProjectIds`（域 7 表内，写方 session-list-render/sidebar-render）**定案：保持域 7**——写方属侧栏列表渲染面，是域 7 的消费语境。
2. **域 5 是否吸收 overview-data.js / todo-plan.js 的 setter**：**定案：setter 留原文件、域 5 patch 门经 import 调用**——域 5 只迁存储键与 patch 门，两个文件的签名计算、probe 提取等渲染数据逻辑留待 P2 整域迁移，每步只做一件事（plan D4）。
3. **局部同名副本的清理时机**：`escapeHtml` 5 个 IIFE 局部、`render` 9 个局部、`container` 18 个局部参数同名。这些不影响域迁移（桥/ESM 后局部名照常遮蔽解析），但 P2 收尾时若想统一 import 域 1 的 `escapeHtml`，各文件是独立小改动。本定案不安排。
4. **fan-in 口径噪声**：本轮 `\b` 匹配含注释与字符串，未做 AST 级排除。抽查显示注释提及占比很小（`currentRuntimeAgentId` 48 个引用文件中注释提及约 2 个），对分桶无影响；P0.5 桥债门禁落地时若要精确基线，建议届时用同一脚本口径固化。
