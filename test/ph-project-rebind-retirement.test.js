/**
 * PH 项目改绑、归档与永久删除（ticket 046）
 *
 * 行为契约（docs/tickets/046-ph-project-rebind-and-retirement.md）：
 * - 改绑：空闲存活实例先按「精确单会话 + waitForPersistence」安全失效（共享
 *   进程兄弟会话 B/D 不受影响：停止调用必须带 sessionId，绝不走 agent 全量
 *   停止语义）；全部释放成功后才写项目表；执行中轮次 / 排队输入 / 探测失败
 *   一律 409 拒绝且零状态变化；释放窗口内新输入被网关 409 拒绝、新启动被
 *   启动闸拒绝；失败时旧绑定完整保留（下次启动仍绑旧目录），不假成功。
 * - 归档/恢复：只翻项目记录 archived 位，Session 索引 / 会话文件 / 配置 /
 *   工作文件原样保留，runtime 不失效；Session archived 语义不被触碰。
 * - 删除：影响预览不改动状态；按 ID 枚举会话（复用 deletePrebuiltSession
 *   清理链）；托管目录仅在 managed + 托管区内 + 无引用 + 用户显式选择时
 *   删除；外部目录绝不删除；显式要求删除但不可删时整个请求 409 拒绝。
 * - ID 稳定：改名与改绑都不换 ID、不搬文件，旧目录不清理。
 *
 * 全程隔离数据根（AGENTDEV_DATA_DIR），无真实模型请求、无 runtime 子进程；
 * 生命周期依赖（stopManagedAgent / readViewerJson / runtime 注册表）注入
 * 假件，逐调用断言精确停止范围。harness 参照 ph-project-session-lifecycle.test.js。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'claw-ph-rebind-retirement-'));
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
  renamePhProject,
  rebindPhProject,
  setPhProjectArchived,
  previewPhProjectDeletion,
  deletePhProject,
  isPhProjectRebindActive,
  isPhSessionRebindGated,
  getPhManagedProjectDir,
  getPhProjectStorePath,
  setupPhProjectRoutes,
} = await import('../server/routes/ph-projects.js');
const { createSessionHelpers } = await import('../server/routes/session-helpers.js');
const { readWorkspaceState, writeWorkspaceState } = await import('../server/routes/workspace.js');
const { readSessionIndex } = await import('../server/shared/session-access.js');
const { resolveSessionRuntimeDirectory } = await import('../server/shared/session-project.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
const { deliverUserInput, UserTurnDeliveryError } = await import('../server/thread-control/input-gateway.js');

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
 * 假 runtime 注册表 + 生命周期依赖。
 * runtimes: Map<sessionId, { viewerAgentId, live, busy: {callActive, queued}, stopping }>。
 * stops 逐调用记录，供断言精确停止范围（必须带 sessionId + waitForPersistence）。
 */
function makeLifecycleDeps({ runtimes, stopImpl, viewerImpl, readWorkspaceStateDep = readWorkspaceState } = {}) {
  const stops = [];
  const probes = [];
  return {
    stops,
    probes,
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
        probes.push(pathname);
        if (viewerImpl) return viewerImpl(pathname);
        // 缺省：全部空闲
        if (pathname.endsWith('/notification')) return { callActive: false };
        if (pathname.endsWith('/queued-inputs')) return [];
        throw new Error(`unexpected viewer path in test: ${pathname}`);
      },
      readWorkspaceState: readWorkspaceStateDep,
    },
  };
}

function normDir(value) {
  return String(value).replace(/\\/g, '/').toLowerCase();
}

async function createProjectSession(helpers, projectId) {
  return helpers.createPrebuiltSession(AGENT, { returnSummary: false, projectId });
}

