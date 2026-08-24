/**
 * Tests for summarizePrebuiltSession data flow and extracted pure functions.
 *
 * Covers three critical code paths that were under-tested after the P0-b
 * refactoring (commit 5c50854) that introduced the sType→sTypeFP rename bug:
 *
 * 1. extractTokenUsage — pure token usage extraction from parsed session
 * 2. extractLastMessagePreview — pure preview text extraction
 * 3. resolveSessionModelFromRecord fast-path — regression guard for the
 *    sTypeFP variable rename that caused both session list blank display
 *    and trim/handoff export failures
 * 4. summarizePrebuiltSession integration — fast / slow / catch paths via
 *    createSessionHelpers with real temp session files
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'fs';
import path from 'path';

import {
  extractTokenUsage,
  extractLastMessagePreview,
  resolveSessionModelFromRecord,
  META_VERSION,
  createSessionHelpers,
} from '../server/routes/session-helpers.js';
import { getPrebuiltSessionFilePath } from '../server/shared/session-access.js';

// ── 1. extractTokenUsage ──────────────────────────────────────────

describe('extractTokenUsage', () => {
  it('extracts all fields from a well-formed session object', () => {
    const parsed = {
      runtime: {
        usageStats: {
          totalUsage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
          lastRequestUsage: { inputTokens: 200, outputTokens: 100 },
        },
      },
    };
    const result = extractTokenUsage(parsed);
    assert.equal(result.inputTokens, 1000);
    assert.equal(result.outputTokens, 500);
    assert.equal(result.totalTokens, 1500);
    assert.deepEqual(result.lastRequestUsage, { inputTokens: 200, outputTokens: 100 });
  });

  it('returns zeros when runtime.usageStats is missing', () => {
    const result = extractTokenUsage({});
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 0);
    assert.equal(result.lastRequestUsage, null);
  });

  it('returns zeros when totalUsage is null', () => {
    const parsed = { runtime: { usageStats: { totalUsage: null } } };
    const result = extractTokenUsage(parsed);
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 0);
  });

  it('handles partial totalUsage (some fields zero/missing)', () => {
    const parsed = {
      runtime: {
        usageStats: {
          totalUsage: { inputTokens: 300 },
        },
      },
    };
    const result = extractTokenUsage(parsed);
    assert.equal(result.inputTokens, 300);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 0);
    assert.equal(result.lastRequestUsage, null);
  });

  it('passes through lastRequestUsage even when totalUsage is empty', () => {
    const lastReq = { model: 'glm-5.1', inputTokens: 50 };
    const parsed = {
      runtime: {
        usageStats: {
          lastRequestUsage: lastReq,
        },
      },
    };
    const result = extractTokenUsage(parsed);
    assert.deepEqual(result.lastRequestUsage, lastReq);
  });

  it('handles null input gracefully', () => {
    const result = extractTokenUsage(null);
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.totalTokens, 0);
    assert.equal(result.lastRequestUsage, null);
  });
});

// ── 2. extractLastMessagePreview ──────────────────────────────────

describe('extractLastMessagePreview', () => {
  it('extracts last non-system message content', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    assert.equal(extractLastMessagePreview(messages), 'Hi there');
  });

  it('skips system messages', () => {
    const messages = [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
      { role: 'system', content: 'system prompt' },
    ];
    assert.equal(extractLastMessagePreview(messages), 'Answer');
  });

  it('returns empty string for empty message array', () => {
    assert.equal(extractLastMessagePreview([]), '');
  });

  it('returns empty string when only system messages exist', () => {
    const messages = [{ role: 'system', content: 'sys' }];
    assert.equal(extractLastMessagePreview(messages), '');
  });

  it('returns empty string when messages have no string content', () => {
    const messages = [
      { role: 'user', content: null },
      { role: 'assistant', content: 42 },
    ];
    assert.equal(extractLastMessagePreview(messages), '');
  });

  it('collapses whitespace in preview', () => {
    const messages = [
      { role: 'user', content: 'line1\n\n  line2\t\tend' },
    ];
    assert.equal(extractLastMessagePreview(messages), 'line1 line2 end');
  });

  it('truncates to 140 characters', () => {
    const longText = 'A'.repeat(200);
    const messages = [{ role: 'user', content: longText }];
    const result = extractLastMessagePreview(messages);
    assert.equal(result.length, 140);
    assert.equal(result, 'A'.repeat(140));
  });

  it('handles null input gracefully', () => {
    assert.equal(extractLastMessagePreview(null), '');
  });
});

// ── 3. resolveSessionModelFromRecord fast-path regression guard ───

describe('resolveSessionModelFromRecord — fast-path regression guard', () => {
  // This test directly guards against the bug where the fast path variable
  // was renamed from sType to sTypeFP but the return object still referenced
  // the old name, causing a ReferenceError that was silently caught.
  it('correctly resolves sessionType for main sessions', () => {
    const record = { modelName: 'glm-5.1', contextLength: 200000 };
    const result = resolveSessionModelFromRecord(record, { default: { modelName: 'fallback' } }, 'main', {});
    assert.equal(result.modelName, 'glm-5.1');
    assert.equal(result.contextLength, 200000);
  });

  it('defaults to main role when sessionType is empty and no metadata hint', () => {
    const record = {};
    const map = { default: { modelName: 'default-model', contextLength: 200000 } };
    const result = resolveSessionModelFromRecord(record, map, '', {});
    assert.equal(result.modelName, 'default-model');
  });
});

// ── 4. summarizePrebuiltSession integration (fast/slow/catch) ─────

/**
 * These tests create real temp session files at the path that
 * getPrebuiltSessionFilePath computes, then exercise the three code paths
 * of summarizePrebuiltSession via createSessionHelpers.
 *
 * Uses programming-helper agentId (a workspace session agent) with a mock
 * ctx that returns empty workspace state.
 */

