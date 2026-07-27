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

var WINDOW_ABOVE = 100;
var WINDOW_BELOW = 50;

/* ── state ── */

var _preToggleViewportIdx = -1;
var _scrollRafPending = false;
var _scrollListenerAttached = false;
var _lastWindowStart = -1;
var _lastWindowEnd = -1;
var _cachedRows = null;
var _lastTopIdx = 0;

/** Pixel bounds for fast-path skip */
var _winPixTop = -1;
var _winPixBottom = -1;

/** Row cache: Map<row, {els, content}> — eliminates DOM queries during scroll */
var _rowCache = null;
var _collapseTimer = null;

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
  if (row.classList.contains('tool') || row.classList.contains('system')) return true;
  return _rowCache && _rowCache.has(row);
}

/* ── visibility (cv-hidden, NOT display:none) ── */

function _setRowCvVisible(row, isNear) {
  if (row.classList.contains('tool') || row.classList.contains('system')) {
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

  for (var i = startIdx; i < rows.length; i++) {
    var bottom = rows[i].offsetTop + rows[i].offsetHeight;
    if (bottom > scrollTop) {
      _lastTopIdx = i;
      return i;
    }
  }

  return rows.length - 1;
}

/* ── debounced collapse ── */

function _scheduleCollapseCheck() {
  if (_collapseTimer) clearTimeout(_collapseTimer);
  _collapseTimer = setTimeout(function() {
    _collapseTimer = null;
    if (!showChatProcess || !container) return;
    var rows = _cachedRows;
    if (!rows || rows.length === 0) return;
    var topIdx = _findViewportTopRowIdx(rows);
    var start = Math.max(0, topIdx - 5);
    var end = Math.min(rows.length - 1, topIdx + 15);
    runWithSuppressedChatViewportObservers(function() {
      for (var i = start; i <= end; i++) {
        if (typeof syncRowCollapseState === 'function') {
          syncRowCollapseState(rows[i]);
        }
      }
    }, 300);
  }, 200);
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

  // Pixel fast-path: skip all work if scrollTop is safely within window
  var scrollTop = container.scrollTop;
  if (_winPixTop >= 0) {
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

  // Phase 2: debounced collapse
  _scheduleCollapseCheck();
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
  _updatePixBounds(rows, _lastWindowStart, _lastWindowEnd);

  if (!_scrollListenerAttached && container) {
    container.addEventListener('scroll', _onScrollForWindowing, { passive: true });
    _scrollListenerAttached = true;
  }

  _scheduleCollapseCheck();
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

  if (_collapseTimer) {
    clearTimeout(_collapseTimer);
    _collapseTimer = null;
  }

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
