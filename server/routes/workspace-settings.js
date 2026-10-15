/**
 * Workspace Settings — 用户工作空间集的呈现策略与资源策略
 *
 *   GET  /protoclaw/workspace_settings                    — 读覆盖表（两节）
 *   PUT  /protoclaw/workspace_settings                    — 写呈现策略覆盖（{ agentId, policy }）
 *   PUT  /protoclaw/workspace_settings/resource_policy    — 写资源策略（{ agentId, maxLiveRuntimes }）
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

/** resourcePolicy 节 → 合法策略投影（{ <agentId>: { maxLiveRuntimes } }）。 */
function projectResourcePolicies(node) {
  const policies = {};
  if (!node || typeof node !== 'object') return policies;
  for (const [agentId, policy] of Object.entries(node)) {
    if (typeof agentId === 'string' && agentId.trim() && policy && typeof policy === 'object') {
      const limit = policy.maxLiveRuntimes;
      if (Number.isInteger(limit) && limit > 0) {
        policies[agentId.trim()] = { maxLiveRuntimes: limit };
      }
    }
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
 * 写单条资源策略。maxLiveRuntimes=null 即清除该工作空间的 runtime 配额
 * （回到缺省不限）。整文件读改写，保留 workspaceVisibility 等兄弟节。
 * @returns {Promise<{ ok: true, agentId: string, maxLiveRuntimes: number|null, resourcePolicy: Record<string, { maxLiveRuntimes: number }> }>}
 */
export async function writeWorkspaceResourcePolicy(agentId, maxLiveRuntimes, { settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) {
    throw Object.assign(new Error('agentId is required'), { status: 400 });
  }
  if (maxLiveRuntimes !== null && !(Number.isInteger(maxLiveRuntimes) && maxLiveRuntimes > 0)) {
    throw Object.assign(new Error('maxLiveRuntimes must be a positive integer, or null to clear'), { status: 400 });
  }
  const policies = await withSettingsWriteLock(settingsPath, async () => {
    const current = await readWorkspaceSettingsFile(settingsPath);
    const next = projectResourcePolicies(current.resourcePolicy);
    if (maxLiveRuntimes === null) {
      delete next[normalizedAgentId];
    } else {
      next[normalizedAgentId] = { maxLiveRuntimes };
    }
    await writeWorkspaceSettingsFile(settingsPath, { ...current, version: 1, resourcePolicy: next });
    _resourcePolicyCaches.set(settingsPath, next);
    return next;
  });
  return { ok: true, agentId: normalizedAgentId, maxLiveRuntimes, resourcePolicy: { ...policies } };
}

export function setupWorkspaceSettingsRoutes(app, express) {
  app.get('/protoclaw/workspace_settings', async (_req, res) => {
    res.json({
      workspaceVisibility: await readWorkspaceVisibilityOverrides(),
      resourcePolicy: await readWorkspaceResourcePolicies(),
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
      if (req.body?.maxLiveRuntimes === undefined) {
        return res.status(400).json({ error: 'maxLiveRuntimes is required (positive integer, or null to clear)' });
      }
      const result = await writeWorkspaceResourcePolicy(req.body?.agentId, req.body?.maxLiveRuntimes);
      res.json(result);
    } catch (error) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });
}
