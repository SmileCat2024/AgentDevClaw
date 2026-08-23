/**
 * tool-progress.js — 工具执行中进度状态与卡片 DOM 同步（ticket 025）
 *
 * 数据源：/api/agents/:id/notification 的 state 快照（tool.progress，
 * category=state，ViewerWorker 单条覆盖语义，只关心最新帧）。
 *
 * 状态纪律：
 * - 只服务当前焦点 runtime（updateNotificationStatus 本身就在同步的
 *   currentRuntimeAgentId 上下文中被调用，无 await 窗口）；
 * - 以 callId 与执行中工具卡片配对（chat-renderer 渲染 call 卡片时
 *   写入 data-tool-call-id）；结果落地（messages 中出现对应 tool 行）即清除；
 * - elapsed 由 startedAt 本地插值（200ms 时钟 tick），两次 poll 之间平滑增长。
 *
 * 导出全局函数：
 *   applyToolProgressNotification, clearToolProgressState,
 *   resolveToolProgressForCall, syncToolProgressDom
 */

// callId -> { callId, toolName, startedAt, timeoutMs, outputTail }
const _toolProgressByCallId = new Map();
// 当前 DOM 中存在的进度块数量（0 时跳过查询，关闭进度场景零开销）
let _toolProgressDomCount = 0;

function normalizeToolProgressEntry(data) {
  if (!data || typeof data !== 'object') return null;
  const callId = String(data.callId || '').trim();
  if (!callId) return null;
  const startedAt = Number(data.startedAt);
  const timeoutMs = Number(data.timeoutMs);
  return {
    callId,
    toolName: String(data.toolName || ''),
    // startedAt 缺失时以当下为起点（elapsed 从 0 走秒，不阻塞呈现）
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now(),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
    outputTail: typeof data.outputTail === 'string' ? data.outputTail.slice(-2000) : '',
  };
}

/** 由 notification 快照推进进度状态：tool.progress 入表；终态信号清除。 */
function applyToolProgressNotification(payload) {
  const state = payload && typeof payload === 'object' ? payload.state : null;
  const landed = new Set(
    (currentMessages || [])
      .filter((m) => m && m.role === 'tool' && m.toolCallId)
      .map((m) => String(m.toolCallId))
  );

  // 清除已经落地结果的旧进度，即使当前快照仍是下一工具的 tool.progress。
  let mutated = false;
  for (const id of Array.from(_toolProgressByCallId.keys())) {
    if (landed.has(id)) {
      _toolProgressByCallId.delete(id);
      mutated = true;
    }
  }

  if (state && state.type === 'tool.progress') {
    const entry = normalizeToolProgressEntry(state.data);
    if (entry) {
      _toolProgressByCallId.set(entry.callId, entry);
      mutated = true;
    }
    if (mutated) syncToolProgressDom();
    return;
  }

  if (_toolProgressByCallId.size === 0) {
    if (mutated) syncToolProgressDom();
    return;
  }

  // 清除信号：call.finish / callActive=false → 全清；结果落地已在上面按 callId 清理
  const callFinished = (state && state.type === 'call.finish')
    || payload.callActive === false
    || (payload.runtime && payload.runtime.callActive === false);
  if (callFinished) {
    _toolProgressByCallId.clear();
    mutated = true;
  }
  if (mutated) syncToolProgressDom();
}

/** 切换 runtime / 会话时整体复位。 */
function clearToolProgressState() {
  if (_toolProgressByCallId.size === 0 && _toolProgressDomCount === 0) return;
  _toolProgressByCallId.clear();
  syncToolProgressDom();
}

/** 渲染 call 卡片时取该调用的插值后进度数据；无则返回 null（模板走既有行为）。 */
function resolveToolProgressForCall(call) {
  if (!call || !call.id) return null;
  const entry = _toolProgressByCallId.get(String(call.id));
  if (!entry) return null;
  return {
    startedAt: entry.startedAt,
    elapsedMs: Math.max(0, Date.now() - entry.startedAt),
    timeoutMs: entry.timeoutMs,
    outputTail: entry.outputTail,
  };
}

