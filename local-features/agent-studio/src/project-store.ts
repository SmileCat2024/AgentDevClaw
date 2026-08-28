// ── 项目档案 / registry / runs 持久化 + normalize 层 ──────────
//
// 从 index.ts 原样迁出。项目模型（AgentStudioProject）与磁盘形态
// （agent-studio.json / projects.json / runs.json）的读写都收敛在本模块。

import os from 'os';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import type { StudioFeatureVerification, StudioTestCase, StudioRunRecord } from './assertions.js';
import { normalizeTestCase, type StudioFeatureCoverage } from './assertions.js';

export type TestRuntimeStatus = 'not-provisioned' | 'running' | 'stopped';

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

export interface AgentStudioProject {
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

export interface WorkspaceState {
  forms?: Record<string, Record<string, string>>;
  openDirectory?: string;
}

export interface StudioProjectEntry {
  projectDir: string;
  name: string;
  goal: string;
  targetAgent: string;
  updatedAt: string;
}

// ── 常量 ──────────────────────────────────────────────────────

export const PROJECT_FILE_NAME = 'agent-studio.json';
export const REGISTRY_FILE_NAME = 'projects.json';
export const RUNS_DIR_NAME = '.agent-studio';
export const RUNS_FILE_NAME = 'runs.json';
export const RUNS_KEEP_COUNT = 30;
export const RUNS_RESULT_TRUNCATE = 2000;

// ── 项目文件读写 ──────────────────────────────────────────────

export function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

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
  return override ? resolve(override) : join(os.homedir(), '.agentdev', 'AgentDevClaw');
}

export function getDefaultStatePath(): string {
  return join(resolveUserDataDir(), 'workspaces', 'agent-studio', 'state.json');
}

export function getProjectPath(projectDir: string): string {
  return join(projectDir, PROJECT_FILE_NAME);
}

export function normalizeProject(raw: Partial<AgentStudioProject>): AgentStudioProject | null {
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

export function describeCoverage(coverage: StudioFeatureCoverage): string {
  const parts: string[] = [];
  if (coverage.tools.length > 0) parts.push(`工具 ${coverage.tools.join('/')}`);
  if (coverage.hooks.length > 0) parts.push(`钩子 ${coverage.hooks.join('/')}`);
  if (coverage.deniedTools.length > 0) parts.push(`被拒工具 ${coverage.deniedTools.join('/')}`);
  return parts.join('，');
}

export function buildProjectMarkdown(
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

export function getRunsPath(projectDir: string): string {
  return join(projectDir, RUNS_DIR_NAME, RUNS_FILE_NAME);
}

export async function readRuns(projectDir: string): Promise<StudioRunRecord[]> {
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

export async function appendRun(projectDir: string, record: StudioRunRecord): Promise<void> {
  const existing = await readRuns(projectDir);
  const next = [truncateRunEvidence(record), ...existing].slice(0, RUNS_KEEP_COUNT);
  await fs.mkdir(join(projectDir, RUNS_DIR_NAME), { recursive: true });
  await fs.writeFile(getRunsPath(projectDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

export async function markRuntimeStopped(projectDir: string): Promise<void> {
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

