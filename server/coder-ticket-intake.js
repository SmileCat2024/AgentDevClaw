/**
 * coder 外部工单目录（ticket intake）
 *
 * 约定一个外部 tickets 目录（由上游工具或人工放置 JSON 工单），
 * 这里只做两件事：
 *   1. 列出目录下的工单（文件名去 .json 后缀即权威 id）
 *   2. 把某张工单派发给 coder 执行（登记到 coder 工单存储并启动线程）
 *
 * 工单 JSON 字段（instruction 必填，其余可选）：
 *   { "title": "...", "instruction": "...", "projectDir": "...", "completionPolicy": "auto|review" }
 *
 * 派发语义：
 *   - 未派发过 → 以外部 id 创建工单并启动（projectDir 取派发参数，缺省用工单自带）
 *   - 已派发且 running → 直接返回（不重复投递）
 *   - 已派发且 done → 直接返回
 *   - 已派发但 blocked/queued → resume（恢复措辞，不重放原始指令）
 */

import path from 'path';
import { promises as fs } from 'fs';

import { cleanSessionText } from './shared/string-helpers.js';

const COMPLETION_POLICIES = new Set(['auto', 'review']);

function intakeError(message, status = 400, code = 'intake_error') {
  return Object.assign(new Error(message), { status, code });
}

function parseExternalTicket(fileName, raw) {
  const id = fileName.replace(/\.json$/i, '');
  if (!raw || typeof raw !== 'object') {
    return { id, invalid: true };
  }
  const instruction = cleanSessionText(raw.instruction);
  if (!instruction) {
    return { id, invalid: true };
  }
  return {
    id,
    title: cleanSessionText(raw.title) || instruction.slice(0, 60),
    instruction,
    projectDir: cleanSessionText(raw.projectDir) || null,
    completionPolicy: COMPLETION_POLICIES.has(raw.completionPolicy) ? raw.completionPolicy : 'review',
  };
}

export function createCoderTicketIntake({ ticketService } = {}) {
  if (!ticketService) throw new Error('createCoderTicketIntake requires a ticketService');

  async function list(ticketsDir) {
    const directory = cleanSessionText(ticketsDir);
    if (!directory) throw intakeError('ticketsDir is required');
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw intakeError(error?.code === 'ENOENT'
        ? 'Tickets directory does not exist'
        : `Cannot read tickets directory: ${error?.message || error}`, 404, 'tickets_dir_unreadable');
    }
    const tickets = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      let raw = null;
      let parseError = false;
      try {
        raw = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
      } catch {
        parseError = true;
      }
      const parsed = parseExternalTicket(entry.name, raw);
      const dispatched = parsed.invalid ? null : await ticketService.getTicket(parsed.id);
      tickets.push({
        ...parsed,
        parseError,
        dispatched: Boolean(dispatched),
        status: dispatched?.status || null,
        threadId: dispatched?.threadId || null,
        headSessionId: dispatched?.headSessionId || null,
      });
    }
    tickets.sort((left, right) => left.id.localeCompare(right.id));
    return tickets;
  }

  async function dispatch({ ticketsDir, ticketId, projectDir } = {}) {
    const directory = cleanSessionText(ticketsDir);
    const id = cleanSessionText(ticketId);
    if (!directory || !id) throw intakeError('ticketsDir and ticketId are required');

    let raw;
    try {
      raw = JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), 'utf8'));
    } catch {
      throw intakeError(`Ticket file not found or invalid JSON: ${id}`, 404, 'ticket_not_found');
    }
    const parsed = parseExternalTicket(`${id}.json`, raw);
    if (parsed.invalid) throw intakeError(`Ticket ${id} is missing a valid instruction`);

    const existing = await ticketService.getTicket(id);
    if (existing && (existing.status === 'running' || existing.status === 'done')) {
      return { ticket: existing, action: existing.status === 'done' ? 'already-done' : 'already-running' };
    }
    if (existing) {
      return { ticket: await ticketService.resume(id), action: 'resumed' };
    }
    const effectiveProjectDir = cleanSessionText(projectDir) || parsed.projectDir;
    if (!effectiveProjectDir) {
      throw intakeError('projectDir is required (ticket has none; pass it when dispatching)');
    }
    return {
      ticket: await ticketService.create({
        id,
        instruction: parsed.instruction,
        projectDir: effectiveProjectDir,
        completionPolicy: parsed.completionPolicy,
      }),
      action: 'dispatched',
    };
  }

  return { list, dispatch };
}

export function setupCoderTicketIntakeRoutes(app, express, { intake } = {}) {
  if (!intake) throw new Error('setupCoderTicketIntakeRoutes requires an intake');
  const json = express.json({ limit: '256kb' });
  const handleError = (res, error) => res.status(Number(error?.status) || 500).json({
    ok: false,
    code: error?.code || 'intake_error',
    error: error instanceof Error ? error.message : String(error),
  });

  app.get('/protoclaw/coder/ticket_intake', async (req, res) => {
    try {
      res.json({ ok: true, tickets: await intake.list(req.query.dir) });
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post('/protoclaw/coder/ticket_intake/dispatch', json, async (req, res) => {
    try {
      res.json({ ok: true, ...(await intake.dispatch(req.body || {})) });
    } catch (error) {
      handleError(res, error);
    }
  });
}
