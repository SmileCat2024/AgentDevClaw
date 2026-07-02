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
import { DebugHub, FileSessionStore } from 'agentdev';
import { setTimeout as sleep } from 'timers/promises';
import { buildClaudeCompactPrompt, stripCompactAnalysis, scanFilesAndSkills } from '../server/context-continuity/claude-compact-prompts.js';
import { importFeatureContinuity } from '../server/context-continuity/feature-continuity.js';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { buildModelUsageMeta, reportUsageEvent } from './usage-report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const VIEWER_PORT = parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';
const NO_SESSION_TOKEN = '__protoclaw-no-session__';
const HANDOFF_PATH_ENV = 'PROTOCLAW_HANDOFF_PATH';
const HANDOFF_PAYLOAD_ENV = 'PROTOCLAW_HANDOFF_PAYLOAD';
const WORKSPACE_BOUND_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);
const IS_EXPLORATION = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';
const runtimeInstanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const reportedUsageEventIds = new Set();
let resolvedUsageModel = null;

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

function resolveWorkspaceCwd(agentId) {
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

  // --- Project mode: use openDirectory from state ---
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

let agent = null;
let disposed = false;
let compactSummaryInFlight = false;

// ── CallArbiter: single entry point for agent.onCall() ────────────
//
// Guarantees that only one onCall() is active at a time per runtime.
// All sources (user input, dispatch, IM) must enqueue envelopes here
// instead of calling agent.onCall() directly.

class CallArbiter {
  constructor(agentInstance) {
    this._agent = agentInstance;
    this._queue = [];
    this._active = false;
    this._activeEnvelope = null;
    this._status = 'idle'; // idle | queued | running
    this._listeners = { callStarted: [], callFinished: [] };
    // Completion trackers: envelopeId → resolve callback
    this._completionCallbacks = new Map();

    // ── Continuation support ──
    // Session save callback for checkpoint/rollback barriers.
    // Set via `arbiter.sessionSaveFn = async () => { ... }`.
    this.sessionSaveFn = null;

    // Continuation budget limits (per envelope).
    this.continuationBudget = {
      maxSegments: 20,
      maxCheckpoints: 5,
      maxRollbacks: 3,
    };

    // ── Supplement buffer ──
    // When the agent is busy (call active), queued-input messages go here
    // instead of becoming new envelopes. They are drained at each step start
    // and injected as system messages inside the current call.
    this._supplementBuffer = [];
  }

  /**
   * Enqueue a call envelope and kick the processing loop.
   *
   * @param {{ id?: string, source: string, sourceRef?: string, text: string }} envelope
   * @returns {object} The envelope with assigned id and status
   */
  enqueue(envelope) {
    // When agent is busy and this is a queued-input (user supplement),
    // route to the supplement buffer instead of creating a new envelope.
    // The supplement will be injected as a system message inside the
    // current call at the next step start.
    if (this._active && envelope.source === 'queued-input') {
      const supp = {
        text: envelope.text,
        sourceRef: envelope.sourceRef || '',
        timestamp: Date.now(),
      };
      this._supplementBuffer.push(supp);
      console.log(`[CallArbiter] supplemented (sourceRef=${supp.sourceRef}, buffer=${this._supplementBuffer.length})`);
      return {
        id: envelope.id || `supp-${Date.now()}`,
        source: envelope.source,
        sourceRef: supp.sourceRef,
        text: envelope.text,
        status: 'supplemented',
        createdAt: supp.timestamp,
      };
    }

    const entry = {
      id: envelope.id || `arbiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source: envelope.source || 'unknown',
      sourceRef: envelope.sourceRef || '',
      text: envelope.text,
      status: 'queued',
      createdAt: Date.now(),
      result: null,
      error: null,
    };
    this._queue.push(entry);
    this._status = 'queued';
    console.log(`[CallArbiter] enqueued ${entry.id} (source=${entry.source}, queue=${this._queue.length})`);
    this._kick();
    return entry;
  }

  /**
   * Drain all pending supplements (called at each step start).
   * Also notifies the ViewerWorker to remove them from its queue display.
   * @returns {Array<{text: string, sourceRef: string}>} Drained supplements in order
   */
  drainSupplements() {
    if (this._supplementBuffer.length === 0) return [];
    const supplements = this._supplementBuffer.splice(0);
    if (this._agent?.agentId) {
      for (const supp of supplements) {
        if (supp.sourceRef) {
          try {
            DebugHub.getInstance().consumeQueuedInput(this._agent.agentId, supp.sourceRef);
          } catch (error) {
            console.warn('[CallArbiter] consumeQueuedInput for supplement failed:', error);
          }
        }
      }
    }
    console.log(`[CallArbiter] drained ${supplements.length} supplement(s)`);
    return supplements;
  }

  /**
   * Register a lifecycle event listener.
   * @param {'callStarted'|'callFinished'} event
   * @param {function} fn
   */
  on(event, fn) {
    if (this._listeners[event]) {
      this._listeners[event].push(fn);
    }
  }

  /**
   * Wait for a specific envelope to complete (status = completed or failed).
   * Returns a promise that resolves with the finished envelope.
   *
   * @param {string} envelopeId
   * @returns {Promise<object>}
   */
  waitForCompletion(envelopeId) {
    return new Promise((resolve) => {
      this._completionCallbacks.set(envelopeId, resolve);
    });
  }

  /** Get current arbiter status */
  getStatus() {
    return {
      status: this._status,
      queueLength: this._queue.length,
      activeEnvelopeId: this._activeEnvelope?.id || null,
    };
  }

  clearQueued(reason = 'cancelled by interrupt') {
    const removed = this._queue.splice(0, this._queue.length);
    for (const envelope of removed) {
      envelope.status = 'cancelled';
      envelope.error = reason;
      const cb = this._completionCallbacks.get(envelope.id);
      if (cb) {
        this._completionCallbacks.delete(envelope.id);
        cb(envelope);
      }
    }
    // Also clear pending supplements
    const clearedSupps = this._supplementBuffer.splice(0);
    this._status = this._active ? 'running' : 'idle';
    return removed.length + clearedSupps.length;
  }

  // -- Internal --

  _emit(event, envelope) {
    for (const fn of this._listeners[event] || []) {
      try { fn(envelope); } catch (err) {
        console.error(`[CallArbiter] ${event} listener error:`, err);
      }
    }
  }

  _kick() {
    if (this._active || this._queue.length === 0) return;
    // Dequeue and run
    this._active = true;
    this._activeEnvelope = this._queue.shift();
    this._status = 'running';

    const envelope = this._activeEnvelope;
    envelope.status = 'running';

    // Track continuation counters for this envelope
    envelope._segmentCount = 0;
    envelope._checkpointCount = 0;
    envelope._rollbackCount = 0;

    if (envelope.source === 'queued-input' && envelope.sourceRef && this._agent?.agentId) {
      try {
        DebugHub.getInstance().consumeQueuedInput(this._agent.agentId, envelope.sourceRef);
      } catch (error) {
        console.warn('[CallArbiter] consumeQueuedInput failed:', error);
      }
    }

    console.log(`[CallArbiter] executing ${envelope.id} (source=${envelope.source})`);
    this._emit('callStarted', envelope);

    // Run asynchronously so enqueue() returns immediately
    this._runEnvelope(envelope)
      .catch((err) => {
        envelope.status = 'failed';
        envelope.error = err instanceof Error ? err.message : String(err);
        console.error(`[CallArbiter] envelope ${envelope.id} failed:`, err);
      })
      .finally(() => {
        if (envelope.status === 'running') {
          // _runEnvelope completed without setting status (normal completion)
          envelope.status = 'completed';
        }
        this._active = false;

        // Convert leftover supplements to regular queued envelopes.
        // This happens when the call finishes before the next step could
        // drain them (e.g. agent completed at the current step).
        if (this._supplementBuffer.length > 0) {
          for (const supp of this._supplementBuffer) {
            this._queue.push({
              id: `arbiter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              source: 'queued-input',
              sourceRef: supp.sourceRef || '',
              text: supp.text,
              status: 'queued',
              createdAt: supp.timestamp || Date.now(),
              result: null,
              error: null,
            });
          }
          const count = this._supplementBuffer.length;
          this._supplementBuffer = [];
          console.log(`[CallArbiter] converted ${count} leftover supplement(s) to envelopes`);
        }

        this._status = this._queue.length > 0 ? 'queued' : 'idle';
        console.log(`[CallArbiter] finished ${envelope.id} (status=${envelope.status}, segments=${envelope._segmentCount || 0}, remaining=${this._queue.length})`);
        this._emit('callFinished', envelope);
        // Resolve any waitForCompletion() promises for this envelope
        const cb = this._completionCallbacks.get(envelope.id);
        if (cb) {
          this._completionCallbacks.delete(envelope.id);
          cb(envelope);
        }
        this._activeEnvelope = null;
        // Continue draining the queue
        this._kick();
      });
  }

  /**
   * Execute a logical envelope, which may consist of multiple sequential
   * onCall segments connected by checkpoint/rollback continuation requests.
   *
   * Each segment is a complete, non-recursive onCall().  Between segments,
   * the arbiter applies a barrier (checkpoint commit or rollback restore)
   * and then starts the next segment with an internal continuation input.
   *
   * The envelope is only "done" when a segment completes without registering
   * a continuation request, or when the continuation budget is exhausted.
   */
  async _runEnvelope(envelope) {
    let input = envelope.text;

    while (true) {
      // ── Budget enforcement ──
      envelope._segmentCount += 1;
      if (envelope._segmentCount > this.continuationBudget.maxSegments) {
        throw new Error(`Continuation budget exhausted: maxSegments=${this.continuationBudget.maxSegments} reached for envelope ${envelope.id}`);
      }

      // ── Execute one onCall segment ──
      const result = await this._agent.onCall(input);
      envelope.result = typeof result === 'string' ? result : '';

      // ── Check for continuation request ──
      const continuation = typeof this._agent.consumeContinuationRequest === 'function'
        ? this._agent.consumeContinuationRequest()
        : null;

      if (!continuation) {
        // Normal completion — no continuation requested
        envelope.status = 'completed';
        return;
      }

      console.log(`[CallArbiter] continuation request: kind=${continuation.kind}, checkpointId=${continuation.checkpointId} (envelope=${envelope.id})`);

      // ── Apply continuation barrier ──
      if (continuation.kind === 'checkpoint') {
        envelope._checkpointCount += 1;
        if (envelope._checkpointCount > this.continuationBudget.maxCheckpoints) {
          throw new Error(`Continuation budget exhausted: maxCheckpoints=${this.continuationBudget.maxCheckpoints} reached for envelope ${envelope.id}`);
        }

        await this._checkpointBarrier(continuation, envelope);
        this._injectContinuationSystemMessage('checkpoint', continuation);
        input = this._buildCheckpointContinuationInput(continuation);

      } else if (continuation.kind === 'rollback') {
        envelope._rollbackCount += 1;
        if (envelope._rollbackCount > this.continuationBudget.maxRollbacks) {
          throw new Error(`Continuation budget exhausted: maxRollbacks=${this.continuationBudget.maxRollbacks} reached for envelope ${envelope.id}`);
        }

        await this._rollbackBarrier(continuation, envelope);
        this._injectContinuationSystemMessage('rollback', continuation);
        input = this._buildRollbackContinuationInput(continuation);
      }
    }
  }

  /**
   * Checkpoint barrier: capture named runtime snapshot and persist session.
   */
  async _checkpointBarrier(continuation, envelope) {
    const checkpointId = continuation.checkpointId;

    if (typeof this._agent.createNamedCheckpoint === 'function') {
      // Single-checkpoint model: clear existing checkpoints before creating a new one
      if (typeof this._agent.clearNamedCheckpoints === 'function') {
        this._agent.clearNamedCheckpoints();
      }
      await this._agent.createNamedCheckpoint(checkpointId);
      console.log(`[CallArbiter] checkpoint committed: ${checkpointId} (envelope=${envelope.id})`);
    }

    // Save session and wait for completion
    if (this.sessionSaveFn) {
      await this.sessionSaveFn();
    }
  }

  /**
   * Rollback barrier: restore named checkpoint and persist session.
   */
  async _rollbackBarrier(continuation, envelope) {
    const checkpointId = continuation.checkpointId;

    if (typeof this._agent.rollbackToNamedCheckpoint === 'function') {
      await this._agent.rollbackToNamedCheckpoint(checkpointId);
      console.log(`[CallArbiter] rollback completed: ${checkpointId} (envelope=${envelope.id})`);
    }

    // Save session and wait for completion
    if (this.sessionSaveFn) {
      await this.sessionSaveFn();
    }
  }

  /**
   * Inject a system message before the continuation user input.
   *
   * The system message carries the detailed continuation context (checkpoint
   * info or rollback summary + side-effects warning), while the user message
   * that onCall will add afterwards is kept short and auto-generated in tone.
   */
  _injectContinuationSystemMessage(kind, continuation) {
    const ctx = typeof this._agent.getContext === 'function'
      ? this._agent.getContext()
      : null;
    if (!ctx || typeof ctx.add !== 'function') return;

    if (kind === 'checkpoint') {
      const note = continuation.metadata?.note ? `\n备注: ${continuation.metadata.note}` : '';
      ctx.add({
        role: 'system',
        content: `检查点 "${continuation.checkpointId}" 已建立并提交。当前对话上下文已保存。${note}\n\n后续视需要可调用 rollback_to_checkpoint 回退到此处。`,
      });
    } else if (kind === 'rollback') {
      ctx.add({
        role: 'system',
        content: [
          `会话已回退到检查点 "${continuation.checkpointId}"。`,
          '',
          '以下是被回退会话的摘要：',
          continuation.summary,
          '',
          '注意：回退仅恢复对话上下文和部分工具状态。外部执行（文件写入、命令执行、API 调用等）不会被撤销——请验证所修改的外部资源的真实状态。',
        ].join('\n'),
      });
    }
  }

  /**
   * Build the continuation user input for a checkpoint segment.
   * Kept short — the detailed context is in the preceding system message.
   */
  _buildCheckpointContinuationInput(_continuation) {
    return '[本条消息由系统自动发送] 检查点已生效。请从此处继续执行当前任务——可以自由探索，如果方向不对可随时回退。';
  }

  /**
   * Build the continuation user input for a rollback segment.
   * Kept short — the detailed context (summary, warnings) is in the
   * preceding system message.
   */
  _buildRollbackContinuationInput(_continuation) {
    return '[本条消息由系统自动发送] 刚才会话发生了回退，以上为相关信息。请从恢复的检查点继续原始任务。';
  }
}

