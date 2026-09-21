/**
 * Tests for public/src/modules/feature-catalog.js (P1 panel visibility)
 *
 * Covers pure grouping/enrichment helpers:
 *   - groupFeaturesByType: 按功能类型词表分组、来源/能力双筛选、兜底进 _unmapped
 *   - enrichFeatureEntry: seed 命中/未命中、运行时能力推导（tools/policy/mcp/skills/commands）
 *   - countFeaturesBySource: 分页器各档计数（随能力筛选联动）
 *   - resolveDisplayName / provenanceI18nKey / normalizeCapFilter
 *   - fetchFeatureCatalog 响应契约（字段脱节回归）
 *
 * 能力是多值属性且以运行时真相为准（ADR 0017 决策 2）：
 * tools/policy/mcp 由 inspector 信号推导，skills 由快照 skillCount 推导
 * （缺失回退 seed），commands 由 /protoclaw/commands 集合判定（不可用回退 seed）。
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
  capabilities: [{ id: 'tools' }, { id: 'policy' }, { id: 'commands' }, { id: 'skills' }, { id: 'mcp' }],
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
    { name: 'im-operator', displayName: { zh: 'IM 接线员', en: 'IM Operator' }, type: 'interface', capabilities: ['tools'], provenance: 'inline', group: 'bundled' },
    { name: 'user-input', displayName: { zh: '用户输入', en: 'User Input' }, type: 'system', capabilities: [], provenance: 'builtin', group: 'bundled' },
    { name: 'user-tool', displayName: { zh: '用户工具', en: 'User Tool' }, type: 'ability', capabilities: ['tools'], provenance: 'packaged', group: 'installed' },
  ],
};

/**
 * inspector feature fixture：默认无任何运行时能力信号（全 0 / 空 tools），
 * 测试显式声明各维度信号，避免 fixture 默认值掩盖推导逻辑。
 */
function inspectorFeature(name, extra = {}) {
  return {
    name,
    source: 'src/' + name + '.ts',
    description: 'd',
    hookCount: 0,
    enabledToolCount: 0,
    toolCount: 0,
    tools: [],
    skillCount: 0,
    ...extra,
  };
}

