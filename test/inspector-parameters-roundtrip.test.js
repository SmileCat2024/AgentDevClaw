/**
 * Round-trip tests for the tool `parameters` field through the
 * Claw frontend normalizeHookInspector pipeline.
 *
 * Data flow:
 *   buildHookInspectorSnapshot (framework agent.ts)
 *     → API JSON → normalizeHookInspector (Claw overview-data.js)
 *       → currentHookInspector → renderFeatureDetailOverlay (debug-features-hooks.js)
 *
 * The `parameters` field carries the tool's JSON Schema and must survive
 * normalization intact so the feature detail overlay can display it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadOverviewData() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/overview-data.js');
  return ctx;
}

function buildSnapshotWithParameters() {
  return {
    lifecycleOrder: ['CallStart', 'StepFinish'],
    features: [
      {
        name: 'shell',
        enabled: true,
        status: 'enabled',
        hookCount: 2,
        toolCount: 2,
        enabledToolCount: 2,
        source: 'ShellFeature',
        description: 'Shell execution',
        tools: [
          {
            name: 'bash',
            description: 'Run a bash command',
            state: 'enabled',
            enabled: true,
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The command' },
                timeout: { type: 'number', description: 'Timeout in ms' },
              },
              required: ['command'],
            },
          },
          {
            name: 'powershell',
            description: 'Run PowerShell command',
            state: 'enabled',
            enabled: true,
            // No parameters field — simulates a tool without schema
          },
        ],
      },
    ],
    hooks: [
      {
        lifecycle: 'StepFinish',
        kind: 'decision',
        entries: [],
      },
    ],
    standaloneTools: [
      {
        name: 'custom_tool',
        description: 'A standalone tool',
        state: 'enabled',
        enabled: true,
        source: 'custom-source',
        parameters: {
          type: 'object',
          properties: {
            input: { type: 'string' },
          },
        },
      },
    ],
  };
}

describe('normalizeHookInspector: parameters field round-trip', () => {
  it('preserves parameters on feature tools', () => {
    const ctx = loadOverviewData();
    const input = buildSnapshotWithParameters();
    const output = ctx.run(`normalizeHookInspector(${JSON.stringify(input)})`);

    const tool = output.features[0].tools[0];
    assert.equal(tool.name, 'bash');
    assert.ok(tool.parameters, 'parameters must be preserved');
    assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command' },
        timeout: { type: 'number', description: 'Timeout in ms' },
      },
      required: ['command'],
    });
  });

  it('preserves undefined parameters gracefully (tool without schema)', () => {
    const ctx = loadOverviewData();
    const input = buildSnapshotWithParameters();
    const output = ctx.run(`normalizeHookInspector(${JSON.stringify(input)})`);

    const tool = output.features[0].tools[1]; // 'powershell' — no parameters
    assert.equal(tool.name, 'powershell');
    assert.equal(tool.parameters, undefined, 'missing parameters should stay undefined');
  });

  it('preserves parameters on standalone tools', () => {
    const ctx = loadOverviewData();
    const input = buildSnapshotWithParameters();
    const output = ctx.run(`normalizeHookInspector(${JSON.stringify(input)})`);

    assert.ok(output.standaloneTools, 'standaloneTools must exist');
    assert.equal(output.standaloneTools[0].name, 'custom_tool');
    assert.ok(output.standaloneTools[0].parameters, 'standalone tool parameters preserved');
    assert.deepEqual(JSON.parse(JSON.stringify(output.standaloneTools[0].parameters)), {
      type: 'object',
      properties: { input: { type: 'string' } },
    });
  });

  it('preserves other tool fields alongside parameters (no regression)', () => {
    const ctx = loadOverviewData();
    const input = buildSnapshotWithParameters();
    const output = ctx.run(`normalizeHookInspector(${JSON.stringify(input)})`);

    const tool = output.features[0].tools[0];
    assert.equal(tool.name, 'bash');
    assert.equal(tool.description, 'Run a bash command');
    assert.equal(tool.state, 'enabled');
    assert.equal(tool.enabled, true);
    assert.ok(tool.parameters, 'parameters present alongside other fields');
  });

  it('regression guard: parameters must not be silently stripped', () => {
    // Before the fix, normalizeHookInspector reconstructed feature objects
    // but tools were passed by reference, so parameters should survive.
    // This test locks that behavior down.
    const ctx = loadOverviewData();
    const input = buildSnapshotWithParameters();
    const output = ctx.run(`normalizeHookInspector(${JSON.stringify(input)})`);

    const hasParameters = output.features[0].tools.some(t => t.parameters);
    assert.ok(hasParameters,
      'at least one tool must retain parameters through normalization');
  });
});
