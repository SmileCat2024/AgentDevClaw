/**
 * Tests for tool-card collapse semantics in chat-renderer.js:
 *
 * 1. Every long tool RESULT row auto-collapses regardless of tool name
 *    (previously only Read/Edit folded — Grep/Bash/LS results stayed fully
 *    expanded, the "long tools never fold" complaint).
 * 2. Long tool CALL cards (assistant rows) collapse per-card with an in-card
 *    toggle, independent of the row's own collapse state. Short cards stay
 *    as-is; the user's explicit expand is remembered via the
 *    _userExpandedToolCalls override set.
 *
 * Loads the real collapse functions (computeRowCollapsePlan /
 * applyRowCollapsePlan / applyToolCallCollapsePlan) extracted from
 * chat-renderer.js into a vm sandbox with classList-style DOM stubs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const chatRendererSource = fs.readFileSync(
  new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, force) => {
      const enable = force === undefined ? !set.has(name) : Boolean(force);
      if (enable) set.add(name); else set.delete(name);
      return enable;
    },
    contains: (name) => set.has(name),
  };
}

function makeToggleBarStub() {
  return {
    _isToggleBar: true,
    className: '',
    style: {},
    classList: makeClassList(),
    // applyRowCollapsePlan diff-guards its innerHTML write by reading the
    // button back out of the written markup string.
    set innerHTML(html) { this._html = html; },
    get innerHTML() { return this._html || ''; },
    querySelector(sel) {
      if (sel !== '.expand-toggle-btn') return null;
      const m = /<button[^>]*>([^<]*)<\/button>/.exec(this.innerHTML || '');
      if (!m) return null;
      const clsMatch = /<button class="([^"]*)"/.exec(this.innerHTML || '');
      return {
        textContent: m[1],
        classList: makeClassList(clsMatch ? clsMatch[1].split(' ') : []),
      };
    },
  };
}

function makeCallCard({ contentH, id }) {
  const card = { classList: makeClassList(), _bar: null };
  const content = { id, scrollHeight: contentH, classList: makeClassList() };
  card.querySelector = (sel) => {
    if (sel === '.tool-content') return content;
    if (sel === '.tool-call-toggle-bar') return card._bar;
    return null;
  };
  card.appendChild = (child) => {
    if (child && child._isToggleBar) card._bar = child;
    return child;
  };
  return { card, content };
}

function makeRow({ role, contentH, callCards = [], msgIndex = 0 }) {
  const row = { classList: makeClassList(), _rowBar: null };
  row.classList.add(role);
  const content = { id: `msg-${msgIndex}`, scrollHeight: contentH, classList: makeClassList() };
  const toolHeaderSpan = { textContent: '' };
  row.querySelector = (sel) => {
    if (sel === '.message-content') return content;
    if (sel === '.expand-toggle-bar') return row._rowBar;
    if (sel === '.tool-result-header span:last-child') return toolHeaderSpan;
    return null;
  };
  row.querySelectorAll = (sel) =>
    sel === '.tool-call-container' ? callCards.map((c) => c.card) : [];
  row.appendChild = (child) => {
    if (child && child._isToggleBar) row._rowBar = child;
    return child;
  };
  return { row, content };
}

function createCollapseSandbox() {
  const sandbox = {
    document: {
      createElement: () => makeToggleBarStub(),
    },
    getToggleButtonLabel: (collapsed) => (collapsed ? '展开' : '收起'),
    _userExpandedMsgs: new Set(),
    _userCollapsedMsgs: new Set(),
    _userExpandedToolCalls: new Set(),
    _userCollapsedToolCalls: new Set(),
  };
  vm.createContext(sandbox);
  const block = sourceBetween(
    chatRendererSource,
    'function getCollapseThresholdForRow',
    '\nfunction syncRowCollapseState',
  );
  vm.runInContext(block, sandbox, { filename: 'chat-renderer-collapse.js' });
  return sandbox;
}

function runSync(sandbox, row) {
  const plan = vm.runInContext('computeRowCollapsePlan', sandbox)(row);
  if (plan) vm.runInContext('applyRowCollapsePlan', sandbox)(row, plan);
  return plan;
}

test('any long tool result row auto-collapses, not only Read/Edit', () => {
  const sandbox = createCollapseSandbox();
  for (const toolName of ['Bash', 'Grep', 'Glob', 'mcp_claw_mcp_overview', 'ls']) {
    const { row, content } = makeRow({ role: 'tool', contentH: 600, msgIndex: 3 });
    const plan = runSync(sandbox, row);
    assert.equal(plan.shouldCollapse, true, `${toolName} result should auto-collapse`);
    assert.equal(content.classList.contains('collapsed'), true, `${toolName} content gets collapsed`);
    assert.ok(row._rowBar, `${toolName} row gets a toggle bar`);
  }
});

test('assistant text rows keep manual-only collapse (no auto-fold)', () => {
  const sandbox = createCollapseSandbox();
  const { row, content } = makeRow({ role: 'assistant', contentH: 600, msgIndex: 1 });
  const plan = runSync(sandbox, row);
  assert.equal(plan.shouldCollapse, false, 'assistant rows do not auto-collapse');
  assert.equal(content.classList.contains('collapsed'), false);
  assert.ok(row._rowBar, 'long assistant row still gets a manual toggle');
});

test('long tool call cards collapse per-card; short cards stay open', () => {
  const sandbox = createCollapseSandbox();
  const long = makeCallCard({ contentH: 600, id: 'tcallc-msg-2-0' });
  const short = makeCallCard({ contentH: 40, id: 'tcallc-msg-2-1' });
  const { row, content } = makeRow({
    role: 'assistant', contentH: 40, callCards: [long, short], msgIndex: 2,
  });

  const plan = runSync(sandbox, row);
  assert.equal(plan.callPlans.length, 2);
  assert.equal(long.content.classList.contains('collapsed'), true, 'long call content collapses');
  assert.ok(long.card._bar, 'long call card gets an in-card toggle bar');
  assert.equal(short.content.classList.contains('collapsed'), false, 'short call content stays open');
  assert.equal(short.card._bar, null, 'short call card gets no toggle bar');
  assert.equal(content.classList.contains('collapsed'), false, 'row itself stays open');
});

test('user-expanded call card overrides the auto-collapse default', () => {
  const sandbox = createCollapseSandbox();
  sandbox._userExpandedToolCalls.add('2:0');
  const long = makeCallCard({ contentH: 600, id: 'tcallc-msg-2-0' });
  const { row } = makeRow({ role: 'assistant', contentH: 40, callCards: [long], msgIndex: 2 });

  runSync(sandbox, row);
  assert.equal(long.content.classList.contains('collapsed'), false,
    'explicitly expanded card must stay expanded');
  assert.ok(long.card._bar, 'toggle bar persists so the choice is reversible');
});

test('process-hidden call cards are skipped (scrollHeight unreliable)', () => {
  const sandbox = createCollapseSandbox();
  const hidden = makeCallCard({ contentH: 600, id: 'tcallc-msg-2-0' });
  hidden.card.classList.add('process-cv-hidden');
  const { row } = makeRow({ role: 'assistant', contentH: 40, callCards: [hidden], msgIndex: 2 });

  const plan = runSync(sandbox, row);
  assert.equal(plan.callPlans.length, 0, 'cv-hidden card must not be measured');
});

test('toolCallKeyFromContentId parses indexes and rejects foreign ids', () => {
  const sandbox = createCollapseSandbox();
  const parse = vm.runInContext('toolCallKeyFromContentId', sandbox);
  assert.equal(parse('tcallc-msg-12-3'), '12:3');
  assert.equal(parse('tcallc-msg-0-0'), '0:0');
  assert.equal(parse('msg-12'), null);
  assert.equal(parse('tcallc-msg-12'), null);
  assert.equal(parse(''), null);
  assert.equal(parse(null), null);
});
