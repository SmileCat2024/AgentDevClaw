/**
 * PH Session 正式归属转移（ph_project/sessions_move）
 *
 * 行为契约：
 * - 同一有效工作目录内：默认目录 ↔ 项目、项目 A ↔ 项目 B；跨目录显式拒绝。
 * - 移动非复制：session id / 历史 / workspaceAgentId / checkpoint 全保留，
 *   会话文件本体字节不动；只改索引记录归属字段（projectId / openDirectory）。
 * - 全部先校验后释放：busy（执行中轮次 / 排队输入 / 探测失败）409 且零状态
 *   变化；批量预校验不通过绝不部分改归属。
 * - 空闲存活实例按「精确单会话 + waitForPersistence」释放，共享进程兄弟
 *   会话不受影响；下次启动按目标归属重新装配（项目表 + 配置层真实重解析）。
 * - 释放窗口（门闩）内：并发重叠移动 409、新输入 409、派生会话 409、涉及
 *   项目的改绑 / 归档 / 删除 409；窗口结束即恢复。
 * - 归属无变化 = no-op 成功：不停实例、不重写索引、不递增 revision。
 * - 目标项目未知 / 归档、无效 Session、跨目录 → 具体错误码显式失败。
 *
 * 全程隔离数据根（AGENTDEV_DATA_DIR），无真实模型请求、无 runtime 子进程；
 * 生命周期依赖注入假件，逐调用断言精确停止范围。harness 参照
 * ph-project-rebind-retirement.test.js。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-session-move-'));
process.env.AGENTDEV_DATA_DIR = DATA_ROOT;

const EXTERNAL_ROOTS = [];
function makeExternalDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  EXTERNAL_ROOTS.push(dir);
  return dir;
}

after(() => {
  rmSync(DATA_ROOT, { recursive: true, force: true });
  for (const dir of EXTERNAL_ROOTS) rmSync(dir, { recursive: true, force: true });
});

// 先设 env 再 import：ph-projects / session-access 模块链在 import 时解析数据根
const {
  createPhProject,
  getPhProject,
  getPhProjectStorePath,
  movePhSessions,
  rebindPhProject,
  setPhProjectArchived,
  deletePhProject,
  previewPhProjectDeletion,
  isPhSessionRebindGated,
  isPhProjectRebindActive,
  getPhSessionGateInfo,
  setupPhProjectRoutes,
} = await import('../server/routes/ph-projects.js');
const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { readWorkspaceState, writeWorkspaceState } = await import('../server/routes/workspace.js');
const { readSessionIndex, getPrebuiltSessionFilePath } = await import('../server/shared/session-access.js');
const { resolveSessionRuntimeDirectory, getSessionProjectId } = await import('../server/shared/session-project.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
const { deliverUserInput, UserTurnDeliveryError } = await import('../server/thread-control/input-gateway.js');
const { buildScopeLayers } = await import('../server/routes/feature-config.js');
const { projectLayerPath } = await import('../server/shared/feature-config-layers.js');
const { getRecoverySessions, addOpenSession } = await import('../server/shared/open-sessions-tracker.js');

const AGENT = 'programming-helper';

// ── harness ──────────────────────────────────────────────────────────────

function makeHelpers() {
  return createSessionHelpers({
    readWorkspaceState,
    writeWorkspaceState,
    discoverAgents: async () => [{ id: AGENT }, { id: 'coder' }],
    enrichAgent: async (agent) => agent,
    startManagedAgent: async () => ({ ok: true }),
    waitForManagedRuntimeReady: async () => true,
  });
}

/**
 * 假 runtime 注册表 + 生命周期依赖（与 rebind 测试同款）。
 * runtimes: Map<sessionId, { viewerAgentId, busy: {callActive, queued} }>。
 * stops 逐调用记录，供断言精确停止范围（必须带 sessionId + waitForPersistence）。
 */
function makeLifecycleDeps({ runtimes, stopImpl, viewerImpl } = {}) {
  const stops = [];
  return {
    stops,
    deps: {
      getAgentRuntime: (agentId, sessionId) => (runtimes.has(sessionId)
        ? { agentId, selectedSessionId: sessionId, viewerAgentId: runtimes.get(sessionId).viewerAgentId || null }
        : undefined),
      isManagedRuntimeRunning: () => true,
      stopManagedAgent: async (agentId, sessionId, opts) => {
        stops.push({ agentId, sessionId, opts });
        if (stopImpl) await stopImpl(agentId, sessionId, opts);
      },
      readViewerJson: async (pathname) => {
        if (viewerImpl) return viewerImpl(pathname);
        if (pathname.endsWith('/notification')) return { callActive: false };
        if (pathname.endsWith('/queued-inputs')) return [];
        throw new Error(`unexpected viewer path in test: ${pathname}`);
      },
      readWorkspaceState,
    },
  };
}

function viewerFromRuntimes(runtimes) {
  return (pathname) => {
    const match = pathname.match(/^\/api\/agents\/view-([^/]+)\/(notification|queued-inputs)$/);
    if (!match) throw new Error(`unexpected viewer path: ${pathname}`);
    const entry = [...runtimes.values()].find((item) => item.viewerAgentId === `view-${match[1]}`) || null;
    if (!entry) throw new Error('viewer agent not found');
    if (match[2] === 'notification') return { callActive: !!entry.busy?.callActive };
    return entry.busy?.queued || [];
  };
}

