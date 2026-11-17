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
 * 装载路线（P4 T2 批次）：chat-renderer 已迁 ESM，折叠函数改真实 import
 * （withP2EsmCase + prepareClassicSandbox 提供整条 classic 宿主链）。行 / 内容 /
 * 折叠按钮仍是本文件的 classList 风格 DOM 夹具——折叠判定只读这几样。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const CHAT_RENDERER = 'public/src/modules/chat-renderer.js';
const componentsCss = fs.readFileSync(
  new URL('../public/styles/components.css', import.meta.url), 'utf8');

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

function makeDocument(extraElements = {}) {
  const generic = () => ({
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '',
    classList: makeClassList(), addEventListener() {}, removeEventListener() {},
    appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, matches() { return false; }, remove() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
  });
  return {
    // applyRowCollapsePlan 的折叠按钮条：只写 innerHTML 并回读按钮
    createElement: () => makeToggleBarStub(),
    getElementById: (id) => extraElements[id] || generic(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {},
    body: generic(), head: generic(), documentElement: generic(),
  };
}

/**
 * 一个用例 = 真实 chat-renderer 模块 + 真实 classic 宿主链。
 * `surface` 是 app-core 的聊天表面宿主（过程显隐 / 折叠偏好三兄弟）。
 */
async function withCollapseCase(fn) {
  return withP2EsmCase({
    classic: (sandbox) => {
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
  }, async (c) => {
    const renderer = await c.load(CHAT_RENDERER);
    return fn({ renderer, surface: c.window.createP2BootstrapChatSurfaceHost() });
  });
}

function runSync({ renderer }, row) {
  const plan = renderer.computeRowCollapsePlan(row);
  if (plan) renderer.applyRowCollapsePlan(row, plan);
  return plan;
}

test('any long tool result row auto-collapses, not only Read/Edit', async () => {
  await withCollapseCase((h) => {
    for (const toolName of ['Bash', 'Grep', 'Glob', 'mcp_claw_mcp_overview', 'ls']) {
      const { row, content } = makeRow({ role: 'tool', contentH: 600, msgIndex: 3 });
      const plan = runSync(h, row);
      assert.equal(plan.shouldCollapse, true, `${toolName} result should auto-collapse`);
      assert.equal(content.classList.contains('collapsed'), true, `${toolName} content gets collapsed`);
      assert.ok(row._rowBar, `${toolName} row gets a toggle bar`);
    }  });
});

test('assistant text rows keep manual-only collapse (no auto-fold)', async () => {
  await withCollapseCase((h) => {
    const { row, content } = makeRow({ role: 'assistant', contentH: 600, msgIndex: 1 });
    const plan = runSync(h, row);
    assert.equal(plan.shouldCollapse, false, 'assistant rows do not auto-collapse');
    assert.equal(content.classList.contains('collapsed'), false);
    assert.ok(row._rowBar, 'long assistant row still gets a manual toggle');  });
});

test('tall assistant rows with call cards auto-collapse at row level (toggle outside the block)', async () => {
  await withCollapseCase((h) => {
    const card = { classList: makeClassList() };
    const { row, content } = makeRow({ role: 'assistant', contentH: 600, callCards: [card], msgIndex: 2 });

    const plan = runSync(h, row);
    assert.equal(plan.shouldCollapse, true, 'card-bearing assistant row auto-collapses');
    assert.equal(content.classList.contains('collapsed'), true, 'row content collapses as a whole');
    assert.ok(row._rowBar, 'the single toggle bar is the row-level (outside) one');
    assert.equal(card.classList.contains('collapsed'), false,
      'call cards no longer carry their own collapsed state');  });
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

test('card-bearing rows compensate for each card shell while keeping the 160px content budget', async () => {
  await withCollapseCase((h) => {
    // 每张卡约 68px shell：总高阈值 = 160px 内容 + 卡数 × 68px
    const oneCardBelow = makeRow({ role: 'assistant', contentH: 228, callCards: [{ classList: makeClassList() }], msgIndex: 4 });
    assert.equal(runSync(h, oneCardBelow.row).shouldCollapse, false,
      'one card at its 228px compensated threshold stays open');

    const oneCardOver = makeRow({ role: 'assistant', contentH: 229, callCards: [{ classList: makeClassList() }], msgIndex: 5 });
    assert.equal(runSync(h, oneCardOver.row).shouldCollapse, true,
      'one card collapses only after 160px usable content plus its shell');

    const twoCardsBelow = makeRow({ role: 'assistant', contentH: 296, callCards: [{}, {}].map(() => ({ classList: makeClassList() })), msgIndex: 6 });
    assert.equal(runSync(h, twoCardsBelow.row).shouldCollapse, false,
      'two cards get two shell compensations');

    const twoCardsOver = makeRow({ role: 'assistant', contentH: 297, callCards: [{}, {}].map(() => ({ classList: makeClassList() })), msgIndex: 7 });
    assert.equal(runSync(h, twoCardsOver.row).shouldCollapse, true,
      'two cards collapse only after their combined 296px compensated threshold');

    const textOnly = makeRow({ role: 'assistant', contentH: 161, msgIndex: 8 });
    assert.equal(runSync(h, textOnly.row).shouldCollapse, false,
      'plain text rows retain manual-only behavior');  });
});

test('user-expanded row preference overrides the auto-collapse default', async () => {
  await withCollapseCase((h) => {
    h.surface._userExpandedMsgs.add(2);
    const card = { classList: makeClassList() };
    const { row, content } = makeRow({ role: 'assistant', contentH: 600, callCards: [card], msgIndex: 2 });

    runSync(h, row);
    assert.equal(content.classList.contains('collapsed'), false,
      'explicitly expanded row must stay expanded');
    assert.ok(row._rowBar, 'toggle bar persists so the choice is reversible');  });
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

test('hide mode: empty assistant row is born hidden', async () => {
  await withCollapseCase((h) => {
    h.surface.showChatProcess = false;
    const { row } = makeBirthRow({
      children: [childWithClasses(['markdown-body'], '')],
    });
    h.renderer.markAssistantBirthProcessState(row);
    assert.equal(row.classList.contains('process-hidden-empty'), true);  });
});

test('hide mode: assistant row whose visible content is only process children is born hidden', async () => {
  await withCollapseCase((h) => {
    h.surface.showChatProcess = false;
    const { row } = makeBirthRow({
      children: [
        childWithClasses(['markdown-body'], ''),
        childWithClasses(['reasoning-block'], 'thinking…'),
        childWithClasses(['tool-call-container'], 'args'),
      ],
    });
    h.renderer.markAssistantBirthProcessState(row);
    assert.equal(row.classList.contains('process-hidden-empty'), true);  });
});

test('hide mode: assistant row with visible text is born visible', async () => {
  await withCollapseCase((h) => {
    h.surface.showChatProcess = false;
    const { row } = makeBirthRow({
      children: [
        childWithClasses(['markdown-body'], '分析中'),
        childWithClasses(['tool-call-container'], 'args'),
      ],
    });
    h.renderer.markAssistantBirthProcessState(row);
    assert.equal(row.classList.contains('process-hidden-empty'), false);  });
});

test('hide mode: non-process children like tool-error keep the row visible', async () => {
  await withCollapseCase((h) => {
    h.surface.showChatProcess = false;
    const { row } = makeBirthRow({
      children: [
        childWithClasses(['markdown-body'], ''),
        childWithClasses(['tool-error'], ''),
      ],
    });
    h.renderer.markAssistantBirthProcessState(row);
    assert.equal(row.classList.contains('process-hidden-empty'), false);  });
});

test('show mode: birth state stays untouched (windowing owns visibility)', async () => {
  await withCollapseCase((h) => {
    h.surface.showChatProcess = true;
    const { row } = makeBirthRow({
      children: [childWithClasses(['markdown-body'], '')],
    });
    h.renderer.markAssistantBirthProcessState(row);
    assert.equal(row.classList.contains('process-hidden-empty'), false);  });
});
