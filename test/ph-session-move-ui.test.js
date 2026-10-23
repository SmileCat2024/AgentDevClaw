/**
 * PH 会话移动（sessions_move）前端行为（VM 沙箱驱动真实源码）。
 *
 * 覆盖：
 *  - 入口渲染：工具条多选（本地 PH only）、条目 checkbox、ctx 菜单项（本地 PH）
 *  - 弹窗目标：仅同目录（默认 ↔ 项目 ↔ 项目），当前归属禁用；跨目录不支持文案
 *  - 单条入口归属来源：会话记录冻结 owner（projectId/openDirectory），不取页面焦点
 *  - 请求形状：POST sessions_move { agentId, sessionIds, target }
 *  - busy 409：可读提示、不假成功、状态不动
 *  - 其他错误：payload.error 呈现
 *  - 成功：切片重拉 + 侧栏 loadAgents + 搜索 retry；已释放旧实例不沿用（loadAgents 重投影）
 *  - 异步竞态：移动期间浏览目标切换 → 不重拉、不覆盖
 *  - 多选状态：切目录/项目即清；渲染期和解清理不可见 id（模拟切片更换）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };

/** 移动弹窗智能元素：querySelector 按选择器映射。 */
function createMoveDialogDom() {
  const errorEl = { hidden: true, textContent: '' };
  const submitBtn = { disabled: false };
  const checkedRadio = { value: '' };
  const form = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const cancelBtn = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const radios = [];
  const refs = {
    '.ph-move-error': errorEl,
    'button[type="submit"]': submitBtn,
    'input[name="ph-move-target"]:checked': checkedRadio,
    'form': form,
  };
  const created = [];
  const makeElement = () => {
    const el = {
      className: '', id: '', innerHTML: '', removed: false,
      appendChild() {}, remove() { el.removed = true; },
      addEventListener() {}, removeEventListener() {},
      querySelector: (sel) => refs[sel] || null,
      querySelectorAll: (sel) => {
        if (sel === '.ph-move-cancel') return [cancelBtn, cancelBtn];
        if (sel === '.ph-move-target-item input[type="radio"]') return radios;
        return [];
      },
      classList: { add() {}, remove() {}, contains: () => false },
      getAttribute: () => null,
      setAttribute() {},
      closest: () => null,
    };
    created.push(el);
    return el;
  };
  return {
    refs, makeElement, created, errorEl, submitBtn, checkedRadio, form, cancelBtn,
    addRadio: (value) => { const radio = { value, checked: false, listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }, closest: () => null }; radios.push(radio); return radio; },
  };
}

