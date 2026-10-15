import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 测试隔离：必须先固化 AGENTDEV_DATA_DIR 再动态 import server 模块——
// ESM 静态 import 会提升，模块加载先于 env 设置（与 headless-log-preamble
// 同理）。startManagedAgent 的配额检查读默认路径（USER_DATA_ROOT 下
// workspace-settings.json），不隔离会读真实用户数据目录。
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claw-runtime-quota-test-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;

const { managedAgents, countLiveRuntimeProcessesByAgent } = await import('../server/shared/agent-access.js');
const {
  RUNTIME_SPAWN_INTENTS,
  countLiveRuntimeProcesses,
  assertRuntimeSpawnAllowed,
  createRuntimeQuotaExceededError,
} = await import('../server/routes/runtime-quota.js');
const {
  readWorkspaceResourcePolicies,
  writeWorkspaceResourcePolicy,
  writeWorkspaceVisibilityOverride,
} = await import('../server/routes/workspace-settings.js');
const { buildLocalFailureResponse } = await import('../server/shared/operation-contract.js');
const { createAgentStartupFns } = await import('../server/routes/agent-startup.js');

// ── Helpers（对齐 agent-lifecycle.test.js 的 mock 模式）──────────

function createMockChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function injectRuntime(agentId, sessionId, child) {
  const runtime = {
    key: `${agentId}::${sessionId || '__NO_SESSION__'}`,
    agentId,
    id: agentId,
    process: child,
    startedAt: new Date().toISOString(),
    exitCode: null,
    stopped: false,
    viewerAgentId: null,
    selectedSessionId: sessionId || null,
    ready: false,
    sessionType: null,
    gcChatId: null,
  };
  managedAgents.set(runtime.key, runtime);
  return runtime;
}

function createStartupFns() {
  return createAgentStartupFns({
    sessionApi: {},
    requireAgentLight: async (id) => ({ id }),
    resolveRuntimeDisplayName: async (agent) => agent?.name || agent?.id || 'test-agent',
    readViewerJson: async () => ({ agents: [] }),
    exitCallbacks: [],
  });
}

const injectedKeys = [];

function injectTrackedRuntime(agentId, sessionId, child) {
  const runtime = injectRuntime(agentId, sessionId, child);
  injectedKeys.push(runtime.key);
  return runtime;
}

before(() => {
  // 默认路径（隔离后的 DATA_ROOT）预置配额。计数敏感用例各用独立 agentId：
  // managedAgents 是进程级共享，前面的用例注入的 runtime 会留在后面用例的
  // 计数里，交叉使用同一 agentId 会让存活数断言漂移。
  return Promise.all([
    writeWorkspaceResourcePolicy('coder', 2),
    writeWorkspaceResourcePolicy('gate-agent', 2),
    writeWorkspaceResourcePolicy('legacy-agent', 3),
  ]);
});

