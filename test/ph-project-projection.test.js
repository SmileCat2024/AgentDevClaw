/**
 * PH 项目投影与旧目录操作隔离（ticket 044）
 *
 * 行为契约（docs/tickets/044 + 2026-10-22-ph-project-coexistence.md）：
 * - 同目录 D 与项目 A/B 是三个互斥会话集合：项目过滤按 projectId 身份，
 *   目录过滤（projectDir）排除一切非空 projectId 会话；分页/计数/标题与
 *   内容搜索同一归属规则。
 * - 归档/删除回选（selectFallbackSession）不跨集合；目录批量删除
 *   （deletePrebuiltProject）不删除 A/B 的索引或正文。
 * - 旧外围不收编项目会话：调度 extractProjectId / __latest__、群聊候选、
 *   workspace 从历史补目录（deriveDirectoryPhProjectsFromSessions）。
 * - 内容搜索索引（v2）条目携带归属；旧持久缓存经 Session 索引元数据补
 *   projectId，不重读历史正文（不称迁移）。
 * - 全局总览（session_directory / buildSessionDirectoryEntries）保留全部
 *   三类会话并透传归属身份。
 *
 * 全程隔离数据根（AGENTDEV_DATA_DIR 先于 import 设置）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-projection-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;
const EXTERNAL_ROOTS = [];

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  for (const dir of EXTERNAL_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeExternalDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  EXTERNAL_ROOTS.push(dir);
  return dir;
}

// 先设 env 再 import：模块链在 import 时解析数据根
const { createPhProject } = await import('../server/routes/ph-projects.js');
const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { setupSessionRoutes } = await import('../server/routes/session.js');
const { readWorkspaceState, writeWorkspaceState } = await import('../server/routes/workspace.js');
const {
  sliceSessionsForWire,
  sessionRecordToWorkspaceMeta,
  buildChildRuntimeAgent,
  buildSessionDirectoryEntries,
  buildLightPrebuiltSessionRecord,
} = await import('../server/routes/session-helpers-pure.js');
const { selectFallbackSession } = await import('../server/routes/session-helpers.js');
const { deriveDirectoryPhProjectsFromSessions } = await import('../server/routes/workspace-projects.js');
const { ProgrammingHelperProjectAdapter } = await import('../server/routes/dispatch.js');
const {
  ensureSearchIndex,
  searchSessionsContent,
  invalidateSearchIndex,
  getSearchIndexPath,
} = await import('../server/routes/session-search-index.js');
const { getPrebuiltAgentSessionDir, getPrebuiltSessionFilePath } = await import('../server/shared/session-access.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
const { getSessionProjectId } = await import('../server/shared/session-project.js');

// ── 场景夹具：D 目录 + 同路径 A/B 项目，三组会话（目录/项目各 3 条） ─────

let dirD;
let projectA;
let projectB;
let helpers;

/** 会话记录工厂：目录会话不带 projectId（字段缺席），项目会话带。 */
function dirSession(id, { title = id, archived = false, updated = id } = {}) {
  return {
    id, title, openDirectory: dirD, archived,
    sessionType: 'main', workspaceAgentId: 'main',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: `2026-10-0${updated}T00:00:00Z`,
    messageCount: 1, preview: 'p', fileSize: 10, fileMtimeMs: 1,
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    modelName: 'm', contextLength: null, compressRatio: 80, hasSummary: false,
    sidebarMetaVersion: 1,
  };
}
function projectSession(id, projectId, { title = id, archived = false, updated = id } = {}) {
  return { ...dirSession(id, { title, archived, updated }), projectId, openDirectory: dirD };
}

function dRecords() {
  return [dirSession('d1'), dirSession('d2'), dirSession('d3', { archived: true })];
}
function aRecords() {
  return [projectSession('a1', projectA.id), projectSession('a2', projectA.id, { archived: true })];
}
function bRecords() {
  return [projectSession('b1', projectB.id), projectSession('b2', projectB.id)];
}
function allRecords() {
  return [...dRecords(), ...aRecords(), ...bRecords()].map((record) => buildLightPrebuiltSessionRecord('programming-helper', record));
}

before(async () => {
  dirD = makeExternalDir('claw-044-dirD-');
  projectA = await createPhProject({ name: 'A', workDirectory: dirD });
  projectB = await createPhProject({ name: 'B', workDirectory: dirD });
  helpers = createSessionHelpers({
    readWorkspaceState,
    writeWorkspaceState,
    discoverAgents: async () => [{ id: 'programming-helper' }, { id: 'coder' }],
    enrichAgent: async (agent) => agent,
    startManagedAgent: async () => ({ ok: true }),
    waitForManagedRuntimeReady: async () => true,
  });
});

