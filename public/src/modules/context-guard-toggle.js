/**
 * context-guard-toggle.js — 超阈值守卫三态开关（上边栏 badge 形态）
 *
 * ContextGuardFeature 的会话级控制（mode 三态：off 关闭 / interrupt 自动
 * 打断 / rotate 自动接续）。interrupt 态 = 保险丝语义：触发过界打断不翻
 * 转 mode，badge 恒显示手动状态 → 越界触发时打断本轮并拦截机器唤醒
 * （reminder 类 call）→ 人工输入即视为批准继续，解除拦截，本次越界期间
 * 维持放行 → 用量回落阈值下方后再次越界会重新触发。rotate 态 = coder 同
 * 构的自动接续：过界打断本轮后经服务端 thread-rotation 执行线程接力，
 * 过程提示由线程既有「上下文接力中…」承载，badge 零新增提示。
 * 循环点击：关闭 → 自动打断 → 自动接续 → 关闭（allowRotation=false 时
 * 两态循环）；仅当前会话生效。控制入口从 session-controls-panel 的
 * 「上下文保护」区迁来：badge 内嵌在 chat-context-bar 的 token 进度条
 * 组内——开关管的阈值与进度条是同一个（contextLength × compressRatio%），
 * 读数与守卫放在一起；详情行并入 ccb-popup（hover 弹窗，只读）。
 *
 * 数据流：状态真值在 runtime 内 Feature。读：poll 主循环
 * （agent-data-loader refreshCurrentRuntimeStatus / SSE 激活轻量形态）拉
 * /protoclaw/context_guard_status，经 runtime-status.applyContextGuardStatus
 * 转发到本模块 applyStatus 缓存（per runtimeId）；写：toggleGuard POST
 * /protoclaw/context_guard_control（{mode}），应答携带最新 status 直接回填。
 * trip 的打断提醒 toast 由 runtime-status 既有逻辑负责（仅 interrupt 触发）；
 * 本模块的 toast 只覆盖开关操作反馈。
 *
 * 渲染协议：updateChatContextBar 每轮重建 bar innerHTML 时调用
 * renderBadge() 取 badge HTML（未挂载 / 状态未到位返回空串）；mode 或
 * 阈值变化时本模块主动调 updateChatContextBar() 重渲染。
 *
 * 身份与写门控纪律对齐 session-controls-panel.js（panelAgentId /
 * currentSessionId / panelWriteEnabled 的远程分支，ADR-0011/0012）：本地
 * 会话 = 焦点宿主逻辑 id；远程会话 = 宿主级命名空间 id + 连接能力矩阵
 * write 位，缺位降级只读（badge 禁用，无远程标识）。
 */
