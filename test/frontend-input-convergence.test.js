/**
 * frontend-input-convergence.test.js — 工单 037 验收用例（输入面触发权收敛）
 *
 * 覆盖工单验收节三条用例：
 *   1. 状态写入自动触发：applySessionViewPatch({ inputRequests }) 后输入面
 *      渲染无需手动 poke（hook → notifyInputSurfaceChanged 订阅生效）
 *   2. 契约 §8 事件→显示映射逐行锁死（poll 变化 / 会话切换 / 主视图渲染 /
 *      calling 翻转 / choice 交互与拒绝 / 回退对话框关闭 / 提交成功 / 排队同步）
 *   3. 乐观即时性：提交成功后输入面更新不依赖 poll（同步完成）
 *
 * 沙箱加载真实 session-view-state.js + input-composer.js + input-render.js
 * （与 index.html 加载序语义一致），mini DOM 方式参考
 * test/frontend-input-composer.test.js。
 */

import fs from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

// ── Mini DOM：与 frontend-input-composer.test.js 同款最小元素树 ─────────────

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
      if (part.startsWith(':')) return true;
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
    addEventListener() {},
    removeEventListener() {},
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

// ── 沙箱：真实 session-view-state + input-composer + input-render 同链路 ─────

function createConvergenceSandbox({ contextKey = 'session-a' } = {}) {
  const doc = createMiniDocument();
  const container = createMiniElement('div', doc);
  container.id = 'user-input-container';
  doc.body.appendChild(container);

  const state = { doc, container, liveKey: contextKey };

  const ctx = createFrontendSandbox({
    document: doc,
    currentLanguage: 'zh',
    currentRuntimeAgentId: 'agent-1',
    currentMessages: [],
    currentInputRequests: [],
    readOnlyMode: false,
    followLatestEnabled: false,
    _rollbackDialogOpen: false,
    _partialCompactInFlight: false,
    _partialCompactRuntimeId: null,
    _partialCompactContextKey: null,
    _compactTimerInterval: null,
    _agentCallActive: new Map(),
    // 语音域（默认无录音）
    _voiceRecording: false,
    _voiceStopping: false,
    _voiceTranscribing: false,
    _voicePendingSend: false,
    _voiceCacheKey: null,
    _pendingVoiceResults: {},
    // 依赖函数 stub
    t: (key) => key,
    getRuntimeContextKey: () => state.liveKey,
    _getSessionInputCacheKey: () => state.liveKey,
    isChatSurfaceActive: () => true,
    isRemoteNamespaceAgentId: () => false,
    runWithSuppressedChatViewportObservers: (fn) => fn(),
    notifyChatViewportMutation: () => {},
    // choice 渲染替身：由 input-render 的 choice 分支调用，用例内替换为计数器
    renderChoiceInputRequest: () => {},
    collapsePrimaryChoiceRequest: () => {},
    renderPersistentInput: () => {},
    _renderQueueBubbles: () => {},
    _syncPersistentInputUi: () => {},
    _renderLastCallElapsed: () => {},
    _renderRecapHint: () => {},
    _injectPendingVoiceResult: () => {},
    _reattachVoiceInputUi: () => {},
    _renderAttachmentPreview: () => {},
    updateInputModelSwitcher: () => {},
    updateThinkingEffortSwitcher: () => {},
    autoResize: () => {},
    _syncPersistentActionButton: () => {},
    stopVoiceRecording: () => {},
    _cancelVoiceRecording: () => {},
    _shouldPreserveVoiceInputForRender: () => false,
    readPartialCompactStartedAt: () => null,
    writePartialCompactStartedAt: () => {},
    // composer 端点绑定的提交域 stub（用例不触发真实行为）
    handleInputPaste: () => {},
    handlePersistentInputKey: () => {},
    onPersistentBtnClick: () => {},
    handleInputKey: () => {},
    submitInput: () => {},
    submitInputAction: () => {},
    onImageFilesSelected: () => {},
    toggleVoiceRecording: () => {},
    toggleInputModelDropdown: () => {},
    toggleThinkingEffortDropdown: () => {},
    escapeHtml: (text) => String(text == null ? '' : text),
  });

  // applySessionViewPatch 的写入目标与 setter（app-core.js 提供的同名符号）
  ctx.run(`
    var toolRenderConfigs = {};
    var TOOL_NAMES = {};
    var currentHookInspector = { lifecycleOrder: [], features: [], hooks: [] };
    var currentHookInspectorSignature = '';
    var currentOverviewSnapshot = {};
    var currentOverviewSignature = '';
    var currentTodoPlan = {};
    var currentTodoPlanSignature = '';
    var currentRuntimeConnected = true;
    // 队列乐观态（persistent-input 域全局；§3 级 6 输入）
    var _queuedTexts = [];
    var _pendingQueuedCount = 0;
    var _localQueuedInputPending = false;
    var _lastQueueBubbleSignature = '';
    var _switchEpoch = 0;
    // choice 域替身（choice-input.js 未加载时的中性实现）；
    // choice 用例加载真实模块后由 window.* 实现重新接管。
    function isChoiceInputRequest(req) {
      return !!req && req.mode === 'choices' && Array.isArray(req.questions) && req.questions.length > 0;
    }
    function isChoiceInputRejected() { return false; }
    function isChoiceInputConsumed() { return false; }
    function setCurrentHookInspector(value) {
      currentHookInspector = value;
      currentHookInspectorSignature = JSON.stringify(value);
    }
    function setCurrentOverviewSnapshot(value) {
      currentOverviewSnapshot = value;
      currentOverviewSignature = JSON.stringify(value);
    }
    function setCurrentTodoPlan(value) {
      currentTodoPlan = value;
      currentTodoPlanSignature = JSON.stringify(value);
    }
  `);
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.loadSource('public/src/modules/input-composer.js');
  ctx.run(`
    function getInputSurfaceMode(requests = readCurrentSessionViewState().inputRequests) {
      return resolveInputSurfaceMode(readInputSurfaceModeState(requests, isChatSurfaceActive()));
    }
  `);
  // renderPersistentInput 真实片段（persistent 分支的属性级更新依赖它）
  const persistentSource = fs.readFileSync('public/src/modules/persistent-input.js', 'utf8');
  const rpStart = persistentSource.indexOf('function renderPersistentInput(container) {');
  const rpEnd = persistentSource.indexOf('function syncContextPressureChip', rpStart);
  ctx.run(persistentSource.slice(rpStart, rpEnd));
  ctx.loadSource('public/src/modules/input-render.js');

  ctx.state = state;
  return ctx;
}

