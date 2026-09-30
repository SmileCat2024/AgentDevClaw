/**
 * Reproduction attempts for the hide-process-mode badge leak: an assistant
 * message with no text output must be fully hidden (process-hidden-empty on
 * the row), not rendered as a badge-only "empty assistant message".
 *
 * Drives the real appendNewMessages / updateLastMessage /
 * applyConversationProcessState pipeline (mirrors the harness of
 * frontend-append-incremental.test.js) through the live-streaming shapes:
 *   1. tool-call-only assistant message appended while in hide mode
 *   2. same message patched again (updateLastMessage) as calls stream in
 *   3. assistant message appended empty, then patched with text
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = (p) => fs.readFileSync(new URL('../public/src/' + p, import.meta.url), 'utf8');

const VIEW_H = 800;

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

// Assistant row stub shaped like renderMessage output:
// .message-content > [ .markdown-body, .tool-call-container* ]
function makeAssistantRow({ text = '', callCount = 0, msgId = '' }) {
  const row = {
    realH: 200,
    rememberedH: null,
    classList: makeClassList(),
    dataset: {},
    contains: () => false,
    matches: () => false,
    style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, removeProperty(k) { delete this._props[k]; } },
  };
  row.classList.add('assistant');

  const markdownBody = {
    classList: makeClassList(),
    _html: '',
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    get textContent() { return this._html; },
  };
  markdownBody.classList.add('markdown-body');
  markdownBody._html = text;

  const callCards = [];
  for (let i = 0; i < callCount; i++) {
    const card = {
      classList: makeClassList(),
      style: { _props: {}, setProperty(k, v) { this._props[k] = String(v); }, removeProperty(k) { delete this._props[k]; } },
      querySelector: () => null,
      appendChild: (c) => c,
    };
    card.classList.add('tool-call-container');
    callCards.push(card);
  }

  const content = {
    id: msgId,
    scrollHeight: 200,
    classList: makeClassList(),
    style: {},
    get children() { return [markdownBody, ...callCards]; },
  };

  row._markdownBody = markdownBody;
  row._callCards = callCards;
  row._processChildren = callCards;
  row._appended = [];
  row.querySelector = (sel) => {
    if (sel === '.message-content') return content;
    if (sel.includes('markdown-body')) return markdownBody;
    if (sel === '.expand-toggle-bar') {
      return row._appended.find((c) => c.classList.contains('expand-toggle-bar')) || null;
    }
    return null;
  };
  row.querySelectorAll = (sel) => {
    if (sel === '.reasoning-block, .tool-call-container' || sel === '.tool-call-container') return callCards;
    return [];
  };
  row.appendChild = (c) => { row._appended.push(c); return c; };
  return row;
}

function createHarness({ messages } = {}) {
  const container = {
    clientHeight: VIEW_H,
    clientWidth: 1000,
    _scrollTop: 0,
    _entries: [],
    scrollHeight: VIEW_H * 4,
  };
  Object.defineProperty(container, 'scrollTop', {
    get() { return container._scrollTop; },
    set(v) { container._scrollTop = Math.max(0, Number(v) || 0); },
  });
  container.querySelectorAll = (sel) => (sel === '.message-row'
    ? container._entries.map((e) => e.row)
    : []);
  container.querySelector = () => null;
  container.getBoundingClientRect = () => ({ top: 0, left: 0, width: 1000, height: VIEW_H });
  container.addEventListener = () => {};
  container.removeEventListener = () => {};

  // appendNewMessages consumes the html string, materializes our stub row.
  const pendingRows = [];
  container.insertAdjacentHTML = (_pos, _html) => {
    const entry = pendingRows.shift();
    if (entry) container._entries.push(entry);
  };
  Object.defineProperty(container, 'lastElementChild', {
    get: () => {
      const last = container._entries[container._entries.length - 1];
      return last ? last.row : null;
    },
  });

  const sandbox = {
    console, Date, JSON, Math, Promise, Map, Set, Number, Object, Array, Boolean, String, isNaN, parseInt,
    CSS: { supports: () => true },
    window: {},
    setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: {},
        classList: makeClassList(),
        dataset: {},
        setAttribute() {},
        appendChild(c) { return c; },
        querySelector: () => null,
        querySelectorAll: () => [],
      }),
      body: { contains: () => true },
      activeElement: null,
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },

    container,
    followLatestButton: { classList: { toggle() {}, add() {}, remove() {} }, innerHTML: '' },
    currentMessages: messages || [],
    allAgents: [],
    toolRenderConfigs: {},
    _lastRenderedChatSig: '',
    _userExpandedReasoning: new Set(),
    _userExpandedMsgs: new Set(),
    _userCollapsedMsgs: new Set(),
    currentInputRequests: [],
    chatProcessToggle: null,
    CHAT_PROCESS_VISIBILITY_KEY: 'k',
    readCurrentSessionViewState: () => ({ messages: sandbox.currentMessages, inputRequests: [] }),
    saveChatProcessVisibility() {},

    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    shouldShowChatWelcome: () => false,
    escapeHtml: (v) => String(v ?? ''),
    t: (k) => k,
    renderMarkdown: (s) => String(s ?? ''),
    parseToolResult: (content) => ({ success: true, data: content }),
    renderJsonHighlight: (d) => '<pre>' + String(d).slice(0, 20) + '</pre>',
    applyTemplate: () => '<div>args</div>',
    enhanceMathInElement() {},
    enhanceMarkdownTables() {},
    clearTruncatedHighlightData() {},
    getToolDisplayName: (n) => n || 'Tool',
    getToolRenderTemplate: () => ({}),
    resolveToolProgressForCall: () => null,
    canRollbackMessage: () => false,
    requestRollbackEdit() {},
    switchAgent() {},
    ensureChatRuntimeIndicator() {},
    getEmptyStateHtml: () => '<div class="empty-state">empty</div>',
    renderCurrentMainView() {},
    renderChatEmptyState() {},

    followLatestEnabled: false,
    suppressFollowScrollEvent: false,
    lastManualScrollIntentAt: 0,
    _progScrollCooldownUntil: 0,
    followLatestEntryUntil: 0,
    chatViewportObserversReady: true,
    chatViewportObserverSuppressDepth: 0,
    chatViewportObserverQuietUntil: 0,
    chatViewportMutationObserver: null,
    chatViewportResizeObserver: null,
    chatViewportSettlementToken: 0,
    chatViewportSettlementRaf: 0,
    chatViewportSettlementTimer: null,
    chatViewportSettlementContext: null,
    chatViewportFollowRaf: 0,
    chatViewportFollowToken: 0,
    chatViewportFollowTransition: 'locked',
    assemblySideRailRevealTimer: null,
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src('modules/chat-viewport.js'), sandbox, { filename: 'chat-viewport.js' });
  vm.runInContext(src('modules/input-helpers.js'), sandbox, { filename: 'input-helpers.js' });
  vm.runInContext(src('modules/lazy-tool-content.js'), sandbox, { filename: 'lazy-tool-content.js' });
  vm.runInContext(src('modules/chat-renderer.js'), sandbox, { filename: 'chat-renderer.js' });
  vm.runInContext(src('modules/chat-row-visibility.js'), sandbox, { filename: 'chat-row-visibility.js' });

  return {
    sandbox, container,
    queueRow(row) { pendingRows.push({ row }); },
  };
}

test('hide mode: tool-call-only assistant message appended must be fully hidden', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = false; // hide mode

  const userRow = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
  userRow.classList.remove('assistant');
  userRow.classList.add('user');
  h.container._entries.push({ row: userRow });

  const assistantRow = makeAssistantRow({ text: '', callCount: 2, msgId: 'msg-1' });
  h.queueRow(assistantRow);
  h.sandbox.currentMessages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [
      { id: 'c1', name: 'Read', arguments: { filePath: 'a' } },
      { id: 'c2', name: 'Edit', arguments: { filePath: 'b' } },
    ] },
  ];

  vm.runInContext('appendNewMessages([currentMessages[1]], 1)', h.sandbox);

  assert.ok(assistantRow.classList.contains('process-hidden-empty'),
    'tool-call-only assistant row must be hidden via process-hidden-empty in hide mode');
  assert.ok(assistantRow._callCards.every((c) => c.classList.contains('process-hidden')),
    'its call cards must be process-hidden');
});

test('hide mode: empty assistant message patched by updateLastMessage stays hidden', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = false;

  const userRow = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
  userRow.classList.remove('assistant');
  userRow.classList.add('user');
  h.container._entries.push({ row: userRow });

  const assistantRow = makeAssistantRow({ text: '', callCount: 1, msgId: 'msg-1' });
  h.queueRow(assistantRow);
  h.sandbox.currentMessages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }] },
  ];
  vm.runInContext('appendNewMessages([currentMessages[1]], 1)', h.sandbox);
  assert.ok(assistantRow.classList.contains('process-hidden-empty'));

  // Poll patch: the call arguments grew (streaming), content still empty.
  h.sandbox.currentMessages[1].toolCalls[0].arguments = { filePath: 'longer/path' };
  vm.runInContext('updateLastMessage(currentMessages[currentMessages.length - 1])', h.sandbox);

  assert.ok(assistantRow.classList.contains('process-hidden-empty'),
    'patched empty assistant row must remain hidden (no badge-only row)');
});

test('hide mode: assistant row that gains text becomes visible, losing text hides it again', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = false;

  const userRow = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
  userRow.classList.remove('assistant');
  userRow.classList.add('user');
  h.container._entries.push({ row: userRow });

  const assistantRow = makeAssistantRow({ text: '', callCount: 0, msgId: 'msg-1' });
  h.queueRow(assistantRow);
  h.sandbox.currentMessages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '' },
  ];
  vm.runInContext('appendNewMessages([currentMessages[1]], 1)', h.sandbox);
  assert.ok(assistantRow.classList.contains('process-hidden-empty'),
    'textless assistant row must start hidden');

  // Text streams in → row must become visible.
  h.sandbox.currentMessages[1].content = '让我看看';
  vm.runInContext('updateLastMessage(currentMessages[currentMessages.length - 1])', h.sandbox);
  assert.equal(assistantRow.classList.contains('process-hidden-empty'), false,
    'row with streamed text must be visible');

  // Text removed again (edge case) → must re-hide.
  h.sandbox.currentMessages[1].content = '';
  vm.runInContext('updateLastMessage(currentMessages[currentMessages.length - 1])', h.sandbox);
  assert.ok(assistantRow.classList.contains('process-hidden-empty'),
    'row returning to no text must hide again');
});

test('hide mode: toolCalls arriving after birth rebuild the row (cards enter DOM hidden)', () => {
  const h = createHarness();
  h.sandbox.showChatProcess = false;

  const userRow = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
  userRow.classList.remove('assistant');
  userRow.classList.add('user');
  h.container._entries.push({ row: userRow });

  // The message was born empty (no text, no calls yet) — its row has no cards.
  const bornRow = makeAssistantRow({ text: '', callCount: 0, msgId: 'msg-1' });
  h.queueRow(bornRow);
  h.sandbox.currentMessages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '' },
  ];
  vm.runInContext('appendNewMessages([currentMessages[1]], 1)', h.sandbox);
  assert.ok(bornRow.classList.contains('process-hidden-empty'),
    'empty row starts hidden');

  // Streaming race: toolCalls populate on the already-appended message.
  h.sandbox.currentMessages[1].toolCalls = [
    { id: 'c1', name: 'Read', arguments: { filePath: 'a' } },
  ];

  // The rebuild path materializes the fresh row via insertAdjacentHTML.
  const rebuiltRow = makeAssistantRow({ text: '', callCount: 1, msgId: 'msg-1' });
  bornRow.insertAdjacentHTML = () => {
    const i = h.container._entries.findIndex((e) => e.row === bornRow);
    h.container._entries.splice(i, 0, { row: rebuiltRow });
  };
  bornRow.remove = () => {
    const i = h.container._entries.findIndex((e) => e.row === bornRow);
    if (i >= 0) h.container._entries.splice(i, 1);
  };

  vm.runInContext('updateLastMessage(currentMessages[currentMessages.length - 1])', h.sandbox);

  assert.equal(h.container._entries[h.container._entries.length - 1].row, rebuiltRow,
    'the row is replaced in place');
  assert.ok(rebuiltRow.classList.contains('process-hidden-empty'),
    'rebuilt empty row stays hidden (no badge-only row)');
  assert.ok(rebuiltRow._callCards.every((c) => c.classList.contains('process-hidden')),
    'late-arriving call cards enter the DOM pre-hidden');
  assert.equal(bornRow._callCards.length, 0, 'stale row had no cards');
});
