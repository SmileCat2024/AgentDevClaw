/**
 * Tests for public/src/modules/chat-scroll.js
 *
 * Covers pure/near-pure functions:
 *   - normalizeWheelDeltaY (wheel event deltaY normalization)
 *   - canElementScrollVertically (vertical scroll capability check)
 *   - hasScrollableWheelTarget (scrollable ancestor detection)
 *   - isChromeWithoutEdge (browser UA detection)
 *   - shouldUseManualWheelScroll (stateful manual scroll decision)
 *
 * 装载路线（P4 T2 批次）：chat-scroll 已迁 ESM，走 withP2EsmCase 的真实 import
 * 路线（`c.load`）。原 classic 沙箱的注入面按模块现有依赖重建：
 *   - `document.getElementById('chat-container' / 'follow-latest-btn')`：模块
 *     求值期等价重建的 DOM 引用（原 app-core 顶层 const）；
 *   - `window.createP2BootstrapChatSurfaceHost()`：跟随开关 / 滚动抑制标志的
 *     宿主适配（p2-bootstrap-chat-surface）；
 *   - 视口域同步入口（isChatSurfaceActive / shouldRenderWorkspaceSurface /
 *     registerManualScrollIntent / isNearBottom / setFollowLatest /
 *     hasRecentManualScrollIntent）与浏览器全局（WheelEvent / Element /
 *     navigator / getComputedStyle）：模块经 window 晚绑定调用，用例在
 *     window 上按用例替换。
 * 每个用例一张独立 ESM 图（模块私有恢复标记不跨用例），case 结束自动回收。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const CHAT_SCROLL = 'public/src/modules/chat-scroll.js';
const WHEEL_EVENT = { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2, DOM_DELTA_PIXEL: 0 };

/**
 * 建一个 chat-scroll 用例环境并真实 import 模块。
 *
 * chat-scroll 在求值期给 container / followLatestButton 注册事件监听（桩里
 * 记录到 listeners Map），并查询两个 DOM 元素；其余依赖都在调用时才读 window。
 */
