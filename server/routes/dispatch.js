/**
 * Dispatch scheduling system + project adapter registry.
 *
 * Extracted from server.js Phase 3.
 *
 * Dependencies injected via ctx:
 *   readWorkspaceState, writeWorkspaceState, readProjectIMWorkspaceConfig,
 *   listPrebuiltSessions, requirePrebuiltAgentForRuntime,
 *   createPrebuiltSession, startManagedAgent,
 *   waitForManagedRuntimeReady, activatePrebuiltSession
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

import {
  createCallEnvelope,
  enqueueRuntimeEnvelope,
  refreshRuntimeExecutionState,
  updateEnvelopeStatus,
  EnvelopeSource,
  EnvelopeStatus,
} from '../runtime-call-envelope.js';
import { USER_DATA_ROOT } from '../shared/constants.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import {
  getManagedRuntimeKey,
  getAgentRuntime,
  listAgentRuntimes,
} from '../shared/agent-access.js';
import { readSessionIndex } from '../shared/session-access.js';
import { onRuntimeReady } from '../shared/runtime-hooks.js';

// ── Module state ──────────────────────────────────────────────────

let DISPATCH_SCHEDULES_PATH = path.join(USER_DATA_ROOT, 'dispatch-schedules.json');

const dispatchSchedules = new Map();       // scheduleId → schedule object
const dispatchQueue = new Map();           // runtimeKey → [{ id, text, scheduleId }]
const dispatchPendingPolls = new Map();    // runtimeKey → resolveFn
const dispatchTimers = new Map();          // scheduleId → setTimeout handle
const dispatchRuntimeActivity = new Map(); // runtimeKey → { lastActiveAt, status: 'idle'|'active' }
const dispatchIdleCheckers = new Map();    // scheduleId → setInterval handle (for on-idle triggers)

const DISPATCH_FIRED_TIMEOUT_MS = 5 * 60 * 1000; // fired schedule 超时阈值：5 分钟

// ── ctx injection (set by setupDispatchRoutes or setDispatchCtx) ──

let _ctx = {};

// ── Project abstraction layer ─────────────────────────────────────

const projectAdapters = new Map();

function registerProjectAdapter(adapter) {
  if (adapter && adapter.workspaceId) {
    projectAdapters.set(adapter.workspaceId, adapter);
  }
}

function getProjectAdapter(agentId) {
  return projectAdapters.get(agentId) || null;
}

class ProgrammingHelperProjectAdapter {
  constructor() {
    this.workspaceId = 'programming-helper';
  }

  extractProjectId(session) {
    const openDirectory = session?.openDirectory;
    if (!openDirectory) return null;
    return `dir:${String(openDirectory).replace(/\\/g, '/').toLowerCase()}`;
  }

  async getCurrentProject() {
    try {
      const workspaceState = await _ctx.readWorkspaceState(this.workspaceId);
      const openDirectory = workspaceState?.openDirectory;
      if (!openDirectory) return null;

      const projectId = this.extractProjectId({ openDirectory });
      const projectName = openDirectory.split(/[\\/]/).filter(Boolean).pop() || 'UntitledProject';

      return {
        id: projectId,
        name: projectName,
        type: 'directory',
        workspaceId: this.workspaceId,
        config: { openDirectory },
        sessionIds: [],
        latestSessionId: null,
        createdAt: workspaceState.updatedAt,
        updatedAt: workspaceState.updatedAt,
      };
    } catch (err) {
      console.error(`[ProjectAdapter] Failed to get current project for ${this.workspaceId}:`, err.message);
      return null;
    }
  }

  getProjectConfig(projectId) {
    if (!projectId || !projectId.startsWith('dir:')) {
      return {};
    }
    const openDirectory = projectId.slice(4); // Remove 'dir:' prefix
    return { openDirectory };
  }

  async listProjects() {
    const current = await this.getCurrentProject();
    return current ? [current] : [];
  }

  async activateProject(projectId) {
    const config = this.getProjectConfig(projectId);
    if (!config.openDirectory) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    // Only update openDirectory, do not overwrite forms or other state
    await _ctx.writeWorkspaceState(this.workspaceId, {
      openDirectory: config.openDirectory,
    });
  }
}

class QqbotProjectAdapter {
  constructor() {
    this.workspaceId = 'qqbot';
  }

  extractProjectId(_session) {
    // 门户代理作为一个整体项目，没有子项目区分
    return 'qqbot';
  }

  async getCurrentProject() {
    try {
      const config = await _ctx.readProjectIMWorkspaceConfig();
      return {
        id: 'qqbot',
        name: '门户代理',
        type: 'im-portal',
        workspaceId: this.workspaceId,
        config: { selectedChannel: config.selectedChannel || 'qq' },
        sessionIds: [],
        latestSessionId: config.receptionistSessionId || null,
        createdAt: null,
        updatedAt: null,
      };
    } catch (err) {
      console.error(`[ProjectAdapter] Failed to get current project for ${this.workspaceId}:`, err.message);
      return null;
    }
  }

  getProjectConfig(projectId) {
    if (projectId !== 'qqbot') return {};
    return { selectedChannel: 'qq' };
  }

  async activateProject(_projectId) {
    // 门户代理只有一个项目，无需切换
  }

  async listProjects() {
    const current = await this.getCurrentProject();
    return current ? [current] : [];
  }
}

// ── Dispatch helper functions ─────────────────────────────────────

function loadDispatchSchedules() {
  try {
    if (!existsSync(DISPATCH_SCHEDULES_PATH)) return;
    const raw = JSON.parse(readFileSync(DISPATCH_SCHEDULES_PATH, 'utf8'));
    const arr = Array.isArray(raw?.schedules) ? raw.schedules : [];
    for (const s of arr) {
      if (s && s.id) dispatchSchedules.set(s.id, s);
    }
  } catch {}
}

function saveDispatchSchedules() {
  const arr = Array.from(dispatchSchedules.values());
  writeFileSync(DISPATCH_SCHEDULES_PATH, JSON.stringify({ schedules: arr }, null, 2), 'utf8');
}

function pushDispatchMessage(runtimeKey, text, scheduleId = null) {
  const msg = { id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, scheduleId };
  // if a poll is already waiting, deliver directly — no need to queue
  const resolver = dispatchPendingPolls.get(runtimeKey);
  if (resolver) {
    dispatchPendingPolls.delete(runtimeKey);
    resolver(msg);
    return;
  }
  // otherwise queue for next poll
  const queue = dispatchQueue.get(runtimeKey);
  if (queue) {
    queue.push(msg);
  } else {
    dispatchQueue.set(runtimeKey, [msg]);
  }
}

function scheduleDispatchFire(schedule) {
  const triggerType = schedule.trigger?.type || 'timer';

  if (triggerType === 'timer') {
    const fireAt = new Date(schedule.fireAt).getTime();
    const delay = fireAt - Date.now();
    if (delay <= 0) {
      fireDispatchNow(schedule);
      return;
    }
    const handle = setTimeout(() => {
      dispatchTimers.delete(schedule.id);
      fireDispatchNow(schedule);
    }, delay);
    dispatchTimers.set(schedule.id, handle);
  } else if (triggerType === 'on-idle') {
    // Start periodic check for idle trigger
    const threshold = (schedule.trigger.idleThreshold || 300) * 1000;
    const minInterval = (schedule.repeatInterval || 0) * 1000; // minimum time between consecutive fires
    const interval = Math.max(Math.floor(threshold / 3), 5000);
    const earliestNext = minInterval > 0 ? (schedule._lastFiredAt || 0) + minInterval : 0;
    const handle = setInterval(() => {
      if (schedule.status !== 'pending') {
        clearInterval(handle);
        dispatchIdleCheckers.delete(schedule.id);
        return;
      }
      // Enforce minimum trigger interval (cooldown)
      if (earliestNext > 0 && Date.now() < earliestNext) return;
      // For __latest__ or null targetSessionId, check all runtimes of the agent
      let isIdle = false;
      if (!schedule.targetSessionId || schedule.targetSessionId === '__latest__') {
        const prefix = sanitizeSessionFragment(schedule.targetAgentId) + '::';
        for (const [key, activity] of dispatchRuntimeActivity) {
          if (!key.startsWith(prefix)) continue;
          if (activity.status !== 'idle') continue;
          const idleMs = Date.now() - (activity.lastActiveAt || 0);
          if (idleMs >= threshold) { isIdle = true; break; }
        }
      } else {
        const runtimeKey = getManagedRuntimeKey(schedule.targetAgentId, schedule.targetSessionId);
        const activity = dispatchRuntimeActivity.get(runtimeKey);
        if (activity && activity.status === 'idle') {
          const idleMs = Date.now() - (activity.lastActiveAt || 0);
          if (idleMs >= threshold) isIdle = true;
        }
      }
      if (isIdle) {
        clearInterval(handle);
        dispatchIdleCheckers.delete(schedule.id);
        fireDispatchNow(schedule);
      }
    }, interval);
    dispatchIdleCheckers.set(schedule.id, handle);
  }
  // 'on-ready' is handled by emitDispatchReadyEvent() below
}

function emitDispatchReadyEvent(agentId, sessionId) {
  for (const s of dispatchSchedules.values()) {
    if (s.status !== 'pending') continue;
    if (s.trigger?.type !== 'on-ready') continue;
    // Match by agentId (schedule may target the workspace or a specific session)
    if (s.targetAgentId !== agentId) continue;
    if (s.targetSessionId && s.targetSessionId !== sessionId) continue;
    fireDispatchNow(s);
  }
}

function cancelEventTrigger(scheduleId) {
  const handle = dispatchIdleCheckers.get(scheduleId);
  if (handle) {
    clearInterval(handle);
    dispatchIdleCheckers.delete(scheduleId);
  }
}

async function fireSingleTarget(s, target) {
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

/**
 * 统一启动恢复 sweep：对所有 schedule 按状态和触发类型做恢复处理。
 * 覆盖场景：pending timer（未来/过期）、pending on-idle、pending on-ready、
 * fired（刚触发/已超时）。
 */
