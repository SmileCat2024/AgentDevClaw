/**
 * Tests for public/src/modules/feature-catalog.js (P1 panel visibility)
 *
 * Covers pure grouping/enrichment helpers:
 *   - groupFeaturesByCategory: order 排序、空组剔除、兜底进 _unmapped
 *   - enrichFeatureEntry: seed 命中/未命中、原字段保留
 *   - resolveDisplayName: {zh,en} / string / 缺失回退 name 三态
 *   - provenanceI18nKey: 已知词表 / 未知值
 *
 * 方案：docs/plans/2026-09-13-feature-registry-p1-panel-visibility.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadModule() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/feature-catalog.js');
  return ctx;
}

const CATALOG = {
  schemaVersion: 1,
  categories: [
    { id: 'tools', order: 1, defaultOpen: true },
    { id: 'gateway', order: 5, defaultOpen: true },
    { id: 'protocol', order: 7, defaultOpen: false },
    { id: '_unmapped', order: 8, defaultOpen: true },
  ],
  features: [
    { name: 'shell', displayName: { zh: 'Shell 执行', en: 'Shell' }, category: 'tools', provenance: 'ecosystem' },
    { name: 'qqbot', displayName: { zh: 'QQ 渠道', en: 'QQ Channel' }, category: 'gateway', provenance: 'ecosystem' },
    { name: 'claw-dispatch', displayName: '调度', category: 'protocol', provenance: 'local' },
  ],
};

function inspectorFeature(name, extra = {}) {
  return { name, source: 'src/' + name + '.ts', description: 'd', hookCount: 1, enabledToolCount: 2, toolCount: 3, ...extra };
}

// ── groupFeaturesByCategory ────────────────────────────────────────

describe('feature-catalog: groupFeaturesByCategory', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('groups by category, sorted by order, empty groups dropped', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByCategory(
      [ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('qqbot'))}, ${JSON.stringify(inspectorFeature('claw-dispatch'))} ],
      ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(JSON.stringify(groups.map(g => g.category)), JSON.stringify(['tools', 'gateway', 'protocol']));
    assert.equal(groups[0].features.length, 1);
    assert.equal(groups[0].defaultOpen, true);
    assert.equal(groups[2].defaultOpen, false);
  });

  it('unmapped features land in _unmapped with mapped:false', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByCategory(
      [ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('brand-new-feature'))} ],
      ${JSON.stringify(CATALOG)}
    )`);
    const unmapped = groups.find(g => g.category === '_unmapped');
    assert.ok(unmapped, 'unmapped group present');
    assert.equal(unmapped.features.length, 1);
    assert.equal(unmapped.features[0].name, 'brand-new-feature');
    assert.equal(unmapped.features[0].mapped, false);
    assert.equal(unmapped.features[0].provenance, null);
  });

  it('null catalog sends all features to _unmapped', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByCategory(
      [ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('qqbot'))} ], null
    )`);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].category, '_unmapped');
    assert.equal(groups[0].features.length, 2);
    assert.equal(groups[0].features.every(f => f.mapped === false), true);
  });

  it('empty features input returns empty group array', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByCategory([], ${JSON.stringify(CATALOG)})`);
    assert.equal(groups.length, 0);
    assert.equal(fn('window.ClawFW.featureCatalog.groupFeaturesByCategory(undefined, null)').length, 0);
  });

  it('seed category outside the response vocabulary lands in _unmapped (never hidden)', () => {
    const drifted = {
      ...CATALOG,
      features: [{ name: 'drift', displayName: 'D', category: 'no-such-cat', provenance: 'ecosystem' }],
    };
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByCategory(
      [ ${JSON.stringify(inspectorFeature('drift'))} ], ${JSON.stringify(drifted)}
    )`);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].category, '_unmapped');
    assert.equal(groups[0].features[0].name, 'drift');
    assert.equal(groups[0].features[0].mapped, true);
  });

  it('categories are sorted by order even if the catalog lists them unordered', () => {
    const shuffled = {
      ...CATALOG,
      categories: [...CATALOG.categories].sort((a, b) => b.order - a.order),
    };
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByCategory(
      [ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('qqbot'))} ],
      ${JSON.stringify(shuffled)}
    )`);
    assert.equal(JSON.stringify(groups.map(g => g.category)), JSON.stringify(['tools', 'gateway']));
  });
});

// ── enrichFeatureEntry ─────────────────────────────────────────────

describe('feature-catalog: enrichFeatureEntry', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('mapped entry carries seed metadata and keeps original fields', () => {
    const entry = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('shell', { hookCount: 7 }))}, ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(entry.mapped, true);
    assert.equal(entry.category, 'tools');
    assert.equal(entry.provenance, 'ecosystem');
    // 逐字段断言：VM 跨 realm 对象与主 realm prototype 不同，deepStrictEqual 不适用
    assert.equal(entry.displayName.zh, 'Shell 执行');
    assert.equal(entry.displayName.en, 'Shell');
    assert.equal(entry.hookCount, 7, 'original inspector fields preserved');
    assert.equal(entry.source, 'src/shell.ts');
  });

  it('unmatched feature falls back to _unmapped with displayName undefined', () => {
    const entry = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('ghost'))}, ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(entry.mapped, false);
    assert.equal(entry.category, '_unmapped');
    assert.equal(entry.provenance, null);
    assert.equal(entry.displayName, undefined);
  });
});

// ── resolveDisplayName ─────────────────────────────────────────────

describe('feature-catalog: resolveDisplayName', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('resolves {zh,en} object by language', () => {
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName({ displayName: { zh: '甲', en: 'A' }, name: 'x' }, 'zh')`), '甲');
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName({ displayName: { zh: '甲', en: 'A' }, name: 'x' }, 'en')`), 'A');
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName({ displayName: { zh: '甲', en: 'A' }, name: 'x' }, 'fr')`), 'A');
  });

  it('returns plain string displayName as-is', () => {
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName({ displayName: '调度', name: 'x' }, 'zh')`), '调度');
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName({ displayName: '调度', name: 'x' }, 'en')`), '调度');
  });

  it('falls back to name when displayName missing/empty/malformed', () => {
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName({ name: 'shell' }, 'zh')`), 'shell');
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName({ displayName: '', name: 'shell' }, 'zh')`), 'shell');
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName({ displayName: { zh: '甲' }, name: 'shell' }, 'zh')`), 'shell');
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveDisplayName(null, 'zh')`), '');
  });
});

// ── provenanceI18nKey ──────────────────────────────────────────────

describe('feature-catalog: provenanceI18nKey', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('maps provenances in the server-provided vocabulary to i18n keys', () => {
    const vocab = JSON.stringify(['builtin', 'ecosystem', 'local', 'inline', 'packaged']);
    for (const p of ['builtin', 'ecosystem', 'local', 'inline', 'packaged']) {
      assert.equal(fn(`window.ClawFW.featureCatalog.provenanceI18nKey('${p}', ${vocab})`), 'feature_prov_' + p);
    }
  });

  it('returns null for values outside the vocabulary or missing vocabulary (caller renders raw or hides)', () => {
    const vocab = JSON.stringify(['builtin']);
    assert.equal(fn(`window.ClawFW.featureCatalog.provenanceI18nKey('ecosystem', ${vocab})`), null);
    assert.equal(fn(`window.ClawFW.featureCatalog.provenanceI18nKey('builtin', undefined)`), null);
    assert.equal(fn(`window.ClawFW.featureCatalog.provenanceI18nKey('builtin', null)`), null);
    assert.equal(fn(`window.ClawFW.featureCatalog.provenanceI18nKey(undefined, ${vocab})`), null);
  });
});
