/**
 * lazy-tool-content.js — display:none distance windowing with scroll listener
 *
 * Far rows use display:none (process-hidden). Near rows are fully visible.
 * A scroll listener (rAF-throttled) manages the window based on row index.
 *
 * Why not content-visibility:hidden:
 *   Chromium still renders content inside cv-hidden subtrees (confirmed by
 *   console warnings), so there's no performance benefit over display:none.
 *
 * Viewport detection:
 *   Primary: scan for first visible row at scrollTop.
 *   Fallback: proportional estimate (scrollTop/scrollHeight × rowCount).
 *   The fallback handles the case where all rows at the viewport position
 *   are display:none (no visible row to find).
 *
 * Observer suppression:
 *   500ms quiet period after each windowing operation prevents the
 *   settlement system from fighting with our scroll management.
 *
 * 依赖全局变量: container, showChatProcess
 * 依赖全局函数: runWithSuppressedChatViewportObservers, syncRowCollapseState
 * 导出: applyProcessDistance, clearProcessDistance, precomputeViewportIdx
 */

var WINDOW_ABOVE = 50;
var WINDOW_BELOW = 20;

var _preToggleViewportIdx = -1;
var _scrollRafPending = false;
var _scrollListenerAttached = false;
var _lastWindowStart = -1;
var _lastWindowEnd = -1;

/* ── row visibility ── */

function _setRowProcessVisible(row, isNear) {
  if (row.classList.contains('tool') || row.classList.contains('system')) {
    row.classList.toggle('process-hidden', !isNear);
  } else if (row.classList.contains('assistant')) {
    var children = row.querySelectorAll('.reasoning-block, .tool-call-container');
    for (var i = 0; i < children.length; i++) {
      children[i].classList.toggle('process-hidden', !isNear);
    }
    _updateAssistantEmptyState(row);
  }
}

function _updateAssistantEmptyState(row) {
  var content = row.querySelector('.message-content');
  if (!content) return;
  var hasVisible = false;
  var children = content.children;
  for (var i = 0; i < children.length; i++) {
    var child = children[i];
    if (child.classList.contains('process-hidden')) continue;
    if (child.classList.contains('markdown-body')) {
      if ((child.textContent || '').trim().length > 0) { hasVisible = true; break; }
    } else if (child.classList.contains('reasoning-block') ||
               child.classList.contains('tool-call-container')) {
      hasVisible = true; break;
    }
  }
  row.classList.toggle('process-hidden-empty', !hasVisible);
}

function _rowIsProcessHidden(row) {
  if (row.classList.contains('tool') || row.classList.contains('system')) {
    return row.classList.contains('process-hidden');
  }
  if (row.classList.contains('assistant')) {
    return row.querySelector('.reasoning-block.process-hidden, .tool-call-container.process-hidden') !== null;
  }
  return false;
}

function _rowHasProcessContent(row) {
  if (row.classList.contains('tool') || row.classList.contains('system')) return true;
  if (row.classList.contains('assistant')) {
    return row.querySelector('.reasoning-block, .tool-call-container') !== null;
  }
  return false;
}

/* ── viewport detection ── */

function _findViewportTopRowIdx(rows) {
  var scrollTop = container.scrollTop;

  // Primary: scan for first visible row at scrollTop
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (row.classList.contains('process-hidden') ||
        row.classList.contains('process-hidden-empty')) continue;
    var bottom = row.offsetTop + row.offsetHeight;
    if (bottom > scrollTop) return i;
  }

  // Fallback: proportional estimate based on scroll ratio.
  // When all rows at the viewport are display:none, this gives an
  // approximate index. The window will be refined on subsequent scrolls.
  var ratio = scrollTop / Math.max(1, container.scrollHeight);
  return Math.floor(ratio * rows.length);
}

/* ── scroll handler ── */

function _onScrollForWindowing() {
  if (_scrollRafPending) return;
  _scrollRafPending = true;
  requestAnimationFrame(function() {
    _scrollRafPending = false;
    _applyWindow();
  });
}

