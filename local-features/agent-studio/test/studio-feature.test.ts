/**
 * AgentStudioFeature test (node:test format)
 *
 * Validates:
 * 1. Tool registration (15 tools, names)
 * 2. evaluateAssertions: five assertion kinds, pass/fail semantics
 * 3. computeFeatureCoverage: evidence attribution to features
 * 4. advanceFeatureStatuses: per-feature verified ledger, reload resets verification
 * 5. normalizeAssertion / normalizeTestCase: schema validation with precise errors
 * 6. Directory manifest (schema 5) + global feature registry round trips
 * 7. Legacy schema ≤ 4 lazy migration: features go to the registry, manifest upgrades in place
 * 8. Session binding backoff: skipped without session identity, error surfaced on unreachable server
 * 9. injectProjectState skips empty-input pre-inject
 * 10. captureState/restoreState preserves active directory
 * 11. studio_run_test without a running runtime throws
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
  readFeatureRegistry,
  type StudioToolCallEvidence,
  type StudioHookEvidence,
  type StudioFeatureEntry,
  type StudioRunRecord,
} from '../src/index.js';
import type { Tool } from '@agentdevjs/core';

async function makeTempWorkspace(): Promise<{ workspaceDir: string; statePath: string; studioDir: string; agentRegistryPath: string }> {
  const base = await fs.mkdtemp(join(tmpdir(), 'agent-studio-test-'));
  return {
    workspaceDir: base,
    statePath: join(base, 'state.json'),
    studioDir: join(base, 'studio'),
    agentRegistryPath: join(base, 'agent-registry.json'),
  };
}

type ExecFn = (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function bindTools(feature: AgentStudioFeature): ExecFn {
  return async (name, args = {}) => {
    const tool = feature.getTools().find((item: Tool) => item.name === name);
    assert.ok(tool, `tool ${name} not found`);
    return (tool.execute as (a: Record<string, unknown>) => Promise<Record<string, unknown>>)(args);
  };
}

/** 在指定目录上构造 feature（共享同一 statePath → 同一全局注册表），返回工具执行器。 */
function execAt(env: { workspaceDir: string; statePath: string; agentRegistryPath: string }, dir: string): ExecFn {
  return bindTools(new AgentStudioFeature({
    workspaceDir: dir,
    statePath: env.statePath,
    agentRegistryPath: env.agentRegistryPath,
  }));
}

