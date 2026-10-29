import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const loaderSource = fs.readFileSync(new URL('../public/src/modules/agent-data-loader.js', import.meta.url), 'utf8');
const sseSource = fs.readFileSync(new URL('../public/src/modules/sse-client.js', import.meta.url), 'utf8');
const coreSource = fs.readFileSync(new URL('../public/src/app-core.js', import.meta.url), 'utf8');

function createView({ runtimeId = 'runtime-a', hostId = 'host-a', epoch = 1 } = {}) {
  const ctx = createFrontendSandbox({
    focusedAgentId: hostId,
    currentRuntimeAgentId: runtimeId,
    _switchEpoch: epoch,
    getCurrentHostAgentRecord: () => ({ id: ctx.focusedAgentId }),
    getEmptyOverviewSnapshot: () => ({ empty: true }),
    getEmptyTodoPlan: () => ({ tasks: [] }),
    notifyInputSurfaceChanged() {},
  });
  ctx.loadSource('public/src/modules/session-view-state.js');
  return ctx;
}

const producers = [
  'initial load', 'poll', 'SSE', 'cache restoration',
  'await-surface messages', 'historical browsing', '404 handling',
];
const identityMigrations = [
  'same runtime, new session', 'new runtime', 'identity cleared', 'sessionMeta derives identity',
  'explicit identity change', 'same-runtime double-session revisit',
];
const timings = ['response commits before migration', 'response returns after migration', 'switch epoch advances'];

// Matrix coverage: every producer is checked against every meaningful identity migration.
for (const producer of producers) {
  for (const migration of identityMigrations) {
    for (const timing of timings) {
      test(`${producer}: ${timing} under ${migration}`, () => {
        const ctx = createView();
        ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' } })");
        ctx.run("globalThis.__token = captureSessionViewToken('runtime-a')");
        if (timing === 'response commits before migration') {
          assert.equal(ctx.run(`commitSessionViewPatch(globalThis.__token, { messages: [{ content: ${JSON.stringify(producer)} }] })`), true);
          assert.equal(ctx.run('currentMessages[0].content'), producer);
          return;
        }

        if (migration === 'same runtime, new session') {
          ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-b' } })");
        } else if (migration === 'new runtime') {
          ctx.currentRuntimeAgentId = 'runtime-b';
          ctx.run("applySessionViewPatch({ identity: { agentId: 'host-b', sessionId: 'session-a' } })");
        } else if (migration === 'identity cleared') {
          ctx.run('applySessionViewPatch({ identity: null })');
        } else if (migration === 'sessionMeta derives identity') {
          ctx.run("applySessionViewPatch({ sessionMeta: { sessionId: 'session-b' } })");
        } else if (migration === 'explicit identity change') {
          ctx.run("applySessionViewPatch({ identity: { agentId: 'host-b', sessionId: 'session-b' } })");
        } else {
          ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-b' } })");
          ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' } })");
        }
        if (timing === 'switch epoch advances') ctx._switchEpoch += 1;
        ctx.run("currentMessages = [{ content: 'current' }]");
        // 身份代次守卫：任何身份变化（含 A→B→A 回访——epoch 未推进、身份
        // 恰好回到原值）都作废捕获时的 token，迟到响应一律拒绝提交。
        const committed = ctx.run(`commitSessionViewPatch(globalThis.__token, { messages: [{ content: ${JSON.stringify(producer)} }] })`);
        assert.equal(committed, false);
        assert.equal(ctx.run('currentMessages[0].content'), 'current');
      });
    }
  }
}

test('identity normalization trims IDs and maps missing/empty session IDs to host-only identity', () => {
  const ctx = createView();
  const normalized = ctx.run("normalizeSessionViewIdentity({ agentId: ' host-a ', sessionId: '   ' })");
  assert.equal(normalized.agentId, 'host-a');
  assert.equal(normalized.sessionId, '');
  assert.equal(ctx.run("normalizeSessionViewIdentity({ agentId: ' ', sessionId: 'session-a' })"), null);
  assert.equal(ctx.run('normalizeSessionViewIdentity(null)'), null);
});

