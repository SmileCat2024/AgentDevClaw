import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FeatureCommunicationStore } from '../server/feature-communication-store.js';

const target = { agentId: 'agent-a', sessionId: 'session-a', featureId: 'shell', channelId: 'task-1' };

describe('FeatureCommunicationStore', () => {
  it('stores a replaceable current snapshot per exact feature channel', () => {
    const store = new FeatureCommunicationStore();
    store.declareChannel(target);
    const first = store.publishSnapshot(target, { status: 'running' });
    const second = store.publishSnapshot(target, { status: 'finished' });

    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.deepEqual(store.getSnapshot(target), { revision: 2, data: { status: 'finished' } });
    assert.equal(store.getSnapshot({ ...target, sessionId: 'other-session' }), null);
  });

  it('assigns ordered event ids and resumes from a bounded event cursor', () => {
    const store = new FeatureCommunicationStore({ eventLimit: 2 });
    store.declareChannel(target);
    const first = store.publishEvent(target, 'output', { text: 'one' });
    store.publishEvent(target, 'output', { text: 'two' });
    store.publishEvent(target, 'output', { text: 'three' });

    assert.equal(first.eventId, 1);
    assert.deepEqual(store.readEvents(target, 1), {
      resync: false,
      events: [
        { eventId: 2, type: 'output', data: { text: 'two' } },
        { eventId: 3, type: 'output', data: { text: 'three' } },
      ],
    });
    assert.deepEqual(store.readEvents(target, 0), { resync: true, events: [] });
  });

  it('bounds retained event payload bytes as well as event count', () => {
    const store = new FeatureCommunicationStore({ eventLimit: 256, eventBytesLimit: 250 });
    store.declareChannel(target);
    for (let i = 0; i < 10; i++) store.publishEvent(target, 'output', { text: 'x'.repeat(100), i });
    assert.ok(store.channels.get(JSON.stringify(Object.values(target))).eventBytes <= 250);
    assert.deepEqual(store.readEvents(target, 0), { resync: true, events: [] });
    const recent = store.readEvents(target, 9);
    assert.equal(recent.events.length, 1);
    assert.equal(recent.events[0].data.i, 9);
    assert.equal(store.getLastEventId(target), 10);
  });

  it('drops an oversized event from history but delivers it live and requests resync', () => {
    const store = new FeatureCommunicationStore({ eventBytesLimit: 100 });
    store.declareChannel(target);
    const delivered = [];
    store.subscribe(target, event => delivered.push(event));
    const event = store.publishEvent(target, 'output', { text: 'x'.repeat(200) });
    assert.deepEqual(delivered, [event]);
    assert.equal(store.channels.get(JSON.stringify(Object.values(target))).eventBytes, 0);
    assert.deepEqual(store.readEvents(target, 0), { resync: true, events: [] });
    assert.deepEqual(store.readEvents(target, event.eventId), { resync: false, events: [] });
  });

  it('keeps busy-session output mirrors bounded across many live channels', () => {
    const store = new FeatureCommunicationStore();
    const tail = 'x'.repeat(2_000);
    for (let session = 0; session < 32; session++) {
      const address = { ...target, sessionId: `session-${session}` };
      store.declareChannel(address);
      for (let event = 0; event < 256; event++) {
        store.publishEvent(address, 'output', { id: 'bg-1', outputTail: tail });
      }
    }
    assert.equal(store.channels.size, 32);
    for (const channel of store.channels.values()) {
      assert.ok(channel.eventBytes <= 256 * 1024);
      assert.ok(channel.events.length < 256);
      assert.equal(channel.eventId, 256);
    }
  });

  it('closes channel state and rejects pending requests when a session runtime stops', async () => {
    const store = new FeatureCommunicationStore();
    store.declareChannel(target);
    store.publishSnapshot(target, { status: 'running' });
    const terminal = [];
    store.subscribe(target, (event) => terminal.push(event.type));
    const pending = store.beginRequest(target, 'request-stop');
    store.closeSession(target.agentId, target.sessionId);
    assert.equal(store.getSnapshot(target), null);
    assert.deepEqual(terminal, ['closed']);
    assert.equal(store.isDeclared(target), false);
    assert.deepEqual(store.listChannels(target.agentId, target.sessionId), []);
    assert.deepEqual(await pending, { ok: false, code: 'runtime_stopped', error: 'Session runtime stopped' });
  });

  it('rejects publishing and requesting on undeclared channels', async () => {
    const store = new FeatureCommunicationStore();
    assert.throws(() => store.publishSnapshot(target, {}), /channel_not_declared/);
    assert.throws(() => store.publishEvent(target, 'output', {}), /channel_not_declared/);
    assert.throws(() => store.beginRequest(target, 'request-1'), /channel_not_declared/);
  });

  it('lists declared channels with live snapshot presence per session', () => {
    const store = new FeatureCommunicationStore();
    store.declareChannel(target, { title: 'Background tasks', description: 'Live shell task states' });
    store.declareChannel({ ...target, channelId: 'task-2' });
    store.publishSnapshot(target, { status: 'running' });
    const channels = store.listChannels(target.agentId, target.sessionId);
    assert.equal(channels.length, 2);
    const task1 = channels.find((channel) => channel.channelId === 'task-1');
    assert.equal(task1.title, 'Background tasks');
    assert.equal(task1.hasSnapshot, true);
    assert.equal(task1.lastEventId, 1);
    const task2 = channels.find((channel) => channel.channelId === 'task-2');
    assert.equal(task2.hasSnapshot, false);
    assert.deepEqual(store.listChannels(target.agentId, 'other-session'), []);
  });

  it('keeps request/response waiters separate by exact runtime target and request id', async () => {
    const store = new FeatureCommunicationStore();
    store.declareChannel(target);
    const pending = store.beginRequest(target, 'request-1');
    assert.equal(store.resolveRequest({ ...target, sessionId: 'other-session' }, 'request-1', { ok: true }), false);
    assert.equal(store.resolveRequest(target, 'request-1', { ok: true, result: 42 }), true);
    assert.deepEqual(await pending, { ok: true, result: 42 });
  });
});