function createSetup({ entities = [], target = null, openDirectory = 'D:/shared', sessionsMeta = null } = {}) {
  const agent = {
    id: 'programming-helper',
    modelPresets: { default: { primary: 'm1' } },
    workspace_sessions: sessionsMeta,
    workspace_state: null,
  };
  const workspaceState = { openDirectory, phProjects: [{ openDirectory }] };
  agent.workspace_state = workspaceState;
  const requests = [];
  const fetchLog = [];
  const alerts = [];
  const cardCalls = [];
  const loadAgentsCalls = [];
  const tabsRoot = {
    dataset: { searchAgentId: 'programming-helper', searchDirectory: '', searchProjectId: '', searchRemote: 'false', searchHostId: 'programming-helper' },
    classList: { add() {}, remove() {}, contains: () => false },
  };
  const searchPanel = { innerHTML: '' };
  const moveDialog = createMoveDialogDom();
  const openContainer = { innerHTML: '' };

  const ctx = createFrontendSandbox({
    URLSearchParams,
    phSearchQuery: '', _phSearchTimer: null, savedPhTabState: {}, phSessionSortMode: 'updatedAt',
    currentLanguage: 'zh',
    lastRenderedWorkspaceHtml: '',
    renderCurrentMainView() {},
    getCurrentAgentRecord: () => agent,
    getAgentWorkspaceState: () => workspaceState,
    getWorkspaceSessions: (a) => (a?.workspace_sessions?.sessions) || [],
    getWorkspaceSessionById: (a, sessionId) => ((a?.workspace_sessions?.sessions) || []).find((s) => s.id === sessionId) || null,
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
    escapeHtml: (v) => String(v ?? ''),
    renderSessionTokenBar: () => '',
    renderSessionResumeBadge: () => '',
    renderSessionTodoBadge: () => '',
    renderSessionArchivedBadge: () => '',
    renderSessionTitleAiButton: () => '',
    getSessionShortTime: () => '', getSessionRecencyClass: () => '',
    mergeWorkspaceSessionSnapshots: (o, n) => ({ ...o, ...n, sessions: [...(o?.sessions || []), ...(n?.sessions || [])] }),
    _phOpenSessionsCache: { html: '' },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    allAgents: [agent],
    loadAgents: async () => { loadAgentsCalls.push(Date.now()); },
    renderAgentList() {},
    phSearchRetry() { calls.searchRetry++; },
    fetch(url, opts) {
      fetchLog.push({ url, opts });
      return new Promise((resolve) => requests.push({ url, opts, resolve }));
    },
    alert: (m) => alerts.push(m),
    document: {
      querySelector: (s) => (s === '.ph-session-tabs' ? tabsRoot : s === '.ph-search-panel' ? searchPanel : null),
      querySelectorAll: (s) => {
        if (s === '.ph-select-count') return countEls;
        return [];
      },
      getElementById: (id) => (id === 'ph-open-sessions-container' ? openContainer : null),
      addEventListener() {}, removeEventListener() {},
      body: { appendChild() {} },
      activeElement: null,
      createElement: () => moveDialog.makeElement(),
    },
  });
  const countEls = [];
  const calls = { searchRetry: 0 };
  ctx.window.alert = (m) => alerts.push(m);
  ctx.window.phLoadOpenSessionsCard = (...args) => { cardCalls.push(args); };
  ctx.loadSource('public/src/modules/project-data.js');
  ctx.loadSource('public/src/modules/ph-project-actions.js');
  ctx.loadSource('public/src/modules/ph-session-move.js');
  ctx.loadSource('public/src/modules/session-list-render.js');
  ctx.loadSource('public/src/modules/ph-session-list.js');
  // 模块加载后挂观测桩（ph-session-list.js 等会定义同名 window 成员，先挂会被覆盖）
  ctx.window.loadAgents = async () => { loadAgentsCalls.push(Date.now()); };
  ctx.window.phSearchRetry = () => { calls.searchRetry++; };
  const store = ctx.window.ClawFW.phProjectEntities;
  store.projects = entities.map((raw) => ctx.run(`normalizePhProjectEntity(${JSON.stringify(raw)})`)).filter(Boolean);
  store.loaded = true;
  if (target) ctx.run(`setPhBrowsingTarget('programming-helper', ${JSON.stringify(target)})`);
  ctx.__agent = agent;
  const currentAgent = () => ctx.run('allAgents.find((a) => a.id === "programming-helper")') || agent;
  const render = () => {
    ctx.__agent = currentAgent();
    return ctx.run('_renderProgrammingHelperSessionList(__agent, {}, { desc: "d" })');
  };
  return { ctx, agent, currentAgent, workspaceState, requests, fetchLog, alerts, cardCalls, loadAgentsCalls, calls, moveDialog, render, countEls };
}

const resolveAt = async (s, entry, data, ok = true, status) => {
  const idx = s.requests.indexOf(entry);
  if (idx >= 0) s.requests.splice(idx, 1);
  entry.resolve({
    ok, status: status ?? (ok ? 200 : 500),
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  });
  await flush();
};

/** 持续消费在途请求（phLoadProjectSessions 链路会串行发多个 fetch）。 */
const drainRequests = async (s, dataFor) => {
  let guard = 0;
  while (s.requests.length > 0 && guard++ < 20) {
    const [entry] = s.requests.splice(0, 1);
    const data = dataFor(entry);
    entry.resolve({
      ok: true, status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    });
    await flush();
  }
};

