import path from 'node:path';
import { promises as fs } from 'node:fs';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeId(value) {
  const id = clean(value);
  return id && /^[A-Za-z0-9._-]+$/.test(id) ? id : '';
}

function timestampAt(enriched, index) {
  const value = enriched?.[index]?.timestamp;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function messageContentText(message) {
  if (typeof message?.content === 'string') return message.content;
  return JSON.stringify(message?.content ?? '');
}

function sameMessage(a, b) {
  if (!a || !b) return false;
  if (clean(a.role) !== clean(b.role)) return false;
  if (typeof a.content === 'string' || typeof b.content === 'string') {
    return a.content === b.content;
  }
  return JSON.stringify(a.content) === JSON.stringify(b.content);
}

/** 种子起点的搜索窗口：runtime 前置注入（身份提示/reminder）条数有限，超出即视为账目失配。 */
const SEED_LOCATE_WINDOW = 32;

/**
 * 按接续账目切分一代消息（账目驱动，零内容比对去重）。
 *
 * 权威数据链：会话索引 metadata.handoffId → handoff 包 seedMessages /
 * seedBoundary。种子区段在快照中不固定从 0 开始（前面有 runtime 前置注入），
 * 用 seedMessages 首尾两条在头部小窗口内锚定起点，其余区间全部由账目
 * （seedMessageCount / appendedInjection）确定；锚定失败按 boundary=unknown
 * 如实报告，不做内容级判重。
 */
export function segmentGeneration(record) {
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const handoff = record.handoff || null;
  const base = { boundary: 'unknown', offset: 0, seedEnd: 0, replayCount: 0, injections: [], notes: [] };

  if (!handoff) return { ...base, notes: ['handoff-missing'] };

  const seed = Array.isArray(handoff.seedMessages) ? handoff.seedMessages : [];
  if (!seed.length) return { ...base, notes: ['seed-empty'] };

  let offset = -1;
  const windowEnd = Math.min(messages.length, SEED_LOCATE_WINDOW);
  for (let i = 0; i < windowEnd; i++) {
    if (sameMessage(messages[i], seed[0])) { offset = i; break; }
  }
  const tailMatched = offset >= 0
    && offset + seed.length <= messages.length
    && sameMessage(messages[offset + seed.length - 1], seed[seed.length - 1]);
  if (!tailMatched) return { ...base, notes: ['seed-not-located'] };

  const seedEnd = offset + seed.length;
  const injections = [];
  const notes = [];
  if (clean(handoff.seedKind) === 'summary-message') {
    // 纯 summary 接续：种子即摘要（无重放前缀），整段按注入呈现。
    for (let i = offset; i < seedEnd; i++) injections.push({ messageIndex: i, injectionKind: 'summary' });
  } else {
    const declared = Array.isArray(handoff.seedBoundary?.appendedInjection)
      ? handoff.seedBoundary.appendedInjection
      : null;
    if (!declared) {
      notes.push('injection-undeclared');
    } else {
      for (const item of declared) {
        const idx = offset + Number(item?.messageIndex);
        if (Number.isInteger(idx) && idx >= offset && idx < seedEnd) {
          injections.push({ messageIndex: idx, injectionKind: clean(item?.kind) || 'injection' });
        }
      }
    }
  }
  return {
    boundary: 'accounted',
    offset,
    seedEnd,
    replayCount: seed.length - injections.length,
    injections,
    notes,
  };
}

/** Build a read-only chronological projection segmented by handoff accounts. */
export function projectThreadTranscript(thread, records) {
  const events = [];
  let previousSession = null;

  for (const record of records) {
    const sessionId = clean(record.sessionId);
    if (record.unavailable) {
      events.push({ kind: 'generation-unavailable', sessionId, reason: record.unavailable });
      previousSession = record;
      continue;
    }
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const timestamps = Array.isArray(record.timestamps) ? record.timestamps : [];
    const seg = segmentGeneration(record);
    const newFrom = seg.boundary === 'accounted' ? seg.seedEnd : 0;
    const injectionByIndex = new Map(seg.injections.map((inj) => [inj.messageIndex, inj.injectionKind]));

    if (previousSession) {
      events.push({
        kind: 'succession',
        fromSessionId: clean(previousSession.sessionId),
        toSessionId: sessionId,
        endKind: previousSession.endKind || 'unknown',
        at: previousSession.endedAt ?? null,
      });
    }
    events.push({
      kind: 'generation-header',
      sessionId,
      title: clean(record.title),
      endKind: record.endKind || null,
      startedAt: record.startedAt ?? null,
      endedAt: record.endedAt ?? null,
      messageCount: messages.length,
      newCount: messages.length - newFrom,
      replayCount: seg.boundary === 'accounted' ? seg.replayCount : 0,
      boundary: previousSession ? seg.boundary : 'first',
      notes: previousSession ? seg.notes : [],
    });
    if (seg.boundary === 'accounted' && seg.replayCount > 0) {
      events.push({
        kind: 'replay',
        sessionId,
        count: seg.replayCount,
        fromMessageIndex: seg.offset,
        toMessageIndex: seg.seedEnd,
      });
    }
    if (seg.boundary === 'accounted') {
      for (const inj of seg.injections) {
        const message = messages[inj.messageIndex] || {};
        events.push({
          kind: 'injection',
          injectionKind: inj.injectionKind,
          content: messageContentText(message),
          source: {
            sessionId,
            turn: Number.isFinite(message.turn) ? message.turn : null,
            messageIndex: inj.messageIndex,
          },
        });
      }
    }
    for (let index = newFrom; index < messages.length; index++) {
      const message = messages[index] || {};
      if (injectionByIndex.has(index)) continue;
      events.push({
        kind: 'message',
        role: clean(message.role) || 'unknown',
        content: messageContentText(message),
        toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls : [],
        toolCallId: clean(message.toolCallId) || null,
        timestamp: timestamps[index] ?? null,
        source: {
          sessionId,
          turn: Number.isFinite(message.turn) ? message.turn : null,
          messageIndex: index,
        },
      });
    }
    previousSession = record;
  }

  return {
    threadId: clean(thread.threadId),
    agentId: clean(thread.agentId),
    title: clean(records.at(-1)?.title) || clean(thread.title),
    events,
    generations: records.map((record) => ({
      sessionId: record.sessionId,
      title: record.title || '',
      endKind: record.endKind || null,
      startedAt: record.startedAt ?? null,
      endedAt: record.endedAt ?? null,
    })),
  };
}

/**
 * Install the read-only thread transcript endpoint.
 *
 * 接续账目读取链：会话索引（SQLite index.db）record.metadata.handoffId →
 * readHandoff 注入函数取 handoff 包；第一代与无账目的代不读包。
 */
export function setupThreadTranscriptRoute(app, { threadsRoot, getSessionFilePath, readSessionIndex, readHandoff }) {
  app.get('/protoclaw/thread_transcript', async (req, res, next) => {
    try {
      const threadId = safeId(req.query.threadId);
      if (!threadId || !threadsRoot || typeof getSessionFilePath !== 'function') {
        res.status(400).json({ error: 'threadId is required' });
        return;
      }
      const threadPath = path.join(threadsRoot, 'threads', `${threadId}.json`);
      let thread;
      try {
        thread = JSON.parse(await fs.readFile(threadPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          res.status(404).json({ error: `thread not found: ${threadId}` });
          return;
        }
        throw error;
      }
      const agentId = safeId(thread.agentId);
      const chain = Array.isArray(thread.sessionChain) ? thread.sessionChain : [];
      const indexData = typeof readSessionIndex === 'function'
        ? await readSessionIndex(agentId).catch(() => null)
        : null;
      const infoById = new Map(
        (Array.isArray(indexData?.sessions) ? indexData.sessions : [])
          .map((entry) => [entry?.id, entry]),
      );

      const records = [];
      for (let genIndex = 0; genIndex < chain.length; genIndex++) {
        const member = chain[genIndex];
        const sessionId = safeId(member?.sessionId);
        if (!sessionId) continue;
        const info = infoById.get(sessionId) || {};
        const metadata = info?.metadata && typeof info.metadata === 'object' ? info.metadata : {};
        const base = {
          sessionId,
          title: clean(info?.title),
          endKind: member.endKind || null,
          startedAt: member.startedAt ?? null,
          endedAt: member.endedAt ?? null,
        };
        let handoff = null;
        if (genIndex > 0 && typeof readHandoff === 'function') {
          const handoffId = clean(metadata.handoffId);
          if (handoffId) handoff = await readHandoff(agentId, handoffId);
        }
        try {
          const snapshot = JSON.parse(await fs.readFile(getSessionFilePath(agentId, sessionId), 'utf8'));
          const context = snapshot?.runtime?.context || {};
          const messages = Array.isArray(context.messages) ? context.messages : [];
          const enriched = Array.isArray(context.enrichedMessages) ? context.enrichedMessages : [];
          records.push({
            ...base,
            handoff,
            messages: messages.map((message) => ({
              ...message,
              content: messageContentText(message),
            })),
            timestamps: messages.map((_, index) => timestampAt(enriched, index)),
          });
        } catch (error) {
          records.push({
            ...base,
            unavailable: error?.code === 'ENOENT' ? 'session_missing' : 'session_unreadable',
            messages: [],
            timestamps: [],
          });
        }
      }
      res.json(projectThreadTranscript(thread, records));
    } catch (error) {
      next(error);
    }
  });
}
