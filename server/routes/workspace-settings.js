/**
 * Workspace Settings — 用户工作空间集的呈现策略（ADR-0025 收尾）
 *
 *   GET  /protoclaw/workspace_settings  — 工作空间显示策略覆盖表
 *   PUT  /protoclaw/workspace_settings  — 写单条覆盖（{ agentId, policy }）
 *
 * 概念层级：工作空间是用户资产（用户可安装任意工作空间集，甚至不装智能
 * 编码空间），本设置随用户工作空间集走，不属于随 Claw 的系统设置。默认
 * 策略由工作空间作者在 metadata.json 声明（visibility: on-demand → 自动；
 * persistent → 始终显示），本文件只存用户覆盖层（agentId → 'auto' |
 * 'always'），缺省即作者默认。存储于用户数据根目录 workspace-settings.json，
 * 与 proxy-config 等同构。settingsPath 参数是测试缝（隔离用户数据目录）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { USER_DATA_ROOT } from '../shared/constants.js';

const DEFAULT_WORKSPACE_SETTINGS_PATH = path.join(USER_DATA_ROOT, 'workspace-settings.json');
const VALID_POLICIES = new Set(['auto', 'always']);

// 单进程内存缓存（按路径隔离，测试注入路径互不串扰）：PUT 与合流读取
// （agent-connected）共用同一模块实例，无跨进程失效问题。
const _overrideCaches = new Map();

/**
 * 读用户覆盖表（{ <agentId>: 'auto' | 'always' }）。损坏/缺省返回空表。
 */
export async function readWorkspaceVisibilityOverrides({ settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  if (_overrideCaches.has(settingsPath)) return _overrideCaches.get(settingsPath);
  let overrides = {};
  try {
    const raw = await fsp.readFile(settingsPath, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.workspaceVisibility === 'object' && data.workspaceVisibility) {
      for (const [agentId, policy] of Object.entries(data.workspaceVisibility)) {
        if (typeof agentId === 'string' && agentId.trim() && VALID_POLICIES.has(policy)) {
          overrides[agentId.trim()] = policy;
        }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[workspace-settings] 读取失败（按无覆盖处理）: ${error?.message || error}`);
    }
  }
  _overrideCaches.set(settingsPath, overrides);
  return overrides;
}

/**
 * 写单条覆盖。policy='auto' 即回到作者默认（从覆盖表删除该条）。
 * @returns {Promise<{ ok: true, agentId: string, policy: 'auto'|'always', workspaceVisibility: Record<string, string> }>}
 */
export async function writeWorkspaceVisibilityOverride(agentId, policy, { settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) {
    throw Object.assign(new Error('agentId is required'), { status: 400 });
  }
  if (!VALID_POLICIES.has(policy)) {
    throw Object.assign(new Error(`policy must be one of: ${[...VALID_POLICIES].join(', ')}`), { status: 400 });
  }
  const overrides = { ...(await readWorkspaceVisibilityOverrides({ settingsPath })) };
  if (policy === 'always') {
    overrides[normalizedAgentId] = 'always';
  } else {
    delete overrides[normalizedAgentId];
  }
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, workspaceVisibility: overrides }, null, 2));
  await fsp.rename(tmp, settingsPath);
  _overrideCaches.set(settingsPath, overrides);
  return { ok: true, agentId: normalizedAgentId, policy, workspaceVisibility: { ...overrides } };
}

export function setupWorkspaceSettingsRoutes(app, express) {
  app.get('/protoclaw/workspace_settings', async (_req, res) => {
    res.json({ workspaceVisibility: await readWorkspaceVisibilityOverrides() });
  });

  app.put('/protoclaw/workspace_settings', express.json(), async (req, res, next) => {
    try {
      const result = await writeWorkspaceVisibilityOverride(req.body?.agentId, req.body?.policy);
      res.json(result);
    } catch (error) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });
}
