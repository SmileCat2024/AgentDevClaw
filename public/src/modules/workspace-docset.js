/**
 * workspace-docset.js — 域 Q 的 project docset chrome（P4 L1 classic → ESM）。
 *
 * 迁移沿革：P2 W2-10 把本域的可迁实现移入 ESM 模块
 * [p2-w2-10-workspace-docset.js](p2-w2-10-workspace-docset.js)
 * （artifacts / project-docset 渲染、动作处理器、toggleProjectDocsetOverlay）。
 * 本文件只剩 `updateProjectDocsetChrome` 与它的读取 helper
 * `getCurrentProjectDocset`；原先因为 app-main 顶层 `applyTheme(); applyLanguage();`
 * 在 classic 相同步触达它而保持 classic——P4 时序切换（首屏链改由 ESM boot
 * 触发）解除了这条约束，本批按配方常规转换。
 *
 * 仍为 classic 的依赖（显式 `window.*` 晚绑定，均为运行期调用）：
 *   - `getCurrentAgentRecord`（app-main，编排域收敛时改 import）
 *   - `ensureUnitMode`（app-ui，渲染入口域收敛时改 import）
 *   - `localizeWorkspaceValue`（app-core，i18n/格式化域收敛时改 import）
 *   - `renderProjectDocsetContent`（域 Q 的 ESM 实现 p2-w2-10-workspace-docset.js
 *     经内核桥暴露的同名键）。刻意不做静态 import：本文件是「首屏 chrome 同步」
 *     的窄域，静态 import 会把整个装配渲染图拉进首屏依赖；该分支只在 agent
 *     workspace_data 就绪后可达，届时桥键必然已注册。
 *
 * 桥键（domain `workspace-docset-chrome`；`workspace-docset` 已被
 * p2-w2-10-workspace-docset.js 认领，故本文件用独立域避免二次 claim 覆盖）：
 *   - `updateProjectDocsetChrome` ← app-ui.js（renderCurrentMainView 四条分支，
 *     含首屏）
 *   - `getCurrentProjectDocset`   ← p2-w2-10-workspace-docset.js（overlay 渲染）
 *   注销条件：上述消费方迁 ESM 并改 import 后删除注册行与域。
 *
 * 时序审计（R1/R2/R4）：两条键在 classic 相都没有触达点——唯一首屏调用来自
 * boot 触发的 renderCurrentMainView（模块相），因此注册相位取模块求值相；
 * 本文件顶层只有函数声明与 import，无立即执行的初始化，加载相 → 模块相等价。
 */
import { domRefs } from './p2-bootstrap-dom.js';
import { escapeHtml } from './markdown-utils.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import {
  currentProjectDocsetOpen,
  setCurrentProjectDocsetOpen,
  setCurrentProjectRequirementEdit,
} from './render-entry-state.js';
import { localizeWorkspaceValue } from './format-utils.js';

// 加载期 DOM 引用（app-core 的 const 引用，元素从不替换）：解构语义与
// classic 裸读同一个元素对象。
const { projectDocsetToggle, projectDocsetOverlay, projectDocsetSheet } = domRefs;

// ── 读取 helper（首屏分支与 ESM 实现共用）──

export function getCurrentProjectDocset(agent = window.getCurrentAgentRecord()) {
  const workspaceData = agent?.workspace_data;
  if (!workspaceData || typeof workspaceData !== 'object') return null;
  const data = workspaceData['project-docset'];
  return data && typeof data === 'object' ? data : null;
}

// ── 首屏 chrome 同步 ──

export function updateProjectDocsetChrome(agent = window.getCurrentAgentRecord()) {
  if (!projectDocsetToggle || !projectDocsetOverlay || !projectDocsetSheet) return;
  const docset = getCurrentProjectDocset(agent);
  const canShowButton = Boolean(docset?.exists) && window.ensureUnitMode(agent) === 'chat';
  projectDocsetToggle.classList.toggle('hidden', !canShowButton);
  projectDocsetToggle.classList.toggle('active', canShowButton && currentProjectDocsetOpen);
  projectDocsetToggle.textContent = getCurrentLanguage() === 'zh' ? '项目文档' : 'Project Docs';

  if (!canShowButton) {
    setCurrentProjectDocsetOpen(false);
    setCurrentProjectRequirementEdit(null);
  }

  projectDocsetOverlay.classList.toggle('hidden', !(canShowButton && currentProjectDocsetOpen));
  if (!(canShowButton && currentProjectDocsetOpen)) {
    projectDocsetSheet.innerHTML = '';
    return;
  }

  const block = {
    id: 'project-docset',
    title: { zh: '项目文档集', en: 'Project Docset' },
    description: { zh: '当前项目的实时文档状态。', en: 'Live project documentation for the current conversation.' },
  };

  projectDocsetSheet.innerHTML = [
    '<div class="project-docset-sheet-head">',
    '<div>',
    '<div class="project-docset-sheet-title">' + escapeHtml(localizeWorkspaceValue(block.title, 'Project Docset')) + '</div>',
    '<div class="project-docset-sheet-subtitle">' + escapeHtml(String(docset?.projectDir || '')) + '</div>',
    '</div>',
    '<div class="workspace-actions"><button class="workspace-action secondary" type="button" data-action="wsDocset.overlayClose">关闭</button></div>',
    '</div>',
    '<div class="project-docset-sheet-body">',
    // 桥接期：实现于 p2-w2-10-workspace-docset.js（ESM，域 workspace-docset）；
    // 该分支只在 agent 数据已加载时可达。
    window.renderProjectDocsetContent(agent, block, docset),
    '</div>',
  ].join('');
}

// ── 兼容桥（classic 消费方收敛后注销）──────────────────────────────

const bridgeValues = { updateProjectDocsetChrome, getCurrentProjectDocset };

window.KernelState.defineKey('workspace-docset-chrome', 'updateProjectDocsetChrome', updateProjectDocsetChrome);
window.KernelState.defineKey('workspace-docset-chrome', 'getCurrentProjectDocset', getCurrentProjectDocset);
window.KernelState.claim('workspace-docset-chrome', {
  get(key) {
    return bridgeValues[key];
  },
  set(key, value) {
    bridgeValues[key] = value;
  },
});
