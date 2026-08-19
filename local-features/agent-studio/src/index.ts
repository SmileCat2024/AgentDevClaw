import os from 'os';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import type { AgentFeature, CallStartContext, FeatureInitContext, FeatureStateSnapshot, HookDeclarations, PackageInfo, Tool } from 'agentdev';
import { CoreLifecycle, createTool } from 'agentdev';

export interface AgentStudioFeatureConfig {
  workspaceDir?: string;
  statePath?: string;
  /** 覆盖全局 Agent 注册表路径（默认用户目录 agent-registry.json；测试用） */
  agentRegistryPath?: string;
}

type TestRuntimeStatus = 'not-provisioned' | 'running' | 'stopped';
type StudioFeatureStatus = 'implemented' | 'mounted' | 'verified' | 'snapshotted';
export type SessionPolicy = 'fresh' | 'stateful' | 'checkpointed';

const ASSERTION_KINDS = ['tool-executed', 'tool-denied', 'tool-result-path', 'reply-includes', 'hook-observed'] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

/** 可执行断言：测试通过的判定依据，全部由运行证据机器判定。 */
export interface StudioAssertion {
  kind: AssertionKind;
  /** tool-executed / tool-denied / tool-result-path 必填 */
  tool?: string;
  /** tool-executed：最少执行次数（缺省 1） */
  count?: number;
  /** tool-denied：拒绝原因需包含的子串 */
  reasonIncludes?: string;
  /** tool-result-path：匹配第几次调用（从 1 开始；缺省取最后一次） */
  occurrence?: number;
  /** tool-result-path：结果 JSON 路径，如 $.openCount、$.tickets[0].title */
  path?: string;
  /** tool-result-path：期望值（深度比较） */
  equals?: unknown;
  /** reply-includes 必填 */
  text?: string;
  /** hook-observed 过滤条件（lifecycle 必填，其余可选） */
  feature?: string;
  lifecycle?: string;
  method?: string;
  /** hook-observed：关联工具名 */
  subject?: string;
}

export interface StudioTestCase {
  id: string;
  title: string;
  input: string;
  /** 供人读的测试意图说明（不参与判定） */
  description?: string;
  sessionPolicy: SessionPolicy;
  /** sessionPolicy='checkpointed' 时必填 */
  checkpoint?: string;
  assertions: StudioAssertion[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StudioFeatureVerification {
  lastVerifiedRunId: string;
  verifiedAt: string;
  coverage: StudioFeatureCoverage;
  sourceDigest?: string;
  /** 传递覆盖：本 Feature 无直接证据，凭依赖它的 Feature 本次验证通过而推进；值为提供覆盖的依赖方 Feature 名 */
  transitiveVia?: string[];
}

interface StudioFeatureSource {
  kind: 'project';
  projectDir: string;
  entry: string;
  buildCommand: string[];
}

interface StudioFeatureSnapshot {
  version: string;
  archivePath: string;
  archiveDigest: string;
  createdAt: string;
}

export interface StudioFeatureEntry {
  name: string;
  modulePath: string;
  package?: string;
  export?: string;
  source?: StudioFeatureSource;
  status: StudioFeatureStatus;
  verification?: StudioFeatureVerification;
  snapshot?: StudioFeatureSnapshot;
  /** 装配时从 static inject 读取的依赖 Feature 名（运行时同步回写，传递覆盖判定用） */
  staticInject?: string[];
}

interface StudioAgentDefinition {
  projectDir: string;
  metadataPath: string;
}

interface AgentStudioProject {
  schemaVersion: 3;
  name: string;
  goal: string;
  targetAgent: string;
  agent?: StudioAgentDefinition;
  features: StudioFeatureEntry[];
  testRuntime: {
    status: TestRuntimeStatus;
  };
  tests: StudioTestCase[];
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceState {
  forms?: Record<string, Record<string, string>>;
  openDirectory?: string;
}

interface StudioProjectEntry {
  projectDir: string;
  name: string;
  goal: string;
  targetAgent: string;
  updatedAt: string;
}

export interface StudioToolCallEvidence {
  tool: string;
  /** 拥有该工具的 feature（证据归属） */
  feature?: string;
  ok: boolean;
  durationMs: number;
  /** 最终投递结果（ToolResultTransform 之后、模型实际收到的值） */
  result?: unknown;
  error?: string;
  at: string;
  /** true = 调用被拦截（guard Deny / 工具禁用），execute 从未执行 */
  denied?: boolean;
}

export interface StudioHookEvidence {
  feature: string;
  method: string;
  lifecycle: string;
  kind: string;
  subject?: string;
  decision?: string;
  durationMs?: number;
  at: string;
}

export interface StudioFeatureCoverage {
  tools: string[];
  hooks: string[];
  deniedTools: string[];
}

export interface AssertionEvaluation {
  assertion: StudioAssertion;
  ok: boolean;
  actual?: unknown;
  detail?: string;
}

export interface StudioRunRecord {
  runId: string;
  testId: string;
  startedAt: string;
  finishedAt: string;
  phase: 'reload' | 'test';
  ok: boolean;
  /** true = 全部断言通过；false = 有断言失败或运行出错；null = 本次运行没有断言（仅取证） */
  passed: boolean | null;
  assertionResults: AssertionEvaluation[];
  /** 本次运行实际覆盖到的 Feature 与证据面 */
  featureCoverage: Record<string, StudioFeatureCoverage>;
  /** 运行时各 Feature 的源指纹（size-mtimeMs） */
  featureRevisions: Record<string, string>;
  session: {
    policy: SessionPolicy;
    checkpoint?: string;
    restoredFrom?: string | null;
    saved?: string | null;
  };
  reply?: string;
  toolCalls: StudioToolCallEvidence[];
  hooks: StudioHookEvidence[];
  reloadSummary: Array<{
    featureName: string;
    action: 'reloaded' | 'unchanged' | 'ensure-mounted' | 'failed';
    ok: boolean;
    durationMs?: number;
    stateTransferred?: boolean;
    stage?: string;
    reverted?: boolean;
    error?: string;
  }>;
  error?: { name: string; message: string; stack?: string };
}

// ── 断言求值（纯函数） ─────────────────────────────────────────

/** 解析 $ 路径：$.a.b、$.list[0].name */
export function getPathValue(target: unknown, path: string): unknown {
  if (!path.startsWith('$')) {
    throw new Error(`path 必须以 $ 开头：${path}`);
  }
  const tokens = path
    .slice(1)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current = target;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    );
  }
  return false;
}

function parseEvidenceResult(raw: unknown): { value?: unknown; error?: string } {
  if (raw === undefined || raw === null) return { error: '结果为空' };
  if (typeof raw === 'string') {
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return { error: `结果不是合法 JSON：${raw.slice(0, 200)}` };
    }
  }
  return { value: raw };
}

/** 模型端生成工具参数时可能把 number / boolean 字符串化（如 4 → "4"、true → "true"）。
 * deepEqual 前做单边类型反缩放：一边为字符串、另一边为 number/boolean 时，
 * 尝试把字符串侧解析回原始类型，避免严格深度比较因类型不一致必败。 */
function descaleComparable(actual: unknown, expected: unknown): { actual: unknown; expected: unknown; descaled: boolean } {
  const parsePrimitive = (text: string): { value: unknown } | null => {
    if (text === 'true') return { value: true };
    if (text === 'false') return { value: false };
    if (text.trim() !== '' && Number.isFinite(Number(text))) return { value: Number(text) };
    return null;
  };
  if (typeof expected === 'string' && (typeof actual === 'number' || typeof actual === 'boolean')) {
    const parsed = parsePrimitive(expected);
    if (parsed) return { actual, expected: parsed.value, descaled: true };
  } else if (typeof actual === 'string' && (typeof expected === 'number' || typeof expected === 'boolean')) {
    const parsed = parsePrimitive(actual);
    if (parsed) return { actual: parsed.value, expected, descaled: true };
  }
  return { actual, expected, descaled: false };
}

export function evaluateAssertions(
  assertions: StudioAssertion[],
  input: { reply?: string; toolCalls: StudioToolCallEvidence[]; hooks: StudioHookEvidence[] },
): AssertionEvaluation[] {
  const results: AssertionEvaluation[] = [];
  for (const assertion of assertions) {
    results.push(evaluateAssertion(assertion, input));
  }
  return results;
}