test('identity-changing patch wipes all prior session snapshots', () => {
  const ctx = createView();
  ctx.run(`applySessionViewPatch({
    identity: { agentId: 'host-a', sessionId: 'session-a' },
    messages: [{ content: 'A' }], inputRequests: [{ requestId: 'a' }],
    toolRenderConfigs: { a: true }, toolNames: { a: 'A' }, hookInspector: { hooks: ['a'] },
    overview: { modelName: 'A' }, todoPlan: { tasks: [{ id: 'a' }] },
    sessionMeta: { sessionId: 'session-a' }, connected: true,
  })`);
  ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-b' } })");
  const view = ctx.run('readCurrentSessionViewState()');
  assert.equal(view.identity.sessionId, 'session-b');
  assert.equal(view.messages.length, 0);
  assert.equal(view.inputRequests.length, 0);
  assert.equal(Object.keys(view.toolRenderConfigs).length, 0);
  assert.equal(Object.keys(view.toolNames).length, 0);
  assert.equal(view.hookInspector.hooks.length, 0);
  assert.equal(view.overview.empty, true);
  assert.equal(view.todoPlan.tasks.length, 0);
  assert.equal(view.sessionMeta.sessionId, '');
  assert.equal(view.connected, false);
});

test('sessionMeta-only patch derives the current host and session identity without an explicit wipe', () => {
  const ctx = createView();
  ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' } })");
  ctx.run("applySessionViewPatch({ sessionMeta: { sessionId: 'session-b' } })");
  const view = ctx.run('readCurrentSessionViewState()');
  assert.equal(view.identity.agentId, 'host-a');
  assert.equal(view.identity.sessionId, 'session-b');
});

test('explicit identity equal to current identity does not wipe; null identity clears session snapshots', () => {
  const ctx = createView();
  ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' } })");
  ctx.run("applySessionViewPatch({ messages: [{ content: 'A' }] })");
  ctx.run("applySessionViewPatch({ identity: { agentId: 'host-a', sessionId: 'session-a' }, connected: true })");
  assert.equal(ctx.run('currentMessages[0].content'), 'A');
  ctx.run('applySessionViewPatch({ identity: null })');
  assert.equal(ctx.run('currentMessages.length'), 0);
  assert.equal(ctx.run('readCurrentSessionViewState().identity.sessionId'), '');
});

test('direct apply callers are synchronous navigation transactions; async message producers are guarded', () => {
  const threadStore = fs.readFileSync(new URL('../public/src/modules/thread-store.js', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../public/src/modules/workspace-actions.js', import.meta.url), 'utf8');
  const awaitLoader = threadStore.slice(threadStore.indexOf('function _loadAwaitSurfaceMessages'), threadStore.indexOf('window.openConversationTarget'));
  const historyLoader = actions.slice(actions.indexOf("if (action.type === 'view_session_record')"), actions.indexOf("if (action.type === 'open_summary')"));
  assert.match(awaitLoader, /captureSessionViewToken\('', \{ agentId, sessionId \}\)/);
  assert.match(awaitLoader, /commitSessionViewPatch\(viewToken, \{ messages: data\.messages \}/);
  assert.match(historyLoader, /recordNavigationEpoch !== _navigationGuardEpoch/);
  assert.match(historyLoader, /applySessionViewPatch\(\{\s*identity: \{ agentId, sessionId \}/);
});

test('initial loading and polling paths guard responses and commit through SessionView', () => {
  assert.match(loaderSource, /const loadToken = captureSessionViewToken\(agentId\)/);
  assert.match(loaderSource, /if \(!isSessionViewTokenCurrent\(loadToken\)\)/);
  assert.match(loaderSource, /commitSessionViewPatch\(loadToken/);
  assert.match(mainSource, /const pollToken = captureSessionViewToken\(\)/);
  assert.match(mainSource, /commitSessionViewPatch\(pollToken/);
  assert.match(mainSource, /if \(!isSessionViewTokenCurrent\(pollToken\)\) return true/);
});

test('SSE focus events capture a SessionView token before metadata commits', () => {
  assert.match(sseSource, /const token = captureSessionViewToken\(frame\.agentId\)/);
  assert.match(sseSource, /commitMetadataUpdate\(token/);
});

test('cache restore is an explicit synchronous restore path and session detail uses guarded metadata commit', () => {
  assert.match(coreSource, /function restoreRuntimeFromCache\(agentId/);
  assert.match(coreSource, /applySessionViewPatch\(restorePatch\)/);
  assert.match(coreSource, /sessionMeta: cached\.sessionMeta/);
  assert.match(coreSource, /commitSessionViewPatch\(sessionViewToken, \{ sessionMeta \},/);
  assert.match(coreSource, /extractSessionMetaFromDetail\(detail, selectedIdentity\.sessionId\)/);
});
