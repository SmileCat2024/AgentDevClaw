/**
 * frontend-input-composer.test.js — 输入区 Composer 常驻化验收用例
 *
 * 覆盖：
 *   1. lease 不翻转 composer：普通文本 lease 到达/清除时元素身份与端点不变
 *      （ADR-0035 替代原「persistent ↔ requests 模式翻转」用例）
 *   2. 会话切换：草稿按 sessionKey 保存/恢复、不串会话；提交后草稿键删除
 *   3. 草稿迁移后 voice-input.js 的 re-export 与既有引用零行为变化
 *   4. 模式判定矩阵（行为契约 §3）纯函数用例锁死
 *
 * 参考 test/frontend-interrupt-voice-lifecycle.test.js 的沙箱与 overrides 方式。
 */

import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox, prepareEsmModules, SESSION_VIEW_DOMAIN } from './p2-classic-hosts.js';

const SLASH_MENU = 'public/src/modules/slash-menu.js';
const QUEUE_PROJECTION = 'public/src/modules/p2-w2-3a-queue-projection.js';
const INPUT_QUEUE_STATE = 'public/src/modules/p2-w2-3a-input-queue-state.js';

// ── Mini DOM：支撑 renderInputRequests / composer 流程的最小元素树 ─────────

function matchesSimple(part, el) {
  if (part.startsWith('.')) return el.classList.contains(part.slice(1));
  if (part.startsWith('#')) return el.id === part.slice(1);
  if (part.startsWith('[')) {
    const inner = part.slice(1, -1);
    const eqIdx = inner.indexOf('=');
    if (eqIdx === -1) return el.getAttribute(inner) != null;
    const isPrefix = inner[eqIdx - 1] === '^' && inner[eqIdx + 1] === '=';
    const attr = isPrefix ? inner.slice(0, eqIdx - 1) : inner.slice(0, eqIdx);
    const value = inner.slice(eqIdx + 1).replace(/^"|"$/g, '');
    const actual = el.getAttribute(attr);
    if (isPrefix) return String(actual ?? '').startsWith(value);
    return String(actual ?? '') === value;
  }
  return el.tagName === part.toUpperCase();
}

function selectorPredicate(selector) {
  const groups = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
  return (el) => groups.some((group) =>
    group.split(/\s*>\s*|\s+/).filter(Boolean).every((part) => {
      if (part.startsWith(':')) return true; // :scope 等伪类不深入匹配
      return matchesSimple(part, el);
    }));
}

