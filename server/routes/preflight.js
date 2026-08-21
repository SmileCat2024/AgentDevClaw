/**
 * 装配预检路由（工作项 D 前端数据源）
 *
 * POST /protoclaw/preflight
 *   body: { features?: string[], modulePaths?: Record<string, string> }
 *   - features: 按名选择要参与预检的 feature（缺省 = 全部可实例化的）
 *   - modulePaths: 候选 feature 的本地模块路径（feature-creator 场景：
 *     还未安装的开发中模块，与新代码一起做假设装配检查）
 *
 * 返回 preflightAssembly 的完整结果：ok / issues（含修复建议）/ assembly
 * （拓扑序 + 工具归属 + 钩子清单）。供装配 UI 亮红与 agent HTTP 消费。
 */

import { preflightAssembly } from '@agentdev/core';
import { pathToFileURL } from 'url';

/** 可实例化的 feature 类注册表（与 system-feature-config 相同的发现面） */
async function discoverFeatureConstructors() {
  const registry = new Map(); // name -> ctor
  const importPaths = ['agentdev', '../../local-features/dist/index.js'];
  for (const importPath of importPaths) {
    try {
      const mod = await import(importPath);
      for (const [, Ctor] of Object.entries(mod)) {
        if (typeof Ctor !== 'function' || !/Feature$/.test(Ctor.name || '')) continue;
        try {
          const probe = new Ctor();
          const name = probe.name || Ctor.name;
          if (typeof probe.getTools === 'function') registry.set(name, Ctor);
        } catch { /* 需要构造参数的跳过 */ }
      }
    } catch { /* 模块不可用 */ }
  }
  return registry;
}

async function instantiateSelected(names, registry) {
  const features = [];
  for (const name of names) {
    const Ctor = registry.get(name);
    if (!Ctor) continue;
    try { features.push(new Ctor()); } catch { /* 跳过 */ }
  }
  return features;
}

async function loadCandidateFeatures(modulePaths) {
  const features = [];
  for (const [name, modulePath] of Object.entries(modulePaths ?? {})) {
    try {
      const mod = await import(pathToFileURL(modulePath).href);
      const Ctor = Object.values(mod).find(
        (v) => typeof v === 'function' && /Feature$/.test(v.name || '')
      );
      if (!Ctor) continue;
      const instance = new Ctor();
      if (instance.name === name) features.push(instance);
    } catch { /* 候选模块加载失败：留给调用方看 import 错误，这里不阻断其余检查 */ }
  }
  return features;
}

export function setupPreflightRoutes(app, express) {
  app.post('/protoclaw/preflight', express.json(), async (req, res) => {
    try {
      const { features: selected, modulePaths } = req.body ?? {};

      const registry = await discoverFeatureConstructors();
      const names = Array.isArray(selected) && selected.length > 0
        ? selected.filter(n => registry.has(n))
        : [...registry.keys()];

      const existing = await instantiateSelected(names, registry);
      const candidates = await loadCandidateFeatures(modulePaths);

      const result = preflightAssembly([...existing, ...candidates]);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
