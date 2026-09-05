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
    sessionType: operation?.sessionType || '',
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

// 会话身份解析：多身份工作空间（programming-helper 的 main / coder）共享
// 同一个宿主 agentId，operation 必须携带 sessionType 才能在侧栏按身份路由
// （宿主条目 vs 投影条目），否则占位会在两个条目下镜像。
// 优先级：显式传入 > allAgents 中该会话运行时的 sessionType（server 权威）>
// 线程宿主索引（coder 会话必有线程）> 默认 main。
function resolveSidebarOperationSessionType(agentId, sessionId, explicit = '') {
  const direct = String(explicit || '').trim();
  if (direct) return direct;
  const ownerAgentId = String(agentId || '').trim();
  const sourceSessionId = String(sessionId || '').trim();
  if (!ownerAgentId || !sourceSessionId) return 'main';
  if (typeof allAgents !== 'undefined' && Array.isArray(allAgents)) {
    const runtime = allAgents.find((item) => (
      item
      && item.source !== 'prebuilt'
      && String(item.parent_id || '').trim() === ownerAgentId
      && String(item.active_workspace_session_id || '').trim() === sourceSessionId
    ));
    const runtimeType = String(runtime?.sessionType || '').trim();
    if (runtimeType) return runtimeType;
  }
  if (typeof window !== 'undefined'
    && typeof window.isThreadHostAgentId === 'function'
    && window.isThreadHostAgentId(ownerAgentId, sourceSessionId)) {
    return 'coder';
  }
  return 'main';
}

