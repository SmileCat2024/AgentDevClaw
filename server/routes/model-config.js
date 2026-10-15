import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';

import { PROJECT_ROOT, MODEL_CONFIG_PATH, MODEL_PRESETS_PATH, MODEL_CONNECTIONS_PATH, DEFAULT_COMPRESS_RATIO, PH_STYLE_WORKSPACE_AGENT_IDS, AGENT_CONFIGS_ROOT, AGENT_USER_CONFIG_PATH } from '../shared/constants.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import { readJson, readJsonSafe, ensureDir } from '../shared/fs-helpers.js';
import { requestRuntimeAck } from '../shared/ipc.js';
import { getRuntimeByViewerAgentId, getAgentRuntime } from '../shared/agent-access.js';
import { resolveRuntimeControlTarget } from '../shared/operation-target.js';
import { bareId, resolveForwardHostTarget, forwardProtoclawRoute, readForwardTargetError } from '../shared/remote-forward.js';
import { buildLocalFailureResponse } from '../shared/operation-contract.js';
import { normalizeProgrammingHelperProcessMode, GLOBAL_SHARED_AGENT_ID } from '../shared/process-mode.js';
import { resolveOpenCodeBaseUrl, parseZenModelsResponse } from '../zen-helpers.js';
import { fetchWithRetry } from '../shared/fetch-retry.js';
import { resolveAccessTokenSync, buildCodexOAuthHeaders, DEFAULT_CLIENT_ID, DEFAULT_CODEX_BASE_URL } from '../oauth-codex.js';

export { normalizeProgrammingHelperProcessMode } from '../shared/process-mode.js';

// ── Model Config ──────────────────────────────────────────────────

async function readModelConfig() {
  try {
    const data = await readJson(MODEL_CONFIG_PATH);
    return data && typeof data === 'object' ? data : { defaultModel: {}, agent: {} };
  } catch {
    return { defaultModel: {}, agent: {} };
  }
}

async function writeModelConfig(config) {
  await ensureDir(path.dirname(MODEL_CONFIG_PATH));
  await fs.writeFile(MODEL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

async function readModelPresetsFile() {
  try {
    return await readJson(MODEL_PRESETS_PATH);
  } catch {
    return null;
  }
}

function normalizeModelPresetsData(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      providers: Array.isArray(data.providers) ? data.providers.filter(item => item && typeof item === 'object') : [],
      presets: Array.isArray(data.presets) ? data.presets.filter(item => item && typeof item === 'object') : [],
    };
  }
  if (Array.isArray(data)) {
    return buildStructuredModelPresets(data);
  }
  return { providers: [], presets: [] };
}

function resolvePresetApiSurface(protocol, authType, apiSurface) {
  if (protocol === 'openai' && authType === 'oauth-codex') return 'responses';
  return cleanSessionText(apiSurface) || 'chat';
}

function providerSignature(protocol, provider) {
  return JSON.stringify([
    protocol,
    cleanSessionText(provider?.endpoints?.[protocol]),
    cleanSessionText(provider?.apiKey),
    cleanSessionText(provider?.authType),
  ]);
}

function resolveProviderForPreset(normalized, protocol, providerName, presetBaseUrl, presetApiKey, presetAuthType) {
  const providers = normalized.providers;
  const nameMatches = providers.filter(provider => cleanSessionText(provider?.name) === providerName);
  if (nameMatches.length === 0) return null;

  const presetSignature = JSON.stringify([
    protocol,
    cleanSessionText(presetBaseUrl),
    cleanSessionText(presetApiKey),
    cleanSessionText(presetAuthType),
  ]);
  const exact = nameMatches.find(provider => providerSignature(protocol, provider) === presetSignature);
  if (exact) return exact;

  // Provider names may be shared by records for different protocols or auth
  // modes. Prefer a record that actually carries this protocol's endpoint so
  // an empty endpoint on the first same-name record cannot hide the URL.
  return nameMatches.find(provider => cleanSessionText(provider?.endpoints?.[protocol]))
    || nameMatches[0];
}

function flattenModelPresets(data) {
  const normalized = normalizeModelPresetsData(data);
  const mapped = normalized.presets.map((preset, index) => {
    const protocol = cleanSessionText(preset?.protocol || preset?.provider) || 'anthropic';
    const providerName = cleanSessionText(preset?.providerName);
    const catalogProvider = cleanSessionText(preset?.catalogProvider);
    const provider = catalogProvider ? null : resolveProviderForPreset(
      normalized,
      protocol,
      providerName,
      preset?.baseUrl,
      preset?.apiKey,
      preset?.authType,
    );
    const authType = catalogProvider === 'codex' ? 'oauth-codex' : (cleanSessionText(provider?.authType || preset?.authType) || '');
    const apiKey = catalogProvider ? '' : cleanSessionText(provider?.apiKey || preset?.apiKey);
    const baseUrl = catalogProvider === 'codex'
      ? 'https://chatgpt.com/backend-api/codex'
      : catalogProvider === 'opencode'
        ? 'https://opencode.ai/zen/v1'
        : cleanSessionText(provider?.endpoints?.[protocol] || preset?.baseUrl);
    return {
      name: cleanSessionText(preset?.name) || cleanSessionText(preset?.model) || `Preset ${index + 1}`,
      provider: protocol,
      providerName,
      catalogProvider: cleanSessionText(preset?.catalogProvider) || '',
      model: cleanSessionText(preset?.model),
      baseUrl,
      apiKey,
      authType,
      clientId: cleanSessionText(provider?.clientId || preset?.clientId) || '',
      apiSurface: resolvePresetApiSurface(protocol, authType, preset?.apiSurface),
      vision: preset?.vision === true,
      starred: preset?.starred === true,
      thinkingEffort: typeof preset?.thinkingEffort === 'string' && preset.thinkingEffort ? preset.thinkingEffort : null,
      thinkingBudgetTokens: Number.isFinite(Number(preset?.thinkingBudgetTokens)) ? Number(preset.thinkingBudgetTokens) : null,
      maxTokens: Number.isFinite(Number(preset?.maxTokens)) ? Number(preset.maxTokens) : null,
      temperature: Number.isFinite(Number(preset?.temperature)) ? Number(preset.temperature) : null,
      contextLength: Number.isFinite(Number(preset?.contextLength)) ? Number(preset.contextLength) : null,
      compressRatio: Number.isFinite(Number(preset?.compressRatio)) ? Math.max(1, Math.min(100, Number(preset.compressRatio))) : DEFAULT_COMPRESS_RATIO,
      countTokenPath: cleanSessionText(preset?.countTokenPath) || null,
      customHeaders: Array.isArray(preset?.customHeaders) ? preset.customHeaders.filter(h => h && typeof h === 'object') : [],
    };
  });
  // Starred presets float to the top (stable within each group) so every
  // consumer of the preset list — UI lists and dropdowns alike — shows them first.
  return mapped.sort((a, b) => (b.starred === true) - (a.starred === true));
}

