/**
 * session-reference-picker.js — 输入框会话引用（+菜单弹窗 / 侧栏拖拽 / pill 管理）
 *
 * 引用是一次性附件语义（与图片附件同心智模型）：挂在输入框上，随下一条
 * user-turn 以 metadata['session-reference'] 发送，发出即消费。状态只存在于
 * 本模块局部作用域，会话切换清空；发送失败归还（与 ClawSlash 激活通知的
 * consume/restore 模式同构）。
 *
 * window 命名空间导出（window.SessionReference）：
 *   add(entry) / remove(index) / clear()
 *   consume() / restore(refs) / peek()
 *   chipsHtml() — 引用 pill 的 HTML（_renderAttachmentPreview 拼接）
 *   openPicker() — + 菜单「会话」入口打开选择弹窗
 *
 * 依赖全局（运行时解析，加载顺序见 index.html）：
 *   currentLanguage, currentRuntimeAgentId, allAgents (app-core.js)
 *   escapeHtml (markdown-utils.js)
 *   ClawToast (toast-notify.js)
 */

// ── 引用状态（模块局部） ──────────────────────────────────────────

// 引用按会话隔离：会话 A 挂的引用不被会话 B 的发送消费，切回 A 后 pill
// 恢复显示。key 必须在挂载/提交/渲染三个时刻读出同一值：
//   - currentRuntimeAgentId：同步全局，switchAgent / loadAgentData 同步写入；
//   - getRuntimeWorkspaceSessionId(runtimeId)：读 viewer 绑定（switchAgent /
//     open_session 时同步冻结），共享 runtime 下切会话时 sessionId 变化。
// 禁用 dataset.sessionKey 与 getRuntimeContextKey 作 key：前者被轮询渲染的
// syncPersistentComposerSessionCard 周期性重写，后者派生自异步 allAgents，
// 两者都会在三个时刻之间漂移，导致 consume 读空桶（metadata 丢失）而
// chipsHtml 渲染又漂回有引用的桶（pill 残留）。
const _sessionReferences = new Map(); // key → [{ agentId, sessionId, sessionType, title }]
let _lastKnownRefKey = null;

function _activeRefKey() {
  const runtimeId = typeof currentRuntimeAgentId !== 'undefined'
    ? String(currentRuntimeAgentId || '').trim()
    : '';
  const sessionId = runtimeId && typeof getRuntimeWorkspaceSessionId === 'function'
    ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim()
    : '';
  if (runtimeId && sessionId) {
    _lastKnownRefKey = `${runtimeId}::${sessionId}`;
    return _lastKnownRefKey;
  }
  if (runtimeId) {
    // sessionId 尚未冻结（会话加载窗口期）：暂以 runtime 归档，绑定就位后
    // 首次读取自然迁移到组合 key。
    _lastKnownRefKey = runtimeId;
    return runtimeId;
  }
  return _lastKnownRefKey || 'default';
}

function _refs() {
  const key = _activeRefKey();
  let refs = _sessionReferences.get(key);
  if (!Array.isArray(refs)) {
    refs = [];
    _sessionReferences.set(key, refs);
  }
  return refs;
}

function _refKey(ref) {
  return `${ref.agentId}/${ref.sessionId}`;
}

/** 当前活跃会话的 (agentId, sessionId) 判定：同步读取 viewer 绑定，仅用于禁自引用提示。 */
function _currentSessionIdentity() {
  const runtimeId = typeof currentRuntimeAgentId !== 'undefined'
    ? String(currentRuntimeAgentId || '').trim()
    : '';
  if (!runtimeId) return null;
  const sessionId = typeof getRuntimeWorkspaceSessionId === 'function'
    ? String(getRuntimeWorkspaceSessionId(runtimeId) || '').trim()
    : '';
  if (!sessionId) return null;
  const host = typeof getCurrentHostAgentRecord === 'function'
    ? getCurrentHostAgentRecord()
    : null;
  const agentId = String(
    (typeof getLogicalAgentId === 'function' && host && getLogicalAgentId(host))
    || host?.id
    || 'programming-helper',
  ).trim();
  return { agentId, sessionId };
}

