/**
 * chat-nav-timeline.js — 聊天消息导航时间线
 *
 * 在聊天区域左侧渲染一组竖向小条，每条对应一条 user 消息。
 * 支持 hover 波形预览、点击暴力跳转、滚动高亮当前消息。
 *
 * 完全自包含：通过 MutationObserver 监听 container 的结构变化，
 * 不依赖 chat-renderer.js / chat-viewport.js 的任何调用点。
 *
 * 依赖（全局变量，声明于 app-core.js）:
 *   - container: 聊天容器 DOM (#chat-container)
 *   - currentMessages: 当前消息列表
 * 依赖（全局函数）:
 *   - escapeHtml (modules/markdown-utils.js)
 */

var _navTimelineEl = null;
var _navCardEl = null;
var _navBars = [];       // 可视条元素（用于波形样式）
var _navSlots = [];      // slot 包装器（用于事件 + 定位）
var _navUserIndices = [];
var _navObserver = null;
var _navScrollRaf = null;
var _navRebuildTimer = null;
var _navActiveBar = -1;
var _navResizeTimer = null;
var _navReady = false;

function _initChatNavTimeline() {
  if (_navReady) return;
  _navTimelineEl = document.getElementById('chat-nav-timeline');
  _navCardEl = document.getElementById('chat-nav-card');
  if (!_navTimelineEl || !_navCardEl || !container) return;

  _navReady = true;

  // 监听 container 结构变化（full render / append / surface 切换）
  _navObserver = new MutationObserver(function () {
    _scheduleNavRebuild();
  });
  _navObserver.observe(container, { childList: true, subtree: false });

  // 滚动监听（passive，不干扰现有 scroll 管理）
  container.addEventListener('scroll', _onNavScroll, { passive: true });

  // 窗口尺寸变化时重新定位
  window.addEventListener('resize', function () {
    clearTimeout(_navResizeTimer);
    _navResizeTimer = setTimeout(_positionNavTimeline, 150);
  });

  // 容器尺寸变化（tabs bar 显隐、header 变化等）时重新定位
  if (typeof ResizeObserver !== 'undefined') {
    var navRO = new ResizeObserver(function () {
      _positionNavTimeline();
    });
    navRO.observe(container);
  }

  // 鼠标离开整个时间线区域时重置波形
  _navTimelineEl.addEventListener('mouseleave', function () {
    _resetWave();
    _hideNavCard();
    _updateActiveNavBar();
  });

  _positionNavTimeline();
  _rebuildNavTimeline();
}

function _scheduleNavRebuild() {
  clearTimeout(_navRebuildTimer);
  _navRebuildTimer = setTimeout(_rebuildNavTimeline, 80);
}

function _positionNavTimeline() {
  if (!_navTimelineEl || !container) return;
  var mainContent = container.parentElement;
  if (!mainContent) return;
  var cRect = container.getBoundingClientRect();
  var mRect = mainContent.getBoundingClientRect();
  _navTimelineEl.style.top = (cRect.top - mRect.top) + 'px';
  _navTimelineEl.style.height = cRect.height + 'px';
}

function _rebuildNavTimeline() {
  if (!_navReady) return;

  // 查找 DOM 中的 user 消息行
  var rows = container.querySelectorAll('.message-row.user');
  if (rows.length === 0) {
    _navTimelineEl.classList.add('hidden');
    _hideNavCard();
    _navUserIndices = [];
    _navBars = [];
    _navSlots = [];
    _navActiveBar = -1;
    return;
  }

  _navTimelineEl.classList.remove('hidden');
  _positionNavTimeline();

  // 收集 user 消息索引
  _navUserIndices = [];
  var previews = [];

  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var contentEl = row.querySelector('[id^="msg-"]');
    if (!contentEl) continue;
    var idx = parseInt(contentEl.id.replace('msg-', ''), 10);
    if (isNaN(idx)) continue;

    _navUserIndices.push(idx);

    var msg = currentMessages[idx];
    var text = msg ? String(msg.content || '') : (contentEl.textContent || '');
    previews.push(text);
  }

  if (_navUserIndices.length === 0) {
    _navTimelineEl.classList.add('hidden');
    _hideNavCard();
    return;
  }

  // 重建 slot + bar 结构
  _navTimelineEl.innerHTML = '';
  _navBars = [];
  _navSlots = [];
  _navActiveBar = -1;

  for (var i = 0; i < _navUserIndices.length; i++) {
    (function (barIndex, previewText) {
      // slot：大命中区域，处理所有鼠标事件
      var slot = document.createElement('div');
      slot.className = 'chat-nav-slot';

      // bar：可视条，只做宽度动画
      var bar = document.createElement('div');
      bar.className = 'chat-nav-bar';
      slot.appendChild(bar);

      slot.addEventListener('mouseenter', function () { _onSlotHover(barIndex); });
      slot.addEventListener('click', function () { _onBarClick(barIndex); });

      _navTimelineEl.appendChild(slot);
      _navSlots.push(slot);
      _navBars.push(bar);
    })(i, previews[i]);
  }

  // 根据条数调整间距
  var n = _navBars.length;
  if (n > 40) {
    _navTimelineEl.style.setProperty('--nav-gap', '2px');
  } else if (n > 25) {
    _navTimelineEl.style.setProperty('--nav-gap', '3px');
  } else {
    _navTimelineEl.style.setProperty('--nav-gap', '4px');
  }

  _updateActiveNavBar();
}

