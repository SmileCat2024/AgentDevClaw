/**
 * PH 项目会话归属、派生与运行时装配（ticket 042）
 *
 * 行为契约（docs/tickets/042 + 2026-10-22-ph-project-coexistence.md）：
 * - 创建：D 目录对话与同路径 A/B 项目对话三组独立创建，索引归属正确
 *   （项目会话带 projectId + openDirectory=项目当前目录；目录会话不带非空
 *   projectId）；无项目参数保持旧目录语义（回退 state.openDirectory），
 *   不查找同路径项目；显式非法/未知项目报错不退回目录路径；其他 agent
 *   不接受 PH 项目身份；项目下的"新对话N"编号独立。
 * - 派生：branch（直接构造索引的路径）与 compacted successor
 *   （createPrebuiltSession sourceSessionId 继承）都从来源索引继承 projectId
 *   与 workspaceAgentId，当前选择不覆盖；显式传入与来源不一致报错。
 * - 激活/保存：项目会话激活不把旧目录写回目录选择 state；session_meta_sync
 *   保留归属；索引落盘重启（重读）仍保留归属。
 * - 运行时：resolveSessionRuntimeDirectory（server 侧 placement 与三类宿主
 *   共用的单源规则）严格解析项目目录；resolveManagedProcessPlacement 第三参
 *   让项目会话的进程分组与 workspaceCwd 跟随项目目录。
 *
 * 全程隔离数据根（AGENTDEV_DATA_DIR），无真实模型请求、无 runtime 子进程。
 * harness 参照 ph-project-store.test.js / session-extraction.test.js。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-session-lifecycle-'));
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

// 先设 env 再 import：ph-projects / session-access 模块链在 import 时解析数据根
const {
  createPhProject,
  getPhProjectStorePath,
} = await import('../server/routes/ph-projects.js');
const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { setupSessionRoutes } = await import('../server/routes/session.js');
const { readWorkspaceState, writeWorkspaceState } = await import('../server/routes/workspace.js');
const {
  getSessionProjectId,
  resolveSessionRuntimeDirectory,
} = await import('../server/shared/session-project.js');
const { computeNextSessionNumber } = await import('../server/shared/session-access.js');
const {
  buildSessionWorkspaceEnv,
  buildSharedSessionStartMessage,
  resolveManagedProcessPlacement,
} = await import('../server/routes/agent-startup.js');
const { resolveWorkspaceCwd: mirrorResolveWorkspaceCwd } = await import('../scripts/mirror-runtime.js');

// ── harness ──────────────────────────────────────────────────────────────

// 真实 workspace state 读写（隔离根下），其余注入最小 stub
function makeHelpers() {
  return createSessionHelpers({
    readWorkspaceState,
    writeWorkspaceState,
    discoverAgents: async () => [
      { id: 'programming-helper' },
      { id: 'coder' },
    ],
    enrichAgent: async (agent) => agent,
    startManagedAgent: async () => ({ ok: true }),
    waitForManagedRuntimeReady: async () => true,
  });
}

function captureHandlers(helpers) {
  const handlers = {};
  const app = {
    get: (p, ...rest) => { handlers[`GET ${p}`] = rest[rest.length - 1]; },
    post: (p, ...rest) => { handlers[`POST ${p}`] = rest[rest.length - 1]; },
    put: (p, ...rest) => { handlers[`PUT ${p}`] = rest[rest.length - 1]; },
    delete: (p, ...rest) => { handlers[`DELETE ${p}`] = rest[rest.length - 1]; },
  };
  const noop = async () => {};
  setupSessionRoutes(app, { json: () => (_req, _res, next) => next?.() }, {
    ...helpers,
    requireAgentLight: async (agentId) => ({ id: agentId, permissions: undefined }),
    discoverAgents: async () => [{ id: 'programming-helper' }, { id: 'coder' }],
    startManagedAgent: async () => ({ ok: true }),
    stopManagedAgent: noop,
    waitForManagedRuntimeReady: async () => true,
    notifySessionLineage: null,
    notifySessionArchived: null,
    clearUISurfaces: noop,
    threadRotation: {},
    threadLifecycle: { findThreadBySession: async () => null },
    threadSuccession: {},
    threadDelete: {},
  });
  return handlers;
}

function makeRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    error: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonPayload = payload; },
  };
}

async function call(handler, req) {
  const res = makeRes();
  await handler(req, res, (error) => { res.error = error; });
  return res;
}

// 最小可分支会话快照：branch 只消费 messages / rollbackHistory / runtime
function writeSessionSnapshot(agentId, sessionId, messageCount = 2) {
  const messages = Array.from({ length: messageCount }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `m${i}`,
    turn: Math.floor(i / 2),
  }));
  const filePath = join(DATA_ROOT, 'workspaces', agentId, 'sessions', `${sessionId}.json`);
  writeFileSync(filePath, JSON.stringify({
    sessionId,
    savedAt: Date.now(),
    runtime: { callIndex: Math.max(-1, Math.ceil(messageCount / 2) - 1), callState: 'idle', context: { messages, enrichedMessages: [] }, featureStates: [] },
    rollbackHistory: [],
  }), 'utf8');
  return filePath;
}

// ── 场景夹具 ─────────────────────────────────────────────────────────────

/** 同一外部目录 dirD 上的目录对话 D + 项目 A/B（coexistence 验收形态） */
async function setupCoexistenceFixture() {
  const helpers = makeHelpers();
  const dirD = makeExternalDir('claw-ph-dirD-');
  const stateBefore = await readWorkspaceState('programming-helper');
  await writeWorkspaceState('programming-helper', { ...stateBefore, openDirectory: dirD });

  const projectA = await createPhProject({ name: 'A', workDirectory: dirD });
  const projectB = await createPhProject({ name: 'B', workDirectory: dirD });

  return { helpers, dirD, projectA, projectB };
}

