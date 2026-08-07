/**
 * MCP Gateway manager test.
 *
 * Tests the full chain: mock MCP server (stdio) → GatewayManager → HTTP proxy → MCPClient
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// We need to import the manager — use dynamic import for ESM
const { MCPGatewayManager, GatewayConnection } = await import('../server/mcp-gateway/manager.js');

// ── Mock stdio MCP server ────────────────────────────────────────

const MOCK_SERVER_CODE = `
const { stdin, stdout } = process;
let buf = '';
stdin.setEncoding('utf8');
stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(msg) { stdout.write(JSON.stringify(msg) + '\\n'); }

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-gateway-test', version: '1.0.0' },
    }});
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      tools: [{
        name: 'echo',
        description: 'Echoes the input text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }],
    }});
    return;
  }
  if (msg.method === 'tools/call') {
    const args = msg.params?.arguments || {};
    if (msg.params?.name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'Echo: ' + (args.text || '') }],
      }});
    }
    return;
  }
}
`;

const TMP_DIR = join(process.cwd(), '.test-tmp-gateway');
const MOCK_SERVER_PATH = join(TMP_DIR, 'mock-mcp-server.cjs');

let _manager = null;
let _httpServer = null;
let _httpPort = 0;

before(async () => {
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(MOCK_SERVER_PATH, MOCK_SERVER_CODE);

  _manager = new MCPGatewayManager();
  _manager.config = {
    servers: {
      'mock-stdio': {
        transport: 'stdio',
        command: process.execPath,
        args: [MOCK_SERVER_PATH],
      },
    },
  };
  // Manually register connection (bypass file-based config)
  _manager.connections.set('mock-stdio', new GatewayConnection('mock-stdio', {
    transport: 'stdio',
    command: process.execPath,
    args: [MOCK_SERVER_PATH],
  }));

  const conn = _manager.connections.get('mock-stdio');
  await conn.connect();

  await new Promise((resolve) => {
    _httpServer = createServer(async (req, res) => {
      const match = req.url.match(/^\/protoclaw\/mcp-gateway\/([^/]+)$/);
      if (match) {
        await _manager.handleRequest(match[1], req, res);
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });
    _httpServer.listen(0, '127.0.0.1', () => {
      _httpPort = _httpServer.address().port;
      resolve();
    });
  });
});

after(async () => {
  if (_httpServer) await new Promise(r => _httpServer.close(r));
  if (_manager) await _manager.dispose();
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('MCP Gateway Manager', () => {
  it('upstream connection is established', () => {
    const conn = _manager.connections.get('mock-stdio');
    assert.equal(conn.status, 'connected');
    assert.ok(conn.tools.length > 0);
    assert.equal(conn.tools[0].name, 'echo');
  });

  it('agent connects via StreamableHTTP and lists tools', async () => {
    const url = new URL(`http://127.0.0.1:${_httpPort}/protoclaw/mcp-gateway/mock-stdio`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(transport);

    const result = await client.listTools();
    assert.ok(result.tools.length > 0);
    const echoTool = result.tools.find(t => t.name === 'echo');
    assert.ok(echoTool);
    assert.equal(echoTool.description, 'Echoes the input text');

    await client.close();
  });

  it('agent calls tool through gateway proxy', async () => {
    const url = new URL(`http://127.0.0.1:${_httpPort}/protoclaw/mcp-gateway/mock-stdio`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(transport);

    const result = await client.callTool({
      name: 'echo',
      arguments: { text: 'hello gateway' },
    });

    assert.ok(result.content);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'Echo: hello gateway');

    await client.close();
  });

  it('discovery returns server info with URL', () => {
    const discovery = _manager.getDiscoveryInfo();
    // System servers are included by default
    const custom = discovery.filter(d => d.id === 'mock-stdio');
    assert.equal(custom.length, 1);
    assert.ok(custom[0].url.includes('/protoclaw/mcp-gateway/mock-stdio'));
    assert.ok(custom[0].toolCount > 0);
  });

  it('status returns management info', () => {
    const status = _manager.getStatus();
    assert.ok(status.systemServers.length >= 2, 'should have system servers');
    const custom = status.servers.filter(s => s.id === 'mock-stdio');
    assert.equal(custom.length, 1);
    assert.equal(custom[0].status, 'connected');
    assert.ok(custom[0].toolCount > 0);
    assert.ok(custom[0].toolNames.includes('echo'));
  });
});
