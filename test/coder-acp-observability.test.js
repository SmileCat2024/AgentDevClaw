/** Prompt lifecycle evidence tests for coder ACP diagnostics. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionManager } from '../scripts/coder-acp/session-manager.js';
import { ClawHttpError } from '../scripts/coder-acp/claw-client.js';
import { ERROR_CODES } from '../scripts/coder-acp/protocol.js';

function makeTrace() {
  const records = [];
  return {
    records,
    record(event, fields) { records.push({ event, ...fields }); },
    registerSession() {},
  };
}

function makeClient({ pages = [], eventsError = null, commandError = null } = {}) {
  const state = [...pages];
  return {
    async createCoderSession() {
      return { ok: true, clawSessionId: 'claw-observe', threadId: 'thread-observe', viewerAgentId: 'runtime-observe' };
    },
    async appendUserMessage() {
      if (commandError) throw commandError;
      return { ok: true, commandId: 'command-observe' };
    },
    async getThreadEvents() {
      if (eventsError && state.length === 0) throw eventsError;
      return state.length > 0 ? state.shift() : { events: [], cursor: 0 };
    },
    async interruptSession() {
      return { ok: true };
    },
  };
}

async function makeManager(client, trace, extra = {}) {
  const manager = createSessionManager({
    clawClient: client,
    trace,
    pollIntervalMs: 2,
    promptTimeoutMs: 0,
    log: { info() {}, warn() {}, error() {} },
    ...extra,
  });
  const { sessionId } = await manager.createSession('C:/work');
  return { manager, sessionId };
}

describe('coder ACP prompt observability', () => {
  it('records terminal evidence for timeout, cancel, server error, and adapter exception', async () => {
    const timeoutTrace = makeTrace();
    const timeout = await makeManager(makeClient(), timeoutTrace, { promptTimeoutMs: 8 });
    await assert.rejects(timeout.manager.runPrompt(timeout.sessionId, 'wait', { onUpdate() {} }), (error) => error.code === ERROR_CODES.PROMPT_TIMEOUT);
    const timeoutRecord = timeoutTrace.records.find((record) => record.event === 'acp.prompt.timeout');
    assert.ok(timeoutRecord);
    assert.equal(timeoutRecord.lastKnownState, 'timeout');

    const cancelTrace = makeTrace();
    const cancel = await makeManager(makeClient(), cancelTrace);
    const cancelled = cancel.manager.runPrompt(cancel.sessionId, 'cancel', { onUpdate() {} });
    await new Promise((resolve) => setTimeout(resolve, 8));
    cancel.manager.cancel(cancel.sessionId);
    assert.deepEqual(await cancelled, { stopReason: 'cancelled' });
    assert.ok(cancelTrace.records.some((record) => record.event === 'acp.prompt.cancel_requested'));
    assert.ok(cancelTrace.records.some((record) => record.event === 'acp.prompt.interrupt_delivered'));

    const serverTrace = makeTrace();
    const server = await makeManager(makeClient({
      pages: [{ events: [], cursor: 0 }],
      eventsError: new ClawHttpError(503, { ok: false, code: 'runtime_unavailable' }),
    }), serverTrace);
    await assert.rejects(server.manager.runPrompt(server.sessionId, 'server', { onUpdate() {} }), (error) => error.code === ERROR_CODES.CLAW_ERROR);
    const serverError = serverTrace.records.find((record) => record.event === 'acp.events.poll_error');
    assert.equal(serverError.errorCode, 'runtime_unavailable');
    assert.equal(serverError.lastKnownState, 'command_accepted');

    const adapterTrace = makeTrace();
    const adapter = await makeManager(makeClient({
      pages: [
        { events: [], cursor: 0 },
        { events: [{ type: 'item.completed', item: { type: 'agent_message', text: 'done' }, eventId: 'event-1' }], cursor: 1 },
      ],
    }), adapterTrace);
    await assert.rejects(adapter.manager.runPrompt(adapter.sessionId, 'adapter', {
      onUpdate() { throw new Error('client notification failed'); },
    }), /client notification failed/);
    const adapterError = adapterTrace.records.find((record) => record.event === 'acp.prompt.error');
    // 回显（首个 onUpdate）现在发生在 prompt_received 阶段：client 通知通道
    // 故障在回显时即 surfaced，早于命令投递
    assert.equal(adapterError.lastKnownState, 'prompt_received');
  });
});
