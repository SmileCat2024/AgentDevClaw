/**
 * 配置队列层文件读写公共实现（tickets 03/04/05）
 *
 * agent 侧（programming-helper 目录层 / coder 配置组）与 server 侧
 * （resolved API / layer 写回 API）共用同一套读取与编码逻辑，
 * 避免两套实现漂移。全局层文件路径也在此统一定义。
 */

import { createHash } from 'crypto';
import { basename, join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';

import { USER_DATA_ROOT } from './constants.js';

/** 全局层：feature-setup.json（已由 ticket 02 清洗为稀疏）。 */
export const GLOBAL_LAYER_PATH = join(USER_DATA_ROOT, 'feature-setup.json');

/** 各 agent 的层文件目录：workspaces/<agentId>/feature-config/ */
export function featureConfigDirFor(agentId) {
  return join(USER_DATA_ROOT, 'workspaces', agentId, 'feature-config');
}

/**
 * 目录层文件编码：`dir-<hash8>-<basename>.json`。
 * hash = 目录绝对路径的 sha256 前 8 位 hex（稳定，跨进程一致）；
 * basename 仅用于人工可读性。路径分隔符差异（win/linux）会导致不同 hash，
 * 同一目录在同一机器上始终稳定。
 */
export function encodeDirConfigFile(workspaceDir) {
  const resolved = resolve(workspaceDir);
  const shortHash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `dir-${shortHash}-${basename(resolved)}.json`;
}

/** 目录层的完整路径。 */
export function dirLayerPath(workspaceDir, agentId = 'programming-helper') {
  return join(featureConfigDirFor(agentId), encodeDirConfigFile(workspaceDir));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把任意解析结果规范为稀疏 FeatureConfig 对象；非法形态一律视为空层。 */
function toSparseConfig(parsed) {
  return isPlainObject(parsed) ? parsed : {};
}

/**
 * 读取一个层文件并规范为对象。文件不存在 = 该层无内容（正常态），返回 {}。
 * JSON 损坏或非对象同样返回 {}（与 agent 侧现状行为一致，不抛错）。
 */
export function readLayerFile(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return toSparseConfig(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return {};
  }
}

/** 全局层读取（含顶层 runtimes → lsp.runtimes 的向后兼容迁移）。 */
export function readGlobalLayer(globalPath = GLOBAL_LAYER_PATH) {
  const config = readLayerFile(globalPath);
  if (config.runtimes && typeof config.runtimes === 'object') {
    config.lsp = { ...(config.lsp || {}), runtimes: config.runtimes };
    delete config.runtimes;
  }
  return config;
}

/** 编程小助手目录层读取（按目录定位，文件不存在返回 {}）。 */
export function readDirLayer(workspaceDir, agentId = 'programming-helper') {
  return readLayerFile(dirLayerPath(workspaceDir, agentId));
}
