import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import { setupFeatureCommunicationRoutes } from '../server/routes/feature-communication.js';
import { FeatureCommunicationStore } from '../server/feature-communication-store.js';
import { managedAgents } from '../server/shared/agent-access.js';

function makeApp() {
  const routes = {};
  return { routes, post(path, ...handlers) { routes[`POST ${path}`] = handlers; }, get(path, ...handlers) { routes[`GET ${path}`] = handlers; } };
}
function res() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
}

describe('feature communication routes', () => {
  it('accepts feature snapshots only from an internal authenticated request and publishes the exact runtime scope', async () => {
    const app = makeApp();
    const emitted = [];
    const store = setupFeatureCommunicationRoutes(app, { json: () => (_req, _res, next) => next() }, { communicationStore: new FeatureCommunicationStore() });
    const child = new EventEmitter();
    child.exitCode = null;
    child.send = () => true;
    managedAgents.set('comms-agent::comms-session', { agentId: 'comms-agent', selectedSessionId: 'comms-session', process: child, stopped: false });
    try {
      const handler = app.routes['POST /protoclaw/feature-comms/publish'].at(-1);
      const response = res();
      await handler({ auth: { kind: 'internal' }, body: { agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1', kind: 'snapshot', data: { status: 'running' } } }, response);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.revision, 1);
      assert.deepEqual(store.getSnapshot({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1' }).data, { status: 'running' });

      const denied = res();
      await handler({ auth: { kind: 'session' }, body: { agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1', kind: 'snapshot', data: {} } }, denied);
      assert.equal(denied.statusCode, 403);
    } finally {
      managedAgents.delete('comms-agent::comms-session');
    }
  });

  it('serves a channel-scoped SSE snapshot and live events, then releases its subscription', async (t) => {
    const app = express();
    app.use((req, _res, next) => { req.auth = { kind: 'session' }; next(); });
    const store = new FeatureCommunicationStore({ eventLimit: 2 });
    const storeRoutes = setupFeatureCommunicationRoutes(app, express, { communicationStore: store });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.close(); server.closeAllConnections?.(); });
    const target = { agentId: 'stream-agent', sessionId: 'stream-session', featureId: 'shell', channelId: 'task-1' };
    store.publishSnapshot(target, { state: 'running' });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/protoclaw/feature-comms/stream?${new URLSearchParams(target)}`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const pump = (async () => {
      try { while (true) { const { value, done } = await reader.read(); if (value) text += decoder.decode(value, { stream: true }); if (done) break; } } catch {}
    })();
    const waitFor = async (needle) => {
      const until = Date.now() + 1000;
      while (!text.includes(needle) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(text.includes(needle), `expected SSE frame containing ${needle}`);
    };
    try {
      await waitFor('"state":"running"');
      store.publishEvent(target, 'output', { text: 'line-1' });
      await waitFor('"text":"line-1"');
      assert.equal(store.listeners.size, 1);
    } finally {
      controller.abort();
      await pump;
    }
    const cleanupDeadline = Date.now() + 250;
    while (store.listeners.size && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(store.listeners.size, 0);
  });

  it('routes panel requests only to the exact session runtime', async () => {
    const app = makeApp();
    const child = new EventEmitter();
    child.exitCode = null;
    child.sent = [];
    child.send = (message) => { child.sent.push(message); return true; };
    managedAgents.set('comms-agent::comms-session', { agentId: 'comms-agent', selectedSessionId: 'comms-session', process: child, stopped: false });
    try {
      setupFeatureCommunicationRoutes(app, { json: () => (_req, _res, next) => next() }, { communicationStore: new FeatureCommunicationStore({ requestTimeoutMs: 100 }) });
      const handler = app.routes['POST /protoclaw/feature-comms/request'].at(-1);
      const response = res();
      const request = handler({ auth: { kind: 'session' }, body: { agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1', requestType: 'stop', payload: {} } }, response);
      assert.equal(child.sent[0].__targetSessionId, 'comms-session');
      child.emit('message', { type: 'feature-comms-result', requestId: child.sent[0].requestId, sessionId: 'other-session', result: { ok: true } });
      child.emit('message', { type: 'feature-comms-result', requestId: child.sent[0].requestId, sessionId: 'comms-session', result: { ok: true } });
      await request;
      assert.deepEqual(response.body, { ok: true, result: { ok: true } });
    } finally {
      managedAgents.delete('comms-agent::comms-session');
    }
  });
});
