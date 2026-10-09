/**
 * context-guard-toggle.js — 超阈值自动打断开关（上边栏 badge 形态）
 *
 * ContextGuardFeature 的会话级控制（armed 布防 → 上下文超阈值时打断本轮并
 * 提醒精简 → 触发一次后自动解除，可重新布防；仅当前会话生效）。控制入口
 * 从 session-controls-panel 的「上下文保护」区迁来：badge 内嵌在
 * chat-context-bar 的 token 进度条组内——开关管的阈值与进度条是同一个
 * （contextLength × compressRatio%），读数与守卫放在一起；详情行并入
 * ccb-popup（hover 弹窗，只读）。
 *
 * 数据流：状态真值在 runtime 内 Feature。读：poll 主循环
 * （agent-data-loader refreshCurrentRuntimeStatus / SSE 激活轻量形态）拉
 * /protoclaw/context_guard_status，经 runtime-status.applyContextGuardStatus
 * 转发到本模块 applyStatus 缓存（per runtimeId）；写：toggleGuard POST
 * /protoclaw/context_guard_control，应答携带最新 status 直接回填。
 * trip 发生时的打断提醒 toast 由 runtime-status 既有逻辑负责；本模块的
 * toast 只覆盖开关操作反馈。
 *
 * 渲染协议：updateChatContextBar 每轮重建 bar innerHTML 时调用
 * renderBadge() 取 badge HTML（未挂载 / 状态未到位返回空串）；armed 或
 * 阈值变化时本模块主动调 updateChatContextBar() 重渲染。
 *
 * 身份与写门控纪律对齐 session-controls-panel.js（panelAgentId /
 * currentSessionId / panelWriteEnabled 的远程分支，ADR-0011/0012）：本地
 * 会话 = 焦点宿主逻辑 id；远程会话 = 宿主级命名空间 id + 连接能力矩阵
 * write 位，缺位降级只读（badge 禁用，无远程标识）。
 */
