import { createAgentLoader } from './agent-loader.js';
import { allAgents } from './agent-store-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { toolRenderConfigs } from './session-view-storage.js';
import { commitSessionViewPatch } from './session-view-commit-host.js';
// 与 template-engine 的静态环：对端只读本模块的 FEATURE_TEMPLATE_MAP（仅函数体内），
// 本模块只取它的两个函数并以惰性包装注入 loader —— 环内两侧顶层都不解引用对端
// 绑定（不依赖函数声明提升，也没有 TDZ 风险）。真实整图由
// frontend-agent-loader-host / p2-esm-graph-isolation 用例执行。
import { collectTemplateNames, warmTemplatesInBackground } from './template-engine.js';
// sidebar-operations / project-data 都已是 ESM：具名 import。
// 与 project-data 的静态环：agent-loader-host → project-data → session-ui →
// agent-snapshot-loader-host →（session-data-loader-host / 本模块）。本模块顶层
// 只建 loader 闭包、注入点全部惰性转调，求值期不解引用对端绑定；环内对端模块
// 的顶层读取（loadAgentDetail / loadAgentData / loadFeatureTemplateMap /
// refreshCurrentRuntimeStatus）已在两个 host 里改成惰性转调，故无 TDZ。
// 真实整图由 test/p2-input-loader-cycle-graph.test.js（多入口求值）执行。
import {
  captureSidebarSnapshotToken,
  isSidebarSnapshotTokenCurrent,
  mergeWorkspaceSessionSnapshots,
} from './sidebar-operations.js';
import { getPhSessionOwnershipParams } from './project-data.js';

export let FEATURE_TEMPLATE_MAP;
/** 模板映射的唯一写入口：agent-data-loader 的 clearTemplates 与 loader 自身共用。 */
export const setFeatureTemplateMap = (value) => { FEATURE_TEMPLATE_MAP = value; };
const loader = createAgentLoader({
  loadedAgentDetailIds: window.AgentLoaderHost.loadedAgentDetailIds,
  currentRuntimeAgentId: () => currentRuntimeAgentId,
  fetch: (...args) => window.fetch(...args),
  setFeatureTemplateMap,
  allAgents: () => allAgents,
  // sidebar-operations / project-data 都是 ESM：具名 import + 注入点惰性转调
  // （agent-loader 在 loadAgentDetail 调用时取 host.<entry>，模块求值期不触达）。
  getPhSessionOwnershipParams: (agent) => getPhSessionOwnershipParams(agent),
  captureSidebarSnapshotToken: () => captureSidebarSnapshotToken(),
  isSidebarSnapshotTokenCurrent: (token) => isSidebarSnapshotTokenCurrent(token),
  captureSessionViewToken: () => typeof window.captureSessionViewToken === 'function'
    ? window.captureSessionViewToken() : null,
  commitSessionViewPatch,
  get mergeWorkspaceSessionSnapshots() { return mergeWorkspaceSessionSnapshots; },
  updateChatContextBar: (...args) => typeof window.updateChatContextBar === 'function'
    && window.updateChatContextBar(...args),
  renderCurrentMainView: (...args) => typeof window.renderCurrentMainView === 'function'
    && window.renderCurrentMainView(...args),
  toolRenderConfigs: () => toolRenderConfigs,
  // 环内含 template-engine：注入点用惰性包装，模块顶层不读对端绑定
  // （与 agent-data-loader 同形），环的安全性不依赖函数声明提升。
  collectTemplateNames: (tools) => collectTemplateNames(tools),
  warmTemplatesInBackground: (...args) => warmTemplatesInBackground(...args),
  warn: (...args) => console.warn(...args),
  info: (...args) => console.info(...args),
  log: (...args) => console.log(...args),
});

export const { loadFeatureTemplateMap, reloadFeatureTemplateMap, loadAgentDetail,
  getAgentDetailPayload, extractSessionMetaFromDetail } = loader;

window.KernelState.defineKey('agent-loader', 'loadFeatureTemplateMap', loadFeatureTemplateMap);
window.KernelState.defineKey('agent-loader', 'reloadFeatureTemplateMap', reloadFeatureTemplateMap);
window.KernelState.defineKey('agent-loader', 'loadAgentDetail', loadAgentDetail);
const compatibility = { ...loader };
window.KernelState.claim('agent-loader', {
  get: (key) => key === 'FEATURE_TEMPLATE_MAP' ? FEATURE_TEMPLATE_MAP : compatibility[key],
  set(key, value) {
    if (key === 'FEATURE_TEMPLATE_MAP') setFeatureTemplateMap(value);
    else compatibility[key] = value;
  },
});
