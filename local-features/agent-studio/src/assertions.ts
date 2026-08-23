// ── 可执行断言引擎 ────────────────────────────────────────────
//
// 纯函数区段：从 index.ts 原样迁出，无实例依赖。
// 测试经 index.ts 的 re-export 直接消费本模块符号。

import { cleanValue, type StudioFeatureEntry } from './project-store.js';

export const ASSERTION_KINDS = ['tool-executed', 'tool-denied', 'tool-result-path', 'reply-includes', 'hook-observed'] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export type SessionPolicy = 'fresh' | 'stateful' | 'checkpointed';

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

// ── 输入 normalize（schema 校验 + 精确报错） ───────────────────

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

export function normalizeSessionPolicy(value: unknown): SessionPolicy {
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
