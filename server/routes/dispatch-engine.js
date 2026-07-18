/**
 * Dispatch engine — fire logic + boot recovery.
 *
 * Extracted from dispatch.js. Contains:
 *   - fireSingleTarget: resolve target, start/create runtime, push message + envelope
 *   - fireDispatchNow: top-level fire dispatcher (send_message / start_agent)
 *   - restoreDispatchSchedulesOnBoot: recovery sweep on server restart
 *   - fireBootSchedules: fire on-boot schedules after server ready
 *
 * Shared dependencies (Maps, _ctx, helper functions) are wired at runtime
 * via initDispatchEngine(), called by dispatch.js setDispatchCtx().
 */

import {
  createCallEnvelope,
  enqueueRuntimeEnvelope,
  refreshRuntimeExecutionState,
  updateEnvelopeStatus,
  EnvelopeSource,
  EnvelopeStatus,
} from '../runtime-call-envelope.js';
import { DISPATCH_FIRED_TIMEOUT_MS } from '../shared/constants.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import {
  getManagedRuntimeKey,
  getAgentRuntime,
  listAgentRuntimes,
} from '../shared/agent-access.js';
import { readSessionIndex } from '../shared/session-access.js';

// ── Shared dependency wiring ──────────────────────────────────────

/**
 * Shared deps object, populated by dispatch.js via initDispatchEngine().
 *
 * Expected shape:
 *   dispatchSchedules       — Map (scheduleId → schedule)
 *   dispatchTimers          — Map (scheduleId/watchdogKey → timer handle)
 *   getCtx()                — returns the current _ctx object
 *   saveDispatchSchedules() — persists schedules to disk
 *   pushDispatchMessage(runtimeKey, text, scheduleId) — enqueue/deliver
 *   scheduleDispatchFire(schedule) — arm timer/idle/on-ready trigger
 *   emitDispatchReadyEvent(agentId, sessionId) — match on-ready schedules
 *   getProjectAdapter(agentId) — returns project adapter or null
 */
const _shared = {};

export function initDispatchEngine(deps) {
  Object.assign(_shared, deps);
}

// ── Fire logic ────────────────────────────────────────────────────

