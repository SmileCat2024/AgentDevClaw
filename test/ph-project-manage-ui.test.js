/**
 * Ticket 046 — PH 项目管理 UI。
 *
 * 覆盖：
 *  - 归档项目从选择器隐藏；typed target 指向归档项目时失效回退目录模式
 *  - 管理弹窗：活跃/已归档分组、恢复动作走 project_archive
 *  - 改绑弹窗：请求体、成功后实体刷新 + 当前目标切片重拉、busy 错误呈现
 *  - 删除弹窗：影响预览（会话/配置/托管目录可删性）、托管目录显式勾选、
 *    输入项目名二次确认门、请求体 deleteManagedDirectory
 *  - 下拉「管理项目…」入口存在
 *
 * 装载路线（P2 W2-8 测试改造）：project-data / ph-project-actions /
 * ph-session-list / session-list-render 已迁 ESM → withP2EsmCase 真实 import
 * 整图（每 case 一张图）；classic 侧仍真实 loadSource 跑 action-dispatcher /
 * app-core / i18n，其余 classic 宿主函数按最小契约注入。渲染入口改用命名
 * 导出 renderWorkspaceSessionList（本模块公开入口），断言面是真实请求形状与
 * 可观察 DOM（弹窗 innerHTML）。
 *
 * 已知缺口：恢复/删除成功后的 toast 文案无法在本测试观察——生产调用
 * ClawToast.show 未传 id，而 toast-notify 要求 id（缺省直接 early-return），
 * 真实运行时不产生卡片；原断言观察的是被替换的全局 window.ClawToast。本测试
 * 不伪造该覆盖，改为断言真实可观察结果（分组刷新 / 弹窗关闭），见用例内注释。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const PROJECT_DATA = 'public/src/modules/project-data.js';
const PH_PROJECT_ACTIONS = 'public/src/modules/ph-project-actions.js';
const PH_SESSION_LIST = 'public/src/modules/ph-session-list.js';
const SESSION_LIST_RENDER = 'public/src/modules/session-list-render.js';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };

const DIALOG_HOST_IDS = new Set([
  'ph-manage-projects-host',
  'ph-rebind-host',
  'ph-delete-host',
  'ph-move-dialog-host',
]);

/** 通用元素桩：稳定 id 引用 + 子节点记账（app-core 装载期与元素形态契约）。 */
function makeDomElement(overrides = {}) {
  const children = [];
  const classes = new Set();
  const attrs = {};
  const el = {
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    isConnected: true,
    dataset: {},
    style: {},
    children,
    parentNode: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle(c, on) { if (on === undefined) (classes.has(c) ? classes.delete(c) : classes.add(c)); else if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    appendChild(child) { children.push(child); if (child) child.parentNode = el; return child; },
    append() {},
    insertBefore(child) { children.push(child); if (child) child.parentNode = el; return child; },
    removeChild(child) { const at = children.indexOf(child); if (at >= 0) children.splice(at, 1); },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute(key, value) { attrs[key] = String(value); if (key === 'class') el.className = String(value); },
    removeAttribute(key) { delete attrs[key]; },
    getAttribute(key) { return Object.prototype.hasOwnProperty.call(attrs, key) ? attrs[key] : null; },
    focus() {},
    querySelector(selector) { return findDescendant(el, selector); },
    querySelectorAll() { return []; },
    contains() { return false; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0 }; },
    dispatchEvent() {},
    matches() { return false; },
    ...overrides,
  };
  return el;
}

function matchesSelector(el, selector) {
  const sel = String(selector || '').trim();
  if (!sel) return false;
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) {
    const name = sel.slice(1);
    return String(el.className || '').split(/\s+/).includes(name);
  }
  return false;
}

function findDescendant(el, selector) {
  for (const child of el.children || []) {
    if (matchesSelector(child, selector)) return child;
    const nested = findDescendant(child, selector);
    if (nested) return nested;
  }
  return null;
}

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
 * @param {{ dialogKind?: 'manage'|'rebind'|'delete', checkboxEnabled?: boolean }} options
 */
