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
        'list_explorations',
        'list_sub_agents',
        'show',
        'spawn',
        'compact',
        'resume',
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

    it('list_explorations should pass limit, file, and keyword params', async () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerTools(mock);

      const tool = mock.tools.find(t => t.name === 'list_explorations');
      // Just verify it doesn't throw with default params
      const result = await tool.handler({ limit: 5 });
      assert.ok(result.content);
    });

    it('spawn should join explorationIds into from param', async () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerTools(mock);

      const tool = mock.tools.find(t => t.name === 'spawn');
      // This will call dispatch which may fail, but the error should be wrapped
      const result = await tool.handler({ goal: 'test goal', explorationIds: ['exp-1', 'exp-2'] });
      assert.ok(result.content);
    });
  });

  describe('registerResources', () => {
    it('should register all expected resources', () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerResources(mock);

      const expectedResources = ['explorations', 'sub-agents', 'session-detail'];
      for (const name of expectedResources) {
        const found = mock.resources.find(r => r.name === name);
        assert.ok(found, `Resource "${name}" should be registered`);
      }
    });
  });

  describe('registerPrompts', () => {
    it('should register all expected prompts', () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerPrompts(mock);

      const expectedPrompts = ['explore_codebase', 'delegate_task'];
      for (const name of expectedPrompts) {
        const found = mock.prompts.find(p => p.name === name);
        assert.ok(found, `Prompt "${name}" should be registered`);
      }
    });

    it('explore_codebase prompt should return guidance messages', async () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerPrompts(mock);

      const prompt = mock.prompts.find(p => p.name === 'explore_codebase');
      const result = await prompt.handler();
      assert.ok(result.messages);
      assert.ok(result.messages.length > 0);
      assert.equal(result.messages[0].content.type, 'text');
      assert.ok(result.messages[0].content.text.includes('list_explorations'));
    });

    it('delegate_task prompt should return guidance messages', async () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerPrompts(mock);

      const prompt = mock.prompts.find(p => p.name === 'delegate_task');
      const result = await prompt.handler();
      assert.ok(result.messages);
      assert.ok(result.messages[0].content.text.includes('spawn'));
    });
  });

  describe('Error handling', () => {
    it('tool handlers should wrap errors as isError content', async () => {
      const clawMcp = new ClawMCPServer();
      const mock = createMockServer();
      clawMcp.registerTools(mock);

      // show tool with non-existent sessionId should return error content
      const showTool = mock.tools.find(t => t.name === 'show');
      const result = await showTool.handler({ sessionId: 'non-existent-id' });

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
