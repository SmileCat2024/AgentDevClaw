/**
 * Desktop Notification 模块
 * 从 app-main.js 拆出
 *
 * 功能：
 *   1. 当 agent 运行完毕且页面不在前台时，通过 Notification API 弹出系统通知。
 *   2. 当 user_input feature 的 choice 工具触发且页面不在前台时，同样弹出通知。
 *   内置 Web Worker 心跳绕过浏览器后台 tab timer 节流。
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   allAgents, currentLanguage
 * 依赖全局函数 (定义在 app-main.js, 运行时调用):
 *   normalizeAgentIdentity, refreshAgentCallStates,
 *   window.handlePrebuiltAgentClick, window.switchAgent
 * 导出全局函数 (window.*):
 *   _tryNotifyAgentFinished, _tryNotifyInputRequest, _requestNotifyPermission
 */

/* ── Dedup: 防止同一 agent 短时间内重复通知 ──
 * 用 Map 存储 normId → 完成时的时间戳。实际通知和前台已观察完成
 * 分开记录，新一轮 call.start 会清空对应 runtime 的旧记录。
 */
const _notifiedFinishMap = new Map();
const _foregroundObservedFinishMap = new Map();

/* ── Input request notification dedup ──
 * 与 finish 通知同样的模式：normId → { requestId, timestamp }
 * 当同一 agent 出现新的 requestId（新的 choice 请求）时替换旧条目，
 * 使新一轮 choice 请求能正常触发通知。
 */
const _notifiedInputRequestMap = new Map();
const _foregroundObservedInputMap = new Map();

/* ── Foreground grace period: 解决转换检测延迟导致的前台完成被误判为后台完成 ──
 *
 * 问题场景：
 *   1. 用户在前台观看 agent 运行
 *   2. Agent 完成，用户看到结果并读完
 *   3. calling-state 转换（true→false）被 refreshAgentCallStates 的 1s 节流、
 *      poll 周期延迟、或 _callStatesRefreshInProgress 互斥锁推迟
 *   4. 用户切到其他应用
 *   5. Web Worker 心跳检测到延迟的转换，此时 document.hidden=true → 误发通知
 *
 * 方案：追踪页面最后一次处于前台（visible + focused）的时间戳。
 *       若通知触发时距最后一次前台在宽限期内，说明用户刚离开，
 *       agent 完成时用户很可能就在看着，跳过通知。
 */
const FOREGROUND_GRACE_MS = 5000;
let _lastForegroundTs = 0; // 0 = 页面从未获得过前台焦点

function _syncForegroundState() {
  if (!document.hidden && document.hasFocus()) {
    _lastForegroundTs = Date.now();
  }
}
document.addEventListener('visibilitychange', _syncForegroundState);
window.addEventListener('focus', _syncForegroundState);
window.addEventListener('blur', _syncForegroundState);
_syncForegroundState(); // 页面加载时初始化

function _isNotifyForeground() {
  return !document.hidden && document.hasFocus();
}

function _normalizeNotifyTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1000000000000 ? n * 1000 : n;
}

function _getNotificationAction(notifData) {
  const state = notifData?.state && typeof notifData.state === 'object' ? notifData.state : null;
  const event = notifData?.event && typeof notifData.event === 'object' ? notifData.event : null;
  if (event && (!state || _normalizeNotifyTimestamp(event.timestamp) >= _normalizeNotifyTimestamp(state.timestamp))) {
    return event;
  }
  return state;
}

function _getFinishObservedTimestamp(notifData) {
  const action = _getNotificationAction(notifData);
  if (String(action?.type || '').trim() === 'call.finish') {
    const actionTs = _normalizeNotifyTimestamp(action.timestamp);
    if (actionTs) return actionTs;
  }
  const runtime = notifData?.runtime && typeof notifData.runtime === 'object' ? notifData.runtime : null;
  const runtimeSettled = runtime && runtime.callActive === false
    && ['completed', 'failed', 'cancelled'].includes(String(runtime.stage || '').trim());
  if (runtimeSettled) {
    const updatedAt = _normalizeNotifyTimestamp(runtime.updatedAt);
    if (updatedAt) return updatedAt;
  }
  return 0;
}

