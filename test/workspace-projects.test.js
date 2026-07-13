/**
 * Tests for server/routes/workspace-projects.js — project CRUD, ID builders, and sync functions
 *
 * Covers:
 * 1. buildWorkspaceFeatureProjectId
 * 2. buildWorkspaceAgentProjectId
 * 3. upsertWorkspaceFeatureProject
 * 4. upsertWorkspaceAgentProject
 * 5. syncFeatureCreatorProjects
 * 6. syncAgentCreatorProjects
 * 7. syncFlowAssemblyProjects
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkspaceFeatureProjectId,
  buildWorkspaceAgentProjectId,
  upsertWorkspaceFeatureProject,
  upsertWorkspaceAgentProject,
  syncFeatureCreatorProjects,
  syncAgentCreatorProjects,
  syncFlowAssemblyProjects,
} from '../server/routes/workspace-projects.js';

// ── buildWorkspaceFeatureProjectId ───────────────────────────────────────────

describe('buildWorkspaceFeatureProjectId', () => {
  it('uses openDirectory when present', () => {
    assert.strictEqual(
      buildWorkspaceFeatureProjectId({ openDirectory: '/foo/Bar' }),
      'dir:/foo/bar',
    );
  });

  it('converts backslashes to forward slashes in openDirectory', () => {
    assert.strictEqual(
      buildWorkspaceFeatureProjectId({ openDirectory: 'C:\\dev\\proj' }),
      'dir:c:/dev/proj',
    );
  });

  it('uses featureName@targetDir when no openDirectory', () => {
    assert.strictEqual(
      buildWorkspaceFeatureProjectId({ featureName: 'MyFeature', targetDir: '/dev/Project' }),
      'feature:myfeature@/dev/project',
    );
  });

  it('uses featureName only when no openDirectory and no targetDir', () => {
    assert.strictEqual(
      buildWorkspaceFeatureProjectId({ featureName: 'MyFeature' }),
      'feature:myfeature',
    );
  });

  it('returns empty string when no identifying fields', () => {
    assert.strictEqual(buildWorkspaceFeatureProjectId({}), '');
    assert.strictEqual(buildWorkspaceFeatureProjectId({ targetDir: '/only/dir' }), '');
    assert.strictEqual(buildWorkspaceFeatureProjectId(), '');
  });

  it('trims inputs', () => {
    assert.strictEqual(
      buildWorkspaceFeatureProjectId({ openDirectory: '  /path  ' }),
      'dir:/path',
    );
  });
});

// ── buildWorkspaceAgentProjectId ─────────────────────────────────────────────

describe('buildWorkspaceAgentProjectId', () => {
  it('uses openDirectory when present', () => {
    assert.strictEqual(
      buildWorkspaceAgentProjectId({ openDirectory: '/foo/Bar' }),
      'dir:/foo/bar',
    );
  });

  it('uses agentName@targetDir when no openDirectory', () => {
    assert.strictEqual(
      buildWorkspaceAgentProjectId({ agentName: 'MyAgent', targetDir: '/dev/Project' }),
      'agent:myagent@/dev/project',
    );
  });

  it('uses agentName only when no openDirectory and no targetDir', () => {
    assert.strictEqual(
      buildWorkspaceAgentProjectId({ agentName: 'MyAgent' }),
      'agent:myagent',
    );
  });

  it('returns empty string when no identifying fields', () => {
    assert.strictEqual(buildWorkspaceAgentProjectId({}), '');
    assert.strictEqual(buildWorkspaceAgentProjectId({ targetDir: '/only/dir' }), '');
  });
});

// ── upsertWorkspaceFeatureProject ────────────────────────────────────────────

describe('upsertWorkspaceFeatureProject', () => {
  it('returns state unchanged when project is invalid (no identifying fields)', () => {
    const state = { featureProjects: [] };
    const result = upsertWorkspaceFeatureProject(state, { goal: 'x' }, '2024-01-01');
    assert.strictEqual(result, state);
  });

  it('adds new project to empty state', () => {
    const state = { featureProjects: [] };
    const result = upsertWorkspaceFeatureProject(state, {
      featureName: 'TestFeature',
      openDirectory: '/dev',
    }, '2024-06-01');
    assert.strictEqual(result.featureProjects.length, 1);
    assert.strictEqual(result.featureProjects[0].featureName, 'TestFeature');
    assert.strictEqual(result.featureProjects[0].updatedAt, '2024-06-01');
    assert.strictEqual(result.featureProjects[0].createdAt, '2024-06-01');
  });

  it('updates existing project by id', () => {
    const state = {
      featureProjects: [
        { id: 'dir:/proj', featureName: 'Old', openDirectory: '/proj', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const result = upsertWorkspaceFeatureProject(state, {
      featureName: 'New',
      openDirectory: '/proj',
    }, '2024-06-01');
    assert.strictEqual(result.featureProjects.length, 1);
    assert.strictEqual(result.featureProjects[0].featureName, 'New');
    assert.strictEqual(result.featureProjects[0].createdAt, '2024-01-01');
    assert.strictEqual(result.featureProjects[0].updatedAt, '2024-06-01');
  });

  it('preserves createdAt of existing project', () => {
    const state = {
      featureProjects: [
        { id: 'dir:/proj', featureName: 'X', openDirectory: '/proj', createdAt: '2023-01-01', updatedAt: '2023-01-01' },
      ],
    };
    const result = upsertWorkspaceFeatureProject(state, { openDirectory: '/proj' }, '2024-06-01');
    assert.strictEqual(result.featureProjects[0].createdAt, '2023-01-01');
  });

  it('sorts projects by updatedAt descending', () => {
    const state = {
      featureProjects: [
        { id: 'dir:/old', openDirectory: '/old', updatedAt: '2024-01-01' },
      ],
    };
    const result = upsertWorkspaceFeatureProject(state, { openDirectory: '/new' }, '2024-06-01');
    assert.strictEqual(result.featureProjects[0].id, 'dir:/new');
    assert.strictEqual(result.featureProjects[1].id, 'dir:/old');
  });

  it('does not mutate original state', () => {
    const state = { featureProjects: [] };
    const result = upsertWorkspaceFeatureProject(state, { openDirectory: '/dev' }, '2024-01-01');
    assert.strictEqual(state.featureProjects.length, 0);
    assert.strictEqual(result.featureProjects.length, 1);
  });

  it('initializes featureProjects array when missing', () => {
    const state = {};
    const result = upsertWorkspaceFeatureProject(state, { openDirectory: '/dev' }, '2024-01-01');
    assert.ok(Array.isArray(result.featureProjects));
    assert.strictEqual(result.featureProjects.length, 1);
  });
});

// ── upsertWorkspaceAgentProject ──────────────────────────────────────────────

describe('upsertWorkspaceAgentProject', () => {
  it('returns state unchanged when project is invalid', () => {
    const state = { agentProjects: [] };
    const result = upsertWorkspaceAgentProject(state, { goal: 'x' }, '2024-01-01');
    assert.strictEqual(result, state);
  });

  it('adds new project to empty state', () => {
    const state = { agentProjects: [] };
    const result = upsertWorkspaceAgentProject(state, {
      agentName: 'TestBot',
      openDirectory: '/dev',
    }, '2024-06-01');
    assert.strictEqual(result.agentProjects.length, 1);
    assert.strictEqual(result.agentProjects[0].agentName, 'TestBot');
  });

  it('updates existing project by id', () => {
    const state = {
      agentProjects: [
        { id: 'dir:/proj', agentName: 'Old', openDirectory: '/proj', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const result = upsertWorkspaceAgentProject(state, {
      agentName: 'New',
      openDirectory: '/proj',
    }, '2024-06-01');
    assert.strictEqual(result.agentProjects.length, 1);
    assert.strictEqual(result.agentProjects[0].agentName, 'New');
    assert.strictEqual(result.agentProjects[0].createdAt, '2024-01-01');
  });

  it('preserves managedBy when updating', () => {
    const state = {
      agentProjects: [
        { id: 'dir:/proj', agentName: 'Bot', openDirectory: '/proj', managedBy: 'assembly-config', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const result = upsertWorkspaceAgentProject(state, {
      agentName: 'Bot',
      openDirectory: '/proj',
      managedBy: 'assembly-config',
    }, '2024-06-01');
    assert.strictEqual(result.agentProjects[0].managedBy, 'assembly-config');
  });

  it('sorts projects by updatedAt descending', () => {
    const state = {
      agentProjects: [
        { id: 'dir:/old', agentName: 'Old', openDirectory: '/old', updatedAt: '2024-01-01' },
      ],
    };
    const result = upsertWorkspaceAgentProject(state, { openDirectory: '/new' }, '2024-06-01');
    assert.strictEqual(result.agentProjects[0].id, 'dir:/new');
    assert.strictEqual(result.agentProjects[1].id, 'dir:/old');
  });

  it('initializes agentProjects array when missing', () => {
    const state = {};
    const result = upsertWorkspaceAgentProject(state, { agentName: 'Bot' }, '2024-01-01');
    assert.ok(Array.isArray(result.agentProjects));
    assert.strictEqual(result.agentProjects.length, 1);
  });
});

// ── syncFeatureCreatorProjects ───────────────────────────────────────────────

describe('syncFeatureCreatorProjects', () => {
  it('returns state unchanged when no featureName and no openDirectory', () => {
    const state = { forms: { 'startup-form': { goal: 'x' } } };
    const result = syncFeatureCreatorProjects(state, '2024-01-01');
    assert.strictEqual(result, state);
  });

  it('returns state unchanged for empty startup-form', () => {
    const state = { forms: { 'startup-form': {} }, featureProjects: [] };
    const result = syncFeatureCreatorProjects(state, '2024-01-01');
    assert.strictEqual(result, state);
  });

  it('returns state unchanged when forms is missing', () => {
    const state = { featureProjects: [] };
    const result = syncFeatureCreatorProjects(state, '2024-01-01');
    assert.strictEqual(result, state);
  });

  it('upserts feature project from startup form', () => {
    const state = {
      forms: {
        'startup-form': {
          feature_name: 'MyFeature',
          target_dir: '/target',
          goal: 'Build it',
          constraints: 'No deps',
          install_mode: 'custom',
        },
      },
      featureProjects: [],
    };
    const result = syncFeatureCreatorProjects(state, '2024-06-01');
    assert.strictEqual(result.featureProjects.length, 1);
    assert.strictEqual(result.featureProjects[0].featureName, 'MyFeature');
    assert.strictEqual(result.featureProjects[0].installMode, 'custom');
    assert.strictEqual(result.featureProjects[0].goal, 'Build it');
  });

  it('upserts project using openDirectory when no featureName', () => {
    const state = {
      openDirectory: '/dev/proj',
      forms: { 'startup-form': {} },
      featureProjects: [],
    };
    const result = syncFeatureCreatorProjects(state, '2024-06-01');
    assert.strictEqual(result.featureProjects.length, 1);
    assert.strictEqual(result.featureProjects[0].openDirectory, '/dev/proj');
  });

  it('updates existing project rather than adding duplicate', () => {
    const state = {
      openDirectory: '/dev/proj',
      forms: { 'startup-form': { feature_name: 'Feat' } },
      featureProjects: [
        { id: 'dir:/dev/proj', featureName: 'Feat', openDirectory: '/dev/proj', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const result = syncFeatureCreatorProjects(state, '2024-06-01');
    assert.strictEqual(result.featureProjects.length, 1);
    assert.strictEqual(result.featureProjects[0].createdAt, '2024-01-01');
    assert.strictEqual(result.featureProjects[0].updatedAt, '2024-06-01');
  });
});

// ── syncAgentCreatorProjects ─────────────────────────────────────────────────

describe('syncAgentCreatorProjects', () => {
  it('returns state unchanged when no agentName and no openDirectory', () => {
    const state = { forms: { 'startup-form': { goal: 'x' } } };
    const result = syncAgentCreatorProjects(state, '2024-01-01');
    assert.strictEqual(result, state);
  });

  it('upserts agent project from startup form', () => {
    const state = {
      forms: {
        'startup-form': {
          agent_name: 'MyBot',
          target_dir: '/target',
          goal: 'Help users',
          target_user: 'devs',
          runtime_style: 'interactive',
          planned_features: 'shell',
          install_mode: 'system',
        },
      },
      agentProjects: [],
    };
    const result = syncAgentCreatorProjects(state, '2024-06-01');
    assert.strictEqual(result.agentProjects.length, 1);
    assert.strictEqual(result.agentProjects[0].agentName, 'MyBot');
    assert.strictEqual(result.agentProjects[0].targetUser, 'devs');
    assert.strictEqual(result.agentProjects[0].runtimeStyle, 'interactive');
  });

  it('updates existing project by openDirectory', () => {
    const state = {
      openDirectory: '/dev/proj',
      forms: { 'startup-form': { agent_name: 'Bot' } },
      agentProjects: [
        { id: 'dir:/dev/proj', agentName: 'Bot', openDirectory: '/dev/proj', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const result = syncAgentCreatorProjects(state, '2024-06-01');
    assert.strictEqual(result.agentProjects.length, 1);
    assert.strictEqual(result.agentProjects[0].createdAt, '2024-01-01');
    assert.strictEqual(result.agentProjects[0].updatedAt, '2024-06-01');
  });
});

// ── syncFlowAssemblyProjects ─────────────────────────────────────────────────

describe('syncFlowAssemblyProjects', () => {
  it('removes existing assembly-config projects when no assemblyConfigs', () => {
    const state = {
      assemblyConfigs: [],
      agentProjects: [
        { id: 'dir:/a', agentName: 'A', openDirectory: '/a', managedBy: 'assembly-config' },
        { id: 'dir:/b', agentName: 'B', openDirectory: '/b', managedBy: 'manual' },
      ],
    };
    const result = syncFlowAssemblyProjects(state, '2024-06-01');
    assert.strictEqual(result.agentProjects.length, 1);
    assert.strictEqual(result.agentProjects[0].id, 'dir:/b');
  });

  it('creates agent projects from assemblyConfigs', () => {
    const state = {
      assemblyConfigs: [
        { id: 'cfg1', name: 'Agent1', features: ['f1', 'f2'], goal: 'Do stuff' },
      ],
      agentProjects: [],
    };
    const result = syncFlowAssemblyProjects(state, '2024-06-01');
    assert.strictEqual(result.agentProjects.length, 1);
    assert.strictEqual(result.agentProjects[0].agentName, 'Agent1');
    assert.strictEqual(result.agentProjects[0].managedBy, 'assembly-config');
    assert.strictEqual(result.agentProjects[0].plannedFeatures, 'f1\nf2');
    assert.strictEqual(result.agentProjects[0].goal, 'Do stuff');
  });

  it('replaces existing assembly-config projects with new configs', () => {
    const state = {
      assemblyConfigs: [
        { id: 'cfg2', name: 'NewAgent' },
      ],
      agentProjects: [
        { id: 'dir:/old', agentName: 'OldAgent', managedBy: 'assembly-config', updatedAt: '2024-01-01' },
        { id: 'dir:/manual', agentName: 'ManualAgent', managedBy: 'manual' },
      ],
    };
    const result = syncFlowAssemblyProjects(state, '2024-06-01');
    // Old assembly-config project should be removed, new one added
    const assemblyManaged = result.agentProjects.filter((p) => p.managedBy === 'assembly-config');
    assert.strictEqual(assemblyManaged.length, 1);
    assert.strictEqual(assemblyManaged[0].agentName, 'NewAgent');
    // Manual project should be preserved
    const manualProjects = result.agentProjects.filter((p) => p.managedBy !== 'assembly-config');
    assert.strictEqual(manualProjects.length, 1);
    assert.strictEqual(manualProjects[0].agentName, 'ManualAgent');
  });

  it('skips configs without name or id', () => {
    const state = {
      assemblyConfigs: [
        { id: '', name: '' },
        { id: 'cfg2', name: 'ValidAgent' },
      ],
      agentProjects: [],
    };
    const result = syncFlowAssemblyProjects(state, '2024-06-01');
    assert.strictEqual(result.agentProjects.length, 1);
    assert.strictEqual(result.agentProjects[0].agentName, 'ValidAgent');
  });

  it('uses envDir as openDirectory when present', () => {
    const state = {
      assemblyConfigs: [
        { id: 'cfg1', name: 'Agent1', envDir: '/custom/env' },
      ],
      agentProjects: [],
    };
    const result = syncFlowAssemblyProjects(state, '2024-06-01');
    assert.strictEqual(result.agentProjects[0].openDirectory, '/custom/env');
  });

  it('sets runtimeStyle from preset or defaults to assembly', () => {
    const state1 = {
      assemblyConfigs: [{ id: 'c1', name: 'A', preset: 'custom-preset' }],
      agentProjects: [],
    };
    const result1 = syncFlowAssemblyProjects(state1, '2024-06-01');
    assert.strictEqual(result1.agentProjects[0].runtimeStyle, 'custom-preset');

    const state2 = {
      assemblyConfigs: [{ id: 'c1', name: 'A' }],
      agentProjects: [],
    };
    const result2 = syncFlowAssemblyProjects(state2, '2024-06-01');
    assert.strictEqual(result2.agentProjects[0].runtimeStyle, 'assembly');
  });

  it('handles empty/missing state gracefully', () => {
    const result1 = syncFlowAssemblyProjects({}, '2024-06-01');
    assert.ok(Array.isArray(result1.agentProjects));

    const result2 = syncFlowAssemblyProjects(null, '2024-06-01');
    assert.ok(Array.isArray(result2.agentProjects));
  });
});
