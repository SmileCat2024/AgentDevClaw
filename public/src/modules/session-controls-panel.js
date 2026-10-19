/**
 * session-controls-panel.js — 会话控制面板（session-local control plane）
 *
 * 三个 section 对应三个可能挂载的 Feature，均以 runtime 内 Feature 为权威
 * 状态持有者，浏览器只是乐观 UI 缓存（请求-应答式 IPC，经 /protoclaw/*_status
 * / *_control 或 capability_invoke 路由）：
 *   - 保持任务继续：ForceContinuation 的开关 / 触发条件 / 上限
 *   - 模型轮转：StepRotatingModel 的强/省模型配置（已屏蔽，见
 *     ROTATION_SECTION_DISABLED）
 *   - 输出风格：StylizedOutput 的风格选择与签名门禁状态
 *
 * （ContextGuardFeature 的超阈值打断开关原在此面板，已迁至上边栏
 * chat-context-bar 的进度条组内嵌 badge，见 modules/context-guard-toggle.js。）
 *
 * 显示条件 = 当前会话 runtime 实际挂载的 Feature 名单（inspector 快照，
 * 与 Features 面板同源）；未挂载的 section 不渲染。
 *
 * 远程会话（R2-04，ADR-0011）：状态与控制经命名空间身份转发到远程同名路由
 * 执行（feature 状态真值在远程 runtime 内）；agentId 用焦点收敛的宿主级命名
 * 空间 id（panelAgentId），sessionId 用目录条目的命名空间值；写操作统一携带
 * 幂等键，连接能力矩阵 write 缺位时面板降级为只读（无远程标识）。
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

  // ── 挂载探测：面板按当前会话实际挂载的 Feature 收敛显示 ──────────
  // 权威信号是 inspector 快照（/api/agents/<runtimeId>/hooks）里的 feature
  // 名单。同步路径直接读 currentHookInspector；三项都未命中时才补发一次
  // 探测，区分「快照还没到」与「确实没挂载」，结果按 runtime 缓存。
  const CONTROLLED_FEATURE_NAMES = {
    fc: 'force-continuation',
    rot: 'step-rotating-model',
    style: 'stylized-output',
  };

  // 模型轮转 section 已屏蔽：step-rotating-model 已从编程小助手卸载
  // （装配注释保留在 prebuilt-agents/official/programming-helper/agent.js）。
  // 屏蔽在 UI 层显式生效，即使 runtime 名单中重新出现该 feature 也不渲染；
  // 恢复时改回 false 并同步恢复 agent.js 装配。
  const ROTATION_SECTION_DISABLED = true;

  function namesToCaps(names) {
    const set = new Set(names.map((name) => String(name || '').trim()).filter(Boolean));
    return {
      fc: set.has(CONTROLLED_FEATURE_NAMES.fc),
      rot: !ROTATION_SECTION_DISABLED && set.has(CONTROLLED_FEATURE_NAMES.rot),
      style: set.has(CONTROLLED_FEATURE_NAMES.style),
    };
  }

  function capsFromInspector() {
    const raw = typeof currentHookInspector === 'object' ? currentHookInspector : null;
    const list = raw && Array.isArray(raw.features) ? raw.features : [];
    return namesToCaps(list.map((feature) => feature?.name));
  }

  // 已探明的挂载集；无法确定时返回 null（调用方触发探测或按未决处理）。
  function resolveCaps(key = runtimeKey()) {
    if (!key) return null;
    const cached = getState(key).caps;
    if (cached) return cached;
    const caps = capsFromInspector();
    if (caps.fc || caps.rot || caps.style) return caps;
    return null;
  }

  async function probeCapabilities() {
    if (!currentRuntimeAgentId || !currentSessionId()) return null;
    const key = runtimeKey();
    const item = getState(key);
    if (item.caps || item.capsProbing) return item.caps;
    if (item.capsFailedAt && Date.now() - item.capsFailedAt < 2000) return null;

    setState({ capsProbing: true }, key);
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(currentRuntimeAgentId)}/hooks`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json().catch(() => null);
      const list = snapshot && Array.isArray(snapshot.features) ? snapshot.features : [];
      setState({
        capsProbing: false,
        capsFailedAt: 0,
        caps: namesToCaps(list.map((feature) => feature?.name)),
      }, key);
    } catch {
      setState({ capsProbing: false, capsFailedAt: Date.now() }, key);
    }
    if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
    return getState(key).caps;
  }

  function currentSessionId() {
    const local = typeof getRuntimeWorkspaceSessionId === 'function' && currentRuntimeAgentId
      ? getRuntimeWorkspaceSessionId(currentRuntimeAgentId)
        || (typeof getActiveWorkspaceSessionId === 'function' ? getActiveWorkspaceSessionId() : '')
      : '';
    if (local) return local;
    // 远程会话（R2-04，ADR-0012）：远程条目不在 allAgents，viewer 绑定与
    // record 链落空——会话身份从远程目录解析（命名空间化条目值）。目录未含
    // 条目（连接断开）返回空串，调用方按「无会话」降级，与本地空态同形。
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

  // ── 远程身份与写门控（R2-04，ADR-0011/0012）─────────────────────
  // 面板调用点的宿主身份纪律：本地会话 = 焦点宿主逻辑 id（现状不变）；远程
  // 会话 = 焦点收敛产物（switchAgent 已把 focusedAgentId 收敛为宿主级命名
  // 空间 id），目录未含条目（focusedAgentId 仍是运行时引用，如断开窗口）时
  // 从目录解析，仍无则空串——调用方显式失败，不猜目标（对齐
  // slash-commands.js _currentSessionContext 身份纪律）。
  function panelAgentId() {
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

  // 写能力门控（ADR-0011 能力矩阵）：面板三项均为 runtime 控制写，远程会话
  // 按连接能力矩阵 write 位判定（capabilityFor），本地恒可写。缺位（旧远程 /
  // 断开）降级为只读呈现，不出现远程标识（ADR-0011 #5）。
  function panelWriteEnabled() {
    if (typeof isRemoteNamespaceAgentId !== 'function') return true;
    const focused = typeof focusedAgentId === 'string' ? focusedAgentId : '';
    if (!isRemoteNamespaceAgentId(focused) && !isRemoteNamespaceAgentId(currentRuntimeAgentId || '')) {
      return true;
    }
    const rc = typeof window !== 'undefined' ? window.RemoteConnections : null;
    return rc?.capabilityFor?.(panelAgentId(), 'write') === true;
  }

  // ── 幂等键（ADR-0011）：写类提交统一携带（本地忽略、远程强制）──────
  function newIdempotencyKey() {
    const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      return cryptoObj.randomUUID();
    }
    return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
      caps: null,
      capsProbing: false,
      capsFailedAt: 0,
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
        apiErrorRetry: raw.apiErrorRetry !== false,
      };
    }
    // raw Feature status shape — the two provider keys are one concern for the
    // user, so the panel shows them as a single switch (on = both respond).
    return {
      outputTruncation: raw.providerMaxTokens !== false && raw.providerLength !== false,
      frameworkLimitReached: raw.frameworkLimitReached !== false,
      apiErrorRetry: raw.apiErrorRetry !== false,
    };
  }

  // ── 渲染 ─────────────────────────────────────────────────────────
  // 结构对齐 todo-plan.js 的 renderPlanPanel：摘要行（strong/label 统计）→
  // 主开关行 → 候选列表（.plan-task-list 同构）→
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

  function renderEmpty(message, zh) {
    return '<div class="feature-panel-empty"><div class="feature-panel-section">'
      + '<div class="feature-panel-section-title">' + esc(zh ? '会话控制' : 'Session Controls') + '</div>'
      + '<div>' + esc(message) + '</div>'
      + '</div></div>';
  }

  function renderAutoResumeSection({ item, zh, writeEnabled = true }) {
    const disabled = item.pending || !writeEnabled;
    const triggers = getTriggers(item);

    return [
      '<section class="force-continuation-master">',
      '<div class="force-continuation-master-main">',
      '<div class="force-continuation-master-label">', zh ? '保持任务继续' : 'Keep task moving', '</div>',
      '<div class="force-continuation-master-help">', zh
        ? '开启后，输出被截断或可重试的 API 错误发生时，自动从中断处继续。仅当前会话生效。'
        : 'When on, truncated output and retryable API errors continue automatically from where it stopped. Applies to this session only.', '</div>',
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
      renderTriggerRow({
        key: 'apiErrorRetry',
        title: zh ? 'API 错误自动重试' : 'Retry on API errors',
        help: zh ? '调用因可重试的 API 错误（超时、断连、限流、服务端错误）失败时，自动开启下一段重试。' : 'When a call fails with a retryable API error (timeout, disconnect, rate limit, server error), the next segment retries automatically.',
        enabled: triggers.apiErrorRetry,
        disabled,
        zh,
      }),
      renderLimitRow({
        value: typeof item.maxConsecutiveContinuations === 'number' ? item.maxConsecutiveContinuations : 5,
        disabled,
        zh,
      }),
      '</section>',
    ].join('');
  }

  function render() {
    const zh = currentLanguage !== 'en';
    const sessionId = currentSessionId();

    if (!currentRuntimeAgentId || !sessionId) {
      return renderEmpty(
        zh ? '请先打开并连接一个会话。' : 'Open and connect a session first.',
        zh,
      );
    }

    // 先确认本会话实际挂载了哪些受控 Feature；快照未决时探测一次再决定
    // 显隐，避免把「数据还没到」误判成「工作空间不支持」。
    const caps = resolveCaps();
    if (!caps) {
      void probeCapabilities();
      return renderEmpty(
        zh ? '正在读取本会话的控制能力…' : "Loading this session's controls…",
        zh,
      );
    }
    if (!caps.fc && !caps.rot && !caps.style) {
      return renderEmpty(
        zh ? '此控制在当前工作空间不可用。' : 'This control is not available in the current workspace.',
        zh,
      );
    }

    const item = getState();
    // 写能力门控（ADR-0011 能力矩阵）：远程会话按连接能力矩阵 write 位判定；
    // 缺位（旧远程/断开）降级为只读呈现（开关禁用，状态仍展示远程真实值），
    // 不出现任何远程标识。本地会话恒可写（本地身份 capabilityFor 恒真）。
    const writeEnabled = panelWriteEnabled();

    if (caps.fc && !item.initialized && !item.refreshing && !item.pending) {
      // Read the authoritative session Feature state rather than treating this
      // browser cache as a source of truth (important after reopen/reload).
      void refreshStatus({ renderWhenDone: true });
    }

    const sections = [];
    if (caps.fc) sections.push(renderAutoResumeSection({ item, zh, writeEnabled: writeEnabled }));
    if (caps.rot) sections.push(renderRotationSection({ zh, writeEnabled }));
    if (caps.style) sections.push(renderStyleSection({ zh, writeEnabled }));

    const notes = [];
    if (caps.fc) notes.push(zh
      ? '手动停止与不可重试的错误（如认证失败）不会触发自动接续；自动接续次数受上限约束。'
      : 'Manual stops and non-retryable errors (e.g. auth failures) never trigger auto-resume; auto-resume is capped.');
    if (caps.style) notes.push(zh
      ? '风格切换在下一次模型调用前生效；清空选择即关闭签名门禁。'
      : 'Style changes apply before the next model call; clearing the selection disarms the signature gate.');

    return [
      '<div class="force-continuation-panel session-controls-panel">',
      ...sections,
      notes.length ? '<div class="force-continuation-note">' + esc(notes.join(zh ? '' : ' ')) + '</div>' : '',
      '</div>',
    ].join('');
  }

  function normalizeStatus(status) {
    return status && typeof status === 'object' ? status : {};
  }

  async function refreshStatus({ renderWhenDone = true } = {}) {
    if (!resolveCaps()?.fc) return null;
    const sessionId = currentSessionId();
    const key = runtimeKey();
    if (!sessionId || !focusedAgentId || !key) return null;
    const current = getState(key);
    if (current.refreshing || current.pending) return null;

    setState({ refreshing: true, error: '' }, key);
    try {
      const params = new URLSearchParams({ agentId: panelAgentId(), sessionId });
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
    if (!resolveCaps()?.fc || !panelWriteEnabled()) return;
    const sessionId = currentSessionId();
    const key = runtimeKey();
    if (!sessionId || !focusedAgentId || !key) return;
    setState({ pending: true, error: '' }, key);
    if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
    try {
      const response = await fetch('/protoclaw/force_continuation_control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
        body: JSON.stringify({ agentId: panelAgentId(), sessionId, ...patch }),
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
    if (trigger === 'apiErrorRetry') {
      return updateControl({ triggers: { apiErrorRetry: enabled === true } });
    }
  }

  async function updateLimit(value) {
    const next = Math.floor(Number(value));
    if (!Number.isFinite(next) || next < 1 || next > 10) return;
    return updateControl({ maxConsecutiveContinuations: next });
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

    // 模型轮转（capability_invoke 通用通路）
    const rotEnabled = event.target?.closest?.('[data-rotation-enabled]');
    if (rotEnabled) { void updateRotationConfig({ enabled: rotEnabled.checked }); return; }
    const rotStrongSteps = event.target?.closest?.('[data-rotation-strong-steps]');
    if (rotStrongSteps) { void updateRotationConfig({ strongSteps: Number(rotStrongSteps.value) }); return; }
    const rotCheapSteps = event.target?.closest?.('[data-rotation-cheap-steps]');
    if (rotCheapSteps) { void updateRotationConfig({ cheapSteps: Number(rotCheapSteps.value) }); }
  });

  // 轮转模型/档位下拉：触发按钮打开 body 级浮层（ccb-model-dropdown 同款），
  // 选中项在浮层内直接提交，见 openRotationMenu。输出风格下拉同配方（openStyleMenu）。
  featurePanelBody.addEventListener('click', (event) => {
    const menuBtn = event.target?.closest?.('[data-rotation-menu]');
    if (menuBtn && !menuBtn.disabled) openRotationMenu(menuBtn);
    const styleMenuBtn = event.target?.closest?.('[data-style-menu]');
    if (styleMenuBtn && !styleMenuBtn.disabled) openStyleMenu(styleMenuBtn);
  });

  // 外部入口（如 slash 菜单经 capability_invoke）修改了本面板对应的
  // Feature 状态时，刷新本地缓存——面板自身只覆盖自己的开关操作闭环。
  window.addEventListener('claw:capability-invoked', (event) => {
    const detail = event.detail || {};
    if (detail.ref === 'step-rotating-model.configure') {
      if (resolveCaps()?.rot && detail.agentId === focusedAgentId && detail.sessionId === currentSessionId()) {
        void refreshRotationStatus({ renderWhenDone: true });
      }
      return;
    }
    if (detail.ref === 'stylized-output.configure') {
      if (resolveCaps()?.style && detail.agentId === focusedAgentId && detail.sessionId === currentSessionId()) {
        void refreshStyleStatus({ renderWhenDone: true });
      }
      return;
    }
    if (detail.ref !== 'force-continuation.configure') return;
    if (!resolveCaps()?.fc || detail.agentId !== focusedAgentId || detail.sessionId !== currentSessionId()) return;
    void refreshStatus({ renderWhenDone: true });
  });

  // == 模型轮转（step-rotating-model）====================================
  // 走通用 capability_invoke 通路（ADR-0007 收编方向）：无专属 IPC 分支、
  // 无专属路由；Feature 是权威状态持有者，浏览器只是乐观 UI 缓存。
  // 模型下拉自拉 /protoclaw/model_config（活清单），档位词表按所选
  // preset 的 protocol 切换（anthropic / openai 两套词）。

  const ROTATION_REF = 'step-rotating-model.configure';
  const ROTATION_OPENAI_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  const ROTATION_ANTHROPIC_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

  const rotationStateByRuntime = new Map();
  function getRotation(key = runtimeKey()) {
    if (!rotationStateByRuntime.has(key)) {
      rotationStateByRuntime.set(key, {
        status: null, presets: [], presetsLoaded: false,
        pending: false, refreshing: false, error: '', initialized: false,
      });
    }
    return rotationStateByRuntime.get(key);
  }

  function rotationProtocolOf(presetName) {
    if (!presetName) return null;
    const r = getRotation();
    const p = r.presets.find(function (x) { return (x.name || x.model) === presetName; });
    return (p && (p.protocol || p.provider)) || null;
  }

  function rotationEffortOptions(presetName, zh) {
    const protocol = rotationProtocolOf(presetName);
    const values = protocol === 'anthropic' ? ROTATION_ANTHROPIC_EFFORTS : ROTATION_OPENAI_EFFORTS;
    return [{ label: zh ? '默认（跟随 preset）' : 'Default (preset)', value: '' }]
      .concat(values.map(function (v) { return { label: v, value: v }; }));
  }

  async function loadRotationPresets() {
    const r = getRotation();
    if (r.presetsLoaded) return;
    try {
      const resp = await fetch('/protoclaw/model_config');
      const data = await resp.json();
      r.presets = Array.isArray(data && data.presets) ? data.presets : [];
      r.presetsLoaded = true;
    } catch { /* 清单拉取失败时下拉仅含当前值 */ }
  }

  async function invokeRotation(args) {
    const sessionId = currentSessionId();
    if (!sessionId || !focusedAgentId) throw new Error('session not connected');
    const resp = await fetch('/protoclaw/capability_invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        agentId: panelAgentId(),
        sessionId,
        runtimeId: currentRuntimeAgentId || undefined,
        ref: ROTATION_REF,
        args: args || {},
      }),
    });
    const payload = await resp.json().catch(function () { return {}; });
    if (!resp.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + resp.status));
    return payload.result;
  }

  async function refreshRotationStatus({ renderWhenDone = true, silent = false } = {}) {
    if (!resolveCaps()?.rot || !currentRuntimeAgentId || !currentSessionId()) return null;
    const r = getRotation();
    if (r.refreshing || r.pending) return null;
    r.refreshing = true;
    try {
      await loadRotationPresets();
      const status = normalizeStatus(await invokeRotation({}));
      r.status = status;
      r.initialized = true;
      r.error = '';
    } catch (error) {
      r.error = String((error && error.message) || error);
      r.initialized = true;
    } finally {
      r.refreshing = false;
      if (renderWhenDone && activeFeaturePanel === 'session-controls') renderFeaturePanel();
    }
    return r.status;
  }

  async function updateRotationConfig(partial) {
    if (!resolveCaps()?.rot || !panelWriteEnabled()) return;
    const r = getRotation();
    if (r.pending) return;
    r.pending = true;
    if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
    try {
      r.status = normalizeStatus(await invokeRotation(partial));
      r.error = '';
    } catch (error) {
      r.error = String((error && error.message) || error);
    } finally {
      r.pending = false;
      if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
    }
  }

  let _rotationPollTimer = null;
  function ensureRotationPolling() {
    if (_rotationPollTimer || typeof setInterval !== 'function') return;
    const timer = setInterval(() => {
      if (typeof activeFeaturePanel === 'undefined' || activeFeaturePanel !== 'session-controls') return;
      if (!resolveCaps()?.rot || !currentRuntimeAgentId || !currentSessionId()) return;
      void refreshRotationStatus({ renderWhenDone: true, silent: true });
    }, 3000);
    if (typeof timer?.unref === 'function') timer.unref();
    _rotationPollTimer = timer;
  }

  // 与输入框模型切换（input-model-switcher.js）同配方：触发按钮 + body 级
  // .ccb-model-dropdown 浮层（fixed 定位、active 高亮、context 长度徽标）。
  // preset 项来自 /protoclaw/model_config 活清单；effort 项按所选 preset 协议
  // 出词表。选中即走 capability invoke，面板随后重渲染按钮标签。
  let _rotationMenuEl = null;

  const ROTATION_VISION_SVG = '<svg class="ccb-md-vision" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const ROTATION_CHEVRON_SVG = '<svg class="scr-trigger-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

  function renderRotationTrigger(fieldKey, value, disabled, title, placeholder) {
    return '<button type="button" class="session-controls-rotation-trigger" data-rotation-menu="' + fieldKey + '"'
      + ' title="' + esc(title) + '"' + (disabled ? ' disabled' : '') + '>'
      + '<span class="scr-trigger-label">' + esc(value || placeholder) + '</span>'
      + ROTATION_CHEVRON_SVG
      + '</button>';
  }

  function _rotationMenuItemHtml(value, label, active, vision, ctxText) {
    return '<div class="ccb-md-item' + (active ? ' active' : '') + '" data-value="' + esc(String(value)) + '">'
      + '<span class="ccb-md-left">'
      + '<span class="ccb-md-name">' + esc(String(label)) + '</span>'
      + (vision ? ROTATION_VISION_SVG : '')
      + '</span>'
      + '<span class="ccb-md-right">'
      + (ctxText ? '<span class="ccb-md-ctx">' + esc(ctxText) + '</span>' : '')
      + '</span>'
      + '</div>';
  }

  function _closeRotationMenu() {
    if (!_rotationMenuEl) return;
    const el = _rotationMenuEl;
    _rotationMenuEl = null;
    el.classList.remove('visible');
    setTimeout(function () { el.remove(); }, 150);
  }

  function _rotationMenuOutsideClick(event) {
    if (!_rotationMenuEl) return;
    if (_rotationMenuEl.contains(event.target)) {
      // 点击浮层内部（未命中列表项）：续命，等下一次外部点击。
      document.addEventListener('click', _rotationMenuOutsideClick, { once: true });
      return;
    }
    // 触发按钮的开关交给 openRotationMenu（toggle 收起 / 换源重建），此处重复
    // 注册监听会与 openRotationMenu 自己的 setTimeout 注册叠加。
    if (event.target.closest?.('[data-rotation-menu]')) return;
    _closeRotationMenu();
  }

  function _placeRotationMenu(el, rect) {
    document.body.appendChild(el);
    el.style.left = rect.left + 'px';
    el.style.top = '0px';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
    const top = rect.top - h - 4 >= 8
      ? rect.top - h - 4
      : Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - h - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    requestAnimationFrame(function () { el.classList.add('visible'); });
  }

  function openRotationMenu(btn) {
    const fieldKey = btn.dataset.rotationMenu;
    // 浮层已打开时再点同一触发按钮 = 收起。按钮元素会随面板 3s 轮询重渲染被
    // 替换，故用 fieldKey 比对而非元素引用；点其他触发按钮则关闭旧的换源重建。
    if (_rotationMenuEl && _rotationMenuEl._scrFieldKey === fieldKey) {
      _closeRotationMenu();
      return;
    }
    _closeRotationMenu();
    const isPreset = fieldKey === 'strongPreset' || fieldKey === 'cheapPreset';
    const slot = fieldKey === 'strongPreset' || fieldKey === 'strongEffort' ? 'strong' : 'cheap';
    const r = getRotation();
    const st = r.status || {};
    const zh = currentLanguage !== 'en';

    let html = '';
    if (isPreset) {
      const presets = r.presets.length ? r.presets
        : (st[slot + 'Preset'] ? [{ name: st[slot + 'Preset'] }] : []);
      presets.forEach(function (p) {
        const name = String(p.name || p.model || '');
        if (!name) return;
        const ctxText = p.contextLength && p.contextLength > 0 ? Math.round(p.contextLength / 1000) + 'K' : '';
        html += _rotationMenuItemHtml(name, name, name === st[slot + 'Preset'], p.vision === true, ctxText);
      });
    } else {
      rotationEffortOptions(st[slot + 'Preset'], zh).forEach(function (o) {
        html += _rotationMenuItemHtml(o.value, o.label, String(o.value) === String(st[slot + 'Effort'] || ''), false, '');
      });
    }

    const el = document.createElement('div');
    el.className = 'ccb-model-dropdown';
    el.innerHTML = '<div class="ccb-model-dropdown-list">' + html + '</div>';

    el.addEventListener('click', function (event) {
      const itemEl = event.target.closest && event.target.closest('.ccb-md-item');
      if (!itemEl) return;
      const value = itemEl.dataset.value;
      _closeRotationMenu();
      const patch = {};
      patch[fieldKey] = isPreset ? value : (value === '' ? null : value);
      void updateRotationConfig(patch);
    });

    _rotationMenuEl = el;
    el._scrFieldKey = fieldKey;
    _placeRotationMenu(el, btn.getBoundingClientRect());
    setTimeout(function () {
      document.addEventListener('click', _rotationMenuOutsideClick, { once: true });
    }, 0);
  }

  function renderRotationStepsInput(attribute, value, disabled) {
    const v = Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
    return '<input type="number" class="session-controls-rotation-steps" ' + attribute
      + ' min="1" max="10" step="1" value="' + String(v) + '"' + (disabled ? ' disabled' : '') + '>';
  }

  function renderRotationModelRow({ zh, slot, presetName, effort, disabled }) {
    const isStrong = slot === 'strong';
    const title = isStrong ? (zh ? '强模型' : 'Strong model') : (zh ? '性价比模型' : 'Budget model');
    const help = isStrong
      ? (zh ? '轮转周期内先连续执行的模型，通常承担规划与关键决策 step。' : 'Runs first in each rotation cycle; typically planning and key decisions.')
      : (zh ? '承接轮转中低价值 step，压低整体成本。' : 'Absorbs low-value steps to cut overall cost.');
    return [
      '<div class="session-controls-rotation-model">',
      '<div class="force-continuation-candidate-label">', esc(title), '</div>',
      '<div class="force-continuation-candidate-desc">', esc(help), '</div>',
      '<div class="session-controls-rotation-controls">',
      renderRotationTrigger(
        slot + 'Preset',
        presetName || '',
        disabled,
        zh ? '选择模型' : 'Pick model',
        zh ? '（选择模型）' : '(pick model)',
      ),
      renderRotationTrigger(
        slot + 'Effort',
        effort || (zh ? '默认档位' : 'Default'),
        disabled,
        zh ? '思考档位（默认 = 跟随 preset）' : 'Thinking effort (default = preset)',
        zh ? '默认档位' : 'Default',
      ),
      '</div>',
      '</div>',
    ].join('');
  }

  function renderRotationSection({ zh, writeEnabled = true }) {
    const r = getRotation();
    if (!r.initialized && !r.refreshing && !r.pending) {
      void refreshRotationStatus({ renderWhenDone: true });
    }
    ensureRotationPolling();
    const st = r.status || {};
    const disabled = r.pending || !writeEnabled;

    const facts = [];
    if (st.currentPreset) facts.push((zh ? '当前 ' : 'now ') + String(st.currentPreset));
    if (st.slotAtLastStep === 'strong') facts.push(zh ? '相位：强' : 'phase: strong');
    else if (st.slotAtLastStep === 'cheap') facts.push(zh ? '相位：省' : 'phase: cheap');
    if (Array.isArray(st.recentSwaps) && st.recentSwaps.length) {
      facts.push((zh ? '本会话切换 ' : 'swaps ') + String(st.recentSwaps.length));
    }

    const rows = [];
    if (r.error) rows.push('<div class="session-controls-guard-error">' + esc(r.error) + '</div>');
    else if (st.lastError) rows.push('<div class="session-controls-guard-error">' + esc(String(st.lastError)) + '</div>');
    if (facts.length) rows.push('<div class="session-controls-guard-fact">' + esc(facts.join(' · ')) + '</div>');

    return [
      '<section class="force-continuation-candidates session-controls-rotation">',
      '<div class="force-continuation-group-label">', zh ? '模型轮转' : 'MODEL ROTATION', '</div>',
      '<div class="force-continuation-candidate">',
      '<div class="force-continuation-candidate-main">',
      '<div class="force-continuation-candidate-label">', zh ? 'step 级模型轮转' : 'Step-level model rotation', '</div>',
      '<div class="force-continuation-candidate-desc">', zh
        ? '强模型连续 N 步后切性价比模型 M 步循环。仅当前会话生效。'
        : 'Strong model runs N steps, then the budget model runs M steps, in a loop. This session only.', '</div>',
      '</div>',
      renderSwitch({
        checked: st.enabled === true,
        disabled,
        title: zh ? '切换模型轮转' : 'Toggle model rotation',
        attribute: 'data-rotation-enabled',
      }),
      '</div>',
      '<div class="session-controls-rotation-body', st.enabled === true ? '' : ' is-master-off', '">',
      renderRotationModelRow({ zh, slot: 'strong', presetName: st.strongPreset, effort: st.strongEffort, disabled }),
      renderRotationModelRow({ zh, slot: 'cheap', presetName: st.cheapPreset, effort: st.cheapEffort, disabled }),
      '<div class="session-controls-rotation-model">',
      '<div class="force-continuation-candidate-label">', zh ? '轮转步数（强 : 省）' : 'Rotation steps (strong : cheap)', '</div>',
      '<div class="force-continuation-candidate-desc">', zh
        ? '一个周期内各自连续执行的 step 数（1–10）。'
        : 'Consecutive steps per cycle for each model (1-10).', '</div>',
      '<div class="session-controls-rotation-controls">',
      renderRotationStepsInput('data-rotation-strong-steps', st.strongSteps, disabled),
      '<span class="session-controls-rotation-sep">:</span>',
      renderRotationStepsInput('data-rotation-cheap-steps', st.cheapSteps, disabled),
      '</div>',
      '</div>',
      ...rows,
      '</div>',
      '</section>',
    ].join('');
  }

  // == 输出风格（stylized-output）=====================================
  // 风格清单/门禁状态读取与选择切换全部走 capability_invoke 通用通道
  // （stylized-output.configure，slash 入口契约）。风格发现自 feature 内置
  // 目录与工作区 .agentdev/output-style/（重名时工作区优先）；未选择时配置的
  // 默认风格自动启用，面板"清除"是显式清除——清除后默认风格不再自动回填。
  // 切换直接写 Feature 会话内存态（不落盘、跨会话不继承），下一次模型调用前由 Feature 注入生效。

  const STYLE_REF = 'stylized-output.configure';

  const styleStateByRuntime = new Map();
  function getStyleState(key = runtimeKey()) {
    if (!styleStateByRuntime.has(key)) {
      styleStateByRuntime.set(key, {
        status: null, pending: false, refreshing: false, error: '', initialized: false,
      });
    }
    return styleStateByRuntime.get(key);
  }

  async function invokeStyle(args) {
    const sessionId = currentSessionId();
    if (!sessionId || !focusedAgentId) throw new Error('session not connected');
    const resp = await fetch('/protoclaw/capability_invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': newIdempotencyKey() },
      body: JSON.stringify({
        agentId: panelAgentId(),
        sessionId,
        runtimeId: currentRuntimeAgentId || undefined,
        ref: STYLE_REF,
        args: args || {},
      }),
    });
    const payload = await resp.json().catch(function () { return {}; });
    if (!resp.ok || payload.ok !== true) throw new Error(payload.error || ('HTTP ' + resp.status));
    return payload.result;
  }

  async function refreshStyleStatus({ renderWhenDone = true, silent = false } = {}) {
    if (!resolveCaps()?.style || !currentRuntimeAgentId || !currentSessionId()) return null;
    const st = getStyleState();
    if (st.refreshing) return null;
    if (!silent && st.pending) return null;
    st.refreshing = true;
    if (!silent && activeFeaturePanel === 'session-controls') renderFeaturePanel();
    try {
      const status = normalizeStatus(await invokeStyle({}));
      st.status = status;
      st.error = '';
      st.initialized = true;
    } catch (error) {
      st.error = String(error?.message || error);
    } finally {
      st.refreshing = false;
      if (renderWhenDone && activeFeaturePanel === 'session-controls') renderFeaturePanel();
    }
    return null;
  }

  async function updateStyleSelection(styleName) {
    if (!resolveCaps()?.style || !panelWriteEnabled()) return;
    const sessionId = currentSessionId();
    if (!sessionId || !focusedAgentId) return;
    const st = getStyleState();
    st.pending = true;
    st.error = '';
    if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
    try {
      const status = normalizeStatus(await invokeStyle({ styleName: styleName || null }));
      st.status = status;
      st.initialized = true;
    } catch (error) {
      st.error = String(error?.message || error);
    } finally {
      st.pending = false;
      if (activeFeaturePanel === 'session-controls') renderFeaturePanel();
    }
  }

  // 门禁状态（signed/blocked/...）随每轮回复变化，面板打开期间低频轮询。
  let _stylePollTimer = null;
  function ensureStylePolling() {
    if (_stylePollTimer || typeof setInterval !== 'function') return;
    const timer = setInterval(function () {
      if (typeof activeFeaturePanel === 'undefined' || activeFeaturePanel !== 'session-controls') return;
      if (!currentRuntimeAgentId || !currentSessionId()) return;
      if (!resolveCaps()?.style) return;
      void refreshStyleStatus({ renderWhenDone: true, silent: true });
    }, 3000);
    if (typeof timer?.unref === 'function') timer.unref();
    _stylePollTimer = timer;
  }

  // 风格下拉与轮转模型下拉同配方（openRotationMenu）：触发按钮 + body 级
  // .ccb-model-dropdown 浮层，条目复用 _rotationMenuItemHtml 的 ccb-md 结构。
  let _styleMenuEl = null;

  function _closeStyleMenu() {
    if (!_styleMenuEl) return;
    const el = _styleMenuEl;
    _styleMenuEl = null;
    el.classList.remove('visible');
    setTimeout(function () { el.remove(); }, 150);
  }

  function _styleMenuOutsideClick(event) {
    if (!_styleMenuEl) return;
    if (_styleMenuEl.contains(event.target)) {
      document.addEventListener('click', _styleMenuOutsideClick, { once: true });
      return;
    }
    if (event.target.closest?.('[data-style-menu]')) return; // 触发按钮交给 openStyleMenu toggle
    _closeStyleMenu();
  }

  function openStyleMenu(btn) {
    // 唯一触发按钮：浮层已打开时再点 = 收起。
    if (_styleMenuEl) {
      _closeStyleMenu();
      return;
    }
    const st = getStyleState();
    const status = normalizeStatus(st.status);
    const styles = Array.isArray(status.styles) ? status.styles : [];
    const active = typeof status.activeStyle === 'string' ? status.activeStyle : '';
    const zh = currentLanguage !== 'en';

    let html = _rotationMenuItemHtml('', zh ? '未选择（不启用）' : '(none)', !active, false, '');
    styles.forEach(function (item) {
      const name = String(item && item.name || '');
      if (!name) return;
      html += _rotationMenuItemHtml(name, name, name === active, false, '');
    });

    const el = document.createElement('div');
    el.className = 'ccb-model-dropdown';
    el.innerHTML = '<div class="ccb-model-dropdown-list">' + html + '</div>';
    el.addEventListener('click', function (event) {
      const itemEl = event.target.closest && event.target.closest('.ccb-md-item');
      if (!itemEl) return;
      _closeStyleMenu();
      void updateStyleSelection(itemEl.dataset.value || null);
    });

    _styleMenuEl = el;
    _placeRotationMenu(el, btn.getBoundingClientRect());
    setTimeout(function () {
      document.addEventListener('click', _styleMenuOutsideClick, { once: true });
    }, 0);
  }

  function renderStyleSection({ zh, writeEnabled = true }) {
    const st = getStyleState();
    if (!st.initialized && !st.refreshing && !st.pending) {
      void refreshStyleStatus({ renderWhenDone: true });
    }
    ensureStylePolling();
    const status = normalizeStatus(st.status);
    const styles = Array.isArray(status.styles) ? status.styles : [];
    const active = typeof status.activeStyle === 'string' ? status.activeStyle : '';
    const disabled = st.pending || !writeEnabled;

    const facts = [];
    if (styles.length) facts.push((zh ? '已发现 ' : 'found ') + String(styles.length));
    facts.push(active
      ? (zh ? '门禁已启用，每轮回复须签名' : 'gate on: every reply must sign')
      : (zh ? '门禁未启用（未选择风格）' : 'gate off (no style selected)'));
    if (status.lastAction && status.lastAction !== 'idle') {
      facts.push((zh ? '最近动作 ' : 'last ') + String(status.lastAction));
    }

    const rows = [];
    if (st.error) rows.push('<div class="session-controls-guard-error">' + esc(st.error) + '</div>');
    else if (!styles.length && st.initialized) rows.push('<div class="session-controls-guard-fact">' + esc(zh
      ? '尚未发现风格：把风格 md 放入工作区 .agentdev/output-style/'
      : 'No styles found: drop style md files into .agentdev/output-style/ in the workspace') + '</div>');

    return [
      '<section class="force-continuation-candidates session-controls-style">',
      '<div class="force-continuation-group-label">', zh ? '输出风格' : 'OUTPUT STYLE', '</div>',
      '<div class="force-continuation-candidate">',
      '<div class="force-continuation-candidate-main">',
      '<div class="force-continuation-candidate-label">', zh ? '风格选择' : 'Style', '</div>',
      '<div class="force-continuation-candidate-desc">', zh
        ? '选中后下一次模型调用起按该风格输出，且每次最终回复须通过确认签名门禁。风格文件由你放入 .agentdev/output-style/。'
        : 'Once selected, replies follow the style and each final reply must pass the confirmation-signature gate. Style files live in .agentdev/output-style/.', '</div>',
      '<div class="session-controls-rotation-controls">',
      '<button type="button" class="session-controls-rotation-trigger" data-style-menu="1"'
      + ' title="', esc(zh ? '选择输出风格' : 'Pick output style'), '"', disabled ? ' disabled' : '', '>',
      '<span class="scr-trigger-label">', esc(active || (zh ? '未选择（不启用）' : '(none)')), '</span>',
      ROTATION_CHEVRON_SVG,
      '</button>',
      '</div>',
      '</div>',
    ].concat(rows)
      .concat(facts.length ? ['<div class="session-controls-guard-fact">' + esc(facts.join(' · ')) + '</div>'] : [])
      .concat(['</div>', '</section>'])
      .join('');
  }

  window.SessionControlsPanel = {
    render,
    updateEnabled,
    updateTrigger,
    updateLimit,
    refreshStatus,
    refreshRotationStatus,
    updateRotationConfig,
    refreshStyleStatus,
    updateStyleSelection,
    // 消费方按已探明的挂载集决定是否发请求；探测未决时返回 false，避免对
    // 不支持的 runtime 打出 503。
    isAvailable: () => {
      const caps = resolveCaps();
      return !!(caps && (caps.fc || caps.rot || caps.style));
    },
    isStyleAvailable: () => resolveCaps()?.style === true,
  };
}());
