import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFeatureRequirements,
  normalizeFeatureTypes,
  normalizeFeatureCompatibility,
  inferFeatureTypes,
  inferFeatureManifest,
  normalizeClawManifestV2,
} from '../server/routes/feature-repository.js';

// ── normalizeFeatureRequirements ────────────────────────────────────

describe('normalizeFeatureRequirements', () => {
  it('returns empty defaults for falsy input', () => {
    assert.deepStrictEqual(normalizeFeatureRequirements(), { platforms: [], node: '', external: [], services: [] });
  });
  it('returns empty defaults for non-object input', () => {
    assert.deepStrictEqual(normalizeFeatureRequirements('hello'), { platforms: [], node: '', external: [], services: [] });
  });
  it('normalizes valid input with unique strings', () => {
    const result = normalizeFeatureRequirements({ platforms: ['win32', 'darwin', 'win32'], node: '>=18.0.0', external: ['system-shell', 'audio-output'], services: ['network', 'network'] });
    assert.deepStrictEqual(result.platforms, ['win32', 'darwin']);
    assert.strictEqual(result.node, '>=18.0.0');
    assert.deepStrictEqual(result.external, ['system-shell', 'audio-output']);
    assert.deepStrictEqual(result.services, ['network']);
  });
  it('trims node version string', () => assert.strictEqual(normalizeFeatureRequirements({ node: '  >=20.0.0  ' }).node, '>=20.0.0'));
  it('handles non-string node field', () => assert.strictEqual(normalizeFeatureRequirements({ node: 42 }).node, ''));
});

describe('normalizeFeatureTypes', () => {
  it('filters to allowed types only', () => assert.deepStrictEqual(normalizeFeatureTypes(['tools', 'invalid', 'hooks', 'mcp', 'bad']), ['tools', 'hooks', 'mcp']));
  it('handles deduplication', () => assert.deepStrictEqual(normalizeFeatureTypes(['tools', 'tools', 'hooks']), ['tools', 'hooks']));
  it('allows legacy and Manifest v2 types', () => assert.deepStrictEqual(normalizeFeatureTypes(['tools', 'mcp', 'hooks', 'control', 'rollback', 'ability', 'governance', 'interface', 'system']), ['tools', 'mcp', 'hooks', 'control', 'rollback', 'ability', 'governance', 'interface', 'system']));
  it('handles falsy and non-array input', () => {
    assert.deepStrictEqual(normalizeFeatureTypes(), []);
    assert.deepStrictEqual(normalizeFeatureTypes(null), []);
    assert.deepStrictEqual(normalizeFeatureTypes('tools'), []);
    assert.deepStrictEqual(normalizeFeatureTypes(42), []);
  });
});

describe('normalizeFeatureCompatibility', () => {
  it('infers rollback from featureTypes when not explicitly set', () => assert.strictEqual(normalizeFeatureCompatibility({}, ['rollback', 'tools']).rollback, true));
  it('uses explicit rollback boolean over featureTypes inference', () => assert.strictEqual(normalizeFeatureCompatibility({ rollback: false }, ['rollback']).rollback, false));
  it('defaults rollback to false when neither is set', () => assert.strictEqual(normalizeFeatureCompatibility({}, ['tools']).rollback, false));
  it('adds rollback tags and merges existing tags', () => {
    assert.deepStrictEqual(normalizeFeatureCompatibility({ rollback: true, tags: ['custom-tag'] }).tags, ['custom-tag', 'supports-rollback']);
    assert.ok(normalizeFeatureCompatibility({ rollback: false }).tags.includes('no-rollback'));
  });
  it('handles non-object input', () => {
    const result = normalizeFeatureCompatibility('bad');
    assert.strictEqual(result.rollback, false);
    assert.ok(result.tags.includes('no-rollback'));
  });
});

describe('inferFeatureTypes', () => {
  it('returns tools for shell-like base IDs', () => {
    for (const id of ['my-shell-feature', 'websearch', 'visual-feature', 'tts', 'lsp-helper', 'memory']) assert.deepStrictEqual(inferFeatureTypes({}, id), ['tools']);
  });
  it('returns hooks for audio-feedback/audit/plugin-compat', () => {
    for (const id of ['audio-feedback', 'audit', 'plugin-compat']) assert.deepStrictEqual(inferFeatureTypes({}, id), ['hooks']);
  });
  it('returns hooks+control for qqbot', () => assert.deepStrictEqual(inferFeatureTypes({}, 'qqbot'), ['hooks', 'control']));
  it('returns empty for @sliverp/ scoped, unrecognized and falsy packages', () => {
    assert.deepStrictEqual(inferFeatureTypes({ name: '@sliverp/something' }, 'something'), []);
    assert.deepStrictEqual(inferFeatureTypes({ name: 'random-pkg' }, 'random'), []);
    assert.deepStrictEqual(inferFeatureTypes(null, null), []);
    assert.deepStrictEqual(inferFeatureTypes(undefined, undefined), []);
  });
  it('is case-insensitive for baseId matching', () => {
    assert.deepStrictEqual(inferFeatureTypes({}, 'SHELL'), ['tools']);
    assert.deepStrictEqual(inferFeatureTypes({}, 'QQBot'), ['hooks', 'control']);
  });
});

