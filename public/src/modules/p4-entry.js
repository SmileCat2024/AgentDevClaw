/**
 * p4-entry.js — P4（活跃域 classic 清零）批次的装载入口。
 *
 * 为什么单独一层：P2 的消费方批次收口在 p2-entry.js（那批模块在"首屏同步链
 * 仍由 classic 触发"的前提下迁移，逐模块带 R1 残留说明）。P4 时序切换后
 * （boot 在模块相触发首屏），新迁移的域不再有 classic 相同步触达约束，批次
 * 语义与 P2 不同，装载清单也就不混在一起——回退某个 P4 批次时只动本文件一行。
 *
 * 时相：本模块由 kernel-entry 在 p2-entry 之后静态 import，仍在 DOMContentLoaded
 * 之前求值。首屏渲染入口 boot.js 是 index.html 的最后一条 module 标签，晚于
 * 本文件，因此这里注册的桥键对首屏链一定可见。
 *
 * 登记纪律：新增一批必须在 test/frontend-script-tags-gate.test.js 的
 * MODULE_ENTRY_IMPORTS 有意识登记（R4：装载链改变即时序改变）。
 */

// ── T2 渲染层批次 ──
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
// auth-client 判定 R1/R2/R4 触线，保持 classic：它创建 __clawAuthReady 并被 app-main
// 顶层 IIFE 等待，创建时点不能后移到模块相（详见 P4 计划实施记录）。

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
