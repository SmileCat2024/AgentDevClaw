/**
 * input-composer.js — 常驻 Composer 组件（工单 036）
 *
 * 职责：
 * - 常驻 composer 卡（textarea + 工具栏）：首次挂载后常驻 DOM，普通文本 lease
 *   不改变 composer 形态或提交端点；Ask User 卡片处于独立渲染面。
 *   焦点、IME 组合态、光标、选中态因此自然保留（行为契约 §7）。
 * - 会话草稿缓存（迁自 voice-input.js，工单 036 改动项 C）：语音模块不再
 *   拥有 composer 草稿状态；_pendingVoiceResults 留在 voice-input.js。
 * - 输入槽位显示模式判定：优先级矩阵纯函数（行为契约 §3）。
 *
 * 普通发言 composer 恒走 POST /user-turn（handlePersistentInputKey / onPersistentBtnClick）；
 * lease 应答由 choice 卡与 submitInputAction 等专用交互承载。
 * 工具栏（attach / 模型 / 思考 / 语音 / 发送-停止）属于常驻 composer。
 *
 * 导出全局函数：
 *   resolveInputSurfaceMode, readInputSurfaceModeState,
 *   ensurePersistentComposerCard, applyComposerMode, syncPersistentComposerSession,
 *   hidePersistentComposerCard, showPersistentComposerCard,
 *   detachTransientInputContent
 * 导出全局变量：
 *   _sessionInputCache
 * 导出全局函数（草稿缓存，原 voice-input.js 符号，引用方零改动）：
 *   _cacheSessionInput, _restoreSessionInputDraft, _storeSessionInputDraft,
 *   _storeVisibleSessionInputDraft
 *
 * 依赖全局（运行时解析，加载顺序见 index.html）：
 *   t, currentLanguage (i18n.js / app-core.js)
 *   currentRuntimeAgentId, readOnlyMode (app-core.js)
 *   autoResize (input-helpers.js)
 *   submitInputAction (input-helpers.js)
 *   handlePersistentInputKey, onPersistentBtnClick, _syncPersistentActionButton,
 *   _localQueuedInputPending, _pendingQueuedCount, _queuedTexts,
 *   _lastQueueBubbleSignature (persistent-input.js)
 *   updateInputModelSwitcher, updateThinkingEffortSwitcher (input-model-switcher.js)
 *   _getSessionInputCacheKey (app-main.js)
 *   runWithSuppressedChatViewportObservers (chat-viewport.js)
 *   handleInputPaste (persistent-input.js)
 *   toggleVoiceRecording (voice-input.js)
 *   isChoiceInputRequest, isChoiceInputConsumed (choice-input.js)
 *   _rollbackDialogOpen, _partialCompactInFlight, _partialCompactRuntimeId,
 *   _compactTimerInterval (rollback-dialog.js)
 */

// ── 会话草稿缓存（迁自 voice-input.js，composer 本体状态）─────────────────

let _sessionInputCache = {};        // { cacheKey: text } — 每个会话 persistent 输入框内容缓存

// Real-time cache for the persistent composer draft per session.
function _cacheSessionInput(textarea) {
  const key = textarea?.dataset?.sessionKey || _getSessionInputCacheKey();
  if (!key) return;
  _sessionInputCache[key] = textarea.value || '';
}

function _restoreSessionInputDraft(textarea, key = textarea?.dataset?.sessionKey || _getSessionInputCacheKey()) {
  if (!textarea || !key) return false;
  if (!Object.prototype.hasOwnProperty.call(_sessionInputCache, key)) return false;
  const cached = _sessionInputCache[key];
  if (typeof cached !== 'string') return false;
  textarea.value = cached;
  autoResize(textarea);
  return true;
}

function _storeSessionInputDraft(textarea) {
  if (!textarea) return;
  const key = textarea.dataset?.sessionKey || _getSessionInputCacheKey();
  if (!key) return;
  _sessionInputCache[key] = textarea.value || '';
}

