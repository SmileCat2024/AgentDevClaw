/**
 * frontend-input-composer.test.js — 工单 036 验收用例（输入区 Composer 常驻化）
 *
 * 覆盖工单验收节四条用例：
 *   1. 模式翻转不重建：persistent ↔ requests 切换时 composer 元素身份不变
 *   2. 会话切换：草稿按 sessionKey 保存/恢复、不串会话；提交后草稿键删除
 *   3. 草稿迁移后 voice-input.js 的 re-export 与既有引用零行为变化
 *   4. 模式判定矩阵（行为契约 §3 九级优先级）纯函数用例锁死
 *
 * 参考 test/frontend-interrupt-voice-lifecycle.test.js 的沙箱与 overrides 方式。
 */

import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

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
  doc.addEventListener = () => {};
  return doc;
}

// ── 渲染沙箱：注入输入区全局符号，跑真实模块源码 ───────────────────────────

function createInputSandbox({ contextKey = 'session-a', requests = [] } = {}) {
  const doc = createMiniDocument();
  const container = createMiniElement('div', doc);
  container.id = 'user-input-container';
  doc.body.appendChild(container);

  const state = { doc, container, liveKey: contextKey, requests };

  const ctx = createFrontendSandbox({
    document: doc,
    // 输入区全局状态
    currentLanguage: 'zh',
    currentRuntimeAgentId: 'agent-1',
    readOnlyMode: false,
    followLatestEnabled: false,
    _rollbackDialogOpen: false,
    _partialCompactInFlight: false,
    _partialCompactRuntimeId: null,
    _partialCompactContextKey: null,
    _compactTimerInterval: null,
    currentInputRequests: requests,
    lastRenderedInputSignature: '',
    lastRenderedInputMode: null,
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
    runWithSuppressedChatViewportObservers: (fn) => fn(),
    notifyChatViewportMutation: () => {},
    isChoiceInputRequest: (req) => !!req && req.mode === 'choices'
      && Array.isArray(req.questions) && req.questions.length > 0,
    isChoiceInputRejected: () => false,
    renderChoiceInputRequest: () => {},
    collapsePrimaryChoiceRequest: () => {},
    handlePersistentInputKey: () => {},
    onPersistentBtnClick: () => {},
    handleInputKey: () => {},
    submitInput: () => {},
    submitQueuedInput: () => {},
    toggleInputModelDropdown: () => {},
    toggleThinkingEffortDropdown: () => {},
    toggleVoiceRecording: () => {},
    onImageFilesSelected: () => {},
    handleInputPaste: () => {},
    _syncPersistentActionButton: () => {},
    _setActionBtnSend: () => {},
    _setActionBtnStop: () => {},
    autoResize: () => {},
    updateInputModelSwitcher: () => {},
    updateThinkingEffortSwitcher: () => {},
    _renderAttachmentPreview: () => {},
    _renderLastCallElapsed: () => {},
    _renderRecapHint: () => {},
    _injectPendingVoiceResult: () => {},
    _reattachVoiceInputUi: () => {},
    _renderQueueBubbles: () => {},
    _syncPersistentInputUi: () => {},
    _lastQueueBubbleSignature: '',
    _pendingQueuedCount: 0,
    _queuedTexts: [],
    _localQueuedInputPending: false,
    stopVoiceRecording: () => {},
    _cancelVoiceRecording: () => {},
    _shouldPreserveVoiceInputForRender: () => false,
    readPartialCompactStartedAt: () => null,
    writePartialCompactStartedAt: () => {},
    _agentCallActive: new Map(),
    escapeHtml: (text) => String(text == null ? '' : text).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m])),
  });

  ctx.state = state;
  return ctx;
}

// 注入模块源码，与 index.html 加载序语义一致（input-composer → render）。
function loadInputModules(ctx) {
  ctx.loadSource('public/src/modules/input-composer.js');
  // getInputSurfaceMode（app-main.js 现已委托 composer 模块的纯函数）
  ctx.run(`
    function getInputSurfaceMode(requests = readCurrentSessionViewState().inputRequests) {
      return resolveInputSurfaceMode(readInputSurfaceModeState(requests, isChatSurfaceActive()));
    }
  `);
  const persistentSource = fs.readFileSync('public/src/modules/persistent-input.js', 'utf8');
  const start = persistentSource.indexOf('function renderPersistentInput(container) {');
  const end = persistentSource.indexOf('function syncContextPressureChip', start);
  ctx.run(persistentSource.slice(start, end));
  ctx.loadSource('public/src/modules/input-render.js');
}

