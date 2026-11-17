/**
 * Classic adapters for session-data-loader and runtime-status-loader ESM hosts.
 * First-paint state and rendering retain their original synchronous timing;
 * adapters resolve those dependencies only when the async loaders call them.
 *
 * ESM（P2 W2-4 二段）：本文件只剩两个 host 工厂，且它们是**装配 seam** 而非域实现。
 * 两个消费方 host 现在直接 import 这里的工厂（顶层 spread 取面），因此：
 *   - 不再为工厂造 window 桥键，也不再需要额外的 loader 装载入口；ESM 图本身保证
 *     求值顺序（消费方 import 本文件）；
 *   - 无反向环：本文件不 import 任何 loader host；`refreshStatus` 由 session host 用
 *     自己 import 的 `refreshCurrentRuntimeStatus` 覆盖，故本工厂不再保留该成员；
 *   - 依赖解析规则：已迁 ESM 的一律直接 import；仍 classic 的函数显式 `window.X`
 *     并注明归属；状态写入口走已迁 owner 的 setter（模板映射用
 *     agent-loader-host 的 setFeatureTemplateMap）。本批把回退/模型/思考档位
 *     三个 ESM 更新器与 ContextGuardToggle 从 window 改为 import（原 typeof
 *     守卫是测试桩遗留，生产侧由 import 图保证存在）。
 *   - 首屏/错误/请求/清理时点不变：工厂体只建闭包，真正的取值都发生在 loadAgentData
 *     / refreshCurrentRuntimeStatus 调用时。
 */

import { currentRuntimeAgentId, setCurrentRuntimeAgentId } from './orchestration-state.js';
import { focusedAgentId } from './agent-store-state.js';
import { activeFeaturePanel } from './render-entry-state.js';
import {
  isSessionViewMessagesCurrent,
  isSessionViewTokenCurrent,
  commitSessionViewPatch,
  commitSessionViewState,
} from './session-view-commit-host.js';
import { loadAgentDetail, loadFeatureTemplateMap, setFeatureTemplateMap } from './agent-loader-host.js';
import {
  clearFeatureTemplateCache,
  collectTemplateNames,
  warmTemplatesInBackground,
} from './template-engine.js';
import { attachMessagesTimestamps } from './message-timeline.js';
import { recheckAutoTitleCandidate } from './auto-title.js';
import { clearChatLoadingSession } from './chat-loading-host.js';
import { clearRecapForNewMessage } from './p2-w2-3a-recap-state.js';
import { updateRollbackActionVisibility } from './input-actions.js';
import { updateInputModelSwitcher, updateThinkingEffortSwitcher } from './input-model-switcher.js';
import { ContextGuardToggle } from './context-guard-toggle.js';

