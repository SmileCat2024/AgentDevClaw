/**
 * Tests for ViewerWorker user-turn queued delivery / dequeue-input HTTP endpoints.
 *
 * The mailbox (queuedInputs) has a single production write path:
 * POST /user-turn → submitUserTurn → no inputLease → enqueueQueuedInput.
 * (The legacy standalone queue-input endpoint was removed 2026-08; every
 * new-turn producer must go through user-turn arbitration.)
 *
 * Validates the fix for the "useArbiterQueue dead zone" bug:
 * - queued delivery must NOT set session.useArbiterQueue
 * - handleDequeueInput must NOT gate on useArbiterQueue
 * - dequeue always returns queued items in FIFO order
 * - image inputs survive the round-trip
 *
 * Uses the real ViewerWorker class from agentdev (via junction or published).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ── Pick a random port to avoid collisions ──
const TEST_PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const AGENT_ID = 'test-queued-input-agent';
const CLIENT_ID = 'fake-client-id';

let viewerWorker = null;

async function httpPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function httpGet(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, data: await res.json() };
}

/** Enqueue one item through the real user-turn endpoint (queued delivery). */
async function queueViaUserTurn(text, images) {
  return httpPost(`/api/agents/${AGENT_ID}/user-turn`, images ? { text, images } : { text });
}

