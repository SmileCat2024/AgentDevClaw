/**
 * Desktop Notification 模块 — app-notification 帧呈现器（ADR-0030）
 *
 * 触发判定已上移 server（统一投递出口：权限闸 + 事件级去重 + SSE
 * app-notification 帧）；本模块只承担设备端呈现策略：
 *   1. 免打扰判定（_isObservedConversation：页面聚焦且正选中该会话
 *      才静默；页面失焦一律通知，判定用会话粒度 runtimeAgentId）；
 *   1b. 持久性判定（_shouldPersistNotification：页面失焦才常驻挂起；
 *      前台（含看别的会话）普通 toast 自动收进通知中心）；
 *   2. 呈现级去重（finish/input 事件幂等 + 30s 并发窗口；reminder 等
 *      主动投递帧同帧只弹一次——server 逐条投无事件级键，重放防护在前端）；
 *   3. 通知文案组装（fetch 最后回复做正文预览、markdown 剥离截断）；
 *   4. Tauri/Web 通知权限处理与 toast 点击导航。
 * 内置 Web Worker 心跳保留前台时钟刷新（事件路径刷新钩子）。
 *
 * 帧语义（server 侧已保证）：type=finish 的完成事实已排除挂起（ADR-0019）
 * 且按 agentId+finishTs 事件级去重；type=input 的 choice 请求按
 * agentId+requestId 去重；type=reminder 等主动投递类透传 APP 文案，server
 * 逐条投不做事件级去重（每次 POST 都是新事实）。
 * SSE 断连重连的 Last-Event-ID 重放会再次投递同帧，由本模块呈现级去重
 * 挡住（reminder 等无事件级键的帧：requestId 优先，内容键 + 30s 窗口
 * 兜底）。严禁与既有 notification 快照帧（call 状态感知，runtime-status
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
 * 注册全局回调:
 *   window.__clawConsumeNotificationActivation（壳原生 toast 点击激活，
 *   desktop/main.rs on_activated 经 webview eval 调用）
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

/* ── Generic（reminder 等主动投递）通知去重 ──
 * 同构：normId → { key, ts }。server 对这类帧逐条投、无事件级键，SSE
 * 重连重放的同一帧在此挡住。与 input 路径同语义——键匹配且 30s 窗口内
 * 才抑制：同分钟两条不同内容的提醒互不吞；真循环提醒（同文案次日再发）
 * 间隔远超窗口，不受影响。
 */
const _notifiedGenericMap = new Map();

/** 主动投递帧的呈现级去重键：requestId 优先（帧携带时）；否则内容键。 */
function _genericFrameKey(payload) {
  const requestId = String(payload?.requestId || '').trim();
  if (requestId) return `req:${requestId}`;
  return `cnt:${payload?.title ?? ''}\u0000${payload?.body ?? ''}\u0000${payload?.threadId ?? ''}`;
}

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

/* ── 持久性判定：页面失焦（用户不在 Claw）才常驻挂起 ──
 * 与免打扰判定（_isObservedConversation）同源的页面焦点语义：前台时
 * 通知只是轻提示（普通 toast，约 5 秒收进通知中心，侧栏「刚刚完成」
 * 蓝灯仍在）；页面失焦（最小化 / 后台标签 / 被遮挡）时持久挂起
 * （requireInteraction / 壳内原生 Reminder toast），停留至用户处理。
 */