// ── 滚动追踪 ──────────────────────────────────────

function _onNavScroll() {
  if (_navScrollRaf) return;
  _navScrollRaf = requestAnimationFrame(function () {
    _navScrollRaf = null;
    _updateActiveNavBar();
  });
}

function _updateActiveNavBar() {
  if (_navBars.length === 0) return;

  var containerTop = container.getBoundingClientRect().top;
  var bestIdx = -1;
  var bestTop = -Infinity;

  for (var i = 0; i < _navUserIndices.length; i++) {
    var el = document.getElementById('msg-' + _navUserIndices[i]);
    if (!el) continue;
    var row = el.closest('.message-row');
    if (!row) continue;
    var rRect = row.getBoundingClientRect();
    var topRelativeToViewport = rRect.top - containerTop;

    if (topRelativeToViewport <= 60 && topRelativeToViewport > bestTop) {
      bestTop = topRelativeToViewport;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) bestIdx = 0;

  if (bestIdx !== _navActiveBar) {
    _navActiveBar = bestIdx;
    for (var j = 0; j < _navBars.length; j++) {
      _navBars[j].classList.toggle('active', j === _navActiveBar);
    }
  }
}

// ── Hover 波形预览 ──────────────────────────────────

function _onSlotHover(barIndex) {
  // 设置所有条的波形宽度（只改宽度，不改高度）
  for (var i = 0; i < _navBars.length; i++) {
    var distance = Math.abs(i - barIndex);
    var influence = Math.max(0, 1 - distance / 4);
    _navBars[i].style.setProperty('--nav-wave', influence.toFixed(3));
    _navBars[i].classList.toggle('hover-focus', i === barIndex);
    _navBars[i].classList.toggle('hover-near', influence > 0 && i !== barIndex);
  }
  _showNavCard(barIndex);
}

function _resetWave() {
  for (var i = 0; i < _navBars.length; i++) {
    _navBars[i].style.removeProperty('--nav-wave');
    _navBars[i].classList.remove('hover-focus', 'hover-near');
  }
}

function _showNavCard(barIndex) {
  if (!_navCardEl || !_navSlots[barIndex]) return;

  var msgIndex = _navUserIndices[barIndex];
  var msg = currentMessages[msgIndex];
  var rawText = msg ? String(msg.content || '') : '';
  var preview = rawText.slice(0, 240);
  if (rawText.length > 240) preview += '…';

  var numLabel = '#' + (barIndex + 1);

  _navCardEl.innerHTML =
    '<div class="chat-nav-card-head">' +
      '<span class="chat-nav-card-num">' + escapeHtml(numLabel) + '</span>' +
    '</div>' +
    '<div class="chat-nav-card-body">' + escapeHtml(preview) + '</div>';

  var slotRect = _navSlots[barIndex].getBoundingClientRect();
  var mainRect = container.parentElement.getBoundingClientRect();

  _navCardEl.style.top = (slotRect.top - mainRect.top) + 'px';
  _navCardEl.classList.add('show');
}

function _hideNavCard() {
  if (_navCardEl) _navCardEl.classList.remove('show');
}

// ── 点击暴力跳转 ────────────────────────────────────

function _onBarClick(barIndex) {
  var msgIndex = _navUserIndices[barIndex];
  if (msgIndex === undefined) return;

  var el = document.getElementById('msg-' + msgIndex);
  if (!el) return;
  var row = el.closest('.message-row');
  if (!row) return;

  // 暴力切：直接设置 scrollTop，不做平滑动画
  var cRect = container.getBoundingClientRect();
  var rRect = row.getBoundingClientRect();
  var delta = rRect.top - cRect.top + container.scrollTop;
  container.scrollTop = delta - 16;

  // 短暂闪烁高亮目标行
  row.classList.add('nav-flash');
  setTimeout(function () {
    row.classList.remove('nav-flash');
  }, 700);

  _updateActiveNavBar();
}

// ── 启动 ───────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initChatNavTimeline);
} else {
  _initChatNavTimeline();
}
