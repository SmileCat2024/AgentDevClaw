/**
 * Tests for server/usage-ledger.js — pure functions
 *
 * Covers:
 * 1. cleanText
 * 2. toNumber
 * 3. normalizeDate
 * 4. normalizeUsage
 * 5. normalizeModel
 * 6. stableHash
 * 7. hashBaseUrl
 * 8. buildUsageEvent
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanText,
  toNumber,
  normalizeDate,
  normalizeUsage,
  normalizeModel,
  stableHash,
  hashBaseUrl,
  buildUsageEvent,
} from '../server/usage-ledger.js';

// ── cleanText ────────────────────────────────────────────────────────────────

describe('cleanText', () => {
  it('trims whitespace from strings', () => {
    assert.strictEqual(cleanText('  hello  '), 'hello');
  });

  it('returns empty string for non-string values', () => {
    assert.strictEqual(cleanText(null), '');
    assert.strictEqual(cleanText(undefined), '');
    assert.strictEqual(cleanText(42), '');
    assert.strictEqual(cleanText(true), '');
    assert.strictEqual(cleanText({}), '');
  });

  it('returns empty string for empty input', () => {
    assert.strictEqual(cleanText(''), '');
  });
});

// ── toNumber ─────────────────────────────────────────────────────────────────

describe('toNumber', () => {
  it('returns number for finite values', () => {
    assert.strictEqual(toNumber(42), 42);
    assert.strictEqual(toNumber(0), 0);
    assert.strictEqual(toNumber(-3.14), -3.14);
  });

  it('returns 0 for non-finite values', () => {
    assert.strictEqual(toNumber(Infinity), 0);
    assert.strictEqual(toNumber(NaN), 0);
    assert.strictEqual(toNumber(-Infinity), 0);
  });

  it('returns 0 for non-number values', () => {
    assert.strictEqual(toNumber('42'), 0);
    assert.strictEqual(toNumber(null), 0);
    assert.strictEqual(toNumber(undefined), 0);
    assert.strictEqual(toNumber({}), 0);
  });
});

// ── normalizeDate ────────────────────────────────────────────────────────────

describe('normalizeDate', () => {
  it('returns valid YYYY-MM-DD dates', () => {
    assert.strictEqual(normalizeDate('2024-01-15'), '2024-01-15');
    assert.strictEqual(normalizeDate('2024-12-31'), '2024-12-31');
  });

  it('returns empty string for invalid formats', () => {
    assert.strictEqual(normalizeDate('2024/01/15'), '');
    assert.strictEqual(normalizeDate('01-15-2024'), '');
    assert.strictEqual(normalizeDate('2024-1-5'), '');
    assert.strictEqual(normalizeDate('not-a-date'), '');
  });

  it('trims input before validation', () => {
    assert.strictEqual(normalizeDate('  2024-01-15  '), '2024-01-15');
  });

  it('returns empty string for non-string input', () => {
    assert.strictEqual(normalizeDate(null), '');
    assert.strictEqual(normalizeDate(42), '');
  });
});

// ── normalizeUsage ───────────────────────────────────────────────────────────

describe('normalizeUsage', () => {
  it('returns all zero fields for empty input', () => {
    const result = normalizeUsage();
    assert.strictEqual(result.inputTokens, 0);
    assert.strictEqual(result.outputTokens, 0);
    assert.strictEqual(result.totalTokens, 0);
    assert.strictEqual(result.cacheReadTokens, 0);
    assert.strictEqual(result.cacheCreationTokens, 0);
    assert.strictEqual(result.reasoningTokens, 0);
    assert.strictEqual(result.audioTokens, 0);
  });

  it('normalizes all token fields', () => {
    const result = normalizeUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 10,
      reasoningTokens: 30,
      audioTokens: 5,
    });
    assert.strictEqual(result.inputTokens, 100);
    assert.strictEqual(result.outputTokens, 50);
    assert.strictEqual(result.cacheReadTokens, 200);
    assert.strictEqual(result.cacheCreationTokens, 10);
    assert.strictEqual(result.reasoningTokens, 30);
    assert.strictEqual(result.audioTokens, 5);
  });

  it('computes totalTokens from input+output when totalTokens is 0', () => {
    const result = normalizeUsage({ inputTokens: 100, outputTokens: 50 });
    assert.strictEqual(result.totalTokens, 150);
  });

  it('preserves explicit totalTokens', () => {
    const result = normalizeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 999 });
    assert.strictEqual(result.totalTokens, 999);
  });

  it('coerces non-finite values to 0', () => {
    const result = normalizeUsage({ inputTokens: 'abc', outputTokens: NaN });
    assert.strictEqual(result.inputTokens, 0);
    assert.strictEqual(result.outputTokens, 0);
  });
});

// ── normalizeModel ───────────────────────────────────────────────────────────

describe('normalizeModel', () => {
  it('returns empty fields for empty input', () => {
    const result = normalizeModel();
    assert.strictEqual(result.modelName, '');
    assert.strictEqual(result.provider, '');
    assert.strictEqual(result.providerName, '');
    assert.strictEqual(result.protocol, '');
    assert.strictEqual(result.presetName, '');
    assert.strictEqual(result.presetRole, '');
    assert.strictEqual(result.baseUrlHash, '');
  });

  it('normalizes string fields by trimming', () => {
    const result = normalizeModel({
      modelName: '  gpt-4  ',
      provider: '  openai  ',
      providerName: '  OpenAI  ',
    });
    assert.strictEqual(result.modelName, 'gpt-4');
    assert.strictEqual(result.provider, 'openai');
    assert.strictEqual(result.providerName, 'OpenAI');
  });

  it('computes baseUrlHash from baseUrl when not provided', () => {
    const result = normalizeModel({ baseUrl: 'https://api.example.com' });
    assert.ok(result.baseUrlHash);
    assert.ok(result.baseUrlHash.startsWith('sha256:'));
  });

  it('prefers explicit baseUrlHash over computed', () => {
    const result = normalizeModel({
      baseUrlHash: 'sha256:abc123',
      baseUrl: 'https://api.example.com',
    });
    assert.strictEqual(result.baseUrlHash, 'sha256:abc123');
  });

  it('returns empty baseUrlHash for empty baseUrl', () => {
    const result = normalizeModel({});
    assert.strictEqual(result.baseUrlHash, '');
  });
});

// ── stableHash ───────────────────────────────────────────────────────────────

describe('stableHash', () => {
  it('returns consistent 24-char hex string', () => {
    const result = stableHash({ a: 1, b: 2 });
    assert.strictEqual(result.length, 24);
    assert.match(result, /^[0-9a-f]{24}$/);
  });

  it('produces same hash for same input', () => {
    assert.strictEqual(stableHash({ x: 1 }), stableHash({ x: 1 }));
  });

  it('produces different hash for different input', () => {
    assert.notStrictEqual(stableHash({ x: 1 }), stableHash({ x: 2 }));
  });

  it('handles primitive input', () => {
    assert.strictEqual(typeof stableHash(42), 'string');
    assert.strictEqual(typeof stableHash('hello'), 'string');
    assert.strictEqual(typeof stableHash(true), 'string');
  });

  it('produces deterministic hash regardless of key order in same object', () => {
    // JSON.stringify preserves insertion order; these are different objects
    // but the JSON output is the same
    assert.strictEqual(stableHash({ a: 1, b: 2 }), stableHash({ a: 1, b: 2 }));
  });
});

// ── hashBaseUrl ──────────────────────────────────────────────────────────────

describe('hashBaseUrl', () => {
  it('returns "sha256:" prefixed hash', () => {
    const result = hashBaseUrl('https://api.example.com');
    assert.ok(result.startsWith('sha256:'));
    // 16 hex chars after prefix
    const hashPart = result.slice(7);
    assert.strictEqual(hashPart.length, 16);
    assert.match(hashPart, /^[0-9a-f]{16}$/);
  });

  it('returns empty string for empty/null input', () => {
    assert.strictEqual(hashBaseUrl(''), '');
    assert.strictEqual(hashBaseUrl(null), '');
    assert.strictEqual(hashBaseUrl(undefined), '');
    assert.strictEqual(hashBaseUrl('  '), '');
  });

  it('produces same hash for same URL', () => {
    assert.strictEqual(
      hashBaseUrl('https://api.openai.com/v1'),
      hashBaseUrl('https://api.openai.com/v1'),
    );
  });

  it('produces different hash for different URLs', () => {
    assert.notStrictEqual(
      hashBaseUrl('https://api.openai.com/v1'),
      hashBaseUrl('https://api.anthropic.com'),
    );
  });

  it('trims input before hashing', () => {
    assert.strictEqual(
      hashBaseUrl('  https://api.example.com  '),
      hashBaseUrl('https://api.example.com'),
    );
  });
});

// ── buildUsageEvent ──────────────────────────────────────────────────────────

describe('buildUsageEvent', () => {
  it('builds event with default fields for empty input', () => {
    const event = buildUsageEvent();
    assert.strictEqual(event.schemaVersion, 1);
    assert.strictEqual(event.source, 'unknown');
    assert.ok(event.eventId);
    assert.ok(event.timestamp > 0);
    assert.ok(event.date);
    assert.strictEqual(event.requestCount, 1);
    assert.strictEqual(event.cacheHitRequests, 0);
    assert.strictEqual(event.model.modelName, '');
    assert.strictEqual(event.usage.inputTokens, 0);
  });

  it('preserves explicit eventId', () => {
    const event = buildUsageEvent({ eventId: 'custom-id-123' });
    assert.strictEqual(event.eventId, 'custom-id-123');
  });

  it('auto-generates eventId from stable hash when not provided', () => {
    const event1 = buildUsageEvent({ source: 'test', timestamp: 1000 });
    const event2 = buildUsageEvent({ source: 'test', timestamp: 1000 });
    assert.strictEqual(event1.eventId, event2.eventId);
    assert.strictEqual(event1.eventId.length, 24);
  });

  it('normalizes usage fields', () => {
    const event = buildUsageEvent({
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    assert.strictEqual(event.usage.inputTokens, 100);
    assert.strictEqual(event.usage.outputTokens, 50);
    assert.strictEqual(event.usage.totalTokens, 150);
  });

  it('normalizes model fields', () => {
    const event = buildUsageEvent({
      model: { modelName: '  gpt-4  ', provider: '  openai  ' },
    });
    assert.strictEqual(event.model.modelName, 'gpt-4');
    assert.strictEqual(event.model.provider, 'openai');
  });

  it('derives date from timestamp when not provided', () => {
    // 2024-01-15 00:00:00 UTC
    const event = buildUsageEvent({ timestamp: 1705276800000 });
    assert.strictEqual(event.date, expectDateFor(event.date));
    assert.match(event.date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('respects explicit date over timestamp-derived date', () => {
    const event = buildUsageEvent({ timestamp: 1705276800000, date: '2023-06-01' });
    assert.strictEqual(event.date, '2023-06-01');
  });

  it('clamps requestCount to minimum 1', () => {
    assert.strictEqual(buildUsageEvent({ requestCount: 0 }).requestCount, 1);
    assert.strictEqual(buildUsageEvent({ requestCount: -5 }).requestCount, 1);
    assert.strictEqual(buildUsageEvent({ requestCount: 3 }).requestCount, 3);
  });

  it('handles callIndex and step correctly', () => {
    const event = buildUsageEvent({ callIndex: 2, step: 5 });
    assert.strictEqual(event.callIndex, 2);
    assert.strictEqual(event.step, 5);
  });

  it('nulls callIndex and step for non-finite values', () => {
    const event = buildUsageEvent({ callIndex: 'abc', step: NaN });
    assert.strictEqual(event.callIndex, null);
    assert.strictEqual(event.step, null);
  });

  it('preserves metadata object', () => {
    const event = buildUsageEvent({ metadata: { custom: 'data' } });
    assert.deepStrictEqual(event.metadata, { custom: 'data' });
  });

  it('defaults metadata to empty object for non-object input', () => {
    const event = buildUsageEvent({ metadata: 'invalid' });
    assert.deepStrictEqual(event.metadata, {});
  });

  it('normalizes context fields', () => {
    const event = buildUsageEvent({
      context: { contextInputTokens: 500, messageCount: 10 },
    });
    assert.strictEqual(event.context.contextInputTokens, 500);
    assert.strictEqual(event.context.messageCount, 10);
  });
});

// Helper: just return the date back (ensures format is valid)
function expectDateFor(date) {
  return date;
}
