/**
 * Tests for scripts/coder-acp/event-mapper.js (ticket 019, design §7 / §12)
 *
 * Covers:
 * - §7 mapping table, every row:
 *   item.completed(agent_message) → agent_message_chunk (whole message, messageId)
 *   item.started(tool_call)       → tool_call (in_progress, rawInput only if present)
 *   item.completed(tool_call)     → tool_call_update (failed→failed, rawOutput only if present)
 *   item.completed(reasoning)     → agent_thought_chunk (codex-acp style, empty text skipped)
 *   turn.completed/failed/cancelled → terminal (no update; completed/failed carry usage)
 * - missing-field rules: missing item.id → fallback `tool:<name>:<turn>:<seq>`;
 *   completed-only tool call → minimal tool_call emitted first; rawInput/rawOutput
 *   omitted when absent (never fabricated)
 * - eventId dedup: second occurrence skipped
 * - unknown event types ignored
 * - classifyToolKind minimal classification (§7 / Q18)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyToolKind, createPromptEventMapper } from '../scripts/coder-acp/event-mapper.js';

function agentMessageEvent(overrides = {}) {
  return {
    type: 'item.completed',
    eventId: 'ev-1',
    item: { id: 'item_1', turn: 3, type: 'agent_message', text: 'hello world' },
    ...overrides,
  };
}

function toolStartedEvent(overrides = {}) {
  return {
    type: 'item.started',
    eventId: 'ev-2',
    item: {
      id: 'call_1', turn: 3, type: 'tool_call', tool: 'bash',
      arguments: { command: 'ls' }, status: 'in_progress',
    },
    ...overrides,
  };
}

function toolCompletedEvent(overrides = {}) {
  return {
    type: 'item.completed',
    eventId: 'ev-3',
    item: {
      id: 'call_1', turn: 3, type: 'tool_call', tool: 'bash',
      arguments: { command: 'ls' }, status: 'completed', result: 'file-a\nfile-b',
    },
    ...overrides,
  };
}

describe('classifyToolKind', () => {
  it('maps shell-family tool names to execute', () => {
    assert.equal(classifyToolKind('bash'), 'execute');
    assert.equal(classifyToolKind('shell'), 'execute');
    assert.equal(classifyToolKind('exec'), 'execute');
    assert.equal(classifyToolKind('powershell'), 'execute');
  });

  it('maps read-family tool names (incl. lsp_* prefix) to read', () => {
    assert.equal(classifyToolKind('read'), 'read');
    assert.equal(classifyToolKind('glob'), 'read');
    assert.equal(classifyToolKind('grep'), 'read');
    assert.equal(classifyToolKind('lsp_go_to_definition'), 'read');
    assert.equal(classifyToolKind('lsp_hover'), 'read');
  });

  it('maps write/edit to edit', () => {
    assert.equal(classifyToolKind('write'), 'edit');
    assert.equal(classifyToolKind('edit'), 'edit');
  });

  it('maps web/search-containing names to search', () => {
    assert.equal(classifyToolKind('web_fetch'), 'search');
    assert.equal(classifyToolKind('websearch'), 'search');
    assert.equal(classifyToolKind('search_code'), 'search');
  });

  it('maps everything else to other', () => {
    assert.equal(classifyToolKind('task'), 'other');
    assert.equal(classifyToolKind('todo_write'), 'other');
    assert.equal(classifyToolKind(''), 'other');
    assert.equal(classifyToolKind(undefined), 'other');
  });
});

describe('createPromptEventMapper — §7 mapping table', () => {
  it('maps item.completed(agent_message) to a single agent_message_chunk', () => {
    const mapper = createPromptEventMapper();
    const { updates, terminal } = mapper.mapBatch([agentMessageEvent()]);
    assert.equal(terminal, null);
    assert.deepEqual(updates, [{
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello world' },
      messageId: 'item_1',
    }]);
  });

  it('omits messageId when the agent_message item has no id', () => {
    const mapper = createPromptEventMapper();
    const { updates } = mapper.mapBatch([agentMessageEvent({ item: { turn: 1, type: 'agent_message', text: 'hi' } })]);
    assert.equal(updates.length, 1);
    assert.equal('messageId' in updates[0], false);
  });

  it('maps item.started(tool_call) to tool_call with in_progress + rawInput only if present', () => {
    const mapper = createPromptEventMapper();
    const { updates } = mapper.mapBatch([toolStartedEvent()]);
    assert.deepEqual(updates, [{
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'bash',
      name: 'bash',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'ls' },
    }]);

    const noArgs = createPromptEventMapper();
    const { updates: bare } = noArgs.mapBatch([
      toolStartedEvent({ item: { id: 'call_2', turn: 1, type: 'tool_call', tool: 'read', status: 'in_progress' } }),
    ]);
    assert.equal(bare[0].kind, 'read');
    assert.equal('rawInput' in bare[0], false);
  });

  it('maps item.completed(tool_call) to tool_call_update; failed status kept; rawOutput omitted when absent', () => {
    const mapper = createPromptEventMapper();
    // started seen first, so no minimal tool_call is injected
    mapper.mapBatch([toolStartedEvent()]);
    const { updates } = mapper.mapBatch([toolCompletedEvent()]);
    assert.deepEqual(updates, [{
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput: 'file-a\nfile-b',
    }]);

    const failed = createPromptEventMapper();
    failed.mapBatch([toolStartedEvent({ item: { id: 'call_9', turn: 1, type: 'tool_call', tool: 'bash', status: 'in_progress' } })]);
    const { updates: failedUpdates } = failed.mapBatch([
      toolCompletedEvent({
        item: { id: 'call_9', turn: 1, type: 'tool_call', tool: 'bash', status: 'failed', error: 'boom' },
      }),
    ]);
    assert.equal(failedUpdates[0].status, 'failed');
    assert.equal(failedUpdates[0].rawOutput, 'boom');

    const noResult = createPromptEventMapper();
    noResult.mapBatch([toolStartedEvent({ item: { id: 'call_a', turn: 1, type: 'tool_call', tool: 'bash', status: 'in_progress' } })]);
    const { updates: bare } = noResult.mapBatch([
      toolCompletedEvent({ item: { id: 'call_a', turn: 1, type: 'tool_call', tool: 'bash', status: 'completed' } }),
    ]);
    assert.equal('rawOutput' in bare[0], false);
  });

  it('emits a minimal tool_call before tool_call_update when only completed arrives', () => {
    const mapper = createPromptEventMapper();
    const { updates } = mapper.mapBatch([toolCompletedEvent()]);
    assert.equal(updates.length, 2);
    // minimal tool_call first: in_progress, no rawInput fabricated from the completed item
    assert.deepEqual(updates[0], {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'bash',
      name: 'bash',
      kind: 'execute',
      status: 'in_progress',
    });
    assert.deepEqual(updates[1], {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput: 'file-a\nfile-b',
    });
  });

  it('maps item.completed(reasoning) to agent_thought_chunk; empty text skipped; item.started(reasoning) not mapped', () => {
    const mapper = createPromptEventMapper();
    const { updates } = mapper.mapBatch([
      { type: 'item.completed', item: { id: 'r1', turn: 1, type: 'reasoning', text: 'thinking...' }, eventId: 'c' },
      { type: 'item.completed', item: { id: 'r2', turn: 1, type: 'reasoning', text: '' }, eventId: 'c2' },
      { type: 'item.started', item: { id: 'r3', turn: 1, type: 'reasoning', text: 'hmm' }, eventId: 'd' },
    ]);
    assert.deepEqual(updates, [{
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking...' },
      messageId: 'r1',
    }]);
  });

  it('does not map turn.started or thread.started', () => {
    const mapper = createPromptEventMapper();
    const { updates, terminal } = mapper.mapBatch([
      { type: 'thread.started', threadId: 't', eventId: 'a' },
      { type: 'turn.started', turn: 1, eventId: 'b' },
    ]);
    assert.deepEqual(updates, []);
    assert.equal(terminal, null);
  });

  it('returns terminal for turn.completed / turn.failed / turn.cancelled without updates', () => {
    const mapper = createPromptEventMapper();
    const completed = mapper.mapBatch([{ type: 'turn.completed', turn: 5, usage: { totalTokens: 1 }, eventId: 'x' }]);
    assert.deepEqual(completed.terminal, { kind: 'completed', turn: 5, usage: { totalTokens: 1 } });
    assert.deepEqual(completed.updates, []);

    const noUsage = mapper.mapBatch([{ type: 'turn.completed', turn: 5, eventId: 'x2' }]);
    assert.equal(noUsage.terminal.usage, null);

    const failed = mapper.mapBatch([
      { type: 'turn.failed', turn: 6, error: { message: 'boom', category: 'runtime' }, usage: { totalTokens: 2 }, eventId: 'y' },
    ]);
    assert.equal(failed.terminal.kind, 'failed');
    assert.equal(failed.terminal.error.message, 'boom');
    assert.deepEqual(failed.terminal.usage, { totalTokens: 2 });

    const cancelled = mapper.mapBatch([
      { type: 'turn.cancelled', turn: null, error: { message: 'interrupted' }, eventId: 'z' },
    ]);
    assert.deepEqual(cancelled.terminal, { kind: 'cancelled', turn: null, error: { message: 'interrupted' } });
  });

  it('stops at the first terminal event in a batch', () => {
    const mapper = createPromptEventMapper();
    const { updates, terminal } = mapper.mapBatch([
      agentMessageEvent(),
      { type: 'turn.completed', turn: 3, eventId: 'ev-t' },
      agentMessageEvent({ eventId: 'ev-after' }),
    ]);
    assert.equal(terminal.kind, 'completed');
    // events after the terminal are not mapped
    assert.equal(updates.length, 1);
  });

  it('ignores unknown event types', () => {
    const mapper = createPromptEventMapper();
    const { updates, terminal } = mapper.mapBatch([
      { type: 'something.new', eventId: 'n1' },
      { eventId: 'n2' },
    ]);
    assert.deepEqual(updates, []);
    assert.equal(terminal, null);
  });
});

describe('createPromptEventMapper — missing-field fallback id', () => {
  it('generates stable-shaped fallback ids tool:<name>:<turn>:<seq> for id-less tool items', () => {
    const mapper = createPromptEventMapper();
    const { updates } = mapper.mapBatch([
      toolCompletedEvent({ eventId: 'f1', item: { turn: 4, type: 'tool_call', tool: 'grep', status: 'completed', result: 'x' } }),
      toolCompletedEvent({ eventId: 'f2', item: { turn: 4, type: 'tool_call', tool: 'bash', status: 'completed' } }),
    ]);
    const call1 = updates[0]; // minimal tool_call for the first
    assert.equal(call1.toolCallId, 'tool:grep:4:1');
    assert.equal(updates[1].toolCallId, 'tool:grep:4:1'); // its update pairs on the same id
    const call2 = updates[2];
    // seq counts per (name, turn): different tool names get independent counters
    assert.equal(call2.toolCallId, 'tool:bash:4:1');
  });

  it('reuses the last fallback seq for repeated completed-only id-less calls (no started in between)', () => {
    const mapper = createPromptEventMapper();
    const { updates } = mapper.mapBatch([
      toolCompletedEvent({ eventId: 'g1', item: { turn: 4, type: 'tool_call', tool: 'bash', status: 'completed' } }),
      toolCompletedEvent({ eventId: 'g2', item: { turn: 4, type: 'tool_call', tool: 'bash', status: 'completed' } }),
    ]);
    // first: minimal tool_call + update on seq 1
    assert.equal(updates[0].toolCallId, 'tool:bash:4:1');
    assert.equal(updates[1].toolCallId, 'tool:bash:4:1');
    // second completed-only without a new started reuses seq 1 (id already seen →
    // no extra minimal tool_call, just another update on the same id)
    assert.equal(updates[2].sessionUpdate, 'tool_call_update');
    assert.equal(updates[2].toolCallId, 'tool:bash:4:1');
    assert.equal(updates.length, 3);
  });

  it('assigns a fresh seq when a new id-less started intervenes for the same (name, turn)', () => {
    const mapper = createPromptEventMapper();
    const started1 = mapper.mapBatch([
      { type: 'item.started', eventId: 'h1', item: { turn: 4, type: 'tool_call', tool: 'bash', status: 'in_progress' } },
    ]);
    const completed1 = mapper.mapBatch([
      { type: 'item.completed', eventId: 'h2', item: { turn: 4, type: 'tool_call', tool: 'bash', status: 'completed' } },
    ]);
    const started2 = mapper.mapBatch([
      { type: 'item.started', eventId: 'h3', item: { turn: 4, type: 'tool_call', tool: 'bash', status: 'in_progress' } },
    ]);
    const completed2 = mapper.mapBatch([
      { type: 'item.completed', eventId: 'h4', item: { turn: 4, type: 'tool_call', tool: 'bash', status: 'completed' } },
    ]);
    assert.equal(started1.updates[0].toolCallId, 'tool:bash:4:1');
    assert.equal(completed1.updates[0].toolCallId, 'tool:bash:4:1');
    assert.equal(started2.updates[0].toolCallId, 'tool:bash:4:2');
    assert.equal(completed2.updates[0].toolCallId, 'tool:bash:4:2');
    assert.equal(completed2.updates.length, 1); // paired: no minimal tool_call injected
  });

  it('pairs started/completed tool items on the same fallback id within one prompt', () => {
    const mapper = createPromptEventMapper();
    const started = mapper.mapBatch([
      { type: 'item.started', item: { turn: 2, type: 'tool_call', tool: 'edit', status: 'in_progress' }, eventId: 's1' },
    ]);
    const completed = mapper.mapBatch([
      { type: 'item.completed', item: { turn: 2, type: 'tool_call', tool: 'edit', status: 'completed', result: 1 }, eventId: 'c1' },
    ]);
    assert.equal(started.updates[0].toolCallId, 'tool:edit:2:1');
    // completed saw the started via seenToolCallIds → no minimal injection, ids still match
    assert.equal(completed.updates.length, 1);
    assert.equal(completed.updates[0].toolCallId, 'tool:edit:2:1');
  });
});

describe('createPromptEventMapper — eventId dedup', () => {
  it('skips events whose eventId was in the baseline or already processed', () => {
    const mapper = createPromptEventMapper(['ev-base']);
    const first = mapper.mapBatch([
      { type: 'ev-x', eventId: 'ev-base' }, // baseline duplicate
      agentMessageEvent(), // ev-1 → processed
    ]);
    assert.equal(first.updates.length, 1);

    const second = mapper.mapBatch([
      agentMessageEvent(), // ev-1 again → duplicate, skipped
      agentMessageEvent({ eventId: 'ev-new', item: { id: 'i2', turn: 3, type: 'agent_message', text: 'second' } }),
    ]);
    assert.equal(second.duplicatesSkipped, 1);
    assert.equal(second.updates.length, 1);
    assert.equal(second.updates[0].content.text, 'second');
  });

  it('processes events without eventId (no dedup possible)', () => {
    const mapper = createPromptEventMapper();
    const noId = { type: 'item.completed', item: { id: 'm1', turn: 1, type: 'agent_message', text: 'x' } };
    const first = mapper.mapBatch([noId]);
    const second = mapper.mapBatch([noId]);
    assert.equal(first.updates.length, 1);
    assert.equal(second.updates.length, 1);
  });
});