// ── 用例 1：状态写入自动触发（订阅生效，无需手动 poke） ─────────────────────

describe('state-write auto-triggers input surface (ticket 037 acceptance #1)', () => {
  it('applySessionViewPatch({inputRequests}) flips the composer with no manual poke', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const taA = ctx.run("document.getElementById('input-persistent')");
    assert.ok(taA, 'persistent composer mounts on first render');

    // 状态写入即声明：patch 写入 inputRequests 后不调用任何手动 render/reset，
    // 输入面必须已翻转到请求卡端点（同节点、属性级更新）。
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'r1', placeholder: 'Answer me' }] })`);
    const taB = ctx.run("document.getElementById('input-r1')");
    assert.ok(taB, 'requests endpoint rendered by the patch hook alone (no manual poke)');
    assert.equal(taB, taA, 'persistent -> requests flip must reuse the same composer node');
    assert.equal(composerMode(ctx), 'requests');

    // 写回空请求：同一节点翻回 persistent
    ctx.run('applySessionViewPatch({ inputRequests: [] })');
    const taBack = ctx.run("document.getElementById('input-persistent')");
    assert.equal(taBack, taA, 'requests -> persistent flip must reuse the same composer node');
    assert.equal(composerMode(ctx), 'persistent');
  });

  it('same-round duplicate declarations are idempotent (draft preserved, node stable)', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const taA = ctx.run("document.getElementById('input-persistent')");
    taA.value = 'draft preserved';
    ctx.run('_cacheSessionInput(document.getElementById("input-persistent"))');

    // 同轮多次声明（无状态变化）必须全部幂等 no-op，不得清空草稿
    ctx.run(`
      applySessionViewPatch({ inputRequests: [] });
      notifyInputSurfaceChanged([]);
      notifyInputSurfaceChanged([]);
    `);
    const taAfter = ctx.run("document.getElementById('input-persistent')");
    assert.equal(taAfter, taA, 'same-round duplicates must not rebuild the composer');
    assert.equal(taAfter.value, 'draft preserved', 'deduped notifies must keep the draft');
  });

  it('rollback-dialog freeze keeps renders as no-ops; close (state write) restores', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const taA = ctx.run("document.getElementById('input-persistent')");
    const cardA = ctx.run(composerQuery(ctx));

    // 对话框接管（§3 级 3）：接管期间声明 no-op，DOM 不被触碰
    ctx._rollbackDialogOpen = true;
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'rb-1' }] })`);
    assert.equal(composerMode(ctx), 'persistent',
      'render while frozen must be a no-op (stale endpoint stays hidden)');
    assert.equal(ctx.run("document.getElementById('input-rb-1')"), null,
      'frozen render must not touch the DOM');

    // 关闭 = 状态写入 + 声明 → 恢复输入面（签名为冻结期间记录的 frozen，
    // 关闭后的声明因模式差异自然触发恢复渲染）
    ctx.run(`
      _rollbackDialogOpen = false;
      notifyInputSurfaceChanged(currentInputRequests || []);
    `);
    assert.equal(composerMode(ctx), 'requests',
      'close restores the input surface for the pending lease');
    assert.equal(ctx.run("document.getElementById('input-rb-1')"), taA,
      'restore reuses the same composer node');
  });
});

