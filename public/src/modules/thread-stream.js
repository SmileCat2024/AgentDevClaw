/**
 * thread-stream.js — 线程单流视图（ADR-0024 决策 4 / PR-3）
 *
 * APP 型工作空间的流视图宿主能力：一条业务对话 = 一条连续消息流，
 * 接续（换头）对用户不可见。页面身份锚 = APP 对话引用（conversationKey），
 * 数据源（当前 head runtime / threadId）是可替换的从属字段。
 *
 *   - 视图状态（滚动、草稿、焦点）挂对话键下：本模块局部作用域，
 *     遵守 app-core 全局状态纪律（全局状态区只减不增）；
 *   - 数据源绑定：流接口快照建单流基线（predecessor 可见消息 + head
 *     渲染边界）；head 新增经既有 probe/tail 通道接入（双坐标：probe
 *     count 制数组 + 流接口给的 seq 区间换算边界，仅边界后新增段并入
 *     单流）；head 变化取新一致快照后 rewrite（滚动 / 草稿不动）；
 *   - 换头发现：SSE thread.head-advanced 即时 + 流接口 contentHash 轮询
 *     签名兜底（SSE 断连恢复），双触发去抖合并为一次重取；
 *   - 发送：POST /protoclaw/threads/:threadId/input，永不计算目标
 *     session / viewer id（服务端寻址，竞态在服务端收敛）；
 *   - rotation_failed：一条可恢复错误状态条（复用 thread-store 的
 *     failed 事实），不呈现接力过程；
 *   - thread_queued（交接窗口暂存）：「已发送、等待送达」占位，不静默
 *     吞输入；
 *   - 输入增强（capabilityActivations / pills / 语音）复用既有 composer，
 *     仅替换提交目标（submitThreadStreamInput）。
 *
 * 第一个 APP 工作空间（metadata ui.home 声明 thread-stream block）经
 * app-ui block 分发消费本模块；未声明的工作空间零感知（可拔插）。
 *
 * 依赖全局（均在运行时调用，加载顺序无关）：
 *   - escapeHtml, currentLanguage (app-core.js)
 *   - window.ClawFW.SseClient.subscribeThreadEvents (sse-client.js，PR-2)
 *   - window.ClawThreads (thread-store.js，failed 事实与链投影)
 */

