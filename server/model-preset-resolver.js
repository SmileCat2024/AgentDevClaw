/**
 * Shared model preset resolver for prebuilt agent runtimes.
 *
 * Reads config/presets.json and agent metadata.json to resolve a preset name
 * into an LLM instance via AgentDev's createLLM().
 */

import { join, resolve, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createLLM } from '@agentdevjs/llm';
import { buildCodexOAuthHeaders, resolveAccessTokenSync } from './oauth-codex.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const PRESETS_PATH = join(PROTOCLAW_ROOT, 'config', 'presets.json');

/**
 * 全局默认模型的合成 preset 名。config/default.json 的内联 defaultModel 没有
 * preset 身份；赋此名后，显示、切换、档位调整与普通 preset 走同一条链路，
 * 下游无需为"匿名模型"做任何特判。
 */
export const GLOBAL_DEFAULT_PRESET_NAME = '__default__';

/**
 * Resolve a preset name to { llm, modelName }.
 * @param {string} presetName
 * @param {{ thinkingEffort?: string | null }} [overrides] - Runtime overrides for this resolution only; does not mutate config/presets.json.
 * @param {{ configPath?: string, resolveAccessToken?: (providerName: string, clientId?: string) => string | null }} [options]
 *   Test seam — production callers omit. configPath overrides config/presets.json;
 *   resolveAccessToken replaces the OAuth token-store lookup.
 * @returns {{ llm: import('@agentdevjs/llm').LLMClient, modelName: string, presetName: string, providerName: string, provider: string, protocol: string, apiSurface?: string, baseUrl: string } | null}
 */
