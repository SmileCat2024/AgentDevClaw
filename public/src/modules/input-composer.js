/**
 * input-composer.js — 常驻 Composer 组件（工单 036）
 *
 * 职责：
 * - 常驻 composer 卡（textarea + 工具栏 + 请求 footer）：首次挂载后常驻 DOM，
 *   persistent ↔ requests 模式翻转只做属性级更新（提交端点 / textarea id /
 *   keydown 绑定 / placeholder / footer 动作），不再整块销毁重建。
 *   焦点、IME 组合态、光标、选中态因此自然保留（行为契约 §7）。
 * - 会话草稿缓存（迁自 voice-input.js，工单 036 改动项 C）：语音模块不再
 *   拥有 composer 草稿状态；_pendingVoiceResults 留在 voice-input.js。
 * - 输入槽位显示模式判定：九级优先级矩阵纯函数（行为契约 §3）。
 *
 * persistent 与 requests 只是同一 composer 的两种提交端点：
 *   - persistent：POST /user-turn（handlePersistentInputKey / onPersistentBtnClick）
 *   - requests：POST /input + requestId（handleInputKey / submitInput）
 * 工具栏（attach / 模型 / 思考 / 语音 / 发送-停止）两模式共用一份 DOM。
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
 *   autoResize, handleInputKey, submitInput (input-helpers.js)
 *   submitInputAction (input-helpers.js)
 *   handlePersistentInputKey, onPersistentBtnClick, _syncPersistentActionButton,
 *   _localQueuedInputPending, _pendingQueuedCount, _queuedTexts,
 *   _lastQueueBubbleSignature (persistent-input.js)
 *   updateInputModelSwitcher, updateThinkingEffortSwitcher (input-model-switcher.js)
 *   _getSessionInputCacheKey (app-main.js)
 *   runWithSuppressedChatViewportObservers (chat-viewport.js)
 *   handleInputPaste (persistent-input.js)
 *   toggleVoiceRecording (voice-input.js)
 *   isChoiceInputRequest, isChoiceInputRejected (choice-input.js)
 *   _rollbackDialogOpen, _partialCompactInFlight, _partialCompactRuntimeId,
 *   _compactTimerInterval (rollback-dialog.js)
 */

// ── 会话草稿缓存（迁自 voice-input.js，composer 本体状态）─────────────────

let _sessionInputCache = {};        // { cacheKey: text } — 每个会话 persistent 输入框内容缓存

// Real-time cache shared by persistent and request text inputs per session.
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

// ── 显示模式判定（行为契约 §3 九级优先级矩阵）─────────────────────────────
//
// "什么状态决定什么模式"是契约，判定代码结构不是。本函数是九级优先级的
// 纯函数实现：输入全部显式化，输出唯一模式，便于用例锁死矩阵。

function resolveInputSurfaceMode(state) {
  if (!state.chatActive) return 'hidden';                                          // 1 非 chat surface
  if (state.readOnlyMode) return 'readonly';                                       // 2 只读
  if (state.rollbackDialogOpen) return 'frozen';                                   // 3 回退对话框接管
  if (state.compactInFlight && state.compactRuntimeMatches) return 'compacting';   // 4 会话内压缩
  if (state.hasChoiceRequest) return 'choice';                                     // 5 choice 请求
  if (state.hasLocalQueuedInput) return 'persistent';                              // 6 本地排队乐观态
  if (state.hasRequests) return 'requests';                                        // 7 非 choice 请求卡
  if (state.hasRuntimeSelected) return 'persistent';                               // 8 选中 runtime
  return 'hidden';                                                                 // 9 都不满足
}

