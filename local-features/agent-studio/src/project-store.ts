// ── 目录环境清单（agent-studio.json，schema 5）持久化 + normalize 层 ──
//
// feature-first 模型（ADR-0022）下的分工：
//   - 本模块：目录级环境——工具链、测试定义、Test Runtime 状态、agent-debug
//     登记。清单文件落在 Studio 目录内，只描述"这个目录的环境"。
//   - feature-store.ts：feature 级记账——状态机、验证账本、快照，跨目录
//     收敛在全局 features.json。
//
// schema 4（旧"项目"档案）的读取兼容在 normalize 层完成：features[] 交还
// 调用方迁移进全局注册表，name/goal/environment/projectDir 直接丢弃。

import { homedir } from 'os';
import { promises as fs } from 'fs';
import { join, resolve as resolvePath } from 'path';
import type { StudioFeatureVerification, StudioTestCase, StudioRunRecord } from './assertions.js';
import { normalizeTestCase, type StudioFeatureCoverage } from './assertions.js';
import { cleanValue } from './clean-value.js';

export type TestRuntimeStatus = 'not-provisioned' | 'running' | 'stopped';
export interface StudioToolchain { source: 'bundled' | 'system' | 'custom'; nodePath: string; npmPath: string }

export interface StudioFeatureSource {
  kind: 'project';
  projectDir: string;
  entry: string;
  buildCommand: string[];
}

export interface StudioFeatureSnapshot {
  version: string;
  archivePath: string;
  archiveDigest: string;
  createdAt: string;
}

export type StudioFeatureStatus = 'implemented' | 'mounted' | 'verified' | 'snapshotted';

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

export interface StudioAgentDefinition {
  projectDir: string;
  metadataPath: string;
}

/** schema 5：目录环境清单 */
export interface StudioEnvironmentManifest {
  schemaVersion: 5;
  toolchain?: StudioToolchain;
  agent?: StudioAgentDefinition;
  targetAgent: string;
  testRuntime: {
    status: TestRuntimeStatus;
  };
  tests: StudioTestCase[];
  createdAt: string;
  updatedAt: string;
}

/** 磁盘上可能的旧形态（schema ≤ 4）：多出的字段在读取时剥离 */
export interface StudioManifestFile {
  raw?: Record<string, unknown>;
  manifest: StudioEnvironmentManifest;
  /** schema ≤ 4 档案里的 features[]，交还调用方迁移进全局注册表 */
  legacyFeatures: StudioFeatureEntry[];
}

export interface WorkspaceState {
  forms?: Record<string, Record<string, string>>;
  openDirectory?: string;
}

// ── 常量 ──────────────────────────────────────────────────────

export const MANIFEST_FILE_NAME = 'agent-studio.json';
export const LEGACY_REGISTRY_FILE_NAME = 'projects.json';
export const RUNS_DIR_NAME = '.agent-studio';
export const RUNS_FILE_NAME = 'runs.json';
export const RUNS_KEEP_COUNT = 30;
export const RUNS_RESULT_TRUNCATE = 2000;

// ── 清单读写 ──────────────────────────────────────────────────