function normDir(value) {
  return String(value).replace(/\\/g, '/').toLowerCase();
}

/** 会话文件正文（runtime 保存的快照形态）：消息 + checkpoint。 */
function writeSessionBody(sessionId, { cwd = '' } = {}) {
  const filePath = getPrebuiltSessionFilePath(AGENT, sessionId);
  const body = {
    runtime: {
      context: {
        cwd,
        messages: [
          { role: 'user', turn: 1, content: `hello from ${sessionId}` },
          { role: 'assistant', turn: 1, content: 'ack' },
        ],
        checkpoints: [{ callIndex: 1, label: 'cp-1', createdAt: '2026-10-23T00:00:00.000Z' }],
      },
    },
    savedAt: 1760000000000,
  };
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(body, null, 2), 'utf8');
  return { filePath, bytes: readFileSync(filePath) };
}

/**
 * 预置：外部目录 dirX 上项目 A / B + 目录会话 D（coexistence 形态）。
 * 返回 helpers、项目、会话与假 runtime 表（全员空闲）。
 */
async function setupMoveFixture() {
  const helpers = makeHelpers();
  const dirX = makeExternalDir('claw-ph-mv-dirX-');
  const dirY = makeExternalDir('claw-ph-mv-dirY-');
  const state = await readWorkspaceState(AGENT);
  await writeWorkspaceState(AGENT, { ...state, openDirectory: dirX });

  const projectA = await createPhProject({ name: 'A', workDirectory: dirX });
  const projectB = await createPhProject({ name: 'B', workDirectory: dirX });
  const sessionA1 = await helpers.createPrebuiltSession(AGENT, { returnSummary: false, projectId: projectA.id });
  const sessionA2 = await helpers.createPrebuiltSession(AGENT, { returnSummary: false, projectId: projectA.id });
  const sessionB1 = await helpers.createPrebuiltSession(AGENT, { returnSummary: false, projectId: projectB.id });
  const sessionD = await helpers.createPrebuiltSession(AGENT, { returnSummary: false, openDirectory: dirX, title: 'dir chat' });

  const runtimes = new Map();
  for (const session of [sessionA1, sessionA2, sessionB1, sessionD]) {
    runtimes.set(session.id, { viewerAgentId: `view-${session.id}`, busy: { callActive: false, queued: [] } });
  }

  const bodies = new Map();
  for (const session of [sessionA1, sessionA2, sessionB1, sessionD]) {
    bodies.set(session.id, writeSessionBody(session.id, { cwd: dirX }));
  }

  return {
    helpers, dirX, dirY, projectA, projectB,
    sessionA1, sessionA2, sessionB1, sessionD,
    runtimes, bodies,
  };
}

async function readRecord(sessionId) {
  const index = await readSessionIndex(AGENT);
  return index.sessions.find((s) => s.id === sessionId) || null;
}

// ── 1. 往返与保留 ────────────────────────────────────────────────────────

describe('归属转移：往返与事实保留', () => {
  test('项目 A → 项目 B（同目录）：projectId 翻转、id/历史/workspaceAgentId/checkpoint/文件字节全保留', async () => {
    const fixture = await setupMoveFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    const before = await readRecord(fixture.sessionA1.id);
    assert.equal(before.workspaceAgentId, 'main');
    const beforeRevision = (await readSessionIndex(AGENT)).revision;

    const result = await movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'project', id: fixture.projectB.id },
    }, deps);

    assert.deepEqual(result.movedSessionIds, [fixture.sessionA1.id]);
    assert.deepEqual(result.releasedSessionIds, [fixture.sessionA1.id]);
    assert.equal(result.revision, beforeRevision + 1, '单次批量一次 revision 递增');
    assert.equal(result.target.type, 'project');
    assert.equal(result.target.id, fixture.projectB.id);

    const after = await readRecord(fixture.sessionA1.id);
    const expected = { ...before, projectId: fixture.projectB.id, openDirectory: fixture.projectB.workDirectory };
    assert.deepEqual(after, expected, '除归属字段外记录逐字段保留（updatedAt 也不重写）');
    assert.equal(after.workspaceAgentId, before.workspaceAgentId);

    // 会话文件本体一字节不动（消息 / checkpoint / savedAt 都在文件里）
    const body = fixture.bodies.get(fixture.sessionA1.id);
    assert.deepEqual(readFileSync(body.filePath), body.bytes, '会话文件字节不动（移动非复制）');
    const parsedBody = JSON.parse(readFileSync(body.filePath, 'utf8'));
    assert.equal(parsedBody.runtime.context.checkpoints.length, 1, 'checkpoint 保留');
    assert.equal(parsedBody.runtime.context.messages.length, 2, '历史消息保留');

    // 精确停止：只停被转移会话，带 waitForPersistence
    assert.equal(stops.length, 1);
    assert.equal(stops[0].sessionId, fixture.sessionA1.id);
    assert.equal(stops[0].opts?.waitForPersistence, true);

    // 门闩已释放
    assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), false);
  });

  test('项目 → 默认目录（同目录）：projectId 字段删除、目录语义恢复、往返闭环', async () => {
    const fixture = await setupMoveFixture();
    const { deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });

    // B1 项目会话 → 默认目录
    const toDirectory = await movePhSessions({
      sessionIds: [fixture.sessionB1.id],
      target: { type: 'directory', openDirectory: fixture.dirX },
    }, deps);
    assert.deepEqual(toDirectory.movedSessionIds, [fixture.sessionB1.id]);
    assert.equal(toDirectory.target.type, 'directory');

    let record = await readRecord(fixture.sessionB1.id);
    assert.equal(getSessionProjectId(record), '', 'projectId 归一为空');
    assert.ok(!('projectId' in record), '目录会话记录不携带 projectId 键（与历史形态一致）');
    assert.equal(normDir(record.openDirectory), normDir(fixture.dirX));
    assert.equal(resolveSessionRuntimeDirectory(record, { sessionId: record.id }), null, '目录语义：不再按项目表解析');

    // 往返：默认目录 → 项目 B（同目录）
    const backToProject = await movePhSessions({
      sessionIds: [fixture.sessionB1.id],
      target: { type: 'project', id: fixture.projectB.id },
    }, deps);
    assert.deepEqual(backToProject.movedSessionIds, [fixture.sessionB1.id]);
    record = await readRecord(fixture.sessionB1.id);
    assert.equal(record.projectId, fixture.projectB.id);
    assert.equal(normDir(record.openDirectory), normDir(fixture.projectB.workDirectory));
  });

  test('默认目录 → 项目（同目录）：目录会话收编为项目会话', async () => {
    const fixture = await setupMoveFixture();
    const { deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    const result = await movePhSessions({
      sessionIds: [fixture.sessionD.id],
      target: { type: 'project', id: fixture.projectA.id },
    }, deps);
    assert.deepEqual(result.movedSessionIds, [fixture.sessionD.id]);
    const record = await readRecord(fixture.sessionD.id);
    assert.equal(record.projectId, fixture.projectA.id);
    assert.equal(normDir(record.openDirectory), normDir(fixture.projectA.workDirectory));
  });
});

