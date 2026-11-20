/**
 * 一次性启动迁移：存量默认 OAuth 槽位名 'OpenAI Auth' → 'codex-account-N'。
 *
 * 槽位名同时出现在三处数据，必须一致换名，否则 resolver / 账号簿断链：
 *   1. token 文件 oauth-tokens/OpenAI_Auth.json（文件名即槽位键）
 *   2. 账号簿 model-connections.json codex 段（accounts[].providerName / activeProvider）
 *   3. model-config（providers[].name 与 presets[].providerName 的旧引用）
 *
 * 幂等：旧 token 文件不存在且账号簿无旧条目时跳过（model-config 引用只在
 * 有旧条目时顺带清理）。displayName（用户可见的账号名）原样保留。启动时
 * 无并发请求，步骤顺序无中间态可见性；任一步失败由调用方（server.js）告警
 * 不阻断启动——残留旧名下次启动会重试。
 */

import { existsSync, renameSync } from 'fs';
import { tokenFilePath, sanitizeProviderSlotKey } from './oauth-codex.js';
import {
  LEGACY_DEFAULT_CODEX_SLOT_NAME,
  listCodexAccounts,
  generateCodexSlotName,
  renameCodexSlot,
} from './codex-accounts.js';
import { readModelPresets, writeModelPresetsFile } from './routes/model-config.js';

async function rewriteModelConfigReferences(legacyKey, newName) {
  const data = await readModelPresets();
  let changed = false;
  const providers = data.providers.map((provider) => {
    if (provider && provider.authType === 'oauth-codex' && sanitizeProviderSlotKey(provider.name) === legacyKey) {
      changed = true;
      return { ...provider, name: newName };
    }
    return provider;
  });
  const presets = data.presets.map((preset) => {
    if (preset && sanitizeProviderSlotKey(preset.providerName) === legacyKey) {
      changed = true;
      return { ...preset, providerName: newName };
    }
    return preset;
  });
  if (!changed) return false;
  await writeModelPresetsFile({ ...data, providers, presets });
  return true;
}

export async function migrateLegacyCodexSlotName() {
  const legacyKey = sanitizeProviderSlotKey(LEGACY_DEFAULT_CODEX_SLOT_NAME);
  const legacyTokenPath = tokenFilePath(LEGACY_DEFAULT_CODEX_SLOT_NAME);
  const hasLegacyToken = existsSync(legacyTokenPath);
  // 账号簿显式条目检测（合并视图；此分支下无旧 token 文件，视图条目即显式条目）
  const bookHasLegacy = listCodexAccounts().accounts.some((a) => sanitizeProviderSlotKey(a.providerName) === legacyKey);

  if (!hasLegacyToken && !bookHasLegacy) return { skipped: true };

  const newName = generateCodexSlotName();
  renameCodexSlot(LEGACY_DEFAULT_CODEX_SLOT_NAME, newName);
  await rewriteModelConfigReferences(legacyKey, newName);
  if (hasLegacyToken) {
    renameSync(legacyTokenPath, tokenFilePath(newName));
  }
  return { skipped: false, newName, tokenRenamed: hasLegacyToken };
}