function makeUniqueProviderName(baseName, usedNames) {
  const fallback = cleanSessionText(baseName) || 'Provider';
  let candidate = fallback;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${fallback} ${counter}`;
    counter += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function buildStructuredModelPresets(flatPresets, existingData = null) {
  const normalizedExisting = normalizeModelPresetsData(existingData);
  const existingProviderRecordsBySignature = new Map();
  const existingProvidersByName = new Map();
  normalizedExisting.providers.forEach((provider) => {
    const name = cleanSessionText(provider?.name);
    if (!name) return;
    if (!existingProvidersByName.has(name)) existingProvidersByName.set(name, []);
    existingProvidersByName.get(name).push(provider);
    const endpoints = provider?.endpoints && typeof provider.endpoints === 'object' ? provider.endpoints : {};
    Object.entries(endpoints).forEach(([protocol, endpoint]) => {
      const signature = JSON.stringify([cleanSessionText(protocol), cleanSessionText(endpoint), cleanSessionText(provider?.apiKey), cleanSessionText(provider?.authType)]);
      if (!existingProviderRecordsBySignature.has(signature)) existingProviderRecordsBySignature.set(signature, name);
    });
  });

  const providers = [];
  const presets = [];
  const providersBySignature = new Map();
  const usedNames = new Set();

  flatPresets.forEach((rawPreset, index) => {
    if (!rawPreset || typeof rawPreset !== 'object') return;
    const protocol = cleanSessionText(rawPreset.provider) || 'anthropic';
    const name = cleanSessionText(rawPreset.name) || cleanSessionText(rawPreset.model) || `Preset ${index + 1}`;
    const model = cleanSessionText(rawPreset.model);
    const requestedName = cleanSessionText(rawPreset.providerName);
    let baseUrl = cleanSessionText(rawPreset.baseUrl);
    const apiKey = cleanSessionText(rawPreset.apiKey);
    const authType = cleanSessionText(rawPreset.authType) || '';
    const clientId = cleanSessionText(rawPreset.clientId) || '';
    // A save arriving with an empty baseUrl must not erase the endpoint already
    // stored under the same provider name + protocol (partial payloads from
    // clients that echo a blank field). Inherit the stored endpoint so the
    // rebuilt record keeps it.
    if (!baseUrl && requestedName) {
      const inheritSource = (existingProvidersByName.get(requestedName) || [])
        .find(provider => cleanSessionText(provider?.endpoints?.[protocol]));
      if (inheritSource) baseUrl = cleanSessionText(inheritSource.endpoints[protocol]);
    }
    // Signature includes authType so OAuth providers (empty apiKey) don't collide with API-key providers
    const signature = JSON.stringify([protocol, baseUrl, apiKey, authType]);

    let providerName = providersBySignature.get(signature);
    if (!providerName) {
      const namedProviders = requestedName ? (existingProvidersByName.get(requestedName) || []) : [];
      const existingProvider = namedProviders.find(provider => providerSignature(protocol, provider) === signature);
      const existingSignature = existingProvider
        ? JSON.stringify([protocol, cleanSessionText(existingProvider?.endpoints?.[protocol]), cleanSessionText(existingProvider?.apiKey), cleanSessionText(existingProvider?.authType)])
        : '';
      if (requestedName && existingSignature === signature && !usedNames.has(requestedName)) {
        providerName = requestedName;
        usedNames.add(providerName);
      } else {
        providerName = existingProviderRecordsBySignature.get(signature) || makeUniqueProviderName(requestedName || name, usedNames);
        usedNames.add(providerName);
      }
      providersBySignature.set(signature, providerName);
      const providerRecord = {
        name: providerName,
        apiKey,
        endpoints: {},
      };
      if (authType) providerRecord.authType = authType;
      if (clientId) providerRecord.clientId = clientId;
      if (baseUrl) providerRecord.endpoints[protocol] = baseUrl;
      providers.push(providerRecord);
    }

    const presetRecord = {
      name,
      providerName,
      ...(cleanSessionText(rawPreset.catalogProvider) ? { catalogProvider: cleanSessionText(rawPreset.catalogProvider) } : {}),
      ...(cleanSessionText(rawPreset.catalogProvider) ? { baseUrl, apiKey, authType, clientId } : {}),
      protocol,
      apiSurface: resolvePresetApiSurface(protocol, authType, rawPreset.apiSurface),
      vision: rawPreset?.vision === true,
      starred: rawPreset?.starred === true,
      model,
      thinkingEffort: typeof rawPreset?.thinkingEffort === 'string' && rawPreset.thinkingEffort ? rawPreset.thinkingEffort : null,
      thinkingBudgetTokens: Number.isFinite(Number(rawPreset.thinkingBudgetTokens)) ? Number(rawPreset.thinkingBudgetTokens) : null,
      maxTokens: Number.isFinite(Number(rawPreset.maxTokens)) ? Number(rawPreset.maxTokens) : null,
      temperature: Number.isFinite(Number(rawPreset.temperature)) ? Number(rawPreset.temperature) : null,
      contextLength: Number.isFinite(Number(rawPreset.contextLength)) ? Number(rawPreset.contextLength) : null,
      compressRatio: Number.isFinite(Number(rawPreset.compressRatio)) ? Math.max(1, Math.min(100, Number(rawPreset.compressRatio))) : DEFAULT_COMPRESS_RATIO,
      countTokenPath: cleanSessionText(rawPreset.countTokenPath) || null,
      customHeaders: Array.isArray(rawPreset.customHeaders) ? rawPreset.customHeaders.filter(h => h && typeof h === 'object') : [],
    };
    presets.push(presetRecord);
  });

  return { providers, presets };
}

async function readModelPresets() {
  const data = await readModelPresetsFile();
  return normalizeModelPresetsData(data);
}

async function writeModelPresetsFile(presetsOrFile) {
  await ensureDir(path.dirname(MODEL_PRESETS_PATH));
  await fs.writeFile(MODEL_PRESETS_PATH, JSON.stringify(presetsOrFile, null, 2), 'utf8');
  return presetsOrFile;
}

async function readModelConnections() {
  const data = await readJsonSafe(MODEL_CONNECTIONS_PATH, {});
  const storedOpenCode = data?.opencode && typeof data.opencode === 'object' ? data.opencode : {};
  const presets = flattenModelPresets(await readModelPresets());
  const legacyPreset = presets.find((preset) => ['OpenCode Zen', 'OpenCode Go'].includes(preset.providerName) && preset.apiKey);
  return {
    opencode: {
      ...storedOpenCode,
      ...(storedOpenCode.apiKey || !legacyPreset ? {} : {
        apiKey: legacyPreset.apiKey,
        tier: legacyPreset.providerName === 'OpenCode Go' ? 'go' : 'zen',
      }),
    },
  };
}

async function writeModelConnections(data) {
  const next = {
    opencode: {
      apiKey: cleanSessionText(data?.opencode?.apiKey),
      tier: data?.opencode?.tier === 'go' ? 'go' : 'zen',
    },
  };
  await ensureDir(path.dirname(MODEL_CONNECTIONS_PATH));
  await fs.writeFile(MODEL_CONNECTIONS_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

async function writeModelPresets(flatPresets) {
  const existingData = await readModelPresetsFile();
  const nextData = buildStructuredModelPresets(Array.isArray(flatPresets) ? flatPresets : [], existingData);
  await writeModelPresetsFile(nextData);
  return flattenModelPresets(nextData);
}

async function resolveSessionModelInfo(agentId) {
  const presets = flattenModelPresets(await readModelPresets());
  const config = await readModelConfig();

  let presetName = null;
  if (agentId) {
    try {
      const userConfigPath = AGENT_USER_CONFIG_PATH(agentId);
      const userConfig = await readJson(userConfigPath) || {};
      const mp = userConfig?.modelPresets;
      if (mp && typeof mp === 'object') {
        // modelPresets values may be either a string preset name
        // or an object { primary, secondary } (dual-model slot format)
        const resolvePresetName = (val) => {
          if (typeof val === 'string') return val.trim() || null;
          if (val && typeof val === 'object') {
            return cleanSessionText(val.primary) || cleanSessionText(val.default) || null;
          }
          return null;
        };
        presetName = resolvePresetName(mp.default) || null;
      }
    } catch {}
  }

  if (!presetName && config.defaultModel?.model) {
    const dm = config.defaultModel;
    presetName = presets.find(p => p.model === dm.model && p.provider === (dm.provider || 'anthropic'))?.name || null;
  }

  if (presetName) {
    const preset = presets.find(p => p.name === presetName);
    if (preset) {
      const cl = Number.isFinite(preset.contextLength) && preset.contextLength > 0 ? preset.contextLength : null;
      const cr = Number.isFinite(preset.compressRatio) ? preset.compressRatio : 80;
      return {
        contextLength: cl,
        compressRatio: cr,
        modelName: preset.model || preset.name,
        presetName: preset.name,
      };
    }
  }

  for (const preset of presets) {
    if (Number.isFinite(preset.contextLength) && preset.contextLength > 0) {
      const cr = Number.isFinite(preset.compressRatio) ? preset.compressRatio : 80;
      return {
        contextLength: preset.contextLength,
        compressRatio: cr,
        modelName: preset.model || preset.name,
        presetName: preset.name,
      };
    }
  }
  return {
    contextLength: null,
    compressRatio: 80,
    modelName: config.defaultModel?.model || '',
    presetName: null,
  };
}

// ── Speech Model Config ───────────────────────────────────────────

export const DEFAULT_SPEECH_MODEL = {
  baseUrl: '',
  apiKey: '',
  model: '',
  language: 'auto',
  // ASR upstream surface: 'chat' = chat/completions with input_audio payload
  // (chat-surface ASR extension), 'audio' = OpenAI Audio transcriptions
  // (non-streaming), 'audio-stream' = streaming WS transcriptions channel.
  apiType: 'chat',
};

const SPEECH_MODEL_API_TYPES = new Set(['chat', 'audio', 'audio-stream']);

function normalizeSpeechApiType(raw) {
  return SPEECH_MODEL_API_TYPES.has(raw) ? raw : 'chat';
}

export function normalizeSpeechModel(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SPEECH_MODEL };
  return {
    baseUrl: cleanSessionText(raw.baseUrl) || '',
    apiKey: cleanSessionText(raw.apiKey) || '',
    model: cleanSessionText(raw.model) || DEFAULT_SPEECH_MODEL.model,
    language: cleanSessionText(raw.language) || DEFAULT_SPEECH_MODEL.language,
    apiType: normalizeSpeechApiType(cleanSessionText(raw.apiType)),
  };
}

function normalizeSpeechPreset(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    name: cleanSessionText(raw.name) || '',
    baseUrl: cleanSessionText(raw.baseUrl) || '',
    apiKey: cleanSessionText(raw.apiKey) || '',
    model: cleanSessionText(raw.model) || DEFAULT_SPEECH_MODEL.model,
    language: cleanSessionText(raw.language) || DEFAULT_SPEECH_MODEL.language,
    apiType: normalizeSpeechApiType(cleanSessionText(raw.apiType)),
  };
}

async function readSpeechModelConfig() {
  const config = await readModelConfig();
  const speechModel = normalizeSpeechModel(config.speechModel);
  const speechPresets = Array.isArray(config.speechPresets)
    ? config.speechPresets.map(normalizeSpeechPreset).filter(Boolean)
    : [];
  return { speechModel, speechPresets };
}

async function writeSpeechModelConfig(speechModel, speechPresets) {
  const config = await readModelConfig();
  config.speechModel = normalizeSpeechModel(speechModel);
  if (Array.isArray(speechPresets)) {
    config.speechPresets = speechPresets.map(normalizeSpeechPreset).filter(Boolean);
  }
  await writeModelConfig(config);
  return { speechModel: config.speechModel, speechPresets: config.speechPresets || [] };
}

// ── ASR Proxy helpers ─────────────────────────────────────────────

/**
 * Encode raw PCM samples as a WAV buffer (16kHz, 16-bit, mono).
 * Pure JS — no ffmpeg dependency. Ported from MiMo-Code voice.ts.
 */
export function encodeWav(samples) {
  const sampleRate = 16000;
  const isBuf = Buffer.isBuffer(samples);
  const dataSize = isBuf ? samples.length : (samples.length * 2);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  if (isBuf) {
    samples.copy(buffer, 44);
  } else {
    const int16 = new Int16Array(buffer.buffer, buffer.byteOffset + 44, samples.length);
    int16.set(samples);
  }
  return buffer;
}

/**
 * Convert audio buffer to 16kHz mono PCM16 WAV via ffmpeg.
 * Returns null if ffmpeg is not available or conversion fails.
 */
export function convertAudioToWav(inputBuffer) {
  return new Promise((resolve) => {
    const ffmpegArgs = ['-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'];
    const child = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let stderrData = '';

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (data) => { stderrData += data.toString(); });

    child.on('error', (err) => {
      console.error('[ASR Proxy] ffmpeg spawn error:', err.message);
      resolve(null);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // Log last 500 chars of stderr for diagnosis without flooding the console
        console.error('[ASR Proxy] ffmpeg exited with code', code, '| stderr:', stderrData.slice(-500));
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    child.stdin.write(inputBuffer);
    child.stdin.end();
  });
}

// ── ASR upstream request functions ────────────────────────────────
// Shared by the /protoclaw/speech_to_text proxy; exported for tests.
// Both are non-streaming. Audio preprocessing (ffmpeg → 16kHz mono WAV)
// happens in the proxy before these are called, so `audioMimeType` always
// describes `audioBuffer` truthfully.

function audioFileExtension(mimeType) {
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'wav';
}

/**
 * ASR via chat/completions with a base64 `input_audio` user message
 * (chat-surface ASR extension). Transcript is read from the standard
 * assistant message content.
 */
export async function requestAsrViaChatCompletions(speechConfig, audioBuffer, audioMimeType) {
  const dataUri = `data:${audioMimeType};base64,${audioBuffer.toString('base64')}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  const asrResp = await fetch(speechConfig.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${speechConfig.apiKey}`,
      'api-key': speechConfig.apiKey,
    },
    body: JSON.stringify({
      model: speechConfig.model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: dataUri },
            },
          ],
        },
      ],
      asr_options: { language: speechConfig.language || 'auto' },
    }),
    signal: controller.signal,
  }).catch(() => null);

  clearTimeout(timeout);

  if (!asrResp || !asrResp.ok) {
    const status = asrResp ? asrResp.status : 502;
    const detail = asrResp ? await asrResp.text().catch(() => '') : 'network error';
    return { ok: false, status, detail };
  }

  const data = await asrResp.json();
  return { ok: true, text: data?.choices?.[0]?.message?.content?.trim() || '' };
}

/**
 * ASR via the OpenAI Audio Transcriptions surface
 * (POST {baseUrl}/audio/transcriptions, multipart/form-data). The upstream
 * auto-detects the language when the parameter is omitted, so 'auto' is
 * simply not sent. Default response_format=json carries the transcript in
 * the top-level `text` field.
 */
export async function requestAsrViaAudioTranscriptions(speechConfig, audioBuffer, audioMimeType) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: audioMimeType }), `audio.${audioFileExtension(audioMimeType)}`);
  form.append('model', speechConfig.model);
  if (speechConfig.language && speechConfig.language !== 'auto') {
    form.append('language', speechConfig.language);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  const asrResp = await fetch(speechConfig.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${speechConfig.apiKey}`,
      'api-key': speechConfig.apiKey,
    },
    body: form,
    signal: controller.signal,
  }).catch(() => null);

  clearTimeout(timeout);

  if (!asrResp || !asrResp.ok) {
    const status = asrResp ? asrResp.status : 502;
    const detail = asrResp ? await asrResp.text().catch(() => '') : 'network error';
    return { ok: false, status, detail };
  }

  const data = await asrResp.json();
  return { ok: true, text: data?.text?.trim() || '' };
}