async function withChatScroll(opts, fn) {
  const container = {
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
  const followLatestButton = { addEventListener() {} };
  // 跟随开关 / 滚动抑制标志的宿主（生产由 app-core 的
  // createP2BootstrapChatSurfaceHost 提供，读写实时转发到 classic 状态）。
  const surface = {
    followLatestEnabled: opts.followLatest ?? true,
    suppressFollowScrollEvent: false,
    showChatProcess: false,
  };
  const document = {
    getElementById(id) {
      if (id === 'chat-container') return container;
      if (id === 'follow-latest-btn') return followLatestButton;
      return null;
    },
    body: {},
    documentElement: {},
    addEventListener() {},
  };

  return withP2EsmCase({
    globals: {
      document,
      WheelEvent: WHEEL_EVENT,
      Element: function Element() {},
      navigator: { userAgent: opts.userAgent ?? '' },
      getComputedStyle: () => ({ overflowY: opts.overflowY ?? 'auto', paddingTop: '0px' }),
      createP2BootstrapChatSurfaceHost: () => surface,
      isChatSurfaceActive: opts.isChatSurfaceActive ?? (() => false),
      shouldRenderWorkspaceSurface: () => false,
      registerManualScrollIntent: opts.registerManualScrollIntent ?? (() => {}),
      closeCtxMenu: () => {},
    },
  }, async (c) => {
    const module = await c.load(CHAT_SCROLL);
    return fn({ c, module, container, surface });
  });
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
  it('ordinary wheel stays passive and interrupts follow without reading target geometry', async () => {
    const intents = [];
    await withChatScroll({
      userAgent: 'Chrome/140.0', isChatSurfaceActive: () => true,
      registerManualScrollIntent: options => intents.push(options),
    }, ({ c, container }) => {
      c.window.getComputedStyle = () => { throw new Error('Unexpected target layout read'); };
      assert.ok([...container.listeners.get('wheel').values()].every(o => o.passive));
      const event = dispatchWheel({ container }, { deltaY: -80, target: new c.window.Element() });
      assert.equal(event.prevented, false);
      assert.equal(intents[0].interrupt, true);
    });
  });

  it('Chrome recovery leaves nested scrolling and zoom alone, then compensates only once', async () => {
    await withChatScroll({ userAgent: 'Chrome/140.0', isChatSurfaceActive: () => true },
      ({ c, module, container }) => {
        const nested = Object.assign(new c.window.Element(), {
          parentElement: container, scrollHeight: 500, clientHeight: 100, scrollTop: 20,
        });
        module.markChatPageResumed();
        assert.equal(dispatchWheel({ container }, { target: nested }).prevented, false);
        assert.equal(container.scrollTop, 0);
        assert.equal(dispatchWheel({ container }, { ctrlKey: true }).prevented, false);
        nested.scrollTop = 400; // Nested scroller is at its lower boundary; chat owns the wheel.
        assert.equal(dispatchWheel({ container }, { target: nested }).prevented, true);
        assert.equal(container.scrollTop, 80);
        assert.ok([...container.listeners.get('wheel').values()].every(o => o.passive));
        assert.equal(dispatchWheel({ container }).prevented, false);
        assert.equal(container.scrollTop, 80, 'subsequent movement belongs to the browser');
      });
  });

  it('Edge resume never installs a blocking wheel listener', async () => {
    await withChatScroll({ userAgent: 'Chrome/140.0 Edg/140.0', isChatSurfaceActive: () => true },
      ({ module, container }) => {
        module.markChatPageResumed();
        assert.ok([...container.listeners.get('wheel').values()].every(o => o.passive));
      });
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
async function withFollowScroll(opts, fn) {
  return withChatScroll(opts, (ctx) => {
    const setCalls = [];
    ctx.c.window.isNearBottom = () =>
      ctx.container.scrollHeight - ctx.container.scrollTop - ctx.container.clientHeight <= 48;
    ctx.c.window.hasRecentManualScrollIntent = () => opts.manualIntent ?? true;
    ctx.c.window.setFollowLatest = (enabled) => { setCalls.push(enabled); };
    return fn({ ...ctx, setCalls });
  });
}

function dispatchScroll(container) {
  for (const listener of [...container.listeners.get('scroll').keys()]) listener();
}

/** 程序定位初始 scrollTop：更新方向基准但不参与跟随判定。 */
function establishScrollBaseline({ container, surface }, top) {
  surface.suppressFollowScrollEvent = true;
  container.scrollTop = top;
  dispatchScroll(container);
  surface.suppressFollowScrollEvent = false;
}

describe('chat-scroll: follow-latest scroll direction guard', () => {
  // scrollHeight 1000 / clientHeight 600 → maxTop 400；scrollTop 380 时距底 20px（容差内）

  it('follow on — 向上滚一小下（仍在容差内）立即退出跟随（滚动条/触屏路径）', async () => {
    await withFollowScroll({ followLatest: true }, ({ container, surface, setCalls }) => {
      establishScrollBaseline({ container, surface }, 400); // 定位在底部
      container.scrollTop = 380; dispatchScroll(container); // 向上 20px，isNearBottom 仍 true
      assert.deepEqual(setCalls, [false]);
    });
  });

  it('follow off — 向上滚后仍在容差内不得恢复跟随（滚轮路径 bug 场景）', async () => {
    // wheel handler 已 interrupt 关闭跟随；随后 scroll 事件不得因 isNearBottom 误重开
    await withFollowScroll({ followLatest: false }, ({ container, surface, setCalls }) => {
      establishScrollBaseline({ container, surface }, 400);
      container.scrollTop = 380; dispatchScroll(container);
      assert.deepEqual(setCalls, []);
    });
  });

  it('follow off — 向下滚回底部恢复跟随（旧行为保留）', async () => {
    await withFollowScroll({ followLatest: false }, ({ container, surface, setCalls }) => {
      establishScrollBaseline({ container, surface }, 380);
      container.scrollTop = 400; dispatchScroll(container);
      assert.deepEqual(setCalls, [true]);
    });
  });

  it('无位移的重复 scroll 事件沿用上次方向，不误恢复跟随', async () => {
    await withFollowScroll({ followLatest: false }, ({ container, surface, setCalls }) => {
      establishScrollBaseline({ container, surface }, 400);
      container.scrollTop = 380; dispatchScroll(container); // 向上滚离开底部
      dispatchScroll(container); // 程序补发：scrollTop 仍 380
      assert.deepEqual(setCalls, []);
    });
  });

  it('suppress 期间的程序滚动更新基准：随后的向下滚动按真实方向判定', async () => {
    await withFollowScroll({ followLatest: false }, ({ container, surface, setCalls }) => {
      establishScrollBaseline({ container, surface }, 400);
      surface.suppressFollowScrollEvent = true;
      container.scrollTop = 300; dispatchScroll(container); // 程序 preserveTop 向上恢复
      surface.suppressFollowScrollEvent = false;
      container.scrollTop = 360; dispatchScroll(container); // 用户向下滚回容差内
      assert.deepEqual(setCalls, [true]);
    });
  });

  it('follow on — 向下滚到底不误关（在底部时的非自愿下滚不打断跟随）', async () => {
    await withFollowScroll({ followLatest: true }, ({ container, surface, setCalls }) => {
      establishScrollBaseline({ container, surface }, 390);
      container.scrollTop = 400; dispatchScroll(container); // down + isNearBottom
      assert.deepEqual(setCalls, []);
    });
  });

  it('follow on — 无手动滚动意图时滚动事件不改变跟随状态（旧行为保留）', async () => {
    await withFollowScroll({ followLatest: true, manualIntent: false },
      ({ container, surface, setCalls }) => {
        establishScrollBaseline({ container, surface }, 400);
        container.scrollTop = 380; dispatchScroll(container);
        assert.deepEqual(setCalls, []);
      });
  });
});

// ── normalizeWheelDeltaY ───────────────────────────────────────────

describe('chat-scroll: normalizeWheelDeltaY', () => {
  it('returns deltaY as-is for pixel mode (deltaMode 0 / undefined)', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.normalizeWheelDeltaY({ deltaY: 100, deltaMode: 0 }), 100);
    });
  });

  it('returns deltaY as-is when deltaMode is undefined', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.normalizeWheelDeltaY({ deltaY: 50 }), 50);
    });
  });

  it('multiplies by 40 for line mode (DOM_DELTA_LINE)', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(
        module.normalizeWheelDeltaY({ deltaY: 3, deltaMode: WHEEL_EVENT.DOM_DELTA_LINE }),
        120,
      );
    });
  });

  it('multiplies by clientHeight for page mode (DOM_DELTA_PAGE)', async () => {
    await withChatScroll({ containerHeight: 800 }, ({ module }) => {
      assert.equal(
        module.normalizeWheelDeltaY({ deltaY: 2, deltaMode: WHEEL_EVENT.DOM_DELTA_PAGE }),
        1600,
      );
    });
  });

  it('handles negative deltaY (scroll up) in pixel mode', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.normalizeWheelDeltaY({ deltaY: -100, deltaMode: 0 }), -100);
    });
  });

  it('handles negative deltaY in line mode', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(
        module.normalizeWheelDeltaY({ deltaY: -3, deltaMode: WHEEL_EVENT.DOM_DELTA_LINE }),
        -120,
      );
    });
  });

  it('handles zero deltaY', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.normalizeWheelDeltaY({ deltaY: 0, deltaMode: 0 }), 0);
    });
  });
});