function addSessionReference(entry) {
  if (!entry || typeof entry.sessionId !== 'string' || !entry.sessionId.trim()) return false;
  const ref = {
    agentId: String(entry.agentId || '').trim() || 'programming-helper',
    sessionId: entry.sessionId.trim(),
    sessionType: String(entry.sessionType || 'main').trim() || 'main',
    title: String(entry.title || '').trim(),
  };
  const current = _currentSessionIdentity();
  if (current && current.agentId === ref.agentId && current.sessionId === ref.sessionId) {
    if (typeof ClawToast !== 'undefined' && ClawToast?.show) {
      ClawToast.show({
        id: 'session-ref-self',
        status: 'info',
        title: typeof currentLanguage !== 'undefined' && currentLanguage === 'zh'
          ? '当前会话不能引用自身' : 'Cannot reference the current session',
        autoDismiss: 3200,
      });
    }
    return false;
  }
  if (_refs().some(r => _refKey(r) === _refKey(ref))) return true; // 已挂载：幂等
  _refs().push(ref);
  _notifyPreviewChanged();
  return true;
}

function removeSessionReference(index) {
  const refs = _refs();
  if (index < 0 || index >= refs.length) return;
  refs.splice(index, 1);
  _notifyPreviewChanged();
}

function clearSessionReferences() {
  const key = _activeRefKey();
  const refs = _sessionReferences.get(key);
  if (!Array.isArray(refs) || refs.length === 0) return;
  _sessionReferences.set(key, []);
  _notifyPreviewChanged();
}

/** 发送时消费：取走当前会话的全部引用（数组浅拷贝）并清空 pill。 */
function consumeSessionReferences() {
  const refs = _refs().slice();
  _sessionReferences.set(_activeRefKey(), []);
  _notifyPreviewChanged();
  return refs;
}

/** 发送失败归还（consume 取走的引用原样放回），不覆盖期间新挂的引用。 */
function restoreSessionReferences(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return;
  const current = _refs();
  for (const ref of refs) {
    if (ref && typeof ref.sessionId === 'string' && !current.some(r => _refKey(r) === _refKey(ref))) {
      current.push(ref);
    }
  }
  _notifyPreviewChanged();
}

/** 乐观气泡快照（不消费）。 */
function peekSessionReferences() {
  return _refs().slice();
}

/** user-turn body 的 metadata 片段；无引用时返回 null（不产生空字段）。 */
function buildTurnMetadata() {
  const refs = _refs();
  if (refs.length === 0) return null;
  return { 'session-reference': refs.map(r => ({ ...r })) };
}

/** 引用 pill HTML（与图片缩略图同在附件预览区渲染）。 */
function sessionReferenceChipsHtml() {
  const refs = _refs();
  if (refs.length === 0) return '';
  return refs.map((ref, idx) => {
    const label = ref.title || ref.sessionId;
    const meta = `${ref.agentId}/${ref.sessionType}`;
    return '<div class="session-ref-chip" title="' + escapeHtml(meta + ' · ' + ref.sessionId) + '">'
      + '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>'
      + '<span class="session-ref-chip-label">' + escapeHtml(label) + '</span>'
      + '<span class="session-ref-chip-meta">' + escapeHtml(meta) + '</span>'
      + '<button class="session-ref-chip-remove" type="button" onclick="SessionReference.remove(' + idx + ')" title="'
      + escapeHtml(typeof currentLanguage !== 'undefined' && currentLanguage === 'zh' ? '移除' : 'Remove')
      + '">×</button>'
      + '</div>';
  }).join('');
}

function _notifyPreviewChanged() {
  // 引用 key 随会话切换（input-composer 的 syncPersistentComposerSessionCard
  // 更新 dataset.sessionKey）后，附件预览必须按新 key 重渲染，否则旧会话的
  // pill 残留显示（DOM 不刷新）。_renderAttachmentPreview 定义于
  // persistent-input.js，加载顺序在本模块之后，运行时解析。
  if (typeof _renderAttachmentPreview === 'function') _renderAttachmentPreview();
}

