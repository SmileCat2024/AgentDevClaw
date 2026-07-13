/**
 * Tests for server/routes/workspace-artifacts.js — artifact helper pure functions
 *
 * Covers:
 * 1. cleanWorkspaceArtifactPayload
 * 2. normalizeWorkspaceArtifact
 * 3. buildFeatureCreatorDraftArtifact
 * 4. buildAgentCreatorDraftArtifact
 * 5. buildProgrammingHelperDraftArtifact
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanWorkspaceArtifactPayload,
  normalizeWorkspaceArtifact,
  buildFeatureCreatorDraftArtifact,
  buildAgentCreatorDraftArtifact,
  buildProgrammingHelperDraftArtifact,
} from '../server/routes/workspace-artifacts.js';

// ── cleanWorkspaceArtifactPayload ────────────────────────────────────────────

describe('cleanWorkspaceArtifactPayload', () => {
  it('returns empty object for null/undefined/non-object input', () => {
    assert.deepStrictEqual(cleanWorkspaceArtifactPayload(null), {});
    assert.deepStrictEqual(cleanWorkspaceArtifactPayload(undefined), {});
    assert.deepStrictEqual(cleanWorkspaceArtifactPayload('string'), {});
    assert.deepStrictEqual(cleanWorkspaceArtifactPayload(42), {});
  });

  it('returns empty object for empty object input', () => {
    assert.deepStrictEqual(cleanWorkspaceArtifactPayload({}), {});
  });

  it('trims string values', () => {
    const result = cleanWorkspaceArtifactPayload({ key: '  hello  ' });
    assert.strictEqual(result.key, 'hello');
  });

  it('filters out null and undefined values', () => {
    const result = cleanWorkspaceArtifactPayload({ a: 'keep', b: null, c: undefined });
    assert.ok('a' in result);
    assert.ok(!('b' in result));
    assert.ok(!('c' in result));
  });

  it('filters out empty string values', () => {
    const result = cleanWorkspaceArtifactPayload({ a: 'keep', b: '' });
    assert.ok('a' in result);
    assert.ok(!('b' in result));
  });

  it('preserves non-string values (numbers, booleans, objects)', () => {
    const result = cleanWorkspaceArtifactPayload({
      num: 42,
      bool: true,
      obj: { nested: true },
      arr: [1, 2],
    });
    assert.strictEqual(result.num, 42);
    assert.strictEqual(result.bool, true);
    assert.deepStrictEqual(result.obj, { nested: true });
    assert.deepStrictEqual(result.arr, [1, 2]);
  });

  it('coerces keys to strings', () => {
    const result = cleanWorkspaceArtifactPayload({ 1: 'val' });
    assert.ok('1' in result);
  });
});

// ── normalizeWorkspaceArtifact ───────────────────────────────────────────────

describe('normalizeWorkspaceArtifact', () => {
  it('returns normalized structure for non-object input', () => {
    const result = normalizeWorkspaceArtifact(null);
    assert.ok(typeof result.id === 'string');
    assert.strictEqual(result.kind, 'artifact');
    assert.strictEqual(result.status, 'active');
    assert.strictEqual(result.createdAt, null);
    assert.strictEqual(result.updatedAt, null);
    assert.deepStrictEqual(result.source, {});
    assert.deepStrictEqual(result.payload, {});
  });

  it('uses id when provided', () => {
    const result = normalizeWorkspaceArtifact({ id: 'my-artifact' });
    assert.strictEqual(result.id, 'my-artifact');
  });

  it('falls back to title for id when id missing', () => {
    const result = normalizeWorkspaceArtifact({ title: 'MyTitle' });
    assert.strictEqual(result.id, 'MyTitle');
    assert.strictEqual(result.title, 'MyTitle');
  });

  it('generates UUID when both id and title are missing', () => {
    const result = normalizeWorkspaceArtifact({});
    assert.ok(typeof result.id === 'string' && result.id.length > 0);
    // title falls back to normalizedId
    assert.strictEqual(result.title, result.id);
  });

  it('uses provided kind, defaulting to artifact', () => {
    assert.strictEqual(normalizeWorkspaceArtifact({ id: 'x', kind: 'draft' }).kind, 'draft');
    assert.strictEqual(normalizeWorkspaceArtifact({ id: 'x', kind: '' }).kind, 'artifact');
    assert.strictEqual(normalizeWorkspaceArtifact({ id: 'x' }).kind, 'artifact');
  });

  it('uses provided status, defaulting to active', () => {
    assert.strictEqual(normalizeWorkspaceArtifact({ id: 'x', status: 'archived' }).status, 'archived');
    assert.strictEqual(normalizeWorkspaceArtifact({ id: 'x', status: '' }).status, 'active');
    assert.strictEqual(normalizeWorkspaceArtifact({ id: 'x' }).status, 'active');
  });

  it('trims title', () => {
    const result = normalizeWorkspaceArtifact({ id: 'x', title: '  Trimmed Title  ' });
    assert.strictEqual(result.title, 'Trimmed Title');
  });

  it('preserves createdAt and updatedAt strings', () => {
    const result = normalizeWorkspaceArtifact({
      id: 'x',
      createdAt: '2024-01-01',
      updatedAt: '2024-02-01',
    });
    assert.strictEqual(result.createdAt, '2024-01-01');
    assert.strictEqual(result.updatedAt, '2024-02-01');
  });

  it('normalizes relatedTo fields', () => {
    const result = normalizeWorkspaceArtifact({
      id: 'x',
      relatedTo: {
        openDirectory: '  /path  ',
        sessionId: '  sess123  ',
        parentId: '  parent456  ',
      },
    });
    assert.strictEqual(result.relatedTo.openDirectory, '/path');
    assert.strictEqual(result.relatedTo.sessionId, 'sess123');
    assert.strictEqual(result.relatedTo.parentId, 'parent456');
  });

  it('defaults relatedTo fields to empty strings', () => {
    const result = normalizeWorkspaceArtifact({ id: 'x' });
    assert.strictEqual(result.relatedTo.openDirectory, '');
    assert.strictEqual(result.relatedTo.sessionId, '');
    assert.strictEqual(result.relatedTo.parentId, '');
  });

  it('cleans payload through cleanWorkspaceArtifactPayload', () => {
    const result = normalizeWorkspaceArtifact({
      id: 'x',
      payload: { keep: 'val', drop: null, empty: '' },
    });
    assert.strictEqual(result.payload.keep, 'val');
    assert.ok(!('drop' in result.payload));
    assert.ok(!('empty' in result.payload));
  });

  it('preserves source object', () => {
    const source = { workspace: 'test', formId: 'f1' };
    const result = normalizeWorkspaceArtifact({ id: 'x', source });
    assert.deepStrictEqual(result.source, source);
  });
});

// ── buildFeatureCreatorDraftArtifact ─────────────────────────────────────────

describe('buildFeatureCreatorDraftArtifact', () => {
  it('returns null when no openDirectory and no featureName/targetDir', () => {
    const state = { forms: { 'startup-form': { goal: 'some goal' } } };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result, null);
  });

  it('returns null for empty state', () => {
    assert.strictEqual(buildFeatureCreatorDraftArtifact({}, '2024-01-01'), null);
    assert.strictEqual(buildFeatureCreatorDraftArtifact(null, '2024-01-01'), null);
    assert.strictEqual(buildFeatureCreatorDraftArtifact(undefined, '2024-01-01'), null);
  });

  it('uses openDirectory as stableKey when present', () => {
    const state = {
      openDirectory: '/dev/project',
      forms: { 'startup-form': { feature_name: 'MyFeature' } },
    };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.ok(result);
    // sanitizeSessionFragment replaces / with - and strips leading/trailing -
    assert.strictEqual(result.id, 'feature-creator-draft-dev-project');
  });

  it('uses featureName@targetDir as stableKey when no openDirectory', () => {
    const state = {
      forms: { 'startup-form': { feature_name: 'MyFeature', target_dir: '/some/dir' } },
    };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.ok(result);
    // sanitizeSessionFragment replaces @ and / with -
    assert.strictEqual(result.id, 'feature-creator-draft-MyFeature-some-dir');
  });

  it('uses featureName only as stableKey when no openDirectory and no targetDir', () => {
    const state = {
      forms: { 'startup-form': { feature_name: 'MyFeature' } },
    };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.ok(result);
    assert.strictEqual(result.id, 'feature-creator-draft-MyFeature');
  });

  it('sets kind to draft', () => {
    const state = { openDirectory: '/dev' };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.kind, 'draft');
  });

  it('sets title with feature name when present', () => {
    const state = {
      openDirectory: '/dev',
      forms: { 'startup-form': { feature_name: 'CoolFeature' } },
    };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.title, '创建 CoolFeature');
  });

  it('sets default title when feature name is empty', () => {
    const state = { openDirectory: '/dev' };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.title, 'Feature 创建草稿');
  });

  it('sets source workspace to feature-creator', () => {
    const state = { openDirectory: '/dev' };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.source.workspace, 'feature-creator');
    assert.strictEqual(result.source.formId, 'startup-form');
  });

  it('sets timestamps from parameter', () => {
    const state = { openDirectory: '/dev' };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-06-15T10:00:00Z');
    assert.strictEqual(result.createdAt, '2024-06-15T10:00:00Z');
    assert.strictEqual(result.updatedAt, '2024-06-15T10:00:00Z');
  });

  it('passes form fields into payload', () => {
    const state = {
      openDirectory: '/dev',
      forms: {
        'startup-form': {
          feature_name: 'MyFeature',
          goal: 'Build it',
          constraints: 'No deps',
          install_mode: 'custom',
          target_dir: '/target',
        },
      },
    };
    const result = buildFeatureCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.payload.feature_name, 'MyFeature');
    assert.strictEqual(result.payload.goal, 'Build it');
    assert.strictEqual(result.payload.constraints, 'No deps');
    assert.strictEqual(result.payload.install_mode, 'custom');
    assert.strictEqual(result.payload.target_dir, '/target');
  });
});

// ── buildAgentCreatorDraftArtifact ───────────────────────────────────────────

describe('buildAgentCreatorDraftArtifact', () => {
  it('returns null when no openDirectory and no agentName/targetDir', () => {
    const state = { forms: { 'startup-form': { goal: 'some goal' } } };
    const result = buildAgentCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result, null);
  });

  it('returns null for empty state', () => {
    assert.strictEqual(buildAgentCreatorDraftArtifact({}, '2024-01-01'), null);
    assert.strictEqual(buildAgentCreatorDraftArtifact(null, '2024-01-01'), null);
  });

  it('uses openDirectory as stableKey when present', () => {
    const state = {
      openDirectory: '/dev/project',
      forms: { 'startup-form': { agent_name: 'MyAgent' } },
    };
    const result = buildAgentCreatorDraftArtifact(state, '2024-01-01');
    assert.ok(result);
    // sanitizeSessionFragment replaces / with - and strips leading/trailing -
    assert.strictEqual(result.id, 'agent-creator-draft-dev-project');
  });

  it('uses agentName@targetDir as stableKey when no openDirectory', () => {
    const state = {
      forms: { 'startup-form': { agent_name: 'MyAgent', target_dir: '/some/dir' } },
    };
    const result = buildAgentCreatorDraftArtifact(state, '2024-01-01');
    assert.ok(result);
    // sanitizeSessionFragment replaces @ and / with -
    assert.strictEqual(result.id, 'agent-creator-draft-MyAgent-some-dir');
  });

  it('sets kind to draft', () => {
    const state = { openDirectory: '/dev' };
    const result = buildAgentCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.kind, 'draft');
  });

  it('sets title with agent name when present', () => {
    const state = {
      openDirectory: '/dev',
      forms: { 'startup-form': { agent_name: 'CoolBot' } },
    };
    const result = buildAgentCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.title, '创建 CoolBot');
  });

  it('sets default title when agent name is empty', () => {
    const state = { openDirectory: '/dev' };
    const result = buildAgentCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.title, 'Agent 创建草稿');
  });

  it('sets source workspace to agent-creator', () => {
    const state = { openDirectory: '/dev' };
    const result = buildAgentCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.source.workspace, 'agent-creator');
    assert.strictEqual(result.source.formId, 'startup-form');
  });

  it('passes form fields into payload including agent-specific fields', () => {
    const state = {
      openDirectory: '/dev',
      forms: {
        'startup-form': {
          agent_name: 'MyAgent',
          goal: 'Help users',
          constraints: 'Be polite',
          install_mode: 'system',
          target_dir: '/target',
          target_user: 'developers',
          runtime_style: 'interactive',
          planned_features: 'shell, memory',
        },
      },
    };
    const result = buildAgentCreatorDraftArtifact(state, '2024-01-01');
    assert.strictEqual(result.payload.agent_name, 'MyAgent');
    assert.strictEqual(result.payload.goal, 'Help users');
    assert.strictEqual(result.payload.constraints, 'Be polite');
    assert.strictEqual(result.payload.target_user, 'developers');
    assert.strictEqual(result.payload.runtime_style, 'interactive');
    assert.strictEqual(result.payload.planned_features, 'shell, memory');
  });
});

// ── buildProgrammingHelperDraftArtifact ──────────────────────────────────────

describe('buildProgrammingHelperDraftArtifact', () => {
  it('always returns null regardless of state', () => {
    assert.strictEqual(buildProgrammingHelperDraftArtifact({}, '2024-01-01'), null);
    assert.strictEqual(buildProgrammingHelperDraftArtifact({
      openDirectory: '/dev',
      forms: { 'startup-form': { feature_name: 'test' } },
    }, '2024-01-01'), null);
    assert.strictEqual(buildProgrammingHelperDraftArtifact(null, '2024-01-01'), null);
    assert.strictEqual(buildProgrammingHelperDraftArtifact(undefined, '2024-01-01'), null);
  });
});
