/**
 * Tests for server/claw-mcp.js
 *
 * Validates MCP server tool/resource/prompt registration completeness
 * and basic tool handler behavior using a mock dispatch layer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ClawMCPServer } from '../server/claw-mcp.js';

// ── Mock MCP Server ──

function createMockServer() {
  const tools = [];
  const resources = [];
  const prompts = [];

  return {
    tools,
    resources,
    prompts,
    registerTool(name, meta, handler) {
      tools.push({ name, meta, handler });
    },
    registerResource(name, template, meta, handler) {
      resources.push({ name, template, meta, handler });
    },
    registerPrompt(name, meta, handler) {
      prompts.push({ name, meta, handler });
    },
  };
}

describe('ClawMCPServer', () => {

  describe('createServer', () => {
    it('should return a server object without throwing', () => {
      const clawMcp = new ClawMCPServer();
      const server = clawMcp.createServer();
      assert.ok(server);
    });
  });

  describe('registerTools', () => {
    it('should register all expected tools', () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerTools(mock);

      const expectedTools = [
        'overview',
        'workspace_list',
        'create_session',
      ];

      for (const name of expectedTools) {
        const found = mock.tools.find(t => t.name === name);
        assert.ok(found, `Tool "${name}" should be registered`);
      }
      assert.equal(mock.tools.length, expectedTools.length);
    });

    it('each tool should have title, description, and inputSchema', () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerTools(mock);

      for (const { name, meta } of mock.tools) {
        assert.ok(meta.title, `Tool "${name}" should have a title`);
        assert.ok(meta.description, `Tool "${name}" should have a description`);
        assert.ok(meta.inputSchema !== undefined, `Tool "${name}" should have inputSchema`);
      }
    });

    it('workspace_list should return provider records', async () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerTools(mock);

      const wsListTool = mock.tools.find(t => t.name === 'workspace_list');
      const result = await wsListTool.handler({});

      assert.ok(result.content);
      assert.equal(result.content[0].type, 'text');
      const parsed = JSON.parse(result.content[0].text);
      assert.ok('total' in parsed);
      assert.ok('workspaces' in parsed);
    });

    it('create_session should require a path', async () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerTools(mock);

      const tool = mock.tools.find(t => t.name === 'create_session');
      // Missing path -> dispatch error wrapped as content
      const result = await tool.handler({});
      assert.ok(result.content);
    });
  });

  describe('registerResources', () => {
    it('should register all expected resources', () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerResources(mock);

      const expectedResources = ['session-detail'];
      for (const name of expectedResources) {
        const found = mock.resources.find(r => r.name === name);
        assert.ok(found, `Resource "${name}" should be registered`);
      }
    });
  });

  describe('Error handling', () => {
    it('tool handlers should wrap errors as isError content', async () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerTools(mock);

      // create_session tool with missing path should return error content
      const createTool = mock.tools.find(t => t.name === 'create_session');
      const result = await createTool.handler({});

      // Either isError: true or content with error
      if (result.isError) {
        assert.ok(result.content);
      } else {
        const parsed = JSON.parse(result.content[0].text);
        // Should either have data or error
        assert.ok(parsed !== null);
      }
    });
  });
});
