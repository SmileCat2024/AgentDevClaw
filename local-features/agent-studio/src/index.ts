import type { AgentFeature, CallStartContext, FeatureInitContext, FeatureStateSnapshot, HookDeclarations, PackageInfo } from '@agentdevjs/core';
import { CoreLifecycle } from '@agentdevjs/core';
import type { StudioEnvironmentManifest, TestRuntimeStatus, StudioFeatureEntry } from './project-store.js';
import {
  getDefaultStatePath,
  buildDirectoryStatusMarkdown,
  readManifestFile,
  readRuns,
  writeManifest,
} from './project-store.js';
import type { StudioFeatureRecord } from './feature-store.js';
import {
  featuresInDirectory,
  readFeatureRegistry,
  registerFeatureRecord,
  upsertFeatureRecords,
  removeFeatureRecord,
} from './feature-store.js';
import { cleanValue } from './clean-value.js';
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

export { cleanValue } from './clean-value.js';

export {
  MANIFEST_FILE_NAME,
  LEGACY_REGISTRY_FILE_NAME,
  RUNS_DIR_NAME,
  RUNS_FILE_NAME,
  RUNS_KEEP_COUNT,
  RUNS_RESULT_TRUNCATE,
  normalizeFeatureStatus,
  normalizeFeatureEntry,
  normalizeTestRuntimeStatus,
  getDefaultStatePath,
  getManifestPath,
  parseManifestFile,
  describeCoverage,
  buildDirectoryStatusMarkdown,
  getRunsPath,
  readRuns,
  appendRun,
  markRuntimeStopped,
  type TestRuntimeStatus,
  type StudioFeatureSource,
  type StudioToolchain,
  type StudioFeatureSnapshot,
  type StudioFeatureStatus,
  type StudioFeatureEntry,
  type StudioAgentDefinition,
  type StudioEnvironmentManifest,
  type StudioManifestFile,
  type WorkspaceState,
} from './project-store.js';

export {
  FEATURE_REGISTRY_FILE_NAME,
  getFeatureRegistryPaths,
  featureRecordId,
  normalizeFeatureRecord,
  readFeatureRegistry,
  writeFeatureRegistry,
  featuresInDirectory,
  registerFeatureRecord,
  upsertFeatureRecords,
  removeFeatureRecord,
  migrateLegacyRegistry,
  deleteLegacyProjectsRegistry,
  type StudioFeatureRecord,
  type LegacyMigrationResult,
} from './feature-store.js';

export {
  READY_TIMEOUT_MS,
  SYNC_TIMEOUT_MS,
  RUN_TEST_TIMEOUT_MS,
  INSPECT_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  findProjectScript,
  findAgentRegistryModuleUrl,
  findCreateFeatureCliPath,
  detectStudioToolchains,
  probeStudioToolchain,
  requireStudioToolchain,
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
  /** 宿主注入：当前会话 id（studio_create_feature 回写会话绑定用；缺省跳过绑定） */
  sessionId?: string;
  /** 宿主注入：宿主 agent id（会话绑定请求寻址用） */
  agentId?: string;
  /** 宿主注入：Claw server origin（缺省 http://127.0.0.1:1420） */
  serverOrigin?: string;
}

export interface StudioDirectoryContext {
  dir: string;
  manifest: StudioEnvironmentManifest;
  features: StudioFeatureRecord[];
}

export class AgentStudioFeature implements AgentFeature {
  static hooks: HookDeclarations = {
    injectProjectState: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' },
  };

  readonly name = 'agent-studio';
  readonly source = import.meta.url;
  readonly description = 'Agent Studio 控制面：feature 一级注册表、目录环境清单、Test Runtime 生命周期、装配拓扑、结构化断言测试与 Feature 级验证账本。';

  private readonly workspaceDir: string;
  private readonly statePath: string;
  private readonly agentRegistryPath?: string;
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly serverOrigin: string;
  private packageInfo: PackageInfo | null = null;
  activeProjectDir: string | null = null;

  constructor(config: AgentStudioFeatureConfig = {}) {
    this.workspaceDir = config.workspaceDir || process.cwd();
    this.statePath = config.statePath || getDefaultStatePath();
    this.agentRegistryPath = config.agentRegistryPath;
    this.sessionId = cleanValue(config.sessionId);
    this.agentId = cleanValue(config.agentId);
    this.serverOrigin = cleanValue(config.serverOrigin) || 'http://127.0.0.1:1420';
  }

  getPackageInfo(): PackageInfo | null {
    return this.packageInfo;
  }

