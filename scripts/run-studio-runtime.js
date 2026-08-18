#!/usr/bin/env node
/**
 * Agent Studio Test Runtime host.
 *
 * Runs the target agent (minimal Agent by default) plus the project's
 * development features in an isolated child process, controlled via IPC by
 * AgentStudioFeature on the dev-agent side.
 *
 * Usage: node scripts/run-studio-runtime.js <projectDir>
 *
 * IPC contract (parent -> child):
 *   { type: 'studio-ensure-feature', requestId, featureName, modulePath }
 *   { type: 'studio-reload-feature', requestId, featureName, modulePath }
 *   { type: 'studio-run-test', requestId, testId?, input }
 *   { type: 'studio-inspect', requestId }
 *   { type: 'studio-shutdown', requestId }
 *
 * IPC contract (child -> parent):
 *   { type: 'studio-ready', ok, ... } — startup outcome (features mounted or error)
 *   { type: 'studio-result', requestId, operation, ok, ... } — per-request reply
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { Agent, FileSessionStore, createLLM, runWithLogScope } from 'agentdev';
import { resolveAgentModelLLM, resolveModelPresetLLM } from '../server/model-preset-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const SESSION_ID = 'default';
const RUN_TEST_REPLY_LIMIT = 4000;
const IPC_ERROR_STACK_LIMIT = 2000;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…(+${value.length - max} chars)` : value;
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: String(error?.message || error),
    stack: truncate(error?.stack || '', IPC_ERROR_STACK_LIMIT),
  };
}

function summarize(value) {
  try {
    return truncate(JSON.stringify(value), 600);
  } catch {
    return truncate(String(value), 600);
  }
}

function send(message) {
  if (!process.connected) return;
  try {
    process.send(message);
  } catch (error) {
    console.error('[StudioRuntime] IPC send failed:', error?.message || error);
  }
}

function failReady(message, featureName, error) {
  send({
    type: 'studio-ready',
    ok: false,
    ...(featureName ? { feature: featureName } : {}),
    error: error ? serializeError(error) : { name: 'Error', message, stack: '' },
  });
  console.error(`[StudioRuntime] startup failed${featureName ? ` (feature=${featureName})` : ''}: ${message}`);
  process.exit(1);
}

/**
 * Model resolution chain:
 * 1. STUDIO_MODEL_PRESET env override (explicit preset name)
 * 2. agent-studio per-agent preset (metadata.json + user agent-config override)
 * 3. global default model: inline defaultModel in config/default.json, built
 *    via createLLM — the same path BasicAgent workspaces (programming-helper
 *    et al.) use when no preset is configured
 * 4. legacy: match a preset by model name (for defaultModel entries that only
 *    reference a model name without inline credentials)
 */
function resolveRuntimeLLM() {
  const envPreset = clean(process.env.STUDIO_MODEL_PRESET);
  if (envPreset) {
    const resolved = resolveModelPresetLLM(envPreset);
    if (resolved) return resolved;
    console.warn(`[StudioRuntime] STUDIO_MODEL_PRESET "${envPreset}" could not be resolved; falling back`);
  }

  const perAgent = resolveAgentModelLLM(
    join(PROTOCLAW_ROOT, 'prebuilt-agents', 'official', 'agent-studio'),
    'default',
  );
  if (perAgent) return perAgent;

  try {
    const raw = JSON.parse(readFileSync(join(PROTOCLAW_ROOT, 'config', 'default.json'), 'utf8'));
    const dm = raw?.defaultModel;
    if (dm?.model && dm?.baseUrl && dm?.apiKey) {
      const llm = createLLM({ defaultModel: dm });
      console.log(`[StudioRuntime] global default model (inline) => ${dm.model}`);
      return { llm, modelName: dm.model, presetName: '' };
    }
  } catch (error) {
    console.warn('[StudioRuntime] global default model resolution skipped:', error?.message || error);
  }

  try {
    const config = JSON.parse(readFileSync(join(PROTOCLAW_ROOT, 'config', 'default.json'), 'utf8'));
    const defaultModel = config?.defaultModel;
    if (defaultModel?.model) {
      const raw = JSON.parse(readFileSync(join(PROTOCLAW_ROOT, 'config', 'presets.json'), 'utf8'));
      const presets = Array.isArray(raw?.presets) ? raw.presets : [];
      const candidates = presets.filter((p) => p.model === defaultModel.model);
      const preset = candidates.find((p) => (p.protocol || 'anthropic') === (defaultModel.protocol || 'anthropic'))
        || candidates[0];
      if (preset) {
        const resolved = resolveModelPresetLLM(preset.name);
        if (resolved) return resolved;
      }
    }
  } catch (error) {
    console.warn('[StudioRuntime] preset-by-model-name fallback skipped:', error?.message || error);
  }
  return null;
}

