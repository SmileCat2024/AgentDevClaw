import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeWorkspaceAgents, resolveWorkspaceAgent, resolveNewSessionAgent, resolveWorkspaceAgentClass } from '../server/shared/workspace-agents.js';
import { Marked } from 'marked';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const metadata = { id: 'programming-helper', name: '工作空间', defaultAgentId: 'main', agents: [
  { id: 'main', displayName: '编程小助手' }, { id: 'reviewer', displayName: { zh: '审查助手', en: 'Reviewer' } },
] };

test('validates declarations and preserves the explicit legacy main contract', () => {
  assert.equal(normalizeWorkspaceAgents({ name: '旧应用' }).agents[0].displayName, '旧应用');
  assert.equal(resolveWorkspaceAgent(metadata).id, 'main');
  assert.equal(resolveWorkspaceAgent(metadata, 'reviewer').displayName.en, 'Reviewer');
  for (const input of [
    { agents: [] }, { agents: metadata.agents },
    { ...metadata, defaultAgentId: 'missing' },
    { ...metadata, agents: [metadata.agents[0], metadata.agents[0]] },
    { agents: [{ id: '../evil', displayName: 'A' }] },
    { agents: [{ id: 'main', displayName: '' }] }, { defaultAgentId: 'reviewer' },
  ]) assert.throws(() => normalizeWorkspaceAgents(input), { code: 'invalid_workspace_agent' });
  for (const id of ['', null, 1, 'missing']) assert.throws(() => resolveWorkspaceAgent(metadata, id));
});

test('derived sessions retain their Agent even when the default changes', () => {
  const changed = { ...metadata, defaultAgentId: 'reviewer' };
  assert.equal(resolveNewSessionAgent(changed), 'reviewer');
  assert.equal(resolveNewSessionAgent(changed, {}, {}), 'main');
  assert.equal(resolveNewSessionAgent(changed, {}, { workspaceAgentId: 'reviewer' }), 'reviewer');
  assert.throws(() => resolveNewSessionAgent(metadata, { workspaceAgentId: 'main' }, { workspaceAgentId: 'reviewer' }));
});

test('each session selects its own assembly, missing exports fail explicitly', () => {
  class Main {} class Reviewer {}
  const module = { default: Main, agents: { reviewer: Reviewer } };
  assert.ok(new (resolveWorkspaceAgentClass(module, 'main'))() instanceof Main);
  assert.ok(new (resolveWorkspaceAgentClass(module, 'reviewer'))() instanceof Reviewer);
  assert.throws(() => resolveWorkspaceAgentClass({ default: Main }, 'reviewer'));
  assert.equal(resolveWorkspaceAgentClass({ Main }, 'main'), Main);
  assert.throws(() => resolveWorkspaceAgentClass({ Main, Reviewer }, 'main'));
});

// ── 前端欢迎名解析：真实 import 路线（ESM 迁移配方·测试改造）──────────
// workspace-agents.js 已迁 ESM（P2 W1-4）：宿主状态经 ESM owner 的 setter 写入
// （与生产 claim 后同一份状态），仍为 classic 的解析函数以 window 桩提供，转义
// 与语言走真实 ESM 依赖（markdown-utils / i18n-environment-state）。
let cleanupStubs = null;
let agentStore = null;
let orchestration = null;
let i18n = null;
let agentLoader = null;
let workspaceAgents = null;

const sessionCatalog = {
  ...metadata,
  source: 'prebuilt',
  workspace_sessions: { activeSessionId: 'other', sessions: [{ id: 's1', workspaceAgentId: 'main' }, { id: 's2', workspaceAgentId: 'reviewer' }] },
};

