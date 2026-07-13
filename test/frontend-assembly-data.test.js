/**
 * Tests for public/src/modules/assembly-data.js
 *
 * Covers pure functions:
 *   - Session type checks (isAssemblySession, isAssemblySessionRunning)
 *   - Path/name sanitization (sanitizeWorkspacePathFragment, isValid*Name,
 *     normalizeAssemblyDirectoryToken)
 *   - Project key building (buildWorkspaceProjectKey)
 *   - Draft normalization (normalizeAssemblyDraft, getAssemblyDisplayName,
 *     getAssemblyEditorMode)
 *   - Environment state (getAssemblyEnvironmentState, status label/tone)
 *   - Output directory resolution (getFeatureCreatorOutputDirectory,
 *     getAgentCreatorOutputDirectory, getExpectedAssemblyEnvDir)
 *   - Status chip rendering (renderAssemblyStatusChip)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * Assembly-data depends on parseWorkspaceListField from workspace-blocks.js
 * for getAssemblyEnvironmentState. We stub it as a simple comma-splitter.
 */
function loadAssemblyData() {
  const ctx = createFrontendSandbox({
    parseWorkspaceListField: (value) => {
      if (!value) return [];
      return String(value).split(',').map((s) => s.trim()).filter(Boolean);
    },
    getWorkspaceBlockData: () => ({}),
    getWorkspaceSessions: () => [],
    getSavedAssemblyConfigs: () => [],
    canonicalizeAssemblyFeatureSelection: (agent, values) => values,
    normalizeFeatureConfigMap: (c) => c || {},
    featureConfigKeyMatches: () => false,
    normalizeFeatureConfigEntry: (c) => c || {},
  });
  ctx.loadSource('public/src/modules/assembly-data.js');
  return ctx;
}

// ── isAssemblySession ──────────────────────────────────────────────

describe('assembly-data: isAssemblySession', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('returns true when formId is assembly-form', () => {
    assert.equal(fn('isAssemblySession({ formId: "assembly-form" })'), true);
  });

  it('returns false for other formId', () => {
    assert.equal(fn('isAssemblySession({ formId: "startup-form" })'), false);
  });

  it('returns false for null session', () => {
    assert.equal(fn('isAssemblySession(null)'), false);
  });

  it('returns false for session without formId', () => {
    assert.equal(fn('isAssemblySession({})'), false);
  });
});

// ── isAssemblySessionRunning ───────────────────────────────────────

describe('assembly-data: isAssemblySessionRunning', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('returns false for null agent', () => {
    assert.equal(fn('isAssemblySessionRunning(null, { formId: "assembly-form", id: "s1" })'), false);
  });

  it('returns false for non-assembly session', () => {
    assert.equal(fn('isAssemblySessionRunning({}, { formId: "startup-form", id: "s1" })'), false);
  });

  it('returns true when session is active and runtime exists', () => {
    const agent = '{ active_workspace_session_id: "s1", runtime_session_id: "rt-1" }';
    const session = '{ formId: "assembly-form", id: "s1" }';
    assert.equal(fn(`isAssemblySessionRunning(${agent}, ${session})`), true);
  });

  it('returns false when session id does not match active', () => {
    const agent = '{ active_workspace_session_id: "s2", runtime_session_id: "rt-1" }';
    const session = '{ formId: "assembly-form", id: "s1" }';
    assert.equal(fn(`isAssemblySessionRunning(${agent}, ${session})`), false);
  });
});

// ── buildWorkspaceProjectKey ───────────────────────────────────────

describe('assembly-data: buildWorkspaceProjectKey', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('uses openDirectory when present', () => {
    assert.equal(fn('buildWorkspaceProjectKey({ openDirectory: "D:\\\\code" })'), 'dir:d:/code');
  });

  it('lowercases and normalizes backslashes', () => {
    assert.equal(fn('buildWorkspaceProjectKey({ openDirectory: "D:\\\\Code\\\\Test" })'), 'dir:d:/code/test');
  });

  it('uses feature+targetDir when no openDirectory', () => {
    const result = fn('buildWorkspaceProjectKey({ featureName: "MyFeature", targetDir: "D:\\\\out" })');
    assert.equal(result, 'feature:myfeature@d:/out');
  });

  it('uses feature only when no targetDir', () => {
    assert.equal(fn('buildWorkspaceProjectKey({ featureName: "Shell" })'), 'feature:shell');
  });

  it('returns empty string for empty source', () => {
    assert.equal(fn('buildWorkspaceProjectKey({})'), '');
    assert.equal(fn('buildWorkspaceProjectKey()'), '');
  });
});

