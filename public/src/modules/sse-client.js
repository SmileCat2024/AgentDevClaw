/**
 * sse-client.js — /protoclaw/events SSE 推送通道的浏览器端消费模块。
 *
 * 设计依据 docs/sse-migration-bcd-preparation.md §5.1/§5.5/§5.6：
 * - 单条聚合流（每 tab 1 连接），事件按 kind+agentId 分发；焦点判定后走与
 *   fetch 响应完全相同的消费链（captureSessionViewToken + commitSessionViewPatch）
 * - messages 事件只携带 probe，取数复用 runMessagesProbeCycle（ADR-0013 契约不动）
 * - 熔断（连续 3 次致命失败冷却 60s）+ 401 探测闭环（停止重连，交登录流程）
 * - 30s 静默看门狗：事件帧静默超阈值 → forceFullPollOnce 一次全量对账
 *   （§6.5 第 c 层兜底；poll 的 SSE 分支不拉 notification，全量形态才有对账能力）
 * - 排队气泡乐观对账（§5.5）：POST /user-turn 响应携带服务端排队 id 作为
 *   锚点，SSE 快照按 id 确认，10s TTL 兜底移除（已被消费/转交）
 * - URL 开关：?sse=0 禁用（灰度回退）、?sse=1 强制（调试），缺省自动
 *
 * 模式切换语义：isSseActive() = 连接已收到 hello 且当前健康。poll 循环与
 * refreshAgentCallStates 等按该谓词切换行为；断连（CLOSED）即置 false，
 * 全量轮询自动恢复，事件通道恢复后由 hello 重新激活。
 *
 * 依赖（全局，运行时解析）：EventSource、currentRuntimeAgentId、
 * updateNotificationStatus、applyAgentCallStateFromNotification、
 * setConnectionStatus、getRuntimeRecord、commitMetadataUpdate、
 * runMessagesProbeCycle、applyQueuedInputsTexts、loadAgents、
 * captureSessionViewToken、_syncForegroundState、_tryNotifyInputRequest、
 * _seenChoiceAlertIds、ClawToast、window.ClawFW.requestImmediatePoll
 */

// ── 连接状态（模块局部）────────────────────────────────────────────
let _mode = 'auto';            // 'off' | 'on' | 'auto'（boot 时从 URL 解析）
let _source = null;            // EventSource 实例
let _active = false;           // 已收到 hello 且连接健康
let _fatalFailures = 0;        // 连续致命失败（CLOSED）计数，hello 清零
let _cooldownUntil = 0;        // 熔断冷却截止时间戳
let _unauthorized = false;     // 401：停止重连，等待登录流程 / 页面重载
let _lastFrameAt = 0;          // 最近一次事件帧到达时间（心跳注释帧不触发回调，天然不计）
let _watchdogTimer = null;
let _retryTimer = null;

// 焦点 runtime 最近一次 queued-inputs 快照（供 _syncPersistentInputUi 的
// SSE 分支即时消费，避免事件到达前的过渡期拉取）
let _lastQueuedSnapshot = null; // { runtimeId, items, at }

// 排队气泡乐观锚点：服务端排队 id -> { text, ts }
const _optimisticQueued = new Map();
const OPTIMISTIC_QUEUED_TTL_MS = 10000;

function isSseActive() {
  return _active;
}

function sseModeFromUrl() {
  try {
    const value = new URLSearchParams(window.location.search || '').get('sse');
    if (value === '0') return 'off';
    if (value === '1') return 'on';
  } catch { /* location 不可用（测试沙箱）时保持 auto */ }
  return 'auto';
}

function isSameRuntime(a, b) {
  const norm = (v) => String(v || '').trim();
  return norm(a) !== '' && norm(a) === norm(b);
}

// ── 事件帧分发 ─────────────────────────────────────────────────────

