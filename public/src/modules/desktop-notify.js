/**
 * Desktop Notification 模块 — app-notification 帧呈现器（ADR-0030）
 *
 * 触发判定已上移 server（统一投递出口：权限闸 + 事件级去重 + SSE
 * app-notification 帧）；本模块只承担设备端呈现策略：
 *   1. 免打扰判定（_isObservedConversation：页面聚焦且正选中该会话
 *      才静默；页面失焦一律通知，判定用会话粒度 runtimeAgentId）；
 *   2. 呈现级去重（finishTs / requestId 事件幂等 + 30s 并发窗口）；
 *   3. 通知文案组装（fetch 最后回复做正文预览、markdown 剥离截断）；
 *   4. Tauri/Web 通知权限处理与 toast 点击导航。
 * 内置 Web Worker 心跳保留前台时钟刷新（事件路径刷新钩子）。
 *
 * 帧语义（server 侧已保证）：type=finish 的完成事实已排除挂起（ADR-0019）
 * 且按 agentId+finishTs 事件级去重；type=input 的 choice 请求按
 * agentId+requestId 去重；type=reminder 等主动投递类透传 APP 文案。
 * SSE 断连重连的 Last-Event-ID 重放会再次投递同帧，由本模块呈现级去重
 * 挡住。严禁与既有 notification 快照帧（call 状态感知，runtime-status
 * 消费）混淆——两者语义不同。
 *
 * 依赖全局状态 (定义在 app-core.js):
 *   allAgents, currentLanguage, currentRuntimeAgentId
 * 依赖全局函数 (运行时解析):
 *   normalizeAgentIdentity, _recentlyFinishedRuntimes (sidebar-render.js),
 *   window.handlePrebuiltAgentClick, window.switchAgent,
 *   window.openConversationTarget
 * 导出全局函数:
 *   _presentAppNotification, _markAgentCallStartedForNotify,
 *   _requestNotifyPermission
 */

/* ── Dedup: 呈现级去重（ADR-0030 拆层的前端半边）──
 * Map 存储 normId → { at, finishTs }（at=标记写入时刻，finishTs=帧携带的
 * 完成事件时间戳，0=payload 未携带）。事件级幂等：同一 finish 帧（重放 /
 * 多路径并发）finishTs 相同只弹一次；30s 时间窗口保留为并发防护与无
 * 时间戳 payload 的 fallback。新一轮 call.start 清空旧记录
 * （_markAgentCallStartedForNotify，所有开始入口汇聚）。
 */
const _notifiedFinishMap = new Map();

/* ── Input request 通知去重 ──
 * 与 finish 同构：normId → { requestId, ts }。同一 requestId 30s 内不重复
 * 弹（重放防护）；新 requestId（新一轮 choice）替换旧条目照常弹。
 */
const _notifiedInputRequestMap = new Map();

/* ── Foreground clock: 事件帧到达刷新（sse-client 调用）──
 * 历史上用于页面级前台宽限判定；呈现判定已改为会话级焦点
 * （_isObservedConversation），时钟保留供事件路径刷新。
 */
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

/* ── 免打扰判定：页面聚焦 && 完成会话正被选中 ──
 * 语义（与产品裁决对齐）：页面焦点不在 Claw（最小化 / 后台标签 /
 * 被其他窗口遮挡 / 桌面形态失焦）→ 一律通知；页面聚焦时只有正选中
 * 的会话免打扰（完成已可见），其他会话（含同一工作空间的兄弟会话）
 * 照常通知。历史教训两条：页面级前台静默（页面在前台全静默）会让
 * 单窗口工作流用户永远收不到通知；帧 agentId 归一到工作空间粒度
 * 会让多会话工作空间的焦点判定误杀兄弟会话——判定必须用会话粒度
 * 的 runtimeAgentId（帧缺失时回退 agentId）。
 */
function _isObservedConversation(runtimeAgentId) {
  if (document.hidden || !document.hasFocus()) return false; // 页面失焦：一律通知
  const focused = normalizeAgentIdentity(currentRuntimeAgentId);
  return !!focused && normalizeAgentIdentity(runtimeAgentId) === focused;
}