// ── sanitizeWorkspacePathFragment ──────────────────────────────────

describe('assembly-data: sanitizeWorkspacePathFragment', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('lowercases and replaces special chars with dashes', () => {
    assert.equal(fn('sanitizeWorkspacePathFragment("My Feature@Name")'), 'my-feature-name');
  });

  it('collapses consecutive dashes', () => {
    assert.equal(fn('sanitizeWorkspacePathFragment("a---b")'), 'a-b');
  });

  it('trims leading/trailing dashes', () => {
    assert.equal(fn('sanitizeWorkspacePathFragment("---hello---")'), 'hello');
  });

  it('allows underscores and hyphens', () => {
    assert.equal(fn('sanitizeWorkspacePathFragment("my_feature-name")'), 'my_feature-name');
  });

  it('returns "untitled-feature" for empty/all-special input', () => {
    assert.equal(fn('sanitizeWorkspacePathFragment("")'), 'untitled-feature');
    assert.equal(fn('sanitizeWorkspacePathFragment("@@@")'), 'untitled-feature');
  });

  it('handles null/undefined', () => {
    assert.equal(fn('sanitizeWorkspacePathFragment(null)'), 'untitled-feature');
  });
});

// ── isValidFeatureCreatorName / isValidAgentCreatorName ────────────

describe('assembly-data: name validators', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('accepts valid kebab-case names', () => {
    assert.equal(fn('isValidFeatureCreatorName("my-feature")'), true);
    assert.equal(fn('isValidFeatureCreatorName("shell")'), true);
    assert.equal(fn('isValidAgentCreatorName("my-agent")'), true);
  });

  it('rejects uppercase', () => {
    assert.equal(fn('isValidFeatureCreatorName("MyFeature")'), false);
  });

  it('rejects starting with number', () => {
    assert.equal(fn('isValidFeatureCreatorName("2nd-feature")'), false);
  });

  it('rejects empty', () => {
    assert.equal(fn('isValidFeatureCreatorName("")'), false);
    assert.equal(fn('isValidFeatureCreatorName(null)'), false);
  });

  it('rejects trailing dash', () => {
    assert.equal(fn('isValidFeatureCreatorName("feature-")'), false);
  });

  it('rejects double dash', () => {
    assert.equal(fn('isValidFeatureCreatorName("feature--name")'), false);
  });
});

// ── normalizeAssemblyDirectoryToken ────────────────────────────────

describe('assembly-data: normalizeAssemblyDirectoryToken', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('normalizes slashes', () => {
    assert.equal(fn('normalizeAssemblyDirectoryToken("D:\\\\code\\\\test")'), 'd:/code/test');
  });

  it('lowercases', () => {
    assert.equal(fn('normalizeAssemblyDirectoryToken("D:/Code/Test")'), 'd:/code/test');
  });

  it('collapses multiple slashes', () => {
    assert.equal(fn('normalizeAssemblyDirectoryToken("D:////Code")'), 'd:/code');
  });

  it('trims', () => {
    assert.equal(fn('normalizeAssemblyDirectoryToken("  D:/Code  ")'), 'd:/code');
  });

  it('handles null', () => {
    assert.equal(fn('normalizeAssemblyDirectoryToken(null)'), '');
  });
});

// ── normalizeAssemblyDraft ─────────────────────────────────────────

describe('assembly-data: normalizeAssemblyDraft', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('ensures all string fields default to empty string', () => {
    const result = fn('normalizeAssemblyDraft({})');
    assert.equal(result.assembly_name, '');
    assert.equal(result.display_name, '');
    assert.equal(result.env_dir, '');
    assert.equal(result.env_status, '');
  });

  it('normalizes env_created to "1" or "0"', () => {
    assert.equal(fn('normalizeAssemblyDraft({ env_created: "1" }).env_created'), '1');
    assert.equal(fn('normalizeAssemblyDraft({ env_created: 1 }).env_created'), '1');
    assert.equal(fn('normalizeAssemblyDraft({ env_created: false }).env_created'), '0');
    assert.equal(fn('normalizeAssemblyDraft({}).env_created'), '0');
  });

  it('preserves existing string values', () => {
    const result = fn('normalizeAssemblyDraft({ assembly_name: "test", env_dir: "/path" })');
    assert.equal(result.assembly_name, 'test');
    assert.equal(result.env_dir, '/path');
  });

  it('coerces non-string fields to empty string', () => {
    const result = fn('normalizeAssemblyDraft({ assembly_name: 123 })');
    assert.equal(result.assembly_name, '');
  });
});

// ── getAssemblyDisplayName ─────────────────────────────────────────

