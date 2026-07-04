import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFeatureRequirements,
  normalizeFeatureTypes,
  normalizeFeatureCompatibility,
  inferFeatureTypes,
  inferFeatureManifest,
} from '../server/routes/feature-repository.js';

// ── normalizeFeatureRequirements ────────────────────────────────────

describe('normalizeFeatureRequirements', () => {
  it('returns empty defaults for falsy input', () => {
    assert.deepStrictEqual(normalizeFeatureRequirements(), {
      platforms: [],
      node: '',
      external: [],
      services: [],
    });
  });

  it('returns empty defaults for non-object input', () => {
    assert.deepStrictEqual(normalizeFeatureRequirements('hello'), {
      platforms: [],
      node: '',
      external: [],
      services: [],
    });
  });

  it('normalizes valid input with unique strings', () => {
    const result = normalizeFeatureRequirements({
      platforms: ['win32', 'darwin', 'win32'],
      node: '>=18.0.0',
      external: ['system-shell', 'audio-output'],
      services: ['network', 'network'],
    });
    assert.deepStrictEqual(result.platforms, ['win32', 'darwin']);
    assert.strictEqual(result.node, '>=18.0.0');
    assert.deepStrictEqual(result.external, ['system-shell', 'audio-output']);
    assert.deepStrictEqual(result.services, ['network']);
  });

  it('trims node version string', () => {
    const result = normalizeFeatureRequirements({ node: '  >=20.0.0  ' });
    assert.strictEqual(result.node, '>=20.0.0');
  });

  it('handles non-string node field', () => {
    const result = normalizeFeatureRequirements({ node: 42 });
    assert.strictEqual(result.node, '');
  });
});

// ── normalizeFeatureTypes ───────────────────────────────────────────

describe('normalizeFeatureTypes', () => {
  it('filters to allowed types only', () => {
    const result = normalizeFeatureTypes(['tools', 'invalid', 'hooks', 'mcp', 'bad']);
    assert.deepStrictEqual(result, ['tools', 'hooks', 'mcp']);
  });

  it('handles deduplication', () => {
    const result = normalizeFeatureTypes(['tools', 'tools', 'hooks']);
    assert.deepStrictEqual(result, ['tools', 'hooks']);
  });

  it('allows all valid types', () => {
    const result = normalizeFeatureTypes(['tools', 'mcp', 'hooks', 'control', 'rollback']);
    assert.deepStrictEqual(result, ['tools', 'mcp', 'hooks', 'control', 'rollback']);
  });

  it('handles falsy input', () => {
    assert.deepStrictEqual(normalizeFeatureTypes(), []);
    assert.deepStrictEqual(normalizeFeatureTypes(null), []);
  });

  it('handles non-array input (coerced to empty)', () => {
    // uniqueStrings only accepts arrays; non-array input yields empty
    assert.deepStrictEqual(normalizeFeatureTypes('tools'), []);
    assert.deepStrictEqual(normalizeFeatureTypes(42), []);
  });
});

// ── normalizeFeatureCompatibility ───────────────────────────────────

describe('normalizeFeatureCompatibility', () => {
  it('infers rollback from featureTypes when not explicitly set', () => {
    const result = normalizeFeatureCompatibility({}, ['rollback', 'tools']);
    assert.strictEqual(result.rollback, true);
  });

  it('uses explicit rollback boolean over featureTypes inference', () => {
    const result = normalizeFeatureCompatibility({ rollback: false }, ['rollback']);
    assert.strictEqual(result.rollback, false);
  });

  it('defaults rollback to false when neither is set', () => {
    const result = normalizeFeatureCompatibility({}, ['tools']);
    assert.strictEqual(result.rollback, false);
  });

  it('adds supports-rollback tag when rollback is true', () => {
    const result = normalizeFeatureCompatibility({ rollback: true });
    assert.ok(result.tags.includes('supports-rollback'));
  });

  it('adds no-rollback tag when rollback is false', () => {
    const result = normalizeFeatureCompatibility({ rollback: false });
    assert.ok(result.tags.includes('no-rollback'));
  });

  it('merges existing tags with rollback tag', () => {
    const result = normalizeFeatureCompatibility({ rollback: true, tags: ['custom-tag'] });
    assert.ok(result.tags.includes('custom-tag'));
    assert.ok(result.tags.includes('supports-rollback'));
  });

  it('handles non-object input', () => {
    const result = normalizeFeatureCompatibility('bad');
    assert.strictEqual(result.rollback, false);
    assert.ok(result.tags.includes('no-rollback'));
  });
});

// ── inferFeatureTypes ───────────────────────────────────────────────

