/**
 * Tests for the tool-call rewrite badge in chat-renderer.js (ADR-0023 / PR-4).
 *
 * Mirrors the framework viewer's coverage (packages/viewer/test/
 * viewer-html-tool-rewrite.test.ts) so both rendering pipelines are locked to
 * the same DOM contract: the call card body shows the effective call, the
 * header carries a "已修改" badge, and the badge toggles a detail block holding
 * the original call snapshot.
 *
 * 装载路线（P4 T2 批次）：chat-renderer 已迁 ESM，改真实 import（withP2EsmCase）。
 * 渲染期改写索引 `rewrittenByCallId` 是模块私有状态，用例不再直改它——改为经
 * 生产入口 `refreshRewriteIndex(messages)` 建索引后断言卡片产物，观察面因此与
 * 真实调用链一致。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';
import { t as realT } from '../public/src/i18n.js';

const CHAT_RENDERER = 'public/src/modules/chat-renderer.js';
const REWRITTEN = { name: 'read_file', arguments: { path: './a.ts' } };

function makeDocument() {
  const element = () => ({
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; }, remove() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
  });
  return {
    getElementById: () => element(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => element(),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {},
    body: element(), head: element(), documentElement: element(),
  };
}

async function withRenderer(fn) {
  return withP2EsmCase({
    classic: (sandbox) => {
      // 整条生产先行脚本序（宿主工厂是生产实现）；markdown-utils 的 escapeHtml /
      // renderer 在 ESM 求值期自建，用例只补 vendor 的 marked 面。
      prepareClassicSandbox(sandbox);
    },
    globals: {
      document: makeDocument(),
      marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: (value) => String(value ?? '') },
      createPollCoordinatorHost: () => ({
        run: () => Promise.resolve(),
        fastInterval: () => 2000,
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (id) => clearTimeout(id),
      }),
    },
  }, async (c) => fn(await c.load(CHAT_RENDERER)));
}

test('getRewrittenCall: valid display returns the snapshot, missing or malformed returns null', async () => {
  await withRenderer((renderer) => {
    assert.deepEqual(renderer.getRewrittenCall({ rewrittenCall: REWRITTEN }), REWRITTEN);
    assert.equal(renderer.getRewrittenCall({}), null);
    assert.equal(renderer.getRewrittenCall({ rewrittenCall: 'garbage' }), null);
    assert.equal(renderer.getRewrittenCall(undefined), null);
  });
});

test('renderRewriteBadge: emits the badge with class, i18n text and toggle handler; empty without a rewrite', async () => {
  await withRenderer((renderer) => {
    const badge = renderer.renderRewriteBadge('rw-call-1', REWRITTEN);
    assert.match(badge, /tool-rewrite-badge/);
    assert.ok(badge.includes(realT('tool_rewritten')), 'badge text comes from the real i18n binding');
    assert.match(badge, /data-action="chat\.toggleRewriteDetail"/);
    assert.match(badge, /data-args='\["rw-call-1"\]'/);
    assert.equal(renderer.renderRewriteBadge('rw-call-1', null), '');
  });
});

test('renderRewriteDetail: expanded block carries the original name and argument JSON; empty without a rewrite', async () => {
  await withRenderer((renderer) => {
    const detail = renderer.renderRewriteDetail('rw-call-1', REWRITTEN);
    assert.match(detail, /id="rw-call-1"/);
    assert.match(detail, /tool-rewrite-detail/);
    assert.match(detail, /read_file/);
    assert.match(detail, /\.\/a\.ts/);
    assert.equal(renderer.renderRewriteDetail('rw-call-1', null), '');
  });
});

test('rewriteDetailId: unsafe call ids are sanitized into a valid DOM id', async () => {
  await withRenderer((renderer) => {
    assert.equal(renderer.rewriteDetailId('abc-1_2'), 'rw-call-abc-1_2');
    assert.equal(renderer.rewriteDetailId('a b/c<d>'), 'rw-call-a_b_c_d_');
  });
});

test('renderToolCallCardHtml: without a rewrite the card carries no badge', async () => {
  await withRenderer((renderer) => {
    const html = renderer.renderToolCallCardHtml({ id: 'call-1', name: 'read', arguments: { filePath: 'a.ts' } });
    assert.match(html, /data-tool-call-id="call-1"/);
    assert.doesNotMatch(html, /tool-rewrite-badge/);
    assert.doesNotMatch(html, /tool-rewrite-detail/);
  });
});

test('renderToolCallCardHtml: a rewritten call mounts the badge and detail on its card', async () => {
  await withRenderer((renderer) => {
    renderer.refreshRewriteIndex([
      { role: 'tool', toolCallId: 'call-1', display: { rewrittenCall: REWRITTEN } },
    ]);
    const html = renderer.renderToolCallCardHtml({ id: 'call-1', name: 'read_file', arguments: { path: './a.ts' } });
    assert.match(html, /tool-rewrite-badge/);
    assert.match(html, /tool-rewrite-detail/);
    assert.match(html, /read_file/);
  });
});

test('refreshRewriteIndex: indexes rewritten calls by toolCallId from tool messages only', async () => {
  await withRenderer((renderer) => {
    const messages = [
      { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read' }] },
      { role: 'tool', toolCallId: 'call-1', display: { rewrittenCall: REWRITTEN } },
      { role: 'tool', toolCallId: 'call-2', display: {} },
    ];
    renderer.refreshRewriteIndex(messages);
    assert.match(renderer.renderToolCallCardHtml({ id: 'call-1', name: 'read' }), /tool-rewrite-badge/);
    assert.doesNotMatch(renderer.renderToolCallCardHtml({ id: 'call-2', name: 'read' }), /tool-rewrite-badge/);

    // 索引按每次渲染重建：无改写时清空（不残留上一批的徽章）
    renderer.refreshRewriteIndex([{ role: 'tool', toolCallId: 'call-1', display: {} }]);
    assert.doesNotMatch(renderer.renderToolCallCardHtml({ id: 'call-1', name: 'read' }), /tool-rewrite-badge/);
  });
});