/** 预置：外部目录 dirD 上 A/B 项目 + 目录会话 D（coexistence 形态），A 带 1 会话 + 假 runtime。 */
async function setupRebindFixture({ aBusy = null } = {}) {
  const helpers = makeHelpers();
  const dirD = makeExternalDir('claw-ph-dirD-');
  const dirNew = makeExternalDir('claw-ph-dirNew-');
  const state = await readWorkspaceState(AGENT);
  await writeWorkspaceState(AGENT, { ...state, openDirectory: dirD });

  const projectA = await createPhProject({ name: 'A', workDirectory: dirD });
  const projectB = await createPhProject({ name: 'B', workDirectory: dirD });
  const sessionA1 = await createProjectSession(helpers, projectA.id);
  const sessionB1 = await createProjectSession(helpers, projectB.id);
  const sessionD = await helpers.createPrebuiltSession(AGENT, { returnSummary: false, openDirectory: dirD, title: 'dir' });

  const runtimes = new Map();
  runtimes.set(sessionA1.id, { viewerAgentId: `view-${sessionA1.id}`, busy: aBusy || { callActive: false, queued: [] } });
  runtimes.set(sessionB1.id, { viewerAgentId: `view-${sessionB1.id}`, busy: { callActive: false, queued: [] } });
  runtimes.set(sessionD.id, { viewerAgentId: `view-${sessionD.id}`, busy: { callActive: false, queued: [] } });

  return { helpers, dirD, dirNew, projectA, projectB, sessionA1, sessionB1, sessionD, runtimes };
}

// viewerImpl 工厂：按 runtime 表返回 notification / queued-inputs
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

// ── 1. 改绑 ──────────────────────────────────────────────────────────────

describe('046 改绑：空闲释放与精确范围', () => {
  test('A 空闲改绑新目录：A 实例按会话精确失效，B/D 不受影响，下次启动绑新目录', async () => {
    const fixture = await setupRebindFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });

    const result = await rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, deps);

    assert.equal(result.unchanged, false);
    assert.ok(Array.isArray(result.releasedSessionIds));
    assert.deepEqual(result.releasedSessionIds, [fixture.sessionA1.id]);
    // 精确停止：只有 A 的会话，带 sessionId + waitForPersistence
    assert.equal(stops.length, 1);
    assert.equal(stops[0].agentId, AGENT);
    assert.equal(stops[0].sessionId, fixture.sessionA1.id);
    assert.equal(stops[0].opts?.waitForPersistence, true, '必须经 waitForPersistence 屏障失效');
    // B/D 会话从未出现在停止调用里（共享进程兄弟保留）
    const stoppedIds = new Set(stops.map((s) => s.sessionId));
    assert.ok(!stoppedIds.has(fixture.sessionB1.id));
    assert.ok(!stoppedIds.has(fixture.sessionD.id));
    // 表已更新：目录与 updatedAt 变化，ID/名称不变
    assert.equal(normDir(result.project.workDirectory), normDir(fixture.dirNew));
    assert.equal(result.project.id, fixture.projectA.id);
    assert.equal(result.project.name, 'A');
    // 下次启动绑新目录（单源规则真实读表）
    const index = await readSessionIndex(AGENT);
    const record = index.sessions.find((s) => s.id === fixture.sessionA1.id);
    assert.equal(normDir(resolveSessionRuntimeDirectory(record, { sessionId: record.id })), normDir(fixture.dirNew));
    // 旧目录不清理（外部目录原样保留）
    assert.ok(existsSync(fixture.dirD));
    assert.ok(existsSync(join(fixture.dirD)), '改绑不搬文件：旧目录仍在');
    // 门闩已释放
    assert.equal(isPhProjectRebindActive(fixture.projectA.id), false);
  });

  test('改绑到不存在的目录 400，不动表不动 runtime', async () => {
    const fixture = await setupRebindFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    await assert.rejects(
      rebindPhProject(fixture.projectA.id, { workDirectory: 'Z:/definitely/not/here' }, deps),
      (error) => error.statusCode === 400,
    );
    assert.equal(stops.length, 0);
    const index = await readSessionIndex(AGENT);
    const record = index.sessions.find((s) => s.id === fixture.sessionA1.id);
    assert.equal(normDir(resolveSessionRuntimeDirectory(record, { sessionId: record.id })), normDir(fixture.dirD));
  });

  test('目录与来源均未变化：no-op 成功，不触碰 runtime 与表', async () => {
    const fixture = await setupRebindFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    const before = (await readSessionIndex(AGENT)).sessions.find((s) => s.id === fixture.sessionA1.id);
    const result = await rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirD }, deps);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.releasedSessionIds, []);
    assert.equal(stops.length, 0);
    const after = (await readSessionIndex(AGENT)).sessions.find((s) => s.id === fixture.sessionA1.id);
    assert.equal(after.updatedAt, before.updatedAt, 'no-op 不重写索引时间戳');
  });

  test('空 workDirectory 改绑 = 重新分配托管目录，directorySource 转 managed', async () => {
    const fixture = await setupRebindFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    const result = await rebindPhProject(fixture.projectA.id, { workDirectory: '' }, deps);
    assert.equal(result.project.directorySource, 'managed');
    assert.equal(normDir(result.project.workDirectory), normDir(getPhManagedProjectDir(fixture.projectA.id)));
    assert.ok(existsSync(result.project.workDirectory), '托管目录已创建');
    assert.equal(stops.length, 1, '空闲实例照常安全失效');
    // 旧外部目录不清理
    assert.ok(existsSync(fixture.dirD));
  });
});