/** Locate the feature class export: sole class export, or class default export. */
function resolveFeatureClass(moduleExports) {
  const classExports = Object.entries(moduleExports).filter(
    ([, value]) => typeof value === 'function' && /^\s*class\s+/.test(Function.prototype.toString.call(value)),
  );
  if (classExports.length === 1) return classExports[0][1];
  const defaultExport = moduleExports.default;
  if (typeof defaultExport === 'function' && /^\s*class\s+/.test(Function.prototype.toString.call(defaultExport))) {
    return defaultExport;
  }
  const available = Object.keys(moduleExports).filter((key) => key !== 'default');
  throw new Error(`no feature class export found (available exports: ${available.join(', ') || '(none)'})`);
}

function buildSystemMessage(project) {
  return [
    '你是 Agent Studio Test Runtime 中的被测 Agent。',
    `项目：${project?.name || '未命名'}`,
    `目标：${project?.goal || '未指定'}`,
    project?.targetAgent ? `目标 Agent：${project.targetAgent}` : '',
    '根据输入正常完成任务；环境中挂载了正在开发中的 Feature，请正常使用它们暴露的工具。',
  ].filter(Boolean).join('\n');
}

/** Wrap every registered tool's execute so run evidence is recorded. */
function patchToolRegistry(agent, evidence) {
  const registry = agent.tools;
  const origRegister = registry.register.bind(registry);
  registry.register = (tool, source) => origRegister(wrapTool(tool, evidence), source);
}

function wrapTool(tool, evidence) {
  if (!tool || typeof tool.execute !== 'function') return tool;
  const wrapped = Object.create(tool);
  wrapped.execute = async (...args) => {
    const startedAt = Date.now();
    const entry = { tool: tool.name, at: new Date().toISOString() };
    try {
      const result = await tool.execute(...args);
      entry.ok = true;
      entry.durationMs = Date.now() - startedAt;
      entry.result = summarize(result);
      evidence.current.push(entry);
      return result;
    } catch (error) {
      entry.ok = false;
      entry.durationMs = Date.now() - startedAt;
      entry.error = String(error?.message || error);
      evidence.current.push(entry);
      throw error;
    }
  };
  return wrapped;
}

/**
 * Host-side observe feature: records every ToolFinished result, including
 * calls blocked by a guard Deny (their execute never runs, so the execute
 * wrapper misses them). Denied entries surface in run evidence instead of
 * silently vanishing.
 */
class EvidenceCollector {
  static hooks = {
    onToolFinished: { lifecycle: 'ToolFinished', kind: 'observe' },
  };

  name = 'studio-evidence';
  description = 'Test Runtime host evidence collector: records every finished tool call, including guard-denied ones.';

  constructor(evidence) {
    this.evidence = evidence;
  }

  async onToolFinished(ctx) {
    this.evidence.finished.push({
      tool: String(ctx?.toolName || ''),
      at: new Date().toISOString(),
      ok: ctx?.success === true,
      error: ctx?.error ? String(ctx.error) : undefined,
      durationMs: typeof ctx?.duration === 'number' ? ctx.duration : 0,
    });
  }
}

/**
 * Merge executed entries with finished results (chronological). A finished
 * result with no matching executed entry means execute never ran — the call
 * was blocked before execution (guard deny / disabled tool).
 */
function mergeEvidence(executed, finished) {
  const remaining = new Map();
  for (const entry of executed) {
    remaining.set(entry.tool, (remaining.get(entry.tool) || 0) + 1);
  }
  const taken = new Map();
  const byName = new Map();
  for (const entry of executed) {
    const list = byName.get(entry.tool) || [];
    list.push(entry);
    byName.set(entry.tool, list);
  }
  const out = [];
  for (const fin of finished) {
    const left = remaining.get(fin.tool) || 0;
    if (left > 0) {
      remaining.set(fin.tool, left - 1);
      const idx = taken.get(fin.tool) || 0;
      const entry = (byName.get(fin.tool) || [])[idx];
      taken.set(fin.tool, idx + 1);
      out.push(entry);
    } else {
      out.push({
        tool: fin.tool,
        at: fin.at,
        ok: false,
        denied: true,
        error: fin.error || 'blocked before execution',
      });
    }
  }
  return out;
}

