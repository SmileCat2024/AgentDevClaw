import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';

import { PROJECT_ROOT, MODEL_CONFIG_PATH, MODEL_PRESETS_PATH } from '../shared/constants.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import { readJson, readJsonSafe, ensureDir } from '../shared/fs-helpers.js';

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

function flattenModelPresets(data) {
  const normalized = normalizeModelPresetsData(data);
  const providersByName = new Map();
  normalized.providers.forEach((provider) => {
    const name = cleanSessionText(provider?.name);
    if (name) providersByName.set(name, provider);
  });
  return normalized.presets.map((preset, index) => {
    const protocol = cleanSessionText(preset?.protocol || preset?.provider) || 'anthropic';
    const providerName = cleanSessionText(preset?.providerName);
    const provider = providerName ? providersByName.get(providerName) : null;
    return {
      name: cleanSessionText(preset?.name) || cleanSessionText(preset?.model) || `Preset ${index + 1}`,
      provider: protocol,
      providerName,
      model: cleanSessionText(preset?.model),
      baseUrl: cleanSessionText(provider?.endpoints?.[protocol] || preset?.baseUrl),
      apiKey: cleanSessionText(provider?.apiKey || preset?.apiKey),
      apiSurface: cleanSessionText(preset?.apiSurface) || 'chat',
      thinkingBudgetTokens: Number.isFinite(Number(preset?.thinkingBudgetTokens)) ? Number(preset.thinkingBudgetTokens) : null,
      maxTokens: Number.isFinite(Number(preset?.maxTokens)) ? Number(preset.maxTokens) : null,
      temperature: Number.isFinite(Number(preset?.temperature)) ? Number(preset.temperature) : null,
      contextLength: Number.isFinite(Number(preset?.contextLength)) ? Number(preset.contextLength) : null,
      compressRatio: Number.isFinite(Number(preset?.compressRatio)) ? Math.max(1, Math.min(100, Number(preset.compressRatio))) : 80,
      countTokenPath: cleanSessionText(preset?.countTokenPath) || null,
      customHeaders: Array.isArray(preset?.customHeaders) ? preset.customHeaders.filter(h => h && typeof h === 'object') : [],
    };
  });
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
  const existingProvidersByName = new Map();
  const existingProviderNameBySignature = new Map();
  normalizedExisting.providers.forEach((provider) => {
    const name = cleanSessionText(provider?.name);
    if (!name) return;
    existingProvidersByName.set(name, provider);
    const endpoints = provider?.endpoints && typeof provider.endpoints === 'object' ? provider.endpoints : {};
    Object.entries(endpoints).forEach(([protocol, endpoint]) => {
      existingProviderNameBySignature.set(JSON.stringify([cleanSessionText(protocol), cleanSessionText(endpoint), cleanSessionText(provider?.apiKey)]), name);
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
    const baseUrl = cleanSessionText(rawPreset.baseUrl);
    const apiKey = cleanSessionText(rawPreset.apiKey);
    const signature = JSON.stringify([protocol, baseUrl, apiKey]);

    let providerName = providersBySignature.get(signature);
    if (!providerName) {
      const requestedName = cleanSessionText(rawPreset.providerName);
      const existingProvider = requestedName ? existingProvidersByName.get(requestedName) : null;
      const existingSignature = existingProvider
        ? JSON.stringify([protocol, cleanSessionText(existingProvider?.endpoints?.[protocol]), cleanSessionText(existingProvider?.apiKey)])
        : '';
      if (requestedName && existingSignature === signature && !usedNames.has(requestedName)) {
        providerName = requestedName;
        usedNames.add(providerName);
      } else {
        providerName = existingProviderNameBySignature.get(signature) || makeUniqueProviderName(requestedName || name, usedNames);
        usedNames.add(providerName);
      }
      providersBySignature.set(signature, providerName);
      const providerRecord = {
        name: providerName,
        apiKey,
        endpoints: {},
      };
      if (baseUrl) providerRecord.endpoints[protocol] = baseUrl;
      providers.push(providerRecord);
    }

    const presetRecord = {
      name,
      providerName,
      protocol,
      apiSurface: cleanSessionText(rawPreset.apiSurface) || 'chat',
      model,
      thinkingBudgetTokens: Number.isFinite(Number(rawPreset.thinkingBudgetTokens)) ? Number(rawPreset.thinkingBudgetTokens) : null,
      maxTokens: Number.isFinite(Number(rawPreset.maxTokens)) ? Number(rawPreset.maxTokens) : null,
      temperature: Number.isFinite(Number(rawPreset.temperature)) ? Number(rawPreset.temperature) : null,
      contextLength: Number.isFinite(Number(rawPreset.contextLength)) ? Number(rawPreset.contextLength) : null,
      compressRatio: Number.isFinite(Number(rawPreset.compressRatio)) ? Math.max(1, Math.min(100, Number(rawPreset.compressRatio))) : 80,
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

async function writeModelPresets(flatPresets) {
  const existingData = await readModelPresetsFile();
  const nextData = buildStructuredModelPresets(Array.isArray(flatPresets) ? flatPresets : [], existingData);
  await writeModelPresetsFile(nextData);
  return flattenModelPresets(nextData);
}

async function resolveSessionModelInfo(agentId, sessionType) {
  const presets = flattenModelPresets(await readModelPresets());
  const config = await readModelConfig();
  const role = sessionType === 'exploration' ? 'exploration' : sessionType === 'sub' ? 'sub' : 'default';

  let presetName = null;
  if (agentId) {
    try {
      const userConfigPath = path.join(PROJECT_ROOT, '.agentdev', 'agent-configs', `${agentId}.json`);
      const userConfig = await readJson(userConfigPath) || {};
      const mp = userConfig?.modelPresets;
      if (mp && typeof mp === 'object') {
        presetName = mp[role] || mp.default || null;
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

const DEFAULT_SPEECH_MODEL = {
  baseUrl: '',
  apiKey: '',
  model: 'mimo-v2.5-asr',
  language: 'auto',
};

function normalizeSpeechModel(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SPEECH_MODEL };
  return {
    baseUrl: cleanSessionText(raw.baseUrl) || '',
    apiKey: cleanSessionText(raw.apiKey) || '',
    model: cleanSessionText(raw.model) || DEFAULT_SPEECH_MODEL.model,
    language: cleanSessionText(raw.language) || DEFAULT_SPEECH_MODEL.language,
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
function encodeWav(samples) {
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
function convertAudioToWav(inputBuffer) {
  return new Promise((resolve) => {
    const ffmpegArgs = ['-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'];
    const child = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.resume();

    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks));
      }
    });

    child.stdin.write(inputBuffer);
    child.stdin.end();
  });
}

// ── Routes ────────────────────────────────────────────────────────

export function setupModelConfigRoutes(app, express) {
  app.get('/protoclaw/model_config', async (_req, res, next) => {
    try {
      const config = await readModelConfig();
      const presets = flattenModelPresets(await readModelPresets());
      res.json({ config, presets, configPath: MODEL_CONFIG_PATH });
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

      if (!isWav) {
        const converted = await convertAudioToWav(audioBuffer);
        if (converted) {
          audioBuffer = converted;
        } else {
          console.warn('[ASR Proxy] ffmpeg conversion failed, attempting raw PCM encode');
          const pcmSamples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2);
          audioBuffer = encodeWav(pcmSamples);
        }
      }

      const audioBase64 = audioBuffer.toString('base64');
      const dataUri = `data:audio/wav;base64,${audioBase64}`;

      const asrUrl = speechConfig.baseUrl.replace(/\/+$/, '') + '/chat/completions';

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      const asrResp = await fetch(asrUrl, {
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
        const errText = asrResp ? await asrResp.text().catch(() => '') : 'network error';
        return res.status(status).json({ error: `ASR request failed: ${status}`, detail: errText });
      }

      const data = await asrResp.json();
      const text = data?.choices?.[0]?.message?.content?.trim() || '';
      res.json({ text });
    } catch (error) {
      next(error);
    }
  });

  // ── Agent Model Presets ──

  app.get('/protoclaw/agent_model_presets', async (req, res, next) => {
    try {
      const agentId = req.query.agentId;
      if (!agentId || typeof agentId !== 'string') {
        return res.status(400).json({ error: 'agentId is required' });
      }
      const metaPath = path.join(PROJECT_ROOT, 'prebuilt-agents', 'official', agentId, 'metadata.json');
      const meta = await readJson(metaPath);
      if (!meta) {
        return res.status(404).json({ error: 'Agent metadata not found' });
      }

      const userConfigPath = path.join(PROJECT_ROOT, '.agentdev', 'agent-configs', `${agentId}.json`);
      const userConfig = await readJsonSafe(userConfigPath, {}) || {};

      const modelPresets = {
        ...(meta.modelPresets || {}),
        ...(userConfig.modelPresets || {})
      };

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

      const metaPath = path.join(PROJECT_ROOT, 'prebuilt-agents', 'official', agentId, 'metadata.json');
      const meta = await readJson(metaPath);
      if (!meta) {
        return res.status(404).json({ error: 'Agent metadata not found' });
      }

      const userConfigDir = path.join(PROJECT_ROOT, '.agentdev', 'agent-configs');
      await fs.mkdir(userConfigDir, { recursive: true });
      const userConfigPath = path.join(userConfigDir, `${agentId}.json`);

      const existingConfig = await readJsonSafe(userConfigPath, {}) || {};

      existingConfig.modelPresets = modelPresets;

      await fs.writeFile(userConfigPath, JSON.stringify(existingConfig, null, 2), 'utf8');

      res.json({ ok: true, agentId, modelPresets });
    } catch (error) { next(error); }
  });
}

export {
  readModelConfig,
  writeModelConfig,
  readModelPresets,
  writeModelPresetsFile,
  resolveSessionModelInfo,
};
