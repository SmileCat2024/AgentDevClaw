# 前端 ESM P4：活跃域 classic 清零与首屏链迁移

日期：2026-11-17
状态：方向已裁决（终态定义、悬置域封存、接受首屏时序变化），待实施
上位依据：[ADR-0051](../adr/0051-frontend-esm-strangler-migration.md)（D1–D5 决策不变）、[主计划 2026-11-16](2026-11-16-frontend-esm-strangler-migration.md)（P0–P3 已交付，本计划是其 §194 搁置路线的裁决与实施）、[P2 交付记录](2026-11-17-frontend-esm-p2-acceptance.md)、[P3 收敛提交 e5a76a22]
组织方式：沿用《[ESM 迁移配方](esm-migration-playbook.md)》+ 批次工单（claw-coder-dispatch）+ 门禁量债，全部验收规则以配方为准，本文档只补充阶段划分与专项边界。

## 背景与裁决

P3 按"保留同步首屏"路线收敛后，主计划 §194 的两条路线选择已重新裁决：

1. **终态定义从"classic 全零"修正为"活跃域清零 + 悬置域封存"**。初衷（提升代码质量、现代化、便于长期管理）的敌人是加载序即依赖图、全局状态无唯一 owner、上帝模块——P1/P2 已兑现大头（170 模块显式依赖图、台账 799+2143 → 399+972 键、新增全局有门禁）。剩余质量债务集中在 39 个活跃域 classic 文件（约 22,400 行），其中 app-core / app-ui / app-main 与首屏同步链是 [frontend-rendering-patterns.md](../reference/frontend-rendering-patterns.md) 全篇竞态记录的主战场。
2. **悬置域不转换**。15 个悬置域标签文件（约 12,500 行，flow-editor / wg-\* / im-\* / dispatch-\* / home-dashboard / resources-viewer）刻意搁置待重做，机械转换是双倍工作量；重做时以 ESM 起写（主计划既定原则）。它们消费的内核桥键保留并逐键登记注销条件。死文件例外：无标签且无加载方的文件确认后删除（work-group-ui.js 已于本日删除）。
3. **接受唯一行为变化**：首屏渲染时点从 classic 逐标签同步相移到静态 ESM 模块求值相（DOMContentLoaded 前）。本地服务 + 桌面壳是主部署形态，模块图（170 → 预计 300+ 文件）在 localhost 的加载开销为几十毫秒级；远程慢网络可用 `<link rel="modulepreload">`（标准 HTML 手段，不违反 D1 不引入构建器）缓解。

## 目标与非目标

**目标**：index.html 中活跃域项目代码 classic `<script src>` 标签归零；首屏同步链（`applyTheme → applyLanguage → renderAgentList / renderFeaturePanel / renderCurrentMainView`）整链迁入 ESM 模块图；活跃域消费方归零的桥键即时注销；kernel-entry 与 p2-entry 合并为单一入口。

**非目标**（显式排除）：

1. 不动 15 个悬置域标签（封存；死文件确认后删除除外）。
2. 不动 vendor 5 个 UMD 标签（marked / hljs / katex×2 / diff2html，第三方库不是项目代码）。
3. 不动 2 段内联 bootstrap（base-path / fetch / EventSource patch、hljs 兜底——"永远 classic"是 ADR-0051 既定边界；允许在其中追加主题预读，见时序切换节）。
4. `kernel-state.js` 标签保留：桥基础设施，服务悬置域消费键与测试预挂；活跃域桥键撤除后它只剩悬置域消费面，不删除。
5. 不改 innerHTML 渲染管线、不重设计行为、不引入构建器（D1–D5 全部沿用）。
6. 插件 window 协议（memo / coder / claw-guide / agent-studio 的 `host.env` 与 `getClawModelPresets` 类协议）不动。

## 范围清单（39 个活跃域文件）

head 4 件：claw-host（692 行）、plugin-manifest（23）、action-dispatcher（164）、auth-client（272）。
body 35 件：i18n（936）、app-core（1384）、session-view-state（254）、sidebar-layout（329）、sidebar-render（875）、remote-connections（1085）、chat-context-bar（663）、workspace-docset（79）、markdown-bootstrap（47）、theme-lang（88）、chat-viewport（900）、debug-logs（390）、debug-features-hooks（1083）、generative-ui-panel（734）、debug-panel-host（507）、panel-plugins（64）、todo-plan（363）、bg-panel（942）、right-panel-registry（13，转发壳，随 claw-host 收编退役）、app-ui（2285）、rail-customize（928）、desktop-notify（448）、input-composer（427）、voice-input（821）、rollback-dialog（41）、chat-scroll（194）、runtime-status（1754）、input-helpers（36）、input-render（317）、persistent-input（1008）、chat-renderer（1644）、thread-store（672）、desktop-open（102）、app-main（1067，消亡：boot IIFE 并入 ESM 入口）。

