/**
 * annotations.js — 会话标注（conversation-annotations feature 的前端消费端）
 *
 * 职责链（通信全部走 ADR-0018 feature-comms 通道，不自建链路）：
 * - 选中捕获：#chat-container 内单条 user/assistant 消息的部分选中 → 浮动
 *   弹窗 → create 请求。锚位 = { turn, role, quote, occurrence }：框架消息
 *   无稳定 id，turn（轮次号）是唯一稳定锚，quote + occurrence 定位轮内文本。
 * - 高亮重放：对消息行渲染文本建"归一化空白文本模型"，全文搜索 quote 的第
 *   occurrence 次出现，跨文本节点用 <mark class="anno-highlight"> 包裹。
 *   创建与重放共用同一匹配口径（occurrenceFor / findOccurrence）。
 * - 删除：点已有高亮 → 删除弹窗 → remove 请求。
 * - 会话同步：寻址变化时重置状态、拉取 list、（重）订阅 SSE
 *   （created / removed 事件驱动重放与面板缓存；远程会话降级不可用）。
 * - 面板数据：window.ClawAnnotations.getPanelHtml 供 rail 面板渲染
 *   （app-ui.js 注册，debug-panel-host.js 管生命周期）。
 *
 * 状态真值源在 feature（runtime 进程内存态 + 会话快照落盘）；本模块只持
 * 请求面拉回的缓存副本，事件到达后按需重拉或本地对账。
 */