// ── 契约 §8 事件→显示映射逐行锁死（收敛后覆盖面不得减少） ────────────────────

describe('contract §8 event->display mapping after convergence (ticket 037)', () => {
  it('§8 poll 行：inputRequests JSON 变化经 patch hook 重渲染', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    // 模拟 poll metadata commit：inputChanged → patch → hook 渲染
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'poll-1', placeholder: 'P' }] })`);
    assert.ok(ctx.run("document.getElementById('input-poll-1')"),
      'poll-driven lease change renders the request endpoint');
    ctx.run('applySessionViewPatch({ inputRequests: [] })');
    assert.ok(ctx.run("document.getElementById('input-persistent')"),
      'lease cleared -> optimistic persistent restore');
  });

  it('§8 会话切换/加载：draft rebinds by sessionKey through the single entry', () => {
    const ctx = createConvergenceSandbox({ contextKey: 'session-a' });
    ctx.run('renderInputRequests([])');
    const ta = ctx.run("document.getElementById('input-persistent')");
    ta.value = 'draft for a';
    ctx.run('_cacheSessionInput(document.getElementById("input-persistent"))');

    // 会话切换 = liveKey 变化 + patch（loadAgentData / 缓存恢复的收敛路径）
    ctx.state.liveKey = 'session-b';
    ctx.currentRuntimeAgentId = 'agent-2';
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'r-b' }] })`);
    const card = ctx.run(composerQuery(ctx));
    const liveTa = card.querySelector('.user-input-textarea');
    assert.equal(liveTa.dataset.sessionKey, 'session-b',
      'session switch rebinds dataset.sessionKey through the single entry');
    assert.equal(ctx.run(`_sessionInputCache['session-a']`), 'draft for a',
      'old session draft saved before rebind');
    assert.equal(liveTa.value, '', 'new session without a draft starts empty (no mixing)');
  });

  it('§8 主视图渲染 / 会话加载：结构性时机走唯一声明入口（源码级锁死）', () => {
    const uiSource = fs.readFileSync('public/src/app-ui.js', 'utf8');
    const renderBlock = uiSource.slice(
      uiSource.indexOf('function renderCurrentMainView'),
      uiSource.indexOf('\nfunction resetRuntimeBackedSurfaceState'),
    );
    assert.match(renderBlock, /notifyInputSurfaceChanged\(viewState\.inputRequests\)/);

    const loaderSource = fs.readFileSync('public/src/modules/agent-data-loader.js', 'utf8');
    assert.match(loaderSource, /notifyInputSurfaceChanged\(current\.inputRequests\)/);
  });

  it('§8 calling 翻转：按钮三态同步，输入面不重建（模式矩阵不变）', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const taA = ctx.run("document.getElementById('input-persistent')");
    // calling 翻转只同步按钮三态（persistent-input 域）；calling 不进入 §3
    // 模式矩阵（级 8 calling/idle 同为 persistent），输入面不得重建。
    ctx.run('_agentCallActive.set(currentRuntimeAgentId, true); _syncPersistentActionButton();');
    assert.equal(ctx.run("document.getElementById('input-persistent')"), taA,
      'calling flip must not rebuild the composer');
    assert.equal(composerMode(ctx), 'persistent');
    // calling 期间请求卡送达仍正常翻转（模式翻转由 patch 声明）
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'rc-1' }] })`);
    assert.equal(composerMode(ctx), 'requests');
  });

  it('§8 提交成功（请求卡路径）：optimistic restore without waiting for poll', async () => {
    const ctx = createConvergenceSandbox({ contextKey: 'session-a' });
    ctx.run('renderInputRequests([])');
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'r-act' }] })`);
    assert.ok(ctx.run("document.getElementById('input-r-act')"), 'request endpoint rendered');

    // 真实 submitInputAction 路径（input-helpers.js）
    const helpersSource = fs.readFileSync('public/src/modules/input-helpers.js', 'utf8');
    const block = helpersSource.slice(
      helpersSource.indexOf('async function submitInputAction'),
    );
    ctx.run(block);
    ctx.run(`
      function clearInterruptSuppression() {}
      function _markAgentCallStartedForNotify() {}
      function renderAgentList() {}
      function beginFollowLatestEntryWindow() {}
      function requestFollowLatest() {}
      function newIdempotencyKey() { return 'k'; }
      function _syncPersistentActionButton() {}
      var _submitActionPolls = 0;
      function poll() { _submitActionPolls += 1; }
    `);
    ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

    await ctx.run(`submitInputAction('r-act', 'proceed', {}, 'agent-1')`);

    // 乐观即时性：await 返回时输入面已恢复 persistent，不依赖后台 poll。
    assert.ok(ctx.run("document.getElementById('input-persistent')") !== null,
      'composer restored optimistically right after submit success');
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]').dataset.composerMode",
    ), 'persistent');
  });

  it('§8 选择卡交互（选项/收起/展开/拒绝）：state write + notify rebuilds the card', async () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    ctx.run(`
      var choiceInputState = {};
      function poll() {}
      function newIdempotencyKey() { return 'k'; }
    `);
    ctx.loadSource('public/src/modules/choice-input.js');
    // 真实模块以 window.* 注册 choice 判定；vm 沙箱的 bare-name 解析走
    // 上下文全局，这里把真实实现接管回来（浏览器里 window 即全局）。
    ctx.run(`
      isChoiceInputRejected = window.isChoiceInputRejected;
      isChoiceInputConsumed = window.isChoiceInputConsumed;
    `);
    ctx.run(`
      applySessionViewPatch({ inputRequests: [{
        requestId: 'choice-1', mode: 'choices',
        questions: [{ id: 'q1', question: 'How?', options: [{ id: 'a' }, { id: 'b' }], allowCustom: true }],
      }] });
    `);

    let choiceRenders = 0;
    ctx.renderChoiceInputRequest = () => { choiceRenders += 1; };
    assert.equal(choiceRenders, 0, 'renderChoiceInputRequest is stubbed for counting');

    // 选项交互：状态写入 + 声明 → 选择卡重建（经唯一入口）
    ctx.run(`window.selectChoiceOption('choice-1', 1)`);
    assert.ok(choiceRenders >= 1, 'option interaction re-renders the choice card');
    assert.equal(ctx.run(`choiceInputState['choice-1'].selectedIndex`), 1);

    // 展开/收起：状态入签名，声明即重建
    const rendersBeforeCollapse = choiceRenders;
    ctx.run(`window.toggleChoiceContext('choice-1')`);
    assert.ok(choiceRenders > rendersBeforeCollapse, 'context toggle re-renders via the single entry');

    // 拒绝（跳过并打断）：本地立即恢复普通输入面，不等网络。
    ctx.fetch = async () => { throw new Error('reject must restore input before any network'); };
    await ctx.run(`window.rejectChoiceRequest('choice-1')`);
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]') !== null",
    ), true, 'reject restores the persistent composer immediately');
  });

  it('§8 选择卡提交成功：consumed lease 在陈旧快照中不再重建（防闪回第一题）', async () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    ctx.run(`
      var choiceInputState = {};
      function poll() {}
      function newIdempotencyKey() { return 'k'; }
    `);
    ctx.loadSource('public/src/modules/choice-input.js');
    ctx.run(`
      isChoiceInputRejected = window.isChoiceInputRejected;
      isChoiceInputConsumed = window.isChoiceInputConsumed;
    `);
    ctx.run(`
      applySessionViewPatch({ inputRequests: [{
        requestId: 'choice-2', mode: 'choices',
        questions: [{ id: 'q1', question: 'How?', options: [{ id: 'a' }, { id: 'b' }] }],
      }] });
    `);
    assert.equal(ctx.run(`choiceInputState['choice-2'].questionIndex`), 0);

    // 提交答案（单题即最后一题）：POST 成功后交互状态清理、lease 登记 consumed。
    ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await ctx.run(`window.confirmChoiceQuestion('choice-2')`);
    assert.equal(ctx.run(`choiceInputState['choice-2']`), undefined, 'interaction state cleared on submit');
    assert.equal(ctx.run(`window.isChoiceInputConsumed('choice-2')`), true, 'submitted lease registered as consumed');

    // 陈旧快照仍带回该 lease：模式判定与渲染都必须视其为不存在，
    // 直接落回 persistent composer，而不是以初始题号重建选择卡。
    ctx.run(`
      applySessionViewPatch({ inputRequests: [{
        requestId: 'choice-2', mode: 'choices',
        questions: [{ id: 'q1', question: 'How?', options: [{ id: 'a' }, { id: 'b' }] }],
      }] });
    `);
    assert.equal(composerMode(ctx), 'persistent', 'stale consumed lease must not flip the surface back to choice');
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('.user-choice-card')",
    ), null, 'stale consumed lease must not rebuild the choice card');
  });

  it('§8 排队同步：level-6 optimistic queue pins persistent over a pending lease', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    // 请求卡在先
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'q-1' }] })`);
    assert.ok(ctx.run("document.getElementById('input-q-1')"), 'requests card shows for the lease');
    // 本地排队乐观态写入 + 声明（persistent-input 的队列同步收敛路径）
    ctx.run(`
      _localQueuedInputPending = true;
      _pendingQueuedCount = 1;
      notifyInputSurfaceChanged(currentInputRequests || []);
    `);
    // 级 6：本地排队乐观态 → persistent（请求卡被压住，不弹卡）
    assert.equal(composerMode(ctx), 'persistent');
    // 排空后声明 → 请求卡恢复
    ctx.run(`
      _localQueuedInputPending = false;
      _pendingQueuedCount = 0;
      notifyInputSurfaceChanged(currentInputRequests || []);
    `);
    assert.equal(composerMode(ctx), 'requests', 'drained queue reveals the request card again');
  });
});

// ── 收敛断言：手动戳协议灭绝（源码级锁死） ──────────────────────────────────

const FILES_OUTSIDE_RENDERER = [
  'public/src/app-core.js',
  'public/src/app-main.js',
  'public/src/app-ui.js',
  'public/src/modules/agent-data-loader.js',
  'public/src/modules/choice-input.js',
  'public/src/modules/generative-ui-panel.js',
  'public/src/modules/input-helpers.js',
  'public/src/modules/persistent-input.js',
  'public/src/modules/rollback-dialog.js',
  'public/src/modules/runtime-status.js',
  'public/src/modules/workspace-actions.js',
  'public/src/modules/session-view-state.js',
];

describe('manual poke protocol is retired (ticket 037)', () => {
  it('no module outside the renderer pokes the dedup signature or calls the renderer', () => {
    for (const file of FILES_OUTSIDE_RENDERER) {
      const source = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(
        source,
        /lastRenderedInputSignature\s*=[^=]|lastRenderedInputMode\s*=[^=]/,
        `${file} must not poke the renderer-internal dedup signature`,
      );
      assert.doesNotMatch(
        source,
        /\brenderInputRequests\s*\(/,
        `${file} must not call the renderer directly; declare via notifyInputSurfaceChanged`,
      );
    }
  });

  it('applySessionViewPatch auto-triggers on inputRequests writes (source level)', () => {
    const source = fs.readFileSync('public/src/modules/session-view-state.js', 'utf8');
    const applyBlock = sourceBetween(
      source,
      'function applySessionViewPatch',
      '\n/**\n * Canonical writer',
    );
    assert.match(applyBlock, /notifyInputSurfaceChanged\(currentInputRequests\)/);
  });

  it('optimistic submit paths keep immediate feedback without poll dependency', () => {
    const helpersSource = fs.readFileSync('public/src/modules/input-helpers.js', 'utf8');
    const submitBlock = helpersSource.slice(
      helpersSource.indexOf('async function submitInputAction'),
    );
    // 乐观即时性：patch 写入（同步触发渲染）先于 poll()
    const patchAt = submitBlock.indexOf('applySessionViewPatch({ inputRequests: [] })');
    const pollAt = submitBlock.indexOf('poll()');
    assert.notEqual(patchAt, -1, 'submitInputAction still patches inputRequests');
    assert.ok(pollAt > patchAt, 'poll() must come after the synchronous optimistic restore');
    assert.doesNotMatch(submitBlock, /lastRenderedInputSignature/);
  });
});

function composerMode(ctx) {
  return ctx.run(
    "document.getElementById('user-input-container').querySelector('[data-persistent-composer]').dataset.composerMode",
  );
}

function composerQuery(ctx) {
  return "document.getElementById('user-input-container').querySelector('[data-persistent-composer]')";
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}
