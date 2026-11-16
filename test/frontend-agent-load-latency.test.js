import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const HOST = 'programming-helper';
const SELECTED = 'session-selected';
const FRESH = [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'fresh answer' }];
const DETAIL = {
  workspace_sessions: {
    activeSessionId: 'session-other',
    sessions: [
      { id: SELECTED, sessionType: 'main', openDirectory: '/selected', messageCount: 2 },
      { id: 'session-other', sessionType: 'main', openDirectory: '/other', messageCount: 99 },
    ],
  },
};

function createLoadHarness() {
  const paints = [];
  const errors = [];
  const requests = [];
  const gates = new Map();
  const failures = new Set();
  const ctx = createFrontendSandbox({
    console: { ...console, error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    resetRuntimeStatusForSwitch() {},
    attachMessagesTimestamps: (messages) => messages,
    loadFeatureTemplateMap: async () => true,
    recheckAutoTitleCandidate() {},
    notifyInputSurfaceChanged() {},
    updateRollbackActionVisibility() {},
    renderFeaturePanel() {},
    warmTemplatesInBackground() {},
    collectTemplateNames: () => [],
    updateInputModelSwitcher() {},
    updateThinkingEffortSwitcher() {},
    updateChatContextBar() {},
    updateNotificationStatus() {},
    getCurrentAgentRecord: () => ctx.run('allAgents[0]'),
    getCurrentHostAgentRecord: () => ctx.run('allAgents[0]'),
    renderCurrentMainView: () => paints.push(ctx.run('readCurrentSessionViewState()')),
    fetch: async (url) => {
      const endpoint = String(url).includes('/agent_detail?') ? 'detail' : String(url).split('/').at(-1);
      requests.push(endpoint);
      const gate = gates.get(endpoint);
      if (gate?.phase === 'headers') await gate.promise;
      if (failures.has(endpoint)) throw new Error(`failed ${endpoint}`);
      return {
        ok: true,
        json: async () => {
          if (gate?.phase === 'body') await gate.promise;
          if (endpoint === 'messages') return { messages: structuredClone(FRESH) };
          if (endpoint === 'detail') return structuredClone(DETAIL);
          if (endpoint === 'overview') return { modelName: 'loaded-model', thinkingEffort: 'high' };
          if (endpoint === 'hooks') return { features: [{ name: 'loaded-feature' }] };
          if (endpoint === 'tools') return [{ name: 'read', render: { result: '__inline__', inlineResult: 'loaded' } }];
          if (endpoint === 'todo') return { tasks: [{ id: 'loaded-task' }] };
          return [];
        },
      };
    },
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/overview-data.js');
  ctx.loadSource('public/src/modules/todo-plan.js');
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.loadSource('public/src/modules/agent-data-loader.js');
  ctx.run(`
    focusedAgentId = '${HOST}';
    currentRuntimeAgentId = 'runtime-selected';
    allAgents = [{ id: '${HOST}', source: 'prebuilt', kind: 'workspace' }];
    setViewerSessionBinding(currentRuntimeAgentId, '${SELECTED}');
    applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: '${SELECTED}' } });
    refreshCurrentRuntimeStatus = async () => {};
  `);
  return {
    ctx, paints, errors, requests, failures,
    block(endpoint, phase = 'headers') {
      const gate = { ...deferred(), phase };
      gates.set(endpoint, gate);
      return gate;
    },
    load: () => ctx.run("loadAgentData('runtime-selected')"),
    view: () => ctx.run('readCurrentSessionViewState()'),
  };
}

for (const endpoint of ['detail', 'hooks', 'overview', 'todo', 'input-requests', 'tools']) {
  for (const phase of ['headers', 'body']) {
    test(`fresh transcript paints without waiting for ${endpoint} ${phase}`, async () => {
      const h = createLoadHarness();
      const gate = h.block(endpoint, phase);
      h.ctx.run("applySessionViewPatch({ messages: [{ role: 'assistant', content: 'cached old answer' }] })");
      const loading = h.load();
      try {
        await flush();
        assert.equal(h.paints.at(-1)?.messages.at(-1)?.content, 'fresh answer');
        assert.equal(h.view().identity.sessionId, SELECTED);
      } finally {
        gate.resolve();
        await loading;
      }
      assert.deepEqual(h.errors, []);
      assert.equal(h.view().messages.at(-1).content, 'fresh answer');
      assert.equal(h.view().overview.modelName, 'loaded-model');
    });
  }
}

test('cold host detail enriches the selected session without invalidating its message load', async () => {
  const h = createLoadHarness();
  const gate = h.block('messages', 'body');
  const token = h.ctx.run('captureSessionViewToken()');
  const loading = h.load();
  try {
    await flush();
    assert.equal(h.view().sessionMeta.sessionId, SELECTED);
    assert.equal(h.view().sessionMeta.openDirectory, '/selected');
    assert.equal(h.ctx.isSessionViewTokenCurrent(token), true);
  } finally {
    gate.resolve();
    await loading;
  }
  assert.equal(h.view().messages.at(-1)?.content, 'fresh answer');
  assert.deepEqual(h.errors, []);
});

test('a detail slice missing the selected session never borrows the host active session', async () => {
  const h = createLoadHarness();
  const originalFetch = h.ctx.fetch;
  h.ctx.fetch = async (url) => String(url).includes('/agent_detail?')
    ? { ok: true, json: async () => ({ workspace_sessions: {
      activeSessionId: 'session-other', sessions: [DETAIL.workspace_sessions.sessions[1]],
    } }) }
    : originalFetch(url);
  await h.load();
  assert.equal(h.view().identity.sessionId, SELECTED);
  assert.equal(h.view().sessionMeta.sessionId, '');
  assert.equal(h.view().messages.at(-1)?.content, 'fresh answer');
  assert.deepEqual(h.errors, []);
});

test('late auxiliary responses cannot repaint or write into another visit', async () => {
  const h = createLoadHarness();
  const gate = h.block('hooks', 'body');
  const loading = h.load();
  await flush();
  h.ctx.run(`
    _switchEpoch += 1;
    currentRuntimeAgentId = 'runtime-new';
    applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: 'session-new' } });
    applySessionViewPatch({ messages: [{ role: 'assistant', content: 'new visit' }] });
  `);
  const paintCount = h.paints.length;
  gate.resolve();
  await loading;
  assert.equal(h.view().messages.at(-1).content, 'new visit');
  assert.equal(h.paints.length, paintCount);
  assert.deepEqual(h.errors, []);
});

test('a live message update wins over an older initial full response', async () => {
  const h = createLoadHarness();
  const gate = h.block('messages', 'body');
  const loading = h.load();
  await flush();
  h.ctx.run(`commitSessionViewPatch(captureSessionViewToken(), {
    messages: [{ role: 'assistant', content: 'newer live answer' }],
  }); renderCurrentMainView();`);
  gate.resolve();
  await loading;
  assert.equal(h.view().messages.at(-1).content, 'newer live answer');
  assert.equal(h.paints.at(-1).messages.at(-1).content, 'newer live answer');
  assert.equal(h.view().overview.modelName, 'loaded-model', 'only stale transcript is discarded');
  assert.deepEqual(h.errors, []);
});

test('an unchanged probe reusing the cached array does not invalidate initial message loading', async () => {
  const h = createLoadHarness();
  const gate = h.block('messages', 'body');
  const loading = h.load();
  await flush();
  h.ctx.run('commitSessionViewPatch(captureSessionViewToken(), { messages: currentMessages })');
  gate.resolve();
  await loading;
  assert.equal(h.view().messages.at(-1)?.content, 'fresh answer');
  assert.deepEqual(h.errors, []);
});

test('returning to a cached conversation paints fresh messages before slow panels finish', async () => {
  const h = createLoadHarness();
  h.ctx.run(`
    applySessionViewPatch({
      sessionMeta: { sessionId: '${SELECTED}' },
      messages: [{ role: 'assistant', content: 'cached old answer' }],
    });
    saveCurrentRuntimeToCache('runtime-selected');
    _switchEpoch += 1;
    currentRuntimeAgentId = 'runtime-other';
    applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: 'session-other' } });
    _switchEpoch += 1;
    currentRuntimeAgentId = 'runtime-selected';
  `);
  assert.equal(h.ctx.run("restoreRuntimeFromCache('runtime-selected')"), true);
  assert.equal(h.view().messages.at(-1).content, 'cached old answer');
  const gate = h.block('hooks', 'body');
  const loading = h.load();
  try {
    await flush();
    assert.equal(h.paints.at(-1)?.messages.at(-1)?.content, 'fresh answer');
    assert.equal(h.view().identity.sessionId, SELECTED);
  } finally {
    gate.resolve();
    await loading;
  }
  assert.deepEqual(h.errors, []);
});

test('late tool configuration repaints current messages without restoring a stale transcript', async () => {
  const h = createLoadHarness();
  const gate = h.block('tools', 'body');
  const loading = h.load();
  await flush();
  h.ctx.run(`commitSessionViewPatch(captureSessionViewToken(), {
    messages: [{ role: 'assistant', content: 'newer live answer', toolCalls: [{ id: 'call-read', name: 'read' }] }],
  }); renderCurrentMainView();`);
  const previousPaints = h.paints.length;
  gate.resolve();
  await loading;
  assert.equal(h.paints.length, previousPaints + 1);
  assert.equal(h.paints.at(-1).messages.at(-1).content, 'newer live answer');
  assert.equal(h.paints.at(-1).toolRenderConfigs.read.render.inlineResult, 'loaded');
  assert.deepEqual(h.errors, []);
});

test('late detail from an earlier visit cannot overwrite the selected session metadata', async () => {
  const h = createLoadHarness();
  const gate = h.block('detail', 'body');
  const loading = h.load();
  await flush();
  h.ctx.run(`
    _switchEpoch += 1;
    currentRuntimeAgentId = 'runtime-other';
    applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: 'session-other' } });
    _switchEpoch += 1;
    currentRuntimeAgentId = 'runtime-selected';
    applySessionViewPatch({ identity: { agentId: '${HOST}', sessionId: '${SELECTED}' } });
    applySessionViewPatch({ sessionMeta: { sessionId: '${SELECTED}', openDirectory: '/newer' } });
  `);
  gate.resolve();
  await loading;
  assert.equal(h.view().sessionMeta.openDirectory, '/newer');
  assert.deepEqual(h.errors, []);
});

test('failed auxiliary requests do not prevent the transcript from painting', async () => {
  const h = createLoadHarness();
  h.failures.add('hooks');
  await h.load();
  assert.equal(h.paints.at(-1)?.messages.at(-1)?.content, 'fresh answer');
  assert.equal(h.errors.length, 1, 'the failed auxiliary request remains observable');
});