const TEST_AGENT_ID = 'programming-helper';
const TEST_SESSION_ID = `session-test-summary-${Date.now()}`;
const SESSION_PATH = getPrebuiltSessionFilePath(TEST_AGENT_ID, TEST_SESSION_ID);
const SESSION_DIR = path.dirname(SESSION_PATH);

function makeMockCtx() {
  return {
    readWorkspaceState: async () => ({}),
    writeWorkspaceState: async () => {},
    discoverAgents: async () => [],
    enrichAgent: async (agent) => agent,
    startManagedAgent: async () => {},
    waitForManagedRuntimeReady: async () => true,
  };
}

function makeSessionFileContent({ messages = [], usage = null, savedAt = null } = {}) {
  const obj = {
    runtime: {
      context: { messages },
    },
  };
  if (usage) {
    obj.runtime.usageStats = usage;
  }
  if (savedAt !== null) {
    obj.savedAt = savedAt;
  }
  return JSON.stringify(obj);
}

describe('summarizePrebuiltSession integration', () => {
  let helpers;

  beforeEach(() => {
    helpers = createSessionHelpers(makeMockCtx());
    mkdirSync(SESSION_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(SESSION_PATH, { force: true });
  });

  // ── Fast path: cached metadata matches file ──

  describe('fast path (cache hit)', () => {
    it('returns cached values with exists:true and correct sessionType', async () => {
      // Write a session file
      const fileContent = makeSessionFileContent({
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'world' },
        ],
        usage: {
          totalUsage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 },
          lastRequestUsage: { inputTokens: 100 },
        },
      });
      writeFileSync(SESSION_PATH, fileContent, 'utf8');
      const stat = statSync(SESSION_PATH);

      // Build a record that matches the file's mtime/size (fast path condition)
      const record = {
        id: TEST_SESSION_ID,
        title: 'Test Fast Path',
        sessionType: 'main',
        openDirectory: 'D:/code/test-project',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:10:00.000Z',
        fileMtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        metaVersion: META_VERSION,
        messageCount: 2,
        preview: 'world',
        tokenUsage: {
          inputTokens: 500,
          outputTokens: 200,
          totalTokens: 700,
          lastRequestUsage: { inputTokens: 100 },
        },
        modelName: 'glm-5.1',
        contextLength: 200000,
        compressRatio: 80,
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      // Fast path must succeed (not fall through to catch)
      assert.equal(result.exists, true);
      // sessionType must be correctly set (the sType→sTypeFP bug would have
      // caused a ReferenceError here, making exists=false)
      assert.equal(result.sessionType, 'main');
      // Cached values must be used
      assert.equal(result.messageCount, 2);
      assert.equal(result.preview, 'world');
      assert.equal(result.tokenUsage.inputTokens, 500);
      assert.equal(result.tokenUsage.outputTokens, 200);
      assert.equal(result.modelName, 'glm-5.1');
      assert.equal(result.bytes, stat.size);
    });
  });

  // ── Slow path: file changed since last read ──

  describe('slow path (file changed)', () => {
    it('reads file and extracts messages, preview, and usage', async () => {
      const messages = [
        { role: 'user', content: 'Fix the bug' },
        { role: 'assistant', content: 'I will investigate.' },
        { role: 'user', content: '  multiple\n\n  spaces  ' },
        { role: 'assistant', content: 'Done fixing.' },
      ];
      writeFileSync(SESSION_PATH, makeSessionFileContent({
        messages,
        usage: {
          totalUsage: { inputTokens: 1500, outputTokens: 800, totalTokens: 2300 },
          lastRequestUsage: { model: 'glm-5.1', inputTokens: 300 },
        },
        savedAt: 1735689600000, // 2025-01-01T00:00:00Z
      }), 'utf8');
      const stat = statSync(SESSION_PATH);

      // Record with stale mtime (won't match → slow path)
      const record = {
        id: TEST_SESSION_ID,
        title: '',
        sessionType: 'main',
        openDirectory: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        fileMtimeMs: stat.mtimeMs - 1000, // stale
        fileSize: stat.size + 100,         // stale
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      assert.equal(result.exists, true);
      assert.equal(result.messageCount, 4);
      // Preview should be the last non-system message, whitespace-normalized
      assert.equal(result.preview, 'Done fixing.');
      assert.equal(result.tokenUsage.inputTokens, 1500);
      assert.equal(result.tokenUsage.outputTokens, 800);
      assert.equal(result.tokenUsage.totalTokens, 2300);
      assert.deepEqual(result.tokenUsage.lastRequestUsage, { model: 'glm-5.1', inputTokens: 300 });
      // updatedAt from savedAt
      assert.equal(result.updatedAt, '2025-01-01T00:00:00.000Z');
    });

    it('attaches _metaWriteback as non-enumerable with correct values', async () => {
      const messages = [
        { role: 'user', content: 'test' },
        { role: 'assistant', content: 'response' },
      ];
      writeFileSync(SESSION_PATH, makeSessionFileContent({
        messages,
        usage: {
          totalUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        },
      }), 'utf8');
      const stat = statSync(SESSION_PATH);

      const record = {
        id: TEST_SESSION_ID,
        title: '',
        sessionType: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        fileMtimeMs: 0, // stale → slow path
        fileSize: 0,
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      // _metaWriteback must not be enumerable (won't appear in JSON.stringify)
      assert.equal(result.propertyIsEnumerable('_metaWriteback'), false);
      const serialized = JSON.parse(JSON.stringify(result));
      assert.equal(serialized._metaWriteback, undefined);

      // But it must be accessible and contain correct values
      const wb = result._metaWriteback;
      assert.equal(wb.fileMtimeMs, stat.mtimeMs);
      assert.equal(wb.fileSize, stat.size);
      assert.equal(wb.messageCount, 2);
      assert.equal(wb.preview, 'response');
      assert.equal(wb.tokenUsage.inputTokens, 100);
      assert.equal(wb.metaVersion, META_VERSION);
    });

    it('handles empty messages array gracefully', async () => {
      writeFileSync(SESSION_PATH, makeSessionFileContent({ messages: [] }), 'utf8');

      const record = {
        id: TEST_SESSION_ID,
        title: '',
        sessionType: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        fileMtimeMs: 0,
        fileSize: 0,
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      assert.equal(result.exists, true);
      assert.equal(result.messageCount, 0);
      assert.equal(result.preview, '');
      assert.equal(result.tokenUsage.inputTokens, 0);
    });
  });

  // ── Catch path: file missing or unreadable ──

  describe('catch path (file missing)', () => {
    it('returns exists:false when session file does not exist', async () => {
      // Don't write any file; ensure it doesn't exist
      rmSync(SESSION_PATH, { force: true });

      const record = {
        id: TEST_SESSION_ID,
        title: 'Missing Session',
        sessionType: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      assert.equal(result.exists, false);
      assert.equal(result.messageCount, 0);
      assert.equal(result.preview, '');
      assert.equal(result.tokenUsage.inputTokens, 0);
      assert.equal(result.tokenUsage.outputTokens, 0);
      assert.equal(result.modelName, '');
      assert.equal(result.bytes, 0);
    });

    it('preserves metadata fields even when file is missing', async () => {
      rmSync(SESSION_PATH, { force: true });

      const record = {
        id: TEST_SESSION_ID,
        title: 'Ghost Session',
        sessionType: 'main',
        openDirectory: 'D:/code/ghost',
        createdAt: '2026-02-01T00:00:00.000Z',
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      assert.equal(result.exists, false);
      assert.equal(result.id, TEST_SESSION_ID);
      assert.equal(result.title, 'Ghost Session');
      assert.equal(result.sessionType, 'main');
      assert.equal(result.openDirectory, 'D:/code/ghost');
    });

    it('returns exists:false when session file is corrupt JSON', async () => {
      writeFileSync(SESSION_PATH, '{ invalid json !!!', 'utf8');

      const record = {
        id: TEST_SESSION_ID,
        title: '',
        sessionType: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        fileMtimeMs: 0, // force slow path → will hit JSON.parse error
        fileSize: 0,
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      assert.equal(result.exists, false);
    });
  });

  // ── Fast path condition boundary ──

  describe('fast path condition boundaries', () => {
    it('falls through to slow path when metaVersion differs', async () => {
      writeFileSync(SESSION_PATH, makeSessionFileContent({
        messages: [{ role: 'user', content: 'hi' }],
      }), 'utf8');
      const stat = statSync(SESSION_PATH);

      const record = {
        id: TEST_SESSION_ID,
        title: '',
        sessionType: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        fileMtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        metaVersion: META_VERSION + 999, // different version → slow path
        messageCount: 0,
        preview: '',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      // Slow path should read from file and get correct message count
      assert.equal(result.exists, true);
      assert.equal(result.messageCount, 1);
    });

    it('falls through to slow path when messageCount is not a number', async () => {
      writeFileSync(SESSION_PATH, makeSessionFileContent({
        messages: [{ role: 'user', content: 'hi' }],
      }), 'utf8');
      const stat = statSync(SESSION_PATH);

      const record = {
        id: TEST_SESSION_ID,
        title: '',
        sessionType: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        fileMtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        metaVersion: META_VERSION,
        // messageCount missing → not a number → slow path
        preview: '',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      assert.equal(result.exists, true);
      assert.equal(result.messageCount, 1); // from file, not cache
    });

    it('falls through to slow path when tokenUsage is missing', async () => {
      writeFileSync(SESSION_PATH, makeSessionFileContent({
        messages: [{ role: 'user', content: 'hi' }],
      }), 'utf8');
      const stat = statSync(SESSION_PATH);

      const record = {
        id: TEST_SESSION_ID,
        title: '',
        sessionType: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        fileMtimeMs: stat.mtimeMs,
        fileSize: stat.size,
        metaVersion: META_VERSION,
        messageCount: 1,
        preview: 'hi',
        // tokenUsage missing → slow path
      };

      const result = await helpers.summarizePrebuiltSession(TEST_AGENT_ID, record);

      assert.equal(result.exists, true);
      assert.equal(result.messageCount, 1); // from file
    });
  });
});