(function () {
  'use strict';

  // runtimeId → { mode, strategy, allowRotation, trip, thresholdTokens, pending, initialized }
  const _statusByRuntime = new Map();

  // mode 三态与循环次序（allowRotation=false 时 rotate 从循环中摘除）
  const MODE_CYCLE_FULL = ['off', 'interrupt', 'rotate'];
  const MODE_CYCLE_BASIC = ['off', 'interrupt'];

  function normalizeMode(value, armedLegacy) {
    if (value === 'off' || value === 'interrupt' || value === 'rotate') return value;
    // 远程旧版 runtime 只回报 armed：布尔映射到两态基线（rotate 能力未知按无）
    return armedLegacy === true ? 'interrupt' : 'off';
  }

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
      mode: 'off',
      strategy: 'adaptive',
      allowRotation: false,
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
      mode: normalizeMode(trip.mode, null),
    };
  }

  // /protoclaw/context_guard_status 与 context_guard_control 共用应答形态：
  // { ok, status: { mode, strategy, allowRotation, trip, thresholdTokens } }；
  // 远程旧版只有 { armed }（normalizeMode 映射）
  function applyStatusPayload(payload) {
    const status = payload && typeof payload === 'object' && payload.status && typeof payload.status === 'object'
      ? payload.status : null;
    if (!status) return null;
    const thresholdTokens = Number(status.thresholdTokens);
    return {
      mode: normalizeMode(status.mode, status.armed === true),
      strategy: status.strategy === 'trim' || status.strategy === 'summary' ? status.strategy : 'adaptive',
      allowRotation: status.allowRotation === true,
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
    // 写操作 pending 期间 poll 回填不覆盖 mode/strategy（那一刻的权威值由
    // pending 应答携带，避免乐观态闪回；trip 不受 pending 保护，如实回填）
    const state = prev.pending
      ? { ...next, mode: prev.mode, strategy: prev.strategy, allowRotation: prev.allowRotation }
      : next;
    _statusByRuntime.set(id, { ...state, pending: prev.pending, initialized: true });
    // mode / strategy / 阈值变化（含首次到位）才重渲染；bar innerHTML 重建有成本
    if (prev.initialized && prev.mode === state.mode && prev.strategy === state.strategy
      && prev.allowRotation === state.allowRotation && prev.thresholdTokens === state.thresholdTokens) return;
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

  // 图标：off / interrupt 用 Lucide shield-alert，rotate 用 Lucide rotate-cw
  // （循环标志，自动接续语义；lucide-static v1.53.0, ISC License）。状态
  // 另靠样式区分（灰淡裸图标 vs 淡琥珀/淡蓝胶囊+文字）
  const SHIELD_SVG = '<svg class="ccb-guard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>'
    + '<path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
  const ROTATE_SVG = '<svg class="ccb-guard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/>'
    + '<path d="M21 3v5h-5"/></svg>';

  function renderBadge() {
    if (!currentRuntimeAgentId || !guardSessionId()) return '';
    if (!isAvailable()) return '';
    const state = getStatus();
    if (!state.initialized) return '';
    const zh = currentLanguage !== 'en';
    const pending = state.pending === true;
    const readonly = !writeEnabled();

    // 循环点击的态次序由 allowRotation 决定：装配未开通自动接续时 rotate
    // 不进循环（coder/memo 的触发器无控制面，编程小助手侧 allowRotation
    // 由装配声明，agent-studio 等非线程宿主两态）
    const cycle = state.allowRotation ? MODE_CYCLE_FULL : MODE_CYCLE_BASIC;
    const idx = cycle.indexOf(state.mode);
    const mode = idx >= 0 ? state.mode : 'off';

    const cls = ['ccb-guard', 'is-' + mode];
    if (pending) cls.push('is-pending');
    if (readonly) cls.push('is-readonly');

    // 弹窗触发区是白名单（ccb-model / ccb-bar / ccb-label，data-ccb-trigger，
    // 见 chat-context-bar）：badge 不在触发区内，hover 与点击互不干扰。
    // 三态同构胶囊（图标 + 文字恒渲染）——中文文案全 4 字，宽度恒定，
    // 切换时 bar 布局零跳动；off 显示动作提示（开启打断），armed 两态显示
    // 当前态名，与既有 Enable/Enabled 先例同模式。
    const text = mode === 'interrupt'
      ? (zh ? '自动打断' : 'Auto-interrupt')
      : mode === 'rotate'
        ? (zh ? '自动接续' : 'Auto-rotate')
        : (zh ? '开启打断' : 'Enable');
    const ariaLabel = mode === 'interrupt'
      ? (zh ? '超阈值自动打断已开启，点击切换为自动接续' : 'Auto-interrupt on; click for auto-rotation')
      : mode === 'rotate'
        ? (zh ? '超阈值自动接续已开启，点击关闭守卫' : 'Auto-rotation on; click to disable the guard')
        : (zh ? '超阈值守卫已关闭，点击开启自动打断' : 'Guard off; click to enable auto-interrupt');

    return '<button type="button" class="' + cls.join(' ') + '" data-guard-toggle="1"'
      + (pending || readonly ? ' disabled' : '')
      + ' aria-label="' + ariaLabel + '">'
      + (mode === 'rotate' ? ROTATE_SVG : SHIELD_SVG)
      + '<span class="ccb-guard-text">' + text + '</span>'
      + '</button>';
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

    // 循环点击：关闭 → 自动打断 → 自动接续 → 关闭（无接续能力时两态）
    const cycle = prev.allowRotation ? MODE_CYCLE_FULL : MODE_CYCLE_BASIC;
    const idx = cycle.indexOf(prev.mode);
    const nextMode = cycle[((idx >= 0 ? idx : 0) + 1) % cycle.length];

    _statusByRuntime.set(id, { ...prev, pending: true });
    if (typeof updateChatContextBar === 'function') updateChatContextBar();

    try {
      const response = await fetch('/protoclaw/context_guard_control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
        body: JSON.stringify({ agentId, sessionId, mode: nextMode }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + response.status));
      const next = applyStatusPayload(payload);
      if (!next) throw new Error('invalid status payload');
      _statusByRuntime.set(id, { ...next, pending: false, initialized: true });
      _toastToggle(next.mode, next.thresholdTokens);
      if (typeof window._scheduleInspectorRefresh === 'function') window._scheduleInspectorRefresh(120);
    } catch (error) {
      _statusByRuntime.set(id, { ...prev, pending: false });
      _toastToggleError(error);
    }
    if (typeof updateChatContextBar === 'function') updateChatContextBar();
  }

  function _toastToggle(mode, thresholdTokens) {
    const zh = currentLanguage !== 'en';
    const thresholdText = formatTokens(thresholdTokens);
    if (mode === 'rotate') {
      window.ClawToast?.show?.({
        id: 'context-guard-toggle',
        status: 'success',
        title: zh ? '已开启超阈值自动接续' : 'Auto-rotation armed',
        description: zh
          ? `阈值 ≈ ${thresholdText} tokens，过界后将自动打断并按当前策略接力`
          : `Threshold ≈ ${thresholdText} tokens; crossing it interrupts and rotates with the current strategy`,
      });
    } else if (mode === 'interrupt') {
      window.ClawToast?.show?.({
        id: 'context-guard-toggle',
        status: 'success',
        title: zh ? '已开启超阈值自动打断' : 'Auto-interrupt armed',
        description: zh ? `阈值 ≈ ${thresholdText} tokens` : `Threshold ≈ ${thresholdText} tokens`,
      });
    } else {
      window.ClawToast?.show?.({
        id: 'context-guard-toggle',
        status: 'warning',
        title: zh ? '已关闭超阈值守卫' : 'Context guard disarmed',
        description: zh
          ? '上下文超阈值时将不再自动打断，token 开销可能大幅增加'
          : 'Usage above the threshold will no longer be interrupted; token costs may increase sharply',
      });
    }
  }

  function _toastToggleError(error) {
    const zh = currentLanguage !== 'en';
    window.ClawToast?.show?.({
      id: 'context-guard-toggle',
      status: 'error',
      title: zh ? '切换超阈值守卫失败' : 'Failed to toggle the context guard',
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
    return {
      mode: state.mode,
      strategy: state.strategy,
      allowRotation: state.allowRotation,
      thresholdTokens: state.thresholdTokens,
      trip: state.trip,
    };
  }

  window.ContextGuardToggle = { isAvailable, applyStatus, renderBadge, toggleGuard, getDetail };
}());
