import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 测试隔离：startManagedAgent 的配额检查（ADR-0027）读默认路径下的
// workspace-settings.json，USER_DATA_ROOT 在模块加载时固化——必须先设
// env 再动态 import（ESM 静态 import 会提升），否则读真实用户数据目录。
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claw-agent-lifecycle-test-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;

const { createAgentLifecycleModule } = await import('../server/routes/agent-lifecycle.js');
const { buildSessionWorkspaceEnv, buildSharedSessionStartMessage, resolveManagedProcessPlacement } = await import('../server/routes/agent-startup.js');
const { managedAgents } = await import('../server/shared/agent-access.js');
const { FileSessionStore } = await import('@agentdevjs/core');

after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

// ── Helpers ────────────────────────────────────────────────

function createMockChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.exitCode = 0;
    child.stopped = true;
    child.emit('exit', 0);
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

const EMPTY_SESSION_META = {
  active_workspace_session_id: null,
  active_workspace_session_form_id: null,
  active_workspace_session_title: null,
  active_workspace_agent_name: null,
  active_workspace_display_name: null,
};

function createMockCtx(overrides = {}) {
  return {
    sessionApi: {
      activatePrebuiltSession: async () => ({ id: 'test-session' }),
      summarizePrebuiltSession: async (agentId, session) => session,
    },
    getAgents: async () => [],
    getAgentsLight: async () => [],
    enrichAgent: async (agent) => agent,
    requireAgentLight: async (id) => ({ id, relativeDir: 'test', name: id }),
    resolveRuntimeDisplayName: async (agent) => agent?.name || 'test-agent',
    readActiveWorkspaceSessionMeta: async () => ({
      workspaceSessions: [],
      sessionMeta: { ...EMPTY_SESSION_META },
    }),
    readWorkspaceSessionMeta: async () => ({ ...EMPTY_SESSION_META }),
    readViewerJson: async () => ({ agents: [], currentAgentId: null }),
    getPendingInputCount: async () => 0,
    resolveAgentModelPresets: async () => null,
    // 测试隔离：不读真实用户数据目录的 workspace-settings.json
    readVisibilityOverrides: async () => ({}),
    ...overrides,
  };
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

describe('buildSessionWorkspaceEnv', () => {
  it('passes the first programming-helper session workdir explicitly to the host', () => {
    assert.deepEqual(buildSessionWorkspaceEnv(
      'programming-helper',
      'project-a-session',
      'D:/code/project-a',
    ), {
      PROTOCLAW_SESSION_WORKSPACE_CWD: 'D:/code/project-a',
    });
  });

  it('rejects a programming-helper session without an explicit workdir', () => {
    assert.throws(
      () => buildSessionWorkspaceEnv('programming-helper', 'missing-workdir', ''),
      /explicit session project directory/,
    );
  });

  it('does not add the programming workdir contract to other agents', () => {
    assert.deepEqual(buildSessionWorkspaceEnv('qqbot', 'portal-session', ''), {});
  });
});

describe('buildSharedSessionStartMessage', () => {
  it('preserves the target session workdir for a cross-project shared host', () => {
    const message = buildSharedSessionStartMessage({
      sessionId: 'project-b-session',
      agentName: 'Project B',
      projectDir: 'D:/code/project-b',
      runtime: { modelPresetRole: 'default' },
    });
    assert.deepEqual(message, {
      type: 'add-session',
      sessionId: 'project-b-session',
      agentName: 'Project B',
      workspaceCwd: 'D:/code/project-b',
      handoffPath: null,
      runtime: { sessionType: null, gcChatId: null, modelPresetRole: 'default' },
    });
  });

  it('rejects shared-session startup without a target session workdir', () => {
    assert.throws(
      () => buildSharedSessionStartMessage({ sessionId: 'missing-workdir', agentName: 'Missing', projectDir: '' }),
      /explicit session project directory/,
    );
  });
});

describe('resolveManagedProcessPlacement', () => {
  const globalAgent = { id: 'programming-helper', processMode: 'shared-global' };

  it('groups different project sessions globally while preserving each project directory', () => {
    const first = resolveManagedProcessPlacement(globalAgent, { openDirectory: 'D:/code/project-a' });
    const second = resolveManagedProcessPlacement(globalAgent, { openDirectory: 'D:/code/project-b' });

    assert.deepEqual(first, {
      processMode: 'shared-global',
      projectDir: 'D:/code/project-a',
      processGroupKey: 'programming-helper::__global__',
    });
    assert.deepEqual(second, {
      processMode: 'shared-global',
      projectDir: 'D:/code/project-b',
      processGroupKey: 'programming-helper::__global__',
    });
  });

  it('does not create a global host without a session-owned project directory', () => {
    const placement = resolveManagedProcessPlacement(globalAgent, { openDirectory: '' });
    assert.equal(placement.processMode, 'shared-global');
    assert.equal(placement.projectDir, '');
    assert.equal(placement.processGroupKey, null);
  });

  it('does not permit shared-global for another prebuilt agent', () => {
    const placement = resolveManagedProcessPlacement({ id: 'qqbot', processMode: 'shared-global' }, {
      openDirectory: 'D:/code/project-a',
    });
    assert.equal(placement.processMode, 'isolated');
    assert.equal(placement.processGroupKey, null);
  });
});

describe('agent-lifecycle', () => {
  let savedKeys;

  beforeEach(() => {
    // Snapshot existing keys so we can clean up after each test
    savedKeys = new Set(managedAgents.keys());
  });

  afterEach(() => {
    // Clean up any keys we added
    for (const key of managedAgents.keys()) {
      if (!savedKeys.has(key)) {
        managedAgents.delete(key);
      }
    }
  });

  // ── waitForProcessExit ───────────────────────────────────

  describe('waitForProcessExit', () => {
    it('resolves when the child emits exit', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = new EventEmitter();
      child.exitCode = null;

      // Emit exit shortly after calling
      setTimeout(() => {
        child.exitCode = 0;
        child.emit('exit', 0);
      }, 10);

      await mod.waitForProcessExit(child);
      assert.equal(child.exitCode, 0);
    });

    it('resolves after timeout even if child never exits', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = new EventEmitter();
      child.exitCode = null;

      // Use a very short timeout
      await mod.waitForProcessExit(child, 50);
      // Child still alive, but we resolved due to timeout
      assert.equal(child.exitCode, null);
    });
  });

  // ── stopManagedAgent ─────────────────────────────────────

  describe('stopManagedAgent', () => {
    it('kills a running agent process and sets stopped flag', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = createMockChild();
      const runtime = injectRuntime('test-agent', 'sess-1', child);

      const status = await mod.stopManagedAgent('test-agent', 'sess-1');
      assert.equal(status.status, 'stopped');
      assert.equal(runtime.stopped, true);
    });

    it('returns stopped status when no runtime exists', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const status = await mod.stopManagedAgent('nonexistent-agent');
      assert.equal(status.status, 'stopped');
    });

    it('skips already-stopped runtimes', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = createMockChild();
      child.stopped = true;
      child.exitCode = 0;
      const runtime = injectRuntime('stopped-agent', 'sess-2', child);
      runtime.stopped = true;
      runtime.exitCode = 0;

      let killCalled = false;
      child.kill = () => { killCalled = true; };

      await mod.stopManagedAgent('stopped-agent', 'sess-2');
      assert.equal(killCalled, false);
    });

    it('stops all runtimes for an agent when no sessionId specified', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child1 = createMockChild();
      const child2 = createMockChild();
      injectRuntime('multi-agent', 'sess-a', child1);
      injectRuntime('multi-agent', 'sess-b', child2);

      const status = await mod.stopManagedAgent('multi-agent');
      assert.equal(status.status, 'stopped');
      // Both children should have been killed
      assert.equal(child1.stopped, true);
      assert.equal(child2.stopped, true);
    });

    it('reports stopped after SIGTERM even though the child exitCode stays null', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = createMockChild();
      child.kill = (signal) => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      };
      const runtime = injectRuntime('signal-agent', 'sess-signal', child);

      const status = await mod.stopManagedAgent('signal-agent', 'sess-signal');
      assert.equal(runtime.stopped, true);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, 'SIGTERM');
      assert.equal(status.status, 'stopped');
      assert.equal(status.signalCode, 'SIGTERM');
    });

    it('accepts shared-session cleanup without killing the sibling process', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = createMockChild();
      const runtime = injectRuntime('shared-agent', 'shared-session', child);
      runtime.processGroupKey = 'shared-agent::/project';
      let killCalled = false;
      child.kill = () => { killCalled = true; };
      child.send = (message) => {
        assert.deepEqual(message, { type: 'remove-session', sessionId: 'shared-session' });
        queueMicrotask(() => child.emit('message', { type: 'session-exited', sessionId: 'shared-session' }));
      };

      const status = await mod.stopManagedAgent('shared-agent', 'shared-session');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(status.status, 'stopped');
      assert.equal(runtime.stopped, true);
      assert.equal(killCalled, false);
    });

    it('waits for shared-session persistence acknowledgement when requested', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = createMockChild();
      const runtime = injectRuntime('shared-agent', 'slow-session', child);
      runtime.processGroupKey = 'shared-agent::/project';
      child.send = (message) => {
        assert.deepEqual(message, { type: 'remove-session', sessionId: 'slow-session' });
      };

      let settled = false;
      const stopping = mod.stopManagedAgent('shared-agent', 'slow-session', { waitForPersistence: true })
        .then((status) => {
          settled = true;
          return status;
        });
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(runtime.stopped, false);
      assert.equal(runtime.stopping, true);

      child.emit('message', { type: 'session-exited', sessionId: 'slow-session', persisted: true });
      const status = await stopping;
      assert.equal(status.status, 'stopped');
      assert.equal(runtime.stopped, true);
      assert.equal(runtime.stopping, false);
    });

    it('confirms the closing snapshot while automatic saves of the same session are pending', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = createMockChild();
      injectRuntime('coder', 'concurrent-save-session', child);
      const sessionDir = path.join(DATA_DIR, 'concurrent-session-saves');
      const store = new FileSessionStore(sessionDir);
      const snapshot = (callIndex) => ({
        version: 3,
        sessionId: 'concurrent-save-session',
        savedAt: callIndex,
        agentType: 'TestAgent',
        runtime: { initialized: true, callIndex, featureStates: [] },
        rollbackHistory: [],
      });
      // Keep the storage implementation real; only the child IPC transport is replaced.
      const autoSaves = Array.from({ length: 16 }, (_, index) =>
        store.save('concurrent-save-session', snapshot(index)));
      const autoResults = Promise.allSettled(autoSaves);
      let closing;
      child.send = (message) => {
        assert.deepEqual(message, { type: 'remove-session', sessionId: 'concurrent-save-session' });
        closing = store.save('concurrent-save-session', snapshot(16)).then(
          () => child.emit('message', { type: 'session-exited', sessionId: message.sessionId, persisted: true }),
          () => child.emit('message', { type: 'session-exited', sessionId: message.sessionId, persisted: false }),
        );
      };

      const stopping = mod.stopManagedAgent('coder', 'concurrent-save-session', { waitForPersistence: true });
      try {
        assert.equal((await stopping).status, 'stopped');
        assert.deepEqual((await autoResults).map(result => result.status), Array(16).fill('fulfilled'));
        const saved = JSON.parse(readFileSync(path.join(sessionDir, 'concurrent-save-session.json'), 'utf8'));
        assert.deepEqual(saved, snapshot(16), 'the acknowledged closing snapshot must remain on disk');
      } finally {
        await Promise.allSettled([autoResults, closing, stopping]);
      }
    });

    it('fails a persistence wait when no runtime can confirm the session save', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      await assert.rejects(
        mod.stopManagedAgent('missing-agent', 'missing-session', { waitForPersistence: true }),
        /unavailable before persistence confirmation/,
      );
    });

    it('fails a persistence wait when the runtime reports a save failure', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = createMockChild();
      const runtime = injectRuntime('shared-agent', 'unsaved-session', child);
      runtime.processGroupKey = 'shared-agent::/project';
      child.send = () => {};

      const stopping = mod.stopManagedAgent('shared-agent', 'unsaved-session', { waitForPersistence: true });
      child.emit('message', { type: 'session-exited', sessionId: 'unsaved-session', persisted: false });

      await assert.rejects(stopping, /Failed to confirm session persistence/);
    });

    it('fails a persistence wait when the host process exits before acknowledgement', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const child = createMockChild();
      const runtime = injectRuntime('shared-agent', 'exiting-session', child);
      runtime.processGroupKey = 'shared-agent::/project';
      child.send = () => {};

      const stopping = mod.stopManagedAgent('shared-agent', 'exiting-session', { waitForPersistence: true });
      child.exitCode = 1;
      child.emit('exit', 1);

      await assert.rejects(stopping, /Failed to confirm session persistence/);
      assert.equal(runtime.stopped, true);
      assert.equal(runtime.stopping, false);
    });

    // ── 早关闭竞态（伪失败）：子进程自行关闭（保存已落盘）→ session-exited
    // 发出时服务端尚未监听（消息丢失）→ process.exit(0) → 服务端 onExit 无确认。
    // 保存屏障的语义是"快照落盘确认"，不是"握手确认"：进程死亡且未确认时，
    // 必须核验盘上保存事实，而不是把落盘成功的关闭误判为失败（rotation 伪失败
    // 的主路径，10-17/10-18 三次事故同签名）。
    describe('early self-close persistence race', () => {
      it('passes the barrier when the host exits after a fresh on-disk save', async () => {
        const mod = createAgentLifecycleModule(createMockCtx({
          readSessionSavedAt: async () => Date.now() - 500,
        }));
        const child = createMockChild();
        const runtime = injectRuntime('shared-agent', 'raced-session', child);
        runtime.processGroupKey = 'shared-agent::/project';
        child.send = () => {
          // 子进程已自行关闭（保存完成）后垂死：remove-session 无人处理，进程退出
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit('exit', 0);
          });
        };

        const status = await mod.stopManagedAgent('shared-agent', 'raced-session', { waitForPersistence: true });
        assert.equal(status.status, 'stopped');
        assert.equal(runtime.stopped, true);
      });

      it('fails the barrier when the host exits and the on-disk save is stale', async () => {
        const mod = createAgentLifecycleModule(createMockCtx({
          readSessionSavedAt: async () => Date.now() - 60_000,
        }));
        const child = createMockChild();
        const runtime = injectRuntime('shared-agent', 'stale-save-session', child);
        runtime.processGroupKey = 'shared-agent::/project';
        child.send = () => {
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit('exit', 0);
          });
        };

        const stopping = mod.stopManagedAgent('shared-agent', 'stale-save-session', { waitForPersistence: true });
        await assert.rejects(stopping, /Failed to confirm session persistence/);
      });

      it('fails the barrier when the host exits and no on-disk save exists', async () => {
        const mod = createAgentLifecycleModule(createMockCtx({
          readSessionSavedAt: async () => null,
        }));
        const child = createMockChild();
        const runtime = injectRuntime('shared-agent', 'no-save-session', child);
        runtime.processGroupKey = 'shared-agent::/project';
        child.send = () => {
          queueMicrotask(() => {
            child.exitCode = 1;
            child.emit('exit', 1);
          });
        };

        const stopping = mod.stopManagedAgent('shared-agent', 'no-save-session', { waitForPersistence: true });
        await assert.rejects(stopping, /Failed to confirm session persistence/);
      });

      it('keeps an explicit persisted:false acknowledgement a hard failure', async () => {
        const mod = createAgentLifecycleModule(createMockCtx({
          readSessionSavedAt: async () => Date.now() - 100,
        }));
        const child = createMockChild();
        const runtime = injectRuntime('shared-agent', 'explicit-fail-session', child);
        runtime.processGroupKey = 'shared-agent::/project';
        child.send = () => {};

        const stopping = mod.stopManagedAgent('shared-agent', 'explicit-fail-session', { waitForPersistence: true });
        child.emit('message', { type: 'session-exited', sessionId: 'explicit-fail-session', persisted: false });

        await assert.rejects(stopping, /Failed to confirm session persistence/);
      });
    });
  });

  // ── onAgentExit ──────────────────────────────────────────

  describe('onAgentExit callback', () => {
    it('fires exit callbacks when startManagedAgent process exits', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());

      let exitInfo = null;
      mod.onAgentExit((agentId, sessionId, code, key) => {
        exitInfo = { agentId, sessionId, code, key };
      });

      // Start a managed agent with a non-existent directory — the spawned
      // process will fail quickly and exit, triggering the exit handler.
      const fakeAgent = {
        id: 'exit-cb-agent',
        name: 'Exit Callback Agent',
        relativeDir: 'prebuilt-agents/__nonexistent__',
        workspace_sessions: { activeSessionId: null },
      };

      const status = await mod.startManagedAgent(fakeAgent, null);
      assert.ok(status, 'startManagedAgent should return a status');

      // Wait for the spawned process to exit (it should fail fast)
      const runtime = Array.from(managedAgents.values())
        .find(r => r.agentId === 'exit-cb-agent');
      if (runtime?.process) {
        await mod.waitForProcessExit(runtime.process, 15000);
      }

      assert.ok(exitInfo, 'exit callback should have been called');
      assert.equal(exitInfo.agentId, 'exit-cb-agent');
      assert.equal(typeof exitInfo.code, 'number');
    });

    it('survives callback errors without crashing', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());

      mod.onAgentExit(() => {
        throw new Error('callback error');
      });

      const fakeAgent = {
        id: 'exit-err-agent',
        name: 'Error Agent',
        relativeDir: 'prebuilt-agents/__nonexistent__',
        workspace_sessions: { activeSessionId: null },
      };

      // Should not throw — error is caught internally in the exit handler
      await mod.startManagedAgent(fakeAgent, null);

      const runtime = Array.from(managedAgents.values())
        .find(r => r.agentId === 'exit-err-agent');
      if (runtime?.process) {
        await mod.waitForProcessExit(runtime.process, 15000);
      }
      // If we get here without uncaught exception, the test passes
      assert.ok(true);
    });
  });

  // ── getConnectedAgents ───────────────────────────────────

  describe('getConnectedAgents', () => {
    it('returns prebuilt agents with stopped status when no runtimes exist', async () => {
      const mod = createAgentLifecycleModule(createMockCtx({
        getAgentsLight: async () => [
          { id: 'agent-a', name: 'Agent A', description: 'desc', kind: 'agent', status: { pid: null, viewerAgentId: null } },
        ],
      }));

      const agents = await mod.getConnectedAgents();
      assert.ok(Array.isArray(agents));
      const agent = agents.find(a => a.id === 'agent-a');
      assert.ok(agent);
      assert.equal(agent.status, 'stopped');
      assert.equal(agent.source, 'prebuilt');
      assert.equal(agent.connected, false);
    });

    it('marks agent as running when a runtime is active', async () => {
      const child = createMockChild();
      injectRuntime('running-agent', null, child);
      // Set ready and viewerAgentId
      const runtime = managedAgents.get('running-agent::__NO_SESSION__');
      runtime.ready = true;
      runtime.viewerAgentId = 'viewer-1';

      const mod = createAgentLifecycleModule(createMockCtx({
        getAgentsLight: async () => [
          { id: 'running-agent', name: 'Running', description: '', kind: 'agent', status: { pid: 12345, viewerAgentId: 'viewer-1' } },
        ],
        readViewerJson: async (url) => {
          if (url.includes('/api/agents')) {
            return {
              agents: [{
                id: 'viewer-1',
                name: 'Running',
                connected: true,
                messageCount: 5,
                createdAt: '2026-01-01T00:00:00Z',
              }],
              currentAgentId: 'viewer-1',
            };
          }
          if (url.includes('/notification')) {
            return { callActive: false };
          }
          return {};
        },
      }));

      const agents = await mod.getConnectedAgents();
      const agent = agents.find(a => a.id === 'running-agent');
      assert.ok(agent);
      assert.equal(agent.status, 'running');
      assert.ok(agent.pid);
    });

    it('projects a newly published managed runtime identity when publication races workspace metadata loading', async () => {
      const child = createMockChild();
      const runtime = injectRuntime('programming-helper', 'new-session', child);
      const viewerEntry = { id: 'viewer-new', name: '编程小助手', connected: true };
      const mod = createAgentLifecycleModule(createMockCtx({
        getAgentsLight: async () => [{
          id: 'programming-helper', name: '智能编码空间', description: '', kind: 'workspace',
          status: { pid: 12345, viewerAgentId: null },
        }],
        readActiveWorkspaceSessionMeta: async () => {
          // Simulates the runtime identity arriving while APP metadata is read.
          runtime.viewerAgentId = viewerEntry.id;
          return { workspaceSessions: { sessions: [] }, sessionMeta: { ...EMPTY_SESSION_META } };
        },
        readWorkspaceSessionMeta: async (agentId, sessionId) => ({
          ...EMPTY_SESSION_META,
          active_workspace_session_id: sessionId,
          active_workspace_session_title: '新对话',
          active_workspace_display_name: '编程小助手',
        }),
        readViewerJson: async (url) => url.includes('/api/agents')
          ? { agents: [viewerEntry, { id: 'external-viewer', name: '真实外部代理', connected: true }], currentAgentId: viewerEntry.id }
          : { callActive: false },
      }));

      const agents = await mod.getConnectedAgents();
      const childEntry = agents.find((agent) => agent.id === viewerEntry.id);
      assert.equal(childEntry?.source, 'child');
      assert.equal(childEntry?.parent_id, 'programming-helper');
      assert.equal(childEntry?.sidebar_entry_id, 'programming-helper');
      assert.equal(childEntry?.active_workspace_session_id, 'new-session');
      assert.equal(agents.some((agent) => agent.id === viewerEntry.id && agent.source === 'external'), false);
      assert.equal(agents.find((agent) => agent.id === 'external-viewer')?.source, 'external');
    });

    it('hides a shared session while its disposal acknowledgement is pending', async () => {
      const child = createMockChild();
      const runtime = injectRuntime('stopping-agent', 'stopping-session', child);
      runtime.ready = true;
      runtime.viewerAgentId = 'viewer-stopping';
      runtime.stopping = true;
      const mod = createAgentLifecycleModule(createMockCtx({
        getAgentsLight: async () => [
          { id: 'stopping-agent', name: 'Stopping', description: '', kind: 'agent', status: { pid: 12345, viewerAgentId: 'viewer-stopping' } },
        ],
        readViewerJson: async () => ({
          agents: [{ id: 'viewer-stopping', name: 'Stopping', connected: true }],
          currentAgentId: 'viewer-stopping',
        }),
      }));

      const agents = await mod.getConnectedAgents();
      assert.equal(agents.some((agent) => agent.id === 'viewer-stopping'), false);
    });

    it('handles errors from readViewerJson gracefully', async () => {
      const mod = createAgentLifecycleModule(createMockCtx({
        getAgentsLight: async () => [
          { id: 'err-agent', name: 'Err', description: '', kind: 'agent', status: { pid: null, viewerAgentId: null } },
        ],
        readViewerJson: async () => { throw new Error('network error'); },
      }));

      const agents = await mod.getConnectedAgents();
      // Should not throw — should return agents with default values
      assert.ok(Array.isArray(agents));
      assert.ok(agents.length > 0);
    });

    // ── coder APP 呈现声明与条目路由（ADR-0025）──────────────

    const CODER_APP_LIGHT = {
      id: 'coder',
      name: 'Coder',
      description: '',
      kind: 'agent',
      status: { pid: null, viewerAgentId: null },
      visibility: 'on-demand',
      host: 'programming-helper',
    };

    it('exposes an on-demand APP entry with visibility and host facts (ADR-0025)', async () => {
      const mod = createAgentLifecycleModule(createMockCtx({
        getAgentsLight: async () => [
          {
            id: 'programming-helper',
            name: 'Programming Helper',
            description: '',
            kind: 'agent',
            status: { pid: null, viewerAgentId: null },
          },
          CODER_APP_LIGHT,
        ],
        readActiveWorkspaceSessionMeta: async () => ({
          workspaceSessions: { sessions: [] },
          sessionMeta: { ...EMPTY_SESSION_META },
        }),
        readViewerJson: async () => ({ agents: [], currentAgentId: null }),
      }));

      const agents = await mod.getConnectedAgents();
      const coderApp = agents.find((a) => a.id === 'coder');
      assert.ok(coderApp, 'coder APP entry comes from the prebuilt manifest');
      // APP 身份来自清单；on-demand 可见性按服务端合流的 Runtime 事实判定
      assert.equal(coderApp.visibility, 'on-demand');
      assert.equal(coderApp.host, 'programming-helper');
      assert.equal(typeof coderApp.sidebarVisible, 'boolean');
      assert.equal(coderApp.visibilityPolicy, 'auto');
    });

    it('routes coder APP children to their own entry (no sessionType routing)', async () => {
      const child = createMockChild();
      const runtime = injectRuntime('coder', 'coder-session', child);
      runtime.ready = true;
      runtime.viewerAgentId = 'viewer-coder';

      const mod = createAgentLifecycleModule(createMockCtx({
        getAgentsLight: async () => [CODER_APP_LIGHT],
        readActiveWorkspaceSessionMeta: async () => ({
          workspaceSessions: { sessions: [] },
          sessionMeta: { ...EMPTY_SESSION_META },
        }),
        readViewerJson: async (url) => {
          if (url.includes('/api/agents')) {
            return {
              agents: [{ id: 'viewer-coder', name: 'coder', connected: true, createdAt: '2026-01-01T00:00:00Z' }],
              currentAgentId: 'viewer-coder',
            };
          }
          if (url.includes('/notification')) return { callActive: false };
          return {};
        },
      }));

      const agents = await mod.getConnectedAgents();
      const coderChild = agents.find((a) => a.id === 'viewer-coder');
      assert.ok(coderChild, 'coder runtime should be listed as a child');
      assert.equal(coderChild.sidebar_entry_id, 'coder');
      assert.equal(coderChild.parent_id, 'coder');
    });
  });

  // ── setupRoutes ──────────────────────────────────────────

  describe('setupRoutes', () => {
    it('registers health, start, stop, restart, and other routes', () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const routes = [];
      const app = {
        get: (path, ...rest) => routes.push({ method: 'GET', path }),
        post: (path, ...rest) => routes.push({ method: 'POST', path }),
        put: (path, ...rest) => routes.push({ method: 'PUT', path }),
        delete: (path, ...rest) => routes.push({ method: 'DELETE', path }),
      };

      mod.setupRoutes(app, { json: () => (req, res, next) => next() });

      const paths = routes.map(r => r.path);
      assert.ok(paths.includes('/protoclaw/health'));
      assert.ok(paths.includes('/protoclaw/get_prebuilt_agents'));
      assert.ok(paths.includes('/protoclaw/get_agents_status'));
      assert.ok(paths.includes('/protoclaw/get_connected_agents'));
      assert.ok(paths.includes('/protoclaw/runtime_status'));
      assert.ok(paths.includes('/protoclaw/start_agent'));
      assert.ok(paths.includes('/protoclaw/stop_agent'));
      assert.ok(paths.includes('/protoclaw/restart_agent'));
    });

    it('health endpoint returns ok', () => {
      const serviceLifecycle = { getState: () => 'ready' };
      const mod = createAgentLifecycleModule(createMockCtx({ serviceLifecycle }));
      let responseData = null;
      let responseStatus = null;
      const app = {
        get: (path, handler) => {
          if (path === '/protoclaw/health') {
            handler({}, {
              status: (value) => { responseStatus = value; return { json: (data) => { responseData = data; } }; },
            });
          }
        },
        post: () => {},
        put: () => {},
        delete: () => {},
      };

      mod.setupRoutes(app, { json: () => (req, res, next) => next() });
      assert.ok(responseData);
      assert.equal(responseData.ok, true);
      assert.equal(responseData.state, 'ready');
      assert.equal(responseStatus, 200);
      assert.ok(responseData.appPort);
      assert.ok(responseData.viewerPort);
    });

    it('health is unavailable until the service reaches ready', () => {
      const mod = createAgentLifecycleModule(createMockCtx({ serviceLifecycle: { getState: () => 'starting' } }));
      let responseData = null;
      let responseStatus = null;
      const app = {
        get: (path, handler) => {
          if (path === '/protoclaw/health') {
            handler({}, {
              status: (value) => { responseStatus = value; return { json: (data) => { responseData = data; } }; },
            });
          }
        },
        post: () => {},
        put: () => {},
        delete: () => {},
      };
      mod.setupRoutes(app, { json: () => (req, res, next) => next() });
      assert.equal(responseStatus, 503);
      assert.deepEqual(responseData, { ok: false, state: 'starting', pid: responseData.pid, appPort: responseData.appPort, viewerPort: responseData.viewerPort });
    });

    it('runtime_status returns only the requested ready runtime', async () => {
      const runtime = injectRuntime('programming-helper', 'session-target', createMockChild());
      runtime.ready = true;
      runtime.viewerAgentId = 'viewer-target';
      const mod = createAgentLifecycleModule(createMockCtx({
        readViewerJson: async () => ({
          agents: [{
            id: 'viewer-target',
            name: 'Viewer Target',
            connected: true,
            messageCount: 4,
            connectionInfo: 'viewer://target',
          }],
        }),
        readWorkspaceSessionMeta: async () => ({
          ...EMPTY_SESSION_META,
          active_workspace_session_id: 'session-target',
          active_workspace_session_title: 'Target Session',
          active_workspace_display_name: 'Target Session',
        }),
      }));
      let handler = null;
      const app = {
        get: (path, routeHandler) => {
          if (path === '/protoclaw/runtime_status') handler = routeHandler;
        },
        post: () => {}, put: () => {}, delete: () => {},
      };
      mod.setupRoutes(app, { json: () => (req, res, next) => next() });
      let responseData = null;
      await handler(
        { query: { agentId: 'programming-helper', sessionId: 'session-target', operationId: 'create:test' } },
        { status: () => ({ json: () => {} }), json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );
      assert.equal(responseData.operationId, 'create:test');
      assert.equal(responseData.lifecycle, 'ready');
      assert.equal(responseData.ready, true);
      assert.equal(responseData.agent.id, 'viewer-target');
      assert.equal(responseData.agent.parent_id, 'programming-helper');
      assert.equal(responseData.agent.active_workspace_session_id, 'session-target');
    });

    it('runtime_status does not scan session metadata while the Viewer runtime is still absent', async () => {
      const runtime = injectRuntime('programming-helper', 'session-starting', createMockChild());
      runtime.viewerAgentId = 'viewer-not-connected';
      let metadataReads = 0;
      const mod = createAgentLifecycleModule(createMockCtx({
        readViewerJson: async () => ({ agents: [] }),
        readWorkspaceSessionMeta: async () => {
          metadataReads += 1;
          return { ...EMPTY_SESSION_META };
        },
      }));
      let handler = null;
      const app = {
        get: (path, routeHandler) => {
          if (path === '/protoclaw/runtime_status') handler = routeHandler;
        },
        post: () => {}, put: () => {}, delete: () => {},
      };
      mod.setupRoutes(app, { json: () => (req, res, next) => next() });
      let responseData = null;
      await handler(
        { query: { agentId: 'programming-helper', sessionId: 'session-starting' } },
        { status: () => ({ json: () => {} }), json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );
      assert.equal(responseData.lifecycle, 'starting');
      assert.equal(responseData.agent, null);
      assert.equal(metadataReads, 0);
    });

    it('runtime_status reports a shared session awaiting disposal acknowledgement as stopping', async () => {
      const runtime = injectRuntime('programming-helper', 'session-disposing', createMockChild());
      runtime.stopping = true;
      runtime.ready = true;
      runtime.viewerAgentId = 'viewer-disposing';
      const mod = createAgentLifecycleModule(createMockCtx({
        readViewerJson: async () => ({ agents: [{ id: 'viewer-disposing', connected: true }] }),
      }));
      let handler = null;
      const app = {
        get: (path, routeHandler) => {
          if (path === '/protoclaw/runtime_status') handler = routeHandler;
        },
        post: () => {}, put: () => {}, delete: () => {},
      };
      mod.setupRoutes(app, { json: () => (req, res, next) => next() });
      let responseData = null;
      await handler(
        { query: { agentId: 'programming-helper', sessionId: 'session-disposing' } },
        { status: () => ({ json: () => {} }), json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );
      assert.equal(responseData.lifecycle, 'stopping');
      assert.equal(responseData.ready, false);
    });

    it('runtime_status treats signal termination as stopped instead of stopping forever', async () => {
      const child = createMockChild();
      child.signalCode = 'SIGTERM';
      const runtime = injectRuntime('programming-helper', 'session-signal', child);
      runtime.stopped = true;
      runtime.ready = true;
      runtime.viewerAgentId = 'viewer-signal';
      const mod = createAgentLifecycleModule(createMockCtx({
        readViewerJson: async () => ({
          agents: [{ id: 'viewer-signal', connected: false }],
        }),
      }));
      let handler = null;
      const app = {
        get: (path, routeHandler) => {
          if (path === '/protoclaw/runtime_status') handler = routeHandler;
        },
        post: () => {}, put: () => {}, delete: () => {},
      };
      mod.setupRoutes(app, { json: () => (req, res, next) => next() });
      let responseData = null;
      await handler(
        { query: { agentId: 'programming-helper', sessionId: 'session-signal' } },
        { status: () => ({ json: () => {} }), json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );
      assert.equal(responseData.lifecycle, 'stopped');
      assert.equal(responseData.ready, false);
    });
  });

  // ── todo_control route ──────────────────────────────────

  describe('todo_control route', () => {
    function captureTodoControlHandler(mod) {
      let handler = null;
      const app = {
        get: () => {},
        post: (path, ...rest) => {
          if (path === '/protoclaw/todo_control') {
            // Express middleware: express.json() then the handler
            // The middleware array is [jsonMiddleware, handler]
            handler = rest[rest.length - 1];
          }
        },
        put: () => {},
        delete: () => {},
      };
      mod.setupRoutes(app, { json: () => (req, res, next) => next() });
      return handler;
    }

    it('sends IPC to the exact (agentId, sessionId) runtime', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const handler = captureTodoControlHandler(mod);

      const childA = createMockChild();
      const childB = createMockChild();
      const messagesA = [];
      const messagesB = [];
      childA.send = (msg) => { messagesA.push(msg); return true; };
      childB.send = (msg) => { messagesB.push(msg); return true; };

      injectRuntime('test-agent', 'session-A', childA);
      injectRuntime('test-agent', 'session-B', childB);

      let responseData = null;
      await handler(
        { body: { agentId: 'test-agent', sessionId: 'session-A', taskId: '3' } },
        { json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );

      assert.equal(responseData.ok, true);
      assert.equal(messagesA.length, 1, 'session-A should receive the IPC');
      assert.equal(messagesA[0].type, 'todo-control');
      assert.equal(messagesA[0].taskId, '3');
      assert.equal(messagesB.length, 0, 'session-B should NOT receive any IPC');
    });

    it('does NOT fall back to primary runtime when sessionId does not match', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const handler = captureTodoControlHandler(mod);

      // Only session-B exists; request targets session-A
      const childB = createMockChild();
      const messagesB = [];
      childB.send = (msg) => { messagesB.push(msg); return true; };
      injectRuntime('test-agent', 'session-B', childB);

      let responseData = null;
      await handler(
        { body: { agentId: 'test-agent', sessionId: 'session-A', taskId: '3' } },
        { json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );

      assert.equal(responseData.ok, false, 'should report not sent when session not found');
      assert.equal(messagesB.length, 0, 'session-B must NOT receive the IPC (no fallback)');
    });

    it('returns ok=false when sessionId is missing', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const handler = captureTodoControlHandler(mod);

      const child = createMockChild();
      const messages = [];
      child.send = (msg) => { messages.push(msg); return true; };
      injectRuntime('test-agent', 'session-X', child);

      let responseData = null;
      let responseStatus = null;
      await handler(
        { body: { agentId: 'test-agent', taskId: '3' } },
        {
          status: (status) => { responseStatus = status; return { json: (data) => { responseData = data; } }; },
          json: (data) => { responseData = data; },
        },
        (error) => { throw error; },
      );

      assert.equal(responseStatus, 400, 'should reject without an explicit runtime target');
      assert.equal(responseData.code, 'invalid_target');
      assert.equal(messages.length, 0);
    });

    it('rejects missing taskId payload', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const handler = captureTodoControlHandler(mod);

      const child = createMockChild();
      const messages = [];
      child.send = (msg) => { messages.push(msg); return true; };
      injectRuntime('test-agent', 'session-A', child);

      let statusCode = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: () => {},
      };
      await handler(
        { body: { agentId: 'test-agent', sessionId: 'session-A' } },
        res,
        (error) => { throw error; },
      );

      assert.equal(statusCode, 400);
      assert.equal(messages.length, 0);
    });

    it('rejects non-string taskId', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const handler = captureTodoControlHandler(mod);

      const child = createMockChild();
      const messages = [];
      child.send = (msg) => { messages.push(msg); return true; };
      injectRuntime('test-agent', 'session-A', child);

      let statusCode = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: () => {},
      };
      await handler(
        { body: { agentId: 'test-agent', sessionId: 'session-A', taskId: 3 } },
        res,
        (error) => { throw error; },
      );

      assert.equal(statusCode, 400);
      assert.equal(messages.length, 0);
    });

    it('delivers via runtimeId even when sessionId is stale (frontend id-space mismatch)', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const handler = captureTodoControlHandler(mod);

      const child = createMockChild();
      const messages = [];
      child.send = (msg) => { messages.push(msg); return true; };
      const rt = injectRuntime('test-agent', 'session-real', child);
      rt.viewerAgentId = 'viewer-agent-1';

      let responseData = null;
      await handler(
        // sessionId intentionally references a session that has no runtime entry —
        // this is the stale-cache window that previously caused {ok:false}
        { body: { agentId: 'test-agent', runtimeId: 'viewer-agent-1', sessionId: 'session-stale', taskId: '3' } },
        { json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );

      assert.equal(responseData.ok, true);
      assert.equal(responseData.via, 'runtimeId');
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'todo-control');
      assert.equal(messages[0].taskId, '3');
      assert.equal(messages[0].__targetSessionId, 'session-real', 'runtime targetSessionId is authoritative');
    });

    it('falls back to sessionId when runtimeId does not resolve', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const handler = captureTodoControlHandler(mod);

      const child = createMockChild();
      const messages = [];
      child.send = (msg) => { messages.push(msg); return true; };
      injectRuntime('test-agent', 'session-A', child);

      let responseData = null;
      await handler(
        { body: { agentId: 'test-agent', runtimeId: 'viewer-unknown', sessionId: 'session-A', taskId: '3' } },
        { json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );

      assert.equal(responseData.ok, true);
      assert.equal(responseData.via, 'sessionId');
      assert.equal(messages.length, 1);
      assert.equal(messages[0].type, 'todo-control');
      assert.equal(messages[0].taskId, '3');
    });

    it('returns ok=false when neither runtimeId nor sessionId resolves', async () => {
      const mod = createAgentLifecycleModule(createMockCtx());
      const handler = captureTodoControlHandler(mod);

      const child = createMockChild();
      const messages = [];
      child.send = (msg) => { messages.push(msg); return true; };
      injectRuntime('test-agent', 'session-B', child);

      let responseData = null;
      await handler(
        { body: { agentId: 'test-agent', runtimeId: 'viewer-unknown', sessionId: 'session-A', taskId: '3' } },
        { json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );

      assert.equal(responseData.ok, false, 'must not fall back to a different session (no cross-session contamination)');
      assert.equal(messages.length, 0);
    });
  });
});

// ── /protoclaw/app_info handshake capabilities ────────────────────────────
// ADR-0011 能力矩阵回归钉：握手能力位是前端远程门控（远程叶子右键菜单
// sessionOps、远程目录新对话 workspaceCreate）的唯一数据源。位漏报时这些
// 界面对真实远程整体消失（2026-08-31 fcdf770 引入门控当天即发生），
// mock 载荷驱动的连接侧测试抓不到，必须在路由真值层钉住。

describe('agent-lifecycle: app_info advertises the full remote capability set', () => {
  it('reports write / sessionOps / workspaceCreate as true', async () => {
    const mod = createAgentLifecycleModule(createMockCtx());
    let handler = null;
    const app = { get: (path, fn) => { if (path === '/protoclaw/app_info') handler = fn; }, post: () => {} };
    mod.setupRoutes(app, { json: () => (_req, _res, next) => next() });

    let responseData = null;
    await handler({}, { json: (data) => { responseData = data; } });

    assert.equal(responseData.ok, true);
    assert.deepEqual(responseData.capabilities, {
      write: true,
      sessionOps: true,
      workspaceCreate: true,
    });
  });
});
