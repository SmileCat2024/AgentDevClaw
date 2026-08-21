/**
 * AgentStudioFeature test (node:test format)
 *
 * Validates:
 * 1. Tool registration (14 tools, names)
 * 2. evaluateAssertions: five assertion kinds, pass/fail semantics
 * 3. computeFeatureCoverage: evidence attribution to features
 * 4. advanceFeatureStatuses: per-feature verified ledger, reload resets verification
 * 5. normalizeAssertion / normalizeTestCase: schema validation with precise errors
 * 6. studio_initialize_project / studio_define_test round trip (assertions schema v2)
 * 7. injectProjectState skips empty-input pre-inject
 * 8. captureState/restoreState preserves active project directory
 * 9. studio_run_test without a running runtime throws
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  AgentStudioFeature,
  evaluateAssertions,
  computeFeatureCoverage,
  advanceFeatureStatuses,
  normalizeAssertion,
  normalizeTestCase,
  type StudioToolCallEvidence,
  type StudioHookEvidence,
  type StudioFeatureEntry,
  type StudioRunRecord,
} from '../src/index.js';
import type { Tool } from '@agentdev/core';

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

const EVIDENCE_TOOL_CALLS: StudioToolCallEvidence[] = [
  { tool: 'ticket_create', feature: 'ticket-board', ok: true, durationMs: 2, at: 't1', result: '{"id":1,"contactEmail":"alice@example.com"}' },
  { tool: 'ticket_create', feature: 'ticket-board', ok: true, durationMs: 1, at: 't2', result: '{"id":2,"contactEmail":"bob@example.com"}' },
  { tool: 'ticket_create', feature: 'ticket-board', ok: false, durationMs: 0, at: 't3', denied: true, error: '当前打开工单 2 张，已达上限 2' },
  { tool: 'ticket_list', feature: 'ticket-board', ok: true, durationMs: 1, at: 't4', result: '{"openCount":2,"tickets":[{"contactEmail":"a***@example.com"}]}' },
];

const EVIDENCE_HOOKS: StudioHookEvidence[] = [
  { feature: 'ticket-policy', method: 'guardQuota', lifecycle: 'ToolUse', kind: 'guard', subject: 'ticket_create', decision: 'deny', durationMs: 1, at: 't3' },
  { feature: 'ticket-policy', method: 'maskEmails', lifecycle: 'ToolResultTransform', kind: 'transform', subject: 'ticket_list', durationMs: 1, at: 't4' },
];

describe('AgentStudioFeature', () => {
  let workspaceDir: string;
  let projectDir: string;
  let exec: ExecFn;

  before(async () => {
    const temp = await makeTempWorkspace();
    workspaceDir = temp.workspaceDir;
    projectDir = temp.projectDir;
    const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json'), agentRegistryPath: join(workspaceDir, 'agent-registry.json') });
    exec = bindTools(feature);
  });

  after(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  describe('Tool registration', () => {
    it('should expose exactly 14 tools', () => {
      const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });
      assert.equal(feature.getTools().length, 14);
    });

    it('should have expected tool names', () => {
      const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });
      const names = feature.getTools().map((tool: Tool) => tool.name);
      assert.deepEqual(names.sort(), [
        'studio_add_feature',
        'studio_create_feature',
        'studio_create_snapshot',
        'studio_define_test',
        'studio_get_project',
        'studio_get_run',
        'studio_initialize_project',
        'studio_list_tests',
        'studio_register_agent',
        'studio_remove_feature',
        'studio_run_test',
        'studio_save_checkpoint',
        'studio_start_runtime',
        'studio_stop_runtime',
      ]);
    });
  });

  describe('evaluateAssertions', () => {
    it('tool-executed: counts non-denied calls only, min count respected', () => {
      const outcomes = evaluateAssertions(
        [
          { kind: 'tool-executed', tool: 'ticket_create', count: 2 },
          { kind: 'tool-executed', tool: 'missing_tool' },
        ],
        { reply: 'ok', toolCalls: EVIDENCE_TOOL_CALLS, hooks: EVIDENCE_HOOKS },
      );
      assert.equal(outcomes[0].ok, true);
      assert.equal(outcomes[0].actual, 2);
      assert.equal(outcomes[1].ok, false);
      assert.equal(outcomes[1].actual, 0);
      assert.ok(outcomes[1].detail?.includes('missing_tool'));
    });

    it('tool-denied: matches denial and reasonIncludes substring', () => {
      const outcomes = evaluateAssertions(
        [
          { kind: 'tool-denied', tool: 'ticket_create', reasonIncludes: '已达上限' },
          { kind: 'tool-denied', tool: 'ticket_create', reasonIncludes: '不存在的理由' },
          { kind: 'tool-denied', tool: 'ticket_list' },
        ],
        { reply: 'ok', toolCalls: EVIDENCE_TOOL_CALLS, hooks: EVIDENCE_HOOKS },
      );
      assert.equal(outcomes[0].ok, true);
      assert.equal(outcomes[1].ok, false);
      assert.equal(outcomes[2].ok, false);
      assert.ok(outcomes[2].detail?.includes('实际执行'));
    });

    it('tool-result-path: last occurrence, nested path, deep equality, nth occurrence', () => {
      const outcomes = evaluateAssertions(
        [
          { kind: 'tool-result-path', tool: 'ticket_list', path: '$.openCount', equals: 2 },
          { kind: 'tool-result-path', tool: 'ticket_list', path: '$.tickets[0].contactEmail', equals: 'a***@example.com' },
          { kind: 'tool-result-path', tool: 'ticket_list', path: '$.openCount', equals: 3 },
          { kind: 'tool-result-path', tool: 'ticket_create', occurrence: 1, path: '$.contactEmail', equals: 'alice@example.com' },
          { kind: 'tool-result-path', tool: 'ticket_create', occurrence: 9, path: '$.id', equals: 1 },
        ],
        { reply: 'ok', toolCalls: EVIDENCE_TOOL_CALLS, hooks: EVIDENCE_HOOKS },
      );
      assert.equal(outcomes[0].ok, true);
      assert.equal(outcomes[1].ok, true);
      assert.equal(outcomes[2].ok, false);
      assert.equal(outcomes[2].actual, 2);
      assert.equal(outcomes[3].ok, true);
      assert.equal(outcomes[4].ok, false);
      assert.ok(outcomes[4].detail?.includes('仅执行'));
    });

    it('tool-result-path: stringified number/boolean expected values are descaled before comparison', () => {
      const outcomes = evaluateAssertions(
        [
          // 模型端把数值/布尔字符串化的常见形态：equals 传 "2" / "true"，实际值为 2 / true
          { kind: 'tool-result-path', tool: 'ticket_list', path: '$.openCount', equals: '2' },
          { kind: 'tool-result-path', tool: 'ticket_list', path: '$.openCount', equals: '3' },
          { kind: 'tool-result-path', tool: 'bool_tool', path: '$.active', equals: 'true' },
          // 反方向：实际值为字符串、期望为 number/boolean 也应反缩放
          { kind: 'tool-result-path', tool: 'obj_tool', path: '$.flag', equals: true },
          // 无法反缩放的普通字符串仍按原值比较
          { kind: 'tool-result-path', tool: 'ticket_list', path: '$.tickets[0].contactEmail', equals: 'a***@example.com' },
          // 实际值为字符串、期望数值但解析不出来 → 仍失败
          { kind: 'tool-result-path', tool: 'obj_tool', path: '$.text', equals: 5 },
        ],
        {
          reply: 'ok',
          toolCalls: [
            ...EVIDENCE_TOOL_CALLS,
            { tool: 'obj_tool', feature: 'f', ok: true, durationMs: 1, at: 't', result: { flag: 'true', text: 'hello' } },
            { tool: 'bool_tool', feature: 'f', ok: true, durationMs: 1, at: 't', result: '{"active":true}' },
          ] as unknown as StudioToolCallEvidence[],
          hooks: [],
        },
      );
      assert.equal(outcomes[0].ok, true);
      assert.ok(outcomes[0].detail?.includes('类型反缩放'));
      assert.equal(outcomes[1].ok, false);
      assert.ok(outcomes[1].detail?.includes('类型 number'));
      assert.equal(outcomes[2].ok, true);
      assert.equal(outcomes[3].ok, true);
      assert.equal(outcomes[4].ok, true);
      assert.equal(outcomes[5].ok, false);
    });

    it('tool-result-path: object results and non-JSON strings', () => {
      const outcomes = evaluateAssertions(
        [
          { kind: 'tool-result-path', tool: 'obj_tool', path: '$.n', equals: 1 },
          { kind: 'tool-result-path', tool: 'text_tool', path: '$.n', equals: 1 },
        ],
        {
          reply: 'ok',
          toolCalls: [
            { tool: 'obj_tool', feature: 'f', ok: true, durationMs: 1, at: 't', result: { n: 1 } },
            { tool: 'text_tool', feature: 'f', ok: true, durationMs: 1, at: 't', result: 'plain text' },
          ] as StudioToolCallEvidence[],
          hooks: [],
        },
      );
      assert.equal(outcomes[0].ok, true);
      assert.equal(outcomes[1].ok, false);
      assert.ok(outcomes[1].detail?.includes('JSON'));
    });

    it('reply-includes: substring presence', () => {
      const outcomes = evaluateAssertions(
        [
          { kind: 'reply-includes', text: 'a***@example.com' },
          { kind: 'reply-includes', text: 'never-appears' },
        ],
        { reply: '共 2 张工单，邮箱已打码为 a***@example.com', toolCalls: EVIDENCE_TOOL_CALLS, hooks: EVIDENCE_HOOKS },
      );
      assert.equal(outcomes[0].ok, true);
      assert.equal(outcomes[1].ok, false);
    });

    it('hook-observed: lifecycle/feature/method/subject filters', () => {
      const outcomes = evaluateAssertions(
        [
          { kind: 'hook-observed', lifecycle: 'ToolUse', feature: 'ticket-policy', method: 'guardQuota' },
          { kind: 'hook-observed', lifecycle: 'ToolResultTransform', subject: 'ticket_list' },
          { kind: 'hook-observed', lifecycle: 'ToolUse', feature: 'ticket-board' },
          { kind: 'hook-observed', lifecycle: 'CallStart' },
        ],
        { reply: 'ok', toolCalls: EVIDENCE_TOOL_CALLS, hooks: EVIDENCE_HOOKS },
      );
      assert.equal(outcomes[0].ok, true);
      assert.equal(outcomes[1].ok, true);
      assert.equal(outcomes[2].ok, false);
      assert.equal(outcomes[3].ok, false);
      assert.ok(outcomes[3].detail?.includes('CallStart'));
    });

    it('empty assertions produce empty outcomes', () => {
      assert.deepEqual(evaluateAssertions([], { toolCalls: [], hooks: [] }), []);
    });
  });

  describe('computeFeatureCoverage', () => {
    it('attributes tools, denied tools, and hooks to owning features', () => {
      const coverage = computeFeatureCoverage(EVIDENCE_TOOL_CALLS, EVIDENCE_HOOKS);
      assert.deepEqual(Object.keys(coverage).sort(), ['ticket-board', 'ticket-policy']);
      assert.deepEqual(coverage['ticket-board'].tools.sort(), ['ticket_create', 'ticket_list']);
      assert.deepEqual(coverage['ticket-board'].deniedTools, ['ticket_create']);
      assert.deepEqual(coverage['ticket-policy'].hooks, ['ToolResultTransform:maskEmails', 'ToolUse:guardQuota']);
      // denied tool belongs to its owning feature (ticket-board), not the guard feature (ticket-policy)
      assert.deepEqual(coverage['ticket-policy'].deniedTools, []);
    });

    it('entries without feature attribution are skipped', () => {
      const coverage = computeFeatureCoverage(
        [{ tool: 'x', ok: true, durationMs: 1, at: 't' }],
        [],
      );
      assert.deepEqual(coverage, {});
    });
  });

  describe('advanceFeatureStatuses', () => {
    const reloadSummary = (action: StudioRunRecord['reloadSummary'][number]['action'], featureName: string) => [{ featureName, action, ok: true }];

    it('passed run verifies only covered features', () => {
      const features: StudioFeatureEntry[] = [
        { name: 'ticket-board', modulePath: 'a.mjs', status: 'mounted' },
        { name: 'ticket-policy', modulePath: 'b.mjs', status: 'mounted' },
      ];
      const coverage = {
        'ticket-board': { tools: ['ticket_list'], hooks: [], deniedTools: [] },
      };
      const next = advanceFeatureStatuses(features, [], coverage, true, 'run-1', 't1');
      assert.equal(next[0].status, 'verified');
      assert.equal(next[0].verification?.lastVerifiedRunId, 'run-1');
      assert.deepEqual(next[0].verification?.coverage.tools, ['ticket_list']);
      assert.equal(next[1].status, 'mounted');
      assert.equal(next[1].verification, undefined);
    });

    it('reload resets verification to mounted; failed run does not verify', () => {
      const features: StudioFeatureEntry[] = [
        { name: 'ticket-board', modulePath: 'a.mjs', status: 'verified', verification: { lastVerifiedRunId: 'run-0', verifiedAt: 't0', coverage: { tools: ['x'], hooks: [], deniedTools: [] } } },
      ];
      const reloaded = advanceFeatureStatuses(features, reloadSummary('reloaded', 'ticket-board'), { 'ticket-board': { tools: ['x'], hooks: [], deniedTools: [] } }, true, 'run-2', 't2');
      // reload 后即使本次 passed 也会重新验证（新账本）
      assert.equal(reloaded[0].status, 'verified');
      assert.equal(reloaded[0].verification?.lastVerifiedRunId, 'run-2');

      const failed = advanceFeatureStatuses(features, reloadSummary('reloaded', 'ticket-board'), { 'ticket-board': { tools: ['x'], hooks: [], deniedTools: [] } }, false, 'run-3', 't3');
      assert.equal(failed[0].status, 'mounted');
      assert.equal(failed[0].verification, undefined);

      const revertedOnly = advanceFeatureStatuses(features, reloadSummary('reloaded', 'ticket-board'), {}, null, 'run-4', 't4');
      assert.equal(revertedOnly[0].status, 'mounted');
      assert.equal(revertedOnly[0].verification, undefined);
    });

    it('unchanged features keep verified status', () => {
      const features: StudioFeatureEntry[] = [
        { name: 'ticket-board', modulePath: 'a.mjs', status: 'verified', verification: { lastVerifiedRunId: 'run-0', verifiedAt: 't0', coverage: { tools: [], hooks: ['ToolUse:g'], deniedTools: [] } } },
      ];
      const next = advanceFeatureStatuses(features, reloadSummary('unchanged', 'ticket-board'), {}, null, 'run-5', 't5');
      assert.equal(next[0].status, 'verified');
      assert.equal(next[0].verification?.lastVerifiedRunId, 'run-0');
    });

    it('library feature without direct evidence is transitively verified via dependent (chained)', () => {
      // audit-scanner 依赖 audit-core，audit-core 又依赖 base-utils：纯库型链
      const features: StudioFeatureEntry[] = [
        { name: 'audit-scanner', modulePath: 'a.mjs', status: 'mounted', staticInject: ['audit-core'] },
        { name: 'audit-core', modulePath: 'b.mjs', status: 'mounted', staticInject: ['base-utils'] },
        { name: 'base-utils', modulePath: 'c.mjs', status: 'mounted' },
      ];
      const coverage = {
        'audit-scanner': { tools: ['audit_scan'], hooks: [], deniedTools: [] },
      };
      const next = advanceFeatureStatuses(features, [], coverage, true, 'run-6', 't6', {
        'audit-scanner': 'rev-s',
        'audit-core': 'rev-c',
        'base-utils': 'rev-u',
      });
      assert.equal(next[0].status, 'verified');
      assert.equal(next[0].verification?.transitiveVia, undefined);
      // 库型无直接证据 → 凭依赖方传递推进，账本标注来源
      assert.equal(next[1].status, 'verified');
      assert.deepEqual(next[1].verification?.transitiveVia, ['audit-scanner']);
      assert.equal(next[1].verification?.sourceDigest, 'rev-c');
      // 链式传播到不动点：base-utils 也随传递链推进
      assert.equal(next[2].status, 'verified');
      assert.deepEqual(next[2].verification?.transitiveVia, ['audit-core']);
    });

    it('transitive verification does not fire when run failed or no dependent verified', () => {
      const features: StudioFeatureEntry[] = [
        { name: 'scanner', modulePath: 'a.mjs', status: 'mounted', staticInject: ['core'] },
        { name: 'core', modulePath: 'b.mjs', status: 'mounted' },
        { name: 'lonely-lib', modulePath: 'c.mjs', status: 'mounted' },
      ];
      const failed = advanceFeatureStatuses(features, [], { scanner: { tools: ['s'], hooks: [], deniedTools: [] } }, false, 'run-7', 't7');
      assert.equal(failed[1].status, 'mounted');
      // 无依赖方的库型 Feature 即使整体 passed 也不推进
      const noDep = advanceFeatureStatuses(features, [], { scanner: { tools: ['s'], hooks: [], deniedTools: [] } }, true, 'run-8', 't8');
      assert.equal(noDep[1].status, 'verified');
      assert.equal(noDep[2].status, 'mounted');
      // 依赖方未 verified（仅 mounted）时不传递
      const idleDep = advanceFeatureStatuses(
        [{ name: 'scanner', modulePath: 'a.mjs', status: 'mounted', staticInject: ['core'] }, { name: 'core', modulePath: 'b.mjs', status: 'mounted' }],
        [], {}, null, 'run-9', 't9',
      );
      assert.equal(idleDep[1].status, 'mounted');
    });
  });

  describe('normalizeAssertion', () => {
    it('rejects unknown kind with the full valid list', () => {
      assert.throws(() => normalizeAssertion({ kind: 'magic' }), /tool-executed/);
    });

    it('requires tool for tool-* kinds', () => {
      assert.throws(() => normalizeAssertion({ kind: 'tool-executed' }), /tool 字段/);
      assert.throws(() => normalizeAssertion({ kind: 'tool-denied' }), /tool 字段/);
    });

    it('validates path shape and requires equals', () => {
      assert.throws(() => normalizeAssertion({ kind: 'tool-result-path', tool: 'x', path: 'openCount' }), /\$/);
      assert.throws(() => normalizeAssertion({ kind: 'tool-result-path', tool: 'x', path: '$.a' }), /equals/);
      const ok = normalizeAssertion({ kind: 'tool-result-path', tool: 'x', path: '$.a', equals: 1, occurrence: 2 });
      assert.equal(ok.path, '$.a');
      assert.equal(ok.equals, 1);
      assert.equal(ok.occurrence, 2);
    });

    it('requires text / lifecycle for their kinds', () => {
      assert.throws(() => normalizeAssertion({ kind: 'reply-includes' }), /text/);
      assert.throws(() => normalizeAssertion({ kind: 'hook-observed' }), /lifecycle/);
    });

    it('strips fields not relevant to the kind', () => {
      const assertion = normalizeAssertion({ kind: 'tool-executed', tool: 'x', count: 2, text: 'ignored', lifecycle: 'ignored' });
      assert.equal(assertion.text, undefined);
      assert.equal(assertion.lifecycle, undefined);
    });
  });

  describe('normalizeTestCase', () => {
    it('defaults to fresh policy and validates checkpointed requirement', () => {
      const test = normalizeTestCase({ id: 'a', title: 't', input: 'i', assertions: [] });
      assert.equal(test?.sessionPolicy, 'fresh');
      assert.equal(test?.assertions.length, 0);
      // checkpointed without checkpoint is rejected
      assert.equal(normalizeTestCase({ id: 'a', title: 't', input: 'i', sessionPolicy: 'checkpointed', assertions: [] }), null);
      const cp = normalizeTestCase({ id: 'a', title: 't', input: 'i', sessionPolicy: 'checkpointed', checkpoint: 'base', assertions: [] });
      assert.equal(cp?.checkpoint, 'base');
    });

    it('normalizes assertions through normalizeAssertion', () => {
      const test = normalizeTestCase({
        id: 'a', title: 't', input: 'i',
        assertions: [{ kind: 'tool-executed', tool: 'x', count: 2 }],
      });
      assert.deepEqual(test?.assertions, [{ kind: 'tool-executed', tool: 'x', count: 2 }]);
      assert.throws(() => normalizeTestCase({ id: 'a', title: 't', input: 'i', assertions: [{ kind: 'bad' }] } as never));
    });
  });

  describe('studio_initialize_project / studio_define_test', () => {
    it('writes project, defines a test with assertions, round-trips via list', async () => {
      await exec('studio_initialize_project', { projectDir, name: 'demo', goal: '演示' });
      const defined = await exec('studio_define_test', {
        id: 'allow-create',
        title: '创建工单',
        input: '创建一张工单',
        sessionPolicy: 'stateful',
        assertions: [
          { kind: 'tool-executed', tool: 'ticket_create', count: 1 },
          { kind: 'tool-result-path', tool: 'ticket_list', path: '$.openCount', equals: 1 },
        ],
      });
      assert.equal((defined as { testCount: number }).testCount, 1);

      const listed = await exec('studio_list_tests');
      const tests = (listed as { tests: Array<{ id: string; sessionPolicy: string; assertions: unknown[] }> }).tests;
      assert.equal(tests[0].id, 'allow-create');
      assert.equal(tests[0].sessionPolicy, 'stateful');
      assert.equal(tests[0].assertions.length, 2);

      const project = await exec('studio_get_project');
      assert.equal((project as { project: { schemaVersion: number } }).project.schemaVersion, 3);
    });

    it('re-initialize keeps tests and features', async () => {
      await exec('studio_initialize_project', { projectDir, name: 'demo-2' });
      const listed = await exec('studio_list_tests');
      assert.equal((listed as { tests: unknown[] }).tests.length, 1);
    });

    it('normalizes legacy schema as schema 3 without losing module registration', async () => {
      const legacyDir = join(workspaceDir, 'legacy-project');
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.writeFile(join(legacyDir, 'legacy.mjs'), 'export default class { name = "legacy"; getTools() { return []; } }\n');
      await fs.writeFile(join(legacyDir, 'agent-studio.json'), JSON.stringify({
        schemaVersion: 2,
        name: 'legacy',
        goal: '',
        targetAgent: '',
        features: [{ name: 'legacy', modulePath: join(legacyDir, 'legacy.mjs'), status: 'implemented' }],
        testRuntime: { status: 'stopped' },
        tests: [],
        createdAt: 't',
        updatedAt: 't',
      }));
      await exec('studio_initialize_project', { projectDir: legacyDir, name: 'legacy' });
      const loaded = await exec('studio_get_project');
      const project = (loaded as { project: { schemaVersion: number; features: Array<{ name: string; modulePath: string }> } }).project;
      assert.equal(project.schemaVersion, 3);
      assert.equal(project.features[0].name, 'legacy');
      assert.equal(project.features[0].modulePath, join(legacyDir, 'legacy.mjs'));
    });

    it('rejects a nonstandard persisted build command before it reaches a shell', async () => {
      const invalidDir = join(workspaceDir, 'invalid-build-project');
      await fs.mkdir(invalidDir, { recursive: true });
      await fs.writeFile(join(invalidDir, 'agent-studio.json'), JSON.stringify({
        schemaVersion: 3, name: 'invalid', goal: '', targetAgent: '',
        features: [{ name: 'bad', modulePath: join(invalidDir, 'bad.mjs'), source: { kind: 'project', projectDir: invalidDir, entry: join(invalidDir, 'bad.mjs'), buildCommand: ['npm', 'run', 'build; malicious'] }, status: 'implemented' }],
        testRuntime: { status: 'stopped' }, tests: [], createdAt: 't', updatedAt: 't',
      }));
      await fs.writeFile(join(invalidDir, 'bad.mjs'), 'export default class { name = "bad"; }\\n');
      await exec('studio_initialize_project', { projectDir: invalidDir, name: 'invalid' });
      await assert.rejects(() => exec('studio_start_runtime'), /仅支持 buildCommand/);
    });

    it('registers a standard Feature project through projectDir', async () => {
      const featureDir = join(projectDir, 'features', 'ticket-feature');
      await fs.mkdir(join(featureDir, 'dist'), { recursive: true });
      await fs.writeFile(join(featureDir, 'package.json'), JSON.stringify({
        name: '@agentdev/ticket-feature',
        main: 'dist/index.js',
      }));
      await fs.writeFile(join(featureDir, 'dist', 'index.js'), 'export default class { name = "ticket-feature"; getTools() { return []; } }\n');
      await exec('studio_initialize_project', { projectDir, name: 'standard-project' });
      const registered = await exec('studio_add_feature', { projectDir: './features/ticket-feature' });
      const feature = (registered as { feature: { name: string; package?: string; modulePath: string; source?: { kind: string } } }).feature;
      assert.equal(feature.name, 'ticket-feature');
      assert.equal(feature.package, '@agentdev/ticket-feature');
      assert.equal(feature.modulePath, join(featureDir, 'dist', 'index.js'));
      assert.equal(feature.source?.kind, 'project');
    });

    it('registers a standalone Agent definition without changing its source', async () => {
      const agentDir = join(projectDir, 'agent-under-test');
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(join(agentDir, 'metadata.json'), JSON.stringify({
        id: 'debug-agent', entry: './agent.js', deployment: { kind: 'standalone' }, features: [],
      }));
      await fs.writeFile(join(agentDir, 'agent.js'), 'export default class DebugAgent {}\\n');
      await exec('studio_initialize_project', { projectDir, name: 'debug-project' });
      const result = await exec('studio_register_agent', { agentDir: './agent-under-test' });
      assert.equal((result as { agentId: string }).agentId, 'debug-agent');
      // 全局注册收口：claw run 消费的注册表同步生成记录
      const globalRegistration = (result as { globalRegistration?: { ok: boolean; id?: string } }).globalRegistration;
      assert.equal(globalRegistration?.ok, true);
      assert.equal(globalRegistration?.id, 'debug-agent');
      const registryRaw = JSON.parse(await fs.readFile(join(workspaceDir, 'agent-registry.json'), 'utf8')) as { agents: Array<{ id: string; studioProjectDir?: string }> };
      const record = registryRaw.agents.find((entry) => entry.id === 'debug-agent');
      assert.ok(record, 'global registry contains debug-agent');
      assert.equal(record?.studioProjectDir, projectDir);
      const loaded = await exec('studio_get_project');
      assert.equal((loaded as { project: { agent?: { metadataPath: string } } }).project.agent?.metadataPath, join(agentDir, 'metadata.json'));
    });

    it('reports global registration failure without blocking project-level registration', async () => {
      const agentDir = join(projectDir, 'builtin-id-agent');
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(join(agentDir, 'metadata.json'), JSON.stringify({
        id: 'coder', entry: './agent.js', deployment: { kind: 'standalone' }, features: [],
      }));
      await fs.writeFile(join(agentDir, 'agent.js'), 'export default class Coder {}\\n');
      await exec('studio_initialize_project', { projectDir, name: 'builtin-id-project' });
      const result = await exec('studio_register_agent', { agentDir: './builtin-id-agent' });
      // 项目内登记不受影响
      assert.equal((result as { agentId: string }).agentId, 'coder');
      // 全局注册显式失败并给出指引（ID 与内建 plain Agent 冲突）
      const globalRegistration = (result as { globalRegistration?: { ok: boolean; error?: string; hint?: string } }).globalRegistration;
      assert.equal(globalRegistration?.ok, false);
      assert.ok(globalRegistration?.error?.includes('冲突'), `conflict error surfaced: ${globalRegistration?.error}`);
      assert.ok(globalRegistration?.hint?.includes('claw run'));
    });

    it('rejects built-in metadata before attempting an agent-debug runtime', async () => {
      const agentDir = join(projectDir, 'built-in-agent');
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(join(agentDir, 'metadata.json'), JSON.stringify({
        id: 'built-in-agent', entry: './agent.js', features: ['todo'],
      }));
      await fs.writeFile(join(agentDir, 'agent.js'), 'export default class BuiltInAgent {}\\n');
      await exec('studio_initialize_project', { projectDir, name: 'built-in-project' });

      await assert.rejects(
        () => exec('studio_register_agent', { agentDir: './built-in-agent' }),
        /仅支持 standalone metadata 驱动装配.*built-in \/ prebuilt Agent/s,
      );
    });

    it('rejects invalid assertion definitions with precise errors', async () => {
      await assert.rejects(
        () => exec('studio_define_test', {
          id: 'bad', title: 't', input: 'i',
          assertions: [{ kind: 'tool-result-path', tool: 'x', path: 'no-dollar' }],
        }),
        /path/,
      );
    });

    it('studio_run_test without a running runtime throws', async () => {
      await assert.rejects(
        () => exec('studio_run_test', { testId: 'allow-create' }),
        /studio_start_runtime/,
      );
    });
  });

  describe('state and injection', () => {
    it('captureState/restoreState preserves active project directory', async () => {
      const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });
      await exec('studio_initialize_project', { projectDir, name: 'demo' });
      // simulate the feature having an active project
      const captured = { activeProjectDir: projectDir };
      feature.restoreState(captured);
      const project = await exec('studio_get_project');
      assert.equal((project as { projectDir: string }).projectDir, projectDir);
      assert.deepEqual(feature.captureState(), captured);
    });

    it('injectProjectState skips empty-input pre-inject to avoid double injection', async () => {
      const feature = new AgentStudioFeature({ workspaceDir, statePath: join(workspaceDir, 'state.json') });
      const added: Array<{ role: string; content: string }> = [];
      const fakeContext = { add: (entry: { role: string; content: string }) => { added.push(entry); } };
      await feature.injectProjectState({ input: '', context: fakeContext } as never);
      assert.equal(added.length, 0);
      await feature.injectProjectState({ input: '创建工单', context: fakeContext } as never);
      assert.equal(added.length, 1);
      assert.ok(added[0].content.includes('Agent Studio 项目状态'));
    });
  });
});