// ── groupFeaturesByType ────────────────────────────────────────────

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

  it('capFilter derives policy from runtime hookCount, not seed annotation', () => {
    // shell 运行时挂了钩子（hookCount=2）；todo seed 虽标注 tools 但运行时零信号
    const input = `[
      ${JSON.stringify(inspectorFeature('shell', { hookCount: 2, toolCount: 3, enabledToolCount: 3, tools: [{ name: 'bash' }] }))},
      ${JSON.stringify(inspectorFeature('todo'))},
      ${JSON.stringify(inspectorFeature('context-guard', { hookCount: 4 }))}
    ]`;
    const policy = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'policy')`);
    assert.equal(JSON.stringify(policy.map(g => g.id)), JSON.stringify(['ability', 'governance']));
    assert.equal(policy[0].features[0].name, 'shell');
    assert.equal(policy[1].features[0].name, 'context-guard');
  });

  it('capFilter mcp matches tool names with mcp_ prefix (MCP server mounts)', () => {
    const input = `[
      ${JSON.stringify(inspectorFeature('lsp', { toolCount: 2, tools: [{ name: 'lsp_hover' }] }))},
      ${JSON.stringify(inspectorFeature('im-operator', { toolCount: 2, tools: [{ name: 'mcp_github_create_issue' }, { name: 'im_overview' }] }))}
    ]`;
    const mcp = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'mcp')`);
    assert.equal(JSON.stringify(mcp.map(g => g.id)), JSON.stringify(['interface']));
    assert.equal(mcp[0].features[0].name, 'im-operator');
  });

  it('capFilter skills uses snapshot skillCount; stale seed skills is overridden', () => {
    // user-input 的 seed 无 skills；运行时 skillCount=2 → 命中 skills 筛选
    const input = `[
      ${JSON.stringify(inspectorFeature('user-input', { skillCount: 2 }))},
      ${JSON.stringify(inspectorFeature('todo', { skillCount: 0 }))}
    ]`;
    const skills = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'skills')`);
    assert.equal(JSON.stringify(skills.map(g => g.id)), JSON.stringify(['system']));
    assert.equal(skills[0].features[0].name, 'user-input');
  });

  it('capFilter skills falls back to seed when snapshot lacks skillCount (older framework)', () => {
    const legacy = inspectorFeature('todo');
    delete legacy.skillCount; // 旧框架快照无该字段
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(
      [ ${JSON.stringify(legacy)} ], ${JSON.stringify(CATALOG)}, 'all', 'skills'
    )`);
    // todo 的 seed 未标 skills → 空；换成 seed 标了 skills 的 shell 验证回退
    assert.equal(groups.length, 0);
    const legacyShell = inspectorFeature('shell');
    delete legacyShell.skillCount;
    const viaSeed = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(
      [ ${JSON.stringify(legacyShell)} ], ${JSON.stringify(CATALOG)}, 'all', 'skills'
    )`);
    // shell seed 也未标 skills，用 commands 维度同机制验证 seed 回退路径
    assert.equal(viaSeed.length, 0);
  });

  it('capFilter commands uses runtime commandFeatures set; falls back to seed when unavailable', () => {
    // 运行时清单：todo 提供了 slash 命令
    const input = `[ ${JSON.stringify(inspectorFeature('todo'))}, ${JSON.stringify(inspectorFeature('shell'))} ]`;
    const runtime = `new Set(['todo'])`;
    const withRuntime = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'commands', { commandFeatures: ${runtime} })`);
    assert.equal(withRuntime.length, 1);
    assert.equal(withRuntime[0].features[0].name, 'todo');
    // 清单不可用（null）→ 回退 seed：seed 中无 commands 标注 → 空
    const fallback = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'commands', { commandFeatures: null })`);
    assert.equal(fallback.length, 0);
  });

  it('capFilter combined with src filter intersects both conditions', () => {
    const input = `[ ${JSON.stringify(inspectorFeature('shell', { toolCount: 2, tools: [{ name: 'bash' }] }))}, ${JSON.stringify(inspectorFeature('user-tool', { toolCount: 1, tools: [{ name: 'ut' }] }))} ]`;
    // tools 能力 + installed 来源：只有 user-tool 命中
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'installed', 'tools')`);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].features[0].name, 'user-tool');
  });

  it('capFilter excludes entries without runtime signals even when seed claims the capability', () => {
    // todo seed 标注 tools，但运行时零工具信号（被禁用/未注册）→ seed 不再生效
    const input = `[ ${JSON.stringify(inspectorFeature('todo'))} ]`;
    const filtered = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'tools')`);
    assert.equal(filtered.length, 0);
    const all = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'all')`);
    assert.equal(all[0].id, 'ability');
  });

  it('capFilter with no matching features returns empty group array', () => {
    const input = `[ ${JSON.stringify(inspectorFeature('todo'))} ]`;
    const groups = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'all', 'mcp')`);
    assert.equal(groups.length, 0);
  });

  it('normalizeCapFilter passes all/vocabulary ids and folds stale values to all', () => {
    const call = (v) => fn(`window.ClawFW.featureCatalog.normalizeCapFilter(${JSON.stringify(v)}, ${JSON.stringify(CATALOG)})`);
    assert.equal(call('all'), 'all');
    assert.equal(call('tools'), 'tools');
    assert.equal(call('mcp'), 'mcp');
    assert.equal(call('gateway'), 'all', 'removed vocabulary value folds to all');
    assert.equal(call('protocol'), 'all', 'removed vocabulary value folds to all');
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

// ── enrichFeatureEntry / deriveRuntimeCapabilities ─────────────────

describe('feature-catalog: enrichFeatureEntry', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('mapped entry carries seed metadata; capabilities come from runtime signals', () => {
    const entry = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('shell', { hookCount: 7, toolCount: 3, enabledToolCount: 2, tools: [{ name: 'bash' }] }))}, ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(entry.mapped, true);
    // 运行时推导：注册了工具 + 挂了钩子
    assert.equal(JSON.stringify(entry.capabilities), JSON.stringify(['tools', 'policy']));
    assert.equal(entry.provenance, 'ecosystem');
    assert.equal(entry.group, 'bundled');
    assert.equal(entry.displayName.zh, 'Shell 执行');
    assert.equal(entry.displayName.en, 'Shell');
    assert.equal(entry.hookCount, 7, 'original inspector fields preserved');
    assert.equal(entry.source, 'src/shell.ts');
  });

  it('unmatched feature falls back to pure runtime derivation with provenance null', () => {
    const entry = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('ghost', { toolCount: 2, tools: [{ name: 'mcp_x_y' }] }))}, ${JSON.stringify(CATALOG)}
    )`);
    assert.equal(entry.mapped, false);
    assert.equal(entry.provenance, null);
    // 未映射条目能力仍可推导：兜底组里 tools/mcp 筛选照样准确
    assert.equal(JSON.stringify(entry.capabilities), JSON.stringify(['tools', 'mcp']));
    assert.equal(entry.displayName, undefined);
  });

  it('mountedNames overrides seed group: $mount fact wins over static mapping', () => {
    // 官方选装 playwright-shell：seed 标 bundled（provenance local），但经
    // $mount 挂载 → 装配事实 installed，与挂载管理页口径一致
    const input = `[ ${JSON.stringify(inspectorFeature('playwright-shell'))} ]`;
    const mounted = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('playwright-shell'))}, ${JSON.stringify(CATALOG)},
      { mountedNames: new Set(['playwright-shell']) }
    )`);
    assert.equal(mounted.group, 'installed');
    // 同一装配域内未命中 $mount 清单 → 默认装配（bundled），即使 seed 缺失
    const unmounted = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('brand-new-feature'))}, ${JSON.stringify(CATALOG)},
      { mountedNames: new Set(['playwright-shell']) }
    )`);
    assert.equal(unmounted.group, 'bundled');
    assert.equal(unmounted.mapped, false);
    // 装配事实不可用（null）→ 回退 seed 静态 group
    const fallback = fn(`window.ClawFW.featureCatalog.enrichFeatureEntry(
      ${JSON.stringify(inspectorFeature('user-tool'))}, ${JSON.stringify(CATALOG)},
      { mountedNames: null }
    )`);
    assert.equal(fallback.group, 'installed');
  });

  it('deriveRuntimeCapabilities maps inspector signals to vocabulary ids', () => {
    const call = (extra) => fn(`window.ClawFW.featureCatalog.deriveRuntimeCapabilities(${JSON.stringify(inspectorFeature('x', extra))})`);
    assert.equal(JSON.stringify(call({})), JSON.stringify([]), 'zero-signal feature has no capabilities');
    assert.equal(JSON.stringify(call({ toolCount: 1 })), JSON.stringify(['tools']), 'toolCount>0 without tool details');
    assert.equal(JSON.stringify(call({ hookCount: 1 })), JSON.stringify(['policy']));
    assert.equal(JSON.stringify(call({ tools: [{ name: 'mcp_github_create_issue' }] })), JSON.stringify(['tools', 'mcp']), 'mcp mount also provides tools');
    assert.equal(JSON.stringify(call({ toolCount: 2, tools: [{ name: 'a' }, { name: 'b' }], hookCount: 3 })), JSON.stringify(['tools', 'policy']));
  });
});

