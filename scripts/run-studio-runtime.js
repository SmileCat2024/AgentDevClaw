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
 *   { type: 'studio-sync-features', requestId, runId, ensure[], reload[] }
 *   { type: 'studio-run-test', requestId, testId?, input, runId, sessionPolicy, checkpoint? }
 *   { type: 'studio-save-checkpoint', requestId, name }
 *   { type: 'studio-remove-feature', requestId, featureName }
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
const STATEFUL_SESSION_ID = 'default';
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

// ── Evidence collection ─────────────────────────────────────────────────────

/**
 * Wrap every registered tool's execute with an "executed" marker (ok +
 * duration). Results are NOT recorded here — the post-transform delivered
 * result comes from the ToolFinished hook below, which is the value the model
 * actually received.
 */
function patchToolRegistry(agent, evidence) {
  const registry = agent.tools;
  const origRegister = registry.register.bind(registry);
  registry.register = (tool, source) => origRegister(wrapTool(tool, source, evidence), source);
}

function wrapTool(tool, source, evidence) {
  if (!tool || typeof tool.execute !== 'function') return tool;
  const wrapped = Object.create(tool);
  wrapped.execute = async (...args) => {
    const startedAt = Date.now();
    const entry = { tool: tool.name, feature: clean(source) || undefined, at: new Date().toISOString() };
    try {
      const result = await tool.execute(...args);
      entry.ok = true;
      entry.durationMs = Date.now() - startedAt;
      evidence.executed.push(entry);
      return result;
    } catch (error) {
      entry.ok = false;
      entry.durationMs = Date.now() - startedAt;
      entry.error = String(error?.message || error);
      evidence.executed.push(entry);
      throw error;
    }
  };
  return wrapped;
}

/**
 * Host-side observe feature: records every ToolFinished result with the
 * delivered (post-ToolResultTransform) payload, including calls blocked by a
 * guard Deny (their execute never runs, so the executed marker misses them).
 */
class EvidenceCollector {
  static hooks = {
    onToolFinished: { lifecycle: 'ToolFinished', kind: 'observe' },
  };

  name = 'studio-evidence';
  description = 'Test Runtime host evidence collector: records every finished tool call with its delivered result.';

  constructor(evidence, agent) {
    this.evidence = evidence;
    this.agent = agent;
  }

  async onToolFinished(ctx) {
    const tool = String(ctx?.toolName || '');
    if (!tool) return;
    const delivered = ctx?.delivered;
    this.evidence.finished.push({
      tool,
      at: new Date().toISOString(),
      ok: ctx?.success === true,
      error: ctx?.error ? String(ctx.error) : undefined,
      durationMs: typeof ctx?.duration === 'number' ? ctx.duration : 0,
      ...(delivered?.result !== undefined ? { deliveredResult: delivered.result } : {}),
    });
  }
}

/**
 * Merge executed markers with finished results (chronological). A finished
 * result with no matching executed marker means execute never ran — the call
 * was blocked before execution (guard deny / disabled tool). The recorded
 * result is the delivered (post-transform) value.
 */
function mergeEvidence(executed, finished, getSource) {
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
      out.push({
        tool: fin.tool,
        feature: entry?.feature || clean(getSource(fin.tool)) || undefined,
        at: fin.at,
        ok: fin.ok,
        durationMs: fin.durationMs,
        ...(fin.deliveredResult !== undefined ? { result: fin.deliveredResult } : {}),
        ...(fin.error && !fin.ok ? { error: fin.error } : {}),
      });
    } else {
      out.push({
        tool: fin.tool,
        feature: clean(getSource(fin.tool)) || undefined,
        at: fin.at,
        ok: false,
        denied: true,
        error: fin.error || 'blocked before execution',
      });
    }
  }
  return out;
}

// ── Assembly ordering (static inject topological sort) ─────────────────────

function readInject(className) {
  const inject = className?.inject;
  if (!Array.isArray(inject)) return [];
  return inject.map(clean).filter(Boolean);
}

/**
 * Topologically order `pending` entries against already-mounted features.
 * Deps satisfied by mounted features are OK; deps missing everywhere are
 * reported per-feature. Returns { order, missing: Map<name, dep>, cycle }.
 */
