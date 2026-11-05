/**
 * IM workspace bundle: weixin binding lifecycle, bundle aggregation,
 * and line-conflict utility functions.
 *
 * Extracted from server/routes/im.js during module split.
 */

import { WeixinApiClient } from '@agentdevjs/weixin-bot';

import {
  APP_QQBOT_CONFIG_PATH,
  APP_WEIXIN_CONFIG_PATH,
  APP_FEISHU_CONFIG_PATH,
  APP_WECOM_CONFIG_PATH,
  APP_ROKID_CONFIG_PATH,
  APP_IM_WORKSPACE_CONFIG_PATH,
} from '../shared/constants.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import { readSessionIndex } from '../shared/session-access.js';
import { getThreadIntegration } from '../thread-control/thread-integration.js';

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
      sourcePath: APP_WEIXIN_CONFIG_PATH,
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
    sourcePath: APP_WEIXIN_CONFIG_PATH,
  };
}

// ── Workspace bundle aggregator ───────────────────────────────────

export async function buildIMWorkspaceBundle(agentId = 'qqbot') {
  let workspaceConfig = await readProjectIMWorkspaceConfig();
  const [qqConfig, weixinConfig, feishuConfig, wecomConfig, rokidConfig, index] = await Promise.all([
    readProjectQQBotConfig(),
    readProjectWeixinConfig(),
    readProjectFeishuConfig(),
    readProjectWecomConfig(),
    readProjectRokidConfig(),
    readSessionIndex(agentId).catch(() => ({ sessions: [], activeSessionId: null })),
  ]);

  // Background pruning through the serializer (non-blocking). ADR-0042：
  // 悬空判定（线程终态/归档）在 prune 内部，bundle 不再重复 runtime 检查。
  pruneStaleIMLineBindings().catch((e) =>
    console.error('[ProtoClaw IM] Background prune failed:', e)
  );

  const sessions = Array.isArray(index?.sessions)
    ? index.sessions.map((session) => ({
        id: cleanSessionText(session?.id),
        title: cleanSessionText(session?.title) || cleanSessionText(session?.id),
        updatedAt: cleanSessionText(session?.updatedAt),
      })).filter((session) => session.id)
    : [];
  const binding = serializeWeixinBindingState(weixinBindingSessions.get(agentId) || null);

  // ADR-0042：接线员线程投影（receptionistSession 时代结束——接线员是线程，
  // head 会话随接续演进，引用经 threads 全局库解析）。
  const operatorThreadId = String(workspaceConfig.operatorThreadId || '').trim();
  const operatorThreadRecord = operatorThreadId
    ? await getThreadIntegration().core.getThread(operatorThreadId).catch(() => null)
    : null;
  const operatorThread = operatorThreadRecord
    ? {
        threadId: operatorThreadRecord.threadId,
        headSessionId: operatorThreadRecord.headSessionId,
        title: operatorThreadRecord.title || operatorThreadRecord.headSessionId,
        status: operatorThreadRecord.status,
      }
    : null;

  return {
    workspaceConfig,
    qqConfig,
    weixinConfig: {
      configured: !!weixinConfig.botToken,
      baseUrl: weixinConfig.baseUrl || '',
      loginTime: weixinConfig.loginTime || null,
      sourcePath: APP_WEIXIN_CONFIG_PATH,
    },
    feishuConfig: {
      configured: !!feishuConfig.appId && !!feishuConfig.appSecret,
      appId: feishuConfig.appId || '',
      appSecret: feishuConfig.appSecret || '',
      sourcePath: APP_FEISHU_CONFIG_PATH,
    },
    wecomConfig: {
      configured: !!wecomConfig.botId && !!wecomConfig.secret,
      botId: wecomConfig.botId || '',
      secret: wecomConfig.secret || '',
      sourcePath: APP_WECOM_CONFIG_PATH,
    },
    rokidConfig: {
      configured: !!rokidConfig.linkCode && !!rokidConfig.linkSecret,
      linkCode: rokidConfig.linkCode || '',
      linkSecret: rokidConfig.linkSecret || '',
      wsUrl: rokidConfig.wsUrl || 'wss://rcs.rokid.com/claw/ws/link',
      sourcePath: APP_ROKID_CONFIG_PATH,
    },
    binding,
    sessions,
    operatorThread,
    qqSourcePath: APP_QQBOT_CONFIG_PATH,
    workspaceSourcePath: APP_IM_WORKSPACE_CONFIG_PATH,
  };
}

export async function startWeixinBinding(agentId = 'qqbot') {
  const client = new WeixinApiClient(APP_WEIXIN_CONFIG_PATH);
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
  const client = new WeixinApiClient(APP_WEIXIN_CONFIG_PATH);
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
  const client = new WeixinApiClient(APP_WEIXIN_CONFIG_PATH);
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
 * Carrier exclusivity: when a line claims a carrier, clear all other lines
 * that held the same carrier (carrier is exclusive across lines).
 *
 * ADR-0042 决策 1：selectedChannel 并入线路模型后不再存在"门户让路"方向——
 * 接线员线路也是普通线路，carrier 冲突统一按"claim 者清占线"解决。
 *
 * Mutates config in-place. Returns true if any conflict was resolved.
 */
export function resolveLineTransferConflict(config, { lineId, carrier }) {
  let changed = false;
  for (const otherLine of (config.lines || [])) {
    if (otherLine.id !== lineId && otherLine.carrier === carrier) {
      otherLine.carrier = '';
      otherLine.boundTarget = null;
      changed = true;
    }
  }
  return changed;
}

/**
 * Carrier exclusivity (bundle PUT direction): when a line claims a carrier,
 * clear all other lines that held the same carrier.
 *
 * 接替退役的 resolvePortalChannelConflict（ADR-0042：门户渠道并入线路模型，
 * "门户换渠道"方向不存在了，bundle 保存时统一按线路间 carrier 互斥清理）。
 *
 * Mutates config in-place. Returns true if any line was cleared.
 */
export function resolveCarrierConflicts(config) {
  let changed = false;
  const seen = new Set();
  for (const line of (config.lines || [])) {
    if (!line.carrier) continue;
    if (seen.has(line.carrier)) {
      line.carrier = '';
      line.boundTarget = null;
      changed = true;
    } else {
      seen.add(line.carrier);
    }
  }
  return changed;
}