// 与 bash.render.ts renderCallProgress 相同的紧凑时长格式（12s / 2m05s / 1h02m）
function _formatProgressDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

function _formatProgressTimeout(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const minutes = ms / 60000;
  return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
}

function _isZhUi() {
  try {
    return String(navigator.language || '').toLowerCase().startsWith('zh');
  } catch (e) {
    return true;
  }
}

function buildToolProgressHtml(entry) {
  const zh = _isZhUi();
  const elapsedMs = Math.max(0, Date.now() - entry.startedAt);
  const parts = [];
  parts.push(zh ? `已运行 ${_formatProgressDuration(elapsedMs)}` : `running ${_formatProgressDuration(elapsedMs)}`);
  if (entry.timeoutMs !== null) {
    parts.push(zh ? `超时 ${_formatProgressTimeout(entry.timeoutMs)}` : `timeout ${_formatProgressTimeout(entry.timeoutMs)}`);
  }
  let html = '<div class="bash-progress-meta"><span class="bash-progress-dot"></span>'
    + escapeHtml(parts.join(' · '))
    + '</div>';
  const tail = entry.outputTail.replace(/\s+$/, '');
  if (tail) {
    html += `<pre class="bash-progress-tail">${escapeHtml(tail)}</pre>`;
  }
  return html;
}

function _escapeAttrSelector(value) {
  // call.id 为 LLM 生成的标识符，通常安全；CSS.escape 兜底特殊字符
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\\]]/g, '\\$&');
}

/**
 * 进度块与执行中工具卡片的 DOM 双向同步：
 * - 清理不属于任何活跃 callId 的进度块（含全量重渲染后的历史卡片残留）；
 * - 为活跃 callId 的卡片补建 / 刷新进度块（innerHTML 比对，避免无谓重排）。
 */
function syncToolProgressDom() {
  // 快速路径：无活跃进度且 DOM 无残留块时零查询（关闭进度场景无渲染抖动）
  if (_toolProgressByCallId.size === 0 && _toolProgressDomCount === 0) return;

  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return;

  let liveCount = 0;
  const wrappers = chatContainer.querySelectorAll('.bash-progress-live');
  if (wrappers.length > 0) {
    const activeIds = new Set(_toolProgressByCallId.keys());
    const stale = [];
    wrappers.forEach((wrapper) => {
      const card = wrapper.closest('[data-tool-call-id]');
      const ownerId = card ? card.getAttribute('data-tool-call-id') : null;
      if (!ownerId || !activeIds.has(ownerId)) {
        stale.push(wrapper);
      }
    });
    if (stale.length > 0) {
      runWithSuppressedChatViewportObservers(() => {
        for (const wrapper of stale) wrapper.remove();
      });
    }
    // 活跃块在下面按 callId 重新计数，避免对既有块重复累计。
    liveCount = 0;
  }

  if (_toolProgressByCallId.size > 0) {
    for (const [callId, entry] of _toolProgressByCallId) {
      const content = chatContainer.querySelector(
        `[data-tool-call-id="${_escapeAttrSelector(callId)}"] .tool-content`
      );
      if (!content) continue;
      let block = content.querySelector('.bash-progress-live');
      const html = buildToolProgressHtml(entry);
      if (!block) {
        block = document.createElement('div');
        block.className = 'bash-progress-live';
        runWithSuppressedChatViewportObservers(() => {
          content.appendChild(block);
          block.innerHTML = html;
        });
        liveCount += 1;
      } else if (block.innerHTML !== html) {
        runWithSuppressedChatViewportObservers(() => {
          block.innerHTML = html;
        });
        liveCount += 1;
      } else {
        liveCount += 1;
      }
    }
  }

  _toolProgressDomCount = liveCount;
}
