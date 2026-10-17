/**
 * App Notification Outlet — 面向用户的桌面通知统一投递出口（ADR-0030）
 *
 * 一切通知经此出口：投递请求（带 agentId 身份）→ 权限判定 → SSE
 * app-notification 帧 → 前端呈现器弹 toast。事件源两类，同走一出口：
 * - runtime 状态类（完成 / 输入请求）：sse-events 在既有感知链上调用
 *   observeCallStatusSnapshot（经 server.js 装配为 onCallStatusSnapshot
 *   钩子），判定权限后发布；
 * - 主动投递类（APP 侧发起）：POST /protoclaw/app_notifications 端点，
 *   internal 鉴权照 feature-communication 先例（runtime 子进程经
 *   PROTOCLAW_INTERNAL_TOKEN 持内部服务 token）。
 *
 * 判定链（三层，ADR-0027/0030）：用户覆盖（workspace-settings
 * resourcePolicy，按 agentId 键控）> 作者默认（metadata permissionDefaults）
 * > 兜底 false。不通过静默跳过（deliverAppNotification 返回 false 供调用
 * 方观测，不报错）。
 *
 * 去重拆层：server 做事件级（同一事实只发一帧，键对齐 desktop-notify 既有
 * 完成判定的事实键：finish = agentId + finish 事件时间戳，input = agentId +
 * requestId）；前端做呈现级（既有 dedup 逻辑保留）。在线投递语义：SSE 只投
 * 在线连接（环形缓冲 + Last-Event-ID 重放照既有事件），不落全局通知历史、
 * 不做离线补投（ADR-0030 可达边界）。
 */

import { resolveRequestAuth } from '../auth.js';
import { readWorkspaceResourcePolicies } from './workspace-settings.js';
import { publishAppNotification } from './sse-events.js';

/** 通知 type → 权限项 ID。枚举外的自定义 type 不允许（工单裁决）。 */
export const APP_NOTIFICATION_TYPES = Object.freeze({
  finish: 'notifications.finish',
  reminder: 'notifications.reminder',
  input: 'notifications.input',
});

// 事件级去重表（`${type}:${dedupeKey}`）。容量照 bell seen 集合先例：
// 溢出整体清空——完成事实键带时间戳天然演进，清空至多造成极早期事实重判
// 一次，不值得为此维护 LRU。
const _deliveredFactKeys = new Set();
const DEDUP_MAX_KEYS = 500;

/** 三层判定链（纯函数，可测）：用户覆盖 > 作者默认 > 兜底 false。 */
export function resolveNotificationPermissionValue({ userValue, authorDefault }) {
  if (typeof userValue === 'boolean') return userValue;
  if (typeof authorDefault === 'boolean') return authorDefault;
  return false;
}

/** 读 metadata 作者默认值。requireAgent 缺失或 agent 未知时按空表处理。 */
async function readAuthorDefaults(agentId, requireAgent) {
  if (typeof requireAgent !== 'function') return {};
  try {
    const agent = await requireAgent(agentId);
    const defaults = agent?.permissionDefaults;
    return defaults && typeof defaults === 'object' ? defaults : {};
  } catch {
    return {};
  }
}

/**
 * 判定 agentId 对某通知 type 是否允许投递（判定链全链）。
 * settingsPath 是测试缝（隔离用户数据目录），生产调用不传。
 */
export async function isNotificationAllowed({
  agentId,
  type,
  requireAgent = null,
  settingsPath = undefined,
} = {}) {
  const permissionId = APP_NOTIFICATION_TYPES[type];
  const normalizedAgentId = String(agentId || '').trim();
  if (!permissionId || !normalizedAgentId) return false;
  const [policies, authorDefaults] = await Promise.all([
    readWorkspaceResourcePolicies({ settingsPath }),
    readAuthorDefaults(normalizedAgentId, requireAgent),
  ]);
  return resolveNotificationPermissionValue({
    userValue: policies[normalizedAgentId]?.[permissionId],
    authorDefault: authorDefaults[permissionId],
  });
}

