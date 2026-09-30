/**
 * Tests for collapse semantics in chat-renderer.js:
 *
 * 1. Every long tool RESULT row auto-collapses regardless of tool name
 *    (previously only Read/Edit folded — Grep/Bash/LS results stayed fully
 *    expanded, the "long tools never fold" complaint).
 * 2. Assistant rows containing tool-call cards auto-collapse at the ROW level
 *    when tall — the collapse control lives outside the block (the row-level
 *    expand-toggle bar), exactly like tool result rows. There is no per-card
 *    in-block collapse anymore (the removed "块内折叠" design).
 * 3. Pure-text assistant rows keep manual-only collapse (no auto-fold).
 * 4. markAssistantBirthProcessState: freshly inserted / rebuilt assistant rows
 *    in hide-process mode are born hidden (process-hidden-empty) when they
 *    have no visible content, independent of the tail-scan sync that follows.
 *
 * Loads the real collapse functions (computeRowCollapsePlan /
 * applyRowCollapsePlan / markAssistantBirthProcessState) extracted from
 * chat-renderer.js into a vm sandbox with classList-style DOM stubs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const chatRendererSource = fs.readFileSync(
  new URL('../public/src/modules/chat-renderer.js', import.meta.url), 'utf8');
const componentsCss = fs.readFileSync(
  new URL('../public/styles/components.css', import.meta.url), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return source.slice(start, end);
}

function makeClassList(initial = []) {
  const set = new Set(initial);
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

function makeRow({ role, contentH, callCards = [], msgIndex = 0 }) {
  const row = { classList: makeClassList(), _rowBar: null };
  row.classList.add(role);
  const content = { id: `msg-${msgIndex}`, scrollHeight: contentH, classList: makeClassList() };
  const toolHeaderSpan = { textContent: '' };
  row.querySelector = (sel) => {
    if (sel === '.message-content') return content;
    if (sel === '.expand-toggle-bar') return row._rowBar;
    if (sel === '.tool-result-header span:last-child') return toolHeaderSpan;
    if (sel === '.tool-call-container') return callCards[0] || null;
    return null;
  };
  row.querySelectorAll = (sel) =>
    sel === '.tool-call-container' ? callCards : [];
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
    showChatProcess: false,
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

test('tall assistant rows with call cards auto-collapse at row level (toggle outside the block)', () => {
  const sandbox = createCollapseSandbox();
  const card = { classList: makeClassList() };
  const { row, content } = makeRow({ role: 'assistant', contentH: 600, callCards: [card], msgIndex: 2 });

  const plan = runSync(sandbox, row);
  assert.equal(plan.shouldCollapse, true, 'card-bearing assistant row auto-collapses');
  assert.equal(content.classList.contains('collapsed'), true, 'row content collapses as a whole');
  assert.ok(row._rowBar, 'the single toggle bar is the row-level (outside) one');
  assert.equal(card.classList.contains('collapsed'), false,
    'call cards no longer carry their own collapsed state');
});

test('collapsed call cards show the same 160px viewport as tool-result rows without nesting a toggle', () => {
  assert.match(componentsCss,
    /\.message-row\.assistant:has\(\.tool-call-container\) \.message-content\.collapsed\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/,
    'the row remains unclipped so preceding reasoning/text cannot consume the call-card viewport');
  assert.match(componentsCss,
    /\.message-row\.assistant:has\(\.tool-call-container\) \.message-content\.collapsed \.tool-call-container\s*\{\s*max-height:\s*160px;[^}]*mask-image:\s*linear-gradient\(to bottom, black 60%, transparent 100%\);[^}]*overflow:\s*hidden;/,
    'each call card gets the same 160px clipped viewport and fade-out as a tool-result row');
  assert.match(componentsCss,
    /\.message-content\.collapsed\s*\{\s*max-height:\s*160px;/,
    'tool-result rows retain their existing 160px row-level viewport');
  assert.doesNotMatch(componentsCss, /tool-call-toggle-bar/,
    'call cards have no nested expand/collapse controls');
});

test('card-bearing rows compensate for each card shell while keeping the 160px content budget', () => {
  const sandbox = createCollapseSandbox();
  // 每张卡约 68px shell：总高阈值 = 160px 内容 + 卡数 × 68px
  const oneCardBelow = makeRow({ role: 'assistant', contentH: 228, callCards: [{ classList: makeClassList() }], msgIndex: 4 });
  assert.equal(runSync(sandbox, oneCardBelow.row).shouldCollapse, false,
    'one card at its 228px compensated threshold stays open');

  const oneCardOver = makeRow({ role: 'assistant', contentH: 229, callCards: [{ classList: makeClassList() }], msgIndex: 5 });
  assert.equal(runSync(sandbox, oneCardOver.row).shouldCollapse, true,
    'one card collapses only after 160px usable content plus its shell');

  const twoCardsBelow = makeRow({ role: 'assistant', contentH: 296, callCards: [{}, {}].map(() => ({ classList: makeClassList() })), msgIndex: 6 });
  assert.equal(runSync(sandbox, twoCardsBelow.row).shouldCollapse, false,
    'two cards get two shell compensations');

  const twoCardsOver = makeRow({ role: 'assistant', contentH: 297, callCards: [{}, {}].map(() => ({ classList: makeClassList() })), msgIndex: 7 });
  assert.equal(runSync(sandbox, twoCardsOver.row).shouldCollapse, true,
    'two cards collapse only after their combined 296px compensated threshold');

  const textOnly = makeRow({ role: 'assistant', contentH: 161, msgIndex: 8 });
  assert.equal(runSync(sandbox, textOnly.row).shouldCollapse, false,
    'plain text rows retain manual-only behavior');
});

test('user-expanded row preference overrides the auto-collapse default', () => {
  const sandbox = createCollapseSandbox();
  sandbox._userExpandedMsgs.add(2);
  const card = { classList: makeClassList() };
  const { row, content } = makeRow({ role: 'assistant', contentH: 600, callCards: [card], msgIndex: 2 });

  runSync(sandbox, row);
  assert.equal(content.classList.contains('collapsed'), false,
    'explicitly expanded row must stay expanded');
  assert.ok(row._rowBar, 'toggle bar persists so the choice is reversible');
});

// ── markAssistantBirthProcessState ─────────────────────────────────────────

function makeBirthRow({ role = 'assistant', children = [] }) {
  const row = { classList: makeClassList() };
  row.classList.add(role);
  const content = { children, classList: makeClassList() };
  row.querySelector = (sel) => (sel === '.message-content' ? content : null);
  return { row, content };
}

function childWithClasses(classes, textContent = '') {
  return { classList: makeClassList(classes), textContent };
}

function runBirth(sandbox, row) {
  return vm.runInContext('markAssistantBirthProcessState', sandbox)(row);
}

test('hide mode: empty assistant row is born hidden', () => {
  const sandbox = createCollapseSandbox();
  sandbox.showChatProcess = false;
  const { row } = makeBirthRow({
    children: [childWithClasses(['markdown-body'], '')],
  });
  runBirth(sandbox, row);
  assert.equal(row.classList.contains('process-hidden-empty'), true);
});

test('hide mode: assistant row whose visible content is only process children is born hidden', () => {
  const sandbox = createCollapseSandbox();
  sandbox.showChatProcess = false;
  const { row } = makeBirthRow({
    children: [
      childWithClasses(['markdown-body'], ''),
      childWithClasses(['reasoning-block'], 'thinking…'),
      childWithClasses(['tool-call-container'], 'args'),
    ],
  });
  runBirth(sandbox, row);
  assert.equal(row.classList.contains('process-hidden-empty'), true);
});

test('hide mode: assistant row with visible text is born visible', () => {
  const sandbox = createCollapseSandbox();
  sandbox.showChatProcess = false;
  const { row } = makeBirthRow({
    children: [
      childWithClasses(['markdown-body'], '分析中'),
      childWithClasses(['tool-call-container'], 'args'),
    ],
  });
  runBirth(sandbox, row);
  assert.equal(row.classList.contains('process-hidden-empty'), false);
});

test('hide mode: non-process children like tool-error keep the row visible', () => {
  const sandbox = createCollapseSandbox();
  sandbox.showChatProcess = false;
  const { row } = makeBirthRow({
    children: [
      childWithClasses(['markdown-body'], ''),
      childWithClasses(['tool-error'], ''),
    ],
  });
  runBirth(sandbox, row);
  assert.equal(row.classList.contains('process-hidden-empty'), false);
});

test('show mode: birth state stays untouched (windowing owns visibility)', () => {
  const sandbox = createCollapseSandbox();
  sandbox.showChatProcess = true;
  const { row } = makeBirthRow({
    children: [childWithClasses(['markdown-body'], '')],
  });
  runBirth(sandbox, row);
  assert.equal(row.classList.contains('process-hidden-empty'), false);
});
