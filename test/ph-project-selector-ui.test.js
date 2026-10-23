/**
 * Ticket 045 — PH 项目选择器与对话 UI（VM 沙箱驱动真实前端源码）。
 *
 * 覆盖：
 *  - 纯目录无回归（目录组 / 新对话 openDirectory / 无 projectId）
 *  - 同目录 D/A/B：两组选择器、切片隔离、新建对话动作显式 projectId
 *  - phSwitchProject 前端项目切换（无 ph_project/switch 调用）、未知项目拒绝
 *  - 新建项目对话框：取消无副作用 / 托管创建 / 外部目录 / 空项目可见
 *  - 名称相同 ID 独立
 *  - typed target 不被 workspace_state.openDirectory 漂移覆盖（轮询参数）
 *  - 搜索归属身份 + 快速切换 stale 拒绝
 *  - 恢复卡片按完整归属过滤（项目目标 / 目录目标）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marked } from 'marked';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };

/** 新建项目对话框的智能元素：querySelector 按选择器映射到预置桩。 */
function createDialogDom() {
  const nameInput = { value: '', focus() {} };
  const dirInput = { value: '' };
  const errorEl = { hidden: true, textContent: '' };
  const submitBtn = { disabled: false };
  const form = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const browse = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const cancelBtn = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const refs = {
    '#ph-new-project-name': nameInput,
    '#ph-new-project-dir': dirInput,
    '.ph-new-project-error': errorEl,
    'button[type="submit"]': submitBtn,
    'form': form,
    '.ph-new-project-browse': browse,
  };
  const created = [];
  const makeElement = () => {
    const el = {
      className: '', id: '', innerHTML: '', removed: false,
      appendChild() {}, remove() { el.removed = true; },
      addEventListener() {}, removeEventListener() {},
      querySelector: (sel) => refs[sel] || null,
      querySelectorAll: (sel) => (sel === '.ph-new-project-cancel' ? [cancelBtn, cancelBtn] : []),
      classList: { add() {}, remove() {}, contains: () => false },
    };
    created.push(el);
    return el;
  };
  return { refs, makeElement, created, nameInput, dirInput, errorEl, submitBtn, form, browse, cancelBtn };
}

/**
 * 渲染主夹具：加载 project-data / ph-project-actions / session-list-render /
 * ph-session-list 真实源码。entities 预置进实体缓存（跳过网络往返）。
 */
