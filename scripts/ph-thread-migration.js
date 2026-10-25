import { createHash, randomUUID } from 'node:crypto';

const clean = (value) => typeof value === 'string' ? value.trim() : '';

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Build a deterministic migration plan from PH session-index records. */
export function buildPhThreadMigrationPlan(index, { makeThreadId = () => `wt-${randomUUID()}`, existingSessionIds = [], existingThreadMembership = [] } = {}) {
  if (!index || !Array.isArray(index.sessions)) {
    throw new TypeError('Session index must contain a sessions array');
  }

  const records = new Map();
  const duplicateIds = new Set();
  for (const raw of index.sessions) {
    const id = clean(raw?.id);
    if (!id || id === 'legacy') continue;
    if (records.has(id)) duplicateIds.add(id);
    else records.set(id, raw);
  }
  const duplicateAffected = new Set(duplicateIds);
  for (const id of duplicateIds) {
    for (const raw of index.sessions.filter((item) => clean(item?.id) === id)) {
      const metadata = raw?.metadata || {};
      const parentId = metadata.resumeMode === 'compacted' ? clean(metadata.sourceSessionId) : clean(metadata.branchSourceSessionId);
      if (parentId) duplicateAffected.add(parentId);
    }
    for (const [childId, child] of records) {
      if (clean(child?.metadata?.sourceSessionId) === id || clean(child?.metadata?.branchSourceSessionId) === id) duplicateAffected.add(childId);
    }
  }

  const existingMembers = new Set(existingSessionIds.map(clean).filter(Boolean));
  const included = new Map([...records].filter(([, record]) => record?.metadata?.resumeMode !== 'one-shot' && !existingMembers.has(clean(record?.id))));
  const skippedAlreadyThreadedSessionIds = [...records.keys()].filter((id) => existingMembers.has(id)).sort();
  const edges = [];
  const dangling = [];
  const branchRelations = [];
  const malformed = [];
  for (const [id, record] of included) {
    const metadata = record?.metadata || {};
    if (duplicateAffected.has(id)) continue;
    const branchSourceId = clean(metadata.branchSourceSessionId);
    // A branch is a new conversation/thread, not a succession member. The field can
    // coexist with inherited compacted metadata, so it takes precedence here.
    if (branchSourceId) {
      const sourcePresent = included.has(branchSourceId);
      branchRelations.push({ sourceSessionId: branchSourceId, sessionId: id, sourcePresent });
      if (!sourcePresent) dangling.push({ sourceSessionId: branchSourceId, sessionId: id, kind: 'branch' });
      continue;
    }
    if (metadata.resumeMode !== 'compacted') continue;
    const sourceId = clean(metadata.sourceSessionId);
    if (!sourceId) {
      malformed.push({ sessionId: id, reason: 'compacted_missing_source' });
      continue;
    }
    if (!included.has(sourceId)) {
      dangling.push({ sourceSessionId: sourceId, sessionId: id, kind: 'compacted' });
      continue;
    }
    const handoffMode = clean(metadata.handoffSummaryKind).toLowerCase();
    edges.push({ from: sourceId, to: id, kind: handoffMode.includes('summar') ? 'summary' : 'trim' });
  }

  const adjacency = new Map();
  const add = (a, b) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  };
  for (const edge of edges) { add(edge.from, edge.to); add(edge.to, edge.from); }

  for (const id of duplicateAffected) {
    if (!included.has(id)) continue;
    for (const [childId, child] of included) {
      if (clean(child?.metadata?.sourceSessionId) === id || clean(child?.metadata?.branchSourceSessionId) === id) add(id, childId);
    }
    const duplicateRecords = index.sessions.filter((item) => clean(item?.id) === id);
    for (const raw of duplicateRecords) {
      const metadata = raw?.metadata || {};
      const parentId = metadata.resumeMode === 'compacted' ? clean(metadata.sourceSessionId) : clean(metadata.branchSourceSessionId);
      if (parentId && included.has(parentId)) add(id, parentId);
    }
  }

  const components = [];
  const seen = new Set();
  for (const id of included.keys()) {
    if (seen.has(id)) continue;
    const stack = [id];
    const component = [];
    seen.add(id);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    components.push(component);
  }

  for (const id of duplicateAffected) {
    if (!included.has(id) || adjacency.has(id)) continue;
    components.push([id]);
  }

  const groups = [];
  const ambiguous = [];
  for (const item of malformed) {
    if (!adjacency.has(item.sessionId)) components.push([item.sessionId]);
  }

  for (const component of components) {
    const members = new Set(component);
    const componentEdges = edges.filter((edge) => members.has(edge.from) && members.has(edge.to));
    const outgoing = new Map();
    const incoming = new Map();
    for (const edge of componentEdges) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      outgoing.get(edge.from).push(edge);
      incoming.get(edge.to).push(edge);
    }
    const reasons = [];
    if (component.some((member) => duplicateAffected.has(member))) reasons.push('duplicate_session_id');
    if (componentEdges.some((edge) => (outgoing.get(edge.from)?.length || 0) > 1)) reasons.push('multiple_successors');
    if (componentEdges.some((edge) => (incoming.get(edge.to)?.length || 0) > 1)) reasons.push('multiple_predecessors');
    const componentDangling = dangling.filter((item) => members.has(item.sessionId));
    const componentMalformed = malformed.filter((item) => members.has(item.sessionId));
    if (componentDangling.length) reasons.push('dangling_source');
    if (componentMalformed.length) reasons.push(...componentMalformed.map((item) => item.reason));

    const roots = component.filter((member) => !(incoming.get(member)?.length));
    if (roots.length !== 1) reasons.push(roots.length === 0 ? 'cycle' : 'multiple_roots');

    let ordered = [];
    if (!reasons.length) {
      let current = roots[0];
      const visited = new Set();
      while (current && !visited.has(current)) {
        ordered.push(current);
        visited.add(current);
        current = outgoing.get(current)?.[0]?.to;
      }
      if (visited.size !== component.length) reasons.push('cycle_or_disconnected');
    }

    if (reasons.length) {
      ambiguous.push({ sessionIds: [...component].sort(), reasons: [...new Set(reasons)], dangling: componentDangling, malformed: componentMalformed });
      continue;
    }

    const groupEdges = ordered.slice(1).map((sessionId, i) => ({
      from: ordered[i], to: sessionId, kind: outgoing.get(ordered[i])[0].kind,
    }));
    groups.push({ threadId: makeThreadId(), sessionIds: ordered, edges: groupEdges });
  }

  const oneShotIds = new Set([...records].filter(([, record]) => record?.metadata?.resumeMode === 'one-shot').map(([id]) => id));
  const planEligibleCount = included.size + skippedAlreadyThreadedSessionIds.length + oneShotIds.size;
  const plan = {
    schemaVersion: 1,
    agentId: 'programming-helper',
    sourceRevision: Number(index.revision) || 0,
    sourceHash: stableHash(index),
    generatedAt: new Date().toISOString(),
    includedSessionCount: included.size,
    eligibleSessionIds: [...included.keys()].sort(),
    planEligibleCount,
    excludedOneShotSessionIds: [...records].filter(([, record]) => record?.metadata?.resumeMode === 'one-shot').map(([id]) => id).sort(),
    skippedAlreadyThreadedSessionIds,
    existingThreadMembership: existingThreadMembership.map((item) => ({ ...item })),
    branchOrigins: branchRelations.map((item) => ({ ...item })),
    groups,
    ambiguous,
    summary: {
      threadCount: groups.length,
      memberCount: groups.reduce((sum, group) => sum + group.sessionIds.length, 0),
      singletonCount: groups.filter((group) => group.sessionIds.length === 1).length,
      multiSessionThreadCount: groups.filter((group) => group.sessionIds.length > 1).length,
      ambiguousComponentCount: ambiguous.length,
      danglingEdgeCount: dangling.length,
    },
  };
  return { ...plan, planHash: stableHash(plan) };
}

