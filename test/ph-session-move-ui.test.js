/**
 * PH 会话移动（sessions_move）前端行为。
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
 *
 * 装载路线（P2 W2-8 测试改造）：project-data / ph-session-move / ph-project-actions /
 * ph-session-list / session-list-render 已迁 ESM → withP2EsmCase 真实 import 整图
 * （每 case 一张图）；classic 侧仍真实 loadSource 跑 action-dispatcher / app-core /
 * i18n。断言改调命名导出、真实请求形状与可观察 DOM；「搜索 retry」不再经 window
 * 替身，而是断言真实的 search_sessions 请求被发出。
 *
 * 生产已把侧栏重投影改为 import `loadAgents`（闭包，window 桩失效）：其宿主
 * 工厂的真实实现是 classic sidebar-render 的 createAgentSnapshotLoaderHost，
 * 这里执行该工厂的真实源码片段（classic 依赖按调用契约注入），以 `/api/agents`
 * 请求作为「侧栏快照被重拉」的观测点——真实 loader 逻辑照常执行。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { sourceBetween } from './helpers/frontend-vm.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// ph-session-move 已改为 import `loadAgents`（闭包），侧栏重投影的宿主工厂真实
// 实现是 classic sidebar-render 的 createAgentSnapshotLoaderHost：整文装载
// sidebar-render 需要整套首屏脚本序，故按仓库既有做法执行该工厂的真实源码片段
// （非复刻、非空心面），其 classic 依赖按调用契约注入。
const SIDEBAR_RENDER_SRC = fs.readFileSync(
  join(__dirname, '..', 'public', 'src', 'modules', 'sidebar-render.js'),
  'utf8',
);

const PROJECT_DATA = 'public/src/modules/project-data.js';
const PH_PROJECT_ACTIONS = 'public/src/modules/ph-project-actions.js';
const PH_SESSION_MOVE = 'public/src/modules/ph-session-move.js';
const PH_SESSION_LIST = 'public/src/modules/ph-session-list.js';
const SESSION_LIST_RENDER = 'public/src/modules/session-list-render.js';

const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };

const DIALOG_HOST_IDS = new Set(['ph-move-dialog-host', 'ph-manage-projects-host', 'ph-rebind-host', 'ph-delete-host']);

function matchesSelector(el, selector) {
  const sel = String(selector || '').trim();
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return String(el.className || '').split(/\s+/).includes(sel.slice(1));
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

/** 通用元素桩：稳定 id 引用 + 子节点记账（app-core / toast 生命周期）。 */
function makeDomElement(overrides = {}) {
  const classes = new Set();
  const children = [];
  const el = {
    id: '', className: '', innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    isConnected: true, dataset: {}, style: {}, children,
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
    setAttribute(key, value) { if (key === 'class') el.className = String(value); },
    removeAttribute() {},
    getAttribute() { return null; },
    focus() {},
    querySelector(selector) { return findDescendant(el, selector); },
    querySelectorAll(selector) {
      if (!selector) return [];
      return findDescendant(el, selector) ? [findDescendant(el, selector)] : [];
    },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0 }; },
    dispatchEvent() {},
    ...overrides,
  };
  return el;
}

/** 移动弹窗智能元素：querySelector 按选择器映射。 */
function createMoveDialogDom() {
  const errorEl = { hidden: true, textContent: '' };
  const submitBtn = { disabled: false };
  const checkedRadio = { value: '' };
  const makeListenerEl = () => ({ listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } });
  const form = makeListenerEl();
  const cancelBtn = makeListenerEl();
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

