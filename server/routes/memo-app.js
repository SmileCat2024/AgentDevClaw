/**
 * Memo App — 备忘录 APP 型工作空间的业务状态与对话事务
 *
 * ADR-0024 决策 1/2：「唯一活动对话」是 memo 的产品业务状态，由 APP 装配层
 * 持有（qqbot 接线员会话 receptionistSessionId 的先例同构），不放进通用线程
 * 设施。本模块是 memo 活动引用的权威持有方：
 *
 * - 状态文件 workspaces/memo/app-state.json：{ activeThreadId }（线程记录本体
 *   在全局 threads/ 目录，这里只持有「活动引用」）；
 * - start 事务：有活动线程且存活 → 唤起其 head runtime 复用；否则新建
 *   会话 → 拉起 runtime → 宿主钩子自动建线程 → 写引用（空态等首条消息的
 *   会话创建由本事务触发，首条消息本身走 /threads/:id/input）；
 * - new 事务：先完成新建与引用切换，再 best-effort 归档旧线程
 *   （lifecycle.archiveThread 归档即打断收纳）。失败模式是「多一条未归档
 *   旧线程」（可对账收敛），绝不出现「丢了活动对话」——归档不可逆，把
 *   它放在链路最后一段是刻意的。
 *
 * 创建链失败回滚与 ACP 原子创建同构（stop runtime → 线程删除事务级联 →
 * 悬引用清理）。start/new 经同一把 in-flight 互斥串行——并发防重写在
 * 业务状态的权威写入处（ADR-0024 决策 2），不靠「查一条线程再创建」。
 */

import path from 'path';
import { promises as fs } from 'fs';
import { getPrebuiltWorkspaceDir } from '../shared/session-access.js';
import { readJson, ensureDir } from '../shared/fs-helpers.js';
import { listMemoNotes, readMemoNote, writeMemoNote, sanitizeMemoFilename } from '../shared/memo-notes.js';
import { resolveSessionViewerAgentId } from './acp.js';

const MEMO_AGENT_ID = 'memo';
const RUNTIME_READY_TIMEOUT_MS = 20000;
const STATE_FILE = path.join(getPrebuiltWorkspaceDir(MEMO_AGENT_ID), 'app-state.json');
// 便签存储：workspaces/memo/notes/（一便签一篇 md，无索引文件）。
// 工具面（增删改查）在 runtime 侧 local-features/memo-notes，两处同域。
const NOTES_DIR = path.join(getPrebuiltWorkspaceDir(MEMO_AGENT_ID), 'notes');

function memoError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function readMemoState() {
  const state = await readJson(STATE_FILE).catch(() => null);
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

async function writeMemoState(next) {
  await ensureDir(path.dirname(STATE_FILE));
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
}

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} deps 宿主注入（与 ACP / thread 路由同一批装配能力）
 */