export function materializeThreadRecord(group, index, { now = Date.now } = {}) {
  const byId = new Map((index.sessions || []).map((record) => [clean(record?.id), record]));
  const ids = group.sessionIds;
  const timestamp = now();
  const sessionChain = ids.map((sessionId, i) => {
    const next = group.edges[i]?.to || null;
    const edge = i < ids.length - 1 ? group.edges[i] : null;
    const record = byId.get(sessionId);
    const startedAt = Date.parse(record?.createdAt || '') || timestamp;
    const successor = next ? byId.get(next) : null;
    const endedAt = edge
      ? (Date.parse(successor?.metadata?.handoffCreatedAt || '') || Date.parse(successor?.createdAt || '') || startedAt)
      : null;
    return {
      sessionId,
      role: i === ids.length - 1 ? 'head' : 'predecessor',
      startedAt,
      endedAt,
      endKind: edge?.kind || null,
      successorSessionId: next,
    };
  });
  const root = byId.get(ids[0]);
  const head = byId.get(ids.at(-1));
  return {
    threadId: group.threadId,
    agentId: 'programming-helper',
    workspaceId: 'programming-helper',
    // Migration only establishes continuity membership. Per the current host contract,
    // identity is not inferred from session index metadata.
    title: clean(head?.title || root?.title),
    status: 'open',
    identity: null,
    rootSessionId: ids[0],
    headSessionId: ids.at(-1),
    sessionChain,
    commands: [],
    pendingSuccession: null,
    hold: false,
    lifecycleEvents: [],
    lastLifecycleEvent: null,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
