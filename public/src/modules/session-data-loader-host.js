import { createSessionDataLoader } from './session-data-loader.js';
import { setCurrentRuntimeAgentId } from './orchestration-state.js';
import { focusedAgentId } from './agent-store-state.js';
import { activeFeaturePanel } from './render-entry-state.js';
import { isSessionViewTokenCurrent, isSessionViewMessagesCurrent, commitSessionViewPatch } from './session-view-commit-host.js';
import { loadFeatureTemplateMap, loadAgentDetail } from './agent-loader-host.js';
import { createSessionDataLoaderHost } from './agent-data-loader.js';
import { refreshCurrentRuntimeStatus } from './runtime-status-loader-host.js';

// 静态环内的顶层读取惰性转调（与 agent-snapshot-loader-host 同模式）：
// agent-loader-host → project-data → session-ui → agent-snapshot-loader-host →
// 本模块 → agent-loader-host / runtime-status-loader-host。环被另一侧先打开时，
// 上面三个 `export const {...} = loader` 尚未初始化，顶层直接放函数值会 TDZ
// （ReferenceError）。转调保留参数传递与 `host.<name>(...)` 的方法调用形态
// （三个生产函数都不读 `this`）。
const loader = createSessionDataLoader({
  ...createSessionDataLoaderHost(),
  setRuntime: setCurrentRuntimeAgentId,
  focused: () => focusedAgentId,
  activePanel: () => activeFeaturePanel,
  isCurrent: isSessionViewTokenCurrent,
  messagesCurrent: isSessionViewMessagesCurrent,
  patch: commitSessionViewPatch,
  loadTemplates: (...args) => loadFeatureTemplateMap(...args),
  loadDetail: (...args) => loadAgentDetail(...args),
  refreshStatus: (...args) => refreshCurrentRuntimeStatus(...args),
});
export const { loadAgentData } = loader;
window.KernelState.defineKey('session-data-loader', 'loadAgentData', loadAgentData);
window.KernelState.claim('session-data-loader', {
  get: (key) => loader[key],
  set: (key, value) => { loader[key] = value; },
});
