/**
 * Tests for speech model config & ASR proxy logic.
 *
 * Covers:
 * 1. normalizeSpeechModel — defaults, partial/full/empty/invalid input
 * 2. convertAudioToWav — ffmpeg pipe conversion (skip if ffmpeg unavailable)
 * 3. Config persistence — write/read round-trip via temp config file
 *
 * When server.js speech model logic changes, update the inline copies here.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

// ── Inline helpers (mirrors server.js) ──

function cleanSessionText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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

/**
 * Encode raw PCM samples as a WAV buffer (16kHz, 16-bit, mono).
 * Pure JS — mirrors server.js encodeWav ported from MiMo-Code voice.ts.
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
 * Generate a minimal valid WAV file buffer with silence.
 * Used for testing convertAudioToWav without depending on external audio files.
 */
function generateSilentWav(durationSec = 1, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const numSamples = sampleRate * durationSec;
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28); // byte rate
  buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32); // block align
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  // rest is zeros = silence

  return buffer;
}

// ── Helper: check ffmpeg availability ──

function isFfmpegAvailable() {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// ── Tests ──

describe('Speech Model Config', () => {

  describe('normalizeSpeechModel', () => {

    it('returns defaults for null input', () => {
      const result = normalizeSpeechModel(null);
      assert.deepStrictEqual(result, { ...DEFAULT_SPEECH_MODEL });
    });

    it('returns defaults for undefined input', () => {
      const result = normalizeSpeechModel(undefined);
      assert.deepStrictEqual(result, { ...DEFAULT_SPEECH_MODEL });
    });

    it('returns defaults for non-object input', () => {
      const result = normalizeSpeechModel('hello');
      assert.deepStrictEqual(result, { ...DEFAULT_SPEECH_MODEL });
    });

    it('returns defaults for number input', () => {
      const result = normalizeSpeechModel(42);
      assert.deepStrictEqual(result, { ...DEFAULT_SPEECH_MODEL });
    });

    it('returns defaults for empty object', () => {
      const result = normalizeSpeechModel({});
      assert.equal(result.baseUrl, '');
      assert.equal(result.apiKey, '');
      assert.equal(result.model, DEFAULT_SPEECH_MODEL.model);
      assert.equal(result.language, DEFAULT_SPEECH_MODEL.language);
    });

    it('preserves valid full input', () => {
      const input = {
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'sk-test-key-123',
        model: 'mimo-v2.5-asr',
        language: 'zh',
      };
      const result = normalizeSpeechModel(input);
      assert.equal(result.baseUrl, input.baseUrl);
      assert.equal(result.apiKey, input.apiKey);
      assert.equal(result.model, input.model);
      assert.equal(result.language, input.language);
    });

    it('trims whitespace from all fields', () => {
      const input = {
        baseUrl: '  https://api.example.com/v1  ',
        apiKey: '  sk-key  ',
        model: '  my-model  ',
        language: '  en  ',
      };
      const result = normalizeSpeechModel(input);
      assert.equal(result.baseUrl, 'https://api.example.com/v1');
      assert.equal(result.apiKey, 'sk-key');
      assert.equal(result.model, 'my-model');
      assert.equal(result.language, 'en');
    });

    it('fills default model when model is empty string', () => {
      const result = normalizeSpeechModel({ baseUrl: 'https://example.com', apiKey: 'key' });
      assert.equal(result.model, DEFAULT_SPEECH_MODEL.model);
    });

    it('fills default language when language is empty string', () => {
      const result = normalizeSpeechModel({ baseUrl: 'https://example.com', apiKey: 'key' });
      assert.equal(result.language, DEFAULT_SPEECH_MODEL.language);
    });

    it('ignores non-string fields gracefully', () => {
      const input = {
        baseUrl: 123,
        apiKey: null,
        model: undefined,
        language: true,
      };
      const result = normalizeSpeechModel(input);
      assert.equal(result.baseUrl, '');
      assert.equal(result.apiKey, '');
      assert.equal(result.model, DEFAULT_SPEECH_MODEL.model);
      assert.equal(result.language, DEFAULT_SPEECH_MODEL.language);
    });

    it('returns a new object (no reference sharing)', () => {
      const result1 = normalizeSpeechModel(null);
      const result2 = normalizeSpeechModel(null);
      result1.baseUrl = 'changed';
      assert.equal(result2.baseUrl, '');
    });
  });

  describe('Config persistence round-trip', () => {
    let tempDir;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), 'speech-test-'));
    });

    afterEach(() => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    });

    function readJson(filePath) {
      const raw = readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }

    function writeJson(filePath, data) {
      const dir = filePath.replace(/[/\\][^/\\]+$/, '');
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }

    it('writes and reads speech model config back correctly', async () => {
      const configPath = join(tempDir, 'config', 'default.json');

      // Write initial config with speechModel
      const speechModel = {
        baseUrl: 'https://api.xiaomimimo.com/v1',
        apiKey: 'sk-test-key',
        model: 'mimo-v2.5-asr',
        language: 'zh',
      };
      writeJson(configPath, { defaultModel: {}, speechModel });

      // Read back
      const config = readJson(configPath);
      const result = normalizeSpeechModel(config.speechModel);

      assert.equal(result.baseUrl, speechModel.baseUrl);
      assert.equal(result.apiKey, speechModel.apiKey);
      assert.equal(result.model, speechModel.model);
      assert.equal(result.language, speechModel.language);
    });

    it('returns defaults when speechModel key is missing', async () => {
      const configPath = join(tempDir, 'config', 'default.json');
      writeJson(configPath, { defaultModel: {} });

      const config = readJson(configPath);
      const result = normalizeSpeechModel(config.speechModel);

      assert.deepStrictEqual(result, { ...DEFAULT_SPEECH_MODEL });
    });

    it('returns defaults when config file does not exist', async () => {
      const configPath = join(tempDir, 'config', 'nonexistent.json');
      let config;
      try {
        config = readJson(configPath);
      } catch {
        config = null;
      }
      const result = normalizeSpeechModel(config?.speechModel);
      assert.deepStrictEqual(result, { ...DEFAULT_SPEECH_MODEL });
    });

    it('overwrites speech model config while preserving other fields', async () => {
      const configPath = join(tempDir, 'config', 'default.json');
      const original = {
        defaultModel: { model: 'glm-5', provider: 'openai' },
        agent: { temperature: 0.7 },
        speechModel: { baseUrl: 'https://old.com', apiKey: 'old-key', model: 'old-model', language: 'en' },
      };
      writeJson(configPath, original);

      // Simulate writeSpeechModelConfig: read → merge → write
      const config = readJson(configPath);
      config.speechModel = normalizeSpeechModel({
        baseUrl: 'https://new.com',
        apiKey: 'new-key',
        model: 'mimo-v2.5-asr',
        language: 'auto',
      });
      writeJson(configPath, config);

      // Read back and verify
      const updated = readJson(configPath);
      assert.equal(updated.defaultModel.model, 'glm-5');       // preserved
      assert.equal(updated.agent.temperature, 0.7);              // preserved
      assert.equal(updated.speechModel.baseUrl, 'https://new.com');
      assert.equal(updated.speechModel.apiKey, 'new-key');
      assert.equal(updated.speechModel.model, 'mimo-v2.5-asr');
      assert.equal(updated.speechModel.language, 'auto');
    });
  });
});

