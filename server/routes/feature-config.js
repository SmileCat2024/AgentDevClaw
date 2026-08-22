/**
 * Feature 配置队列 resolved API（ticket 05）
 *
 * scope→queue 注册表 + provenance 暴露：
 * - 每个 agent（scope）注册自己的队列组装函数，层的 id/label/顺序由注册方
 *   声明，server 不解释层语义；merge 与 provenance 唯一权威在框架
 *   `resolveFeatureConfig`（D1/D6），Claw 只消费。
 * - 层文件读取与 agent 侧共用 server/shared/feature-config-layers.js，
 *   避免两套读取实现漂移。
 * - provenance 查询时动态计算、永不落盘（D7）。
 * - sensitiveFields 只返回字段清单锚点，本 ticket 不做脱敏。
 */

import { basename, dirname as pathDirname, join } from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';

import { resolveFeatureConfig } from '@agentdev/core';

import {
  GLOBAL_LAYER_PATH,
  agentLayerPath,
  dirLayerPath,
  readGlobalLayer,
  readLayerFile,
} from '../shared/feature-config-layers.js';

// ── scope → queue 解析注册表（server 进程内存态，不做热更新） ──────────

/**
 * @type {Map<string, (params: { dir?: string }) => { layers: Array<{ id: string, label: string, path: string }> }>}
 */
const scopeResolvers = new Map();

/**
 * 注册一个 scope 的队列组装函数。组装函数只声明层的 id/label/顺序与
 * 层文件路径，不读取内容——内容由路由统一读取并 resolve。
 */
export function registerScopeResolver(agentId, resolver) {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    throw new Error('registerScopeResolver: agentId must be a non-empty string');
  }
  if (typeof resolver !== 'function') {
    throw new Error('registerScopeResolver: resolver must be a function');
  }
  scopeResolvers.set(agentId, resolver);
}

/** 已注册的 scope 列表（测试/诊断用）。 */
export function listRegisteredScopes() {
  return [...scopeResolvers.keys()];
}

// ── 编程小助手注册（首个消费方，与 prebuilt-agents 装配逻辑对齐） ──────

const PROGRAMMING_HELPER_ID = 'programming-helper';

registerScopeResolver(PROGRAMMING_HELPER_ID, ({ dir } = {}) => {
  const layers = [
    { id: 'global', label: '全局', path: GLOBAL_LAYER_PATH },
    { id: 'agent', label: '编程小助手', path: agentLayerPath(PROGRAMMING_HELPER_ID) },
  ];
  if (dir) {
    layers.push({
      id: `dir:${dir}`,
      label: basename(dir),
      path: dirLayerPath(dir, PROGRAMMING_HELPER_ID),
    });
  }
  return { layers };
});

// ── 敏感字段清单（脱敏另立 ticket，本版原样返回，仅留锚点） ────────────

/** 点路径清单：出现在 merged 中的这些字段会在返回体 sensitiveFields 中列出。 */
const SENSITIVE_FIELD_PATHS = ['github.token'];

function collectSensitiveFields(merged, sensitivePaths = SENSITIVE_FIELD_PATHS) {
  return sensitivePaths.filter((path) => {
    let cursor = merged;
    for (const key of path.split('.')) {
      if (!cursor || typeof cursor !== 'object') return false;
      cursor = cursor[key];
    }
    return cursor !== undefined;
  });
}

export { collectSensitiveFields };

// ── 纯逻辑：queue 组装 + resolve ───────────────────────────────────────

/**
 * 按注册表解析某 scope 的配置队列。
 * @returns {{ layers: Array<{id,label,path,sparse}>, queue }}
 * @throws 未注册的 agentId 抛错（路由转 404）
 */
export function buildScopeLayers({ agentId, dir }, resolvers = scopeResolvers) {
  const resolver = resolvers.get(agentId);
  if (!resolver) {
    throw new Error(`未注册的 scope: "${agentId}"`);
  }
  const declared = resolver({ dir });
  const layers = (declared.layers || []).map((layer) => ({
    ...layer,
    sparse: readLayerFile(layer.path),
  }));
  return { layers, queue: layers.map((layer) => layer.sparse) };
}

