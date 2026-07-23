import path from 'path';
import { existsSync, readFileSync, promises as fs } from 'fs';

import { GROUP_CHATS_ROOT, VIEWER_ORIGIN, AGENTS_ROOT, LONG_POLL_DEFAULT_SEC, LONG_POLL_MAX_SEC, GROUP_CHAT_CALL_TIMEOUT_MS } from '../shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText, log } from '../shared/string-helpers.js';
import { managedAgents, getManagedRuntimeKey, listAgentRuntimes, getAgentRuntime } from '../shared/agent-access.js';
import { readSessionIndex, readSessionIndexSync, getPrebuiltSessionFilePath } from '../shared/session-access.js';
import { resolveSessionModelInfo } from './model-config.js';
import { getRuntimeExecutionState } from '../runtime-call-envelope.js';

// ── Extracted modules (Phase 1) ───────────────────────────────────
export {
  normalizeGroupChatMembers,
  composeDispatchPrompt,
  aggregateSessionPool,
  groupByLineage,
  deriveThreadWorkStatus,
  buildThreadTaskSummary,
  buildSessionContextUsage,
  buildSessionLatestMessage,
} from './group-chat/pure-functions.js';

export { createGroupChatDataLayer, getGroupChatsForSidebar } from './group-chat/data-layer.js';

import {
  RESOURCE_ALLOWED_EXTS,
  GC_MSG_TRUNCATE_THRESHOLD,
  getResourcesDir,
  validateResourceName,
  parseMemoryRange,
  getSessionContextUsage,
  formatDispatchTarget,
  formatSessionLabel,
  formatSessionLifecycleEvent,
  composeGroupMemory,
  formatGroupInfoBlock,
  formatMemoryRange,
  formatGroupMemoryPrompt,
  truncateMessageText,
  formatCatchUpPrompt,
  processAttachmentsForInjection,
  buildGroupDispatchSystemMessage,
} from './group-chat/format-helpers.js';

// ── 管理员上下文阈值默认值 ──────────────────────────────────────
const ADMIN_DEFAULT_TOKEN_LIMIT = 200000;   // 按 token 讗数的上下文阈值
const ADMIN_DEFAULT_RATIO_LIMIT = 20;       // 按比例计数的阈值（百分比）
const ADMIN_DEFAULT_CONTEXT_LENGTH = 200000; // contextLength 回退值（模型未提供时）

export function setupGroupChatRoutes(app, express, ctx) {
  const {
    collectIdentities,
    requireAgentLight,
    createPrebuiltSession,
    waitForManagedRuntimeReady,
    startManagedAgent,
    stopManagedAgent,
    discoverAgents,
    readViewerJson,
    onAgentExit,
  } = ctx;

// ── Group Chat Data Layer ──────────────────────────────────────────

/**
 * 群聊文件存储。每个群聊一个 JSON 文件，消息 append-only（routing 字段除外可更新）。
 * 文件路径：~/.agentdev/AgentDevClaw/group-chats/<chatId>.json
 *
 * 核心数据操作委托给模块级 createGroupChatDataLayer 工厂。
 * 通过 onWrite hook 在每次文件写入后唤醒前端 long-poll waiter。
 */

// chatId → Set<resolve callback>，用于前端 long-poll 的更新通知
const _gcUpdateWaiters = new Map();

function notifyGroupChatUpdate(chatId) {
  const waiters = _gcUpdateWaiters.get(chatId);
  if (waiters && waiters.size > 0) {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }
}

const _dataLayer = createGroupChatDataLayer(GROUP_CHATS_ROOT, {
  onWrite: (chatId) => notifyGroupChatUpdate(chatId),
});
const {
  ensureGroupChatsDir: _ensureGroupChatsDir,
  getGroupChatPath,
  readGroupChat,
  writeGroupChat,
  listGroupChats,
  appendGroupChatMessage,
  updateMessageRouting,
  updateMessageFields,
} = _dataLayer;

async function ensureGroupChatsDir() {
  await _ensureGroupChatsDir();
}

async function deleteGroupChatFile(chatId) {
  let deleted = await _dataLayer.deleteGroupChatFile(chatId);
  // 清理 annotations 文件
  try {
    await fs.unlink(_annotationsFilePath(chatId));
  } catch {}
  // 清理数据目录（GROUP.md 等）
  try {
    await fs.rm(getGroupChatDataDir(chatId), { recursive: true, force: true });
  } catch {}
  return deleted;
}


/**
 * Per-chat 互斥锁：串行化管理员 session 解析。
 * 防止并发调用（@admin + plan 模式通知 + activity 通知）同时创建多个 admin session。
 * key = `${chatId}:admin`, value = Promise chain
 */
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

  // one-shot: 总是创建新 session（resolveOnly 模式下不创建）
  if (sessionModel === 'one-shot') {
    if (options.resolveOnly) return null;
    const agent = await requireAgentLight(workspaceId);
    const taskTitle = explicitTitle || adminSessionTitle;
    const session = await createPrebuiltSession(agent.id, {
      sessionType: 'exploration',
      ...(sessionOpenDir ? { openDirectory: sessionOpenDir } : {}),
      ...(taskTitle ? { taskTitle } : {}),
    });
    return { sessionId: session.id, isNew: true };
  }

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


// ── Group Chat Bridge: inbox + writeback ───────────────────────────

const gcInboxQueue = new Map();       // runtimeKey → message[]
const gcInboxPendingPolls = new Map(); // runtimeKey → callback

/**
 * 向 gc inbox 投递一条消息，唤醒等待的 long-poll。
 */
function enqueueGcInbox(runtimeKey, msg) {
  // If a long-poll is waiting, deliver directly via callback WITHOUT
  // also pushing to the queue.  Pushing to the queue AND delivering via
  // callback causes the same message to be returned again on the next
  // poll (double-delivery bug).
  const cb = gcInboxPendingPolls.get(runtimeKey);
  if (cb) {
    gcInboxPendingPolls.delete(runtimeKey);
    cb(msg);
    return;
  }
  if (!gcInboxQueue.has(runtimeKey)) gcInboxQueue.set(runtimeKey, []);
  gcInboxQueue.get(runtimeKey).push(msg);
}

app.get('/protoclaw/gc/inbox', async (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const timeoutMs = Math.min(Number(req.query.timeout) || LONG_POLL_DEFAULT_SEC, LONG_POLL_MAX_SEC) * 1000;
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);

  const queue = gcInboxQueue.get(runtimeKey);
  if (queue && queue.length > 0) {
    return res.json(queue.shift());
  }

  const timer = setTimeout(() => {
    gcInboxPendingPolls.delete(runtimeKey);
    res.status(204).end();
  }, timeoutMs);

  gcInboxPendingPolls.set(runtimeKey, (msg) => {
    clearTimeout(timer);
    gcInboxPendingPolls.delete(runtimeKey);
    res.json(msg);
  });
});

