/**
 * Tests for public/src/modules/feature-catalog.js (P1 panel visibility)
 *
 * Covers pure grouping/enrichment helpers:
 *   - groupFeaturesByProvenance: 按 provenance 词表顺序分组、空组剔除、兜底进 _unmapped
 *   - enrichFeatureEntry: seed 命中/未命中、原字段保留、多值 capabilities
 *   - resolveDisplayName: {zh,en} / string / 缺失回退 name 三态
 *   - provenanceI18nKey: 响应携带词表内 / 词表外
 *
 * 能力标签（tools/policy/mcp…）是多值属性，不作分组因素（ADR 0017 决策 2 修订）。
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
  capabilities: [{ id: 'tools' }, { id: 'policy' }, { id: 'gateway' }, { id: 'mcp' }, { id: 'protocol' }],
  provenances: ['ecosystem', 'local', 'builtin', 'inline', 'packaged'],
  types: [
    { id: 'ability', collapsed: false },
    { id: 'governance', collapsed: false },
    { id: 'interface', collapsed: false },
    { id: 'system', collapsed: true },
  ],
  groups: ['installed', 'bundled'],
  features: [
    { name: 'shell', displayName: { zh: 'Shell 执行', en: 'Shell' }, type: 'ability', capabilities: ['tools', 'policy'], provenance: 'ecosystem', group: 'bundled' },
    { name: 'todo', displayName: '任务清单', type: 'ability', capabilities: ['tools'], provenance: 'local', group: 'bundled' },
    { name: 'lsp', displayName: { zh: '语言服务', en: 'Language Server' }, type: 'ability', capabilities: ['tools'], provenance: 'builtin', group: 'bundled' },
    { name: 'context-guard', displayName: { zh: '上下文守卫', en: 'Context Guard' }, type: 'governance', capabilities: ['policy'], provenance: 'local', group: 'bundled' },
    { name: 'im-operator', displayName: { zh: 'IM 接线员', en: 'IM Operator' }, type: 'interface', capabilities: ['gateway', 'tools'], provenance: 'inline', group: 'bundled' },
    { name: 'user-input', displayName: { zh: '用户输入', en: 'User Input' }, type: 'system', capabilities: ['tools'], provenance: 'builtin', group: 'bundled' },
    { name: 'user-tool', displayName: { zh: '用户工具', en: 'User Tool' }, type: 'ability', capabilities: ['tools'], provenance: 'packaged', group: 'installed' },
  ],
};

function inspectorFeature(name, extra = {}) {
  return { name, source: 'src/' + name + '.ts', description: 'd', hookCount: 1, enabledToolCount: 2, toolCount: 3, ...extra };
}

// ── groupFeaturesByDisplayGroup ────────────────────────────────────

describe('feature-catalog: groupFeaturesByType', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('groups by type vocabulary order, empty groups dropped', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(
      [ ${JSON.stringify(inspectorFeature('lsp'))}, ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('context-guard'))}, ${JSON.stringify(inspectorFeature('im-operator'))}, ${JSON.stringify(inspectorFeature('user-input'))}, ${JSON.stringify(inspectorFeature('user-tool'))} ],
      ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(JSON.stringify(groups.map(g => g.id)), JSON.stringify(['ability', 'governance', 'interface', 'system']));
    // user-tool 是 installed 来源但功能类型是 ability——分组轴与过滤器正交，不产生独立 installed 组
    assert.equal(groups[0].features.length, 3);
    assert.equal(groups[1].features[0].name, 'context-guard');
    assert.equal(groups[3].features[0].name, 'user-input');
  });

  it('filter=bundled keeps only bundled entries; filter=installed keeps only installed', () => {
    const input = `[ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('user-tool'))} ]`;
    const bundled = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'bundled')`);
    assert.equal(JSON.stringify(bundled.map(g => g.id)), JSON.stringify(['ability']));
    assert.equal(bundled[0].features.length, 1);
    const installed = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'installed')`);
    assert.equal(JSON.stringify(installed.map(g => g.id)), JSON.stringify(['ability']));
    assert.equal(installed[0].features[0].name, 'user-tool');
  });

  it('filter=installed with no installed features returns empty group array', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(
      [ ${JSON.stringify(inspectorFeature('shell'))} ], ${JSON.stringify(CATALOG)}, 'installed'
    )`);
    assert.equal(groups.length, 0);
  });

  it('unmapped features land in _unmapped (always last) with mapped:false', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(
      [ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('brand-new-feature'))} ],
      ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(JSON.stringify(groups.map(g => g.id)), JSON.stringify(['ability', '_unmapped']));
    const unmapped = groups[1];
    assert.equal(unmapped.features.length, 1);
    assert.equal(unmapped.features[0].name, 'brand-new-feature');
    assert.equal(unmapped.features[0].mapped, false);
    assert.equal(unmapped.features[0].provenance, null);
    assert.equal(unmapped.features[0].group, null);
    assert.equal(unmapped.features[0].type, null);
  });

  it('null catalog sends all features to _unmapped', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(
      [ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('todo'))} ], null
    )`);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, '_unmapped');
    assert.equal(groups[0].features.length, 2);
    assert.equal(groups[0].features.every(f => f.mapped === false), true);
  });

  it('empty features input returns empty group array', () => {
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType([], ${JSON.stringify(CATALOG)})`);
    assert.equal(groups.length, 0);
    assert.equal(fn('window.ClawFW.featureCatalog.groupFeaturesByType(undefined, null)').length, 0);
  });

  it('capFilter keeps features having that capability (multi-value membership)', () => {
    const input = `[ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('todo'))}, ${JSON.stringify(inspectorFeature('context-guard'))}, ${JSON.stringify(inspectorFeature('im-operator'))} ]`;
    // policy：shell（tools+policy）与 context-guard 命中；todo（仅 tools）、im-operator（gateway+tools）排除
    const policy = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'policy')`);
    assert.equal(JSON.stringify(policy.map(g => g.id)), JSON.stringify(['ability', 'governance']));
    assert.equal(policy[0].features[0].name, 'shell');
    assert.equal(policy[1].features[0].name, 'context-guard');
    // gateway：仅 im-operator（interface 组）
    const gateway = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'gateway')`);
    assert.equal(JSON.stringify(gateway.map(g => g.id)), JSON.stringify(['interface']));
    assert.equal(gateway[0].features[0].name, 'im-operator');
  });

  it('capFilter combined with src filter intersects both conditions', () => {
    const input = `[ ${JSON.stringify(inspectorFeature('shell'))}, ${JSON.stringify(inspectorFeature('user-tool'))} ]`;
    // tools 能力 + installed 来源：只有 user-tool 命中
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'installed', 'tools')`);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].features[0].name, 'user-tool');
  });

  it('capFilter excludes unmapped entries (unknown capabilities) but keeps them under all', () => {
    const input = `[ ${JSON.stringify(inspectorFeature('ghost'))} ]`;
    const filtered = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'tools')`);
    assert.equal(filtered.length, 0);
    const all = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'all')`);
    assert.equal(all[0].id, '_unmapped');
  });

  it('capFilter with no matching features returns empty group array', () => {
    const input = `[ ${JSON.stringify(inspectorFeature('todo'))} ]`;
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'gateway')`);
    assert.equal(groups.length, 0);
  });

  it('normalizeCapFilter passes all/vocabulary ids and folds stale values to all', () => {
    const call = (v) => fn(`window.ClawFW.featureCatalog.normalizeCapFilter(${JSON.stringify(v)}, ${JSON.stringify(CATALOG)})`);
    assert.equal(call('all'), 'all');
    assert.equal(call('tools'), 'tools');
    assert.equal(call('mcp'), 'mcp');
    assert.equal(call('hooks'), 'all', 'legacy vocabulary value folds to all');
    assert.equal(call(undefined), 'all');
    assert.equal(call(''), 'all');
    const noVocab = fn(`window.ClawFW.featureCatalog.normalizeCapFilter('tools', null)`);
    assert.equal(noVocab, 'all');
  });

  it('typeCollapsedByDefault follows vocabulary flags (system folds)', () => {
    const call = (id) => fn(`window.ClawFW.featureCatalog.typeCollapsedByDefault('${id}', ${JSON.stringify(CATALOG)})`);
    assert.equal(call('system'), true);
    assert.equal(call('ability'), false);
    assert.equal(call('governance'), false);
    assert.equal(call('nonexistent'), false);
  });
});

// ── enrichFeatureEntry ─────────────────────────────────────────────

describe('feature-catalog: enrichFeatureEntry', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('mapped entry carries seed metadata (multi-value capabilities) and keeps original fields', () => {
    const entry = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('shell', { hookCount: 7 }))}, ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(entry.mapped, true);
    // 多值能力：shell 同时提供工具与生命周期守卫
    assert.equal(JSON.stringify(entry.capabilities), JSON.stringify(['tools', 'policy']));
    assert.equal(entry.provenance, 'ecosystem');
    assert.equal(entry.group, 'bundled');
    assert.equal(entry.displayName.zh, 'Shell 执行');
    assert.equal(entry.displayName.en, 'Shell');
    assert.equal(entry.hookCount, 7, 'original inspector fields preserved');
    assert.equal(entry.source, 'src/shell.ts');
  });

  it('unmatched feature falls back with empty capabilities and provenance null', () => {
    const entry = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('ghost'))}, ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(entry.mapped, false);
    assert.equal(entry.provenance, null);
    assert.equal(JSON.stringify(entry.capabilities), JSON.stringify([]));
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

// ── fetchFeatureCatalog response contract ─────────────────────────
// 回归：响应校验字段曾与 server 契约脱节（categories vs provenances），
// 导致 catalog 永远加载失败、面板全部落 _unmapped——纯函数用例拦不住，这里钉死。

describe('feature-catalog: response contract', () => {
  it('accepts current contract (provenances + features) and caches snapshot', async () => {
    const calls = [];
    const ctx = createFrontendSandbox({
      fetch: async (url) => { calls.push(url); return { ok: true, json: async () => CATALOG }; },
    });
    ctx.loadSource('public/src/modules/feature-catalog.js');
    await ctx.run('window.ClawFW.featureCatalog.loadFeatureCatalog(true)');
    const snap = ctx.run('window.ClawFW.featureCatalog.getFeatureCatalogSnapshot()');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], '/api/feature-catalog');
    assert.ok(Array.isArray(snap.provenances));
    assert.ok(Array.isArray(snap.features));
  });

  it('rejects responses missing provenances instead of half-loading', async () => {
    const ctx = createFrontendSandbox({
      fetch: async () => ({ ok: true, json: async () => ({ features: CATALOG.features }) }),
    });
    ctx.loadSource('public/src/modules/feature-catalog.js');
    await assert.rejects(
      ctx.run('window.ClawFW.featureCatalog.loadFeatureCatalog(true)'),
      /malformed/
    );
    const snap = ctx.run('window.ClawFW.featureCatalog.getFeatureCatalogSnapshot()');
    assert.equal(snap, null);
  });
});
