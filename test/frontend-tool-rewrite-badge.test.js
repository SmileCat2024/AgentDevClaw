/**
 * Tests for the tool-call rewrite badge in chat-renderer.js (ADR-0023 / PR-4).
 *
 * Mirrors the framework viewer's coverage (packages/viewer/test/
 * viewer-html-tool-rewrite.test.ts) so both rendering pipelines are locked to
 * the same DOM contract: the call card body shows the effective call, the
 * header carries a "已修改" badge, and the badge toggles a detail block holding
 * the original call snapshot.
 *
 * Loads the real render helpers from chat-renderer.js into a front-end vm
 * sandbox (the file's module-level init calls are outside the extracted range).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const REWRITTEN = { name: 'read_file', arguments: { path: './a.ts' } };

function harness() {
  const ctx = createFrontendSandbox({
    t: (key) => key,
    getToolDisplayName: (name) => name || 'unknown',
    getToolRenderTemplate: () => ({}),
    applyTemplate: () => '',
    renderJsonHighlight: (args) => JSON.stringify(args),
    rewrittenByCallId: new Map(),
  });
  const source = fs.readFileSync(
    new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');
  vm.runInContext(
    sourceBetween(source, 'function getRewrittenCall(', 'window.toggleRewriteDetail = '),
    ctx,
    { filename: 'chat-renderer-rewrite.js' },
  );
  return ctx;
}

test('getRewrittenCall: valid display returns the snapshot, missing or malformed returns null', () => {
  const ctx = harness();
  assert.equal(
    ctx.run('JSON.stringify(getRewrittenCall({ rewrittenCall: ' + JSON.stringify(REWRITTEN) + ' }))'),
    JSON.stringify(REWRITTEN),
  );
  assert.equal(ctx.run('getRewrittenCall({})'), null);
  assert.equal(ctx.run('getRewrittenCall({ rewrittenCall: "garbage" })'), null);
  assert.equal(ctx.run('getRewrittenCall(undefined)'), null);
});

test('renderRewriteBadge: emits the badge with class, i18n text and toggle handler; empty without a rewrite', () => {
  const ctx = harness();
  const badge = ctx.run('renderRewriteBadge("rw-call-1", ' + JSON.stringify(REWRITTEN) + ')');
  assert.match(badge, /tool-rewrite-badge/);
  assert.match(badge, /tool_rewritten/);
  assert.match(badge, /toggleRewriteDetail\('rw-call-1'\)/);
  assert.equal(ctx.run('renderRewriteBadge("rw-call-1", null)'), '');
});

test('renderRewriteDetail: expanded block carries the original name and argument JSON; empty without a rewrite', () => {
  const ctx = harness();
  const detail = ctx.run('renderRewriteDetail("rw-call-1", ' + JSON.stringify(REWRITTEN) + ')');
  assert.match(detail, /id="rw-call-1"/);
  assert.match(detail, /tool-rewrite-detail/);
  assert.match(detail, /read_file/);
  assert.match(detail, /\.\/a\.ts/);
  assert.equal(ctx.run('renderRewriteDetail("rw-call-1", null)'), '');
});

test('rewriteDetailId: unsafe call ids are sanitized into a valid DOM id', () => {
  const ctx = harness();
  assert.equal(ctx.run('rewriteDetailId("abc-1_2")'), 'rw-call-abc-1_2');
  assert.equal(ctx.run('rewriteDetailId("a b/c<d>")'), 'rw-call-a_b_c_d_');
});

test('renderToolCallCardHtml: without a rewrite the card carries no badge', () => {
  const ctx = harness();
  const html = ctx.run('renderToolCallCardHtml({ id: "call-1", name: "read", arguments: { filePath: "a.ts" } })');
  assert.match(html, /data-tool-call-id="call-1"/);
  assert.doesNotMatch(html, /tool-rewrite-badge/);
  assert.doesNotMatch(html, /tool-rewrite-detail/);
});

test('renderToolCallCardHtml: a rewritten call mounts the badge and detail on its card', () => {
  const ctx = harness();
  ctx.run('rewrittenByCallId.set("call-1", ' + JSON.stringify(REWRITTEN) + ')');
  const html = ctx.run('renderToolCallCardHtml({ id: "call-1", name: "read_file", arguments: { path: "./a.ts" } })');
  assert.match(html, /tool-rewrite-badge/);
  assert.match(html, /tool-rewrite-detail/);
  assert.match(html, /read_file/);
});

test('refreshRewriteIndex: indexes rewritten calls by toolCallId from tool messages only', () => {
  const ctx = harness();
  ctx.messages = [
    { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read' }] },
    { role: 'tool', toolCallId: 'call-1', display: { rewrittenCall: REWRITTEN } },
    { role: 'tool', toolCallId: 'call-2', display: {} },
  ];
  ctx.run('refreshRewriteIndex(messages)');
  assert.equal(ctx.run('JSON.stringify(rewrittenByCallId.get("call-1"))'), JSON.stringify(REWRITTEN));
  assert.equal(ctx.run('rewrittenByCallId.has("call-2")'), false);
  assert.equal(ctx.run('rewrittenByCallId.size'), 1);
});