行数为 2026-11-17 快照，仅供规模感，以代码为准。测试面：85 个 frontend-vm 沙箱测试文件中与本清单相关者随批迁移（配方第三节规则），不单列阶段。

## 阶段划分

总量估算 25–35 批。拆解逻辑：按依赖方向自底向上——原料层 → 渲染层（含唯一时序切换）→ 编排长尾 → 封存登记 → 清零收尾；每批消掉一层 classic 消费方，桥债单调下降。难度分布：T2 决定成败，T3 决定工期，T1/T4/T5 低风险。

### T1 原料层（约 2,400 行，5–8 批）

- i18n.js → ESM（I18N 字典纯数据 + `t` 纯函数；`t` 桥 get 保留，全库最高频裸读）。
- markdown-bootstrap 并入 markdown-utils 域（escapeHtml / renderer 已是同域桥键，合并后唯一实现，消除双定义）。
- theme-lang 并入 i18n-environment-state（applyTheme / applyLanguage / renderThemeToggle / setThemeStylesheet / showAgentStartError）。
- app-core 拆解（本阶段大头）：DOM 引用区 43 键 → dom-refs 域（R3：deferred 执行时 DOM 已就绪，初值等价重建）；身份函数（normalizeAgentIdentity 族）→ identity 域；格式化函数 → i18n 域随迁；`invoke` / `waitForViewerReady` / Viewer fetch 分流 → 传输域（消费面 90+ 文件，桥语义与初值时点重点审计）；`_showWebPicker` 随迁。
- 验收：本阶段全部不改行为（applyTheme/applyLanguage 仍在 classic 相由 app-main 顶层调用）；app-core 行数显著下降；相关批测试迁移完成。

### T2 渲染层 + 时序切换（约 10,300 行，8–12 批 + 1 次专项提交，全工程最难）

按拓扑序分批联合迁移：session-view-state → sidebar-layout / sidebar-render（renderAgentList）→ debug-panel-host + debug-logs + debug-features-hooks（早期可点入口随迁）→ right-panel-registry 退役 → chat-viewport / chat-scroll / chat-renderer → input 面四件（input-composer / input-render / input-helpers / persistent-input）+ rollback-dialog → app-ui 本体拆解（renderCurrentMainView 及支撑函数）。

- 收尾专项提交：**时序切换**——`applyTheme(currentTheme); applyLanguage()` 首次执行从 app-main classic 顶层移入 ESM boot 模块；app-main 残余（顶层调用、visibilitychange、boot IIFE）就地消亡或并入 boot 模块。
- 主题闪烁缓解：内联 bootstrap 追加主题预读（localStorage `agentdev-theme` → `document.body.dataset.theme`），属"永远 classic"的 bootstrap 类，是本计划对内联脚本的唯一新增授权。
- 早期事件窗口语义翻转：解析途中按钮从"触发未声明函数报错"变为"无监听、点击无效果"——更安全，但需专项回归桌面唤起（desktop-open）等外部一次性入口。
- 浏览器专项回归（本阶段验收必做）：首屏骨架→填充、light 主题无闪烁、慢网络（节流模拟）可用时点、语言/主题/设置按钮在模块就绪前点击无副作用、`__clawAuthReady` → startApplication 链正常。

### T3 长尾编排层（约 10,200 行，10–14 批，量大但独立，可并行派发）

runtime-status、remote-connections、bg-panel、rail-customize、voice-input、generative-ui-panel、thread-store 刷新引擎（2s 启动 / 20s 周期 / visibilitychange / finally 指示器，R4 等价性审计）、claw-host / plugin-manifest / action-dispatcher / auth-client（head 四件；静态模块在 DOMContentLoaded 前求值，事件注册搬到模块相逐件审计）、desktop-open / desktop-notify、todo-plan、chat-context-bar、workspace-docset、panel-plugins。多数只做"事件注册时相等价"审计，互相独立，适合工单并行。

### T4 悬置域封存（半天级，无转换）

- 悬置域消费的内核桥键（实测 `renderCurrentMainView` 7 文件、`currentLanguage` 5、`escapeHtml` 5、`allAgents` 2、`runWorkspaceAction` 2 等）逐键登记"悬置域重做时消亡"的注销条件头注。
- script-tags 基线中悬置域标签固化为显式永久清单。
- 死文件确认删除（须同时满足：无 index.html 标签、无加载方、无测试装载；work-group-ui.js 已删，其余 wg-\* 无死亡证据不动）。