function _markAgentCallStartedForNotify(runtimeId) {
  const normId = normalizeAgentIdentity(runtimeId);
  if (!normId) return;
  _foregroundObservedFinishMap.delete(normId);
  _notifiedFinishMap.delete(normId);
}

function _markAgentFinishObserved(runtimeId, notifData = null) {
  const normId = normalizeAgentIdentity(runtimeId);
  if (!normId) return;
  const finishTs = _getFinishObservedTimestamp(notifData) || Date.now();
  _foregroundObservedFinishMap.set(normId, finishTs);
}

function _hasUserAlreadyObservedFinish(runtimeId, notifData = null) {
  const normId = normalizeAgentIdentity(runtimeId);
  if (!normId) return false;
  if (_foregroundObservedFinishMap.has(normId)) return true;

  const finishTs = _getFinishObservedTimestamp(notifData);
  if (finishTs > 0 && _lastForegroundTs > 0 && finishTs <= _lastForegroundTs) {
    _foregroundObservedFinishMap.set(normId, finishTs);
    return true;
  }
  return false;
}

/* ── 文本截断：去除 markdown 语法，只保留纯文本预览 ── */
function _truncateForNotification(text, maxLen = 120) {
  if (!text) return '';
  let plain = text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[.*?\]\(.*?\)/g, '[image]')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|-]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (plain.length > maxLen) {
    plain = plain.slice(0, maxLen) + '...';
  }
  return plain;
}

