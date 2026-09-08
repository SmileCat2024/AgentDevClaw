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
var _navUserIndices = []; // 全量 user 消息下标（按消息顺序）

// ── 窗口化：消息数超过容器容量时，只渲染一个滑动窗口 ──
var _navWindowStart = 0;        // 窗口第一条在 _navUserIndices 中的下标
var _navCapacity = 0;           // 窗口容量（可见条数上限）
var _navWindowManual = false;   // 用户手动滑窗后挂起"窗口跟随"，直到聊天区再次滚动
var _navAutoScrollDir = 0;      // 边缘自动滚窗口方向：-1 上 / 1 下 / 0 停
var _navAutoScrollTimer = null;
var _navBandTop = null;         // 条带上方感应带（有上文可滚时存在）
var _navBandBottom = null;      // 条带下方感应带（有下文可滚时创建）
var _navEdgeHysteresis = 22;    // 防脱手：滚动中鼠标晃出感应带这么远才停

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
    _stopNavAutoScroll();
    _resetWave();
    _hideNavCard();
    _updateActiveNavBar();
  });

  // 鼠标进入条带外侧的隐形感应带时自动滚动窗口（判定区不在白条上）
  _navTimelineEl.addEventListener('mousemove', _handleNavEdgeHover);

  // 滚轮在时间线上滑动窗口（阻止事件落到聊天区，鼠标滚轮只负责更迭窗口）
  _navTimelineEl.addEventListener('wheel', function (e) {
    if (_navUserIndices.length <= _navCapacity) return;
    e.preventDefault();
    e.stopPropagation();
    _slideNavWindow(e.deltaY > 0 ? 3 : -3);
  }, { passive: false });

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
    _stopNavAutoScroll();
    _navUserIndices = [];
    _navBars = [];
    _navSlots = [];
    _navActiveBar = -1;
    _navWindowStart = 0;
    _navWindowManual = false;
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

  // 重建 slot + bar 结构（窗口化：消息数超过容器容量时按窗口滑动显示）
  _navTimelineEl.innerHTML = '';
  _navBars = [];
  _navSlots = [];
  _navActiveBar = -1;
  _navBandTop = null;
  _navBandBottom = null;

  var n = _navUserIndices.length;
  _navCapacity = _computeNavCapacity();
  if (_navWindowStart + _navCapacity > n) {
    _navWindowStart = Math.max(0, n - _navCapacity);
  }
  if (_navWindowStart < 0) _navWindowStart = 0;

  var winStart = _navWindowStart;
  var winEnd = Math.min(n, winStart + _navCapacity);

  for (var wi = winStart; wi < winEnd; wi++) {
    (function (globalIndex, previewText) {
      // slot：大命中区域，处理所有鼠标事件
      var slot = document.createElement('div');
      slot.className = 'chat-nav-slot';

      // bar：可视条，只做宽度动画
      var bar = document.createElement('div');
      bar.className = 'chat-nav-bar';
      slot.appendChild(bar);

      slot.addEventListener('mouseenter', function () { _onSlotHover(globalIndex); });
      slot.addEventListener('click', function () { _onBarClick(globalIndex); });

      _navTimelineEl.appendChild(slot);
      _navSlots.push(slot);
      _navBars.push(bar);
    })(wi, previews[wi]);
  }

  // 感应带：条带外侧的隐形滚动触发区（绝对定位在条带之外的空白区），
  // 只在有可滚方向时创建；点击落在白条上不会误触发自动滚动
  if (winStart > 0) {
    _navBandTop = _buildEdgeBand(true);
    _navTimelineEl.appendChild(_navBandTop);
  }
  if (winEnd < n) {
    _navBandBottom = _buildEdgeBand(false);
    _navTimelineEl.appendChild(_navBandBottom);
  }

  // 根据条数调整间距
  var barCount = _navBars.length;
  if (barCount > 40) {
    _navTimelineEl.style.setProperty('--nav-gap', '2px');
  } else if (barCount > 25) {
    _navTimelineEl.style.setProperty('--nav-gap', '3px');
  } else {
    _navTimelineEl.style.setProperty('--nav-gap', '4px');
  }

  _updateActiveNavBar();
}

