/**
 * recap-hint.js — 离开摘要（已临时禁用）
 * 从 app-main.js 拆出（Phase A-7）
 * 拆出日期：2026-07-03
 *
 * 当前状态：RECAP_DISABLED = true，所有函数入口提前返回（`_renderRecapHint`
 * 只在已有摘要文本时渲染，而文本只可能由 `_maybeFetchRecap` 写入，因此整条
 * 链路保持断开）。本批次只做 classic → ESM 的所有权搬迁，不改这条策略。
 *
 * ESM 迁移（P2 W2-3a）：状态唯一 owner 是 p2-w2-3a-recap-state.js（活绑定 +
 * setter + `clearRecapForNewMessage` 语义 clear）。本模块只保留行为。
 *
 * 兼容桥（domain `recap-hint`，ESM 相注册——时序见 p2-w2-3a-recap-state.js
 * 头注释：本域在 classic 相没有触达点）：
 *   - `_maybeFetchRecap`           ← runtime-status.js（call.finish 后补触发）
 *   - `_renderRecapHint`           ← input-render.js（持久输入面渲染末段）
 *   - `_clearRecapForNewMessage`   ← persistent-input.js（消息提交成功路径）
 *   - `_trackRecapSessionPresence` ← app-main.js（轮询循环）
 *   - `_currentRecapText` / `_recapPendingTrigger`（状态键，注册行在状态 owner）
 *   注销条件：上述 classic 消费方迁 ESM 后改 import。
 *
 * `data-action="recap.dismiss"` 的分发器动作仍在模块执行相登记：动作只可能由
 * 已渲染的 recap 气泡触发，而气泡渲染必须晚于本模块执行（`_renderRecapHint`
 * 由持久输入面渲染调用，晚于 deferred 模块），时点等价。
 */

import { escapeHtml } from './markdown-utils.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { focusedAgentId } from './agent-store-state.js';
import { currentMessages } from './session-view-storage.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import {
  currentRecapText,
  recapFetchInFlight,
  recapLastSeenBySession,
  recapShownForSession,
  recapDismissedForSession,
  setCurrentRecapText,
  setRecapPendingTrigger,
  setRecapFetchInFlight,
  clearRecapForNewMessage as clearRecapStateForNewMessage,
} from './p2-w2-3a-recap-state.js';

// ── Recap (离开摘要) ──────────────────────────────────────────────
// 当用户切走离开当前会话（切到别的 agent/session/workspace 视图）超过阈值后
// 再切回来，自动生成一段简短回顾，显示在输入框上方帮助用户恢复上下文。
// 【已临时屏蔽】设为 true 断开 recap 链路，所有触发入口提前返回，不再实际运行。
export const RECAP_DISABLED = true;

const RECAP_AWAY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export function _getRecapAgentAndSession() {
  // 桥接期：getCurrentAgentRecord / getActiveWorkspaceSessionId 定义于
  // app-main / app-core（classic，身份解析域收敛时改 import）
  const agent = window.getCurrentAgentRecord();
  const agentId = String(agent?.parent_id || agent?.id || focusedAgentId || '').trim();
  const sessionId = window.getActiveWorkspaceSessionId(agent);
  return { agentId, sessionId };
}

export async function _maybeFetchRecap() {
  if (RECAP_DISABLED) return;
  if (recapFetchInFlight) return;
  // 桥接期：_getSessionInputCacheKey 定义于 app-main（classic）
  const sessionKey = window._getSessionInputCacheKey();
  if (!sessionKey) return;
  if (recapShownForSession.has(sessionKey)) return;
  if (recapDismissedForSession.has(sessionKey)) return;

  // Need at least some conversation to generate a meaningful recap
  if (!Array.isArray(currentMessages) || currentMessages.length < 2) return;

  const { agentId, sessionId } = _getRecapAgentAndSession();
  if (!agentId || !sessionId) return;

  // Don't trigger recap while agent is actively generating — defer to after call finish
  if (currentRuntimeAgentId && window.isRuntimeCalling(currentRuntimeAgentId)) {
    setRecapPendingTrigger(true);
    return;
  }

  setRecapFetchInFlight(true);
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
      if (window._getSessionInputCacheKey() === sessionKey) {
        setCurrentRecapText(result.recap);
        recapShownForSession.add(sessionKey);
        _renderRecapHint();
      }
    }
  } catch (e) {
    console.error('[Recap] Failed to fetch:', e);
  } finally {
    setRecapFetchInFlight(false);
  }
}