export function setupMemoAppRoutes(app, express, {
  requireAgentLight,
  createPrebuiltSession,
  deletePrebuiltSession,
  startManagedAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
  threadControl,
  threadIntegration,
  threadLifecycle,
  threadDelete,
} = {}) {
  /** start/new 共用的串行锁：同一时刻至多一个对话事务在改写活动引用。 */
  let inFlight = null;
  async function serialized(task) {
    const previous = inFlight || Promise.resolve();
    const run = previous.then(task, task);
    inFlight = run.finally(() => {
      if (inFlight === run) inFlight = null;
    });
    return inFlight;
  }

  /** 活动引用 → 存活线程（含 head 会话）；悬空（删除/关闭/归档）返回 null。 */
  async function resolveActiveThread() {
    const { activeThreadId } = await readMemoState();
    const threadId = String(activeThreadId || '').trim();
    if (!threadId) return null;
    const thread = await threadControl.core.getThread(threadId).catch(() => null);
    if (!thread || thread.status === 'closed') return null;
    if (await threadControl.archive.isArchived(threadId).catch(() => false)) return null;
    return thread;
  }

  /** 新建一段对话：会话 → runtime → 宿主钩子建线程 → ready 对账 → 写引用。 */
  async function createConversation() {
    const agent = await requireAgentLight(MEMO_AGENT_ID);
    const state = { session: null, runtimeStartAttempted: false };
    try {
      const session = await createPrebuiltSession(MEMO_AGENT_ID, {
        title: '跟 Memo 说',
        returnSummary: false,
      });
      state.session = session;

      state.runtimeStartAttempted = true;
      await startManagedAgent(agent, session.id);

      // 线程宿主钩子：memo 的会话自动成为新线程初始 head（声明化判定）。
      await threadIntegration.onSessionCreated(MEMO_AGENT_ID, session);

      const ready = await waitForManagedRuntimeReady(MEMO_AGENT_ID, RUNTIME_READY_TIMEOUT_MS, session.id);
      if (!ready) {
        throw memoError(504, 'runtime_ready_timeout',
          `memo runtime not READY within ${RUNTIME_READY_TIMEOUT_MS}ms (session=${session.id})`);
      }

      const viewerAgentId = resolveSessionViewerAgentId(MEMO_AGENT_ID, session.id);
      if (!viewerAgentId) {
        throw memoError(500, 'viewer_agent_missing',
          `READY runtime has no viewerAgentId (session=${session.id})`);
      }

      const thread = await threadControl.core.findThreadByHeadSession(MEMO_AGENT_ID, session.id);
      if (!thread) {
        throw memoError(500, 'thread_missing',
          `session created but no thread anchor holds it as head (session=${session.id})`);
      }

      await writeMemoState({ activeThreadId: thread.threadId });
      return {
        created: true,
        threadId: thread.threadId,
        sessionId: session.id,
        viewerAgentId,
      };
    } catch (error) {
      await rollbackConversationCreation(state).catch((rollbackError) => {
        console.error('[memo-app] rollback failed:', rollbackError?.message || rollbackError);
      });
      throw error;
    }
  }

  /** 创建链回滚（ACP 原子创建同构）：stop runtime → 线程级联删 → 清悬引用。 */
  async function rollbackConversationCreation(state) {
    const sessionId = state.session?.id;
    if (!sessionId) return;
    if (state.runtimeStartAttempted) {
      await stopManagedAgent(MEMO_AGENT_ID, sessionId).catch(() => {});
    }
    const thread = await threadControl.core
      .findThreadByHeadSession(MEMO_AGENT_ID, sessionId).catch(() => null);
    if (thread) {
      const result = await threadDelete.deleteThread(thread.threadId, {
        reason: 'memo_conversation_creation_rollback',
      });
      if (result.status !== 'complete') {
        console.warn(`[memo-app] rollback thread delete partial: ${thread.threadId}`);
      }
      return;
    }
    await deletePrebuiltSession(MEMO_AGENT_ID, sessionId, { includeSessions: false }).catch(() => {});
  }

  /** 对话事实响应（thread 头部 + head 会话 + 投递目标）。 */
  const _conversationPayload = async (conversation) => ({
    ok: true,
    ...conversation,
    thread: await threadControl.core.getThread(conversation.threadId).catch(() => null),
  });

  app.get('/protoclaw/memo-app/state', async (_req, res, next) => {
    try {
      const thread = await resolveActiveThread();
      res.json({
        ok: true,
        activeThread: thread
          ? {
            threadId: thread.threadId,
            agentId: thread.agentId,
            headSessionId: thread.headSessionId,
            title: thread.title || '',
            status: thread.status,
            viewerAgentId: resolveSessionViewerAgentId(thread.agentId, thread.headSessionId) || null,
          }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  /** 便签墙数据面：不带 filename 列索引，带 filename 读单篇全文（查看 overlay）。 */
  app.get('/protoclaw/memo-app/notes', async (req, res, next) => {
    try {
      const filename = typeof req.query.filename === 'string' ? req.query.filename.trim() : '';
      if (filename) {
        const note = await readMemoNote(NOTES_DIR, filename);
        if (!note) {
          return res.status(404).json({ ok: false, error: `便签不存在: ${filename}` });
        }
        return res.json({ ok: true, note });
      }
      const notes = await listMemoNotes(NOTES_DIR);
      return res.json({ ok: true, notes });
    } catch (err) {
      return next(err);
    }
  });

  /** 便签写数据面：阅读视图块级就地编辑的整篇覆盖写（只覆盖已有便签）。 */
  app.post('/protoclaw/memo-app/notes', express.json(), async (req, res, next) => {
    try {
      const raw = typeof req.body?.filename === 'string' ? req.body.filename : '';
      if (typeof req.body?.content !== 'string') {
        return res.status(400).json({ ok: false, error: 'content 必须是字符串' });
      }
      if (!sanitizeMemoFilename(raw)) {
        return res.status(400).json({ ok: false, error: 'filename 无效' });
      }
      const note = await writeMemoNote(NOTES_DIR, raw, req.body.content);
      if (!note) {
        return res.status(404).json({ ok: false, error: `便签不存在: ${raw}` });
      }
      return res.json({ ok: true, note });
    } catch (err) {
      return next(err);
    }
  });

  app.post('/protoclaw/memo-app/conversation/start', express.json(), async (_req, res, next) => {
    try {
      const conversation = await serialized(async () => {
        const active = await resolveActiveThread();
        if (!active) return createConversation();
        // 复用：唤起 head runtime（按需拉起；在线则 no-op），引用不动。
        const agent = await requireAgentLight(MEMO_AGENT_ID);
        await startManagedAgent(agent, active.headSessionId);
        const ready = await waitForManagedRuntimeReady(
          MEMO_AGENT_ID, RUNTIME_READY_TIMEOUT_MS, active.headSessionId,
        );
        if (!ready) {
          throw memoError(504, 'runtime_ready_timeout',
            `memo runtime not READY within ${RUNTIME_READY_TIMEOUT_MS}ms (session=${active.headSessionId})`);
        }
        const viewerAgentId = resolveSessionViewerAgentId(MEMO_AGENT_ID, active.headSessionId);
        if (!viewerAgentId) {
          throw memoError(500, 'viewer_agent_missing',
            `READY runtime has no viewerAgentId (session=${active.headSessionId})`);
        }
        return {
          created: false,
          threadId: active.threadId,
          sessionId: active.headSessionId,
          viewerAgentId,
        };
      });
      res.json(await _conversationPayload(conversation));
    } catch (err) {
      next(err);
    }
  });

  app.post('/protoclaw/memo-app/conversation/new', express.json(), async (_req, res, next) => {
    try {
      const previous = await resolveActiveThread();
      const conversation = await serialized(() => createConversation());
      // 新建落定后归档旧线程（打断收纳）。best-effort：失败只携带事实，
      // 残留旧线程不破坏单活动语义（活动引用已指向新线程）。
      let archive = null;
      if (previous) {
        try {
          await threadLifecycle.archiveThread(previous.threadId, {
            reason: 'memo_new_conversation',
          });
          archive = { archived: true, threadId: previous.threadId };
        } catch (error) {
          archive = {
            archived: false,
            threadId: previous.threadId,
            error: String(error?.message || error),
          };
          console.warn(`[memo-app] archive previous thread failed: ${previous.threadId}:`,
            error?.message || error);
        }
      }
      res.json({ ...(await _conversationPayload(conversation)), archive });
    } catch (err) {
      next(err);
    }
  });
}
