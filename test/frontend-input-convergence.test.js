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
 * 加载路线（P2 跨批测试迁移）：
 *   - classic 相（`sandbox.loadSource` / `sandbox.run`）：action-dispatcher +
 *     session-view-state + input-composer + input-render + rollback-dialog（同步注册壳）
 *     + persistent-input 片段——输入面的渲染入口与模式矩阵仍是 classic（与
 *     index.html 加载序语义一致），mini DOM 方式参考
 *     test/frontend-input-composer.test.js。
 *   - 会话视图存储键按生产协议在 classic 相 register（app-core 只 defineKey），
 *     ESM owner claim 后 classic 与 ESM 两侧读写同一份状态。
 *   - ESM 相：`c.load` 真实 import —— sse-client（排队锚点与 queued-inputs 事件入口）、
 *     input-actions（动作提交与回退可用性）、choice-input（选择卡整域）、
 *     rollback-dialog-runtime（回退对话框与运行期编排）。每个用例独占一份 window
 *     与一张 ESM 图（withP2EsmCase）：模块私有状态（乐观锚点、已观察排队 id、
 *     快照缓存）不跨用例残留，用例体经 createConvergenceSandbox() 取当前用例的
 *     沙箱外观。
 *   - 排队事件走真实公开入口：bootSseClient() + MockEventSource 的 queued-inputs 帧；
 *     选择卡与回退动作走真实分发器动作（choice.*）与 window.requestRollbackEdit。
 */

import fs from 'node:fs';
import { describe, it as nodeIt } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

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
  const el = {
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
  // innerHTML 的标签树构建：卡片模板（选择卡 / 回退对话框）以字符串装配，
  // 真实 DOM 会在赋值时建树，测试要断言结构与其 querySelector 就必须同样建树。
  // 只构建标签/属性（class/id/data-*），文本节点忽略——断言面是结构与接线。
  let _innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _innerHTML; },
    set(html) {
      _innerHTML = String(html);
      el.children = [];
      const stack = [el];
      const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/)?>/g;
      let match;
      while ((match = tagRe.exec(_innerHTML))) {
        const [, closing, tag, attrText, selfClosing] = match;
        if (closing) { if (stack.length > 1) stack.pop(); continue; }
        const child = createMiniElement(tag, doc);
        const attrRe = /([\w-]+)(?:="([^"]*)")?/g;
        let attr;
        while ((attr = attrRe.exec(attrText))) {
          if (attr[1] === 'class') child.className = attr[2] || '';
          else child.setAttribute(attr[1], attr[2] ?? '');
        }
        stack[stack.length - 1].appendChild(child);
        if (!selfClosing) stack.push(child);
      }
    },
  });
  return el;
}

/**
 * 新增可达模块（queue-projection → thread-store-domain → workspace-actions →
 * trim-page）在模块求值期按 id 取自己的节点并注册监听；生产里这些节点由
 * index.html 提供。夹具按 id 建最小节点，避免把"元素缺席"当成被测链路的
 * 事实（它们只有 id，不参与 class 选择器断言）。
 */
const NEWLY_REACHABLE_ELEMENT_IDS = [
  // app-core 的 classic 顶层 const（chat-renderer 的容器）：必须在 app-core 装载前
  // 就存在，回显气泡才落到本用例断言的同一个节点上。
  'chat-container',
  // trim-page
  'trim-page', 'trim-page-list', 'trim-page-title', 'trim-page-submit',
  'trim-page-mode', 'trim-page-ratio-config', 'trim-page-manual-config',
  'trim-page-ratio-slider', 'trim-page-ratio-input', 'trim-page-readout',
  'trim-page-summary-toggle', 'trim-page-archive-toggle', 'trim-page-archive-row',
  'trim-page-keep-skill-toggle', 'trim-page-keep-skill-control',
  'trim-page-keep-skill-value', 'trim-page-keep-skill-dec', 'trim-page-keep-skill-inc',
  // session-dialogs（分支对话框）
  'branch-dialog', 'branch-round-list', 'branch-footer-info',
];


const TRIM_PAGE_ELEMENT_IDS = [
  'trim-page', 'trim-page-list', 'trim-page-title', 'trim-page-submit',
  'trim-page-mode', 'trim-page-ratio-config', 'trim-page-manual-config',
  'trim-page-ratio-slider', 'trim-page-ratio-input', 'trim-page-readout',
  'trim-page-summary-toggle', 'trim-page-archive-toggle', 'trim-page-archive-row',
  'trim-page-keep-skill-toggle', 'trim-page-keep-skill-control',
  'trim-page-keep-skill-value', 'trim-page-keep-skill-dec', 'trim-page-keep-skill-inc',
];

function createMiniDocument() {
  const doc = { activeElement: null, readyState: 'complete' };
  doc.body = createMiniElement('body', doc);
  doc.body.contains = function (node) { return node === this || this.contains(node); };
  doc.createElement = (tag) => createMiniElement(tag, doc);
  doc.getElementById = (id) => findAllDeep(doc.body, (el) => el.id === id)[0] || null;
  doc.querySelector = (selector) => findFirst(doc.body, selectorPredicate(selector));
  doc.querySelectorAll = (selector) => findAllDeep(doc.body, selectorPredicate(selector));
  doc.addEventListener = () => {};
  for (const id of NEWLY_REACHABLE_ELEMENT_IDS) {
    const node = doc.createElement('div');
    node.id = id;
    doc.body.appendChild(node);
  }
  return doc;
}

// ── 用例上下文：classic 输入面链 + 真实 import 的 sse-client 图 ────────────

class MockEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.onerror = null;
    MockEventSource.instances.push(this);
  }
  addEventListener(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, []);
    this.listeners.get(kind).push(fn);
  }
  close() { this.readyState = 2; }
  emit(kind, data) {
    this.readyState = 1;
    for (const fn of this.listeners.get(kind) || []) fn({ data: JSON.stringify(data) });
  }
}

const latestSseSource = () => MockEventSource.instances[MockEventSource.instances.length - 1] || null;

/**
 * sse-client 图在装载期 `...window.createXHost()` 取宿主面。本文件只消费排队
 * 锚点语义与 queued-inputs 帧，不驱动通知 / 元数据提交 / 轮询 / runtime 消失
 * 路径——这些域的真实行为由各自测试文件覆盖（frontend-sse-client 等）。
 * 因此这里按生产 seam 提供最小宿主面，不复制任何业务策略。
 */
function createSseGraphHostStubs({ container, pollState } = {}) {
  return {
    createAgentCallStatesHost: () => ({}),
    createMetadataCommitHost: () => ({}),
    createMessageProbeHost: () => ({}),
    createAgentSnapshotLoaderHost: () => ({}),
    createRuntimeNotFoundHost: () => ({}),
    // 轮询协调器宿主（生产由 app-main 提供）：input-actions / choice-input 已改为
    // 直接 import poll-coordinator-host，本文件按该 seam 提供最小可用宿主，
    // 直接用真实 poll 模块，不保留 window.poll 回退。
    createPollCoordinatorHost: () => ({
      // 真实 poll 模块的宿主 seam（生产由 app-main 提供）。run 记次并支持用例
      // 挂 hook，以便在 poll 真实调用点观察状态（不再用 window.poll 桩）。
      run: () => {
        pollState.runs += 1;
        return pollState.hook ? Promise.resolve(pollState.hook()) : Promise.resolve();
      },
      fastInterval: () => 2000,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (id) => clearTimeout(id),
    }),
    // call 活动容器：input-actions 的 submitInputAction 与 classic 侧共享同一 Map
    // 引用（生产由 app-core 的 createP2BootstrapCallActivityHost 交出）。
    createP2BootstrapCallActivityHost: () => ({
      _agentCallActive: new Map(),
      _recentlyFinishedRuntimes: new Set(),
      _seenChoiceAlertIds: new Set(),
      _autoTitleTriggered: new Set(),
      _lastInterruptUserActionAt: 0,
    }),
    // DOM 引用（input-actions 回退按钮同步扫描 .message-row 的根节点）
    createP2BootstrapDomHost: () => ({ container }),
    // 其余 P2 bootstrap 适配 seam：本文件不驱动这些域的路径
    createP2BootstrapSessionSwitchHost: () => ({}),
    // 聊天表面状态宿主（生产由 app-core 提供）：输入面渲染器的视口声明读
    // 跟随开关与滚动抑制标志，成对转发到沙箱全局（原 classic 裸标识符同源）。
    // 宿主工厂在用例体被调用时，globalThis.window 已是本 case 的沙箱。
    createP2BootstrapChatSurfaceHost: () => ({
      get followLatestEnabled() { return window.followLatestEnabled; },
      set followLatestEnabled(value) { window.followLatestEnabled = value; },
      get suppressFollowScrollEvent() { return window.suppressFollowScrollEvent; },
      set suppressFollowScrollEvent(value) { window.suppressFollowScrollEvent = value; },
      get showChatProcess() { return window.showChatProcess; },
      set showChatProcess(value) { window.showChatProcess = value; },
    }),
    createP2BootstrapSidebarHost: () => ({}),
    // SSE / 列表快照 / 元数据提交等已迁 ESM 域的装载期宿主 seam（生产分别由
    // sidebar-render / session-view-state / app-main 交出）：本文件不驱动这些域。
    createP2BootstrapSidebarRenderHost: () => ({}),
    createAgentCallStatesHost: () => ({}),
    createAgentSnapshotLoaderHost: () => ({ state: { suppressRender: true } }),
    createMetadataCommitHost: () => ({}),
    createMessageProbeHost: () => ({}),
    createSessionDataLoaderHost: () => ({}),
    createRuntimeStatusLoaderHost: () => ({}),
    createRuntimeNotFoundHost: () => ({}),
    createP2BootstrapPhSessionHost: () => ({}),
    createP2BootstrapDebugPanelHost: () => ({}),
    createRuntimePollHost: () => ({}),
    createPollCycleHost: () => ({}),
    createPollMaintenanceHost: () => ({}),
    AgentLoaderHost: { loadedAgentDetailIds: new Set() },
  };
}

