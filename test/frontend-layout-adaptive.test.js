/**
 * Tests for layout-adaptive pure logic in app-ui.js / chat-viewport.js.
 *
 * 1. Splitter drag ceilings (_sidebarDragCeiling / _panelDragCeiling):
 *    manually widening either side column must never squeeze the central
 *    column below CENTRAL_MIN_WIDTH — the same invariant the window-resize
 *    cascade (_cascadeCentralWidth) enforces, so window resizes and manual
 *    drags share one definition of a legal layout.
 *
 * 2. Follow-latest button dynamic avoidance (updateFollowLatestButtonPosition):
 *    when avoidance is active (narrow main content or open panel) the button
 *    bottom is measured from the real input container top edge instead of
 *    fixed-pixel breakpoints, so it tracks input height changes and never
 *    falls back onto the input at narrow breakpoints.
 *
 * Sources are extracted from the real frontend files into a vm sandbox
 * (same pattern as frontend-model-info-roundtrip.test.js).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const uiSource = fs.readFileSync(new URL('../public/src/app-ui.js', import.meta.url), 'utf8');
const viewportSource = fs.readFileSync(new URL('../public/src/modules/chat-viewport.js', import.meta.url), 'utf8');

// ── Source extractors ──────────────────────────────────────

function extractCeilingsSource() {
  const start = uiSource.indexOf('function _sidebarDragCeiling');
  const end = uiSource.indexOf('/** 纯适配动作', start);
  assert.notEqual(start, -1, 'sidebar ceiling start marker should exist');
  assert.notEqual(end, -1, 'cascade comment marker should exist');
  return uiSource.slice(start, end);
}

function extractFollowPositionSource() {
  // Include the module constants the function body reads.
  const start = viewportSource.indexOf('const FOLLOW_LATEST_AVOID_MAX_WIDTH');
  const end = viewportSource.indexOf('/** 惰性建立尺寸跟踪', start);
  assert.notEqual(start, -1, 'avoid constants marker should exist');
  assert.notEqual(end, -1, 'observer ensure marker should exist');
  return viewportSource.slice(start, end);
}

// ── Splitter drag ceilings ─────────────────────────────────

/**
 * Sandbox stubs for the ceiling functions. Occupied widths are injected as
 * plain numbers so tests stay pure layout arithmetic.
 */
