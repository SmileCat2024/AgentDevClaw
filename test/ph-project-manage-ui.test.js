/**
 * Ticket 046 — PH 项目管理 UI（VM 沙箱驱动真实前端源码）。
 *
 * 覆盖：
 *  - 归档项目从选择器隐藏；typed target 指向归档项目时失效回退目录模式
 *  - 管理弹窗：活跃/已归档分组、恢复动作走 project_archive
 *  - 改绑弹窗：请求体、成功后实体刷新 + 当前目标切片重拉、busy 错误呈现
 *  - 删除弹窗：影响预览（会话/配置/托管目录可删性）、托管目录显式勾选、
 *    输入项目名二次确认门、请求体 deleteManagedDirectory
 *  - 下拉「管理项目…」入口存在
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };

function smartEl(extra = {}) {
  const el = {
    className: '', id: '', innerHTML: '', removed: false, disabled: false, textContent: '',
    _listeners: {},
    appendChild() {}, remove() { el.removed = true; },
    addEventListener(type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); },
    removeEventListener() {},
    dispatch(type, event) { for (const fn of el._listeners[type] || []) fn(event); },
    querySelector: () => null,
    querySelectorAll: () => [],
    classList: { add() {}, remove() {}, contains: () => false },
    getAttribute: () => null,
    setAttribute() {},
    focus() {},
    ...extra,
  };
  return el;
}

/** 行内按钮桩：getAttribute 反映 setAttribute（归档二段式确认依赖 data-armed）。 */
function makeRowBtn(action, id) {
  const state = { armed: 'no' };
  return {
    disabled: false, textContent: '', isConnected: true,
    getAttribute: (k) => (k === 'data-action' ? action : k === 'data-id' ? id : k === 'data-armed' ? state.armed : null),
    setAttribute: (k, v) => { if (k === 'data-armed') state.armed = v; },
  };
}

/**
 * @param {'manage'|'rebind'|'delete'} dialogKind 预建对应弹窗的智能元素
 * @param {{ checkboxEnabled?: boolean }} options 删除预览是否含托管目录勾选框
 */