/**
 * 用例作用域内的沙箱外观：`ctx.run` / `ctx.loadSource` / `ctx.state` 是本用例
 * 专属面，其余读写原样转发到真实沙箱全局（`ctx.fetch = …` 之类与原来一致）。
 */
function createCaseApi(c, state, sse, net, inputActions, choiceInput) {
  const base = {
    state,
    sse,
    /** 真实选择卡模块（命名导出 + 模块私有交互状态；classic 消费方经桥键取用）。 */
    choiceInput,
    /** 真实动作提交（ESM 入口；classic 消费方经 window 晚绑定，本文件直接调用）。 */
    submitInputAction: (...args) => inputActions.submitInputAction(...args),
    run: (code) => c.read(code),
    loadSource: (rel) => c.sandbox.loadSource(rel),
    /** 真实 SSE 入口：queued-inputs 帧（sse-client 的唯一排队事件消费路径）。 */
    emitQueued: (data, agentId = 'agent-1') => {
      const source = latestSseSource();
      assert.ok(source, 'sse-client 已建连（queued-inputs 帧需要真实连接）');
      source.emit('queued-inputs', { agentId, data });
    },
    /** 真实 import 一个仓库内 ESM 模块（本用例图内同一实例）。 */
    loadModule: (rel) => c.load(rel),
    noteQueuedOptimistic: (...args) => sse.noteQueuedOptimistic(...args),
    reconcileQueuedTexts: (...args) => sse.reconcileQueuedTexts(...args),
    getLastQueuedSnapshot: (...args) => sse.getLastQueuedSnapshot(...args),
    window: c.window,
    get document() { return c.window.document; },
    // 网络面：写穿到 case 的委托（classic 与 ESM 两侧同时生效）
    get fetch() { return (url, init) => (net.impl ? net.impl(url, init) : c.window.fetch(url, init)); },
    set fetch(fn) { net.impl = fn; },
  };
  return new Proxy(base, {
    get(target, prop) { return prop in target ? target[prop] : c.window[prop]; },
    set(target, prop, value) {
      if (prop in target) { target[prop] = value; return true; }
      c.window[prop] = value;
      return true;
    },
    has(target, prop) { return prop in target || prop in c.window; },
  });
}

/**
 * 会话视图存储键与 setter（app-core.js 在生产里提供的同一批符号）。
 *
 * 存储键按**生产协议**在 classic 相 register（app-core 只 defineKey、不另声明
 * 同名 let），因此 classic 侧裸读写与 ESM owner（session-view-storage）claim 后
 * 的读写是同一份状态——choice-input / input-actions 读到的 `currentInputRequests`
 * 就是 `applySessionViewPatch` 刚写进去的那一份，不靠测试副本。
 */
const CONVERGENCE_STATE_PRELUDE = `
  // 会话视图存储键按生产协议在 classic 相 register（app-core 只 defineKey、不另声明
  // 同名 let），因此 classic 侧裸读写与 ESM owner（session-view-storage）claim 后的
  // 读写是同一份状态——choice-input / input-actions 读到的 currentInputRequests 就是
  // applySessionViewPatch 刚写进去的那一份，不靠测试副本。
  // session-view-storage 的 10 个桥键由真实 app-core（本相第一支脚本）注册，
  // 这里不再重复 defineKey（唯一注册制，重复会抛错）。
  // 输入队列桥键（§3 级 6 输入）+ 投影归属：P4 输入面批次起由 persistent-input
  // 在模块相注册（本文件在用例体里真实 import 它），这里不再重复 defineKey
  //（唯一注册制，重复会抛错）。
  currentRuntimeConnected = true;
  var _switchEpoch = 0;
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
`;

/** 一个用例的加载环境：mini DOM + classic 输入面链 + sse-client 图的宿主桩。 */
function convergenceCaseOptions() {
  // 网络面委托：ESM 模块以裸 fetch 调用（主 realm 的 globalThis.fetch 是 case
  // 开始时的快照），classic 代码走沙箱全局 fetch。两者都指向同一个委托函数，
  // 用例内 `ctx.fetch = …` 换实现时不会因 realm 差异失联。
  const net = { impl: null };
  const pollState = { runs: 0, hook: null };
  const fetchBridge = (url, init) => (net.impl
    ? net.impl(url, init)
    : Promise.resolve({ ok: false, status: 0, json: async () => ({}), text: async () => '' }));
  const doc = createMiniDocument();
  const container = createMiniElement('div', doc);
  container.id = 'user-input-container';
  doc.body.appendChild(container);
  const choiceContainer = createMiniElement('div', doc);
  choiceContainer.id = 'choice-input-container';
  doc.body.appendChild(choiceContainer);

  const state = { doc, container, choiceContainer, liveKey: 'session-a', poll: pollState };

  const caseGlobals = {
        document: doc,
        EventSource: MockEventSource,
        URLSearchParams,
        ClawToast: { show() {} },
        marked: { parse: (markdown) => String(markdown ?? '') },
        performance: { now: () => Date.now() },
        fetch: fetchBridge,
        currentLanguage: 'zh',
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
        // 聊天渲染域（chat-renderer，P4 T2 迁 ESM）的视口结算判定：本文件不装载
        // app-ui，按同一 seam 给出"站在聊天表面"的常量真值。
        shouldRenderWorkspaceSurface: () => false,
        isRemoteNamespaceAgentId: () => false,
        runWithSuppressedChatViewportObservers: (fn) => fn(),
        notifyChatViewportMutation: () => {},
        // choice 渲染替身：由 input-render 的 choice 分支调用，用例内替换为计数器
        renderPersistentInput: () => {},
        _renderQueueBubbles: () => {},
        _syncPersistentInputUi: () => {},
        _renderLastCallElapsed: () => {},
        _renderRecapHint: () => {},
        _injectPendingVoiceResult: () => {},
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
        // composer 端点绑定（正常输入仅走 persistent user-turn；action 应答独立）
        handleInputPaste: () => {},
        handlePersistentInputKey: () => {},
        onPersistentBtnClick: () => {},
        onImageFilesSelected: () => {},
        toggleVoiceRecording: () => {},
        toggleInputModelDropdown: () => {},
        toggleThinkingEffortDropdown: () => {},
        escapeHtml: (text) => String(text == null ? '' : text),
        // 回退对话框运行时的 classic 汇点（生产分别定义于 runtime-status /
        // persistent-input；本文件不驱动打断链路，按既有注入面提供）。
        isRuntimeCalling: () => false,
        interruptAgent: async () => ({ ok: true }),
        // 提交 / 打断成功后的 UI 与跟随汇点（生产来自 sidebar-render /
        // chat-viewport / desktop-notify / recap-hint，本裁剪链不装这些模块）：
        // 本文件只断言端点与状态。
        _requestNotifyPermission: () => {},
        _clearRecapForNewMessage: () => {},
        refreshThreads: () => {},
        renderAgentList: () => {},
        beginFollowLatestEntryWindow: () => {},
        requestFollowLatest: () => {},
        _markAgentCallStartedForNotify: () => {},
        clearInterruptSuppression: () => {},
        ...createSseGraphHostStubs({ container, pollState }),
  };

  return {
    state,
    net,
    options: {
      classic: (sandbox) => {
        // classic 相（本文件是**切片式**夹具：只装输入面收敛需要的 classic 片段）。
        // 完整真实链安装实测会改变用例钉住的行为（见交付报告：wakeup 按钮态 /
        // echo 确认 6 例），故保留裁剪链 + 逐支说明的宿主 seam：
        //   app-core.js     → P2Bootstrap* / RuntimeViewCache / ApplicationStartup（成对 get/set 访问器袋）
        //   app-main.js     → RuntimeSwitch（顶层读 host.state）/ PollCoordinator / CompactResume / WorkspaceEntry
        //   sidebar-render  → AgentCallStates / AgentSnapshotLoader / SidebarRender（lastAgentListRenderSignature 访问器）
        //   app-ui.js       → WorkspaceSurface（只 spread 注入）
        // 宿主接口按生产读取面给出（非统一空壳），装真链的阻断链见交付报告。
        sandbox.loadSource('public/src/modules/action-dispatcher.js');
        // 真实 app-core：call-interrupt 的 classic 同步引擎（四个桥键）与
        // session-view-storage / orchestration 的桥键都在这里注册。本用例的
        // classic 与 ESM 两侧因此读同一 window 上的同一份状态与同一 policy 实例
        // （不再从第二个 sandbox 搬运访问器）。
        sandbox.loadSource('public/src/app-core.js');
        // app-core 的真实 getRuntimeContextKey 会覆盖夹具的会话上下文桩（本文件的
        // 断言以 state.liveKey 为会话键），按既有宿主 seam 恢复。
        sandbox.getRuntimeContextKey = () => state.liveKey;
        sandbox.run(CONVERGENCE_STATE_PRELUDE);
        sandbox.loadSource('public/src/modules/session-view-state.js');
        // input-composer / persistent-input 已迁 ESM（P4 输入面批次）：改由用例体
        // 真实 import（模式判定 / 常驻渲染 / 排队重绑 / 交互面守卫的桥键来源）。
        sandbox.run(`
          function getInputSurfaceMode(requests = readCurrentSessionViewState().inputRequests) {
            return resolveInputSurfaceMode(readInputSurfaceModeState(requests, isChatSurfaceActive()));
          }
        `);
        // rollback-dialog / input-render 已迁 ESM（P4 T2）：改由用例体真实 import。
        sandbox.createRuntimeViewCacheHost = () => ({ cache: new Map(), capacity: 0 });
        sandbox.createRuntimeSwitchHost = () => ({ state: {} });
        sandbox.createCompactResumeHost = () => ({});
        sandbox.createP2BootstrapPhSessionHost = () => ({});
        sandbox.createP2BootstrapAssemblyHost = () => ({});
        sandbox.createP2BootstrapContextMenuHost = () => ({});
        sandbox.createP2BootstrapDebugPanelHost = () => ({});
        sandbox.createWorkspaceEntryHost = () => ({});
        sandbox.createWorkspaceSurfaceHost = () => ({});
      },
      globals: caseGlobals,
    },
  };
}