function _shouldPersistNotification() {
  return document.hidden || !document.hasFocus();
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

  // 持久性按页面焦点判定：失焦（用户不在）常驻挂起；前台（看着别的
  // 会话）轻提示，自动收进通知中心。navPayload 供原生 toast 点击后
  // 定位会话（runtimeId 切会话）。
  _showPersistentNotification(
    isZh ? `${agentName} 已完成` : `${agentName} finished`,
    { body, tag: 'claw-agent-finished-' + normId, requireInteraction: _shouldPersistNotification() },
    () => {
      window.focus();
      _navigateToAgent(agent);
    },
    { runtimeId: normId, agentId: agent?.id }
  );
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

/* ── Tauri 壳原生 toast ──────────────────────────────────────────────────
 * WebView2 的 Web Notification 不兑现 requireInteraction（toast 默认 5
 * 秒收进通知中心）。壳内 toast 通知统一经自定义 command
 * persistent_notification 转系统通知：options.requireInteraction 为 true
 * 时 Windows toast 用 Scenario::Reminder（常驻屏幕直到用户处理），false
 * 时普通 toast（自动收进通知中心，与 Web API 语义对齐）。invoke 不可用 /
 * 失败时回退 Web API（浏览器语义不变，requireInteraction 由浏览器自行
 * 解释）。原生 toast 成功后不再走 Web API（避免双弹）。点击行为与 Web
 * onclick 等价：点本体 / 点「查看」按钮由壳拉窗口到前台并经 webview eval
 * 回调 __clawConsumeNotificationActivation（navPayload 原样往返，壳不
 * 解释语义）；点 X 才是纯关闭。
 */
function _showPersistentNotification(title, options, onClick, navPayload) {
  const internals = window.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === 'function') {
    internals
      .invoke('persistent_notification', {
        title,
        body: String(options.body || ''),
        persistent: options.requireInteraction !== false,
        navPayload: navPayload ? JSON.stringify(navPayload) : null,
      })
      .catch(() => { try { _webNotification(title, options, onClick); } catch (e) { /* ignore */ } });
    return;
  }
  try { _webNotification(title, options, onClick); } catch (e) { /* ignore */ }
}

function _webNotification(title, options, onClick) {
  const notification = new Notification(title, options);
  notification.onclick = onClick || null;
}

/* ── 原生 toast 点击激活的消费入口（壳 webview eval 调用）────────────────
 * 与 desktop-open.js 的 __clawConsumeOpenRequest 同模式：壳侧 on_activated
 * 拉窗口到前台后，把 invoke 时回传的导航 payload 原样交回这里执行，行为
 * 与 Web 路径 onclick 一致（threadId 优先会话导航，否则按 runtime id
 * 切会话）。payload 结构见各 _showPersistentNotification 调用点。
 */
window.__clawConsumeNotificationActivation = function (payloadJson) {
  try {
    const nav = JSON.parse(payloadJson) || {};
    window.focus();
    if (nav.threadId && typeof window.openConversationTarget === 'function') {
      window.openConversationTarget({ threadId: nav.threadId, agentId: nav.agentId });
      return;
    }
    _navigateToAgent(_findAgentByRuntimeId(nav.runtimeId || nav.agentId));
  } catch (e) { /* ignore */ }
};

/* ── 主动投递类通知呈现（type=reminder 等 APP 侧发起）─────────────────────
 * 文案由 APP 经投递端点提供（title/body 透传）；threadId 存在时点击落点
 * 优先会话导航。
 */
function _presentGenericAppNotification(payload) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  const normId = normalizeAgentIdentity(payload?.agentId);
  if (!normId) return;

  // dedup：同帧（SSE 重连重放）30s 内只弹一次；requestId 优先，内容键
  // 兜底（memo 等主动投递方不携带 requestId）。本函数全程同步，标记写
  // 在呈现之前即可挡住重放与并发。
  const now = Date.now();
  const frameKey = _genericFrameKey(payload);
  const prevGeneric = _notifiedGenericMap.get(normId);
  if (prevGeneric && prevGeneric.key === frameKey && (now - prevGeneric.ts) < 30000) return;
  _notifiedGenericMap.set(normId, { key: frameKey, ts: now });

  const agent = _findAgentByRuntimeId(normId);
  const agentName = (agent?.name || agent?.id || normId).trim();
  const title = String(payload?.title || '').trim() || agentName;
  const body = String(payload?.body || '').trim();
  const threadId = String(payload?.threadId || '').trim();

  // 持久性按页面焦点判定（同 finish：失焦常驻，前台轻提示）。
  // navPayload 供原生 toast 点击后定位：threadId 优先精确到会话，
  // 否则按 agentId。
  _showPersistentNotification(
    title,
    {
      body,
      tag: 'claw-app-notification-' + normId,
      requireInteraction: _shouldPersistNotification(),
    },
    () => {
      window.focus();
      if (threadId && typeof window.openConversationTarget === 'function') {
        window.openConversationTarget({ threadId, agentId: agent?.id || normId });
        return;
      }
      _navigateToAgent(agent);
    },
    { agentId: agent?.id || normId, threadId: threadId || undefined }
  );
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