// ── canElementScrollVertically ─────────────────────────────────────

describe('chat-scroll: canElementScrollVertically', () => {
  it('returns false for null element', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.canElementScrollVertically(null, 10), false);
    });
  });

  it('returns false for undefined element', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.canElementScrollVertically(undefined, 10), false);
    });
  });

  it('returns false when element is the container itself', async () => {
    await withChatScroll({}, ({ module, container }) => {
      assert.equal(module.canElementScrollVertically(container, 10), false);
    });
  });

  it('returns false when element is document.body', async () => {
    await withChatScroll({}, ({ c, module }) => {
      assert.equal(module.canElementScrollVertically(c.window.document.body, 10), false);
    });
  });

  it('returns false when element is document.documentElement', async () => {
    await withChatScroll({}, ({ c, module }) => {
      assert.equal(module.canElementScrollVertically(c.window.document.documentElement, 10), false);
    });
  });

  it('returns false when overflowY is hidden', async () => {
    await withChatScroll({ overflowY: 'hidden' }, ({ module }) => {
      assert.equal(module.canElementScrollVertically({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }, 10), false);
    });
  });

  it('returns false when overflowY is visible', async () => {
    await withChatScroll({ overflowY: 'visible' }, ({ module }) => {
      assert.equal(module.canElementScrollVertically({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }, 10), false);
    });
  });

  it('returns true when overflowY is scroll and can scroll down', async () => {
    await withChatScroll({ overflowY: 'scroll' }, ({ module }) => {
      assert.equal(module.canElementScrollVertically({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }, 10), true);
    });
  });

  it('returns true when overflowY is overlay and can scroll down', async () => {
    await withChatScroll({ overflowY: 'overlay' }, ({ module }) => {
      assert.equal(module.canElementScrollVertically({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }, 10), true);
    });
  });

  it('returns false when content fits exactly (maxTop <= 1)', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.canElementScrollVertically({ scrollHeight: 200, clientHeight: 200, scrollTop: 0 }, 10), false);
    });
  });

  it('returns false when at bottom and scrolling down', async () => {
    await withChatScroll({}, ({ module }) => {
      // maxTop = 800, scrollTop = 800, 800 < 800-1=799 → false
      assert.equal(module.canElementScrollVertically({ scrollHeight: 1000, clientHeight: 200, scrollTop: 800 }, 10), false);
    });
  });

  it('returns true when can scroll up (deltaY < 0, scrollTop > 1)', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.canElementScrollVertically({ scrollHeight: 1000, clientHeight: 200, scrollTop: 500 }, -10), true);
    });
  });

  it('returns false when at top and scrolling up (scrollTop <= 1)', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.canElementScrollVertically({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 }, -10), false);
    });
  });

  it('returns false when deltaY is 0', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.canElementScrollVertically({ scrollHeight: 1000, clientHeight: 200, scrollTop: 500 }, 0), false);
    });
  });
});