### T5 清零收尾（1–2 批等价）

- 活跃域撤桥收尾（大部分撤桥分摊在前三阶段各批内，此处清剩余）。
- kernel-entry 与 p2-entry 合并为单一入口；批次入口文件随批次收尾删除。
- 台账 / inline-events / script-tags / 桥债基线收敛；AGENT.md 与 frontend-rendering-patterns.md 中"classic 相 / 首屏同步链"相关表述同步更新。

## 度量与验收

- **每批**：配方第五节全部规则（node --check、目标测试、test:core、台账修剪、桥债报告、变异抽查）。
- **阶段级**：script-tags 基线中活跃域标签单调下降；桥债基线（当前 256/85）随消费方归零下调，无依据上调照旧禁止。
- **P4 完成**：index.html 项目代码 classic 标签 = 悬置域 15 + kernel-state 1（vendor 与内联除外）；活跃域消费的桥键全部注销；悬置域消费键进入永久桥清单（逐键头注 + 注销条件）；kernel-entry/p2-entry 合一；全量测试绿 + T2/T5 两轮 Chromium 端到端回归通过。
- **既有噪声区分**：3 条域外导入警告、线程接续 G3 历史间歇失败——非本计划引入，验收时不计入新增失败，也不得借此声明"全量绿"。

## 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 首屏时序变化在远程慢网络下体验回退 | 中 | modulepreload 提示；慢网络纳入 T2 浏览器回归；部署形态以本地/桌面壳为主的事实写入裁决记录 |
| 主题闪烁（模块执行前的暗色默认帧） | 低 | 内联 bootstrap 主题预读（唯一授权的内联新增） |
| 早期事件窗口语义翻转破坏外部入口 | 中 | desktop-open / desktop-notify 专项回归；外部唤起链在 T2 验收清单内 |
| T2 批间咬合导致中间态不可运行 | 高 | 按拓扑序分批 + 每批 test:core；批次表在 T1 收尾后按实测依赖微调，不顺拆硬切 |
| 测试迁移量（约 60–80 个沙箱文件） | 中 | 分摊各批；loader helper 已泛化，属机械工作 |
| 悬置域桥键误撤导致悬置域断链 | 中 | T4 清单化登记；撤桥以消费面 grep 归零为唯一依据（配方步 5） |

## 实施记录

### 时序切换提前到 P4 起点（2026-11-17）

实测依赖关系与 T1 的"不改行为"约束冲突：`i18n` 的 `t`、`theme-lang` 的 `applyTheme` / `applyLanguage`、`markdown-bootstrap` 的 `escapeHtml` / `renderer`、`app-core` 的 DOM 引用区，都被 app-main 顶层的 `applyTheme(currentTheme); applyLanguage();` 在 classic 相同步触达（传递链：`applyLanguage → renderCurrentMainView → getEmptyStateHtml → escapeHtml`）。只要这条顶层调用还在 classic 相，这些域迁进 ESM 就会在首屏抛 ReferenceError，各文件头注的 R1 收敛条件（如 `workspace-docset.js`）也是同一约束。

因此把 T2 的收尾专项提交**提前为本阶段第一步**落地，作为独立可回退提交：

- 新增 `public/src/modules/boot.js`（index.html 最后一条 module 标签），承接原 app-main 顶层两行调用；app-main 侧留注释禁止恢复。
- index.html 的 `app-theme-bootstrap` 内联主题预读（本计划授权的唯一内联新增）。
- 行为变化与风险表一致：首屏渲染时点移到模块求值相；主题闪烁由预读兜住。
- 切换后 R1/R4 的"首屏同步触达"约束整体解除，后续批次改为纯自底向上转换（可并行），不再需要逐文件登记"等首屏链迁移后再收敛"的中间态。

不按原顺序（先迁链、后切时序）执行的理由：那要求首屏链上十几个文件在同一批里联合迁移成 ESM，才能保住首屏可用；提前切换把这条巨型原子批次拆成了一系列独立可验收的批次，且中间态始终可运行。

### 已完成批次与当前进度（2026-11-17）

