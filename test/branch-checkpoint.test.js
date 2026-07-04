import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findMissingCheckpoints } from '../server/shared/session-access.js';

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
