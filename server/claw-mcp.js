/**
 * claw-mcp — MCP Server (thin shell)
 *
 * Routes all MCP tool calls through claw-core provider registry.
 * Tool names match the previous version for backward compatibility.
 *
 * New tool: workspace_list / workspace_help — discover available workspaces.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';

import {
  loadProviders, listProviders, getProvider, getDefaultWorkspaceId,
  dispatch,
  readSessionIndex, getExplorations, getSubs,
  findHandoffSummary, loadSessionDetail, loadFinalOutput,
  cleanText,
} from './claw-core.mjs';

// ── MCP Server ───────────────────────────────────────────────────

export class ClawMCPServer {
  constructor() {}

  async handleRequest(req, res) {
    // Ensure providers are loaded
    await loadProviders();

    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };

    res.on('close', () => { void close(); });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      if (!res.writableEnded) {
        await close();
      }
    }
  }

  createServer() {
    const server = new McpServer(
      { name: 'claw-cli', version: '2.0.0' },
      { capabilities: { logging: {} } }
    );

    this.registerTools(server);
    this.registerResources(server);
    this.registerPrompts(server);
    return server;
  }

  // ── Tool registration ──────────────────────────────────────────

  registerTools(server) {
    const defaultWs = getDefaultWorkspaceId();

    // Helper: wrap dispatch result into MCP content
    const wrap = (result) => ({
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    });
    const wrapError = (errorMsg) => ({
      content: [{ type: 'text', text: JSON.stringify({ error: errorMsg }) }],
      isError: true,
    });

    // --- overview ---
    server.registerTool('overview', {
      title: 'Claw Status Overview',
      description: 'Get an overview of the claw workspace: working directory, exploration count, sub-agent count.',
      inputSchema: z.object({}).optional(),
    }, async () => {
      const { ok, result } = await dispatch(defaultWs, 'overview');
      if (!ok) return wrapError('Failed to get overview');
      return wrap(result);
    });

    // --- workspace_list (NEW) ---
    server.registerTool('workspace_list', {
      title: 'List Workspaces',
      description: 'List all registered workspace providers with their available operations.',
      inputSchema: z.object({}).optional(),
    }, async () => {
      const providers = listProviders();
      const records = providers.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        operations: p.operations.map(op => op.name),
      }));
      return wrap({ total: records.length, workspaces: records });
    });

    // --- list_explorations ---
    server.registerTool('list_explorations', {
      title: 'List Explorations',
      description: 'List exploration records. Supports filtering by file path and keyword, with a limit cap.',
      inputSchema: z.object({
        limit: z.number().default(20).describe('Max records to return (default 20)'),
        file: z.string().optional().describe('Filter: match important files containing this substring'),
        keyword: z.string().optional().describe('Filter: match goal, summary text, or session title'),
      }),
    }, async ({ limit = 20, file: fileFilter, keyword }) => {
      const { ok, result } = await dispatch(defaultWs, 'explorations', { limit, file: fileFilter, keyword });
      if (!ok) return wrapError(result?.error || 'Failed');
      return wrap(result);
    });

    // --- list_sub_agents ---
    server.registerTool('list_sub_agents', {
      title: 'List Sub-agents',
      description: 'List sub-agent conversations derived from exploration records.',
      inputSchema: z.object({}).optional(),
    }, async () => {
      const { ok, result } = await dispatch(defaultWs, 'subs');
      if (!ok) return wrapError(result?.error || 'Failed');
      return wrap(result);
    });

    // --- show ---
    server.registerTool('show', {
      title: 'Show Session Detail',
      description: 'Show detailed information about an exploration record or sub-agent conversation, including the full result or summary.',
      inputSchema: z.object({
        sessionId: z.string().describe('The session ID to inspect'),
      }),
    }, async ({ sessionId }) => {
      const { ok, result } = await dispatch(defaultWs, 'show', { sessionId });
      if (!ok) return wrapError(result?.error || 'Failed');
      if (result.error) return wrapError(result.error);
      return wrap(result);
    });

    // --- spawn ---
    server.registerTool('spawn', {
      title: 'Spawn Exploration or Sub-agent',
      description: 'Spawn a new exploration (no parent context) or sub-agent (from exploration records). For exploration: pass empty explorationIds. For sub-agent: pass one or more exploration IDs as context.',
      inputSchema: z.object({
        goal: z.string().describe('The goal/task for the spawned agent'),
        explorationIds: z.array(z.string()).default([]).describe('Parent exploration IDs (empty = bare exploration spawn)'),
      }),
    }, async ({ goal, explorationIds = [] }) => {
      const params = { goal };
      if (explorationIds.length > 0) params.from = explorationIds.join(',');

      const { ok, result } = await dispatch(defaultWs, 'spawn', params);
      if (!ok) return wrapError(result?.error || 'Failed');
      if (result.error) return wrapError(result.error);
      return wrap(result);
    });

    // --- compact ---
    server.registerTool('compact', {
      title: 'Generate Summary',
      description: 'Generate a summary (compact) for an exploration record. Only explorations can be compacted.',
      inputSchema: z.object({
        sessionId: z.string().describe('The exploration session ID to compact'),
      }),
    }, async ({ sessionId }) => {
      const { ok, result } = await dispatch(defaultWs, 'compact', { sessionId });
      if (!ok) return wrapError(result?.error || 'Failed');
      if (result.error) return wrapError(result.error);
      return wrap(result);
    });

    // --- resume ---
    server.registerTool('resume', {
      title: 'Resume Sub-agent',
      description: 'Resume (append a message to) an existing sub-agent conversation. Only sub-agents can be resumed, not explorations.',
      inputSchema: z.object({
        sessionId: z.string().describe('The sub-agent session ID to resume'),
        message: z.string().describe('The message to append'),
      }),
    }, async ({ sessionId, message }) => {
      const { ok, result } = await dispatch(defaultWs, 'resume', { sessionId, message });
      if (!ok) return wrapError(result?.error || 'Failed');
      if (result.error) return wrapError(result.error);
      return wrap(result);
    });
  }

  // ── Resource registration ──────────────────────────────────────

  registerResources(server) {
    const defaultWs = getDefaultWorkspaceId();

    // claw://explorations
    server.registerResource('explorations', 'claw://explorations', {
      title: 'All Explorations',
      description: 'Complete list of exploration records with metadata.',
      mimeType: 'application/json',
    }, async (uri) => {
      const explorations = getExplorations(defaultWs);
      const records = explorations.map(record => {
        const handoff = findHandoffSummary(defaultWs, record.id);
        return {
          id: record.id,
          goal: cleanText(record.goal) || '(no goal)',
          status: record.status === 'locked' ? 'locked' : 'running',
          domains: Array.isArray(record.domains) ? record.domains : [],
          hasSummary: !!handoff?.summaryText,
          sessionTitle: handoff?.sessionTitle || null,
          timestamp: handoff?.sessionTimestamp || record.updatedAt || record.createdAt,
        };
      });
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(records, null, 2),
        }],
      };
    });

    // claw://sub-agents
    server.registerResource('sub-agents', 'claw://sub-agents', {
      title: 'All Sub-agents',
      description: 'Complete list of sub-agent conversations.',
      mimeType: 'application/json',
    }, async (uri) => {
      const subs = getSubs(defaultWs);
      const records = subs.map(record => ({
        id: record.id,
        goal: cleanText(record.goal) || '(no goal)',
        domains: Array.isArray(record.domains) ? record.domains : [],
        sourceExplorationIds: Array.isArray(record.metadata?.sourceExplorationIds)
          ? record.metadata.sourceExplorationIds : [],
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }));
      return {
        contents: [{
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(records, null, 2),
        }],
      };
    });

    // claw://sessions/{sessionId}
    server.registerResource(
      'session-detail',
      new ResourceTemplate('claw://sessions/{sessionId}', { list: undefined }),
      {
        title: 'Session Detail',
        description: 'Detailed view of a session by ID.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const sessionId = typeof variables.sessionId === 'string'
          ? variables.sessionId
          : (Array.isArray(variables.sessionId) ? variables.sessionId[0] : String(variables.sessionId || ''));

        const index = readSessionIndex(defaultWs);
        const record = index.sessions.find(s => s.id === sessionId);
        if (!record) {
          return {
            contents: [{
              uri: uri.toString(),
              mimeType: 'application/json',
              text: JSON.stringify({ error: `Session not found: ${sessionId}` }),
            }],
          };
        }

        const sessionType = cleanText(record.sessionType);
        const isExploration = sessionType === 'exploration' || record.metadata?.clean === true;
        const detail = loadSessionDetail(defaultWs, sessionId);
        const goal = cleanText(record.goal) || '(no goal)';

        let result = {};
        if (isExploration) {
          const handoff = findHandoffSummary(defaultWs, sessionId);
          result = {
            type: 'exploration', id: sessionId, goal,
            status: record.status === 'locked' ? 'locked' : 'running',
            domains: Array.isArray(record.domains) ? record.domains : [],
            summary: handoff?.summaryText || null,
            importantFiles: handoff?.importantFiles || [],
            sessionTitle: handoff?.sessionTitle || null,
            gitMeta: handoff?.gitMeta || null,
            messageCount: detail?.messageCount || 0,
          };
        } else {
          result = {
            type: 'sub-agent', id: sessionId, goal,
            sourceExplorationIds: Array.isArray(record.metadata?.sourceExplorationIds)
              ? record.metadata.sourceExplorationIds : [],
            domains: Array.isArray(record.domains) ? record.domains : [],
            messageCount: detail?.messageCount || 0,
            finalOutput: loadFinalOutput(defaultWs, sessionId),
          };
        }

        return {
          contents: [{
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }
    );
  }

  // ── Prompt registration ────────────────────────────────────────

  registerPrompts(server) {
    server.registerPrompt('explore_codebase', {
      title: 'Explore Codebase',
      description: 'Start an exploration to understand a specific part of the codebase. Best practice: first check existing explorations, then spawn only if no relevant record exists.',
    }, async () => {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I need to explore the codebase. First, use the "list_explorations" tool to check if there are already relevant exploration records. If you find one that matches, use "show" to read its results. If none is relevant, use "spawn" to start a new exploration with a clear, modular goal. After the exploration completes, use "compact" to generate a summary for future reference.`,
          },
        }],
      };
    });

    server.registerPrompt('delegate_task', {
      title: 'Delegate Task to Sub-agent',
      description: 'Delegate a task to a sub-agent using existing exploration records as context. The sub-agent will have access to the full conversation history of the referenced explorations.',
    }, async () => {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I need to delegate a task to a sub-agent. First, use "list_explorations" to find relevant exploration records that provide context. Then use "spawn" with the relevant explorationIds and a clear goal. Use "show" to check the sub-agent's results when done. If the results are insufficient, use "resume" to continue the conversation.`,
          },
        }],
      };
    });
  }
}
