/**
 * Shared model preset resolver for prebuilt agent runtimes.
 *
 * Reads config/presets.json and agent metadata.json to resolve a preset name
 * into an LLM instance via AgentDev's createLLM().
 */

import { join, resolve, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createLLM } from 'agentdev';
import { buildCodexOAuthHeaders, resolveAccessTokenSync } from './oauth-codex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const PRESETS_PATH = join(PROTOCLAW_ROOT, 'config', 'presets.json');

/**
 * Resolve a preset name to { llm, modelName }.
 * @param {string} presetName
 * @returns {{ llm: import('agentdev').LLMClient, modelName: string, presetName: string, providerName: string, provider: string, protocol: string, apiSurface?: string, baseUrl: string } | null}
 */
export function resolveModelPresetLLM(presetName) {
  if (!presetName || !existsSync(PRESETS_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(PRESETS_PATH, 'utf8'));
    const presets = Array.isArray(raw?.presets) ? raw.presets : [];
    const providers = Array.isArray(raw?.providers) ? raw.providers : [];
    const preset = presets.find((p) => p.name === presetName);
    if (!preset) {
      console.warn(`[ModelPreset] Preset "${presetName}" not found in config/presets.json`);
      return null;
    }
    const provider = providers.find((p) => p.name === preset.providerName);
    if (!provider) {
      console.warn(`[ModelPreset] Provider "${preset.providerName}" not found for preset "${presetName}"`);
      return null;
    }
    const protocol = preset.protocol || 'anthropic';
    const baseUrl = provider.endpoints?.[protocol] || '';

    // thinkingEffort: always read from preset, never inherit across providers.
    const effectiveThinkingEffort = preset.thinkingEffort || undefined;

    // OAuth provider: resolve access_token from token store
    const isOAuth = provider.authType === 'oauth-codex';
    let apiKey;
    if (isOAuth) {
      apiKey = resolveAccessTokenSync(provider.name, provider.clientId) || '';
      if (!apiKey) {
        console.warn(`[ModelPreset] OAuth provider "${provider.name}" has no stored token — login required`);
        return null;
      }
    } else {
      apiKey = provider.apiKey || '';
    }

    if (!baseUrl || !apiKey || !preset.model) {
      console.warn(`[ModelPreset] Incomplete config for preset "${presetName}": baseUrl=${!!baseUrl} apiKey=${!!apiKey} model=${!!preset.model}`);
      return null;
    }
    // ChatGPT-managed Codex authentication is a Responses API transport.
    // Force the runtime invariant even for presets saved by older clients.
    const apiSurface = protocol === 'openai'
      ? (isOAuth ? 'responses' : (preset.apiSurface || 'chat'))
      : undefined;
    const customHeaders = isOAuth
      ? buildCodexOAuthHeaders(apiKey, preset.customHeaders)
      : preset.customHeaders;
    const llm = createLLM({
      provider: protocol,
      model: preset.model,
      apiKey,
      baseUrl,
      thinkingEffort: effectiveThinkingEffort,
      thinkingBudgetTokens: preset.thinkingBudgetTokens ?? undefined,
      ...(apiSurface ? { apiSurface } : {}),
      ...(isOAuth ? { responsesProfile: 'codex' } : {}),
      ...(preset.maxTokens ? { maxTokens: preset.maxTokens } : {}),
      ...(preset.vision === true ? { vision: true } : {}),
      ...(Array.isArray(customHeaders) && customHeaders.length > 0
        ? { customHeaders }
        : {}),
    });
    console.log(`[ModelPreset] Resolved preset "${presetName}" => ${preset.model} (${protocol}${isOAuth ? ' / OAuth' : ''})`);
    return {
      llm,
      modelName: preset.model,
      presetName: preset.name || presetName,
      providerName: provider.name || preset.providerName || '',
      provider: protocol,
      protocol,
      authType: isOAuth ? 'oauth-codex' : '',
      vision: preset.vision === true,
      contextLength: Number.isFinite(Number(preset.contextLength)) && Number(preset.contextLength) > 0
        ? Number(preset.contextLength) : null,
      compressRatio: Number.isFinite(Number(preset.compressRatio))
        ? Math.max(1, Math.min(100, Number(preset.compressRatio))) : 80,
      ...(apiSurface ? { apiSurface } : {}),
      baseUrl,
    };
  } catch (error) {
    console.warn(`[ModelPreset] Failed to resolve preset "${presetName}":`, error.message);
    return null;
  }
}

/**
 * Read agent metadata.json and user config to resolve the model preset for a given role.
 * @param {string} agentDir - Absolute path to the agent directory
 * @param {'default'|'exploration'|'sub'|'system'} role
 * @returns {{ llm: import('agentdev').LLMClient, modelName: string, presetName: string, providerName: string, provider: string, protocol: string, apiSurface?: string, baseUrl: string, presetRole: string } | null}
 */
export function resolveAgentModelLLM(agentDir, role = 'default') {
  const metaPath = join(agentDir, 'metadata.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    
    // 从 agentDir 中提取 agentId（最后一级目录名）
    const agentId = agentDir.split(/[\\/]/).pop();
    
    // 读取用户配置文件（如果存在）
    const userConfigPath = join(PROTOCLAW_ROOT, '.agentdev', 'agent-configs', `${agentId}.json`);
    let userConfig = {};
    if (existsSync(userConfigPath)) {
      try {
        userConfig = JSON.parse(readFileSync(userConfigPath, 'utf8')) || {};
      } catch {}
    }
    
    // 合并配置：用户配置优先，metadata.json 中的 modelPresets 作为后备
    const presets = {
      ...(meta?.modelPresets || {}),
      ...(userConfig?.modelPresets || {})
    };
    
    if (!presets || typeof presets !== 'object') return null;
    
    const roleConfig = presets[role];
    let presetName = null;
    
    // 支持双槽位格式：{ primary: 'model1', secondary: 'model2' } 或旧格式字符串
    if (typeof roleConfig === 'string') {
      presetName = roleConfig;
    } else if (roleConfig && typeof roleConfig === 'object') {
      presetName = roleConfig.primary || null;
    }
    
    // 回退到 default
    if (!presetName && role !== 'default') {
      const defaultConfig = presets['default'];
      if (typeof defaultConfig === 'string') {
        presetName = defaultConfig;
      } else if (defaultConfig && typeof defaultConfig === 'object') {
        presetName = defaultConfig.primary || null;
      }
    }
    
    if (!presetName) return null;
    const resolved = resolveModelPresetLLM(presetName);
    return resolved ? { ...resolved, presetRole: role } : null;
  } catch (error) {
    console.warn(`[ModelPreset] Failed to read agent metadata from ${metaPath}:`, error.message);
    return null;
  }
}