// 容量：条带区高度除以单条步进，按最宽步进档（slot 10 + gap 4 = 14px）保守估算，
// 保证任何间距档位下窗口都填得下；步进以 slot 自身高度承载（见 CSS）。
function _computeNavCapacity() {
  if (!_navTimelineEl) return 20;
  var h = _navTimelineEl.getBoundingClientRect().height;
  var avail = h - 176; // padding: 36px 顶部感应带 + 140px 底部
  return Math.max(8, Math.floor((avail - 14) / 14));
}

// 感应带：条带外侧的透明热区，滚动判定区不在白条上，
// 点击窗口内的条目不会被误判为要滚动
function _buildEdgeBand(isTop) {
  var band = document.createElement('div');
  band.className = 'chat-nav-edge-band ' + (isTop ? 'chat-nav-edge-band-top' : 'chat-nav-edge-band-bottom');
  return band;
}

// 滑动窗口。delta 为条数（正=向更新消息方向），返回窗口是否真的移动。
// 用户主动滑窗（滚轮 / 边缘悬停）时挂起窗口跟随，避免 scroll spy 立刻把窗口
// 拉回"当前可见消息"所在的旧位置；聊天区再次滚动时由 _onNavScroll 解除。
function _slideNavWindow(delta) {
  var n = _navUserIndices.length;
  if (n <= _navCapacity || delta === 0) return false;
  var maxStart = n - _navCapacity;
  var next = Math.min(maxStart, Math.max(0, _navWindowStart + delta));
  if (next === _navWindowStart) return false;
  _navWindowStart = next;
  _navWindowManual = true;
  _rebuildNavTimeline();
  _hideNavCard();
  return true;
}

function _stopNavAutoScroll() {
  if (_navAutoScrollTimer) {
    clearInterval(_navAutoScrollTimer);
    _navAutoScrollTimer = null;
  }
  _navAutoScrollDir = 0;
}

// 边缘自动滚窗口：判定区是条带外侧的隐形感应带（不在白条上，点击条目不触发滚动）。
// 防脱手：已滚动时判定区向外扩 _navEdgeHysteresis，鼠标小幅晃出感应带不打断滚动。
function _handleNavEdgeHover(e) {
  if (!_navReady || _navSlots.length === 0 || _navUserIndices.length <= _navCapacity) {
    _stopNavAutoScroll();
    return;
  }
  var marginTop = _navAutoScrollDir === -1 ? _navEdgeHysteresis : 0;
  var marginBottom = _navAutoScrollDir === 1 ? _navEdgeHysteresis : 0;

  var dir = 0;
  if (_navBandTop && _navWindowStart > 0 &&
      e.clientY <= _navBandTop.getBoundingClientRect().bottom + marginTop) {
    dir = -1;
  } else if (_navBandBottom && _navWindowStart + _navCapacity < _navUserIndices.length &&
      e.clientY >= _navBandBottom.getBoundingClientRect().top - marginBottom) {
    dir = 1;
  }

  if (dir !== _navAutoScrollDir) {
    _stopNavAutoScroll();
    if (dir !== 0) {
      _navAutoScrollDir = dir;
      _navAutoScrollTimer = setInterval(function () {
        if (!_slideNavWindow(dir)) {
          _stopNavAutoScroll();
          return;
        }
        // 滚动进行中把焦点钉在窗口最边缘的可选条上，条目在光标下方流动，
        // 用户能持续感知到窗口在滚动（rebuild 后 mouseenter 不会自动补发）
        var pinned = dir === -1
          ? _navWindowStart
          : Math.min(_navUserIndices.length - 1, _navWindowStart + _navCapacity - 1);
        _onSlotHover(pinned);
      }, 90);
    }
  }
}

// ── 滚动追踪 ──────────────────────────────────────