// ── 2. 批量与 no-op ──────────────────────────────────────────────────────

describe('归属转移：批量与 no-op', () => {
  test('批量混合来源（A 两条 + 目录一条）→ B：一次调用、一次 revision、全员落位', async () => {
    const fixture = await setupMoveFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    const beforeRevision = (await readSessionIndex(AGENT)).revision;
    const batch = [fixture.sessionA1.id, fixture.sessionA2.id, fixture.sessionD.id];

    const result = await movePhSessions({
      sessionIds: batch,
      target: { type: 'project', id: fixture.projectB.id },
    }, deps);

    assert.deepEqual(new Set(result.movedSessionIds), new Set(batch));
    assert.equal(result.revision, beforeRevision + 1, '批量只递增一次 revision（单次原子写）');
    for (const sessionId of batch) {
      assert.equal((await readRecord(sessionId)).projectId, fixture.projectB.id);
    }
    // 全员按会话精确释放
    assert.deepEqual(new Set(stops.map((s) => s.sessionId)), new Set(batch));
    for (const stop of stops) {
      assert.equal(stop.opts?.waitForPersistence, true);
    }
  });

  test('混合批次只报实际变化成员；全员 no-op 不停实例、不重写索引、不递增 revision', async () => {
    const fixture = await setupMoveFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });

    // 混合批次：no-op 成员（A1 已在 A）+ 真实移动成员（D 目录 → A）
    const mixed = await movePhSessions({
      sessionIds: [fixture.sessionA1.id, fixture.sessionD.id],
      target: { type: 'project', id: fixture.projectA.id },
    }, deps);
    assert.deepEqual(mixed.movedSessionIds, [fixture.sessionD.id], '只报归属实际变化的成员');
    assert.deepEqual(mixed.releasedSessionIds, [fixture.sessionD.id]);

    // 全员 no-op：不触碰 runtime、不重写索引
    const beforeIndex = await readSessionIndex(AGENT);
    const beforeRecord = await readRecord(fixture.sessionA1.id);
    const stopsBefore = stops.length;

    const noop = await movePhSessions({
      sessionIds: [fixture.sessionA1.id, fixture.sessionA2.id],
      target: { type: 'project', id: fixture.projectA.id },
    }, deps);
    assert.deepEqual(noop.movedSessionIds, []);
    assert.deepEqual(noop.releasedSessionIds, []);

    const afterIndex = await readSessionIndex(AGENT);
    assert.equal(afterIndex.revision, beforeIndex.revision, 'no-op 不递增 revision');
    assert.deepEqual(await readRecord(fixture.sessionA1.id), beforeRecord, 'no-op 不重写记录（历史不动）');
    assert.equal(stops.length, stopsBefore, 'no-op 不停任何实例');
  });

  test('重复请求幂等：已落位的转移重放 = no-op 成功', async () => {
    const fixture = await setupMoveFixture();
    const { deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    const first = await movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'project', id: fixture.projectB.id },
    }, deps);
    const second = await movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'project', id: fixture.projectB.id },
    }, deps);
    assert.deepEqual(second.movedSessionIds, []);
    assert.equal(second.revision, first.revision, '重放不再递增 revision');
  });
});

// ── 3. 拒绝与零副作用 ────────────────────────────────────────────────────

