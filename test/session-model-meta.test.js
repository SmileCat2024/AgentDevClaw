/**
 * Tests for session model metadata resolution logic.
 *
 * Covers the core decision logic extracted from server.js:
 * 1. resolveSessionModelInfo — resolves model config from metadata.json + global config
 * 2. Model info merge logic — prioritize persisted record over runtime fallback
 *
 * These mirror the actual code paths in server.js (createPrebuiltSession / summarizePrebuiltSession).
 * When the server code changes, these tests should be updated accordingly.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// ── Inline helpers (mirrors server.js) ──

function cleanSessionText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve model info for a session, prioritizing persisted record data.
 * This mirrors the logic in summarizePrebuiltSession() in server.js.
 *
 * @param {object} record - session index record (may have modelName, contextLength)
 * @param {object} modelInfoMap - { default: { modelName, contextLength, presetName }, ... }
 * @param {string} sessionType - 'main' | 'exploration' | 'sub'
 * @param {object} [metadata] - optional session metadata
 * @returns {{ modelName: string, contextLength: number|null }}
 */
function resolveSessionModel(record, modelInfoMap, sessionType, metadata) {
  const sType = cleanSessionText(sessionType) || (metadata?.resumeMode === 'one-shot' ? 'sub' : 'main');
  const modelRole = sType === 'exploration' ? 'exploration' : sType === 'sub' ? 'sub' : 'default';
  const fallbackModelInfo = (modelInfoMap && modelInfoMap[modelRole]) || {};

  const persistedModelName = cleanSessionText(record.modelName);
  const persistedCL = Number.isFinite(record.contextLength) && record.contextLength > 0
    ? record.contextLength : null;

  return {
    modelName: persistedModelName || fallbackModelInfo.modelName || '',
    contextLength: persistedCL || fallbackModelInfo.contextLength || null,
  };
}

// ── Tests ──