app.post('/protoclaw/gc/writeback', express.json(), async (req, res, next) => {
  try {
    const { chatId, identityRef, response, error, sessionId: reqSessionId } = req.body || {};
    if (!chatId || !identityRef) {
      return res.status(400).json({ error: 'chatId and identityRef required' });
    }

    const text = error
      ? `执行出错: ${error}`
      : (response || '(无回复)');

    // 回写消息携带 session 信息，供前端显示会话标签和跳转
    // sessionId 从请求体获取（由 agent 子进程通过 bridge 传入）
    const workspaceId = identityRef.split(':')[0];
    const wbSessionId = reqSessionId || null;
    let wbSessionTitle = wbSessionId;
    if (wbSessionId) {
      try {
        const idx = await readSessionIndex(workspaceId);
        const rec = idx.sessions.find((s) => s.id === wbSessionId);
        if (rec) wbSessionTitle = rec.title || rec.taskTitle || wbSessionId;
      } catch {}
    }

    await appendGroupChatMessage(chatId, {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      from: identityRef,
      text,
      mentions: [],
      links: [],
      kind: error ? 'text' : 'text',
      timestamp: Date.now(),
      routing: wbSessionId ? {
        status: 'completed',
        targetSessionId: wbSessionId,
        targetSessionTitle: wbSessionTitle,
        targetWorkspaceId: workspaceId,
        targetIdentityRef: identityRef,
        completedAt: Date.now(),
      } : null,
    });
    log('GroupChat', `writeback from ${identityRef} to chat ${chatId}`);

    // 规划模式下，通知管理员 agent 完成了回复
    const wbChat = await readGroupChat(chatId);
    if (wbChat && (wbChat.initiativeMode || 'assist') === 'plan' && identityRef !== 'work-group:admin') {
      const wbMessage = {
        id: `wb-${Date.now()}`,
        from: identityRef,
        text,
        kind: 'text',
        timestamp: Date.now(),
        // 携带 session 信息，使管理员通知能区分同一身份的不同会话
        routing: wbSessionId ? { targetSessionTitle: wbSessionTitle, targetSessionId: wbSessionId } : null,
      };
      notifyAdminForActivity(chatId, wbMessage, wbChat).catch((err) => {
        log('GroupChat', `admin activity notify (writeback) failed: ${err.message}`, 'warn');
      });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/**
 * 群聊控制 API：中断/暂停/恢复指定 identity 的会话。
 *
 * 流程：
 * 1. 根据 chatId + identityRef 找到对应的 runtime
 * 2. 获取 viewerAgentId
 * 3. 调用 ViewerWorker 的 interrupt API
 * 4. 通过 gc/writeback 写入状态消息到群聊
 */
app.post('/protoclaw/gc/control', express.json(), async (req, res, next) => {
  try {
    const { chatId, identityRef, sessionId, action } = req.body || {};
    if (!chatId || !identityRef || !action) {
      return res.status(400).json({ error: 'chatId, identityRef, and action required' });
    }

    if (!['interrupt'].includes(action)) {
      return res.status(400).json({ error: 'action must be interrupt' });
    }

    const workspaceId = identityRef.split(':')[0];
    // 优先使用传入的 sessionId，否则回退到从群聊配置查找
    const resolvedSessionId = sessionId || resolveGroupChatSessionSync(chatId, identityRef);

    if (!resolvedSessionId) {
      return res.status(404).json({ error: 'No active session found for this identity' });
    }

    const runtime = getAgentRuntime(workspaceId, resolvedSessionId);
    if (!runtime) {
      return res.status(404).json({ error: 'Runtime not found' });
    }

    const viewerAgentId = runtime.viewerAgentId;
    if (!viewerAgentId) {
      return res.status(404).json({ error: 'Runtime has no viewerAgentId' });
    }

    // 调用 ViewerWorker 的 interrupt API
    const interruptRes = await fetch(`${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!interruptRes.ok) {
      const errText = await interruptRes.text().catch(() => 'unknown error');
      return res.status(502).json({ error: `Interrupt failed: ${errText}` });
    }

    log('GroupChat', `control action=${action} for ${identityRef} in chat ${chatId}`);
    res.json({ ok: true, action, viewerAgentId });

    // 异步写入中断事件到群聊（不阻塞响应）
    (async () => {
      try {
        const allIdentities = await collectIdentities();
        const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
        const identityName = identityInfo?.displayName || workspaceId;

        // 读取 session 标题
        const sessionIndex = await readSessionIndex(workspaceId).catch(() => null);
        const sessionRecord = sessionIndex?.sessions?.find((s) => s.id === resolvedSessionId);
        const sessionTitle = sessionRecord?.title || null;

        const eventMessage = {
          id: `evt-interrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chatId,
          from: identityRef,
          text: '',
          kind: 'event',
          event: {
            type: 'session_interrupted',
            identityRef,
            identityName,
            sessionId: resolvedSessionId,
            sessionTitle,
            workspaceId,
          },
          mentions: [],
          links: [],
          timestamp: Date.now(),
          routing: null,
        };

        const chat = await appendGroupChatMessage(chatId, eventMessage);
        log('GroupChat', `event card appended: session_interrupted for ${identityRef} in ${chatId}`);

        // plan 模式下通知管理员
        if (chat && (chat.initiativeMode || 'assist') === 'plan') {
          await notifyAdminForActivity(chatId, eventMessage, chat);
        }
      } catch (e) {
        log('GroupChat', `post-interrupt event failed: ${e.message}`, 'error');
      }
    })();
  } catch (error) {
    next(error);
  }
});

/**
 * 审批通过：将 dispatch_pending 转为正式派发并执行。
 *
 * 流程：
 * 1. 读取待审批消息，验证状态
 * 2. 更新消息 kind → 'dispatch'，approval.status → 'approved'
 * 3. 从 mentions 提取 sessionOptions
 * 4. 调用 dispatchGroupChatMessage 执行派发
 * 5. 规划模式下通知管理员审批结果
 */
app.post('/protoclaw/gc/dispatch/approve', express.json(), async (req, res, next) => {
  try {
    const { chatId, messageId } = req.body || {};
    if (!chatId || !messageId) {
      return res.status(400).json({ error: 'chatId and messageId required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const pendingMsg = (chat.messages || []).find((m) => m.id === messageId);
    if (!pendingMsg) return res.status(404).json({ error: 'Message not found' });
    if (pendingMsg.kind !== 'dispatch_pending') {
      return res.status(400).json({ error: 'Message is not a pending dispatch' });
    }
    if (pendingMsg.approval?.status !== 'pending') {
      return res.status(400).json({ error: `Dispatch already ${pendingMsg.approval?.status || 'resolved'}` });
    }

    // 标记为已批准
    pendingMsg.approval.status = 'approved';
    pendingMsg.approval.approvedAt = Date.now();
    pendingMsg.kind = 'dispatch';
    await writeGroupChat(chat);
    log('GroupChat', `dispatch ${messageId} approved by user`);

    // 提取 sessionOptions
    const firstMention = pendingMsg.mentions?.[0] || {};
    let sessionOptions = {};
    if (firstMention.targetSessionId) sessionOptions.targetSessionId = firstMention.targetSessionId;
    if (firstMention.forceNew) sessionOptions.forceNew = true;
    if (firstMention.title && typeof firstMention.title === 'string' && firstMention.title.trim()) {
      sessionOptions.title = firstMention.title.trim();
    }

    // 执行派发（异步，不阻塞响应）
    dispatchGroupChatMessage(chatId, pendingMsg, sessionOptions).then(async (dispatchResult) => {
      // 规划模式下通知管理员：审批通过 + 派发结果
      if ((chat.initiativeMode || 'assist') === 'plan') {
        try {
          const allIdentities = await collectIdentities();
          const targetRef = pendingMsg.routing?.targetIdentityRef;
          const targetInfo = allIdentities.find((i) => i.identityRef === targetRef);
          const targetName = targetInfo?.displayName || targetRef;

          let systemNote;
          if (dispatchResult) {
            const action = dispatchResult.isNew
              ? `已建立新工作「${dispatchResult.sessionTitle}」`
              : `指令已进入已有工作「${dispatchResult.sessionTitle}」`;
            systemNote = [
              '─── 审批通过 · 派发已执行 ───',
              `目标：${targetName}（${targetRef}）`,
              `操作：${action}`,
              `原派发消息 ID: ${messageId}`,
            ].join('\n');
          } else {
            systemNote = [
              '─── 审批通过 · 派发可能失败 ───',
              `目标：${targetName}（${targetRef}）`,
              `原派发消息 ID: ${messageId}`,
              '状态：会话启动可能失败，请关注。',
            ].join('\n');
          }

          // 构造一个虚拟消息用于通知（不写入群聊消息列表）
          const notifyMsg = {
            id: `approve-${messageId}`,
            from: 'user',
            text: '',
            kind: 'event',
            timestamp: Date.now(),
            routing: null,
          };
          await notifyAdminWithPrompt(chatId, notifyMsg, chat, `用户批准了 ${targetName} 的派发请求`, systemNote);
          log('GroupChat', `admin notified of approved dispatch ${messageId}`);
        } catch (err) {
          log('GroupChat', `post-approve admin notify failed: ${err.message}`, 'warn');
        }
      }
    }).catch((err) => {
      console.error(`[GroupChat] approved dispatch failed for ${messageId}:`, err);
    });

    res.json({ ok: true, messageId, status: 'approved' });
  } catch (error) {
    next(error);
  }
});

/**
 * 同步解析群聊 session（无 async）。
 * 用于 gc/control 等需要快速查找的场景。
 */
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

function getUsageContextTokens(tokenUsage) {
  const lastReq = tokenUsage?.lastRequestUsage || null;
  if (Number.isFinite(lastReq?.inputTokens) && lastReq.inputTokens > 0) return lastReq.inputTokens;
  if (Number.isFinite(lastReq?.totalTokens) && lastReq.totalTokens > 0) return lastReq.totalTokens;
  if (Number.isFinite(tokenUsage?.totalTokens) && tokenUsage.totalTokens > 0) return tokenUsage.totalTokens;
  return null;
}

async function getRuntimeExecSnapshot(agentId, sessionId) {
  const runtime = getAgentRuntime(agentId, sessionId);
  const alive = !!(runtime?.process && runtime.process.exitCode === null && !runtime.stopped);
  if (!alive) {
    return {
      status: 'offline',
      viewerAgentId: null,
      queueLength: 0,
      lastActiveAt: null,
      workdir: null,
    };
  }

  let callActive = false;
  if (runtime.viewerAgentId) {
    try {
      const notif = await readViewerJson(`/api/agents/${encodeURIComponent(runtime.viewerAgentId)}/notification`);
      callActive = notif?.callActive === true;
    } catch {}
  }

  const rtKey = getManagedRuntimeKey(agentId, sessionId);
  const execState = getRuntimeExecutionState(rtKey);
  return {
    status: callActive ? 'running' : (execState.queueLength > 0 ? 'queued' : 'idle'),
    viewerAgentId: runtime.viewerAgentId || null,
    queueLength: execState.queueLength || 0,
    lastActiveAt: execState.lastActiveAt || null,
    workdir: runtime.workspaceDir || null,
  };
}

async function buildGroupChatAwareness(chatId) {
  const chat = await readGroupChat(chatId);
  if (!chat) return null;

  const allIdentities = await collectIdentities();
  const identityInfoByRef = new Map(allIdentities.map((i) => [i.identityRef, i]));
  const identityRefs = new Set();

  const isAdminIdentity = (identityRef) => identityRef === 'work-group:admin';

  for (const member of (chat.members || [])) {
    if (!member?.identityRef || member.identityRef === 'user' || isAdminIdentity(member.identityRef)) continue;
    identityRefs.add(member.identityRef);
  }
  for (const ref of Object.keys(chat.sessions || {})) {
    if (ref && ref !== 'user' && !isAdminIdentity(ref)) identityRefs.add(ref);
  }
  for (const msg of (chat.messages || [])) {
    const ref = msg?.routing?.targetIdentityRef;
    if (ref && ref !== 'user' && !isAdminIdentity(ref)) identityRefs.add(ref);
  }
  for (const imp of (chat.importedSessions || [])) {
    if (!imp?.workspaceId) continue;
    const memberIdentity = (chat.members || [])
      .find((m) => m.identityRef && m.identityRef.startsWith(`${imp.workspaceId}:`));
    const identityRef = memberIdentity?.identityRef || `${imp.workspaceId}:main`;
    if (!isAdminIdentity(identityRef)) identityRefs.add(identityRef);
  }

  const latestRoutingBySession = new Map();
  for (const msg of (chat.messages || [])) {
    const r = msg?.routing;
    if (!r?.targetIdentityRef || !r?.targetSessionId) continue;
    const key = `${r.targetIdentityRef}:${r.targetSessionId}`;
    const existing = latestRoutingBySession.get(key);
    if (!existing || (msg.timestamp || 0) >= (existing.messageTimestamp || 0)) {
      latestRoutingBySession.set(key, {
        status: r.status || null,
        error: r.error || null,
        messageId: msg.id || null,
        messageTimestamp: msg.timestamp || null,
        dispatchedAt: r.dispatchedAt || null,
        completedAt: r.completedAt || null,
      });
    }
  }

  const identities = [];
  const totals = {
    identities: 0,
    sessions: 0,
    running: 0,
    queued: 0,
    idle: 0,
    offline: 0,
    thresholdReached: 0,
    pendingRoutes: 0,
    deliveredRoutes: 0,
  };

  for (const identityRef of Array.from(identityRefs).sort()) {
    const workspaceId = identityRef.split(':')[0];
    const info = identityInfoByRef.get(identityRef) || null;
    const sessionIds = new Set();

    const activeSessionId = chat.sessions?.[identityRef] || null;
    if (activeSessionId) sessionIds.add(activeSessionId);
    for (const msg of (chat.messages || [])) {
      const r = msg?.routing;
      if (r?.targetIdentityRef === identityRef && r.targetSessionId) sessionIds.add(r.targetSessionId);
    }
    for (const imp of (chat.importedSessions || [])) {
      if (imp?.workspaceId === workspaceId && imp.sessionId) sessionIds.add(imp.sessionId);
    }

    let index = { sessions: [] };
    try {
      index = readSessionIndexSync(workspaceId);
    } catch {}
    const metaMap = new Map((index.sessions || []).map((s) => [s.id, s]));

    const sessions = [];
    for (const sid of Array.from(sessionIds)) {
      const meta = metaMap.get(sid) || {};
      const sessionType = cleanSessionText(meta.sessionType) || 'main';
      const modelInfo = await resolveSessionModelInfo(workspaceId, sessionType);
      const tokenUsage = meta.tokenUsage || null;
      const contextTokens = getUsageContextTokens(tokenUsage);
      const contextLength = Number.isFinite(meta.contextLength) && meta.contextLength > 0
        ? meta.contextLength : (Number.isFinite(modelInfo.contextLength) && modelInfo.contextLength > 0
        ? modelInfo.contextLength : null);
      const compressRatio = Number.isFinite(meta.compressRatio) && meta.compressRatio > 0
        ? meta.compressRatio : (Number.isFinite(modelInfo.compressRatio) && modelInfo.compressRatio > 0
        ? modelInfo.compressRatio : 80);
      const contextUsagePct = (contextTokens && contextLength)
        ? Math.round(contextTokens / contextLength * 100)
        : null;
      const runtime = await getRuntimeExecSnapshot(workspaceId, sid);
      const routing = latestRoutingBySession.get(`${identityRef}:${sid}`) || null;
      const status = runtime.status;
      if (status === 'running') totals.running++;
      else if (status === 'queued') totals.queued++;
      else if (status === 'idle') totals.idle++;
      else totals.offline++;
      if (contextUsagePct != null && contextUsagePct >= compressRatio) totals.thresholdReached++;
      if (routing?.status === 'pending') totals.pendingRoutes++;
      if (routing?.status === 'delivered') totals.deliveredRoutes++;

      sessions.push({
        sessionId: sid,
        title: meta.title || meta.taskTitle || sid,
        isActive: sid === activeSessionId,
        sessionType,
        createdAt: meta.createdAt || null,
        updatedAt: meta.updatedAt || meta.createdAt || null,
        savedAt: typeof meta.savedAt === 'number' ? meta.savedAt : null,
        messageCount: typeof meta.messageCount === 'number' ? meta.messageCount : null,
        modelName: cleanSessionText(meta.modelName) || modelInfo.modelName || '',
        contextLength,
        compressRatio,
        contextTokens,
        contextUsagePct,
        tokenUsage: tokenUsage ? {
          inputTokens: tokenUsage.inputTokens || 0,
          outputTokens: tokenUsage.outputTokens || 0,
          totalTokens: tokenUsage.totalTokens || 0,
          lastRequestUsage: tokenUsage.lastRequestUsage || null,
        } : null,
        runtimeStatus: status,
        execQueueLength: runtime.queueLength,
        execLastActiveAt: runtime.lastActiveAt,
        viewerAgentId: runtime.viewerAgentId,
        workdir: runtime.workdir || cleanSessionText(meta.openDirectory) || null,
        routing,
      });
    }

    sessions.sort((left, right) => {
      if (left.runtimeStatus === 'running' && right.runtimeStatus !== 'running') return -1;
      if (right.runtimeStatus === 'running' && left.runtimeStatus !== 'running') return 1;
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    });

    const aggregateStatus = sessions.some((s) => s.runtimeStatus === 'running') ? 'running'
      : sessions.some((s) => s.runtimeStatus === 'queued') ? 'queued'
      : sessions.some((s) => s.runtimeStatus === 'idle') ? 'idle'
      : 'offline';
    identities.push({
      identityRef,
      workspaceId,
      displayName: info?.displayName || identityRef,
      description: info?.description || '',
      sessionModel: info?.sessionModel || 'persistent',
      aggregateStatus,
      sessions,
    });
    totals.sessions += sessions.length;
  }

  totals.identities = identities.length;
  return {
    chat: {
      id: chat.id,
      name: chat.name || '',
      messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
      updatedAt: chat.updatedAt || null,
    },
    totals,
    identities,
  };
}

/**
 * 群聊运行时状态查询 API。
 * 返回完整会话池中每个会话的运行状态（running/idle/offline）。
 *
 * 数据来源：
 * 1. chat.sessions 映射（持久会话）
 * 2. chat.messages 消息路由（派发产生的会话，含已完成的）
 * 3. chat.importedSessions（从外部引入的会话）
 *
 * 前端态势感知面板轮询此接口获取实时会话池状态。
 */
app.get('/protoclaw/gc/runtime_status', async (req, res, next) => {
  try {
    const chatId = req.query.chatId;
    if (!chatId) {
      return res.status(400).json({ error: 'chatId required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const allIdentities = await collectIdentities();

    // 收集会话池中所有会话（去重 key = identityRef:sessionId）
    const sessionPool = aggregateSessionPool(chat, allIdentities);

    // 对每个会话查实际运行时状态
    const results = [];
    for (const s of sessionPool) {
      const runtimeKey = getManagedRuntimeKey(s.workspaceId, s.sessionId);
      const runtime = managedAgents.get(runtimeKey);

      if (!runtime || runtime.process?.exitCode !== null || runtime.stopped) {
        results.push({
          identityRef: s.identityRef,
          sessionId: s.sessionId,
          workspaceId: s.workspaceId,
          displayName: s.displayName,
          status: 'offline',
          viewerAgentId: null,
          lastActivity: s.lastActivity,
        });
        continue;
      }

      const viewerAgentId = runtime.viewerAgentId || null;
      let isRunning = false;

      if (viewerAgentId) {
        try {
          // 使用 /notification API 而非 /running：
          // /running 在进程存活时永远返回 {running:true}（仅检查 UDS socket 连通），
          // 不反映是否有 call 正在执行。
          // /notification 的 callActive 字段由 call.start/call.finish 事件维护，
          // 能准确反映会话是否真正处于调用中。
          const notif = await readViewerJson(
            `/api/agents/${encodeURIComponent(viewerAgentId)}/notification`
          );
          isRunning = notif?.callActive === true;
        } catch {}
      }

      results.push({
        identityRef: s.identityRef,
        sessionId: s.sessionId,
        workspaceId: s.workspaceId,
        displayName: s.displayName,
        status: isRunning ? 'running' : 'idle',
        viewerAgentId,
        lastActivity: s.lastActivity,
      });
    }

    res.json({ sessions: results });
  } catch (error) {
    next(error);
  }
});

// ── Phase 3: 拉取工具端点 ──────────────────────────────────────────

async function readThreadHeadOperationalData(workspaceId, sessionId) {
  let session = null;
  try {
    const raw = await fs.readFile(getPrebuiltSessionFilePath(workspaceId, sessionId), 'utf8');
    session = JSON.parse(raw);
  } catch {}

  const featureStates = session?.runtime?.featureStates;
  const todoCheckpoint = Array.isArray(featureStates)
    ? featureStates.find((entry) => entry?.featureName === 'todo' && entry.snapshot)
    : null;
  const tasks = Array.isArray(todoCheckpoint?.snapshot?.tasks) ? todoCheckpoint.snapshot.tasks : [];
  const sessionIndex = await readSessionIndex(workspaceId).catch(() => null);
  const sessionRecord = sessionIndex?.sessions?.find((item) => item.id === sessionId) || null;
  const runtime = await getRuntimeExecSnapshot(workspaceId, sessionId);
  const taskSummary = buildThreadTaskSummary(tasks);

  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      subject: task.subject || '',
      status: task.status || 'pending',
      activeForm: task.activeForm || '',
      createdAt: Number(task.createdAt) || null,
      updatedAt: Number(task.updatedAt) || null,
      finishedAt: ['completed', 'deleted', 'cancelled', 'canceled'].includes(task.status)
        ? Number(task.metadata?.finishedAt
          || task.metadata?.completedAt
          || task.metadata?.cancelledAt
          || task.updatedAt) || null
        : null,
    })),
    taskSummary,
    contextUsage: session ? buildSessionContextUsage(session, sessionRecord) : null,
    latestMessage: session ? buildSessionLatestMessage(session, sessionRecord) : null,
    runtimeStatus: runtime.status,
    execQueueLength: runtime.queueLength || 0,
  };
}

async function buildThreadSituation(chat, allIdentities, options = {}) {
  const sessionPool = aggregateSessionPool(chat, allIdentities);
  const projected = await groupByLineage(sessionPool, chat.sessionLineage, allIdentities, undefined, {
    activeSessions: chat.sessions,
    messages: chat.messages,
  });

  const threads = await Promise.all(projected.map(async (thread) => {
    const operational = await readThreadHeadOperationalData(thread.workspaceId, thread.lineageHeadId);
    const lineageSessionIds = new Set((thread.lineage || []).map((node) => node.sessionId));
    const latestRoutingMessage = [...(chat.messages || [])]
      .reverse()
      .find((message) => message?.routing?.targetIdentityRef === thread.identityRef
        && lineageSessionIds.has(message.routing.targetSessionId));
    const latestRoutingStatus = latestRoutingMessage?.routing?.status || null;
    const workStatus = deriveThreadWorkStatus(
      { ...thread, latestRoutingStatus },
      operational.taskSummary,
      operational.runtimeStatus,
    );
    return {
      ...thread,
      workStatus,
      latestRoutingStatus,
      runtimeStatus: thread.canDispatch ? operational.runtimeStatus : 'unavailable',
      taskSummary: operational.taskSummary,
      contextUsage: operational.contextUsage,
      latestMessage: operational.latestMessage,
      execQueueLength: operational.execQueueLength,
      ...(options.includeTasks ? { tasks: operational.tasks } : {}),
    };
  }));

  const workRank = { active: 0, completed: 1, archived: 2 };
  const runtimeRank = { running: 0, queued: 1, idle: 2, offline: 3, unavailable: 4 };
  threads.sort((left, right) =>
    (workRank[left.workStatus] ?? 9) - (workRank[right.workStatus] ?? 9)
    || (runtimeRank[left.runtimeStatus] ?? 9) - (runtimeRank[right.runtimeStatus] ?? 9)
    || (right.updatedAt || 0) - (left.updatedAt || 0)
  );

  const totals = {
    running: threads.filter((thread) => thread.runtimeStatus === 'running').length,
    active: threads.filter((thread) => thread.workStatus === 'active').length,
    completed: threads.filter((thread) => thread.workStatus === 'completed').length,
    archived: threads.filter((thread) => thread.workStatus === 'archived').length,
  };
  return { generatedAt: Date.now(), totals, threads };
}

function findThreadByRef(situation, threadRef) {
  return situation?.threads?.find((thread) => thread.threadRef === threadRef) || null;
}

function formatAdminThreadSituation(situation) {
  const threads = Array.isArray(situation?.threads) ? situation.threads : [];
  const totals = situation?.totals || {};
  const lines = [
    '─── 当前工作线程 ───',
    `概览：进行中 ${totals.active || 0}；已完成 ${totals.completed || 0}；已归档 ${totals.archived || 0}`,
  ];
  if (threads.length === 0) {
    lines.push('当前还没有工作线程。');
    return lines.join('\n');
  }

  const visible = threads.filter((thread) => thread.workStatus !== 'archived').slice(0, 20);
  for (const thread of visible) {
    const workLabel = thread.workStatus === 'completed' ? '已完成' : '进行中';
    const runtimeLabels = {
      running: '运行中', queued: '排队中', idle: '空闲可继续', offline: '未运行可继续', unavailable: '不可用',
    };
    const task = thread.taskSummary || {};
    const taskText = (task.total || 0) > 0
      ? `Task ${task.resolved ?? ((task.completed || 0) + (task.cancelled || 0))}/${task.total} 已处理${task.cancelled ? `（含 ${task.cancelled} 取消）` : ''}`
      : 'Task 尚未建立';
    const contextText = thread.contextUsage
      ? `上下文 ${thread.contextUsage.percent || 0}%`
      : '上下文未知';
    const title = thread.threadTitle || thread.activeHeadTitle || '未命名工作';
    lines.push(
      '',
      `[${workLabel} · ${runtimeLabels[thread.runtimeStatus] || thread.runtimeStatus || '未知'}] ${thread.identityName} · ${title}`,
      `  threadRef: ${thread.threadRef}`,
      `  ${taskText}；${contextText}；${thread.canDispatch ? '可派发' : '不可派发'}`,
    );
    const latest = String(thread.latestMessage?.text || '').replace(/\s+/g, ' ').trim();
    if (latest) lines.push(`  最近：${latest.length > 180 ? `${latest.slice(0, 180)}…` : latest}`);
  }
  if ((totals.archived || 0) > 0) {
    lines.push('', `已归档线程：${totals.archived} 条（未展开）`);
  }
  return lines.join('\n');
}

/**
 * GET /protoclaw/gc/session_threads?chatId=xxx
 * 返回群聊的所有工作线程视图（血缘聚合）。
 */
app.get('/protoclaw/gc/session_threads', async (req, res, next) => {
  try {
    const chatId = req.query.chatId;
    if (!chatId) return res.status(400).json({ error: 'chatId required' });

    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });

    const allIdentities = await collectIdentities();
    const situation = await buildThreadSituation(chat, allIdentities);
    res.json(situation);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /protoclaw/gc/thread_detail?chatId=xxx&threadRef=yyy
 * 管理员与人类 UI 共用的线程详情：当前 head、Task、上下文、最近消息和血缘。
 */
app.get('/protoclaw/gc/thread_detail', async (req, res, next) => {
  try {
    const { chatId, threadRef } = req.query;
    if (!chatId || !threadRef) return res.status(400).json({ error: 'chatId and threadRef required' });
    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    const allIdentities = await collectIdentities();
    const situation = await buildThreadSituation(chat, allIdentities, { includeTasks: true });
    const thread = findThreadByRef(situation, threadRef);
    if (!thread) return res.status(404).json({ error: 'Work thread not found' });
    res.json({ generatedAt: situation.generatedAt, thread });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /protoclaw/gc/session_tasks?agentId=xxx&sessionId=yyy
 * 读取指定 session 文件中的 TodoFeature task 列表。
 */
app.get('/protoclaw/gc/session_tasks', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      return res.status(400).json({ error: 'agentId and sessionId required' });
    }

    const operational = await readThreadHeadOperationalData(agentId, sessionId);

    res.json({
      sessionId,
      tasks: operational.tasks,
      summary: operational.taskSummary,
      contextUsage: operational.contextUsage,
      latestMessage: operational.latestMessage,
      runtimeStatus: operational.runtimeStatus,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /protoclaw/gc/session_summary?agentId=xxx&sessionId=yyy
 * 返回指定 session 的简要摘要（标题、创建时间、更新时间、项目目录）。
 */
app.get('/protoclaw/gc/session_summary', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      return res.status(400).json({ error: 'agentId and sessionId required' });
    }

    const index = await readSessionIndex(agentId).catch(() => null);
    if (!index?.sessions) {
      return res.status(404).json({ error: 'Session index not found' });
    }

    const record = index.sessions.find((s) => s.id === sessionId);
    if (!record) {
      return res.status(404).json({ error: 'Session not found in index' });
    }

    res.json({
      sessionId,
      title: record.title || record.taskTitle || '',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      openDirectory: record.openDirectory || null,
      sessionType: record.sessionType || 'normal',
    });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/group_chats/:chatId/awareness', async (req, res, next) => {
  try {
    const awareness = await buildGroupChatAwareness(req.params.chatId);
    if (!awareness) return res.status(404).json({ error: 'Group chat not found' });
    res.json(awareness);
  } catch (error) {
    next(error);
  }
});

/**
 * Level 1 mention 派发：将群聊消息发送到目标 agent 的 session。
 *
 * 流程：
 * 1. 解析 mention → workspaceId
 * 2. 找到或启动 agent runtime
 * 3. 等待 runtime ready
 * 4. 通过 gc inbox 投递消息（GroupChatBridgeFeature 轮询消费）
 * 5. 更新 routing.status = "delivered"
 * 6. 后台跟踪 agent 完成状态 → "completed" / "failed"
 */
/**
 * 管理员上下文完整性保证（基础语义）。
 *
 * 这是管理员被唤醒时的唯一上下文准备通道。所有向管理员投递消息的路径
 * —— dispatchToIdentity（直接派发 / execute 模式）、
 *    notifyAdminForActivity（plan 模式动态通知）、
 *    notifyAdminForObservation（plan 模式观察通知）——
 * 都必须经过此函数。
 *
 * 保证三条不变量：
 * 1. catch-up：管理员离开后错过的群聊消息全部补全
 * 2. 群记忆：新 session 时注入历史摘要
 * 3. 水位线：lastActiveAt 在每次调用后正确推进
 *
 * 函数内部读取最新群聊状态（避免调用方传入 stale 对象），计算后写回。
 *
 * @param {string} chatId - 群聊 ID
 * @param {Array}  allIdentities - collectIdentities() 结果（避免重复调用）
 * @param {number} currentMessageTimestamp - 触发本次唤醒的消息时间戳（catch-up 上界）
 * @param {string} currentMessageId - 触发本次唤醒的消息 ID（排除自身）
 * @param {boolean} isNew - 管理员 session 是否为本次新建
 * @param {boolean} [includeCurrentMessage=false] - 是否将触发消息本身纳入 catch-up
 *        （非 @admin 直达场景需要 true，使触发消息内容进入 system-reminder 而非 user 块）
 * @returns {string|null} 合并后的上下文前缀文本（群记忆 + catch-up），无内容时返回 null
 */
async function prepareAdminContext(chatId, allIdentities, currentMessageTimestamp, currentMessageId, isNew, includeCurrentMessage = false) {
  const identityRef = 'work-group:admin';
  const chat = await readGroupChat(chatId);
  if (!chat) return null;

  const sections = [];

  // ── 新 session：群聊基本信息 + GROUP.md + 群记忆 ──
  // 这些是静态/半静态背景，只在 session 首次注入，避免每轮重复污染
  if (isNew) {
    // 群聊基本信息
    sections.push(formatGroupInfoBlock(chat));

    // GROUP.md
    try {
      const mdPath = path.join(GROUP_CHATS_ROOT, chatId, 'GROUP.md');
      const mdContent = await fs.readFile(mdPath, 'utf-8');
      if (mdContent && mdContent.trim()) {
        sections.push(`─── 群聊背景 ───\n${mdContent}`);
        log('GroupChat', `GROUP.md injected (${mdContent.length} chars) for new admin session`);
      }
    } catch {
      // GROUP.md 不存在或不可读，跳过
    }

    // 群记忆（近期消息摘要，标注时间范围）
    const mem = chat.adminMemory || { range: '3d' };
    const range = mem.range || '3d';
    const groupMemory = await composeGroupMemory(chat, range, { includeAnnotations: true, collectIdentities, readAnnotations });
    groupMemory.chatId = chatId;
    const memoryPrompt = formatGroupMemoryPrompt(groupMemory, range);
    if (memoryPrompt) {
      sections.push(memoryPrompt);
      log('GroupChat', `group memory pre-injected for new admin session (${groupMemory.messageCount} messages, range=${range})`);
    }
  }

  // ── 每次激活：注入当前工作线程态势 ──
  // 保持原有“两层结构”不变：线程态势属于 system-reminder 中的环境证据，
  // user 块仍只承载真实用户请求或一句事件触发描述。管理员先知道“现在怎样”，
  // 再通过下方 catch-up 理解“刚刚发生了什么”。
  try {
    const situation = await buildThreadSituation(chat, allIdentities);
    sections.push(formatAdminThreadSituation(situation));
  } catch (err) {
    log('GroupChat', `admin thread situation build failed: ${err.message}`, 'warn');
  }

  // ── catch-up：补上管理员离开后错过的全部群聊消息（含事件消息）──
  // 首轮（新 session 且无历史水位线）跳过 catch-up，群记忆已覆盖历史
  if (!chat.lastActiveAt) chat.lastActiveAt = {};
  const lastActive = chat.lastActiveAt[identityRef] || 0;
  if (!(isNew && lastActive === 0)) {
    const catchUpMessages = (chat.messages || []).filter(
      (m) => {
        if ((m.timestamp || 0) <= lastActive) return false;
        // includeCurrentMessage=true 时，触发消息本身纳入 catch-up（进入 system-reminder），
        // 使 user 块只需承载事件通知而非原始内容
        if (includeCurrentMessage) return true;
        if ((m.timestamp || 0) >= (currentMessageTimestamp || Date.now())) return false;
        if (m.id === currentMessageId) return false;
        return true;
      }
    );
    if (catchUpMessages.length > 0) {
      // 合并批注到 catch-up 消息（仅管理员注入）
      const annotations = await readAnnotations(chatId);
      if (Object.keys(annotations).length > 0) {
        catchUpMessages.forEach((m) => {
          if (annotations[m.id]) m._annotation = annotations[m.id];
        });
      }
      const catchUpPrompt = formatCatchUpPrompt(catchUpMessages, allIdentities, chatId, chat.name);
      if (catchUpPrompt) {
        sections.push(catchUpPrompt);
        log('GroupChat', `catch-up merged into admin context: ${catchUpMessages.length} messages`);
      }
    }
  }

  // ── 推进水位线 ──
  chat.lastActiveAt[identityRef] = currentMessageTimestamp || Date.now();
  await writeGroupChat(chat);

  return sections.length > 0 ? sections.join('\n\n') : null;
}

/**
 * 确保 work-group admin runtime 已启动。
 * 统一管理员 runtime 的启动入口，供所有 admin 通知路径调用。
 * 返回 runtime 对象（已 ready），失败时抛异常。
 */
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

/**
 * 核心派发逻辑：将消息投递到指定 identity 的 session。
 * 负责 session 解析、runtime 启动、gc inbox 投递、状态跟踪。
 */
async function dispatchToIdentity(chatId, message, chat, identityRef, composedPrompt, sessionOptions = {}, opts = {}) {
  const workspaceId = identityRef.split(':')[0];
  log('GroupChat', `dispatching message ${message.id} to ${workspaceId} (${identityRef}) sessionOpts=${JSON.stringify(sessionOptions)}`);

  // 1. 解析 identity 的 sessionModel
  const allIdentities = await collectIdentities();
  const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
  const sessionModel = identityInfo?.sessionModel || 'persistent';

  // 2. 解析或创建 session（传入 sessionOptions）
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, identityRef, sessionModel, sessionOptions);
  log('GroupChat', `resolved session ${sessionId} (isNew=${isNew}) for ${identityRef}`);

  // 3. 找到或启动指定 session 的 runtime
  let runtime = getAgentRuntime(workspaceId, sessionId);
  const isAlive = runtime?.process && runtime.process.exitCode === null && !runtime.stopped;

  if (!isAlive) {
    try {
      const agent = await requireAgentLight(workspaceId);
      log('GroupChat', `starting agent ${workspaceId} session=${sessionId} for dispatch`);
      await startManagedAgent(agent, sessionId);
      runtime = await waitForManagedRuntimeReady(workspaceId, 30000, sessionId);
      if (!runtime) {
        throw new Error('Agent runtime failed to become ready within 30s');
      }
    } catch (err) {
      log('GroupChat', `failed to start agent: ${err.message}`, 'error');
      await updateMessageRouting(chatId, message.id, {
        status: 'failed',
        error: `Failed to start agent: ${err.message}`,
        completedAt: Date.now(),
      });
      return;
    }
  }

  // 4. 确保 runtime ready
  if (!runtime.viewerAgentId) {
    const ready = await waitForManagedRuntimeReady(workspaceId, 15000, sessionId);
    if (!ready?.id) {
      await updateMessageRouting(chatId, message.id, {
        status: 'failed',
        error: 'Agent runtime not ready (no viewerAgentId)',
        completedAt: Date.now(),
      });
      return;
    }
    runtime = getAgentRuntime(workspaceId, sessionId);
  }

  const viewerAgentId = runtime?.viewerAgentId;
  if (!viewerAgentId) {
    await updateMessageRouting(chatId, message.id, {
      status: 'failed',
      error: 'No viewerAgentId available',
      completedAt: Date.now(),
    });
    return;
  }

  // 5. 上下文完整性：
  // - 管理员：catch-up + 群记忆 + GROUP.md + 群聊基本信息
  // - 被派发 agent：群聊 system 上下文块（交代群聊背景、发送者身份、回复可见性）
  // 这些内容通过 contextText 分离传递，bridge 在 CallStart 时注入为 system 消息，
  // 而不是混入用户消息。
  const runtimeKey = getManagedRuntimeKey(workspaceId, sessionId);

  let fullPrompt = composedPrompt;
  let contextText = null;

  if (identityRef === 'work-group:admin') {
    contextText = await prepareAdminContext(
      chatId, allIdentities,
      message.timestamp || Date.now(), message.id, isNew,
      opts.includeCurrentMessage || false,
    );
    // systemNote 作为 system 层辅助信息注入（如审批拒绝上下文）
    if (opts.systemNote) {
      contextText = contextText ? `${opts.systemNote}\n\n${contextText}` : opts.systemNote;
    }
  } else {
    // 被派发的 agent：注入群聊 system 上下文块
    contextText = buildGroupDispatchSystemMessage(chat, message, allIdentities);
  }

  // 6. 通过 gc inbox 投递实际消息（context 通过 contextText 字段分离传递）
  // 附件作为独立字段传递，不再混入用户消息文本
  // 处理附件内容，实现渐进式加载
  const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
  
  enqueueGcInbox(runtimeKey, {
    id: message.id,
    text: fullPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: identityRef,
    attachments: processedAttachments,
    textInCatchUp: opts.includeCurrentMessage || false,
  });
  log('GroupChat', `message ${message.id} enqueued to gc inbox for ${workspaceId}/${sessionId}`);

  // 6. 更新 routing 状态（含 sessionTitle 供 dispatch 卡片展示）
  // 查找 session 标题用于展示
  let resolvedSessionTitle = sessionId;
  try {
    const idx = await readSessionIndex(workspaceId);
    const rec = idx.sessions.find((s) => s.id === sessionId);
    if (rec) resolvedSessionTitle = rec.title || rec.taskTitle || sessionId;
  } catch {}

  await updateMessageRouting(chatId, message.id, {
    status: 'delivered',
    targetSessionId: sessionId,
    targetSessionTitle: resolvedSessionTitle,
    dispatchedAt: Date.now(),
  });

  // 6.5. 追加"任务已启动"事件卡片（以 agent 身份发送，便于追踪）
  // 管理员自身不需要 task_started 卡片——它是协调者，不是执行者
  // 管理员发起的 dispatch 已经有 dispatch 卡片传达了完整信息，不再追加冗余事件
  if (identityRef !== 'work-group:admin' && message.from !== 'work-group:admin') {
    await appendGroupChatMessage(chatId, {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      from: identityRef,
      text: '',
      kind: 'event',
      event: {
        type: 'task_started',
        identityRef,
        identityName: identityInfo?.displayName || workspaceId,
        sessionId,
        sessionTitle: resolvedSessionTitle,
        workspaceId,
      },
      mentions: [],
      links: [],
      timestamp: Date.now(),
      routing: null,
    });
    log('GroupChat', `event card appended: task_started for ${identityRef} in ${chatId}`);
  }

  // 6.6. 规划模式下不再单独通知 task_started 事件
  // plan 模式的通知已在 dispatchGroupChatMessage 的 plan 分支合并投递
  // （notifyAdminWithPrompt 包含了"@了X + X已开始处理"的完整信息）

  // 7. 后台跟踪完成状态 + task 完成检测
  trackGroupChatDispatch(chatId, message.id, workspaceId, viewerAgentId, {
    identityRef,
    sessionId,
    sessionTitle: resolvedSessionTitle,
    identityName: identityInfo?.displayName || workspaceId,
  });

  return { sessionId, sessionTitle: resolvedSessionTitle, isNew, workspaceId, viewerAgentId };
}

/**
 * 群聊消息派发入口。
 * 根据群的主动性模式决定路由策略：
 * - assist: 直接派发到目标 agent
 * - plan: 直接派发 + 通知管理员观察
 * - execute: 转发给管理员协调
 */
async function dispatchGroupChatMessage(chatId, message, sessionOptions = {}) {
  const routing = message.routing;
  if (!routing || !routing.targetWorkspaceId) return;

  const chat = await readGroupChat(chatId);
  const chatName = chat?.name || '';
  const initiativeMode = chat?.initiativeMode || 'assist';
  const autonomyMode = chat?.autonomyMode || 'auto';
  const targetIdentityRef = routing.targetIdentityRef;
  const targetIsAdmin = targetIdentityRef === 'work-group:admin';

  // @管理员 → 始终直接派发给管理员
  if (targetIsAdmin) {
    const prompt = composeDispatchPrompt(message);
    let opts = {};
    // 拒绝审批派发的消息：附带 systemNote 让管理员理解拒绝上下文
    if (message.rejectDispatchId) {
      const pendingMsg = (chat?.messages || []).find((m) => m.id === message.rejectDispatchId);
      if (pendingMsg) {
        const pTargetRef = pendingMsg.mentions?.[0]?.identityRef || pendingMsg.routing?.targetIdentityRef;
        const pTargetInfo = (await collectIdentities()).find((i) => i.identityRef === pTargetRef);
        const pTargetName = pTargetInfo?.displayName || pTargetRef;
        opts.systemNote = [
          '─── 派发请求被拒绝 ───',
          `被拒绝的派发目标：${pTargetName}（${pTargetRef}）`,
          `被拒绝的派发内容：${(pendingMsg.text || '').slice(0, 300)}`,
          `原派发消息 ID: ${message.rejectDispatchId}`,
        ].join('\n');
      }
    }
    await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions, opts);
    return;
  }

  // 管理员发出的派发消息 → 直接到达目标，不再经过模式路由。
  // 否则在 execute 模式下，admin dispatch → 新消息 → 又路由回 admin → 无限循环。
  if (message.from === 'work-group:admin') {
    const prompt = composeDispatchPrompt(message);
    await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
    return;
  }

  switch (initiativeMode) {
    case 'execute': {
      // 执行模式：转发给管理员协调
      log('GroupChat', `execute mode: routing to admin for ${message.id}`);
      const allIdentities = await collectIdentities();
      const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
      const targetName = targetInfo?.displayName || targetIdentityRef;

      // user 块仅保留事件通知，用户原话由 catch-up（含触发消息）注入 system-reminder
      const coordinatorPrompt = `用户 @了 ${targetName}`;

      // 更新 routing 目标为管理员
      await updateMessageRouting(chatId, message.id, {
        targetIdentityRef: 'work-group:admin',
        targetWorkspaceId: 'work-group',
        routedByMode: 'execute',
      });
      await dispatchToIdentity(chatId, message, chat, 'work-group:admin', coordinatorPrompt, {}, { includeCurrentMessage: true });
      break;
    }

    case 'plan': {
      // 规划模式：直接派发 + 单一通知管理员
      const prompt = composeDispatchPrompt(message);
      const dispatchResult = await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);

      // 异步通知管理员（合并：观察 + 任务启动信息，一次 call 搞定）
      const allIdentities = await collectIdentities();
      const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
      const targetName = targetInfo?.displayName || targetIdentityRef;

      // user 块：仅保留事件通知，用户原话由 catch-up（含触发消息）注入 system-reminder
      let observationText = `用户 @了 ${targetName}`;

      // 附件摘要：显示附件数量和名称
      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        const attNames = message.attachments.map(a => a.name).join(', ');
        observationText += `  [附件: ${attNames}]`;
      }

      // system 层：派发状态，与 gc_dispatch 工具返回的信息丰富度保持一致
      let systemNote;
      if (dispatchResult) {
        const action = dispatchResult.isNew
          ? `已建立新工作「${dispatchResult.sessionTitle}」`
          : `指令已进入已有工作「${dispatchResult.sessionTitle}」`;
        systemNote = [
          '─── 自动派发状态 ───',
          `目标：${targetName}（${targetIdentityRef}）`,
          `操作：${action}`,
          `消息 ID: ${message.id}`,
          `系统已自动将此消息派发给 ${targetName}，你不需要重复派发。`,
        ].join('\n');
      } else {
        systemNote = [
          '─── 自动派发状态 ───',
          `目标：${targetName}（${targetIdentityRef}）`,
          `状态：会话启动可能失败，请关注。`,
          `消息 ID: ${message.id}`,
        ].join('\n');
      }

      notifyAdminWithPrompt(chatId, message, chat, observationText, systemNote).catch((err) => {
        log('GroupChat', `admin observation notify failed: ${err.message}`, 'warn');
      });
      break;
    }

    case 'assist':
    default: {
      // 辅助模式：直接派发
      const prompt = composeDispatchPrompt(message);
      await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
      break;
    }
  }
}

/**
 * 统一管理员通知通道：向管理员投递一条自定义 prompt（合并到一次 call）。
 * 内部调用 prepareAdminContext 保证 catch-up + 群记忆完整性。
 * 用于替代 notifyAdminForObservation，避免产生多次碎片化 call。
 */
async function notifyAdminWithPrompt(chatId, message, chat, promptText, systemNote) {
  const allIdentities = await collectIdentities();

  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `notifyAdminWithPrompt: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  let contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
  );

  // systemNote 作为 system 层辅助信息注入，与 catch-up / 群记忆并列，
  // 避免辅助性内容混入 user 块导致模型困惑。
  if (systemNote) {
    contextText = contextText
      ? `${systemNote}\n\n${contextText}`
      : systemNote;
  }

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  // 处理附件内容，实现渐进式加载
  const processedAttachments = processAttachmentsForInjection(message.attachments, chat);

  enqueueGcInbox(runtimeKey, {
    id: `obs-${message.id}`,
    text: promptText,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
    attachments: processedAttachments,
    textInCatchUp: true,
  });
  log('GroupChat', `notifyAdminWithPrompt enqueued for admin`);
}

/**
 * 规划模式下，通知管理员观察群内活动。
 * 不创建 routing，只投递一条观察消息到管理员的 gc inbox。
 */
async function notifyAdminForObservation(chatId, message, chat, targetIdentityRef) {
  const chatName = chat?.name || '';
  const allIdentities = await collectIdentities();
  const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
  const targetName = targetInfo?.displayName || targetIdentityRef;

  let observationText = `[观察] 用户 @了 ${targetName}：${message.text || ''}`;
  
  // 附件摘要：显示附件数量和名称
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attNames = message.attachments.map(a => a.name).join(', ');
    observationText += `  [附件: ${attNames}]`;
  }
  
  const observationPrompt = [
    observationText,
    '',
    `系统已将此消息派发给 ${targetName}，会话已启动。你不需要重复派发。`,
  ].join('\n');

  // 确保管理员 runtime 存在
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `admin observation: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  // 上下文完整性：经统一通道补全 catch-up + 群记忆（含触发消息本身）
  const contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
  );

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  // 处理附件内容，实现渐进式加载
  const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
  
  enqueueGcInbox(runtimeKey, {
    id: `obs-${message.id}`,
    text: observationPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
    attachments: processedAttachments,
    textInCatchUp: true,
  });
  log('GroupChat', `observation notify enqueued for admin`);
}

/**
 * 规划模式下，通知管理员观察一般群聊活动（非 @mention 消息）。
 * 用于纯讨论消息、agent 回复等。
 */
async function notifyAdminForActivity(chatId, message, chat) {
  const chatName = chat?.name || '';
  const allIdentities = await collectIdentities();
  const senderInfo = allIdentities.find((i) => i.identityRef === message.from);
  const senderName = message.from === 'user'
    ? '用户'
    : (senderInfo?.displayName || message.from);

  let activityDesc;
  const sessionLabel = formatSessionLabel(message.routing?.targetSessionTitle, message.routing?.targetSessionId);
  if (message.kind === 'event') {
    const evtSession = formatSessionLabel(message.event?.sessionTitle, message.event?.sessionId);
    const evtName = message.event?.identityName || '';
    switch (message.event?.type) {
      case 'task_started':
        activityDesc = `系统事件：${evtName}${evtSession} 已开始处理`;
        break;
      case 'session_interrupted':
        activityDesc = `系统事件：${evtName}${evtSession} 会话已被管理员中断`;
        break;
      case 'agent_offline':
        activityDesc = `系统事件：${evtName}${evtSession} 进程已退出`;
        break;
      case 'session_continued': {
        const reason = message.event?.reason || '';
        const reasonMeanings = {
          trim: '精简历史后已由新上下文接管',
          summary: '摘要交接后已由新上下文接管',
          branch: '已创建新的并行工作线程',
        };
        const meaning = message.event?.threadDisposition === 'new_thread'
          ? '已从历史上下文派生新的并行工作线程'
          : (reasonMeanings[reason] || '当前上下文入口已更新');
        const archiveNote = message.event?.archived ? '，原会话已归档，不再接收新任务' : '';
        const threadTitle = message.event?.threadTitle || message.event?.sessionTitle || '未命名工作';
        activityDesc = `系统事件：${evtName} · 工作线程「${threadTitle}」${meaning}${archiveNote}`;
        break;
      }
      case 'session_archived':
        activityDesc = `系统事件：${evtName}${evtSession} 会话已归档，不再接收新任务`;
        break;
      case 'session_unarchived':
        activityDesc = `系统事件：${evtName}${evtSession} 已取消归档，可以继续接收任务`;
        break;
      case 'task_completed': {
        const taskTitle = message.event?.taskTitle || '';
        const threadTitle = message.event?.threadTitle || message.event?.sessionTitle || '未命名工作';
        activityDesc = `系统事件：${evtName} · 工作线程「${threadTitle}」Task 完成：${taskTitle}`;
        break;
      }
      default:
        activityDesc = `系统事件：${evtName}${evtSession}`;
        break;
    }
  } else if (message.from === 'user') {
    activityDesc = `用户发送了消息`;
  } else {
    activityDesc = `${senderName}${sessionLabel} 回复了`;
  }

  // 附件摘要：显示附件数量和名称
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attNames = message.attachments.map(a => a.name).join(', ');
    activityDesc += `  [附件: ${attNames}]`;
  }

  // user 块仅保留事件通知，原始内容由 catch-up（含触发消息）注入 system-reminder
  const activityPrompt = activityDesc;

  // 确保管理员 runtime 存在
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `admin activity: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  // 上下文完整性：经统一通道补全 catch-up + 群记忆（含触发消息本身）
  const contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew, true,
  );

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  // 处理附件内容，实现渐进式加载
  const processedAttachments = processAttachmentsForInjection(message.attachments, chat);
  
  enqueueGcInbox(runtimeKey, {
    id: `act-${message.id}`,
    text: activityPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
    attachments: processedAttachments,
    textInCatchUp: true,
  });
  log('GroupChat', `activity notify enqueued for admin: ${activityDesc.slice(0, 50)}`);
}

/**
 * 反查：哪些群聊关联了指定的 session？
 *
 * 查找 3 个来源（按优先级）：
 * 1. chat.sessions 映射（活跃头部）
 * 2. chat.importedSessions（导入的外部会话）
 * 3. 消息 routing.targetSessionId（历史派发记录）
 *
 * @param {string} sessionId — 要查找的 session ID
 * @returns {Promise<Array<{ chat: object, identityRef: string }>>}
 */
async function findChatsBySessionId(sessionId) {
  const chatList = await listGroupChats();
  const matches = [];

  for (const summary of chatList) {
    if (summary.archived) continue;
    const chat = await readGroupChat(summary.id);
    if (!chat) continue;

    let foundRef = null;

    // Source 1: chat.sessions 映射
    for (const [identityRef, sid] of Object.entries(chat.sessions || {})) {
      if (identityRef === 'work-group:admin') continue;
      if (sid === sessionId) {
        foundRef = identityRef;
        break;
      }
    }

    // Source 2: importedSessions
    if (!foundRef && Array.isArray(chat.importedSessions)) {
      for (const imp of chat.importedSessions) {
        if (imp.sessionId === sessionId) {
          foundRef = imp.identityRef || `${imp.workspaceId}:main`;
          break;
        }
      }
    }

    // Source 3: 消息 routing
    if (!foundRef) {
      for (const msg of (chat.messages || [])) {
        if (msg.routing?.targetSessionId === sessionId) {
          const ref = msg.routing.targetIdentityRef;
          if (ref && ref !== 'work-group:admin') {
            foundRef = ref;
            break;
          }
        }
      }
    }

    if (foundRef) {
      matches.push({ chat, identityRef: foundRef });
    }
  }

  return matches;
}

/**
 * 会话血缘继承：当上下文管理操作（trim/compact/summary/branch）产生新 session 时，
 * 自动将新 session 关联到原 session 所属的群聊，并通知管理员。
 *
 * 核心流程：
 * 1. 反查 fromSessionId 关联的群聊
 * 2. 在群聊中写入血缘记录、更新活跃头部、追加事件消息（原子写入）
 * 3. plan/execute 模式下通知管理员
 *
 * 如果 fromSessionId 不属于任何群聊，静默跳过。
 *
 * @param {object} params
 * @param {string} params.agentId        — workspace ID（如 'programming-helper'），用于解析 session 标题
 * @param {string} params.fromSessionId  — 源 session ID
 * @param {string} params.toSessionId    — 新 session ID
 * @param {string} params.reason         — branch | summary | trim
 * @param {boolean} [params.archived]   — 原会话是否已被归档
 * @param {number} [params.trimCutRounds] — trim 操作精简的轮次数
 */
async function notifySessionLineage({ agentId, fromSessionId, toSessionId, reason, archived = false, trimCutRounds } = {}) {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return;

  const matches = await findChatsBySessionId(fromSessionId);
  if (matches.length === 0) return;

  const allIdentities = await collectIdentities();

  for (const { chat, identityRef } of matches) {
    try {
      const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
      const identityName = identityInfo?.displayName || identityRef.split(':')[1] || identityRef;
      const workspaceId = identityRef.split(':')[0];

      // 读取新 session 和原 session 的标题
      let sessionTitle = null;
      let fromSessionTitle = null;
      try {
        const sessionIndex = await readSessionIndex(workspaceId);
        const toRecord = sessionIndex?.sessions?.find((s) => s.id === toSessionId);
        sessionTitle = toRecord?.title || null;
        const fromRecord = sessionIndex?.sessions?.find((s) => s.id === fromSessionId);
        fromSessionTitle = fromRecord?.title || null;
      } catch {}

      // 原子写入：血缘记录 + 活跃头部更新 + 事件消息
      if (!Array.isArray(chat.sessionLineage)) chat.sessionLineage = [];
      chat.sessionLineage.push({
        from: fromSessionId,
        to: toSessionId,
        reason,
        timestamp: Date.now(),
        identityRef,
      });

      // 更新活跃头部
      if (!chat.sessions) chat.sessions = {};
      chat.sessions[identityRef] = toSessionId;

      // 基于更新后的血缘图解析稳定线程引用。线性 successor 继承原线程引用，
      // branch 或旧节点再派生得到新的引用。事件与管理员/UI 因而指向同一工作。
      let threadRef = null;
      let threadTitle = sessionTitle || fromSessionTitle || null;
      let threadDisposition = 'head_advanced';
      try {
        const projected = await groupByLineage(
          aggregateSessionPool(chat, allIdentities),
          chat.sessionLineage,
          allIdentities,
          undefined,
          { activeSessions: chat.sessions, messages: chat.messages },
        );
        const targetThread = projected.find((thread) => thread.lineageHeadId === toSessionId && thread.identityRef === identityRef);
        if (targetThread) {
          threadRef = targetThread.threadRef;
          threadTitle = targetThread.threadTitle || targetThread.activeHeadTitle || threadTitle;
          if (targetThread.threadRef === `${identityRef}::${toSessionId}`) {
            threadDisposition = 'new_thread';
          }
        }
      } catch {}

      // 追加事件消息
      const eventMessage = {
        id: `evt-lineage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatId: chat.id,
        from: identityRef,
        text: '',
        kind: 'event',
        event: {
          type: 'session_continued',
          identityRef,
          identityName,
          threadRef,
          threadTitle,
          threadDisposition,
          sessionId: toSessionId,
          sessionTitle,
          fromSessionId,
          fromSessionTitle,
          toSessionId,
          reason,
          archived,
          ...(trimCutRounds != null ? { trimCutRounds } : {}),
          workspaceId,
        },
        mentions: [],
        links: [],
        timestamp: Date.now(),
        routing: null,
      };

      if (!Array.isArray(chat.messages)) chat.messages = [];
      chat.messages.push(eventMessage);

      await writeGroupChat(chat);
      log('GroupChat', `session lineage: ${fromSessionId} → ${toSessionId} (${reason}) in chat ${chat.id}`);

      // 不主动唤醒管理员：session lifecycle 事件降级为纯水位线捕获，
      // 仅写入 chat.messages，等下一次管理员因其他原因被唤醒时由 catch-up 自然带入。
    } catch (err) {
      log('GroupChat', `session lineage failed for chat ${chat.id}: ${err.message}`, 'error');
    }
  }
}