function findFirst(root, predicate) {
  for (const child of root.children) {
    if (predicate(child)) return child;
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function findAllDeep(root, predicate, out = []) {
  for (const child of root.children) {
    if (predicate(child)) out.push(child);
    findAllDeep(child, predicate, out);
  }
  return out;
}

function createMiniElement(tagName, doc) {
  const elementListeners = new Map();
  const classes = new Set();
  const attributes = new Map();
  // dataset 赋值与 data-* attribute 双向同步（camelCase ↔ kebab-case），
  // 供 [data-...] 属性谓词查询使用
  const dataset = new Proxy({}, {
    set(target, key, value) {
      target[key] = value;
      const kebab = String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      attributes.set('data-' + kebab, String(value));
      return true;
    },
    get(target, key) { return target[key]; },
    deleteProperty(target, key) {
      delete target[key];
      attributes.delete('data-' + String(key).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
      return true;
    },
  });
  return {
    tagName: String(tagName).toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    value: '',
    rows: 1,
    disabled: false,
    type: '',
    accept: '',
    multiple: false,
    placeholder: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    title: '',
    selectionStart: 0,
    selectionEnd: 0,
    innerHTML: '',
    style: {},
    dataset,
    // id 与 attribute 注册表双向同步（浏览器 getElementById 语义）
    get id() { return attributes.has('id') ? attributes.get('id') : ''; },
    set id(value) {
      if (value) attributes.set('id', String(value));
      else attributes.delete('id');
    },
    classList: {
      add: (...names) => { names.forEach((n) => classes.add(n)); },
      remove: (...names) => { names.forEach((n) => classes.delete(n)); },
      toggle: (name, force) => {
        const want = force === undefined ? !classes.has(name) : Boolean(force);
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
      contains: (name) => classes.has(name),
    },
    get className() { return Array.from(classes).join(' '); },
    set className(value) {
      classes.clear();
      String(value).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(node, ref) {
      if (!node) return node;
      if (node.parentNode) node.parentNode.removeChild(node);
      node.parentNode = this;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx === -1) this.children.push(node);
      else this.children.splice(idx, 0, node);
      return node;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    contains(target) {
      return this.children.some((c) => c === target || c.contains(target));
    },
    querySelector(selector) {
      return findFirst(this, selectorPredicate(selector));
    },
    closest(selector) {
      const predicate = selectorPredicate(selector);
      let node = this;
      while (node) {
        if (predicate(node)) return node;
        node = node.parentNode;
      }
      return null;
    },
    querySelectorAll(selector) {
      return findAllDeep(this, selectorPredicate(selector));
    },
    get isConnected() {
      let node = this;
      while (node.parentNode) node = node.parentNode;
      return doc ? node === doc.body : false;
    },
    getBoundingClientRect() {
      return { width: 360, height: 48, left: 24, top: 520, right: 384, bottom: 568 };
    },
    // 元素级监听（slash 菜单本体注册 Enter/click 与 hover 收起）
    addEventListener(type, callback) {
      if (!elementListeners.has(type)) elementListeners.set(type, []);
      elementListeners.get(type).push(callback);
    },
    removeEventListener(type, callback) {
      const list = elementListeners.get(type);
      if (list) elementListeners.set(type, list.filter((cb) => cb !== callback));
    },
    dispatchEvent(event) {
      for (const callback of elementListeners.get(event.type) || []) callback(event);
      return true;
    },
    focus() { if (doc) doc.activeElement = this; },
    blur() { if (doc && doc.activeElement === this) doc.activeElement = doc.body; },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
}

function createMiniDocument() {
  const doc = { activeElement: null, readyState: 'complete' };
  doc.body = createMiniElement('body', doc);
  doc.body.contains = function (node) { return node === this || this.contains(node); };
  doc.createElement = (tag) => createMiniElement(tag, doc);
  doc.getElementById = (id) => findAllDeep(doc.body, (el) => el.id === id)[0] || null;
  doc.querySelector = (selector) => findFirst(doc.body, selectorPredicate(selector));
  doc.querySelectorAll = (selector) => findAllDeep(doc.body, selectorPredicate(selector));
  // document 级监听（slash-menu 用 capture 监听 input / keydown）：记录并按
  // 注册序派发，供用例以真实事件驱动菜单与 pill 行为。
  const listeners = new Map();
  doc.addEventListener = (type, callback) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(callback);
  };
  doc.removeEventListener = (type, callback) => {
    const list = listeners.get(type);
    if (!list) return;
    listeners.set(type, list.filter((cb) => cb !== callback));
  };
  doc.dispatch = (type, event) => {
    for (const callback of listeners.get(type) || []) callback(event);
  };
  return doc;
}

// ── 渲染沙箱：注入输入区全局符号，跑真实模块源码 ───────────────────────────

// ESM 图会经 thread-store-domain → workspace-actions 带入 trim-page /
// session-dialogs（两批正在 ESM 化）：它们在**装载期**按 id 取自己的控件并注册
// 监听。生产由 index.html 的静态标记提供；本用例不渲染这两个界面，按同一批 id
// 建最小节点，避免「元素缺失」在装载期变成 TypeError。
const BOOTSTRAP_ELEMENT_IDS = [
  'agent-context-menu', 'agent-list', 'app-chat-input-slot', 'chat-container',
  'chat-process-toggle', 'compact-branch-action', 'compact-context-menu',
  'compact-summary-action', 'compact-trim-action', 'ctx-menu', 'current-agent-name',
  'delete-agent-action', 'delete-feature-action', 'delete-project-action',
  'external-agent-list', 'external-count', 'external-group', 'feature-panel',
  'feature-panel-body', 'feature-panel-collapse-hint', 'feature-panel-resizer',
  'feature-panel-title', 'feature-repo-context-menu', 'follow-latest-btn',
  'language-toggle', 'notification-metrics', 'notification-phase', 'notification-status',
  'notification-summary', 'persistent-action-btn', 'prebuilt-agent-list', 'prebuilt-count',
  'prebuilt-group', 'project-context-menu', 'project-docset-overlay', 'project-docset-sheet',
  'project-docset-toggle', 'restart-agent-action', 'settings-flyout-auth',
  'settings-flyout-config', 'settings-flyout-exit', 'settings-flyout-mcp-gateway',
  'settings-flyout-menu', 'settings-flyout-plugins', 'settings-flyout-proxy',
  'settings-flyout-remote', 'settings-flyout-remote-servers', 'settings-flyout-usage',
  'settings-flyout-workspace', 'settings-toggle', 'sidebar', 'sidebar-collapse-hint',
  'sidebar-resizer', 'sidebar-toggle', 'stop-agent-action', 'theme-toggle',
  'tool-agent-list', 'tool-count', 'tool-group', 'workspace-tabs-bar',
];

const LOAD_TIME_DOM_ELEMENT_IDS = [
  'trim-page', 'trim-page-title', 'trim-page-mode', 'trim-page-list', 'trim-page-readout',
  'trim-page-submit', 'trim-page-ratio-input', 'trim-page-ratio-slider', 'trim-page-ratio-config',
  'trim-page-manual-config', 'trim-page-archive-row', 'trim-page-archive-toggle',
  'trim-page-summary-toggle', 'trim-page-keep-skill-control', 'trim-page-keep-skill-toggle',
  'trim-page-keep-skill-value', 'trim-page-keep-skill-dec', 'trim-page-keep-skill-inc',
  'branch-dialog', 'branch-round-list', 'branch-submit', 'branch-footer-info',
];

function createInputDom(contextKey, requests) {
  const doc = createMiniDocument();
  const container = createMiniElement('div', doc);
  container.id = 'user-input-container';
  doc.body.appendChild(container);
  // 交互面容器（选择卡/回退对话框的独立渲染面）：renderInputRequests 对两个
  // 容器做存在性检查，缺失会整体 no-op
  const choiceContainer = createMiniElement('div', doc);
  choiceContainer.id = 'choice-input-container';
  doc.body.appendChild(choiceContainer);

  for (const id of [...BOOTSTRAP_ELEMENT_IDS, ...LOAD_TIME_DOM_ELEMENT_IDS]) {
    if (doc.getElementById(id)) continue;
    const el = createMiniElement('div', doc);
    el.id = id;
    doc.body.appendChild(el);
  }

  const state = { doc, container, liveKey: contextKey, requests };
  return { doc, container, choiceContainer, state };
}

/**
 * 输入区全局符号面：classic 沙箱（createInputSandbox）与 ESM 用例
 * （withInputEsmCase）共用同一份，避免两条装载路线漂移。
 * `getRuntimeAgentId` 取当前运行时 id（classic 沙箱读 window 变量，ESM 用例
 * 读内核桥访问器——两者都是同一份权威状态）。
 */
function buildInputGlobals(doc, state, getRuntimeAgentId) {
  return {
    document: doc,
    // 输入区全局状态
    currentLanguage: 'zh',
    currentRuntimeAgentId: 'agent-1',
    readOnlyMode: false,
    // 回退 / 压缩域状态键（P4 T2）：注册壳 rollback-dialog.js 在用例体首段真实
    // import（defineKey + owner claim），不再由夹具以同名全局播种。
    _rollbackDialogOpen: false,
    _partialCompactInFlight: false,
    _partialCompactRuntimeId: null,
    _compactTimerInterval: null,
    currentInputRequests: state.requests,
    // 语音域（默认无录音）
    _voiceRecording: false,
    _voiceStopping: false,
    _voiceTranscribing: false,
    _voicePendingSend: false,
    _voiceCacheKey: null,
    _pendingVoiceResults: {},
    // 依赖函数 stub（composer 绑定引用，用例内不触发真实行为）
    t: (key) => key,
    getRuntimeContextKey: () => state.liveKey,
    _getSessionInputCacheKey: () => state.liveKey,
    isChatSurfaceActive: () => true,
    isRemoteNamespaceAgentId: () => false,
    readCurrentSessionViewState: () => ({ inputRequests: state.requests }),
    // 会话视图 token：真实判定（session-view-commit）按字段比较——空身份 token 以
    // runtimeId 为准；switchEpoch / generation 取 owner 的初值（0 / undefined）。
    captureSessionViewToken: (runtimeId) => ({
      runtimeId,
      identity: null,
      switchEpoch: 0,
      generation: undefined,
      key: state.liveKey,
    }),
    runWithSuppressedChatViewportObservers: (fn) => fn(),
    notifyChatViewportMutation: () => {},
    isChoiceInputRequest: (req) => !!req && req.mode === 'choices'
      && Array.isArray(req.questions) && req.questions.length > 0,
    isChoiceInputRejected: () => false,
    isChoiceInputConsumed: () => false,
    renderChoiceInputRequest: () => {},
    collapsePrimaryChoiceRequest: () => {},
    handlePersistentInputKey: () => {},
    onPersistentBtnClick: () => {},
    submitQueuedInput: () => {},
    toggleInputModelDropdown: () => {},
    toggleThinkingEffortDropdown: () => {},
    toggleVoiceRecording: () => {},
    onImageFilesSelected: () => {},
    handleInputPaste: () => {},
    _syncPersistentActionButton: () => {},
    _setActionBtnSend: () => {},
    _setActionBtnStop: () => {},
    _setActionBtnSending: () => {},
    _beginSubmitFeedbackWindow: () => {},
    _endSubmitFeedbackWindow: () => {},
    _nextPaint: async () => {},
    autoResize: () => {},
    updateInputModelSwitcher: () => {},
    updateThinkingEffortSwitcher: () => {},
    // 已迁 ESM 消费方（input-actions / 排队投影 / sse-client）的静态图在装载期经
    // `window.createXHost()` 取 classic 相宿主工厂（生产契约由 classic 相与各 host
    // 用例覆盖）。本用例只要求这些 seam 在装载期可解析；能力不被触达。
    ...Object.fromEntries([
      'createAgentCallStatesHost', 'createAgentSnapshotLoaderHost', 'createCallInterruptHost',
      'createMessageProbeHost', 'createMetadataCommitHost', 'createP2BootstrapCallActivityHost',
      'createP2BootstrapSessionSwitchHost',
      'createP2BootstrapSidebarHost', 'createP2BootstrapSidebarRenderHost',
      'createPollCoordinatorHost', 'createRuntimeNotFoundHost',
    ].map((name) => [name, () => ({})])),
    // 会话提交策略的宿主面（生产由 classic session-view-state 提供）：按策略实际
    // 读取的字段给形状（identity 空 = 无身份 token，token 以 runtimeId 为准）。
    createSessionViewCommitHost: () => ({
      identity: () => null,
      read: () => ({}),
      apply: () => {},
      normalizeModel: () => ({}),
    }),
    // runtime-status（P4 T2 起 ESM）经桥调用点的身份归一化（生产 app-core 的
    // classic 函数）：语义与生产一致（String(...).trim()）。
    normalizeAgentIdentity: (value) => String(value || '').trim(),
    // 调用状态容器按引用共享（sse-client 的 choice 提醒经它去重；
    // runtime-status 的 isRuntimeCalling 读 _agentCallActive）
    createP2BootstrapCallActivityHost: () => ({
      _seenChoiceAlertIds: new Set(), _agentCallActive: new Map(),
      _recentlyFinishedRuntimes: new Set(), _autoTitleTriggered: new Set(),
      _interruptSuppression: new Map(), _lastInterruptUserActionAt: 0,
    }),
    // 侧栏 DOM 容器（P4 T2：sidebar-render 迁 ESM 后在模块求值期装委托/写外部列表）
    createP2BootstrapDomHost: () => ({
      container: doc.createElement('div'),
      agentList: doc.createElement('div'), externalAgentList: doc.createElement('div'),
      externalGroup: doc.createElement('div'), externalCount: doc.createElement('div'),
      currentAgentTitle: doc.createElement('div'),
    }),
    // 侧栏渲染的 classic 协作面（app-main / app-ui）：本夹具不验侧栏渲染。
    groupConnectedAgents: (agents) => ({ external: Array.isArray(agents) ? agents : [], groups: [] }),
    updateCurrentAgentChrome: () => {},
    ClawSidebarLayout: { load: async () => {}, signature: () => '', isInteracting: () => false, render() {} },
    // agent-loader-host 装载期读 classic 相交出的详情缓存容器（app-core 持有）
    AgentLoaderHost: { loadedAgentDetailIds: new Set() },
    // 提交成功后置的 UI / 记账汇点（生产来自 runtime-status / desktop-notify /
    // sidebar-render / chat-viewport / recap-hint）：本夹具只断言提交端点与草稿。
    isRuntimeCalling: () => false,
    isInterruptSuppressed: () => false,
    clearInterruptSuppression: () => {},
    _markAgentCallStartedForNotify: () => {},
    _requestNotifyPermission: () => {},
    renderAgentList: () => {},
    beginFollowLatestEntryWindow: () => {},
    requestFollowLatest: () => {},
    updateQueueIndicator: () => {},
    _clearRecapForNewMessage: () => {},
    refreshThreads: () => {},
    _renderAttachmentPreview: () => {},
    _renderLastCallElapsed: () => {},
    _renderRecapHint: () => {},
    _injectPendingVoiceResult: () => {},
    _renderQueueBubbles: () => {},
    _syncPersistentInputUi: () => {},
    rebindQueueProjectionForRuntime: () => {},
    _lastQueueBubbleSignature: '',
    _pendingQueuedCount: 0,
    _queuedTexts: [],
    _localQueuedInputPending: false,
    stopVoiceRecording: () => {},
    _cancelVoiceRecording: () => {},
    _shouldPreserveVoiceInputForRender: () => false,
    _agentCallActive: new Map(),
    escapeHtml: (text) => String(text == null ? '' : text).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m])),
  };
}

function createInputSandbox({ contextKey = 'session-a', requests = [] } = {}) {
  const { doc, container, choiceContainer, state } = createInputDom(contextKey, requests);
  const ctx = createFrontendSandbox(buildInputGlobals(doc, state, () => ctx.currentRuntimeAgentId));
  ctx.state = state;
  return ctx;
}

// classic 相只保留「模式判定入口」：app-main 的 getInputSurfaceMode 是 classic
// 实现（整份 app-main 会拉起启动链），这里注入真实的那一段源码；它调用的
// resolveInputSurfaceMode / readInputSurfaceModeState 由 input-composer 的桥键
// 提供（P4 输入面批次起是 ESM，见 withInputEsmCase 的用例体）。
function loadInputSurfaceModeEntry(ctx) {
  ctx.run(`
    function getInputSurfaceMode(requests = readCurrentSessionViewState().inputRequests) {
      return resolveInputSurfaceMode(readInputSurfaceModeState(requests, isChatSurfaceActive()));
    }
  `);
}

// input-composer / input-render / persistent-input 仍是 classic（同步首屏边界），
// 继续走真实 classic 源；已迁 ESM 的消费面（slash-menu、排队投影）走真实 import。
// 每个用例一份 window + 一张 ESM 图（整图隔离），classic 相按 index.html 加载序
// 先行，内核桥键（i18n 语言 / orchestration 运行时 id）在 classic 相注册真初值，
// ESM owner 装载时认领——与生产 app-core 的桥接时序同形。
const INPUT_RENDER = 'public/src/modules/input-render.js';

/**
 * 输入面用例（渲染器已迁 ESM 的用例统一入口）：classic 沙箱 + 一张真实 ESM 图，
 * 用例体拿到沙箱本身（`ctx.run` / `ctx.state` / `ctx.window` 与原夹具同形）。
 * 必须在用例体内完成断言——case 结束即回收全局与模块图。
 */
function withInputCase(fn) {
  return withInputEsmCase({}, async ({ c, state }) => {
    const ctx = c.window; // 沙箱本身（带 .run / .runSource 面，与原夹具同形）
    ctx.state = state;
    return fn(ctx);
  });
}

function withInputEsmCase(options, fn) {
  const { contextKey = 'session-a', requests = [], classic, globals = {} } = options || {};
  const { doc, container, choiceContainer, state } = createInputDom(contextKey, requests);
  const holder = {};
  const baseGlobals = buildInputGlobals(doc, state, () => holder.sandbox.currentRuntimeAgentId);
  delete baseGlobals.currentRuntimeAgentId; // 由内核桥访问器提供（ESM owner 认领后真值）

  return withP2EsmCase({
    label: 'input-composer',
    classic: (sandbox) => {
      holder.sandbox = sandbox;
      sandbox.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
      sandbox.KernelState.defineKey('orchestration', 'currentRuntimeAgentId', 'agent-1');
      sandbox.KernelState.defineKey('orchestration', '_switchEpoch', 0);
      // 只读态与会话视图快照同样是「classic 相注册真初值 → ESM owner 认领」
      // （生产由 app-core 注册）：用例里 ctx.readOnlyMode = true 仍按 window 写方
      // 语义经访问器落到 agent-store owner，输入面模式判定读到同一份状态。
      sandbox.KernelState.defineKey('agent-store', 'readOnlyMode', false);
      sandbox.KernelState.defineKey('session-view-storage', 'currentMessages', []);
      sandbox.KernelState.defineKey('session-view-storage', 'currentInputRequests', []);
      // ESM 图内的模块装载期注册动作处理器（window.ClawFW.actions）。
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      loadInputSurfaceModeEntry(sandbox);
      // 装载期宿主面（本 fixture 的 classic 相只到输入面切片，不含 app-core /
      // app-main / app-ui）。真实链安装实测被阻断：app-core 会重复注册本用例预置的
      // 内核桥键（或反过来），app-ui 的 renderCurrentMainView 需要整条页面渲染链
      // （chat-viewport → input-render → app-chat-input 槽位），本 fixture 的 mini DOM
      // 无法满足。逐支按生产读取面给形状（宿主接口与生产一致，非统一空壳）：
      //   createRuntimeViewCacheHost ← app-core.js：runtime-view-cache 读 host.cache(Map)/capacity
      //   createRuntimeSwitchHost    ← app-main.js：runtime-switch-host 顶层对 host.state 做 defineProperties
      //   createAgentSnapshotLoaderHost ← sidebar-render.js：读 host.state.suppressRender
      //   createP2BootstrapSidebarRenderHost ← sidebar-render.js：只提供 lastAgentListRenderSignature 访问器（无 state）
      //   createP2Bootstrap*Host ↙ app-core.js：成对 get/set 访问器袋，成员只在函数体内读取
      //   createWorkspaceEntryHost / createCompactResumeHost ← app-main.js：闭包宿主，本图不调用
      //   createWorkspaceSurfaceHost ← app-ui.js：只 spread 注入，本图不驱动工作区表面
      // 聊天表面状态宿主（生产由 app-core 提供）：跟随开关 / 滚动抑制 / 过程显隐
      // 三个 classic 顶层状态，成对转发到沙箱全局（输入面渲染器的视口声明读它）。
      sandbox.createP2BootstrapChatSurfaceHost = () => ({
        get followLatestEnabled() { return sandbox.followLatestEnabled; },
        set followLatestEnabled(value) { sandbox.followLatestEnabled = value; },
        get suppressFollowScrollEvent() { return sandbox.suppressFollowScrollEvent; },
        set suppressFollowScrollEvent(value) { sandbox.suppressFollowScrollEvent = value; },
        get showChatProcess() { return sandbox.showChatProcess; },
        set showChatProcess(value) { sandbox.showChatProcess = value; },
      });
      sandbox.createRuntimeViewCacheHost = () => ({ cache: new Map(), capacity: 0 });
      sandbox.createRuntimeSwitchHost = () => ({ state: {} });
      sandbox.createAgentSnapshotLoaderHost = () => ({ state: {} });
      sandbox.createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
      sandbox.createAgentCallStatesHost = () => ({});
      sandbox.createP2BootstrapPhSessionHost = () => ({});
      sandbox.createP2BootstrapAssemblyHost = () => ({});
      sandbox.createP2BootstrapContextMenuHost = () => ({});
      sandbox.createP2BootstrapDebugPanelHost = () => ({});
      sandbox.createWorkspaceEntryHost = () => ({});
      sandbox.createCompactResumeHost = () => ({});
      sandbox.createWorkspaceSurfaceHost = () => ({});
      if (typeof classic === 'function') classic(sandbox);
    },
    globals: Object.fromEntries(Object.entries({
      ...baseGlobals,
      ...(typeof globals === 'function' ? globals(state) : globals),
    }).filter(([, value]) => value !== undefined)),
  }, async (c) => {
    // 输入面渲染器已迁 ESM（P4 T2）：回退 / 压缩域注册壳先求值（状态键 window
    // 访问器 + owner claim），再真实 import 渲染入口。渲染入口经 c.expose 注入
    // 沙箱，让用例的经典驱动面（ctx.run）与生产入口名一致。
    await c.load('public/src/modules/rollback-dialog.js');
    // 输入面实现（P4 输入面批次起是 ESM）：composer 组件 + 常驻输入组件的桥键
    // （模式判定 / 草稿 / 渲染入口）必须先于渲染入口的调用就位。
    await c.load('public/src/modules/persistent-input.js');
    const render = await c.load(INPUT_RENDER);
    c.expose('renderInputRequests', render.renderInputRequests);
    c.expose('notifyInputSurfaceChanged', render.notifyInputSurfaceChanged);
    // 会话身份（P4 T1：identity 域是 owner）：生产里的 viewer 绑定由 switchAgent
    // 建立，用例的会话切换经同一入口同步（烧掉 getRuntimeWorkspaceSessionId 桩）。
    const identity = await c.load('public/src/modules/identity.js');
    const syncInputIdentity = () => {
      const runtimeId = String(c.window.currentRuntimeAgentId || '').trim();
      if (runtimeId) identity.setViewerSessionBinding(runtimeId, state.liveKey);
    };
    c.window.__syncInputIdentity = syncInputIdentity;
    state.syncIdentity = syncInputIdentity;
    syncInputIdentity();
    c.state = state;
    return fn({ c, doc, state, container, choiceContainer, render });
  });
}

// ── 排队投影装载面（ESM 用例共用）──────────────────────────────────────────
// 状态 owner（p2-w2-3a-input-queue-state）与投影/同步实现
// （p2-w2-3a-queue-projection）已是 ESM → 真实 import；输入面实现
// （persistent-input，含 rebindQueueProjectionForRuntime 与交互面守卫）同样是
// ESM，在用例体里与投影同图装载，不再按源码切片重放。
function loadQueueClassicBootstrap(sandbox) {
  // 投影模块已 import 会话提交策略宿主：classic commit host 由 session-view-state
  // 提供（生产同源）。
  prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN);
}

function withQueueProjectionCase(extraGlobals, fn) {
  return withInputEsmCase({
    classic: loadQueueClassicBootstrap,
    globals: {
      // 会话视图 token 用真实 classic 实现（session-view-state）：投影模块已
      // import 会话提交策略宿主，token 判定走真实代次/身份语义。
      captureSessionViewToken: undefined,
      isSessionViewTokenCurrent: undefined,
      // classic 相调用点（runtime-status 域）：本用例无存活轮次
      isRuntimeCalling: () => false,
      ...(extraGlobals || {}),
    },
  }, async ({ c, doc, state, container, choiceContainer }) => {
    // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主 createThreadStoreHost，
// 必须先于 thread-store-domain 进入同一张图。
    await c.load('public/src/modules/thread-store.js');
    // 输入面实现：排队重绑（rebindQueueProjectionForRuntime）与交互面守卫的桥键来源
    await c.load('public/src/modules/persistent-input.js');
    const queueState = await c.load(INPUT_QUEUE_STATE);
    const projection = await c.load(QUEUE_PROJECTION);
    return fn({ c, doc, state, container, choiceContainer, queueState, projection });
  });
}

// ── slash 菜单/面板装载面（ESM 用例共用）────────────────────────────────────
// 生产里 prompt pill 由「菜单选中 prompt 型命令」挂载、激活经真实
// capability_invoke 投递；用例按同一条公开链路驱动，不触碰模块私有状态。

const slashFetchStub = (invokeCalls = []) => async (url, options = {}) => {
  const target = String(url);
  if (target.startsWith('/protoclaw/commands')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, commands: [] }) };
  }
  if (target === '/protoclaw/capability_invoke') {
    const body = JSON.parse(options.body || '{}');
    invokeCalls.push(body.ref);
    return { ok: true, status: 200, json: async () => ({ ok: true, result: body.ref }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const slashTargetGlobals = () => ({
  getRuntimeId: (id) => id,
  getRuntimeWorkspaceSessionId: () => 'session-a',
  getLogicalAgentId: () => 'programming-helper',
  getCurrentRuntimeRecord: () => ({ id: 'agent-1' }),
});

/** 在文档里挂一个 user-input-textarea（菜单/pill 的触发与挂载锚点）。 */
function mountSlashTextarea(c, initialValue = '') {
  const doc = c.document;
  const area = doc.createElement('div');
  area.className = 'persistent-input-textarea-area';
  doc.body.appendChild(area);
  const ta = doc.createElement('textarea');
  ta.className = 'user-input-textarea';
  ta.id = 'input-persistent';
  ta.value = initialValue;
  area.appendChild(ta);
  return ta;
}

/** 经菜单公开链路选中 prompt 型命令 → 挂 pill（不直接写模块私有桶）。 */
function mountPromptPill(c, SlashMenu, ta, cmd, typedValue) {
  SlashMenu.registerCommands([{ ...cmd, destination: 'session', kind: 'prompt' }]);
  const doc = c.document;
  ta.value = typedValue ?? ('/' + String(cmd.name).split('.').pop());
  doc.dispatch('input', { target: ta });
  doc.dispatch('keydown', {
    target: ta,
    key: 'Enter',
    preventDefault() {},
    stopPropagation() {},
  });
}

// 输入面重渲染（会话切换 / lease 变化都经同一入口）。ADR-0035 后不存在
// 「模式翻转」：普通文本 lease 只是一条状态，不改变 composer 形态与端点。
// 去重签名自 P4 T2 起是渲染器的模块私有状态（不再是沙箱全局）：用例只声明
// 真实状态变化（会话键 / 模式 / 压缩态），是否重渲染由渲染器按签名自行判定。
function renderInputSurface(ctx) {
  ctx.state.requests = [];
  ctx.run('currentInputRequests = []; renderInputRequests([])');
}

function renderInputSurfaceWithLease(ctx, lease) {
  ctx.state.requests = [lease];
  ctx.currentInputRequests = [lease];
  ctx.run('renderInputRequests(currentInputRequests)');
}

// ── 用例 1：lease 不翻转常驻 composer ────────────────────────────────────────

describe('persistent composer DOM identity (ADR-0035)', () => {
  it('keeps one persistent composer endpoint while a text lease is pending', () => withInputCase((ctx) => {
    ctx.run('renderInputRequests([])');
    const textarea = ctx.run("document.getElementById('input-persistent')");
    assert.ok(textarea, 'persistent composer textarea should exist after first render');

    // 普通文本 lease 仍可用于 actions / rollback，但不再接管发言输入面。
    ctx.state.requests = [{ requestId: 'r1', placeholder: 'Answer me' }];
    ctx.currentInputRequests = ctx.state.requests;
    // 文本 lease 不改变 persistent 签名：声明后由渲染器去重，不重渲染。
    ctx.run('renderInputRequests(currentInputRequests)');

    assert.equal(ctx.run("document.getElementById('input-persistent')"), textarea,
      'pending text lease must leave the persistent composer mounted');
    assert.equal(ctx.run("document.getElementById('input-r1')"), null,
      'pending text lease must not create a request-bound text endpoint');
    assert.equal(textarea.closest('[data-persistent-composer]').dataset.composerMode, 'persistent');
  }));

  it('hides (but keeps) the composer in hidden/readonly/compacting modes and reuses it after', () => withInputCase((ctx) => {
    ctx.run('renderInputRequests([])');
    const cardA = ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]')",
    );
    assert.ok(cardA);

    // 离开输入面（非 chat surface）→ composer 隐藏但节点保留
    ctx.isChatSurfaceActive = () => false;
    ctx.run('renderInputRequests([])');
    assert.equal(ctx.run("document.getElementById('user-input-container').children.length > 0"), true,
      'composer element stays mounted while hidden');
    assert.equal(ctx.run("document.getElementById('user-input-container').querySelector('[data-persistent-composer]')"), cardA);

    // 回到 chat surface → 同一节点重新显示
    ctx.isChatSurfaceActive = () => true;
    ctx.run('renderInputRequests([])');
    assert.equal(ctx.run("document.getElementById('user-input-container').querySelector('[data-persistent-composer]')"), cardA);
  }));
});

// ── 回归：容器遭外部清空的异常路径下 composer 单例被 detach（模块单例仍
//    持有引用，parentNode 已断），此后 renderInputRequests 转入 readonly /
//    compacting 分支时，安全插入 helper 必须回落为 appendChild，不得抛
//    NotFoundError。历史上该路径由回退对话框的 container.innerHTML 清空触
//    发；交互弹窗解耦后正常路径不再清空容器，防御保留为通用安全。

describe('transient card insertion vs detached composer singleton (ticket 036 regression)', () => {
  function detachComposerSimulatingContainerWipe(ctx) {
    ctx.run(`
      const c = document.getElementById('user-input-container');
      const composer = c.querySelector('[data-persistent-composer]');
      c.removeChild(composer);
    `);
  }

  it('renders the readonly card without throwing after the composer is detached', () => withInputCase((ctx) => {
    ctx.run('renderInputRequests([])');
    assert.ok(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]')",
    ));
    // 异常路径：容器被清空（composer detach，模块单例仍持有引用）
    detachComposerSimulatingContainerWipe(ctx);

    // 此后转入远程只读会话：renderInputRequests 以 readonly 模式运行
    // （触发路径：detach → readonly）
    ctx.readOnlyMode = true;
    ctx.run('renderInputRequests([])');
    const readonlyCard = ctx.run(
      "document.getElementById('user-input-container').querySelector('.user-input-card')",
    );
    assert.ok(readonlyCard, 'readonly hint card renders without throwing');
    assert.match(readonlyCard.innerHTML, /disabled/, 'readonly textarea stays disabled');
    // detached 的 composer 单例不得被误挂回容器
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]')",
    ), null);
  }));

  it('renders the compacting card without throwing after the composer is detached', () => withInputCase((ctx) => {
    ctx.run('renderInputRequests([])');
    detachComposerSimulatingContainerWipe(ctx);

    // 会话内压缩 in-flight（发起 runtime 匹配）→ compacting 分支
    ctx._partialCompactInFlight = true;
    ctx._partialCompactRuntimeId = 'agent-1';
    ctx.run('renderInputRequests([])');
    const compactCard = ctx.run(
      "document.getElementById('user-input-container').querySelector('.partial-compact-card')",
    );
    assert.ok(compactCard, 'compacting status card renders without throwing');
    // 压缩计时器不悬挂（mini DOM 下 elapsedEl 不存在 → 立即自清，此处兜底）
    ctx.run('if (_compactTimerInterval) clearInterval(_compactTimerInterval)');
  }));
});

