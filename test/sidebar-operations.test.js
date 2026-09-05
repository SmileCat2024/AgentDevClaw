import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { createOperationTrace, normalizeOperationId } from '../server/shared/operation-trace.js';
import { sessionIndexContentSignature } from '../server/shared/session-access.js';

function loadSidebarOperations(overrides = {}) {
  const ctx = createFrontendSandbox({
    renderAgentList() {},
    renderCurrentMainView() {},
    updateAgentRecord(agentId, updates = {}) {
      let matched = null;
      ctx.allAgents = ctx.allAgents.map((agent) => {
        if (agent.id !== agentId) return agent;
        matched = { ...agent, ...updates };
        return matched;
      });
      return matched;
    },
    URLSearchParams,
    ...overrides,
  });
  ctx.loadSource('public/src/modules/sidebar-operations.js');
  return ctx;
}

describe('sidebar operation state machine', () => {
  it('moves through deterministic phases and removes only the completed operation', () => {
    const ctx = loadSidebarOperations();
    const result = ctx.run(`(() => {
      const first = beginSidebarOperation({
        operationId: 'summary:one', type: 'replacement', kind: 'summary',
        agentId: 'programming-helper', sourceSessionId: 'source-1', phase: 'generating'
      });
      const second = beginSidebarOperation({
        operationId: 'create:two', type: 'create', kind: 'create',
        agentId: 'programming-helper', phase: 'committing'
      });
      updateSidebarOperation(first.operationId, {
        phase: 'target-ready', targetSessionId: 'target-1', targetRuntimeId: 'runtime-1', serverRevision: 4
      });
      const completed = finishSidebarOperation(first.operationId, 'settled');
      return {
        completed,
        remaining: listSidebarOperations(),
        version: getSidebarOperationVersion()
      };
    })()`);

    assert.equal(result.completed.phase, 'settled');
    assert.equal(result.completed.targetSessionId, 'target-1');
    assert.equal(result.completed.serverRevision, 4);
    assert.equal(result.remaining.length, 1);
    assert.equal(result.remaining[0].operationId, 'create:two');
    assert.equal(result.version, 4);
  });

  it('builds a content-free client diagnostic phase record', () => {
    const ctx = loadSidebarOperations();
    const event = ctx.run(`buildSidebarDiagnosticPhaseEvent({
      operationId: 'summary:client', kind: 'summary', phase: 'target-ready',
      agentId: 'programming-helper', sourceSessionId: 'source-1', targetSessionId: 'target-1',
      projectDir: 'D:\\\\private', projectName: 'private', title: 'private title',
      startedAt: Date.now() - 50, serverRevision: 8
    }, 'target-ready', { elapsedMs: 50, phaseDurationMs: 12 })`);
    assert.equal(event.operationId, 'summary:client');
    assert.equal(event.revision, 8);
    assert.equal(event.phaseDurationMs, 12);
    assert.equal(Object.hasOwn(event, 'projectDir'), false);
    assert.equal(Object.hasOwn(event, 'projectName'), false);
    assert.equal(Object.hasOwn(event, 'title'), false);
  });

  it('records response checkpoints and aggregates scoped Long Tasks', () => {
    class FakePerformanceObserver {
      constructor(callback) { this.callback = callback; }
      observe() {}
      takeRecords() { return [{ duration: 75 }, { duration: 20 }, { duration: 125 }]; }
      disconnect() {}
    }
    let now = 100;
    const ctx = loadSidebarOperations({
      PerformanceObserver: FakePerformanceObserver,
      performance: { now: () => (now += 10) },
    });
    const result = ctx.run(`(() => {
      beginSidebarOperation({
        operationId: 'trim:timing', kind: 'trim', type: 'replacement',
        phase: 'generating', agentId: 'programming-helper', sourceSessionId: 'source-1'
      });
      const checkpoint = recordSidebarOperationCheckpoint('trim:timing', 'response_headers_received', {
        requestWaitMs: 6400, responseBytes: 512
      });
      const stop = beginSidebarOperationMainThreadObservation('trim:timing');
      const observation = stop();
      return { checkpoint, observation };
    })()`);
    assert.equal(result.checkpoint.requestWaitMs, 6400);
    assert.equal(result.checkpoint.responseBytes, 512);
    assert.equal(result.observation.longTaskCount, 2);
    assert.equal(result.observation.longTaskTotalMs, 200);
    assert.equal(result.observation.longTaskMaxMs, 125);
  });

  it('measures the synchronous delta application without changing its result', () => {
    let now = 0;
    const ctx = loadSidebarOperations({ performance: { now: () => (now += 4) } });
    ctx.run(`allAgents = [{
      id: 'programming-helper',
      workspace_sessions: { revision: 1, activeSessionId: 'old', sessions: [{ id: 'old' }] }
    }]; beginSidebarOperation({
      operationId: 'summary:apply', kind: 'summary', type: 'replacement',
      phase: 'generating', agentId: 'programming-helper', sourceSessionId: 'old'
    });`);
    const applied = ctx.run(`applySidebarMutationDeltaWithDiagnostics('summary:apply', 'programming-helper', {
      revision: 2,
      sessionDelta: { revision: 2, activeSessionId: 'new', upsert: [{ id: 'new' }], remove: ['old'] }
    })`);
    assert.equal(applied, true);
    assert.deepEqual(Array.from(ctx.run('allAgents[0].workspace_sessions.sessions'), (item) => item.id), ['new']);
  });

  it('flushes a bounded client diagnostic batch without operation content', async () => {
    const requests = [];
    const ctx = loadSidebarOperations({
      navigator: {},
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      },
    });
    ctx.run(`beginSidebarOperation({
      operationId: 'summary:flush', kind: 'summary', type: 'replacement',
      phase: 'generating', agentId: 'programming-helper', sourceSessionId: 'source-1',
      projectDir: 'D:\\\\private', title: 'private title'
    })`);
    assert.equal(await ctx.run('flushSidebarDiagnosticEvents()'), 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/protoclaw/sidebar_diagnostics/events');
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.events.length, 1);
    assert.equal(JSON.stringify(body).includes('private title'), false);
    assert.equal(JSON.stringify(body).includes('D:\\\\private'), false);
  });

  it('applies a revisioned delta and rejects an older delta', () => {
    const ctx = loadSidebarOperations();
    ctx.run(`allAgents = [{
      id: 'programming-helper',
      active_workspace_session_id: 'old',
      workspace_sessions: {
        revision: 2,
        activeSessionId: 'old',
        sessions: [{ id: 'old', title: 'Old' }]
      }
    }]`);

    assert.equal(ctx.run(`applySessionMutationDelta('programming-helper', {
      revision: 3,
      sessionDelta: {
        revision: 3, activeSessionId: 'new',
        upsert: [{ id: 'new', title: 'New' }], remove: ['old']
      }
    })`), true);
    assert.equal(ctx.run(`allAgents[0].workspace_sessions.revision`), 3);
    assert.deepEqual(
      Array.from(ctx.run(`allAgents[0].workspace_sessions.sessions.map((s) => s.id)`)),
      ['new'],
    );

    assert.equal(ctx.run(`applySessionMutationDelta('programming-helper', {
      revision: 2,
      sessionDelta: {
        revision: 2, activeSessionId: 'old',
        upsert: [{ id: 'old', title: 'Stale' }], remove: ['new']
      }
    })`), false);
    assert.deepEqual(
      Array.from(ctx.run(`allAgents[0].workspace_sessions.sessions.map((s) => s.id)`)),
      ['new'],
    );

    assert.equal(ctx.run(`applySessionMutationDelta('programming-helper', {
      revision: 0,
      sessionDelta: {
        revision: 0, activeSessionId: 'legacy',
        upsert: [{ id: 'legacy', title: 'Zero revision' }], remove: ['new']
      }
    })`), false);
    assert.deepEqual(
      Array.from(ctx.run(`allAgents[0].workspace_sessions.sessions.map((s) => s.id)`)),
      ['new'],
    );
  });

  it('keeps an optimistic deletion removed when a newer full snapshot still contains it', () => {
    const ctx = loadSidebarOperations();
    const merged = ctx.run(`(() => {
      beginSidebarOperation({
        operationId: 'delete:one', type: 'delete', kind: 'delete', phase: 'committing',
        agentId: 'programming-helper', sourceSessionId: 'deleted'
      });
      return mergeWorkspaceSessionSnapshots(
        { revision: 5, activeSessionId: 'kept', sessions: [{ id: 'kept' }] },
        { revision: 6, activeSessionId: 'kept', sessions: [{ id: 'deleted' }, { id: 'kept' }] },
        'programming-helper'
      );
    })()`);
    assert.equal(merged.revision, 6);
    assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['kept']);
  });

  it('does not allow a lower-revision snapshot to overwrite local state', () => {
    const ctx = loadSidebarOperations();
    const merged = ctx.run(`mergeWorkspaceSessionSnapshots(
      { revision: 9, activeSessionId: 'new', sessions: [{ id: 'new' }] },
      { revision: 8, activeSessionId: 'old', sessions: [{ id: 'old' }] },
      'programming-helper'
    )`);
    assert.equal(merged.revision, 9);
    assert.deepEqual(Array.from(merged.sessions, (session) => session.id), ['new']);
  });

  it('retains a committed upsert across lagging snapshots until the server echoes it', () => {
    const ctx = loadSidebarOperations();
    ctx.run(`allAgents = [{
      id: 'programming-helper',
      workspace_sessions: { revision: 4, activeSessionId: 'old', sessions: [{ id: 'old' }] }
    }];
    applySessionMutationDelta('programming-helper', {
      revision: 5,
      sessionDelta: { revision: 5, activeSessionId: 'new', upsert: [{ id: 'new', title: 'New' }] }
    })`);

    // Light snapshot / agent_detail that still lacks the committed session must
    // not drop it from the merged list (placeholder vanishing then reappearing).
    const lagging = ctx.run(`mergeWorkspaceSessionSnapshots(
      allAgents[0].workspace_sessions,
      { revision: 5, activeSessionId: 'old', sessions: [{ id: 'old' }] },
      'programming-helper'
    )`);
    assert.deepEqual(Array.from(lagging.sessions, (session) => session.id), ['new', 'old']);

    // Once the server echoes the id, fresh fields win and the entry leaves the
    // pending registry (no duplicate retention on later merges).
    const echoed = ctx.run(`mergeWorkspaceSessionSnapshots(
      allAgents[0].workspace_sessions,
      { revision: 5, activeSessionId: 'new', sessions: [{ id: 'old' }, { id: 'new', title: 'New (server)' }] },
      'programming-helper'
    )`);
    assert.deepEqual(Array.from(echoed.sessions, (session) => session.id), ['old', 'new']);
    assert.equal(echoed.sessions.find((session) => session.id === 'new').title, 'New (server)');

    const settled = ctx.run(`mergeWorkspaceSessionSnapshots(
      allAgents[0].workspace_sessions,
      { revision: 6, activeSessionId: 'new', sessions: [{ id: 'old' }, { id: 'new', title: 'New (server)' }] },
      'programming-helper'
    )`);
    assert.deepEqual(Array.from(settled.sessions, (session) => session.id), ['old', 'new']);
  });

  it('keeps source-runtime observation out of session operation settlement', () => {
    const ctx = loadSidebarOperations();
    assert.equal(ctx.run("typeof settleSidebarSourceOperation"), 'undefined');
  });
});

