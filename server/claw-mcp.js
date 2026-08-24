/**
 * claw-mcp — MCP Server (thin shell)
 *
 * Routes all MCP tool calls through claw-core provider registry.
 * Tool names match the previous version for backward compatibility.
 *
 * New tool: workspace_list / workspace_help — discover available workspaces.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod/v4';

import {
  loadProviders, listProviders, getDefaultWorkspaceId,
  dispatch,
  readSessionIndex,
  loadSessionDetail,
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
      description: 'Get an overview of the claw workspace: working directory.',
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

    // --- create_session ---
    server.registerTool('create_session', {
      title: 'Create New Session',
      description: 'Create a new programming-helper session for a given project path. The session will be created and the runtime will be started automatically.',
      inputSchema: z.object({
        path: z.string().describe('The project directory path for the new session'),
      }),
    }, async ({ path }) => {
      const { ok, result } = await dispatch(defaultWs, 'create_session', { path });
      if (!ok) return wrapError(result?.error || 'Failed');
      if (result.error) return wrapError(result.error);
      return wrap(result);
    });
  }

  // ── Resource registration ──────────────────────────────────────

  registerResources(server) {
    const defaultWs = getDefaultWorkspaceId();

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

        const detail = loadSessionDetail(defaultWs, sessionId);
        const result = {
          type: 'session',
          id: sessionId,
          title: record.title || null,
          sessionType: cleanText(record.sessionType) || 'main',
          openDirectory: record.openDirectory || '',
          messageCount: detail?.messageCount || 0,
          lastMessage: detail?.lastMessage || '',
        };

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
}