describe('ViewerWorker user-turn queued mailbox', () => {
  before(async () => {
    const { ViewerWorker } = await import('@agentdevjs/viewer');
    viewerWorker = new ViewerWorker(TEST_PORT, false);
    await viewerWorker.start();

    // Register a fake agent session directly so user-turn/dequeue routes find
    // it. submitUserTurn requires a connected session (isSessionConnected
    // checks udsClients.has(clientId)), so also register a stub UDS entry —
    // queued delivery never touches the socket itself.
    viewerWorker.agentSessions.set(AGENT_ID, {
      agentId: AGENT_ID,
      messages: [],
      logs: [],
      queuedInputs: [],
      clientId: CLIENT_ID,
    });
    viewerWorker.udsClients.set(CLIENT_ID, { write() {} });
  });

  after(async () => {
    if (viewerWorker) {
      viewerWorker.udsClients.delete(CLIENT_ID);
      await viewerWorker.stop();
    }
  });

  // ── user-turn queued delivery ──

  it('user-turn queues text input when no lease is held', async () => {
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    const { status, data } = await queueViaUserTurn('hello world');
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(data.delivery, 'queued', 'no lease held → delivery must be queued');
    assert.ok(data.id, 'should return an id');
    assert.equal(data.queueLength, 1);
  });

  it('user-turn queues input with images', async () => {
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    const { status, data } = await queueViaUserTurn('look at this', [
      { base64: 'iVBOR...', mediaType: 'image/png' },
    ]);
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(data.delivery, 'queued');
    assert.equal(data.queueLength, 1);
  });

  it('user-turn rejects missing text', async () => {
    const { status, data } = await httpPost(
      `/api/agents/${AGENT_ID}/user-turn`,
      { images: [] },
    );
    assert.equal(status, 400);
    assert.equal(data.code, 'invalid_input');
  });

  it('user-turn returns 404 for unknown agent', async () => {
    const { status, data } = await httpPost(
      `/api/agents/nonexistent-agent/user-turn`,
      { text: 'test' },
    );
    assert.equal(status, 404);
    assert.equal(data.code, 'agent_not_found');
  });

  it('queued delivery does NOT set session.useArbiterQueue', async () => {
    // Clear queue and add a fresh input
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];
    session.useArbiterQueue = undefined; // reset

    await queueViaUserTurn('trigger');

    assert.equal(
      session.useArbiterQueue,
      undefined,
      'useArbiterQueue must NOT be set by queued delivery',
    );
  });

  // ── handleDequeueInput ──

  it('handleDequeueInput returns null when queue is empty', async () => {
    // Ensure queue is empty
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    const { status, data } = await httpPost(
      `/api/agents/${AGENT_ID}/dequeue-input`,
      {},
    );
    assert.equal(status, 200);
    assert.equal(data.input, null);
  });

  it('handleDequeueInput returns queued text in FIFO order', async () => {
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    // Queue two items
    await queueViaUserTurn('first');
    await queueViaUserTurn('second');

    // Dequeue first
    const r1 = await httpPost(`/api/agents/${AGENT_ID}/dequeue-input`, {});
    assert.equal(r1.status, 200);
    assert.equal(r1.data.input.text, 'first');
    assert.equal(r1.data.remaining, 1);

    // Dequeue second
    const r2 = await httpPost(`/api/agents/${AGENT_ID}/dequeue-input`, {});
    assert.equal(r2.status, 200);
    assert.equal(r2.data.input.text, 'second');
    assert.equal(r2.data.remaining, 0);

    // Queue should now be empty
    const r3 = await httpPost(`/api/agents/${AGENT_ID}/dequeue-input`, {});
    assert.equal(r3.data.input, null);
  });

  it('handleDequeueInput preserves images in the dequeued item', async () => {
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    const images = [
      { base64: 'abc123', mediaType: 'image/png' },
      { base64: 'def456', mediaType: 'image/jpeg' },
    ];
    await queueViaUserTurn('image test', images);

    const { status, data } = await httpPost(
      `/api/agents/${AGENT_ID}/dequeue-input`,
      {},
    );
    assert.equal(status, 200);
    assert.equal(data.input.text, 'image test');
    assert.ok(Array.isArray(data.input.images));
    assert.equal(data.input.images.length, 2);
    assert.equal(data.input.images[0].base64, 'abc123');
    assert.equal(data.input.images[1].mediaType, 'image/jpeg');
  });

  it('handleDequeueInput returns 404 for unknown agent', async () => {
    const { status } = await httpPost(
      `/api/agents/nonexistent-agent/dequeue-input`,
      {},
    );
    assert.equal(status, 404);
  });

  // ── handleGetQueuedInputs ──

  it('handleGetQueuedInputs returns remaining queue items', async () => {
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    await queueViaUserTurn('item-a');
    await queueViaUserTurn('item-b');

    const { status, data } = await httpGet(
      `/api/agents/${AGENT_ID}/queued-inputs`,
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
    assert.equal(data.length, 2);
    assert.equal(data[0].text, 'item-a');
    assert.equal(data[1].text, 'item-b');
  });

  // ── Regression: useArbiterQueue dead zone ──

  it('dequeue works even when session.clientId is set (simulates UDS connection)', async () => {
    // This is the core regression test:
    // Before the fix, the queue write path would set useArbiterQueue=true when
    // clientId pointed to a connected UDS client, and handleDequeueInput
    // would then always return { input: null }, blocking the HTTP dequeue path.
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];
    session.clientId = CLIENT_ID;
    session.useArbiterQueue = undefined;

    // Queue an input (this used to set useArbiterQueue=true)
    await queueViaUserTurn('regression test');

    // Verify useArbiterQueue was NOT set
    assert.equal(
      session.useArbiterQueue,
      undefined,
      'useArbiterQueue must remain unset',
    );

    // Dequeue should return the item (not null)
    const { status, data } = await httpPost(
      `/api/agents/${AGENT_ID}/dequeue-input`,
      {},
    );
    assert.equal(status, 200);
    assert.ok(data.input, 'dequeue must return the queued input, not null');
    assert.equal(data.input.text, 'regression test');
  });

  it('drain-all: consecutive dequeue calls return all items then null', async () => {
    // Simulates the react-loop while(true) drain pattern:
    //   while (true) { const qi = await fetchQueuedInput(); if (!qi) break; ... }
    // When the user queues 3 messages, all 3 must be consumable before null.
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    await queueViaUserTurn('msg-1');
    await queueViaUserTurn('msg-2');
    await queueViaUserTurn('msg-3');

    const drained = [];
    for (;;) {
      const { data } = await httpPost(`/api/agents/${AGENT_ID}/dequeue-input`, {});
      if (!data.input) break;
      drained.push(data.input.text);
    }

    assert.deepEqual(drained, ['msg-1', 'msg-2', 'msg-3']);
    assert.equal(session.queuedInputs.length, 0, 'queue must be empty after drain');
  });

  it('drain-all: images survive across multiple items in one drain', async () => {
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    await queueViaUserTurn('with image', [
      { type: 'image', source_type: 'base64', media_type: 'image/png', data: 'AAAA' },
    ]);
    await queueViaUserTurn('no image');

    const { data: first } = await httpPost(`/api/agents/${AGENT_ID}/dequeue-input`, {});
    assert.ok(first.input.images, 'first item must have images');
    assert.equal(first.input.images.length, 1);

    const { data: second } = await httpPost(`/api/agents/${AGENT_ID}/dequeue-input`, {});
    assert.equal(second.input.text, 'no image');
    assert.ok(!second.input.images, 'second item must not have images');

    const { data: third } = await httpPost(`/api/agents/${AGENT_ID}/dequeue-input`, {});
    assert.equal(third.input, null, 'queue drained');
  });
});
