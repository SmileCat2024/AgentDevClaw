/**
 * Workspace Settings — 用户工作空间集的呈现策略与资源策略
 *
 *   GET  /protoclaw/workspace_settings                    — 读覆盖表（两节）
 *   PUT  /protoclaw/workspace_settings                    — 写呈现策略覆盖（{ agentId, policy }）
 *   PUT  /protoclaw/workspace_settings/resource_policy    — 写权限项用户值（{ agentId, permissionId, value }）
 *   GET/PUT /protoclaw/workspace_settings/sidebar_layout — 应用位置、文件夹排序与折叠状态（sidebarLayout 节）
 *
 * 概念层级：工作空间是用户资产（用户可安装任意工作空间集，甚至不装智能
 * 编码空间），本设置随用户工作空间集走，不属于随 Claw 的系统设置。
 *
 * - workspaceVisibility：呈现策略覆盖（ADR-0025 收尾）。默认策略由工作空间
 *   作者在 metadata.json 声明，本文件只存用户覆盖层（agentId → 'auto' |
 *   'always'），缺省即作者默认。
 * - resourcePolicy：per-workspace 资源策略（ADR-0027）。首个字段
 *   maxLiveThreads 限非终态线程数（修订一）；缺省即不限。
 *
 * 写入约束：两个节同文件共存，任一写路径必须整文件读改写（保留兄弟节），
 * 不得整体重写为自己单节的投影。存储于用户数据根目录 workspace-settings.json，
 * 与 proxy-config 等同构。settingsPath 参数是测试缝（隔离用户数据目录）。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { USER_DATA_ROOT } from '../shared/constants.js';
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
 * 读资源策略表（{ <agentId>: { maxLiveThreads } }，ADR-0027）。损坏/缺省返回空表。
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

export async function writeWorkspaceResourcePolicy(agentId, maxLiveThreads, options = {}) {
  const result = await writeWorkspacePermissionValue(agentId, PERMISSION_ITEMS.maxLiveThreads.id, maxLiveThreads, options);
  return { ...result, maxLiveThreads: maxLiveThreads };
}

const SIDEBAR_FOLDER_IDS = ['prebuilt-group', 'tool-group'];
const RETIRED_SIDEBAR_FOLDER = 'work-group-group';

function validateSidebarLayout(value, readStored = false) {
  const folderIds = readStored && Array.isArray(value?.folders) && value.folders.some(folder => folder?.id === RETIRED_SIDEBAR_FOLDER)
    ? [...SIDEBAR_FOLDER_IDS, RETIRED_SIDEBAR_FOLDER] : SIDEBAR_FOLDER_IDS;
  const invalid = () => { throw Object.assign(new Error('Invalid sidebar layout'), { status: 400 }); };
  if (!value || value.version !== 1 || !Array.isArray(value.order) || !Array.isArray(value.folders)
    || value.order.length > 1000 || value.folders.length !== folderIds.length) invalid();
  const apps = new Set();
  const validApp = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\s]/.test(id) && [...id].every(char => char.charCodeAt(0) >= 32);
  const takeApp = (id) => {
    if (!validApp(id) || apps.has(id)) invalid();
    apps.add(id);
  };
  const roots = new Set();
  for (const item of value.order) {
    if (typeof item !== 'string' || roots.has(item)) invalid();
    roots.add(item);
    if (item.startsWith('app:')) takeApp(item.slice(4));
    else if (!folderIds.some(id => item === `folder:${id}`)) invalid();
  }
  if (!folderIds.every(id => roots.has(`folder:${id}`))) invalid();
  const folders = new Set();
  for (const folder of value.folders) {
    if (!folder || !folderIds.includes(folder.id) || folders.has(folder.id)
      || typeof folder.collapsed !== 'boolean' || !Array.isArray(folder.apps) || folder.apps.length > 1000) invalid();
    folders.add(folder.id);
    for (const id of folder.apps) takeApp(id);
  }
  if (typeof value.externalCollapsed !== 'boolean') invalid();
  return {
    version: 1,
    // Stored layouts may contain user-moved apps in the retired folder: unwrap
    // them in place rather than losing their positions or resetting the layout.
    order: value.order.flatMap(id => id === `folder:${RETIRED_SIDEBAR_FOLDER}`
      ? value.folders.find(folder => folder.id === RETIRED_SIDEBAR_FOLDER).apps.map(app => `app:${app}`) : [id]),
    folders: value.folders.filter(folder => folder.id !== RETIRED_SIDEBAR_FOLDER)
      .map(({ id, apps: ids, collapsed }) => ({ id, apps: [...ids], collapsed })),
    externalCollapsed: value.externalCollapsed,
  };
}

export async function readSidebarLayout({ settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  const data = await readWorkspaceSettingsFile(settingsPath);
  if (data.sidebarLayout === undefined) return null;
  return validateSidebarLayout(data.sidebarLayout, true);
}

export async function writeSidebarLayout(layout, { settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  const next = validateSidebarLayout(layout);
  await withSettingsWriteLock(settingsPath, async () => {
    const current = await readWorkspaceSettingsFile(settingsPath);
    await writeWorkspaceSettingsFile(settingsPath, { ...current, version: 1, sidebarLayout: next });
  });
  return { ok: true, sidebarLayout: next };
}

export function setupWorkspaceSettingsRoutes(app, express, { countLiveThreadsByAgent, settingsPath = DEFAULT_WORKSPACE_SETTINGS_PATH } = {}) {
  app.get('/protoclaw/workspace_settings/sidebar_layout', async (_req, res, next) => {
    try { res.json({ ok: true, sidebarLayout: await readSidebarLayout({ settingsPath }) }); }
    catch (error) { next(error); }
  });
  app.put('/protoclaw/workspace_settings/sidebar_layout', express.json(), async (req, res, next) => {
    try { res.json(await writeSidebarLayout(req.body?.sidebarLayout, { settingsPath })); }
    catch (error) {
      if (error?.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });
  app.get('/protoclaw/workspace_settings', async (_req, res) => {
    res.json({
      workspaceVisibility: await readWorkspaceVisibilityOverrides(),
      resourcePolicy: await readWorkspaceResourcePolicies(),
      // 非终态线程现状投影（ADR-0027 修订一）：设置面板展示「当前 N」与
      // coder_shell 预检共用本端点，配额策略与现状一次读齐。计数闭包由
      // 装配层注入（thread-quota 的 countNonTerminalThreadsByAgent）；
      // 未注入时投影为空表（测试装配）。
      liveThreads: typeof countLiveThreadsByAgent === 'function'
        ? await countLiveThreadsByAgent()
        : {},
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
