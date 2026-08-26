// ── studio_* 工具定义 ─────────────────────────────────────────
//
// 从 index.ts 的 AgentStudioFeature.getTools() 工厂化迁出：
// execute 内原 this.xxx 实例调用全部改为 feature.xxx。
// 工具名、参数 schema、行为与迁出前保持一致。

import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { createTool } from '@agentdevjs/core';
import type { Tool } from '@agentdevjs/core';
import type {
  StudioAssertion,
  StudioToolCallEvidence,
  StudioHookEvidence,
  StudioRunRecord,
  SessionPolicy,
} from './assertions.js';
import {
  ASSERTION_KINDS,
  evaluateAssertions,
  computeFeatureCoverage,
  advanceFeatureStatuses,
  normalizeAssertion,
  normalizeTestCase,
  normalizeSessionPolicy,
} from './assertions.js';
import type { AgentStudioProject, WorkspaceState, StudioFeatureEntry } from './project-store.js';
import {
  cleanValue,
  normalizeProject,
  getProjectPath,
  readRuns,
  appendRun,
} from './project-store.js';
import type { TestRuntimeStatus } from './project-store.js';
import type { RuntimeHandle } from './runtime-process.js';
import type { AgentStudioFeature } from './index.js';
import {
  SYNC_TIMEOUT_MS,
  RUN_TEST_TIMEOUT_MS,
  findCreateFeatureCliPath,
  normalizeStandaloneAgentMetadata,
  getRuntimeHandle,
  fingerprintModule,
  fingerprintAgentDefinition,
  fingerprintFeatureSource,
  runProjectCommand,
  runFeatureBuild,
  runSnapshotScript,
  readFeatureProjectEntry,
  prepareAgentDebugPlan,
  runtimeRequest,
  startRuntimeProcess,
  stopRuntimeProcess,
  syncFeaturesToRuntime,
} from './runtime-process.js';