// ── 会话选择弹窗 ──────────────────────────────────────────────────

let _pickerEl = null;

function closeSessionReferencePicker() {
  if (_pickerEl) {
    _pickerEl.remove();
    _pickerEl = null;
  }
}

function openSessionReferencePicker() {
  if (_pickerEl) { _pickerEl.remove(); _pickerEl = null; }
  const zh = typeof currentLanguage !== 'undefined' && currentLanguage === 'zh';

  const overlay = document.createElement('div');
  overlay.className = 'session-ref-picker-overlay';
  overlay.innerHTML = ''
    + '<div class="session-ref-picker" role="dialog" aria-modal="true">'
    + '<div class="session-ref-picker-header">'
    + '<div class="session-ref-picker-title">' + (zh ? '引用会话' : 'Reference Sessions') + '</div>'
    + '<button class="session-ref-picker-close" type="button" title="' + (zh ? '关闭' : 'Close') + '">×</button>'
    + '</div>'
    + '<input class="session-ref-picker-search" type="text" placeholder="'
    + (zh ? '搜索标题 / 摘要 / 会话 ID…' : 'Search title / summary / session ID…') + '">'
    + '<div class="session-ref-picker-list"><div class="session-ref-picker-empty">'
    + (zh ? '加载中…' : 'Loading…') + '</div></div>'
    + '<div class="session-ref-picker-footer">'
    + '<button class="session-ref-picker-cancel" type="button">' + (zh ? '取消' : 'Cancel') + '</button>'
    + '<button class="session-ref-picker-confirm" type="button" disabled>' + (zh ? '引用' : 'Reference') + '</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(overlay);
  _pickerEl = overlay;

  const listEl = overlay.querySelector('.session-ref-picker-list');
  const searchEl = overlay.querySelector('.session-ref-picker-search');
  const confirmBtn = overlay.querySelector('.session-ref-picker-confirm');
  const current = _currentSessionIdentity();

  overlay.querySelector('.session-ref-picker-close').onclick = closeSessionReferencePicker;
  overlay.querySelector('.session-ref-picker-cancel').onclick = closeSessionReferencePicker;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeSessionReferencePicker(); });

  let sessions = [];
  let selected = new Set(); // 目录条目的 agentId/sessionId 复合键

  const renderList = () => {
    const query = searchEl.value.trim().toLowerCase();
    const filtered = query
      ? sessions.filter(s => {
          const hay = `${s.title || ''} ${s.preview || ''} ${s.sessionId || ''} ${s.agentId || ''}`.toLowerCase();
          return hay.includes(query);
        })
      : sessions;
    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="session-ref-picker-empty">'
        + (query ? (zh ? '无匹配会话' : 'No matching sessions') : (zh ? '暂无可引用的会话' : 'No sessions to reference'))
        + '</div>';
      return;
    }
    const html = filtered.map(s => {
      const key = `${s.agentId}/${s.sessionId}`;
      const isCurrent = current && current.agentId === s.agentId && current.sessionId === s.sessionId;
      const checked = selected.has(key) ? ' checked' : '';
      const disabled = isCurrent ? ' disabled' : '';
      const currentNote = isCurrent ? '<span class="session-ref-item-current">' + (zh ? ' · 当前会话' : ' · current') + '</span>' : '';
      return '<label class="session-ref-item' + (isCurrent ? ' is-current' : '') + '" data-key="' + escapeHtml(key) + '">'
        + '<input type="checkbox" data-key="' + escapeHtml(key) + '"' + checked + disabled + '>'
        + '<div class="session-ref-item-body">'
        + '<div class="session-ref-item-title">' + escapeHtml(s.title || s.sessionId) + currentNote + '</div>'
        + '<div class="session-ref-item-meta">' + escapeHtml(`${s.agentId}/${s.sessionType || 'main'} · ${s.messageCount || 0}${zh ? '条' : ' msgs'} · ${s.updatedAt || ''}`) + '</div>'
        + (s.openDirectory ? '<div class="session-ref-item-dir">' + escapeHtml(s.openDirectory) + '</div>' : '')
        + (s.preview ? '<div class="session-ref-item-preview">' + escapeHtml(s.preview) + '</div>' : '')
        + '</div>'
        + '</label>';
    }).join('');
    listEl.innerHTML = html;
  };

  const syncConfirm = () => {
    confirmBtn.disabled = selected.size === 0;
    confirmBtn.textContent = zh ? `引用 (${selected.size})` : `Reference (${selected.size})`;
  };

  listEl.addEventListener('change', (e) => {
    const input = e.target.closest('input[type="checkbox"][data-key]');
    if (!input) return;
    if (input.checked) selected.add(input.dataset.key);
    else selected.delete(input.dataset.key);
    syncConfirm();
  });
  searchEl.addEventListener('input', renderList);
  searchEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSessionReferencePicker(); });

  confirmBtn.onclick = () => {
    let added = 0;
    for (const key of selected) {
      const [agentId, sessionId] = key.split('/');
      const entry = sessions.find(s => s.agentId === agentId && s.sessionId === sessionId);
      if (entry && addSessionReference(entry)) added += 1;
    }
    closeSessionReferencePicker();
    if (added > 0 && typeof ClawToast !== 'undefined' && ClawToast?.show) {
      ClawToast.show({
        id: 'session-ref-added',
        status: 'success',
        title: zh ? `已挂载 ${added} 个会话引用` : `Referenced ${added} session(s)`,
        autoDismiss: 2600,
      });
    }
  };

  // 数据源与 session_list 工具同源（跨 agent 聚合，更新时间倒序）
  fetch('/protoclaw/session_directory?limit=50')
    .then(res => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
    .then(data => {
      sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      renderList();
    })
    .catch(() => {
      listEl.innerHTML = '<div class="session-ref-picker-empty">'
        + (zh ? '会话目录加载失败，请稍后重试' : 'Failed to load the session directory') + '</div>';
    });
}

