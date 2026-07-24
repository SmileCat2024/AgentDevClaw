import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createAgentLifecycleModule } from '../server/routes/agent-lifecycle.js';
import { managedAgents } from '../server/shared/agent-access.js';

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
      const mod = createAgentLifecycleModule(createMockCtx());
      let responseData = null;
      const app = {
        get: (path, handler) => {
          if (path === '/protoclaw/health') {
            handler({}, { json: (data) => { responseData = data; } });
          }
        },
        post: () => {},
        put: () => {},
        delete: () => {},
      };

      mod.setupRoutes(app, { json: () => (req, res, next) => next() });
      assert.ok(responseData);
      assert.equal(responseData.ok, true);
      assert.ok(responseData.appPort);
      assert.ok(responseData.viewerPort);
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
      await handler(
        { body: { agentId: 'test-agent', taskId: '3' } },
        { json: (data) => { responseData = data; } },
        (error) => { throw error; },
      );

      assert.equal(responseData.ok, false, 'should not send without sessionId');
      assert.equal(messages.length, 0);
    });
  });
});
