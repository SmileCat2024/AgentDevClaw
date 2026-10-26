/**
 * PH 项目投影前端往返（ticket 044）
 *
 * 用真实 server 投影产物驱动真实前端投影代码（vm 沙箱）：
 *   轮询链：Session 索引记录 → sessionRecordToWorkspaceMeta →
 *          buildChildRuntimeAgent（真实 wire child，含 project_id）→
 *          collectRuntimeEntriesForPrebuilt（runtime-status.js）→
 *          resolveSidebarChildProjectGroup（project-data.js）→
 *          renderSidebarChildItems（sidebar-render.js 分组渲染）
 *   乐观链：beginSidebarOperation（projectId 身份）→ normalize 清空
 *          projectDir → operation-pending 合成条目进项目身份组
 *
 * 验收锚（044 工单）：
 *   - 同目录 D 下的 A/B/D 运行中会话渲染为三个互不混入的组
 *   - 项目身份组（prj:*）与目录组均有「进入」按钮，分别使用项目 ID / 目录路径寻址
 *   - 乐观条目与轮询条目同一归属规则；无身份的操作不合成条目
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-fe-projection-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;
after(() => rmSync(DATA_ROOT, { recursive: true, force: true }));

// 真实 server 投影链（042/044 实现）
const {
  buildLightPrebuiltSessionRecord,
  sessionRecordToWorkspaceMeta,
  buildChildRuntimeAgent,
} = await import('../server/routes/session-helpers-pure.js');

const { createFrontendSandbox } = await import('./helpers/frontend-vm.js');

const DIR_D = 'D:/code/shared-dir';
const PROJECT_A = 'prj_aaaaaaaa01';
const PROJECT_B = 'prj_bbbbbbbb02';

function wireSession(id, projectId, updatedAt) {
  const record = {
    id,
    title: id + '-title',
    openDirectory: DIR_D,
    projectId,
    sessionType: 'main',
    workspaceAgentId: 'main',
    archived: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt,
    messageCount: 1,
    preview: 'p',
    fileSize: 10,
    fileMtimeMs: 1,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    modelName: 'm',
    contextLength: null,
    compressRatio: 80,
    hasSummary: false,
    sidebarMetaVersion: 1,
  };
  return projectId ? record : (() => { const { projectId: _drop, ...rest } = record; return rest; })();
}

const SESSIONS_D1 = wireSession('d1', '', '2026-10-02T00:00:00Z');
const SESSIONS_A1 = wireSession('a1', PROJECT_A, '2026-10-03T00:00:00Z');
const SESSIONS_B1 = wireSession('b1', PROJECT_B, '2026-10-04T00:00:00Z');

/** 真实 server 侧 wire child（/api/agents 里 PH 子条目的字段形状）。 */
function serverWireChild(sessionRecord, runtimeId) {
  const viewerAgent = {
    id: runtimeId,
    name: runtimeId,
    connected: true,
    created_at: '2026-10-01T10:00:00.000Z',
  };
  return buildChildRuntimeAgent(viewerAgent, {
    agentId: 'programming-helper',
    sessionId: sessionRecord.id,
    sessionMeta: sessionRecordToWorkspaceMeta(sessionRecord),
  });
}

function loadFrontend({ realSidebarRenderer = false, onSidebarClickListener } = {}) {
  const ctx = createFrontendSandbox({
    t: (key) => key,
    currentLanguage: 'zh',
    currentMessages: [],
    normalizeAgentIdentity: (x) => String(x || '').trim(),
    getPathLeaf: (value) => String(value || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '',
    toEpochMs: (value) => Date.parse(value || '') || 0,
    escapeHtml: (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])),
    isRuntimeItemActive: () => false,
    isSidebarRuntimeDisconnected: (entry) => entry?.status === 'disconnected',
    isRuntimeSuspended: () => false,
    restartingRuntimeIds: new Set(),
    _recentlyFinishedRuntimes: new Set(),
    _agentCallActive: new Map(),
    getActiveSessionId: () => '',
    getRuntimeId: (agent) => String(agent?.id || '').trim(),
    getParentAgentId: (agent) => String(agent?.parent_id || '').trim(),
    // sidebar-render.js 底部的全局事件挂载（app-ui.js 持有元素；沙箱给哑件）
    agentList: { addEventListener(type, listener) { if (type === 'click') onSidebarClickListener?.(listener); }, classList: { add() {}, remove() {}, toggle() {} }, style: {} },
  });
  ctx.window.setInterval = () => 0;
  ctx.window.SIDEBAR_TODO_COLORS = new Set(['white']);
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/project-data.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  // 全量 renderAgentList 依赖 app-core 全局；本测试只驱动投影函数，
  // 操作登记触发的侧栏失效重渲染替换为哑件（不参与断言）。
  if (!realSidebarRenderer) ctx.run('renderAgentList = () => {};');
  return ctx;
}

