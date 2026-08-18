/**
 * AgentStudioFeature test (node:test format)
 *
 * Validates:
 * 1. Tool registration (9 tools, names)
 * 2. evaluateToolCalls pure function
 * 3. studio_initialize_project: writes agent-studio.json + registry, sets active project
 * 4. Re-initialize keeps tests/features; explicit empty targetAgent clears the field
 * 5. studio_add_feature: requires existing module file, registers as implemented
 * 6. studio_define_test / studio_list_tests round trip
 * 7. studio_get_project: runtime status not-provisioned without a running runtime
 * 8. studio_run_test without a running runtime throws
 * 9. captureState/restoreState preserves active project directory
 * 10. injectProjectState skips empty-input pre-inject to avoid double injection
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentStudioFeature, evaluateToolCalls } from '../src/index.js';
import type { Tool } from 'agentdev';

async function makeTempWorkspace(): Promise<{ workspaceDir: string; projectDir: string }> {
  const base = await fs.mkdtemp(join(tmpdir(), 'agent-studio-test-'));
  return { workspaceDir: base, projectDir: join(base, 'project') };
}

type ExecFn = (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function bindTools(feature: AgentStudioFeature): ExecFn {
  return async (name, args = {}) => {
    const tool = feature.getTools().find((item: Tool) => item.name === name);
    assert.ok(tool, `tool ${name} not found`);
    return (tool.execute as (a: Record<string, unknown>) => Promise<Record<string, unknown>>)(args);
  };
}

describe('AgentStudioFeature', () => {
  let workspaceDir: string;
  let projectDir: string;
  let exec: ExecFn;

  before(async () => {
    const temp = await makeTempWorkspace();
    workspaceDir = temp.workspaceDir;
    projectDir = temp.projectDir;
    const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });
    exec = bindTools(feature);
  });

  after(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  describe('Tool registration', () => {
    it('should expose exactly 9 tools', () => {
      const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });
      assert.equal(feature.getTools().length, 9);
    });

    it('should have expected tool names', () => {
      const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });
      const names = feature.getTools().map((tool: Tool) => tool.name);
      assert.deepEqual(names.sort(), [
        'studio_add_feature',
        'studio_define_test',
        'studio_get_project',
        'studio_get_run',
        'studio_initialize_project',
        'studio_list_tests',
        'studio_run_test',
        'studio_start_runtime',
        'studio_stop_runtime',
      ]);
    });
  });

  describe('evaluateToolCalls', () => {
    it('matches all expected tools', () => {
      const result = evaluateToolCalls(['a', 'b'], ['a', 'b']);
      assert.deepEqual(result.matchedToolCalls.sort(), ['a', 'b']);
      assert.deepEqual(result.missingToolCalls, []);
    });

    it('reports missing tools', () => {
      const result = evaluateToolCalls(['a'], ['a', 'b', 'c']);
      assert.deepEqual(result.matchedToolCalls, ['a']);
      assert.deepEqual(result.missingToolCalls.sort(), ['b', 'c']);
    });

    it('treats empty expectation as matched', () => {
      const result = evaluateToolCalls(['a'], []);
      assert.deepEqual(result.matchedToolCalls, []);
      assert.deepEqual(result.missingToolCalls, []);
    });
  });

  describe('denied-call evidence semantics', () => {
    it('a denied entry does not count as invoked (filtered before evaluation)', () => {
      // mirrors the run_test call site: evidenceToolNames excludes denied entries
      const toolCalls = [
        { tool: 'budget_status', ok: true, durationMs: 1, at: 't1' },
        { tool: 'budget_spend', ok: false, durationMs: 0, at: 't2', denied: true, error: '预算不足' },
      ];
      const evidenceToolNames = toolCalls.filter((entry) => !(entry as { denied?: boolean }).denied).map((entry) => entry.tool);
      const result = evaluateToolCalls(evidenceToolNames, ['budget_status', 'budget_spend']);
      assert.deepEqual(result.matchedToolCalls, ['budget_status']);
      assert.deepEqual(result.missingToolCalls, ['budget_spend']);
      const deniedToolCalls = [...new Set(toolCalls.filter((entry) => (entry as { denied?: boolean }).denied).map((entry) => entry.tool))];
      assert.deepEqual(deniedToolCalls, ['budget_spend']);
      // self-explaining guidance trigger: missing ∩ denied
      const deniedMissing = result.missingToolCalls.filter((name) => deniedToolCalls.includes(name));
      assert.deepEqual(deniedMissing, ['budget_spend']);
    });
  });

  describe('studio_initialize_project', () => {
    it('writes agent-studio.json, registry entry, and sets active project', async () => {
      const result = await exec('studio_initialize_project', {
        projectDir,
        name: 'demo',
        goal: '测试项目',
        targetAgent: 'release-assistant',
      });
      assert.equal(result.projectDir, projectDir);

      const saved = JSON.parse(await fs.readFile(join(projectDir, 'agent-studio.json'), 'utf8'));
      assert.equal(saved.name, 'demo');
      assert.equal(saved.goal, '测试项目');
      assert.equal(saved.targetAgent, 'release-assistant');
      assert.equal(saved.testRuntime.status, 'not-provisioned');

      const registry = JSON.parse(await fs.readFile(join(workspaceDir, 'projects.json'), 'utf8'));
      assert.equal(registry.length, 1);
      assert.equal(registry[0].projectDir, projectDir);
      assert.equal(registry[0].name, 'demo');
    });

    it('keeps tests/features on re-init and clears targetAgent when passed empty', async () => {
      await fs.mkdir(join(projectDir, 'features', 'demo'), { recursive: true });
      await fs.writeFile(join(projectDir, 'features', 'demo', 'index.mjs'), 'export class DemoFeature {}\n', 'utf8');
      await exec('studio_add_feature', { name: 'demo-feature', modulePath: join(projectDir, 'features', 'demo', 'index.mjs') });
      await exec('studio_define_test', { id: 'smoke', title: '冒烟', input: '你好', expectedToolCalls: ['demo_tool'] });

      await exec('studio_initialize_project', { projectDir, name: 'demo', targetAgent: '' });

      const project = await exec('studio_get_project');
      const saved = project.project as Record<string, unknown>;
      assert.equal(saved.targetAgent, '');
      assert.equal((saved.features as unknown[]).length, 1);
      assert.equal((saved.tests as unknown[]).length, 1);
    });
  });

  describe('studio_add_feature', () => {
    it('rejects a module file that does not exist', async () => {
      await assert.rejects(
        exec('studio_add_feature', { name: 'ghost', modulePath: join(projectDir, 'features', 'ghost', 'index.mjs') }),
        /模块文件不存在/,
      );
    });

    it('registers an existing module as implemented', async () => {
      const result = await exec('studio_add_feature', { name: 'demo-feature', modulePath: 'features/demo/index.mjs' });
      const entry = result.feature as Record<string, unknown>;
      assert.equal(entry.name, 'demo-feature');
      assert.equal(entry.status, 'implemented');
    });
  });

  describe('studio_define_test / studio_list_tests', () => {
    it('round-trips a test definition', async () => {
      const result = await exec('studio_list_tests');
      const tests = result.tests as Array<Record<string, unknown>>;
      const smoke = tests.find((item) => item.id === 'smoke');
      assert.ok(smoke);
      assert.equal(smoke.input, '你好');
      assert.deepEqual(smoke.expectedToolCalls, ['demo_tool']);
    });
  });

  describe('studio_get_project', () => {
    it('reports not-provisioned without a running runtime', async () => {
      const result = await exec('studio_get_project');
      assert.equal(result.runtimeStatus, 'not-provisioned');
      assert.equal(result.runCount, 0);
    });
  });

  describe('studio_run_test', () => {
    it('throws when the Test Runtime is not running', async () => {
      await assert.rejects(
        exec('studio_run_test', { testId: 'smoke' }),
        /Test Runtime 未运行/,
      );
    });
  });

  describe('captureState / restoreState', () => {
    it('preserves the active project directory across state transfer', async () => {
      const original = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });
      await bindTools(original)('studio_initialize_project', { projectDir, name: 'demo' });
      const snapshot = original.captureState();

      const restored = new AgentStudioFeature({ workspaceDir: tmpdir(), statePath: join(tmpdir(), 'nowhere-state.json') });
      restored.restoreState(snapshot);
      const result = await bindTools(restored)('studio_get_project');
      assert.equal(result.projectDir, projectDir);
    });
  });

  describe('injectProjectState (CallStart hook)', () => {
    type AddedMessage = { role: string; content: string };

    function makeCallStart(input: string): { ctx: Parameters<AgentStudioFeature['injectProjectState']>[0]; added: AddedMessage[] } {
      const added: AddedMessage[] = [];
      const ctx = {
        input,
        context: { add: (message: AddedMessage) => { added.push(message); } },
        isFirstCall: true,
        agent: {},
      } as unknown as Parameters<AgentStudioFeature['injectProjectState']>[0];
      return { ctx, added };
    }

    it('skips pre-inject calls with empty input so the first real call injects only once', async () => {
      const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });

      const pre = makeCallStart('');
      await feature.injectProjectState(pre.ctx);
      assert.equal(pre.added.length, 0, 'preInjectCallStart (empty input) must not inject');

      const real = makeCallStart('开始开发');
      await feature.injectProjectState(real.ctx);
      assert.equal(real.added.length, 1, 'real call should inject exactly once');
      assert.equal(real.added[0].role, 'system');
    });
  });
});
