/**
 * kernel-entry.js — 唯一模块装载入口（P4 T5 收尾：p2-entry / p4-entry 已合并进来）。
 *
 * 合并前是三层：kernel-entry → p4-entry → p2-entry。分期迁移时那三层各有意义
 * （P2 那批在"首屏同步链仍由 classic 触发"的前提下迁移；P4 时序切换后迁移的域
 * 没有 classic 相同步触达约束，批次语义不同），但批次收尾后它们只是装载清单的
 * 三段，分成三个文件的唯一作用是多两层间接。
 *
 * ## 三段装载顺序（改动前先读，顺序错了会中断整图求值）
 *
 * 1. 内核宿主图（本文件上半）：各域宿主模块，求值期互相取 `window.createXHost()`；
 * 2. P4 段：活跃域清零后迁移的模块。**必须早于 P2 段**——P2 图里的消费方在求值期
 *    经桥键取 P4 提供的能力（thread-store-domain 装载时调 window.createThreadStoreHost()、
 *    chat 窗口链取 chat-viewport 的锚点函数）。其中 `thread-store.js` 还必须早于
 *    P2 段整体（P2 经 workspace-actions 的链带入 thread-store-domain）；
 * 3. P2 段：P2 消费方批次模块。
 *
 * 首屏渲染入口 boot.js 是 index.html 的最后一条 module 标签，晚于本文件，因此这里
 * 注册的桥键对首屏链一定可见。新增一批须在 test/frontend-script-tags-gate.test.js
 * 有意识登记（R4：装载链改变即时序改变）。
 */

import './session-view-commit-host.js';
import './runtime-status-loader-host.js';
import './session-data-loader-host.js';
import './poll-coordinator-host.js';
import './message-probe-host.js';
import './metadata-commit-host.js';
import './runtime-poll-host.js';
import './poll-cycle-host.js';
import './agent-loader-host.js';
import './runtime-view-cache-host.js';
import './call-interrupt-host.js';
import './agent-call-states-host.js';
import './agent-snapshot-loader-host.js';
import './time-format-host.js';
// P4 T1 原料层：i18n 域的 t 桥键（实现见 ../i18n.js）。模块相注册即可——
// classic 相已无 t 的加载期调用（首屏由 boot 在模块相触发）。
import './i18n-host.js';
import './runtime-switch-host.js';
import './workspace-session-navigation-host.js';
import './workspace-entry-host.js';
import './compact-resume-host.js';
// workspace-surface-host 随 app-ui 批进入 p4-entry（求值期取 app-ui 的宿主工厂，
// 必须在 app-ui 之后求值）。
import './application-startup-host.js';
import './stream-draft-logic.js';
import './trim-ratio-core.js';

// ═══ P4 段（原 p4-entry.js）═══
// ── T1 原料层：app-core 内部三族抽取（三族四个模块）──
// app-core 仍是 classic（不能 import ESM），三族迁出后由本入口在模块相求值；
// 每族对外给命名导出（已迁消费方改具名 import），并只为「仍有 classic / window
// 面消费方」的键注册桥键。求值顺序：dom-refs 无依赖；identity / transport 只
// 依赖 window 上的桥键与 classic 函数，晚绑定读取，顺序不影响语义。
import './dom-refs.js'; // 首屏 DOM 引用域（37 键 + 三条顶层 click 监听）；桥 domain dom-refs（3 键）
import './identity.js'; // 会话/运行身份解析域；桥 domain identity（10 键 ← app-core / app-main / desktop-notify）
import './transport.js'; // 传输域：fetch 分流补丁 + invoke + Viewer 就绪宿主；桥 domain transport（invoke ← app-main / wg-*）
import './format-utils.js'; // 展示格式化函数族；桥 domain format-utils（localizeWorkspaceValue ← im-ui）

// ── T2 渲染层批次 ──
// session-view-state：会话视图提交边界（token 捕获 / patch 门 / 代次守卫）。
// 求值期已由 kernel-entry 的首条 import（session-view-commit-host）经具名导出带入，
// 此处显式登记两层含义：批次归属，以及「桥键必须在首屏 boot 之前注册」的时相。
// 6 个桥键 ← app-core / app-ui / app-main（classic）与 SSE / 轮询 / 输入面等
// window 晚绑定消费方；状态族 owner 是 session-view-storage / session-view-identity-state。
import './session-view-state.js';
// sidebar-layout：用户自有侧栏布局（拖拽/键盘整理 + 持久化）。对外 API 仍经
// window.ClawSidebarLayout 桥键供 classic sidebar-render 与诊断面取用。
import './sidebar-layout.js';

// ── L1 长尾编排层（T3 批次一）──
// 四件的桥键都是首屏 renderCurrentMainView 链的裸调用目标（updateChatContextBar /
// updateProjectDocsetChrome / getEmptyTodoPlan 等），必须早于 boot.js 求值。
import './chat-context-bar.js'; // 上下文栏与 hover 弹窗；桥 updateChatContextBar ← app-ui
import './workspace-docset.js'; // project docset chrome；桥 ← app-ui / p2-w2-10
import './todo-plan.js'; // 计划面板与 todo 控制；6 桥键 ← app-ui / app-core / app-main / session-view-state
import './panel-plugins.js'; // 懒面板声明（纯副作用，无桥键）