async function fireSingleTarget(s, target) {
  const _ctx = _shared.getCtx();
  const { getProjectAdapter, saveDispatchSchedules, pushDispatchMessage } = _shared;

  const agentId = target.agentId || s.targetAgentId;
  let sessionId = target.sessionId || s.targetSessionId;
  const sessionType = target.newSessionType || s.newSessionType || 'main';

  // ── Resolve __latest__ session ──
  if (sessionId === '__latest__') {
    try {
      const sessionsResult = await _ctx.listPrebuiltSessions(agentId);
      const allSessions = sessionsResult?.sessions || [];
      // Filter: main only for programming-helper, all for others
      const filtered = agentId === 'programming-helper'
        ? allSessions.filter(ss => ss.sessionType !== 'exploration')
        : allSessions;
      // Further filter by project if specified
      const projId = s.projectId;
      const byProject = projId
        ? filtered.filter(ss => {
            const adapter = getProjectAdapter(agentId);
            return adapter ? adapter.extractProjectId(ss) === projId : true;
          })
        : filtered;
      const latest = byProject[0]; // already sorted by updatedAt desc
      if (latest) {
        sessionId = latest.id;
        console.log(`[Dispatch] __latest__ resolved to ${sessionId} for ${agentId}`);
      } else {
        console.warn(`[Dispatch] __latest__ found no sessions for ${agentId}, skipping`);
        return;
      }
    } catch (err) {
      console.error(`[Dispatch] __latest__ resolution failed for ${agentId}:`, err.message);
      return;
    }
  }

  // ── onlyActiveSessions check ──
  if (s.onlyActiveSessions && sessionId) {
    const runtime = getAgentRuntime(agentId, sessionId);
    if (!runtime || runtime.stopped || runtime.process?.exitCode !== null) {
      console.log(`[Dispatch] onlyActiveSessions: session ${sessionId} not running, skipping`);
      return;
    }
  }

  const isNewSession = !sessionId;

  try {
    if (isNewSession) {
      const agent = await _ctx.requirePrebuiltAgentForRuntime(agentId);
      let createOpts = { sessionType };
      const adapter = getProjectAdapter(agentId);
      const projectId = target.projectId || s.projectId;

      if (adapter) {
        let projectConfig = null;
        if (projectId) {
          projectConfig = adapter.getProjectConfig(projectId);
          console.log(`[Dispatch] using specified project ${projectId} for ${agentId}`);
        } else {
          const currentProject = await adapter.getCurrentProject();
          if (currentProject) {
            projectConfig = adapter.getProjectConfig(currentProject.id);
            console.log(`[Dispatch] using current project ${currentProject.id} for ${agentId}`);
          }
        }
        if (projectConfig && Object.keys(projectConfig).length > 0) {
          createOpts = { ...createOpts, ...projectConfig };
        }
      } else {
        console.log(`[Dispatch] no project adapter for ${agentId}, using workspace state`);
        try {
          const workspaceState = await _ctx.readWorkspaceState(agentId);
          if (workspaceState?.openDirectory) {
            createOpts.openDirectory = workspaceState.openDirectory;
          }
        } catch (err) {
          console.error(`[Dispatch] failed to read workspace state for ${agentId}:`, err.message);
        }
      }

      const session = await _ctx.createPrebuiltSession(agentId, createOpts);
      sessionId = session.id;
      if (!s.targets) { s.targetSessionId = sessionId; saveDispatchSchedules(); }
      const runtimeOpts = {};
      if (sessionType !== 'main') {
        runtimeOpts.extraEnv = {
          PROTOCLAW_SESSION_TYPE: sessionType,
          PROTOCLAW_MODEL_PRESET_ROLE: sessionType === 'exploration' ? 'exploration' : 'sub',
        };
      }
      await _ctx.startManagedAgent(agent, sessionId, runtimeOpts);
      const connected = await _ctx.waitForManagedRuntimeReady(agent.id, 15000, sessionId);
      console.log(`[Dispatch] auto-started ${agentId} session=${sessionId} type=${sessionType} connected=${connected}`);
    } else {
      const runtime = getAgentRuntime(agentId, sessionId);
      if (!runtime || runtime.stopped || runtime.process?.exitCode !== null) {
        const agent = await _ctx.requirePrebuiltAgentForRuntime(agentId);
        await _ctx.activatePrebuiltSession(agentId, sessionId);
        const idx = await readSessionIndex(agentId);
        const record = idx.sessions.find(r => r.id === sessionId);
        const resolvedType = record?.sessionType || sessionType;
        const runtimeOpts = {};
        if (resolvedType !== 'main') {
          runtimeOpts.extraEnv = {
            PROTOCLAW_SESSION_TYPE: resolvedType,
            PROTOCLAW_MODEL_PRESET_ROLE: resolvedType === 'exploration' ? 'exploration' : 'sub',
          };
        }
        await _ctx.startManagedAgent(agent, sessionId, runtimeOpts);
        const connected = await _ctx.waitForManagedRuntimeReady(agent.id, 15000, sessionId);
        console.log(`[Dispatch] auto-started ${agentId} session=${sessionId} type=${resolvedType} connected=${connected}`);
      }
    }
  } catch (err) {
    console.error(`[Dispatch] failed to start runtime for ${agentId}/${sessionId}:`, err.message);
    s.status = 'failed';
    s.lastError = err instanceof Error ? err.message : String(err);
    s.result = s.result || '(dispatch target is unavailable)';
    s.completedAt = new Date().toISOString();
    saveDispatchSchedules();
    return;
  }

  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);

  // 回写解析后的真实目标到 schedule（兼容旧记录，无需回写时跳过）
  if (!s.targets) {
    s.resolvedTargetSessionId = sessionId;
    s.resolvedRuntimeKey = runtimeKey;
  }
  s.awaitingResponseSince = Date.now();
  saveDispatchSchedules();

  pushDispatchMessage(runtimeKey, s.message, s.id);

  // ── CallEnvelope compatibility bridge ──
  // Create and enqueue an envelope alongside the legacy dispatch message.
  // The envelopeId is written back to the schedule so future arbiter code
  // can correlate schedule → envelope.
  const envelope = createCallEnvelope({
    runtimeKey,
    agentId,
    sessionId: sessionId || '',
    source: EnvelopeSource.DISPATCH,
    sourceRef: s.id,
    text: s.message,
  });
  enqueueRuntimeEnvelope(envelope);
  refreshRuntimeExecutionState(runtimeKey);
  s.envelopeId = envelope.id;
  saveDispatchSchedules();

  console.log(`[Dispatch] fired → ${agentId}::${sessionId} (runtimeKey=${runtimeKey}, envelope=${envelope.id}): ${s.message.slice(0, 50)}...`);
}

