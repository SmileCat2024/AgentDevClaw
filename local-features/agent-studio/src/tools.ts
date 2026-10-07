// ── studio_* 工具定义 ─────────────────────────────────────────
//
// feature-first 模型（ADR-0022）：工具面围绕"目录环境 + 全局 feature 注册表"
// 组织。目录清单（agent-studio.json）懒创建——select_toolchain /
// create_feature 首次落盘，没有独立的初始化步骤。

import { promises as fs } from 'fs';
import { isAbsolute, join, resolve } from 'path';
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
import type { StudioFeatureEntry, StudioToolchain } from './project-store.js';
import {
  getManifestPath,
  readRuns,
  appendRun,
} from './project-store.js';
import type { StudioFeatureRecord } from './feature-store.js';
import { cleanValue } from './clean-value.js';
import type { AgentStudioFeature } from './index.js';
import {
  SYNC_TIMEOUT_MS,
  RUN_TEST_TIMEOUT_MS,
  findCreateFeatureCliPath,
  detectStudioToolchains,
  probeStudioToolchain,
  requireStudioToolchain,
  assertStandardBuildCommand,
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

async function readPackageDescription(featureProjectDir: string): Promise<string> {
  try {
    const pkg = JSON.parse(await fs.readFile(join(featureProjectDir, 'package.json'), 'utf8')) as Record<string, unknown>;
    return cleanValue(pkg.description);
  } catch {
    return '';
  }
}

/** 注册 feature 并回写会话绑定；返回给工具结果的标准片段。 */
async function registerAndBind(
  feature: AgentStudioFeature,
  entry: StudioFeatureEntry,
  directory: string,
  description: string,
): Promise<{ record: StudioFeatureRecord; sessionBinding: Record<string, unknown> }> {
  const record = await feature.registerFeature(entry, directory, description);
  const binding = await feature.appendSessionFeatureBinding([record.id]);
  const sessionBinding = binding.ok
    ? { ok: true, featureId: record.id }
    : { ok: false, ...(binding.skipped ? { skipped: true } : {}), ...(binding.error ? { error: binding.error } : {}) };
  return { record, sessionBinding };
}

export function buildStudioTools(feature: AgentStudioFeature): Tool[] {
  return [
    createTool({
      name: 'studio_detect_environment',
      description: '检查可用于 Feature 项目的 Node/npm：列出桌面随包与系统环境中经实际命令验证的组合，以及当前目录的选择。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const directory = await feature.resolveDirectory();
        const manifest = await feature.readManifest(directory);
        return { directory, available: await detectStudioToolchains(), selected: manifest?.toolchain || null };
      },
    }),
    createTool({
      name: 'studio_select_toolchain',
      description: '为当前目录选择 Node/npm 组合（目录清单不存在时自动创建）。可以选择检测到的方案，也可以提供用户指定的可执行路径；保存前会实际运行版本检测。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['bundled', 'system', 'custom'] },
          nodePath: { type: 'string', description: 'Node 可执行文件绝对路径。' },
          npmPath: { type: 'string', description: 'npm 可执行入口绝对路径（可为 npm-cli.js、npm.cmd 或 npm）。' },
        },
        required: ['source', 'nodePath', 'npmPath'],
      },
      execute: async (args: Record<string, unknown>) => {
        const { dir, manifest } = await feature.ensureDirectory();
        const source = cleanValue(args.source);
        const nodePath = cleanValue(args.nodePath);
        const npmPath = cleanValue(args.npmPath);
        if ((source !== 'bundled' && source !== 'system' && source !== 'custom') || !nodePath || !npmPath
          || !isAbsolute(nodePath) || !isAbsolute(npmPath)) {
          throw new Error('请选择有效的 Node/npm 绝对路径。');
        }
        const toolchain = { source, nodePath, npmPath } as StudioToolchain;
        const verified = await probeStudioToolchain(toolchain);
        if (!verified) throw new Error('这组 Node/npm 不可用。请检查路径后重新检测。');
        await feature.writeManifestUpdate(dir, { ...manifest, toolchain });
        return { directory: dir, toolchain: verified };
      },
    }),
    createTool({
      name: 'studio_get_directory',
      description: '读取当前目录的环境清单（工具链、测试、Test Runtime 状态）、本目录开发中的 Feature（含验证证据）和最近运行记录。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const directory = await feature.resolveDirectory();
        const loaded = await feature.loadDirectory(directory);
        const runs = await readRuns(directory);
        return {
          directory,
          manifestFile: getManifestPath(directory),
          manifest: loaded?.manifest || null,
          features: loaded?.features || [],
          runtimeStatus: feature.liveRuntimeStatus(directory, loaded?.manifest || null),
          lastRun: runs[0] || null,
          runCount: runs.length,
        };
      },
    }),
    createTool({
      name: 'studio_create_feature',
      description: '在当前目录下创建、安装并注册标准 AgentDev Feature npm 项目，并绑定到当前会话。必须依据已确认的功能范围填写 Claw Manifest v2 元数据；不要留用脚手架默认描述，也不要按包名猜 capabilities / type / requirements。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Feature 名称，仅允许小写字母、数字和连字符，例如 ticket-feature。' },
          parentDir: { type: 'string', description: '父目录，相对当前目录；默认 features。' },
          displayNameZh: { type: 'string', description: 'Claw Feature 元数据必填：中文展示名。' },
          displayNameEn: { type: 'string', description: 'Claw Feature 元数据必填：英文展示名。' },
          description: { type: 'string', description: 'Claw Feature 元数据必填：面向用户说明用途与使用时机；同时写入 package.json.description。' },
          type: { type: 'string', enum: ['ability', 'governance', 'interface', 'system'], description: 'Claw Manifest v2 单值功能类型。' },
          capabilities: { type: 'array', items: { type: 'string', enum: ['tools', 'policy', 'commands', 'skills', 'mcp'] }, description: '按真实实现选择的零个或多个能力。' },
          provides: { type: 'object', description: '如实声明 tools / skills / commands 名称数组，以及 hooks / mcp 布尔值。' },
          depends: { type: 'array', items: { type: 'object' }, description: 'Feature 的 static inject 依赖，使用 { id, range }。' },
          requirements: { type: 'object', description: '实际 requirements：platforms、node、external、services。' },
          rollback: { type: 'boolean', description: '是否支持回滚；依据实际状态/副作用语义填写。' },
        },
        required: ['name', 'displayNameZh', 'displayNameEn', 'description', 'type', 'capabilities', 'provides', 'depends', 'requirements', 'rollback'],
      },
      execute: async (args: Record<string, unknown>) => {
        const { dir, manifest } = await feature.ensureDirectory();
        const name = cleanValue(args.name);
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
          throw new Error('Feature 名称仅允许小写字母、数字和连字符，且必须以字母开头。');
        }
        const description = cleanValue(args.description);
        const displayNameZh = cleanValue(args.displayNameZh);
        const displayNameEn = cleanValue(args.displayNameEn);
        const type = cleanValue(args.type);
        const capabilities = Array.isArray(args.capabilities) ? args.capabilities.map(cleanValue) : [];
        const validCapabilities = new Set(['tools', 'policy', 'commands', 'skills', 'mcp']);
        if (!description || !displayNameZh || !displayNameEn || !['ability', 'governance', 'interface', 'system'].includes(type)) {
          throw new Error('创建 Feature 前必须提供完整 Claw 元数据：description、中文/英文展示名和有效 type。');
        }
        if (capabilities.some((item) => !validCapabilities.has(item))) {
          throw new Error('capabilities 只能包含 tools、policy、commands、skills、mcp。');
        }
        const providesRaw = args.provides && typeof args.provides === 'object' && !Array.isArray(args.provides)
          ? args.provides as Record<string, unknown>
          : null;
        const requirementsRaw = args.requirements && typeof args.requirements === 'object' && !Array.isArray(args.requirements)
          ? args.requirements as Record<string, unknown>
          : null;
        const dependsRaw = Array.isArray(args.depends) ? args.depends : null;
        if (!providesRaw || !requirementsRaw || !dependsRaw || typeof args.rollback !== 'boolean') {
          throw new Error('Claw 元数据必须包含 provides、depends、requirements 对象/数组及 rollback 布尔值。');
        }
        const toolchain = await requireStudioToolchain(manifest);
        const registry = await feature.listAllFeatureRecords();
        const existing = registry.find((record) => record.name === name || record.package === name);
        if (existing) {
          throw new Error(`Feature 包名 ${name} 已注册（目录：${existing.directory}）。包名是全局唯一身份：请换一个名称，或先 studio_remove_feature 移除旧记录。`);
        }
        const provides = {
          tools: Array.isArray(providesRaw.tools) ? providesRaw.tools.map(cleanValue).filter(Boolean) : [],
          skills: Array.isArray(providesRaw.skills) ? providesRaw.skills.map(cleanValue).filter(Boolean) : [],
          commands: Array.isArray(providesRaw.commands) ? providesRaw.commands.map(cleanValue).filter(Boolean) : [],
          hooks: providesRaw.hooks === true,
          mcp: providesRaw.mcp === true,
        };
        const requirements = {
          platforms: Array.isArray(requirementsRaw.platforms) ? requirementsRaw.platforms.map(cleanValue).filter(Boolean) : [],
          node: cleanValue(requirementsRaw.node),
          external: Array.isArray(requirementsRaw.external) ? requirementsRaw.external.map(cleanValue).filter(Boolean) : [],
          services: Array.isArray(requirementsRaw.services) ? requirementsRaw.services.map(cleanValue).filter(Boolean) : [],
        };
        const depends = dependsRaw.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('depends 中每项必须是 { id, range } 对象。');
          const dependency = item as Record<string, unknown>;
          const id = cleanValue(dependency.id);
          const range = cleanValue(dependency.range);
          if (!id || !range) throw new Error('depends 每项都必须提供 id 与 range。');
          return { id, range };
        });
        const agentdev = {
          schemaVersion: 2,
          id: name,
          displayName: { zh: displayNameZh, en: displayNameEn },
          type,
          capabilities,
          provides,
          depends,
          requirements,
          compatibility: { rollback: args.rollback },
        };
        const parentDir = resolve(dir, cleanValue(args.parentDir) || 'features');
        const cliPath = findCreateFeatureCliPath();
        await fs.mkdir(parentDir, { recursive: true });
        await runProjectCommand(parentDir, toolchain.nodePath, [cliPath, name]);
        const featureProjectDir = join(parentDir, name);
        const packagePath = join(featureProjectDir, 'package.json');
        const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8')) as Record<string, unknown>;
        const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.map(cleanValue).filter(Boolean) : [];
        await fs.writeFile(packagePath, `${JSON.stringify({
          ...pkg,
          description,
          keywords: [...new Set([...keywords, ...capabilities])],
          engines: { ...(pkg.engines && typeof pkg.engines === 'object' ? pkg.engines : {}), agentdev: '^0.1.0' },
          agentdev,
        }, null, 2)}\\n`, 'utf8');
        await runProjectCommand(featureProjectDir, 'npm', ['install', '--no-fund', '--no-audit'], toolchain);
        const entry = await readFeatureProjectEntry(featureProjectDir);
        const { record, sessionBinding } = await registerAndBind(feature, entry, dir, description);
        return { directory: dir, featureProjectDir, feature: record, sessionBinding };
      },
    }),
    createTool({
      name: 'studio_add_feature',
      description: '注册一个开发中的 Feature 并绑定到当前会话。推荐传 featureProjectDir（标准 npm Feature 项目，同名重注册视为移动目录、保留验证账本）；legacy 模块可继续传 name + modulePath。',
      parameters: {
        type: 'object',
        properties: {
          featureProjectDir: { type: 'string', description: '标准 Feature npm 项目目录；自动读取 package.json 和 dist 入口。' },
          name: { type: 'string', description: 'legacy 模块的 feature 名（与实例 name 属性一致）。' },
          modulePath: { type: 'string', description: 'legacy ESM 模块路径。' },
        },
      },
      execute: async (args: Record<string, unknown>) => {
        const { dir } = await feature.ensureDirectory();
        const sourceDir = cleanValue(args.featureProjectDir);
        let entry: StudioFeatureEntry;
        let description = '';
        if (sourceDir) {
          const featureProjectDir = resolve(dir, sourceDir);
          entry = await readFeatureProjectEntry(featureProjectDir);
          description = await readPackageDescription(featureProjectDir);
        } else {
          const name = cleanValue(args.name);
          const rawModulePath = cleanValue(args.modulePath);
          if (!name || !rawModulePath) throw new Error('请传 featureProjectDir，或同时传 name 和 modulePath。');
          const modulePath = resolve(dir, rawModulePath);
          if (!existsSync(modulePath)) throw new Error(`模块文件不存在：${modulePath}。请先创建模块文件再注册。`);
          entry = { name, modulePath, status: 'implemented' };
        }
        const { record, sessionBinding } = await registerAndBind(feature, entry, dir, description);
        return { directory: dir, feature: record, sessionBinding };
      },
    }),
    createTool({
      name: 'studio_remove_feature',
      description: '移除一个 Feature 的注册（全局注册表 + 当前目录）。若 Test Runtime 正在运行，同时从运行时卸载。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '要移除的 feature 名。' },
        },
        required: ['name'],
      },
      execute: async (args: Record<string, unknown>) => {
        const { dir, features } = await feature.requireDirectory();
        const name = cleanValue(args.name);
        if (!name) throw new Error('name 不能为空。');
        const existing = features.find((item) => item.name === name);
        if (!existing) throw new Error(`Feature ${name} 不在本目录的注册表中。`);
        const handle = getRuntimeHandle(dir);
        let runtimeUpdated = false;
        if (handle) {
          const removed = await runtimeRequest(dir, handle, {
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
        await feature.removeFeature(existing.id);
        return { directory: dir, removed: existing.id, runtimeUpdated };
      },
    }),
    createTool({
      name: 'studio_register_agent',
      description: '登记当前目录要在真实装配条件下调试的 Agent，并同步写入全局注册表（claw run 的消费入口）。Agent metadata 负责声明精确 Feature 包版本；Studio 的开发中标准 Feature 会以源码覆盖这些声明。全局注册失败时返回 globalRegistration 说明原因与修复指引，不影响目录内登记与 agent-debug。',
      parameters: {
        type: 'object',
        properties: {
          agentDir: { type: 'string', description: 'Agent 项目目录，相对当前目录或绝对路径。' },
          metadataPath: { type: 'string', description: 'metadata.json 路径；缺省为 <agentDir>/metadata.json。' },
        },
        required: ['agentDir'],
      },
      execute: async (args: Record<string, unknown>) => {
        const { dir, manifest } = await feature.requireDirectory();
        const agentDir = resolve(dir, cleanValue(args.agentDir));
        if (!existsSync(agentDir)) throw new Error(`Agent 项目目录不存在：${agentDir}`);
        const metadataPath = cleanValue(args.metadataPath)
          ? resolve(dir, cleanValue(args.metadataPath))
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
        const agent = { projectDir: agentDir, metadataPath };
        await feature.writeManifestUpdate(dir, { ...manifest, agent, targetAgent: metadata.id });
        const globalRegistration = await feature.syncGlobalAgentRegistration(agentDir, metadataPath, dir);
        return { directory: dir, agent, agentId: metadata.id, globalRegistration };
      },
    }),
    createTool({
      name: 'studio_start_runtime',
      description: '启动隔离 Test Runtime（按当前目录起进程）。feature-harness 使用最小 Agent；agent-debug 加载 studio_register_agent 登记的真实 Agent，并混装开发源码 Feature 与仓库 Snapshot Feature。会话目录为目录内 .agent-studio/runtime-sessions。',
      parameters: {
        type: 'object',
        properties: {
          modelPreset: { type: 'string', description: '指定模型预设名；缺省依次使用 agent-studio 配置与全局默认模型。' },
          mode: { type: 'string', enum: ['feature-harness', 'agent-debug'], description: 'feature-harness=最小 Agent；agent-debug=真实 Agent。已登记真实 Agent 时默认 agent-debug。' },
        },
      },
      execute: async (args: Record<string, unknown>) => {
        const { dir, manifest, features } = await feature.requireDirectory();
        const existingHandle = getRuntimeHandle(dir);
        if (existingHandle) {
          return { directory: dir, alreadyRunning: true, model: existingHandle.model };
        }
        const mode = cleanValue(args.mode) || (manifest.agent ? 'agent-debug' : 'feature-harness');
        if (mode !== 'feature-harness' && mode !== 'agent-debug') throw new Error('mode 只能是 feature-harness 或 agent-debug。');
        for (const f of features) assertStandardBuildCommand(f);
        if (mode === 'feature-harness' && features.length === 0) {
          throw new Error('feature-harness 至少需要注册一个开发中 Feature。');
        }
        if (features.some((f) => f.source)) await requireStudioToolchain(manifest);
        for (const f of features) await runFeatureBuild(f, manifest.toolchain);
        const missing = features.filter((f) => !existsSync(f.modulePath));
        if (missing.length > 0) {
          throw new Error(`以下 Feature 模块文件不存在：${missing.map((f) => `${f.name} (${f.modulePath})`).join('；')}`);
        }
        const runtimePlanPath = mode === 'agent-debug' ? await prepareAgentDebugPlan(dir, manifest, features) : '';
        const { ready, handle } = await startRuntimeProcess(dir, cleanValue(args.modelPreset), mode, runtimePlanPath, features);
        for (const f of features) {
          handle.fingerprints.set(f.name, await fingerprintModule(f.modulePath));
        }
        if (mode === 'agent-debug') handle.agentFingerprint = await fingerprintAgentDefinition(manifest.agent);
        await feature.writeManifestUpdate(dir, { ...manifest, testRuntime: { status: 'running' } });
        return {
          directory: dir,
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
      description: '停止当前目录的 Test Runtime。stateful 测试会话已持久化，下次启动自动恢复。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const { dir, manifest } = await feature.requireDirectory();
        const result = await stopRuntimeProcess(dir);
        await feature.writeManifestUpdate(dir, { ...manifest, testRuntime: { status: 'stopped' } });
        return { directory: dir, ...result };
      },
    }),
    createTool({
      name: 'studio_define_test',
      description: '定义测试用例并保存到当前目录清单：输入 + 会话策略 + 可执行断言（由运行证据机器判定）。之后用 studio_run_test { testId } 运行。',
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
        const { dir, manifest } = await feature.requireDirectory();
        const testId = cleanValue(args.id);
        const timestamp = new Date().toISOString();
        let assertions: StudioAssertion[];
        try {
          assertions = Array.isArray(args.assertions)
            ? (args.assertions as unknown[]).map((item) => normalizeAssertion(item))
            : [];
        } catch (error) {
          throw new Error(`测试 ${testId} 的断言定义不合法：${error instanceof Error ? error.message : String(error)}`, { cause: error });
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
        const existingIndex = manifest.tests.findIndex((item) => item.id === testId);
        const previous = existingIndex >= 0 ? manifest.tests[existingIndex] : null;
        const tests = [...manifest.tests];
        const savedTest = { ...nextTest, createdAt: previous?.createdAt || timestamp };
        if (existingIndex >= 0) tests.splice(existingIndex, 1, savedTest);
        else tests.push(savedTest);
        await feature.writeManifestUpdate(dir, { ...manifest, tests });
        return { directory: dir, test: savedTest, testCount: tests.length };
      },
    }),
    createTool({
      name: 'studio_list_tests',
      description: '列出当前目录已定义的测试用例（含会话策略与断言）。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const { dir, manifest } = await feature.requireDirectory();
        return { directory: dir, tests: manifest.tests, runtimeStatus: feature.liveRuntimeStatus(dir, manifest) };
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
        const { dir } = await feature.requireDirectory();
        const handle = getRuntimeHandle(dir);
        if (!handle) {
          throw new Error('Test Runtime 未运行。请先调用 studio_start_runtime，并以 stateful 策略至少运行一次建立 default 会话。');
        }
        const name = cleanValue(args.name);
        if (!name) throw new Error('检查点名称不能为空。');
        const saved = await runtimeRequest(dir, handle, {
          type: 'studio-save-checkpoint',
          name,
        }, SYNC_TIMEOUT_MS);
        if (saved.ok !== true) {
          const error = saved.error as { message?: string } | undefined;
          throw new Error(error?.message || '保存检查点失败。');
        }
        return {
          directory: dir,
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
            description: '临时断言（仅本次运行生效，不写回测试定义）。',
          },
          sessionPolicy: {
            type: 'string',
            enum: ['fresh', 'stateful', 'checkpointed'],
            description: '临时运行覆盖会话策略；运行已定义测试时缺省用测试定义的策略。',
          },
          checkpoint: { type: 'string', description: 'checkpointed 策略的检查点名。' },
        },
      },
      execute: async (args: Record<string, unknown>) => {
        const { dir, manifest, features } = await feature.requireDirectory();
        let handle = getRuntimeHandle(dir);
        if (!handle) {
          throw new Error('Test Runtime 未运行。请先调用 studio_start_runtime。');
        }
        if (handle.mode === 'agent-debug') {
          const currentAgentFingerprint = await fingerprintAgentDefinition(manifest.agent);
          if (currentAgentFingerprint !== handle.agentFingerprint) {
            await stopRuntimeProcess(dir);
            const runtimePlanPath = await prepareAgentDebugPlan(dir, manifest, features);
            const restarted = await startRuntimeProcess(dir, '', 'agent-debug', runtimePlanPath, features);
            handle = restarted.handle;
            handle.agentFingerprint = currentAgentFingerprint;
            for (const f of features) handle.fingerprints.set(f.name, await fingerprintModule(f.modulePath));
          }
        }

        const testId = cleanValue(args.testId);
        const input = cleanValue(args.input);
        let testInput = input;
        let assertions: StudioAssertion[];
        let sessionPolicy: SessionPolicy;
        let checkpoint: string;
        let recordedTestId = testId;
        if (testId) {
          const defined = manifest.tests.find((item) => item.id === testId);
          if (!defined) throw new Error(`测试 ${testId} 不存在。请先调用 studio_define_test 定义。`);
          testInput = defined.input;
          assertions = Array.isArray(args.assertions)
            ? (args.assertions as unknown[]).map((item) => normalizeAssertion(item))
            : defined.assertions;
          sessionPolicy = args.sessionPolicy ? normalizeSessionPolicy(args.sessionPolicy) : defined.sessionPolicy;
          checkpoint = cleanValue(args.checkpoint) || defined.checkpoint || '';
        } else {
          if (!testInput) throw new Error('请提供 testId（运行已定义测试）或 input（临时测试）。');
          recordedTestId = 'ad-hoc';
          assertions = Array.isArray(args.assertions)
            ? (args.assertions as unknown[]).map((item) => normalizeAssertion(item))
            : [];
          sessionPolicy = normalizeSessionPolicy(args.sessionPolicy);
          checkpoint = cleanValue(args.checkpoint);
        }
        if (sessionPolicy === 'checkpointed' && !checkpoint) {
          throw new Error('checkpointed 策略需要 checkpoint 名称（先用 studio_save_checkpoint 保存）。');
        }

        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const startedAt = new Date().toISOString();

        // 1) 同步 Feature 源码到 runtime（ensure 按拓扑序 + reload），runId 透传打日志标签
        for (const f of features) assertStandardBuildCommand(f);
        if (features.some((f) => f.source)) await requireStudioToolchain(manifest);
        const reloadSummary = await syncFeaturesToRuntime(dir, handle, features, manifest.toolchain, runId);
        const failedReload = reloadSummary.filter((item) => !item.ok);
        const featureRevisions: Record<string, string> = {};
        for (const f of features) {
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
          await appendRun(dir, record);
          return { run: record, guidance: 'Feature 热载失败，运行未执行；runtime 已回退到上一可用版本，修复源码后重试。' };
        }

        // 2) 发送测试输入（含会话策略）
        const result = await runtimeRequest(dir, handle, {
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
          await appendRun(dir, record);
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
        await appendRun(dir, record);

        // 4) Feature 状态推进：按 reloadSummary 与覆盖证据独立推进每个 Feature；
        //    依赖图（static inject）随本次同步回写进注册表记录，供传递覆盖判定
        const timestamp = new Date().toISOString();
        const featuresWithInject = features.map((f) => ({
          ...f,
          staticInject: handle.featureInject.get(f.name) ?? f.staticInject,
        }));
        const advanced = advanceFeatureStatuses(featuresWithInject, reloadSummary, featureCoverage, passed, runId, timestamp, featureRevisions) as StudioFeatureRecord[];
        await feature.saveFeatures(advanced);

        const deniedTools = [...new Set(toolCalls.filter((entry) => entry.denied).map((entry) => entry.tool))];
        const deniedMissing = assertionResults
          .filter((item) => !item.ok && item.assertion.kind === 'tool-executed' && deniedTools.includes(item.assertion.tool || ''))
          .map((item) => item.assertion.tool || '');
        const guidance = deniedMissing.length > 0
          ? `期望工具 ${[...new Set(deniedMissing)].join(', ')} 被调用但被拦截（denied，真实执行 0 次）。被拒调用不算 executed：若这是 guard 拒绝路径，请用 tool-denied 断言拒绝本身、或断言可观察的下游证据；若不应被拒，请检查 guard 逻辑。`
          : undefined;
        return {
          run: record,
          featureStatuses: advanced.map((f) => ({ name: f.name, status: f.status })),
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
          name: { type: 'string', description: '要创建快照的 Feature 名。' },
        },
        required: ['name'],
      },
      execute: async (args: Record<string, unknown>) => {
        const { dir, manifest, features } = await feature.requireDirectory();
        const name = cleanValue(args.name);
        const studioFeature = features.find((item) => item.name === name);
        if (!studioFeature) throw new Error(`Feature ${name} 不在本目录的注册表中。`);
        if (!studioFeature.source) throw new Error(`Feature ${name} 是 legacy 模块；请先升级为标准 npm Feature 项目后再创建 Snapshot。`);
        if (studioFeature.status !== 'verified' || !studioFeature.verification?.sourceDigest) {
          throw new Error(`Feature ${name} 尚未通过当前源码的验证。请先运行带可执行断言且覆盖该 Feature 的 studio_run_test。`);
        }
        assertStandardBuildCommand(studioFeature);
        const toolchain = await requireStudioToolchain(manifest);
        await runFeatureBuild(studioFeature, toolchain);
        const currentDigest = await fingerprintFeatureSource(studioFeature);
        if (currentDigest !== studioFeature.verification.sourceDigest) {
          throw new Error(`Feature ${name} 的构建产物已变化，之前验证已失效。请重新运行测试后再创建 Snapshot。`);
        }
        const snapshot = await runSnapshotScript(studioFeature.source.projectDir, toolchain);
        const timestamp = new Date().toISOString();
        await feature.saveFeatures([{
          ...studioFeature,
          status: 'snapshotted',
          snapshot,
          updatedAt: timestamp,
        }]);
        return { directory: dir, feature: name, snapshot };
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
        const { dir } = await feature.requireDirectory();
        const runs = await readRuns(dir);
        const runId = cleanValue(args.runId);
        if (runId) {
          const record = runs.find((item) => item.runId === runId) || null;
          if (!record) throw new Error(`运行记录 ${runId} 不存在。`);
          return { directory: dir, run: record };
        }
        return { directory: dir, runs: runs.map(({ runId: id, testId, phase, ok, passed, startedAt }) => ({ runId: id, testId, phase, ok, passed, startedAt })) };
      },
    }),
  ];
}
