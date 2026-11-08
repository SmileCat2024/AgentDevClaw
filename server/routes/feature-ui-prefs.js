/**
 * feature-ui-prefs.js — 呈现配置与面板偏好的服务端持久化（ADR-0046 决策 3）
 *
 * 两份数据同一作用域（工作空间 agentId ×，纯空间级、不分层），落同一文件
 * `workspaces/<agentId>/feature-config/ui-prefs.json`：
 *
 *   {
 *     "presentation": { "<panelId>": { "visible": false, "order": 2 } },   // sparse：缺省 = 默认呈现
 *     "panelPrefs":    { "<panelId>": { "<key>": <json> } }                 // 面板自管 KV，值不解释
 *   }
 *
 * - 呈现配置：右栏面板显隐与排序，宿主声明方（rail 自定义弹窗），整块覆写。
 * - 面板偏好：每页条数一类的高频轻调整，作者声明方（host.panelPrefs），按
 *   panelId 整块覆写，键值语义宿主不解释。
 * - 身份域 = 全部可聚焦工作空间（含无 featureMounts 的 home/memo 等，与
 *   memo-app 等路由同惯例：按需懒建 workspace 目录）；路径安全由
 *   sanitizeSessionFragment 等价校验保证（危险字符 400，不拼进文件路径）。
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { dirname } from 'path';

import { agentLayerPath } from '../shared/feature-config-layers.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';

/** ui-prefs 文件路径：与 agent 层配置同目录（feature-config/），独立文件。 */
export function uiPrefsPath(agentId) {
  return agentLayerPath(agentId).replace(/agent\.json$/, 'ui-prefs.json');
}

/** 读整份 ui-prefs（文件缺失 / 损坏按空处理——偏好数据不阻塞渲染）。 */
export function readUiPrefs(agentId, { root } = {}) {
  const filePath = root ? `${root}/workspaces/${agentId}/feature-config/ui-prefs.json` : uiPrefsPath(agentId);
  if (!existsSync(filePath)) return { presentation: {}, panelPrefs: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      presentation: sanitizePresentation(parsed?.presentation),
      panelPrefs: sanitizePanelPrefs(parsed?.panelPrefs),
    };
  } catch (error) {
    console.warn(`[feature-ui-prefs] 读取 ${agentId} 的 ui-prefs 失败（按空处理）：${error?.message || error}`);
    return { presentation: {}, panelPrefs: {} };
  }
}

/** 整文件写（读改写由调用方组装后传入完整 prefs；小文件无并发压力场景）。 */
function writeUiPrefsFile(agentId, prefs) {
  const filePath = uiPrefsPath(agentId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(prefs, null, 2), 'utf8');
}

/** 呈现配置 sparse 校验：{ panelId: { visible?: boolean, order?: number } }，未知字段剔除。 */
export function sanitizePresentation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [panelId, entry] of Object.entries(raw)) {
    if (typeof panelId !== 'string' || !panelId.trim() || panelId.includes('/')) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = {};
    if (typeof entry.visible === 'boolean') item.visible = entry.visible;
    if (typeof entry.order === 'number' && Number.isFinite(entry.order)) item.order = entry.order;
    if (Object.keys(item).length > 0) clean[panelId] = item;
  }
  return clean;
}

/** 面板偏好校验：{ panelId: { <key>: <json 值> } }，键非空字符串；值原样保留。 */
export function sanitizePanelPrefs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const [panelId, prefs] of Object.entries(raw)) {
    if (typeof panelId !== 'string' || !panelId.trim() || panelId.includes('/')) continue;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) continue;
    const item = {};
    for (const [key, value] of Object.entries(prefs)) {
      if (typeof key !== 'string' || !key.trim() || key.includes('/')) continue;
      item[key] = value;
    }
    if (Object.keys(item).length > 0) clean[panelId] = item;
  }
  return clean;
}

function requireRegisteredAgentId(agentId) {
  // 路径安全校验（sanitize 等价）：非空且消毒后原样保留，才允许拼进文件路径
  if (typeof agentId !== 'string' || !agentId || sanitizeSessionFragment(agentId) !== agentId) {
    const error = new Error(`非法的工作空间身份：${agentId}`);
    error.statusCode = 400;
    throw error;
  }
  return agentId;
}

export function setupFeatureUiPrefsRoutes(app, { readFile, writeFile } = {}) {
  // IO 注入面（测试隔离）；缺省生产实现。readFile(agentId) → prefs 对象，
  // writeFile(agentId, prefs) 持久化。
  const load = readFile || ((agentId) => readUiPrefs(agentId));
  const save = writeFile || ((agentId, prefs) => writeUiPrefsFile(agentId, prefs));

  // 读：GET ?agentId=（呈现配置 + 面板偏好一次取回；渲染初始化单请求）
  app.get('/api/feature-ui/ui-prefs', (req, res, next) => {
    try {
      const agentId = requireRegisteredAgentId(String(req.query.agentId || ''));
      res.json({ ok: true, prefs: load(agentId) });
    } catch (error) {
      next(error);
    }
  });

  // 呈现配置整块覆写（rail 自定义弹窗提交；sparse 形态，未含 panelId = 回默认）
  app.put('/api/feature-ui/ui-prefs', (req, res, next) => {
    try {
      const agentId = requireRegisteredAgentId(req.body?.agentId);
      const presentation = sanitizePresentation(req.body?.presentation);
      const prefs = load(agentId);
      prefs.presentation = presentation;
      save(agentId, prefs);
      res.json({ ok: true, presentation });
    } catch (error) {
      next(error);
    }
  });

  // 面板偏好按 panelId 整块覆写（host.panelPrefs.set 的落点；高频小写）
  app.put('/api/feature-ui/panel-prefs', (req, res, next) => {
    try {
      const agentId = requireRegisteredAgentId(req.body?.agentId);
      const panelId = typeof req.body?.panelId === 'string' ? req.body.panelId.trim() : '';
      if (!panelId || panelId.includes('/')) {
        const error = new Error('panelId 必须是非空且不含路径分隔符的字符串');
        error.statusCode = 400;
        throw error;
      }
      const panelPrefs = sanitizePanelPrefs({ [panelId]: req.body?.prefs })[panelId] || {};
      const prefs = load(agentId);
      if (Object.keys(panelPrefs).length === 0) delete prefs.panelPrefs[panelId];
      else prefs.panelPrefs[panelId] = panelPrefs;
      save(agentId, prefs);
      res.json({ ok: true, panelId, prefs: panelPrefs });
    } catch (error) {
      next(error);
    }
  });
}
