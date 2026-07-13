import { existsSync, readFileSync, promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  APP_ORIGIN,
  PROJECT_ROOT,
  VIEWER_ORIGIN,
} from '../shared/constants.js';
import {
  getPrebuiltSessionFilePath,
} from '../shared/session-access.js';

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_SNAPSHOT_MS = 5_000;
const DEFAULT_COMMAND_MS = 2_000;
const PROJECT_REMOTE_CLAW_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'remote-claw.json');

export function startEmbeddedRemoteClawConnector(ctx) {
  const config = loadRemoteClawConfig();
  if (!config.enabled) {
    return { enabled: false, stop() {} };
  }

  const connector = new EmbeddedRemoteClawConnector({
    ...ctx,
    ...config,
  });
  connector.start();
  return { enabled: true, stop: () => connector.stop() };
}

class EmbeddedRemoteClawConnector {
  constructor(options) {
    Object.assign(this, options);
    this.workspaceId = null;
    this.stopped = false;
    this.timers = [];
    this.sessionByRemoteId = new Map();
    this.syncStateByLocalKey = new Map();
    this.executedCommands = new Set();
    this.runningLoops = new Set();
    this.catalogDigest = '';
    this.commandCursor = 0;
    this.failuresByLabel = new Map();
  }

  start() {
    const configNote = this.configPath ? `; config=${this.configPath}` : '';
    this.log(`enabled; relay=${this.relayUrl}${configNote}`);
    this.runLoop('initial sync', async () => {
      await this.registerWorkspace();
      await this.syncSnapshot();
      await this.pullCommands();
    }).finally(() => {
      if (this.stopped) return;
      this.every('heartbeat', this.heartbeatMs, () => this.heartbeat());
      this.every('snapshot', this.snapshotMs, () => this.syncSnapshot());
      this.every('commands', this.commandMs, () => this.pullCommands());
    });
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  every(label, ms, fn) {
    const schedule = () => {
      if (this.stopped) return;
      const delay = this.backoffDelay(label, ms);
      const timer = setTimeout(() => {
        this.runLoop(label, fn).finally(() => {
          if (!this.stopped) schedule();
        });
      }, delay);
      timer.unref?.();
      this.timers.push(timer);
    };
    schedule();
  }

  backoffDelay(label, baseMs) {
    const failures = this.failuresByLabel.get(label) || 0;
    if (failures === 0) return baseMs;
    const exponent = Math.min(failures, 5);
    return Math.min(baseMs * (2 ** exponent), 60_000);
  }

  runLoop(label, fn) {
    if (this.runningLoops.has(label) || this.stopped) return Promise.resolve();
    this.runningLoops.add(label);
    return this.runSafely(label, fn).finally(() => this.runningLoops.delete(label));
  }

  async runSafely(label, fn) {
    if (this.stopped) return;
    try {
      await fn();
      const prevFailures = this.failuresByLabel.get(label) || 0;
      if (prevFailures > 0) {
        this.failuresByLabel.delete(label);
        this.log(`${label} recovered after ${prevFailures} consecutive failure(s)`);
      }
    } catch (error) {
      const count = (this.failuresByLabel.get(label) || 0) + 1;
      this.failuresByLabel.set(label, count);
      if (count === 1 || count % 10 === 0) {
        this.log(`${label} failed (attempt ${count}): ${error.message || error}`, 'warn');
      }
    }
  }

  async registerWorkspace() {
    if (this.workspaceId) return this.workspaceId;
    const data = await this.post('/api/workspaces/register', {
      schemaVersion: 1,
      workspaceName: this.workspaceName,
      localOrigin: APP_ORIGIN,
      connectorVersion: 'embedded',
      capabilities: {
        transcriptSnapshot: true,
        queueInput: true,
        inputRequest: false,
        interrupt: true,
        attachments: false,
        embedded: true,
      },
    });
    this.workspaceId = data.workspaceId;
    this.log(`workspace registered: ${this.workspaceId}`);
    return this.workspaceId;
  }

  async heartbeat() {
    const workspaceId = await this.registerWorkspace();
    await this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/heartbeat`, {
      schemaVersion: 1,
      status: 'online',
      connectorStartedAt: new Date().toISOString(),
      lastLocalSnapshotAt: new Date().toISOString(),
    });
  }

  async syncSnapshot() {
    const workspaceId = await this.registerWorkspace();
    const agents = await this.getAgentsLight();
    const connected = await this.getConnectedAgents();
    const runtimeByAgentId = buildRuntimeMap(connected);
    const sessions = [];

    for (const agent of agents) {
      if (!agent?.id) continue;
      const listed = await this.listPrebuiltSessions(agent.id).catch(() => null);
      for (const session of listed?.sessions || []) {
        const runtime = runtimeByAgentId.get(`${agent.id}:${session.id}`) || null;
        sessions.push({
          agentId: agent.id,
          localSessionId: session.id,
          viewerAgentId: runtime?.runtime_session_id || runtime?.runtimeSessionId || null,
          runtimeSessionId: runtime?.runtime_session_id || runtime?.runtimeSessionId || null,
          title: session.title || session.taskTitle || 'Untitled',
          status: runtime ? (runtime.callActive ? 'running' : 'idle') : 'offline',
          sessionType: session.sessionType || null,
          archived: session.archived === true,
          todo: session.todo === true,
          openDirectory: session.openDirectory || null,
          messageCount: Number(session.messageCount || 0),
          preview: session.preview || '',
          tokenUsage: session.tokenUsage || null,
          contextLength: Number.isFinite(session.contextLength) ? session.contextLength : null,
          compressRatio: Number.isFinite(session.compressRatio) ? session.compressRatio : 80,
          modelName: session.modelName || '',
          savedAt: toIso(session.savedAt || session.updatedAt || session.createdAt),
          fileMtimeMs: session.fileMtimeMs || null,
          fileSize: session.fileSize || null,
          metadata: {
            featureName: session.featureName || '',
            agentName: session.agentName || agent.name || '',
            openDirectory: session.openDirectory || '',
            sessionType: session.sessionType || null,
            goal: session.goal || '',
            targetFiles: session.targetFiles || '',
            referenceMaterials: session.referenceMaterials || '',
            tokenUsage: session.tokenUsage || null,
            contextLength: Number.isFinite(session.contextLength) ? session.contextLength : null,
            compressRatio: Number.isFinite(session.compressRatio) ? session.compressRatio : 80,
            modelName: session.modelName || '',
          },
        });
      }
    }

    const catalogDigest = sha256(JSON.stringify(sessions.map((session) => ({
      agentId: session.agentId,
      localSessionId: session.localSessionId,
      title: session.title,
      status: session.status,
      archived: session.archived,
      todo: session.todo,
      messageCount: session.messageCount,
      fileMtimeMs: session.fileMtimeMs,
      fileSize: session.fileSize,
      viewerAgentId: session.viewerAgentId,
      openDirectory: session.openDirectory,
      tokenUsage: session.tokenUsage,
      contextLength: session.contextLength,
      compressRatio: session.compressRatio,
      modelName: session.modelName,
    }))));
    if (catalogDigest === this.catalogDigest) return;
    const result = await this.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/upsert`, {
      schemaVersion: 1,
      sessions,
      complete: true,
    });
    this.catalogDigest = catalogDigest;
    for (const mapped of result.sessions || []) {
      const key = localKey(mapped.agentId, mapped.localSessionId);
      const original = sessions.find((item) => item.agentId === mapped.agentId && item.localSessionId === mapped.localSessionId);
      this.sessionByRemoteId.set(mapped.remoteSessionId, { ...mapped, ...original });
      await this.syncTranscript(mapped, original);
    }
  }

