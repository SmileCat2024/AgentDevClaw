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
 *
 * 装载路线（P2）：classic 侧按 index.html 真实加载序跑 action-dispatcher →
 * i18n → app-core → chat-viewport → input-helpers → chat-renderer（同名全局函数就是生产入口，
 * 经 `c.read` 调用）；lazy-tool-content / chat-row-visibility 已迁 ESM，经
 * `c.load` 真实 import，classic 消费面由生产兼容桥 p2-w2-1-chat-windowing-host
 * 提供。过程可见性状态经 app-core 的 chatSurface host 读写（既有 seam）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';

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
    closest: selector => selector === '.message-row' ? row : null,
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
    if (sel === '.tool-call-container') return callCards[0] || null;
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

function createRig() {
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
  container.querySelector = (selector) => {
    if (selector === '.message-row') return container._entries[0]?.row || null;
    const match = /^#msg-\d+$/.test(selector);
    return match ? container._entries.map(e => e.row.querySelector('.message-content'))
      .find(content => '#' + content.id === selector) || null : null;
  };
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

  const elements = new Map();
  const elementStub = (id) => ({
    id, innerHTML: '', textContent: '', style: {},
    classList: makeClassList(), dataset: {},
    clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollTop: 0, parentElement: null,
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  });
  const document = {
    activeElement: null,
    readyState: 'complete',
    getElementById(id) {
      if (id === 'chat-container') return container;
      if (!elements.has(id)) elements.set(id, elementStub(id));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: () => elementStub('created'),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {},
    body: elementStub('body'), head: elementStub('head'), documentElement: elementStub('html'),
  };

  const timers = new Map();
  let seq = 1;
  const fakeTimers = {
    setTimeout(callback) { const id = seq++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { const id = seq++; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
    requestAnimationFrame() { return seq++; },
    cancelAnimationFrame() {},
  };

  return {
    container, document, fakeTimers,
    queueRow(row) { pendingRows.push({ row }); },
  };
}

async function withHarness({ messages } = {}, fn) {
  const rig = createRig();
  const counters = { fullRenders: 0 };
  // currentMessages 的唯一真源是 app-core 装载期注册的桥键；会话视图读取面
  // 绑定到同一 owner（不读初始数组副本）。
  const live = { readMessages: () => [] };
  const globals = {
    document: rig.document,
    // markdown-bootstrap 装载期需要 vendor 的 marked（renderer 由它自建）。
    marked: { Renderer: class { constructor() {} }, setOptions() {}, parse: (value) => String(value ?? '') },
    // input-actions 已 import 真实 poll 模块（poll-coordinator-host）：按生产
    // 宿主 seam 提供最小面，本文件不驱动轮询、不再保留 window.poll 桩。
    createPollCoordinatorHost: () => ({
      run: () => Promise.resolve(),
      fastInterval: () => 2000,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id),
    }),
    CSS: { supports: () => true },
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    shouldShowChatWelcome: () => false,
    // 以下是仍需晚绑定的 classic 宿主函数；渲染依赖（markdown-utils /
    // template-engine / message-timeline / tool-progress）已由 chat-renderer 静态
    // import，夹具不再为它们留桩。
    escapeHtml: (v) => String(v ?? ''),
    t: (k) => k,
    switchAgent() {},
    ensureChatRuntimeIndicator() {},
    getEmptyStateHtml: () => '<div class="empty-state">empty</div>',
    renderChatEmptyState() {},
    readCurrentSessionViewState: () => ({ messages: live.readMessages(), inputRequests: [] }),
    // message-timeline.js：时间分隔线包装（无时间锚场景透传行 html）
  };
  return withP2EsmCase({
    classic: (sandbox) => {
      // chat-renderer 的 import 链触达整条装载期宿主工厂链：按生产先行脚本序整链
      // 装载（boot 体与周期排程由基座关掉），再补 markdown-bootstrap
      // （markdown-utils 求值期捕获 escapeHtml / renderer / marked）。
      prepareClassicSandbox(sandbox);
      sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
      // 夹具的确定性计时器 / rAF 必须晚于基座落位（基座会关闭 rAF 与周期排程）。
      Object.assign(sandbox, rig.fakeTimers);
    },
    globals,
  }, async (c) => {
    await c.load('public/src/modules/chat-renderer.js');
    await c.load('public/src/modules/chat-viewport.js');
    // chat-viewport 的 import 链把 markdown-utils 的真实实现带进来（并注册其桥键），
    // 会覆盖 globals 里同名桩；本文件的观测面要求桩生效，故在装载后重新落一遍。
    Object.assign(c.window, globals);
    // input-helpers 已迁 ESM（P4 T2）：真实 import 装载，桥键由模块自身注册。
    await c.load('public/src/modules/input-helpers.js');
    const surface = c.window.createP2BootstrapChatSurfaceHost();
    surface.showChatProcess = true;
    surface.followLatestEnabled = false;
    c.window.currentMessages = messages || [];
    live.readMessages = () => c.window.currentMessages;
    c.window.allAgents = [];
    c.window.toolRenderConfigs = {};
    c.window.currentInputRequests = [];
    c.window._lastRenderedChatSig = '';
    c.window.renderCurrentMainView = () => { counters.fullRenders += 1; };
    await c.load('public/src/modules/p2-w2-1-chat-windowing-host.js');
    // 输入面域（本批迁 ESM）：回退按钮可见性与过程显隐的真实实现
    await c.load('public/src/modules/input-actions.js');
    await c.load('public/src/modules/chat-process-visibility.js');
    const mod = await c.load(LAZY_TOOL_CONTENT);
    mod.setProcessWindowingDisabled(true);
    return fn(Object.assign(rig, {
      setShowChatProcess: (value) => { surface.showChatProcess = value; },
      messages: () => c.window.currentMessages,
      setMessages: (value) => { c.window.currentMessages = value; },
      fullRenders: () => counters.fullRenders,
      applyProcessState: () => c.read('applyConversationProcessState(container)'),
      append: (messageIndex, startIndex) => c.read(`appendNewMessages([currentMessages[${messageIndex}]], ${startIndex})`),
      updateLast: () => c.read('updateLastMessage(currentMessages[currentMessages.length - 1])'),
      setProcessWindowingDisabled: (value) => mod.setProcessWindowingDisabled(value),
    }));
  });
}

function addGroupedPrefix(h) {
  const user = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
  user.classList.remove('assistant');
  user.classList.add('user');
  // Production render() projects two errors into one row with no msg-N element.
  const group = makeAssistantRow({ text: 'two errors' });
  h.container._entries.push({ row: user }, { row: group });
  h.setMessages([
    { role: 'user', content: 'hi' },
    ...['first', 'second'].map(content => ({ role: 'assistant', content,
      execution: { status: 'failed', error: { category: 'server_error' } } })),
  ]);
  return { user, group };
}

for (const show of [false, true]) {
  test(`grouped prefix: append and tail text updates use DOM row positions (show=${show})`, async () => {
    await withHarness({}, (h) => {
      h.setShowChatProcess(show);
      addGroupedPrefix(h);
      h.setProcessWindowingDisabled(true);
      h.applyProcessState();
      const row = makeAssistantRow({ callCount: 1, msgId: 'msg-3' });
      h.queueRow(row);
      const message = { role: 'assistant', content: '',
        toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }] };
      h.messages().push(message);
      h.append(3, 3);
      assert.equal(row._callCards[0].classList.contains('process-hidden'), !show,
        'show mode must reveal the appended call card without a process toggle');
      assert.equal(row.classList.contains('process-hidden-empty'), !show);

      message.content = 'streamed text';
      h.updateLast();
      assert.equal(h.fullRenders(), 0, 'tail patch must find msg-3 in DOM row 2');
      assert.equal(row._markdownBody.textContent, 'streamed text');
      assert.equal(row.classList.contains('process-hidden-empty'), false);
      message.content = '';
      h.updateLast();
      assert.equal(row.classList.contains('process-hidden-empty'), !show);
    });
  });
}