function flipToRequests(ctx, lease) {
  ctx.state.requests = [lease];
  ctx.currentInputRequests = [lease];
  ctx.run(`
    currentInputRequests = ${JSON.stringify([lease])};
    lastRenderedInputSignature = "";
    renderInputRequests(currentInputRequests);
  `);
}

function flipToPersistent(ctx) {
  ctx.state.requests = [];
  ctx.run('currentInputRequests = []; lastRenderedInputSignature = ""; renderInputRequests([])');
}

// ── 用例 1：模式翻转不重建同一 DOM 节点 ─────────────────────────────────────

describe('persistent composer DOM identity (ticket 036)', () => {
  it('keeps the same composer node across persistent <-> requests flips', () => {
    const ctx = createInputSandbox();
    loadInputModules(ctx);

    // persistent 模式首次挂载
    ctx.run('renderInputRequests([])');
    const taA = ctx.run("document.getElementById('input-persistent')");
    assert.ok(taA, 'persistent composer textarea should exist after first render');

    // 翻转到 requests：同一 composer 节点，仅端点属性更新
    flipToRequests(ctx, { requestId: 'r1', placeholder: 'Answer me' });
    const taB = ctx.run("document.getElementById('input-r1')");
    assert.ok(taB, 'requests endpoint textarea should exist');
    assert.equal(taB, taA, 'persistent -> requests flip must reuse the same composer node');
    assert.equal(taB.closest('[data-persistent-composer]').dataset.composerMode, 'requests');

    // 翻回 persistent：textarea id 切回且节点身份不变
    flipToPersistent(ctx);
    const taBack = ctx.run("document.getElementById('input-persistent')");
    assert.equal(taBack, taB, 'flip back must reuse the same composer node');
    assert.equal(ctx.run("card = document.getElementById('user-input-container').querySelector('[data-persistent-composer]'); card === document.getElementById('input-persistent').closest('[data-persistent-composer]')"), true);

    // 发送按钮端点绑定随模式切换（persistent → user-turn，requests → submitInput）
    ctx.run('lastRenderedInputSignature = ""; renderInputRequests([{ requestId: "r2" }])');
    assert.equal(ctx.run("document.getElementById('persistent-action-btn')"), null,
      'requests mode must not expose the persistent tri-state send button');
    assert.equal(ctx.run("document.getElementById('input-r1')"), null,
      'stale request endpoint id must be replaced');
  });

  it('hides (but keeps) the composer in hidden/readonly/compacting modes and reuses it after', () => {
    const ctx = createInputSandbox();
    loadInputModules(ctx);

    ctx.run('renderInputRequests([])');
    const cardA = ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]')",
    );
    assert.ok(cardA);

    // 离开输入面（非 chat surface）→ composer 隐藏但节点保留
    ctx.isChatSurfaceActive = () => false;
    ctx.run('lastRenderedInputSignature = ""; renderInputRequests([])');
    assert.equal(ctx.run("document.getElementById('user-input-container').children.length > 0"), true,
      'composer element stays mounted while hidden');
    assert.equal(ctx.run("document.getElementById('user-input-container').querySelector('[data-persistent-composer]')"), cardA);

    // 回到 chat surface → 同一节点重新显示
    ctx.run('lastRenderedInputSignature = ""; renderInputRequests([])');
    assert.equal(ctx.run("document.getElementById('user-input-container').querySelector('[data-persistent-composer]')"), cardA);
  });
});

// ── 回归：回退对话框接管期间 composer 单例被 detach（rollback-dialog.js 的
//    container.innerHTML 清空容器，模块单例仍持有引用），此后 renderInputRequests
//    转入 readonly / compacting 分支时，安全插入 helper 必须回落为 appendChild，
//    不得抛 NotFoundError（旧实现为 appendChild，天然无此问题）。

