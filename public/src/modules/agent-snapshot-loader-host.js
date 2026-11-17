import { createAgentSnapshotLoader } from './agent-snapshot-loader.js';
import * as store from './agent-store-state.js';
import { loadAgentDetail } from './agent-loader-host.js';
import { refreshAgentCallStates } from './agent-call-states-host.js';
import { activeFeaturePanel } from './render-entry-state.js';
import { loadAgentData } from './session-data-loader-host.js';

const host = window.createAgentSnapshotLoaderHost();
// 顶层读取一律惰性转调（不是直接放函数值）：agent-loader-host 已具名 import
// project-data，静态环成立为
// agent-loader-host → project-data → session-ui → 本模块 →
// （session-data-loader-host / agent-loader-host）。环被另一侧先打开时，上面两个
// `export const {...} = loader` 尚未初始化，顶层直接放函数值就是 TDZ
// （ReferenceError，已在真实 kernel-entry 整图求值中复现）。转调保留参数传递
// 与 `host.<name>(...)` 的方法调用形态（两个生产函数都不读 `this`），与
// agent-loader-host 对 template-engine 的惰性包装同模式。
const loader = createAgentSnapshotLoader({
  ...host,
  state: {
    get agents() { return store.allAgents; }, set agents(value) { store.setAllAgents(value); },
    get inFlight() { return store.loadAgentsInFlight; }, set inFlight(value) { store.setLoadAgentsInFlight(value); },
    get focused() { return store.focusedAgentId; }, set focused(value) { store.setFocusedAgentId(value); },
    get suppressRender() { return host.state.suppressRender; },
    get activePanel() { return activeFeaturePanel; },
  },
  loadDetail: (...args) => loadAgentDetail(...args),
  refreshCalls: refreshAgentCallStates,
  loadData: (...args) => loadAgentData(...args),
});
export const { loadAgents } = loader;
window.KernelState.defineKey('agent-snapshot-loader', 'loadAgents', loadAgents);
window.KernelState.claim('agent-snapshot-loader', {
  get: (key) => loader[key],
  set: (key, value) => { loader[key] = value; },
});
