#!/usr/bin/env node
/**
 * ProtoClaw prebuilt agent runtime.
 *
 * This script owns the runtime contract for internal prebuilt agents:
 * - load the agent class from ProtoClaw's prebuilt source tree
 * - attach to the local ViewerWorker
 * - restore/persist session state in a stable ProtoClaw-owned location
 * - drive the agent through UserInputFeature
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import os from 'os';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { DebugHub, FileSessionStore, HandoffSeedFeature } from '@agentdevjs/core';
import { setTimeout as sleep } from 'timers/promises';
import { importFeatureContinuity } from '../server/context-continuity/feature-continuity.js';
import { mountUserConfiguredFeatures } from '../server/feature-runtime/user-mount.js';
import { preflightRefreshTokens } from '../server/oauth-codex.js';
import { resolveAgentModelLLM, resolveGlobalDefaultLLM, modelPresetResolver } from '../server/model-preset-resolver.js';
import { buildCallUsageEvents, reportUsageEvent } from './usage-report.js';
import { enqueueOrderedProjection } from './post-call-sync.js';

import { mapEnvelopeToTurnEvent } from './turn-event-mapping.js';
import { createTurnEventBus } from '../server/shared/turn-event-bus.js';
import { CallArbiter } from '../server/call-arbiter.js';
import { createRuntimeIPC } from './runtime-im-bridge.js';
import { dispatchCapabilityRequest, handleCapabilityIPC } from './capability-ipc.js';
import { createSummaryHandlers } from './runtime-summary.js';
import { createPassiveMailboxLoop } from './runtime-passive-mailbox.js';
import { postUserTurnToViewerMailbox, waitForArbiterIdle } from './runtime-interjection-mailbox.js';
import { WORKSPACE_SESSION_AGENT_IDS, resolveUserDataDir, AGENT_USER_CONFIG_PATH, MODEL_PRESETS_PATH } from '../server/shared/constants.js';
import { resolveDesktopWorkspace } from '../server/shared/desktop-workspace.js';
import { parseHandoffContent } from '../server/shared/handoff-payload.js';
import { internalAuthHeaders } from '../server/shared/internal-auth.js';
import { resolveWorkspaceAgent, resolveWorkspaceAgentClass, workspaceAgentDisplayName } from '../server/shared/workspace-agents.js';
import { resolveSessionRuntimeDirectory } from '../server/shared/session-project.js';
import { readSessionIndexSync } from '../server/shared/session-access.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const VIEWER_PORT = parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:14200';
// ADR-0037 M6：托管容器形态（无父子 IPC 通道）经注册协议完成身份交接与
// 退役上报；本地托管形态（process.connected）不走该分支。
const REGISTER_MODE = cleanValue(process.env.PROTOCLAW_RUNTIME_REGISTER) === '1';
const RUNTIME_REGISTER_TIMEOUT_MS = parseInt(process.env.PROTOCLAW_RUNTIME_REGISTER_TIMEOUT_MS || '20000', 10);
const NO_SESSION_TOKEN = '__protoclaw-no-session__';
const HANDOFF_PATH_ENV = 'PROTOCLAW_HANDOFF_PATH';
const HANDOFF_PAYLOAD_ENV = 'PROTOCLAW_HANDOFF_PAYLOAD';
// 权威集合来自 server/shared/constants.js（服务端与子进程必须同源）
const WORKSPACE_BOUND_AGENT_IDS = WORKSPACE_SESSION_AGENT_IDS;
// 会话数据根同源解析，支持 AGENTDEV_DATA_DIR 多实例隔离
const USER_DATA_ROOT = resolveUserDataDir();
const PREBUILT_AGENT_MAX_TOKENS_CAP = 8000; // 预制 agent maxTokens 上限（应与 server/shared/constants.js 保持一致）
const runtimeInstanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const reportedUsageEventIds = new Set();

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function loadRuntimeHandoff() {
  const payloadText = cleanValue(process.env[HANDOFF_PAYLOAD_ENV]);
  if (payloadText) {
    return {
      source: HANDOFF_PAYLOAD_ENV,
      handoff: parseHandoffContent(payloadText, HANDOFF_PAYLOAD_ENV, { rawTextFallback: true }),
    };
  }

  const handoffPath = cleanValue(process.env[HANDOFF_PATH_ENV]);
  if (!handoffPath) {
    return null;
  }
  if (!existsSync(handoffPath)) {
    throw new Error(`handoff 文件不存在: ${handoffPath}`);
  }

  const fileContent = readFileSync(handoffPath, 'utf8');
  return {
    source: handoffPath,
    handoff: parseHandoffContent(fileContent, handoffPath),
  };
}

function sanitizeSessionFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}


function getWorkspaceStatePath(agentId) {
  return join(USER_DATA_ROOT, 'workspaces', sanitizeSessionFragment(agentId), 'state.json');
}

// 容器形态（CLAW_SESSION_INDEX_REMOTE=1，容器后端注入）：索引读不直连
// index.db——WAL 锁跨不过容器边界（宿主↔容器双向互斥，ADR-0037 容器修订），
// 统一走平台 HTTP（写侧 session_meta_sync 已是 HTTP）；本地形态维持
// session-access 同步直读（同内核文件锁有效）。
const SESSION_INDEX_REMOTE = process.env.CLAW_SESSION_INDEX_REMOTE === '1';

async function fetchSessionRecordRemote(agentId, sessionId) {
  const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/session_record_lookup`, {
    method: 'POST',
    headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ agentId, sessionId }),
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`session record lookup failed: HTTP ${resp.status}`);
  const data = await resp.json();
  return data?.record || null;
}

async function lookupSessionRecord(agentId, sessionId) {
  if (SESSION_INDEX_REMOTE) return fetchSessionRecordRemote(agentId, sessionId);
  const parsed = readSessionIndexSync(agentId);
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  return sessions.find((session) => sanitizeSessionFragment(session?.id) === sanitizeSessionFragment(sessionId)) || null;
}

async function resolveSessionWorkspaceCwd(agentId, sessionId) {
  const normalizedSessionId = cleanValue(sessionId);
  if (!normalizedSessionId || normalizedSessionId === NO_SESSION_TOKEN) {
    return null;
  }

  let record = null;
  try {
    // ADR-0036：索引持久层为 index.db，本地经 session-access 同步直读（WAL
    // 支持父子进程并发读）；容器形态经 lookupSessionRecord 走平台 HTTP。
    record = await lookupSessionRecord(agentId, normalizedSessionId);
  } catch (error) {
    console.warn('[ProtoClaw Runtime] 读取 session 工作目录失败:', error);
    return null;
  }
  // PH 项目会话（ticket 042）：运行目录由项目表当前记录解析，失败直接抛错
  // （被上层启动失败路径捕获），不退回 openDirectory/state 的目录会话语义。
  const projectDirectory = resolveSessionRuntimeDirectory(record, { sessionId: normalizedSessionId });
  if (projectDirectory) {
    return projectDirectory;
  }
  const openDirectory = cleanValue(record?.openDirectory);
  if (!openDirectory || !existsSync(openDirectory)) {
    return null;
  }
  return openDirectory;
}

async function resolveWorkspaceCwd(agentId, sessionId = '') {
  if (!WORKSPACE_BOUND_AGENT_IDS.has(sanitizeSessionFragment(agentId))) {
    return null;
  }

  // --- Assembly mode: compute cwd from env var or assembly form ---
  if (process.env.PROTOCLAW_ASSEMBLY_RUNTIME === '1') {
    const assemblyCwd = process.env.PROTOCLAW_ASSEMBLY_WORKSPACE;
    if (assemblyCwd) {
      mkdirSync(assemblyCwd, { recursive: true });
      const claudeMdPath = join(assemblyCwd, 'CLAUDE.md');
      if (!existsSync(claudeMdPath)) {
        writeFileSync(claudeMdPath, '# Chatbot Workspace\n\nAssembly workspace.\n', 'utf8');
      }
      return assemblyCwd;
    }
    // Fallback: read from state.json
    const statePath = getWorkspaceStatePath(agentId);
    if (existsSync(statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
        const assemblyName = parsed?.forms?.['assembly-form']?.assembly_name;
        if (assemblyName && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(assemblyName)) {
          const fallbackCwd = join(os.homedir(), '.agentdev', 'agent-dev', assemblyName);
          mkdirSync(fallbackCwd, { recursive: true });
          const claudeMdPath = join(fallbackCwd, 'CLAUDE.md');
          if (!existsSync(claudeMdPath)) {
            writeFileSync(claudeMdPath, `# ${assemblyName}\n\nAssembly workspace.\n`, 'utf8');
          }
          return fallbackCwd;
        }
      } catch (error) {
        console.warn('[ProtoClaw Runtime] Assembly 模式读取状态失败:', error);
      }
    }
    return null;
  }

  // --- Project mode: prefer the target session's own openDirectory ---
  const sessionCwd = await resolveSessionWorkspaceCwd(agentId, sessionId);
  if (sessionCwd) {
    return sessionCwd;
  }

  // Fallback for workspace home/no-session mode: use current openDirectory from state.
  const statePath = getWorkspaceStatePath(agentId);
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const openDirectory = typeof parsed?.openDirectory === 'string' ? parsed.openDirectory.trim() : '';
    if (!openDirectory || !existsSync(openDirectory)) {
      return null;
    }
    return openDirectory;
  } catch (error) {
    console.warn('[ProtoClaw Runtime] 读取工作空间状态失败:', error);
    return null;
  }
}

const [agentDir, agentId, agentNameArg, sessionIdArg] = process.argv.slice(2);

if (!agentDir || !agentId) {
  console.error('用法: node scripts/run-prebuilt-agent.js <agent-dir> <agent-id> [agent-name] [session-id]');
  process.exit(1);
}

const agentPath = resolve(PROTOCLAW_ROOT, agentDir);
const agentJsPath = join(agentPath, 'agent.js');
const agentName = agentNameArg || agentId;
const sessionStoreDir = WORKSPACE_BOUND_AGENT_IDS.has(sanitizeSessionFragment(agentId))
  ? join(USER_DATA_ROOT, 'workspaces', sanitizeSessionFragment(agentId), 'sessions')
  : join(USER_DATA_ROOT, 'prebuilt-sessions', sanitizeSessionFragment(agentId));
mkdirSync(sessionStoreDir, { recursive: true });

const sessionStore = new FileSessionStore(sessionStoreDir);
const sessionId = sessionIdArg && sessionIdArg !== NO_SESSION_TOKEN
  ? sanitizeSessionFragment(sessionIdArg)
  : null;
const INPUT_PROMPT = '请输入: ';
const NEXT_TURN_ACTIONS = [
  {
    id: 'rollback_to_call',
    label: '回滚到指定轮次',
    kind: 'rollback',
    variant: 'secondary',
  },
  {
    id: 'compact_from_call',
    label: '从指定轮次压缩',
    kind: 'compact',
    variant: 'secondary',
  },
];

// ── Session registry (multi-session support) ──────────────────
// sessionId → SessionLifecycle instance
const sessions = new Map();

// ── Shared postJson utility ────────────────────────────────────
async function postJson(pathname, payload) {
  const response = await fetch(`${SERVER_ORIGIN}${pathname}`, {
    method: 'POST',
    headers: internalAuthHeaders({
      'content-type': 'application/json',
    }),
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  const data = bodyText ? JSON.parse(bodyText) : {};
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : `${pathname} failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}

// ── 托管容器身份交接（ADR-0037 M6）────────────────────────────
// 容器 runtime 无父子 IPC：经 /protoclaw/runtime/register 携一次性 ticket
// 完成与本地 runtime-identity → accepted 等价的握手（次序一致：注册
// accepted 后才接入 Viewer）。平台暂未就绪（启动竞态）时退避重试；ticket
// 被拒（无效 / 过期 / 不匹配）为确定性失败，不重试直接抛出。
async function registerManagedRuntimeWithPlatform(viewerAgentId, identity) {
  const payload = {
    viewerAgentId,
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    ticket: cleanValue(process.env.PROTOCLAW_RUNTIME_TICKET),
  };
  const deadline = Date.now() + RUNTIME_REGISTER_TIMEOUT_MS;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    try {
      await postJson('/protoclaw/runtime/register', payload);
      console.log('[ProtoClaw Runtime] ✓ 平台注册完成（ticket 身份交接）');
      return;
    } catch (error) {
      const message = String(error?.message || error);
      if (/ticket/i.test(message)) {
        throw new Error(`平台注册被拒（ticket 无效或身份不匹配）: ${message}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`平台注册超时（${RUNTIME_REGISTER_TIMEOUT_MS}ms，尝试 ${attempt} 次）: ${message}`);
      }
      console.warn(`[ProtoClaw Runtime] 平台注册未就绪，重试 (第 ${attempt} 次): ${message}`);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(500 * attempt, 3000)));
  }
}

// ── SessionLifecycle ──────────────────────────────────────────
// Encapsulates the full lifecycle of a single agent session within
// a process that may host multiple sessions concurrently.
class SessionLifecycle {
  constructor(opts) {
    this.sessionId = opts.sessionId ?? null;
    this.agentName = opts.agentName || agentId;
    this.workspaceCwd = opts.workspaceCwd ?? null;
    this.runtimeHandoff = opts.runtimeHandoff ?? null;
    this.announceOnStdout = opts.announceOnStdout === true;
    this.managedRuntimeIdentity = opts.managedRuntimeIdentity?.enabled === true
      ? { agentId: opts.managedRuntimeIdentity.agentId, sessionId: opts.managedRuntimeIdentity.sessionId }
      : null;
    this.runtime = {
      agentId,
      sessionId: this.sessionId,
      serverOrigin: SERVER_ORIGIN,
      sessionType: opts.runtime?.sessionType || null,
      gcChatId: opts.runtime?.gcChatId || null,
      modelPresetRole: opts.runtime?.modelPresetRole || null,
    };

    // Populated during start()
    this.agent = null;
    this.callArbiter = null;
    // 轮次事件总线（ADR-0041 决策 3）：把 turn.* 事实广播给应用订阅者。
    // 与 thread_events 上报并行且互不依赖——上报失败不影响总线分发，
    // 总线订阅者抛错也不影响上报与回合本身。
    this.turnEvents = createTurnEventBus({
      onListenerError: (error, event) => {
        console.warn(`[ProtoClaw Runtime] turn event listener failed (${event?.type}):`,
          error?.message || error);
      },
    });
    this.disposed = false;
    this.inputLoopRunning = false;
    this.passiveMailboxLoop = null;
    this.lastReportedMessageCount = 0;
    // 上一个输入动作（回退/压缩）的失败原因：随下一次 lease actions 一次性
    // 广播给前端（toast 呈现），不再只进输入框 placeholder（几乎不可见）。
    this._lastActionError = null;

    // feature-comms 请求面的去抖保存（scheduleCommsSave）：idle 期经
    // onHostRequest 变更的 feature 状态（如会话标注）没有近期保存点，
    // 宿主统一在请求成功后去抖补一次 saveSession。
    this._commsSaveTimer = null;
    this._commsSaveChain = Promise.resolve();
    // Post-call server projections are ordered per runtime but never hold the
    // CallArbiter gate; an unreachable viewer must not block the next user turn.
    this._postCallSyncChain = Promise.resolve();
    this._hostRequests = new Set();

    // Per-session bridge contexts (shared by reference with extracted modules)
    this.ipcCtx = { agent: null };
    this.summaryCtx = {
      agentId,
      sessionId: this.sessionId,
      PREBUILT_AGENT_MAX_TOKENS_CAP,
      agent: null,
      sessionStore,
      postJson,
    };
    this.runtimeIPC = createRuntimeIPC(this.ipcCtx);
    this.summaryHandlers = createSummaryHandlers(this.summaryCtx);
  }

  getNextTurnActions() {
    const checkpoints = Array.isArray(this.agent?._callCheckpoints) ? this.agent._callCheckpoints : [];
    if (checkpoints.length === 0) return undefined;
    const availableCallIndices = checkpoints.map(cp => cp.callIndex);
    // 观测防御：lease 广播发生在轮次终态之后，checkpoint 应已含最新轮；
    // 落后于 _callIndex 说明广播早于 checkpoint 提交（低概率竞态，历史观测
    // 过一次），留 warn 痕迹便于复现时定位。前端对最新用户消息另有放宽。
    const agentCallIndex = typeof this.agent?._callIndex === 'number' ? this.agent._callIndex : null;
    if (agentCallIndex !== null && Math.max(...availableCallIndices) < agentCallIndex) {
      console.warn(`[ProtoClaw Runtime] lease actions 落后于当前轮: checkpoints=[${availableCallIndices.join(',')}] _callIndex=${agentCallIndex}`);
    }
    // 上一个输入动作的失败原因随 actions 一次性携带（读后即清），前端以
    // toast 呈现；输入框 placeholder 提示保留作兜底。
    const lastActionError = this._lastActionError;
    this._lastActionError = null;
    return NEXT_TURN_ACTIONS.map(action => ({
      ...action,
      data: { availableCallIndices, ...(lastActionError ? { lastActionError } : {}) },
    }));
  }

  async cancelThreadCommands(commands) {
    if (!this.sessionId || !Array.isArray(commands)) return;
    for (const identity of commands) {
      if (!identity || typeof identity.commandId !== 'string' || typeof identity.threadId !== 'string'
        || !Number.isInteger(identity.headGeneration)) continue;
      try {
        await postJson(`/protoclaw/threads/${encodeURIComponent(identity.threadId)}/commands/${encodeURIComponent(identity.commandId)}/cancel`, {
          headGeneration: identity.headGeneration,
          source: 'user_interrupt',
        });
      } catch (error) {
        console.warn(`[ProtoClaw Runtime] durable command cancellation failed (${identity.commandId}):`, error?.message || error);
      }
    }
  }

  async reportThreadEvent(event) {
    if (!this.sessionId || !event || typeof event !== 'object') return;
    try {
      await postJson('/protoclaw/thread_events', {
        agentId,
        sessionId: this.sessionId,
        runtimeInstanceId,
        event,
      });
    } catch {
      // Lifecycle reporting is observability only and must not change the call result.
    }
  }

  async reportSessionItemsForTurn(messagesSnapshot) {
    if (!this.sessionId) return;
    const messages = Array.isArray(messagesSnapshot)
      ? messagesSnapshot
      : (Array.isArray(this.agent?.getContext?.()?.getAll?.())
          ? this.agent.getContext().getAll()
          : []);
    const pending = messages.slice(this.lastReportedMessageCount);
    for (const message of pending) {
      // 插话锚点的 turn 是分数（N.5/N.75…，见 captureInterjectionCheckpoint），
      // 按数值透传；thread 事件消费方（无头 JSONL / 看板）只作标识不去重语义。
      const turn = typeof message?.turn === 'number' && Number.isFinite(message.turn) ? message.turn : null;
      if (message?.role === 'assistant') {
        if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
          await this.reportThreadEvent({
            type: 'item.completed',
            eventId: `${runtimeInstanceId}:reasoning:${turn}:${this.lastReportedMessageCount}`,
            item: { id: `reasoning-${runtimeInstanceId}-${this.lastReportedMessageCount}`, turn, type: 'reasoning', text: message.reasoning },
          });
        }
        if (typeof message.content === 'string' && message.content.trim()) {
          await this.reportThreadEvent({
            type: 'item.completed',
            eventId: `${runtimeInstanceId}:message:${turn}:${this.lastReportedMessageCount}`,
            item: { id: `message-${runtimeInstanceId}-${this.lastReportedMessageCount}`, turn, type: 'agent_message', text: message.content },
          });
        }
        for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
          await this.reportThreadEvent({
            type: 'item.started',
            eventId: `${runtimeInstanceId}:tool-started:${call.id || this.lastReportedMessageCount}`,
            item: { id: call.id || `tool-${this.lastReportedMessageCount}`, turn, type: 'tool_call', tool: call.name, arguments: call.arguments, status: 'in_progress' },
          });
        }
      } else if (message?.role === 'tool') {
        let parsed = null;
        try { parsed = JSON.parse(message.content); } catch {}
        const success = parsed?.success !== false;
        await this.reportThreadEvent({
          type: 'item.completed',
          eventId: `${runtimeInstanceId}:tool-completed:${message.toolCallId || this.lastReportedMessageCount}`,
          item: {
            id: message.toolCallId || `tool-${this.lastReportedMessageCount}`,
            turn,
            type: 'tool_call',
            tool: parsed?.tool || 'tool',
            status: success ? 'completed' : 'failed',
            ...(success ? { result: parsed?.result ?? message.content } : { error: parsed?.error || message.content }),
          },
        });
      }
      this.lastReportedMessageCount += 1;
    }
  }

  // ── IPC handler for this session ────────────────────────────
  // Called by the central IPC dispatcher when __targetSessionId matches
  // this session, or as fallback when only one session exists.
  /**
   * feature-comms 请求面去抖保存：2s 窗口合并连续请求（连续标注只写一次
   * 盘），串行链保证自身重入不交错；与 callFinished / step auto-save 的
   * 并发保存由快照语义兜底（后写胜出，双方均为有效快照）。disposed 后静默
   * 不调度——remove() 的保存屏障已覆盖去抖窗口内的变更。
   */
  scheduleCommsSave() {
    if (this.disposed) return;
    if (this._commsSaveTimer) clearTimeout(this._commsSaveTimer);
    this._commsSaveTimer = setTimeout(() => {
      this._commsSaveTimer = null;
      if (this.disposed || !this.agent || !this.sessionId) return;
      this._commsSaveChain = this._commsSaveChain
        .then(() => this.agent.saveSession(this.sessionId, sessionStore))
        .catch((error) => {
          console.warn('[ProtoClaw Runtime] feature-comms 去抖保存失败:', error?.message || error);
        });
    }, 2000);
  }

  /**
   * feature-comms 定向请求的进程内分发：返回给发起方的 result 对象。
   * 两条传输面共用——本地父子 IPC（handleActiveIPC）与容器/外部形态的
   * viewer host-request 通道（main 的 setHostRequestHandler），行为保持
   * 一致（含成功请求后的去抖补存：idle 期没有 callFinished 保存点）。
   */
  async dispatchFeatureCommsRequest(msg) {
    const feature = this.agent?.features?.get?.(msg.featureId)
      || this.agent?.getFeature?.(msg.featureId);
    if (typeof feature?.onHostRequest !== 'function') {
      return { ok: false, code: 'operation_unavailable', error: 'Feature does not handle host requests' };
    }
    try {
      const result = await feature.onHostRequest(msg.requestType, msg.payload, { channelId: msg.channelId, sessionId: this.sessionId });
      // ok:false 是 feature 明确的业务失败，无状态变更可言，不调度保存。
      if (result?.ok !== false) this.scheduleCommsSave();
      return result;
    } catch (error) {
      return { ok: false, code: 'operation_failed', error: String(error?.message || error) };
    }
  }

  handleIPC(msg) {
    if (!msg || typeof msg !== 'object') return Promise.resolve();
    if (this.disposed) {
      if (msg.requestId && process.connected) {
        const type = msg.type === 'feature-comms-request' ? 'feature-comms-result'
          : String(msg.type).startsWith('capability-') ? 'capability-result'
          : String(msg.type).replace(/-(control|status|request)$/, '-result');
        const error = { ok: false, code: 'session_closing', error: 'Session is closing' };
        process.send({ type, requestId: msg.requestId, sessionId: this.sessionId,
          ...error, ...(type === 'feature-comms-result' ? { result: error } : {}) });
      }
      return Promise.resolve();
    }
    const request = this.handleActiveIPC(msg);
    this._hostRequests.add(request);
    void request.finally(() => this._hostRequests.delete(request)).catch(() => {});
    return request;
  }

  async handleActiveIPC(msg) {
    if (!msg || typeof msg !== 'object') return;

    // ── tool / feature / hook enable-disable ──
    if (msg.type === 'tool-state') {
      const { scope, action } = msg;
      if (action !== 'enable' && action !== 'disable') return;
      try {
        if (scope === 'hook') {
          // hook 分支：不需要 name
          const { lifecycle, featureName, methodName } = msg;
          if (!lifecycle || !featureName || !methodName) return;

          if (typeof this.agent?.[`${action}Hook`] !== 'function') {
            console.warn(`[ProtoClaw Runtime] tool-state: agent.${action}Hook not available`);
            return;
          }
          this.agent[`${action}Hook`](lifecycle, featureName, methodName);
          console.log(`[ProtoClaw Runtime] ✓ Hook ${lifecycle}:${featureName}.${methodName} ${action}d`);
        } else if (scope === 'feature') {
          const { name } = msg;
          if (!name) return;
          if (typeof this.agent?.[action] !== 'function') {
            console.warn(`[ProtoClaw Runtime] tool-state: agent.${action} not available`);
            return;
          }
          this.agent[action](name);
          console.log(`[ProtoClaw Runtime] ✓ Feature '${name}' ${action}d`);
        } else {
          // scope='tool'（默认）
          const { name } = msg;
          if (!name) return;
          if (!this.agent?.tools || typeof this.agent.tools[action] !== 'function') {
            console.warn(`[ProtoClaw Runtime] tool-state: tools.${action} not available`);
            return;
          }
          this.agent.tools[action](name);
          console.log(`[ProtoClaw Runtime] ✓ Tool '${name}' ${action}d`);
        }
      } catch (err) {
        console.error(`[ProtoClaw Runtime] tool-state error:`, err);
      }
      return;
    }

    // ── Runtime IPC（todo-control / IM 线路热更新）──
    // ADR-0042：mount-im-carrier / unmount-im-carrier 已退役（载体挂载随
    // 线程寻址取消）。线路配置变更改由 reload-im-lines 触发门户按配置对账：
    // 只重连变化的线路，不重启 runtime、不打断进行中的轮次。
    if (msg.type === 'todo-control') {
      return this.runtimeIPC.handleIPCMessage(msg);
    }
    if (msg.type === 'reload-im-lines' && typeof this.agent?.reloadPortalLines === 'function') {
      try {
        const connected = await this.agent.reloadPortalLines();
        console.log('[ProtoClaw Runtime] ✓ IM 线路已按新配置对账:', JSON.stringify(connected));
      } catch (error) {
        console.error('[ProtoClaw Runtime] IM 线路对账失败:', error?.message || error);
      }
      return;
    }

    // ── adopt-thread-head: 换头后宿主推送线程身份（ADR-0047 阶段 5）──
    // successor 在 READY 门前拉起时不是 head，spawn 身份不含线程；宿主在
    // 换头提交后调用本分支，Agent 采纳身份并向 Viewer 重注册，fencing
    // 对齐后线程指令才可投递。带 requestId 时回执（requestRuntimeAck 等待）。
    if (msg.type === 'adopt-thread-head') {
      const adopted = await this.agent?.adoptThreadHeadIdentity?.({
        threadId: msg.threadId,
        headGeneration: msg.headGeneration,
        sessionId: msg.sessionId,
      });
      if (msg.requestId && process.connected) {
        process.send({
          type: 'adopt-thread-head-result',
          requestId: msg.requestId,
          sessionId: this.sessionId,
          ok: Boolean(adopted?.ok),
          ...(adopted?.ok ? {} : { error: adopted?.error || 'adopt-thread-head failed' }),
        });
      }
      if (adopted?.ok) {
        console.log(`[ProtoClaw Runtime] ✓ 线程身份已采纳: thread=${msg.threadId} gen=${msg.headGeneration} session=${msg.sessionId}`);
      } else {
        console.error('[ProtoClaw Runtime] adopt-thread-head 失败:', adopted?.error || 'agent method unavailable');
      }
      return;
    }

    if (msg.type === 'feature-comms-request') {
      const result = await this.dispatchFeatureCommsRequest(msg);
      try {
        process.send({ type: 'feature-comms-result', requestId: msg.requestId, sessionId: this.sessionId, result });
      } catch {}
      return;
    }

    // ── Generic capability IPC (request/ack) ──────────────────
    // Registry 传输面：server /protoclaw/capability_invoke 与 /protoclaw/commands
    // 的子进程端点。宿主前端转发视为 slash 入口。原计划的"专用 IPC 分支由这
    // 里收编"已改道：force-continuation / context-guard / model-selection 的
    // 会话控制统一走上方 feature-comms-request 通用分支（onHostRequest
    // 请求面，ADR-0018 / ADR-0034）。
    if (msg.type === 'capability-invoke' || msg.type === 'capability-list-request') {
      await handleCapabilityIPC(this, msg, (payload) => {
        try {
          process.send({
            type: 'capability-result',
            requestId: msg.requestId,
            sessionId: this.sessionId,
            ...payload,
          });
        } catch {}
      });
    }

    // （force-continuation-control / -status 与 context-guard-control / -status
    //  专用 IPC 分支已收编退役：会话控制面板的本地路径改经 server 路由发
    //  feature-comms-request 消息形态（上方通用分支按 featureId 寻址
    //  feature.onHostRequest），宿主不再按 feature 名字写业务分支。）
  }

  // ── Dispose this session (does NOT exit the process) ────────
  remove() {
    if (!this._removePromise) this._removePromise = this.removeInternal();
    return this._removePromise;
  }

  async removeInternal() {
    this.disposed = true;
    this.inputLoopRunning = false;
    // 去抖窗口内的变更由下方 saveSession 覆盖；清掉 pending 定时器，
    // 避免 remove 保存完成后再多跑一次写盘。
    if (this._commsSaveTimer) { clearTimeout(this._commsSaveTimer); this._commsSaveTimer = null; }
    let persisted = true;

    if (this.agent) {
      // Settle calls and admitted host mutations before the final snapshot. Both
      // shared and isolated runtimes acknowledge only after this whole sequence.
      if (this.callArbiter) await this.callArbiter.close();
      else await this.agent.quiesce();
      await Promise.allSettled([...this._hostRequests]);
      await this._commsSaveChain;
      if (this.sessionId) {
        try {
          await this.agent.saveSession(this.sessionId, sessionStore);
        } catch (error) {
          persisted = false;
          console.error(`[ProtoClaw Runtime] 保存会话失败 (session=${this.sessionId}):`, error);
        }
      }

      try {
        await this.agent.dispose();
      } catch (error) {
        // dispose 只释放资源，其失败不影响已落盘快照的完整性：保存屏障的
        // persisted 只反映保存结果，不得因释放失败把已成功的保存误报为失败
        // （rotation 伪失败路径之一）。
        console.error(`[ProtoClaw Runtime] 释放资源失败 (session=${this.sessionId}):`, error);
      }
    }
    return persisted;
  }
}