// ── L2 长尾编排层（T3 批次二）──
import './rail-customize.js'; // rail 清单 / 配置 API；桥 applyRailConfig ← app-ui / debug-panel-host
import './generative-ui-panel.js'; // GenUI 面板；桥 GenUIPanel ← agent-data-loader
// desktop-open / desktop-notify 仍是 classic 唯一实现：壳侧 webview eval 在页面装载
// 完成前就可能投递（`&&` 守卫是静默丢弃而非排队），迁到模块相会多出一段请求被吞
// 的窗口。见 P4 计划「T2 早期事件窗口」与 test/frontend-desktop-open.test.js。

// ── T2 渲染层：调试面板三件（T3 批次二）──
// rail 按钮在首屏渲染时生成，其 render / onOpen 闭包由 app-ui 持有并裸调这些桥键。
import './debug-panel-host.js'; // renderFeaturePanel / toggleFeaturePanel / syncRailButtons / syncPanelBodyHtmlCache
import './debug-logs.js'; // renderLogsPanel / loadLogs / safePrettyJson
import './debug-features-hooks.js'; // renderFeaturesPanel / renderReverseHooksPanel
// right-panel-registry 仍保留：window.ClawPanels 转发壳的消费面未归零（悬置域与
// 旧模板仍按 window 取用），退役判定见 P4 计划「T4 悬置域封存」。

// ── T3 长尾：后台任务面板与语音输入（L3 批次）──
import './bg-panel.js'; // 后台任务面板；桥 BgPanel ← agent-data-loader
import './voice-input.js'; // 语音录制 / 转写；状态键 owner 在 p2-w2-3a-voice-state，api 经 voice-input-api 域

// ── T3 长尾：线程刷新引擎与插件清单 ──
import './thread-store.js'; // 线程刷新引擎（2s 启动 / 20s 周期 / visibilitychange）；桥 domain thread-store-engine
import './plugin-manifest.js'; // APP 插件清单解析；桥 resolveAgentPlugin ← app-ui
// auth-client 已迁 ESM（P4 收尾）：它是 index.html 的**独立 module 入口**，排在
// app-main 之前（认证闸 __clawAuthReady 必须在编排域求值前发布），因此本入口不
// 重复 import；桥键 domain `auth-client` 服务 sse-client 的自举判定与 app-ui 的
// 访问保护设置入口。

// ── T3 长尾：远程连接（remote-connections）──
import './remote-connections.js'; // 远程命名空间 / 侧栏远程投影 / 远程写链路；10 桥键

// ── T2 渲染层：聊天视口与跟随（chat-viewport）──
import './chat-viewport.js'; // 视口/跟随/锚点域；29 桥键 ← app-ui / app-main / app-core / chat-renderer / chat-scroll
// chat-renderer：消息渲染主路径；12 桥键 ← app-ui / app-main / claw-host / lazy-tool-content。
// 折叠偏好三兄弟经 app-core 的 chatSurface 宿主 seam 读写（getter 现取，activate
// 重赋值后立即可见）。后 5 个桥键（toggleMessage / toggleErrorGroup / openImageZoom /
// computeAssistantErrorGroups / syncRowCollapseState / settleAllRowCollapseStates /
// syncCollapseStates / getMessageRollbackEditActionHtml）的消费方与本源互相 import，
// 注销要先把共享面下沉到无环投影模块（见文件末尾注释）。
import './chat-renderer.js';
// runtime-status / sidebar-render / agent-call-states-engine（P4 T2 收尾批次）：
// B1–B4 互锁，必须同批进模块相——sidebar-render 的 createAgentCallStatesHost()
// 按引用交出 runtime-status 的 _agentSuspended（B4）；原 app-main 顶层 IIFE 的调用
// （B1）已搬出为 agent-call-states-engine；两个宿主工厂的求值期抓取（B2/B3）改
// 具名 import。三者都进模块相后，app-core 补的两处最小 seam 让引擎仍拿到
// _interruptSuppression（B5）与 pendingPrebuiltAgentIds（B6）。
import './runtime-status.js'; // 运行时状态 / 通知 / 指示块；状态 owner p2-w2-2，函数键桥 runtime-status-api
import './sidebar-render.js'; // 侧栏渲染与数据装载宿主；7 桥键（sidebar-render 域）
import './agent-call-states-engine.js'; // call 状态对账引擎唯一实例；桥 agent-call-states + ClawFW.CallStates

// ── T2 渲染层：输入面剩余两件（input-composer / persistent-input）──
import './input-composer.js'; // 会话草稿缓存 + 模式判定 + composer 本体；桥 domain input-composer / input-composer-api
import './persistent-input.js'; // 常驻输入框 / 队列提交 / 图片附件；桥 input-queue / input-call-elapsed / persistent-input-api

