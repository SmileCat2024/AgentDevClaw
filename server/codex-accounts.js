/**
 * Codex OAuth 账号簿 — 多账号槽位的元数据与"当前账号"指针。
 *
 * 账号 = token 槽位（oauth-tokens/<sanitized>.json，由 oauth-codex.js 管理）
 *      + 列表元数据（displayName）。元数据与当前账号指针落在 Claw user data
 * model-connections.json 的 codex 段：
 *
 *   { "codex": { "accounts": [{ "providerName", "displayName" }],
 *                "activeProvider": "<providerName>" } }
 *
 * 读路径懒合并：token 目录里存在文件但不在列表的槽位（存量 'OpenAI Auth'、
 * 手工放置）自动纳入账号列表，默认名按合并位置编号；activeProvider 缺省或
 * 指向无 token 的槽位时，回退到列表中第一个有 token 的账号。合并结果不强制
 * 写盘——任何写操作（登记 / 重命名 / activate / 登出）才会规范化落盘。
 *
 * 槽位名以 token 文件名为准做归一比较（sanitize 后同名视为同一槽位），
 * 因此存量 'OpenAI Auth'（文件名 OpenAI_Auth）经任何写操作登记后，列表里
 * 记录的是文件名形态；displayName 才是面向用户的标识。
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { MODEL_CONNECTIONS_PATH } from './shared/constants.js';
import { OAUTH_TOKENS_DIR, sanitizeProviderSlotKey } from './oauth-codex.js';

function readCodexSection(connectionsPath) {
  try {
    const raw = JSON.parse(readFileSync(connectionsPath, 'utf8'));
    const section = raw?.codex;
    const accounts = Array.isArray(section?.accounts)
      ? section.accounts
        .filter((a) => a && typeof a.providerName === 'string' && a.providerName.trim())
        .map((a) => ({
          providerName: a.providerName.trim(),
          displayName: typeof a.displayName === 'string' && a.displayName.trim() ? a.displayName.trim() : '',
        }))
      : [];
    const activeProvider = typeof section?.activeProvider === 'string' ? section.activeProvider : '';
    return { accounts, activeProvider };
  } catch {
    return { accounts: [], activeProvider: '' };
  }
}

function scanTokenSlots() {
  if (!existsSync(OAUTH_TOKENS_DIR)) return [];
  try {
    return readdirSync(OAUTH_TOKENS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

/**
 * 合并视图：列表条目在前（保持配置顺序），孤儿 token 槽位按文件名排序追加；
 * 同一槽位（sanitize 归一）只保留一条，列表条目优先。默认名 "Codex 账号 N"
 * 按合并后位置编号——孤儿默认名只在未落盘前的读时呈现，任何写操作后固定。
 */
export function listCodexAccounts(connectionsPath = MODEL_CONNECTIONS_PATH) {
  const section = readCodexSection(connectionsPath);
  const slots = scanTokenSlots();
  const merged = [...section.accounts];
  const known = new Set(merged.map((a) => sanitizeProviderSlotKey(a.providerName)));
  for (const slot of [...slots].sort()) {
    if (!known.has(slot)) {
      merged.push({ providerName: slot, displayName: '' });
      known.add(slot);
    }
  }
  const accounts = merged.map((a, i) => ({
    providerName: a.providerName,
    displayName: a.displayName || `Codex 账号 ${i + 1}`,
    hasToken: slots.includes(sanitizeProviderSlotKey(a.providerName)),
  }));
  // 当前账号回退：显式 active 无效（未设/无 token）时取第一个有 token 的账号
  const explicit = accounts.find(
    (a) => a.hasToken && sanitizeProviderSlotKey(a.providerName) === sanitizeProviderSlotKey(section.activeProvider),
  );
  const fallback = explicit || accounts.find((a) => a.hasToken) || null;
  return { accounts, activeProvider: fallback ? fallback.providerName : '' };
}

function writeCodexSection(updater, connectionsPath) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(connectionsPath, 'utf8')) || {}; } catch {}
  const next = updater(readCodexSection(connectionsPath));
  raw.codex = next;
  mkdirSync(path.dirname(connectionsPath), { recursive: true });
  writeFileSync(connectionsPath, JSON.stringify(raw, null, 2), 'utf8');
  return next;
}

/**
 * 登录完成时登记槽位（幂等：已在列表则跳过）。孤儿槽位重新登录也走这里，
 * 列表会补一条 displayName 默认名的新条目。
 */