/**
 * 统一投递入口：判定权限 → 通过则发布 app-notification SSE 帧。
 * dedupeKey 提供事件级去重（同一事实只发一帧）；去重标记在判定之前写入
 * （并发防护对齐 desktop-notify 教训：标记晚于 await 则并发调用都能通过
 * 检查），权限拒绝即该事实终局——在线投递语义下不补投。
 * runtimeAgentId：帧的会话粒度定位（SSE 快照原始 agentId，runtime 形态）。
 * agentId 用于权限与身份（prebuilt/workspace 形态）；多会话工作空间（如
 * 编程小助手）下两者不同——前端焦点判定与导航用 runtimeAgentId，丢失
 * 它会把"哪个会话完成"抹平成"哪个工作空间完成"。
 * @returns {Promise<boolean>} 是否实际发布（供调用方观测，不报错）
 */
export async function deliverAppNotification({
  agentId,
  type,
  title = '',
  body = '',
  threadId = null,
  requestId = null,
  finishTs = null,
  dedupeKey = null,
  runtimeAgentId = null,
  requireAgent = null,
  settingsPath = undefined,
} = {}) {
  const normalizedAgentId = String(agentId || '').trim();
  const normalizedRuntimeAgentId = String(runtimeAgentId || '').trim();
  if (!normalizedAgentId || !APP_NOTIFICATION_TYPES[type]) return false;
  if (dedupeKey != null && dedupeKey !== '') {
    const key = `${type}:${dedupeKey}`;
    if (_deliveredFactKeys.has(key)) return false;
    if (_deliveredFactKeys.size >= DEDUP_MAX_KEYS) _deliveredFactKeys.clear();
    _deliveredFactKeys.add(key);
  }
  const allowed = await isNotificationAllowed({ agentId: normalizedAgentId, type, requireAgent, settingsPath });
  if (!allowed) return false;
  publishAppNotification({
    kind: 'app-notification',
    agentId: normalizedAgentId,
    type,
    ...(normalizedRuntimeAgentId ? { runtimeAgentId: normalizedRuntimeAgentId } : {}),
    ...(title ? { title: String(title) } : {}),
    ...(body ? { body: String(body) } : {}),
    ...(threadId ? { threadId: String(threadId) } : {}),
    ...(requestId ? { requestId: String(requestId) } : {}),
    ...(finishTs ? { finishTs } : {}),
  });
  return true;
}

// ── runtime 状态类感知（完成 / 输入请求）────────────────────────────
// 事实键提取照 desktop-notify 现状判定逐字对齐（工单：勿发明新键）。

function normalizeTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1000000000000 ? n * 1000 : n;
}

/** notification 快照的生效侧（event 较新取 event，否则 state）。 */
function notificationAction(notifData) {
  const state = notifData?.state && typeof notifData.state === 'object' ? notifData.state : null;
  const event = notifData?.event && typeof notifData.event === 'object' ? notifData.event : null;
  if (event && (!state || normalizeTs(event.timestamp) >= normalizeTs(state.timestamp))) return event;
  return state;
}

/** 完成事实时间戳：call.finish 事件时间戳优先，runtime settled 的 updatedAt 兜底。 */
export function extractFinishTimestamp(notifData) {
  const action = notificationAction(notifData);
  if (String(action?.type || '').trim() === 'call.finish') {
    const actionTs = normalizeTs(action.timestamp);
    if (actionTs) return actionTs;
  }
  const runtime = notifData?.runtime && typeof notifData.runtime === 'object' ? notifData.runtime : null;
  const settled = runtime && runtime.callActive === false
    && ['completed', 'failed', 'cancelled'].includes(String(runtime.stage || '').trim());
  if (settled) return normalizeTs(runtime.updatedAt);
  return 0;
}

/** 挂起不是完成（ADR-0019）：continued+suspended 任一命中即视为挂起。 */
export function isSuspendedFinish(notifData) {
  const suspended = (data) => !!(data && typeof data === 'object'
    && String(data.status || '').trim() === 'continued'
    && String(data.reason || '').trim() === 'suspended');
  const action = notificationAction(notifData);
  if (String(action?.type || '').trim() === 'call.finish' && suspended(action.data)) return true;
  return suspended(notifData?.runtime?.lastOutcome);
}

/** input-requests 快照中的 choice lease 谓词（与 sse-events bell 过滤同源）。 */
function isChoiceLease(lease) {
  return Boolean(lease && lease.mode === 'choices'
    && Array.isArray(lease.questions) && lease.questions.length > 0
    && typeof lease.requestId === 'string');
}

