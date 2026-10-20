/**
 * coder 工作空间级 feature 预设（一次性出厂预填）
 *
 * 首次启动（coder agent 层文件不存在）时写入工作空间预设配置；文件已存在
 * 则完全不动——预填是一次性的"出厂值"，用户此后在设置菜单的任何修改/
 * 清除都是显式用户配置，不会被升级或重启覆盖回预设。配置项的 schema、
 * 取值范围与字段语义由 feature manifest 声明（system_feature_manifests），
 * 此处只预填值。
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import { agentLayerPath } from '../shared/feature-config-layers.js';

/**
 * coder 工作空间出厂预设。
 *
 * API 重试：正文输出达到上限、网络错误两类默认开启，共享重试预算 5。
 * 字段及默认值由 feature 提供，此处声明 coder 的出厂预设。
 */
export const CODER_FEATURE_PRESETS = {
  'force-continuation': {
    outputTruncation: true,
    apiErrorRetry: true,
    maxConsecutiveContinuations: 5,
  },
};

/**
 * 确保 coder agent 层存在出厂预设。文件已存在（含损坏）一律不动。
 * @returns {{ created: boolean, layerPath?: string }}
 */
export function ensureCoderFeaturePresets(
  { presets = CODER_FEATURE_PRESETS, layerPath = agentLayerPath('coder') } = {},
) {
  if (existsSync(layerPath)) {
    return { created: false };
  }
  mkdirSync(dirname(layerPath), { recursive: true });
  writeFileSync(layerPath, JSON.stringify(presets, null, 2), 'utf8');
  return { created: true, layerPath };
}