// 会话关闭单飞：remove-session、输入循环结束、退役等路径可能并发关闭同一
// 会话。若无单飞，第二次调用里 remove() 因 disposed 立即返回 false，会在
// 首次保存仍在途时提前发出 persisted:false 的 session-exited，让服务端把
// 正在成功的保存误判为失败（ADR-0026 保存屏障被伪失败击穿）。并发调用复用
// 同一关闭 Promise 与同一次通知。
const closingSessions = new Map();

async function closeHostedSession(sessionId, { notify = true, expectedSession = null } = {}) {
  const session = sessions.get(sessionId);
  // Session ID survives restart; callbacks from a retired instance must not
  // dispose the replacement instance now stored under the same persistent ID.
  if (!session || (expectedSession && session !== expectedSession)) return false;
  const inFlight = closingSessions.get(sessionId);
  if (inFlight) return inFlight;
  const closePromise = (async () => {
    try {
      const persisted = await session.remove();
      sessions.delete(sessionId);
      if (notify && process.connected) {
        try {
          await new Promise((resolve, reject) => {
            process.send({ type: 'session-exited', sessionId, persisted }, error => error ? reject(error) : resolve());
          });
        } catch (error) {
          console.warn(`[ProtoClaw Runtime] session-exited 通知失败 (session=${sessionId}):`, error?.message || error);
        }
      } else if (notify && REGISTER_MODE) {
        // ADR-0037 M6：容器形态的 session 级退役上报（平台转发为容器 handle
        // 的 session-exited 语义事件，宿主消费面与本地 IPC 同构）。
        const viewerAgentId = session.agent?.agentId ?? null;
        if (viewerAgentId) {
          try {
            await postJson('/protoclaw/runtime/exited', { viewerAgentId, sessionId, persisted });
          } catch (error) {
            console.warn(`[ProtoClaw Runtime] session-exited 上报失败 (session=${sessionId}):`, error?.message || error);
          }
        }
      }
      if (sessions.size === 0) {
        console.log('[ProtoClaw Runtime] 最后一个 session 已退出，关闭进程');
        process.exit(0);
      }
      return true;
    } finally {
      closingSessions.delete(sessionId);
    }
  })();
  closingSessions.set(sessionId, closePromise);
  return closePromise;
}