/**
 * runtime 状态类通知感知：notification 快照 → 完成判定（挂起排除 + finishTs
 * 事实键去重）；input-requests 快照 → choice 请求（requestId 事实键去重）。
 * 判定权限后经统一出口发布。由 server.js 装配进 createSseEventsModule 的
 * onCallStatusSnapshot 钩子；opts 透传 requireAgent / settingsPath /
 * resolveAgentId（SSE 快照的 agentId 为 runtime 形态，权限表按
 * prebuilt/workspace id 键控，判定前归一；未注入或未命中透传原值）。
 * 自捕获错误：感知失败只留痕，绝不打断 SSE 管线。
 */
export async function observeCallStatusSnapshot(kind, agentId, snapshot, opts = {}) {
  try {
    // ID 归一（runtime → prebuilt/workspace）：两分支共用；非 runtime 形态
    // （如测试直传 prebuilt id）反查未命中即透传，行为不变。
    let targetAgentId = String(agentId || '').trim();
    if (targetAgentId && typeof opts.resolveAgentId === 'function') {
      targetAgentId = String(await opts.resolveAgentId(targetAgentId) || '') || targetAgentId;
    }
    if (!targetAgentId) return;
    if (kind === 'notification') {
      const finishTs = extractFinishTimestamp(snapshot);
      if (!finishTs) return; // 非完成态快照（call.start / calling 中）：无完成事实
      if (isSuspendedFinish(snapshot)) return; // 挂起等待唤醒，不是完成
      await deliverAppNotification({
        agentId: targetAgentId,
        runtimeAgentId: agentId, // 会话粒度定位：多会话工作空间下与 agentId 不同
        type: 'finish',
        finishTs,
        dedupeKey: `${targetAgentId}:${finishTs}`,
        ...opts,
      });
      return;
    }
    if (kind === 'input-requests' && Array.isArray(snapshot)) {
      for (const lease of snapshot) {
        if (!isChoiceLease(lease)) continue; // 普通文本输入请求不触发通知
        await deliverAppNotification({
          agentId: targetAgentId,
          runtimeAgentId: agentId,
          type: 'input',
          requestId: lease.requestId,
          dedupeKey: `${targetAgentId}:${lease.requestId}`,
          ...opts,
        });
      }
    }
  } catch (error) {
    console.warn(`[app-notification] observe ${kind}:${agentId} failed:`, error?.message || error);
  }
}

/**
 * APP 主动投递端点。鉴权照 feature-communication 先例：resolveRequestAuth
 * 从请求自行判定（internal bearer），鉴权关闭时中间件不写 req.auth、
 * runtime 调用照常工作；浏览器 session 请求一律 403。
 */
export function setupAppNotificationRoutes(app, express, { requireAgent = null } = {}) {
  app.post('/protoclaw/app_notifications', express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      if (resolveRequestAuth(req)?.kind !== 'internal') {
        return res.status(403).json({ ok: false, code: 'internal_only' });
      }
      const body = req.body || {};
      const agentId = String(body.agentId || '').trim();
      if (!agentId) {
        return res.status(400).json({ ok: false, code: 'invalid_request', error: 'agentId is required' });
      }
      if (!APP_NOTIFICATION_TYPES[body.type]) {
        return res.status(400).json({
          ok: false,
          code: 'invalid_request',
          error: `type must be one of: ${Object.keys(APP_NOTIFICATION_TYPES).join(', ')}`,
        });
      }
      // agentId 必须为已知 prebuilt/workspace agent
      if (typeof requireAgent === 'function') {
        try {
          await requireAgent(agentId);
        } catch {
          return res.status(404).json({ ok: false, code: 'unknown_agent', error: `Unknown agent: ${agentId}` });
        }
      }
      const delivered = await deliverAppNotification({
        agentId,
        type: body.type,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        threadId: body.threadId ?? null,
        requestId: body.requestId ?? null,
        // input 类按 requestId 事件级去重；reminder / finish 主动投递逐条投
        dedupeKey: body.type === 'input' && body.requestId ? `${agentId}:${body.requestId}` : null,
        requireAgent,
      });
      return res.json({ ok: true, delivered });
    } catch (error) {
      next(error);
    }
  });
}
