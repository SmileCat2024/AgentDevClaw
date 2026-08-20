import path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';

import { USER_DATA_ROOT } from './shared/constants.js';
import { ensureDir } from './shared/fs-helpers.js';
import { cleanSessionText } from './shared/string-helpers.js';

const CODER_AGENT_ID = 'coder';
const TICKET_STATUSES = new Set(['queued', 'running', 'blocked', 'done']);
const COMPLETION_POLICIES = new Set(['auto', 'review']);
const RECOVERY_INSTRUCTION = [
  '继续处理这张工单。先检查当前工作树、已有变更、测试结果和上一棒摘要，',
  '确认哪些步骤已经完成；不要重复可能已有副作用的操作。',
  '完成后按工单的完成策略处理；需要人工决策或无法安全判断时，明确说明原因。',
].join('');

function ticketRoot(rootDir = USER_DATA_ROOT) {
  return path.join(rootDir, 'workspaces', CODER_AGENT_ID, 'tickets');
}

function ticketPath(rootDir, ticketId) {
  return path.join(ticketRoot(rootDir), `${ticketId}.json`);
}

function normalizeTicket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = cleanSessionText(raw.id);
  const instruction = cleanSessionText(raw.instruction);
  const projectDir = cleanSessionText(raw.projectDir);
  const status = TICKET_STATUSES.has(raw.status) ? raw.status : 'queued';
  if (!id || !instruction || !projectDir) return null;
  return {
    id,
    instruction,
    projectDir,
    completionPolicy: COMPLETION_POLICIES.has(raw.completionPolicy) ? raw.completionPolicy : 'review',
    status,
    threadId: cleanSessionText(raw.threadId) || null,
    blockedReason: cleanSessionText(raw.blockedReason) || null,
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now(),
  };
}

function toTicketSummary(ticket, thread = null) {
  return {
    ...ticket,
    headSessionId: cleanSessionText(thread?.headSessionId) || null,
    threadStatus: cleanSessionText(thread?.status) || null,
  };
}

