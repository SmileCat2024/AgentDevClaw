import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import express from 'express';
import { setupFeatureCommunicationRoutes } from '../server/routes/feature-communication.js';
import { FeatureCommunicationStore } from '../server/feature-communication-store.js';
import { managedAgents } from '../server/shared/agent-access.js';
import { getInternalAuthToken, setAuthEnabledForTest } from '../server/auth.js';

function makeApp() {
  const routes = {};
  return { routes, post(path, ...handlers) { routes[`POST ${path}`] = handlers; }, get(path, ...handlers) { routes[`GET ${path}`] = handlers; } };
}
function res() {
  return { statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
}
// Runtime calls carry the process bearer token; browser calls carry nothing
// until host auth is enabled. Handlers are invoked the way the real express
// pipeline would: no synthetic req.auth field.
function internalReq(body) {
  return { headers: { authorization: `Bearer ${getInternalAuthToken()}` }, body };
}
function browserReq(body) {
  return { headers: {}, body };
}
function registerRuntime() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.send = () => true;
  managedAgents.set('comms-agent::comms-session', { agentId: 'comms-agent', selectedSessionId: 'comms-session', process: child, stopped: false });
  return child;
}

describe('feature communication routes', () => {
  it('declares channels from internal-token requests on live runtimes only', async () => {
    const app = makeApp();
    const store = setupFeatureCommunicationRoutes(app, { json: () => (_req, _res, next) => next() }, { communicationStore: new FeatureCommunicationStore() });
    registerRuntime();
    try {
      const handler = app.routes['POST /protoclaw/feature-comms/declare'].at(-1);
      const response = res();
      await handler(internalReq({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1', title: 'Background tasks' }), response);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.declaration.title, 'Background tasks');
      assert.equal(store.isDeclared({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1' }), true);

      const denied = res();
      await handler(browserReq({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-2' }), denied);
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.body.code, 'internal_only');

      const missingRuntime = res();
      await handler(internalReq({ agentId: 'comms-agent', sessionId: 'no-such-session', featureId: 'shell', channelId: 'task-3' }), missingRuntime);
      assert.equal(missingRuntime.statusCode, 404);
    } finally {
      managedAgents.delete('comms-agent::comms-session');
    }
  });

  it('accepts feature snapshots only from internal-token requests and publishes the exact runtime scope', async () => {
    const app = makeApp();
    const store = setupFeatureCommunicationRoutes(app, { json: () => (_req, _res, next) => next() }, { communicationStore: new FeatureCommunicationStore() });
    registerRuntime();
    try {
      store.declareChannel({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1' });
      const handler = app.routes['POST /protoclaw/feature-comms/publish'].at(-1);
      const response = res();
      await handler(internalReq({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1', kind: 'snapshot', data: { status: 'running' } }), response);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.revision, 1);
      assert.deepEqual(store.getSnapshot({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1' }).data, { status: 'running' });

      const denied = res();
      await handler(browserReq({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1', kind: 'snapshot', data: {} }), denied);
      assert.equal(denied.statusCode, 403);

      const undeclared = res();
      await handler(internalReq({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'undeclared', kind: 'snapshot', data: {} }), undeclared);
      assert.equal(undeclared.statusCode, 404);
      assert.equal(undeclared.body.code, 'channel_not_declared');
    } finally {
      managedAgents.delete('comms-agent::comms-session');
    }
  });

  it('serves a channel-scoped SSE snapshot and live events, then releases its subscription', async (t) => {
    // No synthetic auth middleware: with host auth disabled the real pipeline
    // never sets req.auth, and the stream must still serve the browser.
    const app = express();
    const store = new FeatureCommunicationStore({ eventLimit: 2 });
    const storeRoutes = setupFeatureCommunicationRoutes(app, express, { communicationStore: store });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.close(); server.closeAllConnections?.(); });
    const target = { agentId: 'stream-agent', sessionId: 'stream-session', featureId: 'shell', channelId: 'task-1' };
    store.declareChannel(target);
    store.publishSnapshot(target, { state: 'running' });
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/protoclaw/feature-comms/stream?${new URLSearchParams(target)}`, { signal: controller.signal });
    assert.equal(response.status, 200);
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
      store.closeSession(target.agentId, target.sessionId);
      await waitFor('event: closed');
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
      const store = setupFeatureCommunicationRoutes(app, { json: () => (_req, _res, next) => next() }, { communicationStore: new FeatureCommunicationStore({ requestTimeoutMs: 100 }) });
      store.declareChannel({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1' });
      const handler = app.routes['POST /protoclaw/feature-comms/request'].at(-1);
      const response = res();
      // Browser call without any identity — must pass the auth gate when host
      // auth is disabled (regression: previously 403 user_session_required).
      const request = handler(browserReq({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1', requestType: 'stop', payload: {} }), response);
      assert.equal(child.sent[0].__targetSessionId, 'comms-session');
      child.emit('message', { type: 'feature-comms-result', requestId: child.sent[0].requestId, sessionId: 'other-session', result: { ok: true } });
      child.emit('message', { type: 'feature-comms-result', requestId: child.sent[0].requestId, sessionId: 'comms-session', result: { ok: true } });
      await request;
      assert.deepEqual(response.body, { ok: true, result: { ok: true } });
    } finally {
      managedAgents.delete('comms-agent::comms-session');
    }
  });

  describe('auth posture across host-auth modes', () => {
    it('keeps runtime endpoints open to bearer-token calls and closed to browsers when auth is enabled', async () => {
      const app = makeApp();
      setupFeatureCommunicationRoutes(app, { json: () => (_req, _res, next) => next() }, { communicationStore: new FeatureCommunicationStore() });
      registerRuntime();
      const previous = setAuthEnabledForTest(true);
      try {
        const declare = app.routes['POST /protoclaw/feature-comms/declare'].at(-1);
        const allowed = res();
        await declare(internalReq({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-a' }), allowed);
        assert.equal(allowed.body.ok, true);

        const denied = res();
        await declare(browserReq({ agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-b' }), denied);
        assert.equal(denied.statusCode, 403);
      } finally {
        setAuthEnabledForTest(previous);
        managedAgents.delete('comms-agent::comms-session');
      }
    });

    it('rejects browser stream/channels/request without a session identity when auth is enabled', async () => {
      const app = makeApp();
      const store = setupFeatureCommunicationRoutes(app, { json: () => (_req, _res, next) => next() }, { communicationStore: new FeatureCommunicationStore() });
      registerRuntime();
      const previous = setAuthEnabledForTest(true);
      try {
        const target = { agentId: 'comms-agent', sessionId: 'comms-session', featureId: 'shell', channelId: 'task-1' };
        store.declareChannel(target);

        const stream = app.routes['GET /protoclaw/feature-comms/stream'].at(-1);
        const streamRes = { ...res(), end() { return this; }, writeHead() { return this; }, flushHeaders() {}, on() {}, setHeader() {} };
        await stream({ headers: {}, query: target }, streamRes);
        assert.equal(streamRes.statusCode, 401);

        const channels = app.routes['GET /protoclaw/feature-comms/channels'].at(-1);
        const channelsRes = { ...res(), end() { return this; } };
        await channels({ headers: {}, query: { agentId: 'comms-agent', sessionId: 'comms-session' } }, channelsRes);
        assert.equal(channelsRes.statusCode, 401);

        const request = app.routes['POST /protoclaw/feature-comms/request'].at(-1);
        const requestRes = res();
        await request(browserReq({ ...target, requestType: 'stop' }), requestRes);
        assert.equal(requestRes.statusCode, 403);
        assert.equal(requestRes.body.code, 'user_session_required');
      } finally {
        setAuthEnabledForTest(previous);
        managedAgents.delete('comms-agent::comms-session');
      }
    });

    it('admits anonymous browser reads of stream/channels when auth is disabled', async (t) => {
      const app = express();
      const store = new FeatureCommunicationStore();
      setupFeatureCommunicationRoutes(app, express, { communicationStore: store });
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => { server.close(); server.closeAllConnections?.(); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const target = { agentId: 'open-agent', sessionId: 'open-session', featureId: 'shell', channelId: 'task-1' };
      store.declareChannel(target);
      store.publishSnapshot(target, { state: 'idle' });

      const controller = new AbortController();
      const streamResponse = await fetch(`${base}/protoclaw/feature-comms/stream?${new URLSearchParams(target)}`, { signal: controller.signal });
      assert.equal(streamResponse.status, 200);
      controller.abort();

      const snapshotResponse = await fetch(`${base}/protoclaw/feature-comms/snapshot?${new URLSearchParams(target)}`);
      assert.equal(snapshotResponse.status, 200);
    });
  });
});