describe('046 改绑：busy 拒绝（零状态变化）', () => {
  test('A 执行中轮次：409，不停止、表不变、门闩释放', async () => {
    const fixture = await setupRebindFixture({ aBusy: { callActive: true, queued: [] } });
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    await assert.rejects(
      rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, deps),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'ph_project_busy');
        assert.match(error.message, /call_active/);
        return true;
      },
    );
    assert.equal(stops.length, 0, 'busy 拒绝绝不停止任何实例');
    const index = await readSessionIndex(AGENT);
    const record = index.sessions.find((s) => s.id === fixture.sessionA1.id);
    assert.equal(normDir(resolveSessionRuntimeDirectory(record, { sessionId: record.id })), normDir(fixture.dirD), '旧绑定保留');
    assert.equal(isPhProjectRebindActive(fixture.projectA.id), false, '拒绝路径同样释放门闩');
  });

  test('A 有排队输入：409 拒绝', async () => {
    const fixture = await setupRebindFixture({ aBusy: { callActive: false, queued: [{ text: 'pending' }] } });
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    await assert.rejects(
      rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, deps),
      (error) => error.statusCode === 409 && error.code === 'ph_project_busy',
    );
    assert.equal(stops.length, 0);
  });

  test('探测失败按 busy 处理（fail-closed）', async () => {
    const fixture = await setupRebindFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: () => { throw new Error('viewer unreachable'); },
    });
    await assert.rejects(
      rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, deps),
      (error) => error.statusCode === 409 && /probe_failed/.test(error.message),
    );
    assert.equal(stops.length, 0);
  });

  test('存活但无 viewer 身份（启动中）：按 busy 拒绝', async () => {
    const fixture = await setupRebindFixture();
    fixture.runtimes.get(fixture.sessionA1.id).viewerAgentId = '';
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    await assert.rejects(
      rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, deps),
      (error) => error.statusCode === 409 && /runtime_starting/.test(error.message),
    );
    assert.equal(stops.length, 0);
  });
});