/** 在「非预期 warn/error 必须为空」的守卫下跑一个 case（失败也要还原 console）。 */
async function withNoiseClean(label, fn) {
  const noise = captureConsoleNoise(NOISE_ALLOWED);
  try {
    const result = await fn();
    noise.assertClean(label);
    return result;
  } finally {
    noise.restore();
  }
}

/** 当前用例的沙箱外观（只能在 it() 用例体内取用）。 */
let currentConvergence = null;

function createConvergenceSandbox(options = {}) {
  if (!currentConvergence) throw new Error('createConvergenceSandbox 只能在 it() 用例体内使用');
  if (options.contextKey) currentConvergence.state.liveKey = options.contextKey;
  return currentConvergence;
}

/**
 * 本文件允许的既有输出（逐条理由；其余任何 warn/error 一律失败）。两条都来自
 * 用例**故意**制造的失败响应，生产侧如实记录，且用例已断言其本地恢复语义：
 *   - `[Choice] interrupt request failed`：拒绝用例让 fetch 抛错，断言本地立即
 *     恢复输入面（不等网络）；
 *   - `排队输入提交失败`：409 operation_rejected 用例，断言草稿保留 + 明确提示。
 */
const NOISE_ALLOWED = [
  /^error: \[Choice\] interrupt request failed: reject must restore input before any network$/,
  /^error: 排队输入提交失败: A non-text interactive input request must be completed before submitting a new user turn$/,
];

/**
 * 用例级控制台噪音捕获：production 的 `host.warn` / `promise.catch` 会把失败降级
 * 成 warn 输出，测试若不看输出就可能带着 ReferenceError 变绿。case 内接管
 * console.warn / console.error，用例结束断言为空——不吞错。
 */
function captureConsoleNoise(allowed = []) {
  const entries = [];
  const original = { warn: console.warn, error: console.error };
  const record = (level) => (...args) => {
    entries.push(`${level}: ${args.map((value) => (value instanceof Error ? value.message : String(value))).join(' ')}`);
  };
  console.warn = record('warn');
  console.error = record('error');
  return {
    entries,
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
    assertClean(label) {
      const unexpected = entries.filter((line) => !allowed.some((pattern) => pattern.test(line)));
      assert.deepEqual(unexpected, [],
        `${label} 不得出现非预期 warn/error 输出：\n${unexpected.join('\n')}`);
    },
  };
}

/**
 * 每个用例：一份 window + 一张 ESM 图。焦点 runtime 在生产由 app-core 注册桥键、
 * orchestration owner 认领（本文件的 classic 子集不含 app-core，故按同一协议注册）。
 */
function it(name, body) {
  return nodeIt(name, async () => {
    const { state, net, options } = convergenceCaseOptions();
    MockEventSource.instances.length = 0;
    await withNoiseClean('输入面收敛用例', () => withP2EsmCase(options, async (c) => {
      // 刷新引擎（P4 T3 起是真实 ESM）：交互域在**装载期**取它的窄宿主 createThreadStoreHost，
// 必须先于 thread-store-domain 进入同一张图。
      await c.load('public/src/modules/thread-store.js');
      // 桥键按生产协议在 classic 相注册、**初值为 null**（本文件的 classic 子集不含
      // app-core）；焦点 runtime 随后经真实 setter 写入，而不是预置状态副本。
      c.sandbox.run(`
        // currentRuntimeAgentId / _switchEpoch 由真实 app-core 注册（初值 null / 0）。
        window.__clawAuthReady = new Promise(() => {});
      `);
      const orchestration = await c.load('public/src/modules/orchestration-state.js');
      orchestration.setCurrentRuntimeAgentId('agent-1');
      assert.equal(c.read('currentRuntimeAgentId'), 'agent-1', '焦点 runtime 经真实 setter 生效');
      // 输入面渲染器已迁 ESM（P4 T2）：回退 / 压缩域注册壳先求值（状态键窗口
      // 访问器 + owner claim），再真实 import 渲染入口；入口注入沙箱后，用例的
      // 经典驱动面 ctx.run('renderInputRequests(...)') 与生产入口名保持一致。
      await c.load('public/src/modules/rollback-dialog.js');
      // 输入面实现（P4 输入面批次起是 ESM）：模式判定 / 常驻渲染 / 提交与打断
      // 入口 / 交互面守卫的桥键全部由它注册，必须在渲染入口调用前就位。
      await c.load('public/src/modules/persistent-input.js');
      const inputRender = await c.load('public/src/modules/input-render.js');
      c.expose('renderInputRequests', inputRender.renderInputRequests);
      // agent-data-loader 的 host 工厂（session-data-loader / runtime-status-loader seam）
      await c.load('public/src/modules/agent-data-loader.js');
      // 排队气泡投影域（P2 W2-3a 已迁出 persistent-input）：气泡渲染与后端队列
      // 同步的真实实现，classic 消费方经 input-queue 桥键继续调用
      await c.load('public/src/modules/p2-w2-3a-input-queue-state.js');
      await c.load('public/src/modules/p2-w2-3a-queue-projection.js');
      // 输入面动作与选择卡（本批收尾批次已迁 ESM）：动作提交、回退按钮可见性与
      // 选择卡谓词/渲染在生产里就是这两个模块，classic 消费方经桥键取用谓词。
      const inputActions = await c.load('public/src/modules/input-actions.js');
      const choiceInput = await c.load('public/src/modules/choice-input.js');
      // 回退对话框与运行期编排（原 rollback-dialog.js 的 ESM 部分）
      await c.load('public/src/modules/rollback-dialog-runtime.js');
      // 渲染域（P4 T2 迁出）：回显 / 对账的真实实现，回显用例经它驱动。
      const chatRenderer = await c.load('public/src/modules/chat-renderer.js');
      const sse = await c.load('public/src/modules/sse-client.js');
      sse.bootSseClient();
      const source = latestSseSource();
      if (source) source.emit('hello', { hello: true });
      currentConvergence = createCaseApi(c, state, sse, net, inputActions, choiceInput);
      currentConvergence.chatRenderer = chatRenderer;
      try {
        await body();
      } finally {
        currentConvergence = null;
      }
    }));
  });
}

