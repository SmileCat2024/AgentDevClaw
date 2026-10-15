/**
 * Workspace Settings — 用户工作空间集的呈现策略与资源策略
 *
 *   GET  /protoclaw/workspace_settings                    — 读覆盖表（两节）
 *   PUT  /protoclaw/workspace_settings                    — 写呈现策略覆盖（{ agentId, policy }）
 *   PUT  /protoclaw/workspace_settings/resource_policy    — 写权限项用户值（{ agentId, permissionId, value }）
 *
 * 概念层级：工作空间是用户资产（用户可安装任意工作空间集，甚至不装智能
 * 编码空间），本设置随用户工作空间集走，不属于随 Claw 的系统设置。
 *
 * - workspaceVisibility：呈现策略覆盖（ADR-0025 收尾）。默认策略由工作空间
 *   作者在 metadata.json 声明，本文件只存用户覆盖层（agentId → 'auto' |
 *   'always'），缺省即作者默认。
 * - resourcePolicy：per-workspace 资源策略（ADR-0027）。首个字段
 *   maxLiveRuntimes 限存活 runtime 子进程数；缺省即不限。
 *
 * 写入约束：两个节同文件共存，任一写路径必须整文件读改写（保留兄弟节），
 * 不得整体重写为自己单节的投影。存储于用户数据根目录 workspace-settings.json，
 * 与 proxy-config 等同构。settingsPath 参数是测试缝（隔离用户数据目录）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { USER_DATA_ROOT } from '../shared/constants.js';
import { countLiveRuntimeProcessesByAgent } from '../shared/agent-access.js';
import { PERMISSION_ITEMS, projectPermissionValues } from '../shared/permission-registry.js';

const DEFAULT_WORKSPACE_SETTINGS_PATH = path.join(USER_DATA_ROOT, 'workspace-settings.json');
const VALID_POLICIES = new Set(['auto', 'always']);

// 单进程内存缓存（按路径隔离，测试注入路径互不串扰）：读路径与合流读取
// （agent-connected）共用同一模块实例，无跨进程失效问题。
const _overrideCaches = new Map();
const _resourcePolicyCaches = new Map();

/** 读整份设置文件（无缓存；写入路径经它拿兄弟节最新值）。损坏/缺省返回 {}。 */
async function readWorkspaceSettingsFile(settingsPath) {
  try {
    const raw = await fsp.readFile(settingsPath, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[workspace-settings] 读取失败（按缺省处理）: ${error?.message || error}`);
    }
    return {};
  }
}

/** 原子写整份设置文件（临时文件 + rename）。 */
async function writeWorkspaceSettingsFile(settingsPath, data) {
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, settingsPath);
}

// 写路径互斥（按路径键控，模式对齐 session-access 的 _indexLocks）：设置
// 文件是整文件读改写，并发写会互抹兄弟节（后写者整体覆盖前者刚写入的
// 节），读改写必须整段在锁窗口内。锁条目是独立 release 的 promise，与
// 任务结果解耦——单个任务失败不污染后续等待者；完成后清理条目防 Map
// 增长。进程内锁不跨进程，跨进程由唯一临时名（进程 pid）+ rename 原子
// 性兜底。
const _writeLocks = new Map();

async function withSettingsWriteLock(settingsPath, task) {
  const prev = _writeLocks.get(settingsPath) || Promise.resolve();
  let release;
  const next = new Promise(r => release = r);
  _writeLocks.set(settingsPath, next);
  await prev;
  try {
    return await task();
  } finally {
    release();
    if (_writeLocks.get(settingsPath) === next) _writeLocks.delete(settingsPath);
  }
}

/** workspaceVisibility 节 → 合法覆盖投影（{ <agentId>: 'auto' | 'always' }）。 */
function projectWorkspaceVisibility(node) {
  const overrides = {};
  if (!node || typeof node !== 'object') return overrides;
  for (const [agentId, policy] of Object.entries(node)) {
    if (typeof agentId === 'string' && agentId.trim() && VALID_POLICIES.has(policy)) {
      overrides[agentId.trim()] = policy;
    }
  }
  return overrides;
}

/** resourcePolicy 节 → 合法策略投影（{ <agentId>: { <permissionId>: value }）。 */
function projectResourcePolicies(node) {
  const policies = {};
  if (!node || typeof node !== 'object' || Array.isArray(node)) return policies;
  for (const [agentId, policy] of Object.entries(node)) {
    if (typeof agentId !== 'string' || !agentId.trim()) continue;
    const permissions = projectPermissionValues(policy);
    if (Object.keys(permissions).length > 0) policies[agentId.trim()] = permissions;
  }
  return policies;
}

/**
 * 读用户覆盖表（{ <agentId>: 'auto' | 'always' }）。损坏/缺省返回空表。
 */
export async function readWorkspaceVisibilityOverrides({ settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  if (_overrideCaches.has(settingsPath)) return _overrideCaches.get(settingsPath);
  const data = await readWorkspaceSettingsFile(settingsPath);
  const overrides = projectWorkspaceVisibility(data.workspaceVisibility);
  _overrideCaches.set(settingsPath, overrides);
  return overrides;
}

/**
 * 写单条覆盖。policy='auto' 即回到作者默认（从覆盖表删除该条）。
 * 整文件读改写，保留 resourcePolicy 等兄弟节。
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
  const overrides = await withSettingsWriteLock(settingsPath, async () => {
    const current = await readWorkspaceSettingsFile(settingsPath);
    const next = projectWorkspaceVisibility(current.workspaceVisibility);
    if (policy === 'always') {
      next[normalizedAgentId] = 'always';
    } else {
      delete next[normalizedAgentId];
    }
    await writeWorkspaceSettingsFile(settingsPath, { ...current, version: 1, workspaceVisibility: next });
    _overrideCaches.set(settingsPath, next);
    return next;
  });
  return { ok: true, agentId: normalizedAgentId, policy, workspaceVisibility: { ...overrides } };
}

/**
 * 读资源策略表（{ <agentId>: { maxLiveRuntimes } }，ADR-0027）。损坏/缺省返回空表。
 */
export async function readWorkspaceResourcePolicies({ settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  if (_resourcePolicyCaches.has(settingsPath)) return _resourcePolicyCaches.get(settingsPath);
  const data = await readWorkspaceSettingsFile(settingsPath);
  const policies = projectResourcePolicies(data.resourcePolicy);
  _resourcePolicyCaches.set(settingsPath, policies);
  return policies;
}

/**
 * 写单个权限项用户值。value=null 即清除该工作空间对此权限项的覆盖，回到缺省状态。
 * 整文件读改写，保留 workspaceVisibility 等兄弟节。
 * @returns {Promise<{ ok: true, agentId: string, permissionId: string, value: unknown, resourcePolicy: Record<string, Record<string, unknown>> }>}
 */
export async function writeWorkspacePermissionValue(agentId, permissionId, value, { settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) {
    throw Object.assign(new Error('agentId is required'), { status: 400 });
  }
  const permission = PERMISSION_ITEMS[permissionId];
  if (!permission || (value !== null && !permission.validate(value))) {
    throw Object.assign(new Error(`Invalid value for permission item: ${permissionId}`), { status: 400 });
  }
  const policies = await withSettingsWriteLock(settingsPath, async () => {
    const current = await readWorkspaceSettingsFile(settingsPath);
    const next = projectResourcePolicies(current.resourcePolicy);
    const workspacePolicy = { ...(next[normalizedAgentId] || {}) };
    if (value === null) delete workspacePolicy[permissionId];
    else workspacePolicy[permissionId] = value;
    if (Object.keys(workspacePolicy).length > 0) next[normalizedAgentId] = workspacePolicy;
    else delete next[normalizedAgentId];
    await writeWorkspaceSettingsFile(settingsPath, { ...current, version: 1, resourcePolicy: next });
    _resourcePolicyCaches.set(settingsPath, next);
    return next;
  });
  return {
    ok: true,
    agentId: normalizedAgentId,
    permissionId,
    value,
    resourcePolicy: { ...policies },
  };
}

export async function writeWorkspaceResourcePolicy(agentId, maxLiveRuntimes, options = {}) {
  const result = await writeWorkspacePermissionValue(agentId, PERMISSION_ITEMS.maxLiveRuntimes.id, maxLiveRuntimes, options);
  return { ...result, maxLiveRuntimes: maxLiveRuntimes };
}

export function setupWorkspaceSettingsRoutes(app, express) {
  app.get('/protoclaw/workspace_settings', async (_req, res) => {
    res.json({
      workspaceVisibility: await readWorkspaceVisibilityOverrides(),
      resourcePolicy: await readWorkspaceResourcePolicies(),
      // 存活 runtime 现状投影（ADR-0027）：设置面板展示「当前 N」与
      // coder_shell 预检共用本端点，配额策略与现状一次读齐。
      liveRuntimes: countLiveRuntimeProcessesByAgent(),
    });
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

  app.put('/protoclaw/workspace_settings/resource_policy', express.json(), async (req, res, next) => {
    try {
      const { agentId, permissionId, value } = req.body || {};
      if (typeof permissionId !== 'string' || value === undefined) {
        return res.status(400).json({ error: 'permissionId and value are required (null clears the value)' });
      }
      const result = await writeWorkspacePermissionValue(agentId, permissionId, value);
      res.json(result);
    } catch (error) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });
}