| 提交 | 内容 | 度量变化 |
|---|---|---|
| `396e1709` | 时序切换：`modules/boot.js` 承接首屏渲染链；index.html 内联主题预读；script-tags gate 增加"boot 必须是最后一条 module 标签" | src 标签 69 → 70（新增即该入口） |
| `89fa18e8` | i18n → ESM（`I18N` + `createTranslator` + 生产绑定 `t`），`modules/i18n-host.js` 注册 `i18n:t` 桥键；54 个沙箱用例改为经 `test/helpers/install-i18n.js` 装真实字典 | 台账 71 文件 / state 399 / behavior 972 → 70 / 398 / 971；桥债 256/85 → 257/86 |
| `32c36d24` | theme-lang 并入 i18n-environment-state；sidebar-layout 迁 ESM（新增 `modules/p4-entry.js` 作为 P4 批次入口）；长尾四件（chat-context-bar / workspace-docset / todo-plan / panel-plugins）迁 ESM | 台账 → 65 / 384 / 933；src 标签 70 → 63；桥债 267/90 → 270/90 |
| `a88238e1` | rail-customize / generative-ui-panel 迁 ESM。同批判定 `desktop-open` / `desktop-notify` **R4 触线不转**：顶层就是桌面壳 webview eval 的消费入口，`&&` 守卫是静默丢弃不是排队，迁到模块相会多出请求被吞的窗口（`test/frontend-desktop-open.test.js` 钉这条） | src 标签 63 → 61；桥债 270/90 → 272/92 |
| `d4912118` | 第二批三组：调试三件（debug-logs / debug-features-hooks / debug-panel-host）、聊天滚动与输入薄壳（chat-scroll / input-helpers / rollback-dialog / input-render）、后台面板与语音输入（bg-panel / voice-input）。right-panel-registry 保留（转发壳消费面未归零） | src 标签 61 → 52；桥债 272/92 → 289/99；台账 65 / 384 / 933 → 56 / 323 / 823 |
| `412eccd2` | 第三批三组：chat-viewport（29 桥键）、chat-renderer（12 桥键，折叠偏好经 app-core 新增的 chatSurface getter/setter）、remote-connections（10 桥键）。同批判定 `runtime-status` R1 触线未转 | src 标签 52 → 49；桥债 289/99 → 340/102；台账 56 / 323 / 823 → 54 / 286 / 678 |
| `7c3720e5` | 第四批两组：输入面两件（input-composer / persistent-input，函数键另立 `*-api` 域）、线程引擎与插件清单（thread-store / plugin-manifest）。**装载序修正**：kernel-entry 里 p4-entry 改到 p2-entry 之前——P2 图消费方在求值期经桥键取 P4 能力，顺序颠倒会让整图求值中断（Chromium 回归的 pageerror 面抓到，单元测试各自的夹具没覆盖） | src 标签 49 → 45；桥债 340/102 → 369/106；台账 54 / 286 / 678 → 50 / 261 / 606 |
| `7f4c2e63` | 第五批：markdown-bootstrap 并入 markdown-utils（escapeHtml 与 renderer 配置逐字搬入，`markdown-utils:renderer` 桥键注销）；frontend-vm 补 marked 面（每沙箱一份实例） | src 标签 45 → 44；桥债 369/106 → 368/106 |
| `12b04b0a` | 第六批（T2 收尾）：sidebar-render + runtime-status 迁 ESM，app-main 顶层 call-state IIFE 搬出为 `modules/agent-call-states-engine.js`，B2/B3 两处求值期抓取改具名 import，app-core 补两处最小 seam（B5/B6） | src 标签 44 → 42；桥债 368/106 → 382/108；台账 50 / 261 / 606 → 50 / 248 / 554 |
| `2608fe1d` | 第七批：session-view-state 迁 ESM（T2 渲染层最后一件）。8 命名导出 + 6 桥键；identity 族 6 条 defineKey 注销；`session-view-commit-host` 的 window 抓取改具名 import（与 B2/B3 同型）；57 test 文件 + 3 helper 改造，`test/helpers/session-view-commit.js` 删除 | src 标签 42 → 41；桥债 382/108 → 382/109；台账 50 / 248 / 554 → 50 / 247 / 544 |
| `2bf6ef91` | 第八批：app-ui 迁 ESM（T2 渲染层收尾）。35 处 export + 23 桥键；app-core 两处最小 seam；`workspace-surface-host` 改首调惰性装配（破静态环）；**回归修复**：resources-viewer 改为直接调注册表本体，并在生产浏览器回归里加 work-group 面板断言 | src 标签 41 → 40；桥债 382/109 → 383/110；台账 50 / 247 / 544 → 50 / 238 / 490 |
| `1108b73f` | 第九批：app-core 拆解——dom-refs / identity / transport / format-utils 四族抽出 ESM（app-core 1439 → 838 行）。桥债反向 383/110 → 398/114（抽出后 classic 消费方仍需桥，注销条件逐键写在模块尾注） | src 标签 40 → 41（app-core 尚存 + 新模块经 p4-entry，标签数不变口径见门禁）；台账 50 / 238 / 490 → 51 / 189 / 464 |

转换中确立的几条约定（后续批次沿用）：

