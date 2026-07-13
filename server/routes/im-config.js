/**
 * IM configuration: normalizers, readers/writers, and serialized mutation.
 *
 * Extracted from server/routes/im.js during module split.
 */

import path from 'path';
import { promises as fs } from 'fs';

import {
  PROJECT_QQBOT_CONFIG_PATH,
  PROJECT_WEIXIN_CONFIG_PATH,
  PROJECT_FEISHU_CONFIG_PATH,
  PROJECT_WECOM_CONFIG_PATH,
  PROJECT_IM_WORKSPACE_CONFIG_PATH,
} from '../shared/constants.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import { readJson, ensureDir } from '../shared/fs-helpers.js';
import { getAgentRuntime } from '../shared/agent-access.js';
import { IM_CHANNELS, getIMChannelLabel } from '../shared/im-channels.js';

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

export function normalizeWeixinConfig(raw = {}) {
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

  // Ensure all registered channels have a default entry
  for (const ch of IM_CHANNELS) {
    if (!channels[ch.id]) {
      channels[ch.id] = normalizeIMChannelConfig({}, { label: ch.label });
    }
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

export function getPortalAgentDisplayName(channelId) {
  const label = getIMChannelLabel(channelId) || '未接渠道';
  return `门户代理（${label}）`;
}

// ── Config readers / writers ──────────────────────────────────────

export async function readProjectQQBotConfig() {
  try {
    const data = await readJson(PROJECT_QQBOT_CONFIG_PATH);
    return normalizeQQBotConfig(data);
  } catch {
    return normalizeQQBotConfig({});
  }
}

export async function writeProjectQQBotConfig(rawConfig) {
  const config = normalizeQQBotConfig(rawConfig);
  await ensureDir(path.dirname(PROJECT_QQBOT_CONFIG_PATH));
  await fs.writeFile(PROJECT_QQBOT_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function readProjectWeixinConfig() {
  try {
    const data = await readJson(PROJECT_WEIXIN_CONFIG_PATH);
    return normalizeWeixinConfig(data);
  } catch {
    return normalizeWeixinConfig({});
  }
}

export async function readProjectFeishuConfig() {
  try {
    const data = await readJson(PROJECT_FEISHU_CONFIG_PATH);
    return normalizeFeishuConfig(data);
  } catch {
    return normalizeFeishuConfig({});
  }
}

export async function writeProjectFeishuConfig(rawConfig) {
  const config = normalizeFeishuConfig(rawConfig);
  await ensureDir(path.dirname(PROJECT_FEISHU_CONFIG_PATH));
  await fs.writeFile(PROJECT_FEISHU_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function readProjectWecomConfig() {
  try {
    const data = await readJson(PROJECT_WECOM_CONFIG_PATH);
    return normalizeWecomConfig(data);
  } catch {
    return normalizeWecomConfig({});
  }
}

export async function writeProjectWecomConfig(rawConfig) {
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

export async function writeProjectIMWorkspaceConfig(rawConfig) {
  const config = normalizeIMWorkspaceConfig(rawConfig);
  await ensureDir(path.dirname(PROJECT_IM_WORKSPACE_CONFIG_PATH));
  await fs.writeFile(PROJECT_IM_WORKSPACE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

// ── Serialized config mutation ────────────────────────────────────

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

export const withIMWorkspaceConfig = createConfigSerializer({
  read: readProjectIMWorkspaceConfig,
  write: writeProjectIMWorkspaceConfig,
});

/**
 * Prune line bindings whose target runtime is no longer alive.
 * Runs through the serializer to avoid racing with concurrent transfers.
 * Returns the number of pruned lines.
 */
export function pruneStaleIMLineBindings() {
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