export function resolveModelPresetLLM(presetName, overrides, options = {}) {
  const configPath = options.configPath || PRESETS_PATH;
  if (!presetName || !existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
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

    // thinkingEffort: runtime override takes priority, then preset default.
    const effectiveThinkingEffort = (overrides && typeof overrides === 'object' && 'thinkingEffort' in overrides)
      ? (overrides.thinkingEffort || undefined)
      : (preset.thinkingEffort || undefined);

    // OAuth provider: resolve access_token from token store
    const isOAuth = provider.authType === 'oauth-codex';
    let apiKey;
    if (isOAuth) {
      apiKey = (options.resolveAccessToken || resolveAccessTokenSync)(provider.name, provider.clientId) || '';
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
      thinkingEffort: effectiveThinkingEffort || null,
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
 * @param {'default'|'system'} role
 * @param {{ configPath?: string, userConfigPath?: string, resolveAccessToken?: (providerName: string, clientId?: string) => string | null }} [options]
 *   Test seam — production callers omit. Threaded through to resolveModelPresetLLM;
 *   userConfigPath overrides the per-agent user config location.
 * @returns {{ llm: import('@agentdevjs/llm').LLMClient, modelName: string, presetName: string, providerName: string, provider: string, protocol: string, apiSurface?: string, baseUrl: string, presetRole: string } | null}
 */
export function resolveAgentModelLLM(agentDir, role = 'default', options = {}) {
  const metaPath = join(agentDir, 'metadata.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    
    // 从 agentDir 中提取 agentId（最后一级目录名）
    const agentId = agentDir.split(/[\\/]/).pop();
    
    // 读取用户配置文件（如果存在）
    const userConfigPath = options.userConfigPath
      || join(PROTOCLAW_ROOT, '.agentdev', 'agent-configs', `${agentId}.json`);
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
    const resolved = resolveModelPresetLLM(presetName, undefined, options);
    return resolved ? { ...resolved, presetRole: role } : null;
  } catch (error) {
    console.warn(`[ModelPreset] Failed to read agent metadata from ${metaPath}:`, error.message);
    return null;
  }
}

/**
 * Fallback chain when an agent has no model preset configured:
 *   1. config/default.json 的 defaultModel（内联完整配置）
 *   2. config/default.json 的 defaultModel.model 在 config/presets.json 中匹配同名 preset
 *
 * 新框架 BasicAgent 的 llm 为必传（票 009 纯基类化），无 preset 的 agent
 * （如 qqbot / agent-studio）依赖此兜底完成构造。
 *
 * 返回携带合成 preset 名 GLOBAL_DEFAULT_PRESET_NAME：全局默认是"具名"模型，
 * 档位重造（setThinkingEffort）与普通 preset 走同一链路。
 *
 * @param {{ thinkingEffort?: string | null }} [overrides] - 运行时档位覆盖；null 清除为厂商默认。
 * @param {{ configPath?: string, presetsPath?: string }} [options] - Test seam — production callers omit.
 *   configPath overrides config/default.json（inline 分支生效）；
 *   presetsPath overrides config/presets.json（窗口元数据补齐）。
 * @returns {{ llm: import('@agentdevjs/llm').LLMClient, modelName: string, presetName: string, thinkingEffort: string | null, provider: string, protocol: string } | null}
 */
export function resolveGlobalDefaultLLM(overrides, options = {}) {
  const configPath = options.configPath || join(PROTOCLAW_ROOT, 'config', 'default.json');
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const dm = raw?.defaultModel;
    if (dm?.model && dm?.baseUrl && dm?.apiKey) {
      // dm 本身是完整 ModelConfig；摊平传入以支持 thinkingEffort 运行时覆盖。
      const effectiveThinkingEffort = (overrides && 'thinkingEffort' in overrides)
        ? (overrides.thinkingEffort || undefined)
        : (dm.thinkingEffort || undefined);
      const llm = createLLM({ ...dm, thinkingEffort: effectiveThinkingEffort });
      // inline 形态天然只携带连接字段（apiKey/baseUrl/…），窗口元数据缺失时按
      // model 名从 presets.json 补齐——表条目是窗口元数据的权威来源。只补
      // contextLength/compressRatio 展示元数据，不碰连接字段；查不到保持
      // null（前端用量条不渲染，与改动前语义一致）。
      let windowMeta = {};
      if (!(Number.isFinite(Number(dm.contextLength)) && Number(dm.contextLength) > 0)) {
        try {
          const presetsPath = options.presetsPath || PRESETS_PATH;
          const presetsRaw = JSON.parse(readFileSync(presetsPath, 'utf8'));
          const presets = Array.isArray(presetsRaw?.presets) ? presetsRaw.presets : [];
          const match = presets.find((p) => p.model === dm.model);
          if (match) windowMeta = { contextLength: match.contextLength, compressRatio: match.compressRatio };
        } catch { /* presets 表不可读时保持无窗口元数据 */ }
      }
      const rawContextLength = Number(dm.contextLength ?? windowMeta.contextLength);
      const rawCompressRatio = Number(dm.compressRatio ?? windowMeta.compressRatio);
      console.log(`[ModelPreset] global default model (inline) => ${dm.model}`);
      return {
        llm,
        modelName: dm.model,
        presetName: GLOBAL_DEFAULT_PRESET_NAME,
        thinkingEffort: effectiveThinkingEffort || null,
        providerName: '',
        provider: dm.provider || '',
        protocol: dm.provider || '',
        authType: '',
        vision: dm.vision === true,
        contextLength: Number.isFinite(rawContextLength) && rawContextLength > 0
          ? rawContextLength : null,
        compressRatio: Number.isFinite(rawCompressRatio)
          ? Math.max(1, Math.min(100, rawCompressRatio)) : 80,
        baseUrl: dm.baseUrl,
      };
    }
  } catch (error) {
    console.warn(`[ModelPreset] global default model resolution skipped:`, error?.message || error);
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const defaultModel = raw?.defaultModel;
    if (defaultModel?.model) {
      const presetsRaw = JSON.parse(readFileSync(PRESETS_PATH, 'utf8'));
      const presets = Array.isArray(presetsRaw?.presets) ? presetsRaw.presets : [];
      const candidates = presets.filter((p) => p.model === defaultModel.model);
      const preset = candidates.find((p) => (p.protocol || 'anthropic') === (defaultModel.protocol || defaultModel.provider || 'anthropic'))
        || candidates[0];
      if (preset) {
        // 注意不透传 options：本函数的 configPath 指 default.json，
        // resolveModelPresetLLM 的 configPath 指 presets.json，语义不同。
        const resolved = resolveModelPresetLLM(preset.name, overrides);
        if (resolved) {
          console.log(`[ModelPreset] global default model via preset "${preset.name}" => ${preset.model}`);
          return resolved;
        }
      }
    }
  } catch (error) {
    console.warn(`[ModelPreset] preset-by-model-name fallback skipped:`, error?.message || error);
  }
  return null;
}

/**
 * 符合框架 ModelPresetResolver 契约的适配对象（宿主装配时注入 Agent 构造参数）。
 * '__default__' 别名在此层处理，resolveModelPresetLLM / resolveGlobalDefaultLLM
 * 的公共签名保持不变。
 */
function toResolvedPreset(r) {
  if (!r?.llm) return null;
  return {
    llm: r.llm,
    meta: {
      modelName: r.modelName,
      contextLength: r.contextLength ?? null,
      compressRatio: r.compressRatio,
      presetName: r.presetName,
      thinkingEffort: r.thinkingEffort ?? null,
      provider: r.protocol || r.provider || '',
    },
  };
}

export const modelPresetResolver = {
  /**
   * @param {string} presetName
   * @param {{ thinkingEffort?: string | null }} [overrides]
   * @param {{ configPath?: string, presetsPath?: string }} [options] - Test seam — production callers omit.
   */
  resolve(presetName, overrides, options) {
    const resolved = presetName === GLOBAL_DEFAULT_PRESET_NAME
      ? resolveGlobalDefaultLLM(overrides, options)
      : resolveModelPresetLLM(presetName, overrides, options);
    return toResolvedPreset(resolved);
  },
};
