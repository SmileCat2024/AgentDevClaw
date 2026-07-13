/**
 * Tests for public/src/modules/feature-config.js
 *
 * Covers pure data-path helpers:
 *   - Config normalization (normalizeFeatureConfigEntry, normalizeFeatureConfigMap)
 *   - Config lookup/matching (buildFeatureConfigLookupKeys, featureConfigKeyMatches,
 *     findFeatureConfigMapEntry, removeMatchingFeatureConfigAliases)
 *   - Manifest helpers (resolveFeaturePackageRecord, findFeatureManifestForSelection,
 *     getFeatureManifestPropertyEntries, getFeatureManifestDisplayName,
 *     formatManifestDefaultValue, normalizeManifestComparableValue)
 *   - Status meta (getFeatureConfigStatusMeta)
 *   - Value coercion (coerceFeatureManifestValue, parseInlineDataValue)
 *   - File accept matching (normalizeAcceptList, matchesFeatureConfigAccept)
 *   - DOM ID generation (featureControlDomId)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadFeatureConfig() {
  const ctx = createFrontendSandbox({ currentLanguage: 'en' });
  ctx.loadSource('public/src/modules/feature-config.js');
  return ctx;
}

// ── normalizeFeatureConfigEntry ────────────────────────────────────

describe('feature-config: normalizeFeatureConfigEntry', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('returns empty object for null', () => {
    assert.deepEqual(fn('normalizeFeatureConfigEntry(null)'), {});
  });

  it('returns empty object for arrays', () => {
    assert.deepEqual(fn('normalizeFeatureConfigEntry([1,2])'), {});
  });

  it('returns empty object for primitives', () => {
    assert.deepEqual(fn('normalizeFeatureConfigEntry("hi")'), {});
  });

  it('clones a valid config object', () => {
    const result = fn('normalizeFeatureConfigEntry({ a: 1, b: "x" })');
    assert.deepEqual(result, { a: 1, b: 'x' });
  });

  it('filters out undefined values', () => {
    const result = fn('normalizeFeatureConfigEntry({ a: 1, b: undefined })');
    assert.deepEqual(result, { a: 1 });
  });

  it('filters out empty/whitespace keys', () => {
    const result = fn('normalizeFeatureConfigEntry({ "": 1, "  ": 2, valid: 3 })');
    assert.deepEqual(result, { valid: 3 });
  });

  it('keeps falsy values that are not undefined', () => {
    const result = fn('normalizeFeatureConfigEntry({ a: 0, b: false, c: "", d: null })');
    assert.deepEqual(result, { a: 0, b: false, c: '', d: null });
  });
});

// ── buildFeatureConfigLookupKeys ───────────────────────────────────

describe('feature-config: buildFeatureConfigLookupKeys', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('returns empty set for null/empty', () => {
    assert.equal(fn('buildFeatureConfigLookupKeys("").size'), 0);
    assert.equal(fn('buildFeatureConfigLookupKeys(null).size'), 0);
  });

  it('lowercases raw input', () => {
    const keys = fn('buildFeatureConfigLookupKeys("Shell")');
    assert.ok(keys.has('shell'));
  });

  it('strips @agentdev/ prefix and -feature suffix', () => {
    const keys = fn('buildFeatureConfigLookupKeys("@agentdev/shell-feature")');
    assert.ok(keys.has('shell'));
    assert.ok(keys.has('@agentdev/shell'));
    assert.ok(keys.has('@agentdev/shell-feature'));
  });

  it('handles name without -feature suffix', () => {
    const keys = fn('buildFeatureConfigLookupKeys("@agentdev/websearch")');
    assert.ok(keys.has('websearch'));
    assert.ok(keys.has('@agentdev/websearch'));
    assert.ok(keys.has('@agentdev/websearch-feature'));
  });

  it('trims whitespace', () => {
    const keys = fn('buildFeatureConfigLookupKeys("  audit  ")');
    assert.ok(keys.has('audit'));
  });
});

// ── featureConfigKeyMatches ────────────────────────────────────────

describe('feature-config: featureConfigKeyMatches', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('matches identical keys', () => {
    assert.equal(fn('featureConfigKeyMatches("shell", "shell")'), true);
  });

  it('matches with different casing', () => {
    assert.equal(fn('featureConfigKeyMatches("Shell", "SHELL")'), true);
  });

  it('matches scoped vs unscoped', () => {
    assert.equal(fn('featureConfigKeyMatches("@agentdev/shell-feature", "shell")'), true);
  });

  it('matches unscoped vs scoped', () => {
    assert.equal(fn('featureConfigKeyMatches("shell", "@agentdev/shell-feature")'), true);
  });

  it('does not match different features', () => {
    assert.equal(fn('featureConfigKeyMatches("shell", "audit")'), false);
  });

  it('returns false for empty refs', () => {
    assert.equal(fn('featureConfigKeyMatches("", "shell")'), false);
  });
});

// ── findFeatureConfigMapEntry ──────────────────────────────────────

describe('feature-config: findFeatureConfigMapEntry', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('returns null for null configs', () => {
    assert.equal(fn('findFeatureConfigMapEntry(null, "shell")'), null);
  });

  it('returns null for empty key', () => {
    assert.equal(fn('findFeatureConfigMapEntry({ shell: {} }, "")'), null);
  });

  it('finds exact match', () => {
    const result = fn('findFeatureConfigMapEntry({ shell: { enabled: true } }, "shell")');
    assert.deepEqual(result, { key: 'shell', value: { enabled: true } });
  });

  it('finds via alias match', () => {
    const result = fn('findFeatureConfigMapEntry({ "@agentdev/shell-feature": { x: 1 } }, "shell")');
    assert.ok(result);
    assert.equal(result.key, '@agentdev/shell-feature');
  });

  it('returns null when no match found', () => {
    assert.equal(fn('findFeatureConfigMapEntry({ shell: {} }, "audit")'), null);
  });

  it('normalizes the value entry', () => {
    const result = fn('findFeatureConfigMapEntry({ shell: { "": 1, valid: 2 } }, "shell")');
    assert.deepEqual(result.value, { valid: 2 });
  });
});

// ── removeMatchingFeatureConfigAliases ─────────────────────────────

describe('feature-config: removeMatchingFeatureConfigAliases', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('removes alias keys that match the target', () => {
    fn('var configs = { "@agentdev/shell-feature": { a: 1 }, "shell": { a: 1 } }');
    fn('removeMatchingFeatureConfigAliases(configs, "shell")');
    // "shell" is the target, alias "@agentdev/shell-feature" should be removed
    assert.equal(fn('"@agentdev/shell-feature" in configs'), false);
    assert.equal(fn('"shell" in configs'), true);
  });

  it('keeps non-matching keys', () => {
    fn('var configs2 = { shell: { a: 1 }, audit: { b: 2 } }');
    fn('removeMatchingFeatureConfigAliases(configs2, "shell")');
    assert.equal(fn('"audit" in configs2'), true);
    assert.equal(fn('"shell" in configs2'), true);
  });

  it('handles null configs gracefully', () => {
    // Should not throw
    fn('removeMatchingFeatureConfigAliases(null, "shell")');
  });
});

// ── normalizeFeatureConfigMap ──────────────────────────────────────

describe('feature-config: normalizeFeatureConfigMap', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('returns empty for null', () => {
    assert.deepEqual(fn('normalizeFeatureConfigMap(null)'), {});
  });

  it('normalizes all entries', () => {
    const result = fn('normalizeFeatureConfigMap({ shell: { a: 1 }, audit: { b: undefined } })');
    assert.deepEqual(result, { shell: { a: 1 } });
  });

  it('skips empty keys', () => {
    const result = fn('normalizeFeatureConfigMap({ "": { a: 1 }, valid: { b: 2 } })');
    assert.deepEqual(result, { valid: { b: 2 } });
  });

  it('trims keys', () => {
    const result = fn('normalizeFeatureConfigMap({ "  shell  ": { a: 1 } })');
    assert.deepEqual(result, { shell: { a: 1 } });
  });
});

// ── resolveFeaturePackageRecord ────────────────────────────────────

describe('feature-config: resolveFeaturePackageRecord', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('returns null for empty token', () => {
    assert.equal(fn('resolveFeaturePackageRecord([], "")'), null);
  });

  it('returns null for empty packages', () => {
    assert.equal(fn('resolveFeaturePackageRecord([], "shell")'), null);
  });

  it('finds by packageName', () => {
    const result = fn('resolveFeaturePackageRecord([{ packageName: "@agentdev/shell-feature" }], "shell")');
    assert.ok(result);
    assert.equal(result.packageName, '@agentdev/shell-feature');
  });

  it('finds by name', () => {
    const result = fn('resolveFeaturePackageRecord([{ name: "shell" }], "shell")');
    assert.ok(result);
    assert.equal(result.name, 'shell');
  });

  it('finds by id', () => {
    const result = fn('resolveFeaturePackageRecord([{ id: "audit" }], "audit")');
    assert.ok(result);
    assert.equal(result.id, 'audit');
  });

  it('returns null when not found', () => {
    assert.equal(fn('resolveFeaturePackageRecord([{ name: "shell" }], "audit")'), null);
  });
});

// ── getFeatureManifestPropertyEntries ──────────────────────────────

describe('feature-config: getFeatureManifestPropertyEntries', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('returns empty array for null manifest', () => {
    assert.deepEqual(fn('getFeatureManifestPropertyEntries(null)'), []);
  });

  it('returns empty array when no properties', () => {
    assert.deepEqual(fn('getFeatureManifestPropertyEntries({ settings: {} })'), []);
  });

  it('extracts properties as entries', () => {
    const result = fn('getFeatureManifestPropertyEntries({ settings: { properties: { foo: { type: "string" }, bar: { type: "boolean" } } } })');
    assert.equal(result.length, 2);
  });

  it('filters empty keys and non-object values', () => {
    const result = fn('getFeatureManifestPropertyEntries({ settings: { properties: { "": {}, valid: null, ok: { type: "string" } } } })');
    assert.equal(result.length, 1);
  });
});

// ── getFeatureManifestDisplayName ──────────────────────────────────

describe('feature-config: getFeatureManifestDisplayName', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('uses pkg.name first', () => {
    assert.equal(fn('getFeatureManifestDisplayName("tok", { name: "@agentdev/shell-feature" }, null)'), 'shell');
  });

  it('falls back to manifest.featureName', () => {
    assert.equal(fn('getFeatureManifestDisplayName("tok", null, { featureName: "@agentdev/audit-feature" })'), 'audit');
  });

  it('falls back to token', () => {
    assert.equal(fn('getFeatureManifestDisplayName("websearch", null, null)'), 'websearch');
  });

  it('returns empty for all empty', () => {
    assert.equal(fn('getFeatureManifestDisplayName("", null, {})'), '');
  });
});

// ── formatManifestDefaultValue ─────────────────────────────────────

describe('feature-config: formatManifestDefaultValue', () => {
  const ctx = loadFeatureConfig();

  it('returns "No default" when no default property exists', () => {
    assert.equal(ctx.run('formatManifestDefaultValue({ type: "string" })'), 'No default');
  });

  it('formats boolean true', () => {
    assert.equal(ctx.run('formatManifestDefaultValue({ type: "boolean", default: true })'), 'true');
  });

  it('formats boolean false', () => {
    assert.equal(ctx.run('formatManifestDefaultValue({ type: "boolean", default: false })'), 'false');
  });

  it('formats directory with array default', () => {
    assert.equal(ctx.run('formatManifestDefaultValue({ type: "directory", default: ["/a", "/b"] })'), '/a, /b');
  });

  it('formats directory with empty array default', () => {
    assert.equal(ctx.run('formatManifestDefaultValue({ type: "directory", default: [] })'), 'Empty');
  });

  it('formats empty string default as "Empty"', () => {
    assert.equal(ctx.run('formatManifestDefaultValue({ type: "string", default: "" })'), 'Empty');
  });

  it('formats number default', () => {
    assert.equal(ctx.run('formatManifestDefaultValue({ type: "number", default: 42 })'), '42');
  });

  it('formats string default', () => {
    assert.equal(ctx.run('formatManifestDefaultValue({ type: "string", default: "hello" })'), 'hello');
  });
});

// ── normalizeManifestComparableValue ───────────────────────────────

describe('feature-config: normalizeManifestComparableValue', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('normalizes number type', () => {
    assert.equal(fn('normalizeManifestComparableValue("number", "42")'), 42);
    assert.equal(fn('normalizeManifestComparableValue("number", "abc")'), null);
    assert.equal(fn('normalizeManifestComparableValue("number", 3.14)'), 3.14);
  });

  it('normalizes boolean type', () => {
    assert.equal(fn('normalizeManifestComparableValue("boolean", true)'), true);
    assert.equal(fn('normalizeManifestComparableValue("boolean", "true")'), true);
    assert.equal(fn('normalizeManifestComparableValue("boolean", 1)'), true);
    assert.equal(fn('normalizeManifestComparableValue("boolean", "1")'), true);
    assert.equal(fn('normalizeManifestComparableValue("boolean", false)'), false);
    assert.equal(fn('normalizeManifestComparableValue("boolean", 0)'), false);
    assert.equal(fn('normalizeManifestComparableValue("boolean", "no")'), false);
  });

  it('normalizes directory type with sorted join', () => {
    assert.equal(fn('normalizeManifestComparableValue("directory", ["/b", "/a"])'), '/a|/b');
    assert.equal(fn('normalizeManifestComparableValue("directory", [])'), '');
    assert.equal(fn('normalizeManifestComparableValue("directory", "not-array")'), '');
  });

  it('normalizes file type with sorted join', () => {
    assert.equal(fn('normalizeManifestComparableValue("file", ["z.txt", "a.txt"])'), 'a.txt|z.txt');
  });

  it('normalizes string type (trimmed)', () => {
    assert.equal(fn('normalizeManifestComparableValue("string", "  hello  ")'), 'hello');
    assert.equal(fn('normalizeManifestComparableValue("string", null)'), '');
  });
});

// ── getFeatureConfigStatusMeta ─────────────────────────────────────

describe('feature-config: getFeatureConfigStatusMeta', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('returns zero overrides when config matches defaults', () => {
    const manifest = '{ settings: { properties: { foo: { type: "string", default: "bar" } } } }';
    const config = '{ foo: "bar" }';
    const result = fn(`getFeatureConfigStatusMeta(${manifest}, ${config})`);
    assert.equal(result.overriddenCount, 0);
    assert.equal(result.customized, false);
  });

  it('detects override when value differs from default', () => {
    const manifest = '{ settings: { properties: { foo: { type: "string", default: "bar" } } } }';
    const config = '{ foo: "baz" }';
    const result = fn(`getFeatureConfigStatusMeta(${manifest}, ${config})`);
    assert.equal(result.overriddenCount, 1);
    assert.equal(result.customized, true);
  });

  it('ignores fields not in manifest', () => {
    const manifest = '{ settings: { properties: { foo: { type: "string", default: "bar" } } } }';
    const config = '{ foo: "bar", unknown: "x" }';
    const result = fn(`getFeatureConfigStatusMeta(${manifest}, ${config})`);
    assert.equal(result.overriddenCount, 0);
  });

  it('handles empty manifest', () => {
    const result = fn('getFeatureConfigStatusMeta(null, { foo: 1 })');
    assert.equal(result.overriddenCount, 0);
  });

  it('handles empty config', () => {
    const manifest = '{ settings: { properties: { foo: { type: "string", default: "bar" } } } }';
    const result = fn(`getFeatureConfigStatusMeta(${manifest}, {})`);
    assert.equal(result.overriddenCount, 0);
  });
});

// ── coerceFeatureManifestValue ─────────────────────────────────────

describe('feature-config: coerceFeatureManifestValue', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('coerces boolean', () => {
    assert.equal(fn('coerceFeatureManifestValue("boolean", true)'), true);
    assert.equal(fn('coerceFeatureManifestValue("boolean", "")'), false);
    assert.equal(fn('coerceFeatureManifestValue("boolean", "anything")'), true);
  });

  it('coerces number', () => {
    assert.equal(fn('coerceFeatureManifestValue("number", "42")'), 42);
    assert.equal(fn('coerceFeatureManifestValue("number", "")'), undefined);
    assert.equal(fn('coerceFeatureManifestValue("number", "abc")'), undefined);
  });

  it('coerces directory from array', () => {
    assert.deepEqual(fn('coerceFeatureManifestValue("directory", ["/a", "", "/b"])'), ['/a', '/b']);
  });

  it('coerces directory from string', () => {
    assert.deepEqual(fn('coerceFeatureManifestValue("directory", "/path")'), ['/path']);
    assert.deepEqual(fn('coerceFeatureManifestValue("directory", "")'), []);
  });

  it('coerces file from array', () => {
    assert.deepEqual(fn('coerceFeatureManifestValue("file", ["a.txt", "", "b.txt"])'), ['a.txt', 'b.txt']);
  });

  it('coerces string (trimmed)', () => {
    assert.equal(fn('coerceFeatureManifestValue("string", "  hello  ")'), 'hello');
    assert.equal(fn('coerceFeatureManifestValue("string", "")'), undefined);
  });
});

// ── parseInlineDataValue ───────────────────────────────────────────

describe('feature-config: parseInlineDataValue', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('returns empty string for null', () => {
    assert.equal(fn('parseInlineDataValue(null)'), '');
  });

  it('parses JSON', () => {
    assert.deepEqual(fn('parseInlineDataValue(\'["a","b"]\')'), ['a', 'b']);
  });

  it('returns raw string when JSON parse fails', () => {
    assert.equal(fn('parseInlineDataValue("not-json")'), 'not-json');
  });

  it('parses number string', () => {
    assert.equal(fn('parseInlineDataValue("42")'), 42);
  });
});

// ── normalizeAcceptList ────────────────────────────────────────────

describe('feature-config: normalizeAcceptList', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('handles string input', () => {
    assert.deepEqual(fn('normalizeAcceptList(".ts")'), ['.ts']);
  });

  it('handles comma-separated string', () => {
    assert.deepEqual(fn('normalizeAcceptList(".ts, .js, .json")'), ['.ts', '.js', '.json']);
  });

  it('handles array input', () => {
    assert.deepEqual(fn('normalizeAcceptList([".ts", ".js"])'), ['.ts', '.js']);
  });

  it('lowercases and trims', () => {
    assert.deepEqual(fn('normalizeAcceptList([" .TS "])'), ['.ts']);
  });

  it('filters empty values', () => {
    assert.deepEqual(fn('normalizeAcceptList(["", ".ts", ""])'), ['.ts']);
  });
});

// ── matchesFeatureConfigAccept ─────────────────────────────────────

describe('feature-config: matchesFeatureConfigAccept', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('matches extension rules', () => {
    assert.equal(fn('matchesFeatureConfigAccept("file.ts", ".ts")'), true);
    assert.equal(fn('matchesFeatureConfigAccept("file.js", ".ts")'), false);
  });

  it('matches audio/* wildcard', () => {
    assert.equal(fn('matchesFeatureConfigAccept("song.mp3", "audio/*")'), true);
    assert.equal(fn('matchesFeatureConfigAccept("song.wav", "audio/*")'), true);
    assert.equal(fn('matchesFeatureConfigAccept("doc.pdf", "audio/*")'), false);
  });

  it('matches MIME types', () => {
    assert.equal(fn('matchesFeatureConfigAccept("image.png", "image/png")'), true);
  });

  it('returns true when accept list is empty', () => {
    assert.equal(fn('matchesFeatureConfigAccept("file.ts", [])'), true);
  });

  it('returns true when path is empty', () => {
    assert.equal(fn('matchesFeatureConfigAccept("", ".ts")'), true);
  });
});

// ── featureControlDomId ────────────────────────────────────────────

describe('feature-config: featureControlDomId', () => {
  const ctx = loadFeatureConfig();
  const fn = ctx.run;

  it('generates prefixed DOM id', () => {
    assert.equal(fn('featureControlDomId("shell", "enabled")'), 'fw-manifest-shell__enabled');
  });

  it('includes suffix when provided', () => {
    assert.equal(fn('featureControlDomId("shell", "port", "range")'), 'fw-manifest-shell__port__range');
  });

  it('replaces special characters with dashes', () => {
    assert.equal(fn('featureControlDomId("@agentdev/shell-feature", "my.field")'), 'fw-manifest--agentdev-shell-feature__my-field');
  });

  it('handles empty inputs', () => {
    assert.equal(fn('featureControlDomId("", "")'), 'fw-manifest-__');
  });
});