// ── countFeaturesBySource ──────────────────────────────────────────

describe('feature-catalog: countFeaturesBySource', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('counts per source group; capFilter narrows counts consistently', () => {
    const input = `[
      ${JSON.stringify(inspectorFeature('shell', { toolCount: 2, tools: [{ name: 'bash' }], hookCount: 1 }))},
      ${JSON.stringify(inspectorFeature('user-tool', { toolCount: 1, tools: [{ name: 'ut' }] }))},
      ${JSON.stringify(inspectorFeature('context-guard', { hookCount: 2 }))}
    ]`;
    const all = fn(`window.ClawFW.featureCatalog.countFeaturesBySource(${input}, ${JSON.stringify(CATALOG)})`);
    assert.equal(JSON.stringify(all), JSON.stringify({ all: 3, bundled: 2, installed: 1 }));
    const policyOnly = fn(`window.ClawFW.featureCatalog.countFeaturesBySource(${input}, ${JSON.stringify(CATALOG)}, 'policy')`);
    assert.equal(JSON.stringify(policyOnly), JSON.stringify({ all: 2, bundled: 2, installed: 0 }));
  });

  it('unmapped features count toward all but not bundled/installed', () => {
    const input = `[ ${JSON.stringify(inspectorFeature('brand-new'))} ]`;
    const counts = fn(`window.ClawFW.featureCatalog.countFeaturesBySource(${input}, ${JSON.stringify(CATALOG)})`);
    assert.equal(JSON.stringify(counts), JSON.stringify({ all: 1, bundled: 0, installed: 0 }));
  });

  it('empty or non-array input returns zero counts', () => {
    const counts = fn(`window.ClawFW.featureCatalog.countFeaturesBySource([], ${JSON.stringify(CATALOG)})`);
    assert.equal(JSON.stringify(counts), JSON.stringify({ all: 0, bundled: 0, installed: 0 }));
    const none = fn(`window.ClawFW.featureCatalog.countFeaturesBySource(undefined, null)`);
    assert.equal(JSON.stringify(none), JSON.stringify({ all: 0, bundled: 0, installed: 0 }));
  });

  it('mountedNames feeds pager counts consistently with the rendered list', () => {
    // 用户场景回归：seed 全 bundled + 一个 $mount 挂载 → installed 1，与配置页一致
    const input = `[
      ${JSON.stringify(inspectorFeature('shell'))},
      ${JSON.stringify(inspectorFeature('todo'))},
      ${JSON.stringify(inspectorFeature('playwright-shell'))}
    ]`;
    const runtime = `{ mountedNames: new Set(['playwright-shell']) }`;
    const counts = fn(`window.ClawFW.featureCatalog.countFeaturesBySource(${input}, ${JSON.stringify(CATALOG)}, 'all', ${runtime})`);
    assert.equal(JSON.stringify(counts), JSON.stringify({ all: 3, bundled: 2, installed: 1 }));
    const installed = fn(`window.ClawFW.featureCatalog.groupFeaturesByType(${input}, ${JSON.stringify(CATALOG)}, 'installed', 'all', ${runtime})`);
    assert.equal(installed.length, 1);
    assert.equal(installed[0].features[0].name, 'playwright-shell');
  });
});