function handleNotificationEvent(frame) {
  // 事件到达本身证明页面代码在运行：顺带刷新前台时钟（§5.4 时钟源迁移的
  // 预置钩子，P3 心跳改造后成为宽限期判定的主时钟源之一）
  if (typeof _syncForegroundState === 'function') _syncForegroundState();
  const payload = frame?.data;
  if (!payload || typeof payload !== 'object') return;
  if (isSameRuntime(frame.agentId, currentRuntimeAgentId)) {
    // 焦点：与 fetch 路径同一条消费链（内部维护 _agentCallActive、完成
    // 通知、状态条渲染；payload 与 GET /notification 同构）
    updateNotificationStatus(payload);
  } else if (typeof applyAgentCallStateFromNotification === 'function') {
    // 非焦点：只更新侧栏级 call 状态（转圈、true→false 完成通知）
    applyAgentCallStateFromNotification(frame.agentId, payload);
  }
}

function handleConnectionEvent(frame) {
  const connected = frame?.connected !== false;
  if (isSameRuntime(frame.agentId, currentRuntimeAgentId)) {
    if (typeof setConnectionStatus === 'function') setConnectionStatus(connected);
    const record = typeof getRuntimeRecord === 'function' ? getRuntimeRecord(frame.agentId) : null;
    if (record) record.connected = connected;
  }
  // connection 事件触发即时 agent 列表刷新（§5.2：替代 3s 轮询的即时路径）
  if (typeof loadAgents === 'function') {
    loadAgents().catch((e) => console.warn('[sse] loadAgents on connection failed:', e));
  }
  // UDS 层断连恢复（§6.5 层 2）：register 重连对账尾部的事件携带
  // reconnected:true，对该 agent 做一次全量对账兜底
  if (frame?.reconnected && window.ClawFW?.forceFullPollOnce) {
    window.ClawFW.forceFullPollOnce();
  }
}

function handleTodoEvent(frame) {
  if (!isSameRuntime(frame.agentId, currentRuntimeAgentId)) return;
  if (typeof commitMetadataUpdate !== 'function') return;
  const token = captureSessionViewToken(frame.agentId);
  commitMetadataUpdate(token, { todoRaw: frame?.data ?? null });
}

function handleOverviewEvent(frame) {
  if (!isSameRuntime(frame.agentId, currentRuntimeAgentId)) return;
  if (typeof commitMetadataUpdate !== 'function') return;
  const token = captureSessionViewToken(frame.agentId);
  commitMetadataUpdate(token, { overviewJson: frame?.data ?? null });
}

function handleInputRequestsEvent(frame) {
  const requests = Array.isArray(frame?.data) ? frame.data : [];
  if (isSameRuntime(frame.agentId, currentRuntimeAgentId)) {
    const token = captureSessionViewToken(frame.agentId);
    if (typeof commitMetadataUpdate === 'function') {
      commitMetadataUpdate(token, { inputRequestsRaw: requests });
    }
    // 焦点会话的 choice 通知（_tryNotifyInputRequest 内部自判前台/去重）。
    // 谓词与非焦点分支、服务端 /protoclaw/choice_alerts 聚合同源：
    // 普通文本输入请求在输入框内呈现即可，不得触发"需要你的选择"桌面通知。
    const choiceLease = requests
      .filter((lease) => lease?.mode === 'choices'
        && Array.isArray(lease?.questions) && lease.questions.length > 0)
      .pop();
    if (choiceLease?.requestId && typeof _tryNotifyInputRequest === 'function') {
      // markObserved:false：前台到达不写观察标记，离场后由心跳 30s 重扫
      // 补发（基线行为对齐，详见 desktop-notify.js）
      _tryNotifyInputRequest(frame.agentId, choiceLease.requestId, null, { markObserved: false });
    }
  } else {
    // 与服务端 /protoclaw/choice_alerts 聚合同一谓词（mode=choices 且含
    // 问题项）：普通文本输入请求不进 choice toast（F1）
    notifyChoiceAlerts(requests
      .filter((lease) => lease?.mode === 'choices'
        && Array.isArray(lease?.questions) && lease.questions.length > 0)
      .map((lease) => ({
        requestId: lease?.requestId,
        agentId: frame.agentId,
      })));
  }
}

function handleQueuedInputsEvent(frame) {
  if (!isSameRuntime(frame.agentId, currentRuntimeAgentId)) return;
  const items = Array.isArray(frame?.data) ? frame.data : [];
  _lastQueuedSnapshot = { runtimeId: String(frame.agentId || '').trim(), items, at: Date.now() };
  const texts = reconcileQueuedTexts(items);
  if (typeof applyQueuedInputsTexts === 'function') {
    applyQueuedInputsTexts(frame.agentId, texts, items.filter(isUserQueuedItem).length);
  }
}

