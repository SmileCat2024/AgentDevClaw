import { readSessionIndex } from '../../shared/session-access.js';

// ── Module-level exports (pure functions + data layer factory) ─────
// Extracted from setupGroupChatRoutes closures for direct unit testing.

/**
 * 规范化群聊成员列表。自动注入 user 和 work-group:admin。
 * @param {Array} members — 原始成员数组
 * @returns {Array} 规范化后的成员数组
 */
export function normalizeGroupChatMembers(members) {
  const result = [];
  const seen = new Set();
  const add = (member) => {
    const ref = member?.identityRef;
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    result.push(member);
  };
  add({ identityRef: 'user', role: 'human' });
  add({ identityRef: 'work-group:admin', role: 'admin' });
  if (Array.isArray(members)) {
    for (const member of members) {
      if (!member || member.identityRef === 'user' || member.identityRef === 'work-group:admin') continue;
      add({ identityRef: member.identityRef, role: member.role || 'agent' });
    }
  }
  return result;
}

/**
 * 组装派发 prompt（用户消息文本 + 参考链接）。
 * 群聊上下文已通过 contextText (system block) 独立注入，
 * 附件通过 attachments 字段独立传递，不再混入用户消息文本。
 * @param {object} message — { text, links }
 * @returns {string}
 */
