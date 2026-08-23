/**
 * Tests for workspace state normalization + project functions
 *
 * Covers:
 * 1. normalizeFeatureConfigs           (workspace.js)
 * 2. normalizeWorkspaceState           (workspace.js)
 * 3. normalizeWorkspaceFeatureProject  (workspace-projects.js)
 * 4. normalizeWorkspaceAgentProject    (workspace-projects.js)
 * 5. normalizeWorkspacePhProject       (workspace-projects.js)
 * 6. upsertWorkspacePhProject          (workspace-projects.js)
 * 7. removeWorkspacePhProject          (workspace-projects.js)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFeatureConfigs,
  normalizeWorkspaceState,
} from '../server/routes/workspace.js';

import {
  resolveHostTarget,
} from '../server/shared/operation-target.js';

import {
  normalizeWorkspaceFeatureProject,
  normalizeWorkspaceAgentProject,
  normalizeWorkspacePhProject,
  upsertWorkspacePhProject,
  removeWorkspacePhProject,
} from '../server/routes/workspace-projects.js';

// Host workspace state is local to the named workspace record; a page focus
// value is not a substitute for that host-owned target.
describe('workspace host target boundary', () => {
  it('does not derive workspace ownership from focusedAgentId', () => {
    assert.deepStrictEqual(resolveHostTarget({ focusedAgentId: 'agent-a' }), {
      scope: 'local-host',
      agentId: null,
    });
  });
});

// ── normalizeFeatureConfigs ──────────────────────────────────────────────────

describe('normalizeFeatureConfigs', () => {
  it('returns empty object for null/undefined/non-object input', () => {
    assert.deepStrictEqual(normalizeFeatureConfigs(null), {});
    assert.deepStrictEqual(normalizeFeatureConfigs(undefined), {});
    assert.deepStrictEqual(normalizeFeatureConfigs('string'), {});
    assert.deepStrictEqual(normalizeFeatureConfigs(42), {});
    assert.deepStrictEqual(normalizeFeatureConfigs([]), {});
  });

  it('returns empty object for empty object input', () => {
    assert.deepStrictEqual(normalizeFeatureConfigs({}), {});
  });

  it('normalizes valid feature configs', () => {
    const input = {
      'shell-feature': { enabled: true, priority: 1 },
      'memory-feature': { key: 'value' },
    };
    const result = normalizeFeatureConfigs(input);
    assert.ok(result['shell-feature']);
    assert.strictEqual(result['shell-feature'].enabled, true);
    assert.strictEqual(result['shell-feature'].priority, 1);
    assert.strictEqual(result['memory-feature'].key, 'value');
  });

  it('skips non-object config values (arrays, nulls, primitives)', () => {
    const input = {
      'valid-config': { key: 'val' },
      'invalid-array': [1, 2, 3],
      'invalid-null': null,
      'invalid-string': 'hello',
    };
    const result = normalizeFeatureConfigs(input);
    assert.ok(result['valid-config']);
    assert.strictEqual(result['valid-config'].key, 'val');
    assert.ok(!('invalid-array' in result));
    assert.ok(!('invalid-null' in result));
    assert.ok(!('invalid-string' in result));
  });

  it('coerces feature keys to strings', () => {
    const input = { 42: { key: 'val' } };
    const result = normalizeFeatureConfigs(input);
    assert.ok(result['42']);
    assert.strictEqual(result['42'].key, 'val');
  });
});

// ── normalizeWorkspaceState ──────────────────────────────────────────────────

describe('normalizeWorkspaceState', () => {
  it('returns normalized empty state for no input', () => {
    const result = normalizeWorkspaceState();
    assert.ok(result.forms);
    assert.deepStrictEqual(result.forms, {});
    assert.deepStrictEqual(result.assemblyConfigs, []);
    assert.deepStrictEqual(result.featureProjects, []);
    assert.deepStrictEqual(result.agentProjects, []);
    assert.deepStrictEqual(result.phProjects, []);
    assert.strictEqual(result.openDirectory, '');
    assert.strictEqual(result.updatedAt, null);
  });

  it('coerces form field values to strings', () => {
    const result = normalizeWorkspaceState({
      forms: {
        'startup-form': { feature_name: 'test', count: 123 },
      },
    });
    assert.strictEqual(result.forms['startup-form'].feature_name, 'test');
    assert.strictEqual(result.forms['startup-form'].count, '123');
  });

  it('normalizes feature-configs inside forms', () => {
    const result = normalizeWorkspaceState({
      forms: {
        'feature-configs': {
          'shell-feature': { enabled: true },
        },
      },
    });
    assert.ok(result.forms['feature-configs']['shell-feature']);
    assert.strictEqual(result.forms['feature-configs']['shell-feature'].enabled, true);
  });

  it('normalizes phProjects', () => {
    const result = normalizeWorkspaceState({
      phProjects: [
        { openDirectory: '/foo/bar', createdAt: '2024-01-01', updatedAt: '2024-01-02' },
        { openDirectory: '  ', createdAt: '2024-01-01' }, // should be filtered out
      ],
    });
    assert.strictEqual(result.phProjects.length, 1);
    assert.strictEqual(result.phProjects[0].id, 'dir:/foo/bar');
  });

  it('normalizes featureProjects', () => {
    const result = normalizeWorkspaceState({
      featureProjects: [
        { featureName: 'MyFeature', openDirectory: '/dev/proj' },
      ],
    });
    assert.strictEqual(result.featureProjects.length, 1);
    assert.strictEqual(result.featureProjects[0].featureName, 'MyFeature');
    assert.strictEqual(result.featureProjects[0].installMode, 'system');
  });

  it('normalizes agentProjects', () => {
    const result = normalizeWorkspaceState({
      agentProjects: [
        { agentName: 'MyAgent', openDirectory: '/dev/proj' },
      ],
    });
    assert.strictEqual(result.agentProjects.length, 1);
    assert.strictEqual(result.agentProjects[0].agentName, 'MyAgent');
  });

  it('preserves openDirectory and updatedAt', () => {
    const result = normalizeWorkspaceState({
      openDirectory: '  /path/to/dir  ',
      updatedAt: '2024-06-01T00:00:00Z',
    });
    assert.strictEqual(result.openDirectory, '/path/to/dir');
    assert.strictEqual(result.updatedAt, '2024-06-01T00:00:00Z');
  });

  it('normalizes assemblyConfigs with id filter', () => {
    const result = normalizeWorkspaceState({
      assemblyConfigs: [
        { id: 'cfg1', name: 'Config 1', features: ['f1', 'f2'] },
        { id: '', name: 'No ID' }, // should be filtered (no id)
      ],
    });
    assert.strictEqual(result.assemblyConfigs.length, 1);
    assert.strictEqual(result.assemblyConfigs[0].id, 'cfg1');
    assert.deepStrictEqual(result.assemblyConfigs[0].features, ['f1', 'f2']);
  });
});

// ── normalizeWorkspaceFeatureProject ─────────────────────────────────────────

describe('normalizeWorkspaceFeatureProject', () => {
  it('returns null for null/undefined/non-object input', () => {
    assert.strictEqual(normalizeWorkspaceFeatureProject(null), null);
    assert.strictEqual(normalizeWorkspaceFeatureProject(undefined), null);
    assert.strictEqual(normalizeWorkspaceFeatureProject('string'), null);
  });

  it('returns null when no identifying fields are present', () => {
    assert.strictEqual(normalizeWorkspaceFeatureProject({}), null);
    assert.strictEqual(normalizeWorkspaceFeatureProject({ goal: 'some goal' }), null);
  });

  it('normalizes with openDirectory taking priority for id', () => {
    const result = normalizeWorkspaceFeatureProject({
      openDirectory: '/foo/Bar',
      featureName: 'my-feature',
      targetDir: '/some/target',
    });
    assert.strictEqual(result.id, 'dir:/foo/bar');
    assert.strictEqual(result.featureName, 'my-feature');
    assert.strictEqual(result.installMode, 'system');
  });

  it('normalizes with featureName+targetDir for id when no openDirectory', () => {
    const result = normalizeWorkspaceFeatureProject({
      featureName: 'MyFeature',
      targetDir: '/dev/Project',
    });
    assert.strictEqual(result.id, 'feature:myfeature@/dev/project');
  });

  it('normalizes with featureName only for id', () => {
    const result = normalizeWorkspaceFeatureProject({
      featureName: 'MyFeature',
    });
    assert.strictEqual(result.id, 'feature:myfeature');
  });

  it('respects custom installMode', () => {
    const result = normalizeWorkspaceFeatureProject({
      openDirectory: '/dev/proj',
      installMode: 'custom',
    });
    assert.strictEqual(result.installMode, 'custom');
  });

  it('trims string fields', () => {
    const result = normalizeWorkspaceFeatureProject({
      openDirectory: '  /foo/bar  ',
      featureName: '  test  ',
      targetDir: '  /target  ',
      goal: '  my goal  ',
      constraints: '  constraint  ',
    });
    assert.strictEqual(result.openDirectory, '/foo/bar');
    assert.strictEqual(result.featureName, 'test');
    assert.strictEqual(result.targetDir, '/target');
    assert.strictEqual(result.goal, 'my goal');
    assert.strictEqual(result.constraints, 'constraint');
  });
});

// ── normalizeWorkspaceAgentProject ───────────────────────────────────────────

describe('normalizeWorkspaceAgentProject', () => {
  it('returns null for null/undefined/non-object input', () => {
    assert.strictEqual(normalizeWorkspaceAgentProject(null), null);
    assert.strictEqual(normalizeWorkspaceAgentProject(undefined), null);
    assert.strictEqual(normalizeWorkspaceAgentProject('string'), null);
  });

  it('returns null when no identifying fields are present', () => {
    assert.strictEqual(normalizeWorkspaceAgentProject({}), null);
    assert.strictEqual(normalizeWorkspaceAgentProject({ goal: 'some goal' }), null);
  });

  it('normalizes with openDirectory taking priority for id', () => {
    const result = normalizeWorkspaceAgentProject({
      openDirectory: '/foo/Bar',
      agentName: 'my-agent',
    });
    assert.strictEqual(result.id, 'dir:/foo/bar');
    assert.strictEqual(result.agentName, 'my-agent');
  });

  it('normalizes with agentName+targetDir for id when no openDirectory', () => {
    const result = normalizeWorkspaceAgentProject({
      agentName: 'MyAgent',
      targetDir: '/dev/Project',
    });
    assert.strictEqual(result.id, 'agent:myagent@/dev/project');
  });

  it('normalizes with agentName only for id', () => {
    const result = normalizeWorkspaceAgentProject({
      agentName: 'MyAgent',
    });
    assert.strictEqual(result.id, 'agent:myagent');
  });

  it('preserves extra agent fields', () => {
    const result = normalizeWorkspaceAgentProject({
      openDirectory: '/dev/proj',
      agentName: 'Bot',
      targetUser: 'developer',
      runtimeStyle: 'interactive',
      plannedFeatures: 'shell, memory',
      managedBy: 'assembly-config',
    });
    assert.strictEqual(result.targetUser, 'developer');
    assert.strictEqual(result.runtimeStyle, 'interactive');
    assert.strictEqual(result.plannedFeatures, 'shell, memory');
    assert.strictEqual(result.managedBy, 'assembly-config');
  });
});

// ── normalizeWorkspacePhProject ──────────────────────────────────────────────

describe('normalizeWorkspacePhProject', () => {
  it('returns null for null/undefined/non-object input', () => {
    assert.strictEqual(normalizeWorkspacePhProject(null), null);
    assert.strictEqual(normalizeWorkspacePhProject(undefined), null);
    assert.strictEqual(normalizeWorkspacePhProject('string'), null);
  });

  it('returns null when openDirectory is empty', () => {
    assert.strictEqual(normalizeWorkspacePhProject({}), null);
    assert.strictEqual(normalizeWorkspacePhProject({ openDirectory: '  ' }), null);
  });

  it('normalizes openDirectory into id', () => {
    const result = normalizeWorkspacePhProject({
      openDirectory: '/foo/Bar',
      createdAt: '2024-01-01',
      updatedAt: '2024-02-01',
    });
    assert.strictEqual(result.id, 'dir:/foo/bar');
    assert.strictEqual(result.openDirectory, '/foo/Bar');
    assert.strictEqual(result.createdAt, '2024-01-01');
    assert.strictEqual(result.updatedAt, '2024-02-01');
  });

  it('converts backslashes to forward slashes in id', () => {
    const result = normalizeWorkspacePhProject({
      openDirectory: 'C:\\Users\\dev\\project',
    });
    assert.strictEqual(result.id, 'dir:c:/users/dev/project');
  });

  it('lowercases path in id', () => {
    const result = normalizeWorkspacePhProject({
      openDirectory: '/PATH/TO/PROJECT',
    });
    assert.strictEqual(result.id, 'dir:/path/to/project');
  });

  it('defaults timestamps to null when not provided', () => {
    const result = normalizeWorkspacePhProject({
      openDirectory: '/dev/proj',
    });
    assert.strictEqual(result.createdAt, null);
    assert.strictEqual(result.updatedAt, null);
  });
});

// ── upsertWorkspacePhProject ─────────────────────────────────────────────────

describe('upsertWorkspacePhProject', () => {
  it('returns state unchanged when project is invalid (no openDirectory)', () => {
    const state = { phProjects: [{ id: 'dir:/existing', openDirectory: '/existing' }] };
    const result = upsertWorkspacePhProject(state, { openDirectory: '' }, '2024-01-01');
    assert.strictEqual(result, state); // same reference
  });

  it('adds new project to empty state', () => {
    const state = { phProjects: [] };
    const result = upsertWorkspacePhProject(state, { openDirectory: '/new' }, '2024-06-01');
    assert.strictEqual(result.phProjects.length, 1);
    assert.strictEqual(result.phProjects[0].id, 'dir:/new');
    assert.strictEqual(result.phProjects[0].openDirectory, '/new');
    assert.strictEqual(result.phProjects[0].updatedAt, '2024-06-01');
    assert.strictEqual(result.phProjects[0].createdAt, '2024-06-01');
  });

  it('updates existing project by id', () => {
    const state = {
      phProjects: [
        { id: 'dir:/proj', openDirectory: '/proj', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const result = upsertWorkspacePhProject(state, { openDirectory: '/proj' }, '2024-06-01');
    assert.strictEqual(result.phProjects.length, 1);
    assert.strictEqual(result.phProjects[0].createdAt, '2024-01-01');
    assert.strictEqual(result.phProjects[0].updatedAt, '2024-06-01');
  });

  it('preserves createdAt of existing project', () => {
    const state = {
      phProjects: [
        { id: 'dir:/proj', openDirectory: '/proj', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const result = upsertWorkspacePhProject(state, { openDirectory: '/proj' }, '2024-06-01');
    assert.strictEqual(result.phProjects[0].createdAt, '2024-01-01');
  });

  it('sorts projects by updatedAt descending', () => {
    const state = {
      phProjects: [
        { id: 'dir:/old', openDirectory: '/old', updatedAt: '2024-01-01' },
      ],
    };
    const result = upsertWorkspacePhProject(state, { openDirectory: '/new' }, '2024-06-01');
    assert.strictEqual(result.phProjects[0].id, 'dir:/new');
    assert.strictEqual(result.phProjects[1].id, 'dir:/old');
  });

  it('initializes phProjects array when missing', () => {
    const state = {};
    const result = upsertWorkspacePhProject(state, { openDirectory: '/proj' }, '2024-01-01');
    assert.ok(Array.isArray(result.phProjects));
    assert.strictEqual(result.phProjects.length, 1);
  });
});

// ── removeWorkspacePhProject ─────────────────────────────────────────────────

describe('removeWorkspacePhProject', () => {
  it('removes project by id', () => {
    const state = {
      phProjects: [
        { id: 'dir:/a', openDirectory: '/a' },
        { id: 'dir:/b', openDirectory: '/b' },
      ],
    };
    const result = removeWorkspacePhProject(state, 'dir:/a');
    assert.strictEqual(result.phProjects.length, 1);
    assert.strictEqual(result.phProjects[0].id, 'dir:/b');
  });

  it('returns empty array when phProjects is missing', () => {
    const state = {};
    const result = removeWorkspacePhProject(state, 'dir:/nonexistent');
    assert.ok(Array.isArray(result.phProjects));
    assert.strictEqual(result.phProjects.length, 0);
  });

  it('does not mutate original state', () => {
    const state = {
      phProjects: [{ id: 'dir:/a', openDirectory: '/a' }],
    };
    const result = removeWorkspacePhProject(state, 'dir:/a');
    assert.strictEqual(state.phProjects.length, 1);
    assert.strictEqual(result.phProjects.length, 0);
  });

  it('handles non-existent id gracefully', () => {
    const state = {
      phProjects: [{ id: 'dir:/a', openDirectory: '/a' }],
    };
    const result = removeWorkspacePhProject(state, 'dir:/nonexistent');
    assert.strictEqual(result.phProjects.length, 1);
  });
});
