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
    listeners: new Map(),
    addEventListener(type, listener, options) {
      const listeners = this.listeners.get(type) || new Map();
      listeners.set(listener, options);
      this.listeners.set(type, listeners);
    },
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); },
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
    shouldRenderWorkspaceSurface: () => false,
    registerManualScrollIntent: opts.registerManualScrollIntent ?? (() => {}),
    getComputedStyle: () => ({ overflowY: opts.overflowY ?? 'auto' }),
  });
  // window.getComputedStyle is used inside canElementScrollVertically
  ctx.window.getComputedStyle = () => ({ overflowY: opts.overflowY ?? 'auto' });
  ctx.window.closeCtxMenu = () => {};
  ctx.loadSource('public/src/modules/chat-scroll.js');
  return ctx;
}

function dispatchWheel(ctx, overrides = {}) {
  const event = {
    deltaY: 80, deltaX: 0, deltaMode: 0, target: ctx.container,
    prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides,
  };
  for (const listener of [...ctx.container.listeners.get('wheel').keys()]) listener(event);
  return event;
}

describe('chat-scroll: native wheel and resume recovery', () => {
  it('ordinary wheel stays passive and interrupts follow without reading target geometry', () => {
    const intents = [];
    const ctx = loadChatScroll({
      userAgent: 'Chrome/140.0', isChatSurfaceActive: () => true,
      registerManualScrollIntent: options => intents.push(options),
    });
    ctx.window.getComputedStyle = () => { throw new Error('Unexpected target layout read'); };
    assert.ok([...ctx.container.listeners.get('wheel').values()].every(o => o.passive));
    const event = dispatchWheel(ctx, { deltaY: -80, target: new ctx.Element() });
    assert.equal(event.prevented, false);
    assert.equal(intents[0].interrupt, true);
  });

  it('Chrome recovery leaves nested scrolling and zoom alone, then compensates only once', () => {
    const ctx = loadChatScroll({ userAgent: 'Chrome/140.0', isChatSurfaceActive: () => true });
    const nested = Object.assign(new ctx.Element(), {
      parentElement: ctx.container, scrollHeight: 500, clientHeight: 100, scrollTop: 20,
    });
    ctx.run('markChatPageResumed()');
    assert.equal(dispatchWheel(ctx, { target: nested }).prevented, false);
    assert.equal(ctx.container.scrollTop, 0);
    assert.equal(dispatchWheel(ctx, { ctrlKey: true }).prevented, false);
    nested.scrollTop = 400; // Nested scroller is at its lower boundary; chat owns the wheel.
    assert.equal(dispatchWheel(ctx, { target: nested }).prevented, true);
    assert.equal(ctx.container.scrollTop, 80);
    assert.ok([...ctx.container.listeners.get('wheel').values()].every(o => o.passive));
    assert.equal(dispatchWheel(ctx).prevented, false);
    assert.equal(ctx.container.scrollTop, 80, 'subsequent movement belongs to the browser');
  });

  it('Edge resume never installs a blocking wheel listener', () => {
    const ctx = loadChatScroll({ userAgent: 'Chrome/140.0 Edg/140.0', isChatSurfaceActive: () => true });
    ctx.run('markChatPageResumed()');
    assert.ok([...ctx.container.listeners.get('wheel').values()].every(o => o.passive));
  });
});

// ── follow-latest scroll direction guard ───────────────────────────

/**
 * 跟随最新的 scroll 判定（方向感知）：
 *   - 跟随开启时向上滚动（哪怕仍在底部 48px 容差内）立即退出跟随；
 *   - 跟随退出后，只有向下滚回底部附近才恢复跟随——向上滚（含离开
 *     底部一点点）不得恢复；
 *   - 无位移的重复 scroll 事件沿用上次方向；suppress 期间的程序滚动
 *     更新基准但不参与判定。
 * isNearBottom 注入真实阈值语义（chat-viewport.js：距底 ≤ 48px）。
 */
