/**
 * feature-catalog.js — Feature 分类目录（P1）
 *
 * 数据源：GET /api/feature-catalog（server/shared/feature-registry-seed.json）。
 * 与 inspector 轮询数据在前端 join（key = 运行时 AgentFeature.name），
 * 为 Features 面板提供 displayName / category / provenance 组织维度。
 *
 * 纯函数不依赖 t() / escapeHtml / DOM（语言经参数传入），保证 frontend-vm 沙箱可测。
 * 设计：docs/plans/2026-09-13-feature-registry-p1-panel-visibility.md
 */

window.ClawFW = window.ClawFW || {};

// ── catalog 加载（低频；agent 切换不强制刷新）──────────────────────

let _catalog = null;        // 已 resolve 的快照（同步渲染入口）
let _catalogPromise = null; // 进行中的拉取（失败不缓存，下次可重试）

async function fetchFeatureCatalog() {
  const resp = await fetch('/api/feature-catalog');
  if (!resp.ok) throw new Error('/api/feature-catalog ' + resp.status);
  const data = await resp.json();
  if (!data || !Array.isArray(data.provenances) || !Array.isArray(data.types)
    || !Array.isArray(data.features)) {
    throw new Error('feature-catalog: malformed response');
  }
  return data;
}

/**
 * 拉取（或复用进行中/已完成的）catalog。
 * 首次成功后主动触发一帧面板重渲染——renderFeaturesPanel 是同步渲染，
 * catalog 未就绪的首帧 feature 全落 _unmapped，靠本回调修正而非等轮询周期。
 * 与筛选切换一致走 renderFeaturePanel 直渲染（乐观、无 poll 往返迟滞）。
 */
async function loadFeatureCatalog(force = false) {
  if (_catalogPromise && !force) return _catalogPromise;
  _catalogPromise = (async () => {
    const data = await fetchFeatureCatalog();
    const firstLoad = !_catalog;
    _catalog = data;
    if (firstLoad && typeof activeFeaturePanel !== 'undefined'
      && activeFeaturePanel === 'hooks' && typeof renderFeaturePanel === 'function') {
      renderFeaturePanel();
    }
    return data;
  })().catch(err => {
    _catalogPromise = null;
    throw err;
  });
  return _catalogPromise;
}

/** 同步取已加载快照；未就绪返回 null（渲染层兜底进 _unmapped 组）。 */
function getFeatureCatalogSnapshot() {
  return _catalog;
}

// ── 纯函数（join / 分组 / 展示）────────────────────────────────────

/** catalog 缺失时的兜底分组词表（仅 _unmapped）。 */
const FALLBACK_GROUPS = [{ id: '_unmapped' }];

/**
 * 从 inspector 运行时数据推导可观测能力：
 * tools = 注册过工具；policy = 注册过生命周期钩子；
 * mcp = 挂了 MCP server（其工具以 mcp_<serverId>_<tool> 前缀注册，
 * 见 AgentDev packages/mcp/src/client.ts 的工具命名）。
 * skills / commands 带数据源可用性回退，在 enrichFeatureEntry 内处理。
 */
function deriveRuntimeCapabilities(feature) {
  const caps = [];
  const tools = Array.isArray(feature.tools) ? feature.tools : [];
  if (tools.length > 0 || (feature.toolCount || 0) > 0) caps.push('tools');
  if ((feature.hookCount || 0) > 0) caps.push('policy');
  if (tools.some(t => typeof t.name === 'string' && t.name.indexOf('mcp_') === 0)) caps.push('mcp');
  return caps;
}

/**
 * inspector feature 条目 + catalog → enriched 条目。
 * capabilities 是**有效能力**（筛选与展示的唯一依据）：
 * - tools/policy/mcp：inspector 运行时推导，覆盖 seed 标注
 * - skills：快照携带 skillCount（框架 collectFeatureSkills 的归属透出）
 *   时运行时判定；旧框架快照无该字段时回退 seed
 * - commands：commands 清单可用时运行时判定；不可用时回退 seed
 * seed 未命中时 mapped:false，capabilities 退化为纯运行时推导——
 * 兜底组正常显示不隐藏，且可观测维度的筛选仍然准确。
 *
 * runtime（可缺省）：{ commandFeatures: Set<string> | null }
 * commandFeatures = 提供了 slash 命令的 feature 名集合（null = 数据不可用）。
 */
function enrichFeatureEntry(feature, catalog, runtime) {
  const entry = catalog && catalog.features
    ? catalog.features.find(seed => seed.name === feature.name)
    : null;
  const seedCaps = entry && Array.isArray(entry.capabilities) ? entry.capabilities : [];
  const caps = deriveRuntimeCapabilities(feature);
  if (typeof feature.skillCount === 'number') {
    if (feature.skillCount > 0) caps.push('skills');
  } else if (seedCaps.indexOf('skills') !== -1) {
    caps.push('skills');
  }
  if (runtime && runtime.commandFeatures) {
    if (runtime.commandFeatures.has(feature.name)) caps.push('commands');
  } else if (seedCaps.indexOf('commands') !== -1) {
    caps.push('commands');
  }
  if (!entry) {
    return { ...feature, displayName: undefined, capabilities: caps, provenance: null, group: null, type: null, mapped: false };
  }
  return {
    ...feature,
    displayName: entry.displayName,
    capabilities: caps,
    provenance: entry.provenance,
    group: entry.group,
    type: entry.type,
    mapped: true,
  };
}

