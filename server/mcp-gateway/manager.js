/**
 * MCP Gateway Manager — centrally hosts MCP server connections for sharing
 * across agent sessions.
 *
 * Each configured upstream server maintains ONE persistent Client connection.
 * Incoming agent requests are served via per-request proxy McpServer instances
 * (stateless, same pattern as debugger-mcp.ts / claw-mcp.js).
 */

import path from 'path';
import { promises as fs } from 'fs';

import { Client, StreamableHTTPClientTransport, SSEClientTransport, fromJsonSchema } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

import { readJsonSafe, ensureDir } from '../shared/fs-helpers.js';
import { MCP_GATEWAY_CONFIG_PATH } from '../shared/constants.js';

// ── Transport factory ─────────────────────────────────────────────

function createUpstreamTransport(config) {
  const transport = (config.transport || 'stdio').toLowerCase();

  if (transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: config.env ? { ...process.env, ...config.env } : undefined,
    });
  }

  if (transport === 'http' || transport === 'streamable-http') {
    return new StreamableHTTPClientTransport(new URL(config.url));
  }

  if (transport === 'sse') {
    return new SSEClientTransport(new URL(config.url));
  }

  throw new Error(`Unknown transport type: ${transport}`);
}

// ── GatewayConnection ─────────────────────────────────────────────

class GatewayConnection {
  constructor(id, config) {
    this.id = id;
    this.config = config;
    this.client = null;
    this.tools = [];
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
    this.error = null;
    this.connectedAt = null;
  }

  async connect() {
    if (this.status === 'connected' || this.status === 'connecting') return;
    this.status = 'connecting';
    this.error = null;

    try {
      this.client = new Client(
        { name: `claw-gateway-${this.id}`, version: '1.0.0' },
        { capabilities: {} }
      );
      const transport = createUpstreamTransport(this.config);
      await this.client.connect(transport);

      const result = await this.client.listTools();
      this.tools = result.tools || [];
      this.status = 'connected';
      this.connectedAt = Date.now();
    } catch (err) {
      this.status = 'error';
      this.error = err.message || String(err);
      if (this.client) {
        await this.client.close().catch(() => {});
        this.client = null;
      }
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
    this.status = 'disconnected';
    this.tools = [];
    this.connectedAt = null;
    this.error = null;
  }

  async restart() {
    await this.disconnect();
    await this.connect();
  }

  getSummary() {
    return {
      id: this.id,
      transport: this.config.transport || 'stdio',
      status: this.status,
      toolCount: this.tools.length,
      toolNames: this.tools.map(t => t.name),
      connectedAt: this.connectedAt,
      lastError: this.error,
    };
  }
}

// ── MCPGatewayManager ─────────────────────────────────────────────

class MCPGatewayManager {
  constructor() {
    this.connections = new Map();
    this.config = { servers: {} };
    this._loaded = false;
  }

  /**
   * Load (or reload) config from disk and reconcile connection entries.
   * Existing connections whose config changed will be reconnected lazily
   * (on next request). Removed entries are disconnected immediately.
   */
  async loadConfig() {
    this.config = await readJsonSafe(MCP_GATEWAY_CONFIG_PATH, { servers: {} });
    this._loaded = true;

    // Remove connections no longer in config
    for (const id of [...this.connections.keys()]) {
      if (!this.config.servers[id]) {
        const conn = this.connections.get(id);
        await conn.disconnect();
        this.connections.delete(id);
      }
    }

    // Add connections for new config entries (lazy — not connected yet)
    for (const [id, serverConfig] of Object.entries(this.config.servers || {})) {
      if (!this.connections.has(id)) {
        this.connections.set(id, new GatewayConnection(id, serverConfig));
      }
    }
  }

  /**
   * Ensure a connection is established. Lazy: only connects on first use.
   */
  async ensureConnection(serverId) {
    if (!this.connections.has(serverId)) {
      throw new Error(`Unknown gateway server: ${serverId}`);
    }
    const conn = this.connections.get(serverId);
    if (conn.status === 'disconnected' || conn.status === 'error') {
      await conn.connect();
    }
    if (conn.status !== 'connected') {
      throw new Error(`Gateway server "${serverId}" unavailable: ${conn.error || conn.status}`);
    }
    return conn;
  }

  /**
   * Handle an incoming MCP HTTP request by proxying to the upstream server.
   * Creates a per-request proxy McpServer (stateless, same pattern as debugger-mcp).
   */
  async handleRequest(serverId, req, res) {
    const conn = await this.ensureConnection(serverId);

    const server = new McpServer({
      name: `claw-gateway-proxy-${serverId}`,
      version: '1.0.0',
    });

    // Register all upstream tools as forwarding proxies
    for (const tool of conn.tools) {
      // Convert raw JSON Schema to Standard Schema for v2 registerTool
      const schema = tool.inputSchema
        ? fromJsonSchema(tool.inputSchema)
        : undefined;

      server.registerTool(tool.name, {
        description: tool.description || `Proxied tool from ${serverId}`,
        ...(schema ? { inputSchema: schema } : {}),
      }, async (args) => {
        const result = await conn.client.callTool({
          name: tool.name,
          arguments: args,
        });
        return result;
      });
    }

    const transport = new NodeStreamableHTTPServerTransport({
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
    } catch (err) {
      console.error(`[MCP Gateway] Error proxying to "${serverId}":`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Gateway proxy error' },
          id: null,
        }));
      }
    } finally {
      if (!res.writableEnded) {
        await close();
      }
    }
  }

  /**
   * Discovery info for agents: includes URL for each server.
   */
  getDiscoveryInfo(origin) {
    return Array.from(this.connections.values()).map(conn => ({
      id: conn.id,
      transport: conn.config.transport || 'stdio',
      status: conn.status,
      toolCount: conn.tools.length,
      url: `${origin}/protoclaw/mcp-gateway/${conn.id}`,
    }));
  }

  /**
   * Management status for UI.
   */
  getStatus() {
    return {
      servers: Array.from(this.connections.values()).map(c => c.getSummary()),
    };
  }

  /**
   * Get raw config (for UI display).
   */
  getConfig() {
    return this.config;
  }

  /**
   * Save new config to disk and reconcile connections.
   */
  async saveConfig(newConfig) {
    const dir = path.dirname(MCP_GATEWAY_CONFIG_PATH);
    await ensureDir(dir);
    await fs.writeFile(MCP_GATEWAY_CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf8');
    await this.loadConfig();
  }

  /**
   * Restart a specific server connection.
   */
  async restartServer(serverId) {
    const conn = this.connections.get(serverId);
    if (!conn) throw new Error(`Unknown gateway server: ${serverId}`);
    await conn.restart();
  }

  /**
   * Connect all configured servers (for eager initialization).
   */
  async connectAll() {
    const promises = [];
    for (const conn of this.connections.values()) {
      if (conn.status === 'disconnected') {
        promises.push(conn.connect());
      }
    }
    await Promise.allSettled(promises);
  }

  /**
   * Cleanup all connections on shutdown.
   */
  async dispose() {
    for (const conn of this.connections.values()) {
      await conn.disconnect();
    }
    this.connections.clear();
  }
}

// Singleton instance for the Claw process
let _instance = null;

export function getGatewayManager() {
  if (!_instance) {
    _instance = new MCPGatewayManager();
  }
  return _instance;
}

export { MCPGatewayManager, GatewayConnection };