// ── Routes ────────────────────────────────────────────────────────
// Host/Global boundary: model_config and speech_model_config persist in the
// local user configuration files. They intentionally have no Agent target and
// never derive one from page focus. Agent-specific preset routes below require
// their explicit agentId and only write that Agent's user config file.

/**
 * Read an agent's model preset overrides.
 *
 * Some workspace identities (currently `coder`) are declared inside their
 * host's metadata.json and do not have a metadata file of their own. Missing
 * identity metadata is therefore resolved through the host identity registry,
 * rather than treated as an I/O error.
 *
 * @param {string} agentId
 * @param {string} rootDir - Test seam; defaults to the project root.
 * @param {{ userConfigPath?: string }} [options] - Optional user config path for isolated tests.
 * @returns {Promise<object|null>} merged metadata/user presets, or null when
 *   the agent and its host identity are unknown.
 */
export async function readAgentModelPresets(agentId, rootDir = PROJECT_ROOT, options = {}) {
  const metaPath = path.join(rootDir, 'prebuilt-agents', 'official', agentId, 'metadata.json');
  let meta = await readJsonSafe(metaPath, null);
  if (!meta) {
    const hostMeta = await readJsonSafe(
      path.join(rootDir, 'prebuilt-agents', 'official', 'programming-helper', 'metadata.json'),
      null,
    );
    const identity = Array.isArray(hostMeta?.identities)
      ? hostMeta.identities.find((entry) => entry.id === agentId)
      : null;
    if (!identity) return null;
    meta = identity;
  }

  const resolvedUserConfigPath = options.userConfigPath || AGENT_USER_CONFIG_PATH(agentId);
  const userConfig = await readJsonSafe(resolvedUserConfigPath, {}) || {};
  return {
    ...(meta.modelPresets || {}),
    ...(userConfig.modelPresets || {}),
  };
}