describe('归属转移：拒绝与零副作用', () => {
  async function assertZeroSideEffects(fixture, sessionId) {
    const record = await readRecord(sessionId);
    assert.ok(record, '索引记录保留');
    assert.equal(record.projectId, fixture.projectA.id, '归属不变');
    assert.equal(
      normDir(resolveSessionRuntimeDirectory(record, { sessionId })),
      normDir(fixture.dirX),
      '运行目录仍按项目表解析',
    );
  }

  test('busy（执行中轮次）：409 ph_sessions_busy，零停止、零索引变化、门闩释放', async () => {
    const fixture = await setupMoveFixture();
    fixture.runtimes.get(fixture.sessionA1.id).busy = { callActive: true, queued: [] };
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    const beforeRevision = (await readSessionIndex(AGENT)).revision;

    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionA1.id, fixture.sessionA2.id],
        target: { type: 'project', id: fixture.projectB.id },
      }, deps),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'ph_sessions_busy');
        assert.match(error.message, /call_active/);
        return true;
      },
    );
    assert.equal(stops.length, 0, 'busy 拒绝不停止任何实例');
    assert.equal((await readSessionIndex(AGENT)).revision, beforeRevision, '索引零变化');
    await assertZeroSideEffects(fixture, fixture.sessionA1.id);
    await assertZeroSideEffects(fixture, fixture.sessionA2.id);
    assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), false, '拒绝路径同样释放门闩');
  });

  test('排队输入 / 探测失败 / 启动中：同按 busy 拒绝', async () => {
    const fixture = await setupMoveFixture();

    fixture.runtimes.get(fixture.sessionA1.id).busy = { callActive: false, queued: [{ text: 'pending' }] };
    let harness = makeLifecycleDeps({ runtimes: fixture.runtimes, viewerImpl: viewerFromRuntimes(fixture.runtimes) });
    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'project', id: fixture.projectB.id } }, harness.deps),
      (error) => error.statusCode === 409 && error.code === 'ph_sessions_busy' && /queued_inputs/.test(error.message),
    );

    harness = makeLifecycleDeps({ runtimes: fixture.runtimes, viewerImpl: () => { throw new Error('viewer unreachable'); } });
    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'project', id: fixture.projectB.id } }, harness.deps),
      (error) => error.statusCode === 409 && /probe_failed/.test(error.message),
    );

    fixture.runtimes.get(fixture.sessionA1.id).viewerAgentId = '';
    harness = makeLifecycleDeps({ runtimes: fixture.runtimes, viewerImpl: viewerFromRuntimes(fixture.runtimes) });
    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'project', id: fixture.projectB.id } }, harness.deps),
      (error) => error.statusCode === 409 && /runtime_starting/.test(error.message),
    );
    assert.equal(harness.stops.length, 0);
  });

  test('跨有效目录：409 ph_session_cross_directory，批量整体拒绝', async () => {
    const fixture = await setupMoveFixture();
    const dirY2 = makeExternalDir('claw-ph-mv-dirY2-');
    const projectOther = await createPhProject({ name: 'O', workDirectory: dirY2 });
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });

    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionA1.id, fixture.sessionA2.id],
        target: { type: 'project', id: projectOther.id },
      }, deps),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'ph_session_cross_directory');
        return true;
      },
    );
    assert.equal(stops.length, 0, '预校验失败绝不部分改归属');
    await assertZeroSideEffects(fixture, fixture.sessionA1.id);
    await assertZeroSideEffects(fixture, fixture.sessionA2.id);

    // 目录目标同样受跨目录约束
    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'directory', openDirectory: fixture.dirY } }, deps),
      (error) => error.statusCode === 409 && error.code === 'ph_session_cross_directory',
    );
  });

  test('未知项目 / 归档项目 / 未知会话 / 无效参数：具体错误码显式失败', async () => {
    const fixture = await setupMoveFixture();
    const { deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });

    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'project', id: 'prj_000000000000' } }, deps),
      (error) => error.statusCode === 404 && error.code === 'ph_project_unknown',
    );
    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'project', id: 'not-a-project-id' } }, deps),
      (error) => error.statusCode === 400,
    );

    await setPhProjectArchived(fixture.projectB.id, true);
    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'project', id: fixture.projectB.id } }, deps),
      (error) => error.statusCode === 409 && error.code === 'ph_project_archived',
    );
    await setPhProjectArchived(fixture.projectB.id, false);

    await assert.rejects(
      movePhSessions({ sessionIds: ['session-does-not-exist'], target: { type: 'project', id: fixture.projectB.id } }, deps),
      (error) => error.statusCode === 404 && error.code === 'ph_session_unknown',
    );
    // 批量里混入一个未知会话：整体失败，另一个会话归属不动
    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionA1.id, 'session-does-not-exist'],
        target: { type: 'project', id: fixture.projectB.id },
      }, deps),
      (error) => error.statusCode === 404 && error.code === 'ph_session_unknown',
    );
    await assertZeroSideEffects(fixture, fixture.sessionA1.id);

    await assert.rejects(
      movePhSessions({ sessionIds: [], target: { type: 'project', id: fixture.projectB.id } }, deps),
      (error) => error.statusCode === 400 && error.code === 'ph_sessions_move_invalid_request',
    );
    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'galaxy', id: 'x' } }, deps),
      (error) => error.statusCode === 400 && error.code === 'ph_sessions_move_invalid_request',
    );
    await assert.rejects(
      movePhSessions({ sessionIds: [fixture.sessionA1.id], target: { type: 'directory', openDirectory: 'Z:/definitely/not/here' } }, deps),
      (error) => error.statusCode === 400,
    );
  });

  test('来源项目已从表移除的会话：显式失败，不猜测目录', async () => {
    const fixture = await setupMoveFixture();
    const orphan = await fixture.helpers.createPrebuiltSession(AGENT, { returnSummary: false, projectId: fixture.projectA.id });
    // 绕过 deletePhProject 的会话级联：直接从表里移除项目记录制造孤儿归属
    const storePath = getPhProjectStorePath();
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    const kept = store.projects.filter((p) => p.id !== fixture.projectA.id);
    writeFileSync(storePath, JSON.stringify({ ...store, projects: kept }, null, 2), 'utf8');

    const { deps } = makeLifecycleDeps({ runtimes: new Map() });
    await assert.rejects(
      movePhSessions({ sessionIds: [orphan.id], target: { type: 'directory', openDirectory: fixture.dirX } }, deps),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'ph_session_source_project_unknown');
        return true;
      },
    );
    // 还原表，避免影响其他用例
    writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  });
});

