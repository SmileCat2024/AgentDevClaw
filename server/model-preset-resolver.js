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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const PRESETS_PATH = join(PROTOCLAW_ROOT, 'config', 'presets.json');

/**
 * Resolve a preset name to { llm, modelName }.
 * @param {string} presetName
 * @returns {{ llm: import('agentdev').LLMClient, modelName: string } | null}
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
    const apiKey = provider.apiKey || '';
    if (!baseUrl || !apiKey || !preset.model) {
      console.warn(`[ModelPreset] Incomplete config for preset "${presetName}": baseUrl=${!!baseUrl} apiKey=${!!apiKey} model=${!!preset.model}`);
      return null;
    }
    const llm = createLLM({
      provider: protocol,
      model: preset.model,
      apiKey,
      baseUrl,
      thinkingBudgetTokens: preset.thinkingBudgetTokens ?? undefined,
      ...(preset.maxTokens ? { maxTokens: preset.maxTokens } : {}),
      ...(Array.isArray(preset.customHeaders) && preset.customHeaders.length > 0
        ? { customHeaders: preset.customHeaders }
        : {}),
    });
    console.log(`[ModelPreset] Resolved preset "${presetName}" => ${preset.model} (${protocol})`);
    return { llm, modelName: preset.model };
  } catch (error) {
    console.warn(`[ModelPreset] Failed to resolve preset "${presetName}":`, error.message);
    return null;
  }
}

/**
 * Read agent metadata.json and resolve the model preset for a given role.
 * @param {string} agentDir - Absolute path to the agent directory
 * @param {'default'|'exploration'|'sub'} role
 * @returns {{ llm: import('agentdev').LLMClient, modelName: string } | null}
 */
export function resolveAgentModelLLM(agentDir, role = 'default') {
  const metaPath = join(agentDir, 'metadata.json');
  if (!existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const presets = meta?.modelPresets;
    if (!presets || typeof presets !== 'object') return null;
    const presetName = presets[role] || presets['default'] || null;
    if (!presetName) return null;
    return resolveModelPresetLLM(presetName);
  } catch (error) {
    console.warn(`[ModelPreset] Failed to read agent metadata from ${metaPath}:`, error.message);
    return null;
  }
}
