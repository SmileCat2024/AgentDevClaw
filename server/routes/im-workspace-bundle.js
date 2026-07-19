/**
 * IM workspace bundle: weixin binding lifecycle, bundle aggregation,
 * and line-conflict utility functions.
 *
 * Extracted from server/routes/im.js during module split.
 */

import { WeixinApiClient } from '@agentdev/weixin-bot';

import {
  PROJECT_QQBOT_CONFIG_PATH,
  PROJECT_WEIXIN_CONFIG_PATH,
  PROJECT_FEISHU_CONFIG_PATH,
  PROJECT_WECOM_CONFIG_PATH,
  PROJECT_ROKID_CONFIG_PATH,
  PROJECT_IM_WORKSPACE_CONFIG_PATH,
} from '../shared/constants.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import { getAgentRuntime, listAgentRuntimes, getManagedRuntimeKey } from '../shared/agent-access.js';
import { readSessionIndex } from '../shared/session-access.js';
import { getIMChannelIds } from '../shared/im-channels.js';

import {
  readProjectIMWorkspaceConfig,
  readProjectQQBotConfig,
  readProjectWeixinConfig,
  readProjectFeishuConfig,
  readProjectWecomConfig,
  readProjectRokidConfig,
  normalizeWeixinConfig,
  pruneStaleIMLineBindings,
} from './im-config.js';

// ── Module state ──────────────────────────────────────────────────

const weixinBindingSessions = new Map();

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

export async function buildIMWorkspaceBundle(agentId = 'qqbot') {
  let workspaceConfig = await readProjectIMWorkspaceConfig();
  const [qqConfig, weixinConfig, feishuConfig, wecomConfig, rokidConfig, index, phIndex] = await Promise.all([
    readProjectQQBotConfig(),
    readProjectWeixinConfig(),
    readProjectFeishuConfig(),
    readProjectWecomConfig(),
    readProjectRokidConfig(),
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
    rokidConfig: {
      configured: !!rokidConfig.linkCode && !!rokidConfig.linkSecret,
      linkCode: rokidConfig.linkCode || '',
      linkSecret: rokidConfig.linkSecret || '',
      wsUrl: rokidConfig.wsUrl || 'wss://rcs.rokid.com/claw/ws/link',
      sourcePath: PROJECT_ROKID_CONFIG_PATH,
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

export async function startWeixinBinding(agentId = 'qqbot') {
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

export async function refreshWeixinBinding(agentId = 'qqbot') {
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

export async function clearWeixinBinding(agentId = 'qqbot') {
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
    const available = getIMChannelIds().find(c =>
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
