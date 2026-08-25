/**
 * Tests for server/routes/capability.js
 *
 * Covers:
 * 1. Route registration — both /protoclaw/commands and /protoclaw/capability_invoke
 * 2. GET /commands without a session target — host commands only
 * 3. GET /commands with a connected runtime — session commands merged in
 * 4. GET /commands with a disconnected runtime — host subset + warning
 * 5. POST /capability_invoke — ref/args relay and result passthrough
 * 6. POST /capability_invoke — runtime rejection maps to 503
 * 7. POST validation — missing ref / bad args / missing sessionId
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

import { setupCapabilityRoutes } from '../server/routes/capability.js';
import { managedAgents } from '../server/shared/agent-access.js';

// ── Test helpers ──────────────────────────────────────────────────

function makeMockApp() {
  const routes = {};
  const mockApp = {
    get: (path, ...handlers) => { routes[`GET ${path}`] = handlers; },
    post: (path, ...handlers) => { routes[`POST ${path}`] = handlers; },
    delete: (path, ...handlers) => { routes[`DELETE ${path}`] = handlers; },
  };
  mockApp._routes = routes;
  return mockApp;
}

function makeMockExpress() {
  // express.json() is a factory: calling it returns the middleware.
  return { json: () => (req, res, next) => next() };
}

function makeMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; this.ended = true; return this; },
  };
  return res;
}

/** Child that answers every capability IPC with the given reply payload. */
function makeReplyingChild(replyFactory) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.sent = [];
  child.send = (msg) => {
    child.sent.push(msg);
    setImmediate(() => {
      child.emit('message', replyFactory(msg));
    });
    return true;
  };
  return child;
}

function injectRuntime(agentId, sessionId, child) {
  const runtime = {
    key: `${agentId}::${sessionId}`,
    agentId,
    id: agentId,
    process: child,
    startedAt: new Date().toISOString(),
    exitCode: null,
    stopped: false,
    viewerAgentId: null,
    selectedSessionId: sessionId,
    ready: true,
    sessionType: null,
  };
  managedAgents.set(runtime.key, runtime);
  return runtime;
}

const AGENT_ID = 'cap-test-agent';
const SESSION_ID = 'cap-test-session';

describe('capability routes', () => {
  let app;
  const injectedKeys = [];

  function setup() {
    app = makeMockApp();
    setupCapabilityRoutes(app, makeMockExpress());
    return app;
  }

  function inject(child) {
    injectRuntime(AGENT_ID, SESSION_ID, child);
    injectedKeys.push(`${AGENT_ID}::${SESSION_ID}`);
  }

  beforeEach(() => { setup(); });
  afterEach(() => {
    for (const key of injectedKeys) managedAgents.delete(key);
    injectedKeys.length = 0;
  });

  it('registers both routes', () => {
    assert.ok(app._routes['GET /protoclaw/commands']);
    assert.ok(app._routes['POST /protoclaw/capability_invoke']);
  });

  it('GET /commands without a session target returns host commands only', async () => {
    const res = makeMockRes();
    await app._routes['GET /protoclaw/commands'][0]({ query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.host.map((c) => c.name), ['trim', 'summary']);
    assert.deepEqual(res.body.commands, []);
  });

  it('GET /commands merges session commands from the runtime', async () => {
    inject(makeReplyingChild((msg) => ({
      type: 'capability-result',
      requestId: msg.requestId,
      sessionId: msg.sessionId ?? SESSION_ID,
      ok: true,
      commands: [{ name: 'force-continuation.continue', description: 'force a continuation turn' }],
    })));
    const res = makeMockRes();
    await app._routes['GET /protoclaw/commands'][0](
      { query: { agentId: AGENT_ID, sessionId: SESSION_ID } }, res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.commands.length, 1);
    assert.equal(res.body.commands[0].name, 'force-continuation.continue');
    // The IPC request targeted the exact session and asked for slash visibility.
    const child = Array.from(managedAgents.values()).find((r) => r.agentId === AGENT_ID).process;
    assert.equal(child.sent[0].type, 'capability-list-request');
    assert.equal(child.sent[0].entryPoint, 'slash');
    assert.equal(child.sent[0].__targetSessionId, SESSION_ID);
  });

  it('GET /commands with a disconnected runtime falls back to host subset', async () => {
    const deadChild = new EventEmitter();
    deadChild.exitCode = 1; // process no longer running
    deadChild.send = () => false;
    inject(deadChild);
    const res = makeMockRes();
    await app._routes['GET /protoclaw/commands'][0](
      { query: { agentId: AGENT_ID, sessionId: SESSION_ID } }, res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.commands, []);
    assert.ok(res.body.warning);
  });

  it('POST /capability_invoke relays ref and args and passes the result through', async () => {
    inject(makeReplyingChild((msg) => ({
      type: 'capability-result',
      requestId: msg.requestId,
      sessionId: SESSION_ID,
      ok: true,
      result: { continued: true },
    })));
    const res = makeMockRes();
    await app._routes['POST /protoclaw/capability_invoke'].at(-1)(
      { body: { ref: 'force-continuation.continue', args: {}, agentId: AGENT_ID, sessionId: SESSION_ID } }, res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.result, { continued: true });
    const runtime = Array.from(managedAgents.values()).find((r) => r.agentId === AGENT_ID);
    assert.equal(runtime.process.sent[0].type, 'capability-invoke');
    assert.equal(runtime.process.sent[0].ref, 'force-continuation.continue');
    assert.deepEqual(runtime.process.sent[0].args, {});
  });

  it('POST /capability_invoke maps runtime rejection to 503', async () => {
    inject(makeReplyingChild((msg) => ({
      type: 'capability-result',
      requestId: msg.requestId,
      sessionId: SESSION_ID,
      ok: false,
      error: 'entry_point_denied',
    })));
    const res = makeMockRes();
    await app._routes['POST /protoclaw/capability_invoke'].at(-1)(
      { body: { ref: 'internal.cmd', agentId: AGENT_ID, sessionId: SESSION_ID } }, res,
    );
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'entry_point_denied');
  });

  it('POST /capability_invoke validates request shape', async () => {
    const cases = [
      { body: { agentId: AGENT_ID, sessionId: SESSION_ID }, status: 400, match: /ref is required/ },
      { body: { ref: 'x', args: 'nope', agentId: AGENT_ID, sessionId: SESSION_ID }, status: 400, match: /args must be an object/ },
      { body: { ref: 'x', agentId: AGENT_ID }, status: 400, match: /sessionId is required/ },
    ];
    for (const { body, status, match } of cases) {
      const res = makeMockRes();
      await app._routes['POST /protoclaw/capability_invoke'].at(-1)({ body }, res);
      assert.equal(res.statusCode, status, JSON.stringify(body));
      assert.match(res.body.error, match);
    }
  });
});