function loadCeilings({ innerWidth, sidebarCollapsed = false, narrow = false, sidebarWidth = 280, panelOpen = true, panelWidth = 400 }) {
  const sandbox = {
    CENTRAL_MIN_WIDTH: 480,
    SIDEBAR_MAX_WIDTH: 480,
    window: { innerWidth },
    _isNarrowScreen: () => narrow,
    _getSidebarOccupiedWidth: () => (sidebarCollapsed || narrow ? 0 : sidebarWidth + 4),
    _getPanelOccupiedWidth: () => (panelOpen ? panelWidth : 0),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractCeilingsSource()}
globalThis.__ceiling = { sidebar: _sidebarDragCeiling(), panel: _panelDragCeiling() };`, sandbox);
  return sandbox.__ceiling;
}

test('sidebar ceiling leaves central min width with panel closed', () => {
  // 1440 wide, no panel: ceiling = 1440 - 60(resizer+rail) - 480 = 900,
  // above SIDEBAR_MAX — the hard max is what binds, central stays ample.
  const c = loadCeilings({ innerWidth: 1440, panelOpen: false });
  assert.equal(c.sidebar, 900);
});

test('sidebar ceiling shrinks with open panel to protect central min width', () => {
  // 1440 wide, panel 400: ceiling = 1440 - 400 - 60 - 480 = 500.
  const c = loadCeilings({ innerWidth: 1440, panelWidth: 400 });
  assert.equal(c.sidebar, 500);
  // At the ceiling the central column still meets the minimum.
  const central = 1440 - (500 + 4) - 400 - 56;
  assert.ok(central >= 480);
});

test('panel ceiling accounts for visible sidebar width plus resizer', () => {
  // 1440 wide, sidebar 280(+4): ceiling = 1440 - 284 - 56 - 480 = 620.
  const c = loadCeilings({ innerWidth: 1440 });
  assert.equal(c.panel, 620);
  const central = 1440 - 284 - 620 - 56;
  assert.equal(central, 480);
});

test('panel ceiling ignores collapsed sidebar (drawer occupies nothing)', () => {
  const c = loadCeilings({ innerWidth: 1440, sidebarCollapsed: true });
  assert.equal(c.panel, 1440 - 56 - 480);
});

test('narrow screen sidebar ceiling falls back to the hard max', () => {
  // Drawer mode: the sidebar overlays and occupies no layout width.
  const c = loadCeilings({ innerWidth: 800, narrow: true });
  assert.equal(c.sidebar, 480);
});

// ── Follow-latest button dynamic avoidance ─────────────────

function makeRect({ top = 0, bottom = 0, height = 0 }) {
  return { top, bottom, height };
}

function loadFollowPositionSandbox({ panelOpen = false, mainWidth = 1400, mainBottom = 900, inputTop = 700, inputHeight = 200, cardTop = null, cardHeight = null }) {
  const styleProps = new Map();
  const button = {
    style: {
      setProperty: (name, value) => styleProps.set(name, String(value)),
      removeProperty: (name) => styleProps.delete(name),
    },
    closest: () => main,
  };
  const main = {
    classList: { contains: (name) => name === 'panel-open' && panelOpen },
    clientWidth: mainWidth,
    getBoundingClientRect: () => makeRect({ bottom: mainBottom }),
  };
  const inputCard = {
    getBoundingClientRect: () => makeRect({
      top: cardTop === null ? inputTop : cardTop,
      height: cardHeight === null ? inputHeight : cardHeight,
    }),
  };
  const inputHost = {
    getBoundingClientRect: () => makeRect({ top: inputTop, height: inputHeight }),
    querySelector: (sel) => (sel === '.user-input-card.persistent-input' ? inputCard : null),
  };
  const sandbox = {
    followLatestButton: button,
    document: {
      getElementById: (id) => (id === 'user-input-container' ? inputHost : null),
    },
    bottomVar: styleProps,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFollowPositionSource(), sandbox);
  sandbox.updateFollowLatestButtonPosition();
  return { styleProps, sandbox };
}

test('avoidance active on narrow main content: bottom tracks the real input top edge', () => {
  // main bottom 900, input top 700 → button bottom = 200 + 10 (gap).
  const { styleProps } = loadFollowPositionSandbox({ mainWidth: 1000 });
  assert.equal(styleProps.get('--follow-latest-bottom'), '210px');
});

test('avoidance active when panel is open even on a wide main content', () => {
  const { styleProps } = loadFollowPositionSandbox({ panelOpen: true, mainWidth: 1400 });
  assert.equal(styleProps.get('--follow-latest-bottom'), '210px');
});

test('no avoidance on wide main content: fixed-pixel default applies', () => {
  const { styleProps } = loadFollowPositionSandbox({ mainWidth: 1400 });
  assert.equal(styleProps.size, 0);
});

test('growing input height moves the button up by the same amount', () => {
  const narrow = { mainWidth: 1000, inputTop: 700, inputHeight: 200 };
  const grown = { mainWidth: 1000, inputTop: 560, inputHeight: 340 };
  const a = parseFloat(loadFollowPositionSandbox(narrow).styleProps.get('--follow-latest-bottom'));
  const b = parseFloat(loadFollowPositionSandbox(grown).styleProps.get('--follow-latest-bottom'));
  // Input grew by 140px (3 extra lines) → button rides up 140px with it
  // (a larger `bottom` = farther from the main-content bottom edge).
  assert.equal(b - a, 140);
});

test('zero-height input container (non-chat surface) clears the override', () => {
  const { styleProps } = loadFollowPositionSandbox({ mainWidth: 1000, inputHeight: 0 });
  assert.equal(styleProps.size, 0);
});

test('measures the input card, not the taller wrapper (runtime pill excluded)', () => {
  // Wrapper top includes the runtime pill above the card; the button must
  // hug the card's own top edge (100px lower than the wrapper top).
  const { styleProps } = loadFollowPositionSandbox({
    mainWidth: 1000,
    inputTop: 640, // wrapper top (pill included)
    inputHeight: 260,
    cardTop: 740, // actual input card top
    cardHeight: 160,
  });
  // bottom = 900 - 740 + 10 = 170, NOT 900 - 640 + 10 = 270.
  assert.equal(styleProps.get('--follow-latest-bottom'), '170px');
});

test('zero-height input card (no input surface) clears the override', () => {
  const { styleProps } = loadFollowPositionSandbox({
    mainWidth: 1000,
    inputTop: 700,
    inputHeight: 200,
    cardHeight: 0,
  });
  assert.equal(styleProps.size, 0);
});
