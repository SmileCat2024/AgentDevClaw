import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadLifecycleService } from '../server/thread-control/thread-lifecycle.js';

function makeFixture(overrides = {}) {
  const calls = [];
  const thread = {
    threadId: 'thread-1',
    agentId: 'programming-helper',
    rootSessionId: 'session-1',
    headSessionId: 'session-2',
    sessionChain: [
      { sessionId: 'session-1' },
      { sessionId: 'session-2' },
    ],
    commands: [
      { commandId: 'cmd-pending', status: 'pending' },
      { commandId: 'cmd-delivered', status: 'delivered' },
    ],
    status: 'open',
  };
  const core = {
    async getThread(threadId) {
      calls.push(['getThread', threadId]);
      return threadId === thread.threadId ? thread : null;
    },
    async setHold(threadId, held) {
      calls.push(['setHold', threadId, held]);
      return thread;
    },
    async cancelCommand(threadId, commandId) {
      calls.push(['cancelCommand', threadId, commandId]);
      return { status: 'cancelled' };
    },
  };
  const board = {
    async closeBoard(threadId, options) {
      calls.push(['closeBoard', threadId, options]);
    },
    async reopenBoard(threadId, options) {
      calls.push(['reopenBoard', threadId, options]);
    },
  };
  const archive = {
    async archive(threadId, options) {
      calls.push(['archive', threadId, options]);
      return { archivedAt: 100, cleanup: options.cleanup };
    },
    async unarchive(threadId) {
      calls.push(['unarchive', threadId]);
    },
  };
  return {
    calls,
    thread,
    service: createThreadLifecycleService({
      control: { core, board, archive },
      interruptSession: async (agentId, sessionId) => {
        calls.push(['interrupt', agentId, sessionId]);
        return { status: 'interrupted' };
      },
      stopSession: async (agentId, sessionId) => {
        calls.push(['stopSession', agentId, sessionId]);
        return { status: 'stopped' };
      },
      ...overrides,
    }),
  };
}

describe('ThreadLifecycle archive transaction', () => {
  it('interrupts head, cancels pending commands, stops every session, and closes board', async () => {
    const { service, calls } = makeFixture();
    const result = await service.archiveThread('thread-1', { reason: 'test' });

    assert.equal(result.cleanup.status, 'complete');
    assert.equal(result.cleanup.commandsCancelled, 1);
    assert.deepEqual(result.cleanup.sessions.map((entry) => entry.sessionId), ['session-1', 'session-2']);
    assert.deepEqual(calls.map((entry) => entry[0]), [
      'getThread', 'archive', 'setHold', 'interrupt', 'cancelCommand',
      'stopSession', 'stopSession', 'closeBoard', 'archive',
    ]);
  });

  it('records partial cleanup when one runtime cannot be stopped', async () => {
    const { service } = makeFixture({
      stopSession: async (_agentId, sessionId) => {
        if (sessionId === 'session-2') throw new Error('stop timeout');
        return { status: 'stopped' };
      },
    });
    const result = await service.archiveThread('thread-1');

    assert.equal(result.cleanup.status, 'partial');
    assert.deepEqual(result.cleanup.failures, [
      { stage: 'stop_runtime', sessionId: 'session-2', error: 'stop timeout' },
    ]);
  });

  it('unarchives without starting a runtime and reopens the board', async () => {
    const { service, calls } = makeFixture();
    const result = await service.unarchiveThread('thread-1');

    assert.equal(result.runtimeStarted, false);
    assert.deepEqual(calls.map((entry) => entry[0]), [
      'getThread', 'unarchive', 'setHold', 'reopenBoard',
    ]);
  });
});