async function withMoveCase({ entities = [], target = null, openDirectory = 'D:/shared', sessionsMeta = null } = {}, probe) {
  const agent = {
    id: 'programming-helper',
    source: 'prebuilt',
    modelPresets: { default: { primary: 'm1' } },
    workspace_sessions: sessionsMeta,
    workspace_state: null,
  };
  const workspaceState = { openDirectory, phProjects: [{ openDirectory }] };
  agent.workspace_state = workspaceState;

  const requests = [];
  const fetchLog = [];
  const alerts = [];
  // 侧栏重投影的观测面：ph-session-move 已改为 import `loadAgents`（闭包，
  // window 桩不再生效）。真实 loader 的宿主契约见 agent-snapshot-loader.js；
  // 这里按契约补全宿主并在 viewer() 上记账，避免用 window 能力兜底。
  const snapshotLoads = [];
  const tabsRoot = {
    dataset: { searchAgentId: 'programming-helper', searchDirectory: '', searchProjectId: '', searchRemote: 'false', searchHostId: 'programming-helper' },
    classList: { add() {}, remove() {}, contains: () => false },
  };
  const searchPanel = { innerHTML: '' };
  const moveDialog = createMoveDialogDom();
  const openContainer = { innerHTML: '' };
  const countEls = [];
  const byId = new Map();
  let dialogCreateCount = 0;

  const document = {
    getElementById(id) {
      const key = String(id);
      if (key === 'ph-open-sessions-container') return openContainer;
      if (DIALOG_HOST_IDS.has(key)) return null;
      if (!byId.has(key)) byId.set(key, makeDomElement({ id: key }));
      return byId.get(key);
    },
    querySelector: (s) => (s === '.ph-session-tabs' ? tabsRoot : s === '.ph-search-panel' ? searchPanel : null),
    querySelectorAll: (s) => (s === '.ph-select-count' ? countEls : []),
    createElement() {
      // 前两次：弹窗 host + overlay（真实构造顺序）；其后通用 DOM。
      if (dialogCreateCount === 0) { dialogCreateCount += 1; const host = makeDomElement(); moveDialog.created.push(host); return host; }
      if (dialogCreateCount === 1) { dialogCreateCount += 1; return moveDialog.makeElement(); }
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
  let agentProvider = () => agent;
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      prepareEsmModules(sandbox, APP_CORE_DOMAIN);
      // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
      sandbox.allAgents = [agent];
      const hostSeamSource = `
        // classic 宿主面（app-main / app-ui 仍 classic）：当前记录 + 重绘 + 侧栏。
        window.getCurrentAgentRecord = () => window.__agentProvider();
        window.renderCurrentMainView = function () {};
        window.renderAgentList = function () {};
        // remote-connections 未装载：远程命名空间判定与远程目录投影的最小契约。
        window.isRemoteNamespaceAgentId = (id) => String(id || '').startsWith('remote:');
        window.getRemoteHistoryProjectBuckets = () => [];
        window.RemoteConnections = {};
        // ESM 图求值期读取的 loader host 工厂（最小契约替身；snapshot loader
        // 由 JS 侧按完整宿主契约注入，见下方 sandbox.createAgentSnapshotLoaderHost）。
        createRuntimeSwitchHost = () => ({ state: {} });
        // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader →
        // input-actions 触达 poll-coordinator-host，后者在模块求值期取该工厂。
        createPollCoordinatorHost = () => ({
          run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
        });
        createWorkspaceSurfaceHost = () => ({ state: {} });
        createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
        // agent-call-states 的宿主契约（真实实现见 classic sidebar-render 的
        // createAgentCallStatesHost）：真实 loadAgents 会经 refreshAgentCallStates
        // 消费这组 Map/Set 与 remoteEntries。
        createAgentCallStatesHost = () => ({
          calling: new Map(),
          suspended: new Set(),
          interrupting: new Map(),
          finished: new Set(),
          agents: () => [],
          currentRuntimeId: () => null,
          runtimeId: (record) => (record && record.id ? record.id : ''),
          remoteEntries: () => [],
          normalize: (value) => value || '',
          resolveCalling: () => false,
          isSuspended: () => false,
          markStarted: () => {},
          syncActionButton: () => {},
          isSseActive: () => false,
          isRemote: () => false,
          fetch: (...args) => fetch(...args),
          now: () => Date.now(),
          lastRefresh: () => 0,
          setLastRefresh: () => {},
          render: () => {},
        });
        createSessionViewCommitHost = () => ({ state: {} });
        createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
      `;
      sandbox.run(hostSeamSource);
      sandbox.__agentProvider = () => agentProvider();
      // call 状态对账引擎自 P4 T2 起是 ESM（modules/agent-call-states-engine.js），
      // 不再由 app-main 顶层建立，真实装载链见 test/frontend-agent-call-states.test.js。
      // 本文件不验引擎（只验移动链路对侧栏重投影的调用），桥键按调用契约给替身
      // ——它们在同一条 seam 的 refreshAgentCallStates / collectActiveCallRuntimeIds
      // 声明处，与真引擎的公开签名一致。
      sandbox.run(hostSeamSource);
      // 真实侧栏快照宿主工厂（sidebar-render 源码片段）：其 classic 依赖按调用
      // 契约注入；`invoke('get_connected_agents')` 与 `/api/agents` 由夹具响应，
      // 后者即「侧栏重投影真实发生」的观测点。
      sandbox.run(`
        window.invoke = async function () { return []; };
        collectActiveCallRuntimeIds = function () { return []; };
        reconcilePendingRuntimeStops = function () {};
        mergeWorkspaceSessionSnapshots = function (previous) { return previous; };
        getRuntimeId = function (record) { return record && record.id ? record.id : ''; };
        getAgentRuntimeId = function (record) { return record && record.runtime_session_id ? record.runtime_session_id : (record && record.id ? record.id : ''); };
        getLogicalAgentId = function (record) { return record && record.id ? record.id : ''; };
        resolveWorkspaceFallbackAgentId = function () { return null; };
        resolveFocusedAgentAfterRefresh = function () { return null; };
        setPreferredUnitMode = function () {};
        refreshAgentCallStates = function () {};
        renderFeaturePanel = function () {};
        loadAgentData = async function () {};
        captureSidebarSnapshotToken = function () { return null; };
        isSidebarSnapshotTokenCurrent = function () { return true; };
        queueSidebarDiagnosticEvent = function () {};
      `);
      sandbox.run(sourceBetween(SIDEBAR_RENDER_SRC, 'function createAgentSnapshotLoaderHost() {', '// Desktop notification -> modules/desktop-notify.js'));
    },
    globals: {
      document,
      URLSearchParams,
      performance,
      alert: (message) => { alerts.push(String(message)); },
      fetch(url, opts) {
        const requestUrl = String(url);
        fetchLog.push({ url: requestUrl, opts });
        const path = requestUrl.split('?')[0];
        if (path === '/protoclaw/ph_project/projects' && seedProjectsPending) {
          seedProjectsPending = false;
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: entities }) });
        }
        // 搜索重拉（成功链路的真实副作用）直接回空结果：断言只关心请求已发出。
        if (path === '/protoclaw/search_sessions') {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ results: [], total: 0 }) });
        }
        if (path === '/api/agents') {
          snapshotLoads.push(Date.now());
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ agents: [] }) });
        }
        return new Promise((resolve) => requests.push({ url: requestUrl, opts, resolve }));
      },
    },
  }, async (c) => {
    const data = await c.load(PROJECT_DATA);
    const actions = await c.load(PH_PROJECT_ACTIONS);
    const move = await c.load(PH_SESSION_MOVE);
    const sessionList = await c.load(SESSION_LIST_RENDER);
    await c.load(PH_SESSION_LIST);
    await data.ensurePhProjectEntitiesLoaded(true);
    fetchLog.length = 0;
    requests.length = 0;
    dialogCreateCount = 0;
    if (target) data.setPhBrowsingTarget('programming-helper', target);
    const currentAgent = () => c.read('allAgents').find((item) => item.id === 'programming-helper') || agent;
    agentProvider = currentAgent;
    const render = () => sessionList.renderWorkspaceSessionList(currentAgent(), {});
    return probe({
      c, data, actions, move, agent, currentAgent, workspaceState, requests, fetchLog, alerts,
      snapshotLoads, moveDialog, render, countEls,
    });
  });
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
  it('本地 PH 目录视图：工具条有多选按钮、无 checkbox；进入多选后 checkbox + 计数 + 移动入口', async () => {
    await withMoveCase({
      entities: ENTITIES,
      sessionsMeta: DIR_SLICE(['s1', 's2']),
    }, async ({ move, render }) => {
      let html = render();
      assert.match(html, /ph-select-toggle-btn[^>]*>多选</);
      assert.doesNotMatch(html, /ph-session-select"/);
      move.phToggleSessionSelectMode();
      html = render();
      assert.match(html, /ph-session-select"/);
      assert.match(html, /data-select-session-id="s1"/);
      assert.match(html, /ph-select-count[^>]*>0 已选</);
      assert.match(html, /ph-select-move-btn[^>]*>移动到…</);
      assert.match(html, /ph-select-exit-btn/);
    });
  });

  it('远程目录视图不渲染多选入口（只本地 PH）', async () => {
    await withMoveCase({ entities: [], sessionsMeta: DIR_SLICE(['r1']) }, async ({ c, data, render }) => {
      // 远程目录桶（ADR-0012）：目录本地不存在 → remoteOnly
      c.window.getRemoteHistoryProjectBuckets = () => (
        [{ openDirectory: '/srv/remote', sessions: [{ id: 'r1', title: 'R', updatedAt: '2026-10-22T10:00:00Z' }] }]
      );
      const remoteOk = data.getProgrammingHelperProjects(c.read('allAgents')[0])
        .find((p) => p.remoteOnly);
      assert.ok(remoteOk, 'remoteOnly bucket should be synthesized');
      // 导航到 remoteOnly 目录视图：入口隐藏
      const agent = c.read('allAgents')[0];
      agent.workspace_sessions = { sessions: [], sessionProjectId: '', sessionTotal: 0 };
      data.setPhBrowsingTarget('programming-helper', { type: 'dir', id: 'dir:/srv/remote' });
      const htmlGated = render();
      assert.doesNotMatch(htmlGated, /ph-select-toggle-btn/, 'remoteOnly view must not offer local move UI');
      assert.match(htmlGated, /ph-org-selector/);
    });
  });
});