// ── 用例 1：状态写入自动触发（订阅生效，无需手动 poke） ─────────────────────

describe('state-write auto-triggers input surface (ticket 037 acceptance #1)', () => {
  it('inputRequests state updates preserve the persistent composer and ordinary-send endpoint', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const textarea = ctx.run("document.getElementById('input-persistent')");
    assert.ok(textarea, 'persistent composer mounts on first render');

    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'r1', placeholder: 'Answer me' }] })`);
    assert.equal(ctx.run("document.getElementById('input-persistent')"), textarea,
      'a pending text lease must not replace the ordinary-send composer');
    assert.equal(ctx.run("document.getElementById('input-r1')"), null,
      'ordinary text entry must not become requestId-bound');
    assert.equal(composerMode(ctx), 'persistent');

    ctx.run('applySessionViewPatch({ inputRequests: [] })');
    assert.equal(ctx.run("document.getElementById('input-persistent')"), textarea,
      'clearing a lease keeps the same composer');
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

  it('rollback-dialog freeze keeps renders as no-ops; close preserves the persistent composer', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const textarea = ctx.run("document.getElementById('input-persistent')");

    ctx._rollbackDialogOpen = true;
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'rb-1' }] })`);
    assert.equal(composerMode(ctx), 'persistent',
      'render while rollback dialog is open must not alter the composer');
    assert.equal(ctx.run("document.getElementById('input-persistent')"), textarea);

    ctx.run(`
      _rollbackDialogOpen = false;
      notifyInputSurfaceChanged(currentInputRequests || []);
    `);
    assert.equal(composerMode(ctx), 'persistent',
      'closing the dialog restores the ordinary composer, not a lease answer endpoint');
    assert.equal(ctx.run("document.getElementById('input-rb-1')"), null);
  });
});

// ── 契约 §8 事件→显示映射逐行锁死（收敛后覆盖面不得减少） ────────────────────

