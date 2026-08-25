/**
 * Thread Identity — 线程身份归属解析（T001）
 *
 * WorkThread 的 `identity` 字段是线程承载产品身份的事实来源。
 * 身份本身由 Session 携带（sessionType），本模块是 Claw 侧的
 * 会话身份真相源解析器，注入框架 WorkThread 的 identitySource：
 *
 *   (agentId, sessionId) → sessionType（main / coder / ...），查不到 → null
 *
 * 解析顺序（与 session-access.resolvePrebuiltSessionType 同源语义）：
 *   1. session index（readSessionIndex 已把缺失 sessionType 归一为 'main'）；
 *   2. 会话文件（index 未命中时回退读 session json）。
 *
 * 注意：本模块回答「这个会话在产品上是什么身份」，不回答「这个会话是否
 * 应该建立线程」——后者是 host-agents.isThreadHostSession 的职责，两者
 * 正交，不得互相推导。身份解析失败返回 null（未知），绝不默认成 main。
 */

import { resolvePrebuiltSessionType } from '../shared/session-access.js';

/**
 * 生产 identitySource：从 session index / 会话文件解析会话身份。
 * 会话不存在或无身份事实时返回 null——框架据此判定
 * session_workspace_mismatch / thread_identity_missing，不静默放行。
 *
 * @param {string} agentId
 * @param {string} sessionId
 * @returns {Promise<string | null>}
 */
export async function resolveSessionIdentity(agentId, sessionId) {
  const normalizedAgentId = String(agentId || '').trim();
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedAgentId || !normalizedSessionId) return null;
  const identity = await resolvePrebuiltSessionType(normalizedAgentId, normalizedSessionId).catch(() => '');
  return identity || null;
}
