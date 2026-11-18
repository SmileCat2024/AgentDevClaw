/**
 * Round-trip tests for the tool `parameters` field through the
 * Claw frontend normalizeHookInspector pipeline（P2 真实 ESM 图路线）.
 *
 * Data flow:
 *   buildHookInspectorSnapshot (framework agent.ts)
 *     → API JSON → normalizeHookInspector (Claw overview-data.js, ESM 命名导出)
 *       → currentHookInspector（session-view-storage owner）
 *         → renderFeatureDetailOverlay (debug-features-hooks.js)
 *
 * The `parameters` field carries the tool's JSON Schema and must survive
 * normalization intact so the feature detail overlay can display it.
 *
 * 装载路线：classic 相只跑仍是 classic 的真实生产源（app-core 提供
 * `createP2BootstrapDebugPanelHost`）；overview-data 已迁 ESM，经
 * `withP2EsmCase` + `c.load` 真实 import，断言直接打在其命名导出上。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

const OVERVIEW_DATA = 'public/src/modules/overview-data.js';

/** classic 相：真实 app-core（KernelState 桥键初值 + debug panel 宿主工厂）。 */
function loadClassicBootstrap(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // i18n 已迁 ESM（P4）：t 桥键由 createFrontendSandbox 自动装载，见 test/helpers/install-i18n.js
  prepareEsmModules(sandbox, APP_CORE_DOMAIN);
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
        skills: [{ name: 'shell-help', description: 'Shell usage', root: 0, path: 'skills/shell-help/SKILL.md' }],
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

/** 一次用例 = 一张独立模块图；返回真实 normalizeHookInspector 的输出。 */
async function normalize(input) {
  return withP2EsmCase({ classic: loadClassicBootstrap }, async (c) => {
    const overviewData = await c.load(OVERVIEW_DATA);
    return overviewData.normalizeHookInspector(input);
  });
}

describe('normalizeHookInspector: parameters and skill resource metadata round-trip', () => {
  it('preserves skill resource metadata and tool parameters through normalization', async () => {
    const input = buildSnapshotWithParameters();
    const output = await normalize(input);

    assert.deepEqual(output.features[0].skills, [{
      name: 'shell-help', description: 'Shell usage', root: 0, path: 'skills/shell-help/SKILL.md',
    }]);
    const tool = output.features[0].tools[0];
    assert.equal(tool.name, 'bash');
    assert.ok(tool.parameters, 'parameters must be preserved');
    assert.deepEqual(tool.parameters, {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command' },
        timeout: { type: 'number', description: 'Timeout in ms' },
      },
      required: ['command'],
    });
  });

  it('drops invalid skill paths that could escape the registered package root', async () => {
    const input = buildSnapshotWithParameters();
    input.features[0].skills.push(
      { name: 'traversal', description: 'bad', root: 0, path: '../secret/SKILL.md' },
      { name: 'absolute', description: 'bad', root: 0, path: '/etc/passwd' },
      { name: 'windows', description: 'bad', root: 0, path: 'C:/Windows/secret' },
    );
    const output = await normalize(input);
    assert.deepEqual(output.features[0].skills, [{
      name: 'shell-help', description: 'Shell usage', root: 0, path: 'skills/shell-help/SKILL.md',
    }]);
  });

  it('preserves undefined parameters gracefully (tool without schema)', async () => {
    const input = buildSnapshotWithParameters();
    const output = await normalize(input);

    const tool = output.features[0].tools[1]; // 'powershell' — no parameters
    assert.equal(tool.name, 'powershell');
    assert.equal(tool.parameters, undefined, 'missing parameters should stay undefined');
  });

  it('preserves parameters on standalone tools', async () => {
    const input = buildSnapshotWithParameters();
    const output = await normalize(input);

    assert.ok(output.standaloneTools, 'standaloneTools must exist');
    assert.equal(output.standaloneTools[0].name, 'custom_tool');
    assert.ok(output.standaloneTools[0].parameters, 'standalone tool parameters preserved');
    assert.deepEqual(output.standaloneTools[0].parameters, {
      type: 'object',
      properties: { input: { type: 'string' } },
    });
  });

  it('preserves other tool fields alongside parameters (no regression)', async () => {
    const input = buildSnapshotWithParameters();
    const output = await normalize(input);

    const tool = output.features[0].tools[0];
    assert.equal(tool.name, 'bash');
    assert.equal(tool.description, 'Run a bash command');
    assert.equal(tool.state, 'enabled');
    assert.equal(tool.enabled, true);
    assert.ok(tool.parameters, 'parameters present alongside other fields');
  });

  it('regression guard: parameters must not be silently stripped', async () => {
    // Before the fix, normalizeHookInspector reconstructed feature objects
    // but tools were passed by reference, so parameters should survive.
    // This test locks that behavior down.
    const input = buildSnapshotWithParameters();
    const output = await normalize(input);

    const hasParameters = output.features[0].tools.some(t => t.parameters);
    assert.ok(hasParameters,
      'at least one tool must retain parameters through normalization');
  });
});