before(async () => {
  cleanupStubs = installBrowserStubs({
    window: {
      // vendor 面：index.html 的 marked UMD 标签先于 module 标签执行，markdown-utils
      // 在求值期就要 `new marked.Renderer()`。
      marked: new Marked(),
      escapeHtml: (text) => String(text).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
      ClawFW: { actions: { registerMany() {} } },
      // runtime-status（P4 T2 迁 ESM）在模块求值期启动 200ms 通知时钟与
      // 指示块刷新；本用例只验证工作空间 Agent 声明解析，不需要真实计时。
      setInterval: () => 0,
      clearInterval: () => {},
      setTimeout: (cb) => { setTimeout(cb, 0); return 0; },
      queueMicrotask: (cb) => queueMicrotask(cb),
    },
  });
  await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
  // agent-loader 宿主在装载期读取 classic 适配面（P1 已迁宿主，直接 import）
  window.AgentLoaderHost = { loadedAgentDetailIds: new Set() };
  // agent-loader-host → template-engine → p2-bootstrap-session-switch 会取 app-core 的
  // P2 bootstrap 宿主工厂。app-core 自 P4 T5 起是 ESM：本模块在模块相求值，工厂与
  // 桥键一起注册到当前 window（domain `app-core`），宿主状态仍是该模块那一份。
  // session-view-state 自 P4 T2 起是 ESM，且会话提交策略宿主改由 session-view-commit-host
  // 具名 import（不再在求值期经 window 抓 classic 实现）——本夹具也不需要它的 classic 前置。
  await import('../public/src/app-core.js');
  // sidebar-render / runtime-status 的宿主工厂面已全部接到 window（上一段循环），
  // 它们的 ESM 静态链随下面的 agentLoader / workspace-agents 求值装载（B2b：
  // sidebar-operations → p2-bootstrap-sidebar → sidebar-render → runtime-status）。
  for (const [name, factory] of Object.entries({
    createWorkspaceSurfaceHost: () => ({}),
    createPollCoordinatorHost: () => ({}),
    createRuntimeSwitchHost: () => ({ state: {} }),
    createCompactResumeHost: () => ({}),
  })) {
    if (typeof window[name] !== 'function') window[name] = factory;
  }
  // 无唯一 query → 与域模块内部 import 同址，共用同一模块实例（状态唯一 owner）
  agentStore = await import('../public/src/modules/agent-store-state.js');
  orchestration = await import('../public/src/modules/orchestration-state.js');
  i18n = await import('../public/src/modules/i18n-environment-state.js');
  agentLoader = await import('../public/src/modules/agent-loader-host.js');
  workspaceAgents = (await loadModuleOnce('public/src/modules/workspace-agents.js', { installGlobals: false })).module;
});

after(() => { cleanupStubs(); });

/** 每例复位：状态经 owner setter 写入，classic 解析函数按例换桩。 */
function resetWelcome(overrides = {}) {
  agentStore.setAllAgents([sessionCatalog]);
  agentStore.setFocusedAgentId('programming-helper');
  orchestration.setCurrentRuntimeAgentId('r1');
  i18n.setCurrentLanguage('zh');
  window.getCurrentSessionViewIdentity = () => null;
  window.readCurrentSessionViewState = () => ({ sessionMeta: null });
  window.getRuntimeWorkspaceSessionId = () => '';
  window.getLogicalAgentId = (record) => record?.id || '';
  window.splitRemoteNamespaceId = () => null;
  window.localizeWorkspaceValue = (value, fallback = '') => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') return value[i18n.getCurrentLanguage()] || value.en || value.zh || fallback;
    return fallback;
  };
  for (const [key, value] of Object.entries(overrides)) window[key] = value;
}

test('welcome follows the selected Session, not workspace active/title/default; handles language and unknown identity', () => {
  resetWelcome({
    getCurrentSessionViewIdentity: () => ({ agentId: 'programming-helper', sessionId: 's2' }),
  });
  assert.equal(workspaceAgents.getWelcomeName(), '审查助手');
  i18n.setCurrentLanguage('en');
  assert.equal(workspaceAgents.getWelcomeName(), 'Reviewer');
  i18n.setCurrentLanguage('zh');
  window.getCurrentSessionViewIdentity = () => ({ agentId: 'programming-helper', sessionId: 's1' });
  assert.equal(workspaceAgents.getWelcomeName(), '编程小助手');
  window.getCurrentSessionViewIdentity = () => ({ agentId: 'programming-helper', sessionId: 'unknown' });
  assert.equal(workspaceAgents.getWelcomeName(), '', 'unknown Session falls back to the generic welcome title');
});

test('the classic-phase initial state produces no welcome name', () => {
  // 首屏同步渲染（app-main 顶层 applyLanguage → getEmptyStateHtml）时的真实初始
  // 状态：catalog 为空、无焦点、无身份、agent 详情桥尚未装载。
  resetWelcome();
  agentStore.setAllAgents([]);
  agentStore.setFocusedAgentId(null);
  orchestration.setCurrentRuntimeAgentId(null);
  assert.equal(workspaceAgents.getWelcomeName(), '');
});

test('bound metadata survives view normalization and overrides stale catalog', () => {
  resetWelcome({
    getCurrentSessionViewIdentity: () => ({ agentId: 'programming-helper', sessionId: 's1' }),
  });
  window.readCurrentSessionViewState = () => ({ sessionMeta: { sessionId: 's1', workspaceAgentId: 'reviewer' } });
  assert.equal(workspaceAgents.getWelcomeName(), '审查助手');
});