describe('inferFeatureTypes', () => {
  it('returns tools for shell-like base IDs', () => {
    assert.deepStrictEqual(inferFeatureTypes({ name: 'test' }, 'my-shell-feature'), ['tools']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'websearch'), ['tools']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'visual-feature'), ['tools']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'tts'), ['tools']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'lsp-helper'), ['tools']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'memory'), ['tools']);
  });

  it('returns hooks for audio-feedback/audit/plugin-compat', () => {
    assert.deepStrictEqual(inferFeatureTypes({}, 'audio-feedback'), ['hooks']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'audit'), ['hooks']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'plugin-compat'), ['hooks']);
  });

  it('returns hooks+control for qqbot', () => {
    assert.deepStrictEqual(inferFeatureTypes({}, 'qqbot'), ['hooks', 'control']);
  });

  it('returns empty for @sliverp/ scoped packages', () => {
    assert.deepStrictEqual(inferFeatureTypes({ name: '@sliverp/something' }, 'something'), []);
  });

  it('returns empty for unrecognized packages', () => {
    assert.deepStrictEqual(inferFeatureTypes({ name: 'random-pkg' }, 'random'), []);
  });

  it('handles falsy inputs gracefully', () => {
    assert.deepStrictEqual(inferFeatureTypes(null, null), []);
    assert.deepStrictEqual(inferFeatureTypes(undefined, undefined), []);
  });

  it('is case-insensitive for baseId matching', () => {
    assert.deepStrictEqual(inferFeatureTypes({}, 'SHELL'), ['tools']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'QQBot'), ['hooks', 'control']);
  });
});

// ── inferFeatureManifest ────────────────────────────────────────────

describe('inferFeatureManifest', () => {
  it('infers manifest from package.json with name', () => {
    const manifest = inferFeatureManifest({
      name: '@agentdev/shell-feature',
      version: '1.2.3',
      description: 'Shell execution feature',
      main: 'dist/index.js',
      keywords: ['shell', 'tools'],
      homepage: 'https://example.com',
      repository: { url: 'git+https://github.com/repo.git' },
      engines: { node: '>=18' },
      peerDependencies: { agentdev: '^0.2.0' },
    }, 'shell-feature-1.2.3.tgz');

    assert.strictEqual(manifest.id, 'shell-feature');
    assert.strictEqual(manifest.name, 'shell-feature');
    assert.strictEqual(manifest.version, '1.2.3');
    assert.strictEqual(manifest.description, 'Shell execution feature');
    assert.strictEqual(manifest.entry, 'dist/index.js');
    assert.strictEqual(manifest.schemaVersion, 1);
    assert.ok(manifest.tags.includes('shell'));
    assert.ok(manifest.tags.includes('tools'));
    assert.strictEqual(manifest.agentdev.compatible, '^0.2.0');
    assert.strictEqual(manifest.homepage, 'https://example.com');
    assert.strictEqual(manifest.repository, 'git+https://github.com/repo.git');
    assert.strictEqual(manifest.requirements.node, '>=18');
    assert.ok(manifest.requirements.external.includes('system-shell'));
  });

  it('falls back to archive name when package has no name', () => {
    const manifest = inferFeatureManifest({}, 'unknown-feature-0.1.0.tgz');
    assert.strictEqual(manifest.id, 'unknown-feature-0.1.0');
    assert.strictEqual(manifest.name, 'unknown-feature-0.1.0');
  });

  it('infers feature types from baseId', () => {
    const manifest = inferFeatureManifest({ name: 'qqbot-feature' }, 'qqbot-feature.tgz');
    assert.deepStrictEqual(manifest.featureTypes, ['hooks', 'control']);
  });

  it('infers network service for websearch/visual/tts or openai dependency', () => {
    const manifest = inferFeatureManifest({
      name: 'my-websearch',
      dependencies: { openai: '^4.0.0' },
    }, 'my-websearch.tgz');
    assert.ok(manifest.requirements.services.includes('network'));
  });

  it('infers audio-output external for audio/tts or sound-play dependency', () => {
    const manifest = inferFeatureManifest({
      name: 'my-audio',
      dependencies: { 'sound-play': '^1.0.0' },
    }, 'my-audio.tgz');
    assert.ok(manifest.requirements.external.includes('audio-output'));
  });

  it('infers desktop-capture for visual', () => {
    const manifest = inferFeatureManifest({ name: 'my-visual' }, 'my-visual.tgz');
    assert.ok(manifest.requirements.external.includes('desktop-capture'));
  });

  it('infers language-server for lsp', () => {
    const manifest = inferFeatureManifest({ name: 'my-lsp' }, 'my-lsp.tgz');
    assert.ok(manifest.requirements.external.includes('language-server'));
  });

  it('infers qqbot service for qqbot', () => {
    const manifest = inferFeatureManifest({ name: 'my-qqbot' }, 'my-qqbot.tgz');
    assert.ok(manifest.requirements.services.includes('qqbot'));
  });

  it('handles repository as string', () => {
    const manifest = inferFeatureManifest({
      name: 'test',
      repository: 'https://github.com/repo.git',
    }, 'test.tgz');
    assert.strictEqual(manifest.repository, 'https://github.com/repo.git');
  });

  it('handles falsy package input', () => {
    const manifest = inferFeatureManifest(null, 'fallback.tgz');
    assert.strictEqual(manifest.id, 'fallback');
    assert.strictEqual(manifest.version, '');
    assert.strictEqual(manifest.description, '');
  });
});