/**
 * 会话归档状态通知：当用户直接归档或取消归档一个会话时，
 * 向关联群聊推送对应事件。
 *
 * 与 notifySessionLineage 的区别：
 * - 不创建新会话，不更新活跃头部
 * - 归档时从活跃头部映射中移除该 session（如果有）
 * - 事件 type 为 session_archived / session_unarchived
 *
 * @param {object} params
 * @param {string} params.agentId        — workspace ID
 * @param {string} params.sessionId      — 被归档的 session ID
 * @param {boolean} params.archived      — true 为归档，false 为取消归档
 */
async function notifySessionArchived({ agentId, sessionId, archived = true }) {
  if (!sessionId) return;

  const matches = await findChatsBySessionId(sessionId);
  if (matches.length === 0) return;

  const allIdentities = await collectIdentities();

  for (const { chat, identityRef } of matches) {
    try {
      const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
      const identityName = identityInfo?.displayName || identityRef.split(':')[1] || identityRef;
      const workspaceId = identityRef.split(':')[0];

      let sessionTitle = null;
      try {
        const sessionIndex = await readSessionIndex(workspaceId);
        const record = sessionIndex?.sessions?.find((s) => s.id === sessionId);
        sessionTitle = record?.title || null;
      } catch {}

      // 归档当前入口时移除旧映射；取消归档不强行抢占同身份的当前入口。
      if (archived && chat.sessions && chat.sessions[identityRef] === sessionId) {
        delete chat.sessions[identityRef];
      }

      const eventMessage = {
        id: `evt-${archived ? 'archive' : 'unarchive'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chatId: chat.id,
        from: identityRef,
        text: '',
        kind: 'event',
        event: {
          type: archived ? 'session_archived' : 'session_unarchived',
          identityRef,
          identityName,
          sessionId,
          sessionTitle,
          workspaceId,
        },
        mentions: [],
        links: [],
        timestamp: Date.now(),
        routing: null,
      };

      if (!Array.isArray(chat.messages)) chat.messages = [];
      chat.messages.push(eventMessage);

      await writeGroupChat(chat);
      log('GroupChat', `session ${archived ? 'archived' : 'unarchived'}: ${sessionId} in chat ${chat.id}`);

      // 同 notifySessionLineage：不主动唤醒管理员，由 catch-up 自然带入。
    } catch (err) {
      log('GroupChat', `session archive-state notification failed for chat ${chat.id}: ${err.message}`, 'error');
    }
  }
}

/**
 * 通过 ViewerWorker /running 端点检测 agent 运行状态变化。
 * 当 agent 从 running → idle 时，标记消息为 completed。
 * Agent 回复通过 GroupChatBridgeFeature 的 CallFinish piggyback 写回群聊。
 *
 * Phase 2: 同时轮询 ViewerWorker 的 todo plan，检测新完成的 task，
 * 向关联群聊推送 task_completed 事件。
 *
 * @param {string} chatId
 * @param {string} messageId
 * @param {string} workspaceId
 * @param {string} viewerAgentId
 * @param {{ identityRef: string, sessionId: string, sessionTitle: string, identityName: string }} [sessionInfo]
 */
function trackGroupChatDispatch(chatId, messageId, workspaceId, viewerAgentId, sessionInfo) {
  let wasRunning = false;
  const startTime = Date.now();
  const TIMEOUT_MS = GROUP_CHAT_CALL_TIMEOUT_MS;

  // Phase 2: task 完成检测状态
  const knownCompletedTaskIds = new Set();
  // 先把派发前已经完成的 Task 作为 baseline，避免同一线程再次派发时把旧完成项
  // 全部重新广播。轮询会等待 baseline 尝试结束；失败时仍可继续跟踪本轮变化。
  const taskBaselineReady = seedCompletedTaskBaseline(viewerAgentId, knownCompletedTaskIds);

  const interval = setInterval(async () => {
    // 超时保护
    if (Date.now() - startTime > TIMEOUT_MS) {
      clearInterval(interval);
      await updateMessageRouting(chatId, messageId, {
        status: 'failed',
        error: 'Agent call timeout (15min)',
        completedAt: Date.now(),
      });
      return;
    }

    try {
      // 检查 runtime 是否还活着
      const runtime = getAgentRuntime(workspaceId);
      if (!runtime || runtime.stopped || runtime.process?.exitCode !== null) {
        if (wasRunning) {
          // Agent 曾经运行过，现在进程已退出
          clearInterval(interval);
          await updateMessageRouting(chatId, messageId, {
            status: 'completed',
            completedAt: Date.now(),
          });
        }
        return;
      }

      // 检查 ViewerWorker 的 running 状态
      const currentViewerId = runtime.viewerAgentId || viewerAgentId;
      const res = await fetch(
        `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(currentViewerId)}/running`
      );
      if (!res.ok) return;
      const data = await res.json();
      const isRunning = data.running === true || data.callActive === true;

      if (isRunning) {
        wasRunning = true;

        // Phase 2: 轮询 todo plan，检测新完成的 task
        if (sessionInfo) {
          await taskBaselineReady;
          await pollTaskCompletion(chatId, currentViewerId, sessionInfo, knownCompletedTaskIds);
        }
      } else if (wasRunning) {
        // Agent 曾在运行，现在空闲 → 完成
        // 在清除 interval 前做最后一次 task 轮询（agent 刚结束，可能完成了最后一个 task）
        if (sessionInfo) {
          await taskBaselineReady;
          await pollTaskCompletion(chatId, currentViewerId, sessionInfo, knownCompletedTaskIds);
        }
        clearInterval(interval);
        await updateMessageRouting(chatId, messageId, {
          status: 'completed',
          completedAt: Date.now(),
        });
        log('GroupChat', `message ${messageId} completed`);
      }
    } catch {
      // 网络错误等，继续重试
    }
  }, 3000);
}

async function seedCompletedTaskBaseline(viewerAgentId, knownCompletedTaskIds) {
  if (!viewerAgentId) return;
  try {
    const res = await fetch(`${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/todo`);
    if (!res.ok) return;
    const todoPlan = await res.json();
    for (const task of (Array.isArray(todoPlan?.tasks) ? todoPlan.tasks : [])) {
      if (task.status === 'completed') knownCompletedTaskIds.add(String(task.id));
    }
  } catch {}
}

const _gcEventIdempotencyKeys = new Set();

async function appendUniqueGroupChatEvent(chatId, eventMessage) {
  const key = eventMessage?.event?.idempotencyKey;
  if (!key) {
    await appendGroupChatMessage(chatId, eventMessage);
    return true;
  }
  if (_gcEventIdempotencyKeys.has(key)) return false;
  const chat = await readGroupChat(chatId);
  if ((chat?.messages || []).some((message) => message?.event?.idempotencyKey === key)) {
    _gcEventIdempotencyKeys.add(key);
    return false;
  }
  // 单进程内先占位，避免两个并发 tracker 在文件写入前同时通过检查。
  _gcEventIdempotencyKeys.add(key);
  try {
    await appendGroupChatMessage(chatId, eventMessage);
    return true;
  } catch (error) {
    _gcEventIdempotencyKeys.delete(key);
    throw error;
  }
}

/**
 * Phase 2: 轮询 ViewerWorker 的 todo plan，检测新完成的 task。
 * 对每个新完成的 task，写入 task_completed 事件并通知管理员。
 *
 * @param {string} chatId
 * @param {string} viewerAgentId
 * @param {{ identityRef: string, sessionId: string, sessionTitle: string, identityName: string }} sessionInfo
 * @param {Set<string>} knownCompletedTaskIds — 已知已完成 task ID 集合（跨轮次保持）
 */
async function pollTaskCompletion(chatId, viewerAgentId, sessionInfo, knownCompletedTaskIds) {
  try {
    const res = await fetch(
      `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/todo`
    );
    if (!res.ok) return;
    const todoPlan = await res.json();
    const tasks = Array.isArray(todoPlan?.tasks) ? todoPlan.tasks : [];

    let owningThread = null;
    try {
      const chat = await readGroupChat(chatId);
      const allIdentities = await collectIdentities();
      const projected = await groupByLineage(
        aggregateSessionPool(chat, allIdentities),
        chat.sessionLineage,
        allIdentities,
        undefined,
        { activeSessions: chat.sessions, messages: chat.messages },
      );
      const candidates = projected.filter((thread) =>
        thread.identityRef === sessionInfo.identityRef
        && (thread.lineageHeadId === sessionInfo.sessionId
          || thread.lineage?.some((node) => node.sessionId === sessionInfo.sessionId))
      );
      owningThread = candidates.find((thread) => thread.lineageHeadId === sessionInfo.sessionId)
        || candidates.find((thread) => thread.isCurrent)
        || candidates[0]
        || null;
    } catch {}

    for (const task of tasks) {
      if (task.status !== 'completed') continue;
      const taskId = String(task.id);
      if (knownCompletedTaskIds.has(taskId)) continue;

      // 新完成的 task
      knownCompletedTaskIds.add(taskId);

      const eventMessage = {
        id: `evt-task-${Date.now()}-${taskId}-${Math.random().toString(36).slice(2, 6)}`,
        chatId,
        from: sessionInfo.identityRef,
        text: '',
        kind: 'event',
        event: {
          type: 'task_completed',
          identityRef: sessionInfo.identityRef,
          identityName: sessionInfo.identityName,
          threadRef: owningThread?.threadRef || null,
          threadTitle: owningThread?.threadTitle || sessionInfo.sessionTitle,
          sessionId: sessionInfo.sessionId,
          sessionTitle: sessionInfo.sessionTitle,
          taskId,
          taskTitle: task.subject || task.description || `Task #${taskId}`,
          idempotencyKey: `task_completed:${sessionInfo.sessionId}:${taskId}`,
          workspaceId: sessionInfo.identityRef.split(':')[0],
        },
        mentions: [],
        links: [],
        timestamp: Date.now(),
        routing: null,
      };

      const appended = await appendUniqueGroupChatEvent(chatId, eventMessage);
      if (appended) {
        log('GroupChat', `task_completed event: ${sessionInfo.identityName} completed "${eventMessage.event.taskTitle}"`);
      }
    }
  } catch {
    // 网络错误等，静默跳过
  }
}