describe('sidebar operation trace', () => {
  it('sanitizes operation ids and returns correlated phase timings', () => {
    const persisted = [];
    assert.equal(normalizeOperationId('  delete:abc / unsafe  '), 'delete:abcunsafe');
    const trace = createOperationTrace({
      operationId: 'create:trace',
      operation: 'create_session',
      agentId: 'programming-helper',
      sessionId: 'source-1',
      diagnosticWriter: (event) => persisted.push(event),
    });
    const phase = trace.mark('index_committed', {
      revision: 7,
      operationId: 'forged',
      phase: 'forged',
      elapsedMs: 999999,
    });
    assert.equal(phase.operationId, 'create:trace');
    assert.equal(phase.phase, 'index_committed');
    assert.equal(phase.revision, 7);
    assert.ok(phase.elapsedMs >= 0);
    assert.ok(phase.phaseDurationMs >= 0);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].kind, 'operation_phase');
    assert.equal(persisted[0].operationId, 'create:trace');
  });
});

describe('session index revision signature', () => {
  it('compares logical index content independently of property order and revision', () => {
    const first = sessionIndexContentSignature({
      revision: 4,
      activeSessionId: 'session-1',
      sessions: [{ id: 'session-1' }],
    });
    const second = sessionIndexContentSignature({
      sessions: [{ id: 'session-1' }],
      activeSessionId: 'session-1',
      revision: 99,
    });
    assert.equal(first, second);
  });
});
