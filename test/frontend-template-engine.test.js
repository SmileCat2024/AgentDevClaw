/**
 * Tests for public/src/modules/template-engine.js
 *
 * Covers pure functions:
 *   - parseToolResult (JSON tool result parsing with fallback)
 *   - getToolDisplayName (tool name lookup via TOOL_NAMES map)
 *   - interpolateTemplate ({{placeholder}} replacement)
 *   - formatError (error HTML formatting with escapeHtml)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * Create a sandbox with template-engine.js loaded.
 * Provides TOOL_NAMES and other globals the module expects.
 */
function loadTemplateEngine(toolNames = {}) {
  const ctx = createFrontendSandbox({
    TOOL_NAMES: toolNames,
    FEATURE_TEMPLATE_MAP: {},
    toolRenderConfigs: {},
    templateWarmupToken: 0,
  });
  ctx.loadSource('public/src/modules/template-engine.js');
  return ctx;
}

// ── parseToolResult ────────────────────────────────────────────────

describe('template-engine: parseToolResult', () => {
  it('parses valid JSON with success and result fields', () => {
    const ctx = loadTemplateEngine();
    const input = JSON.stringify({ success: true, result: 'hello' });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    assert.equal(result.success, true);
    assert.equal(result.data, 'hello');
  });

  it('parses failed result', () => {
    const ctx = loadTemplateEngine();
    const input = JSON.stringify({ success: false, result: 'error message' });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    assert.equal(result.success, false);
    assert.equal(result.data, 'error message');
  });

  it('unwraps double-encoded JSON string result', () => {
    const ctx = loadTemplateEngine();
    const inner = JSON.stringify({ key: 'value' });
    const input = JSON.stringify({ success: true, result: inner });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    assert.equal(result.success, true);
    assert.equal(result.data.key, 'value');
  });

  it('unwraps double-encoded JSON array string result', () => {
    const ctx = loadTemplateEngine();
    const inner = JSON.stringify([1, 2, 3]);
    const input = JSON.stringify({ success: true, result: inner });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    assert.equal(result.success, true);
    assert.equal(result.data.length, 3);
    assert.equal(result.data[0], 1);
    assert.equal(result.data[2], 3);
  });

  it('returns content as-is for non-JSON string', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('parseToolResult("plain text")');
    assert.equal(result.success, true);
    assert.equal(result.data, 'plain text');
  });

  it('returns content as-is for JSON without success/result fields', () => {
    const ctx = loadTemplateEngine();
    const input = JSON.stringify({ foo: 'bar' });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    assert.equal(result.success, true);
    assert.equal(result.data, input);
  });

  it('returns content as-is for JSON with only success field', () => {
    const ctx = loadTemplateEngine();
    const input = JSON.stringify({ success: true });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    assert.equal(result.success, true);
    assert.equal(result.data, input);
  });

  it('returns content as-is for JSON with only result field', () => {
    const ctx = loadTemplateEngine();
    const input = JSON.stringify({ result: 'data' });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    assert.equal(result.success, true);
    assert.equal(result.data, input);
  });

  it('returns content as-is for JSON primitive (number)', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('parseToolResult("42")');
    assert.equal(result.success, true);
    assert.equal(result.data, '42');
  });

  it('handles empty string input', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('parseToolResult("")');
    assert.equal(result.success, true);
    assert.equal(result.data, '');
  });

  it('preserves non-JSON string result (not double-encoded)', () => {
    const ctx = loadTemplateEngine();
    const input = JSON.stringify({ success: true, result: 'not json' });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    assert.equal(result.success, true);
    assert.equal(result.data, 'not json');
  });

  it('preserves string result that starts with { but is invalid JSON', () => {
    const ctx = loadTemplateEngine();
    const input = JSON.stringify({ success: true, result: '{invalid json' });
    const result = ctx.run(`parseToolResult(${JSON.stringify(input)})`);
    // The inner JSON.parse fails, so data stays as the original string
    assert.equal(result.success, true);
    assert.equal(result.data, '{invalid json');
  });
});