after(() => {
  for (const key of injectedKeys) managedAgents.delete(key);
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// ── countLiveRuntimeProcesses ─────────────────────────────────

describe('countLiveRuntimeProcesses', () => {
  it('counts only running runtimes, deduped by process', () => {
    const sharedChild = createMockChild();
    injectTrackedRuntime('count-agent', 's1', sharedChild);
    injectTrackedRuntime('count-agent', 's2', sharedChild); // 共享进程：计 1

    const stopped = injectTrackedRuntime('count-agent', 's3', createMockChild());
    stopped.stopped = true;

    const exited = injectTrackedRuntime('count-agent', 's4', createMockChild());
    exited.process.exitCode = 0; // 进程已退出

    assert.equal(countLiveRuntimeProcesses('count-agent'), 1);
    assert.equal(countLiveRuntimeProcesses('other-agent'), 0);
  });

  it('countLiveRuntimeProcessesByAgent projects per-agent deduped counts', () => {
    // 共享进程只发生在同 agent 内（processGroupKey 含 agentId），跨 agent
    // 各计各的独立进程
    injectTrackedRuntime('count-agent', 's5', createMockChild());
    injectTrackedRuntime('count-b', 's1', createMockChild());
    injectTrackedRuntime('count-b', 's2', createMockChild());

    const counts = countLiveRuntimeProcessesByAgent();
    assert.equal(counts['count-agent'], 2); // s1+s2 共享进程计 1 + s5 独立计 1
    assert.equal(counts['count-b'], 2);
  });
});

// ── assertRuntimeSpawnAllowed ─────────────────────────────────

describe('assertRuntimeSpawnAllowed', () => {
  it('allows when no policy is configured (缺省不限，零行为)', async () => {
    // coder 配了额，其他 agent 未配：放行且不数 runtime。
    await assert.doesNotReject(assertRuntimeSpawnAllowed({ agentId: 'memo' }));
  });

  it('does not constrain programming-helper by the linked coder policy', async () => {
    await writeWorkspaceResourcePolicy('programming-helper', 1);
    injectTrackedRuntime('programming-helper', 'ph-1', createMockChild());
    injectTrackedRuntime('programming-helper', 'ph-2', createMockChild());
    await assert.doesNotReject(assertRuntimeSpawnAllowed({ agentId: 'programming-helper' }));
  });

  it('allows when below the declared limit', async () => {
    await assert.doesNotReject(assertRuntimeSpawnAllowed({ agentId: 'coder', permissions: ['maxLiveRuntimes'] }));
  });

  it('does not apply a stored limit when the workspace has not declared that permission', async () => {
    injectTrackedRuntime('coder', 'undeclared-q1', createMockChild());
    injectTrackedRuntime('coder', 'undeclared-q2', createMockChild());
    await assert.doesNotReject(assertRuntimeSpawnAllowed({ agentId: 'coder' }));
  });

  it('rejects with a structured quota payload when the limit is reached', async () => {
    await writeWorkspaceResourcePolicy('quota-reject-agent', 2);
    injectTrackedRuntime('quota-reject-agent', 'q1', createMockChild());
    injectTrackedRuntime('quota-reject-agent', 'q2', createMockChild()); // 2/2 满

    await assert.rejects(
      assertRuntimeSpawnAllowed({ agentId: 'quota-reject-agent', permissions: ['maxLiveRuntimes'] }),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.code, 'runtime_quota_exceeded');
        assert.deepEqual(error.runtimeQuota, {
          agentId: 'quota-reject-agent',
          limit: 2,
          liveRuntimes: 2,
          actions: ['archive_thread', 'raise_quota', 'abandon'],
        });
        return true;
      },
    );
  });

  it('exempts rotation/接续 intent even at the limit (ADR-0027 §5)', async () => {
    injectTrackedRuntime('coder', 'r1', createMockChild());
    injectTrackedRuntime('coder', 'r2', createMockChild()); // 2/2 满

    await assert.doesNotReject(
      assertRuntimeSpawnAllowed({ agentId: 'coder', permissions: ['maxLiveRuntimes'], intent: RUNTIME_SPAWN_INTENTS.ROTATION }),
    );
  });

  it('存量豁免：调低配额不击杀存活 runtime，新 spawn 按新值拒绝', async () => {
    const a1 = injectTrackedRuntime('legacy-agent', 'g1', createMockChild());
    const a2 = injectTrackedRuntime('legacy-agent', 'g2', createMockChild());
    await writeWorkspaceResourcePolicy('legacy-agent', 1); // 调低到 1，存活仍 2

    // 不击杀：存活 runtime 原样
    assert.equal(a1.stopped, false);
    assert.equal(a2.stopped, false);
    assert.equal(countLiveRuntimeProcesses('legacy-agent'), 2);

    // 新 spawn 按新值判定：拒绝并报新配额
    await assert.rejects(
      assertRuntimeSpawnAllowed({ agentId: 'legacy-agent', permissions: ['maxLiveRuntimes'] }),
      (error) => error.runtimeQuota.limit === 1 && error.runtimeQuota.liveRuntimes === 2,
    );
  });
});

// ── structured rejection contract ─────────────────────────────

describe('buildLocalFailureResponse runtimeQuota passthrough', () => {
  it('carries the quota payload through the global error contract', () => {
    const error = createRuntimeQuotaExceededError({ agentId: 'coder', limit: 6, liveRuntimes: 6 });
    const response = buildLocalFailureResponse(error);
    assert.equal(response.ok, false);
    assert.equal(response.code, 'operation_rejected'); // stable contract
    assert.equal(response.legacyCode, 'runtime_quota_exceeded'); // 专有标识
    assert.equal(response.retryable, false); // 配额拒绝不可重试
    assert.deepEqual(response.runtimeQuota, {
      agentId: 'coder',
      limit: 6,
      liveRuntimes: 6,
      actions: ['archive_thread', 'raise_quota', 'abandon'],
    });
  });

  it('leaves ordinary errors unchanged', () => {
    const response = buildLocalFailureResponse(new Error('plain'));
    assert.equal('runtimeQuota' in response, false);
  });
});

// ── workspace-settings resourcePolicy 节 ──────────────────────

