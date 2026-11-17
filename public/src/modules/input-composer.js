/**
 * input-composer.js — 常驻 Composer 组件（工单 036）
 * （classic → ESM，P4 T2 输入面批次）
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
 * 命名导出（跨文件消费方一律 import；桥键见文件末尾）：
 *   resolveInputSurfaceMode, readInputSurfaceModeState,
 *   _cacheSessionInput, _restoreSessionInputDraft, _storeSessionInputDraft,
 *   _storeVisibleSessionInputDraft,
 *   ensurePersistentComposerCard, applyComposerMode, syncPersistentComposerSessionCard,
 *   hidePersistentComposerCard, showPersistentComposerCard, getPersistentComposerCard,
 *   insertTransientInputCard, detachTransientInputContent
 *
 * 模块私有（零跨文件生产消费方）：_attachMenuEl / _composerCard / closeAttachMenu /
 * toggleAttachMenu / _attachMenuOutsideHandler / buildComposerCard / SVG 常量。
 * `_restoreSessionInputDraft` / `_storeSessionInputDraft` 生产消费方仅本文件（后者
 * 还服务 _storeVisibleSessionInputDraft），导出供真实 import 测试。
 *
 * 状态归属：
 *   - `_sessionInputCache`（域 input-composer）owner 是 p2-w2-3a-composer-state.js，
 *     本文件 import 其活绑定直读写；注册行留在本文件（见下）。
 *   - 排队投影 / 回退压缩 / 语音 / 选择卡 / 只读 / 编排态全部 import owner 的活绑定
 *     与 setter，不再经 window 访问器。
 *
 * 桥键（domain `input-composer-api`）：对外函数键。**不能复用 `input-composer`
 * 域**——该域已由 p2-w2-3a-composer-state.js claim，其 impl 只转发
 * `_sessionInputCache`，认领后补注册的函数键取到 undefined（先例：voice-input-api）。
 *   逐键消费方与注销条件见文件末尾注册块。
 *
 * 时相（R1/R2/R4 审计结论）：
 *   - classic 相零触达：状态键与函数键的注册行、全部状态声明都在函数体外求值，
 *     但消费方（app-main 的 getInputSurfaceMode / input-render 的
 *     renderInputRequests / 本模块自身的渲染路径）全部在函数体内调用；P4 时序
 *     切换后首屏链由 `boot.js`（index.html 最后一条 module 标签）在模块相触发，
 *     晚于本模块求值，因此模块相注册与 classic 相注册等价。
 *   - 顶层语句只有：状态声明（null 初值）、桥键注册、函数声明、SVG 常量字符串。
 *     无 DOM 查询、无事件注册、无 localStorage 读写（草稿缓存是纯内存对象，
 *     持久化只发生在 sessionStorage 的压缩计时域，不在本文件）。
 *   - sloppy → strict：原文件无 `'use strict'`，逐条核对无隐式全局赋值（所有跨
 *     文件写点都是 defineKey 桥键或本模块声明）、无 `with`、无顶层 `this`。
 *
 * 与 persistent-input.js 的静态循环：两侧只在函数体互相调用（function 声明在
 * 模块实例化阶段即初始化），求值期零解引用；装载顺序（p4-entry）不影响语义。
 *
 * 外来键的三选一结论（配方步 3）：
 *   - import：已迁态 owner 与轻量宿主域——i18n `t`、getCurrentLanguage、
 *     currentRuntimeAgentId / readOnlyMode、sessionInputCache、排队投影四键 +
 *     setLastQueueBubbleSignature、回退压缩四键 + setCompactTimerInterval、
 *     `autoResize`；本批兄弟 persistent-input（function 声明，静态循环安全）。
 *   - `window.` 晚绑定：目标模块自身仍以桥键服务其他消费方，走 window 与迁移前
 *     裸标识符解析到同一访问器，语义零变化（行尾注释标定义域与收敛条件）：
 *     `_getSessionInputCacheKey`（app-main，classic）、`isChoiceInputRequest` /
 *     `isChoiceInputConsumed`（choice-input 桥）、`toggleInputModelDropdown` /
 *     `toggleThinkingEffortDropdown`（input-model-switcher 桥）、
 *     `toggleVoiceRecording`（voice-input-api 桥）、
 *     `runWithSuppressedChatViewportObservers`（chat-viewport 桥）。
 *     `window.SessionReference` / `window.ClawSlash` 是既有公开命名空间协议。
 *   - 无触线项：本文件不引用任何仍 classic 的顶层 let/const/class 词法绑定。
 */