// ── 4. 失败保留与共享进程兄弟 ────────────────────────────────────────────

describe('归属转移：失败保留与共享进程兄弟', () => {
  test('持久化确认失败：抛错，归属保持原样（下次启动仍按旧归属装配）', async () => {
    const fixture = await setupMoveFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
      stopImpl: async () => { throw new Error('persist confirmation failed'); },
    });
    const beforeRevision = (await readSessionIndex(AGENT)).revision;

    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionA1.id, fixture.sessionA2.id],
        target: { type: 'project', id: fixture.projectB.id },
      }, deps),
      /persist confirmation failed/,
    );
    assert.equal(stops.length, 1, '停止尝试发生过（不假成功，也不吞错）');
    assert.equal((await readSessionIndex(AGENT)).revision, beforeRevision, '索引零变化');
    for (const sessionId of [fixture.sessionA1.id, fixture.sessionA2.id]) {
      const record = await readRecord(sessionId);
      assert.equal(record.projectId, fixture.projectA.id, '失败后归属完整保留');
    }
    assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), false);
  });

  test('共享进程兄弟会话不被波及：只精确释放被转移成员', async () => {
    const fixture = await setupMoveFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    await movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'project', id: fixture.projectB.id },
    }, deps);

    const stoppedIds = new Set(stops.map((s) => s.sessionId));
    assert.deepEqual([...stoppedIds], [fixture.sessionA1.id]);
    // 兄弟（A2 同项目、B1 目标项目、D 目录）从未被停止
    for (const sibling of [fixture.sessionA2.id, fixture.sessionB1.id, fixture.sessionD.id]) {
      assert.ok(!stoppedIds.has(sibling));
    }
    for (const stop of stops) {
      assert.equal(stop.agentId, AGENT, '绝不经 agent 全量停止语义');
    }
  });
});

// ── 5. 并发 gate（释放窗口）──────────────────────────────────────────────