export function normalizeFeatureStatus(value: unknown): StudioFeatureStatus {
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

export function normalizeFeatureEntry(raw: Partial<StudioFeatureEntry>): StudioFeatureEntry | null {
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

export function normalizeTestRuntimeStatus(value: unknown): TestRuntimeStatus {
  return value === 'running' || value === 'stopped' ? value : 'not-provisioned';
}

// 与 server/shared/constants.js 的 resolveUserDataDir 同语义（TS 独立构建无法
// 直接复用）：AGENTDEV_DATA_DIR 仅用于多实例/测试场景，未设置时保持默认布局。
export function resolveUserDataDir(): string {
  const override = process.env.AGENTDEV_DATA_DIR?.trim();
  return override ? resolvePath(override) : join(homedir(), '.agentdev', 'AgentDevClaw');
}

export function getDefaultStatePath(): string {
  return join(resolveUserDataDir(), 'workspaces', 'agent-studio', 'state.json');
}

export function getManifestPath(directory: string): string {
  return join(directory, MANIFEST_FILE_NAME);
}

/**
 * 解析清单文件内容。schema ≤ 4 的旧档案返回 schema 5 清单 + legacyFeatures
 * （由调用方迁移进全局注册表）；schema 5 正常解析；内容不合法返回 null。
 */
export function parseManifestFile(raw: unknown): StudioManifestFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const schemaVersion = Number(record.schemaVersion);
  const legacyFeatures = (schemaVersion >= 5 ? [] : Array.isArray(record.features)
    ? record.features.map((item) => normalizeFeatureEntry(item as Partial<StudioFeatureEntry>)).filter(Boolean) as StudioFeatureEntry[]
    : []);
  const tests = Array.isArray(record.tests)
    ? record.tests.map((item) => normalizeTestCase(item || {})).filter(Boolean) as StudioTestCase[]
    : [];
  const rawToolchain = record.toolchain as Record<string, unknown> | undefined;
  const toolchain = rawToolchain && (rawToolchain.source === 'bundled' || rawToolchain.source === 'system' || rawToolchain.source === 'custom')
    && cleanValue(rawToolchain.nodePath) && cleanValue(rawToolchain.npmPath)
    ? { source: rawToolchain.source as StudioToolchain['source'], nodePath: cleanValue(rawToolchain.nodePath), npmPath: cleanValue(rawToolchain.npmPath) }
    : undefined;
  const rawAgent = record.agent as Record<string, unknown> | undefined;
  const agentProjectDir = cleanValue(rawAgent?.projectDir);
  const agentMetadataPath = cleanValue(rawAgent?.metadataPath);
  const agent = agentProjectDir && agentMetadataPath
    ? { projectDir: agentProjectDir, metadataPath: agentMetadataPath }
    : undefined;
  const createdAt = cleanValue(record.createdAt) || new Date().toISOString();
  const manifest: StudioEnvironmentManifest = {
    schemaVersion: 5,
    ...(toolchain ? { toolchain } : {}),
    targetAgent: cleanValue(record.targetAgent),
    testRuntime: {
      status: normalizeTestRuntimeStatus((record.testRuntime as Record<string, unknown> | undefined)?.status),
    },
    tests,
    ...(agent ? { agent } : {}),
    createdAt,
    updatedAt: cleanValue(record.updatedAt) || createdAt,
  };
  return { raw: record, manifest, legacyFeatures };
}

export async function readManifestFile(directory: string): Promise<StudioManifestFile | null> {
  if (!directory) return null;
  try {
    return parseManifestFile(JSON.parse(await fs.readFile(getManifestPath(directory), 'utf8')));
  } catch {
    return null;
  }
}

export async function writeManifest(directory: string, manifest: StudioEnvironmentManifest): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(getManifestPath(directory), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function describeCoverage(coverage: StudioFeatureCoverage): string {
  const parts: string[] = [];
  if (coverage.tools.length > 0) parts.push(`工具 ${coverage.tools.join('/')}`);
  if (coverage.hooks.length > 0) parts.push(`钩子 ${coverage.hooks.join('/')}`);
  if (coverage.deniedTools.length > 0) parts.push(`被拒工具 ${coverage.deniedTools.join('/')}`);
  return parts.join('，');
}

export function buildDirectoryStatusMarkdown(
  directory: string,
  manifest: StudioEnvironmentManifest | null,
  features: StudioFeatureEntry[],
  liveStatus: TestRuntimeStatus | 'not-initialized',
  lastRun: StudioRunRecord | null,
): string {
  if (!manifest) {
    return [
      '## 当前目录与 Feature 状态',
      '',
      `- 目录：${directory || '未设置'}`,
      '- 本目录还没有 agent-studio.json。开发需要 Node/npm 的 Feature 前会先确认三件事：做什么能力、用什么工具链；目录即当前会话的工作目录。',
    ].join('\n');
  }

  const featureLines = features.length > 0
    ? features.flatMap((feature) => {
        const line = `  - ${feature.name}：${feature.status}（${feature.modulePath}）`;
        if (feature.status === 'verified' && feature.verification) {
          return [line, `    验证证据：${describeCoverage(feature.verification.coverage)}（${feature.verification.lastVerifiedRunId}）`];
        }
        return [line];
      })
    : ['  （本目录尚未注册开发中的 Feature）'];
  const testLines = manifest.tests.length > 0
    ? manifest.tests.map((test) => `  - ${test.id}${test.enabled ? '' : '（已停用）'}：${test.title}，策略 ${test.sessionPolicy}${test.checkpoint ? `（${test.checkpoint}）` : ''}，断言 ${test.assertions.length} 条`)
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
    '## 当前目录与 Feature 状态',
    '',
    `- 目录：${directory}`,
    `- 开发工具链：${manifest.toolchain ? `${manifest.toolchain.source}（Node: ${manifest.toolchain.nodePath}；npm: ${manifest.toolchain.npmPath}）` : '未选择；开发前先检测环境并请用户选择'}`,
    `- 目标 Agent：${manifest.targetAgent || '未指定（最小被测 Agent）'}`,
    `- Test Runtime 状态：${liveStatus}`,
    '- 本目录开发中的 Feature：',
    ...featureLines,
    '- 测试：',
    ...testLines,
    runLine,
    '',
    '注意事项：implemented 只代表代码存在；Feature 状态由运行证据推进——挂载成功为 mounted，测试断言全部通过且证据归属到该 Feature 才是 verified。装配顺序由 static inject 自动拓扑排序，注册顺序无关。修改源码后 studio_run_test 自动热载并重验。',
  ].join('\n');
}

// ── run 记录 ─────────────────────────────────────────────────

export function getRunsPath(directory: string): string {
  return join(directory, RUNS_DIR_NAME, RUNS_FILE_NAME);
}

export async function readRuns(directory: string): Promise<StudioRunRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(getRunsPath(directory), 'utf8')) as unknown;
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

export async function appendRun(directory: string, record: StudioRunRecord): Promise<void> {
  const existing = await readRuns(directory);
  const next = [truncateRunEvidence(record), ...existing].slice(0, RUNS_KEEP_COUNT);
  await fs.mkdir(join(directory, RUNS_DIR_NAME), { recursive: true });
  await fs.writeFile(getRunsPath(directory), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export async function markRuntimeStopped(directory: string): Promise<void> {
  try {
    const parsed = await readManifestFile(directory);
    if (parsed && parsed.manifest.testRuntime.status === 'running') {
      await writeManifest(directory, {
        ...parsed.manifest,
        testRuntime: { status: 'stopped' },
        updatedAt: new Date().toISOString(),
      });
    }
  } catch {
    // 清单缺失/损坏时不强行写入
  }
}
