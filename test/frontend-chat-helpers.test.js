/**
 * Tests for public/src/modules/chat-scroll.js
 *
 * Covers pure/near-pure functions:
 *   - normalizeWheelDeltaY (wheel event deltaY normalization)
 *   - canElementScrollVertically (vertical scroll capability check)
 *   - hasScrollableWheelTarget (scrollable ancestor detection)
 *   - isChromeWithoutEdge (browser UA detection)
 *   - shouldUseManualWheelScroll (stateful manual scroll decision)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * Create a sandbox with chat-scroll.js loaded.
 *
 * chat-scroll.js expects several globals defined in app-core.js:
 *   container, followLatestButton (DOM elements)
 * Plus browser APIs: WheelEvent, navigator, Element
 *
 * The module also registers event listeners on container/followLatestButton
 * at load time, but the sandbox stubs make addEventListener a no-op.
 */
function loadChatScroll(opts = {}) {
  const containerStub = {
    addEventListener() {},
    clientHeight: opts.containerHeight ?? 600,
    scrollHeight: opts.containerScrollHeight ?? 1000,
    scrollTop: 0,
    querySelector() { return null; },
    getBoundingClientRect() { return { top: 0 }; },
  };

  const ctx = createFrontendSandbox({
    container: containerStub,
    followLatestButton: { addEventListener() {} },
    WheelEvent: {
      DOM_DELTA_LINE: 1,
      DOM_DELTA_PAGE: 2,
      DOM_DELTA_PIXEL: 0,
    },
    navigator: { userAgent: opts.userAgent ?? '' },
    Element: function Element() {},
    isChatSurfaceActive: opts.isChatSurfaceActive ?? (() => false),
    getComputedStyle: () => ({ overflowY: opts.overflowY ?? 'auto' }),
  });
  // window.getComputedStyle is used inside canElementScrollVertically
  ctx.window.getComputedStyle = () => ({ overflowY: opts.overflowY ?? 'auto' });
  ctx.loadSource('public/src/modules/chat-scroll.js');
  return ctx;
}

// ── normalizeWheelDeltaY ───────────────────────────────────────────

describe('chat-scroll: normalizeWheelDeltaY', () => {
  it('returns deltaY as-is for pixel mode (deltaMode 0 / undefined)', () => {
    const ctx = loadChatScroll();
    assert.equal(
      ctx.run('normalizeWheelDeltaY({ deltaY: 100, deltaMode: 0 })'),
      100
    );
  });

  it('returns deltaY as-is when deltaMode is undefined', () => {
    const ctx = loadChatScroll();
    assert.equal(
      ctx.run('normalizeWheelDeltaY({ deltaY: 50 })'),
      50
    );
  });

  it('multiplies by 40 for line mode (DOM_DELTA_LINE)', () => {
    const ctx = loadChatScroll();
    assert.equal(
      ctx.run('normalizeWheelDeltaY({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE })'),
      120
    );
  });

  it('multiplies by clientHeight for page mode (DOM_DELTA_PAGE)', () => {
    const ctx = loadChatScroll({ containerHeight: 800 });
    assert.equal(
      ctx.run('normalizeWheelDeltaY({ deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_PAGE })'),
      1600
    );
  });

  it('handles negative deltaY (scroll up) in pixel mode', () => {
    const ctx = loadChatScroll();
    assert.equal(
      ctx.run('normalizeWheelDeltaY({ deltaY: -100, deltaMode: 0 })'),
      -100
    );
  });

  it('handles negative deltaY in line mode', () => {
    const ctx = loadChatScroll();
    assert.equal(
      ctx.run('normalizeWheelDeltaY({ deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE })'),
      -120
    );
  });

  it('handles zero deltaY', () => {
    const ctx = loadChatScroll();
    assert.equal(
      ctx.run('normalizeWheelDeltaY({ deltaY: 0, deltaMode: 0 })'),
      0
    );
  });
});

// ── canElementScrollVertically ─────────────────────────────────────