// ── 会话草稿缓存（迁自 voice-input.js，composer 本体状态）─────────────────

import { t } from '../i18n.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { currentRuntimeAgentId } from './orchestration-state.js';
import { readOnlyMode } from './agent-store-state.js';
import { sessionInputCache } from './p2-w2-3a-composer-state.js';
import {
  localQueuedInputPending,
  pendingQueuedCount,
  queuedTexts,
  setLastQueueBubbleSignature,
} from './p2-w2-3a-input-queue-state.js';
import {
  rollbackDialogOpen,
  partialCompactInFlight,
  partialCompactRuntimeId,
  compactTimerInterval,
  setCompactTimerInterval,
} from './p2-w2-3b-rollback-domain.js';
import { autoResize } from './input-actions.js';
import {
  handlePersistentInputKey,
  onPersistentBtnClick,
  handleInputPaste,
  onImageFilesSelected,
  _syncPersistentActionButton,
} from './persistent-input.js';

// ESM 迁移（P4 输入面批次）：`_sessionInputCache` 的 owner 仍是
// p2-w2-3a-composer-state.js（上面的 import 使它先求值并 claim，故本注册走
// 「认领后补注册」路径，初值直接落进 owner 状态；无双存储）。注册行保留在本
// 文件原声明位置，服务尚未迁移的 classic 消费方（input-render 的 lease 草稿
// 回填、voice-input 的 ASR 回写、app-chat-input / slash-menu 的草稿保存）。
// 注销条件：上述消费方全部改为 import 本模块 / owner 之后（注册行在本批清单内，
// 届时可直接删）。
window.KernelState.defineKey('input-composer', '_sessionInputCache', {}); // { cacheKey: text } — 每个会话 persistent 输入框内容缓存

// Real-time cache for the persistent composer draft per session.
export function _cacheSessionInput(textarea) {
  const key = textarea?.dataset?.sessionKey || window._getSessionInputCacheKey();
  if (!key) return;
  sessionInputCache[key] = textarea.value || '';
}

export function _restoreSessionInputDraft(textarea, key = textarea?.dataset?.sessionKey || window._getSessionInputCacheKey()) {
  if (!textarea || !key) return false;
  if (!Object.prototype.hasOwnProperty.call(sessionInputCache, key)) return false;
  const cached = sessionInputCache[key];
  if (typeof cached !== 'string') return false;
  textarea.value = cached;
  autoResize(textarea);
  return true;
}

export function _storeSessionInputDraft(textarea) {
  if (!textarea) return;
  const key = textarea.dataset?.sessionKey || window._getSessionInputCacheKey();
  if (!key) return;
  sessionInputCache[key] = textarea.value || '';
}