function handleMessagesEvent(frame) {
  if (!isSameRuntime(frame.agentId, currentRuntimeAgentId)) return;
  const probe = frame?.probe;
  if (!probe || typeof runMessagesProbeCycle !== 'function') return;
  // probe 到达路径从 overview 响应换成事件帧；seq 对账矩阵与取数逻辑
  // 原样复用（ADR-0013 契约不动）。token 捕获后取数是异步的，stale 由
  // 周期内既有的 isSessionViewTokenCurrent 检查兜底。
  const token = captureSessionViewToken(frame.agentId);
  runMessagesProbeCycle(token, probe)
    .then((outcome) => {
      // /messages 404：runtime 已消失，与轮询路径共用 runtime 消失处理（F3）
      if (outcome === 'handled404' && typeof handleCoreResponsesNotFound === 'function') {
        return handleCoreResponsesNotFound(token);
      }
      return undefined;
    })
    .catch((e) => console.warn('[sse] messages probe cycle failed:', e));
}

// ── 非焦点 choice 提醒（§4.3：ClawToast 迁移为事件驱动）─────────────
// 与 checkGlobalChoiceAlerts 共享 _seenChoiceAlertIds 去重：事件路径与
// 轮询降级路径（SSE 断连恢复期）谁先处理谁标记，不会重复 toast。
// 同时触发桌面通知（后台 tab 时 toast 不可见，系统通知直达）：此处驱动
// 首发通知，30s 周期重提醒与前台到达后离场补发由心跳低频重扫承担
// （desktop-notify.js，markObserved:false 语义）。

function notifyChoiceAlerts(alerts) {
  if (!Array.isArray(alerts)) return;
  for (const alert of alerts) {
    const requestId = alert?.requestId;
    if (!requestId || typeof _seenChoiceAlertIds === 'undefined') continue;
    if (_seenChoiceAlertIds.has(requestId)) continue;
    if (_seenChoiceAlertIds.size > 500) _seenChoiceAlertIds.clear();
    _seenChoiceAlertIds.add(requestId);
    // 后台桌面通知（_tryNotifyInputRequest 内部自判前台：前台时直接
    // 返回，后台时弹系统通知）。接替 Worker 心跳 refreshChoiceAlertStates
    // 对非焦点本地 agent 的首发通知职责；markObserved:false 使前台到达
    // 不写观察标记，离场后由心跳 30s 重扫补发（基线行为对齐）。
    if (typeof _tryNotifyInputRequest === 'function') {
      _tryNotifyInputRequest(alert.agentId, requestId, null, { markObserved: false });
    }
    if (typeof ClawToast === 'undefined' || !ClawToast?.show) continue;
    const matched = (Array.isArray(allAgents) ? allAgents : []).find(
      (a) => (a.runtime_session_id || a.runtimeSessionId) === alert.agentId
    );
    const displayName = matched?.active_workspace_display_name
      || matched?.active_workspace_session_title
      || matched?.name
      || alert.agentName
      || alert.agentId;
    const isZh = currentLanguage === 'zh';
    ClawToast.show({
      id: 'choice-alert-' + requestId,
      title: isZh ? '等待用户选择' : 'Waiting for user choice',
      description: (isZh ? '会话：' : 'Session: ') + displayName,
      status: 'warning',
    });
  }
}

// ── 排队气泡乐观对账（§5.5）────────────────────────────────────────
// 纯逻辑（可测）：快照确认乐观 id、TTL 过期清除、保留未决乐观文本。
// 输出为展示文本序列：快照文本在前，未决乐观文本追加在后。

// 排队快照里 user 与 reminder（机器通报）同队存放（viewer 邮箱不分会话），
// 但待发送气泡只承载用户输入：展示文本与待发送计数都按 kind 过滤。
function isUserQueuedItem(item) {
  return item?.kind !== 'reminder';
}

