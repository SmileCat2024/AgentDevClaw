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
  refreshRuntimeExecutionState,
  updateEnvelopeStatus,
  EnvelopeStatus,
} from '../runtime-call-envelope.js';
import { USER_DATA_ROOT, LONG_POLL_DEFAULT_SEC, LONG_POLL_MAX_SEC, DISPATCH_IDLE_THRESHOLD_DEFAULT_SEC, DISPATCH_IDLE_POLL_MIN_MS } from '../shared/constants.js';
import { getDefaultIMChannelId } from '../shared/im-channels.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import {
  getManagedRuntimeKey,
} from '../shared/agent-access.js';
import { onRuntimeReady } from '../shared/runtime-hooks.js';

import {
  initDispatchEngine,
  fireSingleTarget,
  fireDispatchNow,
  restoreDispatchSchedulesOnBoot,
  fireBootSchedules,
} from './dispatch-engine.js';

// ── Module state ──────────────────────────────────────────────────

let DISPATCH_SCHEDULES_PATH = path.join(USER_DATA_ROOT, 'dispatch-schedules.json');

const dispatchSchedules = new Map();       // scheduleId → schedule object
const dispatchQueue = new Map();           // runtimeKey → [{ id, text, scheduleId }]
const dispatchPendingPolls = new Map();    // runtimeKey → resolveFn
const dispatchTimers = new Map();          // scheduleId → setTimeout handle
const dispatchRuntimeActivity = new Map(); // runtimeKey → { lastActiveAt, status: 'idle'|'active' }
const dispatchIdleCheckers = new Map();    // scheduleId → setInterval handle (for on-idle triggers)

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
        config: { selectedChannel: config.selectedChannel || getDefaultIMChannelId() },
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
    return { selectedChannel: getDefaultIMChannelId() };
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
    const threshold = (schedule.trigger.idleThreshold || DISPATCH_IDLE_THRESHOLD_DEFAULT_SEC) * 1000;
    const minInterval = (schedule.repeatInterval || 0) * 1000; // minimum time between consecutive fires
    const interval = Math.max(Math.floor(threshold / 3), DISPATCH_IDLE_POLL_MIN_MS);
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

// ── Fire logic + boot recovery live in dispatch-engine.js ─────────
// The following functions are imported from ./dispatch-engine.js:
//   fireSingleTarget, fireDispatchNow, restoreDispatchSchedulesOnBoot, fireBootSchedules
// They access shared state via the _shared object wired in setDispatchCtx().

// ── Route setup ───────────────────────────────────────────────────

export function setupDispatchRoutes(app, express, ctx) {
  setDispatchCtx(ctx);

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
    const timeoutMs = Math.min(Number(req.query.timeout) || LONG_POLL_DEFAULT_SEC, LONG_POLL_MAX_SEC) * 1000;
    const runtimeKey = getManagedRuntimeKey(agentId, sessionId);

    const queue = dispatchQueue.get(runtimeKey);
    if (queue && queue.length > 0) {
      return res.json(queue.shift());
    }

    // One runtime has one polling consumer. Replace an older waiter explicitly
    // so it cannot later delete or respond in place of this request.
    const previous = dispatchPendingPolls.get(runtimeKey);
    previous?.cancel?.();

    let settled = false;
    let timer = null;
    const settle = (send) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (dispatchPendingPolls.get(runtimeKey) === resolver) {
        dispatchPendingPolls.delete(runtimeKey);
      }
      send?.();
    };
    const resolver = (msg) => settle(() => res.json(msg));
    resolver.cancel = () => settle(() => res.status(204).end());

    timer = setTimeout(() => settle(() => res.status(204).end()), timeoutMs);
    dispatchPendingPolls.set(runtimeKey, resolver);

    req.once('close', () => settle());
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
  // Wire shared state into the engine module so fire/boot functions
  // can access Maps, _ctx, and helper functions without circular imports.
  initDispatchEngine({
    dispatchSchedules,
    dispatchTimers,
    getCtx: () => _ctx,
    saveDispatchSchedules,
    pushDispatchMessage,
    scheduleDispatchFire,
    emitDispatchReadyEvent,
    getProjectAdapter,
  });
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