function _storeVisibleSessionInputDraft(root = document) {
  const textareas = root.querySelectorAll
    ? Array.from(root.querySelectorAll('.user-input-textarea:not([disabled])'))
    : [];
  if (textareas.length === 0) return;
  const focused = textareas.find((textarea) => textarea === document.activeElement);
  const populated = textareas.find((textarea) => textarea.value);
  _storeSessionInputDraft(focused || populated || textareas[0]);
}

// ── 附件菜单（图片 / 会话引用） ─────────────────────────────────

let _attachMenuEl = null;

function closeAttachMenu() {
  if (_attachMenuEl) {
    _attachMenuEl.remove();
    _attachMenuEl = null;
  }
  document.removeEventListener('mousedown', _attachMenuOutsideHandler);
}

function toggleAttachMenu(event) {
  event.stopPropagation();
  if (_attachMenuEl) {
    closeAttachMenu();
    return;
  }
  const zh = currentLanguage === 'zh';
  const menu = document.createElement('div');
  menu.className = 'attach-menu-popover';
  menu.innerHTML = ''
    + '<button class="attach-menu-item" type="button" data-attach-action="image">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'
    + '<span>' + (zh ? '图片' : 'Image') + '</span>'
    + '</button>'
    + '<button class="attach-menu-item" type="button" data-attach-action="session">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>'
    + '<span>' + (zh ? '会话' : 'Session') + '</span>'
    + '</button>';
  const btn = document.getElementById('attach-image-btn');
  // 锚在 + 号的直接父级（toolbar 左区，CSS position:relative 定位上下文）；
  // .user-input-card 与更外层容器都不是 positioned 元素，锚错层级会让
  // absolute 定位的 popover 贴到整个输入容器边缘
  const anchor = btn?.closest('.persistent-input-toolbar-left') || document.body;
  anchor.appendChild(menu);
  _attachMenuEl = menu;

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-attach-action]');
    if (!item) return;
    const action = item.dataset.attachAction;
    closeAttachMenu();
    if (action === 'image') {
      document.getElementById('image-file-input')?.click();
    } else if (action === 'session') {
      window.SessionReference?.openPicker?.();
    }
  });
  // 点击菜单外任意处关闭（下一 tick 起生效，避免吞掉本次打开点击）
  setTimeout(() => {
    document.addEventListener('mousedown', _attachMenuOutsideHandler);
  }, 0);
}

function _attachMenuOutsideHandler(event) {
  if (!_attachMenuEl) {
    document.removeEventListener('mousedown', _attachMenuOutsideHandler);
    return;
  }
  if (event.target instanceof Node && _attachMenuEl.contains(event.target)) return;
  // + 按钮自身的点击交给 toggleAttachMenu（关闭语义），不在此处理
  if (event.target instanceof Node && event.target.closest && event.target.closest('#attach-image-btn')) return;
  closeAttachMenu();
  document.removeEventListener('mousedown', _attachMenuOutsideHandler);
}

// ── 显示模式判定（行为契约 §3 九级优先级矩阵）─────────────────────────────
//
// "什么状态决定什么模式"是契约，判定代码结构不是。本函数按优先级给出
// 唯一显示模式；普通文本 lease 不参与模式选择。

function resolveInputSurfaceMode(state) {
  if (!state.chatActive) return 'hidden';                                          // 1 非 chat surface
  if (state.readOnlyMode) return 'readonly';                                       // 2 只读
  if (state.rollbackDialogOpen) return 'frozen';                                   // 3 回退对话框接管
  if (state.compactInFlight && state.compactRuntimeMatches) return 'compacting';   // 4 会话内压缩
  if (state.hasChoiceRequest) return 'choice';                                     // 5 choice 请求
  if (state.hasLocalQueuedInput) return 'persistent';                              // 6 本地排队乐观态
  // 级 7 requests 已退役（ADR-0035）：文本 lease 不再翻转 composer，
  // 空闲发言恒走 user-turn 由 viewer 转 lease 回填；lease 快照仅供
  // rollback 按钮可见性与伴生反馈（动作失败 toast / 草稿回填）消费。
  if (state.hasRuntimeSelected || state.hasThreadAwaitTarget) return 'persistent'; // 8 选中 runtime / 接续等待会话
  return 'hidden';                                                                 // 9 都不满足
}

