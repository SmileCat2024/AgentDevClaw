#!/usr/bin/env node
/** Read-only, offline reconstruction; never imports session-store (which may repair data). */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveUserDataDir, WORKSPACE_SESSION_AGENT_IDS } from '../server/shared/constants.js';
import { renderTopology } from './session-topology/render.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const text = value => typeof value === 'string' ? value : '';
export const sessionKey = (agentId, sessionId) => JSON.stringify([agentId, sessionId]);
const safeFragment = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
function decode(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}
export function resultStatus(raw) {
  if (raw === undefined) return 'unknown';
  let value = raw;
  for (let i = 0; i < 5; i++) {
    value = decode(value);
    if (!value || typeof value !== 'object') return 'unknown';
    if (value.error || value.success === false || value.ok === false) return 'failed';
    if ('result' in value) { value = value.result; continue; }
    if (typeof value.text === 'string' && value.text.length) return 'success';
    return 'unknown';
  }
  return 'unknown';
}

/** Only trusted message locations, never IDs inside quoted transcripts or tool results. */
export function extractObservations(messages) {
  const observations = [];
  const results = new Map(messages.filter(m => m.role === 'tool' && m.toolCallId).map(m => [m.toolCallId, m.content]));
  const ordinals = new Map();
  let userAnchor = '';
  const emit = (value, fingerprint) => {
    const ordinal = ordinals.get(fingerprint) || 0;
    ordinals.set(fingerprint, ordinal + 1);
    observations.push({ ...value, fingerprint: `${fingerprint}:${ordinal}` });
  };
  for (const [messageIndex, m] of messages.entries()) {
    if (m.role === 'user') userAnchor = hash(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    if (m.role === 'system' && m.source === 'session-reference' && text(m.content).startsWith('[会话引用]')) {
      for (const line of m.content.split('\n')) {
        // Both current agentId: and the historical agent: agent/type reminder form.
        const match = line.match(/^-\s+(\S+?)(?:「(.*?)」)?\s+—\s+(agentId|agent):\s*([^\s（(]+)/)
          || (() => { const old = line.match(/^-\s+(\S+?)(?:「(.*?)」)?\s+\(([^/\s)]+)\/[^)]+\)/); return old ? [old[0], old[1], old[2], 'agent', old[3]] : null; })();
        if (!match) continue;
        const targetAgent = match[3] === 'agent' ? match[4].split('/')[0] : match[4];
        emit({ kind: 'reference', targetAgent, targetId: match[1], titleHint: match[2] || '',
          status: 'declared', turn: m.turn ?? null, messageIndex, evidence: 'session-reference reminder' },
        hash(JSON.stringify(['reference', targetAgent, match[1], userAnchor])));
      }
    }
    if (m.role !== 'assistant') continue;
    for (const [callIndex, call] of (m.toolCalls || []).entries()) {
      const name = text(call.name).replace(/^functions\./, '');
      if (name !== 'session_read_overview' && name !== 'session_read_turn') continue;
      const args = decode(call.arguments ?? call.args) || {};
      if (!text(args.sessionId)) continue;
      emit({ kind: name === 'session_read_turn' ? 'read-turn' : 'read-overview',
        targetAgent: text(args.agentId), targetId: args.sessionId, status: resultStatus(results.get(call.id)),
        targetTurn: args.turn ?? null, turn: m.turn ?? null, messageIndex, callIndex,
        callId: text(call.id), evidence: name },
      hash(JSON.stringify([name, call.id || [userAnchor, args, callIndex]])));
    }
  }
  return observations;
}