// ── 1. 创建与索引归属 ────────────────────────────────────────────────────

describe('042 创建：三组独立归属', () => {
  test('D 目录对话与同路径 A/B 项目对话分别创建，索引归属正确', async () => {
    const { helpers, dirD, projectA, projectB } = await setupCoexistenceFixture();

    const dirSession = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, openDirectory: dirD, title: '新对话1',
    });
    const aSession = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id,
    });
    const bSession = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectB.id,
    });

    assert.equal(getSessionProjectId(dirSession), '');
    assert.ok(!('projectId' in dirSession), '目录会话轻记录不带非空 projectId 字段');
    assert.equal(aSession.projectId, projectA.id);
    assert.equal(bSession.projectId, projectB.id);

    // 项目会话 openDirectory = 项目当前目录（创建时记录）；目录会话 = 显式目录
    assert.equal(
      aSession.openDirectory.replace(/\\/g, '/').toLowerCase(),
      projectA.workDirectory.replace(/\\/g, '/').toLowerCase(),
    );
    assert.equal(
      dirSession.openDirectory.replace(/\\/g, '/').toLowerCase(),
      dirD.replace(/\\/g, '/').toLowerCase(),
    );

    // 索引是归属权威：A/B/D 三条记录互不混
    const { readSessionIndex } = await import('../server/shared/session-access.js');
    const index = await readSessionIndex('programming-helper');
    const records = index.sessions.filter((s) =>
      [dirSession.id, aSession.id, bSession.id].includes(s.id));
    assert.equal(records.length, 3);
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    assert.equal(getSessionProjectId(byId[dirSession.id]), '');
    assert.equal(byId[aSession.id].projectId, projectA.id);
    assert.equal(byId[bSession.id].projectId, projectB.id);
  });

  test('无项目参数保持目录语义：回退 workspace state 当前目录，不查找同路径项目', async () => {
    const { helpers, dirD, projectA } = await setupCoexistenceFixture();
    assert.ok(projectA, '同路径项目存在但不参与无参创建的归属');

    const session = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false,
    });
    assert.equal(getSessionProjectId(session), '');
    assert.equal(
      session.openDirectory.replace(/\\/g, '/').toLowerCase(),
      dirD.replace(/\\/g, '/').toLowerCase(),
    );
  });

  test('显式非法/未知项目报错不退回目录路径；其他 agent 不接受 PH 项目身份', async () => {
    const { helpers, dirD } = await setupCoexistenceFixture();

    await assert.rejects(
      helpers.createPrebuiltSession('programming-helper', { returnSummary: false, projectId: 'dir:/not-a-project' }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /Invalid projectId/);
        return true;
      },
    );
    await assert.rejects(
      helpers.createPrebuiltSession('programming-helper', { returnSummary: false, projectId: 'prj_ffffffffffff' }),
      (error) => {
        assert.equal(error.statusCode, 404);
        assert.match(error.message, /Unknown project/);
        return true;
      },
    );
    await assert.rejects(
      helpers.createPrebuiltSession('coder', { returnSummary: false, projectId: 'prj_000000000000', openDirectory: dirD }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /only supported for programming-helper/);
        return true;
      },
    );
  });

  test('项目下的新对话编号独立，不与同目录其他集合混用', async () => {
    const { helpers, dirD, projectA, projectB } = await setupCoexistenceFixture();
    // 预置：D 目录已有 新对话2；A 项目已有 新对话1（同一路径 dirD）
    await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, openDirectory: dirD, title: '新对话2',
    });
    await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id, title: '新对话1',
    });

    const dNext = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, openDirectory: dirD,
    });
    const aNext = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id,
    });
    const bNext = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectB.id,
    });
    assert.equal(dNext.title, '新对话3');
    assert.equal(aNext.title, '新对话2');
    assert.equal(bNext.title, '新对话1');
  });

  test('并发创建按提交顺序分配唯一连续编号', async () => {
    const { helpers, dirD } = await setupCoexistenceFixture();
    const created = await Promise.all(Array.from({ length: 8 }, () =>
      helpers.createPrebuiltSession('programming-helper', {
        returnSummary: false,
        openDirectory: dirD,
      }),
    ));
    assert.deepEqual(
      created.map((session) => session.title).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))),
      Array.from({ length: 8 }, (_, index) => `新对话${index + 1}`),
    );
  });

  test('computeNextSessionNumber 归属隔离纯函数：项目集合看 projectId，目录集合排除项目会话', () => {
    const sessions = [
      { title: '新对话2', openDirectory: '/proj' },
      { title: '新对话1', openDirectory: '/proj', projectId: 'prj_aaaaaaaaaaaa' },
      { title: '新对话5', openDirectory: '/other', projectId: 'prj_bbbbbbbbbbbb' },
    ];
    assert.equal(computeNextSessionNumber(sessions, '/proj'), 3);
    assert.equal(computeNextSessionNumber(sessions, '/proj', { projectId: 'prj_aaaaaaaaaaaa' }), 2);
    assert.equal(computeNextSessionNumber(sessions, '/proj', { projectId: 'prj_bbbbbbbbbbbb' }), 6);
    assert.equal(computeNextSessionNumber(sessions, '/proj', { projectId: 'prj_cccccccccccc' }), 1);
  });

  test('创建项目会话不把项目目录写回目录选择 state（目录会话仍写回）', async () => {
    const { helpers, dirD, projectA } = await setupCoexistenceFixture();
    const dirBefore = (await readWorkspaceState('programming-helper')).openDirectory;

    await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id,
    });
    assert.equal(
      (await readWorkspaceState('programming-helper')).openDirectory.replace(/\\/g, '/').toLowerCase(),
      dirBefore.replace(/\\/g, '/').toLowerCase(),
      '项目会话创建不得改写目录选择',
    );

    const otherDir = makeExternalDir('claw-ph-dirE-');
    await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, openDirectory: otherDir,
    });
    assert.equal(
      (await readWorkspaceState('programming-helper')).openDirectory.replace(/\\/g, '/').toLowerCase(),
      otherDir.replace(/\\/g, '/').toLowerCase(),
      '目录会话创建写回当前目录（原行为回归）',
    );
  });
});