function _onNavScroll() {
  // 聊天区滚动 = 阅读位置真正变化，解除手动滑窗挂起，恢复窗口跟随
  _navWindowManual = false;
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

  // 窗口跟随：当前消息滑出窗口边缘时移动窗口（带少量余量，减少滚动中频繁重建）。
  // 手动滑窗挂起期间不跟随，窗口停在用户摆的位置。
  var total = _navUserIndices.length;
  if (total > _navCapacity && !_navWindowManual) {
    if (bestIdx < _navWindowStart) {
      _navWindowStart = Math.max(0, bestIdx - 2);
      _scheduleNavRebuild();
    } else if (bestIdx >= _navWindowStart + _navCapacity) {
      _navWindowStart = Math.min(total - _navCapacity, bestIdx - _navCapacity + 3);
      _scheduleNavRebuild();
    }
  }

  // 高亮窗口内的条
  var localActive = bestIdx - _navWindowStart;
  if (localActive !== _navActiveBar) {
    _navActiveBar = localActive;
    for (var j = 0; j < _navBars.length; j++) {
      _navBars[j].classList.toggle('active', j === _navActiveBar);
    }
  }
}

// ── Hover 波形预览 ──────────────────────────────────

function _onSlotHover(globalIndex) {
  // 设置所有条的波形宽度（只改宽度，不改高度）；波形按窗口内位置计算
  var localIndex = globalIndex - _navWindowStart;
  for (var i = 0; i < _navBars.length; i++) {
    var distance = Math.abs(i - localIndex);
    var influence = Math.max(0, 1 - distance / 4);
    _navBars[i].style.setProperty('--nav-wave', influence.toFixed(3));
    _navBars[i].classList.toggle('hover-focus', i === localIndex);
    _navBars[i].classList.toggle('hover-near', influence > 0 && i !== localIndex);
  }
  _showNavCard(globalIndex);
}

function _resetWave() {
  for (var i = 0; i < _navBars.length; i++) {
    _navBars[i].style.removeProperty('--nav-wave');
    _navBars[i].classList.remove('hover-focus', 'hover-near');
  }
}

function _showNavCard(globalIndex) {
  var localIndex = globalIndex - _navWindowStart;
  if (!_navCardEl || !_navSlots[localIndex]) return;

  var msgIndex = _navUserIndices[globalIndex];
  var msg = currentMessages[msgIndex];
  var rawText = msg ? String(msg.content || '') : '';
  var preview = rawText.slice(0, 240);
  if (rawText.length > 240) preview += '…';

  var numLabel = '#' + (globalIndex + 1);

  _navCardEl.innerHTML =
    '<div class="chat-nav-card-head">' +
      '<span class="chat-nav-card-num">' + escapeHtml(numLabel) + '</span>' +
    '</div>' +
    '<div class="chat-nav-card-body">' + escapeHtml(preview) + '</div>';

  var slotRect = _navSlots[localIndex].getBoundingClientRect();
  var mainRect = container.parentElement.getBoundingClientRect();

  _navCardEl.style.top = (slotRect.top - mainRect.top) + 'px';
  _navCardEl.classList.add('show');
}

function _hideNavCard() {
  if (_navCardEl) _navCardEl.classList.remove('show');
}

// ── 点击暴力跳转 ────────────────────────────────────

function _onBarClick(globalIndex) {
  var msgIndex = _navUserIndices[globalIndex];
  if (msgIndex === undefined) return;

  var el = document.getElementById('msg-' + msgIndex);
  if (!el) return;
  var row = el.closest('.message-row');
  if (!row) return;

  // 导航点击是用户主动改变阅读位置，语义上等同于手动滚轮/拖动。
  // 先中断跟随动画和未完成的 settlement，再写入目标位置；否则
  // 距离较小时 follow-latest 会把这次跳转重新拉回底部。
  if (typeof registerManualScrollIntent === 'function') {
    registerManualScrollIntent({ interrupt: true });
  }

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