export function _storeVisibleSessionInputDraft(root = document) {
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
  const zh = getCurrentLanguage() === 'zh';
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

export function resolveInputSurfaceMode(state) {
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
export function readInputSurfaceModeState(requests, chatActive) {
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
    rollbackDialogOpen,
    compactInFlight: partialCompactInFlight,
    compactRuntimeMatches: hasRuntimeSelected
      && currentRuntimeAgentId === partialCompactRuntimeId,
    hasRuntimeSelected,
    hasThreadAwaitTarget,
    hasChoiceRequest: Array.isArray(requests)
      // 桥接期：定义于 choice-input（选择卡域收敛时改 import）
      && requests.some(req => window.isChoiceInputRequest(req) && !window.isChoiceInputConsumed(req.requestId)),
    hasLocalQueuedInput: hasRuntimeSelected
      && (localQueuedInputPending || pendingQueuedCount > 0 || queuedTexts.length > 0),
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
  attachBtn.title = getCurrentLanguage() === 'zh' ? '添加附件' : 'Attach';
  attachBtn.innerHTML = _COMPOSER_ATTACH_SVG;
  left.appendChild(fileInput);
  left.appendChild(attachBtn);
  toolbar.appendChild(left);

  const right = document.createElement('div');
  right.className = 'persistent-input-toolbar-right';

  const modelBtn = document.createElement('button');
  modelBtn.className = 'input-model-switch-btn';
  modelBtn.id = 'input-model-switch-btn';
  // 桥接期：定义于 input-model-switcher（模型切换域收敛时改 import）
  modelBtn.onclick = function(event) { window.toggleInputModelDropdown(event); };
  modelBtn.innerHTML = '<span class="input-model-name">' + (getCurrentLanguage() === 'zh' ? '模型' : 'Model') + '</span>'
    + _COMPOSER_MODEL_CHEVRON_SVG;

  const thinkingBtn = document.createElement('button');
  thinkingBtn.className = 'input-thinking-btn';
  thinkingBtn.id = 'input-thinking-btn';
  // 桥接期：定义于 input-model-switcher（模型切换域收敛时改 import）
  thinkingBtn.onclick = function(event) { window.toggleThinkingEffortDropdown(event); };
  thinkingBtn.innerHTML = _COMPOSER_THINKING_ICON_SVG
    + '<span class="input-thinking-name">' + (getCurrentLanguage() === 'zh' ? '思考强度' : 'Thinking') + '</span>'
    + _COMPOSER_THINKING_CHEVRON_SVG;

  const voiceBtn = document.createElement('button');
  voiceBtn.className = 'voice-input-btn';
  voiceBtn.dataset.target = 'input-persistent';
  // 桥接期：定义于 voice-input（语音域收敛时改 import）
  voiceBtn.onclick = function() { window.toggleVoiceRecording(this); };
  voiceBtn.title = getCurrentLanguage() === 'zh' ? '语音输入' : 'Voice Input';
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

export function ensurePersistentComposerCard(container) {
  // 优先复用模块级单例：元素被外部 detach（容器遭清空的异常路径）后对象
  // 仍存活——重新插入同一节点，DOM 节点身份保持不变。交互弹窗（选择卡/
  // 回退对话框）已解耦到独立渲染面，正常路径不会再销毁 composer。
  if (!container.querySelector('[data-persistent-composer]')) {
    if (!_composerCard) _composerCard = buildComposerCard();
    // 桥接期：定义于 chat-viewport（聊天视口域收敛时改 import）
    window.runWithSuppressedChatViewportObservers(() => {
      container.appendChild(_composerCard);
    });
    const ta = _composerCard.querySelector('.user-input-textarea');
    if (ta && !ta.dataset.sessionKey) {
      // 挂载时初始化会话身份（首次挂载或从对话框 detach 恢复）
      ta.dataset.sessionKey = window._getSessionInputCacheKey() || '';
      _restoreSessionInputDraft(ta, ta.dataset.sessionKey);
    }
  }
  return container.querySelector('[data-persistent-composer]') || _composerCard;
}

/**
 * 为常驻 composer 绑定普通发言提交行为。
 */
export function applyComposerMode(card) {
  const ta = card.querySelector('.user-input-textarea');
  const sendBtn = card.querySelector('.persistent-action-btn');
  if (!ta || !sendBtn) return;

  ta.id = 'input-persistent';
  ta.placeholder = t('input_placeholder');
  ta.onkeydown = handlePersistentInputKey;
  card.dataset.composerMode = 'persistent';
  card.classList.add('persistent-input');

  sendBtn.id = 'persistent-action-btn';
  sendBtn.title = getCurrentLanguage() === 'zh' ? '发送' : 'Send';
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
export function syncPersistentComposerSessionCard(container) {
  const card = container.querySelector('[data-persistent-composer]');
  const ta = card ? card.querySelector('.user-input-textarea') : null;
  if (!ta) return false;
  const oldKey = ta.dataset.sessionKey || '';
  const newKey = window._getSessionInputCacheKey() || '';
  if (oldKey === newKey) return false;
  if (oldKey) sessionInputCache[oldKey] = ta.value || '';
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

export function hidePersistentComposerCard() {
  if (_composerCard) _composerCard.style.display = 'none';
}

export function showPersistentComposerCard(container) {
  const card = ensurePersistentComposerCard(container);
  _composerCard = card;
  card.style.display = '';
  return card;
}

export function getPersistentComposerCard() {
  return _composerCard;
}

/**
 * 向容器安全插入互斥卡（readonly / 压缩状态卡），语义为"插在常驻 composer
 * 之前"。引用节点不在容器内时 insertBefore 会抛 NotFoundError——composer
 * 单例引用存在但 parentNode 已断（容器遭外部清空的异常路径）时回落为
 * null（等同 appendChild）。
 */
export function insertTransientInputCard(container, card) {
  const ref = getPersistentComposerCard();
  const refInContainer = ref && ref.parentNode === container ? ref : null;
  container.insertBefore(card, refInContainer);
}

// 清理互斥临时内容（readonly 卡 / 压缩卡 / 气泡 / 胶囊）。交互弹窗（选择
// 卡 / 回退对话框卡）在独立渲染面，不经此函数。常驻 composer 是容器内唯一
// 保留的子元素；气泡栈与 meta bar 由各自模块按需重建。
export function detachTransientInputContent(container) {
  if (compactTimerInterval) {
    clearInterval(compactTimerInterval);
    setCompactTimerInterval(null);
  }
  for (const child of Array.from(container.children)) {
    if (child.dataset && child.dataset.persistentComposer) continue;
    child.remove();
  }
  // 气泡栈 DOM 被清理后重置签名缓存，回 persistent 时由 _renderQueueBubbles 重插
  setLastQueueBubbleSignature('');
}

// ── 兼容桥（未迁移消费方收敛后注销）────────────────────────────────────────
// 函数键落 `input-composer-api` 域而不是 `input-composer`：后者已由
// p2-w2-3a-composer-state.js claim（impl 只转发 `_sessionInputCache`），认领后
// 补注册的函数键会取到 undefined。理由见文件头注。
const BRIDGE_FUNCTIONS = {
  resolveInputSurfaceMode,
  readInputSurfaceModeState,
  _cacheSessionInput,
  _storeVisibleSessionInputDraft,
  syncPersistentComposerSessionCard,
  hidePersistentComposerCard,
  insertTransientInputCard,
  detachTransientInputContent,
};

// 逐键消费方（grep public/，排除定义方）与注销条件：
//   resolveInputSurfaceMode          ← app-main（getInputSurfaceMode，裸调用）
//   readInputSurfaceModeState        ← app-main（同上）
//   _cacheSessionInput               ← app-chat-input / slash-menu / voice-input（window.）
//   _storeVisibleSessionInputDraft   ← app-main（宿主 storeDraft）/ session-readonly-view
//                                      （window.）/ thread-store（裸调用）/ workspace-actions（window.）
//   syncPersistentComposerSessionCard← input-render（window.）
//   hidePersistentComposerCard       ← input-render / rollback-dialog-runtime（window.）
//   insertTransientInputCard         ← input-render（window.）
//   detachTransientInputContent      ← input-render / rollback-dialog-runtime（window.）
// 注销条件：以上消费方迁 ESM 并改为 import 之后。
window.KernelState.defineKey('input-composer-api', 'resolveInputSurfaceMode', resolveInputSurfaceMode);
window.KernelState.defineKey('input-composer-api', 'readInputSurfaceModeState', readInputSurfaceModeState);
window.KernelState.defineKey('input-composer-api', '_cacheSessionInput', _cacheSessionInput);
window.KernelState.defineKey('input-composer-api', '_storeVisibleSessionInputDraft', _storeVisibleSessionInputDraft);
window.KernelState.defineKey('input-composer-api', 'syncPersistentComposerSessionCard', syncPersistentComposerSessionCard);
window.KernelState.defineKey('input-composer-api', 'hidePersistentComposerCard', hidePersistentComposerCard);
window.KernelState.defineKey('input-composer-api', 'insertTransientInputCard', insertTransientInputCard);
window.KernelState.defineKey('input-composer-api', 'detachTransientInputContent', detachTransientInputContent);

window.KernelState.claim('input-composer-api', {
  get(key) {
    return BRIDGE_FUNCTIONS[key];
  },
  set(key, value) {
    BRIDGE_FUNCTIONS[key] = value;
  },
});