// ── Process-level signal handlers ─────────────────────────────
let processDisposing = false;

async function disposeAllSessions(exitCode = 0) {
  if (processDisposing) return;
  processDisposing = true;

  const allSessions = Array.from(sessions.values());
  sessions.clear();

  await Promise.allSettled(allSessions.map(s => s.remove()));
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void disposeAllSessions(0);
});

process.on('SIGTERM', () => {
  void disposeAllSessions(0);
});


// ── SessionLifecycle: start + runInputLoop ────────────────────
// (Continuation of SessionLifecycle class methods — defined here
//  after postJson and all helpers are available in module scope.)

SessionLifecycle.prototype.start = async function () {
  const workspaceCwd = WORKSPACE_BOUND_AGENT_IDS.has(agentId)
    ? (agentId === 'programming-helper' && this.sessionId
      ? this.workspaceCwd
      : (this.workspaceCwd || (await resolveWorkspaceCwd(agentId, this.sessionId))))
    : resolveDesktopWorkspace();
  if (agentId === 'programming-helper' && this.sessionId && !workspaceCwd) {
    throw new Error(`Programming Helper session ${this.sessionId} requires an explicit workspace directory`);
  }
  if (agentId === 'agent-studio' && !workspaceCwd) {
    throw new Error('Agent Studio 需要先选择项目目录。');
  }

  const agentModule = await import(pathToFileURL(agentJsPath).href);
  const metadata = JSON.parse(readFileSync(join(agentPath, 'metadata.json'), 'utf8'));
  let boundAgentId;
  let sessionProjectId = '';
  if (this.sessionId) {
    // ADR-0036 + ADR-0037 容器修订：本地经 session-access 直读（父进程写侧
    // 同一存储）；容器形态经 lookupSessionRecord 走平台 HTTP（WAL 锁跨不过
    // 容器边界，容器不直连 index.db）。记录缺失语义不变：
    // "Session index record not found"。
    const record = await lookupSessionRecord(agentId, this.sessionId);
    if (!record) throw new Error(`Session index record not found: ${this.sessionId}`);
    boundAgentId = record.workspaceAgentId === undefined ? 'main' : record.workspaceAgentId;
    // PH 项目会话归属（ticket 043）：逐实例注入，agent 构造函数据此选项目配置层
    // （禁止进程级缓存——同进程多 session 归属可能不同）。
    sessionProjectId = cleanValue(record?.projectId);
  }
  const declaration = resolveWorkspaceAgent(metadata, boundAgentId);
  this.runtime.workspaceAgentId = declaration.id;
  if (metadata.agents !== undefined) this.agentName = workspaceAgentDisplayName(declaration);
  const AgentClass = resolveWorkspaceAgentClass(agentModule, declaration.id);

  // coder 是独立 APP（ADR-0025）：模型配置走自己的 agent-configs/coder.json。
  const modelOptions = agentId === 'coder'
    ? { userConfigPath: AGENT_USER_CONFIG_PATH('coder') }
    : {};
  // OAuth 启动预刷新：在 async 上下文先把将过期的 token 刷新落盘，再进入同步
  // resolve（见 preflightAgentOAuthRefresh 注释）。
  await preflightAgentOAuthRefresh(agentPath, modelOptions.userConfigPath);
  // 启动解析是构造期一次性注入（agent 尚未创建）；运行期切换统一走
  // agent.setModel / setThinkingEffort，消费注入的 modelPresetResolver。
  const resolved = resolveAgentModelLLM(agentPath, 'default', modelOptions) || resolveGlobalDefaultLLM();
  this.agent = new AgentClass({
    name: this.agentName,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir: workspaceCwd || PROTOCLAW_ROOT,
    runtime: this.runtime,
    // 会话身份由宿主一次性注入（ADR-0022）：feature 据此向 server 回写会话级绑定
    agentId,
    sessionId: this.sessionId || undefined,
    runtimeInputIdentity: {
      runtimeInstanceId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(process.env.PROTOCLAW_THREAD_ID ? { threadId: process.env.PROTOCLAW_THREAD_ID } : {}),
      ...(Number.isInteger(Number(process.env.PROTOCLAW_HEAD_GENERATION)) && Number(process.env.PROTOCLAW_HEAD_GENERATION) > 0
        ? { headGeneration: Number(process.env.PROTOCLAW_HEAD_GENERATION) }
        : {}),
    },
    serverOrigin: SERVER_ORIGIN,
    // PH 项目归属（ticket 043）：目录会话不传（undefined），保持旧构造面不变
    ...(sessionProjectId ? { projectId: sessionProjectId } : {}),
    // contextGuard 只是首轮调用前的兜底种子（启动预设的窗口期快照）；
    // 阈值真相是会话当前模型的 live meta，feature 每轮 CallStart /
    // onLLMSwap 都会重算，不依赖这里的快照。
    ...((agentId === 'programming-helper' || agentId === 'agent-studio') ? {
      contextGuard: {
        contextLength: resolved?.contextLength ?? null,
        compressRatio: resolved?.compressRatio ?? 80,
      },
    } : {}),
    ...(resolved ? { llm: resolved.llm } : {}),
    modelResolver: modelPresetResolver,
  });
  // Propagate agent reference to extracted module contexts
  this.ipcCtx.agent = this.agent;
  this.summaryCtx.agent = this.agent;
  if (resolved) {
    if (typeof this.agent.setLLM === 'function') {
      this.agent.setLLM(resolved.llm, {
        modelName: resolved.modelName,
        contextLength: resolved.contextLength,
        compressRatio: resolved.compressRatio,
        presetName: resolved.presetName,
        thinkingEffort: resolved.thinkingEffort || null,
        ...(resolved.provider ? { provider: resolved.provider } : {}),
        source: 'boot',
      });
    }
    console.log(`[ProtoClaw Runtime] Using model preset from metadata.json => ${resolved.modelName}`);
    try {
      const ctx = typeof this.agent.getSystemContext === 'function' ? this.agent.getSystemContext() : this.agent._systemContext;
      if (ctx) ctx.SYSTEM_CURRENT_MODEL = resolved.modelName;
    } catch {}
  } else {
    const fallbackModelName = this.agent?.llm?.modelName;
    if (fallbackModelName) {
      console.log(`[ProtoClaw Runtime] No model preset found, using agent LLM model => ${fallbackModelName}`);
    }
  }

  if (this.runtimeHandoff?.handoff && (this.runtimeHandoff.handoff.sourceSummary || this.runtimeHandoff.handoff.seedMessages?.length)) {
    // 框架标准 handoff seed feature（原 Claw context-handoff-seed 已下沉，见 docs/tickets/008）
    this.agent.use(new HandoffSeedFeature({
      handoff: this.runtimeHandoff.handoff,
    }));
    console.log(`[ProtoClaw Runtime] 已挂载 handoff seed (${this.runtimeHandoff.source})`);
  }

  // 用户 $mount 装配（feature 装配一期）：在官方静态装配与 handoff seed 之后、
  // prepareRuntime 之前追加挂载。runtime 创建时解析，运行中不热更新；解析/安装/
  // 同名冲突失败直接抛错终止启动（fail fast，不静默降级）。builtin 形态走
  // agent.js 的 builtinOptionalFeatures 工厂（官方可选插件），repository 形态
  // 走 tgz 装配链。
  if (this.agent.pendingFeatureMounts instanceof Map && this.agent.pendingFeatureMounts.size > 0) {
    // builtin 工厂表是 agent.js 的平表导出（键 = runtimeName），装配适用面
    // 由各 agent 自己声明——宿主不做任何身份推导（ADR-0025）。
    const builtinFactories = agentModule.builtinOptionalFeatures || {};
    const repositoryMounts = new Map();
    for (const [name, mount] of this.agent.pendingFeatureMounts) {
      // 禁用三态（ADR-0046）：enabled:false = 装配保留、三面整体下线——
      // 启动链不挂载 feature 面（UI 面/数据面由 server 侧同口径过滤）
      if (mount.enabled === false) {
        console.log(`[ProtoClaw Runtime] ⊘ 装配 '${name}' 已禁用（enabled:false），跳过挂载`);
        continue;
      }
      if (mount.kind !== 'builtin') {
        repositoryMounts.set(name, mount);
        continue;
      }
      const plugin = builtinFactories[name];
      if (!plugin) {
        throw new Error(`官方可选插件 '${name}' 未在本 agent 的 builtinOptionalFeatures 声明，无法挂载`);
      }
      if (this.agent.features?.has(name)) {
        throw new Error(`动态装配 Feature 名称冲突：${name}（Agent 已静态挂载同名 Feature）`);
      }
      const configValue = this.agent.config?.features?.[name];
      const instance = plugin.create(
        configValue && typeof configValue === 'object' ? configValue : {},
        { workspaceDir: this.agent.config?.workspaceDir || process.cwd() },
      );
      if (String(instance?.name || '') !== name) {
        throw new Error(`官方可选插件工厂产出 name '${instance?.name}' 与 $mount 键 '${name}' 不一致`);
      }
      await this.agent.mountFeature(instance, { strictInit: true });
      console.log(`[ProtoClaw Runtime] ✓ 官方可选 feature 已挂载: ${name}`);
    }
    if (repositoryMounts.size > 0) {
      const mounted = await mountUserConfiguredFeatures(this.agent, repositoryMounts, { agentId });
      console.log(`[ProtoClaw Runtime] ✓ 用户装配 feature 已挂载 (${mounted.length}): ${mounted.map((item) => `${item.name}@${item.package}`).join(', ')}`);
    }
  }

  if (typeof this.agent.prepareRuntime === 'function') {
    await this.agent.prepareRuntime();
  }

  if (workspaceCwd) {
    console.log(`[ProtoClaw Runtime] Workspace-bound agent environment => ${workspaceCwd}`);
  }

  console.log(`[ProtoClaw Runtime] Host workdir => ${process.cwd()}`);
  console.log(`[ProtoClaw Runtime] Agent 实例已创建: ${this.agentName}`);

  console.log(`[ProtoClaw Runtime] 正在连接到 ViewerWorker (端口 ${VIEWER_PORT})...`);
  if (this.sessionId && this.managedRuntimeIdentity && process.connected) {
    const identity = {
      type: 'runtime-identity',
      agentId: this.managedRuntimeIdentity.agentId,
      sessionId: this.managedRuntimeIdentity.sessionId,
      viewerAgentId: this.agent.agentId,
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        process.off('message', onMessage);
        reject(new Error('Managed runtime identity acknowledgement timed out'));
      }, 2000);
      const onMessage = (message) => {
        if (message?.type !== 'runtime-identity-accepted'
          || message.agentId !== this.managedRuntimeIdentity.agentId
          || message.sessionId !== this.sessionId
          || message.viewerAgentId !== this.agent.agentId) return;
        clearTimeout(timer);
        process.off('message', onMessage);
        resolve();
      };
      process.on('message', onMessage);
      process.send(identity, (error) => {
        if (!error) return;
        clearTimeout(timer);
        process.off('message', onMessage);
        reject(error);
      });
    });
  } else if (this.sessionId && this.managedRuntimeIdentity && REGISTER_MODE) {
    // ADR-0037 M6：容器形态的身份交接经注册协议（本地为上方 IPC 握手）。
    // viewerAgentId 已由框架分配（Agent 构造时），注册 accepted 即等价
    // runtime-identity-accepted。
    await registerManagedRuntimeWithPlatform(this.agent.agentId, this.managedRuntimeIdentity);
  }
  await this.agent.withViewer(this.agentName, VIEWER_PORT, false, {
    projectRoot: PROTOCLAW_ROOT,
  });
  console.log('[ProtoClaw Runtime] ✓ 已连接到 ViewerWorker');
  if (this.announceOnStdout) {
    console.log(`[ProtoClaw Runtime] Viewer Agent ID: ${this.agent.agentId ?? 'unknown'}`);
  }

  let sessionRestoreFailed = null;
  if (this.sessionId) {
    let sessionLoaded = false;
    try {
      await this.agent.loadSession(this.sessionId, sessionStore);
      sessionLoaded = true;
      const restoredMessages = this.agent.getContext?.()?.getAll?.();
      this.lastReportedMessageCount = Array.isArray(restoredMessages) ? restoredMessages.length : 0;
      console.log('[ProtoClaw Runtime] ✓ 已恢复会话: ' + this.sessionId);
    } catch (error) {
      // ADR-0034 决策 5：快照存在但损坏时禁止静默转新会话——原路径的
      // preInjectCallStart + saveSession 会覆盖原快照（不可逆丢失）。
      // 仅"快照不存在"（ENOENT）走新会话路径。
      const snapshotMissing = error?.code === 'ENOENT' || /ENOENT/i.test(String(error?.message || ''));
      if (snapshotMissing) {
        console.log('[ProtoClaw Runtime] 创建新会话: ' + this.sessionId);

        if (typeof this.agent['preInjectCallStart'] === 'function') {
          try {
            await this.agent['preInjectCallStart']();
            await this.agent.saveSession(this.sessionId, sessionStore);
            console.log('[ProtoClaw Runtime] ✓ preInjectCallStart 内容已落盘');
          } catch (error) {
            console.warn('[ProtoClaw Runtime] preInjectCallStart 失败:', error instanceof Error ? error.message : String(error));
          }
        }
      } else {
        sessionRestoreFailed = error;
        console.error(
          '[ProtoClaw Runtime] 会话快照恢复失败（保留原快照，将拒绝 READY）:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    // branch 注入消费（ADR-0034 决策 2）：分支快照的 featureStates 是边界历史值，
    // 源会话当前选择经注入文件（metadata.handoffPath，mode='branch'）传递——
    // loadSession 成功后仍导入（continuity 覆盖历史值）。接续 handoff 保持
    // 原条件（仅未 loadSession 时导入，避免覆盖已恢复快照中的会话自有状态）。
    const handoffMode = this.runtimeHandoff?.handoff?.mode;
    const shouldImportContinuity = this.runtimeHandoff?.handoff?.featureContinuity
      && (!sessionLoaded || handoffMode === 'branch');
    if (shouldImportContinuity) {
      try {
        const sourceSessionId = this.runtimeHandoff.handoff.sourceSessionId;
        const origin = {
          kind: handoffMode === 'branch' ? 'branch-import' : 'continuity-import',
          ...(sourceSessionId ? { sourceSessionId } : {}),
        };
        const imported = await importFeatureContinuity(this.agent, this.runtimeHandoff.handoff.featureContinuity, {
          sourceSessionId,
          origin,
        });
        if (imported.length > 0) {
          await this.agent.saveSession(this.sessionId, sessionStore);
          console.log(`[ProtoClaw Runtime] ✓ 已导入 continuity feature state (${origin.kind}): ${imported.join(', ')}`);
          // branch 注入文件一次性消费（正确性要求，非清理美化）：不删除的话，
          // 分支会话重启会再次按 branch-import 导入，把分支自己的当前选择
          // 覆盖回创建时刻的源值。接续 handoff 文件保持既有生命周期，不在此删。
          if (handoffMode === 'branch' && this.runtimeHandoff.source) {
            try {
              rmSync(this.runtimeHandoff.source, { force: true });
            } catch (error) {
              console.warn('[ProtoClaw Runtime] branch 注入文件删除失败:', error instanceof Error ? error.message : String(error));
            }
          }
        }
      } catch (error) {
        console.warn('[ProtoClaw Runtime] continuity feature state 导入失败:', error instanceof Error ? error.message : String(error));
      }
    }
    if (typeof this.agent.enableStepAutoSave === 'function') {
      this.agent.enableStepAutoSave(this.sessionId, sessionStore);
      console.log('[ProtoClaw Runtime] ✓ 已启用 step 级自动保存');
    }
  } else {
    console.log('[ProtoClaw Runtime] 当前未绑定对话会话，运行在工作空间首页模式。');
  }

  // Push restored state to Viewer
  try {
    const context = typeof this.agent.getContext === 'function' ? this.agent.getContext() : null;
    const messages = context ? context.getAll() : [];
    // enriched 侧时间戳随基线一并下发：恢复推送不带时间表时，debug-hub 会按
    // "无时间锚"填全 null，会话历史的时间分隔线将整体丢失。
    const timestamps = context && typeof context.getTimestamps === 'function'
      ? context.getTimestamps()
      : undefined;
    this.agent['pushToDebug']?.(messages, timestamps);
    this.agent['syncRegisteredToolsToDebug']?.();
    this.agent['pushInspectorSnapshot']?.();
    this.agent['pushOverviewSnapshot']?.();
  } catch (error) {
    console.warn('[ProtoClaw Runtime] 恢复会话后同步调试状态失败:', error);
  }

  // ── 阶段三：READY 门禁（ADR-0034 决策 5）──
  // 快照损坏恢复失败：拒绝 READY（不覆盖任何会话文件），进程经 main catch
  // 以非零码退出，server spawn 失败处理链接管。
  if (sessionRestoreFailed) {
    throw new Error(
      `会话快照恢复失败，拒绝启动（原快照未改动）: ${sessionRestoreFailed instanceof Error ? sessionRestoreFailed.message : String(sessionRestoreFailed)}`,
    );
  }
  // 无可用模型（启动 resolve 失败、agent 构造未注入默认、恢复也未绑定）：
  // 会话无法服务，拒绝 READY。首页模式（无 sessionId）不拦——首页是零配置
  // 用户进入设置配模型的入口，不消费模型。
  if (this.sessionId && !this.agent.llm) {
    throw new Error('No model available: 启动模型解析失败且会话恢复未绑定任何模型');
  }

  if (this.announceOnStdout) {
    console.log('[ProtoClaw Runtime] READY session=' + (this.sessionId || 'none'));
  }

  // ── CallArbiter ──
  this.callArbiter = new CallArbiter(this.agent);
  // 上下文过界的两个策略壳都需要仲裁器执行「打断当前轮 + 退回排队消息」。
  for (const guardFeatureName of ['context-guard', 'context-rotation-trigger']) {
    const guardFeature = this.agent.features?.get?.(guardFeatureName);
    if (guardFeature && typeof guardFeature.setCallArbiter === 'function') {
      guardFeature.setCallArbiter(this.callArbiter);
    }
  }

  // 插话时序修复 v3（2026-11-05）：call 启动即撤销已武装的输入 lease，
  // 维持不变式「call 运行 ⇒ 无武装 lease」。非 lease 来源（rotation 接续
  // 通报经邮箱、IM/调度 envelope）启动的 call 运行期间，若输入循环的
  // lease 仍武装，viewer 的 lease 转交路径会把忙时插话截给陈旧 lease——
  // 输入循环把它回投邮箱时，会被直接入队的后续插话越过，FIFO 倒置
  //（实测 1.5/1.75 倒序）。撤销后忙时插话只落队列一条路，顺序由队列
  // 保证。lease 来源的 call 启动时其 lease 已被应答消费，无挂起请求，
  // 此处为 no-op；ask_user_choice 等工具级输入只在 call 内部挂起，而
  // arbiter 串行保证 callStarted 时不存在 call 内挂起请求，不会被误撤。
  this.callArbiter.on('callStarted', () => {
    try {
      DebugHub.getInstance().cancelInputRequests(
        this.agent?.agentId,
        'call started; input lease retired while call is running',
      );
    } catch {
      // 无 viewer 连接（无头/一shot）时无 lease 可撤，静默。
    }
  });

  // Per-agent interrupt handler
  const self = this;
  DebugHub.getInstance().setInterruptHandler(this.agent?.agentId, async (_targetAgentId, clearQueue, cancelledCommands) => {
    if (!self.callArbiter) return;
    const result = self.callArbiter.interruptActive('cancelled by interrupt', { clearQueue });
    if (Array.isArray(cancelledCommands) && cancelledCommands.length > 0) {
      await self.cancelThreadCommands(cancelledCommands);
    }
    if (result.active || result.cleared > 0 || cancelledCommands?.length > 0) {
      console.log(`[ProtoClaw Runtime] interrupt marked active=${result.active}, cleared=${result.cleared}, cancelledCommands=${cancelledCommands?.length || 0}`);
    }
  });

  // turn 号契约（完整定义见 turn-event-mapping.js 头注释）：0-based，
  // = Agent._callIndex。callStarted 由 CallArbiter._kick() 同步 emit、
  // envelope 实际执行（executeCall 内 _callIndex 递增）在其后异步发生，
  // 故此处读到的 _callIndex 尚未递增，+1 对齐本次 call 号；callFinished
  // 时递增已完成，直接用 _callIndex。同一 turn 两事件同号。
  this.callArbiter.on('callStarted', (envelope) => {
    const startEvent = {
      type: 'turn.started',
      turn: typeof self.agent?._callIndex === 'number' ? self.agent._callIndex + 1 : null,
      source: envelope?.source || null,
      // 输入身份（ADR-0031 步骤一）：观察器把本回合关联回触发它的提交；
      // 身份未知时为 null，消费端不得据空值猜测
      sourceRef: envelope?.sourceRef || null,
    };
    // 应用订阅面同样收到开始事件（ADR-0041 决策 3），与终态事件同构。
    self.turnEvents.emit({
      ...startEvent,
      agentId,
      sessionId: self.sessionId,
      runtimeInstanceId,
    });
    return self.reportThreadEvent(startEvent);
  });

  this.callArbiter.on('callFinished', (envelope) => {
    if (!self.sessionId) return;

    // Capture the completed call's data before the next call mutates context.
    const context = typeof self.agent.getContext === 'function' ? self.agent.getContext() : null;
    const messages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
    const lastMessage = [...messages].reverse().find((m) => m && typeof m.content === 'string' && m.role !== 'system') || null;
    const preview = lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '';
    const usageStats = typeof self.agent.getUsage === 'function' ? self.agent.getUsage().toSnapshot() : null;
    const totalUsage = usageStats?.totalUsage;
    const callIndex = typeof self.agent?._callIndex === 'number' ? self.agent._callIndex : null;
    const callSummary = Array.isArray(usageStats?.calls)
      ? usageStats.calls.find((call) => call?.callIndex === callIndex)
      : null;
    const llmMeta = typeof self.agent?.getLLMMeta === 'function' ? self.agent.getLLMMeta() : {};
    const usageEvents = callSummary?.totalUsage && callIndex !== null
      ? buildCallUsageEvents({
          agentId,
          sessionId: self.sessionId,
          runtimeInstanceId,
          callIndex,
          callSummary,
          llmMeta,
          context: {
            contextInputTokens: usageStats?.lastRequestUsage?.inputTokens || 0,
            messageCount: messages.length,
          },
        })
      : [];
    const metaPayload = {
      agentId,
      sessionId: self.sessionId,
      messageCount: messages.length,
      preview,
      tokenUsage: {
        inputTokens: totalUsage?.inputTokens || 0,
        outputTokens: totalUsage?.outputTokens || 0,
        totalTokens: totalUsage?.totalTokens || 0,
        lastRequestUsage: usageStats?.lastRequestUsage || null,
      },
      ...(llmMeta.modelName ? { modelName: llmMeta.modelName } : {}),
      contextLength: llmMeta.contextLength ?? undefined,
      compressRatio: llmMeta.compressRatio ?? undefined,
      savedAt: Date.now(),
    };
    const turnEvent = mapEnvelopeToTurnEvent(envelope, {
      turn: callIndex,
      usage: usageStats?.lastRequestUsage || null,
    });
    // 应用订阅面（ADR-0041 决策 3）：在终态确定的同一时刻同步广播，带上
    // 完整身份。刻意放在上报链之外——上报链受服务端可达性影响，应用订阅者
    // 不应因为 viewer 不可达而收不到回合事实；反过来，订阅者抛错也不会
    // 影响保存与上报（总线内部逐订阅者隔离）。
    self.turnEvents.emit({
      ...turnEvent,
      agentId,
      sessionId: self.sessionId,
      runtimeInstanceId,
    });
    const barrier = self.agent.saveSession(self.sessionId, sessionStore).catch((error) => {
      console.warn('[ProtoClaw Runtime] 保存 session 失败:', error.message);
    });

    enqueueOrderedProjection(self, '_postCallSyncChain', async () => {
      await self.reportSessionItemsForTurn(messages);
      await self.reportThreadEvent(turnEvent);
      for (const event of usageEvents) {
        if (reportedUsageEventIds.has(event.eventId)) continue;
        reportedUsageEventIds.add(event.eventId);
        const usageResult = await reportUsageEvent(SERVER_ORIGIN, event);
        if (usageResult?.ok === false) {
          console.warn('[ProtoClaw Runtime] usage event sync failed:', usageResult.error || usageResult.status);
        }
      }
      await fetch(`${SERVER_ORIGIN}/protoclaw/session_meta_sync`, {
        method: 'POST',
        headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(metaPayload),
      });
    }, (error) => {
      console.warn('[ProtoClaw Runtime] post-call projection sync failed:', error?.message || error);
    });
    return barrier;
  });

  if (typeof this.agent.setCallArbiter === 'function') {
    this.agent.setCallArbiter(this.callArbiter);
  }
  // 应用订阅入口（ADR-0041 决策 3）：Agent 宿主可选实现 setTurnEventBus，
  // 装配层据此把总线转交给 Feature。不实现时总线只服务宿主自身的观测，
  // 现有 agent.js 无需改动。总线只报告事实，订不订阅、订阅后做什么由应用决定。
  if (typeof this.agent.setTurnEventBus === 'function') {
    this.agent.setTurnEventBus(this.turnEvents);
  }

  this.callArbiter.sessionSaveFn = async () => {
    if (!self.sessionId) return;
    await self.agent.saveSession(self.sessionId, sessionStore);
  };

  console.log('[ProtoClaw Runtime] ✓ CallArbiter 已初始化');

  // ── IM Gateway（ADR-0042 决策 2：门户线路）──
  //
  // 门户 runtime 是全部线路渠道连接的持有者：按配置对账启动每条线路，随后
  // 订阅线程轮次事件作为出站通道。旧单渠道入口（startSelectedIMGateway）与
  // 「目标会话 runtime 挂载体」（mountIMLineCarrierIfBound）已退役——绑定是
  // 线程寻址，runtime 换头不该让平台连接跟着断。
  try {
    if (typeof this.agent.startPortalLines === 'function') {
      const carriers = await this.agent.startPortalLines();
      if (Array.isArray(carriers) && carriers.length === 0) {
        console.log('[ProtoClaw Runtime] • IM Gateway 未启动（无已配置渠道的线路），仅调试模式运行');
      } else {
        console.log(`[ProtoClaw Runtime] ✓ 已启动门户线路 (${carriers.join(', ')})`);
      }
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] IM Gateway 启动失败，已降级为仅调试运行:', error);
  }

  try {
    const dispatchFeature = this.agent.features?.get?.('claw-dispatch');
    if (dispatchFeature && typeof dispatchFeature.startDispatchLoop === 'function') {
      await dispatchFeature.startDispatchLoop(this.agent, this.callArbiter);
      console.log('[ProtoClaw Runtime] ✓ 已启动 ClawDispatch loop (via arbiter)');
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] ClawDispatch 启动失败:', error);
  }

  try {
    const gcBridgeFeature = this.agent.features?.get?.('group-chat-bridge');
    if (gcBridgeFeature && typeof gcBridgeFeature.startBridgeLoop === 'function') {
      await gcBridgeFeature.startBridgeLoop(this.agent, this.callArbiter);
      console.log('[ProtoClaw Runtime] ✓ 已启动 GroupChatBridge loop');
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] GroupChatBridge 启动失败:', error);
  }

  // ── Input loop ──
  const userInput = this.agent.features?.get?.('user-input');
  const hasUserInput = Boolean(userInput && typeof userInput.getUserInput === 'function');

  // ── Idle mailbox consumption loop（两种模式都装配）──
  // viewer 邮箱在 call 期间由 react-loop 步边界与 arbiter 安全网消费，
  // 空闲时无人消费。被动模式（无 UserInputFeature）的 user-turn 只能落
  // 邮箱，缺少此循环会投递成功但会话卡住；主动模式的 reminder 通报
  // （kind='reminder'，不响应 input lease）同样只在空闲邮箱等待消费。
  // 循环只在 arbiter idle 时 dequeue，与 lease 通道正交：真人输入走
  // lease 应答（input loop），机器通报走邮箱，互不抢占。
  this.passiveMailboxLoop = createPassiveMailboxLoop({
    agent: this.agent,
    callArbiter: this.callArbiter,
    isDisposed: () => this.disposed,
    viewerPort: VIEWER_PORT,
  });
  this.passiveMailboxLoop.run().catch(err => {
    console.error(`[ProtoClaw Runtime] 邮箱消费循环异常退出 (session=${this.sessionId}):`, err);
  });
  console.log('[ProtoClaw Runtime] ✓ 已启动邮箱消费循环 (viewer mailbox → arbiter)');
  // 入队通知 → 立即消费：viewer 在输入落盘成功后下发 queued-input-available
  // 帧（debug-hub 分发）。poke 只把下一次轮询提前，消费仍走 claim/dequeue
  // 完整协议；信号丢失时由上方轮询兜底。ADR-0047 后 durable command 不走
  // lease 直答，空闲态若无此触发，指令要等一个完整轮询相位才被领取。
  DebugHub.getInstance().setQueuedInputAvailableHandler(this.agent?.agentId, (notifyAgentId) => {
    if (notifyAgentId && this.agent?.agentId && notifyAgentId !== this.agent.agentId) return;
    this.passiveMailboxLoop?.poke();
  });

  if (!hasUserInput) {
    console.log('');
    console.log('当前 Agent 不使用 UserInputFeature，运行在被动事件模式。');
    // Keep the session alive without an input loop.
    // The process stays alive as long as pending IPC / DebugHub requests exist.
    return;
  }

  console.log('');
  console.log('等待调试界面输入...');

  // Start input loop asynchronously (non-blocking).
  // Multiple sessions can run their loops concurrently.
  this.runInputLoop(userInput).catch(err => {
    console.error(`[ProtoClaw Runtime] 输入循环异常 (session=${this.sessionId}):`, err);
  });
};

SessionLifecycle.prototype.runInputLoop = async function (userInput) {
  this.inputLoopRunning = true;

  // 输入动作（如回退）处理失败时，失败原因经下一轮输入请求的 placeholder
  // 呈现给用户；不带回显，失败只进日志，用户侧表现为"点击无反应"。
  // 提示只跟随下一次弹出的输入框，请求建立后即恢复常规提示。
  let inputPrompt = INPUT_PROMPT;

  while (this.inputLoopRunning) {
    // 忙时不武装新的输入 lease（插话时序修复 v2，2026-11-05）：call 运行
    // 期间（无论由 lease 应答、rotation 接续通报还是 IM/调度 envelope 启动）
    // 用户输入的正确通道是 viewer 邮箱——react-loop 步边界注入（插话锚点）
    // 与 arbiter 安全网兜底。此期间若武装 lease，viewer 的「lease 转交」
    // 路径会把邮箱队首（正是刚回投的插话）立刻转回 lease，形成应答→回投
    // →转交→应答的毫秒级热循环；等回 idle 再武装，循环在源头不存在。
    if (this.callArbiter) {
      const gate = await waitForArbiterIdle({
        getStatus: () => this.callArbiter.getStatus(),
        isCancelled: () => this.disposed || !this.inputLoopRunning,
      });
      if (gate === 'cancelled') break;
    }
    let response;
    try {
      response = await userInput.getUserInputEvent(inputPrompt, undefined, this.getNextTurnActions());
    } catch (error) {
      // Disposing the instance aborts its input lease intentionally, not as a
      // recoverable input failure. Do not schedule a retired loop to retry.
      if (this.disposed || !this.inputLoopRunning) break;
      // 插话时序修复 v3：call 启动撤销武装 lease（见 callStarted 钩子）与
      // interrupt/unregister 都以 AbortError 结算挂起的输入请求——属预期
      // 生命周期事件，静默回到顶部闸门（忙则等空闲，闲则重新武装）。
      if (error?.name === 'AbortError') {
        continue;
      }
      console.error('[ProtoClaw Runtime] 等待用户输入失败，稍后重试:', error);
      await sleep(500);
      continue;
    }
    inputPrompt = INPUT_PROMPT;

    let handled;
    try {
      if (this.disposed || !this.inputLoopRunning) break;
      const action = this.summaryHandlers.handleInputResponse(userInput, response);
      this._hostRequests.add(action);
      try { handled = await action; }
      finally { this._hostRequests.delete(action); }
      if (this.disposed || !this.inputLoopRunning) break;
    } catch (error) {
      console.error('[ProtoClaw Runtime] 处理输入动作失败，已忽略本次请求:', error);
      console.error(error?.stack || error);
      // 回退失败时恢复用户在回退对话框中编辑的草稿（成功路径由
      // rollbackToCallAndSave 内部回填，失败路径走不到那里）。
      if (response?.kind === 'action' && response?.actionId === 'rollback_to_call'
        && typeof response?.payload?.draftInput === 'string') {
        userInput.setNextDraftInput(response.payload.draftInput);
      }
      // 失败原因记录后随下一次 lease actions 广播（getNextTurnActions 一次性
      // 携带，前端 toast 呈现）——只有 placeholder 时用户几乎不可见。
      this._lastActionError = String(error?.message || error).slice(0, 200);
      inputPrompt = `上次操作失败: ${String(error?.message || error).slice(0, 160)}。可直接重试或继续输入: `;
      continue;
    }

    if (handled.kind === 'continue') {
      continue;
    }

    if (handled.kind === 'exit') {
      console.log(`[ProtoClaw Runtime] 收到退出指令 (session=${this.sessionId})，正在关闭该 session...`);
      break;
    }

    try {
      // 竞态安全网（插话时序修复，2026-11-05）：idle 等待放行到 lease 应答
      // 之间，call 可能恰好由非 lease 来源启动（rotation 接续通报落邮箱后经
      // passive 循环、IM/调度 envelope）。此时直接 enqueue 会被 AgentBase
      // 串行化排在活跃 call 之后，消息直到 call 结束才落地（整数下一轮），
      // 且与邮箱路径的后续消息倒序。改投 viewer 邮箱，由步边界注入；本循环
      // 顶部随后停在 idle 等待，不会形成回投热循环。投递失败退回原路径
      // （延迟到 call 结束但不丢失）。
      if (this.callArbiter.getStatus().status !== 'idle') {
        const agentIdForMailbox = this.agent?.agentId;
        if (agentIdForMailbox) {
          const routed = await postUserTurnToViewerMailbox({
            agentId: agentIdForMailbox,
            viewerPort: VIEWER_PORT,
            turn: {
              text: handled.text,
              source: 'viewer-input',
              ...(handled.sourceRef ? { sourceRef: handled.sourceRef } : {}),
              ...(Array.isArray(handled.images) && handled.images.length > 0 ? { images: handled.images } : {}),
              ...(Array.isArray(handled.capabilityActivations) && handled.capabilityActivations.length > 0
                ? { capabilityActivations: handled.capabilityActivations }
                : {}),
              ...(handled.metadata && typeof handled.metadata === 'object' && Object.keys(handled.metadata).length > 0
                ? { metadata: handled.metadata }
                : {}),
            },
          });
          if (routed.ok) {
            if (routed.delivery !== 'queued') {
              console.warn(`[ProtoClaw Runtime] 忙时插话回投邮箱得到非预期 delivery=${routed.delivery}（消息不丢，时序语义待查）`);
            }
            continue;
          }
          console.error('[ProtoClaw Runtime] 忙时插话回投邮箱失败，退回 envelope 排队（将延迟到 call 结束）:',
            routed.status ?? '', routed.error ?? '');
        }
      }
      const entry = this.callArbiter.enqueue({
        source: 'viewer-input',
        text: handled.text,
        // 输入身份（ADR-0031 步骤一）：lease 直投路径的 sourceRef 随
        // envelope 流入 turn 事件，观察器据此关联回触发提交
        ...(handled.sourceRef ? { sourceRef: handled.sourceRef } : {}),
        ...(Array.isArray(handled.images) && handled.images.length > 0 ? { images: handled.images } : {}),
        ...(Array.isArray(handled.capabilityActivations) && handled.capabilityActivations.length > 0
          ? { capabilityActivations: handled.capabilityActivations }
          : {}),
        ...(handled.metadata && typeof handled.metadata === 'object' && Object.keys(handled.metadata).length > 0
          ? { metadata: handled.metadata }
          : {}),
      });
      await this.callArbiter.waitForCompletion(entry.id);
    } catch (error) {
      console.error('[ProtoClaw Runtime] CallArbiter 入队失败:', error);
    }
  }

  // Input loop ended — remove this session and notify the server.
  await closeHostedSession(this.sessionId, { expectedSession: this });
};

// ── Central IPC dispatcher ────────────────────────────────────
process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  // ── add-session: request process to load a new session ──
  if (msg.type === 'add-session') {
    const requestedSessionId = cleanValue(msg.sessionId);
    const newSessionId = sanitizeSessionFragment(requestedSessionId);
    if (!requestedSessionId || sessions.has(newSessionId)) {
      process.send({ type: 'session-error', sessionId: newSessionId, error: 'session already exists or invalid sessionId' });
      return;
    }
    const newSession = new SessionLifecycle({
      sessionId: newSessionId,
      managedRuntimeIdentity: {
        agentId,
        sessionId: newSessionId,
        enabled: Boolean(process.connected && process.env.PROTOCLAW_PREBUILT_AGENT_ID === agentId),
      },
      agentName: msg.agentName || agentName,
      workspaceCwd: msg.workspaceCwd || null,
      runtimeHandoff: msg.handoffPath ? loadRuntimeHandoffFromPath(msg.handoffPath) : null,
      runtime: msg.runtime,
    });
    sessions.set(newSessionId, newSession);
    try {
      await newSession.start();
      process.send({ type: 'session-ready', sessionId: newSessionId, viewerAgentId: newSession.agent?.agentId ?? null });
    } catch (err) {
      console.error(`[ProtoClaw Runtime] add-session 失败 (session=${newSessionId}):`, err);
      await newSession.remove();
      sessions.delete(newSessionId);
      process.send({ type: 'session-error', sessionId: newSessionId, error: String(err?.message || err) });
      if (sessions.size === 0) process.exit(1);
    }
    return;
  }

  // ── remove-session: request process to remove a session ──
  if (msg.type === 'remove-session') {
    const targetId = sanitizeSessionFragment(msg.sessionId || '');
    await closeHostedSession(targetId);
    return;
  }

  // ── Session-scoped IPC: route by __targetSessionId ──
  const targetSessionId = msg.__targetSessionId;
  if (targetSessionId) {
    const session = sessions.get(sanitizeSessionFragment(targetSessionId));
    if (session) {
      session.handleIPC(msg);
    } else {
      console.warn(`[ProtoClaw Runtime] IPC 路由失败：session ${targetSessionId} 不存在`);
    }
    return;
  }

  // ── Legacy fallback: single session mode ──
  // When no __targetSessionId is specified and only one session exists,
  // route to that session (backward compatibility with existing server-side IPC).
  if (sessions.size === 1) {
    const [onlySession] = sessions.values();
    onlySession.handleIPC(msg);
  } else if (sessions.size > 1) {
    console.warn(`[ProtoClaw Runtime] IPC 消息缺少 __targetSessionId 且存在多个 session (${sessions.size})，已丢弃: ${msg.type}`);
  }
});