// ── Remote namespace adaptation (ADR-0011) ─────────────────────────
// protoclaw 族不走代理闸：路由内识别 remote: 命名空间，经共享 helper 转发远程
// 同名路由（裸 id），远程响应原文返回；失败按 operation 契约三分类呈现。
// 本地分支不经过转发函数，保持既有 IPC / 文件读取路径字节级不动。
// forwardProtoclawRoute / readForwardTargetError 提升于 shared/remote-forward.js。

/**
 * Codex /models 目录请求的 client_version 查询参数。后端要求该参数（缺失即 400
 * "Field required"），并按 ModelInfo.minimal_client_version 过滤可见模型。Claw 的
 * Responses 传输层不携带客户端版本相关能力，版本门槛对它不适用，取高版本避免
 * 新模型被隐藏；格式必须为纯 semver（"rust-v0.50.0" 会被拒收）。
 */
const CODEX_MODELS_CLIENT_VERSION = '99.0.0';

/**
 * 用 OAuth token 拉取 Codex 模型目录并解析为目录条目。model_catalog 与
 * openai-auth/models 两条路由共用同一请求形态与解析口径。
 * @returns {Promise<{models: Array<{id: string, displayName: string, contextLength: number|null,
 *   thinkingEffort: string|null, supportedThinkingEfforts: string[]}>}
 *   | {error: string, status: number}>}
 */