function restoreDispatchSchedulesOnBoot() {
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
  for (const s of dispatchSchedules.values()) {
    if (s.status !== 'pending' || s.trigger?.type !== 'on-boot') continue;
    console.log(`[Dispatch] on-boot: ${s.action?.type || 'send_message'} → ${s.targetAgentId}`);
    await fireDispatchNow(s);
  }
}

// ── Route setup ───────────────────────────────────────────────────

export function setupDispatchRoutes(app, express, ctx) {
  _ctx = ctx;

  // Initialize: register project adapters
  registerProjectAdapter(new ProgrammingHelperProjectAdapter());
  registerProjectAdapter(new QqbotProjectAdapter());

  // ── Dispatch init (was module-top-level in server.js) ──
  loadDispatchSchedules();
  restoreDispatchSchedulesOnBoot();

  // Phase 0: register runtime-ready callback for event-driven dispatch schedules
  onRuntimeReady((agentId, sessionId) => emitDispatchReadyEvent(agentId, sessionId));

  // ── Dispatch API routes ──────────────────────────────────────────

  app.get('/protoclaw/dispatch/projects', async (_req, res) => {
    const agentId = String(_req.query.agentId || '').trim();
    if (!agentId) return res.status(400).json({ error: 'agentId required' });

    const adapter = getProjectAdapter(agentId);
    if (!adapter) {
      return res.json({ projects: [] });
    }

    try {
      // Aggregate projects from workspace state + sessions
      const currentState = await _ctx.readWorkspaceState(agentId);
      const sessionsResult = await _ctx.listPrebuiltSessions(agentId);
      const sessions = sessionsResult?.sessions || [];
      const projectsMap = new Map();

      const upsertProject = (rawProject) => {
        const id = adapter.extractProjectId(rawProject);
        if (!id) return null;
        const existing = projectsMap.get(id);
        const merged = existing || {
          id,
          name: rawProject.openDirectory
            ? rawProject.openDirectory.split(/[\\/]/).filter(Boolean).pop() || 'Unnamed'
            : 'Unnamed',
          type: 'directory',
          config: adapter.getProjectConfig(id),
          sessionIds: [],
          latestSessionId: null,
          createdAt: rawProject.createdAt,
          updatedAt: rawProject.updatedAt,
        };
        projectsMap.set(id, merged);
        return merged;
      };

      // Add current workspace state as a project
      if (currentState?.openDirectory) {
        upsertProject({ openDirectory: currentState.openDirectory, updatedAt: currentState.updatedAt });
      }

      // Add projects from state-managed list
      const stateProjects = Array.isArray(currentState?.phProjects) ? currentState.phProjects : [];
      stateProjects.forEach(p => upsertProject(p));

      // Add projects from sessions
      (sessions || []).forEach(session => {
        const project = upsertProject(session);
        if (project) {
          project.sessionIds.push(session.id);
          if (!project.latestSessionId) {
            project.latestSessionId = session.id;
          }
        }
      });

      const projects = Array.from(projectsMap.values());
      res.json({ projects });
    } catch (err) {
      console.error('[Dispatch] Failed to list projects:', err.message);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  });

  app.get('/protoclaw/dispatch/schedules', (_req, res) => {
    res.json({ schedules: Array.from(dispatchSchedules.values()) });
  });

  app.post('/protoclaw/dispatch/schedules', express.json(), async (req, res, next) => {
    try {
      const body = req.body || {};
      const { targetAgentId, targetSessionId, message, secondsFromNow, newSessionType, projectId, trigger, targets, repeatInterval, loopMaxCount, loopEndTime, onlyActiveSessions, action } = body;
      const actionType = action?.type || 'send_message';

      // start_agent tasks don't require a message
      if (actionType !== 'start_agent' && (!message || typeof message !== 'string')) {
        return res.status(400).json({ error: 'message is required' });
      }

      const triggerType = trigger?.type || 'timer';
      // timer triggers require secondsFromNow; on-boot does not
      if (triggerType === 'timer') {
        const secs = Number(secondsFromNow);
        if (!Number.isFinite(secs) || secs <= 0) {
          return res.status(400).json({ error: 'secondsFromNow must be a positive number for timer triggers' });
        }
      }

      const agentId = targetAgentId || 'programming-helper';
      const fireAt = triggerType === 'timer'
        ? new Date(Date.now() + Number(secondsFromNow) * 1000).toISOString()
        : new Date().toISOString(); // event triggers use now as reference
      const id = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const schedule = {
        id,
        fireAt,
        targetAgentId: agentId,
        targetSessionId: targetSessionId || null,
        newSessionType: newSessionType || null,
        projectId: projectId || null,
        trigger: triggerType !== 'timer' ? { type: triggerType, idleThreshold: trigger?.idleThreshold || 300 } : null,
        action: actionType !== 'send_message' ? { type: actionType } : null,
        targets: Array.isArray(targets) && targets.length > 0 ? targets : null,
        repeatInterval: Number(repeatInterval) > 0 ? Number(repeatInterval) : null,
        loopMaxCount: Number(loopMaxCount) > 0 ? Number(loopMaxCount) : null,
        loopEndTime: Number(loopEndTime) > 0 ? Number(loopEndTime) : null,
        loopFiredCount: 0,
        onlyActiveSessions: !!onlyActiveSessions,
        message: message || '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        firedAt: null,
        result: null,
      };
      dispatchSchedules.set(id, schedule);
      saveDispatchSchedules();
      // on-boot schedules are fired by fireBootSchedules() on server ready, not here
      if (triggerType !== 'on-boot') {
        scheduleDispatchFire(schedule);
      }
      res.json(schedule);
    } catch (error) { next(error); }
  });

  app.delete('/protoclaw/dispatch/schedules/:id', (req, res) => {
    const s = dispatchSchedules.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.status === 'pending') {
      const handle = dispatchTimers.get(s.id);
      if (handle) { clearTimeout(handle); dispatchTimers.delete(s.id); }
      cancelEventTrigger(s.id);
      s.status = 'cancelled';
      saveDispatchSchedules();
    } else if (s.status === 'fired') {
      // 清除看门狗定时器
      const watchdogKey = `__watchdog_${s.id}`;
      const watchdog = dispatchTimers.get(watchdogKey);
      if (watchdog) { clearTimeout(watchdog); dispatchTimers.delete(watchdogKey); }
      // Stuck in fired — runtime likely crashed or never responded
      s.status = 'cancelled';
      s.result = '(cancelled while firing)';
      if (s.envelopeId) {
        updateEnvelopeStatus(s.envelopeId, {
          status: EnvelopeStatus.CANCELLED,
          result: s.result,
        });
        if (s.resolvedRuntimeKey) refreshRuntimeExecutionState(s.resolvedRuntimeKey);
      }
      saveDispatchSchedules();
    }
    res.json({ ok: true });
  });

  app.get('/protoclaw/dispatch/poll', async (req, res) => {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId || null;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const timeoutMs = Math.min(Number(req.query.timeout) || 25, 30) * 1000;
    const runtimeKey = getManagedRuntimeKey(agentId, sessionId);

    const queue = dispatchQueue.get(runtimeKey);
    if (queue && queue.length > 0) {
      return res.json(queue.shift());
    }

    // long-poll: wait for message or timeout
    const timer = setTimeout(() => {
      dispatchPendingPolls.delete(runtimeKey);
      res.status(204).end();
    }, timeoutMs);

    dispatchPendingPolls.set(runtimeKey, (msg) => {
      clearTimeout(timer);
      dispatchPendingPolls.delete(runtimeKey);
      res.json(msg);
    });
  });

  app.post('/protoclaw/dispatch/respond', express.json(), (req, res) => {
    const { scheduleId, response, error } = req.body || {};
    if (scheduleId) {
      const s = dispatchSchedules.get(scheduleId);
      if (s) {
        // start_agent schedules don't expect responses; just acknowledge
        if ((s.action?.type || 'send_message') === 'start_agent') {
          return res.json({ ok: true });
        }
        // 清除看门狗定时器（如果存在）
        const watchdogKey = `__watchdog_${scheduleId}`;
        const watchdog = dispatchTimers.get(watchdogKey);
        if (watchdog) { clearTimeout(watchdog); dispatchTimers.delete(watchdogKey); }

        // Update activity tracking for the target runtime
        // 优先使用 fire 阶段解析后的真实目标，避免 __latest__ 导致 key 错位
        const resolvedSessionId = s.resolvedTargetSessionId || s.targetSessionId;
        const runtimeKey = s.resolvedRuntimeKey || getManagedRuntimeKey(s.targetAgentId, resolvedSessionId);
        dispatchRuntimeActivity.set(runtimeKey, { lastActiveAt: Date.now(), status: 'active' });
        if (s.envelopeId) {
          updateEnvelopeStatus(s.envelopeId, {
            status: error ? EnvelopeStatus.FAILED : EnvelopeStatus.COMPLETED,
            error: error || null,
            result: error || response || '',
          });
          refreshRuntimeExecutionState(runtimeKey);
        }

        // Check if this is a repeating schedule (Phase 2: repeatInterval)
        if (!error && s.repeatInterval && s.repeatInterval > 0) {
          s.loopFiredCount = (s.loopFiredCount || 0) + 1;
          // Check loop termination conditions
          const maxReached = s.loopMaxCount && s.loopFiredCount >= s.loopMaxCount;
          const timeReached = s.loopEndTime && Date.now() >= s.loopEndTime;
          if (maxReached || timeReached) {
            s.status = 'completed';
            s.result = (maxReached ? 'Reached max count' : 'Reached end time') + (response ? ': ' + response : '');
            s.completedAt = new Date().toISOString();
            saveDispatchSchedules();
          } else {
            // Re-arm: only on-ready needs to become a timer after the first fire.
            // on-idle already has dedicated checker logic and should remain on-idle.
            if (s.trigger?.type === 'on-ready' && !s.trigger.originalType) {
              s.trigger.originalType = s.trigger.type;
              s.trigger.type = 'timer';
            }
            s.status = 'pending';
            s.fireAt = new Date(Date.now() + s.repeatInterval * 1000).toISOString();
            s.firedAt = new Date().toISOString();
            s._lastFiredAt = Date.now(); // track for on-idle cooldown
            s.result = response || '';
            saveDispatchSchedules();
            scheduleDispatchFire(s);
          }
        } else {
          s.status = error ? 'failed' : 'completed';
          s.result = error || response || '';
          s.completedAt = new Date().toISOString();
          saveDispatchSchedules();
        }
      }
    }
    res.json({ ok: true });
  });

  app.post('/protoclaw/dispatch/agent_status', express.json(), (req, res) => {
    const { agentId, sessionId, status } = req.body || {};
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const runtimeKey = getManagedRuntimeKey(agentId, sessionId || null);
    dispatchRuntimeActivity.set(runtimeKey, { lastActiveAt: Date.now(), status: status || 'idle' });
    res.json({ ok: true });
  });
}