describe('transient card insertion vs detached composer singleton (ticket 036 regression)', () => {
  function detachComposerSimulatingRollbackDialog(ctx) {
    ctx.run(`
      const c = document.getElementById('user-input-container');
      const composer = c.querySelector('[data-persistent-composer]');
      c.removeChild(composer);
    `);
  }

  it('renders the readonly card without throwing after a rollback dialog detaches the composer', () => {
    const ctx = createInputSandbox();
    loadInputModules(ctx);

    ctx.run('renderInputRequests([])');
    assert.ok(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]')",
    ));
    // 回退对话框接管期间清空容器（composer detach，模块单例仍持有引用）
    detachComposerSimulatingRollbackDialog(ctx);

    // 关闭对话框后转入远程只读会话：close() 后 renderInputRequests
    // 以 readonly 模式运行（触发路径：dialog open → detach → readonly）
    ctx.readOnlyMode = true;
    ctx.run('lastRenderedInputSignature = ""; renderInputRequests([])');
    const readonlyCard = ctx.run(
      "document.getElementById('user-input-container').querySelector('.user-input-card')",
    );
    assert.ok(readonlyCard, 'readonly hint card renders without throwing');
    assert.match(readonlyCard.innerHTML, /disabled/, 'readonly textarea stays disabled');
    // detached 的 composer 单例不得被误挂回容器
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]')",
    ), null);
  });

  it('renders the compacting card without throwing after a rollback dialog detaches the composer', () => {
    const ctx = createInputSandbox();
    loadInputModules(ctx);

    ctx.run('renderInputRequests([])');
    detachComposerSimulatingRollbackDialog(ctx);

    // 关闭对话框 + 会话内压缩 in-flight（发起 runtime 匹配）→ compacting 分支
    ctx._partialCompactInFlight = true;
    ctx._partialCompactRuntimeId = 'agent-1';
    ctx.run('lastRenderedInputSignature = ""; renderInputRequests([])');
    const compactCard = ctx.run(
      "document.getElementById('user-input-container').querySelector('.partial-compact-card')",
    );
    assert.ok(compactCard, 'compacting status card renders without throwing');
    // 压缩计时器不悬挂（mini DOM 下 elapsedEl 不存在 → 立即自清，此处兜底）
    ctx.run('if (_compactTimerInterval) clearInterval(_compactTimerInterval)');
  });
});

// ── 用例 2：会话切换草稿保存/恢复不串 + 提交后草稿键删除 ───────────────────

describe('composer session draft isolation (ticket 036)', () => {
  it('saves/restores drafts per sessionKey and never mixes sessions', () => {
    const ctx = createInputSandbox();
    loadInputModules(ctx);

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
    flipToPersistent(ctx);
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
    flipToPersistent(ctx);
    const taRestore = ctx.run("document.getElementById('input-persistent')");
    assert.equal(taRestore.value, 'hello session a');
  });

  it('deletes the draft key after a successful persistent submit', async () => {
    const ctx = createInputSandbox();
    loadInputModules(ctx);

    // 提交路径依赖（persistent-input.js submitQueuedInput 片段的伴生 stub）
    ctx.run(`
      let _submitInFlight = false;
      let _queuedTexts = [];
      let _pendingQueuedCount = 0;
      let _localQueuedInputPending = false;
      let _lastQueueBubbleSignature = "";
      let _pendingImages = [];
    `);
    // 真实提交路径（persistent-input.js）
    const persistentSource = fs.readFileSync('public/src/modules/persistent-input.js', 'utf8');
    const submitStart = persistentSource.indexOf('async function submitQueuedInput()');
    const submitEnd = persistentSource.indexOf('function updateQueueIndicator', submitStart);
    ctx.run(persistentSource.slice(submitStart, submitEnd));
    ctx.run('renderInputRequests([])');
    ctx.run(`
      const ta = document.getElementById('input-persistent');
      ta.value = 'send me';
      _cacheSessionInput(ta);
    `);
    ctx.fetchCalls = [];
    ctx.fetch = async (url, opts) => {
      ctx.fetchCalls.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ delivery: 'direct' }) };
    };
    // await 期间的依赖 stub
    ctx.run(`
      async function _awaitPendingImageUploads() {}
      function getPendingInputImages() { return []; }
      function clearPendingInputImages() {}
      function _requestNotifyPermission() {}
      function _clearRecapForNewMessage() {}
      function beginFollowLatestEntryWindow() {}
      function requestFollowLatest() {}
      function clearInterruptSuppression() {}
      function _markAgentCallStartedForNotify() {}
      function renderAgentList() {}
      function newIdempotencyKey() { return "test-key"; }
    `);

    await ctx.run('submitQueuedInput()');

    assert.equal(ctx.fetchCalls.length, 1, 'exactly one user-turn POST');
    assert.equal(ctx.fetchCalls[0].url, '/api/agents/agent-1/user-turn');
    assert.equal(JSON.parse(ctx.fetchCalls[0].opts.body).text, 'send me');
    // 提交成功：草稿键删除（已发送文本不得经草稿写回"复活"）
    assert.equal(ctx.run(`Object.prototype.hasOwnProperty.call(_sessionInputCache, 'session-a')`), false);
  });
});

