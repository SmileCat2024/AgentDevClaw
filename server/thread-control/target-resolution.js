/**
 * Target Resolution — 统一目标解析入口（T003）
 *
 * 让开发者尽量使用一致的动作名称，不必先记住「这是 Thread API 还是
 * Session API」。服务端根据目标的 Thread 成员关系解析实际对象：
 *
 *   - 生命周期动作（archive / resume / delete）：目标属于某 Thread 时定位置
 *     所属 Thread 并执行 Thread 语义；不属于任何 Thread 时执行独立 Session
 *     语义。响应以实际生效对象为主体，并保留原请求目标。
 *   - 上下文变换（trim / summary / compact）：只能作用于 Thread 当前 head——
 *        * 当前 head：正常执行；
 *        * Thread 历史 Session：返回明确的 stale_session 过期目标错误，附 Thread
 *          ID 与当前 head，绝不静默把历史 Session 改写成当前 head；
 *        * 非 Thread Session：保持原有 Session 语义。
 *   - 历史 Session 的 activate 只允许浏览 / 挂载视角，不改变 head。
 *
 * 本模块是纯逻辑：成员归属事实由调用方注入的 `memberLookup` 提供（生产
 * 装配绑定 threadLifecycle.findThreadBySession / 框架 WorkThread.findThreadBySession，
 * 测试注入 stub，不依赖真实 Runtime）。所有入口（Web UI / CLI / ACP / HTTP）
 * 消费同一解析结果，消除「部分路由直接按 sessionType 特判」的分叉实现。
 *
 * 统一响应形状：
 *   {
 *     request:   { agentId, sessionId },   // 原请求目标（永远保留）
 *     actual:    { type: 'thread'|'session', id },  // 实际生效对象
 *     membership: 'thread-head'|'thread-historical'|'thread-member'|'standalone',
 *     threadId, headSessionId, threadStatus,   // 命中线程时的归属事实
 *     ok, code, message,                     // 动作结果 / 错误信息
 *   }
 */

function cleanText(value) {
  return String(value || '').trim();
}

/**
 * 纯分类：给定某会话的所属线程记录（memberLookup 命中）与该会话 id，
 * 判定它在产品对象模型中的归属角色。
 *
 * @param {object|null} thread  - 会话所属的线程记录（或 null = 非线程成员）
 * @param {string} sessionId    - 目标会话 id
 * @returns {{type:'session'|'thread', membership:string, threadId:string|null,
 *            headSessionId:string|null, threadStatus:string|null, isHead:boolean}}
 */
export function classifyTarget(thread, sessionId) {
  const normalizedSession = cleanText(sessionId);
  if (!thread || !normalizedSession) {
    return {
      type: 'session',
      membership: 'standalone',
      threadId: null,
      headSessionId: null,
      threadStatus: null,
      isHead: false,
    };
  }
  const threadId = cleanText(thread.threadId);
  const headSessionId = cleanText(thread.headSessionId);
  const isHead = Boolean(headSessionId) && headSessionId === normalizedSession;
  const membership = isHead ? 'thread-head' : 'thread-historical';
  return {
    type: 'thread',
    membership,
    threadId,
    headSessionId: headSessionId || null,
    threadStatus: thread?.status || null,
    isHead,
  };
}

/**
 * 生命周期目标解析：把请求目标解析为实际生效对象。
 *
 * - 属于 Thread（memberLookup 命中）→ actual 为所属 Thread（type:'thread'，
 *   id 为 threadId）。调用方据此执行 Thread 语义。head 与历史成员同样定位置
 *   Thread——归档 / 恢复 / 删除都是对 Thread 这个工作容器的操作，不要求目标是
 *   head（ADR-001 §4/§5）。实际执行细节由调用方决定（本票不改变归档 /
 *   删除执行细节，只在解析层统一归属）。
 * - 不属于任何 Thread → actual 为独立 Session（type:'session'），保持原 Session 语义。
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.sessionId
 * @param {(agentId:string, sessionId:string)=>Promise<object|null>} opts.memberLookup
 * @returns {Promise<object>} 统一目标描述符（见文件头形状）
 */
export async function resolveLifecycleTarget({ agentId, sessionId, memberLookup }) {
  const normalizedAgentId = cleanText(agentId);
  const normalizedSessionId = cleanText(sessionId);
  const base = { request: { agentId: normalizedAgentId, sessionId: normalizedSessionId } };
  if (!normalizedAgentId || !normalizedSessionId) {
    return { ...base, ok: false, code: 'invalid_target', message: 'agentId and sessionId are required' };
  }
  let thread = null;
  try {
    thread = typeof memberLookup === 'function'
      ? await memberLookup(normalizedAgentId, normalizedSessionId)
      : null;
  } catch {
    thread = null;
  }
  const cls = classifyTarget(thread, normalizedSessionId);
  return {
    ...base,
    ok: true,
    actual: { type: cls.type, id: cls.type === 'thread' ? cls.threadId : normalizedSessionId },
    ...cls,
  };
}

/**
 * 上下文变换目标解析：只能作用于 Thread 当前 head。
 *
 * - 目标为 Thread 当前 head → ok，actual 为该 Thread；
 * - 目标为 Thread 历史 Session → ok:false，code:'stale_session'，附 Thread ID
 *   与当前 head，绝不静默改写成 head；
 * - 目标非 Thread 成员 → ok（standalone），保持原 Session 语义。
 *
 * @param {object} opts 同 resolveLifecycleTarget
 * @returns {Promise<object>}
 */
export async function resolveTransformationTarget({ agentId, sessionId, memberLookup }) {
  const normalizedAgentId = cleanText(agentId);
  const normalizedSessionId = cleanText(sessionId);
  const base = { request: { agentId: normalizedAgentId, sessionId: normalizedSessionId } };
  if (!normalizedAgentId || !normalizedSessionId) {
    return { ...base, ok: false, code: 'invalid_target', message: 'agentId and sessionId are required' };
  }
  let thread = null;
  try {
    thread = typeof memberLookup === 'function'
      ? await memberLookup(normalizedAgentId, normalizedSessionId)
      : null;
  } catch {
    thread = null;
  }
  const cls = classifyTarget(thread, normalizedSessionId);
  if (cls.type === 'thread' && !cls.isHead) {
    return {
      ...base,
      ok: false,
      code: 'stale_session',
      message: `Session ${normalizedSessionId} 是 Thread 的历史会话，上下文变换只能作用于当前 head（${cls.headSessionId}）`,
      actual: { type: 'thread', id: cls.threadId },
      ...cls,
    };
  }
  return {
    ...base,
    ok: true,
    actual: { type: cls.type, id: cls.type === 'thread' ? cls.threadId : normalizedSessionId },
    ...cls,
  };
}

/**
 * 浏览 / 挂载视角判定：历史 Session 只允许只读挂载，不得改变 Thread head。
 * 供 activate 等「不应推进 head」的入口消费——返回是否允许变更视角。
 *
 * @param {object} cls  - classifyTarget 的返回
 * @returns {boolean}   - true = 允许浏览 / 挂载视角；false = 目标无效或非历史
 */
export function isBrowseOnlyMount(cls) {
  return Boolean(cls) && cls.type === 'thread' && cls.membership === 'thread-historical';
}