// ── Group Chat CRUD API ────────────────────────────────────────────

app.get('/protoclaw/group_chats', async (_req, res, next) => {
  try {
    const chats = await listGroupChats();
    res.json({ chats });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/group_chats', express.json(), async (req, res, next) => {
  try {
    const { name, workDir, members } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!workDir) return res.status(400).json({ error: 'workDir required' });

    const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chat = {
      id: chatId,
      name,
      workDir: workDir || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      members: normalizeGroupChatMembers(members),
      messages: [],
      sessions: {},
      initiativeMode: 'assist',
      autonomyMode: 'auto',
      adminMemory: { range: '3d', limitMode: 'tokens', tokenLimit: ADMIN_DEFAULT_TOKEN_LIMIT, ratioLimit: ADMIN_DEFAULT_RATIO_LIMIT },
      lastActiveAt: {},
    };
    await writeGroupChat(chat);
    res.status(201).json(chat);
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/group_chats/:chatId', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

/**
 * Long-poll 端点：客户端传入 since（上次已知的 updatedAt 时间戳），
 * 服务端挂起响应直到有新更新或超时。
 * 返回 { updated: true, updatedAt, chat } 或 { updated: false, updatedAt }。
 */
app.get('/protoclaw/group_chats/:chatId/updates', async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const since = parseInt(req.query.since, 10) || 0;
    const timeoutMs = Math.min(Number(req.query.timeout) || LONG_POLL_DEFAULT_SEC, LONG_POLL_MAX_SEC) * 1000;

    // 先检查是否已有更新
    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    if ((chat.updatedAt || 0) > since) {
      return res.json({ updated: true, updatedAt: chat.updatedAt, chat });
    }

    // 无更新，注册 waiter
    let resolved = false;

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      _removeWaiter(chatId, resolve);
      res.json({ updated: false, updatedAt: chat.updatedAt || Date.now() });
    }, timeoutMs);

    function resolve() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      _removeWaiter(chatId, resolve);
      // 重新读取以获取最新数据
      readGroupChat(chatId).then((freshChat) => {
        if (freshChat) {
          res.json({ updated: true, updatedAt: freshChat.updatedAt || Date.now(), chat: freshChat });
        } else {
          res.json({ updated: false, updatedAt: Date.now() });
        }
      }).catch(() => {
        res.json({ updated: false, updatedAt: Date.now() });
      });
    }

    if (!_gcUpdateWaiters.has(chatId)) _gcUpdateWaiters.set(chatId, new Set());
    _gcUpdateWaiters.get(chatId).add(resolve);

    // 客户端断开连接时清理 waiter
    req.on('close', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      _removeWaiter(chatId, resolve);
    });
  } catch (error) {
    next(error);
  }
});

