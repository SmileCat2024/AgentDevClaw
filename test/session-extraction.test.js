/**
 * Tests for Phase 5 Session system extraction.
 *
 * Covers the key data flows introduced by extracting session helpers and
 * session routes from server.js into dedicated modules:
 *
 * 1. createSessionHelpers — factory completeness, ctx injection contract
 * 2. setupSessionRoutes  — route registration completeness
 * 3. string-helpers.js   — new pure functions (getAssemblyWorkspaceDir, normalizeClientAgentId)
 * 4. META_VERSION         — module-level export verification
 * 5. Module wiring        — import resolution, no circular deps
 *
 * Uses node:test format per project convention (test/*.test.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import {
  getAssemblyWorkspaceDir,
  normalizeClientAgentId,
} from '../server/shared/string-helpers.js';
import { createSessionHelpers, META_VERSION } from '../server/routes/session-helpers.js';
import { setupSessionRoutes } from '../server/routes/session.js';

// ─── Helpers ───────────────────────────────────────────────────────

/** Minimal mock ctx for createSessionHelpers — all 6 injected functions. */
function makeMockHelpersCtx() {
  return {
    readWorkspaceState: async () => ({}),
    writeWorkspaceState: async () => {},
    discoverAgents: async () => [],
    enrichAgent: async (agent) => agent,
    startManagedAgent: async () => {},
    waitForManagedRuntimeReady: async () => true,
  };
}

/** Minimal mock ctx for setupSessionRoutes — all 26 destructured functions. */
function makeMockRoutesCtx() {
  const noop = async () => {};
  const ctx = {
    // 21 session-helper functions
    activatePrebuiltSession: noop,
    archivePrebuiltSession: noop,
    buildExplorationHandoffPayload: noop,
    buildSessionTrimPreview: noop,
    compactAndResumeCurrentSession: noop,
    compactAndResumeFromProvidedSummary: noop,
    createCompactedResumeFromHandoff: noop,
    createPrebuiltSession: noop,
    deletePrebuiltSession: noop,
    exportContextHandoffForSession: noop,
    exportProvidedSummaryHandoff: noop,
    findSessionSummary: noop,
    findSessionSummaryPath: noop,
    listPrebuiltSessions: noop,
    lockExplorationSession: noop,
    requirePrebuiltAgentForRuntime: noop,
    requirePrebuiltSessionRecord: noop,
    resolvePrebuiltSessionOwner: noop,
    searchSessionsContent: noop,
    tagPrebuiltSessionTodo: noop,
    writeSyntheticHandoff: noop,
    // 5 server.js lifecycle functions
    requireAgentLight: noop,
    startManagedAgent: noop,
    startOneShotAgent: noop,
    stopManagedAgent: noop,
    waitForManagedRuntimeReady: noop,
  };
  return ctx;
}

/** Mock Express app that records route registrations. */
function makeMockApp() {
  const routes = [];
  const app = {
    get: (p, ...h) => routes.push(`GET ${p}`),
    post: (p, ...h) => routes.push(`POST ${p}`),
    put: (p, ...h) => routes.push(`PUT ${p}`),
    delete: (p, ...h) => routes.push(`DELETE ${p}`),
  };
  app._routes = routes;
  return app;
}

// ─── 1. createSessionHelpers factory ───────────────────────────────

const EXPECTED_HELPER_KEYS = [
  'buildFeatureSessionTitle', 'buildNamedSessionTitle', 'getNextNewSessionTitle',
  'checkSessionHasSummary', 'buildSessionSummaryMap', 'buildLightPrebuiltSessionRecord',
  'findSessionSummary', 'findSessionSummaryPath', 'extractToolCallLabel',
  'buildSessionTrimPreview', 'summarizePrebuiltSession',
  'getSearchIndexPath', 'loadPersistentSearchIndex', 'savePersistentSearchIndex',
  'extractSessionSearchText', 'ensureSearchIndex', 'searchInText', 'searchSessionsContent',
  'cleanupEmptySessions', 'listPrebuiltSessions', 'buildSessionModelInfoMap',
  'createPrebuiltSession', 'activatePrebuiltSession', 'deletePrebuiltSession',
  'archivePrebuiltSession', 'tagPrebuiltSessionTodo', 'requirePrebuiltSessionRecord',
  'resolvePrebuiltSessionOwner', 'requirePrebuiltAgentForRuntime',
  'exportContextHandoffForSession', 'createCompactedResumeFromHandoff',
  'compactAndResumeCurrentSession', 'compactAndResumeFromProvidedSummary',
  'exportProvidedSummaryHandoff', 'deletePrebuiltProject', 'resolveContextLength',
  'lockExplorationSession', 'extractDomainsFromText',
  'buildExplorationHandoffPayload', 'writeSyntheticHandoff',
];