let callArbiter = null;

// ── IM result delivery via callfinish ──────────────────────────────
//
// When a call completes via the arbiter, this dispatcher decides whether
// the result should be mirrored to the active IM channel.
//
// Rules:
//  - IM-originated calls (source=qq|weixin): the Feature's own gateway
//    adapter already handles the reply — do NOT double-send.
//  - Non-IM-originated calls (dispatch, viewer-input, system):
//    deliver result to IM if the runtime has an active IM channel
//    and at least one prior IM peer is known.

const IM_REPLY_POLICY = {
  /** IM sources that already handle their own reply — skip callfinish delivery */
  IM_SOURCES: new Set(['qq', 'weixin', 'feishu', 'wecom']),
  /** Maximum character length for IM result delivery before truncation */
  MAX_IM_RESULT_LENGTH: 1500,
  /** Maximum length for error messages sent to IM */
  MAX_IM_ERROR_LENGTH: 500,
};

/**
 * Truncate text for IM delivery, adding an ellipsis indicator.
 */
function truncateForIM(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n...(结果已截断，完整内容请查看调试面板)';
}

/**
 * Dispatch a completed call envelope's result to IM.
 * Called from the callFinished listener.
 *
 * @param {object} envelope - The finished envelope from CallArbiter
 */
async function dispatchIMCallFinish(envelope) {
  if (!agent || typeof agent.sendIMMessage !== 'function') {
    return;
  }

  // Skip IM-originated calls — the Feature adapter handles its own reply.
  if (IM_REPLY_POLICY.IM_SOURCES.has(envelope.source)) {
    return;
  }

  const channel = typeof agent.getActiveIMChannel === 'function'
    ? agent.getActiveIMChannel()
    : null;

  if (!channel) {
    return;
  }

  // Determine result text
  let resultText = '';

  if (envelope.status === 'failed') {
    const errorText = envelope.error || '未知错误';
    resultText = `⚠ 调用失败: ${truncateForIM(errorText, IM_REPLY_POLICY.MAX_IM_ERROR_LENGTH)}`;
  } else if (envelope.status === 'completed') {
    const raw = envelope.result || '';
    if (!raw) {
      // Successful but empty result — skip IM notification for success with no content
      return;
    }
    resultText = truncateForIM(raw, IM_REPLY_POLICY.MAX_IM_RESULT_LENGTH);
  } else {
    return;
  }

  try {
    const delivered = await agent.sendIMMessage(resultText);
    if (delivered) {
      console.log(`[IM-CallFinish] delivered result to ${channel} (source=${envelope.source}, status=${envelope.status})`);
    } else {
      console.warn(`[IM-CallFinish] skipped result delivery to ${channel} (source=${envelope.source})`);
    }
  } catch (err) {
    console.error('[IM-CallFinish] failed to deliver result to IM:', err);
  }
}