async function writeTicket(rootDir, ticket) {
  await ensureDir(ticketRoot(rootDir));
  const destination = ticketPath(rootDir, ticket.id);
  const temporary = `${destination}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(ticket, null, 2), 'utf8');
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
    await fs.unlink(destination).catch(() => {});
    await fs.rename(temporary, destination);
  }
}

async function readTicket(rootDir, ticketId) {
  try {
    return normalizeTicket(JSON.parse(await fs.readFile(ticketPath(rootDir, ticketId), 'utf8')));
  } catch {
    return null;
  }
}

async function listTickets(rootDir) {
  try {
    const entries = await fs.readdir(ticketRoot(rootDir), { withFileTypes: true });
    const tickets = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => fs.readFile(path.join(ticketRoot(rootDir), entry.name), 'utf8')
        .then(JSON.parse)
        .then(normalizeTicket)
        .catch(() => null)));
    return tickets.filter(Boolean).sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

function createTicketError(message, status = 400, code = 'invalid_ticket') {
  return Object.assign(new Error(message), { status, code });
}

export function createCoderTicketService({
  rootDir = USER_DATA_ROOT,
  sessionApi,
  requireAgentLight,
  startManagedAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
  getAgentRuntime,
  threadIntegration,
  threadController,
  stat = fs.stat,
} = {}) {
  if (!sessionApi || typeof sessionApi.updateSessionIndex !== 'function' || !requireAgentLight || !startManagedAgent
    || typeof stopManagedAgent !== 'function' || !waitForManagedRuntimeReady || typeof getAgentRuntime !== 'function' || !threadIntegration || !threadController) {
    throw new Error('createCoderTicketService requires session and thread dependencies');
  }

  const ticketLocks = new Map();

  /**
   * 清除 session index 里持久化的守卫阻断标志。
   * 守卫阻断标志只在 runtime 内存里成立；runtime 停止或重启后它就变成
   * 谎言（UI 会一直显示输入被禁用）。在 runtime 换代/退役时同步清掉。
   */
  async function clearPersistedGuardState(sessionId) {
    try {
      await sessionApi.updateSessionIndex(CODER_AGENT_ID, (index) => ({
        ...index,
        sessions: index.sessions.map((record) => record.id === sessionId && record.contextGuard
          ? { ...record, contextGuard: null, updatedAt: new Date().toISOString() }
          : record),
      }));
    } catch (error) {
      console.warn(`[coder-tickets] failed to clear persisted guard state for session=${sessionId}:`, error?.message || error);
    }
  }

  async function withTicketLock(ticketId, operation) {
    const previous = ticketLocks.get(ticketId) || Promise.resolve();
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    ticketLocks.set(ticketId, next);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (ticketLocks.get(ticketId) === next) ticketLocks.delete(ticketId);
    }
  }

  async function updateTicket(ticketId, update) {
    return withTicketLock(ticketId, async () => {
      const current = await readTicket(rootDir, ticketId);
      if (!current) throw createTicketError('Ticket not found', 404, 'ticket_not_found');
      const next = normalizeTicket({ ...current, ...update, updatedAt: Date.now() });
      await writeTicket(rootDir, next);
      return next;
    });
  }

  async function getTicket(ticketId) {
    const ticket = await readTicket(rootDir, ticketId);
    if (!ticket) return null;
    const thread = ticket.threadId ? await threadController.getThread(ticket.threadId) : null;
    return toTicketSummary(ticket, thread);
  }

  async function list() {
    const tickets = await listTickets(rootDir);
    return Promise.all(tickets.map(async (ticket) => {
      const thread = ticket.threadId ? await threadController.getThread(ticket.threadId) : null;
      return toTicketSummary(ticket, thread);
    }));
  }

  async function start(ticketId, { recovery = false } = {}) {
    return withTicketLock(ticketId, async () => {
      let ticket = await readTicket(rootDir, ticketId);
      if (!ticket) throw createTicketError('Ticket not found', 404, 'ticket_not_found');
      if (ticket.status === 'done') return getTicket(ticketId);

      try {
        const projectStat = await stat(ticket.projectDir);
        if (!projectStat.isDirectory()) {
          throw createTicketError('Ticket projectDir is not a directory', 400, 'invalid_project_directory');
        }
      } catch (error) {
        const reason = error?.code === 'ENOENT'
          ? '项目目录不存在，无法继续执行。'
          : (error?.message || '无法访问项目目录。');
        ticket = normalizeTicket({ ...ticket, status: 'blocked', blockedReason: reason, updatedAt: Date.now() });
        await writeTicket(rootDir, ticket);
        return toTicketSummary(ticket);
      }

      const agent = await requireAgentLight(CODER_AGENT_ID);
      let thread = ticket.threadId ? await threadController.getThread(ticket.threadId) : null;
      if (!thread || thread.status !== 'active') {
        const session = await sessionApi.createPrebuiltSession(CODER_AGENT_ID, {
          openDirectory: ticket.projectDir,
          title: ticket.instruction.slice(0, 80),
          metadata: { ticketId: ticket.id },
        });
        thread = await threadIntegration.onSessionCreated(CODER_AGENT_ID, session);
        if (!thread) throw new Error('Unable to create a work thread for ticket');
        await sessionApi.updateSessionIndex(CODER_AGENT_ID, (index) => ({
          ...index,
          sessions: index.sessions.map((record) => record.id === session.id
            ? { ...record, metadata: { ...(record.metadata || {}), ticketId: ticket.id } }
            : record),
        }));
        ticket = normalizeTicket({
          ...ticket,
          threadId: thread.threadId,
          status: 'queued',
          blockedReason: null,
          updatedAt: Date.now(),
        });
        await writeTicket(rootDir, ticket);
      }

      const existingRuntime = getAgentRuntime(CODER_AGENT_ID, thread.headSessionId);
      const wasAlreadyReady = existingRuntime?.ready === true;
      await startManagedAgent(agent, thread.headSessionId);
      const runtime = await waitForManagedRuntimeReady(CODER_AGENT_ID, undefined, thread.headSessionId);
      if (!runtime) {
        ticket = normalizeTicket({
          ...ticket,
          status: 'queued',
          blockedReason: '执行运行时尚未就绪，将在下次恢复时重试。',
          updatedAt: Date.now(),
        });
        await writeTicket(rootDir, ticket);
        return toTicketSummary(ticket, thread);
      }

      const shouldResume = recovery || wasAlreadyReady;
      // runtime 刚换代的会话不再处于守卫阻断态；清掉 index 里可能残留的
      // 旧标志（如 rotation 失败或进程崩溃后重启的场景），否则 UI 永远禁用输入。
      await clearPersistedGuardState(thread.headSessionId);
      const instruction = shouldResume
        ? `恢复工单「${ticket.instruction}」。${RECOVERY_INSTRUCTION}`
        : [
            `处理工单：${ticket.instruction}`,
            `项目目录：${ticket.projectDir}`,
            ticket.completionPolicy === 'auto'
              ? '完成实现后运行最相关的验证；确认目标达成后可报告完成。'
              : '完成实现和验证后不要自行宣布工单结束，整理结果并等待人工验收。',
          ].join('\n');
      await threadController.appendCommand({
        threadId: thread.threadId,
        kind: shouldResume ? 'system_continuation' : 'external',
        text: instruction,
        source: shouldResume ? 'ticket-recovery' : 'ticket',
        idempotencyKey: shouldResume ? `ticket-recovery-${ticket.id}-${thread.headSessionId}` : `ticket-start-${ticket.id}`,
      });
      await threadIntegration.tryDeliver(thread.threadId);

      ticket = normalizeTicket({
        ...ticket,
        status: 'running',
        blockedReason: null,
        updatedAt: Date.now(),
      });
      await writeTicket(rootDir, ticket);
      return toTicketSummary(ticket, await threadController.getThread(thread.threadId));
    });
  }

  async function create({ id, instruction, projectDir, completionPolicy } = {}) {
    const normalizedInstruction = cleanSessionText(instruction);
    const normalizedProjectDir = cleanSessionText(projectDir);
    if (!normalizedInstruction) throw createTicketError('instruction is required');
    if (!normalizedProjectDir) throw createTicketError('projectDir is required');
    const ticket = normalizeTicket({
      // 外部派发（ticket intake）以外部工单文件名作为 id，保持与源目录幂等对应
      id: cleanSessionText(id) || `ticket-${Date.now()}-${randomUUID().slice(0, 8)}`,
      instruction: normalizedInstruction,
      projectDir: normalizedProjectDir,
      completionPolicy,
      status: 'queued',
      threadId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await writeTicket(rootDir, ticket);
    return start(ticket.id);
  }

  async function resume(ticketId) {
    await updateTicket(ticketId, { status: 'queued', blockedReason: null });
    return start(ticketId, { recovery: true });
  }

  async function markDone(ticketId) {
    return updateTicket(ticketId, { status: 'done', blockedReason: null });
  }

  async function handleContextGuard(agentId, sessionId) {
    if (agentId !== CODER_AGENT_ID) return null;
    const tickets = await listTickets(rootDir);
    let ticket = null;
    for (const candidate of tickets) {
      if (candidate.status !== 'running' || !candidate.threadId) continue;
      const thread = await threadController.getThread(candidate.threadId);
      if (thread?.headSessionId === sessionId) {
        ticket = candidate;
        break;
      }
    }
    if (!ticket) return null;
    return withTicketLock(ticket.id, async () => {
      const current = await readTicket(rootDir, ticket.id);
      const thread = current?.threadId ? await threadController.getThread(current.threadId) : null;
      if (!current || current.status !== 'running' || !thread || thread.headSessionId !== sessionId) return null;
      try {
        await threadIntegration.beginSessionSuccession({ agentId, sessionId, reason: 'trim' });
        // 先退役旧 head 再摘要：guard 已将其置于阻断态（内存仲裁拒绝一切输入），
        // 留着只是僵尸会话；更重要的是 remove-session 会让 runtime 把最新会话
        // 状态 flush 落盘——摘要 mirror 读的是 session 文件，若不先 flush，
        // 会基于过期快照生成"没有实质性工作"的失真摘要（实测两轮轮换均复现）。
        await stopManagedAgent(CODER_AGENT_ID, sessionId).catch((error) => {
          console.warn(`[coder-tickets] failed to retire pre-rotation runtime for session=${sessionId}:`, error?.message || error);
        });
        const result = await sessionApi.compactAndResumeCurrentSession({
          preferredAgentId: CODER_AGENT_ID,
          sessionId,
          // 混合精简：trim-transcript 保留裁剪后的对话主干（工具记录折叠），
          // appendSummary 走 run-compact-mirror 独立摘要管线，把摘要 system
          // message 追加到 seed 尾部（mode: trim-transcript-with-summary）。
          policy: { strategy: 'trim-transcript' },
          appendSummary: true,
          startRuntime: true,
        });
        const nextSessionId = cleanSessionText(result?.session?.id);
        if (!nextSessionId) throw new Error('Trim compaction did not create a successor session');
        await threadIntegration.applySessionSuccession({
          agentId,
          fromSessionId: sessionId,
          toSessionId: nextSessionId,
          reason: 'trim',
        });
        await clearPersistedGuardState(sessionId);
        await threadController.appendCommand({
          threadId: current.threadId,
          kind: 'system_continuation',
          text: `工单上下文已精简接力。${RECOVERY_INSTRUCTION}`,
          source: 'ticket-context-rotation',
          idempotencyKey: `ticket-context-rotation-${current.id}-${nextSessionId}`,
        });
        await threadIntegration.tryDeliver(current.threadId);
        const next = normalizeTicket({ ...current, status: 'running', blockedReason: null, updatedAt: Date.now() });
        await writeTicket(rootDir, next);
        return toTicketSummary(next, await threadController.getThread(next.threadId));
      } catch (error) {
        // 接力失败时旧 runtime 仍卡在守卫阻断态（内存仲裁拒绝一切输入）。
        // 不退役的话，后续 resume() 会把恢复指令投给一个永远拒绝输入的 runtime。
        await stopManagedAgent(CODER_AGENT_ID, sessionId).catch(() => {});
        await clearPersistedGuardState(sessionId);
        const next = normalizeTicket({
          ...current,
          status: 'blocked',
          blockedReason: `上下文接力失败：${error instanceof Error ? error.message : String(error)}`,
          updatedAt: Date.now(),
        });
        await writeTicket(rootDir, next);
        return toTicketSummary(next, thread);
      }
    });
  }

  async function recoverAll() {
    const tickets = await listTickets(rootDir);
    const results = [];
    for (const ticket of tickets) {
      if (ticket.status !== 'queued' && ticket.status !== 'running') continue;
      try {
        if (ticket.status === 'running') {
          const thread = ticket.threadId ? await threadController.getThread(ticket.threadId) : null;
          if (thread && getAgentRuntime(CODER_AGENT_ID, thread.headSessionId)?.ready === true) continue;
        }
        results.push(await start(ticket.id, { recovery: ticket.status === 'running' }));
      } catch (error) {
        results.push(await updateTicket(ticket.id, {
          status: 'blocked',
          blockedReason: `恢复失败：${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    }
    return results;
  }

  return { create, getTicket, list, resume, markDone, handleContextGuard, recoverAll };
}

export function setupCoderTicketRoutes(app, express, { service } = {}) {
  if (!service) throw new Error('setupCoderTicketRoutes requires a service');
  const json = express.json({ limit: '256kb' });
  const handleError = (res, error) => res.status(Number(error?.status) || 500).json({
    ok: false,
    code: error?.code || 'ticket_error',
    error: error instanceof Error ? error.message : String(error),
  });

  app.get('/protoclaw/coder/tickets', async (_req, res) => {
    try {
      res.json({ ok: true, tickets: await service.list() });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post('/protoclaw/coder/tickets', json, async (req, res) => {
    try {
      res.status(201).json({ ok: true, ticket: await service.create(req.body || {}) });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post('/protoclaw/coder/tickets/:ticketId/resume', json, async (req, res) => {
    try {
      res.json({ ok: true, ticket: await service.resume(req.params.ticketId) });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post('/protoclaw/coder/tickets/:ticketId/done', json, async (req, res) => {
    try {
      res.json({ ok: true, ticket: await service.markDone(req.params.ticketId) });
    } catch (error) {
      handleError(res, error);
    }
  });
}
