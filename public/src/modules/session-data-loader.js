const DEFAULT_DISPLAY_NAMES = {
  run_shell_command: 'Bash', read_file: 'Read File', write_file: 'Write File', list_directory: 'List',
  web_fetch: 'Web', calculator: 'Calc', invoke_skill: 'Invoke Skill', spawn_agent: 'Spawn Agent',
  list_agents: 'List Agents', send_to_agent: 'Send to Agent', close_agent: 'Close Agent',
  read: 'Read', write: 'Write', edit: 'Edit', batch_replace: 'Batch Replace', glob: 'Glob', grep: 'Grep', ls: 'LS',
};

export function createSessionDataLoader(host) {
  let lastTemplateRuntimeId = null;
  async function loadAgentData(agentId) {
    if (host.isUiOnly(agentId)) {
      host.setRuntime(null);
      host.apply({ connected: true });
      host.notify(null);
      host.resetSurface();
      host.render();
      host.renderPanel();
      return;
    }
    const token = host.capture(agentId);
    try {
      host.setRuntime(agentId);
      if (agentId !== lastTemplateRuntimeId) {
        lastTemplateRuntimeId = agentId;
        host.clearTemplates();
        host.loadTemplates().catch((error) => host.warn('[Viewer] Template map reload on switch failed:', error));
      }
      host.refreshBadges();
      host.resetRuntimeStatus();
      host.activateCollapse(agentId);
      host.clearRecap();
      const loadPart = async (name, work) => {
        try { await work(); } catch (error) { host.error(`Failed to load agent ${name}:`, error); }
      };
      const fetchJson = async (endpoint) => {
        const response = await host.fetch(`/api/agents/${agentId}/${endpoint}`);
        if (endpoint === 'todo' && !response.ok) return host.emptyTodo();
        return response.json();
      };
      // Independent producers share one visit token. Body paint never waits for
      // auxiliary panels, tools or detail, and their failures cannot discard it.
      const messages = loadPart('messages', async () => {
        const data = await fetchJson('messages');
        if (!host.isCurrent(token) || !host.messagesCurrent(token)) return;
        host.patch(token, { messages: host.attachTimestamps(data.messages || [], data.timestamps) }, ({ current }) => {
          host.recheckTitle();
          if (current.messages.length > 0) host.clearLoading();
          host.updateRollback();
          host.render(current);
        });
      });
      const tools = loadPart('tools', async () => {
        const payload = await fetchJson('tools');
        const list = Array.isArray(payload) ? payload : [];
        const configs = {};
        const names = {};
        for (const tool of list) {
          configs[tool.name] = tool;
          names[tool.name] = DEFAULT_DISPLAY_NAMES[tool.name] || tool.name;
        }
        host.patch(token, { toolRenderConfigs: configs, toolNames: names }, ({ previous, current }) => {
          if (current.messages.some((message) => message.role === 'tool' || message.toolCalls?.length > 0)
            && JSON.stringify(previous.toolRenderConfigs) !== JSON.stringify(current.toolRenderConfigs)) host.render(current);
          host.warmTemplates(host.templateNames(list), agentId);
        });
      });
      const hooks = loadPart('hooks', async () => {
        const hookInspector = await fetchJson('hooks');
        host.patch(token, { hookInspector }, () => host.renderPanel());
      });
      const overview = loadPart('overview', async () => {
        const data = await fetchJson('overview');
        host.patch(token, { overview: data }, ({ current }) => {
          host.updateContext(current);
          host.updateModel();
          host.updateThinking();
          if (host.activePanel() === 'workspace') host.renderPanel();
        });
      });
      const todo = loadPart('todo', async () => {
        const todoPlan = await fetchJson('todo');
        host.patch(token, { todoPlan }, () => {
          host.updatePlan();
          if (host.activePanel() === 'plan') host.renderPanel();
        });
      });
      const input = loadPart('input requests', async () => {
        const inputRequests = await fetchJson('input-requests');
        host.patch(token, { inputRequests: Array.isArray(inputRequests) ? inputRequests : [] }, () => host.updateRollback());
      });
      const detail = loadPart('workspace detail', () => host.loadDetail(host.focused()));
      const status = loadPart('runtime status', async () => {
        await host.refreshStatus(agentId, token);
        if (!host.isCurrent(token)) return;
        if (host.activePanel() === 'logs') {
          await host.loadLogs(true);
          if (!host.isCurrent(token)) return;
        }
        host.renderPanel();
      });
      await Promise.all([messages, tools, hooks, overview, todo, input, detail, status]);
    } catch (error) {
      host.error('Failed to load agent data:', error);
    }
  }
  return { loadAgentData };
}