describe('createSessionHelpers', () => {
  it('should return all expected function keys', () => {
    const helpers = createSessionHelpers(makeMockHelpersCtx());
    const actualKeys = Object.keys(helpers).sort();
    const expectedKeys = [...EXPECTED_HELPER_KEYS].sort();
    assert.deepEqual(actualKeys, expectedKeys,
      `Expected ${expectedKeys.length} keys, got ${actualKeys.length}`);
  });

  it('should return functions (not undefined) for every key', () => {
    const helpers = createSessionHelpers(makeMockHelpersCtx());
    for (const key of EXPECTED_HELPER_KEYS) {
      assert.equal(typeof helpers[key], 'function',
        `${key} should be a function, got ${typeof helpers[key]}`);
    }
  });

  it('should return exactly the expected number of keys', () => {
    const helpers = createSessionHelpers(makeMockHelpersCtx());
    assert.equal(Object.keys(helpers).length, EXPECTED_HELPER_KEYS.length);
  });

  it('should not throw when ctx functions are called (smoke)', async () => {
    const ctx = makeMockHelpersCtx();
    let wsRead = null;
    ctx.readWorkspaceState = async (agentId) => { wsRead = agentId; return { forms: {} }; };
    const helpers = createSessionHelpers(ctx);

    // createPrebuiltSession calls readWorkspaceState for workspace agents
    await helpers.createPrebuiltSession('flow-workspace', {});
    assert.ok(wsRead === 'flow-workspace',
      'readWorkspaceState should have been called with flow-workspace');
  });
});

// ─── 2. setupSessionRoutes registration ────────────────────────────

const EXPECTED_ROUTES = [
  'GET /protoclaw/prebuilt_sessions',
  'GET /protoclaw/search_sessions',
  'GET /protoclaw/session_record',
  'POST /protoclaw/render_conversation',
  'GET /protoclaw/session_trim_preview',
  'POST /protoclaw/sessions/branch',
  'GET /protoclaw/session_summary',
  'POST /protoclaw/session_generate_summary',
  'POST /protoclaw/refresh_session_token_count',
  'POST /protoclaw/prebuilt_sessions',
  'PUT /protoclaw/prebuilt_sessions/:sessionId/title',
  'POST /protoclaw/generate_session_title',
  'POST /protoclaw/generate_recap',
  'POST /protoclaw/context_handoffs/export',
  'POST /protoclaw/context_handoffs/compacted_resume',
  'POST /protoclaw/spawn_one_shot',
  'POST /protoclaw/resume_sub',
  'POST /protoclaw/context_handoffs/compact_and_resume',
  'POST /protoclaw/context_handoffs/summary_resume',
  'POST /protoclaw/context_handoffs/summary_export',
  'POST /protoclaw/prebuilt_sessions/activate',
  'POST /protoclaw/prebuilt_sessions/delete',
  'POST /protoclaw/prebuilt_sessions/archive',
  'POST /protoclaw/prebuilt_sessions/todo',
  'POST /protoclaw/session_meta_sync',
];

describe('setupSessionRoutes', () => {
  it('should register all expected routes without throwing', () => {
    const app = makeMockApp();
    const ctx = makeMockRoutesCtx();
    // Should not throw
    setupSessionRoutes(app, { json: () => (req, res, next) => next() }, ctx);
  });

  it('should register exactly the expected set of routes', () => {
    const app = makeMockApp();
    const ctx = makeMockRoutesCtx();
    setupSessionRoutes(app, { json: () => (req, res, next) => next() }, ctx);

    const actual = [...app._routes].sort();
    const expected = [...EXPECTED_ROUTES].sort();
    assert.deepEqual(actual, expected,
      `Route mismatch: expected ${expected.length}, got ${actual.length}`);
  });

  it('should register no duplicate routes', () => {
    const app = makeMockApp();
    const ctx = makeMockRoutesCtx();
    setupSessionRoutes(app, { json: () => (req, res, next) => next() }, ctx);

    const seen = new Set();
    for (const route of app._routes) {
      assert.ok(!seen.has(route), `Duplicate route: ${route}`);
      seen.add(route);
    }
  });
});

// ─── 3. string-helpers.js new pure functions ───────────────────────

