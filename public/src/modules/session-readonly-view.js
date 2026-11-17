/**
 * session-readonly-view.js — 会话只读浏览（唯一实现）
 *
 * 只读浏览 = 用会话自身的持久化记录渲染聊天表面，不启动、不绑定任何 runtime。
 * ADR-0026：Session 是会话内容的所有者，runtime 不可用时从同一 Session 的
 * 持久记录读取。归档会话因此必须可读——「归档后不能启动 runtime」与
 * 「归档后不能查看内容」是两件事，不得互相代偿。
 *
 * 消费者（全部经本入口，不各自拼装只读面）：
 *   - 已归档对话（会话级 archived / 线程级 archived）
 *   - 线程历史存档「查看原文」
 *   - 工作群「查看会话记录」
 *
 * 视图身份：本模块把视图冻结在目标 Session 上（identity 指向它、
 * currentRuntimeAgentId 置空、activeConversation.readOnly=true 且
 * wasHead=false）。这三条共同保证轮询、SSE、接续重绑与事实对账都不会把
 * 只读视图拉回任何 head——重绑 / 对账以 wasHead 与 runtime 态为锚。
 *
 * 消息形状与存活 runtime 的 /messages 同源同形（服务端 session_record 按同
 * 一字段集投影），因此渲染走同一条渲染管线，工具卡片、图片、思考块、时间
 * 分隔线全部照常，不存在第二套只读渲染。
 *
 * ESM 化（P2 W1-4 会话弹窗与精简浏览批次）：本模块直接 import 状态 owner
 * （agent-store / orchestration / render-entry / session-view-storage 的命名
 * 导出与 setter）与已迁宿主能力（session-view-commit / runtime-view-cache /
 * chat-loading / message-timeline / toast-notify）；仍为 classic 的同步视图
 * 事务与渲染函数（captureSessionViewToken / applySessionViewPatch /
 * renderCurrentMainView 等）经 window 显式晚绑定
 * （行内标注定义域）。四个入口函数仍有 classic 消费方（workspace-actions、
 * input-render、app-ui/app-main 与 coder 插件宿主通道），经 kernel-state
 * 兼容桥暴露。
 */

import { focusedAgentId, readOnlyMode, setFocusedAgentId, setReadOnlyMode } from './agent-store-state.js';
import { currentRuntimeAgentId, _navigationGuardEpoch, setCurrentRuntimeAgentId } from './orchestration-state.js';
import { currentWorkspaceTab, setCurrentWorkspaceTab } from './render-entry-state.js';
import { toolRenderConfigs, TOOL_NAMES } from './session-view-storage.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { attachMessagesTimestamps } from './message-timeline.js';
import { ClawToast } from './toast-notify.js';
import { commitSessionViewPatch } from './session-view-commit-host.js';
import { saveCurrentRuntimeToCache } from './runtime-view-cache-host.js';
import { beginChatLoadingSession, clearChatLoadingSession } from './chat-loading-host.js';

let _state = null;

function _isZh() {
  return getCurrentLanguage() === 'zh';
}

function _navigationEpoch() {
  return typeof _navigationGuardEpoch === 'undefined' ? 0 : _navigationGuardEpoch;
}

function _resolveThreadId(agentId, sessionId, explicitThreadId) {
  const explicit = String(explicitThreadId || '').trim();
  if (explicit) return explicit;
  const thread = typeof window.getThreadForSession === 'function'
    ? window.getThreadForSession(agentId, sessionId)
    : null;
  return String(thread?.threadId || '').trim();
}

function _applyReadOnlyConversationTarget(nextState) {
  const threads = window.ClawThreads;
  if (!threads) return;
  // wasHead=false：视图不进入「等待重绑」豁免，接续重绑与事实对账一律不
  // 会改写它。readOnly 标记供输入守卫与重绑守卫识别。
  threads.browseOnly = false;
  threads.browseOnlyThreadId = '';
  threads.activeConversation = {
    agentId: nextState.agentId,
    threadId: nextState.threadId || '',
    sessionId: nextState.sessionId,
    runtimeId: '',
    wasHead: false,
    readOnly: true,
  };
}

function _indicatorAnchor() {
  const bar = document.getElementById('chat-context-bar');
  return bar && bar.parentElement ? bar.parentElement : null;
}

let _indicatorEl = null;

function _clearIndicator() {
  const el = _indicatorEl;
  _indicatorEl = null;
  if (!el) return;
  if (typeof el.remove === 'function') {
    el.remove();
    return;
  }
  if (el.parentNode) el.parentNode.removeChild(el);
}

