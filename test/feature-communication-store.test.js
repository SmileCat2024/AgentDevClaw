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