async function withManageCase(options = {}, probe) {
  const {
    entities = [], target = null, openDirectory = '', phProjects = [], sessionsMeta = null,
    dialogKind = 'manage', checkboxEnabled = false,
  } = options;

  const agent = {
    id: 'programming-helper',
    source: 'prebuilt',
    modelPresets: { default: { primary: 'm1' } },
    workspace_sessions: sessionsMeta,
    workspace_state: null,
  };
  const workspaceState = { openDirectory, phProjects };
  agent.workspace_state = workspaceState;

  const requests = [];
  const fetchLog = [];
  const alerts = [];
  const tabsRoot = {
    dataset: { searchAgentId: 'programming-helper', searchDirectory: '', searchProjectId: '', searchRemote: 'false', searchHostId: 'programming-helper' },
    classList: { add() {}, remove() {}, contains: () => false },
  };
  const searchPanel = { innerHTML: '' };
  const openContainer = { innerHTML: '' };
  const countEls = [];

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
  const checkboxEl = smartEl({ checked: false, value: '' });
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
  let dialogCreateCount = 0;
  const hostEls = [];

  const byId = new Map();
  const document = {
    getElementById(id) {
      const key = String(id);
      if (key === 'ph-open-sessions-container') return openContainer;
      // 弹窗宿主：真实 DOM 里首次查询为 null（模块自建 host 元素）。
      if (DIALOG_HOST_IDS.has(key)) return null;
      if (!byId.has(key)) byId.set(key, makeDomElement({ id: key }));
      return byId.get(key);
    },
    querySelector: (s) => (s === '.ph-session-tabs' ? tabsRoot : s === '.ph-search-panel' ? searchPanel : null),
    querySelectorAll: (selector) => (selector === '.ph-select-count' ? countEls : []),
    createElement() {
      // 前两次 createElement 是弹窗 host + overlay（真实构造顺序）；其后是通用
      // DOM（其他 createElement 调用方）。
      if (dialogCreateCount === 0) { dialogCreateCount += 1; const host = smartEl(); hostEls.push(host); return host; }
      if (dialogCreateCount === 1) { dialogCreateCount += 1; return dialogOverlay; }
      return makeDomElement();
    },
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    removeEventListener() {},
    body: makeDomElement({ id: 'body' }),
    head: makeDomElement({ id: 'head' }),
    documentElement: makeDomElement({ id: 'html' }),
    activeElement: null,
    readyState: 'complete',
  };
  let seedProjectsPending = true;
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
      sandbox.loadSource('public/src/i18n.js');
      sandbox.allAgents = [agent];
      sandbox.run(`
        // classic 宿主面（app-main / app-ui 仍 classic）：当前记录 + 重绘 + 侧栏。
        window.getCurrentAgentRecord = () => window.__agent;
        window.renderCurrentMainView = function () {};
        window.renderAgentList = function () {};
        window.loadAgents = async function () {};
        window.invoke = async () => { throw new Error('not used in test'); };
        // remote-connections 未装载：远程命名空间判定与远程目录投影的最小契约。
        window.isRemoteNamespaceAgentId = (id) => String(id || '').startsWith('remote:');
        window.getRemoteHistoryProjectBuckets = () => [];
        window.RemoteConnections = {};
        // ESM 图求值期读取的 loader host 工厂（最小契约替身）。
        createAgentSnapshotLoaderHost = () => ({ state: {} });
        createRuntimeSwitchHost = () => ({ state: {} });
        createWorkspaceSurfaceHost = () => ({ state: {} });
        createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
        createAgentCallStatesHost = () => ({ state: {} });
        createSessionViewCommitHost = () => ({ state: {} });
        createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
        // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader →
        // input-actions 触达 poll-coordinator-host，后者在模块求值期取该工厂。
        createPollCoordinatorHost = () => ({
          run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
        });
      `);
      sandbox.__agent = agent;
    },
    globals: {
      document,
      URLSearchParams,
      alert: (message) => { alerts.push(String(message)); },
      fetch(url, opts) {
        const target = String(url);
        fetchLog.push({ url: target, opts });
        const path = target.split('?')[0];
        // 首次实体清单请求服务夹具预置（真实 ensure 入口的一次性取用）；之后
        // 的清单请求交给用例手动 resolve，断言 force 刷新与落地时机。
        if (path === '/protoclaw/ph_project/projects' && seedProjectsPending) {
          seedProjectsPending = false;
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: entities }) });
        }
        return new Promise((resolve) => requests.push({ url: target, opts, resolve }));
      },
    },
  }, async (c) => {
    const data = await c.load(PROJECT_DATA);
    const actions = await c.load(PH_PROJECT_ACTIONS);
    const sessionList = await c.load(SESSION_LIST_RENDER);
    await c.load(PH_SESSION_LIST);
    // 实体缓存预置：真实 ensure 入口（真实 normalize 语义），随后清空请求日志
    await data.ensurePhProjectEntitiesLoaded(true);
    fetchLog.length = 0;
    requests.length = 0;
    dialogCreateCount = 0;
    if (target) data.setPhBrowsingTarget('programming-helper', target);
    const currentAgent = () => c.read('allAgents').find((item) => item.id === 'programming-helper') || agent;
    const render = () => sessionList.renderWorkspaceSessionList(currentAgent(), {});
    return probe({
      c, data, actions, agent, currentAgent, workspaceState, requests, fetchLog, alerts, render,
      manageBody, manageOverlay, rebindDirInput, rebindError, rebindSubmit, rebindForm,
      deleteBody, deleteError, nextBtn, checkboxEl, confirmInput, deleteOverlay, rebindOverlay,
      dialogOverlay,
    });
  });
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
  it('归档项目不出现在下拉项目组；typed target 指向归档项目时清目标回退目录', async () => {
    await withManageCase({
      entities: activeEntities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      target: { type: 'project', id: 'prj_X' },
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    }, async ({ c, data, currentAgent, render }) => {
      const html = render();
      assert.match(html, /data-project-id="prj_A"/);
      assert.doesNotMatch(html, /data-project-id="prj_X"/, 'archived project hidden from selector');
      assert.doesNotMatch(html, /XArchived/);
      // 目标失效：回退目录模式，且存储目标被清除
      const target = data.getPhBrowsingTarget(currentAgent());
      assert.equal(target.type, 'dir');
      assert.equal(
        c.window.localStorage.getItem('protoclaw:ph-browsing-target:programming-helper'),
        null,
        'archived target cleared from storage',
      );
    });
  });

  it('未归档项目目标不受影响', async () => {
    await withManageCase({
      entities: activeEntities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    }, async ({ data, currentAgent }) => {
      const target = data.getPhBrowsingTarget(currentAgent());
      assert.equal(target.type, 'project');
      assert.equal(target.id, 'prj_A');
    });
  });

  it('项目下拉开头提供「编辑项目」动作，直达项目管理弹窗', async () => {
    await withManageCase({ openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }] }, async ({ render }) => {
      const html = render();
      const orgMenu = html.slice(html.indexOf('ph-org-menu'), html.indexOf('ph-quick-add'));
      assert.match(orgMenu, /编辑项目/);
      assert.ok(orgMenu.includes('data-action="sessions.manageProjects"'));
      assert.ok(orgMenu.indexOf('编辑项目') < orgMenu.indexOf('ph-org-directory'));
      assert.doesNotMatch(html, /ph-quick-menu/);
    });
  });
});

