import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

// One production dependency graph per test process: transitive ESM imports keep
// their real cache identity rather than being rewritten into sandbox scripts.
test('loader host preserves early template resets, const Set identity and real session commits', async () => {
  const requests = [];
  const ctx = createFrontendSandbox({
    fetch: async (url) => {
      requests.push(String(url));
      return { ok: true, json: async () => String(url).startsWith('/api/templates/')
        ? { tool: '/template.js' }
        : { workspace_sessions: { sessions: [{ id: 'selected', openDirectory: '/selected' }] } } };
    },
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.run(`
    FEATURE_TEMPLATE_MAP = { early: '/early.js' };
    currentRuntimeAgentId = 'runtime';
    allAgents = [{ id: 'host' }];
    applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'selected' } });
  `);
  const earlyMap = ctx.FEATURE_TEMPLATE_MAP;
  const detailIds = ctx.run('loadedAgentDetailIds');
  const previousWindow = globalThis.window;
  globalThis.window = ctx;
  try {
    const { module } = await loadModuleOnce('public/src/modules/agent-loader-host.js', { installGlobals: false });
    assert.strictEqual(module.FEATURE_TEMPLATE_MAP, earlyMap);
    assert.strictEqual(ctx.AgentLoaderHost.loadedAgentDetailIds, detailIds);
    assert.throws(() => ctx.run('loadedAgentDetailIds = new Set()'), { name: 'TypeError' });
    assert.strictEqual(ctx.loadAgentDetail, module.loadAgentDetail);
    assert.strictEqual(ctx.loadFeatureTemplateMap, module.loadFeatureTemplateMap);
    assert.equal(await module.loadFeatureTemplateMap(), true);
    assert.deepEqual(module.FEATURE_TEMPLATE_MAP, { tool: '/template.js' });
    const reset = {};
    ctx.FEATURE_TEMPLATE_MAP = reset;
    assert.strictEqual(module.FEATURE_TEMPLATE_MAP, reset);
    await ctx.loadAgentDetail('host');
    assert.equal(ctx.run('readCurrentSessionViewState().sessionMeta.openDirectory'), '/selected');
    assert.equal(detailIds.has('host'), true);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].includes('agentId=runtime'));
    assert.equal(module.getAgentDetailPayload('host').workspace_sessions.sessions[0].id, 'selected');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
