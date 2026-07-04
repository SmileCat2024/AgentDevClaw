/**
 * Tests for server/routes/project-docset.js — sanitize/clean series pure functions
 *
 * Covers:
 * 1. sanitizeProjectDocsetId
 * 2. buildProjectDocsetMarkdownId
 * 3. cleanProjectDocsetPayload
 * 4. normalizeProjectConversationRecord
 * 5. extractMaterialSourcePath
 *
 * Security focus: ID injection, payload sanitization, path extraction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeProjectDocsetId,
  buildProjectDocsetMarkdownId,
  cleanProjectDocsetPayload,
  normalizeProjectConversationRecord,
  extractMaterialSourcePath,
} from '../server/routes/project-docset.js';

// ── sanitizeProjectDocsetId ──────────────────────────────────────────────────

describe('sanitizeProjectDocsetId', () => {
  it('lowercases input', () => {
    assert.strictEqual(sanitizeProjectDocsetId('MyDocID'), 'mydocid');
  });

  it('trims whitespace', () => {
    assert.strictEqual(sanitizeProjectDocsetId('  spaced  '), 'spaced');
  });

  it('replaces non-alphanumeric characters with hyphens', () => {
    assert.strictEqual(sanitizeProjectDocsetId('my doc.id!'), 'my-doc-id');
  });

  it('collapses consecutive hyphens', () => {
    assert.strictEqual(sanitizeProjectDocsetId('a---b'), 'a-b');
  });

  it('strips leading and trailing hyphens', () => {
    assert.strictEqual(sanitizeProjectDocsetId('---test---'), 'test');
  });

  it('preserves underscores', () => {
    assert.strictEqual(sanitizeProjectDocsetId('my_doc'), 'my_doc');
  });

  it('returns "doc" for empty/null/undefined input', () => {
    assert.strictEqual(sanitizeProjectDocsetId(''), 'doc');
    assert.strictEqual(sanitizeProjectDocsetId(null), 'doc');
    assert.strictEqual(sanitizeProjectDocsetId(undefined), 'doc');
  });

  it('prevents path traversal attempts', () => {
    assert.strictEqual(sanitizeProjectDocsetId('../../../etc/passwd'), 'etc-passwd');
  });

  it('prevents dot-segment injection', () => {
    const result = sanitizeProjectDocsetId('../../secret');
    assert.ok(!result.includes('..'));
    assert.ok(!result.startsWith('/'));
  });
});

// ── buildProjectDocsetMarkdownId ─────────────────────────────────────────────

describe('buildProjectDocsetMarkdownId', () => {
  it('builds ID with prefix, sanitized title, and timestamp', () => {
    const result = buildProjectDocsetMarkdownId('My Feature Plan', '2024-01-15T10:30:00Z', 'plan');
    assert.ok(result.startsWith('plan-my-feature-plan-20240115103000'));
  });

  it('uses fallback prefix when title is empty', () => {
    const result = buildProjectDocsetMarkdownId('', '2024-01-15T10:30:00Z', 'plan');
    assert.ok(result.startsWith('plan-plan-'));
  });

  it('uses default fallback prefix when not specified', () => {
    const result = buildProjectDocsetMarkdownId('test', '2024-01-15');
    assert.ok(result.startsWith('plan-test-'));
  });

  it('extracts only numeric digits from timestamp', () => {
    const result = buildProjectDocsetMarkdownId('x', '2024-06-01T12:00:00Z', 'p');
    assert.ok(result.includes('20240601120000'));
  });

  it('falls back to Date.now() when no timestamp and no digits extracted', () => {
    const result = buildProjectDocsetMarkdownId('test', '', 'plan');
    // Should contain a numeric suffix (Date.now())
    assert.match(result, /^plan-test-\d+$/);
  });
});

// ── cleanProjectDocsetPayload ────────────────────────────────────────────────

describe('cleanProjectDocsetPayload', () => {
  it('returns empty object for null/undefined/non-object input', () => {
    assert.deepStrictEqual(cleanProjectDocsetPayload(null), {});
    assert.deepStrictEqual(cleanProjectDocsetPayload(undefined), {});
    assert.deepStrictEqual(cleanProjectDocsetPayload('string'), {});
    assert.deepStrictEqual(cleanProjectDocsetPayload([]), {});
  });

  it('returns empty object for empty input', () => {
    assert.deepStrictEqual(cleanProjectDocsetPayload({}), {});
  });

  it('trims string values', () => {
    const result = cleanProjectDocsetPayload({ key: '  value  ' });
    assert.strictEqual(result.key, 'value');
  });

  it('preserves non-string values as-is', () => {
    const result = cleanProjectDocsetPayload({ count: 42, flag: true });
    assert.strictEqual(result.count, 42);
    assert.strictEqual(result.flag, true);
  });

  it('filters out null and undefined values', () => {
    const result = cleanProjectDocsetPayload({
      keep: 'val',
      dropNull: null,
      dropUndefined: undefined,
    });
    assert.strictEqual(Object.keys(result).length, 1);
    assert.ok('keep' in result);
  });

  it('filters out empty strings', () => {
    const result = cleanProjectDocsetPayload({
      keep: 'val',
      dropEmpty: '',
      dropWhitespace: '   ',
    });
    assert.strictEqual(Object.keys(result).length, 1);
    assert.ok('keep' in result);
  });

  it('coerces keys to strings', () => {
    const result = cleanProjectDocsetPayload({ 42: 'val' });
    assert.ok('42' in result);
  });
});

// ── normalizeProjectConversationRecord ───────────────────────────────────────

describe('normalizeProjectConversationRecord', () => {
  it('returns normalized record for empty input', () => {
    const result = normalizeProjectConversationRecord({});
    assert.strictEqual(result.sessionId, 'session');
    assert.strictEqual(result.title, 'conversation-record');
    assert.strictEqual(result.summary, '');
    assert.deepStrictEqual(result.keyDecisions, []);
    assert.deepStrictEqual(result.nextActions, []);
    assert.deepStrictEqual(result.openQuestions, []);
    assert.deepStrictEqual(result.relatedMaterialIds, []);
    assert.ok(result.createdAt);
    assert.ok(result.updatedAt);
  });

  it('normalizes sessionId through sanitizeProjectDocsetId', () => {
    const result = normalizeProjectConversationRecord({ sessionId: 'My Session.ID' });
    assert.strictEqual(result.sessionId, 'my-session-id');
  });

  it('defaults sessionId to "session" when empty', () => {
    const result = normalizeProjectConversationRecord({ sessionId: '' });
    assert.strictEqual(result.sessionId, 'session');
  });

  it('trims title and defaults when empty', () => {
    const result = normalizeProjectConversationRecord({ title: '  My Title  ' });
    assert.strictEqual(result.title, 'My Title');
  });

  it('normalizes array fields by trimming and filtering', () => {
    const result = normalizeProjectConversationRecord({
      keyDecisions: ['  decision one  ', '', 'decision two'],
      nextActions: ['  action  ', null],
    });
    assert.deepStrictEqual(result.keyDecisions, ['decision one', 'decision two']);
    assert.deepStrictEqual(result.nextActions, ['action']);
  });

  it('sanitizes relatedMaterialIds through sanitizeProjectDocsetId', () => {
    const result = normalizeProjectConversationRecord({
      relatedMaterialIds: ['Material.ID', 'other-id'],
    });
    assert.deepStrictEqual(result.relatedMaterialIds, ['material-id', 'other-id']);
  });

  it('preserves valid createdAt/updatedAt', () => {
    const result = normalizeProjectConversationRecord({
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-02-01T00:00:00Z',
    });
    assert.strictEqual(result.createdAt, '2024-01-01T00:00:00Z');
    assert.strictEqual(result.updatedAt, '2024-02-01T00:00:00Z');
  });

  it('returns defaults for non-object input', () => {
    const result = normalizeProjectConversationRecord(null);
    assert.strictEqual(result.sessionId, 'session');
    assert.strictEqual(result.title, 'conversation-record');
  });
});

// ── extractMaterialSourcePath ────────────────────────────────────────────────

describe('extractMaterialSourcePath', () => {
  it('extracts path from "Source Path:" line', () => {
    const content = [
      '# Title',
      '',
      '- Source Kind: file',
      '- Source Path: /path/to/file.js',
      '- Imported At: 2024-01-01',
    ].join('\n');
    assert.strictEqual(extractMaterialSourcePath(content), '/path/to/file.js');
  });

  it('handles Windows paths with backslashes', () => {
    const content = '- Source Path: C:\\Users\\dev\\project';
    assert.strictEqual(extractMaterialSourcePath(content), 'C:\\Users\\dev\\project');
  });

  it('handles paths with spaces', () => {
    const content = '- Source Path: /path with spaces/file.txt';
    assert.strictEqual(extractMaterialSourcePath(content), '/path with spaces/file.txt');
  });

  it('trims extracted path', () => {
    const content = '- Source Path:   /path/to/file.js   ';
    assert.strictEqual(extractMaterialSourcePath(content), '/path/to/file.js');
  });

  it('returns empty string when no Source Path line', () => {
    assert.strictEqual(extractMaterialSourcePath('# Title\nSome content'), '');
  });

  it('returns empty string for empty/null content', () => {
    assert.strictEqual(extractMaterialSourcePath(''), '');
    assert.strictEqual(extractMaterialSourcePath(null), '');
    assert.strictEqual(extractMaterialSourcePath(undefined), '');
  });

  it('matches only first occurrence', () => {
    const content = [
      '- Source Path: /first/path',
      'Some text',
      '- Source Path: /second/path',
    ].join('\n');
    assert.strictEqual(extractMaterialSourcePath(content), '/first/path');
  });

  it('is case-insensitive on "Source Path:" prefix via whitespace tolerance', () => {
    const content = '- Source Path:  /path  ';
    assert.strictEqual(extractMaterialSourcePath(content), '/path');
  });
});