test('remote welcome resolves a namespaced Session against the remote detail payload', async () => {
  resetWelcome({
    getCurrentSessionViewIdentity: () => ({ agentId: 'remote:host:workspace', sessionId: 'remote:host:remote-session' }),
    splitRemoteNamespaceId: (value) => {
      const match = /^remote:([^:]+):(.*)$/.exec(value);
      return match ? { connectionId: match[1], innerId: match[2] } : null;
    },
  });
  agentStore.setAllAgents([]);
  // 远程宿主的详情载荷来自真实 agent-loader（宿主依赖由 window 桩提供）
  const detail = {
    id: 'remote:host:workspace',
    agents: [{ id: 'reviewer', displayName: '远程审查助手' }],
    workspace_sessions: { sessions: [{ id: 'remote-session', workspaceAgentId: 'reviewer' }] },
  };
  window.fetch = async (url) => {
    assert.match(String(url), /\/protoclaw\/agent_detail\?agentId=remote%3Ahost%3Aworkspace/);
    return { ok: true, json: async () => detail };
  };
  await agentLoader.loadAgentDetail('remote:host:workspace');
  assert.equal(workspaceAgents.getWelcomeName(), '远程审查助手');
});

test('single Agent and derived sessions need no selection dialog', async () => {
  resetWelcome();
  const action = { type: 'create_session' };
  assert.equal(await workspaceAgents.selectForNewSession({ agents: [metadata.agents[0]] }, action), action);
  const derived = { type: 'create_session', sessionId: 'source' };
  assert.equal(await workspaceAgents.selectForNewSession(metadata, derived), derived);
});

test('multi-Agent hosts ask for the Agent and pin it on the action', async () => {
  resetWelcome();
  const fake = pickerDocument();
  const prevDocument = globalThis.document;
  globalThis.document = fake.document;
  try {
    const pending = workspaceAgents.selectForNewSession(metadata, { type: 'create_session' });
    assert.match(fake.overlay.innerHTML, /value="reviewer"/);
    assert.match(fake.overlay.innerHTML, /value="main" selected/);
    fake.listeners.get('submit')({ preventDefault() {} });
    const result = await pending;
    assert.equal(result.workspaceAgentId, 'reviewer', 'the selected Agent is pinned on the create_session action');
  } finally {
    globalThis.document = prevDocument;
  }
});

test('cancelling the picker aborts the create_session action', async () => {
  resetWelcome();
  const fake = pickerDocument();
  const prevDocument = globalThis.document;
  globalThis.document = fake.document;
  try {
    const pending = workspaceAgents.selectForNewSession(metadata, { type: 'create_session' });
    fake.listeners.get('click')({ target: fake.overlay });
    assert.equal(await pending, null);
  } finally {
    globalThis.document = prevDocument;
  }
});

test('the ClawFW namespace keeps exposing the same entries to classic consumers', () => {
  assert.equal(window.ClawFW.workspaceAgents.getWelcomeName, workspaceAgents.getWelcomeName);
  assert.equal(window.ClawFW.workspaceAgents.selectForNewSession, workspaceAgents.selectForNewSession);
});

/** 选择弹窗的最小 DOM：form submit 与遮罩点击两条出口。 */
function pickerDocument() {
  const listeners = new Map();
  const select = { value: 'reviewer', focus() {} };
  const form = { addEventListener(_type, callback) { listeners.set('submit', callback); } };
  const cancelButton = { addEventListener() {} };
  const overlay = {
    className: '',
    innerHTML: '',
    isConnected: true,
    addEventListener(type, callback) { listeners.set(type, callback); },
    querySelector(selector) {
      if (selector === 'form') return form;
      if (selector === 'select') return select;
      if (selector === 'button[type="button"]') return cancelButton;
      return null;
    },
    querySelectorAll() { return [select]; },
    remove() { overlay.isConnected = false; },
  };
  return {
    listeners,
    overlay,
    select,
    document: {
      activeElement: null,
      createElement: () => overlay,
      addEventListener() {},
      removeEventListener() {},
      body: { appendChild() {} },
    },
  };
}