/* ── 主通知逻辑 ── */
async function _tryNotifyAgentFinished(runtimeId, notifData = null) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const normId = normalizeAgentIdentity(runtimeId);

  // 前台时不需要通知——用户已经看到了。
  if (_isNotifyForeground()) {
    _markAgentFinishObserved(normId, notifData);
    return;
  }

  if (_hasUserAlreadyObservedFinish(normId, notifData)) return;

  // 前台宽限期：如果页面刚从前台切走不久（在 FOREGROUND_GRACE_MS 内），
  // 说明 agent 完成时用户很可能就在看着，只是 calling-state 转换检测被
  // 节流/poll延迟/互斥锁推迟到了用户离开之后。
  // 标记 dedup 防止同一完成事件稍后被重复触发。
  const sinceForeground = _lastForegroundTs > 0 ? Date.now() - _lastForegroundTs : Infinity;
  if (sinceForeground < FOREGROUND_GRACE_MS) {
    _markAgentFinishObserved(normId, notifData);
    _notifiedFinishMap.set(normId, Date.now());
    return;
  }

  // dedup: 30s 内同一 agent 的完成事件不重复通知。
  // 仅在确认需要通知（后台 + 权限已授）时才检查和标记。
  const now = Date.now();
  const lastNotified = _notifiedFinishMap.get(normId);
  if (lastNotified && (now - lastNotified) < 30000) return;

  const agent = (Array.isArray(allAgents) ? allAgents : []).find(
    (a) => normalizeAgentIdentity(a.runtime_session_id || a.runtimeSessionId || a.id) === normId
  );
  const agentName = (agent?.name || agent?.id || normId).trim();
  const sessionTitle = (agent?.active_workspace_session_title || '').trim();
  const isZh = currentLanguage === 'zh';

  // 尝试获取最后一条 assistant 回复
  let replyPreview = '';
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(normId)}/messages`);
    if (res.ok) {
      const data = await res.json();
      const messages = data.messages || [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].content) {
          replyPreview = _truncateForNotification(messages[i].content);
          break;
        }
      }
    }
  } catch (e) { /* ignore — 通知照常发出，只是没有预览 */ }

  // 构建通知正文
  const bodyParts = [];
  if (sessionTitle) bodyParts.push(sessionTitle);
  if (replyPreview) bodyParts.push(replyPreview);
  const body = bodyParts.length > 0
    ? bodyParts.join('\n')
    : (isZh ? 'Agent 已完成运行，点击查看' : 'Agent has finished running. Click to view.');

  // 标记已通知（在实际发送通知之前，防止 fetch 期间重复触发）
  _notifiedFinishMap.set(normId, Date.now());

  try {
    const n = new Notification(
      isZh ? `${agentName} 已完成` : `${agentName} finished`,
      { body, tag: 'claw-agent-finished-' + normId }
    );
    n.onclick = () => {
      window.focus();
      n.close();
      if (agent?.source === 'prebuilt') {
        window.handlePrebuiltAgentClick(agent.id);
      } else if (agent) {
        window.switchAgent(agent.id);
      }
    };
  } catch (e) { /* ignore */ }
}

/* ── Input request (choice) 通知逻辑 ──────────────────────────────────────
 * 当 user_input feature 的 choice 工具触发时，如果页面不在前台，
 * 通过 Notification API 弹出系统通知。复用与 _tryNotifyAgentFinished 相同的
 * 保护机制：前台检测、已观察去重、前台宽限期、requestId 级去重。
 *
 * 与 finish 通知的对应关系：
 *   _foregroundObservedFinishMap  ↔  _foregroundObservedInputMap
 *   _notifiedFinishMap            ↔  _notifiedInputRequestMap
 *   _markAgentCallStartedForNotify (新一轮 call 清除 finish 状态)
 *     ↔  新 requestId 替换旧条目 (新一轮 choice 清除 input 状态)
 */
async function _tryNotifyInputRequest(runtimeId, requestId, alertData = null) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const normId = normalizeAgentIdentity(runtimeId);
  if (!normId || !requestId) return;

  // 前台时不需要通知——用户已经看到了 choice 卡片或 toast。
  if (_isNotifyForeground()) {
    _foregroundObservedInputMap.set(normId, Date.now());
    return;
  }

  // 已在前台观察过此 agent 的 input request：跳过。
  // 如果 requestId 变了（新一轮 choice），清除旧观察记录，继续走通知流程。
  if (_foregroundObservedInputMap.has(normId)) {
    const prev = _notifiedInputRequestMap.get(normId);
    if (prev && prev.requestId !== requestId) {
      _foregroundObservedInputMap.delete(normId);
    } else {
      return;
    }
  }

  // 前台宽限期：如果页面刚从前台切走不久（在 FOREGROUND_GRACE_MS 内），
  // 说明 choice 请求出现时用户很可能就在看着。
  const sinceForeground = _lastForegroundTs > 0 ? Date.now() - _lastForegroundTs : Infinity;
  if (sinceForeground < FOREGROUND_GRACE_MS) {
    _foregroundObservedInputMap.set(normId, Date.now());
    _notifiedInputRequestMap.set(normId, { requestId, ts: Date.now() });
    return;
  }

  // dedup: 同一 requestId 30s 内不重复通知。
  // 如果是新的 requestId（新一轮 choice），替换旧条目并继续。
  const now = Date.now();
  const prevEntry = _notifiedInputRequestMap.get(normId);
  if (prevEntry && prevEntry.requestId === requestId && (now - prevEntry.ts) < 30000) return;

  const agent = (Array.isArray(allAgents) ? allAgents : []).find(
    (a) => normalizeAgentIdentity(a.runtime_session_id || a.runtimeSessionId || a.id) === normId
  );
  const agentName = (agent?.name || alertData?.agentName || agent?.id || normId).trim();
  const sessionTitle = (agent?.active_workspace_session_title || '').trim();
  const isZh = currentLanguage === 'zh';

  // 构建通知正文
  const bodyParts = [];
  if (sessionTitle) bodyParts.push(sessionTitle);
  bodyParts.push(isZh ? '需要你做个选择' : 'Needs your decision');
  const body = bodyParts.join('\n');

  // 标记已通知（在实际发送通知之前，防止重复触发）
  _notifiedInputRequestMap.set(normId, { requestId, ts: now });

  try {
    const n = new Notification(
      isZh ? `${agentName} 需要你的选择` : `${agentName} needs your decision`,
      { body, tag: 'claw-agent-input-' + normId }
    );
    n.onclick = () => {
      window.focus();
      n.close();
      if (agent?.source === 'prebuilt') {
        window.handlePrebuiltAgentClick(agent.id);
      } else if (agent) {
        window.switchAgent(agent.id);
      }
    };
  } catch (e) { /* ignore */ }
}

/* ── 请求通知权限（需在用户手势内调用） ── */
function _requestNotifyPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(e => console.warn(e));
  }
}

/* ── Choice-alert 状态刷新（独立于 checkGlobalChoiceAlerts）────────────────
 *
 * 关键设计：此函数与 auto-title.js 中的 checkGlobalChoiceAlerts 完全独立。
 *
 * 问题背景：checkGlobalChoiceAlerts 使用 _seenChoiceAlertIds 做去重，
 *   一旦前台 poll 循环处理了某个 requestId，worker 心跳再调用同一函数时
 *   会被 _seenChoiceAlertIds 跳过，导致 _tryNotifyInputRequest 永远不会
 *   从后台路径被触发。
 *
 * 解决方案：refreshChoiceAlertStates 直接 fetch /protoclaw/choice_alerts，
 *   不经过 _seenChoiceAlertIds，为每个活跃请求调用 _tryNotifyInputRequest。
 *   所有去重逻辑（前台检测、宽限期、requestId 级 30s 窗口）由
 *   _tryNotifyInputRequest 内部处理。
 *
 * 这与 refreshAgentCallStates 的设计完全对称：
 *   refreshAgentCallStates  → 独立 fetch /notification → _tryNotifyAgentFinished
 *   refreshChoiceAlertStates → 独立 fetch /choice_alerts → _tryNotifyInputRequest
 */
let _lastChoiceNotifyCheckAt = 0;

async function refreshChoiceAlertStates() {
  try {
    const res = await fetch('/protoclaw/choice_alerts');
    if (!res.ok) return;
    const data = await res.json();
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    for (const alert of alerts) {
      _tryNotifyInputRequest(alert.agentId, alert.requestId, alert);
    }
  } catch { /* non-critical */ }
}

/* ── Background heartbeat via Web Worker ──────────────────────────────────
 * 浏览器会将后台 tab 的 setTimeout 节流至 1s 甚至 1min，导致轮询检测不到
 * agent 完成。Web Worker 的 setInterval 不受此限制。
 */
(function () {
  try {
    const code = `setInterval(()=>postMessage('tick'),1000);`;
    const blob = new Blob([code], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = () => {
      // 持续刷新前台时间戳（worker 不受后台 tab timer 节流）
      _syncForegroundState();
      // 页面可见且有焦点时，常规 poll (300ms) 已经在跑，不需要 worker 介入
      if (!document.hidden && document.hasFocus()) return;
      // 通知权限未授予时也不需要心跳
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      refreshAgentCallStates(allAgents, { force: true });
      // 后台时也检查 choice 请求（poll 循环可能被节流，无法及时检测）
      // 使用独立的 refreshChoiceAlertStates 而非 checkGlobalChoiceAlerts，
      // 避免 _seenChoiceAlertIds 去重阻断后台通知路径
      if (Date.now() - _lastChoiceNotifyCheckAt > 2000) {
        _lastChoiceNotifyCheckAt = Date.now();
        refreshChoiceAlertStates().catch(e => console.warn(e));
      }
    };
  } catch (e) {
    console.warn('[Notify] Web Worker heartbeat unavailable:', e);
  }
})();