describe('assembly-data: getAssemblyDisplayName', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('uses display_name when present', () => {
    assert.equal(fn('getAssemblyDisplayName({ display_name: "My Agent", assembly_name: "agent" })'), 'My Agent');
  });

  it('falls back to assembly_name', () => {
    assert.equal(fn('getAssemblyDisplayName({ assembly_name: "agent" })'), 'agent');
  });

  it('returns empty for empty draft', () => {
    assert.equal(fn('getAssemblyDisplayName({})'), '');
  });
});

// ── getAssemblyEditorMode ──────────────────────────────────────────

describe('assembly-data: getAssemblyEditorMode', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('returns "blank" for empty draft', () => {
    assert.equal(fn('getAssemblyEditorMode({})'), 'blank');
  });

  it('returns "creating" when assembly_name is set but no saved setup', () => {
    assert.equal(fn('getAssemblyEditorMode({ assembly_name: "test" })'), 'creating');
  });

  it('returns "editing-saved" when savedSetupExists and name is set', () => {
    assert.equal(fn('getAssemblyEditorMode({ assembly_name: "test" }, true)'), 'editing-saved');
  });

  it('returns "blank" when name is empty even with savedSetupExists', () => {
    assert.equal(fn('getAssemblyEditorMode({}, true)'), 'blank');
  });
});

// ── getAssemblyEnvironmentState ────────────────────────────────────

describe('assembly-data: getAssemblyEnvironmentState', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('returns missing-name when no assembly name', () => {
    const result = fn('getAssemblyEnvironmentState({})');
    assert.equal(result.status, 'missing-name');
    assert.equal(result.needsConfiguration, true);
  });

  it('returns missing when name set but no env config', () => {
    const result = fn('getAssemblyEnvironmentState({ assembly_name: "test" })');
    assert.equal(result.status, 'missing');
    assert.equal(result.needsConfiguration, true);
    assert.equal(result.isReady, false);
  });

  it('returns ready when env_dir is set', () => {
    const result = fn('getAssemblyEnvironmentState({ assembly_name: "test", env_dir: "~/.agentdev/agent-dev/test" })');
    assert.equal(result.status, 'ready');
    assert.equal(result.isReady, true);
    assert.equal(result.needsConfiguration, false);
  });

  it('returns ready when env_created is "1"', () => {
    const result = fn('getAssemblyEnvironmentState({ assembly_name: "test", env_created: "1" })');
    assert.equal(result.status, 'ready');
  });

  it('detects stale when configured name differs from assembly name', () => {
    const result = fn('getAssemblyEnvironmentState({ assembly_name: "new", env_configured_name: "old", env_dir: "~/.agentdev/agent-dev/old" })');
    assert.equal(result.status, 'stale');
    assert.equal(result.stale, true);
  });

  it('computes expectedDir from assembly name', () => {
    const result = fn('getAssemblyEnvironmentState({ assembly_name: "myagent" })');
    assert.equal(result.expectedDir, '~/.agentdev/agent-dev/myagent');
  });

  it('detects feature stale when selected features differ from configured', () => {
    const result = fn('getAssemblyEnvironmentState({ assembly_name: "test", env_created: "1", selected_features: "shell, audit", env_configured_features: "shell" })');
    assert.equal(result.status, 'stale');
  });
});

// ── getAssemblyEnvironmentStatusLabel ──────────────────────────────

describe('assembly-data: getAssemblyEnvironmentStatusLabel', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('returns label for each known status', () => {
    const statuses = ['missing-name', 'missing', 'stale', 'creating', 'installing', 'starting', 'running', 'ready', 'error'];
    for (const status of statuses) {
      const label = fn(`getAssemblyEnvironmentStatusLabel("${status}")`);
      assert.ok(typeof label === 'string' && label.length > 0, `Expected non-empty label for ${status}`);
    }
  });

  it('returns default label for unknown status', () => {
    const label = fn('getAssemblyEnvironmentStatusLabel("unknown")');
    assert.ok(label.length > 0);
  });
});

// ── getAssemblyEnvironmentStatusTone ───────────────────────────────