describe('046 — 管理弹窗（恢复 / 归档二段式）', () => {
  it('打开：分组渲染（活跃 + 已归档），实体经 force 刷新', async () => {
    await withManageCase({ entities: activeEntities, dialogKind: 'manage' }, async ({ actions, requests, fetchLog, manageBody }) => {
      const job = actions.phOpenManageProjectsDialog();
      await flush();
      const listReq = fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/projects'));
      assert.ok(listReq, 'entities force refresh fired');
      await resolve(requests.at(-1), { ok: true, projects: activeEntities });
      await job;
      const html = String(manageBody.innerHTML);
      assert.match(html, /进行中的项目/);
      assert.match(html, /已归档（可恢复）/);
      assert.match(html, /prj_A/);
      assert.match(html, /prj_X/);
      assert.match(html, /data-action="restore"/);
      assert.match(html, /data-action="rebind"/);
      assert.match(html, /data-action="delete"/);
    });
  });

  it('恢复：POST project_archive archived=false，成功后行刷新', async () => {
    await withManageCase({ entities: activeEntities, dialogKind: 'manage' }, async ({ actions, requests, fetchLog, manageBody }) => {
      const job = actions.phOpenManageProjectsDialog();
      await flush();
      await resolve(requests.at(-1), { ok: true, projects: activeEntities });
      await job;
      // 点击已归档行的「恢复」
      await manageBody.dispatch('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? makeRowBtn('restore', 'prj_X') : null) } });
      const archiveReq = fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_archive'));
      assert.ok(archiveReq, 'archive request fired');
      assert.equal(JSON.parse(archiveReq.opts.body).archived, false);
      assert.equal(JSON.parse(archiveReq.opts.body).projectId, 'prj_X');
      await resolve(requests.at(-1), { ok: true, project: { id: 'prj_X', archived: false } });
      const refreshed = [
        { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' },
        { id: 'prj_X', name: 'XArchived', workDirectory: 'D:/archived' },
      ];
      await resolve(requests.at(-1), { ok: true, projects: refreshed });
      await flush();
      assert.doesNotMatch(String(manageBody.innerHTML), /已归档（可恢复）/, 'restored project moves to active group');
      // 原「恢复」toast 文案断言依赖被替换的全局 window.ClawToast；ESM 化后
      // ph-project-actions 直接 import toast-notify，且该调用未传 id
      // （toast-notify 要求 id，缺省 early-return，运行时不产生卡片）——文案
      // 断言不可达且不伪造覆盖，改以真实可观察结果（行刷新）为准。
    });
  });

  it('归档：第一次点击只进入确认态，第二次点击才发请求', async () => {
    await withManageCase({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' }],
      dialogKind: 'manage',
    }, async ({ actions, requests, fetchLog, manageBody }) => {
      const job = actions.phOpenManageProjectsDialog();
      await flush();
      await resolve(requests.at(-1), { ok: true, projects: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared' }] });
      await job;
      const btn = makeRowBtn('archive', 'prj_A');
      await manageBody.dispatch('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? btn : null) } });
      assert.ok(!fetchLog.some((f) => f.url.includes('project_archive')), 'first click must not fire request');
      assert.equal(btn.getAttribute('data-armed'), 'yes');
      await manageBody.dispatch('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? btn : null) } });
      const archiveReq = fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_archive'));
      assert.ok(archiveReq, 'second click fires request');
      assert.equal(JSON.parse(archiveReq.opts.body).archived, true);
      await resolve(requests.at(-1), { ok: true, project: { id: 'prj_A', archived: true } });
      await resolve(requests.at(-1), { ok: true, projects: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', archived: true }] });
      await flush();
    });
  });
});

describe('046 — 改绑弹窗', () => {
  it('提交：请求体带显式目录；成功后实体刷新 + 当前目标切片重拉', async () => {
    await withManageCase({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/old' }],
      target: { type: 'project', id: 'prj_A' },
      openDirectory: 'D:/old',
      phProjects: [{ openDirectory: 'D:/old' }],
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
      dialogKind: 'rebind',
    }, async ({ actions, requests, fetchLog, rebindDirInput, rebindForm, rebindOverlay }) => {
      actions.phRebindProject('prj_A');
      rebindDirInput.value = 'E:/newdir';
      rebindForm.dispatch('submit', { preventDefault() {} });
      // dispatch 同步返回 undefined；改绑 submit 是 async 监听器，微任务排空后断言请求
      await flush();
      const rebindReq = fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_rebind'));
      assert.ok(rebindReq, 'rebind request fired');
      const body = JSON.parse(rebindReq.opts.body);
      assert.equal(body.projectId, 'prj_A');
      assert.equal(body.agentId, 'programming-helper');
      assert.equal(body.workDirectory, 'E:/newdir');
      await resolve(requests.at(-1), { ok: true, project: { id: 'prj_A', workDirectory: 'E:/newdir' }, releasedSessionIds: ['s1'] });
      // 实体刷新（045 的 target 实体刷新入口）
      const listReq = fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/projects'));
      assert.ok(listReq, 'entities refresh after rebind');
      await resolve(requests.at(-1), { ok: true, projects: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'E:/newdir' }] });
      // 当前目标正是 prj_A：切片按项目重拉
      const sliceReq = fetchLog.filter((f) => f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
      assert.ok(sliceReq && sliceReq.url.includes('projectId=prj_A'), 'current-target slice reload');
      await resolve(requests.at(-1), { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
      await flush();
      assert.equal(rebindOverlay.removed, true, 'dialog closes on success');
    });
  });

  it('busy 拒绝：错误呈现为可读解释，不关闭弹窗、按钮复位', async () => {
    await withManageCase({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/old' }],
      dialogKind: 'rebind',
    }, async ({ actions, requests, fetchLog, rebindDirInput, rebindForm, rebindError, rebindSubmit, rebindOverlay }) => {
      actions.phRebindProject('prj_A');
      rebindDirInput.value = 'E:/newdir';
      await rebindForm.dispatch('submit', { preventDefault() {} });
      await flush();
      const rebindReq = fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_rebind'));
      assert.ok(rebindReq);
      await resolve(requests.at(-1), { ok: false, error: 'PH project prj_A has busy sessions (call_active); rebind is rejected' }, false);
      assert.equal(rebindError.hidden, false);
      assert.match(rebindError.textContent, /已拒绝改绑/);
      assert.equal(rebindSubmit.disabled, false, 'submit re-enabled for retry');
      assert.equal(rebindOverlay.removed, false, 'dialog stays open on failure');
    });
  });
});

describe('046 — 删除弹窗（影响预览 + 二次确认）', () => {
  const openDelete = async (s) => {
    s.actions.phDeleteProject('prj_A');
    await flush();
    const previewReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_delete_preview'));
    assert.ok(previewReq, 'preview request fired');
    return previewReq;
  };

  it('可删托管目录：预览影响面 → 勾选目录 → 输入项目名 → 删除请求', async () => {
    await withManageCase({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/managed/prj_A', directorySource: 'managed' }],
      target: { type: 'project', id: 'prj_A' },
      openDirectory: 'D:/elsewhere',
      phProjects: [{ openDirectory: 'D:/elsewhere' }],
      dialogKind: 'delete',
      checkboxEnabled: true,
    }, async (s) => {
      const { requests, fetchLog, deleteBody, checkboxEl, confirmInput, nextBtn, deleteOverlay } = s;
      await openDelete(s);
      await resolve(requests.at(-1), {
        ok: true,
        project: { id: 'prj_A', name: 'Alpha' },
        sessions: [{ id: 's1', title: 'chat1' }, { id: 's2', title: 'chat2' }],
        featureConfig: { path: 'D:/cfg/project-prj_A.json', exists: true },
        managedDirectory: { path: 'D:/managed/prj_A', source: 'managed', deletable: true, reasons: [] },
      });
      const previewHtml = String(deleteBody.innerHTML);
      assert.match(previewHtml, /项目会话 2/);
      assert.match(previewHtml, /chat1/);
      assert.match(previewHtml, /项目层配置文件/);
      assert.match(previewHtml, /ph-delete-dir-checkbox/);
      // 勾选托管目录删除（显式选择）
      checkboxEl.checked = true;
      checkboxEl.dispatch('change', {});
      // 第一步：下一步 → 第二步输入名
      assert.equal(nextBtn.disabled, false);
      nextBtn.dispatch('click', {});
      assert.match(String(deleteBody.innerHTML), /ph-delete-confirm-input/);
      assert.equal(nextBtn.disabled, true, 'confirm gated until name matches');
      // 名字不对：保持禁用
      confirmInput.value = 'Alph';
      confirmInput.dispatch('input', {});
      assert.equal(nextBtn.disabled, true);
      // 名字正确：放开
      confirmInput.value = 'Alpha';
      confirmInput.dispatch('input', {});
      assert.equal(nextBtn.disabled, false);
      nextBtn.dispatch('click', {});
      await flush();
      const deleteReq = fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_delete') && !f.url.includes('preview'));
      assert.ok(deleteReq, 'delete request fired only after explicit confirm');
      const body = JSON.parse(deleteReq.opts.body);
      assert.equal(body.projectId, 'prj_A');
      assert.equal(body.deleteManagedDirectory, true);
      await resolve(requests.at(-1), {
        ok: true,
        project: { id: 'prj_A' },
        deletedSessions: ['s1', 's2'],
        featureConfigDeleted: true,
        managedDirectory: { path: 'D:/managed/prj_A', deleted: true },
      });
      // 实体刷新 + 当前目标失效（prj_A 被删）→ 清目标回退目录切片
      await resolve(requests.at(-1), { ok: true, projects: [] });
      const sliceReq = fetchLog.filter((f) => f.url.includes('/protocloud') || f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
      assert.ok(sliceReq && sliceReq.url.includes('projectDir='), 'browsing falls back to directory mode');
      await resolve(requests.at(-1), { sessions: [], sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
      await flush();
      assert.equal(deleteOverlay.removed, true, 'dialog closes on success');
      // 删除成功的 toast 文案同「恢复」：生产调用未传 id，运行时不产生卡片
      // （原断言观察的是被 stub 的全局 window.ClawToast），不伪造覆盖。
    });
  });

  it('外部目录：预览呈现保留原因、无勾选框，删除请求不带目录删除', async () => {
    await withManageCase({
      entities: [{ id: 'prj_A', name: 'Alpha', workDirectory: 'E:/external', directorySource: 'external' }],
      dialogKind: 'delete',
      checkboxEnabled: false,
    }, async (s) => {
      const { requests, fetchLog, deleteBody, confirmInput, nextBtn } = s;
      await openDelete(s);
      await resolve(requests.at(-1), {
        ok: true,
        project: { id: 'prj_A', name: 'Alpha' },
        sessions: [],
        featureConfig: { path: 'D:/cfg/project-prj_A.json', exists: false },
        managedDirectory: { path: 'E:/external', source: 'external', deletable: false, reasons: [{ kind: 'external_directory' }] },
      });
      const previewHtml = String(deleteBody.innerHTML);
      assert.match(previewHtml, /外部目录，绝不删除/);
      assert.doesNotMatch(previewHtml, /ph-delete-dir-option/);
      nextBtn.dispatch('click', {});
      confirmInput.value = 'Alpha';
      confirmInput.dispatch('input', {});
      nextBtn.dispatch('click', {});
      await flush();
      const deleteReq = fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_delete') && !f.url.includes('preview'));
      assert.ok(deleteReq);
      assert.equal(JSON.parse(deleteReq.opts.body).deleteManagedDirectory, false);
      await resolve(requests.at(-1), { ok: true, project: { id: 'prj_A' }, deletedSessions: [], managedDirectory: { path: 'E:/external', deleted: false } });
      await resolve(requests.at(-1), { ok: true, projects: [] });
      await flush();
    });
  });
});