const ENTITIES = [
  { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
  { id: 'prj_B', name: 'Beta', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
  { id: 'prj_X', name: 'Elsewhere', workDirectory: 'D:/other', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
];

const DIR_SLICE = (ids) => ({
  sessions: ids.map((id, i) => ({ id, title: 'Dir ' + id, updatedAt: '2026-10-2' + i + 'T10:00:00Z', openDirectory: 'D:/shared', messageCount: 1 })),
  sessionProjectId: '', sessionTotal: ids.length, mainTotal: ids.length, archivedTotal: 0,
});

describe('移动 — 入口渲染', () => {
  it('本地 PH 目录视图：工具条有多选按钮、无 checkbox；进入多选后 checkbox + 计数 + 移动入口', () => {
    const s = createSetup({
      entities: ENTITIES,
      sessionsMeta: DIR_SLICE(['s1', 's2']),
    });
    let html = s.render();
    assert.match(html, /ph-select-toggle-btn[^>]*>多选</);
    assert.doesNotMatch(html, /ph-session-select"/);
    s.ctx.run('window.phToggleSessionSelectMode()');
    html = s.render();
    assert.match(html, /ph-session-select"/);
    assert.match(html, /data-select-session-id="s1"/);
    assert.match(html, /ph-select-count[^>]*>0 已选</);
    assert.match(html, /ph-select-move-btn[^>]*>移动到…</);
    assert.match(html, /ph-select-exit-btn/);
  });

  it('远程目录视图不渲染多选入口（只本地 PH）', () => {
    const s = createSetup({ entities: [], sessionsMeta: DIR_SLICE(['r1']) });
    // 远程目录桶（ADR-0012）：目录本地不存在 → remoteOnly
    s.ctx.run(`
      getRemoteHistoryProjectBuckets = function () {
        return [{ openDirectory: '/srv/remote', sessions: [{ id: 'r1', title: 'R', updatedAt: '2026-10-22T10:00:00Z' }] }];
      };
    `);
    const remoteOk = s.ctx.run(`
      (function () {
        var agent = getCurrentAgentRecord();
        var projects = getProgrammingHelperProjects(agent);
        var remote = projects.find(function (p) { return p.remoteOnly; });
        return remote ? remote.id : '';
      })()
    `);
    assert.ok(remoteOk, 'remoteOnly bucket should be synthesized');
    // 导航到 remoteOnly 目录视图：入口隐藏
    const htmlGated = s.ctx.run(`
      (function () {
        var agent = getCurrentAgentRecord();
        agent.workspace_sessions = { sessions: [], sessionProjectId: '', sessionTotal: 0 };
        setPhBrowsingTarget('programming-helper', { type: 'dir', id: 'dir:/srv/remote' });
        lastRenderedWorkspaceHtml = '';
        return _renderProgrammingHelperSessionList(agent, {}, { desc: 'd' });
      })()
    `);
    assert.doesNotMatch(htmlGated, /ph-select-toggle-btn/, 'remoteOnly view must not offer local move UI');
    assert.match(htmlGated, /ph-org-selector/);
  });
});

describe('移动 — 弹窗目标与归属来源', () => {
  it('目录视图批量：目标 = 默认项目（当前归属禁用）+ 同目录项目；跨目录项目不出现', async () => {
    const s = createSetup({
      entities: ENTITIES,
      sessionsMeta: DIR_SLICE(['s1', 's2']),
    });
    s.render();
    s.ctx.run('window.phToggleSessionSelectMode()');
    s.ctx.run('window.phToggleSessionSelection("s1", true)');
    s.ctx.run('window.phToggleSessionSelection("s2", true)');
    s.ctx.run('window.phOpenSessionMoveDialog(["s1", "s2"])');
    const overlayHtml = s.moveDialog.created[1].innerHTML;
    assert.match(overlayHtml, /默认项目/);
    assert.match(overlayHtml, /Alpha/);
    assert.match(overlayHtml, /Beta/);
    assert.doesNotMatch(overlayHtml, /Elsewhere/, 'cross-directory project must not be a target');
    assert.match(overlayHtml, /跨目录移动暂不支持/, 'copy states cross-directory is unsupported');
    // 当前归属 = directory（批量全部是目录会话）→ 默认目标禁用
    assert.match(overlayHtml, /ph-move-target-item disabled">[^<]*<input[^>]*disabled/);
  });

  it('单条入口：归属从会话记录解析（项目会话 → 项目目录 + 当前项目禁用），不取页面焦点', async () => {
    // 页面焦点在目录视图，但被移动会话属于 prj_B —— 目标必须按 prj_B 的目录（D:/shared）构建
    const s = createSetup({
      entities: ENTITIES,
      sessionsMeta: {
        sessions: [
          { id: 'sD', title: 'Dir chat', updatedAt: '2026-10-22T10:00:00Z', openDirectory: 'D:/shared', messageCount: 1 },
          { id: 'sB', title: 'B chat', updatedAt: '2026-10-22T11:00:00Z', projectId: 'prj_B', messageCount: 1 },
        ],
        sessionProjectId: '', sessionTotal: 2, mainTotal: 2, archivedTotal: 0,
      },
    });
    s.render();
    s.ctx.run('window.phOpenSessionMoveDialog(["sB"])');
    const overlayHtml = s.moveDialog.created[1].innerHTML;
    assert.match(overlayHtml, /默认项目/);
    assert.match(overlayHtml, /Alpha/);
    // prj_B 是该会话当前归属 → 禁用；prj_A 可选（label 结构：class 先于名称文本）
    const segments = overlayHtml.split('ph-move-target-item');
    const seg = (name) => segments.find((s) => s.includes(name)) || '';
    assert.match(seg('Beta'), /^ disabled/, 'current owner project is disabled');
    assert.doesNotMatch(seg('Alpha'), /^ disabled/, 'other same-directory project is selectable');
    assert.doesNotMatch(overlayHtml, /Elsewhere/);
  });

  it('单条入口：归属不可解析（无实体、无目录）→ 显式失败，不猜测', async () => {
    const s = createSetup({
      entities: ENTITIES,
      sessionsMeta: {
        sessions: [{ id: 'sGhost', title: 'Ghost', updatedAt: '2026-10-22T10:00:00Z', projectId: 'prj_gone', messageCount: 1 }],
        sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    });
    s.render();
    s.ctx.run('window.phOpenSessionMoveDialog(["sGhost"])');
    assert.ok(s.alerts.some((m) => String(m).includes('无法确定')), 'unresolvable ownership fails visibly');
    assert.equal(s.moveDialog.created.length, 0, 'no dialog opens');
  });
});

describe('移动 — 请求与响应', () => {
  function openMoveForSelection(s) {
    s.render();
    s.ctx.run('window.phToggleSessionSelectMode()');
    s.ctx.run('window.phToggleSessionSelection("s1", true)');
    // 工具条批量入口：无参调用（勾选后实时读 selected，渲染期列表会过期）
    s.ctx.run('window.phOpenSessionMoveDialog()');
    // 目标 radio：s1 是目录会话（当前归属），目录默认项被禁用 → 选第一个项目（items[1]）
    s.moveDialog.addRadio('0');
    s.moveDialog.addRadio('1');
    s.moveDialog.checkedRadio.value = '1';
  }

  it('请求形状：POST sessions_move { agentId, sessionIds, target }', async () => {
    const s = createSetup({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) });
    openMoveForSelection(s);
    const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
    await flush();
    const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
    assert.ok(req, 'move request fired');
    assert.equal(req.opts.method, 'POST');
    assert.deepEqual(JSON.parse(req.opts.body), {
      agentId: 'programming-helper',
      sessionIds: ['s1'],
      target: { type: 'project', id: 'prj_A' },
    });
    await resolveAt(s, s.requests.at(-1), { ok: true, movedSessionIds: ['s1'], releasedSessionIds: [], revision: 4, target: { type: 'project', id: 'prj_A' } });
    // 成功链路会继续拉切片/实体——全部消费避免悬空
    await drainRequests(s, (entry) => (entry.url.includes('/protocloud') ? {} : (entry.url.includes('/protoclaw/prebuilt_sessions') ? DIR_SLICE(['s2']) : { state: { openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }] }, projects: [] })));
    await job;
  });

  it('busy 409：可读提示、弹窗保留、不假成功、无刷新副作用', async () => {
    const s = createSetup({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) });
    openMoveForSelection(s);
    const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
    await flush();
    const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
    await resolveAt(s, req, { code: 'ph_sessions_busy', error: 'sessions busy' }, false, 409);
    await job;
    assert.equal(s.moveDialog.errorEl.hidden, false);
    assert.match(s.moveDialog.errorEl.textContent, /正在执行/);
    assert.match(s.moveDialog.errorEl.textContent, /未做任何改动/);
    // 无刷新副作用：没有切片重拉 / loadAgents
    assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/prebuilt_sessions')));
    assert.equal(s.loadAgentsCalls.length, 0);
    // 多选状态保留（可重试）
    assert.equal(s.ctx.run('window.ClawFW.phSessionMove.selectMode'), true);
    assert.equal(s.ctx.run('window.ClawFW.phSessionMove.selected.size'), 1);
  });

  it('其他错误：payload.error 呈现', async () => {
    const s = createSetup({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) });
    openMoveForSelection(s);
    const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
    await flush();
    const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
    await resolveAt(s, req, { error: 'invalid target' }, false, 400);
    await job;
    assert.match(s.moveDialog.errorEl.textContent, /invalid target/);
  });

  it('成功：切片重拉（同归属）+ loadAgents 侧栏重投影 + 搜索 retry（有查询时）', async () => {
    const s = createSetup({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) });
    s.ctx.run('phSearchQuery = "needle"');
    openMoveForSelection(s);
    const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
    await flush();
    const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
    const moved = resolveAt(s, req, { ok: true, movedSessionIds: ['s1'], releasedSessionIds: ['s1'], revision: 5, target: { type: 'project', id: 'prj_A' } });
    await moved;
    // 切片重拉断言在 drain 前落账（fetchLog 保留全部历史）
    await drainRequests(s, (entry) => (entry.url.includes('/protoclaw/prebuilt_sessions') ? DIR_SLICE(['s2']) : { state: { openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }] }, projects: [] }));
    await job;
    // 切片重拉按当前归属（目录目标 → projectDir）
    const slice = s.fetchLog.filter((f) => f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
    assert.ok(slice, 'slice re-pulled');
    assert.match(decodeURIComponent(slice.url), /projectDir=D:\/shared/);
    assert.equal(s.loadAgentsCalls.length, 1, 'sidebar runtime re-projected (released instances not reused)');
    assert.equal(s.calls.searchRetry, 1, 'active search re-ran');
    // 多选状态清空
    assert.equal(s.ctx.run('window.ClawFW.phSessionMove.selectMode'), false);
  });

  it('异步竞态：移动期间浏览目标切换 → 不重拉、不覆盖当前页面', async () => {
    const s = createSetup({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) });
    openMoveForSelection(s);
    const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
    await flush();
    // 移动在途时用户切到项目 prj_A
    s.ctx.run('setPhBrowsingTarget("programming-helper", { type: "project", id: "prj_A" })');
    const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
    await resolveAt(s, req, { ok: true, movedSessionIds: ['s1'], releasedSessionIds: [], revision: 6, target: { type: 'directory', openDirectory: 'D:/shared' } });
    await job;
    await flush();
    assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/prebuilt_sessions')), 'must not re-pull a slice for a stale view');
    assert.equal(s.loadAgentsCalls.length, 0);
  });
});