describe('chat-scroll: canElementScrollVertically', () => {
  it('returns false for null element', () => {
    const ctx = loadChatScroll();
    assert.equal(ctx.run('canElementScrollVertically(null, 10)'), false);
  });

  it('returns false for undefined element', () => {
    const ctx = loadChatScroll();
    assert.equal(ctx.run('canElementScrollVertically(undefined, 10)'), false);
  });

  it('returns false when element is the container itself', () => {
    const ctx = loadChatScroll();
    assert.equal(ctx.run('canElementScrollVertically(container, 10)'), false);
  });

  it('returns false when element is document.body', () => {
    const ctx = loadChatScroll();
    assert.equal(ctx.run('canElementScrollVertically(document.body, 10)'), false);
  });

  it('returns false when element is document.documentElement', () => {
    const ctx = loadChatScroll();
    assert.equal(ctx.run('canElementScrollVertically(document.documentElement, 10)'), false);
  });

  it('returns false when overflowY is hidden', () => {
    const ctx = loadChatScroll({ overflowY: 'hidden' });
    ctx.run(`
      var el = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    `);
    assert.equal(ctx.run('canElementScrollVertically(el, 10)'), false);
  });

  it('returns false when overflowY is visible', () => {
    const ctx = loadChatScroll({ overflowY: 'visible' });
    ctx.run(`
      var el = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    `);
    assert.equal(ctx.run('canElementScrollVertically(el, 10)'), false);
  });

  it('returns true when overflowY is scroll and can scroll down', () => {
    const ctx = loadChatScroll({ overflowY: 'scroll' });
    ctx.run(`
      var el = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    `);
    assert.equal(ctx.run('canElementScrollVertically(el, 10)'), true);
  });

  it('returns true when overflowY is overlay and can scroll down', () => {
    const ctx = loadChatScroll({ overflowY: 'overlay' });
    ctx.run(`
      var el = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    `);
    assert.equal(ctx.run('canElementScrollVertically(el, 10)'), true);
  });

  it('returns false when content fits exactly (maxTop <= 1)', () => {
    const ctx = loadChatScroll();
    ctx.run(`
      var el = { scrollHeight: 200, clientHeight: 200, scrollTop: 0 };
    `);
    assert.equal(ctx.run('canElementScrollVertically(el, 10)'), false);
  });

  it('returns false when at bottom and scrolling down', () => {
    const ctx = loadChatScroll();
    ctx.run(`
      var el = { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 };
    `);
    // maxTop = 800, scrollTop = 800, 800 < 800-1=799 → false
    assert.equal(ctx.run('canElementScrollVertically(el, 10)'), false);
  });

  it('returns true when can scroll up (deltaY < 0, scrollTop > 1)', () => {
    const ctx = loadChatScroll();
    ctx.run(`
      var el = { scrollHeight: 1000, clientHeight: 200, scrollTop: 500 };
    `);
    assert.equal(ctx.run('canElementScrollVertically(el, -10)'), true);
  });

  it('returns false when at top and scrolling up (scrollTop <= 1)', () => {
    const ctx = loadChatScroll();
    ctx.run(`
      var el = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    `);
    assert.equal(ctx.run('canElementScrollVertically(el, -10)'), false);
  });

  it('returns false when deltaY is 0', () => {
    const ctx = loadChatScroll();
    ctx.run(`
      var el = { scrollHeight: 1000, clientHeight: 200, scrollTop: 500 };
    `);
    assert.equal(ctx.run('canElementScrollVertically(el, 0)'), false);
  });
});

// ── hasScrollableWheelTarget ───────────────────────────────────────

describe('chat-scroll: hasScrollableWheelTarget', () => {
  it('returns false for null target', () => {
    const ctx = loadChatScroll();
    assert.equal(ctx.run('hasScrollableWheelTarget(null, 10)'), false);
  });

  it('returns false for undefined target', () => {
    const ctx = loadChatScroll();
    assert.equal(ctx.run('hasScrollableWheelTarget(undefined, 10)'), false);
  });

  it('returns false for plain object with no scrollable parent chain', () => {
    const ctx = loadChatScroll();
    ctx.run(`
      var target = { parentElement: container };
    `);
    // target is not instanceof Element, so node = target.parentElement = container
    // container === container → while condition false → returns false
    assert.equal(ctx.run('hasScrollableWheelTarget(target, 10)'), false);
  });

  it('returns true when a parent in the chain is scrollable', () => {
    const ctx = loadChatScroll();
    ctx.run(`
      var scrollableParent = {
        parentElement: container,
        scrollHeight: 1000,
        clientHeight: 200,
        scrollTop: 10
      };
      var target = { parentElement: scrollableParent };
    `);
    // target not instanceof Element → node = target.parentElement = scrollableParent
    // scrollableParent !== container → check canElementScrollVertically → true
    assert.equal(ctx.run('hasScrollableWheelTarget(target, 10)'), true);
  });

  it('stops at container boundary', () => {
    const ctx = loadChatScroll();
    ctx.run(`
      var child = {
        parentElement: container,
        scrollHeight: 1000,
        clientHeight: 200,
        scrollTop: 10
      };
    `);
    // child not instanceof Element → node = child.parentElement = container
    // container === container → exits loop → false
    // (canElementScrollVertically also returns false for container)
    assert.equal(ctx.run('hasScrollableWheelTarget(child, 10)'), false);
  });
});

