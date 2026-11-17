/**
 * Tests for the follow-latest animation vs streaming-append interaction.
 *
 * Decision (F1, 2026-08-19): 滚动过程不闪 — while the follow animation is
 * cruising in smooth mode, an incoming streaming append must NOT hard-lock the
 * viewport to the new bottom in a single frame (the old behavior produced a
 * visible flash-jump, e.g. 300px in one frame vs the animation's 84px/frame
 * cap). Instead the animation keeps chasing the new bottom frame by frame.
 * The animation's own distance>360 hard-jump fallback still applies, so a
 * burst of content cannot outrun the animation forever.
 *
 * 装载路线（P4 T2 批次）：chat-viewport 已迁 ESM，经 withP2EsmCase 的 `c.load`
 * 真实 import；classic 相装真实 app-core（视口状态 owner + 两个 bootstrap host
 * 工厂）。沙箱的计时器 / rAF 换成确定性队列，ESM 侧的 `setTimeout` /
 * `requestAnimationFrame` 由 case 的平台全局注入走同一队列——两者是同一份时间源。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const CHAT_VIEWPORT = 'public/src/modules/chat-viewport.js';
const CLIENT_HEIGHT = 600;

async function withFollowHarness(fn) {
  const container = {
    _scrollTop: 0,
    _rows: [],
    _timeline: [],
    clientHeight: CLIENT_HEIGHT,
    scrollHeight: CLIENT_HEIGHT,
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll(selector) {
      return selector === '.message-row' ? container._rows : [];
    },
  };
  Object.defineProperty(container, 'scrollTop', {
    get() { return container._scrollTop; },
    set(value) {
      const next = Math.max(
        0,
        Math.min(Number(value) || 0, container.scrollHeight - container.clientHeight),
      );
      container._timeline.push({ from: container._scrollTop, to: next });
      container._scrollTop = next;
    },
  });
  const document = {
    activeElement: null,
    readyState: 'complete',
    getElementById(id) {
      if (id === 'chat-container') return container;
      if (id === 'follow-latest-btn') return { classList: { toggle() {}, contains: () => false }, innerHTML: '' };
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement: () => ({ style: {}, classList: { add() {}, contains: () => false }, setAttribute() {}, appendChild() {} }),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {},
    body: { contains: () => false }, head: {}, documentElement: {},
  };

  const timers = new Map();
  let timerSeq = 1;
  const rafCallbacks = new Map();
  const rafOrder = [];
  let rafSeq = 1;
  const fakeTimers = {
    setTimeout(callback) { const id = timerSeq++; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = rafSeq++; rafCallbacks.set(id, callback); rafOrder.push(id); return id; },
    cancelAnimationFrame(id) {
      rafCallbacks.delete(id);
      const index = rafOrder.indexOf(id);
      if (index >= 0) rafOrder.splice(index, 1);
    },
  };

  const flushTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((callback) => callback());
  };
  const pumpFrame = () => {
    const ids = rafOrder.splice(0);
    ids.forEach((id) => {
      const callback = rafCallbacks.get(id);
      rafCallbacks.delete(id);
      if (callback) callback();
    });
  };
  const pump = (frames) => {
    flushTimers();
    for (let frame = 0; frame < frames; frame += 1) {
      pumpFrame();
      flushTimers();
    }
  };
  const setRows = (count) => {
    container._rows = Array.from({ length: count }, () => ({
      classList: { contains: () => false },
    }));
    container.scrollHeight = count > 0 ? count * 100 : CLIENT_HEIGHT;
  };
  const maxAbsStep = (from = 0) => container._timeline
    .slice(from)
    .filter((e) => e.to !== e.from)
    .reduce((acc, e) => Math.max(acc, Math.abs(e.to - e.from)), 0);

  return withP2EsmCase({
    classic: (sandbox) => {
      Object.assign(sandbox, fakeTimers);
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      sandbox.loadSource('public/src/app-core.js');
    },
    globals: {
      document,
      escapeHtml: (value) => String(value),
      isChatSurfaceActive: () => true,
      shouldRenderWorkspaceSurface: () => false,
      MutationObserver: class { observe() {} unobserve() {} disconnect() {} },
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    },
  }, async (c) => {
    const viewport = await c.load(CHAT_VIEWPORT);
    return fn({ c, viewport, container, pump, setRows, maxAbsStep });
  });
}

test('a streaming append does not interrupt the cruising follow animation (F1)', async () => {
  await withFollowHarness((h) => {
    h.setRows(20);                 // scrollHeight 2000, maxTop 1400
    h.container.scrollTop = 1200;  // 200px above the bottom → animation band (64, 240]
    const setupEnd = h.container._timeline.length;

    h.viewport.setFollowLatest(true, { scroll: true, behavior: 'smooth' }); // real follow button params
    h.pump(6); // settle (3 stable frames) + a few animation steps

    const distanceBefore = h.container.scrollHeight - h.container.scrollTop - h.container.clientHeight;
    assert.ok(distanceBefore > 0 && distanceBefore < 200, `animation should be mid-flight, distance=${distanceBefore}`);
    assert.equal(h.viewport.isFollowLatestAnimationCruising(), true, 'follow animation should be cruising');

    // Streaming append arrives mid-flight (real appendNewMessages notify params).
    const topBeforeAppend = h.container.scrollTop;
    h.setRows(22);                 // +200px content, new bottom = 1600
    h.viewport.notifyChatViewportMutation({
      reason: 'append',
      shouldFollow: true,
      preserveTop: null,
      allowChase: false,
      preferSmooth: false,
      forceSnap: false,
    });

    assert.equal(
      h.container.scrollTop,
      topBeforeAppend,
      'append must not hard-lock the viewport synchronously (F1 flash-jump regression)',
    );

    h.pump(40); // let the animation chase and land
    assert.equal(h.container.scrollTop, 1600, 'must land exactly at the new bottom');
    assert.ok(
      h.maxAbsStep(setupEnd) <= 84 + 1e-6,
      `every frame step must stay within the animation cap (84px), max=${h.maxAbsStep(setupEnd)}`,
    );
  });
});

test('a burst append larger than the 360px fallback still catches up in one step', async () => {
  await withFollowHarness((h) => {
    h.setRows(20);
    h.container.scrollTop = 1200;
    h.viewport.setFollowLatest(true, { scroll: true, behavior: 'smooth' });
    h.pump(6);
    assert.equal(h.viewport.isFollowLatestAnimationCruising(), true);

    const timelineStart = h.container._timeline.length;
    h.setRows(45); // +2500px in one poll → distance far beyond 360
    h.viewport.notifyChatViewportMutation({
      reason: 'append',
      shouldFollow: true,
      preserveTop: null,
      allowChase: false,
      preferSmooth: false,
      forceSnap: false,
    });

    h.pump(40);
    assert.equal(h.container.scrollTop, 3900, 'fallback must land at the new bottom');
    const maxStep = h.maxAbsStep(timelineStart);
    assert.ok(maxStep > 360, `fast stream must trigger the hard-jump fallback, maxStep=${maxStep}`);
  });
});