async function fireDispatchNow(schedule) {
  const { dispatchSchedules, dispatchTimers } = _shared;
  const _ctx = _shared.getCtx();
  const { emitDispatchReadyEvent, saveDispatchSchedules } = _shared;

  const s = dispatchSchedules.get(schedule.id);
  if (!s || s.status !== 'pending') return;

  // ── start_agent action: just start the runtime, no message/envelope/watchdog ──
  const actionType = s.action?.type || 'send_message';
  const isOnBoot = s.trigger?.type === 'on-boot';

  if (actionType === 'start_agent') {
    const targetList = Array.isArray(s.targets) && s.targets.length > 0
      ? s.targets
      : [{ agentId: s.targetAgentId, sessionId: s.targetSessionId }];

    for (const target of targetList) {
      const agentId = target.agentId || s.targetAgentId;
      let sessionId = target.sessionId || s.targetSessionId;
      try {
        const agent = await _ctx.requirePrebuiltAgentForRuntime(agentId);
        // Skip qqbot auto-start when no IM channel is selected
        if (sanitizeSessionFragment(agentId) === 'qqbot') {
          const wsConfig = await _ctx.readProjectIMWorkspaceConfig();
          if (!wsConfig.selectedChannel) {
            console.log(`[Dispatch] start_agent skipped for ${agentId}: 未选择 IM 渠道`);
            continue;
          }
        }
        // Resolve __latest__ to the actual latest session from the session index
        if (!sessionId || sessionId === '__latest__') {
          const idx = await readSessionIndex(agentId);
          if (idx.activeSessionId) {
            sessionId = idx.activeSessionId;
          } else if (idx.sessions.length > 0) {
            sessionId = idx.sessions[idx.sessions.length - 1].id;
          }
        }
        if (sessionId) {
          await _ctx.activatePrebuiltSession(agentId, sessionId);
        }
        await _ctx.startManagedAgent(agent, sessionId || undefined);
        const connected = await _ctx.waitForManagedRuntimeReady(agent.id, 15000, sessionId || undefined);
        console.log(`[Dispatch] start_agent: ${agentId} session=${sessionId || '(auto)'} connected=${!!connected}`);
        if (isOnBoot) {
          emitDispatchReadyEvent(agent.id, sessionId);
        }
      } catch (err) {
        console.error(`[Dispatch] start_agent failed for ${agentId}:`, err.message);
      }
    }

    // on-boot stays pending (persistent); other triggers mark completed
    if (!isOnBoot) {
      s.status = 'completed';
      s.completedAt = new Date().toISOString();
      saveDispatchSchedules();
    }
    return;
  }

  // ── send_message action: existing logic ──
  s.status = 'fired';
  s.firedAt = new Date().toISOString();
  s.awaitingResponseSince = Date.now();
  saveDispatchSchedules();

  // 启动 fired 超时看门狗
  const watchdogKey = `__watchdog_${s.id}`;
  const watchdog = setTimeout(() => {
    const current = dispatchSchedules.get(s.id);
    if (current && current.status === 'fired') {
      current.status = 'failed';
      current.result = current.result || '(dispatch response timed out)';
      current.lastError = 'runtime did not respond before timeout';
      current.completedAt = new Date().toISOString();
      if (current.envelopeId) {
        updateEnvelopeStatus(current.envelopeId, {
          status: EnvelopeStatus.FAILED,
          error: current.lastError,
          result: current.result,
        });
        if (current.resolvedRuntimeKey) refreshRuntimeExecutionState(current.resolvedRuntimeKey);
      }
      saveDispatchSchedules();
      console.warn(`[Dispatch] watchdog: schedule ${s.id} timed out, marking failed`);
    }
  }, DISPATCH_FIRED_TIMEOUT_MS);
  dispatchTimers.set(watchdogKey, watchdog);

  // Phase 4: multi-target support
  if (Array.isArray(s.targets) && s.targets.length > 0) {
    await Promise.allSettled(s.targets.map(target => fireSingleTarget(s, target)));
  } else {
    await fireSingleTarget(s, {
      agentId: s.targetAgentId,
      sessionId: s.targetSessionId,
      newSessionType: s.newSessionType,
      projectId: s.projectId,
    });
  }
}

// ── Boot recovery ─────────────────────────────────────────────────

/**
 * 统一启动恢复 sweep：对所有 schedule 按状态和触发类型做恢复处理。
 * 覆盖场景：pending timer（未来/过期）、pending on-idle、pending on-ready、
 * fired（刚触发/已超时）。
 */