// ── Test/utility exports ──────────────────────────────────────────

export function resetDispatchState() {
  for (const handle of dispatchTimers.values()) {
    clearTimeout(handle);
  }
  dispatchTimers.clear();
  for (const handle of dispatchIdleCheckers.values()) {
    clearInterval(handle);
  }
  dispatchIdleCheckers.clear();
  dispatchSchedules.clear();
  dispatchQueue.clear();
  dispatchPendingPolls.clear();
  dispatchRuntimeActivity.clear();
}

export function setSchedulesPath(p) {
  DISPATCH_SCHEDULES_PATH = p;
}

export function setDispatchCtx(ctx) {
  _ctx = ctx;
}

export function getDispatchState() {
  return {
    dispatchSchedules,
    dispatchQueue,
    dispatchPendingPolls,
    dispatchTimers,
    dispatchRuntimeActivity,
    dispatchIdleCheckers,
  };
}

export {
  // Public API
  getProjectAdapter,
  fireBootSchedules,
  // Internal exports (for testing + reuse)
  loadDispatchSchedules,
  saveDispatchSchedules,
  pushDispatchMessage,
  scheduleDispatchFire,
  emitDispatchReadyEvent,
  cancelEventTrigger,
  fireSingleTarget,
  fireDispatchNow,
  restoreDispatchSchedulesOnBoot,
  registerProjectAdapter,
};