(function () {
  'use strict';

  // 视图状态：对话键（APP 业务对话引用；未显式声明时回落 threadId）→
  // { draft, scrollAnchor, focusSeq }。页面身份不随 successor 变化。
  const _viewStates = new Map();
  // 流模型：threadId → buildStreamModel 产物（当前一致快照的投影）。
  const _models = new Map();
  // 活跃数据源：threadId → { debouncer, unsubscribe, pollTimer }。
  const _sources = new Map();
  // thread_queued 占位事实：threadId → { commandId, text, queuedAt }。
  const _pendingDelivery = new Map();

  const DEFAULT_POLL_INTERVAL_MS = 20000;
  const REBIND_DEBOUNCE_MS = 300;

  function _isZh() {
    return (typeof currentLanguage !== 'undefined' && currentLanguage === 'zh');
  }

  function _esc(value) {
    if (typeof escapeHtml === 'function') return escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ── 纯函数（test/frontend-thread-stream.test.js 驱动）────────────

  /**
   * 流接口快照 → 单流模型。predecessor 棒各带 seed 段之后的可见消息；
   * head 棒只带坐标（内容走 probe/tail 通道），visibleStartIndex 即
   * probe count 制数组下的渲染边界（双坐标的边界侧）。
   */
  function buildStreamModel(data) {
    const segments = Array.isArray(data?.segments) ? data.segments : [];
    const predecessor = [];
    let head = null;
    for (const seg of segments) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.role === 'head') {
        head = {
          index: Number(seg.index) || 0,
          sessionId: String(seg.sessionId || ''),
          visibleStartIndex: Number.isInteger(seg.visibleStartIndex) ? seg.visibleStartIndex : 0,
          baselineCount: Number(seg.baseline?.count) || 0,
          seedSegment: seg.seedSegment || null,
        };
      } else {
        predecessor.push({
          index: Number(seg.index) || 0,
          sessionId: String(seg.sessionId || ''),
          incomplete: seg.incomplete === true,
          incompleteReason: seg.incompleteReason || null,
          messages: Array.isArray(seg.messages) ? seg.messages : [],
        });
      }
    }
    return {
      threadId: String(data?.threadId || ''),
      headSessionId: String(data?.headSessionId || ''),
      status: String(data?.status || ''),
      contentHash: String(data?.contentHash || ''),
      revision: Number.isInteger(data?.revision) ? data.revision : null,
      hasIncomplete: segments.some((s) => s?.incomplete === true),
      predecessor,
      head,
    };
  }

  /**
   * head 的 probe 通道全量数组（count 制，含 seed 段）并入单流：
   * 仅渲染边界（visibleStartIndex）之后的新增段并入，seed 段不重复呈现。
   * 数组回缩到边界之前（rewound）说明基线失效——返回方应触发 rewrite
   * （取新一致快照），不得把旧基线与新数组拼接。
   */
  function mergeHeadMessages(model, headArray) {
    const arr = Array.isArray(headArray) ? headArray : [];
    const start = model?.head ? Math.max(0, model.head.visibleStartIndex) : 0;
    const messages = [];
    for (const seg of model?.predecessor || []) messages.push(...seg.messages);
    messages.push(...arr.slice(start));
    return {
      messages,
      headCount: arr.length,
      rewound: arr.length < start,
    };
  }

  /**
   * 换头判定：facts 来自 thread-store 轮询的线程事实（headSessionId）或
   * 流接口轮询签名（contentHash）；任一变化即需 rewrite。
   */
  function shouldRewrite(model, facts = {}) {
    if (!model) return true;
    if (facts.headSessionId && facts.headSessionId !== model.headSessionId) return true;
    if (facts.contentHash && facts.contentHash !== model.contentHash) return true;
    return false;
  }

  /**
   * 换头重取去抖：SSE 即时事件与轮询兜底在窗口内合并为一次 rewrite
   * （head-advanced 事件可能连续到达：接力落定 + 后续状态收敛）。
   */
  function createRebindDebouncer(onRebind, waitMs = REBIND_DEBOUNCE_MS) {
    let timer = null;
    let pendingHeadSessionId = null;
    const flush = () => {
      timer = null;
      const headSessionId = pendingHeadSessionId;
      pendingHeadSessionId = null;
      try { onRebind(headSessionId); } catch (e) { console.warn('[thread-stream] rebind failed:', e); }
    };
    return {
      schedule(headSessionId) {
        if (typeof headSessionId === 'string' && headSessionId) {
          pendingHeadSessionId = headSessionId;
        }
        if (timer !== null) return; // 窗口内合并
        timer = setTimeout(flush, waitMs);
      },
      cancel() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        pendingHeadSessionId = null;
      },
    };
  }

  // ── 视图状态（对话键控；换头不换键，滚动 / 草稿保持）──────────────

  function getConversationViewState(conversationKey) {
    return _viewStates.get(String(conversationKey || '')) || null;
  }

  function setConversationViewState(conversationKey, patch = {}) {
    const key = String(conversationKey || '');
    if (!key) return null;
    const prev = _viewStates.get(key) || { draft: '', scrollAnchor: null, focusSeq: null };
    const next = { ...prev, ...patch };
    _viewStates.set(key, next);
    return next;
  }

  // ── 数据源绑定 ────────────────────────────────────────────────────

  async function fetchStreamSnapshot(threadId, sinceContentHash) {
    const id = encodeURIComponent(String(threadId || ''));
    const query = sinceContentHash ? `?sinceContentHash=${encodeURIComponent(sinceContentHash)}` : '';
    const res = await fetch(`/protoclaw/threads/${id}/stream${query}`);
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async function _refreshModel(threadId, { onRewrite, onSnapshot } = {}) {
    const data = await fetchStreamSnapshot(threadId);
    if (!data || data.ok !== true || !Array.isArray(data.segments)) return null;
    const model = buildStreamModel(data);
    _models.set(threadId, model);
    if (typeof onSnapshot === 'function') onSnapshot(model);
    // rewrite：调用方按 ADR-0013 rewrite 分支全量重建消息基线（滚动 /
    // 草稿不动——页面身份不动的自然结果，不进导航事务）
    if (typeof onRewrite === 'function') onRewrite(model);
    return model;
  }

  // contentHash 轮询兜底：SSE 断连 / 重建窗口内丢帧时的恢复机制。
  async function _pollSignature(threadId, hooks) {
    const model = _models.get(threadId);
    const data = await fetchStreamSnapshot(threadId, model?.contentHash || '');
    if (!data) return;
    if (data.unchanged === true) return;
    const next = (data.ok === true && Array.isArray(data.segments)) ? data : null;
    if (next && !shouldRewrite(model, { contentHash: next.contentHash })) return;
    hooks.debouncer.schedule(next?.headSessionId);
  }

  /**
   * 绑定一条线程的单流数据源。SSE thread.head-advanced 即时触发 +
   * contentHash 轮询签名兜底，去抖合并为一次快照重取。
   *
   * @param {string} threadId
   * @param {object} [hooks]
   * @param {(model: object) => void} [hooks.onRewrite] 快照重建后回调（rewrite）
   * @param {(model: object) => void} [hooks.onSnapshot] 同上（初始基线与换头共用）
   * @param {number} [hooks.pollIntervalMs] 轮询兜底间隔（默认 20s）
   * @returns {() => void} detach
   */
  function attachThreadStream(threadId, hooks = {}) {
    const id = String(threadId || '').trim();
    if (!id) return () => {};
    detachThreadStream(id);
    const pollIntervalMs = Math.max(1000, Number(hooks.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS);
    const debouncer = createRebindDebouncer(() => {
      void _refreshModel(id, { onRewrite: hooks.onRewrite, onSnapshot: hooks.onSnapshot });
    });
    const unsubscribe = window.ClawFW?.SseClient?.subscribeThreadEvents?.(id, (evt) => {
      if (evt?.type === 'thread.head-advanced') {
        debouncer.schedule(evt.payload?.toSessionId);
      }
    }) || null;
    const pollTimer = setInterval(() => {
      void _pollSignature(id, { debouncer });
    }, pollIntervalMs);
    _sources.set(id, { debouncer, unsubscribe, pollTimer });
    void _refreshModel(id, { onRewrite: hooks.onRewrite, onSnapshot: hooks.onSnapshot });
    return () => detachThreadStream(id);
  }

  function detachThreadStream(threadId) {
    const id = String(threadId || '').trim();
    const source = _sources.get(id);
    if (!source) return;
    source.debouncer.cancel();
    if (typeof source.unsubscribe === 'function') source.unsubscribe();
    clearInterval(source.pollTimer);
    _sources.delete(id);
  }

  // ── 发送（线程寻址：永不计算目标 session / viewer id）────────────

  /**
   * 提交输入到线程输入端点（服务端解析当前 head 并复用统一网关的全部
   * 路由判定）。返回形状沿用网关：delivery 含 'thread_queued'（交接窗口
   * 暂存，呈现占位）等。
   */
  async function submitThreadStreamInput(threadId, payload = {}) {
    const id = String(threadId || '').trim();
    const res = await fetch(`/protoclaw/threads/${encodeURIComponent(id)}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: typeof payload.text === 'string' ? payload.text : '',
        ...(Array.isArray(payload.images) ? { images: payload.images } : {}),
        ...(payload.kind ? { kind: payload.kind } : {}),
        ...(typeof payload.source === 'string' && payload.source ? { source: payload.source } : {}),
        ...(Array.isArray(payload.capabilityActivations) ? { capabilityActivations: payload.capabilityActivations } : {}),
        ...(payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? { metadata: payload.metadata }
          : {}),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const error = new Error(data?.message || `thread input failed (${res.status})`);
      error.code = data?.code || 'thread_input_failed';
      error.status = res.status;
      throw error;
    }
    if (data.delivery === 'thread_queued') {
      _pendingDelivery.set(id, {
        commandId: data.commandId || null,
        text: typeof payload.text === 'string' ? payload.text : '',
        queuedAt: Date.now(),
      });
    }
    return data;
  }

  function getPendingDelivery(threadId) {
    return _pendingDelivery.get(String(threadId || '')) || null;
  }

  function clearPendingDelivery(threadId) {
    _pendingDelivery.delete(String(threadId || ''));
  }

  // ── 呈现 ──────────────────────────────────────────────────────────

  /**
   * 状态条（工单约定的两条呈现，其余零输出）：
   *   - rotation_failed：一条可恢复错误状态条（复用 thread-store 的
   *     failed 事实；不呈现接力过程）；
   *   - thread_queued：「已发送、等待送达」占位（交接窗口暂存，送达后由
   *     消息通道自然取代）。
   */
  function threadStreamStatusLine({ threadStatus, pendingDelivery } = {}) {
    const zh = _isZh();
    if (threadStatus === 'rotation_failed') {
      return `<div class="thread-stream-status thread-stream-status--error" data-thread-status="rotation_failed" role="alert">`
        + `<span class="thread-stream-status-dot"></span>`
        + (zh
          ? '上下文轮换未完成，对话仍在当前会话进行；问题解决后可重试接续。'
          : 'Context rotation did not complete; the conversation continues in the current session. Rotation can be retried later.')
        + `</div>`;
    }
    if (pendingDelivery) {
      const text = _esc(pendingDelivery.text || '');
      return `<div class="thread-stream-status thread-stream-status--queued" data-thread-status="thread_queued">`
        + `<span class="thread-stream-status-dot"></span>`
        + (zh ? '已发送，等待送达当前会话' : 'Sent — waiting for delivery to the current session')
        + (text ? `<span class="thread-stream-queued-text">${text}</span>` : '')
        + `</div>`;
    }
    return '';
  }

  /**
   * thread-stream block 渲染（metadata ui.home 声明；app-ui 分发）。
   * 骨架 = 状态条 + 单流消息容器 + composer 挂点；消息内容由
   * mergeHeadMessages 产物经 APP 接入既有渲染管线（本模块不重写消息
   * 渲染）。conversationKey 缺省回落 threadId（页面身份键）。
   */
  function renderThreadStreamBlock(block) {
    const threadId = String(block?.threadId || block?.thread?.threadId || '').trim();
    if (!threadId) return '';
    const conversationKey = String(block?.conversationKey || threadId).trim();
    const model = _models.get(threadId) || null;
    // failed 事实优先取流快照，回落 thread-store 轮询事实（复用，不平行拉取）
    const threadSummary = window.ClawThreads?.byId?.[threadId] || null;
    const threadStatus = model?.status || threadSummary?.status || '';
    const statusHtml = threadStreamStatusLine({
      threadStatus,
      pendingDelivery: getPendingDelivery(threadId),
    });
    const incompleteHtml = model?.hasIncomplete
      ? `<div class="thread-stream-status thread-stream-status--incomplete" data-thread-incomplete="1">`
        + (_isZh()
          ? '部分较早的对话记录无法验证完整性，下方流可能存在缺失。'
          : 'Some earlier conversation records could not be verified for completeness; gaps are possible.')
        + `</div>`
      : '';
    return `<div class="thread-stream" data-thread-id="${_esc(threadId)}" data-conversation-key="${_esc(conversationKey)}">`
      + statusHtml
      + incompleteHtml
      + `<div class="thread-stream-messages" data-thread-stream-messages="1"></div>`
      + `<div class="thread-stream-composer" data-thread-stream-composer="1"></div>`
      + `</div>`;
  }

  window.ThreadStream = {
    // 纯函数
    buildStreamModel,
    mergeHeadMessages,
    shouldRewrite,
    createRebindDebouncer,
    // 视图状态（对话键控）
    getConversationViewState,
    setConversationViewState,
    // 数据源
    attachThreadStream,
    detachThreadStream,
    fetchStreamSnapshot,
    // 发送
    submitThreadStreamInput,
    getPendingDelivery,
    clearPendingDelivery,
    // 呈现
    threadStreamStatusLine,
    renderThreadStreamBlock,
  };
})();