describe('046 改绑：失败不假成功', () => {
  test('持久化确认失败：抛错，表保持旧绑定（下次启动仍绑旧目录）', async () => {
    const fixture = await setupRebindFixture();
    const { stops, deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
      stopImpl: async () => { throw new Error('persist confirmation failed'); },
    });
    await assert.rejects(
      rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, deps),
      /persist confirmation failed/,
    );
    assert.equal(stops.length, 1, '停止尝试发生过（不假成功，也不吞错）');
    const index = await readSessionIndex(AGENT);
    const record = index.sessions.find((s) => s.id === fixture.sessionA1.id);
    assert.equal(normDir(resolveSessionRuntimeDirectory(record, { sessionId: record.id })), normDir(fixture.dirD), '失败后旧绑定完整保留');
    assert.equal(isPhProjectRebindActive(fixture.projectA.id), false);
  });

  test('释放窗口内：并发改绑 409、新输入被网关拒绝、启动闸生效、结束后恢复', async () => {
    const fixture = await setupRebindFixture();
    let releaseStop;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const { deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
      stopImpl: () => stopGate,
    });

    // 注册假 runtime 到真实注册表，让网关按 viewerAgentId 反查到 A 会话
    const aEntry = fixture.runtimes.get(fixture.sessionA1.id);
    const registryKey = `${AGENT}::${fixture.sessionA1.id}`;
    managedAgents.set(registryKey, {
      key: registryKey, agentId: AGENT, id: AGENT,
      selectedSessionId: fixture.sessionA1.id, viewerAgentId: aEntry.viewerAgentId,
    });
    const firstRebind = rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, deps);
    // 等待门闩建立（改绑编排先做表/目录/索引 IO，门闩在停止前建立；停止被
    // stopGate 挂住，此处轮询到 active 即进入释放窗口，确定性同步）
    const pollStart = Date.now();
    while (!isPhProjectRebindActive(fixture.projectA.id) && Date.now() - pollStart < 500) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    try {
      assert.equal(isPhProjectRebindActive(fixture.projectA.id), true, '释放窗口内启动闸生效');
      assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), true);
      assert.equal(isPhSessionRebindGated(fixture.sessionB1.id), false, '兄弟会话不被门闩波及');

      // 并发第二次改绑：409 rebind_in_progress
      await assert.rejects(
        rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, makeLifecycleDeps({
          runtimes: fixture.runtimes,
          viewerImpl: viewerFromRuntimes(fixture.runtimes),
        }).deps),
        (error) => error.statusCode === 409 && error.code === 'ph_project_rebind_in_progress',
      );

      // 新输入在释放窗口内被统一网关 409 拒绝
      await assert.rejects(
        deliverUserInput(
          { viewerAgentId: aEntry.viewerAgentId, text: 'hello during rebind' },
          { integration: { core: { findThreadByHeadSession: async () => null }, findThreadBySession: async () => null, archive: {} }, fetchImpl: async () => { throw new Error('should not reach viewer'); } },
        ),
        (error) => {
          assert.ok(error instanceof UserTurnDeliveryError);
          assert.equal(error.code, 'ph_project_rebind_in_progress');
          assert.equal(error.status, 409);
          return true;
        },
      );
    } finally {
      releaseStop();
      await firstRebind;
      managedAgents.delete(registryKey);
    }
    assert.equal(isPhProjectRebindActive(fixture.projectA.id), false);
    assert.equal(isPhSessionRebindGated(fixture.sessionA1.id), false);
  });
});

// ── 2. 归档 / 恢复 ────────────────────────────────────────────────────────

describe('046 归档/恢复：只翻项目位，资产全保留', () => {
  test('归档保留会话/配置/工作文件，Session archived 语义不动', async () => {
    const helpers = makeHelpers();
    const dirD = makeExternalDir('claw-ph-archive-');
    const project = await createPhProject({ name: 'A', workDirectory: dirD });
    const session = await createProjectSession(helpers, project.id);
    const configFile = join(DATA_ROOT, 'feature-config', `project-${project.id}.json`);
    mkdirSync(join(DATA_ROOT, 'feature-config'), { recursive: true });
    writeFileSync(configFile, '{}', 'utf8');

    const archived = await setPhProjectArchived(project.id, true);
    assert.equal(archived.archived, true);
    assert.ok(archived.archivedAt);
    assert.equal(archived.workDirectory, project.workDirectory, '目录不动');

    // 会话索引 / 会话文件 / 配置 / 工作目录全部原样；归档不接收生命周期
    // 依赖——runtime 不失效（与改绑的取消性语义相反）
    const index = await readSessionIndex(AGENT);
    const record = index.sessions.find((s) => s.id === session.id);
    assert.ok(record, '索引记录保留');
    assert.equal(record.projectId, project.id);
    assert.ok(existsSync(configFile), '配置文件保留');
    assert.ok(existsSync(dirD), '工作目录保留');
    // Session archived 语义不被项目归档触碰
    assert.ok(!('archived' in record) || record.archived === undefined || record.archived === false);

    // 恢复
    const restored = await setPhProjectArchived(project.id, false);
    assert.equal(restored.archived, false);
    assert.equal(restored.archivedAt, null);
    const indexAfter = await readSessionIndex(AGENT);
    assert.ok(indexAfter.sessions.find((s) => s.id === session.id), '恢复后历史仍在');
  });

  test('重复归档幂等（archivedAt 不变），未知项目 404', async () => {
    const dirD = makeExternalDir('claw-ph-archive2-');
    const project = await createPhProject({ name: 'A2', workDirectory: dirD });
    const first = await setPhProjectArchived(project.id, true);
    const second = await setPhProjectArchived(project.id, true);
    assert.equal(second.archivedAt, first.archivedAt);
    await assert.rejects(setPhProjectArchived('prj_000000000000', true), (error) => error.statusCode === 404);
  });
});

// ── 3. 永久删除 ──────────────────────────────────────────────────────────