describe('contract §8 event->display mapping after convergence (ticket 037)', () => {
  it('§8 poll 行：inputRequests lease change updates feedback state without changing the composer', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const textarea = ctx.run("document.getElementById('input-persistent')");

    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'poll-1', placeholder: 'P' }] })`);
    assert.equal(ctx.run("document.getElementById('input-persistent')"), textarea,
      'poll lease updates must preserve the persistent composer');
    assert.equal(ctx.run("document.getElementById('input-poll-1')"), null,
      'poll lease updates must not create a request-bound endpoint');

    ctx.run('applySessionViewPatch({ inputRequests: [] })');
    assert.equal(ctx.run("document.getElementById('input-persistent')"), textarea,
      'lease cleared keeps the persistent composer');
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

    const loaderSource = fs.readFileSync('public/src/modules/session-data-loader.js', 'utf8');
    // 加载独立提交 inputRequests，由 SessionView 写入 hook 声明输入面变化。
    assert.match(loaderSource, /host\.patch\(token, \{\s*inputRequests:/);
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
    // calling 期间普通文本 lease 到达，不改变 composer 形态。
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'rc-1' }] })`);
    assert.equal(composerMode(ctx), 'persistent');
    assert.ok(ctx.run("document.getElementById('input-persistent')"));
  });

  it('§8 提交成功（请求卡路径）：optimistic restore without waiting for poll', async () => {
    const ctx = createConvergenceSandbox({ contextKey: 'session-a' });
    ctx.run('renderInputRequests([])');
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'r-act', actions: [{ id: 'proceed' }] }] })`);
    assert.ok(ctx.run("document.getElementById('input-persistent')"), 'persistent composer remains mounted');

    // 真实 submitInputAction（input-actions.js）；仍是 classic 的汇点按生产形态
    // 以 window 函数提供（模块经 window 晚绑定调用它们）。
    ctx.run(`
      function _markAgentCallStartedForNotify() {}
      function renderAgentList() {}
      function beginFollowLatestEntryWindow() {}
      function requestFollowLatest() {}
      function _syncPersistentActionButton() {}
    `);
    ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

    await ctx.submitInputAction('r-act', 'proceed', {}, 'agent-1');

    // 乐观即时性：await 返回时输入面已恢复 persistent，不依赖后台 poll。
    assert.ok(ctx.run("document.getElementById('input-persistent')") !== null,
      'composer restored optimistically right after submit success');
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]').dataset.composerMode",
    ), 'persistent');
  });

  it('keeps the Ask User card isolated and hides the persistent composer until dismissal', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const composer = ctx.run("document.getElementById('input-persistent')");
    ctx.renderChoiceInputRequest = (container) => {
      const card = ctx.document.createElement('div');
      card.className = 'user-choice-card';
      container.appendChild(card);
    };
    ctx.run(`applySessionViewPatch({ inputRequests: [{
      requestId: 'choice-separate', mode: 'choices',
      questions: [{ id: 'q1', question: 'How?', options: [{ id: 'a' }, { id: 'b' }] }],
    }] })`);

    assert.equal(ctx.run("document.getElementById('input-persistent')"), composer,
      'Ask User must not replace the persistent composer node');
    assert.equal(ctx.run("document.getElementById('input-persistent').closest('[data-persistent-composer]').style.display"), 'none',
      'persistent composer must be hidden while Ask User is active');
    assert.equal(ctx.run("document.getElementById('user-input-container').querySelector('.user-choice-card')"), null,
      'choice card must not be rendered into the composer container');
    assert.equal(ctx.run("document.getElementById('choice-input-container').children.length"), 1,
      'choice card must render in its dedicated container');

    ctx.run('applySessionViewPatch({ inputRequests: [] });' );
    assert.equal(ctx.run("document.getElementById('input-persistent').closest('[data-persistent-composer]').style.display"), '',
      'persistent composer returns after the choice lease is consumed');
  });

  it('§8 选择卡交互（选项/收起/展开/拒绝）：state write + notify rebuilds the card', async () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    // 命名导出是跨文件契约（本批补齐）：四个键都可从真实模块取得。
    for (const name of ['isChoiceInputRequest', 'isChoiceInputConsumed', 'getChoiceInteractionSignature', 'renderChoiceInputRequest']) {
      assert.equal(typeof ctx.choiceInput[name], 'function', `${name} 必须是命名导出`);
    }
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
    ctx.run(`window.ClawFW.actions.invoke('choice.selectOption', { dataset: { requestId: 'choice-1', optionIndex: '1' } })`);
    assert.ok(choiceRenders >= 1, 'option interaction re-renders the choice card');
    assert.equal(JSON.parse(ctx.choiceInput.getChoiceInteractionSignature('choice-1'))[1], 1,
      'option selection lands in the module-private interaction state');

    // 展开/收起：状态入签名，声明即重建
    const rendersBeforeCollapse = choiceRenders;
    ctx.run(`window.ClawFW.actions.invoke('choice.toggleContext', { dataset: { requestId: 'choice-1' } })`);
    assert.ok(choiceRenders > rendersBeforeCollapse, 'context toggle re-renders via the single entry');

    // 拒绝（跳过并打断）：本地立即恢复普通输入面，不等网络。
    ctx.fetch = async () => { throw new Error('reject must restore input before any network'); };
    await ctx.run(`window.ClawFW.actions.invoke('choice.reject', { dataset: { requestId: 'choice-1' } })`);
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]') !== null",
    ), true, 'reject restores the persistent composer immediately');

    // 桥键可写转发（诊断 / 测试整体替换后消费方命中替换实现），随后还原。
    const realConsumed = ctx.choiceInput.isChoiceInputConsumed;
    ctx.window.isChoiceInputConsumed = () => true;
    assert.equal(ctx.window.isChoiceInputConsumed('not-submitted'), true,
      'isChoiceInputConsumed 桥键 setter 转发到替换后的实现');
    ctx.window.isChoiceInputConsumed = realConsumed;
  });

  it('§8 选择卡提交成功：consumed lease 在陈旧快照中不再重建（防闪回第一题）', async () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    ctx.run(`
      applySessionViewPatch({ inputRequests: [{
        requestId: 'choice-2', mode: 'choices',
        questions: [{ id: 'q1', question: 'How?', options: [{ id: 'a' }, { id: 'b' }] }],
      }] });
    `);
    assert.equal(JSON.parse(ctx.choiceInput.getChoiceInteractionSignature('choice-2'))[0], 0,
      'fresh interaction starts at the first question');

    // 提交答案（单题即最后一题）：POST 成功后交互状态清理、lease 登记 consumed。
    ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await ctx.run(`window.ClawFW.actions.invoke('choice.confirm', { dataset: { requestId: 'choice-2' } })`);
    assert.equal(ctx.choiceInput.getChoiceInteractionSignature('choice-2'), 'new',
      'interaction state cleared on submit');
    assert.equal(ctx.run(`window.isChoiceInputConsumed('choice-2')`), true, 'submitted lease registered as consumed');
    assert.equal(composerMode(ctx), 'persistent', 'choice card closes immediately after submit success');
    assert.equal(ctx.run(
      `document.getElementById('user-input-container').querySelector('.user-choice-card')`,
    ), null, 'choice card is removed without waiting for poll');

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

  it('interactive surface takeover removes staged queue bubbles', () => {
    const ctx = createConvergenceSandbox();
    ctx.run(`
      var _queuedTexts = ['queued text'];
      var _lastQueueBubbleSignature = '';
      window.getThreadPendingTexts = () => ['staged text'];
    `);
    // 气泡渲染与交互面守卫都是真实 ESM 实现的桥键（P4 输入面批次后不再切片重放）：
    // _renderQueueBubbles 来自 p2-w2-3a-queue-projection，_interactiveSurfaceOccupiesInput
    // 来自 persistent-input。
    ctx.run(`
      const stack = document.createElement('div');
      stack.className = 'queue-bubbles-stack';
      document.getElementById('user-input-container').appendChild(stack);
      const card = document.createElement('div');
      card.className = 'user-choice-card';
      document.getElementById('choice-input-container').appendChild(card);
      _renderQueueBubbles(document.getElementById('user-input-container'));
    `);
    assert.equal(ctx.run(
      `document.getElementById('user-input-container').querySelector('.queue-bubbles-stack')`,
    ), null, 'interactive surface takeover removes both queued and thread-staged bubbles');
  });

  it('rollback dialog renders on the interactive surface without destroying the composer', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    const composer = ctx.run("document.getElementById('input-persistent')");
    assert.ok(composer, 'persistent composer is mounted before the dialog opens');

    // 真实入口：回退动作 lease 在场时点击「编辑此轮」= window.requestRollbackEdit。
    ctx.run(`currentMessages = [{ role: 'user', turn: 0, content: 'draft me' }];
      applySessionViewPatch({ inputRequests: [{ requestId: 'rb-lease',
        actions: [{ id: 'rollback_to_call', data: { availableCallIndices: [0] } }] }] });`);
    ctx.run('window.requestRollbackEdit(0)');

    // 渲染目标：独立交互面容器（与 Ask User 同款），输入槽不被占据、不清空
    assert.ok(ctx.run("document.getElementById('choice-input-container').children[0]"),
      'dialog renders on the interactive surface');
    // 对话框内容由 innerHTML 装配（mini DOM 不解析标签）：断言两个动作按钮的
    // data-mode 接线仍在卡片模板里；真实点击语义由 frontend-rollback-runtime 覆盖。
    const dialogHtml = ctx.run("document.getElementById('choice-input-container').children[0].innerHTML");
    assert.match(dialogHtml, /data-mode="rollback"/, 'rollback action button is wired on the dialog');
    assert.match(dialogHtml, /data-mode="compact"/, 'compact action button is wired on the dialog');
    assert.match(dialogHtml, /data-mode="cancel"/, 'cancel button is wired on the dialog');
    assert.equal(ctx.run("document.getElementById('input-persistent')"), composer,
      'composer node is preserved (hidden, not destroyed)');
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]').style.display",
    ), 'none', 'composer is hidden while the dialog owns the input surface');
    assert.equal(ctx.run('_rollbackDialogOpen'), true, 'freeze flag is set');

    // 点交互面空白处关闭（容器 onclick 是真实关闭路径）：声明恢复输入面。
    ctx.run(`document.getElementById('choice-input-container')
      .onclick({ target: document.getElementById('choice-input-container') })`);
    assert.equal(ctx.run('_rollbackDialogOpen'), false, 'close clears the freeze flag');
    assert.equal(ctx.run("document.getElementById('choice-input-container').children.length"), 0,
      'dialog is removed on the next declared render');
    assert.equal(ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]').style.display",
    ), '', 'composer returns without being recreated');
    assert.equal(ctx.run("document.getElementById('input-persistent')"), composer,
      'the same composer node survives the dialog round-trip');
  });

  it('dialog open declaration keeps close restorable with no state change while frozen', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    // 输入槽塞一张 transient 卡作"恢复渲染执行了"的探针；打开序列等价
    // showRollbackActionDialog：置冻结标志 + 声明一次（记录 frozen 签名）。
    ctx.run(`
      const probe = document.createElement('div');
      probe.className = 'queue-bubbles-stack';
      document.getElementById('user-input-container').appendChild(probe);
      _rollbackDialogOpen = true;
      notifyInputSurfaceChanged();
    `);
    assert.ok(ctx.run("document.getElementById('user-input-container').querySelector('.queue-bubbles-stack')"),
      'frozen declaration must not touch the DOM');
    // 关闭序列等价 close()：仅解除冻结（冻结期间无任何状态变化）
    ctx.run(`
      _rollbackDialogOpen = false;
      notifyInputSurfaceChanged();
    `);
    assert.equal(ctx.run("document.getElementById('user-input-container').querySelector('.queue-bubbles-stack')"), null,
      'close declaration must re-render even without state changes while frozen');
  });

  it('§8 排队同步：level-6 optimistic queue pins persistent over a pending lease', () => {
    const ctx = createConvergenceSandbox();
    ctx.run('renderInputRequests([])');
    // 普通文本 lease 到达，但输入框仍是 user-turn composer。
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'q-1' }] })`);
    assert.ok(ctx.run("document.getElementById('input-persistent')"));
    assert.equal(ctx.run("document.getElementById('input-q-1')"), null);
    // 本地排队乐观态写入 + 声明（persistent-input 的队列同步收敛路径）
    ctx.run(`
      _localQueuedInputPending = true;
      _pendingQueuedCount = 1;
      notifyInputSurfaceChanged(currentInputRequests || []);
    `);
    // 级 6：本地排队乐观态 → persistent（请求卡被压住，不弹卡）
    assert.equal(composerMode(ctx), 'persistent');
    // 排空只清理队列反馈，普通发言输入面仍不受文本 lease 影响。
    ctx.run(`
      _localQueuedInputPending = false;
      _pendingQueuedCount = 0;
      notifyInputSurfaceChanged(currentInputRequests || []);
    `);
    assert.equal(composerMode(ctx), 'persistent');
    assert.equal(ctx.run("document.getElementById('input-q-1')"), null);
  });

  it('§6 会话隔离：切换 runtime 后旧会话的排队乐观态不劫持新会话输入面', () => {
    const ctx = createConvergenceSandbox();
    // 会话 A：请求卡在场，但排队乐观态按级 6 压住 → persistent
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'q-1' }] })`);
    ctx.run(`
      _queuedTexts = ['A 会话的排队文本'];
      _pendingQueuedCount = 1;
      _localQueuedInputPending = true;
      _queuedProjectionRuntimeId = 'agent-1';
      notifyInputSurfaceChanged(currentInputRequests || []);
    `);
    assert.equal(composerMode(ctx), 'persistent', '会话 A 内排队乐观态压住请求卡（级 6）');

    // 切到会话 B（runtime 变化）：渲染入口先重绑投影，B 的请求卡不被
    // A 的排队乐观态劫持，排队气泡也不在新会话输入面冒出
    ctx.currentRuntimeAgentId = 'agent-2';
    ctx.state.liveKey = 'session-b';
    ctx.run('renderInputRequests(currentInputRequests || [])');

    assert.equal(ctx.run('_queuedTexts.length'), 0, '旧会话排队文本被重绑清空');
    assert.equal(ctx.run('_localQueuedInputPending'), false);
    assert.equal(ctx.run('String(_queuedProjectionRuntimeId)'), 'agent-2');
    assert.equal(composerMode(ctx), 'persistent',
      '投影重绑不会让新会话输入面进入 lease 应答模式');
    assert.equal(ctx.run("document.getElementById('input-q-1')"), null);
  });
});

// Real notification → composer button path, including an idle text lease that
// remains open when a background reminder starts another call.
//
// 提交/打断入口已随 persistent-input 迁 ESM（P4 输入面批次）：本 helper 只负责
// classic 通知链（runtime-status）与时钟夹具，输入面实现由用例基座真实 import。
function loadWakeupButtonPaths(ctx) {
  ctx.state.now = 1000;
  ctx.Date = class extends Date { static now() { return ctx.state.now; } };
  ctx.window.setInterval = () => 0;
  // classic runtime-status（通知链）：按桥键裸引用 call-interrupt 的四个访问器。
  ctx.loadSource('public/src/modules/runtime-status.js');
  ctx.run('function ensureChatRuntimeIndicator() {}');
  for (const id of ['notification-status', 'notification-phase', 'notification-summary', 'notification-metrics']) {
    const el = ctx.document.createElement('div');
    el.id = id;
    ctx.state.doc.body.appendChild(el);
  }
}

it('background wakeup restores the interrupt button while the persistent composer remains mounted', () => {
  const ctx = createConvergenceSandbox();
  loadWakeupButtonPaths(ctx);
  ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'idle-lease' }] });
    updateNotificationStatus({ callActive: false, runtime: { callActive: false,
      lastOutcome: { status: 'continued', reason: 'suspended' } } });`);
  const textarea = ctx.run("document.getElementById('input-persistent')");
  const button = ctx.state.container.querySelector('.persistent-action-btn');
  assert.ok(textarea);
  assert.equal(button.classList.contains('is-stop'), false, 'waiting may show send');
  ctx.run(`updateNotificationStatus({ callActive: true,
    state: { type: 'call.start', timestamp: 100, data: {} },
    runtime: { callActive: true, callStartedAt: 100 } });`);
  assert.equal(ctx.run('isRuntimeCalling(currentRuntimeAgentId)'), true);
  assert.equal(button.classList.contains('is-stop'), true, 'running must show interrupt');
  assert.equal(ctx.run("document.getElementById('input-persistent')"), textarea);
  // 空输入 + stop 语义 = 中断：真实 interruptAgent 的端点即观测面（模块内部实现
  // 不再可替换，P4 输入面批次后走真实桥键）。
  const endpoints = [];
  ctx.fetch = (url) => {
    endpoints.push(String(url));
    return new Promise(() => {}); // 请求在途：本用例只断言语义选择
  };
  button.onclick();
  assert.deepEqual(endpoints, ['/api/agents/agent-1/interrupt'],
    'empty running composer must interrupt, not submit');
});