// ── T2 渲染层：聊天滚动与输入薄壳（T3 批次三）──
import './rollback-dialog.js'; // 部分压缩状态键注册壳（owner/claim 在 p2-w2-3b-rollback-domain）
import './chat-scroll.js'; // 滚轮归一化 / 跟随判定；零桥键（纯函数与容器监听）
import './input-helpers.js'; // 桥 updateChatProcessToggle ← app-ui
import './input-render.js'; // 桥 notifyInputSurfaceChanged ← session-view-state / app-ui / persistent-input

// ── T2 渲染层末件：app-ui（工作空间主视图渲染域）──
// 排在 P4 各域之后：本域在求值期注册宿主 block primitive、面板注册、actions 与
// 布局监听，并在末尾登记 domain `app-ui` 的桥面；它的具名 import 覆盖
// chat-viewport / chat-renderer / workspace-blocks / assembly-* / debug-* 等已迁
// 域，排在它们之后求值可保持「先注册域状态、后注册消费方桥」的既有次序。
// 装载期消费方 workspace-surface-host 在同一相内随后求值（具名 import）。
import '../app-ui.js'; // 桥 domain app-ui（23 键）；createWorkspaceSurfaceHost ← workspace-surface-host
import './workspace-surface-host.js'; // 导航宿主装配（求值期取 app-ui 的 createWorkspaceSurfaceHost）

// ═══ P2 段（原 p2-entry.js）═══
// ── 1. 批次入口（按批号顺序；批内顺序见各自头注） ──
import './p2-w1-2-panel-bootstrap.js'; // 批次 2：右栏注册表与插件底座
import './p2-w2-3a-input-bootstrap.js'; // 第二波 3a：输入面状态 owner + 队列投影
import './p2-w2-3b-input-bootstrap.js'; // 第二波 3b：回退域 owner + APP 输入面
import './p2-w2-4-title-timeline-bootstrap.js'; // 第二波 4：模板 / overview / 标题 / 时间线
import './p2-w2-6-sidebar-session-bootstrap.js'; // 第二波 6：侧栏操作与会话状态
import './p2-w2-7-menu-session-bootstrap.js'; // 第二波 7：会话列表与菜单声明
import './p2-w2-7-context-menu-bootstrap.js'; // 第二波 7：上下文菜单开关与动作
import './p2-w2-8-project-domain-bootstrap.js'; // 第二波 8：编程小助手项目域
import './p2-w2-10-assembly-bootstrap.js'; // 第二波 10：装配工作台与表面块
import './p2-debug-small-bootstrap.js'; // 调试小批：装配预检 / MCP 面板
import './p2-w2-11-debug-deep-bootstrap.js'; // 第二波 11：调试总览面板

// ── 2. 生产兼容桥 / 状态 owner 宿主（批次交付时未附入口文件） ──
// p2-w2-1：process 窗口分级与整行实测窗口的 classic 消费面桥键（实现模块可重装，
// 注册只在此处发生一次，见文件头注）。
import './p2-w2-1-chat-windowing-host.js';
// p2-w2-2：runtime-status 域三个跨文件可变状态键的 owner（初值由 classic
// runtime-status.js 在原声明位置注册，这里 claim 吸收）。
import './p2-w2-2-runtime-status-owner.js';

// ── 3. 其余已迁模块（原 index.html classic 标签已删除） ──
// 原 index.html 413-479 段（配置 / 面板 / 工具）中未被批次入口覆盖的部分
import './speech-config-cache.js';
import './claw-select.js';
import './app-info.js';
import './usage-info-overlay.js';
import './speech-settings.js';
import './oauth-flow.js';
import './proxy-overlay.js';
import './workspace-settings.js';
import './model-settings.js';
import './mcp-gateway-ui.js';
import './remote-claw-settings.js';
import './context-guard-toggle.js';
import './conversation-export-dialog.js';
import './generative-ui-renderer.js';

// 原 index.html 480-500 段（表面块 / 右栏）
import './annotations.js';

// 原 index.html 476 段（Phase B 输入面）：choice-input 由第二波 3b 入口带入，
// 这里只补 input-model-switcher。两者之间仍是 classic 的 input-helpers /
// input-render / persistent-input 继续按原位置加载（见文件头"不在本入口的边界"）。
import './input-model-switcher.js';

// 原 index.html 501-517 段（Phase A：输入 / 会话引用 / 项目与线程）
// （session-reference-picker / ph-thread-history 走批次导入）

// 原 index.html 518-532 段（Phase B/C：会话变更 / 菜单 / 工具进度 / slash）
import './tool-progress.js';
// workspace-actions（原 index.html 485 段）：整文件已迁 ESM，classic 标签删除。
// 唯一桥键 runWorkspaceAction 继续服务 classic 消费方（app-main / app-ui /
// thread-store / 悬置域）；thread-store 自身仍是 classic 刷新引擎，不在此入口。
import './workspace-actions.js';
import './slash-menu.js';
import './slash-commands.js';

// 原 index.html 533-551 段（Phase D：聊天渲染 / 侧栏会话 / SSE / feature 通道）
import './chat-row-visibility.js';
import './lazy-tool-content.js';
import './workspace-agents.js';
import './runtime-mode-menu.js';
import './chat-nav-timeline.js';
import './session-readonly-view.js';
import './sse-client.js';
import './feature-communication.js';
