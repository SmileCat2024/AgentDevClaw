/**
 * Tests for the two front-end memory-leak conclusions (public/src, Claw 管线 1420).
 *
 * A. generative-ui chart ResizeObserver leak:
 *    _renderChart creates one ResizeObserver per render. The panel
 *    (generative-ui-panel.js _populateMount) fully replaces the mount content on
 *    every spec revision change / tab switch / agent switch, so old chart
 *    elements become detached while their observers hold them (and the whole SVG
 *    subtree) strongly. Fix under test: the observer self-disconnects once its
 *    element is no longer connected to the document. _renderSparkline has no
 *    observer and must stay untouched.
 *
 * B. Per-context Map growth:
 *    _userCollapseStateByContext (app-core.js) and chatViewportAnchorByContext
 *    (modules/chat-viewport.js) are keyed by the runtime context key — which
 *    embeds sessionId, so one entry per session ever visited — and had no
 *    cleanup path. Fix under test: the LRU eviction branch of
 *    saveCurrentRuntimeToCache drops the same key from both maps, except for
 *    the currently active context.
 *
 * Loads the real sources into vm sandboxes (script-global sharing model, no
 * imports), following frontend-core-helpers.test.js (app-core) and
 * frontend-tool-collapse-windowing.test.js (chat-viewport) patterns.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// ═══════════════════════════════════════════════════════════════
// Part A — generative-ui chart ResizeObserver
// ═══════════════════════════════════════════════════════════════

function makeClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle(name, force) {
      const enable = force === undefined ? !set.has(name) : Boolean(force);
      if (enable) set.add(name); else set.delete(name);
      return enable;
    },
    contains: (name) => set.has(name),
  };
}

// Minimal element stub covering the DOM surface _renderChart touches:
// appendChild / setAttribute / style / classList / dataset / textContent
// (setter clears children, like the real DOM) / isConnected (test-controlled).
function makeChartElement(tag) {
  const el = {
    tagName: tag,
    children: [],
    parentNode: null,
    isConnected: true,
    style: {},
    dataset: {},
    className: '',
    classList: makeClassList(),
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text || ''; },
    set(value) { this._text = value == null ? '' : String(value); this.children = []; },
    configurable: true,
  });
  return el;
}

const roInstances = [];

class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = new Set();
    this.disconnectCalls = 0;
    roInstances.push(this);
  }
  observe(target) { this.observed.add(target); }
  unobserve(target) { this.observed.delete(target); }
  disconnect() { this.disconnectCalls += 1; this.observed.clear(); }
  // Mimic the browser: no delivery after disconnect. Detached elements are
  // delivered with an empty contentRect (0x0), like display:none.
  deliver(target, width) {
    if (this.disconnectCalls > 0) return;
    this.callback.call(this, [{ target, contentRect: { width } }]);
  }
}

function createChartSandbox() {
  roInstances.length = 0;
  const ctx = createFrontendSandbox({
    ResizeObserver: FakeResizeObserver,
    document: {
      createElement: (tag) => makeChartElement(tag),
      createElementNS: (_ns, tag) => makeChartElement(tag),
      createTextNode: (text) => ({ text: String(text) }),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { contains: () => true },
    },
  });
  ctx.loadSource('public/src/modules/generative-ui-renderer.js');
  return ctx;
}

const CHART_SPEC = {
  root: 'chart1',
  elements: {
    chart1: {
      type: 'Chart',
      props: {
        chartType: 'line',
        labels: ['a', 'b', 'c'],
        series: [{ label: 'S', values: [1, 2, 3] }],
      },
    },
  },
};

function firstSvg(el) {
  return el.children.find((child) => child.tagName === 'svg') || null;
}

describe('generative-ui chart ResizeObserver lifecycle', () => {
  it('observes its own element; connected resizes still redraw; detach self-disconnects', () => {
    const ctx = createChartSandbox();
    const chartEl = ctx.renderGenUISpec(CHART_SPEC, {}, {});

    assert.equal(roInstances.length, 1, 'one observer per chart render');
    const observer = roInstances[0];
    assert.equal(observer.observed.size, 1);
    assert.strictEqual([...observer.observed][0], chartEl, 'observed target is the chart element');
    assert.equal(observer.disconnectCalls, 0);

    // While connected, a real-width delivery redraws (behavior unchanged).
    const svgBefore = firstSvg(chartEl);
    assert.ok(svgBefore, 'initial fallback draw produced an svg');
    observer.deliver(chartEl, 600);
    assert.notStrictEqual(firstSvg(chartEl), svgBefore, 'width delivery redraws the chart');
    assert.equal(observer.disconnectCalls, 0, 'connected charts must not disconnect');

    // Panel rebuild detaches the element; the next delivery must self-disconnect.
    chartEl.isConnected = false;
    observer.deliver(chartEl, 0);
    assert.equal(observer.disconnectCalls, 1, 'detached element releases its observer');
    assert.equal(observer.observed.size, 0);
  });

  it('repeated panel rebuilds do not accumulate observed targets (leak regression)', () => {
    const ctx = createChartSandbox();
    let previous = null;
    for (let i = 0; i < 5; i++) {
      if (previous) {
        // generative-ui-panel _populateMount does `mount.innerHTML = ''` — the old
        // chart element leaves the document and the observer is delivered a 0x0
        // entry on the next rendering frame.
        previous.isConnected = false;
        const previousObserver = roInstances[i - 1];
        previousObserver.deliver(previous, 0);
        assert.equal(previousObserver.disconnectCalls, 1,
          `observer #${i - 1} must disconnect after its element was detached`);
      }
      previous = ctx.renderGenUISpec(CHART_SPEC, {}, {});
      previous.isConnected = true; // appended into the freshly rebuilt mount
      roInstances[i].deliver(previous, 400); // initial observe delivery
      assert.equal(roInstances[i].disconnectCalls, 0);
    }
    const liveObserved = roInstances.reduce((sum, obs) => sum + obs.observed.size, 0);
    assert.equal(liveObserved, 1, 'only the current chart stays observed');
  });

  it('undefined isConnected (legacy stub harnesses) keeps the legacy redraw path', () => {
    // Older vm harnesses (e.g. frontend-generative-ui-renderer.test.js) stub
    // elements without an isConnected property. The self-disconnect must only
    // trigger on a definitive false, never on undefined.
    const ctx = createChartSandbox();
    const chartEl = ctx.renderGenUISpec(CHART_SPEC, {}, {});
    const observer = roInstances[0];
    delete chartEl.isConnected;
    observer.deliver(chartEl, 640);
    assert.equal(observer.disconnectCalls, 0, 'undefined must not be treated as detached');
    const svg = firstSvg(chartEl);
    assert.ok(svg, 'chart redraws');
    assert.equal(svg.attrs.viewBox, '0 0 640 220', 'real-width redraw still happens');
  });

  it('sparkline renders without any ResizeObserver (out of fix scope, stays untouched)', () => {
    const ctx = createChartSandbox();
    const spec = {
      root: 's1',
      elements: { s1: { type: 'Sparkline', props: { values: [1, 2, 3, 4] } } },
    };
    const el = ctx.renderGenUISpec(spec, {}, {});
    assert.ok(el, 'sparkline renders');
    assert.equal(roInstances.length, 0, 'sparkline path never creates observers');
  });
});

// ═══════════════════════════════════════════════════════════════
// Part B — per-context Map eviction linkage
// ═══════════════════════════════════════════════════════════════

function createEvictionSandbox() {
  const ctx = createFrontendSandbox({
    // captureChatViewportAnchor requires an active chat surface and non-follow
    // mode to persist a (pixel) anchor per context key.
    isChatSurfaceActive: () => true,
    shouldRenderWorkspaceSurface: () => false,
  });
  // readCurrentSessionViewState lives in modules/session-view-state.js; only
  // its read shape is needed by saveCurrentRuntimeToCache.
  ctx.readCurrentSessionViewState = () => ({
    messages: [],
    inputRequests: [],
    toolRenderConfigs: {},
    toolNames: {},
    hookInspector: null,
    overview: null,
    todoPlan: null,
    sessionMeta: null,
    connected: true,
  });
  ctx.loadSource('public/src/app-core.js');
  ctx.loadSource('public/src/modules/chat-viewport.js');
  ctx.run('followLatestEnabled = false'); // let-bound in app-core.js
  return ctx;
}

// Simulates one session visit: switch focus, activate collapse state,
// persist a viewport anchor, and save the runtime view into the LRU cache.
function activateContext(ctx, runtimeId) {
  ctx.run(`currentRuntimeAgentId = ${JSON.stringify(runtimeId)}`);
  const key = ctx.run(`getRuntimeContextKey(${JSON.stringify(runtimeId)})`);
  ctx.run(`activateUserCollapseStateForContext(${JSON.stringify(key)})`);
  ctx.run(`rememberChatViewportAnchorForContext(${JSON.stringify(key)})`);
  ctx.run(`saveCurrentRuntimeToCache(${JSON.stringify(runtimeId)}, ${JSON.stringify(key)})`);
  return key;
}

describe('per-context map eviction linkage', () => {
  it('context key embeds sessionId (host form) and falls back to runtime form', () => {
    const ctx = createEvictionSandbox();
    // No session binding / host record → runtime-id keyed context.
    assert.equal(ctx.run('getRuntimeContextKey("rt-1")'), 'runtime:rt-1');
    // With a host + viewer session binding the key is host|session — one entry
    // per session, which is what makes the maps grow with session creation.
    ctx.run('focusedAgentId = "hostA"');
    ctx.run('setViewerSessionBinding("rt-9", "sess-9")');
    assert.equal(ctx.run('getRuntimeContextKey("rt-9")'), 'host:hostA|session:sess-9');
  });

  it('LRU eviction of a runtime view drops the same key from both per-context maps', () => {
    const ctx = createEvictionSandbox();
    for (const rt of ['rt-1', 'rt-2', 'rt-3', 'rt-4']) activateContext(ctx, rt);
    assert.equal(ctx.run('_agentRuntimeCache.size'), 4);
    assert.equal(ctx.run('_userCollapseStateByContext.size'), 4);
    assert.equal(ctx.run('chatViewportAnchorByContext.size'), 4);

    // 5th context evicts the least-recently-saved entry (runtime:rt-1) and must
    // clean up its bystander state too.
    activateContext(ctx, 'rt-5');
    assert.equal(ctx.run('_agentRuntimeCache.size'), 4);
    assert.equal(ctx.run('_agentRuntimeCache.has("runtime:rt-1")'), false);
    assert.equal(ctx.run('_userCollapseStateByContext.has("runtime:rt-1")'), false,
      'evicted context must drop its collapse state');
    assert.equal(ctx.run('chatViewportAnchorByContext.has("runtime:rt-1")'), false,
      'evicted context must drop its viewport anchor');
    for (const rt of ['rt-2', 'rt-3', 'rt-4', 'rt-5']) {
      assert.equal(ctx.run(`_userCollapseStateByContext.has("runtime:${rt}")`), true,
        `survivor ${rt} keeps its collapse state`);
      assert.equal(ctx.run(`chatViewportAnchorByContext.has("runtime:${rt}")`), true,
        `survivor ${rt} keeps its viewport anchor`);
    }
  });

  it('never deletes the collapse state / anchor of the currently active context', () => {
    const ctx = createEvictionSandbox();
    for (const rt of ['rt-1', 'rt-2', 'rt-3', 'rt-4']) activateContext(ctx, rt);
    // Focus is back on the oldest cached context; saving another runtime evicts
    // runtime:rt-1 from the LRU cache, but it is the active context.
    ctx.run('currentRuntimeAgentId = "rt-1"');
    ctx.run('activateUserCollapseStateForContext("runtime:rt-1")');
    ctx.run('saveCurrentRuntimeToCache("rt-5", "runtime:rt-5")');

    assert.equal(ctx.run('_agentRuntimeCache.has("runtime:rt-1")'), false,
      'cache eviction still happens');
    assert.equal(ctx.run('_userCollapseStateByContext.has("runtime:rt-1")'), true,
      'active context collapse state is preserved');
    assert.equal(ctx.run('chatViewportAnchorByContext.has("runtime:rt-1")'), true,
      'active context viewport anchor is preserved');
  });
});
