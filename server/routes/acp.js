/**
 * ACP Support Routes — coder 会话的原子创建 + 精确中断 + 会话发现与续接（ticket 018）
 *
 * 为外部 ACP adapter（scripts/run-coder-acp.js，独立 stdio 进程）提供进程内
 * 编排路由，替代 adapter 自行组合既有端点（会留下孤儿 session / runtime /
 * thread，且需要理解 viewerAgentId 等 ViewerWorker 内部概念，见 ADR-0004 决策 3）：
 *
 *   POST /protoclaw/acp/coder/sessions
 *     （原子创建，见下）
 *
 *   GET  /protoclaw/acp/coder/sessions?cwd=...
 *     线程视角会话发现：每个活跃（未归档）线程出一条，以 head 会话为视角。
 *     可选 cwd 过滤按会话 openDirectory 归一化比较（Windows 大小写不敏感）。
 *
 *   POST /protoclaw/acp/coder/sessions/:clawSessionId/resume
 *     把成员或 head 会话解析到其线程的当前 head，急切挂载 runtime 并等待
 *     READY 后返回 { clawSessionId, threadId, viewerAgentId, cwd }。归档线程
 *     拒绝（409），无线程锚定 404，cwd 与持久化记录不一致 403。
 *
 *   POST /protoclaw/acp/coder/sessions/:clawSessionId/interrupt
 *     （精确中断，见下）
 *
 * 外部契约仍以 agentId="coder" 调用（编辑器集成零感知）；coder 已并入
 * programming-helper 工作空间，内部实现落在该工作空间的 coder 会话身份
 * 上（sessionType='coder'，线程宿主）。
 */

import path from 'path';
import { promises as fs } from 'fs';

import { VIEWER_ORIGIN } from '../shared/constants.js';
import {
  getAgentRuntime,
  listAgentRuntimes,
  isManagedRuntimeRunning,
} from '../shared/agent-access.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';

/** 对外契约 ID：ACP adapter 请求体仍传 agentId="coder"。 */
export const ACP_AGENT_ID = 'coder';
/** 内部实现：coder 会话宿主在 programming-helper 工作空间。 */
export const ACP_WORKSPACE_AGENT_ID = 'programming-helper';
/** coder 身份会话类型（线程宿主判定与 CoderAgent 分派键）。 */
export const ACP_SESSION_TYPE = 'coder';
export const ACP_READY_TIMEOUT_DEFAULT_MS = 30_000;
export function resolveAcpReadyTimeoutMs() {
  const raw = Number(process.env.CLAW_ACP_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : ACP_READY_TIMEOUT_DEFAULT_MS;
}

function acpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** 路径比较键：归一化分隔符 + 小写（Windows 大小写不敏感语义）。 */
export function acpPathKey(rawPath) {
  return String(rawPath || '').trim().replace(/[\\/]+/g, '\\').toLowerCase();
}

/**
 * 解析某 session 当前 runtime 的 viewerAgentId。
 *
 * 精确 session 定位（与 thread-controller 桥的 resolveRuntimeViewerId 同
 * 语义）：先查精确注册键，再扫描该 agent 的 runtimes 按 selectedSessionId
 * 匹配（shared-by-project 模式下注册键可能漂移，selectedSessionId 才是
 * 当前绑定事实）。绝不回退到 primary runtime——那会把控制投递送到别的
 * session（跨 session 污染）。
 */
export function resolveSessionViewerAgentId(agentId, sessionId) {
  const normalizedSession = sanitizeSessionFragment(sessionId);
  const direct = getAgentRuntime(agentId, sessionId);
  if (direct && isManagedRuntimeRunning(direct) && direct.viewerAgentId) {
    return direct.viewerAgentId;
  }
  const match = listAgentRuntimes(agentId).find((runtime) =>
    isManagedRuntimeRunning(runtime)
    && sanitizeSessionFragment(runtime.selectedSessionId) === normalizedSession
    && runtime.viewerAgentId,
  );
  return match?.viewerAgentId || null;
}

/**
 * 校验 ACP cwd：必须是绝对路径、且已存在并为目录。
 * 拒绝隐式创建 / 回退（不存在、是文件、相对路径一律 400）。
 */
export async function validateAcpCwd(rawCwd) {
  if (typeof rawCwd !== 'string' || !rawCwd.trim()) {
    throw acpError(400, 'invalid_cwd', 'cwd must be a non-empty string');
  }
  const trimmed = rawCwd.trim();
  if (!path.isAbsolute(trimmed)) {
    throw acpError(400, 'invalid_cwd', `cwd must be an absolute path: ${trimmed}`);
  }
  const normalized = path.normalize(trimmed);
  let stat;
  try {
    stat = await fs.stat(normalized);
  } catch {
    throw acpError(400, 'invalid_cwd', `cwd does not exist: ${normalized}`);
  }
  if (!stat.isDirectory()) {
    throw acpError(400, 'invalid_cwd', `cwd is not a directory: ${normalized}`);
  }
  return normalized;
}

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} ctx
 * @param {object} ctx.threadIntegration - getThreadIntegration()（onSessionCreated 宿主钩子）
 * @param {object} ctx.threadControl - getThreadControl()（{core, archive}；list/resume 需要）
 * @param {Function} [ctx.requirePrebuiltSessionRecord] - 会话索引记录读取（resume cwd 校验 / list 标题来源）
 */
