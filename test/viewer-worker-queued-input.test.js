/**
 * Tests for ViewerWorker queued-input / dequeue-input HTTP endpoints.
 *
 * Validates the fix for the "useArbiterQueue dead zone" bug:
 * - handleQueueInput must NOT set session.useArbiterQueue
 * - handleQueueInput must NOT forward to UDS
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

describe('ViewerWorker queued-input HTTP endpoints', () => {
  before(async () => {
    const { ViewerWorker } = await import('agentdev');
    viewerWorker = new ViewerWorker(TEST_PORT, false);
    await viewerWorker.start();

    // Register a fake agent session directly so queue/dequeue routes find it
    viewerWorker.agentSessions.set(AGENT_ID, {
      agentId: AGENT_ID,
      messages: [],
      logs: [],
      queuedInputs: [],
      clientId: 'fake-client-id',
    });
  });

  after(async () => {
    if (viewerWorker) {
      await viewerWorker.stop();
    }
  });

  // ── handleQueueInput ──

  it('handleQueueInput stores text input and returns success', async () => {
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    const { status, data } = await httpPost(
      `/api/agents/${AGENT_ID}/queue-input`,
      { text: 'hello world' },
    );
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.ok(data.id, 'should return an id');
    assert.equal(data.queueLength, 1);
  });

  it('handleQueueInput stores input with images', async () => {
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];

    const { status, data } = await httpPost(
      `/api/agents/${AGENT_ID}/queue-input`,
      {
        text: 'look at this',
        images: [{ base64: 'iVBOR...', mediaType: 'image/png' }],
      },
    );
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(data.queueLength, 1);
  });

  it('handleQueueInput rejects missing text', async () => {
    const { status, data } = await httpPost(
      `/api/agents/${AGENT_ID}/queue-input`,
      { images: [] },
    );
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('handleQueueInput returns 404 for unknown agent', async () => {
    const { status } = await httpPost(
      `/api/agents/nonexistent-agent/queue-input`,
      { text: 'test' },
    );
    assert.equal(status, 404);
  });

  it('handleQueueInput does NOT set session.useArbiterQueue', async () => {
    // Clear queue and add a fresh input
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];
    session.useArbiterQueue = undefined; // reset

    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'trigger' });

    assert.equal(
      session.useArbiterQueue,
      undefined,
      'useArbiterQueue must NOT be set by handleQueueInput',
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
    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'first' });
    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'second' });

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
    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, {
      text: 'image test',
      images,
    });

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

    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'item-a' });
    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'item-b' });

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
    // Before the fix, handleQueueInput would set useArbiterQueue=true when
    // clientId pointed to a connected UDS client, and handleDequeueInput
    // would then always return { input: null }, blocking the HTTP dequeue path.
    const session = viewerWorker.agentSessions.get(AGENT_ID);
    session.queuedInputs = [];
    session.clientId = 'fake-client-id';
    session.useArbiterQueue = undefined;

    // Queue an input (this used to set useArbiterQueue=true)
    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'regression test' });

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

    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'msg-1' });
    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'msg-2' });
    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'msg-3' });

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

    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, {
      text: 'with image',
      images: [{ type: 'image', source_type: 'base64', media_type: 'image/png', data: 'AAAA' }],
    });
    await httpPost(`/api/agents/${AGENT_ID}/queue-input`, { text: 'no image' });

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
