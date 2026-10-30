import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'claw-lifecycle-contract-'));
process.env.AGENTDEV_DATA_DIR = root;
const { setupSessionRoutes } = await import('../server/routes/session.js');
const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { getPrebuiltSessionFilePath, updateSessionIndex, readSessionIndex } = await import('../server/shared/session-access.js');
const { buildSessionTrimPreview, buildSessionTrimMessagePreview, estimatePreambleCharCount } = await import('../server/routes/session-helpers-pure.js');
const { FileSessionStore } = await import('@agentdevjs/core');
const { createAgentStartupFns } = await import('../server/routes/agent-startup.js');
const startup = createAgentStartupFns({});
after(async () => {
  const { closeAllSessionDbs } = await import('../server/shared/session-access.js');
  closeAllSessionDbs(); // Windows 下打开的 db 句柄会让 rm 报 EBUSY
  rm(root, { recursive: true, force: true });
});

function routes(extra) {
  const captured = new Map();
  const app = Object.fromEntries(['post', 'get', 'put', 'delete'].map(method => [method, (url, ...handlers) => captured.set(`${method} ${url}`, handlers.at(-1))]));
  const helpers = createSessionHelpers({});
  setupSessionRoutes(app, { json: () => () => {} }, {
    ...helpers, buildSessionTrimPreview, buildSessionTrimMessagePreview, estimatePreambleCharCount,
    requireAgentLight: async id => ({ id }),
    threadLifecycle: { findThreadBySession: async () => null },
    ...extra,
  });
  return async (method, url, data) => {
    let result;
    let error;
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { result = body; } };
    await captured.get(`${method} ${url}`)({ body: data, query: data }, response, err => { error = err; });
    if (error) throw error;
    return { status: response.statusCode, body: result };
  };
}

async function seed(id) {
  const agentId = 'lifecycle-fixture';
  const file = getPrebuiltSessionFilePath(agentId, id);
  await mkdir(path.dirname(file), { recursive: true });
  const snapshot = { sessionId: id, runtime: { initialized: true, callIndex: 0, callState: 'idle', featureStates: [], context: { messages: [{ role: 'user', turn: 0, content: 'hello' }, { role: 'assistant', turn: 0, content: 'done' }], enrichedMessages: [] } }, rollbackHistory: [] };
  await writeFile(file, JSON.stringify(snapshot));
  await updateSessionIndex(agentId, index => ({ ...index, sessions: [...index.sessions, { id, title: id }] }));
  return { agentId, sessionId: id, file, snapshot };
}

for (const action of ['delete', 'archive']) {
  test(`${action} route waits for final runtime write; failed retirement retains the session`, async () => {
    const source = await seed(`${action}-success`);
    const release = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const invoke = routes({ stopManagedAgent: async () => {
      entered.resolve();
      await release.promise;
      const store = new FileSessionStore(path.dirname(source.file));
      await store.save(source.sessionId, { ...source.snapshot, savedAt: 10 });
    } });
    const operation = invoke('post', `/protoclaw/prebuilt_sessions/${action}`, { ...source, responseMode: 'delta' });
    await entered.promise;
    try {
      assert.ok(await readFile(source.file));
      assert.equal((await readSessionIndex(source.agentId)).sessions.find(s => s.id === source.sessionId).archived, false);
      await assert.rejects(startup.startManagedAgent({ id: source.agentId }, source.sessionId), { code: 'session_operation_in_progress' });
      await assert.rejects(invoke('post', '/protoclaw/prebuilt_sessions/archive', source), { code: 'session_operation_in_progress' });
    } finally {
      release.resolve();
      await operation;
    }
    if (action === 'delete') {
      await assert.rejects(readFile(source.file), { code: 'ENOENT' });
      assert.equal((await readSessionIndex(source.agentId)).sessions.some(s => s.id === source.sessionId), false);
    } else {
      assert.equal(JSON.parse(await readFile(source.file)).savedAt, 10);
      assert.equal((await readSessionIndex(source.agentId)).sessions.find(s => s.id === source.sessionId).archived, true);
    }
    await assert.rejects(startup.startManagedAgent({ id: source.agentId }, source.sessionId), {
      code: action === 'delete' ? 'session_not_found' : 'session_archived',
    });
    const failed = await seed(`${action}-failure`);
    const reject = routes({ stopManagedAgent: async () => { throw new Error('save not confirmed'); } });
    await assert.rejects(reject('post', `/protoclaw/prebuilt_sessions/${action}`, failed), /save not confirmed/);
    assert.ok(await readFile(failed.file));
    assert.equal((await readSessionIndex(failed.agentId)).sessions.find(s => s.id === failed.sessionId).archived, false);
  });
}

test('branch rejects a changed preview without creating a new session or stopping its source', async () => {
  const source = await seed('branch-source');
  const invoke = routes({ stopManagedAgent: () => assert.fail('branch must not stop source') });
  const preview = await invoke('get', '/protoclaw/session_trim_preview', source);
  await writeFile(source.file, JSON.stringify({ ...source.snapshot, savedAt: 20 }));
  const before = await readSessionIndex(source.agentId);
  const result = await invoke('post', '/protoclaw/sessions/branch', {
    agentId: source.agentId, sourceSessionId: source.sessionId, cutMsgIndexEnd: 1,
    snapshotRevision: preview.body.snapshotRevision,
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'branch_preview_stale');
  assert.deepEqual(await readSessionIndex(source.agentId), before);
});
