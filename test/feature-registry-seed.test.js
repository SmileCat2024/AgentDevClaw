/**
 * Tests for server/shared/feature-registry.js (seed loading & validation)
 *
 * - 真实 seed 通过校验（含 capabilities / provenances 词表回传）
 * - 各校验分支对坏 seed 显式 throw（不静默回退）
 *
 * 坏 seed 写入临时目录，不触碰真实用户数据。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadFeatureRegistry } from '../server/shared/feature-registry.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-registry-test-'));

function writeSeed(obj) {
  const p = path.join(tmpDir, 'seed-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('feature-registry: loadFeatureRegistry', () => {
  it('loads the real seed and echoes vocabularies in the response', () => {
    const registry = loadFeatureRegistry();
    assert.equal(registry.schemaVersion, 1);
    assert.ok(registry.features.length > 0);
    assert.ok(registry.capabilities.some(c => c.id === 'tools'));
    assert.deepEqual(registry.provenances, ['ecosystem', 'local', 'builtin', 'inline', 'packaged']);
    assert.ok(registry.features.every(f => f.displayName && Array.isArray(f.capabilities) && f.provenance));
  });

  it('rejects wrong schemaVersion', () => {
    const p = writeSeed({ schemaVersion: 2, features: [] });
    assert.throws(() => loadFeatureRegistry(p), /schemaVersion/);
  });

  it('rejects non-array features', () => {
    const p = writeSeed({ schemaVersion: 1, features: {} });
    assert.throws(() => loadFeatureRegistry(p), /features.*array/);
  });

  it('rejects malformed names (non-kebab or trailing/double dash)', () => {
    for (const bad of ['Foo', 'foo-', 'foo--bar', 'foo_bar', '']) {
      const p = writeSeed({ schemaVersion: 1, features: [{ name: bad, displayName: 'X', capabilities: ['tools'], provenance: 'local' }] });
      assert.throws(() => loadFeatureRegistry(p), /name/, 'name=' + bad);
    }
  });

  it('rejects duplicate names', () => {
    const entry = { name: 'dup', displayName: 'X', capabilities: ['tools'], provenance: 'local' };
    const p = writeSeed({ schemaVersion: 1, features: [entry, entry] });
    assert.throws(() => loadFeatureRegistry(p), /duplicate/);
  });

  it('rejects missing, empty, or unknown capabilities', () => {
    for (const caps of [undefined, [], ['no-such-cap'], 'tools']) {
      const p = writeSeed({ schemaVersion: 1, features: [{ name: 'x', displayName: 'X', capabilities: caps, provenance: 'local' }] });
      assert.throws(() => loadFeatureRegistry(p), /capabilities/, 'capabilities=' + JSON.stringify(caps));
    }
  });

  it('rejects unknown provenance', () => {
    const p = writeSeed({ schemaVersion: 1, features: [{ name: 'x', displayName: 'X', capabilities: ['tools'], provenance: 'mystery' }] });
    assert.throws(() => loadFeatureRegistry(p), /provenance/);
  });

  it('rejects missing or malformed displayName', () => {
    for (const dn of [undefined, '', '   ', { zh: '只中文' }, 42]) {
      const p = writeSeed({ schemaVersion: 1, features: [{ name: 'x', displayName: dn, capabilities: ['tools'], provenance: 'local' }] });
      assert.throws(() => loadFeatureRegistry(p), /displayName/);
    }
  });
});