for (const show of [false, true]) {
  test(`grouped prefix: late toolCalls rebuild the live tail row (show=${show})`, async () => {
    await withHarness({}, (h) => {
      h.setShowChatProcess(show);
      addGroupedPrefix(h);
      h.setProcessWindowingDisabled(true);
      h.applyProcessState();
      const born = makeAssistantRow({ msgId: 'msg-3' });
      h.queueRow(born);
      const message = { role: 'assistant', content: '' };
      h.messages().push(message);
      h.append(3, 3);
      const rebuilt = makeAssistantRow({ callCount: 1, msgId: 'msg-3' });
      born.insertAdjacentHTML = () => {
        h.container._entries.splice(2, 0, { row: rebuilt });
      };
      born.remove = () => {
        const i = h.container._entries.findIndex(e => e.row === born);
        h.container._entries.splice(i, 1);
      };
      message.toolCalls = [{ id: 'c1', name: 'Read', arguments: {} }];
      h.updateLast();
      assert.equal(h.container._entries[2].row, rebuilt);
      assert.equal(rebuilt._callCards[0].classList.contains('process-hidden'), !show);
      assert.equal(rebuilt.classList.contains('process-hidden-empty'), !show);
    });
  });
}

test('grouped prefix: appended call cards settle their collapse state at birth', async () => {
  await withHarness({}, (h) => {
    h.setShowChatProcess(true);
    addGroupedPrefix(h);
    h.setProcessWindowingDisabled(true);
    h.applyProcessState();
    const row = makeAssistantRow({ callCount: 1, msgId: 'msg-3' });
    row.querySelector('.message-content').scrollHeight = 500;
    h.queueRow(row);
    const message = { role: 'assistant', content: '',
      toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }] };
    h.messages().push(message);
    h.append(3, 3);
    assert.equal(row.querySelector('.message-content').classList.contains('collapsed'), true,
      'collapse scan must start at the actual appended DOM row');
  });
});

