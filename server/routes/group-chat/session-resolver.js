// session-resolver.js — created by Phase 2 extraction
import path from 'path';
import { existsSync, readFileSync } from 'fs';

import { GROUP_CHATS_ROOT } from '../../shared/constants.js';
import { sanitizeSessionFragment, log } from '../../shared/string-helpers.js';
import { readSessionIndex } from '../../shared/session-access.js';
import { resolveSessionModelInfo } from '../model-config.js';
import { getSessionContextUsage } from './format-helpers.js';

const ADMIN_DEFAULT_TOKEN_LIMIT = 200000;
const ADMIN_DEFAULT_RATIO_LIMIT = 20;
const ADMIN_DEFAULT_CONTEXT_LENGTH = 200000;

export function createSessionResolverModule(deps) {
  const {
    readGroupChat,
    writeGroupChat,
    collectIdentities,
    requireAgentLight,
    createPrebuiltSession,
    stopManagedAgent,
    startManagedAgent,
    waitForManagedRuntimeReady,
    getAgentRuntime,
    managedAgents,
  } = deps;

  const _gcAdminLocks = new Map();

  function withAdminSessionLock(chatId, fn) {
    const key = `${chatId}:admin`;
    const prev = _gcAdminLocks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    _gcAdminLocks.set(key, next.catch(e => console.warn(e)));
    return next;
  }
  
  /**
   * 在覆盖 chat.sessions[identityRef] 之前，将旧 session ID 记录到 adminSessionHistory。
   * 仅对管理员生效，用于追踪滚动/重启产生的历史 session。
   */
  function _recordAdminSessionHistory(chat, identityRef) {
    if (identityRef !== 'work-group:admin') return;
    const oldSid = chat.sessions?.[identityRef];
    if (!oldSid) return;
    if (!Array.isArray(chat.adminSessionHistory)) chat.adminSessionHistory = [];
    if (!chat.adminSessionHistory.includes(oldSid)) {
      chat.adminSessionHistory.push(oldSid);
    }
  }
  
  /**
   * 为群聊中的某个 identity 解析或创建 session。
   * - persistent: 首次创建，后续复用
   * - one-shot: 总是创建新的
   * 返回 { sessionId, isNew }
   *
   * 管理员（work-group:admin）的解析会自动加互斥锁，
   * 保证同一群聊同一时刻只有一个 admin session 被创建/解析。
   */
  async function resolveGroupChatSession(chatId, identityRef, sessionModel, options = {}) {
    // 管理员：通过互斥锁串行化，防止并发创建多个 session
    if (identityRef === 'work-group:admin') {
      return withAdminSessionLock(chatId, () => _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options));
    }
    return _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options);
  }
  
  async function _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options = {}) {
    const chat = await readGroupChat(chatId);
    if (!chat) throw new Error(`Group chat not found: ${chatId}`);
  
    const workspaceId = identityRef.split(':')[0];
  
    // 查找身份显示名
    const allIdentities = await collectIdentities();
    const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
    const displayName = identityInfo?.displayName || identityRef.split(':')[1] || 'Agent';
    // 管理员会话使用「群聊名 · 管理员」格式；其他身份由 dispatch title 或 createPrebuiltSession 默认规则决定
    const isAdmin = identityRef === 'work-group:admin';
    const adminSessionTitle = isAdmin ? `${chat.name || '群聊'} · ${displayName}` : null;
    const explicitTitle = (typeof options.title === 'string' && options.title.trim()) || null;
  
    // 新会话的项目目录：优先使用 dispatch 指定的目录，其次用群聊绑定的 workDir
    const sessionOpenDir =
      (typeof options.openDirectory === 'string' && options.openDirectory.trim())
      || chat.workDir
      || undefined;

    // 指定会话：管理员或用户通过 targetSessionId 精准路由
    if (options.targetSessionId) {
      const index = await readSessionIndex(workspaceId);
      const found = index.sessions.find((s) => s.id === options.targetSessionId);
      if (found) {
        // 更新群聊会话映射，使后续默认派发也走这个会话
        _recordAdminSessionHistory(chat, identityRef);
        chat.sessions[identityRef] = found.id;
        await writeGroupChat(chat);
        return { sessionId: found.id, isNew: false };
      }
      // 指定的 targetSessionId 不存在 → 明确报错，不静默降级
      throw new Error(`指定的会话 ${options.targetSessionId} 不存在，请用 gc_sessions 确认可用会话`);
    }
  
    // 强制新会话（resolveOnly 模式下不创建）
    if (options.forceNew) {
      if (options.resolveOnly) return null;
      const agent = await requireAgentLight(workspaceId);
      const taskTitle = explicitTitle || adminSessionTitle;
      const session = await createPrebuiltSession(agent.id, {
        ...(sessionOpenDir ? { openDirectory: sessionOpenDir } : {}),
        ...(taskTitle ? { taskTitle } : {}),
      });
      _recordAdminSessionHistory(chat, identityRef);
      chat.sessions[identityRef] = session.id;
      await writeGroupChat(chat);
      return { sessionId: session.id, isNew: true };
    }
  
    // persistent: 检查映射
    if (!chat.sessions) chat.sessions = {};
    const existing = chat.sessions[identityRef];
    if (existing) {
      // 验证 session 是否仍存在于 index 中
      const index = await readSessionIndex(workspaceId);
      const found = index.sessions.find((s) => s.id === existing);
      if (found) {
        // 管理员：检查上下文是否超限，超限则滚动到新 session
        if (identityRef === 'work-group:admin') {
          const mem = chat.adminMemory || { limitMode: 'tokens', tokenLimit: ADMIN_DEFAULT_TOKEN_LIMIT, ratioLimit: ADMIN_DEFAULT_RATIO_LIMIT };
          const { contextTokens, available } = await getSessionContextUsage(workspaceId, existing);
          if (available) {
            let exceeded = false;
            if (mem.limitMode === 'ratio') {
              // 按比例：contextTokens / contextLength > ratioLimit%
              const ratioVal = mem.ratioLimit ?? mem.limitValue ?? ADMIN_DEFAULT_RATIO_LIMIT;
              const modelInfo = await resolveSessionModelInfo(workspaceId, 'default');
              const contextLength = modelInfo?.contextLength || ADMIN_DEFAULT_CONTEXT_LENGTH;
              exceeded = contextTokens / contextLength > ratioVal / 100;
            } else {
              // 按 token 数
              const tokenVal = mem.tokenLimit ?? mem.limitValue ?? ADMIN_DEFAULT_TOKEN_LIMIT;
              exceeded = contextTokens >= tokenVal;
            }
            if (!exceeded) {
              return { sessionId: existing, isNew: false };
            }
            // 超限 → 先停止旧 runtime，再 fall through 创建新 session
            log('GroupChat', `admin session ${existing} context exceeded (${contextTokens} tokens), rolling to new session`);
            try {
              await stopManagedAgent(workspaceId, existing);
              log('GroupChat', `stopped old admin runtime ${existing} before rolling`);
            } catch (err) {
              log('GroupChat', `failed to stop old admin runtime ${existing}: ${err.message}`, 'warn');
            }
          } else {
            // 无用量数据（首次/刚创建）
            // 检查是否为 admin_restart 创建的待初始化 session
            if (chat.adminNeedsContextInit === existing) {
              chat.adminNeedsContextInit = null;
              await writeGroupChat(chat);
              log('GroupChat', `admin session ${existing} marked for context init, returning isNew=true`);
              return { sessionId: existing, isNew: true };
            }
            return { sessionId: existing, isNew: false };
          }
        } else {
          return { sessionId: existing, isNew: false };
        }
      }
      // session 不存在了（可能被删除），重建
    }
  
    // 创建新 session 并存储映射（resolveOnly 模式下不创建）
    if (options.resolveOnly) return null;
    const agent = await requireAgentLight(workspaceId);
    const taskTitle = explicitTitle || adminSessionTitle;
    const session = await createPrebuiltSession(agent.id, {
      ...(sessionOpenDir ? { openDirectory: sessionOpenDir } : {}),
      ...(taskTitle ? { taskTitle } : {}),
    });
    _recordAdminSessionHistory(chat, identityRef);
    chat.sessions[identityRef] = session.id;
    await writeGroupChat(chat);
    return { sessionId: session.id, isNew: true };
  }
  
  function resolveGroupChatSessionSync(chatId, identityRef) {
    try {
      const chat = readGroupChatSync(chatId);
      if (chat?.sessions?.[identityRef]) {
        return chat.sessions[identityRef];
      }
    } catch {}
  
    // 从 runtime 中查找
    const workspaceId = identityRef.split(':')[0];
    for (const [runtimeKey, runtime] of managedAgents.entries()) {
      if (runtimeKey.startsWith(`${workspaceId}::`) && runtime.process?.exitCode === null) {
        return runtimeKey.split('::')[1];
      }
    }
    return null;
  }
  
  /**
   * 同步读取群聊配置（用于快速查找）。
   */
  function readGroupChatSync(chatId) {
    const chatPath = path.join(GROUP_CHATS_ROOT, `${sanitizeSessionFragment(chatId)}.json`);
    if (!existsSync(chatPath)) return null;
    try {
      return JSON.parse(readFileSync(chatPath, 'utf8'));
    } catch {
      return null;
    }
  }
  
  async function ensureAdminRuntime(chatId, sessionId) {
    let runtime = getAgentRuntime('work-group', sessionId);
    if (runtime?.process && runtime.process.exitCode === null && !runtime.stopped) {
      // Verify the runtime was started with the correct PROTOCLAW_GC_CHAT_ID.
      // The admin can be started through UI paths (start_agent, activate) that
      // don't set the env var; in that case all GroupAdminFeature API calls
      // would hit /group_chats//messages → 404.
      if (runtime.gcChatId === chatId) {
        return runtime;
      }
      log('GroupChat', `admin runtime chatId mismatch: expected=${chatId}, actual=${runtime.gcChatId || '(none)'}, restarting`);
      await stopManagedAgent('work-group', sessionId);
      // Fall through to restart with correct env
    }
  
    const agent = await requireAgentLight('work-group');
    log('GroupChat', `starting work-group admin session=${sessionId} for chat=${chatId}`);
    await startManagedAgent(agent, sessionId, {
      extraEnv: { PROTOCLAW_GC_CHAT_ID: chatId },
    });
    runtime = await waitForManagedRuntimeReady('work-group', 30000, sessionId);
    if (!runtime) throw new Error('Admin runtime failed to become ready within 30s');
    return runtime;
  }

  return {
    withAdminSessionLock,
    resolveGroupChatSession,
    _resolveGroupChatSessionInner,
    resolveGroupChatSessionSync,
    readGroupChatSync,
    ensureAdminRuntime,
  };
}