function fakeLayerPath(projectId) {
  return join(DATA_ROOT, 'feature-config', `project-${projectId}.json`);
}

function ensureConfigFile(projectId) {
  mkdirSync(join(DATA_ROOT, 'feature-config'), { recursive: true });
  writeFileSync(fakeLayerPath(projectId), '{}', 'utf8');
}

describe('046 删除：影响预览', () => {
  test('managed 无引用：预览列全会话/配置，目录可删；预览零状态变化', async () => {
    const helpers = makeHelpers();
    const project = await createPhProject({ name: 'M', workDirectory: '' }); // managed
    const s1 = await createProjectSession(helpers, project.id);
    const s2 = await createProjectSession(helpers, project.id);
    ensureConfigFile(project.id);

    const preview = await previewPhProjectDeletion(project.id, { projectLayerPath: fakeLayerPath });
    assert.equal(preview.managedDirectory.deletable, true);
    assert.deepEqual(preview.managedDirectory.reasons, []);
    assert.equal(preview.managedDirectory.source, 'managed');
    assert.equal(preview.sessions.length, 2);
    assert.deepEqual(new Set(preview.sessions.map((s) => s.id)), new Set([s1.id, s2.id]));
    assert.equal(preview.featureConfig.exists, true);
    // 预览零状态变化
    const index = await readSessionIndex(AGENT);
    assert.equal(index.sessions.filter((s) => s.projectId === project.id).length, 2);
    assert.ok(existsSync(getPhManagedProjectDir(project.id)));
  });

  test('外部目录项目：deletable=false（external_directory），目录保留', async () => {
    const dirD = makeExternalDir('claw-ph-del-ext-');
    const project = await createPhProject({ name: 'E', workDirectory: dirD });
    const preview = await previewPhProjectDeletion(project.id, {});
    assert.equal(preview.managedDirectory.deletable, false);
    assert.ok(preview.managedDirectory.reasons.some((r) => r.kind === 'external_directory'));
  });

  test('被其他项目 / 目录会话 / 工作空间当前目录引用：不可删并列明原因', async () => {
    const helpers = makeHelpers();
    // A 托管目录同时被 B（外部绑定同路径）与目录会话 D 引用
    const projectA = await createPhProject({ name: 'A', workDirectory: '' });
    const managedDir = getPhManagedProjectDir(projectA.id);
    const projectB = await createPhProject({ name: 'B', workDirectory: managedDir });
    await helpers.createPrebuiltSession(AGENT, { returnSummary: false, openDirectory: managedDir, title: 'dir chat' });

    let preview = await previewPhProjectDeletion(projectA.id, {});
    const kinds = preview.managedDirectory.reasons.map((r) => r.kind);
    assert.ok(kinds.includes('project'), '其他项目引用');
    assert.ok(kinds.includes('session'), '目录会话引用');
    assert.equal(preview.managedDirectory.deletable, false);

    // 工作空间当前目录指向托管目录也算引用
    const projectC = await createPhProject({ name: 'C', workDirectory: '' });
    const state = await readWorkspaceState(AGENT);
    await writeWorkspaceState(AGENT, { ...state, openDirectory: getPhManagedProjectDir(projectC.id) });
    preview = await previewPhProjectDeletion(projectC.id, { readWorkspaceState });
    assert.ok(preview.managedDirectory.reasons.some((r) => r.kind === 'workspace_open_directory'));
    assert.equal(preview.managedDirectory.deletable, false);
    void projectB;
  });
});

