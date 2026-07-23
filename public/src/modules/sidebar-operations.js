/**
 * sidebar-operations.js
 *
 * Unified operation state for sidebar-affecting session changes. Operation
 * records remain pure data; the small diagnostic queue is transport-only and
 * never participates in UI completion semantics.
 */

const _sidebarOperations = new Map();
// Compatibility alias while callers migrate from the replacement-only map.
const _sessionReplacementMutations = _sidebarOperations;
let _sidebarOperationVersion = 0;
let _sidebarMutationEpoch = 0;
let _sidebarOperationSequence = 0;
const _sidebarDiagnosticEventQueue = [];
let _sidebarDiagnosticFlushTimer = null;
let _sidebarDiagnosticFlushInFlight = false;

function sidebarDiagnosticNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function inferSidebarDiagnosticResult(phase, errorCode = '') {
  if (phase === 'degraded' || errorCode) return phase === 'failed' ? 'failed' : 'degraded';
  if (phase === 'failed') return 'failed';
  if (['superseded', 'expired', 'cancelled'].includes(phase)) return 'cancelled';
  if (phase === 'settled') return 'success';
  return '';
}

function buildSidebarDiagnosticPhaseEvent(operation, phase, fields = {}) {
  const result = inferSidebarDiagnosticResult(phase, fields.errorCode || operation?.errorCode);
  const event = {
    timestamp: Date.now(),
    kind: 'operation_phase',
    operationId: operation?.operationId || '',
    operation: operation?.kind || operation?.type || 'sidebar',
    phase: String(phase || operation?.phase || 'unknown'),
    agentId: operation?.agentId || '',
    sessionId: operation?.sourceSessionId || '',
    targetSessionId: operation?.targetSessionId || '',
    elapsedMs: Number(fields.elapsedMs) || 0,
    phaseDurationMs: Number(fields.phaseDurationMs) || 0,
    revision: Number(operation?.serverRevision ?? fields.revision) || 0,
    errorCode: fields.errorCode || operation?.errorCode || '',
    ...(result ? { result } : {}),
  };
  for (const key of [
    'durationMs', 'requestWaitMs', 'bodyParseMs', 'clientApplyMs',
    'longTaskTotalMs', 'longTaskMaxMs', 'longTaskCount', 'responseBytes',
  ]) {
    const value = Number(fields[key]);
    if (Number.isFinite(value) && value >= 0) event[key] = value;
  }
  return event;
}

function scheduleSidebarDiagnosticFlush(delayMs = 250) {
  if (_sidebarDiagnosticFlushTimer !== null || typeof navigator === 'undefined') return;
  _sidebarDiagnosticFlushTimer = window.setTimeout(() => {
    _sidebarDiagnosticFlushTimer = null;
    void flushSidebarDiagnosticEvents();
  }, delayMs);
}

function queueSidebarDiagnosticEvent(event) {
  if (typeof navigator === 'undefined' || typeof fetch !== 'function') return;
  _sidebarDiagnosticEventQueue.push(event);
  if (_sidebarDiagnosticEventQueue.length > 200) {
    _sidebarDiagnosticEventQueue.splice(0, _sidebarDiagnosticEventQueue.length - 200);
  }
  scheduleSidebarDiagnosticFlush(_sidebarDiagnosticEventQueue.length >= 20 ? 0 : 250);
}

