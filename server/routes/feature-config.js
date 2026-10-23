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

import { resolveFeatureConfig } from '@agentdevjs/core';

import {
  GLOBAL_LAYER_PATH,
  agentLayerPath,
  dirLayerPath,
  projectLayerPath,
  readGlobalLayer,
  readLayerFile,
} from '../shared/feature-config-layers.js';
import { MOUNT_KEY, validateMountEntry } from '../shared/feature-mount.js';
import {
  ACCUMULATED_FIELD_PATHS,
  collapseAccumulatedFields,
} from '../shared/feature-config-accumulate.js';
import { findPhProjectSync } from './ph-projects.js';

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

/**
 * 项目层定位前校验（ticket 043）：解析真实项目后才能定位层文件——
 * 非法 ID 格式（findPhProjectSync throw 400 语义）与未知项目（404 语义）
 * 都明确失败，绝不退回目录层。同步查表与 scope resolver 的同步签名对齐。
 */
function requirePhProjectForLayer(projectId) {
  const project = findPhProjectSync(projectId); // 非法格式直接 throw
  if (!project) {
    const error = new Error(`Unknown project: ${projectId}`);
    error.statusCode = 404;
    throw error;
  }
  return project;
}

registerScopeResolver(PROGRAMMING_HELPER_ID, ({ dir, projectId } = {}) => {
  if (dir && projectId) {
    const error = new Error('dir 与 projectId 是互斥的归属参数，不能同时提供');
    error.statusCode = 400;
    throw error;
  }
  const layers = [
    { id: 'global', label: '全局', path: GLOBAL_LAYER_PATH },
    { id: 'agent', label: '编程小助手', path: agentLayerPath(PROGRAMMING_HELPER_ID) },
  ];
  if (projectId) {
    // 项目链（ticket 043）：global → agent → project → session，不读目录层
    const project = requirePhProjectForLayer(projectId);
    layers.push({
      id: `project:${projectId}`,
      label: project.name,
      path: projectLayerPath(projectId, PROGRAMMING_HELPER_ID),
    });
  } else if (dir) {
    layers.push({
      id: `dir:${dir}`,
      label: basename(dir),
      path: dirLayerPath(dir, PROGRAMMING_HELPER_ID),
    });
  }
  return { layers };
});

// coder 独立 APP（ADR-0025）：配置队列与编程小助手同构——[全局, 本 APP agent
// 层]，无目录层。coder/agent.js 装配时按同一队列读取合并。
const CODER_SCOPE_ID = 'coder';

registerScopeResolver(CODER_SCOPE_ID, () => ({
  layers: [
    { id: 'global', label: '全局', path: GLOBAL_LAYER_PATH },
    { id: 'agent', label: 'coder', path: agentLayerPath(CODER_SCOPE_ID) },
  ],
}));

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
 * 按注册表解析某 scope 的配置队列。dir / projectId 归属参数原样透传给
 * 组装函数（PH 组装函数据此选目录层或项目层，ticket 043）。
 * @returns {{ layers: Array<{id,label,path,sparse}>, queue }}
 * @throws 未注册的 agentId 抛错（路由转 404）
 */
export function buildScopeLayers({ agentId, dir, projectId }, resolvers = scopeResolvers) {
  const resolver = resolvers.get(agentId);
  if (!resolver) {
    throw new Error(`未注册的 scope: "${agentId}"`);
  }
  const declared = resolver({ dir, projectId });
  const layers = (declared.layers || []).map((layer) => ({
    ...layer,
    sparse: readLayerFile(layer.path),
  }));
  return { layers, queue: layers.map((layer) => layer.sparse) };
}

/** resolved 端点主体：layers + merged + provenance 三者同源一致。 */
export function resolveScopeConfig(params, resolvers = scopeResolvers) {
  const { layers, queue } = buildScopeLayers(params, resolvers);
  // 累加型多值字段跨层叠加后进 merge——与 agent 侧构造期行为同源，
  // 保证 UI 预览（merged）与运行时实际生效配置一致。
  const { merged, provenance, warnings } = resolveFeatureConfig(collapseAccumulatedFields(queue));
  return {
    layers: layers.map(({ id, label, sparse }) => ({ id, label, sparse })),
    merged,
    provenance,
    warnings,
    sensitiveFields: collectSensitiveFields(merged),
    // 累加字段清单：前端据此把这些字段渲染为"上游只读 + 本层追加"
    accumulatedFields: [...ACCUMULATED_FIELD_PATHS],
  };
}

