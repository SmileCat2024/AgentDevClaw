import path from 'path';
import { existsSync, readFileSync, promises as fs } from 'fs';
import { pathToFileURL } from 'url';
import {
  USER_DATA_ROOT, rootRequire, PROJECT_ROOT,
} from '../shared/constants.js';
import { sanitizeSessionFragment, cleanSessionText, parseListField } from '../shared/string-helpers.js';
import { ensureDir } from '../shared/fs-helpers.js';
import { readModelPresets } from './model-config.js';

/* ── flow graph path helpers ─────────────────────────────────────── */

function getFlowGraphsDir(agentId) {
  return path.join(USER_DATA_ROOT, 'flows', sanitizeSessionFragment(agentId));
}

function getFlowGraphPath(agentId, flowId) {
  return path.join(getFlowGraphsDir(agentId), `${sanitizeSessionFragment(flowId)}.json`);
}

async function readFlowGraphFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return { flow: JSON.parse(raw), recovered: false };
  } catch (error) {
    const message = error?.message || '';
    const trailingMatch = message.match(/position\s+(\d+)/i);
    if (trailingMatch) {
      const cutoff = Number(trailingMatch[1]);
      if (Number.isFinite(cutoff) && cutoff > 0) {
        const trimmed = raw.slice(0, cutoff).trimEnd();
        try {
          return { flow: JSON.parse(trimmed), recovered: true };
        } catch {}
      }
    }
    throw error;
  }
}

/* ── capability serialization helpers ────────────────────────────── */