// ── isChromeWithoutEdge ────────────────────────────────────────────

describe('chat-scroll: isChromeWithoutEdge', () => {
  it('returns true for Chrome UA without Edge', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';
    const ctx = loadChatScroll({ userAgent: ua });
    assert.equal(ctx.run('isChromeWithoutEdge()'), true);
  });

  it('returns false for Edge UA (contains Chrome/ but also Edg/)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Edg/120.0.0.0 Safari/537.36';
    const ctx = loadChatScroll({ userAgent: ua });
    assert.equal(ctx.run('isChromeWithoutEdge()'), false);
  });

  it('returns false for Firefox UA', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';
    const ctx = loadChatScroll({ userAgent: ua });
    assert.equal(ctx.run('isChromeWithoutEdge()'), false);
  });

  it('returns false for Safari UA without Chrome/', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
    const ctx = loadChatScroll({ userAgent: ua });
    assert.equal(ctx.run('isChromeWithoutEdge()'), false);
  });

  it('returns false for empty UA string', () => {
    const ctx = loadChatScroll({ userAgent: '' });
    assert.equal(ctx.run('isChromeWithoutEdge()'), false);
  });
});

// ── shouldUseManualWheelScroll ─────────────────────────────────────

describe('chat-scroll: shouldUseManualWheelScroll', () => {
  it('returns false when browser is not Chrome', () => {
    const ctx = loadChatScroll({ userAgent: 'Firefox/120.0' });
    assert.equal(ctx.run('shouldUseManualWheelScroll()'), false);
  });

  it('returns false initially when Chrome but no recovery flag set', () => {
    const ua = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36';
    const ctx = loadChatScroll({ userAgent: ua });
    assert.equal(ctx.run('shouldUseManualWheelScroll()'), false);
  });

  it('returns true once after markChatPageResumed sets recovery flag', () => {
    const ua = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36';
    const ctx = loadChatScroll({
      userAgent: ua,
      isChatSurfaceActive: () => true,
    });
    // Set the recovery flag via markChatPageResumed
    ctx.run('markChatPageResumed()');
    // First call should return true and consume the flag
    assert.equal(ctx.run('shouldUseManualWheelScroll()'), true);
  });

  it('resets flag after returning true (second call returns false)', () => {
    const ua = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36';
    const ctx = loadChatScroll({
      userAgent: ua,
      isChatSurfaceActive: () => true,
    });
    ctx.run('markChatPageResumed()');
    assert.equal(ctx.run('shouldUseManualWheelScroll()'), true);
    // Flag consumed — second call without re-marking should return false
    assert.equal(ctx.run('shouldUseManualWheelScroll()'), false);
  });

  it('markChatPageResumed does not set flag when not Chrome', () => {
    const ctx = loadChatScroll({
      userAgent: 'Firefox/120.0',
      isChatSurfaceActive: () => true,
    });
    ctx.run('markChatPageResumed()');
    assert.equal(ctx.run('shouldUseManualWheelScroll()'), false);
  });

  it('markChatPageResumed does not set flag when chat surface is inactive', () => {
    const ua = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36';
    const ctx = loadChatScroll({
      userAgent: ua,
      isChatSurfaceActive: () => false,
    });
    ctx.run('markChatPageResumed()');
    assert.equal(ctx.run('shouldUseManualWheelScroll()'), false);
  });
});
