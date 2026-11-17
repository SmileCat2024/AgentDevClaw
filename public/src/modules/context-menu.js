// context-menu.js
// Phase 2c-3: 上下文菜单功能（Domain P）
// 从 app-ui.js 提取的 8 个右键菜单函数
// （会话菜单已退役：会话右键统一走 ctx-menu-items.js 声明式菜单，ADR-0049）
//
// ESM 化：P2 W2-7 菜单批剩余部分（原位转换，菜单几何与开关行为零变化）。
// 跨文件依赖一律经既有适配面取用，不裸读 classic 词法：
//   - 6 个待执行目标（contextMenu*）→ p2-bootstrap-context-menu.js 的
//     contextMenuUi（get/set 成对转发 app-core 原 let，本文件不持有副本）
//   - 菜单元素 → p2-bootstrap-dom.js 的 domRefs（app-core 加载期 const 引用）
// 四个关闭/打开入口经 kernel-state 访问器桥暴露，消费方分两类（逐键证据见
// 文件末尾桥接块）：
//   - 仍 classic：sidebar-render.js、app-main.js（裸标识符 / 宿主工厂内调用）
//   - 已 ESM 但当前以 window.* 取用（存量债，不在本批授权内改）：
//     ph-session-list.js、trim-page.js、session-dialogs.js
// openAgentContextMenu / openProjectContextMenu / openFeatureRepoContextMenu /
// closeFeatureRepoContextMenu 的唯一消费方是本批一同迁移的 ctx-menu-handlers.js，
// 直接 import，不上桥。

import { domRefs } from './p2-bootstrap-dom.js';
import { contextMenuUi } from './p2-bootstrap-context-menu.js';

const {
  agentContextMenu,
  projectContextMenu,
  featureRepoContextMenu,
  compactContextMenu,
  restartAgentAction,
  stopAgentAction,
  deleteAgentAction,
} = domRefs;

// ── 关闭函数 ──────────────────────────────────────────────

export function closeAgentContextMenu() {
  agentContextMenu.classList.remove('open');
  contextMenuUi.contextMenuAgentId = null;
  contextMenuUi.contextMenuAgentMode = null;
}

export function closeProjectContextMenu() {
  projectContextMenu.classList.remove('open');
  contextMenuUi.contextMenuProjectAgentId = null;
  contextMenuUi.contextMenuProjectId = null;
}

export function closeFeatureRepoContextMenu() {
  featureRepoContextMenu.classList.remove('open');
  contextMenuUi.contextMenuFeatureRepoPackageId = null;
}

export function closeCompactMenu() {
  compactContextMenu.classList.remove('open');
  contextMenuUi.contextMenuCompactAction = null;
}

// ── 打开函数 ──────────────────────────────────────────────

export function openCompactMenu(action, x, y) {
  closeAgentContextMenu();
  closeProjectContextMenu();
  contextMenuUi.contextMenuCompactAction = action;

  const margin = 8;
  compactContextMenu.classList.add('open');
  compactContextMenu.style.left = '0px';
  compactContextMenu.style.top = '0px';

  const rect = compactContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  compactContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  compactContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

export function openFeatureRepoContextMenu(packageId, x, y) {
  closeAgentContextMenu();
  closeProjectContextMenu();
  contextMenuUi.contextMenuFeatureRepoPackageId = packageId;

  const margin = 8;
  featureRepoContextMenu.classList.add('open');
  featureRepoContextMenu.style.left = '0px';
  featureRepoContextMenu.style.top = '0px';

  const rect = featureRepoContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  featureRepoContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  featureRepoContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

export function openProjectContextMenu(agentId, projectId, x, y) {
  closeAgentContextMenu();
  contextMenuUi.contextMenuProjectAgentId = agentId;
  contextMenuUi.contextMenuProjectId = projectId;

  const margin = 8;
  projectContextMenu.classList.add('open');
  projectContextMenu.style.left = '0px';
  projectContextMenu.style.top = '0px';

  const rect = projectContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  projectContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  projectContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

export function openAgentContextMenu(agentId, x, y, mode) {
  closeProjectContextMenu();
  contextMenuUi.contextMenuAgentId = agentId;
  contextMenuUi.contextMenuAgentMode = mode || null;
  const showRuntimeActions = mode === 'prebuilt-runtime' || mode === 'external-runtime' || mode === 'child-runtime';

  restartAgentAction.style.display = showRuntimeActions ? '' : 'none';
  restartAgentAction.disabled = !showRuntimeActions;
  stopAgentAction.style.display = showRuntimeActions ? '' : 'none';
  stopAgentAction.disabled = !showRuntimeActions;
  deleteAgentAction.style.display = mode === 'delete-only' ? '' : 'none';
  deleteAgentAction.disabled = mode !== 'delete-only';

  const margin = 8;
  agentContextMenu.classList.add('open');
  agentContextMenu.style.left = '0px';
  agentContextMenu.style.top = '0px';

  const rect = agentContextMenu.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - margin;
  const maxTop = window.innerHeight - rect.height - margin;
  agentContextMenu.style.left = Math.max(margin, Math.min(x, maxLeft)) + 'px';
  agentContextMenu.style.top = Math.max(margin, Math.min(y, maxTop)) + 'px';
}

// —— 桥接期兼容面（kernel-state 访问器桥）——
// 保留原因：以下四个入口仍有消费方在调用时点取用（全部位于事件回调或晚绑定
// 工厂内，无 classic 顶层调用，R1 零触线）；逐键消费面与注销条件：
//   closeAgentContextMenu   ← classic sidebar-render（会话项 ⋯ 入口）、
//     app-main（切换事务宿主工厂的 closeContextMenu，裸标识符）；
//     ESM ph-session-list（搜索结果 ⋯ 入口，window.*）
//   closeProjectContextMenu ← classic sidebar-render（裸标识符）；
//     ESM ph-session-list（window.*）
//   closeCompactMenu        ← classic sidebar-render（裸标识符）；
//     ESM ph-session-list / trim-page / session-dialogs（window.closeCompactMenu）
//   openCompactMenu         ← classic app-main（精简入口，裸标识符）
// 零 production 消费面（只作命名导出，不上桥）：openAgentContextMenu /
// openProjectContextMenu / openFeatureRepoContextMenu /
// closeFeatureRepoContextMenu——唯一消费方是本批迁移的 ctx-menu-handlers.js，
// 已改 import。
// 注销条件：上列消费方全部改用 import 后，删除对应 defineKey 并下调桥债基线
// （已 ESM 的三处先改 window.* → import，classic 的两处随各自批次迁移）。
const bridgeApi = {
  closeAgentContextMenu,
  closeProjectContextMenu,
  closeCompactMenu,
  openCompactMenu,
};
window.KernelState.defineKey('context-menu', 'closeAgentContextMenu', closeAgentContextMenu);
window.KernelState.defineKey('context-menu', 'closeProjectContextMenu', closeProjectContextMenu);
window.KernelState.defineKey('context-menu', 'closeCompactMenu', closeCompactMenu);
window.KernelState.defineKey('context-menu', 'openCompactMenu', openCompactMenu);
window.KernelState.claim('context-menu', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});
