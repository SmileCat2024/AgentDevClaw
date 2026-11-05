/**
 * IM configuration: normalizers, readers/writers, and serialized mutation.
 *
 * Extracted from server/routes/im.js during module split.
 */

import path from 'path';
import { promises as fs } from 'fs';

import {
  APP_QQBOT_CONFIG_PATH,
  APP_WEIXIN_CONFIG_PATH,
  APP_FEISHU_CONFIG_PATH,
  APP_WECOM_CONFIG_PATH,
  APP_ROKID_CONFIG_PATH,
  APP_IM_WORKSPACE_CONFIG_PATH,
} from '../shared/constants.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';
import { readJson, ensureDir } from '../shared/fs-helpers.js';
import { IM_CHANNELS, getIMChannelLabel } from '../shared/im-channels.js';
import { getThreadIntegration } from '../thread-control/thread-integration.js';

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

export function normalizeRokidConfig(raw = {}) {
  return {
    linkCode: typeof raw.linkCode === 'string' ? raw.linkCode.trim() : '',
    linkSecret: typeof raw.linkSecret === 'string' ? raw.linkSecret.trim() : '',
    wsUrl: typeof raw.wsUrl === 'string' && raw.wsUrl.trim()
      ? raw.wsUrl.trim()
      : 'wss://rcs.rokid.com/claw/ws/link',
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

function normalizeBoundTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
  const threadId = typeof raw.threadId === 'string' ? raw.threadId.trim() : '';
  if (!agentId || !threadId) return null;
  return { agentId, threadId };
}

function normalizeIMLine(raw, index) {
  if (!raw || typeof raw !== 'object') raw = {};
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `line${index + 1}`,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `通道 ${index + 1}`,
    carrier: typeof raw.carrier === 'string' ? raw.carrier.trim() : '',
    // ADR-0042 决策 1：线路统一线程寻址。旧 boundSession（会话寻址）读到即
    // 丢弃——清空不迁移（决策 6），用户按新模型重新接线。
    boundTarget: normalizeBoundTarget(raw.boundTarget),
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

  // ADR-0042 决策 1：selectedChannel 并入线路模型——门户渠道线路 = 绑定接线员
  // 线程的线路（boundTarget 指向 operatorThreadId 的线路），渠道取该线路的
  // carrier。配置文件残留的 selectedChannel 读到即丢弃，归一化写盘后消失。
  const receptionistSessionId = typeof raw.receptionistSessionId === 'string'
    ? sanitizeSessionFragment(raw.receptionistSessionId)
    : '';
  // receptionistSessionId 保留归一仅供升级迁移读取（im-operator-thread 归档
  // 旧会话后清除）；runtime 会话解析只认 operatorThreadId。
  const operatorThreadId = typeof raw.operatorThreadId === 'string'
    ? raw.operatorThreadId.trim()
    : '';

  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  const lines = rawLines.length > 0
    ? rawLines.map((l, i) => normalizeIMLine(l, i))
    : [normalizeIMLine({}, 0), normalizeIMLine({}, 1)];

  return {
    receptionistSessionId,
    operatorThreadId,
    channels,
    lines,
  };
}

export function getPortalAgentDisplayName(channelId) {
  const label = getIMChannelLabel(channelId) || '未接渠道';
  return `门户代理（${label}）`;
}

/**
 * 接线员线路（ADR-0042 决策 1）：boundTarget 指向接线员线程的线路。
 * 门户渠道 = 接线员线路的 carrier；接线员线路不存在即门户未接渠道。
 * server 侧唯一判定入口，消费方（discovery / lifecycle / dispatch / bundle）
 * 一律从这里取，禁止各自内联比较。
 */
export function findOperatorLines(config) {
  const operatorThreadId = String(config?.operatorThreadId || '').trim();
  if (!operatorThreadId) return [];
  const lines = Array.isArray(config?.lines) ? config.lines : [];
  return lines.filter((line) => line?.boundTarget
    && line.boundTarget.agentId === 'qqbot'
    && String(line.boundTarget.threadId).trim() === operatorThreadId);
}

/**
 * 接线员线路的首要 carrier：门户 gateway 的启动渠道（ADR-0042 决策 1，
 * selectedChannel 的继任语义）。无接线员线路或线路均未选渠道 → ''（未接线）。
 */
export function operatorCarrierOf(config) {
  const line = findOperatorLines(config).find((l) => l.carrier && l.carrier.trim());
  return line ? line.carrier.trim() : '';
}

// ── Config readers / writers ──────────────────────────────────────

export async function readProjectQQBotConfig() {
  try {
    const data = await readJson(APP_QQBOT_CONFIG_PATH);
    return normalizeQQBotConfig(data);
  } catch {
    return normalizeQQBotConfig({});
  }
}

export async function writeProjectQQBotConfig(rawConfig) {
  const config = normalizeQQBotConfig(rawConfig);
  await ensureDir(path.dirname(APP_QQBOT_CONFIG_PATH));
  await fs.writeFile(APP_QQBOT_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function readProjectWeixinConfig() {
  try {
    const data = await readJson(APP_WEIXIN_CONFIG_PATH);
    return normalizeWeixinConfig(data);
  } catch {
    return normalizeWeixinConfig({});
  }
}

export async function readProjectFeishuConfig() {
  try {
    const data = await readJson(APP_FEISHU_CONFIG_PATH);
    return normalizeFeishuConfig(data);
  } catch {
    return normalizeFeishuConfig({});
  }
}

export async function writeProjectFeishuConfig(rawConfig) {
  const config = normalizeFeishuConfig(rawConfig);
  await ensureDir(path.dirname(APP_FEISHU_CONFIG_PATH));
  await fs.writeFile(APP_FEISHU_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function readProjectWecomConfig() {
  try {
    const data = await readJson(APP_WECOM_CONFIG_PATH);
    return normalizeWecomConfig(data);
  } catch {
    return normalizeWecomConfig({});
  }
}

export async function writeProjectWecomConfig(rawConfig) {
  const config = normalizeWecomConfig(rawConfig);
  await ensureDir(path.dirname(APP_WECOM_CONFIG_PATH));
  await fs.writeFile(APP_WECOM_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function readProjectRokidConfig() {
  try {
    const data = await readJson(APP_ROKID_CONFIG_PATH);
    return normalizeRokidConfig(data);
  } catch {
    return normalizeRokidConfig({});
  }
}

export async function writeProjectRokidConfig(rawConfig) {
  const config = normalizeRokidConfig(rawConfig);
  await ensureDir(path.dirname(APP_ROKID_CONFIG_PATH));
  await fs.writeFile(APP_ROKID_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

export async function readProjectIMWorkspaceConfig() {
  try {
    const data = await readJson(APP_IM_WORKSPACE_CONFIG_PATH);
    return normalizeIMWorkspaceConfig(data);
  } catch {
    return normalizeIMWorkspaceConfig({});
  }
}

export async function writeProjectIMWorkspaceConfig(rawConfig) {
  const config = normalizeIMWorkspaceConfig(rawConfig);
  await ensureDir(path.dirname(APP_IM_WORKSPACE_CONFIG_PATH));
  await fs.writeFile(APP_IM_WORKSPACE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
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
    // Swallow rejections so the chain never breaks for subsequent callers;
    // each rejection still propagates to its own caller via `run`.
    chain = run.catch(() => {
      // handled by the caller of `run`
    });
    return run;
  };
}

export const withIMWorkspaceConfig = createConfigSerializer({
  read: readProjectIMWorkspaceConfig,
  write: writeProjectIMWorkspaceConfig,
});

/**
 * Prune line bindings whose target thread is no longer bindable
 * (closed / archived / record gone). Runs through the serializer to avoid
 * racing with concurrent transfers. Returns the number of pruned lines.
 *
 * ADR-0042：绑定目标线程化后，悬空判定与投递接受性同一组事实——线程终态或
 * 归档即清（runtime 是否存活不再相关，消息经线程 Inbox 兜底）。
 */
export function pruneStaleIMLineBindings() {
  return withIMWorkspaceConfig(async (config) => {
    const integration = getThreadIntegration();
    const archived = new Set(Object.keys(await integration.archive.list().catch(() => ({})) || {}));
    let pruned = 0;
    for (const line of (config.lines || [])) {
      if (!line.boundTarget?.agentId || !line.boundTarget?.threadId) continue;
      const thread = await integration.core
        .getThread(line.boundTarget.threadId).catch(() => null);
      if (!thread || thread.status === 'closed' || archived.has(line.boundTarget.threadId)) {
        line.boundTarget = null;
        pruned++;
      }
    }
    return pruned > 0;
  });
}