function _removeWaiter(chatId, resolve) {
  const waiters = _gcUpdateWaiters.get(chatId);
  if (!waiters) return;
  waiters.delete(resolve);
  if (waiters.size === 0) _gcUpdateWaiters.delete(chatId);
}

app.put('/protoclaw/group_chats/:chatId', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const { name, workDir, members, initiativeMode, autonomyMode, adminMemory, archived } = req.body || {};
    if (name !== undefined) chat.name = name;
    if (workDir !== undefined) chat.workDir = workDir || null;
    if (Array.isArray(members)) chat.members = normalizeGroupChatMembers(members);
    if (typeof initiativeMode === 'string') chat.initiativeMode = initiativeMode;
    if (typeof autonomyMode === 'string') chat.autonomyMode = autonomyMode;
    if (typeof archived === 'boolean') chat.archived = archived;
    if (adminMemory && typeof adminMemory === 'object') {
      const prev = chat.adminMemory || {};
      chat.adminMemory = {
        range: adminMemory.range || '3d',
        limitMode: adminMemory.limitMode || 'tokens',
        tokenLimit: typeof adminMemory.tokenLimit === 'number'
          ? adminMemory.tokenLimit
          : (typeof prev.tokenLimit === 'number' ? prev.tokenLimit
            : (typeof adminMemory.limitValue === 'number' ? adminMemory.limitValue
              : (typeof prev.limitValue === 'number' ? prev.limitValue : ADMIN_DEFAULT_TOKEN_LIMIT))),
        ratioLimit: typeof adminMemory.ratioLimit === 'number'
          ? adminMemory.ratioLimit
          : (typeof prev.ratioLimit === 'number' ? prev.ratioLimit : ADMIN_DEFAULT_RATIO_LIMIT),
      };
    }

    await writeGroupChat(chat);
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId', async (req, res, next) => {
  try {
    const deleted = await deleteGroupChatFile(req.params.chatId);
    if (!deleted) return res.status(404).json({ error: 'Group chat not found' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat GROUP.md API ────────────────────────────────────────
// GROUP.md 存放在群聊独立数据目录 group-chats/<chatId>/GROUP.md，
// 不依赖 workDir，避免同 workDir 多群聊共用污染。

function getGroupChatDataDir(chatId) {
  return path.join(GROUP_CHATS_ROOT, chatId);
}

app.get('/protoclaw/group_chats/:chatId/group_md', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const mdPath = path.join(getGroupChatDataDir(req.params.chatId), 'GROUP.md');
    try {
      const content = await fs.readFile(mdPath, 'utf-8');
      res.json({ content, exists: true });
    } catch {
      res.json({ content: '', exists: false });
    }
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/group_md', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });

    const dataDir = getGroupChatDataDir(req.params.chatId);
    await fs.mkdir(dataDir, { recursive: true });
    const mdPath = path.join(dataDir, 'GROUP.md');
    await fs.writeFile(mdPath, content, 'utf-8');
    res.json({ ok: true, path: mdPath });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Resources API ───────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/resources', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resources = [];

    // ── GROUP.md 虚拟条目（始终置顶） ──
    try {
      const mdPath = path.join(getGroupChatDataDir(req.params.chatId), 'GROUP.md');
      const mdContent = await fs.readFile(mdPath, 'utf-8');
      const mdStat = await fs.stat(mdPath);
      const previewLines = mdContent.split('\n').map(l => l.trim()).filter(l => l).slice(0, 3).join('\n');
      resources.push({
        name: 'GROUP.md',
        isGroupMd: true,
        size: mdStat.size,
        mtime: mdStat.mtimeMs,
        ext: 'md',
        preview: previewLines,
      });
    } catch {
      // GROUP.md 不存在时也显示虚拟条目（空内容）
      resources.push({
        name: 'GROUP.md',
        isGroupMd: true,
        size: 0,
        mtime: 0,
        ext: 'md',
        preview: '',
      });
    }

    // ── 资源文件 ──
    const resDir = getResourcesDir(chat);
    if (resDir) {
      try {
        await fs.mkdir(resDir, { recursive: true });
        const entries = await fs.readdir(resDir);
        for (const entry of entries) {
          const ext = path.extname(entry).toLowerCase();
          if (!RESOURCE_ALLOWED_EXTS.has(ext)) continue;
          try {
            const filePath = path.join(resDir, entry);
            const stat = await fs.stat(filePath);
            // 提取前两行非空内容作为预览
            let preview = '';
            try {
              const raw = await fs.readFile(filePath, 'utf-8');
              preview = raw.split('\n').map(l => l.trim()).filter(l => l).slice(0, 2).join('\n');
              if (preview.length > 200) preview = preview.slice(0, 200) + '...';
            } catch {}
            resources.push({
              name: entry,
              size: stat.size,
              mtime: stat.mtimeMs,
              ext: ext.slice(1),
              preview,
            });
          } catch {}
        }
      } catch {}
    }

    // 资源文件按 mtime 降序（GROUP.md 虚拟条目已在最前面，保持不动）
    const groupMdEntry = resources.shift();
    const fileEntries = resources.sort((a, b) => b.mtime - a.mtime);
    res.json({ resources: [groupMdEntry, ...fileEntries] });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/group_chats/:chatId/resources/:name', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const filePath = path.join(resDir, validation.name);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const stat = await fs.stat(filePath);
      res.json({ name: validation.name, content, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      res.status(404).json({ error: 'Resource not found' });
    }
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/resources/:name', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });

    await fs.mkdir(resDir, { recursive: true });
    const filePath = path.join(resDir, validation.name);
    await fs.writeFile(filePath, content, 'utf8');
    const stat = await fs.stat(filePath);
    res.json({ ok: true, name: validation.name, size: stat.size });
  } catch (error) {
    next(error);
  }
});

// ── 自动命名创建：POST /resources ──
// 服务端生成 note-MMDD-HHmm.md 格式的文件名，避免重名。
app.post('/protoclaw/group_chats/:chatId/resources', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    await fs.mkdir(resDir, { recursive: true });

    // 生成 note-MMDD-HHmm.md
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    let name = `note-${stamp}.md`;
    // 防止同一分钟内重名
    let suffix = 2;
    while (true) {
      try {
        await fs.access(path.join(resDir, name));
        name = `note-${stamp}-${suffix}.md`;
        suffix++;
      } catch {
        break;
      }
    }

    const content = (req.body && typeof req.body.content === 'string') ? req.body.content : '';
    const filePath = path.join(resDir, name);
    await fs.writeFile(filePath, content, 'utf8');
    const stat = await fs.stat(filePath);
    res.json({ ok: true, name, size: stat.size });
  } catch (error) {
    next(error);
  }
});

// ── 重命名：POST /resources/:name/rename ──
app.post('/protoclaw/group_chats/:chatId/resources/:name/rename', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const { newName } = req.body || {};
    const nameValidation = validateResourceName(newName);
    if (!nameValidation.ok) return res.status(400).json({ error: nameValidation.error });

    const oldPath = path.join(resDir, validation.name);
    const newPath = path.join(resDir, nameValidation.name);

    // 检查原文件存在
    try {
      await fs.access(oldPath);
    } catch {
      return res.status(404).json({ error: 'Resource not found' });
    }
    // 检查目标文件不存在（防止覆盖）
    try {
      await fs.access(newPath);
      return res.status(409).json({ error: 'A file with that name already exists' });
    } catch {
      // 目标不存在，可以重命名
    }

    await fs.rename(oldPath, newPath);
    res.json({ ok: true, oldName: validation.name, newName: nameValidation.name });
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId/resources/:name', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const filePath = path.join(resDir, validation.name);
    try {
      await fs.unlink(filePath);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'Resource not found' });
    }
  } catch (error) {
    next(error);
  }
});

