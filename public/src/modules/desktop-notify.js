/**
 * Desktop Notification 模块
 * 从 app-main.js 拆出
 *
 * 功能：当 agent 运行完毕且页面不在前台时，通过 Notification API 弹出系统通知。
 *       内置 Web Worker 心跳绕过浏览器后台 tab timer 节流。
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   allAgents, currentLanguage
 * 依赖全局函数 (定义在 app-main.js, 运行时调用):
 *   normalizeAgentIdentity, refreshAgentCallStates,
 *   window.handlePrebuiltAgentClick, window.switchAgent
 * 导出全局函数 (window.*):
 *   _tryNotifyAgentFinished, _requestNotifyPermission
 */

/* ── Dedup: 防止同一 agent 短时间内重复通知 (60s 内不重复) ── */
const _notifiedFinishIds = new Set();

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
async function _tryNotifyAgentFinished(runtimeId) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const normId = normalizeAgentIdentity(runtimeId);

  // 关键：dedup 标记必须在可见性检查之前。
  // 即使前台时跳过了通知，也要标记"已完成"，防止用户切走后重复触发。
  if (_notifiedFinishIds.has(normId)) return;
  _notifiedFinishIds.add(normId);
  setTimeout(() => _notifiedFinishIds.delete(normId), 60000);

  // 前台时不需要通知——用户已经看到了
  if (!document.hidden && document.hasFocus()) return;

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

/* ── 请求通知权限（需在用户手势内调用） ── */
function _requestNotifyPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
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
      // 页面可见且有焦点时，常规 poll (300ms) 已经在跑，不需要 worker 介入
      if (!document.hidden && document.hasFocus()) return;
      // 通知权限未授予时也不需要心跳
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      refreshAgentCallStates(allAgents, { force: true });
    };
  } catch (e) {
    console.warn('[Notify] Web Worker heartbeat unavailable:', e);
  }
})();