1. **P2 与 P4 的装载入口分开**：`p2-entry.js` 收 P2 消费方批次（那批模块迁移时首屏仍是 classic 触发，逐文件带 R1 残留说明），`p4-entry.js` 收 P4 批次（时序切换后迁移，无 classic 相同步触达约束）。两者都由 `kernel-entry` 静态 import，`p4-entry` 在后。
2. **静态按钮的早期窗口语义**：主题 / 语言按钮的 click 由 `bindStaticToggleButtons()` 在 boot 首屏渲染后绑定；模块求值前点击无效果、无报错。这是把"按钮在 DOM 里可点但实现未到"从抛错变成静默的显式选择，`test/p2-production-boot-browser-check.mjs` 钉住两侧（渲染前无效果、就绪后生效）。
3. **测试沙箱的基础设施按需补齐**：`install-i18n.js`（真实字典 i18n 桥）、`frontend-vm.js` 的 elementStub 补 `dataset`、`esm-module-loader` 的 window/document 桩面；这些是"真实 DOM 必备面"，不是为迁就某个文件加的兜底。
4. **同名域的冲突**：`workspace-docset` 的桥键域已被 P2 的 `p2-w2-10-workspace-docset.js` 认领，新的 chrome 薄壳用 `workspace-docset-chrome`，并在文件头注写明注销条件。同型先例还有 `voice-input-api`（状态域 `voice-input` 的 impl 只转发已知键，函数键必须另立域，否则认领后补注册取到 undefined）。
5. **app-core 的最小 host seam（chat-renderer 前置）**：chat-renderer 的折叠偏好三个 Set（`_userExpandedReasoning` / `_userCollapsedMsgs` / `_userExpandedMsgs`）owner 是 app-core 顶层 `let`，且 `activateUserCollapseStateForContext()` 会整体重赋值——传值型宿主面会让渲染侧抓住旧 Set。因此在 `createP2BootstrapChatSurfaceHost()` 增补三对 getter/setter（读写同一 binding），chat-renderer 经 `chatSurface` 取用。这是 P2 既有宿主工厂模式的最小延续，不新增桥键、不改 owner。
6. **测试桩面按真实 DOM / 端点契约补齐**：元素桩的 `dataset` / `children` / `contains` / `closest` / `matches` / `getBoundingClientRect`，document 的 `contains`，运行时创建元素（`rail-cust-overlay`）返回 `null`。每次补齐都对应一条真实生产路径（例如 `RailCustomize.findAnchor` 遍历 `rail.children`），不是为迁就某个批次。整图用例的"装载期请求集合"是精确相等断言，新增依赖（`ui-prefs?agentId=home`、`/sounds/*.mp3`）须逐条登记。

剩余工作按依赖分组（每批仍按配方验收、独立提交）：

- **T1 已完成**（第五批 markdown-bootstrap、第九批 app-core 四族）。app-core 剩余 838 行的 owner 迁移与 app-main 同批（见第九批记录）。
- **T2 已完成**（第六、七、八批：sidebar-render / runtime-status / session-view-state / app-ui）。
- **T3**：remote-connections / runtime-status（第六批解除 R1）已迁。`auth-client` **R1/R2/R4 触线保留 classic**：它创建 `__clawAuthReady` 并被 app-main 顶层 IIFE 等待，创建时点不能后移到模块相。`desktop-open` / `desktop-notify` 按 R4 保留；head 四件中 `action-dispatcher` 在配方禁区，需单独立项。app-main 残余（`visibilitychange` 注册与 `startApplication` 编排）是下一步。
- **T5 收尾**：`kernel-entry` 与 `p2-entry` / `p4-entry` 合并为单一入口；台账 / script-tags / 桥债基线收敛；`AGENT.md` 与 `frontend-rendering-patterns.md` 中"classic 相 / 首屏同步链"表述同步。

### 第六批：T2 收尾批次（sidebar-render + runtime-status + call 状态引擎）

阻断清单 B1–B6 全部解除，处理方式如下（每条都对应一次实测，不是推断）：

- **B1**：`app-main.js` 的 `bootstrapAgentCallStates` IIFE 逐字搬出为 `modules/agent-call-states-engine.js`，由 `p4-entry` 在模块相求值。两个桥键（`agent-call-states` 域）与 `window.ClawFW.CallStates` 协议面保持原样，app-main 的 `visibilitychange` 全量对账与 sidebar-render 的适配面语义不变。
- **B2 / B3**：`agent-snapshot-loader-host.js` 与 `p2-bootstrap-sidebar.js` 改为具名 import 宿主工厂，不再在求值期经 window 抓 classic 全局。
- **B4**：`runtime-status.js` 具名导出 `_agentSuspended`，`createAgentCallStatesHost()` 直接 import —— 同一 Map 引用，无双存储。
- **B5 / B6**：`app-core.js` 的 `createP2BootstrapCallActivityHost()` 与 `createP2BootstrapSidebarHost()` 各增一个只读引用（`_interruptSuppression` / `pendingPrebuiltAgentIds`），与既有 `_agentCallActive` 同风格，未新增容器、未改 owner。

