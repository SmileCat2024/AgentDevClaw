import { createWorkspaceSurface } from './workspace-surface.js';
import { beginChatLoadingSession } from './chat-loading-host.js';
import { allAgents, focusedAgentId, readOnlyMode } from './agent-store-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { saveCurrentRuntimeToCache } from './runtime-view-cache-host.js';
import { loadAgentDetail } from './agent-loader-host.js';

const navigation = createWorkspaceSurface({
  ...window.createWorkspaceSurfaceHost(),
  findAgent: id => allAgents.find(agent => agent.id === id) || null,
  focusedAgentId: () => focusedAgentId,
  runtimeId: () => currentRuntimeAgentId,
  readOnlyMode: () => readOnlyMode,
  saveCache: saveCurrentRuntimeToCache,
  // 静态环内的顶层读取惰性转调（与 session-data-loader-host 同模式）：
  // agent-loader-host → project-data → session-ui → agent-snapshot-loader-host →
  // session-data-loader-host → 本模块 的环里，本模块可能先于 agent-loader-host
  // 求值，其 `export const {...} = loader` 此时尚未初始化（TDZ）。转调保留参数
  // 传递与 `host.<name>(...)` 方法调用形态（生产函数不读 `this`）。
  loadDetail: (...args) => loadAgentDetail(...args),
  beginLoading: beginChatLoadingSession,
});
export const { selectWorkspaceSurface } = navigation;
window.KernelState.defineKey('workspace-surface', 'selectWorkspaceSurface', selectWorkspaceSurface);
window.KernelState.claim('workspace-surface', {
  get: key => navigation[key],
  set: (key, value) => { navigation[key] = value; },
});