/** 只读指示器只在聊天表面有意义：工作空间首页/其它 tab 下不显示。 */
function _chatSurfaceActive() {
  // 桥接期：定义于 app-ui（渲染入口域收敛时改 import）
  if (typeof window.isChatSurfaceActive === 'function') return window.isChatSurfaceActive() !== false;
  return true;
}

/**
 * 顶栏只读指示器（与线程历史「只读 · 前往当前会话」同一配方与同位）。
 * 每次主视图渲染刷新，视图切走自然消失。
 */
export function updateReadOnlySessionIndicator() {
  const anchor = _indicatorAnchor();
  if (!anchor || !_state || readOnlyMode !== true || !_chatSurfaceActive()) {
    _clearIndicator();
    return;
  }
  const isZh = _isZh();
  let el = _indicatorEl;
  if (!el) {
    el = document.createElement('span');
    el.id = 'session-readonly-indicator';
    _indicatorEl = el;
    anchor.insertBefore(el, anchor.firstChild);
  }
  el.className = 'thread-header-indicator historical readonly';
  el.title = _state.archived
    ? (isZh
      ? '已归档对话：只读查看，不启动运行。恢复归档后可继续对话。'
      : 'Archived conversation: read-only, no runtime is started. Unarchive to continue.')
    : (isZh
      ? '历史存档：只读查看，不启动运行。'
      : 'Historical archive: read-only, no runtime is started.');
  el.textContent = _state.archived
    ? (isZh ? '只读 · 已归档' : 'Read-only · archived')
    : (isZh ? '只读 · 历史记录' : 'Read-only · archive');
}

/** 当前只读浏览目标；非只读浏览返回 null。 */
export function getReadOnlySessionTarget() {
  return _state ? { ..._state } : null;
}

/**
 * 离开只读浏览（切到别的会话 / 回工作空间首页 / 恢复归档后调用）。
 * 幂等：非只读态下只清指示器。
 */
export function closeReadOnlySession() {
  const wasReadOnly = !!_state;
  _state = null;
  _clearIndicator();
  const threads = window.ClawThreads;
  if (threads?.activeConversation?.readOnly === true) {
    threads.activeConversation = null;
  }
  if (wasReadOnly && readOnlyMode === true) setReadOnlyMode(false);
}