// ── getToolDisplayName ─────────────────────────────────────────────

describe('template-engine: getToolDisplayName', () => {
  it('returns mapped display name when tool is in TOOL_NAMES', () => {
    const ctx = loadTemplateEngine({ read: 'Read File', bash: 'Run Command' });
    assert.equal(ctx.run('getToolDisplayName("read")'), 'Read File');
    assert.equal(ctx.run('getToolDisplayName("bash")'), 'Run Command');
  });

  it('returns original toolName when not in TOOL_NAMES', () => {
    const ctx = loadTemplateEngine({ read: 'Read File' });
    assert.equal(ctx.run('getToolDisplayName("unknown_tool")'), 'unknown_tool');
  });

  it('returns "Tool" for null input', () => {
    const ctx = loadTemplateEngine();
    assert.equal(ctx.run('getToolDisplayName(null)'), 'Tool');
  });

  it('returns "Tool" for undefined input', () => {
    const ctx = loadTemplateEngine();
    assert.equal(ctx.run('getToolDisplayName(undefined)'), 'Tool');
  });

  it('returns "Tool" for empty string', () => {
    const ctx = loadTemplateEngine();
    assert.equal(ctx.run('getToolDisplayName("")'), 'Tool');
  });

  it('returns "Tool" for falsy 0', () => {
    const ctx = loadTemplateEngine();
    assert.equal(ctx.run('getToolDisplayName(0)'), 'Tool');
  });

  it('works with empty TOOL_NAMES map', () => {
    const ctx = loadTemplateEngine();
    assert.equal(ctx.run('getToolDisplayName("any_tool")'), 'any_tool');
  });
});

// ── interpolateTemplate ────────────────────────────────────────────

describe('template-engine: interpolateTemplate', () => {
  it('replaces single placeholder', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('interpolateTemplate("Hello {{name}}!", { name: "World" })');
    assert.equal(result, 'Hello World!');
  });

  it('replaces multiple placeholders', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('interpolateTemplate("{{a}} and {{b}}", { a: "1", b: "2" })');
    assert.equal(result, '1 and 2');
  });

  it('preserves placeholder when key is missing from data', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('interpolateTemplate("Hello {{name}}", {})');
    assert.equal(result, 'Hello {{name}}');
  });

  it('preserves placeholder when key value is undefined', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('interpolateTemplate("{{x}}", { x: undefined })');
    assert.equal(result, '{{x}}');
  });

  it('converts non-string values to string', () => {
    const ctx = loadTemplateEngine();
    assert.equal(ctx.run('interpolateTemplate("{{n}}", { n: 42 })'), '42');
    assert.equal(ctx.run('interpolateTemplate("{{b}}", { b: true })'), 'true');
  });

  it('handles templates with no placeholders', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('interpolateTemplate("no placeholders here", {})');
    assert.equal(result, 'no placeholders here');
  });

  it('handles underscore in placeholder key', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('interpolateTemplate("{{file_name}}", { file_name: "test.js" })');
    assert.equal(result, 'test.js');
  });

  it('handles numeric in placeholder key', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('interpolateTemplate("{{item123}}", { item123: "value" })');
    assert.equal(result, 'value');
  });
});

// ── formatError ────────────────────────────────────────────────────

describe('template-engine: formatError', () => {
  it('formats string error with escaping', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('formatError("something failed")');
    assert.ok(result.includes('tool-error'));
    assert.ok(result.includes('something failed'));
  });

  it('formats object error as JSON', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('formatError({ code: 500, message: "oops" })');
    assert.ok(result.includes('tool-error'));
    // JSON quotes are escaped by escapeHtml
    assert.ok(result.includes('code'));
    assert.ok(result.includes('500'));
    assert.ok(result.includes('oops'));
  });

  it('escapes HTML in error text (XSS prevention)', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('formatError("<script>alert(1)</script>")');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;script&gt;'));
  });

  it('includes SVG icon element', () => {
    const ctx = loadTemplateEngine();
    const result = ctx.run('formatError("err")');
    assert.ok(result.includes('<svg'));
  });
});