export function _dismissRecap() {
  // 桥接期：_getSessionInputCacheKey 定义于 app-main（classic）
  const sessionKey = window._getSessionInputCacheKey();
  if (sessionKey) recapDismissedForSession.add(sessionKey);
  setCurrentRecapText('');
  const container = document.getElementById('user-input-container');
  if (container) {
    const hint = container.querySelector('.recap-hint');
    if (hint) hint.remove();
    window._cleanupInputMetaBar(container);
  }
}

export function _clearRecapForNewMessage() {
  clearRecapStateForNewMessage();
  // 桥接期：_getSessionInputCacheKey 定义于 app-main（classic）
  const sessionKey = window._getSessionInputCacheKey();
  if (sessionKey) {
    recapShownForSession.delete(sessionKey);
    recapDismissedForSession.delete(sessionKey);
  }
  const container = document.getElementById('user-input-container');
  if (container) {
    const hint = container.querySelector('.recap-hint');
    if (hint) hint.remove();
    window._cleanupInputMetaBar(container);
  }
}

export function _renderRecapHint() {
  const container = document.getElementById('user-input-container');
  if (!container) return;

  const existing = container.querySelector('.recap-hint');

  if (!currentRecapText || !window.isChatSurfaceActive()) {
    if (existing) {
      existing.remove();
      window._cleanupInputMetaBar(container);
    }
    return;
  }

  // 桥接期：_getSessionInputCacheKey 定义于 app-main（classic）
  const sessionKey = window._getSessionInputCacheKey();
  if (sessionKey && recapDismissedForSession.has(sessionKey)) {
    if (existing) {
      existing.remove();
      window._cleanupInputMetaBar(container);
    }
    return;
  }

  const bar = window._ensureInputMetaBar(container);

  if (existing) {
    const textEl = existing.querySelector('.recap-hint-text');
    if (textEl) textEl.textContent = currentRecapText;
    return;
  }

  const el = document.createElement('div');
  el.className = 'recap-hint';
  el.innerHTML = `
    <span class="recap-hint-icon">#</span>
    <span class="recap-hint-text">${escapeHtml(currentRecapText)}</span>
    <button class="recap-hint-close" data-action="recap.dismiss" title="${getCurrentLanguage() === 'zh' ? '关闭' : 'Dismiss'}">
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
export function _trackRecapSessionPresence() {
  if (RECAP_DISABLED) return;
  if (!window.isChatSurfaceActive()) return;
  // 桥接期：_getSessionInputCacheKey 定义于 app-main（classic）
  const sessionKey = window._getSessionInputCacheKey();
  if (!sessionKey) return;

  const now = Date.now();
  const lastSeen = recapLastSeenBySession[sessionKey];

  if (lastSeen && (now - lastSeen) >= RECAP_AWAY_THRESHOLD_MS) {
    // Returning after absence — allow re-generation
    recapShownForSession.delete(sessionKey);
    _maybeFetchRecap();
  }

  recapLastSeenBySession[sessionKey] = now;
}

// ── 以下为仍未迁移的 classic 依赖（调用时点晚绑定）──────────────────────
// isRuntimeCalling  （runtime-status，W2-2 后续批次转 ESM）
// isChatSurfaceActive（app-ui，渲染入口域收敛时改 import）
// _ensureInputMetaBar / _cleanupInputMetaBar（persistent-input，classic）

window.KernelState.defineKey('recap-hint', '_maybeFetchRecap', _maybeFetchRecap);
window.KernelState.defineKey('recap-hint', '_clearRecapForNewMessage', _clearRecapForNewMessage);
window.KernelState.defineKey('recap-hint', '_renderRecapHint', _renderRecapHint);
window.KernelState.defineKey('recap-hint', '_trackRecapSessionPresence', _trackRecapSessionPresence);

// ── 分发器动作（原模板内联事件收编，命名空间 recap.*）─────────────
window.ClawFW.actions.registerMany({
  'recap.dismiss': () => _dismissRecap(),
});