describe('044 前端投影往返（真实 server 输出 → 真实前端投影）', () => {
  const ctx = loadFrontend();

  // server 侧一次算好 wire children（真实链），前端沙箱内只做投影
  const wireChildren = [
    serverWireChild(SESSIONS_D1, 'rt-d1'),
    serverWireChild(SESSIONS_A1, 'rt-a1'),
    serverWireChild(SESSIONS_B1, 'rt-b1'),
  ];

  const hostFixture = () => ({
    id: 'programming-helper',
    source: 'prebuilt',
    workspace_sessions: {
      sessions: [
        buildLightPrebuiltSessionRecord('programming-helper', SESSIONS_D1),
        buildLightPrebuiltSessionRecord('programming-helper', SESSIONS_A1),
        buildLightPrebuiltSessionRecord('programming-helper', SESSIONS_B1),
      ],
      activeSessionId: '',
    },
    workspace_state: { phProjects: [] },
  });

  test('轮询 child：A/B/D 三会话三个独立组，A/B 不落入目录组', () => {
    const entries = ctx.run(`(() => {
      const host = ${JSON.stringify(hostFixture())};
      const children = ${JSON.stringify(wireChildren)};
      return collectRuntimeEntriesForPrebuilt(host, children);
    })()`);
    assert.equal(entries.length, 3);
    const bySession = new Map(entries.map((e) => [e.sessionId, e]));
    // 项目会话：projectKey 身份组，无目录分组
    assert.equal(bySession.get('a1').projectKey, 'prj:' + PROJECT_A);
    assert.equal(bySession.get('b1').projectKey, 'prj:' + PROJECT_B);
    assert.equal(bySession.get('a1').projectDir || '', '');
    assert.equal(bySession.get('b1').projectDir || '', '');
    // 目录会话：目录分组（无 projectKey）
    assert.equal(bySession.get('d1').projectKey || '', '');
    assert.equal(bySession.get('d1').projectDir, DIR_D);
    // 归属身份从 wire 透传（真实 buildChildRuntimeAgent 输出）
    assert.equal(bySession.get('a1').projectId, PROJECT_A);
    assert.equal(bySession.get('d1').projectId, '');
  });

  test('渲染：项目组与目录组分别提供正确身份的「进入」按钮', () => {
    const html = ctx.run(`(() => {
      const host = ${JSON.stringify(hostFixture())};
      const children = ${JSON.stringify(wireChildren)};
      const entries = collectRuntimeEntriesForPrebuilt(host, children);
      return renderSidebarChildItems(entries, 'programming-helper');
    })()`);
    const groups = html.split('agent-runtime-project-group').slice(1);
    assert.equal(groups.length, 3, 'three project groups rendered');
    const parsed = groups.map((chunk) => ({
      key: /data-project-key="([^"]*)"/.exec(chunk)?.[1] || '',
      enterBtn: /<button class="project-enter-btn" data-enter-type="([^"]*)" data-enter-target="([^"]*)"/.exec(chunk),
      runtimeIds: [...chunk.matchAll(/data-agent-id="([^"]*)"/g)].map((m) => m[1]),
    }));
    const projectGroups = parsed.filter((g) => g.key.startsWith('prj:'));
    const dirGroup = parsed.find((g) => !g.key.startsWith('prj:'));
    assert.equal(projectGroups.length, 2);
    // 项目身份组以 prj_* 稳定 ID 作为目标，不能退化为名称或目录路径。
    for (const group of projectGroups) {
      const [, enterType, enterTarget] = group.enterBtn || [];
      const projectId = group.key.slice('prj:'.length);
      assert.equal(enterType, 'ph-project', group.key);
      assert.equal(enterTarget, projectId, group.key);
      assert.equal(group.runtimeIds.length, 1, group.key);
    }
    assert.deepEqual(
      projectGroups.map((g) => g.runtimeIds[0]).sort(),
      ['rt-a1', 'rt-b1'],
      'project runtimes live in their own identity groups',
    );
    // 目录组：唯一持有 d1，进入按钮在（本地目录操作入口不变）
    assert.ok(dirGroup, 'directory group exists');
    const [, dirEnterType, dirEnterTarget] = dirGroup.enterBtn || [];
    assert.equal(dirEnterType, 'ph');
    assert.equal(dirEnterTarget, DIR_D);
    assert.deepEqual(dirGroup.runtimeIds, ['rt-d1']);
  });

  test('重新点击编程小助手：恢复已保存的项目会话切片', async () => {
    let clickListener = null;
    const clickCtx = loadFrontend({
      onSidebarClickListener: (listener) => { clickListener = listener; },
    });
    const calls = [];
    clickCtx.allAgents = [{ id: 'programming-helper', source: 'prebuilt' }];
    clickCtx.window.handlePrebuiltAgentClick = async (agentId) => calls.push(['workspace', agentId]);
    clickCtx.ensurePhProjectEntitiesLoaded = async () => calls.push(['projects-loaded']);
    clickCtx.getPhBrowsingTarget = () => ({ type: 'project', id: PROJECT_A });
    clickCtx.phLoadProjectSessions = async (target) => calls.push(['sessions', target]);

    const item = { dataset: { agentPrebuilt: 'true', agentId: 'programming-helper' }, classList: { contains: () => false } };
    const event = { target: { closest(selector) { return selector === '.agent-item' ? item : null; } } };
    await clickListener(event);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      ['workspace', 'programming-helper'],
      ['projects-loaded'],
      ['sessions', { projectId: PROJECT_A }],
    ]);
  });

  test('重新点击编程小助手：恢复默认目录会话切片', async () => {
    let clickListener = null;
    const clickCtx = loadFrontend({
      onSidebarClickListener: (listener) => { clickListener = listener; },
    });
    const calls = [];
    clickCtx.allAgents = [{ id: 'programming-helper', source: 'prebuilt' }];
    clickCtx.getAgentWorkspaceState = () => ({ openDirectory: DIR_D });
    clickCtx.window.handlePrebuiltAgentClick = async (agentId) => calls.push(['workspace', agentId]);
    clickCtx.ensurePhProjectEntitiesLoaded = async () => calls.push(['projects-loaded']);
    clickCtx.getPhBrowsingTarget = () => ({ type: 'dir', id: 'dir:' + DIR_D.toLowerCase(), openDirectory: DIR_D });
    clickCtx.phLoadProjectSessions = async (target) => calls.push(['sessions', target]);

    const item = { dataset: { agentPrebuilt: 'true', agentId: 'programming-helper' }, classList: { contains: () => false } };
    const event = { target: { closest(selector) { return selector === '.agent-item' ? item : null; } } };
    await clickListener(event);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      ['workspace', 'programming-helper'],
      ['projects-loaded'],
      ['sessions', { projectDir: DIR_D }],
    ]);
  });

  test('点击项目进入按钮：先进入编程小助手，再按项目 ID 切换', async () => {
    let clickListener = null;
    const clickCtx = loadFrontend({
      onSidebarClickListener: (listener) => { clickListener = listener; },
    });
    const calls = [];
    clickCtx.window.handlePrebuiltAgentClick = async (agentId) => calls.push(['workspace', agentId]);
    clickCtx.window.phSwitchProject = async (targetId) => calls.push(['target', targetId]);
    assert.equal(typeof clickListener, 'function', 'sidebar click handler is registered');

    const button = { dataset: { enterType: 'ph-project', enterTarget: PROJECT_A } };
    const event = {
      target: {
        closest(selector) {
          if (selector === '.project-enter-btn') return button;
          return null;
        },
      },
    };
    await clickListener(event);
    assert.deepEqual(calls, [
      ['workspace', 'programming-helper'],
      ['target', PROJECT_A],
    ]);
  });

  test('侧栏项目标签使用实体名称，同名项目仍按 ID 独立分组', () => {
    const named = loadFrontend();
    named.window.ClawFW.phProjectEntities.projects = [
      { id: PROJECT_A, name: '发布整理 <A>' },
      { id: PROJECT_B, name: '发布整理 <A>' },
    ];
    const html = named.run(`renderSidebarChildItems(
      collectRuntimeEntriesForPrebuilt(${JSON.stringify(hostFixture())}, ${JSON.stringify(wireChildren)}),
      'programming-helper'
    )`);
    const labels = [...html.matchAll(/class="project-collapse-label">([^<]*)</g)].map((m) => m[1]);
    assert.equal(labels.filter((label) => label === '发布整理 &lt;A&gt;').length, 2);
    assert.match(html, new RegExp('data-project-key="prj:' + PROJECT_A + '"'));
    assert.match(html, new RegExp('data-project-key="prj:' + PROJECT_B + '"'));
    assert.ok(!labels.some((label) => /^项目 [a-f0-9]+$/.test(label)));
  });

  test('首次侧栏加载即显示项目名，无须先开首页；改名后实际重绘', async () => {
    const named = loadFrontend({ realSidebarRenderer: true });
    const agents = [hostFixture(), ...wireChildren];
    let html = '';
    let requests = 0;
    named.window.ClawSidebarLayout = {
      load: async () => {}, isInteracting: () => false, signature: () => '',
      render() {
        html = named.run('renderSidebarChildItems(collectRuntimeEntriesForPrebuilt(allAgents[0], allAgents), "programming-helper")');
      },
    };
    Object.assign(named, {
      performance: { now: () => 0 }, loadAgentsInFlight: null,
      loadedAgentDetailIds: new Set(), suppressSidebarRerender: false,
      pendingPrebuiltAgentIds: new Set(), focusedAgentId: 'programming-helper',
      groupConnectedAgents: () => ({ external: [] }),
      externalAgentList: {}, externalGroup: { style: {} }, externalCount: {},
      updateCurrentAgentChrome() {}, renderFeaturePanel() {},
      refreshAgentCallStates: async () => {}, isRemoteNamespaceAgentId: () => false,
      getAgentRuntimeId: (agent) => agent.runtime_session_id || '',
      invoke: async () => agents,
      fetch: async (url) => {
        if (url === '/api/agents') return { ok: true, json: async () => ({ agents: [] }) };
        assert.equal(url, '/protoclaw/ph_project/projects?agentId=programming-helper');
        requests += 1;
        return { ok: true, json: async () => ({ projects: [
          { id: PROJECT_A, name: requests === 1 ? '发布整理' : '前端体验', workDirectory: DIR_D },
          { id: PROJECT_B, name: '另一个项目', workDirectory: DIR_D },
        ] }) };
      },
    });
    await named.run('loadAgents()');
    assert.match(html, /class="project-collapse-label">发布整理</);
    assert.match(html, /class="project-collapse-label">另一个项目</);
    await named.run('loadAgents()');
    assert.equal(requests, 1, '普通侧栏轮询复用已加载清单');
    await named.run('ensurePhProjectEntitiesLoaded(true)');
    named.run('renderAgentList()');
    assert.match(html, /class="project-collapse-label">前端体验</);
    assert.doesNotMatch(html, /class="project-collapse-label">发布整理</);
  });

  test('侧栏渲染去重在同一运行时项目归属变化后重新投影', () => {
    const live = loadFrontend({ realSidebarRenderer: true });
    const host = hostFixture();
    const runtime = { ...wireChildren[1] };
    const agents = [host, runtime];
    let html = '';
    live.allAgents = agents;
    live.focusedAgentId = 'programming-helper';
    live.currentRuntimeAgentId = '';
    live.pendingPrebuiltAgentIds = new Set();
    live.restartingRuntimeIds = new Set();
    live._recentlyFinishedRuntimes = new Set();
    live._agentCallActive = new Map();
    live.groupConnectedAgents = () => ({ external: [] });
    live.getAgentRuntimeId = (agent) => agent.runtime_session_id || agent.id || '';
    live.getParentAgentId = (agent) => agent.parent_id || '';
    live.updateCurrentAgentChrome = () => {};
    live.renderFeaturePanel = () => {};
    live.externalAgentList = {};
    live.externalGroup = { style: {} };
    live.externalCount = {};
    live.isRemoteNamespaceAgentId = () => false;
    live.window.ClawSidebarLayout = {
      signature: () => '',
      isInteracting: () => false,
      render() {
        html = live.run('renderSidebarChildItems(collectRuntimeEntriesForPrebuilt(allAgents[0], allAgents), "programming-helper")');
      },
    };

    live.run('renderAgentList()');
    assert.ok(html.includes('data-project-key="prj:' + PROJECT_A + '"'));
    assert.ok(html.includes('data-agent-id="rt-a1"'));

    runtime.project_id = '';
    live.run('renderAgentList()');
    const groups = html.split('agent-runtime-project-group').slice(1);
    assert.ok(groups.some((group) => group.includes('data-project-key="' + DIR_D + '"') && group.includes('data-agent-id="rt-a1"')));
  });

  test('项目名称请求失败保留旧清单，下次侧栏加载可以重试', async () => {
    const named = loadFrontend();
    const store = named.window.ClawFW.phProjectEntities;
    store.projects = [{ id: PROJECT_A, name: '已有名称' }];
    named.fetch = async () => ({ ok: false, status: 503 });
    await named.run('ensurePhProjectEntitiesLoaded()');
    assert.equal(store.loaded, false);
    assert.equal(store.projects[0].name, '已有名称');
    named.fetch = async () => ({ ok: true, json: async () => ({ projects: [
      { id: PROJECT_A, name: '恢复后的名称', workDirectory: DIR_D },
    ] }) });
    await named.run('ensurePhProjectEntitiesLoaded()');
    assert.equal(store.loaded, true);
    assert.equal(store.projects[0].name, '恢复后的名称');
  });

  test('乐观 child：项目操作（projectId）合成条目进项目身份组；目录身份不丢', () => {
    const result = ctx.run(`(() => {
      // 归一化契约：projectId 优先，projectDir 清空（文件环境不作分组）
      const projectOp = beginSidebarOperation({
        type: 'create', kind: 'summary', phase: 'generating',
        agentId: 'programming-helper', sourceSessionId: 'a1',
        projectId: '${PROJECT_A}', projectDir: '${DIR_D}',
      });
      const normalized = getSidebarOperation(projectOp.operationId);
      const dirOp = beginSidebarOperation({
        type: 'create', kind: 'summary', phase: 'generating',
        agentId: 'programming-helper', sourceSessionId: 'd1',
        projectDir: '${DIR_D}',
      });
      const noIdentityOp = beginSidebarOperation({
        type: 'create', kind: 'summary', phase: 'generating',
        agentId: 'programming-helper', sourceSessionId: 'x1',
      });
      const host = ${JSON.stringify(hostFixture())};
      const entries = collectRuntimeEntriesForPrebuilt(host, []);
      return {
        normalized: { projectId: normalized.projectId, projectDir: normalized.projectDir },
        entries: entries.map((e) => ({
          sessionId: e.sessionId, source: e.source,
          projectKey: e.projectKey || '', projectDir: e.projectDir || '',
        })),
        opIds: { projectOp: projectOp.operationId, dirOp: dirOp.operationId, noIdentityOp: noIdentityOp.operationId },
      };
    })()`);
    // 归一：projectId 保留，projectDir 被清空
    assert.equal(result.normalized.projectId, PROJECT_A);
    assert.equal(result.normalized.projectDir, '');
    // 两条带身份的操作合成乐观条目；无身份操作被 PH 守卫拒绝
    const optimistic = result.entries.filter((e) => e.source === 'operation-pending');
    assert.equal(optimistic.length, 2);
    const bySession = new Map(optimistic.map((e) => [e.sessionId, e]));
    assert.equal(bySession.get('a1').projectKey, 'prj:' + PROJECT_A);
    assert.equal(bySession.get('a1').projectDir, '');
    assert.equal(bySession.get('d1').projectKey, '');
    assert.equal(bySession.get('d1').projectDir, DIR_D);
    assert.equal(bySession.has('x1'), false, 'identity-less operation yields no synthetic entry');
  });
});
