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

import { createGroupChatDataLayer, getGroupChatsForSidebar } from './group-chat/data-layer.js';
export { createGroupChatDataLayer, getGroupChatsForSidebar };

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

// ── Extracted modules (Phase 2) ───────────────────────────────────
import { createSessionResolverModule } from './group-chat/session-resolver.js';
import { createDispatchCoreModule } from './group-chat/dispatch-core.js';
import { createAwarenessModule } from './group-chat/awareness.js';

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
  updateGroupChat,
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

// ── Phase 2 module initialization ────────────────────────────────
const sessionResolver = createSessionResolverModule({
  readGroupChat, writeGroupChat, collectIdentities, requireAgentLight,
  createPrebuiltSession, stopManagedAgent, startManagedAgent,
  waitForManagedRuntimeReady, getAgentRuntime, managedAgents,
});
const {
  withAdminSessionLock,
  resolveGroupChatSession,
  _resolveGroupChatSessionInner,
  resolveGroupChatSessionSync,
  readGroupChatSync,
  ensureAdminRuntime,
} = sessionResolver;

const awareness = createAwarenessModule({
  app,
  readGroupChat, collectIdentities, readViewerJson,
  getAgentRuntime, getManagedRuntimeKey, managedAgents,
});
const {
  getUsageContextTokens,
  getRuntimeExecSnapshot,
  buildGroupChatAwareness,
  readThreadHeadOperationalData,
  buildThreadSituation,
  findThreadByRef,
  formatAdminThreadSituation,
  getAdminStatus,
} = awareness;

const dispatchCore = createDispatchCoreModule({
  readGroupChat, writeGroupChat, appendGroupChatMessage, updateMessageRouting,
  listGroupChats, collectIdentities, requireAgentLight,
  getManagedRuntimeKey, getAgentRuntime, startManagedAgent,
  waitForManagedRuntimeReady, readAnnotations, enqueueGcInbox,
  resolveGroupChatSession, ensureAdminRuntime,
  buildThreadSituation, formatAdminThreadSituation,
});
const {
  prepareAdminContext,
  dispatchToIdentity,
  dispatchGroupChatMessage,
  notifyAdminWithPrompt,
  notifyAdminForObservation,
  notifyAdminForActivity,
  findChatsBySessionId,
  notifySessionLineage,
  notifySessionArchived,
  trackGroupChatDispatch,
  seedCompletedTaskBaseline,
  appendUniqueGroupChatEvent,
  pollTaskCompletion,
} = dispatchCore;

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

  // One runtime has one polling consumer. Replace an older waiter explicitly
  // so it cannot later delete or respond in place of this request.
  const previous = gcInboxPendingPolls.get(runtimeKey);
  previous?.cancel?.();

  let settled = false;
  let timer = null;
  const settle = (send) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (gcInboxPendingPolls.get(runtimeKey) === resolver) {
      gcInboxPendingPolls.delete(runtimeKey);
    }
    send?.();
  };
  const resolver = (msg) => settle(() => res.json(msg));
  resolver.cancel = () => settle(() => res.status(204).end());

  timer = setTimeout(() => settle(() => res.status(204).end()), timeoutMs);
  gcInboxPendingPolls.set(runtimeKey, resolver);

  req.once('close', () => settle());
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