it('running composer uses user-turn, keeps rejected choice-conflict text, and explains the required action', async () => {
  const ctx = createConvergenceSandbox();
  loadWakeupButtonPaths(ctx);
  const toasts = [];
  const echoes = [];
  ctx.window.ClawToast = { show: (value) => toasts.push(value) };
  ctx.window.ClawFW = { ...ctx.window.ClawFW, pushOptimisticUserEcho: (value) => echoes.push(value) };
  ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'choice-lease', mode: 'choices' }] });
    updateNotificationStatus({ callActive: true, runtime: { callActive: true, callStartedAt: 100 } });`);
  // 选择卡已接管输入面；模拟竞态：user-turn 在接管前已发出。
  const textarea = ctx.run("document.getElementById('input-persistent')");
  textarea.value = 'draft during choice race';
  ctx.run('_cacheSessionInput(document.getElementById("input-persistent"))');
  const requests = [];
  ctx.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    // 真实服务端形状：operation-contract 把 viewer 的 input_mode_conflict
    // 归一成稳定码 operation_rejected，原码放 legacyCode。
    return {
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        code: 'operation_rejected',
        legacyCode: 'input_mode_conflict',
        retryable: false,
        error: 'A non-text interactive input request must be completed before submitting a new user turn',
      }),
    };
  };
  await ctx.run('submitQueuedInput()');
  assert.equal(requests[0].url, '/api/agents/agent-1/user-turn');
  assert.equal(textarea.value, 'draft during choice race');
  assert.equal(ctx.run('_sessionInputCache["session-a"]'), 'draft during choice race');
  assert.deepEqual(echoes, [], 'rejected turn must not appear as sent');
  assert.equal(toasts[0].status, 'info');
  assert.match(toasts[0].title, /请先完成选择/);
  assert.match(toasts[0].description, /输入内容已保留/);
});

it('request composer keeps interrupting sticky through a stale running frame until call finish', async () => {
  const ctx = createConvergenceSandbox();
  loadWakeupButtonPaths(ctx);
  // interruptAgent 是真实 ESM 实现（P4 输入面批次后不再切片重放）：按钮点击经
  // composer 端点属性调用同一实现，端点与粘性状态都按生产语义断言。
  ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'idle-lease' }] });
    updateNotificationStatus({ callActive: true, runtime: { callActive: true, callStartedAt: 100 } });`);
  const request = deferred();
  const requests = [];
  ctx.fetch = (url) => { requests.push(url); return request.promise; };
  const button = ctx.state.container.querySelector('.persistent-action-btn');
  button.onclick();
  assert.deepEqual(requests, ['/api/agents/agent-1/interrupt']);
  assert.equal(button.classList.contains('is-interrupting'), true);
  ctx.run(`updateNotificationStatus({ callActive: true, runtime: { callActive: true, callStartedAt: 100 } });`);
  button.onclick();
  assert.equal(requests.length, 1, 'no duplicate interrupt or accidental text submission');
  assert.equal(button.classList.contains('is-interrupting'), true);
  request.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.classList.contains('is-interrupting'), true, 'HTTP acceptance is not call termination');
  ctx.run(`updateNotificationStatus({ callActive: false, state: { type: 'call.finish', timestamp: 200,
    data: { status: 'cancelled', reason: 'interrupted' } }, runtime: { callActive: false } });`);
  assert.equal(button.classList.contains('is-interrupting'), false);
  assert.equal(button.classList.contains('is-stop'), false);
});

it('a text lease arriving during a running call cannot reset the interrupt button', () => {
  const ctx = createConvergenceSandbox();
  loadWakeupButtonPaths(ctx);
  ctx.run(`renderInputRequests([]);
    updateNotificationStatus({ callActive: true, runtime: { callActive: true, callStartedAt: 100 } });
    applySessionViewPatch({ inputRequests: [{ requestId: 'late-lease' }] });`);
  const button = ctx.state.container.querySelector('.persistent-action-btn');
  assert.equal(button.classList.contains('is-stop'), true);
  ctx.run(`updateNotificationStatus({ callActive: false, runtime: { callActive: false,
    lastOutcome: { status: 'continued', reason: 'suspended' } } });`);
  assert.equal(button.classList.contains('is-stop'), false, 'waiting restores send without removing the lease');
});