function evaluateAssertion(
  assertion: StudioAssertion,
  input: { reply?: string; toolCalls: StudioToolCallEvidence[]; hooks: StudioHookEvidence[] },
): AssertionEvaluation {
  const { reply, toolCalls, hooks } = input;
  switch (assertion.kind) {
    case 'tool-executed': {
      const required = assertion.count && assertion.count > 0 ? assertion.count : 1;
      const executed = toolCalls.filter((entry) => !entry.denied && entry.tool === assertion.tool);
      const denied = toolCalls.filter((entry) => entry.denied && entry.tool === assertion.tool);
      const ok = executed.length >= required;
      return {
        assertion,
        ok,
        actual: executed.length,
        detail: ok
          ? undefined
          : `工具 ${assertion.tool} 实际执行 ${executed.length} 次（要求 >= ${required}）${denied.length > 0 ? `；另有 ${denied.length} 次被拦截（denied）` : ''}`,
      };
    }
    case 'tool-denied': {
      const deniedEntries = toolCalls.filter((entry) => entry.denied && entry.tool === assertion.tool);
      const executed = toolCalls.filter((entry) => !entry.denied && entry.tool === assertion.tool);
      let matched = deniedEntries;
      if (assertion.reasonIncludes) {
        matched = deniedEntries.filter((entry) => (entry.error || '').includes(assertion.reasonIncludes!));
      }
      const ok = matched.length > 0;
      return {
        assertion,
        ok,
        actual: matched.length,
        detail: ok
          ? undefined
          : `工具 ${assertion.tool} 未观察到满足条件的被拒调用（被拒 ${deniedEntries.length} 次，实际执行 ${executed.length} 次）${assertion.reasonIncludes ? `；要求拒绝原因包含「${assertion.reasonIncludes}」` : ''}`,
      };
    }
    case 'tool-result-path': {
      const executed = toolCalls.filter((entry) => !entry.denied && entry.tool === assertion.tool);
      if (executed.length === 0) {
        return { assertion, ok: false, detail: `工具 ${assertion.tool} 未执行，无法取结果` };
      }
      const index = assertion.occurrence && assertion.occurrence > 0
        ? assertion.occurrence - 1
        : executed.length - 1;
      if (index >= executed.length) {
        return { assertion, ok: false, actual: executed.length, detail: `工具 ${assertion.tool} 仅执行 ${executed.length} 次，无法取第 ${assertion.occurrence} 次结果` };
      }
      const parsed = parseEvidenceResult(executed[index].result);
      if (parsed.error) {
        return { assertion, ok: false, detail: parsed.error };
      }
      let value: unknown;
      try {
        value = getPathValue(parsed.value, assertion.path || '$');
      } catch (error) {
        return { assertion, ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
      const compared = descaleComparable(value, assertion.equals);
      const ok = deepEqual(compared.actual, compared.expected);
      return {
        assertion,
        ok,
        actual: value,
        detail: ok
          ? compared.descaled ? `通过（期望值 ${JSON.stringify(assertion.equals)} 经类型反缩放为 ${JSON.stringify(compared.expected)} 后匹配）` : undefined
          : `路径 ${assertion.path} 实际值为 ${JSON.stringify(value) ?? String(value)}（类型 ${typeof value}），期望 ${JSON.stringify(assertion.equals) ?? String(assertion.equals)}（类型 ${typeof assertion.equals}）`,
      };
    }
    case 'reply-includes': {
      const ok = typeof reply === 'string' && reply.includes(assertion.text || '');
      return {
        assertion,
        ok,
        detail: ok ? undefined : `最终回复未包含「${assertion.text}」${typeof reply === 'string' ? `（回复长度 ${reply.length}）` : '（无回复）'}`,
      };
    }
    case 'hook-observed': {
      const matched = hooks.filter((entry) =>
        entry.lifecycle === assertion.lifecycle
        && (!assertion.feature || entry.feature === assertion.feature)
        && (!assertion.method || entry.method === assertion.method)
        && (!assertion.subject || entry.subject === assertion.subject),
      );
      const ok = matched.length > 0;
      return {
        assertion,
        ok,
        actual: matched.length,
        detail: ok
          ? undefined
          : `未观察到匹配的钩子调用（lifecycle=${assertion.lifecycle}${assertion.feature ? `, feature=${assertion.feature}` : ''}${assertion.method ? `, method=${assertion.method}` : ''}；实际观察到 ${hooks.length} 次钩子调用）`,
      };
    }
    default:
      return { assertion, ok: false, detail: `未知断言类型：${assertion.kind}` };
  }
}

/** 把运行证据归属到 Feature：工具按 feature 字段、钩子按 feature 字段。 */
export function computeFeatureCoverage(
  toolCalls: StudioToolCallEvidence[],
  hooks: StudioHookEvidence[],
): Record<string, StudioFeatureCoverage> {
  const coverage: Record<string, StudioFeatureCoverage> = {};
  const ensure = (feature: string): StudioFeatureCoverage => {
    if (!coverage[feature]) coverage[feature] = { tools: [], hooks: [], deniedTools: [] };
    return coverage[feature];
  };
  for (const entry of toolCalls) {
    if (!entry.feature) continue;
    const bucket = ensure(entry.feature);
    if (entry.denied) {
      if (!bucket.deniedTools.includes(entry.tool)) bucket.deniedTools.push(entry.tool);
    } else if (!bucket.tools.includes(entry.tool)) {
      bucket.tools.push(entry.tool);
    }
  }
  for (const hook of hooks) {
    if (!hook.feature) continue;
    const bucket = ensure(hook.feature);
    const signature = `${hook.lifecycle}:${hook.method}`;
    if (!bucket.hooks.includes(signature)) bucket.hooks.push(signature);
  }
  // 账本与事件顺序无关：统一排序保证持久化形态稳定
  for (const bucket of Object.values(coverage)) {
    bucket.tools.sort();
    bucket.hooks.sort();
    bucket.deniedTools.sort();
  }
  return coverage;
}

function isCovered(coverage: StudioFeatureCoverage | undefined): boolean {
  if (!coverage) return false;
  return coverage.tools.length + coverage.hooks.length + coverage.deniedTools.length > 0;
}

/**
 * Feature 状态推进：
 * - reloaded / ensure-mounted → mounted（源码已变，旧验证失效）
 * - 本次 passed 且该 Feature 有覆盖证据 → verified（记录验证账本）
 * - 传递覆盖：纯库型 Feature（无工具无钩子，永远拿不到直接证据）在本次 passed
 *   且依赖它的 Feature 已 verified（直接或传递）时一并推进 verified，verification 标注
 *   transitiveVia。传播到不动点，覆盖 A→B→C 链式依赖。
 * - unchanged → 保持原状（verified 不因未变更而降级）
 */
export function advanceFeatureStatuses(
  features: StudioFeatureEntry[],
  reloadSummary: StudioRunRecord['reloadSummary'],
  coverage: Record<string, StudioFeatureCoverage>,
  passed: boolean | null,
  runId: string,
  timestamp: string,
  featureRevisions: Record<string, string> = {},
): StudioFeatureEntry[] {
  const advanced = features.map((feature) => {
    const summaryEntry = reloadSummary.find((item) => item.featureName === feature.name);
    let status = feature.status;
    let verification = feature.verification;
    let snapshot = feature.snapshot;
    if (summaryEntry && (summaryEntry.action === 'reloaded' || summaryEntry.action === 'ensure-mounted')) {
      status = 'mounted';
      verification = undefined;
      snapshot = undefined;
    }
    if (passed === true && isCovered(coverage[feature.name])) {
      status = snapshot ? 'snapshotted' : 'verified';
      verification = {
        lastVerifiedRunId: runId,
        verifiedAt: timestamp,
        coverage: coverage[feature.name],
        ...(featureRevisions[feature.name] ? { sourceDigest: featureRevisions[feature.name] } : {}),
      };
    }
    return verification ? { ...feature, status, verification, ...(snapshot ? { snapshot } : {}) } : { ...feature, status, verification: undefined, ...(snapshot ? { snapshot } : {}) };
  });

  if (passed !== true) return advanced;

  // 传递覆盖：依赖方（static inject 声明）本次 verified 时，被依赖的库型 Feature 一并推进。
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const entry of advanced) {
      if (entry.status === 'verified' || entry.status === 'snapshotted') continue;
      const dependents = advanced.filter((other) => (other.staticInject || []).includes(entry.name));
      const verifiedDependents = dependents
        .filter((other) => other.status === 'verified' || other.status === 'snapshotted')
        .map((other) => other.name);
      if (verifiedDependents.length === 0) continue;
      entry.status = entry.snapshot ? 'snapshotted' : 'verified';
      entry.verification = {
        lastVerifiedRunId: runId,
        verifiedAt: timestamp,
        coverage: { tools: [], hooks: [], deniedTools: [] },
        transitiveVia: verifiedDependents,
        ...(featureRevisions[entry.name] ? { sourceDigest: featureRevisions[entry.name] } : {}),
      };
      progressed = true;
    }
  }
  return advanced;
}

// ── 常量 ──────────────────────────────────────────────────────

const PROJECT_FILE_NAME = 'agent-studio.json';
const REGISTRY_FILE_NAME = 'projects.json';
const RUNS_DIR_NAME = '.agent-studio';
const RUNS_FILE_NAME = 'runs.json';
const RUNS_KEEP_COUNT = 30;
const READY_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 120_000;
const RUN_TEST_TIMEOUT_MS = 300_000;
const INSPECT_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const RUNS_RESULT_TRUNCATE = 2000;

// ── Test Runtime 进程管理（module 级：feature 热载后子进程不丢） ──────────

interface StudioReadyPayload {
  ok: boolean;
  model?: string;
  sessionRestored?: boolean;
  observability?: 'hub' | 'local-only';
  viewerAgentId?: string | null;
  features?: Array<{ name: string; mounted: boolean }>;
  feature?: string;
  error?: { name: string; message: string; stack?: string };
}

interface RuntimePendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RuntimeHandle {
  child: ChildProcess;
  pending: Map<string, RuntimePendingRequest>;
  fingerprints: Map<string, string>;
  mode: 'feature-harness' | 'agent-debug';
  agentFingerprint: string | null;
  model: string | null;
  viewerAgentId: string | null;
  /** 最近一次 inspect 拿到的 Feature 依赖图（static inject），供传递覆盖判定用 */
  featureInject: Map<string, string[]>;
}

const runtimeHandles = new Map<string, RuntimeHandle>();
let runtimeScriptPath: string | null = null;