  /**
   * 把 Studio 登记的 Agent 同步进全局注册表（claw run 的消费入口）。
   * 注册失败不阻塞目录内登记（agent-debug 只依赖目录清单），但显式返回原因与修复指引，
   * 保证"消费端收口"始终可见而非静默丢失。
   */
  async syncGlobalAgentRegistration(
    agentDir: string,
    metadataPath: string,
    studioDir: string,
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
        studioProjectDir: studioDir,
        ...(this.agentRegistryPath ? { registryPath: this.agentRegistryPath } : {}),
      });
      return { ok: true, id: record.id };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        hint: '全局注册未完成，claw run 暂不能消费该 Agent；目录内登记与 agent-debug 不受影响。按 error 修复后重新执行 studio_register_agent 即可补齐。',
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

  /**
   * 会话工作目录解析：会话内显式指定（activeProjectDir）优先，否则用运行时
   * 宿主传入的 workspaceDir（= 本会话创建时的 openDirectory）。不读 workspace
   * 级共享状态——那是跨会话漂移的根源（ADR-0022）。
   */
  resolveDirectory(): Promise<string> {
    return Promise.resolve(this.activeProjectDir || this.workspaceDir);
  }

  async readManifest(directory: string): Promise<StudioEnvironmentManifest | null> {
    const parsed = await readManifestFile(directory);
    return parsed ? parsed.manifest : null;
  }

  /**
   * 读取目录上下文（清单 + 该目录的 feature 记录）。schema ≤ 4 的旧档案在此
   * 懒迁移：features[] 进全局注册表（已有记录优先），档案就地升级 schema 5。
   */
  async loadDirectory(directory: string): Promise<StudioDirectoryContext | null> {
    const parsed = await readManifestFile(directory);
    if (!parsed) return null;
    if (parsed.legacyFeatures.length > 0) {
      for (const entry of parsed.legacyFeatures) {
        await registerFeatureRecord(this.statePath, entry, directory);
      }
      await writeManifest(directory, { ...parsed.manifest, updatedAt: new Date().toISOString() });
    }
    const features = featuresInDirectory(await readFeatureRegistry(this.statePath), directory);
    return { dir: directory, manifest: parsed.manifest, features };
  }

  /** 工具面的标准入口：目录必须有清单；schema ≤ 4 懒迁移同 loadDirectory。 */
  async requireDirectory(): Promise<StudioDirectoryContext> {
    const directory = await this.resolveDirectory();
    const loaded = await this.loadDirectory(directory);
    if (!loaded) {
      throw new Error(`目录 ${directory} 尚未初始化。请先调用 studio_select_toolchain 选择工具链，或直接描述需求后调用 studio_create_feature（两者都会自动创建目录清单）。`);
    }
    return loaded;
  }

  /** 懒初始化：清单不存在时创建空清单（schema 5）。 */
  async ensureDirectory(): Promise<StudioDirectoryContext> {
    const directory = await this.resolveDirectory();
    const loaded = await this.loadDirectory(directory);
    if (loaded) return loaded;
    const timestamp = new Date().toISOString();
    const manifest: StudioEnvironmentManifest = {
      schemaVersion: 5,
      targetAgent: '',
      testRuntime: { status: 'not-provisioned' },
      tests: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await writeManifest(directory, manifest);
    return { dir: directory, manifest, features: [] };
  }

  async writeManifestUpdate(directory: string, manifest: StudioEnvironmentManifest): Promise<void> {
    await writeManifest(directory, { ...manifest, updatedAt: new Date().toISOString() });
  }

  listFeatureRecords(directory: string): Promise<StudioFeatureRecord[]> {
    return readFeatureRegistry(this.statePath).then((records) => featuresInDirectory(records, directory));
  }

  /** 全量注册表（create_feature 的包名唯一性检查用）。 */
  listAllFeatureRecords(): Promise<StudioFeatureRecord[]> {
    return readFeatureRegistry(this.statePath);
  }

  registerFeature(entry: StudioFeatureEntry, directory: string, description = ''): Promise<StudioFeatureRecord> {
    return registerFeatureRecord(this.statePath, entry, directory, description);
  }

  /** 全值写回（状态推进/快照落账）。 */
  async saveFeatures(records: StudioFeatureRecord[]): Promise<void> {
    await upsertFeatureRecords(this.statePath, records);
  }

  async removeFeature(id: string): Promise<void> {
    await removeFeatureRecord(this.statePath, id);
  }

  /**
   * 会话 ↔ feature 绑定回写：studio_create_feature / studio_add_feature 后把
   * feature id 追加到当前会话记录（server 持有会话索引，经 HTTP 追加）。
   * 宿主未注入 sessionId（如测试环境）时显式返回 skipped，不静默吞掉。
   */
  async appendSessionFeatureBinding(featureIds: string[]): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
    const ids = featureIds.map((id) => cleanValue(id)).filter(Boolean);
    if (ids.length === 0 || !this.sessionId || !this.agentId) {
      return { ok: false, skipped: true, error: '会话身份不可用（宿主未注入 sessionId/agentId），本次未回写会话绑定。' };
    }
    try {
      const response = await fetch(`${this.serverOrigin}/protoclaw/prebuilt_sessions/${encodeURIComponent(this.sessionId)}/studio_feature_binding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: this.agentId, featureIds: ids }),
      });
      if (!response.ok) {
        return { ok: false, error: `绑定请求失败（HTTP ${response.status}）：${await response.text().catch(() => '')}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  liveRuntimeStatus(directory: string, manifest: StudioEnvironmentManifest | null): TestRuntimeStatus | 'not-initialized' {
    if (!manifest) return 'not-initialized';
    if (getRuntimeHandle(directory)) return 'running';
    return manifest.testRuntime.status === 'running' ? 'stopped' : manifest.testRuntime.status;
  }

  getTools() {
    return buildStudioTools(this);
  }

  async injectProjectState(ctx: CallStartContext): Promise<void> {
    // 会话创建时 run-prebuilt-agent 会以空输入调用 preInjectCallStart 预注入；
    // 首轮真实调用会再次触发 CallStart，跳过空输入避免同一轮注入两次。
    if (!ctx.input || !ctx.input.trim()) return;
    const directory = await this.resolveDirectory();
    const loaded = await this.loadDirectory(directory);
    const runs = await readRuns(directory);
    ctx.context.add({
      role: 'system',
      content: buildDirectoryStatusMarkdown(
        directory,
        loaded?.manifest || null,
        loaded?.features || [],
        this.liveRuntimeStatus(directory, loaded?.manifest || null),
        runs[0] || null,
      ),
    });
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'CallStart' && methodName === 'injectProjectState') {
      return '每轮开始时注入当前目录环境与本目录 Feature 的真实状态（清单、Test Runtime、最近运行）。';
    }
    return undefined;
  }
}