// ── 1. sliceSessionsForWire：D/A/B 过滤、分页、计数、搜索 ────────────────

describe('044 列表归属过滤（sliceSessionsForWire）', () => {
  test('projectDir=D 只含目录会话；projectId=A 只含 A；互不渗透', () => {
    // archived 筛选缺省 = 全部（含归档 tab 的会话）
    const dirPage = sliceSessionsForWire(allRecords(), { projectDir: dirD });
    assert.deepEqual(dirPage.slice.map((s) => s.id).sort(), ['d1', 'd2', 'd3']);
    assert.equal(dirPage.total, 3);
    assert.deepEqual([dirPage.mainTotal, dirPage.archivedTotal], [2, 1]);

    const aPage = sliceSessionsForWire(allRecords(), { projectId: projectA.id });
    assert.deepEqual(aPage.slice.map((s) => s.id).sort(), ['a1', 'a2']);
    assert.deepEqual([aPage.mainTotal, aPage.archivedTotal], [1, 1]);

    const bPage = sliceSessionsForWire(allRecords(), { projectId: projectB.id });
    assert.deepEqual(bPage.slice.map((s) => s.id).sort(), ['b1', 'b2']);
    assert.deepEqual([bPage.mainTotal, bPage.archivedTotal], [2, 0]);
  });

  test('分页与计数：归属集合内切片，total/hasMore 一致', () => {
    const all = sliceSessionsForWire(allRecords(), {});
    assert.equal(all.total, 7);
    const page = sliceSessionsForWire(allRecords(), { offset: 1, limit: 2 });
    assert.equal(page.slice.length, 2);
    assert.equal(page.total, 7);
    const dirOnly = sliceSessionsForWire(allRecords(), { projectDir: dirD, offset: 1, limit: 1 });
    assert.equal(dirOnly.total, 3);
    assert.equal(dirOnly.slice.length, 1);
    const aOnly = sliceSessionsForWire(allRecords(), { projectId: projectA.id, offset: 1, limit: 5 });
    assert.equal(aOnly.total, 2);
    assert.equal(aOnly.slice.length, 1);
  });

  test('标题搜索在归属集合内进行（目录搜索不搜到 A/B 标题命中）', () => {
    const dirHit = sliceSessionsForWire(allRecords(), { projectDir: dirD, query: 'a1' });
    assert.equal(dirHit.total, 0);
    const aHit = sliceSessionsForWire(allRecords(), { projectId: projectA.id, query: 'a1' });
    assert.equal(aHit.total, 1);
    const dirSelfHit = sliceSessionsForWire(allRecords(), { projectDir: dirD, query: 'd1' });
    assert.equal(dirSelfHit.total, 1);
  });

  test('archived tab 过滤与归属正交', () => {
    const dirArchived = sliceSessionsForWire(allRecords(), { projectDir: dirD, archived: 'archived' });
    assert.deepEqual(dirArchived.slice.map((s) => s.id), ['d3']);
    const aMain = sliceSessionsForWire(allRecords(), { projectId: projectA.id, archived: 'main' });
    assert.deepEqual(aMain.slice.map((s) => s.id), ['a1']);
  });

  test('目录过滤大小写/斜杠归一不受影响；projectId 精确比较', () => {
    const dirAlt = sliceSessionsForWire(allRecords(), { projectDir: dirD.toUpperCase() + '\\' });
    assert.equal(dirAlt.total, 3);
    assert.equal(sliceSessionsForWire(allRecords(), { projectId: projectA.id.toUpperCase() }).total, 0);
  });
});

// ── 2. 列表读模型贯通（真实 helpers + 路由层） ───────────────────────────