  async syncTranscript(mapped, local) {
    if (!mapped?.remoteSessionId || !mapped?.streamId || !local?.agentId || !local?.localSessionId) return;
    const key = localKey(local.agentId, local.localSessionId);
    const state = this.syncStateByLocalKey.get(key) || { hashes: [] };
    const fingerprint = `${local.fileMtimeMs || 0}:${local.fileSize || 0}:${local.messageCount || 0}`;
    if (state.fingerprint === fingerprint) return;
    const messages = await readSessionMessages(local.agentId, local.localSessionId).catch(() => []);
    const normalized = messages.map((message, index) => normalizeMessage(mapped.remoteSessionId, message, index));
    const hashes = normalized.map((message) => message.contentHash);
    const events = [];

    if (isPrefix(state.hashes, hashes)) {
      for (let index = state.hashes.length; index < normalized.length; index += 1) {
        const payload = normalized[index];
        events.push({
          sourceEventId: `msg:${key}:${index}:${payload.contentHash}`,
          streamId: mapped.streamId,
          scopeType: 'session',
          scopeId: mapped.remoteSessionId,
          type: eventTypeForRole(payload.role),
          payload,
        });
      }
    } else {
      events.push({
        sourceEventId: `transcript:${key}:${hashes.join('|')}`,
        streamId: mapped.streamId,
        scopeType: 'session',
        scopeId: mapped.remoteSessionId,
        type: 'transcript.replaced',
        payload: {
          schemaVersion: 1,
          remoteSessionId: mapped.remoteSessionId,
          previousTranscriptVersion: state.version || null,
          transcriptVersion: Date.now(),
          reason: 'hash_mismatch',
          messageCount: normalized.length,
          snapshotHash: sha256(hashes.join('|')),
          messages: normalized,
        },
      });
    }

    if (events.length > 0) {
      await this.post(`/api/workspaces/${encodeURIComponent(this.workspaceId)}/events`, {
        schemaVersion: 1,
        events,
      });
      this.syncStateByLocalKey.set(key, { hashes, version: Date.now(), fingerprint });
    } else {
      this.syncStateByLocalKey.set(key, { ...state, hashes, fingerprint });
    }
  }

