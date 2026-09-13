/**
 * feature-catalog routes — GET /api/feature-catalog
 *
 * 返回 feature 分组词表与种子映射表（P1 数据源为手维护 seed，
 * 见 server/shared/feature-registry.js）。前端 Features 面板据此
 * 分组折叠渲染；P3 Registry 落地后本路由原地升级，响应 schema 不变。
 */

import { loadFeatureRegistry, FEATURE_REGISTRY_SEED_PATH } from '../shared/feature-registry.js';

export function setupFeatureCatalogRoutes(app) {
  app.get('/api/feature-catalog', (req, res) => {
    try {
      const registry = loadFeatureRegistry();
      res.json(registry);
    } catch (err) {
      // seed 损坏是宿主数据问题，显式报错并给出修复路径，不静默回退空表
      res.status(500).json({
        error: 'feature_registry_seed_invalid',
        message: String(err && err.message ? err.message : err),
        hint: `检查 ${FEATURE_REGISTRY_SEED_PATH} 后重试`,
      });
    }
  });
}