describe('移动 — 多选状态生命周期', () => {
  it('切目录/切项目即清（回调路径）', async () => {
    const s = createSetup({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1', 's2']) });
    s.render();
    s.ctx.run('window.phToggleSessionSelectMode()');
    s.ctx.run('window.phToggleSessionSelection("s1", true)');
    assert.equal(s.ctx.run('window.ClawFW.phSessionMove.selected.size'), 1);
    const switched = s.ctx.run('window.phSwitchProject("dir:d:/shared")');
    await flush();
    await resolveAt(s, s.requests[0], { state: { openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }] } });
    await resolveAt(s, s.requests.at(-1), DIR_SLICE(['s1', 's2']));
    await switched;
    assert.equal(s.ctx.run('window.ClawFW.phSessionMove.selectMode'), false, 'select mode cleared on directory switch');
    assert.equal(s.ctx.run('window.ClawFW.phSessionMove.selected.size'), 0);
  });

  it('渲染期和解：切片更换后不可见 id 清理（poll 场景）', () => {
    const s = createSetup({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1', 's2']) });
    s.render();
    s.ctx.run('window.phToggleSessionSelectMode()');
    s.ctx.run('window.phToggleSessionSelection("s1", true)');
    s.ctx.run('window.phToggleSessionSelection("s2", true)');
    // 模拟轮询/切片更换：s2 不在新切片里
    s.ctx.run('updateAgentRecord("programming-helper", { workspace_sessions: { sessions: [{ id: "s1", title: "Dir s1", updatedAt: "2026-10-22T10:00:00Z", openDirectory: "D:/shared" }], sessionProjectId: "", sessionTotal: 1, mainTotal: 1, archivedTotal: 0 } })');
    s.render();
    const state = JSON.parse(s.ctx.run('JSON.stringify({ mode: window.ClawFW.phSessionMove.selectMode, ids: Array.from(window.ClawFW.phSessionMove.selected) })'));
    assert.equal(state.mode, true, 'same view: mode kept');
    assert.deepEqual(state.ids, ['s1'], 'invisible ids pruned on slice replacement');
  });

  it('渲染期和解：浏览目标漂移 → 整体作废', () => {
    const s = createSetup({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) });
    s.render();
    s.ctx.run('window.phToggleSessionSelectMode()');
    s.ctx.run('window.phToggleSessionSelection("s1", true)');
    s.ctx.run('setPhBrowsingTarget("programming-helper", { type: "project", id: "prj_A" })');
    // 渲染按项目视图（不经过切换回调，直接渲染——模拟外部状态漂移）
    s.ctx.run('updateAgentRecord("programming-helper", { workspace_sessions: { sessions: [{ id: "sA", title: "A chat", updatedAt: "2026-10-22T10:00:00Z", projectId: "prj_A" }], sessionProjectId: "prj_A", sessionTotal: 1, mainTotal: 1, archivedTotal: 0 } })');
    s.render();
    assert.equal(s.ctx.run('window.ClawFW.phSessionMove.selectMode'), false, 'browsing drift invalidates selection state');
  });
});
