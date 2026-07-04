import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderConversationHtml,
  groupByTurn,
  parseToolResult,
  escapeHtml,
  getToolDisplayName,
  buildToolCallIndex,
  formatToolError,
  TOOL_DISPLAY_NAMES,
} from '../server/conversation-renderer.js';

describe('conversation-renderer', () => {

  // ── escapeHtml (XSS defense) ──────────────────────────────

  describe('escapeHtml', () => {
    it('escapes ampersand', () => {
      assert.equal(escapeHtml('a&b'), 'a&amp;b');
    });
    it('escapes less-than', () => {
      assert.equal(escapeHtml('a<b'), 'a&lt;b');
    });
    it('escapes greater-than', () => {
      assert.equal(escapeHtml('a>b'), 'a&gt;b');
    });
    it('escapes double quotes', () => {
      assert.equal(escapeHtml('a"b'), 'a&quot;b');
    });
    it('escapes single quotes', () => {
      assert.equal(escapeHtml("a'b"), 'a&#39;b');
    });
    it('escapes all special chars in one string', () => {
      assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });
    it('returns empty string for null/undefined', () => {
      assert.equal(escapeHtml(null), '');
      assert.equal(escapeHtml(undefined), '');
    });
    it('coerces non-strings to string then escapes', () => {
      assert.equal(escapeHtml(42), '42');
    });
    it('handles already-escaped content (double-escape)', () => {
      // & should be escaped again — this is correct behavior for XSS prevention
      assert.equal(escapeHtml('a&amp;b'), 'a&amp;amp;b');
    });
  });

  // ── parseToolResult ───────────────────────────────────────

  describe('parseToolResult', () => {
    it('parses JSON with success and result fields', () => {
      const result = parseToolResult('{"success":true,"result":"hello"}');
      assert.deepEqual(result, { success: true, data: 'hello' });
    });

    it('parses JSON with result as object', () => {
      const result = parseToolResult('{"success":true,"result":{"key":"val"}}');
      assert.deepEqual(result, { success: true, data: { key: 'val' } });
    });

    it('parses result string that is itself JSON', () => {
      const result = parseToolResult('{"success":true,"result":"{\\"nested\\":true}"}');
      assert.deepEqual(result, { success: true, data: { nested: true } });
    });

    it('returns success:true with raw content for non-JSON', () => {
      const result = parseToolResult('plain text');
      assert.deepEqual(result, { success: true, data: 'plain text' });
    });

    it('returns success:true with raw content for JSON without success/result', () => {
      const result = parseToolResult('{"foo":"bar"}');
      assert.deepEqual(result, { success: true, data: '{"foo":"bar"}' });
    });

    it('handles failed result', () => {
      const result = parseToolResult('{"success":false,"result":"error message"}');
      assert.deepEqual(result, { success: false, data: 'error message' });
    });
  });

  // ── getToolDisplayName ────────────────────────────────────

  describe('getToolDisplayName', () => {
    it('returns mapped name for known tools', () => {
      assert.equal(getToolDisplayName('read'), 'Read');
      assert.equal(getToolDisplayName('write'), 'Write');
      assert.equal(getToolDisplayName('bash'), 'Bash');
      assert.equal(getToolDisplayName('grep'), 'Grep');
      assert.equal(getToolDisplayName('task_create'), 'Task Create');
    });

    it('returns raw name for unknown tools', () => {
      assert.equal(getToolDisplayName('custom_tool'), 'custom_tool');
    });

    it('returns Unknown for empty/null name', () => {
      assert.equal(getToolDisplayName(''), 'Unknown');
      assert.equal(getToolDisplayName(null), 'Unknown');
      assert.equal(getToolDisplayName(undefined), 'Unknown');
    });
  });

  // ── buildToolCallIndex ────────────────────────────────────

  describe('buildToolCallIndex', () => {
    it('builds index from toolCalls in messages', () => {
      const messages = [
        { role: 'assistant', toolCalls: [
          { id: 'tc1', name: 'read', arguments: { filePath: 'a.js' } },
          { id: 'tc2', name: 'write', arguments: { filePath: 'b.js' } },
        ]},
      ];
      const index = buildToolCallIndex(messages);
      assert.equal(index.size, 2);
      assert.deepEqual(index.get('tc1'), { name: 'read', arguments: { filePath: 'a.js' } });
      assert.deepEqual(index.get('tc2'), { name: 'write', arguments: { filePath: 'b.js' } });
    });

    it('returns empty Map for messages without toolCalls', () => {
      const index = buildToolCallIndex([{ role: 'user', content: 'hello' }]);
      assert.equal(index.size, 0);
    });

    it('handles multiple messages with toolCalls', () => {
      const messages = [
        { role: 'assistant', toolCalls: [{ id: 'tc1', name: 'read', arguments: {} }] },
        { role: 'assistant', toolCalls: [{ id: 'tc2', name: 'grep', arguments: {} }] },
      ];
      const index = buildToolCallIndex(messages);
      assert.equal(index.size, 2);
    });
  });

  // ── formatToolError ───────────────────────────────────────

  describe('formatToolError', () => {
    it('wraps error text in tool-error div', () => {
      const html = formatToolError('some error');
      assert.ok(html.includes('class="tool-error"'));
      assert.ok(html.includes('some error'));
    });

    it('stringifies objects', () => {
      const html = formatToolError({ code: 500, msg: 'fail' });
      assert.ok(html.includes('500'));
      assert.ok(html.includes('fail'));
    });

    it('escapes HTML in error text', () => {
      const html = formatToolError('<script>alert(1)</script>');
      assert.ok(!html.includes('<script>'));
      assert.ok(html.includes('&lt;script&gt;'));
    });
  });

  // ── groupByTurn ───────────────────────────────────────────

  describe('groupByTurn', () => {
    it('groups messages by turn field', () => {
      const messages = [
        { role: 'user', content: 'a', turn: 0 },
        { role: 'assistant', content: 'b', turn: 0 },
        { role: 'user', content: 'c', turn: 1 },
      ];
      const groups = groupByTurn(messages);
      assert.equal(groups.length, 2);
      assert.equal(groups[0].turn, 0);
      assert.equal(groups[0].messages.length, 2);
      assert.equal(groups[1].turn, 1);
      assert.equal(groups[1].messages.length, 1);
    });

    it('inherits turn from previous message when turn is undefined', () => {
      const messages = [
        { role: 'user', content: 'a', turn: 0 },
        { role: 'system', content: 'reminder' },  // no turn
        { role: 'assistant', content: 'b', turn: 0 },
      ];
      const groups = groupByTurn(messages);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].turn, 0);
      assert.equal(groups[0].messages.length, 3);
    });

    it('inherits turn from previous message when turn is null', () => {
      const messages = [
        { role: 'user', content: 'a', turn: 2 },
        { role: 'system', content: 'reminder', turn: null },
      ];
      const groups = groupByTurn(messages);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].turn, 2);
    });

    it('handles empty array', () => {
      assert.deepEqual(groupByTurn([]), []);
    });

    it('handles messages with no turn field at all', () => {
      const messages = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ];
      const groups = groupByTurn(messages);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].turn, 0);
    });
  });

  // ── renderConversationHtml ────────────────────────────────

  describe('renderConversationHtml', () => {
    it('produces a complete HTML document', () => {
      const html = renderConversationHtml([]);
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('</html>'));
    });

    it('includes custom title', () => {
      const html = renderConversationHtml([], { title: 'My Conversation' });
      assert.ok(html.includes('My Conversation'));
    });

    it('includes agentId and sessionId in header when provided', () => {
      const html = renderConversationHtml([], {
        agentId: 'my-agent',
        sessionId: 'session-abcdef123456',
      });
      assert.ok(html.includes('my-agent'));
      // sessionId is sliced to last 12 chars in the header
      assert.ok(html.includes('abcdef123456'));
    });

    it('renders user and assistant messages', () => {
      const messages = [
        { role: 'user', content: 'hello world', turn: 0 },
        { role: 'assistant', content: 'hi there', turn: 0 },
      ];
      const html = renderConversationHtml(messages);
      assert.ok(html.includes('hello world'));
      assert.ok(html.includes('hi there'));
      assert.ok(html.includes('message-row user'));
      assert.ok(html.includes('message-row assistant'));
    });

    it('escapes HTML in title field (XSS prevention via escapeHtml)', () => {
      // escapeHtml is applied to title, agentId, tool names — not markdown body content
      // (markdown body is processed by marked, which has its own HTML handling)
      const html = renderConversationHtml([], { title: '<script>x</script>' });
      assert.ok(!html.includes('<title><script>'));
      assert.ok(html.includes('&lt;script&gt;'));
    });

    it('renders tool calls with results', () => {
      const messages = [
        { role: 'user', content: 'read a file', turn: 0 },
        { role: 'assistant', content: 'ok', turn: 0, toolCalls: [
          { id: 'tc1', name: 'read', arguments: { filePath: 'a.js' } },
        ]},
        { role: 'tool', toolCallId: 'tc1', content: '{"success":true,"result":"file content"}', turn: 0 },
      ];
      const html = renderConversationHtml(messages);
      assert.ok(html.includes('Read'));
      assert.ok(html.includes('tool-block'));
      assert.ok(html.includes('file content'));
    });

    it('renders error tool results with fail status', () => {
      const messages = [
        { role: 'assistant', content: 'trying', turn: 0, toolCalls: [
          { id: 'tc1', name: 'bash', arguments: { command: 'bad' } },
        ]},
        { role: 'tool', toolCallId: 'tc1', content: '{"success":false,"result":"command not found"}', turn: 0 },
      ];
      const html = renderConversationHtml(messages);
      assert.ok(html.includes('tool-block-status fail') || html.includes('✗'));
      assert.ok(html.includes('command not found'));
    });

    it('filters by lastNCalls when provided', () => {
      const messages = [
        { role: 'user', content: 'turn0', turn: 0 },
        { role: 'user', content: 'turn1', turn: 1 },
        { role: 'user', content: 'turn2', turn: 2 },
      ];
      const html = renderConversationHtml(messages, { lastNCalls: 1 });
      assert.ok(html.includes('turn2'));
      assert.ok(!html.includes('turn0'));
      assert.ok(!html.includes('turn1'));
    });

    it('renders system messages', () => {
      const messages = [
        { role: 'system', content: 'system reminder', turn: 0 },
      ];
      const html = renderConversationHtml(messages);
      assert.ok(html.includes('system reminder'));
      assert.ok(html.includes('role-badge'));
    });

    it('includes reasoning block when present', () => {
      const messages = [
        { role: 'assistant', content: 'answer', turn: 0, reasoning: 'thinking...' },
      ];
      const html = renderConversationHtml(messages);
      assert.ok(html.includes('reasoning-block'));
      assert.ok(html.includes('thinking'));
    });

    it('includes token usage info when present', () => {
      const messages = [
        { role: 'assistant', content: 'reply', turn: 0, usage: { inputTokens: 100, outputTokens: 50 } },
      ];
      const html = renderConversationHtml(messages);
      assert.ok(html.includes('100'));
      assert.ok(html.includes('50'));
    });
  });
});