async function entries(dir) {
  try { return (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

export async function collectTopology({ dataRoot, onProgress = () => {} }) {
  const startedAt = new Date().toISOString();
  const warnings = [];
  const files = [];
  async function readJson(file, optional = false) {
    try {
      const before = await fs.stat(file);
      const bytes = await fs.readFile(file);
      const after = await fs.stat(file);
      const relative = path.relative(dataRoot, file).replaceAll('\\', '/');
      files.push({ path: relative, bytes: bytes.length, mtimeMs: before.mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex') });
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) warnings.push({ kind: 'changed-during-read', file: relative });
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (!(optional && error.code === 'ENOENT')) warnings.push({ kind: 'read-error', file: path.relative(dataRoot, file), error: error.message });
      return null;
    }
  }
  const sessions = new Map();
  const observations = new Map();
  const lineage = [];
  const excluded = { orphanFiles: 0, noncanonicalStores: [], unsupportedSnapshots: 0, missingSnapshots: 0, remindersWithoutOriginalSource: 0 };
  const stores = [];
  const names = new Set();
  for (const folder of ['workspaces', 'prebuilt-sessions']) {
    for (const entry of await entries(path.join(dataRoot, folder))) if (entry.isDirectory()) names.add(entry.name);
  }
  for (const name of [...names].sort()) {
    const folder = WORKSPACE_SESSION_AGENT_IDS.has(name) ? path.join('workspaces', name, 'sessions') : path.join('prebuilt-sessions', name);
    stores.push({ agentId: name, folder });
    const other = WORKSPACE_SESSION_AGENT_IDS.has(name) ? path.join('prebuilt-sessions', name) : path.join('workspaces', name, 'sessions');
    if ((await entries(path.join(dataRoot, other))).some(f => f.name === 'index.json' || /^session-.*\.json$/.test(f.name))) excluded.noncanonicalStores.push(other);
  }
  for (const entry of await entries(path.join(dataRoot, 'agents'))) {
    if (entry.isDirectory()) stores.push({ agentId: `plain:${entry.name}`, folder: path.join('agents', entry.name, 'sessions') });
  }
  for (const store of stores) {
    const dir = path.join(dataRoot, store.folder);
    const listing = await entries(dir);
    const index = await readJson(path.join(dir, 'index.json'), true);
    if (index && !Array.isArray(index.sessions)) warnings.push({ kind: 'unsupported-index', file: store.folder });
    const records = Array.isArray(index?.sessions) ? index.sessions : [];
    const indexedIds = new Set(records.map(r => r.id));
    excluded.orphanFiles += listing.filter(f => f.isFile() && /^session-.*\.json$/.test(f.name) && !indexedIds.has(f.name.slice(0, -5))).length;
    if (records.length) onProgress(`[info] ${store.agentId}: ${records.length} indexed sessions`);
    for (const record of records) {
      if (!safeFragment(record.id)) { warnings.push({ kind: 'invalid-session-id', agentId: store.agentId }); continue; }
      const key = sessionKey(store.agentId, record.id);
      if (sessions.has(key)) { warnings.push({ kind: 'duplicate-index-entry', key }); continue; }
      const file = path.join(dir, `${record.id}.json`);
      const node = { id: key, agentId: store.agentId, sessionId: record.id,
        title: text(record.title) || record.id, createdAt: record.createdAt || '', updatedAt: record.updatedAt || '',
        archived: record.archived === true, directory: text(record.openDirectory), projectId: text(record.projectId),
        file: path.relative(dataRoot, file).replaceAll('\\', '/'), available: false };
      sessions.set(key, node);
      const metadata = record.metadata || {};
      if (metadata.sourceSessionId) lineage.push({ source: key,
        target: sessionKey(metadata.sourceAgentId || store.agentId, metadata.sourceSessionId),
        kind: metadata.resumeMode === 'compacted' ? 'continuation' : 'derived', evidence: 'index.metadata.sourceSessionId' });
      if (metadata.branchSourceSessionId) lineage.push({ source: key,
        target: sessionKey(metadata.branchSourceAgentId || store.agentId, metadata.branchSourceSessionId), kind: 'branch', evidence: 'index.metadata.branchSourceSessionId' });
      const snapshot = await readJson(file);
      if (!snapshot) { excluded.missingSnapshots++; continue; }
      const messages = snapshot.runtime?.context?.messages;
      if (!Array.isArray(messages)) { excluded.unsupportedSnapshots++; warnings.push({ kind: 'unsupported-snapshot', file: node.file, version: snapshot.version }); continue; }
      node.available = true;
      node.messageCount = messages.length;
      excluded.remindersWithoutOriginalSource += messages.filter(m => m.role === 'system' && m.source !== 'session-reference' && text(m.content).startsWith('[会话引用]')).length;
      observations.set(key, extractObservations(messages));
      if (sessions.size % 250 === 0) onProgress(`[info] scanned ${sessions.size} sessions`);
    }
  }
  const threadIndex = await readJson(path.join(dataRoot, 'threads/index.json'), true);
  const threadArchive = await readJson(path.join(dataRoot, 'threads/archive-index.json'), true);
  const threads = Array.isArray(threadIndex?.threads) ? threadIndex.threads : [];
  const membership = new Map();
  const conflicts = new Set();
  const threadMap = new Map();
  for (const t of threads) {
    if (!safeFragment(t.threadId)) continue;
    const agentId = t.workspaceId || t.agentId;
    threadMap.set(t.threadId, { ...t, agentId });
    for (const sid of t.sessionIds || []) {
      const key = sessionKey(agentId, sid);
      if (membership.has(key) && membership.get(key) !== t.threadId) conflicts.add(key);
      else membership.set(key, t.threadId);
    }
    // Index chainEdges are not guessed: detailed record gives explicit predecessor links.
    const detail = await readJson(path.join(dataRoot, 'threads/threads', `${t.threadId}.json`));
    for (const item of detail?.sessionChain || []) {
      if (item.successorSessionId) lineage.push({ source: sessionKey(agentId, item.successorSessionId),
        target: sessionKey(agentId, item.sessionId), kind: 'continuation', evidence: 'thread.sessionChain.successorSessionId' });
    }
  }
  for (const key of conflicts) { membership.delete(key); warnings.push({ kind: 'conflicting-thread-membership', key }); }
  const parents = new Map();
  const lineageUnique = new Map();
  for (const edge of lineage) {
    const id = JSON.stringify([edge.source, edge.target, edge.kind]);
    if (lineageUnique.has(id)) continue;
    lineageUnique.set(id, edge);
    if (edge.kind === 'continuation' || edge.kind === 'branch') {
      if (!parents.has(edge.source)) parents.set(edge.source, new Set());
      parents.get(edge.source).add(edge.target);
    }
  }
  const fingerprints = new Map([...observations].map(([key, values]) => [key, new Map(values.map(v => [v.fingerprint, v]))]));
  function ancestorOrigin(key, fingerprint, seen = new Set()) {
    if (seen.has(key)) return null;
    seen.add(key);
    for (const parent of parents.get(key) || []) {
      const older = ancestorOrigin(parent, fingerprint, seen);
      if (older) return older;
      if (fingerprints.get(parent)?.has(fingerprint)) return parent;
    }
    return null;
  }
  const events = new Map();
  let inheritedObservations = 0;
  for (const [key, values] of observations) for (const observation of values) {
    const origin = ancestorOrigin(key, observation.fingerprint) || key;
    if (origin !== key) inheritedObservations++;
    const id = hash(JSON.stringify([origin, observation.fingerprint]));
    let event = events.get(id);
    if (!event) {
      const original = fingerprints.get(origin)?.get(observation.fingerprint) || observation;
      event = { ...original, id, source: origin, observedIn: [] };
      delete event.fingerprint;
      events.set(id, event);
    }
    event.observedIn.push({ session: key, messageIndex: observation.messageIndex, turn: observation.turn });
  }
  const nodes = new Map();
  function conversation(key) {
    const threadId = membership.get(key);
    const id = threadId || key;
    if (!nodes.has(id)) {
      const session = sessions.get(key);
      const t = threadMap.get(threadId);
      nodes.set(id, { id, title: (t && sessions.get(sessionKey(t.agentId, t.headSessionId))?.title) || t?.title || session?.title || key, agentId: t?.agentId || session?.agentId || '',
        threadId: threadId || '', sessions: [], available: false, missing: !session,
        archived: threadId ? Boolean(threadArchive?.threads?.[threadId]) : session?.archived || false,
        createdAt: '', updatedAt: '' });
    }
    return id;
  }
  for (const [key, session] of sessions) {
    const node = nodes.get(conversation(key));
    node.sessions.push(key);
    node.available ||= session.available;
    if (!node.createdAt || session.createdAt < node.createdAt) node.createdAt = session.createdAt;
    if (!node.updatedAt || session.updatedAt > node.updatedAt) node.updatedAt = session.updatedAt;
    session.conversationId = node.id;
  }
  function resolveTarget(agentId, sid, hint = '') {
    if (sid.startsWith('wt-')) {
      const t = threadMap.get(sid);
      if (t) {
        const id = conversation(sessionKey(t.agentId, t.headSessionId));
        if (id === sid) return id;
      }
      if (!nodes.has(sid)) nodes.set(sid, { id: sid, threadId: sid, title: hint || sid, agentId: agentId || '', sessions: [], available: false, missing: true });
      return sid;
    }
    const key = sessionKey(agentId || '(unspecified)', sid);
    const id = conversation(key);
    if (!sessions.has(key) && !membership.has(key)) {
      const node = nodes.get(id);
      node.title = hint || sid; node.agentId = agentId || '(unspecified)';
    }
    return id;
  }
  const edges = new Map();
  function addEdge(source, target, kind, status, eventId) {
    const id = hash(JSON.stringify([source, target, kind, status]));
    if (!edges.has(id)) edges.set(id, { id, source, target, kind, status, count: 0, eventIds: [] });
    const edge = edges.get(id); edge.count++; if (eventId) edge.eventIds.push(eventId);
  }
  for (const event of events.values()) {
    event.sourceConversation = conversation(event.source);
    event.targetConversation = resolveTarget(event.targetAgent, event.targetId, event.titleHint);
    addEdge(event.sourceConversation, event.targetConversation, event.kind, event.status, event.id);
  }
  for (const edge of lineageUnique.values()) {
    const source = conversation(edge.source);
    const [agentId, sid] = JSON.parse(edge.target);
    const target = resolveTarget(agentId, sid);
    edge.sourceConversation = source; edge.targetConversation = target;
    if (source !== target) addEdge(source, target, edge.kind, 'structural', null);
  }
  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];
  const stats = { indexedSessions: sessions.size, readableSessions: [...sessions.values()].filter(s => s.available).length,
    threads: threads.length, conversations: nodeList.filter(n => !n.missing).length,
    unresolvedTargets: nodeList.filter(n => n.missing).length, observations: [...observations.values()].reduce((a, v) => a + v.length, 0),
    inheritedObservations, events: events.size, edges: edges.size, byKind: {}, byStatus: {}, excluded };
  for (const event of events.values()) {
    stats.byKind[event.kind] = (stats.byKind[event.kind] || 0) + 1;
    if (event.kind !== 'reference') stats.byStatus[event.status] = (stats.byStatus[event.status] || 0) + 1;
  }
  const active = new Set(edgeList.filter(e => e.source !== e.target && (e.kind === 'reference' || e.status === 'success')).flatMap(e => [e.source, e.target]));
  stats.connectedConversations = active.size;
  stats.byAgent = {};
  for (const session of sessions.values()) {
    const value = stats.byAgent[session.agentId] ||= { indexed: 0, readable: 0 };
    value.indexed++; value.readable += Number(session.available);
  }
  const referenceEdges = edgeList.filter(e => e.kind === 'reference' && e.source !== e.target);
  const adjacency = new Map();
  for (const edge of referenceEdges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source).add(edge.target); adjacency.get(edge.target).add(edge.source);
  }
  const visited = new Set(), components = [];
  for (const id of adjacency.keys()) {
    if (visited.has(id)) continue;
    const group = [], queue = [id]; visited.add(id);
    while (queue.length) {
      const current = queue.pop(); group.push(current);
      for (const next of adjacency.get(current)) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
    components.push(group);
  }
  stats.referenceGraph = { conversations: adjacency.size, edges: referenceEdges.length,
    internalEvents: [...events.values()].filter(e => e.kind === 'reference' && e.sourceConversation === e.targetConversation).length,
    unresolvedTargets: [...adjacency.keys()].filter(id => nodes.get(id)?.missing).length,
    components: components.sort((a, b) => b.length - a.length) };
  return { schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(),
    scope: 'Local indexed canonical workspace/prebuilt/plain stores, including archives. No remote traversal, backups, rollback history or orphan-file inference.',
    direction: 'source uses/references/derives from target (not chronology)', stats, warnings,
    nodes: nodeList, edges: edgeList, sessions: [...sessions.values()], events: [...events.values()], lineage: [...lineageUnique.values()], files };
}

export async function main(args = process.argv.slice(2)) {
  const options = { dataRoot: resolveUserDataDir(), out: path.resolve('.agentdev/session-topology') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log('node scripts/session-topology.mjs [--data-root PATH] [--out NEW_DIRECTORY]\nReads local indexed sessions only. Writes graph.json, index.html and summary.json; output must not exist.'); return; }
    const key = { '--data-root': 'dataRoot', '--out': 'out' }[args[i]];
    if (!key || !args[i + 1]) throw new Error(`Unknown/incomplete option: ${args[i]}`);
    options[key] = path.resolve(args[++i]);
  }
  const root = await fs.realpath(options.dataRoot);
  // Fresh output only: refuse overwriting artifacts or writing under the source store.
  await fs.mkdir(path.dirname(options.out), { recursive: true });
  const parent = await fs.realpath(path.dirname(options.out));
  const output = path.join(parent, path.basename(options.out));
  const relative = path.relative(root, output);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Output must be outside the source data root');
  await fs.mkdir(output);
  const graph = await collectTopology({ dataRoot: root, onProgress: console.log });
  await fs.writeFile(path.join(output, 'graph.json'), JSON.stringify(graph, null, 2));
  await fs.writeFile(path.join(output, 'index.html'), renderTopology(graph));
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify({ startedAt: graph.startedAt, finishedAt: graph.finishedAt, stats: graph.stats, warnings: graph.warnings }, null, 2));
  console.log(JSON.stringify({ output, stats: graph.stats, warnings: graph.warnings.length }, null, 2));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error('[error]', error.message); process.exitCode = 1; });
}