export function composeDispatchPrompt(message) {
  const parts = [];
  parts.push(message.text || '');
  if (Array.isArray(message.links) && message.links.length > 0) {
    parts.push('\n参考链接：');
    for (const link of message.links) {
      const desc = link.description ? ` — ${link.description}` : '';
      parts.push(`- ${link.url}${desc}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * 聚合群聊会话池中的所有会话（3 个来源去重）。
 * 1. chat.sessions 映射（持久会话）
 * 2. chat.messages routing（派发会话）
 * 3. chat.importedSessions（导入的外部会话）
 *
 * 排除 work-group:admin 身份。
 * 去重 key = identityRef:sessionId。
 *
 * @param {object} chat — 群聊对象
 * @param {Array} identities — collectIdentities() 返回的身份列表
 * @returns {Array} 会话池数组
 */
export function aggregateSessionPool(chat, identities) {
  const identityDisplayName = (ref) => {
    const info = identities.find((i) => i.identityRef === ref);
    return info?.displayName || ref.split(':')[1] || ref;
  };

  const sessionMap = new Map();

  // Source 1: chat.sessions 映射（持久会话）
  for (const [identityRef, sessionId] of Object.entries(chat.sessions || {})) {
    if (identityRef === 'work-group:admin') continue;
    if (!sessionId) continue;
    const workspaceId = identityRef.split(':')[0];
    const key = `${identityRef}:${sessionId}`;
    sessionMap.set(key, {
      identityRef,
      sessionId,
      workspaceId,
      displayName: identityDisplayName(identityRef),
      lastActivity: 0,
    });
  }

  // Source 2: 消息路由（含已完成和 failed 会话——不再排除 failed，
  // 因为 routing.status 由旧版 trackGroupChatDispatch 维护，经常误标 failed，
  // 实际运行时状态以 runtime 查询结果为准）
  for (const msg of (chat.messages || [])) {
    const r = msg.routing;
    if (!r || !r.targetSessionId) continue;
    if (r.targetIdentityRef === 'work-group:admin') continue;
    const key = `${r.targetIdentityRef}:${r.targetSessionId}`;
    const existing = sessionMap.get(key);
    if (!existing || (msg.timestamp || 0) > (existing.lastActivity || 0)) {
      sessionMap.set(key, {
        identityRef: r.targetIdentityRef,
        sessionId: r.targetSessionId,
        workspaceId: r.targetWorkspaceId || r.targetIdentityRef.split(':')[0],
        displayName: identityDisplayName(r.targetIdentityRef),
        lastActivity: msg.timestamp || 0,
      });
    }
  }

  // Source 3: 导入的外部会话
  for (const imp of (chat.importedSessions || [])) {
    if (!imp.sessionId || !imp.workspaceId) continue;
    const memberIdentity = (chat.members || [])
      .find((m) => m.identityRef && m.identityRef.startsWith(imp.workspaceId + ':'));
    const identityRef = memberIdentity?.identityRef || `${imp.workspaceId}:main`;
    const key = `${identityRef}:${imp.sessionId}`;
    if (!sessionMap.has(key)) {
      sessionMap.set(key, {
        identityRef,
        sessionId: imp.sessionId,
        workspaceId: imp.workspaceId,
        displayName: imp.workspaceName || identityDisplayName(identityRef),
        lastActivity: imp.importedAt || 0,
      });
    }
  }

  return Array.from(sessionMap.values());
}

/**
 * Phase 3: 将扁平会话池按血缘关系聚合为工作线程。
 *
 * 血缘分组规则：
 * - trim/compact/summary 产生的后续 session → 同一条工作线程
 * - branch 产生的新 session → 新的工作线程
 *
 * 每个工作线程包含：
 * - lineage: 血缘链 [{ sessionId, sessionTitle, reason }]
 * - activeHeadId: 活跃头部 session ID
 * - identityRef: 归属身份
 * - phase: 推断的阶段（exploration / coding / possibly_done）
 *
 * @param {Array} sessionPool — aggregateSessionPool() 的返回值
 * @param {Array} lineageRecords — chat.sessionLineage
 * @param {Array} allIdentities — collectIdentities() 结果
 * @param {Function} readIndexFn — 异步读取 session index 的函数（可选，用于测试注入）
 * @returns {Promise<Array>} 工作线程列表
 */
export async function groupByLineage(sessionPool, lineageRecords, allIdentities, readIndexFn, context = {}) {
  const readIndex = readIndexFn || readSessionIndex;
  const lineage = Array.isArray(lineageRecords) ? lineageRecords : [];

  // 线程必须以血缘图为主数据源。后续 session 归档后可能已不在 sessionPool，
  // 但仍然是工作线程历史的一部分；同一个源节点也可能产生多个后续节点。
  const nodes = new Map();
  const outgoing = new Map();
  const incoming = new Map();
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const activeSessions = context.activeSessions || {};
  const archivedIds = new Set();
  const eventTitles = new Map();
  const transitionMeta = new Map();

  const ensureNode = (sessionId, identityRef = null) => {
    if (!sessionId) return null;
    if (!nodes.has(sessionId)) {
      nodes.set(sessionId, { sessionId, identityRef, pool: null, indexRecord: null });
    } else if (identityRef && !nodes.get(sessionId).identityRef) {
      nodes.get(sessionId).identityRef = identityRef;
    }
    return nodes.get(sessionId);
  };

  for (const session of (sessionPool || [])) {
    const node = ensureNode(session.sessionId, session.identityRef);
    if (node) node.pool = session;
  }

  for (const message of messages) {
    const event = message?.event;
    if (!event) continue;
    if (event.type === 'session_archived' && event.sessionId) archivedIds.add(event.sessionId);
    if (event.type === 'session_unarchived' && event.sessionId) archivedIds.delete(event.sessionId);
    if (event.type === 'session_continued' && event.archived === true && event.fromSessionId) {
      archivedIds.add(event.fromSessionId);
    }
    if (event.sessionId && event.sessionTitle) eventTitles.set(event.sessionId, event.sessionTitle);
    if (event.fromSessionId && event.fromSessionTitle) eventTitles.set(event.fromSessionId, event.fromSessionTitle);
    if (event.type === 'session_continued' && event.fromSessionId && event.toSessionId) {
      transitionMeta.set(`${event.fromSessionId}\u0000${event.toSessionId}`, {
        trimCutRounds: event.trimCutRounds ?? null,
        archived: event.archived === true,
        timestamp: event.timestamp || message.timestamp || 0,
      });
    }
  }

  for (const rec of lineage) {
    if (!rec?.from || !rec?.to) continue;
    const identityRef = rec.identityRef
      || nodes.get(rec.from)?.identityRef
      || nodes.get(rec.to)?.identityRef
      || null;
    ensureNode(rec.from, identityRef);
    ensureNode(rec.to, identityRef);
    const edgeKey = `${rec.from}\u0000${rec.to}`;
    const edge = {
      from: rec.from,
      to: rec.to,
      reason: rec.reason || 'unknown',
      timestamp: rec.timestamp || 0,
      ...(transitionMeta.get(edgeKey) || {}),
    };
    if (!outgoing.has(rec.from)) outgoing.set(rec.from, []);
    if (!outgoing.get(rec.from).some((item) => item.to === rec.to)) outgoing.get(rec.from).push(edge);
    if (!incoming.has(rec.to)) incoming.set(rec.to, []);
    if (!incoming.get(rec.to).some((item) => item.from === rec.from)) incoming.get(rec.to).push(edge);
  }

  // 同一历史节点可能先后产生多个后继。按时间稳定排序后，将第一条非 branch
  // 后继视为原线程的自然延续；branch 和其余后继均投影为新线程。
  // 这样线性 trim/summary 的 threadRef 在 head 前移后保持稳定，而旧节点再次
  // 派生不会抢走已有线程的身份。
  for (const edges of outgoing.values()) {
    edges.sort((left, right) =>
      (left.timestamp || 0) - (right.timestamp || 0)
      || String(left.to).localeCompare(String(right.to))
    );
  }

  // Session index 只负责补标题与“是否仍可打开”，不决定节点是否存在。
  const indexByWorkspace = new Map();
  const workspaceIds = new Set(
    [...nodes.values()]
      .map((node) => node.identityRef?.split(':')[0])
      .filter(Boolean)
  );
  await Promise.all([...workspaceIds].map(async (workspaceId) => {
    try { indexByWorkspace.set(workspaceId, await readIndex(workspaceId)); }
    catch { indexByWorkspace.set(workspaceId, null); }
  }));
  for (const node of nodes.values()) {
    const workspaceId = node.identityRef?.split(':')[0];
    node.indexRecord = indexByWorkspace.get(workspaceId)?.sessions?.find((item) => item.id === node.sessionId) || null;
    node.title = node.indexRecord?.title || node.indexRecord?.taskTitle || eventTitles.get(node.sessionId) || null;
    node.updatedAt = Math.max(
      node.pool?.lastActivity || 0,
      node.indexRecord?.updatedAt || node.indexRecord?.savedAt || node.indexRecord?.createdAt || 0
    );
  }

  const roots = [...nodes.values()].filter((node) => !incoming.has(node.sessionId));
  const paths = [];
  const walk = (node, nodePath, edgePath, visiting, threadAnchorId) => {
    if (!node || visiting.has(node.sessionId)) {
      if (nodePath.length) paths.push({ nodes: nodePath, edges: edgePath, threadAnchorId });
      return;
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(node.sessionId);
    const nextNodes = [...nodePath, node];
    const edges = outgoing.get(node.sessionId) || [];
    if (edges.length === 0) {
      paths.push({ nodes: nextNodes, edges: edgePath, threadAnchorId });
      return;
    }

    const continuations = edges.filter((edge) => edge.reason !== 'branch');
    const branches = edges.filter((edge) => edge.reason === 'branch');

    // 没有自然延续时，source 本身仍是一条可查看的原线程；branch 只增加新线程，
    // 不应让原线程从投影中消失。
    if (continuations.length === 0) {
      paths.push({ nodes: nextNodes, edges: edgePath, threadAnchorId });
    }

    continuations.forEach((edge, index) => {
      walk(
        nodes.get(edge.to),
        nextNodes,
        [...edgePath, edge],
        nextVisiting,
        index === 0 ? threadAnchorId : edge.to,
      );
    });
    for (const edge of branches) {
      walk(nodes.get(edge.to), nextNodes, [...edgePath, edge], nextVisiting, edge.to);
    }
  };
  for (const root of roots) walk(root, [], [], new Set(), root.sessionId);

  // 防御异常环或完全孤立的节点，保证每个已知 session 都能被投影。
  const covered = new Set(paths.flatMap((pathInfo) => pathInfo.nodes.map((node) => node.sessionId)));
  for (const node of nodes.values()) {
    if (!covered.has(node.sessionId)) paths.push({ nodes: [node], edges: [], threadAnchorId: node.sessionId });
  }

  // Session index 是归档状态的实时事实来源。群聊事件只在索引记录暂时不可读时兜底，
  // 避免一次 session_archived 事件让线程永久停留在归档区；从任意入口取消归档后，
  // 下一次线程投影都会立即恢复该 head。
  const nodeIsArchived = (node) => typeof node?.indexRecord?.archived === 'boolean'
    ? node.indexRecord.archived
    : archivedIds.has(node?.sessionId);

  const threads = paths.map(({ nodes: pathNodes, edges, threadAnchorId }) => {
    const head = pathNodes[pathNodes.length - 1];
    const threadAnchor = pathNodes.find((node) => node.sessionId === threadAnchorId) || pathNodes[0] || head;
    const identityRef = head.identityRef || pathNodes.find((node) => node.identityRef)?.identityRef || 'unknown:main';
    const workspaceId = identityRef.split(':')[0];
    const identityInfo = allIdentities.find((item) => item.identityRef === identityRef);
    const isCurrent = activeSessions[identityRef] === head.sessionId;
    const isArchived = nodeIsArchived(head);
    const headAvailable = Boolean(head.indexRecord) && !isArchived;
    const lifecycle = isArchived ? 'archived' : isCurrent ? 'current' : headAvailable ? 'available' : 'missing';
    const chain = pathNodes.map((node, index) => {
      const edge = index > 0 ? edges[index - 1] : null;
      return {
        sessionId: node.sessionId,
        sessionTitle: node.title,
        identityRef: node.identityRef || identityRef,
        reason: edge?.reason || null,
        transition: edge ? {
          reason: edge.reason,
          trimCutRounds: edge.trimCutRounds ?? null,
          archived: edge.archived === true,
          timestamp: edge.timestamp || 0,
        } : null,
        isCurrent: activeSessions[identityRef] === node.sessionId,
        isArchived: nodeIsArchived(node),
        isAvailable: Boolean(node.indexRecord) && !nodeIsArchived(node),
        updatedAt: node.updatedAt || 0,
      };
    });
    const updatedAt = Math.max(
      ...pathNodes.map((node) => node.updatedAt || 0),
      ...edges.map((edge) => edge.timestamp || 0),
      0
    );
    return {
      threadRef: `${identityRef}::${threadAnchorId || pathNodes[0]?.sessionId || head.sessionId}`,
      identityRef,
      identityName: identityInfo?.displayName || identityRef,
      workspaceId,
      threadTitle: threadAnchor?.title || head.title || null,
      activeHeadId: head.sessionId, // 兼容旧消费方；语义是 lineage head，不等同于正在运行。
      activeHeadTitle: head.title,
      lineageHeadId: head.sessionId,
      lineageDepth: chain.length,
      lineage: chain,
      phase: inferThreadPhase(chain, lineage),
      lifecycle,
      isCurrent,
      isArchived,
      canDispatch: headAvailable,
      updatedAt,
    };
  });

  const lifecycleRank = { current: 0, available: 1, archived: 2, missing: 3 };
  return threads.sort((a, b) =>
    (lifecycleRank[a.lifecycle] ?? 9) - (lifecycleRank[b.lifecycle] ?? 9)
    || (b.updatedAt || 0) - (a.updatedAt || 0)
  );
}

/**
 * 线程分类只表达当前执行是否结束，不再由 Task 完成度推断。
 * Task 是线程内部的进度信息；取消 Task 也不会让已结束的线程滞留在进行中。
 */
export function deriveThreadWorkStatus(thread, taskSummary, runtimeStatus) {
  if (thread?.lifecycle === 'archived') return 'archived';
  if (runtimeStatus === 'running' || runtimeStatus === 'queued') return 'active';
  if (['pending', 'delivered', 'processing'].includes(thread?.latestRoutingStatus)) return 'active';
  return 'completed';
}

/** Task 的终态包括完成和取消；二者都表示无需继续执行该 Task。 */
export function buildThreadTaskSummary(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const completed = list.filter((task) => task.status === 'completed').length;
  const cancelled = list.filter((task) => ['deleted', 'cancelled', 'canceled'].includes(task.status)).length;
  return {
    total: list.length,
    completed,
    cancelled,
    resolved: completed + cancelled,
    inProgress: list.filter((task) => task.status === 'in_progress').length,
    pending: list.filter((task) => task.status === 'pending').length,
  };
}

/** 将 session 持久化用量投影为与会话列表一致的上下文占用口径。 */
export function buildSessionContextUsage(session, sessionRecord) {
  const usageStats = session?.runtime?.usageStats || {};
  const lastRequestUsage = usageStats.lastRequestUsage || null;
  const totalUsage = usageStats.totalUsage || null;
  const contextLength = Number.isFinite(sessionRecord?.contextLength) && sessionRecord.contextLength > 0
    ? sessionRecord.contextLength
    : 200000;
  const compressRatio = Number.isFinite(sessionRecord?.compressRatio) && sessionRecord.compressRatio > 0
    ? sessionRecord.compressRatio
    : 80;
  const usedTokens = lastRequestUsage?.inputTokens || totalUsage?.totalTokens || 0;
  return {
    usedTokens,
    contextLength,
    compressRatio,
    percent: contextLength > 0 ? Math.min(100, Math.round((usedTokens / contextLength) * 100)) : 0,
    modelName: sessionRecord?.modelName || '',
    source: lastRequestUsage ? 'last_request' : totalUsage ? 'cumulative' : 'none',
  };
}

/** 从持久化上下文中提取最近一条适合在线程卡片展示的对话消息。 */
export function buildSessionLatestMessage(session, sessionRecord = null) {
  const messages = Array.isArray(session?.runtime?.context?.messages)
    ? session.runtime.context.messages
    : [];
  const readText = (content) => {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n');
  };

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!['user', 'assistant'].includes(message?.role)) continue;
    const text = readText(message.content);
    if (!text) continue;
    return {
      role: message.role,
      text: text.length > 1200 ? `${text.slice(0, 1200).trimEnd()}…` : text,
      turn: Number.isFinite(message.turn) ? message.turn : null,
      timestamp: Number(message.timestamp || message.createdAt || message.updatedAt || sessionRecord?.updatedAt || sessionRecord?.savedAt || 0) || null,
    };
  }
  return null;
}

/**
 * 推断工作线程的阶段。
 *
 * 规则（基于设计文档 3.2 节）：
 * - lineage 中有 trim/compact/summary → 至少进入过编码阶段
 * - lineage 全是 branch → 探索阶段
 * - 无法判断 → unknown
 */
function inferThreadPhase(chain, lineageRecords) {
  const reasons = chain
    .map((link) => link.reason)
    .filter((r) => r && r !== 'unknown');

  if (reasons.length === 0) return 'exploration';

  const hasContextManagement = reasons.some((r) => ['trim', 'compact', 'summary'].includes(r));
  if (hasContextManagement) return 'coding';

  return 'exploration';
}