function createSetup({ entities = [], target = null, openDirectory = '', phProjects = [], sessionsMeta = null } = {}) {
  const agent = {
    id: 'programming-helper',
    modelPresets: { default: { primary: 'm1' } },
    workspace_sessions: sessionsMeta,
    // project-data.js 自带 getAgentWorkspaceState(agent) 读 agent.workspace_state
    // （vm 内函数声明会遮蔽 overrides 注入的同名桩），状态必须挂在 agent 上
    workspace_state: null,
  };
  const workspaceState = { openDirectory, phProjects };
  agent.workspace_state = workspaceState;
  const requests = [];
  const fetchLog = [];
  const alerts = [];
  const cardCalls = [];
  const tabsRoot = {
    dataset: { searchAgentId: 'programming-helper', searchDirectory: '', searchProjectId: '', searchRemote: 'false', searchHostId: 'programming-helper' },
    classList: { add() {}, remove() {}, contains: () => false },
  };
  const searchPanel = { innerHTML: '' };
  const dialog = createDialogDom();
  const openContainer = { innerHTML: '' };

  const ctx = createFrontendSandbox({
    URLSearchParams, marked,
    phSearchQuery: '', _phSearchTimer: null, savedPhTabState: {}, phSessionSortMode: 'updatedAt',
    currentLanguage: 'zh',
    lastRenderedWorkspaceHtml: '',
    renderCurrentMainView() {},
    getCurrentAgentRecord: () => agent,
    getAgentWorkspaceState: () => workspaceState,
    getWorkspaceSessions: (a) => (a?.workspace_sessions?.sessions) || [],
    updateAgentRecord: (id, patch) => { Object.assign(agent, patch); },
    isPhStyleWorkspaceAgent: (a) => a?.id === 'programming-helper',
    isRemoteNamespaceAgentId: () => false,
    getClawModelPresets: () => [{ name: 'm1' }],
    projectViewIdentity: (a) => a.id,
    viewCapabilityEnabled: () => true,
    getTimeGroupLabel: () => '',
    sortPhSessionsByMode: (list) => [...list].sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1)),
    t: (k) => k,
    formatWorkspaceDate: (s) => String(s || ''),
    renderSessionTokenBar: () => '',
    renderSessionResumeBadge: () => '',
    renderSessionTodoBadge: () => '',
    renderSessionArchivedBadge: (s) => (s.archived ? '已归档' : ''),
    renderSessionTitleAiButton: () => '',
    getSessionShortTime: () => '', getSessionRecencyClass: () => '',
    mergeWorkspaceSessionSnapshots: (o, n) => ({ ...o, ...n, sessions: [...(o?.sessions || []), ...(n?.sessions || [])] }),
    _phOpenSessionsCache: { html: '' },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    allAgents: [agent],
    fetch(url, opts) {
      fetchLog.push({ url, opts });
      return new Promise((resolve) => requests.push({ url, opts, resolve }));
    },
    alert: (m) => alerts.push(m),
    document: {
      querySelector: (s) => (s === '.ph-session-tabs' ? tabsRoot : s === '.ph-search-panel' ? searchPanel : null),
      querySelectorAll: () => [],
      getElementById: (id) => (id === 'ph-open-sessions-container' ? openContainer : null),
      addEventListener() {}, removeEventListener() {},
      body: { appendChild() {} },
      activeElement: null,
      createElement: () => dialog.makeElement(),
    },
  });
  ctx.window.alert = (m) => alerts.push(m);
  ctx.window.phLoadOpenSessionsCard = (...args) => { cardCalls.push(args); };
  ctx.loadSource('public/src/modules/project-data.js');
  ctx.loadSource('public/src/modules/ph-project-actions.js');
  ctx.loadSource('public/src/modules/session-list-render.js');
  ctx.loadSource('public/src/modules/ph-session-list.js');
  // 实体缓存预置（真实 normalize 语义）：loaded=true 后 ensure 短路
  const store = ctx.window.ClawFW.phProjectEntities;
  store.projects = entities.map((raw) => ctx.run(`normalizePhProjectEntity(${JSON.stringify(raw)})`)).filter(Boolean);
  store.loaded = true;
  if (target) {
    ctx.run(`setPhBrowsingTarget('programming-helper', ${JSON.stringify(target)})`);
  }
  ctx.__agent = agent;
  // updateAgentRecord（project-data 真实现）会替换 vm 全局 allAgents 里的条目，
  // 变更后的 agent 要从 vm 侧读；渲染也始终用最新条目
  const currentAgent = () => ctx.run('allAgents.find((a) => a.id === "programming-helper")') || agent;
  const render = () => {
    ctx.__agent = currentAgent();
    return ctx.run('_renderProgrammingHelperSessionList(__agent, {}, { desc: "d" })');
  };
  return { ctx, agent, currentAgent, workspaceState, requests, fetchLog, alerts, cardCalls, tabsRoot, searchPanel, dialog, render };
}

const resolve = async (entry, data, ok = true) => {
  entry.resolve({ ok, status: ok ? 200 : 500, json: async () => data });
  await flush();
};

