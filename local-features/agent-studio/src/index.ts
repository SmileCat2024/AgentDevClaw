import os from 'os';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import type { AgentFeature, CallStartContext, FeatureInitContext, FeatureStateSnapshot, HookDeclarations, PackageInfo, Tool } from 'agentdev';
import { CoreLifecycle, createTool } from 'agentdev';

export interface AgentStudioFeatureConfig {
  workspaceDir?: string;
  statePath?: string;
}

type TestRuntimeMode = 'shared' | 'workspace-copy' | 'restricted';
type TestRuntimeStatus = 'not-provisioned' | 'running' | 'stopped';
type StudioFeatureStatus = 'implemented' | 'mounted' | 'verified';

interface StudioFeatureEntry {
  name: string;
  modulePath: string;
  status: StudioFeatureStatus;
}

interface StudioTestCase {
  id: string;
  title: string;
  input: string;
  expectedEvidence: string;
  expectedToolCalls: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentStudioProject {
  schemaVersion: 1;
  name: string;
  goal: string;
  targetAgent: string;
  features: StudioFeatureEntry[];
  testRuntime: {
    mode: TestRuntimeMode;
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
  ok: boolean;
  durationMs: number;
  result?: string;
  error?: string;
  at: string;
  /** true = 调用被拦截（guard Deny / 工具禁用），execute 从未执行 */
  denied?: boolean;
}

export interface StudioRunRecord {
  runId: string;
  testId: string;
  startedAt: string;
  finishedAt: string;
  phase: 'reload' | 'test';
  ok: boolean;
  /** true = 期望工具全部观察到；false = 有缺失；null = 本次运行没有可机检的期望 */
  passed: boolean | null;
  expectedToolCalls: string[];
  matchedToolCalls: string[];
  missingToolCalls: string[];
  /** 本次运行中被拦截（未真实执行）的期望外工具名，供拒绝路径取证 */
  deniedToolCalls?: string[];
  reply?: string;
  toolCalls: StudioToolCallEvidence[];
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

/** 评估工具调用证据是否覆盖期望（纯函数，测试直接覆盖）。 */
export function evaluateToolCalls(
  evidenceToolNames: string[],
  expectedToolCalls: string[],
): { matchedToolCalls: string[]; missingToolCalls: string[] } {
  const present = new Set(evidenceToolNames);
  const matchedToolCalls = expectedToolCalls.filter((name) => present.has(name));
  const missingToolCalls = expectedToolCalls.filter((name) => !present.has(name));
  return { matchedToolCalls, missingToolCalls };
}

const PROJECT_FILE_NAME = 'agent-studio.json';
const REGISTRY_FILE_NAME = 'projects.json';
const RUNS_DIR_NAME = '.agent-studio';
const RUNS_FILE_NAME = 'runs.json';
const RUNS_KEEP_COUNT = 30;
const READY_TIMEOUT_MS = 60_000;
const RELOAD_TIMEOUT_MS = 30_000;
const RUN_TEST_TIMEOUT_MS = 300_000;
const INSPECT_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

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
  model: string | null;
  viewerAgentId: string | null;
}

const runtimeHandles = new Map<string, RuntimeHandle>();
let runtimeScriptPath: string | null = null;

function findRuntimeScriptPath(): string {
  if (runtimeScriptPath) return runtimeScriptPath;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, 'scripts', 'run-studio-runtime.js');
    if (existsSync(candidate)) {
      runtimeScriptPath = candidate;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('找不到 scripts/run-studio-runtime.js；请确认在 AgentDevClaw 仓库环境中运行。');
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
    const stat = await fs.stat(modulePath);
    return `${stat.size}-${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return 'missing';
  }
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
): Promise<{ ready: StudioReadyPayload; handle: RuntimeHandle }> {
  const scriptPath = findRuntimeScriptPath();
  const viewerPort = Number(process.env.AGENTDEV_VIEWER_PORT || 2026);
  const child = spawn(process.execPath, [scriptPath, projectDir], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: projectDir,
    env: { ...process.env, STUDIO_MODEL_PRESET: modelPreset, STUDIO_VIEWER_PORT: String(viewerPort) },
  });
  const handle: RuntimeHandle = { child, pending: new Map(), fingerprints: new Map(), model: null, viewerAgentId: null };
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

// run-test 前把项目 features 同步进 runtime：未挂载的 ensure，变更的 reload。
// runTag 透传给子进程打日志标签（runId 或 'startup'），供日志流按运行批次过滤。
async function syncFeaturesToRuntime(
  projectDir: string,
  handle: RuntimeHandle,
  project: AgentStudioProject,
  runTag = 'startup',
): Promise<StudioRunRecord['reloadSummary']> {
  const summary: StudioRunRecord['reloadSummary'] = [];
  const inspectResult = await runtimeRequest(projectDir, handle, {
    type: 'studio-inspect',
  }, INSPECT_TIMEOUT_MS).catch(() => null);
  const mountedFeatures = inspectResult && Array.isArray(inspectResult.features)
    ? new Set(inspectResult.features as string[])
    : new Set<string>();
  for (const feature of project.features) {
    const currentFingerprint = await fingerprintModule(feature.modulePath);
    if (!mountedFeatures.has(feature.name)) {
      const ensured = await runtimeRequest(projectDir, handle, {
        type: 'studio-ensure-feature',
        featureName: feature.name,
        modulePath: feature.modulePath,
        runId: runTag,
      }, RELOAD_TIMEOUT_MS);
      if (ensured.ok) {
        handle.fingerprints.set(feature.name, currentFingerprint);
        summary.push({ featureName: feature.name, action: 'ensure-mounted', ok: true });
      } else {
        const error = ensured.error as { message?: string } | undefined;
        summary.push({
          featureName: feature.name,
          action: 'failed',
          ok: false,
          stage: typeof ensured.stage === 'string' ? ensured.stage : undefined,
          error: error?.message || 'ensure 失败',
        });
      }
      continue;
    }
    if (handle.fingerprints.get(feature.name) === currentFingerprint) {
      summary.push({ featureName: feature.name, action: 'unchanged', ok: true });
      continue;
    }
    const reloaded = await runtimeRequest(projectDir, handle, {
      type: 'studio-reload-feature',
      featureName: feature.name,
      modulePath: feature.modulePath,
      runId: runTag,
    }, RELOAD_TIMEOUT_MS);
    if (reloaded.ok) {
      handle.fingerprints.set(feature.name, currentFingerprint);
      summary.push({
        featureName: feature.name,
        action: 'reloaded',
        ok: true,
        durationMs: typeof reloaded.durationMs === 'number' ? reloaded.durationMs : undefined,
        stateTransferred: reloaded.stateTransferred === true,
      });
    } else {
      const error = reloaded.error as { message?: string } | undefined;
      summary.push({
        featureName: feature.name,
        action: 'failed',
        ok: false,
        stage: typeof reloaded.stage === 'string' ? reloaded.stage : undefined,
        reverted: reloaded.reverted === true,
        error: error?.message || 'reload 失败',
      });
    }
  }
  return summary;
}

// ── 项目文件读写 ──────────────────────────────────────────────

function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeFeatureStatus(value: unknown): StudioFeatureStatus {
  return value === 'mounted' || value === 'verified' ? value : 'implemented';
}

function normalizeFeatureEntry(raw: Partial<StudioFeatureEntry>): StudioFeatureEntry | null {
  const name = cleanValue(raw.name);
  const modulePath = cleanValue(raw.modulePath);
  if (!name || !modulePath) return null;
  return { name, modulePath, status: normalizeFeatureStatus(raw.status) };
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

function normalizeTestRuntimeMode(value: unknown): TestRuntimeMode {
  return value === 'workspace-copy' || value === 'restricted' ? value : 'shared';
}

function normalizeTestCase(raw: Partial<StudioTestCase>): StudioTestCase | null {
  const id = cleanValue(raw.id);
  const title = cleanValue(raw.title);
  const input = cleanValue(raw.input);
  if (!id || !title || !input) return null;
  return {
    id,
    title,
    input,
    expectedEvidence: cleanValue(raw.expectedEvidence),
    expectedToolCalls: Array.isArray(raw.expectedToolCalls)
      ? raw.expectedToolCalls.map(cleanValue).filter(Boolean)
      : [],
    enabled: raw.enabled !== false,
    createdAt: cleanValue(raw.createdAt),
    updatedAt: cleanValue(raw.updatedAt),
  };
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
  return {
    schemaVersion: 1,
    name,
    goal: cleanValue(raw.goal),
    targetAgent: cleanValue(raw.targetAgent),
    features,
    testRuntime: {
      mode: normalizeTestRuntimeMode(raw.testRuntime?.mode),
      status: normalizeTestRuntimeStatus(raw.testRuntime?.status),
    },
    tests,
    createdAt: cleanValue(raw.createdAt),
    updatedAt: cleanValue(raw.updatedAt),
  };
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
    ? project.features.map((feature) => `  - ${feature.name}：${feature.status}（${feature.modulePath}）`)
    : ['  （尚未注册开发中的 Feature）'];
  const testLines = project.tests.length > 0
    ? project.tests.map((test) => `  - ${test.id}${test.enabled ? '' : '（已停用）'}：${test.title}${test.expectedToolCalls.length > 0 ? `，期望工具：${test.expectedToolCalls.join(', ')}` : ''}`)
    : ['  （尚未定义测试）'];
  const runLine = lastRun
    ? `- 最近一次运行（${lastRun.runId}）：phase=${lastRun.phase} ok=${lastRun.ok} passed=${lastRun.passed}${lastRun.missingToolCalls?.length ? `，缺失工具：${lastRun.missingToolCalls.join(', ')}` : ''}${lastRun.deniedToolCalls?.length ? `，被拦截工具：${lastRun.deniedToolCalls.join(', ')}（未真实执行）` : ''}`
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
    '注意事项：feature 状态为 implemented 时只代表代码存在；只有经过 Test Runtime 挂载/运行产生的结果才可称为 mounted/verified。修改 Feature 源码后调用 studio_run_test 会自动完成重新挂载与测试。',
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

async function appendRun(projectDir: string, record: StudioRunRecord): Promise<void> {
  const existing = await readRuns(projectDir);
  const next = [record, ...existing].slice(0, RUNS_KEEP_COUNT);
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

// ── Feature 主体 ─────────────────────────────────────────────

export class AgentStudioFeature implements AgentFeature {
  static hooks: HookDeclarations = {
    injectProjectState: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' },
  };

  readonly name = 'agent-studio';
  readonly source = import.meta.url;
  readonly description = 'Agent Studio 控制面：统一项目模型、Test Runtime 生命周期、热载与可归因测试运行。';

  private readonly workspaceDir: string;
  private readonly statePath: string;
  private packageInfo: PackageInfo | null = null;
  private activeProjectDir: string | null = null;

  constructor(config: AgentStudioFeatureConfig = {}) {
    this.workspaceDir = config.workspaceDir || process.cwd();
    this.statePath = config.statePath || getDefaultStatePath();
  }

  getPackageInfo(): PackageInfo | null {
    return this.packageInfo;
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
        description: '读取当前 Agent Studio 项目的配置、开发中 Feature、Test Runtime 实时状态和最近运行记录。',
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
              mode: 'shared',
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
        name: 'studio_add_feature',
        description: '注册一个开发中的 Feature：给出 feature 名与 ESM 模块文件路径。模块需导出 feature 类且 name 属性与注册名一致。先写好模块文件再调用。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'feature 名（与模块内实例的 name 属性一致）。' },
            modulePath: { type: 'string', description: 'feature 模块文件的绝对路径或相对项目目录的路径（ESM JS，如 features/demo/index.mjs）。' },
          },
          required: ['name', 'modulePath'],
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const name = cleanValue(args.name);
          const rawModulePath = cleanValue(args.modulePath);
          if (!name || !rawModulePath) throw new Error('name 和 modulePath 均不能为空。');
          const modulePath = resolve(projectDir, rawModulePath);
          if (!existsSync(modulePath)) {
            throw new Error(`模块文件不存在：${modulePath}。请先创建模块文件再注册。`);
          }
          const timestamp = new Date().toISOString();
          const entry: StudioFeatureEntry = { name, modulePath, status: 'implemented' };
          const rest = project.features.filter((item) => item.name !== name);
          const features = [...rest, entry];
          const nextProject = { ...project, features, updatedAt: timestamp };
          await this.writeProject(projectDir, nextProject);
          return { projectDir, feature: entry, featureCount: features.length };
        },
      }),
      createTool({
        name: 'studio_start_runtime',
        description: '启动当前项目的 Test Runtime：独立进程加载最小被测 Agent 与全部开发中 Feature，初始化失败会直接报错。会话目录为项目内 .agent-studio/runtime-sessions。',
        parameters: {
          type: 'object',
          properties: {
            modelPreset: { type: 'string', description: '指定模型预设名；缺省依次使用 agent-studio 配置与全局默认模型。' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const existingHandle = getRuntimeHandle(projectDir);
          if (existingHandle) {
            return { projectDir, alreadyRunning: true, model: existingHandle.model };
          }
          if (project.features.length === 0) {
            throw new Error('项目尚未注册任何开发中 Feature。请先用 studio_add_feature 注册至少一个模块。');
          }
          const missing = project.features.filter((feature) => !existsSync(feature.modulePath));
          if (missing.length > 0) {
            throw new Error(`以下 Feature 模块文件不存在：${missing.map((feature) => `${feature.name} (${feature.modulePath})`).join('；')}`);
          }
          const { ready, handle } = await startRuntimeProcess(projectDir, cleanValue(args.modelPreset));
          for (const feature of project.features) {
            handle.fingerprints.set(feature.name, await fingerprintModule(feature.modulePath));
          }
          const timestamp = new Date().toISOString();
          const nextProject = { ...project, testRuntime: { ...project.testRuntime, status: 'running' as const }, updatedAt: timestamp };
          await this.writeProject(projectDir, nextProject);
          return {
            projectDir,
            model: ready.model,
            sessionRestored: ready.sessionRestored === true,
            observability: ready.observability || 'local-only',
            viewerAgentId: handle.viewerAgentId,
            features: ready.features || [],
          };
        },
      }),
      createTool({
        name: 'studio_stop_runtime',
        description: '停止当前项目的 Test Runtime。测试会话已持久化，下次启动自动恢复。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const { projectDir, project } = await this.requireProject();
          const result = await stopRuntimeProcess(projectDir);
          const timestamp = new Date().toISOString();
          const nextProject = { ...project, testRuntime: { ...project.testRuntime, status: 'stopped' as const }, updatedAt: timestamp };
          await this.writeProject(projectDir, nextProject);
          return { projectDir, ...result };
        },
      }),
      createTool({
        name: 'studio_run_test',
        description: '在 Test Runtime 上运行测试：自动检测 Feature 源码变更并热载（失败自动回退上一版本），然后发送测试输入，返回回复全文、逐工具执行证据与期望比对结果。运行记录持久化，可用 studio_get_run 查询。',
        parameters: {
          type: 'object',
          properties: {
            testId: { type: 'string', description: '运行 studio_define_test 已定义的测试。' },
            input: { type: 'string', description: '临时测试输入（与 testId 二选一）。' },
            expectedToolCalls: {
              type: 'array',
              items: { type: 'string' },
              description: '临时期望的工具名列表；全部被观察到才算通过。临时运行不写回测试定义。',
            },
            title: { type: 'string', description: '临时测试的标题（仅记录用）。' },
          },
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const handle = getRuntimeHandle(projectDir);
          if (!handle) {
            throw new Error('Test Runtime 未运行。请先调用 studio_start_runtime。');
          }

          const testId = cleanValue(args.testId);
          const input = cleanValue(args.input);
          let testInput = input;
          let expectedToolCalls: string[];
          let recordedTestId = testId;
          let title = cleanValue(args.title);
          if (testId) {
            const defined = project.tests.find((item) => item.id === testId);
            if (!defined) throw new Error(`测试 ${testId} 不存在。请先调用 studio_define_test 定义。`);
            testInput = defined.input;
            expectedToolCalls = Array.isArray(args.expectedToolCalls)
              ? (args.expectedToolCalls as unknown[]).map(cleanValue).filter(Boolean)
              : defined.expectedToolCalls;
            title = title || defined.title;
          } else {
            if (!testInput) throw new Error('请提供 testId（运行已定义测试）或 input（临时测试）。');
            recordedTestId = 'ad-hoc';
            expectedToolCalls = Array.isArray(args.expectedToolCalls)
              ? (args.expectedToolCalls as unknown[]).map(cleanValue).filter(Boolean)
              : [];
            title = title || 'ad-hoc';
          }

          const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const startedAt = new Date().toISOString();

          // 1) 同步 Feature 源码到 runtime（ensure/reload），runId 随消息透传打日志标签
          const reloadSummary = await syncFeaturesToRuntime(projectDir, handle, project, runId);
          const failedReload = reloadSummary.filter((item) => !item.ok);
          if (failedReload.length > 0) {
            const record: StudioRunRecord = {
              runId,
              testId: recordedTestId,
              startedAt,
              finishedAt: new Date().toISOString(),
              phase: 'reload',
              ok: false,
              passed: false,
              expectedToolCalls,
              matchedToolCalls: [],
              // 测试未执行，不产生行为证据；缺失列表保持为空，由 phase 表达"未运行"
              missingToolCalls: [],
              toolCalls: [],
              reloadSummary,
            };
            await appendRun(projectDir, record);
            return { run: record, guidance: 'Feature 热载失败，运行未执行；runtime 已回退到上一可用版本，修复源码后重试。' };
          }

          // 2) 发送测试输入
          const result = await runtimeRequest(projectDir, handle, {
            type: 'studio-run-test',
            testId: recordedTestId,
            input: testInput,
            runId,
          }, RUN_TEST_TIMEOUT_MS);

          const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls as StudioToolCallEvidence[] : [];
          // 被拦截的调用（denied）未真实执行，不算 invoked
          const evidenceToolNames = toolCalls.filter((entry) => !entry.denied).map((entry) => entry.tool);
          const { matchedToolCalls, missingToolCalls } = evaluateToolCalls(evidenceToolNames, expectedToolCalls);
          const deniedToolCalls = [...new Set(toolCalls.filter((entry) => entry.denied).map((entry) => entry.tool))];
          const callOk = result.ok === true;
          const hasExpectation = expectedToolCalls.length > 0;
          const passed = hasExpectation ? callOk && missingToolCalls.length === 0 : null;
          const error = result.error as { name?: string; message?: string; stack?: string } | undefined;

          const record: StudioRunRecord = {
            runId,
            testId: recordedTestId,
            startedAt,
            finishedAt: new Date().toISOString(),
            phase: 'test',
            ok: callOk,
            passed,
            expectedToolCalls,
            matchedToolCalls,
            missingToolCalls,
            ...(deniedToolCalls.length > 0 ? { deniedToolCalls } : {}),
            reply: typeof result.reply === 'string' ? result.reply : undefined,
            toolCalls,
            reloadSummary,
            ...(error ? { error: { name: error.name || 'Error', message: error.message || '', stack: error.stack } } : {}),
          };
          await appendRun(projectDir, record);

          // 3) 状态推进：本次重新挂载 → mounted；期望全部观察到 → verified
          //    （测试通过必然以挂载为前提，verified 蕴含 mounted）
          const timestamp = new Date().toISOString();
          const features = project.features.map((feature) => {
            const summaryEntry = reloadSummary.find((item) => item.featureName === feature.name);
            let status = feature.status;
            if (summaryEntry && (summaryEntry.action === 'reloaded' || summaryEntry.action === 'ensure-mounted')) {
              status = 'mounted';
            }
            if (passed === true) {
              status = 'verified';
            }
            return { ...feature, status };
          });
          const nextProject = { ...project, features, updatedAt: timestamp };
          await this.writeProject(projectDir, nextProject);

          const deniedMissing = missingToolCalls.filter((name) => deniedToolCalls.includes(name));
          const runTestGuidance = deniedMissing.length > 0
            ? `期望工具 ${deniedMissing.join(', ')} 被调用但被拦截（denied，真实执行 0 次）。被拒调用不算 invoked：若这是 guard 拒绝路径，请改为断言可观察的下游证据（如拒绝记录查询工具）而非被拒工具本身；若不应被拒，请检查 guard 逻辑。`
            : undefined;
          return {
            run: record,
            featureStatuses: features.map((feature) => ({ name: feature.name, status: feature.status })),
            ...(runTestGuidance ? { guidance: runTestGuidance } : {}),
          };
        },
      }),
      createTool({
        name: 'studio_get_run',
        description: '查询运行记录：带 runId 返回完整记录（含逐工具证据），不带参数返回最近记录列表。',
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
      createTool({
        name: 'studio_define_test',
        description: '为当前项目定义测试用例并保存到 agent-studio.json：测试输入 + 期望观察到的工具名（可机检）。之后用 studio_run_test { testId } 运行。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '稳定测试 ID，例如 create-release-issue。' },
            title: { type: 'string' },
            input: { type: 'string', description: '发送给 Test Runtime 的测试输入。' },
            expectedEvidence: { type: 'string', description: '期望观察到的现象描述（供人读）。' },
            expectedToolCalls: {
              type: 'array',
              items: { type: 'string' },
              description: '期望被调用的工具名列表；测试通过要求全部观察到。',
            },
          },
          required: ['id', 'title', 'input'],
        },
        execute: async (args: Record<string, unknown>) => {
          const { projectDir, project } = await this.requireProject();
          const testId = cleanValue(args.id);
          const timestamp = new Date().toISOString();
          const nextTest = normalizeTestCase({
            id: testId,
            title: cleanValue(args.title),
            input: cleanValue(args.input),
            expectedEvidence: cleanValue(args.expectedEvidence),
            expectedToolCalls: Array.isArray(args.expectedToolCalls)
              ? (args.expectedToolCalls as unknown[]).map(cleanValue).filter(Boolean)
              : [],
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
        description: '列出当前项目已定义的测试用例。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const { projectDir, project } = await this.requireProject();
          return { projectDir, tests: project.tests, runtimeStatus: this.liveRuntimeStatus(projectDir, project) };
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