export async function fetchCodexModelCatalog(accessToken, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchWithRetry(
      `${DEFAULT_CODEX_BASE_URL}/models?client_version=${CODEX_MODELS_CLIENT_VERSION}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...Object.fromEntries(buildCodexOAuthHeaders(accessToken).map((header) => [header.key, header.value])),
        },
      },
      { operation: 'Codex model catalog request', fetchImpl },
    );
  } catch (error) {
    return { error: error?.message || 'Codex model catalog request failed: network error', status: 502 };
  }
  if (!response.ok) {
    return {
      error: `Codex model catalog request failed: ${response.status}`,
      status: response.status,
    };
  }
  const raw = await response.json().catch(() => null);
  const seen = new Set();
  const models = (Array.isArray(raw?.models) ? raw.models : [])
    // visibility=hide 是 OpenAI 明确不向选择器展示的内部模型（如 gpt-reserve），
    // 与 codex CLI 选择器同口径剔除；字段缺省视为 list。
    .filter((model) => cleanSessionText(model?.visibility) !== 'hide')
    .map((model) => {
      const id = cleanSessionText(model?.slug);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        displayName: cleanSessionText(model?.display_name) || id,
        contextLength: Number.isFinite(Number(model?.context_window)) ? Number(model.context_window) : null,
        thinkingEffort: cleanSessionText(model?.default_reasoning_level) || null,
        supportedThinkingEfforts: Array.isArray(model?.supported_reasoning_levels)
          ? model.supported_reasoning_levels.map((item) => cleanSessionText(item?.effort)).filter(Boolean)
          : [],
      };
    })
    .filter(Boolean);
  return { models };
}

export function setupModelConfigRoutes(app, express) {
  app.get('/protoclaw/model_connections', async (_req, res, next) => {
    try {
      const connections = await readModelConnections();
      const opencode = connections.opencode || {};
      res.json({ opencode: { hasApiKey: !!opencode.apiKey, tier: opencode.tier === 'go' ? 'go' : 'zen', apiKey: opencode.apiKey || '' } });
    } catch (error) { next(error); }
  });

  app.put('/protoclaw/model_connections', express.json(), async (req, res, next) => {
    try {
      const current = await readModelConnections();
      const nextOpenCode = req.body?.opencode || {};
      const saved = await writeModelConnections({
        opencode: {
          apiKey: typeof nextOpenCode.apiKey === 'string' && nextOpenCode.apiKey.trim() ? nextOpenCode.apiKey : current.opencode.apiKey,
          tier: nextOpenCode.tier,
        },
      });
      res.json({ opencode: { hasApiKey: !!saved.opencode.apiKey, tier: saved.opencode.tier, apiKey: saved.opencode.apiKey || '' } });
    } catch (error) { next(error); }
  });

  app.post('/protoclaw/model_catalog/:provider', express.json(), async (req, res, next) => {
    try {
      const provider = req.params.provider;
      if (provider === 'codex') {
        const oauthPresets = flattenModelPresets(await readModelPresets())
          .filter((preset) => preset.authType === 'oauth-codex' && preset.providerName);
        const tokenProviders = [...new Set(['OpenAI Auth', ...oauthPresets.map((preset) => preset.providerName)])];
        let accessToken = null;
        for (const providerName of tokenProviders) {
          accessToken = resolveAccessTokenSync(providerName, DEFAULT_CLIENT_ID);
          if (accessToken) break;
        }
        if (!accessToken) return res.status(401).json({ error: 'OpenAI Auth is not logged in' });
        const result = await fetchCodexModelCatalog(accessToken);
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ models: result.models });
      }

      if (provider === 'opencode') {
        const connections = await readModelConnections();
        const connection = connections.opencode;
        if (!connection?.apiKey) return res.status(400).json({ error: 'OpenCode API key is not configured' });
        const tier = connection.tier === 'go' ? 'go' : 'zen';
        let response;
        try {
          response = await fetchWithRetry(`${resolveOpenCodeBaseUrl(tier)}/models`, {
            headers: { Authorization: `Bearer ${connection.apiKey}` },
          }, { operation: `OpenCode ${tier} model catalog` });
        } catch (error) {
          return res.status(502).json({ error: error?.message || `OpenCode ${tier} model catalog request failed: network error` });
        }
        if (!response.ok) {
          return res.status(response.status).json({ error: `OpenCode ${tier} model catalog request failed: ${response.status}` });
        }
        const raw = await response.json().catch(() => ({ data: [] }));
        return res.json({ models: parseZenModelsResponse(raw) });
      }

      return res.status(400).json({ error: 'Unsupported model catalog provider' });
    } catch (error) { next(error); }
  });

  app.get('/protoclaw/model_config', async (req, res, next) => {
    try {
      // ADR-0011：host 域默认本地；调用方携带会话命名空间（remote:<connId>:…）
      // 时显式派生 connectionId 转发远程同名路由，返回远程自己的 config/preset
      // 列表。本地调用（无命名空间）行为不变。
      let hostTarget;
      try {
        hostTarget = resolveForwardHostTarget(typeof req.query.agentId === 'string' ? req.query.agentId : '');
      } catch (error) {
        return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
      }
      if (hostTarget.scope === 'remote') {
        return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/model_config');
      }
      const config = await readModelConfig();
      const presets = flattenModelPresets(await readModelPresets());
      const connections = await readModelConnections();
      res.json({ config, presets, connections: { opencode: { hasApiKey: !!connections.opencode.apiKey, tier: connections.opencode.tier } }, configPath: MODEL_CONFIG_PATH });
    } catch (error) {
      next(error);
    }
  });

  app.put('/protoclaw/model_config', express.json(), async (req, res, next) => {
    try {
      const { config, presets } = req.body || {};

      let savedConfig = null;
      let savedPresets = null;
      if (config && typeof config === 'object') {
        savedConfig = await writeModelConfig(config);
      }
      if (Array.isArray(presets)) {
        savedPresets = await writeModelPresets(presets);
      }
      res.json({
        config: savedConfig ?? await readModelConfig(),
        presets: savedPresets ?? flattenModelPresets(await readModelPresets()),
        connections: { opencode: { hasApiKey: !!(await readModelConnections()).opencode.apiKey, tier: (await readModelConnections()).opencode.tier } },
        configPath: MODEL_CONFIG_PATH,
        savedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Speech Model Config ──

  app.get('/protoclaw/speech_model_config', async (_req, res, next) => {
    try {
      const { speechModel, speechPresets } = await readSpeechModelConfig();
      res.json({ speechModel, speechPresets });
    } catch (error) {
      next(error);
    }
  });

  app.put('/protoclaw/speech_model_config', express.json(), async (req, res, next) => {
    try {
      const { speechModel, speechPresets } = req.body || {};
      if (!speechModel || typeof speechModel !== 'object') {
        return res.status(400).json({ error: 'speechModel object is required' });
      }
      const saved = await writeSpeechModelConfig(speechModel, speechPresets);
      res.json({ speechModel: saved.speechModel, speechPresets: saved.speechPresets, savedAt: new Date().toISOString() });
    } catch (error) {
      next(error);
    }
  });

  // ── ASR Proxy ──

  app.post('/protoclaw/speech_to_text', express.raw({ type: '*/*', limit: '20mb' }), async (req, res, next) => {
    try {
      const { speechModel: speechConfig } = await readSpeechModelConfig();
      if (!speechConfig.apiKey || !speechConfig.baseUrl) {
        return res.status(400).json({ error: 'Speech model not configured. Set baseUrl and apiKey in Speech settings.' });
      }

      let audioBuffer = req.body;
      if (!audioBuffer || audioBuffer.length === 0) {
        return res.status(400).json({ error: 'No audio data received' });
      }

      const contentType = req.headers['content-type'] || 'audio/wav';
      const isWebm = contentType.includes('webm');
      const isMp3 = contentType.includes('mp3') || contentType.includes('mpeg');
      const isWav = contentType.includes('wav') || (!isWebm && !isMp3);

      let audioMimeType = 'audio/wav';

      if (!isWav) {
        const converted = await convertAudioToWav(audioBuffer);
        if (converted) {
          audioBuffer = converted;
          // audioMimeType stays 'audio/wav'
        } else {
          // ffmpeg failed — send the original compressed format directly.
          // Most ASR APIs (Whisper, GLM-4-Voice, etc.) accept webm/ogg natively.
          // Do NOT treat compressed binary as raw PCM — that produces garbage.
          audioMimeType = isWebm ? 'audio/webm' : isMp3 ? 'audio/mpeg' : 'audio/ogg';
          console.warn(`[ASR Proxy] ffmpeg conversion failed, sending original format (${audioMimeType}) to ASR`);
        }
      }

      const asrResult = speechConfig.apiType === 'audio'
        ? await requestAsrViaAudioTranscriptions(speechConfig, audioBuffer, audioMimeType)
        : await requestAsrViaChatCompletions(speechConfig, audioBuffer, audioMimeType);

      if (!asrResult.ok) {
        return res.status(asrResult.status).json({ error: `ASR request failed: ${asrResult.status}`, detail: asrResult.detail });
      }

      res.json({ text: asrResult.text });
    } catch (error) {
      next(error);
    }
  });

  // ── Agent Workspace Process Mode ──

  app.get('/protoclaw/agent_process_mode', async (req, res, next) => {
    try {
      const agentId = cleanSessionText(req.query.agentId);
      if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(agentId)) {
        return res.status(400).json({ error: 'agentId is not supported for process mode config' });
      }
      const metaPath = path.join(PROJECT_ROOT, 'prebuilt-agents', 'official', agentId, 'metadata.json');
      const userConfigPath = AGENT_USER_CONFIG_PATH(agentId);
      const [meta, userConfig] = await Promise.all([
        readJsonSafe(metaPath, {}),
        readJsonSafe(userConfigPath, {}),
      ]);
      const processMode = normalizeProgrammingHelperProcessMode(userConfig?.processMode)
        || normalizeProgrammingHelperProcessMode(meta?.processMode)
        || 'isolated';
      res.json({ agentId, processMode });
    } catch (error) { next(error); }
  });

  app.put('/protoclaw/agent_process_mode', express.json(), async (req, res, next) => {
    try {
      const agentId = cleanSessionText(req.body?.agentId);
      const processMode = normalizeProgrammingHelperProcessMode(req.body?.processMode);
      if (!PH_STYLE_WORKSPACE_AGENT_IDS.has(agentId)) {
        return res.status(400).json({ error: 'agentId is not supported for process mode config' });
      }
      // shared-global 进程宿主仍限定 programming-helper（见 agent-startup.js 设计注释）
      if (processMode === 'shared-global' && agentId !== GLOBAL_SHARED_AGENT_ID) {
        return res.status(400).json({ error: 'shared-global process mode is only available for programming-helper' });
      }
      if (!processMode) {
        return res.status(400).json({ error: 'processMode must be isolated, shared-by-project, or shared-global' });
      }
      const userConfigDir = AGENT_CONFIGS_ROOT;
      await fs.mkdir(userConfigDir, { recursive: true });
      const userConfigPath = path.join(userConfigDir, `${agentId}.json`);
  const resolvedUserConfigPath = userConfigPath || AGENT_USER_CONFIG_PATH(agentId);
  const userConfig = await readJsonSafe(resolvedUserConfigPath, {}) || {};
      userConfig.processMode = processMode;
      await fs.writeFile(userConfigPath, JSON.stringify(userConfig, null, 2), 'utf8');
      res.json({ ok: true, agentId, processMode });
    } catch (error) { next(error); }
  });

  // ── Agent Model Presets ──

  app.get('/protoclaw/agent_model_presets', async (req, res, next) => {
    try {
      const agentId = req.query.agentId;
      if (!agentId || typeof agentId !== 'string') {
        return res.status(400).json({ error: 'agentId is required' });
      }
      const modelPresets = await readAgentModelPresets(agentId);
      if (!modelPresets) {
        return res.status(404).json({ error: 'Agent metadata not found' });
      }

      res.json({ agentId, modelPresets });
    } catch (error) { next(error); }
  });

  app.put('/protoclaw/agent_model_presets', express.json(), async (req, res, next) => {
    try {
      const { agentId, modelPresets } = req.body || {};
      if (!agentId || typeof agentId !== 'string') {
        return res.status(400).json({ error: 'agentId is required' });
      }
      if (!modelPresets || typeof modelPresets !== 'object') {
        return res.status(400).json({ error: 'modelPresets object is required' });
      }

      // Write user-level agent config (independent of metadata.json)
      const userConfigDir = AGENT_CONFIGS_ROOT;
      await fs.mkdir(userConfigDir, { recursive: true });
      const userConfigPath = path.join(userConfigDir, `${agentId}.json`);

      const existingConfig = await readJsonSafe(userConfigPath, {}) || {};

      existingConfig.modelPresets = modelPresets;

      await fs.writeFile(userConfigPath, JSON.stringify(existingConfig, null, 2), 'utf8');

      res.json({ ok: true, agentId, modelPresets });
    } catch (error) { next(error); }
  });

  // ── Hot-swap request/ack ──
  // swap 指令带 requestId 发送，等待 runtime 执行 setModel/setThinkingEffort 后的
  // 回执（type 'model-swap-result'）再响应前端——ok 表示"切换已生效"而非"消息已
  // 送达"。preset 不存在、OAuth token 缺失等失败对前端可见。requestId 全局唯一，
  // type + requestId 足以匹配回执，无需 sessionId 三重匹配。
  const requestModelSwapAck = (runtime, message) => requestRuntimeAck(runtime, message, 'model-swap-result');

  // ── Hot-swap: switch thinking effort for one explicit runtime ──
  // Runtime-only: updates the in-memory LLM instance without touching the
  // preset definition in config/presets.json. The preset's thinkingEffort is
  // the authoritative default at launch and must not be mutated by a
  // mid-session adjustment.
  // Per-session: when sessionId is provided, IPC is delivered only to that
  // session's runtime — not broadcast to all sessions of the agent.
  app.post('/protoclaw/swap_thinking_effort', express.json(), async (req, res, next) => {
    try {
      const { thinkingEffort } = req.body || {};
      let target;
      try {
        target = resolveRuntimeControlTarget(req.body);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code });
      }
      const { agentId, sessionId, runtimeId } = target;
      // ADR-0011：远程命名空间身份 → 转发远程同名 swap 路由（裸 id，远程端做
      // 自己的 IPC）；本地身份走下方既有 IPC 查表路径，行为字节级不动。
      try {
        const hostTarget = resolveForwardHostTarget(runtimeId, agentId, sessionId);
        if (hostTarget.scope === 'remote') {
          return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/swap_thinking_effort', {
            method: 'POST',
            body: {
              ...(req.body || {}),
              agentId: bareId(agentId),
              runtimeId: bareId(runtimeId),
              sessionId: bareId(sessionId),
            },
          });
        }
      } catch (error) {
        return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
      }
      // thinkingEffort is null (clear → vendor default) or a non-empty string
      const normalized = thinkingEffort === null
        ? null
        : (typeof thinkingEffort === 'string' && thinkingEffort ? thinkingEffort : null);

      const message = { type: 'swap-thinking', thinkingEffort: normalized };
      let result = { ok: false, error: 'no reachable runtime for this target' };

      // Priority 1: runtimeId (viewerAgentId) — the most precise identifier.
      if (runtimeId && typeof runtimeId === 'string') {
        const rt = getRuntimeByViewerAgentId(runtimeId);
        if (rt && rt.process && rt.process.exitCode === null && !rt.stopped) {
          result = await requestModelSwapAck(rt, message);
        }
      }
      // Priority 2: agentId + sessionId — fallback when runtimeId is unavailable
      if (!result.ok && sessionId && typeof sessionId === 'string') {
        const rt = getAgentRuntime(agentId, sessionId);
        if (rt) result = await requestModelSwapAck(rt, message);
      }
      // No broadcast fallback: an explicit runtime/session request must not
      // change another session's in-memory model.

      if (!result.ok) {
        return res.status(502).json({ ok: false, agentId, thinkingEffort: normalized, error: result.error });
      }
      res.json({ ok: true, agentId, thinkingEffort: normalized, meta: result.meta });
    } catch (error) { next(error); }
  });

  // ── Hot-swap: switch active model for one explicit runtime ──
  // Runtime-only: updates the in-memory LLM instance without touching the
  // agent's startup preset (用户数据目录 agent-configs)。 The preset file is the
  // authoritative source for "what model to use at launch" and must not be
  // mutated by a mid-session model switch.
  // Per-session: when sessionId is provided, IPC is delivered only to that
  // session's runtime — not broadcast to all sessions of the agent.
  app.post('/protoclaw/swap_model', express.json(), async (req, res, next) => {
    try {
      const { presetName } = req.body || {};
      let target;
      try {
        target = resolveRuntimeControlTarget(req.body);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code });
      }
      const { agentId, sessionId, runtimeId } = target;
      // ADR-0011：远程命名空间身份 → 转发远程同名 swap 路由（裸 id，远程端做
      // 自己的 IPC）；本地身份走下方既有 IPC 查表路径，行为字节级不动。
      try {
        const hostTarget = resolveForwardHostTarget(runtimeId, agentId, sessionId);
        if (hostTarget.scope === 'remote') {
          return await forwardProtoclawRoute(res, hostTarget, '/protoclaw/swap_model', {
            method: 'POST',
            body: {
              ...(req.body || {}),
              agentId: bareId(agentId),
              runtimeId: bareId(runtimeId),
              sessionId: bareId(sessionId),
            },
          });
        }
      } catch (error) {
        return res.status(readForwardTargetError(error)).json(buildLocalFailureResponse(error));
      }
      if (!presetName || typeof presetName !== 'string') {
        return res.status(400).json({ error: 'presetName is required' });
      }

      const message = { type: 'swap-model', presetName };
      let result = { ok: false, error: 'no reachable runtime for this target' };

      // Priority 1: runtimeId (viewerAgentId) — the most precise identifier.
      // The frontend always knows currentRuntimeAgentId, which uniquely
      // identifies the session's runtime process.
      if (runtimeId && typeof runtimeId === 'string') {
        const rt = getRuntimeByViewerAgentId(runtimeId);
        if (rt && rt.process && rt.process.exitCode === null && !rt.stopped) {
          result = await requestModelSwapAck(rt, message);
        }
      }

      // Priority 2: agentId + sessionId — fallback when runtimeId is unavailable
      if (!result.ok && sessionId && typeof sessionId === 'string') {
        const rt = getAgentRuntime(agentId, sessionId);
        if (rt) result = await requestModelSwapAck(rt, message);
      }

      // No broadcast fallback: an explicit runtime/session request must not
      // change another session's in-memory model.

      if (!result.ok) {
        return res.status(502).json({ ok: false, agentId, presetName, error: result.error });
      }
      res.json({ ok: true, agentId, presetName, meta: result.meta });
    } catch (error) { next(error); }
  });

  // ── OpenAI Auth: list models from the Codex catalog using the stored OAuth token ──
  app.post('/protoclaw/openai-auth/models', express.json(), async (req, res, next) => {
    try {
      const providerName = cleanSessionText(req.body?.providerName);
      if (!providerName) return res.status(400).json({ error: 'providerName is required' });
      const accessToken = resolveAccessTokenSync(providerName, DEFAULT_CLIENT_ID);
      if (!accessToken) return res.status(401).json({ error: 'OpenAI Auth is not logged in' });

      const result = await fetchCodexModelCatalog(accessToken);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json({ models: result.models });
    } catch (error) { next(error); }
  });

  // ── OpenCode: list models from the selected official gateway ──
  // The user manages their API key and any Go subscription in OpenCode.
  // This route only proxies the fixed Zen or Go model catalogue.
  app.post('/protoclaw/opencode/models', express.json(), async (req, res, next) => {
    try {
      const apiKey = cleanSessionText(req.body?.apiKey);
      const tier = req.body?.tier === 'go' ? 'go' : 'zen';
      if (!apiKey) {
        return res.status(400).json({ error: 'apiKey is required' });
      }

      const baseUrl = resolveOpenCodeBaseUrl(tier);
      let gatewayResp;
      try {
        gatewayResp = await fetchWithRetry(`${baseUrl}/models`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        }, { operation: `OpenCode ${tier} models` });
      } catch (error) {
        return res.status(502).json({ error: `OpenCode ${tier} API request failed: 502`, detail: error?.message || 'network error' });
      }

      if (!gatewayResp.ok) {
        const status = gatewayResp.status;
        const errText = await gatewayResp.text().catch(() => '');
        return res.status(status).json({ error: `OpenCode ${tier} API request failed: ${status}`, detail: errText });
      }

      const raw = await gatewayResp.json().catch(() => ({ data: [] }));
      const models = parseZenModelsResponse(raw);
      res.json({ models });
    } catch (error) {
      next(error);
    }
  });
}

export {
  readModelConfig,
  writeModelConfig,
  readModelPresets,
  writeModelPresetsFile,
  resolveSessionModelInfo,
  normalizeModelPresetsData,
  flattenModelPresets,
  buildStructuredModelPresets,
  resolvePresetApiSurface,
  normalizeSpeechPreset,
  readSpeechModelConfig,
};
