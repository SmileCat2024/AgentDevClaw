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
 *   - 项目身份组（prj:*）无「进入」按钮（不是目录操作入口）；目录组有
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

function loadFrontend() {
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
    agentList: { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {} },
  });
  ctx.window.setInterval = () => 0;
  ctx.window.SIDEBAR_TODO_COLORS = new Set(['white']);
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  ctx.loadSource('public/src/modules/project-data.js');
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.loadSource('public/src/modules/sidebar-render.js');
  // 全量 renderAgentList 依赖 app-core 全局；本测试只驱动投影函数，
  // 操作登记触发的侧栏失效重渲染替换为哑件（不参与断言）。
  ctx.run('renderAgentList = () => {};');
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

  test('渲染：三个组各归其位；项目组无「进入」按钮，目录组有', () => {
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
      enterBtn: chunk.includes('project-enter-btn'),
      runtimeIds: [...chunk.matchAll(/data-agent-id="([^"]*)"/g)].map((m) => m[1]),
    }));
    const projectGroups = parsed.filter((g) => g.key.startsWith('prj:'));
    const dirGroup = parsed.find((g) => !g.key.startsWith('prj:'));
    assert.equal(projectGroups.length, 2);
    // 项目身份组：不是目录操作入口，无进入按钮（045 接项目视图前）
    for (const group of projectGroups) {
      assert.equal(group.enterBtn, false, group.key);
      assert.equal(group.runtimeIds.length, 1, group.key);
    }
    assert.deepEqual(
      projectGroups.map((g) => g.runtimeIds[0]).sort(),
      ['rt-a1', 'rt-b1'],
      'project runtimes live in their own identity groups',
    );
    // 目录组：唯一持有 d1，进入按钮在（本地目录操作入口不变）
    assert.ok(dirGroup, 'directory group exists');
    assert.equal(dirGroup.enterBtn, true);
    assert.deepEqual(dirGroup.runtimeIds, ['rt-d1']);
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
