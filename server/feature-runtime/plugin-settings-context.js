import { buildScopeLayers } from '../routes/feature-config.js';
import { findPrebuiltSessionRecordShared } from '../shared/session-access.js';
import { IDENTITY_SCOPES, readEffectiveMounts } from './install-service.js';
import { catalogRootsWithWorkspaceRepositories, resolveCatalogPackage, scanFeatureCatalog } from './catalog.js';
import { pluginSettingsKey, resolvePluginSettings } from './plugin-settings.js';

export async function validatePluginSettingsWrite({ agentId, layerId, content, changed }, { resolvers, catalogRoots } = {}) {
  const scope = Object.values(IDENTITY_SCOPES).find((item) => item.agentId === agentId);
  if (!scope) fail(404, '工作空间不支持插件装配');
  const { mounts } = readEffectiveMounts(scope, resolvers);
  const catalog = await scanFeatureCatalog(catalogRootsWithWorkspaceRepositories(catalogRoots, [agentId]));
  for (const key of changed) {
    const mount = [...mounts.values()].find((item) => item.package && pluginSettingsKey(item.package) === key);
    const versions = mount && catalog.packages.get(mount.package);
    const archive = versions?.find((entry) => entry.version === mount.version
      && (!entry.scopeAgentId || entry.scopeAgentId === agentId));
    if (layerId === 'global' && archive?.scopeAgentId) fail(400, '私有插件不能写入全局默认设置');
    if (!archive?.pluginSettings) fail(400, `未找到 ${key} 对应的插件设置声明`);
    const values = content[key];
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail(400, `${key} 必须是对象`);
    for (const field of Object.keys(values)) {
      if (!Object.hasOwn(archive.pluginSettings.properties, field)) fail(400, `未知插件设置 ${field}`);
    }
    try { resolvePluginSettings(archive, [content]); } catch (error) { fail(400, error.message); }
  }
}

function fail(statusCode, message) {
  throw Object.assign(new Error(message), { statusCode });
}

/** Request identity comes from the caller; project/dir identity comes from the session index. */
export async function readRequestPluginSettings(packageName, query, {
  resolvers, catalogRoots, catalog, findSession = findPrebuiltSessionRecordShared,
} = {}) {
  const { agentId, sessionId } = query || {};
  if (typeof packageName !== 'string' || !packageName) fail(400, '缺少插件包名');
  if (typeof agentId !== 'string' || !agentId || (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId))) {
    fail(400, '明确的 agentId 和可选的 sessionId 是必需的');
  }
  const scope = Object.values(IDENTITY_SCOPES).find((item) => item.agentId === agentId);
  if (!scope) fail(404, '工作空间不支持插件装配');
  const { mounts } = readEffectiveMounts(scope, resolvers);
  const selected = [...mounts.values()].filter((mount) => mount.kind !== 'builtin' && mount.enabled !== false && mount.package === packageName);
  if (!selected.length) fail(404, '插件未在该工作空间启用');
  if (selected.length !== 1) fail(409, '工作空间存在多条同包装配声明');
  catalog ??= await scanFeatureCatalog(catalogRootsWithWorkspaceRepositories(catalogRoots, [agentId]));
  let archive;
  try {
    archive = resolveCatalogPackage(catalog, { packageName, version: selected[0].version, agentId });
  } catch {
    fail(404, '装配的插件包不在仓库');
  }
  // Compare before reading any values; a global route may currently serve another artifact.
  if (typeof query.digest !== 'string' || query.digest !== archive.archiveDigest) fail(409, '插件实现与当前装配不匹配');
  if (!archive.pluginSettings) fail(404, '插件未声明统一设置');
  const context = { agentId };
  if (sessionId) {
    const record = await findSession(agentId, sessionId);
    if (!record) fail(404, '该工作空间没有此会话');
    if (agentId === 'programming-helper') {
      if (record.projectId) context.projectId = record.projectId;
      else if (record.openDirectory) context.dir = record.openDirectory;
    }
  }
  const { queue } = buildScopeLayers(context, resolvers);
  return resolvePluginSettings(archive, queue);
}
