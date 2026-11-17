import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ViewerWorker } from '@agentdevjs/viewer';
import { WorkThreadRuntimeBridge } from '@agentdevjs/core';
import { createThreadControl } from '../../server/thread-control/thread-controller.js';
import { setupThreadRoutes } from '../../server/thread-control/thread-routes.js';

test('manual head route commits despite stop failure; old Viewer slot can still claim unresolved input', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-retirement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inherited = process.env.AGENTDEV_VIEWER_ADDR;
  delete process.env.AGENTDEV_VIEWER_ADDR;
  let viewer;
  try { viewer = new ViewerWorker(0, false, path.join(root, 'unused.sock'), { queuedInputStoreDir: root }); }
  finally { if (inherited !== undefined) process.env.AGENTDEV_VIEWER_ADDR = inherited; }
  const bridge = new WorkThreadRuntimeBridge({ enabled: true,
    resolveRuntimeViewerId: () => 'old-runtime', submitTurn: async p => {
      const { kind: _kind, ...input } = p;
      const result = viewer.submitUserTurn(p.agentId, input);
      assert.equal(result.success, true, JSON.stringify(result));
      return result;
    } });
  const data = path.join(root, 'threads');
  const control = createThreadControl({ rootDir: data, bridge });
  const thread = await control.core.start({ sessionRef: { agentId: 'retirement-host', sessionId: 'old' } });
  viewer.udsClients.set('client', { write() {}, destroy() {} });
  viewer.handleRegisterAgent({ type: 'register-agent', agentId: 'old-runtime', name: 'retirement replay',
    runtimeInstanceId: 'old-incarnation', threadId: thread.threadId, headGeneration: 1, workSessionId: 'old' }, 'client');
  const { command } = await control.core.appendCommand({ threadId: thread.threadId, text: 'still on old runtime' });
  assert.equal((await control.core.deliverPendingCommands(thread.threadId)).delivered, 1);
  const routes = {};
  const app = { get(p, ...h) { routes[`GET ${p}`] = h; }, post(p, ...h) { routes[`POST ${p}`] = h; } };
  let stopAttempts = 0;
  setupThreadRoutes(app, { json: () => () => {} }, { control,
    ensureHeadRuntime: async () => ({ ok: true }), adoptHeadIdentity: async () => ({ ok: true }),
    stopManagedAgent: async () => { stopAttempts++; throw new Error('injected retire failure'); } });
  const handler = routes['POST /protoclaw/threads/:threadId/head'].at(-1);
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await handler({ params: { threadId: thread.threadId }, body: { fromSessionId: 'old', toSessionId: 'new' }, query: {} }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(stopAttempts, 1);
  assert.equal(res.body.thread.headSessionId, 'new');
  assert.equal(res.body.unresolved[0].commandId, command.commandId);
  const claim = viewer.claimCommandInput('old-runtime');
  assert.equal(claim.inputLease.commandId, command.commandId);
  const reloaded = createThreadControl({ rootDir: data, bridge: new WorkThreadRuntimeBridge({ enabled: false }) });
  assert.equal((await reloaded.core.getThread(thread.threadId)).headSessionId, 'new');
  console.log('OBSERVATION retirement:', JSON.stringify({ routeAccepted: true, oldClaimAccepted: true, unresolved: 1 }));
  if (process.env.REQUIRE_RETIRED_RUNTIME_FENCE === '1') {
    assert.equal(claim, null, 'retired runtime must not acquire work already assigned to unresolved recovery');
  }
});