function reconcileQueuedTexts(items, nowMs = Date.now()) {
  const snapshotIds = new Set();
  const snapshotTexts = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isUserQueuedItem(item)) continue;
    if (typeof item?.id === 'string' && item.id) snapshotIds.add(item.id);
    const t = typeof item?.text === 'string' ? item.text.trim() : '';
    if (t) snapshotTexts.push(t);
    else if (Array.isArray(item?.images) && item.images.length > 0) snapshotTexts.push('🖼');
  }
  const preservedTexts = [];
  for (const [id, entry] of Array.from(_optimisticQueued.entries())) {
    if (snapshotIds.has(id)) {
      // 服务端快照已含该排队项：确认，乐观标记清除
      _optimisticQueued.delete(id);
    } else if (nowMs - entry.ts > OPTIMISTIC_QUEUED_TTL_MS) {
      // 连续快照不含且超时：已被消费/转交，移除
      _optimisticQueued.delete(id);
    } else {
      // POST 响应先到、快照尚未包含（或快照是 POST 处理前的旧帧）：保留乐观气泡
      preservedTexts.push(entry.text);
    }
  }
  return [...snapshotTexts, ...preservedTexts];
}

function noteQueuedOptimistic(id, text) {
  if (!id) return;
  _optimisticQueued.set(id, { text: text || ' ', ts: Date.now() });
}

function getLastQueuedSnapshot(runtimeId) {
  if (!_lastQueuedSnapshot) return null;
  if (runtimeId && !isSameRuntime(_lastQueuedSnapshot.runtimeId, runtimeId)) return null;
  return _lastQueuedSnapshot;
}

// ── 连接生命周期 ───────────────────────────────────────────────────

function onHello(event) {
  _fatalFailures = 0;
  _active = true;
  _lastFrameAt = Date.now();
  let payload = null;
  try { payload = JSON.parse(event.data); } catch { /* hello 帧异常按无负载处理 */ }
  // bell 双入口之一（§4.2）：首连/重连快照扫描已 pending 的 choice 请求
  if (Array.isArray(payload?.choiceAlerts)) {
    notifyChoiceAlerts(payload.choiceAlerts);
  }
  // 服务端重启（eid 归零）或缓冲超界：一次全量对账
  if (payload?.resynced && window.ClawFW?.forceFullPollOnce) {
    window.ClawFW.forceFullPollOnce();
  }
}

function onResync() {
  _lastFrameAt = Date.now();
  if (window.ClawFW?.forceFullPollOnce) window.ClawFW.forceFullPollOnce();
}

function onShutdown() {
  // 服务端主动收口（重启/维护）：立即降级轮询，等浏览器自动重连（retry 3s）
  _active = false;
}

function scheduleRetry(delayMs) {
  if (_retryTimer !== null) return;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    connect();
  }, Math.max(0, Number(delayMs) || 0));
}

/**
 * 401 探测闭环（§5.1.2）：致命断开后先探一次受保护轻量 GET——
 * 401 说明会话已过期，停止重连交由登录过期流程接管；其余情况正常重试。
 */
async function probeAuthThenRetry(delayMs) {
  try {
    const res = await fetch('/protoclaw/choice_alerts');
    if (res && res.status === 401) {
      _unauthorized = true;
      _active = false;
      return;
    }
  } catch { /* 探测失败（网络不可达）不阻断重试节奏 */ }
  scheduleRetry(delayMs);
}

function onSourceError() {
  if (!_source) return;
  // CONNECTING：浏览器按 retry 自动重连（携带 Last-Event-ID），不干预；
  // 期间 _active 保持，事件盲窗由 30s 看门狗兜底。
  if (_source.readyState === 0) return;
  // CLOSED：致命（501 未部署 / 503 连接满 / 401 / 网络彻底失败）。
  // 501（服务端不支持）会反复失败，由熔断计数收敛到冷却降级。
  _source.close();
  _source = null;
  _fatalFailures += 1;
  _active = false;
  if (_fatalFailures >= 3) {
    _cooldownUntil = Date.now() + 60000;
    _fatalFailures = 0;
    scheduleRetry(60000);
    return;
  }
  probeAuthThenRetry(3000);
}