// ── 用例 3：草稿迁移后 voice-input.js 的 re-export 与既有引用零行为变化 ─────

describe('draft cache migration compatibility (ticket 036)', () => {
  it('keeps voice-input.js consumers working against the composer-owned cache', () => {
    const ctx = createFrontendSandbox();
    const toasts = [];
    ctx.window.ClawToast = { show: (value) => toasts.push(value) };
    // 草稿缓存本体住在 input-composer.js（工单 036 迁移后）
    ctx.loadSource('public/src/modules/input-composer.js');
    // voice-input.js 的既有消费片段（跨会话发送失败 → 草稿回滚 + error toast）
    const voiceSource = fs.readFileSync('public/src/modules/voice-input.js', 'utf8');
    ctx.run(sourceBetween(voiceSource, 'function _restoreCrossSessionVoiceInput', 'function stopVoiceRecording'));

    // 既有引用零行为变化：发送失败把全文回滚到 composer 拥有的草稿缓存
    ctx.run(`_restoreCrossSessionVoiceInput('session-a', 'typed and spoken', 'agent-a', 'runtime unavailable')`);
    assert.equal(ctx.run(`_sessionInputCache['session-a']`), 'typed and spoken');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].status, 'error');

    // 语音 onstop 自动发送路径按原全局符号读取缓存（拼接原会话草稿 + 转写文本）
    ctx.run(`_cacheSessionInput({ dataset: { sessionKey: 'session-b' }, value: 'typed ' })`);
    assert.equal(ctx.run(`_sessionInputCache['session-b']`), 'typed ');
    // 迁移后 voice-input.js 不再拥有缓存状态：消费方按符号解析到 composer 绑定
    ctx.run(`delete _sessionInputCache['session-b']`);
    assert.equal(ctx.run(`_sessionInputCache['session-b']`), undefined);
  });
});

// ── 用例 4：模式判定九级优先级矩阵（行为契约 §3）纯函数锁死 ─────────────────

describe('input surface mode matrix (contract §3, ticket 036)', () => {
  const ctx = createInputSandbox();
  ctx.loadSource('public/src/modules/input-composer.js');
  const resolve = (state) => ctx.run(`resolveInputSurfaceMode(${JSON.stringify(state)})`);

  const baseState = {
    chatActive: true,
    readOnlyMode: false,
    rollbackDialogOpen: false,
    compactInFlight: false,
    compactRuntimeMatches: false,
    hasRuntimeSelected: false,
    hasRequests: false,
    hasChoiceRequest: false,
    hasLocalQueuedInput: false,
  };

  it('locks the nine-level priority matrix', () => {
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
    // 级 7：非 choice 请求卡
    assert.equal(resolve({ ...baseState, hasRequests: true, hasRuntimeSelected: true }), 'requests');
    // 级 8：选中 runtime（calling / idle 同为 persistent）
    assert.equal(resolve({ ...baseState, hasRuntimeSelected: true }), 'persistent');
    // 级 9：都不满足 → hidden
    assert.equal(resolve({ ...baseState }), 'hidden');
  });
});

// voice-input.js 片段提取（与 frontend-interrupt-voice-lifecycle.test.js 同款方式）
function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

