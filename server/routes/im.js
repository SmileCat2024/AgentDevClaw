/**
 * IM workspace management: channel configs, line bindings, weixin binding,
 * routable targets, and the IM workspace bundle aggregator.
 *
 * Extracted from server.js Phase 4.
 *
 * Dependencies injected via ctx (only needed inside setupIMRoutes):
 *   stopManagedAgent, requireAgentLight, startManagedAgent,
 *   waitForProcessExit, getAgentsLight, readViewerJson
 *
 * Exports for server.js consumption:
 *   readProjectIMWorkspaceConfig, getPortalAgentDisplayName, setupIMRoutes
 */

import path from 'path';
import { promises as fs } from 'fs';

import { WeixinApiClient } from '@agentdev/weixin-bot';

import {
  PROJECT_QQBOT_CONFIG_PATH,
  PROJECT_WEIXIN_CONFIG_PATH,
  PROJECT_FEISHU_CONFIG_PATH,
  PROJECT_WECOM_CONFIG_PATH,
  PROJECT_IM_WORKSPACE_CONFIG_PATH,
} from '../shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText } from '../shared/string-helpers.js';
import { readJson, ensureDir } from '../shared/fs-helpers.js';
import { getAgentRuntime, listAgentRuntimes, getManagedRuntimeKey } from '../shared/agent-access.js';
import { readSessionIndex, readSessionIndexSync } from '../shared/session-access.js';
import { sendIPCtoSession } from '../shared/ipc.js';
import { resolveSessionModelInfo } from './model-config.js';
import { getProjectAdapter } from './dispatch.js';
import { getRuntimeExecutionState } from '../runtime-call-envelope.js';

// ── Module state ──────────────────────────────────────────────────

const weixinBindingSessions = new Map();

// ── Config normalizers ────────────────────────────────────────────

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

function normalizeFeishuConfig(raw = {}) {
  return {
    appId: typeof raw.appId === 'string' ? raw.appId.trim() : '',
    appSecret: typeof raw.appSecret === 'string' ? raw.appSecret.trim() : '',
  };
}

