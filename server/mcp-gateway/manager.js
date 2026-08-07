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
import { MCP_GATEWAY_CONFIG_PATH, APP_ORIGIN, VIEWER_ORIGIN } from '../shared/constants.js';

// ── System MCP servers (always available, not proxied) ───────────

const SYSTEM_MCP_SERVERS = [
  {
    id: 'claw-mcp',
    name: 'Claw MCP',
    getUrl: () => `${APP_ORIGIN}/protoclaw/claw-mcp`,
    transport: 'http',
  },
  {
    id: 'debugger-mcp',
    name: 'Debugger MCP',
    getUrl: () => `${VIEWER_ORIGIN}/mcp`,
    transport: 'http',
  },
];

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
      const client = new Client(
        { name: `claw-gateway-${this.id}`, version: '1.0.0' },
      );
      const transport = createUpstreamTransport(this.config);
      await client.connect(transport);

      // Wire up transport lifecycle — if upstream drops, mark as error
      // so ensureConnection will reconnect on next request.
      transport.onclose = () => {
        if (this.status === 'connected') {
          this.status = 'disconnected';
          this.client = null;
          this.tools = [];
        }
      };
      transport.onerror = (err) => {
        console.error(`[MCP Gateway] Transport error for "${this.id}":`, err?.message || err);
      };

      const result = await client.listTools();
      this.tools = result.tools || [];
      this.client = client;
      this.status = 'connected';
      this.connectedAt = Date.now();
    } catch (err) {
      this.status = 'error';
      this.error = err.message || String(err);
      this.tools = [];
      this.client = null;
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
    this.config = { servers: {}, systemServers: {} };
    this._loaded = false;
  }

  /**
   * Load (or reload) config from disk and reconcile connection entries.
   */
  async loadConfig() {
    const loaded = await readJsonSafe(MCP_GATEWAY_CONFIG_PATH, { servers: {}, systemServers: {} });
    this.config = {
      servers: loaded.servers || {},
      systemServers: loaded.systemServers || {},
    };
    this._loaded = true;

    // Ensure all system servers have an entry (default enabled)
    for (const sys of SYSTEM_MCP_SERVERS) {
      if (this.config.systemServers[sys.id] === undefined) {
        this.config.systemServers[sys.id] = { enabled: true };
      }
    }

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
    // Reconnect if disconnected or errored (lazy reconnect)
    if (conn.status === 'disconnected' || conn.status === 'error' || !conn.client) {
      await conn.connect();
    }
    if (conn.status !== 'connected' || !conn.client) {
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

    if (!conn.client) {
      throw new Error(`Gateway server "${serverId}" has no active client connection`);
    }

    const proxyClient = conn.client;
    const proxyTools = [...conn.tools];

    const server = new McpServer({
      name: `claw-gateway-proxy-${serverId}`,
      version: '1.0.0',
    });

    // Register all upstream tools as forwarding proxies
    for (const tool of proxyTools) {
      // Convert raw JSON Schema to Standard Schema for v2 registerTool
      const schema = tool.inputSchema
        ? fromJsonSchema(tool.inputSchema)
        : undefined;

      server.registerTool(tool.name, {
        description: tool.description || `Proxied tool from ${serverId}`,
        ...(schema ? { inputSchema: schema } : {}),
      }, async (args) => {
        const result = await proxyClient.callTool({
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
   * Discovery info for agents: includes both system MCP servers (direct HTTP)
   * and custom proxied servers.
   */
  getDiscoveryInfo() {
    const result = [];

    // System MCP servers — always available if enabled, agents connect directly
    for (const sys of SYSTEM_MCP_SERVERS) {
      const enabled = this.config.systemServers?.[sys.id]?.enabled !== false;
      if (!enabled) continue;
      result.push({
        id: sys.id,
        transport: sys.transport,
        status: 'connected',
        toolCount: 1, // Non-zero so agent discovery filter passes
        url: sys.getUrl(),
      });
    }

    // Custom proxied servers — only if connected with tools
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected' && conn.tools.length > 0) {
        result.push({
          id: conn.id,
          transport: conn.config.transport || 'stdio',
          status: conn.status,
          toolCount: conn.tools.length,
          url: `${APP_ORIGIN}/protoclaw/mcp-gateway/${conn.id}`,
        });
      }
    }

    return result;
  }

  /**
   * Management status for UI.
   */
  getStatus() {
    const systemServers = SYSTEM_MCP_SERVERS.map(sys => ({
      id: sys.id,
      name: sys.name,
      transport: sys.transport,
      status: 'connected',
      toolCount: 0,
      toolNames: [],
      enabled: this.config.systemServers?.[sys.id]?.enabled !== false,
      url: sys.getUrl(),
      isSystem: true,
    }));

    const customServers = Array.from(this.connections.values()).map(c => ({
      ...c.getSummary(),
      isSystem: false,
    }));

    return { systemServers, servers: customServers };
  }

  // ── System MCP tool cache (avoids repeated one-shot connections) ──

  _systemToolCache = new Map(); // id → { tools, fetchedAt }
  static SYSTEM_CACHE_TTL = 30000; // 30s

  /**
   * One-shot connect to a system MCP endpoint and list tools.
   * Results are cached for 30s.
   */
  async _fetchSystemTools(sysId) {
    const cached = this._systemToolCache.get(sysId);
    if (cached && Date.now() - cached.fetchedAt < MCPGatewayManager.SYSTEM_CACHE_TTL) {
      return cached.tools;
    }

    const sys = SYSTEM_MCP_SERVERS.find(s => s.id === sysId);
    if (!sys) return [];

    try {
      const client = new Client(
        { name: `claw-gateway-probe-${sysId}`, version: '1.0.0' },
      );
      const transport = new StreamableHTTPClientTransport(new URL(sys.getUrl()));
      await client.connect(transport);
      const result = await client.listTools();
      await client.close().catch(() => {});
      const tools = (result.tools || []).map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema,
      }));
      this._systemToolCache.set(sysId, { tools, fetchedAt: Date.now() });
      return tools;
    } catch (err) {
      return [];
    }
  }

  /**
   * Get detailed info for a specific server (system or custom).
   */
  async getServerDetail(serverId) {
    // System MCP server
    const sys = SYSTEM_MCP_SERVERS.find(s => s.id === serverId);
    if (sys) {
      const tools = await this._fetchSystemTools(serverId);
      return {
        id: serverId,
        name: sys.name,
        isSystem: true,
        transport: sys.transport,
        url: sys.getUrl(),
        status: 'connected',
        enabled: this.config.systemServers?.[serverId]?.enabled !== false,
        connectedAt: null,
        lastError: null,
        tools,
      };
    }

    // Custom server
    const conn = this.connections.get(serverId);
    if (!conn) return null;

    return {
      id: serverId,
      name: serverId,
      isSystem: false,
      transport: conn.config.transport || 'stdio',
      config: conn.config,
      status: conn.status,
      connectedAt: conn.connectedAt,
      lastError: conn.error,
      tools: conn.tools.map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema,
      })),
    };
  }

  /**
   * Toggle a system MCP server's enabled state.
   */
  async toggleSystemServer(serverId, enabled) {
    if (!this.config.systemServers) this.config.systemServers = {};
    this.config.systemServers[serverId] = { enabled };
    await this._persistConfig();
  }

  /**
   * Get raw config (for UI display).
   */
  getConfig() {
    return this.config;
  }

  /**
   * Write current config to disk.
   */
  async _persistConfig() {
    const dir = path.dirname(MCP_GATEWAY_CONFIG_PATH);
    await ensureDir(dir);
    await fs.writeFile(MCP_GATEWAY_CONFIG_PATH, JSON.stringify(this.config, null, 2), 'utf8');
  }

  /**
   * Save new config to disk and reconcile connections.
   */
  async saveConfig(newConfig) {
    // Preserve systemServers if not provided
    if (!newConfig.systemServers && this.config.systemServers) {
      newConfig.systemServers = this.config.systemServers;
    }

    // Detect which servers changed (new or modified) to trigger immediate reconnect
    const prevConfig = this.config.servers || {};
    const nextConfig = newConfig.servers || {};
    const changedIds = [];
    for (const id of Object.keys(nextConfig)) {
      if (!prevConfig[id] || JSON.stringify(prevConfig[id]) !== JSON.stringify(nextConfig[id])) {
        changedIds.push(id);
      }
    }

    this.config = {
      servers: nextConfig,
      systemServers: newConfig.systemServers || {},
    };
    // Ensure all system servers have an entry
    for (const sys of SYSTEM_MCP_SERVERS) {
      if (this.config.systemServers[sys.id] === undefined) {
        this.config.systemServers[sys.id] = { enabled: true };
      }
    }
    await this._persistConfig();
    // Reconcile connections (read back and sync — disconnects removed, creates new entries)
    await this.loadConfig();
    // Eagerly connect all servers, especially new/changed ones
    void this.connectAll();
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
