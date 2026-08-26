/**
 * Tests for scripts/capability-ipc.js — the runtime-side endpoint of the
 * capability control plane (capability-invoke / capability-list-request).
 *
 * Covers:
 * 1. list request delegates to getCapabilitySnapshot with the entryPoint filter
 * 2. list request defaults the entryPoint to slash
 * 3. invoke delegates ref/args with the slash entry point (host-forwarded trigger)
 * 4. registry rejection (entry_point_denied etc.) passes through unchanged
 * 5. missing registry on the session answers a structured error
 * 6. thrown errors are converted to structured failures, not crashes
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleCapabilityIPC } from '../scripts/capability-ipc.js';

function createMockAgent(overrides = {}) {
  const calls = { invoke: [], snapshot: [] };
  return {
    calls,
    invokeCapability: async (ref, args, entryPoint) => {
      calls.invoke.push({ ref, args, entryPoint });
      if (overrides.invoke) return overrides.invoke(ref, args, entryPoint);
      return { ok: true, result: { done: true } };
    },
    getCapabilitySnapshot: async (filter) => {
      calls.snapshot.push(filter);
      if (overrides.snapshot) return overrides.snapshot(filter);
      return [{ name: 'force-continuation.configure', description: 'configure' }];
    },
  };
}

function createReplyCollector() {
  const replies = [];
  return {
    replies,
    reply: (payload) => replies.push(payload),
  };
}

describe('handleCapabilityIPC', () => {
  it('list request delegates to getCapabilitySnapshot with the entryPoint filter', async () => {
    const agent = createMockAgent();
    const { replies, reply } = createReplyCollector();

    await handleCapabilityIPC({ agent, sessionId: 's1' }, { type: 'capability-list-request', entryPoint: 'slash' }, reply);

    assert.deepEqual(agent.calls.snapshot, [{ entryPoint: 'slash' }]);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].ok, true);
    assert.deepEqual(replies[0].commands, [{ name: 'force-continuation.configure', description: 'configure' }]);
  });

  it('list request defaults the entryPoint to slash', async () => {
    const agent = createMockAgent();
    const { reply } = createReplyCollector();

    await handleCapabilityIPC({ agent, sessionId: 's1' }, { type: 'capability-list-request' }, reply);

    assert.deepEqual(agent.calls.snapshot, [{ entryPoint: 'slash' }]);
  });

  it('invoke delegates ref/args with the slash entry point', async () => {
    const agent = createMockAgent();
    const { replies, reply } = createReplyCollector();
    const args = { enabled: true, maxConsecutive: 3 };

    await handleCapabilityIPC({ agent, sessionId: 's1' }, { type: 'capability-invoke', ref: 'force-continuation.configure', args }, reply);

    assert.deepEqual(agent.calls.invoke, [{ ref: 'force-continuation.configure', args, entryPoint: 'slash' }]);
    assert.deepEqual(replies[0], { ok: true, result: { done: true } });
  });

  it('passes registry rejections through unchanged', async () => {
    const agent = createMockAgent({
      invoke: () => ({ ok: false, code: 'entry_point_denied', message: 'not available via slash' }),
    });
    const { replies, reply } = createReplyCollector();

    await handleCapabilityIPC({ agent, sessionId: 's1' }, { type: 'capability-invoke', ref: 'internal.cmd' }, reply);

    assert.deepEqual(replies[0], { ok: false, code: 'entry_point_denied', message: 'not available via slash' });
  });

  it('answers a structured error when the session has no registry', async () => {
    const { replies, reply } = createReplyCollector();

    await handleCapabilityIPC({ agent: null, sessionId: 's1' }, { type: 'capability-invoke', ref: 'x.y' }, reply);
    await handleCapabilityIPC({ agent: {}, sessionId: 's1' }, { type: 'capability-list-request' }, reply);

    assert.equal(replies.length, 2);
    for (const r of replies) {
      assert.equal(r.ok, false);
      assert.match(r.error, /capability registry not available/);
    }
  });

  it('converts thrown errors to structured failures', async () => {
    const agent = {
      invokeCapability: async () => { throw new Error('boom'); },
      getCapabilitySnapshot: async () => [],
    };
    const { replies, reply } = createReplyCollector();

    await handleCapabilityIPC({ agent, sessionId: 's1' }, { type: 'capability-invoke', ref: 'x.y' }, reply);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].ok, false);
    assert.match(replies[0].error, /boom/);
  });
});