// ── IM Transfer: Dynamic feature injection/removal ──────────────────
//
// Manages dynamic IM feature injection into the current runtime.
// Triggered by IPC messages from server.js when a channel is transferred
// to or disconnected from this runtime's session.

// ── IM Line Carrier Mount ──────────────────────────────────────────
//
// When a line is bound to this session, the carrier feature (QQBotFeature
// or WeixinBot) is dynamically mounted on THIS agent. The gateway receives
// IM messages and routes them through the CallArbiter for serialization.
//
// Carrier features do NOT use agentdev hooks or tools — they only provide
// a gateway that calls agentRef.onCall(text). This makes dynamic mounting
// safe even after the agent is already running.

let _mountedCarrierFeature = null; // tracks currently mounted carrier name

/**
 * Dynamically mount a carrier feature on this running agent.
 * Works because carrier features only provide a gateway (no hooks/tools).
 */
async function mountCarrierFeature(carrier) {
  if (!agent || IS_EXPLORATION) return;

  if (_mountedCarrierFeature === carrier) {
    console.log(`[IM-Line] Carrier "${carrier}" already mounted, skipping`);
    return;
  }

  try {
    console.log(`[IM-Line] Mounting carrier="${carrier}" dynamically...`);

    if (carrier === 'qq') {
      const { QQBotFeature } = await import('@agentdev/qqbot-feature');
      const cfgResp = await fetch(`${SERVER_ORIGIN}/protoclaw/qqbot_config`);
      const qqCfg = cfgResp.ok ? await cfgResp.json() : {};
      const feature = new QQBotFeature({
        appId: qqCfg?.appId || '',
        clientSecret: qqCfg?.clientSecret || '',
        configPath: qqCfg?.configPath || '',
        accountId: qqCfg?.accountId || '',
        markdownSupport: qqCfg?.markdownSupport ?? true,
      });
      await agent.mountFeature(feature);
      await feature.startGateway(agent);
      // Route IM messages through CallArbiter for serialization
      if (callArbiter) {
        feature.agentRef = {
          onCall: async (text) => {
            const entry = callArbiter.enqueue({ source: 'im-line-qq', text });
            const finished = await callArbiter.waitForCompletion(entry.id);
            if (finished.status === 'failed') {
              throw new Error(finished.error || 'unknown error');
            }
            return finished.result || '处理完成';
          },
        };
      }
      _mountedCarrierFeature = 'qq';
      console.log('[IM-Line] ✓ QQBot dynamically mounted + gateway started');
    } else if (carrier === 'weixin') {
      const { WeixinBot } = await import('@agentdev/weixin-bot');
      const feature = new WeixinBot({
        configPath: process.env.PROTOCLAW_WEIXIN_CONFIG_PATH || '',
      });
      await agent.mountFeature(feature);
      await feature.startGateway(agent);
      // Override handleMessage to route through CallArbiter
      if (callArbiter && typeof feature.handleMessage === 'function') {
        const origHandle = feature.handleMessage.bind(feature);
        const { WeixinApiClient } = await import('@agentdev/weixin-bot');
        feature.handleMessage = async (msg) => {
          if (!msg || msg.message_type !== 1) return;
          const text = WeixinApiClient.extractText(msg);
          if (!text) return;

          // 设置 WeixinBot 的 turn context，使 @CallStart 和 upload_attachment 工具生效
          feature._currentTurnCtx = {
            fromUserId: msg.from_user_id,
            contextToken: msg.context_token,
          };
          feature._pendingMedia = [];

          try {
            const entry = callArbiter.enqueue({
              source: 'im-line-weixin',
              sourceRef: msg.from_user_id || '',
              text,
            });
            const finished = await callArbiter.waitForCompletion(entry.id);
            const resp = finished.status === 'failed'
              ? `处理失败: ${finished.error || '未知错误'}`
              : (finished.result || '处理完成');
            if (resp) {
              await feature.apiClient.sendTextMessage(msg.from_user_id, resp, msg.context_token);
            }
            // flush 所有待发送的媒体附件
            await feature.flushPendingMedia();
          } finally {
            feature._currentTurnCtx = null;
            feature._pendingMedia = [];
          }
        };
      }
      _mountedCarrierFeature = 'weixin';
      console.log('[IM-Line] ✓ WeixinBot dynamically mounted + gateway started');
    } else if (carrier === 'feishu') {
      const { FeishuBot } = await import('@agentdev/feishu-bot');
      const feature = new FeishuBot({
        configPath: process.env.PROTOCLAW_FEISHU_CONFIG_PATH || '',
      });
      await agent.mountFeature(feature);
      await feature.startGateway(agent);
      // Route IM messages through CallArbiter for serialization
      if (callArbiter) {
        feature.agentRef = {
          onCall: async (text) => {
            const entry = callArbiter.enqueue({ source: 'im-line-feishu', text });
            const finished = await callArbiter.waitForCompletion(entry.id);
            if (finished.status === 'failed') {
              throw new Error(finished.error || 'unknown error');
            }
            return finished.result || '处理完成';
          },
        };
      }
      _mountedCarrierFeature = 'feishu';
      console.log('[IM-Line] ✓ FeishuBot dynamically mounted + gateway started');
    } else if (carrier === 'wecom') {
      const { WecomBot } = await import('@agentdev/wecom-bot');
      const feature = new WecomBot({
        configPath: process.env.PROTOCLAW_WECOM_CONFIG_PATH || '',
      });
      await agent.mountFeature(feature);
      await feature.startGateway(agent);
      // Route IM messages through CallArbiter for serialization
      if (callArbiter) {
        feature.agentRef = {
          onCall: async (text) => {
            const entry = callArbiter.enqueue({ source: 'im-line-wecom', text });
            const finished = await callArbiter.waitForCompletion(entry.id);
            if (finished.status === 'failed') {
              throw new Error(finished.error || 'unknown error');
            }
            return finished.result || '处理完成';
          },
        };
      }
      _mountedCarrierFeature = 'wecom';
      console.log('[IM-Line] ✓ WecomBot dynamically mounted + gateway started');
    }
  } catch (err) {
    console.error(`[IM-Line] Failed to mount carrier "${carrier}":`, err);
  }
}