  async pullCommands() {
    const workspaceId = await this.registerWorkspace();
    const data = await this.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/commands?after_seq=${this.commandCursor}&status=pending&limit=100`);
    for (const command of data.commands || []) {
      await this.executeCommand(command);
      this.commandCursor = Math.max(this.commandCursor, Number(command.seq || 0));
    }
  }

  async executeCommand(command) {
    if (!command?.id || this.executedCommands.has(command.id)) return;
    await this.post(`/api/workspaces/${encodeURIComponent(this.workspaceId)}/commands/${encodeURIComponent(command.id)}/ack`, {
      schemaVersion: 1,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    try {
      let result;
      if (command.type === 'message.send') {
        result = await this.executeMessageSend(command);
      } else if (command.type === 'runtime.interrupt') {
        result = await this.executeInterrupt(command);
      } else {
        throw retryableError(`Unsupported command type: ${command.type}`, false, 'validation_failed');
      }
      this.executedCommands.add(command.id);
      await this.post(`/api/workspaces/${encodeURIComponent(this.workspaceId)}/commands/${encodeURIComponent(command.id)}/result`, {
        schemaVersion: 1,
        status: 'succeeded',
        result,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.post(`/api/workspaces/${encodeURIComponent(this.workspaceId)}/commands/${encodeURIComponent(command.id)}/result`, {
        schemaVersion: 1,
        status: 'failed',
        error: {
          code: error.code || 'internal_error',
          message: error.message || String(error),
          retryable: error.retryable !== false,
        },
        finishedAt: new Date().toISOString(),
      });
    }
  }

  async executeMessageSend(command) {
    const target = this.resolveCommandTarget(command);
    let viewerAgentId = target.viewerAgentId || null;
    if (!viewerAgentId) {
      const agent = await this.requireAgentLight(target.agentId);
      const session = await this.activatePrebuiltSession(agent.id, target.localSessionId, { returnSummary: false });
      const status = await this.startManagedAgent(agent, session.id);
      const ready = await this.waitForManagedRuntimeReady(agent.id, 15_000, session.id);
      viewerAgentId = ready?.runtime_session_id || ready?.runtimeSessionId || status?.viewerAgentId || status?.runtime_session_id || null;
    }
    if (!viewerAgentId) {
      throw retryableError('viewerAgentId missing after activation', true, 'viewer_agent_id_missing');
    }
    const payload = command.payload || {};
    const response = await fetch(`${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/queue-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: payload.text || ' ',
        images: Array.isArray(payload.images) ? payload.images : undefined,
      }),
    });
    if (!response.ok) {
      throw retryableError(`queue-input failed: HTTP ${response.status}`, true, 'local_runtime_not_ready');
    }
    return {
      localAccepted: true,
      queued: true,
      agentId: target.agentId,
      localSessionId: target.localSessionId,
      viewerAgentId,
    };
  }

  async executeInterrupt(command) {
    const target = this.resolveCommandTarget(command);
    if (!target.viewerAgentId) return { noOp: true };
    const response = await fetch(`${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(target.viewerAgentId)}/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: command.payload?.reason || 'remote-claw' }),
    });
    if (!response.ok) {
      throw retryableError(`interrupt failed: HTTP ${response.status}`, true, 'local_runtime_not_ready');
    }
    return { interrupted: true, viewerAgentId: target.viewerAgentId };
  }

  resolveCommandTarget(command) {
    const remoteSessionId = command.remoteSessionId || command.target?.remoteSessionId;
    const mapped = remoteSessionId ? this.sessionByRemoteId.get(remoteSessionId) : null;
    const agentId = mapped?.agentId || command.target?.agentId || command.targetAgentId;
    const localSessionId = mapped?.localSessionId || command.target?.localSessionId || command.targetLocalSessionId;
    const viewerAgentId = mapped?.viewerAgentId || command.target?.viewerAgentId || command.targetViewerAgentId || null;
    if (!agentId || !localSessionId) {
      throw retryableError('command target cannot be resolved', true, 'local_session_not_found');
    }
    return { agentId, localSessionId, viewerAgentId };
  }

  async get(pathname) {
    return this.request('GET', pathname);
  }

  async post(pathname, body) {
    return this.request('POST', pathname, body);
  }

  async request(method, pathname, body = undefined) {
    const response = await fetch(`${this.relayUrl}${pathname}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-Remote-Claw-Protocol': '1',
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) {
      throw new Error(json?.error?.message || `Relay HTTP ${response.status}`);
    }
    return json.data || json;
  }

  log(message, level = 'info') {
    const line = `[remote-claw] ${message}`;
    if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

async function readSessionMessages(agentId, sessionId) {
  const raw = await fs.readFile(getPrebuiltSessionFilePath(agentId, sessionId), 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.runtime?.context?.messages) ? parsed.runtime.context.messages : [];
}

function normalizeMessage(remoteSessionId, message, index) {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  const role = cleanText(message.role) || 'assistant';
  const contentHash = sha256(JSON.stringify({
    role,
    content,
    turn: message.turn ?? null,
    toolCallId: message.toolCallId ?? null,
    toolCalls: message.toolCalls ?? null,
  }));
  return {
    schemaVersion: 1,
    remoteSessionId,
    transcriptVersion: 1,
    ordinal: index,
    localMessageId: `${remoteSessionId}:${index}:${contentHash.slice(0, 16)}`,
    role,
    content,
    contentHash: `sha256:${contentHash}`,
    turn: typeof message.turn === 'number' ? message.turn : null,
    toolCallId: message.toolCallId || null,
    toolCalls: Array.isArray(message.toolCalls) ? message.toolCalls : null,
    reasoning: typeof message.reasoning === 'string' ? message.reasoning : null,
    usage: message.usage || null,
    images: Array.isArray(message.images) ? message.images : [],
    source: 'session_snapshot',
    raw: message,
    createdAt: new Date().toISOString(),
  };
}

function buildRuntimeMap(connectedAgents) {
  const map = new Map();
  for (const agent of connectedAgents || []) {
    const parentId = agent.parent_id || agent.parentId || agent.id;
    const sessionId = agent.active_workspace_session_id || agent.selectedSessionId || null;
    if (parentId && sessionId) map.set(`${parentId}:${sessionId}`, agent);
  }
  return map;
}

function localKey(agentId, sessionId) {
  return `${agentId}:${sessionId}`;
}

function eventTypeForRole(role) {
  if (role === 'user') return 'message.user';
  if (role === 'tool') return 'message.tool_result';
  if (role === 'system') return 'message.system';
  return 'message.assistant';
}

function isPrefix(previous, next) {
  if (!Array.isArray(previous) || previous.length > next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanUrl(value) {
  return cleanText(value).replace(/\/+$/, '');
}

function loadRemoteClawConfig() {
  const fileConfig = readJsonIfExists(PROJECT_REMOTE_CLAW_CONFIG_PATH) || {};
  const relayUrl = cleanUrl(process.env.REMOTE_CLAW_RELAY_URL) || cleanUrl(fileConfig.relayUrl);
  const token = cleanText(process.env.REMOTE_CLAW_CONNECTOR_TOKEN)
    || cleanText(fileConfig.connectorToken)
    || cleanText(fileConfig.token);
  const envEnabled = Boolean(cleanUrl(process.env.REMOTE_CLAW_RELAY_URL) && cleanText(process.env.REMOTE_CLAW_CONNECTOR_TOKEN));
  const fileEnabled = fileConfig.enabled === true;

  if (!(envEnabled || fileEnabled) || !relayUrl || !token) {
    return { enabled: false };
  }

  return {
    enabled: true,
    relayUrl,
    token,
    workspaceName: cleanText(process.env.REMOTE_CLAW_WORKSPACE_NAME)
      || cleanText(fileConfig.workspaceName)
      || 'AgentDevClaw',
    heartbeatMs: numberOption(process.env.REMOTE_CLAW_HEARTBEAT_MS, fileConfig.heartbeatMs, DEFAULT_HEARTBEAT_MS),
    snapshotMs: numberOption(process.env.REMOTE_CLAW_SNAPSHOT_MS, fileConfig.snapshotMs, DEFAULT_SNAPSHOT_MS),
    commandMs: numberOption(process.env.REMOTE_CLAW_COMMAND_MS, fileConfig.commandMs, DEFAULT_COMMAND_MS),
    configPath: existsSync(PROJECT_REMOTE_CLAW_CONFIG_PATH) ? PROJECT_REMOTE_CLAW_CONFIG_PATH : null,
  };
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`[remote-claw] ignored invalid config ${filePath}: ${error.message || error}`);
    return null;
  }
}

function numberOption(envValue, configValue, fallback) {
  const envParsed = Number.parseInt(envValue || '', 10);
  if (Number.isFinite(envParsed) && envParsed > 0) return envParsed;
  const configParsed = Number.parseInt(configValue || '', 10);
  return Number.isFinite(configParsed) && configParsed > 0 ? configParsed : fallback;
}

function toIso(value) {
  if (!value) return null;
  if (typeof value === 'number') return new Date(value).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function retryableError(message, retryable, code) {
  const error = new Error(message);
  error.retryable = retryable;
  error.code = code;
  return error;
}