// 组装模式判定所需的当前全局状态（非纯；读输入区各域的全局状态）。
function readInputSurfaceModeState(requests, chatActive) {
  const hasRuntimeSelected = !!currentRuntimeAgentId;
  // 接续等待表面（线程接续挡板 / 退役窗口，runtime 态为空）：输入经
  // getActiveThreadInputTarget 的一致性校验走 Thread Inbox 暂存，新 head
  // 上线后投递——composer 必须在场（挂起≠消失），与 runtime 态同级放行。
  const hasThreadAwaitTarget = !hasRuntimeSelected
    && typeof window.getActiveThreadInputTarget === 'function'
    && !!window.getActiveThreadInputTarget()?.threadId;
  return {
    chatActive,
    readOnlyMode,
    rollbackDialogOpen: _rollbackDialogOpen,
    compactInFlight: _partialCompactInFlight,
    compactRuntimeMatches: hasRuntimeSelected
      && currentRuntimeAgentId === _partialCompactRuntimeId,
    hasRuntimeSelected,
    hasThreadAwaitTarget,
    hasChoiceRequest: Array.isArray(requests)
      && requests.some(req => isChoiceInputRequest(req) && !isChoiceInputConsumed(req.requestId)),
    hasLocalQueuedInput: hasRuntimeSelected
      && (_localQueuedInputPending || _pendingQueuedCount > 0 || _queuedTexts.length > 0),
  };
}

// ── 常驻 Composer 组件 ─────────────────────────────────────────────────────

const _COMPOSER_ATTACH_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
const _COMPOSER_MODEL_CHEVRON_SVG = '<svg class="input-model-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _COMPOSER_THINKING_ICON_SVG = '<svg class="input-thinking-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 3 3 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"></path></svg>';
const _COMPOSER_THINKING_CHEVRON_SVG = '<svg class="input-thinking-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _COMPOSER_MIC_SVG = '<svg class="icon-mic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>';
const _COMPOSER_SEND_SVG = '<svg class="icon-send" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
const _COMPOSER_STOP_SVG = '<svg class="icon-stop" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>';

// 常驻 composer 单例。会话切换复用同一元素，按需更新会话绑定。
let _composerCard = null;