(function () {
  'use strict';

  // runtimeId → { armed, trip, thresholdTokens, pending, initialized }
  const _statusByRuntime = new Map();

  function formatTokens(n) {
    if (!n || !Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  // ── 挂载探测：inspector 快照名单（与 session-controls-panel 同源信号）──
  function isAvailable() {
    const raw = typeof currentHookInspector === 'object' ? currentHookInspector : null;
    const list = raw && Array.isArray(raw.features) ? raw.features : [];
    return list.some((feature) => String(feature && feature.name || '').trim() === 'context-guard');
  }

  function getStatus(runtimeId = currentRuntimeAgentId) {
    return _statusByRuntime.get(String(runtimeId || '').trim()) || {
      armed: false,
      trip: null,
      thresholdTokens: null,
      pending: false,
      initialized: false,
    };
  }

  function normalizeTrip(trip) {
    if (!trip || typeof trip !== 'object') return null;
    const at = Number(trip.at);
    const inputTokens = Number(trip.inputTokens);
    const thresholdTokens = Number(trip.thresholdTokens);
    return {
      at: Number.isFinite(at) && at > 0 ? Math.round(at) : null,
      inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? Math.round(inputTokens) : null,
      thresholdTokens: Number.isFinite(thresholdTokens) && thresholdTokens > 0 ? Math.round(thresholdTokens) : null,
      reason: typeof trip.reason === 'string' ? trip.reason : '',
    };
  }

  // /protoclaw/context_guard_status 与 context_guard_control 共用应答形态：
  // { ok, status: { armed, trip, thresholdTokens } }
  function applyStatusPayload(payload) {
    const status = payload && typeof payload === 'object' && payload.status && typeof payload.status === 'object'
      ? payload.status : null;
    if (!status) return null;
    const thresholdTokens = Number(status.thresholdTokens);
    return {
      armed: status.armed === true,
      trip: normalizeTrip(status.trip),
      thresholdTokens: Number.isFinite(thresholdTokens) && thresholdTokens > 0 ? Math.round(thresholdTokens) : null,
    };
  }

  function applyStatus(payload, runtimeId = currentRuntimeAgentId) {
    const id = String(runtimeId || '').trim();
    if (!id) return;
    const next = applyStatusPayload(payload);
    if (!next) return;
    const prev = getStatus(id);
    // 写操作 pending 期间 poll 回填不覆盖 armed（trip 会真实消耗 armed，
    // 但那一刻的权威值由 pending 应答携带，避免乐观态闪回）
    const state = prev.pending ? { ...next, armed: prev.armed } : next;
    _statusByRuntime.set(id, { ...state, pending: prev.pending, initialized: true });
    // armed / 阈值变化（含首次到位）才重渲染；bar innerHTML 重建有成本
    if (prev.initialized && prev.armed === state.armed && prev.thresholdTokens === state.thresholdTokens) return;
    if (typeof updateChatContextBar === 'function') updateChatContextBar();
  }

  // ── 身份与写门控（对齐 session-controls-panel 同名逻辑，详见其注释）──

  function guardSessionId() {
    const local = typeof getRuntimeWorkspaceSessionId === 'function' && currentRuntimeAgentId
      ? getRuntimeWorkspaceSessionId(currentRuntimeAgentId)
        || (typeof getActiveWorkspaceSessionId === 'function' ? getActiveWorkspaceSessionId() : '')
      : '';
    if (local) return local;
    // 远程会话：会话身份从远程目录解析；未含条目（连接断开）返回空串
    const runtimeRef = currentRuntimeAgentId || '';
    if (typeof isRemoteNamespaceAgentId !== 'function'
      || (!isRemoteNamespaceAgentId(runtimeRef)
        && !(typeof focusedAgentId === 'string' && isRemoteNamespaceAgentId(focusedAgentId)))) {
      return '';
    }
    const rc = typeof window !== 'undefined' ? window.RemoteConnections : null;
    return (typeof rc?.getEntryRuntimeSessionId === 'function' && runtimeRef)
      ? rc.getEntryRuntimeSessionId(runtimeRef)
      : '';
  }

  function guardAgentId() {
    const focused = typeof focusedAgentId === 'string' ? focusedAgentId : '';
    const runtimeRef = currentRuntimeAgentId || '';
    const isRemote = typeof isRemoteNamespaceAgentId === 'function'
      && (isRemoteNamespaceAgentId(focused) || isRemoteNamespaceAgentId(runtimeRef));
    if (!isRemote) return focused;
    if (focused && isRemoteNamespaceAgentId(focused)) return focused;
    const rc = typeof window !== 'undefined' ? window.RemoteConnections : null;
    return (typeof rc?.getEntryHostNamespaceId === 'function' && runtimeRef)
      ? (rc.getEntryHostNamespaceId(runtimeRef) || '')
      : '';
  }

  function writeEnabled() {
    if (typeof isRemoteNamespaceAgentId !== 'function') return true;
    const focused = typeof focusedAgentId === 'string' ? focusedAgentId : '';
    if (!isRemoteNamespaceAgentId(focused) && !isRemoteNamespaceAgentId(currentRuntimeAgentId || '')) {
      return true;
    }
    const rc = typeof window !== 'undefined' ? window.RemoteConnections : null;
    return rc?.capabilityFor?.(guardAgentId(), 'write') === true;
  }

  // ── badge 渲染 ────────────────────────────────────────────────────

  // Lucide shield-alert（lucide-static v1.53.0, ISC License）。
  // off / armed 图标一致，状态只靠样式区分（灰淡裸图标 vs 淡琥珀胶囊+文字）
  const SHIELD_SVG = '<svg class="ccb-guard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'
    + '<path d="M12 8v4"/><path d="M12 16h.01"/></svg>';

  function renderBadge() {
    if (!currentRuntimeAgentId || !guardSessionId()) return '';
    if (!isAvailable()) return '';
    const state = getStatus();
    if (!state.initialized) return '';
    const zh = currentLanguage !== 'en';
    const armed = state.armed === true;
    const pending = state.pending === true;
    const readonly = !writeEnabled();

    const cls = ['ccb-guard'];
    if (armed) cls.push('is-armed');
    if (pending) cls.push('is-pending');
    if (readonly) cls.push('is-readonly');

    // 外层 zone 是 hover/click 缓冲带（data-guard-zone）：点歪在按钮周围
    // 时不弹详情、不误触模型操作；负 margin 抵消 padding，视觉零占位。
    // off / armed 同构胶囊（图标 + 文字恒渲染，仅颜色区分）——宽度恒定，
    // 切换时 bar 布局零跳动
    return '<span class="ccb-guard-zone" data-guard-zone="1">'
      + '<button type="button" class="' + cls.join(' ') + '" data-guard-toggle="1"'
      + (pending || readonly ? ' disabled' : '')
      + ' aria-pressed="' + (armed ? 'true' : 'false') + '">'
      + SHIELD_SVG
      + '<span class="ccb-guard-text">'
      + (armed ? (zh ? '自动打断' : 'Enabled') : (zh ? '开启打断' : 'Enable'))
      + '</span>'
      + '</button></span>';
  }

  // ── 写操作 ────────────────────────────────────────────────────────

  async function toggleGuard() {
    const sessionId = guardSessionId();
    const agentId = guardAgentId();
    const id = String(currentRuntimeAgentId || '').trim();
    if (!id || !agentId || !sessionId) return;
    if (!writeEnabled()) return;
    const prev = getStatus(id);
    if (prev.pending) return;

    _statusByRuntime.set(id, { ...prev, pending: true });
    if (typeof updateChatContextBar === 'function') updateChatContextBar();

    try {
      const response = await fetch('/protoclaw/context_guard_control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
        body: JSON.stringify({ agentId, sessionId, armed: !(prev.armed === true) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + response.status));
      const next = applyStatusPayload(payload);
      if (!next) throw new Error('invalid status payload');
      _statusByRuntime.set(id, { ...next, pending: false, initialized: true });
      _toastToggle(next.armed, next.thresholdTokens);
      if (typeof window._scheduleInspectorRefresh === 'function') window._scheduleInspectorRefresh(120);
    } catch (error) {
      _statusByRuntime.set(id, { ...prev, pending: false });
      _toastToggleError(error);
    }
    if (typeof updateChatContextBar === 'function') updateChatContextBar();
  }

  function _toastToggle(armed, thresholdTokens) {
    const zh = currentLanguage !== 'en';
    const thresholdText = formatTokens(thresholdTokens);
    if (armed) {
      window.ClawToast?.show?.({
        id: 'context-guard-toggle',
        status: 'success',
        title: zh ? '已开启超阈值自动打断' : 'Auto-interrupt armed',
        description: zh
          ? `超过阈值（约 ${thresholdText} tokens）时自动打断并提醒精简；触发一次后自动关闭。仅当前会话生效。`
          : `When usage exceeds the threshold (≈ ${thresholdText} tokens), the turn is interrupted with a trimming hint; it disarms after one trip. Applies to this session only.`,
        autoDismiss: 5000,
      });
    } else {
      window.ClawToast?.show?.({
        id: 'context-guard-toggle',
        status: 'success',
        title: zh ? '已关闭超阈值自动打断' : 'Auto-interrupt disarmed',
        autoDismiss: 3000,
      });
    }
  }

  function _toastToggleError(error) {
    const zh = currentLanguage !== 'en';
    window.ClawToast?.show?.({
      id: 'context-guard-toggle',
      status: 'error',
      title: zh ? '切换超阈值自动打断失败' : 'Failed to toggle auto-interrupt',
      description: String(error?.message || error),
      closable: true,
      autoDismiss: 8000,
    });
  }

  // ccb-popup 详情数据（chat-context-bar 的 _buildCcbPopupHtml 消费）
  function getDetail() {
    if (!currentRuntimeAgentId || !isAvailable()) return null;
    const state = getStatus();
    if (!state.initialized) return null;
    return { armed: state.armed === true, thresholdTokens: state.thresholdTokens, trip: state.trip };
  }

  window.ContextGuardToggle = { isAvailable, applyStatus, renderBadge, toggleGuard, getDetail };
}());