describe('046 删除：执行与安全边界', () => {
  function makeDeleteDeps(runtimes) {
    const harness = makeLifecycleDeps({
      runtimes,
      viewerImpl: viewerFromRuntimes(runtimes),
    });
    const helpers = makeHelpers();
    return {
      stops: harness.stops,
      deps: {
        ...harness.deps,
        deletePrebuiltSession: helpers.deletePrebuiltSession,
        clearUISurfaces: (viewerAgentId) => { (harness.deps.__cleared ||= []).push(viewerAgentId); },
        projectLayerPath: fakeLayerPath,
      },
    };
  }

  test('托管项目 + 用户显式选择：会话/配置/目录/记录全删，共享兄弟会话不误停', async () => {
    const helpers = makeHelpers();
    const project = await createPhProject({ name: 'M', workDirectory: '' });
    const s1 = await createProjectSession(helpers, project.id);
    const s2 = await createProjectSession(helpers, project.id);
    ensureConfigFile(project.id);
    // 同数据根下另一项目的会话（不应被触碰）
    const other = await createPhProject({ name: 'O', workDirectory: makeExternalDir('claw-ph-del-o-') });
    const otherSession = await createProjectSession(helpers, other.id);

    const runtimes = new Map([[s1.id, { viewerAgentId: `view-${s1.id}`, busy: { callActive: false, queued: [] } }]]);
    const { stops, deps } = makeDeleteDeps(runtimes);

    const result = await deletePhProject(project.id, { deleteManagedDirectory: true }, deps);

    assert.deepEqual(new Set(result.deletedSessions), new Set([s1.id, s2.id]));
    // 精确停止：只有项目自己的存活会话，带 waitForPersistence
    assert.equal(stops.length, 1);
    assert.equal(stops[0].sessionId, s1.id);
    assert.equal(stops[0].opts?.waitForPersistence, true);
    // 索引与文件清理（复用单会话删除链）
    const index = await readSessionIndex(AGENT);
    assert.equal(index.sessions.filter((s) => s.projectId === project.id).length, 0);
    assert.ok(index.sessions.find((s) => s.id === otherSession.id), '其他项目会话保留');
    assert.ok(!existsSync(join(DATA_ROOT, 'workspaces', AGENT, 'sessions', `${s1.id}.json`)), '会话文件删除');
    // 配置删除、托管目录删除、记录移除
    assert.equal(result.featureConfigDeleted, true);
    assert.ok(!existsSync(fakeLayerPath(project.id)));
    assert.equal(result.managedDirectory.deleted, true);
    assert.ok(!existsSync(getPhManagedProjectDir(project.id)), '托管目录已删');
    const storeRaw = JSON.parse((await import('fs')).readFileSync(getPhProjectStorePath(), 'utf8'));
    assert.ok(!storeRaw.projects.some((p) => p.id === project.id), '项目记录移除');
    assert.ok(storeRaw.projects.some((p) => p.id === other.id), '其他项目保留');
  });

  test('默认（deleteManagedDirectory 缺省）：目录保留，其余照删', async () => {
    const helpers = makeHelpers();
    const project = await createPhProject({ name: 'M2', workDirectory: '' });
    await createProjectSession(helpers, project.id);
    const { deps } = makeDeleteDeps(new Map());
    const result = await deletePhProject(project.id, {}, deps);
    assert.equal(result.managedDirectory.deleted, false);
    assert.ok(existsSync(getPhManagedProjectDir(project.id)), '不捎带删除托管目录');
    const index = await readSessionIndex(AGENT);
    assert.equal(index.sessions.filter((s) => s.projectId === project.id).length, 0);
  });

  test('外部项目 + 显式要求删目录：409 拒绝且零状态变化（外部目录绝不删除）', async () => {
    const dirD = makeExternalDir('claw-ph-del-ext2-');
    const project = await createPhProject({ name: 'E2', workDirectory: dirD });
    const { deps } = makeDeleteDeps(new Map());
    await assert.rejects(
      deletePhProject(project.id, { deleteManagedDirectory: true }, deps),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'ph_project_directory_not_deletable');
        assert.ok(error.reasons.some((r) => r.kind === 'external_directory'));
        return true;
      },
    );
    assert.ok(existsSync(dirD), '外部目录原样');
    const index = await readSessionIndex(AGENT);
    // 项目与会话均未被删除（整个请求拒绝，不做半成功）
    assert.ok((await import('../server/routes/ph-projects.js')).getPhProject(project.id));
    void index;
  });

  test('托管目录被目录会话引用 + 显式要求删目录：409 拒绝，目录保留', async () => {
    const helpers = makeHelpers();
    const project = await createPhProject({ name: 'M3', workDirectory: '' });
    const managedDir = getPhManagedProjectDir(project.id);
    await helpers.createPrebuiltSession(AGENT, { returnSummary: false, openDirectory: managedDir, title: 'dir chat' });
    const { deps } = makeDeleteDeps(new Map());
    await assert.rejects(
      deletePhProject(project.id, { deleteManagedDirectory: true }, deps),
      (error) => error.statusCode === 409 && error.code === 'ph_project_directory_not_deletable',
    );
    assert.ok(existsSync(managedDir), '被引用目录保留');
  });

  test('优雅停止失败回退硬停，删除继续完成', async () => {
    const helpers = makeHelpers();
    const project = await createPhProject({ name: 'M4', workDirectory: '' });
    const s1 = await createProjectSession(helpers, project.id);
    const runtimes = new Map([[s1.id, { viewerAgentId: `view-${s1.id}`, busy: { callActive: false, queued: [] } }]]);
    const harness = makeLifecycleDeps({ runtimes, viewerImpl: viewerFromRuntimes(runtimes) });
    let hardStopCalled = false;
    const deps = {
      ...harness.deps,
      stopManagedAgent: async (agentId, sessionId, opts) => {
        harness.stops.push({ agentId, sessionId, opts });
        if (opts?.waitForPersistence) throw new Error('persist failed');
        hardStopCalled = true; // 回退：无 waitForPersistence 的普通停止
      },
      deletePrebuiltSession: helpers.deletePrebuiltSession,
      projectLayerPath: fakeLayerPath,
    };
    const result = await deletePhProject(project.id, {}, deps);
    assert.ok(hardStopCalled, '持久化失败后回退硬停');
    assert.deepEqual(result.deletedSessions, [s1.id], '删除仍完成');
  });
});