**唯一计划外桥债（已评审接受）**：`sidebar-render` 的渲染签名需要项目实体缓存，具名 import `project-data` 会构成真实的值级环——`sidebar-render → project-data → session-ui → agent-snapshot-loader-host → sidebar-render`（最后一条边是本批 B2 建立的）。因此 `project-data` 注册 `phProjectEntities` 桥键（`+1 registered`），`sidebar-render` 经 `window.phProjectEntities` 读同一对象，不复制。收敛条件写进代码注释：先把 `agent-snapshot-loader-host → sidebar-render` 这条反向边解开（宿主工厂下沉到独立投影模块），再改具名 import 并注销该键。

**测试面**：64 个测试文件改造（+1739 行），四类形态——classic 装载点改 ESM 域装载（`p2-classic-hosts.js` 增 `loadEsmDomain` / `applyEsmDomain`）、侧栏重绘观测点改用真实渲染入口（`updateCurrentAgentChrome`）或模块相后经桥 setter 覆盖、ADR-0019 那批用例改 `withRuntimeStatusCase` 真图 + `runtime-status-api` 桥键调用、桥面穷举补齐。`sidebar-empty-snapshot` 的三条降级诊断断言改为对 console 文案断言（`queueSidebarDiagnosticEvent` 是桥键访问器，测试内覆盖不生效），事件协议形状仍由同文件的 `captureDiagnosticQueueRequest` 用例覆盖。

**验收（实跑）**：`test:core` 6646 项 / 6638 通过 / 4 失败（3 个已知平台项 + `oauth-codex` 的 `isTokenRefreshDue` 在满量并行下超时，单文件复跑 81/81 全过）/ 4 跳过；`node test/p2-production-boot-browser-check.mjs` 主链 + 延迟相 7 面板全 PASS、零 pageerror；`check-import-cycles` 零新增环（另报 1 个 `scripts/e2e-container-phase.mjs` 的既有失效导入，2026-11-02 起就存在，不在本批范围）；`check:frontend-globals` state 层无新增。变异抽查两项（删 `_agentSuspended` 的 export → import 侧 SyntaxError；`sidebar-render` 的 claim set 改空函数 → `p2-w2-6` 用例红）。

### 第七批：session-view-state（T2 渲染层收尾）

时序审计结论：6 个对外函数在 classic 侧的调用点全部位于函数体 / 默认参数 / 宿主闭包内，首屏链自第六批已移到 `boot.js` 模块相，因此不存在「classic 加载期读它的状态」的顺序依赖，未触发 B 系列阻断流程。

三处值得记录的判断：

1. **identity 族 6 条 `defineKey` 随批注销**：唯一生产消费方 `session-view-commit-host` 改具名 import，其余只剩测试表达式。初值改为本文件求值时经 setter 写进 owner，测试改读模块导出——桥债注册维度净 0（注销 6、新增 6 个对外 API 键）。
2. **`session-view-commit-host` 的 window 抓取是隐性装载序依赖**：它是 `kernel-entry` 的首条 import，而会话视图域正是经这条边被拉进图的，`window.createSessionViewCommitHost()` 在该时点必然读到 undefined。与第六批 B2/B3 完全同型，只是此前没暴露（迁移前由 classic 相先行注册兜住）。
3. **测试桩的替换而非削弱**：`frontend-session-view-identity-state` 的「classic 经 window 写 → claim 吸收 + 代次守卫」拆成两条真实出口（claim 吸收 `defineKey` 初值为同一引用；setter ↔ 活绑定 ↔ 访问器同一份状态），patch 与代次守卫由 `frontend-session-view-commit` / `frontend-session-view-matrix` 承担。`test/helpers/session-view-commit.js` 删除，两个消费者改真实图。

验收（实跑）：`test:core` 6647 项 / 6640 通过 / 3 失败（全部为已知平台项）/ 4 跳过；浏览器首屏回归主链 + 7 面板 PASS、零 pageerror；`check-import-cycles` 零新增环；三个门禁通过；`check:frontend-globals --update-baseline` 只做收敛（state 248 → 247、behavior 554 → 544，均为主助手复核后的纯删减）。

### 第八批：app-ui（T2 渲染层收尾）

