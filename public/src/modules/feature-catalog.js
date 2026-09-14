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
  if (!data || !Array.isArray(data.provenances) || !Array.isArray(data.groups)
    || !Array.isArray(data.features)) {
    throw new Error('feature-catalog: malformed response');
  }
  return data;
}

/**
 * 拉取（或复用进行中/已完成的）catalog。
 * 首次成功后主动触发一帧 inspector 刷新——renderFeaturesPanel 是同步渲染，
 * catalog 未就绪的首帧 feature 全落 _unmapped，靠本回调修正而非等轮询周期。
 */
async function loadFeatureCatalog(force = false) {
  if (_catalogPromise && !force) return _catalogPromise;
  _catalogPromise = (async () => {
    const data = await fetchFeatureCatalog();
    const firstLoad = !_catalog;
    _catalog = data;
    if (firstLoad && window._scheduleInspectorRefresh) window._scheduleInspectorRefresh(0);
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
 * inspector feature 条目 + catalog → enriched 条目。
 * seed 未命中时 mapped:false，provenance=null，capabilities:[]——
 * 兜底组正常显示，不隐藏（新 feature 上线即出现在兜底组，是 seed 补录的可见信号）。
 */
function enrichFeatureEntry(feature, catalog) {
  const entry = catalog && catalog.features
    ? catalog.features.find(seed => seed.name === feature.name)
    : null;
  if (!entry) {
    return { ...feature, displayName: undefined, capabilities: [], provenance: null, group: null, mapped: false };
  }
  return {
    ...feature,
    displayName: entry.displayName,
    capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : [],
    provenance: entry.provenance,
    group: entry.group,
    mapped: true,
  };
}

/**
 * 按展示分组（用户视角：官方内置 bundled / 已安装 installed）分组。
 * 细粒度 provenance（仓库边界，开发者视角）是数据层概念，
 * 只用于弹窗来源标签，不作面板分组轴。
 * 分组顺序 = 响应携带的 groups 词表顺序，_unmapped 恒在最后；空组剔除。
 * catalog 为 null 时全部进 _unmapped。features 为空返回 []。
 */
function groupFeaturesByDisplayGroup(features, catalog) {
  if (!Array.isArray(features) || features.length === 0) return [];
  const groups = (catalog && Array.isArray(catalog.groups) && catalog.groups.length > 0)
    ? catalog.groups
    : [];
  const order = [...groups, '_unmapped'];
  const buckets = new Map(order.map(id => [id, []]));
  for (const feature of features) {
    const enriched = enrichFeatureEntry(feature, catalog);
    const key = enriched.group && buckets.has(enriched.group) ? enriched.group : '_unmapped';
    buckets.get(key).push(enriched);
  }
  return order
    .filter(id => (buckets.get(id) || []).length > 0)
    .map(id => ({ id, features: buckets.get(id) }));
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
  groupFeaturesByDisplayGroup,
  resolveDisplayName,
  provenanceI18nKey,
};
