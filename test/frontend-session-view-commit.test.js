import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

test('ESM commit host rejects stale visits without effects while preserving newer input and model fields', async () => {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.currentRuntimeAgentId = 'runtime';
  ctx.focusedAgentId = 'host';
  ctx.applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
  const beforeModule = ctx.captureSessionViewToken();
  const previousWindow = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/session-view-commit-host.js', { installGlobals: false });
    let callbacks = 0;
    assert.equal(module.commitSessionViewPatch(beforeModule, { messages: [{ content: 'first' }] }, () => { callbacks++; }), true);
    assert.equal(ctx.currentMessages[0].content, 'first');
    assert.equal(callbacks, 1, 'the observer must see a valid commit before checking rejected commits');
    const oldVisit = ctx.captureSessionViewToken();
    ctx.applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'b' } });
    ctx.applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
    const messages = ctx.currentMessages;
    assert.equal(module.commitSessionViewPatch(oldVisit, { messages: [{ content: 'stale' }] }, () => { callbacks++; }), false);
    assert.strictEqual(ctx.currentMessages, messages);
    assert.equal(callbacks, 1, 'a stale transaction cannot run its UI callback');

    ctx.applySessionViewPatch({ overview: { modelRevision: 2, modelName: 'current', usage: 10 } });
    const token = ctx.captureSessionViewToken();
    const latestRequests = [{ requestId: 'new-lease' }];
    ctx.applySessionViewPatch({ inputRequests: latestRequests });
    assert.equal(module.commitSessionViewPatch(token, {
      messages: [{ content: 'accepted' }], inputRequests: [{ requestId: 'old-lease' }],
      overview: { modelRevision: 1, modelName: 'old', usage: 20 },
    }, ({ previous, current }) => {
      assert.strictEqual(previous.messages, messages);
      assert.equal(current.messages[0].content, 'accepted');
      assert.strictEqual(current.inputRequests, latestRequests);
      assert.equal(current.overview.modelName, 'current');
      callbacks++;
    }), true);
    assert.equal(ctx.currentOverviewSnapshot.usage, 20, 'fresh non-model fields survive model revision filtering');
    assert.equal(ctx.currentOverviewSnapshot.modelRevision, 2);
    assert.strictEqual(ctx.currentInputRequests, latestRequests);
    assert.equal(callbacks, 2);
    assert.throws(() => module.commitSessionViewState(token, null), /synchronous apply function/);
    assert.throws(() => module.commitSessionViewPatch(token, {}, null), /afterCommit must be a function/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