function connect() {
  if (_mode === 'off' || _unauthorized) return;
  if (typeof EventSource === 'undefined') return;
  if (_source) return;
  const now = Date.now();
  if (now < _cooldownUntil) {
    scheduleRetry(_cooldownUntil - now);
    return;
  }
  const source = new EventSource('/protoclaw/events');
  _source = source;
  source.addEventListener('hello', onHello);
  source.addEventListener('resync', onResync);
  source.addEventListener('shutdown', onShutdown);
  source.addEventListener('notification', (e) => dispatch('notification', e));
  source.addEventListener('connection', (e) => dispatch('connection', e));
  source.addEventListener('todo', (e) => dispatch('todo', e));
  source.addEventListener('overview', (e) => dispatch('overview', e));
  source.addEventListener('input-requests', (e) => dispatch('input-requests', e));
  source.addEventListener('queued-inputs', (e) => dispatch('queued-inputs', e));
  source.addEventListener('messages', (e) => dispatch('messages', e));
  source.onerror = onSourceError;
}

function dispatch(kind, event) {
  _lastFrameAt = Date.now();
  let frame;
  try { frame = JSON.parse(event.data); } catch { return; }
  if (!frame || typeof frame.agentId !== 'string') return;
  switch (kind) {
    case 'notification': handleNotificationEvent(frame); break;
    case 'connection': handleConnectionEvent(frame); break;
    case 'todo': handleTodoEvent(frame); break;
    case 'overview': handleOverviewEvent(frame); break;
    case 'input-requests': handleInputRequestsEvent(frame); break;
    case 'queued-inputs': handleQueuedInputsEvent(frame); break;
    case 'messages': handleMessagesEvent(frame); break;
    default: break;
  }
}

// ── 30s 静默看门狗（§5.1.5 / §6.5 第 c 层）─────────────────────────
// 事件帧静默 30s（空闲 agent 的正常态）→ 一次全量 poll 对账（顺带经
// authMiddleware 刷新 idle 时钟，§6.11）。检查粒度 5s；连接不健康时
// 先降级再触发，保证对账走全量形态。

const WATCHDOG_SILENT_MS = 30000;
const WATCHDOG_INTERVAL_MS = 5000;

/**
 * 看门狗判定（纯函数，可测）：返回 { poll, deactivate }。
 * - 连接未激活（未收到 hello / 已断连）：无事可做
 * - 静默未超阈值：空闲 agent 的正常态，不扰动
 * - 静默超阈值且连接已死（onerror 未收敛的半开态）：先降级，再全量对账
 * - 静默超阈值且连接健康：只触发全量对账
 */
function watchdogDecide(active, lastFrameAt, nowMs, readyState) {
  if (!active) return { poll: false, deactivate: false };
  if (nowMs - lastFrameAt < WATCHDOG_SILENT_MS) return { poll: false, deactivate: false };
  return { poll: true, deactivate: readyState !== 1 };
}

function startWatchdog() {
  if (_watchdogTimer !== null) return;
  _watchdogTimer = setInterval(() => {
    const decision = watchdogDecide(_active, _lastFrameAt, Date.now(), _source ? _source.readyState : -1);
    if (decision.poll) {
      _lastFrameAt = Date.now(); // 防止 5s 粒度内重复触发
      if (decision.deactivate) _active = false; // 连接已死但未被 onerror 收敛：降级，poll 自动回全量
      if (window.ClawFW?.forceFullPollOnce) window.ClawFW.forceFullPollOnce();
    }
  }, WATCHDOG_INTERVAL_MS);
  if (typeof _watchdogTimer.unref === 'function') _watchdogTimer.unref();
}

// ── 自举 ───────────────────────────────────────────────────────────

function bootSseClient() {
  _mode = sseModeFromUrl();
  if (_mode === 'off') return;
  if (typeof EventSource === 'undefined') return;
  connect();
  startWatchdog();
}

window.ClawFW = window.ClawFW || {};
window.ClawFW.SseClient = {
  isSseActive,
  noteQueuedOptimistic,
  getLastQueuedSnapshot,
  reconcileQueuedTexts,
};

// 鉴权就绪后再连接（EventSource 同源自动携带 Cookie，但连接早于登录
// 完成只会收到 401 徒增熔断计数）；__clawAuthReady 由 auth-client.js
// 创建（缺省时立即连接，兼容测试沙箱与旧壳）。
if (typeof window.__clawAuthReady?.then === 'function') {
  window.__clawAuthReady.then(() => bootSseClient()).catch(() => { /* 保持轮询 */ });
} else {
  bootSseClient();
}
