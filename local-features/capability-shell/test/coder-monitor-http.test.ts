import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CapabilityShellFeature } from '../src/coder-shell-feature.js';
import { runCapabilityShellPipeline } from '../src/tool-factory.js';
import { createCoderShellPolicy } from '../src/coder-policy.js';
import { createThreadsAdapters } from '../src/coder-shell.js';

for (const succession of [false, true]) {
it(`real HTTP: receipt → autonomous observer → explicit-session reminder (succession=${succession})`, { timeout: 2_000 }, async (t) => {
  let submitted = false;
  const panelRequests: any[] = [];
  let eventReads = 0;
  const notices: any[] = [];
  let resolveNotice: () => void;
  const delivered = new Promise<void>((resolve) => { resolveNotice = resolve; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/protoclaw/feature-comms/')) {
      panelRequests.push(body);
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, code: 'projection_offline' }));
    } else if (req.method === 'POST' && req.url.endsWith('/commands')) {
      submitted = true;
      res.end(JSON.stringify({ ok: true, command: { commandId: 'c1' }, delivery: { delivered: 1 } }));
    } else if (req.url.includes('/events')) {
      const finished = submitted && ++eventReads > 1;
      const history = succession ? [
        { type: 'turn.started', sourceRef: 'c1', sessionId: 's1', turn: 5 },
        ...(finished ? [
          { type: 'turn.started', sourceRef: 'next', sessionId: 's2', turn: 106 },
          { type: 'item.completed', sessionId: 's2', item: { type: 'agent_message', text: 'successor report', turn: 106 } },
          { type: 'turn.completed', sourceRef: 'next', sessionId: 's2', turn: 106 },
        ] : []),
      ] : finished ? [{ type: 'turn.completed', sourceRef: 'c1', sessionId: 's1', turn: 0 }] : [];
      const after = Number(new URL(req.url, 'http://test').searchParams.get('after')) || 0;
      res.end(JSON.stringify({ ok: true, events: history.slice(after), cursor: history.length, baseOffset: 0 }));
    } else if (req.url.endsWith('/user-turn')) {
      notices.push({ url: req.url, body });
      res.end(JSON.stringify({ success: true, delivery: 'queued' }));
      resolveNotice();
    } else res.end(JSON.stringify({ ok: true, thread: { threadId: 'wt1', headSessionId: succession ? 's2' : 's1',
      lifeState: 'idle', status: 'open', headRuntimeRunning: true,
      sessionChain: succession ? [{ sessionId: 's1' }, { sessionId: 's2' }] : [{ sessionId: 's1' }],
      commands: [{ commandId: 'c1', source: 'coder_shell', status: 'delivered' },
        ...(succession ? [{ commandId: 'next', kind: 'system_continuation', idempotencyKey: 'succession:wt1:s1', status: 'delivered' }] : [])] } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const origin = `http://127.0.0.1:${port}`;
  // Both HTTP destinations use the actual transport; the viewer port is test-local.
  const oldPort = process.env.AGENTDEV_VIEWER_PORT;
  process.env.AGENTDEV_VIEWER_PORT = String(port);
  const feature = new CapabilityShellFeature({ serverOrigin: origin, agentId: 'parent', sessionId: 'parent-session', pollIntervalMs: 1, panel: true });
  t.after(async () => {
    await feature.onDestroy();
    if (oldPort === undefined) delete process.env.AGENTDEV_VIEWER_PORT;
    else process.env.AGENTDEV_VIEWER_PORT = oldPort;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const [tool] = await feature.getAsyncTools({ agentId: 'viewer-parent' } as any);
  assert.match(String(await tool.execute({ command: "send wt1 key 'do work'" })), /sent c1/);
  await delivered;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].url, '/api/agents/viewer-parent/user-turn');
  assert.equal(notices[0].body.sessionId, 'parent-session');
  assert.equal(notices[0].body.kind, 'reminder');
  assert.deepEqual(notices[0].body.metadata['claw-coder-dispatch'].workIds, ['wt1/c1']);
  assert.match(notices[0].body.sourceRef, /^claw-coder-dispatch-evt-/);
  assert.match(notices[0].body.text, /completed/);
  if (succession) assert.match(notices[0].body.text, /successor report/);
  assert.match(String(await tool.execute({ command: 'watch wt1 --command=c1' })), /reason=completed/);
  assert.equal(await feature.standby(), 'continue');
  assert.ok(panelRequests.length > 0);
  const list = await feature.onHostRequest('list');
  assert.equal((list.tasks as any[])[0].status, 'completed');
  assert.deepEqual(await feature.onHostRequest('kill'), { ok: false, code: 'operation_unavailable' });
  assert.deepEqual(await feature.onHostRequest('report'), { ok: false, code: 'operation_unavailable' });
});
}

it('Coder feature: Bash loop keeps independent monitor/panel items and defers standby until tool return', async (t) => {
  let next = 0;
  const feature = new CapabilityShellFeature({ sessionId: 'parent-session', agentId: 'parent',
    serverOrigin: 'http://test', pollIntervalMs: 60_000, panel: true, deliver: async () => {},
    fetchImpl: async (url) => {
      const threadId = url.split('/threads/')[1]?.split('/')[0];
      const payload = url.endsWith('/commands') ? { ok: true, command: { commandId: `c-${++next}` } }
        : url.includes('/events') ? { ok: true, events: [], cursor: 0, baseOffset: 0 }
          : { ok: true, thread: { threadId, status: 'open', lifeState: 'idle', headRuntimeRunning: true,
            commands: [{ commandId: threadId === 'wt-a' ? 'c-1' : 'c-2', source: 'coder_shell' }] } };
      return { ok: true, status: 200, json: async () => payload };
    } });
  t.after(() => feature.onDestroy());
  const [tool] = await feature.getAsyncTools({ agentId: 'viewer' } as any);
  const output = String(await tool.execute({ command: `
    for thread in wt-a wt-b; do
      send "$thread" "batch-$thread" 'independent work'
      watch "$thread"
    done` }));
  assert.equal(next, 2);
  assert.match(output, /sent c-1/);
  assert.match(output, /sent c-2/);
  const projection = await feature.onHostRequest('list');
  assert.deepEqual((projection.tasks as any[]).map((task) => task.id), ['wt-a/c-1', 'wt-b/c-2']);
  assert.equal(await feature.standby(), 'deny');
  assert.equal(await feature.standby(), 'continue');
});

it('real HTTP: Bash for dispatches distinct receipts; watch inside loop never truncates remaining sends', async (t) => {
  const submissions: any[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url.endsWith('/commands')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const threadId = req.url.split('/')[3];
      submissions.push({ threadId, ...body });
      res.end(JSON.stringify({ ok: true, command: { commandId: `c-${threadId}` }, delivery: { delivered: 1 } }));
    } else {
      const threadId = req.url.split('/')[3];
      res.end(JSON.stringify({ ok: true, thread: { commands: [{ commandId: `c-${threadId}`, source: 'coder_shell' }] } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  let standbyRequests = 0;
  const observed: string[] = [];
  const adapters = createThreadsAdapters({ serverOrigin: `http://127.0.0.1:${(server.address() as any).port}`,
    monitor: { observe: async (identity) => { observed.push(identity.threadId); return 'monitoring'; },
      isObserving: () => true } as any,
    access: { requestStandby: () => { standbyRequests++; } } as any });
  const result = await runCapabilityShellPipeline(createCoderShellPolicy(), `
    for thread in wt-a wt-b; do
      send "$thread" "batch-$thread" "work $thread" && watch "$thread"
    done`, { adapters });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(submissions.map((submission) => [submission.threadId, submission.idempotencyKey, submission.text]),
    [['wt-a', 'batch-wt-a', 'work wt-a'], ['wt-b', 'batch-wt-b', 'work wt-b']]);
  assert.deepEqual(observed, ['wt-a', 'wt-a', 'wt-b', 'wt-b']);
  assert.equal(standbyRequests, 2);
  assert.match(result.output, /sent c-wt-a/);
  assert.match(result.output, /sent c-wt-b/);
});
