/**
 * lazy-tool-content.js — "content-visibility:hidden 虚拟化"
 *
 * 根本原理：
 *   display:none → 高度归零 → 滚动条失真 → 需要 scrollTop 补偿（补丁）
 *   content-visibility:hidden → 高度保留（contain-intrinsic-size:auto）
 *     → 滚动条始终准确 → 无需任何补偿
 *
 *   cv-hidden 的子树不参与 layout/paint（浏览器原生跳过），
 *   但元素自身保留高度（首次 150px 估算，之后 auto 记住实际高度）。
 *
 * 前提条件（已满足）：
 *   show 模式下不调用 syncCollapseStates（读 scrollHeight 会强制
 *   计算 cv-hidden 子树布局，触发 Chromium 性能警告）。
 *
 * 依赖全局变量: container, showChatProcess
 * 依赖全局函数: runWithSuppressedChatViewportObservers, syncRowCollapseState
 * 导出: applyProcessDistance, clearProcessDistance, precomputeViewportIdx
 */

/* ── config ── */

var WINDOW_ABOVE = 150;
var WINDOW_BELOW = 100;

/* ── state ── */

var _preToggleViewportIdx = -1;
var _scrollRafPending = false;
var _scrollListenerAttached = false;
var _lastWindowStart = -1;
var _lastWindowEnd = -1;
var _cachedRows = null;
var _lastTopIdx = 0;
var _winPixTop = -1;
var _winPixBottom = -1;
var _cachedClientHeight = 0;
var _rowCache = null;
var _rowIdxMap = null;
var _scrollStopTimer = null;
var _lastScrollTop = 0;
var _largeDeltaPending = false;

/* ── cache ── */

function _buildRowCache(rows) {
  _rowCache = new Map();
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.classList.contains('assistant')) {
      var els = row.querySelectorAll('.reasoning-block, .tool-call-container');
      if (els.length > 0) {
        _rowCache.set(row, {
          els: els,
          content: row.querySelector('.message-content')
        });
      }
    }
  }
}

function _rowHasProcess(row) {
  if (row.classList.contains('tool')) return true;
  return _rowCache && _rowCache.has(row);
}

function _rowIsCvHidden(row) {
  if (row.classList.contains('tool')) {
    return row.classList.contains('process-cv-hidden');
  }
  var entry = _rowCache ? _rowCache.get(row) : null;
  if (!entry) return false;
  var els = entry.els;
  for (var i = 0; i < els.length; i++) {
    if (!els[i].classList.contains('process-cv-hidden')) return false;
  }
  return els.length > 0;
}

/* ── visibility (cv-hidden, NOT display:none) ── */

function _setRowCvVisible(row, isNear) {
  if (row.classList.contains('tool')) {
    row.classList.toggle('process-cv-hidden', !isNear);
    return;
  }
  var entry = _rowCache ? _rowCache.get(row) : null;
  if (!entry) return;
  var els = entry.els;
  for (var i = 0; i < els.length; i++) {
    els[i].classList.toggle('process-cv-hidden', !isNear);
  }
}

/* ── viewport detection ── */

function _findViewportTopRowIdx(rows) {
  var scrollTop = container.scrollTop;
  var startIdx = Math.max(0, Math.min(rows.length - 1, _lastTopIdx));

  // With cv-hidden, ALL rows have non-zero height, so we never need
  // the proportional fallback. offsetTop/offsetHeight are always valid.
  var checkRow = rows[startIdx];
  if (checkRow) {
    var checkBottom = checkRow.offsetTop + checkRow.offsetHeight;
    if (checkBottom > scrollTop) {
      for (var i = startIdx; i >= 0; i--) {
        var bottom = rows[i].offsetTop + rows[i].offsetHeight;
        if (bottom <= scrollTop) {
          _lastTopIdx = i + 1;
          return i + 1;
        }
      }
      _lastTopIdx = 0;
      return 0;
    }
  }

  for (var j = startIdx; j < rows.length; j++) {
    var bRowBottom = rows[j].offsetTop + rows[j].offsetHeight;
    if (bRowBottom > scrollTop) {
      _lastTopIdx = j;
      return j;
    }
  }

  return rows.length - 1;
}

