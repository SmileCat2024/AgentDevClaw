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
    // 功能类型词表（面板主分组轴）：四类有序，默认全展开
    assert.deepEqual(registry.types, [
      { id: 'ability', collapsed: false },
      { id: 'governance', collapsed: false },
      { id: 'interface', collapsed: false },
      { id: 'system', collapsed: false },
    ]);
    assert.ok(registry.features.every(f => registry.types.some(t => t.id === f.type)),
      'every entry carries a known type');
    // 来源过滤器：细粒度 provenance 全部映射到 bundled/installed，词表顺序 installed 在前
    assert.deepEqual(registry.groups, ['installed', 'bundled']);
    assert.ok(registry.features.every(f => f.group === 'bundled' || f.group === 'installed'),
      'every entry carries a display group');
    const grouped = new Map(registry.features.map(f => [f.provenance, f.group]));
    for (const [prov, group] of grouped) {
      if (prov === 'packaged') assert.equal(group, 'installed');
      else assert.equal(group, 'bundled', `${prov} should map to bundled`);
    }
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
    const entry = { name: 'dup', displayName: 'X', type: 'ability', capabilities: ['tools'], provenance: 'local' };
    const p = writeSeed({ schemaVersion: 1, features: [entry, entry] });
    assert.throws(() => loadFeatureRegistry(p), /duplicate/);
  });

  it('rejects missing or unknown capabilities; empty array is allowed (pure-runtime features)', () => {
    // 空 capabilities 合法：纯网关/协议件可观测维度全由运行时推导，seed 无可标注项
    const emptyOk = writeSeed({ schemaVersion: 1, features: [{ name: 'x', displayName: 'X', type: 'interface', capabilities: [], provenance: 'local' }] });
    assert.doesNotThrow(() => loadFeatureRegistry(emptyOk));
    for (const caps of [undefined, ['no-such-cap'], ['gateway'], ['protocol'], 'tools']) {
      const p = writeSeed({ schemaVersion: 1, features: [{ name: 'x', displayName: 'X', capabilities: caps, provenance: 'local' }] });
      assert.throws(() => loadFeatureRegistry(p), /capabilities/, 'capabilities=' + JSON.stringify(caps));
    }
  });

  it('rejects unknown provenance', () => {
    const p = writeSeed({ schemaVersion: 1, features: [{ name: 'x', displayName: 'X', type: 'ability', capabilities: ['tools'], provenance: 'wat' }] });
    assert.throws(() => loadFeatureRegistry(p), /unknown provenance/);
  });

  it('rejects unknown type', () => {
    const p = writeSeed({ schemaVersion: 1, features: [{ name: 'x', displayName: 'X', type: 'wat', capabilities: ['tools'], provenance: 'local' }] });
    assert.throws(() => loadFeatureRegistry(p), /unknown type/);
  });

  it('rejects missing or malformed displayName', () => {
    for (const dn of [undefined, '', '   ', { zh: '只中文' }, 42]) {
      const p = writeSeed({ schemaVersion: 1, features: [{ name: 'x', displayName: dn, type: 'ability', capabilities: ['tools'], provenance: 'local' }] });
      assert.throws(() => loadFeatureRegistry(p), /displayName/);
    }
  });
});
