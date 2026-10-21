import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CapabilityShellFeature } from '../src/coder-shell-feature.js';

it('real HTTP: receipt → autonomous observer → explicit-session reminder, no extra model polling', async (t) => {
  let submitted = false;
  let eventReads = 0;
  const notices: any[] = [];
  let resolveNotice: () => void;
  const delivered = new Promise<void>((resolve) => { resolveNotice = resolve; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url.endsWith('/commands')) {
      submitted = true;
      res.end(JSON.stringify({ ok: true, command: { commandId: 'c1' }, delivery: { delivered: 1 } }));
    } else if (req.url.includes('/events')) {
      const events = submitted && ++eventReads > 1 ? [{ type: 'turn.completed', sourceRef: 'c1', sessionId: 's1', turn: 0 }] : [];
      res.end(JSON.stringify({ ok: true, events, cursor: events.length, baseOffset: 0 }));
    } else if (req.url.endsWith('/user-turn')) {
      notices.push({ url: req.url, body });
      res.end(JSON.stringify({ success: true, delivery: 'queued' }));
      resolveNotice();
    } else res.end(JSON.stringify({ ok: true, thread: { threadId: 'wt1', headSessionId: 's1',
      lifeState: 'idle', status: 'open', headRuntimeRunning: true,
      commands: [{ commandId: 'c1', source: 'coder_shell', status: 'delivered' }] } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as any).port;
  const origin = `http://127.0.0.1:${port}`;
  // Both HTTP destinations use the actual transport; the viewer port is test-local.
  const oldPort = process.env.AGENTDEV_VIEWER_PORT;
  process.env.AGENTDEV_VIEWER_PORT = String(port);
  const feature = new CapabilityShellFeature({ serverOrigin: origin, sessionId: 'parent-session', pollIntervalMs: 1 });
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
  assert.match(String(await tool.execute({ command: 'watch wt1 --command=c1' })), /reason=completed/);
  assert.equal(await feature.standby(), 'continue');
});