describe('归属转移：释放窗口并发 gate', () => {
  test('窗口内：重叠移动 409 / 新输入 409 / 派生 409 / 涉及项目改绑·归档·删除 409；无关项目不受波及；结束后恢复', async () => {
    const fixture = await setupMoveFixture();
    let releaseStop;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const { deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
      stopImpl: () => stopGate,
    });

    // 注册假 runtime 到真实注册表，让网关按 viewerAgentId 反查到移动中会话
    const aEntry = fixture.runtimes.get(fixture.sessionA1.id);
    const registryKey = `${AGENT}::${fixture.sessionA1.id}`;
    managedAgents.set(registryKey, {
      key: registryKey, agentId: AGENT, id: AGENT,
      selectedSessionId: fixture.sessionA1.id, viewerAgentId: aEntry.viewerAgentId,
    });

    const firstMove = movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'project', id: fixture.projectB.id },
    }, deps);
    // 等待门闩建立（停止被 stopGate 挂住，轮询到 gated 即进入释放窗口）
    const pollStart = Date.now();
    while (!isPhSessionRebindGated(fixture.sessionA1.id) && Date.now() - pollStart < 500) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    try {
      assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), true, '释放窗口已建立');
      assert.equal(getPhSessionGateInfo(fixture.sessionA1.id)?.code, 'ph_sessions_move_in_progress');
      assert.equal(isPhSessionRebindGated(fixture.sessionA2.id), false, '同项目未转移成员不被会话级门闩波及');

      // 并发重叠移动：409
      await assert.rejects(
        movePhSessions({
          sessionIds: [fixture.sessionA1.id],
          target: { type: 'directory', openDirectory: fixture.dirX },
        }, makeLifecycleDeps({ runtimes: fixture.runtimes, viewerImpl: viewerFromRuntimes(fixture.runtimes) }).deps),
        (error) => error.statusCode === 409 && error.code === 'ph_sessions_move_in_progress',
      );

      // 新输入在释放窗口内被统一网关 409 拒绝（携带移动语义的 code）
      await assert.rejects(
        deliverUserInput(
          { viewerAgentId: aEntry.viewerAgentId, text: 'hello during move' },
          { integration: { core: { findThreadByHeadSession: async () => null }, findThreadBySession: async () => null, archive: {} }, fetchImpl: async () => { throw new Error('should not reach viewer'); } },
        ),
        (error) => {
          assert.ok(error instanceof UserTurnDeliveryError);
          assert.equal(error.code, 'ph_sessions_move_in_progress');
          assert.equal(error.status, 409);
          return true;
        },
      );

      // 派生会话（sourceSessionId）在窗口内被拒绝
      await assert.rejects(
        fixture.helpers.createPrebuiltSession(AGENT, { returnSummary: false, sourceSessionId: fixture.sessionA1.id }),
        (error) => error.statusCode === 409 && error.code === 'ph_sessions_move_in_progress',
      );

      // 涉及项目（来源 A / 目标 B）在窗口内拒绝改绑 / 归档 / 删除
      for (const project of [fixture.projectA, fixture.projectB]) {
        await assert.rejects(
          rebindPhProject(project.id, { workDirectory: fixture.dirY }, makeLifecycleDeps({ runtimes: new Map() }).deps),
          (error) => error.statusCode === 409 && error.code === 'ph_sessions_move_in_progress',
        );
        await assert.rejects(
          setPhProjectArchived(project.id, true),
          (error) => error.statusCode === 409 && error.code === 'ph_sessions_move_in_progress',
        );
        await assert.rejects(
          deletePhProject(project.id, {}, {
            ...makeLifecycleDeps({ runtimes: new Map() }).deps,
            deletePrebuiltSession: async () => { throw new Error('should not reach deletion'); },
          }),
          (error) => error.statusCode === 409 && error.code === 'ph_sessions_move_in_progress',
        );
      }

      // 无关项目不受波及（预览 / 归档正常）
      const unrelated = await createPhProject({ name: 'U', workDirectory: fixture.dirY });
      assert.equal((await previewPhProjectDeletion(unrelated.id, {})).project.id, unrelated.id);
      await setPhProjectArchived(unrelated.id, true);
      await setPhProjectArchived(unrelated.id, false);
    } finally {
      releaseStop();
      await firstMove;
      managedAgents.delete(registryKey);
    }

    assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), false, '窗口结束门闩释放');
    assert.equal((await readRecord(fixture.sessionA1.id)).projectId, fixture.projectB.id, '窗口结束后归属已落位');
    // 窗口结束后恢复：再次移动可正常进行
    const back = await movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'project', id: fixture.projectA.id },
    }, makeLifecycleDeps({ runtimes: new Map() }).deps);
    assert.deepEqual(back.movedSessionIds, [fixture.sessionA1.id]);
  });

  test('改绑窗口先行时：移动涉及该项目被 409 拒绝（双向互斥）', async () => {
    const fixture = await setupMoveFixture();
    let releaseStop;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const rebindDeps = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
      stopImpl: () => stopGate,
    });
    // 改绑 A：先探 busy（全员空闲）再停 A 成员；停止被挂住 → 窗口建立
    const rebindTask = rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirY }, rebindDeps.deps);
    const pollStart = Date.now();
    while (!isPhSessionRebindGated(fixture.sessionA1.id) && Date.now() - pollStart < 500) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    try {
      await assert.rejects(
        movePhSessions({
          sessionIds: [fixture.sessionB1.id],
          target: { type: 'project', id: fixture.projectA.id },
        }, makeLifecycleDeps({ runtimes: new Map() }).deps),
        (error) => error.statusCode === 409 && error.code === 'ph_project_rebind_in_progress',
      );
    } finally {
      releaseStop();
      await rebindTask;
    }
  });
});

// ── 5b. 反向竞态（生命周期事务先行）────────────────────────────────────