// ── 用例 2：会话切换草稿保存/恢复不串 + 提交后草稿键删除 ───────────────────

describe('composer session draft isolation (ticket 036)', () => {
  it('saves/restores drafts per sessionKey and never mixes sessions', () => withInputCase((ctx) => {
    ctx.run('renderInputRequests([])');
    const ta = ctx.run("document.getElementById('input-persistent')");
    assert.equal(ta.dataset.sessionKey, 'session-a');

    // 会话 A 打字 → oninput 实时写草稿缓存
    ta.value = 'hello session a';
    ctx.run('_cacheSessionInput(document.getElementById("input-persistent"))');
    assert.equal(ctx.run(`_sessionInputCache['session-a']`), 'hello session a');

    // 切换会话 B：旧 key 保存、新 key 无草稿 → 输入框清空（不串）
    ctx.state.liveKey = 'session-b';
    ctx.currentRuntimeAgentId = 'agent-2';
    ctx.__syncInputIdentity();
    ctx.__syncInputIdentity();
    renderInputSurface(ctx);
    assert.equal(ta.dataset.sessionKey, 'session-b');
    assert.equal(ta.value, '', 'new session without a draft must start empty');
    assert.equal(ctx.run(`_sessionInputCache['session-a']`), 'hello session a');

    // 会话 B 打字
    ta.value = 'world b';
    ctx.run('_cacheSessionInput(document.getElementById("input-persistent"))');
    assert.equal(ctx.run(`_sessionInputCache['session-b']`), 'world b');

    // 切回会话 A：恢复 A 的草稿，绝不串入 B 的文本
    ctx.state.liveKey = 'session-a';
    ctx.currentRuntimeAgentId = 'agent-1';
    ctx.__syncInputIdentity();
    renderInputSurface(ctx);
    const taRestore = ctx.run("document.getElementById('input-persistent')");
    assert.equal(taRestore.value, 'hello session a');
  }));

  it('routes the send button through pending prompt activation', () => withInputCase((ctx) => {
    const calls = [];
    ctx.window.ClawSlash = {
      submitWithPendingPrompts: (textarea, submit) => {
        calls.push({ textarea, submit });
      },
    };
    ctx.run('renderInputRequests([])');
    const textarea = ctx.run("document.getElementById('input-persistent')");
    const sendButton = ctx.run("document.getElementById('persistent-action-btn')");
    sendButton.onclick();
    assert.equal(calls.length, 1, 'send button delegates through prompt activation');
    assert.equal(calls[0].textarea, textarea);
    assert.equal(typeof calls[0].submit, 'function');

    // 待应答 lease 在场时发送按钮仍是同一枚、同一路径：不做端点绑定切换。
    renderInputSurfaceWithLease(ctx, { requestId: 'r1' });
    const requestButton = ctx.run("document.querySelector('.persistent-action-btn')");
    requestButton.onclick();
    assert.equal(calls.length, 2, 'request send button delegates through the same prompt activation');
    assert.equal(calls[1].textarea, textarea);
    assert.equal(typeof calls[1].submit, 'function');
  }));

  it('activates pending prompts before invoking the supplied submit path and hands refs to the payload consumer', async () => {
    const invokeCalls = [];
    await withInputEsmCase({
      globals: {
        fetch: slashFetchStub(invokeCalls),
        getCurrentRuntimeRecord: () => ({ id: 'agent-1' }),
        SessionReference: { activeKey: () => 'session-a' },
      },
    }, async ({ c }) => {
      const { ClawSlash, SlashMenu } = await c.load(SLASH_MENU);
      const ta = mountSlashTextarea(c, '/grill-me 请审查方案');
      mountPromptPill(c, SlashMenu, ta, { name: 'skill.grill-me', ref: 'skill.grill-me' }, '/grill-me 请审查方案');
      assert.equal(ta.value, '请审查方案', '选中 prompt 命令只消费命令段，正文保留');

      let submittedText = null;
      await ClawSlash.submitWithPendingPrompts(ta, async () => {
        submittedText = String(ta.value);
      });
      assert.equal(submittedText, '/grill-me 请审查方案');
      assert.deepEqual([...ClawSlash.consumeActivations()], ['skill.grill-me']);
      assert.deepEqual(invokeCalls, ['skill.grill-me'], '激活走真实 capability_invoke 投递');
      assert.equal(c.read("document.getElementById('slash-prompt-bar')"), null, '激活成功后 pill 消费清空');
    });
  });

  it('rebinds the slash prompt pill bar on session switch only', () => withInputCase((ctx) => {
    let rebound = 0;
    ctx.window.ClawSlash = { rebindSession: () => { rebound += 1; } };

    // 先以会话 A 挂载 composer（首次挂载无会话切换）
    ctx.run('renderInputRequests([])');
    assert.equal(rebound, 0);

    // 会话 A → B：sessionKey 变化触发附件态收敛（pill bar 按新会话桶重渲染）
    ctx.state.liveKey = 'session-b';
    ctx.currentRuntimeAgentId = 'agent-2';
    renderInputSurface(ctx);
    assert.equal(rebound, 1, '会话切换必须重绑 slash prompt pill bar');

    // 同会话的重渲染（lease 到达后清除 + 只读面往返）不重复重绑
    renderInputSurfaceWithLease(ctx, { requestId: 'r1', placeholder: 'Answer me' });
    ctx.readOnlyMode = true;
    ctx.run('renderInputRequests([])');
    ctx.readOnlyMode = false;
    ctx.run('renderInputRequests([])');
    assert.equal(rebound, 1, '同会话的重渲染不得触发 pill bar 重绑');
  }));

  it('deletes the draft key after a successful persistent submit', () => withInputCase(async (ctx) => {
    ctx.run('renderInputRequests([])');
    ctx.run(`
      const ta = document.getElementById('input-persistent');
      ta.value = 'send me';
      _cacheSessionInput(ta);
    `);
    // 真实提交路径（persistent-input.js，P4 输入面批次起是 ESM）：经桥键调用与
    // classic 消费方同一条入口；网络面由主 realm 的 fetch 桩接管（模块裸引用）。
    const fetchCalls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      return { ok: true, status: 200, json: async () => ({ delivery: 'direct' }) };
    };
    try {
      await ctx.run('submitQueuedInput()');
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(fetchCalls.length, 1, 'exactly one user-turn POST');
    assert.equal(fetchCalls[0].url, '/api/agents/agent-1/user-turn');
    assert.equal(JSON.parse(fetchCalls[0].opts.body).text, 'send me');
    // 提交成功：草稿键删除（已发送文本不得经草稿写回"复活"）
    assert.equal(ctx.run(`Object.prototype.hasOwnProperty.call(_sessionInputCache, 'session-a')`), false);
  }));
});