describe('inferFeatureManifest', () => {
  it('infers manifest from package.json with name', () => {
    const manifest = inferFeatureManifest({ name: '@agentdevjs/shell-feature', version: '1.2.3', description: 'Shell execution feature', main: 'dist/index.js', keywords: ['shell', 'tools'], homepage: 'https://example.com', repository: { url: 'git+https://github.com/repo.git' }, engines: { node: '>=18' }, peerDependencies: { agentdev: '^0.2.0' } }, 'shell-feature-1.2.3.tgz');
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
  it('infers feature types from baseId', () => assert.deepStrictEqual(inferFeatureManifest({ name: 'qqbot-feature' }, 'qqbot-feature.tgz').featureTypes, ['hooks', 'control']));
  it('infers network service for websearch/visual/tts or openai dependency', () => assert.ok(inferFeatureManifest({ name: 'my-websearch', dependencies: { openai: '^4.0.0' } }, 'my-websearch.tgz').requirements.services.includes('network')));
  it('infers audio-output external for audio/tts or sound-play dependency', () => assert.ok(inferFeatureManifest({ name: 'my-audio', dependencies: { 'sound-play': '^1.0.0' } }, 'my-audio.tgz').requirements.external.includes('audio-output')));
  it('infers desktop-capture for visual', () => assert.ok(inferFeatureManifest({ name: 'my-visual' }, 'my-visual.tgz').requirements.external.includes('desktop-capture')));
  it('infers language-server for lsp', () => assert.ok(inferFeatureManifest({ name: 'my-lsp' }, 'my-lsp.tgz').requirements.external.includes('language-server')));
  it('infers qqbot service for qqbot', () => assert.ok(inferFeatureManifest({ name: 'my-qqbot' }, 'my-qqbot.tgz').requirements.services.includes('qqbot')));
  it('handles repository as string', () => assert.strictEqual(inferFeatureManifest({ name: 'test', repository: 'https://github.com/repo.git' }, 'test.tgz').repository, 'https://github.com/repo.git'));
  it('handles falsy package input', () => {
    const manifest = inferFeatureManifest(null, 'fallback.tgz');
    assert.strictEqual(manifest.id, 'fallback');
    assert.strictEqual(manifest.version, '');
    assert.strictEqual(manifest.description, '');
  });
});

describe('normalizeClawManifestV2', () => {
  it('projects the Claw v2 package metadata without guessing from the package name', () => {
    const normalized = normalizeClawManifestV2({
      name: '@agentdevjs/ticket-feature',
      version: '1.2.3',
      description: 'Manage support tickets.',
      main: 'dist/index.js',
      keywords: ['agentdev', 'tickets'],
      homepage: 'https://example.com',
      repository: { url: 'https://example.com/repo' },
      engines: { agentdev: '^0.1.0' },
      agentdev: {
        schemaVersion: 2,
        id: 'ticket-feature',
        displayName: { zh: '工单管理', en: 'Ticket Management' },
        type: 'ability',
        capabilities: ['tools', 'policy'],
        provides: { tools: ['ticket_create'], skills: [], commands: [], hooks: true, mcp: false },
        depends: [{ id: 'storage', range: '^1.0.0' }],
        requirements: { platforms: ['win32'], node: '>=20', external: [], services: [] },
        compatibility: { rollback: false },
      },
    });
    assert.equal(normalized.id, 'ticket-feature');
    assert.deepEqual(normalized.displayName, { zh: '工单管理', en: 'Ticket Management' });
    assert.equal(normalized.type, 'ability');
    assert.deepEqual(normalized.capabilities, ['tools', 'policy']);
    assert.deepEqual(normalized.provides.tools, ['ticket_create']);
    assert.deepEqual(normalized.depends, [{ id: 'storage', range: '^1.0.0' }]);
    assert.deepEqual(normalized.requirements, { platforms: ['win32'], node: '>=20', external: [], services: [] });
    assert.deepEqual(normalized.agentdev, { compatible: '^0.1.0' });
  });
  it('does not treat incomplete or wrong-version metadata as v2', () => {
    assert.equal(normalizeClawManifestV2({ name: '@agentdevjs/ticket-feature', agentdev: { schemaVersion: 1 } }), null);
    assert.equal(normalizeClawManifestV2({ agentdev: { schemaVersion: 2 } }), null);
  });
});
