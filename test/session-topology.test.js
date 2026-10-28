import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectTopology, extractObservations, resultStatus, sessionKey } from '../scripts/session-topology.mjs';
import { renderTopology } from '../scripts/session-topology/render.mjs';
import { projectTopology, selectTopologyNode } from '../scripts/session-topology/view-model.mjs';

const ref = (target = 'session-b', turn = 0) => ({ role: 'system', source: 'session-reference', turn,
  content: `[会话引用] 用户在本条消息中引用了以下会话：\n- ${target}「背景」 — agentId: programming-helper（身份: main）` });
const user = content => ({ role: 'user', content, turn: 0 });
const call = (id, target = 'session-b') => ({ role: 'assistant', turn: 0,
  toolCalls: [{ id, name: 'session_read_overview', arguments: { agentId: 'programming-helper', sessionId: target } }] });
const result = (id, payload) => ({ role: 'tool', toolCallId: id, content: JSON.stringify(payload) });

test('reference parser uses only source-tagged system messages, not embedded transcripts', () => {
  const m = ref();
  const observations = extractObservations([user('背景'), m, { ...m, source: 'memory' }, { ...m, role: 'tool' }, { ...m, role: 'assistant' }], 'programming-helper');
  assert.equal(observations.length, 1);
  assert.equal(observations[0].targetId, 'session-b');
  assert.equal(observations[0].targetAgent, 'programming-helper');
  assert.equal(observations[0].messageIndex, 1);
  const legacy = { ...m, content: m.content.replace(' — agentId: programming-helper（身份: main）', ' (programming-helper/main)') };
  assert.equal(extractObservations([legacy])[0].targetAgent, 'programming-helper');
  assert.equal(extractObservations([{ ...m, content: m.content.replace('agentId: programming-helper（身份: main）', 'agent: programming-helper/main') }])[0].targetAgent, 'programming-helper');
});

test('read success requires returned content; wrapped errors and absent results are not success', () => {
  assert.equal(resultStatus(JSON.stringify({ success: true, result: JSON.stringify({ text: 'history' }) })), 'success');
  assert.equal(resultStatus(JSON.stringify({ success: true, result: JSON.stringify({ error: 'missing' }) })), 'failed');
  assert.equal(resultStatus(undefined), 'unknown');
  assert.equal(resultStatus({ success: true }), 'unknown');
  const values = extractObservations([call('a'), result('a', { text: 'ok' }), call('b'), result('b', { error: 'missing' }), call('c')]);
  assert.deepEqual(values.map(v => v.status), ['success', 'failed', 'unknown']);
});

test('reference identity distinguishes different input turns without using mutable turn numbers', () => {
  const a = extractObservations([user('first'), ref(), user('second'), ref()]);
  assert.notEqual(a[0].fingerprint, a[1].fingerprint);
  const inherited = extractObservations([user('first'), ref('session-b', 15)]);
  assert.equal(a[0].fingerprint, inherited[0].fingerprint);
});