describe('Audio Conversion', () => {

  let ffmpegAvailable;

  beforeEach(async () => {
    ffmpegAvailable = await isFfmpegAvailable();
  });

  it('converts a valid WAV input and outputs WAV with correct header', { skip: !ffmpegAvailable }, async () => {
    // ffmpeg can re-encode a WAV to the target format (16kHz mono)
    const inputWav = generateSilentWav(0.5, 44100); // 44.1kHz source
    const output = await convertAudioToWav(inputWav);

    // Verify WAV header
    assert.equal(output.toString('ascii', 0, 4), 'RIFF');
    assert.equal(output.toString('ascii', 8, 12), 'WAVE');

    // Verify fmt chunk: should be 16kHz mono 16-bit PCM
    assert.equal(output.readUInt16LE(20), 1);    // PCM format
    assert.equal(output.readUInt16LE(22), 1);    // 1 channel (mono)
    assert.equal(output.readUInt32LE(24), 16000); // 16kHz sample rate
    assert.equal(output.readUInt16LE(34), 16);    // 16 bits per sample
  });

  it('produces non-empty output for non-trivial input', { skip: !ffmpegAvailable }, async () => {
    const inputWav = generateSilentWav(1, 16000);
    const output = await convertAudioToWav(inputWav);
    assert.ok(output.length > 44, 'output should contain more than just WAV header');
  });

  it('returns null when ffmpeg is given garbage input', { skip: !ffmpegAvailable }, async () => {
    const garbage = Buffer.from('this is not audio data at all');
    const result = await convertAudioToWav(garbage);
    assert.equal(result, null);
  });

  it('returns null when ffmpeg is given empty input', { skip: !ffmpegAvailable }, async () => {
    const empty = Buffer.alloc(0);
    const result = await convertAudioToWav(empty);
    assert.equal(result, null);
  });
});

describe('encodeWav (pure JS)', () => {

  it('produces valid WAV header', () => {
    const samples = new Int16Array(16000); // 1 second of silence
    const wav = encodeWav(samples);

    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
    assert.equal(wav.toString('ascii', 36, 40), 'data');
  });

  it('has correct fmt chunk values for 16kHz mono 16-bit', () => {
    const samples = new Int16Array(16000);
    const wav = encodeWav(samples);

    assert.equal(wav.readUInt32LE(16), 16);    // fmt chunk size
    assert.equal(wav.readUInt16LE(20), 1);     // PCM format
    assert.equal(wav.readUInt16LE(22), 1);     // mono
    assert.equal(wav.readUInt32LE(24), 16000); // sample rate
    assert.equal(wav.readUInt32LE(28), 32000); // byte rate (16000 * 2)
    assert.equal(wav.readUInt16LE(32), 2);     // block align
    assert.equal(wav.readUInt16LE(34), 16);    // bits per sample
  });

  it('total buffer size = 44 + samples.length * 2', () => {
    const samples = new Int16Array(8000);
    const wav = encodeWav(samples);
    assert.equal(wav.length, 44 + 8000 * 2);
    assert.equal(wav.readUInt32LE(4), 36 + 8000 * 2); // RIFF size
    assert.equal(wav.readUInt32LE(40), 8000 * 2);      // data size
  });

  it('preserves sample data in the output', () => {
    const samples = new Int16Array([1000, -2000, 30000, -30000, 0]);
    const wav = encodeWav(samples);

    for (let i = 0; i < samples.length; i++) {
      assert.equal(wav.readInt16LE(44 + i * 2), samples[i]);
    }
  });

  it('works with Buffer input (raw PCM bytes)', () => {
    const raw = Buffer.alloc(100); // 50 PCM16 samples of silence
    const wav = encodeWav(raw);
    assert.equal(wav.length, 44 + 100);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  });

  it('works with empty samples (produces header-only WAV)', () => {
    const samples = new Int16Array(0);
    const wav = encodeWav(samples);
    assert.equal(wav.length, 44);
    assert.equal(wav.readUInt32LE(4), 36);
    assert.equal(wav.readUInt32LE(40), 0);
  });
});
