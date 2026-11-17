import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { installSessionViewCommit } from './helpers/session-view-commit.js';
import { installRuntimeViewCache } from './helpers/runtime-view-cache.js';
import { installI18n } from './helpers/install-i18n.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

/** Raw VM contexts install the real kernel with window/global unified. */
const coreSource = fs.readFileSync(new URL('../public/src/app-core.js', import.meta.url), 'utf8');
const inputRenderSource = fs.readFileSync(
  new URL('../public/src/modules/input-render.js', import.meta.url),
  'utf8',
);
const uiSource = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
const sessionViewStateSource = fs.readFileSync(
  new URL('../public/src/modules/session-view-state.js', import.meta.url),
  'utf8',
);
// 工单 036：会话草稿缓存已从 voice-input.js 迁至 input-composer.js
const inputComposerSource = fs.readFileSync(
  new URL('../public/src/modules/input-composer.js', import.meta.url),
  'utf8',
);
const CHAT_RENDERER = 'public/src/modules/chat-renderer.js';

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
  context.window = context;
  vm.runInContext(fs.readFileSync(new URL('../public/src/modules/kernel-state.js', import.meta.url), 'utf8'), context);
  // i18n 已迁 ESM（P4）：t 桥键按生产同款 defineKey + claim 装进裸 vm 上下文
  installI18n(context);
  const cacheBlock = sourceBetween(
    coreSource,
    'const MAX_CACHED_RUNTIME_VIEWS = 4;',
    '\nfunction getFeatureStatus',
  );
  vm.runInContext(
    `${sessionViewStateSource}
${cacheBlock}
`, context);
  installSessionViewCommit(context);
  installRuntimeViewCache(context);
  vm.runInContext(`globalThis.__uiContext = {
  getActiveWorkspaceSessionId,
  getRuntimeContextKey,
  getRuntimeWorkspaceSessionId,
  setViewerSessionBinding,
  saveCurrentRuntimeToCache,
  restoreRuntimeFromCache,
  cacheKeys: () => [..._agentRuntimeCache.keys()],
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
  // ADR-0035 后普通发言只有一条提交路径（submitQueuedInput），此契约只剩
  // 该处需要锁定；input-helpers 的 /input 文本编排已退役。
  const persistentInputSource = fs.readFileSync(
    new URL('../public/src/modules/persistent-input.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    persistentInputSource.includes("const liveTextarea = document.getElementById('input-persistent')"),
    'submitQueuedInput should resolve the live textarea after await',
  );

  // 动作提交实现已迁 input-actions.js；退役的 /input 文本编排在两个文件里都不许回来。
  const inputActionsSource = fs.readFileSync(
    new URL('../public/src/modules/input-actions.js', import.meta.url),
    'utf8',
  );
  assert.equal(
    /async function submitInput\b|_submitInputInner/.test(inputActionsSource),
    false,
    'the retired /input text orchestration must not come back (ADR-0035)',
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

test('cache restore restores the session identity together with the transcript', () => {
  // 缺陷现场：离开会话回工作空间首页会把视图身份清成空会话；切回已缓存的
  // 会话时只恢复内容不恢复身份，界面上有对话、身份却停在空会话，模型切换
  // 与输入面因此判定「当前会话不支持模型切换」。缓存条目里的 sessionMeta
  // 在会话元数据尚未加载时本就是空值，不能作为身份来源。
  const context = createCoreContext();
  const api = context.__uiContext;

  context.currentAgent.workspace_sessions.activeSessionId = 'session-a';
  context.currentMessages = [{ role: 'assistant', content: 'session A' }];
  api.saveCurrentRuntimeToCache('runtime-1');

  // 回工作空间首页：身份被清成空会话
  context.run?.('void 0');
  vm.runInContext("applySessionViewPatch({ identity: { agentId: 'flow-workspace', sessionId: '' } })", context);
  context.currentMessages = [];
  context.currentAgent.workspace_sessions.activeSessionId = 'session-a';

  assert.equal(api.restoreRuntimeFromCache('runtime-1'), true);
  assert.equal(context.currentMessages[0].content, 'session A');
  assert.equal(
    vm.runInContext('readCurrentSessionViewState().identity.sessionId', context),
    'session-a',
  );
});

test('runtime cache retains the most recently visited views without holding every transcript', () => {
  const context = createCoreContext();
  const api = context.__uiContext;
  for (let index = 0; index < 4; index++) {
    context.currentAgent.workspace_sessions.activeSessionId = `session-${index}`;
    context.currentMessages = [{ role: 'assistant', content: `message-${index}` }];
    api.saveCurrentRuntimeToCache('runtime-1');
  }
  context.currentAgent.workspace_sessions.activeSessionId = 'session-0';
  assert.equal(api.restoreRuntimeFromCache('runtime-1'), true);
  api.saveCurrentRuntimeToCache('runtime-1');
  context.currentAgent.workspace_sessions.activeSessionId = 'session-4';
  context.currentMessages = [{ role: 'assistant', content: 'message-4' }];
  api.saveCurrentRuntimeToCache('runtime-1');
  assert.equal(api.cacheKeys().length, 4);
  assert.ok(api.cacheKeys().some(key => key.endsWith('session:session-0')));
  assert.ok(!api.cacheKeys().some(key => key.endsWith('session:session-1')));
  context.currentAgent.workspace_sessions.activeSessionId = 'session-1';
  assert.equal(api.restoreRuntimeFromCache('runtime-1'), false);
});

test('persistent input render signature changes with session context', () => {
  const context = {
    currentRuntimeAgentId: 'runtime-1',
    readOnlyMode: false,
    getRuntimeContextKey: () => 'host:flow-workspace|session:session-a',
  };
  vm.createContext(context);
  context.window = context;
  vm.runInContext(fs.readFileSync(new URL('../public/src/modules/kernel-state.js', import.meta.url), 'utf8'), context);
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

test('detached textarea writes back to its frozen session key', async () => {
  // 草稿函数已随 input-composer 迁 ESM（P4 输入面批次）：真实 import 路线。
  // 会话键冻结语义不变——textarea 自带 sessionKey 时不读当前会话键。
  await withP2EsmCase({
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      sandbox._getSessionInputCacheKey = () => 'session-b';
    },
  }, async (c) => {
    const composer = await c.load('public/src/modules/input-composer.js');
    const composerState = await c.load('public/src/modules/p2-w2-3a-composer-state.js');
    const cache = composerState.sessionInputCache;

    const oldTextarea = {
      value: 'draft from A',
      dataset: { sessionKey: 'session-a' },
      style: {},
      scrollHeight: 0,
    };
    composer._cacheSessionInput(oldTextarea);
    assert.equal(cache['session-a'], 'draft from A');
    assert.equal(cache['session-b'], undefined);

    oldTextarea.value = '';
    composer._storeSessionInputDraft(oldTextarea);
    assert.equal(cache['session-a'], '');
  });
});

test('cached session draft restores into request textarea', async () => {
  await withP2EsmCase({
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      sandbox._getSessionInputCacheKey = () => 'session-a';
    },
  }, async (c) => {
    const composer = await c.load('public/src/modules/input-composer.js');
    const composerState = await c.load('public/src/modules/p2-w2-3a-composer-state.js');
    composerState.sessionInputCache['session-a'] = 'draft from A';

    const requestTextarea = {
      value: '',
      dataset: { sessionKey: 'session-a' },
      style: {},
      scrollHeight: 0,
    };
    assert.equal(composer._restoreSessionInputDraft(requestTextarea), true);
    assert.equal(requestTextarea.value, 'draft from A');
    // 真实 autoResize（input-actions 具名导出）跑过一次：高度被重算为 px 值
    assert.equal(requestTextarea.style.height, '0px');
  });
});

test('empty cached session draft restores as an intentional blank', async () => {
  await withP2EsmCase({
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      sandbox._getSessionInputCacheKey = () => 'session-a';
    },
  }, async (c) => {
    const composer = await c.load('public/src/modules/input-composer.js');
    const composerState = await c.load('public/src/modules/p2-w2-3a-composer-state.js');
    composerState.sessionInputCache['session-a'] = '';

    const requestTextarea = {
      value: 'initial prompt',
      dataset: { sessionKey: 'session-a' },
      style: {},
      scrollHeight: 0,
    };
    assert.equal(composer._restoreSessionInputDraft(requestTextarea), true);
    assert.equal(requestTextarea.value, '');
    assert.equal(requestTextarea.style.height, '0px');
  });
});

/**
 * chat-renderer 的两个增量入口在 follow 关闭时的视口语义与折叠偏好重放。
 *
 * 装载路线（P4 T2 批次）：chat-renderer 已迁 ESM，改真实 import
 * （withP2EsmCase + prepareClassicSandbox）。原用例把 appendNewMessages…折叠函数
 * 切片进 vm 并替换 notify / restoreUserCollapseState 桩、断言调用参数；迁 ESM 后
 * 这两个入口都是模块内部导入、不可替换，改为断言**可观测结果**：
 *   - 视口保持：notify 记下的 preserveTop 是变更瞬间的 scrollTop，结算后把视口
 *     写回该像素值（本用例在结算前把 scrollTop 挪开，验证写回的是快照值）；
 *   - 折叠偏好重放：用户显式展开过的行在增量渲染后仍处于展开态。
 */
async function withMutationCase(fn) {
  const row = {
    dataset: {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    matches() { return false; },
  };
  const container = {
    _rows: [row],
    _html: '',
    scrollTop: 123,
    scrollHeight: 800,
    clientHeight: 600,
    dataset: {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    addEventListener() {}, removeEventListener() {},
    get innerHTML() { return container._html; },
    set innerHTML(value) { container._html = String(value); },
    get lastElementChild() { return row; },
    querySelector(sel) {
      if (sel === '.message-row') return row;
      if (typeof sel === 'string' && sel.startsWith('#')) {
        // 消息行定位（updateLastMessage）与运行态指示块（runtime-status）共用
        return Object.assign({}, generic(), { closest: () => row });
      }
      return null;
    },
    querySelectorAll(sel) {
      return sel.includes('.message-row') ? [row] : [];
    },
    insertAdjacentHTML() {},
    getElementsByTagName: () => [],
    style: {},
  };
  const messageContent = {
    id: 'msg-0',
    style: {},
    remove() {},
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    classList: { contains: (name) => messageContent._collapsed && name === 'collapsed', add() {}, remove() { messageContent._collapsed = false; }, toggle() {} },
    _collapsed: true,
    querySelector() { return null; },
    closest() { return row; },
  };
  const generic = () => ({
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '', id: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; }, remove() {},
    insertBefore() {}, contains: () => false, focus() {}, blur() {},
    insertAdjacentHTML() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
  });
  const document = {
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => {
      if (id === 'chat-container') return container;
      if (id === 'msg-0') return messageContent;
      return generic();
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => generic(),
    createTextNode: (text) => ({ textContent: text }),
    body: generic(), head: generic(), documentElement: generic(),
  };

  return withP2EsmCase({
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
    },
    globals: {
      document,
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: (value) => String(value ?? '') },
      updateChatProcessToggle: () => {},
      // 本用例站在聊天表面：视口域的判定按此固定（生产由 app-ui 按表面状态给出）。
      isChatSurfaceActive: () => true,
      shouldRenderWorkspaceSurface: () => false,
      // 基座把 rAF 关掉（首屏用例不需要帧）；视口结算走 rAF，这里接回最小帧。
      requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: (id) => clearTimeout(id),
      createPollCoordinatorHost: () => ({
        run: () => Promise.resolve(),
        fastInterval: () => 2000,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (id) => clearTimeout(id),
      }),
    },
  }, async (c) => {
    const renderer = await c.load(CHAT_RENDERER);
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.followLatestEnabled = false;
    surface.showChatProcess = false;
    c.window.currentMessages = [{ role: 'user', content: 'existing' }];
    return fn({ c, renderer, surface, container, messageContent });
  });
}

/** 结算链是 setTimeout(0) → rAF → 两帧稳定，用最小 tick 推进到落位。 */
async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('append preserves viewport and reapplies explicit collapse state when follow is off', async () => {
  await withMutationCase(async ({ renderer, surface, container, messageContent }) => {
    surface._userExpandedMsgs.add(0);
    container.scrollTop = 123;

    renderer.appendNewMessages([], 1);
    // 结算前用户离开快照位置：写回的必须是变更瞬间的像素值（123），不是现值。
    container.scrollTop = 50;
    await settle();

    assert.equal(container.scrollTop, 123, 'preserveTop snapshot restores the viewport');
    assert.equal(messageContent._collapsed, false, 'explicit expand preference is replayed');
  });
});

test('patch-last preserves viewport and reapplies explicit collapse state when follow is off', async () => {
  await withMutationCase(async ({ renderer, surface, container, messageContent }) => {
    surface._userExpandedMsgs.add(0);
    container.scrollTop = 123;

    renderer.updateLastMessage({ role: 'user', content: 'existing' });
    container.scrollTop = 50;
    await settle();

    assert.equal(container.scrollTop, 123, 'preserveTop snapshot restores the viewport');
    assert.equal(messageContent._collapsed, false, 'explicit expand preference is replayed');
  });
});

test('collapse preference follows the activated context (host seam stays live)', async () => {
  // app-core 的 activateUserCollapseStateForContext() 会整体重新赋值三个偏好绑定。
  // chat-renderer 经 chatSurface 的 getter 取用，因此切换上下文后必须看到新的
  // Set；若宿主交的是值拷贝，渲染侧会继续持旧上下文集合（切换窗口内展开态错位）。
  await withMutationCase(({ c, renderer, surface, container, messageContent }) => {
    messageContent._collapsed = true;

    // ctx-a：用户展开第 0 行
    c.window.activateUserCollapseStateForContext('ctx-a');
    surface._userExpandedMsgs.add(0);
    renderer.restoreUserCollapseState(container);
    assert.equal(messageContent._collapsed, false, 'ctx-a 的展开偏好必须重放');

    // 切到 ctx-b：activate 重赋值绑定，ctx-b 尚无该行偏好
    c.window.activateUserCollapseStateForContext('ctx-b');
    messageContent._collapsed = true;
    renderer.restoreUserCollapseState(container);
    assert.equal(messageContent._collapsed, true, '渲染侧不得再持 ctx-a 的旧集合');

    // ctx-b 自己的偏好（写入与读出落在同一激活上下文）
    surface._userExpandedMsgs.add(0);
    renderer.restoreUserCollapseState(container);
    assert.equal(messageContent._collapsed, false, '写入与读出必须落在当前激活的集合');
  });
});

test('chat render signature changes when equal-length Chinese content changes', async () => {
  await withMutationCase(({ renderer }) => {
    const messages = (content) => [{ role: 'user', content, _ts: 1 }];
    assert.notEqual(
      renderer.buildChatRenderSignature(messages('一二三四五')),
      renderer.buildChatRenderSignature(messages('一二三四六')),
      'equal-length content change must change the signature',
    );
    assert.equal(
      renderer.buildChatRenderSignature(messages('一二三四五')),
      renderer.buildChatRenderSignature(messages('一二三四五')),
      'identical content must be stable',
    );
  });
});

test('input renderer is a read-only consumer of session view state', () => {
  const start = inputRenderSource.indexOf('function renderInputRequests');
  assert.notEqual(start, -1, 'renderInputRequests should exist in input-render.js');
  const renderBlock = inputRenderSource.slice(start);

  assert.doesNotMatch(renderBlock, /applySessionViewPatch\s*\(/);
  assert.match(renderBlock, /readCurrentSessionViewState\(\)\.inputRequests/);
});

test('lease action responses stay bound to the runtime that rendered the lease', () => {
  // ADR-0035：普通发言恒走 user-turn，composer 不再按 lease 绑定 requestId
  // 端点。唯一残留的 requestId 端点消费方是 rollback / compact 的 action 应答。
  // 该应答必须携带渲染时绑定的 runtimeId——lease 与运行态正交，用户可能在
  // 应答前切走选中态，改用 currentRuntimeAgentId 会把动作投到错误会话。
  // 对话框与运行期编排已迁 rollback-dialog-runtime.js（rollback-dialog.js 只剩
  // classic 相状态键注册壳）；契约断言的落点随之迁移。
  const rollbackSource = fs.readFileSync(
    new URL('../public/src/modules/rollback-dialog-runtime.js', import.meta.url),
    'utf8',
  );
  assert.match(
    rollbackSource,
    /submitInputAction\(\s*lease\.requestId,\s*'rollback_to_call',[\s\S]{0,200}?boundRuntimeId\s*,\s*viewToken\)/,
  );
  assert.match(
    rollbackSource,
    /submitInputAction\(\s*lease\.requestId,\s*'compact_from_call',[\s\S]{0,200}?boundRuntimeId\s*,\s*viewToken\)/,
  );
  // composer 侧：不存在 requestId 绑定的键盘提交路径。
  assert.equal(/handleInputKey/.test(inputComposerSource), false,
    'composer must not bind a requestId text endpoint (ADR-0035)');
});

test('main render boundary consumes one captured session view', () => {
  const renderBlock = sourceBetween(
    uiSource,
    'function renderCurrentMainView',
    '\nfunction resetRuntimeBackedSurfaceState',
  );

  assert.match(renderBlock, /viewState\s*=\s*readCurrentSessionViewState\(\)/);
  // 工单 037：结构性时机保留显式调用，但必须走唯一声明入口。
  assert.match(renderBlock, /notifyInputSurfaceChanged\(viewState\.inputRequests\)/);
  assert.doesNotMatch(renderBlock, /\brenderInputRequests\(/);
  assert.match(renderBlock, /render\(viewState\.messages\)/);
  assert.match(renderBlock, /updateChatContextBar\(viewState\)/);
  assert.doesNotMatch(renderBlock, /\bcurrentMessages\b|\bcurrentInputRequests\b/);
});

test('context bar renders one supplied session view snapshot', async () => {
  // chat-context-bar 已迁 ESM（P4 L1）：真实 import 路线（原实现按源码切片在 vm 里
  // 重放函数体，ESM 化后函数体依赖导入值与模块状态，切片不再适用）。
  const classNames = new Set();
  const bar = {
    innerHTML: '',
    classList: {
      add: (name) => classNames.add(name),
      remove: (name) => classNames.delete(name),
      contains: (name) => classNames.has(name),
    },
  };
  const documentStub = {
    getElementById: (id) => (id === 'chat-context-bar' ? bar : null),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, addEventListener() {}, appendChild() {} }; },
    addEventListener() {},
    body: { appendChild() {} },
    readyState: 'complete',
  };
  await withP2EsmCase({
    globals: {
      document: documentStub,
      shouldRenderWorkspaceSurface: () => false,
      isChatSurfaceActive: () => false,
      getRuntimeAwareAgentRecord: () => ({ workspace_sessions: { sessions: [{}] } }),
      getCurrentRuntimeRecord: () => ({}),
      notifyChatViewportMutation: () => {},
      // vendor 解析器 / 高亮库：markdown-utils 求值期构造 Renderer，渲染期查 hljs。
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: () => '' },
      hljs: { getLanguage: () => null, highlight: () => ({ value: '' }) },
    },
    classic: (sandbox) => {
      sandbox.setTimeout = () => 0; // 抑制 _initCcbPopup / _initTitlePopup 的定时器
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
    },
  }, async (c) => {
    const contextBar = await c.load('public/src/modules/chat-context-bar.js');
    contextBar.updateChatContextBar({
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
    assert.equal(contextBar._ccbDetailData.used, 25);
    assert.equal(contextBar._ccbDetailData.totalInput, 40);
  });
});