function _applyWindow() {
  if (!showChatProcess || !container) return;

  var rows = container.querySelectorAll('.message-row');
  if (rows.length === 0) return;

  var topIdx = _findViewportTopRowIdx(rows);
  var windowStart = Math.max(0, topIdx - WINDOW_ABOVE);
  var windowEnd = Math.min(rows.length - 1, topIdx + WINDOW_BELOW);

  // Skip if window hasn't moved
  if (windowStart === _lastWindowStart && windowEnd === _lastWindowEnd) return;

  var toReveal = [];
  var toHide = [];
  var i;

  if (_lastWindowStart < 0) {
    // First time: process all rows
    for (i = 0; i < rows.length; i++) {
      if (!_rowHasProcessContent(rows[i])) continue;
      if (i >= windowStart && i <= windowEnd) toReveal.push(rows[i]);
      else toHide.push(rows[i]);
    }
  } else {
    // Delta: only process rows that entered or left the window
    var oldStart = _lastWindowStart;
    var oldEnd = _lastWindowEnd;

    // Rows that became far (were in old window, not in new)
    for (i = oldStart; i < windowStart; i++) {
      if (i >= 0 && i < rows.length && _rowHasProcessContent(rows[i])) toHide.push(rows[i]);
    }
    for (i = windowEnd + 1; i <= oldEnd; i++) {
      if (i < rows.length && _rowHasProcessContent(rows[i])) toHide.push(rows[i]);
    }

    // Rows that became near (were outside old window, now inside)
    for (i = windowStart; i < oldStart; i++) {
      if (i >= 0 && _rowHasProcessContent(rows[i])) toReveal.push(rows[i]);
    }
    for (i = oldEnd + 1; i <= windowEnd; i++) {
      if (i < rows.length && _rowHasProcessContent(rows[i])) toReveal.push(rows[i]);
    }
  }

  _lastWindowStart = windowStart;
  _lastWindowEnd = windowEnd;

  if (!toReveal.length && !toHide.length) return;

  runWithSuppressedChatViewportObservers(function() {
    // Hide first (frees layout capacity)
    for (var j = 0; j < toHide.length; j++) {
      _setRowProcessVisible(toHide[j], false);
    }
    // Reveal
    for (var k = 0; k < toReveal.length; k++) {
      _setRowProcessVisible(toReveal[k], true);
      if (typeof syncRowCollapseState === 'function') {
        syncRowCollapseState(toReveal[k]);
      }
    }
  }, 500);
}

/* ── public API ── */

function applyProcessDistance(root) {
  root = root || container;
  if (!showChatProcess) return;

  var rows = root.querySelectorAll('.message-row');
  var viewportIdx;

  if (_preToggleViewportIdx >= 0) {
    viewportIdx = _preToggleViewportIdx;
    _preToggleViewportIdx = -1;
  } else {
    viewportIdx = Math.max(0, rows.length - 1);
  }

  var windowStart = viewportIdx - WINDOW_ABOVE;
  var windowEnd = viewportIdx + WINDOW_BELOW;

  for (var idx = 0; idx < rows.length; idx++) {
    _setRowProcessVisible(rows[idx], idx >= windowStart && idx <= windowEnd);
  }

  // Sync delta tracker so _applyWindow only processes actual changes on scroll
  _lastWindowStart = Math.max(0, windowStart);
  _lastWindowEnd = Math.min(rows.length - 1, windowEnd);

  if (!_scrollListenerAttached && container) {
    container.addEventListener('scroll', _onScrollForWindowing, { passive: true });
    _scrollListenerAttached = true;
  }
}

function clearProcessDistance(root) {
  root = root || container;
  root.querySelectorAll(
    '.message-row.system, .reasoning-block, ' +
    '.message-row.assistant .tool-call-container, .message-row.tool'
  ).forEach(function(el) {
    el.classList.add('process-hidden');
  });

  _lastWindowStart = -1;
  _lastWindowEnd = -1;

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