function normalizeWecomConfig(raw = {}) {
  return {
    botId: typeof raw.botId === 'string' ? raw.botId.trim() : '',
    secret: typeof raw.secret === 'string' ? raw.secret.trim() : '',
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

export function normalizeIMWorkspaceConfig(raw = {}) {
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

  if (!channels.feishu) {
    channels.feishu = normalizeIMChannelConfig({}, {
      label: '飞书',
      note: '',
    });
  }

  if (!channels.wecom) {
    channels.wecom = normalizeIMChannelConfig({}, {
      label: '企业微信',
      note: '',
    });
  }

  const rawChannel = typeof raw.selectedChannel === 'string' ? raw.selectedChannel.trim() : '';
  const selectedChannel = rawChannel && channels[rawChannel] ? rawChannel : '';
  const receptionistSessionId = typeof raw.receptionistSessionId === 'string'
    ? sanitizeSessionFragment(raw.receptionistSessionId)
    : '';

  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = rawLines.length > 0
    ? rawLines.map((l, i) => normalizeIMLine(l, i))
    : [normalizeIMLine({}, 0), normalizeIMLine({}, 1)];

  return {
    selectedChannel,
    receptionistSessionId,
    channels,
    lines,
  };
}

const IM_CHANNEL_DISPLAY_LABELS = { qq: 'QQ', weixin: '微信', feishu: '飞书', wecom: '企业微信' };

export function getPortalAgentDisplayName(channelId) {
  const label = IM_CHANNEL_DISPLAY_LABELS[channelId] || channelId || '未接渠道';
  return `门户代理（${label}）`;
}

// ── Config readers / writers ──────────────────────────────────────

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

async function readProjectFeishuConfig() {
  try {
    const data = await readJson(PROJECT_FEISHU_CONFIG_PATH);
    return normalizeFeishuConfig(data);
  } catch {
    return normalizeFeishuConfig({});
  }
}

async function writeProjectFeishuConfig(rawConfig) {
  const config = normalizeFeishuConfig(rawConfig);
  await ensureDir(path.dirname(PROJECT_FEISHU_CONFIG_PATH));
  await fs.writeFile(PROJECT_FEISHU_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

async function readProjectWecomConfig() {
  try {
    const data = await readJson(PROJECT_WECOM_CONFIG_PATH);
    return normalizeWecomConfig(data);
  } catch {
    return normalizeWecomConfig({});
  }
}

async function writeProjectWecomConfig(rawConfig) {
  const config = normalizeWecomConfig(rawConfig);
  await ensureDir(path.dirname(PROJECT_WECOM_CONFIG_PATH));
  await fs.writeFile(PROJECT_WECOM_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function readProjectIMWorkspaceConfig() {
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
 * Factory: create a serialized read-modify-write queue for a config file.
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
export function createConfigSerializer({ read, write }) {
  let chain = Promise.resolve();
  return function withConfig(mutator) {
    const run = chain.then(async () => {
      const config = await read();
      const shouldWrite = await mutator(config);
      if (shouldWrite) {
        await write(config);
      }
      return config;
    });
    // Swallow rejections so the chain never breaks for subsequent callers
    chain = run.catch(() => {});
    return run;
  };
}

const withIMWorkspaceConfig = createConfigSerializer({
  read: readProjectIMWorkspaceConfig,
  write: writeProjectIMWorkspaceConfig,
});

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

// ── Weixin binding helpers ────────────────────────────────────────

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

// ── Workspace bundle aggregator ───────────────────────────────────

async function buildIMWorkspaceBundle(agentId = 'qqbot') {
  let workspaceConfig = await readProjectIMWorkspaceConfig();
  const [qqConfig, weixinConfig, feishuConfig, wecomConfig, index, phIndex] = await Promise.all([
    readProjectQQBotConfig(),
    readProjectWeixinConfig(),
    readProjectFeishuConfig(),
    readProjectWecomConfig(),
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
    feishuConfig: {
      configured: !!feishuConfig.appId && !!feishuConfig.appSecret,
      appId: feishuConfig.appId || '',
      appSecret: feishuConfig.appSecret || '',
      sourcePath: PROJECT_FEISHU_CONFIG_PATH,
    },
    wecomConfig: {
      configured: !!wecomConfig.botId && !!wecomConfig.secret,
      botId: wecomConfig.botId || '',
      secret: wecomConfig.secret || '',
      sourcePath: PROJECT_WECOM_CONFIG_PATH,
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

// ── Utility ───────────────────────────────────────────────────────

export function getUsageContextTokens(tokenUsage) {
  const lastReq = tokenUsage?.lastRequestUsage || null;
  if (Number.isFinite(lastReq?.inputTokens) && lastReq.inputTokens > 0) return lastReq.inputTokens;
  if (Number.isFinite(lastReq?.totalTokens) && lastReq.totalTokens > 0) return lastReq.totalTokens;
  if (Number.isFinite(tokenUsage?.totalTokens) && tokenUsage.totalTokens > 0) return tokenUsage.totalTokens;
  return null;
}

export function findLine(config, lineId) {
  return (config.lines || []).find(l => l.id === lineId) || null;
}

/**
 * Three-way exclusivity: when a line claims a carrier, clear all other lines
 * that held the same carrier, and re-assign the portal's selectedChannel if it
 * conflicted (falls back to the first available non-conflicting carrier).
 *
 * Mutates config in-place. Returns true if any conflict was resolved.
 */
export function resolveLineTransferConflict(config, { lineId, carrier }) {
  let changed = false;
  for (const otherLine of (config.lines || [])) {
    if (otherLine.id !== lineId && otherLine.carrier === carrier) {
      otherLine.carrier = '';
      otherLine.boundSession = null;
      changed = true;
    }
  }
  if (config.selectedChannel === carrier) {
    const available = ['qq', 'weixin', 'feishu', 'wecom'].find(c =>
      c !== carrier && !(config.lines || []).some(l => l.carrier === c)
    );
    config.selectedChannel = available || '';
    changed = true;
  }
  return changed;
}

/**
 * Three-way exclusivity (reverse direction): when the portal agent switches to
 * a new channel, clear all lines that held the same carrier.
 *
 * Mutates config in-place. Returns true if any line was cleared.
 */
export function resolvePortalChannelConflict(config, newChannel) {
  let changed = false;
  for (const line of (config.lines || [])) {
    if (line.carrier === newChannel) {
      line.carrier = '';
      line.boundSession = null;
      changed = true;
    }
  }
  return changed;
}

// ── Route setup ───────────────────────────────────────────────────

export function setupIMRoutes(app, express, ctx) {
  const {
    stopManagedAgent,
    requireAgentLight,
    startManagedAgent,
    waitForProcessExit,
    getAgentsLight,
    readViewerJson,
  } = ctx;

  // ── QQBot Config ────────────────────────────────────────────────

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

  // ── IM Workspace Bundle ─────────────────────────────────────────

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
      const feishuConfig = await writeProjectFeishuConfig(req.body?.feishuConfig || {});
      const wecomConfig = await writeProjectWecomConfig(req.body?.wecomConfig || {});

      const newChannel = workspaceConfig.selectedChannel || '';
      const channelChanged = newChannel !== (prevConfig.selectedChannel || '');
      let portalRestarted = false;

      // Enforce three-way exclusivity: if portal's new channel conflicts with a line, clear that line
      if (channelChanged && newChannel) {
        const conflicted = resolvePortalChannelConflict(workspaceConfig, newChannel);
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
          if (newChannel) {
            // Channel switched to a different non-empty channel: restart
            try {
              const agent = await requireAgentLight('qqbot');
              await startManagedAgent(agent);
              portalRestarted = true;
              console.log(`[ProtoClaw IM] 渠道切换: ${prevConfig.selectedChannel || '(空)'} → ${newChannel}，门户代理已重启`);
            } catch (restartErr) {
              console.error('[ProtoClaw IM] 门户代理重启失败:', restartErr);
            }
          } else {
            // Channel set to empty: stop without restart
            console.log('[ProtoClaw IM] 渠道已置空，门户代理已停止');
          }
        }
      }

      const bundle = await buildIMWorkspaceBundle('qqbot');
      res.json({
        ...bundle,
        savedAt: new Date().toISOString(),
        portalRestarted,
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Weixin Binding ──────────────────────────────────────────────

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

  // ── IM Line Transfer ────────────────────────────────────────────
  //
  // A "line" (通道) binds to a carrier (渠道: qq/weixin) and optionally to
  // a target agent session.  The portal agent (receptionist) has its own
  // carrier binding via `selectedChannel`; these endpoints manage the
  // additional logical lines.

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
      if (carrier && agentId === 'qqbot') {
        return res.status(400).json({ error: 'Portal agent sessions cannot be used as IM transfer targets' });
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
        resolveLineTransferConflict(config, { lineId, carrier });

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

  // ── IM Routable Targets ─────────────────────────────────────────
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
        if (agent.id === 'qqbot') continue;
        const adapter = getProjectAdapter(agent.id);

        let projects;
        if (adapter) {
          try {
            projects = await adapter.listProjects();
          } catch {
            projects = [];
          }
        } else if (agent.id === 'work-group') {
          projects = [{
            id: 'work-group-admin',
            name: '管理员会话',
            type: 'workspace',
            config: {},
            sessionIds: listAgentRuntimes(agent.id)
              .filter(rt => rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId)
              .map(rt => rt.selectedSessionId),
            latestSessionId: null,
            createdAt: null,
            updatedAt: null,
          }];
        } else {
          continue;
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
        const modelInfoCache = new Map();
        const getAgentModelInfo = async (sessionType) => {
          const key = sessionType || 'default';
          if (!modelInfoCache.has(key)) {
            modelInfoCache.set(key, await resolveSessionModelInfo(agent.id, key));
          }
          return modelInfoCache.get(key);
        };

        for (const project of projects) {
          const projectSessionIds = project.sessionIds || [];
          const projectSessions = [];

          const buildSessionEntry = async (sid) => {
            const meta = sessionMetaMap.get(sid);
            const sessionType = meta?.sessionType || 'main';
            const agentModelInfo = await getAgentModelInfo(sessionType);
            const tokenUsage = meta?.tokenUsage || null;
            const contextTokens = getUsageContextTokens(tokenUsage);
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
                projectSessions.push(await buildSessionEntry(sid));
              }
            }
          } else {
            // When project has no explicit sessionIds, associate all live runtimes
            for (const rt of runtimes) {
              if (rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId) {
                projectSessions.push(await buildSessionEntry(rt.selectedSessionId));
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
            if (bound.agentId === 'qqbot') {
              return {
                id: l.id,
                name: l.name || l.id,
                carrier: l.carrier || null,
                boundSession: null,
              };
            }
            const idx = readSessionIndexSync(bound.agentId);
            const match = (idx?.sessions || []).find(s => s.id === bound.sessionId);
            const sessionTitle = match?.title || bound.sessionId;
            const tokenUsage = match?.tokenUsage || null;
            const boundModelInfo = await resolveSessionModelInfo(bound.agentId, 'default');
            const contextLength = boundModelInfo.contextLength || null;
            const contextTokens = getUsageContextTokens(tokenUsage);
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
}
