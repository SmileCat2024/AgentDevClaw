import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const coreSource = fs.readFileSync(new URL('../public/src/app-core.js', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

function createCoreContext() {
  const context = {
    currentAgentId: 'flow-workspace',
    currentRuntimeAgentId: 'runtime-1',
    currentMessages: [],
    currentInputRequests: [],
    currentHookInspector: {},
    currentHookInspectorSignature: '',
    currentOverviewSnapshot: {},
    currentOverviewSignature: '',
    currentRuntimeConnected: true,
    toolRenderConfigs: {},
    TOOL_NAMES: {},
    allAgents: [],
    window: { lastInputRequests: [] },
  };
  context.currentAgent = {
    id: 'flow-workspace',
    active_workspace_session_id: 'stale-session',
    workspace_sessions: { activeSessionId: 'session-a' },
  };
  context.getCurrentAgentRecord = () => context.currentAgent;
  vm.createContext(context);
  const cacheBlock = sourceBetween(
    coreSource,
    'const _agentRuntimeCache = new Map();',
    '\nconst I18N =',
  );
  vm.runInContext(
    `${cacheBlock}
globalThis.__uiContext = {
  getActiveWorkspaceSessionId,
  getRuntimeContextKey,
  saveCurrentRuntimeToCache,
  restoreRuntimeFromCache,
};`,
    context,
  );
  return context;
}

test('runtime context key isolates sessions sharing one runtime', () => {
  const context = createCoreContext();
  const api = context.__uiContext;

  assert.equal(api.getActiveWorkspaceSessionId(), 'session-a');
  const sessionAKey = api.getRuntimeContextKey();
  context.currentAgent.workspace_sessions.activeSessionId = 'session-b';
  const sessionBKey = api.getRuntimeContextKey();

  assert.notEqual(sessionAKey, sessionBKey);
  assert.equal(sessionAKey, 'host:flow-workspace|session:session-a');
  assert.equal(sessionBKey, 'host:flow-workspace|session:session-b');
});

test('optimistic runtime cache restores data by session context', () => {
  const context = createCoreContext();
  const api = context.__uiContext;

  context.currentMessages = [{ role: 'assistant', content: 'session A' }];
  context.currentInputRequests = [{ requestId: 'request-a', mode: 'text' }];
  api.saveCurrentRuntimeToCache('runtime-1');

  context.currentAgent.workspace_sessions.activeSessionId = 'session-b';
  context.currentMessages = [{ role: 'assistant', content: 'session B' }];
  context.currentInputRequests = [{ requestId: 'request-b', mode: 'text' }];
  api.saveCurrentRuntimeToCache('runtime-1');

  context.currentAgent.workspace_sessions.activeSessionId = 'session-a';
  context.currentMessages = [];
  context.currentInputRequests = [];
  assert.equal(api.restoreRuntimeFromCache('runtime-1'), true);
  assert.equal(context.currentMessages[0].content, 'session A');
  assert.equal(context.currentInputRequests[0].requestId, 'request-a');
});

test('persistent input render signature changes with session context', () => {
  const context = {
    currentRuntimeAgentId: 'runtime-1',
    readOnlyMode: false,
    getRuntimeContextKey: () => 'host:flow-workspace|session:session-a',
  };
  vm.createContext(context);
  const signatureBlock = sourceBetween(
    mainSource,
    'function getInputRenderSignature',
    '\nfunction renderInputRequests',
  );
  vm.runInContext(`${signatureBlock}
globalThis.__getInputRenderSignature = getInputRenderSignature;`, context);

  const first = context.__getInputRenderSignature([], 'persistent');
  context.getRuntimeContextKey = () => 'host:flow-workspace|session:session-b';
  const second = context.__getInputRenderSignature([], 'persistent');

  assert.notEqual(first, second);
});

test('detached textarea writes back to its frozen session key', () => {
  const context = {
    _sessionInputCache: {},
    _getSessionInputCacheKey: () => 'session-b',
  };
  vm.createContext(context);
  const inputCacheBlock = sourceBetween(
    mainSource,
    'function _cacheSessionInput',
    '\n// Inject pending voice ASR result',
  );
  vm.runInContext(`${inputCacheBlock}
globalThis.__cacheSessionInput = _cacheSessionInput;
globalThis.__restoreSessionInputDraft = _restoreSessionInputDraft;
globalThis.__storeSessionInputDraft = _storeSessionInputDraft;`, context);

  const oldTextarea = {
    value: 'draft from A',
    dataset: { sessionKey: 'session-a' },
  };
  context.__cacheSessionInput(oldTextarea);
  assert.equal(context._sessionInputCache['session-a'], 'draft from A');
  assert.equal(context._sessionInputCache['session-b'], undefined);

  oldTextarea.value = '';
  context.__storeSessionInputDraft(oldTextarea);
  assert.equal(context._sessionInputCache['session-a'], undefined);
});

test('cached session draft restores into request textarea', () => {
  const resizeState = { calls: 0 };
  const context = {
    _sessionInputCache: { 'session-a': 'draft from A' },
    _getSessionInputCacheKey: () => 'session-a',
    autoResize() {
      resizeState.calls += 1;
    },
  };
  vm.createContext(context);
  const inputCacheBlock = sourceBetween(
    mainSource,
    'function _cacheSessionInput',
    '\n// Inject pending voice ASR result',
  );
  vm.runInContext(`${inputCacheBlock}
globalThis.__restoreSessionInputDraft = _restoreSessionInputDraft;`, context);

  const requestTextarea = {
    value: '',
    dataset: { sessionKey: 'session-a' },
  };
  assert.equal(context.__restoreSessionInputDraft(requestTextarea), true);
  assert.equal(requestTextarea.value, 'draft from A');
  assert.equal(resizeState.calls, 1);
});
