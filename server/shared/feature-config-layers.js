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
import { isValidPhProjectId } from '../routes/ph-projects.js';

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

/**
 * 项目层文件编码：`project-<projectId>.json`（ticket 043）。
 * 项目层按项目 ID 寻址（契约：项目身份不由目录决定，改名/改绑不改 ID，配置
 * 文件随 ID 稳定）。projectId 进文件名，必须先过 isValidPhProjectId 守卫——
 * 既挡路径穿越（`../` 等），也与项目表 ID 生成规则（041）同源。
 */
export function encodeProjectConfigFile(projectId) {
  if (!isValidPhProjectId(projectId)) {
    throw new Error(`Invalid projectId: ${projectId}`);
  }
  return `project-${projectId}.json`;
}

/** 项目层的完整路径（agentId 当前固定 programming-helper——项目层仅 PH 有）。 */
export function projectLayerPath(projectId, agentId = 'programming-helper') {
  return join(featureConfigDirFor(agentId), encodeProjectConfigFile(projectId));
}

/**
 * agent 层文件：workspaces/<agentId>/feature-config/agent.json。
 * agent 层覆盖该 agent 的所有目录（工作空间整体级），位于全局层与目录层之间；
 * 从空开始，稀疏存储。
 */
export function agentLayerPath(agentId = 'programming-helper') {
  return join(featureConfigDirFor(agentId), 'agent.json');
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

/**
 * 编程小助手项目层读取（ticket 043，按项目 ID 定位，文件不存在返回 {}）。
 * 只负责读文件——项目存在性校验（无效格式 400 / 未知项目 404）由调用方经
 * ph-projects 的 findPhProjectSync / getPhProject 完成，本函数不重复查表。
 */
export function readProjectLayer(projectId, agentId = 'programming-helper') {
  return readLayerFile(projectLayerPath(projectId, agentId));
}

/** agent 层读取（该 agent 整体级，文件不存在返回 {}）。 */
export function readAgentLayer(agentId = 'programming-helper') {
  return readLayerFile(agentLayerPath(agentId));
}