(function () {
  'use strict';

  const FEATURE_ID = 'conversation-annotations';
  const CHANNEL_ID = 'annotations';
  const QUOTE_MAX_CHARS = 4000;

  // ── 模块状态（会话切换时整体重置）────────────────────────────────
  let annotations = [];        // 当前会话标注缓存（feature list 请求面为准）
  let addressing = null;       // { agentId, sessionId }
  let sessionKey = '';         // 寻址键（变化检测）
  let stream = null;           // EventSource（SSE latest=1）
  let listSeq = 0;             // list 请求竞态守卫
  let panelOpen = false;

  function t(zh, en) {
    return (typeof currentLanguage === 'string' ? currentLanguage : 'zh') === 'zh' ? zh : en;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(status, title, description) {
    if (typeof window.ClawToast?.show !== 'function') return;
    window.ClawToast.show({ id: `annotations-${status}-${Date.now()}`, status, title, description });
  }

  // ── 寻址（对齐 bg-panel 的宿主身份纪律）─────────────────────────

  function currentAddressing() {
    const runtimeRef = typeof currentRuntimeAgentId === 'string' ? currentRuntimeAgentId : '';
    const sessionId = (typeof getRuntimeWorkspaceSessionId === 'function' && runtimeRef
      ? getRuntimeWorkspaceSessionId(runtimeRef)
      : '') || (typeof getActiveWorkspaceSessionId === 'function' ? getActiveWorkspaceSessionId() : '');
    if (!sessionId) return null;
    // 远程会话没有本机 feature-comms 通道，降级为不可用（不猜目标）。
    const focused = typeof focusedAgentId === 'string' ? focusedAgentId : '';
    if (typeof isRemoteNamespaceAgentId === 'function'
      && (isRemoteNamespaceAgentId(focused) || isRemoteNamespaceAgentId(runtimeRef))) return null;
    const agentId = focused || '';
    if (!agentId) return null;
    return { agentId, sessionId };
  }

  // ── 请求面 ────────────────────────────────────────────────────────

  async function channelRequest(requestType, payload) {
    if (!addressing) return { ok: false, code: 'no_session' };
    const response = await fetch('/protoclaw/feature-comms/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: addressing.agentId,
        sessionId: addressing.sessionId,
        featureId: FEATURE_ID,
        channelId: CHANNEL_ID,
        requestType,
        payload: payload || {},
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, code: body?.code || body?.result?.code || `HTTP ${response.status}` };
    }
    return body?.result || { ok: false, code: 'empty_result' };
  }

  // ── 会话同步（寻址变化 → 重置 + 拉取 + 订阅）─────────────────────

  function ensureSession() {
    const next = currentAddressing();
    const nextKey = next ? `${next.agentId}/${next.sessionId}` : '';
    if (nextKey === sessionKey) return;
    sessionKey = nextKey;
    addressing = next;
    closeStream();
    annotations = [];
    if (next) {
      void loadList();
      subscribe();
    }
    scheduleReplay();
  }

  async function loadList() {
    const seq = ++listSeq;
    const result = await channelRequest('list', {});
    if (seq !== listSeq) return; // 过期响应（会话已切换）
    if (result.ok && Array.isArray(result.annotations)) {
      annotations = result.annotations;
      scheduleReplay();
      if (panelOpen) repaintPanel();
    }
  }

  function closeStream() {
    if (stream) { stream.close(); stream = null; }
  }

  function subscribe() {
    if (!addressing) return;
    const params = new URLSearchParams({
      agentId: addressing.agentId,
      sessionId: addressing.sessionId,
      featureId: FEATURE_ID,
      channelId: CHANNEL_ID,
      latest: '1',
    });
    const source = new EventSource(`/protoclaw/feature-comms/stream?${params}`);
    stream = source;
    source.addEventListener('event', event => {
      if (stream !== source) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload?.type === 'created' && payload?.data?.id) {
        annotations = [...annotations.filter(a => a.id !== payload.data.id), payload.data]
          .sort((a, b) => a.createdAt - b.createdAt);
        scheduleReplay();
        if (panelOpen) repaintPanel();
      } else if (payload?.type === 'removed' && payload?.data?.id) {
        annotations = annotations.filter(a => a.id !== payload.data.id);
        scheduleReplay();
        if (panelOpen) repaintPanel();
      }
    });
    // resync / snapshot：服务端事件序号不连续时的对账信号，重拉 list。
    for (const type of ['resync', 'snapshot', 'open']) {
      source.addEventListener(type, () => {
        if (stream === source) void loadList();
      });
    }
    source.addEventListener('closed', () => {
      if (stream !== source) return;
      closeStream();
      annotations = [];
      scheduleReplay();
      if (panelOpen) repaintPanel();
    });
    // error：EventSource 自带断线续接（Last-Event-ID），不主动处置。
  }

  // ── 文本模型（创建与重放共用的匹配口径）──────────────────────────
  //
  // 把消息行 .message-content 的渲染文本投影为"空白归一化"字符串：
  // 任意空白序列（跨元素、换行）折叠为单空格，首尾 trim。positions[i] 记录
  // 归一化第 i 个字符的源 (textNode, nodeOffset)，匹配区间可据此拆回源片段。

  function buildTextModel(rootEl) {
    const normalized = [];
    const positions = [];
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    let prevSpace = true; // 行首空白吞掉（左 trim）
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      // 行内代码 / 代码块统一处理：它们也是渲染文本的一部分，标注合法。
      for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        const isSpace = ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 160;
        if (isSpace) {
          if (!prevSpace) { normalized.push(32); positions.push({ node, nodeOffset: i }); prevSpace = true; }
        } else {
          normalized.push(ch); positions.push({ node, nodeOffset: i }); prevSpace = false;
        }
      }
    }
    return { normalized, positions };
  }

  function modelString(model) {
    // 分块拼接避免大数组展开触栈（超长消息保护）
    if (!model._str) {
      let str = '';
      for (let i = 0; i < model.normalized.length; i += 4096) {
        str += String.fromCharCode(...model.normalized.slice(i, i + 4096));
      }
      model._str = str;
    }
    return model._str;
  }

  /** 定位 quote 第 occurrence 次出现的起始位置；找不到返回 -1。 */
  function findOccurrence(text, quote, occurrence) {
    let idx = -1;
    for (let k = 0; k <= occurrence; k++) {
      idx = text.indexOf(quote, idx + 1);
      if (idx === -1) return -1;
    }
    return idx;
  }

  /** 选区区间与 quote 的哪一次出现相交（选区含前导/尾随空白时仍正确定位）。 */
  function occurrenceFor(text, quote, selStart, selEnd) {
    let idx = text.indexOf(quote);
    let count = 0;
    while (idx !== -1) {
      if (idx < selEnd && selStart < idx + quote.length) return count;
      count++;
      idx = text.indexOf(quote, idx + 1);
    }
    return Math.max(0, count - 1);
  }

  /** 选区边界（node, offset）→ 归一化位置。返回该边界后第一个归一化字符的序号。 */
  function offsetInModel(model, node, offset) {
    let fallback = -1;
    for (let i = 0; i < model.positions.length; i++) {
      const p = model.positions[i];
      if (p.node === node) {
        if (p.nodeOffset >= offset) return i;
        fallback = i + 1;
      }
    }
    return fallback;
  }

  // ── 选中捕获 → 创建 ───────────────────────────────────────────────

  function findMessageContent(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body) {
      if (el.classList?.contains('message-content')) return el;
      el = el.parentElement;
    }
    return null;
  }

  /**
   * 选区 → 标注锚位。约束：选区完整落在一条 user/assistant 消息的
   * .message-content（id=msg-<index>，error 分组/乐观回显无此 id，天然排除）。
   */
  function getSelectionContext(sel) {
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const contentEl = findMessageContent(range.commonAncestorContainer);
    if (!contentEl) return null;
    const idMatch = /^msg-(\d+)$/.exec(contentEl.id || '');
    if (!idMatch) return null;
    const index = Number(idMatch[1]);
    const msg = Array.isArray(currentMessages) ? currentMessages[index] : null;
    if (!msg || typeof msg.turn !== 'number') return null;
    if (msg.role !== 'user' && msg.role !== 'assistant') return null;
    if (!contentEl.contains(range.startContainer) || !contentEl.contains(range.endContainer)) return null;
    const model = buildTextModel(contentEl);
    const text = modelString(model);
    const start = offsetInModel(model, range.startContainer, range.startOffset);
    const end = offsetInModel(model, range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) return null;
    const quote = text.slice(start, end).trim();
    if (!quote) return null;
    if (quote.length > QUOTE_MAX_CHARS) {
      toast('warning', t('选段过长', 'Selection too long'),
        t(`标注上限 ${QUOTE_MAX_CHARS} 字符，请缩小选区`, `Annotations cap at ${QUOTE_MAX_CHARS} chars`));
      return null;
    }
    return { index, turn: msg.turn, role: msg.role, quote, occurrence: occurrenceFor(text, quote, start, end) };
  }

  async function createAnnotation(ctx) {
    const result = await channelRequest('create', {
      turn: ctx.turn, role: ctx.role, quote: ctx.quote, occurrence: ctx.occurrence,
    });
    if (result.ok) {
      annotations = [...annotations.filter(a => a.id !== result.annotation.id), result.annotation]
        .sort((a, b) => a.createdAt - b.createdAt);
      scheduleReplay();
      if (panelOpen) repaintPanel();
    } else {
      toast('error', t('标注失败', 'Annotation failed'), String(result.code || result.error || ''));
    }
  }

  async function removeAnnotation(id) {
    const result = await channelRequest('remove', { id });
    if (result.ok) {
      annotations = annotations.filter(a => a.id !== id);
      scheduleReplay();
      if (panelOpen) repaintPanel();
    } else if (result.code !== 'annotation_not_found') {
      toast('error', t('删除失败', 'Remove failed'), String(result.code || result.error || ''));
    }
  }

  // ── 高亮重放 ──────────────────────────────────────────────────────

  function clearRowHighlights(contentEl) {
    contentEl.querySelectorAll('mark.anno-highlight').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
  }

  function applyAnnotationToRow(contentEl, anno) {
    const model = buildTextModel(contentEl);
    const text = modelString(model);
    const start = findOccurrence(text, anno.quote, anno.occurrence);
    if (start === -1) return; // 消息被精简 / 内容变化后锚点失配：面板仍可见 quote
    const end = start + anno.quote.length;
    // 拆回源片段（同节点连续段），从后往前包裹避免前面的切分影响后面
    const segments = [];
    let i = start;
    while (i < end) {
      const node = model.positions[i].node;
      const segStart = model.positions[i].nodeOffset;
      let segEnd = segStart + 1;
      let j = i + 1;
      while (j < end && model.positions[j].node === node && model.positions[j].nodeOffset === segEnd) {
        segEnd++; j++;
      }
      segments.push({ node, start: segStart, end: segEnd });
      i = j;
    }
    for (let k = segments.length - 1; k >= 0; k--) {
      const seg = segments[k];
      if (seg.node.nodeValue === null) continue;
      const rangeObj = document.createRange();
      rangeObj.setStart(seg.node, seg.start);
      rangeObj.setEnd(seg.node, seg.end);
      const mark = document.createElement('mark');
      mark.className = 'anno-highlight';
      mark.dataset.annoId = anno.id;
      mark.title = t('标注（点击删除）', 'Annotation (click to remove)');
      try { rangeObj.surroundContents(mark); } catch { /* 段异常跳过，其余段仍生效 */ }
    }
  }

  let replayQueued = false;
  function scheduleReplay() {
    if (replayQueued) return;
    replayQueued = true;
    requestAnimationFrame(() => {
      replayQueued = false;
      ensureSession();
      replayAll();
    });
  }

  function replayAll() {
    const container = document.getElementById('chat-container');
    if (!container) return;
    // 用户正在消息区内做选择时跳过本轮重放：DOM 重排会打断选区（正要标注）。
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && container.contains(sel.anchorNode)) return;
    const byTurnRole = new Map();
    for (const anno of annotations) {
      const key = `${anno.turn}|${anno.role}`;
      byTurnRole.set(key, [...(byTurnRole.get(key) || []), anno]);
    }
    container.querySelectorAll('.message-content[id^="msg-"]').forEach(contentEl => {
      const idMatch = /^msg-(\d+)$/.exec(contentEl.id || '');
      if (!idMatch) return;
      const msg = Array.isArray(currentMessages) ? currentMessages[Number(idMatch[1])] : null;
      if (!msg || typeof msg.turn !== 'number') return;
      // 无条件清除后重放：删除标注（尤其删除后列表为空 / 该行不再有标注）时，
      // 旧高亮必须被清掉——"只清有标注的行"的优化会让已删标注的高亮残留，
      // 直到下一次创建才被顺带清除（历史 bug）。
      clearRowHighlights(contentEl);
      const rowAnnos = byTurnRole.get(`${msg.turn}|${msg.role}`);
      if (rowAnnos) for (const anno of rowAnnos) applyAnnotationToRow(contentEl, anno);
    });
  }

  // ── 弹窗（浮动工具条 / 删除确认）─────────────────────────────────

  let popoverEl = null;
  let popoverCtx = null;
  let deletePopoverEl = null;

  function ensurePopover() {
    if (popoverEl) return popoverEl;
    popoverEl = document.createElement('div');
    popoverEl.className = 'anno-popover hidden';
    popoverEl.innerHTML =
      `<button type="button" class="anno-popover-btn">${escapeHtml(t('标注', 'Annotate'))}</button>`;
    popoverEl.querySelector('.anno-popover-btn').addEventListener('click', () => {
      const ctx = popoverCtx;
      hidePopover();
      if (ctx) {
        window.getSelection()?.removeAllRanges();
        void createAnnotation(ctx);
      }
    });
    document.body.appendChild(popoverEl);
    return popoverEl;
  }

  function showPopover(ctx, rect) {
    const el = ensurePopover();
    popoverCtx = ctx;
    el.classList.remove('hidden');
    // 先显示再测量（hidden 状态下 offsetWidth 为 0）
    const { offsetWidth: w, offsetHeight: h } = el;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    const top = rect.top - h - 8 > 8 ? rect.top - h - 8 : rect.bottom + 8;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function hidePopover() {
    if (popoverEl) popoverEl.classList.add('hidden');
    popoverCtx = null;
  }

  function showDeletePopover(mark) {
    hideDeletePopover();
    deletePopoverEl = document.createElement('div');
    deletePopoverEl.className = 'anno-popover anno-delete-popover';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'anno-popover-btn anno-delete-btn';
    btn.textContent = t('删除标注', 'Remove annotation');
    btn.addEventListener('click', () => {
      const id = mark.dataset.annoId;
      hideDeletePopover();
      if (id) void removeAnnotation(id);
    });
    deletePopoverEl.appendChild(btn);
    document.body.appendChild(deletePopoverEl);
    const rect = mark.getBoundingClientRect();
    deletePopoverEl.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - deletePopoverEl.offsetWidth / 2, window.innerWidth - deletePopoverEl.offsetWidth - 8))}px`;
    deletePopoverEl.style.top = `${rect.bottom + 8}px`;
    // 点击他处关闭
    setTimeout(() => {
      document.addEventListener('mousedown', function onDown(e) {
        if (deletePopoverEl && !deletePopoverEl.contains(e.target)) {
          hideDeletePopover();
          document.removeEventListener('mousedown', onDown);
        } else if (!deletePopoverEl) {
          document.removeEventListener('mousedown', onDown);
        }
      });
    }, 0);
  }

  function hideDeletePopover() {
    if (deletePopoverEl) { deletePopoverEl.remove(); deletePopoverEl = null; }
  }

  // ── 事件绑定 ──────────────────────────────────────────────────────

  document.addEventListener('mouseup', (event) => {
    if (popoverEl && popoverEl.contains(event.target)) return;
    if (deletePopoverEl && deletePopoverEl.contains(event.target)) return;
    const sel = window.getSelection();
    const ctx = getSelectionContext(sel);
    if (ctx) {
      ensureSession();
      showPopover(ctx, sel.getRangeAt(0).getBoundingClientRect());
    } else {
      hidePopover();
    }
  });

  document.addEventListener('click', (event) => {
    const mark = event.target?.closest?.('mark.anno-highlight');
    if (!mark) return;
    event.preventDefault();
    event.stopPropagation();
    hidePopover();
    showDeletePopover(mark);
  }, true); // capture：先于消息行自身的点击行为（折叠卡片等）

  // ── 面板 API（rail 面板宿主调用）─────────────────────────────────

  function formatTime(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function getPanelHtml() {
    ensureSession();
    if (!addressing) {
      return `<div class="feature-panel-empty"><div>${escapeHtml(t('当前会话不支持标注', 'Annotations unavailable'))}</div></div>`;
    }
    if (!annotations.length) {
      return `<div class="feature-panel-empty"><div>${escapeHtml(t('暂无标注：选中文本即可标注', 'No annotations yet: select text to annotate'))}</div></div>`;
    }
    const items = annotations.map((anno) => {
      const clip = anno.quote.length > 160 ? `${anno.quote.slice(0, 160)}…` : anno.quote;
      return `<div class="anno-panel-item" data-anno-id="${escapeHtml(anno.id)}">`
        + `<div class="anno-panel-quote">${escapeHtml(clip)}</div>`
        + `<div class="anno-panel-meta">${escapeHtml(`T${anno.turn} · ${anno.role} · ${formatTime(anno.createdAt)}`)}</div>`
        + '</div>';
    }).join('');
    return `<div class="anno-panel-list">${items}</div>`;
  }

  /** 面板重绘：rail 宿主容器以 data-panel 标识当前面板，仅当前面板在位时替换。 */
  function repaintPanel() {
    const host = document.getElementById('feature-panel-body');
    if (host?.dataset?.panel === 'annotations') host.innerHTML = getPanelHtml();
  }

  function scrollToAnnotation(id) {
    const anno = annotations.find(a => a.id === id);
    if (!anno) return;
    const container = document.getElementById('chat-container');
    if (!container) return;
    for (const contentEl of container.querySelectorAll('.message-content[id^="msg-"]')) {
      const idMatch = /^msg-(\d+)$/.exec(contentEl.id || '');
      if (!idMatch) continue;
      const msg = Array.isArray(currentMessages) ? currentMessages[Number(idMatch[1])] : null;
      if (!msg || msg.turn !== anno.turn || msg.role !== anno.role) continue;
      const mark = [...contentEl.querySelectorAll('mark.anno-highlight')].find(m => m.dataset.annoId === id);
      const target = mark || contentEl;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (mark) {
        mark.classList.add('anno-flash');
        setTimeout(() => mark.classList.remove('anno-flash'), 1200);
      }
      return;
    }
    toast('info', t('目标消息不在当前视图', 'Target message not in view'),
      t('消息可能被精简，摘录见列表', 'Message may have been trimmed; see quote in list'));
  }

  // 面板列表点击（事件委托，节点由 repaintPanel 动态生成）
  document.addEventListener('click', (event) => {
    const item = event.target?.closest?.('.anno-panel-item');
    if (!item) return;
    const id = item.dataset.annoId;
    if (id) scrollToAnnotation(id);
  });

  window.ClawAnnotations = {
    scheduleReplay,
    getPanelHtml,
    refresh: () => { ensureSession(); void loadList(); },
    onOpen: () => { panelOpen = true; ensureSession(); void loadList(); },
    onClose: () => { panelOpen = false; },
  };
})();
