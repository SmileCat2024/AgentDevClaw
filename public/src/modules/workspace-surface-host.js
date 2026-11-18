import { createWorkspaceSurface } from './workspace-surface.js';
import { beginChatLoadingSession } from './chat-loading-host.js';
import { allAgents, focusedAgentId, readOnlyMode } from './agent-store-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { saveCurrentRuntimeToCache } from './runtime-view-cache-host.js';
import { loadAgentDetail } from './agent-loader-host.js';

// 宿主面装配：app-ui 的 createWorkspaceSurfaceHost 在**首调**时经桥键解析。
//
// 为什么不是求值期具名 import：app-ui 的静态依赖覆盖 assembly-actions /
// workspace-blocks / session-list-render 等整片域，而这些域又 import 本模块
// （selectWorkspaceSurface）——具名 import 会形成 app-ui → … → 本模块 → app-ui
// 的环，并把 app-ui 整张图拖进任何触达这些域的模块图（测试用例逐 case 实例化，
// 实测每个 case +30ms 量级）。改为首调惰性解析：导航只发生在模块相之后
// （UI 事件 / boot 首轮），此时 domain `app-ui` 的桥键必然已注册；本模块不再
// 在求值期解引用 app-ui。与下面 loadDetail 的惰性转调同模式。
let navigation = null;

function getNavigation() {
  if (!navigation) {
    navigation = createWorkspaceSurface({
      ...window.createWorkspaceSurfaceHost(), // 桥接期：定义于 app-ui（求值期不解析）
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
  }
  return navigation;
}

/** 同步导航入口（签名不变）：宿主装配推迟到首调，调用点语义与迁移前一致。 */
export function selectWorkspaceSurface(...args) {
  return getNavigation().selectWorkspaceSurface(...args);
}
// 桥键（domain `workspace-surface`）：读值是上面的同步入口；写值（classic 覆盖）
// 落在本模块的持有槽里，不改已导出的入口——与迁移前「写 navigation 键、导出值
// 不变」一致。持有槽独立于懒装配的 navigation，认领时不解引用导航宿主。
let selectWorkspaceSurfaceImpl = selectWorkspaceSurface;
window.KernelState.defineKey('workspace-surface', 'selectWorkspaceSurface', selectWorkspaceSurface);
window.KernelState.claim('workspace-surface', {
  get: (key) => (key === 'selectWorkspaceSurface' ? selectWorkspaceSurfaceImpl : undefined),
  set: (key, value) => { if (key === 'selectWorkspaceSurface') selectWorkspaceSurfaceImpl = value; },
});