function findProjectScript(relativePath: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到 ${relativePath}；请确认在 AgentDevClaw 仓库环境中运行。`);
}

function findRuntimeScriptPath(): string {
  if (runtimeScriptPath) return runtimeScriptPath;
  runtimeScriptPath = findProjectScript(join('scripts', 'run-studio-runtime.js'));
  return runtimeScriptPath;
}

let agentRegistryModuleUrl: string | null = null;

/** 定位 server/feature-runtime/agent-registry.js，与消费端（claw run / server）共用同一注册实现。 */
function findAgentRegistryModuleUrl(): string {
  if (agentRegistryModuleUrl) return agentRegistryModuleUrl;
  const registryPath = findProjectScript(join('server', 'feature-runtime', 'agent-registry.js'));
  agentRegistryModuleUrl = pathToFileURL(registryPath).href;
  return agentRegistryModuleUrl;
}

function findCreateFeatureCliPath(): string {
  const clawRoot = dirname(dirname(findRuntimeScriptPath()));
  const agentDevRoot = dirname(clawRoot);
  const candidate = join(agentDevRoot, 'AgentDev', 'dist', 'create-feature-cli.js');
  if (!existsSync(candidate)) {
    throw new Error(
      `AgentDev 框架构建产物缺失，无法创建 Feature 脚手架：${candidate}。`
      + ` 请先在框架仓库完成构建（${join(agentDevRoot, 'AgentDev')} 目录下执行 npm install && npm run build），`
      + ` 构建完成后重试本工具；不要手工补建该文件。`,
    );
  }
  return candidate;
}

function findPrepareRuntimeScriptPath(): string {
  return findProjectScript(join('scripts', 'prepare-agent-runtime.js'));
}

/**
 * Keep Studio registration on the same metadata schema as runtime-plan
 * preparation without embedding an incorrect path in local-features/dist.
 */
async function normalizeStandaloneAgentMetadata(raw: unknown): Promise<{
  id: string;
  entry: string;
  deployment: { kind: string };
}> {
  const clawRoot = dirname(dirname(findRuntimeScriptPath()));
  const schemaPath = join(clawRoot, 'server', 'feature-runtime', 'schemas.js');
  const { normalizeAgentMetadata } = await import(pathToFileURL(schemaPath).href) as {
    normalizeAgentMetadata: (value: unknown, options: { requireFeatureVersions: boolean }) => {
      id: string;
      entry: string;
      deployment: { kind: string };
    };
  };
  return normalizeAgentMetadata(raw, { requireFeatureVersions: true });
}

function getRuntimePlanPath(projectDir: string): string {
  return join(projectDir, RUNS_DIR_NAME, 'runtime-plan.json');
}

function getRuntimeOverridesPath(projectDir: string): string {
  return join(projectDir, RUNS_DIR_NAME, 'source-overrides.json');
}

function getRuntimeHandle(projectDir: string): RuntimeHandle | null {
  const handle = runtimeHandles.get(projectDir);
  if (handle && handle.child.connected && handle.child.exitCode === null) return handle;
  if (handle) runtimeHandles.delete(projectDir);
  return null;
}

function failPendingRequests(handle: RuntimeHandle, error: Error): void {
  for (const [, pending] of handle.pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  handle.pending.clear();
}

async function fingerprintModule(modulePath: string): Promise<string> {
  try {
    const content = await fs.readFile(modulePath);
    return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

async function fingerprintAgentDefinition(project: AgentStudioProject): Promise<string> {
  if (!project.agent) return 'none';
  const hash = crypto.createHash('sha256');
  for (const filePath of [project.agent.metadataPath, join(project.agent.projectDir, 'agent.js')]) {
    hash.update(filePath);
    hash.update('\\0');
    try { hash.update(await fs.readFile(filePath)); } catch { hash.update('missing'); }
    hash.update('\\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function fingerprintFeatureSource(feature: StudioFeatureEntry): Promise<string> {
  if (!feature.source) return fingerprintModule(feature.modulePath);
  const root = feature.source.projectDir;
  const ignored = new Set(['node_modules', 'dist', '.agent-studio']);
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(join(dir, entry.name));
      } else if (entry.isFile() && !entry.name.endsWith('.tgz')) {
        files.push(join(dir, entry.name));
      }
    }
  };
  try {
    await visit(root);
    const hash = crypto.createHash('sha256');
    for (const filePath of files.sort()) {
      hash.update(relative(root, filePath).replace(/\\/g, '/'));
      hash.update('\0');
      hash.update(await fs.readFile(filePath));
      hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
  } catch {
    return 'missing';
  }
}

async function runProjectCommand(projectDir: string, command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((promiseResolve, promiseReject) => {
    // Node on this Windows runtime cannot spawn npm.cmd with shell:false. The
    // only npm operations Studio issues are fixed lifecycle commands; reject
    // every other token sequence before using cmd.exe as a compatibility shim.
    const isNpm = command === 'npm';
    const allowedNpmArgs = args.join(' ') === 'run build' || args.join(' ') === 'install --no-fund --no-audit';
    if (isNpm && !allowedNpmArgs) {
      promiseReject(new Error(`Studio 不允许执行未声明的 npm 命令：npm ${args.join(' ')}`));
      return;
    }
    const executable = process.platform === 'win32' && isNpm ? (process.env.ComSpec || 'cmd.exe') : command;
    const executableArgs = process.platform === 'win32' && isNpm
      ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`]
      : args;
    const child = spawn(executable, executableArgs, { cwd: projectDir, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', promiseReject);
    child.on('exit', (code) => {
      if (code === 0) promiseResolve({ stdout, stderr });
      else promiseReject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function runFeatureBuild(feature: StudioFeatureEntry): Promise<void> {
  if (!feature.source) return;
  const [command, ...args] = feature.source.buildCommand;
  if (command !== 'npm' || args.join(' ') !== 'run build') {
    throw new Error(`标准 Feature 项目仅支持 buildCommand=["npm","run","build"]：${feature.name}`);
  }
  await runProjectCommand(feature.source.projectDir, command, args);
}

async function readFeatureProjectEntry(projectDir: string, studioProjectDir: string): Promise<StudioFeatureEntry> {
  const packageJson = JSON.parse(await fs.readFile(join(projectDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  const packageName = cleanValue(packageJson.name);
  const main = cleanValue(packageJson.main) || 'dist/index.js';
  if (!packageName) throw new Error(`Feature 项目缺少 package.json name：${projectDir}`);
  const entryPath = resolve(projectDir, main);
  const name = packageName.replace(/^@[^/]+\//, '');
  return {
    name,
    modulePath: entryPath,
    package: packageName,
    source: {
      kind: 'project',
      projectDir,
      entry: entryPath,
      buildCommand: ['npm', 'run', 'build'],
    },
    status: 'implemented',
  };
}

async function runSnapshotScript(projectDir: string): Promise<StudioFeatureSnapshot> {
  const scriptPath = findProjectScript(join('scripts', 'package-feature-project.js'));
  const { stdout } = await runProjectCommand(dirname(scriptPath), process.execPath, [scriptPath, '--project-dir', projectDir]);
  const line = stdout.trim().split(/\r?\n/).find((item) => item.startsWith('{')) || '';
  const result = JSON.parse(line) as { ok?: boolean; snapshot?: StudioFeatureSnapshot; error?: string };
  if (!result.ok || !result.snapshot) throw new Error(result.error || '创建本地 Snapshot 失败。');
  return result.snapshot;
}

async function prepareAgentDebugPlan(projectDir: string, project: AgentStudioProject): Promise<string> {
  if (!project.agent) throw new Error('当前项目没有注册真实 Agent。请先调用 studio_register_agent，或以 feature-harness 模式启动。');
  const agentRoot = resolve(projectDir, project.agent.projectDir);
  const metadataPath = resolve(projectDir, project.agent.metadataPath);
  if (!existsSync(metadataPath)) throw new Error(`Agent metadata 不存在：${metadataPath}`);
  const overrides = project.features.map((feature) => {
    if (!feature.package || !feature.source) {
      throw new Error(`Agent Debug 只支持标准 Feature 项目；${feature.name} 仍是 legacy 模块。`);
    }
    return {
      package: feature.package,
      runtimeName: feature.name,
      ...(feature.export ? { export: feature.export } : {}),
      source: {
        kind: 'project',
        projectDir: feature.source.projectDir,
        entry: feature.source.entry,
      },
    };
  });
  const overridesPath = getRuntimeOverridesPath(projectDir);
  const planPath = getRuntimePlanPath(projectDir);
  await fs.mkdir(dirname(planPath), { recursive: true });
  await fs.writeFile(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
  const scriptPath = findPrepareRuntimeScriptPath();
  const { stdout } = await runProjectCommand(dirname(scriptPath), process.execPath, [
    scriptPath,
    '--agent-root', agentRoot,
    '--metadata', metadataPath,
    '--output', planPath,
    '--mode', 'debug',
    '--source-overrides', overridesPath,
  ]);
  const line = stdout.trim().split(/\r?\n/).find((item) => item.startsWith('{')) || '';
  const result = JSON.parse(line) as { ok?: boolean; error?: string };
  if (!result.ok) throw new Error(result.error || 'Agent Debug 运行计划准备失败。');
  return planPath;
}

function runtimeRequest(
  projectDir: string,
  handle: RuntimeHandle,
  message: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  if (!handle.child.connected) {
    return Promise.reject(new Error('Test Runtime 进程已退出。请重新调用 studio_start_runtime。'));
  }
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((promiseResolve, promiseReject) => {
    const timer = setTimeout(() => {
      handle.pending.delete(requestId);
      promiseReject(new Error(`Test Runtime 请求超时（${message.type}，${timeoutMs}ms）。`));
    }, timeoutMs);
    handle.pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        handle.pending.delete(requestId);
        promiseResolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        handle.pending.delete(requestId);
        promiseReject(error);
      },
      timer,
    });
    handle.child.send({ ...message, requestId });
  });
}

async function startRuntimeProcess(
  projectDir: string,
  modelPreset: string,
  mode: 'feature-harness' | 'agent-debug' = 'feature-harness',
  runtimePlanPath = '',
): Promise<{ ready: StudioReadyPayload; handle: RuntimeHandle }> {
  const scriptPath = findRuntimeScriptPath();
  const viewerPort = Number(process.env.AGENTDEV_VIEWER_PORT || 2026);
  const childArgs = [scriptPath, projectDir, '--mode', mode];
  if (runtimePlanPath) childArgs.push('--plan', runtimePlanPath);
  const child = spawn(process.execPath, childArgs, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: projectDir,
    env: { ...process.env, STUDIO_MODEL_PRESET: modelPreset, STUDIO_VIEWER_PORT: String(viewerPort) },
  });
  const handle: RuntimeHandle = { child, pending: new Map(), fingerprints: new Map(), mode, agentFingerprint: null, model: null, viewerAgentId: null, featureInject: new Map() };
  runtimeHandles.set(projectDir, handle);

  // 子进程接入 DebugHub 后日志走结构化流；这里只保留环形缓冲，
  // 在启动失败/异常退出时把现场嵌进错误信息，不再向父进程日志流转发。
  const outputTail: string[] = [];
  const captureStream = (stream: NodeJS.ReadableStream, tag: string) => {
    stream.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      outputTail.push(`[${tag}] ${text}`);
      if (outputTail.length > 200) outputTail.shift();
    });
  };
  captureStream(child.stdout, 'out');
  captureStream(child.stderr, 'err');
  const tailText = () => (outputTail.length ? `\n最近输出（尾部 ${outputTail.length} 行）：\n${outputTail.join('\n')}` : '');

  const readyPromise = new Promise<StudioReadyPayload>((resolveReady, rejectReady) => {
    const readyTimer = setTimeout(() => {
      rejectReady(new Error(`Test Runtime 启动超时（${READY_TIMEOUT_MS}ms）。${tailText()}`));
      child.kill();
    }, READY_TIMEOUT_MS);
    const onMessage = (msg: Record<string, unknown>) => {
      if (msg?.type === 'studio-ready') {
        clearTimeout(readyTimer);
        resolveReady(msg as unknown as StudioReadyPayload);
        child.off('message', onMessage);
      }
    };
    child.on('message', onMessage);
    child.once('exit', (code) => {
      clearTimeout(readyTimer);
      failPendingRequests(handle, new Error(`Test Runtime 进程已退出（code=${code}）。`));
      runtimeHandles.delete(projectDir);
      rejectReady(new Error(`Test Runtime 进程在就绪前退出（code=${code}）。${tailText()}`));
    });
  });

  // 常规请求/响应分发（ready 之后）
  child.on('message', (msg: Record<string, unknown>) => {
    if (msg?.type !== 'studio-result') return;
    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const pending = handle.pending.get(requestId);
    if (pending) pending.resolve(msg);
  });
  child.on('exit', () => {
    failPendingRequests(handle, new Error('Test Runtime 进程已退出。'));
    runtimeHandles.delete(projectDir);
    void markRuntimeStopped(projectDir);
  });

  const ready = await readyPromise;
  if (!ready.ok) {
    child.kill();
    runtimeHandles.delete(projectDir);
    const detail = ready.error?.message || '未知错误';
    const featurePart = ready.feature ? `（feature: ${ready.feature}）` : '';
    throw new Error(`Test Runtime 启动失败${featurePart}: ${detail}${tailText()}`);
  }
  handle.model = ready.model || null;
  handle.viewerAgentId = ready.viewerAgentId ?? null;
  return { ready, handle };
}

async function stopRuntimeProcess(projectDir: string): Promise<{ stopped: boolean; wasRunning: boolean }> {
  const handle = getRuntimeHandle(projectDir);
  if (!handle) return { stopped: true, wasRunning: false };
  try {
    await runtimeRequest(projectDir, handle, { type: 'studio-shutdown' }, SHUTDOWN_TIMEOUT_MS);
  } catch {
    handle.child.kill();
  }
  const exited = new Promise<void>((resolveExit) => {
    const timer = setTimeout(() => {
      handle.child.kill();
      resolveExit();
    }, SHUTDOWN_TIMEOUT_MS);
    handle.child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
  await exited;
  runtimeHandles.delete(projectDir);
  return { stopped: true, wasRunning: true };
}

/**
 * run-test 前把项目 features 同步进 runtime：一次 sync 请求完成
 * ensure（按 static inject 拓扑序自动挂载）与 reload（状态迁移/失败回退）。
 */
async function syncFeaturesToRuntime(
  projectDir: string,
  handle: RuntimeHandle,
  project: AgentStudioProject,
  runTag = 'startup',
): Promise<StudioRunRecord['reloadSummary']> {
  const inspectResult = await runtimeRequest(projectDir, handle, {
    type: 'studio-inspect',
  }, INSPECT_TIMEOUT_MS).catch(() => null);
  const mountedFeatures = inspectResult && Array.isArray(inspectResult.features)
    ? new Set(inspectResult.features as string[])
    : new Set<string>();
  if (inspectResult && inspectResult.featureInject && typeof inspectResult.featureInject === 'object') {
    handle.featureInject = new Map(
      Object.entries(inspectResult.featureInject as Record<string, unknown>)
        .map(([name, deps]) => [name, Array.isArray(deps) ? deps.map(String) : []]),
    );
  }

  const ensure: Array<{ name: string; modulePath: string }> = [];
  const reload: Array<{ name: string; modulePath: string }> = [];
  const unchanged: string[] = [];
  for (const feature of project.features) {
    await runFeatureBuild(feature);
    const currentFingerprint = await fingerprintModule(feature.modulePath);
    if (!mountedFeatures.has(feature.name)) {
      ensure.push({ name: feature.name, modulePath: feature.modulePath });
    } else if (handle.fingerprints.get(feature.name) === currentFingerprint) {
      unchanged.push(feature.name);
    } else {
      reload.push({ name: feature.name, modulePath: feature.modulePath });
    }
  }

  const summary: StudioRunRecord['reloadSummary'] = [];
  if (ensure.length > 0 || reload.length > 0) {
    const synced = await runtimeRequest(projectDir, handle, {
      type: 'studio-sync-features',
      runId: runTag,
      ensure: ensure.map((entry) => ({ featureName: entry.name, modulePath: entry.modulePath })),
      reload: reload.map((entry) => ({ featureName: entry.name, modulePath: entry.modulePath })),
    }, SYNC_TIMEOUT_MS);
    const perFeature = Array.isArray(synced.perFeature) ? synced.perFeature as Array<Record<string, unknown>> : [];
    const byName = new Map(perFeature.map((entry) => [String(entry.featureName || ''), entry]));
    for (const feature of project.features) {
      const entry = byName.get(feature.name);
      if (entry) {
        const action = entry.action === 'reloaded' || entry.action === 'ensure-mounted' || entry.action === 'failed'
          ? entry.action
          : 'unchanged';
        if (entry.ok !== false) {
          handle.fingerprints.set(feature.name, await fingerprintModule(feature.modulePath));
        }
        summary.push({
          featureName: feature.name,
          action,
          ok: entry.ok !== false,
          ...(typeof entry.durationMs === 'number' ? { durationMs: entry.durationMs } : {}),
          ...(entry.stateTransferred === true ? { stateTransferred: true } : {}),
          ...(typeof entry.stage === 'string' ? { stage: entry.stage } : {}),
          ...(entry.reverted === true ? { reverted: true } : {}),
          ...(typeof entry.error === 'string' ? { error: entry.error } : {}),
        });
      } else {
        summary.push({ featureName: feature.name, action: 'unchanged', ok: true });
      }
    }
  } else {
    for (const feature of project.features) {
      summary.push({ featureName: feature.name, action: 'unchanged', ok: true });
    }
  }
  return summary;
}

// ── 项目文件读写 ──────────────────────────────────────────────

function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFeatureStatus(value: unknown): StudioFeatureStatus {
  return value === 'mounted' || value === 'verified' || value === 'snapshotted' ? value : 'implemented';
}

function normalizeVerification(raw: unknown): StudioFeatureVerification | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const coverageRaw = record.coverage && typeof record.coverage === 'object' ? record.coverage : {};
  const coverage = coverageRaw as Record<string, unknown>;
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  return {
    lastVerifiedRunId: cleanValue(record.lastVerifiedRunId),
    verifiedAt: cleanValue(record.verifiedAt),
    coverage: {
      tools: list(coverage.tools),
      hooks: list(coverage.hooks),
      deniedTools: list(coverage.deniedTools),
    },
    ...(cleanValue(record.sourceDigest) ? { sourceDigest: cleanValue(record.sourceDigest) } : {}),
    ...(Array.isArray(record.transitiveVia) && record.transitiveVia.length > 0
      ? { transitiveVia: record.transitiveVia.map(String).filter(Boolean) }
      : {}),
  };
}

function normalizeFeatureEntry(raw: Partial<StudioFeatureEntry>): StudioFeatureEntry | null {
  const name = cleanValue(raw.name);
  const modulePath = cleanValue(raw.modulePath);
  if (!name || !modulePath) return null;
  const entry: StudioFeatureEntry = { name, modulePath, status: normalizeFeatureStatus(raw.status) };
  const packageName = cleanValue(raw.package);
  if (packageName) entry.package = packageName;
  const exportName = cleanValue(raw.export);
  if (exportName) entry.export = exportName;
  const rawSource = raw.source as unknown as Record<string, unknown> | undefined;
  if (rawSource?.kind === 'project') {
    const projectDir = cleanValue(rawSource.projectDir);
    const sourceEntry = cleanValue(rawSource.entry);
    const buildCommand = Array.isArray(rawSource.buildCommand) ? rawSource.buildCommand.map(String).filter(Boolean) : [];
    if (projectDir && sourceEntry && buildCommand.length > 0) {
      entry.source = { kind: 'project', projectDir, entry: sourceEntry, buildCommand };
    }
  }
  const verification = normalizeVerification(raw.verification);
  if (verification && verification.lastVerifiedRunId) entry.verification = verification;
  const rawStaticInject = raw.staticInject;
  if (Array.isArray(rawStaticInject) && rawStaticInject.length > 0) {
    entry.staticInject = rawStaticInject.map(String).filter(Boolean);
  }
  const rawSnapshot = raw.snapshot as unknown as Record<string, unknown> | undefined;
  if (rawSnapshot) {
    const version = cleanValue(rawSnapshot.version);
    const archivePath = cleanValue(rawSnapshot.archivePath);
    const archiveDigest = cleanValue(rawSnapshot.archiveDigest);
    const createdAt = cleanValue(rawSnapshot.createdAt);
    if (version && archivePath && archiveDigest && createdAt) entry.snapshot = { version, archivePath, archiveDigest, createdAt };
  }
  return entry;
}

function normalizeTestRuntimeStatus(value: unknown): TestRuntimeStatus {
  return value === 'running' || value === 'stopped' ? value : 'not-provisioned';
}

function getDefaultStatePath(): string {
  return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'agent-studio', 'state.json');
}

function getProjectPath(projectDir: string): string {
  return join(projectDir, PROJECT_FILE_NAME);
}

export function normalizeAssertion(raw: unknown): StudioAssertion {
  if (!raw || typeof raw !== 'object') {
    throw new Error('断言必须是对象，形如 { kind, ... }。五种 kind：tool-executed / tool-denied / tool-result-path / reply-includes / hook-observed。');
  }
  const record = raw as Record<string, unknown>;
  const kind = cleanValue(record.kind) as AssertionKind;
  if (!ASSERTION_KINDS.includes(kind)) {
    throw new Error(`断言 kind 「${kind || '(空)'}」不合法。可选：${ASSERTION_KINDS.join(' / ')}。`);
  }
  const assertion: StudioAssertion = { kind };
  const tool = cleanValue(record.tool);
  const assign = (key: keyof StudioAssertion, value: unknown) => {
    (assertion as unknown as Record<string, unknown>)[key] = value;
  };
  switch (kind) {
    case 'tool-executed':
    case 'tool-denied':
    case 'tool-result-path': {
      if (!tool) throw new Error(`断言 kind=${kind} 需要非空 tool 字段（工具名）。`);
      assign('tool', tool);
      if (kind === 'tool-executed' && typeof record.count === 'number' && record.count > 0) assign('count', record.count);
      if (kind === 'tool-denied' && cleanValue(record.reasonIncludes)) assign('reasonIncludes', cleanValue(record.reasonIncludes));
      if (kind === 'tool-result-path') {
        const path = cleanValue(record.path);
        if (!path.startsWith('$')) {
          throw new Error(`tool-result-path 需要 path 字段且以 $ 开头（如 $.openCount、$.items[0].title），收到：${path || '(空)'}`);
        }
        assign('path', path);
        if (typeof record.occurrence === 'number' && record.occurrence > 0) assign('occurrence', record.occurrence);
        if (Object.prototype.hasOwnProperty.call(record, 'equals')) assign('equals', record.equals);
        else throw new Error('tool-result-path 需要 equals 字段（期望值，深度比较）。');
      }
      break;
    }
    case 'reply-includes': {
      const text = cleanValue(record.text);
      if (!text) throw new Error('reply-includes 需要非空 text 字段。');
      assign('text', text);
      break;
    }
    case 'hook-observed': {
      const lifecycle = cleanValue(record.lifecycle);
      if (!lifecycle) throw new Error('hook-observed 需要 lifecycle 字段（如 ToolUse / ToolResultTransform / CallStart）。');
      assign('lifecycle', lifecycle);
      if (cleanValue(record.feature)) assign('feature', cleanValue(record.feature));
      if (cleanValue(record.method)) assign('method', cleanValue(record.method));
      if (cleanValue(record.subject)) assign('subject', cleanValue(record.subject));
      break;
    }
  }
  return assertion;
}

function normalizeSessionPolicy(value: unknown): SessionPolicy {
  return value === 'stateful' || value === 'checkpointed' ? value : 'fresh';
}

export function normalizeTestCase(raw: Partial<StudioTestCase>): StudioTestCase | null {
  const id = cleanValue(raw.id);
  const title = cleanValue(raw.title);
  const input = cleanValue(raw.input);
  if (!id || !title || !input) return null;
  const sessionPolicy = normalizeSessionPolicy(raw.sessionPolicy);
  const checkpoint = cleanValue(raw.checkpoint);
  if (sessionPolicy === 'checkpointed' && !checkpoint) return null;
  const assertions = Array.isArray(raw.assertions)
    ? raw.assertions.map((item) => normalizeAssertion(item))
    : [];
  const test: StudioTestCase = {
    id,
    title,
    input,
    sessionPolicy,
    ...(checkpoint ? { checkpoint } : {}),
    assertions,
    enabled: raw.enabled !== false,
    createdAt: cleanValue(raw.createdAt),
    updatedAt: cleanValue(raw.updatedAt),
  };
  if (cleanValue(raw.description)) test.description = cleanValue(raw.description);
  return test;
}

function normalizeProject(raw: Partial<AgentStudioProject>): AgentStudioProject | null {
  const name = cleanValue(raw.name);
  if (!name) return null;
  const tests = Array.isArray(raw.tests)
    ? raw.tests.map((item) => normalizeTestCase(item || {})).filter(Boolean) as StudioTestCase[]
    : [];
  const features = Array.isArray(raw.features)
    ? raw.features.map((item) => normalizeFeatureEntry(item || {})).filter(Boolean) as StudioFeatureEntry[]
    : [];
  const rawAgent = raw.agent as unknown as Record<string, unknown> | undefined;
  const agentProjectDir = cleanValue(rawAgent?.projectDir);
  const agentMetadataPath = cleanValue(rawAgent?.metadataPath);
  const agent = agentProjectDir && agentMetadataPath
    ? { projectDir: agentProjectDir, metadataPath: agentMetadataPath }
    : undefined;
  return {
    schemaVersion: 3,
    name,
    goal: cleanValue(raw.goal),
    targetAgent: cleanValue(raw.targetAgent),
    ...(agent ? { agent } : {}),
    features,
    testRuntime: {
      status: normalizeTestRuntimeStatus(raw.testRuntime?.status),
    },
    tests,
    createdAt: cleanValue(raw.createdAt),
    updatedAt: cleanValue(raw.updatedAt),
  };
}

function describeCoverage(coverage: StudioFeatureCoverage): string {
  const parts: string[] = [];
  if (coverage.tools.length > 0) parts.push(`工具 ${coverage.tools.join('/')}`);
  if (coverage.hooks.length > 0) parts.push(`钩子 ${coverage.hooks.join('/')}`);
  if (coverage.deniedTools.length > 0) parts.push(`被拒工具 ${coverage.deniedTools.join('/')}`);
  return parts.join('，');
}

function buildProjectMarkdown(
  projectDir: string,
  project: AgentStudioProject | null,
  liveStatus: TestRuntimeStatus | 'not-initialized',
  lastRun: StudioRunRecord | null,
): string {
  if (!project) {
    return [
      '## Agent Studio 项目状态',
      '',
      `- 项目目录：${projectDir || '未设置'}`,
      '- 当前还没有 `agent-studio.json`。先确认目标 Agent、要开发的能力和第一个可观察测试，再初始化项目。',
    ].join('\n');
  }

  const featureLines = project.features.length > 0
    ? project.features.flatMap((feature) => {
        const line = `  - ${feature.name}：${feature.status}（${feature.modulePath}）`;
        if (feature.status === 'verified' && feature.verification) {
          return [line, `    验证证据：${describeCoverage(feature.verification.coverage)}（${feature.verification.lastVerifiedRunId}）`];
        }
        return [line];
      })
    : ['  （尚未注册开发中的 Feature）'];
  const testLines = project.tests.length > 0
    ? project.tests.map((test) => `  - ${test.id}${test.enabled ? '' : '（已停用）'}：${test.title}，策略 ${test.sessionPolicy}${test.checkpoint ? `（${test.checkpoint}）` : ''}，断言 ${test.assertions.length} 条`)
    : ['  （尚未定义测试）'];
  const runLine = lastRun
    ? (() => {
        const passedCount = lastRun.assertionResults.filter((item) => item.ok).length;
        const base = `- 最近一次运行（${lastRun.runId}）：phase=${lastRun.phase} ok=${lastRun.ok} passed=${lastRun.passed}`;
        if (lastRun.assertionResults.length > 0) {
          return `${base}，断言 ${passedCount}/${lastRun.assertionResults.length} 通过`;
        }
        return base;
      })()
    : '- 尚无运行记录';

  return [
    '## Agent Studio 项目状态',
    '',
    `- 项目：${project.name}`,
    `- 目标 Agent：${project.targetAgent || '未指定（最小被测 Agent）'}`,
    `- 目标：${project.goal || '未指定'}`,
    `- Test Runtime 状态：${liveStatus}`,
    '- 开发中 Feature：',
    ...featureLines,
    '- 测试：',
    ...testLines,
    runLine,
    '',
    '注意事项：implemented 只代表代码存在；Feature 状态由运行证据推进——挂载成功为 mounted，测试断言全部通过且证据归属到该 Feature 才是 verified。装配顺序由 static inject 自动拓扑排序，注册顺序无关。修改源码后 studio_run_test 自动热载并重验。',
  ].join('\n');
}

// ── run 记录 ─────────────────────────────────────────────────

function getRunsPath(projectDir: string): string {
  return join(projectDir, RUNS_DIR_NAME, RUNS_FILE_NAME);
}

async function readRuns(projectDir: string): Promise<StudioRunRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(getRunsPath(projectDir), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed as StudioRunRecord[] : [];
  } catch {
    return [];
  }
}

function truncateRunEvidence(record: StudioRunRecord): StudioRunRecord {
  const toolCalls = record.toolCalls.map((entry) => ({
    ...entry,
    ...(entry.result !== undefined
      ? { result: typeof entry.result === 'string' && entry.result.length > RUNS_RESULT_TRUNCATE ? `${entry.result.slice(0, RUNS_RESULT_TRUNCATE)}…` : entry.result }
      : {}),
  }));
  return { ...record, toolCalls };
}

async function appendRun(projectDir: string, record: StudioRunRecord): Promise<void> {
  const existing = await readRuns(projectDir);
  const next = [truncateRunEvidence(record), ...existing].slice(0, RUNS_KEEP_COUNT);
  await fs.mkdir(join(projectDir, RUNS_DIR_NAME), { recursive: true });
  await fs.writeFile(getRunsPath(projectDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

async function markRuntimeStopped(projectDir: string): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(getProjectPath(projectDir), 'utf8')) as Partial<AgentStudioProject>;
    const project = normalizeProject(raw);
    if (project && project.testRuntime.status === 'running') {
      project.testRuntime.status = 'stopped';
      await fs.writeFile(getProjectPath(projectDir), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    }
  } catch {
    // 项目文件缺失/损坏时不强行写入
  }
}

// ── 工具参数 schema 片段 ──────────────────────────────────────

const assertionParameterSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...ASSERTION_KINDS], description: '断言类型。' },
    tool: { type: 'string', description: '工具名（tool-executed / tool-denied / tool-result-path 必填）。' },
    count: { type: 'number', description: 'tool-executed：最少执行次数，缺省 1。' },
    reasonIncludes: { type: 'string', description: 'tool-denied：拒绝原因需包含的子串。' },
    occurrence: { type: 'number', description: 'tool-result-path：匹配第几次调用（从 1 开始），缺省取最后一次。' },
    path: { type: 'string', description: 'tool-result-path：结果 JSON 路径，如 $.openCount、$.items[0].title。' },
    equals: { type: ['string', 'number', 'boolean', 'object', 'array'], description: 'tool-result-path：期望值（深度比较）。按目标字段的真实类型传值：数值传 number（4 不要写成 "4"），布尔传 boolean（true 不要写成 "true"）。' },
    text: { type: 'string', description: 'reply-includes：回复需包含的文本。' },
    feature: { type: 'string', description: 'hook-observed：feature 名过滤。' },
    lifecycle: { type: 'string', description: 'hook-observed：生命周期名（ToolUse / ToolResultTransform 等）。' },
    method: { type: 'string', description: 'hook-observed：钩子方法名过滤。' },
    subject: { type: 'string', description: 'hook-observed：关联工具名过滤。' },
  },
  required: ['kind'],
};