/* ── viewport-aware collapse ── */

// COLLAPSE TIMING CONTRACT — three moments, nothing else folds rows:
//
// 1. Motion frames (small deltas: wheel / slow scroll) — fold only rows
//    FULLY OUTSIDE the viewport (above: with scrollTop compensation so the
//    view stays pixel-identical; below: invisible). Visible rows never
//    change height mid-scroll — that is the "delayed fold" jolt.
//
// 2. Landing settles (drag / large-jump release, full render, mode toggle)
//    — ONE comprehensive pass in the same task as the content reveal:
//    every foldable row near the viewport folds in a single paint. Rows
//    SPANNING the viewport top fold too, re-anchoring the viewport onto
//    the stub (see _foldRowIfOutside). Incremental arrivals keep their
//    state — they only ever run the conservative scan.
//
// 3. Background patches (streaming append / updateLastMessage) —
//    conservative scan only. Settle powers here would fold and re-anchor
//    rows under a user who scrolled up to read while the stream patches.
//    New tail rows are folded at birth by the append path's
//    applyCollapseLogic, so patches never need settle powers.
//
// Large-delta motion (scrollbar drag / fling) stays fully silent until
// release: the window is frozen at the drag start (arrival rows are
// cv-hidden — fold attempts are guarded no-ops), and a fold+compensation
// write mid-drag would shift the scrollbar thumb under the user's hand.
function _runCollapseScan(settleContext) {
  if (!showChatProcess || !container) return;
  if (typeof syncRowCollapseState !== 'function') return;
  var rows = _cachedRows;
  if (!rows || rows.length === 0) return;

  var scrollTop = container.scrollTop;
  var viewBottom = scrollTop + (container.clientHeight || 1);

  // Rows are in document order (offsetTop monotonic): binary search for the
  // first row whose bottom passes scrollTop, then walk forward. The row
  // before it (last fully-above row) is processed too — it is the next row
  // to re-enter the viewport when scrolling up, so it must fold first.
  var lo = 0, hi = rows.length - 1, first = rows.length;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (rows[mid].offsetTop + rows[mid].offsetHeight > scrollTop) { first = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  runWithSuppressedChatViewportObservers(function() {
    // Look back a few fully-above rows, not just the boundary row: a wheel
    // step can jump past a row's entire "fully above" band in one frame,
    // which would let a tall row enter the viewport still expanded. Rows
    // before `first` are fully above by construction (binary search), so
    // they can only hit the compensated above-branch.
    var backStart = Math.max(0, first - 5);
    for (var b = backStart; b < first; b++) _foldRowIfOutside(rows[b]);
    // Walk intersecting rows plus a few fully-below rows (they are the next
    // to enter when scrolling down — fold them before they become visible).
    var belowRun = 0;
    for (var i = first; i < rows.length; i++) {
      var row = rows[i];
      if (row.offsetTop >= viewBottom) {
        if (++belowRun > 4) break;
      }
      _foldRowIfOutside(row, settleContext);
    }
  }, 300);
}

function _foldRowIfOutside(row, settleContext) {
  var scrollTop = container.scrollTop;
  var viewBottom = scrollTop + (container.clientHeight || 1);
  var rowTop = row.offsetTop;
  var rowBottom = rowTop + row.offsetHeight;

  if (rowBottom <= scrollTop) {
    // Fully above the viewport. Folding shrinks the content above the view;
    // compensate scrollTop by the height delta so the visible content stays
    // pixel-identical (classic scroll anchoring).
    var before = row.offsetHeight;
    syncRowCollapseState(row);
    var delta = before - row.offsetHeight;
    if (delta !== 0 && !followLatestEnabled && container.scrollTop === scrollTop) {
      container.scrollTop = scrollTop - delta;
      // Keep the delta tracker in sync so the synthetic scroll event fired
      // by this write is not misread as another large user jump.
      _lastScrollTop = container.scrollTop;
    }
    return;
  }

  if (rowTop >= viewBottom) {
    // Fully below the viewport: folding is invisible
    syncRowCollapseState(row);
    return;
  }

  // Row intersects the viewport — only settle contexts may fold it, never
  // mid-scroll (that is the visible delayed-fold jolt).
  if (!settleContext) return;

  if (rowTop < scrollTop - 1 && rowBottom > scrollTop + 1) {
    // The row SPANS the viewport top edge. For rows taller than the
    // viewport this is not a transient state — it covers ~90% of the
    // row's scroll range, and it is the FIRST visible state when the row
    // arrives from below (upward scroll: its tail pokes in at the viewport
    // top already spanning). Exempting it here made long blocks unfoldable
    // after any fast upward drag: motion frames skip visible rows, so the
    // release always landed "spanning" and nothing ever folded.
    //
    // A settle context means the user just ARRIVED here by a jump (drag
    // release / render landing) — there is no reading continuity to
    // protect. Fold and re-anchor the viewport onto the stub, so the
    // landing shows the block collapsed in its conversational context
    // instead of its interior. (Incremental arrivals run scan(false) and
    // keep the exemption.) The height-delta guard leaves manually expanded
    // and already-folded rows untouched: no fold → no re-anchor.
    var beforeSpan = row.offsetHeight;
    syncRowCollapseState(row);
    if (beforeSpan - row.offsetHeight > 0) {
      // Re-read offsetTop: folds of rows above (processed first) shift it.
      if (!followLatestEnabled) {
        var stubTop = row.offsetTop;
        container.scrollTop = Math.max(0, stubTop - 120);
        // Keep the delta tracker in sync so the synthetic scroll event fired
        // by this write is not misread as another large user jump.
        _lastScrollTop = container.scrollTop;
      }
    }
    return;
  }

  // Intersecting with its top inside the viewport: the canonical fold —
  // the stub stays where the row started, content below rises.
  syncRowCollapseState(row);
}

/* ── scroll handler ── */

function _onScrollForWindowing() {
  if (!showChatProcess || !container) return;

  var currentScrollTop = container.scrollTop;
  var delta = Math.abs(currentScrollTop - _lastScrollTop);
  _lastScrollTop = currentScrollTop;

  if (!_cachedClientHeight) _cachedClientHeight = container.clientHeight;

  // Large delta (scrollbar drag / fast flick) — switch to deferral mode:
  // total silence until release. One comprehensive settle (fresh window +
  // full collapse pass) then lands in a single paint at the final position.
  if (delta > _cachedClientHeight * 0.4) _largeDeltaPending = true;

  if (!_scrollRafPending) {
    _scrollRafPending = true;
    requestAnimationFrame(function() {
      _scrollRafPending = false;
      // Silent during drag/fling: the window is frozen at the drag start
      // (arrival rows are cv-hidden — folds there are guarded no-ops), and
      // a compensated scrollTop write mid-drag shifts the thumb under the
      // user's hand. _onScrollStop does the full settle on release.
      if (_largeDeltaPending) return;
      _applyWindow();
      _runCollapseScan(false);
    });
  }

  // Scroll-stop timer
  if (_scrollStopTimer) clearTimeout(_scrollStopTimer);
  _scrollStopTimer = setTimeout(_onScrollStop, 150);
}

function _onScrollStop() {
  _scrollStopTimer = null;

  if (_largeDeltaPending) {
    // Scrollbar drag / large jump release — one full precise window update,
    // then fold in the SAME task so reveal + collapse land in one paint
    // (no delayed shift after the user has already stopped).
    _largeDeltaPending = false;
    _lastWindowStart = -1; // force fresh windowing
    _applyWindow();
    _runCollapseScan(true);
    return;
  }

  // Normal scroll-stop — rows intersecting the viewport keep their state;
  // this only catches fully-outside rows a starved rAF may have missed.
  _runCollapseScan(false);
}

function _applyWindow() {
  if (!showChatProcess || !container) return;

  // Pixel fast-path: skip all work if scrollTop is safely within window.
  // Must not fire when fresh windowing was forced (_lastWindowStart === -1):
  // after a large jump the release point can still sit inside the old
  // window's pixel bounds, which previously skipped the refresh entirely.
  var scrollTop = container.scrollTop;
  if (_winPixTop >= 0 && _lastWindowStart >= 0) {
    var halfView = container.clientHeight * 0.6;
    if (scrollTop >= _winPixTop + halfView && scrollTop <= _winPixBottom - halfView) {
      return;
    }
  }

  if (!_cachedRows || _cachedRows.length === 0 ||
      _cachedRows[0] !== container.querySelector('.message-row')) {
    _cachedRows = container.querySelectorAll('.message-row');
  }
  var rows = _cachedRows;
  if (rows.length === 0) return;

  var topIdx = _findViewportTopRowIdx(rows);
  var windowStart = Math.max(0, topIdx - WINDOW_ABOVE);
  var windowEnd = Math.min(rows.length - 1, topIdx + WINDOW_BELOW);

  if (windowStart === _lastWindowStart && windowEnd === _lastWindowEnd) return;

  var toReveal = [];
  var toHide = [];
  var i;

  if (_lastWindowStart < 0) {
    for (i = 0; i < rows.length; i++) {
      if (!_rowHasProcess(rows[i])) continue;
      if (i >= windowStart && i <= windowEnd) toReveal.push(rows[i]);
      else toHide.push(rows[i]);
    }
  } else {
    var oldStart = _lastWindowStart;
    var oldEnd = _lastWindowEnd;
    var delta = Math.abs(topIdx - _lastTopIdx);

    if (delta > WINDOW_ABOVE + WINDOW_BELOW) {
      for (i = oldStart; i <= oldEnd; i++) {
        if (i >= 0 && i < rows.length && _rowHasProcess(rows[i])) toHide.push(rows[i]);
      }
      for (i = windowStart; i <= windowEnd; i++) {
        if (i >= 0 && i < rows.length && _rowHasProcess(rows[i])) toReveal.push(rows[i]);
      }
    } else {
      for (i = oldStart; i < windowStart; i++) {
        if (i >= 0 && i < rows.length && _rowHasProcess(rows[i])) toHide.push(rows[i]);
      }
      for (i = windowEnd + 1; i <= oldEnd; i++) {
        if (i < rows.length && _rowHasProcess(rows[i])) toHide.push(rows[i]);
      }
      for (i = windowStart; i < oldStart; i++) {
        if (i >= 0 && i < rows.length && _rowHasProcess(rows[i])) toReveal.push(rows[i]);
      }
      for (i = oldEnd + 1; i <= windowEnd; i++) {
        if (i < rows.length && _rowHasProcess(rows[i])) toReveal.push(rows[i]);
      }
    }
  }

  _lastWindowStart = windowStart;
  _lastWindowEnd = windowEnd;

  if (!toReveal.length && !toHide.length) {
    _updatePixBounds(rows, windowStart, windowEnd);
    return;
  }

  // Phase 1: CSS writes — toggle cv-hidden
  // NO layout reads, NO scrollTop compensation needed.
  // cv-hidden preserves element height, so the scrollbar stays accurate.
  runWithSuppressedChatViewportObservers(function() {
    for (var j = 0; j < toHide.length; j++) {
      _setRowCvVisible(toHide[j], false);
    }
    for (var k = 0; k < toReveal.length; k++) {
      _setRowCvVisible(toReveal[k], true);
    }
  }, 500);

  // Update pixel bounds after CSS changes
  _updatePixBounds(rows, windowStart, windowEnd);

  // NOTE: collapse is handled by _onScrollStop, NOT here.
  // Putting it here causes a double-shift: reveal at full height →
  // 200ms later collapse → position jump.
}

function _updatePixBounds(rows, windowStart, windowEnd) {
  if (rows.length === 0) return;
  var fv = rows[Math.max(0, windowStart)];
  var lv = rows[Math.min(rows.length - 1, windowEnd)];
  if (fv) _winPixTop = fv.offsetTop;
  if (lv) _winPixBottom = lv.offsetTop + lv.offsetHeight;
}

/* ── public API ── */

function applyProcessDistance(root) {
  root = root || container;
  if (!showChatProcess) return;

  // Landing = first windowing after a reset. Full renders, mode toggles and
  // session switches all run clearProcessDistance first (which resets
  // _lastWindowStart to -1); streaming patches (append / updateLastMessage)
  // arrive with the previous window intact → background patch semantics.
  var isLanding = _lastWindowStart < 0;

  _cachedRows = null;
  _lastTopIdx = 0;

  var rows = root.querySelectorAll('.message-row');
  _buildRowCache(rows);

  var viewportIdx;
  if (_preToggleViewportIdx >= 0) {
    viewportIdx = _preToggleViewportIdx;
    _preToggleViewportIdx = -1;
  } else {
    viewportIdx = Math.max(0, rows.length - 1);
  }

  var windowStart = viewportIdx - WINDOW_ABOVE;
  var windowEnd = viewportIdx + WINDOW_BELOW;

  // Initial windowing: near rows visible, far rows cv-hidden
  for (var idx = 0; idx < rows.length; idx++) {
    // Remove any leftover process-hidden from hide mode
    if (rows[idx].classList.contains('tool') || rows[idx].classList.contains('system')) {
      rows[idx].classList.remove('process-hidden');
    }
    _setRowCvVisible(rows[idx], idx >= windowStart && idx <= windowEnd);
  }
  // Also remove process-hidden from assistant row children
  root.querySelectorAll('.reasoning-block.process-hidden, .tool-call-container.process-hidden')
    .forEach(function(el) { el.classList.remove('process-hidden'); });

  _lastWindowStart = Math.max(0, windowStart);
  _lastWindowEnd = Math.min(rows.length - 1, windowEnd);
  // Repopulate the row cache BEFORE the scheduled collapse check below —
  // otherwise it reads null and every post-render check silently no-ops
  // until the first _applyWindow bypasses its pixel fast-path.
  _cachedRows = rows;
  _updatePixBounds(rows, _lastWindowStart, _lastWindowEnd);

  if (!_scrollListenerAttached && container) {
    container.addEventListener('scroll', _onScrollForWindowing, { passive: true });
    _scrollListenerAttached = true;
  }

  // Landing settle: comprehensive fold in the same task as the reveal, so
  // the first paint already shows stubs (folding 200ms later caused a
  // visible jump every time a session opened). Background patches run the
  // conservative scan only — see the collapse timing contract above.
  if (isLanding) _runCollapseScan(true);
  else _runCollapseScan(false);
}

function clearProcessDistance(root) {
  root = root || container;
  _cachedRows = null;
  _rowCache = null;
  _lastTopIdx = 0;
  _lastWindowStart = -1;
  _lastWindowEnd = -1;
  _winPixTop = -1;
  _winPixBottom = -1;
  _cachedClientHeight = 0;
  _lastScrollTop = 0;
  _largeDeltaPending = false;
  if (_scrollStopTimer) { clearTimeout(_scrollStopTimer); _scrollStopTimer = null; }

  // Switch from cv-hidden to display:none (hide mode)
  root.querySelectorAll(
    '.message-row.system, .reasoning-block, ' +
    '.message-row.assistant .tool-call-container, .message-row.tool'
  ).forEach(function(el) {
    el.classList.remove('process-cv-hidden');
    el.classList.add('process-hidden');
  });

  if (_scrollListenerAttached && container) {
    container.removeEventListener('scroll', _onScrollForWindowing);
    _scrollListenerAttached = false;
  }
}

function precomputeViewportIdx() {
  var scrollTop = container.scrollTop;
  var rows = container.querySelectorAll('.message-row');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    // In hide mode, skip display:none rows
    if (row.classList.contains('process-hidden') ||
        row.classList.contains('process-hidden-empty')) continue;
    var bottom = row.offsetTop + row.offsetHeight;
    if (bottom > scrollTop) {
      _preToggleViewportIdx = i;
      return;
    }
  }
  _preToggleViewportIdx = 0;
}