export const assertionParameterSchema = {
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

export function buildStudioTools(feature: AgentStudioFeature): Tool[] {
  return [
    createTool({
      name: 'studio_get_project',
      description: '读取当前 Agent Studio 项目的配置、开发中 Feature（含验证证据）、Test Runtime 实时状态和最近运行记录。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const projectDir = await feature.resolveProjectDirectory();
        const project = await feature.readProject(projectDir);
        const runs = await readRuns(projectDir);
        return {
          projectDir,
          projectFile: getProjectPath(projectDir),
          project,
          runtimeStatus: feature.liveRuntimeStatus(projectDir, project),
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
        const resolvedProjectDir = cleanValue(args.projectDir) || await feature.resolveProjectDirectory();
        if (!resolvedProjectDir) throw new Error('项目目录不能为空。请先在工作空间选择项目目录，或显式传入 projectDir。');
        const existing = await feature.readProject(resolvedProjectDir);
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
        await feature.writeProject(resolvedProjectDir, project);
        await feature.updateRegistry(resolvedProjectDir, project);
        feature.activeProjectDir = resolvedProjectDir;
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
        const { projectDir, project } = await feature.requireProject();
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
        await feature.writeProject(projectDir, { ...project, features, updatedAt: timestamp });
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
        const { projectDir, project } = await feature.requireProject();
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
        await feature.writeProject(projectDir, { ...project, features, updatedAt: timestamp });
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
        const { projectDir, project } = await feature.requireProject();
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
        await feature.writeProject(projectDir, { ...project, features, updatedAt: timestamp });
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
        const { projectDir, project } = await feature.requireProject();
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
        await feature.writeProject(projectDir, { ...project, agent, targetAgent: metadata.id, updatedAt: timestamp });
        const globalRegistration = await feature.syncGlobalAgentRegistration(agentDir, metadataPath, projectDir);
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
        const { projectDir, project } = await feature.requireProject();
        const existingHandle = getRuntimeHandle(projectDir);
        if (existingHandle) {
          return { projectDir, alreadyRunning: true, model: existingHandle.model };
        }
        const mode = cleanValue(args.mode) || (project.agent ? 'agent-debug' : 'feature-harness');
        if (mode !== 'feature-harness' && mode !== 'agent-debug') throw new Error('mode 只能是 feature-harness 或 agent-debug。');
        if (mode === 'feature-harness' && project.features.length === 0) {
          throw new Error('feature-harness 至少需要注册一个开发中 Feature。');
        }
        for (const f of project.features) await runFeatureBuild(f);
        const missing = project.features.filter((f) => !existsSync(f.modulePath));
        if (missing.length > 0) {
          throw new Error(`以下 Feature 模块文件不存在：${missing.map((f) => `${f.name} (${f.modulePath})`).join('；')}`);
        }
        const runtimePlanPath = mode === 'agent-debug' ? await prepareAgentDebugPlan(projectDir, project) : '';
        const { ready, handle } = await startRuntimeProcess(projectDir, cleanValue(args.modelPreset), mode, runtimePlanPath);
        for (const f of project.features) {
          handle.fingerprints.set(f.name, await fingerprintModule(f.modulePath));
        }
        if (mode === 'agent-debug') handle.agentFingerprint = await fingerprintAgentDefinition(project);
        const timestamp = new Date().toISOString();
        const nextProject = { ...project, testRuntime: { status: 'running' as const }, updatedAt: timestamp };
        await feature.writeProject(projectDir, nextProject);
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
        const { projectDir, project } = await feature.requireProject();
        const result = await stopRuntimeProcess(projectDir);
        const timestamp = new Date().toISOString();
        const nextProject = { ...project, testRuntime: { status: 'stopped' as const }, updatedAt: timestamp };
        await feature.writeProject(projectDir, nextProject);
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
        const { projectDir, project } = await feature.requireProject();
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
        await feature.writeProject(projectDir, nextProject);
        return { projectDir, test: savedTest, testCount: tests.length };
      },
    }),
    createTool({
      name: 'studio_list_tests',
      description: '列出当前项目已定义的测试用例（含会话策略与断言）。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const { projectDir, project } = await feature.requireProject();
        return { projectDir, tests: project.tests, runtimeStatus: feature.liveRuntimeStatus(projectDir, project) };
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
        const { projectDir } = await feature.requireProject();
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
        const { projectDir, project } = await feature.requireProject();
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
            for (const f of project.features) handle.fingerprints.set(f.name, await fingerprintModule(f.modulePath));
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
        for (const f of project.features) {
          featureRevisions[f.name] = await fingerprintFeatureSource(f);
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
        const featuresWithInject = project.features.map((f) => ({
          ...f,
          staticInject: handle.featureInject.get(f.name) ?? f.staticInject,
        }));
        const features = advanceFeatureStatuses(featuresWithInject, reloadSummary, featureCoverage, passed, runId, timestamp, featureRevisions);
        await feature.writeProject(projectDir, { ...project, features, updatedAt: timestamp });

        const deniedTools = [...new Set(toolCalls.filter((entry) => entry.denied).map((entry) => entry.tool))];
        const deniedMissing = assertionResults
          .filter((item) => !item.ok && item.assertion.kind === 'tool-executed' && deniedTools.includes(item.assertion.tool || ''))
          .map((item) => item.assertion.tool || '');
        const guidance = deniedMissing.length > 0
          ? `期望工具 ${[...new Set(deniedMissing)].join(', ')} 被调用但被拦截（denied，真实执行 0 次）。被拒调用不算 executed：若这是 guard 拒绝路径，请用 tool-denied 断言拒绝本身、或断言可观察的下游证据；若不应被拒，请检查 guard 逻辑。`
          : undefined;
        return {
          run: record,
          featureStatuses: features.map((f) => ({ name: f.name, status: f.status })),
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
        const { projectDir, project } = await feature.requireProject();
        const name = cleanValue(args.name);
        const studioFeature = project.features.find((item) => item.name === name);
        if (!studioFeature) throw new Error(`Feature ${name} 不在项目注册表中。`);
        if (!studioFeature.source) throw new Error(`Feature ${name} 是 legacy 模块；请先升级为标准 npm Feature 项目后再创建 Snapshot。`);
        if (studioFeature.status !== 'verified' || !studioFeature.verification?.sourceDigest) {
          throw new Error(`Feature ${name} 尚未通过当前源码的验证。请先运行带可执行断言且覆盖该 Feature 的 studio_run_test。`);
        }
        await runFeatureBuild(studioFeature);
        const currentDigest = await fingerprintFeatureSource(studioFeature);
        if (currentDigest !== studioFeature.verification.sourceDigest) {
          throw new Error(`Feature ${name} 的构建产物已变化，之前验证已失效。请重新运行测试后再创建 Snapshot。`);
        }
        const snapshot = await runSnapshotScript(studioFeature.source.projectDir);
        const timestamp = new Date().toISOString();
        const features = project.features.map((item) => item.name === name
          ? { ...item, status: 'snapshotted' as const, snapshot }
          : item);
        await feature.writeProject(projectDir, { ...project, features, updatedAt: timestamp });
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
        const { projectDir } = await feature.requireProject();
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