describe('归属转移：反向竞态（生命周期事务先行）', () => {
  test('删除先开始（窗口持有中）：move 涉及该项目 / 成员会话 409；删除完成后 move 显式 404', async () => {
    const fixture = await setupMoveFixture();
    let releaseStop;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const { deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
      stopImpl: () => stopGate,
    });
    const deleteTask = deletePhProject(fixture.projectA.id, {}, {
      ...deps,
      deletePrebuiltSession: async () => {},
    });
    const pollStart = Date.now();
    while (!isPhSessionRebindGated(fixture.sessionA1.id) && Date.now() - pollStart < 500) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    try {
      assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), true, '删除窗口已建立');
      assert.equal(getPhSessionGateInfo(fixture.sessionA1.id)?.code, 'ph_project_delete_in_progress');
      await assert.rejects(
        movePhSessions({
          sessionIds: [fixture.sessionD.id],
          target: { type: 'project', id: fixture.projectA.id },
        }, makeLifecycleDeps({ runtimes: new Map() }).deps),
        (error) => error.statusCode === 409 && error.code === 'ph_project_delete_in_progress',
      );
      await assert.rejects(
        movePhSessions({
          sessionIds: [fixture.sessionA1.id],
          target: { type: 'project', id: fixture.projectB.id },
        }, makeLifecycleDeps({ runtimes: new Map() }).deps),
        (error) => error.statusCode === 409 && error.code === 'ph_project_delete_in_progress',
      );
    } finally {
      releaseStop();
      await deleteTask;
    }
    assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), false, '删除窗口释放');
    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionD.id],
        target: { type: 'project', id: fixture.projectA.id },
      }, makeLifecycleDeps({ runtimes: new Map() }).deps),
      (error) => error.statusCode === 404 && error.code === 'ph_project_unknown',
    );
  });

  test('归档先开始（窗口持有中）：move 被拒 409；归档落盘后按归档拒绝，恢复后成功', async () => {
    const fixture = await setupMoveFixture();
    let releaseLock;
    const lockGate = new Promise((resolve) => { releaseLock = resolve; });
    const idleDeps = makeLifecycleDeps({ runtimes: new Map() }).deps;
    const archiveTask = setPhProjectArchived(fixture.projectB.id, true, {
      withStoreWriteLock: async (fn) => {
        await lockGate;
        return fn(); // 单测试内无并发写表，直接执行等价
      },
    });
    try {
      assert.equal(isPhProjectRebindActive(fixture.projectB.id), true, '归档窗口已建立');
      await assert.rejects(
        movePhSessions({
          sessionIds: [fixture.sessionA1.id],
          target: { type: 'project', id: fixture.projectB.id },
        }, idleDeps),
        (error) => error.statusCode === 409 && error.code === 'ph_project_archive_in_progress',
      );
    } finally {
      releaseLock();
      await archiveTask;
    }
    assert.equal(isPhProjectRebindActive(fixture.projectB.id), false, '归档窗口释放');
    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionA1.id],
        target: { type: 'project', id: fixture.projectB.id },
      }, idleDeps),
      (error) => error.statusCode === 409 && error.code === 'ph_project_archived',
    );
    await setPhProjectArchived(fixture.projectB.id, false);
    const result = await movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'project', id: fixture.projectB.id },
    }, idleDeps);
    assert.deepEqual(result.movedSessionIds, [fixture.sessionA1.id]);
  });

  test('预校验与门闩之间改绑完成：陈旧目标目录计划被锁内 fresh 重验拒绝，索引零变化', async () => {
    const fixture = await setupMoveFixture();
    const beforeIndex = await readSessionIndex(AGENT);
    const baseDeps = makeLifecycleDeps({ runtimes: new Map() }).deps;
    let rebindDone = false;
    const moveDeps = {
      ...baseDeps,
      readSessionIndex: async (agentId) => {
        const index = await readSessionIndex(agentId);
        if (!rebindDone) {
          rebindDone = true;
          // move 预校验的索引读取挂起期间，目标项目 B 改绑到 dirY 并完整
          // 落盘（改绑窗口关闭）——move 手里的 targetDirectory 停留在 dirX
          await rebindPhProject(fixture.projectB.id, { workDirectory: fixture.dirY }, baseDeps);
        }
        return index;
      },
    };
    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionA1.id],
        target: { type: 'project', id: fixture.projectB.id },
      }, moveDeps),
      (error) => error.statusCode === 409 && error.code === 'ph_sessions_move_conflict',
    );
    const afterIndex = await readSessionIndex(AGENT);
    assert.equal(afterIndex.revision, beforeIndex.revision, '索引未被重写');
    assert.equal((await readRecord(fixture.sessionA1.id)).projectId, fixture.projectA.id, '归属保持原样');
    assert.equal(normDir((await getPhProject(fixture.projectB.id)).workDirectory), normDir(fixture.dirY), '改绑已真实落盘');
    assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), false, '无窗口残留');
    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionA1.id],
        target: { type: 'project', id: fixture.projectB.id },
      }, baseDeps),
      (error) => error.statusCode === 409 && error.code === 'ph_session_cross_directory',
    );
  });

  test('目标项目目录缺失（盘上不存在）：project 分支显式拒绝，与 directory 分支同契约', async () => {
    const fixture = await setupMoveFixture();
    const dirZ = makeExternalDir('claw-ph-mv-dirZ-');
    const projectC = await createPhProject({ name: 'C', workDirectory: dirZ });
    rmSync(dirZ, { recursive: true, force: true });
    const idleDeps = makeLifecycleDeps({ runtimes: new Map() }).deps;
    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionD.id],
        target: { type: 'project', id: projectC.id },
      }, idleDeps),
      (error) => error.statusCode === 409 && error.code === 'ph_project_directory_missing',
    );
    await assert.rejects(
      movePhSessions({
        sessionIds: [fixture.sessionD.id],
        target: { type: 'directory', openDirectory: dirZ },
      }, idleDeps),
      (error) => error.statusCode === 400,
    );
  });
});

// ── 6. 真实重新解析配置 ──────────────────────────────────────────────────

describe('归属转移：真实重新解析（项目表 + 配置层）', () => {
  test('A → B 后：运行目录与项目配置层都按目标项目真实重解析', async () => {
    const fixture = await setupMoveFixture();
    const { deps } = makeLifecycleDeps({ runtimes: new Map() });

    // 项目配置层（真实文件，真实路径编码 projectLayerPath）：A 与 B 各写一份可区分内容
    const layerAPath = projectLayerPath(fixture.projectA.id);
    const layerBPath = projectLayerPath(fixture.projectB.id);
    mkdirSync(join(layerAPath, '..'), { recursive: true });
    mkdirSync(join(layerBPath, '..'), { recursive: true });
    const layerA = { 'mv-test-feature': { enabled: false, note: 'layer-A' } };
    const layerB = { 'mv-test-feature': { enabled: true, note: 'layer-B' } };
    writeFileSync(layerAPath, JSON.stringify(layerA), 'utf8');
    writeFileSync(layerBPath, JSON.stringify(layerB), 'utf8');

    // 转移前：A 会话解析 A 层
    let record = await readRecord(fixture.sessionA1.id);
    assert.equal(record.projectId, fixture.projectA.id);
    let layers = buildScopeLayers({ agentId: AGENT, projectId: record.projectId }).layers;
    assert.deepEqual(layers.find((l) => l.id === `project:${fixture.projectA.id}`)?.sparse, layerA);

    await movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'project', id: fixture.projectB.id },
    }, deps);

    // 转移后：记录归属 → B；运行目录按项目表真实读表解析到 B.workDirectory
    record = await readRecord(fixture.sessionA1.id);
    assert.equal(record.projectId, fixture.projectB.id);
    assert.equal(
      normDir(resolveSessionRuntimeDirectory(record, { sessionId: record.id })),
      normDir((await getPhProject(fixture.projectB.id)).workDirectory),
    );
    // 配置层按新 projectId 真实解析到 B 层内容（下次启动重装配的配置来源）
    layers = buildScopeLayers({ agentId: AGENT, projectId: record.projectId }).layers;
    assert.deepEqual(layers.find((l) => l.id === `project:${fixture.projectB.id}`)?.sparse, layerB);
    assert.ok(!layers.some((l) => l.id === `project:${fixture.projectA.id}`));
  });
});

