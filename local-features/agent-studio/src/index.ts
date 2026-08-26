import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { AgentFeature, CallStartContext, FeatureInitContext, FeatureStateSnapshot, HookDeclarations, PackageInfo } from '@agentdevjs/core';
import { CoreLifecycle } from '@agentdevjs/core';
import type { AgentStudioProject, WorkspaceState, StudioProjectEntry, TestRuntimeStatus } from './project-store.js';
import {
  cleanValue,
  getDefaultStatePath,
  getProjectPath,
  normalizeProject,
  readRuns,
  buildProjectMarkdown,
  REGISTRY_FILE_NAME,
} from './project-store.js';
import { findAgentRegistryModuleUrl, getRuntimeHandle } from './runtime-process.js';
import { buildStudioTools } from './tools.js';

// ── 模块拆分后的 re-export（对外契约保持不变：测试与消费方均从本入口导入） ──

export {
  ASSERTION_KINDS,
  getPathValue,
  deepEqual,
  evaluateAssertions,
  computeFeatureCoverage,
  advanceFeatureStatuses,
  normalizeAssertion,
  normalizeSessionPolicy,
  normalizeTestCase,
  type AssertionKind,
  type SessionPolicy,
  type StudioAssertion,
  type StudioTestCase,
  type StudioFeatureVerification,
  type StudioToolCallEvidence,
  type StudioHookEvidence,
  type StudioFeatureCoverage,
  type AssertionEvaluation,
  type StudioRunRecord,
} from './assertions.js';

export {
  PROJECT_FILE_NAME,
  REGISTRY_FILE_NAME,
  RUNS_DIR_NAME,
  RUNS_FILE_NAME,
  RUNS_KEEP_COUNT,
  RUNS_RESULT_TRUNCATE,
  cleanValue,
  normalizeFeatureStatus,
  normalizeFeatureEntry,
  normalizeTestRuntimeStatus,
  getDefaultStatePath,
  getProjectPath,
  normalizeProject,
  describeCoverage,
  buildProjectMarkdown,
  getRunsPath,
  readRuns,
  appendRun,
  markRuntimeStopped,
  type TestRuntimeStatus,
  type StudioFeatureSource,
  type StudioFeatureSnapshot,
  type StudioFeatureStatus,
  type StudioFeatureEntry,
  type StudioAgentDefinition,
  type AgentStudioProject,
  type WorkspaceState,
  type StudioProjectEntry,
} from './project-store.js';

export {
  READY_TIMEOUT_MS,
  SYNC_TIMEOUT_MS,
  RUN_TEST_TIMEOUT_MS,
  INSPECT_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  findProjectScript,
  findAgentRegistryModuleUrl,
  findCreateFeatureCliPath,
  normalizeStandaloneAgentMetadata,
  getRuntimePlanPath,
  getRuntimeOverridesPath,
  getRuntimeHandle,
  fingerprintModule,
  fingerprintAgentDefinition,
  fingerprintFeatureSource,
  runProjectCommand,
  runFeatureBuild,
  runSnapshotScript,
  prepareAgentDebugPlan,
  runtimeRequest,
  startRuntimeProcess,
  stopRuntimeProcess,
  syncFeaturesToRuntime,
  readFeatureProjectEntry,
  type StudioReadyPayload,
  type RuntimeHandle,
} from './runtime-process.js';

export { assertionParameterSchema, buildStudioTools } from './tools.js';

export interface AgentStudioFeatureConfig {
  workspaceDir?: string;
  statePath?: string;
  /** 覆盖全局 Agent 注册表路径（默认用户目录 agent-registry.json；测试用） */
  agentRegistryPath?: string;
}

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
  activeProjectDir: string | null = null;

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
  async syncGlobalAgentRegistration(
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

  resolveProjectDirectory(): Promise<string> {
    if (this.activeProjectDir) return Promise.resolve(this.activeProjectDir);
    return this.readWorkspaceState().then((state) => cleanValue(state.openDirectory) || this.workspaceDir);
  }

  async readProject(projectDir: string): Promise<AgentStudioProject | null> {
    if (!projectDir) return null;
    try {
      return normalizeProject(JSON.parse(await fs.readFile(getProjectPath(projectDir), 'utf8')) as AgentStudioProject);
    } catch {
      return null;
    }
  }

  async requireProject(): Promise<{ projectDir: string; project: AgentStudioProject }> {
    const projectDir = await this.resolveProjectDirectory();
    const project = await this.readProject(projectDir);
    if (!project) {
      throw new Error('当前目录尚未初始化 Agent Studio 项目。请先调用 studio_initialize_project。');
    }
    return { projectDir, project };
  }

  async writeProject(projectDir: string, project: AgentStudioProject): Promise<void> {
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

  async updateRegistry(projectDir: string, project: AgentStudioProject): Promise<void> {
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

  liveRuntimeStatus(projectDir: string, project: AgentStudioProject | null): TestRuntimeStatus | 'not-initialized' {
    if (!project) return 'not-initialized';
    if (getRuntimeHandle(projectDir)) return 'running';
    return project.testRuntime.status === 'running' ? 'stopped' : project.testRuntime.status;
  }

  getTools() {
    return buildStudioTools(this);
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