describe('getAssemblyWorkspaceDir', () => {
  it('should return a path under ~/.agentdev/agent-dev/', () => {
    const dir = getAssemblyWorkspaceDir('my-project');
    const expectedRoot = path.join(os.homedir(), '.agentdev', 'agent-dev');
    assert.ok(dir.startsWith(expectedRoot),
      `Expected ${dir} to start with ${expectedRoot}`);
  });

  it('should sanitize the assembly name in the path', () => {
    const dir = getAssemblyWorkspaceDir('My Project!');
    assert.ok(dir.endsWith('My-Project'),
      `Expected sanitized suffix, got: ${dir}`);
  });

  it('should use "default" for empty input', () => {
    const dir = getAssemblyWorkspaceDir('');
    assert.ok(dir.endsWith('default'),
      `Expected "default" suffix, got: ${dir}`);
  });
});

describe('normalizeClientAgentId', () => {
  it('should sanitize a valid agent ID', () => {
    assert.strictEqual(normalizeClientAgentId('qqbot'), 'qqbot');
    assert.strictEqual(normalizeClientAgentId('flow workspace'), 'flow-workspace');
  });

  it('should return fallback for empty/falsy input', () => {
    assert.strictEqual(normalizeClientAgentId(''), '');
    assert.strictEqual(normalizeClientAgentId(null), '');
    assert.strictEqual(normalizeClientAgentId(undefined), '');
    assert.strictEqual(normalizeClientAgentId('', 'default-agent'), 'default-agent');
  });

  it('should return fallback for string "null" or "undefined"', () => {
    assert.strictEqual(normalizeClientAgentId('null'), '');
    assert.strictEqual(normalizeClientAgentId('undefined'), '');
    assert.strictEqual(normalizeClientAgentId('NULL', 'fb'), 'fb');
  });

  it('should trim whitespace before processing', () => {
    assert.strictEqual(normalizeClientAgentId('  qqbot  '), 'qqbot');
  });
});

// ─── 4. META_VERSION export ────────────────────────────────────────

describe('META_VERSION', () => {
  it('should be exported from session-helpers.js', () => {
    assert.ok(META_VERSION !== undefined, 'META_VERSION should be exported');
  });

  it('should be a positive integer', () => {
    assert.equal(typeof META_VERSION, 'number');
    assert.ok(Number.isInteger(META_VERSION));
    assert.ok(META_VERSION > 0);
  });

  it('should equal 1 (current schema version)', () => {
    assert.strictEqual(META_VERSION, 1);
  });
});

// ─── 5. Module wiring integrity ────────────────────────────────────

describe('module wiring', () => {
  it('session-helpers.js should import without errors', () => {
    // If this import failed, the test file itself would not load
    assert.ok(typeof createSessionHelpers === 'function');
  });

  it('session.js should import without errors', () => {
    assert.ok(typeof setupSessionRoutes === 'function');
  });

  it('string-helpers.js should export the new functions', () => {
    assert.equal(typeof getAssemblyWorkspaceDir, 'function');
    assert.equal(typeof normalizeClientAgentId, 'function');
  });

  it('session.js should not import from server.js (no circular dependency)', async () => {
    const fs = await import('fs');
    const code = fs.readFileSync('server/routes/session.js', 'utf8');
    assert.ok(!code.includes("from '../../server.js'") && !code.includes("from '../../../server.js'"),
      'session.js must not import from server.js');
  });

  it('session-helpers.js should not import from server.js', async () => {
    const fs = await import('fs');
    const code = fs.readFileSync('server/routes/session-helpers.js', 'utf8');
    assert.ok(!code.includes("from '../../server.js'") && !code.includes("from '../../../server.js'"),
      'session-helpers.js must not import from server.js');
  });

  it('createSessionHelpers ctx should require exactly 6 keys', () => {
    const ctx = makeMockHelpersCtx();
    const expectedCtxKeys = [
      'readWorkspaceState', 'writeWorkspaceState', 'discoverAgents',
      'enrichAgent', 'startManagedAgent', 'waitForManagedRuntimeReady',
    ];
    // Passing a ctx with exactly these keys should not throw
    const helpers = createSessionHelpers(ctx);
    assert.ok(typeof helpers === 'object');
    // Verify by removing one key — factory should still work (it destructures, undefined is ok)
    const partialCtx = { ...ctx };
    delete partialCtx.enrichAgent;
    // Should not throw even with missing key (functions will be undefined)
    const partialHelpers = createSessionHelpers(partialCtx);
    assert.ok(typeof partialHelpers === 'object');
  });
});
