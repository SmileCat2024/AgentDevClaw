/**
 * Flow 工作空间 Agent
 *
 * 支持双模式运行：
 * 1. 工作空间模式（首页）：展示 flow-editor / assembly 等块
 * 2. 装配会话模式（对话）：加载用户选择的 Features + Agent 配套编排图
 */

import { BasicAgent, TemplateComposer, UserInputFeature, createLLM } from 'agentdev';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { FlowFeature } from '../../../local-features/dist/flow/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = join(__dirname, '..', '..', '..');
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const WORKSPACE_STATE_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'flow-workspace', 'state.json');
const SESSION_INDEX_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'flow-workspace', 'sessions', 'index.json');
const FLOWS_ROOT = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'flows');
const AGENT_GRAPH_ID = 'agent-flow-graph';
const MODEL_PRESETS_PATH = join(PROTOCLAW_ROOT, 'config', 'presets.json');

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isAutoEntryMode(mode) {
  return mode === 'auto' || mode === 'auto-reenterable';
}

function parseList(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatFeatureLabel(token) {
  return cleanValue(token)
    .replace(/^@agentdev\//, '')
    .replace(/-feature$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeFeatureToken(value) {
  return cleanValue(value)
    .replace(/^@agentdev\//, '')
    .replace(/-feature$/, '');
}

function getFeatureConfigFromWorkspace(featureConfigs, token) {
  if (!featureConfigs || typeof featureConfigs !== 'object') return {};
  const candidates = new Set();
  const rawToken = cleanValue(token);
  const normalized = normalizeFeatureToken(rawToken);
  if (rawToken) candidates.add(rawToken);
  if (normalized) {
    candidates.add(normalized);
    candidates.add(`@agentdev/${normalized}`);
    candidates.add(`@agentdev/${normalized}-feature`);
  }

  for (const key of candidates) {
    const value = featureConfigs[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value };
    }
  }
  return {};
}

function readFlowWorkspaceState() {
  if (!existsSync(WORKSPACE_STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(WORKSPACE_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function resolveModelPresetLLM(presetName) {
  if (!presetName || !existsSync(MODEL_PRESETS_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(MODEL_PRESETS_PATH, 'utf8'));
    const presets = Array.isArray(raw?.presets) ? raw.presets : [];
    const providers = Array.isArray(raw?.providers) ? raw.providers : [];
    const preset = presets.find((p) => p.name === presetName);
    if (!preset) return null;
    const provider = providers.find((p) => p.name === preset.providerName);
    if (!provider) return null;
    const protocol = preset.protocol || 'anthropic';
    const baseUrl = provider.endpoints?.[protocol] || '';
    const apiKey = provider.apiKey || '';
    if (!baseUrl || !apiKey || !preset.model) return null;
    return createLLM({
      provider: protocol,
      model: preset.model,
      apiKey,
      baseUrl,
      thinkingBudgetTokens: preset.thinkingBudgetTokens ?? undefined,
    });
  } catch (error) {
    console.warn('[FlowWorkspace] Failed to resolve model preset:', error.message);
    return null;
  }
}

function readCurrentSessionFormId() {
  const sessionId = cleanValue(process.env.PROTOCLAW_PREBUILT_SESSION_ID);
  if (!sessionId || !existsSync(SESSION_INDEX_PATH)) return '';
  try {
    const parsed = JSON.parse(readFileSync(SESSION_INDEX_PATH, 'utf8'));
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const matched = sessions.find((s) => cleanValue(s?.id) === sessionId);
    return cleanValue(matched?.formId);
  } catch {
    return '';
  }
}

function readAgentGraph(assemblyForm = {}) {
  const projectId = cleanValue(assemblyForm.assembly_name) || 'flow-workspace';
  const flowPath = join(FLOWS_ROOT, projectId, `${AGENT_GRAPH_ID}.json`);
  if (!existsSync(flowPath)) return null;
  try {
    return JSON.parse(readFileSync(flowPath, 'utf8'));
  } catch {
    return null;
  }
}

function graphToRuntimeFlows(graph) {
  if (!graph || !Array.isArray(graph.nodes)) return [];
  if (graph.mode && graph.entry && !graph.workflows) return [graph];

  const nodes = graph.nodes;
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set()]));
  const isWorkflowHead = (node) => Boolean(node && (node.type === 'workflow-head' || node.kind === 'workflow-head'));
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }

  const heads = nodes.filter(isWorkflowHead);
  if (heads.length > 0) {
    let autoSeen = false;
    return heads.map((head, index) => {
      const workflowId = cleanValue(head.workflowId) || Object.entries(graph.workflows || {})
        .find(([, meta]) => cleanValue(meta?.entry) === head.id)?.[0] || `workflow-${index + 1}`;
      const meta = graph.workflows?.[workflowId] || {};
      const seen = new Set([head.id]);
      const queue = [head.id];
      while (queue.length) {
        const id = queue.shift();
        for (const next of adjacency.get(id) || []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }

      const runtimeNodes = [...seen]
        .map((id) => byId.get(id))
        .filter((node) => node && !isWorkflowHead(node));
      if (runtimeNodes.length === 0) return null;

      const runtimeNodeIds = new Set(runtimeNodes.map((node) => node.id));
      const firstFromHead = edges.find((edge) => edge.from === head.id && runtimeNodeIds.has(edge.to))?.to
        || edges.find((edge) => edge.to === head.id && runtimeNodeIds.has(edge.from))?.from;
      const entry = runtimeNodeIds.has(meta.runtimeEntry) ? meta.runtimeEntry
        : (runtimeNodeIds.has(meta.entry) ? meta.entry : (firstFromHead || runtimeNodes[0]?.id));
      let mode = meta.mode || 'agent-initiated';
      if (isAutoEntryMode(mode)) {
        if (autoSeen) mode = 'agent-initiated';
        autoSeen = true;
      }

      return {
        id: workflowId,
        name: meta.name || head.name || `工作流 ${index + 1}`,
        description: meta.description || '',
        mode,
        nodes: runtimeNodes.map((item) => {
          const { position, workflowId: _workflowId, ...runtimeNode } = item;
          return runtimeNode;
        }),
        edges: edges.filter((edge) => runtimeNodeIds.has(edge.from) && runtimeNodeIds.has(edge.to)),
        entry,
        reminderFrequency: meta.reminderFrequency || 'every-step',
        reminderInterval: meta.reminderInterval,
        variables: meta.variables || {},
        prompts: meta.prompts || [],
      };
    }).filter(Boolean);
  }

  const seen = new Set();
  let autoSeen = false;
  const flows = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    const queue = [node.id];
    const ids = [];
    seen.add(node.id);
    while (queue.length) {
      const id = queue.shift();
      ids.push(id);
      for (const next of adjacency.get(id) || []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    const componentNodes = ids.map((id) => byId.get(id)).filter(Boolean);
    const workflowIds = new Map();
    for (const item of componentNodes) {
      workflowIds.set(item.workflowId, (workflowIds.get(item.workflowId) || 0) + 1);
    }
    const workflowId = [...workflowIds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || `workflow-${flows.length + 1}`;
    const meta = graph.workflows?.[workflowId] || {};
    const entry = componentNodes.some((item) => item.id === meta.entry) ? meta.entry : componentNodes[0]?.id;
    let mode = meta.mode || 'agent-initiated';
    if (isAutoEntryMode(mode)) {
      if (autoSeen) mode = 'agent-initiated';
      autoSeen = true;
    }

    flows.push({
      id: workflowId,
      name: meta.name || `工作流 ${flows.length + 1}`,
      description: meta.description || '',
      mode,
      nodes: componentNodes.map((item) => {
        const { position, workflowId: _workflowId, ...runtimeNode } = item;
        return runtimeNode;
      }),
      edges: edges.filter((edge) => ids.includes(edge.from) && ids.includes(edge.to)),
      entry,
      reminderFrequency: meta.reminderFrequency || 'every-step',
      reminderInterval: meta.reminderInterval,
      variables: meta.variables || {},
      prompts: meta.prompts || [],
    });
  }
  return flows;
}

async function instantiateSelectableFeature(token, config, projectFeatureConfig = {}) {
  const normalized = cleanValue(token).replace(/^@agentdev\//, '');
  if (!normalized) return null;

  const moduleName = `@agentdev/${normalized}`;
  const featureConfig = {
    workspaceDir: config.workspaceDir,
    projectRoot: config.projectRoot,
    workdir: config.projectRoot,
    resourceRoot: config.projectRoot,
    ...projectFeatureConfig,
  };

  try {
    const workspaceRequire = createRequire(join(config.workspaceDir, 'package.json'));
    const entryPath = workspaceRequire.resolve(moduleName);
    const mod = await import(pathToFileURL(entryPath).href);
    const entry = Object.entries(mod).find(([name, value]) => typeof value === 'function' && /Feature$/.test(name));
    if (!entry) {
      console.warn(`[FlowWorkspace] Feature package ${moduleName} loaded but no *Feature export was found.`);
      return null;
    }
    return new entry[1](featureConfig);
  } catch (error) {
    console.warn(`[FlowWorkspace] Failed to load feature ${moduleName}:`, error.message);
    return null;
  }
}

export class FlowWorkspaceAgent extends BasicAgent {
  constructor(config = {}) {
    const resolvedProjectRoot = config.projectRoot ?? PROTOCLAW_ROOT;
    const assemblySessionMode = readCurrentSessionFormId() === 'assembly-form';

    // 预解析 assembly 配置（在 super() 之前，用于 LLM 和 workdir）
    let preAssemblyForm = {};
    let preResolvedLLM = config.llm || null;
    let preResolvedWorkspaceDir = config.workspaceDir ?? PROTOCLAW_ROOT;
    let preSkillConfig = null;
    if (assemblySessionMode) {
      const ws = readFlowWorkspaceState();
      preAssemblyForm = ws?.forms?.['assembly-form'] || {};
      if (!preResolvedLLM && cleanValue(preAssemblyForm.model_preset)) {
        preResolvedLLM = resolveModelPresetLLM(cleanValue(preAssemblyForm.model_preset));
        if (preResolvedLLM) {
          console.log(`[FlowWorkspace] Using model preset: ${preAssemblyForm.model_preset}`);
        }
      }
      const customWorkdir = cleanValue(preAssemblyForm.workdir);
      if (customWorkdir) {
        preResolvedWorkspaceDir = customWorkdir;
      }
      // 读取 skill feature 配置
      const featureConfigs = ws?.forms?.['feature-configs'] || {};
      preSkillConfig = getFeatureConfigFromWorkspace(featureConfigs, 'skill');
    }

    super({
      ...config,
      ...(preResolvedLLM ? { llm: preResolvedLLM } : {}),
      ...(preSkillConfig && Object.keys(preSkillConfig).length > 0 ? { skillConfig: preSkillConfig } : {}),
      projectRoot: resolvedProjectRoot,
      workspaceDir: preResolvedWorkspaceDir,
    });

    this._resolvedProjectRoot = resolvedProjectRoot;
    this._resolvedWorkspaceDir = preResolvedWorkspaceDir;
    this._assemblySessionMode = assemblySessionMode;
    this._assemblyFeatureTokens = [];
    this._assemblyForm = null;
    this._assemblyFeaturesMounted = false;
    this._assemblyRuntimeConfigApplied = false;
    this._assemblySystemPromptText = '';
    this._workspaceState = null;
    this._assemblyFeatureConfigs = {};

    if (this._assemblySessionMode) {
      const workspaceState = readFlowWorkspaceState();
      this._workspaceState = workspaceState;
      const assemblyForm = preAssemblyForm || workspaceState?.forms?.['assembly-form'] || {};
      this._assemblyFeatureConfigs = workspaceState?.forms?.['feature-configs'] || {};
      this._assemblyForm = assemblyForm;
      this._assemblyFeatureTokens = parseList(assemblyForm.selected_features);

      const flowData = readAgentGraph(assemblyForm);
      const runtimeFlows = graphToRuntimeFlows(flowData);
      if (runtimeFlows.length > 0) {
        this.use(new FlowFeature({
          flows: runtimeFlows,
        }));
      } else {
        this.use(new FlowFeature({ flows: [] }));
      }
    }

    if (!this._assemblySessionMode) {
      this.use(new FlowFeature());
    }

    this.use(new UserInputFeature());
  }

  async ensureAssemblyFeaturesMounted() {
    if (!this._assemblySessionMode || this._assemblyFeaturesMounted) return;

    if (this._assemblyFeatureTokens.length > 0) {
      const mounted = [];
      for (const token of this._assemblyFeatureTokens) {
        const projectFeatureConfig = getFeatureConfigFromWorkspace(this._assemblyFeatureConfigs, token);
        const feature = await instantiateSelectableFeature(token, {
          workspaceDir: this._resolvedWorkspaceDir,
          projectRoot: this._resolvedProjectRoot,
        }, projectFeatureConfig);
        if (feature) {
          this.use(feature);
          this.config.features = this.config.features || {};
          this.config.features[feature.name] = { ...projectFeatureConfig };
          mounted.push(`${token}=>${feature.name}`);
        }
      }
      console.log(`[FlowWorkspace] Mounted assembly features: ${mounted.length ? mounted.join(', ') : 'none'}`);
    }
    this._assemblyFeaturesMounted = true;
  }

  buildAssemblySystemPrompt() {
    const rawDisplayName = cleanValue(this._assemblyForm?.display_name);
    const assemblyName = rawDisplayName || cleanValue(this._assemblyForm?.assembly_name) || 'assembled-agent';
    const targetUser = cleanValue(this._assemblyForm?.target_user);
    const goal = cleanValue(this._assemblyForm?.goal);
    const constraints = cleanValue(this._assemblyForm?.constraints);
    const preset = cleanValue(this._assemblyForm?.preset);
    const customSystemPrompt = cleanValue(this._assemblyForm?.custom_system_prompt);
    const enabledFeatures = this._assemblyFeatureTokens.map((item) => formatFeatureLabel(item)).filter(Boolean);

    if (customSystemPrompt) {
      return customSystemPrompt;
    }

    return [
      '你是一个已经组装完成并直接面对最终用户的 Agent。',
      `你的名称是：${assemblyName}。`,
      `预设定位：${preset || 'general-chatbot'}。`,
      targetUser ? `目标用户：${targetUser}` : '',
      goal ? `主要目标：${goal}` : '',
      constraints ? `边界与限制：${constraints}` : '',
      enabledFeatures.length > 0 ? `当前已启用能力：${enabledFeatures.join('、')}` : '',
      '当前可用工作流如下：\n{{flowSummaryText|（暂无可用工作流）}}',
      '其中需要你主动调用 enter_flow 的工作流如下：\n{{agentInitiatedFlowSummaryText|（无）}}',
      '其中会自动进入的工作流如下：\n{{autoFlowSummaryText|（无）}}',
      '你会按当前 Agent 项目绑定的编排图工作。需要进入某个工作流时使用 enter_flow；若当前节点存在多个后续分支，调用 complete_node 时必须明确指定目标节点。',
      '直接以目标 Agent 身份与用户对话，不要提及 Flow 工作空间、装配过程或内部实现。',
      '没有启用的能力不要假装拥有。',
    ].filter(Boolean).join('\n\n');
  }

  async applyAssemblyRuntimeConfig() {
    if (!this._assemblySessionMode) return;
    await this.ensureAssemblyFeaturesMounted();

    const promptText = this.buildAssemblySystemPrompt();
    this._assemblySystemPromptText = promptText;
    this.setSystemPrompt(new TemplateComposer().add(promptText));

    // 收集所有 Feature 的 Flow 变量值并注入到系统上下文
    this._injectFlowVariablesIntoContext();

    if (!this._assemblyRuntimeConfigApplied) {
      console.log(`[FlowWorkspace] Assembly runtime configured: ${this._assemblyFeatureTokens.length} feature(s), prompt=${promptText ? 'ready' : 'empty'}`);
      this._assemblyRuntimeConfigApplied = true;
    }
  }

  _injectFlowVariablesIntoContext() {
    if (!this.features || !(this.features instanceof Map)) return;
    const flowVarContext = {};
    for (const [, feature] of this.features) {
      if (typeof feature.getFlowVariables === 'function') {
        try {
          const vars = feature.getFlowVariables();
          if (Array.isArray(vars)) {
            for (const v of vars) {
              if (v && v.key && typeof v.resolver === 'function') {
                try { flowVarContext[v.key] = v.resolver(); } catch {}
              }
            }
          }
        } catch {}
      }
    }
    const keys = Object.keys(flowVarContext);
    if (keys.length > 0) {
      const nextContext = { ...(this._systemContext || {}), ...flowVarContext };
      this._systemContext = nextContext;
      this.setSystemContext(nextContext);
    }
  }

  async prepareRuntime() {
    await this.applyAssemblyRuntimeConfig();
  }

  async onCall(input) {
    await this.applyAssemblyRuntimeConfig();
    return super.onCall(input);
  }

  async onInitiate(ctx) {
    await this.applyAssemblyRuntimeConfig();
    await super.onInitiate(ctx);
    await this.applyAssemblyRuntimeConfig();
  }
}

export default FlowWorkspaceAgent;