describe('assembly-data: getAssemblyEnvironmentStatusTone', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('returns success tone for ready/running', () => {
    assert.equal(fn('getAssemblyEnvironmentStatusTone("ready")'), 'var(--success-color)');
    assert.equal(fn('getAssemblyEnvironmentStatusTone("running")'), 'var(--success-color)');
  });

  it('returns warning tone for transient states', () => {
    assert.equal(fn('getAssemblyEnvironmentStatusTone("creating")'), 'var(--warning-color)');
    assert.equal(fn('getAssemblyEnvironmentStatusTone("installing")'), 'var(--warning-color)');
    assert.equal(fn('getAssemblyEnvironmentStatusTone("starting")'), 'var(--warning-color)');
  });

  it('returns error tone for error/stale', () => {
    assert.equal(fn('getAssemblyEnvironmentStatusTone("error")'), 'var(--error-color)');
    assert.equal(fn('getAssemblyEnvironmentStatusTone("stale")'), 'var(--error-color)');
  });

  it('returns default tone for unknown', () => {
    assert.equal(fn('getAssemblyEnvironmentStatusTone("unknown")'), 'var(--text-secondary)');
  });
});

// ── getExpectedAssemblyEnvDir ──────────────────────────────────────

describe('assembly-data: getExpectedAssemblyEnvDir', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('builds path from name', () => {
    assert.equal(fn('getExpectedAssemblyEnvDir("myagent")'), '~/.agentdev/agent-dev/myagent');
  });

  it('returns empty for empty name', () => {
    assert.equal(fn('getExpectedAssemblyEnvDir("")'), '');
    assert.equal(fn('getExpectedAssemblyEnvDir(null)'), '');
  });

  it('trims input', () => {
    assert.equal(fn('getExpectedAssemblyEnvDir("  agent  ")'), '~/.agentdev/agent-dev/agent');
  });
});

// ── getFeatureCreatorOutputDirectory / getAgentCreatorOutputDirectory ─

describe('assembly-data: output directory resolution', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('returns path for feature-creator', () => {
    const result = fn('getFeatureCreatorOutputDirectory({ id: "feature-creator" }, { feature_name: "my-feat", target_dir: "D:\\\\code" })');
    assert.equal(result, 'D:\\code\\my-feat');
  });

  it('returns empty for non feature-creator agent', () => {
    assert.equal(fn('getFeatureCreatorOutputDirectory({ id: "agent-creator" }, { feature_name: "x" })'), '');
  });

  it('returns empty when missing feature_name', () => {
    assert.equal(fn('getFeatureCreatorOutputDirectory({ id: "feature-creator" }, { target_dir: "D:\\\\code" })'), '');
  });

  it('returns empty when missing target_dir', () => {
    assert.equal(fn('getFeatureCreatorOutputDirectory({ id: "feature-creator" }, { feature_name: "x" })'), '');
  });

  it('strips trailing slashes from parent dir', () => {
    const result = fn('getFeatureCreatorOutputDirectory({ id: "feature-creator" }, { feature_name: "x", target_dir: "D:\\\\code\\\\" })');
    assert.equal(result, 'D:\\code\\x');
  });

  it('returns path for agent-creator', () => {
    const result = fn('getAgentCreatorOutputDirectory({ id: "agent-creator" }, { agent_name: "my-bot", target_dir: "D:\\\\out" })');
    assert.equal(result, 'D:\\out\\my-bot');
  });

  it('returns empty for non agent-creator', () => {
    assert.equal(fn('getAgentCreatorOutputDirectory({ id: "feature-creator" }, { agent_name: "x" })'), '');
  });
});

// ── renderAssemblyStatusChip ───────────────────────────────────────

describe('assembly-data: renderAssemblyStatusChip', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('renders a span with label and tone', () => {
    const html = fn('renderAssemblyStatusChip("Running", "var(--success-color)")');
    assert.ok(html.includes('assembly-status-chip'));
    assert.ok(html.includes('Running'));
    assert.ok(html.includes('var(--success-color)'));
  });

  it('uses default tone when not provided', () => {
    const html = fn('renderAssemblyStatusChip("Label")');
    assert.ok(html.includes('var(--text-secondary)'));
  });

  it('escapes HTML in label', () => {
    const html = fn('renderAssemblyStatusChip("<script>")');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

// ── getAssemblySessionStatus ───────────────────────────────────────

describe('assembly-data: getAssemblySessionStatus', () => {
  const ctx = loadAssemblyData();
  const fn = ctx.run;

  it('returns Running when session is running', () => {
    const agent = '{ active_workspace_session_id: "s1", runtime_session_id: "rt" }';
    const session = '{ formId: "assembly-form", id: "s1" }';
    const result = fn(`getAssemblySessionStatus(${agent}, ${session})`);
    assert.equal(result.tone, 'var(--success-color)');
  });

  it('returns Saved Session when not running', () => {
    const result = fn('getAssemblySessionStatus({}, { formId: "assembly-form", id: "s1" })');
    assert.equal(result.tone, 'var(--text-secondary)');
  });
});