/**
 * 按功能类型分组（面板主分组轴，ADR 0017 决策 2 三次修订）：
 * ability（让 agent 会什么）/ governance（怎么管 agent）/
 * interface（怎么连 agent）/ system（宿主运转件，默认折叠）。
 * 来源（bundled/installed）是过滤器不作分组轴。
 *
 * filter: 'all' 不过滤；'bundled' | 'installed' 按 entry.group 筛选。
 * capFilter: 'all' 不过滤；否则按 entry.capabilities 多值包含筛选
 *   （一个 feature 可同时具备多种能力，命中其一即入选；未映射条目
 *   capabilities 为空，任何能力筛选都会排除它们）。
 * 分组顺序 = 响应携带的 types 词表顺序，_unmapped 恒在最后；空组剔除。
 * catalog 为 null 时全部进 _unmapped。features 为空返回 []。
 */
function groupFeaturesByType(features, catalog, filter = 'all', capFilter = 'all', runtime) {
  if (!Array.isArray(features) || features.length === 0) return [];
  const types = (catalog && Array.isArray(catalog.types) && catalog.types.length > 0)
    ? catalog.types.map(t => (typeof t === 'string' ? t : t.id))
    : [];
  const order = [...types, '_unmapped'];
  const buckets = new Map(order.map(id => [id, []]));
  for (const feature of features) {
    const enriched = enrichFeatureEntry(feature, catalog, runtime);
    if (filter !== 'all' && enriched.group !== filter) continue;
    if (capFilter !== 'all' && enriched.capabilities.indexOf(capFilter) === -1) continue;
    const key = enriched.type && buckets.has(enriched.type) ? enriched.type : '_unmapped';
    buckets.get(key).push(enriched);
  }
  return order
    .filter(id => (buckets.get(id) || []).length > 0)
    .map(id => ({ id, features: buckets.get(id) }));
}

/**
 * 按来源过滤器计数（分页器各档的小字，语义 = "点这一档会看到几个"）。
 * 计数应用当前能力筛选（capFilter），与点击后的实际结果一致。
 * 与 groupFeaturesByType 同一套 enrich/判定，保证数字与列表永不脱节。
 */
function countFeaturesBySource(features, catalog, capFilter = 'all', runtime) {
  const counts = { all: 0, bundled: 0, installed: 0 };
  if (!Array.isArray(features)) return counts;
  for (const feature of features) {
    const enriched = enrichFeatureEntry(feature, catalog, runtime);
    if (capFilter !== 'all' && enriched.capabilities.indexOf(capFilter) === -1) continue;
    counts.all += 1;
    if (enriched.group === 'bundled' || enriched.group === 'installed') counts[enriched.group] += 1;
  }
  return counts;
}

/**
 * 能力筛选值归一：'all' 与词表内的能力 id 原样通过，
 * 词表外/持久化的过期值归一为 'all'（词表演进时存储值不至于过滤成空）。
 */
function normalizeCapFilter(value, catalog) {
  if (value === 'all') return 'all';
  const ids = catalog && Array.isArray(catalog.capabilities)
    ? catalog.capabilities.map(c => (typeof c === 'string' ? c : c.id))
    : [];
  return ids.includes(value) ? value : 'all';
}

/**
 * type → 默认折叠态。词表由响应携带（[{ id, collapsed }]）；
 * 未声明 collapsed 或词表缺失视为展开。
 */
function typeCollapsedByDefault(typeId, catalog) {
  const t = catalog && Array.isArray(catalog.types)
    ? catalog.types.find(x => (typeof x === 'string' ? x : x.id) === typeId)
    : null;
  return Boolean(t && typeof t === 'object' && t.collapsed);
}

/**
 * displayName 解析：{zh,en} 对象按语言取值（非 zh 取 en）；
 * 纯字符串原样；缺失/非法回退 name。
 */
function resolveDisplayName(entry, lang) {
  const dn = entry && entry.displayName;
  if (dn && typeof dn === 'object' && typeof dn.zh === 'string' && typeof dn.en === 'string') {
    return lang === 'zh' ? dn.zh : dn.en;
  }
  if (typeof dn === 'string' && dn.trim().length > 0) return dn;
  return entry && typeof entry.name === 'string' ? entry.name : '';
}

/**
 * provenance → i18n key。词表由 API 响应携带（catalog.provenances，单一权威），
 * 命中返回 key（渲染层 t(key)）；不在词表内返回 null（渲染层原样透传或隐藏）。
 */
function provenanceI18nKey(provenance, provenances) {
  return Array.isArray(provenances) && provenances.includes(provenance)
    ? 'feature_prov_' + provenance
    : null;
}

window.ClawFW.featureCatalog = {
  loadFeatureCatalog,
  getFeatureCatalogSnapshot,
  enrichFeatureEntry,
  deriveRuntimeCapabilities,
  groupFeaturesByType,
  countFeaturesBySource,
  normalizeCapFilter,
  typeCollapsedByDefault,
  resolveDisplayName,
  provenanceI18nKey,
};
