/**
 * dom-refs.js — 首屏 DOM 引用域（P4 T1：从 app-core 抽出的第一族）。
 *
 * 原先住在 app-core.js 的 classic 顶层：`document.getElementById(...)` 得到的
 * 一批常量引用 + 依附其上的三条 click 监听。迁入模块后：
 *
 *   - 求值时相从「加载序」变为模块相（deferred）。DOM 此时已解析完毕，逐 id
 *     查询与原 const 等价重建（配方 R3）；元素从不替换，引用身份不变。
 *   - ESM 消费方经 `domRefs` 取用（适配模块 p2-bootstrap-dom.js 转发本模块导出，
 *     消费方 import 路径不变）。
 *   - 仍有 window 面消费方的三键经 KernelState 桥键（domain `dom-refs`）暴露：
 *     app-main 的顶栏标题（currentAgentTitle）、聊天容器（container，含 app-core
 *     的 createRuntimeViewCacheHost 读 scrollTop），以及一等面板插件
 *     （panel-plugins/git.js、session-controls.js）的事件委托目标
 *     featurePanelBody——它们按 ADR-0044 的宿主全局契约保留裸引用，桥键是这些
 *     引用的唯一来源。其余 34 键零外部消费面，收敛为模块私有，不进桥债台账。
 *   - app-core 原声明里的 6 个元素引用（prebuilt-agent-list / tool-agent-list /
 *     prebuilt-group / tool-group / prebuilt-count / tool-count）全库零消费方
 *     （连 classic 工厂都没交出），随搬迁删除，不留死键。
 *   - 三条顶层 click 监听同步搬到模块相。语义与其余已迁域一致：解析完成到模块
 *     求值之间点这三个静态按钮不再有任何效果（此前会走 classic 实现）。
 *
 * 注销条件：app-main 迁 ESM 后改为具名 import，`container` 与 `currentAgentTitle`
 * 两个桥键随之下桥（届时 app-core 的 createRuntimeViewCacheHost 一并改具名取用）；
 * 面板插件改从 domRefs 取用后 `featurePanelBody` 下桥。
 */

const container = document.getElementById('chat-container');
const agentList = document.getElementById('agent-list');
const externalAgentList = document.getElementById('external-agent-list');
const externalGroup = document.getElementById('external-group');
const externalCount = document.getElementById('external-count');
const currentAgentTitle = document.getElementById('current-agent-name');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarResizer = document.getElementById('sidebar-resizer');
const sidebarCollapseHint = document.getElementById('sidebar-collapse-hint');
const featurePanel = document.getElementById('feature-panel');
const featurePanelTitle = document.getElementById('feature-panel-title');
const featurePanelBody = document.getElementById('feature-panel-body');
const featurePanelResizer = document.getElementById('feature-panel-resizer');
const featurePanelCollapseHint = document.getElementById('feature-panel-collapse-hint');
const agentContextMenu = document.getElementById('agent-context-menu');
const restartAgentAction = document.getElementById('restart-agent-action');
const stopAgentAction = document.getElementById('stop-agent-action');
const deleteAgentAction = document.getElementById('delete-agent-action');
const compactContextMenu = document.getElementById('compact-context-menu');
const compactSummaryAction = document.getElementById('compact-summary-action');
const compactTrimAction = document.getElementById('compact-trim-action');
const compactBranchAction = document.getElementById('compact-branch-action');
const projectContextMenu = document.getElementById('project-context-menu');
const deleteProjectAction = document.getElementById('delete-project-action');
const featureRepoContextMenu = document.getElementById('feature-repo-context-menu');
const deleteFeatureAction = document.getElementById('delete-feature-action');
const ctxMenu = document.getElementById('ctx-menu');
const followLatestButton = document.getElementById('follow-latest-btn');
const workspaceTabsBar = document.getElementById('workspace-tabs-bar');
const projectDocsetToggle = document.getElementById('project-docset-toggle');
const chatProcessToggle = document.getElementById('chat-process-toggle');
const projectDocsetOverlay = document.getElementById('project-docset-overlay');
const projectDocsetSheet = document.getElementById('project-docset-sheet');
// rail 面板按钮不再启动快照（ADR-0044 P2b：由 syncRailButtons 按注册表
// 动态生成，消费方动态查询）；工具按钮仍静态声明于 index.html。
const languageToggle = document.getElementById('language-toggle');
const themeToggle = document.getElementById('theme-toggle');
const settingsToggle = document.getElementById('settings-toggle');

/**
 * 对外唯一的 DOM 引用面（键名沿用 classic 声明名）。全部是模块求值期的
 * 元素引用，冻结后只读——向属性赋值在 ESM strict 下抛 TypeError，与 classic
 * 顶层 const 的只读语义一致。
 */
export const domRefs = Object.freeze({
  container,
  sidebar,
  sidebarToggle,
  sidebarResizer,
  sidebarCollapseHint,
  featurePanelResizer,
  featurePanelCollapseHint,
  workspaceTabsBar,
  settingsToggle,
  agentList,
  externalAgentList,
  externalGroup,
  externalCount,
  currentAgentTitle,
  featurePanel,
  featurePanelTitle,
  featurePanelBody,
  agentContextMenu,
  restartAgentAction,
  stopAgentAction,
  deleteAgentAction,
  compactContextMenu,
  compactSummaryAction,
  compactTrimAction,
  compactBranchAction,
  projectContextMenu,
  deleteProjectAction,
  featureRepoContextMenu,
  deleteFeatureAction,
  ctxMenu,
  followLatestButton,
  projectDocsetToggle,
  projectDocsetOverlay,
  projectDocsetSheet,
  chatProcessToggle,
  languageToggle,
  themeToggle,
});

if (projectDocsetToggle) {
  projectDocsetToggle.addEventListener('click', () => window.toggleProjectDocsetOverlay());
}
if (chatProcessToggle) {
  chatProcessToggle.addEventListener('click', () => window.toggleChatProcessVisibility());
}
if (projectDocsetOverlay) {
  projectDocsetOverlay.addEventListener('click', (event) => {
    if (event.target === projectDocsetOverlay) {
      window.toggleProjectDocsetOverlay(false);
    }
  });
}

// 仍 classic 的消费方（app-main 顶栏标题 / 聊天容器、app-core 的 runtime view
// cache）与面板插件读这三个键；其余 34 键零 window 面消费面，不注册。
const bridgeState = {
  container: domRefs.container,
  currentAgentTitle: domRefs.currentAgentTitle,
  featurePanelBody: domRefs.featurePanelBody,
};
window.KernelState.defineKey('dom-refs', 'container', bridgeState.container);
window.KernelState.defineKey('dom-refs', 'currentAgentTitle', bridgeState.currentAgentTitle);
window.KernelState.defineKey('dom-refs', 'featurePanelBody', bridgeState.featurePanelBody);
window.KernelState.claim('dom-refs', {
  get: (key) => bridgeState[key],
  set: (key, value) => { bridgeState[key] = value; },
});