/**
 * 打开只读浏览。
 *
 * @param {object} options
 * @param {string} options.agentId     会话所属工作空间（宿主）id
 * @param {string} options.sessionId   目标会话 id
 * @param {string} [options.threadId]  所属线程（缺省按会话反查）
 * @param {string} [options.title]     展示用标题
 * @param {boolean} [options.archived] 列表已知的归档事实
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function openReadOnlySession(options) {
  const agentId = String(options?.agentId || '').trim();
  const sessionId = String(options?.sessionId || '').trim();
  if (!agentId || !sessionId) return { ok: false, reason: 'invalid_target' };

  // 桥接期：定义于 app-core（编排域收敛时改 import）
  window.bumpNavigationGuard();
  const navigationEpoch = _navigationEpoch();

  // 离开存活 runtime：先存视图缓存，只读视图不持有任何 runtime 态。
  if (currentRuntimeAgentId && readOnlyMode !== true) {
    saveCurrentRuntimeToCache(currentRuntimeAgentId, window.getRuntimeContextKey(currentRuntimeAgentId));
  }
  if (typeof window.saveCurrentWorkspaceSurfaceScroll === 'function') window.saveCurrentWorkspaceSurfaceScroll();
  if (typeof window._storeVisibleSessionInputDraft === 'function') window._storeVisibleSessionInputDraft();

  // 工具渲染配置随存活 runtime 加载：只读视图没有 runtime 可取，沿用最近
  // 一次已加载的配置（模板映射按 agent 缓存，未切 runtime 即未失效）。
  // 完全没有历史配置时退回 json 模板，属可接受降级。
  const inheritedToolRenderConfigs = toolRenderConfigs && typeof toolRenderConfigs === 'object'
    ? { ...toolRenderConfigs }
    : {};
  const inheritedToolNames = typeof TOOL_NAMES === 'object' && TOOL_NAMES ? { ...TOOL_NAMES } : {};

  _state = {
    agentId,
    sessionId,
    threadId: _resolveThreadId(agentId, sessionId, options?.threadId),
    title: String(options?.title || '').trim(),
    archived: options?.archived === true,
  };

  // 视图身份先落定（清空上一会话内容），再提交只读记录。
  setFocusedAgentId(agentId);
  setCurrentRuntimeAgentId(null);
  setReadOnlyMode(true);
  if (typeof currentWorkspaceTab !== 'undefined') setCurrentWorkspaceTab('chat');
  // 桥接期：定义于 session-view-state（会话视图域收敛时改 import）
  window.applySessionViewPatch({ identity: { agentId, sessionId } });
  _applyReadOnlyConversationTarget(_state);
  if (typeof window._syncActiveThreadSubscription === 'function') window._syncActiveThreadSubscription();
  if (typeof window.resetRuntimeStatusForSwitch === 'function') window.resetRuntimeStatusForSwitch();
  beginChatLoadingSession();
  if (typeof window.renderAgentList === 'function') window.renderAgentList();
  if (typeof window.updateThreadHeaderIndicator === 'function') window.updateThreadHeaderIndicator();
  if (typeof window.renderCurrentMainView === 'function') window.renderCurrentMainView();

  const viewToken = typeof window.captureSessionViewToken === 'function'
    ? window.captureSessionViewToken('', { agentId, sessionId })
    : null;
  try {
    const response = await fetch(
      '/protoclaw/session_record?agentId=' + encodeURIComponent(agentId)
      + '&sessionId=' + encodeURIComponent(sessionId),
    );
    if (!response.ok) {
      throw new Error(await response.text().catch(() => `session_record ${response.status}`));
    }
    const data = await response.json();
    if (navigationEpoch !== _navigationEpoch()) return { ok: false, reason: 'superseded' };
    // 请求期间用户可能已点开别的会话：只读目标不再一致即放弃提交。
    if (!_state || _state.agentId !== agentId || _state.sessionId !== sessionId) {
      return { ok: false, reason: 'superseded' };
    }
    if (data?.archived === true) _state.archived = true;

    const rawMessages = Array.isArray(data?.messages) ? data.messages : [];
    const timestamps = Array.isArray(data?.timestamps) ? data.timestamps : [];
    const messages = attachMessagesTimestamps(rawMessages, timestamps);
    const patch = {
      messages,
      inputRequests: [],
      toolRenderConfigs: inheritedToolRenderConfigs,
      toolNames: inheritedToolNames,
    };
    const commit = () => {
      clearChatLoadingSession();
      if (typeof window.renderCurrentMainView === 'function') window.renderCurrentMainView();
      // 同模块函数直调（原 window.updateReadOnlySessionIndicator 绕回本模块的桥键）
      updateReadOnlySessionIndicator();
    };
    if (viewToken) {
      commitSessionViewPatch(viewToken, patch, commit);
    } else {
      window.applySessionViewPatch(patch);
      commit();
    }
    return { ok: true };
  } catch (error) {
    console.error('Failed to load session record:', error);
    if (navigationEpoch !== _navigationEpoch()) return { ok: false, reason: 'superseded' };
    clearChatLoadingSession();
    const title = (_isZh() ? '无法读取会话记录：' : 'Failed to load session record: ')
      + (error?.message || error);
    ClawToast.show({ id: 'session-readonly-failed-' + sessionId, status: 'error', title });
    return { ok: false, reason: 'load_failed' };
  }
}

// —— 桥接期兼容面（kernel-state 访问器桥）——
// classic 消费方：workspace-actions.js（归档会话 / 线程存档打开，含 coder 插件
// 经 window 的宿主通道）、app-ui.js（主视图渲染后刷新指示器）、input-render.js
// 与 app-main.js（输入守卫读取只读目标）、runtime-switch/workspace-surface 宿主
// 适配器（离开只读）。全面迁 ESM 后撤桥。
const readonlyApi = {
  openReadOnlySession,
  closeReadOnlySession,
  getReadOnlySessionTarget,
  updateReadOnlySessionIndicator,
};
window.KernelState.defineKey('session-readonly-view', 'openReadOnlySession', openReadOnlySession);
window.KernelState.defineKey('session-readonly-view', 'closeReadOnlySession', closeReadOnlySession);
window.KernelState.defineKey('session-readonly-view', 'getReadOnlySessionTarget', getReadOnlySessionTarget);
window.KernelState.defineKey('session-readonly-view', 'updateReadOnlySessionIndicator', updateReadOnlySessionIndicator);
window.KernelState.claim('session-readonly-view', {
  get: (key) => readonlyApi[key],
  set: (key, value) => { readonlyApi[key] = value; },
});
