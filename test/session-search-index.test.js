/**
 * Tests for bounded in-memory session search index caching.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSearchIndexMemoryCache } from '../server/routes/session-search-index.js';

describe('session search index memory cache', () => {
  it('evicts the least recently used agent index when the budget is exceeded', () => {
    const cache = createSearchIndexMemoryCache(10);
    const first = new Map([['a', { text: 'first' }]]);
    const second = new Map([['b', { text: 'second' }]]);

    cache.set('agent-a', first, 6);
    cache.set('agent-b', second, 6);

    assert.equal(cache.get('agent-a'), null);
    assert.equal(cache.get('agent-b'), second);
    assert.deepEqual(cache.getStats(), { size: 1, totalBytes: 6 });
  });

  it('does not retain a single index larger than the cache budget', () => {
    const cache = createSearchIndexMemoryCache(10);
    cache.set('oversized-agent', new Map(), 11);

    assert.equal(cache.get('oversized-agent'), null);
    assert.deepEqual(cache.getStats(), { size: 0, totalBytes: 0 });
  });
});