app-ui.js 是最后一件大文件（2281 行）。时序审计的结论是「无装载期触达」：40 个顶层函数的 classic 消费点全在函数体或宿主闭包里，首屏链自时序切换后已在 `boot.js` 模块相。转换后 23 个键上桥、22 个函数收为模块私有，DOM 引用经 app-core 的 `domRefs` 取同一批加载期 `const`。

三件事按重要性排列：

1. **`workspace-surface-host` 的宿主面必须改成首调惰性**（阻断 B-A）。它原来在模块求值期 `...window.createWorkspaceSurfaceHost()`，而该工厂属于 app-ui；具名 import 会形成 `app-ui → assembly-actions / workspace-blocks / session-list-render → workspace-surface-host → app-ui` 的静态环，并把 app-ui 整张图拖进任何触达这些域的模块图（实测每个测试 case +29ms，7 个纯函数文件从 3.8s 涨到 8.2s）。改成首调时经桥键解析后，零静态环、零图膨胀；`selectWorkspaceSurface` 签名与桥键写值槽不变。
2. **`resources-viewer` 的静默丢功能（本批发现并修复）**。它是 classic 脚本，在解析期自注册 work-group 的「资料 / 文档」两个 rail 面板，走的是 `window.registerFeaturePanel`（app-ui 的一行转发）＋ `typeof !== 'function'` 守卫。app-ui 进模块相后，解析期读不到该键，守卫静默返回——两个面板消失，而单元测试的金样本自己注入了转发函数，掩盖了这条路径。修复是让它直接调注册表本体 `window.ClawPanels.register`（`right-panel-registry.js` 早于它装载，是注册表的权威入口），并在生产浏览器回归里加断言：work-group 可用面板必须是 `resources / settings / threads / viewer`（把修复反向变异可打红，已验证）。
3. **`APP_UI_DOMAIN` 为显式 opt-in**：app-ui 的静态依赖覆盖整片域，逐 case 实例化 +29ms 会把纯函数测试文件推过 1.5s 预算，因此只在真正需要真实渲染的用例里装载（生产侧仍由 p4-entry 装载）。

**遗留债务（本批未修，需单独立项）**：11 个 `test/*browser-check.mjs` 手工拼页面，把已迁 ESM 的文件当 classic `<script src>` 装入，另有一个引用了 P4 T1 起已删除的 `markdown-bootstrap.js`（`p2-w2-7-context-menu-chromium-browser-check`）。它们不在 `npm test` 里，所以没有红灯信号，属于「看似可用的回归脚本」。清单：agent-loader / agent-snapshot / bg-panel / message-probe / metadata-commit / p2-w2-7-context-menu / runtime-poll / runtime-view-cache / session-data / session-view-commit / sidebar-freshness。修法是改为装载真实 `index.html` 链（与 `p2-production-boot-browser-check` 同路），或退役。

**债务处置（已收口）**：只有 `bg-panel` 有独占的、针对真实布局与滚动的断言（`scrollTop` / `scrollHeight` / 计算色，单元测试面没有真值），改写为装载真实 `index.html` 生产链（feature-comms 通道发现 / 请求面 / SSE 全由脚本内 HTTP 契约 mock 供出），断言集合保留并补了两条路径取证（轻量更新同节点、骨架变化新节点）。其余 10 个脚本的断言各有单元测试承接，已退役——逐条对照见 `test/frontend-agent-loader-host.test.js` / `frontend-agent-loader.test.js` / `frontend-agent-snapshot-loader.test.js` / `frontend-msg-probe.test.js` / `frontend-metadata-commit.test.js` / `p2-w2-7-context-menu.test.js` / `frontend-runtime-poll.test.js`（及 switch / handoff-409 / compact-resume / chat-loading 各自的专测）/ `frontend-runtime-view-cache.test.js` / `frontend-agent-load-latency.test.js` / `frontend-session-view-commit.test.js` / `frontend-sidebar-freshness.test.js`。

验收（实跑）：`test:core` 6647 项 / 6640 通过 / 3 失败（已知平台项）/ 4 跳过；浏览器回归主链 + 7 面板 + work-group 面板断言 PASS、零 pageerror；`check-import-cycles` 零新增环；三个门禁通过。

### 第九批：app-core 拆解（T1 收尾）

app-core 从 1439 行降到 838 行，四族抽出：`dom-refs`（140 行，37 个静态 DOM 引用 + 3 条顶层 click 监听）、`identity`（251 行，身份解析 + viewer 会话绑定 Map）、`transport`（348 行，fetch 分流 / invoke / 文件选择器 / Viewer 就绪宿主）、`format-utils`（71 行）。抽出后 app-core 内同名函数定义清零，内部调用一律走桥键——没有留第二份实现。