function buildComposerCard() {
  const card = document.createElement('div');
  card.className = 'user-input-card persistent-input';
  card.dataset.persistentComposer = 'true';

  // 附件预览
  const preview = document.createElement('div');
  preview.className = 'persistent-attachment-preview';
  preview.id = 'attachment-preview';
  preview.setAttribute('data-attachment-preview', '');
  preview.style.display = 'none';
  card.appendChild(preview);

  const body = document.createElement('div');
  body.className = 'persistent-input-body';

  const taArea = document.createElement('div');
  taArea.className = 'persistent-input-textarea-area';
  const ta = document.createElement('textarea');
  ta.className = 'user-input-textarea';
  ta.rows = 1;
  ta.id = 'input-persistent';
  ta.oninput = function() { autoResize(this); _cacheSessionInput(this); };
  ta.onpaste = handleInputPaste;
  taArea.appendChild(ta);
  body.appendChild(taArea);

  const toolbar = document.createElement('div');
  toolbar.className = 'persistent-input-toolbar';

  const left = document.createElement('div');
  left.className = 'persistent-input-toolbar-left';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'image-file-input';
  fileInput.accept = 'image/*';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  fileInput.onchange = function() { onImageFilesSelected(this); };
  const attachBtn = document.createElement('button');
  attachBtn.className = 'persistent-icon-btn';
  attachBtn.id = 'attach-image-btn';
  attachBtn.type = 'button';
  // + 号是附件菜单入口（图片 / 会话引用）：点击弹出 popover，不再直连文件选择
  attachBtn.onclick = function(event) { toggleAttachMenu(event); };
  attachBtn.title = currentLanguage === 'zh' ? '添加附件' : 'Attach';
  attachBtn.innerHTML = _COMPOSER_ATTACH_SVG;
  left.appendChild(fileInput);
  left.appendChild(attachBtn);
  toolbar.appendChild(left);

  const right = document.createElement('div');
  right.className = 'persistent-input-toolbar-right';

  const modelBtn = document.createElement('button');
  modelBtn.className = 'input-model-switch-btn';
  modelBtn.id = 'input-model-switch-btn';
  modelBtn.onclick = function(event) { toggleInputModelDropdown(event); };
  modelBtn.innerHTML = '<span class="input-model-name">' + (currentLanguage === 'zh' ? '模型' : 'Model') + '</span>'
    + _COMPOSER_MODEL_CHEVRON_SVG;

  const thinkingBtn = document.createElement('button');
  thinkingBtn.className = 'input-thinking-btn';
  thinkingBtn.id = 'input-thinking-btn';
  thinkingBtn.onclick = function(event) { toggleThinkingEffortDropdown(event); };
  thinkingBtn.innerHTML = _COMPOSER_THINKING_ICON_SVG
    + '<span class="input-thinking-name">' + (currentLanguage === 'zh' ? '思考强度' : 'Thinking') + '</span>'
    + _COMPOSER_THINKING_CHEVRON_SVG;

  const voiceBtn = document.createElement('button');
  voiceBtn.className = 'voice-input-btn';
  voiceBtn.dataset.target = 'input-persistent';
  voiceBtn.onclick = function() { toggleVoiceRecording(this); };
  voiceBtn.title = currentLanguage === 'zh' ? '语音输入' : 'Voice Input';
  voiceBtn.innerHTML = _COMPOSER_MIC_SVG;

  const sendBtn = document.createElement('button');
  sendBtn.className = 'persistent-action-btn';
  sendBtn.id = 'persistent-action-btn';
  sendBtn.onclick = function() {
    const textarea = document.getElementById('input-persistent');
    if (window.ClawSlash?.submitWithPendingPrompts && textarea) {
      void window.ClawSlash.submitWithPendingPrompts(textarea, onPersistentBtnClick);
    } else {
      onPersistentBtnClick();
    }
  };
  sendBtn.innerHTML = _COMPOSER_SEND_SVG + _COMPOSER_STOP_SVG;

  right.appendChild(modelBtn);
  right.appendChild(thinkingBtn);
  right.appendChild(voiceBtn);
  right.appendChild(sendBtn);
  toolbar.appendChild(right);

  body.appendChild(toolbar);
  card.appendChild(body);
  return card;
}

function ensurePersistentComposerCard(container) {
  // 优先复用模块级单例：元素被外部 detach（容器遭清空的异常路径）后对象
  // 仍存活——重新插入同一节点，DOM 节点身份保持不变。交互弹窗（选择卡/
  // 回退对话框）已解耦到独立渲染面，正常路径不会再销毁 composer。
  if (!container.querySelector('[data-persistent-composer]')) {
    if (!_composerCard) _composerCard = buildComposerCard();
    runWithSuppressedChatViewportObservers(() => {
      container.appendChild(_composerCard);
    });
    const ta = _composerCard.querySelector('.user-input-textarea');
    if (ta && !ta.dataset.sessionKey) {
      // 挂载时初始化会话身份（首次挂载或从对话框 detach 恢复）
      ta.dataset.sessionKey = _getSessionInputCacheKey() || '';
      _restoreSessionInputDraft(ta, ta.dataset.sessionKey);
    }
  }
  return container.querySelector('[data-persistent-composer]') || _composerCard;
}