// ── hasScrollableWheelTarget ───────────────────────────────────────

describe('chat-scroll: hasScrollableWheelTarget', () => {
  it('returns false for null target', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.hasScrollableWheelTarget(null, 10), false);
    });
  });

  it('returns false for undefined target', async () => {
    await withChatScroll({}, ({ module }) => {
      assert.equal(module.hasScrollableWheelTarget(undefined, 10), false);
    });
  });

  it('returns false for plain object with no scrollable parent chain', async () => {
    await withChatScroll({}, ({ module, container }) => {
      // target is not instanceof Element, so node = target.parentElement = container
      // container === container → while condition false → returns false
      assert.equal(module.hasScrollableWheelTarget({ parentElement: container }, 10), false);
    });
  });

  it('returns true when a parent in the chain is scrollable', async () => {
    await withChatScroll({}, ({ module, container }) => {
      const scrollableParent = {
        parentElement: container,
        scrollHeight: 1000,
        clientHeight: 200,
        scrollTop: 10,
      };
      // target not instanceof Element → node = target.parentElement = scrollableParent
      // scrollableParent !== container → check canElementScrollVertically → true
      assert.equal(module.hasScrollableWheelTarget({ parentElement: scrollableParent }, 10), true);
    });
  });

  it('stops at container boundary', async () => {
    await withChatScroll({}, ({ module, container }) => {
      const child = {
        parentElement: container,
        scrollHeight: 1000,
        clientHeight: 200,
        scrollTop: 10,
      };
      // child not instanceof Element → node = child.parentElement = container
      // container === container → exits loop → false
      // (canElementScrollVertically also returns false for container)
      assert.equal(module.hasScrollableWheelTarget(child, 10), false);
    });
  });
});