三处值得记的判断：

1. **桥债这批是反向的**（registered 383 → 398、claimed 110 → 114）。抽出状态必然要给仍留在 classic 的消费方（app-main / desktop-notify / 悬置域 wg-* / im-ui）留桥；已迁但仍按桥接期语义读 window 的四个域（sidebar-render / runtime-status / app-ui / input-render）也是。注销条件逐键写在四个模块的尾注，收敛点有两个：classic 侧改具名（随 app-main 迁移）、已迁侧收敛（T5 清零批次）。把这条写进记录，是为了避免后来人把这批读数当成债务增长。
2. **`p2-bootstrap-dom.js` 退化为纯转发壳**，而不是把 20+ 消费方的 import 路径改一遍——转发壳的寿命由 `dom-refs` 的桥键注销条件决定，届时一并删除。
3. **6 个零消费方元素引用随搬迁删除**（prebuilt-agent-list / tool-agent-list / prebuilt-group / tool-group / prebuilt-count / tool-count）：它们连 classic 宿主工厂都没交出，属于历史上就该清的死键，不是本批新产生的。

app-core 保留的 838 行不是剩余垃圾：47 个 `defineKey` 的真相被 app-main 与多个 ESM 域双向读写，owner 迁移必须与 app-main 同批；9 个 `createP2Bootstrap*Host` 工厂是 classic 词法状态到 ESM 域的窄宿主面，状态一迁走即消亡。

验收（实跑）：`test:core` 6651 项 / 6644 通过 / 3 失败（已知平台项）/ 4 跳过；浏览器回归主链 + 7 面板 + work-group 面板 PASS、零 pageerror；`check-import-cycles` 零新增环；两个门禁 12 项通过。

### 剩余核心批次的阻断清单（2026-11-17 实测）

`sidebar-render` 单独转换不可行，实测六处阻断；它必须与 `app-main` 同一批处理（称为「T2 收尾批次」），并附带两处最小 host seam：

| # | 键 / 状态 | 触达点 | 真实后果 | 需要一起改的文件 |
|---|---|---|---|---|
| B1 | `createAgentCallStatesHost` | `app-main.js:864-1030` 顶层 IIFE（调用点 `:1016`） | classic 解析相求值，模块未执行 → `ReferenceError`；异常终止 app-main 余下语句，`visibilitychange` 与 `await __clawAuthReady → startApplication()` 都不注册，整页不启动 | app-main.js |
| B2 | `createAgentSnapshotLoaderHost` | `agent-snapshot-loader-host.js:8` 顶层调用，该模块由 kernel-entry 装载（早于 p4-entry） | 返回 undefined → 装载器构造抛错，kernel-entry 整图求值中断 | kernel-entry.js 或该 host 文件 |
| B3 | `createP2BootstrapSidebarRenderHost` | `p2-bootstrap-sidebar.js:20` 顶层（路径 kernel-entry → agent-loader-host → sidebar-operations） | 同上，TypeError 中断整图 | 该文件或 kernel-entry.js |
| B4 | `_agentSuspended` | `runtime-status.js:622` classic `const`，只经 `createAgentCallStatesHost()` 交给 classic 引擎 | ESM 侧拿不到 Map 身份（引擎要 `set/delete/keys`）；这正是 `runtime-status` 自身 R1 的同一条链 | runtime-status.js（随本批迁移） |
| B5 | `_interruptSuppression` | `app-core.js:378`，`createCallInterruptHost()` 只给函数面 | 引擎要 `interrupting.delete(key)`，缺容器 | app-core.js（加最小 seam） |
| B6 | `pendingPrebuiltAgentIds` | `app-core.js:15` classic `const Set`，无任何 host 工厂暴露 | `renderAgentItems` 的 `has()` 与签名里的 `Array.from()` 都需要它 | app-core.js（加最小 seam） |

转换时可直接复用的键分类（实测）：11 键收敛为模块私有；5 个 `onSidebar*` 是内联事件协议（保持 `window.X = function`，台账会保留这 5 条 behavior，修剪基线要对表）；3 个函数仅测试消费（命名导出、不上桥）；桥键含 `renderAgentList`（27 个 public 文件 + 78 个测试文件）、`createAgentCallStatesHost`（app-main + 38 个测试文件）、`renderAgentGroup` / `renderAgentItems` 等。

## 接续与回滚

每批独立提交、可独立回退（D4/D5 既有纪律）；T2 时序切换提交单独成 commit，回退它即回到同步首屏（桥与模块保留）。本计划实施期间如遇与 ADR-0051 冲突的边界，以 ADR 为准并报告，不自行扩大解释。