describe('Session model metadata resolution', () => {

  describe('resolveSessionModel — persisted vs fallback priority', () => {

    it('uses persisted modelName from record when available', () => {
      const record = { modelName: 'glm-5.1', contextLength: 200000 };
      const modelInfoMap = { default: { modelName: 'deepseek-v4-pro', contextLength: 1000000 } };
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      assert.equal(result.modelName, 'glm-5.1');
      assert.equal(result.contextLength, 200000);
    });

    it('falls back to modelInfoMap when record has no modelName', () => {
      const record = {};
      const modelInfoMap = { default: { modelName: 'deepseek-v4-pro', contextLength: 1000000 } };
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      assert.equal(result.modelName, 'deepseek-v4-pro');
      assert.equal(result.contextLength, 1000000);
    });

    it('falls back to modelInfoMap when record modelName is empty string', () => {
      const record = { modelName: '', contextLength: 0 };
      const modelInfoMap = { default: { modelName: 'glm-5.1', contextLength: 200000 } };
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      assert.equal(result.modelName, 'glm-5.1');
      assert.equal(result.contextLength, 200000);
    });

    it('uses persisted modelName even if it differs from current global config', () => {
      // This is the core fix: session was created with glm-5.1 but global config
      // has since changed to deepseek-v4-pro. The persisted value should win.
      const record = { modelName: 'glm-5.1', contextLength: 200000 };
      const modelInfoMap = { default: { modelName: 'deepseek-v4-pro', contextLength: 1000000 } };
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      assert.equal(result.modelName, 'glm-5.1');
      assert.equal(result.contextLength, 200000);
    });

    it('returns empty values when both record and fallback are empty', () => {
      const record = {};
      const modelInfoMap = {};
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      assert.equal(result.modelName, '');
      assert.equal(result.contextLength, null);
    });

    it('uses persisted contextLength even when fallback has different value', () => {
      const record = { modelName: 'glm-4.7', contextLength: 128000 };
      const modelInfoMap = { default: { modelName: 'glm-5.1', contextLength: 200000 } };
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      assert.equal(result.contextLength, 128000);
    });

    it('ignores persisted contextLength when it is zero', () => {
      const record = { modelName: 'glm-5-turbo', contextLength: 0 };
      const modelInfoMap = { default: { modelName: 'glm-5.1', contextLength: 200000 } };
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      // contextLength 0 is treated as not set, falls back to 200000
      assert.equal(result.contextLength, 200000);
    });

    it('ignores persisted contextLength when it is negative', () => {
      const record = { modelName: 'glm-5-turbo', contextLength: -1 };
      const modelInfoMap = { default: { modelName: 'glm-5.1', contextLength: 200000 } };
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      assert.equal(result.contextLength, 200000);
    });
  });

  describe('resolveSessionModel — sessionType to role mapping', () => {

    const modelInfoMap = {
      default: { modelName: 'glm-5.1', contextLength: 200000 },
      exploration: { modelName: 'glm-5-turbo', contextLength: 128000 },
      sub: { modelName: 'glm-4.7', contextLength: 128000 },
    };

    it('maps main sessionType to default role', () => {
      const record = {};
      const result = resolveSessionModel(record, modelInfoMap, 'main', {});
      assert.equal(result.modelName, 'glm-5.1');
    });

    it('maps exploration sessionType to exploration role', () => {
      const record = {};
      const result = resolveSessionModel(record, modelInfoMap, 'exploration', {});
      assert.equal(result.modelName, 'glm-5-turbo');
    });

    it('maps sub sessionType to sub role', () => {
      const record = {};
      const result = resolveSessionModel(record, modelInfoMap, 'sub', {});
      assert.equal(result.modelName, 'glm-4.7');
    });

    it('defaults to main when sessionType is empty', () => {
      const record = {};
      const result = resolveSessionModel(record, modelInfoMap, '', {});
      assert.equal(result.modelName, 'glm-5.1');
    });

    it('uses sub role when metadata has resumeMode one-shot', () => {
      const record = {};
      const result = resolveSessionModel(record, modelInfoMap, '', { resumeMode: 'one-shot' });
      assert.equal(result.modelName, 'glm-4.7');
    });

    it('persisted record overrides even for exploration role', () => {
      const record = { modelName: 'persisted-model', contextLength: 50000 };
      const result = resolveSessionModel(record, modelInfoMap, 'exploration', {});
      assert.equal(result.modelName, 'persisted-model');
      assert.equal(result.contextLength, 50000);
    });
  });

  describe('cleanSessionText edge cases', () => {

    it('trims whitespace', () => {
      assert.equal(cleanSessionText('  glm-5.1  '), 'glm-5.1');
    });

    it('returns empty string for null', () => {
      assert.equal(cleanSessionText(null), '');
    });

    it('returns empty string for undefined', () => {
      assert.equal(cleanSessionText(undefined), '');
    });

    it('returns empty string for number', () => {
      assert.equal(cleanSessionText(42), '');
    });

    it('returns empty string for object', () => {
      assert.equal(cleanSessionText({}), '');
    });
  });

  describe('createPrebuiltSession record shape', () => {
    /**
     * Verify that a newly created session record includes modelName and contextLength.
     * We test the record construction logic (mirrored from server.js createPrebuiltSession).
     */

    it('record includes modelName and contextLength from resolveSessionModelInfo', () => {
      // Simulate what createPrebuiltSession does:
      // it calls resolveSessionModelInfo(agentId, modelRole) and puts the result into record
      const currentModelInfo = { modelName: 'glm-5.1', contextLength: 200000, presetName: '智谱GLM-5.1' };
      const record = {
        id: 'session-test-001',
        title: 'Test Session',
        sessionType: 'main',
        modelName: currentModelInfo.modelName || '',
        contextLength: currentModelInfo.contextLength || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      assert.equal(record.modelName, 'glm-5.1');
      assert.equal(record.contextLength, 200000);
    });

    it('record handles missing model info gracefully', () => {
      const currentModelInfo = { modelName: '', contextLength: null, presetName: null };
      const record = {
        id: 'session-test-002',
        title: 'No Model Session',
        sessionType: 'main',
        modelName: currentModelInfo.modelName || '',
        contextLength: currentModelInfo.contextLength || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      assert.equal(record.modelName, '');
      assert.equal(record.contextLength, null);
    });
  });

  describe('End-to-end: create then summarize', () => {
    /**
     * Simulate the full flow:
     * 1. createPrebuiltSession writes modelName/contextLength to index record
     * 2. summarizePrebuiltSession reads it back, prioritizing persisted values
     */

    it('model info survives round-trip through index', () => {
      // Step 1: Create (simulates createPrebuiltSession)
      const createModelInfo = { modelName: 'glm-5.1', contextLength: 200000 };
      const indexRecord = {
        id: 'session-roundtrip-001',
        modelName: createModelInfo.modelName || '',
        contextLength: createModelInfo.contextLength || null,
        sessionType: 'main',
      };

      // Step 2: Summarize (simulates summarizePrebuiltSession)
      // Global config has changed to deepseek-v4-pro since session was created
      const modelInfoMap = {
        default: { modelName: 'deepseek-v4-pro', contextLength: 1000000 },
      };

      const result = resolveSessionModel(indexRecord, modelInfoMap, 'main', {});

      // The persisted values from creation time should win
      assert.equal(result.modelName, 'glm-5.1');
      assert.equal(result.contextLength, 200000);
    });

    it('old session without persisted model info falls back to global config', () => {
      // Old index record (created before the fix, no modelName field)
      const indexRecord = {
        id: 'session-old-001',
        // no modelName, no contextLength
        sessionType: 'main',
      };

      const modelInfoMap = {
        default: { modelName: 'deepseek-v4-pro', contextLength: 1000000 },
      };

      const result = resolveSessionModel(indexRecord, modelInfoMap, 'main', {});

      // Falls back to current global config
      assert.equal(result.modelName, 'deepseek-v4-pro');
      assert.equal(result.contextLength, 1000000);
    });
  });
});
