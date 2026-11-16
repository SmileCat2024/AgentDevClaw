import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

// Exercise the production module graph and real SessionView patch mechanism.
test('cache restores synchronously with session identity, follow mode and bounded eviction', async () => {
  const events = [];
  const ctx = createFrontendSandbox({
    getCurrentAgentRecord: () => ({ id: 'host' }),
    notifyInputSurfaceChanged: () => events.push(ctx.run('followLatestEnabled')),
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  const previous = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/runtime-view-cache-host.js', { installGlobals: false });
    assert.strictEqual(ctx.restoreRuntimeFromCache, module.restoreRuntimeFromCache);
    ctx.run(`currentRuntimeAgentId = 'runtime'; focusedAgentId = 'host';
      applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'a' } });
      applySessionViewPatch({ messages: [{ role: 'assistant', content: 'A' }],
        inputRequests: [{ requestId: 'a' }] });
      followLatestEnabled = false;`);
    const messages = ctx.currentMessages;
    ctx.saveCurrentRuntimeToCache('runtime', 'host:host|session:a');
    ctx.run(`applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'b' } });
      followLatestEnabled = true;`);
    events.length = 0;
    const restored = ctx.restoreRuntimeFromCache('runtime', 'host:host|session:a');
    assert.strictEqual(restored, true, 'restoration is not a Promise');
    assert.strictEqual(ctx.currentMessages, messages);
    assert.equal(ctx.run('readCurrentSessionViewState().identity.sessionId'), 'a');
    assert.equal(ctx.currentInputRequests[0].requestId, 'a');
    assert.ok(events.length > 0, 'input notification observation is active');
    assert.ok(events.every((follow) => follow === false), 'notifications see restored follow mode');
    assert.equal(ctx.restoreRuntimeFromCache('other-runtime', 'host:host|session:a'), false);
    assert.equal(ctx.restoreRuntimeFromCache('runtime', 'host:host|session:a'), false, 'collision evicts invalid entry');

    for (let i = 0; i < 5; i++) {
      ctx.saveCurrentRuntimeToCache('runtime', `host:host|session:${i}`);
    }
    assert.equal(ctx.restoreRuntimeFromCache('runtime', 'host:host|session:0'), false);
    assert.equal(ctx.restoreRuntimeFromCache('runtime', 'host:host|session:1'), true);
    ctx.clearAgentRuntimeCache('unrelated');
    assert.equal(ctx.restoreRuntimeFromCache('runtime', 'host:host|session:1'), true);
    ctx.clearAgentRuntimeCache('runtime');
    assert.equal(ctx.restoreRuntimeFromCache('runtime', 'host:host|session:1'), false);
    ctx.saveCurrentRuntimeToCache('runtime', 'runtime:runtime');
    ctx.clearAgentRuntimeCache();
    assert.equal(ctx.restoreRuntimeFromCache('runtime', 'runtime:runtime'), false);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
