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
// 提醒存储：workspaces/memo/reminders.json（APP 级资产，线程零绑定）。
// 工具面（登记 / 完成 / 删除）在 runtime 侧 local-features/memo-reminders，
// 其 src/index.ts 有同构 inline 实现——两处必须同步修改。
const REMINDERS_FILE = path.join(getPrebuiltWorkspaceDir(MEMO_AGENT_ID), 'reminders.json');

// ── 提醒存储（与 local-features/memo-reminders/src/index.ts 的实现同步约定）──
// 文档 { items: [...] }、写时全量落盘、原子写（临时文件 + rename）。runtime
// 与 server 是两个写方，跨进程并发语义为 last-writer-wins（工单 039 认可）。

/** 读提醒条目；ENOENT（尚未登记过）回空数组，数据损坏抛错（不静默覆盖）。 */
async function readReminderEntries() {
  let raw;
  try {
    raw = await fs.readFile(REMINDERS_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const doc = JSON.parse(raw);
  return Array.isArray(doc?.items) ? doc.items : [];
}

/** 原子写：临时文件 + rename。 */
async function writeReminderEntries(items) {
  await ensureDir(path.dirname(REMINDERS_FILE));
  const tmp = `${REMINDERS_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ items }, null, 2), 'utf8');
  await fs.rename(tmp, REMINDERS_FILE);
}

/** 提醒文件的进程内写串行：完成 / 删除两个 HTTP 写口共用，防交错丢改。 */
let remindersWriteChain = Promise.resolve();
function withRemindersLock(task) {
  const run = remindersWriteChain.then(task, task);
  remindersWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

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

  /** 提醒列表数据面（首页提醒列表 block）：返回全部条目，前端自行分组。 */
  app.get('/protoclaw/memo-app/reminders', async (_req, res, next) => {
    try {
      const reminders = await readReminderEntries();
      res.json({ ok: true, reminders });
    } catch (err) {
      next(err);
    }
  });

  /** 提醒完成（写口与 runtime 侧工具面同文件，锁内读改写 + 原子写）。 */
  app.post('/protoclaw/memo-app/reminders/complete', express.json(), async (req, res, next) => {
    try {
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      if (!id) {
        return res.status(400).json({ ok: false, error: 'id 必须是字符串' });
      }
      let updated = null;
      await withRemindersLock(async () => {
        const items = await readReminderEntries();
        const item = items.find((entry) => entry && entry.id === id);
        if (!item) return;
        item.status = 'fired';
        await writeReminderEntries(items);
        updated = item;
      });
      if (!updated) {
        return res.status(404).json({ ok: false, error: `提醒不存在: ${id}` });
      }
      return res.json({ ok: true, reminder: updated });
    } catch (err) {
      return next(err);
    }
  });

  /** 提醒删除（永久删除；写口与 runtime 侧工具面同文件，锁内读改写 + 原子写）。 */
  app.post('/protoclaw/memo-app/reminders/delete', express.json(), async (req, res, next) => {
    try {
      const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
      if (!id) {
        return res.status(400).json({ ok: false, error: 'id 必须是字符串' });
      }
      let removed = null;
      await withRemindersLock(async () => {
        const items = await readReminderEntries();
        const index = items.findIndex((entry) => entry && entry.id === id);
        if (index < 0) return;
        removed = items.splice(index, 1)[0];
        await writeReminderEntries(items);
      });
      if (!removed) {
        return res.status(404).json({ ok: false, error: `提醒不存在: ${id}` });
      }
      return res.json({ ok: true, removed });
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

  /**
   * boot 自启（工单 039）：定时器住 runtime，是提醒刚性的前提。server
   * 就绪后调用（fireBootSchedules 同位）：
   * - 有活动线程 → 唤起其 head runtime（与 conversation/start 复用路径同构）；
   * - 无活动线程但有未触发提醒 → 建一段对话（定时器有宿主，agent 标唤醒
   *   有落点；经 serialized 与用户侧对话事务互斥）；
   * - 两者皆无 → 不拉起（保持按需拉起模型）。
   * 尽力而为：失败只记日志，不阻断、不重试（crash respawn 挂账独立立项）。
   * 手工停止 runtime 后提醒随之停发（模型 A 语义），无隐藏后台。
   */
  async function bootMemoAppOnServerReady() {
    try {
      const active = await resolveActiveThread();
      if (active) {
        const agent = await requireAgentLight(MEMO_AGENT_ID);
        await startManagedAgent(agent, active.headSessionId);
        const ready = await waitForManagedRuntimeReady(
          MEMO_AGENT_ID, RUNTIME_READY_TIMEOUT_MS, active.headSessionId,
        );
        console.log(`[memo-app] boot: runtime ${ready ? 'ready' : 'not ready yet'}`
          + ` (thread=${active.threadId}, session=${active.headSessionId})`);
        return { booted: true, threadId: active.threadId };
      }
      const reminders = await readReminderEntries().catch(() => []);
      const hasScheduled = reminders.some((item) => item
        && (item.status === undefined || item.status === null || item.status === 'scheduled'));
      if (hasScheduled) {
        await serialized(() => createConversation());
        console.log('[memo-app] boot: conversation created for pending reminders');
        return { booted: true, created: true };
      }
      return { booted: false };
    } catch (error) {
      console.warn('[memo-app] boot runtime failed:', error?.message || error);
      return { booted: false, error: String(error?.message || error) };
    }
  }

  return { bootMemoAppOnServerReady };
}