/** resolved 端点主体：layers + merged + provenance 三者同源一致。 */
export function resolveScopeConfig(params, resolvers = scopeResolvers) {
  const { layers, queue } = buildScopeLayers(params, resolvers);
  const { merged, provenance, warnings } = resolveFeatureConfig(queue);
  return {
    layers: layers.map(({ id, label, sparse }) => ({ id, label, sparse })),
    merged,
    provenance,
    warnings,
    sensitiveFields: collectSensitiveFields(merged),
  };
}

// ── PUT 校验（整层写回，diff 责任在前端） ──────────────────────────────

/**
 * 校验 PUT layer 的请求体。返回错误消息（null = 合法）。
 * 规则：content 必须是对象（非 null 非数组）；顶层 key 必须是字符串 featureName；
 * 内容中任何位置出现 null 拒绝（null 是 merge 的删除语义，不落盘）。
 */
export function validateLayerContent(content) {
  if (content === null || content === undefined || typeof content !== 'object' || Array.isArray(content)) {
    return 'layer content must be a non-null object';
  }
  for (const [key, value] of Object.entries(content)) {
    if (typeof key !== 'string' || !key.trim()) {
      return 'top-level keys must be non-empty feature names';
    }
    if (containsNull(value)) {
      return `null is not allowed in layer content (at key '${key}')`;
    }
  }
  return null;
}

function containsNull(value) {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (typeof value === 'object') return Object.values(value).some(containsNull);
  return false;
}

/**
 * 解析 PUT 请求的目标层文件路径。层定位完全由对应 scope 的组装函数声明；
 * 仅当组装函数未声明任何 id 为 'global' 的层时，global 层才回落到全局文件
 * （等价现状全局编辑的兼容路径）。找不到时返回 null。
 */
export function resolveWriteTarget({ agentId, layerId }, resolvers = scopeResolvers) {
  if (!resolvers.get(agentId)) {
    throw new Error(`未注册的 scope: "${agentId}"`);
  }
  // 组装函数按 dir 声明目录层；id 约定为 `dir:<path>`（见 ticket 05 示例），
  // 写回时从 layerId 还原 dir 以便组装函数重新定位层文件。
  const dir = typeof layerId === 'string' && layerId.startsWith('dir:') ? layerId.slice(4) : undefined;
  const { layers } = buildScopeLayers({ agentId, dir }, resolvers);
  const layer = layers.find((entry) => entry.id === layerId);
  if (layer) return layer.path;
  if (layerId === 'global') return GLOBAL_LAYER_PATH;
  return null;
}

// ── Express 路由 ───────────────────────────────────────────────────────

export function setupFeatureConfigRoutes(app, express) {
  app.get('/protoclaw/feature_config/resolved', (req, res) => {
    const agentId = req.query.agentId;
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId required' });
    }
    const dir = req.query.dir || undefined;
    try {
      res.json(resolveScopeConfig({ agentId, dir }));
    } catch (error) {
      // 未注册 scope → 明确 404；其他异常 → 500
      if (/未注册的 scope/.test(String(error?.message))) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/protoclaw/feature_config/layer', express.json(), (req, res) => {
    const { agentId, layerId, content } = req.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId required' });
    }
    if (!layerId || typeof layerId !== 'string') {
      return res.status(400).json({ error: 'layerId required' });
    }
    const validationError = validateLayerContent(content);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    let targetPath;
    try {
      targetPath = resolveWriteTarget({ agentId, layerId });
    } catch (error) {
      if (/未注册的 scope/.test(String(error?.message))) {
        return res.status(404).json({ error: error.message });
      }
      return res.status(500).json({ error: error.message });
    }
    if (!targetPath) {
      return res.status(404).json({ error: `未知 layerId: "${layerId}"` });
    }
    try {
      const dir = pathDirname(targetPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(targetPath, JSON.stringify(content, null, 2), 'utf8');
      res.json({ ok: true, layerId, path: targetPath });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