function queueBubbleTexts(ctx) {
  return ctx.state.container.querySelectorAll('.queue-bubble').map((el) => el.textContent);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

it('late queued POST receipt does not resurrect a consumed bubble in the live input DOM', async () => {
  const ctx = createConvergenceSandbox();
  ctx.run('renderInputRequests([])');
  const receipt = deferred();
  ctx.fetch = () => receipt.promise;
  ctx.run("document.getElementById('input-persistent').value = 'fast queued message'");
  const submit = ctx.run('submitQueuedInput()');
  await new Promise((resolve) => setImmediate(resolve));
  ctx.emitQueued([{ id: 'q-fast', text: 'fast queued message' }]);
  ctx.emitQueued([]);
  receipt.resolve({ ok: true, json: async () => ({ delivery: 'queued', id: 'q-fast' }) });
  await submit;
  assert.deepEqual(queueBubbleTexts(ctx), [], 'already consumed input must not return to the staging stack');
});

it('empty queue response clears a bubble added while the response was in flight', async () => {
  const ctx = createConvergenceSandbox();
  ctx.run('renderInputRequests([])');
  // renderInputRequests 首轮触发的队列同步是浮动异步工作：等它落地再起本轮同步，
  // 避免撞上并发守卫（守卫本身不是本用例的断言对象）
  await new Promise((resolve) => setImmediate(resolve));
  const response = deferred();
  ctx.fetch = () => response.promise;
  const sync = ctx.run('_syncPersistentInputUi()');
  ctx.run(`_queuedTexts = ['already consumed']; _pendingQueuedCount = 1;
    _localQueuedInputPending = true; _queuedProjectionRuntimeId = 'agent-1'; updateQueueIndicator();`);
  assert.deepEqual(queueBubbleTexts(ctx), ['already consumed']);
  response.resolve({ ok: true, json: async () => [] });
  await sync;
  assert.deepEqual(queueBubbleTexts(ctx), [], 'compare the response against live state, not the pre-request signature');
  assert.equal(ctx.run('_localQueuedInputPending'), false);
});

it('late HTTP queue snapshot cannot restore bubbles consumed by a newer SSE event', async () => {
  const ctx = createConvergenceSandbox();
  ctx.run('renderInputRequests([])');
  const body = deferred();
  ctx.fetch = async () => ({ ok: true, json: () => body.promise });
  const sync = ctx.run('_syncPersistentInputUi()');
  await new Promise((resolve) => setImmediate(resolve));
  ctx.emitQueued([]);
  body.resolve([{ id: 'old-q', text: 'already consumed' }]);
  await sync;
  assert.deepEqual(queueBubbleTexts(ctx), [], 'newer SSE queue state must remain visible');
});

it('queue body from an earlier visit cannot restore bubbles after A to B to A', async () => {
  const ctx = createConvergenceSandbox();
  ctx.run('renderInputRequests([])');
  const body = deferred();
  ctx.fetch = async () => ({ ok: true, json: () => body.promise });
  const sync = ctx.run('_syncPersistentInputUi()');
  await new Promise((resolve) => setImmediate(resolve));
  ctx.run(`applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'B' } });
    applySessionViewPatch({ identity: { agentId: 'host', sessionId: 'A' } });`);
  body.resolve([{ id: 'stale', text: 'old visit' }]);
  await sync;
  assert.deepEqual(queueBubbleTexts(ctx), []);
});

it('off-focus queue confirmation clears optimistic anchors before switching back', () => {
  const ctx = createConvergenceSandbox();
  ctx.noteQueuedOptimistic('q-away', 'sent while away', 'agent-1');
  ctx.run(`currentRuntimeAgentId = 'agent-2';`);
  ctx.emitQueued([{ id: 'q-away', text: 'sent while away' }]);
  ctx.emitQueued([]);
  ctx.run(`currentRuntimeAgentId = 'agent-1';`);
  assert.equal(ctx.reconcileQueuedTexts([], Date.now(), 'agent-1').length, 0);
});

it('direct POST receipt after switching sessions cannot echo or scroll in the other session', async () => {
  const ctx = createConvergenceSandbox();
  ctx.run('renderInputRequests([])');
  const receipt = deferred();
  ctx.fetch = () => receipt.promise;
  const echoes = [];
  ctx.window.ClawFW.pushOptimisticUserEcho = (value) => echoes.push(value);
  let followCalls = 0;
  ctx.beginFollowLatestEntryWindow = () => { followCalls += 1; };
  ctx.clearInterruptSuppression = () => {};
  ctx._markAgentCallStartedForNotify = () => {};
  ctx.renderAgentList = () => {};
  ctx.run("document.getElementById('input-persistent').value = 'message for A'");
  const submit = ctx.run('submitQueuedInput()');
  await new Promise((resolve) => setImmediate(resolve));
  ctx.currentRuntimeAgentId = 'agent-2';
  ctx.state.liveKey = 'session-b';
  ctx.run('applySessionViewPatch({ inputRequests: [] })');
  const textarea = ctx.run("document.getElementById('input-persistent')");
  textarea.value = 'draft B';
  receipt.resolve({ ok: true, json: async () => ({ delivery: 'direct' }) });
  await submit;
  assert.deepEqual(echoes, [], 'A must not appear in B');
  assert.equal(followCalls, 0, 'A must not force B to scroll');
  assert.equal(textarea.value, 'draft B');
});

/**
 * 回显 / 对账路径：chat-renderer 已迁 ESM（P4 T2），用真实命名导出驱动，不再把
 * 源码切片搬进 vm。容器仍是 app-core 顶层 const 指向的同一节点（`#chat-container`），
 * 因此断言的就是生产回显落点。
 */
function loadEchoPaths(ctx) {
  const chat = ctx.run("document.getElementById('chat-container')");
  return chat;
}

it('echo does not disappear against a repeated older user message', () => {
  const ctx = createConvergenceSandbox();
  const chat = loadEchoPaths(ctx);
  ctx.run("currentMessages = [{ role: 'user', content: 'again' }];");
  ctx.chatRenderer.pushOptimisticUserEcho({ text: 'again', fromIndex: 1 });
  ctx.chatRenderer.reconcileOptimisticUserEchoes(ctx.run('currentMessages'));
  assert.equal(chat.children.length, 1, 'only a message after submission can confirm this echo');
  ctx.run(`currentMessages = [...currentMessages, { role: 'user', content: 'again' }];`);
  ctx.chatRenderer.reconcileOptimisticUserEchoes(ctx.run('currentMessages'));
  assert.equal(chat.children.length, 0);
});

it('image-only echoes require the same attachment and survive long message bursts', () => {
  const ctx = createConvergenceSandbox();
  const chat = loadEchoPaths(ctx);
  ctx.run('currentMessages = [];');
  ctx.chatRenderer.pushOptimisticUserEcho({ text: ' ', images: [{ path: 'new.png' }], fromIndex: 0 });
  ctx.chatRenderer.reconcileOptimisticUserEchoes([{ role: 'user', content: ' ', images: [{ path: 'old.png' }] }]);
  assert.equal(chat.children.length, 1);
  ctx.chatRenderer.reconcileOptimisticUserEchoes([
    { role: 'user', content: ' ', images: [{ path: 'new.png' }] },
    ...Array.from({ length: 20 }, () => ({ role: 'assistant', content: 'activity' })),
  ]);
  assert.equal(chat.children.length, 0, 'confirmation is not lost beyond a fixed tail window');
});

it('real message preceding the POST receipt does not leave a duplicate echo', () => {
  const ctx = createConvergenceSandbox();
  const chat = loadEchoPaths(ctx);
  ctx.run(`currentMessages = [{ role: 'user', content: 'already arrived' }];`);
  ctx.chatRenderer.pushOptimisticUserEcho({ text: 'already arrived', fromIndex: 0 });
  assert.equal(chat.children.length, 0, 'the already visible real message is sufficient');
});

it('idle text lease uses user-turn and preserves immediate echo without waiting for poll', async () => {
  const ctx = createConvergenceSandbox();
  ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'slot' }] })`);
  ctx.run(`function beginFollowLatestEntryWindow() {} function requestFollowLatest() {}
    function _markAgentCallStartedForNotify() {}
    function renderAgentList() {}`);
  const echoes = [];
  ctx.window.ClawFW.pushOptimisticUserEcho = (value) => echoes.push(value);
  ctx.run("document.getElementById('input-persistent').value = 'slot input'");
  const requests = [];
  ctx.fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ delivery: 'input', requestId: 'slot' }) };
  };
  await ctx.run('submitQueuedInput()');
  assert.deepEqual(requests, ['/api/agents/agent-1/user-turn']);
  assert.equal(echoes.length, 1);
  assert.equal(echoes[0].text, 'slot input');
  assert.equal(echoes[0].fromIndex, 0);
});

it('switching sessions during image preparation cannot reroute A input to B thread', async () => {
  const ctx = createConvergenceSandbox();
  ctx.run('renderInputRequests([])');
  const ready = deferred();
  ctx._resolvePendingImagesForTarget = () => ready.promise;
  const sends = [];
  ctx.fetch = async (url) => { sends.push(url); return { ok: true, json: async () => ({}) }; };
  ctx.window.submitThreadCommand = async (threadId) => { sends.push(threadId); return {}; };
  ctx.run("document.getElementById('input-persistent').value = 'A input'");
  const submit = ctx.run('submitQueuedInput()');
  await new Promise((resolve) => setImmediate(resolve));
  ctx.currentRuntimeAgentId = 'agent-2';
  ctx.state.liveKey = 'session-b';
  ctx.window.resolveThreadInputRoute = () => ({ route: 'thread', thread: { threadId: 'B-thread' } });
  ready.resolve({ images: [], failedCount: 0 });
  await submit;
  assert.deepEqual(sends, [], 'a navigation during preparation leaves A draft unsent');
});

it('action receipt cannot clear a newer input lease in the same session', async () => {
  const ctx = createConvergenceSandbox();
  ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'old' }] })`);
  ctx.run(`function beginFollowLatestEntryWindow() {} function requestFollowLatest() {}
    function _markAgentCallStartedForNotify() {}
    function renderAgentList() {}`);
  const receipt = deferred();
  ctx.fetch = () => receipt.promise;
  const submit = ctx.submitInputAction('old', 'proceed');
  ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'new' }] })`);
  receipt.resolve({ ok: true });
  await submit;
  assert.equal(ctx.run('currentInputRequests[0]?.requestId'), 'new');
});

// ── 收敛断言：手动戳协议灭绝（源码级锁死） ──────────────────────────────────

const FILES_OUTSIDE_RENDERER = [
  'public/src/app-core.js',
  'public/src/app-main.js',
  'public/src/app-ui.js',
  'public/src/modules/agent-data-loader.js',
  'public/src/modules/choice-input.js',
  'public/src/modules/generative-ui-panel.js',
  // 本批新迁出的三个 ESM 模块：动作提交 / 过程显隐 / 回退对话框运行时。
  // 它们只经 notifyInputSurfaceChanged 声明，不得就地戳渲染签名。
  'public/src/modules/input-actions.js',
  'public/src/modules/chat-process-visibility.js',
  'public/src/modules/rollback-dialog-runtime.js',
  'public/src/modules/input-helpers.js',
  'public/src/modules/persistent-input.js',
  'public/src/modules/rollback-dialog.js',
  'public/src/modules/runtime-status.js',
  'public/src/modules/workspace-actions.js',
  'public/src/modules/session-view-state.js',
];

// ── 接续等待表面（ADR-0026）：无 runtime 态下 composer 在场 ──────────────

describe('thread await surface keeps the composer mounted (ADR-0026)', () => {
  it('await target mounts persistent composer; losing the target hides it again', () => {
    const ctx = createConvergenceSandbox();
    ctx.run(`currentRuntimeAgentId = null`);
    ctx.run(`window.getActiveThreadInputTarget = () => ({ threadId: 'wt-1', agentId: 'coder', sessionId: 's-await' })`);
    ctx.run('renderInputRequests([])');
    assert.ok(ctx.run("document.getElementById('input-persistent')"),
      'composer mounts on the await surface (挂起≠消失)');
    // 等待会话之间切换：签名变化触发会话卡重绑（草稿按会话迁移）
    ctx.run(`window.getActiveThreadInputTarget = () => ({ threadId: 'wt-2', agentId: 'coder', sessionId: 's-await-2' })`);
    ctx.run('renderInputRequests([])');
    assert.ok(ctx.run("document.getElementById('input-persistent')"),
      'composer stays mounted across await-session switches');
    // 一致性校验失效（用户切走 / 残留清理）→ 回到 hidden（常驻 composer
    // 隐藏但节点保留，与既有 hidden 语义同款）
    ctx.run(`window.getActiveThreadInputTarget = () => null`);
    ctx.run('renderInputRequests([])');
    const hiddenCard = ctx.run(
      "document.getElementById('user-input-container').querySelector('[data-persistent-composer]')",
    );
    assert.ok(hiddenCard, 'composer singleton stays mounted');
    assert.equal(hiddenCard.style.display, 'none',
      'losing the await target hides the composer');
  });
});

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

  it('input snapshot writes synchronously declare the exact new input surface', () => {
    const ctx = createConvergenceSandbox();
    const observations = [];
    ctx.notifyInputSurfaceChanged = (requests) => observations.push(requests);
    const requests = [{ requestId: 'new-input', type: 'choice' }];
    ctx.applySessionViewPatch({ inputRequests: requests });
    assert.equal(observations.length, 1);
    assert.strictEqual(observations[0], requests);
    assert.strictEqual(ctx.lastInputRequests, requests);
    ctx.applySessionViewPatch({ messages: [] });
    assert.equal(observations.length, 1, 'an unrelated patch must not announce another input change');
  });

  it('optimistic submit paths keep immediate feedback without poll dependency', async () => {
    const ctx = createConvergenceSandbox();
    ctx.run(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'A' }, inputRequests: [{ requestId: 'p-request' }] })`);
    // poll() 是提交后的收尾动作：它被调用时乐观清空必须已经落地。观察真实 poll
    // 模块的宿主 run 调用点（不再用 window.poll 桩）。
    const requestsSeenByPoll = [];
    ctx.state.poll.hook = () => {
      requestsSeenByPoll.push(JSON.parse(JSON.stringify(ctx.window.currentInputRequests || [])));
    };
    ctx.run(`function beginFollowLatestEntryWindow() {} function requestFollowLatest() {}
      function _markAgentCallStartedForNotify() {} function renderAgentList() {}
      function _syncPersistentActionButton() {}`);
    ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await ctx.submitInputAction('p-request', 'proceed', {}, 'agent-1');
    assert.ok(ctx.state.poll.runs >= 1, '提交成功后调用真实 poll');
    assert.deepEqual(requestsSeenByPoll[0], [],
      'poll() runs only after the synchronous optimistic restore (patch before poll)');
  });

  it('delayed action lease from session A cannot clear or rerender session B', async () => {
    const ctx = createConvergenceSandbox();
    ctx.run(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'A' }, inputRequests: [{ requestId: 'A-request' }] })`);
    ctx.run(`
      function _markAgentCallStartedForNotify() {}
      function renderAgentList() {}
      function beginFollowLatestEntryWindow() { globalThis.followCalls = (globalThis.followCalls || 0) + 1; }
      function requestFollowLatest() {}
      function _syncPersistentActionButton() {}
    `);
    let finish;
    ctx.fetch = () => new Promise((resolve) => { finish = resolve; });
    const pending = ctx.submitInputAction('A-request', 'proceed', {}, 'agent-1');
    ctx.run(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'B' } });
    applySessionViewPatch({ inputRequests: [{ requestId: 'B-request' }] });`);
    const rendersBeforeResponse = ctx.run('globalThis.inputSurfaceRenderCount || 0');
    finish({ ok: true, status: 200, json: async () => ({}) });
    await pending;
    assert.equal(ctx.run('currentInputRequests[0].requestId'), 'B-request');
    assert.equal(ctx.run('globalThis.inputSurfaceRenderCount || 0'), rendersBeforeResponse);
    assert.equal(ctx.run('globalThis.followCalls || 0'), 0);
  });

  it('same-session action lease still clears input requests optimistically', async () => {
    const ctx = createConvergenceSandbox();
    ctx.run(`applySessionViewPatch({ identity: { agentId: 'agent-1', sessionId: 'A' }, inputRequests: [{ requestId: 'A-request' }] })`);
    ctx.run(`
      function _markAgentCallStartedForNotify() {}
      function renderAgentList() {}
      function beginFollowLatestEntryWindow() {}
      function requestFollowLatest() {}
      function _syncPersistentActionButton() {}
    `);
    ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await ctx.submitInputAction('A-request', 'proceed', {}, 'agent-1');
    assert.deepEqual(Array.from(ctx.run('currentInputRequests')), []);
  });
});

