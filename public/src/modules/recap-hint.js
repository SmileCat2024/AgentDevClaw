/**
 * recap-hint.js — 离开摘要（已临时禁用）
 * 从 app-main.js 拆出（Phase A-7）
 * 拆出日期：2026-07-03
 *
 * 当前状态：RECAP_DISABLED = true，所有函数入口提前返回。
 *
 * 依赖全局状态（定义在 app-core.js）:
 *   currentAgentId, currentRuntimeAgentId, currentMessages, currentLanguage
 * 依赖全局函数:
 *   getCurrentAgentRecord (app-main.js)
 *   getActiveWorkspaceSessionId (app-ui.js)
 *   _getSessionInputCacheKey (app-main.js)
 *   isRuntimeCalling (app-main.js)
 *   isChatSurfaceActive (app-ui.js)
 *   escapeHtml (app-core.js)
 *   _cleanupInputMetaBar (app-main.js)
 *   _ensureInputMetaBar (app-main.js)
 * 导出全局函数:
 *   _getRecapAgentAndSession, _maybeFetchRecap, _dismissRecap,
 *   _clearRecapForNewMessage, _renderRecapHint, _trackRecapSessionPresence
 * 导出全局变量:
 *   RECAP_DISABLED, _recapLastSeenBySession, _recapShownForSession,
 *   _recapDismissedForSession, _currentRecapText, _recapFetchInFlight,
 *   _recapPendingTrigger, RECAP_AWAY_THRESHOLD_MS
 * HTML onclick 引用:
 *   onclick="_dismissRecap()"
 */

// ── Recap (离开摘要) ──────────────────────────────────────────────
// 当用户切走离开当前会话（切到别的 agent/session/workspace 视图）超过阈值后
// 再切回来，自动生成一段简短回顾，显示在输入框上方帮助用户恢复上下文。
// 【已临时屏蔽】设为 true 断开 recap 链路，所有触发入口提前返回，不再实际运行。
const RECAP_DISABLED = true;

let _recapLastSeenBySession = {};     // sessionKey → 最后活跃时间戳
let _recapShownForSession = new Set();   // session cache keys that have had recap generated
let _recapDismissedForSession = new Set(); // session cache keys where user dismissed
let _currentRecapText = '';
let _recapFetchInFlight = false;
let _recapPendingTrigger = false;        // set when away threshold met but AI was busy
const RECAP_AWAY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function _getRecapAgentAndSession() {
  const agent = getCurrentAgentRecord();
  const agentId = String(agent?.parent_id || agent?.id || currentAgentId || '').trim();
  const sessionId = getActiveWorkspaceSessionId(agent);
  return { agentId, sessionId };
}

async function _maybeFetchRecap() {
  if (RECAP_DISABLED) return;
  if (_recapFetchInFlight) return;
  const sessionKey = _getSessionInputCacheKey();
  if (!sessionKey) return;
  if (_recapShownForSession.has(sessionKey)) return;
  if (_recapDismissedForSession.has(sessionKey)) return;

  // Need at least some conversation to generate a meaningful recap
  if (!Array.isArray(currentMessages) || currentMessages.length < 2) return;

  const { agentId, sessionId } = _getRecapAgentAndSession();
  if (!agentId || !sessionId) return;

  // Don't trigger recap while agent is actively generating — defer to after call finish
  if (currentRuntimeAgentId && isRuntimeCalling(currentRuntimeAgentId)) {
    _recapPendingTrigger = true;
    return;
  }

  _recapFetchInFlight = true;
  try {
    const response = await fetch('/protoclaw/generate_recap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId }),
    });
    if (!response.ok) return;
    const result = await response.json();
    if (result.ok && result.recap) {
      // Verify we're still on the same session
      if (_getSessionInputCacheKey() === sessionKey) {
        _currentRecapText = result.recap;
        _recapShownForSession.add(sessionKey);
        _renderRecapHint();
      }
    }
  } catch (e) {
    console.error('[Recap] Failed to fetch:', e);
  } finally {
    _recapFetchInFlight = false;
  }
}

function _dismissRecap() {
  const sessionKey = _getSessionInputCacheKey();
  if (sessionKey) _recapDismissedForSession.add(sessionKey);
  _currentRecapText = '';
  const container = document.getElementById('user-input-container');
  if (container) {
    const hint = container.querySelector('.recap-hint');
    if (hint) hint.remove();
    _cleanupInputMetaBar(container);
  }
}

function _clearRecapForNewMessage() {
  _currentRecapText = '';
  _recapPendingTrigger = false;
  const sessionKey = _getSessionInputCacheKey();
  if (sessionKey) {
    _recapShownForSession.delete(sessionKey);
    _recapDismissedForSession.delete(sessionKey);
  }
  const container = document.getElementById('user-input-container');
  if (container) {
    const hint = container.querySelector('.recap-hint');
    if (hint) hint.remove();
    _cleanupInputMetaBar(container);
  }
}

function _renderRecapHint() {
  const container = document.getElementById('user-input-container');
  if (!container) return;

  const existing = container.querySelector('.recap-hint');

  if (!_currentRecapText || !isChatSurfaceActive()) {
    if (existing) {
      existing.remove();
      _cleanupInputMetaBar(container);
    }
    return;
  }

  const sessionKey = _getSessionInputCacheKey();
  if (sessionKey && _recapDismissedForSession.has(sessionKey)) {
    if (existing) {
      existing.remove();
      _cleanupInputMetaBar(container);
    }
    return;
  }

  const bar = _ensureInputMetaBar(container);

  if (existing) {
    const textEl = existing.querySelector('.recap-hint-text');
    if (textEl) textEl.textContent = _currentRecapText;
    return;
  }

  const el = document.createElement('div');
  el.className = 'recap-hint';
  el.innerHTML = `
    <span class="recap-hint-icon">#</span>
    <span class="recap-hint-text">${escapeHtml(_currentRecapText)}</span>
    <button class="recap-hint-close" onclick="_dismissRecap()" title="${currentLanguage === 'zh' ? '关闭' : 'Dismiss'}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    </button>
  `;

  // Hover to expand full text, leave to collapse
  let expandTimer = null;
  el.addEventListener('mouseenter', () => {
    const textEl = el.querySelector('.recap-hint-text');
    if (!textEl) return;
    expandTimer = setTimeout(() => {
      textEl.classList.add('expanded');
    }, 300);
  });
  el.addEventListener('mouseleave', () => {
    if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
    const textEl = el.querySelector('.recap-hint-text');
    if (textEl) textEl.classList.remove('expanded');
  });

  bar.appendChild(el); // always rightmost
}

// Per-session "last seen" tracking — runs in poll loop.
// When user is actively on a chat surface, update the timestamp.
// When they return to a session after being away >= threshold, trigger recap.
function _trackRecapSessionPresence() {
  if (RECAP_DISABLED) return;
  if (!isChatSurfaceActive()) return;
  const sessionKey = _getSessionInputCacheKey();
  if (!sessionKey) return;

  const now = Date.now();
  const lastSeen = _recapLastSeenBySession[sessionKey];

  if (lastSeen && (now - lastSeen) >= RECAP_AWAY_THRESHOLD_MS) {
    // Returning after absence — allow re-generation
    _recapShownForSession.delete(sessionKey);
    _maybeFetchRecap();
  }

  _recapLastSeenBySession[sessionKey] = now;
}
