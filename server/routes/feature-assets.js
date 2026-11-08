/**
 * feature-assets.js 路由 — 插件 UI 面资产与声明下发（ADR-0045 P1）
 *
 * 两个端点：
 *   - GET /protoclaw/feature-assets/:package/:version/*file
 *     版本化资产 URL（导入链路解出的 client/ 面文件），immutable 缓存 +
 *     防穿越（resolveClientAsset 内 realpath 校验）。
 *   - GET /api/feature-ui/declarations
 *     当前应下发的面板声明（素材 × 装配事实合成，见 plugin-ui.js）。
 *     前端 feature-ui-registry 消费。
 */

import { composePanelDeclarations } from '../feature-runtime/plugin-ui.js';
import { resolveClientAsset, streamClientAsset } from '../feature-runtime/feature-assets.js';

export function setupFeatureAssetRoutes(app) {
  // Express 4 匿名通配：req.params[0] 捕获完整剩余路径（含嵌套 assets/…）。
  // 实测命名通配 *file 在 Express 4.21 不匹配（path-to-regexp 0.x 限制）。
  // :package 是包目录段形态（@scope/name → @scope!name，由声明合成处的
  // packageDirName 产出，无路径分隔符）。
  app.get('/protoclaw/feature-assets/:package/:version/*', (req, res) => {
    const filePath = resolveClientAsset({
      packageName: req.params.package,
      version: req.params.version,
      file: req.params[0],
    });
    if (!filePath) {
      res.status(404).json({ error: 'asset not found' });
      return;
    }
    streamClientAsset(res, filePath);
  });

  app.get('/api/feature-ui/declarations', async (_req, res, next) => {
    try {
      const { declarations, warnings } = await composePanelDeclarations();
      res.json({ ok: true, declarations, warnings });
    } catch (error) {
      next(error);
    }
  });
}