// ── 2. 派生继承 ──────────────────────────────────────────────────────────

describe('042 派生：分支与接续继承来源归属', () => {
  test('branch（直接构造分支索引）继承来源 projectId 与 workspaceAgentId', async () => {
    const { helpers, dirD, projectA } = await setupCoexistenceFixture();
    // workspaceAgentId 保留验证：PH metadata 未声明 agents → 'main'
    const source = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id,
    });
    assert.equal(source.workspaceAgentId, 'main');
    writeSessionSnapshot('programming-helper', source.id);

    const handlers = captureHandlers(helpers);
    const res = await call(handlers['POST /protoclaw/sessions/branch'], {
      body: { agentId: 'programming-helper', sourceSessionId: source.id, cutMsgIndexEnd: 1 },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.jsonPayload.ok);
    const newId = res.jsonPayload.newSessionId;

    const { readSessionIndex } = await import('../server/shared/session-access.js');
    const index = await readSessionIndex('programming-helper');
    const branch = index.sessions.find((s) => s.id === newId);
    assert.ok(branch, 'branch record in index');
    assert.equal(branch.projectId, projectA.id);
    assert.equal(branch.workspaceAgentId, 'main');
    // 分支记录 openDirectory 继承来源旧记录（运行目录权威仍是项目表）
    assert.equal(
      branch.openDirectory.replace(/\\/g, '/').toLowerCase(),
      source.openDirectory.replace(/\\/g, '/').toLowerCase(),
    );
  });

  test('compacted successor（createPrebuiltSession sourceSessionId）继承来源归属；目录来源不被项目化', async () => {
    const { helpers, dirD, projectA } = await setupCoexistenceFixture();
    const projectSource = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id, title: 'srcA',
    });
    const dirSource = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, openDirectory: dirD, title: 'srcD',
    });

    const successor = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, sourceSessionId: projectSource.id,
    });
    assert.equal(successor.projectId, projectA.id);
    assert.equal(successor.workspaceAgentId, projectSource.workspaceAgentId);

    const dirSuccessor = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, sourceSessionId: dirSource.id,
    });
    assert.equal(getSessionProjectId(dirSuccessor), '');
    assert.ok(!('projectId' in dirSuccessor));
  });

  test('显式 projectId 与来源归属不一致报错；来源项目已失效时继承也报错', async () => {
    const { helpers, dirD, projectA, projectB } = await setupCoexistenceFixture();
    const source = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id,
    });

    await assert.rejects(
      helpers.createPrebuiltSession('programming-helper', {
        returnSummary: false, sourceSessionId: source.id, projectId: projectB.id,
      }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /must retain its source project/);
        return true;
      },
    );

    // 模拟项目失效（从表中移除）：继承路径同样必须报错，不退回目录会话
    const dirSource2 = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, openDirectory: dirD,
    });
    const store = JSON.parse(readFileSync(getPhProjectStorePath(), 'utf8'));
    store.projects = store.projects.filter((p) => p.id !== projectA.id);
    writeFileSync(getPhProjectStorePath(), JSON.stringify(store, null, 2), 'utf8');

    await assert.rejects(
      helpers.createPrebuiltSession('programming-helper', {
        returnSummary: false, sourceSessionId: source.id,
      }),
      (error) => {
        assert.equal(error.statusCode, 404);
        assert.match(error.message, /Unknown project/);
        return true;
      },
    );
    // 目录来源派生不受项目表变化影响
    const dirSuccessor = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, sourceSessionId: dirSource2.id,
    });
    assert.ok(dirSuccessor.id);
  });
});

