(function () {
  const GRAPH_ID = 'agent-flow-graph';
  const NODE_W = 232;
  const NODE_H = 126;
  const WORKFLOW_PADDING = 38;
  const WORKFLOW_MIN_W = 0;
  const WORKFLOW_MIN_H = 0;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 1.8;

  const state = {
    helpers: null,
    hostAgentId: '',
    projectId: '',
    graph: null,
    capabilities: { features: [], tools: [], variables: [], nodeTemplates: [], modes: [], featureManifests: [], loading: false, error: '' },
    selectedNodeId: '',
    selectedWorkflowId: '',
    selectedEdgeId: '',
    inspectorTab: 'node',
    renderQueued: false,
    visualUpdateQueued: false,
    saveQueued: false,
    saveTimer: null,
    draggingNode: null,
    draggingWorkflow: null,
    resizingWorkflow: null,
    panning: null,
    connecting: null,
    connectionMenu: null,
    edgeMenu: null,
    canvasMenu: null,
    suppressClick: null,
    toolPicker: {
      open: false,
      query: '',
    },
    panels: {
      library: false,
      inspector: false,
      help: false,
    },
    promptDialog: {
      open: false,
      scope: 'node',
      targetId: '',
      ruleId: '',
    },
    slashPicker: {
      open: false,
      query: '',
      startIndex: 0,
      activeIndex: 0,
      category: 'all',
    },
    undoStack: [],
    redoStack: [],
  };

  function h() {
    return state.helpers || {};
  }

  function lang() {
    return h().currentLanguage === 'zh' ? 'zh' : 'en';
  }

  function text(zh, en) {
    return lang() === 'zh' ? zh : en;
  }

  function variableTypeLabel(type) {
    var normalized = String(type || 'string').toLowerCase();
    if (normalized === 'number' || normalized === 'boolean' || normalized === 'string') return normalized;
    return normalized || 'string';
  }

  function pickerPreviewText(item) {
    if (!item) return '';
    if (item.description) return String(item.description);
    if (item.type === 'variable') return '{{' + String(item.key || '') + '}}';
    return String(item.insertText || '').replace(/\s+/g, ' ').trim();
  }

  function pickerMetaParts(item) {
    var parts = [];
    if (item?.key) parts.push(String(item.key));
    if (item?.featureName) parts.push(shortFeatureName(String(item.featureName)));
    return parts;
  }

  function esc(value) {
    const escapeHtml = h().escapeHtml;
    if (typeof escapeHtml === 'function') return escapeHtml(String(value ?? ''));
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ownerAgentId() {
    return state.projectId || 'flow-workspace';
  }


  function hostAgentId() {
    return state.hostAgentId || 'flow-workspace';
  }

  function currentAssemblyForm() {
    const helpers = h();
    const agent = helpers.getCurrentAgentRecord?.();
    return helpers.getWorkspaceFormDraft?.(agent)?.['assembly-form'] || {};
  }

  function refreshProjectIdentity() {
    const form = currentAssemblyForm();
    const editingId = String(form.editing_config_id || '').trim();
    const name = String(form.assembly_name || '').trim();
    state.projectId = editingId || name || 'flow-workspace';
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function selectedNode() {
    return state.graph?.nodes?.find(node => node.id === state.selectedNodeId) || null;
  }

  function isWorkflowHead(node) {
    return !!(node && (node.type === 'workflow-head' || node.kind === 'workflow-head'));
  }

  function workflowHeadFor(wid, graph = state.graph) {
    if (!graph || !wid) return null;
    const meta = graph.workflows?.[wid] || {};
    return graph.nodes?.find(node => node.id === meta.entry && isWorkflowHead(node))
      || graph.nodes?.find(node => isWorkflowHead(node) && node.workflowId === wid)
      || null;
  }

  function viewport() {
    const graph = state.graph;
    if (!graph) return { x: 0, y: 0, zoom: 1 };
    graph.viewport = graph.viewport || { x: 100, y: 120, zoom: 1 };
    graph.viewport.zoom = clamp(Number(graph.viewport.zoom || 1), MIN_ZOOM, MAX_ZOOM);
    graph.viewport.x = Number(graph.viewport.x || 0);
    graph.viewport.y = Number(graph.viewport.y || 0);
    return graph.viewport;
  }

  function workflowId() {
    return `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function normalizeGraph(input) {
    const graph = {
      id: GRAPH_ID,
      name: input?.name || text('Agent 编排图', 'Agent Orchestration Graph'),
      description: input?.description || '',
      graphVersion: 1,
      nodes: Array.isArray(input?.nodes) ? input.nodes : [],
      edges: Array.isArray(input?.edges) ? input.edges : [],
      viewport: input?.viewport || { x: 120, y: 140, zoom: 1 },
      workflows: input?.workflows && typeof input.workflows === 'object' ? input.workflows : {},
      variables: input?.variables || {},
      updatedAt: input?.updatedAt,
    };
    graph.nodes.forEach((node, index) => {
      node.id = String(node.id || `node-${Date.now()}-${index}`);
      node.name = node.name || text(`节点 ${index + 1}`, `Node ${index + 1}`);
      node.position = node.position || { x: 100 + index * 320, y: 160 + (index % 3) * 150 };
      node.workflowId = node.workflowId || '';
      if (isWorkflowHead(node)) {
        node.type = 'workflow-head';
        node.workflowId = node.workflowId || workflowId();
      }
    });
    migrateLegacyWorkflowHeads(graph);
    normalizeWorkflowMembership(graph);
    return graph;
  }

  function defaultGraph() {
    const wid = workflowId();
    const nodeId = `node-${Date.now()}`;
    return normalizeGraph({
      id: GRAPH_ID,
      name: text('Agent 编排图', 'Agent Orchestration Graph'),
      description: text('这张图与当前 Agent 一对一配套。只有从工作流头节点连通出去的节点才会组成可进入工作流。', 'This graph belongs to the current Agent. Only nodes connected to a workflow head become an enterable workflow.'),
      nodes: [{
        id: nodeId,
        workflowId: wid,
        type: 'workflow-head',
        name: text('开始', 'Start'),
        position: { x: 120, y: 160 },
      }],
      edges: [],
      workflows: {
        [wid]: {
          id: wid,
          name: text('默认工作流', 'Default workflow'),
          description: text('Agent 可以按需进入这个工作流。', 'The Agent can enter this workflow when needed.'),
          mode: 'agent-initiated',
          entry: nodeId,
          reminderFrequency: 'every-step',
        },
      },
    });
  }

  function migrateFlowsToGraph(flows) {
    const graph = normalizeGraph({ id: GRAPH_ID, name: text('Agent 编排图', 'Agent Orchestration Graph'), nodes: [], edges: [], workflows: {} });
    let offset = 0;
    (flows || []).forEach((flow, flowIndex) => {
      const wid = flow.id || workflowId();
      const nodeIds = new Set((flow.nodes || []).map(node => node.id));
      (flow.nodes || []).forEach(node => {
        graph.nodes.push({
          ...node,
          workflowId: wid,
          position: {
            x: Number(node.position?.x || 120) + offset,
            y: Number(node.position?.y || 160) + flowIndex * 220,
          },
        });
      });
      const headId = `workflow-head-${Date.now()}-${flowIndex}`;
      const firstNode = flow.nodes?.find(node => node.id === flow.entry) || flow.nodes?.[0] || null;
      graph.nodes.push({
        id: headId,
        workflowId: wid,
        type: 'workflow-head',
        name: flow.name || text(`工作流 ${flowIndex + 1}`, `Workflow ${flowIndex + 1}`),
        position: {
          x: Number(firstNode?.position?.x || 120) + offset - 310,
          y: Number(firstNode?.position?.y || 160) + flowIndex * 220,
        },
      });
      if (firstNode?.id) graph.edges.push({ from: headId, to: firstNode.id });
      (flow.edges || []).forEach(edge => {
        if (nodeIds.has(edge.from) && nodeIds.has(edge.to)) graph.edges.push(edge);
      });
      graph.workflows[wid] = {
        id: wid,
        name: flow.name || text(`工作流 ${flowIndex + 1}`, `Workflow ${flowIndex + 1}`),
        description: flow.description || '',
        mode: flow.mode || 'agent-initiated',
        entry: headId,
        reminderFrequency: flow.reminderFrequency || 'every-step',
        variables: flow.variables || {},
      };
      offset += 380;
    });
    return normalizeGraph(graph.nodes.length ? graph : defaultGraph());
  }

  function createNode(position, wid) {
    const graph = state.graph;
    const index = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
    return {
      id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      workflowId: wid || '',
      name: text(`节点 ${index + 1}`, `Node ${index + 1}`),
      prompts: [],
      position: position || { x: 140 + index * 300, y: 220 + (index % 3) * 120 },
    };
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(await res.text().catch(() => res.statusText));
    return res.json();
  }

  async function loadGraph() {
    const data = await fetchJson(`/protoclaw/flow_graphs?agentId=${encodeURIComponent(ownerAgentId())}`);
    const flows = Array.isArray(data.flows) ? data.flows : [];
    const existing = flows.find(item => item?.id === GRAPH_ID);
    state.graph = existing ? normalizeGraph(existing) : migrateFlowsToGraph(flows);
    if (!selectedNode()) {
      state.selectedNodeId = state.graph.nodes[0]?.id || '';
    }
    state.selectedWorkflowId = componentForNode(state.selectedNodeId)?.id || computeComponents()[0]?.id || '';
    ensureViewportContainsNodes();
  }

  function ensureViewportContainsNodes() {
    var graph = state.graph;
    if (!graph || !graph.nodes?.length) return;
    var v = graph.viewport;
    if (!v) return;
    var wrap = document.getElementById('flow-editor-canvas-wrap');
    var rect = wrap ? wrap.getBoundingClientRect() : null;
    var ww = rect ? rect.width : 800;
    var wh = rect ? rect.height : 600;
    var anyVisible = graph.nodes.some(function (node) {
      var nx = Number(node.position?.x || 0);
      var ny = Number(node.position?.y || 0);
      var sx = nx * v.zoom + v.x;
      var sy = ny * v.zoom + v.y;
      return sx + NODE_W * v.zoom > 0 && sx < ww && sy + NODE_H * v.zoom > 0 && sy < wh;
    });
    if (!anyVisible) {
      scheduleFitViewOnRender();
    }
  }

  var pendingFitView = false;
  function scheduleFitViewOnRender() {
    pendingFitView = true;
  }

  async function loadCapabilities() {
    state.capabilities = { ...state.capabilities, loading: true, error: '' };
    try {
      const data = await fetchJson(`/protoclaw/flow_capabilities?agentId=${encodeURIComponent(hostAgentId())}`);
      state.capabilities = {
        features: Array.isArray(data.features) ? data.features : [],
        tools: Array.isArray(data.tools) ? data.tools : [],
        variables: Array.isArray(data.variables) ? data.variables : [],
        nodeTemplates: Array.isArray(data.nodeTemplates) ? data.nodeTemplates : [],
        modes: Array.isArray(data.modes) ? data.modes : [],
        featureManifests: Array.isArray(data.featureManifests) ? data.featureManifests : [],
        loading: false,
        error: '',
        updatedAt: data.updatedAt || '',
      };
    } catch (error) {
      console.error('Failed to load flow capabilities:', error);
      state.capabilities = { features: [], tools: [], variables: [], nodeTemplates: [], modes: [], featureManifests: [], loading: false, error: error.message || String(error) };
    }
  }

  async function saveGraph() {
    if (!state.graph) return null;
    normalizeWorkflowMembership(state.graph);
    const payload = { agentId: ownerAgentId(), flow: state.graph };
    const data = await fetchJson(`/protoclaw/flow_graph/${encodeURIComponent(GRAPH_ID)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.graph = normalizeGraph(data.flow);
    return state.graph;
  }

  function queueSave() {
    if (!state.graph) return;
    window.clearTimeout(state.saveTimer);
    state.saveQueued = true;
    state.saveTimer = window.setTimeout(async () => {
      if (state.draggingNode || state.draggingWorkflow || state.resizingWorkflow || state.panning || state.connecting) {
        queueSave();
        return;
      }
      try {
        await saveGraph();
      } catch (error) {
        console.error('Failed to autosave graph:', error);
      } finally {
        state.saveQueued = false;
      }
    }, 520);
  }

  function legacyConnectedComponents(graph = state.graph) {
    if (!graph) return [];
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
    edges.forEach(edge => {
      if (!byId.has(edge.from) || !byId.has(edge.to)) return;
      adjacency.get(edge.from).add(edge.to);
      adjacency.get(edge.to).add(edge.from);
    });
    const seen = new Set();
    const components = [];
    nodes.forEach(node => {
      if (seen.has(node.id)) return;
      const queue = [node.id];
      const ids = [];
      seen.add(node.id);
      while (queue.length) {
        const id = queue.shift();
        ids.push(id);
        adjacency.get(id)?.forEach(next => {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        });
      }
      const componentNodes = ids.map(id => byId.get(id)).filter(Boolean);
      const idCounts = new Map();
      componentNodes.forEach(item => idCounts.set(item.workflowId, (idCounts.get(item.workflowId) || 0) + 1));
      const wid = [...idCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || workflowId();
      const meta = graph.workflows?.[wid] || {};
      const entry = componentNodes.some(item => item.id === meta.entry) ? meta.entry : componentNodes[0]?.id || '';
      components.push({
        id: wid,
        nodes: componentNodes,
        edges: edges.filter(edge => ids.includes(edge.from) && ids.includes(edge.to)),
        meta: {
          id: wid,
          name: meta.name || text(`工作流 ${components.length + 1}`, `Workflow ${components.length + 1}`),
          description: meta.description || '',
          mode: meta.mode || 'agent-initiated',
          entry,
          reminderFrequency: meta.reminderFrequency || 'every-step',
          variables: meta.variables || {},
        },
      });
    });
    return components;
  }

  function migrateLegacyWorkflowHeads(graph = state.graph) {
    if (!graph || graph._explicitWorkflowHeadsMigrated) return;
    graph.workflows = graph.workflows || {};
    const hasHeads = graph.nodes?.some(isWorkflowHead);
    const workflowEntries = Object.values(graph.workflows || {});
    if (hasHeads || workflowEntries.length === 0) {
      graph._explicitWorkflowHeadsMigrated = true;
      return;
    }

    const components = legacyConnectedComponents(graph);
    components.forEach((component, index) => {
      const wid = component.id || workflowId();
      const meta = graph.workflows[wid] || component.meta || {};
      const entryNode = component.nodes.find(node => node.id === meta.entry) || component.nodes[0];
      if (!entryNode) return;
      const minX = Math.min(...component.nodes.map(node => Number(node.position?.x || 0)));
      const minY = Math.min(...component.nodes.map(node => Number(node.position?.y || 0)));
      const headId = `workflow-head-${Date.now()}-${index}`;
      graph.nodes.push({
        id: headId,
        workflowId: wid,
        type: 'workflow-head',
        name: meta.name || text(`工作流 ${index + 1}`, `Workflow ${index + 1}`),
        position: { x: minX - 310, y: minY },
      });
      graph.edges.push({ from: headId, to: entryNode.id });
      graph.workflows[wid] = {
        ...meta,
        id: wid,
        entry: headId,
      };
    });
    graph._explicitWorkflowHeadsMigrated = true;
  }

  function reachableFromHead(head, graph = state.graph) {
    if (!graph || !head) return { nodes: [], edges: [] };
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
    edges.forEach(edge => {
      if (!byId.has(edge.from) || !byId.has(edge.to)) return;
      adjacency.get(edge.from).add(edge.to);
      adjacency.get(edge.to).add(edge.from);
    });
    const seen = new Set([head.id]);
    const queue = [head.id];
    while (queue.length) {
      const id = queue.shift();
      adjacency.get(id)?.forEach(next => {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      });
    }
    const memberNodes = [...seen].map(id => byId.get(id)).filter(Boolean);
    return {
      nodes: memberNodes,
      edges: edges.filter(edge => seen.has(edge.from) && seen.has(edge.to)),
    };
  }

  function computeWorkflowFrame(component) {
    const metaFrame = component?.meta?.frame || {};
    const nodes = component?.nodes || [];
    if (!nodes.length) {
      return {
        x: Number(metaFrame.x || 80),
        y: Number(metaFrame.y || 120),
        width: Math.max(WORKFLOW_MIN_W, Number(metaFrame.width || WORKFLOW_MIN_W)),
        height: Math.max(WORKFLOW_MIN_H, Number(metaFrame.height || WORKFLOW_MIN_H)),
      };
    }
    const nodeBounds = nodes.reduce((acc, node) => {
      const x = Number(node.position?.x || 0);
      const y = Number(node.position?.y || 0);
      acc.minX = Math.min(acc.minX, x);
      acc.minY = Math.min(acc.minY, y);
      acc.maxX = Math.max(acc.maxX, x + NODE_W);
      acc.maxY = Math.max(acc.maxY, y + NODE_H);
      return acc;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const required = {
      x: nodeBounds.minX - WORKFLOW_PADDING,
      y: nodeBounds.minY - WORKFLOW_PADDING,
      width: nodeBounds.maxX - nodeBounds.minX + WORKFLOW_PADDING * 2,
      height: nodeBounds.maxY - nodeBounds.minY + WORKFLOW_PADDING * 2,
    };
    const frame = {
      x: Math.min(Number(metaFrame.x ?? required.x), required.x),
      y: Math.min(Number(metaFrame.y ?? required.y), required.y),
      width: Math.max(Number(metaFrame.width || 0), required.width, WORKFLOW_MIN_W),
      height: Math.max(Number(metaFrame.height || 0), required.height, WORKFLOW_MIN_H),
    };
    frame.width = Math.max(frame.width, nodeBounds.maxX + WORKFLOW_PADDING - frame.x);
    frame.height = Math.max(frame.height, nodeBounds.maxY + WORKFLOW_PADDING - frame.y);
    return frame;
  }

  function setWorkflowFrame(wid, frame) {
    if (!state.graph?.workflows?.[wid]) return null;
    const meta = state.graph.workflows[wid];
    meta.frame = {
      x: Number(frame.x || 0),
      y: Number(frame.y || 0),
      width: Math.max(WORKFLOW_MIN_W, Number(frame.width || WORKFLOW_MIN_W)),
      height: Math.max(WORKFLOW_MIN_H, Number(frame.height || WORKFLOW_MIN_H)),
    };
    const component = computeComponents(state.graph).find(item => item.id === wid);
    meta.frame = component ? computeWorkflowFrame(component) : meta.frame;
    return meta.frame;
  }

  function setWorkflowFrameFast(wid, frame) {
    if (!state.graph?.workflows?.[wid]) return null;
    const next = {
      x: Number(frame.x || 0),
      y: Number(frame.y || 0),
      width: Math.max(WORKFLOW_MIN_W, Number(frame.width || 0)),
      height: Math.max(WORKFLOW_MIN_H, Number(frame.height || 0)),
    };
    state.graph.workflows[wid].frame = next;
    return next;
  }

  function edgeId(edge) {
    return `${edge.from}__${edge.to}`;
  }

  function canConnect(fromId, toId) {
    const graph = state.graph;
    if (!graph || !fromId || !toId || fromId === toId) return false;
    const from = graph.nodes.find(node => node.id === fromId);
    const to = graph.nodes.find(node => node.id === toId);
    if (!from || !to || isWorkflowHead(to)) return false;
    const fromComponent = componentForNode(fromId);
    const toComponent = componentForNode(toId);
    if (toComponent && fromComponent?.id !== toComponent.id) return false;
    return !graph.edges.some(edge => edge.from === fromId && edge.to === toId);
  }

  var MAX_UNDO = 100;

  function cloneGraph(graph) {
    if (!graph) return null;
    return JSON.parse(JSON.stringify(graph));
  }

  function pushUndo(snapshot) {
    state.undoStack.push(snapshot);
    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
    state.redoStack = [];
  }

  function snapshotAndMarkChanged(opts) {
    pushUndo(cloneGraph(state.graph));
    markGraphChanged(opts);
  }

  function undo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(cloneGraph(state.graph));
    state.graph = state.undoStack.pop();
    state.selectedNodeId = state.graph.nodes[0]?.id || '';
    state.selectedWorkflowId = componentForNode(state.selectedNodeId)?.id || computeComponents()[0]?.id || '';
    state.selectedEdgeId = '';
    queueSave();
    render();
  }

  function redo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(cloneGraph(state.graph));
    state.graph = state.redoStack.pop();
    state.selectedNodeId = state.graph.nodes[0]?.id || '';
    state.selectedWorkflowId = componentForNode(state.selectedNodeId)?.id || computeComponents()[0]?.id || '';
    state.selectedEdgeId = '';
    queueSave();
    render();
  }

  function markGraphChanged({ rerender = false } = {}) {
    if (state.graph) normalizeWorkflowMembership(state.graph);
    queueSave();
    if (rerender) scheduleRender();
  }

  function computeComponents(graph = state.graph) {
    if (!graph) return [];
    graph.workflows = graph.workflows || {};
    const metas = Object.values(graph.workflows || {});
    return metas.map((meta, index) => {
      const wid = meta.id || workflowId();
      const head = workflowHeadFor(wid, graph);
      if (!head) return null;
      const reachable = reachableFromHead(head, graph);
      const nextMeta = {
        ...meta,
        id: wid,
        name: meta.name || head.name || text(`工作流 ${index + 1}`, `Workflow ${index + 1}`),
        mode: meta.mode || 'agent-initiated',
        entry: head.id,
        reminderFrequency: meta.reminderFrequency || 'every-step',
        variables: meta.variables || {},
      };
      const component = {
        id: wid,
        head,
        nodes: reachable.nodes,
        edges: reachable.edges,
        meta: nextMeta,
      };
      component.frame = computeWorkflowFrame(component);
      return component;
    }).filter(Boolean);
  }

  function normalizeWorkflowMembership(graph = state.graph) {
    if (!graph) return;
    graph.workflows = graph.workflows || {};
    let autoSeen = false;
    const nextMeta = {};
    const components = computeComponents(graph);
    components.forEach((component, index) => {
      let wid = component.id || workflowId();
      component.nodes.forEach(node => {
        if (isWorkflowHead(node)) node.workflowId = wid;
      });
      const meta = {
        ...component.meta,
        id: wid,
        name: component.meta.name || text(`工作流 ${index + 1}`, `Workflow ${index + 1}`),
        entry: component.head?.id || component.meta.entry || '',
        frame: computeWorkflowFrame(component),
      };
      if (meta.mode === 'auto' || meta.mode === 'auto-reenterable') {
        if (autoSeen) meta.mode = 'agent-initiated';
        autoSeen = true;
      }
      nextMeta[wid] = meta;
    });
    graph.workflows = nextMeta;
  }

  function componentForNode(nodeId = state.selectedNodeId) {
    return computeComponents().find(component => component.nodes.some(node => node.id === nodeId)) || null;
  }

  function selectedWorkflow() {
    const byNode = componentForNode();
    if (byNode) return byNode;
    return computeComponents().find(component => component.id === state.selectedWorkflowId) || null;
  }

  function customVariablesFor(component) {
    const vars = component?.meta?.variables;
    if (!vars || typeof vars !== 'object') return [];
    return Object.entries(vars).map(([key, value]) => ({
      id: `workflow:${component.id}:${key}`,
      key,
      type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
      title: key,
      description: text('编排图自定义变量', 'Graph custom variable'),
      source: 'workflow',
      workflowId: component.id,
      value,
    }));
  }

  function variableOptions(component = selectedWorkflow()) {
    return [
      ...(state.capabilities.variables || []),
      ...customVariablesFor(component),
    ];
  }

  function toolByName(name) {
    return (state.capabilities.tools || []).find(tool => tool.name === name) || null;
  }

  function variableByKey(key, component = selectedWorkflow()) {
    return variableOptions(component).find(variable => variable.key === key) || null;
  }

  function renderBlock(agent, block, helpers) {
    state.helpers = helpers || {};
    state.hostAgentId = agent?.id || 'flow-workspace';
    refreshProjectIdentity();
    setTimeout(async () => {
      try {
        await Promise.all([loadGraph(), loadCapabilities()]);
      } catch (error) {
        console.error('Failed to load orchestration graph:', error);
        state.graph = defaultGraph();
      }
      render();
    }, 0);
    return '<div id="flow-editor-root"><div class="flow-editor-loading">' + esc(text('加载编排图编辑器中...', 'Loading graph editor...')) + '</div></div>';
  }

  function render() {
    const root = document.getElementById('flow-editor-root');
    if (!root) return;
    const panelScroll = {};
    root.querySelectorAll('.flow-editor-floating-panel[data-flow-panel]').forEach(panel => {
      panelScroll[panel.getAttribute('data-flow-panel')] = panel.scrollTop;
    });
    const previousProjectId = state.projectId;
    refreshProjectIdentity();
    if (previousProjectId && previousProjectId !== state.projectId) {
      loadGraph().then(render).catch(error => console.error('Failed to switch graph project:', error));
      return;
    }
    normalizeWorkflowMembership(state.graph);
    var dialogWasOpen = state.promptDialog.open;
    var dialogEl = dialogWasOpen ? document.querySelector('.feature-detail-overlay') : null;
    root.innerHTML = [
      '<div class="flow-editor-shell">',
      renderCanvas(),
      renderFloatingPanel('library', renderWorkflowPanel(), 'left'),
      renderToolPickerPanel(),
      renderFloatingPanel('inspector', renderInspectorPanel(), 'right'),
      renderFloatingPanel('help', renderHelpPanel(), 'center'),
      dialogWasOpen && dialogEl ? '' : renderNodePromptDialog(),
      '</div>',
    ].join('');
    if (dialogWasOpen && dialogEl) {
      var shell = root.querySelector('.flow-editor-shell');
      if (shell) shell.appendChild(dialogEl);
    }
    root.querySelectorAll('.flow-editor-floating-panel[data-flow-panel]').forEach(panel => {
      const key = panel.getAttribute('data-flow-panel');
      if (Object.prototype.hasOwnProperty.call(panelScroll, key)) panel.scrollTop = panelScroll[key];
    });
    if (pendingFitView) {
      pendingFitView = false;
      fitView();
    }
  }

  function renderFloatingPanel(name, body, placement) {
    if (!state.panels[name]) return '';
    const titleMap = {
      library: text('工作流', 'Workflows'),
      inspector: text('属性面板', 'Inspector'),
      help: text('操作说明', 'Help'),
    };
    return [
      '<aside class="flow-editor-floating-panel ' + esc(placement) + '" data-flow-panel="' + esc(name) + '">',
      '<div class="flow-editor-floating-head">',
      '<div class="flow-editor-panel-title">' + esc(titleMap[name] || name) + '</div>',
      '<button class="flow-editor-icon-button" type="button" onclick="window.ClawFlowEditor.togglePanel(&quot;' + esc(name) + '&quot;, false)">×</button>',
      '</div>',
      body,
      '</aside>',
    ].join('');
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(() => {
      state.renderQueued = false;
      render();
    });
  }

  function renderCanvas() {
    const graph = state.graph;
    if (!graph) {
      return '<main class="flow-editor-canvas-wrap"><div class="flow-editor-empty-state">' + esc(text('编排图加载中。', 'Loading graph.')) + '</div></main>';
    }
    const v = viewport();
    const transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    return [
      '<main class="flow-editor-canvas-wrap" id="flow-editor-canvas-wrap"',
      ' onpointerdown="window.ClawFlowEditor.startCanvasPan(event)"',
      ' onwheel="window.ClawFlowEditor.handleWheel(event)"',
      ' oncontextmenu="window.ClawFlowEditor.openCanvasMenu(event)"',
      ' onclick="window.ClawFlowEditor.clearTransient(event)">',
      renderToolbar(),
      renderZoomControls(),
      renderTransientMenus(),
      '<div class="flow-editor-canvas-world" style="transform:' + esc(transform) + '">',
      renderWorkflowFrames(),
      renderEdges(graph.nodes, graph.edges),
      renderConnectingLine(),
      renderEdgeLabels(graph.nodes, graph.edges),
      graph.nodes.map(node => renderNodeCard(node)).join(''),
      '</div>',
      '</main>',
    ].join('');
  }

  function renderToolbar() {
    const graph = state.graph;
    return [
      '<div class="flow-editor-toolbar">',
      '<div class="flow-editor-toolbar-left">',
      '<button class="flow-editor-toolbar-button" type="button" onclick="window.ClawFlowEditor.togglePanel(&quot;library&quot;)">' + esc(text('工作流', 'Workflows')) + '</button>',
      '<button class="flow-editor-toolbar-button" type="button" onclick="window.ClawFlowEditor.togglePanel(&quot;inspector&quot;)">' + esc(text('属性', 'Inspector')) + '</button>',
      '<button class="flow-editor-toolbar-button" type="button" onclick="window.ClawFlowEditor.togglePanel(&quot;help&quot;)">?</button>',
      '</div>',
      '<div class="flow-editor-toolbar-title">' + esc((state.projectId && state.projectId !== 'flow-workspace' ? state.projectId + ' · ' : '') + (graph?.name || text('Agent 编排图', 'Agent Graph'))) + '</div>',
      '<div class="flow-editor-toolbar-right">',
      '<button class="flow-editor-toolbar-button primary" type="button" onclick="window.ClawFlowEditor.addNode()">' + esc(text('新节点', 'New Node')) + '</button>',
      '<button class="flow-editor-toolbar-button" type="button" onclick="window.ClawFlowEditor.newWorkflow()">' + esc(text('新工作流', 'New Workflow')) + '</button>',
      '<button class="flow-editor-toolbar-button" type="button" onclick="window.ClawFlowEditor.autoLayout()">' + esc(text('排布', 'Layout')) + '</button>',
      '<button class="flow-editor-toolbar-button" type="button" onclick="window.ClawFlowEditor.reloadCapabilities()">' + esc(text('刷新能力', 'Refresh Capabilities')) + '</button>',
      '</div>',
      '</div>',
    ].join('');
  }

  function renderZoomControls() {
    const zoom = Math.round((viewport().zoom || 1) * 100);
    return [
      '<div class="flow-editor-zoom-controls">',
      '<button class="flow-editor-zoom-button" type="button" onclick="window.ClawFlowEditor.zoomBy(0.87)">-</button>',
      '<button class="flow-editor-zoom-value" data-flow-zoom-label="1" type="button" onclick="window.ClawFlowEditor.fitView()">' + esc(zoom + '%') + '</button>',
      '<button class="flow-editor-zoom-button" type="button" onclick="window.ClawFlowEditor.zoomBy(1.15)">+</button>',
      '</div>',
    ].join('');
  }

  function renderConnectionMenu() {
    return renderMenu(state.connectionMenu, [
      ['window.ClawFlowEditor.createNodeFromConnection()', text('创建并连接节点', 'Create and connect node')],
      ['window.ClawFlowEditor.cancelTransientMenus()', text('取消', 'Cancel')],
    ]);
  }

  function renderEdgeMenu() {
    return renderMenu(state.edgeMenu, [
      ['window.ClawFlowEditor.deleteSelectedEdgeFromMenu()', text('删除连线', 'Delete edge')],
    ]);
  }

  function renderCanvasMenu() {
    return renderMenu(state.canvasMenu, [
      ['window.ClawFlowEditor.createNodeFromCanvasMenu()', text('添加节点', 'Add node')],
      ['window.ClawFlowEditor.createWorkflowFromCanvasMenu()', text('添加工作流', 'Add workflow')],
    ]);
  }

  function renderTransientMenus() {
    return [renderConnectionMenu(), renderEdgeMenu(), renderCanvasMenu()].join('');
  }

  function renderMenu(menu, items) {
    if (!menu) return '';
    return [
      '<div class="flow-editor-connection-menu" style="left:' + Number(menu.screenX || 0) + 'px;top:' + Number(menu.screenY || 0) + 'px">',
      items.map(item => '<button type="button" onclick="' + item[0] + '">' + esc(item[1]) + '</button>').join(''),
      '</div>',
    ].join('');
  }

  function renderWorkflowPanel() {
    const components = computeComponents();
    const items = components.length
      ? components.map(component => {
        const runtimeCount = Math.max(0, component.nodes.filter(node => !isWorkflowHead(node)).length);
        const fallbackDesc = text(`包含 ${runtimeCount} 个节点`, `${runtimeCount} nodes`);
        const desc = String(component.meta.description || '').trim() || fallbackDesc;
        var modeClass = component.meta.mode === 'auto' ? ' auto' : (component.meta.mode === 'auto-reenterable' ? ' reenterable' : '');
        var modeLabel = component.meta.mode === 'auto' ? text('自动', 'Auto') : (component.meta.mode === 'auto-reenterable' ? text('可重入', 'Re') : text('按需', 'On'));
        var modeTitle = component.meta.mode === 'auto' ? text('自动进入，退出后不可重入', 'Auto-enter, no re-entry') : (component.meta.mode === 'auto-reenterable' ? text('自动进入，可重入', 'Auto-enter, re-entry allowed') : text('Agent 按需进入', 'Agent enters on demand'));
        return [
        '<li class="flow-editor-flow-item' + (component.id === selectedWorkflow()?.id ? ' active' : '') + modeClass + '">',
        '<button class="flow-editor-flow-open" type="button" onclick="window.ClawFlowEditor.selectWorkflow(&quot;' + esc(component.id) + '&quot;)">',
        '<span class="flow-editor-flow-name">' + esc(component.meta.name || component.id) + '</span>',
        '<span class="flow-editor-flow-desc">' + esc(desc) + '</span>',
        '</button>',
        '<button class="flow-editor-auto-switch' + (component.meta.mode !== 'agent-initiated' ? ' enabled' : '') + (modeClass) + '" type="button" title="' + esc(modeTitle) + '" onclick="window.ClawFlowEditor.toggleAutoWorkflow(&quot;' + esc(component.id) + '&quot;)">' + esc(modeLabel) + '</button>',
        '</li>',
      ].join('');
      }).join('')
      : '<li class="flow-editor-empty">' + esc(text('还没有工作流。点击下方按钮创建一个头节点。', 'No workflows yet. Create a head node below.')) + '</li>';
    return [
      '<div class="flow-editor-panel-section">',
      '<ul class="flow-editor-flow-list">' + items + '</ul>',
      '<div class="flow-editor-actions compact">',
      '<button class="workspace-action" type="button" onclick="window.ClawFlowEditor.newWorkflow()">' + esc(text('新建工作流', 'New Workflow')) + '</button>',
      selectedWorkflow() ? '<button class="workspace-action secondary" type="button" onclick="window.ClawFlowEditor.deleteWorkflow()">' + esc(text('删除当前工作流', 'Delete Current')) + '</button>' : '',
      '</div>',
      '</div>',
    ].join('');
  }

  function renderInspectorPanel() {
    if (!state.graph) return '<div class="flow-editor-empty">' + esc(text('编排图加载中。', 'Graph loading.')) + '</div>';
    const node = selectedNode();
    const workflow = selectedWorkflow();
    const active = isWorkflowHead(node) ? 'workflow' : (state.inspectorTab === 'workflow' ? 'workflow' : 'node');
    return [
      '<div class="flow-editor-tabs">',
      '<button class="flow-editor-tab' + (active === 'node' ? ' active' : '') + '" type="button" ' + (isWorkflowHead(node) ? 'disabled ' : '') + 'onclick="window.ClawFlowEditor.setInspectorTab(&quot;node&quot;)">Node</button>',
      '<button class="flow-editor-tab' + (active === 'workflow' ? ' active' : '') + '" type="button" onclick="window.ClawFlowEditor.setInspectorTab(&quot;workflow&quot;)">Workflow</button>',
      '</div>',
      active === 'workflow' ? renderWorkflowInspector(workflow) : (node ? renderNodeInspector(node) : '<div class="flow-editor-empty">' + esc(text('点击一个节点编辑属性。', 'Click a node to edit it.')) + '</div>'),
    ].join('');
  }

  function renderWorkflowInspector(component) {
    if (!component) return '<div class="flow-editor-empty">' + esc(text('请选择一个节点或工作流组件。', 'Select a node or workflow component.')) + '</div>';
    const meta = component.meta;
    return [
      '<div class="flow-editor-panel-section">',
      '<div class="flow-editor-subtitle">' + esc(text('工作流组件', 'Workflow Component')) + '</div>',
      field(`workflow:${component.id}:name`, text('名称', 'Name'), meta.name || ''),
      textarea(`workflow:${component.id}:description`, text('描述', 'Description'), meta.description || ''),
      renderWorkflowModeToggle(component),
      '</div>',
      '<div class="flow-editor-panel-section">',
      '<div class="flow-editor-subtitle">' + esc(text('工作流默认提示词', 'Workflow Default Prompts')) + '</div>',
      renderWorkflowPromptRules(component),
      '</div>',
      '<div class="flow-editor-panel-section">',
      '<div class="flow-editor-subtitle">' + esc(text('图内自定义变量', 'Graph Variables')) + '</div>',
      renderWorkflowVariables(component),
      '</div>',
    ].join('');
  }

  function renderWorkflowPromptRules(component) {
    var meta = component.meta;
    var rules = ensurePromptRules(meta);
    return renderPromptSlots('workflow', component.id, rules);
  }

  function renderWorkflowVariables(component) {
    const variables = customVariablesFor(component);
    return [
      variables.length ? variables.map(variable => [
        '<div class="flow-editor-action-row">',
        '<div class="flow-editor-variable-key">' + esc(variable.key) + '</div>',
        field(`workflowVar:${component.id}:${variable.key}`, text('值', 'Value'), variable.value ?? ''),
        '<button class="flow-editor-mini-button danger" type="button" onclick="window.ClawFlowEditor.deleteWorkflowVariable(&quot;' + esc(component.id) + '&quot;, &quot;' + esc(variable.key) + '&quot;)">' + esc(text('删除', 'Delete')) + '</button>',
        '</div>',
      ].join('')).join('') : '<div class="flow-editor-empty">' + esc(text('这些变量保存在当前工作流组件里，可被 prompt 和 exitWhen 引用。', 'These variables are stored in this workflow component and can be referenced by prompts and exitWhen.')) + '</div>',
      '<div class="flow-editor-actions compact">',
      '<input class="flow-editor-input" data-new-var-for="' + esc(component.id) + '" placeholder="' + esc(text('变量名', 'Variable key')) + '">',
      '<button class="workspace-action secondary" type="button" onclick="window.ClawFlowEditor.addWorkflowVariable(&quot;' + esc(component.id) + '&quot;)">' + esc(text('添加变量', 'Add variable')) + '</button>',
      '</div>',
    ].join('');
  }

  function renderNodeInspector(node) {
    const exitWhen = node.exitWhen || {};
    const component = componentForNode(node.id);
    return [
      '<div class="flow-editor-panel-section">',
      '<div class="flow-editor-subtitle">' + esc(text('节点', 'Node')) + '</div>',
      field(`node:${node.id}:name`, text('节点名称', 'Node name'), node.name || ''),
      renderNodePromptField(node),
      '</div>',
      '<div class="flow-editor-panel-section">',
      '<div class="flow-editor-subtitle">' + esc(text('Feature 模式', 'Feature Modes')) + '</div>',
      renderFeatureModeSelector(node),
      '</div>',
      '<div class="flow-editor-panel-section">',
      '<div class="flow-editor-subtitle">' + esc(text('工具权限', 'Tool Permissions')) + '</div>',
      renderToolSelector(node),
      '<div class="flow-editor-divider"></div>',
      '<div class="flow-editor-subtitle">exitWhen</div>',
      select(`node:${node.id}:exitVariable`, text('变量', 'Variable'), exitWhen.variable || '', [['', text('不设置', 'None')], ...variableOptions(component).map(variable => [variable.key, `${variable.title || variable.key} (${variableTypeLabel(variable.type)}) · ${variable.source === 'workflow' ? text('图变量', 'Graph') : variable.featureName}`])]),
      select(`node:${node.id}:exitOperator`, text('操作符', 'Operator'), exitWhen.operator || 'eq', ['eq', 'neq', 'gt', 'lt', 'contains', 'changed'].map(op => [op, op])),
      field(`node:${node.id}:exitValue`, text('比较值', 'Value'), exitWhen.value ?? ''),
      '</div>',
      '<div class="flow-editor-panel-section">',
      '<div class="flow-editor-subtitle">' + esc(text('onEnter 函数调用', 'onEnter Function Calls')) + '</div>',
      renderOnEnterActions(node),
      '</div>',
    ].join('');
  }

  function renderPromptSlots(scope, targetId, rules) {
    var timings = promptTimingOptions();
    return timings.map(function (opt) {
      var timing = opt[0];
      var timingLabel = opt[1];
      var rule = rules.find(function (r) { return r.timing === timing; }) || null;
      var filled = rule && String(rule.template || '').trim();
      var ghost = !filled;
      var ruleId = rule ? rule.id : '';
      var preview = filled ? rule.template : '';
      var intervalField = '';
      if (timing === 'every-n-steps' || timing === 'every-n-calls') {
        var iv = rule ? (rule.interval || 3) : 3;
        intervalField = '<input class="flow-editor-input flow-editor-prompt-interval' + (ghost ? ' ghost' : '') + '" type="number" min="1" value="' + esc(String(iv)) + '"' + (ghost ? ' disabled' : '') + ' oninput="window.ClawFlowEditor.updateField(&quot;promptRule:' + scope + ':' + esc(targetId) + ':' + esc(ruleId) + ':interval&quot;, this.value)">';
      }
      return [
        '<div class="flow-editor-prompt-slot' + (ghost ? ' ghost' : '') + '">',
        '<span class="flow-editor-prompt-slot-label">' + esc(timingLabel) + '</span>',
        intervalField,
        '<button class="flow-editor-prompt-slot-btn" type="button"',
        ghost
          ? ' onclick="window.ClawFlowEditor.activatePromptSlot(&quot;' + scope + '&quot;, &quot;' + esc(targetId) + '&quot;, &quot;' + esc(timing) + '&quot;)"'
          : ' onclick="window.ClawFlowEditor.openPromptEditor(&quot;' + scope + '&quot;, &quot;' + esc(targetId) + '&quot;, &quot;' + esc(ruleId) + '&quot;)"',
        '>',
        '<span class="flow-editor-prompt-slot-preview">' + esc(preview || text('默认行为', 'Default')) + '</span>',
        filled ? '<span class="flow-editor-prompt-slot-action">' + esc(text('编辑', 'Edit')) + '</span>' : '',
        '</button>',
        '</div>',
      ].join('');
    }).join('');
  }

  function renderNodePromptField(node) {
    var rules = ensurePromptRules(node);
    return [
      '<div class="flow-editor-field">',
      '<span class="flow-editor-label">Prompts</span>',
      renderPromptSlots('node', node.id, rules),
      '</div>',
    ].join('');
  }

  function renderNodePromptDialog() {
    if (!state.promptDialog.open) return '';
    var scope = state.promptDialog.scope;
    var targetId = state.promptDialog.targetId;
    var ruleId = state.promptDialog.ruleId;
    var target = resolvePromptTarget(scope, targetId);
    if (!target) return '';
    var rules = ensurePromptRules(target);
    var rule = rules.find(function (r) { return r.id === ruleId; });
    if (!rule) return '';
    var varCount = (state.capabilities.variables || []).length;
    var fragmentCount = (state.capabilities.modes || []).reduce(function (s, m) { return s + (Array.isArray(m.suggestedPromptFragments) ? m.suggestedPromptFragments.length : 0); }, 0);
    var templateCount = Array.isArray(state.capabilities.nodeTemplates) ? state.capabilities.nodeTemplates.length : 0;
    var snippetCount = fragmentCount + templateCount;
    var titleText = scope === 'workflow' ? text('编辑工作流提示词规则', 'Edit Workflow Prompt Rule') : text('编辑节点提示词规则', 'Edit Node Prompt Rule');
    var ruleLabel = promptRuleLabel(rule);
    return [
      '<div class="feature-detail-overlay" onkeydown="event.stopPropagation()">',
      '<div class="feature-detail-window" style="width:min(100%,780px);max-height:min(100%,780px);">',
      '<div class="feature-detail-head">',
      '<div>',
      '<div class="feature-detail-title">' + esc(titleText) + '</div>',
      '<div class="feature-detail-subtitle">' + esc(ruleLabel) + ' — ' + esc(text('输入 / 插入变量、模板或预设片段。', 'Type / to insert variables, templates, or preset fragments.')) + '</div>',
      '</div>',
      '<button class="feature-detail-close" type="button" title="' + esc(text('关闭', 'Close')) + '" onclick="window.ClawFlowEditor.closePromptEditor()">×</button>',
      '</div>',
      '<div class="flow-editor-prompt-editor-wrap">',
      '<div class="fw-prompt-editor fe-prompt-ce" contenteditable="true" autofocus data-prompt-scope="' + esc(scope) + '" data-prompt-target="' + esc(targetId) + '" data-prompt-rule="' + esc(ruleId) + '" oninput="window.ClawFlowEditor.handlePromptEditorInput()" onkeydown="window.ClawFlowEditor.handlePromptEditorKeydown(event)">' + promptToHTML(rule.template || '') + '</div>',
      '<div id="flow-prompt-picker-host"></div>',
      '</div>',
      '<div class="fe-prompt-footer">',
      '<div class="fe-prompt-footer-hint">',
      '<span>' + esc(text('输入 / 可插入', 'Type / to insert')) + ' </span>',
      '<span class="fe-prompt-footer-count">' + varCount + '</span><span>' + esc(text(' 个变量', ' variables')) + '</span>',
      '<span class="fe-prompt-footer-sep">·</span>',
      '<span class="fe-prompt-footer-count">' + snippetCount + '</span><span>' + esc(text(' 个模板/片段', ' templates/fragments')) + '</span>',
      '</div>',
      '<button class="fe-prompt-footer-done" type="button" onclick="window.ClawFlowEditor.closePromptEditor()">' + esc(text('完成编辑', 'Done')) + '</button>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');
  }

  function renderFeatureModeSelector(node) {
    const groups = groupModesByFeature();
    if (!groups.length) {
      return '<div class="flow-editor-empty">' + esc(text('当前已启用 Feature 还没有暴露可编排模式。先改造 Feature 并刷新能力后，这里会出现可切换的业务模式。', 'No enabled Feature exposes orchestration modes yet. After a Feature is upgraded and capabilities are refreshed, its modes will appear here.')) + '</div>';
    }

    return [
      '<div class="flow-editor-empty" style="margin-bottom:10px;">' + esc(text('节点只记录“模式修改”。若当前节点不设置某个 Feature，它会继续沿用前面节点已经生效的模式。', 'Nodes only record mode changes. If a Feature is not set on this node, it keeps the mode that was already active in previous nodes.')) + '</div>',
      '<div class="flow-editor-tool-rule-list">' + groups.map(group => renderFeatureModeRow(node, group)).join('') + '</div>',
    ].join('');
  }

  function renderFeatureModeRow(node, group) {
    const selectedChange = getNodeFeatureModeChange(node, group.featureId || group.packageName || group.key);
    const selectedModeId = String(selectedChange?.modeId || '');
    const selectedMode = group.modes.find(mode => String(mode.modeId || mode.id || '') === selectedModeId) || null;
    return [
      '<div class="flow-editor-tool-rule">',
      '<div class="flow-editor-tool-rule-main">',
      '<div class="flow-editor-tool-name">' + esc(group.featureName) + '</div>',
      '<div class="flow-editor-tool-meta">' + esc(selectedMode?.description || (group.packageName || text('当前节点未覆盖，继续继承前序模式。', 'No override on this node; the previous mode remains active.'))) + '</div>',
      '</div>',
      '<div class="flow-editor-mode-select-wrap">',
      '<select class="flow-editor-select" onchange="window.ClawFlowEditor.setNodeFeatureMode(&quot;' + esc(node.id) + '&quot;, &quot;' + esc(group.featureId || '') + '&quot;, &quot;' + esc(group.packageName || '') + '&quot;, this.value)">',
      [['', text('继承当前模式', 'Inherit current mode')], ...group.modes.map(mode => [String(mode.modeId || mode.id || ''), mode.title || mode.modeId || mode.id])].map(option => {
        const optionValue = Array.isArray(option) ? option[0] : option;
        const optionLabel = Array.isArray(option) ? option[1] : option;
        return '<option value="' + esc(optionValue) + '"' + (String(selectedModeId) === String(optionValue) ? ' selected' : '') + '>' + esc(optionLabel) + '</option>';
      }).join(''),
      '</select>',
      '</div>',
      '</div>',
    ].join('');
  }

  function renderToolSelector(node) {
    const rules = getNodeToolRules(node);
    const tools = state.capabilities.tools || [];
    if (!tools.length) {
      return '<div class="flow-editor-empty">' + esc(text('当前 Agent 已选 Feature 没有暴露可配置工具权限。请先在组装页启用 Feature，然后刷新能力。', 'No configurable tool permissions exposed by selected Features. Enable Features on Assembly, then refresh capabilities.')) + '</div>';
    }
    const selectedTools = rules.map(rule => toolByName(rule.name) || { name: rule.name, featureName: text('未知来源', 'Unknown source'), description: '' });
    return [
      '<div class="flow-editor-tool-summary">',
      '<div><strong>' + esc(text('已添加工具', 'Added tools')) + '</strong><small>' + esc(text('这里只管理被添加的工具；未添加的工具保持进入工作流前的状态。', 'Only added tools are managed here; unlisted tools keep the state they had before entering the workflow.')) + '</small></div>',
      '<button class="workspace-action secondary" type="button" onclick="window.ClawFlowEditor.openToolPicker()">' + esc(text('添加工具', 'Add tools')) + '</button>',
      '</div>',
      selectedTools.length
        ? '<div class="flow-editor-tool-rule-list">' + rules.map((rule) => renderToolRuleRow(node, rule)).join('') + '</div>'
        : '<div class="flow-editor-empty">' + esc(text('这个节点还没有显式管理任何工具。点击“添加工具”从 Feature 工具库里选择。', 'This node does not explicitly manage any tools yet. Click Add tools to choose from the Feature tool library.')) + '</div>',
    ].join('');
  }

  function renderToolRuleRow(node, rule) {
    const tool = toolByName(rule.name) || {};
    const mode = normalizeToolRuleMode(rule);
    const labels = {
      enabled: text('启用', 'Enabled'),
      disabled: text('禁用', 'Disabled'),
      removed: text('移除', 'Removed'),
    };
    return [
      '<div class="flow-editor-tool-rule">',
      '<div class="flow-editor-tool-rule-main">',
      '<div class="flow-editor-tool-name">' + esc(rule.name) + '</div>',
      '<div class="flow-editor-tool-meta">' + esc([tool.featureName, tool.description].filter(Boolean).join(' · ')) + '</div>',
      '</div>',
      '<div class="flow-editor-tool-rule-actions">',
      '<button class="flow-editor-state-toggle ' + mode + '" type="button" onclick="window.ClawFlowEditor.cycleNodeToolRule(&quot;' + esc(node.id) + '&quot;, &quot;' + esc(rule.name) + '&quot;)" title="' + esc(text('点击切换：启用 / 禁用 / 移除', 'Click to cycle: enabled / disabled / removed')) + '">' + esc(labels[mode]) + '</button>',
      '<button class="flow-editor-mini-button danger" type="button" title="' + esc(text('从规则中删除', 'Remove from rules')) + '" onclick="window.ClawFlowEditor.removeNodeToolRule(&quot;' + esc(node.id) + '&quot;, &quot;' + esc(rule.name) + '&quot;)">&times;</button>',
      '</div>',
      '</div>',
    ].join('');
  }

  function renderToolPickerPanel() {
    if (!state.toolPicker.open || !selectedNode()) return '';
    const node = selectedNode();
    const query = String(state.toolPicker.query || '').trim().toLowerCase();
    const grouped = groupToolsByFeature(state.capabilities.tools || [], query);
    return [
      '<aside class="flow-editor-floating-panel flow-editor-tool-picker">',
      '<div class="flow-editor-floating-head">',
      '<div><div class="flow-editor-panel-title">' + esc(text('Feature 工具库', 'Feature Tool Library')) + '</div><div class="flow-editor-tool-picker-subtitle">' + esc(text('从已启用 Feature 暴露的工具里添加到当前节点。', 'Add tools exposed by enabled Features to the current node.')) + '</div></div>',
      '<button class="flow-editor-icon-button" type="button" onclick="window.ClawFlowEditor.closeToolPicker()">×</button>',
      '</div>',
      '<input class="flow-editor-input" value="' + esc(state.toolPicker.query) + '" placeholder="' + esc(text('搜索工具或 Feature', 'Search tools or Features')) + '" oninput="window.ClawFlowEditor.setToolPickerQuery(this.value)">',
      '<div class="flow-editor-tool-library">',
      grouped.length ? grouped.map(group => renderToolFeatureGroup(node, group)).join('') : '<div class="flow-editor-empty">' + esc(text('没有匹配的工具。', 'No matching tools.')) + '</div>',
      '</div>',
      '</aside>',
    ].join('');
  }

  function groupToolsByFeature(tools, query) {
    const map = new Map();
    tools.forEach(tool => {
      const haystack = [tool.name, tool.featureName, tool.packageName, tool.description].join(' ').toLowerCase();
      if (query && !haystack.includes(query)) return;
      const key = tool.featureId || tool.featureName || tool.packageName || text('未分组', 'Ungrouped');
      if (!map.has(key)) {
        map.set(key, {
          key,
          featureName: tool.featureName || key,
          packageName: tool.packageName || '',
          tools: [],
        });
      }
      map.get(key).tools.push(tool);
    });
    return [...map.values()].sort((a, b) => a.featureName.localeCompare(b.featureName));
  }

  function groupModesByFeature() {
    const map = new Map();
    (state.capabilities.modes || []).forEach(mode => {
      const key = mode.featureId || mode.packageName || mode.featureName || mode.id;
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, {
          key,
          featureId: mode.featureId || '',
          featureName: mode.featureId || mode.featureName || key,
          packageName: mode.packageName || '',
          modes: [],
        });
      }
      map.get(key).modes.push(mode);
    });
    return [...map.values()]
      .map(group => ({ ...group, modes: group.modes.sort((a, b) => String(a.title || a.modeId || a.id).localeCompare(String(b.title || b.modeId || b.id))) }))
      .sort((a, b) => String(a.featureName || a.key).localeCompare(String(b.featureName || b.key)));
  }

  function getNodeFeatureModeChange(node, featureKey) {
    return getNodeFeatureModeChanges(node).find(change => {
      return [change.featureId, change.packageName].filter(Boolean).some(value => String(value) === String(featureKey));
    }) || null;
  }

  function setNodeFeatureMode(nodeId, featureId, packageName, modeId) {
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node) return;
    pushUndo(cloneGraph(state.graph));
    const current = getNodeFeatureModeChanges(node).filter(change => {
      return String(change.featureId || '') !== String(featureId || '')
        && String(change.packageName || '') !== String(packageName || '');
    });
    const nextModeId = String(modeId || '').trim();
    if (nextModeId) {
      current.push({
        featureId: String(featureId || '').trim() || undefined,
        packageName: String(packageName || '').trim() || undefined,
        modeId: nextModeId,
      });
    }
    if (current.length) node.featureModeChanges = current;
    else delete node.featureModeChanges;
    markGraphChanged();
    render();
  }

  function resolveModeTitle(change) {
    if (!change) return '';
    const featureValue = String(change.featureId || change.packageName || '').trim();
    const modeValue = String(change.modeId || '').trim();
    const matched = (state.capabilities.modes || []).find(mode => {
      const sameFeature = [mode.featureId, mode.packageName].filter(Boolean).some(value => String(value) === featureValue);
      return sameFeature && String(mode.modeId || mode.id || '').trim() === modeValue;
    });
    return matched ? String(matched.title || matched.modeId || matched.id || modeValue) : modeValue;
  }

  // ── Prompt contentEditable helpers ──────────────────

  var VAR_CHIP_RE = /\{\{([^{}]+)\}\}/g;

  function varChipHtml(key) {
    var info = (state.capabilities.variables || []).find(function (v) { return v.key === key; });
    var label = info ? (info.title || key) : key;
    var cls = info ? 'fe-var-chip' : 'fe-var-chip unknown';
    return '<span contenteditable="false" class="' + cls + '" data-var-key="' + esc(key) + '">'
      + '<span class="fe-var-chip-brace">{</span>'
      + '<span class="fe-var-chip-label">' + esc(label) + '</span>'
      + '<span class="fe-var-chip-brace">}</span>'
      + '</span>';
  }

  function promptToHTML(rawText) {
    if (!rawText) return '';
    var parts = rawText.split(VAR_CHIP_RE);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        out.push(esc(parts[i]).replace(/\n/g, '<br>'));
      } else {
        out.push(varChipHtml(parts[i]));
      }
    }
    return out.join('');
  }

  function htmlToPrompt(el) {
    var parts = [];
    function walk(node) {
      if (node.nodeType === 3) { parts.push(node.textContent); return; }
      if (node.nodeType !== 1) return;
      var tag = node.tagName;
      if (tag === 'BR') { parts.push('\n'); return; }
      if (tag === 'SPAN' && node.hasAttribute('data-var-key')) {
        parts.push('{{' + node.getAttribute('data-var-key') + '}}');
        return;
      }
      for (var i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
    for (var i = 0; i < el.childNodes.length; i++) walk(el.childNodes[i]);
    return parts.join('');
  }

  function getPromptCursorOffset(el) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return -1;
    var range = sel.getRangeAt(0);
    var preRange = range.cloneRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    var container = preRange.commonAncestorContainer;
    if (container === el && !preRange.startOffset && !preRange.endOffset) {
      var nodes = [];
      function collect(n) { if (n.nodeType === 3) { nodes.push(n); } else if (n.nodeType === 1) { for (var i = 0; i < n.childNodes.length; i++) collect(n.childNodes[i]); } }
      collect(el);
      if (!nodes.length) return 0;
      preRange.setEnd(nodes[nodes.length - 1], nodes[nodes.length - 1].length);
    }
    var frag = preRange.cloneContents();
    var tmp = document.createElement('div');
    tmp.appendChild(frag);
    return htmlToPrompt(tmp).length;
  }

  function setPromptCursorOffset(el, offset) {
    var acc = 0;
    function walk(node) {
      if (acc >= offset) return null;
      if (node.nodeType === 3) {
        if (acc + node.length >= offset) {
          return { node: node, offset: offset - acc };
        }
        acc += node.length;
        return null;
      }
      if (node.nodeType !== 1) return null;
      var tag = node.tagName;
      if (tag === 'BR') {
        if (acc + 1 > offset) return { node: node.parentNode, offset: Array.from(node.parentNode.childNodes).indexOf(node) };
        acc += 1;
        return null;
      }
      if (tag === 'SPAN' && node.hasAttribute('data-var-key')) {
        if (acc + 1 > offset) {
          return { node: node.parentNode, offset: Array.from(node.parentNode.childNodes).indexOf(node) };
        }
        acc += ('{{' + node.getAttribute('data-var-key') + '}}').length;
        return null;
      }
      for (var i = 0; i < node.childNodes.length; i++) {
        var r = walk(node.childNodes[i]);
        if (r) return r;
      }
      return null;
    }
    var pos = walk(el);
    if (!pos) {
      var last = el.lastChild;
      if (!last) { pos = { node: el, offset: 0 }; }
      else if (last.nodeType === 3) { pos = { node: last, offset: last.length }; }
      else { pos = { node: el, offset: el.childNodes.length }; }
    }
    var sel = window.getSelection();
    var range = document.createRange();
    try { range.setStart(pos.node, pos.offset); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); } catch (e) {}
  }

  function getPickerAnchorRect(el) {
    var sel = window.getSelection();
    if (!sel.rangeCount) return null;
    var range = sel.getRangeAt(0).cloneRange();
    range.collapse(true);
    var rects = range.getClientRects();
    if (rects.length) return rects[0];
    return el.getBoundingClientRect();
  }

  // ── Prompt slash picker ──────────────────────────────

  function collectPromptPickerItems() {
    var items = [];
    var seen = new Set();
    function addItem(item) {
      var dedupeKey = [item.type, item.key, item.insertText].join('::');
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      items.push(item);
    }
    (state.capabilities.variables || []).forEach(function (v) {
      if (!v || !v.key) return;
      addItem({
        type: 'variable',
        key: String(v.key),
        title: String(v.title || v.key),
        description: String(v.description || ''),
        valueType: variableTypeLabel(v.type),
        featureName: String(v.featureName || ''),
        insertText: '{{' + String(v.key) + '}}',
      });
    });
    (state.capabilities.nodeTemplates || []).forEach(function (template) {
      if (!template || !template.id || !template.prompt) return;
      addItem({
        type: 'template',
        key: String(template.id),
        title: String(template.name || template.id),
        description: String(template.description || ''),
        featureName: String(template.featureName || template.packageName || ''),
        insertText: String(template.prompt || ''),
      });
    });
    (state.capabilities.modes || []).forEach(function (mode) {
      if (!Array.isArray(mode.suggestedPromptFragments)) return;
      mode.suggestedPromptFragments.forEach(function (frag) {
        if (!frag || !frag.id) return;
        addItem({
          type: 'fragment',
          key: String(frag.id),
          title: String(frag.title || frag.id),
          description: String(frag.description || ''),
          featureName: String(mode.featureName || ''),
          template: String(frag.template || ''),
          insertText: String(frag.template || ''),
        });
      });
    });
    return items;
  }

  function filterPromptPickerItems(items, query) {
    if (!query) return items.slice(0, 60);
    var q = query.toLowerCase();
    return items.filter(function (item) {
      return [item.title, item.key, item.description, item.featureName, item.insertText].join(' ').toLowerCase().indexOf(q) >= 0;
    }).slice(0, 60);
  }

  function detectSlashTrigger(text, cursorPos) {
    if (cursorPos < 1) return null;
    var before = text.substring(0, cursorPos);
    var slashMatch = before.match(/\/([^/\s]*)$/);
    if (!slashMatch) return null;
    var startPos = cursorPos - slashMatch[0].length;
    return { startIndex: startPos, query: slashMatch[1] || '' };
  }

  function insertPromptPickerItem(scope, targetId, ruleId, item) {
    var target = resolvePromptTarget(scope, targetId);
    if (!target) return;
    var rules = ensurePromptRules(target);
    var rule = rules.find(function (r) { return r.id === ruleId; });
    if (!rule) return;
    var ce = document.querySelector('.fe-prompt-ce');
    if (!ce) return;
    var rawText = htmlToPrompt(ce);
    var cursorOffset = getPromptCursorOffset(ce);
    if (cursorOffset < 0) cursorOffset = rawText.length;
    var trigger = detectSlashTrigger(rawText, cursorOffset);
    if (!trigger) return;
    var before = rawText.substring(0, trigger.startIndex);
    var after = rawText.substring(cursorOffset);
    rule.template = before + item.insertText + after;
    state.slashPicker.open = false;
    state.slashPicker.query = '';
    markGraphChanged();
    var savedOffset = before.length + item.insertText.length;
    ce.innerHTML = promptToHTML(rule.template);
    setPromptCursorOffset(ce, savedOffset);
    renderPromptPickerDropdown();
  }

  function handlePromptEditorInput() {
    var ce = document.querySelector('.fe-prompt-ce');
    if (!ce) return;
    var scope = ce.getAttribute('data-prompt-scope') || 'node';
    var targetId = ce.getAttribute('data-prompt-target') || '';
    var ruleId = ce.getAttribute('data-prompt-rule') || '';
    var rawText = htmlToPrompt(ce);
    updatePromptRuleDraft(scope, targetId, ruleId, rawText);
    var cursorOffset = getPromptCursorOffset(ce);
    var trigger = detectSlashTrigger(rawText, cursorOffset >= 0 ? cursorOffset : rawText.length);
    if (trigger) {
      state.slashPicker.open = true;
      state.slashPicker.query = trigger.query;
      state.slashPicker.startIndex = trigger.startIndex;
      state.slashPicker.activeIndex = 0;
    } else if (state.slashPicker.open) {
      state.slashPicker.open = false;
      state.slashPicker.query = '';
    }
    renderPromptPickerDropdown();
  }

  var PICKER_CATEGORIES = ['all', 'template', 'variable'];
  var PICKER_CATEGORY_LABELS = {
    all: text('全部', 'All'),
    template: text('模板', 'Templates'),
    variable: text('变量', 'Variables'),
  };

  function applyPickerCategoryFilter(items) {
    var cat = state.slashPicker.category || 'all';
    if (cat === 'all') return items;
    if (cat === 'template') return items.filter(function (it) { return it.type === 'template' || it.type === 'fragment'; });
    if (cat === 'variable') return items.filter(function (it) { return it.type === 'variable'; });
    return items;
  }

  function findPrevVarChip(ce) {
    var sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return null;
    var range = sel.getRangeAt(0);
    var node = range.startContainer;
    var offset = range.startOffset;
    var candidate = null;
    if (node.nodeType === 3 && offset === 0) {
      candidate = node.previousSibling;
    } else if (node.nodeType === 1 && offset > 0) {
      candidate = node.childNodes[offset - 1];
    }
    if (!candidate) return null;
    // Walk: skip trailing BRs to find a chip
    while (candidate && candidate.nodeType === 1 && candidate.tagName === 'BR') {
      candidate = candidate.previousSibling;
    }
    if (candidate && candidate.nodeType === 1 && candidate.hasAttribute('data-var-key')) {
      return candidate;
    }
    return null;
  }

  function handlePromptEditorKeydown(e) {
    // ── Backspace: delete variable chip when cursor is right after it ──
    if (e.key === 'Backspace' && !state.slashPicker.open) {
      var ce = document.querySelector('.fe-prompt-ce');
      if (ce && (document.activeElement === ce || ce.contains(document.activeElement))) {
        var chip = findPrevVarChip(ce);
        if (chip) {
          e.preventDefault();
          var rawBefore = htmlToPrompt(ce);
          chip.remove();
          var rawAfter = htmlToPrompt(ce);
          var nodeId = ce.getAttribute('data-node-id');
          var node = state.graph.nodes.find(function (n) { return n.id === nodeId; });
          if (node) { node.prompt = rawAfter; markGraphChanged(); }
          return;
        }
      }
    }
    if (state.slashPicker.open) {
      var allItems = filterPromptPickerItems(collectPromptPickerItems(), state.slashPicker.query);
      var items = applyPickerCategoryFilter(allItems);
      if (e.key === 'Escape') {
        e.preventDefault();
        state.slashPicker.open = false;
        state.slashPicker.query = '';
        renderPromptPickerDropdown();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        var curIdx = PICKER_CATEGORIES.indexOf(state.slashPicker.category || 'all');
        if (e.key === 'ArrowRight') curIdx = (curIdx + 1) % PICKER_CATEGORIES.length;
        else curIdx = (curIdx - 1 + PICKER_CATEGORIES.length) % PICKER_CATEGORIES.length;
        state.slashPicker.category = PICKER_CATEGORIES[curIdx];
        state.slashPicker.activeIndex = 0;
        renderPromptPickerDropdown();
        return;
      }
      if (items.length) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          state.slashPicker.activeIndex = Math.min(state.slashPicker.activeIndex + 1, items.length - 1);
          renderPromptPickerDropdown();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          state.slashPicker.activeIndex = Math.max(state.slashPicker.activeIndex - 1, 0);
          renderPromptPickerDropdown();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          var item = items[state.slashPicker.activeIndex];
          if (item) insertPromptPickerItem(state.promptDialog.scope, state.promptDialog.targetId, state.promptDialog.ruleId, item);
          return;
        }
      }
    }
  }

  function renderPromptPickerDropdown() {
    var host = document.getElementById('flow-prompt-picker-host');
    if (!host) return;
    if (!state.slashPicker.open) { host.innerHTML = ''; return; }
    var query = state.slashPicker.query || '';
    var allItems = filterPromptPickerItems(collectPromptPickerItems(), query);
    var items = applyPickerCategoryFilter(allItems);
    var listEl = host.querySelector('.fe-picker-list');
    var searchEl = host.querySelector('.fe-picker-search');
    if (!host.querySelector('.flow-editor-prompt-picker')) {
      host.innerHTML = '<div class="flow-editor-prompt-picker">'
        + '<div class="fe-picker-search-wrap"><input class="fe-picker-search" value="' + esc(query) + '" placeholder="' + esc(text('搜索变量、模板或片段…', 'Search variables, templates, or fragments…')) + '" oninput="window.ClawFlowEditor.setPickerSearch(this.value)" onkeydown="window.ClawFlowEditor.handlePromptEditorKeydown(event)"></div>'
        + '<div class="fe-picker-tabs"></div>'
        + '<div class="fe-picker-list"></div>'
        + '</div>';
      listEl = host.querySelector('.fe-picker-list');
      searchEl = host.querySelector('.fe-picker-search');
    }
    if (searchEl && document.activeElement !== searchEl) {
      searchEl.value = query;
    }
    // render category tabs
    var tabsEl = host.querySelector('.fe-picker-tabs');
    if (tabsEl) {
      var curCat = state.slashPicker.category || 'all';
      var tabCounts = { all: allItems.length, template: 0, variable: 0 };
      allItems.forEach(function (it) {
        if (it.type === 'variable') tabCounts.variable++;
        else tabCounts.template++;
      });
      var tabsHtml = '';
      PICKER_CATEGORIES.forEach(function (cat) {
        var isActive = cat === curCat;
        tabsHtml += '<button type="button" class="fe-picker-tab' + (isActive ? ' active' : '') + '" onmousedown="event.preventDefault()" onclick="window.ClawFlowEditor.setPickerCategory(\'' + cat + '\')">'
          + PICKER_CATEGORY_LABELS[cat]
          + ' <span class="fe-picker-tab-count">' + tabCounts[cat] + '</span>'
          + '</button>';
      });
      tabsEl.innerHTML = tabsHtml;
    }
    if (!items.length) {
      if (listEl) listEl.innerHTML = '<div class="flow-editor-prompt-picker-empty">' + esc(text('没有匹配项', 'No matches')) + '</div>';
      return;
    }
    var grouped = {};
    items.forEach(function (item) { var g = shortFeatureName(item.featureName) || text('其他', 'Other'); if (!grouped[g]) grouped[g] = []; grouped[g].push(item); });
    var groupNames = Object.keys(grouped);
    var showGroupHeaders = groupNames.length > 1;
    var html = '';
    var idx = 0;
    groupNames.forEach(function (group) {
      if (showGroupHeaders) html += '<div class="fe-picker-group-header">' + esc(group) + '</div>';
      grouped[group].forEach(function (item) {
        var i = idx++;
        var isVar = item.type === 'variable';
        var isTemplate = item.type === 'template';
        var icon = isVar ? '{ }' : (isTemplate ? '&#9638;' : '&#9998;');
        var label = isVar
          ? esc(text('变量', 'Var'))
          : (isTemplate ? esc(text('模板', 'Tpl')) : esc(text('片段', 'Snip')));
        var typeHtml = isVar && item.valueType ? '<small class="fe-picker-type-chip">' + esc(item.valueType) + '</small>' : '';
        var metaParts = pickerMetaParts(item);
        var metaHtml = metaParts.length
          ? metaParts.map(function (part) { return '<span>' + highlightMatch(part, query) + '</span>'; }).join('<span class="fe-picker-meta-sep">·</span>')
          : '';
        var previewText = pickerPreviewText(item);
        var sublineHtml = [metaHtml, previewText ? '<span class="flow-editor-prompt-picker-preview">' + highlightMatch(previewText, query) + '</span>' : ''].filter(Boolean).join('<span class="fe-picker-meta-sep">·</span>');
        html += '<div class="flow-editor-prompt-picker-item' + (i === state.slashPicker.activeIndex ? ' active' : '') + '" data-picker-index="' + i + '" onmousedown="event.preventDefault()" onclick="window.ClawFlowEditor.clickPromptPickerItem(' + i + ')">' +
          '<div class="flow-editor-prompt-picker-main">' +
          '<span class="flow-editor-prompt-picker-icon' + (isVar ? ' var-icon' : ' frag-icon') + '">' + icon + '</span>' +
          '<div class="flow-editor-prompt-picker-text">' +
          '<div class="flow-editor-prompt-picker-title"><div class="flow-editor-prompt-picker-title-main">' + highlightMatch(item.title, query) + '</div>' + typeHtml + '</div>' +
          (sublineHtml ? '<div class="flow-editor-prompt-picker-subline">' + sublineHtml + '</div>' : '') +
          '</div>' +
          '</div>' +
          '<span class="flow-editor-prompt-picker-badge' + (isVar ? ' var-badge' : ' frag-badge') + '">' + label + '</span>' +
          '</div>';
      });
    });
    if (listEl) listEl.innerHTML = html;
    // auto-scroll active item into view
    if (listEl && state.slashPicker.activeIndex >= 0) {
      var activeEl = listEl.querySelector('.flow-editor-prompt-picker-item.active');
      if (activeEl) ensurePickerItemVisible(listEl, activeEl);
    }
  }

  function ensurePickerItemVisible(container, item) {
    if (!container || !item) return;
    var margin = 6;
    var containerRect = container.getBoundingClientRect();
    var itemRect = item.getBoundingClientRect();
    var overTop = itemRect.top - containerRect.top;
    var overBottom = itemRect.bottom - containerRect.bottom;
    if (overTop < margin) {
      container.scrollTop = Math.max(container.scrollTop + overTop - margin, 0);
      return;
    }
    if (overBottom > -margin) {
      container.scrollTop = Math.max(container.scrollTop + overBottom + margin, 0);
    }
  }

  function shortFeatureName(name) {
    if (!name) return '';
    return name.replace(/^@[^/]+\//, '');
  }

  function highlightMatch(text, query) {
    if (!query || !text) return esc(text);
    var q = query.toLowerCase();
    var lower = text.toLowerCase();
    var idx = lower.indexOf(q);
    if (idx < 0) return esc(text);
    return esc(text.substring(0, idx)) + '<span class="fe-picker-hl">' + esc(text.substring(idx, idx + q.length)) + '</span>' + esc(text.substring(idx + q.length));
  }

  function setPickerSearch(value) {
    state.slashPicker.query = value || '';
    state.slashPicker.activeIndex = 0;
    renderPromptPickerDropdown();
  }

  function clickPromptPickerItem(index) {
    var allItems = filterPromptPickerItems(collectPromptPickerItems(), state.slashPicker.query);
    var items = applyPickerCategoryFilter(allItems);
    var item = items[index];
    if (item) insertPromptPickerItem(state.promptDialog.scope, state.promptDialog.targetId, state.promptDialog.ruleId, item);
  }

  function setPickerCategory(cat) {
    state.slashPicker.category = cat;
    state.slashPicker.activeIndex = 0;
    renderPromptPickerDropdown();
  }

  function renderToolFeatureGroup(node, group) {
    const rules = getNodeToolRules(node);
    const selected = new Set(rules.map(rule => rule.name));
    const allSelected = group.tools.every(tool => selected.has(tool.name));
    return [
      '<section class="flow-editor-tool-feature">',
      '<div class="flow-editor-tool-feature-head">',
      '<div><div class="flow-editor-tool-feature-name">' + esc(group.featureName) + '</div><div class="flow-editor-tool-meta">' + esc(group.packageName || `${group.tools.length} tools`) + '</div></div>',
      '<button class="flow-editor-mini-button" type="button" onclick="window.ClawFlowEditor.' + (allSelected ? 'removeFeatureTools' : 'addFeatureTools') + '(&quot;' + esc(node.id) + '&quot;, &quot;' + esc(group.key) + '&quot;)">' + esc(allSelected ? text('移除全部', 'Remove all') : text('添加全部', 'Add all')) + '</button>',
      '</div>',
      '<div class="flow-editor-tool-library-list">',
      group.tools.map(tool => [
        '<button class="flow-editor-tool-library-item ' + (selected.has(tool.name) ? 'selected' : '') + '" type="button" onclick="window.ClawFlowEditor.addNodeToolRule(&quot;' + esc(node.id) + '&quot;, &quot;' + esc(tool.name) + '&quot;)">',
        '<span><strong>' + esc(tool.name) + '</strong><small>' + esc(tool.description || '') + '</small></span>',
        '<span class="flow-editor-tool-library-mark">' + esc(selected.has(tool.name) ? text('已添加', 'Added') : '+') + '</span>',
        '</button>',
      ].join('')).join(''),
      '</div>',
      '</section>',
    ].join('');
  }

  function renderOnEnterActions(node) {
    const actions = Array.isArray(node.onEnter) ? node.onEnter : [];
    const toolOptions = [['', text('选择函数', 'Select function')], ...(state.capabilities.tools || []).map(tool => [tool.name, `${tool.name} · ${tool.featureName}`])];
    return [
      actions.length ? actions.map((action, index) => [
        '<div class="flow-editor-action-row">',
        action.type === 'tool-call'
          ? select(`action:${node.id}:${index}:tool`, text('函数调用', 'Function call'), action.tool || '', toolOptions)
          : field(`action:${node.id}:${index}:variablePath`, text('变量名', 'Variable'), action.variablePath || ''),
        '<button class="flow-editor-mini-button danger" type="button" onclick="window.ClawFlowEditor.deleteOnEnterAction(&quot;' + esc(node.id) + '&quot;, ' + index + ')">' + esc(text('删除', 'Delete')) + '</button>',
        '</div>',
      ].join('')).join('') : '<div class="flow-editor-empty">' + esc(text('进入节点时暂无自动动作。', 'No automatic actions on enter.')) + '</div>',
      '<button class="workspace-action secondary" type="button" onclick="window.ClawFlowEditor.addOnEnterTool(&quot;' + esc(node.id) + '&quot;)">' + esc(text('添加函数调用', 'Add function call')) + '</button>',
    ].join('');
  }

  function renderHelpPanel() {
    return [
      '<div class="flow-editor-help-list">',
      '<p>' + esc(text('拖动画布空白处平移，滚轮缩放。页面本身不会上下滚动。', 'Drag empty canvas space to pan; use the wheel to zoom. The page itself does not scroll.')) + '</p>',
      '<p>' + esc(text('拖拽节点移动。按住节点右侧 + 圆点拖到另一个节点上创建连线。', 'Drag nodes to move them. Drag the + handle on the right side of a node onto another node to create an edge.')) + '</p>',
      '<p>' + esc(text('每个连通分量都是一个工作流；点击节点后，右侧属性卡片默认显示 Node，也可以切换到 Workflow。', 'Each connected component is a workflow. After selecting a node, the inspector defaults to Node and can switch to Workflow.')) + '</p>',
      '</div>',
    ].join('');
  }

  function reminderOptions() {
    return ['every-step', 'every-call', 'once-per-node', 'every-n-steps'].map(item => [item, item]);
  }

  function promptTimingOptions() {
    return [
      ['on-enter', text('进入节点时', 'On enter')],
      ['every-step', text('每一步', 'Every step')],
      ['every-n-steps', text('每 N 步', 'Every N steps')],
      ['every-call', text('每轮对话', 'Every call')],
      ['every-n-calls', text('每 N 轮对话', 'Every N calls')],
    ];
  }

  function ensurePromptRules(target) {
    if (!target) return [];
    if (!target.prompts) {
      if (target.prompt) {
        target.prompts = [{
          id: 'legacy-' + Date.now(),
          timing: target.reminderFrequency || 'every-step',
          interval: target.reminderInterval,
          template: target.prompt,
        }];
      } else {
        target.prompts = [];
      }
    }
    return target.prompts;
  }

  function resolvePromptTarget(scope, targetId) {
    if (scope === 'node') {
      return state.graph?.nodes?.find(function (n) { return n.id === targetId; }) || null;
    }
    if (scope === 'workflow') {
      if (!state.graph?.workflows) return null;
      state.graph.workflows[targetId] = state.graph.workflows[targetId] || {};
      return state.graph.workflows[targetId];
    }
    return null;
  }

  function promptRuleLabel(rule) {
    var label = rule.name || '';
    if (!label) {
      var match = promptTimingOptions().find(function (opt) { return opt[0] === rule.timing; });
      label = match ? match[1] : rule.timing;
    }
    return label;
  }

  function renderWorkflowModeToggle(component) {
    var mode = component.meta.mode || 'agent-initiated';
    var modeLabels = {
      'agent-initiated': text('按需进入', 'On demand'),
      'auto': text('自动进入', 'Auto'),
      'auto-reenterable': text('自动且可重入', 'Auto+Re'),
    };
    var modeDescriptions = {
      'agent-initiated': text('Agent 按需主动进入', 'Agent enters when needed'),
      'auto': text('对话开始后自动进入，退出后不可再进入', 'Auto-enter on start; no re-entry after exit'),
      'auto-reenterable': text('对话开始后自动进入，退出后仍可重新进入', 'Auto-enter on start; re-entry allowed'),
    };
    var modeClasses = {
      'agent-initiated': '',
      'auto': 'auto',
      'auto-reenterable': 'reenterable',
    };
    var cls = modeClasses[mode] || '';
    return [
      '<div class="flow-editor-field">',
      '<span class="flow-editor-label">' + esc(text('进入模式', 'Mode')) + '</span>',
      '<div class="flow-editor-mode-toggle-wrap">',
      '<button class="flow-editor-mode-toggle ' + esc(cls) + '" type="button" title="' + esc(modeDescriptions[mode]) + '" onclick="window.ClawFlowEditor.cycleWorkflowMode(&quot;' + esc(component.id) + '&quot;)">',
      esc(modeLabels[mode]),
      '</button>',
      '</div>',
      '</div>',
    ].join('');
  }

  function cycleWorkflowMode(wid) {
    if (!state.graph?.workflows?.[wid]) return;
    pushUndo(cloneGraph(state.graph));
    var current = state.graph.workflows[wid].mode || 'agent-initiated';
    var order = ['agent-initiated', 'auto', 'auto-reenterable'];
    var idx = order.indexOf(current);
    var next = order[(idx + 1) % order.length];
    state.graph.workflows[wid].mode = next;
    state.selectedWorkflowId = wid;
    markGraphChanged();
    render();
  }

  function field(name, label, value) {
    return '<label class="flow-editor-field"><span class="flow-editor-label">' + esc(label) + '</span><input class="flow-editor-input" value="' + esc(value) + '" oninput="window.ClawFlowEditor.handleTextFieldInput(&quot;' + esc(name) + '&quot;, this.value)" onblur="window.ClawFlowEditor.commitTextField(&quot;' + esc(name) + '&quot;, this.value)"></label>';
  }

  function textarea(name, label, value) {
    return '<label class="flow-editor-field"><span class="flow-editor-label">' + esc(label) + '</span><textarea class="flow-editor-textarea" oninput="window.ClawFlowEditor.handleTextFieldInput(&quot;' + esc(name) + '&quot;, this.value)" onblur="window.ClawFlowEditor.commitTextField(&quot;' + esc(name) + '&quot;, this.value)">' + esc(value) + '</textarea></label>';
  }

  function select(name, label, value, options) {
    const optionHtml = options.map(option => {
      const optionValue = Array.isArray(option) ? option[0] : option;
      const optionLabel = Array.isArray(option) ? option[1] : option;
      return '<option value="' + esc(optionValue) + '"' + (String(value) === String(optionValue) ? ' selected' : '') + '>' + esc(optionLabel) + '</option>';
    }).join('');
    return '<label class="flow-editor-field"><span class="flow-editor-label">' + esc(label) + '</span><select class="flow-editor-select" onchange="window.ClawFlowEditor.updateField(&quot;' + esc(name) + '&quot;, this.value, true)">' + optionHtml + '</select></label>';
  }

  function nodeCenter(node) {
    return {
      x: Number(node.position?.x || 0) + NODE_W / 2,
      y: Number(node.position?.y || 0) + NODE_H / 2,
    };
  }

  function renderWorkflowFrames() {
    return computeComponents().map(component => {
      const frame = component.frame || computeWorkflowFrame(component);
      const active = component.id === state.selectedWorkflowId || component.nodes.some(node => node.id === state.selectedNodeId);
      const auto = component.meta.mode === 'auto';
      const reenterable = component.meta.mode === 'auto-reenterable';
      return [
        '<section class="flow-editor-workflow-frame' + (active ? ' active' : '') + (auto ? ' auto' : '') + (reenterable ? ' reenterable' : '') + '"',
        ' data-flow-workflow-id="' + esc(component.id) + '"',
        ' style="left:' + frame.x + 'px;top:' + frame.y + 'px;width:' + frame.width + 'px;height:' + frame.height + 'px"',
        ' onpointerdown="window.ClawFlowEditor.startWorkflowDrag(event, &quot;' + esc(component.id) + '&quot;)"',
        ' onclick="window.ClawFlowEditor.selectWorkflowFrame(event, &quot;' + esc(component.id) + '&quot;)">',
        '<div class="flow-editor-workflow-frame-title">' + esc(component.meta.name || component.id) + '</div>',
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(handle => '<button class="flow-editor-frame-resize ' + handle + '" type="button" onpointerdown="window.ClawFlowEditor.startWorkflowResize(event, &quot;' + esc(component.id) + '&quot;, &quot;' + handle + '&quot;)"></button>').join(''),
        '</section>',
      ].join('');
    }).join('');
  }

  function renderEdges(nodes, edges) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const paths = edges.map(edge => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return '';
      const startX = Number(from.position?.x || 0) + NODE_W;
      const startY = Number(from.position?.y || 0) + NODE_H / 2;
      const endX = Number(to.position?.x || 0);
      const endY = Number(to.position?.y || 0) + NODE_H / 2;
      const edgeId = `${edge.from}__${edge.to}`;
      return '<path class="flow-editor-edge' + (state.selectedEdgeId === edgeId ? ' active' : '') + '" data-edge-id="' + esc(edgeId) + '" data-edge-from="' + esc(edge.from) + '" data-edge-to="' + esc(edge.to) + '" d="' + esc(bezierPath(startX, startY, endX, endY)) + '" marker-end="url(#flow-arrow)" onclick="window.ClawFlowEditor.selectEdge(event, &quot;' + esc(edgeId) + '&quot;)"></path>';
    }).join('');
    return [
      '<svg class="flow-editor-svg">',
      '<defs><marker id="flow-arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="rgba(172,181,197,0.88)"></path></marker></defs>',
      paths,
      '</svg>',
    ].join('');
  }

  function renderConnectingLine() {
    if (!state.connecting) return '';
    const from = state.connecting.start;
    const to = state.connecting.current || from;
    return '<svg class="flow-editor-svg flow-editor-connection-preview"><path class="flow-editor-edge preview" data-connection-preview="1" d="' + esc(bezierPath(from.x, from.y, to.x, to.y)) + '"></path></svg>';
  }

  function bezierPath(startX, startY, endX, endY) {
    const dx = Math.max(80, Math.abs(endX - startX) * 0.45);
    return `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;
  }

  function renderEdgeLabels(nodes, edges) {
    return '';
  }

  function renderNodeCard(node) {
    const component = componentForNode(node.id);
    const meta = component?.meta || {};
    const isHead = isWorkflowHead(node);
    const isSelected = node.id === state.selectedNodeId;
    const prompt = isHead ? text('工作流头节点：它定义工作流起点，本身不进入运行时执行。', 'Workflow head: defines the workflow start and is not executed at runtime.') : (function () {
      var prs = ensurePromptRules(node);
      if (prs.length === 0) return text('未填写节点提示词。', 'No prompt yet.');
      return prs.map(function (r) { return promptRuleLabel(r) + (r.template ? '' : text('（空）', ' (empty)')); }).join(', ');
    })();
    const displayName = isHead ? (meta.name || node.name || text('未命名工作流', 'Untitled workflow')) : (node.name || node.id);
    const rules = getNodeToolRules(node);
    const modeChanges = getNodeFeatureModeChanges(node);
    const enabledCount = rules.filter(rule => rule.mode === 'enabled').length;
    const disabledCount = rules.filter(rule => rule.mode === 'disabled').length;
    const removedCount = rules.filter(rule => rule.mode === 'removed').length;
    const tools = rules.length
      ? text(`工具 ${rules.length}（启用 ${enabledCount} / 禁用 ${disabledCount} / 移除 ${removedCount}）`, `Tools ${rules.length} (${enabledCount} enabled / ${disabledCount} disabled / ${removedCount} removed)`)
      : text('继承基线工具状态', 'Inherit baseline tool state');
    const modeSummary = modeChanges.length
      ? text(`模式修改 ${modeChanges.length} 项`, `${modeChanges.length} mode change(s)`)
      : text('模式沿用前序节点', 'Modes inherited from previous nodes');
    return [
      '<article class="flow-editor-node' + (isSelected ? ' active' : '') + (isHead ? ' workflow-head' : '') + (meta.mode === 'auto' ? ' auto-head' : (meta.mode === 'auto-reenterable' ? ' reenterable-head' : '')) + '" data-flow-node-id="' + esc(node.id) + '"',
      ' style="left:' + Number(node.position?.x || 0) + 'px;top:' + Number(node.position?.y || 0) + 'px"',
      ' onpointerdown="window.ClawFlowEditor.startNodeDrag(event, &quot;' + esc(node.id) + '&quot;)"',
      ' onclick="window.ClawFlowEditor.selectNode(event, &quot;' + esc(node.id) + '&quot;)">',
      '<div class="flow-editor-node-head">',
      '<div><div class="flow-editor-node-title">' + esc(displayName) + '</div></div>',
      '</div>',
      prompt && !isHead ? '<div class="flow-editor-node-prompt">' + esc(prompt) + '</div>' : '',
      !isHead ? '<div class="flow-editor-node-meta">' + esc(modeSummary + ' · ' + tools) + '</div>' : '',
      '<button class="flow-editor-connect-handle" title="' + esc(text('拖动连接到其他节点', 'Drag to connect to another node')) + '" type="button" onpointerdown="window.ClawFlowEditor.startConnect(event, &quot;' + esc(node.id) + '&quot;)">+</button>',
      '</article>',
    ].join('');
  }

  function screenToWorld(event) {
    const wrap = document.getElementById('flow-editor-canvas-wrap');
    if (!state.graph || !wrap) return { x: 0, y: 0 };
    const rect = wrap.getBoundingClientRect();
    const v = viewport();
    return {
      x: (event.clientX - rect.left - v.x) / v.zoom,
      y: (event.clientY - rect.top - v.y) / v.zoom,
    };
  }

  function canvasCenterWorld() {
    const wrap = document.getElementById('flow-editor-canvas-wrap');
    if (!wrap) return { x: 120, y: 120 };
    const rect = wrap.getBoundingClientRect();
    return screenToWorld({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
  }

  function fieldNeedsDeferredRerender(name) {
    const parts = String(name || '').split(':');
    return (parts[0] === 'workflow' || parts[0] === 'node') && parts[2] === 'name';
  }

  function handleTextFieldInput(name, value) {
    updateField(name, value, false, { suppressDerivedRerender: true });
  }

  function commitTextField(name, value) {
    if (!fieldNeedsDeferredRerender(name)) {
      return;
    }
    updateField(name, value, true);
  }

  function updateField(name, value, rerender = false, options = {}) {
    const graph = state.graph;
    if (!graph) return;
    const parts = String(name || '').split(':');
    if (parts[0] === 'graph') {
      graph[parts[1]] = value;
    } else if (parts[0] === 'workflow') {
      const wid = parts[1];
      graph.workflows[wid] = graph.workflows[wid] || { id: wid };
      const key = parts[2];
      graph.workflows[wid][key] = value;
      if (key === 'name') {
        const head = workflowHeadFor(wid, graph);
        if (head) head.name = value || text('未命名工作流', 'Untitled workflow');
        if (!options.suppressDerivedRerender) {
          rerender = true;
        }
      }
      if (key === 'mode' && (value === 'auto' || value === 'auto-reenterable')) {
        Object.keys(graph.workflows).forEach(id => {
          if (id !== wid && (graph.workflows[id].mode === 'auto' || graph.workflows[id].mode === 'auto-reenterable')) {
            graph.workflows[id].mode = 'agent-initiated';
          }
        });
        rerender = true;
      }
    } else if (parts[0] === 'workflowVar') {
      const wid = parts[1];
      const varKey = parts.slice(2).join(':');
      graph.workflows[wid] = graph.workflows[wid] || { id: wid };
      graph.workflows[wid].variables = graph.workflows[wid].variables || {};
      graph.workflows[wid].variables[varKey] = coerceValue(value);
    } else if (parts[0] === 'action') {
      const node = graph.nodes.find(item => item.id === parts[1]);
      if (!node) return;
      const index = Number(parts[2]);
      const key = parts[3];
      node.onEnter = Array.isArray(node.onEnter) ? node.onEnter : [];
      node.onEnter[index] = node.onEnter[index] || { type: 'tool-call' };
      if (key === 'tool') {
        const tool = toolByName(value);
        node.onEnter[index].type = 'tool-call';
        node.onEnter[index].tool = value || '';
        node.onEnter[index].toolRef = tool ? {
          source: 'feature',
          featureId: tool.featureId,
          packageName: tool.packageName,
          name: tool.name,
        } : undefined;
      } else {
        node.onEnter[index][key] = value;
      }
    } else if (parts[0] === 'node') {
      const node = graph.nodes.find(item => item.id === parts[1]);
      if (!node) return;
      const key = parts[2];
      if (key === 'tools') {
        const tools = String(value || '').split(/[,\n]+/).map(item => item.trim()).filter(Boolean);
        if (tools.length) node.tools = { enable: tools };
        else delete node.tools;
      } else if (key === 'exitVariable' || key === 'exitOperator' || key === 'exitValue') {
        if (!node.exitWhen) node.exitWhen = { variable: '', operator: 'eq' };
        if (key === 'exitVariable') {
          const variable = variableByKey(value, componentForNode(node.id));
          node.exitWhen.variable = value;
          node.exitWhen.variableRef = variable ? {
            source: variable.source,
            featureId: variable.featureId,
            packageName: variable.packageName,
            workflowId: variable.workflowId,
            key: variable.key,
          } : undefined;
        }
        if (key === 'exitOperator') node.exitWhen.operator = value || 'eq';
        if (key === 'exitValue') node.exitWhen.value = coerceValue(value);
        if (!node.exitWhen.variable) delete node.exitWhen;
      } else {
        node[key] = value || undefined;
      }
    } else if (parts[0] === 'promptRule') {
      var prScope = parts[1];
      var prTargetId = parts[2];
      var prRuleId = parts[3];
      var prKey = parts[4];
      var prTarget = resolvePromptTarget(prScope, prTargetId);
      if (prTarget) {
        var prRules = ensurePromptRules(prTarget);
        var prRule = prRules.find(function (r) { return r.id === prRuleId; });
        if (prRule) {
          if (prKey === 'timing') {
            prRule.timing = value;
            rerender = true;
          } else if (prKey === 'interval') {
            prRule.interval = Number(value) || undefined;
          } else if (prKey === 'template') {
            prRule.template = value;
          } else if (prKey === 'name') {
            prRule.name = value;
          }
        }
      }
    }
    markGraphChanged({ rerender });
  }

  function coerceValue(value) {
    if (value === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && String(value).trim() !== '' ? numeric : value;
  }

  // ── 新旧数据结构兼容层 ──────────────────────────────
  // 读取优先级: advanced.tools.rules → tools.rules → tools.enable

  function getNodeFeatureModeChanges(node) {
    if (!node || !Array.isArray(node.featureModeChanges)) return [];
    return node.featureModeChanges.filter(function (c) {
      return c && typeof c.modeId === 'string' && c.modeId.trim();
    });
  }

  function getEffectiveToolRules(node) {
    if (!node) return [];
    // 新结构: advanced.tools.rules
    var advanced = Array.isArray(node.advanced?.tools?.rules) ? node.advanced.tools.rules : null;
    if (advanced && advanced.length) {
      return advanced
        .filter(function (rule) { return rule && typeof rule.name === 'string' && rule.name.trim(); })
        .map(function (rule) { return Object.assign({}, rule, { name: rule.name.trim(), mode: normalizeToolRuleMode(rule) }); });
    }
    // 旧结构: tools.rules
    if (Array.isArray(node.tools?.rules) && node.tools.rules.length) {
      return node.tools.rules
        .filter(function (rule) { return rule && typeof rule.name === 'string' && rule.name.trim(); })
        .map(function (rule) { return Object.assign({}, rule, { name: rule.name.trim(), mode: normalizeToolRuleMode(rule) }); });
    }
    // 更旧结构: tools.enable
    if (Array.isArray(node.tools?.enable) && node.tools.enable.length) {
      return node.tools.enable
        .filter(Boolean)
        .map(function (name) { return { name: name, mode: 'enabled', ref: toolRefByName(name) }; });
    }
    return [];
  }

  function writeAdvancedToolRules(node, rules) {
    var normalized = [];
    var seen = new Set();
    rules.forEach(function (rule) {
      var name = String(rule?.name || '').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      normalized.push({
        name: name,
        mode: normalizeToolRuleMode(rule),
        ref: rule.ref || toolRefByName(name),
      });
    });
    if (normalized.length) {
      if (!node.advanced) node.advanced = {};
      if (!node.advanced.tools) node.advanced.tools = {};
      node.advanced.tools.rules = normalized;
    } else {
      if (node.advanced?.tools) {
        delete node.advanced.tools.rules;
        if (!Object.keys(node.advanced.tools).length) delete node.advanced.tools;
        if (node.advanced && !Object.keys(node.advanced).length) delete node.advanced;
      }
    }
  }

  // 保留旧函数名做兼容
  function getNodeToolRules(node) {
    return getEffectiveToolRules(node);
  }

  function normalizeToolRuleMode(rule) {
    if (rule?.mode === 'disabled' || rule?.mode === 'removed' || rule?.mode === 'enabled') {
      return rule.mode;
    }
    return rule?.enabled === false ? 'disabled' : 'enabled';
  }

  function nextToolRuleMode(mode) {
    if (mode === 'enabled') return 'disabled';
    if (mode === 'disabled') return 'removed';
    return 'enabled';
  }

  function toolRefByName(name) {
    const tool = toolByName(name);
    return tool ? { source: 'feature', featureId: tool.featureId, packageName: tool.packageName, name: tool.name } : { name };
  }

  function writeNodeToolRules(node, rules) {
    writeAdvancedToolRules(node, rules);
  }

  function setNodeToolRule(nodeId, toolName, mode) {
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node) return;
    pushUndo(cloneGraph(state.graph));
    const rules = getNodeToolRules(node);
    const existing = rules.find(rule => rule.name === toolName);
    const nextMode = mode === 'disabled' || mode === 'removed' ? mode : 'enabled';
    if (existing) existing.mode = nextMode;
    else rules.push({ name: toolName, mode: nextMode, ref: toolRefByName(toolName) });
    writeNodeToolRules(node, rules);
    markGraphChanged();
    render();
  }

  function cycleNodeToolRule(nodeId, toolName) {
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node) return;
    pushUndo(cloneGraph(state.graph));
    const rules = getNodeToolRules(node);
    const existing = rules.find(rule => rule.name === toolName);
    const nextMode = nextToolRuleMode(existing ? existing.mode : 'enabled');
    if (existing) existing.mode = nextMode;
    else rules.push({ name: toolName, mode: nextMode, ref: toolRefByName(toolName) });
    writeNodeToolRules(node, rules);
    markGraphChanged();
    render();
  }

  function addNodeToolRule(nodeId, toolName) {
    setNodeToolRule(nodeId, toolName, 'enabled');
  }

  function removeNodeToolRule(nodeId, toolName) {
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node) return;
    pushUndo(cloneGraph(state.graph));
    writeNodeToolRules(node, getNodeToolRules(node).filter(rule => rule.name !== toolName));
    markGraphChanged();
    render();
  }

  function addFeatureTools(nodeId, featureKey) {
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node) return;
    pushUndo(cloneGraph(state.graph));
    const rules = getNodeToolRules(node);
    const names = new Set(rules.map(rule => rule.name));
    (state.capabilities.tools || [])
      .filter(tool => (tool.featureId || tool.featureName || tool.packageName) === featureKey)
      .forEach(tool => {
        if (!names.has(tool.name)) rules.push({ name: tool.name, mode: 'enabled', ref: toolRefByName(tool.name) });
      });
    writeNodeToolRules(node, rules);
    markGraphChanged();
    render();
  }

  function removeFeatureTools(nodeId, featureKey) {
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node) return;
    pushUndo(cloneGraph(state.graph));
    const removeNames = new Set((state.capabilities.tools || [])
      .filter(tool => (tool.featureId || tool.featureName || tool.packageName) === featureKey)
      .map(tool => tool.name));
    writeNodeToolRules(node, getNodeToolRules(node).filter(rule => !removeNames.has(rule.name)));
    markGraphChanged();
    render();
  }

  function openToolPicker() {
    if (!selectedNode()) return;
    state.toolPicker.open = true;
    state.panels.inspector = true;
    render();
  }

  function closeToolPicker() {
    state.toolPicker.open = false;
    render();
  }

  function setToolPickerQuery(value) {
    state.toolPicker.query = String(value || '');
    scheduleRender();
  }

  function addOnEnterTool(nodeId) {
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node) return;
    pushUndo(cloneGraph(state.graph));
    node.onEnter = Array.isArray(node.onEnter) ? node.onEnter : [];
    const firstTool = state.capabilities.tools?.[0] || null;
    node.onEnter.push({
      type: 'tool-call',
      tool: firstTool?.name || '',
      toolRef: firstTool ? { source: 'feature', featureId: firstTool.featureId, packageName: firstTool.packageName, name: firstTool.name } : undefined,
      args: {},
    });
    markGraphChanged();
    render();
  }

  function deleteOnEnterAction(nodeId, index) {
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node || !Array.isArray(node.onEnter)) return;
    pushUndo(cloneGraph(state.graph));
    node.onEnter.splice(index, 1);
    if (!node.onEnter.length) delete node.onEnter;
    markGraphChanged();
    render();
  }

  function addWorkflowVariable(wid) {
    const input = document.querySelector('[data-new-var-for="' + cssEscape(wid) + '"]');
    const key = String(input?.value || '').trim();
    if (!key) return;
    pushUndo(cloneGraph(state.graph));
    const safeKey = key.replace(/[^\w.-]+/g, '_');
    state.graph.workflows[wid] = state.graph.workflows[wid] || { id: wid };
    state.graph.workflows[wid].variables = state.graph.workflows[wid].variables || {};
    if (!(safeKey in state.graph.workflows[wid].variables)) {
      state.graph.workflows[wid].variables[safeKey] = '';
    }
    markGraphChanged();
    render();
  }

  function deleteWorkflowVariable(wid, key) {
    const vars = state.graph?.workflows?.[wid]?.variables;
    if (!vars) return;
    pushUndo(cloneGraph(state.graph));
    delete vars[key];
    markGraphChanged();
    render();
  }

  async function reloadCapabilities() {
    await loadCapabilities();
    render();
  }

  function openPromptEditor(scope, targetId, ruleId) {
    var target = resolvePromptTarget(scope, targetId);
    if (!target) return;
    if (scope === 'node' && isWorkflowHead(target)) return;
    ensurePromptRules(target);
    state.promptDialog.open = true;
    state.promptDialog.scope = scope;
    state.promptDialog.targetId = targetId;
    state.promptDialog.ruleId = ruleId;
    render();
  }

  function closePromptEditor() {
    state.promptDialog.open = false;
    state.promptDialog.scope = 'node';
    state.promptDialog.targetId = '';
    state.promptDialog.ruleId = '';
    state.slashPicker.open = false;
    state.slashPicker.query = '';
    render();
  }

  function updatePromptRuleDraft(scope, targetId, ruleId, value) {
    var target = resolvePromptTarget(scope, targetId);
    if (!target) return;
    var rules = ensurePromptRules(target);
    var rule = rules.find(function (r) { return r.id === ruleId; });
    if (!rule) return;
    rule.template = value || '';
    markGraphChanged();
  }

  function activatePromptSlot(scope, targetId, timing) {
    var target = resolvePromptTarget(scope, targetId);
    if (!target) return;
    var rules = ensurePromptRules(target);
    var existing = rules.find(function (r) { return r.timing === timing; });
    if (existing) {
      openPromptEditor(scope, targetId, existing.id);
      return;
    }
    var newId = 'pr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    var interval = (timing === 'every-n-steps' || timing === 'every-n-calls') ? 3 : undefined;
    rules.push({ id: newId, timing: timing, interval: interval, template: '' });
    markGraphChanged({ rerender: false });
    openPromptEditor(scope, targetId, newId);
  }

  function addPromptRule(scope, targetId) {
    var target = resolvePromptTarget(scope, targetId);
    if (!target) return;
    var rules = ensurePromptRules(target);
    var newId = 'pr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    rules.push({ id: newId, timing: 'on-enter', template: '' });
    markGraphChanged({ rerender: true });
    openPromptEditor(scope, targetId, newId);
  }

  function deletePromptRule(scope, targetId, ruleId) {
    var target = resolvePromptTarget(scope, targetId);
    if (!target) return;
    var rules = ensurePromptRules(target);
    var index = rules.findIndex(function (r) { return r.id === ruleId; });
    if (index >= 0) {
      rules.splice(index, 1);
      markGraphChanged({ rerender: true });
    }
  }

  function selectWorkflow(wid) {
    const component = computeComponents().find(item => item.id === wid);
    if (!component) return;
    state.selectedWorkflowId = wid;
    state.selectedNodeId = component.meta.entry || component.nodes[0]?.id || '';
    state.inspectorTab = 'workflow';
    state.panels.inspector = true;
    markGraphChanged();
    render();
  }

  function toggleAutoWorkflow(wid) {
    if (!state.graph?.workflows?.[wid]) return;
    pushUndo(cloneGraph(state.graph));
    var current = state.graph.workflows[wid].mode || 'agent-initiated';
    var order = ['agent-initiated', 'auto', 'auto-reenterable'];
    var idx = order.indexOf(current);
    var next = order[(idx + 1) % order.length];
    state.graph.workflows[wid].mode = next;
    if (next === 'auto' || next === 'auto-reenterable') {
      Object.keys(state.graph.workflows).forEach(id => {
        if (id !== wid && (state.graph.workflows[id].mode === 'auto' || state.graph.workflows[id].mode === 'auto-reenterable')) {
          state.graph.workflows[id].mode = 'agent-initiated';
        }
      });
    }
    state.selectedWorkflowId = wid;
    markGraphChanged();
    render();
  }

  function newWorkflow() {
    const graph = state.graph || (state.graph = defaultGraph());
    const center = canvasCenterWorld();
    return createWorkflowAt({ x: center.x - NODE_W / 2, y: center.y - NODE_H / 2 });
  }

  function createWorkflowAt(position) {
    const graph = state.graph || (state.graph = defaultGraph());
    const wid = workflowId();
    const node = createNode(position, wid);
    node.type = 'workflow-head';
    node.name = text('新工作流', 'New workflow');
    node.prompt = '';
    graph.nodes.push(node);
    graph.workflows[wid] = {
      id: wid,
      name: node.name,
      description: '',
      mode: 'agent-initiated',
      entry: node.id,
      reminderFrequency: 'every-step',
    };
    normalizeWorkflowMembership(graph);
    state.selectedWorkflowId = wid;
    state.selectedNodeId = node.id;
    state.inspectorTab = 'workflow';
    state.panels.inspector = true;
    render();
  }

  function deleteWorkflow() {
    const component = selectedWorkflow();
    const graph = state.graph;
    if (!graph || !component) return;
    pushUndo(cloneGraph(state.graph));
    if (!window.confirm(text('确认删除当前工作流组件及其中所有节点？', 'Delete the current workflow component and all of its nodes?'))) return;
    const ids = new Set(component.nodes.map(node => node.id));
    graph.nodes = graph.nodes.filter(node => !ids.has(node.id));
    graph.edges = graph.edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to));
    delete graph.workflows[component.id];
    state.selectedNodeId = graph.nodes[0]?.id || '';
    state.selectedWorkflowId = componentForNode(state.selectedNodeId)?.id || '';
    markGraphChanged();
    render();
    return node;
  }

  function addNode() {
    const graph = state.graph || (state.graph = defaultGraph());
    const center = canvasCenterWorld();
    return createNodeAt({ x: center.x - NODE_W / 2, y: center.y - NODE_H / 2 });
  }

  function createNodeAt(position) {
    const graph = state.graph || (state.graph = defaultGraph());
    pushUndo(cloneGraph(state.graph));
    const node = createNode(position, '');
    graph.nodes.push(node);
    state.selectedNodeId = node.id;
    state.selectedWorkflowId = '';
    state.inspectorTab = 'node';
    state.panels.inspector = true;
    markGraphChanged();
    render();
    return node;
  }

  function createNodeFromConnection() {
    const menu = state.connectionMenu;
    const graph = state.graph;
    if (!menu || !graph) return;
    pushUndo(cloneGraph(state.graph));
    const node = createNode({ x: Number(menu.worldX || 0), y: Number(menu.worldY || 0) - NODE_H / 2 }, '');
    graph.nodes.push(node);
    if (canConnect(menu.from, node.id)) graph.edges.push({ from: menu.from, to: node.id });
    state.connectionMenu = null;
    state.selectedNodeId = node.id;
    state.selectedWorkflowId = componentForNode(node.id)?.id || '';
    state.selectedEdgeId = '';
    state.inspectorTab = 'node';
    state.panels.inspector = true;
    markGraphChanged();
    render();
  }

  function createNodeFromCanvasMenu() {
    const menu = state.canvasMenu;
    if (!menu) return;
    state.canvasMenu = null;
    createNodeAt({ x: Number(menu.worldX || 0) - NODE_W / 2, y: Number(menu.worldY || 0) - NODE_H / 2 });
  }

  function createWorkflowFromCanvasMenu() {
    const menu = state.canvasMenu;
    if (!menu) return;
    state.canvasMenu = null;
    createWorkflowAt({ x: Number(menu.worldX || 0) - NODE_W / 2, y: Number(menu.worldY || 0) - NODE_H / 2 });
  }

  function cancelTransientMenus() {
    state.connectionMenu = null;
    state.edgeMenu = null;
    state.canvasMenu = null;
    render();
  }

  function deleteNode(event, nodeId) {
    event?.stopPropagation();
    const graph = state.graph;
    if (!graph) return;
    pushUndo(cloneGraph(state.graph));
    const deletedWorkflowId = componentForNode(nodeId)?.id || '';
    graph.nodes = graph.nodes.filter(node => node.id !== nodeId);
    graph.edges = graph.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
    Object.entries(graph.workflows || {}).forEach(([wid, meta]) => {
      if (meta.entry === nodeId) delete graph.workflows[wid];
    });
    normalizeWorkflowMembership(graph);
    var sibling = graph.nodes.find(function (n) { return componentForNode(n.id)?.id === deletedWorkflowId; });
    state.selectedNodeId = sibling ? sibling.id : '';
    state.selectedWorkflowId = sibling ? deletedWorkflowId : (computeComponents()[0]?.id || '');
    state.selectedEdgeId = '';
    markGraphChanged();
    render();
  }

  function deleteSelected() {
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    if (active && active.isContentEditable) return;
    if (state.promptDialog.open) return;
    if (state.selectedEdgeId) {
      removeEdge(state.selectedEdgeId);
      return;
    }
    if (state.selectedNodeId) {
      deleteNode(null, state.selectedNodeId);
    }
  }

  function selectNode(event, nodeId) {
    event?.stopPropagation();
    if (state.suppressClick?.kind === 'node' && state.suppressClick.id === nodeId && Date.now() < state.suppressClick.until) {
      return;
    }
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    const component = componentForNode(nodeId);
    state.selectedNodeId = nodeId;
    state.selectedWorkflowId = component?.id || '';
    state.selectedEdgeId = '';
    state.inspectorTab = isWorkflowHead(node) ? 'workflow' : 'node';
    state.panels.inspector = true;
    state.toolPicker.open = false;
    render();
  }

  function selectWorkflowFrame(event, wid) {
    event?.stopPropagation?.();
    if (state.suppressClick?.kind === 'workflow' && state.suppressClick.id === wid && Date.now() < state.suppressClick.until) {
      return;
    }
    const component = computeComponents().find(item => item.id === wid);
    if (!component) return;
    state.selectedWorkflowId = component.id;
    state.selectedNodeId = component.head?.id || component.meta.entry || '';
    state.selectedEdgeId = '';
    state.inspectorTab = 'workflow';
    state.panels.inspector = true;
    state.toolPicker.open = false;
    render();
  }

  function setEntry(event, nodeId) {
    event?.stopPropagation();
    const component = componentForNode(nodeId);
    if (!component || !state.graph?.workflows?.[component.id]) return;
    pushUndo(cloneGraph(state.graph));
    state.graph.workflows[component.id].entry = nodeId;
    state.selectedNodeId = nodeId;
    state.selectedWorkflowId = component.id;
    markGraphChanged();
    render();
  }

  function removeEdge(edgeId) {
    const graph = state.graph;
    if (!graph) return;
    pushUndo(cloneGraph(state.graph));
    const [from, to] = String(edgeId || '').split('__');
    graph.edges = graph.edges.filter(edge => !(edge.from === from && edge.to === to));
    state.selectedEdgeId = '';
    markGraphChanged();
    render();
  }

  function selectEdge(event, id) {
    event?.stopPropagation?.();
    if (event?.altKey) {
      removeEdge(id);
      return;
    }
    state.selectedEdgeId = id;
    state.selectedNodeId = '';
    state.selectedWorkflowId = '';
    state.toolPicker.open = false;
    const wrap = document.getElementById('flow-editor-canvas-wrap');
    const rect = wrap?.getBoundingClientRect?.();
    state.edgeMenu = {
      edgeId: id,
      screenX: rect ? event.clientX - rect.left : event.clientX,
      screenY: rect ? event.clientY - rect.top : event.clientY,
    };
    state.connectionMenu = null;
    state.canvasMenu = null;
    render();
  }

  function deleteSelectedEdgeFromMenu() {
    if (!state.edgeMenu?.edgeId) return;
    removeEdge(state.edgeMenu.edgeId);
    state.edgeMenu = null;
  }

  function startNodeDrag(event, nodeId) {
    if (event.button !== 0 || event.target?.closest?.('button')) return;
    event.stopPropagation();
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!node) return;
    state.draggingNode = {
      nodeId,
      startX: event.clientX,
      startY: event.clientY,
      originX: Number(node.position?.x || 0),
      originY: Number(node.position?.y || 0),
      moved: false,
    };
    state.selectedNodeId = nodeId;
    state.selectedWorkflowId = componentForNode(nodeId)?.id || '';
    state.selectedEdgeId = '';
    state.inspectorTab = isWorkflowHead(node) ? 'workflow' : 'node';
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    updateSelectionVisuals();
  }

  function startWorkflowDrag(event, wid) {
    if (event.button !== 0 || event.target?.closest?.('button')) return;
    const component = computeComponents().find(item => item.id === wid);
    if (!component) return;
    event.preventDefault();
    event.stopPropagation();
    state.draggingWorkflow = {
      workflowId: wid,
      startX: event.clientX,
      startY: event.clientY,
      nodeOrigins: component.nodes.map(node => ({
        id: node.id,
        x: Number(node.position?.x || 0),
        y: Number(node.position?.y || 0),
      })),
      frameOrigin: { ...(component.frame || computeWorkflowFrame(component)) },
      moved: false,
    };
    state.selectedWorkflowId = wid;
    state.selectedNodeId = component.head?.id || component.meta.entry || '';
    state.selectedEdgeId = '';
    state.inspectorTab = 'workflow';
    state.toolPicker.open = false;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    updateSelectionVisuals();
  }

  function startWorkflowResize(event, wid, handle) {
    if (event.button !== 0) return;
    const component = computeComponents().find(item => item.id === wid);
    if (!component) return;
    event.preventDefault();
    event.stopPropagation();
    state.resizingWorkflow = {
      workflowId: wid,
      handle,
      startX: event.clientX,
      startY: event.clientY,
      frameOrigin: { ...(component.frame || computeWorkflowFrame(component)) },
      moved: false,
    };
    state.selectedWorkflowId = wid;
    state.selectedNodeId = component.head?.id || component.meta.entry || '';
    state.selectedEdgeId = '';
    state.inspectorTab = 'workflow';
    state.panels.inspector = true;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    updateSelectionVisuals();
  }

  function startConnect(event, nodeId) {
    event.preventDefault();
    event.stopPropagation();
    const node = state.graph?.nodes?.find(item => item.id === nodeId);
    if (!state.graph || !node) return;
    state.connecting = {
      from: nodeId,
      start: {
        x: Number(node.position?.x || 0) + NODE_W,
        y: Number(node.position?.y || 0) + NODE_H / 2,
      },
      current: screenToWorld(event),
    };
    state.selectedNodeId = nodeId;
    state.selectedEdgeId = '';
    state.connectionMenu = null;
    state.edgeMenu = null;
    state.canvasMenu = null;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    render();
  }

  function startCanvasPan(event) {
    if (event.button !== 0) return;
    if (event.target?.closest?.('.flow-editor-node, .flow-editor-workflow-frame, .flow-editor-floating-panel, .flow-editor-toolbar, .flow-editor-edge, .flow-editor-zoom-controls')) return;
    if (!state.graph) return;
    event.preventDefault();
    const v = viewport();
    state.panning = {
      startX: event.clientX,
      startY: event.clientY,
      originX: v.x,
      originY: v.y,
    };
  }

  function handleWheel(event) {
    if (!state.graph) return;
    event.preventDefault();
    const wrap = document.getElementById('flow-editor-canvas-wrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const v = viewport();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    const nextZoom = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const before = {
      x: (event.clientX - rect.left - v.x) / v.zoom,
      y: (event.clientY - rect.top - v.y) / v.zoom,
    };
    v.x = event.clientX - rect.left - before.x * nextZoom;
    v.y = event.clientY - rect.top - before.y * nextZoom;
    v.zoom = nextZoom;
    queueSave();
    scheduleCanvasVisualUpdate();
  }

  function updateCanvasVisuals() {
    const graph = state.graph;
    if (!graph) return;
    const v = viewport();
    const world = document.querySelector('.flow-editor-canvas-world');
    if (world) world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    const byId = new Map((graph.nodes || []).map(node => [node.id, node]));
    (graph.nodes || []).forEach(node => {
      const el = document.querySelector('[data-flow-node-id="' + cssEscape(node.id) + '"]');
      if (!el) return;
      el.style.left = Number(node.position?.x || 0) + 'px';
      el.style.top = Number(node.position?.y || 0) + 'px';
    });
    document.querySelectorAll('.flow-editor-edge[data-edge-from][data-edge-to]').forEach(path => {
      const from = byId.get(path.getAttribute('data-edge-from'));
      const to = byId.get(path.getAttribute('data-edge-to'));
      if (!from || !to) return;
      path.setAttribute('d', bezierPath(
        Number(from.position?.x || 0) + NODE_W,
        Number(from.position?.y || 0) + NODE_H / 2,
        Number(to.position?.x || 0),
        Number(to.position?.y || 0) + NODE_H / 2,
      ));
    });
    computeComponents(graph).forEach(component => {
      const frame = component.frame || computeWorkflowFrame(component);
      const frameEl = document.querySelector('[data-flow-workflow-id="' + cssEscape(component.id) + '"]');
      if (!frameEl) return;
      frameEl.style.left = frame.x + 'px';
      frameEl.style.top = frame.y + 'px';
      frameEl.style.width = frame.width + 'px';
      frameEl.style.height = frame.height + 'px';
    });
    const preview = document.querySelector('[data-connection-preview="1"]');
    if (preview && state.connecting) {
      preview.setAttribute('d', bezierPath(
        state.connecting.start.x,
        state.connecting.start.y,
        state.connecting.current?.x ?? state.connecting.start.x,
        state.connecting.current?.y ?? state.connecting.start.y,
      ));
    }
    const zoomLabel = document.querySelector('[data-flow-zoom-label="1"]');
    if (zoomLabel) zoomLabel.textContent = Math.round(v.zoom * 100) + '%';
  }

  function scheduleCanvasVisualUpdate() {
    if (state.visualUpdateQueued) return;
    state.visualUpdateQueued = true;
    requestAnimationFrame(() => {
      state.visualUpdateQueued = false;
      updateCanvasVisuals();
    });
  }

  function updateSelectionVisuals() {
    document.querySelectorAll('.flow-editor-node.active').forEach(node => node.classList.remove('active'));
    document.querySelectorAll('.flow-editor-workflow-frame.active').forEach(frame => frame.classList.remove('active'));
    document.querySelectorAll('.flow-editor-edge.active').forEach(edge => edge.classList.remove('active'));
    const selected = document.querySelector('[data-flow-node-id="' + cssEscape(state.selectedNodeId) + '"]');
    if (selected) selected.classList.add('active');
    const selectedFrame = document.querySelector('[data-flow-workflow-id="' + cssEscape(state.selectedWorkflowId) + '"]');
    if (selectedFrame) selectedFrame.classList.add('active');
    const selectedEdge = document.querySelector('[data-edge-id="' + cssEscape(state.selectedEdgeId) + '"]');
    if (selectedEdge) selectedEdge.classList.add('active');
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
    return String(value).replace(/"/g, '\\"');
  }

  function zoomBy(factor) {
    const wrap = document.getElementById('flow-editor-canvas-wrap');
    if (!state.graph || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    handleWheel({
      preventDefault() {},
      deltaY: factor > 1 ? -1 : 1,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
  }

  function fitView() {
    const graph = state.graph;
    const wrap = document.getElementById('flow-editor-canvas-wrap');
    if (!graph || !wrap || !graph.nodes.length) return;
    const rect = wrap.getBoundingClientRect();
    const bounds = graph.nodes.reduce((acc, node) => {
      const x = Number(node.position?.x || 0);
      const y = Number(node.position?.y || 0);
      acc.minX = Math.min(acc.minX, x);
      acc.minY = Math.min(acc.minY, y);
      acc.maxX = Math.max(acc.maxX, x + NODE_W);
      acc.maxY = Math.max(acc.maxY, y + NODE_H);
      return acc;
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const padding = 150;
    graph.viewport = {
      zoom: clamp(Math.min(
        rect.width / (bounds.maxX - bounds.minX + padding * 2),
        rect.height / (bounds.maxY - bounds.minY + padding * 2),
      ), MIN_ZOOM, 1.2),
      x: rect.width / 2 - ((bounds.minX + bounds.maxX) / 2),
      y: rect.height / 2 - ((bounds.minY + bounds.maxY) / 2),
    };
    graph.viewport.x = rect.width / 2 - ((bounds.minX + bounds.maxX) / 2) * graph.viewport.zoom;
    graph.viewport.y = rect.height / 2 - ((bounds.minY + bounds.maxY) / 2) * graph.viewport.zoom;
    queueSave();
    render();
  }

  function onPointerMove(event) {
    const graph = state.graph;
    if (!graph) return;
    if (state.draggingWorkflow) {
      const v = viewport();
      const dx = (event.clientX - state.draggingWorkflow.startX) / v.zoom;
      const dy = (event.clientY - state.draggingWorkflow.startY) / v.zoom;
      if (Math.abs(event.clientX - state.draggingWorkflow.startX) + Math.abs(event.clientY - state.draggingWorkflow.startY) > 4) {
        state.draggingWorkflow.moved = true;
      }
      state.draggingWorkflow.nodeOrigins.forEach(origin => {
        const node = graph.nodes.find(item => item.id === origin.id);
        if (node) node.position = { x: origin.x + dx, y: origin.y + dy };
      });
      setWorkflowFrameFast(state.draggingWorkflow.workflowId, {
        x: state.draggingWorkflow.frameOrigin.x + dx,
        y: state.draggingWorkflow.frameOrigin.y + dy,
        width: state.draggingWorkflow.frameOrigin.width,
        height: state.draggingWorkflow.frameOrigin.height,
      });
      scheduleCanvasVisualUpdate();
      return;
    }
    if (state.resizingWorkflow) {
      const v = viewport();
      const dx = (event.clientX - state.resizingWorkflow.startX) / v.zoom;
      const dy = (event.clientY - state.resizingWorkflow.startY) / v.zoom;
      if (Math.abs(event.clientX - state.resizingWorkflow.startX) + Math.abs(event.clientY - state.resizingWorkflow.startY) > 4) {
        state.resizingWorkflow.moved = true;
      }
      const next = { ...state.resizingWorkflow.frameOrigin };
      const handle = state.resizingWorkflow.handle || '';
      if (handle.includes('e')) next.width += dx;
      if (handle.includes('s')) next.height += dy;
      if (handle.includes('w')) {
        next.x += dx;
        next.width -= dx;
      }
      if (handle.includes('n')) {
        next.y += dy;
        next.height -= dy;
      }
      setWorkflowFrameFast(state.resizingWorkflow.workflowId, next);
      scheduleCanvasVisualUpdate();
      return;
    }
    if (state.draggingNode) {
      const node = graph.nodes.find(item => item.id === state.draggingNode.nodeId);
      if (!node) return;
      const v = viewport();
      if (Math.abs(event.clientX - state.draggingNode.startX) + Math.abs(event.clientY - state.draggingNode.startY) > 4) {
        state.draggingNode.moved = true;
      }
      node.position = {
        x: state.draggingNode.originX + (event.clientX - state.draggingNode.startX) / v.zoom,
        y: state.draggingNode.originY + (event.clientY - state.draggingNode.startY) / v.zoom,
      };
      scheduleCanvasVisualUpdate();
      return;
    }
    if (state.panning) {
      const v = viewport();
      v.x = state.panning.originX + event.clientX - state.panning.startX;
      v.y = state.panning.originY + event.clientY - state.panning.startY;
      scheduleCanvasVisualUpdate();
      return;
    }
    if (state.connecting) {
      state.connecting.current = screenToWorld(event);
      scheduleCanvasVisualUpdate();
    }
  }

  function onPointerUp(event) {
    if (state.connecting) {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.flow-editor-node');
      const targetId = target?.getAttribute?.('data-flow-node-id') || '';
      const graph = state.graph;
      if (graph && targetId && targetId !== state.connecting.from) {
        if (canConnect(state.connecting.from, targetId)) {
          pushUndo(cloneGraph(state.graph));
          graph.edges.push({ from: state.connecting.from, to: targetId });
          state.selectedNodeId = targetId;
          state.selectedEdgeId = '';
          markGraphChanged();
          state.selectedWorkflowId = componentForNode(targetId)?.id || '';
        }
      } else if (graph) {
        const wrap = document.getElementById('flow-editor-canvas-wrap');
        const rect = wrap?.getBoundingClientRect?.();
        const worldPoint = state.connecting.current || screenToWorld(event);
        state.connectionMenu = {
          from: state.connecting.from,
          worldX: worldPoint.x,
          worldY: worldPoint.y,
          screenX: rect ? event.clientX - rect.left : event.clientX,
          screenY: rect ? event.clientY - rect.top : event.clientY,
        };
      }
      state.connecting = null;
      render();
    }
    const didMoveNode = !!state.draggingNode?.moved;
    const didMoveWorkflow = !!state.draggingWorkflow?.moved;
    const didResizeWorkflow = !!state.resizingWorkflow?.moved;
    const needsRender = didMoveNode || didMoveWorkflow || didResizeWorkflow;
    if (didMoveNode) {
      state.suppressClick = { kind: 'node', id: state.draggingNode.nodeId, until: Date.now() + 350 };
    }
    if (didMoveWorkflow || didResizeWorkflow) {
      const wid = state.draggingWorkflow?.workflowId || state.resizingWorkflow?.workflowId;
      state.suppressClick = { kind: 'workflow', id: wid, until: Date.now() + 350 };
    }
    if (needsRender && state.graph) {
      normalizeWorkflowMembership(state.graph);
      queueSave();
    }
    state.draggingNode = null;
    state.draggingWorkflow = null;
    state.resizingWorkflow = null;
    if (state.panning) queueSave();
    state.panning = null;
    if (needsRender && !state.connecting) render();
  }

  function onKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.key === 'z' && event.shiftKey))) {
      event.preventDefault();
      redo();
      return;
    }
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    if (active && active.isContentEditable) return;
    if (state.promptDialog.open) return;
    if (active && active.closest && active.closest('.feature-detail-overlay')) return;
    event.preventDefault();
    deleteSelected();
  }

  function clearTransient(event) {
    if (event?.target?.closest?.('.flow-editor-connection-menu')) return;
    if (state.connectionMenu || state.edgeMenu || state.canvasMenu) {
      state.connectionMenu = null;
      state.edgeMenu = null;
      state.canvasMenu = null;
      render();
      return;
    }
    if (state.toolPicker.open && !event?.target?.closest?.('.flow-editor-tool-picker, .flow-editor-floating-panel.right')) {
      state.toolPicker.open = false;
      render();
      return;
    }
    if (event?.target?.closest?.('.flow-editor-node, .flow-editor-workflow-frame, .flow-editor-edge, button, input, textarea, select')) return;
    state.connecting = null;
  }

  function openCanvasMenu(event) {
    const canvas = document.getElementById('flow-editor-canvas-wrap');
    if (!state.graph || !canvas) return;
    if (event.target?.closest?.('.flow-editor-node, .flow-editor-floating-panel, .flow-editor-toolbar, .flow-editor-edge, .flow-editor-zoom-controls, .flow-editor-connection-menu')) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const worldPoint = screenToWorld(event);
    state.canvasMenu = {
      worldX: worldPoint.x,
      worldY: worldPoint.y,
      screenX: event.clientX - rect.left,
      screenY: event.clientY - rect.top,
    };
    state.connectionMenu = null;
    state.edgeMenu = null;
    render();
  }

  function autoLayout() {
    const graph = state.graph;
    if (!graph) return;
    pushUndo(cloneGraph(state.graph));
    const components = computeComponents();
    let yOffset = 130;
    components.forEach(component => {
      if (graph.workflows?.[component.id]) delete graph.workflows[component.id].frame;
      const nodes = component.nodes;
      const indegree = new Map(nodes.map(node => [node.id, 0]));
      component.edges.forEach(edge => indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1));
      const ordered = [];
      const queue = nodes.filter(node => node.id === component.meta.entry || (indegree.get(node.id) || 0) === 0);
      const seen = new Set();
      while (queue.length) {
        const node = queue.shift();
        if (!node || seen.has(node.id)) continue;
        seen.add(node.id);
        ordered.push(node);
        component.edges.filter(edge => edge.from === node.id).forEach(edge => {
          const next = nodes.find(item => item.id === edge.to);
          if (next) queue.push(next);
        });
      }
      nodes.forEach(node => {
        if (!seen.has(node.id)) ordered.push(node);
      });
      ordered.forEach((node, index) => {
        node.position = {
          x: 90 + index * 330,
          y: yOffset + (index % 2) * 140,
        };
      });
      yOffset += 310;
    });
    normalizeWorkflowMembership(graph);
    markGraphChanged();
    fitView();
  }

  async function save() {
    try {
      await saveGraph();
      render();
    } catch (error) {
      console.error('Failed to save graph:', error);
      window.alert(text('保存编排图失败。', 'Failed to save graph.'));
    }
  }

  function setInspectorTab(tab) {
    state.inspectorTab = tab === 'workflow' ? 'workflow' : 'node';
    render();
  }

  function togglePanel(name, force) {
    if (!Object.prototype.hasOwnProperty.call(state.panels, name)) return;
    state.panels[name] = typeof force === 'boolean' ? force : !state.panels[name];
    if (name === 'inspector' && !state.panels[name]) {
      state.toolPicker.open = false;
    }
    render();
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown);

  window.ClawFlowEditor = {
    renderBlock,
    selectWorkflow,
    toggleAutoWorkflow,
    cycleWorkflowMode,
    newWorkflow,
    deleteWorkflow,
    addNode,
    createNodeFromConnection,
    createNodeFromCanvasMenu,
    createWorkflowFromCanvasMenu,
    cancelTransientMenus,
    deleteNode,
    deleteSelected,
    selectNode,
    selectWorkflowFrame,
    setEntry,
    removeEdge,
    selectEdge,
    deleteSelectedEdgeFromMenu,
    clearTransient,
    openCanvasMenu,
    startNodeDrag,
    startWorkflowDrag,
    startWorkflowResize,
    startConnect,
    startCanvasPan,
    handleWheel,
    zoomBy,
    fitView,
    autoLayout,
    handleTextFieldInput,
    commitTextField,
    updateField,
    setNodeToolRule,
    cycleNodeToolRule,
    addNodeToolRule,
    removeNodeToolRule,
    setNodeFeatureMode,
    getNodeFeatureModeChanges,
    getEffectiveToolRules,
    writeAdvancedToolRules,
    addFeatureTools,
    removeFeatureTools,
    openToolPicker,
    closeToolPicker,
    setToolPickerQuery,
    addOnEnterTool,
    deleteOnEnterAction,
    addWorkflowVariable,
    deleteWorkflowVariable,
    reloadCapabilities,
    openNodePromptEditor: function (nodeId) { openPromptEditor('node', nodeId, (ensurePromptRules(state.graph?.nodes?.find(function (n) { return n.id === nodeId; }))[0] || {}).id || ''); },
    closeNodePromptEditor: closePromptEditor,
    openPromptEditor,
    closePromptEditor,
    updateNodePromptDraft: function (nodeId, value) { updatePromptRuleDraft('node', nodeId, state.promptDialog.ruleId, value); },
    updatePromptRuleDraft,
    addPromptRule,
    activatePromptSlot,
    deletePromptRule,
    handlePromptEditorInput,
    handlePromptEditorKeydown,
    clickPromptPickerItem,
    setPickerCategory,
    setPickerSearch,
    undo,
    redo,
    save,
    setInspectorTab,
    togglePanel,
  };

  // Shared prompt editor utilities (used by workspace system prompt dialog in index.html)
  window.PromptEditorUtils = {
    promptToHTML: promptToHTML,
    htmlToPrompt: htmlToPrompt,
    varChipHtml: varChipHtml,
    getPromptCursorOffset: getPromptCursorOffset,
    setPromptCursorOffset: setPromptCursorOffset,
    detectSlashTrigger: detectSlashTrigger,
    findPrevVarChip: findPrevVarChip,
    esc: esc,
    highlightMatch: highlightMatch,
    shortFeatureName: shortFeatureName,
    getCapabilities: function () { return state.capabilities || {}; },
  };
})();
