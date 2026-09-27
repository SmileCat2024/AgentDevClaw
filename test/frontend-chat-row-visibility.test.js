import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/src/modules/chat-row-visibility.js', import.meta.url), 'utf8');
const distant = 'chat-row-distant';

function createView({ count = 300, supported = true } = {}) {
  const reads = { geometry: 0, queries: 0 };
  let writes = 0, sequence = 0, captureCount = 0, restoreCount = 0;
  const frames = new Map(), listeners = new Map();
  const container = {
    scrollTop: 10000, clientHeight: 600, clientWidth: 1200,
    querySelectorAll() { reads.queries++; return rows; },
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const rows = Array.from({ length: count }, (_, i) => {
    const classes = new Set(), properties = new Map();
    return {
      actualHeight: 30 + (i % 7) * 11, isConnected: true,
      classList: {
        contains: name => classes.has(name),
        add(name) { writes++; classes.add(name); },
        remove(name) { writes++; classes.delete(name); },
      },
      style: {
        setProperty(name, value) { writes++; properties.set(name, value); },
        removeProperty(name) { writes++; properties.delete(name); },
        getPropertyValue: name => properties.get(name) || '',
      },
      contains: element => element === rows[i],
      getBoundingClientRect() { reads.geometry++; return { height: this.actualHeight }; },
      get offsetTop() { reads.geometry++; return topOf(i); },
    };
  });
  function heightOf(row) {
    return row.classList.contains(distant)
      ? parseFloat(row.style.getPropertyValue('--chat-row-height')) : row.actualHeight;
  }
  function topOf(index) {
    return rows.slice(0, index).reduce((sum, row) => sum + heightOf(row) + 8, 0);
  }
  function geometry() {
    return rows.map((row, i) => [topOf(i), heightOf(row)]);
  }
  const sandbox = {
    window: {}, container, document: { activeElement: null },
    CSS: { supports: () => supported },
    showChatProcess: true, _windowingDisabled: true, _windowingFrozen: false,
    followLatestEnabled: false,
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    runWithSuppressedChatViewportObservers: callback => callback(),
    captureChatViewportAnchor() {
      captureCount++;
      const index = rows.findIndex((row, i) => topOf(i) + heightOf(row) > container.scrollTop);
      return { index, offset: container.scrollTop - topOf(index) };
    },
    applyChatViewportAnchor(anchor) {
      restoreCount++;
      container.scrollTop = topOf(anchor.index) + anchor.offset;
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'chat-row-visibility.js' });
  function pump() {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach(callback => callback());
  }
  function queueScroll(top) { container.scrollTop = top; listeners.get('scroll')(); }
  function scroll(top) { queueScroll(top); pump(); }
  return {
    rows, container, sandbox, geometry, topOf, scroll, queueScroll, frames,
    refresh: reason => sandbox.window.refreshMeasuredChatRows(reason),
    clear: () => sandbox.window.clearMeasuredChatRows(),
    counters: () => ({ ...reads, writes, captureCount, restoreCount }),
    resetCounters() { reads.geometry = 0; reads.queries = 0; writes = 0; },
    emitLoad: target => listeners.get('load')({ target }),
  };
}

test('distant rows keep measured heights and DOM identities across window changes', () => {
  const view = createView();
  const originalGeometry = view.geometry(), originalRows = [...view.rows];
  view.refresh('render-full');
  assert.deepEqual(view.geometry(), originalGeometry);
  assert(view.rows.filter(row => row.classList.contains(distant)).length > 200);
  const nearby = view.rows.findIndex((row, i) => view.topOf(i) >= view.container.scrollTop);
  assert.equal(view.rows[nearby].classList.contains(distant), false);
  view.scroll(3000);
  assert.deepEqual(view.geometry(), originalGeometry);
  view.rows.forEach((row, i) => assert.equal(row, originalRows[i]));
  assert.equal(view.rows[nearby].classList.contains(distant), true);
});

test('ordinary scrolling within the buffered window reads no row geometry and writes no styles', () => {
  const view = createView();
  view.refresh('render-full'); view.resetCounters();
  for (let i = 1; i <= 10; i++) view.scroll(10000 + i * 35);
  assert.deepEqual(view.counters(), { geometry: 0, queries: 0, writes: 0, captureCount: 0, restoreCount: 0 });
  view.scroll(3000);
  assert.equal(view.counters().geometry, 0);
  assert.equal(view.counters().queries, 0);
  assert(view.counters().writes > 0);
});

test('patching an offscreen tail updates its real height without realizing all history', () => {
  const view = createView();
  view.refresh('render-full');
  const tail = view.rows.at(-1), before = view.geometry();
  assert(tail.classList.contains(distant));
  tail.actualHeight += 420;
  view.refresh('patch-last');
  assert.equal(view.geometry().at(-1)[1], tail.actualHeight);
  assert.deepEqual(view.geometry().slice(0, -1), before.slice(0, -1));
  assert(tail.classList.contains(distant));
  assert(view.rows.filter(row => row.classList.contains(distant)).length > 200);
});

test('width changes wait for unfreeze and preserve the same reading anchor', () => {
  const view = createView();
  view.refresh('render-full');
  view.sandbox._windowingFrozen = true;
  view.container.clientWidth = 900;
  view.rows.forEach(row => { row.actualHeight += 20; });
  view.resetCounters(); view.refresh('resize');
  assert.equal(view.counters().geometry, 0);
  // Visible content can already wrap while dragging; preserve the anchor
  // at release when removing distant rows' old width-dependent height locks.
  const index = view.geometry().findIndex(([top, height]) => top + height > view.container.scrollTop);
  const offset = view.container.scrollTop - view.topOf(index);
  view.sandbox._windowingFrozen = false; view.refresh('width-settled');
  assert.equal(view.counters().captureCount, 1);
  assert.equal(view.counters().restoreCount, 1);
  assert.equal(view.container.scrollTop - view.topOf(index), offset);
  view.geometry().forEach(([, height], i) => assert.equal(height, view.rows[i].actualHeight));
});

test('explicit expansion and image load can reveal and remeasure a distant row', () => {
  const view = createView();
  view.refresh('render-full');
  const row = view.rows[2];
  assert(row.classList.contains(distant));
  view.sandbox.window.revealMeasuredChatRow(row);
  assert.equal(row.classList.contains(distant), false);
  row.actualHeight += 80;
  view.refresh('toggle-message');
  assert.equal(view.geometry()[2][1], row.actualHeight);
  row.actualHeight += 120;
  view.emitLoad({ tagName: 'IMG', closest: () => row });
  assert.equal(view.geometry()[2][1], row.actualHeight);
});

test('focused content remains available outside the window', () => {
  const view = createView();
  view.sandbox.document.activeElement = view.rows[0];
  view.refresh('render-full'); view.scroll(18000);
  assert.equal(view.rows[0].classList.contains(distant), false);
  assert.equal(view.rows[1].classList.contains(distant), true);
});

test('process off and estimated window mode release height locks and pending scroll work', () => {
  for (const flag of ['showChatProcess', '_windowingDisabled']) {
    const view = createView();
    const original = view.geometry(); view.refresh('render-full');
    view.queueScroll(view.container.scrollTop + 5000);
    assert.equal(view.frames.size, 1);
    view.sandbox[flag] = false; view.refresh('mode-change');
    assert.equal(view.frames.size, 0);
    assert.deepEqual(view.geometry(), original);
    view.rows.forEach(row => {
      assert.equal(row.classList.contains(distant), false);
      assert.equal(row.style.getPropertyValue('--chat-row-height'), '');
    });
    view.resetCounters(); view.scroll(0);
    assert.equal(view.counters().writes, 0);
  }
});

test('unsupported browsers and short conversations keep their normal layout', () => {
  for (const options of [{ supported: false }, { count: 100 }]) {
    const view = createView(options), original = view.geometry();
    view.refresh('render-full');
    assert.deepEqual(view.geometry(), original);
    assert.equal(view.counters().geometry, 0);
    assert.equal(view.counters().writes, 0);
  }
});