function normalizeSidebarOperation(raw = {}) {
  const now = Date.now();
  const kind = String(raw.kind || raw.type || 'sidebar').trim() || 'sidebar';
  const operationId = String(raw.operationId || '').trim() || createSidebarOperationId(kind);
  const sourceSessionId = String(raw.sourceSessionId || raw.sessionId || '').trim();
  const agentId = String(raw.agentId || raw.ownerAgentId || '').trim();
  return {
    schemaVersion: 1,
    operationId,
    type: String(raw.type || (['summary', 'trim', 'branch'].includes(kind) ? 'replacement' : kind)).trim() || 'sidebar',
    kind,
    phase: String(raw.phase || 'requested').trim() || 'requested',
    agentId,
    sessionType: resolveSidebarOperationSessionType(agentId, sourceSessionId, raw.sessionType),
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

// Server snapshots (light snapshot / agent_detail) can lag behind a committed
// mutation: the create/activate sessionDelta already confirms the commit, but
// the next refresh payload may still omit the new session. Merging with the
// fresh list as the base would drop that entry — the sidebar shows the new
// session appear, vanish, then come back once the server catches up. Upserts
// registered here survive the merge until the fresh list echoes the id; a 60s
// TTL bounds the protection if the server never confirms.
const _pendingSessionUpserts = new Map();

function markPendingSessionUpsert(agentId, session) {
  if (!agentId || !session?.id) return;
  _pendingSessionUpserts.set(`${agentId}::${session.id}`, {
    agentId: String(agentId),
    sessionId: String(session.id),
    session,
    at: Date.now(),
  });
}

function retainPendingSessionUpserts(agentId, sessions) {
  if (_pendingSessionUpserts.size === 0) return sessions;
  const presentIds = new Set(sessions.map((session) => String(session?.id || '')));
  const retained = [];
  for (const [key, entry] of Array.from(_pendingSessionUpserts.entries())) {
    if (entry.agentId !== String(agentId || '')) continue;
    if (presentIds.has(entry.sessionId) || Date.now() - entry.at > 60000) {
      _pendingSessionUpserts.delete(key);
      continue;
    }
    retained.push(entry.session);
  }
  return retained.length > 0 ? [...retained, ...sessions] : sessions;
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

  // 追加段（sessionOffset > 0）：fresh 是列表更深处的切片（加载更多），
  // 不是 membership 权威——不能据此清理已加载条目。重复 id 意味着排序
  // 位移：已加载条目取 fresh 字段 patch（服务端较新），新条目按 id 去重
  // 后拼接。
  const freshOffset = Number(fresh?.sessionOffset);
  if (Number.isFinite(freshOffset) && freshOffset > 0) {
    const removals = getPendingSessionRemovalIds(agentId);
    const freshById = new Map(freshSessions.map((session) => [String(session?.id || ''), session]));
    const patchedPrevious = previousSessions
      .filter((session) => !removals.has(String(session?.id || '')))
      .map((session) => {
        const patch = freshById.get(String(session?.id || ''));
        return patch ? { ...session, ...patch } : session;
      });
    const previousIds = new Set(previousSessions.map((session) => String(session?.id || '')));
    const appended = freshSessions
      .filter((session) => !previousIds.has(String(session?.id || '')))
      .filter((session) => !removals.has(String(session?.id || '')));
    return {
      ...previous,
      ...fresh,
      revision: Math.max(previousRevision, freshRevision),
      sessions: [...patchedPrevious, ...appended],
    };
  }

  const previousById = new Map(previousSessions.map((session) => [String(session?.id || ''), session]));
  const removals = getPendingSessionRemovalIds(agentId);
  let sessions = freshSessions
    .filter((session) => !removals.has(String(session?.id || '')))
    .map((session) => {
      const prior = previousById.get(String(session?.id || '')) || null;
      return prior ? { ...prior, ...session } : session;
    });

  // 尾部保护：fresh 是 offset=0 的首屏切片（loadAgentDetail 重聚焦 / get_connected_agents
  // 每轮 poll），而已加载深层段（加载更多推进的）不应被截断。不能要求 revision 相等——
  // revision 被一切会话变更推进（含每轮对话的 meta 同步），活跃使用中几乎总在前进，相等
  // 条件会让本保护形同虚设。语义：fresh 声明 0..limit 范围权威，0..limit 段按 id patch，
  // 超出段去重后保留拼接；深层段的 membership 修正由范围 poll（limit=loadedCount，3s 周期）
  // 全域重授权兜底。
  if (Number.isFinite(Number(fresh?.sessionTotal))
    && Number(fresh?.sessionOffset) === 0
    && previousSessions.length > freshSessions.length) {
    const freshIds = new Set(sessions.map((session) => String(session?.id || '')));
    const tail = previousSessions
      .slice(freshSessions.length)
      .filter((session) => !freshIds.has(String(session?.id || '')) && !removals.has(String(session?.id || '')));
    sessions = [...sessions, ...tail];
  }

  return {
    ...previous,
    ...fresh,
    revision: Math.max(previousRevision, freshRevision),
    sessions: retainPendingSessionUpserts(agentId, sessions),
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
  upserts.forEach((session) => markPendingSessionUpsert(agentId, session));
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

  // 分页计数同步：新会话入列 / 会话移除时调整服务端总数投影，避免
  // “加载更多”在 poll 校正前（≤3s）按过期 total 重复拉取或提前收敛。
  // 仅乐观调整已存在的字段；下一次范围刷新会以服务端计数覆盖。
  let mainDelta = 0;
  let archivedDelta = 0;
  for (const session of upsertById.values()) {
    if (session?.archived === true) archivedDelta += 1; else mainDelta += 1;
  }
  const existingById = new Map(existing.map((session) => [String(session?.id || ''), session]));
  for (const id of removeIds) {
    const removed = existingById.get(id);
    if (removed?.archived === true) archivedDelta -= 1; else if (removed) mainDelta -= 1;
  }
  const netDelta = upsertById.size - removeIds.size;
  updateAgentRecord(agentId, {
    workspace_sessions: {
      ...current,
      sessions,
      activeSessionId: Object.hasOwn(delta, 'activeSessionId') ? delta.activeSessionId : current.activeSessionId,
      revision: Number.isSafeInteger(nextRevision) ? nextRevision : currentRevision,
      ...(Number.isFinite(Number(current.sessionTotal)) ? { sessionTotal: Number(current.sessionTotal) + netDelta } : {}),
      ...(Number.isFinite(Number(current.mainTotal)) ? { mainTotal: Number(current.mainTotal) + mainDelta } : {}),
      ...(Number.isFinite(Number(current.archivedTotal)) ? { archivedTotal: Number(current.archivedTotal) + archivedDelta } : {}),
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