/**
 * 为常驻 composer 绑定普通发言提交行为。
 */
function applyComposerMode(card) {
  const ta = card.querySelector('.user-input-textarea');
  const sendBtn = card.querySelector('.persistent-action-btn');
  if (!ta || !sendBtn) return;

  ta.id = 'input-persistent';
  ta.placeholder = t('input_placeholder');
  ta.onkeydown = handlePersistentInputKey;
  card.dataset.composerMode = 'persistent';
  card.classList.add('persistent-input');

  sendBtn.id = 'persistent-action-btn';
  sendBtn.title = currentLanguage === 'zh' ? '发送' : 'Send';
  sendBtn.onclick = function() {
    const textarea = document.getElementById('input-persistent');
    if (window.ClawSlash?.submitWithPendingPrompts && textarea) {
      void window.ClawSlash.submitWithPendingPrompts(textarea, onPersistentBtnClick);
    } else {
      onPersistentBtnClick();
    }
  };
  _syncPersistentActionButton();
}

/**
 * 会话身份重绑（容器级）：旧 key 抢救草稿 → 更新 dataset.sessionKey →
 * 恢复新 key 草稿。同 key 调用是幂等 no-op（同会话重渲染不触碰草稿）。
 * 返回是否发生了会话切换。
 */
function syncPersistentComposerSessionCard(container) {
  const card = container.querySelector('[data-persistent-composer]');
  const ta = card ? card.querySelector('.user-input-textarea') : null;
  if (!ta) return false;
  const oldKey = ta.dataset.sessionKey || '';
  const newKey = _getSessionInputCacheKey() || '';
  if (oldKey === newKey) return false;
  if (oldKey) _sessionInputCache[oldKey] = ta.value || '';
  ta.dataset.sessionKey = newKey || '';
  // 附件类会话态（会话引用 pill、图片缩略图、slash prompt pill）按会话 key
  // 隔离存储：切换后按新 key 重渲染附件预览与 pill bar，上一会话的附件不
  // 残留显示，切回时自然恢复。
  window.SessionReference?.notify?.();
  window.ClawSlash?.rebindSession?.();
  if (!_restoreSessionInputDraft(ta, newKey)) {
    ta.value = '';
    autoResize(ta);
  }
  return true;
}

function hidePersistentComposerCard() {
  if (_composerCard) _composerCard.style.display = 'none';
}

function showPersistentComposerCard(container) {
  const card = ensurePersistentComposerCard(container);
  _composerCard = card;
  card.style.display = '';
  return card;
}

function getPersistentComposerCard() {
  return _composerCard;
}

/**
 * 向容器安全插入互斥卡（readonly / 压缩状态卡），语义为"插在常驻 composer
 * 之前"。引用节点不在容器内时 insertBefore 会抛 NotFoundError——composer
 * 单例引用存在但 parentNode 已断（容器遭外部清空的异常路径）时回落为
 * null（等同 appendChild）。
 */
function insertTransientInputCard(container, card) {
  const ref = getPersistentComposerCard();
  const refInContainer = ref && ref.parentNode === container ? ref : null;
  container.insertBefore(card, refInContainer);
}

// 清理互斥临时内容（readonly 卡 / 压缩卡 / 气泡 / 胶囊）。交互弹窗（选择
// 卡 / 回退对话框卡）在独立渲染面，不经此函数。常驻 composer 是容器内唯一
// 保留的子元素；气泡栈与 meta bar 由各自模块按需重建。
function detachTransientInputContent(container) {
  if (typeof _compactTimerInterval !== 'undefined' && _compactTimerInterval) {
    clearInterval(_compactTimerInterval);
    _compactTimerInterval = null;
  }
  for (const child of Array.from(container.children)) {
    if (child.dataset && child.dataset.persistentComposer) continue;
    child.remove();
  }
  // 气泡栈 DOM 被清理后重置签名缓存，回 persistent 时由 _renderQueueBubbles 重插
  _lastQueueBubbleSignature = '';
}