/** 直接落盘一份 schema 5 目录清单（工具路径之外的测试基线）。 */
async function writeManifest(dir: string, patch: Record<string, unknown> = {}): Promise<void> {
  const manifest = {
    schemaVersion: 5,
    targetAgent: '',
    testRuntime: { status: 'not-provisioned' },
    tests: [],
    createdAt: 't0',
    updatedAt: 't0',
    ...patch,
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'agent-studio.json'), JSON.stringify(manifest));
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
  let statePath: string;
  let studioDir: string;
  let agentRegistryPath: string;

  before(async () => {
    const temp = await makeTempWorkspace();
    workspaceDir = temp.workspaceDir;
    statePath = temp.statePath;
    studioDir = temp.studioDir;
    agentRegistryPath = temp.agentRegistryPath;
  });

  after(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  describe('Tool registration', () => {
    it('should expose exactly 15 tools', () => {
      const feature = new AgentStudioFeature({ workspaceDir: studioDir, statePath });
      assert.equal(feature.getTools().length, 15);
    });

    it('requires Feature metadata parameters for the Claw Manifest v2', () => {
      const feature = new AgentStudioFeature({ workspaceDir: studioDir, statePath });
      const createTool = feature.getTools().find((tool: Tool) => tool.name === 'studio_create_feature') as Tool & {
        parameters: { required?: string[] };
      };
      assert.ok(createTool.parameters.required?.includes('displayNameZh'));
      assert.ok(createTool.parameters.required?.includes('capabilities'));
      assert.ok(createTool.parameters.required?.includes('provides'));
      assert.ok(createTool.parameters.required?.includes('requirements'));
      assert.ok(createTool.parameters.required?.includes('rollback'));
    });

    it('should have expected tool names', () => {
      const feature = new AgentStudioFeature({ workspaceDir: studioDir, statePath });
      const names = feature.getTools().map((tool: Tool) => tool.name);
      assert.deepEqual(names.sort(), [
        'studio_add_feature',
        'studio_create_feature',
        'studio_create_snapshot',
        'studio_define_test',
        'studio_detect_environment',
        'studio_get_directory',
        'studio_get_run',
        'studio_list_tests',
        'studio_register_agent',
        'studio_remove_feature',
        'studio_run_test',
        'studio_save_checkpoint',
        'studio_select_toolchain',
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

  describe('directory manifest and feature registry', () => {
    it('studio_define_test writes into the directory manifest and round-trips via list', async () => {
      await writeManifest(studioDir, {
        toolchain: { source: 'custom', nodePath: '/tools/node', npmPath: '/tools/npm' },
      });
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, studioDir);
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

      const loaded = await exec('studio_get_directory');
      const manifest = (loaded as { manifest: { schemaVersion: number; toolchain?: unknown } }).manifest;
      assert.equal(manifest.schemaVersion, 5);
      assert.deepEqual(manifest.toolchain, { source: 'custom', nodePath: '/tools/node', npmPath: '/tools/npm' });
    });

    it('defining another test grows the manifest without losing existing ones', async () => {
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, studioDir);
      await exec('studio_define_test', { id: 'list-open', title: '列出工单', input: '列出工单' });
      const listed = await exec('studio_list_tests');
      assert.equal((listed as { tests: unknown[] }).tests.length, 2);
    });

    it('lazily migrates a legacy manifest: features go to the global registry, manifest upgrades to schema 5 in place', async () => {
      const legacyDir = join(workspaceDir, 'legacy-dir');
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
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, legacyDir);
      const loaded = await exec('studio_get_directory');
      const manifest = (loaded as { manifest: { schemaVersion: number } }).manifest;
      assert.equal(manifest.schemaVersion, 5);
      const features = (loaded as { features: Array<{ name: string; modulePath: string }> }).features;
      assert.equal(features[0].name, 'legacy');
      assert.equal(features[0].modulePath, join(legacyDir, 'legacy.mjs'));
      // 档案就地升级：磁盘上不再有 features[]/name/goal
      const onDisk = JSON.parse(await fs.readFile(join(legacyDir, 'agent-studio.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(onDisk.schemaVersion, 5);
      assert.equal('features' in onDisk, false);
      assert.equal('name' in onDisk, false);
      assert.equal('goal' in onDisk, false);
      // feature 记账进入全局注册表（id = 无包名时用 feature 名）
      const records = await readFeatureRegistry(statePath);
      const record = records.find((item) => item.id === 'legacy');
      assert.ok(record, 'global registry contains legacy feature');
      assert.equal(record.directory, legacyDir);
    });

    it('rejects a nonstandard persisted build command before it reaches a shell', async () => {
      const invalidDir = join(workspaceDir, 'invalid-build-dir');
      await fs.mkdir(invalidDir, { recursive: true });
      await fs.writeFile(join(invalidDir, 'agent-studio.json'), JSON.stringify({
        schemaVersion: 3, name: 'invalid', goal: '', targetAgent: '',
        features: [{ name: 'bad', modulePath: join(invalidDir, 'bad.mjs'), source: { kind: 'project', projectDir: invalidDir, entry: join(invalidDir, 'bad.mjs'), buildCommand: ['npm', 'run', 'build; malicious'] }, status: 'implemented' }],
        testRuntime: { status: 'stopped' }, tests: [], createdAt: 't', updatedAt: 't',
      }));
      await fs.writeFile(join(invalidDir, 'bad.mjs'), 'export default class { name = "bad"; }\n');
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, invalidDir);
      await exec('studio_get_directory'); // 触发懒迁移：bad 进注册表
      await assert.rejects(() => exec('studio_start_runtime'), /仅支持 buildCommand/);
    });

    it('registers a standard Feature project via featureProjectDir and records it in the global registry', async () => {
      const featureDir = join(studioDir, 'features', 'ticket-feature');
      await fs.mkdir(join(featureDir, 'dist'), { recursive: true });
      await fs.writeFile(join(featureDir, 'package.json'), JSON.stringify({
        name: '@agentdevjs/ticket-feature',
        main: 'dist/index.js',
        description: '工单看板演示 Feature',
      }));
      await fs.writeFile(join(featureDir, 'dist', 'index.js'), 'export default class { name = "ticket-feature"; getTools() { return []; } }\n');
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, studioDir);
      const registered = await exec('studio_add_feature', { featureProjectDir: './features/ticket-feature' });
      const feature = (registered as { feature: { name: string; package?: string; modulePath: string; description: string; source?: { kind: string } } }).feature;
      assert.equal(feature.name, 'ticket-feature');
      assert.equal(feature.package, '@agentdevjs/ticket-feature');
      assert.equal(feature.description, '工单看板演示 Feature');
      assert.equal(feature.modulePath, join(featureDir, 'dist', 'index.js'));
      assert.equal(feature.source?.kind, 'project');
      // 全局注册表按包名记账
      const records = await readFeatureRegistry(statePath);
      const record = records.find((item) => item.id === '@agentdevjs/ticket-feature');
      assert.ok(record, 'registry keyed by package name');
      assert.equal(record.directory, studioDir);
      // 测试环境没有会话身份：绑定回写显式 skipped，不静默吞掉
      const sessionBinding = (registered as { sessionBinding: { ok: boolean; skipped?: boolean } }).sessionBinding;
      assert.equal(sessionBinding.ok, false);
      assert.equal(sessionBinding.skipped, true);
    });

    it('re-registering the same package at a new directory moves it and preserves the ledger', async () => {
      const featureDir = join(studioDir, 'features', 'ticket-feature');
      // 预置账本：verified + 验证证据
      const records = await readFeatureRegistry(statePath);
      const seeded = records.map((record) => record.id === '@agentdevjs/ticket-feature'
        ? {
            ...record,
            status: 'verified' as const,
            verification: { lastVerifiedRunId: 'run-x', verifiedAt: 'tx', coverage: { tools: ['ticket_list'], hooks: [], deniedTools: [] } },
          }
        : record);
      const { writeFeatureRegistry } = await import('../src/index.js');
      await writeFeatureRegistry(statePath, seeded);

      const movedDir = join(workspaceDir, 'moved-dir');
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, movedDir);
      const registered = await exec('studio_add_feature', { featureProjectDir: featureDir });
      const feature = (registered as { feature: { directory: string; status: string; verification?: { lastVerifiedRunId: string } } }).feature;
      assert.equal(feature.directory, movedDir);
      assert.equal(feature.status, 'verified');
      assert.equal(feature.verification?.lastVerifiedRunId, 'run-x');
    });

    it('registers a standalone Agent definition without changing its source', async () => {
      const agentDir = join(studioDir, 'agent-under-test');
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(join(agentDir, 'metadata.json'), JSON.stringify({
        id: 'debug-agent', entry: './agent.js', deployment: { kind: 'standalone' }, features: [],
      }));
      await fs.writeFile(join(agentDir, 'agent.js'), 'export default class DebugAgent {}\n');
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, studioDir);
      const result = await exec('studio_register_agent', { agentDir: './agent-under-test' });
      assert.equal((result as { agentId: string }).agentId, 'debug-agent');
      // 全局注册收口：claw run 消费的注册表同步生成记录
      const globalRegistration = (result as { globalRegistration?: { ok: boolean; id?: string } }).globalRegistration;
      assert.equal(globalRegistration?.ok, true);
      assert.equal(globalRegistration?.id, 'debug-agent');
      const registryRaw = JSON.parse(await fs.readFile(agentRegistryPath, 'utf8')) as { agents: Array<{ id: string; studioProjectDir?: string }> };
      const record = registryRaw.agents.find((entry) => entry.id === 'debug-agent');
      assert.ok(record, 'global registry contains debug-agent');
      assert.equal(record?.studioProjectDir, studioDir);
      const loaded = await exec('studio_get_directory');
      assert.equal((loaded as { manifest: { agent?: { metadataPath: string } } }).manifest.agent?.metadataPath, join(agentDir, 'metadata.json'));
    });

    it('reports global registration failure without blocking directory-level registration', async () => {
      // 内建 plain Agent 冲突判定 = PROJECT_ROOT/agents/<id>/agent.js 存在（server/feature-runtime/agent-registry.js）。
      // 与 test/feature-runtime.test.js 同一规范：用临时内建目录验证，不依赖任何具体内建 agent 存在。
      // 用 process.cwd() 定位仓库根：test:features 与 node --test 均在仓库根运行，绕开 src/dist 编译深度的差异。
      const builtinId = 'agent-studio-test-conflict';
      const builtinDir = join(process.cwd(), 'agents', builtinId);
      await fs.mkdir(builtinDir, { recursive: true });
      try {
        await fs.writeFile(join(builtinDir, 'agent.js'), 'export default class BuiltinConflict {}\n');

        const agentDir = join(studioDir, 'builtin-id-agent');
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(join(agentDir, 'metadata.json'), JSON.stringify({
          id: builtinId, entry: './agent.js', deployment: { kind: 'standalone' }, features: [],
        }));
        await fs.writeFile(join(agentDir, 'agent.js'), 'export default class Coder {}\n');
        const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, studioDir);
        const result = await exec('studio_register_agent', { agentDir: './builtin-id-agent' });
        // 目录内登记不受影响
        assert.equal((result as { agentId: string }).agentId, builtinId);
        // 全局注册显式失败并给出指引（ID 与内建 plain Agent 冲突）
        const globalRegistration = (result as { globalRegistration?: { ok: boolean; error?: string; hint?: string } }).globalRegistration;
        assert.equal(globalRegistration?.ok, false);
        assert.ok(globalRegistration?.error?.includes('冲突'), `conflict error surfaced: ${globalRegistration?.error}`);
        assert.ok(globalRegistration?.hint?.includes('claw run'));
      } finally {
        await fs.rm(builtinDir, { recursive: true, force: true });
      }
    });

    it('rejects built-in metadata before attempting an agent-debug runtime', async () => {
      const agentDir = join(studioDir, 'built-in-agent');
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(join(agentDir, 'metadata.json'), JSON.stringify({
        id: 'built-in-agent', entry: './agent.js', features: ['todo'],
      }));
      await fs.writeFile(join(agentDir, 'agent.js'), 'export default class BuiltInAgent {}\n');
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, studioDir);

      await assert.rejects(
        () => exec('studio_register_agent', { agentDir: './built-in-agent' }),
        /仅支持 standalone metadata 驱动装配.*built-in \/ prebuilt Agent/s,
      );
    });

    it('rejects invalid assertion definitions with precise errors', async () => {
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, studioDir);
      await assert.rejects(
        () => exec('studio_define_test', {
          id: 'bad', title: 't', input: 'i',
          assertions: [{ kind: 'tool-result-path', tool: 'x', path: 'no-dollar' }],
        }),
        /path/,
      );
    });

    it('studio_run_test without a running runtime throws', async () => {
      const exec = execAt({ workspaceDir, statePath, agentRegistryPath }, studioDir);
      await assert.rejects(
        () => exec('studio_run_test', { testId: 'allow-create' }),
        /studio_start_runtime/,
      );
    });
  });

  describe('session feature binding', () => {
    it('skips explicitly when the host injects no session identity', async () => {
      const feature = new AgentStudioFeature({ workspaceDir: studioDir, statePath });
      const result = await feature.appendSessionFeatureBinding(['some-feature']);
      assert.equal(result.ok, false);
      assert.equal(result.skipped, true);
    });

    it('surfaces the error when the binding endpoint is unreachable', async () => {
      const feature = new AgentStudioFeature({
        workspaceDir: studioDir,
        statePath,
        sessionId: 'session-1',
        agentId: 'agent-studio',
        serverOrigin: 'http://127.0.0.1:9',
      });
      const result = await feature.appendSessionFeatureBinding(['some-feature']);
      assert.equal(result.ok, false);
      assert.ok(result.error, 'error message present');
    });
  });

  describe('state and injection', () => {
    it('captureState/restoreState preserves the active directory', async () => {
      const feature = new AgentStudioFeature({ workspaceDir, statePath });
      feature.restoreState({ activeProjectDir: studioDir });
      const exec = bindTools(feature);
      const loaded = await exec('studio_get_directory');
      assert.equal((loaded as { directory: string }).directory, studioDir);
      assert.deepEqual(feature.captureState(), { activeProjectDir: studioDir });
    });

    it('injectProjectState skips empty-input pre-inject to avoid double injection', async () => {
      const feature = new AgentStudioFeature({ workspaceDir: studioDir, statePath });
      const added: Array<{ role: string; content: string }> = [];
      const fakeContext = { add: (entry: { role: string; content: string }) => { added.push(entry); } };
      await feature.injectProjectState({ input: '', context: fakeContext } as never);
      assert.equal(added.length, 0);
      await feature.injectProjectState({ input: '创建工单', context: fakeContext } as never);
      assert.equal(added.length, 1);
      assert.ok(added[0].content.includes('当前目录与 Feature 状态'));
    });
  });
});
