/**
 * Ticket 045+ — PH 顶部双选择器与对话 UI（VM 沙箱驱动真实前端源码）。
 *
 * 覆盖：
 *  - 纯目录无回归（左目录选择器 + 右归属默认项 / 新对话 openDirectory / 无 projectId）
 *  - 同目录 D/A/B：左目录树二级项目、右归属只列同目录项目、切片隔离、动作显式 projectId
 *  - phSwitchProject 前端项目切换（同目录无 ph_project/switch）、未知项目拒绝
 *  - 跨目录项目（左树二级）：目录位置跟随（switch）+ 项目目标，一次切换两者
 *  - 项目绑定目录（含托管）：清单收录、纯视图导航（不写 workspace_state/不 switch）
 *  - 目录本体点击进默认集合（不恢复上次项目）
 *  - 新建项目对话框：默认当前目录 / 显式托管 / 浏览其他目录 / 无当前目录不无声指定
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
  const modeRadio = { value: '', checked: false };
  const browseRadio = { value: 'browse', checked: false };
  const browsePathEl = { textContent: '' };
  const errorEl = { hidden: true, textContent: '' };
  const submitBtn = { disabled: false };
  const form = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const browse = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const cancelBtn = { listeners: {}, addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); } };
  const refs = {
    '#ph-new-project-name': nameInput,
    'input[name="ph-new-project-dir-mode"]:checked': modeRadio,
    'input[name="ph-new-project-dir-mode"][value="browse"]': browseRadio,
    '.ph-new-project-browse-path': browsePathEl,
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
  return { refs, makeElement, created, nameInput, modeRadio, browseRadio, browsePathEl, errorEl, submitBtn, form, browse, cancelBtn };
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
  let invokeResult = null;
  const invokeCalls = [];

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
    invoke: async (mode) => { invokeCalls.push(mode); return invokeResult; },
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
  return {
    ctx, agent, currentAgent, workspaceState, requests, fetchLog, alerts, cardCalls, tabsRoot, searchPanel, dialog, render,
    setInvokeResult: (result) => { invokeResult = result; },
    invokeCalls,
  };
}

const resolve = async (entry, data, ok = true) => {
  entry.resolve({
    ok, status: ok ? 200 : 500,
    json: async () => data,
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
  });
  await flush();
};

describe('双选择器 — 纯目录无回归', () => {
  it('单一目录：左目录项 + 右「默认项目」 active + 新建对话携带 openDirectory 而非 projectId', () => {
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
    // 双选择器：左目录 / 右归属
    assert.match(html, /ph-dir-selector/);
    assert.match(html, /ph-org-selector/);
    // 左：目录项（无项目目录同样有右侧面板，只含默认项目）；触发器为 button（键盘可达）
    assert.match(html, /ph-dir-item[^>]*data-dir-id="dir:d:\/alpha"/);
    assert.doesNotMatch(html, /ph-dir-expand/);
    assert.match(html, /<button[^>]*ph-project-dropdown-trigger[^>]*aria-expanded="false"/);
    assert.match(html, /ph-dir-subprojects[^>]*data-subprojects-for="dir:d:\/alpha"/, 'project-less dir still gets a submenu');
    // 左触发器：大字目录名（主形态）
    assert.match(html, /ph-project-header-name">alpha</);
    // 右胶囊：默认项目（无项目时）
    assert.match(html, /ph-org-pill-label">默认项目</);
    // + 快速菜单：新建/管理/目录设置一步可见；胶囊菜单只做选择
    assert.match(html, /ph-quick-add-btn/);
    assert.match(html, /新建项目…/);
    assert.match(html, /管理项目…/);
    assert.match(html, /目录设置/);
    assert.doesNotMatch(html, /ph-org-selector[^"]*"[\s\S]*?ph-project-dropdown-new/, 'org menu is selection-only');
    // 左：打开目录…入口置顶（不埋在目录清单尾部）+ banner 文案
    assert.ok(html.indexOf('打开目录…') < html.indexOf('ph-dir-item'), 'open-directory entry pinned above the directory list');
    // 键盘可达：可选择菜单项带 role=menuitem + tabindex；key handler 仅在
    // 目标为自身时响应（不吞行内 button 的 Space 原生激活）
    assert.match(html, /role="menuitem" tabindex="0" onkeydown="if\(event\.target===this/);
    assert.match(html, /ph-dir-item[^>]*role="menuitem"/);
    assert.match(html, /ph-org-item[^>]*role="menuitem"/);
    assert.match(html, /ph-banner-btn[^>]*>打开目录</);
    // 右：默认项目 active
    assert.match(html, /ph-org-directory active/);
    // 新对话动作：目录身份（openDirectory 有值，无 projectId 键）
    const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
    const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(parsed.openDirectory, 'D:/alpha');
    assert.equal(parsed.projectId, undefined);
    // 恢复卡片调度：目录身份（目录桶 id，非 prj_ 项目身份）
    assert.ok(s.cardCalls.some((args) => args[1] === 'D:/alpha' && !String(args[2]).startsWith('prj_')));
  });
});

describe('双选择器 — 同目录 D/A/B', () => {
  const entities = [
    { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
    { id: 'prj_B', name: 'Beta', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
    { id: 'prj_C', name: 'Cross', workDirectory: 'D:/other', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
  ];
  const base = {
    entities,
    openDirectory: 'D:/shared',
    phProjects: [{ openDirectory: 'D:/shared' }, { openDirectory: 'D:/other' }],
  };

  it('渲染 HTML 的 div 标签平衡：多余的 </div> 会让浏览器解析时吃掉菜单容器，布局整体塌掉', () => {
    const s = createSetup({
      ...base,
      target: { type: 'project', id: 'prj_A' },
      sessionsMeta: {
        sessions: [{ id: 'sA', title: 'A chat', updatedAt: '2026-10-21T10:00:00Z', projectId: 'prj_A', messageCount: 1 }],
        sessionProjectId: 'prj_A', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    });
    const html = s.render();
    const opened = (html.match(/<div\b/g) || []).length;
    const closed = (html.match(/<\/div>/g) || []).length;
    assert.equal(opened, closed, `div tags unbalanced: ${opened} opened vs ${closed} closed`);
  });

  it('项目目标：左目录树含二级项目、右归属只列同目录项目（不跨目录）、active 归属、动作显式 projectId', () => {
    const s = createSetup({
      ...base,
      target: { type: 'project', id: 'prj_A' },
      sessionsMeta: {
        sessions: [{ id: 'sA', title: 'A chat', updatedAt: '2026-10-21T10:00:00Z', projectId: 'prj_A', messageCount: 1 }],
        sessionProjectId: 'prj_A', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    });
    const html = s.render();
    const dirSeg = html.slice(0, html.indexOf('ph-org-selector'));
    // orgSeg 止于 + 快速菜单（两者同在 ph-org-controls 内，先后渲染）
    const orgSeg = html.slice(html.indexOf('ph-org-selector'), html.indexOf('ph-quick-add'));
    // 左：目录树 —— shared 目录行 + 二级（默认项 + Alpha/Beta）；other 目录行 + Cross
    assert.match(dirSeg, /ph-dir-item[^>]*data-dir-id="dir:d:\/shared"/);
    assert.match(dirSeg, /ph-dir-item[^>]*data-dir-id="dir:d:\/other"/);
    const sharedSubStart = dirSeg.indexOf('data-subprojects-for="dir:d:/shared"');
    const otherSubStart = dirSeg.indexOf('data-subprojects-for="dir:d:/other"');
    // 目录顺序由稳定排序决定（不依赖插入顺序）：每块取自身到下一块
    const subBlockOf = (seg, start) => {
      if (start < 0) return '';
      const next = seg.indexOf('data-subprojects-for="', start + 1);
      return seg.slice(start, next < 0 ? undefined : next);
    };
    const sharedSub = subBlockOf(dirSeg, sharedSubStart);
    const otherSub = subBlockOf(dirSeg, otherSubStart);
    assert.ok(sharedSubStart >= 0, 'shared dir subprojects block exists');
    assert.ok(otherSubStart >= 0, 'other dir subprojects block exists');
    assert.match(sharedSub, /ph-dir-sub-default[^>]*data-dir-id="dir:d:\/shared"/, 'sub menu has the default directory entry');
    assert.match(sharedSub, /data-project-id="prj_A"/);
    assert.match(sharedSub, /data-project-id="prj_B"/);
    assert.doesNotMatch(sharedSub, /prj_C/);
    // 左：当前目录 active = 项目绑定目录（shared），右：项目 active
    assert.match(dirSeg, /ph-dir-item active" data-dir-id="dir:d:\/shared"/);
    // 右：默认项目（非 active）+ Alpha(active) + Beta；Cross 不跨目录出现；
    // 胶囊菜单只做选择（新建/管理在 + 快速菜单，不在胶囊菜单里）
    assert.doesNotMatch(orgSeg, /新建项目…/, 'org menu is selection-only');
    assert.match(orgSeg, /ph-org-directory[^>]*>/);
    assert.match(orgSeg, /ph-org-item active" data-project-id="prj_A"/);
    assert.match(orgSeg, /data-project-id="prj_B"/);
    assert.doesNotMatch(orgSeg, /prj_C/);
    assert.match(html, /ph-quick-menu[\s\S]*?新建项目…/, 'quick menu carries new-project');
    assert.match(html, /ph-quick-menu[\s\S]*?管理项目…/, 'quick menu carries manage');
    // 胶囊显示项目名；项目目标时 + 菜单设置项=项目设置（scope 随归属）
    assert.match(html, /ph-org-pill-label">Alpha</);
    assert.match(html, /ph-quick-menu[\s\S]*?项目设置/);
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

  it('目录目标（同目录）：左目录行 active、右默认项目 active、动作走 openDirectory、无 projectId', () => {
    const s = createSetup({
      ...base,
      target: { type: 'dir', id: 'dir:d:/shared' },
      sessionsMeta: {
        sessions: [{ id: 'sD', title: 'Dir chat', updatedAt: '2026-10-21T11:00:00Z', openDirectory: 'D:/shared', messageCount: 3 }],
        sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0,
      },
    });
    const html = s.render();
    assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/shared"/);
    assert.match(html, /ph-org-directory active/);
    assert.doesNotMatch(html, /ph-org-item active" data-project-id=/);
    const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
    const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(parsed.openDirectory, 'D:/shared');
    assert.equal(parsed.projectId, undefined);
    assert.match(html, /Dir chat/);
  });

  it('前端项目切换（同目录）：按 projectId 拉切片、不调用 ph_project/switch、目标持久化', async () => {
    const s = createSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } });
    const switched = s.ctx.run('window.phSwitchProject("prj_B")');
    await flush();
    const req = s.fetchLog.find((f) => f.url.includes('/protoclaw/prebuilt_sessions'));
    assert.ok(req, 'project slice fetch should fire');
    assert.match(req.url, /projectId=prj_B/);
    assert.doesNotMatch(req.url, /projectDir=/);
    assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/ph_project/switch')), 'same-dir project switch must stay frontend-only');
    await resolve(s.requests.at(-1), { sessions: [{ id: 'sB', title: 'B chat', updatedAt: '2026-10-22T09:00:00Z', projectId: 'prj_B', messageCount: 1 }], sessionProjectId: 'prj_B', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 });
    await switched;
    assert.equal(s.currentAgent().workspace_sessions.sessionProjectId, 'prj_B');
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(JSON.parse(stored).id, 'prj_B');
  });

  it('跨目录项目（左树二级）：目录位置跟随（switch）+ 项目目标，一次切换两者', async () => {
    const s = createSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } });
    const switched = s.ctx.run('window.phSwitchProject("prj_C")');
    await flush();
    // 1) 目录位置切换：switch 调用（registry 目录 d:/other）
    const switchReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/switch'));
    assert.ok(switchReq, 'cross-dir project must switch the workspace directory');
    assert.deepEqual(JSON.parse(switchReq.opts.body), { agentId: 'programming-helper', projectId: 'dir:d:/other' });
    await resolve(s.requests[0], { state: { openDirectory: 'D:/other', phProjects: [{ openDirectory: 'D:/shared' }, { openDirectory: 'D:/other' }] } });
    // 2) 项目切片（projectId）
    const req = s.fetchLog.find((f) => f.url.includes('/protocloud') || f.url.includes('/protoclaw/prebuilt_sessions'));
    assert.match(req.url, /projectId=prj_C/);
    await resolve(s.requests.at(-1), { sessions: [], sessionProjectId: 'prj_C', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 });
    await switched;
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(JSON.parse(stored).id, 'prj_C');
    // 双选择器同步：左 = other 目录，右 = Cross 项目
    const html = s.render();
    assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/other"/);
    assert.match(html, /ph-org-item active" data-project-id="prj_C"/);
  });

  it('目录本体点击进默认集合：不恢复上次项目', async () => {
    const s = createSetup({ ...base, target: { type: 'project', id: 'prj_A' },
      sessionsMeta: { sessions: [], sessionProjectId: 'prj_A', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 } });
    const switched = s.ctx.run('window.phSwitchProject("dir:d:/shared")');
    await flush();
    assert.ok(s.fetchLog.some((f) => f.url.includes('/protoclaw/ph_project/switch')));
    await resolve(s.requests[0], { state: { openDirectory: 'D:/shared', phProjects: [{ openDirectory: 'D:/shared' }, { openDirectory: 'D:/other' }] } });
    await resolve(s.requests.at(-1), { sessions: [{ id: 'sD2', title: 'Back to dir', updatedAt: '2026-10-22T10:00:00Z', openDirectory: 'D:/shared', messageCount: 1 }], sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 });
    await switched;
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(JSON.parse(stored).id, 'dir:d:/shared', 'directory click resets to the default collection');
    const html = s.render();
    assert.match(html, /ph-org-directory active/);
    assert.doesNotMatch(html, /ph-org-item active" data-project-id=/);
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

describe('双选择器 — 项目绑定目录（含托管）', () => {
  const managedDir = 'D:/data/workspaces/ph-projects/prj_M';
  const entities = [
    { id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
    { id: 'prj_M', name: 'Managed One', workDirectory: managedDir, directorySource: 'managed', createdAt: '2026-10-01', updatedAt: '2026-10-02' },
  ];

  it('清单收录项目绑定目录（含托管），不写目录注册表、不混入目录会话桶', () => {
    const s = createSetup({
      entities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    });
    const html = s.render();
    // 左清单含托管目录条目 + 其二级项目；托管目录不在 workspace phProjects 里
    assert.match(html, /ph-dir-item[^>]*data-dir-id="dir:d:\/data\/workspaces\/ph-projects\/prj_m"/);
    assert.match(html, /data-subprojects-for="dir:d:\/data\/workspaces\/ph-projects\/prj_m"/);
    assert.deepEqual(s.workspaceState.phProjects, [{ openDirectory: 'D:/shared' }], 'listing must not register the bound directory');
  });

  it('选择项目绑定目录：纯视图导航（无 switch、切片按 projectDir、目标持久化、workspace_state 不写）', async () => {
    const s = createSetup({
      entities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    });
    const switched = s.ctx.run('window.phSwitchProject("dir:d:/data/workspaces/ph-projects/prj_m")');
    await flush();
    assert.ok(!s.fetchLog.some((f) => f.url.includes('/protoclaw/ph_project/switch')), 'project-bound dir must not call ph_project/switch');
    const req = s.fetchLog.find((f) => f.url.includes('/protoclaw/prebuilt_sessions'));
    assert.ok(req, 'slice fetch should fire');
    assert.match(decodeURIComponent(req.url), new RegExp('projectDir=' + managedDir.replace(/\//g, '\\/')));
    await resolve(s.requests.at(-1), { sessions: [{ id: 'sM', title: 'Managed dir chat', updatedAt: '2026-10-22T08:00:00Z', openDirectory: managedDir, messageCount: 1 }], sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 });
    await switched;
    // workspace_state 不被写（无 openDirectory 变更）
    assert.equal(s.workspaceState.openDirectory, 'D:/shared');
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(JSON.parse(stored).id, 'dir:d:/data/workspaces/ph-projects/prj_m');
    // 渲染：目录视图（左 active = 托管目录；右 = 默认项目 + 同目录项目 prj_M）
    const html = s.render();
    assert.match(html, /Managed dir chat/);
    assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/data\/workspaces\/ph-projects\/prj_m"/);
    assert.match(html, /ph-org-directory active/);
    const orgSeg = html.slice(html.indexOf('ph-org-selector'));
    assert.match(orgSeg, /data-project-id="prj_M"/);
    // 新对话：目录身份（托管目录 openDirectory）
    const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
    const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(parsed.openDirectory, managedDir);
    assert.equal(parsed.projectId, undefined);
  });

  it('持久化目标指向项目绑定目录：重载不回退（stale 防污染）', () => {
    const s = createSetup({
      entities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      target: { type: 'dir', id: 'dir:d:/data/workspaces/ph-projects/prj_m' },
      sessionsMeta: { sessions: [{ id: 'sM', title: 'Managed dir chat', updatedAt: '2026-10-22T08:00:00Z', openDirectory: managedDir, messageCount: 1 }], sessionProjectId: '', sessionTotal: 1, mainTotal: 1, archivedTotal: 0 },
    });
    const html = s.render();
    assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/data\/workspaces\/ph-projects\/prj_m"/, 'stored project-bound dir target survives reload');
  });

  it('未知目录 id（既非注册桶也非项目绑定目录）：走旧 fall-through，服务端显式拒绝', async () => {
    const s = createSetup({
      entities,
      openDirectory: 'D:/shared',
      phProjects: [{ openDirectory: 'D:/shared' }],
      sessionsMeta: { sessions: [], sessionProjectId: '', sessionTotal: 0, mainTotal: 0, archivedTotal: 0 },
    });
    const switched = s.ctx.run('window.phSwitchProject("dir:/nowhere")');
    await flush();
    const switchReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/switch'));
    assert.ok(switchReq, 'unknown dir falls through to the switch endpoint');
    await resolve(s.requests[0], 'unknown directory', false);
    await switched;
    assert.ok(s.alerts.some((m) => String(m).includes('切换项目失败') || String(m).includes('Failed')), 'server rejection surfaces visibly');
  });
});

describe('双选择器 — 新建项目对话框', () => {
  const entities = [{ id: 'prj_A', name: 'Alpha', workDirectory: 'D:/shared', createdAt: '2026-10-01', updatedAt: '2026-10-02' }];
  const base = { entities, phProjects: [{ openDirectory: 'D:/shared' }], openDirectory: 'D:/shared' };

  it('取消：对话框关闭、无网络副作用、无目标变更', async () => {
    const s = createSetup(base);
    s.ctx.run('window.phOpenNewProjectDialog()');
    // created[0]=host, created[1]=overlay；取消按钮 click 绑定 close()
    const overlay = s.dialog.created[1];
    (s.dialog.cancelBtn.listeners.click || []).forEach((fn) => fn());
    assert.equal(overlay.removed, true, 'overlay should close on cancel');
    assert.equal(s.fetchLog.length, 0);
    const stored = s.ctx.run(`localStorage.getItem('protoclaw:ph-browsing-target:programming-helper')`);
    assert.equal(stored, null);
  });

  it('默认当前目录：radio 预选 current、提交携带当前目录路径', async () => {
    const s = createSetup(base);
    s.ctx.run('window.phOpenNewProjectDialog()');
    const overlayHtml = s.dialog.created[1].innerHTML;
    assert.match(overlayHtml, /value="current" checked/, 'current directory is the default selection');
    assert.match(overlayHtml, /D:\/shared/);
    s.dialog.nameInput.value = 'In Current';
    Object.assign(s.dialog.modeRadio, { value: 'current', checked: true });
    const job = s.dialog.form.listeners.submit[0]({ preventDefault() {} });
    const createReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_create'));
    assert.ok(createReq, 'create request fired');
    assert.equal(JSON.parse(createReq.opts.body).workDirectory, 'D:/shared');
    await resolve(s.requests.at(-1), { ok: false, error: 'stop here' });
    await job;
  });

  it('托管显式选择：无 workDirectory 键、创建后进入空项目（不建会话）、双选择器同步', async () => {
    const s = createSetup(base);
    s.ctx.run('window.phOpenNewProjectDialog()');
    s.dialog.nameInput.value = 'Managed';
    Object.assign(s.dialog.modeRadio, { value: 'managed', checked: true });
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
      { id: 'prj_new', name: 'Managed', workDirectory: 'D:/managed/prj_new', directorySource: 'managed', createdAt: '2026-10-23', updatedAt: '2026-10-23' },
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
    // 空项目可见 + 双选择器同步（左=托管目录，右=Managed 项目 active）
    const html = s.render();
    assert.match(html, /workspace_feature_no_sessions/);
    assert.match(html, /ph-dir-item active" data-dir-id="dir:d:\/managed\/prj_new"/);
    assert.match(html, /ph-org-item active" data-project-id="prj_new"/);
    const action = /data-workspace-action="([^"]+)"/.exec(html)[1];
    const parsed = JSON.parse(action.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    assert.equal(parsed.projectId, 'prj_new');
  });

  it('其他目录（浏览）：选后 radio 联动、提交携带浏览路径', async () => {
    const s = createSetup(base);
    s.ctx.run('window.phOpenNewProjectDialog()');
    s.dialog.nameInput.value = 'External';
    s.setInvokeResult({ path: 'E:/ext' });
    await (s.dialog.browse.listeners.click[0])();
    assert.deepEqual(s.invokeCalls, ['select_directory']);
    assert.equal(s.dialog.browseRadio.checked, true, 'browse radio auto-selects after picking a directory');
    assert.equal(s.dialog.browsePathEl.textContent, 'E:/ext');
    Object.assign(s.dialog.modeRadio, { value: 'browse', checked: true });
    const job = s.dialog.form.listeners.submit[0]({ preventDefault() {} });
    const createReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/project_create'));
    assert.equal(JSON.parse(createReq.opts.body).workDirectory, 'E:/ext');
    await resolve(s.requests.at(-1), { ok: false, error: 'stop here' });
    await job;
  });

  it('browse 模式未选路径：本地校验，不发请求', async () => {
    const s = createSetup(base);
    s.ctx.run('window.phOpenNewProjectDialog()');
    s.dialog.nameInput.value = 'X';
    Object.assign(s.dialog.modeRadio, { value: 'browse', checked: true });
    await s.dialog.form.listeners.submit[0]({ preventDefault() {} });
    assert.ok(!s.fetchLog.some((f) => f.url.includes('project_create')));
    assert.equal(s.dialog.errorEl.hidden, false);
  });

  it('无当前目录：不预选任何路径、未显式选择时拒绝提交（不无声指定）', async () => {
    const s = createSetup({ entities: [], phProjects: [], openDirectory: '' });
    s.ctx.run('window.phOpenNewProjectDialog()');
    const overlayHtml = s.dialog.created[1].innerHTML;
    assert.doesNotMatch(overlayHtml, /value="current"/, 'no current-directory option without a current directory');
    s.dialog.nameInput.value = 'Nowhere';
    Object.assign(s.dialog.modeRadio, { value: '', checked: false });
    await s.dialog.form.listeners.submit[0]({ preventDefault() {} });
    assert.ok(!s.fetchLog.some((f) => f.url.includes('project_create')), 'must not silently pick another path');
    assert.equal(s.dialog.errorEl.hidden, false);
  });

  it('名称为空：本地校验，不发请求', async () => {
    const s = createSetup(base);
    s.ctx.run('window.phOpenNewProjectDialog()');
    s.dialog.nameInput.value = '  ';
    await s.dialog.form.listeners.submit[0]({ preventDefault() {} });
    assert.ok(!s.fetchLog.some((f) => f.url.includes('project_create')));
    assert.equal(s.dialog.errorEl.hidden, false);
  });
});

describe('双选择器 — 名称相同 ID 独立', () => {
  it('两个同名项目（不同目录）：左树各挂各目录、右归属只列当前目录者、切换按 ID 拉切片、持久化 ID', async () => {
    const entities = [
      { id: 'prj_1', name: 'Same', workDirectory: 'D:/x', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
      { id: 'prj_2', name: 'Same', workDirectory: 'D:/y', createdAt: '2026-10-01', updatedAt: '2026-10-01' },
    ];
    const s = createSetup({ entities, phProjects: [{ openDirectory: 'D:/x' }, { openDirectory: 'D:/y' }], openDirectory: 'D:/x' });
    const html = s.render();
    // 左树：两个目录行，各带一个同名项目（子菜单块渲染在目录行之后，
    // 块终点取下一个子菜单块而非目录行；目录顺序由稳定排序决定）
    const dirSeg = html.slice(0, html.indexOf('ph-org-selector'));
    const xStart = dirSeg.indexOf('data-subprojects-for="dir:d:/x"');
    const xNext = dirSeg.indexOf('data-subprojects-for="', xStart + 1);
    const subX = dirSeg.slice(xStart, xNext < 0 ? undefined : xNext);
    assert.ok(xStart >= 0);
    assert.match(subX, /ph-dir-sub-default/);
    assert.match(subX, /data-project-id="prj_1"/);
    assert.doesNotMatch(subX, /prj_2/);
    // 右归属（当前目录 x）：只列 prj_1
    const orgSeg = html.slice(html.indexOf('ph-org-selector'));
    assert.match(orgSeg, /data-project-id="prj_1"/);
    assert.doesNotMatch(orgSeg, /prj_2/);
    const switched = s.ctx.run('window.phSwitchProject("prj_2")');
    await flush();
    // prj_2 跨目录（D:/y，registry）：先目录位置跟随，再项目切片
    const switchReq = s.fetchLog.find((f) => f.url.includes('/protoclaw/ph_project/switch'));
    assert.ok(switchReq, 'cross-dir project switches the workspace directory first');
    assert.deepEqual(JSON.parse(switchReq.opts.body), { agentId: 'programming-helper', projectId: 'dir:d:/y' });
    await resolve(s.requests[0], { state: { openDirectory: 'D:/y', phProjects: [{ openDirectory: 'D:/x' }, { openDirectory: 'D:/y' }] } });
    const req = s.fetchLog.filter((f) => f.url.includes('/protoclaw/prebuilt_sessions')).at(-1);
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