describe('移动 — 弹窗目标与归属来源', () => {
  it('目录视图批量：目标 = 默认项目（当前归属禁用）+ 同目录项目；跨目录项目不出现', async () => {
    await withMoveCase({
      entities: ENTITIES,
      sessionsMeta: DIR_SLICE(['s1', 's2']),
    }, async ({ move, render, moveDialog }) => {
      render();
      move.phToggleSessionSelectMode();
      move.phToggleSessionSelection('s1', true);
      move.phToggleSessionSelection('s2', true);
      await move.phOpenSessionMoveDialog(['s1', 's2']);
      const overlayHtml = moveDialog.created[1].innerHTML;
      assert.match(overlayHtml, /默认项目/);
      assert.match(overlayHtml, /Alpha/);
      assert.match(overlayHtml, /Beta/);
      assert.doesNotMatch(overlayHtml, /Elsewhere/, 'cross-directory project must not be a target');
      assert.match(overlayHtml, /跨目录移动暂不支持/, 'copy states cross-directory is unsupported');
      // 当前归属 = directory（批量全部是目录会话）→ 默认目标禁用
      assert.match(overlayHtml, /ph-move-target-item disabled">[^<]*<input[^>]*disabled/);
    });
  });

  it('单条入口：归属从会话记录解析（项目会话 → 项目目录 + 当前项目禁用），不取页面焦点', async () => {
    // 页面焦点在目录视图，但被移动会话属于 prj_B —— 目标必须按 prj_B 的目录（D:/shared）构建
    await withMoveCase({
      entities: ENTITIES,
      sessionsMeta: {
        sessions: [
          { id: 'sD', title: 'Dir chat', updatedAt: '2026-10-22T10:00:00Z', openDirectory: 'D:/shared', messageCount: 1 },
          { id: 'sB', title: 'B chat', updatedAt: '2026-10-22T11:00:00Z', projectId: 'prj_B', messageCount: 1 },
        ],
        sessionProjectId: '', sessionTotal: 2, mainTotal: 2, archivedTotal: 0,
      },
    }, async ({ move, render, moveDialog }) => {
      render();
      await move.phOpenSessionMoveDialog(['sB']);
      const overlayHtml = moveDialog.created[1].innerHTML;
      assert.match(overlayHtml, /默认项目/);
      assert.match(overlayHtml, /Alpha/);
      // prj_B 是该会话当前归属 → 禁用；prj_A 可选（label 结构：class 先于名称文本）
      const segments = overlayHtml.split('ph-move-target-item');
      const seg = (name) => segments.find((s) => s.includes(name)) || '';
      assert.match(seg('Beta'), /^ disabled/, 'current owner project is disabled');
      assert.doesNotMatch(seg('Alpha'), /^ disabled/, 'other same-directory project is selectable');
      assert.doesNotMatch(overlayHtml, /Elsewhere/);
    });
  });

  it('单条入口：归属不可解析（无实体、无目录）→ 显式失败，不猜测', async () => {
    await withMoveCase({
      entities: ENTITIES,
      sessionsMeta: {
        sessions: [{ id: 'sGhost', title: 'Ghost', updatedAt: '2026-10-22T10:00:00Z', projectId: 'prj_gone', messageCount: 1 }],
        sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    }, async (s) => {
      s.render();
      const opening = s.move.phOpenSessionMoveDialog(['sGhost']);
      await flush();
      const lookup = s.requests.find((request) => request.url.includes('/protoclaw/prebuilt_sessions'));
      assert.ok(lookup, 'unresolved cached ownership performs an authoritative session lookup');
      await resolveAt(s, lookup, { sessions: [] });
      await opening;
      assert.ok(s.alerts.some((m) => String(m).includes('无法确定')), 'unresolvable ownership fails visibly');
      assert.equal(s.moveDialog.created.length, 0, 'no dialog opens');
    });
  });
});

describe('移动 — 请求与响应', () => {
  async function openMoveForSelection(s) {
    s.render();
    s.move.phToggleSessionSelectMode();
    s.move.phToggleSessionSelection('s1', true);
    // 工具条批量入口：无参调用（勾选后实时读 selected，渲染期列表会过期）
    await s.move.phOpenSessionMoveDialog();
    // 目标 radio：s1 是目录会话（当前归属），目录默认项被禁用 → 选第一个项目（items[1]）
    s.moveDialog.addRadio('0');
    s.moveDialog.addRadio('1');
    s.moveDialog.checkedRadio.value = '1';
  }

  it('请求形状：POST sessions_move { agentId, sessionIds, target }', async () => {
    await withMoveCase({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) }, async (s) => {
      await openMoveForSelection(s);
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
      await resolveAt(s, s.requests.at(-1), { ok: true, movedSessionIds: ['s1'], revision: 4, target: { type: 'project', id: 'prj_A' } });
      // 成功链路会继续拉切片/实体——全部消费避免悬空
      await drainRequests(s, (entry) => (entry.url.includes('/protocloud') ? {} : (entry.url.includes('/protoclaw/prebuilt_sessions') ? DIR_SLICE(['s2']) : { state: { openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }] }, projects: [] })));
      await job;
    });
  });

  it('busy 409：可读提示、弹窗保留、不假成功、无刷新副作用', async () => {
    await withMoveCase({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) }, async (s) => {
      await openMoveForSelection(s);
      const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
      await flush();
      const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
      await resolveAt(s, req, { code: 'ph_sessions_busy', error: 'sessions busy' }, false, 409);
      await job;
      assert.equal(s.moveDialog.errorEl.hidden, false);
      assert.match(s.moveDialog.errorEl.textContent, /正在执行/);
      assert.match(s.moveDialog.errorEl.textContent, /未做任何改动/);
      // 弹窗保留（可重试）：overlay 元素未被移除
      assert.equal(s.moveDialog.created[1].removed, false, 'dialog stays open after busy rejection');
      // 无刷新副作用：没有切片重拉 / loadAgents
      assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/prebuilt_sessions')));
      assert.equal(s.snapshotLoads.length, 0, 'no sidebar re-projection on rejection');
      // 多选状态保留（可重试）
      assert.equal(s.move.phSessionMove.selectMode, true);
      assert.equal(s.move.phSessionMove.selected.size, 1);
    });
  });

  it('其他错误：payload.error 呈现', async () => {
    await withMoveCase({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) }, async (s) => {
      await openMoveForSelection(s);
      const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
      await flush();
      const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
      await resolveAt(s, req, { error: 'invalid target' }, false, 400);
      await job;
      assert.match(s.moveDialog.errorEl.textContent, /invalid target/);
    });
  });

  it('成功：切片重拉（同归属）+ loadAgents 侧栏重投影 + 搜索 retry（有查询时）', async () => {
    await withMoveCase({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) }, async (s) => {
      s.c.read('phSearchQuery = "needle"');
      await openMoveForSelection(s);
      const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
      await flush();
      const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
      const moved = resolveAt(s, req, { ok: true, movedSessionIds: ['s1'], revision: 5, target: { type: 'project', id: 'prj_A' } });
      await moved;
      // 切片重拉断言在 drain 前落账（fetchLog 保留全部历史）
      await drainRequests(s, (entry) => (entry.url.includes('/protoclaw/prebuilt_sessions') ? DIR_SLICE(['s2']) : { state: { openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }] }, projects: [] }));
      await job;
      // 切片重拉按当前归属（目录目标 → projectDir）
      const slice = s.fetchLog.filter((f) => f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
      assert.ok(slice, 'slice re-pulled');
      assert.match(decodeURIComponent(slice.url), /projectDir=D:\/shared/);
      assert.equal(s.snapshotLoads.length, 1, 'sidebar re-projected (real loadAgents ran)');
      // 搜索 retry 是真实副作用：search_sessions 请求被重新发出
      assert.ok(s.fetchLog.some((f) => f.url.startsWith('/protoclaw/search_sessions?')), 'active search re-ran');
      // 多选状态清空
      assert.equal(s.move.phSessionMove.selectMode, false);
    });
  });

  it('异步竞态：移动期间浏览目标切换 → 不重拉、不覆盖当前页面', async () => {
    await withMoveCase({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) }, async (s) => {
      await openMoveForSelection(s);
      const job = s.moveDialog.form.listeners.submit[0]({ preventDefault() {} });
      await flush();
      // 移动在途时用户切到项目 prj_A
      s.data.setPhBrowsingTarget('programming-helper', { type: 'project', id: 'prj_A' });
      const req = s.requests.find((r) => r.url.includes('/protoclaw/ph_project/sessions_move'));
      await resolveAt(s, req, { ok: true, movedSessionIds: ['s1'], revision: 6, target: { type: 'directory', openDirectory: 'D:/shared' } });
      await job;
      await flush();
      // 正向锚：写请求确实成功处理到「关闭弹窗 + 多选复位」，排除 getCurrentAgentRecord
      // 为空导致 handler 提前 return 造成的零刷新假绿；零刷新由浏览目标漂移守卫造成。
      assert.equal(s.moveDialog.created[1].removed, true, 'success handler ran past the write (dialog closed)');
      assert.equal(s.move.phSessionMove.selectMode, false, 'success handler ran past the write (selection reset)');
      assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/prebuilt_sessions')), 'must not re-pull a slice for a stale view');
      assert.equal(s.snapshotLoads.length, 0, 'only the stale guard remains: sidebar re-projection skipped');
    });
  });
});