// ── 3. 激活、保存与重启恢复 ─────────────────────────────────────────────

describe('042 激活与保存：归属保留', () => {
  test('激活项目会话不把旧目录写回目录选择；目录会话激活保持原写回', async () => {
    const { helpers, dirD, projectA } = await setupCoexistenceFixture();
    const otherDir = makeExternalDir('claw-ph-dirF-');
    const stateBefore = await readWorkspaceState('programming-helper');
    await writeWorkspaceState('programming-helper', { ...stateBefore, openDirectory: otherDir });

    const projectSession = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id,
    });
    await helpers.activatePrebuiltSession('programming-helper', projectSession.id, { returnSummary: false });
    assert.equal(
      (await readWorkspaceState('programming-helper')).openDirectory.replace(/\\/g, '/').toLowerCase(),
      otherDir.replace(/\\/g, '/').toLowerCase(),
      '项目会话激活不得把旧目录/项目目录写回目录选择',
    );

    const dirSession = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, openDirectory: dirD,
    });
    await helpers.activatePrebuiltSession('programming-helper', dirSession.id, { returnSummary: false });
    assert.equal(
      (await readWorkspaceState('programming-helper')).openDirectory.replace(/\\/g, '/').toLowerCase(),
      dirD.replace(/\\/g, '/').toLowerCase(),
      '目录会话激活写回会话目录（原行为回归）',
    );
  });

  test('session_meta_sync 保留 projectId；标题更新后仍保留', async () => {
    const { helpers, projectA } = await setupCoexistenceFixture();
    const session = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id,
    });
    writeSessionSnapshot('programming-helper', session.id);

    const handlers = captureHandlers(helpers);
    const metaRes = await call(handlers['POST /protoclaw/session_meta_sync'], {
      body: {
        agentId: 'programming-helper',
        sessionId: session.id,
        messageCount: 2,
        preview: 'after sync',
        tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    });
    assert.equal(metaRes.jsonPayload.ok, true);

    const titleRes = await call(handlers['PUT /protoclaw/prebuilt_sessions/:sessionId/title'], {
      params: { sessionId: session.id },
      body: { agentId: 'programming-helper', title: '改名后的项目会话' },
    });
    assert.equal(titleRes.jsonPayload.ok, true);

    const { readSessionIndex } = await import('../server/shared/session-access.js');
    const record = (await readSessionIndex('programming-helper')).sessions.find((s) => s.id === session.id);
    assert.equal(record.projectId, projectA.id, 'meta_sync/标题更新后归属保留');
    assert.equal(record.title, '改名后的项目会话');
  });

  test('索引落盘与重读（重启恢复形态）保留归属；旧记录无 projectId 不被批量补字段', async () => {
    const { helpers, dirD, projectA } = await setupCoexistenceFixture();
    await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, projectId: projectA.id,
    });
    // 旧形态记录（无 projectId 字段）预置进索引
    const { updateSessionIndex } = await import('../server/shared/session-access.js');
    await updateSessionIndex('programming-helper', (index) => ({
      ...index,
      sessions: [
        { id: 'session-legacy-0001', title: '旧目录会话', openDirectory: dirD, sessionType: 'main', workspaceAgentId: 'main' },
        ...index.sessions,
      ],
    }));

    // 落盘字节：新项目会话带字段，旧记录不被补字段
    const raw = readFileSync(
      join(DATA_ROOT, 'workspaces', 'programming-helper', 'sessions', 'index.json'), 'utf8');
    const persisted = JSON.parse(raw);
    const legacy = persisted.sessions.find((s) => s.id === 'session-legacy-0001');
    assert.ok(legacy);
    assert.ok(!('projectId' in legacy), '不批量给历史记录补 projectId');
    const projectRecord = persisted.sessions.find((s) => s.projectId === projectA.id);
    assert.ok(projectRecord, '项目会话归属已落盘');

    // 重读归一：目录会话（旧/新）projectId === ''，项目会话保留
    const { readSessionIndex } = await import('../server/shared/session-access.js');
    const reread = await readSessionIndex('programming-helper');
    assert.equal(getSessionProjectId(reread.sessions.find((s) => s.id === 'session-legacy-0001')), '');
    assert.equal(reread.sessions.find((s) => s.projectId === projectA.id).projectId, projectA.id);

    // 再触发一次索引写入（读→改→写回 round-trip）：旧记录仍不得被批量补上
    // projectId 空字段——updateSessionIndex 的写入数据来自归一化读取，读取
    // 侧若无条件补 key，任何 meta_sync/标题/激活写都会改写全部历史记录。
    await updateSessionIndex('programming-helper', (index) => ({
      ...index,
      activeSessionId: index.sessions[0]?.id || null,
    }));
    const rawAfterRewrite = JSON.parse(readFileSync(
      join(DATA_ROOT, 'workspaces', 'programming-helper', 'sessions', 'index.json'), 'utf8'));
    const legacyAfterRewrite = rawAfterRewrite.sessions.find((s) => s.id === 'session-legacy-0001');
    assert.ok(!('projectId' in legacyAfterRewrite), '索引写回不批量给历史记录补 projectId');
    assert.ok(rawAfterRewrite.sessions.find((s) => s.projectId === projectA.id), '项目会话归属写回保留');
  });
});

