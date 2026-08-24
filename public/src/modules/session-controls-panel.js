/**
 * session-controls-panel.js — 会话控制面板（session-local control plane）
 *
 * 两个 section，均以 runtime 内 Feature 为权威状态持有者，浏览器只是
 * 乐观 UI 缓存（请求-应答式 IPC，经 /protoclaw/*_status / *_control 路由）：
 *   - 自动接续：ForceContinuation Feature 的开关 / 触发条件 / 上限
 *   - 上下文保护：ContextGuardFeature 的超阈值打断开关
 *
 * 开关的实时性：它会被 runtime 内真实的超阈值事件消耗，面板打开期间
 * 每 3s 静默刷新一次，保证「用掉了立刻显示为关闭」。
 *
 * Visual language follows the Todo Plan panel: flat sections separated by
 * hairlines (no hero header, no card stack), a strong/label summary line,
 * and the shared .tool-toggle component for every switch row.
 */
(function () {
  'use strict';

  const stateByRuntime = new Map();

  function esc(value) {
    return typeof escapeHtml === 'function'
      ? escapeHtml(String(value ?? ''))
      : String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  /** Agents whose runtime mounts ForceContinuation + ContextGuard. */
  const SUPPORTED_AGENTS = ['programming-helper', 'agent-studio'];

  function isSupportedAgent() {
    return SUPPORTED_AGENTS.includes(String(focusedAgentId || ''));
  }

  function isGuardAvailable() {
    return isSupportedAgent();
  }

  function currentSessionId() {
    return typeof getRuntimeWorkspaceSessionId === 'function' && currentRuntimeAgentId
      ? getRuntimeWorkspaceSessionId(currentRuntimeAgentId)
        || (typeof getActiveWorkspaceSessionId === 'function' ? getActiveWorkspaceSessionId() : '')
      : '';
  }

  function runtimeKey() {
    return String(currentRuntimeAgentId || '') || `${focusedAgentId || ''}::${currentSessionId()}`;
  }

  function getState(key = runtimeKey()) {
    return stateByRuntime.get(key) || {
      enabled: false,
      pending: false,
      refreshing: false,
      error: '',
      initialized: false,
      guardArmed: false,
      guardTrip: null,
      guardThresholdTokens: null,
      guardRefreshing: false,
      guardPending: false,
      guardInitialized: false,
      guardError: '',
      updatedAt: 0,
    };
  }

  function setState(patch, key = runtimeKey()) {
    if (!key) return;
    stateByRuntime.set(key, { ...getState(key), ...patch, updatedAt: Date.now() });
  }

  function getTriggers(item) {
    const raw = item && typeof item.triggers === 'object' && item.triggers ? item.triggers : {};
    if ('outputTruncation' in raw) {
      // already the merged panel view
      return {
        outputTruncation: raw.outputTruncation !== false,
        frameworkLimitReached: raw.frameworkLimitReached !== false,
      };
    }
    // raw Feature status shape — the two provider keys are one concern for the
    // user, so the panel shows them as a single switch (on = both respond).
    return {
      outputTruncation: raw.providerMaxTokens !== false && raw.providerLength !== false,
      frameworkLimitReached: raw.frameworkLimitReached !== false,
    };
  }

  function normalizeGuardTrip(trip) {
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

  // ── 渲染 ─────────────────────────────────────────────────────────
  // 结构对齐 todo-plan.js 的 renderPlanPanel：摘要行（strong/label 统计）→
  // 主开关行（.plan-force-continue 同构）→ 候选列表（.plan-task-list 同构）→
  // 底部说明小字；不可用时返回与 hooks 面板一致的通用空态。

  function renderSwitch({ checked, disabled, title, attribute }) {
    return [
      '<label class="tool-toggle" title="', esc(title), '">',
      '<input type="checkbox" class="tool-toggle-input" ', attribute, checked ? ' checked' : '', disabled ? ' disabled' : '', '>',
      '<span class="tool-toggle-slider"></span>',
      '</label>',
    ].join('');
  }

  function renderTriggerRow({ key, title, help, enabled, disabled, zh }) {
    return [
      '<div class="force-continuation-candidate">',
      '<div class="force-continuation-candidate-main">',
      '<div class="force-continuation-candidate-label">', esc(title), '</div>',
      '<div class="force-continuation-candidate-desc">', esc(help), '</div>',
      '</div>',
      renderSwitch({
        checked: enabled,
        disabled,
        title: zh ? `切换${title}` : `Toggle ${title}`,
        attribute: `data-force-continuation-trigger="${key}"`,
      }),
      '</div>',
    ].join('');
  }

  function renderLimitRow({ value, disabled, zh }) {
    const max = Number.isFinite(value) && value > 0 ? Math.floor(value) : 5;
    return [
      '<div class="force-continuation-candidate force-continuation-limit-row">',
      '<div class="force-continuation-candidate-main">',
      '<div class="force-continuation-candidate-label">', zh ? '自动接续上限' : 'Auto-resume cap', '</div>',
      '<div class="force-continuation-candidate-desc">', zh
        ? '单次任务内最多自动接续的次数（1–10）。'
        : 'Max auto-resumes within one task (1–10).', '</div>',
      '</div>',
      '<input type="number" class="force-continuation-limit-input" data-force-continuation-limit',
      ' min="1" max="10" step="1" value="', String(max), '"', disabled ? ' disabled' : '', '>',
      '</div>',
    ].join('');
  }

  function formatTokens(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function renderGuardSection({ item, zh }) {
    const disabled = item.guardPending;
    const armed = item.guardArmed === true;
    const trip = item.guardTrip;
    const threshold = item.guardThresholdTokens;

    const rows = [];
    if (item.guardError) {
      rows.push('<div class="session-controls-guard-error">' + esc(item.guardError) + '</div>');
    }
    if (trip) {
      const fact = trip.inputTokens && trip.thresholdTokens
        ? `${formatTokens(trip.inputTokens)} / ${formatTokens(trip.thresholdTokens)} tokens`
        : '';
      rows.push([
        '<div class="session-controls-guard-fact">',
        esc(zh ? '最近一次触发' : 'Last trigger'),
        fact ? ` · ${esc(fact)}` : '',
        '</div>',
      ].join(''));
    } else if (threshold) {
      rows.push([
        '<div class="session-controls-guard-fact">',
        esc(zh ? `当前阈值约 ${formatTokens(threshold)} tokens` : `Threshold ≈ ${formatTokens(threshold)} tokens`),
        '</div>',
      ].join(''));
    }

    return [
      '<section class="force-continuation-candidates session-controls-guard">',
      '<div class="force-continuation-group-label">', zh ? '上下文保护' : 'CONTEXT PROTECTION', '</div>',
      '<div class="force-continuation-candidate">',
      '<div class="force-continuation-candidate-main">',
      '<div class="force-continuation-candidate-label">', zh ? '超阈值自动打断' : 'Auto-interrupt at threshold', '</div>',
      '<div class="force-continuation-candidate-desc">', zh
        ? '开启后，上下文超过阈值时自动打断当前会话并提醒精简；触发后自动关闭，可重新开启。仅当前会话生效。'
        : 'When armed, exceeding the threshold interrupts the session and suggests trimming; it disarms after one trip and can be re-armed. Applies to this session only.', '</div>',
      '</div>',
      renderSwitch({
        checked: armed,
        disabled,
        title: zh ? '切换超阈值自动打断' : 'Toggle auto-interrupt at threshold',
        attribute: 'data-guard-armed',
      }),
      '</div>',
      ...rows,
      '</section>',
    ].join('');
  }

  function renderEmpty(message, zh) {
    return '<div class="feature-panel-empty"><div class="feature-panel-section">'
      + '<div class="feature-panel-section-title">' + esc(zh ? '会话控制' : 'Session Controls') + '</div>'
      + '<div>' + esc(message) + '</div>'
      + '</div></div>';
  }

  function render() {
    const zh = currentLanguage !== 'en';
    const sessionId = currentSessionId();
    const item = getState();

    if (!isSupportedAgent() || !currentRuntimeAgentId || !sessionId) {
      const message = !isSupportedAgent()
        ? (zh ? '此控制在当前工作空间不可用。' : 'This control is not available in the current workspace.')
        : (zh ? '请先打开并连接一个会话。' : 'Open and connect a session first.');
      return renderEmpty(message, zh);
    }

    if (!item.initialized && !item.refreshing && !item.pending) {
      // Read the authoritative session Feature state rather than treating this
      // browser cache as a source of truth (important after reopen/reload).
      void refreshStatus({ renderWhenDone: true });
    }
    if (!item.guardInitialized && !item.guardRefreshing && !item.guardPending) {
      void refreshGuardStatus({ renderWhenDone: true });
    }
    ensureGuardPolling();

    const disabled = item.pending;
    const triggers = getTriggers(item);

    return [
      '<div class="force-continuation-panel session-controls-panel">',
      '<section class="force-continuation-master">',
      '<div class="force-continuation-master-main">',
      '<div class="force-continuation-master-label">', zh ? '保持任务继续' : 'Keep task moving', '</div>',
      '<div class="force-continuation-master-help">', zh
        ? '开启后，输出被截断时自动从中断处继续。仅当前会话生效。'
        : 'When on, truncated output continues automatically from where it stopped. Applies to this session only.', '</div>',
      '</div>',
      renderSwitch({
        checked: item.enabled === true,
        disabled,
        title: zh ? '切换保持任务继续' : 'Toggle keep task moving',
        attribute: 'data-force-continuation-toggle',
      }),
      '</section>',
      '<section class="force-continuation-candidates', item.enabled ? '' : ' is-master-off', '">',
      '<div class="force-continuation-group-label">', zh ? '自动接续的条件' : 'AUTO-RESUME CONDITIONS', '</div>',
      renderTriggerRow({
        key: 'outputTruncation',
        title: zh ? '输出长度达到上限' : 'Output hit the length cap',
        help: zh ? '模型输出达到长度上限被截断时，自动从中断处继续。' : 'When output is truncated at the length cap, continue automatically from where it stopped.',
        enabled: triggers.outputTruncation,
        disabled,
        zh,
      }),
      renderTriggerRow({
        key: 'frameworkLimitReached',
        title: zh ? '任务步数达到上限' : 'Task ran out of steps',
        help: zh ? '单次任务执行步数达到上限时，自动开启下一段继续执行。' : 'When a task exhausts its step budget, the next segment starts automatically.',
        enabled: triggers.frameworkLimitReached,
        disabled,
        zh,
      }),
      renderLimitRow({
        value: typeof item.maxConsecutiveContinuations === 'number' ? item.maxConsecutiveContinuations : 5,
        disabled,
        zh,
      }),
      '</section>',
      renderGuardSection({ item, zh }),
      '<div class="force-continuation-note">', zh
        ? '手动停止与服务错误不会触发自动接续；自动接续次数受上限约束；超阈值打断触发后自动关闭。'
        : 'Manual stops and service errors never trigger auto-resume; auto-resume is capped; the threshold intercept disarms after one trip.', '</div>',
      '</div>',
    ].join('');
  }

  function normalizeStatus(status) {
    return status && typeof status === 'object' ? status : {};
  }

  async function refreshStatus({ renderWhenDone = true } = {}) {
    if (!isSupportedAgent()) return null;
    const sessionId = currentSessionId();
    const key = runtimeKey();
    if (!sessionId || !focusedAgentId || !key) return null;
    const current = getState(key);
    if (current.refreshing || current.pending) return null;

    setState({ refreshing: true, error: '' }, key);
    try {
      const params = new URLSearchParams({ agentId: focusedAgentId, sessionId });
      const response = await fetch(`/protoclaw/force_continuation_status?${params.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
      const status = normalizeStatus(payload.status);
      setState({ ...status, enabled: status.enabled === true, triggers: getTriggers(status), refreshing: false, initialized: true, error: '' }, key);
      return status;
    } catch (error) {
      setState({ refreshing: false, initialized: true, error: String(error?.message || error) }, key);
      return null;
    } finally {
      if (renderWhenDone && activeFeaturePanel === 'session-controls') renderFeaturePanel();
    }
  }

  async function updateControl(patch) {
    if (!isSupportedAgent()) return;
    const sessionId = currentSessionId();
    const key = runtimeKey();
    if (!sessionId || !focusedAgentId || !key) return;
    setState({ pending: true, error: '' }, key);
    if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
    try {
      const response = await fetch('/protoclaw/force_continuation_control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: focusedAgentId, sessionId, ...patch }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
      const status = normalizeStatus(payload.status);
      setState({ ...status, enabled: status.enabled === true, triggers: getTriggers(status), pending: false, initialized: true, error: '' }, key);
      if (typeof window._scheduleInspectorRefresh === 'function') window._scheduleInspectorRefresh(120);
    } catch (error) {
      setState({ pending: false, error: String(error?.message || error) }, key);
    }
    if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
  }

  async function updateEnabled(enabled) {
    return updateControl({ enabled: enabled === true });
  }

  async function updateTrigger(trigger, enabled) {
    if (trigger === 'outputTruncation') {
      // One user-facing switch drives both provider keys — the user should not
      // need to know which API names its stop reason max_tokens vs length.
      return updateControl({ triggers: { providerMaxTokens: enabled === true, providerLength: enabled === true } });
    }
    if (trigger === 'frameworkLimitReached') {
      return updateControl({ triggers: { frameworkLimitReached: enabled === true } });
    }
  }

  async function updateLimit(value) {
    const next = Math.floor(Number(value));
    if (!Number.isFinite(next) || next < 1 || next > 10) return;
    return updateControl({ maxConsecutiveContinuations: next });
  }

  // ── 上下文保护（超阈值打断开关）────────────────────────────────

  async function refreshGuardStatus({ renderWhenDone = true, silent = false } = {}) {
    if (!isGuardAvailable()) return null;
    const sessionId = currentSessionId();
    const key = runtimeKey();
    if (!sessionId || !focusedAgentId || !key) return null;
    const current = getState(key);
    if (current.guardRefreshing || current.guardPending) return null;

    setState({ guardRefreshing: true, guardError: '' }, key);
    try {
      const params = new URLSearchParams({ agentId: focusedAgentId, sessionId });
      const response = await fetch(`/protoclaw/context_guard_status?${params.toString()}`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
      const status = normalizeStatus(payload.status);
      setState({
        guardArmed: status.armed === true,
        guardTrip: normalizeGuardTrip(status.trip),
        guardThresholdTokens: Number.isFinite(Number(status.thresholdTokens)) && Number(status.thresholdTokens) > 0
          ? Math.round(Number(status.thresholdTokens)) : null,
        guardRefreshing: false,
        guardInitialized: true,
        guardError: '',
        guardPollFails: 0,
      }, key);
      return status;
    } catch (error) {
      if (!silent) {
        setState({ guardRefreshing: false, guardInitialized: true, guardError: String(error?.message || error) }, key);
      } else {
        // 静默轮询失败：容忍一次瞬时抖动，连续失败则明确提示数据可能过期，
        // 不再无限期展示旧值（否则面板会显示早已失效的阈值/开关状态）。
        const fails = (current.guardPollFails || 0) + 1;
        const patch = { guardRefreshing: false, guardPollFails: fails };
        if (fails >= 2) patch.guardError = currentLanguage !== 'en' ? '状态获取失败，显示的可能不是最新值' : 'Failed to refresh — data may be stale';
        setState(patch, key);
      }
      return null;
    } finally {
      if (renderWhenDone && activeFeaturePanel === 'session-controls') renderFeaturePanel();
    }
  }

  async function updateGuardArmed(armed) {
    if (!isGuardAvailable()) return;
    const sessionId = currentSessionId();
    const key = runtimeKey();
    if (!sessionId || !focusedAgentId || !key) return;
    setState({ guardPending: true, guardError: '' }, key);
    if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
    try {
      const response = await fetch('/protoclaw/context_guard_control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: focusedAgentId, sessionId, armed: armed === true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || `HTTP ${response.status}`);
      const status = normalizeStatus(payload.status);
      setState({
        guardArmed: status.armed === true,
        guardTrip: normalizeGuardTrip(status.trip),
        guardThresholdTokens: Number.isFinite(Number(status.thresholdTokens)) && Number(status.thresholdTokens) > 0
          ? Math.round(Number(status.thresholdTokens)) : null,
        guardPending: false,
        guardInitialized: true,
        guardError: '',
      }, key);
    } catch (error) {
      setState({ guardPending: false, guardError: String(error?.message || error) }, key);
    }
    if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
  }

  // 面板打开期间的开关实时刷新：开关会被 runtime 内真实的超阈值事件
  // 消耗，轮询保证「用掉了立刻显示为关闭」。tick 在面板关闭时 no-op。
  let _guardPollTimer = null;

  function ensureGuardPolling() {
    if (_guardPollTimer || typeof setInterval !== 'function') return;
    const timer = setInterval(() => {
      if (typeof activeFeaturePanel === 'undefined' || activeFeaturePanel !== 'session-controls') return;
      if (!isGuardAvailable() || !currentRuntimeAgentId || !currentSessionId()) return;
      void refreshGuardStatus({ renderWhenDone: true, silent: true });
    }, 3000);
    if (typeof timer?.unref === 'function') timer.unref();
    _guardPollTimer = timer;
  }

  featurePanelBody.addEventListener('change', (event) => {
    const toggle = event.target?.closest?.('[data-force-continuation-toggle]');
    if (toggle) {
      updateEnabled(toggle.checked);
      return;
    }
    const trigger = event.target?.closest?.('[data-force-continuation-trigger]');
    if (trigger) {
      updateTrigger(trigger.dataset.forceContinuationTrigger, trigger.checked);
      return;
    }
    const limit = event.target?.closest?.('[data-force-continuation-limit]');
    if (limit) updateLimit(limit.value);
    const guardToggle = event.target?.closest?.('[data-guard-armed]');
    if (guardToggle) updateGuardArmed(guardToggle.checked);
  });

  window.SessionControlsPanel = {
    render,
    updateEnabled,
    updateTrigger,
    updateLimit,
    refreshStatus,
    refreshGuardStatus,
    updateGuardArmed,
    isAvailable: () => isSupportedAgent(),
    isGuardAvailable,
  };
}());