describe('移动 — 多选状态生命周期', () => {
  it('切目录/切项目即清（回调路径）', async () => {
    await withMoveCase({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1', 's2']) }, async (s) => {
      s.render();
      s.move.phToggleSessionSelectMode();
      s.move.phToggleSessionSelection('s1', true);
      assert.equal(s.move.phSessionMove.selected.size, 1);
      const switched = s.actions.phSwitchProject('dir:d:/shared');
      await flush();
      const switchReq = s.requests.find((r) => r.url === '/protoclaw/ph_project/switch');
      await resolveAt(s, switchReq, { state: { openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }] } });
      const sliceReq = s.requests.find((r) => r.url.includes('/protoclaw/prebuilt_sessions'));
      await resolveAt(s, sliceReq, DIR_SLICE(['s1', 's2']));
      await switched;
      assert.equal(s.move.phSessionMove.selectMode, false, 'select mode cleared on directory switch');
      assert.equal(s.move.phSessionMove.selected.size, 0);
    });
  });

  it('渲染期和解：切片更换后不可见 id 清理（poll 场景）', async () => {
    await withMoveCase({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1', 's2']) }, async (s) => {
      s.render();
      s.move.phToggleSessionSelectMode();
      s.move.phToggleSessionSelection('s1', true);
      s.move.phToggleSessionSelection('s2', true);
      // 模拟轮询/切片更换：s2 不在新切片里
      s.data.updateAgentRecord('programming-helper', {
        workspace_sessions: {
          sessions: [{ id: 's1', title: 'Dir s1', updatedAt: '2026-10-22T10:00:00Z', openDirectory: 'D:/shared' }],
          sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
        },
      });
      s.render();
      const state = s.move.phSessionMove;
      assert.equal(state.selectMode, true, 'same view: mode kept');
      assert.deepEqual(Array.from(state.selected), ['s1'], 'invisible ids pruned on slice replacement');
    });
  });

  it('渲染期和解：浏览目标漂移 → 整体作废', async () => {
    await withMoveCase({ entities: ENTITIES, sessionsMeta: DIR_SLICE(['s1']) }, async (s) => {
      s.render();
      s.move.phToggleSessionSelectMode();
      s.move.phToggleSessionSelection('s1', true);
      s.data.setPhBrowsingTarget('programming-helper', { type: 'project', id: 'prj_A' });
      // 渲染按项目视图（不经过切换回调，直接渲染——模拟外部状态漂移）
      s.data.updateAgentRecord('programming-helper', {
        workspace_sessions: {
          sessions: [{ id: 'sA', title: 'A chat', updatedAt: '2026-10-22T10:00:00Z', projectId: 'prj_A' }],
          sessionProjectId: 'prj_A', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
        },
      });
      s.render();
      assert.equal(s.move.phSessionMove.selectMode, false, 'browsing drift invalidates selection state');
    });
  });
});