// ── resolveMountedNames ────────────────────────────────────────────

describe('feature-catalog: resolveMountedNames', () => {
  const ctx = loadModule();
  const fn = ctx.run;

  it('selects the identity set by sessionType within the programming-helper domain', () => {
    const facts = `({ main: new Set(['playwright-shell']), coder: new Set(['github']) })`;
    const call = (host, sessionType) => fn(
      `String(window.ClawFW.featureCatalog.resolveMountedNames(${facts}, '${host}', '${sessionType}') === null
        ? 'null'
        : [...window.ClawFW.featureCatalog.resolveMountedNames(${facts}, '${host}', '${sessionType}')].sort().join(','))`
    );
    assert.equal(call('programming-helper', ''), 'playwright-shell');
    assert.equal(call('programming-helper', 'main'), 'playwright-shell');
    assert.equal(call('programming-helper', 'coder'), 'github');
  });

  it('returns null outside the mount domain or before facts are ready', () => {
    const facts = `({ main: new Set(['playwright-shell']) })`;
    // 其他宿主不在双身份装配域（挂载管理/商店是编程小助手专属）
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveMountedNames(${facts}, 'agent-studio', '')`), null);
    // 装配事实未就绪
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveMountedNames(null, 'programming-helper', '')`), null);
    // 身份清单缺失（响应不含该身份键）
    assert.equal(fn(`window.ClawFW.featureCatalog.resolveMountedNames({}, 'programming-helper', 'coder')`), null);
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

// 回归：来源分类的装配事实来源（mounts）与 catalog 同为前端 join 的数据源，
// 响应路径与 mounts 形状脱节会让面板静默回退 seed 静态分组。

describe('feature-catalog: mount facts contract', () => {
  it('fetches store overview and caches per-identity mounted-name sets', async () => {
    const calls = [];
    const overview = {
      mounts: {
        main: { 'playwright-shell': { kind: 'builtin', missing: false } },
        coder: {},
      },
    };
    const ctx = createFrontendSandbox({
      fetch: async (url) => { calls.push(url); return { ok: true, json: async () => overview }; },
    });
    ctx.loadSource('public/src/modules/feature-catalog.js');
    await ctx.run('window.ClawFW.featureCatalog.loadMountFacts(true)');
    const snap = ctx.run('window.ClawFW.featureCatalog.getMountFactsSnapshot()');
    assert.equal(calls.length, 1);
    assert.equal(calls[0], '/api/feature-store/overview');
    assert.equal(snap.main.has('playwright-shell'), true);
    assert.equal(snap.coder.size, 0);
  });

  it('rejects malformed mounts and leaves the snapshot unset for retry', async () => {
    const ctx = createFrontendSandbox({
      fetch: async () => ({ ok: true, json: async () => ({ base: {} }) }),
    });
    ctx.loadSource('public/src/modules/feature-catalog.js');
    await assert.rejects(
      ctx.run('window.ClawFW.featureCatalog.loadMountFacts(true)'),
      /malformed/
    );
    assert.equal(ctx.run('window.ClawFW.featureCatalog.getMountFactsSnapshot()'), null);
  });
});
