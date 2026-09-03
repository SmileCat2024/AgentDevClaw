/**
 * generative-ui-panel.js
 *
 * State manager + Panel integration for persistent Generative UI surfaces.
 *
 * Responsibilities:
 *   - Registry cache: surfaceId → { spec, revision, title, closed }
 *   - ViewState per surface: fieldName → value (dirty draft state)
 *   - ETag-based poll: only re-fetches when ETag changes
 *   - Mount point strategy: render() returns a stable div; subsequent updates
 *     patch it directly without triggering renderFeaturePanel()
 *   - Dirty merge: when Agent updates a surface, dirty fields with compatible
 *     types are preserved
 *
 * Self-managed poll timer — does NOT modify the main poll loop.
 * The timer starts when the panel opens and stops when it closes.
 *
 * Dependencies (globals):
 *   - currentRuntimeAgentId (app-core.js)
 *   - renderGenUISpec, createGenUIViewState (generative-ui-renderer.js)
 *   - featurePanels (app-ui.js — registration happens there)
 *
 * Exposed globally:
 *   - window.GenUIPanel.getHtml()       — returns mount point HTML string
 *   - window.GenUIPanel.onOpen()        — lifecycle: panel opened
 *   - window.GenUIPanel.onClose()       — lifecycle: panel closed
 *   - window.GenUIPanel.submitToAgent() — action adapter (called by renderer)
 *   - window.GenUIPanel.resetSurface()  — action adapter (called by renderer)
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════════════

  const POLL_INTERVAL_MS = 3000;
  const MOUNT_ID = 'gen-ui-mount';
  const INPUT_COMPONENT_TYPES = new Set([
    'TextInput',
    'NumberInput',
    'Textarea',
    'Select',
    'Checkbox',
    'RadioGroup',
    'DateInput',
    'Slider',
    'Switch',
    'SegmentedControl',
  ]);

  // ═══════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════

  let _pollTimer = null;
  let _pollingInFlight = false;
  let _lastETag = null;
  let _lastPolledAgentId = null;
  let _activeSurfaceId = null;
  let _panelOpen = false;
  /** @type {Map<string, {spec:Object, revision:number, title:string, closed:boolean}>} */
  const _registry = new Map();
  /** @type {Map<string, Object>} surfaceId → ViewState object */
  const _viewStates = new Map();
  /** @type {Set<string>} surface/action keys currently being submitted */
  const _submissionsInFlight = new Set();

  // ═══════════════════════════════════════════════════════════════
  // Remote write discipline (ADR-0011 / R2-03)
  // ═══════════════════════════════════════════════════════════════

  // 写类提交统一携带幂等键（本地忽略、远程强制，ADR-0011 前端纪律）。
  function newIdempotencyKey() {
    const cryptoObj = (typeof crypto !== 'undefined') ? crypto : null;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      return cryptoObj.randomUUID();
    }
    return `key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // 动作提交门控（ADR-0011 能力矩阵）：本地身份恒可写；远程会话按
  // capabilityFor(agentId, 'write') 判定，缺位（旧远程/断开/未知连接）降级为
  // 只读。capabilityFor 未挂载（集成窗口）时退回命名空间判定——本地恒可写、
  // 远程禁用；不引入伪能力位（session-list-render viewCapabilityEnabled 同形）。
  function actionSubmitEnabled(agentId) {
    if (typeof agentId !== 'string' || !agentId) return false;
    if (!agentId.startsWith('remote:')) return true;
    const capabilityFor = window.RemoteConnections && window.RemoteConnections.capabilityFor;
    if (typeof capabilityFor === 'function') {
      return capabilityFor(agentId, 'write') === true;
    }
    return false;
  }

  function getCurrentAgentId() {
    return (typeof currentRuntimeAgentId !== 'undefined') ? currentRuntimeAgentId : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // Panel lifecycle
  // ═══════════════════════════════════════════════════════════════

  function getHtml() {
    // 只返回空 mount div。
    // 面板声明了 preserveOnReRender，所以 renderFeaturePanel() 在已渲染时
    // 不会替换 innerHTML，事件监听器和输入状态得以保留。
    // 初始填充由 onOpen() 负责，后续更新由 poll timer 负责。
    return `<div id="${MOUNT_ID}" class="gen-ui-mount"></div>`;
  }

  function onOpen() {
    _panelOpen = true;
    // 立即拉取一次最新数据（不需要 mount div）
    _doPoll().catch(() => {});
    _ensureBackgroundPolling();
    // 尝试立即填充（如果面板 body 已同步提交，mount div 已存在）
    _tryPopulate();
  }

  /**
   * 填充 mount div，处理 deferred body 的时序竞态。
   * renderFeaturePanel({ deferBody: true }) 会推迟 mount div 的创建到 double rAF 之后，
   * 所以 onOpen() 执行时 mount div 可能还不存在。
   * 解决方案：立即尝试一次 + double rAF 后再尝试一次。
   */
  function _tryPopulate() {
    _populateMount();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      // 如果 mount 存在但仍为空，说明 deferred body 刚创建它
      const mount = document.getElementById(MOUNT_ID);
      if (mount && mount.children.length === 0) {
        _populateMount();
      }
    }));
  }

  function onClose() {
    _panelOpen = false;
    // 不停止后台轮询 — badge 需要持续更新
  }

  // ═══════════════════════════════════════════════════════════════
  // Polling
  // ═══════════════════════════════════════════════════════════════

  function _ensureBackgroundPolling() {
    // 轮询始终在后台运行，不依赖面板是否打开。
    // 这样 badge 始终能反映当前活跃 surface 数量。
    if (_pollTimer !== null) return;
    _pollTimer = setInterval(() => {
      _doPoll().catch((e) => console.warn('[GenUI] poll error:', e));
    }, POLL_INTERVAL_MS);
  }

  async function _doPoll() {
    if (_pollingInFlight) return;
    const agentId = (typeof currentRuntimeAgentId !== 'undefined') ? currentRuntimeAgentId : null;
    if (!agentId) return;

    // Agent 切换时清除 ETag 和 registry（不同 agent 的 surface 完全独立）
    if (_lastPolledAgentId && _lastPolledAgentId !== agentId) {
      _lastETag = null;
      _registry.clear();
      _viewStates.clear();
      _activeSurfaceId = null;
      _populateMount();
      _updateBadge();
    }
    _lastPolledAgentId = agentId;

    _pollingInFlight = true;
    try {
      const headers = {};
      if (_lastETag) headers['If-None-Match'] = _lastETag;

      const res = await fetch(`/protoclaw/agents/${agentId}/ui-surfaces?includeSpec=true`, { headers });
      if (res.status === 304) return; // no change

      if (!res.ok) {
        if (res.status === 404) {
          // Agent not found / no surfaces — clear mount
          if (_registry.size > 0) {
            _registry.clear();
            _viewStates.clear();
            _activeSurfaceId = null;
            _lastETag = null;
            _populateMount();
            _updateBadge();
          }
        }
        return;
      }

      const etag = res.headers ? res.headers.get('ETag') : null;
      if (etag) _lastETag = etag;

      const data = await res.json();
      _applyRegistryUpdate(data);
    } finally {
      _pollingInFlight = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Registry diff + DOM update
  // ═══════════════════════════════════════════════════════════════

  /**
   * @param {Object} snapshot — { surfaces: [{ surfaceId, spec, revision, title, closed }] }
   */
  function _applyRegistryUpdate(snapshot) {
    const incoming = new Map();
    const surfaces = (snapshot && snapshot.surfaces) || [];
    let changed = false;

    for (const s of surfaces) {
      if (!s.surfaceId) continue;
      incoming.set(s.surfaceId, s);
    }

    // Remove surfaces that are gone or closed
    for (const [id, cached] of _registry) {
      const inc = incoming.get(id);
      if (!inc || inc.closed) {
        _registry.delete(id);
        _viewStates.delete(id);
        if (_activeSurfaceId === id) _activeSurfaceId = null;
        changed = true;
      }
    }

    // Add or update
    for (const [id, inc] of incoming) {
      if (inc.closed) continue;
      const cached = _registry.get(id);

      if (!cached) {
        // New surface
        _registry.set(id, {
          spec: inc.spec,
          revision: inc.revision,
          title: inc.title || inc.spec?.title || 'Surface',
          closed: false,
        });
        _viewStates.set(id, createGenUIViewState());
        changed = true;
      } else if (inc.revision > cached.revision) {
        // Updated spec — preserve only user overrides with compatible types.
        const oldVS = _viewStates.get(id) || {};
        const newVS = _mergeViewState(inc.spec, oldVS);
        _viewStates.set(id, newVS);
        _registry.set(id, {
          spec: inc.spec,
          revision: inc.revision,
          title: inc.title || inc.spec?.title || cached.title,
          closed: false,
        });
        changed = true;
      }
    }

    if (!_activeSurfaceId || !_registry.has(_activeSurfaceId)) {
      _activeSurfaceId = _getSortedSurfaces()[0]?.[0] || null;
    }

    if (changed) {
      _populateMount();
    }
    _updateBadge();
  }

  function _updateBadge() {
    const badge = document.getElementById('rail-genui-badge');
    if (!badge) return;
    const count = _registry.size;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.add('visible');
    } else {
      badge.classList.remove('visible');
      badge.textContent = '';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Dirty merge: preserve compatible dirty values
  // ═══════════════════════════════════════════════════════════════

  function _mergeViewState(newSpec, oldVS) {
    const newVS = {};
    const initialValues = newSpec.initialValues || {};
    const inputFields = _getInputFieldNames(newSpec);

    // ViewState only stores explicit user overrides. initialValues stay on the
    // spec, which lets an agent update an untouched prefill without it being
    // mistaken for a local draft.
    for (const [k, dirtyVal] of Object.entries(oldVS)) {
      if (!inputFields.has(k)) continue;
      const initialValue = initialValues[k];
      const typeIsCompatible = initialValue == null || typeof initialValue === typeof dirtyVal;
      if (typeIsCompatible) {
        newVS[k] = dirtyVal;
      }
      // If type mismatch, drop the obsolete user override and render the new
      // initial value from the spec.
    }

    return newVS;
  }

  function _getInputFieldNames(spec) {
    const fieldNames = new Set();
    const elements = spec?.elements || {};
    for (const element of Object.values(elements)) {
      if (!element || !INPUT_COMPONENT_TYPES.has(element.type)) continue;
      const name = element.props?.name;
      if (typeof name === 'string' && name.length > 0) fieldNames.add(name);
    }
    return fieldNames;
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM population — patch mount div directly (no renderFeaturePanel)
  // ═══════════════════════════════════════════════════════════════

  function _populateMount() {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    // Clear and rebuild
    mount.innerHTML = '';

    if (_registry.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'gen-ui-empty';
      const icon = document.createElement('div');
      icon.className = 'gen-ui-empty-icon';
      icon.textContent = '✦';
      empty.appendChild(icon);
      const title = document.createElement('div');
      title.className = 'gen-ui-empty-title';
      title.textContent = '暂时没有交互页面';
      empty.appendChild(title);
      const description = document.createElement('div');
      description.className = 'gen-ui-empty-description';
      description.textContent = 'Agent 创建页面后，会在这里以页签形式呈现。';
      empty.appendChild(description);
      mount.appendChild(empty);
      return;
    }

    const sorted = _getSortedSurfaces();
    if (!_activeSurfaceId || !_registry.has(_activeSurfaceId)) {
      _activeSurfaceId = sorted[0][0];
    }

    const workspace = document.createElement('div');
    workspace.className = 'gen-ui-workspace';

    const tabs = document.createElement('div');
    // Reuse the Cloud settings tab bar; the Gen UI layer adds scrollable,
    // closable document tabs for multiple concurrent surfaces.
    tabs.className = 'settings-tab-bar gen-ui-surface-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '交互页面');
    for (const [surfaceId, cached] of sorted) {
      const tabItem = document.createElement('div');
      tabItem.className = 'gen-ui-surface-tab-item';
      const tab = document.createElement('button');
      const isActive = surfaceId === _activeSurfaceId;
      tab.type = 'button';
      tab.className = 'gen-ui-surface-tab';
      if (isActive) tabItem.classList.add('is-active');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(isActive));
      tab.setAttribute('aria-controls', `gen-ui-surface-page-${surfaceId}`);
      tab.textContent = cached.title || 'Surface';
      tab.title = cached.spec?.description
        ? `${cached.title || 'Surface'}\n${cached.spec.description}`
        : (cached.title || 'Surface');
      tab.addEventListener('click', () => {
        if (_activeSurfaceId === surfaceId) return;
        _activeSurfaceId = surfaceId;
        _populateMount();
      });

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'gen-ui-surface-tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = `关闭${cached.title || 'Surface'}`;
      closeBtn.setAttribute('aria-label', `关闭${cached.title || 'Surface'}`);
      closeBtn.addEventListener('click', () => _closeSurface(surfaceId));

      tabItem.appendChild(tab);
      tabItem.appendChild(closeBtn);
      tabs.appendChild(tabItem);
    }
    workspace.appendChild(tabs);

    const cached = _registry.get(_activeSurfaceId);
    if (cached) {
      const viewState = _viewStates.get(_activeSurfaceId) || {};
      workspace.appendChild(_buildSurfaceDOM(_activeSurfaceId, cached, viewState));
    }
    mount.appendChild(workspace);
  }

  function _getSortedSurfaces() {
    return [..._registry.entries()].sort((a, b) => a[1].revision - b[1].revision);
  }

  function _buildSurfaceDOM(surfaceId, cached, viewState) {
    const container = document.createElement('div');
    container.className = 'gen-ui-surface-page';
    container.id = `gen-ui-surface-page-${surfaceId}`;
    container.setAttribute('role', 'tabpanel');
    container.dataset.surfaceId = surfaceId;

    const content = document.createElement('div');
    content.className = 'gen-ui-surface-content';

    // Render the spec
    const callbacks = {
      onSubmit: (actionId, action, fields) => {
        _submitAction(surfaceId, actionId, action, fields);
      },
      onReset: (actionId, action) => {
        _resetAction(surfaceId);
      },
      onConfirm: (actionId, action, fields, execute) => {
        _showActionConfirmation(surfaceId, actionId, action, fields, execute);
      },
      onError: (msg) => {
        console.warn('[GenUI] Action error:', msg);
      },
    };

    try {
      const rendered = renderGenUISpec(cached.spec, viewState, callbacks);
      content.appendChild(rendered);
      _enhanceSurfaceSelects(content);
      // 写门控（R2-03）：远程会话且无 write 能力位时提交按钮禁用。renderer
      // 不暴露 intent，动作按钮统一置灰；提交适配器内另有同谓词守卫，兜住
      // 能力缓存刷新晚于渲染的窗口。本地身份恒可写。
      if (!actionSubmitEnabled(getCurrentAgentId())) {
        for (const btn of content.querySelectorAll('button.gen-ui-button')) {
          btn.disabled = true;
        }
      }
    } catch (e) {
      const errEl = document.createElement('div');
      errEl.className = 'gen-ui-error';
      errEl.textContent = 'Render error: ' + (e.message || String(e));
      content.appendChild(errEl);
    }
    container.appendChild(content);

    return container;
  }

  /**
   * Reuse the model-settings dropdown implementation. It keeps the native
   * select as the value source, so submission remains independent of visuals.
   */
  function _enhanceSurfaceSelects(container) {
    const clawSelect = window.ClawSelect
      || (typeof ClawSelect !== 'undefined' ? ClawSelect : null);
    if (!clawSelect || typeof clawSelect.enhanceAll !== 'function') return;
    clawSelect.enhanceAll(container, 'select[data-gen-ui-select]');
  }

  function _showActionConfirmation(surfaceId, actionId, action, fields, execute) {
    const surface = document.querySelector(`.gen-ui-surface-page[data-surface-id="${surfaceId}"]`);
    if (!surface || typeof execute !== 'function') return;

    const oldDialog = surface.querySelector('.gen-ui-confirm-backdrop');
    if (oldDialog) oldDialog.remove();

    const confirm = action.confirm || {};
    const isZh = typeof currentLanguage === 'undefined' || currentLanguage === 'zh';
    const backdrop = document.createElement('div');
    backdrop.className = 'gen-ui-confirm-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('section');
    dialog.className = 'gen-ui-confirm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `gen-ui-confirm-title-${surfaceId}-${actionId}`);

    const title = document.createElement('div');
    title.className = 'gen-ui-confirm-title';
    title.id = `gen-ui-confirm-title-${surfaceId}-${actionId}`;
    title.textContent = confirm.title || action.label || (isZh ? '确认操作' : 'Confirm action');
    dialog.appendChild(title);
    if (confirm.description) {
      const description = document.createElement('div');
      description.className = 'gen-ui-confirm-description';
      description.textContent = confirm.description;
      dialog.appendChild(description);
    }

    const actions = document.createElement('div');
    actions.className = 'gen-ui-confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'gen-ui-button btn-secondary';
    cancel.textContent = isZh ? '取消' : 'Cancel';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'gen-ui-button ' + ((action.intent === 'reset') ? 'btn-danger' : 'btn-primary');
    approve.textContent = confirm.confirmLabel || action.label || (isZh ? '确认' : 'Confirm');
    actions.appendChild(cancel);
    actions.appendChild(approve);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);

    const dismiss = () => backdrop.remove();
    cancel.addEventListener('click', dismiss);
    approve.addEventListener('click', () => {
      dismiss();
      execute();
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) dismiss();
    });
    surface.appendChild(backdrop);
    if (typeof approve.focus === 'function') approve.focus();
  }

  // ═══════════════════════════════════════════════════════════════
  // Action adapter
  // ═══════════════════════════════════════════════════════════════

  async function _submitAction(surfaceId, actionId, action, fields) {
    const agentId = getCurrentAgentId();
    if (!agentId) {
      console.error('[GenUI] No currentRuntimeAgentId');
      return;
    }

    // 写门控（R2-03）：远程会话且无 write 能力位时拒绝提交（远程 server 有
    // 同款幂等闸兜底，这里先行禁用以免发出注定被闸的请求）。本地身份恒可写。
    if (!actionSubmitEnabled(agentId)) {
      console.warn('[GenUI] Action submit blocked: remote session without write capability');
      return;
    }

    const cached = _registry.get(surfaceId);
    if (!cached) {
      console.error('[GenUI] Surface is no longer available:', surfaceId);
      return;
    }

    const submissionKey = `${surfaceId}:${actionId}`;
    if (_submissionsInFlight.has(submissionKey)) return;
    _submissionsInFlight.add(submissionKey);

    const eventId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const actionUrl = [
      '/protoclaw/agents',
      encodeURIComponent(agentId),
      'ui-surfaces',
      encodeURIComponent(surfaceId),
      'actions',
      encodeURIComponent(actionId),
    ].join('/');

    try {
      const res = await fetch(actionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 幂等键（ADR-0011）：eventId 即面板动作的幂等凭证——本地 server
          // 忽略，远程分支以 body.eventId 为闸键（两处同值）。
          'x-idempotency-key': eventId,
        },
        body: JSON.stringify({
          eventId,
          surfaceRevision: cached.revision,
          values: fields || {},
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = body.message || `HTTP ${res.status}`;
        console.error('[GenUI] action submit failed:', res.status, message);
        _showSubmitError(surfaceId, message);
        return;
      }

      const result = await res.json().catch(() => ({}));

      // Direct delivery consumes the idle loop's pending input request. Clear
      // the stale request optimistically so it cannot be submitted a second time.
      // patch 写入即声明（工单 037）：输入面渲染由 hook 自动触发。
      if (result.delivery === 'input' && typeof applySessionViewPatch === 'function') {
        applySessionViewPatch({ inputRequests: [] });
      }

      if (typeof clearInterruptSuppression === 'function') clearInterruptSuppression(agentId);
      if (typeof _markAgentCallStartedForNotify === 'function') _markAgentCallStartedForNotify(agentId);
      if (typeof _agentCallActive !== 'undefined') _agentCallActive.set(agentId, true);
      if (typeof _syncPersistentActionButton === 'function') _syncPersistentActionButton();
      if (typeof renderAgentList === 'function') renderAgentList();
      if (result.delivery === 'queued' && typeof _syncQueueFromBackend === 'function') {
        _syncQueueFromBackend();
      }
      if (typeof poll === 'function') poll();
    } catch (e) {
      console.error('[GenUI] Submit error:', e);
      _showSubmitError(surfaceId, e?.message || String(e));
    } finally {
      _submissionsInFlight.delete(submissionKey);
    }
  }

  function _showSubmitError(surfaceId, message) {
    if (typeof ClawToast === 'undefined' || typeof ClawToast.show !== 'function') return;
    ClawToast.show({
      id: `gen-ui-submit-${surfaceId}`,
      title: '提交失败',
      status: 'error',
      description: message,
    });
  }

  function _resetAction(surfaceId) {
    const cached = _registry.get(surfaceId);
    if (!cached) return;
    _viewStates.set(surfaceId, {});
    _populateMount();
  }

  async function _closeSurface(surfaceId) {
    const agentId = getCurrentAgentId();
    if (!agentId) return;

    try {
      await fetch(`/protoclaw/agents/${agentId}/ui-surfaces/${surfaceId}`, {
        method: 'DELETE',
        headers: { 'x-idempotency-key': newIdempotencyKey() },
      });
    } catch (e) {
      console.error('[GenUI] Close error:', e);
    }

    // Select a neighboring page before optimistic removal.
    if (_activeSurfaceId === surfaceId) {
      const ids = _getSortedSurfaces().map(([id]) => id);
      const index = ids.indexOf(surfaceId);
      _activeSurfaceId = ids[index + 1] || ids[index - 1] || null;
    }

    // Optimistic removal
    _registry.delete(surfaceId);
    _viewStates.delete(surfaceId);
    _populateMount();
    _updateBadge();
  }

  // ═══════════════════════════════════════════════════════════════
  // Global exports
  // ═══════════════════════════════════════════════════════════════

  window.GenUIPanel = {
    getHtml,
    onOpen,
    onClose,
    forceRefresh: () => { _doPoll().catch(() => {}); },
    // Exposed for testing
    _internal: {
      _registry,
      _viewStates,
      _applyRegistryUpdate,
      _mergeViewState,
      _enhanceSurfaceSelects,
      _showActionConfirmation,
      actionSubmitEnabled,
      newIdempotencyKey,
      _resetState() {
        _registry.clear();
        _viewStates.clear();
        _submissionsInFlight.clear();
        _lastETag = null;
        _lastPolledAgentId = null;
        _activeSurfaceId = null;
        _updateBadge();
      },
      _submitAction,
    },
  };

  // 启动后台轮询 — badge 需要在面板未打开时也持续更新
  _ensureBackgroundPolling();
})();