/**
 * Check at startup if this session is bound to an IM line.
 */
async function mountIMLineCarrierIfBound() {
  if (!sessionId || IS_EXPLORATION) return;

  try {
    const resp = await fetch(`${SERVER_ORIGIN}/protoclaw/im_line_binding?agentId=${agentId}&sessionId=${sessionId}`);
    if (!resp.ok) return;
    const binding = await resp.json();
    if (!binding?.carrier) return;
    console.log(`[IM-Line] Startup binding found: carrier="${binding.carrier}"`);
    await mountCarrierFeature(binding.carrier);
  } catch (err) {
    console.error('[IM-Line] Failed to check startup binding:', err);
  }
}

// Handle IPC messages from server for dynamic carrier mounting
process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'mount-im-carrier' && msg.carrier) {
    console.log(`[IM-Line] IPC received: mount carrier "${msg.carrier}"`);
    mountCarrierFeature(msg.carrier).catch(err => {
      console.error('[IM-Line] Dynamic mount failed:', err);
    });
  } else if (msg.type === 'unmount-im-carrier') {
    console.log('[IM-Line] IPC received: unmount carrier');
    if (!_mountedCarrierFeature) return;
    const carrier = _mountedCarrierFeature;
    try {
      const featureName = carrier === 'qq' ? 'qqbot' : carrier === 'feishu' ? 'feishu-bot' : carrier === 'wecom' ? 'wecom-bot' : 'weixin-bot';
      if (typeof agent.removeFeature === 'function') {
        agent.removeFeature(featureName);
      } else {
        // fallback: 手动清理工具和 feature
        const feature = agent.features?.get?.(featureName);
        if (feature && typeof feature.onDestroy === 'function') {
          feature.onDestroy({ agent }).catch(err => {
            console.warn(`[IM-Line] onDestroy error for ${featureName}:`, err.message);
          });
        }
        agent.features?.delete?.(featureName);
      }
      _mountedCarrierFeature = null;
      console.log(`[IM-Line] ✓ Carrier "${carrier}" unmounted and gateway stopped`);
    } catch (err) {
      console.error(`[IM-Line] Unmount error for "${carrier}":`, err);
    }
  }
});

function getNextTurnActions() {
  const checkpoints = Array.isArray(agent?._callCheckpoints) ? agent._callCheckpoints : [];
  if (checkpoints.length === 0) return undefined;
  const availableCallIndices = checkpoints.map(cp => cp.callIndex);
  // Return actions enriched with availableCallIndices so the frontend can
  // determine which user messages actually have rollback targets.
  return NEXT_TURN_ACTIONS.map(action => ({
    ...action,
    data: { availableCallIndices },
  }));
}

async function disposeAgent(exitCode = 0) {
  if (disposed) return;
  disposed = true;

  if (agent) {
    if (sessionId) {
      // 先禁用 step auto-save，再手动做一次最终保存
      if (typeof agent.disableStepAutoSave === 'function') {
        agent.disableStepAutoSave();
      }
      try {
        await agent.saveSession(sessionId, sessionStore);
      } catch (error) {
        console.error('[ProtoClaw Runtime] 保存会话失败:', error);
      }
    }

    try {
      await agent.dispose();
    } catch (error) {
      console.error('[ProtoClaw Runtime] 释放资源失败:', error);
    }
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void disposeAgent(0);
});

process.on('SIGTERM', () => {
  void disposeAgent(0);
});

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

function tuneSummaryLLM(llm) {
  if (!llm || typeof llm !== 'object') return () => {};
  const restore = new Map();
  const remember = (key) => {
    if (Object.prototype.hasOwnProperty.call(llm, key)) {
      restore.set(key, llm[key]);
    }
  };
  remember('thinkingBudgetTokens');
  remember('maxTokens');
  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingBudgetTokens')) {
      llm.thinkingBudgetTokens = undefined;
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'maxTokens')) {
      const current = Number(llm.maxTokens);
      llm.maxTokens = Number.isFinite(current) && current > 0 ? Math.min(current, 2500) : 2500;
    }
  } catch {}
  return () => {
    for (const [key, value] of restore.entries()) {
      try { llm[key] = value; } catch {}
    }
  };
}

function shouldPreserveSummaryTools(agentInstance) {
  const modelName = cleanValue(
    agentInstance?.getSystemContext?.()?.SYSTEM_CURRENT_MODEL
    || agentInstance?._systemContext?.SYSTEM_CURRENT_MODEL
    || '',
  ).toLowerCase();
  return modelName.includes('claude');
}

async function generateInProcessSummary(extraInstructions = '') {
  const context = typeof agent?.getContext === 'function' ? agent.getContext() : null;
  const rawMessages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
  if (rawMessages.length === 0) {
    throw new Error('当前上下文为空，无法生成摘要');
  }

  const prompt = buildClaudeCompactPrompt({
    additionalInstructions: extraInstructions,
  });
  const messages = rawMessages.map((message, index) => ({
    role: message.role,
    content: typeof message?.content === 'string' ? message.content : '',
    turn: Number.isFinite(message?.turn) ? Number(message.turn) : index,
    toolCallId: message?.toolCallId,
    toolCalls: Array.isArray(message?.toolCalls) ? message.toolCalls : undefined,
    reasoning: typeof message?.reasoning === 'string' ? message.reasoning : undefined,
    thinkingBlocks: Array.isArray(message?.thinkingBlocks) ? message.thinkingBlocks : undefined,
  }));
  messages.push({
    role: 'user',
    content: prompt,
    turn: typeof agent?._callIndex === 'number' ? Number(agent._callIndex) + 1 : messages.length,
  });

  const toolRegistry = typeof agent?.getTools === 'function' ? agent.getTools() : null;
  const allTools = toolRegistry?.getAll?.() || [];
  const compactTool = allTools.find(t => t.name === 'record_compaction_context');
  let tools = shouldPreserveSummaryTools(agent) ? allTools : [];
  if (compactTool && !tools.includes(compactTool)) {
    tools = [compactTool];
  }
  const restoreLLM = tuneSummaryLLM(agent?.llm);
  try {
    console.log(`[ProtoClaw Runtime] 开始进程内摘要压缩 messages=${messages.length} tools=${tools.length}`);
    const response = await agent.llm.chat(messages, tools);
    const rawResponse = typeof response?.content === 'string' ? response.content : '';
    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    if (toolCalls.some(tc => tc?.name !== 'record_compaction_context')) {
      throw new Error('摘要模型错误地触发了工具调用');
    }
    const compactCall = toolCalls.find(tc => tc?.name === 'record_compaction_context');

    let importantFiles = [];
    let importantSkills = [];
    let summaryText = '';

    if (compactCall && compactCall.arguments) {
      const args = typeof compactCall.arguments === 'string'
        ? (() => { try { return JSON.parse(compactCall.arguments); } catch { return {}; } })()
        : compactCall.arguments;
      summaryText = typeof args.summary === 'string' ? args.summary.trim() : '';
      importantFiles = Array.isArray(args.important_files)
        ? args.important_files.filter(f => typeof f === 'string')
        : [];
      importantSkills = Array.isArray(args.important_skills)
        ? args.important_skills.filter(s => typeof s === 'string')
        : [];
    }

    if (!summaryText) {
      summaryText = stripCompactAnalysis(rawResponse);
    }

    if (!summaryText.trim()) {
      throw new Error('摘要模型返回了空结果');
    }
    const { fileRanges } = scanFilesAndSkills(rawMessages);
    return {
      rawResponse,
      summaryText,
      importantFiles,
      importantSkills,
      fileRanges,
    };
  } finally {
    restoreLLM();
  }
}