// ── Helper for add-session handoff loading ────────────────────
function loadRuntimeHandoffFromPath(handoffPath) {
  if (!handoffPath || !existsSync(handoffPath)) return null;
  try {
    const fileContent = readFileSync(handoffPath, 'utf8');
    return {
      source: handoffPath,
      handoff: parseHandoffContent(fileContent, handoffPath),
    };
  } catch (err) {
    console.warn(`[ProtoClaw Runtime] 加载 handoff 失败 (${handoffPath}):`, err.message);
    return null;
  }
}

/**
 * OAuth 启动预刷新（票 0028A-5）：resolveAgentModelLLM 是同步契约，拿到的是
 * token 文件当下快照；进入同步 resolve 前先把将过期的 access_token 刷新落盘，
 * 启动 LLM 实例持有的才是新鲜 token。这里镜像 resolveAgentModelLLM 的 default
 * 槽位选择找到 OAuth provider（仅覆盖 agent preset 主路径，全局默认兜底不在
 * 预刷新范围）；刷新失败不阻断启动——回退旧快照，与既有 fire-and-forget 行为
 * 一致，relogin 清理由 oauth-codex 的后台路径完成。
 */
async function preflightAgentOAuthRefresh(agentDir, userConfigPath) {
  try {
    const metaPath = join(agentDir, 'metadata.json');
    if (!existsSync(metaPath)) return;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const agentId = agentDir.split(/[\\/]/).pop();
    const configPath = userConfigPath || AGENT_USER_CONFIG_PATH(agentId);
    let userConfig = {};
    if (existsSync(configPath)) {
      try { userConfig = JSON.parse(readFileSync(configPath, 'utf8')) || {}; } catch {}
    }
    const roleConfig = { ...(meta?.modelPresets || {}), ...(userConfig?.modelPresets || {}) }['default'];
    const presetName = typeof roleConfig === 'string' ? roleConfig : roleConfig?.primary || null;
    if (!presetName) return;
    const raw = JSON.parse(readFileSync(MODEL_PRESETS_PATH, 'utf8'));
    const preset = (Array.isArray(raw?.presets) ? raw.presets : []).find((p) => p.name === presetName);
    const provider = (Array.isArray(raw?.providers) ? raw.providers : []).find((p) => p.name === preset?.providerName);
    if (provider?.authType !== 'oauth-codex') return;
    const refreshed = await preflightRefreshTokens(provider.name, provider.clientId);
    if (refreshed) {
      console.log(`[ProtoClaw Runtime] OAuth token pre-refreshed for provider "${provider.name}"`);
    }
  } catch (error) {
    console.warn('[ProtoClaw Runtime] OAuth 启动预刷新跳过:', error?.message || error);
  }
}

