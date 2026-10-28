import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findMissingCheckpoints } from '../server/shared/session-access.js';
import { buildBranchSnapshot, sessionSnapshotRevision } from '../server/routes/session-branch.js';
import { Agent } from '@agentdevjs/core';

it('branches a real Agent snapshot at a completed call boundary and restores it', async () => {
  const source = new Agent({ llm: { async chat() { return { content: 'done' }; } }, maxTurns: 1 });
  const branch = new Agent({ llm: { async chat() { return { content: 'branched' }; } }, maxTurns: 1 });
  try {
    await source.onCall('first');
    const first = await source.createSessionSnapshot('source');
    await source.onCall('second');
    const current = await source.createSessionSnapshot('source');
    const fork = buildBranchSnapshot(current, first.runtime.context.messages.length - 1, { sessionId: 'branch', live: true });
    assert.deepEqual(fork.runtime.context.messages, first.runtime.context.messages);
    assert.equal(fork.runtime.callIndex, first.runtime.callIndex);
    await branch.restoreSessionSnapshot(fork);
    await branch.onCall('third');
    assert.deepEqual(branch.getContext().getAll().filter(message => message.role === 'user').map(message => message.content), ['first', 'third']);
    assert.deepEqual(source.getContext().getAll().filter(message => message.role === 'user').map(message => message.content), ['first', 'second']);
  } finally {
    await Promise.all([source.dispose(), branch.dispose()]);
  }
});

it('branches a complete historical boundary with matching feature state, not state before the retained turn', () => {
  const messages = [{ role: 'user', turn: 0, content: 'image', images: [{ base64: 'abc' }] }, { role: 'assistant', turn: 0, content: 'done' }, { role: 'user', turn: 1, content: 'running' }];
  const snapshot = {
    runtime: { callIndex: 1, callState: 'running', featureStates: [{ name: 'later' }],
      context: { messages, enrichedMessages: messages, generation: 0 } },
    rollbackHistory: [{ kind: 'context-boundary', callIndex: 1,
      contextBoundary: { messagesLength: 2, enrichedMessagesLength: 2, sequence: 2, generation: 0 },
      runtimeState: { callIndex: 0, initialized: true, featureStates: [{ name: 'at-boundary' }] } }],
  };
  const branch = buildBranchSnapshot(snapshot, 1, { sessionId: 'new', live: true });
  assert.deepEqual(branch.runtime.context.messages, messages.slice(0, 2));
  assert.deepEqual(branch.runtime.featureStates, [{ name: 'at-boundary' }]);
  assert.equal(branch.runtime.callIndex, 0);
  assert.deepEqual(branch.rollbackHistory, []);
  assert.equal(snapshot.runtime.callState, 'running', 'branch must not alter the running source');
  assert.throws(() => buildBranchSnapshot(snapshot, 2, { live: true }), { code: 'branch_boundary_unavailable' });
  assert.throws(() => buildBranchSnapshot(snapshot, 0, { live: true }), { code: 'branch_boundary_unavailable' });
});

it('keeps named checkpoints within the branched history and drops those beyond it', () => {
  const snapshot = { runtime: { callIndex: 2, callState: 'idle',
      context: { messages: [{ role: 'assistant', content: 'done' }], enrichedMessages: [], sequence: 1 } },
    rollbackHistory: [],
    namedCheckpoints: [
      { id: 'within', sourceCallIndex: 1 },
      { id: 'at-boundary', sourceCallIndex: 2 },
      { id: 'beyond', sourceCallIndex: 3 },
    ] };
  const branch = buildBranchSnapshot(snapshot, 0);
  assert.deepEqual(branch.namedCheckpoints.map(cp => cp.id), ['within', 'at-boundary']);
});

it('copies an idle final snapshot exactly, and refuses an unproven live legacy tail', () => {
  const snapshot = { runtime: { callIndex: 3, callState: 'idle', featureStates: [{ name: 'final' }],
    context: { messages: [{ role: 'assistant', content: 'done' }], enrichedMessages: [], sequence: 4 } }, rollbackHistory: [] };
  assert.deepEqual(buildBranchSnapshot(snapshot, 0, { live: true }).runtime.featureStates, snapshot.runtime.featureStates);
  delete snapshot.runtime.callState;
  assert.throws(() => buildBranchSnapshot(snapshot, 0, { live: true }), { code: 'branch_boundary_unavailable' });
  assert.equal(buildBranchSnapshot(snapshot, 0).runtime.callIndex, 3);
  assert.notEqual(sessionSnapshotRevision(JSON.stringify(snapshot)), sessionSnapshotRevision(JSON.stringify({ ...snapshot, savedAt: 2 })));
});

describe('Branch checkpoint integrity validation', () => {
  it('returns empty when all user turns have matching checkpoints', () => {
    const messages = [
      { role: 'user', turn: 0 },
      { role: 'assistant', turn: 0 },
      { role: 'user', turn: 1 },
    ];
    const checkpoints = [
      { callIndex: 0 },
      { callIndex: 1 },
    ];
    assert.deepEqual(findMissingCheckpoints(messages, checkpoints), []);
  });

  it('detects user turns without matching checkpoints', () => {
    const messages = [
      { role: 'user', turn: 0 },
      { role: 'user', turn: 1 },
      { role: 'user', turn: 2 },
    ];
    const checkpoints = [{ callIndex: 0 }];
    assert.deepEqual(findMissingCheckpoints(messages, checkpoints), [1, 2]);
  });

  it('ignores non-user messages when collecting turns', () => {
    const messages = [
      { role: 'assistant', turn: 0 },
      { role: 'tool', turn: 0 },
      { role: 'system', turn: 1 },
    ];
    const checkpoints = [];
    assert.deepEqual(findMissingCheckpoints(messages, checkpoints), []);
  });

  it('ignores user messages without numerical turn', () => {
    const messages = [
      { role: 'user', turn: 0 },
      { role: 'user' },
      { role: 'user', turn: 'abc' },
    ];
    const checkpoints = [{ callIndex: 0 }];
    assert.deepEqual(findMissingCheckpoints(messages, checkpoints), []);
  });

  it('handles empty inputs', () => {
    assert.deepEqual(findMissingCheckpoints([], []), []);
  });

  it('reports missing when checkpoints empty but user turns exist', () => {
    const messages = [{ role: 'user', turn: 0 }];
    const checkpoints = [];
    assert.deepEqual(findMissingCheckpoints(messages, checkpoints), [0]);
  });

  it('handles duplicate user turns', () => {
    const messages = [
      { role: 'user', turn: 1 },
      { role: 'assistant', turn: 1 },
      { role: 'user', turn: 1 },
    ];
    const checkpoints = [{ callIndex: 0 }, { callIndex: 1 }];
    // turn=1 has a matching checkpoint (callIndex=1), so no missing
    assert.deepEqual(findMissingCheckpoints(messages, checkpoints), []);
  });
});