// ── Group Chat WorkDir Scan API ─────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/workdir_scan', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });
    if (!chat.workDir) return res.json({ workDir: null, entries: [], keyFiles: {} });

    const workDir = chat.workDir;
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '__pycache__', '.next', 'build', '.svelte-kit', 'coverage', '.turbo', '.nuxt', 'target', 'vendor']);
    const KEY_FILE_NAMES = ['package.json', 'README.md', 'README', 'CLAUDE.md', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Makefile', 'docker-compose.yml', '.env.example', 'tsconfig.json', 'requirements.txt'];

    // Scan top-level directory
    const entries = [];
    const dirItems = await fs.readdir(workDir, { withFileTypes: true });
    for (const item of dirItems) {
      if (item.name.startsWith('.') && item.name !== '.env.example' && item.name !== '.agentdev') continue;
      if (IGNORE_DIRS.has(item.name)) continue;
      entries.push({
        type: item.isDirectory() ? 'dir' : 'file',
        name: item.name,
      });
    }

    // Read key files
    const keyFiles = {};
    for (const fname of KEY_FILE_NAMES) {
      const fpath = path.join(workDir, fname);
      try {
        const stat = await fs.stat(fpath);
        if (!stat.isFile()) continue;
        const raw = await fs.readFile(fpath, 'utf-8');
        // Truncate large files
        keyFiles[fname] = raw.length > 4000 ? raw.slice(0, 4000) + '\n...(truncated)' : raw;
      } catch {
        // File doesn't exist, skip
      }
    }

    // Also scan second-level directories (names only, for structure awareness)
    const subDirs = entries.filter(e => e.type === 'dir');
    for (const dir of subDirs) {
      const dirPath = path.join(workDir, dir.name);
      try {
        const subItems = await fs.readdir(dirPath, { withFileTypes: true });
        const subNames = subItems
          .filter(i => !i.name.startsWith('.') && !IGNORE_DIRS.has(i.name))
          .slice(0, 15)
          .map(i => `${i.isDirectory() ? '[D]' : '[F]'} ${i.name}`);
        if (subNames.length > 0) {
          entries.push({ type: 'subdir_listing', name: `${dir.name}/`, children: subNames });
        }
      } catch {
        // Permission denied or other error, skip
      }
    }

    res.json({ workDir, entries, keyFiles });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Messages API ────────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/messages', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    // 单条查询模式：按 messageId 返回完整消息（不截断）
    if (req.query.messageId) {
      const msg = (chat.messages || []).find((m) => m.id === req.query.messageId);
      if (!msg) return res.status(404).json({ error: 'Message not found' });
      return res.json({ message: msg });
    }

    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const messages = (chat.messages || []).slice(offset, offset + limit);

    res.json({
      messages,
      total: (chat.messages || []).length,
      offset,
      limit,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/group_chats/:chatId/messages', express.json(), async (req, res, next) => {
  try {
    const { text, mentions, links, from, kind, attachments, rejectDispatchId } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });

    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const messageFrom = from || 'user';

    const message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId: chat.id,
      from: messageFrom,
      text,
      mentions: Array.isArray(mentions) ? mentions : [],
      links: Array.isArray(links) ? links.filter((l) => l && l.url) : [],
      attachments: Array.isArray(attachments) ? attachments.filter((a) => a && a.name) : [],
      kind: kind || 'text',
      timestamp: Date.now(),
      routing: null,
    };

    // 任何带 mention 的消息都初始化 routing（user 和 admin 派发均可）
    if (message.mentions.length > 0) {
      const firstMention = message.mentions[0];
      const targetRef = firstMention.identityRef || null;
      // 防止 admin 向自己派发（反馈循环）
      if (targetRef && targetRef !== messageFrom) {
        message.routing = {
          status: 'pending',
          targetIdentityRef: targetRef,
          targetWorkspaceId: targetRef.split(':')[0] || null,
          targetSessionId: null,
          dispatchedAt: null,
          completedAt: null,
          error: null,
        };
      }
    }

    // 规划模式：管理员派发需要人工审批
    const isPlanModeAdminDispatch = message.routing
      && messageFrom === 'work-group:admin'
      && (chat.initiativeMode || 'assist') === 'plan';

    let resolvedSession = null;

    if (isPlanModeAdminDispatch) {
      message.kind = 'dispatch_pending';
      message.approval = { status: 'pending', createdAt: Date.now() };

      // 预解析会话，存入 routing 供前端展示目标会话信息
      const firstMention = message.mentions[0] || {};
      let sessionOptions = {};
      if (firstMention.targetSessionId) sessionOptions.targetSessionId = firstMention.targetSessionId;
      if (firstMention.forceNew) sessionOptions.forceNew = true;
      if (firstMention.title && typeof firstMention.title === 'string' && firstMention.title.trim()) sessionOptions.title = firstMention.title.trim();
      if (firstMention.openDirectory && typeof firstMention.openDirectory === 'string' && firstMention.openDirectory.trim()) sessionOptions.openDirectory = firstMention.openDirectory.trim();

      try {
        const targetRef = message.routing.targetIdentityRef;
        const allIdentities = await collectIdentities();
        const targetInfo = allIdentities.find((i) => i.identityRef === targetRef);
        const sessionModel = targetInfo?.sessionModel || 'persistent';
        // resolveOnly: 只查找已有会话，不创建新会话。
        // 如果被拒绝，不会留下空会话；如果被批准，approve 端点会正常创建。
        const pre = await resolveGroupChatSession(
          chat.id, targetRef, sessionModel, { ...sessionOptions, resolveOnly: true }
        );
        if (pre) {
          let preTitle = pre.sessionId;
          try {
            const wsId = targetRef.split(':')[0];
            const idx = await readSessionIndex(wsId);
            const rec = idx.sessions.find((s) => s.id === pre.sessionId);
            if (rec) preTitle = rec.title || rec.taskTitle || pre.sessionId;
          } catch {}
          message.routing.targetSessionId = pre.sessionId;
          message.routing.targetSessionTitle = preTitle;
          resolvedSession = { sessionId: pre.sessionId, sessionTitle: preTitle, isNew: pre.isNew };
        } else {
          // 无已有会话（将创建新会话），在卡片上显示提示
          message.routing.targetSessionId = null;
          message.routing.targetSessionTitle = '（新会话）';
        }
      } catch (resolveErr) {
        return res.status(400).json({ error: resolveErr.message || '会话解析失败' });
      }
    }

    await appendGroupChatMessage(chat.id, message);

    // 拒绝审批中的派发：用户发送了拒绝消息（含 rejectDispatchId）
    if (rejectDispatchId) {
      // 必须重新读取 chat：appendGroupChatMessage 写入的是另一份副本，
      // 直接用旧 chat 对象 writeGroupChat 会覆盖掉刚追加的新消息
      const freshChat = await readGroupChat(chat.id);
      const pendingMsg = freshChat.messages.find((m) => m.id === rejectDispatchId);
      if (pendingMsg && pendingMsg.approval?.status === 'pending') {
        pendingMsg.approval.status = 'rejected';
        pendingMsg.approval.rejectedBy = 'user';
        pendingMsg.approval.rejectedAt = Date.now();
        pendingMsg.approval.rejectMessageId = message.id;
        await writeGroupChat(freshChat);
        // 在消息上记录拒绝关联，供 dispatchGroupChatMessage 构造 systemNote
        message.rejectDispatchId = rejectDispatchId;
        log('GroupChat', `dispatch ${rejectDispatchId} rejected by user via message ${message.id}`);
      }
    }

    // 异步派发（不阻塞响应）——任何带 routing 的消息触发
    if (message.kind === 'dispatch_pending') {
      // 规划模式待审批：已在上方预解析会话，此处仅返回响应
      res.status(201).json({ ...message, resolvedSession, pendingApproval: true });
      return;
    }

    if (message.routing) {
      // sessionOptions 从 first mention 中提取（前端放在 mention 对象内发送）
      const firstMention = message.mentions[0] || {};
      let sessionOptions = {};
      if (firstMention.targetSessionId) sessionOptions.targetSessionId = firstMention.targetSessionId;
      if (firstMention.forceNew) sessionOptions.forceNew = true;
      if (firstMention.title && typeof firstMention.title === 'string' && firstMention.title.trim()) sessionOptions.title = firstMention.title.trim();
      if (firstMention.openDirectory && typeof firstMention.openDirectory === 'string' && firstMention.openDirectory.trim()) sessionOptions.openDirectory = firstMention.openDirectory.trim();

      // 管理员派发：同步预解析会话，返回 sessionId/title/isNew 供工具反馈
      if (messageFrom === 'work-group:admin') {
        try {
          const targetRef = message.routing.targetIdentityRef;
          const allIdentities = await collectIdentities();
          const targetInfo = allIdentities.find((i) => i.identityRef === targetRef);
          const sessionModel = targetInfo?.sessionModel || 'persistent';
          const { sessionId: preSid, isNew: preNew } = await resolveGroupChatSession(
            chat.id, targetRef, sessionModel, sessionOptions
          );
          // 查找会话标题
          let preTitle = preSid;
          try {
            const wsId = targetRef.split(':')[0];
            const idx = await readSessionIndex(wsId);
            const rec = idx.sessions.find((s) => s.id === preSid);
            if (rec) preTitle = rec.title || rec.taskTitle || preSid;
          } catch {}
          resolvedSession = { sessionId: preSid, sessionTitle: preTitle, isNew: preNew };
          // 覆盖 sessionOptions：用预解析的 sessionId 作为 targetSessionId，
          // 避免异步 dispatch 重复创建会话
          sessionOptions = { targetSessionId: preSid };
        } catch (resolveErr) {
          return res.status(400).json({ error: resolveErr.message || '会话解析失败' });
        }
      }

      if (message.rejectDispatchId) {
        log('GroupChat', `dispatching rejection message ${message.id} to admin (rejectDispatchId=${message.rejectDispatchId})`);
      }
      dispatchGroupChatMessage(chat.id, message, sessionOptions).catch((err) => {
        console.error(`[GroupChat] dispatch failed for ${message.id}:`, err);
      });
    } else if (['plan', 'execute'].includes(chat.initiativeMode || 'assist') && messageFrom !== 'work-group:admin') {
      // 规划/执行模式：观察所有非 admin 的非 @mention 消息
      notifyAdminForActivity(chat.id, message, chat).catch((err) => {
        log('GroupChat', `admin activity notify failed: ${err.message}`, 'warn');
      });
    }

    res.status(201).json(resolvedSession ? { ...message, resolvedSession } : message);
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Sessions API ────────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/sessions/:identityRef', async (req, res, next) => {
  try {
    const { chatId, identityRef } = req.params;
    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const workspaceId = identityRef.split(':')[0];
    const sessionModel = (await collectIdentities()).find((i) => i.identityRef === identityRef)?.sessionModel || 'persistent';
    const activeSessionId = chat.sessions?.[identityRef] || null;

    // 获取该 workspace 的全部会话
    const index = await readSessionIndex(workspaceId);

    // 群内会话：被 chat.sessions 映射引用的 session
    // 使用精确 identityRef 匹配（非 workspace 前缀），避免其他身份的 session 混入
    const chatSessionIds = new Set(
      Object.entries(chat.sessions || {})
        .filter(([ref]) => ref === identityRef)
        .map(([, sid]) => sid)
    );

    // 管理员：将历史 session（滚动前的旧 session）也纳入群内会话
    if (identityRef === 'work-group:admin' && Array.isArray(chat.adminSessionHistory)) {
      for (const sid of chat.adminSessionHistory) chatSessionIds.add(sid);
    }

    // 消息路由中出现的 session 也属于群内会话（覆盖 one-shot / 指定会话派发）
    for (const msg of (chat.messages || [])) {
      const r = msg.routing;
      if (r && r.targetIdentityRef === identityRef && r.targetSessionId) {
        chatSessionIds.add(r.targetSessionId);
      }
    }

    // 已引入的外部会话也属于群内会话池
    for (const imp of (chat.importedSessions || [])) {
      if (imp.workspaceId === workspaceId && imp.sessionId) {
        chatSessionIds.add(imp.sessionId);
      }
    }

    const inChatSessions = index.sessions
      .filter((s) => chatSessionIds.has(s.id))
      .map((s) => ({
        id: s.id,
        title: s.title || s.taskTitle || '未命名',
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || s.createdAt,
        isActive: s.id === activeSessionId,
      }));

    // 外部会话：不在群内映射中的会话（取最近 20 条）
    const externalSessions = index.sessions
      .filter((s) => !chatSessionIds.has(s.id))
      .slice(0, 20)
      .map((s) => ({
        id: s.id,
        title: s.title || s.taskTitle || '未命名',
        updatedAt: s.updatedAt || s.createdAt,
      }));

    res.json({
      identityRef,
      sessionModel,
      activeSessionId,
      inChatSessions,
      externalSessions,
    });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Admin Status API ─────────────────────────────────

/**
 * 计算管理员会话的健康状态。
 * 统一 healthRatio 语义：0 = 空，1.0 = 到达上限（触发滚动），>1.0 = 已超限。
 */
async function getAdminStatus(chatId) {
  const chat = await readGroupChat(chatId);
  if (!chat) return null;

  const identityRef = 'work-group:admin';
  const workspaceId = 'work-group';
  const sessionId = chat.sessions?.[identityRef] || null;

  if (!sessionId) {
    return {
      online: false,
      sessionId: null,
      sessionTitle: null,
      contextTokens: 0,
      contextLimit: null,
      limitMode: (chat.adminMemory?.limitMode || 'tokens'),
      tokenLimit: (chat.adminMemory?.tokenLimit ?? chat.adminMemory?.limitValue ?? ADMIN_DEFAULT_TOKEN_LIMIT),
      ratioLimit: (chat.adminMemory?.ratioLimit ?? ADMIN_DEFAULT_RATIO_LIMIT),
      healthRatio: 0,
      healthStatus: 'unknown',
    };
  }

  // 判断 runtime 是否存活
  const runtime = getAgentRuntime(workspaceId, sessionId);
  const online = !!(runtime?.process && runtime.process.exitCode === null && !runtime.stopped);

  // 获取上下文用量
  const { contextTokens, available } = await getSessionContextUsage(workspaceId, sessionId);

  // 获取 session 标题
  let sessionTitle = null;
  try {
    const index = await readSessionIndex(workspaceId);
    const record = index.sessions.find((s) => s.id === sessionId);
    sessionTitle = record?.title || record?.taskTitle || null;
  } catch { /* ignore */ }

  const mem = chat.adminMemory || { limitMode: 'tokens', tokenLimit: ADMIN_DEFAULT_TOKEN_LIMIT, ratioLimit: ADMIN_DEFAULT_RATIO_LIMIT };
  let healthRatio = 0;
  let contextLimit = null;

  if (mem.limitMode === 'ratio') {
    const ratioVal = mem.ratioLimit ?? mem.limitValue ?? ADMIN_DEFAULT_RATIO_LIMIT;
    const modelInfo = await resolveSessionModelInfo(workspaceId, 'default');
    const contextLength = modelInfo?.contextLength || ADMIN_DEFAULT_CONTEXT_LENGTH;
    contextLimit = Math.floor(contextLength * ratioVal / 100);
    if (available && contextLength > 0) {
      const actualRatio = contextTokens / contextLength;
      const limitRatio = ratioVal / 100;
      healthRatio = limitRatio > 0 ? actualRatio / limitRatio : 0;
    }
  } else {
    const tokenVal = mem.tokenLimit ?? mem.limitValue ?? ADMIN_DEFAULT_TOKEN_LIMIT;
    contextLimit = tokenVal;
    if (available && tokenVal > 0) {
      healthRatio = contextTokens / tokenVal;
    }
  }

  let healthStatus = 'healthy';
  if (!available || healthRatio === 0) {
    healthStatus = 'unknown';
  } else if (healthRatio >= 1.0) {
    healthStatus = 'critical';
  } else if (healthRatio >= 0.8) {
    healthStatus = 'warning';
  }

  return {
    online,
    sessionId,
    sessionTitle,
    contextTokens,
    contextLimit,
    limitMode: mem.limitMode || 'tokens',
    tokenLimit: mem.tokenLimit ?? mem.limitValue ?? ADMIN_DEFAULT_TOKEN_LIMIT,
    ratioLimit: mem.ratioLimit ?? ADMIN_DEFAULT_RATIO_LIMIT,
    healthRatio,
    healthStatus,
  };
}

app.get('/protoclaw/group_chats/:chatId/admin_status', async (req, res, next) => {
  try {
    const status = await getAdminStatus(req.params.chatId);
    if (!status) return res.status(404).json({ error: 'Group chat not found' });
    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/group_chats/:chatId/admin_restart', async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const identityRef = 'work-group:admin';

    // 整个 stop + create 流程在锁内完成，防止并发 dispatch 在 stop 后重启旧 runtime
    const { oldSessionId, newSessionId } = await withAdminSessionLock(chatId, async () => {
      const chat = await readGroupChat(chatId);
      if (!chat) throw new Error('Group chat not found');

      const oldSid = chat.sessions?.[identityRef] || null;

      // 1. 停止旧 runtime（如果存在）
      if (oldSid) {
        log('GroupChat', `admin restart: stopping old session ${oldSid}`);
        await stopManagedAgent('work-group', oldSid);
      }

      // 2. 强制新建 session（更新 chat.sessions 映射 + 记录历史）
      const result = await _resolveGroupChatSessionInner(
        chatId, identityRef, 'persistent', { forceNew: true }
      );
      log('GroupChat', `admin restart: created new session ${result.sessionId}`);

      // 3. 标记新 session 需要完整上下文初始化
      //    后续消息派发时 _resolveGroupChatSessionInner 检测到此标记，
      //    返回 isNew=true，触发 prepareAdminContext 完整注入
      const chatForMark = await readGroupChat(chatId);
      chatForMark.adminNeedsContextInit = result.sessionId;
      await writeGroupChat(chatForMark);

      return { oldSessionId: oldSid, newSessionId: result.sessionId };
    });

    // 3. 启动新 runtime（必须在锁外执行，ensureAdminRuntime 会等待 READY）
    if (newSessionId) {
      log('GroupChat', `admin restart: starting runtime for new session ${newSessionId}`);
      try {
        await ensureAdminRuntime(chatId, newSessionId);
      } catch (err) {
        log('GroupChat', `admin restart: runtime start failed: ${err.message}`, 'warn');
      }
    }

    // 4. 返回最新状态
    const status = await getAdminStatus(req.params.chatId);
    res.json({ ...status, restartedFromSession: oldSessionId });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Session Pool (External Import) API ─────────────────

/**
 * 跨所有 workspace 搜索会话，用于"引入到群聊会话池"。
 * 排除已引入的 session 和已在 chat.sessions 映射中的 session。
 */
app.get('/protoclaw/group_chats/:chatId/search_sessions', async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const q = (req.query.q || '').trim().toLowerCase();
    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    // 已在会话池中的 session ID 集合（包括 chat.sessions 映射和已引入的）
    const pooledIds = new Set([
      ...Object.values(chat.sessions || {}).filter(Boolean),
      ...(chat.importedSessions || []).map((s) => s.sessionId),
    ]);

    const agents = await discoverAgents(AGENTS_ROOT);
    const results = [];

    for (const agent of agents) {
      if (agent.enabled === false || agent.launchMode === 'ui-only') continue;
      // 只搜索当前有运行中 runtime 的 agent（排除 group chat 自身）
      if (agent.id === 'work-group') continue;
      const runtimes = listAgentRuntimes(agent.id);
      const hasRunning = runtimes.some((rt) => rt?.process && rt.process.exitCode === null && !rt.stopped);
      if (!hasRunning) continue;
      let index;
      try {
        index = await readSessionIndex(agent.id);
      } catch {
        continue;
      }

      for (const session of index.sessions) {
        if (session.archived) continue;
        if (pooledIds.has(session.id)) continue;

        const title = session.title || session.taskTitle || '未命名';
        const searchText = [title, session.goal, session.taskTitle]
          .filter(Boolean).join(' ').toLowerCase();

        // 无关键词时返回所有（前端限制数量）；有关键词时模糊匹配
        if (q && !searchText.includes(q)) continue;

        results.push({
          workspaceId: agent.id,
          workspaceName: agent.name || agent.id,
          sessionId: session.id,
          title,
          updatedAt: session.updatedAt || session.createdAt,
          sessionType: session.sessionType || null,
        });
      }
    }

    // 按更新时间降序
    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    res.json({ sessions: results.slice(0, 50) });
  } catch (error) {
    next(error);
  }
});

/**
 * 引入一个外部 session 到群聊会话池。
 */
app.post('/protoclaw/group_chats/:chatId/import_session', express.json(), async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const { workspaceId, sessionId } = req.body;
    if (!workspaceId || !sessionId) {
      return res.status(400).json({ error: 'workspaceId and sessionId are required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    // 验证 session 存在
    let sessionTitle = null;
    try {
      const index = await readSessionIndex(workspaceId);
      const record = index.sessions.find((s) => s.id === sessionId);
      if (!record) return res.status(404).json({ error: 'Session not found' });
      sessionTitle = record.title || record.taskTitle || '未命名';
    } catch {
      return res.status(404).json({ error: 'Session not found' });
    }

    // 初始化 importedSessions 数组
    if (!Array.isArray(chat.importedSessions)) chat.importedSessions = [];

    // 避免重复引入
    const exists = chat.importedSessions.find(
      (s) => s.workspaceId === workspaceId && s.sessionId === sessionId
    );
    if (exists) {
      return res.json({ imported: chat.importedSessions });
    }

    // 获取 workspace 名称
    const agents = await discoverAgents(AGENTS_ROOT);
    const agentInfo = agents.find((a) => a.id === workspaceId);

    chat.importedSessions.push({
      workspaceId,
      sessionId,
      title: sessionTitle,
      workspaceName: agentInfo?.name || workspaceId,
      importedAt: Date.now(),
    });

    await writeGroupChat(chat);
    log('GroupChat', `imported session ${sessionId} from ${workspaceId} into chat ${chatId}`);

    res.json({ imported: chat.importedSessions });
  } catch (error) {
    next(error);
  }
});

/**
 * 移除已引入的外部 session。
 */
app.delete('/protoclaw/group_chats/:chatId/import_session', express.json(), async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const { workspaceId, sessionId } = req.body;
    if (!workspaceId || !sessionId) {
      return res.status(400).json({ error: 'workspaceId and sessionId are required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    if (Array.isArray(chat.importedSessions)) {
      chat.importedSessions = chat.importedSessions.filter(
        (s) => !(s.workspaceId === workspaceId && s.sessionId === sessionId)
      );
      await writeGroupChat(chat);
    }

    res.json({ imported: chat.importedSessions || [] });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Annotations API ──────────────────────────────────

function _annotationsFilePath(chatId) {
  return path.join(GROUP_CHATS_ROOT, `${sanitizeSessionFragment(chatId)}.annotations.json`);
}

async function readAnnotations(chatId) {
  try {
    const raw = await fs.readFile(_annotationsFilePath(chatId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeAnnotations(chatId, annotations) {
  await ensureGroupChatsDir();
  await fs.writeFile(_annotationsFilePath(chatId), JSON.stringify(annotations, null, 2), 'utf8');
}

app.get('/protoclaw/group_chats/:chatId/annotations', async (req, res, next) => {
  try {
    const annotations = await readAnnotations(req.params.chatId);
    res.json({ annotations });
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/annotations/:messageId', express.json(), async (req, res, next) => {
  try {
    const { chatId, messageId } = req.params;
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const annotations = await readAnnotations(chatId);
    annotations[messageId] = {
      text: text.trim(),
      timestamp: Date.now(),
      author: 'user',
    };
    await writeAnnotations(chatId, annotations);
    res.json({ success: true, annotation: annotations[messageId] });
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId/annotations/:messageId', async (req, res, next) => {
  try {
    const { chatId, messageId } = req.params;
    const annotations = await readAnnotations(chatId);
    delete annotations[messageId];
    await writeAnnotations(chatId, annotations);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── End Group Chat API ─────────────────────────────────────────────

  // ── Startup Cleanup: 孤儿 routing 状态修复 ────────────────────────
  // Claw 重启后，所有 agent 子进程被杀，但群聊 JSON 中的 routing 仍可能为 'processing'。
  // 此函数扫描所有群聊，将 processing 状态但 agent 已不在线的消息标记为 failed。
  async function cleanupOrphanedRouting() {
    const summaries = await listGroupChats();
    let totalFixed = 0;

    for (const summary of summaries) {
      const chat = await readGroupChat(summary.id);
      if (!chat || !Array.isArray(chat.messages)) continue;

      let modified = false;
      for (const msg of chat.messages) {
        const r = msg.routing;
        if (!r || r.status !== 'processing') continue;

        const workspaceId = r.targetWorkspaceId;
        const sessionId = r.targetSessionId;
        const runtime = getAgentRuntime(workspaceId, sessionId);
        const alive = runtime?.process && runtime.process.exitCode === null && !runtime.stopped;

        if (!alive) {
          msg.routing.status = 'failed';
          msg.routing.failureReason = 'agent_unavailable_on_restart';
          modified = true;
          totalFixed++;
          log('GroupChat', `orphaned routing fixed: ${msg.id} in ${chat.id} (target: ${workspaceId}/${sessionId})`);
        }
      }

      if (modified) {
        await writeGroupChat(chat);
      }
    }

    if (totalFixed > 0) {
      log('GroupChat', `cleanupOrphanedRouting: fixed ${totalFixed} orphaned routing(s) across ${summaries.length} chat(s)`);
    }
  }

  // ── Agent Exit Callback ───────────────────────────────────────────
  // 当 agent 进程死亡时，检查群聊中是否有该 agent 处于 processing 状态的消息，
  // 写入离线事件 + 通知管理员，闭环群聊状态。
  if (onAgentExit) {
    onAgentExit(async (agentId, sessionId, exitCode, _runtimeKey) => {
      try {
        const allIdentities = await collectIdentities();
        const summaries = await listGroupChats();

        for (const summary of summaries) {
          const chat = await readGroupChat(summary.id);
          if (!chat || !Array.isArray(chat.messages)) continue;

          // 查找该 agent 在本群聊中处于 processing 状态的消息
          const pending = chat.messages.filter((m) => {
            const r = m.routing;
            if (!r || r.status !== 'processing') return false;
            if (r.targetWorkspaceId !== agentId) return false;
            if (sessionId && r.targetSessionId && r.targetSessionId !== sessionId) return false;
            return true;
          });

          if (pending.length === 0) continue;

          log('GroupChat', `agent ${agentId} (session ${sessionId}) exited with code ${exitCode}, ` +
            `closing ${pending.length} pending routing(s) in chat ${chat.id}`);

          // 找到受影响的 identity 信息
          const affectedRef = pending[0].routing?.targetIdentityRef;
          const identityInfo = allIdentities.find((i) => i.identityRef === affectedRef);
          const identityName = identityInfo?.displayName || agentId;
          const affectedSessionTitle = pending[0].routing?.targetSessionTitle || null;

          // 更新所有 pending 消息的 routing 状态
          for (const msg of pending) {
            msg.routing.status = 'failed';
            msg.routing.failureReason = 'agent_process_exit';
            msg.routing.exitCode = exitCode;
          }
          await writeGroupChat(chat);

          // 写入离线事件消息
          const eventMessage = {
            id: `evt-offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            chatId: chat.id,
            from: affectedRef,
            text: '',
            kind: 'event',
            event: {
              type: 'agent_offline',
              identityRef: affectedRef,
              identityName,
              sessionId,
              sessionTitle: affectedSessionTitle,
              workspaceId: agentId,
              exitCode,
            },
            mentions: [],
            links: [],
            timestamp: Date.now(),
            routing: null,
          };

          const updatedChat = await appendGroupChatMessage(chat.id, eventMessage);
          log('GroupChat', `event card appended: agent_offline for ${affectedRef} in ${chat.id}`);

          // plan 模式下通知管理员
          if (updatedChat && (updatedChat.initiativeMode || 'assist') === 'plan') {
            await notifyAdminForActivity(chat.id, eventMessage, updatedChat);
          }
        }
      } catch (e) {
        console.error('[group-chat] onAgentExit callback error:', e);
      }
    });
  }

  return { cleanupOrphanedRouting, notifySessionLineage, notifySessionArchived };
}