// ── slash prompt pill 会话隔离：pill 按会话 key 分桶（附件类会话态同链路）──
// pill 挂载 / 切换 / 提交三时刻读同一 key 源（window.SessionReference.activeKey，
// 测试中与 composer 会话 key 同源对齐）。会话 A 挂的 pill 不被会话 B 的发送
// 消费，切回 A 恢复显示；提交锚定提交时刻的会话，await 期间切会话不误投。

describe('slash prompt pill session isolation (attachment buckets per session)', () => {
  const PILL_CMD = { name: 'skill.grill-me', ref: 'skill.grill-me' };

  function mountComposer(c) {
    c.read('renderInputRequests([])');
    return c.read("document.getElementById('input-persistent')");
  }

  function switchSession(c, state, liveKey, runtimeId) {
    state.liveKey = liveKey;
    c.window.currentRuntimeAgentId = runtimeId;
    c.window.__syncInputIdentity();
    c.read('currentInputRequests = []; renderInputRequests([])');
  }

  // pill 条目的短名清单（`/grill-me` → 'grill-me'）：既证明条数，也证明恢复/
  // 保留的是哪一条命令（单看条数无法区分命令身份）。
  const pillLabels = (c) => {
    const bar = c.document.getElementById('slash-prompt-bar');
    if (!bar) return null;
    return [...String(bar.innerHTML).matchAll(/slash-prompt-pill-name">\/([^<]+)</g)].map((m) => m[1]);
  };
  const pillNames = (c) => {
    const labels = pillLabels(c);
    return labels === null ? null : labels.length;
  };

  it('keeps pills per session: no carry-over on switch, restored on switch back', async () => {
    const invokeCalls = [];
    await withInputEsmCase({
      globals: (state) => ({
        fetch: slashFetchStub(invokeCalls),
        ...slashTargetGlobals(),
        // pill 桶 key 与 composer 会话 key 同源（生产中 activeKey 是附件类
        // 会话态的权威判定，测试里对齐 liveKey 使两条链路同帧驱动）
        SessionReference: { activeKey: () => state.liveKey },
      }),
    }, async ({ c, state }) => {
      const { ClawSlash, SlashMenu } = await c.load(SLASH_MENU);
      const ta = mountComposer(c);
      assert.equal(ta.dataset.sessionKey, 'session-a');

      // 会话 A：经菜单公开链路选中 prompt 命令挂 pill
      mountPromptPill(c, SlashMenu, ta, PILL_CMD);
      const barInA = c.document.getElementById('slash-prompt-bar');
      assert.ok(barInA, '会话 A 挂 pill 后 pill bar 渲染');
      assert.match(String(barInA.innerHTML), /grill-me/);

      // 会话 B：bar 移除（B 无 pill），A 的 pill 不残留、不参与 B 的发送
      switchSession(c, state, 'session-b', 'agent-2');
      assert.equal(c.document.getElementById('slash-prompt-bar'), null, '会话 B 不得残留 A 的 pill');

      const taB = mountComposer(c);
      taB.value = 'hello from b';
      let submittedB = false;
      await ClawSlash.submitWithPendingPrompts(taB, async () => { submittedB = true; });
      assert.equal(submittedB, true, 'B 无 pill：发送照常');
      assert.equal(taB.value, 'hello from b', 'B 的消息文本不加命令前缀');
      assert.deepEqual(invokeCalls, [], 'B 的发送不得 invoke A 的 pill');
      assert.equal(ClawSlash.consumeActivations(), null, 'B 的发送不携带激活 refs');

      // 切回会话 A：pill 恢复显示（回归点：切会话即清空的旧行为导致丢失）
      switchSession(c, state, 'session-a', 'agent-1');
      assert.equal(pillNames(c), 1, '切回会话 A 后 pill 必须恢复显示');
      assert.deepEqual(pillLabels(c), ['grill-me'], '恢复的是会话 A 原来那条 pill（命令身份不变）');

      // A 内提交：invoke 只针对 A 的 pill，refs 移交，A 桶消费清空
      const taA = c.read("document.getElementById('input-persistent')");
      taA.value = '请审查方案';
      let submittedText = null;
      await ClawSlash.submitWithPendingPrompts(taA, async () => { submittedText = String(taA.value); });
      assert.equal(submittedText, '/grill-me 请审查方案');
      assert.deepEqual([...ClawSlash.consumeActivations()], ['skill.grill-me']);
      assert.deepEqual(invokeCalls, ['skill.grill-me'], 'A 的提交只 invoke A 的 pill');
      assert.equal(pillNames(c), null, '提交成功后 A 桶清空、bar 移除');
    });
  });

  it('submit is pinned to its session: mid-flight switch keeps pills in the original bucket and never submits', async () => {
    const invokeCalls = [];
    const calls = { count: 0 };
    await withInputEsmCase({
      globals: (state) => ({
        // 第一次 invoke 期间切走会话：模拟 await 窗口内的会话切换
        fetch: async (url, options = {}) => {
          if (String(url) === '/protoclaw/capability_invoke') {
            calls.count += 1;
            invokeCalls.push(JSON.parse(options.body || '{}').ref);
            if (calls.count === 1) { state.liveKey = 'session-b'; state.syncIdentity(); }
            return { ok: true, status: 200, json: async () => ({ ok: true, result: 'ok' }) };
          }
          return { ok: true, status: 200, json: async () => ({ ok: true, commands: [] }) };
        },
        ...slashTargetGlobals(),
        SessionReference: { activeKey: () => state.liveKey },
      }),
    }, async ({ c, state }) => {
      const { ClawSlash, SlashMenu } = await c.load(SLASH_MENU);
      const ta = mountComposer(c);
      mountPromptPill(c, SlashMenu, ta, PILL_CMD);
      mountPromptPill(c, SlashMenu, ta, { name: 'skill.some-other', ref: 'skill.some-other' });
      assert.equal(pillNames(c), 2);
      assert.deepEqual(pillLabels(c), ['grill-me', 'some-other'], '两条 pill 的身份与挂载顺序');

      ta.value = 'A 的消息';
      let submitted = false;
      await ClawSlash.submitWithPendingPrompts(ta, async () => { submitted = true; });
      assert.deepEqual(invokeCalls, ['skill.grill-me'],
        '切走前的第一次 invoke 已发出，后续 invoke 阻断');
      assert.equal(submitted, false, '会话已切走：A 的消息文本不得投进 B');
      assert.equal(ClawSlash.consumeActivations(), null, '激活 refs 不移交发送管线');

      // 切回 A：两个 pill 都还在原会话桶（切回后仍可发送）
      state.liveKey = 'session-a';
      c.window.currentRuntimeAgentId = 'agent-1';
      c.window.__syncInputIdentity();
      c.read('currentInputRequests = []; renderInputRequests([])');
      assert.equal(pillNames(c), 2, 'pill 留在原会话桶，切回后仍可发送');
      assert.deepEqual(pillLabels(c), ['grill-me', 'some-other'], '原会话桶里的 pill 身份未变');
    });
  });
});

// ── 草稿槽位别名迁移（根治：切回会话后文本"暂时性丢失"）────────────────────
// _getSessionInputCacheKey 在线程目标解析前后产出 thread / session 两种编码，
// 同一会话的草稿会先后落在两个槽位。以下用例镜像 app-main 的键函数形状
// （线程就位 → thread 编码；未就位 → getRuntimeContextKey()），用真实渲染
// 管线（renderInputRequests → syncPersistentComposerSessionCard）驱动。
describe('draft slot alias migration (thread-resolved key flip)', () => {
  // 与 pill describe 同形的两个驱动帮助（作用域内自备，不跨 describe 共享）
  function mountComposer(c) {
    c.read('renderInputRequests([])');
    return c.read("document.getElementById('input-persistent')");
  }

  function switchSession(c, state, liveKey, runtimeId) {
    state.liveKey = liveKey;
    c.window.currentRuntimeAgentId = runtimeId;
    c.window.__syncInputIdentity();
    c.read('currentInputRequests = []; renderInputRequests([])');
  }

  // 生产形状的会话键与线程目标（覆盖 baseGlobals 的扁平桩，两个状态由
  // state.threadResolved / state.threadId 驱动，与切换窗口的真实时序同构）。
  function mountThreadAwareKeyStub(c, state) {
    c.window.focusedAgentId = 'host-1'; // 让 getRuntimeContextKey 产出 host:…|session:… 格式（会话间可区分）
    c.window.getActiveThreadInputTarget = () => (state.threadResolved
      ? { threadId: state.threadId, sessionId: state.liveKey }
      : null);
    c.window._getSessionInputCacheKey = () => (state.threadResolved
      ? `thread:${state.threadId}`
      : c.window.getRuntimeContextKey());
  }

  it('keeps the draft through the thread-resolved key migration and merges to a single slot', async () => {
    await withInputEsmCase({}, async ({ c, state }) => {
      state.threadId = 'wt-a';
      mountThreadAwareKeyStub(c, state);
      const ta = mountComposer(c);
      // 切换窗口期（线程未就位）：草稿落在 session 编码槽位
      assert.equal(ta.dataset.sessionKey, 'host:host-1|session:session-a');
      ta.value = 'DRAFT-MARK';
      c.window._cacheSessionInput(ta);

      // 线程目标就位后，任一签名变化（如只读态翻转）触发输入面重渲染 →
      // 键迁移。回归点：旧实现恢复 miss 即清空输入框（用户可感知为
      // "药丸还在、文本没了"）；修复后经别名槽位迁移恢复。
      state.threadResolved = true;
      c.read('readOnlyMode = true; renderInputRequests([])');
      assert.equal(ta.dataset.sessionKey, 'thread:wt-a');
      assert.equal(ta.value, 'DRAFT-MARK', '键迁移窗口不得清空草稿');
      assert.equal(c.read("_sessionInputCache['thread:wt-a']"), 'DRAFT-MARK', '草稿迁移到主键槽位');
      assert.equal(c.read("_sessionInputCache['host:host-1|session:session-a']"), undefined,
        '别名槽位合并后删除（单槽不变量）');

      // 线程就位后的同视图重渲染：同 key 幂等 no-op，草稿不动
      c.read('readOnlyMode = false; renderInputRequests([])');
      assert.equal(ta.value, 'DRAFT-MARK');
      assert.equal(c.read("_sessionInputCache['thread:wt-a']"), 'DRAFT-MARK');
    });
  });

  it('restores the draft via the pair memory when returning before the thread target resolves', async () => {
    await withInputEsmCase({}, async ({ c, state }) => {
      state.threadId = 'wt-a';
      mountThreadAwareKeyStub(c, state);
      const ta = mountComposer(c);
      ta.value = 'DRAFT-MARK';
      c.window._cacheSessionInput(ta);

      // 会话 A 停留期线程就位 → 键迁移到 thread 编码（配对记忆在此建立）
      state.threadResolved = true;
      c.read('readOnlyMode = true; renderInputRequests([])');
      assert.equal(ta.dataset.sessionKey, 'thread:wt-a');

      // 切到会话 B（独立会话，无线程目标）再切回 A：切回瞬间线程目标未就位，
      // 草稿在 thread 槽位——配对记忆反查别名，不得清空
      state.threadResolved = false;
      switchSession(c, state, 'session-b', 'agent-2');
      const taB = mountComposer(c);
      assert.equal(taB.value, '', '会话 B 无草稿：切换后从空开始（会话隔离）');
      taB.value = 'B draft';
      c.window._cacheSessionInput(taB);

      switchSession(c, state, 'session-a', 'agent-1');
      const taA = c.read("document.getElementById('input-persistent')");
      assert.equal(taA.dataset.sessionKey, 'host:host-1|session:session-a');
      assert.equal(taA.value, 'DRAFT-MARK', '回程窗口（线程未就位）经配对记忆恢复，不得清空');
      assert.equal(c.read("_sessionInputCache['host:host-1|session:session-a']"), 'DRAFT-MARK',
        '迁移后单槽在 session 主键');
      assert.equal(c.read("_sessionInputCache['thread:wt-a']"), undefined, 'thread 槽位合并后删除');
      assert.equal(c.read("_sessionInputCache['host:host-1|session:session-b']"), 'B draft',
        '会话 B 的草稿不受 A 的别名迁移影响');
    });
  });

  it('keeps miss semantics: empty alias slot fabricates no draft', async () => {
    await withInputEsmCase({}, async ({ c, state }) => {
      state.threadId = 'wt-x';
      state.threadResolved = true;
      mountThreadAwareKeyStub(c, state);
      const composer = await c.load('public/src/modules/input-composer.js');
      const ta = mountComposer(c); // 挂载时线程已就位：dataset 即 thread 主键
      assert.equal(ta.dataset.sessionKey, 'thread:wt-x');
      assert.equal(composer._hasSessionInputDraft('thread:wt-x'), false, '两槽皆空：hasDraft 为假');
      assert.equal(composer._restoreSessionInputDraft(ta, 'thread:wt-x'), false, '两槽皆空：恢复仍 miss');

      // 别名槽位持有空字符串：可迁移（string 契约），但语义等价于无草稿
      c.read("_sessionInputCache['host:host-1|session:session-a'] = ''");
      assert.equal(composer._hasSessionInputDraft('thread:wt-x'), false, '空串别名不算草稿');
      assert.equal(composer._restoreSessionInputDraft(ta, 'thread:wt-x'), true, '空串是合法槽位值：迁移成立');
      assert.equal(ta.value, '', '恢复出的内容为空（与清空等价，不伪造内容）');
    });
  });

  it('hasSessionInputDraft recognizes a draft sitting in the alias slot (both directions)', async () => {
    await withInputEsmCase({}, async ({ c, state }) => {
      state.threadId = 'wt-a';
      state.threadResolved = true;
      mountThreadAwareKeyStub(c, state);
      const composer = await c.load('public/src/modules/input-composer.js');
      mountComposer(c);
      // 桥键就位（input-render 的 lease 回填 hasDraft 判定经它取别名）
      assert.equal(typeof c.window._hasSessionInputDraft, 'function');

      // 正向：主键 thread 编码空，session 别名槽位有草稿（键迁移前的窗口）
      c.read("_sessionInputCache['host:host-1|session:session-a'] = 'DRAFT'");
      assert.equal(composer._hasSessionInputDraft('thread:wt-a'), true);
      // 反向：主键 session 编码空，草稿在配对记忆指向的 thread 槽位
      c.read("delete _sessionInputCache['host:host-1|session:session-a']");
      c.read("_sessionInputCache['thread:wt-a'] = 'DRAFT'");
      state.threadResolved = false;
      assert.equal(composer._hasSessionInputDraft('host:host-1|session:session-a'), true);
      // 无配对记忆的 session（会话 B）不误报
      assert.equal(composer._hasSessionInputDraft('host:host-1|session:session-b'), false);
    });
  });
});

// ── 用例 3：草稿迁移后 voice-input.js 的 re-export 与既有引用零行为变化 ─────

describe('draft cache migration compatibility (ticket 036)', () => {
  // voice-input 已迁 ESM（P4 L3）：跨会话发送失败的消费路径改真实 import；
  // 草稿缓存本体仍是 input-composer.js（classic 相桥键 `_sessionInputCache`），
  // 两个方向的读写落在同一份缓存上——这正是本用例钉住的兼容面。
  it('keeps voice-input.js consumers working against the composer-owned cache', async () => {
    const toasts = [];
    await withP2EsmCase({
      classic: prepareClassicSandbox,
    }, async (c) => {
      // composer（P4 输入面批次起是 ESM）：桥键 `_sessionInputCache` 由它注册
      await c.load('public/src/modules/input-composer.js');
      const voiceInput = await c.load('public/src/modules/voice-input.js');
      // toast-notify 在自己的模块求值时挂 window.ClawToast，桩在装载之后覆盖。
      c.window.ClawToast = { show: (value) => toasts.push(value) };

      // 既有引用零行为变化：发送失败把全文回滚到 composer 拥有的草稿缓存
      voiceInput._restoreCrossSessionVoiceInput('session-a', 'typed and spoken', 'agent-a', 'runtime unavailable');
      assert.equal(c.read(`_sessionInputCache['session-a']`), 'typed and spoken');
      assert.equal(toasts.length, 1);
      assert.equal(toasts[0].status, 'error');

      // 语音 onstop 自动发送路径按同一份缓存读取（拼接原会话草稿 + 转写文本）
      c.read(`_cacheSessionInput({ dataset: { sessionKey: 'session-b' }, value: 'typed ' })`);
      assert.equal(c.read(`_sessionInputCache['session-b']`), 'typed ');
      // 迁移后 voice-input.js 不再拥有缓存状态：消费方解析到 composer 绑定
      c.read(`delete _sessionInputCache['session-b']`);
      assert.equal(c.read(`_sessionInputCache['session-b']`), undefined);
    });
  });
});

// ── 用例 4：模式判定九级优先级矩阵（行为契约 §3）纯函数锁死 ─────────────────
// 判定函数随 input-composer 迁 ESM（P4 输入面批次）：真实 import 后直接调用导出，
// 纯函数用例不再经沙箱求值。

const PERSISTENT_INPUT = 'public/src/modules/persistent-input.js';
const INPUT_COMPOSER = 'public/src/modules/input-composer.js';

/** 输入面实现的裸图选项：只需内核桥 + 静态依赖的 classic 宿主工厂。 */
function inputModuleCaseOptions(label) {
  return {
    label,
    classic: (sandbox) => { sandbox.loadSource('public/src/modules/kernel-state.js'); },
    globals: {
      // 分发器公开面（生产由 public/src/modules/action-dispatcher.js 提供）：
      // 输入面模块在装载期注册 composer.* 动作。
      ClawFW: { actions: { registerMany() {}, register() {}, bindEventType() {} } },
      createSessionViewCommitHost: () => ({
        identity: () => null,
        read: () => ({}),
        apply: () => {},
        normalizeModel: () => ({}),
      }),
      createP2BootstrapCallActivityHost: () => ({ _agentCallActive: new Map() }),
      // P4 T2 尾批：sidebar-render 迁 ESM 后其模块求值期读 domRefs 的侧栏容器。
      createP2BootstrapDomHost: () => {
        const el = () => createMiniDocument().createElement('div');
        return {
          agentList: el(), externalAgentList: el(), externalGroup: el(),
          externalCount: el(), currentAgentTitle: el(), container: el(),
        };
      },
      createPollCoordinatorHost: () => ({}),
    },
  };
}

describe('input surface mode matrix (contract §3, ticket 036)', () => {
  const baseState = {
    chatActive: true,
    readOnlyMode: false,
    rollbackDialogOpen: false,
    compactInFlight: false,
    compactRuntimeMatches: false,
    hasRuntimeSelected: false,
    hasChoiceRequest: false,
    hasLocalQueuedInput: false,
  };

  const withModeCase = (fn) => withP2EsmCase(inputModuleCaseOptions('mode-matrix'), async (c) => {
    const composer = await c.load(INPUT_COMPOSER);
    return fn(composer, c);
  });

  it('locks the nine-level priority matrix', () => withModeCase(async (composer) => {
    const resolve = (state) => composer.resolveInputSurfaceMode(state);
    // 级 1：非 chat surface → hidden（无论其他状态）
    assert.equal(resolve({ ...baseState, chatActive: false, hasRuntimeSelected: true, readOnlyMode: true }), 'hidden');
    // 级 2：只读是明确的只读提示面
    assert.equal(resolve({ ...baseState, readOnlyMode: true, hasRequests: true }), 'readonly');
    // 级 3：回退对话框接管 → 冻结（优先于压缩与请求卡）
    assert.equal(resolve({ ...baseState, rollbackDialogOpen: true, compactInFlight: true, compactRuntimeMatches: true, hasChoiceRequest: true }), 'frozen');
    // 级 4：压缩 in-flight（仅发起 runtime）
    assert.equal(resolve({ ...baseState, compactInFlight: true, compactRuntimeMatches: true, hasChoiceRequest: true, hasRequests: true }), 'compacting');
    // 级 4 仅对发起 runtime 生效：runtime 不匹配时落回后续级别
    assert.equal(resolve({ ...baseState, compactInFlight: true, compactRuntimeMatches: false, hasRuntimeSelected: true }), 'persistent');
    // 级 5：choice 请求优先于本地排队
    assert.equal(resolve({ ...baseState, hasChoiceRequest: true, hasLocalQueuedInput: true, hasRequests: true }), 'choice');
    // 级 6：本地排队乐观态优先于请求卡
    assert.equal(resolve({ ...baseState, hasLocalQueuedInput: true, hasRequests: true }), 'persistent');
    // 非 choice 文本 lease 不再改变输入面：有无 lease 都是 persistent
    assert.equal(resolve({ ...baseState, hasRequests: true, hasRuntimeSelected: true }), 'persistent');
    // choice 请求仍优先接管输入面
    assert.equal(resolve({ ...baseState, hasChoiceRequest: true, hasRuntimeSelected: true }), 'choice');
    // 级 8：选中 runtime（calling / idle 同为 persistent）
    assert.equal(resolve({ ...baseState, hasRuntimeSelected: true }), 'persistent');
    // 级 8：接续等待表面（无 runtime 态，视图挂在等待会话）→ persistent
    //（发送经 Thread Inbox 暂存，composer 必须在场——挂起≠消失）
    assert.equal(resolve({ ...baseState, hasThreadAwaitTarget: true }), 'persistent');
    // 级 9：都不满足 → hidden
    assert.equal(resolve({ ...baseState }), 'hidden');
  }));

  it('readInputSurfaceModeState derives hasThreadAwaitTarget from the consistency-checked thread target', () => withModeCase(async (composer, c) => {
    const orchestration = await c.load('public/src/modules/orchestration-state.js');
    c.window.getActiveThreadInputTarget = () => ({ threadId: 'wt-1', sessionId: 's1' });
    // runtime 态在场：等待目标不参与（矩阵级 8 由 runtime 放行）
    orchestration.setCurrentRuntimeAgentId('rt-1');
    assert.equal(composer.readInputSurfaceModeState([], true).hasRuntimeSelected, true);
    assert.equal(composer.readInputSurfaceModeState([], true).hasThreadAwaitTarget, false);
    // runtime 态为空 + 一致性校验命中的等待会话：等待目标成立
    orchestration.setCurrentRuntimeAgentId(null);
    assert.equal(composer.readInputSurfaceModeState([], true).hasThreadAwaitTarget, true);
    assert.equal(composer.resolveInputSurfaceMode(composer.readInputSurfaceModeState([], true)), 'persistent');
    // 校验未命中（用户切走 / 残留清理）→ 回到 hidden
    c.window.getActiveThreadInputTarget = () => null;
    assert.equal(composer.readInputSurfaceModeState([], true).hasThreadAwaitTarget, false);
    assert.equal(composer.resolveInputSurfaceMode(composer.readInputSurfaceModeState([], true)), 'hidden');
  }));
});

// ── 图片附件：转存 await 期间的移除竞态 + 按会话分桶（真实实现）─────────────
// persistent-input 迁 ESM 后不再按源码切片重放：两个用例直接驱动真实
// `_resolvePendingImagesForTarget` / `clearPendingInputImages`，网络面用可控的
// fetch 桩把「转存请求在途」这一窗口显式打开。

function withImageCase(label, fn) {
  return withP2EsmCase(inputModuleCaseOptions(label), async (c) => {
    const persistent = await c.load(PERSISTENT_INPUT);
    return fn({ c, persistent, seam: persistent.__testInputState });
  });
}

describe('pending image removal race during await (remote image review S1)', () => {
  it('drop removal during the transfer await: removed entry never sent, kept entry always sent', async () => {
    await withImageCase('image-race-drop', async ({ persistent, seam }) => {
      const realFetch = globalThis.fetch;
      let releaseTransfer = null;
      globalThis.fetch = () => new Promise((resolve) => {
        releaseTransfer = () => resolve({ ok: true, status: 200, json: async () => ({ path: '/images/transferred.png' }) });
      });
      try {
        // 目标宿主机是本地：_hostKey 不一致的条目必须转存（走 fetch —— 在途窗口）
        const removed = { source: 'removed', path: '/images/old.png', mediaType: 'image/png', _hostKey: 'remote:conn-1', _uploadPromise: null };
        const kept = { source: 'kept', path: '/images/kept.png', mediaType: 'image/png', _hostKey: 'local', _uploadPromise: null };
        const bucket = seam.imageBucket;
        bucket.push(removed, kept);

        const pending = persistent._resolvePendingImagesForTarget('agent-1', 'default');
        // 等转存请求真正发出，再模拟用户点「移除」（UI 动作 splice 同一个桶）
        await new Promise((resolve) => setTimeout(resolve, 0));
        bucket.splice(bucket.indexOf(removed), 1);
        releaseTransfer();

        const outcome = await pending;
        assert.deepEqual(outcome.images.map((img) => String(img.path)), ['/images/kept.png'],
          'await 期间被移除的附件不得随消息发送');
        assert.equal(outcome.failedCount, 0, '用户主动移除不算上传失败');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });

  it('removal racing a failed transfer: user-removed entry is not counted as failure (review R1)', async () => {
    await withImageCase('image-race-failure', async ({ persistent, seam }) => {
      const realFetch = globalThis.fetch;
      let rejectTransfer = null;
      globalThis.fetch = () => new Promise((_resolve, reject) => {
        rejectTransfer = () => reject(new Error('tunnel reset after removal'));
      });
      try {
        const removed = { source: 'removed', path: '/images/old.png', mediaType: 'image/png', _hostKey: 'remote:conn-1', _uploadPromise: null };
        const kept = { source: 'kept', path: '/images/kept.png', mediaType: 'image/png', _hostKey: 'local', _uploadPromise: null };
        const bucket = seam.imageBucket;
        bucket.push(removed, kept);

        const pending = persistent._resolvePendingImagesForTarget('agent-1', 'default');
        await new Promise((resolve) => setTimeout(resolve, 0));
        bucket.splice(bucket.indexOf(removed), 1);
        rejectTransfer();

        const outcome = await pending;
        assert.deepEqual(outcome.images.map((img) => String(img.path)), ['/images/kept.png'],
          '失败与移除同窗口时，移除者不发送、保留者照常发送');
        assert.equal(outcome.failedCount, 0, '已移除附件的转存失败不得计入 failedCount');
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  });
});

// ── 图片附件会话隔离：按会话 key 分桶，挂载/消费/清空互不串扰 ─────────────
describe('pending image session isolation (attachment buckets per session)', () => {
  it('keeps per-session buckets: no carry-over on switch, clear scoped to the sending session', async () => {
    await withImageCase('image-buckets', async ({ c, persistent, seam }) => {
      let activeKey = 'rt-a::sess-a';
      c.window.SessionReference = { activeKey: () => activeKey };

      const imgA = { source: 'img-a', path: '/images/img-a.png', mediaType: 'image/png', _hostKey: 'local', _uploadPromise: null };
      seam.imageBucket.push(imgA);
      const visibleInA = seam.imageBucket.length;
      // 切换到会话 B：输入框读 B 桶，A 的附件不可见（预览随当前桶渲染）
      activeKey = 'rt-b::sess-b';
      const visibleInB = seam.imageBucket.length;
      seam.imageBucket.push({ source: 'img-b', path: '/images/img-b.png', mediaType: 'image/png', _hostKey: 'local', _uploadPromise: null });
      // 会话 A 发送：resolve / 清空只作用于 A 的桶（发送时刻同步捕获的 key）
      const resolved = await persistent._resolvePendingImagesForTarget('agent-a', 'rt-a::sess-a');
      persistent.clearPendingInputImages('rt-a::sess-a');

      assert.equal(visibleInA, 1, '挂载时刻附件属于挂载会话的桶');
      assert.equal(visibleInB, 0, '切换会话后输入框不得残留上一会话的图片');
      assert.deepEqual(resolved.images.map((img) => String(img.path)), ['/images/img-a.png'], 'resolve 只消费发送会话的桶');
      assert.equal(resolved.failedCount, 0);
      assert.equal((seam.pendingImageBuckets.get('rt-a::sess-a') || []).length, 0, '发送成功的会话桶被清空');
      assert.equal(seam.pendingImageBuckets.get('rt-b::sess-b').length, 1, '其他会话挂载的附件不受发送清空影响');
    });
  });
});

// ── 队列气泡：输入身份过滤 + 会话隔离投影（user-turn kind 适配）──────────

describe('queued-input bubble identity filter (user-turn kind)', () => {
  it('polling snapshot filters reminder items out of bubble texts and count', async () => {
    await withQueueProjectionCase({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ([
          { id: 'q-1', text: '用户消息' },
          { id: 'q-2', text: '面板动作通报', kind: 'reminder' },
          { id: 'q-3', text: '下一条用户消息' },
        ]),
      }),
    }, async ({ projection, queueState }) => {
      await projection._syncPersistentInputUi('agent-1');

      assert.deepEqual([...queueState.queuedTexts], ['用户消息', '下一条用户消息']);
      assert.equal(queueState.pendingQueuedCount, 2, 'reminder 不计入待发送计数');
    });
  });

  it('reminder-only queue keeps bubbles empty and resets local pending state', async () => {
    await withQueueProjectionCase({
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ([{ id: 'q-r', text: '面板动作通报', kind: 'reminder' }]),
      }),
    }, async ({ projection, queueState }) => {
      queueState.setQueuedTexts(['残留乐观文本']);
      queueState.setPendingQueuedCount(1);
      queueState.setLocalQueuedInputPending(true);

      await projection._syncPersistentInputUi('agent-1');

      assert.equal(queueState.queuedTexts.length, 0, '仅 reminder 排队时不显示气泡');
      assert.equal(queueState.pendingQueuedCount, 0);
      assert.equal(queueState.localQueuedInputPending, false, 'reminder 不顶起输入面乐观态');
    });
  });
});

describe('queue bubble projection session isolation', () => {
  it('write guard drops stale snapshots from another runtime', async () => {
    await withQueueProjectionCase({}, async ({ projection, queueState }) => {
      queueState.setQueuedTexts(['当前会话的排队']);
      queueState.setQueuedProjectionRuntimeId('agent-1');
      projection.applyQueuedInputsTexts('agent-9', ['过期快照'], 1);

      assert.deepEqual([...queueState.queuedTexts], ['当前会话的排队'],
        '非当前 runtime 的快照写入直接丢弃');
      assert.equal(String(queueState.queuedProjectionRuntimeId), 'agent-1', '归属不被过期写入改写');
    });
  });

  it('runtime switch rebinds the projection instead of leaking old bubbles', async () => {
    await withQueueProjectionCase({}, async ({ c, projection, queueState }) => {
      queueState.setQueuedTexts(['A 会话的排队文本']);
      queueState.setPendingQueuedCount(1);
      queueState.setLocalQueuedInputPending(true);
      queueState.setQueuedProjectionRuntimeId('agent-1');

      // 切到会话 B：渲染入口先重绑投影，旧会话气泡不进入新会话输入面
      c.window.currentRuntimeAgentId = 'agent-2';
      projection.updateQueueIndicator();

      assert.equal(queueState.queuedTexts.length, 0, '旧会话排队文本被重绑清空');
      assert.equal(queueState.pendingQueuedCount, 0);
      assert.equal(queueState.localQueuedInputPending, false);
      assert.equal(String(queueState.queuedProjectionRuntimeId), 'agent-2');
    });
  });

  it('rebind restores the new session queue from the SSE snapshot cache', async () => {
    // 排队投影已 import sse-client：本 case 里的 window.ClawFW.SseClient 就是真实
    // 传输层命名空间（不再是注入桩）。快照缓存只由 SSE 事件帧填充，这里只把它的
    // 两个读取面换成记录器（IO 边界打桩，与 toast 的 show 同一做法），
    // 驱动的仍是 classic rebind → 命名空间读取这条真实链路。
    await withQueueProjectionCase({}, async ({ c, projection, queueState }) => {
      const namespace = c.window.ClawFW.SseClient;
      const realGetLastQueuedSnapshot = namespace.getLastQueuedSnapshot;
      const realReconcileQueuedTexts = namespace.reconcileQueuedTexts;
      namespace.getLastQueuedSnapshot = (id) => (id === 'agent-2'
        ? { runtimeId: id, items: [{ id: 'q-b', text: 'B 会话的排队' }] }
        : null);
      namespace.reconcileQueuedTexts = (items) => items
        .filter((item) => item?.kind !== 'reminder')
        .map((item) => item.text);
      try {
        queueState.setQueuedTexts(['A 会话的排队文本']);
        queueState.setQueuedProjectionRuntimeId('agent-1');

        c.window.currentRuntimeAgentId = 'agent-2';
        projection.updateQueueIndicator();

        assert.deepEqual([...queueState.queuedTexts], ['B 会话的排队'],
          '切换后从 SSE 快照缓存恢复新会话队列，无需等轮询');
        assert.equal(queueState.pendingQueuedCount, 1);
        assert.equal(String(queueState.queuedProjectionRuntimeId), 'agent-2');
      } finally {
        namespace.getLastQueuedSnapshot = realGetLastQueuedSnapshot;
        namespace.reconcileQueuedTexts = realReconcileQueuedTexts;
      }
    });
  });
});