// ── 7. open-sessions 恢复卡片：归属身份双向刷新 ───────────────────────────

describe('归属转移：open-sessions 恢复卡片身份刷新', () => {
  test('项目 → 默认目录后：卡片条目清除旧 projectId（双向刷新）', async () => {
    const fixture = await setupMoveFixture();
    // 先经真实登记入口写入 tracker 文件（会话索引当时仍是项目归属）
    await addOpenSession(AGENT, fixture.sessionA1.id);
    // 首次读取把文件装载进内存缓存，条目应携带项目身份
    let entries = await getRecoverySessions(AGENT);
    let entry = entries.find((e) => e.sessionId === fixture.sessionA1.id);
    assert.ok(entry, 'tracker 条目存在');
    assert.equal(entry.projectId, fixture.projectA.id, '转移前卡片呈现项目身份');

    // 转移到默认目录
    await movePhSessions({
      sessionIds: [fixture.sessionA1.id],
      target: { type: 'directory', openDirectory: fixture.dirX },
    }, makeLifecycleDeps({ runtimes: new Map() }).deps);

    entries = await getRecoverySessions(AGENT);
    entry = entries.find((e) => e.sessionId === fixture.sessionA1.id);
    assert.ok(entry, '条目仍存在（会话未删）');
    assert.ok(!('projectId' in entry), '旧 projectId 被清除（双向刷新，不残留项目徽标）');
  });
});

// ── 8. 路由装配 ──────────────────────────────────────────────────────────

describe('归属转移：路由装配', () => {
  test('POST /protoclaw/ph_project/sessions_move 挂载且 deps 透传；错误经 next(error)', async () => {
    function makeApp() {
      const handlers = {};
      const app = {
        get: (p, ...rest) => { handlers[`GET ${p}`] = rest[rest.length - 1]; },
        post: (p, ...rest) => { handlers[`POST ${p}`] = rest[rest.length - 1]; },
      };
      return { handlers, app };
    }
    const jsonMiddleware = { json: () => (_req, _res, next) => next?.() };

    const guardHarness = makeApp();
    setupPhProjectRoutes(guardHarness.app, jsonMiddleware, makeLifecycleDeps({ runtimes: new Map() }).deps);
    const guardRoute = guardHarness.handlers['POST /protoclaw/ph_project/sessions_move'];
    assert.ok(guardRoute, 'sessions_move 已挂载');
    assert.ok(guardHarness.handlers['POST /protoclaw/ph_project/project_rebind'], '既有路由不受影响');

    // agentId 守卫：不支持的 agentId 400
    const res1 = { error: null, status(code) { this.statusCode = code; return this; }, json(p) { this.jsonPayload = p; } };
    await guardRoute(
      { body: { agentId: 'someone-else', sessionIds: ['s'], target: { type: 'directory', openDirectory: 'x' } } },
      res1,
      (e) => { res1.error = e; },
    );
    assert.ok(res1.error);
    assert.equal(res1.error.statusCode, 400);

    // 成功路径：响应契约字段齐备（deps 沿装配注入，无 runtime = 无需释放）
    const fixture = await setupMoveFixture();
    const okHarness = makeApp();
    setupPhProjectRoutes(okHarness.app, jsonMiddleware, makeLifecycleDeps({ runtimes: new Map() }).deps);
    const res2 = { error: null, status(code) { this.statusCode = code; return this; }, json(p) { this.jsonPayload = p; } };
    await okHarness.handlers['POST /protoclaw/ph_project/sessions_move'](
      {
        body: {
          agentId: AGENT,
          sessionIds: [fixture.sessionA1.id],
          target: { type: 'project', id: fixture.projectB.id },
        },
      },
      res2,
      (e) => { res2.error = e; },
    );
    assert.ok(!res2.error, res2.error?.message);
    assert.equal(res2.jsonPayload.ok, true);
    assert.deepEqual(res2.jsonPayload.movedSessionIds, [fixture.sessionA1.id]);
    assert.deepEqual(res2.jsonPayload.releasedSessionIds, []);
    assert.equal(typeof res2.jsonPayload.revision, 'number');
    assert.equal(res2.jsonPayload.target.id, fixture.projectB.id);
    assert.ok(existsSync(getPrebuiltSessionFilePath(AGENT, fixture.sessionA1.id)), '移动不删除会话文件');
  });
});