function planAssemblyOrder(pending, mountedNames, injectOf) {
  const pendingNames = new Set(pending.map((entry) => entry.name));
  const missing = new Map();
  const deps = new Map();
  const nodes = [...mountedNames, ...pendingNames];
  for (const name of nodes) {
    const inject = injectOf(name) || [];
    const unsatisfied = inject.filter((dep) => !pendingNames.has(dep) && !mountedNames.has(dep));
    for (const dep of unsatisfied) {
      if (!missing.has(name)) missing.set(name, dep);
    }
    // 只对 pending 内部与 pending→pending 的边建图；mounted 已就位
    deps.set(name, inject.filter((dep) => pendingNames.has(dep)));
  }
  // Kahn：稳定排序（登记顺序为 tie-breaker）
  const order = [];
  const pendingQueue = pending.map((entry) => entry.name);
  const resolved = new Set(mountedNames);
  const indegree = new Map();
  for (const name of pendingQueue) indegree.set(name, (deps.get(name) || []).length);
  let progress = true;
  while (order.length < pendingQueue.length && progress) {
    progress = false;
    for (const name of pendingQueue) {
      if (resolved.has(name)) continue;
      if ((indegree.get(name) || 0) === 0) {
        resolved.add(name);
        order.push(name);
        progress = true;
      }
    }
    if (progress) {
      for (const name of pendingQueue) {
        if (resolved.has(name)) continue;
        // 已解析的依赖从入度中扣除
        const list = deps.get(name) || [];
        indegree.set(name, list.filter((dep) => !resolved.has(dep)).length);
      }
    }
  }
  if (order.length < pendingQueue.length) {
    const cyclic = pendingQueue.filter((name) => !resolved.has(name));
    return { order: [], missing, cycle: cyclic };
  }
  return { order, missing, cycle: null };
}