// 组装模式判定所需的当前全局状态（非纯；读输入区各域的全局状态）。
function readInputSurfaceModeState(requests, chatActive) {
  const hasRuntimeSelected = !!currentRuntimeAgentId;
  return {
    chatActive,
    readOnlyMode,
    rollbackDialogOpen: _rollbackDialogOpen,
    compactInFlight: _partialCompactInFlight,
    compactRuntimeMatches: hasRuntimeSelected
      && currentRuntimeAgentId === _partialCompactRuntimeId,
    hasRuntimeSelected,
    hasRequests: Array.isArray(requests)
      && requests.some(req => req && !isChoiceInputRejected(req.requestId)),
    hasChoiceRequest: Array.isArray(requests)
      && requests.some(req => isChoiceInputRequest(req) && !isChoiceInputRejected(req.requestId)),
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

// 常驻 composer 单例。模式翻转 / 会话切换都复用同一元素，只有属性级更新。
let _composerCard = null;
let _composerMode = null;
let _composerRequestId = null;

function buildComposerCard() {
  const card = document.createElement('div');
  card.className = 'user-input-card persistent-input';
  card.dataset.persistentComposer = 'true';

  // 附件预览（persistent 与 requests 共用；保留 legacy id 供销毁恢复查找）
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
  attachBtn.onclick = function() { document.getElementById('image-file-input').click(); };
  attachBtn.title = currentLanguage === 'zh' ? '添加图片' : 'Attach Image';
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
  sendBtn.onclick = function() { onPersistentBtnClick(); };
  sendBtn.innerHTML = _COMPOSER_SEND_SVG + _COMPOSER_STOP_SVG;

  right.appendChild(modelBtn);
  right.appendChild(thinkingBtn);
  right.appendChild(voiceBtn);
  right.appendChild(sendBtn);
  toolbar.appendChild(right);

  const footer = document.createElement('div');
  footer.className = 'user-input-footer';
  footer.style.display = 'none';

  body.appendChild(toolbar);
  card.appendChild(body);
  card.appendChild(footer);
  return card;
}

function ensurePersistentComposerCard(container) {
  // 优先复用模块级单例：回退对话框等场景会把容器 innerHTML 清空，元素
  // detach 但对象存活——重新插入同一节点，DOM 节点身份保持不变。
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
 * 模式翻转的属性级更新（persistent ↔ requests 不重建元素）：
 * 仅切换提交端点（user-turn / input+requestId）、textarea id、keydown 绑定、
 * placeholder、footer 动作按钮与三态图标显隐。
 */
function applyComposerMode(card, mode, lease = null) {
  const ta = card.querySelector('.user-input-textarea');
  const voiceBtn = card.querySelector('.voice-input-btn');
  const sendBtn = card.querySelector('.persistent-action-btn');
  const footer = card.querySelector('.user-input-footer');
  if (!ta || !sendBtn) return;

  const boundRuntimeId = String(currentRuntimeAgentId || '');
  const requestId = mode === 'requests' && lease ? String(lease.requestId || '') : '';
  const textareaId = mode === 'persistent' ? 'input-persistent' : `input-${requestId}`;

  card.dataset.composerMode = mode;
  _composerMode = mode;
  _composerRequestId = requestId;
  // persistent-input 类是压力 chip（syncContextPressureChip）与三态按钮域的
  // 选择器契约：只在 persistent 模式持有，请求卡模式下保持与原请求卡等价。
  card.classList.toggle('persistent-input', mode === 'persistent');

  ta.id = textareaId;
  // 属性赋值（非 HTML 拼接），placeholder 原样写入
  ta.placeholder = mode === 'persistent'
    ? t('input_placeholder')
    : (lease?.placeholder || t('input_placeholder'));
  ta.onkeydown = mode === 'persistent'
    ? handlePersistentInputKey
    : function(event) { handleInputKey(event, requestId, boundRuntimeId); };
  if (voiceBtn) voiceBtn.dataset.target = ta.id;

  if (mode === 'persistent') {
    sendBtn.id = 'persistent-action-btn';
    sendBtn.title = currentLanguage === 'zh' ? '发送' : 'Send';
    sendBtn.onclick = function() { onPersistentBtnClick(); };
    // 三态（send/stop/interrupting）交还 _syncPersistentActionButton 决定
    _syncPersistentActionButton();
  } else {
    // 请求卡的发送按钮只是 send：移除 persistent 三态标识，避免 calling
    // 状态误把请求卡发送按钮切为 stop（现状请求卡按钮无此 id，行为等价）。
    sendBtn.removeAttribute('id');
    sendBtn.classList.remove('is-stop', 'is-interrupting');
    sendBtn.removeAttribute('aria-busy');
    sendBtn.title = 'Send';
    const iconSend = sendBtn.querySelector('.icon-send');
    const iconStop = sendBtn.querySelector('.icon-stop');
    if (iconSend) iconSend.style.display = '';
    if (iconStop) iconStop.style.display = 'none';
    sendBtn.onclick = function() { submitInput(requestId, boundRuntimeId); };
  }

  // footer 动作（requests 模式）：过滤内部回退/压缩动作（动作过滤契约）
  if (mode === 'requests') {
    const visibleActions = Array.isArray(lease?.actions)
      ? lease.actions.filter(action => action && action.id !== 'rollback_to_call' && action.id !== 'compact_from_call')
      : [];
    footer.innerHTML = visibleActions.length > 0
      ? '<div class="user-input-actions">' + visibleActions.map(action =>
          '<button class="user-input-action ' + escapeHtml(action.variant || 'secondary') + '" onclick="submitInputAction(\'' + escapeHtml(lease.requestId) + '\', \'' + escapeHtml(action.id) + '\', {}, \'' + escapeHtml(boundRuntimeId) + '\')">' + escapeHtml(action.label) + '</button>'
        ).join('') + '</div>'
      : '';
    footer.style.display = visibleActions.length > 0 ? '' : 'none';
  } else {
    footer.innerHTML = '';
    footer.style.display = 'none';
  }
}

/**
 * 会话身份重绑（容器级）：旧 key 抢救草稿 → 更新 dataset.sessionKey →
 * 恢复新 key 草稿。同 key 调用是幂等 no-op（模式翻转不触碰草稿）。
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
 * 之前"。composer 单例可能正被回退对话框接管（rollback-dialog.js 的
 * container.innerHTML 清空容器，模块单例仍持有引用但 parentNode 已断），
 * 此时直接 insertBefore(node, ref) 会抛 NotFoundError——引用节点不在容器内
 * 时回落为 null（等同 appendChild）。
 */
function insertTransientInputCard(container, card) {
  const ref = getPersistentComposerCard();
  const refInContainer = ref && ref.parentNode === container ? ref : null;
  container.insertBefore(card, refInContainer);
}

// 清理互斥临时内容（readonly 卡 / 压缩卡 / choice 卡 / 回退对话框卡 / 气泡 / 胶囊）。
// 常驻 composer 是容器内唯一保留的子元素；气泡栈与 meta bar 由各自模块按需重建。
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