/** 帧的会话定位 id：runtimeAgentId 优先（会话粒度），缺失回退 agentId。 */
function _frameConversationId(payload) {
  return normalizeAgentIdentity(payload?.runtimeAgentId || payload?.agentId);
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

/* ── call 开始标记：新一轮 call 清除 finish 呈现状态 ──
 * 「刚刚完成」蓝灯熄灭 + dedup 记录清空：所有开始入口（SSE / 轮询 /
 * 输入 / 语音 / 切换预热）都汇聚到此处。完成后由 app-notification 帧
 * 重新走呈现流程。
 */
function _markAgentCallStartedForNotify(runtimeId) {
  const normId = normalizeAgentIdentity(runtimeId);
  if (!normId) return;
  _notifiedFinishMap.delete(normId);
  _recentlyFinishedRuntimes.delete(normId);
}

function _navigateToAgent(agent) {
  if (!agent) return;
  if (agent.source === 'prebuilt') {
    window.handlePrebuiltAgentClick(agent.id);
  } else {
    window.switchAgent(agent.id);
  }
}

function _findAgentByRuntimeId(normId) {
  return (Array.isArray(allAgents) ? allAgents : []).find(
    (a) => normalizeAgentIdentity(a.runtime_session_id || a.runtimeSessionId || a.id) === normId
  );
}

/* ── 完成通知呈现（type=finish）─────────────────────────────────────────
 * server 已判定 notifications.finish 权限、排除挂起、按 finishTs 事件级
 * 去重；此处只做设备端呈现判定与文案组装。
 */
async function _presentAgentFinishedNotification(payload) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const normId = _frameConversationId(payload);
  if (!normId) return;
  const finishTs = Number(payload?.finishTs) || 0;

  // 免打扰 = 页面聚焦 && 正选中该会话（完成已可见）；其余一律通知。
  if (_isObservedConversation(normId)) return;

  // dedup（双层）：finishTs 事件幂等 + 30s 时间窗口。标记必须在任何 await
  // 之前同步写入：重放与并发进入都靠它挡住（Tauri 通知插件忽略 tag，
  // 重复构造会弹独立 toast）。
  const now = Date.now();
  const lastNotified = _notifiedFinishMap.get(normId);
  if (lastNotified && finishTs > 0 && lastNotified.finishTs === finishTs) return;
  if (lastNotified && (now - lastNotified.at) < 30000) return;
  _notifiedFinishMap.set(normId, { at: now, finishTs });

  const agent = _findAgentByRuntimeId(normId);
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
    // 完成通知与主动投递类（提醒等）均持久显示（requireInteraction）：
    // 停留至用户查看/关闭，
    // 不随超时自动消失——完成的会话可能需要用户回来处理。
    const notification = new Notification(
      isZh ? `${agentName} 已完成` : `${agentName} finished`,
      { body, tag: 'claw-agent-finished-' + normId, requireInteraction: true }
    );
    notification.onclick = () => {
      window.focus();
      notification.close();
      _navigateToAgent(agent);
    };
  } catch (e) { /* ignore */ }
}

/* ── Input request（choice）通知呈现（type=input）─────────────────────────
 * server 已判定 notifications.input 权限并按 requestId 事件级去重；此处
 * 只做设备端呈现判定。新 requestId（新一轮 choice）替换旧条目照常弹。
 */
function _presentInputRequestNotification(payload) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const normId = _frameConversationId(payload);
  const requestId = String(payload?.requestId || '').trim();
  if (!normId || !requestId) return;

  // 免打扰 = 页面聚焦 && 正选中该会话（choice 卡片已可见）；其余一律通知。
  if (_isObservedConversation(normId)) return;

  // dedup: 同一 requestId 30s 内不重复通知（重放防护）。
  // 如果是新的 requestId（新一轮 choice），替换旧条目并继续。
  const now = Date.now();
  const prevEntry = _notifiedInputRequestMap.get(normId);
  if (prevEntry && prevEntry.requestId === requestId && (now - prevEntry.ts) < 30000) return;

  const agent = _findAgentByRuntimeId(normId);
  const agentName = (agent?.name || agent?.id || normId).trim();
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
    const notification = new Notification(
      isZh ? `${agentName} 需要你的选择` : `${agentName} needs your decision`,
      { body, tag: 'claw-agent-input-' + normId }
    );
    notification.onclick = () => {
      window.focus();
      notification.close();
      _navigateToAgent(agent);
    };
  } catch (e) { /* ignore */ }
}

/* ── 主动投递类通知呈现（type=reminder 等 APP 侧发起）─────────────────────
 * 文案由 APP 经投递端点提供（title/body 透传）；threadId 存在时点击落点
 * 优先会话导航。
 */
function _presentGenericAppNotification(payload) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const normId = normalizeAgentIdentity(payload?.agentId);
  if (!normId) return;
  const agent = _findAgentByRuntimeId(normId);
  const agentName = (agent?.name || agent?.id || normId).trim();
  const title = String(payload?.title || '').trim() || agentName;
  const body = String(payload?.body || '').trim();
  const threadId = String(payload?.threadId || '').trim();

  try {
    const notification = new Notification(title, {
      body,
      tag: 'claw-app-notification-' + normId,
      // 主动投递类（提醒等）持久显示：停留至用户查看/关闭
      requireInteraction: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      if (threadId && typeof window.openConversationTarget === 'function') {
        window.openConversationTarget({ threadId, agentId: agent?.id || normId });
        return;
      }
      _navigateToAgent(agent);
    };
  } catch (e) { /* ignore */ }
}

/* ── app-notification 帧呈现入口（sse-client 分发）── */
function _presentAppNotification(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'finish') _presentAgentFinishedNotification(payload);
  else if (payload.type === 'input') _presentInputRequestNotification(payload);
  else _presentGenericAppNotification(payload);
}

/* ── 请求通知权限（需在用户手势内调用） ── */
function _requestNotifyPermission() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission().catch(e => console.warn(e));
  }
}

/* ── Background heartbeat via Web Worker ──────────────────────────────────
 * 浏览器会将后台 tab 的 setTimeout 节流至 1s 甚至 1min。Web Worker 的
 * setInterval 不受此限制：持续刷新前台时钟（宽限期判定的时间源）。通知
 * 本体由 app-notification 帧实时驱动，心跳不再轮询触发。
 */
(function () {
  try {
    const code = `setInterval(()=>postMessage('tick'),1000);`;
    const blob = new Blob([code], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = () => {
      _syncForegroundState();
    };
  } catch (e) {
    console.warn('[Notify] Web Worker heartbeat unavailable:', e);
  }
})();