function restoreDispatchSchedulesOnBoot() {
  const { dispatchSchedules, dispatchTimers } = _shared;
  const { saveDispatchSchedules, scheduleDispatchFire, emitDispatchReadyEvent } = _shared;

  let restoredTimers = 0, restoredIdle = 0, restoredReady = 0;
  let expiredTimersFired = 0, firedTimeouts = 0;
  let restoredBoot = 0;

  for (const s of dispatchSchedules.values()) {
    const triggerType = s.trigger?.type || 'timer';

    // ── fired：检查是否超时 ──
    if (s.status === 'fired') {
      const since = s.awaitingResponseSince || (s.firedAt ? new Date(s.firedAt).getTime() : 0);
      const elapsed = since ? (Date.now() - since) : DISPATCH_FIRED_TIMEOUT_MS + 1;
      if (elapsed >= DISPATCH_FIRED_TIMEOUT_MS) {
        s.status = 'failed';
        s.result = s.result || '(dispatch response timed out after server restart)';
        s.lastError = 'runtime did not respond before timeout';
        s.completedAt = new Date().toISOString();
        if (s.envelopeId) {
          updateEnvelopeStatus(s.envelopeId, {
            status: EnvelopeStatus.FAILED,
            error: s.lastError,
            result: s.result,
          });
          if (s.resolvedRuntimeKey) refreshRuntimeExecutionState(s.resolvedRuntimeKey);
        }
        firedTimeouts++;
        console.warn(`[Dispatch] recovery: schedule ${s.id} fired too long (${Math.round(elapsed / 1000)}s), marking failed`);
      } else {
        // 刚触发不久，仍然在等待响应，保留 fired 状态但启动超时看门狗
        const remaining = DISPATCH_FIRED_TIMEOUT_MS - elapsed;
        const watchdog = setTimeout(() => {
          const current = dispatchSchedules.get(s.id);
          if (current && current.status === 'fired') {
            current.status = 'failed';
            current.result = current.result || '(dispatch response timed out)';
            current.lastError = 'runtime did not respond before timeout';
            current.completedAt = new Date().toISOString();
            if (current.envelopeId) {
              updateEnvelopeStatus(current.envelopeId, {
                status: EnvelopeStatus.FAILED,
                error: current.lastError,
                result: current.result,
              });
              if (current.resolvedRuntimeKey) refreshRuntimeExecutionState(current.resolvedRuntimeKey);
            }
            saveDispatchSchedules();
            console.warn(`[Dispatch] watchdog: schedule ${s.id} timed out, marking failed`);
          }
        }, remaining);
        // 不存到 dispatchTimers，因为这是超时看门狗不是定时 fire
        dispatchTimers.set(`__watchdog_${s.id}`, watchdog);
      }
      continue;
    }

    // ── 以下只处理 pending ──
    if (s.status !== 'pending') continue;

    if (triggerType === 'timer') {
      const fireAt = new Date(s.fireAt).getTime();
      if (fireAt > Date.now()) {
        // 未来 timer：正常恢复
        scheduleDispatchFire(s);
        restoredTimers++;
      } else {
        // 过期 timer：立即 fire（当前系统语义更偏向"错过也应执行"的续接任务）
        console.log(`[Dispatch] recovery: expired timer ${s.id} (fireAt=${s.fireAt}), firing now`);
        fireDispatchNow(s);
        expiredTimersFired++;
      }
    } else if (triggerType === 'on-idle') {
      scheduleDispatchFire(s);
      restoredIdle++;
    } else if (triggerType === 'on-ready') {
      // 恢复到监听体系：emitDispatchReadyEvent 会在 runtime 启动时被调用，
      // 但如果当前已有 runtime 处于 ready 状态，也需要立即检查一次
      restoredReady++;
    } else if (triggerType === 'on-boot') {
      // on-boot schedules are fired by fireBootSchedules() after server is fully ready
      restoredBoot++;
    }
  }

  // 对 on-ready schedule 做即时匹配：如果目标 runtime 已经在运行，立即触发
  for (const s of dispatchSchedules.values()) {
    if (s.status !== 'pending' || s.trigger?.type !== 'on-ready') continue;
    const agentId = s.targetAgentId;
    // 检查该 agent 是否有活跃 runtime
    const runtimes = listAgentRuntimes(agentId);
    for (const rt of runtimes) {
      if (!rt.stopped && rt.process?.exitCode === null) {
        const sessionId = rt.sessionId || null;
        // 检查是否匹配 targetSessionId
        if (s.targetSessionId && s.targetSessionId !== '__latest__' && s.targetSessionId !== sessionId) continue;
        // runtime 正在运行，触发 ready 事件
        emitDispatchReadyEvent(agentId, sessionId);
        break;
      }
    }
  }

  if (restoredTimers + restoredIdle + restoredReady + restoredBoot + expiredTimersFired + firedTimeouts > 0) {
    saveDispatchSchedules();
    console.log(`[Dispatch] recovery sweep: ${restoredTimers} timers, ${restoredIdle} idle, ${restoredReady} ready, ${restoredBoot} boot restored; ${expiredTimersFired} expired timers fired; ${firedTimeouts} fired timed out`);
  }
}

async function fireBootSchedules() {
  const { dispatchSchedules } = _shared;

  for (const s of dispatchSchedules.values()) {
    if (s.status !== 'pending' || s.trigger?.type !== 'on-boot') continue;
    console.log(`[Dispatch] on-boot: ${s.action?.type || 'send_message'} → ${s.targetAgentId}`);
    await fireDispatchNow(s);
  }
}

// ── Exports ───────────────────────────────────────────────────────

export {
  fireSingleTarget,
  fireDispatchNow,
  restoreDispatchSchedulesOnBoot,
  fireBootSchedules,
};