test('collects thread-level relations with exact session evidence and ancestor-only deduplication, read-only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-topology-'));
  const before = new Map();
  const put = async (rel, value) => {
    const file = path.join(root, rel); await fs.mkdir(path.dirname(file), { recursive: true });
    const content = JSON.stringify(value); await fs.writeFile(file, content); before.set(file, content);
  };
  try {
    const dir = 'workspaces/programming-helper/sessions';
    const records = [
      { id: 'session-a', title: 'origin', createdAt: '2026-01-01' },
      { id: 'session-a2', title: 'successor', metadata: { sourceSessionId: 'session-a', resumeMode: 'compacted' } },
      { id: 'session-b', title: 'background' },
      { id: 'session-c', title: 'independent' },
      { id: 'session-branch', title: 'branch', metadata: { branchSourceSessionId: 'session-a' } },
      { id: 'session-missing', title: 'missing' },
    ];
    await put(`${dir}/index.json`, { sessions: records });
    const inherited = [user('first'), ref(), call('call-origin'), result('call-origin', { text: 'history' })];
    for (const [id, messages] of [
      ['session-a', inherited], ['session-a2', [...inherited, user('new'), ref('session-b'), call('call-new', 'wt-b'), result('call-new', { text: 'thread' })]],
      ['session-b', []], ['session-c', [user('first'), ref()]], ['session-branch', inherited],
    ]) await put(`${dir}/${id}.json`, { runtime: { context: { messages } } });
    await put(`${dir}/session-orphan.json`, { runtime: { context: { messages: [ref()] } } });
    await put('threads/index.json', { threads: [
      { threadId: 'wt-a', workspaceId: 'programming-helper', title: 'one conversation', headSessionId: 'session-a2', sessionIds: ['session-a', 'session-a2'] },
      { threadId: 'wt-b', workspaceId: 'programming-helper', title: 'background conversation', headSessionId: 'session-b', sessionIds: ['session-b'] },
    ] });
    await put('threads/archive-index.json', { threads: { 'wt-b': { archivedAt: 1 } } });
    await put('threads/threads/wt-a.json', { sessionChain: [{ sessionId: 'session-a', successorSessionId: 'session-a2' }] });
    await put('threads/threads/wt-b.json', { sessionChain: [] });
    const graph = await collectTopology({ dataRoot: root });
    assert.equal(graph.stats.indexedSessions, 6);
    assert.equal(graph.stats.readableSessions, 5);
    assert.equal(graph.stats.excluded.orphanFiles, 1);
    assert.equal(graph.stats.inheritedObservations, 4);
    assert.equal(graph.stats.byKind.reference, 3, 'original + new user input + independent, not copied successor/branch');
    assert.equal(graph.stats.byStatus.success, 2);
    const edge = graph.edges.find(e => e.source === 'wt-a' && e.target === 'wt-b' && e.kind === 'reference');
    assert.equal(edge.count, 2);
    const threads = projectTopology(graph);
    assert.deepEqual(new Set(threads.nodes.map(n => n.id)), new Set(['wt-a', 'wt-b']));
    assert.equal(threads.edges.length, 1);
    assert.equal(threads.edges[0].count, 2, 'two sessions in one thread still yield one thread relation');
    assert.equal(threads.edges[0].eventIds.length, 2, 'individual reference evidence is preserved');
    assert.equal(threads.excludedEdges, 1, 'independent unowned session does not become a fake thread');
    assert.equal(projectTopology(graph, { level: 'mixed' }).edges.length, 2);
    assert.ok(graph.nodes.find(n => n.id === 'wt-b').archived);
    assert.ok(graph.edges.some(e => e.kind === 'branch'));
    assert.equal(graph.lineage.filter(e => e.kind === 'continuation').length, 1, 'index and thread evidence are not duplicate structural edges');
    const original = graph.events.find(e => e.kind === 'reference' && e.source === sessionKey('programming-helper', 'session-a'));
    assert.equal(original.observedIn.length, 3);
    assert.equal(original.targetId, 'session-b');
    for (const [file, content] of before) assert.equal(await fs.readFile(file, 'utf8'), content);
    assert.equal(graph.warnings.filter(w => w.kind === 'read-error').length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('selection can toggle off and switch without forcing a scope', () => {
  assert.equal(selectTopologyNode(null, 'wt-a'), 'wt-a');
  assert.equal(selectTopologyNode('wt-a', 'wt-a'), null);
  assert.equal(selectTopologyNode('wt-a', 'wt-b'), 'wt-b');
});

test('thread view excludes unresolved thread IDs and retains them in mixed view', () => {
  const graph = { nodes: [{ id: 'a', threadId: 'a' }, { id: 'b', threadId: 'b', missing: true }],
    edges: [{ source: 'a', target: 'b', kind: 'reference', count: 1 }] };
  assert.equal(projectTopology(graph).edges.length, 0);
  assert.equal(projectTopology(graph).excludedEdges, 1);
  assert.equal(projectTopology(graph, { level: 'mixed' }).edges.length, 1);
  assert.equal(projectTopology(graph, { isolated: true }).nodes.length, 1);
});

test('viewer embeds untrusted titles as JSON data, never executable markup', () => {
  const graph = { nodes: [{ title: '</script><script>alert(1)</script>' }] };
  const html = renderTopology(graph);
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('\\u003c/script>'));
  assert.ok(html.indexOf('value="reference"') < html.indexOf('value="knowledge"'), 'explicit references are the default');
});