describe('044 列表读模型与路由', () => {
  const AGENT = 'programming-helper';

  async function writeIndex(records) {
    mkdirSync(getPrebuiltAgentSessionDir(AGENT), { recursive: true });
    writeFileSync(join(getPrebuiltAgentSessionDir(AGENT), 'index.json'),
      JSON.stringify({ revision: 1, activeSessionId: null, sessions: records }), 'utf8');
  }

  function captureListRoute() {
    const handlers = {};
    const fakeMethods = {
      get: (p, ...rest) => { handlers[`GET ${p}`] = rest[rest.length - 1]; },
      post: () => {}, put: () => {}, delete: () => {}, patch: () => {},
    };
    const app = { ...fakeMethods };
    // 方法调用需保持 this 无关（纯对象函数）
    setupSessionRoutes(app, { json: () => (_req, _res, next) => next?.() }, {
      ...helpers,
      requireAgentLight: async (agentId) => ({ id: agentId }),
      discoverAgents: async () => [{ id: AGENT }],
      startManagedAgent: async () => ({ ok: true }),
      stopManagedAgent: async () => {},
      waitForManagedRuntimeReady: async () => true,
      notifySessionLineage: null,
      notifySessionArchived: null,
      clearUISurfaces: async () => {},
      threadRotation: {},
      threadLifecycle: { findThreadBySession: async () => null },
      threadSuccession: {},
      threadDelete: {},
    });
    return handlers['GET /protoclaw/prebuilt_sessions'];
  }

  function makeRes() {
    return {
      statusCode: 200, payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; },
    };
  }

  before(async () => {
    await writeIndex([...dRecords(), ...aRecords(), ...bRecords()]);
  });

  test('projectId 查询返回 A 集合并携带 sessionProjectId 元信息', async () => {
    const handler = captureListRoute();
    const res = makeRes();
    await handler({ query: { agentId: AGENT, projectId: projectA.id, wireTrim: '1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.sessions.map((s) => s.id).sort(), ['a1', 'a2']);
    assert.equal(res.payload.sessionProjectId, projectA.id);
    assert.equal(res.payload.sessionTotal, 2);
  });

  test('目录查询（workspace state 缺省目录）排除 A/B', async () => {
    const handler = captureListRoute();
    const res = makeRes();
    await handler({ query: { agentId: AGENT, projectDir: dirD } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.sessions.map((s) => s.id).sort(), ['d1', 'd2', 'd3']);
  });

  test('无效 projectId：非法格式 400 / 未知项目 404 / 与 projectDir 互斥 400', async () => {
    const handler = captureListRoute();
    const cases = [
      [{ agentId: AGENT, projectId: 'not-an-id' }, 400, /Invalid projectId/],
      [{ agentId: AGENT, projectId: 'prj_ffffffffffff' }, 404, /Unknown project/],
      [{ agentId: AGENT, projectId: projectA.id, projectDir: dirD }, 400, /互斥/],
    ];
    for (const [query, code, pattern] of cases) {
      const res = makeRes();
      await handler({ query }, res);
      assert.equal(res.statusCode, code, JSON.stringify(query));
      assert.match(res.payload.error, pattern);
    }
  });
});

// ── 3. 回选与目录批量删除隔离 ────────────────────────────────────────────

describe('044 回选与删除隔离', () => {
  function registerRunning(agentId, sessionId) {
    const key = `${agentId}::${sessionId}`;
    managedAgents.set(key, {
      key, id: agentId, agentId, selectedSessionId: sessionId,
      process: { exitCode: null, pid: 4242 }, stopped: false, stopping: false,
    });
  }

  test('删除/归档 A 内会话回选不跨到 D 或 B（同目录同 openDirectory）', () => {
    const source = projectSession('a1', projectA.id);
    // a2 同项目运行中、d1/b1 同目录运行中——只有 a2 可回选
    registerRunning('programming-helper', 'a2');
    registerRunning('programming-helper', 'd1');
    registerRunning('programming-helper', 'b1');
    const remaining = [projectSession('a2', projectA.id), dirSession('d1'), projectSession('b1', projectB.id)];
    const fallback = selectFallbackSession('programming-helper', remaining, source);
    assert.equal(fallback?.id, 'a2');
  });

  test('目录会话回选排除项目会话；项目无运行中会话回退 null', () => {
    // 隔离：清掉上一用例注册的运行态，避免跨用例泄漏
    managedAgents.clear();
    registerRunning('programming-helper', 'b1');
    const dirFallback = selectFallbackSession(
      'programming-helper',
      [dirSession('d1'), projectSession('b1', projectB.id)],
      dirSession('d0'),
    );
    assert.equal(dirFallback, null); // 目录集合无运行中 → null，不借 b1

    const projectFallback = selectFallbackSession(
      'programming-helper',
      [dirSession('d1'), projectSession('a2', projectA.id)],
      projectSession('a1', projectA.id),
    );
    assert.equal(projectFallback, null); // A 内无运行中 → null，不借 d1
  });

  test('目录批量删除不删 A/B 索引与正文', async () => {
    const AGENT = 'programming-helper';
    mkdirSync(getPrebuiltAgentSessionDir(AGENT), { recursive: true });
    const records = [...dRecords(), ...aRecords(), ...bRecords()];
    for (const record of records) {
      writeFileSync(getPrebuiltSessionFilePath(AGENT, record.id), '{}', 'utf8');
    }
    await writeWorkspaceState(AGENT, {
      forms: {},
      openDirectory: dirD,
      phProjects: [{ id: `dir:${dirD.replace(/\\/g, '/').toLowerCase()}`, openDirectory: dirD }],
    });
    writeFileSync(join(getPrebuiltAgentSessionDir(AGENT), 'index.json'),
      JSON.stringify({ revision: 1, activeSessionId: null, sessions: records }), 'utf8');

    const deleted = await helpers.deletePrebuiltProject(AGENT, `dir:${dirD.replace(/\\/g, '/').toLowerCase()}`);
    assert.deepEqual(deleted.deletedSessionIds.sort(), ['d1', 'd2', 'd3']);

    const index = JSON.parse(readFileSync(join(getPrebuiltAgentSessionDir(AGENT), 'index.json'), 'utf8'));
    assert.deepEqual(index.sessions.map((s) => s.id).sort(), ['a1', 'a2', 'b1', 'b2']);
    for (const id of ['a1', 'a2', 'b1', 'b2']) {
      assert.equal(existsSync(getPrebuiltSessionFilePath(AGENT, id)), true, `${id} transcript must survive`);
    }
    for (const id of ['d1', 'd2', 'd3']) {
      assert.equal(existsSync(getPrebuiltSessionFilePath(AGENT, id)), false, `${id} transcript must be removed`);
    }
  });
});

// ── 4. 身份贯通：meta / child / 全局总览 ────────────────────────────────

describe('044 身份贯通投影', () => {
  test('sessionRecordToWorkspaceMeta 透传 project_id（目录 = 空串）', () => {
    assert.equal(sessionRecordToWorkspaceMeta(projectSession('a1', projectA.id)).project_id, projectA.id);
    assert.equal(sessionRecordToWorkspaceMeta(dirSession('d1')).project_id, '');
  });

  test('buildChildRuntimeAgent：乐观 child 与轮询 child 同形携带 project_id', () => {
    const viewerAgent = { id: 'rt-1', name: 'runtime', connected: true };
    const projectChild = buildChildRuntimeAgent(viewerAgent, {
      agentId: 'programming-helper',
      sessionId: 'a1',
      sessionMeta: sessionRecordToWorkspaceMeta(projectSession('a1', projectA.id)),
    });
    assert.equal(projectChild.project_id, projectA.id);
    assert.equal(projectChild.open_directory, dirD); // 文件环境仍在，归属另行判定

    const dirChild = buildChildRuntimeAgent(viewerAgent, {
      agentId: 'programming-helper',
      sessionId: 'd1',
      sessionMeta: sessionRecordToWorkspaceMeta(dirSession('d1')),
    });
    assert.equal(dirChild.project_id, '');
  });

  test('全局总览（session_directory）保留三类会话并透传归属', () => {
    const agentIndexEntries = [
      { agentId: 'programming-helper', agentName: '编程小助手', sessions: [...dRecords(), ...aRecords(), ...bRecords()] },
    ];
    // includeArchived: true 才含归档（d3/a2），身份透传覆盖全部三集合
    const entries = buildSessionDirectoryEntries(agentIndexEntries, { includeArchived: true });
    assert.equal(entries.length, 7);
    const byId = new Map(entries.map((e) => [e.sessionId, e]));
    assert.equal(byId.get('d1').projectId, '');
    assert.equal(byId.get('a1').projectId, projectA.id);
    assert.equal(byId.get('b1').projectId, projectB.id);
    // 缺省跳过归档的既有行为不变
    assert.equal(buildSessionDirectoryEntries(agentIndexEntries).length, 5);
  });
});

// ── 5. 外围目录集合隔离 ─────────────────────────────────────────────────

describe('044 外围目录集合', () => {
  test('调度 extractProjectId：项目会话不入目录桶（session 形输入）', () => {
    const adapter = new ProgrammingHelperProjectAdapter();
    assert.equal(adapter.extractProjectId(projectSession('a1', projectA.id)), null);
    assert.equal(adapter.extractProjectId(projectSession('b1', projectB.id)), null);
    // 目录会话与目录形状输入照旧
    const dirId = `dir:${dirD.replace(/\\/g, '/').toLowerCase()}`;
    assert.equal(adapter.extractProjectId(dirSession('d1')), dirId);
    assert.equal(adapter.extractProjectId({ openDirectory: dirD }), dirId);
  });

  test('workspace 从历史补目录：项目会话不播种目录列表', () => {
    const derived = deriveDirectoryPhProjectsFromSessions([
      ...aRecords(), ...bRecords(),
      dirSession('d1'),
      // 项目会话引用的目录 Even 唯一：若无隔离会把 dirD 播进目录列表
    ]);
    assert.equal(derived.length, 1);
    assert.equal(derived[0].openDirectory, dirD);
  });
});

// ── 6. 内容搜索索引：归属 + 旧缓存补身份 ────────────────────────────────

describe('044 内容搜索归属', () => {
  const AGENT = 'ph-search-probe';

  function transcript(messages) {
    return { runtime: { context: { messages } } };
  }

  function writeSessionFiles(records, texts) {
    mkdirSync(getPrebuiltAgentSessionDir(AGENT), { recursive: true });
    for (const record of records) {
      writeFileSync(getPrebuiltSessionFilePath(AGENT, record.id),
        JSON.stringify(transcript([{ role: 'user', content: texts[record.id] || 'plain' }])), 'utf8');
    }
    writeFileSync(join(getPrebuiltAgentSessionDir(AGENT), 'index.json'),
      JSON.stringify({ revision: 1, activeSessionId: null, sessions: records }), 'utf8');
  }

  before(async () => {
    invalidateSearchIndex(AGENT);
    const records = [
      dirSession('d1'),
      projectSession('a1', projectA.id),
      projectSession('b1', projectB.id),
    ];
    writeSessionFiles(records, { d1: 'needle in dir', a1: 'needle in project a', b1: 'needle in project b' });
  });

  test('目录过滤搜索排除 A/B；项目过滤只回本集合；结果透传归属', async () => {
    const dirResults = await searchSessionsContent(AGENT, 'needle', dirD, {});
    assert.deepEqual(dirResults.results.map((r) => r.sessionId), ['d1']);
    assert.equal(dirResults.results[0].projectId, '');

    const aResults = await searchSessionsContent(AGENT, 'needle', '', { projectId: projectA.id });
    assert.deepEqual(aResults.results.map((r) => r.sessionId), ['a1']);
    assert.equal(aResults.results[0].projectId, projectA.id);

    const bResults = await searchSessionsContent(AGENT, 'needle', '', { projectId: projectB.id });
    assert.deepEqual(bResults.results.map((r) => r.sessionId), ['b1']);

    const all = await searchSessionsContent(AGENT, 'needle', '', {});
    assert.equal(all.results.length, 3); // 全局搜索可见三类（审计语义）
  });

  test('旧 v2 持久缓存（无 projectId）经索引元数据补身份，不重读正文', async () => {
    // 构造旧缓存：条目无 projectId、msgs 完整、fileMtimeMs 与索引一致
    const records = [
      dirSession('d1'),
      projectSession('a1', projectA.id),
      projectSession('b1', projectB.id),
    ];
    const oldEntries = {};
    for (const record of records) {
      oldEntries[record.id] = {
        sessionId: record.id,
        title: record.title,
        openDirectory: record.openDirectory,
        // 无 projectId —— 044 之前的 v2 形状
        sessionType: 'main',
        archived: false,
        todo: false,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
        messageCount: 1,
        fileMtimeMs: record.fileMtimeMs,
        msgs: [{ i: 0, r: 'user', t: 'legacy cached needle' }],
      };
    }
    writeFileSync(getSearchIndexPath(AGENT),
      JSON.stringify({ version: 2, entries: oldEntries }), 'utf8');
    invalidateSearchIndex(AGENT); // 清内存缓存，强制走持久层

    // 删掉正文文件：命中缓存的条目不会重读正文；若实现错误重扫，条目会消失
    rmSync(getPrebuiltSessionFilePath(AGENT, 'a1'), { force: true });

    const entries = await ensureSearchIndex(AGENT);
    assert.equal(entries.get('a1').projectId, projectA.id, 'identity patched from session index');
    assert.equal(entries.get('a1').msgs.length, 1, 'msgs preserved from cache');
    assert.match(entries.get('a1').msgs[0].t, /legacy cached needle/);
    assert.equal(entries.get('d1').projectId, '');

    // 补身份后的搜索按归属隔离：目录过滤命中 d1（同为 legacy 文案的目录会话）
    const aResults = await searchSessionsContent(AGENT, 'legacy', '', { projectId: projectA.id });
    assert.deepEqual(aResults.results.map((r) => r.sessionId), ['a1']);
    const dirResults = await searchSessionsContent(AGENT, 'legacy', dirD, {});
    assert.deepEqual(dirResults.results.map((r) => r.sessionId), ['d1']);
  });
});
