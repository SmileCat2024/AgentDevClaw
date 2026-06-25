import express from 'express';
import multer from 'multer';
import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';
import { randomUUID } from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { ViewerWorker } from 'agentdev';
import { WeixinApiClient } from '@agentdev/weixin-bot';
import {
  exportHistoryOnlyHandoffPackage,
  readHandoffPackage,
} from './server/context-continuity/handoff-package.js';
import { exportSummarizedHandoffPackage, writeSummarizedHandoffPackage } from './server/context-continuity/summarized-handoff.js';
import { ClawMCPServer } from './server/claw-mcp.js';
import {
  createCallEnvelope,
  enqueueRuntimeEnvelope,
  refreshRuntimeExecutionState,
  getRuntimeInboxSnapshot,
  getRuntimeExecutionState,
  listRuntimeExecutionStates,
  findEnvelopeById,
  findEnvelopesBySourceRef,
  updateEnvelopeStatus,
  EnvelopeSource,
  EnvelopeStatus,
} from './server/runtime-call-envelope.js';
import { renderConversationHtml } from './server/conversation-renderer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootRequire = createRequire(path.join(__dirname, 'package.json'));
const APP_PORT = Number.parseInt(process.env.PORT || '1420', 10);
const VIEWER_PORT = Number.parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
const AGENTS_ROOT = path.join(__dirname, 'prebuilt-agents');
const RUNTIME_SCRIPT = path.join(__dirname, 'scripts', 'run-prebuilt-agent.js');
const ONE_SHOT_SCRIPT = path.join(__dirname, 'scripts', 'run-one-shot-agent.js');
const AGENTDEV_ROOT = path.resolve(__dirname, '..', 'AgentDev');
const AGENTDEV_CREATE_FEATURE_CLI = path.join(AGENTDEV_ROOT, 'dist', 'create-feature-cli.js');
const VIEWER_ORIGIN = `http://127.0.0.1:${VIEWER_PORT}`;
const USER_DATA_ROOT = path.join(os.homedir(), '.agentdev', 'AgentDevClaw');
const NO_SESSION_TOKEN = '__protoclaw-no-session__';
const PREBUILT_SESSIONS_ROOT = path.join(USER_DATA_ROOT, 'prebuilt-sessions');
const PREBUILT_WORKSPACES_ROOT = path.join(USER_DATA_ROOT, 'workspaces');
const PROJECT_QQBOT_CONFIG_PATH = path.join(__dirname, '.agentdev', 'qqbot.config.json');
const PROJECT_WEIXIN_CONFIG_PATH = path.join(__dirname, '.agentdev', 'weixin-bot.config.json');
const PROJECT_IM_WORKSPACE_CONFIG_PATH = path.join(__dirname, '.agentdev', 'im-workspace.config.json');
const FEATURE_REPOSITORY_ROOT = path.join(__dirname, 'resources', 'features');
const USER_FEATURE_REPOSITORY_ROOT = path.join(USER_DATA_ROOT, 'user-features');
const FEATURE_MANIFEST_NAME = 'agentdev-feature.json';
const GROUP_CHATS_ROOT = path.join(USER_DATA_ROOT, 'group-chats');
const WORKSPACE_SESSION_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);
const HIDDEN_PREBUILT_AGENT_IDS = new Set(['agent-creator', 'flow-test']);
const PROJECT_DOCSET_SUBPATH = path.join('.agentdev', 'claw-workspace');
const MODEL_CONFIG_PATH = path.join(__dirname, 'config', 'default.json');
const MODEL_PRESETS_PATH = path.join(__dirname, 'config', 'presets.json');
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;

const app = express();
const viewerWorker = new ViewerWorker(VIEWER_PORT, false, process.env.AGENTDEV_UDS_PATH);
const clawMcp = new ClawMCPServer();
const managedAgents = new Map();
const assemblyRuntimeProcesses = new Map();
const pendingFeatureImports = new Map();
const weixinBindingSessions = new Map();

// ── Dispatch system ──────────────────────────────────────────────
const DISPATCH_SCHEDULES_PATH = path.join(USER_DATA_ROOT, 'dispatch-schedules.json');
const dispatchSchedules = new Map();       // scheduleId → schedule object
const dispatchQueue = new Map();           // runtimeKey → [{ id, text, scheduleId }]
const dispatchPendingPolls = new Map();    // runtimeKey → resolveFn
const dispatchTimers = new Map();          // scheduleId → setTimeout handle
const dispatchRuntimeActivity = new Map(); // runtimeKey → { lastActiveAt, status: 'idle'|'active' }
const dispatchIdleCheckers = new Map();    // scheduleId → setInterval handle (for on-idle triggers)


const DISPATCH_FIRED_TIMEOUT_MS = 5 * 60 * 1000; // fired schedule 超时阈值：5 分钟

// ── Project abstraction layer ───────────────────────────────────────
// Project adapter registry: workspaceId → adapter instance
const projectAdapters = new Map();

/**
 * Register a project adapter for a workspace
 */
function registerProjectAdapter(adapter) {
  if (adapter && adapter.workspaceId) {
    projectAdapters.set(adapter.workspaceId, adapter);
  }
}

/**
 * Get project adapter for a workspace
 */
function getProjectAdapter(agentId) {
  return projectAdapters.get(agentId) || null;
}

/**
 * Programming-helper project adapter
 * Projects are directory-based: project = openDirectory
 */
class ProgrammingHelperProjectAdapter {
  constructor() {
    this.workspaceId = 'programming-helper';
  }

  /**
   * Extract project ID from a session record
   */
  extractProjectId(session) {
    const openDirectory = session?.openDirectory;
    if (!openDirectory) return null;
    return `dir:${String(openDirectory).replace(/\\/g, '/').toLowerCase()}`;
  }

  /**
   * Get current active project from workspace state
   */
  async getCurrentProject() {
    try {
      const workspaceState = await readWorkspaceState(this.workspaceId);
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

  /**
   * Get project config by project ID
   */
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

  /**
   * Activate a project (update workspace state)
   */
  async activateProject(projectId) {
    const config = this.getProjectConfig(projectId);
    if (!config.openDirectory) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    // Only update openDirectory, do not overwrite forms or other state
    await writeWorkspaceState(this.workspaceId, {
      openDirectory: config.openDirectory,
    });
  }
}

// Initialize: register programming-helper adapter
registerProjectAdapter(new ProgrammingHelperProjectAdapter());

class QqbotProjectAdapter {
  constructor() {
    this.workspaceId = 'qqbot';
  }

  extractProjectId(session) {
    // 门户代理作为一个整体项目，没有子项目区分
    return 'qqbot';
  }

  async getCurrentProject() {
    try {
      const config = await readProjectIMWorkspaceConfig();
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

  async activateProject(projectId) {
    // 门户代理只有一个项目，无需切换
  }

  async listProjects() {
    const current = await this.getCurrentProject();
    return current ? [current] : [];
  }
}

registerProjectAdapter(new QqbotProjectAdapter());

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
      const sessionsResult = await listPrebuiltSessions(agentId);
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
      const agent = await requirePrebuiltAgentForRuntime(agentId);
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
          const workspaceState = await readWorkspaceState(agentId);
          if (workspaceState?.openDirectory) {
            createOpts.openDirectory = workspaceState.openDirectory;
          }
        } catch (err) {
          console.error(`[Dispatch] failed to read workspace state for ${agentId}:`, err.message);
        }
      }

      const session = await createPrebuiltSession(agentId, createOpts);
      sessionId = session.id;
      if (!s.targets) { s.targetSessionId = sessionId; saveDispatchSchedules(); }
      const runtimeOpts = {};
      if (sessionType !== 'main') {
        runtimeOpts.extraEnv = {
          PROTOCLAW_SESSION_TYPE: sessionType,
          PROTOCLAW_MODEL_PRESET_ROLE: sessionType === 'exploration' ? 'exploration' : 'sub',
        };
      }
      await startManagedAgent(agent, sessionId, runtimeOpts);
      const connected = await waitForManagedRuntimeReady(agent.id, 15000, sessionId);
      console.log(`[Dispatch] auto-started ${agentId} session=${sessionId} type=${sessionType} connected=${connected}`);
    } else {
      const runtime = getAgentRuntime(agentId, sessionId);
      if (!runtime || runtime.stopped || runtime.process?.exitCode !== null) {
        const agent = await requirePrebuiltAgentForRuntime(agentId);
        await activatePrebuiltSession(agentId, sessionId);
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
        await startManagedAgent(agent, sessionId, runtimeOpts);
        const connected = await waitForManagedRuntimeReady(agent.id, 15000, sessionId);
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
        const agent = await requirePrebuiltAgentForRuntime(agentId);
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
          await activatePrebuiltSession(agentId, sessionId);
        }
        await startManagedAgent(agent, sessionId || undefined);
        const connected = await waitForManagedRuntimeReady(agent.id, 15000, sessionId || undefined);
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

loadDispatchSchedules();
restoreDispatchSchedulesOnBoot();

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

function getManagedRuntimeKey(agentId, sessionId = null) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const normalizedSessionId = sessionId == null ? NO_SESSION_TOKEN : sanitizeSessionFragment(sessionId);
  return `${normalizedAgentId}::${normalizedSessionId}`;
}

function log(prefix, message, stream = 'log') {
  console[stream](`[${prefix}] ${message}`);
}

function listAgentRuntimes(agentId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  return Array.from(managedAgents.values()).filter((runtime) => sanitizeSessionFragment(runtime.agentId || runtime.id) === normalizedAgentId);
}

function pickPrimaryAgentRuntime(agentId) {
  const runtimes = listAgentRuntimes(agentId);
  if (runtimes.length === 0) return null;
  const running = runtimes.filter((runtime) => runtime?.process && runtime.process.exitCode === null && !runtime.stopped);
  const pool = running.length ? running : runtimes;
  return pool.sort((left, right) => String(right.startedAt || '').localeCompare(String(left.startedAt || '')))[0] || null;
}

function getAgentRuntime(agentId, sessionId = undefined) {
  if (sessionId !== undefined) {
    return managedAgents.get(getManagedRuntimeKey(agentId, sessionId)) ?? null;
  }
  return pickPrimaryAgentRuntime(agentId);
}

function getAssemblyRuntime(sessionId) {
  return assemblyRuntimeProcesses.get(sanitizeSessionFragment(sessionId)) ?? null;
}

async function stopAssemblyRuntime(sessionId) {
  const runtime = getAssemblyRuntime(sessionId);
  if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
    return { sessionId: sanitizeSessionFragment(sessionId), status: 'stopped' };
  }

  runtime.stopped = true;
  const normalizedSessionId = sanitizeSessionFragment(sessionId);
  const waitForExit = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2500);
    runtime.process.once('exit', () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
  runtime.process.kill('SIGTERM');
  const exited = await waitForExit;
  return {
    sessionId: normalizedSessionId,
    status: exited ? 'stopped' : 'stopping',
    viewerAgentId: runtime.viewerAgentId ?? null,
  };
}

function sanitizeSessionFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function isWorkspaceSessionAgent(agentId) {
  return WORKSPACE_SESSION_AGENT_IDS.has(sanitizeSessionFragment(agentId));
}

function isValidFeatureName(value) {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(String(value || '').trim());
}

function resolveFeatureCreatorOutputDir(parentDir, featureName) {
  return path.join(path.resolve(String(parentDir || '').trim()), String(featureName || '').trim());
}

function getAssemblyWorkspaceDir(assemblyName) {
  return path.join(os.homedir(), '.agentdev', 'agent-dev', sanitizeSessionFragment(assemblyName));
}

function parseListField(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeSpawnEnv(inputEnv) {
  return Object.fromEntries(
    Object.entries(inputEnv || {}).filter(([key, value]) => {
      return typeof key === 'string' && key.length > 0 && value != null;
    }).map(([key, value]) => [key, String(value)])
  );
}

async function ensureAssemblyWorkspaceBase(envDir, assemblyName) {
  await ensureDir(envDir);
  await ensureDir(path.join(envDir, '.agentdev', 'audit'));
  await ensureDir(path.join(envDir, '.agentdev', 'plugins'));
  await ensureDir(path.join(envDir, '.agentdev', 'tts'));

  const claudeMdPath = path.join(envDir, 'CLAUDE.md');
  try {
    await fs.access(claudeMdPath);
  } catch {
    await fs.writeFile(claudeMdPath, `# ${assemblyName}\n\nThis is the workspace for the ${assemblyName} chatbot.\n`, 'utf8');
  }

  const packageJsonPath = path.join(envDir, 'package.json');
  try {
    await fs.access(packageJsonPath);
  } catch {
    await fs.writeFile(packageJsonPath, `${JSON.stringify({
      name: sanitizeSessionFragment(assemblyName),
      private: true,
      type: 'module',
      version: '0.0.0',
      description: `Assembly workspace for ${assemblyName}`,
    }, null, 2)}\n`, 'utf8');
  }
}

async function resolveAssemblyFeatureArchives(tokens) {
  const requested = Array.from(new Set(tokens
    .map((token) => String(token || '').trim())
    .filter(Boolean)));

  if (requested.length === 0) {
    return [];
  }

  const [officialData, customData] = await Promise.all([
    summarizeFeatureRepository(FEATURE_REPOSITORY_ROOT, 'official'),
    summarizeFeatureRepository(USER_FEATURE_REPOSITORY_ROOT, 'custom'),
  ]);
  const catalogs = [officialData, customData];
  const resolved = [];

  for (const token of requested) {
    const normalized = token.replace(/^@agentdev\//, '').trim().toLowerCase();
    let matched = null;

    for (const catalog of catalogs) {
      const packages = Array.isArray(catalog?.packages) ? catalog.packages : [];
      const item = packages.find((pkg) => {
        const packageName = String(pkg?.packageName || '').trim().toLowerCase();
        const packageId = String(pkg?.id || '').trim().toLowerCase();
        const packageNameShort = packageName.replace(/^@agentdev\//, '');
        return token.toLowerCase() === packageName
          || normalized === packageId
          || normalized === packageNameShort;
      });

      if (!item) {
        continue;
      }

      const versions = Array.isArray(item.versions) ? item.versions : [];
      const latestVersion = versions.find((version) => String(version?.version || '') === String(item.latestVersion || ''))
        || versions[versions.length - 1]
        || null;
      if (!latestVersion?.fileName) {
        continue;
      }

      const rootDir = item.source === 'custom' ? USER_FEATURE_REPOSITORY_ROOT : FEATURE_REPOSITORY_ROOT;
      matched = {
        token,
        packageName: String(item.packageName || token).trim(),
        archivePath: path.join(rootDir, latestVersion.fileName),
      };
      break;
    }

    if (!matched) {
      throw new Error(`未找到装配 Feature 包: ${token}`);
    }

    resolved.push(matched);
  }

  return resolved;
}

function toFileDependencySpec(targetPath) {
  return `file:${path.resolve(targetPath).replace(/\\/g, '/')}`;
}

function computeDependencyHash(dependencies) {
  const entries = Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b));
  let hash = 0;
  for (const [key, value] of entries) {
    for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    hash = ((hash << 5) - hash + 0x3A) | 0;
    for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    hash = ((hash << 5) - hash + 0x7C) | 0;
  }
  return hash.toString(36);
}

async function ensureAssemblyWorkspaceDependencies(envDir, selectedFeatures) {
  const _t0 = Date.now();
  const requestedFeatures = Array.isArray(selectedFeatures)
    ? Array.from(new Set(selectedFeatures.map((value) => String(value || '').trim()).filter(Boolean)))
    : [];
  const hashFilePath = path.join(envDir, '.protoclaw-deps-hash');
  const nodeModulesExists = existsSync(path.join(envDir, 'node_modules'));
  const featureKey = [...requestedFeatures].sort().join(',');

  // Early skip: if features haven't changed and node_modules exists, skip everything
  if (nodeModulesExists && requestedFeatures.length >= 0) {
    const savedContent = await fs.readFile(hashFilePath, 'utf8').catch(() => '');
    const savedParts = savedContent.trim().split('|');
    const savedFeatureKey = savedParts.length > 1 ? savedParts[0] : null;
    const savedHash = savedParts.length > 1 ? savedParts[1] : savedParts[0];
    if (savedFeatureKey === featureKey && savedHash) {
      console.log(`[PERF] ensureAssemblyWorkspaceDependencies EARLY SKIP (${Date.now() - _t0}ms) features=${featureKey}`);
      return { installedPackages: requestedFeatures, installDir: envDir, skipped: true };
    }
  }

  const archives = requestedFeatures.length > 0
    ? await resolveAssemblyFeatureArchives(requestedFeatures)
    : [];
  const nextDependencies = {
    agentdev: toFileDependencySpec(AGENTDEV_ROOT),
    ...Object.fromEntries(archives.map((item) => [item.packageName, toFileDependencySpec(item.archivePath)])),
  };
  const depHash = computeDependencyHash(nextDependencies);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packageJsonPath = path.join(envDir, 'package.json');
  const packageJson = await readJson(packageJsonPath).catch(() => ({}));

  await fs.writeFile(packageJsonPath, `${JSON.stringify({
    ...packageJson,
    name: typeof packageJson?.name === 'string' && packageJson.name.trim() ? packageJson.name.trim() : sanitizeSessionFragment(path.basename(envDir)),
    private: true,
    type: 'module',
    version: typeof packageJson?.version === 'string' && packageJson.version.trim() ? packageJson.version.trim() : '0.0.0',
    description: typeof packageJson?.description === 'string' && packageJson.description.trim()
      ? packageJson.description.trim()
      : `Assembly workspace for ${path.basename(envDir)}`,
    dependencies: nextDependencies,
  }, null, 2)}\n`, 'utf8');

  await Promise.all([
    fs.rm(path.join(envDir, 'node_modules'), { recursive: true, force: true }).catch(() => {}),
    fs.rm(path.join(envDir, 'package-lock.json'), { force: true }).catch(() => {}),
  ]);

  await runCommand(npmCommand, [
    'install',
    '--no-fund',
    '--no-audit',
    '--no-package-lock',
  ], { cwd: envDir });

  const hashContent = `${featureKey}|${depHash}`;
  await fs.writeFile(hashFilePath, hashContent, 'utf8').catch(() => {});

  console.log(`[PERF] ensureAssemblyWorkspaceDependencies npm install DONE (${Date.now() - _t0}ms) deps=${Object.keys(nextDependencies).join(',')}`);
  return {
    installedPackages: archives.map((item) => item.packageName),
    installDir: envDir,
    skipped: false,
  };
}

function buildStatus(agentId, sessionId = undefined) {
  const runtime = getAgentRuntime(agentId, sessionId);
  if (!runtime) {
    return { id: agentId, status: 'stopped', pid: null, startedAt: null, exitCode: null, viewerAgentId: null, selectedSessionId: null };
  }

  const running = runtime.process && runtime.process.exitCode === null && !runtime.stopped;
  return {
    id: agentId,
    status: running ? 'running' : 'stopped',
    pid: running ? runtime.process.pid : null,
    startedAt: runtime.startedAt ?? null,
    exitCode: runtime.exitCode ?? null,
    viewerAgentId: running ? (runtime.viewerAgentId ?? null) : null,
    selectedSessionId: runtime.selectedSessionId ?? null,
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function getPrebuiltAgentSessionDir(agentId) {
  if (isWorkspaceSessionAgent(agentId)) {
    return path.join(PREBUILT_WORKSPACES_ROOT, sanitizeSessionFragment(agentId), 'sessions');
  }
  return path.join(PREBUILT_SESSIONS_ROOT, sanitizeSessionFragment(agentId));
}

function getPrebuiltSessionFilePath(agentId, sessionId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), `${sanitizeSessionFragment(sessionId)}.json`);
}

function getPrebuiltSessionIndexPath(agentId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), 'index.json');
}

function getPrebuiltWorkspaceDir(agentId) {
  return path.join(PREBUILT_WORKSPACES_ROOT, sanitizeSessionFragment(agentId));
}

function getPrebuiltWorkspaceStatePath(agentId) {
  return path.join(getPrebuiltWorkspaceDir(agentId), 'state.json');
}

function getPrebuiltWorkspaceArtifactsDir(agentId) {
  return path.join(getPrebuiltWorkspaceDir(agentId), 'artifacts');
}

function getProjectDocsetDir(projectDir) {
  return path.join(path.resolve(String(projectDir || '').trim()), PROJECT_DOCSET_SUBPATH);
}

function getProjectDocsetProjectPath(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'project.json');
}

function getProjectDocsetFormsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'forms');
}

function getProjectDocsetMaterialsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'materials');
}

function getProjectDocsetConversationsDir(projectDir) {
  return path.join(getProjectDocsetDir(projectDir), 'conversations');
}

function getWorkspaceArtifactPath(agentId, artifactId) {
  return path.join(getPrebuiltWorkspaceArtifactsDir(agentId), `${sanitizeSessionFragment(artifactId)}.json`);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function normalizeQQBotConfig(raw = {}) {
  const config = {
    appId: typeof raw.appId === 'string' ? raw.appId.trim() : '',
    clientSecret: typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : '',
    accountId: typeof raw.accountId === 'string' ? raw.accountId.trim() : '',
    markdownSupport: typeof raw.markdownSupport === 'boolean' ? raw.markdownSupport : true,
  };

  return config;
}

function normalizeWeixinConfig(raw = {}) {
  return {
    botToken: typeof raw.botToken === 'string' ? raw.botToken.trim() : '',
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
    loginTime: Number.isFinite(raw.loginTime) ? raw.loginTime : null,
  };
}

function normalizeIMChannelConfig(raw = {}, defaults = {}) {
  return {
    label: typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.trim()
      : String(defaults.label || ''),
    role: typeof raw.role === 'string' && raw.role.trim()
      ? raw.role.trim()
      : String(defaults.role || ''),
    note: typeof raw.note === 'string' ? raw.note.trim() : String(defaults.note || ''),
  };
}

function normalizeBoundSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (!agentId || !sessionId) return null;
  return { agentId, sessionId };
}

function normalizeIMLine(raw, index) {
  if (!raw || typeof raw !== 'object') raw = {};
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `line${index + 1}`,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `通道 ${index + 1}`,
    carrier: typeof raw.carrier === 'string' ? raw.carrier.trim() : '',
    boundSession: normalizeBoundSession(raw.boundSession),
  };
}

function normalizeIMWorkspaceConfig(raw = {}) {
  const rawChannels = raw && typeof raw.channels === 'object' && raw.channels ? raw.channels : {};
  const channels = {};

  for (const [channelId, channelValue] of Object.entries(rawChannels)) {
    if (!channelId) continue;
    channels[String(channelId)] = normalizeIMChannelConfig(channelValue, {});
  }

  if (!channels.qq) {
    channels.qq = normalizeIMChannelConfig({}, {
      label: 'QQ',
      note: '',
    });
  }

  if (!channels.weixin) {
    channels.weixin = normalizeIMChannelConfig({}, {
      label: '微信',
      note: '',
    });
  }

  const selectedChannel = typeof raw.selectedChannel === 'string' && raw.selectedChannel.trim()
    ? raw.selectedChannel.trim()
    : 'qq';
  const receptionistSessionId = typeof raw.receptionistSessionId === 'string'
    ? sanitizeSessionFragment(raw.receptionistSessionId)
    : '';

  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = rawLines.length > 0
    ? rawLines.map((l, i) => normalizeIMLine(l, i))
    : [normalizeIMLine({}, 0), normalizeIMLine({}, 1)];

  return {
    selectedChannel: channels[selectedChannel] ? selectedChannel : 'qq',
    receptionistSessionId,
    channels,
    lines,
  };
}

const IM_CHANNEL_DISPLAY_LABELS = { qq: 'QQ', weixin: '微信' };

function getPortalAgentDisplayName(channelId) {
  const label = IM_CHANNEL_DISPLAY_LABELS[channelId] || channelId || 'QQ';
  return `门户代理（${label}）`;
}

async function readProjectQQBotConfig() {
  try {
    const data = await readJson(PROJECT_QQBOT_CONFIG_PATH);
    return normalizeQQBotConfig(data);
  } catch {
    return normalizeQQBotConfig({});
  }
}

async function writeProjectQQBotConfig(rawConfig) {
  const config = normalizeQQBotConfig(rawConfig);
  await ensureDir(path.dirname(PROJECT_QQBOT_CONFIG_PATH));
  await fs.writeFile(PROJECT_QQBOT_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

async function readProjectWeixinConfig() {
  try {
    const data = await readJson(PROJECT_WEIXIN_CONFIG_PATH);
    return normalizeWeixinConfig(data);
  } catch {
    return normalizeWeixinConfig({});
  }
}

async function readProjectIMWorkspaceConfig() {
  try {
    const data = await readJson(PROJECT_IM_WORKSPACE_CONFIG_PATH);
    return normalizeIMWorkspaceConfig(data);
  } catch {
    return normalizeIMWorkspaceConfig({});
  }
}

async function writeProjectIMWorkspaceConfig(rawConfig) {
  const config = normalizeIMWorkspaceConfig(rawConfig);
  await ensureDir(path.dirname(PROJECT_IM_WORKSPACE_CONFIG_PATH));
  await fs.writeFile(PROJECT_IM_WORKSPACE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

/**
 * Serialized read-modify-write for IM workspace config.
 *
 * Without this, concurrent HTTP requests (e.g. im_line_transfer + GET
 * im_workspace_bundle) interleave their read → modify → write cycles and
 * silently overwrite each other's results — the primary cause of intermittent
 * "接不上" (connection fails silently).
 *
 * Every mutator callback receives the freshly-read config and may mutate it
 * in-place. The config is written back automatically after the callback
 * resolves. Operations are chained sequentially via a promise queue.
 */
let _imConfigOpChain = Promise.resolve();
function withIMWorkspaceConfig(mutator) {
  const run = _imConfigOpChain.then(async () => {
    const config = await readProjectIMWorkspaceConfig();
    const shouldWrite = await mutator(config);
    if (shouldWrite) {
      await writeProjectIMWorkspaceConfig(config);
    }
    return config;
  });
  // Swallow rejections so the chain never breaks for subsequent callers
  _imConfigOpChain = run.catch(() => {});
  return run;
}

/**
 * Prune line bindings whose target runtime is no longer alive.
 * Runs through the serializer to avoid racing with concurrent transfers.
 * Returns the number of pruned lines.
 */
function pruneStaleIMLineBindings() {
  return withIMWorkspaceConfig((config) => {
    let pruned = 0;
    for (const line of (config.lines || [])) {
      if (!line.boundSession?.agentId || !line.boundSession?.sessionId) continue;
      const rt = getAgentRuntime(line.boundSession.agentId, line.boundSession.sessionId);
      if (!rt?.process || rt.process.exitCode !== null || rt.stopped) {
        line.boundSession = null;
        pruned++;
      }
    }
    return pruned > 0;
  });
}

function serializeWeixinBindingState(state = null) {
  if (!state) {
    return {
      pending: false,
      status: 'idle',
      qrcodeId: '',
      qrcodeUrl: '',
      qrcodeDataUrl: '',
      error: '',
      issuedAt: null,
      confirmedAt: null,
      sourcePath: PROJECT_WEIXIN_CONFIG_PATH,
    };
  }

  return {
    pending: state.status === 'pending',
    status: state.status || 'idle',
    qrcodeId: state.qrcodeId || '',
    qrcodeUrl: state.qrcodeUrl || '',
    qrcodeDataUrl: state.qrcodeDataUrl || '',
    error: state.error || '',
    issuedAt: state.issuedAt || null,
    confirmedAt: state.confirmedAt || null,
    sourcePath: PROJECT_WEIXIN_CONFIG_PATH,
  };
}

async function buildIMWorkspaceBundle(agentId = 'qqbot') {
  let workspaceConfig = await readProjectIMWorkspaceConfig();
  const [qqConfig, weixinConfig, index, phIndex] = await Promise.all([
    readProjectQQBotConfig(),
    readProjectWeixinConfig(),
    readSessionIndex(agentId).catch(() => ({ sessions: [], activeSessionId: null })),
    readSessionIndex('programming-helper').catch(() => ({ sessions: [], activeSessionId: null })),
  ]);

  // Detect stale line bindings for display, and fire background pruning
  // through the serializer (non-blocking). This replaces the old inline
  // read-modify-write that raced with concurrent transfers.
  let hasStaleBindings = false;
  for (const line of (workspaceConfig.lines || [])) {
    if (!line.boundSession?.agentId || !line.boundSession?.sessionId) continue;
    const rt = getAgentRuntime(line.boundSession.agentId, line.boundSession.sessionId);
    if (!rt?.process || rt.process.exitCode !== null || rt.stopped) {
      hasStaleBindings = true;
    }
  }
  if (hasStaleBindings) {
    pruneStaleIMLineBindings().catch((e) =>
      console.error('[ProtoClaw IM] Background prune failed:', e)
    );
  }

  const sessions = Array.isArray(index?.sessions)
    ? index.sessions.map((session) => ({
        id: cleanSessionText(session?.id),
        title: cleanSessionText(session?.title) || cleanSessionText(session?.id),
        updatedAt: cleanSessionText(session?.updatedAt),
      })).filter((session) => session.id)
    : [];
  const selectedSessionId = workspaceConfig.receptionistSessionId || cleanSessionText(index?.activeSessionId);
  const receptionistSession = sessions.find((session) => session.id === selectedSessionId) || null;
  const binding = serializeWeixinBindingState(weixinBindingSessions.get(agentId) || null);

  return {
    workspaceConfig: {
      ...workspaceConfig,
      receptionistSessionId: selectedSessionId || '',
    },
    qqConfig,
    weixinConfig: {
      configured: !!weixinConfig.botToken,
      baseUrl: weixinConfig.baseUrl || '',
      loginTime: weixinConfig.loginTime || null,
      sourcePath: PROJECT_WEIXIN_CONFIG_PATH,
    },
    binding,
    sessions,
    receptionistSession,
    qqSourcePath: PROJECT_QQBOT_CONFIG_PATH,
    workspaceSourcePath: PROJECT_IM_WORKSPACE_CONFIG_PATH,
    connectableSessions: buildConnectableSessions(phIndex),
  };
}

function buildConnectableSessions(phIndex) {
  if (!phIndex?.sessions) return [];
  const liveKeys = new Set(
    listAgentRuntimes('programming-helper')
      .filter(rt => rt?.process && rt.process.exitCode === null && !rt.stopped)
      .map(rt => getManagedRuntimeKey('programming-helper', rt.selectedSessionId))
  );
  return phIndex.sessions
    .filter(s => s.sessionType === 'main')
    .filter(s => {
      const key = getManagedRuntimeKey('programming-helper', s.id);
      return liveKeys.has(key);
    })
    .map(s => ({
      id: s.id,
      title: s.title || s.id,
      updatedAt: s.updatedAt || null,
    }))
    .filter(s => s.id);
}

async function startWeixinBinding(agentId = 'qqbot') {
  const client = new WeixinApiClient(PROJECT_WEIXIN_CONFIG_PATH);
  const qrcodeResponse = await client.getBotQrcode();
  const qrcodeUrl = WeixinApiClient.resolveQrcodeUrl(qrcodeResponse);
  const qrcodeDataUrl = await WeixinApiClient.buildQrcodeDataUrl(qrcodeResponse, { width: 320, margin: 2 });
  const nextState = {
    status: 'pending',
    qrcodeId: qrcodeResponse.qrcode,
    qrcodeUrl,
    qrcodeDataUrl,
    issuedAt: new Date().toISOString(),
    confirmedAt: null,
    error: '',
  };
  weixinBindingSessions.set(agentId, nextState);
  return serializeWeixinBindingState(nextState);
}

async function refreshWeixinBinding(agentId = 'qqbot') {
  const current = weixinBindingSessions.get(agentId) || null;
  const client = new WeixinApiClient(PROJECT_WEIXIN_CONFIG_PATH);
  const persisted = normalizeWeixinConfig(client.getPersistedConfig());

  if (!current || !current.qrcodeId) {
    if (persisted.botToken) {
      const configured = {
        status: 'configured',
        qrcodeId: '',
        qrcodeUrl: '',
        qrcodeDataUrl: '',
        issuedAt: null,
        confirmedAt: persisted.loginTime ? new Date(persisted.loginTime).toISOString() : null,
        error: '',
      };
      weixinBindingSessions.set(agentId, configured);
      return serializeWeixinBindingState(configured);
    }
    return serializeWeixinBindingState(null);
  }

  try {
    const status = await client.getQrcodeStatus(current.qrcodeId);
    if (status.status === 'confirmed' && status.bot_token) {
      client.setBotToken(status.bot_token, status.baseurl);
      const configured = {
        ...current,
        status: 'configured',
        confirmedAt: new Date().toISOString(),
        error: '',
      };
      weixinBindingSessions.set(agentId, configured);
      return serializeWeixinBindingState(configured);
    }

    if (status.status === 'expired') {
      const expired = {
        ...current,
        status: 'expired',
        error: '二维码已过期，请重新生成。',
      };
      weixinBindingSessions.set(agentId, expired);
      return serializeWeixinBindingState(expired);
    }

    const pending = {
      ...current,
      status: 'pending',
      error: '',
    };
    weixinBindingSessions.set(agentId, pending);
    return serializeWeixinBindingState(pending);
  } catch (error) {
    const failed = {
      ...current,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
    weixinBindingSessions.set(agentId, failed);
    return serializeWeixinBindingState(failed);
  }
}

async function clearWeixinBinding(agentId = 'qqbot') {
  const client = new WeixinApiClient(PROJECT_WEIXIN_CONFIG_PATH);
  client.clearToken();
  weixinBindingSessions.delete(agentId);
  return serializeWeixinBindingState(null);
}

function normalizeFeatureConfigs(rawConfigs) {
  if (!rawConfigs || typeof rawConfigs !== 'object') return {};
  const result = {};
  for (const [featureKey, config] of Object.entries(rawConfigs)) {
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      result[String(featureKey)] = Object.fromEntries(
        Object.entries(config).map(([k, v]) => [String(k), v]),
      );
    }
  }
  return result;
}

function normalizeWorkspaceState(raw = {}) {
  const rawForms = raw && typeof raw.forms === 'object' && raw.forms ? raw.forms : {};
  const featureConfigs = normalizeFeatureConfigs(rawForms['feature-configs']);
  const forms = Object.fromEntries(Object.entries(rawForms).map(([formId, value]) => {
    if (formId === 'feature-configs') return [formId, featureConfigs];
    return [
      String(formId),
      value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([field, fieldValue]) => [String(field), String(fieldValue ?? '')])) : {},
    ];
  }));
  const assemblyForm = forms['assembly-form'] && typeof forms['assembly-form'] === 'object'
    ? forms['assembly-form']
    : {};
  const assemblyConfigs = Array.isArray(raw?.assemblyConfigs)
    ? raw.assemblyConfigs.map((item) => ({
        id: cleanSessionText(item?.id),
        name: cleanSessionText(item?.name),
        displayName: cleanSessionText(item?.displayName),
        preset: cleanSessionText(item?.preset),
        goal: cleanSessionText(item?.goal),
        targetUser: cleanSessionText(item?.targetUser),
        features: Array.isArray(item?.features) ? item.features.map((value) => cleanSessionText(value)).filter(Boolean) : [],
        toolkits: Array.isArray(item?.toolkits) ? item.toolkits.map((value) => cleanSessionText(value)).filter(Boolean) : [],
        constraints: cleanSessionText(item?.constraints),
        customSystemPrompt: cleanSessionText(item?.customSystemPrompt),
        envDir: cleanSessionText(item?.envDir),
        envConfiguredName: cleanSessionText(item?.envConfiguredName),
        envConfiguredFeatures: Array.isArray(item?.envConfiguredFeatures) ? item.envConfiguredFeatures.map((value) => cleanSessionText(value)).filter(Boolean) : [],
        envStatus: cleanSessionText(item?.envStatus),
        envStatusMessage: cleanSessionText(item?.envStatusMessage),
        modelPreset: cleanSessionText(item?.modelPreset),
        workdir: cleanSessionText(item?.workdir),
        featureConfigs: normalizeFeatureConfigs(item?.featureConfigs),
        createdAt: cleanSessionText(item?.createdAt),
        updatedAt: cleanSessionText(item?.updatedAt),
      })).filter((item) => item.id)
        .reduce((acc, item) => {
          const matchesDraft = item.id === cleanSessionText(assemblyForm?.editing_config_id)
            || item.id === cleanSessionText(assemblyForm?.assembly_name);
          const nextItem = matchesDraft ? {
            ...item,
            envDir: assemblyForm.env_dir !== undefined ? cleanSessionText(assemblyForm.env_dir) : item.envDir,
            envConfiguredName: assemblyForm.env_configured_name !== undefined ? cleanSessionText(assemblyForm.env_configured_name) : item.envConfiguredName,
            envConfiguredFeatures: assemblyForm.env_configured_features !== undefined
              ? parseListField(assemblyForm.env_configured_features)
              : item.envConfiguredFeatures,
            envStatus: assemblyForm.env_status !== undefined ? cleanSessionText(assemblyForm.env_status) : item.envStatus,
            envStatusMessage: assemblyForm.env_status_message !== undefined ? cleanSessionText(assemblyForm.env_status_message) : item.envStatusMessage,
            featureConfigs,
          } : item;
          if (!acc.some((existing) => existing.id === item.id)) {
            acc.push(nextItem);
          }
          return acc;
        }, [])
    : [];
  const featureProjects = Array.isArray(raw?.featureProjects)
    ? raw.featureProjects.map((project) => normalizeWorkspaceFeatureProject(project)).filter(Boolean)
    : [];
  const agentProjects = Array.isArray(raw?.agentProjects)
    ? raw.agentProjects.map((project) => normalizeWorkspaceAgentProject(project)).filter(Boolean)
    : [];
  const phProjects = Array.isArray(raw?.phProjects)
    ? raw.phProjects.map((p) => normalizeWorkspacePhProject(p)).filter(Boolean)
    : [];

  return {
    forms,
    assemblyConfigs,
    featureProjects,
    agentProjects,
    phProjects,
    openDirectory: typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function mergeFeatureRepositoryPackages(...catalogs) {
  const groups = new Map();
  for (const catalog of catalogs) {
    const packages = Array.isArray(catalog?.packages) ? catalog.packages : [];
    for (const item of packages) {
      const key = String(item?.packageName || item?.id || '').trim().toLowerCase();
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    }
  }

  return Array.from(groups.values()).map((group) => {
    const sorted = [...group].sort((left, right) => {
      const sourceScore = (right?.source === 'custom') - (left?.source === 'custom');
      if (sourceScore !== 0) return sourceScore;
      const versionScore = compareSemver(String(right?.latestVersion || ''), String(left?.latestVersion || ''));
      if (versionScore !== 0) return versionScore;
      const t1 = new Date(String(right?.updatedAt || 0)).getTime() || 0;
      const t2 = new Date(String(left?.updatedAt || 0)).getTime() || 0;
      return t1 - t2;
    });
    const preferred = sorted[0];
    const warnings = uniqueStrings(sorted.flatMap((item) => Array.isArray(item?.warnings) ? item.warnings : []));
    return {
      ...preferred,
      source: preferred.source || 'official',
      warnings,
      warningCount: warnings.length,
      duplicateSources: uniqueStrings(sorted.map((item) => String(item?.source || '').trim()).filter(Boolean)),
      versions: Array.isArray(preferred.versions) ? preferred.versions : [],
    };
  }).sort((left, right) => String(left?.name || '').localeCompare(String(right?.name || ''), 'zh-CN'));
}

function cleanWorkspaceArtifactPayload(raw = {}) {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [String(key), typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => {
        if (value === null || value === undefined) return false;
        if (typeof value === 'string') return value.length > 0;
        return true;
      }),
  );
}

function normalizeWorkspaceArtifact(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const relatedToSource = source.relatedTo && typeof source.relatedTo === 'object' ? source.relatedTo : {};
  const normalizedId = sanitizeSessionFragment(source.id || source.title || randomUUID());

  return {
    id: normalizedId,
    kind: typeof source.kind === 'string' && source.kind.trim() ? source.kind.trim() : 'artifact',
    title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : normalizedId,
    status: typeof source.status === 'string' && source.status.trim() ? source.status.trim() : 'active',
    createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : null,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : null,
    source: source.source && typeof source.source === 'object' ? source.source : {},
    relatedTo: {
      openDirectory: typeof relatedToSource.openDirectory === 'string' ? relatedToSource.openDirectory.trim() : '',
      sessionId: typeof relatedToSource.sessionId === 'string' ? relatedToSource.sessionId.trim() : '',
      parentId: typeof relatedToSource.parentId === 'string' ? relatedToSource.parentId.trim() : '',
    },
    payload: cleanWorkspaceArtifactPayload(source.payload),
  };
}

function buildFeatureCreatorDraftArtifact(state, timestamp) {
  const startupForm = state?.forms?.['startup-form'] || {};
  const payload = cleanWorkspaceArtifactPayload({
    feature_name: startupForm.feature_name,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    install_mode: startupForm.install_mode,
    target_dir: startupForm.target_dir,
  });
  const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';
  const featureName = typeof payload.feature_name === 'string' ? payload.feature_name : '';
  const targetDir = typeof payload.target_dir === 'string' ? payload.target_dir : '';
  const stableKey = openDirectory || [featureName, targetDir].filter(Boolean).join('@');

  if (!stableKey) {
    return null;
  }

  return normalizeWorkspaceArtifact({
    id: `feature-creator-draft-${stableKey}`,
    kind: 'draft',
    title: featureName ? `创建 ${featureName}` : 'Feature 创建草稿',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    source: {
      workspace: 'feature-creator',
      formId: 'startup-form',
    },
    relatedTo: {
      openDirectory,
      sessionId: '',
      parentId: '',
    },
    payload,
  });
}

function buildAgentCreatorDraftArtifact(state, timestamp) {
  const startupForm = state?.forms?.['startup-form'] || {};
  const payload = cleanWorkspaceArtifactPayload({
    agent_name: startupForm.agent_name,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    install_mode: startupForm.install_mode,
    target_dir: startupForm.target_dir,
    target_user: startupForm.target_user,
    runtime_style: startupForm.runtime_style,
    planned_features: startupForm.planned_features,
  });
  const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';
  const agentName = typeof payload.agent_name === 'string' ? payload.agent_name : '';
  const targetDir = typeof payload.target_dir === 'string' ? payload.target_dir : '';
  const stableKey = openDirectory || [agentName, targetDir].filter(Boolean).join('@');

  if (!stableKey) {
    return null;
  }

  return normalizeWorkspaceArtifact({
    id: `agent-creator-draft-${stableKey}`,
    kind: 'draft',
    title: agentName ? `创建 ${agentName}` : 'Agent 创建草稿',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    source: {
      workspace: 'agent-creator',
      formId: 'startup-form',
    },
    relatedTo: {
      openDirectory,
      sessionId: '',
      parentId: '',
    },
    payload,
  });
}

function buildProgrammingHelperDraftArtifact(state, timestamp) {
  return null;
}

async function writeWorkspaceArtifact(agentId, rawArtifact) {
  const artifact = normalizeWorkspaceArtifact(rawArtifact);
  const artifactPath = getWorkspaceArtifactPath(agentId, artifact.id);
  let createdAt = artifact.createdAt;

  try {
    const existing = normalizeWorkspaceArtifact(await readJson(artifactPath));
    createdAt = existing.createdAt || createdAt;
  } catch {
    // New artifact file.
  }

  const nextArtifact = {
    ...artifact,
    createdAt: createdAt || artifact.updatedAt || new Date().toISOString(),
  };

  await ensureDir(getPrebuiltWorkspaceArtifactsDir(agentId));
  await fs.writeFile(artifactPath, JSON.stringify(nextArtifact, null, 2), 'utf8');
  return nextArtifact;
}

async function listWorkspaceArtifacts(agentId) {
  const artifactsDir = getPrebuiltWorkspaceArtifactsDir(agentId);

  try {
    const entries = await fs.readdir(artifactsDir, { withFileTypes: true });
    const artifacts = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map(async (entry) => {
        const artifactPath = path.join(artifactsDir, entry.name);
        const artifact = normalizeWorkspaceArtifact(await readJson(artifactPath));
        return {
          ...artifact,
          path: artifactPath,
        };
      }));

    artifacts.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    return {
      artifacts,
      artifactsDir,
    };
  } catch {
    return {
      artifacts: [],
      artifactsDir,
    };
  }
}

async function summarizeWorkspaceArtifacts(agentId, options = {}) {
  const { artifacts, artifactsDir } = await listWorkspaceArtifacts(agentId);
  const allowedKinds = Array.isArray(options.kinds)
    ? new Set(options.kinds.map((value) => String(value || '').trim()).filter(Boolean))
    : null;
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 8;
  const openDirectoryFilter = String(options.openDirectory || '').trim().toLowerCase();
  let filtered = allowedKinds
    ? artifacts.filter((artifact) => allowedKinds.has(String(artifact.kind || '').trim()))
    : artifacts;

  if (openDirectoryFilter) {
    const scoped = filtered.filter((artifact) => String(artifact?.relatedTo?.openDirectory || '').trim().toLowerCase() === openDirectoryFilter);
    if (scoped.length > 0) {
      filtered = scoped;
    }
  }

  return {
    type: 'workspace-artifacts',
    workspaceId: sanitizeSessionFragment(agentId),
    artifactsDir,
    artifactCount: filtered.length,
    latestUpdatedAt: filtered[0]?.updatedAt || null,
    items: filtered.slice(0, limit).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      status: artifact.status,
      updatedAt: artifact.updatedAt,
      createdAt: artifact.createdAt,
      source: artifact.source || {},
      relatedTo: artifact.relatedTo || {},
      payload: artifact.payload || {},
    })),
  };
}

async function summarizeWorkspaceArtifactsCollection(agentIds, options = {}) {
  const results = await Promise.all((Array.isArray(agentIds) ? agentIds : []).map(async (workspaceId) => {
    const summary = await summarizeWorkspaceArtifacts(workspaceId, {
      ...options,
      openDirectory: '',
    });
    return {
      workspaceId: sanitizeSessionFragment(workspaceId),
      items: Array.isArray(summary.items) ? summary.items : [],
    };
  }));

  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : 10;
  const items = results
    .flatMap((entry) => entry.items.map((item) => ({
      ...item,
      source: {
        ...(item.source && typeof item.source === 'object' ? item.source : {}),
        workspace: entry.workspaceId,
      },
    })))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, limit);

  return {
    type: 'workspace-artifacts',
    workspaceId: 'aggregate',
    artifactsDir: '',
    artifactCount: items.length,
    latestUpdatedAt: items[0]?.updatedAt || null,
    items,
  };
}

function normalizeWorkspaceFeatureProject(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const openDirectory = typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '';
  const featureName = typeof raw.featureName === 'string' ? raw.featureName.trim() : '';
  const targetDir = typeof raw.targetDir === 'string' ? raw.targetDir.trim() : '';
  const installMode = raw.installMode === 'custom' ? 'custom' : 'system';
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  const constraints = typeof raw.constraints === 'string' ? raw.constraints.trim() : '';
  const id = buildWorkspaceFeatureProjectId({ openDirectory, featureName, targetDir });

  if (!id) return null;

  return {
    id,
    featureName,
    installMode,
    targetDir,
    openDirectory,
    goal,
    constraints,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function normalizeWorkspaceAgentProject(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const openDirectory = typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '';
  const agentName = typeof raw.agentName === 'string' ? raw.agentName.trim() : '';
  const targetDir = typeof raw.targetDir === 'string' ? raw.targetDir.trim() : '';
  const installMode = raw.installMode === 'custom' ? 'custom' : 'system';
  const goal = typeof raw.goal === 'string' ? raw.goal.trim() : '';
  const constraints = typeof raw.constraints === 'string' ? raw.constraints.trim() : '';
  const targetUser = typeof raw.targetUser === 'string' ? raw.targetUser.trim() : '';
  const runtimeStyle = typeof raw.runtimeStyle === 'string' ? raw.runtimeStyle.trim() : '';
  const plannedFeatures = typeof raw.plannedFeatures === 'string' ? raw.plannedFeatures.trim() : '';
  const id = buildWorkspaceAgentProjectId({ openDirectory, agentName, targetDir });

  if (!id) return null;

  return {
    id,
    agentName,
    installMode,
    targetDir,
    openDirectory,
    goal,
    constraints,
    targetUser,
    runtimeStyle,
    plannedFeatures,
    managedBy: typeof raw.managedBy === 'string' ? raw.managedBy.trim() : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function normalizeWorkspacePhProject(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const openDirectory = typeof raw.openDirectory === 'string' ? raw.openDirectory.trim() : '';
  if (!openDirectory) return null;
  return {
    id: 'dir:' + openDirectory.replace(/\\/g, '/').toLowerCase(),
    openDirectory,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

function buildWorkspaceFeatureProjectId(project = {}) {
  const openDirectory = typeof project.openDirectory === 'string' ? project.openDirectory.trim() : '';
  if (openDirectory) {
    return `dir:${openDirectory.replace(/\\/g, '/').toLowerCase()}`;
  }

  const featureName = typeof project.featureName === 'string' ? project.featureName.trim().toLowerCase() : '';
  const targetDir = typeof project.targetDir === 'string' ? project.targetDir.trim().replace(/\\/g, '/').toLowerCase() : '';
  if (featureName && targetDir) {
    return `feature:${featureName}@${targetDir}`;
  }
  if (featureName) {
    return `feature:${featureName}`;
  }
  return '';
}

function buildWorkspaceAgentProjectId(project = {}) {
  const openDirectory = typeof project.openDirectory === 'string' ? project.openDirectory.trim() : '';
  if (openDirectory) {
    return `dir:${openDirectory.replace(/\\/g, '/').toLowerCase()}`;
  }

  const agentName = typeof project.agentName === 'string' ? project.agentName.trim().toLowerCase() : '';
  const targetDir = typeof project.targetDir === 'string' ? project.targetDir.trim().replace(/\\/g, '/').toLowerCase() : '';
  if (agentName && targetDir) {
    return `agent:${agentName}@${targetDir}`;
  }
  if (agentName) {
    return `agent:${agentName}`;
  }
  return '';
}

function upsertWorkspaceFeatureProject(state, rawProject, timestamp) {
  const project = normalizeWorkspaceFeatureProject({
    ...(rawProject || {}),
    updatedAt: timestamp,
  });
  if (!project) {
    return state;
  }

  const projects = Array.isArray(state.featureProjects) ? [...state.featureProjects] : [];
  const existingIndex = projects.findIndex((item) => item?.id === project.id);
  const existing = existingIndex >= 0 ? projects[existingIndex] : null;
  const merged = {
    ...(existing || {}),
    ...project,
    createdAt: existing?.createdAt || project.createdAt || timestamp,
    updatedAt: timestamp,
  };

  if (existingIndex >= 0) {
    projects.splice(existingIndex, 1, merged);
  } else {
    projects.push(merged);
  }

  projects.sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
  return {
    ...state,
    featureProjects: projects,
  };
}

function upsertWorkspaceAgentProject(state, rawProject, timestamp) {
  const project = normalizeWorkspaceAgentProject({
    ...(rawProject || {}),
    updatedAt: timestamp,
  });
  if (!project) {
    return state;
  }

  const projects = Array.isArray(state.agentProjects) ? [...state.agentProjects] : [];
  const existingIndex = projects.findIndex((item) => item?.id === project.id);
  const existing = existingIndex >= 0 ? projects[existingIndex] : null;
  const merged = {
    ...(existing || {}),
    ...project,
    createdAt: existing?.createdAt || project.createdAt || timestamp,
    updatedAt: timestamp,
  };

  if (existingIndex >= 0) {
    projects.splice(existingIndex, 1, merged);
  } else {
    projects.push(merged);
  }

  projects.sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
  return {
    ...state,
    agentProjects: projects,
  };
}

function upsertWorkspacePhProject(state, rawProject, timestamp) {
  const project = normalizeWorkspacePhProject({
    ...(rawProject || {}),
    updatedAt: timestamp,
  });
  if (!project) return state;
  const projects = Array.isArray(state.phProjects) ? [...state.phProjects] : [];
  const existingIndex = projects.findIndex((item) => item?.id === project.id);
  const existing = existingIndex >= 0 ? projects[existingIndex] : null;
  const merged = {
    ...(existing || {}),
    ...project,
    createdAt: existing?.createdAt || project.createdAt || timestamp,
    updatedAt: timestamp,
  };
  if (existingIndex >= 0) {
    projects.splice(existingIndex, 1, merged);
  } else {
    projects.push(merged);
  }
  projects.sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')));
  return { ...state, phProjects: projects };
}

function removeWorkspacePhProject(state, projectId) {
  const projects = Array.isArray(state.phProjects)
    ? state.phProjects.filter((p) => p.id !== projectId)
    : [];
  return { ...state, phProjects: projects };
}

function syncFeatureCreatorProjects(state, timestamp) {
  const startupForm = state?.forms?.['startup-form'] || {};
  const featureName = typeof startupForm.feature_name === 'string' ? startupForm.feature_name.trim() : '';
  const targetDir = typeof startupForm.target_dir === 'string' ? startupForm.target_dir.trim() : '';
  const goal = typeof startupForm.goal === 'string' ? startupForm.goal.trim() : '';
  const constraints = typeof startupForm.constraints === 'string' ? startupForm.constraints.trim() : '';
  const installMode = startupForm.install_mode === 'custom' ? 'custom' : 'system';
  const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';

  if (!featureName && !openDirectory) {
    return state;
  }

  return upsertWorkspaceFeatureProject(state, {
    featureName,
    targetDir,
    goal,
    constraints,
    installMode,
    openDirectory,
  }, timestamp);
}

function syncAgentCreatorProjects(state, timestamp) {
  const startupForm = state?.forms?.['startup-form'] || {};
  const agentName = typeof startupForm.agent_name === 'string' ? startupForm.agent_name.trim() : '';
  const targetDir = typeof startupForm.target_dir === 'string' ? startupForm.target_dir.trim() : '';
  const goal = typeof startupForm.goal === 'string' ? startupForm.goal.trim() : '';
  const constraints = typeof startupForm.constraints === 'string' ? startupForm.constraints.trim() : '';
  const targetUser = typeof startupForm.target_user === 'string' ? startupForm.target_user.trim() : '';
  const runtimeStyle = typeof startupForm.runtime_style === 'string' ? startupForm.runtime_style.trim() : '';
  const plannedFeatures = typeof startupForm.planned_features === 'string' ? startupForm.planned_features.trim() : '';
  const installMode = startupForm.install_mode === 'custom' ? 'custom' : 'system';
  const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';

  if (!agentName && !openDirectory) {
    return state;
  }

  return upsertWorkspaceAgentProject(state, {
    agentName,
    targetDir,
    goal,
    constraints,
    targetUser,
    runtimeStyle,
    plannedFeatures,
    installMode,
    openDirectory,
  }, timestamp);
}

function syncFlowAssemblyProjects(state, timestamp) {
  const assemblyConfigs = Array.isArray(state?.assemblyConfigs) ? state.assemblyConfigs : [];
  const retainedProjects = Array.isArray(state?.agentProjects)
    ? state.agentProjects.filter((project) => String(project?.managedBy || '').trim() !== 'assembly-config')
    : [];
  let nextState = {
    ...state,
    agentProjects: retainedProjects,
  };

  for (const config of assemblyConfigs) {
    const agentName = cleanSessionText(config?.name || config?.id);
    if (!agentName) continue;
    const openDirectory = cleanSessionText(config?.envDir) || getAssemblyWorkspaceDir(agentName);
    nextState = upsertWorkspaceAgentProject(nextState, {
      agentName,
      installMode: 'system',
      targetDir: openDirectory ? path.dirname(openDirectory) : '',
      openDirectory,
      goal: cleanSessionText(config?.goal),
      constraints: cleanSessionText(config?.constraints),
      targetUser: cleanSessionText(config?.targetUser),
      runtimeStyle: cleanSessionText(config?.preset) || 'assembly',
      plannedFeatures: Array.isArray(config?.features) ? config.features.join('\n') : '',
      managedBy: 'assembly-config',
    }, timestamp);
  }

  return nextState;
}

const _wsCache = new Map();

async function readWorkspaceState(agentId) {
  const key = sanitizeSessionFragment(agentId);
  const cached = _wsCache.get(key);
  if (cached && Date.now() - cached.ts < 5000) return cached.data;
  try {
    let data = normalizeWorkspaceState(await readJson(getPrebuiltWorkspaceStatePath(key)));
    if (key === 'programming-helper' && data.forms && data.forms['startup-form']) {
      delete data.forms['startup-form'];
      writeWorkspaceState(key, data).catch(() => {});
      _wsCache.delete(key);
    }
    if (key === 'programming-helper' && (!Array.isArray(data.phProjects) || data.phProjects.length === 0)) {
      const sessionIndex = await readSessionIndex(key);
      const directories = new Map();
      for (const session of (sessionIndex?.sessions || [])) {
        const dir = String(session.openDirectory || '').trim();
        if (dir && !directories.has(dir.replace(/\\/g, '/').toLowerCase())) {
          directories.set(dir.replace(/\\/g, '/').toLowerCase(), {
            openDirectory: dir,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          });
        }
      }
      if (directories.size > 0) {
        const timestamp = new Date().toISOString();
        data.phProjects = Array.from(directories.values()).map(d =>
          normalizeWorkspacePhProject({ ...d, createdAt: d.createdAt || timestamp, updatedAt: d.updatedAt || timestamp })
        ).filter(Boolean);
        writeWorkspaceState(key, data).catch(() => {});
        _wsCache.delete(key);
      }
    }
    // Auto-set openDirectory to most recently used project if empty
    if (key === 'programming-helper' && !data.openDirectory && Array.isArray(data.phProjects) && data.phProjects.length > 0) {
      const sorted = [...data.phProjects].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      data.openDirectory = sorted[0].openDirectory || '';
      if (data.openDirectory) {
        writeWorkspaceState(key, data).catch(() => {});
        _wsCache.delete(key);
      }
    }
    _wsCache.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    const data = normalizeWorkspaceState({});
    _wsCache.set(key, { data, ts: Date.now() });
    return data;
  }
}

async function writeWorkspaceState(agentId, rawState) {
  const timestamp = new Date().toISOString();
  const nextState = normalizeWorkspaceState({
    ...await readWorkspaceState(agentId),
    ...(rawState || {}),
    updatedAt: timestamp,
  });
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const resolvedState = normalizedAgentId === 'feature-creator'
    ? syncFeatureCreatorProjects(nextState, timestamp)
    : (normalizedAgentId === 'agent-creator'
      ? syncAgentCreatorProjects(nextState, timestamp)
      : (normalizedAgentId === 'flow-workspace'
        ? syncFlowAssemblyProjects(nextState, timestamp)
        : nextState));
  await ensureDir(getPrebuiltWorkspaceDir(agentId));
  await fs.writeFile(getPrebuiltWorkspaceStatePath(agentId), JSON.stringify(resolvedState, null, 2), 'utf8');

  if (sanitizeSessionFragment(agentId) === 'feature-creator') {
    const draftArtifact = buildFeatureCreatorDraftArtifact(resolvedState, timestamp);
    if (draftArtifact) {
      await writeWorkspaceArtifact(agentId, draftArtifact);
    }
  } else if (sanitizeSessionFragment(agentId) === 'agent-creator') {
    const draftArtifact = buildAgentCreatorDraftArtifact(resolvedState, timestamp);
    if (draftArtifact) {
      await writeWorkspaceArtifact(agentId, draftArtifact);
    }
  } else if (sanitizeSessionFragment(agentId) === 'programming-helper') {
    const draftArtifact = buildProgrammingHelperDraftArtifact(resolvedState, timestamp);
    if (draftArtifact) {
      await writeWorkspaceArtifact(agentId, draftArtifact);
    }
  }

  await syncWorkspaceProjectDocset(agentId, resolvedState, timestamp).catch(() => null);

  _wsCache.set(normalizedAgentId, { data: resolvedState, ts: Date.now() });
  return resolvedState;
}

async function summarizeDirectorySource(rawPath) {
  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);

  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      return {
        path: resolvedPath,
        exists: false,
        type: 'directory-summary',
        error: 'Not a directory',
        skillCount: 0,
        entryCount: 0,
        sampleNames: [],
        updatedAt: null,
      };
    }

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const directoryEntries = entries.filter((entry) => entry.isDirectory());
    const skillDirChecks = await Promise.all(directoryEntries.map(async (entry) => {
      try {
        await fs.stat(path.join(resolvedPath, entry.name, 'SKILL.md'));
        return entry.name;
      } catch {
        return null;
      }
    }));

    return {
      path: resolvedPath,
      exists: true,
      type: 'directory-summary',
      skillCount: skillDirChecks.filter(Boolean).length,
      entryCount: entries.length,
      sampleNames: skillDirChecks.filter(Boolean).slice(0, 6),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: false,
      type: 'directory-summary',
      error: error && error.message ? error.message : String(error),
      skillCount: 0,
      entryCount: 0,
      sampleNames: [],
      updatedAt: null,
    };
  }
}

function compareSemver(left, right) {
  const leftParts = String(left || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeFeatureRequirements(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    platforms: uniqueStrings(source.platforms),
    node: typeof source.node === 'string' ? source.node.trim() : '',
    external: uniqueStrings(source.external),
    services: uniqueStrings(source.services),
  };
}

function normalizeFeatureTypes(values) {
  const allowed = new Set(['tools', 'mcp', 'hooks', 'control', 'rollback']);
  return uniqueStrings(values).filter((value) => allowed.has(value));
}

function normalizeFeatureCompatibility(raw = {}, featureTypes = []) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rollback = typeof source.rollback === 'boolean'
    ? source.rollback
    : featureTypes.includes('rollback');

  return {
    rollback,
    tags: uniqueStrings([
      ...(Array.isArray(source.tags) ? source.tags : []),
      rollback ? 'supports-rollback' : 'no-rollback',
    ]),
  };
}

function inferFeatureTypes(pkg, baseId) {
  const packageName = String(pkg?.name || '').trim();
  const lowerBaseId = String(baseId || '').toLowerCase();

  if (packageName.startsWith('@sliverp/')) {
    return [];
  }
  if (/(shell|websearch|visual|tts|lsp|memory)/i.test(lowerBaseId)) {
    return ['tools'];
  }
  if (/(audio-feedback|audit|plugin-compat)/i.test(lowerBaseId)) {
    return ['hooks'];
  }
  if (/qqbot/i.test(lowerBaseId)) {
    return ['hooks', 'control'];
  }
  return [];
}

function inferFeatureManifest(pkg, archiveName) {
  const packageName = typeof pkg?.name === 'string' ? pkg.name.trim() : '';
  const baseId = packageName
    ? packageName.split('/').pop()
    : archiveName.replace(/\.tgz$/i, '');
  const tags = uniqueStrings(pkg?.keywords);
  const featureTypes = inferFeatureTypes(pkg, baseId);
  const dependencyNames = Object.keys(pkg?.dependencies || {});
  const requirements = {
    platforms: [],
    node: '',
    external: [],
    services: [],
  };

  if (typeof pkg?.engines?.node === 'string' && pkg.engines.node.trim()) {
    requirements.node = pkg.engines.node.trim();
  }
  if (dependencyNames.includes('openai') || /websearch|visual|tts/i.test(baseId)) {
    requirements.services.push('network');
  }
  if (/shell/i.test(baseId)) {
    requirements.external.push('system-shell');
  }
  if (/audio|tts/i.test(baseId) || dependencyNames.includes('sound-play')) {
    requirements.external.push('audio-output');
  }
  if (/visual/i.test(baseId)) {
    requirements.external.push('desktop-capture');
  }
  if (/lsp/i.test(baseId)) {
    requirements.external.push('language-server');
  }
  if (/qqbot/i.test(baseId)) {
    requirements.services.push('qqbot');
  }

  return {
    schemaVersion: 1,
    id: baseId,
    name: baseId,
    version: typeof pkg?.version === 'string' ? pkg.version.trim() : '',
    description: typeof pkg?.description === 'string' ? pkg.description.trim() : '',
    tags,
    entry: typeof pkg?.main === 'string' ? pkg.main.trim() : '',
    agentdev: {
      compatible: typeof pkg?.peerDependencies?.agentdev === 'string'
        ? pkg.peerDependencies.agentdev.trim()
        : '',
    },
    homepage: typeof pkg?.homepage === 'string' ? pkg.homepage.trim() : '',
    repository: typeof pkg?.repository === 'string'
      ? pkg.repository.trim()
      : (typeof pkg?.repository?.url === 'string' ? pkg.repository.url.trim() : ''),
    featureTypes,
    compatibility: normalizeFeatureCompatibility({}, featureTypes),
    requirements,
  };
}

async function ensureFeatureProjectManifest(projectDir) {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const manifestPath = path.join(projectDir, FEATURE_MANIFEST_NAME);
  const pkg = await readJson(packageJsonPath);
  const existingManifest = await readJson(manifestPath).catch(() => null);
  const inferred = inferFeatureManifest(pkg, `${path.basename(projectDir)}.tgz`);
  const featureTypes = normalizeFeatureTypes(existingManifest?.featureTypes || inferred.featureTypes);
  const manifest = {
    schemaVersion: 1,
    id: typeof existingManifest?.id === 'string' && existingManifest.id.trim() ? existingManifest.id.trim() : inferred.id,
    name: typeof existingManifest?.name === 'string' && existingManifest.name.trim() ? existingManifest.name.trim() : inferred.name,
    version: typeof pkg?.version === 'string' ? pkg.version.trim() : inferred.version,
    description: typeof existingManifest?.description === 'string' && existingManifest.description.trim()
      ? existingManifest.description.trim()
      : inferred.description,
    tags: uniqueStrings([...(existingManifest?.tags || []), ...(pkg?.keywords || [])]),
    entry: typeof existingManifest?.entry === 'string' && existingManifest.entry.trim()
      ? existingManifest.entry.trim()
      : inferred.entry,
    homepage: typeof existingManifest?.homepage === 'string' && existingManifest.homepage.trim()
      ? existingManifest.homepage.trim()
      : inferred.homepage,
    repository: typeof existingManifest?.repository === 'string' && existingManifest.repository.trim()
      ? existingManifest.repository.trim()
      : inferred.repository,
    agentdev: {
      compatible: typeof existingManifest?.agentdev?.compatible === 'string' && existingManifest.agentdev.compatible.trim()
        ? existingManifest.agentdev.compatible.trim()
        : inferred.agentdev.compatible,
    },
    featureTypes,
    compatibility: normalizeFeatureCompatibility(existingManifest?.compatibility, featureTypes),
    requirements: normalizeFeatureRequirements(existingManifest?.requirements || inferred.requirements),
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  if (Array.isArray(pkg.files) && !pkg.files.includes(FEATURE_MANIFEST_NAME)) {
    await fs.writeFile(packageJsonPath, `${JSON.stringify({
      ...pkg,
      files: uniqueStrings([...pkg.files, FEATURE_MANIFEST_NAME]),
    }, null, 2)}\n`, 'utf8');
  }

  return {
    manifestPath,
    packageJsonPath,
  };
}

async function readArchiveJson(archivePath, archiveEntryPath) {
  const { stdout } = await runCommand('tar', ['-xOf', archivePath, archiveEntryPath], { cwd: __dirname });
  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`Archive entry is empty: ${archiveEntryPath}`);
  }
  return JSON.parse(raw);
}

async function summarizeFeatureArchive(archivePath, archiveName, source = 'custom') {
  const stat = await fs.stat(archivePath);
  let pkg = null;
  let manifest = null;
  const warnings = [];

  try {
    pkg = await readArchiveJson(archivePath, 'package/package.json');
  } catch (error) {
    return {
      id: archiveName.replace(/\.tgz$/i, ''),
      name: archiveName.replace(/\.tgz$/i, ''),
      packageName: '',
      description: '',
      latestVersion: '',
      version: '',
      updatedAt: stat.mtime.toISOString(),
      archiveCount: 1,
      size: stat.size,
      tags: [],
      featureTypes: [],
      compatibility: normalizeFeatureCompatibility({}, []),
      requirements: normalizeFeatureRequirements(),
      homepage: '',
      repository: '',
      entry: '',
      agentdev: {},
      manifestPresent: false,
      warningCount: 1,
      source,
      warnings: [`无法读取 package.json: ${error instanceof Error ? error.message : String(error)}`],
      fileName: archiveName,
    };
  }

  try {
    manifest = await readArchiveJson(archivePath, `package/${FEATURE_MANIFEST_NAME}`);
  } catch {
    manifest = null;
  }

  const normalizedManifest = manifest || inferFeatureManifest(pkg, archiveName);
  const inferredFeatureTypes = inferFeatureTypes(pkg, normalizedManifest.id || pkg.name || archiveName);
  const featureTypes = normalizeFeatureTypes(normalizedManifest.featureTypes || inferredFeatureTypes);
  if (!manifest) {
    warnings.push(`缺少 ${FEATURE_MANIFEST_NAME}，当前仅展示 package.json 推断信息。`);
  }

  return {
    id: String(normalizedManifest.id || pkg.name || archiveName.replace(/\.tgz$/i, '')).trim(),
    name: String(normalizedManifest.name || normalizedManifest.id || pkg.name || archiveName.replace(/\.tgz$/i, '')).trim(),
    packageName: String(pkg.name || '').trim(),
    description: String(normalizedManifest.description || pkg.description || '').trim(),
    latestVersion: String(normalizedManifest.version || pkg.version || '').trim(),
    version: String(normalizedManifest.version || pkg.version || '').trim(),
    updatedAt: stat.mtime.toISOString(),
    archiveCount: 1,
    size: stat.size,
    tags: uniqueStrings([...(normalizedManifest.tags || []), ...(pkg.keywords || [])]),
    featureTypes,
    compatibility: normalizeFeatureCompatibility(normalizedManifest.compatibility, featureTypes),
    requirements: normalizeFeatureRequirements(normalizedManifest.requirements),
    homepage: typeof normalizedManifest.homepage === 'string' ? normalizedManifest.homepage.trim() : '',
    repository: typeof normalizedManifest.repository === 'string' ? normalizedManifest.repository.trim() : '',
    entry: typeof normalizedManifest.entry === 'string' ? normalizedManifest.entry.trim() : '',
    agentdev: typeof normalizedManifest.agentdev === 'object' && normalizedManifest.agentdev ? normalizedManifest.agentdev : {},
    manifestPresent: !!manifest,
    warningCount: warnings.length,
    source,
    warnings,
    fileName: archiveName,
  };
}

async function summarizeFeatureRepository(rawPath, source) {
  const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(__dirname, rawPath);

  try {
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const archives = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tgz'));
    const packageSummaries = await Promise.all(archives.map(async (entry) => {
      const archivePath = path.join(resolvedPath, entry.name);
      const stat = await fs.stat(archivePath);
      let pkg = null;
      let manifest = null;

      try {
        pkg = await readArchiveJson(archivePath, 'package/package.json');
      } catch (error) {
        return {
          id: entry.name.replace(/\.tgz$/i, ''),
          name: entry.name.replace(/\.tgz$/i, ''),
          packageName: '',
          description: '',
          latestVersion: '',
          updatedAt: stat.mtime.toISOString(),
          archiveCount: 1,
          size: stat.size,
          tags: [],
          featureTypes: [],
          compatibility: normalizeFeatureCompatibility({}, []),
          requirements: normalizeFeatureRequirements(),
          homepage: '',
          repository: '',
          manifestPresent: false,
          warningCount: 1,
          warnings: [`无法读取 package.json: ${error instanceof Error ? error.message : String(error)}`],
          versions: [{
            fileName: entry.name,
            version: '',
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
            manifestPresent: false,
            warnings: ['package.json 缺失或损坏'],
          }],
        };
      }

      try {
        manifest = await readArchiveJson(archivePath, `package/${FEATURE_MANIFEST_NAME}`);
      } catch {
        manifest = null;
      }

      const normalizedManifest = manifest || inferFeatureManifest(pkg, entry.name);
      const inferredFeatureTypes = inferFeatureTypes(pkg, normalizedManifest.id || pkg.name || entry.name);
      const featureTypes = normalizeFeatureTypes(normalizedManifest.featureTypes || inferredFeatureTypes);
      const warnings = [];
      if (!manifest) {
        warnings.push(`缺少 ${FEATURE_MANIFEST_NAME}，当前仅展示 package.json 推断信息。`);
      }

      return {
        id: String(normalizedManifest.id || pkg.name || entry.name.replace(/\.tgz$/i, '')).trim(),
        name: String(normalizedManifest.name || normalizedManifest.id || pkg.name || entry.name.replace(/\.tgz$/i, '')).trim(),
        packageName: String(pkg.name || '').trim(),
        description: String(normalizedManifest.description || pkg.description || '').trim(),
        version: String(normalizedManifest.version || pkg.version || '').trim(),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        tags: uniqueStrings([...(normalizedManifest.tags || []), ...(pkg.keywords || [])]),
        featureTypes,
        compatibility: normalizeFeatureCompatibility(normalizedManifest.compatibility, featureTypes),
        requirements: normalizeFeatureRequirements(normalizedManifest.requirements),
        homepage: typeof normalizedManifest.homepage === 'string' ? normalizedManifest.homepage.trim() : '',
        repository: typeof normalizedManifest.repository === 'string' ? normalizedManifest.repository.trim() : '',
        entry: typeof normalizedManifest.entry === 'string' ? normalizedManifest.entry.trim() : '',
        agentdev: typeof normalizedManifest.agentdev === 'object' && normalizedManifest.agentdev
          ? normalizedManifest.agentdev
          : {},
        manifestPresent: !!manifest,
        warnings,
        fileName: entry.name,
      };
    }));

    const groups = new Map();
    for (const item of packageSummaries) {
      const groupId = item.packageName || item.id;
      if (!groups.has(groupId)) {
        groups.set(groupId, []);
      }
      groups.get(groupId).push(item);
    }

    const packages = [...groups.values()].map((group) => {
      const versions = [...group].sort((left, right) => {
        const semverDiff = compareSemver(right.version, left.version);
        if (semverDiff !== 0) return semverDiff;
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      });
      const latest = versions[0];
      const warnings = uniqueStrings([
        ...versions.flatMap((item) => item.warnings || []),
        versions.some((item) => !item.manifestPresent) ? '部分版本缺少 feature 元数据。' : '',
      ]);

      return {
        id: latest.id,
        name: latest.name,
        packageName: latest.packageName,
        description: latest.description,
        latestVersion: latest.version,
        updatedAt: latest.updatedAt,
        archiveCount: versions.length,
        size: latest.size,
        tags: uniqueStrings(versions.flatMap((item) => item.tags || [])),
        featureTypes: latest.featureTypes || [],
        compatibility: latest.compatibility || normalizeFeatureCompatibility({}, latest.featureTypes || []),
        requirements: latest.requirements || normalizeFeatureRequirements(),
        homepage: latest.homepage,
        repository: latest.repository,
        entry: latest.entry,
        agentdev: latest.agentdev || {},
        manifestPresent: versions.every((item) => item.manifestPresent),
        warningCount: warnings.length,
        source: source || 'official',
        warnings,
        versions: versions.map((item) => ({
          fileName: item.fileName,
          version: item.version,
          updatedAt: item.updatedAt,
          size: item.size,
          manifestPresent: item.manifestPresent,
          warnings: item.warnings || [],
        })),
      };
    }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

    return {
      path: resolvedPath,
      exists: true,
      type: 'feature-repository',
      packageCount: packages.length,
      archiveCount: archives.length,
      missingManifestCount: packageSummaries.filter((item) => !item.manifestPresent).length,
      updatedAt: packages.reduce((latest, item) => {
        if (!latest) return item.updatedAt;
        return new Date(item.updatedAt).getTime() > new Date(latest).getTime() ? item.updatedAt : latest;
      }, null),
      packages,
    };
  } catch (error) {
    return {
      path: resolvedPath,
      exists: false,
      type: 'feature-repository',
      packageCount: 0,
      archiveCount: 0,
      missingManifestCount: 0,
      updatedAt: null,
      packages: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function deleteFeaturePackage(packageId) {
  const deletedFiles = [];
  
  // 尝试从官方仓库删除
  const officialPath = FEATURE_REPOSITORY_ROOT;
  try {
    const officialEntries = await fs.readdir(officialPath, { withFileTypes: true });
    for (const entry of officialEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.tgz')) {
        const archivePath = path.join(officialPath, entry.name);
        const archiveId = entry.name.replace(/\.tgz$/i, '');
        if (archiveId === packageId) {
          await fs.unlink(archivePath);
          deletedFiles.push({ path: archivePath, source: 'official' });
        }
      }
    }
  } catch {
    // 官方仓库可能不存在
  }

  // 尝试从用户仓库删除
  const userPath = USER_FEATURE_REPOSITORY_ROOT;
  try {
    const userEntries = await fs.readdir(userPath, { withFileTypes: true });
    for (const entry of userEntries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.tgz')) {
        const archivePath = path.join(userPath, entry.name);
        const archiveId = entry.name.replace(/\.tgz$/i, '');
        if (archiveId === packageId) {
          await fs.unlink(archivePath);
          deletedFiles.push({ path: archivePath, source: 'custom' });
        }
      }
    }
  } catch {
    // 用户仓库可能不存在
  }

  return deletedFiles;
}

async function resolveWorkspaceData(agent) {
  const blocks = Array.isArray(agent?.ui?.home?.blocks) ? agent.ui.home.blocks : [];
  const workspaceState = await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
  const entries = await Promise.all(blocks.map(async (block) => {
    if (!block?.id) {
      return null;
    }

    const data = {};

    if (block.directorySummary?.path) {
      Object.assign(data, await summarizeDirectorySource(block.directorySummary.path));
    }

    if (block.featureRepository?.path) {
      const officialData = await summarizeFeatureRepository(block.featureRepository.path, 'official');
      const customData = await summarizeFeatureRepository(USER_FEATURE_REPOSITORY_ROOT, 'custom');
      const allPackages = mergeFeatureRepositoryPackages(officialData, customData);
      Object.assign(data, {
        path: officialData.path,
        exists: officialData.exists || customData.exists,
        type: 'feature-repository',
        packageCount: allPackages.length,
        archiveCount: (officialData.archiveCount || 0) + (customData.archiveCount || 0),
        missingManifestCount: (officialData.missingManifestCount || 0) + (customData.missingManifestCount || 0),
        officialCount: officialData.packages ? officialData.packages.length : 0,
        customCount: customData.packages ? customData.packages.length : 0,
        updatedAt: [officialData.updatedAt, customData.updatedAt].filter(Boolean).sort().pop() || null,
        packages: allPackages,
      });
    }

    if (block.workspaceArtifacts) {
      if (Array.isArray(block.workspaceArtifacts.workspaces) && block.workspaceArtifacts.workspaces.length > 0) {
        Object.assign(data, await summarizeWorkspaceArtifactsCollection(block.workspaceArtifacts.workspaces, block.workspaceArtifacts));
      } else {
        Object.assign(data, await summarizeWorkspaceArtifacts(agent.id, {
          ...block.workspaceArtifacts,
          openDirectory: workspaceState?.openDirectory || '',
        }));
      }
    }

    if (block.projectDocset) {
      Object.assign(data, await summarizeProjectDocset(workspaceState?.openDirectory || '', {
        ...block.projectDocset,
        currentSessionId: agent?.workspace_sessions?.activeSessionId || agent?.active_workspace_session_id || '',
      }));
    }

    if (block.installDefaults?.type === 'feature-creator') {
      data.systemInstallRoot = path.join(os.homedir(), '.agentdev', 'feature-dev');
    } else if (block.installDefaults?.type === 'agent-creator') {
      data.systemInstallRoot = path.join(os.homedir(), '.agentdev', 'agent-dev');
    }

    return Object.keys(data).length > 0 ? [block.id, data] : null;
  }));

  return Object.fromEntries(entries.filter(Boolean));
}

async function readSessionIndex(agentId) {
  const dirPath = getPrebuiltAgentSessionDir(agentId);
  const indexPath = getPrebuiltSessionIndexPath(agentId);
  await ensureDir(dirPath);

  try {
    const data = await readJson(indexPath);
    const sessions = Array.isArray(data.sessions)
      ? data.sessions
        .filter((session) => session && session.id && session.id !== 'legacy')
        .map((session) => ({
          ...session,
          id: String(session.id),
          title: cleanSessionText(session.title),
          featureName: cleanSessionText(session.featureName),
          agentName: cleanSessionText(session.agentName),
          taskTitle: cleanSessionText(session.taskTitle),
          taskType: cleanSessionText(session.taskType),
          goal: cleanSessionText(session.goal),
          constraints: cleanSessionText(session.constraints),
          expectedOutput: cleanSessionText(session.expectedOutput),
          targetFiles: cleanSessionText(session.targetFiles),
          referenceMaterials: cleanSessionText(session.referenceMaterials),
          openDirectory: cleanSessionText(session.openDirectory),
          sessionType: cleanSessionText(session.sessionType) || (session.metadata?.resumeMode === 'one-shot' ? 'sub' : 'main'),
          archived: session.archived === true,
          todo: session.todo === true,
          metadata: normalizeSessionMetadata(session.metadata),
        }))
      : [];
    return {
      activeSessionId: sessions.some((session) => session.id === data.activeSessionId) ? data.activeSessionId : null,
      sessions,
    };
  } catch {
    return {
      activeSessionId: null,
      sessions: [],
    };
  }
}

async function resolvePrebuiltSessionType(agentId, sessionId) {
  const normalizedSessionId = cleanSessionText(sessionId);
  if (!normalizedSessionId) return '';

  try {
    const index = await readSessionIndex(agentId);
    const record = Array.isArray(index?.sessions)
      ? index.sessions.find((session) => cleanSessionText(session?.id) === normalizedSessionId)
      : null;
    const indexedType = cleanSessionText(record?.sessionType);
    if (indexedType) {
      return indexedType;
    }
    const indexedResumeMode = cleanSessionText(record?.metadata?.resumeMode);
    if (indexedResumeMode === 'one-shot') {
      return 'sub';
    }
  } catch {}

  try {
    const sessionPath = getPrebuiltSessionFilePath(agentId, normalizedSessionId);
    const sessionRecord = await fs.readFile(sessionPath, 'utf8').then(JSON.parse).catch(() => null);
    const fileType = cleanSessionText(sessionRecord?.sessionType);
    if (fileType) {
      return fileType;
    }
    const fileResumeMode = cleanSessionText(sessionRecord?.metadata?.resumeMode);
    if (fileResumeMode === 'one-shot') {
      return 'sub';
    }
  } catch {}

  return '';
}

const _indexLocks = new Map();

async function writeSessionIndex(agentId, index) {
  const dirPath = getPrebuiltAgentSessionDir(agentId);
  const indexPath = getPrebuiltSessionIndexPath(agentId);
  await ensureDir(dirPath);
  const tmpPath = indexPath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  try {
    await fs.rename(tmpPath, indexPath);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      await fs.unlink(indexPath).catch(() => {});
      await fs.rename(tmpPath, indexPath);
    } else if (err.code === 'EXDEV') {
      await fs.copyFile(tmpPath, indexPath);
      await fs.unlink(tmpPath).catch(() => {});
    } else {
      throw err;
    }
  }
}

async function updateSessionIndex(agentId, fn) {
  const prev = _indexLocks.get(agentId) || Promise.resolve();
  let release;
  const next = new Promise(r => release = r);
  _indexLocks.set(agentId, next);
  await prev;
  try {
    const index = await readSessionIndex(agentId);
    const newIndex = await fn(index);
    await writeSessionIndex(agentId, newIndex);
    return newIndex;
  } finally {
    release();
    if (_indexLocks.get(agentId) === next) _indexLocks.delete(agentId);
  }
}

function buildSessionTitle(createdAtIso) {
  const date = new Date(createdAtIso);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ];
  return `对话 ${parts.join('-')} ${time.join(':')}`;
}

function cleanSessionText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSessionMetadata(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const metadata = {
    resumeMode: cleanSessionText(raw.resumeMode),
    sourceAgentId: cleanSessionText(raw.sourceAgentId),
    sourceSessionId: cleanSessionText(raw.sourceSessionId),
    handoffId: cleanSessionText(raw.handoffId),
    handoffPath: cleanSessionText(raw.handoffPath),
    handoffCreatedAt: cleanSessionText(raw.handoffCreatedAt),
    handoffSummaryKind: cleanSessionText(raw.handoffSummaryKind),
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value),
  );
}

function sanitizeProjectDocsetId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'doc';
}

function buildProjectDocsetMarkdownId(title, createdAt, fallbackPrefix = 'plan') {
  const normalizedTitle = sanitizeProjectDocsetId(title || fallbackPrefix);
  const timestamp = String(createdAt || new Date().toISOString())
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  return `${fallbackPrefix}-${normalizedTitle}-${timestamp || Date.now()}`;
}

function cleanProjectDocsetPayload(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw)
      .map(([key, value]) => [String(key), typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => value !== undefined && value !== null && !(typeof value === 'string' && value === '')),
  );
}

function normalizeProjectConversationRecord(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const timestamp = new Date().toISOString();
  return {
    sessionId: sanitizeProjectDocsetId(source.sessionId || 'session'),
    title: cleanSessionText(source.title) || 'conversation-record',
    summary: cleanSessionText(source.summary),
    currentFocus: cleanSessionText(source.currentFocus),
    keyDecisions: Array.isArray(source.keyDecisions) ? source.keyDecisions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    nextActions: Array.isArray(source.nextActions) ? source.nextActions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    openQuestions: Array.isArray(source.openQuestions) ? source.openQuestions.map((value) => cleanSessionText(value)).filter(Boolean) : [],
    relatedMaterialIds: Array.isArray(source.relatedMaterialIds) ? source.relatedMaterialIds.map((value) => sanitizeProjectDocsetId(value)).filter(Boolean) : [],
    createdAt: typeof source.createdAt === 'string' && source.createdAt ? source.createdAt : timestamp,
    updatedAt: typeof source.updatedAt === 'string' && source.updatedAt ? source.updatedAt : timestamp,
  };
}

function extractMaterialSourcePath(content = '') {
  const match = String(content || '').match(/^- Source Path:\s*(.+)$/m);
  return match ? cleanSessionText(match[1]) : '';
}

async function ensureProjectDocset(projectDir, options = {}) {
  const resolvedProjectDir = path.resolve(String(projectDir || '').trim());
  const docsetDir = getProjectDocsetDir(resolvedProjectDir);
  const formsDir = getProjectDocsetFormsDir(resolvedProjectDir);
  const materialsDir = getProjectDocsetMaterialsDir(resolvedProjectDir);
  const conversationsDir = getProjectDocsetConversationsDir(resolvedProjectDir);
  const timestamp = typeof options.timestamp === 'string' && options.timestamp ? options.timestamp : new Date().toISOString();

  await Promise.all([
    ensureDir(docsetDir),
    ensureDir(formsDir),
    ensureDir(materialsDir),
    ensureDir(conversationsDir),
  ]);

  const legacyPlansDir = path.join(docsetDir, 'plans');
  try {
    const entries = await fs.readdir(legacyPlansDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fromPath = path.join(legacyPlansDir, entry.name);
      const toPath = path.join(materialsDir, entry.name);
      await fs.rename(fromPath, toPath).catch(async () => {
        const content = await fs.readFile(fromPath);
        await fs.writeFile(toPath, content);
        await fs.rm(fromPath, { force: true }).catch(() => {});
      });
    }
    await fs.rmdir(legacyPlansDir).catch(() => {});
  } catch {
    // Ignore missing legacy plans dir.
  }

  await fs.rm(path.join(docsetDir, 'tasks'), { recursive: true, force: true }).catch(() => {});

  const legacySessionsDir = path.join(docsetDir, 'sessions');
  try {
    const legacyEntries = await fs.readdir(legacySessionsDir, { withFileTypes: true });
    for (const entry of legacyEntries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
      const legacyPath = path.join(legacySessionsDir, entry.name);
      const nextPath = path.join(conversationsDir, entry.name);
      const raw = await readJson(legacyPath).catch(() => null);
      if (raw) {
        const normalized = normalizeProjectConversationRecord(raw);
        await fs.writeFile(nextPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      }
      await fs.rm(legacyPath, { force: true }).catch(() => {});
    }
    await fs.rmdir(legacySessionsDir).catch(() => {});
  } catch {
    // Ignore missing legacy sessions dir.
  }

  const nextProjectRecord = {
    schemaVersion: 1,
    workspaceId: cleanSessionText(options.workspaceId),
    projectType: cleanSessionText(options.projectType),
    projectName: cleanSessionText(options.projectName),
    openDirectory: resolvedProjectDir,
    targetDir: cleanSessionText(options.targetDir) || path.dirname(resolvedProjectDir),
    goal: cleanSessionText(options.goal),
    constraints: cleanSessionText(options.constraints),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  const projectPath = getProjectDocsetProjectPath(resolvedProjectDir);
  try {
    const existing = await readJson(projectPath);
    nextProjectRecord.createdAt = typeof existing?.createdAt === 'string' && existing.createdAt ? existing.createdAt : timestamp;
  } catch {
    // Ignore if project record does not exist yet.
  }

  await fs.writeFile(projectPath, `${JSON.stringify(nextProjectRecord, null, 2)}\n`, 'utf8');

  if (options.requirementForm && typeof options.requirementForm === 'object') {
    const requirementDoc = {
      schemaVersion: 1,
      formId: cleanSessionText(options.formId) || 'startup-form',
      workspaceId: cleanSessionText(options.workspaceId),
      openDirectory: resolvedProjectDir,
      payload: cleanProjectDocsetPayload(options.requirementForm),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const requirementPath = path.join(formsDir, `${requirementDoc.formId}.json`);
    try {
      const existing = await readJson(requirementPath);
      requirementDoc.createdAt = typeof existing?.createdAt === 'string' && existing.createdAt ? existing.createdAt : timestamp;
    } catch {
      // Ignore if form file does not exist yet.
    }
    await fs.writeFile(requirementPath, `${JSON.stringify(requirementDoc, null, 2)}\n`, 'utf8');
  }

  return {
    docsetDir,
    projectPath,
    formsDir,
    materialsDir,
    conversationsDir,
  };
}

async function syncWorkspaceProjectDocset(agentId, state, timestamp) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (normalizedAgentId !== 'feature-creator' && normalizedAgentId !== 'agent-creator' && normalizedAgentId !== 'programming-helper') {
    return null;
  }

  const openDirectory = cleanSessionText(state?.openDirectory);
  if (!openDirectory) {
    return null;
  }

  const startupForm = state?.forms?.['startup-form'] || {};
  const isFeatureCreator = normalizedAgentId === 'feature-creator';
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  return ensureProjectDocset(openDirectory, {
    timestamp,
    workspaceId: normalizedAgentId,
    projectType: isProgrammingHelper ? 'programming-task' : (isFeatureCreator ? 'feature' : 'agent'),
    projectName: isProgrammingHelper ? startupForm.task_title : (isFeatureCreator ? startupForm.feature_name : startupForm.agent_name),
    targetDir: isProgrammingHelper ? path.dirname(openDirectory) : startupForm.target_dir,
    goal: startupForm.goal,
    constraints: startupForm.constraints,
    formId: 'startup-form',
    requirementForm: startupForm,
  });
}

async function summarizeProjectDocset(projectDir, options = {}) {
  const resolvedProjectDir = cleanSessionText(projectDir);
  if (!resolvedProjectDir) {
    return {
      type: 'project-docset',
      exists: false,
      projectDir: '',
      docsetDir: '',
      requirementForm: null,
      materials: [],
      materialCount: 0,
    };
  }

  const docsetDir = getProjectDocsetDir(resolvedProjectDir);
  const materialLimit = Number.isFinite(Number(options.materialLimit)) ? Math.max(1, Number(options.materialLimit)) : 6;
  const conversationLimit = Number.isFinite(Number(options.conversationLimit)) ? Math.max(1, Number(options.conversationLimit)) : 5;
  const currentSessionId = cleanSessionText(options.currentSessionId);

  try {
    const [projectRecord, requirementForm, materialEntries, conversationEntries] = await Promise.all([
      readJson(getProjectDocsetProjectPath(resolvedProjectDir)).catch(() => null),
      readJson(path.join(getProjectDocsetFormsDir(resolvedProjectDir), 'startup-form.json')).catch(() => null),
      fs.readdir(getProjectDocsetMaterialsDir(resolvedProjectDir), { withFileTypes: true }).catch(() => []),
      fs.readdir(getProjectDocsetConversationsDir(resolvedProjectDir), { withFileTypes: true }).catch(() => []),
    ]);

    const materials = (await Promise.all(materialEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map(async (entry) => {
        const filePath = path.join(getProjectDocsetMaterialsDir(resolvedProjectDir), entry.name);
        const stat = await fs.stat(filePath);
        const body = await fs.readFile(filePath, 'utf8');
        const lines = body.split(/\r?\n/).map((line) => line.trim());
        const heading = lines.find((line) => line.startsWith('# ')) || '';
        const title = heading ? heading.replace(/^#\s+/, '').trim() : entry.name.replace(/\.md$/i, '');
        const preview = lines.filter(Boolean).slice(1, 4).join(' ').slice(0, 180);
        return {
          id: sanitizeProjectDocsetId(entry.name.replace(/\.md$/i, '')),
          title,
          preview,
          content: body,
          sourcePath: extractMaterialSourcePath(body),
          path: filePath,
          updatedAt: stat.mtime.toISOString(),
          createdAt: stat.birthtime.toISOString(),
        };
      })))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    const conversationRecords = (await Promise.all(conversationEntries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map(async (entry) => {
        const filePath = path.join(getProjectDocsetConversationsDir(resolvedProjectDir), entry.name);
        const raw = await readJson(filePath);
        return normalizeProjectConversationRecord(raw);
      })))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    const currentConversationRecord = currentSessionId
      ? conversationRecords.find((item) => item.sessionId === sanitizeProjectDocsetId(currentSessionId)) || null
      : null;

    return {
      type: 'project-docset',
      exists: true,
      projectDir: resolvedProjectDir,
      docsetDir,
      project: projectRecord,
      requirementForm,
      currentSessionId: currentSessionId || '',
      currentConversationRecord,
      conversationRecords: conversationRecords.slice(0, conversationLimit),
      materialCount: materials.length,
      materials: materials.slice(0, materialLimit),
    };
  } catch {
    return {
      type: 'project-docset',
      exists: false,
      projectDir: resolvedProjectDir,
      docsetDir,
      requirementForm: null,
      currentSessionId: currentSessionId || '',
      currentConversationRecord: null,
      conversationRecords: [],
      materials: [],
      materialCount: 0,
    };
  }
}

function buildFeatureSessionTitle(featureName, createdAtIso) {
  const date = new Date(createdAtIso);
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
  const time = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ];
  const base = cleanSessionText(featureName);
  return base ? `${base} · ${parts.join('-')} ${time.join(':')}` : buildSessionTitle(createdAtIso);
}

function buildNamedSessionTitle(name, createdAtIso) {
  return buildFeatureSessionTitle(name, createdAtIso);
}

async function getNextNewSessionTitle(agentId, openDirectory) {
  const index = await readSessionIndex(agentId);
  const normalizedDir = String(openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const newSessionPattern = /^新对话(\d+)$/;
  let maxN = 0;
  for (const session of (index.sessions || [])) {
    const sessionDir = String(session?.openDirectory || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (normalizedDir && sessionDir !== normalizedDir) continue;
    const m = cleanSessionText(session?.title).match(newSessionPattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return `新对话${maxN + 1}`;
}

async function checkSessionHasSummary(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

async function buildSessionSummaryMap(agentId) {
  const map = new Map();
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId && !parsed.stats?.synthetic) {
          const existing = map.get(parsed.sourceSessionId);
          const thisCreatedAt = parsed.createdAt || '';
          if (!existing || thisCreatedAt > (existing.createdAt || '')) {
            map.set(parsed.sourceSessionId, {
              sessionTitle: cleanSessionText(parsed.compactOutput?.sessionTitle),
              createdAt: thisCreatedAt,
            });
          }
        }
      } catch {}
    }
  } catch {}
  return map;
}

function buildLightPrebuiltSessionRecord(agentId, record) {
  const metadata = normalizeSessionMetadata(record?.metadata);
  const sessionType = cleanSessionText(record?.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
  return {
    id: cleanSessionText(record?.id),
    title: cleanSessionText(record?.title),
    featureName: cleanSessionText(record?.featureName),
    agentName: cleanSessionText(record?.agentName),
    taskTitle: cleanSessionText(record?.taskTitle),
    taskType: cleanSessionText(record?.taskType),
    goal: cleanSessionText(record?.goal),
    constraints: cleanSessionText(record?.constraints),
    expectedOutput: cleanSessionText(record?.expectedOutput),
    targetFiles: cleanSessionText(record?.targetFiles),
    referenceMaterials: cleanSessionText(record?.referenceMaterials),
    sessionType,
    status: cleanSessionText(record?.status) || (sessionType === 'exploration' ? 'locked' : ''),
    metadata,
    formId: cleanSessionText(record?.formId) || '',
    openDirectory: cleanSessionText(record?.openDirectory),
    createdAt: cleanSessionText(record?.createdAt) || new Date().toISOString(),
    updatedAt: cleanSessionText(record?.updatedAt) || cleanSessionText(record?.createdAt) || new Date().toISOString(),
    path: getPrebuiltSessionFilePath(agentId, cleanSessionText(record?.id) || ''),
    exists: true,
    bytes: record?.fileSize || 0,
    messageCount: typeof record?.messageCount === 'number' ? record.messageCount : 0,
    preview: cleanSessionText(record?.preview),
    hasSummary: false,
    tokenUsage: record?.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    contextLength: null,
    modelName: cleanSessionText(record?.modelName),
  };
}

async function findSessionSummary(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return parsed;
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function findSessionSummaryPath(agentId, sessionId) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  try {
    const files = await fs.readdir(handoffsDir);
    for (const file of files) {
      if (!file.startsWith('handoff-') || !file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(handoffsDir, file), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId === sessionId && !parsed.stats?.synthetic) {
          return path.join(handoffsDir, file);
        }
      } catch {}
    }
  } catch {}
  return null;
}

function extractToolCallLabel(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'read' || name === 'edit' || name === 'write') {
    const filePath = typeof args.filePath === 'string' ? args.filePath : '';
    if (filePath) {
      const baseName = filePath.split(/[\\/]/).pop() || filePath;
      return `${name} ${baseName}`;
    }
  }
  if (name === 'invoke_skill') {
    const skill = typeof args.skill === 'string' ? args.skill : '';
    if (skill) return `invoke_skill ${skill}`;
  }
  return null;
}

function buildSessionTrimPreview(messages) {
  const rounds = [];
  let currentRound = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = typeof m?.role === 'string' ? m.role : '';
    if (role === 'user') {
      if (currentRound) rounds.push(currentRound);
      const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
      currentRound = {
        roundIndex: rounds.length,
        turnStart: Number.isFinite(m.turn) ? m.turn : i,
        turnEnd: Number.isFinite(m.turn) ? m.turn : i,
        msgIndexStart: i,
        msgIndexEnd: i,
        userPreview: content.slice(0, 120),
        assistantPreview: '',
        toolCalls: [],
        messageCount: 1,
      };
    } else if (currentRound) {
      currentRound.messageCount += 1;
      currentRound.turnEnd = Number.isFinite(m.turn) ? m.turn : currentRound.turnEnd;
      currentRound.msgIndexEnd = i;
      if (role === 'assistant') {
        const content = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
        if (content && !currentRound.assistantPreview) {
          currentRound.assistantPreview = content.slice(0, 120);
        }
        const toolCalls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        for (const tc of toolCalls) {
          const name = typeof tc?.name === 'string' ? tc.name : '';
          if (!name) continue;
          let args = tc.args ?? tc.arguments ?? {};
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
          const label = extractToolCallLabel(name, args) || name;
          currentRound.toolCalls.push({ name, summary: label });
        }
      }
    }
  }
  if (currentRound) rounds.push(currentRound);

  const recentCount = 2;
  for (let i = 0; i < rounds.length; i++) {
    rounds[i].suggestedTrim = i < rounds.length - recentCount;
  }

  return rounds;
}

/**
 * Session index metadata version. Bump when the cached fields schema changes;
 * old index records will auto-heal via the slow path on first access.
 */
const META_VERSION = 1;

async function summarizePrebuiltSession(agentId, record, summaryMap, modelInfoMap) {
  const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const metadata = normalizeSessionMetadata(record.metadata);
  const workspaceState = isWorkspaceSessionAgent(agentId)
    ? await readWorkspaceState(agentId)
    : null;
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  const formId = cleanSessionText(record.formId) || (isProgrammingHelper ? '' : 'startup-form');
  const sourceForm = workspaceState?.forms?.[formId] || {};
  const startupForm = isProgrammingHelper ? {} : (workspaceState?.forms?.['startup-form'] || {});
  const featureName = cleanSessionText(record.featureName) || cleanSessionText(sourceForm.feature_name) || cleanSessionText(startupForm.feature_name);
  const agentName = cleanSessionText(record.agentName) || cleanSessionText(sourceForm.agent_name || sourceForm.assembly_name) || cleanSessionText(startupForm.agent_name);
  const taskTitle = cleanSessionText(record.taskTitle) || cleanSessionText(sourceForm.task_title) || cleanSessionText(startupForm.task_title);
  const taskType = cleanSessionText(record.taskType) || cleanSessionText(sourceForm.task_type) || cleanSessionText(startupForm.task_type);
  const goal = cleanSessionText(record.goal) || cleanSessionText(sourceForm.goal) || cleanSessionText(startupForm.goal);
  const constraints = cleanSessionText(record.constraints) || cleanSessionText(sourceForm.constraints) || cleanSessionText(startupForm.constraints);
  const expectedOutput = cleanSessionText(record.expectedOutput) || cleanSessionText(sourceForm.expected_output) || cleanSessionText(startupForm.expected_output);
  const targetFiles = cleanSessionText(record.targetFiles) || cleanSessionText(sourceForm.target_files) || cleanSessionText(startupForm.target_files);
  const referenceMaterials = cleanSessionText(record.referenceMaterials) || cleanSessionText(sourceForm.reference_materials) || cleanSessionText(startupForm.reference_materials);
  // NOTE: Do NOT fall back to workspaceState.openDirectory for non-assembly
  // agents. workspaceState.openDirectory is the *current* project directory,
  // not the one the session was created with. Falling back here causes sessions
  // with empty openDirectory to appear in every project the user opens.
  const openDirectory = (normalizedAgentId === 'agent-creator' || normalizedAgentId === 'flow-workspace') && formId === 'assembly-form'
    ? (
        cleanSessionText(sourceForm.env_dir)
        || cleanSessionText(record.openDirectory)
      )
    : cleanSessionText(record.openDirectory);
  const displayName = (normalizedAgentId === 'agent-creator' || (normalizedAgentId === 'flow-workspace' && formId === 'assembly-form'))
    ? agentName
    : (normalizedAgentId === 'programming-helper' ? taskTitle : featureName);
  try {
    const stat = await fs.stat(sessionPath);

    // ── Fast path: use cached metadata when the session file hasn't changed ──
    if (
      record.fileMtimeMs === stat.mtimeMs &&
      record.fileSize === stat.size &&
      record.metaVersion === META_VERSION &&
      typeof record.messageCount === 'number' &&
      typeof record.preview !== 'undefined' &&
      record.tokenUsage
    ) {
      const sType = cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
      const modelRole = sType === 'exploration' ? 'exploration' : sType === 'sub' ? 'sub' : 'default';
      const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole])
        || await resolveSessionModelInfo(agentId, sType);
      const persistedModelName = cleanSessionText(record.modelName);
      const persistedCL = Number.isFinite(record.contextLength) && record.contextLength > 0
        ? record.contextLength : null;
      const sessionModelInfo = {
        modelName: fallbackModelInfo.modelName || persistedModelName || '',
        contextLength: fallbackModelInfo.contextLength || persistedCL || null,
        compressRatio: fallbackModelInfo.compressRatio || 80,
      };
      const summaryInfo = summaryMap ? summaryMap.get(record.id) : null;
      const compactTitle = summaryInfo?.sessionTitle || '';
      return {
        id: record.id,
        title: cleanSessionText(record.title) || compactTitle || buildNamedSessionTitle(displayName, record.createdAt || stat.mtime.toISOString()),
        featureName,
        agentName,
        taskTitle,
        taskType,
        goal,
        constraints,
        expectedOutput,
        targetFiles,
        referenceMaterials,
        sessionType: sType,
        status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
        archived: record.archived === true,
        todo: record.todo === true,
        metadata,
        formId,
        openDirectory,
        createdAt: record.createdAt || stat.birthtime.toISOString(),
        updatedAt: record.savedAt ? new Date(record.savedAt).toISOString() : (record.updatedAt || stat.mtime.toISOString()),
        path: sessionPath,
        exists: true,
        bytes: stat.size,
        messageCount: record.messageCount,
        preview: cleanSessionText(record.preview),
        hasSummary: summaryMap ? summaryMap.has(record.id) : (await checkSessionHasSummary(agentId, record.id)),
        tokenUsage: record.tokenUsage,
        contextLength: sessionModelInfo.contextLength || null,
        compressRatio: sessionModelInfo.compressRatio || 80,
        modelName: sessionModelInfo.modelName || '',
      };
    }

    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const lastMessage = [...messages].reverse().find((message) => message && typeof message.content === 'string' && message.role !== 'system') || null;
    const summaryInfo = summaryMap ? summaryMap.get(record.id) : null;
    const compactTitle = summaryInfo?.sessionTitle || '';
    const usageStats = parsed?.runtime?.usageStats;
    const totalUsage = usageStats?.totalUsage;
    const sType = cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
    const modelRole = sType === 'exploration' ? 'exploration' : sType === 'sub' ? 'sub' : 'default';
    const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole])
      || await resolveSessionModelInfo(agentId, sType);
    // 优先使用动态解析的模型信息（当前全局配置），回退到 index record 中持久化的模型信息
    const persistedModelName = cleanSessionText(record.modelName);
    const persistedCL = Number.isFinite(record.contextLength) && record.contextLength > 0
      ? record.contextLength : null;
    const sessionModelInfo = {
      modelName: fallbackModelInfo.modelName || persistedModelName || '',
      contextLength: fallbackModelInfo.contextLength || persistedCL || null,
      compressRatio: fallbackModelInfo.compressRatio || 80,
    };
    const result = {
      id: record.id,
      title: cleanSessionText(record.title) || compactTitle || buildNamedSessionTitle(displayName, record.createdAt || stat.mtime.toISOString()),
      featureName,
      agentName,
      taskTitle,
      taskType,
      goal,
      constraints,
      expectedOutput,
      targetFiles,
      referenceMaterials,
      sessionType: cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main'),
      status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
      archived: record.archived === true,
      todo: record.todo === true,
      metadata,
      formId,
      openDirectory,
      createdAt: record.createdAt || stat.birthtime.toISOString(),
      updatedAt: typeof parsed?.savedAt === 'number' ? new Date(parsed.savedAt).toISOString() : (record.updatedAt || stat.mtime.toISOString()),
      path: sessionPath,
      exists: true,
      bytes: stat.size,
      messageCount: messages.length,
      preview: lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '',
      hasSummary: summaryMap ? summaryMap.has(record.id) : (await checkSessionHasSummary(agentId, record.id)),
      tokenUsage: {
        inputTokens: totalUsage?.inputTokens || 0,
        outputTokens: totalUsage?.outputTokens || 0,
        totalTokens: totalUsage?.totalTokens || 0,
        lastRequestUsage: usageStats?.lastRequestUsage || null,
      },
      contextLength: sessionModelInfo.contextLength || null,
      compressRatio: sessionModelInfo.compressRatio || 80,
      modelName: sessionModelInfo.modelName || '',
    };
    // Attach writeback payload as non-enumerable so it doesn't leak into API JSON responses
    Object.defineProperty(result, '_metaWriteback', {
      value: {
        fileMtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        messageCount: messages.length,
        preview: lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '',
        tokenUsage: {
          inputTokens: totalUsage?.inputTokens || 0,
          outputTokens: totalUsage?.outputTokens || 0,
          totalTokens: totalUsage?.totalTokens || 0,
          lastRequestUsage: usageStats?.lastRequestUsage || null,
        },
        savedAt: typeof parsed?.savedAt === 'number' ? parsed.savedAt : null,
        metaVersion: META_VERSION,
      },
      enumerable: false,
      configurable: true,
    });
    return result;
  } catch {
    return {
      id: record.id,
      title: record.title || buildNamedSessionTitle(displayName, record.createdAt || new Date().toISOString()),
      featureName,
      agentName,
      taskTitle,
      taskType,
      goal,
      constraints,
      expectedOutput,
      targetFiles,
      referenceMaterials,
      sessionType: cleanSessionText(record.sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main'),
      status: cleanSessionText(record.status) || (record.sessionType === 'exploration' ? 'locked' : ''),
      archived: record.archived === true,
      todo: record.todo === true,
      metadata,
      formId,
      openDirectory,
      createdAt: record.createdAt || new Date().toISOString(),
      updatedAt: record.updatedAt || record.createdAt || new Date().toISOString(),
      path: sessionPath,
      exists: false,
      bytes: 0,
      messageCount: 0,
      preview: '',
      hasSummary: false,
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      contextLength: null,
      compressRatio: 80,
      modelName: '',
    };
  }
}

// ── Session Content Search Index ────────────────────────────────
// In-memory cache: agentId → Map<sessionId, { sessionId, title, openDirectory, fileMtimeMs, text }>
const _searchIndexCache = new Map();
const _searchIndexBuilding = new Map();
const SEARCH_INDEX_VERSION = 1;
const SEARCH_SNIPPET_RADIUS = 40;
const SEARCH_MAX_RESULTS = 50;

function getSearchIndexPath(agentId) {
  return path.join(getPrebuiltAgentSessionDir(agentId), 'search-index.json');
}

async function loadPersistentSearchIndex(agentId) {
  try {
    const raw = await fs.readFile(getSearchIndexPath(agentId), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== SEARCH_INDEX_VERSION) return null;
    return parsed.entries || {};
  } catch {
    return null;
  }
}

async function savePersistentSearchIndex(agentId, entriesMap) {
  try {
    const data = { version: SEARCH_INDEX_VERSION, entries: entriesMap };
    await fs.writeFile(getSearchIndexPath(agentId), JSON.stringify(data), 'utf8');
  } catch {}
}

async function extractSessionSearchText(sessionPath) {
  const raw = await fs.readFile(sessionPath, 'utf8');
  const parsed = JSON.parse(raw);
  const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
  const parts = [];
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      parts.push('[user] ' + m.content);
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      parts.push('[assistant] ' + m.content);
    }
  }
  return parts.join('\n');
}

async function ensureSearchIndex(agentId) {
  // Deduplicate concurrent builds
  if (_searchIndexBuilding.has(agentId)) {
    return _searchIndexBuilding.get(agentId);
  }

  const buildPromise = (async () => {
    const index = await readSessionIndex(agentId);
    const memCache = _searchIndexCache.get(agentId);
    const persistent = memCache ? null : await loadPersistentSearchIndex(agentId);

    // Source of truth for valid entries: index.json session IDs
    const validIds = new Set(index.sessions.map(s => s.id));

    // Build entries map: start from existing cache (in-memory or persistent)
    const entries = new Map();
    const toRead = []; // sessions that need file reads

    for (const record of index.sessions) {
      // Check in-memory cache first, then persistent
      const source = memCache?.get(record.id) || persistent?.[record.id];
      if (
        source &&
        source.fileMtimeMs === record.fileMtimeMs &&
        typeof source.text === 'string'
      ) {
        entries.set(record.id, {
          ...source,
          title: cleanSessionText(record.title) || source.title || record.id,
          openDirectory: cleanSessionText(record.openDirectory),
          sessionType: cleanSessionText(record.sessionType) || source.sessionType || 'main',
          archived: record.archived === true,
          todo: record.todo === true,
        });
      } else {
        toRead.push(record);
      }
    }

    // Read files in batches, yielding between batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < toRead.length; i += BATCH_SIZE) {
      const batch = toRead.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (record) => {
        try {
          const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
          const text = await extractSessionSearchText(sessionPath);
          entries.set(record.id, {
            sessionId: record.id,
            title: cleanSessionText(record.title) || record.id,
            openDirectory: cleanSessionText(record.openDirectory),
            sessionType: cleanSessionText(record.sessionType) || 'main',
            archived: record.archived === true,
            todo: record.todo === true,
            fileMtimeMs: record.fileMtimeMs || 0,
            text,
          });
        } catch {
          // Skip unreadable sessions
        }
      }));
      if (i + BATCH_SIZE < toRead.length) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    // Persist updated index (only if we actually read files)
    if (toRead.length > 0) {
      const persistData = {};
      for (const [id, entry] of entries) {
        persistData[id] = {
          sessionId: entry.sessionId,
          title: entry.title,
          openDirectory: entry.openDirectory,
          sessionType: entry.sessionType,
          archived: entry.archived,
          fileMtimeMs: entry.fileMtimeMs,
          text: entry.text,
        };
      }
      await savePersistentSearchIndex(agentId, persistData);
    }

    // Cache in memory
    _searchIndexCache.set(agentId, entries);
    return entries;
  })();

  _searchIndexBuilding.set(agentId, buildPromise);
  try {
    const result = await buildPromise;
    return result;
  } finally {
    _searchIndexBuilding.delete(agentId);
  }
}

function searchInText(text, queryLower) {
  const idx = text.toLowerCase().indexOf(queryLower);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + queryLower.length + SEARCH_SNIPPET_RADIUS);
  let snippet = text.slice(start, end);
  // Strip role prefix from the beginning of snippet if present
  snippet = snippet.replace(/^\[[^\]]*\]\s*/, '');
  // Determine match role by looking backwards for role tag
  const beforeSnippet = text.slice(0, idx);
  const lastRoleMatch = beforeSnippet.match(/\[(user|assistant)\][^\[]*$/);
  const matchRole = lastRoleMatch ? lastRoleMatch[1] : '';
  return { snippet, matchRole, matchIndex: idx };
}

async function searchSessionsContent(agentId, query, openDirectory) {
  const entries = await ensureSearchIndex(agentId);
  const queryLower = query.toLowerCase();
  const results = [];

  // Normalize openDirectory for filtering
  const normalizedDir = openDirectory
    ? String(openDirectory).replace(/\\/g, '/').toLowerCase()
    : null;

  for (const [sessionId, entry] of entries) {
    // Filter by openDirectory
    if (normalizedDir) {
      const entryDir = String(entry.openDirectory || '').replace(/\\/g, '/').toLowerCase();
      if (entryDir !== normalizedDir) continue;
    }

    // Search in text content
    const match = searchInText(entry.text, queryLower);
    if (match) {
      results.push({
        sessionId: entry.sessionId,
        title: entry.title,
        openDirectory: entry.openDirectory,
        sessionType: entry.sessionType || 'main',
        archived: entry.archived === true,
        snippet: match.snippet,
        matchRole: match.matchRole,
        matchedInText: true,
      });
    }
  }

  // Sort by title relevance then by recency (approximated by sessionId timestamp)
  results.sort((a, b) => {
    // Exact title match gets priority
    const aTitle = a.title.toLowerCase().includes(queryLower) ? 0 : 1;
    const bTitle = b.title.toLowerCase().includes(queryLower) ? 0 : 1;
    if (aTitle !== bTitle) return aTitle - bTitle;
    return String(b.sessionId).localeCompare(String(a.sessionId));
  });

  const total = results.length;
  const trimmed = results.slice(0, SEARCH_MAX_RESULTS);

  return {
    query,
    results: trimmed,
    total,
    indexed: entries.size,
  };
}

async function cleanupEmptySessions(agentId) {
  const index = await readSessionIndex(agentId);
  const toDelete = [];
  for (const record of index.sessions) {
    // Only target default "新对话N" titled sessions
    if (!/^新对话\d+$/.test(cleanSessionText(record.title))) continue;
    const sessionPath = getPrebuiltSessionFilePath(agentId, record.id);
    try {
      const raw = await fs.readFile(sessionPath, 'utf8');
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
      // Empty session: no messages at all (never had user input)
      if (messages.length === 0) {
        toDelete.push(record.id);
      }
    } catch {
      // Session file missing or corrupt — also clean up
      toDelete.push(record.id);
    }
  }

  if (toDelete.length === 0) return 0;

  let nextActiveId = index.activeSessionId;
  const remaining = index.sessions.filter((s) => !toDelete.includes(s.id));
  if (toDelete.includes(nextActiveId)) {
    nextActiveId = remaining[0]?.id ?? null;
  }
  await writeSessionIndex(agentId, { activeSessionId: nextActiveId, sessions: remaining });

  for (const id of toDelete) {
    await fs.rm(getPrebuiltSessionFilePath(agentId, id), { force: true }).catch(() => {});
  }

  console.log(`[sessions] cleaned up ${toDelete.length} empty session(s) for ${agentId}: ${toDelete.join(', ')}`);
  return toDelete.length;
}

async function listPrebuiltSessions(agentId) {
  const index = await readSessionIndex(agentId);
  const summaryMap = await buildSessionSummaryMap(agentId);
  const modelInfoMap = await buildSessionModelInfoMap(agentId);
  const sessions = await Promise.all(index.sessions.map((record) => summarizePrebuiltSession(agentId, record, summaryMap, modelInfoMap)));

  // ── Batch writeback of stale index metadata ──
  const writebacks = [];
  for (const s of sessions) {
    if (s?._metaWriteback) {
      writebacks.push({ id: s.id, updatedAt: s.updatedAt, ...s._metaWriteback });
      delete s._metaWriteback;
    }
  }
  if (writebacks.length > 0) {
    updateSessionIndex(agentId, (idx) => {
      let dirty = false;
      const sessionMap = new Map(idx.sessions.map((s) => [s.id, s]));
      for (const wb of writebacks) {
        const existing = sessionMap.get(wb.id);
        if (!existing) continue;
        if (
          existing.fileMtimeMs === wb.fileMtimeMs &&
          existing.fileSize === wb.fileSize &&
          existing.metaVersion === wb.metaVersion
        ) continue; // already up-to-date (concurrent list may have written first)
        dirty = true;
        sessionMap.set(wb.id, {
          ...existing,
          fileMtimeMs: wb.fileMtimeMs,
          fileSize: wb.fileSize,
          messageCount: wb.messageCount,
          preview: wb.preview,
          tokenUsage: wb.tokenUsage,
          savedAt: wb.savedAt,
          metaVersion: wb.metaVersion,
          updatedAt: wb.updatedAt,
        });
      }
      if (!dirty) return idx;
      return { ...idx, sessions: Array.from(sessionMap.values()) };
    }).catch(() => {});
  }

  sessions.sort((left, right) => {
    const aUpdated = String(right.updatedAt || '');
    const bUpdated = String(left.updatedAt || '');
    if (aUpdated !== bUpdated) return aUpdated.localeCompare(bUpdated);
    const aCreated = String(right.createdAt || '');
    const bCreated = String(left.createdAt || '');
    if (aCreated !== bCreated) return aCreated.localeCompare(bCreated);
    return String(right.id || '').localeCompare(String(left.id || ''));
  });
  const defaultModelInfo = modelInfoMap.default || modelInfoMap.main || {};
  return {
    activeSessionId: index.activeSessionId || (sessions[0]?.id ?? null),
    contextLength: defaultModelInfo.contextLength || null,
    compressRatio: defaultModelInfo.compressRatio || 80,
    sessions,
  };
}

async function buildSessionModelInfoMap(agentId) {
  const roles = ['default', 'exploration', 'sub'];
  const map = {};
  await Promise.all(roles.map(async (role) => {
    map[role] = await resolveSessionModelInfo(agentId, role);
  }));
  return map;
}

async function createPrebuiltSession(agentId, options = {}) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const sessionMetadata = normalizeSessionMetadata(options.metadata);
  const currentState = isWorkspaceSessionAgent(agentId)
    ? await readWorkspaceState(agentId)
    : null;
  const isProgrammingHelper = normalizedAgentId === 'programming-helper';
  const requestedFormId = cleanSessionText(options.formId) || (isProgrammingHelper ? '' : 'startup-form');
  const startupForm = isProgrammingHelper ? {} : (currentState?.forms?.['startup-form'] || {});
  const sourceForm = currentState?.forms?.[requestedFormId] || startupForm;
  const sourceSessionId = cleanSessionText(options.sourceSessionId);
  const preIndex = await readSessionIndex(agentId);
  const sourceSession = sourceSessionId
    ? preIndex.sessions.find((session) => session.id === sourceSessionId) || null
    : null;
  const createdAt = new Date().toISOString();
  const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const nextFeatureName =
    cleanSessionText(options.featureName)
    || cleanSessionText(sourceSession?.featureName)
    || cleanSessionText(sourceForm.feature_name)
    || cleanSessionText(startupForm.feature_name);
  const nextAgentName =
    cleanSessionText(options.agentName)
    || cleanSessionText(sourceSession?.agentName)
    || cleanSessionText(sourceForm.agent_name || sourceForm.assembly_name)
    || cleanSessionText(startupForm.agent_name);
  const assemblyForm = currentState?.forms?.['assembly-form'] || {};
  const nextAssemblyEnvDir =
    cleanSessionText(options.openDirectory)
    || cleanSessionText(sourceForm.env_dir)
    || cleanSessionText(assemblyForm.env_dir)
    || (requestedFormId === 'assembly-form' && nextAgentName ? getAssemblyWorkspaceDir(nextAgentName) : '');
  const nextOpenDirectory =
    requestedFormId === 'assembly-form'
      ? nextAssemblyEnvDir
      : (
        cleanSessionText(options.openDirectory)
        || cleanSessionText(sourceSession?.openDirectory)
        || cleanSessionText(currentState?.openDirectory)
      );
  const nextTaskTitle =
    cleanSessionText(options.taskTitle)
    || cleanSessionText(sourceSession?.taskTitle)
    || cleanSessionText(sourceForm.task_title)
    || cleanSessionText(startupForm.task_title);
  const nextTaskType =
    cleanSessionText(options.taskType)
    || cleanSessionText(sourceSession?.taskType)
    || cleanSessionText(sourceForm.task_type)
    || cleanSessionText(startupForm.task_type);
  const nextGoal =
    cleanSessionText(options.goal)
    || cleanSessionText(sourceSession?.goal)
    || cleanSessionText(sourceForm.goal)
    || cleanSessionText(startupForm.goal);
  const nextConstraints =
    cleanSessionText(options.constraints)
    || cleanSessionText(sourceSession?.constraints)
    || cleanSessionText(sourceForm.constraints)
    || cleanSessionText(startupForm.constraints);
  const nextExpectedOutput =
    cleanSessionText(options.expectedOutput)
    || cleanSessionText(sourceSession?.expectedOutput)
    || cleanSessionText(sourceForm.expected_output)
    || cleanSessionText(startupForm.expected_output);
  const nextTargetFiles =
    cleanSessionText(options.targetFiles)
    || cleanSessionText(sourceSession?.targetFiles)
    || cleanSessionText(sourceForm.target_files)
    || cleanSessionText(startupForm.target_files);
  const nextReferenceMaterials =
    cleanSessionText(options.referenceMaterials)
    || cleanSessionText(sourceSession?.referenceMaterials)
    || cleanSessionText(sourceForm.reference_materials)
    || cleanSessionText(startupForm.reference_materials);
  const sessionDisplayName = normalizedAgentId === 'agent-creator'
    ? nextAgentName
    : (normalizedAgentId === 'programming-helper' ? '' : nextFeatureName);
  const nextTitle = isProgrammingHelper
    ? await getNextNewSessionTitle(agentId, nextOpenDirectory)
    : buildNamedSessionTitle(sessionDisplayName, createdAt);
  // 解析当前模型配置，持久化到 session index record
  const sessionType = cleanSessionText(options.sessionType) || 'main';
  const modelRole = sessionType === 'exploration' ? 'exploration' : sessionType === 'sub' ? 'sub' : 'default';
  const currentModelInfo = await resolveSessionModelInfo(agentId, modelRole);

  const record = {
    id: sessionId,
    title: nextTitle,
    featureName: nextFeatureName,
    agentName: nextAgentName,
    taskTitle: nextTaskTitle,
    taskType: nextTaskType,
    goal: nextGoal,
    constraints: nextConstraints,
    expectedOutput: nextExpectedOutput,
    targetFiles: nextTargetFiles,
    referenceMaterials: nextReferenceMaterials,
    formId: requestedFormId,
    openDirectory: nextOpenDirectory,
    sessionType,
    metadata: sessionMetadata,
    modelName: currentModelInfo.modelName || '',
    contextLength: currentModelInfo.contextLength || null,
    createdAt,
    updatedAt: createdAt,
  };
  const nextIndex = await updateSessionIndex(agentId, (index) => {
    return {
      activeSessionId: sessionId,
      sessions: [record, ...index.sessions.filter((session) => session.id !== sessionId)],
    };
  });

  if (normalizedAgentId === 'feature-creator') {
    const featureName = nextFeatureName || cleanSessionText(startupForm.feature_name);
    const openDirectory = nextOpenDirectory || cleanSessionText(currentState.openDirectory);
    const targetDir = cleanSessionText(options.targetDir)
      || (openDirectory ? path.dirname(openDirectory) : cleanSessionText(startupForm.target_dir));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'startup-form': {
          ...startupForm,
          feature_name: featureName,
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'agent-creator') {
    const formId = requestedFormId;
    const targetForm = currentState.forms?.[formId] || {};
    const agentName = nextAgentName || cleanSessionText(targetForm.agent_name || targetForm.assembly_name || startupForm.agent_name);
    const openDirectory = formId === 'assembly-form'
      ? (nextOpenDirectory || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(agentName || 'assembled-agent'))
      : (nextOpenDirectory || cleanSessionText(currentState.openDirectory));
    const targetDir = cleanSessionText(options.targetDir)
      || (openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir || startupForm.target_dir));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'flow-workspace') {
    const formId = requestedFormId;
    const targetForm = currentState.forms?.[formId] || {};
    const agentName = nextAgentName || cleanSessionText(targetForm.agent_name || targetForm.assembly_name);
    const openDirectory = formId === 'assembly-form'
      ? (nextOpenDirectory || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(agentName || 'flow-agent'))
      : (nextOpenDirectory || cleanSessionText(currentState.openDirectory));
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? { assembly_name: agentName, env_created: '1', env_dir: openDirectory }
            : { agent_name: agentName }),
        },
      },
      openDirectory,
    });
  } else if (normalizedAgentId === 'programming-helper') {
    const openDirectory = nextOpenDirectory || cleanSessionText(currentState.openDirectory);
    const cleanedForms = { ...currentState.forms };
    delete cleanedForms['startup-form'];
    await writeWorkspaceState(agentId, {
      forms: cleanedForms,
      openDirectory,
    });
  }

  if (options.returnSummary === false) {
    return buildLightPrebuiltSessionRecord(agentId, record);
  }
  return summarizePrebuiltSession(agentId, record);
}

async function activatePrebuiltSession(agentId, sessionId, options = {}) {
  await updateSessionIndex(agentId, (index) => {
    const session = index.sessions.find((s) => s.id === sessionId);
    if (!session) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    return { ...index, activeSessionId: sessionId };
  });

  const index = await readSessionIndex(agentId);
  const existing = index.sessions.find((s) => s.id === sessionId);

  if (sanitizeSessionFragment(agentId) === 'feature-creator') {
    const currentState = await readWorkspaceState(agentId);
    const startupForm = currentState.forms?.['startup-form'] || {};
    const openDirectory = cleanSessionText(existing?.openDirectory) || cleanSessionText(currentState.openDirectory);
    const featureName = cleanSessionText(existing?.featureName) || cleanSessionText(startupForm.feature_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(startupForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'startup-form': {
          ...startupForm,
          feature_name: featureName,
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'agent-creator') {
    const currentState = await readWorkspaceState(agentId);
    const formId = cleanSessionText(existing.formId) || 'startup-form';
    const startupForm = currentState.forms?.['startup-form'] || {};
    const targetForm = currentState.forms?.[formId] || startupForm;
    const openDirectory = formId === 'assembly-form'
      ? (cleanSessionText(existing.openDirectory) || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(cleanSessionText(existing.agentName) || 'assembled-agent'))
      : (cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory));
    const agentName = cleanSessionText(existing.agentName) || cleanSessionText(targetForm.agent_name || targetForm.assembly_name || startupForm.agent_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir || startupForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'flow-workspace') {
    const currentState = await readWorkspaceState(agentId);
    const formId = cleanSessionText(existing.formId) || 'assembly-form';
    const targetForm = currentState.forms?.[formId] || {};
    const openDirectory = formId === 'assembly-form'
      ? (cleanSessionText(existing.openDirectory) || cleanSessionText(targetForm.env_dir) || getAssemblyWorkspaceDir(cleanSessionText(existing.agentName) || 'flow-agent'))
      : (cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory));
    const agentName = cleanSessionText(existing.agentName) || cleanSessionText(targetForm.agent_name || targetForm.assembly_name);
    const targetDir = openDirectory ? path.dirname(openDirectory) : cleanSessionText(targetForm.target_dir);
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        [formId]: {
          ...targetForm,
          ...(formId === 'assembly-form'
            ? {
                assembly_name: agentName,
                env_created: '1',
                env_dir: openDirectory,
              }
            : { agent_name: agentName }),
          target_dir: targetDir,
        },
      },
      openDirectory,
    });
  } else if (sanitizeSessionFragment(agentId) === 'programming-helper') {
    const currentState = await readWorkspaceState(agentId);
    const openDirectory = cleanSessionText(existing.openDirectory) || cleanSessionText(currentState.openDirectory);
    const cleanedForms = { ...currentState.forms };
    delete cleanedForms['startup-form'];
    await writeWorkspaceState(agentId, {
      forms: cleanedForms,
      openDirectory,
    });
  }

  if (options?.returnSummary === false) {
    return buildLightPrebuiltSessionRecord(agentId, existing);
  }
  return summarizePrebuiltSession(agentId, existing);
}

async function deletePrebuiltSession(agentId, sessionId) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }

    const remainingSessions = index.sessions.filter((session) => session.id !== sessionId);
    const nextActiveSessionId = index.activeSessionId === sessionId
      ? (remainingSessions[0]?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId: nextActiveSessionId, sessions: remainingSessions };
  });

  await fs.rm(getPrebuiltSessionFilePath(agentId, sessionId), { force: true }).catch(() => {});

  return {
    deletedSessionId: sessionId,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function archivePrebuiltSession(agentId, sessionId, archived) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    const sessions = index.sessions.map((session) =>
      session.id === sessionId ? { ...session, archived: !!archived, todo: archived ? false : session.todo } : session,
    );
    return { activeSessionId: index.activeSessionId, sessions };
  });

  return {
    archivedSessionId: sessionId,
    archived: !!archived,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function tagPrebuiltSessionTodo(agentId, sessionId, todo) {
  const newIndex = await updateSessionIndex(agentId, (index) => {
    const existing = index.sessions.find((session) => session.id === sessionId);
    if (!existing) {
      const error = new Error(`Unknown prebuilt session: ${sessionId}`);
      error.statusCode = 404;
      throw error;
    }
    // Only non-archived sessions can be tagged as todo
    if (todo && existing.archived) {
      const error = new Error('Cannot tag an archived session as todo');
      error.statusCode = 400;
      throw error;
    }
    const sessions = index.sessions.map((session) =>
      session.id === sessionId ? { ...session, todo: !!todo } : session,
    );
    return { activeSessionId: index.activeSessionId, sessions };
  });

  return {
    todoSessionId: sessionId,
    todo: !!todo,
    activeSessionId: newIndex.activeSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

async function requirePrebuiltSessionRecord(agentId, sessionId) {
  const index = await readSessionIndex(agentId);
  const existing = index.sessions.find((session) => session.id === cleanSessionText(sessionId));
  if (!existing) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }
  return existing;
}

async function resolvePrebuiltSessionOwner(sessionId, preferredAgentId = '') {
  const cleanSessionId = cleanSessionText(sessionId);
  if (!cleanSessionId) return null;

  const candidates = [];
  const addCandidate = (agentId) => {
    const normalized = normalizeClientAgentId(agentId);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  addCandidate(preferredAgentId);
  addCandidate('flow-workspace');
  addCandidate('agent-creator');
  addCandidate('feature-creator');
  addCandidate('programming-helper');
  try {
    const discovered = await discoverAgents(AGENTS_ROOT);
    discovered.forEach((agent) => addCandidate(agent?.id));
  } catch {}

  for (const agentId of candidates) {
    try {
      const index = await readSessionIndex(agentId);
      if (index.sessions.some((session) => session.id === cleanSessionId)) {
        return agentId;
      }
    } catch {}
  }

  return null;
}

async function requirePrebuiltAgentForRuntime(agentId) {
  const normalizedAgentId = normalizeClientAgentId(agentId);
  const discovered = await discoverAgents(AGENTS_ROOT);
  const metadata = discovered.find((item) => sanitizeSessionFragment(item.id) === normalizedAgentId);
  if (!metadata) {
    const error = new Error(`Unknown agent: ${agentId}`);
    error.statusCode = 404;
    throw error;
  }
  return enrichAgent(metadata);
}

async function exportContextHandoffForSession(sessionId, preferredAgentId = '', policy = {}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  const summary = await summarizePrebuiltSession(ownerAgentId, record);
  if (!summary.exists) {
    const error = new Error(`Session snapshot not found for handoff export: ${sessionId}`);
    error.statusCode = 409;
    throw error;
  }
  const sessionPath = getPrebuiltSessionFilePath(ownerAgentId, sessionId);
  const normalizedStrategy = typeof policy?.strategy === 'string' ? policy.strategy.trim() : '';
  if (normalizedStrategy === 'summarized-nine-section') {
    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    return exportSummarizedHandoffPackage({
      userDataRoot: USER_DATA_ROOT,
      agentId: ownerAgentId,
      sessionId,
      sourceRecord: record,
      policy,
      agentRelativeDir: agent.relativeDir,
      projectRoot: __dirname,
    });
  }
  return exportHistoryOnlyHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sessionPath,
    sourceRecord: record,
    policy,
  });
}

async function createCompactedResumeFromHandoff({
  preferredAgentId = '',
  handoffId = '',
  handoffPath = '',
  goal = '',
  startRuntime = true,
}) {
  const normalizedAgentId = normalizeClientAgentId(preferredAgentId);
  if (!handoffPath && (!normalizedAgentId || !handoffId)) {
    const error = new Error('agentId is required when resuming from handoffId');
    error.statusCode = 400;
    throw error;
  }
  const { handoff, handoffPath: resolvedHandoffPath } = await readHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: normalizedAgentId || cleanSessionText(preferredAgentId),
    handoffId,
    handoffPath,
  });
  const sourceAgentId = cleanSessionText(handoff?.sourceAgentId);
  const sourceSessionId = cleanSessionText(handoff?.sourceSessionId);

  if (!sourceAgentId || !sourceSessionId) {
    const error = new Error('Invalid handoff package: sourceAgentId/sourceSessionId is required');
    error.statusCode = 400;
    throw error;
  }

  if (normalizedAgentId && normalizedAgentId !== sanitizeSessionFragment(sourceAgentId)) {
    const error = new Error('Phase-1 compacted resume only supports resuming within the source agent');
    error.statusCode = 400;
    throw error;
  }

  const agent = await requirePrebuiltAgentForRuntime(sourceAgentId);
  if (!handoff?.stats?.synthetic) {
    await requirePrebuiltSessionRecord(agent.id, sourceSessionId);
  }
  const session = await createPrebuiltSession(agent.id, {
    sourceSessionId,
    goal: goal || undefined,
      metadata: {
        resumeMode: 'compacted',
        sourceAgentId,
        sourceSessionId,
        handoffId: cleanSessionText(handoff?.handoffId) || cleanSessionText(handoffId),
        handoffPath: resolvedHandoffPath,
        handoffCreatedAt: cleanSessionText(handoff?.createdAt),
        handoffMode: cleanSessionText(handoff?.mode),
        handoffSummaryKind: cleanSessionText(handoff?.summaryShape),
      },
    });

  let status = null;
  let connected = null;
  if (startRuntime) {
    status = await startManagedAgent(agent, session.id, {
      extraEnv: {
        PROTOCLAW_HANDOFF_PATH: resolvedHandoffPath,
      },
    });
    connected = await waitForManagedRuntimeReady(agent.id, 10000, session.id);
  }

  return {
    handoff,
    handoffPath: resolvedHandoffPath,
    session,
    status,
    agent: connected,
  };
}

async function compactAndResumeCurrentSession({
  preferredAgentId = '',
  sessionId = '',
  policy = {},
  startRuntime = true,
}) {
  const exportResult = await exportContextHandoffForSession(sessionId, preferredAgentId, policy);
  const handoffPath = cleanSessionText(exportResult?.handoffPath);
  const handoffId = cleanSessionText(exportResult?.handoff?.handoffId);
  return createCompactedResumeFromHandoff({
    preferredAgentId,
    handoffId,
    handoffPath,
    startRuntime,
  });
}

async function compactAndResumeFromProvidedSummary({
  preferredAgentId = '',
  sessionId = '',
  summaryText = '',
  rawResponse = '',
  importantFiles = [],
  importantSkills = [],
  sessionTitle = '',
  fileRanges = {},
  policy = {},
  startRuntime = true,
}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  const handoffResult = await writeSummarizedHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sourceRecord: record,
    policy,
    summaryText,
    rawResponse,
    importantFiles,
    importantSkills,
    sessionTitle,
    fileRanges,
  });

  return createCompactedResumeFromHandoff({
    preferredAgentId: ownerAgentId,
    handoffId: cleanSessionText(handoffResult?.handoff?.handoffId),
    handoffPath: cleanSessionText(handoffResult?.handoffPath),
    startRuntime,
  });
}

async function exportProvidedSummaryHandoff({
  preferredAgentId = '',
  sessionId = '',
  summaryText = '',
  rawResponse = '',
  importantFiles = [],
  importantSkills = [],
  sessionTitle = '',
  fileRanges = {},
  policy = {},
  sessionTimestamp = null,
  gitMeta = null,
}) {
  const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, preferredAgentId);
  if (!ownerAgentId) {
    const error = new Error(`Unknown prebuilt session: ${sessionId}`);
    error.statusCode = 404;
    throw error;
  }

  const record = await requirePrebuiltSessionRecord(ownerAgentId, sessionId);
  return writeSummarizedHandoffPackage({
    userDataRoot: USER_DATA_ROOT,
    agentId: ownerAgentId,
    sessionId,
    sourceRecord: record,
    policy,
    summaryText,
    rawResponse,
    importantFiles,
    importantSkills,
    sessionTitle,
    fileRanges,
    sessionTimestamp,
    gitMeta,
  });
}

async function deletePrebuiltProject(agentId, projectId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (!WORKSPACE_SESSION_AGENT_IDS.has(normalizedAgentId)) {
    const error = new Error(`Agent ${agentId} does not support project deletion`);
    error.statusCode = 400;
    throw error;
  }

  const state = await readWorkspaceState(agentId);
  const projectsKey = normalizedAgentId === 'feature-creator'
    ? 'featureProjects'
    : normalizedAgentId === 'programming-helper'
      ? 'phProjects'
      : 'agentProjects';
  const projects = Array.isArray(state[projectsKey]) ? [...state[projectsKey]] : [];
  const projectIndex = projects.findIndex((p) => p?.id === projectId);

  if (projectIndex < 0) {
    const error = new Error(`Unknown project: ${projectId}`);
    error.statusCode = 404;
    throw error;
  }

  const project = projects[projectIndex];
  const projectOpenDirectory = typeof project.openDirectory === 'string' ? project.openDirectory.trim().toLowerCase().replace(/\\/g, '/') : '';
  const projectFeatureName = typeof (project.featureName || project.agentName) === 'string' ? (project.featureName || project.agentName).trim().toLowerCase() : '';

  projects.splice(projectIndex, 1);
  await writeWorkspaceState(agentId, { [projectsKey]: projects });

  let sessionsToDelete = [];
  let nextActiveSessionId = null;
  await updateSessionIndex(agentId, (index) => {
    sessionsToDelete = [];
    const remainingSessions = index.sessions.filter((session) => {
      const sessionDir = typeof session.openDirectory === 'string' ? session.openDirectory.trim().toLowerCase().replace(/\\/g, '/') : '';
      const sessionName = typeof (session.featureName || session.agentName) === 'string' ? (session.featureName || session.agentName).trim().toLowerCase() : '';
      const matchesDir = projectOpenDirectory && sessionDir === projectOpenDirectory;
      const matchesName = !projectOpenDirectory && projectFeatureName && sessionName === projectFeatureName;
      if (matchesDir || matchesName) {
        sessionsToDelete.push(session);
        return false;
      }
      return true;
    });

    const deletedWasActive = sessionsToDelete.some((s) => s.id === index.activeSessionId);
    nextActiveSessionId = deletedWasActive
      ? (remainingSessions[0]?.id ?? null)
      : index.activeSessionId;
    return { activeSessionId: nextActiveSessionId, sessions: remainingSessions };
  });

  for (const session of sessionsToDelete) {
    await fs.rm(getPrebuiltSessionFilePath(agentId, session.id), { force: true }).catch(() => {});
  }

  return {
    deletedProjectId: projectId,
    deletedSessionIds: sessionsToDelete.map((s) => s.id),
    activeSessionId: nextActiveSessionId,
    sessions: await listPrebuiltSessions(agentId),
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const quoteCmdArg = (value) => {
      const text = String(value ?? '');
      if (text.length === 0) return '""';
      if (!/[ \t"&()^<>|]/.test(text)) return text;
      return `"${text.replace(/"/g, '\\"')}"`;
    };

    const child = isWindows
      ? spawn(process.env.ComSpec || 'cmd.exe', [
          '/d',
          '/s',
          '/c',
          [quoteCmdArg(command), ...(args || []).map(quoteCmdArg)].join(' '),
        ], {
          windowsHide: false,
          cwd: options.cwd || __dirname,
        })
      : spawn(command, args, {
          windowsHide: false,
          cwd: options.cwd || __dirname,
        });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function selectEmptyDirectory() {
  const selectedPath = await runInteractiveSelectionScript([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; WindowState = \'Minimized\'; ShowInTaskbar = $false }',
    '$owner.Show()',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "选择一个空文件夹"',
    '$dialog.Filter = "文件夹|*.folder"',
    '$dialog.CheckFileExists = $false',
    '$dialog.CheckPathExists = $true',
    '$dialog.ValidateNames = $false',
    '$dialog.FileName = "选择此文件夹.folder"',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", (Split-Path $dialog.FileName -Parent), [Text.Encoding]::UTF8)',
    '} else {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", "CANCELLED", [Text.Encoding]::UTF8)',
    '}',
  ]);
  if (!selectedPath) {
    return { path: '', cancelled: true };
  }

  return { path: selectedPath, cancelled: false };
}

async function selectFiles() {
  const stdout = await runInteractiveSelectionScript([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; WindowState = \'Minimized\'; ShowInTaskbar = $false }',
    '$owner.Show()',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "选择资料文件"',
    '$dialog.Multiselect = $true',
    '$dialog.CheckFileExists = $true',
    '$dialog.CheckPathExists = $true',
    '$dialog.Filter = "所有文件|*.*"',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllLines("__OUT__", $dialog.FileNames, [Text.Encoding]::UTF8)',
    '} else {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", "CANCELLED", [Text.Encoding]::UTF8)',
    '}',
  ]);
  const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && line !== 'CANCELLED');
  return { paths, cancelled: paths.length === 0 };
}

async function selectDirectory() {
  const selectedPath = await runInteractiveSelectionScript([
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; WindowState = \'Minimized\'; ShowInTaskbar = $false }',
    '$owner.Show()',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    '$dialog.Title = "选择资料文件夹"',
    '$dialog.Filter = "文件夹|*.folder"',
    '$dialog.CheckFileExists = $false',
    '$dialog.CheckPathExists = $true',
    '$dialog.ValidateNames = $false',
    '$dialog.FileName = "选择此文件夹.folder"',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", (Split-Path $dialog.FileName -Parent), [Text.Encoding]::UTF8)',
    '} else {',
    '  $owner.Close()',
    '  [IO.File]::WriteAllText("__OUT__", "CANCELLED", [Text.Encoding]::UTF8)',
    '}',
  ]);
  return { path: selectedPath, cancelled: !selectedPath };
}

async function runInteractiveSelectionScript(scriptLines, options = {}) {
  const outputPath = path.join(os.tmpdir(), `agentdevclaw-select-${randomUUID()}.txt`);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5 * 60 * 1000;
  const selectionScript = Array.isArray(scriptLines) ? scriptLines.join('\n') : String(scriptLines || '');
  const escapedOutputPath = outputPath.replace(/\\/g, '\\\\');
  const finalScript = selectionScript.replace(/__OUT__/g, escapedOutputPath);
  const encodedSelection = Buffer.from(finalScript, 'utf16le').toString('base64');
  const launcherScript = [
    '$ErrorActionPreference = "Stop"',
    `$outputPath = "${escapedOutputPath}"`,
    'if (Test-Path $outputPath) { Remove-Item $outputPath -Force -ErrorAction SilentlyContinue }',
    `$encoded = "${encodedSelection}"`,
    '$proc = Start-Process powershell.exe -ArgumentList \'-NoProfile\',\'-STA\',\'-EncodedCommand\',$encoded -WindowStyle Hidden -PassThru',
    'Write-Output $proc.Id',
  ].join('\n');
  const encodedLauncher = Buffer.from(launcherScript, 'utf16le').toString('base64');
  const { stdout } = await runCommand('powershell.exe', ['-NoProfile', '-EncodedCommand', encodedLauncher]);
  const childPid = Number.parseInt(stdout.trim(), 10);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const content = await fs.readFile(outputPath, 'utf8').catch(() => null);
    if (typeof content === 'string') {
      await fs.unlink(outputPath).catch(() => {});
      return content.trim() === 'CANCELLED' ? '' : content.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (Number.isFinite(childPid) && childPid > 0) {
    await runCommand('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${childPid} -Force -ErrorAction SilentlyContinue`]).catch(() => {});
  }
  await fs.unlink(outputPath).catch(() => {});
  const error = new Error('Selection dialog timed out');
  error.statusCode = 504;
  throw error;
}

async function validateEmptyDirectory(dirPath) {
  const selectedPath = path.resolve(String(dirPath || '').trim());
  const stat = await fs.stat(selectedPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    const error = new Error('Selected path is not a directory');
    error.statusCode = 400;
    throw error;
  }
  const entries = await fs.readdir(selectedPath).catch(() => []);
  if (entries.length > 0) {
    const error = new Error('Selected directory is not empty');
    error.statusCode = 400;
    throw error;
  }

  return { path: selectedPath, valid: true };
}

async function initializeFeatureCreatorWorkspace(rawFeatureName, rawParentDir) {
  const featureName = String(rawFeatureName || '').trim();
  const parentDir = path.resolve(String(rawParentDir || '').trim());

  if (!isValidFeatureName(featureName)) {
    const error = new Error('Invalid feature name. Use lowercase letters, numbers, and hyphens only.');
    error.statusCode = 400;
    throw error;
  }

  const parentStat = await fs.stat(parentDir).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) {
    const error = new Error(`Parent directory does not exist: ${parentDir}`);
    error.statusCode = 400;
    throw error;
  }

  const outputDir = resolveFeatureCreatorOutputDir(parentDir, featureName);
  const outputExists = await fs.stat(outputDir).then(() => true).catch(() => false);
  if (outputExists) {
    const error = new Error(`Feature directory already exists: ${outputDir}`);
    error.statusCode = 409;
    throw error;
  }

  const cliExists = await fs.stat(AGENTDEV_CREATE_FEATURE_CLI).then(() => true).catch(() => false);
  if (!cliExists) {
    const error = new Error(`Feature scaffold CLI not found: ${AGENTDEV_CREATE_FEATURE_CLI}`);
    error.statusCode = 500;
    throw error;
  }

  const { stdout, stderr } = await runCommand(process.execPath, [AGENTDEV_CREATE_FEATURE_CLI, featureName], {
    cwd: parentDir,
  });
  const metadataFiles = await ensureFeatureProjectManifest(outputDir);
  await ensureProjectDocset(outputDir, {
    workspaceId: 'feature-creator',
    projectType: 'feature',
    projectName: featureName,
    targetDir: parentDir,
  });

  return {
    featureName,
    parentDir,
    outputDir,
    metadataFiles,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

function buildGeneratedAgentClassName(agentName) {
  const parts = String(agentName || '').trim().split('-').filter(Boolean);
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('') || 'GeneratedAgent';
}

function buildAgentWorkspacePackageJson(agentName) {
  return {
    name: `@local/${agentName}`,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: `${agentName} generated by AgentDevClaw agent creator`,
    scripts: {
      start: 'node agent.js',
    },
    dependencies: {
      agentdev: '^0.1.0',
      '@agentdev/audit-feature': '^0.1.0',
      '@agentdev/shell-feature': '^0.1.0',
      '@agentdev/websearch-feature': '^0.1.0',
    },
    engines: {
      node: '>=20',
    },
  };
}

function buildAgentWorkspaceMetadata(agentName, goal) {
  const displayName = buildGeneratedAgentClassName(agentName);

  return {
    id: agentName,
    kind: 'agent',
    name: displayName,
    description: goal || `${agentName} generated by AgentDevClaw`,
    version: '0.1.0',
    icon: 'bot',
    category: 'custom',
    enabled: true,
    features: ['todo', 'audit', 'shell', 'websearch', 'user-input', 'mcp', 'skill'],
    ui: {
      entry: 'home',
      tabs: [
        {
          id: 'home',
          label: {
            zh: '首页',
            en: 'Home',
          },
        },
        {
          id: 'chat',
          label: {
            zh: '对话',
            en: 'Chat',
          },
        },
      ],
      home: {
        blocks: [
          {
            id: 'hero',
            type: 'hero',
            title: {
              zh: displayName,
              en: displayName,
            },
            body: {
              zh: goal || '这是一个由 Agent 创建者初始化的 Agent 工作空间，可以继续补全能力、提示词和挂载的 Features。',
              en: goal || 'This agent workspace was initialized by Agent Creator and can now be extended with prompts and features.',
            },
          },
          {
            id: 'session-list',
            type: 'session-list',
            visibility: 'home-default',
            title: {
              zh: '历史会话',
              en: 'Sessions',
            },
            description: {
              zh: '恢复或继续这个 Agent 的工作会话。',
              en: 'Resume prior work sessions for this agent.',
            },
          },
        ],
      },
    },
  };
}

function buildAgentWorkspaceAgentSource(agentName, goal) {
  const className = `${buildGeneratedAgentClassName(agentName)}Agent`;

  return `import { BasicAgent, TemplateComposer, TodoFeature, UserInputFeature } from 'agentdev';
import { AuditFeature } from '@agentdev/audit-feature';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');

export class ${className} extends BasicAgent {
  constructor(config = {}) {
    super(config);

    this.use(new TodoFeature({
      reminderThresholdWithTasks: config.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
    }));
    this.use(new AuditFeature());
    this.use(new WebSearchFeature());
    this.use(new ShellFeature());
    this.use(new UserInputFeature());
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);

    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\\n\\n## 当前目标\\n\\n')
      .add(${JSON.stringify(goal || '请根据用户需求继续完善这个 Agent 的能力、提示词与工作流。')})
      .add('\\n\\n## 可用技能\\n\\n')
      .add({ skills: '- **{{name}}**: {{description}}' }));
  }
}
`;
}

function buildAgentWorkspaceSystemPrompt(agentName, goal) {
  return `# ${buildGeneratedAgentClassName(agentName)}

你是 \`${agentName}\` 的系统提示词草稿。

## 目标

${goal || '根据用户后续要求继续完善你的职责与边界。'}

## 默认约束

- 先澄清用户意图，再执行
- 优先复用现有 Feature、Skills 和 MCP 能力
- 如果用户要求改代码，先确认范围，再最小化修改
`;
}

function buildAgentWorkspaceReadme(agentName, goal) {
  return `# ${agentName}

由 AgentDevClaw 的 Agent 创建者初始化。

## 当前目标

${goal || '待补充'}

## 初始结构

- \`agent.js\`: Agent 入口
- \`metadata.json\`: Claw 预制工作空间元数据草稿
- \`.agentdev/prompts/system.md\`: 系统提示词草稿
- \`package.json\`: 基础依赖与脚本
`;
}

async function initializeAgentCreatorWorkspace(rawAgentName, rawParentDir, rawGoal) {
  const agentName = String(rawAgentName || '').trim();
  const parentDir = path.resolve(String(rawParentDir || '').trim());
  const goal = String(rawGoal || '').trim();

  if (!isValidFeatureName(agentName)) {
    const error = new Error('Invalid agent name. Use lowercase letters, numbers, and hyphens only.');
    error.statusCode = 400;
    throw error;
  }

  const parentStat = await fs.stat(parentDir).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) {
    const error = new Error(`Parent directory does not exist: ${parentDir}`);
    error.statusCode = 400;
    throw error;
  }

  const outputDir = path.join(parentDir, agentName);
  const outputExists = await fs.stat(outputDir).then(() => true).catch(() => false);
  if (outputExists) {
    const error = new Error(`Agent directory already exists: ${outputDir}`);
    error.statusCode = 409;
    throw error;
  }

  await fs.mkdir(path.join(outputDir, '.agentdev', 'prompts'), { recursive: true });
  await fs.writeFile(path.join(outputDir, 'package.json'), `${JSON.stringify(buildAgentWorkspacePackageJson(agentName), null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'metadata.json'), `${JSON.stringify(buildAgentWorkspaceMetadata(agentName, goal), null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDir, 'agent.js'), buildAgentWorkspaceAgentSource(agentName, goal), 'utf8');
  await fs.writeFile(path.join(outputDir, '.agentdev', 'prompts', 'system.md'), buildAgentWorkspaceSystemPrompt(agentName, goal), 'utf8');
  await fs.writeFile(path.join(outputDir, 'README.md'), buildAgentWorkspaceReadme(agentName, goal), 'utf8');
  await ensureProjectDocset(outputDir, {
    workspaceId: 'agent-creator',
    projectType: 'agent',
    projectName: agentName,
    targetDir: parentDir,
    goal,
  });

  return {
    agentName,
    parentDir,
    outputDir,
    files: [
      'package.json',
      'metadata.json',
      'agent.js',
      '.agentdev/prompts/system.md',
      'README.md',
    ],
  };
}

async function discoverAgents(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await discoverAgents(rootDir, entryPath));
      continue;
    }

    if (entry.isFile() && entry.name === 'metadata.json') {
      const metadata = await readJson(entryPath);
      const agentDir = path.dirname(entryPath);
      results.push({
        ...metadata,
        id: metadata.id ?? path.basename(agentDir),
        relativeDir: path.relative(__dirname, agentDir).replace(/\\/g, '/'),
        agentPath: agentDir,
      });
    }
  }

  return results.sort((left, right) => {
    const leftOrder = typeof left.sortOrder === 'number' ? left.sortOrder : null;
    const rightOrder = typeof right.sortOrder === 'number' ? right.sortOrder : null;
    if (leftOrder !== null && rightOrder !== null) return leftOrder - rightOrder;
    if (leftOrder !== null) return -1;
    if (rightOrder !== null) return 1;
    return (left.name || left.id).localeCompare(right.name || right.id, 'zh-CN');
  });
}

async function getAgentsLight() {
  const agents = await discoverAgents(AGENTS_ROOT);
  const visibleAgents = agents.filter((agent) => !HIDDEN_PREBUILT_AGENT_IDS.has(sanitizeSessionFragment(agent.id)));
  return visibleAgents.map((agent) => ({ ...agent, status: buildStatus(agent.id) }));
}

async function enrichAgent(agent) {
  return {
    ...agent,
    workspace_sessions: await listPrebuiltSessions(agent.id),
    workspace_data: await resolveWorkspaceData(agent),
    workspace_state: await readWorkspaceState(agent.id),
  };
}

async function getAgents() {
  const lightAgents = await getAgentsLight();
  return Promise.all(lightAgents.map(enrichAgent));
}

async function requireAgentLight(agentId) {
  const lightAgents = await getAgentsLight();
  const agent = lightAgents.find((item) => item.id === agentId);
  if (agent) return agent;
  // Fallback: hidden agents (e.g. work-group-admin) are not in getAgentsLight
  const allAgents = await discoverAgents(AGENTS_ROOT);
  const hidden = allAgents.find((item) => item.id === agentId);
  if (hidden) return { ...hidden, status: buildStatus(agentId) };
  const error = new Error(`Unknown agent: ${agentId}`);
  error.statusCode = 404;
  throw error;
}

async function requireAgent(agentId) {
  const agent = await requireAgentLight(agentId);
  return enrichAgent(agent);
}

function normalizeClientAgentId(value, fallback = '') {
  const text = cleanSessionText(value);
  if (!text) return fallback;
  const lower = text.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return fallback;
  return sanitizeSessionFragment(text);
}

async function readViewerJson(pathname) {
  const response = await fetch(`${VIEWER_ORIGIN}${pathname}`);
  if (!response.ok) {
    throw new Error(`Viewer request failed: ${pathname} ${response.status}`);
  }
  return response.json();
}

async function getPendingInputCount(runtimeSessionId) {
  try {
    const items = await readViewerJson(`/api/agents/${encodeURIComponent(runtimeSessionId)}/input-requests`);
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return null;
  }
}

function resolveActiveWorkspaceSessionMeta(agent) {
  const sessions = Array.isArray(agent?.workspace_sessions?.sessions) ? agent.workspace_sessions.sessions : [];
  const activeSessionId = cleanSessionText(agent?.status?.selectedSessionId || agent?.workspace_sessions?.activeSessionId);
  if (!activeSessionId) {
    return {
      active_workspace_session_id: null,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }

  const matched = sessions.find((session) => cleanSessionText(session?.id) === activeSessionId) || null;
  const formId = cleanSessionText(matched?.formId);
  const title = cleanSessionText(matched?.title);
  const agentName = cleanSessionText(matched?.agentName);
  const displayName = formId === 'assembly-form'
    ? (agentName || title)
    : '';

  return {
    active_workspace_session_id: activeSessionId,
    active_workspace_session_form_id: formId || null,
    active_workspace_session_title: title,
    active_workspace_agent_name: agentName,
    active_workspace_display_name: displayName,
  };
}

async function resolveRuntimeDisplayName(agent, selectedSessionId = null) {
  const fallbackName = cleanSessionText(agent?.name) || cleanSessionText(agent?.id) || 'agent';
  const requestedSessionId = cleanSessionText(selectedSessionId);
  if (sanitizeSessionFragment(agent?.id) === 'qqbot') {
    try {
      const imConfig = await readProjectIMWorkspaceConfig();
      return getPortalAgentDisplayName(imConfig.selectedChannel);
    } catch {}
    return getPortalAgentDisplayName('qq');
  }
  if (!requestedSessionId) {
    return fallbackName;
  }

  try {
    const sessionIndex = await readSessionIndex(agent.id);
    const sessionRecord = sessionIndex.sessions.find((session) => cleanSessionText(session?.id) === requestedSessionId) || { id: requestedSessionId };
    const sessionSummary = await summarizePrebuiltSession(agent.id, sessionRecord);
    const formId = cleanSessionText(sessionSummary?.formId);
    if (sanitizeSessionFragment(agent?.id) === 'agent-creator' && formId === 'assembly-form') {
      return cleanSessionText(sessionSummary?.agentName) || cleanSessionText(sessionSummary?.title) || fallbackName;
    }
  } catch {
  }

  return fallbackName;
}

async function readWorkspaceSessionSnapshot(agentId) {
  const index = await readSessionIndex(agentId);
  return {
    activeSessionId: index.activeSessionId || null,
    sessions: index.sessions.map((record) => buildLightPrebuiltSessionRecord(agentId, record)),
  };
}

async function readActiveWorkspaceSessionMeta(agent) {
  const workspaceSessions = await readWorkspaceSessionSnapshot(agent.id);
  const selectedSessionId = cleanSessionText(agent?.status?.selectedSessionId || workspaceSessions.activeSessionId);
  if (!selectedSessionId) {
    let noSessionDisplayName = '';
    if (sanitizeSessionFragment(agent.id) === 'qqbot') {
      try {
        const imConfig = await readProjectIMWorkspaceConfig();
        noSessionDisplayName = getPortalAgentDisplayName(imConfig.selectedChannel);
      } catch {}
    }
    return {
      workspaceSessions,
      sessionMeta: {
        active_workspace_session_id: null,
        active_workspace_session_form_id: null,
        active_workspace_session_title: '',
        active_workspace_agent_name: '',
        active_workspace_display_name: noSessionDisplayName,
      },
    };
  }

  const matched = Array.isArray(workspaceSessions.sessions)
    ? workspaceSessions.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
    : null;
  let title = cleanSessionText(matched?.title);
  let agentName = cleanSessionText(matched?.agentName);
  let formId = cleanSessionText(matched?.formId);

  if (!matched) {
    try {
      const index = await readSessionIndex(agent.id);
      const record = Array.isArray(index?.sessions)
        ? index.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
        : null;
      title = cleanSessionText(record?.title);
      agentName = cleanSessionText(record?.agentName);
      formId = cleanSessionText(record?.formId);
    } catch {}
  }

  let displayName = formId === 'assembly-form'
    ? (agentName || title)
    : '';
  if (!displayName && sanitizeSessionFragment(agent.id) === 'qqbot') {
    try {
      const imConfig = await readProjectIMWorkspaceConfig();
      displayName = getPortalAgentDisplayName(imConfig.selectedChannel);
    } catch {}
  }

  return {
    workspaceSessions: {
      ...workspaceSessions,
      activeSessionId: selectedSessionId,
    },
    sessionMeta: {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: formId || null,
      active_workspace_session_title: title,
      active_workspace_agent_name: agentName,
      active_workspace_display_name: displayName,
    },
  };
}

async function readWorkspaceSessionMeta(agentId, sessionId) {
  const selectedSessionId = cleanSessionText(sessionId);
  if (!selectedSessionId) {
    return {
      active_workspace_session_id: null,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }

  try {
    const index = await readSessionIndex(agentId);
    const record = Array.isArray(index?.sessions)
      ? index.sessions.find((session) => cleanSessionText(session?.id) === selectedSessionId) || null
      : null;
    const title = cleanSessionText(record?.title);
    const agentName = cleanSessionText(record?.agentName);
    const formId = cleanSessionText(record?.formId);
    let displayName = formId === 'assembly-form' ? (agentName || title) : '';
    if (!displayName && sanitizeSessionFragment(agentId) === 'qqbot') {
      try {
        const imConfig = await readProjectIMWorkspaceConfig();
        displayName = getPortalAgentDisplayName(imConfig.selectedChannel);
      } catch {}
    }
    return {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: formId || null,
      active_workspace_session_title: title,
      active_workspace_agent_name: agentName,
      active_workspace_display_name: displayName,
    };
  } catch {
    return {
      active_workspace_session_id: selectedSessionId,
      active_workspace_session_form_id: null,
      active_workspace_session_title: '',
      active_workspace_agent_name: '',
      active_workspace_display_name: '',
    };
  }
}

async function getConnectedAgents() {
  const prebuiltAgents = await getAgentsLight();
  const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [], currentAgentId: null }));
  const runtimeAgents = Array.isArray(viewerData.agents) ? viewerData.agents : [];
  const managedRuntimeByViewerId = new Map(
    Array.from(managedAgents.values())
      .filter((runtime) => runtime?.viewerAgentId && runtime.process && runtime.process.exitCode === null && !runtime.stopped)
      .map((runtime) => [String(runtime.viewerAgentId), runtime])
  );

  const connectedAgents = await Promise.all(prebuiltAgents.map(async (agent) => {
    const { workspaceSessions, sessionMeta } = await readActiveWorkspaceSessionMeta(agent);
    return {
      id: agent.id,
      name: agent.name,
      base_name: agent.name,
      description: agent.description,
      kind: agent.kind || 'agent',
      launchMode: agent.launchMode || null,
      ui: agent.ui || null,
      workspace: agent.workspace || null,
      workspace_sessions: workspaceSessions,
      workspace_data: {},
      workspace_state: { forms: {}, openDirectory: '', updatedAt: null },
      active_workspace_session_id: sessionMeta.active_workspace_session_id,
      active_workspace_session_form_id: sessionMeta.active_workspace_session_form_id,
      active_workspace_session_title: sessionMeta.active_workspace_session_title,
      active_workspace_agent_name: sessionMeta.active_workspace_agent_name,
      active_workspace_display_name: sessionMeta.active_workspace_display_name,
      status: 'stopped',
      source: 'prebuilt',
      parent_id: null,
      connection_info: null,
      pid: agent.status.pid,
      runtime_session_id: agent.status.viewerAgentId,
      message_count: 0,
      pending_input_count: null,
      created_at: null,
      modelPresets: agent.modelPresets || null,
      connected: false,
    };
  }));

  for (const runtimeAgent of runtimeAgents) {
    const managedRuntime = managedRuntimeByViewerId.get(String(runtimeAgent.id || '')) || null;
    if (managedRuntime) {
      const runtimeMeta = await readWorkspaceSessionMeta(managedRuntime.agentId, managedRuntime.selectedSessionId);
      connectedAgents.push({
        id: runtimeAgent.id,
        name: runtimeMeta.active_workspace_display_name
          || runtimeMeta.active_workspace_agent_name
          || runtimeMeta.active_workspace_session_title
          || runtimeAgent.name,
        description: runtimeAgent.description || '',
        status: runtimeAgent.connected ? 'running' : 'stopped',
        source: 'child',
        parent_id: managedRuntime.agentId,
        active_workspace_session_id: runtimeMeta.active_workspace_session_id,
        active_workspace_session_form_id: runtimeMeta.active_workspace_session_form_id,
        active_workspace_session_title: runtimeMeta.active_workspace_session_title,
        active_workspace_agent_name: runtimeMeta.active_workspace_agent_name,
        active_workspace_display_name: runtimeMeta.active_workspace_display_name,
        connection_info: runtimeAgent.connectionInfo || 'viewer://127.0.0.1:2026',
        pid: runtimeAgent.pid || managedRuntime.process?.pid || null,
        runtime_session_id: runtimeAgent.id,
        message_count: runtimeAgent.messageCount ?? 0,
        pending_input_count: await getPendingInputCount(runtimeAgent.id),
        created_at: runtimeAgent.createdAt ?? managedRuntime.startedAt ?? null,
        connected: runtimeAgent.connected ?? false,
      });
      continue;
    }

    const explicitParentHost = connectedAgents.find((agent) =>
      agent.source === 'prebuilt'
      && sanitizeSessionFragment(agent.id) === sanitizeSessionFragment(runtimeAgent.parentAgentId || ''));
    const isExplicitChildRuntime = !!runtimeAgent.parentAgentId && !!explicitParentHost;

    const workspaceHostParent = connectedAgents.find((agent) =>
      agent.source === 'prebuilt'
      && sanitizeSessionFragment(agent.id) === sanitizeSessionFragment(runtimeAgent.parentAgentId || '')
      && (agent.id === 'agent-creator' || agent.id === 'feature-creator'));
    const isWorkspaceHostRuntime =
      workspaceHostParent
      && (cleanSessionText(runtimeAgent.name) === cleanSessionText(workspaceHostParent.base_name)
        || cleanSessionText(runtimeAgent.name) === cleanSessionText(workspaceHostParent.name));
    if (isWorkspaceHostRuntime) {
      continue;
    }

    const matched = connectedAgents.find((agent) => agent.id === runtimeAgent.id)
      || connectedAgents.find((agent) => agent.source === 'prebuilt' && agent.runtime_session_id === runtimeAgent.id)
      || (!isExplicitChildRuntime
        ? connectedAgents.find((agent) => agent.source === 'prebuilt' && (agent.base_name === runtimeAgent.name || agent.name === runtimeAgent.name))
        : null);
    const exposeAsSeparateAssemblyRuntime = matched
      && matched.source === 'prebuilt'
      && (sanitizeSessionFragment(matched.id) === 'agent-creator' || sanitizeSessionFragment(matched.id) === 'flow-workspace')
      && cleanSessionText(matched.active_workspace_session_form_id) === 'assembly-form';

    if (matched && !exposeAsSeparateAssemblyRuntime) {
      matched.status = runtimeAgent.connected ? 'running' : matched.status;
      matched.connection_info = 'viewer://127.0.0.1:2026';
      matched.runtime_session_id = runtimeAgent.id;
      matched.message_count = runtimeAgent.messageCount ?? 0;
      matched.created_at = runtimeAgent.createdAt ?? null;
      matched.connected = runtimeAgent.connected ?? false;
      matched.pending_input_count = await getPendingInputCount(runtimeAgent.id);
      continue;
    }

    if (!runtimeAgent.connected) {
      continue;
    }

    connectedAgents.push({
      id: runtimeAgent.id,
      name: runtimeAgent.name,
      description: runtimeAgent.description || '',
      status: runtimeAgent.connected ? 'running' : 'stopped',
      source: exposeAsSeparateAssemblyRuntime ? 'external' : (runtimeAgent.parentAgentId ? 'child' : 'external'),
      parent_id: exposeAsSeparateAssemblyRuntime ? matched.id : (runtimeAgent.parentAgentId || null),
      active_workspace_session_id: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_id || null) : null,
      active_workspace_session_form_id: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_form_id || null) : null,
      active_workspace_session_title: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_session_title || null) : null,
      active_workspace_agent_name: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_agent_name || null) : null,
      active_workspace_display_name: exposeAsSeparateAssemblyRuntime ? (matched.active_workspace_display_name || null) : null,
      connection_info: runtimeAgent.connectionInfo || 'viewer://127.0.0.1:2026',
      pid: runtimeAgent.pid || null,
      runtime_session_id: runtimeAgent.id,
      message_count: runtimeAgent.messageCount ?? 0,
      pending_input_count: await getPendingInputCount(runtimeAgent.id),
      created_at: runtimeAgent.createdAt ?? null,
      connected: runtimeAgent.connected ?? false,
    });
  }

  for (const managed of connectedAgents) {
    const status = buildStatus(managed.id);
    if (status.status === 'running') {
      managed.status = 'running';
      managed.pid = status.pid;
      managed.active_workspace_session_id = status.selectedSessionId || managed.active_workspace_session_id;
      if (status.viewerAgentId) {
        managed.runtime_session_id = status.viewerAgentId;
      }
    } else if (managed.source === 'prebuilt') {
      managed.status = 'stopped';
      managed.pid = null;
      managed.runtime_session_id = null;
      managed.message_count = 0;
      managed.pending_input_count = null;
      managed.connected = false;
      managed.callActive = false;
    }
  }

  // 查询每个 connected agent 的 call 状态（从 ViewerWorker notification）
  await Promise.all(connectedAgents
    .filter((agent) => agent.connected && agent.runtime_session_id)
    .map(async (agent) => {
      try {
        const notif = await readViewerJson(`/api/agents/${encodeURIComponent(agent.runtime_session_id)}/notification`);
        agent.callActive = notif?.callActive === true;
      } catch {
        agent.callActive = false;
      }
    })
  );

  return connectedAgents;
}

async function waitForProcessExit(child, timeoutMs = 5000) {
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function waitForManagedRuntimeReady(agentId, timeoutMs = 10000, sessionId = undefined) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runtime = getAgentRuntime(agentId, sessionId);
    // Exploration agents run headlessly (no ViewerWorker) — just check ready flag
    if (runtime?.sessionType === 'exploration') {
      if (runtime.ready) return runtime;
    } else {
      const status = buildStatus(agentId, sessionId);
      if (status.viewerAgentId && runtime?.ready) {
        const agents = await getConnectedAgents();
        const viewerAgentId = cleanSessionText(status.viewerAgentId);
        const connected = agents.find((agent) => cleanSessionText(agent.id) === viewerAgentId || cleanSessionText(agent.runtime_session_id || agent.runtimeSessionId) === viewerAgentId);
        if (connected) {
          return connected;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

async function waitForAssemblyRuntimeReady(sessionId, timeoutMs = 10000) {
  const normalizedSessionId = sanitizeSessionFragment(sessionId);
  const start = Date.now();
  console.log(`[PERF] waitForAssemblyRuntimeReady BEGIN session=${normalizedSessionId} timeout=${timeoutMs}`);
  while (Date.now() - start < timeoutMs) {
    const runtime = getAssemblyRuntime(normalizedSessionId);
    if (runtime?.viewerAgentId && runtime?.ready) {
      const viewerData = await readViewerJson('/api/agents').catch(() => ({ agents: [] }));
      const agents = Array.isArray(viewerData?.agents) ? viewerData.agents : [];
      const connected = agents.find((agent) => agent.id === runtime.viewerAgentId);
      if (connected) {
        console.log(`[PERF] waitForAssemblyRuntimeReady FOUND (${Date.now() - start}ms)`);
        return connected;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`[PERF] waitForAssemblyRuntimeReady TIMEOUT (${Date.now() - start}ms)`);
  return null;
}

async function startManagedAgent(agent, selectedSessionId = undefined, runtimeOptions = {}) {
  const requestedSessionId = typeof selectedSessionId === 'string' && selectedSessionId
    ? sanitizeSessionFragment(selectedSessionId)
    : (selectedSessionId === null ? null : undefined);
  let preferredSessionId = null;
  if (requestedSessionId === undefined && sanitizeSessionFragment(agent?.id) === 'qqbot') {
    preferredSessionId = (await readProjectIMWorkspaceConfig().catch(() => ({ receptionistSessionId: '' })))?.receptionistSessionId || null;
  }
  const existing = getAgentRuntime(agent.id, requestedSessionId);
  const resolvedSessionId = requestedSessionId !== undefined
    ? requestedSessionId
    : (preferredSessionId || existing?.selectedSessionId || agent.workspace_sessions?.activeSessionId || null);

  if (sanitizeSessionFragment(agent?.id) === 'qqbot') {
    const siblings = listAgentRuntimes(agent.id).filter((rt) =>
      rt?.process && rt.process.exitCode === null && !rt.stopped
      && rt !== existing
    );
    for (const rt of siblings) {
      rt.stopped = true;
      rt.process.kill('SIGTERM');
    }
    await Promise.all(siblings.map((rt) => waitForProcessExit(rt.process)));
  }

  if (resolvedSessionId && !runtimeOptions?.extraEnv?.PROTOCLAW_HANDOFF_PATH) {
    try {
      const idx = await readSessionIndex(agent.id);
      const sessionRecord = idx.sessions.find(s => s.id === resolvedSessionId);
      if (sessionRecord?.metadata?.handoffPath) {
        // Only pass handoff env when the session has no persisted messages yet.
        // If the session file already exists and contains messages, the handoff
        // was already consumed on first boot and re-injecting would duplicate
        // seed messages with conflicting turn values.
        let shouldInjectHandoff = true;
        try {
          const sessionPath = getPrebuiltSessionFilePath(agent.id, resolvedSessionId);
          const raw = await fs.readFile(sessionPath, 'utf8');
          const snapshot = JSON.parse(raw);
          const messages = snapshot?.runtime?.context?.messages;
          if (Array.isArray(messages) && messages.length > 0) {
            shouldInjectHandoff = false;
          }
        } catch {
          // Session file doesn't exist or is unreadable — safe to inject
        }
        if (shouldInjectHandoff) {
          runtimeOptions = {
            ...runtimeOptions,
            extraEnv: {
              ...(runtimeOptions?.extraEnv || {}),
              PROTOCLAW_HANDOFF_PATH: sessionRecord.metadata.handoffPath,
            },
          };
        }
      }
    } catch {}
  }

  if (existing?.process && existing.process.exitCode === null && !existing.stopped) {
    if (!resolvedSessionId || existing.selectedSessionId === resolvedSessionId) {
      return buildStatus(agent.id, resolvedSessionId);
    }

    existing.stopped = true;
    existing.process.kill('SIGTERM');
    await waitForProcessExit(existing.process);
  }

  if (existing?.process && existing.process.exitCode === null && existing.stopped) {
    await waitForProcessExit(existing.process);
  }

  const runtimeDisplayName = await resolveRuntimeDisplayName(agent, resolvedSessionId);

  const isExplorationSession = runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE === 'exploration';
  const child = spawn(process.execPath, [RUNTIME_SCRIPT, agent.relativeDir, agent.id, runtimeDisplayName, resolvedSessionId || NO_SESSION_TOKEN], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: sanitizeSpawnEnv({
      ...process.env,
      ...(isExplorationSession ? {} : {
        AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
        AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
        AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || '\\\\.\\pipe\\agentdev-viewer',
      }),
      PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
      PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
      PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
      ...(runtimeOptions?.extraEnv && typeof runtimeOptions.extraEnv === 'object' ? runtimeOptions.extraEnv : {}),
    }),
    windowsHide: true,
  });

  const runtime = {
    key: getManagedRuntimeKey(agent.id, resolvedSessionId),
    agentId: agent.id,
    id: agent.id,
    process: child,
    startedAt: new Date().toISOString(),
    exitCode: null,
    stopped: false,
    viewerAgentId: null,
    selectedSessionId: resolvedSessionId || null,
    ready: false,
    sessionType: runtimeOptions?.extraEnv?.PROTOCLAW_SESSION_TYPE || null,
  };

  managedAgents.set(runtime.key, runtime);

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    const match = text.match(/Viewer Agent ID:\s*([^\s]+)/);
    if (match) {
      runtime.viewerAgentId = match[1];
    }
    if (text.includes('[ProtoClaw Runtime] READY session=')) {
      runtime.ready = true;
      // Emit on-ready event for event-driven dispatch schedules
      emitDispatchReadyEvent(agent.id, resolvedSessionId || null);
    }
    log(agent.id, text.trim());
  });

  child.stderr.on('data', (chunk) => {
    log(agent.id, String(chunk).trim(), 'error');
  });

  child.on('exit', (code) => {
    const current = managedAgents.get(runtime.key);
    if (current && current === runtime) {
      current.exitCode = code;
      current.stopped = true;
    }
    log(agent.id, `process exited with code ${code ?? 'null'}`);
  });

  child.on('error', (error) => {
    const current = managedAgents.get(runtime.key);
    if (current) {
      current.exitCode = 1;
      current.stopped = true;
    }
    log(agent.id, `failed to start: ${error.message}`, 'error');
  });

  return buildStatus(agent.id, resolvedSessionId);
}

/**
 * 启动一次性子代理（阻塞式）。
 *
 * 与 startManagedAgent 不同：
 * - 使用 run-one-shot-agent.js 而非 run-prebuilt-agent.js
 * - 不连接 ViewerWorker
 * - 只执行一次 onCall(goal) 后退出
 * - 返回 Promise，在进程退出时 resolve
 */
async function startOneShotAgent(agent, sessionId, goal, options = {}) {
  const resolvedSessionId = sanitizeSessionFragment(sessionId);
  const timeoutMs = options.timeoutMs || 300000;

  return new Promise((resolve, reject) => {
    let resultLine = null;
    const stdoutChunks = [];

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`One-shot agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const child = spawn(process.execPath, [
      ONE_SHOT_SCRIPT,
      agent.relativeDir,
      agent.id,
      resolvedSessionId,
      goal,
    ], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv({
        ...process.env,
        PROTOCLAW_SERVER_ORIGIN: APP_ORIGIN,
        PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
        PROTOCLAW_PREBUILT_SESSION_ID: resolvedSessionId || '',
        ...(options.extraEnv && typeof options.extraEnv === 'object' ? options.extraEnv : {}),
      }),
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdoutChunks.push(text);
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('ONE_SHOT_RESULT:')) {
          resultLine = line;
        }
      }
      log(agent.id, text.trim());
    });

    child.stderr.on('data', (chunk) => {
      log(agent.id, String(chunk).trim(), 'error');
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      log(agent.id, `one-shot process exited with code ${code ?? 'null'}`);

      if (resultLine) {
        try {
          const jsonStr = resultLine.slice('ONE_SHOT_RESULT:'.length);
          const result = JSON.parse(jsonStr);
          resolve({ exitCode: code, result, stdout: stdoutChunks.join('') });
        } catch (err) {
          reject(new Error(`Failed to parse one-shot result: ${err.message}`));
        }
      } else {
        reject(new Error(
          `One-shot agent exited (code ${code}) without producing a result. ` +
          `stdout: ${stdoutChunks.join('').slice(-500)}`,
        ));
      }
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`One-shot agent failed to start: ${error.message}`));
    });
  });
}

async function startAssemblyRuntime(sessionId, agentId = 'agent-creator', preActivatedSession = null, preloadedWorkspaceState = null) {
  const _t0 = Date.now();
  console.log(`[PERF] startAssemblyRuntime BEGIN session=${sessionId} agent=${agentId} hasSession=${!!preActivatedSession} hasState=${!!preloadedWorkspaceState}`);
  const agent = await requireAgentLight(agentId || 'agent-creator');
  let session = preActivatedSession || await activatePrebuiltSession(agent.id, sessionId);
  if (!preActivatedSession) {
    console.log(`[PERF] startAssemblyRuntime activatePrebuiltSession (${Date.now() - _t0}ms)`);
  } else {
    console.log(`[PERF] startAssemblyRuntime using pre-activated session (${Date.now() - _t0}ms)`);
  }
  const normalizedSessionId = sanitizeSessionFragment(session.id);
  const existing = getAssemblyRuntime(normalizedSessionId);

  if (existing?.process && existing.process.exitCode === null && !existing.stopped) {
    return existing;
  }

  const workspaceState = preloadedWorkspaceState || await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
  if (!preloadedWorkspaceState) {
    console.log(`[PERF] startAssemblyRuntime readWorkspaceState (${Date.now() - _t0}ms)`);
  }
  const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
  const runtimeDisplayName = cleanSessionText(session.agentName)
    || cleanSessionText(assemblyForm.assembly_name)
    || 'assembled-agent';
  const assemblyWorkspace = cleanSessionText(assemblyForm.env_dir) || getAssemblyWorkspaceDir(runtimeDisplayName);
  const selectedFeatures = parseListField(assemblyForm.selected_features);
  const customWorkdir = cleanSessionText(assemblyForm.workdir);
  const runtimeWorkdir = customWorkdir || assemblyWorkspace;

  if (cleanSessionText(session.openDirectory) !== assemblyWorkspace) {
    let updatedSession = session;
    await updateSessionIndex(agent.id, (index) => {
      const sessions = index.sessions.map((item) => item.id === session.id
        ? { ...item, openDirectory: assemblyWorkspace, updatedAt: new Date().toISOString() }
        : item);
      updatedSession = sessions.find((item) => item.id === session.id) || session;
      return { ...index, sessions };
    });
    session = await summarizePrebuiltSession(agent.id, updatedSession);
  }

  await ensureAssemblyWorkspaceBase(assemblyWorkspace, runtimeDisplayName);
  console.log(`[PERF] startAssemblyRuntime ensureBase (${Date.now() - _t0}ms)`);
  const installResult = await ensureAssemblyWorkspaceDependencies(assemblyWorkspace, selectedFeatures);
  console.log(`[PERF] startAssemblyRuntime ensureDeps (${Date.now() - _t0}ms) skipped=${installResult.skipped}`);
  if (installResult.installedPackages.length > 0) {
    log(`assembly:${normalizedSessionId}`, `refreshed feature dependencies: ${installResult.installedPackages.join(', ')}`);
  }
  await writeWorkspaceState(agent.id, {
    forms: {
      ...(workspaceState?.forms || {}),
      'assembly-form': {
        ...assemblyForm,
        assembly_name: runtimeDisplayName,
        env_created: '1',
        env_dir: assemblyWorkspace,
        env_configured_name: runtimeDisplayName,
        env_configured_features: selectedFeatures.join('\n'),
        env_status: 'ready',
        env_status_message: selectedFeatures.length > 0
          ? `Runtime dependencies refreshed for ${selectedFeatures.length} feature(s).`
          : 'Runtime dependencies refreshed.',
      },
    },
    openDirectory: assemblyWorkspace,
  });
  console.log(`[PERF] startAssemblyRuntime writeWorkspaceState (${Date.now() - _t0}ms)`);
  const spawnArgs = [
    String(RUNTIME_SCRIPT),
    String(agent.relativeDir || ''),
    String(agent.id || ''),
    String(runtimeDisplayName || ''),
    String(normalizedSessionId || ''),
  ];
  const child = spawn(process.execPath, spawnArgs, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeSpawnEnv({
      ...process.env,
      AGENTDEV_DEBUG_TRANSPORT: 'viewer-worker',
      AGENTDEV_VIEWER_PORT: String(VIEWER_PORT),
      AGENTDEV_UDS_PATH: process.env.AGENTDEV_UDS_PATH || '\\\\.\\pipe\\agentdev-viewer',
      PROTOCLAW_PREBUILT_AGENT_ID: String(agent.id || ''),
      PROTOCLAW_PREBUILT_SESSION_ID: normalizedSessionId,
      PROTOCLAW_ASSEMBLY_RUNTIME: '1',
      PROTOCLAW_ASSEMBLY_WORKSPACE: runtimeWorkdir,
    }),
    windowsHide: true,
  });

  const runtime = {
    sessionId: normalizedSessionId,
    requestedName: runtimeDisplayName,
    workspaceDir: runtimeWorkdir,
    installedPackages: selectedFeatures,
    process: child,
    startedAt: new Date().toISOString(),
    exitCode: null,
    viewerAgentId: null,
    ready: false,
    stopped: false,
  };

  assemblyRuntimeProcesses.set(normalizedSessionId, runtime);
  console.log(`[PERF] startAssemblyRuntime process SPAWNED (${Date.now() - _t0}ms) pid=${child.pid}`);

  child.stdout?.on('data', (chunk) => {
    const text = chunk.toString();
    log(`assembly:${normalizedSessionId}`, text.trimEnd());
    const viewerMatch = text.match(/Viewer Agent ID:\s*(\S+)/);
    if (viewerMatch) {
      runtime.viewerAgentId = viewerMatch[1];
      console.log(`[PERF] startAssemblyRuntime viewerAgentId=${viewerMatch[1]} (${Date.now() - _t0}ms)`);
    }
    if (text.includes('READY session=')) {
      runtime.ready = true;
      console.log(`[PERF] startAssemblyRuntime READY (${Date.now() - _t0}ms)`);
    }
  });

  child.stderr?.on('data', (chunk) => {
    log(`assembly:${normalizedSessionId}`, chunk.toString().trimEnd(), 'error');
  });

  child.on('exit', (code) => {
    runtime.exitCode = code ?? 0;
    runtime.stopped = true;
    assemblyRuntimeProcesses.delete(normalizedSessionId);
  });

  return runtime;
}

async function stopManagedAgent(agentId, sessionId = undefined) {
  const runtimes = sessionId === undefined ? listAgentRuntimes(agentId) : [getAgentRuntime(agentId, sessionId)].filter(Boolean);
  if (runtimes.length === 0) {
    return buildStatus(agentId, sessionId);
  }

  for (const runtime of runtimes) {
    if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
      continue;
    }
    runtime.stopped = true;
    runtime.process.kill('SIGTERM');
  }
  return buildStatus(agentId, sessionId);
}

async function proxyToViewer(req, res) {
  const targetUrl = `${VIEWER_ORIGIN}${req.originalUrl}`;
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (key.toLowerCase() === 'host') continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const method = req.method.toUpperCase();
  const init = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    init.body = Buffer.concat(chunks);
  }

  const response = await fetch(targetUrl, init);
  res.status(response.status);

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });

  const arrayBuffer = await response.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
}

app.all('/protoclaw/claw-mcp', async (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    await clawMcp.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});
app.all('/protoclaw/claw-mcp/', async (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, last-event-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    await clawMcp.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});

// ── Dispatch API ─────────────────────────────────────────────────
app.get('/protoclaw/dispatch/projects', async (_req, res) => {
  const agentId = String(_req.query.agentId || '').trim();
  if (!agentId) return res.status(400).json({ error: 'agentId required' });

  const adapter = getProjectAdapter(agentId);
  if (!adapter) {
    return res.json({ projects: [] });
  }

  try {
    // Aggregate projects from workspace state + sessions
    const currentState = await readWorkspaceState(agentId);
    const sessionsResult = await listPrebuiltSessions(agentId);
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

// ── End Dispatch API ─────────────────────────────────────────────

// ── Identity Registry API ─────────────────────────────────────────

/**
 * 收集所有已启用 prebuilt agent 声明的 identities。
 * 无 identities 声明的 workspace 自动生成默认身份（向后兼容）。
 */
async function collectIdentities() {
  const agents = await discoverAgents(AGENTS_ROOT);
  const identities = [];

  for (const agent of agents) {
    if (agent.enabled === false) continue;
    if (agent.launchMode === 'ui-only') continue;

    const declared = Array.isArray(agent.identities) ? agent.identities : null;
    if (!declared || declared.length === 0) continue;

    for (const id of declared) {
      // 只暴露显式标记为 groupChat 的身份
      if (!id.groupChat) continue;

      identities.push({
        workspaceId: agent.id,
        workspaceName: agent.name,
        identityId: id.id,
        identityRef: `${agent.id}:${id.id}`,
        displayName: id.displayName || id.id,
        description: id.description || '',
        sessionModel: id.sessionModel || 'persistent',
        qualifierLabel: id.qualifierLabel || null,
        operations: Array.isArray(id.operations) ? id.operations : [],
        callTimeoutMs: typeof id.callTimeoutMs === 'number' ? id.callTimeoutMs : 900000,
      });
    }
  }

  return identities;
}

app.get('/protoclaw/identities', async (_req, res, next) => {
  try {
    const identities = await collectIdentities();
    res.json({ identities });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/identities/:workspaceId/:identityId/sessions', async (req, res, next) => {
  try {
    const { workspaceId, identityId } = req.params;

    // 验证 identity 存在
    const identities = await collectIdentities();
    const identity = identities.find(
      (i) => i.workspaceId === workspaceId && i.identityId === identityId
    );
    if (!identity) {
      return res.status(404).json({ error: `Identity not found: ${workspaceId}:${identityId}` });
    }

    const sessions = [];

    if (identity.sessionModel === 'persistent' && identity.qualifierLabel) {
      // 有 qualifierLabel 的 persistent 身份：从 session index 提取 qualifier 列表
      try {
        const index = await readSessionIndex(workspaceId);
        const seen = new Set();

        for (const record of index.sessions) {
          if (record.archived) continue;
          // qualifier 优先用 openDirectory，其次 title
          const qualifier = record.openDirectory || record.title || record.id;
          if (!qualifier || seen.has(qualifier)) continue;
          seen.add(qualifier);

          sessions.push({
            qualifier,
            label: record.title || qualifier,
            status: buildStatus(workspaceId).status === 'running' ? 'running' : 'idle',
            lastActiveTime: record.updatedAt || record.createdAt || null,
            summary: record.goal || null,
          });
        }
      } catch {
        // session index 不存在或读取失败 → 空列表
      }
    }

    const allowCreate = identity.operations.includes('create');

    res.json({
      sessions,
      allowCreate,
      qualifierLabel: identity.qualifierLabel,
    });
  } catch (error) {
    next(error);
  }
});

// ── End Identity Registry API ─────────────────────────────────────

// ── Group Chat Data Layer ──────────────────────────────────────────

/**
 * 群聊文件存储。每个群聊一个 JSON 文件，消息 append-only（routing 字段除外可更新）。
 * 文件路径：~/.agentdev/AgentDevClaw/group-chats/<chatId>.json
 */

async function ensureGroupChatsDir() {
  await fs.mkdir(GROUP_CHATS_ROOT, { recursive: true });
}

function getGroupChatPath(chatId) {
  return path.join(GROUP_CHATS_ROOT, `${sanitizeSessionFragment(chatId)}.json`);
}

async function listGroupChats() {
  await ensureGroupChatsDir();
  const entries = await fs.readdir(GROUP_CHATS_ROOT);
  const chats = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.annotations.json')) continue;
    try {
      const raw = await fs.readFile(path.join(GROUP_CHATS_ROOT, entry), 'utf8');
      const chat = JSON.parse(raw);
      // 列表只返回摘要，不包含消息
      chats.push({
        id: chat.id,
        name: chat.name,
        workDir: chat.workDir || null,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        memberCount: Array.isArray(chat.members) ? chat.members.length : 0,
        messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
        lastMessage: Array.isArray(chat.messages) && chat.messages.length > 0
          ? {
              text: (chat.messages[chat.messages.length - 1].text || '').slice(0, 100),
              from: chat.messages[chat.messages.length - 1].from,
              timestamp: chat.messages[chat.messages.length - 1].timestamp,
            }
          : null,
      });
    } catch {}
  }
  chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return chats;
}

async function readGroupChat(chatId) {
  const filePath = getGroupChatPath(chatId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeGroupChat(chat) {
  await ensureGroupChatsDir();
  const filePath = getGroupChatPath(chat.id);
  chat.updatedAt = Date.now();
  await fs.writeFile(filePath, JSON.stringify(chat, null, 2), 'utf8');
  return chat;
}

async function deleteGroupChatFile(chatId) {
  const filePath = getGroupChatPath(chatId);
  let deleted = false;
  try {
    await fs.unlink(filePath);
    deleted = true;
  } catch {}
  // 清理 annotations 文件
  try {
    await fs.unlink(_annotationsFilePath(chatId));
  } catch {}
  // 清理数据目录（GROUP.md 等）
  try {
    await fs.rm(getGroupChatDataDir(chatId), { recursive: true, force: true });
  } catch {}
  return deleted;
}

// ── Group Chat Resources (文件附件) ────────────────────────────────

const RESOURCE_ALLOWED_EXTS = new Set(['.md', '.txt', '.json']);

/**
 * 获取群聊资源目录路径。需要 chat.workDir 已设置。
 */
function getResourcesDir(chat) {
  if (!chat.workDir) return null;
  return path.join(chat.workDir, '.agentdev', 'resources');
}

/**
 * 校验并规范化资源文件名。
 * 返回 { ok, name, error }。
 */
function validateResourceName(rawName) {
  if (!rawName || typeof rawName !== 'string') return { ok: false, error: 'name required' };
  const name = rawName.trim();
  if (!name) return { ok: false, error: 'name required' };
  if (name.length > 100) return { ok: false, error: 'name too long (max 100)' };
  if (/[\/\\]/.test(name) || name.includes('..')) return { ok: false, error: 'invalid name' };
  // 如果没有合法扩展名，默认加 .md
  const ext = path.extname(name).toLowerCase();
  if (!RESOURCE_ALLOWED_EXTS.has(ext)) {
    return { ok: true, name: name + '.md' };
  }
  return { ok: true, name };
}

/**
 * 向群聊追加一条消息（append-only）。
 * 返回更新后的群聊对象。
 */
async function appendGroupChatMessage(chatId, message) {
  const chat = await readGroupChat(chatId);
  if (!chat) return null;
  if (!Array.isArray(chat.messages)) chat.messages = [];
  chat.messages.push(message);
  await writeGroupChat(chat);
  return chat;
}

/**
 * 更新群聊中某条消息的 routing 状态。
 */
async function updateMessageRouting(chatId, messageId, routingUpdate) {
  const chat = await readGroupChat(chatId);
  if (!chat || !Array.isArray(chat.messages)) return null;
  const msg = chat.messages.find((m) => m.id === messageId);
  if (!msg) return null;
  msg.routing = { ...(msg.routing || {}), ...routingUpdate };
  await writeGroupChat(chat);
  return msg;
}

/**
 * 将时间范围字符串转为毫秒。
 */
function parseMemoryRange(range) {
  switch (range) {
    case '1d': return 86400000;
    case '3d': return 86400000 * 3;
    case '1w': return 86400000 * 7;
    case 'all': return Infinity;
    default: return 86400000 * 3;
  }
}

/**
 * 从框架 session index 中读取上下文使用量（token 数）。
 * 框架已经在 tokenUsage.lastRequestUsage 中记录了最近一次请求的 token 消耗。
 */
async function getSessionContextUsage(workspaceId, sessionId) {
  try {
    const index = await readSessionIndex(workspaceId);
    const record = (index.sessions || []).find((s) => s.id === sessionId);
    if (!record?.tokenUsage) return { contextTokens: 0, available: false };
    const lastReq = record.tokenUsage.lastRequestUsage || null;
    const contextTokens = lastReq?.totalTokens || lastReq?.inputTokens || 0;
    return { contextTokens, available: contextTokens > 0 };
  } catch {
    return { contextTokens: 0, available: false };
  }
}

/**
 * 组装群聊记忆：按 memoryRange 提取消息摘要，作为 agent 上下文的「视图」。
 * 这是长线记忆的基础——从一个不可能全塞进上下文的完整记录中提取 agent 需要的部分。
 */
async function composeGroupMemory(chat, range, options = {}) {
  const now = Date.now();
  const rangeMs = parseMemoryRange(range);
  const allIdentities = await collectIdentities();

  // 按时间范围过滤
  const since = rangeMs === Infinity ? 0 : now - rangeMs;
  const recentMessages = (chat.messages || []).filter(
    (m) => (m.timestamp || 0) >= since && m.kind !== 'event'
  );

  // 合并批注（仅管理员注入路径）
  let annotations = {};
  if (options.includeAnnotations) {
    annotations = await readAnnotations(chat.id);
  }

  // 组装摘要行
  const lines = recentMessages.map((m) => {
    const identityInfo = allIdentities.find((i) => i.identityRef === m.from);
    const from = m.from === 'user' ? '用户' : (identityInfo?.displayName || m.from);
    const time = new Date(m.timestamp).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const text = (m.text || '').slice(0, 200);

    let suffix = '';
    if (annotations[m.id]) {
      const annTime = new Date(annotations[m.id].timestamp).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      suffix = `  [批注 ${annTime}] ${annotations[m.id].text}`;
    }

    return `[${time}] ${from}：${text}${suffix}`;
  });

  return {
    name: chat.name,
    chatId: chat.id,
    summary: lines.join('\n'),
    messageCount: recentMessages.length,
  };
}

/**
 * 将群记忆格式化为可注入 session 的 prompt 文本。
 */
function formatGroupInfoBlock(chat) {
  const lines = [
    '─── 群聊基本信息 ───',
    `群聊名称：${chat.name || '(未命名)'}`,
    `群聊ID：${chat.id}`,
  ];
  if (chat.createdAt) {
    const created = new Date(chat.createdAt).toLocaleString('zh-CN');
    lines.push(`创建时间：${created}`);
  }
  lines.push(`当前时间：${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

function formatMemoryRange(range) {
  const map = { '1d': '近1天', '3d': '近3天', '1w': '近1周', all: '全部历史' };
  return map[range] || '近3天';
}

function formatGroupMemoryPrompt(memory, range) {
  const parts = [];
  if (memory.summary) {
    const rangeLabel = formatMemoryRange(range);
    parts.push(
      `─── 群聊记录（${rangeLabel}，共${memory.messageCount}条）───`,
      memory.summary,
    );
  }
  return parts.join('\n');
}

/**
 * 格式化 catch-up 增量消息：身份被唤醒时，补上它离开后错过的群聊变化。
 * 这是通用的上下文完整性保证——任何身份被派发时都适用。
 *
 * @param {Array} messages - 增量消息数组（已排除当前消息）
 * @param {Array} allIdentities - collectIdentities() 结果
 * @param {string} chatId - 群聊 ID
 * @param {string} chatName - 群聊名称
 * @returns {string|null} 格式化后的 catch-up 文本，无内容时返回 null
 */
function formatCatchUpPrompt(messages, allIdentities, chatId, chatName) {
  if (!messages || messages.length === 0) return null;

  const lines = messages.map((m) => {
    const time = new Date(m.timestamp).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });

    // 事件消息（task_started 等）：让管理员知道哪些派发已经发生
    if (m.kind === 'event' && m.event) {
      const evtName = m.event.identityName || m.event.identityRef || '';
      if (m.event.type === 'task_started') {
        return `[${time}] [系统事件] ${evtName} 已开始处理`;
      }
      return `[${time}] [系统事件] ${evtName}：${m.event.type}`;
    }

    const identityInfo = allIdentities.find((i) => i.identityRef === m.from);
    const from = m.from === 'user' ? '用户' : (identityInfo?.displayName || m.from);
    const text = (m.text || '').slice(0, 300);

    // 批注：附加到消息行尾部，供管理员参考
    let suffix = '';
    if (m._annotation) {
      const annTime = new Date(m._annotation.timestamp).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      suffix = `  [批注 ${annTime}] ${m._annotation.text}`;
    }

    return `[${time}] ${from}：${text}${suffix}`;
  });

  return [
    `─── 你未读的群聊消息（共${messages.length}条）───`,
    ...lines,
  ].join('\n');
}

/**
 * Per-chat 互斥锁：串行化管理员 session 解析。
 * 防止并发调用（@admin + plan 模式通知 + activity 通知）同时创建多个 admin session。
 * key = `${chatId}:admin`, value = Promise chain
 */
const _gcAdminLocks = new Map();

function withAdminSessionLock(chatId, fn) {
  const key = `${chatId}:admin`;
  const prev = _gcAdminLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  _gcAdminLocks.set(key, next.catch(() => {}));
  return next;
}

/**
 * 在覆盖 chat.sessions[identityRef] 之前，将旧 session ID 记录到 adminSessionHistory。
 * 仅对管理员生效，用于追踪滚动/重启产生的历史 session。
 */
function _recordAdminSessionHistory(chat, identityRef) {
  if (identityRef !== 'work-group:admin') return;
  const oldSid = chat.sessions?.[identityRef];
  if (!oldSid) return;
  if (!Array.isArray(chat.adminSessionHistory)) chat.adminSessionHistory = [];
  if (!chat.adminSessionHistory.includes(oldSid)) {
    chat.adminSessionHistory.push(oldSid);
  }
}

/**
 * 为群聊中的某个 identity 解析或创建 session。
 * - persistent: 首次创建，后续复用
 * - one-shot: 总是创建新的
 * 返回 { sessionId, isNew }
 *
 * 管理员（work-group:admin）的解析会自动加互斥锁，
 * 保证同一群聊同一时刻只有一个 admin session 被创建/解析。
 */
async function resolveGroupChatSession(chatId, identityRef, sessionModel, options = {}) {
  // 管理员：通过互斥锁串行化，防止并发创建多个 session
  if (identityRef === 'work-group:admin') {
    return withAdminSessionLock(chatId, () => _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options));
  }
  return _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options);
}

async function _resolveGroupChatSessionInner(chatId, identityRef, sessionModel, options = {}) {
  const chat = await readGroupChat(chatId);
  if (!chat) throw new Error(`Group chat not found: ${chatId}`);

  const workspaceId = identityRef.split(':')[0];

  // 查找身份显示名用于 session 标题
  const allIdentities = await collectIdentities();
  const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
  const displayName = identityInfo?.displayName || identityRef.split(':')[1] || 'Agent';
  const sessionTitle = `${chat.name || '群聊'} · ${displayName}`;

  // one-shot: 总是创建新 session
  if (sessionModel === 'one-shot') {
    const agent = await requireAgentLight(workspaceId);
    const session = await createPrebuiltSession(agent.id, {
      sessionType: 'exploration',
      taskTitle: sessionTitle,
    });
    return { sessionId: session.id, isNew: true };
  }

  // 指定会话：管理员或用户通过 targetSessionId 精准路由
  if (options.targetSessionId) {
    const index = await readSessionIndex(workspaceId);
    const found = index.sessions.find((s) => s.id === options.targetSessionId);
    if (found) {
      // 更新群聊会话映射，使后续默认派发也走这个会话
      _recordAdminSessionHistory(chat, identityRef);
      chat.sessions[identityRef] = found.id;
      await writeGroupChat(chat);
      return { sessionId: found.id, isNew: false };
    }
    log('GroupChat', `targetSessionId ${options.targetSessionId} not found for ${workspaceId}, falling back`);
  }

  // 强制新会话
  if (options.forceNew) {
    const agent = await requireAgentLight(workspaceId);
    const session = await createPrebuiltSession(agent.id, {
      taskTitle: sessionTitle,
    });
    _recordAdminSessionHistory(chat, identityRef);
    chat.sessions[identityRef] = session.id;
    await writeGroupChat(chat);
    return { sessionId: session.id, isNew: true };
  }

  // persistent: 检查映射
  if (!chat.sessions) chat.sessions = {};
  const existing = chat.sessions[identityRef];
  if (existing) {
    // 验证 session 是否仍存在于 index 中
    const index = await readSessionIndex(workspaceId);
    const found = index.sessions.find((s) => s.id === existing);
    if (found) {
      // 管理员：检查上下文是否超限，超限则滚动到新 session
      if (identityRef === 'work-group:admin') {
        const mem = chat.adminMemory || { limitMode: 'tokens', limitValue: 100000 };
        const { contextTokens, available } = await getSessionContextUsage(workspaceId, existing);
        if (available) {
          let exceeded = false;
          if (mem.limitMode === 'ratio') {
            // 按比例：contextTokens / contextLength > limitValue%
            const modelInfo = await resolveSessionModelInfo(workspaceId, 'default');
            const contextLength = modelInfo?.contextLength || 200000;
            exceeded = contextTokens / contextLength > mem.limitValue / 100;
          } else {
            // 按 token 数
            exceeded = contextTokens >= mem.limitValue;
          }
          if (!exceeded) {
            return { sessionId: existing, isNew: false };
          }
          // 超限 → 先停止旧 runtime，再 fall through 创建新 session
          log('GroupChat', `admin session ${existing} context exceeded (${contextTokens} tokens), rolling to new session`);
          try {
            await stopManagedAgent(workspaceId, existing);
            log('GroupChat', `stopped old admin runtime ${existing} before rolling`);
          } catch (err) {
            log('GroupChat', `failed to stop old admin runtime ${existing}: ${err.message}`, 'warn');
          }
        } else {
          // 无用量数据（首次/刚创建），直接复用
          return { sessionId: existing, isNew: false };
        }
      } else {
        return { sessionId: existing, isNew: false };
      }
    }
    // session 不存在了（可能被删除），重建
  }

  // 创建新 session 并存储映射
  const agent = await requireAgentLight(workspaceId);
  const session = await createPrebuiltSession(agent.id, {
    taskTitle: sessionTitle,
  });
  _recordAdminSessionHistory(chat, identityRef);
  chat.sessions[identityRef] = session.id;
  await writeGroupChat(chat);
  return { sessionId: session.id, isNew: true };
}

/**
 * 构建发送给 agent 的 prompt：群聊上下文头 + 消息正文 + 链接引用。
 */
function composeDispatchPrompt(chatName, message, chatId) {
  // 群聊上下文已通过 contextText (system block) 独立注入，
  // 这里只返回消息正文 + 附件 + 链接
  const parts = [];
  parts.push(message.text || '');
  // 附件内联
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    parts.push('\n附件：');
    for (const att of message.attachments) {
      parts.push(`--- ${att.name} ---`);
      parts.push(att.content || '');
    }
  }
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
 * 为被派发的 agent 构建群聊 system 上下文块。
 * 让 agent 知道自己处于群聊中、发送者是谁、回复会被同步回群聊。
 */
function buildGroupDispatchSystemMessage(chat, message, allIdentities) {
  const chatName = chat?.name || '(未命名群聊)';

  // 解析发送者身份
  let senderRole;
  let senderName;
  if (message.from === 'user') {
    senderRole = '用户';
    senderName = '用户';
  } else if (message.from === 'work-group:admin') {
    senderRole = '群管理员';
    senderName = '管理员';
  } else {
    const identityInfo = allIdentities.find((i) => i.identityRef === message.from);
    senderRole = identityInfo?.displayName || message.from;
    senderName = senderRole;
  }

  const lines = [
    `本会话同时被 AgentDevClaw 中群聊「${chatName}」关联管理。下方紧跟的一条用户消息由群聊中的${senderName}（${senderRole}）发送`,
    '',
  ];

  lines.push(
    `当前时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '你的本轮的最后一次回复将自动同步到群聊中，群管理员和用户都能看到。',
  );

  return lines.join('\n');
}

// ── Group Chat Bridge: inbox + writeback ───────────────────────────

const gcInboxQueue = new Map();       // runtimeKey → message[]
const gcInboxPendingPolls = new Map(); // runtimeKey → callback

/**
 * 向 gc inbox 投递一条消息，唤醒等待的 long-poll。
 */
function enqueueGcInbox(runtimeKey, msg) {
  // If a long-poll is waiting, deliver directly via callback WITHOUT
  // also pushing to the queue.  Pushing to the queue AND delivering via
  // callback causes the same message to be returned again on the next
  // poll (double-delivery bug).
  const cb = gcInboxPendingPolls.get(runtimeKey);
  if (cb) {
    gcInboxPendingPolls.delete(runtimeKey);
    cb(msg);
    return;
  }
  if (!gcInboxQueue.has(runtimeKey)) gcInboxQueue.set(runtimeKey, []);
  gcInboxQueue.get(runtimeKey).push(msg);
}

app.get('/protoclaw/gc/inbox', async (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const timeoutMs = Math.min(Number(req.query.timeout) || 25, 30) * 1000;
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);

  const queue = gcInboxQueue.get(runtimeKey);
  if (queue && queue.length > 0) {
    return res.json(queue.shift());
  }

  const timer = setTimeout(() => {
    gcInboxPendingPolls.delete(runtimeKey);
    res.status(204).end();
  }, timeoutMs);

  gcInboxPendingPolls.set(runtimeKey, (msg) => {
    clearTimeout(timer);
    gcInboxPendingPolls.delete(runtimeKey);
    res.json(msg);
  });
});

app.post('/protoclaw/gc/writeback', express.json(), async (req, res, next) => {
  try {
    const { chatId, identityRef, response, error } = req.body || {};
    if (!chatId || !identityRef) {
      return res.status(400).json({ error: 'chatId and identityRef required' });
    }

    const text = error
      ? `执行出错: ${error}`
      : (response || '(无回复)');

    // 回写消息携带 session 信息，供前端显示会话标签和跳转
    const workspaceId = identityRef.split(':')[0];
    const wbSessionId = process.env.PROTOCLAW_PREBUILT_SESSION_ID || null;
    let wbSessionTitle = wbSessionId;
    if (wbSessionId) {
      try {
        const idx = await readSessionIndex(workspaceId);
        const rec = idx.sessions.find((s) => s.id === wbSessionId);
        if (rec) wbSessionTitle = rec.title || rec.taskTitle || wbSessionId;
      } catch {}
    }

    await appendGroupChatMessage(chatId, {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      from: identityRef,
      text,
      mentions: [],
      links: [],
      kind: error ? 'text' : 'text',
      timestamp: Date.now(),
      routing: wbSessionId ? {
        status: 'completed',
        targetSessionId: wbSessionId,
        targetSessionTitle: wbSessionTitle,
        targetWorkspaceId: workspaceId,
        targetIdentityRef: identityRef,
        completedAt: Date.now(),
      } : null,
    });
    log('GroupChat', `writeback from ${identityRef} to chat ${chatId}`);

    // 规划模式下，通知管理员 agent 完成了回复
    const wbChat = await readGroupChat(chatId);
    if (wbChat && (wbChat.initiativeMode || 'assist') === 'plan' && identityRef !== 'work-group:admin') {
      const wbMessage = { id: `wb-${Date.now()}`, from: identityRef, text, kind: 'text', timestamp: Date.now() };
      notifyAdminForActivity(chatId, wbMessage, wbChat).catch((err) => {
        log('GroupChat', `admin activity notify (writeback) failed: ${err.message}`, 'warn');
      });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

/**
 * Level 1 mention 派发：将群聊消息发送到目标 agent 的 session。
 *
 * 流程：
 * 1. 解析 mention → workspaceId
 * 2. 找到或启动 agent runtime
 * 3. 等待 runtime ready
 * 4. 通过 gc inbox 投递消息（GroupChatBridgeFeature 轮询消费）
 * 5. 更新 routing.status = "delivered"
 * 6. 后台跟踪 agent 完成状态 → "completed" / "failed"
 */
/**
 * 管理员上下文完整性保证（基础语义）。
 *
 * 这是管理员被唤醒时的唯一上下文准备通道。所有向管理员投递消息的路径
 * —— dispatchToIdentity（直接派发 / execute 模式）、
 *    notifyAdminForActivity（plan 模式动态通知）、
 *    notifyAdminForObservation（plan 模式观察通知）——
 * 都必须经过此函数。
 *
 * 保证三条不变量：
 * 1. catch-up：管理员离开后错过的群聊消息全部补全
 * 2. 群记忆：新 session 时注入历史摘要
 * 3. 水位线：lastActiveAt 在每次调用后正确推进
 *
 * 函数内部读取最新群聊状态（避免调用方传入 stale 对象），计算后写回。
 *
 * @param {string} chatId - 群聊 ID
 * @param {Array}  allIdentities - collectIdentities() 结果（避免重复调用）
 * @param {number} currentMessageTimestamp - 触发本次唤醒的消息时间戳（catch-up 上界）
 * @param {string} currentMessageId - 触发本次唤醒的消息 ID（排除自身）
 * @param {boolean} isNew - 管理员 session 是否为本次新建
 * @returns {string|null} 合并后的上下文前缀文本（群记忆 + catch-up），无内容时返回 null
 */
async function prepareAdminContext(chatId, allIdentities, currentMessageTimestamp, currentMessageId, isNew) {
  const identityRef = 'work-group:admin';
  const chat = await readGroupChat(chatId);
  if (!chat) return null;

  const sections = [];

  // ── 新 session：群聊基本信息 + GROUP.md + 群记忆 ──
  // 这些是静态/半静态背景，只在 session 首次注入，避免每轮重复污染
  if (isNew) {
    // 群聊基本信息
    sections.push(formatGroupInfoBlock(chat));

    // GROUP.md
    try {
      const mdPath = path.join(GROUP_CHATS_ROOT, chatId, 'GROUP.md');
      const mdContent = await fs.readFile(mdPath, 'utf-8');
      if (mdContent && mdContent.trim()) {
        sections.push(`─── 群聊背景 ───\n${mdContent}`);
        log('GroupChat', `GROUP.md injected (${mdContent.length} chars) for new admin session`);
      }
    } catch {
      // GROUP.md 不存在或不可读，跳过
    }

    // 群记忆（近期消息摘要，标注时间范围）
    const mem = chat.adminMemory || { range: '3d' };
    const range = mem.range || '3d';
    const groupMemory = await composeGroupMemory(chat, range, { includeAnnotations: true });
    groupMemory.chatId = chatId;
    const memoryPrompt = formatGroupMemoryPrompt(groupMemory, range);
    if (memoryPrompt) {
      sections.push(memoryPrompt);
      log('GroupChat', `group memory pre-injected for new admin session (${groupMemory.messageCount} messages, range=${range})`);
    }
  }

  // ── catch-up：补上管理员离开后错过的全部群聊消息（含事件消息）──
  // 首轮（新 session 且无历史水位线）跳过 catch-up，群记忆已覆盖历史
  if (!chat.lastActiveAt) chat.lastActiveAt = {};
  const lastActive = chat.lastActiveAt[identityRef] || 0;
  if (!(isNew && lastActive === 0)) {
    const catchUpMessages = (chat.messages || []).filter(
      (m) => (m.timestamp || 0) > lastActive
        && (m.timestamp || 0) < (currentMessageTimestamp || Date.now())
        && m.id !== currentMessageId
    );
    if (catchUpMessages.length > 0) {
      // 合并批注到 catch-up 消息（仅管理员注入）
      const annotations = await readAnnotations(chatId);
      if (Object.keys(annotations).length > 0) {
        catchUpMessages.forEach((m) => {
          if (annotations[m.id]) m._annotation = annotations[m.id];
        });
      }
      const catchUpPrompt = formatCatchUpPrompt(catchUpMessages, allIdentities, chatId, chat.name);
      if (catchUpPrompt) {
        sections.push(catchUpPrompt);
        log('GroupChat', `catch-up merged into admin context: ${catchUpMessages.length} messages`);
      }
    }
  }

  // ── 推进水位线 ──
  chat.lastActiveAt[identityRef] = currentMessageTimestamp || Date.now();
  await writeGroupChat(chat);

  return sections.length > 0 ? sections.join('\n\n') : null;
}

/**
 * 确保 work-group admin runtime 已启动。
 * 统一管理员 runtime 的启动入口，供所有 admin 通知路径调用。
 * 返回 runtime 对象（已 ready），失败时抛异常。
 */
async function ensureAdminRuntime(chatId, sessionId) {
  let runtime = getAgentRuntime('work-group', sessionId);
  if (runtime?.process && runtime.process.exitCode === null && !runtime.stopped) {
    return runtime;
  }

  const agent = await requireAgentLight('work-group');
  log('GroupChat', `starting work-group admin session=${sessionId} for chat=${chatId}`);
  await startManagedAgent(agent, sessionId);
  runtime = await waitForManagedRuntimeReady('work-group', 30000, sessionId);
  if (!runtime) throw new Error('Admin runtime failed to become ready within 30s');
  return runtime;
}

/**
 * 核心派发逻辑：将消息投递到指定 identity 的 session。
 * 负责 session 解析、runtime 启动、gc inbox 投递、状态跟踪。
 */
async function dispatchToIdentity(chatId, message, chat, identityRef, composedPrompt, sessionOptions = {}) {
  const workspaceId = identityRef.split(':')[0];
  log('GroupChat', `dispatching message ${message.id} to ${workspaceId} (${identityRef}) sessionOpts=${JSON.stringify(sessionOptions)}`);

  // 1. 解析 identity 的 sessionModel
  const allIdentities = await collectIdentities();
  const identityInfo = allIdentities.find((i) => i.identityRef === identityRef);
  const sessionModel = identityInfo?.sessionModel || 'persistent';

  // 2. 解析或创建 session（传入 sessionOptions）
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, identityRef, sessionModel, sessionOptions);
  log('GroupChat', `resolved session ${sessionId} (isNew=${isNew}) for ${identityRef}`);

  // 3. 找到或启动指定 session 的 runtime
  let runtime = getAgentRuntime(workspaceId, sessionId);
  const isAlive = runtime?.process && runtime.process.exitCode === null && !runtime.stopped;

  if (!isAlive) {
    try {
      const agent = await requireAgentLight(workspaceId);
      log('GroupChat', `starting agent ${workspaceId} session=${sessionId} for dispatch`);
      await startManagedAgent(agent, sessionId);
      runtime = await waitForManagedRuntimeReady(workspaceId, 30000, sessionId);
      if (!runtime) {
        throw new Error('Agent runtime failed to become ready within 30s');
      }
    } catch (err) {
      log('GroupChat', `failed to start agent: ${err.message}`, 'error');
      await updateMessageRouting(chatId, message.id, {
        status: 'failed',
        error: `Failed to start agent: ${err.message}`,
        completedAt: Date.now(),
      });
      return;
    }
  }

  // 4. 确保 runtime ready
  if (!runtime.viewerAgentId) {
    const ready = await waitForManagedRuntimeReady(workspaceId, 15000, sessionId);
    if (!ready?.id) {
      await updateMessageRouting(chatId, message.id, {
        status: 'failed',
        error: 'Agent runtime not ready (no viewerAgentId)',
        completedAt: Date.now(),
      });
      return;
    }
    runtime = getAgentRuntime(workspaceId, sessionId);
  }

  const viewerAgentId = runtime?.viewerAgentId;
  if (!viewerAgentId) {
    await updateMessageRouting(chatId, message.id, {
      status: 'failed',
      error: 'No viewerAgentId available',
      completedAt: Date.now(),
    });
    return;
  }

  // 5. 上下文完整性：
  // - 管理员：catch-up + 群记忆 + GROUP.md + 群聊基本信息
  // - 被派发 agent：群聊 system 上下文块（交代群聊背景、发送者身份、回复可见性）
  // 这些内容通过 contextText 分离传递，bridge 在 CallStart 时注入为 system 消息，
  // 而不是混入用户消息。
  const runtimeKey = getManagedRuntimeKey(workspaceId, sessionId);

  let fullPrompt = composedPrompt;
  let contextText = null;

  if (identityRef === 'work-group:admin') {
    contextText = await prepareAdminContext(
      chatId, allIdentities,
      message.timestamp || Date.now(), message.id, isNew,
    );
  } else {
    // 被派发的 agent：注入群聊 system 上下文块
    contextText = buildGroupDispatchSystemMessage(chat, message, allIdentities);
  }

  // 6. 通过 gc inbox 投递实际消息（context 通过 contextText 字段分离传递）
  enqueueGcInbox(runtimeKey, {
    id: message.id,
    text: fullPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: identityRef,
  });
  log('GroupChat', `message ${message.id} enqueued to gc inbox for ${workspaceId}/${sessionId}`);

  // 6. 更新 routing 状态（含 sessionTitle 供 dispatch 卡片展示）
  // 查找 session 标题用于展示
  let resolvedSessionTitle = sessionId;
  try {
    const idx = await readSessionIndex(workspaceId);
    const rec = idx.sessions.find((s) => s.id === sessionId);
    if (rec) resolvedSessionTitle = rec.title || rec.taskTitle || sessionId;
  } catch {}

  await updateMessageRouting(chatId, message.id, {
    status: 'delivered',
    targetSessionId: sessionId,
    targetSessionTitle: resolvedSessionTitle,
    dispatchedAt: Date.now(),
  });

  // 6.5. 追加"任务已启动"事件卡片（以 agent 身份发送，便于追踪）
  // 管理员自身不需要 task_started 卡片——它是协调者，不是执行者
  // 管理员发起的 dispatch 已经有 dispatch 卡片传达了完整信息，不再追加冗余事件
  if (identityRef !== 'work-group:admin' && message.from !== 'work-group:admin') {
    await appendGroupChatMessage(chatId, {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId,
      from: identityRef,
      text: '',
      kind: 'event',
      event: {
        type: 'task_started',
        identityRef,
        identityName: identityInfo?.displayName || workspaceId,
        sessionId,
        sessionTitle: resolvedSessionTitle,
        workspaceId,
      },
      mentions: [],
      links: [],
      timestamp: Date.now(),
      routing: null,
    });
    log('GroupChat', `event card appended: task_started for ${identityRef} in ${chatId}`);
  }

  // 6.6. 规划模式下不再单独通知 task_started 事件
  // plan 模式的通知已在 dispatchGroupChatMessage 的 plan 分支合并投递
  // （notifyAdminWithPrompt 包含了"@了X + X已开始处理"的完整信息）

  // 7. 后台跟踪完成状态
  trackGroupChatDispatch(chatId, message.id, workspaceId, viewerAgentId);
}

/**
 * 群聊消息派发入口。
 * 根据群的主动性模式决定路由策略：
 * - assist: 直接派发到目标 agent
 * - plan: 直接派发 + 通知管理员观察
 * - execute: 转发给管理员协调
 */
async function dispatchGroupChatMessage(chatId, message, sessionOptions = {}) {
  const routing = message.routing;
  if (!routing || !routing.targetWorkspaceId) return;

  const chat = await readGroupChat(chatId);
  const chatName = chat?.name || '';
  const initiativeMode = chat?.initiativeMode || 'assist';
  const autonomyMode = chat?.autonomyMode || 'auto';
  const targetIdentityRef = routing.targetIdentityRef;
  const targetIsAdmin = targetIdentityRef === 'work-group:admin';

  // @管理员 → 始终直接派发给管理员
  if (targetIsAdmin) {
    const prompt = composeDispatchPrompt(chatName, message, chatId);
    await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
    return;
  }

  // 管理员发出的派发消息 → 直接到达目标，不再经过模式路由。
  // 否则在 execute 模式下，admin dispatch → 新消息 → 又路由回 admin → 无限循环。
  if (message.from === 'work-group:admin') {
    const prompt = composeDispatchPrompt(chatName, message, chatId);
    await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);
    return;
  }

  switch (initiativeMode) {
    case 'execute': {
      // 执行模式：转发给管理员协调
      log('GroupChat', `execute mode: routing to admin for ${message.id}`);
      const allIdentities = await collectIdentities();
      const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
      const targetName = targetInfo?.displayName || targetIdentityRef;
      const autonomyDesc = {
        auto: '直接执行',
        cautious: '遇疑则停',
        confirm: '先给方案再执行',
      }[autonomyMode] || '直接执行';

      const coordinatorPrompt = [
        `用户 @了 ${targetName}：`,
        message.text || '',
        '',
        `自决权：${autonomyDesc}`,
      ].join('\n');

      // 更新 routing 目标为管理员
      await updateMessageRouting(chatId, message.id, {
        targetIdentityRef: 'work-group:admin',
        targetWorkspaceId: 'work-group',
        routedByMode: 'execute',
      });
      await dispatchToIdentity(chatId, message, chat, 'work-group:admin', coordinatorPrompt);
      break;
    }

    case 'plan': {
      // 规划模式：直接派发 + 单一通知管理员
      const prompt = composeDispatchPrompt(chatName, message, chatId);
      await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt, sessionOptions);

      // 异步通知管理员（合并：观察 + 任务启动信息，一次 call 搞定）
      // user 块只放精简的身份标签，详细内容在 catch-up（system 块）中
      const allIdentities = await collectIdentities();
      const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
      const targetName = targetInfo?.displayName || targetIdentityRef;

      const observationPrompt = [
        `[观察] 用户 @了 ${targetName}：${(message.text || '').slice(0, 200)}`,
        `${targetName} 已开始处理。你不需要重复派发。`,
      ].join('\n');

      notifyAdminWithPrompt(chatId, message, chat, observationPrompt).catch((err) => {
        log('GroupChat', `admin observation notify failed: ${err.message}`, 'warn');
      });
      break;
    }

    case 'assist':
    default: {
      // 辅助模式：直接派发
      const prompt = composeDispatchPrompt(chatName, message, chatId);
      await dispatchToIdentity(chatId, message, chat, targetIdentityRef, prompt);
      break;
    }
  }
}

/**
 * 统一管理员通知通道：向管理员投递一条自定义 prompt（合并到一次 call）。
 * 内部调用 prepareAdminContext 保证 catch-up + 群记忆完整性。
 * 用于替代 notifyAdminForObservation，避免产生多次碎片化 call。
 */
async function notifyAdminWithPrompt(chatId, message, chat, promptText) {
  const allIdentities = await collectIdentities();

  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `notifyAdminWithPrompt: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  const contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew,
  );

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  enqueueGcInbox(runtimeKey, {
    id: `obs-${message.id}`,
    text: promptText,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
  });
  log('GroupChat', `notifyAdminWithPrompt enqueued for admin`);
}

/**
 * 规划模式下，通知管理员观察群内活动。
 * 不创建 routing，只投递一条观察消息到管理员的 gc inbox。
 */
async function notifyAdminForObservation(chatId, message, chat, targetIdentityRef) {
  const chatName = chat?.name || '';
  const allIdentities = await collectIdentities();
  const targetInfo = allIdentities.find((i) => i.identityRef === targetIdentityRef);
  const targetName = targetInfo?.displayName || targetIdentityRef;

  const observationPrompt = [
    `[观察] 用户 @了 ${targetName}：${(message.text || '').slice(0, 200)}`,
    '',
    `系统已将此消息派发给 ${targetName}，会话已启动。你不需要重复派发。`,
  ].join('\n');

  // 确保管理员 runtime 存在
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `admin observation: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  // 上下文完整性：经统一通道补全 catch-up + 群记忆
  const contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew,
  );

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  enqueueGcInbox(runtimeKey, {
    id: `obs-${message.id}`,
    text: observationPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
  });
  log('GroupChat', `observation notify enqueued for admin`);
}

/**
 * 规划模式下，通知管理员观察一般群聊活动（非 @mention 消息）。
 * 用于纯讨论消息、agent 回复等。
 */
async function notifyAdminForActivity(chatId, message, chat) {
  const chatName = chat?.name || '';
  const allIdentities = await collectIdentities();
  const senderInfo = allIdentities.find((i) => i.identityRef === message.from);
  const senderName = message.from === 'user'
    ? '用户'
    : (senderInfo?.displayName || message.from);

  let activityDesc;
  if (message.kind === 'event') {
    activityDesc = `系统事件：${message.event?.identityName || ''} 已开始处理`;
  } else if (message.from === 'user') {
    activityDesc = `用户发送了消息：${(message.text || '').slice(0, 200)}`;
  } else {
    activityDesc = `${senderName} 回复了：${(message.text || '').slice(0, 200)}`;
  }

  // user 块包含当前触发消息的摘要（catch-up 只含更早的未读消息，无重复）
  const activityPrompt = activityDesc;

  // 确保管理员 runtime 存在
  const { sessionId, isNew } = await resolveGroupChatSession(chatId, 'work-group:admin', 'persistent');
  let runtime;
  try {
    runtime = await ensureAdminRuntime(chatId, sessionId);
  } catch (err) {
    log('GroupChat', `admin activity: failed to start runtime: ${err.message}`, 'warn');
    return;
  }

  // 上下文完整性：经统一通道补全 catch-up + 群记忆
  const contextText = await prepareAdminContext(
    chatId, allIdentities, message.timestamp || Date.now(), message.id, isNew,
  );

  const runtimeKey = getManagedRuntimeKey('work-group', sessionId);
  enqueueGcInbox(runtimeKey, {
    id: `act-${message.id}`,
    text: activityPrompt,
    contextText,
    gcChatId: chatId,
    gcIdentityRef: 'work-group:admin',
  });
  log('GroupChat', `activity notify enqueued for admin: ${activityDesc.slice(0, 50)}`);
}

/**
 * 后台跟踪 agent 是否完成处理。
 * 通过 ViewerWorker /running 端点检测 agent 运行状态变化。
 * 当 agent 从 running → idle 时，标记消息为 completed。
 * Agent 回复通过 GroupChatBridgeFeature 的 CallFinish piggyback 写回群聊。
 */
function trackGroupChatDispatch(chatId, messageId, workspaceId, viewerAgentId) {
  let wasRunning = false;
  const startTime = Date.now();
  const TIMEOUT_MS = 15 * 60 * 1000; // 15 分钟超时

  const interval = setInterval(async () => {
    // 超时保护
    if (Date.now() - startTime > TIMEOUT_MS) {
      clearInterval(interval);
      await updateMessageRouting(chatId, messageId, {
        status: 'failed',
        error: 'Agent call timeout (15min)',
        completedAt: Date.now(),
      });
      return;
    }

    try {
      // 检查 runtime 是否还活着
      const runtime = getAgentRuntime(workspaceId);
      if (!runtime || runtime.stopped || runtime.process?.exitCode !== null) {
        if (wasRunning) {
          // Agent 曾经运行过，现在进程已退出
          clearInterval(interval);
          await updateMessageRouting(chatId, messageId, {
            status: 'completed',
            completedAt: Date.now(),
          });
        }
        return;
      }

      // 检查 ViewerWorker 的 running 状态
      const currentViewerId = runtime.viewerAgentId || viewerAgentId;
      const res = await fetch(
        `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(currentViewerId)}/running`
      );
      if (!res.ok) return;
      const data = await res.json();
      const isRunning = data.running === true || data.callActive === true;

      if (isRunning) {
        wasRunning = true;
      } else if (wasRunning) {
        // Agent 曾在运行，现在空闲 → 完成
        clearInterval(interval);
        await updateMessageRouting(chatId, messageId, {
          status: 'completed',
          completedAt: Date.now(),
        });
        log('GroupChat', `message ${messageId} completed`);
      }
    } catch {
      // 网络错误等，继续重试
    }
  }, 3000);
}

// ── Group Chat CRUD API ────────────────────────────────────────────

app.get('/protoclaw/group_chats', async (_req, res, next) => {
  try {
    const chats = await listGroupChats();
    res.json({ chats });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/group_chats', express.json(), async (req, res, next) => {
  try {
    const { name, workDir, members } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chat = {
      id: chatId,
      name,
      workDir: workDir || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      members: Array.isArray(members) ? members : [
        { identityRef: 'user', role: 'human' },
      ],
      messages: [],
      sessions: {},
      initiativeMode: 'assist',
      autonomyMode: 'auto',
      adminMemory: { range: '3d', limitMode: 'tokens', limitValue: 100000 },
      lastActiveAt: {},
    };
    await writeGroupChat(chat);
    res.status(201).json(chat);
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/group_chats/:chatId', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const { name, workDir, members, initiativeMode, autonomyMode, adminMemory } = req.body || {};
    if (name !== undefined) chat.name = name;
    if (workDir !== undefined) chat.workDir = workDir || null;
    if (Array.isArray(members)) chat.members = members;
    if (typeof initiativeMode === 'string') chat.initiativeMode = initiativeMode;
    if (typeof autonomyMode === 'string') chat.autonomyMode = autonomyMode;
    if (adminMemory && typeof adminMemory === 'object') {
      chat.adminMemory = {
        range: adminMemory.range || '3d',
        limitMode: adminMemory.limitMode || 'tokens',
        limitValue: typeof adminMemory.limitValue === 'number' ? adminMemory.limitValue : 100000,
      };
    }

    await writeGroupChat(chat);
    res.json(chat);
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId', async (req, res, next) => {
  try {
    const deleted = await deleteGroupChatFile(req.params.chatId);
    if (!deleted) return res.status(404).json({ error: 'Group chat not found' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat GROUP.md API ────────────────────────────────────────
// GROUP.md 存放在群聊独立数据目录 group-chats/<chatId>/GROUP.md，
// 不依赖 workDir，避免同 workDir 多群聊共用污染。

function getGroupChatDataDir(chatId) {
  return path.join(GROUP_CHATS_ROOT, chatId);
}

app.get('/protoclaw/group_chats/:chatId/group_md', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const mdPath = path.join(getGroupChatDataDir(req.params.chatId), 'GROUP.md');
    try {
      const content = await fs.readFile(mdPath, 'utf-8');
      res.json({ content, exists: true });
    } catch {
      res.json({ content: '', exists: false });
    }
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/group_md', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });

    const dataDir = getGroupChatDataDir(req.params.chatId);
    await fs.mkdir(dataDir, { recursive: true });
    const mdPath = path.join(dataDir, 'GROUP.md');
    await fs.writeFile(mdPath, content, 'utf-8');
    res.json({ ok: true, path: mdPath });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Resources API ───────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/resources', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.json({ resources: [], noWorkDir: true });

    try {
      await fs.mkdir(resDir, { recursive: true });
      const entries = await fs.readdir(resDir);
      const resources = [];
      for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (!RESOURCE_ALLOWED_EXTS.has(ext)) continue;
        try {
          const stat = await fs.stat(path.join(resDir, entry));
          resources.push({
            name: entry,
            size: stat.size,
            mtime: stat.mtimeMs,
            ext: ext.slice(1),
          });
        } catch {}
      }
      resources.sort((a, b) => b.mtime - a.mtime);
      res.json({ resources });
    } catch {
      res.json({ resources: [] });
    }
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/group_chats/:chatId/resources/:name', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const filePath = path.join(resDir, validation.name);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const stat = await fs.stat(filePath);
      res.json({ name: validation.name, content, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      res.status(404).json({ error: 'Resource not found' });
    }
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/resources/:name', express.json(), async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content (string) required' });

    await fs.mkdir(resDir, { recursive: true });
    const filePath = path.join(resDir, validation.name);
    await fs.writeFile(filePath, content, 'utf8');
    const stat = await fs.stat(filePath);
    res.json({ ok: true, name: validation.name, size: stat.size });
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId/resources/:name', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const resDir = getResourcesDir(chat);
    if (!resDir) return res.status(400).json({ error: 'Group chat has no workDir set' });

    const validation = validateResourceName(req.params.name);
    if (!validation.ok) return res.status(400).json({ error: validation.error });

    const filePath = path.join(resDir, validation.name);
    try {
      await fs.unlink(filePath);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'Resource not found' });
    }
  } catch (error) {
    next(error);
  }
});

// ── Group Chat WorkDir Scan API ─────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/workdir_scan', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });
    if (!chat.workDir) return res.json({ workDir: null, entries: [], keyFiles: {} });

    const workDir = chat.workDir;
    const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.cache', '__pycache__', '.next', 'build', '.svelte-kit', 'coverage', '.turbo', '.nuxt', 'target', 'vendor']);
    const KEY_FILE_NAMES = ['package.json', 'README.md', 'README', 'CLAUDE.md', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'Makefile', 'docker-compose.yml', '.env.example', 'tsconfig.json', 'requirements.txt'];

    // Scan top-level directory
    const entries = [];
    const dirItems = await fs.readdir(workDir, { withFileTypes: true });
    for (const item of dirItems) {
      if (item.name.startsWith('.') && item.name !== '.env.example' && item.name !== '.agentdev') continue;
      if (IGNORE_DIRS.has(item.name)) continue;
      entries.push({
        type: item.isDirectory() ? 'dir' : 'file',
        name: item.name,
      });
    }

    // Read key files
    const keyFiles = {};
    for (const fname of KEY_FILE_NAMES) {
      const fpath = path.join(workDir, fname);
      try {
        const stat = await fs.stat(fpath);
        if (!stat.isFile()) continue;
        const raw = await fs.readFile(fpath, 'utf-8');
        // Truncate large files
        keyFiles[fname] = raw.length > 4000 ? raw.slice(0, 4000) + '\n...(truncated)' : raw;
      } catch {
        // File doesn't exist, skip
      }
    }

    // Also scan second-level directories (names only, for structure awareness)
    const subDirs = entries.filter(e => e.type === 'dir');
    for (const dir of subDirs) {
      const dirPath = path.join(workDir, dir.name);
      try {
        const subItems = await fs.readdir(dirPath, { withFileTypes: true });
        const subNames = subItems
          .filter(i => !i.name.startsWith('.') && !IGNORE_DIRS.has(i.name))
          .slice(0, 15)
          .map(i => `${i.isDirectory() ? '[D]' : '[F]'} ${i.name}`);
        if (subNames.length > 0) {
          entries.push({ type: 'subdir_listing', name: `${dir.name}/`, children: subNames });
        }
      } catch {
        // Permission denied or other error, skip
      }
    }

    res.json({ workDir, entries, keyFiles });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Messages API ────────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/messages', async (req, res, next) => {
  try {
    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const offset = parseInt(req.query.offset) || 0;
    const messages = (chat.messages || []).slice(offset, offset + limit);

    res.json({
      messages,
      total: (chat.messages || []).length,
      offset,
      limit,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/group_chats/:chatId/messages', express.json(), async (req, res, next) => {
  try {
    const { text, mentions, links, from, kind, attachments, targetSessionId, forceNew } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });

    const chat = await readGroupChat(req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const messageFrom = from || 'user';

    const message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId: chat.id,
      from: messageFrom,
      text,
      mentions: Array.isArray(mentions) ? mentions : [],
      links: Array.isArray(links) ? links.filter((l) => l && l.url) : [],
      attachments: Array.isArray(attachments) ? attachments.filter((a) => a && a.name) : [],
      kind: kind || 'text',
      timestamp: Date.now(),
      routing: null,
    };

    // 任何带 mention 的消息都初始化 routing（user 和 admin 派发均可）
    if (message.mentions.length > 0) {
      const firstMention = message.mentions[0];
      const targetRef = firstMention.identityRef || null;
      // 防止 admin 向自己派发（反馈循环）
      if (targetRef && targetRef !== messageFrom) {
        message.routing = {
          status: 'pending',
          targetIdentityRef: targetRef,
          targetWorkspaceId: targetRef.split(':')[0] || null,
          targetSessionId: null,
          dispatchedAt: null,
          completedAt: null,
          error: null,
        };
      }
    }

    await appendGroupChatMessage(chat.id, message);

    // 异步派发（不阻塞响应）——任何带 routing 的消息触发
    if (message.routing) {
      const sessionOptions = {};
      if (targetSessionId) sessionOptions.targetSessionId = targetSessionId;
      if (forceNew) sessionOptions.forceNew = true;
      dispatchGroupChatMessage(chat.id, message, sessionOptions).catch((err) => {
        console.error(`[GroupChat] dispatch failed for ${message.id}:`, err);
      });
    } else if ((chat.initiativeMode || 'assist') === 'plan' && messageFrom !== 'work-group:admin') {
      // 规划模式：观察所有非 admin 的非 @mention 消息
      notifyAdminForActivity(chat.id, message, chat).catch((err) => {
        log('GroupChat', `admin activity notify failed: ${err.message}`, 'warn');
      });
    }

    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Sessions API ────────────────────────────────────────

app.get('/protoclaw/group_chats/:chatId/sessions/:identityRef', async (req, res, next) => {
  try {
    const { chatId, identityRef } = req.params;
    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    const workspaceId = identityRef.split(':')[0];
    const sessionModel = (await collectIdentities()).find((i) => i.identityRef === identityRef)?.sessionModel || 'persistent';
    const activeSessionId = chat.sessions?.[identityRef] || null;

    // 获取该 workspace 的全部会话
    const index = await readSessionIndex(workspaceId);

    // 群内会话：被 chat.sessions 映射引用的 session
    // 使用精确 identityRef 匹配（非 workspace 前缀），避免其他身份的 session 混入
    const chatSessionIds = new Set(
      Object.entries(chat.sessions || {})
        .filter(([ref]) => ref === identityRef)
        .map(([, sid]) => sid)
    );

    // 管理员：将历史 session（滚动前的旧 session）也纳入群内会话
    if (identityRef === 'work-group:admin' && Array.isArray(chat.adminSessionHistory)) {
      for (const sid of chat.adminSessionHistory) chatSessionIds.add(sid);
    }

    const inChatSessions = index.sessions
      .filter((s) => chatSessionIds.has(s.id))
      .map((s) => ({
        id: s.id,
        title: s.title || s.taskTitle || '未命名',
        updatedAt: s.updatedAt || s.createdAt,
        isActive: s.id === activeSessionId,
      }));

    // 外部会话：不在群内映射中的会话（取最近 20 条）
    const externalSessions = index.sessions
      .filter((s) => !chatSessionIds.has(s.id))
      .slice(0, 20)
      .map((s) => ({
        id: s.id,
        title: s.title || s.taskTitle || '未命名',
        updatedAt: s.updatedAt || s.createdAt,
      }));

    res.json({
      identityRef,
      sessionModel,
      activeSessionId,
      inChatSessions,
      externalSessions,
    });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Admin Status API ─────────────────────────────────

/**
 * 计算管理员会话的健康状态。
 * 统一 healthRatio 语义：0 = 空，1.0 = 到达上限（触发滚动），>1.0 = 已超限。
 */
async function getAdminStatus(chatId) {
  const chat = await readGroupChat(chatId);
  if (!chat) return null;

  const identityRef = 'work-group:admin';
  const workspaceId = 'work-group';
  const sessionId = chat.sessions?.[identityRef] || null;

  if (!sessionId) {
    return {
      online: false,
      sessionId: null,
      sessionTitle: null,
      contextTokens: 0,
      contextLimit: null,
      limitMode: (chat.adminMemory?.limitMode || 'tokens'),
      limitValue: (chat.adminMemory?.limitValue ?? 100000),
      healthRatio: 0,
      healthStatus: 'unknown',
    };
  }

  // 判断 runtime 是否存活
  const runtime = getAgentRuntime(workspaceId, sessionId);
  const online = !!(runtime?.process && runtime.process.exitCode === null && !runtime.stopped);

  // 获取上下文用量
  const { contextTokens, available } = await getSessionContextUsage(workspaceId, sessionId);

  // 获取 session 标题
  let sessionTitle = null;
  try {
    const index = await readSessionIndex(workspaceId);
    const record = index.sessions.find((s) => s.id === sessionId);
    sessionTitle = record?.title || record?.taskTitle || null;
  } catch { /* ignore */ }

  const mem = chat.adminMemory || { limitMode: 'tokens', limitValue: 100000 };
  let healthRatio = 0;
  let contextLimit = null;

  if (mem.limitMode === 'ratio') {
    const modelInfo = await resolveSessionModelInfo(workspaceId, 'default');
    const contextLength = modelInfo?.contextLength || 200000;
    contextLimit = Math.floor(contextLength * mem.limitValue / 100);
    if (available && contextLength > 0) {
      const actualRatio = contextTokens / contextLength;
      const limitRatio = mem.limitValue / 100;
      healthRatio = limitRatio > 0 ? actualRatio / limitRatio : 0;
    }
  } else {
    contextLimit = mem.limitValue;
    if (available && mem.limitValue > 0) {
      healthRatio = contextTokens / mem.limitValue;
    }
  }

  let healthStatus = 'healthy';
  if (!available || healthRatio === 0) {
    healthStatus = 'unknown';
  } else if (healthRatio >= 1.0) {
    healthStatus = 'critical';
  } else if (healthRatio >= 0.8) {
    healthStatus = 'warning';
  }

  return {
    online,
    sessionId,
    sessionTitle,
    contextTokens,
    contextLimit,
    limitMode: mem.limitMode || 'tokens',
    limitValue: mem.limitValue ?? 100000,
    healthRatio,
    healthStatus,
  };
}

app.get('/protoclaw/group_chats/:chatId/admin_status', async (req, res, next) => {
  try {
    const status = await getAdminStatus(req.params.chatId);
    if (!status) return res.status(404).json({ error: 'Group chat not found' });
    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/group_chats/:chatId/admin_restart', async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const identityRef = 'work-group:admin';

    // 整个 stop + create 流程在锁内完成，防止并发 dispatch 在 stop 后重启旧 runtime
    const { oldSessionId, newSessionId } = await withAdminSessionLock(chatId, async () => {
      const chat = await readGroupChat(chatId);
      if (!chat) throw new Error('Group chat not found');

      const oldSid = chat.sessions?.[identityRef] || null;

      // 1. 停止旧 runtime（如果存在）
      if (oldSid) {
        log('GroupChat', `admin restart: stopping old session ${oldSid}`);
        await stopManagedAgent('work-group', oldSid);
      }

      // 2. 强制新建 session（更新 chat.sessions 映射 + 记录历史）
      const result = await _resolveGroupChatSessionInner(
        chatId, identityRef, 'persistent', { forceNew: true }
      );
      log('GroupChat', `admin restart: created new session ${result.sessionId}`);

      return { oldSessionId: oldSid, newSessionId: result.sessionId };
    });

    // 3. 返回最新状态
    const status = await getAdminStatus(req.params.chatId);
    res.json({ ...status, restartedFromSession: oldSessionId });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Session Pool (External Import) API ─────────────────

/**
 * 跨所有 workspace 搜索会话，用于"引入到群聊会话池"。
 * 排除已引入的 session 和已在 chat.sessions 映射中的 session。
 */
app.get('/protoclaw/group_chats/:chatId/search_sessions', async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const q = (req.query.q || '').trim().toLowerCase();
    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    // 已在会话池中的 session ID 集合（包括 chat.sessions 映射和已引入的）
    const pooledIds = new Set([
      ...Object.values(chat.sessions || {}).filter(Boolean),
      ...(chat.importedSessions || []).map((s) => s.sessionId),
    ]);

    const agents = await discoverAgents(AGENTS_ROOT);
    const results = [];

    for (const agent of agents) {
      if (agent.enabled === false || agent.launchMode === 'ui-only') continue;
      let index;
      try {
        index = await readSessionIndex(agent.id);
      } catch {
        continue;
      }

      for (const session of index.sessions) {
        if (session.archived) continue;
        if (pooledIds.has(session.id)) continue;

        const title = session.title || session.taskTitle || '未命名';
        const searchText = [title, session.goal, session.taskTitle]
          .filter(Boolean).join(' ').toLowerCase();

        // 无关键词时返回所有（前端限制数量）；有关键词时模糊匹配
        if (q && !searchText.includes(q)) continue;

        results.push({
          workspaceId: agent.id,
          workspaceName: agent.name || agent.id,
          sessionId: session.id,
          title,
          updatedAt: session.updatedAt || session.createdAt,
          sessionType: session.sessionType || null,
        });
      }
    }

    // 按更新时间降序
    results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    res.json({ sessions: results.slice(0, 50) });
  } catch (error) {
    next(error);
  }
});

/**
 * 引入一个外部 session 到群聊会话池。
 */
app.post('/protoclaw/group_chats/:chatId/import_session', express.json(), async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const { workspaceId, sessionId } = req.body;
    if (!workspaceId || !sessionId) {
      return res.status(400).json({ error: 'workspaceId and sessionId are required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    // 验证 session 存在
    let sessionTitle = null;
    try {
      const index = await readSessionIndex(workspaceId);
      const record = index.sessions.find((s) => s.id === sessionId);
      if (!record) return res.status(404).json({ error: 'Session not found' });
      sessionTitle = record.title || record.taskTitle || '未命名';
    } catch {
      return res.status(404).json({ error: 'Session not found' });
    }

    // 初始化 importedSessions 数组
    if (!Array.isArray(chat.importedSessions)) chat.importedSessions = [];

    // 避免重复引入
    const exists = chat.importedSessions.find(
      (s) => s.workspaceId === workspaceId && s.sessionId === sessionId
    );
    if (exists) {
      return res.json({ imported: chat.importedSessions });
    }

    // 获取 workspace 名称
    const agents = await discoverAgents(AGENTS_ROOT);
    const agentInfo = agents.find((a) => a.id === workspaceId);

    chat.importedSessions.push({
      workspaceId,
      sessionId,
      title: sessionTitle,
      workspaceName: agentInfo?.name || workspaceId,
      importedAt: Date.now(),
    });

    await writeGroupChat(chat);
    log('GroupChat', `imported session ${sessionId} from ${workspaceId} into chat ${chatId}`);

    res.json({ imported: chat.importedSessions });
  } catch (error) {
    next(error);
  }
});

/**
 * 移除已引入的外部 session。
 */
app.delete('/protoclaw/group_chats/:chatId/import_session', express.json(), async (req, res, next) => {
  try {
    const chatId = req.params.chatId;
    const { workspaceId, sessionId } = req.body;
    if (!workspaceId || !sessionId) {
      return res.status(400).json({ error: 'workspaceId and sessionId are required' });
    }

    const chat = await readGroupChat(chatId);
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    if (Array.isArray(chat.importedSessions)) {
      chat.importedSessions = chat.importedSessions.filter(
        (s) => !(s.workspaceId === workspaceId && s.sessionId === sessionId)
      );
      await writeGroupChat(chat);
    }

    res.json({ imported: chat.importedSessions || [] });
  } catch (error) {
    next(error);
  }
});

// ── Group Chat Annotations API ──────────────────────────────────

function _annotationsFilePath(chatId) {
  return path.join(GROUP_CHATS_ROOT, `${sanitizeSessionFragment(chatId)}.annotations.json`);
}

async function readAnnotations(chatId) {
  try {
    const raw = await fs.readFile(_annotationsFilePath(chatId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeAnnotations(chatId, annotations) {
  await ensureGroupChatsDir();
  await fs.writeFile(_annotationsFilePath(chatId), JSON.stringify(annotations, null, 2), 'utf8');
}

app.get('/protoclaw/group_chats/:chatId/annotations', async (req, res, next) => {
  try {
    const annotations = await readAnnotations(req.params.chatId);
    res.json({ annotations });
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/group_chats/:chatId/annotations/:messageId', express.json(), async (req, res, next) => {
  try {
    const { chatId, messageId } = req.params;
    const { text } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    const annotations = await readAnnotations(chatId);
    annotations[messageId] = {
      text: text.trim(),
      timestamp: Date.now(),
      author: 'user',
    };
    await writeAnnotations(chatId, annotations);
    res.json({ success: true, annotation: annotations[messageId] });
  } catch (error) {
    next(error);
  }
});

app.delete('/protoclaw/group_chats/:chatId/annotations/:messageId', async (req, res, next) => {
  try {
    const { chatId, messageId } = req.params;
    const annotations = await readAnnotations(chatId);
    delete annotations[messageId];
    await writeAnnotations(chatId, annotations);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// ── End Group Chat API ─────────────────────────────────────────────

// ── System Feature Config API ────────────────────────────────────

const SYSTEM_FEATURE_CONFIG_PATH = path.join(USER_DATA_ROOT, 'feature-setup.json');

/**
 * Detect whether a shell executable is available on this system.
 * Mirrors the logic in ShellFeature's findGitBashPath / findPowerShellPath.
 */
function detectShellPath(type, configuredPath) {
  // 0. User-configured path
  if (configuredPath && configuredPath.trim()) {
    const p = configuredPath.trim();
    if (existsSync(p)) return { available: true, path: p, source: 'configured' };
  }

  const isWin = process.platform === 'win32';

  if (type === 'bash') {
    // 1. Env var
    if (process.env.AGENTDEV_GIT_BASH_PATH && existsSync(process.env.AGENTDEV_GIT_BASH_PATH)) {
      return { available: true, path: process.env.AGENTDEV_GIT_BASH_PATH, source: 'env' };
    }
    if (!isWin) {
      const shellPath = process.env.SHELL || '/bin/bash';
      return { available: true, path: shellPath, source: 'env' };
    }
    // 2. Common Windows locations
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    // 3. `where bash`
    try {
      const result = execSync('where bash', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of result.split('\n').map(l => l.trim()).filter(Boolean)) {
        if (line.toLowerCase().includes('git')) candidates.push(line);
      }
    } catch { /* where not available or bash not found */ }
    // 4. Derive from git path
    try {
      const gitPath = execSync('where git', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0]?.trim();
      if (gitPath) candidates.push(path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe'));
    } catch { /* git not in PATH */ }

    for (const c of candidates) {
      if (c && existsSync(c)) return { available: true, path: c, source: 'auto-detected' };
    }
    return { available: false, path: null, source: null };
  }

  if (type === 'powershell') {
    // 1. Env var
    if (process.env.AGENTDEV_POWERSHELL_PATH && existsSync(process.env.AGENTDEV_POWERSHELL_PATH)) {
      return { available: true, path: process.env.AGENTDEV_POWERSHELL_PATH, source: 'env' };
    }
    const whereCmd = isWin ? 'where' : 'which';
    // 2. pwsh (PS 7+)
    try {
      const result = execSync(`${whereCmd} pwsh`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const p = result.split('\n').map(l => l.trim()).filter(Boolean)[0];
      if (p && existsSync(p)) return { available: true, path: p, source: 'auto-detected' };
    } catch { /* pwsh not installed */ }
    // 3. powershell (5.1, Windows only)
    if (isWin) {
      try {
        const result = execSync(`${whereCmd} powershell`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const p = result.split('\n').map(l => l.trim()).filter(Boolean)[0];
        if (p && existsSync(p)) return { available: true, path: p, source: 'auto-detected' };
      } catch { /* not in PATH */ }
      // 4. System default path
      const sysPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      if (existsSync(sysPath)) return { available: true, path: sysPath, source: 'auto-detected' };
    }
    return { available: false, path: null, source: null };
  }

  return { available: false, path: null, source: null };
}

function readSystemFeatureConfigFile() {
  try {
    if (!existsSync(SYSTEM_FEATURE_CONFIG_PATH)) return {};
    const raw = readFileSync(SYSTEM_FEATURE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSystemFeatureConfigFile(config) {
  const dir = path.dirname(SYSTEM_FEATURE_CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(SYSTEM_FEATURE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

app.get('/protoclaw/system_feature_config', (_req, res) => {
  res.json(readSystemFeatureConfigFile());
});

app.put('/protoclaw/system_feature_config', express.json(), (req, res) => {
  const config = req.body;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return res.status(400).json({ error: 'Config must be a non-null object' });
  }

  // ── Validate shell config: strip enabled-but-unavailable shells ──
  if (config.shell && typeof config.shell === 'object') {
    const bashAvail = detectShellPath('bash', config.shell.bashPath);
    const psAvail = detectShellPath('powershell', config.shell.powershellPath);
    const changes = [];

    if (config.shell.bashEnabled && !bashAvail.available) {
      config.shell.bashEnabled = false;
      changes.push('bash');
    }
    if (config.shell.powershellEnabled && !psAvail.available) {
      config.shell.powershellEnabled = false;
      changes.push('powershell');
    }
  }

  writeSystemFeatureConfigFile(config);
  res.json({ ok: true });
});

app.get('/protoclaw/shell_availability', (req, res) => {
  const config = readSystemFeatureConfigFile();
  const shellConfig = config.shell || {};
  res.json({
    bash: detectShellPath('bash', shellConfig.bashPath),
    powershell: detectShellPath('powershell', shellConfig.powershellPath),
  });
});

app.get('/protoclaw/system_feature_manifests', async (_req, res) => {
  try {
    const seen = new Set();
    const features = [];

    const importPaths = ['agentdev'];
    for (const importPath of importPaths) {
      try {
        const mod = await import(importPath);
        const featureClasses = Object.entries(mod).filter(
          ([, val]) => typeof val === 'function' && /Feature$/.test(val.name || '')
        );
        for (const [, FeatureClass] of featureClasses) {
          try {
            const instance = new FeatureClass();
            const fname = instance.name || FeatureClass.name;
            if (seen.has(fname)) continue;
            if (typeof instance.getFeatureManifest === 'function') {
              const manifest = instance.getFeatureManifest();
              if (manifest?.settings?.properties) {
                seen.add(fname);
                features.push({ featureName: fname, manifest });
              }
            }
          } catch {}
        }
      } catch {}
    }

    res.json({ features });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── End System Feature Config API ────────────────────────────────

// ── Runtime Inbox observation API (read-only) ──────────────────

app.get('/protoclaw/runtime/inbox', (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);
  res.json(getRuntimeInboxSnapshot(runtimeKey));
});

app.get('/protoclaw/runtime/execution_state', (req, res) => {
  const agentId = req.query.agentId;
  const sessionId = req.query.sessionId || null;
  if (!agentId) return res.status(400).json({ error: 'agentId required' });
  const runtimeKey = getManagedRuntimeKey(agentId, sessionId);
  res.json(getRuntimeExecutionState(runtimeKey));
});

app.get('/protoclaw/runtime/execution_states', (_req, res) => {
  res.json({ states: listRuntimeExecutionStates() });
});

app.get('/protoclaw/runtime/envelope', (req, res) => {
  const envelopeId = req.query.envelopeId;
  if (!envelopeId) return res.status(400).json({ error: 'envelopeId required' });
  const envelope = findEnvelopeById(envelopeId);
  if (!envelope) return res.status(404).json({ error: 'envelope not found' });
  res.json(envelope);
});

app.get('/protoclaw/runtime/envelopes_by_source', (req, res) => {
  const sourceRef = req.query.sourceRef;
  if (!sourceRef) return res.status(400).json({ error: 'sourceRef required' });
  res.json({ envelopes: findEnvelopesBySourceRef(sourceRef) });
});

// ── End Runtime Inbox observation API ───────────────────────────

app.get('/protoclaw/health', (_req, res) => {
  res.json({ ok: true, appPort: APP_PORT, viewerPort: VIEWER_PORT });
});

app.get('/protoclaw/get_prebuilt_agents', async (_req, res, next) => {
  try {
    const agents = await getAgents();
    res.json(agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      category: agent.category,
      kind: agent.kind || 'agent',
      launchMode: agent.launchMode || null,
      ui: agent.ui || null,
      features: agent.features || [],
      workspace: agent.workspace || null,
      workspace_sessions: agent.workspace_sessions || { activeSessionId: null, sessions: [] },
      workspace_data: agent.workspace_data || {},
      workspace_state: agent.workspace_state || { forms: {}, openDirectory: '', updatedAt: null },
      active_workspace_session_id: agent.workspace_sessions?.activeSessionId || null,
      modelPresets: agent.modelPresets || null,
      entry_point: agent.relativeDir,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/get_agents_status', async (_req, res, next) => {
  try {
    const agents = await getAgentsLight();
    res.json(agents.map((agent) => ({
      id: agent.id,
      status: buildStatus(agent.id).status,
      pid: buildStatus(agent.id).pid,
    })));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/get_connected_agents', async (_req, res, next) => {
  try {
    res.json(await getConnectedAgents());
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/agent_detail', async (req, res, next) => {
  try {
    const agentId = String(req.query.agentId || '').trim();
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const lightAgents = await getAgentsLight();
    const agent = lightAgents.find((item) => item.id === agentId);
    if (!agent) {
      res.status(404).json({ error: `Unknown agent: ${agentId}` });
      return;
    }
    const enriched = await enrichAgent(agent);
    res.json({
      workspace_sessions: enriched.workspace_sessions || { activeSessionId: null, sessions: [] },
      workspace_data: enriched.workspace_data || {},
      workspace_state: enriched.workspace_state || { forms: {}, openDirectory: '', updatedAt: null },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/start_agent', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (agent.launchMode === 'ui-only') {
      const connectedAgents = await getConnectedAgents();
      const connected = connectedAgents.find((item) => item.id === agent.id) || null;
      res.json({ status: buildStatus(agent.id), agent: connected });
      return;
    }
    const selectedSessionId = req.body.sessionId || null;
    const status = await startManagedAgent(agent, selectedSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, selectedSessionId);
    res.json({ status, agent: connected });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/prebuilt_sessions', async (req, res, next) => {
  try {
    if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    res.json(await listPrebuiltSessions(req.query.agentId));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/search_sessions', async (req, res, next) => {
  try {
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : '';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const openDirectory = typeof req.query.openDirectory === 'string' ? req.query.openDirectory : '';
    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (!query) {
      res.json({ query: '', results: [], total: 0, indexed: 0 });
      return;
    }
    const result = await searchSessionsContent(agentId, query, openDirectory);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/session_record', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const sessionType = await resolvePrebuiltSessionType(agentId, sessionId);
    res.json({
      sessionId,
      sessionType: sessionType || null,
      goal: parsed.goal || null,
      messages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/render_conversation', express.json(), async (req, res, next) => {
  try {
    const { sessionId, agentId, lastNCalls } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const resolvedAgentId = (typeof agentId === 'string' && agentId) || 'qqbot';
    const sessionPath = getPrebuiltSessionFilePath(resolvedAgentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    if (messages.length === 0) {
      res.status(404).json({ error: 'Session has no messages to render' });
      return;
    }

    const html = renderConversationHtml(messages, {
      title: `对话记录 ${sessionId.slice(-12)}`,
      agentId: resolvedAgentId,
      sessionId,
      lastNCalls: typeof lastNCalls === 'number' && lastNCalls > 0 ? lastNCalls : null,
    });

    const tempDir = path.join(process.cwd(), '.agentdev', 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    const filename = `conversation-${sessionId.slice(-12)}-${Date.now()}.html`;
    const filePath = path.join(tempDir, filename);
    await fs.writeFile(filePath, html, 'utf8');

    const stat = await fs.stat(filePath);
    res.json({
      path: filePath,
      filename,
      size: stat.size,
      messageCount: messages.length,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      res.status(404).json({ error: 'Session file not found' });
    } else {
      next(error);
    }
  }
});

app.get('/protoclaw/session_trim_preview', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
    const rounds = buildSessionTrimPreview(messages);
    res.json({
      sessionId,
      sessionTitle: parsed.title || '',
      contextLength: null,
      rounds,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/sessions/branch', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sourceSessionId = cleanSessionText(req.body?.sourceSessionId);
    const cutMsgIndexEnd = req.body?.cutMsgIndexEnd;

    if (!agentId || !sourceSessionId) {
      res.status(400).json({ error: 'agentId and sourceSessionId are required' });
      return;
    }
    if (typeof cutMsgIndexEnd !== 'number' || !Number.isFinite(cutMsgIndexEnd)) {
      res.status(400).json({ error: 'cutMsgIndexEnd must be a finite number' });
      return;
    }

    const sourcePath = getPrebuiltSessionFilePath(agentId, sourceSessionId);
    const sourceRaw = await fs.readFile(sourcePath, 'utf8');
    const sourceSnapshot = JSON.parse(sourceRaw);
    const rawMessages = Array.isArray(sourceSnapshot?.runtime?.context?.messages)
      ? sourceSnapshot.runtime.context.messages
      : [];

    const branchMessages = rawMessages.slice(0, cutMsgIndexEnd + 1);

    if (branchMessages.length === 0) {
      res.status(400).json({ error: 'No messages to keep after branch cut' });
      return;
    }

    // Determine the maximum user turn in the branch so we can preserve the
    // invariant: user message turn === checkpoint callIndex === _callIndex.
    // Previously callIndex was hardcoded to 0 which broke rollback entirely.
    let maxUserTurn = -1;
    for (const m of branchMessages) {
      if (m.role === 'user' && typeof m.turn === 'number') {
        maxUserTurn = Math.max(maxUserTurn, m.turn);
      }
    }

    // Only keep checkpoints whose callIndex is within the branch range.
    // Checkpoints beyond the cut point reference context that no longer exists.
    const sourceCheckpoints = Array.isArray(sourceSnapshot.rollbackHistory)
      ? sourceSnapshot.rollbackHistory
      : [];
    const branchCheckpoints = sourceCheckpoints.filter(
      cp => typeof cp.callIndex === 'number' && cp.callIndex <= maxUserTurn
    );

    // Truncate enrichedMessages to match the branch message range.
    const sourceEnriched = Array.isArray(sourceSnapshot.runtime?.context?.enrichedMessages)
      ? sourceSnapshot.runtime.context.enrichedMessages
      : [];
    const branchEnriched = sourceEnriched.filter(
      em => typeof em.turn !== 'number' || em.turn <= maxUserTurn
    );

    // Read the source session index record early so its metadata (title, etc.)
    // is available when building the branch record. Previously sourceRecord was
    // only assigned inside the updateSessionIndex callback, which ran AFTER the
    // branch record was constructed — so all sourceRecord fields were always null.
    let sourceRecord = null;
    try {
      const sourceIdx = await readSessionIndex(agentId);
      sourceRecord = sourceIdx.sessions.find(s => s.id === sourceSessionId) || null;
    } catch {}

    // Validate checkpoint integrity: warn if user turns lack matching checkpoints.
    const branchUserTurns = branchMessages
      .filter(m => m.role === 'user' && typeof m.turn === 'number')
      .map(m => m.turn);
    const branchCpIndices = branchCheckpoints.map(cp => cp.callIndex);
    const missingCheckpoints = branchUserTurns.filter(t => !branchCpIndices.includes(t));
    if (missingCheckpoints.length > 0) {
      console.warn(`[ProtoClaw] Branch from ${sourceSessionId}: user turns [${branchUserTurns.join(',')}] have missing checkpoints for turns [${missingCheckpoints.join(',')}]. Rollback will be unavailable for those turns.`);
    }

    const newSessionId = `session-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const createdAt = new Date().toISOString();

    const branchSnapshot = {
      ...sourceSnapshot,
      sessionId: newSessionId,
      savedAt: Date.now(),
      runtime: {
        ...(sourceSnapshot.runtime || {}),
        initialized: true,
        callIndex: maxUserTurn,
        context: {
          ...(sourceSnapshot.runtime?.context || {}),
          messages: branchMessages,
          enrichedMessages: branchEnriched,
        },
      },
      rollbackHistory: branchCheckpoints,
    };
    delete branchSnapshot.title;

    const branchSessionPath = getPrebuiltSessionFilePath(agentId, newSessionId);
    await fs.writeFile(branchSessionPath, JSON.stringify(branchSnapshot, null, 2), 'utf8');

    const sourceTitle = sourceRecord?.title || '';
    const branchTitle = sourceTitle
      ? `${sourceTitle}（分支）`
      : `分支会话 · ${createdAt.replace(/[TZ]/g, ' ').trim()}`;

    const branchRecord = {
      id: newSessionId,
      title: branchTitle,
      featureName: sourceRecord?.featureName || '',
      agentName: sourceRecord?.agentName || '',
      taskTitle: sourceRecord?.taskTitle || '',
      taskType: sourceRecord?.taskType || '',
      goal: sourceRecord?.goal || '',
      constraints: sourceRecord?.constraints || '',
      expectedOutput: sourceRecord?.expectedOutput || '',
      targetFiles: sourceRecord?.targetFiles || '',
      referenceMaterials: sourceRecord?.referenceMaterials || '',
      formId: sourceRecord?.formId || '',
      openDirectory: sourceRecord?.openDirectory || '',
      sessionType: sourceRecord?.sessionType || 'main',
      metadata: {
        ...(sourceRecord?.metadata || {}),
        branchSourceSessionId: sourceSessionId,
        branchCutMsgIndexEnd: cutMsgIndexEnd,
      },
      createdAt,
      updatedAt: createdAt,
    };

    const nextIndex = await updateSessionIndex(agentId, (index) => {
      return {
        activeSessionId: newSessionId,
        sessions: [branchRecord, ...index.sessions.filter((s) => s.id !== newSessionId)],
      };
    });

    const agent = await requirePrebuiltAgentForRuntime(agentId);
    await startManagedAgent(agent, newSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, newSessionId);

    res.json({
      ok: true,
      newSessionId,
      branchTitle,
      keptMessages: branchMessages.length,
      totalMessages: rawMessages.length,
      agent: connected,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/session_summary', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    const sessionId = req.query.sessionId;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const handoff = await findSessionSummary(agentId, sessionId);
    if (!handoff) {
      res.status(404).json({ error: 'No summary found for this session' });
      return;
    }
    res.json({
      sessionId,
      summaryText: handoff.sourceSummary || handoff.summaryArtifact?.summaryText || '',
      sessionTitle: handoff.compactOutput?.sessionTitle || '',
      importantFiles: handoff.compactOutput?.importantFiles || [],
      importantSkills: handoff.compactOutput?.importantSkills || [],
      createdAt: handoff.createdAt || null,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/session_generate_summary', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const force = !!req.body?.force;
    const existingSummary = await findSessionSummary(agentId, sessionId);
    if (existingSummary && !force) {
      res.json({ ok: true, alreadyExists: true });
      return;
    }
    if (existingSummary && force) {
      try {
        const handoffPath = await findSessionSummaryPath(agentId, sessionId);
        if (handoffPath) await fs.unlink(handoffPath).catch(() => {});
      } catch {}
    }
    const agentDir = path.join('prebuilt-agents', 'official', agentId);
    const resultPath = path.join(os.tmpdir(), `compact-mirror-${Date.now()}.json`);

    // Resolve sessionType from the workspace session index first; session files may not carry the product-level type.
    const sessionType = await resolvePrebuiltSessionType(agentId, sessionId);

    const args = [
      path.join(__dirname, 'scripts', 'run-compact-mirror.js'),
      agentDir,
      agentId,
      sessionId,
      JSON.stringify({ sessionType, maxAttempts: 1 }),
      resultPath,
    ];
    const output = await new Promise((resolve, reject) => {
      const child = spawn('node', args, { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutMs = 120000;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Compact mirror timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) reject(new Error(stderr || stdout || `compact mirror exited with code ${code}`));
        else resolve(stdout);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    console.log('[generate_summary] compact mirror output:', output?.slice(0, 200));
    const result = await fs.readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null);
    if (!result?.ok || !result.summaryText) {
      res.status(500).json({ error: 'Compact mirror did not produce a valid summary' });
      return;
    }
    await exportProvidedSummaryHandoff({
      preferredAgentId: agentId,
      sessionId,
      summaryText: result.summaryText,
      rawResponse: result.rawResponse || '',
      importantFiles: result.importantFiles || [],
      importantSkills: result.importantSkills || [],
      sessionTitle: result.sessionTitle || '',
    });
    try { await fs.unlink(resultPath); } catch {}
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/workspace_state', async (req, res, next) => {
  try {
    if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    res.json(await readWorkspaceState(req.query.agentId));
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/workspace_artifacts', async (req, res, next) => {
  try {
    if (typeof req.query.agentId !== 'string' || !req.query.agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    res.json(await listWorkspaceArtifacts(req.query.agentId));
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/workspace_state', express.json(), async (req, res, next) => {
  try {
    if (typeof req.body?.agentId !== 'string' || !req.body.agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    const state = await writeWorkspaceState(req.body.agentId, req.body.state || {});
    res.json(state);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/project_docset/import_materials', express.json({ limit: '20mb' }), async (req, res, next) => {
  try {
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
    const projectDir = typeof req.body?.projectDir === 'string' ? req.body.projectDir.trim() : '';
    const materials = Array.isArray(req.body?.materials) ? req.body.materials : [];

    if (!agentId) {
      res.status(400).json({ error: 'agentId is required' });
      return;
    }
    if (!projectDir) {
      res.status(400).json({ error: 'projectDir is required' });
      return;
    }
    if (materials.length === 0) {
      res.status(400).json({ error: 'materials are required' });
      return;
    }

    await ensureProjectDocset(projectDir, {});
    const materialsDir = getProjectDocsetMaterialsDir(projectDir);
    const imported = [];

    for (const material of materials) {
      const sourcePath = typeof material?.sourcePath === 'string' ? material.sourcePath.trim() : '';
      const sourceKind = material?.sourceKind === 'directory' ? 'directory' : 'file';
      const name = typeof material?.name === 'string' && material.name.trim()
        ? material.name.trim()
        : (sourcePath ? path.basename(sourcePath) : '');
      if (!name || !sourcePath) continue;

      const timestamp = new Date().toISOString();
      const title = `导入资料 · ${name}`;
      const id = buildProjectDocsetMarkdownId(title, timestamp, 'material');
      const body = [
        `# ${title}`,
        '',
        `- Source Kind: ${sourceKind}`,
        `- Source Path: ${sourcePath}`,
        `- Imported At: ${timestamp}`,
        '',
        '> 这是路径引用资料，项目文档集只保存来源路径，不复制原始内容。',
      ].join('\n');
      const filePath = path.join(materialsDir, `${id}.md`);
      await fs.writeFile(filePath, body, 'utf8');
      imported.push({ id, title, path: filePath });
    }

    res.json({ ok: true, count: imported.length, items: imported });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/qqbot_config', async (_req, res, next) => {
  try {
    const config = await readProjectQQBotConfig();
    res.json({
      config,
      configured: !!(config.appId && config.clientSecret),
      sourcePath: PROJECT_QQBOT_CONFIG_PATH,
    });
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/qqbot_config', express.json(), async (req, res, next) => {
  try {
    const config = await writeProjectQQBotConfig(req.body || {});
    res.json({
      config,
      configured: !!(config.appId && config.clientSecret),
      sourcePath: PROJECT_QQBOT_CONFIG_PATH,
      savedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/im_workspace_bundle', async (_req, res, next) => {
  try {
    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json(bundle);
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/im_workspace_bundle', express.json(), async (req, res, next) => {
  try {
    const prevConfig = await readProjectIMWorkspaceConfig();
    const workspaceConfig = await writeProjectIMWorkspaceConfig(req.body?.workspaceConfig || {});
    const qqConfig = await writeProjectQQBotConfig(req.body?.qqConfig || {});

    const newChannel = workspaceConfig.selectedChannel || 'qq';
    const channelChanged = newChannel !== (prevConfig.selectedChannel || 'qq');
    let portalRestarted = false;

    // Enforce three-way exclusivity: if portal's new channel conflicts with a line, clear that line
    if (channelChanged && newChannel) {
      let conflicted = false;
      for (const line of (workspaceConfig.lines || [])) {
        if (line.carrier === newChannel) {
          line.carrier = '';
          line.boundSession = null;
          conflicted = true;
        }
      }
      if (conflicted) {
        await writeProjectIMWorkspaceConfig(workspaceConfig);
      }
    }

    if (channelChanged) {
      const runtimes = listAgentRuntimes('qqbot');
      const running = runtimes.filter((rt) => rt?.process && rt.process.exitCode === null && !rt.stopped);
      if (running.length > 0) {
        await stopManagedAgent('qqbot');
        for (const rt of running) {
          await waitForProcessExit(rt.process);
        }
        try {
          const agent = await requireAgentLight('qqbot');
          await startManagedAgent(agent);
          portalRestarted = true;
          console.log(`[ProtoClaw IM] 渠道切换: ${prevConfig.selectedChannel || 'qq'} → ${newChannel}，门户代理已重启`);
        } catch (restartErr) {
          console.error('[ProtoClaw IM] 门户代理重启失败:', restartErr);
        }
      }
    }

    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({
      ...bundle,
      workspaceConfig,
      qqConfig,
      savedAt: new Date().toISOString(),
      portalRestarted,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/im_workspace_bundle/weixin_bind/start', async (_req, res, next) => {
  try {
    const binding = await startWeixinBinding('qqbot');
    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({
      ...bundle,
      binding,
      savedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/protoclaw/im_workspace_bundle/weixin_bind/status', async (_req, res, next) => {
  try {
    const binding = await refreshWeixinBinding('qqbot');
    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({
      ...bundle,
      binding,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/im_workspace_bundle/weixin_logout', async (_req, res, next) => {
  try {
    const binding = await clearWeixinBinding('qqbot');
    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({
      ...bundle,
      binding,
      savedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// ── IM Line Transfer ─────────────────────────────────────────────────────
//
// A "line" (通道) binds to a carrier (渠道: qq/weixin) and optionally to
// a target agent session.  The portal agent (receptionist) has its own
// carrier binding via `selectedChannel`; these endpoints manage the
// additional logical lines.

function findLine(config, lineId) {
  return (config.lines || []).find(l => l.id === lineId) || null;
}

/**
 * Send an IPC message to a running managed session's child process.
 * Used for dynamic carrier feature mounting without restart.
 */
function sendIPCtoSession(targetAgentId, targetSessionId, message) {
  const runtime = getAgentRuntime(targetAgentId, targetSessionId);
  if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
    console.warn(`[ProtoClaw IPC] Target ${targetAgentId}::${targetSessionId} not running`);
    return false;
  }
  try {
    runtime.process.send(message);
    console.log(`[ProtoClaw IPC] Sent to ${targetAgentId}::${targetSessionId}:`, JSON.stringify(message));
    return true;
  } catch (err) {
    console.error(`[ProtoClaw IPC] Failed to send to ${targetAgentId}::${targetSessionId}:`, err);
    return false;
  }
}

// ── IM Line Binding ────────────────────────────────────────────────────
//
// When a line is connected to a session, that session's runtime mounts the
// carrier feature directly. The binding query endpoint lets run-prebuilt-agent.js
// discover at startup whether it should mount a carrier feature.

app.get('/protoclaw/im_line_binding', async (req, res) => {
  const { agentId: qAgentId, sessionId: qSessionId } = req.query || {};
  if (!qAgentId || !qSessionId) {
    return res.json({ carrier: null });
  }
  try {
    const config = await readProjectIMWorkspaceConfig();
    const match = (config.lines || []).find(
      l => l.carrier && l.boundSession && l.boundSession.agentId === qAgentId && l.boundSession.sessionId === qSessionId
    );
    if (match) {
      const rt = getAgentRuntime(qAgentId, qSessionId);
      if (!rt?.process || rt.process.exitCode !== null || rt.stopped) {
        res.json({ carrier: null });
        return;
      }
    }
    res.json(match ? { carrier: match.carrier, lineId: match.id } : { carrier: null });
  } catch {
    res.json({ carrier: null });
  }
});

app.post('/protoclaw/im_line_transfer', express.json(), async (req, res, next) => {
  try {
    const { lineId, carrier, agentId, sessionId } = req.body || {};
    if (!lineId) {
      return res.status(400).json({ error: 'lineId is required' });
    }

    // Validate runtime BEFORE mutating config (fail fast, outside serializer)
    if (carrier && agentId && sessionId) {
      const runtime = getAgentRuntime(agentId, sessionId);
      if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
        return res.status(409).json({ error: 'Target runtime is not running' });
      }
    }

    // Serialized read-modify-write: prevents concurrent transfers (or
    // concurrent bundle reads that prune stale bindings) from interleaving
    // their file writes and silently overwriting each other's results.
    let prevBinding = null;
    await withIMWorkspaceConfig((config) => {
      const line = findLine(config, lineId);
      if (!line) {
        throw new Error(`Unknown line: ${lineId}`);
      }

      prevBinding = line.boundSession ? { ...line.boundSession } : null;

      // If clearing the line (no carrier)
      if (!carrier) {
        line.carrier = '';
        line.boundSession = null;
        return true;
      }

      if (agentId && sessionId) {
        line.carrier = carrier;
        line.boundSession = { agentId, sessionId };
      } else {
        line.carrier = carrier;
        line.boundSession = null;
      }

      // Enforce three-way exclusivity: clear conflicting entities
      for (const otherLine of (config.lines || [])) {
        if (otherLine.id !== lineId && otherLine.carrier === carrier) {
          otherLine.carrier = '';
          otherLine.boundSession = null;
        }
      }
      if (config.selectedChannel === carrier) {
        const available = ['qq', 'weixin'].find(c =>
          c !== carrier && !(config.lines || []).some(l => l.carrier === c)
        );
        config.selectedChannel = available || '';
      }

      return true;
    });

    // After config write: handle IPC side-effects
    // Unmount from the OLD session (if different from new)
    if (prevBinding?.agentId && prevBinding?.sessionId) {
      const isSameSession = (agentId && sessionId
        && prevBinding.agentId === agentId && prevBinding.sessionId === sessionId);
      if (!isSameSession) {
        sendIPCtoSession(prevBinding.agentId, prevBinding.sessionId, { type: 'unmount-im-carrier' });
      }
    }

    // Dynamically mount carrier on the TARGET session via IPC (no restart)
    if (carrier && agentId && sessionId) {
      const mountOK = sendIPCtoSession(agentId, sessionId, { type: 'mount-im-carrier', carrier });
      if (!mountOK) {
        // Retry once after a short delay — the target runtime might still
        // be starting up and its IPC channel not yet ready.
        console.warn(`[ProtoClaw IM] IPC mount to ${agentId}::${sessionId} failed, retrying in 1.5s...`);
        setTimeout(() => {
          const retryOK = sendIPCtoSession(agentId, sessionId, { type: 'mount-im-carrier', carrier });
          if (!retryOK) {
            console.error(`[ProtoClaw IM] IPC mount retry also failed for ${agentId}::${sessionId}`);
          }
        }, 1500);
      }
    }

    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({ success: true, bundle });
  } catch (error) {
    if (error.message?.startsWith('Unknown line:')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

app.post('/protoclaw/im_line_disconnect', express.json(), async (req, res, next) => {
  try {
    const { lineId } = req.body || {};
    if (!lineId) {
      return res.status(400).json({ error: 'lineId is required' });
    }

    // Serialized read-modify-write
    let prevBinding = null;
    await withIMWorkspaceConfig((config) => {
      const line = findLine(config, lineId);
      if (!line) {
        throw new Error(`Unknown line: ${lineId}`);
      }

      prevBinding = line.boundSession || null;
      line.boundSession = null;
      return true;
    });

    // Notify the previously bound session to unmount its carrier via IPC
    if (prevBinding?.agentId && prevBinding?.sessionId) {
      try {
        sendIPCtoSession(prevBinding.agentId, prevBinding.sessionId, { type: 'unmount-im-carrier' });
      } catch (ipcErr) {
        console.error('[ProtoClaw IM] IPC unmount failed:', ipcErr);
      }
    }

    const bundle = await buildIMWorkspaceBundle('qqbot');
    res.json({ success: true, bundle });
  } catch (error) {
    if (error.message?.startsWith('Unknown line:')) {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  }
});

// ── IM Routable Targets ────────────────────────────────────────────────────
//
// Aggregated view for the operator feature: workspaces → projects → running
// sessions, plus current line bindings.

app.get('/protoclaw/im_routable_targets', async (_req, res, next) => {
  try {
    const [agents, imConfig] = await Promise.all([
      getAgentsLight(),
      readProjectIMWorkspaceConfig(),
    ]);

    // Build workspace → project → session tree
    const workspaces = [];
    for (const agent of agents) {
      const adapter = getProjectAdapter(agent.id);
      if (!adapter) continue;

      let projects;
      try {
        projects = await adapter.listProjects();
      } catch {
        projects = [];
      }
      if (!projects || projects.length === 0) continue;

      // Enrich each project with running sessions
      const runtimes = listAgentRuntimes(agent.id);
      const liveSessionKeys = new Set(
        runtimes
          .filter(rt => rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId)
          .map(rt => getManagedRuntimeKey(agent.id, rt.selectedSessionId))
      );

      // Batch-query ViewerWorker callActive + collect workdir for live runtimes.
      // The envelope-based getRuntimeExecutionState() only tracks the dispatch
      // path; normal messages (viewer-input, IM) bypass it entirely, so we must
      // ask the ViewerWorker for the real busy state.
      const callActiveMap = new Map();   // sessionId → boolean
      const workdirMap = new Map();      // sessionId → workdir string
      await Promise.all(
        runtimes
          .filter(rt => rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId)
          .map(async (rt) => {
            const sid = rt.selectedSessionId;
            if (rt.workspaceDir) {
              workdirMap.set(sid, rt.workspaceDir);
            }
            if (rt.viewerAgentId) {
              try {
                const notif = await readViewerJson(`/api/agents/${encodeURIComponent(rt.viewerAgentId)}/notification`);
                callActiveMap.set(sid, notif?.callActive === true);
              } catch {
                callActiveMap.set(sid, false);
              }
            } else {
              callActiveMap.set(sid, false);
            }
          })
      );

      // Get session metadata from the session index
      let sessionIndex;
      try {
        sessionIndex = await readSessionIndex(agent.id);
      } catch {
        sessionIndex = { sessions: [] };
      }
      const sessionMetaMap = new Map(
        (sessionIndex.sessions || []).map(s => [s.id, s])
      );

      // Resolve model info once per agent
      const agentModelInfo = await resolveSessionModelInfo(agent.id, 'default');

      for (const project of projects) {
        const projectSessionIds = project.sessionIds || [];
        const projectSessions = [];

        const buildSessionEntry = (sid) => {
          const meta = sessionMetaMap.get(sid);
          const tokenUsage = meta?.tokenUsage || null;
          const lastReq = tokenUsage?.lastRequestUsage || null;
          const contextTokens = lastReq?.totalTokens || lastReq?.inputTokens || null;
          const contextLength = agentModelInfo.contextLength || null;
          const contextUsagePct = (contextTokens && contextLength)
            ? Math.round(contextTokens / contextLength * 100) : null;
          // Execution state: ViewerWorker callActive is the primary signal;
          // envelope system (dispatch-only) supplements for queue length.
          const rtKey = getManagedRuntimeKey(agent.id, sid);
          const execState = getRuntimeExecutionState(rtKey);
          const callActive = callActiveMap.get(sid) ?? false;
          const savedAt = typeof meta?.savedAt === 'number' ? meta.savedAt : null;
          const sessionWorkdir = workdirMap.get(sid)
            || (typeof meta?.openDirectory === 'string' ? meta.openDirectory.trim() : '')
            || null;
          const realExecStatus = callActive ? 'running'
            : (execState.queueLength > 0 ? 'queued' : execState.status);
          return {
            id: sid,
            title: meta?.title || sid,
            running: true,
            modelName: agentModelInfo.modelName || '',
            contextLength,
            compressRatio: agentModelInfo.compressRatio || 80,
            messageCount: typeof meta?.messageCount === 'number' ? meta.messageCount : null,
            sessionType: meta?.sessionType || null,
            tokenUsage: tokenUsage ? {
              inputTokens: tokenUsage.inputTokens || 0,
              outputTokens: tokenUsage.outputTokens || 0,
              totalTokens: tokenUsage.totalTokens || 0,
            } : null,
            contextTokens,
            contextUsagePct,
            updatedAt: meta?.updatedAt || null,
            savedAt,
            workdir: sessionWorkdir,
            execStatus: realExecStatus,
            execQueueLength: execState.queueLength,
            execLastActiveAt: execState.lastActiveAt,
          };
        };

        if (projectSessionIds.length > 0) {
          for (const sid of projectSessionIds) {
            const key = getManagedRuntimeKey(agent.id, sid);
            if (liveSessionKeys.has(key)) {
              projectSessions.push(buildSessionEntry(sid));
            }
          }
        } else {
          // When project has no explicit sessionIds, associate all live runtimes
          for (const rt of runtimes) {
            if (rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId) {
              projectSessions.push(buildSessionEntry(rt.selectedSessionId));
            }
          }
        }
        project.runningSessions = projectSessions;
      }

      workspaces.push({
        agentId: agent.id,
        name: agent.name || agent.id,
        icon: agent.icon || null,
        projects,
      });
    }

    const activeWorkspaces = workspaces;

    // Build current lines snapshot
    const lines = await Promise.all((imConfig.lines || []).map(async l => {
      const bound = l.boundSession;
      let boundSessionInfo = null;
      if (bound?.agentId && bound?.sessionId) {
        try {
          const idx = readSessionIndexSync(bound.agentId);
          const match = (idx?.sessions || []).find(s => s.id === bound.sessionId);
          const sessionTitle = match?.title || bound.sessionId;
          const tokenUsage = match?.tokenUsage || null;
          const lastReq = tokenUsage?.lastRequestUsage || null;
          const boundModelInfo = await resolveSessionModelInfo(bound.agentId, 'default');
          const contextLength = boundModelInfo.contextLength || null;
          const contextTokens = lastReq?.totalTokens || lastReq?.inputTokens || null;
          const contextUsagePct = (contextTokens && contextLength)
            ? Math.round(contextTokens / contextLength * 100) : null;
          const boundRtKey = getManagedRuntimeKey(bound.agentId, bound.sessionId);
          const boundExecState = getRuntimeExecutionState(boundRtKey);
          const boundRuntime = getAgentRuntime(bound.agentId, bound.sessionId);
          let boundCallActive = false;
          if (boundRuntime?.viewerAgentId) {
            try {
              const boundNotif = await readViewerJson(`/api/agents/${encodeURIComponent(boundRuntime.viewerAgentId)}/notification`);
              boundCallActive = boundNotif?.callActive === true;
            } catch {}
          }
          const boundWorkdir = boundRuntime?.workspaceDir
            || (typeof match?.openDirectory === 'string' ? match.openDirectory.trim() : '')
            || null;
          const boundExecStatus = boundCallActive ? 'running'
            : (boundExecState.queueLength > 0 ? 'queued' : boundExecState.status);
          boundSessionInfo = {
            agentId: bound.agentId,
            sessionId: bound.sessionId,
            sessionTitle,
            modelName: boundModelInfo.modelName || '',
            contextLength,
            compressRatio: boundModelInfo.compressRatio || 80,
            contextTokens,
            contextUsagePct,
            workdir: boundWorkdir,
            execStatus: boundExecStatus,
            execQueueLength: boundExecState.queueLength,
            savedAt: typeof match?.savedAt === 'number' ? match.savedAt : null,
          };
        } catch {
          boundSessionInfo = { agentId: bound.agentId, sessionId: bound.sessionId, sessionTitle: bound.sessionId };
        }
      }
      return {
        id: l.id,
        name: l.name || l.id,
        carrier: l.carrier || null,
        boundSession: boundSessionInfo,
      };
    }));

    res.json({ workspaces: activeWorkspaces, lines });
  } catch (error) {
    next(error);
  }
});

function readSessionIndexSync(agentId) {
  const sessionDir = isWorkspaceSessionAgent(agentId)
    ? path.join(PREBUILT_WORKSPACES_ROOT, agentId, 'sessions')
    : path.join(PREBUILT_SESSIONS_ROOT, agentId);
  const indexPath = path.join(sessionDir, 'index.json');
  try {
    return JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return { sessions: [] };
  }
}

// ── Model Config ──────────────────────────────────────────────────────────────

async function resolveContextLength(agentId) {
  const info = await resolveSessionModelInfo(agentId, 'default');
  return info.contextLength;
}

async function resolveSessionModelInfo(agentId, sessionType) {
  const presets = flattenModelPresets(await readModelPresets());
  const config = await readModelConfig();
  const defaultContextLength = 200000;
  const role = sessionType === 'exploration' ? 'exploration' : sessionType === 'sub' ? 'sub' : 'default';

  let presetName = null;
  if (agentId) {
    try {
      const agentMeta = await readJson(path.join(__dirname, 'prebuilt-agents', 'official', agentId, 'metadata.json'));
      const mp = agentMeta?.modelPresets;
      if (mp && typeof mp === 'object') {
        presetName = mp[role] || mp.default || null;
      }
    } catch {}
  }

  if (!presetName && config.defaultModel?.model) {
    const dm = config.defaultModel;
    presetName = presets.find(p => p.model === dm.model && p.provider === (dm.provider || 'anthropic'))?.name || null;
  }

  if (presetName) {
    const preset = presets.find(p => p.name === presetName);
    if (preset) {
      const cl = Number.isFinite(preset.contextLength) && preset.contextLength > 0 ? preset.contextLength : null;
      const cr = Number.isFinite(preset.compressRatio) ? preset.compressRatio : 80;
      return {
        contextLength: cl,
        compressRatio: cr,
        modelName: preset.model || preset.name,
        presetName: preset.name,
      };
    }
  }

  for (const preset of presets) {
    if (Number.isFinite(preset.contextLength) && preset.contextLength > 0) {
      const cr = Number.isFinite(preset.compressRatio) ? preset.compressRatio : 80;
      return {
        contextLength: preset.contextLength,
        compressRatio: cr,
        modelName: preset.model || preset.name,
        presetName: preset.name,
      };
    }
  }
  return {
    contextLength: null,
    compressRatio: 80,
    modelName: config.defaultModel?.model || '',
    presetName: null,
  };
}

async function readModelConfig() {
  try {
    const data = await readJson(MODEL_CONFIG_PATH);
    return data && typeof data === 'object' ? data : { defaultModel: {}, agent: {} };
  } catch {
    return { defaultModel: {}, agent: {} };
  }
}

async function writeModelConfig(config) {
  await ensureDir(path.dirname(MODEL_CONFIG_PATH));
  await fs.writeFile(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

async function readModelPresetsFile() {
  try {
    return await readJson(MODEL_PRESETS_PATH);
  } catch {
    return null;
  }
}

function normalizeModelPresetsData(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      providers: Array.isArray(data.providers) ? data.providers.filter(item => item && typeof item === 'object') : [],
      presets: Array.isArray(data.presets) ? data.presets.filter(item => item && typeof item === 'object') : [],
    };
  }
  if (Array.isArray(data)) {
    return buildStructuredModelPresets(data);
  }
  return { providers: [], presets: [] };
}

function flattenModelPresets(data) {
  const normalized = normalizeModelPresetsData(data);
  const providersByName = new Map();
  normalized.providers.forEach((provider) => {
    const name = cleanSessionText(provider?.name);
    if (name) providersByName.set(name, provider);
  });
  return normalized.presets.map((preset, index) => {
    const protocol = cleanSessionText(preset?.protocol || preset?.provider) || 'anthropic';
    const providerName = cleanSessionText(preset?.providerName);
    const provider = providerName ? providersByName.get(providerName) : null;
    return {
      name: cleanSessionText(preset?.name) || cleanSessionText(preset?.model) || `Preset ${index + 1}`,
      provider: protocol,
      providerName,
      model: cleanSessionText(preset?.model),
      baseUrl: cleanSessionText(provider?.endpoints?.[protocol] || preset?.baseUrl),
      apiKey: cleanSessionText(provider?.apiKey || preset?.apiKey),
      apiSurface: cleanSessionText(preset?.apiSurface) || 'chat',
      thinkingBudgetTokens: Number.isFinite(Number(preset?.thinkingBudgetTokens)) ? Number(preset.thinkingBudgetTokens) : null,
      maxTokens: Number.isFinite(Number(preset?.maxTokens)) ? Number(preset.maxTokens) : null,
      temperature: Number.isFinite(Number(preset?.temperature)) ? Number(preset.temperature) : null,
      contextLength: Number.isFinite(Number(preset?.contextLength)) ? Number(preset.contextLength) : null,
      compressRatio: Number.isFinite(Number(preset?.compressRatio)) ? Math.max(1, Math.min(100, Number(preset.compressRatio))) : 80,
      countTokenPath: cleanSessionText(preset?.countTokenPath) || null,
      customHeaders: Array.isArray(preset?.customHeaders) ? preset.customHeaders.filter(h => h && typeof h === 'object') : [],
    };
  });
}

function makeUniqueProviderName(baseName, usedNames) {
  const fallback = cleanSessionText(baseName) || 'Provider';
  let candidate = fallback;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${fallback} ${counter}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function buildStructuredModelPresets(flatPresets, existingData = null) {
  const normalizedExisting = normalizeModelPresetsData(existingData);
  const existingProvidersByName = new Map();
  const existingProviderNameBySignature = new Map();
  normalizedExisting.providers.forEach((provider) => {
    const name = cleanSessionText(provider?.name);
    if (!name) return;
    existingProvidersByName.set(name, provider);
    const endpoints = provider?.endpoints && typeof provider.endpoints === 'object' ? provider.endpoints : {};
    Object.entries(endpoints).forEach(([protocol, endpoint]) => {
      existingProviderNameBySignature.set(JSON.stringify([cleanSessionText(protocol), cleanSessionText(endpoint), cleanSessionText(provider?.apiKey)]), name);
    });
  });

  const providers = [];
  const presets = [];
  const providersBySignature = new Map();
  const usedNames = new Set();

  flatPresets.forEach((rawPreset, index) => {
    if (!rawPreset || typeof rawPreset !== 'object') return;
    const protocol = cleanSessionText(rawPreset.provider) || 'anthropic';
    const name = cleanSessionText(rawPreset.name) || cleanSessionText(rawPreset.model) || `Preset ${index + 1}`;
    const model = cleanSessionText(rawPreset.model);
    const baseUrl = cleanSessionText(rawPreset.baseUrl);
    const apiKey = cleanSessionText(rawPreset.apiKey);
    const signature = JSON.stringify([protocol, baseUrl, apiKey]);

    let providerName = providersBySignature.get(signature);
    if (!providerName) {
      const requestedName = cleanSessionText(rawPreset.providerName);
      const existingProvider = requestedName ? existingProvidersByName.get(requestedName) : null;
      const existingSignature = existingProvider
        ? JSON.stringify([protocol, cleanSessionText(existingProvider?.endpoints?.[protocol]), cleanSessionText(existingProvider?.apiKey)])
        : '';
      if (requestedName && existingSignature === signature && !usedNames.has(requestedName)) {
        providerName = requestedName;
        usedNames.add(providerName);
      } else {
        providerName = existingProviderNameBySignature.get(signature) || makeUniqueProviderName(requestedName || name, usedNames);
        usedNames.add(providerName);
      }
      providersBySignature.set(signature, providerName);
      const providerRecord = {
        name: providerName,
        apiKey,
        endpoints: {},
      };
      if (baseUrl) providerRecord.endpoints[protocol] = baseUrl;
      providers.push(providerRecord);
    }

    const presetRecord = {
      name,
      providerName,
      protocol,
      apiSurface: cleanSessionText(rawPreset.apiSurface) || 'chat',
      model,
      thinkingBudgetTokens: Number.isFinite(Number(rawPreset.thinkingBudgetTokens)) ? Number(rawPreset.thinkingBudgetTokens) : null,
      maxTokens: Number.isFinite(Number(rawPreset.maxTokens)) ? Number(rawPreset.maxTokens) : null,
      temperature: Number.isFinite(Number(rawPreset.temperature)) ? Number(rawPreset.temperature) : null,
      contextLength: Number.isFinite(Number(rawPreset.contextLength)) ? Number(rawPreset.contextLength) : null,
      compressRatio: Number.isFinite(Number(rawPreset.compressRatio)) ? Math.max(1, Math.min(100, Number(rawPreset.compressRatio))) : 80,
      countTokenPath: cleanSessionText(rawPreset.countTokenPath) || null,
      customHeaders: Array.isArray(rawPreset.customHeaders) ? rawPreset.customHeaders.filter(h => h && typeof h === 'object') : [],
    };
    presets.push(presetRecord);
  });

  return { providers, presets };
}

async function readModelPresets() {
  const data = await readModelPresetsFile();
  return normalizeModelPresetsData(data);
}

async function writeModelPresetsFile(presetsOrFile) {
  await ensureDir(path.dirname(MODEL_PRESETS_PATH));
  await fs.writeFile(MODEL_PRESETS_PATH, JSON.stringify(presetsOrFile, null, 2), 'utf8');
  return presetsOrFile;
}

async function writeModelPresets(flatPresets) {
  const existingData = await readModelPresetsFile();
  const nextData = buildStructuredModelPresets(Array.isArray(flatPresets) ? flatPresets : [], existingData);
  await writeModelPresetsFile(nextData);
  return flattenModelPresets(nextData);
}

app.post('/protoclaw/shutdown', async (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => void shutdown(0), 200);
});

app.get('/protoclaw/model_config', async (_req, res, next) => {
  try {
    const config = await readModelConfig();
    const presets = flattenModelPresets(await readModelPresets());
    res.json({ config, presets, configPath: MODEL_CONFIG_PATH });
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/model_config', express.json(), async (req, res, next) => {
  try {
    const { config, presets } = req.body || {};
    let savedConfig = null;
    let savedPresets = null;
    if (config && typeof config === 'object') {
      savedConfig = await writeModelConfig(config);
    }
    if (Array.isArray(presets)) {
      savedPresets = await writeModelPresets(presets);
    }
    res.json({
      config: savedConfig ?? await readModelConfig(),
      presets: savedPresets ?? flattenModelPresets(await readModelPresets()),
      configPath: MODEL_CONFIG_PATH,
      savedAt: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// ── Speech Model Config & ASR Proxy ────────────────────────────────────────

const DEFAULT_SPEECH_MODEL = {
  baseUrl: '',
  apiKey: '',
  model: 'mimo-v2.5-asr',
  language: 'auto',
};

function normalizeSpeechModel(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SPEECH_MODEL };
  return {
    baseUrl: cleanSessionText(raw.baseUrl) || '',
    apiKey: cleanSessionText(raw.apiKey) || '',
    model: cleanSessionText(raw.model) || DEFAULT_SPEECH_MODEL.model,
    language: cleanSessionText(raw.language) || DEFAULT_SPEECH_MODEL.language,
  };
}

async function readSpeechModelConfig() {
  const config = await readModelConfig();
  return normalizeSpeechModel(config.speechModel);
}

async function writeSpeechModelConfig(speechModel) {
  const config = await readModelConfig();
  config.speechModel = normalizeSpeechModel(speechModel);
  await writeModelConfig(config);
  return config.speechModel;
}

app.get('/protoclaw/speech_model_config', async (_req, res, next) => {
  try {
    const speechModel = await readSpeechModelConfig();
    res.json({ speechModel });
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/speech_model_config', express.json(), async (req, res, next) => {
  try {
    const { speechModel } = req.body || {};
    if (!speechModel || typeof speechModel !== 'object') {
      return res.status(400).json({ error: 'speechModel object is required' });
    }
    const saved = await writeSpeechModelConfig(speechModel);
    res.json({ speechModel: saved, savedAt: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

/**
 * Encode raw PCM samples as a WAV buffer (16kHz, 16-bit, mono).
 * Pure JS — no ffmpeg dependency. Ported from MiMo-Code voice.ts.
 */
function encodeWav(samples) {
  const sampleRate = 16000;
  // If Buffer, treat it as raw PCM16 bytes; otherwise treat as Int16Array of samples
  const isBuf = Buffer.isBuffer(samples);
  const dataSize = isBuf ? samples.length : (samples.length * 2);
  const buffer = Buffer.alloc(44 + dataSize);
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);           // chunk size
  buffer.writeUInt16LE(1, 20);            // PCM format
  buffer.writeUInt16LE(1, 22);            // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);            // block align
  buffer.writeUInt16LE(16, 34);           // bits per sample
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  if (isBuf) {
    samples.copy(buffer, 44);
  } else {
    const int16 = new Int16Array(buffer.buffer, buffer.byteOffset + 44, samples.length);
    int16.set(samples);
  }
  return buffer;
}

/**
 * Convert audio buffer to 16kHz mono PCM16 WAV via ffmpeg.
 * Returns null if ffmpeg is not available or conversion fails.
 */
function convertAudioToWav(inputBuffer) {
  return new Promise((resolve) => {
    const ffmpegArgs = ['-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'];
    const child = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.resume(); // drain stderr to prevent blocking

    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    child.stdin.write(inputBuffer);
    child.stdin.end();
  });
}

app.post('/protoclaw/speech_to_text', express.raw({ type: '*/*', limit: '20mb' }), async (req, res, next) => {
  try {
    const speechConfig = await readSpeechModelConfig();
    if (!speechConfig.apiKey || !speechConfig.baseUrl) {
      return res.status(400).json({ error: 'Speech model not configured. Set baseUrl and apiKey in Speech settings.' });
    }

    let audioBuffer = req.body;
    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(400).json({ error: 'No audio data received' });
    }

    // Detect MIME type from original content-type
    const contentType = req.headers['content-type'] || 'audio/wav';
    const isWebm = contentType.includes('webm');
    const isMp3 = contentType.includes('mp3') || contentType.includes('mpeg');
    const isWav = contentType.includes('wav') || (!isWebm && !isMp3);

    // Convert to WAV if needed: try ffmpeg first, fall back to raw PCM assumption
    if (!isWav) {
      const converted = await convertAudioToWav(audioBuffer);
      if (converted) {
        audioBuffer = converted;
      } else {
        console.warn('[ASR Proxy] ffmpeg conversion failed, attempting raw PCM encode');
        // As last resort, treat raw bytes as PCM16 samples and wrap with WAV header
        const pcmSamples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2);
        audioBuffer = encodeWav(pcmSamples);
      }
    }

    const audioBase64 = audioBuffer.toString('base64');
    const dataUri = `data:audio/wav;base64,${audioBase64}`;

    const asrUrl = speechConfig.baseUrl.replace(/\/+$/, '') + '/chat/completions';

    // Non-streaming request — ported from MiMo-Code transcribeAudio pattern
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const asrResp = await fetch(asrUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${speechConfig.apiKey}`,
        'api-key': speechConfig.apiKey,
      },
      body: JSON.stringify({
        model: speechConfig.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: dataUri },
              },
            ],
          },
        ],
        asr_options: { language: speechConfig.language || 'auto' },
      }),
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);

    if (!asrResp || !asrResp.ok) {
      const status = asrResp ? asrResp.status : 502;
      const errText = asrResp ? await asrResp.text().catch(() => '') : 'network error';
      return res.status(status).json({ error: `ASR request failed: ${status}`, detail: errText });
    }

    const data = await asrResp.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    res.json({ text });
  } catch (error) {
    next(error);
  }
});

// ── Token Count Refresh ────────────────────────────────────────────────────────

app.post('/protoclaw/refresh_session_token_count', express.json(), async (req, res, next) => {
  try {
    const { sessionId, agentId } = req.body || {};
    if (!sessionId || !agentId) {
      return res.status(400).json({ success: false, error: 'Missing sessionId or agentId' });
    }

    // 读取会话索引
    const index = await readSessionIndex(agentId);
    const sessionRecord = index.sessions.find(s => s.id === sessionId);
    if (!sessionRecord) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    // 复用 resolveSessionModelInfo 获取模型预设信息
    const modelInfo = await resolveSessionModelInfo(agentId, 'default');
    const presetName = modelInfo.presetName;
    const modelName = modelInfo.modelName;

    if (!presetName || !modelName) {
      return res.status(400).json({
        success: false,
        error: `Cannot determine model preset for agent ${agentId}`,
      });
    }

    // 读取模型预设配置（含 providers 和 countTokenPath）
    const presetsData = await readModelPresets();
    const preset = presetsData.presets.find(p => p.name === presetName);

    if (!preset) {
      return res.status(404).json({ success: false, error: `Model preset not found: ${presetName}` });
    }

    const countTokenPath = preset.countTokenPath || '/v1/messages/count_tokens';

    // 获取 provider 信息
    const provider = presetsData.providers.find(p => p.name === preset.providerName);
    if (!provider) {
      return res.status(404).json({ success: false, error: `Provider not found: ${preset.providerName}` });
    }

    const baseUrl = provider.endpoints?.[preset.protocol] || '';
    if (!baseUrl) {
      return res.status(400).json({ success: false, error: 'Provider base URL not configured' });
    }

    // 构建 count tokens API URL
    const countTokensUrl = baseUrl.replace(/\/+$/, '') + countTokenPath;

    // 读取会话文件中的实际消息
    const sessionPath = path.join(getPrebuiltAgentSessionDir(agentId), `${sanitizeSessionFragment(sessionId)}.json`);
    let sessionData = {};
    let actualMessages = [];
    try {
      sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
      const rawMessages = sessionData?.runtime?.context?.messages || [];
      // count_tokens 接口只接受 user/assistant 角色
      // system 角色的内容合并到第一条 user 消息前
      // tool 角色映射为 user（tool_result 嵌入 user message）
      let systemParts = [];
      for (const m of rawMessages) {
        if (!m || m.content == null) continue;
        if (m.role === 'system') {
          systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
          continue;
        }
        let content;
        if (typeof m.content === 'string') {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          content = m.content.map(b => typeof b === 'string' ? b : (b?.text || JSON.stringify(b))).join('\n');
        } else {
          content = JSON.stringify(m.content);
        }
        // prepend system text to first user message
        let role = m.role;
        if (role === 'tool') role = 'user';
        if (role === 'user' && systemParts.length > 0) {
          content = systemParts.join('\n\n') + '\n\n' + content;
          systemParts = [];
        }
        actualMessages.push({ role, content });
      }
      // 如果只有 system 没有 user，补一条
      if (actualMessages.length === 0 && systemParts.length > 0) {
        actualMessages.push({ role: 'user', content: systemParts.join('\n\n') });
      }
    } catch {}

    // 如果没有消息，无法计数
    if (!actualMessages.length) {
      return res.status(400).json({
        success: false,
        error: '会话中没有可用的消息，无法计数',
      });
    }

    // 调用 count tokens API，使用实际消息
    try {
      const countRequest = {
        model: modelName,
        messages: actualMessages,
      };

      const response = await fetch(countTokensUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey,
        },
        body: JSON.stringify(countRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Count tokens API failed: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      const tokenCount = result.input_tokens || result.inputTokens;

      if (typeof tokenCount !== 'number' || tokenCount < 0) {
        return res.status(500).json({
          success: false,
          error: 'Count tokens API did not return a valid token count',
          details: result,
        });
      }

      // 写入路径须与 summarizePrebuiltSession 读取路径一致: runtime.usageStats.lastRequestUsage
      if (!sessionData.runtime) sessionData.runtime = {};
      if (!sessionData.runtime.usageStats) sessionData.runtime.usageStats = {};
      sessionData.runtime.usageStats.lastRequestUsage = {
        inputTokens: tokenCount,
        outputTokens: 0,
        totalTokens: tokenCount,
      };
      sessionData.modelName = modelName;
      sessionData.updatedAt = new Date().toISOString();

      await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));

      res.json({
        success: true,
        tokenCount,
      });
    } catch (fetchError) {
      return res.status(500).json({
        success: false,
        error: `Failed to call count tokens API: ${fetchError.message}`,
      });
    }
  } catch (error) {
    next(error);
  }
});

// ── Sessions ──────────────────────────────────────────────────────────────────

app.post('/protoclaw/prebuilt_sessions', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    const session = await createPrebuiltSession(agent.id, {
      returnSummary: false,
      sourceSessionId: req.body.sourceSessionId,
      formId: req.body.formId,
      featureName: req.body.featureName,
      agentName: req.body.agentName,
      openDirectory: req.body.openDirectory,
      targetDir: req.body.targetDir,
    });
    const status = await startManagedAgent(agent, session.id);
    res.json({ session, status, agent: null });
  } catch (error) {
    next(error);
  }
});

app.put('/protoclaw/prebuilt_sessions/:sessionId/title', express.json(), async (req, res, next) => {
  try {
    const { agentId, title } = req.body || {};
    const sessionId = req.params.sessionId;

    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId is required' });
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required and must be non-empty' });
    }

    await updateSessionIndex(agentId, (index) => {
      const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex === -1) {
        throw Object.assign(new Error('Session not found'), { statusCode: 404 });
      }
      index.sessions[sessionIndex].title = title.trim();
      index.sessions[sessionIndex].updatedAt = new Date().toISOString();
      return index;
    });

    res.json({ ok: true, sessionId, title: title.trim() });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/generate_session_title', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      return res.status(400).json({ error: 'agentId and sessionId are required' });
    }

    const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, agentId);
    if (!ownerAgentId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    const agentRelativeDir = agent.relativeDir;
    if (!agentRelativeDir) {
      return res.status(500).json({ error: 'Agent directory not resolved' });
    }

    const titleMirrorScript = path.join(__dirname, 'scripts', 'run-title-mirror.js');
    const resultDir = path.join(os.tmpdir(), `title-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const resultPath = path.join(resultDir, 'result.json');
    await fs.mkdir(resultDir, { recursive: true });

    const child = spawn(process.execPath, [titleMirrorScript, agentRelativeDir, ownerAgentId, sessionId, JSON.stringify({ maxAttempts: 1 }), resultPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    let stderr = '';
    const timeoutMs = 120000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[title-mirror] ${line.trimEnd()}`);
      }
    });

    await new Promise((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Title generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `run-title-mirror exited with code ${code}`));
          return;
        }
        resolve();
      });
    });

    const raw = await fs.readFile(resultPath, 'utf8');
    const result = JSON.parse(raw.trim());
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => {});

    const title = typeof result?.title === 'string' ? result.title.trim() : '';
    if (!title) {
      return res.status(500).json({ error: 'Title generation returned empty result' });
    }

    await updateSessionIndex(ownerAgentId, (index) => {
      const sessionIndex = index.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        index.sessions[sessionIndex].title = title;
        index.sessions[sessionIndex].updatedAt = new Date().toISOString();
      }
      return index;
    });

    res.json({ ok: true, sessionId, title });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/generate_recap', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      return res.status(400).json({ error: 'agentId and sessionId are required' });
    }

    const ownerAgentId = await resolvePrebuiltSessionOwner(sessionId, agentId);
    if (!ownerAgentId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const agent = await requirePrebuiltAgentForRuntime(ownerAgentId);
    const agentRelativeDir = agent.relativeDir;
    if (!agentRelativeDir) {
      return res.status(500).json({ error: 'Agent directory not resolved' });
    }

    const recapMirrorScript = path.join(__dirname, 'scripts', 'run-recap-mirror.js');
    const resultDir = path.join(os.tmpdir(), `recap-mirror-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const resultPath = path.join(resultDir, 'result.json');
    await fs.mkdir(resultDir, { recursive: true });

    const child = spawn(process.execPath, [recapMirrorScript, agentRelativeDir, ownerAgentId, sessionId, JSON.stringify({ maxAttempts: 1 }), resultPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    let stderr = '';
    const timeoutMs = 120000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.split('\n')) {
        if (line.trim()) console.log(`[recap-mirror] ${line.trimEnd()}`);
      }
    });

    await new Promise((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Recap generation timed out after ${timeoutMs}ms${stderr.trim() ? `\n${stderr.trim()}` : ''}`));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `run-recap-mirror exited with code ${code}`));
          return;
        }
        resolve();
      });
    });

    const raw = await fs.readFile(resultPath, 'utf8');
    const result = JSON.parse(raw.trim());
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => {});

    const recap = typeof result?.recap === 'string' ? result.recap.trim() : '';
    if (!recap) {
      return res.status(500).json({ error: 'Recap generation returned empty result' });
    }

    res.json({ ok: true, sessionId, recap });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/export', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const result = await exportContextHandoffForSession(sessionId, preferredAgentId, req.body?.policy || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/compacted_resume', express.json(), async (req, res, next) => {
  try {
    const handoffId = cleanSessionText(req.body?.handoffId);
    const handoffPath = cleanSessionText(req.body?.handoffPath);
    if (!handoffId && !handoffPath) {
      res.status(400).json({ error: 'handoffId or handoffPath is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const result = await createCompactedResumeFromHandoff({
      preferredAgentId,
      handoffId,
      handoffPath,
      goal: cleanSessionText(req.body?.goal),
      startRuntime: req.body?.startRuntime !== false,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function lockExplorationSession(agentId, sessionId, goal, response) {
  try {
    await updateSessionIndex(agentId, (index) => {
      const record = index.sessions.find(s => s.id === sessionId);
      if (!record) return index;
      record.sessionType = 'exploration';
      record.status = 'locked';
      record.lockedAt = new Date().toISOString();
      if (goal) record.goal = goal;
      record.domains = extractDomainsFromText(response || goal || '');
      record.updatedAt = new Date().toISOString();
      return { ...index };
    });
    console.log(`[lockExploration] Locked session=${sessionId} domains=${record.domains?.join(',') || '(none)'}`);
  } catch (err) {
    console.error(`[lockExploration] Failed for session=${sessionId}:`, err.message);
  }
}

function extractDomainsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const techPatterns = [
    /\b(Flow|Feature|Hook|ToolRegistry|Node|Edge|Workflow|Assembly|Session|Workspace|Runtime|Context|Prompt|Compaction|Mirror|Handoff|Seed|Inspector|Editor|Surface|Block|State|Config|Form|Agent|Message|Chunk|Template|Variable|Skill|Tool|Permission)\b/gi,
  ];
  const found = new Set();
  for (const pattern of techPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const word = match[1];
      if (word.length >= 3) found.add(word);
    }
  }
  return [...found].slice(0, 8);
}

async function buildExplorationHandoffPayload(agentId, explorationIds, goal) {
  const handoffsDir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));

  // --- Phase 1: Read handoff files for 交接班信息 (sourceSummary + importantFiles/Skills) ---
  let handoffFiles = [];
  try {
    handoffFiles = (await fs.readdir(handoffsDir)).filter(f => f.startsWith('handoff-') && !f.startsWith('handoff-synthetic-') && f.endsWith('.json'));
  } catch {}

  const allImportantFiles = [];
  const allImportantSkills = [];
  const allFileRanges = {};
  const summaryParts = [];

  for (const expId of explorationIds) {
    let bestParsed = null;
    let bestCreatedAt = '';
    for (const fname of handoffFiles) {
      try {
        const raw = await fs.readFile(path.join(handoffsDir, fname), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sourceSessionId !== expId) continue;
        const ca = parsed.createdAt || '';
        if (ca > bestCreatedAt) {
          bestParsed = parsed;
          bestCreatedAt = ca;
        }
      } catch {}
    }
    if (bestParsed) {
      // sourceSummary (老版摘要) is part of 交接班信息
      const summary = bestParsed.sourceSummary || bestParsed.summaryText || '';
      if (summary) {
        summaryParts.push(`## 探索记录 ${expId}\n${summary}`);
      }
      if (Array.isArray(bestParsed.compactOutput?.importantFiles)) {
        allImportantFiles.push(...bestParsed.compactOutput.importantFiles);
      }
      if (Array.isArray(bestParsed.compactOutput?.importantSkills)) {
        allImportantSkills.push(...bestParsed.compactOutput.importantSkills);
      }
      if (bestParsed.compactOutput?.fileRanges && typeof bestParsed.compactOutput.fileRanges === 'object') {
        Object.assign(allFileRanges, bestParsed.compactOutput.fileRanges);
      }
    }
  }

  const combinedSummary = summaryParts.join('\n\n');

  // --- Phase 2: Read session files for full conversation history (全量历史) ---
  const sessionsDir = path.join(USER_DATA_ROOT, 'workspaces', sanitizeSessionFragment(agentId || 'programming-helper'), 'sessions');
  const allSeedMessages = [];

  for (const expId of explorationIds) {
    try {
      const sessionPath = path.join(sessionsDir, `${expId}.json`);
      const rawSession = await fs.readFile(sessionPath, 'utf8');
      const sessionData = JSON.parse(rawSession);
      const messages = sessionData?.runtime?.context?.messages;
      if (!Array.isArray(messages)) continue;

      // Include user, assistant, tool messages (skip system prompts — sub-agent has its own)
      const conversationMessages = messages
        .filter(m => m && m.role && m.role !== 'system' && (m.content || Array.isArray(m.toolCalls)))
        .map(m => {
          const msg = { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
          if (typeof m.turn === 'number') msg.turn = m.turn;
          if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) msg.toolCalls = m.toolCalls;
          if (m.toolCallId) msg.toolCallId = m.toolCallId;
          return msg;
        });

      if (conversationMessages.length > 0) {
        allSeedMessages.push(...conversationMessages);
      }
    } catch (err) {
      console.warn(`[buildExplorationHandoffPayload] Failed to read session ${expId}: ${err.message}`);
    }
  }

  return {
    packageId: `synthetic-exploration-${Date.now()}`,
    sourceSessionId: explorationIds[0] || 'unknown',
    sourceSummary: combinedSummary,
    seedMessages: allSeedMessages,
    mode: 'summary',
    stats: { synthetic: true },
    compactOutput: {
      importantFiles: [...new Set(allImportantFiles)],
      importantSkills: [...new Set(allImportantSkills)],
      fileRanges: allFileRanges,
    },
  };
}

async function writeSyntheticHandoff(agentId, payload) {
  const dir = path.join(USER_DATA_ROOT, 'context-handoffs', sanitizeSessionFragment(agentId || 'programming-helper'));
  await fs.mkdir(dir, { recursive: true });
  const fileName = `handoff-synthetic-${Date.now()}.json`;
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

app.post('/protoclaw/spawn_one_shot', express.json(), async (req, res, next) => {
  try {
    const handoffId = cleanSessionText(req.body?.handoffId);
    const handoffPath = cleanSessionText(req.body?.handoffPath);
    const goal = cleanSessionText(req.body?.goal);
    const timeoutMs = Number(req.body?.timeoutMs) || 300000;
    const explorationIds = Array.isArray(req.body?.explorationIds)
      ? req.body.explorationIds.map(id => cleanSessionText(id)).filter(Boolean)
      : [];

    if (!goal) {
      res.status(400).json({ error: 'goal is required for one-shot spawn' });
      return;
    }

    req.setTimeout(timeoutMs + 10000);

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const agentId = preferredAgentId || 'programming-helper';

    const isExploration = explorationIds.length === 0 && !handoffId && !handoffPath;
    const sessionType = isExploration ? 'exploration' : 'sub';

    let resolvedHandoffPath = null;
    let sourceSessionId = null;
    let handoff = null;

    if (isExploration) {
      sourceSessionId = `__protoclaw-exploration-${Date.now()}__`;
      console.log(`[spawn_one_shot] Exploration mode: no parent context`);
    } else {
      if (explorationIds.length > 0) {
        const handoffPayload = await buildExplorationHandoffPayload(agentId, explorationIds, goal);
        const syntheticPath = await writeSyntheticHandoff(agentId, handoffPayload);
        resolvedHandoffPath = syntheticPath;
        sourceSessionId = explorationIds[0];
        console.log(`[spawn_one_shot] Sub-agent mode: from explorations ${explorationIds.join(',')}`);
      } else {
        if (!handoffId && !handoffPath) {
          res.status(400).json({ error: 'handoffId, handoffPath, or explorationIds required' });
          return;
        }
        const handoffResult = await readHandoffPackage({
          userDataRoot: USER_DATA_ROOT,
          agentId: agentId || '',
          handoffId,
          handoffPath,
        });
        handoff = handoffResult.handoff;
        resolvedHandoffPath = handoffResult.handoffPath;
        const hSourceAgentId = cleanSessionText(handoff?.sourceAgentId);
        sourceSessionId = cleanSessionText(handoff?.sourceSessionId);
        if (!hSourceAgentId || !sourceSessionId) {
          res.status(400).json({ error: 'Invalid handoff: sourceAgentId/sourceSessionId required' });
          return;
        }
      }
    }

    const agent = await requirePrebuiltAgentForRuntime(agentId);
    if (!isExploration && !handoff?.stats?.synthetic && explorationIds.length === 0) {
      await requirePrebuiltSessionRecord(agent.id, sourceSessionId);
    }

    const session = await createPrebuiltSession(agent.id, {
      sourceSessionId,
      goal,
      sessionType,
      metadata: {
        resumeMode: 'one-shot',
        ...(isExploration ? {} : {
          handoffId: cleanSessionText(handoff?.handoffId) || cleanSessionText(handoffId),
          handoffPath: resolvedHandoffPath,
          handoffCreatedAt: cleanSessionText(handoff?.createdAt),
          handoffMode: cleanSessionText(handoff?.mode),
          sourceExplorationIds: explorationIds.length > 0 ? explorationIds : undefined,
        }),
      },
    });

    console.log(`[spawn_one_shot] Starting agent=${agent.id} session=${session.id} type=${sessionType} goal="${goal.slice(0, 80)}"`);

    const { exitCode, result } = await startOneShotAgent(agent, session.id, goal, {
      timeoutMs,
      extraEnv: {
        PROTOCLAW_SESSION_TYPE: sessionType,
        PROTOCLAW_MODEL_PRESET_ROLE: sessionType === 'exploration' ? 'exploration' : 'sub',
        ...(resolvedHandoffPath ? { PROTOCLAW_HANDOFF_PATH: resolvedHandoffPath } : {}),
      },
    });

    console.log(`[spawn_one_shot] Completed agent=${agent.id} session=${session.id} type=${sessionType} ok=${result.ok} duration=${result.durationMs}ms`);

    if (isExploration && result.ok) {
      await lockExplorationSession(agent.id, session.id, goal, result.response);
    }

    res.json({
      session: { id: session.id, title: session.title || null, sessionType },
      result: {
        ok: result.ok,
        response: result.response,
        error: result.error,
        durationMs: result.durationMs,
      },
      exitCode,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/resume_sub', express.json(), async (req, res, next) => {
  try {
    const subSessionId = cleanSessionText(req.body?.sessionId);
    const message = cleanSessionText(req.body?.message);
    const timeoutMs = Number(req.body?.timeoutMs) || 300000;

    if (!subSessionId || !message) {
      res.status(400).json({ error: 'sessionId and message are required' });
      return;
    }

    req.setTimeout(timeoutMs + 10000);

    const agentId = 'programming-helper';
    const agent = await requirePrebuiltAgentForRuntime(agentId);

    await updateSessionIndex(agentId, (index) => {
      const record = index.sessions.find(s => s.id === subSessionId);
      if (!record) {
        throw Object.assign(new Error(`Session ${subSessionId} not found`), { statusCode: 404 });
      }
      if (record.sessionType === 'exploration') {
        throw Object.assign(new Error('Cannot resume an exploration session (it is locked)'), { statusCode: 400 });
      }
      if (record.sessionType !== 'sub') {
        throw Object.assign(new Error(`Session ${subSessionId} is not a sub-agent session (type=${record.sessionType})`), { statusCode: 400 });
      }

      record.sessionType = 'sub';
      record.updatedAt = new Date().toISOString();
      return { ...index };
    });

    console.log(`[resume_sub] Resuming sub-agent session=${subSessionId} message="${message.slice(0, 80)}"`);

    const { exitCode, result } = await startOneShotAgent(agent, subSessionId, message, {
      timeoutMs,
      extraEnv: {
        PROTOCLAW_MODEL_PRESET_ROLE: 'sub',
      },
    });

    console.log(`[resume_sub] Completed session=${subSessionId} ok=${result.ok} duration=${result.durationMs}ms`);

    res.json({
      session: { id: subSessionId },
      result: {
        ok: result.ok,
        response: result.response,
        error: result.error,
        durationMs: result.durationMs,
      },
      exitCode,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/compact_and_resume', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const detached = req.body?.detached !== false;
    const policy = req.body?.policy || {};
    console.log(`[compact_and_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId} detached=${detached}`);

    if (detached) {
      const jobId = `compact-resume-${Date.now()}-${randomUUID().slice(0, 8)}`;
      setTimeout(() => {
        compactAndResumeCurrentSession({
          preferredAgentId,
          sessionId,
          policy,
          startRuntime: req.body?.startRuntime !== false,
        }).then((result) => {
          console.log(`[compact_and_resume] job ${jobId} completed for session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
        }).catch((error) => {
          console.error(`[compact_and_resume] job ${jobId} failed for session=${sessionId}:`, error);
        });
      }, 10);

      res.json({
        scheduled: true,
        jobId,
        sessionId,
        agentId: preferredAgentId || null,
      });
      return;
    }

    const result = await compactAndResumeCurrentSession({
      preferredAgentId,
      sessionId,
      policy,
      startRuntime: req.body?.startRuntime !== false,
    });
    console.log(`[compact_and_resume] completed session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/summary_resume', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    const summaryText = typeof req.body?.summaryText === 'string' ? req.body.summaryText.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (!summaryText) {
      res.status(400).json({ error: 'summaryText is required' });
      return;
    }

    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    console.log(`[summary_resume] requested agent=${preferredAgentId || '(auto)'} session=${sessionId}`);
    const result = await compactAndResumeFromProvidedSummary({
      preferredAgentId,
      sessionId,
      summaryText,
      rawResponse: typeof req.body?.rawResponse === 'string' ? req.body.rawResponse : '',
      importantFiles: Array.isArray(req.body?.importantFiles) ? req.body.importantFiles : [],
      importantSkills: Array.isArray(req.body?.importantSkills) ? req.body.importantSkills : [],
      sessionTitle: typeof req.body?.sessionTitle === 'string' ? req.body.sessionTitle : '',
      fileRanges: typeof req.body?.fileRanges === 'object' && req.body.fileRanges !== null ? req.body.fileRanges : {},
      policy: req.body?.policy || {},
      startRuntime: req.body?.startRuntime !== false,
    });
    console.log(`[summary_resume] completed session=${sessionId} newSession=${result?.session?.id || 'unknown'}`);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/context_handoffs/summary_export', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    const summaryText = typeof req.body?.summaryText === 'string' ? req.body.summaryText.trim() : '';
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    if (!summaryText) {
      res.status(400).json({ error: 'summaryText is required' });
      return;
    }
    const preferredAgentId = normalizeClientAgentId(req.body?.agentId);
    const result = await exportProvidedSummaryHandoff({
      preferredAgentId,
      sessionId,
      summaryText,
      rawResponse: typeof req.body?.rawResponse === 'string' ? req.body.rawResponse : '',
      importantFiles: Array.isArray(req.body?.importantFiles) ? req.body.importantFiles : [],
      importantSkills: Array.isArray(req.body?.importantSkills) ? req.body.importantSkills : [],
      sessionTitle: typeof req.body?.sessionTitle === 'string' ? req.body.sessionTitle : '',
      fileRanges: typeof req.body?.fileRanges === 'object' && req.body.fileRanges !== null ? req.body.fileRanges : {},
      policy: req.body?.policy || {},
      sessionTimestamp: typeof req.body?.sessionTimestamp === 'string' ? req.body.sessionTimestamp : null,
      gitMeta: req.body?.gitMeta && typeof req.body.gitMeta === 'object' ? req.body.gitMeta : null,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/assembly_environment/create', express.json(), async (req, res, next) => {
  try {
    const agentId = sanitizeSessionFragment(String(req.body?.agentId || 'agent-creator').trim());
    const assemblyName = sanitizeSessionFragment(String(req.body?.assemblyName || '').trim());
    const force = req.body?.force === true;
    const selectedFeatures = uniqueStrings(Array.isArray(req.body?.selectedFeatures)
      ? req.body.selectedFeatures.map((value) => String(value || '').trim()).filter(Boolean)
      : parseListField(req.body?.selectedFeatures));
    if (!assemblyName || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(assemblyName)) {
      res.status(400).json({ error: 'Invalid assembly name' });
      return;
    }
    const envDir = getAssemblyWorkspaceDir(assemblyName);
    const existed = existsSync(envDir);
    if (existed && !force) {
      res.status(409).json({
        error: 'Assembly environment already exists',
        code: 'ASSEMBLY_ENV_EXISTS',
        directory: envDir,
        existed: true,
      });
      return;
    }
    await ensureAssemblyWorkspaceBase(envDir, assemblyName);
    const installResult = await ensureAssemblyWorkspaceDependencies(envDir, selectedFeatures);
    const currentState = await readWorkspaceState(agentId).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    const assemblyForm = currentState?.forms?.['assembly-form'] || {};
    const assemblyConfigs = Array.isArray(currentState?.assemblyConfigs)
      ? currentState.assemblyConfigs.map((item) => {
          if (cleanSessionText(item?.id) !== assemblyName) {
            return item;
          }
          return {
            ...item,
            envDir,
            envConfiguredName: assemblyName,
            envConfiguredFeatures: selectedFeatures,
            envStatus: 'ready',
            envStatusMessage: existed ? 'Environment dependencies refreshed in the existing directory.' : 'Environment directory created and dependencies installed.',
            updatedAt: new Date().toISOString(),
          };
        })
      : [];
    await writeWorkspaceState(agentId, {
      forms: {
        ...currentState.forms,
        'assembly-form': {
          ...assemblyForm,
          assembly_name: assemblyName,
          env_created: '1',
          env_dir: envDir,
          env_configured_name: assemblyName,
          env_configured_features: selectedFeatures.join('\n'),
          env_status: 'ready',
          env_status_message: existed ? 'Environment dependencies refreshed in the existing directory.' : 'Environment directory created and dependencies installed.',
          target_dir: assemblyForm.target_dir || path.dirname(envDir),
        },
      },
      openDirectory: envDir,
      assemblyConfigs,
    });
    res.json({ directory: envDir, created: !existed, existed, installedPackages: installResult.installedPackages });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/assembly_runtime/start', express.json(), async (req, res, next) => {
  const _t0 = Date.now();
  try {
    const requestedSessionId = cleanSessionText(req.body?.sessionId);
    const requestedAgentId = normalizeClientAgentId(req.body?.agentId);
    const resolvedOwnerId = requestedSessionId
      ? (await resolvePrebuiltSessionOwner(requestedSessionId, requestedAgentId) || requestedAgentId || 'flow-workspace')
      : (requestedAgentId || 'flow-workspace');
    const agent = await requirePrebuiltAgentForRuntime(resolvedOwnerId);
    console.log(`[PERF] /assembly_runtime/start BEGIN agentId=${agent.id} sessionId=${requestedSessionId || '(new)'}`);
    const session = requestedSessionId
      ? await activatePrebuiltSession(agent.id, requestedSessionId)
      : await createPrebuiltSession(agent.id, {
          formId: 'assembly-form',
          agentName: req.body?.agentName,
          openDirectory: req.body?.openDirectory,
          targetDir: req.body?.targetDir,
        });
    console.log(`[PERF] /assembly_runtime/start session ready (${Date.now() - _t0}ms)`);
    const wsState = await readWorkspaceState(agent.id).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    await startAssemblyRuntime(session.id, agent.id, session, wsState);
    console.log(`[PERF] /assembly_runtime/start startAssemblyRuntime done (${Date.now() - _t0}ms)`);
    const connected = await waitForAssemblyRuntimeReady(session.id);
    console.log(`[PERF] /assembly_runtime/start waitForReady done (${Date.now() - _t0}ms)`);
    const latestSession = await summarizePrebuiltSession(agent.id, session);
    console.log(`[PERF] /assembly_runtime/start COMPLETE (${Date.now() - _t0}ms total)`);
    res.json({ session: latestSession, runtime: connected });
  } catch (error) {
    console.error(`[PERF] /assembly_runtime/start FAILED (${Date.now() - _t0}ms):`, error.message);
    next(error);
  }
});

app.post('/protoclaw/assembly_runtime/stop', express.json(), async (req, res, next) => {
  try {
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    res.json(await stopAssemblyRuntime(sessionId));
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/activate', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const session = await activatePrebuiltSession(agent.id, req.body.sessionId, { returnSummary: false });
    const status = await startManagedAgent(agent, session.id);
    res.json({ session, status, agent: null });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/delete', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    let assemblyRuntime = null;
    if (agent.id === 'agent-creator' || agent.id === 'flow-workspace') {
      assemblyRuntime = await stopAssemblyRuntime(req.body.sessionId);
    }
    const deleted = await deletePrebuiltSession(agent.id, req.body.sessionId);
    const runtime = getAgentRuntime(agent.id);
    const deletedRuntime = getAgentRuntime(agent.id, req.body.sessionId);
    const deletedWasActive = deletedRuntime?.selectedSessionId === req.body.sessionId;
    let connected = null;

    if (deletedRuntime?.process && deletedRuntime.process.exitCode === null && !deletedRuntime.stopped && deletedWasActive) {
      await stopManagedAgent(agent.id, req.body.sessionId);
    }

    res.json({
      deleted,
      agent: connected,
      assemblyRuntime,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/archive', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const archived = req.body.archived !== false;
    const result = await archivePrebuiltSession(agent.id, req.body.sessionId, archived);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_sessions/todo', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.sessionId !== 'string' || !req.body.sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const todo = req.body.todo !== false;
    const result = await tagPrebuiltSessionTodo(agent.id, req.body.sessionId, todo);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── Session meta sync: runtime child process pushes fresh metadata after save ──
app.post('/protoclaw/session_meta_sync', express.json(), async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.body?.agentId);
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'agentId and sessionId are required' });
      return;
    }
    const sessionPath = getPrebuiltSessionFilePath(agentId, sessionId);
    let stat;
    try {
      stat = await fs.stat(sessionPath);
    } catch {
      res.status(404).json({ error: 'session file not found' });
      return;
    }

    const messageCount = typeof req.body.messageCount === 'number' ? req.body.messageCount : 0;
    const preview = cleanSessionText(req.body.preview);
    const tokenUsage = req.body.tokenUsage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const savedAt = typeof req.body.savedAt === 'number' ? req.body.savedAt : stat.mtimeMs;

    await updateSessionIndex(agentId, (index) => {
      const sessions = index.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        return {
          ...s,
          fileMtimeMs: stat.mtimeMs,
          fileSize: stat.size,
          messageCount,
          preview,
          tokenUsage,
          savedAt,
          metaVersion: META_VERSION,
          updatedAt: new Date(savedAt).toISOString(),
          // Auto-clear todo when session is actively producing new data
          todo: false,
        };
      });
      return { ...index, sessions };
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/open', express.json(), async (req, res, next) => {
  try {
    const openDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!openDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    // Add to phProjects if not already there
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    // Set as active project
    nextState.openDirectory = openDirectory;
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true, state: nextState });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/switch', express.json(), async (req, res, next) => {
  try {
    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId.trim() : '';
    if (!projectId || !projectId.startsWith('dir:')) {
      return res.status(400).json({ error: 'Valid projectId (dir:...) is required' });
    }
    const openDirectory = projectId.slice(4);
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    // Ensure the project exists in phProjects
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    nextState.openDirectory = openDirectory;
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true, state: nextState });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/add', express.json(), async (req, res, next) => {
  try {
    const openDirectory = typeof req.body?.openDirectory === 'string' ? req.body.openDirectory.trim() : '';
    if (!openDirectory) {
      return res.status(400).json({ error: 'openDirectory is required' });
    }
    const timestamp = new Date().toISOString();
    const state = await readWorkspaceState('programming-helper');
    const nextState = upsertWorkspacePhProject(state, { openDirectory }, timestamp);
    await writeWorkspaceState('programming-helper', nextState);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/ph_project/open_in_explorer', express.json(), async (req, res, next) => {
  try {
    const dirPath = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!dirPath) {
      return res.status(400).json({ error: 'path is required' });
    }
    const { existsSync } = await import('fs');
    if (!existsSync(dirPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', dirPath], { stdio: 'ignore', detached: true }).unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [dirPath], { stdio: 'ignore', detached: true }).unref();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/prebuilt_project/delete', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    if (typeof req.body.projectId !== 'string' || !req.body.projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    const deleted = await deletePrebuiltProject(agent.id, req.body.projectId);
    const runtimesToStop = listAgentRuntimes(agent.id).filter((runtime) => deleted.deletedSessionIds.includes(runtime?.selectedSessionId));
    let connected = null;

    for (const runtime of runtimesToStop) {
      await stopManagedAgent(agent.id, runtime.selectedSessionId);
    }

    res.json({
      deleted,
      agent: connected,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/feature_repository/delete', express.json(), async (req, res, next) => {
  try {
    const packageId = String(req.body.packageId || '').trim();
    if (!packageId) {
      res.status(400).json({ error: 'packageId is required' });
      return;
    }

    const deleted = await deleteFeaturePackage(packageId);
    res.json({ deleted });
  } catch (error) {
    next(error);
  }
});

const uploadsDir = path.join(USER_DATA_ROOT, 'uploads');
await ensureDir(uploadsDir);
const upload = multer({ dest: uploadsDir });

app.post('/protoclaw/feature_repository/parse_upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const tempPath = req.file.path;
    const originalName = path.basename(req.file.originalname || '');
    if (!originalName.toLowerCase().endsWith('.tgz')) {
      await fs.unlink(tempPath).catch(() => {});
      res.status(400).json({ error: 'Only .tgz files are allowed' });
      return;
    }

    const uploadId = randomUUID();
    const summary = await summarizeFeatureArchive(tempPath, originalName, 'custom');
    pendingFeatureImports.set(uploadId, {
      tempPath,
      originalName,
      summary,
      createdAt: Date.now(),
    });
    res.json({ uploadId, summary });
  } catch (error) {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    next(error);
  }
});

app.post('/protoclaw/feature_repository/confirm_import', express.json(), async (req, res, next) => {
  try {
    const uploadId = String(req.body?.uploadId || '').trim();
    const pending = pendingFeatureImports.get(uploadId);
    if (!pending) {
      res.status(404).json({ error: 'Unknown or expired import' });
      return;
    }

    pendingFeatureImports.delete(uploadId);
    await ensureDir(USER_FEATURE_REPOSITORY_ROOT);
    const safeName = path.basename(pending.originalName).replace(/[^a-zA-Z0-9._@+-]+/g, '-');
    let targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, safeName);
    if (existsSync(targetPath)) {
      const parsed = path.parse(safeName);
      targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, `${parsed.name}-${Date.now()}${parsed.ext || '.tgz'}`);
    }
    await fs.rename(pending.tempPath, targetPath);
    const summary = await summarizeFeatureArchive(targetPath, path.basename(targetPath), 'custom');
    res.json({ success: true, fileName: path.basename(targetPath), summary });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/feature_repository/cancel_import', express.json(), async (req, res, next) => {
  try {
    const uploadId = String(req.body?.uploadId || '').trim();
    const pending = pendingFeatureImports.get(uploadId);
    if (pending) {
      pendingFeatureImports.delete(uploadId);
      await fs.unlink(pending.tempPath).catch(() => {});
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/feature_repository/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const tempPath = req.file.path;
    const originalName = req.file.originalname;

    if (!originalName.toLowerCase().endsWith('.tgz')) {
      await fs.unlink(tempPath).catch(() => {});
      res.status(400).json({ error: 'Only .tgz files are allowed' });
      return;
    }

    // 确保用户feature仓库目录存在
    await ensureDir(USER_FEATURE_REPOSITORY_ROOT);
    
    // 移动文件到用户feature仓库
    const targetPath = path.join(USER_FEATURE_REPOSITORY_ROOT, originalName);
    await fs.rename(tempPath, targetPath);

    res.json({ success: true, fileName: originalName });
  } catch (error) {
    // 清理临时文件
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }
    next(error);
  }
});

app.post('/protoclaw/stop_agent', express.json(), async (req, res, next) => {
  try {
    const status = await stopManagedAgent(req.body.agentId, req.body.sessionId);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/restart_agent', express.json(), async (req, res, next) => {
  try {
    const agent = await requireAgentLight(req.body.agentId);
    const selectedSessionId = req.body.sessionId || null;
    await stopManagedAgent(agent.id, selectedSessionId);
    const status = await startManagedAgent(agent, selectedSessionId);
    const connected = await waitForManagedRuntimeReady(agent.id, 10000, selectedSessionId);
    res.json({ status, agent: connected });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/select_empty_directory', async (_req, res, next) => {
  try {
    res.json(await selectEmptyDirectory());
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/select_files', async (_req, res, next) => {
  try {
    res.json(await selectFiles());
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/select_directory', async (_req, res, next) => {
  try {
    res.json(await selectDirectory());
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/validate_empty_directory', express.json(), async (req, res, next) => {
  try {
    if (typeof req.body?.path !== 'string' || !req.body.path.trim()) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    res.json(await validateEmptyDirectory(req.body.path));
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/feature_creator/initialize', express.json(), async (req, res, next) => {
  try {
    const featureName = typeof req.body?.featureName === 'string' ? req.body.featureName : '';
    const parentDir = typeof req.body?.parentDir === 'string' ? req.body.parentDir : '';
    const result = await initializeFeatureCreatorWorkspace(featureName, parentDir);
    const state = await writeWorkspaceState('feature-creator', {
      openDirectory: result.outputDir,
    });
    await writeWorkspaceArtifact('feature-creator', {
      id: `feature-init-${result.outputDir}`,
      kind: 'progress',
      title: `已初始化 ${result.featureName}`,
      status: 'completed',
      updatedAt: new Date().toISOString(),
      source: {
        workspace: 'feature-creator',
        action: 'initialize',
      },
      relatedTo: {
        openDirectory: result.outputDir,
        sessionId: '',
        parentId: '',
      },
      payload: {
        feature_name: result.featureName,
        parent_dir: result.parentDir,
        output_dir: result.outputDir,
      },
    });
    res.json({
      ...result,
      workspaceState: state,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/protoclaw/agent_creator/initialize', express.json(), async (req, res, next) => {
  try {
    const agentName = typeof req.body?.agentName === 'string' ? req.body.agentName : '';
    const parentDir = typeof req.body?.parentDir === 'string' ? req.body.parentDir : '';
    const goal = typeof req.body?.goal === 'string' ? req.body.goal : '';
    const result = await initializeAgentCreatorWorkspace(agentName, parentDir, goal);
    const state = await writeWorkspaceState('agent-creator', {
      openDirectory: result.outputDir,
    });
    await writeWorkspaceArtifact('agent-creator', {
      id: `agent-init-${result.outputDir}`,
      kind: 'progress',
      title: `已初始化 ${result.agentName}`,
      status: 'completed',
      updatedAt: new Date().toISOString(),
      source: {
        workspace: 'agent-creator',
        action: 'initialize',
      },
      relatedTo: {
        openDirectory: result.outputDir,
        sessionId: '',
        parentId: '',
      },
      payload: {
        agent_name: result.agentName,
        parent_dir: result.parentDir,
        output_dir: result.outputDir,
        files: result.files.join(', '),
      },
    });
    res.json({
      ...result,
      workspaceState: state,
    });
  } catch (error) {
    next(error);
  }
});

// ========== Flow Graph API ==========

function getFlowGraphsDir(agentId) {
  return path.join(USER_DATA_ROOT, 'flows', sanitizeSessionFragment(agentId));
}

function getFlowGraphPath(agentId, flowId) {
  return path.join(getFlowGraphsDir(agentId), `${sanitizeSessionFragment(flowId)}.json`);
}

async function readFlowGraphFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return { flow: JSON.parse(raw), recovered: false };
  } catch (error) {
    const message = error?.message || '';
    const trailingMatch = message.match(/position\s+(\d+)/i);
    if (trailingMatch) {
      const cutoff = Number(trailingMatch[1]);
      if (Number.isFinite(cutoff) && cutoff > 0) {
        const trimmed = raw.slice(0, cutoff).trimEnd();
        try {
          return { flow: JSON.parse(trimmed), recovered: true };
        } catch {}
      }
    }
    throw error;
  }
}

app.get('/protoclaw/flow_graphs', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const dir = getFlowGraphsDir(agentId);
    if (!existsSync(dir)) return res.json({ flows: [] });
    const files = await fs.readdir(dir);
    const flows = [];
    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          const parsed = await readFlowGraphFile(path.join(dir, f));
          flows.push(parsed.flow);
        } catch {}
      }
    }
    res.json({ flows });
  } catch (error) { next(error); }
});

app.get('/protoclaw/flow_graph/:flowId', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const filePath = getFlowGraphPath(agentId, req.params.flowId);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Flow not found' });
    const { flow } = await readFlowGraphFile(filePath);
    res.json({ flow });
  } catch (error) { next(error); }
});

app.post('/protoclaw/flow_graph', express.json(), async (req, res, next) => {
  try {
    const agentId = req.body?.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const flow = req.body?.flow;
    if (!flow || !flow.name) return res.status(400).json({ error: 'flow.name is required' });
    const flowId = flow.id || `flow-${Date.now()}`;
    const flowWithId = { ...flow, id: flowId, updatedAt: new Date().toISOString() };
    const dir = getFlowGraphsDir(agentId);
    await ensureDir(dir);
    await fs.writeFile(getFlowGraphPath(agentId, flowId), JSON.stringify(flowWithId, null, 2), 'utf8');
    res.json({ flow: flowWithId, created: true });
  } catch (error) { next(error); }
});

app.put('/protoclaw/flow_graph/:flowId', express.json(), async (req, res, next) => {
  try {
    const agentId = req.body?.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const flowId = req.params.flowId;
    const filePath = getFlowGraphPath(agentId, flowId);
    let existing = {};
    if (existsSync(filePath)) {
      try {
        existing = (await readFlowGraphFile(filePath)).flow || {};
      } catch (error) {
        console.warn(`[flow_graph] Failed to parse existing graph ${filePath}, overwriting with incoming payload:`, error?.message || error);
      }
    }
    const flow = { ...existing, ...req.body?.flow, id: flowId, updatedAt: new Date().toISOString() };
    const dir = getFlowGraphsDir(agentId);
    await ensureDir(dir);
    await fs.writeFile(filePath, JSON.stringify(flow, null, 2), 'utf8');
    res.json({ flow, saved: true });
  } catch (error) { next(error); }
});

app.delete('/protoclaw/flow_graph/:flowId', express.json(), async (req, res, next) => {
  try {
    const agentId = req.query.agentId || req.body?.agentId;
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const filePath = getFlowGraphPath(agentId, req.params.flowId);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Flow not found' });
    await fs.unlink(filePath);
    res.json({ deleted: true, flowId: req.params.flowId });
  } catch (error) { next(error); }
});

function serializeFlowVariable(variable, featureMeta) {
  if (!variable || !variable.key) return null;
  return {
    id: `${featureMeta.id}:${String(variable.key)}`,
    key: String(variable.key),
    type: String(variable.type || 'string'),
    title: String(variable.title || variable.key),
    description: String(variable.description || ''),
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFlowTool(tool, featureMeta) {
  if (!tool || !tool.name) return null;
  return {
    id: `${featureMeta.id}:${String(tool.name)}`,
    name: String(tool.name),
    title: String(tool.title || tool.name),
    description: String(tool.description || ''),
    parameters: tool.parameters || null,
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeNodeTemplate(template, featureMeta) {
  if (!template || !template.id) return null;
  return {
    ...template,
    id: String(template.id),
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFlowMode(mode, featureMeta) {
  if (!mode || !mode.id) return null;
  return {
    ...mode,
    id: `${featureMeta.id}:${String(mode.id)}`,
    modeId: String(mode.id),
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFeatureManifest(manifest, featureMeta) {
  if (!manifest) return null;
  return {
    ...manifest,
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

async function instantiateFeatureForCapability(packageName, workspaceState) {
  const moduleName = String(packageName || '').trim();
  if (!moduleName) return null;
  try {
    const entryPath = rootRequire.resolve(moduleName);
    const mod = await import(`${pathToFileURL(entryPath).href}?capabilities=${Date.now()}`);
    const entry = Object.entries(mod).find(([name, value]) => typeof value === 'function' && /Feature$/.test(name));
    if (!entry) return null;
    return new entry[1]({
      workspaceDir: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      projectRoot: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      workdir: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      resourceRoot: cleanSessionText(workspaceState?.openDirectory) || __dirname,
    });
  } catch (error) {
    return { __capabilityError: error instanceof Error ? error.message : String(error) };
  }
}

async function instantiateBuiltInFeatureForCapability(featureName, workspaceState) {
  const normalized = cleanSessionText(featureName).toLowerCase();
  if (!normalized) return null;
  try {
    const baseConfig = {
      workspaceDir: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      projectRoot: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      workdir: cleanSessionText(workspaceState?.openDirectory) || __dirname,
      resourceRoot: cleanSessionText(workspaceState?.openDirectory) || __dirname,
    };

    if (normalized === 'skill') {
      const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilities=${Date.now()}`);
      const FeatureClass = agentdev?.SkillFeature;
      if (typeof FeatureClass !== 'function') return null;
      return new FeatureClass(baseConfig);
    }

    if (normalized === 'flow') {
      const localFeatures = await import(`${pathToFileURL(path.join(__dirname, 'local-features', 'dist', 'index.js')).href}?builtinCapabilities=${Date.now()}`);
      const FeatureClass = localFeatures?.FlowFeature;
      if (typeof FeatureClass !== 'function') return null;
      const graph = readAssemblyGraphForCapabilities(workspaceState);
      const flows = graphToRuntimeFlowsForCapabilities(graph);
      return new FeatureClass({
        ...baseConfig,
        flows,
        useTestFlow: false,
      });
    }

    const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilities=${Date.now()}`);
    for (const exported of Object.values(agentdev || {})) {
      if (typeof exported !== 'function' || !/Feature$/.test(String(exported.name || ''))) continue;
      if (normalizeBuiltInCapabilityId(exported.name) !== normalized) continue;
      return new exported(baseConfig);
    }

    const localFeatures = await import(`${pathToFileURL(path.join(__dirname, 'local-features', 'dist', 'index.js')).href}?builtinCapabilities=${Date.now()}`);
    for (const [exportName, exported] of Object.entries(localFeatures || {})) {
      if (exportName === 'FlowAwareFeature') continue;
      if (typeof exported !== 'function' || !/Feature$/.test(String(exportName || ''))) continue;
      if (normalizeBuiltInCapabilityId(exportName) !== normalized) continue;
      return new exported(baseConfig);
    }

    return null;
  } catch (error) {
    return { __capabilityError: error instanceof Error ? error.message : String(error) };
  }
}

function hasCapabilitySurface(FeatureClass) {
  const proto = FeatureClass?.prototype;
  if (!proto) return false;
  return ['getFlowVariables', 'getFlowNodeTemplates', 'getFlowModes', 'getFeatureManifest']
    .some((name) => typeof proto[name] === 'function');
}

function normalizeBuiltInCapabilityId(exportName) {
  return String(exportName || '')
    .replace(/Feature$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
    .trim();
}

function isAutoEntryModeForFlow(mode) {
  return mode === 'auto' || mode === 'auto-reenterable';
}

async function listBuiltInCapabilitySources(workspaceState) {
  const sources = [];
  const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilityList=${Date.now()}`);
  const localFeatures = await import(`${pathToFileURL(path.join(__dirname, 'local-features', 'dist', 'index.js')).href}?builtinCapabilityList=${Date.now()}`);

  const modules = [
    { exports: agentdev, packageName: 'agentdev', skip: new Set() },
    { exports: localFeatures, packageName: 'local-features', skip: new Set(['FlowAwareFeature']) },
  ];

  for (const mod of modules) {
    for (const [exportName, exported] of Object.entries(mod.exports || {})) {
      if (!/Feature$/.test(exportName)) continue;
      if (mod.skip.has(exportName)) continue;
      if (typeof exported !== 'function') continue;
      if (!hasCapabilitySurface(exported)) continue;

      const featureId = normalizeBuiltInCapabilityId(exportName);
      if (!featureId) continue;

      sources.push({
        featureMeta: {
          id: featureId,
          name: featureId,
          packageName: mod.packageName,
          token: featureId,
        },
        instantiate: () => instantiateBuiltInFeatureForCapability(featureId, workspaceState),
      });
    }
  }

  return sources;
}

function readAssemblyGraphForCapabilities(workspaceState) {
  const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
  const projectId = cleanSessionText(assemblyForm.editing_config_id)
    || cleanSessionText(assemblyForm.assembly_name)
    || 'flow-workspace';
  const filePath = getFlowGraphPath(projectId, 'agent-flow-graph');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function graphToRuntimeFlowsForCapabilities(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  if (graph.mode && graph.entry && !graph.workflows) return [graph];

  const nodes = graph.nodes;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  const isWorkflowHead = (node) => Boolean(node && (node.type === 'workflow-head' || node.kind === 'workflow-head'));

  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }

  const heads = nodes.filter(isWorkflowHead);
  if (heads.length > 0) {
    let autoSeen = false;
    return heads.map((head, index) => {
      const workflowId = cleanSessionText(head.workflowId) || Object.entries(graph.workflows || {})
        .find(([, meta]) => cleanSessionText(meta?.entry) === head.id)?.[0] || `workflow-${index + 1}`;
      const meta = graph.workflows?.[workflowId] || {};
      const seen = new Set([head.id]);
      const queue = [head.id];
      while (queue.length) {
        const id = queue.shift();
        for (const next of adjacency.get(id) || []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }

      const runtimeNodes = [...seen]
        .map((id) => byId.get(id))
        .filter((node) => node && !isWorkflowHead(node));
      if (runtimeNodes.length === 0) return null;

      const runtimeNodeIds = new Set(runtimeNodes.map((node) => node.id));
      const firstFromHead = edges.find((edge) => edge.from === head.id && runtimeNodeIds.has(edge.to))?.to
        || edges.find((edge) => edge.to === head.id && runtimeNodeIds.has(edge.from))?.from;
      const entry = runtimeNodeIds.has(meta.runtimeEntry) ? meta.runtimeEntry
        : (runtimeNodeIds.has(meta.entry) ? meta.entry : (firstFromHead || runtimeNodes[0]?.id));
      let mode = meta.mode || 'agent-initiated';
      if (isAutoEntryModeForFlow(mode)) {
        if (autoSeen) mode = 'agent-initiated';
        autoSeen = true;
      }

      return {
        id: workflowId,
        name: meta.name || head.name || `工作流 ${index + 1}`,
        description: meta.description || '',
        mode,
        nodes: runtimeNodes.map((item) => {
          const { position, workflowId: _workflowId, ...runtimeNode } = item;
          return runtimeNode;
        }),
        edges: edges.filter((edge) => runtimeNodeIds.has(edge.from) && runtimeNodeIds.has(edge.to)),
        entry,
        reminderFrequency: meta.reminderFrequency || 'every-step',
        reminderInterval: meta.reminderInterval,
        variables: meta.variables || {},
        prompts: meta.prompts || [],
      };
    }).filter(Boolean);
  }

  const seen = new Set();
  let autoSeen = false;
  const flows = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const queue = [node.id];
    const ids = [];
    seen.add(node.id);
    while (queue.length) {
      const id = queue.shift();
      ids.push(id);
      for (const next of adjacency.get(id) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    const componentNodes = ids.map((id) => byId.get(id)).filter(Boolean);
    const workflowIds = new Map();
    for (const item of componentNodes) {
      workflowIds.set(item.workflowId, (workflowIds.get(item.workflowId) || 0) + 1);
    }
    const workflowId = [...workflowIds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || `workflow-${flows.length + 1}`;
    const meta = graph.workflows?.[workflowId] || {};
    const entry = componentNodes.some((item) => item.id === meta.entry) ? meta.entry : componentNodes[0]?.id;
    let mode = meta.mode || 'agent-initiated';
    if (isAutoEntryModeForFlow(mode)) {
      if (autoSeen) mode = 'agent-initiated';
      autoSeen = true;
    }

    flows.push({
      id: workflowId,
      name: meta.name || `工作流 ${flows.length + 1}`,
      description: meta.description || '',
      mode,
      nodes: componentNodes.map((item) => {
        const { position, workflowId: _workflowId, ...runtimeNode } = item;
        return runtimeNode;
      }),
      edges: edges.filter((edge) => ids.includes(edge.from) && ids.includes(edge.to)),
      entry,
      reminderFrequency: meta.reminderFrequency || 'every-step',
      reminderInterval: meta.reminderInterval,
      variables: meta.variables || {},
      prompts: meta.prompts || [],
    });
  }
  return flows;
}

app.get('/protoclaw/flow_capabilities', async (req, res, next) => {
  try {
    const agentId = cleanSessionText(req.query.agentId) || 'flow-workspace';
    const workspaceState = await readWorkspaceState(agentId).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
    const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
    const selectedFeatures = parseListField(assemblyForm.selected_features);
    const archives = selectedFeatures.length > 0
      ? await resolveAssemblyFeatureArchives(selectedFeatures).catch(() => [])
      : [];

    const features = [];
    const tools = [];
    const variables = [];
    const nodeTemplates = [];
    const modes = [];
    const featureManifests = [];

    const builtInSources = await listBuiltInCapabilitySources(workspaceState).catch(() => []);
    const capabilitySources = [
      ...archives.map((item) => ({
        featureMeta: {
          id: String(item.packageName || item.token || '').replace(/^@agentdev\//, '') || String(item.token || ''),
          name: String(item.packageName || item.token || ''),
          packageName: String(item.packageName || item.token || ''),
          token: String(item.token || ''),
        },
        instantiate: () => instantiateFeatureForCapability(String(item.packageName || item.token || ''), workspaceState),
      })),
      ...builtInSources,
    ];

    const seenFeatureIds = new Set();

    for (const source of capabilitySources) {
      const featureMeta = source.featureMeta;
      if (!featureMeta?.id || seenFeatureIds.has(featureMeta.id)) continue;
      seenFeatureIds.add(featureMeta.id);
      const instance = await source.instantiate();
      const featureSummary = { ...featureMeta, tools: 0, variables: 0, nodeTemplates: 0, modes: 0, error: '' };

      if (!instance || instance.__capabilityError) {
        featureSummary.error = instance?.__capabilityError || 'Feature entry not found';
        features.push(featureSummary);
        continue;
      }

      try {
        const featureTools = typeof instance.getTools === 'function' ? instance.getTools() : [];
        if (Array.isArray(featureTools)) {
          for (const tool of featureTools) {
            const serialized = serializeFlowTool(tool, featureMeta);
            if (serialized) tools.push(serialized);
          }
          featureSummary.tools = featureTools.length;
        }
      } catch (error) {
        featureSummary.error = `getTools: ${error instanceof Error ? error.message : String(error)}`;
      }

      try {
        const featureVariables = typeof instance.getFlowVariables === 'function' ? instance.getFlowVariables() : [];
        if (Array.isArray(featureVariables)) {
          for (const variable of featureVariables) {
            const serialized = serializeFlowVariable(variable, featureMeta);
            if (serialized) variables.push(serialized);
          }
          featureSummary.variables = featureVariables.length;
        }
      } catch (error) {
        featureSummary.error = [featureSummary.error, `getFlowVariables: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      }

      try {
        const templates = typeof instance.getFlowNodeTemplates === 'function' ? instance.getFlowNodeTemplates() : [];
        if (Array.isArray(templates)) {
          for (const template of templates) {
            const serialized = serializeNodeTemplate(template, featureMeta);
            if (serialized) nodeTemplates.push(serialized);
          }
          featureSummary.nodeTemplates = templates.length;
        }
      } catch (error) {
        featureSummary.error = [featureSummary.error, `getFlowNodeTemplates: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      }

      try {
        const featureModes = typeof instance.getFlowModes === 'function' ? instance.getFlowModes() : [];
        if (Array.isArray(featureModes)) {
          for (const mode of featureModes) {
            const serialized = serializeFlowMode(mode, featureMeta);
            if (serialized) modes.push(serialized);
          }
          featureSummary.modes = featureModes.length;
        }
      } catch (error) {
        featureSummary.error = [featureSummary.error, `getFlowModes: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      }

      try {
        const manifest = typeof instance.getFeatureManifest === 'function' ? instance.getFeatureManifest() : null;
        if (manifest && typeof manifest === 'object') {
          const serialized = serializeFeatureManifest(manifest, featureMeta);
          if (serialized) featureManifests.push(serialized);
        }
      } catch (error) {
        featureSummary.error = [featureSummary.error, `getFeatureManifest: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
      }

      features.push(featureSummary);
    }

    let modelPresets = [];
    try {
      const presetData = await readModelPresets();
      modelPresets = Array.isArray(presetData?.presets) ? presetData.presets : [];
    } catch {}

    res.json({
      agentId,
      selectedFeatures,
      features,
      tools,
      variables,
      nodeTemplates,
      modes,
      featureManifests,
      modelPresets,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) { next(error); }
});

app.get('/protoclaw/agent_model_presets', async (req, res, next) => {
  try {
    const agentId = req.query.agentId;
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId is required' });
    }
    const metaPath = path.join(__dirname, 'prebuilt-agents', 'official', agentId, 'metadata.json');
    const meta = await readJson(metaPath);
    if (!meta) {
      return res.status(404).json({ error: 'Agent metadata not found' });
    }
    res.json({ agentId, modelPresets: meta.modelPresets || {} });
  } catch (error) { next(error); }
});

app.put('/protoclaw/agent_model_presets', express.json(), async (req, res, next) => {
  try {
    const { agentId, modelPresets } = req.body || {};
    if (!agentId || typeof agentId !== 'string') {
      return res.status(400).json({ error: 'agentId is required' });
    }
    if (!modelPresets || typeof modelPresets !== 'object') {
      return res.status(400).json({ error: 'modelPresets object is required' });
    }
    const metaPath = path.join(__dirname, 'prebuilt-agents', 'official', agentId, 'metadata.json');
    const meta = await readJson(metaPath);
    if (!meta) {
      return res.status(404).json({ error: 'Agent metadata not found' });
    }
    meta.modelPresets = modelPresets;
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    res.json({ ok: true, agentId, modelPresets });
  } catch (error) { next(error); }
});

// ── Server-side audio feedback for choice input requests ───────────────────

const _seenChoiceRequestIds = new Set();
const PLAY_SOUND_SCRIPT = path.join(__dirname, 'scripts', 'play-sound.ps1');

/**
 * Play an audio file on the server machine via PowerShell MCI.
 * Fire-and-forget — does not block the response.
 */
function playSoundOnServer(soundFile) {
  const soundPath = path.join(__dirname, 'public', 'sounds', soundFile);
  const child = spawn('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', PLAY_SOUND_SCRIPT,
    '-Path', soundPath,
  ], { stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
}

/**
 * Intercept input-requests proxy: forward to ViewerWorker, but also inspect
 * the response for new choice-type requests and play a terminal bell sound
 * on the server immediately — independent of frontend rendering state.
 */
app.get('/api/agents/:agentId/input-requests', async (req, res, next) => {
  try {
    const targetUrl = `${VIEWER_ORIGIN}${req.originalUrl}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (key.toLowerCase() === 'host') continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const response = await fetch(targetUrl, { method: 'GET', headers });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value);
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);

    // Detect new choice requests after forwarding the response
    if (response.ok) {
      try {
        const requests = JSON.parse(buffer.toString('utf8'));
        if (Array.isArray(requests)) {
          for (const r of requests) {
            const isChoice = r && r.mode === 'choices'
              && Array.isArray(r.questions) && r.questions.length > 0
              && typeof r.requestId === 'string';
            if (isChoice && !_seenChoiceRequestIds.has(r.requestId)) {
              if (_seenChoiceRequestIds.size > 500) _seenChoiceRequestIds.clear();
              _seenChoiceRequestIds.add(r.requestId);
              playSoundOnServer('terminal-bell.mp3');
              break; // one bell per poll cycle
            }
          }
        }
      } catch { /* non-critical */ }
    }
  } catch (err) {
    next(err);
  }
});

app.get(/^\/(api|features|template|tools|npm)(\/.*)?$/, (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.get(/^\/(chunk-|BasicAgent-|ExplorerAgent-|notification-|resolver-|types-|index\.js).*$/, (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.put('/api/agents/current', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/queue-input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.get('/api/agents/:agentId/queued-inputs', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/dequeue-input', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.post('/api/agents/:agentId/interrupt', (req, res, next) => {
  console.log(`[Server] POST /api/agents/${req.params.agentId}/interrupt → proxying to ViewerWorker`);
  proxyToViewer(req, res).catch(next);
});

app.get('/api/agents/:agentId/running', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.delete('/api/agents/:agentId', (req, res, next) => {
  proxyToViewer(req, res).catch(next);
});

app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));
app.use(express.static(path.join(__dirname, 'public')));

app.use((error, _req, res, _next) => {
  res.status(error.statusCode || 500).json({ error: error.message || 'Internal Server Error' });
});

async function shutdown(exitCode = 0) {
  for (const runtime of managedAgents.values()) {
    if (runtime.process && runtime.process.exitCode === null && !runtime.stopped) {
      runtime.stopped = true;
      runtime.process.kill('SIGTERM');
    }
  }

  for (const runtime of assemblyRuntimeProcesses.values()) {
    if (runtime.process && runtime.process.exitCode === null && !runtime.stopped) {
      runtime.stopped = true;
      runtime.process.kill('SIGTERM');
    }
  }

  await viewerWorker.stop().catch(() => {});
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

async function main() {
  await viewerWorker.start();

  // One-time cleanup of stale empty sessions from previous runs.
  // Only runs at startup — never during normal operation.
  for (const agentId of WORKSPACE_SESSION_AGENT_IDS) {
    try {
      await cleanupEmptySessions(agentId);
    } catch (err) {
      console.warn(`[sessions] startup cleanup failed for ${agentId}:`, err.message);
    }
  }

  app.listen(APP_PORT, () => {
    log('server', `product ui: http://127.0.0.1:${APP_PORT}`);
    log('server', `viewer worker: ${VIEWER_ORIGIN}`);
    fireBootSchedules();
  });
}

main().catch((error) => {
  log('server', error.stack || error.message, 'error');
  process.exit(1);
});