// First-paint helpers retain classic timing. Async load orchestration is ESM.
export function createSessionDataLoaderHost() {
  return {
    // 桥接期：定义于 app-core（身份域收敛时移除）
    isUiOnly: (id) => window.isUiOnlyAgentId(id),
    setRuntime: (id) => { setCurrentRuntimeAgentId(id); },
    // 桥接期：定义于 session-view-state（会话视图域收敛时移除）
    apply: (patch) => window.applySessionViewPatch(patch),
    capture: (id) => window.captureSessionViewToken(id),
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    messagesCurrent: (token) => isSessionViewMessagesCurrent(token),
    patch: (...args) => commitSessionViewPatch(...args),
    focused: () => focusedAgentId,
    activePanel: () => activeFeaturePanel,
    fetch: (...args) => window.fetch(...args),
    // 桥接期：定义于 runtime-status（运行时状态域收敛时移除）
    notify: (...args) => window.updateNotificationStatus(...args),
    // 桥接期：定义于 app-ui（渲染入口域收敛时移除）
    resetSurface: () => window.resetRuntimeBackedSurfaceState(),
    render: (...args) => window.renderCurrentMainView(...args),
    // 桥接期：定义于 debug-panel-host（面板域收敛时移除）
    renderPanel: () => window.renderFeaturePanel(),
    clearTemplates: () => {
      setFeatureTemplateMap({});
      clearFeatureTemplateCache();
    },
    loadTemplates: () => loadFeatureTemplateMap(),
    refreshBadges: () => {
      if (window.GenUIPanel) window.GenUIPanel.forceRefresh();
      if (window.BgPanel) window.BgPanel.refreshBadge();
    },
    // 桥接期：定义于 runtime-status（运行时状态域收敛时移除）
    resetRuntimeStatus: () => window.resetRuntimeStatusForSwitch(),
    // 桥接期：定义于 app-core（会话视图域收敛时移除）
    activateCollapse: (id) => window.activateUserCollapseStateForContext(window.getRuntimeContextKey(id)),
    // 只清「当前摘要文本 / 挂起意图」两键；recap-hint 的 _clearRecapForNewMessage
    // 另带 DOM 提示清理与会话记账，语义不同，不能替代这里。
    clearRecap: () => { clearRecapForNewMessage(); },
    // 桥接期：定义于 todo-plan（计划面板与首屏 rail 同步交互绑定，随联合迁移收敛）
    emptyTodo: () => window.getEmptyTodoPlan(),
    attachTimestamps: (...args) => attachMessagesTimestamps(...args),
    recheckTitle: () => recheckAutoTitleCandidate(),
    clearLoading: () => clearChatLoadingSession(),
    updateRollback: () => updateRollbackActionVisibility(),
    templateNames: (tools) => collectTemplateNames(tools),
    warmTemplates: (...args) => warmTemplatesInBackground(...args),
    // 桥接期：定义于 chat-context-bar（输入面域收敛时移除）
    updateContext: (view) => { if (typeof window.updateChatContextBar === 'function') window.updateChatContextBar(view); },
    updateModel: () => { updateInputModelSwitcher(); },
    updateThinking: () => { updateThinkingEffortSwitcher(); },
    // 桥接期：定义于 todo-plan（计划面板与首屏 rail 同步交互绑定，随联合迁移收敛）
    updatePlan: () => { if (typeof window.updatePlanBadge === 'function') window.updatePlanBadge(); },
    loadDetail: (id) => loadAgentDetail(id),
    // 桥接期：定义于 debug-logs（面板域收敛时移除）
    loadLogs: (force) => window.loadLogs(force),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  };
}

// Async status requests use the ESM commit policy. Classic identity/render
// helpers are resolved when a refresh runs, not while modules initialize.
export function createRuntimeStatusLoaderHost() {
  return {
    runtimeId: () => currentRuntimeAgentId,
    // 桥接期：定义于 session-view-state（会话视图域收敛时移除）
    capture: (id) => window.captureSessionViewToken(id),
    isCurrent: (token) => isSessionViewTokenCurrent(token),
    commit: (token, apply) => commitSessionViewState(token, apply),
    patch: (...args) => commitSessionViewPatch(...args),
    fetch: (...args) => window.fetch(...args),
    guardAvailable: () => ContextGuardToggle.isAvailable() === true,
    // 桥接期：getCurrentRuntimeRecord / getCurrentAgentRecord 定义于 app-main
    // （编排域收敛时移除）
    ownerRecord: () => window.getCurrentRuntimeRecord() || window.getCurrentAgentRecord(),
    // 桥接期：定义于 app-core（身份域收敛时移除）
    logicalId: (record) => window.getLogicalAgentId(record),
    sessionId: (record) => window.getActiveSessionId(record),
    runtimeRecord: (id) => window.getRuntimeRecord(id),
    // 桥接期：定义于 runtime-status（运行时状态域收敛时移除）
    applyGuard: (data, id) => { if (typeof window.applyContextGuardStatus === 'function') window.applyContextGuardStatus(data, id); },
    notify: (...args) => window.updateNotificationStatus(...args),
    warn: (...args) => console.warn(...args),
  };
}
