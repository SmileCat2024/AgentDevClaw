import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const viewportSource = fs.readFileSync(
  new URL('../public/src/modules/chat-viewport.js', import.meta.url),
  'utf8',
);
const navSource = fs.readFileSync(
  new URL('../public/src/modules/chat-nav-timeline.js', import.meta.url),
  'utf8',
);

function createHarness() {
  const timers = new Map();
  const cancelledRafs = [];
  const targetRow = {
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
    },
    closest(selector) {
      return selector === '.message-row' ? targetRow : null;
    },
    getBoundingClientRect() {
      return { top: 180 };
    },
  };
  const targetMessage = {
    id: 'msg-7',
    closest(selector) {
      return selector === '.message-row' ? targetRow : null;
    },
    getBoundingClientRect() {
      return { top: 180 };
    },
  };
  const container = {
    _scrollTop: 900,
    clientHeight: 600,
    scrollHeight: 3000,
    parentElement: {
      getBoundingClientRect() { return { top: 0 }; },
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { top: 100 }; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(container, 'scrollTop', {
    get() { return container._scrollTop; },
    set(value) { container._scrollTop = Number(value); },
  });

  const navTimeline = {
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    style: { setProperty() {} },
  };
  const navCard = {
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    addEventListener() {},
  };
  const document = {
    readyState: 'loading',
    getElementById(id) {
      if (id === 'chat-nav-timeline') return navTimeline;
      if (id === 'chat-nav-card') return navCard;
      if (id === 'msg-7') return targetMessage;
      return null;
    },
    addEventListener() {},
    body: { contains() { return true; } },
  };

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Promise,
    document,
    window: { addEventListener() {} },
    container,
    currentMessages: [{ role: 'user', content: 'target' }],
    followLatestEnabled: true,
    suppressFollowScrollEvent: false,
    lastManualScrollIntentAt: 0,
    _progScrollCooldownUntil: 0,
    followLatestEntryUntil: 0,
    chatViewportObserversReady: false,
    chatViewportObserverSuppressDepth: 0,
    chatViewportObserverQuietUntil: 0,
    chatViewportMutationObserver: null,
    chatViewportResizeObserver: null,
    chatViewportSettlementToken: 0,
    chatViewportSettlementRaf: 41,
    chatViewportSettlementTimer: 42,
    chatViewportSettlementContext: { reasons: new Set(['append']) },
    chatViewportFollowRaf: 43,
    chatViewportFollowToken: 0,
    chatViewportFollowTransition: 'smooth',
    followLatestButton: null,
    workspaceTabsBar: null,
    assemblySideRailRevealTimer: null,
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
    escapeHtml: (value) => String(value),
    t: (key) => key,
    ResizeObserver: class { observe() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame() { return 99; },
    cancelAnimationFrame(id) { cancelledRafs.push(id); },
    setTimeout(callback) {
      const id = timers.size + 1;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };

  vm.createContext(sandbox);
  vm.runInContext(`${viewportSource}\n${navSource}\n` +
    'globalThis.__setupNav = () => { _navUserIndices = [7]; };\n' +
    'globalThis.__clickNav = _onBarClick;\n', sandbox);
  sandbox.__setupNav();

  return { sandbox, container, cancelledRafs };
}

test('clicking the conversation navigation cancels follow-latest before jumping', () => {
  const harness = createHarness();
  harness.sandbox.__clickNav(0);

  assert.equal(
    harness.sandbox.followLatestEnabled,
    false,
    'navigation click must turn off follow-latest',
  );
  assert.deepEqual(
    harness.cancelledRafs.sort((a, b) => a - b),
    [41, 43],
    'navigation click must cancel both settlement and follow animation frames',
  );
  assert.equal(
    harness.sandbox.chatViewportSettlementContext,
    null,
    'navigation click must clear the pending settlement context',
  );
  assert.equal(
    harness.container.scrollTop,
    964,
    'navigation click must still place the target row at the navigation offset',
  );
});