async function triggerSummaryCompaction(extraInstructions = '') {
  if (compactSummaryInFlight) {
    console.warn('[ProtoClaw Runtime] 已有 compact summary 正在进行，本次请求已忽略。');
    return;
  }
  if (!sessionId) {
    console.warn('[ProtoClaw Runtime] 当前 runtime 未绑定 session，无法触发 compact summary。');
    return;
  }

  compactSummaryInFlight = true;
  try {
    await agent.saveSession(sessionId, sessionStore);
    console.log('[ProtoClaw Runtime] 已保存当前 session，开始进程内摘要压缩...');
    const summaryResult = await generateInProcessSummary(extraInstructions);

    const result = await postJson('/protoclaw/context_handoffs/summary_export', {
      agentId,
      sessionId,
      summaryText: summaryResult.summaryText,
      rawResponse: summaryResult.rawResponse,
      importantFiles: summaryResult.importantFiles || [],
      importantSkills: summaryResult.importantSkills || [],
      fileRanges: summaryResult.fileRanges || {},
      policy: {
        strategy: 'summarized-nine-section',
        additionalInstructions: extraInstructions || '',
      },
    });

    const handoffId = cleanValue(result?.handoff?.handoffId);
    const handoffPath = cleanValue(result?.handoffPath);
    const mode = cleanValue(result?.handoff?.mode);
    console.log(`[ProtoClaw Runtime] Compact summary 已生成: mode=${mode || 'summarized-nine-section'} handoffId=${handoffId || '(none)'}`);
    if (handoffPath) {
      console.log(`[ProtoClaw Runtime] Handoff path: ${handoffPath}`);
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] Compact summary 失败:', error);
  } finally {
    compactSummaryInFlight = false;
  }
}

async function triggerSummaryCompactionResume(extraInstructions = '') {
  if (compactSummaryInFlight) {
    console.warn('[ProtoClaw Runtime] 已有 compact summary 正在进行，本次请求已忽略。');
    return;
  }
  if (!sessionId) {
    console.warn('[ProtoClaw Runtime] 当前 runtime 未绑定 session，无法触发 compact summary resume。');
    return;
  }

  compactSummaryInFlight = true;
  try {
    await agent.saveSession(sessionId, sessionStore);
    console.log('[ProtoClaw Runtime] 已保存当前 session，开始进程内摘要并创建新的 resume 会话...');
    const summaryResult = await generateInProcessSummary(extraInstructions);

    const result = await postJson('/protoclaw/context_handoffs/summary_resume', {
      agentId,
      sessionId,
      summaryText: summaryResult.summaryText,
      rawResponse: summaryResult.rawResponse,
      importantFiles: summaryResult.importantFiles || [],
      importantSkills: summaryResult.importantSkills || [],
      fileRanges: summaryResult.fileRanges || {},
      policy: {
        strategy: 'summarized-nine-section',
        additionalInstructions: extraInstructions || '',
      },
    });

    const nextSessionId = cleanValue(result?.session?.id);
    console.log(`[ProtoClaw Runtime] 摘要 resume 已创建: newSession=${nextSessionId || '(none)'}`);
  } catch (error) {
    console.error('[ProtoClaw Runtime] compact summary resume 失败:', error);
  } finally {
    compactSummaryInFlight = false;
  }
}

const PARTIAL_COMPACT_BOUNDARY_MARKER = '[PARTIAL_COMPACT_START]';

function buildPartialCompactSummaryContent(summaryText, { messagesSummarized = 0, feedback = '' } = {}) {
  return [
    '## 已压缩的后续对话摘要',
    '',
    '此消息不是新的用户请求；它是系统在执行“从此处压缩”后注入的连续性摘要。',
    '它替代了从所选用户消息开始、到压缩前为止的对话内容。上方较早消息已按原文保留。',
    '继续工作时，请同时参考上方保留的原文和下面的摘要；不要重新回复被摘要的历史用户消息，除非摘要中的“当前工作”或“待办事项”要求继续执行。',
    '',
    messagesSummarized > 0 ? `被摘要消息数：${messagesSummarized}` : '',
    feedback ? `用户压缩说明：${feedback}` : '',
    '',
    summaryText,
  ].filter(Boolean).join('\n');
}

/**
 * Generate a summary for only a subset of messages (partial compact).
 * The summarizer sees retained context plus an explicit boundary marker so it
 * can explain how the compacted tail relates to the preserved prefix.
 * @param {Array} allMessages - complete messages before partial compact
 * @param {number} pivotMsgIndex - first message that will be summarized
 * @param {string} feedback - optional user-provided extra instructions
 */
async function generatePartialInProcessSummary(allMessages, pivotMsgIndex, feedback = '') {
  const rawMessages = Array.isArray(allMessages) ? allMessages : [];
  const safePivot = Math.max(0, Math.min(Number(pivotMsgIndex) || 0, rawMessages.length));
  const messagesToSummarize = rawMessages.slice(safePivot);
  const prompt = buildClaudeCompactPrompt({
    additionalInstructions: feedback,
    partial: true,
  });
  const messages = rawMessages.map((message, index) => ({
    role: message.role,
    content: typeof message?.content === 'string' ? message.content : '',
    turn: Number.isFinite(message?.turn) ? Number(message.turn) : index,
    toolCallId: message?.toolCallId,
    toolCalls: Array.isArray(message?.toolCalls) ? message.toolCalls : undefined,
    reasoning: typeof message?.reasoning === 'string' ? message.reasoning : undefined,
    thinkingBlocks: Array.isArray(message?.thinkingBlocks) ? message.thinkingBlocks : undefined,
  }));
  messages.splice(safePivot, 0, {
    role: 'system',
    content: [
      PARTIAL_COMPACT_BOUNDARY_MARKER,
      '上方消息会按原文保留，仅作为理解背景。',
      '下方消息是本次“从此处压缩”需要摘要并替换的内容。',
    ].join('\n'),
    turn: Number.isFinite(rawMessages[safePivot]?.turn) ? Number(rawMessages[safePivot].turn) : safePivot,
  });
  messages.push({
    role: 'user',
    content: prompt,
    turn: typeof agent?._callIndex === 'number' ? Number(agent._callIndex) + 1 : messages.length,
  });

  const toolRegistry = typeof agent?.getTools === 'function' ? agent.getTools() : null;
  const allTools = toolRegistry?.getAll?.() || [];
  const compactTool = allTools.find(t => t.name === 'record_compaction_context');
  let tools = shouldPreserveSummaryTools(agent) ? allTools : [];
  if (compactTool && !tools.includes(compactTool)) {
    tools = [compactTool];
  }
  const restoreLLM = tuneSummaryLLM(agent?.llm);
  try {
    console.log(`[ProtoClaw Runtime] 开始部分摘要压缩 messages=${messages.length} tools=${tools.length}`);
    const response = await agent.llm.chat(messages, tools);
    const rawResponse = typeof response?.content === 'string' ? response.content : '';
    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    if (toolCalls.some(tc => tc?.name !== 'record_compaction_context')) {
      throw new Error('摘要模型错误地触发了工具调用');
    }
    const compactCall = toolCalls.find(tc => tc?.name === 'record_compaction_context');

    let importantFiles = [];
    let importantSkills = [];
    let summaryText = '';

    if (compactCall && compactCall.arguments) {
      const args = typeof compactCall.arguments === 'string'
        ? (() => { try { return JSON.parse(compactCall.arguments); } catch { return {}; } })()
        : compactCall.arguments;
      summaryText = typeof args.summary === 'string' ? args.summary.trim() : '';
      importantFiles = Array.isArray(args.important_files)
        ? args.important_files.filter(f => typeof f === 'string')
        : [];
      importantSkills = Array.isArray(args.important_skills)
        ? args.important_skills.filter(s => typeof s === 'string')
        : [];
    }

    if (!summaryText) {
      summaryText = stripCompactAnalysis(rawResponse);
    }

    if (!summaryText.trim()) {
      throw new Error('摘要模型返回了空结果');
    }
    const { fileRanges } = scanFilesAndSkills(messagesToSummarize);
    return {
      rawResponse,
      summaryText,
      importantFiles,
      importantSkills,
      fileRanges,
    };
  } finally {
    restoreLLM();
  }
}

