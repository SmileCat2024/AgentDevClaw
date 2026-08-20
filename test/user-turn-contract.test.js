import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  submitUserTurn,
  UserTurnDeliveryError,
} from '../server/shared/user-turn.js';
import {
  getUISurfaceStore,
  setupUISurfaceRoutes,
} from '../server/routes/ui-surfaces.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('Claw user-turn contract', () => {
  it('uses AgentDev atomic user-turn endpoint and preserves source metadata', async () => {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, options });
      return jsonResponse({
        success: true,
        delivery: 'input',
        requestId: 'input-waiting',
        source: 'generative-ui',
        sourceRef: 'event-1',
      });
    };

    const result = await submitUserTurn({
      agentId: 'agent/a',
      text: 'surface action',
      source: 'generative-ui',
      sourceRef: 'event-1',
    }, {
      viewerOrigin: 'http://viewer.test',
      fetchImpl,
    });

    assert.equal(result.delivery, 'input');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://viewer.test/api/agents/agent%2Fa/user-turn');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      text: 'surface action',
      source: 'generative-ui',
      sourceRef: 'event-1',
    });
  });

  it('exposes framework delivery failures as a stable Claw error contract', async () => {
    const fetchImpl = async () => jsonResponse({
      success: false,
      code: 'input_mode_conflict',
      error: 'complete the pending choice first',
      pendingMode: 'choices',
    }, { ok: false, status: 409 });

    await assert.rejects(
      submitUserTurn({
        agentId: 'agent-a',
        text: 'new turn',
        source: 'remote-claw',
      }, { viewerOrigin: 'http://viewer.test', fetchImpl }),
      (error) => {
        assert.ok(error instanceof UserTurnDeliveryError);
        assert.equal(error.code, 'input_mode_conflict');
        assert.equal(error.status, 409);
        assert.equal(error.retryable, false);
        return true;
      },
    );
  });

  it('normalizes transport failures as retryable delivery errors', async () => {
    await assert.rejects(
      submitUserTurn({
        agentId: 'agent-a',
        text: 'new turn',
      }, {
        viewerOrigin: 'http://viewer.test',
        fetchImpl: async () => { throw new Error('connection refused'); },
      }),
      (error) => {
        assert.ok(error instanceof UserTurnDeliveryError);
        assert.equal(error.code, 'delivery_unavailable');
        assert.equal(error.status, 502);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it('surface action route owns validation/message shaping and delegates delivery', async () => {
    const agentId = 'route-agent';
    const surfaceId = 'settings';
    const store = getUISurfaceStore();
    store.clearAgent(agentId);
    store.upsert(agentId, surfaceId, {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Settings',
      root: 'root',
      elements: {
        root: { type: 'Stack', props: {}, children: ['theme', 'save'] },
        theme: { type: 'TextInput', props: { name: 'theme', label: 'Theme' }, children: [] },
        save: { type: 'Button', props: { label: 'Save', actionId: 'save' }, children: [] },
      },
      actions: {
        save: { intent: 'submit', label: 'Save' },
      },
    });

    let actionHandler = null;
    const app = {
      get() {},
      put() {},
      delete() {},
      post(path, ...handlers) {
        if (path.includes('/actions/:actionId')) actionHandler = handlers.at(-1);
      },
    };
    setupUISurfaceRoutes(app, { json: () => (_req, _res, next) => next() });
    assert.equal(typeof actionHandler, 'function');

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return jsonResponse({
        success: true,
        delivery: 'input',
        requestId: 'idle-request',
        source: 'generative-ui',
      });
    };

    let statusCode = 200;
    let responseBody = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };

    const eventId = `evt-${Date.now()}`;
    try {
      await actionHandler({
        params: { agentId, surfaceId, actionId: 'save' },
        body: {
          eventId,
          surfaceRevision: 1,
          values: { theme: 'dark' },
        },
      }, res);

      await actionHandler({
        params: { agentId, surfaceId, actionId: 'save' },
        body: {
          eventId,
          surfaceRevision: 1,
          values: { theme: 'dark' },
        },
      }, res);
    } finally {
      globalThis.fetch = originalFetch;
      store.clearAgent(agentId);
    }

    assert.equal(statusCode, 200);
    assert.deepEqual(responseBody, {
      ok: true,
      delivery: 'input',
      queued: false,
      requestId: 'idle-request',
      queueId: null,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/agents\/route-agent\/user-turn$/);
    const delivered = JSON.parse(calls[0].options.body);
    assert.equal(delivered.source, 'generative-ui');
    assert.match(delivered.text, /"theme": "dark"/);
    assert.match(delivered.text, /通过右侧页面「Settings」执行「Save」/);
  });

  it('bounds whole-form submissions before they reach the user-turn transport', async () => {
    const agentId = 'oversized-action-agent';
    const surfaceId = 'settings';
    const store = getUISurfaceStore();
    store.clearAgent(agentId);
    store.upsert(agentId, surfaceId, {
      schemaVersion: 1,
      catalogVersion: 'v1',
      title: 'Settings',
      root: 'root',
      elements: {
        root: { type: 'Stack', props: {}, children: ['notes', 'save'] },
        notes: { type: 'Textarea', props: { name: 'notes', label: 'Notes' }, children: [] },
        save: { type: 'Button', props: { label: 'Save', actionId: 'save' }, children: [] },
      },
      actions: { save: { intent: 'submit', label: 'Save' } },
    });

    let actionHandler = null;
    const app = {
      get() {}, put() {}, delete() {},
      post(path, ...handlers) {
        if (path.includes('/actions/:actionId')) actionHandler = handlers.at(-1);
      },
    };
    setupUISurfaceRoutes(app, { json: () => (_req, _res, next) => next() });

    let statusCode = 200;
    let responseBody = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { responseBody = body; return this; },
    };
    try {
      await actionHandler({
        params: { agentId, surfaceId, actionId: 'save' },
        body: {
          eventId: 'oversized-event',
          surfaceRevision: 1,
          values: { notes: 'x'.repeat(64 * 1024) },
        },
      }, res);
    } finally {
      store.clearAgent(agentId);
    }

    assert.equal(statusCode, 413);
    assert.equal(responseBody.code, 'payload_too_large');
  });

  it('routes every Claw-side new-turn producer through user-turn', () => {
    const producerFiles = [
      'public/src/modules/persistent-input.js',
      'public/src/modules/voice-input.js',
      'server/routes/ui-surfaces.js',
      'server/remote-claw/embedded-connector.js',
    ];

    for (const file of producerFiles) {
      const source = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /\/queue-input\b/, `${file} must not bypass user-turn arbitration`);
    }
  });

  it('server user-turn gateway route parses JSON bodies before delivery', () => {
    // server.js has no global express.json(); the user-turn route must mount its
    // own body parser. Without it req.body is undefined, text normalizes to ''
    // and every runtime-period message dies with "text must be a non-empty
    // string" (direct path) or a bogus "image-only input" rejection (handoff path).
    const source = fs.readFileSync('server.js', 'utf8');
    const registration = source.match(/app\.post\('\/api\/agents\/:agentId\/user-turn'[^{]*/);
    assert.ok(registration, 'user-turn gateway route should be registered in server.js');
    assert.match(
      registration[0],
      /express\.json\(\)/,
      'user-turn gateway route must mount express.json() (server.js has no global body parser)',
    );
  });
});