function createSetup({ entities = [], target = null, openDirectory = '', phProjects = [], sessionsMeta = null, dialogKind = 'manage', checkboxEnabled = false } = {}) {
  const agent = {
    id: 'programming-helper',
    modelPresets: { default: { primary: 'm1' } },
    workspace_sessions: sessionsMeta,
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
  const toasts = [];

  // ── 弹窗智能元素（按 dialogKind 装配）──────────────────────────────
  const manageBody = smartEl();
  const manageOverlay = smartEl({
    querySelector: (sel) => (sel === '.ph-manage-projects-body' ? manageBody : null),
    querySelectorAll: (sel) => (sel === '.ph-manage-projects-cancel' ? [smartEl(), smartEl()] : []),
  });
  const rebindDirInput = smartEl({ value: '' });
  const rebindError = smartEl({ hidden: true, textContent: '' });
  const rebindSubmit = smartEl({ disabled: false });
  const rebindForm = smartEl();
  const rebindBrowse = smartEl();
  const rebindOverlay = smartEl({
    querySelector: (sel) => ({
      '#ph-rebind-dir': rebindDirInput,
      '.ph-new-project-error': rebindError,
      'button[type="submit"]': rebindSubmit,
      form: rebindForm,
      '.ph-rebind-browse': rebindBrowse,
    })[sel] || null,
    querySelectorAll: (sel) => (sel === '.ph-rebind-cancel' ? [smartEl(), smartEl()] : []),
  });
  const checkboxEl = smartEl({ checked: false });
  const confirmInput = smartEl({ value: '' });
  const deleteError = smartEl({ hidden: true, textContent: '' });
  const deleteBody = smartEl({
    querySelector: (sel) => {
      const html = String(deleteBody.innerHTML);
      if (sel === '.ph-delete-dir-checkbox') return checkboxEnabled ? checkboxEl : null;
      if (sel === '.ph-delete-confirm-input') return html.includes('ph-delete-confirm-input') ? confirmInput : null;
      if (sel === '.ph-new-project-error') return html.includes('ph-delete-confirm') ? deleteError : null;
      return null;
    },
  });
  const nextBtn = smartEl({ disabled: true });
  const deleteOverlay = smartEl({
    querySelector: (sel) => (sel === '.ph-delete-body' ? deleteBody : sel === '.ph-delete-next' ? nextBtn : null),
    querySelectorAll: (sel) => (sel === '.ph-delete-cancel' ? [smartEl(), smartEl()] : []),
  });
  const dialogOverlay = { manage: manageOverlay, rebind: rebindOverlay, delete: deleteOverlay }[dialogKind];
  let createCount = 0;
  const hostEls = [];

  const ctx = createFrontendSandbox({
    URLSearchParams, marked,
    phSearchQuery: '', _phSearchTimer: null, savedPhTabState: {}, phSessionSortMode: 'updatedAt',
    currentLanguage: 'zh',
    lastRenderedWorkspaceHtml: '',
    renderCurrentMainView() {},
    getCurrentAgentRecord: () => ctx.__agent,
    getAgentWorkspaceState: () => workspaceState,
    getWorkspaceSessions: (a) => (a?.workspace_sessions?.sessions) || [],
    updateAgentRecord: (id, patch) => { Object.assign(ctx.__agent, patch); },
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
    setTimeout: () => 0,
    clearTimeout() {},
    ClawToast: { show: (n) => toasts.push(n), update() {} },
    invoke: async () => { throw new Error('not used in test'); },
    allAgents: [agent],
    fetch(url, opts) {
      fetchLog.push({ url, opts });
      return new Promise((resolve) => requests.push({ url, opts, resolve }));
    },
    alert: (m) => alerts.push(m),
    document: {
      querySelector: (s) => (s === '.ph-session-tabs' ? tabsRoot : s === '.ph-search-panel' ? searchPanel : null),
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener() {}, removeEventListener() {},
      body: { appendChild() {} },
      activeElement: null,
      createElement: () => {
        // 第一个 createElement 是弹窗 host，其后是 overlay 本体
        if (createCount === 0) { createCount += 1; const host = smartEl(); hostEls.push(host); return host; }
        return dialogOverlay;
      },
    },
  });
  ctx.window.alert = (m) => alerts.push(m);
  ctx.window.phLoadOpenSessionsCard = (...args) => { cardCalls.push(args); };
  ctx.loadSource('public/src/modules/project-data.js');
  ctx.loadSource('public/src/modules/ph-project-actions.js');
  ctx.loadSource('public/src/modules/session-list-render.js');
  ctx.loadSource('public/src/modules/ph-session-list.js');

  const store = ctx.window.ClawFW.phProjectEntities;
  store.projects = entities.map((raw) => ctx.run(`normalizePhProjectEntity(${JSON.stringify(raw)})`)).filter(Boolean);
  store.loaded = true;
  if (target) ctx.run(`setPhBrowsingTarget('programming-helper', ${JSON.stringify(target)})`);
  ctx.__agent = agent;
  const render = () => ctx.run('_renderProgrammingHelperSessionList(__agent, {}, { desc: "d" })');
  return {
    ctx, agent, workspaceState, requests, fetchLog, alerts, toasts, render,
    manageBody, manageOverlay, rebindDirInput, rebindError, rebindSubmit, rebindForm,
    deleteBody, deleteError, nextBtn, checkboxEl, confirmInput, deleteOverlay, rebindOverlay,
    dialogOverlay,
  };
}

const resolve = async (entry, data, ok = true) => {
  entry.resolve({ ok, status: ok ? 200 : 500, json: async () => data });
  await flush();
};

const activeEntities = [
  { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', directorySource: 'external', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
  { id: 'prj_X', name: 'XArchived', workDirectory: 'D:/archived', directorySource: 'external', archived: true, createdAt: '2026-10-01', updatedAt: '2026-10-02' },
];

describe('046 — 归档项目的选择器语义', () => {
  it('归档项目不出现在下拉项目组；typed target 指向归档项目时清目标回退目录', () => {
    const s = createSetup({
      entities: activeEntities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      target: { type: 'project', id: 'prj_X' },
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    });
    const html = s.render();
    assert.match(html, /data-project-id="prj_A"/);
    assert.doesNotMatch(html, /data-project-id="prj_X"/, 'archived project hidden from selector');
    assert.doesNotMatch(html, /XArchived/);
    // 目标失效：回退目录模式，且存储目标被清除
    const target = s.ctx.run('getPhBrowsingTarget(__agent)');
    assert.equal(target.type, 'dir');
    assert.equal(
      s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`),
      null,
      'archived target cleared from storage',
    );
  });

  it('未归档项目目标不受影响', () => {
    const s = createSetup({
      entities: activeEntities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    });
    const target = s.ctx.run('getPhBrowsingTarget(__agent)');
    assert.equal(target.type, 'project');
    assert.equal(target.id, 'prj_A');
  });

  it('下拉含「管理项目…」入口', () => {
    const s = createSetup({ openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }] });
    const html = s.render();
    assert.match(html, /管理项目…/);
    assert.match(html, /phOpenManageProjectsDialog/);
  });
});

describe('046 — 管理弹窗（恢复 / 归档二段式）', () => {
  it('打开：分组渲染（活跃 + 已归档），实体经 force 刷新', async () => {
    const s = createSetup({ entities: activeEntities, dialogKind: 'manage' });
    const job = s.ctx.run('window.phOpenManageProjectsDialog()');
    await flush();
    const listReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/projects'));
    assert.ok(listReq, 'entities force refresh fired');
    await resolve(s.requests.at(-1), { ok: true, projects: activeEntities });
    await job;
    const html = String(s.manageBody.innerHTML);
    assert.match(html, /进行中的项目/);
    assert.match(html, /已归档（可恢复）/);
    assert.match(html, /prj_A/);
    assert.match(html, /prj_X/);
    assert.match(html, /data-action="restore"/);
    assert.match(html, /data-action="rebind"/);
    assert.match(html, /data-action="delete"/);
  });

  it('恢复：POST project_archive archived=false，成功后行刷新', async () => {
    const s = createSetup({ entities: activeEntities, dialogKind: 'manage' });
    const job = s.ctx.run('window.phOpenManageProjectsDialog()');
    await flush();
    await resolve(s.requests.at(-1), { ok: true, projects: activeEntities });
    await job;
    // 点击已归档行的「恢复」
    await s.manageBody.dispatch('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? makeRowBtn('restore', 'prj_X') : null) } });
    const archiveReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_archive'));
    assert.ok(archiveReq, 'archive request fired');
    assert.equal(JSON.parse(archiveReq.opts.body).archived, false);
    assert.equal(JSON.parse(archiveReq.opts.body).projectId, 'prj_X');
    await resolve(s.requests.at(-1), { ok: true, project: { id: 'prj_X', archived: false } });
    const refreshed = [
      { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' },
      { id: 'prj_X', name: 'XArchived', workDirectory: 'D:/archived' },
    ];
    await resolve(s.requests.at(-1), { ok: true, projects: refreshed });
    await flush();
    assert.doesNotMatch(String(s.manageBody.innerHTML), /已归档（可恢复）/, 'restored project moves to active group');
    assert.ok(s.toasts.some((t) => String(t.title).includes('恢复')));
  });

  it('归档：第一次点击只进入确认态，第二次点击才发请求', async () => {
    const s = createSetup({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' }],
      dialogKind: 'manage',
    });
    const job = s.ctx.run('window.phOpenManageProjectsDialog()');
    await flush();
    await resolve(s.requests.at(-1), { ok: true, projects: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' }] });
    await job;
    const btn = makeRowBtn('archive', 'prj_A');
    await s.manageBody.dispatch('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? btn : null) } });
    assert.ok(!s.fetchLog.some((f) => f.url.includes('project_archive')), 'first click must not fire request');
    assert.equal(btn.getAttribute('data-armed'), 'yes');
    await s.manageBody.dispatch('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? btn : null) } });
    const archiveReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_archive'));
    assert.ok(archiveReq, 'second click fires request');
    assert.equal(JSON.parse(archiveReq.opts.body).archived, true);
    await resolve(s.requests.at(-1), { ok: true, project: { id: 'prj_A', archived: true } });
    await resolve(s.requests.at(-1), { ok: true, projects: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', archived: true }] });
    await flush();
  });
});

describe('046 — 改绑弹窗', () => {
  it('提交：请求体带显式目录；成功后实体刷新 + 当前目标切片重拉', async () => {
    const s = createSetup({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/old' }],
      target: { type: 'project', id: 'prj_A' },
      openDirectory: 'D:/old',
      phProjects: [{ openDirectory: 'D:/old' }],
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
      dialogKind: 'rebind',
    });
    s.ctx.run('window.phRebindProject("prj_A")');
    s.rebindDirInput.value = 'E:/newdir';
    const job = s.rebindForm.dispatch('submit', { preventDefault() {} });
    // dispatch 同步返回 undefined；改绑 submit 是 async 监听器，微任务排空后断言请求
    await flush();
    const rebindReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_rebind'));
    assert.ok(rebindReq, 'rebind request fired');
    const body = JSON.parse(rebindReq.opts.body);
    assert.equal(body.projectId, 'prj_A');
    assert.equal(body.agentId, 'programming-helper');
    assert.equal(body.workDirectory, 'E:/newdir');
    await resolve(s.requests.at(-1), { ok: true, project: { id: 'prj_A', workDirectory: 'E:/newdir' }, releasedSessionIds: ['s1'] });
    // 实体刷新（045 的 target 实体刷新入口）
    const listReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/projects'));
    assert.ok(listReq, 'entities refresh after rebind');
    await resolve(s.requests.at(-1), { ok: true, projects: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'E:/newdir' }] });
    // 当前目标正是 prj_A：切片按项目重拉
    const sliceReq = s.fetchLog.filter((f) => f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
    assert.ok(sliceReq && sliceReq.url.includes('projectId=prj_A'), 'current-target slice reload');
    await resolve(s.requests.at(-1), { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
    await flush();
    assert.equal(s.rebindOverlay.removed, true, 'dialog closes on success');
    void job;
  });

  it('busy 拒绝：错误呈现为可读解释，不关闭弹窗、按钮复位', async () => {
    const s = createSetup({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/old' }],
      dialogKind: 'rebind',
    });
    s.ctx.run('window.phRebindProject("prj_A")');
    s.rebindDirInput.value = 'E:/newdir';
    await s.rebindForm.dispatch('submit', { preventDefault() {} });
    await flush();
    const rebindReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_rebind'));
    assert.ok(rebindReq);
    await resolve(s.requests.at(-1), { ok: false, error: 'PH project prj_A has busy sessions (call_active); rebind is rejected' }, false);
    assert.equal(s.rebindError.hidden, false);
    assert.match(s.rebindError.textContent, /已拒绝改绑/);
    assert.equal(s.rebindSubmit.disabled, false, 'submit re-enabled for retry');
    assert.equal(s.rebindOverlay.removed, false, 'dialog stays open on failure');
  });
});

describe('046 — 删除弹窗（影响预览 + 二次确认）', () => {
  const openDelete = async (s) => {
    s.ctx.run('window.phDeleteProject("prj_A")');
    await flush();
    const previewReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_delete_preview'));
    assert.ok(previewReq, 'preview request fired');
    return previewReq;
  };

  it('可删托管目录：预览影响面 → 勾选目录 → 输入项目名 → 删除请求', async () => {
    const s = createSetup({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/managed/prj_A', directorySource: 'managed' }],
      target: { type: 'project', id: 'prj_A' },
      openDirectory: 'D:/elsewhere',
      phProjects: [{ openDirectory: 'D:/elsewhere' }],
      dialogKind: 'delete',
      checkboxEnabled: true,
    });
    await openDelete(s);
    await resolve(s.requests.at(-1), {
      ok: true,
      project: { id: 'prj_A', name: 'Alpha' },
      sessions: [{ id: 's1', title: 'chat1' }, { id: 's2', title: 'chat2' }],
      featureConfig: { path: 'D:/cfg/project-prj_A.json', exists: true },
      managedDirectory: { path: 'D:/managed/prj_A', source: 'managed', deletable: true, reasons: [] },
    });
    const previewHtml = String(s.deleteBody.innerHTML);
    assert.match(previewHtml, /项目会话 2/);
    assert.match(previewHtml, /chat1/);
    assert.match(previewHtml, /项目层配置文件/);
    assert.match(previewHtml, /ph-delete-dir-checkbox/);
    // 勾选托管目录删除（显式选择）
    s.checkboxEl.checked = true;
    s.checkboxEl.dispatch('change', {});
    // 第一步：下一步 → 第二步输入名
    assert.equal(s.nextBtn.disabled, false);
    s.nextBtn.dispatch('click', {});
    assert.match(String(s.deleteBody.innerHTML), /ph-delete-confirm-input/);
    assert.equal(s.nextBtn.disabled, true, 'confirm gated until name matches');
    // 名字不对：保持禁用
    s.confirmInput.value = 'Alph';
    s.confirmInput.dispatch('input', {});
    assert.equal(s.nextBtn.disabled, true);
    // 名字正确：放开
    s.confirmInput.value = 'Alpha';
    s.confirmInput.dispatch('input', {});
    assert.equal(s.nextBtn.disabled, false);
    s.nextBtn.dispatch('click', {});
    await flush();
    const deleteReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_delete') && !f.url.includes('preview'));
    assert.ok(deleteReq, 'delete request fired only after explicit confirm');
    const body = JSON.parse(deleteReq.opts.body);
    assert.equal(body.projectId, 'prj_A');
    assert.equal(body.deleteManagedDirectory, true);    await resolve(s.requests.at(-1), {
      ok: true,
      project: { id: 'prj_A' },
      deletedSessions: ['s1', 's2'],
      featureConfigDeleted: true,
      managedDirectory: { path: 'D:/managed/prj_A', deleted: true },
    });
    // 实体刷新 + 当前目标失效（prj_A 被删）→ 清目标回退目录切片
    await resolve(s.requests.at(-1), { ok: true, projects: [] });
    const sliceReq = s.fetchLog.filter((f) => f.url.includes('/protocloud') || f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
    assert.ok(sliceReq && sliceReq.url.includes('projectDir='), 'browsing falls back to directory mode');
    await resolve(s.requests.at(-1), { sessions: [], sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
    await flush();
    assert.equal(s.deleteOverlay.removed, true, 'dialog closes on success');
    assert.ok(s.toasts.some((t) => String(t.title).includes('已删除')));
  });

  it('外部目录：预览呈现保留原因、无勾选框，删除请求不带目录删除', async () => {
    const s = createSetup({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'E:/external', directorySource: 'external' }],
      dialogKind: 'delete',
      checkboxEnabled: false,
    });
    await openDelete(s);
    await resolve(s.requests.at(-1), {
      ok: true,
      project: { id: 'prj_A', name: 'Alpha' },
      sessions: [],
      featureConfig: { path: 'D:/cfg/project-prj_A.json', exists: false },
      managedDirectory: { path: 'E:/external', source: 'external', deletable: false, reasons: [{ kind: 'external_directory' }] },
    });
    const previewHtml = String(s.deleteBody.innerHTML);
    assert.match(previewHtml, /外部目录，绝不删除/);
    assert.doesNotMatch(previewHtml, /ph-delete-dir-option/);
    s.nextBtn.dispatch('click', {});
    s.confirmInput.value = 'Alpha';
    s.confirmInput.dispatch('input', {});
    s.nextBtn.dispatch('click', {});
    await flush();
    const deleteReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_delete') && !f.url.includes('preview'));
    assert.ok(deleteReq);
    assert.equal(JSON.parse(deleteReq.opts.body).deleteManagedDirectory, false);
    await resolve(s.requests.at(-1), { ok: true, project: { id: 'prj_A' }, deletedSessions: [], managedDirectory: { path: 'E:/external', deleted: false } });
    await resolve(s.requests.at(-1), { ok: true, projects: [] });
    await flush();
  });
});
