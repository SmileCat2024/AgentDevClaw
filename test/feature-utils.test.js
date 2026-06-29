/**
 * Tests for Phase 6 shared utility functions.
 *
 * Covers pure functions extracted from server.js into server/shared/:
 * - feature-utils: compareSemver, uniqueStrings
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compareSemver, uniqueStrings } from '../server/shared/feature-utils.js';

// ─── compareSemver ─────────────────────────────────────────────────

describe('compareSemver', () => {
  it('should return 0 for equal versions', () => {
    assert.strictEqual(compareSemver('1.0.0', '1.0.0'), 0);
    assert.strictEqual(compareSemver('2.3.4', '2.3.4'), 0);
  });

  it('should return negative when left < right', () => {
    assert.ok(compareSemver('1.0.0', '2.0.0') < 0);
    assert.ok(compareSemver('1.9.9', '2.0.0') < 0);
    assert.ok(compareSemver('1.0.0', '1.0.1') < 0);
  });

  it('should return positive when left > right', () => {
    assert.ok(compareSemver('2.0.0', '1.0.0') > 0);
    assert.ok(compareSemver('1.0.1', '1.0.0') > 0);
    assert.ok(compareSemver('3.2.1', '3.2.0') > 0);
  });

  it('should handle missing patch/minor segments', () => {
    assert.ok(compareSemver('1.0', '1.0.0') === 0);
    assert.ok(compareSemver('1', '1.0.0') === 0);
    assert.ok(compareSemver('2', '1.9.9') > 0);
  });

  it('should treat non-numeric segments as 0', () => {
    assert.strictEqual(compareSemver('1.x.0', '1.0.0'), 0);
    assert.strictEqual(compareSemver('1.0a', '1.0'), 0);
  });

  it('should handle null/empty/undefined gracefully', () => {
    assert.strictEqual(compareSemver('', ''), 0);
    assert.strictEqual(compareSemver(null, undefined), 0);
    assert.strictEqual(compareSemver('1.0.0', ''), 1);
    assert.ok(compareSemver('1.0.0', null) > 0);
  });
});

// ─── uniqueStrings ─────────────────────────────────────────────────

describe('uniqueStrings', () => {
  it('should deduplicate values', () => {
    assert.deepEqual(uniqueStrings(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
  });

  it('should trim whitespace before dedup', () => {
    assert.deepEqual(uniqueStrings(['a', ' a ', 'a']), ['a']);
  });

  it('should filter out empty/falsy values', () => {
    assert.deepEqual(uniqueStrings(['a', '', null, undefined, 'b']), ['a', 'b']);
    assert.deepEqual(uniqueStrings(['', null, undefined]), []);
  });

  it('should return empty array for non-array input', () => {
    assert.deepEqual(uniqueStrings(null), []);
    assert.deepEqual(uniqueStrings(undefined), []);
    assert.deepEqual(uniqueStrings('not-array'), []);
    assert.deepEqual(uniqueStrings(42), []);
  });

  it('should preserve insertion order', () => {
    assert.deepEqual(uniqueStrings(['c', 'a', 'b', 'a']), ['c', 'a', 'b']);
  });
});