// ── Composer 拖拽投放（侧栏 dragstart 写入引用 MIME） ────────────

const SESSION_REF_MIME = 'application/x-claw-session-ref';

function _composerCardFromEvent(event) {
  const target = event.target;
  if (!(target instanceof Node)) return null;
  return target.closest && target.closest('.user-input-card');
}

function bindSessionReferenceDrop() {
  document.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes(SESSION_REF_MIME)) return;
    const card = _composerCardFromEvent(event);
    if (!card) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    card.classList.add('session-ref-drop-target');
  });
  document.addEventListener('dragleave', (event) => {
    const card = _composerCardFromEvent(event);
    if (card) card.classList.remove('session-ref-drop-target');
  });
  document.addEventListener('drop', (event) => {
    const card = _composerCardFromEvent(event);
    document.querySelectorAll('.session-ref-drop-target').forEach(el => el.classList.remove('session-ref-drop-target'));
    if (!card || !event.dataTransfer) return;
    const raw = event.dataTransfer.getData(SESSION_REF_MIME);
    if (!raw) return;
    event.preventDefault();
    let entry;
    try { entry = JSON.parse(raw); } catch { return; }
    if (addSessionReference(entry)) {
      const textarea = card.querySelector('.user-input-textarea');
      if (textarea) textarea.focus();
    }
  });
}

bindSessionReferenceDrop();

// ── window 命名空间导出 ───────────────────────────────────────────

window.SessionReference = {
  add: addSessionReference,
  remove: removeSessionReference,
  clear: clearSessionReferences,
  consume: consumeSessionReferences,
  restore: restoreSessionReferences,
  peek: peekSessionReferences,
  buildTurnMetadata,
  chipsHtml: sessionReferenceChipsHtml,
  openPicker: openSessionReferencePicker,
  // 会话切换（sessionKey 变更）后按新 key 重渲染附件预览
  notify: _notifyPreviewChanged,
  MIME: SESSION_REF_MIME,
};
