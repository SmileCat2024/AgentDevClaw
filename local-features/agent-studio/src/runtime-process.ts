// ── Test Runtime 进程管理（module 级：feature 热载后子进程不丢） ──────────
//
// 从 index.ts 原样迁出。runtimeHandles 为模块级可变 Map（进程内单例语义）：
// index.ts 与 tools.ts 一律经本模块导出的函数访问，不得持有第二份引用副本。

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import type {
  StudioFeatureEntry,
  StudioFeatureSnapshot,
  AgentStudioProject,
} from './project-store.js';
import type { StudioRunRecord } from './assertions.js';
import {
  RUNS_DIR_NAME,
  cleanValue,
  markRuntimeStopped,
} from './project-store.js';

export const READY_TIMEOUT_MS = 60_000;
export const SYNC_TIMEOUT_MS = 120_000;
export const RUN_TEST_TIMEOUT_MS = 300_000;
export const INSPECT_TIMEOUT_MS = 15_000;
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface StudioReadyPayload {
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

export interface RuntimeHandle {
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

export function findProjectScript(relativePath: string): string {
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
export function findAgentRegistryModuleUrl(): string {
  if (agentRegistryModuleUrl) return agentRegistryModuleUrl;
  const registryPath = findProjectScript(join('server', 'feature-runtime', 'agent-registry.js'));
  agentRegistryModuleUrl = pathToFileURL(registryPath).href;
  return agentRegistryModuleUrl;
}

export function findCreateFeatureCliPath(): string {
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
export async function normalizeStandaloneAgentMetadata(raw: unknown): Promise<{
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

export function getRuntimePlanPath(projectDir: string): string {
  return join(projectDir, RUNS_DIR_NAME, 'runtime-plan.json');
}

export function getRuntimeOverridesPath(projectDir: string): string {
  return join(projectDir, RUNS_DIR_NAME, 'source-overrides.json');
}

export function getRuntimeHandle(projectDir: string): RuntimeHandle | null {
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

export async function fingerprintModule(modulePath: string): Promise<string> {
  try {
    const content = await fs.readFile(modulePath);
    return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

export async function fingerprintAgentDefinition(project: AgentStudioProject): Promise<string> {
  if (!project.agent) return 'none';
  const hash = crypto.createHash('sha256');
  for (const filePath of [project.agent.metadataPath, join(project.agent.projectDir, 'agent.js')]) {
    hash.update(filePath);
    hash.update('\0');
    try { hash.update(await fs.readFile(filePath)); } catch { hash.update('missing'); }
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export async function fingerprintFeatureSource(feature: StudioFeatureEntry): Promise<string> {
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

export async function runProjectCommand(projectDir: string, command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
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

export async function runFeatureBuild(feature: StudioFeatureEntry): Promise<void> {
  if (!feature.source) return;
  const [command, ...args] = feature.source.buildCommand;
  if (command !== 'npm' || args.join(' ') !== 'run build') {
    throw new Error(`标准 Feature 项目仅支持 buildCommand=["npm","run","build"]：${feature.name}`);
  }
  await runProjectCommand(feature.source.projectDir, command, args);
}

export async function readFeatureProjectEntry(projectDir: string): Promise<StudioFeatureEntry> {
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

export async function runSnapshotScript(projectDir: string): Promise<StudioFeatureSnapshot> {
  const scriptPath = findProjectScript(join('scripts', 'package-feature-project.js'));
  const { stdout } = await runProjectCommand(dirname(scriptPath), process.execPath, [scriptPath, '--project-dir', projectDir]);
  const line = stdout.trim().split(/\r?\n/).find((item) => item.startsWith('{')) || '';
  const result = JSON.parse(line) as { ok?: boolean; snapshot?: StudioFeatureSnapshot; error?: string };
  if (!result.ok || !result.snapshot) throw new Error(result.error || '创建本地 Snapshot 失败。');
  return result.snapshot;
}

export async function prepareAgentDebugPlan(projectDir: string, project: AgentStudioProject): Promise<string> {
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

export function runtimeRequest(
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

export async function startRuntimeProcess(
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

export async function stopRuntimeProcess(projectDir: string): Promise<{ stopped: boolean; wasRunning: boolean }> {
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
export async function syncFeaturesToRuntime(
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

