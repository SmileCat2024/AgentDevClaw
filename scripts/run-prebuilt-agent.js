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
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { DebugHub, FileSessionStore, HandoffSeedFeature } from '@agentdevjs/core';
import { setTimeout as sleep } from 'timers/promises';
import { importFeatureContinuity } from '../server/context-continuity/feature-continuity.js';
import { resolveAgentModelLLM, resolveModelPresetLLM, resolveGlobalDefaultLLM } from '../server/model-preset-resolver.js';
import { buildModelUsageMeta, reportUsageEvent } from './usage-report.js';
import { mapEnvelopeToTurnEvent } from './turn-event-mapping.js';
import { CallArbiter, setDebugHubClass } from '../server/call-arbiter.js';
import { createIMBridge } from './runtime-im-bridge.js';
import { handleCapabilityIPC } from './capability-ipc.js';
import { createSummaryHandlers } from './runtime-summary.js';
import { createPassiveMailboxLoop } from './runtime-passive-mailbox.js';
import { WORKSPACE_SESSION_AGENT_IDS } from '../server/shared/constants.js';

// Inject DebugHub into the extracted CallArbiter module
setDebugHubClass(DebugHub);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const VIEWER_PORT = parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';
const NO_SESSION_TOKEN = '__protoclaw-no-session__';
const HANDOFF_PATH_ENV = 'PROTOCLAW_HANDOFF_PATH';
const HANDOFF_PAYLOAD_ENV = 'PROTOCLAW_HANDOFF_PAYLOAD';
// 权威集合来自 server/shared/constants.js（服务端与子进程必须同源）
const WORKSPACE_BOUND_AGENT_IDS = WORKSPACE_SESSION_AGENT_IDS;
const PREBUILT_AGENT_MAX_TOKENS_CAP = 8000; // 预制 agent maxTokens 上限（应与 server/shared/constants.js 保持一致）
const runtimeInstanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const reportedUsageEventIds = new Set();

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseHandoffContent(raw, sourceLabel) {
  const text = cleanValue(raw);
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      return { sourceSummary: parsed, seedMessages: [] };
    }
    if (parsed && typeof parsed === 'object') {
      const seedMessages = Array.isArray(parsed.seedMessages)
        ? parsed.seedMessages
            .filter((message) => {
              if (!message || typeof message !== 'object') return false;
              const role = typeof message.role === 'string' ? message.role.trim() : '';
              if (!role) return false;
              const hasContent = message.content != null && message.content !== '';
              const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
              return hasContent || hasToolCalls;
            })
            .map((message) => ({
              ...message,
              role: message.role.trim(),
              turn: Number.isFinite(message.turn) ? Number(message.turn) : null,
            }))
        : [];
      const sourceSummary = cleanValue(
        parsed.sourceSummary
        || parsed.summaryText
        || parsed.summary
        || parsed.handoffSummary
        || parsed.text,
      );
      if (seedMessages.length === 0 && !sourceSummary) {
        throw new Error('missing seedMessages/sourceSummary');
      }
      return {
        packageId: cleanValue(parsed.packageId || parsed.handoffId),
        sourceSessionId: cleanValue(parsed.sourceSessionId),
        sourceSummary,
        seedMessages,
        mode: cleanValue(parsed.mode),
        policy: parsed.policy && typeof parsed.policy === 'object' ? parsed.policy : {},
        importantFiles: Array.isArray(parsed.compactOutput?.importantFiles)
          ? parsed.compactOutput.importantFiles.filter(f => typeof f === 'string')
          : [],
        importantSkills: Array.isArray(parsed.compactOutput?.importantSkills)
          ? parsed.compactOutput.importantSkills.filter(s => typeof s === 'string')
          : [],
        fileRanges: typeof parsed.compactOutput?.fileRanges === 'object' && parsed.compactOutput.fileRanges !== null
          ? parsed.compactOutput.fileRanges
          : {},
        featureContinuity: parsed.featureContinuity && typeof parsed.featureContinuity === 'object'
          ? parsed.featureContinuity
          : null,
      };
    }
  } catch (error) {
    if (sourceLabel === HANDOFF_PAYLOAD_ENV) {
      return { sourceSummary: text, seedMessages: [] };
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      throw new Error(`解析 handoff 内容失败 (${sourceLabel}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { sourceSummary: text, seedMessages: [] };
}

function loadRuntimeHandoff() {
  const payloadText = cleanValue(process.env[HANDOFF_PAYLOAD_ENV]);
  if (payloadText) {
    return {
      source: HANDOFF_PAYLOAD_ENV,
      handoff: parseHandoffContent(payloadText, HANDOFF_PAYLOAD_ENV),
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

function resolveAgentClass(agentModule) {
  if (typeof agentModule.default === 'function') {
    return agentModule.default;
  }

  for (const exported of Object.values(agentModule)) {
    if (typeof exported === 'function') {
      return exported;
    }
  }

  return null;
}

function getWorkspaceStatePath(agentId) {
  return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', sanitizeSessionFragment(agentId), 'state.json');
}

function getSessionIndexPath(agentId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const sessionRoot = WORKSPACE_BOUND_AGENT_IDS.has(normalizedAgentId)
    ? join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', normalizedAgentId, 'sessions')
    : join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions', normalizedAgentId);
  return join(sessionRoot, 'index.json');
}

function resolveSessionWorkspaceCwd(agentId, sessionId) {
  const normalizedSessionId = cleanValue(sessionId);
  if (!normalizedSessionId || normalizedSessionId === NO_SESSION_TOKEN) {
    return null;
  }

  const indexPath = getSessionIndexPath(agentId);
  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const record = sessions.find((session) => sanitizeSessionFragment(session?.id) === sanitizeSessionFragment(normalizedSessionId));
    const openDirectory = cleanValue(record?.openDirectory);
    if (!openDirectory || !existsSync(openDirectory)) {
      return null;
    }
    return openDirectory;
  } catch (error) {
    console.warn('[ProtoClaw Runtime] 读取 session 工作目录失败:', error);
    return null;
  }
}

function resolveWorkspaceCwd(agentId, sessionId = '') {
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
  const sessionCwd = resolveSessionWorkspaceCwd(agentId, sessionId);
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
  ? join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', sanitizeSessionFragment(agentId), 'sessions')
  : join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions', sanitizeSessionFragment(agentId));
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
    headers: {
      'content-type': 'application/json',
    },
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
    this.resolved = null;
    this.resolvedUsageModel = null;
    this.disposed = false;
    this.inputLoopRunning = false;
    this.passiveMailboxLoop = null;
    this.lastReportedMessageCount = 0;

    // Per-session bridge contexts (shared by reference with extracted modules)
    this.imBridgeCtx = {
      agentId,
      sessionId: this.sessionId,
      SERVER_ORIGIN,
      agent: null,
      callArbiter: null,
    };
    this.summaryCtx = {
      agentId,
      sessionId: this.sessionId,
      PREBUILT_AGENT_MAX_TOKENS_CAP,
      agent: null,
      sessionStore,
      postJson,
    };
    this.imBridge = createIMBridge(this.imBridgeCtx);
    this.summaryHandlers = createSummaryHandlers(this.summaryCtx);
  }

  getNextTurnActions() {
    const checkpoints = Array.isArray(this.agent?._callCheckpoints) ? this.agent._callCheckpoints : [];
    if (checkpoints.length === 0) return undefined;
    const availableCallIndices = checkpoints.map(cp => cp.callIndex);
    return NEXT_TURN_ACTIONS.map(action => ({
      ...action,
      data: { availableCallIndices },
    }));
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

  async reportSessionItemsForTurn() {
    if (!this.sessionId) return;
    const messages = Array.isArray(this.agent?.getContext?.()?.getAll?.())
      ? this.agent.getContext().getAll()
      : [];
    const pending = messages.slice(this.lastReportedMessageCount);
    for (const message of pending) {
      const turn = Number.isInteger(message?.turn) ? message.turn : null;
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
  async handleIPC(msg) {
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

    // ── IM bridge messages (carrier mount/unmount, todo-control) ──
    if (msg.type === 'mount-im-carrier' || msg.type === 'unmount-im-carrier' || msg.type === 'todo-control' || msg.type === 'todo-force-continue') {
      this.imBridge.handleIPCMessage(msg);
      return;
    }

    // ── Generic capability IPC (request/ack) ──────────────────
    // Registry 传输面：server /protoclaw/capability_invoke 与 /protoclaw/commands
    // 的子进程端点。宿主前端转发视为 slash 入口。后续可控 feature 的专用
    // IPC 分支（force-continuation / context-guard 同构模式）由这里收编。
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
      return;
    }

    // ── Force-continuation session control (request/ack) ──
    // The server route waits for a force-continuation-result reply carrying the
    // same requestId + sessionId, so the panel can render the authoritative
    // Feature state from this session runtime.
    if (msg.type === 'force-continuation-control' || msg.type === 'force-continuation-status') {
      const reply = (payload) => {
        try {
          process.send({
            type: 'force-continuation-result',
            requestId: msg.requestId,
            sessionId: this.sessionId,
            ...payload,
          });
        } catch {}
      };
      const feature = (this.agent?.features?.get?.('force-continuation'))
        || (typeof this.agent?.getFeature === 'function' ? this.agent.getFeature('force-continuation') : null);
      if (!feature) {
        reply({ ok: false, error: 'force-continuation feature not mounted in this session' });
        return;
      }
      try {
        if (msg.type === 'force-continuation-control') {
          if (typeof msg.enabled === 'boolean') feature.setEnabled(msg.enabled);
          if (msg.triggers && typeof msg.triggers === 'object') feature.setTriggers(msg.triggers);
          if (typeof msg.maxConsecutiveContinuations === 'number' && typeof feature.setMaxConsecutive === 'function') {
            feature.setMaxConsecutive(msg.maxConsecutiveContinuations);
          }
        }
        reply({ ok: true, status: feature.getStatus() });
      } catch (err) {
        reply({ ok: false, error: String(err?.message || err) });
      }
      return;
    }

    // ── Context-guard session control (interactive fuse, request/ack) ──
    // 会话控制面板的「上下文拦截」开关：与 force-continuation 同构的
    // request/ack 链路，feature 仍是权威状态持有者。
    if (msg.type === 'context-guard-control' || msg.type === 'context-guard-status') {
      const reply = (payload) => {
        try {
          process.send({
            type: 'context-guard-result',
            requestId: msg.requestId,
            sessionId: this.sessionId,
            ...payload,
          });
        } catch {}
      };
      const feature = (this.agent?.features?.get?.('context-guard'))
        || (typeof this.agent?.getFeature === 'function' ? this.agent.getFeature('context-guard') : null);
      if (!feature) {
        reply({ ok: false, error: 'context-guard feature not mounted in this session' });
        return;
      }
      try {
        if (msg.type === 'context-guard-control' && typeof msg.armed === 'boolean') {
          feature.setArmed(msg.armed);
        }
        reply({ ok: true, status: feature.getStatus() });
      } catch (err) {
        reply({ ok: false, error: String(err?.message || err) });
      }
      return;
    }

    // ── model / thinking hot-swap ──
    if (msg.type !== 'swap-model' && msg.type !== 'swap-thinking') return;

    if (typeof this.agent?.setLLM !== 'function') {
      console.warn(`[ProtoClaw Runtime] ${msg.type}: agent.setLLM not available (framework too old)`);
      return;
    }

    let presetName;
    let overrides;

    if (msg.type === 'swap-model') {
      presetName = msg.presetName;
      if (!presetName || typeof presetName !== 'string') {
        console.error('[ProtoClaw Runtime] swap-model: no presetName in IPC payload');
        return;
      }
      overrides = undefined;
    } else {
      presetName = this.resolved?.presetName;
      if (!presetName) {
        console.error('[ProtoClaw Runtime] swap-thinking: cannot determine current presetName');
        return;
      }
      overrides = { thinkingEffort: msg.thinkingEffort };
    }

    const isMidTurn = typeof this.agent.isRunning === 'function' && this.agent.isRunning();
    const newResolved = resolveModelPresetLLM(presetName, overrides);
    if (!newResolved?.llm) {
      console.error(`[ProtoClaw Runtime] ${msg.type}: failed to resolve preset "${presetName}"`);
      return;
    }

    const oldName = this.resolved?.modelName || this.resolvedUsageModel?.modelName || 'unknown';
    this.agent.setLLM(newResolved.llm, {
      modelName: newResolved.modelName,
      contextLength: newResolved.contextLength,
      compressRatio: newResolved.compressRatio,
      presetName: newResolved.presetName,
      thinkingEffort: newResolved.thinkingEffort || null,
    });

    this.resolved = newResolved;
    this.resolvedUsageModel = newResolved;

    const detail = msg.type === 'swap-thinking'
      ? ` (effort: ${msg.thinkingEffort || 'default'})`
      : '';
    console.log(`[ProtoClaw Runtime] ✓ ${msg.type === 'swap-model' ? 'Model' : 'Thinking'} swapped: ${oldName}${detail}${isMidTurn ? ' (mid-turn)' : ''}`);
  }

  // ── Dispose this session (does NOT exit the process) ────────
  async remove() {
    if (this.disposed) return;
    this.disposed = true;
    this.inputLoopRunning = false;

    if (this.agent) {
      if (this.sessionId) {
        if (typeof this.agent.disableStepAutoSave === 'function') {
          this.agent.disableStepAutoSave();
        }
        try {
          await this.agent.saveSession(this.sessionId, sessionStore);
        } catch (error) {
          console.error(`[ProtoClaw Runtime] 保存会话失败 (session=${this.sessionId}):`, error);
        }
      }

      try {
        await this.agent.dispose();
      } catch (error) {
        console.error(`[ProtoClaw Runtime] 释放资源失败 (session=${this.sessionId}):`, error);
      }
    }
  }
}

async function closeHostedSession(sessionId, { notify = true } = {}) {
  const session = sessions.get(sessionId);
  if (!session) return false;
  await session.remove();
  sessions.delete(sessionId);
  if (notify && process.connected) {
    try {
      process.send({ type: 'session-exited', sessionId });
    } catch (error) {
      console.warn(`[ProtoClaw Runtime] session-exited 通知失败 (session=${sessionId}):`, error?.message || error);
    }
  }
  if (sessions.size === 0) {
    console.log('[ProtoClaw Runtime] 最后一个 session 已退出，关闭进程');
    process.exit(0);
  }
  return true;
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
  const workspaceCwd = agentId === 'programming-helper' && this.sessionId
    ? this.workspaceCwd
    : (this.workspaceCwd || resolveWorkspaceCwd(agentId, this.sessionId));
  if (agentId === 'programming-helper' && this.sessionId && !workspaceCwd) {
    throw new Error(`Programming Helper session ${this.sessionId} requires an explicit workspace directory`);
  }

  const agentModule = await import(pathToFileURL(agentJsPath).href);
  // Agent module can export a session-type-aware dispatcher; fall back to the
  // default-export heuristic for single-class agents.
  const AgentClass = typeof agentModule.resolveAgentClass === 'function'
    ? agentModule.resolveAgentClass({ runtime: this.runtime })
    : resolveAgentClass(agentModule);

  if (!AgentClass) {
    throw new Error(`无法在 ${agentJsPath} 中找到 Agent 类导出`);
  }

  // coder sessions keep a standalone model config under agent-configs/coder.json
  // even though they now live inside the programming-helper workspace.
  const modelOptions = this.runtime.sessionType === 'coder'
    ? { userConfigPath: join(PROTOCLAW_ROOT, '.agentdev', 'agent-configs', 'coder.json') }
    : {};
  this.resolved = resolveAgentModelLLM(agentPath, 'default', modelOptions) || resolveGlobalDefaultLLM();
  this.resolvedUsageModel = this.resolved || null;
  this.agent = new AgentClass({
    name: this.agentName,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir: workspaceCwd || PROTOCLAW_ROOT,
    runtime: this.runtime,
    // contextGuard 只是首轮调用前的兜底种子（启动预设的窗口期快照）；
    // 阈值真相是会话当前模型的 live meta，feature 每轮 CallStart /
    // onLLMSwap 都会重算，不依赖这里的快照。
    ...((agentId === 'programming-helper' || agentId === 'agent-studio') ? {
      contextGuard: {
        contextLength: this.resolved?.contextLength ?? null,
        compressRatio: this.resolved?.compressRatio ?? 80,
      },
    } : {}),
    ...(this.resolved ? { llm: this.resolved.llm } : {}),
  });
  // Propagate agent reference to extracted module contexts
  this.imBridgeCtx.agent = this.agent;
  this.summaryCtx.agent = this.agent;
  if (this.resolved) {
    if (typeof this.agent.setLLM === 'function') {
      this.agent.setLLM(this.resolved.llm, {
        modelName: this.resolved.modelName,
        contextLength: this.resolved.contextLength,
        compressRatio: this.resolved.compressRatio,
        presetName: this.resolved.presetName,
        thinkingEffort: this.resolved.thinkingEffort || null,
      });
    }
    console.log(`[ProtoClaw Runtime] Using model preset from metadata.json => ${this.resolved.modelName}`);
    try {
      const ctx = typeof this.agent.getSystemContext === 'function' ? this.agent.getSystemContext() : this.agent._systemContext;
      if (ctx) ctx.SYSTEM_CURRENT_MODEL = this.resolved.modelName;
    } catch {}
  } else {
    const fallbackModelName = this.agent?.llm?.modelName;
    if (fallbackModelName) {
      this.resolvedUsageModel = { modelName: fallbackModelName };
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

  if (typeof this.agent.prepareRuntime === 'function') {
    await this.agent.prepareRuntime();
  }

  if (workspaceCwd) {
    console.log(`[ProtoClaw Runtime] Workspace-bound agent environment => ${workspaceCwd}`);
  }

  console.log(`[ProtoClaw Runtime] Host workdir => ${process.cwd()}`);
  console.log(`[ProtoClaw Runtime] Agent 实例已创建: ${this.agentName}`);

  console.log(`[ProtoClaw Runtime] 正在连接到 ViewerWorker (端口 ${VIEWER_PORT})...`);
  await this.agent.withViewer(this.agentName, VIEWER_PORT, false, {
    projectRoot: PROTOCLAW_ROOT,
  });
  console.log('[ProtoClaw Runtime] ✓ 已连接到 ViewerWorker');
  if (this.announceOnStdout) {
    console.log(`[ProtoClaw Runtime] Viewer Agent ID: ${this.agent.agentId ?? 'unknown'}`);
  }

  if (this.sessionId) {
    let sessionLoaded = false;
    try {
      await this.agent.loadSession(this.sessionId, sessionStore);
      sessionLoaded = true;
      const restoredMessages = this.agent.getContext?.()?.getAll?.();
      this.lastReportedMessageCount = Array.isArray(restoredMessages) ? restoredMessages.length : 0;
      console.log('[ProtoClaw Runtime] ✓ 已恢复会话: ' + this.sessionId);
    } catch {
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
    }
    if (!sessionLoaded && this.runtimeHandoff?.handoff?.featureContinuity) {
      try {
        const imported = await importFeatureContinuity(this.agent, this.runtimeHandoff.handoff.featureContinuity, {
          sourceSessionId: this.runtimeHandoff.handoff.sourceSessionId,
        });
        if (imported.length > 0) {
          await this.agent.saveSession(this.sessionId, sessionStore);
          console.log(`[ProtoClaw Runtime] ✓ 已导入 continuity feature state: ${imported.join(', ')}`);
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
    const messages = typeof this.agent.getContext === 'function' ? this.agent.getContext().getAll() : [];
    this.agent['pushToDebug']?.(messages);
    this.agent['syncRegisteredToolsToDebug']?.();
    this.agent['pushInspectorSnapshot']?.();
    this.agent['pushOverviewSnapshot']?.();
  } catch (error) {
    console.warn('[ProtoClaw Runtime] 恢复会话后同步调试状态失败:', error);
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
  this.imBridgeCtx.callArbiter = this.callArbiter;

  // Per-agent interrupt handler
  const self = this;
  DebugHub.getInstance().setInterruptHandler(this.agent?.agentId, (_targetAgentId, clearQueue) => {
    if (!self.callArbiter) return;
    const result = self.callArbiter.interruptActive('cancelled by interrupt', { clearQueue });
    if (result.active || result.cleared > 0) {
      console.log(`[ProtoClaw Runtime] interrupt marked active=${result.active}, cleared=${result.cleared}`);
    }
  });

  // turn 号契约（完整定义见 turn-event-mapping.js 头注释）：0-based，
  // = Agent._callIndex。callStarted 由 CallArbiter._kick() 同步 emit、
  // envelope 实际执行（executeCall 内 _callIndex 递增）在其后异步发生，
  // 故此处读到的 _callIndex 尚未递增，+1 对齐本次 call 号；callFinished
  // 时递增已完成，直接用 _callIndex。同一 turn 两事件同号。
  this.callArbiter.on('callStarted', (envelope) => {
    void self.reportThreadEvent({
      type: 'turn.started',
      turn: typeof self.agent?._callIndex === 'number' ? self.agent._callIndex + 1 : null,
      source: envelope?.source || null,
    });
  });

  this.callArbiter.on('callFinished', (envelope) => {
    void (async () => {
      await self.reportSessionItemsForTurn();
      const usage = typeof self.agent.getUsage === 'function'
        ? self.agent.getUsage().toSnapshot()?.lastRequestUsage || null
        : null;
      // envelope → turn.* 的映射契约集中在 turn-event-mapping.js（宿主策略：
      // completed+content_filter/refusal 改判不可重试失败；cancelled 是生命周期信号）
      await self.reportThreadEvent(
        mapEnvelopeToTurnEvent(envelope, {
          turn: typeof self.agent?._callIndex === 'number' ? self.agent._callIndex : null,
          usage,
        }),
      );
    })();
    if (!self.sessionId) return;
    self.agent.saveSession(self.sessionId, sessionStore).then(async () => {
      try {
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
        if (callSummary?.totalUsage && callIndex !== null) {
          const usageEventId = [
            'agent-call',
            agentId,
            self.sessionId,
            runtimeInstanceId,
            callIndex,
            callSummary.endTime || Date.now(),
          ].join(':');
          if (!reportedUsageEventIds.has(usageEventId)) {
            reportedUsageEventIds.add(usageEventId);
            const usageResult = await reportUsageEvent(SERVER_ORIGIN, {
              eventId: usageEventId,
              timestamp: callSummary.endTime || Date.now(),
              source: 'agent-call',
              agentId,
              sessionId: self.sessionId,
              runtimeInstanceId,
              callIndex,
              requestCount: callSummary.stepCount || 1,
              cacheHitRequests: callSummary.cacheHitRequests || 0,
              model: buildModelUsageMeta(self.resolvedUsageModel, 'default'),
              usage: callSummary.totalUsage,
              context: {
                contextInputTokens: usageStats?.lastRequestUsage?.inputTokens || 0,
                messageCount: messages.length,
              },
            });
            if (usageResult?.ok === false) {
              console.warn('[ProtoClaw Runtime] usage event sync failed:', usageResult.error || usageResult.status);
            }
          }
        }
        await fetch(`${SERVER_ORIGIN}/protoclaw/session_meta_sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
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
            modelName: self.resolved?.modelName || self.resolvedUsageModel?.modelName || undefined,
            contextLength: self.resolved?.contextLength ?? undefined,
            compressRatio: self.resolved?.compressRatio ?? undefined,
            savedAt: Date.now(),
          }),
        });
      } catch (metaErr) {
        console.warn('[ProtoClaw Runtime] session meta sync failed (will auto-heal on next list):', metaErr.message);
      }
    }).catch(e => {
      console.warn('[ProtoClaw Runtime] 保存 session 失败:', e.message);
    });
  });

  this.callArbiter.on('callFinished', (envelope) => {
    self.imBridge.dispatchIMCallFinish(envelope).catch(err => {
      console.error('[ProtoClaw Runtime] IM callfinish delivery error:', err);
    });
  });

  if (typeof this.agent.setCallArbiter === 'function') {
    this.agent.setCallArbiter(this.callArbiter);
  }

  this.callArbiter.sessionSaveFn = async () => {
    if (!self.sessionId) return;
    await self.agent.saveSession(self.sessionId, sessionStore);
  };

  console.log('[ProtoClaw Runtime] ✓ CallArbiter 已初始化');

  // ── IM Gateway ──
  try {
    if (typeof this.agent.startSelectedIMGateway === 'function') {
      const channel = await this.agent.startSelectedIMGateway();
      if (channel === 'none') {
        console.log('[ProtoClaw Runtime] • IM Gateway 未启动（未选择渠道），仅调试模式运行');
      } else {
        console.log(`[ProtoClaw Runtime] ✓ 已启动 IM Gateway (${channel || 'unknown'})`);
      }
    } else if (typeof this.agent.startQQBotGateway === 'function') {
      await this.agent.startQQBotGateway();
      console.log('[ProtoClaw Runtime] ✓ 已启动 QQBot Gateway');
    } else {
      const qqbotFeature = this.agent.features?.get?.('qqbot');
      if (qqbotFeature && typeof qqbotFeature.startGateway === 'function') {
        await qqbotFeature.startGateway(this.agent);
        console.log('[ProtoClaw Runtime] ✓ 已启动 QQBot Gateway');
      }
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] IM Gateway 启动失败，已降级为仅调试运行:', error);
  }

  // If this session is bound to an IM line, mount the carrier feature + gateway
  await this.imBridge.mountIMLineCarrierIfBound();

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

  if (!hasUserInput) {
    console.log('');
    console.log('当前 Agent 不使用 UserInputFeature，运行在被动事件模式。');
    // 被动模式永不开 input lease，外部 user-turn 只能进 viewer 邮箱；
    // react-loop / arbiter 安全网仅在 call 期间消费邮箱，空闲时无人消费
    // 会导致投递成功但会话卡住（thread 指令）。此循环把邮箱作为又一个
    // 外部事件源接进 arbiter，与 dispatch / IM 桥接同构。
    this.passiveMailboxLoop = createPassiveMailboxLoop({
      agent: this.agent,
      callArbiter: this.callArbiter,
      isDisposed: () => this.disposed,
      viewerPort: VIEWER_PORT,
    });
    this.passiveMailboxLoop.run().catch(err => {
      console.error(`[ProtoClaw Runtime] 被动邮箱消费循环异常退出 (session=${this.sessionId}):`, err);
    });
    console.log('[ProtoClaw Runtime] ✓ 已启动被动邮箱消费循环 (viewer mailbox → arbiter)');
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

  while (this.inputLoopRunning) {
    let response;
    try {
      response = await userInput.getUserInputEvent(INPUT_PROMPT, undefined, this.getNextTurnActions());
    } catch (error) {
      console.error('[ProtoClaw Runtime] 等待用户输入失败，稍后重试:', error);
      await sleep(500);
      continue;
    }

    let handled;
    try {
      handled = await this.summaryHandlers.handleInputResponse(userInput, response);
    } catch (error) {
      console.error('[ProtoClaw Runtime] 处理输入动作失败，已忽略本次请求:', error);
      console.error(error?.stack || error);
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
      const entry = this.callArbiter.enqueue({
        source: 'viewer-input',
        text: handled.text,
        ...(Array.isArray(handled.images) && handled.images.length > 0 ? { images: handled.images } : {}),
        ...(Array.isArray(handled.capabilityActivations) && handled.capabilityActivations.length > 0
          ? { capabilityActivations: handled.capabilityActivations }
          : {}),
      });
      await this.callArbiter.waitForCompletion(entry.id);
    } catch (error) {
      console.error('[ProtoClaw Runtime] CallArbiter 入队失败:', error);
    }
  }

  // Input loop ended — remove this session and notify the server.
  await closeHostedSession(this.sessionId);
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

// ── Main: process host ────────────────────────────────────────
async function main() {
  const workspaceCwd = agentId === 'programming-helper' && sessionId
    ? cleanValue(process.env.PROTOCLAW_SESSION_WORKSPACE_CWD)
    : resolveWorkspaceCwd(agentId, sessionId);
  const runtimeHandoff = loadRuntimeHandoff();

  const initialSession = new SessionLifecycle({
    sessionId,
    agentName,
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