async function flushSidebarDiagnosticEvents(options = {}) {
  if (_sidebarDiagnosticFlushInFlight || _sidebarDiagnosticEventQueue.length === 0) return 0;
  const events = _sidebarDiagnosticEventQueue.splice(0, 50);
  const payload = JSON.stringify({ events });

  if (options.beacon === true && typeof navigator?.sendBeacon === 'function' && typeof Blob !== 'undefined') {
    const sent = navigator.sendBeacon(
      '/protoclaw/sidebar_diagnostics/events',
      new Blob([payload], { type: 'application/json' }),
    );
    if (sent) return events.length;
  }

  _sidebarDiagnosticFlushInFlight = true;
  try {
    const response = await fetch('/protoclaw/sidebar_diagnostics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    });
    if (!response.ok) throw new Error(`diagnostic HTTP ${response.status}`);
    return events.length;
  } catch {
    _sidebarDiagnosticEventQueue.unshift(...events);
    if (_sidebarDiagnosticEventQueue.length > 200) _sidebarDiagnosticEventQueue.length = 200;
    scheduleSidebarDiagnosticFlush(2000);
    return 0;
  } finally {
    _sidebarDiagnosticFlushInFlight = false;
    if (_sidebarDiagnosticEventQueue.length > 0) scheduleSidebarDiagnosticFlush();
  }
}

if (typeof navigator !== 'undefined' && typeof window?.addEventListener === 'function') {
  window.addEventListener('pagehide', () => {
    if (_sidebarDiagnosticFlushTimer !== null) {
      window.clearTimeout(_sidebarDiagnosticFlushTimer);
      _sidebarDiagnosticFlushTimer = null;
    }
    void flushSidebarDiagnosticEvents({ beacon: true });
  });
}

function createSidebarOperationId(kind = 'sidebar') {
  _sidebarOperationSequence += 1;
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${_sidebarOperationSequence.toString(36)}`;
  return `${String(kind || 'sidebar').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'sidebar'}:${randomPart}`;
}

function normalizeSidebarOperation(raw = {}) {
  const now = Date.now();
  const kind = String(raw.kind || raw.type || 'sidebar').trim() || 'sidebar';
  const operationId = String(raw.operationId || '').trim() || createSidebarOperationId(kind);
  const sourceSessionId = String(raw.sourceSessionId || raw.sessionId || '').trim();
  return {
    schemaVersion: 1,
    operationId,
    type: String(raw.type || (['summary', 'trim', 'branch'].includes(kind) ? 'replacement' : kind)).trim() || 'sidebar',
    kind,
    phase: String(raw.phase || 'requested').trim() || 'requested',
    agentId: String(raw.agentId || raw.ownerAgentId || '').trim(),
    sourceSessionId,
    sessionId: sourceSessionId,
    sourceRuntimeId: String(raw.sourceRuntimeId || '').trim(),
    targetSessionId: String(raw.targetSessionId || '').trim(),
    targetRuntimeId: String(raw.targetRuntimeId || '').trim(),
    projectDir: String(raw.projectDir || '').trim(),
    projectName: String(raw.projectName || '').trim(),
    title: String(raw.title || '').trim(),
    serverRevision: raw.serverRevision !== null
      && raw.serverRevision !== ''
      && Number.isFinite(Number(raw.serverRevision))
      ? Number(raw.serverRevision)
      : null,
    startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : now,
    updatedAt: now,
    errorCode: String(raw.errorCode || '').trim(),
  };
}

function recordSidebarOperationPhase(operation, phase = operation?.phase, fields = {}) {
  if (!operation?.operationId) return;
  const elapsedMs = Date.now() - Number(operation.startedAt || Date.now());
  const diagnosticEvent = buildSidebarDiagnosticPhaseEvent(operation, phase, { elapsedMs, ...fields });
  console.info('[SIDEBAR_OPERATION]', {
    operationId: operation.operationId,
    operation: operation.kind,
    phase,
    agentId: operation.agentId,
    sourceSessionId: operation.sourceSessionId,
    targetSessionId: operation.targetSessionId,
    elapsedMs,
    ...fields,
  });
  queueSidebarDiagnosticEvent(diagnosticEvent);
}

// Records a timing checkpoint without mutating UI state. These checkpoints
// close the evidence gap between a server response and the next visible phase,
// while remaining content-free and persisted only through the diagnostic queue.
function recordSidebarOperationCheckpoint(operationId, phase, fields = {}) {
  const operation = getSidebarOperation(operationId);
  if (!operation?.operationId) return null;
  const event = buildSidebarDiagnosticPhaseEvent(operation, phase, {
    elapsedMs: Date.now() - Number(operation.startedAt || Date.now()),
    ...fields,
  });
  queueSidebarDiagnosticEvent(event);
  return event;
}

// Long Task observation is scoped to one network round-trip. It is not a
// permanent observer and emits one aggregate record, so diagnosis does not
// create a new source of background work or high-volume logs.
function beginSidebarOperationMainThreadObservation(operationId) {
  const operation = getSidebarOperation(operationId);
  const Observer = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null;
  if (!operation || !Observer || typeof performance === 'undefined') return () => null;

  const observationStartedAt = sidebarDiagnosticNow();
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let longTaskMaxMs = 0;
  let stopped = false;
  const consume = (entries) => {
    for (const entry of entries || []) {
      const duration = Number(entry?.duration);
      if (!Number.isFinite(duration) || duration < 50) continue;
      longTaskCount += 1;
      longTaskTotalMs += duration;
      longTaskMaxMs = Math.max(longTaskMaxMs, duration);
    }
  };

  let observer = null;
  try {
    observer = new Observer((list) => consume(list.getEntries()));
    observer.observe({ type: 'longtask', buffered: false });
  } catch {
    try { observer?.disconnect?.(); } catch {}
    return () => null;
  }

  return () => {
    if (stopped) return null;
    stopped = true;
    try { consume(observer.takeRecords?.()); } catch {}
    try { observer.disconnect(); } catch {}
    return recordSidebarOperationCheckpoint(operationId, 'main_thread_observation', {
      durationMs: sidebarDiagnosticNow() - observationStartedAt,
      longTaskCount,
      longTaskTotalMs,
      longTaskMaxMs,
    });
  };
}

function invalidateSidebarProjection() {
  _sidebarOperationVersion += 1;
  _sidebarMutationEpoch += 1;
  if (typeof lastAgentListRenderSignature !== 'undefined') lastAgentListRenderSignature = '';
  if (typeof renderAgentList === 'function') renderAgentList();
}

function beginSidebarOperation(raw = {}) {
  const operation = normalizeSidebarOperation(raw);
  _sidebarOperations.set(operation.operationId, operation);
  invalidateSidebarProjection();
  recordSidebarOperationPhase(operation, operation.phase);
  return operation;
}

function getSidebarOperation(operationId) {
  return _sidebarOperations.get(String(operationId || '').trim()) || null;
}

function listSidebarOperations(predicate = null) {
  const items = Array.from(_sidebarOperations.values());
  return typeof predicate === 'function' ? items.filter(predicate) : items;
}

function findSidebarOperation(predicate) {
  if (typeof predicate !== 'function') return null;
  const items = Array.from(_sidebarOperations.values());
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return items[index];
  }
  return null;
}

function updateSidebarOperation(operationId, updates = {}) {
  const current = getSidebarOperation(operationId);
  if (!current) return null;
  const next = normalizeSidebarOperation({
    ...current,
    ...updates,
    operationId: current.operationId,
    startedAt: current.startedAt,
  });
  _sidebarOperations.set(current.operationId, next);
  invalidateSidebarProjection();
  if (next.phase !== current.phase) {
    recordSidebarOperationPhase(next, next.phase, {
      phaseDurationMs: next.updatedAt - Number(current.updatedAt || current.startedAt || next.updatedAt),
    });
  }
  return next;
}

function finishSidebarOperation(operationId, phase = 'settled', fields = {}) {
  const current = getSidebarOperation(operationId);
  if (!current) return null;
  const finished = { ...current, phase, updatedAt: Date.now(), ...fields };
  recordSidebarOperationPhase(finished, phase, {
    phaseDurationMs: finished.updatedAt - Number(current.updatedAt || current.startedAt || finished.updatedAt),
    ...fields,
  });
  _sidebarOperations.delete(current.operationId);
  invalidateSidebarProjection();
  return finished;
}

function captureSidebarSnapshotToken() {
  return { mutationEpoch: _sidebarMutationEpoch, operationVersion: _sidebarOperationVersion };
}

function isSidebarSnapshotTokenCurrent(token) {
  return !!token && Number(token.mutationEpoch) === _sidebarMutationEpoch;
}

function getSidebarOperationVersion() {
  return _sidebarOperationVersion;
}

function markSidebarAuthoritativeMutation() {
  _sidebarMutationEpoch += 1;
}

async function settleSidebarSourceOperation(operationId, options = {}) {
  const initial = getSidebarOperation(operationId);
  if (!initial) return true;
  const agentId = String(options.agentId || initial.agentId || '').trim();
  const sessionId = String(options.sessionId || initial.sourceSessionId || '').trim();
  const attempts = Math.max(1, Number(options.attempts) || 20);
  const intervalMs = Math.max(50, Number(options.intervalMs) || 300);
  const lateReconcileAttempts = Math.max(0, Math.min(3,
    Number.isFinite(Number(options.lateReconcileAttempts)) ? Number(options.lateReconcileAttempts) : 1));
  const lateReconcileDelayMs = Math.max(250, Number(options.lateReconcileDelayMs) || 5000);
  if (!agentId || !sessionId) {
    updateSidebarOperation(operationId, { phase: 'degraded', errorCode: 'source_identity_missing' });
    return false;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const params = new URLSearchParams({ agentId, sessionId, operationId });
      const response = await fetch('/protoclaw/runtime_status?' + params.toString());
      if (response.ok) {
        const status = await response.json();
        if (status?.lifecycle === 'missing' || status?.lifecycle === 'stopped') {
          const latest = getSidebarOperation(operationId);
          if (latest?.errorCode === 'target_runtime_not_ready' && !latest.targetRuntimeId) {
            updateSidebarOperation(operationId, {
              phase: 'degraded',
              errorCode: 'target_runtime_not_ready',
            });
            if (typeof loadAgents === 'function') loadAgents().catch(e => console.warn(e));
            return false;
          }
          finishSidebarOperation(operationId, 'settled', { errorCode: '' });
          if (typeof loadAgents === 'function') loadAgents().catch(e => console.warn(e));
          return true;
        }
      }
    } catch {
      // A transient readiness-query failure must not make a disappearing
      // runtime reappear. Keep the tombstone and retry the targeted query.
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  updateSidebarOperation(operationId, { phase: 'degraded', errorCode: 'source_stop_timeout' });
  if (typeof loadAgents === 'function') loadAgents().catch(e => console.warn(e));
  if (lateReconcileAttempts > 0 && typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    window.setTimeout(() => {
      const latest = getSidebarOperation(operationId);
      if (!latest || latest.phase !== 'degraded') return;
      void settleSidebarSourceOperation(operationId, {
        ...options,
        agentId,
        sessionId,
        attempts: 1,
        intervalMs,
        lateReconcileAttempts: lateReconcileAttempts - 1,
        lateReconcileDelayMs,
      });
    }, lateReconcileDelayMs);
  }
  return false;
}

async function waitForSidebarTargetRuntime(operationId, agentId, sessionId, result = null, attempts = 50) {
  const immediateAgent = result?.agent || null;
  const immediateRuntimeId = immediateAgent?.runtime_session_id || immediateAgent?.runtimeSessionId || immediateAgent?.id || '';
  if (immediateRuntimeId) return immediateAgent;
  if (typeof waitForTargetRuntimeSession !== 'function') {
    throw new Error('Targeted runtime readiness helper is unavailable');
  }
  return waitForTargetRuntimeSession(agentId, sessionId, attempts, { operationId });
}

function getWorkspaceRevision(workspaceSessions) {
  const revision = Number(workspaceSessions?.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function getPendingSessionRemovalIds(agentId) {
  return new Set(listSidebarOperations((operation) => (
    operation.agentId === agentId
    && operation.type === 'delete'
    && !['failed', 'settled'].includes(operation.phase)
    && operation.sourceSessionId
  )).map((operation) => operation.sourceSessionId));
}

function mergeWorkspaceSessionSnapshots(previous = {}, fresh = {}, agentId = '') {
  const previousRevision = getWorkspaceRevision(previous);
  const freshRevision = getWorkspaceRevision(fresh);
  if (previousRevision > freshRevision) return previous;

  const previousSessions = Array.isArray(previous?.sessions) ? previous.sessions : [];
  const freshSessions = Array.isArray(fresh?.sessions) ? fresh.sessions : [];
  if (freshSessions.length === 0 && previousSessions.length > 0 && freshRevision === 0) {
    return previous;
  }

  const previousById = new Map(previousSessions.map((session) => [String(session?.id || ''), session]));
  const removals = getPendingSessionRemovalIds(agentId);
  const sessions = freshSessions
    .filter((session) => !removals.has(String(session?.id || '')))
    .map((session) => {
      const prior = previousById.get(String(session?.id || '')) || null;
      return prior ? { ...prior, ...session } : session;
    });

  return {
    ...previous,
    ...fresh,
    revision: Math.max(previousRevision, freshRevision),
    sessions,
  };
}

function applySessionMutationDelta(agentId, payload) {
  const delta = payload?.sessionDelta || payload?.deleted?.sessionDelta || null;
  if (!agentId || !delta) return false;
  const agent = Array.isArray(allAgents) ? allAgents.find((item) => item.id === agentId) : null;
  if (!agent) return false;
  const current = agent.workspace_sessions || { activeSessionId: null, sessions: [] };
  const currentRevision = getWorkspaceRevision(current);
  const nextRevision = Number(delta.revision ?? payload?.revision ?? payload?.deleted?.revision);
  if (Number.isSafeInteger(nextRevision) && nextRevision < currentRevision) return false;

  const removeIds = new Set(Array.isArray(delta.remove) ? delta.remove.map(String) : []);
  const upserts = Array.isArray(delta.upsert) ? delta.upsert.filter((session) => session?.id) : [];
  const upsertById = new Map(upserts.map((session) => [String(session.id), session]));
  const existing = Array.isArray(current.sessions) ? current.sessions : [];
  const sessions = existing
    .filter((session) => !removeIds.has(String(session?.id || '')))
    .map((session) => {
      const patch = upsertById.get(String(session?.id || ''));
      if (!patch) return session;
      upsertById.delete(String(session.id));
      return { ...session, ...patch };
    });
  for (const session of upsertById.values()) sessions.unshift(session);

  updateAgentRecord(agentId, {
    workspace_sessions: {
      ...current,
      sessions,
      activeSessionId: Object.hasOwn(delta, 'activeSessionId') ? delta.activeSessionId : current.activeSessionId,
      revision: Number.isSafeInteger(nextRevision) ? nextRevision : currentRevision,
    },
    active_workspace_session_id: Object.hasOwn(delta, 'activeSessionId')
      ? delta.activeSessionId
      : (agent.active_workspace_session_id || current.activeSessionId || null),
  });
  markSidebarAuthoritativeMutation();
  if (typeof lastRenderedWorkspaceHtml !== 'undefined') lastRenderedWorkspaceHtml = '';
  if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
  return true;
}

function applySidebarMutationDeltaWithDiagnostics(operationId, agentId, payload) {
  const startedAt = sidebarDiagnosticNow();
  const applied = applySessionMutationDelta(agentId, payload);
  recordSidebarOperationCheckpoint(operationId, 'response_applied', {
    clientApplyMs: sidebarDiagnosticNow() - startedAt,
  });
  return applied;
}
