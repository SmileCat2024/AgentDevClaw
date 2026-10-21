// Workspace-local Agent IDs select an assembly, not an OS address or sessionType.
function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'invalid_workspace_agent';
  return error;
}

export function normalizeWorkspaceAgents(metadata = {}) {
  if (metadata.agents === undefined) {
    if (metadata.defaultAgentId !== undefined && metadata.defaultAgentId !== 'main') {
      throw invalid('metadata.defaultAgentId requires a declared Agent');
    }
    return {
      agents: [{ id: 'main', displayName: metadata.name || metadata.id || 'Agent' }],
      defaultAgentId: 'main',
    };
  }
  if (!Array.isArray(metadata.agents) || metadata.agents.length === 0) {
    throw invalid('metadata.agents must be a non-empty array');
  }
  const ids = new Set();
  const agents = metadata.agents.map((agent) => {
    const id = typeof agent?.id === 'string' ? agent.id.trim() : '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || ids.has(id)) {
      throw invalid(`Invalid or duplicate workspace Agent ID: ${id}`);
    }
    const name = agent.displayName;
    const validName = typeof name === 'string' ? Boolean(name.trim())
      : name && typeof name === 'object' && !Array.isArray(name)
        && Object.keys(name).length > 0
        && Object.values(name).every((value) => typeof value === 'string' && value.trim());
    if (!validName) throw invalid(`Agent ${id} requires displayName`);
    ids.add(id);
    return { id, displayName: typeof name === 'string' ? name.trim() : { ...name } };
  });
  const defaultAgentId = metadata.defaultAgentId === undefined && agents.length === 1
    ? agents[0].id : metadata.defaultAgentId;
  if (typeof defaultAgentId !== 'string' || !ids.has(defaultAgentId)) {
    throw invalid('metadata.defaultAgentId must identify a declared Agent');
  }
  return { agents, defaultAgentId };
}

export function resolveWorkspaceAgent(metadata, workspaceAgentId) {
  const catalog = normalizeWorkspaceAgents(metadata);
  const id = workspaceAgentId === undefined ? catalog.defaultAgentId : workspaceAgentId;
  const agent = catalog.agents.find((entry) => entry.id === id);
  if (!agent) throw invalid(`Unknown workspace Agent: ${String(id)}`);
  return agent;
}

export function resolveNewSessionAgent(metadata, options = {}, sourceSession = null) {
  if (sourceSession) {
    const inherited = sourceSession.workspaceAgentId === undefined ? 'main' : sourceSession.workspaceAgentId;
    if (options.workspaceAgentId !== undefined && options.workspaceAgentId !== inherited) {
      throw invalid('A derived session must retain its source Agent');
    }
    return resolveWorkspaceAgent(metadata, inherited).id;
  }
  return resolveWorkspaceAgent(metadata, options.workspaceAgentId).id;
}

export function workspaceAgentDisplayName(agent, language = 'zh') {
  const value = agent.displayName;
  return typeof value === 'string' ? value : (value[language] || value.zh || value.en || Object.values(value)[0]);
}

// Existing prebuilt modules may export their sole Agent class by name only.
function resolveLegacyMainClass(agentModule) {
  const classes = Object.values(agentModule).filter((value) => typeof value === 'function');
  return classes.length === 1 ? classes[0] : null;
}

export function resolveWorkspaceAgentClass(agentModule, workspaceAgentId) {
  const declared = agentModule.agents;
  const AgentClass = declared && Object.hasOwn(declared, workspaceAgentId)
    ? declared[workspaceAgentId]
    : workspaceAgentId === 'main' ? (agentModule.default || resolveLegacyMainClass(agentModule)) : null;
  if (typeof AgentClass !== 'function') {
    throw invalid(`Missing Agent assembly export for ${workspaceAgentId}`);
  }
  return AgentClass;
}