// ── isChromeWithoutEdge ────────────────────────────────────────────

describe('chat-scroll: isChromeWithoutEdge', () => {
  it('returns true for Chrome UA without Edge', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36';
    await withChatScroll({ userAgent: ua }, ({ module }) => {
      assert.equal(module.isChromeWithoutEdge(), true);
    });
  });

  it('returns false for Edge UA (contains Chrome/ but also Edg/)', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Edg/120.0.0.0 Safari/537.36';
    await withChatScroll({ userAgent: ua }, ({ module }) => {
      assert.equal(module.isChromeWithoutEdge(), false);
    });
  });

  it('returns false for Firefox UA', async () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';
    await withChatScroll({ userAgent: ua }, ({ module }) => {
      assert.equal(module.isChromeWithoutEdge(), false);
    });
  });

  it('returns false for Safari UA without Chrome/', async () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
    await withChatScroll({ userAgent: ua }, ({ module }) => {
      assert.equal(module.isChromeWithoutEdge(), false);
    });
  });

  it('returns false for empty UA string', async () => {
    await withChatScroll({ userAgent: '' }, ({ module }) => {
      assert.equal(module.isChromeWithoutEdge(), false);
    });
  });
});

// ── shouldUseManualWheelScroll ─────────────────────────────────────

describe('chat-scroll: shouldUseManualWheelScroll', () => {
  it('returns false when browser is not Chrome', async () => {
    await withChatScroll({ userAgent: 'Firefox/120.0' }, ({ module }) => {
      assert.equal(module.shouldUseManualWheelScroll(), false);
    });
  });

  it('returns false initially when Chrome but no recovery flag set', async () => {
    const ua = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36';
    await withChatScroll({ userAgent: ua }, ({ module }) => {
      assert.equal(module.shouldUseManualWheelScroll(), false);
    });
  });

  it('returns true once after markChatPageResumed sets recovery flag', async () => {
    const ua = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36';
    await withChatScroll({ userAgent: ua, isChatSurfaceActive: () => true }, ({ module }) => {
      // Set the recovery flag via markChatPageResumed
      module.markChatPageResumed();
      // First call should return true and consume the flag
      assert.equal(module.shouldUseManualWheelScroll(), true);
    });
  });

  it('resets flag after returning true (second call returns false)', async () => {
    const ua = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36';
    await withChatScroll({ userAgent: ua, isChatSurfaceActive: () => true }, ({ module }) => {
      module.markChatPageResumed();
      assert.equal(module.shouldUseManualWheelScroll(), true);
      // Flag consumed — second call without re-marking should return false
      assert.equal(module.shouldUseManualWheelScroll(), false);
    });
  });

  it('markChatPageResumed does not set flag when not Chrome', async () => {
    await withChatScroll({ userAgent: 'Firefox/120.0', isChatSurfaceActive: () => true }, ({ module }) => {
      module.markChatPageResumed();
      assert.equal(module.shouldUseManualWheelScroll(), false);
    });
  });

  it('markChatPageResumed does not set flag when chat surface is inactive', async () => {
    const ua = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36';
    await withChatScroll({ userAgent: ua, isChatSurfaceActive: () => false }, ({ module }) => {
      module.markChatPageResumed();
      assert.equal(module.shouldUseManualWheelScroll(), false);
    });
  });
});