// ── 回归：普通文本 lease 变化不再翻转或重建输入面（ADR-0035） ───────────

describe('ordinary text lease updates leave the persistent composer untouched', () => {
  it('arrival and clearing preserve the same composer node and deliver rollback draft feedback', () => {
    const ctx = createConvergenceSandbox();
    ctx.run(`_sessionInputCache = {};
      var autoResizeCalls = 0;
      autoResize = () => { autoResizeCalls++; };
      var leaseToasts = [];
      ClawToast = { show: (toast) => leaseToasts.push(toast) };
      currentLanguage = 'zh';`);
    ctx.run('renderInputRequests([])');
    const composer = ctx.run(composerQuery(ctx));
    assert.ok(composer, 'the chat surface has its persistent composer mounted');

    // Runtime announces an ordinary text lease: this is answer-routing state, not
    // a reason to replace the user's speaking surface.
    ctx.run(`applySessionViewPatch({ inputRequests: [{ requestId: 'text-lease', placeholder: '请输入', initialValue: 'rollback draft', actions: [{ id: 'rollback_to_call', data: { lastActionError: 'checkpoint missing' } }] }] })`);
    assert.equal(composerMode(ctx), 'persistent');
    assert.equal(ctx.run(composerQuery(ctx)), composer, 'lease arrival keeps the existing composer node');
    assert.equal(ctx.run("document.getElementById('input-persistent').value"), 'rollback draft',
      'lease initialValue restores the rollback draft in the ordinary composer');
    assert.equal(ctx.run("_sessionInputCache['session-a']"), 'rollback draft',
      'restored draft is also retained by the per-session cache');
    assert.equal(ctx.run('leaseToasts.length'), 1, 'carried action failure is surfaced when the lease arrives');
    assert.equal(ctx.run('leaseToasts[0].description'), 'checkpoint missing');

    ctx.run('applySessionViewPatch({ inputRequests: [] })');
    assert.equal(composerMode(ctx), 'persistent');
    assert.equal(ctx.run(composerQuery(ctx)), composer, 'lease clearing keeps the existing composer node');

    ctx.run(`document.getElementById('input-persistent').value = 'user draft';
      _cacheSessionInput(document.getElementById('input-persistent'));
      applySessionViewPatch({ inputRequests: [{ requestId: 'next-lease', initialValue: 'older rollback draft' }] });`);
    assert.equal(ctx.run("document.getElementById('input-persistent').value"), 'user draft',
      'a later rollback draft never overwrites text the user has already entered');
    assert.equal(ctx.run("_sessionInputCache['session-a']"), 'user draft',
      'the session cache retains the user draft as well');
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
  // 工作区可能以 CRLF 检出（core.autocrlf=true），标记含裸 \n 字面量，先归一化。
  const normalized = source.replace(/\r\n/g, '\n');
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf(endMarker, start);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return normalized.slice(start, end);
}