async function main() {
  const projectDir = clean(process.argv[2]);
  if (!projectDir || !existsSync(projectDir)) {
    failReady(`projectDir 无效: ${process.argv[2] || '(empty)'}`);
    return;
  }

  const projectPath = join(projectDir, 'agent-studio.json');
  let project;
  try {
    project = JSON.parse(readFileSync(projectPath, 'utf8'));
  } catch (error) {
    failReady(`无法读取 agent-studio.json: ${error?.message || error}`);
    return;
  }

  const featureEntries = (Array.isArray(project.features) ? project.features : [])
    .map((entry) => ({ name: clean(entry?.name), modulePath: clean(entry?.modulePath) }))
    .filter((entry) => entry.name && entry.modulePath);

  const resolvedLLM = resolveRuntimeLLM();
  if (!resolvedLLM) {
    failReady('没有可用的模型预设：请为 agent-studio 配置模型预设，或设置 config/default.json 的全局默认模型。');
    return;
  }

  const agent = new Agent({
    llm: resolvedLLM.llm,
    name: 'studio-test-runtime',
    systemMessage: buildSystemMessage(project),
    workspaceDir: projectDir,
    projectRoot: PROTOCLAW_ROOT,
  });

  const evidence = { current: [], finished: [] };
  patchToolRegistry(agent, evidence);
  await agent.mountFeature(new EvidenceCollector(evidence), { strictInit: true });

  // Structured observability: join the shared DebugHub so the runtime's logs,
  // hook inspector and events land in the same stream the dev agent queries
  // (debugger MCP). Absent viewer -> local-only, reported in the ready payload.
  let observability = 'local-only';
  let viewerAgentId = null;
  const viewerPort = Number(process.env.STUDIO_VIEWER_PORT || 0);
  if (viewerPort > 0) {
    try {
      await agent.withViewer(
        `studio-sandbox:${clean(project?.name) || 'project'}`,
        viewerPort,
        false,
        { projectRoot: projectDir, inputPolicy: 'none' },
      );
      observability = 'hub';
      viewerAgentId = agent.agentId ?? null;
    } catch (error) {
      console.warn('[StudioRuntime] viewer connect failed, continuing local-only:', error?.message || error);
    }
  }

  const mounted = [];
  for (const entry of featureEntries) {
    if (!existsSync(entry.modulePath)) {
      failReady(`feature '${entry.name}' 模块文件不存在: ${entry.modulePath}`, entry.name);
      return;
    }
    try {
      const mod = await import(pathToFileURL(entry.modulePath).href);
      const FeatureClass = resolveFeatureClass(mod);
      const instance = new FeatureClass();
      const reportedName = clean(instance?.name);
      if (reportedName !== entry.name) {
        failReady(`feature 模块声明的 name '${reportedName || '(empty)'}' 与注册名 '${entry.name}' 不一致`, entry.name);
        return;
      }
      await agent.mountFeature(instance, { strictInit: true });
      mounted.push({ name: entry.name, mounted: true });
    } catch (error) {
      const stage = error?.featureInitStage ? 'init' : 'mount';
      failReady(`feature '${entry.name}' ${stage} 失败: ${error?.message || error}`, entry.name, error);
      return;
    }
  }

  // Force feature initialization now (strict): tools register and init failures
  // surface at startup instead of leaking into the first test run.
  try {
    await agent.ensureFeatureTools({ strict: true });
  } catch (error) {
    failReady(`feature 初始化失败: ${error?.message || error}`, undefined, error);
    return;
  }

  // Session persistence: reload/restart keeps the test conversation.
  const sessionDir = join(projectDir, '.agent-studio', 'runtime-sessions');
  mkdirSync(sessionDir, { recursive: true });
  const store = new FileSessionStore(sessionDir);
  let sessionRestored = false;
  try {
    await agent.loadSession(SESSION_ID, store);
    sessionRestored = true;
    console.log('[StudioRuntime] session restored:', SESSION_ID);
  } catch {
    sessionRestored = false;
    console.log('[StudioRuntime] starting with a fresh session');
  }

  async function saveSessionQuiet() {
    try {
      await agent.saveSession(SESSION_ID, store);
    } catch (error) {
      console.warn('[StudioRuntime] session save failed:', error?.message || error);
    }
  }

  send({
    type: 'studio-ready',
    ok: true,
    pid: process.pid,
    model: resolvedLLM.modelName,
    sessionRestored,
    observability,
    viewerAgentId,
    features: mounted,
    featureCount: mounted.length,
  });

  // ── IPC handlers (serialized) ──────────────────────────────
  async function handleEnsure(msg) {
    const featureName = clean(msg.featureName);
    const modulePath = clean(msg.modulePath);
    if (agent.features?.get(featureName)) {
      send({ type: 'studio-result', requestId: msg.requestId, operation: 'ensure', ok: true, featureName, alreadyMounted: true });
      return;
    }
    if (!existsSync(modulePath)) {
      send({
        type: 'studio-result', requestId: msg.requestId, operation: 'ensure', ok: false, featureName,
        error: { name: 'Error', message: `模块文件不存在: ${modulePath}`, stack: '' },
      });
      return;
    }
    try {
      const mod = await import(pathToFileURL(modulePath).href);
      const FeatureClass = resolveFeatureClass(mod);
      const instance = new FeatureClass();
      await runWithLogScope(
        { tags: [`studio-sync:${clean(msg.runId) || 'startup'}:${featureName}`] },
        () => agent.mountFeature(instance, { strictInit: true }),
      );
      send({ type: 'studio-result', requestId: msg.requestId, operation: 'ensure', ok: true, featureName, alreadyMounted: false });
    } catch (error) {
      send({
        type: 'studio-result', requestId: msg.requestId, operation: 'ensure', ok: false, featureName,
        stage: error?.featureInitStage ? 'init' : 'mount',
        error: serializeError(error),
      });
    }
  }

  async function handleReload(msg) {
    const featureName = clean(msg.featureName);
    const modulePath = clean(msg.modulePath);
    try {
      const result = await runWithLogScope(
        { tags: [`studio-sync:${clean(msg.runId) || 'startup'}:${featureName}`] },
        () => agent.reloadFeature(featureName, modulePath, { strictInit: true }),
      );
      send({
        type: 'studio-result', requestId: msg.requestId, operation: 'reload', ok: true,
        featureName, durationMs: result.durationMs, stateTransferred: result.stateTransferred,
      });
    } catch (error) {
      send({
        type: 'studio-result', requestId: msg.requestId, operation: 'reload', ok: false,
        featureName,
        stage: error?.reloadStage || 'unknown',
        reverted: error?.rolledBack === true,
        error: serializeError(error),
      });
    }
  }

  async function handleRunTest(msg) {
    const input = String(msg.input ?? '');
    const runId = clean(msg.runId) || 'ad-hoc';
    evidence.current = [];
    evidence.finished = [];
    let reply;
    let callError;
    try {
      reply = await runWithLogScope({ tags: [`studio-run:${runId}`] }, () => agent.onCall(input));
    } catch (error) {
      callError = serializeError(error);
    }
    await saveSessionQuiet();
    send({
      type: 'studio-result', requestId: msg.requestId, operation: 'run-test',
      ok: !callError,
      testId: clean(msg.testId) || null,
      runId,
      reply: typeof reply === 'string' ? truncate(reply, RUN_TEST_REPLY_LIMIT) : summarize(reply),
      toolCalls: mergeEvidence(evidence.current, evidence.finished),
      ...(callError ? { error: callError } : {}),
    });
  }

  async function handleInspect(msg) {
    const features = agent.features ? Array.from(agent.features.keys()) : [];
    const tools = agent.tools ? agent.tools.getAll().map((tool) => tool.name) : [];
    const messages = typeof agent.getContext === 'function' ? agent.getContext().getAll() : [];
    send({
      type: 'studio-result', requestId: msg.requestId, operation: 'inspect', ok: true,
      features, toolNames: tools, messageCount: messages.length,
      model: resolvedLLM.modelName, sessionRestored,
      evidenceTail: evidence.current.slice(-20),
    });
  }

  async function handleShutdown(msg) {
    await saveSessionQuiet();
    send({ type: 'studio-result', requestId: msg.requestId, operation: 'shutdown', ok: true });
    process.exit(0);
  }

  const handlers = {
    'studio-ensure-feature': handleEnsure,
    'studio-reload-feature': handleReload,
    'studio-run-test': handleRunTest,
    'studio-inspect': handleInspect,
    'studio-shutdown': handleShutdown,
  };

  let queue = Promise.resolve();
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const handler = handlers[msg.type];
    if (!handler) return;
    queue = queue.then(() => handler(msg)).catch((error) => {
      send({
        type: 'studio-result', requestId: msg.requestId, operation: 'internal',
        ok: false, error: serializeError(error),
      });
    });
  });

  // Parent gone (dev agent restart / crash): stop the runtime.
  process.on('disconnect', () => {
    console.log('[StudioRuntime] parent disconnected, exiting');
    process.exit(0);
  });

  console.log(`[StudioRuntime] ready: model=${resolvedLLM.modelName} features=${mounted.length} sessionRestored=${sessionRestored}`);
}

main().catch((error) => {
  failReady(`启动异常: ${error?.message || error}`, undefined, error);
});
