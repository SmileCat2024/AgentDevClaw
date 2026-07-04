/**
 * Tests for server/routes/assembly-helpers.js — validation/hash pure functions
 *
 * Covers:
 * 1. isValidFeatureName
 * 2. resolveFeatureCreatorOutputDir
 * 3. toFileDependencySpec
 * 4. computeDependencyHash
 *
 * Security focus: feature name injection, path traversal in output dir.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import {
  isValidFeatureName,
  resolveFeatureCreatorOutputDir,
  toFileDependencySpec,
  computeDependencyHash,
} from '../server/routes/assembly-helpers.js';

// ── isValidFeatureName ───────────────────────────────────────────────────────

describe('isValidFeatureName', () => {
  it('accepts simple lowercase names', () => {
    assert.strictEqual(isValidFeatureName('shell'), true);
    assert.strictEqual(isValidFeatureName('memory'), true);
  });

  it('accepts hyphenated names', () => {
    assert.strictEqual(isValidFeatureName('shell-feature'), true);
    assert.strictEqual(isValidFeatureName('my-cool-tool'), true);
  });

  it('accepts names with digits', () => {
    assert.strictEqual(isValidFeatureName('feature2'), true);
    assert.strictEqual(isValidFeatureName('my-feature-v2'), true);
  });

  it('rejects uppercase letters', () => {
    assert.strictEqual(isValidFeatureName('Shell'), false);
    assert.strictEqual(isValidFeatureName('MyFeature'), false);
  });

  it('rejects names starting with a digit', () => {
    assert.strictEqual(isValidFeatureName('2feature'), false);
    assert.strictEqual(isValidFeatureName('1-shell'), false);
  });

  it('rejects names starting with hyphen', () => {
    assert.strictEqual(isValidFeatureName('-shell'), false);
  });

  it('rejects empty/null/undefined input', () => {
    assert.strictEqual(isValidFeatureName(''), false);
    assert.strictEqual(isValidFeatureName(null), false);
    assert.strictEqual(isValidFeatureName(undefined), false);
  });

  it('rejects path traversal attempts', () => {
    assert.strictEqual(isValidFeatureName('../etc/passwd'), false);
    assert.strictEqual(isValidFeatureName('..%2Fetc'), false);
  });

  it('rejects names with spaces', () => {
    assert.strictEqual(isValidFeatureName('my feature'), false);
  });

  it('rejects names with special characters', () => {
    assert.strictEqual(isValidFeatureName('my@feature'), false);
    assert.strictEqual(isValidFeatureName('my_feature'), false);
    assert.strictEqual(isValidFeatureName('my.feature'), false);
  });

  it('trims input before validation', () => {
    assert.strictEqual(isValidFeatureName('  shell  '), true);
  });
});

// ── resolveFeatureCreatorOutputDir ───────────────────────────────────────────

describe('resolveFeatureCreatorOutputDir', () => {
  it('joins parent dir and feature name', () => {
    const result = resolveFeatureCreatorOutputDir('/parent/dir', 'my-feature');
    assert.strictEqual(result, path.join(path.resolve('/parent/dir'), 'my-feature'));
  });

  it('resolves relative parent dir to absolute', () => {
    const result = resolveFeatureCreatorOutputDir('./relative', 'feature');
    assert.ok(path.isAbsolute(result));
    assert.ok(result.endsWith('feature'));
  });

  it('handles empty parent dir', () => {
    const result = resolveFeatureCreatorOutputDir('', 'my-feature');
    assert.ok(result.endsWith('my-feature'));
  });

  it('trims whitespace from both arguments', () => {
    const result = resolveFeatureCreatorOutputDir('  /parent  ', '  feature  ');
    assert.ok(result.endsWith('feature'));
  });

  it('handles empty feature name', () => {
    const result = resolveFeatureCreatorOutputDir('/parent', '');
    assert.strictEqual(result, path.resolve('/parent'));
  });

  it('handles null/undefined inputs', () => {
    const result = resolveFeatureCreatorOutputDir(null, undefined);
    assert.ok(typeof result === 'string');
  });
});

// ── toFileDependencySpec ─────────────────────────────────────────────────────

describe('toFileDependencySpec', () => {
  it('produces file: protocol spec for absolute path', () => {
    const result = toFileDependencySpec('/absolute/path/to/pkg');
    assert.ok(result.startsWith('file:'));
    assert.ok(result.includes('/absolute/path/to/pkg'));
  });

  it('resolves relative paths to absolute', () => {
    const result = toFileDependencySpec('./relative/path');
    assert.ok(result.startsWith('file:'));
    // Should be resolved to absolute path
    assert.ok(!result.includes('./relative/path'));
  });

  it('converts backslashes to forward slashes', () => {
    const result = toFileDependencySpec('C:\\Users\\dev\\project');
    assert.ok(!result.includes('\\'));
    assert.ok(result.includes('C:/Users/dev/project'));
  });

  it('handles root paths', () => {
    const result = toFileDependencySpec('/');
    assert.ok(result.startsWith('file:'));
  });

  it('produces deterministic output for same input', () => {
    const result1 = toFileDependencySpec('/same/path');
    const result2 = toFileDependencySpec('/same/path');
    assert.strictEqual(result1, result2);
  });
});

// ── computeDependencyHash ────────────────────────────────────────────────────

describe('computeDependencyHash', () => {
  it('returns base36 string for non-empty dependencies', () => {
    const result = computeDependencyHash({ agentdev: '^0.2.3' });
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    assert.match(result, /^-?[0-9a-z]+$/);
  });

  it('produces same hash for same dependencies regardless of key order', () => {
    const hash1 = computeDependencyHash({ a: '1.0.0', b: '2.0.0' });
    const hash2 = computeDependencyHash({ b: '2.0.0', a: '1.0.0' });
    assert.strictEqual(hash1, hash2);
  });

  it('produces different hash for different values', () => {
    const hash1 = computeDependencyHash({ dep: '1.0.0' });
    const hash2 = computeDependencyHash({ dep: '2.0.0' });
    assert.notStrictEqual(hash1, hash2);
  });

  it('produces different hash for different keys', () => {
    const hash1 = computeDependencyHash({ depA: '1.0.0' });
    const hash2 = computeDependencyHash({ depB: '1.0.0' });
    assert.notStrictEqual(hash1, hash2);
  });

  it('handles empty dependencies object', () => {
    const result = computeDependencyHash({});
    assert.strictEqual(result, '0');
  });

  it('handles multiple dependencies', () => {
    const result = computeDependencyHash({
      agentdev: '^0.2.3',
      '@agentdev/shell-feature': 'file:../shell',
      '@agentdev/audit-feature': 'file:../audit',
    });
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('produces deterministic hash for the same complex object', () => {
    const deps = {
      agentdev: '^0.2.3',
      '@agentdev/shell-feature': 'file:../shell',
    };
    assert.strictEqual(computeDependencyHash(deps), computeDependencyHash(deps));
  });
});