const root = await mkdtemp(join(tmpdir(), 'claw-workspace-agents-'));
process.env.AGENTDEV_DATA_DIR = root;
after(async () => {
  const { closeAllSessionDbs } = await import('../server/shared/session-access.js');
  closeAllSessionDbs(); // Windows 下打开的 db 句柄会让 rm 报 EBUSY
  await rm(root, { recursive: true, force: true });
});
const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { readSessionIndex } = await import('../server/shared/session-access.js');
const { buildLightPrebuiltSessionRecord, sessionRecordToWorkspaceMeta, buildChildRuntimeAgent } = await import('../server/routes/session-helpers-pure.js');

test('real session creation persists, restores, derives and projects the binding without changing OS addressing', async () => {
  const api = createSessionHelpers({
    discoverAgents: async () => [metadata],
    enrichAgent: async (agent) => agent,
    readWorkspaceState: async () => ({ forms: {}, openDirectory: '' }),
    writeWorkspaceState: async () => {},
  });
  const create = (options) => api.createPrebuiltSession(metadata.id, { returnSummary: false, ...options });
  const first = await create({ workspaceAgentId: 'reviewer' });
  const second = await create({});
  const derived = await create({ sourceSessionId: first.id });
  assert.equal(first.workspaceAgentId, 'reviewer');
  assert.equal(second.workspaceAgentId, 'main');
  assert.equal(derived.workspaceAgentId, 'reviewer');
  await assert.rejects(create({ workspaceAgentId: 'missing' }), { code: 'invalid_workspace_agent' });
  await assert.rejects(create({ sourceSessionId: first.id, workspaceAgentId: 'main' }));
  const restored = await api.activatePrebuiltSession(metadata.id, first.id, { returnSummary: false });
  assert.equal(restored.workspaceAgentId, 'reviewer');
  const index = await readSessionIndex(metadata.id);
  assert.equal(index.sessions.find((entry) => entry.id === first.id).workspaceAgentId, 'reviewer');
  const light = buildLightPrebuiltSessionRecord(metadata.id, first);
  assert.equal(light.workspaceAgentId, 'reviewer');
  const child = buildChildRuntimeAgent({ id: 'runtime', connected: true }, { agentId: metadata.id, sessionId: first.id, sessionMeta: sessionRecordToWorkspaceMeta(first) });
  assert.equal(child.workspaceAgentId, 'reviewer');
  assert.equal(child.parent_id, metadata.id);
  assert.equal(child.active_workspace_session_id, first.id);

  const { getPrebuiltSessionFilePath, updateSessionIndex } = await import('../server/shared/session-access.js');
  const { exportHistoryOnlyHandoffPackage } = await import('../server/context-continuity/handoff-package.js');
  const { writeSummarizedHandoffPackage } = await import('../server/context-continuity/summarized-handoff.js');
  const snapshotPath = getPrebuiltSessionFilePath(metadata.id, first.id);
  await writeFile(snapshotPath, JSON.stringify({ runtime: { callIndex: 0, callState: 'idle', featureStates: [], context: { messages: [{ role: 'user', content: 'Hello', turn: 0 }] } } }));
  for (const exportHandoff of [
    () => exportHistoryOnlyHandoffPackage({ userDataRoot: root, agentId: metadata.id, sessionId: first.id, sessionPath: snapshotPath, sourceRecord: first }),
    () => writeSummarizedHandoffPackage({ userDataRoot: root, agentId: metadata.id, sessionId: first.id, sourceRecord: first, summaryText: 'Continue the task.' }),
  ]) {
    const exported = await exportHandoff();
    assert.equal(exported.handoff.sourceRecord.workspaceAgentId, 'reviewer');
    const resumed = await api.createCompactedResumeFromHandoff({ preferredAgentId: metadata.id, handoffPath: exported.handoffPath, startRuntime: false });
    assert.equal(resumed.session.workspaceAgentId, 'reviewer');
  }

  const { setupSessionRoutes } = await import('../server/routes/session.js');
  let branchHandler;
  setupSessionRoutes({ get() {}, put() {}, delete() {}, post(route, ...handlers) { if (route === '/protoclaw/sessions/branch') branchHandler = handlers.at(-1); } },
    { json: () => () => {} }, { ...api, requireAgentLight: async () => metadata, readSessionIndex, updateSessionIndex, startManagedAgent: async () => {}, waitForManagedRuntimeReady: async () => null });
  let branchResult;
  await branchHandler({ body: { agentId: metadata.id, sourceSessionId: first.id, cutMsgIndexEnd: 0 } },
    { json(value) { branchResult = value; }, status() { return this; } }, (error) => { throw error; });
  assert.equal(branchResult.ok, true);
  assert.equal(branchResult.sessionDelta.upsert[0].workspaceAgentId, 'reviewer');
});