export function setupAcpRoutes(app, express, ctx) {
  const {
    requireAgentLight,
    createPrebuiltSession,
    deletePrebuiltSession,
    startManagedAgent,
    stopManagedAgent,
    waitForManagedRuntimeReady,
    threadIntegration,
    threadControl,
    requirePrebuiltSessionRecord,
  } = ctx;

  /**
   * 失败回滚阶梯（设计 §5）。每步独立 best-effort：前步失败不阻断后步，
   * 失败步骤与遗留对象 ID 全部如实上报。
   */
  async function rollbackAcpCreation(agentId, state) {
    const steps = [];
    const leftover = {};
    const sessionId = state.session?.id;
    if (!sessionId) {
      return { steps: [{ step: 'delete_session', status: 'skipped', reason: 'no_session_created' }], leftover };
    }

    // 1. runtime 已启动（或启动已尝试）→ 精确 stop（agentId + sessionId）
    if (state.runtimeStartAttempted) {
      try {
        await stopManagedAgent(agentId, sessionId);
        steps.push({ step: 'stop_runtime', status: 'ok' });
      } catch (error) {
        const viewerAgentId = resolveSessionViewerAgentId(agentId, sessionId);
        if (viewerAgentId) leftover.viewerAgentId = viewerAgentId;
        steps.push({ step: 'stop_runtime', status: 'failed', error: String(error?.message || error) });
      }
    }

    // 2. thread 已创建 → 关闭。不信编排期的 hook 返回值，重新按
    //    headSessionId 解析——兜底「runtime 未 READY 但 thread 已创建」
    //    的中间态；无线程（hook 未执行 / 非 head）时 skipped。
    let threadRecord = null;
    try {
      threadRecord = await threadControl.core.findThreadByHeadSession(agentId, sessionId);
    } catch (error) {
      steps.push({ step: 'close_thread', status: 'failed', error: String(error?.message || error), phase: 'resolve' });
    }
    if (threadRecord) {
      try {
        await threadControl.core.closeThread(threadRecord.threadId, { reason: 'acp_session_creation_rollback' });
        steps.push({ step: 'close_thread', status: 'ok', threadId: threadRecord.threadId });
      } catch (error) {
        leftover.threadId = threadRecord.threadId;
        steps.push({ step: 'close_thread', status: 'failed', threadId: threadRecord.threadId, error: String(error?.message || error) });
      }
    } else if (!steps.some((step) => step.step === 'close_thread')) {
      steps.push({ step: 'close_thread', status: 'skipped', reason: 'no_thread_for_session' });
    }

    // 3. session 已写入 → 从 index 删除
    try {
      await deletePrebuiltSession(agentId, sessionId, { includeSessions: false });
      steps.push({ step: 'delete_session', status: 'ok' });
    } catch (error) {
      leftover.clawSessionId = sessionId;
      steps.push({ step: 'delete_session', status: 'failed', error: String(error?.message || error) });
    }

    if (Object.keys(leftover).length > 0) leftover.clawSessionId = leftover.clawSessionId || sessionId;
    return { steps, leftover };
  }

  // ── 原子创建 ─────────────────────────────────────────────────────

  app.post('/protoclaw/acp/coder/sessions', express.json(), async (req, res) => {
    try {
      const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
      if (agentId !== ACP_AGENT_ID) {
        res.status(400).json({
          ok: false,
          code: 'agent_not_supported',
          message: `This endpoint only accepts agentId="${ACP_AGENT_ID}" (got: ${JSON.stringify(agentId)})`,
        });
        return;
      }

      const cwd = await validateAcpCwd(req.body?.cwd);

      let agent;
      try {
        agent = await requireAgentLight(ACP_WORKSPACE_AGENT_ID);
      } catch (error) {
        res.status(Number(error?.statusCode) || 500).json({
          ok: false,
          code: error?.code || 'agent_unavailable',
          message: String(error?.message || error),
        });
        return;
      }

      const state = { session: null, runtimeStartAttempted: false };
      try {
        const session = await createPrebuiltSession(agent.id, {
          sessionType: ACP_SESSION_TYPE,
          openDirectory: cwd,
          returnSummary: false,
        });
        state.session = session;

        state.runtimeStartAttempted = true;
        await startManagedAgent(agent, session.id);

        // 线程宿主（coder）：新会话自动成为新线程初始 head（与既有
        // /protoclaw/prebuilt_sessions 同一钩子；失败不阻断，由下方
        // store 解析兜底判定 thread_missing）。
        await threadIntegration.onSessionCreated(agent.id, session);

        const readyTimeoutMs = resolveAcpReadyTimeoutMs();
        const ready = await waitForManagedRuntimeReady(agent.id, readyTimeoutMs, session.id);
        if (!ready) {
          throw acpError(504, 'runtime_ready_timeout', `coder runtime not READY within ${readyTimeoutMs}ms (session=${session.id})`);
        }

        const viewerAgentId = resolveSessionViewerAgentId(agent.id, session.id);
        if (!viewerAgentId) {
          throw acpError(500, 'viewer_agent_missing', `READY runtime has no viewerAgentId (session=${session.id})`);
        }

        const threadRecord = await threadControl.core.findThreadByHeadSession(agent.id, session.id);
        if (!threadRecord) {
          throw acpError(500, 'thread_missing', `session created but no thread anchor holds it as head (session=${session.id})`);
        }

        res.status(201).json({
          ok: true,
          clawSessionId: session.id,
          threadId: threadRecord.threadId,
          viewerAgentId,
          cwd,
        });
      } catch (error) {
        const rollback = await rollbackAcpCreation(agent.id, state);
        res.status(Number(error?.statusCode) || 500).json({
          ok: false,
          code: error?.code || 'acp_session_creation_failed',
          message: String(error?.message || error),
          rollback,
        });
      }
    } catch (error) {
      // cwd 校验等前置失败：无任何副作用，直接回错误。
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_session_creation_failed',
        message: String(error?.message || error),
      });
    }
  });

  // ── 会话发现（线程视角，head 出口）────────────────────────────────

  app.get('/protoclaw/acp/coder/sessions', async (req, res) => {
    try {
      // 可选 cwd 过滤：必须是已存在的目录（与 create/resume 同一校验语义）
      let cwdFilter = null;
      if (req.query.cwd) {
        cwdFilter = acpPathKey(await validateAcpCwd(req.query.cwd));
      }

      const threads = await threadControl.core.listThreads({
        agentId: ACP_WORKSPACE_AGENT_ID,
      });
      const archiveEntries = await threadControl.archive.list().catch(() => ({}));

      const sessions = [];
      for (const thread of Array.isArray(threads) ? threads : []) {
        // 归档是线程层收纳标记：归档线程不出现在 ACP 会话发现中
        if (archiveEntries[thread.threadId]) continue;
        const headSessionId = sanitizeSessionFragment(thread.headSessionId);
        if (!headSessionId) continue;

        // head 会话的持久化记录提供 cwd / 标题；缺失时 cwd 为 null（仍列出，
        // 但 resume 会因无线程锚定或记录缺失而失败——如实暴露数据状态）
        let record = null;
        try {
          record = await requirePrebuiltSessionRecord(ACP_WORKSPACE_AGENT_ID, headSessionId);
        } catch (error) {
          if (error?.statusCode !== 404) throw error;
        }
        const openDirectory = record?.openDirectory ? String(record.openDirectory) : null;
        if (cwdFilter && (!openDirectory || acpPathKey(openDirectory) !== cwdFilter)) continue;

        sessions.push({
          threadId: thread.threadId,
          sessionId: headSessionId,
          cwd: openDirectory,
          title: thread.title || record?.title || null,
          updatedAt: Number(thread.updatedAt)
            ? new Date(Number(thread.updatedAt)).toISOString()
            : (record?.updatedAt || null),
        });
      }

      res.json({ ok: true, threads: sessions });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_list_failed',
        message: String(error?.message || error),
      });
    }
  });

  // ── 会话续接（成员/head → 线程 head，急切挂载）────────────────────

  app.post('/protoclaw/acp/coder/sessions/:clawSessionId/resume', express.json(), async (req, res) => {
    try {
      const requestedSessionId = sanitizeSessionFragment(req.params.clawSessionId);
      if (!requestedSessionId) {
        throw acpError(400, 'invalid_params', 'clawSessionId is required');
      }

      // 可选 cwd 校验：与该会话持久化的 openDirectory 一致才允许续接
      // （防止客户端拿错目录续接另一个项目的上下文）。大小写/分隔符不敏感。
      let requestCwd = null;
      if (req.body?.cwd !== undefined) {
        requestCwd = await validateAcpCwd(req.body.cwd);
      }
      const sessionRecord = await requirePrebuiltSessionRecord(ACP_WORKSPACE_AGENT_ID, requestedSessionId);
      if (
        requestCwd
        && (!sessionRecord?.openDirectory || acpPathKey(sessionRecord.openDirectory) !== acpPathKey(requestCwd))
      ) {
        throw acpError(403, 'cwd_mismatch', `session ${requestedSessionId} belongs to ${sessionRecord?.openDirectory || '(unknown)'}, not ${requestCwd}`);
      }

      // 成员会话 → 线程 → 当前 head（compact 接力后旧会话自动落到最新上下文）。
      // 先按 head 命中（快路径）；未命中再经 thread-integration 的成员链扫描
      // （sessionChain 全成员匹配，与 input-gateway 非 head 投递路由同源语义）。
      let threadRecord = await threadControl.core.findThreadByHeadSession(
        ACP_WORKSPACE_AGENT_ID,
        requestedSessionId,
      );
      if (!threadRecord && typeof threadIntegration?.findThreadBySession === 'function') {
        threadRecord = await threadIntegration.findThreadBySession(
          ACP_WORKSPACE_AGENT_ID,
          requestedSessionId,
        );
      }
      if (!threadRecord) {
        throw acpError(404, 'thread_not_found', `no thread holds session ${requestedSessionId} as member or head`);
      }
      const headSessionId = sanitizeSessionFragment(threadRecord.headSessionId);
      if (!headSessionId) {
        throw acpError(500, 'thread_head_missing', `thread ${threadRecord.threadId} has no head session`);
      }

      // 归档线程拒绝续接（先取消归档才能继续）
      if (await threadControl.archive.isArchived(threadRecord.threadId)) {
        throw acpError(409, 'thread_archived', `thread ${threadRecord.threadId} is archived; unarchive it first`);
      }

      // 急切挂载：runtime 已运行则幂等复用，否则启动并等 READY（错误前置，
      // 不把失败拖到第一次 prompt）
      let agent;
      try {
        agent = await requireAgentLight(ACP_WORKSPACE_AGENT_ID);
      } catch (error) {
        throw Object.assign(error, { statusCode: Number(error?.statusCode) || 500 });
      }
      await startManagedAgent(agent, headSessionId);
      const readyTimeoutMs = resolveAcpReadyTimeoutMs();
      const ready = await waitForManagedRuntimeReady(ACP_WORKSPACE_AGENT_ID, readyTimeoutMs, headSessionId);
      if (!ready) {
        throw acpError(504, 'runtime_ready_timeout', `coder runtime not READY within ${readyTimeoutMs}ms (session=${headSessionId})`);
      }
      const viewerAgentId = resolveSessionViewerAgentId(ACP_WORKSPACE_AGENT_ID, headSessionId);
      if (!viewerAgentId) {
        throw acpError(500, 'viewer_agent_missing', `READY runtime has no viewerAgentId (session=${headSessionId})`);
      }

      res.json({
        ok: true,
        clawSessionId: headSessionId,
        threadId: threadRecord.threadId,
        viewerAgentId,
        cwd: sessionRecord?.openDirectory ? String(sessionRecord.openDirectory) : null,
      });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_resume_failed',
        message: String(error?.message || error),
      });
    }
  });

  // ── 精确中断 ─────────────────────────────────────────────────────

  app.post('/protoclaw/acp/coder/sessions/:clawSessionId/interrupt', express.json(), async (req, res) => {
    const clawSessionId = sanitizeSessionFragment(req.params.clawSessionId);
    try {
      const viewerAgentId = resolveSessionViewerAgentId(ACP_WORKSPACE_AGENT_ID, clawSessionId);
      if (!viewerAgentId) {
        res.status(404).json({
          ok: false,
          code: 'runtime_not_found',
          message: `No running coder runtime is bound to session ${clawSessionId}`,
        });
        return;
      }

      // 现有 /api/agents/:id/interrupt 同链路：ViewerWorker interrupt 端点
      // （服务端 handler 内固定下发 UDS { type: 'interrupt-agent',
      // clearQueue: true }——同时取消 active call 与已排队 user-turn）。
      let response;
      try {
        response = await fetch(
          `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/interrupt`,
          { method: 'POST' },
        );
      } catch (error) {
        res.status(502).json({
          ok: false,
          code: 'viewer_unreachable',
          message: `Failed to reach ViewerWorker interrupt chain: ${String(error?.message || error)}`,
        });
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        res.status(502).json({
          ok: false,
          code: 'viewer_interrupt_failed',
          message: `ViewerWorker interrupt returned ${response.status}`,
          viewerBody: body,
        });
        return;
      }

      res.json({ ok: true, clawSessionId, viewerAgentId });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_interrupt_failed',
        message: String(error?.message || error),
      });
    }
  });
}