// ── Main ────────────────────────────────────────────────────────────────────

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

  const evidence = { executed: [], finished: [], hooks: [] };
  patchToolRegistry(agent, evidence);
  await agent.mountFeature(new EvidenceCollector(evidence, agent), { strictInit: true });

  // Hook invocation evidence: every guard/observe/transform call with its
  // feature, method, decision and duration — structured facts for assertions.
  agent.observeHookInvocations((inv) => {
    evidence.hooks.push({
      feature: clean(inv?.featureName),
      method: clean(inv?.methodName),
      lifecycle: String(inv?.lifecycle ?? ''),
      kind: String(inv?.kind ?? ''),
      ...(inv?.subject ? { subject: clean(inv.subject) } : {}),
      ...(inv?.decision !== undefined ? { decision: String(inv.decision) } : {}),
      ...(typeof inv?.durationMs === 'number' ? { durationMs: inv.durationMs } : {}),
      at: new Date().toISOString(),
    });
  });

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

  const getSource = (toolName) => {
    try {
      return agent.tools.getSource(toolName) || '';
    } catch {
      return '';
    }
  };

  const injectOfModuleCache = new Map();
  async function importFeatureModule(modulePath, bust) {
    const url = pathToFileURL(modulePath).href + (bust ? `?studio=${Date.now()}-${Math.random().toString(36).slice(2, 6)}` : '');
    const mod = await import(url);
    const FeatureClass = resolveFeatureClass(mod);
    const instance = new FeatureClass();
    return { FeatureClass, instance };
  }

  // 启动装配：读 static inject → 拓扑排序 → 按序挂载
  const mounted = [];
  {
    const pending = [];
    for (const entry of featureEntries) {
      if (!existsSync(entry.modulePath)) {
        failReady(`feature '${entry.name}' 模块文件不存在: ${entry.modulePath}`, entry.name);
        return;
      }
      try {
        const { FeatureClass, instance } = await importFeatureModule(entry.modulePath, false);
        const reportedName = clean(instance?.name);
        if (reportedName !== entry.name) {
          failReady(`feature 模块声明的 name '${reportedName || '(empty)'}' 与注册名 '${entry.name}' 不一致`, entry.name);
          return;
        }
        const inject = readInject(FeatureClass);
        injectOfModuleCache.set(entry.name, inject);
        pending.push({ ...entry, instance });
      } catch (error) {
        const stage = error?.featureInitStage ? 'init' : 'mount';
        failReady(`feature '${entry.name}' ${stage} 失败: ${error?.message || error}`, entry.name, error);
        return;
      }
    }
    const { order, missing, cycle } = planAssemblyOrder(pending, [], (name) => injectOfModuleCache.get(name));
    if (cycle) {
      failReady(`Feature 依赖存在循环：${cycle.join(' → ')}。请检查各 Feature 的 static inject 声明。`);
      return;
    }
    if (missing.size > 0) {
      const [name, dep] = missing.entries().next().value;
      failReady(`feature '${name}' 声明 static inject 依赖 '${dep}'，但装配中不存在该 Feature。请先注册被依赖的 Feature，或修正 inject 声明。`, name);
      return;
    }
    const byName = new Map(pending.map((entry) => [entry.name, entry]));
    for (const name of order) {
      const entry = byName.get(name);
      try {
        await agent.mountFeature(entry.instance, { strictInit: true });
        mounted.push({ name: entry.name, mounted: true });
      } catch (error) {
        const stage = error?.featureInitStage ? 'init' : 'mount';
        failReady(`feature '${entry.name}' ${stage} 失败: ${error?.message || error}`, entry.name, error);
        return;
      }
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

  // Session store: stateful conversation (default) + named checkpoints.
  const sessionDir = join(projectDir, '.agent-studio', 'runtime-sessions');
  mkdirSync(sessionDir, { recursive: true });
  const store = new FileSessionStore(sessionDir);

  const projectFeatureNames = new Set(featureEntries.map((entry) => entry.name));

  function resetProjectFeatureStates() {
    for (const name of projectFeatureNames) {
      const feature = agent.features?.get(name);
      if (feature && typeof feature.restoreState === 'function') {
        try {
          feature.restoreState({});
        } catch {
          // feature 状态重置失败不阻断测试，证据里会体现其实际行为
        }
      }
    }
  }

  /**
   * Session policy per run:
   * - fresh: 空上下文 + 空 Feature 状态，运行后不保存
   * - stateful: 恢复 default 会话（文件即真相），运行后保存回 default
   * - checkpointed: 从命名检查点恢复，运行后不写回（检查点保持不变）
   */
  async function prepareRun(policy, checkpointName) {
    if (policy === 'checkpointed') {
      const cpId = `cp-${checkpointName}`;
      try {
        await agent.loadSession(cpId, store);
      } catch {
        return { error: `检查点 ${cpId} 不存在。请先用 studio_save_checkpoint 保存，或修正 checkpoint 名称。` };
      }
      return { restoredFrom: cpId, saveTo: null };
    }
    agent.reset();
    resetProjectFeatureStates();
    if (policy === 'stateful') {
      try {
        await agent.loadSession(STATEFUL_SESSION_ID, store);
        return { restoredFrom: STATEFUL_SESSION_ID, saveTo: STATEFUL_SESSION_ID };
      } catch {
        return { restoredFrom: null, saveTo: STATEFUL_SESSION_ID };
      }
    }
    return { restoredFrom: null, saveTo: null };
  }

  async function saveSessionQuiet(sessionId) {
    try {
      await agent.saveSession(sessionId, store);
    } catch (error) {
      console.warn('[StudioRuntime] session save failed:', error?.message || error);
    }
  }

  let startupSessionRestored = false;
  try {
    await agent.loadSession(STATEFUL_SESSION_ID, store);
    startupSessionRestored = true;
    console.log('[StudioRuntime] stateful session restored:', STATEFUL_SESSION_ID);
  } catch {
    startupSessionRestored = false;
    console.log('[StudioRuntime] no stateful session yet, starting empty');
  }

  send({
    type: 'studio-ready',
    ok: true,
    pid: process.pid,
    model: resolvedLLM.modelName,
    sessionRestored: startupSessionRestored,
    observability,
    viewerAgentId,
    features: mounted,
    featureCount: mounted.length,
  });

  // ── IPC handlers (serialized) ──────────────────────────────

  async function handleSync(msg) {
    const ensure = Array.isArray(msg.ensure) ? msg.ensure : [];
    const reload = Array.isArray(msg.reload) ? msg.reload : [];
    const runId = clean(msg.runId) || 'startup';
    const perFeature = [];

    const mountedNames = agent.features
      ? Array.from(agent.features.keys()).filter((name) => name !== 'studio-evidence')
      : [];
    const injectOf = (name) => {
      if (injectOfModuleCache.has(name)) return injectOfModuleCache.get(name);
      const feature = agent.features?.get(name);
      const inject = readInject(feature?.constructor);
      injectOfModuleCache.set(name, inject);
      return inject;
    };

    const pending = [];
    for (const raw of ensure) {
      const name = clean(raw?.featureName || raw?.name);
      const modulePath = clean(raw?.modulePath);
      if (!name || !modulePath) continue;
      if (!existsSync(modulePath)) {
        perFeature.push({ featureName: name, action: 'failed', ok: false, stage: 'mount', error: `模块文件不存在: ${modulePath}` });
        continue;
      }
      try {
        const { FeatureClass, instance } = await importFeatureModule(modulePath, true);
        const reportedName = clean(instance?.name);
        if (reportedName !== name) {
          perFeature.push({
            featureName: name, action: 'failed', ok: false, stage: 'mount',
            error: `模块声明的 name '${reportedName || '(empty)'}' 与注册名 '${name}' 不一致`,
          });
          continue;
        }
        injectOfModuleCache.set(name, readInject(FeatureClass));
        pending.push({ name, modulePath, instance });
      } catch (error) {
        perFeature.push({
          featureName: name, action: 'failed', ok: false,
          stage: error?.featureInitStage ? 'init' : 'mount',
          error: error?.message || String(error),
        });
      }
    }

    if (pending.length > 0) {
      const { order, missing, cycle } = planAssemblyOrder(pending, mountedNames, injectOf);
      if (cycle) {
        send({
          type: 'studio-result', requestId: msg.requestId, operation: 'sync', ok: false, perFeature,
          error: { name: 'Error', message: `Feature 依赖存在循环：${cycle.join(' → ')}。请检查 static inject 声明。`, stack: '' },
        });
        return;
      }
      if (missing.size > 0) {
        const [name, dep] = missing.entries().next().value;
        send({
          type: 'studio-result', requestId: msg.requestId, operation: 'sync', ok: false, perFeature,
          error: { name: 'Error', message: `feature '${name}' 声明 static inject 依赖 '${dep}'，但装配中不存在该 Feature。`, stack: '' },
        });
        return;
      }
      const byName = new Map(pending.map((entry) => [entry.name, entry]));
      for (const name of order) {
        const entry = byName.get(name);
        try {
          await runWithLogScope(
            { tags: [`studio-sync:${runId}:${name}`] },
            () => agent.mountFeature(entry.instance, { strictInit: true }),
          );
          perFeature.push({ featureName: name, action: 'ensure-mounted', ok: true });
        } catch (error) {
          perFeature.push({
            featureName: name, action: 'failed', ok: false,
            stage: error?.featureInitStage ? 'init' : 'mount',
            error: error?.message || String(error),
          });
        }
      }
    }

    for (const raw of reload) {
      const featureName = clean(raw?.featureName || raw?.name);
      const modulePath = clean(raw?.modulePath);
      if (!featureName || !modulePath) continue;
      try {
        const result = await runWithLogScope(
          { tags: [`studio-sync:${runId}:${featureName}`] },
          () => agent.reloadFeature(featureName, modulePath, { strictInit: true }),
        );
        injectOfModuleCache.delete(featureName);
        perFeature.push({
          featureName, action: 'reloaded', ok: true,
          durationMs: result.durationMs, stateTransferred: result.stateTransferred === true,
        });
      } catch (error) {
        perFeature.push({
          featureName, action: 'failed', ok: false,
          stage: error?.reloadStage || 'unknown',
          reverted: error?.rolledBack === true,
          error: error?.message || String(error),
        });
      }
    }

    const ok = perFeature.every((entry) => entry.ok);
    send({ type: 'studio-result', requestId: msg.requestId, operation: 'sync', ok, perFeature });
  }

  async function handleRunTest(msg) {
    const input = String(msg.input ?? '');
    const runId = clean(msg.runId) || 'ad-hoc';
    const policy = ['fresh', 'stateful', 'checkpointed'].includes(msg.sessionPolicy) ? msg.sessionPolicy : 'stateful';
    const checkpoint = clean(msg.checkpoint);
    evidence.executed = [];
    evidence.finished = [];
    evidence.hooks = [];

    const prep = await prepareRun(policy, checkpoint);
    if (prep.error) {
      send({
        type: 'studio-result', requestId: msg.requestId, operation: 'run-test',
        ok: false, testId: clean(msg.testId) || null, runId,
        session: { policy, ...(checkpoint ? { checkpoint } : {}) },
        error: { name: 'Error', message: prep.error, stack: '' },
      });
      return;
    }

    let reply;
    let callError;
    try {
      reply = await runWithLogScope({ tags: [`studio-run:${runId}`] }, () => agent.onCall(input));
    } catch (error) {
      callError = serializeError(error);
    }
    if (prep.saveTo) await saveSessionQuiet(prep.saveTo);
    send({
      type: 'studio-result', requestId: msg.requestId, operation: 'run-test',
      ok: !callError,
      testId: clean(msg.testId) || null,
      runId,
      session: {
        policy,
        ...(checkpoint ? { checkpoint } : {}),
        ...(prep.restoredFrom ? { restoredFrom: prep.restoredFrom } : {}),
        saved: prep.saveTo || null,
      },
      reply: typeof reply === 'string' ? truncate(reply, RUN_TEST_REPLY_LIMIT) : summarize(reply),
      toolCalls: mergeEvidence(evidence.executed, evidence.finished, getSource),
      hooks: evidence.hooks,
      ...(callError ? { error: callError } : {}),
    });
  }

  async function handleSaveCheckpoint(msg) {
    const name = clean(msg.name);
    if (!name) {
      send({ type: 'studio-result', requestId: msg.requestId, operation: 'save-checkpoint', ok: false, error: { name: 'Error', message: 'checkpoint 名称不能为空。', stack: '' } });
      return;
    }
    const cpId = `cp-${name}`;
    try {
      const snapshot = await store.load(STATEFUL_SESSION_ID);
      await store.save(cpId, snapshot);
      const checkpoints = (await store.list()).filter((id) => id.startsWith('cp-'));
      send({ type: 'studio-result', requestId: msg.requestId, operation: 'save-checkpoint', ok: true, checkpoint: cpId, checkpoints });
    } catch (error) {
      send({
        type: 'studio-result', requestId: msg.requestId, operation: 'save-checkpoint', ok: false,
        error: { name: 'Error', message: `保存检查点失败（需要先以 stateful 策略运行建立 default 会话）: ${error?.message || error}`, stack: '' },
      });
    }
  }

  async function handleRemoveFeature(msg) {
    const featureName = clean(msg.featureName);
    try {
      agent.removeFeature(featureName);
      injectOfModuleCache.delete(featureName);
      send({ type: 'studio-result', requestId: msg.requestId, operation: 'remove-feature', ok: true, featureName });
    } catch (error) {
      send({ type: 'studio-result', requestId: msg.requestId, operation: 'remove-feature', ok: false, featureName, error: serializeError(error) });
    }
  }

  async function handleInspect(msg) {
    const features = agent.features ? Array.from(agent.features.keys()) : [];
    const tools = agent.tools ? agent.tools.getAll().map((tool) => tool.name) : [];
    const messages = typeof agent.getContext === 'function' ? agent.getContext().getAll() : [];
    let checkpoints = [];
    try {
      checkpoints = (await store.list()).filter((id) => id.startsWith('cp-'));
    } catch { /* 列表失败不阻断 */ }
    send({
      type: 'studio-result', requestId: msg.requestId, operation: 'inspect', ok: true,
      features, toolNames: tools, messageCount: messages.length,
      model: resolvedLLM.modelName, sessionRestored: startupSessionRestored,
      checkpoints,
    });
  }

  async function handleShutdown(msg) {
    send({ type: 'studio-result', requestId: msg.requestId, operation: 'shutdown', ok: true });
    process.exit(0);
  }

  const handlers = {
    'studio-sync-features': handleSync,
    'studio-run-test': handleRunTest,
    'studio-save-checkpoint': handleSaveCheckpoint,
    'studio-remove-feature': handleRemoveFeature,
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

  console.log(`[StudioRuntime] ready: model=${resolvedLLM.modelName} features=${mounted.length} sessionRestored=${startupSessionRestored}`);
}

main().catch((error) => {
  failReady(`启动异常: ${error?.message || error}`, undefined, error);
});