function serializeFlowVariable(variable, featureMeta) {
  if (!variable || !variable.key) return null;
  return {
    id: `${featureMeta.id}:${String(variable.key)}`,
    key: String(variable.key),
    type: String(variable.type || 'string'),
    title: String(variable.title || variable.key),
    description: String(variable.description || ''),
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFlowTool(tool, featureMeta) {
  if (!tool || !tool.name) return null;
  return {
    id: `${featureMeta.id}:${String(tool.name)}`,
    name: String(tool.name),
    title: String(tool.title || tool.name),
    description: String(tool.description || ''),
    parameters: tool.parameters || null,
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeNodeTemplate(template, featureMeta) {
  if (!template || !template.id) return null;
  return {
    ...template,
    id: String(template.id),
    source: 'feature',
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFlowMode(mode, featureMeta) {
  if (!mode || !mode.id) return null;
  return {
    ...mode,
    id: `${featureMeta.id}:${String(mode.id)}`,
    modeId: String(mode.id),
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

function serializeFeatureManifest(manifest, featureMeta) {
  if (!manifest) return null;
  return {
    ...manifest,
    featureId: featureMeta.id,
    featureName: featureMeta.name,
    packageName: featureMeta.packageName,
  };
}

/* ── feature instantiation helpers ───────────────────────────────── */

async function instantiateFeatureForCapability(packageName, workspaceState) {
  const moduleName = String(packageName || '').trim();
  if (!moduleName) return null;
  try {
    const entryPath = rootRequire.resolve(moduleName);
    const mod = await import(`${pathToFileURL(entryPath).href}?capabilities=${Date.now()}`);
    const entry = Object.entries(mod).find(([name, value]) => typeof value === 'function' && /Feature$/.test(name));
    if (!entry) return null;
    return new entry[1]({
      workspaceDir: cleanSessionText(workspaceState?.openDirectory) || PROJECT_ROOT,
      projectRoot: cleanSessionText(workspaceState?.openDirectory) || PROJECT_ROOT,
      workdir: cleanSessionText(workspaceState?.openDirectory) || PROJECT_ROOT,
      resourceRoot: cleanSessionText(workspaceState?.openDirectory) || PROJECT_ROOT,
    });
  } catch (error) {
    return { __capabilityError: error instanceof Error ? error.message : String(error) };
  }
}

async function instantiateBuiltInFeatureForCapability(featureName, workspaceState) {
  const normalized = cleanSessionText(featureName).toLowerCase();
  if (!normalized) return null;
  try {
    const baseConfig = {
      workspaceDir: cleanSessionText(workspaceState?.openDirectory) || PROJECT_ROOT,
      projectRoot: cleanSessionText(workspaceState?.openDirectory) || PROJECT_ROOT,
      workdir: cleanSessionText(workspaceState?.openDirectory) || PROJECT_ROOT,
      resourceRoot: cleanSessionText(workspaceState?.openDirectory) || PROJECT_ROOT,
    };

    if (normalized === 'skill') {
      const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilities=${Date.now()}`);
      const FeatureClass = agentdev?.SkillFeature;
      if (typeof FeatureClass !== 'function') return null;
      return new FeatureClass(baseConfig);
    }

    if (normalized === 'flow') {
      const localFeatures = await import(`${pathToFileURL(path.join(PROJECT_ROOT, 'local-features', 'dist', 'index.js')).href}?builtinCapabilities=${Date.now()}`);
      const FeatureClass = localFeatures?.FlowFeature;
      if (typeof FeatureClass !== 'function') return null;
      const graph = readAssemblyGraphForCapabilities(workspaceState);
      const flows = graphToRuntimeFlowsForCapabilities(graph);
      return new FeatureClass({
        ...baseConfig,
        flows,
        useTestFlow: false,
      });
    }

    const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilities=${Date.now()}`);
    for (const exported of Object.values(agentdev || {})) {
      if (typeof exported !== 'function' || !/Feature$/.test(String(exported.name || ''))) continue;
      if (normalizeBuiltInCapabilityId(exported.name) !== normalized) continue;
      return new exported(baseConfig);
    }

    const localFeatures = await import(`${pathToFileURL(path.join(PROJECT_ROOT, 'local-features', 'dist', 'index.js')).href}?builtinCapabilities=${Date.now()}`);
    for (const [exportName, exported] of Object.entries(localFeatures || {})) {
      if (exportName === 'FlowAwareFeature') continue;
      if (typeof exported !== 'function' || !/Feature$/.test(String(exportName || ''))) continue;
      if (normalizeBuiltInCapabilityId(exportName) !== normalized) continue;
      return new exported(baseConfig);
    }

    return null;
  } catch (error) {
    return { __capabilityError: error instanceof Error ? error.message : String(error) };
  }
}

/* ── capability graph helpers ────────────────────────────────────── */

function hasCapabilitySurface(FeatureClass) {
  const proto = FeatureClass?.prototype;
  if (!proto) return false;
  return ['getFlowVariables', 'getFlowNodeTemplates', 'getFlowModes', 'getFeatureManifest']
    .some((name) => typeof proto[name] === 'function');
}

export function normalizeBuiltInCapabilityId(exportName) {
  return String(exportName || '')
    .replace(/Feature$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function isAutoEntryModeForFlow(mode) {
  return cleanSessionText(mode) === 'auto';
}

async function listBuiltInCapabilitySources(workspaceState) {
  const sources = [];
  const agentdev = await import(`${pathToFileURL(rootRequire.resolve('agentdev')).href}?builtinCapabilityList=${Date.now()}`);
  const localFeatures = await import(`${pathToFileURL(path.join(PROJECT_ROOT, 'local-features', 'dist', 'index.js')).href}?builtinCapabilityList=${Date.now()}`);

  const modules = [
    { exports: agentdev, packageName: 'agentdev', skip: new Set() },
    { exports: localFeatures, packageName: 'local-features', skip: new Set(['FlowAwareFeature']) },
  ];

  for (const mod of modules) {
    for (const [exportName, exported] of Object.entries(mod.exports || {})) {
      if (!/Feature$/.test(exportName)) continue;
      if (mod.skip.has(exportName)) continue;
      if (typeof exported !== 'function') continue;
      if (!hasCapabilitySurface(exported)) continue;

      const featureId = normalizeBuiltInCapabilityId(exportName);
      if (!featureId) continue;

      sources.push({
        featureMeta: {
          id: featureId,
          name: featureId,
          packageName: mod.packageName,
          token: featureId,
        },
        instantiate: () => instantiateBuiltInFeatureForCapability(featureId, workspaceState),
      });
    }
  }

  return sources;
}

function readAssemblyGraphForCapabilities(workspaceState) {
  const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
  const projectId = cleanSessionText(assemblyForm.editing_config_id)
    || cleanSessionText(assemblyForm.assembly_name)
    || 'flow-workspace';
  const filePath = getFlowGraphPath(projectId, 'agent-flow-graph');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function graphToRuntimeFlowsForCapabilities(graph) {
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
      const workflowId = cleanSessionText(head.workflowId) || Object.entries(graph.workflows || {})
        .find(([, meta]) => cleanSessionText(meta?.entry) === head.id)?.[0] || `workflow-${index + 1}`;
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
      if (isAutoEntryModeForFlow(mode)) {
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
    if (isAutoEntryModeForFlow(mode)) {
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

/* ── route setup ──────────────────────────────────────────────────── */

export function setupFlowRoutes(app, express, ctx) {
  const { readWorkspaceState, resolveAssemblyFeatureArchives } = ctx;

  app.get('/protoclaw/flow_graphs', async (req, res, next) => {
    try {
      const agentId = req.query.agentId;
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });
      const dir = getFlowGraphsDir(agentId);
      if (!existsSync(dir)) return res.json({ flows: [] });
      const files = await fs.readdir(dir);
      const flows = [];
      for (const f of files) {
        if (f.endsWith('.json')) {
          try {
            const parsed = await readFlowGraphFile(path.join(dir, f));
            flows.push(parsed.flow);
          } catch {}
        }
      }
      res.json({ flows });
    } catch (error) { next(error); }
  });

  app.get('/protoclaw/flow_graph/:flowId', async (req, res, next) => {
    try {
      const agentId = req.query.agentId;
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });
      const filePath = getFlowGraphPath(agentId, req.params.flowId);
      if (!existsSync(filePath)) return res.status(404).json({ error: 'Flow not found' });
      const { flow } = await readFlowGraphFile(filePath);
      res.json({ flow });
    } catch (error) { next(error); }
  });

  app.post('/protoclaw/flow_graph', express.json(), async (req, res, next) => {
    try {
      const agentId = req.body?.agentId;
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });
      const flow = req.body?.flow;
      if (!flow || !flow.name) return res.status(400).json({ error: 'flow.name is required' });
      const flowId = flow.id || `flow-${Date.now()}`;
      const flowWithId = { ...flow, id: flowId, updatedAt: new Date().toISOString() };
      const dir = getFlowGraphsDir(agentId);
      await ensureDir(dir);
      await fs.writeFile(getFlowGraphPath(agentId, flowId), JSON.stringify(flowWithId, null, 2), 'utf8');
      res.json({ flow: flowWithId, created: true });
    } catch (error) { next(error); }
  });

  app.put('/protoclaw/flow_graph/:flowId', express.json(), async (req, res, next) => {
    try {
      const agentId = req.body?.agentId;
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });
      const flowId = req.params.flowId;
      const filePath = getFlowGraphPath(agentId, flowId);
      let existing = {};
      if (existsSync(filePath)) {
        try {
          existing = (await readFlowGraphFile(filePath)).flow || {};
        } catch (error) {
          console.warn(`[flow_graph] Failed to parse existing graph ${filePath}, overwriting with incoming payload:`, error?.message || error);
        }
      }
      const flow = { ...existing, ...req.body?.flow, id: flowId, updatedAt: new Date().toISOString() };
      const dir = getFlowGraphsDir(agentId);
      await ensureDir(dir);
      await fs.writeFile(filePath, JSON.stringify(flow, null, 2), 'utf8');
      res.json({ flow, saved: true });
    } catch (error) { next(error); }
  });

  app.delete('/protoclaw/flow_graph/:flowId', express.json(), async (req, res, next) => {
    try {
      const agentId = req.query.agentId || req.body?.agentId;
      if (!agentId) return res.status(400).json({ error: 'agentId is required' });
      const filePath = getFlowGraphPath(agentId, req.params.flowId);
      if (!existsSync(filePath)) return res.status(404).json({ error: 'Flow not found' });
      await fs.unlink(filePath);
      res.json({ deleted: true, flowId: req.params.flowId });
    } catch (error) { next(error); }
  });

  // Flow capabilities aggregation
  app.get('/protoclaw/flow_capabilities', async (req, res, next) => {
    try {
      const agentId = cleanSessionText(req.query.agentId) || 'flow-workspace';
      const workspaceState = await readWorkspaceState(agentId).catch(() => ({ forms: {}, openDirectory: '', updatedAt: null }));
      const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
      const selectedFeatures = parseListField(assemblyForm.selected_features);
      const archives = selectedFeatures.length > 0
        ? await resolveAssemblyFeatureArchives(selectedFeatures).catch(() => [])
        : [];

      const features = [];
      const tools = [];
      const variables = [];
      const nodeTemplates = [];
      const modes = [];
      const featureManifests = [];

      const builtInSources = await listBuiltInCapabilitySources(workspaceState).catch(() => []);
      const capabilitySources = [
        ...archives.map((item) => ({
          featureMeta: {
            id: String(item.packageName || item.token || '').replace(/^@agentdev\//, '') || String(item.token || ''),
            name: String(item.packageName || item.token || ''),
            packageName: String(item.packageName || item.token || ''),
            token: String(item.token || ''),
          },
          instantiate: () => instantiateFeatureForCapability(String(item.packageName || item.token || ''), workspaceState),
        })),
        ...builtInSources,
      ];

      const seenFeatureIds = new Set();

      for (const source of capabilitySources) {
        const featureMeta = source.featureMeta;
        if (!featureMeta?.id || seenFeatureIds.has(featureMeta.id)) continue;
        seenFeatureIds.add(featureMeta.id);
        const instance = await source.instantiate();
        const featureSummary = { ...featureMeta, tools: 0, variables: 0, nodeTemplates: 0, modes: 0, error: '' };

        if (!instance || instance.__capabilityError) {
          featureSummary.error = instance?.__capabilityError || 'Feature entry not found';
          features.push(featureSummary);
          continue;
        }

        try {
          const featureTools = typeof instance.getTools === 'function' ? instance.getTools() : [];
          if (Array.isArray(featureTools)) {
            for (const tool of featureTools) {
              const serialized = serializeFlowTool(tool, featureMeta);
              if (serialized) tools.push(serialized);
            }
            featureSummary.tools = featureTools.length;
          }
        } catch (error) {
          featureSummary.error = `getTools: ${error instanceof Error ? error.message : String(error)}`;
        }

        try {
          const featureVariables = typeof instance.getFlowVariables === 'function' ? instance.getFlowVariables() : [];
          if (Array.isArray(featureVariables)) {
            for (const variable of featureVariables) {
              const serialized = serializeFlowVariable(variable, featureMeta);
              if (serialized) variables.push(serialized);
            }
            featureSummary.variables = featureVariables.length;
          }
        } catch (error) {
          featureSummary.error = [featureSummary.error, `getFlowVariables: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
        }

        try {
          const templates = typeof instance.getFlowNodeTemplates === 'function' ? instance.getFlowNodeTemplates() : [];
          if (Array.isArray(templates)) {
            for (const template of templates) {
              const serialized = serializeNodeTemplate(template, featureMeta);
              if (serialized) nodeTemplates.push(serialized);
            }
            featureSummary.nodeTemplates = templates.length;
          }
        } catch (error) {
          featureSummary.error = [featureSummary.error, `getFlowNodeTemplates: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
        }

        try {
          const featureModes = typeof instance.getFlowModes === 'function' ? instance.getFlowModes() : [];
          if (Array.isArray(featureModes)) {
            for (const mode of featureModes) {
              const serialized = serializeFlowMode(mode, featureMeta);
              if (serialized) modes.push(serialized);
            }
            featureSummary.modes = featureModes.length;
          }
        } catch (error) {
          featureSummary.error = [featureSummary.error, `getFlowModes: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
        }

        try {
          const manifest = typeof instance.getFeatureManifest === 'function' ? instance.getFeatureManifest() : null;
          if (manifest && typeof manifest === 'object') {
            const serialized = serializeFeatureManifest(manifest, featureMeta);
            if (serialized) featureManifests.push(serialized);
          }
        } catch (error) {
          featureSummary.error = [featureSummary.error, `getFeatureManifest: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
        }

        features.push(featureSummary);
      }

      let modelPresets = [];
      try {
        const presetData = await readModelPresets();
        modelPresets = Array.isArray(presetData?.presets) ? presetData.presets : [];
      } catch {}

      res.json({
        agentId,
        selectedFeatures,
        features,
        tools,
        variables,
        nodeTemplates,
        modes,
        featureManifests,
        modelPresets,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) { next(error); }
  });
}