async function rollbackToCallAndSave(callIndex, { draftInput } = {}) {
  if (typeof agent?.rollbackToCall !== 'function') {
    console.warn('[ProtoClaw Runtime] 当前 Agent 不支持 rollbackToCall');
    return { ok: false, draftInput: '' };
  }

  // Diagnostic: log checkpoint state before attempting rollback
  const checkpoints = Array.isArray(agent?._callCheckpoints) ? agent._callCheckpoints : [];
  const cpIndices = checkpoints.map(cp => cp.callIndex);
  const agentCallIndex = typeof agent?._callIndex === 'number' ? agent._callIndex : 'unknown';
  const context = typeof agent?.getContext === 'function' ? agent.getContext() : null;
  const msgs = context?.getAll?.() || [];
  const userTurns = msgs.filter(m => m.role === 'user').map(m => m.turn);
  console.log(`[ProtoClaw Runtime] rollbackToCallAndSave 诊断: callIndex=${callIndex} _callIndex=${agentCallIndex} checkpoints=[${cpIndices.join(',')}] userTurns=[${userTurns.join(',')}] msgs=${msgs.length}`);

  let result;
  try {
    result = await agent.rollbackToCall(callIndex);
    console.log(`[ProtoClaw Runtime] rollbackToCall 成功: callIndex=${callIndex}`);
  } catch (error) {
    console.error(`[ProtoClaw Runtime] rollbackToCall 失败: callIndex=${callIndex} checkpoints=[${cpIndices.join(',')}] — ${error.message}`);
    throw error;
  }
  const nextDraftInput = typeof draftInput === 'string'
    ? draftInput
    : (typeof result?.draftInput === 'string' ? result.draftInput : '');

  if (sessionId) {
    await agent.saveSession(sessionId, sessionStore);
    console.log(`[ProtoClaw Runtime] 已回滚到 call ${callIndex}`);
  }

  return { ok: true, draftInput: nextDraftInput };
}

/**
 * Trigger partial compaction in-session: summarize messages from the given callIndex
 * onward, roll back to that call, inject the summary as a system reminder message,
 * and save the same session. No new session is created.
 */
async function triggerPartialCompact(callIndex, feedback = '') {
  if (compactSummaryInFlight) {
    console.warn('[ProtoClaw Runtime] 已有 compact summary 正在进行，本次请求已忽略。');
    return;
  }
  if (!sessionId) {
    console.warn('[ProtoClaw Runtime] 当前 runtime 未绑定 session，无法触发 partial compact。');
    return;
  }

  compactSummaryInFlight = true;
  try {
    const context = typeof agent?.getContext === 'function' ? agent.getContext() : null;
    const rawMessages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
    if (rawMessages.length === 0) {
      throw new Error('当前上下文为空，无法生成摘要');
    }

    // Find pivot message index by callIndex (counting user turns)
    let pivotMsgIndex = -1;
    let userTurnCount = 0;
    for (let i = 0; i < rawMessages.length; i++) {
      if (rawMessages[i].role === 'user') {
        const turn = Number.isFinite(rawMessages[i].turn) ? Number(rawMessages[i].turn) : userTurnCount;
        if (turn === callIndex) {
          pivotMsgIndex = i;
          break;
        }
        userTurnCount++;
      }
    }
    // Fallback: use message index-based heuristic
    if (pivotMsgIndex < 0) {
      let count = 0;
      for (let i = 0; i < rawMessages.length; i++) {
        if (rawMessages[i].role === 'user') {
          if (count === callIndex) {
            pivotMsgIndex = i;
            break;
          }
          count++;
        }
      }
    }

    if (pivotMsgIndex < 0) {
      throw new Error(`找不到 callIndex=${callIndex} 对应的消息位置`);
    }

    const messagesToSummarize = rawMessages.slice(pivotMsgIndex);
    if (messagesToSummarize.length === 0) {
      throw new Error('没有需要压缩的消息');
    }

    console.log(`[ProtoClaw Runtime] 部分压缩: pivot=${pivotMsgIndex} summarize=${messagesToSummarize.length} keep=${pivotMsgIndex}`);

    // 1. Generate summary BEFORE rolling back (so we don't lose the messages)
    const summaryResult = await generatePartialInProcessSummary(rawMessages, pivotMsgIndex, feedback);

    const keptMessages = rawMessages.slice(0, pivotMsgIndex);
    const summaryContent = buildPartialCompactSummaryContent(summaryResult.summaryText, {
      messagesSummarized: messagesToSummarize.length,
      feedback,
    });

    // 2. Roll back via the exact same helper used by "回退到此轮".
    const rollback = await rollbackToCallAndSave(callIndex, { draftInput: '' });
    if (!rollback.ok) {
      return;
    }

    // 3. Inject summary as system reminder.
    // After rollback, the context already has the correct kept prefix in both
    // messages and enrichedMessages. We append the summary via addSystemMessage
    // (which syncs both arrays) instead of ctx.restore({ enrichedMessages: [] })
    // which would wipe enrichedMessages and break Feature queries.
    const ctx = typeof agent?.getContext === 'function' ? agent.getContext() : null;
    if (!ctx) {
      throw new Error('无法获取上下文');
    }

    const restoredCallIndex = typeof agent._callIndex === 'number' ? Number(agent._callIndex) : callIndex - 1;
    const reminderTurn = Math.max(0, restoredCallIndex + 1);

    // Verify the rollback produced the expected prefix; if not, fall back to
    // explicit restore (with rebuilt enrichedMessages from post-rollback state).
    const postRollbackMessages = ctx.getAll();
    if (postRollbackMessages.length === keptMessages.length) {
      ctx.addSystemMessage(summaryContent, reminderTurn, 'partial-compact');
    } else {
      console.warn(`[ProtoClaw Runtime] 部分压缩: 回滚后消息数 (${postRollbackMessages.length}) 与预期 (${keptMessages.length}) 不一致，使用显式 restore`);
      const postRollbackEnriched = typeof ctx.getAllEnriched === 'function' ? ctx.getAllEnriched() : [];
      const finalMessages = [...keptMessages, {
        role: 'system', content: summaryContent, turn: reminderTurn,
      }];
      ctx.restore({ version: 2, messages: finalMessages, enrichedMessages: postRollbackEnriched, sequence: postRollbackEnriched.length });
    }

    // 4. Save and sync final state.
    await agent.saveSession(sessionId, sessionStore);
    agent['pushToDebug']?.(ctx.getAll());
    agent['pushInspectorSnapshot']?.();
    console.log(`[ProtoClaw Runtime] 部分压缩已回退并注入 system reminder: before=${rawMessages.length} after=${ctx.getAll().length} reminderTurn=${reminderTurn}`);
    console.log(`[ProtoClaw Runtime] 部分压缩完成 (in-session): callIndex=${callIndex}`);
  } catch (error) {
    console.error('[ProtoClaw Runtime] 部分压缩失败:', error);
  } finally {
    compactSummaryInFlight = false;
  }
}