// ── Feature 主体 ──────────────────────────────────────────────

export class AgentStudioFeature implements AgentFeature {
  static hooks: HookDeclarations = {
    injectProjectState: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' },
  };

  readonly name = 'agent-studio';
  readonly source = import.meta.url;
  readonly description = 'Agent Studio 控制面：统一项目模型、Test Runtime 生命周期、装配拓扑、结构化断言测试与 Feature 级验证账本。';

  private readonly workspaceDir: string;
  private readonly statePath: string;
  private readonly agentRegistryPath?: string;
  private packageInfo: PackageInfo | null = null;
  private activeProjectDir: string | null = null;

  constructor(config: AgentStudioFeatureConfig = {}) {
    this.workspaceDir = config.workspaceDir || process.cwd();
    this.statePath = config.statePath || getDefaultStatePath();
    this.agentRegistryPath = config.agentRegistryPath;
  }

  getPackageInfo(): PackageInfo | null {
    return this.packageInfo;
  }

  /**
   * 把 Studio 登记的 Agent 同步进全局注册表（claw run 的消费入口）。
   * 注册失败不阻塞项目内登记（agent-debug 只依赖项目档案），但显式返回原因与修复指引，
   * 保证"消费端收口"始终可见而非静默丢失。
   */
  private async syncGlobalAgentRegistration(
    agentDir: string,
    metadataPath: string,
    projectDir: string,
  ): Promise<{ ok: true; id: string } | { ok: false; error: string; hint: string }> {
    type AgentRegistryModule = {
      registerAgentProject: (input: {
        projectDir: string;
        metadataPath: string;
        studioProjectDir?: string;
        registryPath?: string;
      }) => Promise<{ id: string }>;
    };
    try {
      const module = await import(findAgentRegistryModuleUrl()) as AgentRegistryModule;
      const record = await module.registerAgentProject({
        projectDir: agentDir,
        metadataPath,
        studioProjectDir: projectDir,
        ...(this.agentRegistryPath ? { registryPath: this.agentRegistryPath } : {}),
      });
      return { ok: true, id: record.id };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        hint: '全局注册未完成，claw run 暂不能消费该 Agent；项目内登记与 agent-debug 不受影响。按 error 修复后重新执行 studio_register_agent 即可补齐。',
      };
    }
  }

  getTemplateNames(): string[] {
    return [];
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {}

  captureState(): FeatureStateSnapshot {
    return { activeProjectDir: this.activeProjectDir || '' };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const restored = cleanValue((snapshot as Record<string, unknown>)?.activeProjectDir);
    this.activeProjectDir = restored || this.activeProjectDir;
  }

  private async readWorkspaceState(): Promise<WorkspaceState> {
    try {
      return JSON.parse(await fs.readFile(this.statePath, 'utf8')) as WorkspaceState;
    } catch {
      return {};
    }
  }

  private async resolveProjectDirectory(): Promise<string> {
    if (this.activeProjectDir) return this.activeProjectDir;
    const state = await this.readWorkspaceState();
    return cleanValue(state.openDirectory) || this.workspaceDir;
  }

  private async readProject(projectDir: string): Promise<AgentStudioProject | null> {
    if (!projectDir) return null;
    try {
      return normalizeProject(JSON.parse(await fs.readFile(getProjectPath(projectDir), 'utf8')) as AgentStudioProject);
    } catch {
      return null;
    }
  }

  private async requireProject(): Promise<{ projectDir: string; project: AgentStudioProject }> {
    const projectDir = await this.resolveProjectDirectory();
    const project = await this.readProject(projectDir);
    if (!project) {
      throw new Error('当前目录尚未初始化 Agent Studio 项目。请先调用 studio_initialize_project。');
    }
    return { projectDir, project };
  }

  private async writeProject(projectDir: string, project: AgentStudioProject): Promise<void> {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(getProjectPath(projectDir), `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  }

  private getRegistryPath(): string {
    return join(dirname(this.statePath), REGISTRY_FILE_NAME);
  }

  private async readRegistry(): Promise<StudioProjectEntry[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.getRegistryPath(), 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as StudioProjectEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async updateRegistry(projectDir: string, project: AgentStudioProject): Promise<void> {
    const entry: StudioProjectEntry = {
      projectDir,
      name: project.name,
      goal: project.goal,
      targetAgent: project.targetAgent,
      updatedAt: project.updatedAt,
    };
    const rest = (await this.readRegistry()).filter((item) => item.projectDir !== projectDir);
    const next = [...rest, entry].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    await fs.mkdir(dirname(this.getRegistryPath()), { recursive: true });
    await fs.writeFile(this.getRegistryPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  }

  private liveRuntimeStatus(projectDir: string, project: AgentStudioProject | null): TestRuntimeStatus | 'not-initialized' {
    if (!project) return 'not-initialized';
    if (getRuntimeHandle(projectDir)) return 'running';
    return project.testRuntime.status === 'running' ? 'stopped' : project.testRuntime.status;
  }

  getTools(): Tool[] {
    return [
      createTool({
        name: 'studio_get_project',
        description: '读取当前 Agent Studio 项目的配置、开发中 Feature（含验证证据）、Test Runtime 实时状态和最近运行记录。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const projectDir = await this.resolveProjectDirectory();
          const project = await this.readProject(projectDir);
          const runs = await readRuns(projectDir);
          return {
            projectDir,
            projectFile: getProjectPath(projectDir),
            project,
            runtimeStatus: this.liveRuntimeStatus(projectDir, project),
            lastRun: runs[0] || null,
            runCount: runs.length,
          };
        },
      }),
      createTool({
        name: 'studio_initialize_project',
        description: '初始化或更新当前目录的 Agent Studio 项目（agent-studio.json）。已有测试和 Feature 注册保持不变。',
        parameters: {
          type: 'object',
          properties: {
            projectDir: { type: 'string', description: '项目根目录；默认使用当前工作空间目录。' },
            name: { type: 'string', description: '项目名称。' },
            goal: { type: 'string', description: '要开发或装配的能力目标。' },
            targetAgent: { type: 'string', description: '待测目标 Agent 名称；纯 Feature 开发可传空字符串。' },
          },
          required: ['name'],
        },
        execute: async (args: Record<string, unknown>) => {
          const resolvedProjectDir = cleanValue(args.projectDir) || await this.resolveProjectDirectory();
          if (!resolvedProjectDir) throw new Error('项目目录不能为空。请先在工作空间选择项目目录，或显式传入 projectDir。');
          const existing = await this.readProject(resolvedProjectDir);
          const timestamp = new Date().toISOString();
          const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(args, key);
          const project = normalizeProject({
            ...(existing || {}),
            name: hasOwn('name') ? cleanValue(args.name) : existing?.name,
            goal: hasOwn('goal') ? cleanValue(args.goal) : existing?.goal,
            targetAgent: hasOwn('targetAgent') ? cleanValue(args.targetAgent) : existing?.targetAgent,
            features: existing?.features || [],
            testRuntime: {
              status: existing?.testRuntime?.status || 'not-provisioned',
            },
            tests: existing?.tests || [],
            createdAt: existing?.createdAt || timestamp,
            updatedAt: timestamp,
          });
          if (!project) throw new Error('项目名称不能为空。');
          await this.writeProject(resolvedProjectDir, project);
          await this.updateRegistry(resolvedProjectDir, project);
          this.activeProjectDir = resolvedProjectDir;
          return { projectDir: resolvedProjectDir, projectFile: getProjectPath(resolvedProjectDir), project };
        },
      }),
      createTool({
        name: 'studio_create_feature',
        description: '在当前 Studio 项目下创建、安装并注册一个标准 AgentDev Feature npm 项目。传入小写 kebab-case 名称；之后直接编辑 src 并运行测试。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Feature 名称，仅允许小写字母、数字和连字符，例如 ticket-feature。' },
            parentDir: { type: 'string', description: '父目录，相对 Studio 项目根目录；默认 features。' },
          },
          required: ['name'],
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const name = cleanValue(args.name);
          if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
            throw new Error('Feature 名称仅允许小写字母、数字和连字符，且必须以字母开头。');
          }
          const parentDir = resolve(projectDir, cleanValue(args.parentDir) || 'features');
          const cliPath = findCreateFeatureCliPath();
          await fs.mkdir(parentDir, { recursive: true });
          await runProjectCommand(parentDir, process.execPath, [cliPath, name]);
          const featureProjectDir = join(parentDir, name);
          await runProjectCommand(featureProjectDir, 'npm', ['install', '--no-fund', '--no-audit']);
          const entry = await readFeatureProjectEntry(featureProjectDir, projectDir);
          const timestamp = new Date().toISOString();
          const features = [...project.features.filter((item) => item.name !== entry.name), entry];
          await this.writeProject(projectDir, { ...project, features, updatedAt: timestamp });
          return { projectDir, featureProjectDir, feature: entry, featureCount: features.length };
        },
      }),
      createTool({
        name: 'studio_add_feature',
        description: '注册一个开发中的 Feature。推荐传 projectDir（标准 npm Feature 项目）；legacy 模块可继续传 name + modulePath。',
        parameters: {
          type: 'object',
          properties: {
            projectDir: { type: 'string', description: '标准 Feature npm 项目目录；自动读取 package.json 和 dist 入口。' },
            name: { type: 'string', description: 'legacy 模块的 feature 名（与实例 name 属性一致）。' },
            modulePath: { type: 'string', description: 'legacy ESM 模块路径。' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const sourceProjectDir = cleanValue(args.projectDir);
          let entry: StudioFeatureEntry;
          if (sourceProjectDir) {
            entry = await readFeatureProjectEntry(resolve(projectDir, sourceProjectDir), projectDir);
          } else {
            const name = cleanValue(args.name);
            const rawModulePath = cleanValue(args.modulePath);
            if (!name || !rawModulePath) throw new Error('请传 projectDir，或同时传 name 和 modulePath。');
            const modulePath = resolve(projectDir, rawModulePath);
            if (!existsSync(modulePath)) throw new Error(`模块文件不存在：${modulePath}。请先创建模块文件再注册。`);
            entry = { name, modulePath, status: 'implemented' };
          }
          const timestamp = new Date().toISOString();
          const rest = project.features.filter((item) => item.name !== entry.name);
          const features = [...rest, entry];
          await this.writeProject(projectDir, { ...project, features, updatedAt: timestamp });
          return { projectDir, feature: entry, featureCount: features.length };
        },
      }),
      createTool({
        name: 'studio_remove_feature',
        description: '从项目中移除一个 Feature 注册。若 Test Runtime 正在运行，同时从运行时卸载。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要移除的 feature 名。' },
          },
          required: ['name'],
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const name = cleanValue(args.name);
          if (!name) throw new Error('name 不能为空。');
          const existing = project.features.find((item) => item.name === name);
          if (!existing) throw new Error(`Feature ${name} 不在项目注册表中。`);
          const handle = getRuntimeHandle(projectDir);
          let runtimeUpdated = false;
          if (handle) {
            const removed = await runtimeRequest(projectDir, handle, {
              type: 'studio-remove-feature',
              featureName: name,
            }, SYNC_TIMEOUT_MS);
            if (removed.ok !== true) {
              const error = removed.error as { message?: string } | undefined;
              throw new Error(`从 Test Runtime 卸载失败：${error?.message || '未知错误'}`);
            }
            handle.fingerprints.delete(name);
            runtimeUpdated = true;
          }
          const timestamp = new Date().toISOString();
          const features = project.features.filter((item) => item.name !== name);
          await this.writeProject(projectDir, { ...project, features, updatedAt: timestamp });
          return { projectDir, removed: name, runtimeUpdated, featureCount: features.length };
        },
      }),
      createTool({
        name: 'studio_register_agent',
        description: '登记当前 Studio 项目要在真实装配条件下调试的 Agent，并同步写入全局注册表（claw run 的消费入口）。Agent metadata 负责声明精确 Feature 包版本；Studio 的开发中标准 Feature 会以源码覆盖这些声明。全局注册失败时返回 globalRegistration 说明原因与修复指引，不影响项目内登记与 agent-debug。',
        parameters: {
          type: 'object',
          properties: {
            agentDir: { type: 'string', description: 'Agent 项目目录，相对 Studio 项目根目录或绝对路径。' },
            metadataPath: { type: 'string', description: 'metadata.json 路径；缺省为 <agentDir>/metadata.json。' },
          },
          required: ['agentDir'],
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const agentDir = resolve(projectDir, cleanValue(args.agentDir));
          if (!existsSync(agentDir)) throw new Error(`Agent 项目目录不存在：${agentDir}`);
          const metadataPath = cleanValue(args.metadataPath)
            ? resolve(projectDir, cleanValue(args.metadataPath))
            : join(agentDir, 'metadata.json');
          if (!existsSync(metadataPath)) throw new Error(`Agent metadata 不存在：${metadataPath}`);
          let rawMetadata: unknown;
          try { rawMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')); }
          catch { throw new Error(`Agent metadata 不是合法 JSON：${metadataPath}`); }
          let metadata: Awaited<ReturnType<typeof normalizeStandaloneAgentMetadata>>;
          try {
            metadata = await normalizeStandaloneAgentMetadata(rawMetadata);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
              `Agent Debug 仅支持 standalone metadata 驱动装配：${detail}。built-in / prebuilt Agent 会在 agent.js 中静态 use() Feature，不能通过 studio_register_agent 进入 agent-debug；请改为 feature-harness 验证开发中的 Feature。`,
              { cause: error },
            );
          }
          if (metadata.deployment.kind !== 'standalone') {
            throw new Error(`Agent Debug 仅支持 deployment.kind=standalone；${metadata.id} 当前为 ${metadata.deployment.kind}。workspace、built-in 与 prebuilt Agent 请使用 feature-harness 验证 Feature 本身。`);
          }
          const entryPath = resolve(agentDir, metadata.entry);
          if (!existsSync(entryPath)) throw new Error(`Agent entry 不存在：${entryPath}`);
          const timestamp = new Date().toISOString();
          const agent = { projectDir: agentDir, metadataPath };
          await this.writeProject(projectDir, { ...project, agent, targetAgent: metadata.id, updatedAt: timestamp });
          const globalRegistration = await this.syncGlobalAgentRegistration(agentDir, metadataPath, projectDir);
          return { projectDir, agent, agentId: metadata.id, globalRegistration };
        },
      }),
      createTool({
        name: 'studio_start_runtime',
        description: '启动隔离 Test Runtime。feature-harness 使用最小 Agent；agent-debug 加载 studio_register_agent 登记的真实 Agent，并混装开发源码 Feature 与仓库 Snapshot Feature。会话目录为项目内 .agent-studio/runtime-sessions。',
        parameters: {
          type: 'object',
          properties: {
            modelPreset: { type: 'string', description: '指定模型预设名；缺省依次使用 agent-studio 配置与全局默认模型。' },
            mode: { type: 'string', enum: ['feature-harness', 'agent-debug'], description: 'feature-harness=最小 Agent；agent-debug=真实 Agent。已注册真实 Agent 时默认 agent-debug。' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const existingHandle = getRuntimeHandle(projectDir);
          if (existingHandle) {
            return { projectDir, alreadyRunning: true, model: existingHandle.model };
          }
          const mode = cleanValue(args.mode) || (project.agent ? 'agent-debug' : 'feature-harness');
          if (mode !== 'feature-harness' && mode !== 'agent-debug') throw new Error('mode 只能是 feature-harness 或 agent-debug。');
          if (mode === 'feature-harness' && project.features.length === 0) {
            throw new Error('feature-harness 至少需要注册一个开发中 Feature。');
          }
          for (const feature of project.features) await runFeatureBuild(feature);
          const missing = project.features.filter((feature) => !existsSync(feature.modulePath));
          if (missing.length > 0) {
            throw new Error(`以下 Feature 模块文件不存在：${missing.map((feature) => `${feature.name} (${feature.modulePath})`).join('；')}`);
          }
          const runtimePlanPath = mode === 'agent-debug' ? await prepareAgentDebugPlan(projectDir, project) : '';
          const { ready, handle } = await startRuntimeProcess(projectDir, cleanValue(args.modelPreset), mode, runtimePlanPath);
          for (const feature of project.features) {
            handle.fingerprints.set(feature.name, await fingerprintModule(feature.modulePath));
          }
          if (mode === 'agent-debug') handle.agentFingerprint = await fingerprintAgentDefinition(project);
          const timestamp = new Date().toISOString();
          const nextProject = { ...project, testRuntime: { status: 'running' as const }, updatedAt: timestamp };
          await this.writeProject(projectDir, nextProject);
          return {
            projectDir,
            model: ready.model,
            sessionRestored: ready.sessionRestored === true,
            observability: ready.observability || 'local-only',
            viewerAgentId: handle.viewerAgentId,
            mode,
            runtimePlanPath: runtimePlanPath || null,
            features: ready.features || [],
          };
        },
      }),
      createTool({
        name: 'studio_stop_runtime',
        description: '停止当前项目的 Test Runtime。stateful 测试会话已持久化，下次启动自动恢复。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const { projectDir, project } = await this.requireProject();
          const result = await stopRuntimeProcess(projectDir);
          const timestamp = new Date().toISOString();
          const nextProject = { ...project, testRuntime: { status: 'stopped' as const }, updatedAt: timestamp };
          await this.writeProject(projectDir, nextProject);
          return { projectDir, ...result };
        },
      }),
      createTool({
        name: 'studio_define_test',
        description: '定义测试用例并保存到 agent-studio.json：输入 + 会话策略 + 可执行断言（由运行证据机器判定）。之后用 studio_run_test { testId } 运行。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '稳定测试 ID，例如 create-release-issue。' },
            title: { type: 'string' },
            input: { type: 'string', description: '发送给 Test Runtime 的测试输入。' },
            description: { type: 'string', description: '测试意图说明（供人读，不参与判定）。' },
            sessionPolicy: {
              type: 'string',
              enum: ['fresh', 'stateful', 'checkpointed'],
              description: 'fresh=空上下文+空 Feature 状态（默认，确定性单场景）；stateful=接续 default 会话（多步流程）；checkpointed=从命名检查点恢复且不写回。',
            },
            checkpoint: { type: 'string', description: 'sessionPolicy=checkpointed 时必填：检查点名（studio_save_checkpoint 保存）。' },
            assertions: {
              type: 'array',
              items: assertionParameterSchema,
              description: '可执行断言列表。五种 kind：tool-executed（工具真实执行次数）/ tool-denied（guard 拒绝）/ tool-result-path（投递结果 JSON 路径取值）/ reply-includes（回复包含文本）/ hook-observed（钩子真实触发）。',
            },
          },
          required: ['id', 'title', 'input'],
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const testId = cleanValue(args.id);
          const timestamp = new Date().toISOString();
          let assertions: StudioAssertion[];
          try {
            assertions = Array.isArray(args.assertions)
              ? (args.assertions as unknown[]).map((item) => normalizeAssertion(item))
              : [];
          } catch (error) {
            throw new Error(`测试 ${testId} 的断言定义不合法：${error instanceof Error ? error.message : String(error)}`);
          }
          const sessionPolicy = normalizeSessionPolicy(args.sessionPolicy);
          const checkpoint = cleanValue(args.checkpoint);
          if (sessionPolicy === 'checkpointed' && !checkpoint) {
            throw new Error(`测试 ${testId} 使用 checkpointed 策略，必须提供 checkpoint 名称（先用 studio_save_checkpoint 保存）。`);
          }
          const nextTest = normalizeTestCase({
            id: testId,
            title: cleanValue(args.title),
            input: cleanValue(args.input),
            ...(cleanValue(args.description) ? { description: cleanValue(args.description) } : {}),
            sessionPolicy,
            ...(checkpoint ? { checkpoint } : {}),
            assertions,
            enabled: true,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          if (!nextTest) throw new Error('测试 id、title 和 input 均不能为空。');
          const existingIndex = project.tests.findIndex((item) => item.id === testId);
          const previous = existingIndex >= 0 ? project.tests[existingIndex] : null;
          const tests = [...project.tests];
          const savedTest = { ...nextTest, createdAt: previous?.createdAt || timestamp };
          if (existingIndex >= 0) tests.splice(existingIndex, 1, savedTest);
          else tests.push(savedTest);
          const nextProject = { ...project, tests, updatedAt: timestamp };
          await this.writeProject(projectDir, nextProject);
          return { projectDir, test: savedTest, testCount: tests.length };
        },
      }),
      createTool({
        name: 'studio_list_tests',
        description: '列出当前项目已定义的测试用例（含会话策略与断言）。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const { projectDir, project } = await this.requireProject();
          return { projectDir, tests: project.tests, runtimeStatus: this.liveRuntimeStatus(projectDir, project) };
        },
      }),
      createTool({
        name: 'studio_save_checkpoint',
        description: '把当前 stateful 会话（default）保存为命名检查点，供 checkpointed 策略的测试从此恢复。检查点不会被测试运行写回。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '检查点名称（存储为 cp-<name>）。' },
          },
          required: ['name'],
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir } = await this.requireProject();
          const handle = getRuntimeHandle(projectDir);
          if (!handle) {
            throw new Error('Test Runtime 未运行。请先调用 studio_start_runtime，并以 stateful 策略至少运行一次建立 default 会话。');
          }
          const name = cleanValue(args.name);
          if (!name) throw new Error('检查点名称不能为空。');
          const saved = await runtimeRequest(projectDir, handle, {
            type: 'studio-save-checkpoint',
            name,
          }, SYNC_TIMEOUT_MS);
          if (saved.ok !== true) {
            const error = saved.error as { message?: string } | undefined;
            throw new Error(error?.message || '保存检查点失败。');
          }
          return {
            projectDir,
            checkpoint: String(saved.checkpoint || `cp-${name}`),
            checkpoints: Array.isArray(saved.checkpoints) ? saved.checkpoints : [],
          };
        },
      }),
      createTool({
        name: 'studio_run_test',
        description: '在 Test Runtime 上运行测试：自动检测 Feature 源码变更并热载（按 static inject 拓扑装配，失败自动回退），然后按会话策略准备上下文、发送输入，返回回复全文、逐工具投递结果证据、钩子触发证据与断言判定。运行记录持久化，可用 studio_get_run 查询。',
        parameters: {
          type: 'object',
          properties: {
            testId: { type: 'string', description: '运行 studio_define_test 已定义的测试。' },
            input: { type: 'string', description: '临时测试输入（与 testId 二选一）。' },
            title: { type: 'string', description: '临时测试的标题（仅记录用）。' },
            assertions: {
              type: 'array',
              items: assertionParameterSchema,
              description: '临时断言（仅本次运行生效，不写回测试定义）。' },
            sessionPolicy: {
              type: 'string',
              enum: ['fresh', 'stateful', 'checkpointed'],
              description: '临时运行覆盖会话策略；运行已定义测试时缺省用测试定义的策略。',
            },
            checkpoint: { type: 'string', description: 'checkpointed 策略的检查点名。' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          let handle = getRuntimeHandle(projectDir);
          if (!handle) {
            throw new Error('Test Runtime 未运行。请先调用 studio_start_runtime。');
          }
          if (handle.mode === 'agent-debug') {
            const currentAgentFingerprint = await fingerprintAgentDefinition(project);
            if (currentAgentFingerprint !== handle.agentFingerprint) {
              await stopRuntimeProcess(projectDir);
              const runtimePlanPath = await prepareAgentDebugPlan(projectDir, project);
              const restarted = await startRuntimeProcess(projectDir, '', 'agent-debug', runtimePlanPath);
              handle = restarted.handle;
              handle.agentFingerprint = currentAgentFingerprint;
              for (const feature of project.features) handle.fingerprints.set(feature.name, await fingerprintModule(feature.modulePath));
            }
          }

          const testId = cleanValue(args.testId);
          const input = cleanValue(args.input);
          let testInput = input;
          let assertions: StudioAssertion[];
          let sessionPolicy: SessionPolicy;
          let checkpoint: string;
          let recordedTestId = testId;
          let title = cleanValue(args.title);
          if (testId) {
            const defined = project.tests.find((item) => item.id === testId);
            if (!defined) throw new Error(`测试 ${testId} 不存在。请先调用 studio_define_test 定义。`);
            testInput = defined.input;
            assertions = Array.isArray(args.assertions)
              ? (args.assertions as unknown[]).map((item) => normalizeAssertion(item))
              : defined.assertions;
            sessionPolicy = args.sessionPolicy ? normalizeSessionPolicy(args.sessionPolicy) : defined.sessionPolicy;
            checkpoint = cleanValue(args.checkpoint) || defined.checkpoint || '';
            title = title || defined.title;
          } else {
            if (!testInput) throw new Error('请提供 testId（运行已定义测试）或 input（临时测试）。');
            recordedTestId = 'ad-hoc';
            assertions = Array.isArray(args.assertions)
              ? (args.assertions as unknown[]).map((item) => normalizeAssertion(item))
              : [];
            sessionPolicy = normalizeSessionPolicy(args.sessionPolicy);
            checkpoint = cleanValue(args.checkpoint);
            title = title || 'ad-hoc';
          }
          if (sessionPolicy === 'checkpointed' && !checkpoint) {
            throw new Error('checkpointed 策略需要 checkpoint 名称（先用 studio_save_checkpoint 保存）。');
          }

          const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const startedAt = new Date().toISOString();

          // 1) 同步 Feature 源码到 runtime（ensure 按拓扑序 + reload），runId 透传打日志标签
          const reloadSummary = await syncFeaturesToRuntime(projectDir, handle, project, runId);
          const failedReload = reloadSummary.filter((item) => !item.ok);
          const featureRevisions: Record<string, string> = {};
          for (const feature of project.features) {
            featureRevisions[feature.name] = await fingerprintFeatureSource(feature);
          }
          const sessionBase = {
            policy: sessionPolicy,
            ...(checkpoint ? { checkpoint } : {}),
          };
          if (failedReload.length > 0) {
            const record: StudioRunRecord = {
              runId,
              testId: recordedTestId,
              startedAt,
              finishedAt: new Date().toISOString(),
              phase: 'reload',
              ok: false,
              passed: false,
              assertionResults: [],
              featureCoverage: {},
              featureRevisions,
              session: sessionBase,
              toolCalls: [],
              hooks: [],
              reloadSummary,
            };
            await appendRun(projectDir, record);
            return { run: record, guidance: 'Feature 热载失败，运行未执行；runtime 已回退到上一可用版本，修复源码后重试。' };
          }

          // 2) 发送测试输入（含会话策略）
          const result = await runtimeRequest(projectDir, handle, {
            type: 'studio-run-test',
            testId: recordedTestId,
            input: testInput,
            runId,
            sessionPolicy,
            ...(checkpoint ? { checkpoint } : {}),
          }, RUN_TEST_TIMEOUT_MS);

          const error = result.error as { name?: string; message?: string; stack?: string } | undefined;
          const sessionInfo = (result.session && typeof result.session === 'object' ? result.session : {}) as Record<string, unknown>;
          const session: StudioRunRecord['session'] = {
            ...sessionBase,
            restoredFrom: typeof sessionInfo.restoredFrom === 'string' ? sessionInfo.restoredFrom : (sessionInfo.restoredFrom === null ? null : undefined),
            saved: typeof sessionInfo.saved === 'string' ? sessionInfo.saved : (sessionInfo.saved === null ? null : undefined),
          };

          if (result.ok !== true && !Array.isArray(result.toolCalls)) {
            // 运行前失败（如检查点不存在）：无行为证据
            const record: StudioRunRecord = {
              runId,
              testId: recordedTestId,
              startedAt,
              finishedAt: new Date().toISOString(),
              phase: 'test',
              ok: false,
              passed: false,
              assertionResults: [],
              featureCoverage: {},
              featureRevisions,
              session,
              toolCalls: [],
              hooks: [],
              reloadSummary,
              ...(error ? { error: { name: error.name || 'Error', message: error.message || '', stack: error.stack } } : {}),
            };
            await appendRun(projectDir, record);
            return { run: record };
          }

          // 3) 断言判定（针对完整投递结果，落盘时才截断）
          const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls as StudioToolCallEvidence[] : [];
          const hooks = Array.isArray(result.hooks) ? result.hooks as StudioHookEvidence[] : [];
          const reply = typeof result.reply === 'string' ? result.reply : undefined;
          const assertionResults = evaluateAssertions(assertions, { reply, toolCalls, hooks });
          const callOk = result.ok === true;
          const hasAssertions = assertions.length > 0;
          const passed = hasAssertions ? callOk && assertionResults.every((item) => item.ok) : null;
          const featureCoverage = computeFeatureCoverage(toolCalls, hooks);

          const record: StudioRunRecord = {
            runId,
            testId: recordedTestId,
            startedAt,
            finishedAt: new Date().toISOString(),
            phase: 'test',
            ok: callOk,
            passed,
            assertionResults,
            featureCoverage,
            featureRevisions,
            session,
            ...(reply !== undefined ? { reply } : {}),
            toolCalls,
            hooks,
            reloadSummary,
            ...(error ? { error: { name: error.name || 'Error', message: error.message || '', stack: error.stack } } : {}),
          };
          await appendRun(projectDir, record);

          // 4) Feature 状态推进：按 reloadSummary 与覆盖证据独立推进每个 Feature；
          //    依赖图（static inject）随本次同步回写进项目档案，供传递覆盖判定
          const timestamp = new Date().toISOString();
          const featuresWithInject = project.features.map((feature) => ({
            ...feature,
            staticInject: handle.featureInject.get(feature.name) ?? feature.staticInject,
          }));
          const features = advanceFeatureStatuses(featuresWithInject, reloadSummary, featureCoverage, passed, runId, timestamp, featureRevisions);
          await this.writeProject(projectDir, { ...project, features, updatedAt: timestamp });

          const deniedTools = [...new Set(toolCalls.filter((entry) => entry.denied).map((entry) => entry.tool))];
          const deniedMissing = assertionResults
            .filter((item) => !item.ok && item.assertion.kind === 'tool-executed' && deniedTools.includes(item.assertion.tool || ''))
            .map((item) => item.assertion.tool || '');
          const guidance = deniedMissing.length > 0
            ? `期望工具 ${[...new Set(deniedMissing)].join(', ')} 被调用但被拦截（denied，真实执行 0 次）。被拒调用不算 executed：若这是 guard 拒绝路径，请用 tool-denied 断言拒绝本身、或断言可观察的下游证据；若不应被拒，请检查 guard 逻辑。`
            : undefined;
          return {
            run: record,
            featureStatuses: features.map((feature) => ({ name: feature.name, status: feature.status })),
            ...(guidance ? { guidance } : {}),
          };
        },
      }),
      createTool({
        name: 'studio_create_snapshot',
        description: '为已验证且未变化的标准 Feature 项目创建不可变本地 tgz Snapshot，并写入用户 Feature 仓库。不会发布到外部系统，也不会修改 Claw 根依赖。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要创建快照的 Studio Feature 名。' },
          },
          required: ['name'],
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const name = cleanValue(args.name);
          const feature = project.features.find((item) => item.name === name);
          if (!feature) throw new Error(`Feature ${name} 不在项目注册表中。`);
          if (!feature.source) throw new Error(`Feature ${name} 是 legacy 模块；请先升级为标准 npm Feature 项目后再创建 Snapshot。`);
          if (feature.status !== 'verified' || !feature.verification?.sourceDigest) {
            throw new Error(`Feature ${name} 尚未通过当前源码的验证。请先运行带可执行断言且覆盖该 Feature 的 studio_run_test。`);
          }
          await runFeatureBuild(feature);
          const currentDigest = await fingerprintFeatureSource(feature);
          if (currentDigest !== feature.verification.sourceDigest) {
            throw new Error(`Feature ${name} 的构建产物已变化，之前验证已失效。请重新运行测试后再创建 Snapshot。`);
          }
          const snapshot = await runSnapshotScript(feature.source.projectDir);
          const timestamp = new Date().toISOString();
          const features = project.features.map((item) => item.name === name
            ? { ...item, status: 'snapshotted' as const, snapshot }
            : item);
          await this.writeProject(projectDir, { ...project, features, updatedAt: timestamp });
          return { projectDir, feature: name, snapshot };
        },
      }),
      createTool({
        name: 'studio_get_run',
        description: '查询运行记录：带 runId 返回完整记录（断言判定、逐工具投递证据、钩子证据、覆盖归属），不带参数返回最近记录列表。',
        parameters: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: '要查看的运行 ID。' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir } = await this.requireProject();
          const runs = await readRuns(projectDir);
          const runId = cleanValue(args.runId);
          if (runId) {
            const record = runs.find((item) => item.runId === runId) || null;
            if (!record) throw new Error(`运行记录 ${runId} 不存在。`);
            return { projectDir, run: record };
          }
          return { projectDir, runs: runs.map(({ runId: id, testId, phase, ok, passed, startedAt }) => ({ runId: id, testId, phase, ok, passed, startedAt })) };
        },
      }),
    ];
  }

  async injectProjectState(ctx: CallStartContext): Promise<void> {
    // 会话创建时 run-prebuilt-agent 会以空输入调用 preInjectCallStart 预注入；
    // 首轮真实调用会再次触发 CallStart，跳过空输入避免同一轮注入两次。
    if (!ctx.input || !ctx.input.trim()) return;
    const projectDir = await this.resolveProjectDirectory();
    const project = await this.readProject(projectDir);
    const runs = await readRuns(projectDir);
    ctx.context.add({
      role: 'system',
      content: buildProjectMarkdown(projectDir, project, this.liveRuntimeStatus(projectDir, project), runs[0] || null),
    });
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'CallStart' && methodName === 'injectProjectState') {
      return '每轮开始时注入当前 Agent Studio 项目的真实状态（Feature、Test Runtime、最近运行）。';
    }
    return undefined;
  }
}