describe('045 selector — 纯目录无回归', () => {
  it('单一目录：目录组 + 常驻下拉 + 新建对话携带 openDirectory 而非 projectId', () => {
    const s = createSetup({
      openDirectory: 'D:/alpha',
      phProjects: [{ openDirectory: 'D:/alpha' }],
      sessionsMeta: {
        sessions: [{ id: 's1', title: 'Dir chat', updatedAt: '2026-10-20T10:00:00Z', openDirectory: 'D:/alpha', messageCount: 2 }],
        sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    });
    const html = s.render();
    assert.match(html, /Dir chat/);
    // 常驻下拉：目录组（旧行为的目录条目仍在）+ 新建项目入口
    assert.match(html, /ph-project-dropdown/);
    assert.match(html, /ph-project-dropdown-group-label[^>]*>目录</);
    assert.doesNotMatch(html, /ph-project-dropdown-group-label[^>]*>项目</);
    assert.match(html, /ph-project-dropdown-new/);
    assert.match(html, /新建项目…/);
    // 新对话动作：目录身份（openDirectory 有值，无 projectId 键）
    const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
    const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(parsed.openDirectory, 'D:/alpha');
    assert.equal(parsed.projectId, undefined);
    // 恢复卡片调度：目录身份（目录桶 id，非 prj_ 项目身份）
    assert.ok(s.cardCalls.some((args) => args[1] === 'D:/alpha' && !String(args[2]).startsWith('prj_')));
  });
});

describe('045 selector — 同目录 D/A/B', () => {
  const entities = [
    { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
    { id: 'prj_B', name: 'Beta', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
  ];
  const base = {
    entities,
    openDirectory: 'D:/shared',
    phProjects: [{ openDirectory: 'D:/shared' }],
  };

  it('项目目标：两组并存、active 归属、切片只含项目会话、动作显式 projectId', () => {
    const s = createSetup({
      ...base,
      target: { type: 'project', id: 'prj_A' },
      sessionsMeta: {
        sessions: [{ id: 'sA', title: 'A chat', updatedAt: '2026-10-21T10:00:00Z', projectId: 'prj_A', messageCount: 1 }],
        sessionProjectId: 'prj_A', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    });
    const html = s.render();
    // 两组：目录（D:/shared 桶）+ 项目（Alpha/Beta）
    assert.match(html, /ph-project-dropdown-group-label[^>]*>目录</);
    assert.match(html, /ph-project-dropdown-group-label[^>]*>项目</);
    assert.match(html, /data-project-id="dir:d:\/shared"/);
    assert.match(html, /data-project-id="prj_A"/);
    assert.match(html, /data-project-id="prj_B"/);
    // active 是 prj_A（项目目标切换后目录桶不 active）
    assert.match(html, /ph-project-dropdown-item active" data-project-id="prj_A"/);
    assert.doesNotMatch(html, /ph-project-dropdown-item active" data-project-id="dir:d:\/shared"/);
    // 头部显示项目名（不是目录叶名）
    assert.match(html, /ph-project-header-name[^>]*>Alpha</);
    // 切片只含项目会话（目录会话不在项目切片内）
    assert.match(html, /A chat/);
    // 新对话动作：显式 projectId，openDirectory 为空
    const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
    const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(parsed.projectId, 'prj_A');
    assert.equal(parsed.openDirectory, '');
    // 恢复卡片调度携带项目身份
    assert.ok(s.cardCalls.some((args) => args[2] === 'prj_A'));
  });

  it('目录目标（同目录）：目录组 active、动作走 openDirectory、无 projectId', () => {
    const s = createSetup({
      ...base,
      target: { type: 'dir', id: 'dir:d:/shared' },
      sessionsMeta: {
        sessions: [{ id: 'sD', title: 'Dir chat', updatedAt: '2026-10-21T11:00:00Z', openDirectory: 'D:/shared', messageCount: 3 }],
        sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    });
    const html = s.render();
    assert.match(html, /ph-project-dropdown-item active" data-project-id="dir:d:\/shared"/);
    const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
    const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(parsed.openDirectory, 'D:/shared');
    assert.equal(parsed.projectId, undefined);
    assert.match(html, /Dir chat/);
  });

  it('前端项目切换：按 projectId 拉切片、不调用 ph_project/switch、目标持久化', async () => {
    const s = createSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } });
    const switched = s.ctx.run('window.phSwitchProject("prj_B")');
    await flush();
    const req = s.fetchLog.find((f) => f.url.includes('/protoclaw/prebuilt_sessions'));
    assert.ok(req, 'project slice fetch should fire');
    assert.match(req.url, /projectId=prj_B/);
    assert.doesNotMatch(req.url, /projectDir=/);
    assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/ph_project/switch')), 'project switch must stay frontend-only');
    await resolve(s.requests.at(-1), { sessions: [{ id: 'sB', title: 'B chat', updatedAt: '2026-10-22T09:00:00Z', projectId: 'prj_B', messageCount: 1 }], sessionProjectId: 'prj_B', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 });
    await switched;
    assert.equal(s.currentAgent().workspace_sessions.sessionProjectId, 'prj_B');
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(JSON.parse(stored).id, 'prj_B');
  });

  it('未知项目：显式失败（不退回另一个目标、不发切片请求）', async () => {
    const s = createSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } });
    await s.ctx.run('window.phSwitchProject("prj_missing")');
    assert.ok(s.alerts.some((m) => String(m).includes('prj_missing')));
    assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/prebuilt_sessions')));
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(JSON.parse(stored).id, 'prj_A', 'target unchanged on unknown project');
  });
});

describe('045 — 新建项目对话框', () => {
  const entities = [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' }];

  it('取消：对话框关闭、无网络副作用、无目标变更', async () => {
    const s = createSetup({ entities, phProjects: [{ openDirectory: 'D:/shared' }], openDirectory: 'D:/shared' });
    s.ctx.run('window.phOpenNewProjectDialog()');
    // created[0]=host, created[1]=overlay；取消按钮 click 绑定 close()
    const overlay = s.dialog.created[1];
    (s.dialog.cancelBtn.listeners.click || []).forEach((fn) => fn());
    assert.equal(overlay.removed, true, 'overlay should close on cancel');
    assert.equal(s.fetchLog.length, 0);
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(stored, null);
  });

  it('托管创建：名称必填、无 workDirectory 键、创建后进入空项目（不建会话）', async () => {
    const s = createSetup({ entities, phProjects: [{ openDirectory: 'D:/shared' }], openDirectory: 'D:/shared' });
    s.ctx.run('window.phOpenNewProjectDialog()');
    s.dialog.nameInput.value = 'Managed';
    const submit = s.dialog.form.listeners.submit[0];
    const job = submit({ preventDefault() {} });
    const createReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_create'));
    assert.ok(createReq, 'create request fired');
    const body = JSON.parse(createReq.opts.body);
    assert.equal(body.name, 'Managed');
    assert.equal(body.workDirectory, undefined, 'managed creation omits workDirectory');
    await resolve(s.requests.at(-1), { ok: true, project: { id: 'prj_new', name: 'Managed', workDirectory: 'D:/managed/prj_new' } });
    // 实体刷新
    const listReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/projects'));
    assert.ok(listReq, 'entities refresh fired');
    await resolve(s.requests.at(-1), { ok: true, projects: [
      { id: 'prj_new', name: 'Managed', workDirectory: 'D:/managed/prj_new', createdAt: '2026-10-23', updatedAt: '2026-10-23' },
      ...entities,
    ] });
    // 空项目切片
    const sliceReq = s.fetchLog.filter((f) => f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
    assert.ok(sliceReq && sliceReq.url.includes('projectId=prj_new'));
    assert.ok(!s.fetchLog.some((f) => f.url.includes('create_session')), 'creation itself must not open a session');
    await resolve(s.requests.at(-1), { sessions: [], sessionProjectId: 'prj_new', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
    await job;
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(JSON.parse(stored).id, 'prj_new');
    // 空项目可见：空态提示 + 新建对话按钮（显式 projectId）
    const html = s.render();
    assert.match(html, /workspace_feature_no_sessions/);
    const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
    const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(parsed.projectId, 'prj_new');
  });

  it('外部目录创建：携带 workDirectory', async () => {
    const s = createSetup({ entities, phProjects: [{ openDirectory: 'D:/shared' }], openDirectory: 'D:/shared' });
    s.ctx.run('window.phOpenNewProjectDialog()');
    s.dialog.nameInput.value = 'External';
    s.dialog.dirInput.value = 'E:/ext';
    const job = s.dialog.form.listeners.submit[0]({ preventDefault() {} });
    const createReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_create'));
    const body = JSON.parse(createReq.opts.body);
    assert.equal(body.workDirectory, 'E:/ext');
    await resolve(s.requests.at(-1), { ok: false, error: 'stop here' });
    await job;
  });

  it('名称为空：本地校验，不发请求', async () => {
    const s = createSetup({ entities, phProjects: [{ openDirectory: 'D:/shared' }], openDirectory: 'D:/shared' });
    s.ctx.run('window.phOpenNewProjectDialog()');
    s.dialog.nameInput.value = '  ';
    await s.dialog.form.listeners.submit[0]({ preventDefault() {} });
    assert.ok(!s.fetchLog.some((f) => f.url.includes('project_create')));
    assert.equal(s.dialog.errorEl.hidden, false);
  });
});

describe('045 — 名称相同 ID 独立', () => {
  it('两个同名项目：下拉两条、切换按 ID 拉切片、持久化 ID', async () => {
    const entities = [
      { id: 'prj_1', name: 'Same', workDirectory: 'D:/x', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
      { id: 'prj_2', name: 'Same', workDirectory: 'D:/y', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
    ];
    const s = createSetup({ entities, phProjects: [{ openDirectory: 'D:/x' }], openDirectory: 'D:/x' });
    const html = s.render();
    assert.equal((html.match(/data-project-id="prj_\d"/g) || []).length, 2);
    const switched = s.ctx.run('window.phSwitchProject("prj_2")');
    await flush();
    const req = s.fetchLog.find((f) => f.url.includes('/protoclaw/prebuilt_sessions'));
    assert.match(req.url, /projectId=prj_2/);
    await resolve(s.requests.at(-1), { sessions: [], sessionProjectId: 'prj_2', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
    await switched;
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(JSON.parse(stored).id, 'prj_2');
  });
});

describe('045 — 轮询归属随 typed target（不被 workspace_state 漂移覆盖）', () => {
  const mainSource = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');
  const pollSource = sourceBetween(mainSource, 'async function fetchWorkspaceSessionsForPoll', 'function schedulePoll');

  function createPollSetup({ entities = [], target = null, openDirectory = '' } = {}) {
    const agent = {
      id: 'programming-helper',
      workspace_sessions: { sessions: [{ id: 's1', updatedAt: '2026-10-20T00:00:00Z' }], sessionTotal: 1 },
      workspace_state: null,
    };
    const workspaceState = { openDirectory, phProjects: openDirectory ? [{ openDirectory }] : [] };
    agent.workspace_state = workspaceState;
    const fetchLog = [];
    const ctx = createFrontendSandbox({
      URLSearchParams,
      allAgents: [agent],
      _wsSessionsRevisionByHost: new Map(),
    isPhStyleWorkspaceAgent: (a) => a?.id === 'programming-helper',
    isRemoteNamespaceAgentId: () => false,
      getAgentWorkspaceState: () => workspaceState,
      fetch(url) { fetchLog.push(url); return Promise.resolve({ ok: false }); },
    });
    ctx.loadSource('public/src/modules/project-data.js');
    const store = ctx.window.ClawFW.phProjectEntities;
    store.projects = entities.map((raw) => ctx.run(`normalizePhProjectEntity(${JSON.stringify(raw)})`)).filter(Boolean);
    store.loaded = true;
    if (target) ctx.run(`setPhBrowsingTarget('programming-helper', ${JSON.stringify(target)})`);
    ctx.__pollSource = pollSource;
    ctx.run(`${pollSource.replace(/^/, 'globalThis.fetchWorkspaceSessionsForPoll = ')}`);
    ctx.__agent = agent;
    return { ctx, fetchLog, workspaceState };
  }

  it('项目目标：projectId 参数；openDirectory 漂移不改变归属', async () => {
    const s = createPollSetup({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' }],
      target: { type: 'project', id: 'prj_A' },
      openDirectory: 'D:/shared',
    });
    await s.ctx.run('fetchWorkspaceSessionsForPoll("programming-helper", __agent)');
    assert.match(s.fetchLog[0], /projectId=prj_A/);
    assert.doesNotMatch(s.fetchLog[0], /projectDir=/);
    // 模拟 workspace_state.openDirectory 被轮询刷成别的目录（目录漂移）
    s.fetchLog.length = 0;
    s.workspaceState.openDirectory = 'D:/drifted';
    s.workspaceState.phProjects = [{ openDirectory: 'D:/drifted' }];
    await s.ctx.run('fetchWorkspaceSessionsForPoll("programming-helper", __agent)');
    assert.match(s.fetchLog[0], /projectId=prj_A/, 'typed target wins over drifted openDirectory');
    assert.doesNotMatch(s.fetchLog[0], /projectDir=/);
  });

  it('目录目标与无目标回退：projectDir 语义保持', async () => {
    const s = createPollSetup({ target: { type: 'dir', id: 'dir:d:/alpha' }, openDirectory: 'D:/alpha' });
    await s.ctx.run('fetchWorkspaceSessionsForPoll("programming-helper", __agent)');
    assert.match(s.fetchLog[0], /projectDir=D%3A%2Falpha/);
    const s2 = createPollSetup({ openDirectory: 'D:/beta' });
    await s2.ctx.run('fetchWorkspaceSessionsForPoll("programming-helper", __agent)');
    assert.match(s2.fetchLog[0], /projectDir=D%3A%2Fbeta/);
  });
});

describe('045 — 搜索归属与快速切换 stale', () => {
  const entities = [
    { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' },
    { id: 'prj_B', name: 'Beta', workDirectory: 'D:/shared' },
  ];

  it('项目目标搜索：请求携带 projectId（互斥）；身份漂移后旧响应不落地', async () => {
    const s = createSetup({ entities, phProjects: [{ openDirectory: 'D:/shared' }], openDirectory: 'D:/shared' });
    // 项目 A 搜索面（dataset 由渲染写入真实 DOM；沙箱内直接设置等价状态）
    Object.assign(s.tabsRoot.dataset, { searchProjectId: 'prj_A', searchDirectory: '' });
    s.ctx.run('window.phOnSearchInput("needle")');
    const reqA = s.fetchLog.find((f) => f.url.includes('/protoclaw/search_sessions'));
    assert.ok(reqA, 'search fired');
    assert.match(reqA.url, /projectId=prj_A/);
    assert.doesNotMatch(reqA.url, /openDirectory=/);
    // 快速切换到项目 B（身份漂移）：B 搜索先发出，A 的旧响应后到 → 拒绝
    Object.assign(s.tabsRoot.dataset, { searchProjectId: 'prj_B' });
    s.ctx.run('window.phOnSearchInput("needle")');
    const reqB = s.fetchLog.filter((f) => f.url.includes('/protoclaw/search_sessions')).at(-1);
    assert.match(reqB.url, /projectId=prj_B/);
    const results = s.requests.filter((r) => r.url.includes('/protoclaw/search_sessions'));
    await resolve(results[1], { results: [{ sessionId: 'rB', title: 'B hit', updatedAt: '2026-10-22', matchCount: 1, matches: [] }], total: 1 });
    await resolve(results[0], { results: [{ sessionId: 'rA', title: 'A hit', updatedAt: '2026-10-22', matchCount: 1, matches: [] }], total: 1 });
    const ids = s.ctx.window.ClawFW.phSearch.results.map((r) => r.sessionId);
    assert.deepEqual(ids, ['rB'], 'stale project-A response must not land');
  });

  it('目录目标搜索：openDirectory 参数、无 projectId', async () => {
    const s = createSetup({ phProjects: [{ openDirectory: 'D:/alpha' }], openDirectory: 'D:/alpha' });
    Object.assign(s.tabsRoot.dataset, { searchProjectId: '', searchDirectory: 'D:/alpha' });
    s.ctx.run('window.phOnSearchInput("needle")');
    const req = s.fetchLog.find((f) => f.url.includes('/protoclaw/search_sessions'));
    assert.match(req.url, /openDirectory=D%3A%2Falpha/);
    assert.doesNotMatch(req.url, /projectId=/);
  });
});

describe('045 — 恢复卡片按完整归属过滤', () => {
  const sessionUiSource = fs.readFileSync(new URL('../public/src/modules/session-ui.js', import.meta.url), 'utf8');

  function createCardSetup() {
    const container = { innerHTML: '' };
    const requests = [];
    const ctx = createFrontendSandbox({
      URLSearchParams,
      currentLanguage: 'zh',
      formatWorkspaceDate: (s) => String(s || ''),
      allAgents: [],
      fetch(url) { return new Promise((resolve) => requests.push({ url, resolve })); },
      document: {
        getElementById: (id) => (id === 'ph-open-sessions-container' ? container : null),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {},
        body: { appendChild() {} },
        createElement: () => ({ classList: { add() {}, remove() {} }, appendChild() {}, style: {} }),
        activeElement: null,
      },
    });
    // 入口屏蔽位是产品现状（功能整体保留但停用）；测试解锁以驱动真实过滤逻辑
    ctx.loadSourceInline = (src) => ctx.run(src);
    const patched = sessionUiSource.replace(
      'const PH_OPEN_SESSIONS_CARD_DISABLED = true',
      'const PH_OPEN_SESSIONS_CARD_DISABLED = false',
    );
    assert.notEqual(patched, sessionUiSource, 'disable flag should exist to patch');
    ctx.run(patched);
    return { ctx, container, requests };
  }

  const openPayload = {
    sessions: [
      { sessionId: 'oA', title: 'A open', updatedAt: '2026-10-22T01:00:00Z', projectId: 'prj_A' },
      { sessionId: 'oD', title: 'Dir open', updatedAt: '2026-10-22T02:00:00Z', openDirectory: 'D:/shared' },
      { sessionId: 'oB', title: 'B open', updatedAt: '2026-10-22T03:00:00Z', projectId: 'prj_B' },
    ],
  };

  it('项目目标：只显示本项目的未关闭会话（同目录目录会话不混入）', async () => {
    const s = createCardSetup();
    const job = s.ctx.run('window.phLoadOpenSessionsCard("programming-helper", "D:/shared", "prj_A")');
    await resolve(s.requests[0], openPayload);
    await job;
    assert.match(s.container.innerHTML, /oA/);
    assert.doesNotMatch(s.container.innerHTML, /oD/);
    assert.doesNotMatch(s.container.innerHTML, /oB/);
  });

  it('目录目标：只显示目录会话，项目会话（同 workDirectory）排除', async () => {
    const s = createCardSetup();
    const job = s.ctx.run('window.phLoadOpenSessionsCard("programming-helper", "D:/shared", "")');
    await resolve(s.requests[0], openPayload);
    await job;
    assert.match(s.container.innerHTML, /oD/);
    assert.doesNotMatch(s.container.innerHTML, /oA/);
    assert.doesNotMatch(s.container.innerHTML, /oB/);
  });
});
