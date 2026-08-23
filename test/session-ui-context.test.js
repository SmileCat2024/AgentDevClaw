import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const coreSource = fs.readFileSync(new URL('../public/src/app-core.js', import.meta.url), 'utf8');
const i18nSource = fs.readFileSync(new URL('../public/src/i18n.js', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
const inputRenderSource = fs.readFileSync(
  new URL('../public/src/modules/input-render.js', import.meta.url),
  'utf8',
);
const uiSource = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
const sessionViewStateSource = fs.readFileSync(
  new URL('../public/src/modules/session-view-state.js', import.meta.url),
  'utf8',
);
const chatContextBarSource = fs.readFileSync(
  new URL('../public/src/modules/chat-context-bar.js', import.meta.url),
  'utf8',
);
const voiceInputSource = fs.readFileSync(new URL('../public/src/modules/voice-input.js', import.meta.url), 'utf8');
const chatRendererSource = fs.readFileSync(new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing marker: ${endMarker}`);
  return source.slice(start, end);
}

function createCoreContext() {
  const context = {
    focusedAgentId: 'flow-workspace',
    currentRuntimeAgentId: 'runtime-1',
    currentMessages: [],
    currentInputRequests: [],
    currentHookInspector: {},
    currentHookInspectorSignature: '',
    currentOverviewSnapshot: {},
    currentOverviewSignature: '',
    currentTodoPlan: {},
    currentTodoPlanSignature: '',
    currentRuntimeConnected: true,
    _switchEpoch: 0,
    toolRenderConfigs: {},
    TOOL_NAMES: {},
    allAgents: [],
    window: { lastInputRequests: [] },
    followLatestEnabled: true,
    container: { scrollTop: 0 },
  };
  context.setCurrentHookInspector = (value) => {
    context.currentHookInspector = value;
    context.currentHookInspectorSignature = JSON.stringify(value);
  };
  context.setCurrentOverviewSnapshot = (value) => {
    context.currentOverviewSnapshot = value;
    context.currentOverviewSignature = JSON.stringify(value);
  };
  context.setCurrentTodoPlan = (value) => {
    context.currentTodoPlan = value;
    context.currentTodoPlanSignature = JSON.stringify(value);
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
    '\nfunction getFeatureStatus',
  );
  vm.runInContext(
    `${i18nSource}
${sessionViewStateSource}
${cacheBlock}
globalThis.__uiContext = {
  getActiveWorkspaceSessionId,
  getRuntimeContextKey,
  getRuntimeWorkspaceSessionId,
  setViewerSessionBinding,
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

test('viewer session binding freezes context key against host active drift', () => {
  const context = createCoreContext();
  const api = context.__uiContext;
  context.allAgents = [{ id: 'runtime-1', active_workspace_session_id: 'session-a' }];

  assert.equal(api.getRuntimeContextKey(), 'host:flow-workspace|session:session-a');

  // 用户主动切换时刻冻结 viewer 绑定
  api.setViewerSessionBinding('runtime-1', 'session-a');

  // 外部入口（IM 转接/CLI/调度/其他标签页）创建并激活新会话：
  // allAgents 刷新后 host 与 runtime 记录的 active 均被抢占
  context.allAgents[0].active_workspace_session_id = 'session-hijacked';
  context.currentAgent.workspace_sessions.activeSessionId = 'session-hijacked';

  // 正在查看的会话身份不漂移：草稿 key / 录音归属 / 输入签名全部稳定
  assert.equal(api.getRuntimeContextKey(), 'host:flow-workspace|session:session-a');
  assert.equal(api.getRuntimeWorkspaceSessionId('runtime-1'), 'session-a');

  // 用户主动切到新会话后绑定更新，contextKey 跟随
  api.setViewerSessionBinding('runtime-1', 'session-hijacked');
  assert.equal(api.getRuntimeContextKey(), 'host:flow-workspace|session:session-hijacked');

  // 绑定清除（空 sessionId）后回退 server 派生值（初始恢复路径）
  api.setViewerSessionBinding('runtime-1', '');
  assert.equal(api.getRuntimeContextKey(), 'host:flow-workspace|session:session-hijacked');
});

test('submit success clears the live textarea, not a detached reference', () => {
  // await fetch 期间输入面可能整块重建；提交前抓取的 textarea 会脱离 DOM。
  // 成功分支必须重新解析 live 元素，否则已发送文本经草稿写回"复活"。
  const persistentInputSource = fs.readFileSync(
    new URL('../public/src/modules/persistent-input.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    persistentInputSource.includes("const liveTextarea = document.getElementById('input-persistent')"),
    'submitQueuedInput should resolve the live textarea after await',
  );

  const inputHelpersSource = fs.readFileSync(
    new URL('../public/src/modules/input-helpers.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    inputHelpersSource.includes('const liveTextarea = document.getElementById(`input-${requestId}`)'),
    'submitInput should resolve the live textarea after await',
  );
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
    inputRenderSource,
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
    voiceInputSource,
    'function _cacheSessionInput',
    '\n// Inject pending voice ASR result',
  );
  vm.runInContext(`${inputCacheBlock}\nglobalThis.__cacheSessionInput = _cacheSessionInput;
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
  assert.equal(context._sessionInputCache['session-a'], '');
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
    voiceInputSource,
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

test('empty cached session draft restores as an intentional blank', () => {
  const resizeState = { calls: 0 };
  const context = {
    _sessionInputCache: { 'session-a': '' },
    _getSessionInputCacheKey: () => 'session-a',
    autoResize() {
      resizeState.calls += 1;
    },
  };
  vm.createContext(context);
  const inputCacheBlock = sourceBetween(
    voiceInputSource,
    'function _cacheSessionInput',
    '\n// Inject pending voice ASR result',
  );
  vm.runInContext(`${inputCacheBlock}
globalThis.__restoreSessionInputDraft = _restoreSessionInputDraft;`, context);

  const requestTextarea = {
    value: 'initial prompt',
    dataset: { sessionKey: 'session-a' },
  };
  assert.equal(context.__restoreSessionInputDraft(requestTextarea), true);
  assert.equal(requestTextarea.value, '');
  assert.equal(resizeState.calls, 1);
});

function createChatMutationContext() {
  const calls = [];
  const restoreState = { calls: 0 };
  const row = {
    dataset: {},
    querySelector() {
      return null;
    },
  };
  const context = {
    followLatestEnabled: false,
    currentMessages: [{ role: 'user', content: 'existing' }],
    currentMessagesLength: 1,
    showChatProcess: false,
    shouldShowChatWelcome: () => false,
    render: () => {},
    container: {
      scrollTop: 123,
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        return selector === '.message-row' ? [row] : [];
      },
      insertAdjacentHTML() {},
      get lastElementChild() {
        return row;
      },
    },
    isChatSurfaceActive: () => true,
    runWithSuppressedChatViewportObservers(work) {
      return work();
    },
    applyCollapseLogic() {},
    updateRollbackActionVisibility() {},
    applyConversationProcessState() {},
    restoreUserCollapseState() {
      restoreState.calls += 1;
    },
    updateFollowLatestButton() {},
    notifyChatViewportMutation(options) {
      calls.push(options);
    },
    enhanceMathInElement() {},
    renderMarkdown(value) {
      return value;
    },
  };
  vm.createContext(context);
  const mutationBlock = sourceBetween(
    chatRendererSource,
    'function appendNewMessages',
    '\nfunction getCollapseThresholdForRow',
  );
  vm.runInContext(`${mutationBlock}
globalThis.__chatMutation = { appendNewMessages, updateLastMessage };`, context);
  return { context, calls, restoreState };
}

function createChatRenderSignatureContext() {
  const context = {
    toolRenderConfigs: {},
  };
  vm.createContext(context);
  const signatureBlock = sourceBetween(
    chatRendererSource,
    'function stableSerializeForChatSignature',
    '\nwindow.toggleMessage',
  );
  vm.runInContext(`${signatureBlock}
globalThis.__chatSignature = { buildChatRenderSignature };`, context);
  return context;
}

test('append preserves viewport and reapplies explicit collapse state when follow is off', () => {
  const { context, calls, restoreState } = createChatMutationContext();

  context.__chatMutation.appendNewMessages([], 1);

  assert.equal(restoreState.calls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'append');
  assert.equal(calls[0].shouldFollow, false);
  assert.equal(calls[0].preserveTop, 123);
});

test('patch-last preserves viewport and reapplies explicit collapse state when follow is off', () => {
  const { context, calls, restoreState } = createChatMutationContext();

  context.__chatMutation.updateLastMessage({ role: 'user', content: 'existing' });

  assert.equal(restoreState.calls, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'patch-last');
  assert.equal(calls[0].shouldFollow, false);
  assert.equal(calls[0].preserveTop, 123);
});

test('chat render signature changes when equal-length Chinese content changes', () => {
  const context = createChatRenderSignatureContext();
  const api = context.__chatSignature;

  const first = api.buildChatRenderSignature([{ role: 'user', content: '问题规范' }]);
  const second = api.buildChatRenderSignature([{ role: 'user', content: '问题安全' }]);

  assert.notEqual(first, second);
});

test('input renderer is a read-only consumer of session view state', () => {
  const start = inputRenderSource.indexOf('function renderInputRequests');
  assert.notEqual(start, -1, 'renderInputRequests should exist in input-render.js');
  const renderBlock = inputRenderSource.slice(start);

  assert.doesNotMatch(renderBlock, /applySessionViewPatch\s*\(/);
  assert.match(renderBlock, /readCurrentSessionViewState\(\)\.inputRequests/);
});

test('request input controls keep the runtime they were rendered for', () => {
  assert.ok(inputRenderSource.includes("submitInput('${req.requestId}', '${escapeHtml(boundRuntimeId)}')"));
  assert.ok(inputRenderSource.includes('submitInputAction(\\\''));
  assert.match(inputRenderSource, /visibleActions\.map[\s\S]*?escapeHtml\(boundRuntimeId\)/);
  assert.ok(inputRenderSource.includes("handleInputKey(event, '${req.requestId}', '${escapeHtml(boundRuntimeId)}')"));
});

test('main render boundary consumes one captured session view', () => {
  const renderBlock = sourceBetween(
    uiSource,
    'function renderCurrentMainView',
    '\nfunction resetRuntimeBackedSurfaceState',
  );

  assert.match(renderBlock, /viewState\s*=\s*readCurrentSessionViewState\(\)/);
  assert.match(renderBlock, /renderInputRequests\(viewState\.inputRequests\)/);
  assert.match(renderBlock, /render\(viewState\.messages\)/);
  assert.match(renderBlock, /updateChatContextBar\(viewState\)/);
  assert.doesNotMatch(renderBlock, /\bcurrentMessages\b|\bcurrentInputRequests\b/);
});

test('context bar renders one supplied session view snapshot', () => {
  const classNames = new Set();
  const bar = {
    innerHTML: '',
    classList: {
      add: (name) => classNames.add(name),
      remove: (name) => classNames.delete(name),
      contains: (name) => classNames.has(name),
    },
  };
  const context = {
    currentOverviewSnapshot: {
      modelName: 'stale-model',
      usageStats: { lastRequestUsage: { inputTokens: 75 } },
    },
    document: {
      getElementById: (id) => id === 'chat-context-bar' ? bar : null,
    },
    window: {},
    shouldRenderWorkspaceSurface: () => false,
    getRuntimeAwareAgentRecord: () => ({
      workspace_sessions: { sessions: [{}] },
    }),
    getCurrentRuntimeRecord: () => ({}),
    escapeHtml: (value) => String(value),
  };
  vm.createContext(context);
  const renderBlock = sourceBetween(
    chatContextBarSource,
    'function updateChatContextBar',
    '\n// ── Context pressure toast trigger',
  );
  vm.runInContext(
    `${renderBlock}\nglobalThis.__updateChatContextBar = updateChatContextBar;`,
    context,
  );

  context.__updateChatContextBar({
    overview: {
      modelName: 'snapshot-model',
      contextLength: 100,
      compressRatio: 80,
      usageStats: {
        lastRequestUsage: { inputTokens: 25 },
        totalUsage: { inputTokens: 40, outputTokens: 10 },
        totalRequests: 2,
      },
    },
  });

  assert.match(bar.innerHTML, /snapshot-model/);
  assert.match(bar.innerHTML, /25%/);
  assert.equal(context.window._ccbDetailData.used, 25);
  assert.equal(context.window._ccbDetailData.totalInput, 40);
});