// ── 4. 运行时身份与目录解析 ─────────────────────────────────────────────

describe('042 运行时：项目目录严格解析与装配传递', () => {
  test('resolveSessionRuntimeDirectory：目录会话 null；项目会话当前目录；失效身份 throw', async () => {
    const dirD = makeExternalDir('claw-ph-dirG-');
    const project = await createPhProject({ name: 'RT', workDirectory: dirD });

    // 目录会话 → null（调用方继续 openDirectory 语义）
    assert.equal(resolveSessionRuntimeDirectory({ openDirectory: dirD }), null);
    assert.equal(resolveSessionRuntimeDirectory({}), null);
    assert.equal(resolveSessionRuntimeDirectory(null), null);

    // 项目会话 → 项目表当前目录
    assert.equal(
      resolveSessionRuntimeDirectory({ projectId: project.id, openDirectory: 'D:/stale' }),
      project.workDirectory,
    );

    // 未知项目 → throw（不退回 openDirectory）
    assert.throws(
      () => resolveSessionRuntimeDirectory({ projectId: 'prj_ffffffffffff' }, { sessionId: 's1' }),
      /unknown PH project prj_ffffffffffff.*session=s1/,
    );

    // 项目存在但目录已消失 → throw
    const ghost = { id: 'prj_0123456789ab', name: 'Ghost', workDirectory: join(dirD, 'gone'),
      directorySource: 'external', archived: false, createdAt: '', updatedAt: '', archivedAt: null };
    const store = JSON.parse(readFileSync(getPhProjectStorePath(), 'utf8'));
    store.projects.push(ghost);
    writeFileSync(getPhProjectStorePath(), JSON.stringify(store, null, 2), 'utf8');
    assert.throws(
      () => resolveSessionRuntimeDirectory({ projectId: 'prj_0123456789ab' }),
      /work directory does not exist/,
    );
  });

  test('resolveManagedProcessPlacement 第三参：projectDir 跟随项目目录；shared-global 进程形态不变', () => {
    const agent = { id: 'programming-helper', processMode: 'shared-global' };
    const sessionRecord = { openDirectory: 'D:/stale-open-dir', projectId: 'prj_aaaaaaaaaaaa' };

    // 缺省（目录会话语义）：沿用 openDirectory
    const byOpenDir = resolveManagedProcessPlacement(agent, sessionRecord);
    assert.equal(byOpenDir.projectDir, 'D:/stale-open-dir');

    // 项目会话：调用方解析出的项目目录优先。shared-global 的分组键对所有
    // 目录恒为 agent::__global__（与 agent-lifecycle.test.js 既有断言一致，
    // 契约"不为配置隔离强制修改现有进程模式"）——项目身份经 per-session
    // workspaceCwd 传递，不拆进程。
    const byProject = resolveManagedProcessPlacement(agent, sessionRecord, 'D:/current-project-dir');
    assert.equal(byProject.projectDir, 'D:/current-project-dir');
    assert.equal(byProject.processGroupKey, 'programming-helper::__global__');
    assert.equal(byProject.processGroupKey, byOpenDir.processGroupKey);

    // shared-by-project：目录确实参与分组，分组键跟随解析后的项目目录
    const byProjectShared = resolveManagedProcessPlacement(
      { id: 'programming-helper', processMode: 'shared-by-project' },
      sessionRecord,
      'D:/current-project-dir',
    );
    const byOpenDirShared = resolveManagedProcessPlacement(
      { id: 'programming-helper', processMode: 'shared-by-project' },
      { openDirectory: 'D:/stale-open-dir' },
    );
    assert.equal(byProjectShared.projectDir, 'D:/current-project-dir');
    assert.notEqual(byProjectShared.processGroupKey, byOpenDirShared.processGroupKey);

    // 旧两参调用（agent-lifecycle 既有断言形态）不变
    const isolated = resolveManagedProcessPlacement({ id: 'coder' }, { openDirectory: 'D:/x' });
    assert.equal(isolated.processGroupKey, null);
  });

  test('首 Session env 与 add-session 消息携带项目目录（shared-global 不丢项目身份）', () => {
    const projectDir = 'D:/resolved-project-dir';
    assert.deepEqual(
      buildSessionWorkspaceEnv('programming-helper', 's1', projectDir),
      { PROTOCLAW_SESSION_WORKSPACE_CWD: projectDir },
    );
    const message = buildSharedSessionStartMessage({
      sessionId: 's2', agentName: 'PH', projectDir, handoffPath: null, runtime: null,
    });
    assert.equal(message.workspaceCwd, projectDir);
    assert.equal(message.type, 'add-session');
  });

  test('mirror 宿主接线：项目会话经项目表解析目录；目录会话保持 openDirectory', async () => {
    const dirD = makeExternalDir('claw-ph-dirH-');
    const project = await createPhProject({ name: 'Mirror', workDirectory: dirD });

    const sessionDir = join(DATA_ROOT, 'workspaces', 'programming-helper', 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessions = [
      { id: 'session-proj-0001', openDirectory: 'D:/stale', projectId: project.id },
      { id: 'session-dir-0001', openDirectory: dirD },
    ];
    writeFileSync(join(sessionDir, 'index.json'), JSON.stringify({ revision: 1, activeSessionId: null, sessions }), 'utf8');

    assert.equal(
      mirrorResolveWorkspaceCwd('programming-helper', 'D:/fallback-root', 'session-proj-0001'),
      project.workDirectory,
      '项目会话：mirror 用项目当前目录而非旧记录',
    );
    assert.equal(
      mirrorResolveWorkspaceCwd('programming-helper', 'D:/fallback-root', 'session-dir-0001'),
      dirD,
      '目录会话：openDirectory 语义不变',
    );

    // 项目失效（表清空）→ mirror 不退回 fallback 根目录
    writeFileSync(getPhProjectStorePath(), JSON.stringify({ schemaVersion: 1, projects: [] }), 'utf8');
    assert.throws(
      () => mirrorResolveWorkspaceCwd('programming-helper', 'D:/fallback-root', 'session-proj-0001'),
      /unknown PH project/,
    );
  });

  test('保存目录回归：shared-global 首 Session env 缺目录仍报错（原约束不放松）', () => {
    // 报错文案是既有产品语义（与 agent-lifecycle.test.js 同款断言形态），
    // 042 只约束目录解析来源，不放松缺目录防线。
    assert.throws(
      () => buildSessionWorkspaceEnv('programming-helper', 'missing-workdir', ''),
      /explicit session project directory/,
    );
  });
});

// ── 5. 旧目录定向回归 ───────────────────────────────────────────────────

describe('042 旧目录回归', () => {
  test('computeNextSessionNumber 两参调用（旧签名）行为不变', () => {
    const sessions = [
      { title: '新对话2', openDirectory: '/project' },
      { title: '新对话5', openDirectory: '/project-a' },
    ];
    assert.equal(computeNextSessionNumber(sessions, '/project'), 3);
    assert.equal(computeNextSessionNumber(sessions, '/project-a'), 6);
    assert.equal(computeNextSessionNumber([], '/project'), 1);
  });

  test('目录会话创建响应（轻记录）不含 projectId 键，字段形状与旧版兼容', async () => {
    const { helpers, dirD } = await setupCoexistenceFixture();
    const session = await helpers.createPrebuiltSession('programming-helper', {
      returnSummary: false, openDirectory: dirD,
    });
    assert.ok(!('projectId' in session));
    assert.equal(session.workspaceAgentId, 'main');
    assert.equal(session.sessionType, 'main');
    assert.ok(session.id && session.createdAt && session.updatedAt);
    assert.ok(existsSync(join(DATA_ROOT, 'workspaces', 'programming-helper', 'sessions', 'index.json')));
  });
});