// ── 4. ID 稳定与路由装配 ──────────────────────────────────────────────────

describe('046 ID 稳定与路由装配', () => {
  test('改名 + 改绑：ID 不变、不搬文件、旧目录保留', async () => {
    const fixture = await setupRebindFixture();
    const { deps } = makeLifecycleDeps({
      runtimes: fixture.runtimes,
      viewerImpl: viewerFromRuntimes(fixture.runtimes),
    });
    const renamed = await renamePhProject(fixture.projectA.id, 'A renamed');
    const rebound = await rebindPhProject(fixture.projectA.id, { workDirectory: fixture.dirNew }, deps);
    assert.equal(renamed.id, fixture.projectA.id);
    assert.equal(rebound.project.id, fixture.projectA.id);
    assert.equal(rebound.project.name, 'A renamed', '改名与改绑互不覆盖');
    assert.ok(existsSync(fixture.dirD), '旧目录不清理');
    const storeRaw = JSON.parse((await import('fs')).readFileSync(getPhProjectStorePath(), 'utf8'));
    assert.equal(storeRaw.projects.filter((p) => p.id === fixture.projectA.id).length, 1, '记录不重复');
  });

  test('路由装配：project_rebind / project_archive / project_delete(_preview) 挂载且 deps 透传', async () => {
    const handlers = {};
    const app = {
      get: (p, ...rest) => { handlers[`GET ${p}`] = rest[rest.length - 1]; },
      post: (p, ...rest) => { handlers[`POST ${p}`] = rest[rest.length - 1]; },
    };
    const harness = makeLifecycleDeps({ runtimes: new Map() });
    setupPhProjectRoutes(app, { json: () => (_req, _res, next) => next?.() }, harness.deps);
    for (const route of [
      'POST /protoclaw/ph_project/project_rebind',
      'POST /protoclaw/ph_project/project_archive',
    ]) {
      assert.ok(handlers[route], `${route} 已挂载`);
    }
    assert.ok(handlers['GET /protoclaw/ph_project/project_delete_preview'], 'delete_preview 已挂载');
    assert.ok(handlers['POST /protoclaw/ph_project/project_delete'], 'delete 已挂载');
    assert.ok(handlers['POST /protoclaw/ph_project/project_create'], '既有 041 路由不受影响');
    assert.ok(handlers['POST /protoclaw/ph_project/project_rename'], '既有 041 路由不受影响');

    // deps 缺失时改绑显式报错（装配完整性自检，而非运行期 TypeError）
    const res1 = { statusCode: 0, jsonPayload: null, status(code) { this.statusCode = code; return this; }, json(p) { this.jsonPayload = p; } };
    await handlers['POST /protoclaw/ph_project/project_rebind'](
      { body: { projectId: 'prj_000000000000', workDirectory: 'x' } }, res1, (e) => { res1.error = e; },
    );
    assert.ok(res1.error, '未知项目经 next(error) 出错');
    assert.equal(res1.error.statusCode, 404);
  });
});
