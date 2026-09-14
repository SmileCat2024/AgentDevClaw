/**
 * $mount 装配声明（feature 装配与配置统一的数据模型）
 *
 * 层文件中 feature 配置项下的 `$mount` 保留键声明"该 feature 是用户从 Feature
 * 仓库装配的包"，携带装配事实 { package, version }；feature 项的其余键仍是其
 * 自身配置值，两者互不污染。
 *
 * 语义对齐三层配置树：
 * - 允许层：global / agent / coder；目录层（dir:*）与会话注入（session）拒绝
 *   （装配是 agent 身份级事实，不开目录粒度——装配一期决策）
 * - 后层 $mount 整体替换前层（装配事实不是配置值，不做字段级合并）
 * - $mount: null = 卸载（对齐框架 resolveFeatureConfig 的 null 删除语义；
 *   层文件经 PUT 校验本不含 null，此形态仅出现于手工编辑层文件）
 *
 * 本模块是 $mount 提取与校验的唯一权威：agent 侧（构造期提取，宿主挂载钩子
 * 消费 pendingFeatureMounts）与 server 侧（PUT 写回校验）共用，避免两套实现漂移。
 */

import { isExactSemver, isValidPackageName } from '../feature-runtime/schemas.js';

export const MOUNT_KEY = '$mount';

/** 允许声明 $mount 的层角色。 */
const MOUNT_ALLOWED_LAYER_IDS = new Set(['global', 'agent', 'coder']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验单个 $mount 声明值的结构。返回错误消息（null = 合法）。
 * 不接受 null（null 是卸载语义，仅在 extractFeatureMounts 的层序合并中处理）。
 */
export function validateMountEntry(value, { featureName = '(unknown)' } = {}) {
  if (!isPlainObject(value)) {
    return `feature '${featureName}' 的 $mount 必须是 { package, version } 对象`;
  }
  if (!isValidPackageName(String(value.package || ''))) {
    return `feature '${featureName}' 的 $mount.package 不是合法 npm 包名：${String(value.package)}`;
  }
  if (!isExactSemver(String(value.version || ''))) {
    return `feature '${featureName}' 的 $mount.version 必须是精确 semver：${String(value.version)}`;
  }
  return null;
}

/**
 * 从有序层提取 $mount 装配声明，并产出剔除 $mount 键后的纯配置层。
 *
 * @param {Array<{id: string, config: object}>} layers 有序层，id 为层角色
 * @returns {{mounts: Map<string, {package: string, version: string, layerId: string}>, configLayers: object[]}}
 * @throws 不允许的层声明 $mount、或 $mount 结构非法时抛错——阻止带着非法装配
 *   事实的 runtime 启动（fail fast），错误消息自带层角色与 feature 名。
 */
export function extractFeatureMounts(layers) {
  const mounts = new Map();
  const configLayers = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    const id = String(layer?.id ?? '');
    const config = layer?.config;
    if (!isPlainObject(config)) {
      configLayers.push(config || {});
      continue;
    }
    let layerConfig = config;
    for (const [featureName, featureConfig] of Object.entries(config)) {
      if (!isPlainObject(featureConfig) || !(MOUNT_KEY in featureConfig)) continue;
      if (!MOUNT_ALLOWED_LAYER_IDS.has(id)) {
        throw new Error(
          `层 '${id}' 不允许声明 ${MOUNT_KEY}（装配是 agent 身份级配置，目录层与会话注入不支持）：${featureName}`
        );
      }
      const mount = featureConfig[MOUNT_KEY];
      if (mount === null) {
        mounts.delete(featureName);
      } else {
        const error = validateMountEntry(mount, { featureName });
        if (error) throw new Error(`层 '${id}' 中 ${error}`);
        mounts.set(featureName, {
          package: String(mount.package).trim(),
          version: String(mount.version).trim(),
          layerId: id,
        });
      }
      // 纯配置层剔除 $mount 键（浅拷贝，不污染层对象）
      if (layerConfig === config) {
        layerConfig = { ...config };
      }
      layerConfig[featureName] = { ...featureConfig };
      delete layerConfig[featureName][MOUNT_KEY];
    }
    configLayers.push(layerConfig);
  }
  return { mounts, configLayers };
}