// ── Main: process host ────────────────────────────────────────
async function main() {
  if (REGISTER_MODE) {
    // ADR-0037 M6：容器形态的优雅停止通道——平台经 Viewer 连接下发
    // stop-agent，宿主侧对齐本地 SIGTERM 语义。收尾必须经
    // closeHostedSession（持久化 + 容器形态的 exited 上报 + 全部退出后
    // 关闭进程），不能走 disposeAllSessions 的裸 session.remove()——
    // 那条路不上报，宿主的停止持久化确认会失败（E2E S4b 实测）。
    // 本地形态不经此通道（宿主直接发信号 / IPC remove-session），不注册。
    DebugHub.getInstance().setStopHandler(() => {
      console.log('[ProtoClaw Runtime] 收到 stop-agent 指令，优雅退出');
      const active = Array.from(sessions.keys());
      void Promise.allSettled(active.map(id => closeHostedSession(id)))
        .finally(() => {
          if (!process.exitCode) process.exit(0);
        });
    });
  }
  // ADR-0037 开放点通道化：宿主定向请求回调。容器/外部 runtime 无父子
  // IPC，宿主的定向请求（feature-comms 与 capability 请求面）经 ViewerWorker 连接的
  // host-request 通道下发到这里；本地 runtime 同样注册——宿主对本地
  // handle 仍优先走 IPC，两轨语义一致由共用 dispatchFeatureCommsRequest
  // 保证。
  DebugHub.getInstance().setHostRequestHandler(async (payload) => {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, code: 'invalid_request', error: 'Malformed host request payload' };
    }
    const targetSessionId = String(payload.sessionId || '');
    const target = sessions.get(targetSessionId);
    if (!target) {
      return { ok: false, code: 'session_not_found', error: `Session ${targetSessionId || '(empty)'} is not hosted by this runtime` };
    }
    if (target.disposed) {
      return { ok: false, code: 'session_closing', error: 'Session is closing' };
    }
    if (payload.kind === 'feature-comms') return target.dispatchFeatureCommsRequest(payload);
    if (payload.kind === 'capability') return dispatchCapabilityRequest(target, payload);
    return { ok: false, code: 'unsupported_host_request', error: `Unsupported host request kind: ${String(payload.kind)}` };
  });
  // ADR-0037 D（cwd 注入通道通用化）：宿主注入的显式值优先于索引 / state.json
  // 解析——容器执行环境把宿主绝对路径映射为 /workspace 后经 env 下发，runtime
  // 不再依赖宿主路径的可达性。assembly 形态不注入该 env（spawn 点不设置），
  // 走 assembly 分支不受影响。resolveWorkspaceCwd 已 async 化（索引读在容器
  // 形态走平台 HTTP）。
  let workspaceCwd;
  if (WORKSPACE_BOUND_AGENT_IDS.has(agentId)) {
    const injectedCwd = cleanValue(process.env.PROTOCLAW_SESSION_WORKSPACE_CWD);
    if (agentId === 'programming-helper' && sessionId) {
      workspaceCwd = injectedCwd;
    } else {
      workspaceCwd = injectedCwd || (await resolveWorkspaceCwd(agentId, sessionId));
    }
  } else {
    workspaceCwd = resolveDesktopWorkspace();
  }
  const runtimeHandoff = loadRuntimeHandoff();

  const initialSession = new SessionLifecycle({
    sessionId,
    agentName,
    managedRuntimeIdentity: {
      agentId,
      sessionId,
      enabled: process.env.PROTOCLAW_PREBUILT_AGENT_ID === agentId
      && process.env.PROTOCLAW_PREBUILT_SESSION_ID === sessionId,
    },
    workspaceCwd,
    runtimeHandoff,
    announceOnStdout: true,
    runtime: {
      sessionType: process.env.PROTOCLAW_SESSION_TYPE || null,
      gcChatId: process.env.PROTOCLAW_GC_CHAT_ID || null,
      modelPresetRole: process.env.PROTOCLAW_MODEL_PRESET_ROLE || null,
    },
  });
  sessions.set(sessionId, initialSession);
  await initialSession.start();

  // If the session uses passive mode (no UserInputFeature), start()
  // returns and the process stays alive via DebugHub pending requests.
  // If the session has an input loop, it runs async and the event loop
  // stays alive via getUserInputEvent's pending request.
}

main().catch(async (error) => {
  console.error('[ProtoClaw Runtime] 启动失败:', error);
  await disposeAllSessions(1);
});
