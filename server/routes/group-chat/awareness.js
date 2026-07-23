// awareness.js — created by Phase 2 extraction
import { promises as fs } from 'fs';

import { cleanSessionText, log } from '../../shared/string-helpers.js';
import { readSessionIndex, readSessionIndexSync, getPrebuiltSessionFilePath } from '../../shared/session-access.js';
import { resolveSessionModelInfo } from '../model-config.js';
import { getRuntimeExecutionState } from '../../runtime-call-envelope.js';
import {
  aggregateSessionPool,
  groupByLineage,
  deriveThreadWorkStatus,
  buildThreadTaskSummary,
  buildSessionContextUsage,
  buildSessionLatestMessage,
} from './pure-functions.js';
import { getSessionContextUsage } from './format-helpers.js';

const ADMIN_DEFAULT_TOKEN_LIMIT = 200000;
const ADMIN_DEFAULT_RATIO_LIMIT = 20;
const ADMIN_DEFAULT_CONTEXT_LENGTH = 200000;

export function createAwarenessModule(deps) {
  const {
    readGroupChat,
    collectIdentities,
    readViewerJson,
    getAgentRuntime,
    getManagedRuntimeKey,
    managedAgents,
  } = deps;

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

  return {
    getUsageContextTokens,
    getRuntimeExecSnapshot,
    buildGroupChatAwareness,
    readThreadHeadOperationalData,
    buildThreadSituation,
    findThreadByRef,
    formatAdminThreadSituation,
    getAdminStatus,
  };
}