async function handleInputResponse(userInput, response) {
  if (!response) {
    return { kind: 'continue' };
  }

  if (response.kind === 'text') {
    const text = response.text ?? '';
    if (!text) {
      return { kind: 'continue' };
    }
    if (text === '/exit') {
      return { kind: 'exit' };
    }
    if (text.startsWith('/compact-summary-resume')) {
      const extraInstructions = text.slice('/compact-summary-resume'.length).trim();
      void triggerSummaryCompactionResume(extraInstructions);
      return { kind: 'continue' };
    }
    if (text.startsWith('/compact-summary')) {
      const extraInstructions = text.slice('/compact-summary'.length).trim();
      void triggerSummaryCompaction(extraInstructions);
      return { kind: 'continue' };
    }
    return { kind: 'text', text };
  }

  if (response.kind === 'action' && response.actionId === 'rollback_to_call') {
    const callIndex = response.payload?.callIndex;
    if (typeof callIndex !== 'number') {
      console.warn('[ProtoClaw Runtime] rollback_to_call 缺少有效的 callIndex');
      return { kind: 'continue' };
    }

    const result = await rollbackToCallAndSave(callIndex, {
      draftInput: typeof response.payload?.draftInput === 'string'
        ? response.payload.draftInput
        : undefined,
    });
    if (result.ok && typeof userInput.setNextDraftInput === 'function') {
      userInput.setNextDraftInput(result.draftInput);
    }
    return { kind: 'continue' };
  }

  if (response.kind === 'action' && response.actionId === 'compact_from_call') {
    const callIndex = response.payload?.callIndex;
    if (typeof callIndex !== 'number') {
      console.warn('[ProtoClaw Runtime] compact_from_call 缺少有效的 callIndex');
      return { kind: 'continue' };
    }

    const feedback = typeof response.payload?.feedback === 'string' ? response.payload.feedback : '';
    await triggerPartialCompact(callIndex, feedback);
    return { kind: 'continue' };
  }

  console.warn('[ProtoClaw Runtime] 收到未处理的输入动作:', response.actionId ?? response.kind);
  return { kind: 'continue' };
}