describe('workspace-settings resourcePolicy', () => {
  const settingsPath = path.join(DATA_DIR, 'nested', 'settings-mixed.json');

  it('writes, reads and clears resource policies through the permission item', async () => {
    await writeWorkspaceResourcePolicy('coder', 4, { settingsPath });
    assert.deepEqual(await readWorkspaceResourcePolicies({ settingsPath }), {
      coder: { maxLiveRuntimes: 4 },
    });

    await writeWorkspaceResourcePolicy('coder', null, { settingsPath }); // null = 清除
    assert.deepEqual(await readWorkspaceResourcePolicies({ settingsPath }), {});
  });

  it('rejects invalid maxLiveRuntimes values', async () => {
    for (const bad of [0, -1, 1.5, '3', true]) {
      await assert.rejects(
        writeWorkspaceResourcePolicy('coder', bad, { settingsPath }),
        (error) => error.status === 400,
      );
    }
    await assert.rejects(
      writeWorkspaceResourcePolicy('', 1, { settingsPath }),
      (error) => error.status === 400,
    );
  });

  it('keeps sibling sections when either section is written (互不抹节)', async () => {
    await writeWorkspaceResourcePolicy('coder', 3, { settingsPath });
    await writeWorkspaceVisibilityOverride('coder', 'always', { settingsPath });

    // 写 visibility 后 resourcePolicy 节仍在文件里
    assert.deepEqual(await readWorkspaceResourcePolicies({ settingsPath }), {
      coder: { maxLiveRuntimes: 3 },
    });

    await writeWorkspaceVisibilityOverride('coder', 'auto', { settingsPath }); // 删除覆盖条目
    await writeWorkspaceResourcePolicy('memo', 1, { settingsPath });

    // resourcePolicy 累积且文件仍可整体解析（两节共存）
    assert.deepEqual(await readWorkspaceResourcePolicies({ settingsPath }), {
      coder: { maxLiveRuntimes: 3 },
      memo: { maxLiveRuntimes: 1 },
    });
    assert.ok(existsSync(settingsPath));
  });
});

// ── startManagedAgent enforcement（拒绝点在 spawn 前，无子进程副作用）──

describe('startManagedAgent quota gate', () => {
  it('rejects before spawn when the workspace is at its limit', async () => {
    injectTrackedRuntime('gate-agent', 'e1', createMockChild());
    injectTrackedRuntime('gate-agent', 'e2', createMockChild()); // 2/2 满

    const { startManagedAgent } = createStartupFns();
    const agent = {
      id: 'gate-agent',
      name: 'Gate Agent',
      permissions: ['maxLiveRuntimes'],
      relativeDir: 'prebuilt-agents/__nonexistent__',
      workspace_sessions: { activeSessionId: null },
    };

    const before = managedAgents.size;
    await assert.rejects(
      startManagedAgent(agent, 'e-new-session'),
      (error) => {
        assert.equal(error.status, 429);
        assert.equal(error.code, 'runtime_quota_exceeded');
        assert.deepEqual(error.runtimeQuota, {
          agentId: 'gate-agent',
          limit: 2,
          liveRuntimes: 2,
          actions: ['archive_thread', 'raise_quota', 'abandon'],
        });
        return true;
      },
    );
    // 拒绝点在 spawn 前：没有新 runtime 条目、没有子进程
    assert.equal(managedAgents.size, before);
  });

  it('lets rotation intent through the gate at the limit', async () => {
    injectTrackedRuntime('gate-agent', 't1', createMockChild());
    injectTrackedRuntime('gate-agent', 't2', createMockChild()); // 2/2 满

    const { startManagedAgent, waitForProcessExit } = createStartupFns();
    const agent = {
      id: 'gate-agent',
      name: 'Gate Agent',
      permissions: ['maxLiveRuntimes'],
      relativeDir: 'prebuilt-agents/__nonexistent__', // 放行后 spawn 立即失败
      workspace_sessions: { activeSessionId: null },
    };

    // rotation 豁免：不被 429 拒绝，走到了 spawn（runtime 条目同步创建即证明）
    const status = await startManagedAgent(agent, 't-rotation', {
      spawnIntent: RUNTIME_SPAWN_INTENTS.ROTATION,
    });
    assert.ok(status);
    assert.ok(managedAgents.has('gate-agent::t-rotation'));

    // 等子进程退出（目录不存在，进程快速失败），避免句柄残留
    const runtime = managedAgents.get('gate-agent::t-rotation');
    if (runtime?.process) {
      await waitForProcessExit(runtime.process, 2000);
      managedAgents.delete(runtime.key);
    }
  });
});