test('hide mode: tool-call-only assistant message appended must be fully hidden', async () => {
  await withHarness({}, (h) => {
    h.setShowChatProcess(false); // hide mode

    const userRow = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
    userRow.classList.remove('assistant');
    userRow.classList.add('user');
    h.container._entries.push({ row: userRow });

    const assistantRow = makeAssistantRow({ text: '', callCount: 2, msgId: 'msg-1' });
    h.queueRow(assistantRow);
    h.setMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [
        { id: 'c1', name: 'Read', arguments: { filePath: 'a' } },
        { id: 'c2', name: 'Edit', arguments: { filePath: 'b' } },
      ] },
    ]);

    h.append(1, 1);

    assert.ok(assistantRow.classList.contains('process-hidden-empty'),
      'tool-call-only assistant row must be hidden via process-hidden-empty in hide mode');
    assert.ok(assistantRow._callCards.every((c) => c.classList.contains('process-hidden')),
      'its call cards must be process-hidden');
  });
});

test('hide mode: empty assistant message patched by updateLastMessage stays hidden', async () => {
  await withHarness({}, (h) => {
    h.setShowChatProcess(false);

    const userRow = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
    userRow.classList.remove('assistant');
    userRow.classList.add('user');
    h.container._entries.push({ row: userRow });

    const assistantRow = makeAssistantRow({ text: '', callCount: 1, msgId: 'msg-1' });
    h.queueRow(assistantRow);
    h.setMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }] },
    ]);
    h.append(1, 1);
    assert.ok(assistantRow.classList.contains('process-hidden-empty'));

    // Poll patch: the call arguments grew (streaming), content still empty.
    h.messages()[1].toolCalls[0].arguments = { filePath: 'longer/path' };
    h.updateLast();

    assert.ok(assistantRow.classList.contains('process-hidden-empty'),
      'patched empty assistant row must remain hidden (no badge-only row)');
  });
});

test('hide mode: assistant row that gains text becomes visible, losing text hides it again', async () => {
  await withHarness({}, (h) => {
    h.setShowChatProcess(false);

    const userRow = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
    userRow.classList.remove('assistant');
    userRow.classList.add('user');
    h.container._entries.push({ row: userRow });

    const assistantRow = makeAssistantRow({ text: '', callCount: 0, msgId: 'msg-1' });
    h.queueRow(assistantRow);
    h.setMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
    ]);
    h.append(1, 1);
    assert.ok(assistantRow.classList.contains('process-hidden-empty'),
      'textless assistant row must start hidden');

    // Text streams in → row must become visible.
    h.messages()[1].content = '让我看看';
    h.updateLast();
    assert.equal(assistantRow.classList.contains('process-hidden-empty'), false,
      'row with streamed text must be visible');

    // Text removed again (edge case) → must re-hide.
    h.messages()[1].content = '';
    h.updateLast();
    assert.ok(assistantRow.classList.contains('process-hidden-empty'),
      'row returning to no text must hide again');
  });
});

test('hide mode: toolCalls arriving after birth rebuild the row (cards enter DOM hidden)', async () => {
  await withHarness({}, (h) => {
    h.setShowChatProcess(false);

    const userRow = makeAssistantRow({ text: 'hi', msgId: 'msg-0' });
    userRow.classList.remove('assistant');
    userRow.classList.add('user');
    h.container._entries.push({ row: userRow });

    // The message was born empty (no text, no calls yet) — its row has no cards.
    const bornRow = makeAssistantRow({ text: '', callCount: 0, msgId: 'msg-1' });
    h.queueRow(bornRow);
    h.setMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
    ]);
    h.append(1, 1);
    assert.ok(bornRow.classList.contains('process-hidden-empty'),
      'empty row starts hidden');

    // Streaming race: toolCalls populate on the already-appended message.
    h.messages()[1].toolCalls = [
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

    h.updateLast();

    assert.equal(h.container._entries[h.container._entries.length - 1].row, rebuiltRow,
      'the row is replaced in place');
    assert.ok(rebuiltRow.classList.contains('process-hidden-empty'),
      'rebuilt empty row stays hidden (no badge-only row)');
    assert.ok(rebuiltRow._callCards.every((c) => c.classList.contains('process-hidden')),
      'late-arriving call cards enter the DOM pre-hidden');
    assert.equal(bornRow._callCards.length, 0, 'stale row had no cards');
  });
});