export function registerCodexAccount(providerName, connectionsPath = MODEL_CONNECTIONS_PATH) {
  writeCodexSection((section) => {
    if (section.accounts.some((a) => sanitizeProviderSlotKey(a.providerName) === sanitizeProviderSlotKey(providerName))) {
      return section;
    }
    return {
      ...section,
      accounts: [...section.accounts, { providerName, displayName: `Codex 账号 ${section.accounts.length + 1}` }],
    };
  }, connectionsPath);
}

/**
 * 生成未占用的登录槽位名（codex-account-N）。占位检查基于合并视图，
 * 因此也不会生成与孤儿 token 文件同名的新槽位。
 */
export function generateCodexSlotName(connectionsPath = MODEL_CONNECTIONS_PATH) {
  const taken = new Set(listCodexAccounts(connectionsPath).accounts.map((a) => sanitizeProviderSlotKey(a.providerName)));
  for (let n = 1; ; n++) {
    const name = `codex-account-${n}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * 设为当前账号。要求槽位已有 token（未登录的槽位不能激活）；激活孤儿槽位
 * 时顺手入列表。返回 { ok, previous }——previous 供调用方判断是否需要广播
 * refresh-credentials（激活未变化时不打扰运行中会话）。
 */
export function activateCodexAccount(providerName, connectionsPath = MODEL_CONNECTIONS_PATH) {
  if (!providerName || !scanTokenSlots().includes(sanitizeProviderSlotKey(providerName))) {
    return { ok: false, error: 'not_logged_in' };
  }
  const previous = listCodexAccounts(connectionsPath).activeProvider;
  writeCodexSection((section) => {
    const exists = section.accounts.some((a) => sanitizeProviderSlotKey(a.providerName) === sanitizeProviderSlotKey(providerName));
    const accounts = exists
      ? section.accounts
      : [...section.accounts, { providerName, displayName: `Codex 账号 ${section.accounts.length + 1}` }];
    return { accounts, activeProvider: providerName };
  }, connectionsPath);
  return { ok: true, previous };
}

export function renameCodexAccount(providerName, displayName, connectionsPath = MODEL_CONNECTIONS_PATH) {
  const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
  if (!trimmed) return { ok: false, error: 'invalid_display_name' };
  // 找到的是合并视图里的条目（可能是只存在于 token 目录的孤儿槽位）；
  // 孤儿重命名必须先入列表再改名，否则 map 落在空列表上静默丢失。
  const view = listCodexAccounts(connectionsPath);
  const slot = sanitizeProviderSlotKey(providerName);
  const viewEntry = view.accounts.find((a) => sanitizeProviderSlotKey(a.providerName) === slot);
  if (!viewEntry) return { ok: false, error: 'not_found' };
  writeCodexSection((section) => {
    const exists = section.accounts.some((a) => sanitizeProviderSlotKey(a.providerName) === slot);
    const accounts = (exists
      ? section.accounts
      : [...section.accounts, { providerName: viewEntry.providerName, displayName: viewEntry.displayName }])
      .map((a) => (sanitizeProviderSlotKey(a.providerName) === slot ? { ...a, displayName: trimmed } : a));
    return { ...section, accounts };
  }, connectionsPath);
  return { ok: true };
}

/**
 * 移出账号列表（登出后调用；token 文件本身由调用方先 deleteTokens 清除）。
 * active 指向被移除账号时置空——读路径自然回退到下一个有 token 的账号。
 */
export function removeCodexAccount(providerName, connectionsPath = MODEL_CONNECTIONS_PATH) {
  writeCodexSection((section) => ({
    ...section,
    accounts: section.accounts.filter((a) => sanitizeProviderSlotKey(a.providerName) !== sanitizeProviderSlotKey(providerName)),
    activeProvider: sanitizeProviderSlotKey(section.activeProvider) === sanitizeProviderSlotKey(providerName)
      ? ''
      : section.activeProvider,
  }), connectionsPath);
  return listCodexAccounts(connectionsPath);
}

/**
 * 当前账号的槽位名（供 resolver / catalog 拉取前置查找）。无任何有效账号
 * 时返回 null，调用方退回存量查找链，未启用账号簿的环境行为不变。
 */
export function resolveActiveCodexProviderName(connectionsPath = MODEL_CONNECTIONS_PATH) {
  return listCodexAccounts(connectionsPath).activeProvider || null;
}