// ── PUT 校验（整层写回，diff 责任在前端） ──────────────────────────────

/**
 * 校验 PUT layer 的请求体。返回错误消息（null = 合法）。
 * 规则：content 必须是对象（非 null 非数组）；顶层 key 必须是字符串 featureName；
 * 内容中任何位置出现 null 拒绝（null 是 merge 的删除语义，不落盘）。
 * 带 layerId 时追加 $mount 约束：目录层（dir:*）拒绝 $mount 装配声明，
 * 允许层校验其结构（合法性与 agent 侧提取共用 shared/feature-mount.js）。
 * 不带 layerId 时（旧调用形态）不做 $mount 约束。
 */
export function validateLayerContent(content, { layerId } = {}) {
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
  if (layerId !== undefined) {
    for (const [featureName, featureConfig] of Object.entries(content)) {
      if (typeof featureConfig !== 'object' || featureConfig === null || Array.isArray(featureConfig)) continue;
      if (!(MOUNT_KEY in featureConfig)) continue;
      if (String(layerId).startsWith('dir:') || String(layerId).startsWith('project:')) {
        return `layer '${layerId}' 不支持 ${MOUNT_KEY} 装配声明（feature '${featureName}'）；装配是 agent 身份级配置，目录层与项目层均不开放`;
      }
      const mountError = validateMountEntry(featureConfig[MOUNT_KEY], { featureName });
      if (mountError) return mountError;
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
  // 组装函数按 dir / projectId 声明归属层；id 约定为 `dir:<path>` 与
  // `project:<id>`（ticket 043），写回时从 layerId 还原参数以便组装函数
  // 重新定位层文件（项目层经 requirePhProjectForLayer 校验真实项目存在）。
  const dir = typeof layerId === 'string' && layerId.startsWith('dir:') ? layerId.slice(4) : undefined;
  const projectId = typeof layerId === 'string' && layerId.startsWith('project:') ? layerId.slice(8) : undefined;
  const { layers } = buildScopeLayers({ agentId, dir, projectId }, resolvers);
  const layer = layers.find((entry) => entry.id === layerId);
  if (layer) return layer.path;
  if (layerId === 'global') return GLOBAL_LAYER_PATH;
  return null;
}

// ── Express 路由 ───────────────────────────────────────────────────────

/** 归属类确定性错误 → HTTP 语义码（其余异常 → 500）。 */
function mapScopeError(res, error) {
  const message = String(error?.message || error);
  if (/未注册的 scope/.test(message)) {
    return res.status(404).json({ error: message });
  }
  // 项目归属校验（ticket 043）：非法 ID 格式 400；未知项目 404——绝不退回目录层
  if (/Invalid projectId/.test(message)) {
    return res.status(400).json({ error: message });
  }
  if (/Unknown project/.test(message)) {
    return res.status(404).json({ error: message });
  }
  if (/互斥的归属参数/.test(message)) {
    return res.status(400).json({ error: message });
  }
  return res.status(500).json({ error: message });
}

export function setupFeatureConfigRoutes(app, express) {
  app.get('/protoclaw/feature_config/resolved', (req, res) => {
    const agentId = req.query.agentId;
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId required' });
    }
    const dir = req.query.dir || undefined;
    // 项目会话（ticket 043）以 projectId 查询项目链；dir 与 projectId 互斥
    const projectId = req.query.projectId || undefined;
    try {
      res.json(resolveScopeConfig({ agentId, dir, projectId }));
    } catch (error) {
      mapScopeError(res, error);
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
    const validationError = validateLayerContent(content, { layerId });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    let targetPath;
    try {
      targetPath = resolveWriteTarget({ agentId, layerId });
    } catch (error) {
      return mapScopeError(res, error);
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