async function main() {
  const workspaceCwd = resolveWorkspaceCwd(agentId);
  const runtimeHandoff = loadRuntimeHandoff();

  const agentModule = await import(pathToFileURL(agentJsPath).href);
  const AgentClass = resolveAgentClass(agentModule);

  if (!AgentClass) {
    throw new Error(`无法在 ${agentJsPath} 中找到 Agent 类导出`);
  }

  const resolved = resolveAgentModelLLM(agentPath, 'default');
  resolvedUsageModel = resolved || null;
  agent = new AgentClass({
    name: agentName,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir: workspaceCwd || PROTOCLAW_ROOT,
    ...(resolved ? { llm: resolved.llm } : {}),
  });
  if (resolved) {
    console.log(`[ProtoClaw Runtime] Using model preset from metadata.json => ${resolved.modelName}`);
    try {
      const ctx = typeof agent.getSystemContext === 'function' ? agent.getSystemContext() : agent._systemContext;
      if (ctx) ctx.SYSTEM_CURRENT_MODEL = resolved.modelName;
    } catch {}
  }

  const localFeatures = await import(pathToFileURL(join(PROTOCLAW_ROOT, 'local-features', 'dist', 'index.js')).href);

  if (typeof localFeatures.ContextCompactionControlFeature === 'function') {
    agent.use(new localFeatures.ContextCompactionControlFeature({
      serverOrigin: SERVER_ORIGIN,
      agentId,
      sessionId,
    }));
    console.log('[ProtoClaw Runtime] 已挂载 context compaction control feature');
  }

  if (runtimeHandoff?.handoff && (runtimeHandoff.handoff.sourceSummary || runtimeHandoff.handoff.seedMessages?.length)) {
    if (typeof localFeatures.ContextHandoffSeedFeature !== 'function') {
      throw new Error('local ContextHandoffSeedFeature 未构建，无法挂载 handoff seed');
    }
    agent.use(new localFeatures.ContextHandoffSeedFeature({
      handoff: runtimeHandoff.handoff,
    }));
    console.log(`[ProtoClaw Runtime] 已挂载 context handoff seed (${runtimeHandoff.source})`);
  }

  if (typeof agent.prepareRuntime === 'function') {
    await agent.prepareRuntime();
  }

  if (workspaceCwd) {
    console.log(`[ProtoClaw Runtime] Workspace-bound agent environment => ${workspaceCwd}`);
  }

  console.log(`[ProtoClaw Runtime] Host workdir => ${process.cwd()}`);

  console.log(`[ProtoClaw Runtime] Agent 实例已创建: ${agentName}`);

  // Exploration agents run headlessly — no ViewerWorker, no IM gateway.
  // ClawDispatchFeature polls via HTTP and is independent of ViewerWorker.
  if (IS_EXPLORATION) {
    console.log('[ProtoClaw Runtime] Exploration mode — skipping ViewerWorker connection');
  } else {
    console.log(`[ProtoClaw Runtime] 正在连接到 ViewerWorker (端口 ${VIEWER_PORT})...`);
    await agent.withViewer(agentName, VIEWER_PORT, false, {
      projectRoot: PROTOCLAW_ROOT,
    });
    console.log('[ProtoClaw Runtime] ✓ 已连接到 ViewerWorker');
    console.log(`[ProtoClaw Runtime] Viewer Agent ID: ${agent.agentId ?? 'unknown'}`);
  }

  if (sessionId) {
    let sessionLoaded = false;
    try {
      await agent.loadSession(sessionId, sessionStore);
      sessionLoaded = true;
      console.log('[ProtoClaw Runtime] ✓ 已恢复会话: ' + sessionId);
    } catch {
      console.log('[ProtoClaw Runtime] 创建新会话: ' + sessionId);

      // 对新 session 预注入 CallStart 钩子内容（CLAUDE.md、交接摘要等），
      // 使首次加载时就能展示注入的上下文，而非空白。
      if (typeof agent['preInjectCallStart'] === 'function') {
        try {
          await agent['preInjectCallStart']();
        } catch (error) {
          console.warn('[ProtoClaw Runtime] preInjectCallStart 失败:', error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (!sessionLoaded && runtimeHandoff?.handoff?.featureContinuity) {
      try {
        const imported = await importFeatureContinuity(agent, runtimeHandoff.handoff.featureContinuity, {
          sourceSessionId: runtimeHandoff.handoff.sourceSessionId,
        });
        if (imported.length > 0) {
          await agent.saveSession(sessionId, sessionStore);
          console.log(`[ProtoClaw Runtime] ✓ 已导入 continuity feature state: ${imported.join(', ')}`);
        }
      } catch (error) {
        console.warn('[ProtoClaw Runtime] continuity feature state 导入失败:', error instanceof Error ? error.message : String(error));
      }
    }
    // 启用 step 级自动保存：每个 StepFinish 后自动落盘
    if (typeof agent.enableStepAutoSave === 'function') {
      agent.enableStepAutoSave(sessionId, sessionStore);
      console.log('[ProtoClaw Runtime] ✓ 已启用 step 级自动保存');
    }
  } else {
    console.log('[ProtoClaw Runtime] 当前未绑定对话会话，运行在工作空间首页模式。');
  }

  // `loadSession()` only restores in-memory state. Push the restored state to Viewer
  // so history is visible immediately without waiting for the next user input.
  if (!IS_EXPLORATION) {
    try {
      const messages = typeof agent.getContext === 'function' ? agent.getContext().getAll() : [];
      agent['pushToDebug']?.(messages);
      agent['syncRegisteredToolsToDebug']?.();
      agent['pushInspectorSnapshot']?.();
      agent['pushOverviewSnapshot']?.();
    } catch (error) {
      console.warn('[ProtoClaw Runtime] 恢复会话后同步调试状态失败:', error);
    }
  }

  console.log('[ProtoClaw Runtime] READY session=' + (sessionId || 'none'));

  // ── CallArbiter: initialize AFTER session restore, BEFORE runtime inputs open ──
  callArbiter = new CallArbiter(agent);
  DebugHub.getInstance().setQueuedInputHandler((targetAgentId, input) => {
    if (!callArbiter || !agent?.agentId || targetAgentId !== agent.agentId) {
      return;
    }
    callArbiter.enqueue({
      source: 'queued-input',
      sourceRef: input.id || '',
      text: input.text,
    });
  });
  DebugHub.getInstance().setInterruptHandler((targetAgentId, clearQueue) => {
    if (!callArbiter || !agent?.agentId || targetAgentId !== agent.agentId) {
      return;
    }
    if (clearQueue) {
      const cleared = callArbiter.clearQueued();
      if (cleared > 0) {
        console.log(`[ProtoClaw Runtime] interrupt cleared ${cleared} queued envelope(s)`);
      }
    }
  });

  // ── Supplement injection: override agent.onStepStart ──
  // At each step start, drain all pending supplements from the CallArbiter
  // and inject them as system messages inside the current call.
  // This lets the user add context mid-call without triggering a new onCall.
  const _originalOnStepStart = agent.onStepStart?.bind(agent);
  agent.onStepStart = async (ctx) => {
    const supplements = callArbiter.drainSupplements();
    if (supplements.length > 0 && ctx?.context?.addSystemMessage) {
      for (const supp of supplements) {
        ctx.context.addSystemMessage(
          `用户补充信息：${supp.text}`,
          ctx.callIndex,
        );
      }
      // Push updated context so DebugHub reflects the injected messages
      try { agent['pushToDebug']?.(ctx.context.getAll()); } catch {}
      console.log(`[ProtoClaw Runtime] injected ${supplements.length} supplement(s) at step ${ctx.step}`);
    }
    if (typeof _originalOnStepStart === 'function') {
      await _originalOnStepStart(ctx);
    }
  };

  callArbiter.on('callFinished', (_envelope) => {
    if (!sessionId) return;
    agent.saveSession(sessionId, sessionStore).then(async () => {
      // Push fresh metadata to server so session list can skip reading full files
      try {
        const context = typeof agent.getContext === 'function' ? agent.getContext() : null;
        const messages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
        const lastMessage = [...messages].reverse().find((m) => m && typeof m.content === 'string' && m.role !== 'system') || null;
        const preview = lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '';
        const usageStats = typeof agent.getUsage === 'function' ? agent.getUsage().toSnapshot() : null;
        const totalUsage = usageStats?.totalUsage;
        const callIndex = typeof agent?._callIndex === 'number' ? agent._callIndex : null;
        const callSummary = Array.isArray(usageStats?.calls)
          ? usageStats.calls.find((call) => call?.callIndex === callIndex)
          : null;
        if (callSummary?.totalUsage && callIndex !== null) {
          const usageEventId = [
            'agent-call',
            agentId,
            sessionId,
            runtimeInstanceId,
            callIndex,
            callSummary.endTime || Date.now(),
          ].join(':');
          if (!reportedUsageEventIds.has(usageEventId)) {
            reportedUsageEventIds.add(usageEventId);
            const usageResult = await reportUsageEvent(SERVER_ORIGIN, {
              eventId: usageEventId,
              timestamp: callSummary.endTime || Date.now(),
              source: IS_EXPLORATION ? 'exploration-call' : 'agent-call',
              agentId,
              sessionId,
              runtimeInstanceId,
              callIndex,
              requestCount: callSummary.stepCount || 1,
              cacheHitRequests: callSummary.cacheHitRequests || 0,
              model: buildModelUsageMeta(resolvedUsageModel, IS_EXPLORATION ? 'exploration' : 'default'),
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
            sessionId,
            messageCount: messages.length,
            preview,
            tokenUsage: {
              inputTokens: totalUsage?.inputTokens || 0,
              outputTokens: totalUsage?.outputTokens || 0,
              totalTokens: totalUsage?.totalTokens || 0,
              lastRequestUsage: usageStats?.lastRequestUsage || null,
            },
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

  callArbiter.on('callFinished', (envelope) => {
    dispatchIMCallFinish(envelope).catch(err => {
      console.error('[ProtoClaw Runtime] IM callfinish delivery error:', err);
    });
  });

  if (typeof agent.setCallArbiter === 'function') {
    agent.setCallArbiter(callArbiter);
  }

  // Wire session save for checkpoint/rollback continuation barriers
  callArbiter.sessionSaveFn = async () => {
    if (!sessionId) return;
    await agent.saveSession(sessionId, sessionStore);
  };

  console.log('[ProtoClaw Runtime] ✓ CallArbiter 已初始化');

  if (!IS_EXPLORATION) {
    try {
      if (typeof agent.startSelectedIMGateway === 'function') {
        const channel = await agent.startSelectedIMGateway();
        if (channel === 'none') {
          console.log('[ProtoClaw Runtime] • IM Gateway 未启动（未选择渠道），仅调试模式运行');
        } else {
          console.log(`[ProtoClaw Runtime] ✓ 已启动 IM Gateway (${channel || 'unknown'})`);
        }
      } else if (typeof agent.startQQBotGateway === 'function') {
        await agent.startQQBotGateway();
        console.log('[ProtoClaw Runtime] ✓ 已启动 QQBot Gateway');
      } else {
        const qqbotFeature = agent.features?.get?.('qqbot');
        if (qqbotFeature && typeof qqbotFeature.startGateway === 'function') {
          await qqbotFeature.startGateway(agent);
          console.log('[ProtoClaw Runtime] ✓ 已启动 QQBot Gateway');
        }
      }
    } catch (error) {
      console.error('[ProtoClaw Runtime] IM Gateway 启动失败，已降级为仅调试运行:', error);
    }

  }

  // If this session is bound to an IM line, mount the carrier feature + gateway
  await mountIMLineCarrierIfBound();

  try {
    const dispatchFeature = agent.features?.get?.('claw-dispatch');
    if (dispatchFeature && typeof dispatchFeature.startDispatchLoop === 'function') {
      await dispatchFeature.startDispatchLoop(agent, callArbiter);
      console.log('[ProtoClaw Runtime] ✓ 已启动 ClawDispatch loop (via arbiter)');
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] ClawDispatch 启动失败:', error);
  }

  try {
    const gcBridgeFeature = agent.features?.get?.('group-chat-bridge');
    if (gcBridgeFeature && typeof gcBridgeFeature.startBridgeLoop === 'function') {
      await gcBridgeFeature.startBridgeLoop(agent, callArbiter);
      console.log('[ProtoClaw Runtime] ✓ 已启动 GroupChatBridge loop');
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] GroupChatBridge 启动失败:', error);
  }

  const userInput = agent.features?.get?.('user-input');
  const hasUserInput = Boolean(userInput && typeof userInput.getUserInput === 'function');

  if (!hasUserInput) {
    console.log('');
    console.log('当前 Agent 不使用 UserInputFeature，运行在被动事件模式。');
    await new Promise(() => {});
    return;
  }

  console.log('');
  console.log('等待调试界面输入...');

  while (true) {
    let response;
    try {
      response = await userInput.getUserInputEvent(INPUT_PROMPT, undefined, getNextTurnActions());
    } catch (error) {
      console.error('[ProtoClaw Runtime] 等待用户输入失败，稍后重试:', error);
      await sleep(500);
      continue;
    }

    let handled;
    try {
      handled = await handleInputResponse(userInput, response);
    } catch (error) {
      console.error('[ProtoClaw Runtime] 处理输入动作失败，已忽略本次请求:', error);
      console.error(error?.stack || error);
      continue;
    }

    if (handled.kind === 'continue') {
      continue;
    }

    if (handled.kind === 'exit') {
      console.log('[ProtoClaw Runtime] 收到退出指令，正在关闭...');
      break;
    }

    try {
      const entry = callArbiter.enqueue({ source: 'viewer-input', text: handled.text });
      await callArbiter.waitForCompletion(entry.id);
    } catch (error) {
      console.error('[ProtoClaw Runtime] CallArbiter 入队失败:', error);
    }

    // 只有当前一轮 viewer 输入对应的调用真正结束后，
    // 才重新挂出下一轮 input-request。
    // 这样可以保留原本“运行中显示暂停/队列态”的前端语义。
  }

  await disposeAgent(0);
}

main().catch(async (error) => {
  console.error('[ProtoClaw Runtime] 启动失败:', error);
  await disposeAgent(1);
});
