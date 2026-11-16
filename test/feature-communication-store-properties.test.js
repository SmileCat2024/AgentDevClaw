import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { FeatureCommunicationStore } from '../server/feature-communication-store.js';

const MAX_RUNS = Math.min(500, Math.max(20, Number(process.env.FAST_CHECK_NUM_RUNS) || 100));
const SEED = Number.isSafeInteger(Number(process.env.FAST_CHECK_SEED))
  ? Number(process.env.FAST_CHECK_SEED)
  : undefined;
const PROPERTY_OPTIONS = {
  numRuns: MAX_RUNS,
  ...(SEED === undefined ? {} : { seed: SEED }),
};

const targetArb = fc.record({
  agentId: fc.stringMatching(/^agent-[a-z]{1,4}$/),
  sessionId: fc.stringMatching(/^session-[a-z]{1,4}$/),
  featureId: fc.stringMatching(/^feature-[a-z]{1,4}$/),
  channelId: fc.stringMatching(/^channel-[a-z]{1,4}$/),
});
const eventDataArb = fc.record({
  text: fc.string({ unit: 'grapheme', minLength: 1, maxLength: 24 }),
  value: fc.integer({ min: -1000, max: 1000 }),
});
const eventSequenceArb = fc.array(eventDataArb, { minLength: 1, maxLength: 32 });

function declare(store, target) {
  store.declareChannel(target);
}

function publishSequence(store, target, data) {
  return data.map((value) => store.publishEvent(target, 'output', value));
}

function eventIds(events) {
  return events.map((event) => event.eventId);
}

describe('FeatureCommunicationStore business properties', () => {
  it('replays every retained suffix and requests resync only before the retained window', () => {
    fc.assert(
      fc.property(targetArb, fc.integer({ min: 1, max: 12 }), eventSequenceArb, (target, eventLimit, data) => {
        const store = new FeatureCommunicationStore({ eventLimit, eventBytesLimit: 1_000_000 });
        declare(store, target);
        const published = publishSequence(store, target, data);
        const retained = published.slice(-eventLimit);
        const firstRetainedId = retained[0].eventId;

        assert.deepEqual(eventIds(retained), Array.from({ length: retained.length }, (_, index) => firstRetainedId + index));
        assert.equal(store.getLastEventId(target), published.length);

        for (let cursor = 0; cursor <= published.length; cursor += 1) {
          const read = store.readEvents(target, cursor);
          if (cursor < firstRetainedId - 1) {
            assert.deepEqual(read, { resync: true, events: [] });
          } else {
            assert.equal(read.resync, false);
            assert.deepEqual(eventIds(read.events), published.filter((event) => event.eventId > cursor).map((event) => event.eventId));
          }
        }
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('keeps event ids and replay data isolated for exact channels', () => {
    fc.assert(
      fc.property(targetArb, targetArb, eventSequenceArb, eventSequenceArb, (firstTarget, secondTarget, firstData, secondData) => {
        fc.pre(JSON.stringify(firstTarget) !== JSON.stringify(secondTarget));
        const store = new FeatureCommunicationStore({ eventBytesLimit: 1_000_000 });
        declare(store, firstTarget);
        declare(store, secondTarget);

        const firstPublished = [];
        const secondPublished = [];
        const length = Math.max(firstData.length, secondData.length);
        for (let index = 0; index < length; index += 1) {
          if (firstData[index] !== undefined) firstPublished.push(store.publishEvent(firstTarget, 'output', firstData[index]));
          if (secondData[index] !== undefined) secondPublished.push(store.publishEvent(secondTarget, 'output', secondData[index]));
        }

        assert.deepEqual(eventIds(firstPublished), Array.from({ length: firstPublished.length }, (_, index) => index + 1));
        assert.deepEqual(eventIds(secondPublished), Array.from({ length: secondPublished.length }, (_, index) => index + 1));
        assert.deepEqual(store.readEvents(firstTarget, 0).events, firstPublished);
        assert.deepEqual(store.readEvents(secondTarget, 0).events, secondPublished);
        assert.equal(store.getLastEventId(firstTarget), firstPublished.length);
        assert.equal(store.getLastEventId(secondTarget), secondPublished.length);
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('delivers an oversized event live while making its history gap explicit', () => {
    fc.assert(
      fc.property(targetArb, fc.string({ unit: 'grapheme', minLength: 1, maxLength: 256 }), (target, text) => {
        const store = new FeatureCommunicationStore({ eventBytesLimit: 1 });
        declare(store, target);
        const delivered = [];
        store.subscribe(target, (event) => delivered.push(event));

        const published = store.publishEvent(target, 'output', { text });
        assert.deepEqual(delivered, [published]);
        assert.deepEqual(store.readEvents(target, 0), { resync: true, events: [] });
        assert.deepEqual(store.readEvents(target, published.eventId), { resync: false, events: [] });
      }),
      PROPERTY_OPTIONS,
    );
  });
});