function loadFollowScrollSandbox(opts = {}) {
  const setCalls = [];
  const ctx = loadChatScroll();
  ctx.followLatestEnabled = opts.followLatest ?? true;
  ctx.suppressFollowScrollEvent = false;
  ctx.isNearBottom = () =>
    ctx.container.scrollHeight - ctx.container.scrollTop - ctx.container.clientHeight <= 48;
  ctx.hasRecentManualScrollIntent = () => opts.manualIntent ?? true;
  ctx.setFollowLatest = (enabled) => { setCalls.push(enabled); };
  return { ctx, setCalls };
}

function dispatchScroll(ctx) {
  for (const listener of [...ctx.container.listeners.get('scroll').keys()]) listener();
}

/** 程序定位初始 scrollTop：更新方向基准但不参与跟随判定。 */
function establishScrollBaseline(ctx, top) {
  ctx.run('suppressFollowScrollEvent = true');
  ctx.container.scrollTop = top;
  dispatchScroll(ctx);
  ctx.run('suppressFollowScrollEvent = false');
}

describe('chat-scroll: follow-latest scroll direction guard', () => {
  // scrollHeight 1000 / clientHeight 600 → maxTop 400；scrollTop 380 时距底 20px（容差内）

  it('follow on — 向上滚一小下（仍在容差内）立即退出跟随（滚动条/触屏路径）', () => {
    const { ctx, setCalls } = loadFollowScrollSandbox({ followLatest: true });
    establishScrollBaseline(ctx, 400); // 定位在底部
    ctx.container.scrollTop = 380; dispatchScroll(ctx); // 向上 20px，isNearBottom 仍 true
    assert.deepEqual(setCalls, [false]);
  });

  it('follow off — 向上滚后仍在容差内不得恢复跟随（滚轮路径 bug 场景）', () => {
    // wheel handler 已 interrupt 关闭跟随；随后 scroll 事件不得因 isNearBottom 误重开
    const { ctx, setCalls } = loadFollowScrollSandbox({ followLatest: false });
    establishScrollBaseline(ctx, 400);
    ctx.container.scrollTop = 380; dispatchScroll(ctx);
    assert.deepEqual(setCalls, []);
  });

  it('follow off — 向下滚回底部恢复跟随（旧行为保留）', () => {
    const { ctx, setCalls } = loadFollowScrollSandbox({ followLatest: false });
    establishScrollBaseline(ctx, 380);
    ctx.container.scrollTop = 400; dispatchScroll(ctx);
    assert.deepEqual(setCalls, [true]);
  });

  it('无位移的重复 scroll 事件沿用上次方向，不误恢复跟随', () => {
    const { ctx, setCalls } = loadFollowScrollSandbox({ followLatest: false });
    establishScrollBaseline(ctx, 400);
    ctx.container.scrollTop = 380; dispatchScroll(ctx); // 向上滚离开底部
    dispatchScroll(ctx); // 程序补发：scrollTop 仍 380
    assert.deepEqual(setCalls, []);
  });

  it('suppress 期间的程序滚动更新基准：随后的向下滚动按真实方向判定', () => {
    const { ctx, setCalls } = loadFollowScrollSandbox({ followLatest: false });
    establishScrollBaseline(ctx, 400);
    ctx.run('suppressFollowScrollEvent = true');
    ctx.container.scrollTop = 300; dispatchScroll(ctx); // 程序 preserveTop 向上恢复
    ctx.run('suppressFollowScrollEvent = false');
    ctx.container.scrollTop = 360; dispatchScroll(ctx); // 用户向下滚回容差内
    assert.deepEqual(setCalls, [true]);
  });

  it('follow on — 向下滚到底不误关（在底部时的非自愿下滚不打断跟随）', () => {
    const { ctx, setCalls } = loadFollowScrollSandbox({ followLatest: true });
    establishScrollBaseline(ctx, 390);
    ctx.container.scrollTop = 400; dispatchScroll(ctx); // down + isNearBottom
    assert.deepEqual(setCalls, []);
  });

  it('follow on — 无手动滚动意图时滚动事件不改变跟随状态（旧行为保留）', () => {
    const { ctx, setCalls } = loadFollowScrollSandbox({ followLatest: true, manualIntent: false });
    establishScrollBaseline(ctx, 400);
    ctx.container.scrollTop = 380; dispatchScroll(ctx);
    assert.deepEqual(setCalls, []);
  });
});

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
